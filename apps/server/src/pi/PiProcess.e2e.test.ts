import { describe, expect, it } from "@effect/vitest";
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as PiProcess from "./PiProcess.ts";

describe("PiProcess (real child)", () => {
  it.effect(
    "spawns the pi RPC child and answers get_state",
    () =>
      Effect.gen(function* () {
        const process = yield* PiProcess.PiProcess;
        const response = yield* process
          .request<{ success?: boolean; data?: { sessionFile?: string } }>({
            id: "t3-e2e",
            type: "get_state",
          })
          .pipe(Effect.timeout(Duration.minutes(3)));
        expect(response.success).toBe(true);
        expect(response.data?.sessionFile).toBeDefined();
      }).pipe(
        Effect.provide(PiProcess.layer.pipe(Layer.provide(NodeServices.layer))),
        Effect.scoped,
      ),
    { timeout: 200_000 },
  );
});
