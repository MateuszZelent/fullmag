import { BufferGeometry, LineSegments } from "three";
import { describe, expect, it } from "vitest";

import { buildLineIndexGeometry } from "./viewport3dSurfaceEdges";
import {
  sampleViewport3DWireframeEdges,
  updateViewport3DInteractionWireframe,
} from "./viewport3dInteractionWireframe";
import {
  beginViewport3DCameraGesture,
  cancelViewport3DCameraGesture,
  createViewport3DCameraGestureRef,
  settleViewport3DCameraGesture,
} from "./layers/viewport3DCameraGesture";

describe("interaction wireframe", () => {
  it("retains complete edge pairs distributed over the entire surface", () => {
    const edges = new Uint32Array(Array.from({ length: 200 }, (_, index) => index));
    const sampled = sampleViewport3DWireframeEdges(edges, 5);
    expect(Array.from(sampled ?? [])).toEqual([0, 1, 50, 51, 100, 101, 148, 149, 198, 199]);
    expect(edges).toEqual(new Uint32Array(Array.from({ length: 200 }, (_, index) => index)));
  });

  it("keeps small meshes exact and rejects incomplete edge buffers", () => {
    const edges = new Uint32Array([0, 1, 1, 2]);
    expect(sampleViewport3DWireframeEdges(edges, 10)).toBe(edges);
    expect(sampleViewport3DWireframeEdges(new Uint32Array([0, 1, 2]), 10)).toBeNull();
    expect(sampleViewport3DWireframeEdges(null, 10)).toBeNull();
  });

  it("restores the exact full geometry after settling or cancelling navigation", () => {
    const full = new BufferGeometry();
    const light = new BufferGeometry();
    const line = new LineSegments(full);
    const gesture = createViewport3DCameraGestureRef();
    const first = beginViewport3DCameraGesture(gesture, "orbit");
    updateViewport3DInteractionWireframe(line, full, light, gesture);
    expect(line.geometry).toBe(light);
    settleViewport3DCameraGesture(gesture, first);
    updateViewport3DInteractionWireframe(line, full, light, gesture);
    expect(line.geometry).toBe(full);
    const second = beginViewport3DCameraGesture(gesture, "wheel");
    updateViewport3DInteractionWireframe(line, full, light, gesture);
    cancelViewport3DCameraGesture(gesture, second);
    updateViewport3DInteractionWireframe(line, full, light, gesture);
    expect(line.geometry).toBe(full);
  });

  it("keeps the full mesh available while the lightweight buffer is pending", () => {
    const full = new BufferGeometry();
    const line = new LineSegments(full);
    const gesture = createViewport3DCameraGestureRef();
    const epoch = beginViewport3DCameraGesture(gesture);
    updateViewport3DInteractionWireframe(line, full, null, gesture);
    expect(line.geometry).toBe(full);
    cancelViewport3DCameraGesture(gesture, epoch);
  });

  it("shares positions with the full mesh without releasing its live position buffer", () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const full = buildLineIndexGeometry(positions, new Uint32Array([0, 1, 1, 2, 2, 0]))!;
    const light = buildLineIndexGeometry(positions, sampleViewport3DWireframeEdges(full.getIndex()!.array, 2))!;
    expect(light.getAttribute("position")).toBe(full.getAttribute("position"));
    light.dispose();
    expect(full.getAttribute("position").array).toBe(positions);
    full.dispose();
  });
});
