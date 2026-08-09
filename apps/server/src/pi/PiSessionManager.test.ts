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
      expect(requests.map((request) => request.type)).toEqual([
        "new_session",
        "get_state",
        "prompt",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("resolves a model slug through the pi model catalog before set_model", () => {
    const requests: Array<Record<string, unknown>> = [];
    const fakeProcess = {
      request: <T>(request: Record<string, unknown>) => {
        requests.push(request);
        const data =
          request.type === "get_available_models"
            ? {
                models: [
                  { id: "gpt-5.4", provider: "openai", name: "GPT-5.4" },
                  { id: "claude-opus-4-6", provider: "anthropic", name: "Claude Opus 4.6" },
                ],
              }
            : { sessionFile: "/tmp/pi-session.jsonl" };
        return Effect.succeed({ type: "response", success: true, data } as T);
      },
      events: Stream.empty as Stream.Stream<PiRpcResponse>,
    } satisfies typeof PiProcess.Service;
    const layer = PiSessionManager.layer.pipe(Layer.provide(Layer.succeed(PiProcess, fakeProcess)));
    const threadId = ThreadId.make("thread-model");

    return Effect.gen(function* () {
      const manager = yield* PiSessionManager.PiSessionManager;
      yield* manager.create(threadId, "/tmp/project");
      yield* manager.setModel(threadId, "claude-opus-4-6");
      const setModelRequest = requests.find((request) => request.type === "set_model");
      expect(setModelRequest).toEqual({
        id: "pi-setModel-thread-model",
        type: "set_model",
        provider: "anthropic",
        modelId: "claude-opus-4-6",
      });
      expect(requests.map((request) => request.type)).toEqual([
        "new_session",
        "get_state",
        "get_available_models",
        "set_model",
      ]);
    }).pipe(Effect.provide(layer));
  });
});
