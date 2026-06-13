import { afterEach, describe, expect, it, vi } from "vitest";

import { AnalysisFieldOverlayController } from "./AnalysisFieldOverlayController";
import {
  startAnalysisFieldOverlayPhaseAnimation,
} from "./AnalysisFieldOverlayPhaseAnimation";

function setEigenOverlay(controller: AnalysisFieldOverlayController): void {
  controller.set({
    animation: {
      animatePhase: true,
      animationRateHz: 1,
    },
    fieldId: "analysis:eigen:sample-0000:mode-0002",
    label: "Mode 2",
    query: {
      component: "full",
      phase_rad: 0,
      scope_kind: "full",
      view: "phase_rotated_real",
    },
    source: "eigen-mode",
  });
}

function setResponseOverlay(controller: AnalysisFieldOverlayController): void {
  controller.set({
    animation: {
      animatePhase: true,
      animationRateHz: 1,
    },
    fieldId: "analysis:frequency-response:frequency-0001",
    label: "1 GHz",
    query: {
      component: "full",
      phase_rad: 0,
      scope_kind: "full",
      view: "phase_rotated_real",
    },
    source: "frequency-response",
  });
}

describe("AnalysisFieldOverlayPhaseAnimation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("advances phase only while eigen mode animation is active", () => {
    vi.useFakeTimers();
    const controller = new AnalysisFieldOverlayController();
    setEigenOverlay(controller);

    const handle = startAnalysisFieldOverlayPhaseAnimation(controller, {
      intervalMs: 100,
    });

    vi.advanceTimersByTime(100);

    expect(controller.getSnapshot()?.query.phase_rad).toBeCloseTo(
      0.2 * Math.PI,
    );

    controller.update({
      animation: {
        animatePhase: false,
        animationRateHz: 1,
      },
    });
    vi.advanceTimersByTime(500);

    expect(controller.getSnapshot()?.query.phase_rad).toBeCloseTo(
      0.2 * Math.PI,
    );

    handle.stop();
  });

  it("stops and clears the interval when the overlay is cleared", () => {
    vi.useFakeTimers();
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const controller = new AnalysisFieldOverlayController();
    setEigenOverlay(controller);

    startAnalysisFieldOverlayPhaseAnimation(controller, { intervalMs: 100 });
    controller.clear();
    vi.advanceTimersByTime(100);

    expect(clearIntervalSpy).toHaveBeenCalled();
    expect(controller.getSnapshot()).toBeNull();
  });

  it("advances response field phase while response animation is active", () => {
    vi.useFakeTimers();
    const controller = new AnalysisFieldOverlayController();
    setResponseOverlay(controller);

    const handle = startAnalysisFieldOverlayPhaseAnimation(controller, {
      intervalMs: 100,
    });

    vi.advanceTimersByTime(100);

    expect(controller.getSnapshot()).toMatchObject({
      query: {
        phase_rad: 0.2 * Math.PI,
        view: "phase_rotated_real",
      },
      source: "frequency-response",
    });

    handle.stop();
  });
});
