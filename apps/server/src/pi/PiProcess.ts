// @effect-diagnostics preferSchemaOverJson:off
// @effect-diagnostics nodeBuiltinImport:off
import * as Context from "effect/Context";
import * as NodeURL from "node:url";
import * as NodePath from "node:path";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

export interface PiRpcRequest {
  readonly id: string;
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface PiRpcResponse {
  readonly id?: string;
  readonly type: string;
  readonly success?: boolean;
  readonly data?: unknown;
  readonly error?: unknown;
  readonly [key: string]: unknown;
}

export interface PiProcessShape {
  readonly request: <T>(request: PiRpcRequest) => Effect.Effect<T, PiProcessError>;
  readonly events: Stream.Stream<PiRpcResponse, PiProcessError>;
}

export class PiProcessError extends Schema.TaggedErrorClass<PiProcessError>()("PiProcessError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Pi process ${this.operation} failed: ${this.detail}`;
  }
}

export class PiProcess extends Context.Service<PiProcess, PiProcessShape>()("t3/pi/PiProcess") {}

const nextRequestId = (() => {
  let sequence = 0;
  return () => `t3-${sequence++}`;
})();

const parseLine = (line: string): PiRpcResponse | undefined => {
  if (line.trim().length === 0) return undefined;
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null || !("type" in value)) return undefined;
    return value as PiRpcResponse;
  } catch {
    return undefined;
  }
};

const READINESS_ATTEMPTS = 12;
const READINESS_DELAY = "5 seconds";

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const configuredBinary = process.env.PI_BINARY;
  const binary = configuredBinary ?? process.execPath;
  const args = configuredBinary
    ? ["--mode", "rpc"]
    : [
        NodePath.join(
          NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
          "../../node_modules/@earendil-works/pi-coding-agent/dist/rpc-entry.js",
        ),
      ];
  const command = yield* resolveSpawnCommand(binary, args, { env: process.env });
  const child = yield* spawner.spawn(
    ChildProcess.make(command.command, command.args, {
      shell: command.shell,
      extendEnv: true,
    }),
  );
  const requests = yield* Queue.unbounded<readonly [string, string]>();
  const responses = yield* Ref.make(
    new Map<string, Deferred.Deferred<PiRpcResponse, PiProcessError>>(),
  );
  const events = yield* Queue.unbounded<PiRpcResponse>();
  const outputBuffer = yield* Ref.make("");

  // The pi CLI drops stdin writes that arrive before its JSONL reader is
  // attached (extension loading takes ~10s on Windows). A request that gets
  // dropped never produces a response, so each `request` call retries by
  // re-queuing the same payload until either a response or a terminal state
  // (child exit / shutdown) settles it.
  const pendingAttempts = yield* Ref.make(new Map<string, number>());

  const failPending = (cause: PiProcessError) =>
    Ref.get(responses).pipe(
      Effect.flatMap((pending) =>
        Effect.forEach(
          [...pending.entries()],
          ([, deferred]) => Deferred.fail(deferred, cause).pipe(Effect.ignore),
          { discard: true },
        ),
      ),
      Effect.andThen(Ref.set(responses, new Map())),
    );

  const writeRequests = Stream.fromQueue(requests).pipe(
    Stream.mapEffect(([line]) =>
      Stream.run(Stream.encodeText(Stream.make(line)), child.stdin).pipe(
        Effect.mapError(
          (cause) =>
            new PiProcessError({
              operation: "write",
              detail: "Could not write to pi stdin",
              cause,
            }),
        ),
      ),
    ),
    Stream.runDrain,
    Effect.forkScoped,
  );

  const readOutput = child.stdout.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      Ref.modify(outputBuffer, (buffer) => {
        const lines = (buffer + chunk).split("\n");
        return [lines.slice(0, -1), lines.at(-1) ?? ""] as const;
      }).pipe(
        Effect.flatMap((lines) =>
          Effect.forEach(lines, (line) => {
            const message = parseLine(line.replace(/\r$/, ""));
            if (!message) return Effect.void;
            if (message.id) {
              return Ref.get(responses).pipe(
                Effect.flatMap((pending) => {
                  const deferred = pending.get(message.id!);
                  if (!deferred) return Effect.void;
                  return Deferred.succeed(deferred, message).pipe(
                    Effect.andThen(
                      Ref.update(responses, (current) => {
                        const next = new Map(current);
                        next.delete(message.id!);
                        return next;
                      }),
                    ),
                    Effect.andThen(
                      Ref.update(pendingAttempts, (current) => {
                        const next = new Map(current);
                        next.delete(message.id!);
                        return next;
                      }),
                    ),
                  );
                }),
              );
            }
            return Queue.offer(events, message);
          }),
        ),
      ),
    ),
    Effect.forkScoped,
  );

  // If the child exits, fail every in-flight request so callers observe the
  // process failure instead of hanging forever.
  const watchExit = child.exitCode.pipe(
    Effect.flatMap((code) =>
      failPending(
        new PiProcessError({
          operation: "exit",
          detail: `pi exited with code ${code}`,
        }),
      ),
    ),
    Effect.forkScoped,
  );

  yield* Effect.all([writeRequests, readOutput, watchExit], { discard: true });

  const request = <T>(input: PiRpcRequest): Effect.Effect<T, PiProcessError> =>
    Effect.gen(function* () {
      const deferred = yield* Deferred.make<PiRpcResponse, PiProcessError>();
      yield* Ref.update(responses, (current) => new Map(current).set(input.id, deferred));

      // Re-queue until answered. Early writes (before pi's reader is
      // attached) are silently dropped; the retry loop keeps the payload in
      // flight until the child either answers or terminates.
      const attempts = yield* Ref.get(pendingAttempts);
      yield* Ref.update(pendingAttempts, (current) =>
        new Map(current).set(input.id, (attempts.get(input.id) ?? 0) + 1),
      );
      yield* Queue.offer(requests, [JSON.stringify(input) + "\n", input.id]);

      for (let attempt = 1; attempt <= READINESS_ATTEMPTS; attempt += 1) {
        const settled = yield* Effect.race(
          Deferred.await(deferred).pipe(Effect.as(true)),
          Effect.sleep(Duration.toMillis(READINESS_DELAY)).pipe(Effect.as(false)),
        );
        if (settled) break;
        yield* Ref.update(pendingAttempts, (current) => {
          const next = new Map(current);
          next.set(input.id, (current.get(input.id) ?? 0) + 1);
          return next;
        });
        yield* Queue.offer(requests, [JSON.stringify(input) + "\n", input.id]);
      }

      const response = yield* Deferred.await(deferred);
      return response as T;
    }).pipe(
      Effect.mapError((cause) =>
        Schema.is(PiProcessError)(cause)
          ? cause
          : new PiProcessError({
              operation: "request",
              detail: `Pi request '${input.type}' failed`,
              cause,
            }),
      ),
    );

  return {
    request,
    events: Stream.fromQueue(events),
  } satisfies PiProcessShape;
});

export const layer = Layer.effect(PiProcess, make);
