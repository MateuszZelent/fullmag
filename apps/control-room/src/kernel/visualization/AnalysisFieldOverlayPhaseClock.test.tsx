import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { instanceTabVisibility } from "../layout/instanceTabVisibility";
import { installSimulationPreparationTestDom } from "../layout/simulationPreparationTestDom.test-support";
import {
  AnalysisFieldOverlayController,
  useAnalysisFieldOverlay,
  useAnalysisFieldOverlayContext,
  useAnalysisFieldOverlayDisplayedPhase,
  useRenderableAnalysisFieldOverlay,
} from "./AnalysisFieldOverlayController";
import { startAnalysisFieldOverlayPhaseAnimation } from "./AnalysisFieldOverlayPhaseAnimation";
import { isLivePhaseUniform } from "./livePhaseUniform";

function setAnimatedOverlay(controller: AnalysisFieldOverlayController): void {
  controller.set({
    animation: { animatePhase: true, animationRateHz: 1 },
    fieldId: "analysis:eigen:sample-0000:mode-0002",
    label: "Mode 2",
    query: {
      component: "full",
      phase_rad: 0,
      scope_kind: "full",
      view: "phase_rotated_real",
    },
    source: "eigen-mode",
    visualizationPhaseRad: 0.5,
  });
}

function stubFrames() {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    nextId += 1;
    callbacks.set(nextId, callback);
    return nextId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    callbacks.delete(id);
  });
  return {
    run(timeMs: number) {
      const pending = [...callbacks.entries()];
      callbacks.clear();
      for (const [, callback] of pending) callback(timeMs);
    },
  };
}

