/**
 * Pi extension-tracker state — surfaces pi's installed usage trackers
 * (subscription-meter, quotas, LSP status, goal, statusline, pwsh) as Pi Tie
 * features. pi's extensions emit `extension_ui_request` messages over the
 * RPC stream (setStatus / setWidget / notify); these flow through the TUI
 * publish stream and are parsed here into renderable state.
 *
 * @module web/state/piExtensions
 */
import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId, type TuiPublishedEvent } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo, useRef, useState } from "react";

import { tuiPublish } from "./tui";

export interface PiStatusEntry {
  readonly key: string;
  readonly text: string;
}

export interface PiWidget {
  readonly key: string;
  readonly lines: ReadonlyArray<string>;
}

export interface PiExtensionState {
  readonly statuses: ReadonlyArray<PiStatusEntry>;
  readonly widgets: ReadonlyArray<PiWidget>;
  readonly notices: ReadonlyArray<{
    readonly id: number;
    readonly level: string;
    readonly text: string;
  }>;
}

interface ExtensionUiRequest {
  readonly type?: unknown;
  readonly method?: unknown;
  readonly statusKey?: unknown;
  readonly statusText?: unknown;
  readonly widgetKey?: unknown;
  readonly widgetLines?: unknown;
  readonly message?: unknown;
  readonly notifyType?: unknown;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const widgetLines = (value: unknown): ReadonlyArray<string> => {
  if (!Array.isArray(value)) return [];
  return value.filter((line): line is string => typeof line === "string");
};

const EMPTY: PiExtensionState = { statuses: [], widgets: [], notices: [] };

/**
 * Parse one published pi event into extension-tracker updates.
 */
export function parseExtensionUiEvent(
  event: TuiPublishedEvent,
  previous: PiExtensionState,
  noticeSeq: number,
): { readonly next: PiExtensionState; readonly noticeSeq: number } {
  if (event.type !== "extension_ui_request") {
    return { next: previous, noticeSeq };
  }
  const raw = asRecord(event.raw) as ExtensionUiRequest | undefined;
  if (
    !raw ||
    (raw.method !== "setStatus" && raw.method !== "setWidget" && raw.method !== "notify")
  ) {
    return { next: previous, noticeSeq };
  }

  if (raw.method === "setStatus") {
    const key = text(raw.statusKey);
    const statusText = text(raw.statusText);
    if (!key) return { next: previous, noticeSeq };
    const nextStatuses =
      statusText === undefined
        ? previous.statuses.filter((entry) => entry.key !== key)
        : [...previous.statuses.filter((entry) => entry.key !== key), { key, text: statusText }];
    return { next: { ...previous, statuses: nextStatuses }, noticeSeq };
  }

  if (raw.method === "setWidget") {
    const key = text(raw.widgetKey);
    if (!key) return { next: previous, noticeSeq };
    const lines = widgetLines(raw.widgetLines);
    const nextWidgets =
      lines.length === 0
        ? previous.widgets.filter((widget) => widget.key !== key)
        : [...previous.widgets.filter((widget) => widget.key !== key), { key, lines }];
    return { next: { ...previous, widgets: nextWidgets }, noticeSeq };
  }

  const message = text(raw.message);
  if (!message) return { next: previous, noticeSeq };
  const level = text(raw.notifyType) ?? "info";
  return {
    next: {
      ...previous,
      notices: [...previous.notices.slice(-4), { id: ++noticeSeq, level, text: message }],
    },
    noticeSeq,
  };
}

/**
 * Consume the tui publish stream and derive pi extension state.
 */
export function usePiExtensions(environmentId: EnvironmentId): PiExtensionState {
  const publishState = useAtomValue(tuiPublish({ environmentId, input: {} }));
  const [state, setState] = useState<PiExtensionState>(EMPTY);
  const stateRef = useRef(state);
  stateRef.current = state;
  const noticeSeq = useRef(0);

  const latest = Option.getOrNull(AsyncResult.value(publishState)) ?? null;

  useEffect(() => {
    if (latest === null) return;
    const { next, noticeSeq: nextSeq } = parseExtensionUiEvent(
      latest,
      stateRef.current,
      noticeSeq.current,
    );
    if (next !== stateRef.current) {
      noticeSeq.current = nextSeq;
      setState(next);
    }
  }, [latest]);

  return useMemo(() => state, [state]);
}
