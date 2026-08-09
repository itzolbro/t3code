/**
 * PiTuiBridge — opencode-style queue control plane over the pi session.
 *
 * Mirrors opencode's `tui-control.ts`: a remote UI drives the live pi agent
 * loop through request/response queues (`nextTuiRequest` / `nextTuiResponse`)
 * and receives the mirrored event stream via a publish bus. The bridge owns
 * no agent state — `PiSessionManager` (and through it the pi RPC child) is
 * the source of truth.
 *
 * @module tui/PiTuiBridge
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { PiRpcResponse } from "../pi/PiProcess.ts";
import { PiSessionManager, PiSessionManagerError } from "../pi/PiSessionManager.ts";

export interface TuiBridgeCommand {
  readonly type: "append" | "submit" | "clear" | "execute" | "select";
  readonly threadId: ThreadId;
  readonly text?: string | undefined;
  readonly sessionPath?: string | undefined;
}

export interface TuiBridgeShape {
  /** Enqueue a control command for the pi session. */
  readonly command: (command: TuiBridgeCommand) => Effect.Effect<void, PiSessionManagerError>;
  /** Acquire the published pi-event stream (caller scopes the subscription). */
  readonly published: Effect.Effect<
    Stream.Stream<
      { readonly threadId: ThreadId; readonly event: PiRpcResponse },
      PiSessionManagerError
    >,
    never,
    Scope.Scope
  >;
  /** Queue-backed request handoff for remote TUI control. */
  readonly nextRequest: Effect.Effect<TuiBridgeCommand | undefined, never>;
  readonly respond: (response: unknown) => Effect.Effect<void, never>;
}

export class PiTuiBridgeError extends Schema.TaggedErrorClass<PiTuiBridgeError>()(
  "PiTuiBridgeError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Pi TUI bridge ${this.operation} failed: ${this.detail}`;
  }
}

export class PiTuiBridge extends Context.Service<PiTuiBridge, TuiBridgeShape>()(
  "t3/tui/PiTuiBridge",
) {}

const make = Effect.gen(function* () {
  const manager = yield* PiSessionManager;
  const controlRequests = yield* Queue.unbounded<TuiBridgeCommand>();
  const controlResponses = yield* Queue.unbounded<unknown>();
  const published = yield* PubSub.unbounded<{
    readonly threadId: ThreadId;
    readonly event: PiRpcResponse;
  }>();

  // Fan manager events into the publish bus for bridge consumers.
  yield* manager.events.pipe(
    Stream.tap((entry) => PubSub.publish(published, entry).pipe(Effect.asVoid)),
    Stream.runDrain,
    Effect.forkScoped,
  );

  // Bridge consumers subscribe through an explicit subscription so fan-out
  // stays live regardless of consumer count. The subscription effect is
  // scoped by the caller (matching `subscribeChanges` elsewhere in the repo).
  const subscribePublished = PubSub.subscribe(published).pipe(
    Effect.map((subscription) => Stream.fromSubscription(subscription)),
  );

  const runCommand = (command: TuiBridgeCommand) =>
    Effect.gen(function* () {
      switch (command.type) {
        case "append":
          // Append is a no-op on the server: the client keeps draft state.
          return;
        case "submit":
          if (!command.text) return;
          yield* manager.submit(command.threadId, command.text);
          return;
        case "clear":
          return;
        case "execute":
          if (!command.text) return;
          yield* manager.submit(command.threadId, command.text);
          return;
        case "select":
          if (!command.sessionPath) return;
          yield* manager.open(command.threadId, command.sessionPath, process.cwd());
          return;
      }
    });

  return {
    command: (command) =>
      runCommand(command).pipe(Effect.mapError((cause) => cause as PiSessionManagerError)),
    published: subscribePublished.pipe(
      Effect.map((stream) =>
        stream.pipe(
          Stream.mapError(
            (cause) =>
              new PiSessionManagerError({
                operation: "published",
                threadId: "unknown" as ThreadId,
                detail: String(cause),
                cause,
              }),
          ),
        ),
      ),
    ),
    nextRequest: Queue.take(controlRequests).pipe(
      Effect.map((command) => (command === undefined ? undefined : command)),
      Effect.catch(() => Effect.succeed(undefined)),
    ),
    respond: (response) => Queue.offer(controlResponses, response).pipe(Effect.asVoid),
  } satisfies TuiBridgeShape;
});

export const layer = Layer.effect(PiTuiBridge, make);
