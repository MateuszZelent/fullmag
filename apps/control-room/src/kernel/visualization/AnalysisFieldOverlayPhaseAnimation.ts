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
  let animationFrameId: number | null = null;
  let previousFrameTimeMs: number | null = null;
  let stopped = false;
  const browserFramesAvailable =
    typeof globalThis.requestAnimationFrame === "function" &&
    typeof globalThis.cancelAnimationFrame === "function";
  const documentAvailable = typeof globalThis.document !== "undefined";
  const reducedMotion =
    typeof globalThis.matchMedia === "function" &&
    globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const stopInterval = () => {
    if (intervalId === null) return;
    globalThis.clearInterval(intervalId);
    intervalId = null;
  };

  const stopFrame = () => {
    if (animationFrameId === null) return;
    globalThis.cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
    previousFrameTimeMs = null;
  };

  const tick = () => {
    const snapshot = controller.getSnapshot();
    if (!isAnimatingAnalysisOverlay(snapshot)) {
      stopInterval();
      return;
    }
    const phaseRad =
      snapshot.visualizationPhaseRad ?? snapshot.query.phase_rad ?? 0;
    const animationRateHz =
      snapshot.animation.animationRateHz * (snapshot.animation.direction ?? 1);
    controller.update({
      visualizationPhaseRad: wrapPhaseRad(
        phaseRad + TWO_PI * animationRateHz * (intervalMs / 1000),
      ),
    });
  };

  const frame = (timeMs: number) => {
    animationFrameId = null;
    const snapshot = controller.getSnapshot();
    if (!isAnimatingAnalysisOverlay(snapshot)) {
      previousFrameTimeMs = null;
      return;
    }
    if (previousFrameTimeMs !== null) {
      const elapsedSeconds = Math.min(
        0.1,
        Math.max(0, timeMs - previousFrameTimeMs) / 1000,
      );
      const phaseRad =
        snapshot.visualizationPhaseRad ?? snapshot.query.phase_rad ?? 0;
      controller.update({
        visualizationPhaseRad: wrapPhaseRad(
          phaseRad +
            TWO_PI *
              snapshot.animation.animationRateHz *
              (snapshot.animation.direction ?? 1) *
              elapsedSeconds,
        ),
      });
    }
    previousFrameTimeMs = timeMs;
    if (
      animationFrameId === null &&
      isAnimatingAnalysisOverlay(controller.getSnapshot())
    ) {
      animationFrameId = globalThis.requestAnimationFrame(frame);
    }
  };

  const sync = () => {
    if (stopped) return;
    if (
      !isAnimatingAnalysisOverlay(controller.getSnapshot()) ||
      reducedMotion ||
      (documentAvailable && globalThis.document.visibilityState === "hidden")
    ) {
      stopInterval();
      stopFrame();
      return;
    }
    if (browserFramesAvailable) {
      stopInterval();
      if (animationFrameId === null) {
        animationFrameId = globalThis.requestAnimationFrame(frame);
      }
      return;
    }
    if (intervalId !== null) return;
    intervalId = globalThis.setInterval(tick, intervalMs);
  };

  const unsubscribe = controller.subscribe(sync);
  if (documentAvailable) {
    globalThis.document.addEventListener("visibilitychange", sync);
  }
  sync();

  return {
    stop: () => {
      stopped = true;
      stopInterval();
      stopFrame();
      unsubscribe();
      if (documentAvailable) {
        globalThis.document.removeEventListener("visibilitychange", sync);
      }
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
