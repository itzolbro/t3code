/**
 * Pi TUI bridge — the opencode-style control plane between a remote UI and
 * the live pi agent loop (see PLAN-pi-harness Phase 3).
 *
 * The bridge mirrors opencode's `tui-control.ts`: the pi RPC session is the
 * source of truth, and remote surfaces drive it through append/submit/
 * execute commands while receiving a publish stream of pi events.
 *
 * Wire protocol is WS-RPC (`TUI_WS_METHODS`); every method is a plain
 * request/response plus `tui.publish` as the event stream.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { ThreadId } from "./baseSchemas.ts";
import { EnvironmentAuthorizationError } from "./auth.ts";

export const TUI_WS_METHODS = {
  tuiAppendPrompt: "tui.appendPrompt",
  tuiSubmitPrompt: "tui.submitPrompt",
  tuiClearPrompt: "tui.clearPrompt",
  tuiExecuteCommand: "tui.executeCommand",
  tuiSelectSession: "tui.selectSession",
  tuiPublish: "tui.publish",
} as const;

export const TuiAppendPromptInput = Schema.Struct({
  threadId: ThreadId,
  text: Schema.String,
});
export type TuiAppendPromptInput = typeof TuiAppendPromptInput.Type;

export const TuiSubmitPromptInput = Schema.Struct({
  threadId: ThreadId,
  text: Schema.String,
});
export type TuiSubmitPromptInput = typeof TuiSubmitPromptInput.Type;

export const TuiClearPromptInput = Schema.Struct({
  threadId: ThreadId,
});
export type TuiClearPromptInput = typeof TuiClearPromptInput.Type;

export const TuiExecuteCommandInput = Schema.Struct({
  threadId: ThreadId,
  command: Schema.String,
});
export type TuiExecuteCommandInput = typeof TuiExecuteCommandInput.Type;

export const TuiSelectSessionInput = Schema.Struct({
  threadId: ThreadId,
  sessionPath: Schema.String,
});
export type TuiSelectSessionInput = typeof TuiSelectSessionInput.Type;

/**
 * A pi RPC event mirrored out of the bridge. `raw` carries the parsed pi
 * JSONL payload so a virtual-terminal renderer can display it verbatim.
 */
export const TuiPublishedEvent = Schema.Struct({
  threadId: ThreadId,
  type: Schema.String,
  raw: Schema.Unknown,
});
export type TuiPublishedEvent = typeof TuiPublishedEvent.Type;

export const TuiCommandResult = Schema.Struct({
  ok: Schema.Boolean,
  detail: Schema.optional(Schema.String),
});
export type TuiCommandResult = typeof TuiCommandResult.Type;

export const WsTuiAppendPromptRpc = Rpc.make(TUI_WS_METHODS.tuiAppendPrompt, {
  payload: TuiAppendPromptInput,
  success: TuiCommandResult,
  error: EnvironmentAuthorizationError,
});

export const WsTuiSubmitPromptRpc = Rpc.make(TUI_WS_METHODS.tuiSubmitPrompt, {
  payload: TuiSubmitPromptInput,
  success: TuiCommandResult,
  error: EnvironmentAuthorizationError,
});

export const WsTuiClearPromptRpc = Rpc.make(TUI_WS_METHODS.tuiClearPrompt, {
  payload: TuiClearPromptInput,
  success: TuiCommandResult,
  error: EnvironmentAuthorizationError,
});

export const WsTuiExecuteCommandRpc = Rpc.make(TUI_WS_METHODS.tuiExecuteCommand, {
  payload: TuiExecuteCommandInput,
  success: TuiCommandResult,
  error: EnvironmentAuthorizationError,
});

export const WsTuiSelectSessionRpc = Rpc.make(TUI_WS_METHODS.tuiSelectSession, {
  payload: TuiSelectSessionInput,
  success: TuiCommandResult,
  error: EnvironmentAuthorizationError,
});

export const WsTuiPublishRpc = Rpc.make(TUI_WS_METHODS.tuiPublish, {
  payload: Schema.Struct({}),
  success: TuiPublishedEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});
