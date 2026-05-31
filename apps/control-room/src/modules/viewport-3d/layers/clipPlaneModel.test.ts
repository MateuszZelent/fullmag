import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { VisualizationStateResource } from "@/kernel/api/apiTypes";

import {
  buildClipPlaneIntersectionMarkerBuffers,
  resolveClipPlaneFrame,
  resolveClipPlaneFrameOutlineSegments,
} from "./clipPlaneModel";

const bounds = {
  center: [10, 20, 30] as [number, number, number],
  radius: 50,
  size: [100, 200, 300] as [number, number, number],
};
const clipPlaneLayerSourceUrl = new URL("./ClipPlaneLayer.tsx", import.meta.url);

function clip(
  patch: Partial<VisualizationStateResource["clip"]>,
): VisualizationStateResource["clip"] {
  return {
    axis: "z",
    enabled: true,
    flipped: false,
    position_percent: 50,
    ...patch,
  };
}

describe("resolveClipPlaneFrame", () => {
  it("places an XY cut plane along the Z bounds span", () => {
    expect(resolveClipPlaneFrame(clip({ axis: "z", position_percent: 25 }), bounds))
      .toMatchObject({
        center: [10, 20, -45],
        height: 200,
        normal: [0, 0, 1],
        planeConstant: 45,
        width: 100,
      });
  });

  it("places a YZ cut plane along the X bounds span", () => {
    expect(resolveClipPlaneFrame(clip({ axis: "x", position_percent: 75 }), bounds))
      .toMatchObject({
        center: [35, 20, 30],
        height: 300,
        normal: [1, 0, 0],
        planeConstant: -35,
        width: 200,
      });
  });

  it("flips the clipping normal without moving the visual plane", () => {
    expect(
      resolveClipPlaneFrame(
        clip({ axis: "y", flipped: true, position_percent: 10 }),
        bounds,
      ),
    ).toMatchObject({
      center: [10, -60, 30],
      normal: [0, -1, 0],
      planeConstant: -60,
    });
  });

  it("clamps invalid percentages and skips disabled clips", () => {
    expect(resolveClipPlaneFrame(clip({ enabled: false }), bounds)).toBeNull();
    expect(resolveClipPlaneFrame(clip({ position_percent: 150 }), bounds))
      .toMatchObject({
        center: [10, 20, 180],
        planeConstant: -180,
      });
  });

  it("stores clamped in-plane frame rotation separately from the clipping plane", () => {
    expect(
      resolveClipPlaneFrame(
        clip({ axis: "z", position_percent: 50 }),
        bounds,
        270,
      ),
    ).toMatchObject({
      center: [10, 20, 30],
      normal: [0, 0, 1],
      planeConstant: -30,
      rotationDegrees: 180,
    });
    expect(
      resolveClipPlaneFrame(
        clip({ axis: "x", position_percent: 50 }),
        bounds,
        -35,
      ),
    ).toMatchObject({
      normal: [1, 0, 0],
      rotationDegrees: -35,
    });
  });

  it("builds COMSOL-style local outline segments around the cut plane", () => {
    const frame = resolveClipPlaneFrame(
      clip({ axis: "z", position_percent: 50 }),
      bounds,
    );

    expect(frame).not.toBeNull();
    expect([...resolveClipPlaneFrameOutlineSegments(frame!)]).toEqual([
      -50, -100, 0,
      50, -100, 0,
      50, -100, 0,
      50, 100, 0,
      50, 100, 0,
      -50, 100, 0,
      -50, 100, 0,
      -50, -100, 0,
      -50, 0, 0,
      50, 0, 0,
      0, -100, 0,
      0, 100, 0,
    ]);
  });

  it("splits cross-section marker positions into mesh-node and edge-intersection buffers", () => {
    const buffers = buildClipPlaneIntersectionMarkerBuffers({
      bounds: { uMin: 0, uMax: 1, vMin: 0, vMax: 1 },
      intersectionEdgeNodeIds: new Uint32Array([0, 0, 0, 3, 1, 3]),
      intersectionEdgeT: new Float32Array([0, 0.5, 0.5]),
      intersectionKinds: new Uint32Array([1, 0, 0]),
      intersectionWorld: new Float32Array([
        0, 0, 0.5,
        0.5, 0, 0.5,
        0, 0.5, 0.5,
      ]),
      parentElementIds: new Uint32Array([7]),
      polygonCount: 1,
      polygonOffsets: new Uint32Array([0, 3]),
      segmentCount: 0,
      segments: new Float32Array(),
      vertexCount: 3,
      vertices: new Float32Array([0, 0, 0.5, 0, 0, 0.5]),
    });

    expect(buffers?.meshNodeCount).toBe(1);
    expect(buffers?.edgeIntersectionCount).toBe(2);
    expect([...(buffers?.meshNodePositions ?? [])]).toEqual([0, 0, 0.5]);
    expect([...(buffers?.edgeIntersectionPositions ?? [])]).toEqual([
      0.5, 0, 0.5,
      0, 0.5, 0.5,
    ]);
  });

  it("keeps the cross-section frame preview as an outline-only layer", () => {
    const source = readFileSync(clipPlaneLayerSourceUrl, "utf8");
    const previewStart = source.indexOf(
      "export function ClipPlaneFramePreviewLayer",
    );
    const previewEnd = source.indexOf("function resolveClipPlaneFrameQuaternion");
    const previewBlock = source.slice(previewStart, previewEnd);

    expect(previewStart).toBeGreaterThanOrEqual(0);
    expect(previewEnd).toBeGreaterThan(previewStart);
    expect(previewBlock).toContain("ClipPlaneFrameOutline");
    expect(previewBlock).not.toContain("applyRendererClipping");
    expect(previewBlock).not.toContain("ClipPlaneIntersectionMarkers");
    expect(previewBlock).not.toContain("<mesh");
    expect(previewBlock).not.toContain("<points");
  });
});
