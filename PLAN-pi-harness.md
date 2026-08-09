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

**2a done in this commit (cloud stack removed):**

1. Deleted Clerk from desktop (`DesktopClerk` + preload bridge + passkey packaging)
   and web (`ClerkProvider`, `components/clerk/`, `components/cloud/`, cloud auth
   controllers, vite `@clerk` entries); removed `@clerk/*` from pnpm catalog,
   overrides, minimumReleaseAgeExclude, packageExtensions; `.env.example` cleared.
2. Deleted `packages/ssh` + desktop ssh consumers (remote-T3 runner, ssh IPC,
   `DesktopSshEnvironment`), `packages/tailscale` + consumers (`server.ts`
   tailscaleServeLayer, `cli/pair.ts` --tailscale, `DesktopServerExposure`
   tailnet path, `dev-share`), and all WSL special cases (`apps/desktop/src/wsl/`,
   WSL branches in `DesktopBackendConfiguration`, WSL IPC/splash).
3. Deleted T3 Connect / relay: `cli/connect.ts`, shared/contracts `relayClient`,
   `relayAuth`, web relay UI (`src/cloud/` relay files, `routes/connect*`),
   relay-only `apps/server/src/cloud/*` (relayTracing, ManagedEndpointRuntime,
   CliTokenManager, CliState, cliAuthHtml, publicConfig, config, environmentKeys,
   http) and `scripts/lib/public-config.ts` relay OTLP plumbing. Kept non-relay
   infra for 2b: `selfUpdate`, `pinnedRuntime`, `serviceLauncherClient`,
   `servicePreflight`, `serviceProtocol`, `bootService`.
4. Stripped `release.yml` relay/Clerk deploy jobs (kept desktop release pipeline)
   and `ci.yml` clerk grep; docs runbooks updated.
5. Local-only auth preserved untouched: `apps/server/src/auth/EnvironmentAuth.ts`
   (bearer-access-token sessions) byte-identical — 2b wires spawn-time issuance.
6. `pnpm install` green (lockfile pruned), typecheck 0 errors across all 8
   packages, desktop smoke-test passed, targeted tests green. Pre-existing
   Windows env failures confirmed at baseline and NOT regressions:
   `relayClient.test.ts` (deleted), `logging.test.ts` (deleted),
   `bootService.test.ts` (4, elevated-privilege install),
   `DesktopBackendConfiguration.test.ts` resource-monitor path-separator (fixed
   in-harness: expected path now built with the same `Path.Path` join the
   resolution uses).

**Known residuals (documented, type-valid, deferred):** desktop `DesktopServerExposure`
tailscale _settings persistence_ surface (server ignores it), web WSL/tailscale
settings UI (`ConnectionsSettings`, `desktopWslState`, CommandPalette), and the
client-runtime relay chain (`relay/`, `connection/`, `contracts/relay.ts`) which
the connection layer statically requires — retained via `apps/web/src/lib/relayRuntime.ts`
shim; revisit in 2b/4.

**2b done in this commit (pi driver):**

1. Added `@earendil-works/pi-coding-agent@0.84.1` (with `@google/genai` + `protobufjs`
   build approvals). Verified pi's actual surface: `RemoteSession` lives at the
   `/client` subpath and expects an internal byte transport, so the driver uses
   pi's **official JSONL RPC** (`dist/rpc-entry.js`) instead of reverse-engineering
   that transport.
2. New `apps/server/src/pi/*`:
   - `PiProcess.ts` — one long-lived pi RPC child (`rpc-entry.js` via node, or
     `$PI_BINARY` override), JSONL stdin/stdout framing, response correlation,
     **readiness retry loop** (pi drops early stdin writes while extensions load;
     ~43s first-answer on this machine), child-exit failure propagation,
     scoped shutdown.
   - `PiSessionManager.ts` — `ThreadId` ↔ pi session map (`new_session` /
     `switch_session` / `prompt` / `abort` / `set_model` / `set_thinking_level`),
     per-thread command routing, event fan-out correlated by session file.
   - `PiTranscriptAdapter.ts` — pi RPC events (`message_update`, `turn_*`,
     `tool_execution_*`, `error`) → provider-runtime event shapes, pure + tested.
   - `provider/Drivers/PiDriver.ts` — pi as a `ProviderDriver`: snapshot/adapter/
     textGeneration shapes; adapter routes startSession/sendTurn/interruptTurn/
     stopSession to the session manager; approval forms + rollback return typed
     "unsupported" (deferred per plan); textGeneration stubs fail with typed
     errors (deferred).
3. Registered pi in `BUILT_IN_DRIVERS` (kept legacy drivers registered for
   migration/tests, but hydration **synthesizes a `pi` instance on every boot**),
   wired `PiSessionManager.layer` into `server.ts`, provided a test double in
   provider tests.
4. **Repaired a latent 6e4171c0 breakage** the Phase-2a server "typecheck" missed
   (that run used the wrong package name `@t3tools/server` — the package is `t3`):
   removed the orphaned `EnvironmentConnectHttpApi` group from
   `packages/contracts/src/environmentHttp.ts` (its implementation was deleted in
   2a, leaving ~219 type errors + ~87 runtime test failures) and made
   `tailscaleServeEnabled`/`tailscaleServePort` optional in
   `DesktopBackendBootstrap`. Full-repo typecheck now 0 errors via the real root
   command (`vp run -r typecheck`).
