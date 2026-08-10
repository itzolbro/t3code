/**
 * BUILT_IN_DRIVERS — the static set of `ProviderDriver`s this build ships
 * with.
 *
 * Pi Tie is a pi-only harness: the only provider is pi. Every driver that
 * the server knows how to instantiate from settings is listed here; the
 * `ProviderInstanceRegistry` iterates this array when resolving
 * `providerInstances` entries, and anything not in the array surfaces as an
 * `"unavailable"` shadow snapshot at runtime (see
 * `buildUnavailableProviderSnapshot`).
 *
 * Legacy t3code drivers (Codex, Claude, Cursor, Grok, OpenCode) are not
 * registered — their source remains under `Drivers/` only as reference.
 *
 * @module provider/builtInDrivers
 */
import { PiDriver, type PiDriverEnv } from "./Drivers/PiDriver.ts";
import type { AnyProviderDriver } from "./ProviderDriver.ts";

/**
 * Union of infrastructure services required to construct any built-in
 * driver. The registry layer declares `R = BuiltInDriversEnv`; the runtime
 * layer must provide every service in this union.
 */
export type BuiltInDriversEnv = PiDriverEnv;

/**
 * Ordered list of built-in drivers. Order matters only for tie-breaking in
 * UI presentation — the registry itself is keyed by `driverKind`, so
 * iteration order has no functional effect on instance lookup.
 */
export const BUILT_IN_DRIVERS: ReadonlyArray<AnyProviderDriver<BuiltInDriversEnv>> = [PiDriver];
