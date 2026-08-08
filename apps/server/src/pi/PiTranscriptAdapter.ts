// @effect-diagnostics globalDateInEffect:off
// @effect-diagnostics globalDate:off
import {
  EventId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

export type PiTranscriptEvent =
  | {
      readonly type: "text";
      readonly threadId: ThreadId;
      readonly delta: string;
    }
  | {
      readonly type: "tool";
      readonly threadId: ThreadId;
      readonly phase: "start" | "update" | "end";
      readonly toolCallId?: string;
      readonly name?: string;
      readonly content?: string;
    }
  | {
      readonly type: "turn";
      readonly threadId: ThreadId;
      readonly phase: "start" | "end" | "abort";
    }
  | {
      readonly type: "error";
      readonly threadId: ThreadId;
      readonly message: string;
    };

interface PiEventRecord {
  readonly type?: unknown;
  readonly assistantMessageEvent?: unknown;
  readonly toolCallId?: unknown;
  readonly toolName?: unknown;
  readonly partialResult?: unknown;
  readonly delta?: unknown;
  readonly error?: unknown;
}

const record = (value: unknown): PiEventRecord =>
  typeof value === "object" && value !== null ? (value as PiEventRecord) : {};

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

export function adapt(threadId: ThreadId, value: unknown): PiTranscriptEvent | undefined {
  const event = record(value);
  if (event.type === "turn_start") return { type: "turn", threadId, phase: "start" };
  if (event.type === "turn_end") return { type: "turn", threadId, phase: "end" };
  if (event.type === "agent_end") return { type: "turn", threadId, phase: "end" };
  if (event.type === "agent_abort") return { type: "turn", threadId, phase: "abort" };
  if (event.type === "tool_execution_start") {
    const toolCallId = text(event.toolCallId);
    const name = text(event.toolName);
    return {
      type: "tool",
      threadId,
      phase: "start",
      ...(toolCallId ? { toolCallId } : {}),
      ...(name ? { name } : {}),
    };
  }
  if (event.type === "tool_execution_update") {
    const toolCallId = text(event.toolCallId);
    const content = text(event.partialResult);
    return {
      type: "tool",
      threadId,
      phase: "update",
      ...(toolCallId ? { toolCallId } : {}),
      ...(content ? { content } : {}),
    };
  }
  if (event.type === "tool_execution_end") {
    const toolCallId = text(event.toolCallId);
    return {
      type: "tool",
      threadId,
      phase: "end",
      ...(toolCallId ? { toolCallId } : {}),
    };
  }
  if (event.type === "message_update") {
    const message = record(event.assistantMessageEvent);
    const delta = text(message.delta);
    return delta ? { type: "text", threadId, delta } : undefined;
  }
  if (event.type === "error") {
    return { type: "error", threadId, message: text(event.error) ?? "Pi reported an error" };
  }
  return undefined;
}

export function runtime(
  providerInstanceId: string,
  event: PiTranscriptEvent,
): ProviderRuntimeEvent {
  const base = {
    eventId: EventId.make(`pi-${event.threadId}-${event.type}`),
    provider: ProviderDriverKind.make("pi"),
    providerInstanceId,
    threadId: event.threadId,
    createdAt: new Date().toISOString(),
  };
  if (event.type === "text") {
    return {
      ...base,
      type: "content.delta",
      payload: { streamKind: "assistant", delta: event.delta },
    } as unknown as ProviderRuntimeEvent;
  }
  if (event.type === "turn") {
    return {
      ...base,
      turnId: TurnId.make(`pi-turn-${event.threadId}`),
      type:
        event.phase === "start"
          ? "turn.started"
          : event.phase === "abort"
            ? "turn.aborted"
            : "turn.completed",
      payload:
        event.phase === "start"
          ? {}
          : event.phase === "abort"
            ? { reason: "Pi aborted the turn" }
            : { state: "completed", stopReason: null },
    } as unknown as ProviderRuntimeEvent;
  }
  return {
    ...base,
    type: "runtime.error",
    payload: { message: event.type === "error" ? event.message : "Pi tool event" },
  } as unknown as ProviderRuntimeEvent;
}
