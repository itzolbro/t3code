import {
  ProviderDriverKind,
  TextGenerationError,
  type ProviderSession,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSessionStartInput,
  type ServerProvider,
  type ServerProviderModel,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Result from "effect/Result";
import type * as Scope from "effect/Scope";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { buildServerProvider } from "../providerSnapshot.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { PiSessionManager } from "../../pi/PiSessionManager.ts";
import * as PiTranscriptAdapter from "../../pi/PiTranscriptAdapter.ts";
import type * as TextGeneration from "../../textGeneration/TextGeneration.ts";

const DRIVER_KIND = ProviderDriverKind.make("pi");
const PiSettings = Schema.Struct({
  model: Schema.optional(Schema.String),
  thinkingLevel: Schema.optional(Schema.String),
});
type PiSettings = typeof PiSettings.Type;

const now = Effect.map(DateTime.now, DateTime.formatIso);

const unsupported = (
  operation: string,
  threadId: ThreadId,
): Effect.Effect<never, ProviderAdapterError> =>
  Effect.fail(
    new ProviderAdapterRequestError({
      provider: "pi",
      method: operation,
      detail: `Pi does not expose ${operation} through the Phase 2b adapter yet`,
      cause: { threadId },
    }),
  );

const session = (
  input: ProviderSessionStartInput,
  providerInstanceId: string,
  createdAt: string,
): ProviderSession => ({
  provider: DRIVER_KIND,
  providerInstanceId: providerInstanceId as ProviderInstance["instanceId"],
  status: "ready",
  runtimeMode: input.runtimeMode,
  cwd: input.cwd,
  model: input.modelSelection?.model,
  threadId: input.threadId,
  createdAt,
  updatedAt: createdAt,
});

export type PiDriverEnv = PiSessionManager;

export const PiDriver: ProviderDriver<PiSettings, PiDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Pi", supportsMultipleInstances: false },
  configSchema: PiSettings,
  defaultConfig: () => ({}),
  create: ({ instanceId, displayName, accentColor, enabled, config }) =>
    Effect.gen(function* () {
      const manager = yield* PiSessionManager;
      const maintenanceCapabilities = makeManualOnlyProviderMaintenanceCapabilities({
        provider: DRIVER_KIND,
        packageName: null,
      });
      const checkedAt = yield* now;
      const initialModels: ServerProviderModel[] = config.model
        ? [{ slug: config.model, name: config.model, isCustom: true, capabilities: null }]
        : [];
      const snapshotDraft = buildServerProvider({
        presentation: { displayName: displayName ?? "Pi", showInteractionModeToggle: true },
        enabled,
        checkedAt,
        models: initialModels,
        probe: {
          installed: true,
          version: "0.84.1",
          status: "ready",
          auth: { status: "unknown" },
        },
      });
      const snapshot = yield* Ref.make<ServerProvider>({
        ...snapshotDraft,
        instanceId,
        driver: DRIVER_KIND,
        ...(accentColor ? { accentColor } : {}),
      });

      // Model picker integration: advertise pi's real models (with the
      // thinking levels each model supports) in the provider snapshot. The
      // catalog is fetched lazily from the pi child; refresh is best-effort
      // and non-blocking so a cold pi boot never stalls the registry.
      const PI_THINKING_LEVELS: ReadonlyArray<{
        readonly id: string;
        readonly label: string;
      }> = [
        { id: "off", label: "Off" },
        { id: "minimal", label: "Minimal" },
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
        { id: "xhigh", label: "X-High" },
        { id: "max", label: "Max" },
      ];
      const modelSnapshot = (
        models: ReadonlyArray<{
          readonly provider: string;
          readonly modelId: string;
          readonly name: string;
          readonly thinkingLevels: ReadonlyArray<string>;
        }>,
      ): ReadonlyArray<ServerProviderModel> => {
        if (models.length === 0) return initialModels;
        return models.map((entry) => {
          const levels =
            entry.thinkingLevels.length > 0 ? entry.thinkingLevels : ["medium", "high"];
          const choices = PI_THINKING_LEVELS.filter((level) => levels.includes(level.id)).map(
            (level, index) => ({
              id: level.id,
              label: level.label,
              ...(index === 0 ? { isDefault: true } : {}),
            }),
          );
          return {
            slug: entry.modelId,
            name: entry.name,
            ...(entry.provider ? { subProvider: entry.provider } : {}),
            isCustom: false,
            capabilities:
              choices.length > 0
                ? {
                    optionDescriptors: [
                      {
                        id: "thinkingLevel",
                        label: "Thinking",
                        type: "select" as const,
                        options: choices,
                        currentValue: choices[0]?.id,
                        promptInjectedValues: [],
                      },
                    ],
                  }
                : null,
          };
        });
      };
      const refreshModels = Effect.gen(function* () {
        const models = yield* manager.listModels.pipe(
          Effect.timeout(Duration.seconds(10)),
          Effect.orElseSucceed(() => []),
        );
        if (models.length === 0) return;
        const current = yield* Ref.get(snapshot);
        const next: ServerProvider = {
          ...current,
          models: modelSnapshot(models),
        };
        yield* Ref.set(snapshot, next);
      }).pipe(Effect.ignore);

      // Kick off one catalog fetch at startup; the registry's periodic
      // refresh re-runs it until pi answers.
      yield* refreshModels.pipe(Effect.forkScoped);
      const active = new Map<ThreadId, ProviderSession>();
      const events = manager.events.pipe(
        Stream.filterMap(({ threadId, event }) => {
          const transcript = PiTranscriptAdapter.adapt(threadId, event);
          return transcript
            ? Result.succeed(PiTranscriptAdapter.runtime(instanceId, transcript))
            : Result.failVoid;
        }),
      );
      const mapAdapterError = (cause: unknown, operation: string, threadId: ThreadId) =>
        Schema.is(ProviderAdapterRequestError)(cause) ||
        Schema.is(ProviderAdapterSessionNotFoundError)(cause)
          ? cause
          : new ProviderAdapterRequestError({
              provider: "pi",
              method: operation,
              detail: String(cause),
              cause: { threadId },
            });
      const adapter = {
        provider: DRIVER_KIND,
        capabilities: { sessionModelSwitch: "in-session" as const },
        startSession: (input: ProviderSessionStartInput) =>
          Effect.gen(function* () {
            const created = yield* manager
              .create(input.threadId, input.cwd ?? process.cwd())
              .pipe(
                Effect.mapError((cause) => mapAdapterError(cause, "startSession", input.threadId)),
              );
            const model = input.modelSelection?.model;
            if (model !== undefined && model.trim().length > 0) {
              yield* manager.setModel(input.threadId, model).pipe(
                Effect.mapError((cause) => mapAdapterError(cause, "setModel", input.threadId)),
                Effect.ignore,
              );
            }
            const createdAt = yield* now;
            const next = session(input, instanceId, createdAt);
            active.set(input.threadId, next);
            return { ...next, resumeCursor: created.sessionPath };
          }),
        sendTurn: (input: ProviderSendTurnInput) =>
          Effect.gen(function* () {
            const message = input.input;
            if (!message) {
              return yield* unsupported("sendTurn", input.threadId);
            }
            // Model picker integration: apply the requested model before the
            // turn so the provider UI's selection reaches pi's set_model.
            const model = input.modelSelection?.model;
            if (model !== undefined && model.trim().length > 0) {
              yield* manager.setModel(input.threadId, model).pipe(
                Effect.mapError((cause) => mapAdapterError(cause, "setModel", input.threadId)),
                Effect.ignore,
              );
            }
            yield* manager
              .submit(input.threadId, message)
              .pipe(Effect.mapError((cause) => mapAdapterError(cause, "sendTurn", input.threadId)));
            return { threadId: input.threadId, turnId: TurnId.make(`pi-turn-${input.threadId}`) };
          }),
        interruptTurn: (threadId: ThreadId) =>
          manager.abort(threadId).pipe(
            Effect.mapError((cause) => mapAdapterError(cause, "interruptTurn", threadId)),
            Effect.asVoid,
          ),
        respondToRequest: (threadId: ThreadId) => unsupported("respondToRequest", threadId),
        respondToUserInput: (threadId: ThreadId) => unsupported("respondToUserInput", threadId),
        stopSession: (threadId: ThreadId) =>
          manager.abort(threadId).pipe(
            Effect.mapError((cause) => mapAdapterError(cause, "stopSession", threadId)),
            Effect.ignore,
            Effect.andThen(Effect.sync(() => active.delete(threadId))),
          ),
        listSessions: () => Effect.succeed([...active.values()]),
        hasSession: (threadId: ThreadId) => Effect.succeed(active.has(threadId)),
        readThread: (threadId: ThreadId) =>
          active.has(threadId)
            ? Effect.succeed({ threadId, turns: [] })
            : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: "pi", threadId })),
        rollbackThread: (threadId: ThreadId) => unsupported("rollbackThread", threadId),
        stopAll: () =>
          Effect.forEach([...active.keys()], (threadId: ThreadId) =>
            manager.abort(threadId).pipe(Effect.ignore),
          ).pipe(Effect.asVoid),
        streamEvents: events,
      };
      const textGeneration = {
        generateCommitMessage: (_input: TextGeneration.CommitMessageGenerationInput) =>
          Effect.fail(
            new TextGenerationError({
              operation: "generateCommitMessage",
              detail: "Pi text generation is not wired yet.",
            }),
          ),
        generatePrContent: (_input: TextGeneration.PrContentGenerationInput) =>
          Effect.fail(
            new TextGenerationError({
              operation: "generatePrContent",
              detail: "Pi text generation is not wired yet.",
            }),
          ),
        generateBranchName: (_input: TextGeneration.BranchNameGenerationInput) =>
          Effect.fail(
            new TextGenerationError({
              operation: "generateBranchName",
              detail: "Pi text generation is not wired yet.",
            }),
          ),
        generateThreadTitle: (_input: TextGeneration.ThreadTitleGenerationInput) =>
          Effect.fail(
            new TextGenerationError({
              operation: "generateThreadTitle",
              detail: "Pi text generation is not wired yet.",
            }),
          ),
      };
      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity: defaultProviderContinuationIdentity({
          driverKind: DRIVER_KIND,
          instanceId,
        }),
        displayName,
        accentColor,
        enabled,
        snapshot: {
          maintenanceCapabilities,
          getSnapshot: Ref.get(snapshot),
          refresh: refreshModels.pipe(Effect.andThen(Ref.get(snapshot))),
          streamChanges: Stream.empty,
        },
        adapter: adapter as unknown as ProviderAdapterShape<ProviderAdapterError>,
        textGeneration,
      } satisfies ProviderInstance;
    }).pipe(
      Effect.mapError((cause) =>
        Schema.is(ProviderDriverError)(cause)
          ? cause
          : new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: String(cause),
              cause,
            }),
      ),
    ) as unknown as Effect.Effect<ProviderInstance, ProviderDriverError, PiDriverEnv | Scope.Scope>,
};
