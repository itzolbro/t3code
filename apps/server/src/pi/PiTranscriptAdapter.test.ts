import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";

import { adapt } from "./PiTranscriptAdapter.ts";

const threadId = ThreadId.make("thread-pi");

describe("PiTranscriptAdapter", () => {
  it("adapts streamed assistant text", () => {
    expect(
      adapt(threadId, {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "hello" },
      }),
    ).toEqual({ type: "text", threadId, delta: "hello" });
  });

  it("adapts tool lifecycle events", () => {
    expect(
      adapt(threadId, { type: "tool_execution_start", toolCallId: "call-1", toolName: "bash" }),
    ).toEqual({ type: "tool", threadId, phase: "start", toolCallId: "call-1", name: "bash" });
  });

  it("ignores unrelated events", () => {
    expect(adapt(threadId, { type: "session_info" })).toBeUndefined();
  });
});
