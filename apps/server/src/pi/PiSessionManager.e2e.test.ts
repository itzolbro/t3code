import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ThreadId } from "@t3tools/contracts";

import * as PiProcess from "./PiProcess.ts";
import * as PiSessionManager from "./PiSessionManager.ts";

describe("PiSessionManager (real child)", () => {
  it.effect(
    "creates a session, applies a model, and receives streamed events after a prompt",
    () =>
      Effect.gen(function* () {
        const manager = yield* PiSessionManager.PiSessionManager;
        const threadId = ThreadId.make("t3-e2e-thread");
        const events = yield* Queue.unbounded<{ readonly threadId: ThreadId }>();
        yield* manager.events
          .pipe(Stream.runForEach((e) => Queue.offer(events, e)))
          .pipe(Effect.forkScoped);

        const session = yield* manager
          .create(threadId, process.cwd())
          .pipe(Effect.timeout(Duration.minutes(3)));
        expect(session.sessionPath.length).toBeGreaterThan(0);

        yield* manager
          .submit(threadId, "Reply with exactly: PONG")
          .pipe(Effect.timeout(Duration.minutes(3)));

        // pi streams agent/turn events after the prompt is accepted; the
        // first event may take a while (model cold start).
        let sawActivity = false;
        for (let i = 0; i < 36; i += 1) {
          const next = yield* Queue.take(events).pipe(
            Effect.timeout(Duration.seconds(5)),
            Effect.orElseSucceed(() => undefined),
          );
          if (next) {
            sawActivity = true;
            break;
          }
        }
        expect(sawActivity).toBe(true);
      }).pipe(
        Effect.provide(
          PiSessionManager.layer.pipe(
            Layer.provide(PiProcess.layer),
            Layer.provide(NodeServices.layer),
          ),
        ),
        Effect.scoped,
      ),
    { timeout: 400_000 },
  );
});
