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
    vi.unstubAllGlobals();
  });

  it("advances phase only while eigen mode animation is active", () => {
    vi.useFakeTimers();
    const controller = new AnalysisFieldOverlayController();
    setEigenOverlay(controller);

    const handle = startAnalysisFieldOverlayPhaseAnimation(controller, {
      intervalMs: 100,
    });

    vi.advanceTimersByTime(100);

    expect(controller.getSnapshot()?.query.phase_rad).toBe(0);
    expect(controller.getSnapshot()?.visualizationPhaseRad).toBeCloseTo(
      0.2 * Math.PI,
    );

    controller.update({
      animation: {
        animatePhase: false,
        animationRateHz: 1,
      },
    });
    vi.advanceTimersByTime(500);

    expect(controller.getSnapshot()?.query.phase_rad).toBe(0);
    expect(controller.getSnapshot()?.visualizationPhaseRad).toBeCloseTo(
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
        phase_rad: 0,
        view: "phase_rotated_real",
      },
      source: "frequency-response",
      visualizationPhaseRad: 0.2 * Math.PI,
    });

    handle.stop();
  });

  it("uses bounded default cadence for backend-backed phase animation", () => {
    vi.useFakeTimers();
    const controller = new AnalysisFieldOverlayController();
    setEigenOverlay(controller);

    const handle = startAnalysisFieldOverlayPhaseAnimation(controller);

    vi.advanceTimersByTime(100);
    expect(controller.getSnapshot()?.query.phase_rad).toBe(0);
    expect(controller.getSnapshot()?.visualizationPhaseRad).toBeUndefined();

    vi.advanceTimersByTime(150);
    expect(controller.getSnapshot()?.query.phase_rad).toBe(0);
    expect(controller.getSnapshot()?.visualizationPhaseRad).toBeCloseTo(
      0.5 * Math.PI,
    );

    handle.stop();
  });

  it("stops at one full cycle when phase looping is disabled", () => {
    vi.useFakeTimers();
    const controller = new AnalysisFieldOverlayController();
    setEigenOverlay(controller);
    controller.update({
      animation: {
        animatePhase: true,
        animationRateHz: 1,
        direction: 1,
        loop: false,
      },
      visualizationPhaseRad: 1.9 * Math.PI,
    });

    const handle = startAnalysisFieldOverlayPhaseAnimation(controller, {
      intervalMs: 100,
    });
    vi.advanceTimersByTime(100);

    expect(controller.getSnapshot()?.visualizationPhaseRad).toBeCloseTo(2 * Math.PI);
    expect(controller.getSnapshot()?.animation).toMatchObject({
      animatePhase: false,
      loop: false,
    });

    handle.stop();
  });

  it("does not schedule phase motion when reduced motion is requested", () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    const requestFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const controller = new AnalysisFieldOverlayController();
    setEigenOverlay(controller);
    controller.update({
      animation: {
        animatePhase: true,
        animationRateHz: 1,
        direction: -1,
        loop: false,
      },
      visualizationPhaseRad: 1.25,
    });

    const handle = startAnalysisFieldOverlayPhaseAnimation(controller, {
      intervalMs: 100,
    });
    vi.advanceTimersByTime(500);

    expect(requestFrame).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({
      animation: {
        animatePhase: false,
        animationRateHz: 1,
        direction: -1,
        loop: false,
      },
      query: { phase_rad: 0 },
      visualizationPhaseRad: 1.25,
    });

    handle.stop();
  });

  it("pauses and cancels local phase animation when the document becomes hidden", () => {
    vi.useFakeTimers();
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const visibilityListeners = new Set<() => void>();
    const documentStub = {
      visibilityState: "visible" as DocumentVisibilityState,
      addEventListener: vi.fn((_type: string, listener: () => void) => {
        visibilityListeners.add(listener);
      }),
      removeEventListener: vi.fn((_type: string, listener: () => void) => {
        visibilityListeners.delete(listener);
      }),
    };
    vi.stubGlobal("document", documentStub);
    const controller = new AnalysisFieldOverlayController();
    setEigenOverlay(controller);
    controller.update({
      animation: {
        animatePhase: true,
        animationRateHz: 1,
        direction: -1,
        loop: false,
      },
      visualizationPhaseRad: 0.75,
    });

    const handle = startAnalysisFieldOverlayPhaseAnimation(controller, {
      intervalMs: 100,
    });
    documentStub.visibilityState = "hidden";
    visibilityListeners.forEach((listener) => listener());
    vi.advanceTimersByTime(500);

    expect(clearIntervalSpy).toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({
      animation: {
        animatePhase: false,
        animationRateHz: 1,
        direction: -1,
        loop: false,
      },
      query: { phase_rad: 0 },
      visualizationPhaseRad: 0.75,
    });

    documentStub.visibilityState = "visible";
    visibilityListeners.forEach((listener) => listener());
    vi.advanceTimersByTime(500);
    expect(controller.getSnapshot()?.animation?.animatePhase).toBe(false);
    expect(controller.getSnapshot()?.visualizationPhaseRad).toBe(0.75);

    handle.stop();
    expect(documentStub.removeEventListener).toHaveBeenCalled();
  });

  it("cancels a browser frame when the document becomes hidden", () => {
    const callbacks: FrameRequestCallback[] = [];
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    const cancelFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", cancelFrame);
    const visibilityListeners = new Set<() => void>();
    const documentStub = {
      visibilityState: "visible" as DocumentVisibilityState,
      addEventListener: vi.fn((_type: string, listener: () => void) => {
        visibilityListeners.add(listener);
      }),
      removeEventListener: vi.fn((_type: string, listener: () => void) => {
        visibilityListeners.delete(listener);
      }),
    };
    vi.stubGlobal("document", documentStub);
    const controller = new AnalysisFieldOverlayController();
    setEigenOverlay(controller);
    controller.update({ visualizationPhaseRad: 1.5 });

    const handle = startAnalysisFieldOverlayPhaseAnimation(controller);
    expect(requestFrame).toHaveBeenCalledTimes(1);

    documentStub.visibilityState = "hidden";
    visibilityListeners.forEach((listener) => listener());

    expect(cancelFrame).toHaveBeenCalledWith(1);
    expect(controller.getSnapshot()).toMatchObject({
      animation: { animatePhase: false },
      query: { phase_rad: 0 },
      visualizationPhaseRad: 1.5,
    });

    handle.stop();
    expect(callbacks).toHaveLength(1);
  });

  it("uses frame timestamps for smooth browser animation and cancels the owned frame", () => {
    const callbacks: FrameRequestCallback[] = [];
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    const cancelFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", cancelFrame);
    const controller = new AnalysisFieldOverlayController();
    setEigenOverlay(controller);

    const handle = startAnalysisFieldOverlayPhaseAnimation(controller);
    callbacks.shift()?.(1000);
    callbacks.shift()?.(1016);

    expect(controller.getSnapshot()?.visualizationPhaseRad).toBeCloseTo(
      2 * Math.PI * 0.016,
    );
    expect(requestFrame).toHaveBeenCalledTimes(3);

    handle.stop();
    expect(cancelFrame).toHaveBeenCalled();
  });
});
