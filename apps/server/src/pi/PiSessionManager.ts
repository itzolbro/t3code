import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Result from "effect/Result";

import { PiProcess, type PiRpcRequest, type PiRpcResponse } from "./PiProcess.ts";

export interface PiModelRef {
  readonly provider: string;
  readonly modelId: string;
}

interface PiSession {
  readonly threadId: ThreadId;
  readonly sessionPath: string;
  readonly cwd: string;
  /** Last model slug applied via set_model; undefined until first set. */
  readonly model?: string | undefined;
}

export interface PiSessionManagerShape {
  readonly create: (
    threadId: ThreadId,
    cwd: string,
  ) => Effect.Effect<PiSession, PiSessionManagerError>;
  readonly open: (
    threadId: ThreadId,
    sessionPath: string,
    cwd: string,
  ) => Effect.Effect<PiSession, PiSessionManagerError>;
  readonly submit: (
    threadId: ThreadId,
    message: string,
  ) => Effect.Effect<void, PiSessionManagerError>;
  readonly abort: (threadId: ThreadId) => Effect.Effect<void, PiSessionManagerError>;
  /** Apply a model by slug, resolving provider/modelId via get_available_models. */
  readonly setModel: (
    threadId: ThreadId,
    modelSlug: string,
  ) => Effect.Effect<void, PiSessionManagerError>;
  readonly setThinking: (
    threadId: ThreadId,
    level: string,
  ) => Effect.Effect<void, PiSessionManagerError>;
  readonly get: (threadId: ThreadId) => Effect.Effect<PiSession | undefined>;
  /** Available models (provider/modelId/name + supported thinking levels). */
  readonly listModels: Effect.Effect<
    ReadonlyArray<{
      readonly provider: string;
      readonly modelId: string;
      readonly name: string;
      readonly thinkingLevels: ReadonlyArray<string>;
    }>,
    PiSessionManagerError
  >;
  readonly events: Stream.Stream<
    { readonly threadId: ThreadId; readonly event: PiRpcResponse },
    PiSessionManagerError
  >;
}

