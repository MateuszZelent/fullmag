"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { createLivePhaseUniform, type LivePhaseUniform } from "./livePhaseUniform";
import type { ModeCompositionLayer, ModeCompositionResource } from "./ModeCompositionController";

const TWO_PI = Math.PI * 2;

export interface ModeCompositionPhaseClockSnapshot {
  /**
   * One stable live phase cell per layer. Animation frames update the cell
   * values in place; this snapshot changes only when the layer set changes.
   */
  readonly phaseUniformByLayerId: ReadonlyMap<string, LivePhaseUniform>;
}

const EMPTY_SNAPSHOT: ModeCompositionPhaseClockSnapshot = {
  phaseUniformByLayerId: new Map(),
};

type Listener = () => void;

/**
 * Owns the local display clock for already-loaded mode fields. It never mutates
 * the server composition; a frame is requested only while a modal layer is
 * explicitly animated. React subscribers are notified when the layer set
 * changes; frame subscribers (viewport invalidation) on every phase change.
 */
export class ModeCompositionPhaseClock {
  private animationFrameId: number | null = null;
  private elapsedSeconds = 0;
  private lastFrameTimeMs: number | null = null;
  private readonly frameListeners = new Set<Listener>();
  private readonly listeners = new Set<Listener>();
  private resource: ModeCompositionResource | null = null;
  private snapshot: ModeCompositionPhaseClockSnapshot = EMPTY_SNAPSHOT;

  getSnapshot(): ModeCompositionPhaseClockSnapshot {
    return this.snapshot;
  }

  /** Current phase of one layer (diagnostics and tests). */
  getPhaseRad(layerId: string): number | undefined {
    return this.snapshot.phaseUniformByLayerId.get(layerId)?.value;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Called after every phase change, including animation frames. */
  readonly subscribeFrame = (listener: Listener): (() => void) => {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  };

  setResource(resource: ModeCompositionResource | null | undefined): void {
    this.resource = resource ?? null;
    this.elapsedSeconds = 0;
    this.lastFrameTimeMs = null;
    this.publish();
    this.sync();
  }

  stop(): void {
    this.stopFrame();
  }

  private readonly frame = (timeMs: number): void => {
    this.animationFrameId = null;
    if (!this.hasActiveAnimation()) {
      this.lastFrameTimeMs = null;
      return;
    }
    if (this.lastFrameTimeMs !== null) {
      this.elapsedSeconds += Math.max(0, timeMs - this.lastFrameTimeMs) / 1000;
      this.publish();
    }
    this.lastFrameTimeMs = timeMs;
    this.sync();
  };

  private hasActiveAnimation(): boolean {
    return Boolean(this.resource?.layers.some((layer) =>
      layer.enabled &&
      layer.animation.enabled &&
      effectiveRateHz(this.resource!, layer) > 0,
    ));
  }

  private publish(): void {
    const resource = this.resource;
    if (!resource) {
      if (this.snapshot !== EMPTY_SNAPSHOT) {
        this.snapshot = EMPTY_SNAPSHOT;
        this.notify();
        this.notifyFrame();
      }
      return;
    }
    const previous = this.snapshot.phaseUniformByLayerId;
    let layerSetChanged = previous.size !== resource.layers.length;
    const phaseUniformByLayerId = new Map<string, LivePhaseUniform>();
    for (const layer of resource.layers) {
      const rateHz = layer.enabled && layer.animation.enabled
        ? effectiveRateHz(resource, layer)
        : 0;
      const phaseRad = wrapPhaseRad(
        layer.phase_rad +
          layer.animation.phase_offset_rad +
          TWO_PI * rateHz * this.elapsedSeconds,
      );
      let uniform = previous.get(layer.layer_id);
      if (!uniform) {
        uniform = createLivePhaseUniform(phaseRad);
        layerSetChanged = true;
      }
      uniform.value = phaseRad;
      phaseUniformByLayerId.set(layer.layer_id, uniform);
    }
    if (layerSetChanged) {
      this.snapshot = { phaseUniformByLayerId };
      this.notify();
    }
    this.notifyFrame();
  }

  private sync(): void {
    if (!this.hasActiveAnimation()) {
      this.stopFrame();
      return;
    }
    if (
      this.animationFrameId !== null ||
      typeof globalThis.requestAnimationFrame !== "function"
    ) {
      return;
    }
    this.animationFrameId = globalThis.requestAnimationFrame(this.frame);
  }

  private stopFrame(): void {
    if (this.animationFrameId === null) return;
    if (typeof globalThis.cancelAnimationFrame === "function") {
      globalThis.cancelAnimationFrame(this.animationFrameId);
    }
    this.animationFrameId = null;
    this.lastFrameTimeMs = null;
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private notifyFrame(): void {
    for (const listener of this.frameListeners) listener();
  }
}

export function useModeCompositionPhaseClock(
  resource: ModeCompositionResource | null | undefined,
): ModeCompositionPhaseClockSnapshot & {
  readonly subscribeFrame: ModeCompositionPhaseClock["subscribeFrame"];
} {
  const [clock] = useState(() => new ModeCompositionPhaseClock());
  const subscribe = useCallback((listener: Listener) => clock.subscribe(listener), [clock]);
  const getSnapshot = useCallback(() => clock.getSnapshot(), [clock]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    clock.setResource(resource);
  }, [clock, resource]);
  useEffect(() => () => clock.stop(), [clock]);

  return useMemo(
    () => ({ ...snapshot, subscribeFrame: clock.subscribeFrame }),
    [clock, snapshot],
  );
}

function effectiveRateHz(
  resource: ModeCompositionResource,
  layer: ModeCompositionLayer,
): number {
  const requestedRate = resource.phase_clock.synchronized && layer.animation.synchronized
    ? resource.phase_clock.master_rate_hz
    : layer.animation.rate_hz;
  return Number.isFinite(requestedRate) && requestedRate > 0 ? requestedRate : 0;
}

function wrapPhaseRad(phaseRad: number): number {
  const wrapped = phaseRad % TWO_PI;
  return wrapped >= 0 ? wrapped : wrapped + TWO_PI;
}
