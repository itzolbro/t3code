import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Result from "effect/Result";

import { PiProcess, type PiRpcRequest, type PiRpcResponse } from "./PiProcess.ts";

interface PiSession {
  readonly threadId: ThreadId;
  readonly sessionPath: string;
  readonly cwd: string;
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
  readonly setModel: (
    threadId: ThreadId,
    provider: string,
    modelId: string,
  ) => Effect.Effect<void, PiSessionManagerError>;
  readonly setThinking: (
    threadId: ThreadId,
    level: string,
  ) => Effect.Effect<void, PiSessionManagerError>;
  readonly get: (threadId: ThreadId) => Effect.Effect<PiSession | undefined>;
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

const make = Effect.gen(function* () {
  const process = yield* PiProcess;
  const sessions = yield* Ref.make<Map<ThreadId, PiSession>>(new Map());

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

  const create = (threadId: ThreadId, cwd: string) =>
    request(threadId, "create", { type: "new_session" }).pipe(
      Effect.map((response) => ({
        threadId,
        sessionPath: sessionPath(response),
        cwd,
      })),
      Effect.tap((session) =>
        Ref.update(sessions, (known) => new Map(known).set(threadId, session)),
      ),
    );

  const open = (threadId: ThreadId, path: string, cwd: string) =>
    request(threadId, "open", { type: "switch_session", sessionPath: path }).pipe(
      Effect.map(() => ({ threadId, sessionPath: path, cwd })),
      Effect.tap((session) =>
        Ref.update(sessions, (known) => new Map(known).set(threadId, session)),
      ),
    );

  const command = (threadId: ThreadId, operation: string, input: Record<string, unknown>) =>
    current(threadId, operation).pipe(
      Effect.andThen(request(threadId, operation, input)),
      Effect.asVoid,
    );

  return {
    create,
    open,
    submit: (threadId, message) => command(threadId, "submit", { type: "prompt", message }),
    abort: (threadId) => command(threadId, "abort", { type: "abort" }),
    setModel: (threadId, provider, modelId) =>
      command(threadId, "setModel", { type: "set_model", provider, modelId }),
    setThinking: (threadId, level) =>
      command(threadId, "setThinking", { type: "set_thinking_level", level }),
    get: (threadId) => Ref.get(sessions).pipe(Effect.map((known) => known.get(threadId))),
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
        Ref.get(sessions).pipe(
          Effect.flatMap((known) => {
            const eventSession =
              asRecord(event.data)?.sessionFile ?? asRecord(event.data)?.sessionId;
            const match = [...known.values()].find(
              (session) => session.sessionPath === eventSession,
            );
            return Effect.succeed(
              match ? Result.succeed({ threadId: match.threadId, event }) : Result.failVoid,
            );
          }),
        ),
      ),
      Stream.filterMap((value) => value),
    ),
  } satisfies PiSessionManagerShape;
});

export const layer = Layer.effect(PiSessionManager, make);
