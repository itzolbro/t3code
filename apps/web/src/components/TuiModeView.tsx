import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId, ThreadId, type TuiPublishedEvent } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useRef, useState } from "react";

import { useAtomCommand } from "../state/use-atom-command";
import { tuiPublish, tuiSubmitPrompt } from "../state/tui";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

interface TuiModeViewProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onExitTuiMode: () => void;
}

interface RenderedLine {
  readonly key: string;
  readonly text: string;
  readonly tone: "assistant" | "tool" | "system" | "user";
}

const toneForEvent = (type: string): RenderedLine["tone"] => {
  if (type.includes("tool")) return "tool";
  if (type.includes("turn") || type === "agent_start" || type === "agent_end") return "system";
  return "assistant";
};

const renderEvent = (event: TuiPublishedEvent): RenderedLine => {
  const raw = event.raw as {
    readonly data?: { readonly delta?: string; readonly state?: string };
    readonly message?: string;
  };
  const detail =
    typeof raw.message === "string"
      ? raw.message
      : typeof raw.data?.delta === "string"
        ? raw.data.delta
        : typeof raw.data?.state === "string"
          ? raw.data.state
          : JSON.stringify(raw.data ?? "").slice(0, 200);
  return {
    key: `${event.type}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    text: detail.length > 0 ? `[${event.type}] ${detail}` : `[${event.type}]`,
    tone: toneForEvent(event.type),
  };
};

/**
 * TUI mode — a virtual terminal fed by the pi publish stream. Native chat
 * mode and TUI mode drive the same pi session (see PLAN Phase 3).
 */
export function TuiModeView({ environmentId, threadId, onExitTuiMode }: TuiModeViewProps) {
  const publishState = useAtomValue(tuiPublish({ environmentId, input: {} }));
  const submitCommand = useAtomCommand(tuiSubmitPrompt, { reportFailure: false });
  const [draft, setDraft] = useState("");
  const [lines, setLines] = useState<ReadonlyArray<RenderedLine>>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastSeen = useRef<{ readonly type: string; readonly raw: unknown } | null>(null);

  const latest = Option.getOrNull(AsyncResult.value(publishState)) ?? null;

  useEffect(() => {
    if (latest === null || latest === lastSeen.current) return;
    lastSeen.current = latest;
    setLines((previous) => [...previous.slice(-500), renderEvent(latest)]);
  }, [latest]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lines]);

  const submit = () => {
    const text = draft.trim();
    if (text.length === 0) return;
    setLines((previous) => [...previous, { key: `user-${Date.now()}`, text, tone: "user" }]);
    void submitCommand({ environmentId, input: { threadId, text } });
    setDraft("");
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-black font-mono text-sm text-zinc-100">
      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-1.5 text-xs text-zinc-500">
        <span>pi TUI — {String(threadId)}</span>
        <button
          type="button"
          onClick={onExitTuiMode}
          className="rounded px-2 py-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
        >
          exit TUI mode
        </button>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2 whitespace-pre-wrap">
        {lines.map((line) => (
          <div
            key={line.key}
            className={
              line.tone === "tool"
                ? "text-amber-300/80"
                : line.tone === "system"
                  ? "text-zinc-500"
                  : line.tone === "user"
                    ? "text-sky-300"
                    : "text-zinc-100"
            }
          >
            {line.text}
          </div>
        ))}
      </div>
      <div className="flex items-end gap-2 border-t border-zinc-800 p-2">
        <Textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder="Prompt pi… (Enter to submit, Shift+Enter for newline)"
          className="min-h-9 max-h-40 flex-1 resize-none bg-zinc-900 font-mono text-sm"
        />
        <Button type="button" onClick={submit} disabled={draft.trim().length === 0}>
          Send
        </Button>
      </div>
    </div>
  );
}
