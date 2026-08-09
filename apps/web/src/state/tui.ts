/**
 * Pi TUI bridge state — web-side atoms for the TUI-mode view.
 *
 * Exposes the `tui.*` WS-RPC methods through the connection runtime:
 * submit prompts to the active pi session, and subscribe to the published pi
 * event stream that a virtual-terminal view renders.
 *
 * @module web/state/tui
 */
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  TUI_WS_METHODS,
  type TuiAppendPromptInput,
  type TuiClearPromptInput,
  type TuiCommandResult,
  type TuiPublishedEvent,
  type TuiSelectSessionInput,
  type TuiSubmitPromptInput,
} from "@t3tools/contracts";
import * as Stream from "effect/Stream";

import { connectionAtomRuntime } from "../connection/runtime";

export const tuiSubmitPrompt = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:tui:submit-prompt",
  tag: TUI_WS_METHODS.tuiSubmitPrompt,
  concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
});

export const tuiAppendPrompt = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:tui:append-prompt",
  tag: TUI_WS_METHODS.tuiAppendPrompt,
});

export const tuiClearPrompt = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:tui:clear-prompt",
  tag: TUI_WS_METHODS.tuiClearPrompt,
});

export const tuiSelectSession = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:tui:select-session",
  tag: TUI_WS_METHODS.tuiSelectSession,
});

/**
 * The published pi event stream for the primary environment. Renders the
 * live pi session (message deltas, tool activity, turn boundaries) the same
 * way a virtual terminal would.
 */
export const tuiPublish = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:tui:publish",
  tag: TUI_WS_METHODS.tuiPublish,
  idleTtlMs: 0,
});

export type TuiPublishInput = {
  readonly environmentId: string;
  readonly input: Record<string, never>;
};

export type {
  TuiAppendPromptInput,
  TuiClearPromptInput,
  TuiCommandResult,
  TuiPublishedEvent,
  TuiSelectSessionInput,
  TuiSubmitPromptInput,
};
