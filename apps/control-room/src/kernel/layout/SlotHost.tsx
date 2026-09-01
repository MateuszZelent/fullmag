"use client";

import {
  Component,
  createElement,
  lazy,
  Suspense,
  useCallback,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";

import { useKernel } from "../KernelContext";
import { useLayoutSelector } from "./useLayout";
import type { ModuleConfig, ModuleManifest, ModuleProps, SlotId } from "../types";

interface SlotHostProps {
  slotId: SlotId;
  /** Explicit manifest override — if null, auto-discover from kernel registry. */
  moduleManifest?: ModuleManifest | null;
}

export function resolveSlotModuleManifest(
  registered: readonly ModuleManifest[],
  activeModuleTab: string,
): ModuleManifest | null {
  return registered.find((candidate) => candidate.activationTab === activeModuleTab) ??
    registered[0] ??
    null;
}

/**
 * Module-level cache for lazy-wrapped components.
 * Keyed by manifest.id so each module is wrapped exactly once.
 */
const lazyCache = new Map<string, ComponentType<ModuleProps>>();

interface ModuleErrorBoundaryProps {
  children: ReactNode;
  manifest: ModuleManifest;
}

interface ModuleErrorBoundaryState {
  error: Error | null;
  retryKey: number;
}

class ModuleErrorBoundary extends Component<
  ModuleErrorBoundaryProps,
  ModuleErrorBoundaryState
> {
  state: ModuleErrorBoundaryState = {
    error: null,
    retryKey: 0,
  };

  static getDerivedStateFromError(
    error: Error,
  ): Partial<ModuleErrorBoundaryState> {
    return { error };
  }

  private retry = () => {
    this.setState(({ retryKey }) => ({
      error: null,
      retryKey: retryKey + 1,
    }));
  };

  render() {
    if (this.state.error) {
      return (
        <div className="fm-slot__error" role="alert">
          <strong>{this.props.manifest.title} failed to mount</strong>
          <span>{this.state.error.message}</span>
          <button type="button" onClick={this.retry}>
            Retry
          </button>
        </div>
      );
    }

    return (
      <Suspense
        key={this.state.retryKey}
        fallback={<div className="fm-slot__loading">Loading…</div>}
      >
        {this.props.children}
      </Suspense>
    );
  }
}

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
    <ModuleErrorBoundary
      key={`${slotId}:${manifest.id}`}
      manifest={manifest}
    >
      {createElement(lazyCache.get(manifest.id)!, {
        config,
        kernel,
        moduleId: manifest.id,
        setConfig,
        slotId,
      })}
    </ModuleErrorBoundary>
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
  const activeModuleTab = useLayoutSelector((layout) => layout.activeModuleTab);

  let manifest: ModuleManifest | null = null;
  if (moduleManifest !== undefined) {
    manifest = moduleManifest;
  } else {
    const registered = kernel.modules.forSlot(slotId);
    manifest = resolveSlotModuleManifest(registered, activeModuleTab);
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