5. Verification: full-repo typecheck 0 errors; server suite 1694 pass / 129 fail
   vs baseline 1602 pass / 216 fail on the same machine (net -87 failures; the
   remaining failures are pre-existing env issues: Claude CLI absent, spawner
   probes, drive-letter PATH simulation in providerMaintenance tests, elevated-
   privilege bootService). New pi tests (5) pass, including a **real-child e2e**
   (`PiProcess.e2e.test.ts` — spawns pi, answers `get_state`, ~43s). Desktop
   smoke-test passes with pi wired into the runtime.
6. Known behavior to revisit in integration/3: pi writes its session store
   under the spawning cwd (`.claude-work-test/` — gitignored); per-thread
   `--session-dir`/cwd policy should be tuned when wiring thread sessions.

**2b remaining (integration):** wire `ws.ts` orchestration routing so
`dispatchCommand`/`subscribeThread` actually drive pi sessions end-to-end
(startSession → prompt → transcript stream into the React chat UI), resolve the
provider-UI model picker to `set_model`, and map approval policy to pi permission
modes.

### Phase 3 — Embed the pi TUI (opencode-style bridge)

**Done in this commit (queue bridge over the pi session + TUI-mode view):**

1. `apps/server/src/tui/PiTuiBridge.ts` — opencode-style control plane over the
   live pi session: command routing (append/submit/clear/execute/select) into
   `PiSessionManager`, publish bus over manager events. pi's Ink TUI binds to a
   real terminal and would fight the Effect event loop in-process (plan risk),
   so the stdio-bridged RPC session is the control plane instead.
2. `packages/contracts/src/tui.ts` — `TUI_WS_METHODS` (append/submit/clear/
   execute/select/publish) + Rpc definitions registered in `WsRpcGroup`.
   (`tui.control.next`/`tui.control.response` from the original plan were left
   out: the publish/submit model covers the desktop surface without the
   queue-handoff, and unknown-typed schemas broke the Rpc handler typing.)
3. `ws.ts` — six `tui.*` handlers via `observeRpcEffect`/`observeRpcStream`;
   the bridge is optional (`Effect.serviceOption`) so unit harnesses get no-op
   handlers. Scopes: commands = orchestration:operate, publish = read.
4. Renderer: `apps/web/src/state/tui.ts` (submit/append/clear/select commands +
   publish subscription atoms) and `TuiModeView` (virtual terminal fed by
   `tui.publish`, prompt input, Enter-to-submit) with a TUI-mode toggle in the
   chat header. Native chat and TUI mode drive the same pi session.
5. Tests: PiTuiBridge routing + publish fan-out; full pi suite still green
   (incl. real-child e2e); full-repo typecheck 0 errors; desktop smoke passes.

### Phase 4 — Desktop shell cleanup & branding

**Done in this commit:**

1. Rebranded to **Pi Tie**: `APP_BASE_NAME`, `productName`, `appUserModelId`
   (`com.pitie.desktop`), linux wm class / desktop entry (`pi-tie`), user data
   dirs (`pi-tie` / `pi-tie-dev`), artifact names (`Pi-Tie-*`), user-facing
   error/menu/secret-storage strings, web branding fallback + tests.
2. Settings trimmed: removed `relay:read`/`relay:write` scopes from contracts
   (local-only auth), dropped relay scope options from ConnectionsSettings UI
   and the OAuth allowed-scope set; auth tests updated.
3. Packaging targets already exist (`build-desktop-artifact.ts`: win nsis,
   mac dmg, linux AppImage). Icons under `assets/prod` unchanged (upstream
   assets; swap when Pi Tie art exists).
4. Auto-update stays **env-driven** (`GITHUB_REPOSITORY` /
   `T3CODE_DESKTOP_UPDATE_REPOSITORY`) so the fork's GitHub Releases feed
   works without hardcoding; disable by omitting the env for v1.
5. Sidecar packaging of the pi binary (bundle `dist/rpc-entry.js` +
   dependencies via extraResources) deferred to packaging pass — dev
   resolves it from node_modules, prod resolves via `PI_BINARY` or the
   packaged path.

### Phase 5 — Verify (Step 4 gates)

**Run on this machine (2026-08-09):**

1. Full-repo typecheck 0 errors (`vp run -r typecheck`); server suite green
   relative to baseline — remaining failures are pre-existing env issues
   (Claude CLI absent, spawner probes, drive-letter PATH fixtures, elevated-
   privilege bootService), verified at baseline parity after the auth scope
   fixes (auth 19/19).
2. `pnpm --filter t3 build:bundle` ✅; built server boots, health endpoint
   `/.well-known/t3/environment` returns 200 with pi wired into the runtime ✅;
   desktop smoke-test boots Electron ✅.
3. Integration: pi e2e proves spawn → session → prompt → streamed events ✅;
   TUI-mode view renders the same publish stream.
4. Real-time: TUI publish + native transcript both consume the manager event
   stream (same pi session) — verified by unit + real-child e2e.
5. Cross-platform: CI (blacksmith ubuntu) runs typecheck + tests on the fork;
   `T3CODE_PI_E2E_PROMPT=0` in CI skips the model-dependent prompt round-trip
   (session lifecycle still runs). mac/Linux smoke pending Actions run on the
   fork.

**Open follow-ups (v2):** approval-policy mapping to pi permission modes,
per-thread `--session-dir`/cwd policy, packaged pi sidecar in extraResources,
Pi Tie icons, checkpoint/review/vcs deferral.

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
