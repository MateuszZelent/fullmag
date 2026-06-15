"use client";

import type { AnalysisFieldOverlayState } from "./AnalysisFieldOverlayController";
import { AnalysisFieldOverlayController } from "./AnalysisFieldOverlayController";

interface AnalysisFieldOverlayPhaseAnimationOptions {
  intervalMs?: number;
}

interface AnalysisFieldOverlayPhaseAnimationHandle {
  stop: () => void;
}

const TWO_PI = Math.PI * 2;
const DEFAULT_INTERVAL_MS = 250;

export function startAnalysisFieldOverlayPhaseAnimation(
  controller: AnalysisFieldOverlayController,
  options: AnalysisFieldOverlayPhaseAnimationOptions = {},
): AnalysisFieldOverlayPhaseAnimationHandle {
  const intervalMs = Math.max(100, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  let intervalId: ReturnType<typeof globalThis.setInterval> | null = null;
  let stopped = false;

  const stopInterval = () => {
    if (intervalId === null) return;
    globalThis.clearInterval(intervalId);
    intervalId = null;
  };

  const tick = () => {
    const snapshot = controller.getSnapshot();
    if (!isAnimatingAnalysisOverlay(snapshot)) {
      stopInterval();
      return;
    }
    const phaseRad =
      snapshot.visualizationPhaseRad ?? snapshot.query.phase_rad ?? 0;
    const animationRateHz = snapshot.animation.animationRateHz;
    controller.update({
      visualizationPhaseRad: wrapPhaseRad(
        phaseRad + TWO_PI * animationRateHz * (intervalMs / 1000),
      ),
    });
  };

  const sync = () => {
    if (stopped) return;
    if (!isAnimatingAnalysisOverlay(controller.getSnapshot())) {
      stopInterval();
      return;
    }
    if (intervalId !== null) return;
    intervalId = globalThis.setInterval(tick, intervalMs);
  };

  const unsubscribe = controller.subscribe(sync);
  sync();

  return {
    stop: () => {
      stopped = true;
      stopInterval();
      unsubscribe();
    },
  };
}

function isAnimatingAnalysisOverlay(
  snapshot: AnalysisFieldOverlayState | null,
): snapshot is AnalysisFieldOverlayState & {
  animation: NonNullable<AnalysisFieldOverlayState["animation"]>;
} {
  return Boolean(
    snapshot?.animation?.animatePhase &&
      Number.isFinite(snapshot.animation.animationRateHz) &&
      snapshot.animation.animationRateHz > 0,
  );
}

function wrapPhaseRad(phaseRad: number): number {
  const wrapped = phaseRad % TWO_PI;
  return wrapped >= 0 ? wrapped : wrapped + TWO_PI;
}
