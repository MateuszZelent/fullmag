import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModeCompositionResource } from "./ModeCompositionController";
import { ModeCompositionPhaseClock } from "./ModeCompositionPhaseClock";

const frameCallbacks: FrameRequestCallback[] = [];

function composition(
  animation: Partial<ModeCompositionResource["layers"][number]["animation"]> = {},
  clock: Partial<ModeCompositionResource["phase_clock"]> = {},
): ModeCompositionResource {
  return {
    artifact_revision: "artifact-1",
    composition_id: "active",
    layers: [{
      amplitude_scale: 1,
      animation: {
        enabled: true,
        phase_offset_rad: 0.25,
        rate_hz: 3,
        synchronized: false,
        ...animation,
      },
      appearance: {
        auto_range: true,
        colorbar_visible: true,
        colormap: "coolwarm",
        opacity: 1,
        range_max: null,
        range_min: null,
        symmetric_zero: true,
        vector_budget: 0,
        vector_length_scale: 1,
        vectors_visible: false,
      },
      component: "x",
      enabled: true,
      field_id: "mode-field",
      layer_id: "mode-layer:film",
      mode: {
        artifact_revision: "artifact-1",
        mode_id: "mode-a",
        run_id: "run-1",
        sample_id: "sample-1",
        stage_id: "stage-1",
      },
      normalization: "mode_global_max",
      object_id: "film",
      phase_rad: 0.5,
      representation: "phase_rotated_real",
      target_id: "object:film",
    }],
    lifecycle: {
      artifact_revision: 1,
      mesh_revision: 1,
      run_id: "run-1",
      session_id: "session-1",
    },
    phase_clock: { master_rate_hz: 2, synchronized: true, ...clock },
    revision: 1,
    run_id: "run-1",
    schema_version: "mode-composition.v1",
    stage_id: "stage-1",
  };
}

afterEach(() => {
  frameCallbacks.length = 0;
  vi.unstubAllGlobals();
});

describe("ModeCompositionPhaseClock", () => {
  it("uses a synchronized master rate and disposes its only requested frame", () => {
    let nextFrameId = 0;
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      frameCallbacks.push(callback);
      nextFrameId += 1;
      return nextFrameId;
    });
    const cancelFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", cancelFrame);
    const clock = new ModeCompositionPhaseClock();

    clock.setResource(composition({ synchronized: true }));
    expect(requestFrame).toHaveBeenCalledTimes(1);

    frameCallbacks.shift()?.(1_000);
    frameCallbacks.shift()?.(1_250);
    expect(clock.getSnapshot().phaseByLayerId.get("mode-layer:film")).toBeCloseTo(
      0.5 + 0.25 + 2 * Math.PI * 2 * 0.25,
    );

    clock.stop();
    expect(cancelFrame).toHaveBeenCalledWith(3);
  });

  it("uses each layer rate when synchronization is disabled", () => {
    let nextFrameId = 0;
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      frameCallbacks.push(callback);
      nextFrameId += 1;
      return nextFrameId;
    });
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const clock = new ModeCompositionPhaseClock();

    clock.setResource(composition({ synchronized: false }, { synchronized: false }));
    frameCallbacks.shift()?.(1_000);
    frameCallbacks.shift()?.(1_250);
    expect(clock.getSnapshot().phaseByLayerId.get("mode-layer:film")).toBeCloseTo(
      0.5 + 0.25 + 2 * Math.PI * 3 * 0.25,
    );

    clock.stop();
  });

  it("remains idle when no enabled layer is animated", () => {
    const requestFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const clock = new ModeCompositionPhaseClock();

    clock.setResource(composition({ enabled: false }));

    expect(requestFrame).not.toHaveBeenCalled();
    expect(clock.getSnapshot().phaseByLayerId.get("mode-layer:film")).toBe(0.75);
    clock.stop();
  });

  it("cancels the active frame as soon as the last animated layer is disabled", () => {
    let nextFrameId = 0;
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      frameCallbacks.push(callback);
      nextFrameId += 1;
      return nextFrameId;
    });
    const cancelFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", cancelFrame);
    const clock = new ModeCompositionPhaseClock();

    clock.setResource(composition());
    clock.setResource(composition({ enabled: false }));

    expect(cancelFrame).toHaveBeenCalledWith(1);
    expect(requestFrame).toHaveBeenCalledTimes(1);
    clock.stop();
  });
});
