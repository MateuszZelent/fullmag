"use client";

import {
  createElement,
  lazy,
  Suspense,
  useCallback,
  useState,
  type ComponentType,
} from "react";

import { useKernel } from "../KernelContext";
import type { ModuleConfig, ModuleManifest, ModuleProps, SlotId } from "../types";

interface SlotHostProps {
  slotId: SlotId;
  /** Explicit manifest override — if null, auto-discover from kernel registry. */
  moduleManifest?: ModuleManifest | null;
}

/**
 * Module-level cache for lazy-wrapped components.
 * Keyed by manifest.id so each module is wrapped exactly once.
 */
const lazyCache = new Map<string, ComponentType<ModuleProps>>();

function ensureLazyCached(manifest: ModuleManifest): void {
  if (!lazyCache.has(manifest.id)) {
    lazyCache.set(
      manifest.id,
      lazy(
        manifest.component as () => Promise<{ default: ComponentType<ModuleProps> }>,
      ),
    );
  }
}

/**
 * Renders a resolved module using createElement to avoid
 * react-hooks/static-components lint violations with dynamic component types.
 */
export function MountedModule({
  manifest,
  kernel,
  slotId,
}: {
  manifest: ModuleManifest;
  kernel: ReturnType<typeof useKernel>;
  slotId: SlotId;
}) {
  ensureLazyCached(manifest);
  const [config, setConfigState] = useState<ModuleConfig>({});
  const setConfig = useCallback(
    (patch: Partial<ModuleConfig>) =>
      setConfigState((prev) => ({ ...prev, ...patch })),
    [],
  );

  return (
    <Suspense fallback={<div className="fm-slot__loading">Loading…</div>}>
      {createElement(lazyCache.get(manifest.id)!, {
        config,
        kernel,
        moduleId: manifest.id,
        setConfig,
        slotId,
      })}
    </Suspense>
  );
}

/**
 * SlotHost mounts a module into a named layout slot.
 *
 * Resolution order:
 * 1. Explicit `moduleManifest` prop (for testing / overrides)
 * 2. First module registered for this slotId in the kernel ModuleRegistry
 * 3. Empty placeholder
 */
export function SlotHost({ slotId, moduleManifest }: SlotHostProps) {
  const kernel = useKernel();

  let manifest: ModuleManifest | null = null;
  if (moduleManifest !== undefined) {
    manifest = moduleManifest;
  } else {
    const registered = kernel.modules.forSlot(slotId);
    manifest = registered[0] ?? null;
  }

  if (!manifest) {
    return (
      <section className="fm-slot" data-slot-id={slotId}>
        <div className="fm-slot__empty">No module mounted</div>
      </section>
    );
  }

  return (
    <section className="fm-slot" data-slot-id={slotId}>
      <MountedModule kernel={kernel} manifest={manifest} slotId={slotId} />
    </section>
  );
}