describe("AnalysisFieldOverlayPhaseClock", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    instanceTabVisibility.resetForTests();
  });

  it("advances animation frames without notifying overlay subscribers", () => {
    const frames = stubFrames();
    const controller = new AnalysisFieldOverlayController();
    setAnimatedOverlay(controller);
    const snapshot = controller.getSnapshot();
    const overlayListener = vi.fn();
    const clockListener = vi.fn();
    controller.subscribe(overlayListener);
    controller.phaseClock.subscribe(clockListener);
    const handle = startAnalysisFieldOverlayPhaseAnimation(controller);

    frames.run(1_000);
    frames.run(1_100);
    frames.run(1_200);

    expect(overlayListener).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toBe(snapshot);
    expect(clockListener).toHaveBeenCalledTimes(2);
    expect(controller.getDisplayedPhaseRad()).toBeCloseTo(0.5 + 0.4 * Math.PI);
    expect(controller.phaseClock.uniform.value).toBeCloseTo(0.5 + 0.4 * Math.PI);
    expect(isLivePhaseUniform(controller.phaseClock.uniform)).toBe(true);

    handle.stop();
  });

  it("commits the last frame when the animation is paused", () => {
    const frames = stubFrames();
    const controller = new AnalysisFieldOverlayController();
    setAnimatedOverlay(controller);
    const handle = startAnalysisFieldOverlayPhaseAnimation(controller);
    frames.run(1_000);
    frames.run(1_250);
    const livePhaseRad = controller.getDisplayedPhaseRad();

    controller.update({
      animation: { animatePhase: false, animationRateHz: 1 },
    });

    expect(controller.phaseClock.getLivePhaseRad()).toBeNull();
    expect(controller.getSnapshot()?.visualizationPhaseRad).toBeCloseTo(livePhaseRad);
    expect(controller.phaseClock.uniform.value).toBeCloseTo(livePhaseRad);
    handle.stop();
  });

  it("lets an explicitly set phase replace the running animation phase", () => {
    const frames = stubFrames();
    const controller = new AnalysisFieldOverlayController();
    setAnimatedOverlay(controller);
    const handle = startAnalysisFieldOverlayPhaseAnimation(controller);
    frames.run(1_000);
    frames.run(1_100);

    controller.update({ visualizationPhaseRad: 2 });

    expect(controller.phaseClock.getLivePhaseRad()).toBeNull();
    expect(controller.getDisplayedPhaseRad()).toBe(2);
    expect(controller.phaseClock.uniform.value).toBe(2);
    frames.run(1_200);
    expect(controller.getDisplayedPhaseRad()).toBeCloseTo(2 + 0.2 * Math.PI);
    handle.stop();
  });

  it("resets to an unchanged committed phase without rebuilding the overlay", () => {
    const frames = stubFrames();
    const controller = new AnalysisFieldOverlayController();
    setAnimatedOverlay(controller);
    const snapshot = controller.getSnapshot();
    const listener = vi.fn();
    controller.subscribe(listener);
    const handle = startAnalysisFieldOverlayPhaseAnimation(controller);
    frames.run(1_000);
    frames.run(1_100);
    expect(controller.getDisplayedPhaseRad()).not.toBe(0.5);

    controller.update({ visualizationPhaseRad: 0.5 });

    expect(controller.getSnapshot()).toBe(snapshot);
    expect(listener).not.toHaveBeenCalled();
    expect(controller.phaseClock.getLivePhaseRad()).toBeNull();
    expect(controller.phaseClock.uniform.value).toBe(0.5);
    frames.run(1_200);
    expect(controller.getDisplayedPhaseRad()).toBeCloseTo(0.5 + 0.2 * Math.PI);

    controller.update({
      animation: { animatePhase: false, animationRateHz: 1 },
      visualizationPhaseRad: 0.5,
    });
    expect(controller.getSnapshot()?.visualizationPhaseRad).toBe(0.5);
    expect(controller.getDisplayedPhaseRad()).toBe(0.5);
    handle.stop();
  });

  it("keeps phase-ignoring subscribers on the same snapshot when only the phase changes", async () => {
    const controller = new AnalysisFieldOverlayController();
    setAnimatedOverlay(controller);
    const renders = { context: 0, overlay: 0, renderable: 0, withPhase: 0 };
    const seen: { label?: string; phase?: number } = {};
    function ContextProbe() {
      renders.context += 1;
      const context = useAnalysisFieldOverlayContext(controller, { ignorePhase: true });
      seen.label = context.overlay?.label;
      return null;
    }
    function OverlayProbe() {
      renders.overlay += 1;
      useAnalysisFieldOverlay(controller, { ignorePhase: true });
      return null;
    }
    function RenderableProbe() {
      renders.renderable += 1;
      useRenderableAnalysisFieldOverlay(controller, { ignorePhase: true });
      return null;
    }
    function PhaseProbe() {
      renders.withPhase += 1;
      seen.phase = useAnalysisFieldOverlay(controller)?.visualizationPhaseRad;
      return null;
    }
    const dom = installSimulationPreparationTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as Element);
    try {
      await act(async () => root.render(
        <>
          <ContextProbe />
          <OverlayProbe />
          <RenderableProbe />
          <PhaseProbe />
        </>,
      ));
      const before = { ...renders };

      await act(async () => controller.update({ visualizationPhaseRad: 1.25 }));

      expect(renders.context).toBe(before.context);
      expect(renders.overlay).toBe(before.overlay);
      expect(renders.renderable).toBe(before.renderable);
      expect(renders.withPhase).toBe(before.withPhase + 1);
      expect(seen.phase).toBe(1.25);

      await act(async () => controller.update({ label: "Mode 2 (renamed)" }));

      expect(renders.context).toBe(before.context + 1);
      expect(seen.label).toBe("Mode 2 (renamed)");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("throttles the displayed-phase readout while animating", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const controller = new AnalysisFieldOverlayController();
    setAnimatedOverlay(controller);
    let renders = 0;
    let shown = Number.NaN;
    function Readout() {
      renders += 1;
      shown = useAnalysisFieldOverlayDisplayedPhase(controller, { maxHz: 10 });
      return null;
    }
    const dom = installSimulationPreparationTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as Element);
    try {
      await act(async () => root.render(<Readout />));
      expect(shown).toBe(0.5);
      const rendersBefore = renders;

      await act(async () => {
        for (let frame = 1; frame <= 6; frame += 1) {
          controller.phaseClock.setLivePhaseRad(0.5 + frame * 0.01);
        }
      });
      // The first change shows at once; later frames wait for the trailing update.
      expect(renders - rendersBefore).toBe(1);
      expect(shown).toBeCloseTo(0.51);

      await act(async () => {
        vi.advanceTimersByTime(100);
      });
      expect(renders - rendersBefore).toBe(2);
      expect(shown).toBeCloseTo(0.56);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
