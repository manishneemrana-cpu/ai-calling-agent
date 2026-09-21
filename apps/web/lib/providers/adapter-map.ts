/**
 * The self-registration map behind the Provider Registry's factory. See
 * docs/PROVIDER_REGISTRY.md for the full explanation of why this exists
 * instead of a dynamic `import()` of `providers.adapter_class_identifier`
 * (Next.js/webpack cannot resolve an arbitrary runtime string to a module).
 *
 * Each adapter module calls `registerAdapter(identifier, factoryFn)` at
 * import time (see adapters/mock.ts, adapters/plivo.ts, adapters/frejun-teler.ts).
 * apps/web/lib/providers/registry.ts imports every adapter module once (for
 * side effects, so they register themselves) and then looks up
 * `providers.adapter_class_identifier` in this map — it never contains an
 * if/else or switch on a provider name itself.
 *
 * This map is intentionally layer-agnostic: identifiers are namespaced
 * strings like "telephony.plivo" chosen by convention, not a typed enum, so
 * Phase 3's stt./tts./llm. adapters register into the exact same map with
 * zero changes here.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdapterFactory = (config: Record<string, unknown>) => any;

const registry = new Map<string, AdapterFactory>();

export function registerAdapter(identifier: string, factory: AdapterFactory): void {
  if (registry.has(identifier)) {
    // Re-registration happens harmlessly under Next.js dev hot-reload /
    // repeated test imports of the same module; last write wins.
    registry.set(identifier, factory);
    return;
  }
  registry.set(identifier, factory);
}

export function resolveAdapterFactory(identifier: string): AdapterFactory | undefined {
  return registry.get(identifier);
}

export function listRegisteredAdapterIdentifiers(): string[] {
  return Array.from(registry.keys());
}

/** Test-only escape hatch to remove a fake adapter registered by a test. */
export function _unregisterAdapterForTests(identifier: string): void {
  registry.delete(identifier);
}
