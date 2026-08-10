import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import { ThreadId } from "@t3tools/contracts";

import * as PiTuiBridge from "./PiTuiBridge.ts";
import { PiSessionManager } from "../pi/PiSessionManager.ts";

describe("PiTuiBridge", () => {
  it.effect("routes submit commands to the pi session manager", () => {
    const submitted: Array<{ readonly threadId: ThreadId; readonly text: string }> = [];
    const fakeManager = {
      create: () =>
        Effect.succeed({ threadId: ThreadId.make("x"), sessionPath: "/tmp/x", cwd: "/tmp" }),
      open: () =>
        Effect.succeed({ threadId: ThreadId.make("x"), sessionPath: "/tmp/x", cwd: "/tmp" }),
      submit: (threadId: ThreadId, text: string) =>
        Effect.sync(() => {
          submitted.push({ threadId, text });
        }),
      abort: () => Effect.void,
      setModel: () => Effect.void,
      setThinking: () => Effect.void,
      listModels: Effect.succeed([]),
      get: () => Effect.succeed(undefined),
      events: Stream.empty,
    } satisfies typeof PiSessionManager.Service;
    const layer = PiTuiBridge.layer.pipe(
      Layer.provide(Layer.succeed(PiSessionManager, fakeManager)),
    );
    const threadId = ThreadId.make("tui-thread");

    return Effect.gen(function* () {
      const bridge = yield* PiTuiBridge.PiTuiBridge;
      yield* bridge.command({ type: "submit", threadId, text: "hello pi" });
      yield* bridge.command({ type: "execute", threadId, text: "/status" });
      yield* bridge.command({ type: "clear", threadId });
      expect(submitted).toEqual([
        { threadId, text: "hello pi" },
        { threadId, text: "/status" },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("publishes manager events through the bridge", () => {
    const queue = yieldQueue();
    const fakeManager = {
      create: () =>
        Effect.succeed({ threadId: ThreadId.make("x"), sessionPath: "/tmp/x", cwd: "/tmp" }),
      open: () =>
        Effect.succeed({ threadId: ThreadId.make("x"), sessionPath: "/tmp/x", cwd: "/tmp" }),
      submit: () => Effect.void,
      abort: () => Effect.void,
      setModel: () => Effect.void,
      setThinking: () => Effect.void,
      listModels: Effect.succeed([]),
      get: () => Effect.succeed(undefined),
      events: Stream.fromQueue(queue),
    } satisfies typeof PiSessionManager.Service;
    const layer = PiTuiBridge.layer.pipe(
      Layer.provide(Layer.succeed(PiSessionManager, fakeManager)),
    );
    const threadId = ThreadId.make("tui-thread");

    return Effect.gen(function* () {
      const bridge = yield* PiTuiBridge.PiTuiBridge;
      yield* Queue.offer(queue, { threadId, event: { type: "message_update" } });
      const published = yield* bridge.published.pipe(
        Effect.map((stream) => Stream.runHead(stream)),
        Effect.flatten,
      );
      expect(published._tag).toBe("Some");
      if (published._tag === "Some") {
        expect(published.value).toEqual({
          threadId,
          event: { type: "message_update" },
        });
      }
    }).pipe(Effect.provide(layer), Effect.scoped);
  });
});

function yieldQueue() {
  return Effect.runSync(Queue.unbounded<{ threadId: ThreadId; event: { type: string } }>());
}
