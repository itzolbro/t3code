import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ThreadId } from "@t3tools/contracts";

import { PiProcess, type PiRpcResponse } from "./PiProcess.ts";
import * as PiSessionManager from "./PiSessionManager.ts";

describe("PiSessionManager", () => {
  it.effect("maps a thread to a created pi session and submits prompts", () => {
    const requests: Array<Record<string, unknown>> = [];
    const fakeProcess = {
      request: <T>(request: Record<string, unknown>) => {
        requests.push(request);
        return Effect.succeed({
          type: "response",
          success: true,
          data: { sessionFile: "/tmp/pi-session.jsonl" },
        } as T);
      },
      events: Stream.empty as Stream.Stream<PiRpcResponse>,
    } satisfies typeof PiProcess.Service;
    const layer = PiSessionManager.layer.pipe(Layer.provide(Layer.succeed(PiProcess, fakeProcess)));
    const threadId = ThreadId.make("thread-pi");

    return Effect.gen(function* () {
      const manager = yield* PiSessionManager.PiSessionManager;
      const session = yield* manager.create(threadId, "/tmp/project");
      yield* manager.submit(threadId, "hello");
      expect(session.sessionPath).toBe("/tmp/pi-session.jsonl");
      expect(requests.map((request) => request.type)).toEqual(["new_session", "prompt"]);
    }).pipe(Effect.provide(layer));
  });
});
