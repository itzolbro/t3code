# Plan: Convert t3code → "Pi Tie" — Desktop harness for the pi coding agent

Fork: `github.com/itzolbro/t3code` (upstream `pingdotgg/t3code`, default branch `main`).
Goal: strip every mobile/cloud/web feature; keep the Electron desktop shell + local server
bridge; re-target the server so it drives **pi** (the harness) instead of the bundled
Codex/Claude agent; embed the pi TUI (Ink) in the Electron renderer; support Windows,
macOS, Linux. No iOS/Android, no EAS, no relay, no T3 Connect, no auth cloud.

---

## 0. Research summary — how each project connects its TUI to its desktop app

### A. t3code (the fork's starting point) — Effect RPC over WebSocket

- **Process model.** `apps/server` is a Node CLI (`bin.ts`) exposing `t3 start` / `t3 serve`
  (<https://github.com/pingdotgg/t3code/blob/main/apps/server/src/cli/server.ts>). The
  Electron main process (`apps/desktop/src/backend/DesktopBackendManager.ts`) spawns the
  server as a child process, polls a readiness endpoint
  (`/.well-known/t3/environment`, `BACKEND_READINESS_PATH`), and restarts it with backoff on
  crash. The renderer never talks to the server directly — it goes through
  `packages/client-runtime`.
- **Wire protocol.** Effect `RpcServer`/`RpcClient` over a WebSocket (`apps/server/src/ws.ts`
  → `WsRpcGroup` from `packages/contracts/src/rpc.ts`). Client session
  (`packages/client-runtime/src/rpc/session.ts`) uses `Socket.layerWebSocket` +
  `RpcClient.makeProtocolSocket` + `RpcSerialization.layerJson`. Method names are string
  constants (`WS_METHODS`, `ORCHESTRATION_WS_METHODS`). Streams/subscriptions are first-class
  (`subscribeThread`, `subscribeShell`, `subscribeTerminalEvents`).
- **Renderer.** `apps/web` + `apps/desktop` (Electron) load the same React SPA; desktop shell
  adds `preload.ts` exposing a `window.desktopBridge` (`contextBridge` + `ipcRenderer`) for
  OS features (window, settings, updates, SSH/WSL environment bootstrapping, secret storage).
  Renderer → server transport is the WS-RPC client; desktop-specific OS calls are IPC.
- **Orchestration.** `apps/server/src/orchestration/*` owns the session state machine
  (`OrchestrationEngine`), provider registry, approval policy, sandbox modes
  (`ProviderSandboxMode`), and checkpointing. This is the part that changes: today it drives
  the bundled Anthropic/Codex SDK; we replace the "provider" boundary with pi.

### B. opencode — HTTP API + SSE + queue-based TUI control (the reference)

- **Process model.** Electron main (`packages/desktop/src/main/index.ts`) spawns the local
  server as a **sidecar** via `utilityProcess.fork(sidecar.js, ...)`
  (`packages/desktop/src/main/server.ts`), with env flags (`OPENCODE_CLIENT=desktop`,
  `XDG_STATE_HOME`), health-polling (`checkHealth`), and a stop path. Renderer is the same
  web app (`packages/app`), fetched from the local server.
- **Wire protocol.** Plain HTTP API + SSE for events (no custom RPC crate):
  `packages/opencode/src/server/routes/instance/httpapi/*` — groups like `session.ts`,
  `tui.ts`, `event.ts`, `control.ts`. Password/bearer auth on localhost.
- **TUI→desktop bridge (the key idea).** `packages/opencode/src/server/shared/tui-control.ts`
  is a **global async queue**: the TUI runs in the same process as the server and registers
  `nextTuiRequest()`/`nextTuiResponse()`; the HTTP layer exposes
  `POST /tui/append-prompt`, `/tui/submit-prompt`, `/tui/execute-command`, `/tui/publish`,
  `/tui/control/next`, `/tui/control/response` (`packages/opencode/src/server/routes/instance/httpapi/groups/tui.ts`).
  So the TUI **is** the control plane: a remote UI drives a live TUI instance through
  request/response queues, and TUI events are mirrored out over SSE
  (`packages/opencode/src/server/tui-event.ts`).
- **Takeaway for us.** OpenCode's "TUI as the source of truth, bridged by queues over
  HTTP/SSE" is exactly the pattern we want: pi's own TUI (Ink) keeps working, and the
  Electron app becomes a remote that drives it.

### C. pi (the harness being embedded)

- Package `@earendil-works/pi-coding-agent` (v0.84.1 installed). Public SDK surface:
  - `dist/client/index.d.ts` → `RemoteSession` class (`open/create/submit/abort/setModel/
setThinking/reconnect/dispose`) + transcript helpers.
  - `RemoteSession` wraps a `PiClient` (from `@earendil-works/pi-client`): it acquires an
    exclusive session handle, streams `session_progress` events, applies transcript
    snapshots, and exposes `subscribe(listener)` over `RemoteSessionState`.
  - Everything is **transport-agnostic**: the client works over RPC mode
    (`dist/rpc-entry.js`) or in-process. The server side (`apps/server`) spawns `pi`
    (the binary/CLI) as a child process.
- pi's own TUI is built on **Ink** (`@earendil-works/pi-tui`) and lives in the same package
  (`dist/modes/interactive/`). Reusing it means zero reimplementation of the agent UI.

---

## 1. Architectural decisions (Step 1)

| Decision          | Choice                                                                                  | Why                                                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Project structure | Feature-first, keep existing t3code layout                                              | Fork already clean: `apps/desktop`, `apps/server`, `packages/contracts`, `packages/client-runtime`, `packages/web`. Trim, don't restructure. |
| Desktop shell     | **Electron** (keep t3code's)                                                            | Already shipping. Matches opencode. Drop WSL/SSH/Clerk special cases for v1.                                                                 |
| Server            | **Node + Effect** (`apps/server`)                                                       | Keep t3code server, replace provider/orchestration boundary with a pi child-process driver.                                                  |
| Transport         | **Keep Effect WS-RPC** (`WsRpcGroup`)                                                   | Already wired end-to-end (server ↔ client-runtime ↔ renderer). Less work than opencode's HTTP/SSE swap.                                      |
| TUI↔app bridge    | **opencode-style queue bridge** (add `/tui/*` WS-RPC methods + in-process pi TUI)       | TUI stays source of truth; desktop drives it via `appendPrompt`/`submitPrompt`/`publish` + subscribe transcript.                             |
| Agent engine      | **pi as child process** (like opencode's sidecar, but per-session or single long-lived) | Reuses full pi harness (tools, skills, models, sessions) with zero reimplementation.                                                         |
| Auth              | **Local only, bearer token generated at spawn** (drop Clerk/cloud)                      | Desktop spawns server with a random token; no accounts.                                                                                      |
| Mobile/cloud      | **Delete**                                                                              | `apps/mobile`, EAS workflows, relay infra, tailscale/ssh packages, marketing.                                                                |
| Real-time         | WS-RPC streams (existing `subscribeThread`/`subscribeTerminalEvents`)                   | Already built.                                                                                                                               |

---

## 2. Target layout

```
apps/desktop        Electron shell (trimmed: no WSL/SSH/Clerk; keep window, menu, updater, backend pool)
apps/server         pi-harness server (Effect): spawns pi, exposes WS-RPC; keep ws/http/config/bootstrap
apps/web            React SPA (trim: connection-catalog/onboarding → single local server; keep chat/thread/review/terminal UI)
packages/contracts  WS-RPC schemas (trim to pi surface; add /tui bridge methods)
packages/client-runtime  WS-RPC client + state (keep connection layer, point at pi server)
packages/shared     shared helpers (keep)
apps/mobile         DELETE
infra/relay         DELETE
packages/tailscale, packages/ssh  DELETE (or keep ssh for v2)
native/resource-monitor, libghostty-vt  keep only if used by desktop terminal; else vendor
```

---

## 3. Implementation phases

### Phase 1 — Trim & baseline (no pi yet)

**Done in this commit (desktop-only fork baseline):**

1. Deleted `apps/mobile`, `apps/marketing`, `infra/relay`, `experiments`, `.repos`,
   mobile/relay GitHub workflows, and orphaned mobile/relay/repos scripts
   (`mobile-showcase*`, `mobile-native-static-check*`, `sync-reference-repos*`,
   `announce-connect-ga*`, `scripts/lib/reference-repos.ts`).
2. Pruned `package.json` scripts (marketing/mobile/relay/sync), `ci.yml` mobile job,
   `pnpm-workspace.yaml` unused RN/Expo patchedDependencies + their patch files,
   `release-smoke.ts` workspace manifest list.
3. Kept the backend pool + readiness + restart machinery (`DesktopBackendManager`,
   `DesktopBackendPool`) — that's the opencode-style sidecar lifecycle we want.
4. `pnpm install && pnpm typecheck` green (0 errors; only effect style suggestions).
   Tests: 315 pass; 5 pre-existing environment-dependent failures in
   `relayClient.test.ts` (cloudflared not installed) and `logging.test.ts`
   (Windows missing-log-file edge) — relay/cloud layer, Phase-2 target.

**Deferred to Phase 2 (with the pi server swap):** Clerk auth (desktop single-instance
bridge, web cloud components), `@t3tools/ssh`, `@t3tools/tailscale`, server
cloud/relay/connect code, `release.yml` relay/Clerk deploy pipeline. These are
interwoven with the desktop shell + server orchestration; removing them now would
break the build, so they go with the provider-boundary refactor.

### Phase 2 — pi driver (replace provider/orchestration boundary)

1. New package `packages/pi-driver` (or `apps/server/src/pi/*`):
   - `PiProcess.ts` — spawn `pi` (resolved binary; dev = `node dist/cli.js`, prod = packaged
     binary), env passthrough, stdout/stderr capture, readiness via health/`rpc-entry`.
   - `PiSessionManager.ts` — map t3code `ThreadId` ↔ pi session (cwd, model, thinking level);
     start via `RemoteSession.create(client, {cwd, model, thinkingLevel})`, open existing via
     `RemoteSession.open(client, id)`.
   - `PiTranscriptAdapter.ts` — `RemoteSessionState`/`session_progress` →
     t3code thread/turn/message shapes so the existing React chat UI renders unchanged.
   - `PiProviderRegistry.ts` — bridge existing provider UI (model picker) to pi
     `setModel`/`setThinking`; keep the sandbox/approval policy layer, delegating to pi
     permission modes.
2. Wire the driver into `ws.ts`: `orchestration.dispatchCommand` etc. now route to
   pi sessions; `subscribeThread` streams transcript snapshots from `RemoteSession.subscribe`.
3. Keep terminal/checkpointing/vcs/review as-is where pi doesn't own that surface
   (or defer review/vcs to v2 and stub).

### Phase 3 — Embed the pi TUI (opencode-style bridge)

1. New `apps/server/src/tui/*`:
   - `PiTuiHost.ts` — instantiate pi's Ink TUI in-process
     (`@earendil-works/pi-tui` interactive mode) with a virtual input/output stream instead
     of the real terminal.
   - `PiTuiBridge.ts` — global async queues exactly like opencode's
     `tui-control.ts`: `nextTuiRequest/nextTuiResponse`, plus a publish bus for TUI events
     (prompt appended, command executed, session selected, toast shown).
2. Add WS-RPC methods to `packages/contracts` (`TUI_WS_METHODS`):
   `tui.appendPrompt`, `tui.submitPrompt`, `tui.clearPrompt`, `tui.executeCommand`,
   `tui.selectSession`, `tui.publish`, `tui.control.next`, `tui.control.response`.
3. Renderer: new "TUI mode" view = a virtual terminal (`xterm.js` or the existing
   ghostty-vt renderer) fed by the bridge stream; keep "native mode" = current React chat
   UI reading the same transcript stream. Both drive the same pi instance.

### Phase 4 — Desktop shell cleanup & branding

1. Rename app/product: `Pi Tie`, window title, icons (`assets/prod`), `productName`,
   `APP_IDS`, auto-update endpoint.
2. Settings: replace Clerk/cloud settings with local `electron-store` (theme, keybindings,
   model defaults, permission mode). Reuse `DesktopClientSettings` skeleton.
3. Packaging: `electron-builder` targets — win nsis, mac dmg/zip, linux AppImage/deb.
   Bundle the pi binary as a sidecar (extraResources) + a minimal embedded node if needed.
4. Auto-update: point updater at a pi-tie releases feed (GitHub Releases) or disable for v1.

### Phase 5 — Verify (Step 4 gates)

1. `pnpm typecheck` (all packages) + `pnpm test` green.
2. `pnpm --filter @t3tools/server build` → `node dist/bin.mjs start` → health endpoint
   returns ok; `pnpm --filter @t3tools/desktop smoke-test` boots Electron.
3. Integration: launch desktop → renderer connects via WS-RPC → `RemoteSession.create`
   in `apps/server` spawns `pi` → send a prompt → transcript streams into chat UI;
   TUI mode shows the same transcript through the bridge.
4. Real-time: two windows / TUI-mode + native-mode both live-update on one session.
5. Cross-platform smoke: Windows (this machine), then mac/Linux CI (GitHub Actions).

---

## 4. Risks & mitigations

| Risk                                                                             | Mitigation                                                                                                                  |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| pi SDK surface is large; transcript shapes differ                                | Phase 2 adapter isolates mapping; keep a fixture of real `RemoteSessionState` snapshots from a live pi run                  |
| Running pi TUI in-process may fight the WS-RPC server's own EventLoop            | Same-process queue bridge like opencode; if contending, fork pi TUI into the same child as the driver and bridge over stdio |
| t3code's orchestration expects provider approval/checkpointing pi doesn't expose | Map to pi permission modes; stub/defer checkpoint/review to v2                                                              |
| Electron + heavy Effect server + pi = large bundle                               | Bundle server+pi as single sidecar binary (`bun build --compile` or `tsgo` + packaged pi); keep renderer thin               |
| Upstream t3code moves fast (Effect betas)                                        | Stay on forked versions; pnpm catalog pins                                                                                  |

---

## 5. Deliverables / exit criteria

- Fork `itzolbro/t3code` with mobile/cloud removed, desktop-only.
- `apps/server` spawns and drives pi (create/open/submit/abort/model/thinking/transcript).
- Electron desktop renders either the React chat UI or the embedded pi TUI, both on the
  same live session; TUI bridge mirrors opencode's queue pattern.
- Local-only auth (spawn-time bearer token). Windows/macOS/Linux builds via electron-builder.
- `pnpm typecheck`, `pnpm test`, server smoke, desktop smoke, and the 2-window real-time
  check all pass.

## 6. Open questions for the owner

1. Drive pi **per-session child process** (isolated, heavier) vs **one long-lived pi**
   process hosting all sessions (matches opencode's sidecar)? Default: one long-lived
   process + `RemoteSession` per thread, like opencode's single sidecar.
2. Keep the existing React chat UI as the primary desktop view, or make the embedded pi
   TUI primary? Plan supports both; pick after Phase 3 spike.
3. VCS/review/terminal (t3code's rich extras) — keep for v1 or defer to v2?
   Default: keep terminal + file tree; defer review/VCS.
4. Auto-update: GitHub Releases feed or none for v1?

## 7. References

- t3code: `apps/server/src/ws.ts`, `apps/desktop/src/backend/DesktopBackendManager.ts`,
  `packages/contracts/src/rpc.ts`, `packages/client-runtime/src/rpc/session.ts`
- opencode (reference pattern): `packages/opencode/src/server/shared/tui-control.ts`,
  `packages/opencode/src/server/routes/instance/httpapi/groups/tui.ts`,
  `packages/desktop/src/main/server.ts` (utilityProcess sidecar)
- pi SDK: `@earendil-works/pi-coding-agent/dist/client/remote-session.js` (v0.84.1)
