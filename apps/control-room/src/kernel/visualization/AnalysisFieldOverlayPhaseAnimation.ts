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
const DEFAULT_INTERVAL_MS = 100;

export function startAnalysisFieldOverlayPhaseAnimation(
  controller: AnalysisFieldOverlayController,
  options: AnalysisFieldOverlayPhaseAnimationOptions = {},
): AnalysisFieldOverlayPhaseAnimationHandle {
  const intervalMs = Math.max(16, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  let intervalId: ReturnType<typeof globalThis.setInterval> | null = null;
  let stopped = false;

  const stopInterval = () => {
    if (intervalId === null) return;
    globalThis.clearInterval(intervalId);
    intervalId = null;
  };

  const tick = () => {
    const snapshot = controller.getSnapshot();
    if (!isAnimatingEigenOverlay(snapshot)) {
      stopInterval();
      return;
    }
    const phaseRad = snapshot.query.phase_rad ?? 0;
    const animationRateHz = snapshot.animation.animationRateHz;
    controller.update({
      query: {
        ...snapshot.query,
        phase_rad: wrapPhaseRad(
          phaseRad + TWO_PI * animationRateHz * (intervalMs / 1000),
        ),
        view: "phase_rotated_real",
      },
    });
  };

  const sync = () => {
    if (stopped) return;
    if (!isAnimatingEigenOverlay(controller.getSnapshot())) {
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

function isAnimatingEigenOverlay(
  snapshot: AnalysisFieldOverlayState | null,
): snapshot is AnalysisFieldOverlayState & {
  animation: NonNullable<AnalysisFieldOverlayState["animation"]>;
} {
  return Boolean(
    snapshot?.source === "eigen-mode" &&
      snapshot.animation?.animatePhase &&
      Number.isFinite(snapshot.animation.animationRateHz) &&
      snapshot.animation.animationRateHz > 0,
  );
}

function wrapPhaseRad(phaseRad: number): number {
  const wrapped = phaseRad % TWO_PI;
  return wrapped >= 0 ? wrapped : wrapped + TWO_PI;
}
