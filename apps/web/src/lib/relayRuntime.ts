import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { RelayWebClientId } from "@t3tools/contracts/relay";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

// Browser implementation of the Effect crypto service. The client-runtime
// connection layer requires it statically, so it must be provided even though
// this local-only harness never performs cloud auth.
export const browserCryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.promise(async () => {
        const input = new Uint8Array(data.length);
        input.set(data);
        return new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, input.buffer));
      }),
  }),
);

// The relay DPoP signer is required statically by the client-runtime managed
// relay layer, but the harness is local-only: with an empty relay URL the
// client is built in its disabled form and never calls the signer.
const relaySigningUnavailable = new Error(
  "Relay DPoP signing is unavailable in the local-only harness.",
);

export const relayDpopSignerLayer = Layer.succeed(
  ManagedRelay.ManagedRelayDpopSigner,
  ManagedRelay.ManagedRelayDpopSigner.of({
    thumbprint: Effect.fail(
      new ManagedRelay.ManagedRelayDpopKeyLoadError({
        keyStore: "indexed-db",
        cause: relaySigningUnavailable,
      }),
    ),
    createProof: Effect.fn("web.relayDpopSigner.createProof")(function* (input) {
      return yield* new ManagedRelay.ManagedRelayDpopProofCreationError({
        method: input.method,
        url: input.url,
        cause: relaySigningUnavailable,
      });
    }),
  }),
);

export const managedRelayClientLayer = (relayUrl: string) =>
  ManagedRelay.layer({ relayUrl, clientId: RelayWebClientId }).pipe(
    Layer.provideMerge(relayDpopSignerLayer),
  );
