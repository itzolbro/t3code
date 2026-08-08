import {
  ProviderDriverKind,
  TextGenerationError,
  type ProviderSession,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSessionStartInput,
  type ServerProvider,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
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
      const snapshotDraft = buildServerProvider({
        presentation: { displayName: displayName ?? "Pi", showInteractionModeToggle: true },
        enabled,
        checkedAt,
        models: config.model
          ? [{ slug: config.model, name: config.model, isCustom: true, capabilities: null }]
          : [],
        probe: {
          installed: true,
          version: "0.84.1",
          status: "ready",
          auth: { status: "unknown" },
        },
      });
      const snapshot: ServerProvider = {
        ...snapshotDraft,
        instanceId,
        driver: DRIVER_KIND,
        ...(accentColor ? { accentColor } : {}),
      };
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
          getSnapshot: Effect.succeed(snapshot),
          refresh: Effect.succeed(snapshot),
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