export class PiSessionManagerError extends Schema.TaggedErrorClass<PiSessionManagerError>()(
  "PiSessionManagerError",
  {
    operation: Schema.String,
    threadId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Pi session ${this.operation} failed for ${this.threadId}: ${this.detail}`;
  }
}

export class PiSessionManager extends Context.Service<PiSessionManager, PiSessionManagerShape>()(
  "t3/pi/PiSessionManager",
) {}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

const responseData = (response: PiRpcResponse): Record<string, unknown> =>
  asRecord(response.data) ?? {};

const sessionPath = (response: PiRpcResponse): string => {
  const data = responseData(response);
  const candidate = data.sessionFile ?? data.sessionPath;
  return typeof candidate === "string" ? candidate : "";
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const make = Effect.gen(function* () {
  const process = yield* PiProcess;
  const sessions = yield* Ref.make<Map<ThreadId, PiSession>>(new Map());
  // pi's RPC process hosts exactly ONE active session: `new_session` and
  // `switch_session` swap the current session, and every subsequent event
  // (message_update, turn_*, tool_*) belongs to that session. Track the
  // thread that last activated the session so events can be attributed
  // without a session identifier (pi's streaming events carry none).
  const activeThread = yield* Ref.make<ThreadId | undefined>(undefined);
  // Model catalog cache — refresh once per process lifetime; pi's model set
  // only changes when config changes (which requires a process restart).
  let modelCatalog: ReadonlyArray<{
    readonly provider: string;
    readonly modelId: string;
    readonly name: string;
    readonly thinkingLevels: ReadonlyArray<string>;
  }> = [];

  const request = (threadId: ThreadId, operation: string, input: Record<string, unknown>) =>
    process
      .request<PiRpcResponse>({
        id: `pi-${operation}-${threadId}`,
        type: String(input.type),
        ...input,
      } as PiRpcRequest)
      .pipe(
        Effect.mapError(
          (cause) =>
            new PiSessionManagerError({
              operation,
              threadId,
              detail: String(cause),
              cause,
            }),
        ),
      );

  const current = (threadId: ThreadId, operation: string) =>
    Ref.get(sessions).pipe(
      Effect.flatMap((known) => {
        const session = known.get(threadId);
        return session
          ? Effect.succeed(session)
          : Effect.fail(
              new PiSessionManagerError({
                operation,
                threadId,
                detail: "No pi session is bound to this thread",
              }),
            );
      }),
    );

  const setSessionModel = (threadId: ThreadId, model: string | undefined) =>
    Ref.update(sessions, (known) => {
      const session = known.get(threadId);
      if (!session) return known;
      const next = new Map(known);
      next.set(threadId, { ...session, ...(model === undefined ? {} : { model }) });
      return next;
    });

  const loadModelCatalog = Effect.gen(function* () {
    if (modelCatalog.length > 0) return modelCatalog;
    const response = yield* process.request<PiRpcResponse>({
      id: "pi-models",
      type: "get_available_models",
    });
    const data = responseData(response);
    const models = Array.isArray(data.models) ? data.models : [];
    const resolved: Array<{
      readonly provider: string;
      readonly modelId: string;
      readonly name: string;
      readonly thinkingLevels: ReadonlyArray<string>;
    }> = [];
    for (const entry of models) {
      if (!isRecord(entry)) continue;
      const provider = typeof entry.provider === "string" ? entry.provider : "";
      const modelId = typeof entry.id === "string" ? entry.id : "";
      const name = typeof entry.name === "string" ? entry.name : modelId;
      if (provider.length > 0 && modelId.length > 0) {
        // pi's catalog entries carry a thinkingLevelMap ({ level: apiValue })
        // — the levels the model actually supports (pi-web-ui shows exactly
        // this: getAvailableThinkingLevels scoped to the current model).
        const thinkingLevels: string[] = [];
        const map = asRecord(entry.thinkingLevelMap);
        if (map) {
          for (const [level, value] of Object.entries(map)) {
            if (value !== null && value !== undefined) {
              thinkingLevels.push(level);
            }
          }
        }
        resolved.push({ provider, modelId, name, thinkingLevels });
      }
    }
    modelCatalog = resolved;
    return resolved;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new PiSessionManagerError({
          operation: "models",
          threadId: "unknown" as ThreadId,
          detail: String(cause),
          cause,
        }),
    ),
  );

  const create = (threadId: ThreadId, cwd: string) =>
    request(threadId, "create", { type: "new_session" }).pipe(
      // `new_session` only reports whether a session switch was cancelled;
      // the session identity (file + id) comes from `get_state`.
      Effect.flatMap(() =>
        request(threadId, "create-state", { type: "get_state" }).pipe(
          Effect.map((response) => ({
            threadId,
            sessionPath: sessionPath(response),
            cwd,
          })),
        ),
      ),
      Effect.tap((session) =>
        Ref.update(sessions, (known) => new Map(known).set(threadId, session)),
      ),
      Effect.tap(() => Ref.set(activeThread, threadId)),
    );

  const open = (threadId: ThreadId, path: string, cwd: string) =>
    request(threadId, "open", { type: "switch_session", sessionPath: path }).pipe(
      Effect.map(() => ({ threadId, sessionPath: path, cwd })),
      Effect.tap((session) =>
        Ref.update(sessions, (known) => new Map(known).set(threadId, session)),
      ),
      Effect.tap(() => Ref.set(activeThread, threadId)),
    );

  const command = (threadId: ThreadId, operation: string, input: Record<string, unknown>) =>
    current(threadId, operation).pipe(
      Effect.andThen(request(threadId, operation, input)),
      Effect.asVoid,
    );

  const setModel = (threadId: ThreadId, modelSlug: string) =>
    Effect.gen(function* () {
      const catalog = yield* loadModelCatalog;
      // Accept "provider/model" slugs and bare model ids. Prefer an exact
      // catalog match on id, then provider-prefixed, then first entry.
      const normalized = modelSlug.trim();
      const exact =
        catalog.find((entry) => entry.modelId === normalized) ??
        catalog.find((entry) => `${entry.provider}/${entry.modelId}` === normalized);
      const model = exact ?? catalog[0];
      if (!model) {
        return yield* Effect.fail(
          new PiSessionManagerError({
            operation: "setModel",
            threadId,
            detail: `pi reports no available models; cannot apply '${modelSlug}'`,
          }),
        );
      }
      yield* request(threadId, "setModel", {
        type: "set_model",
        provider: model.provider,
        modelId: model.modelId,
      });
      yield* setSessionModel(threadId, normalized);
    });

  return {
    create,
    open,
    submit: (threadId, message) =>
      command(threadId, "submit", { type: "prompt", message }).pipe(
        Effect.tap(() => Ref.set(activeThread, threadId)),
      ),
    abort: (threadId) => command(threadId, "abort", { type: "abort" }),
    setModel,
    setThinking: (threadId, level) =>
      command(threadId, "setThinking", { type: "set_thinking_level", level }),
    get: (threadId) => Ref.get(sessions).pipe(Effect.map((known) => known.get(threadId))),
    listModels: loadModelCatalog,
    events: process.events.pipe(
      Stream.mapError(
        (cause) =>
          new PiSessionManagerError({
            operation: "events",
            threadId: "unknown" as ThreadId,
            detail: cause.message,
            cause,
          }),
      ),
      Stream.mapEffect((event) =>
        Ref.get(activeThread).pipe(
          Effect.map((threadId) => {
            // Extension UI requests (setStatus/setWidget/notify from pi's
            // trackers like subscription-meter / quotas / LSP / goal) are
            // process-global — surface them even before any thread activates.
            if (event.type === "extension_ui_request") {
              return Result.succeed({
                threadId: threadId ?? ("extension" as ThreadId),
                event,
              });
            }
            return threadId ? Result.succeed({ threadId, event }) : Result.failVoid;
          }),
        ),
      ),
      Stream.filterMap((value) => value),
    ),
  } satisfies PiSessionManagerShape;
});

export const layer = Layer.effect(PiSessionManager, make);
