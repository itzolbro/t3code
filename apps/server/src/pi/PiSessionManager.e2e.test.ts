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

// The prompt round-trip needs a reachable pi model. CI has no API keys, so
// `T3CODE_PI_E2E_PROMPT` opts the prompt test in; the session-lifecycle test
// (create + get_state) runs everywhere. Locally both run by default.
const runPromptE2E = process.env.T3CODE_PI_E2E_PROMPT !== "0";

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
        // first event may take a while (model cold start). Skipped in CI
        // where no model is configured (T3CODE_PI_E2E_PROMPT=0).
        if (runPromptE2E) {
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
        }
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
