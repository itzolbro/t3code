# T3 Connect — REMOVED

> **Historical.** This document is retained only as an upstream reference.

T3 Connect (Clerk authentication, the relay broker, the `t3 connect` CLI group,
desktop passkeys, and the hosted `app.t3.codes` flow) was removed from the Pi
Tie fork during the Phase 2a cloud-stack removal:

- Clerk auth: removed from desktop, web, and release packaging.
- Relay / T3 Connect broker: `infra/relay`, `packages/shared/relayClient.ts`,
  `packages/contracts/relayClient.ts`, server relay/connect code, and web
  relay/connect UI were deleted.
- `t3 connect` CLI group: deleted with `apps/server/src/cli/connect.ts`.
- The hosted web app (`app.t3.codes`) deploy job was removed from
  `.github/workflows/release.yml`.

None of the setup steps in the original document apply to this fork.
