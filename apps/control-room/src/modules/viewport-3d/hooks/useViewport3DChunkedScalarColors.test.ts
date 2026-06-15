import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { ScalarColorBuffer } from "../viewport3dFieldMapping";
import type { Viewport3DFieldRenderModel } from "../viewport3dRenderModel";
import {
  chunkedScalarColorStateIsCompatible,
  mergeViewport3DFieldScalarColors,
  shouldStartChunkedScalarColorBuild,
} from "./useViewport3DChunkedScalarColors";

const sourceUrl = new URL("./useViewport3DChunkedScalarColors.ts", import.meta.url);

function colorBuffer(value: number): ScalarColorBuffer {
  return {
    colors: new Float32Array([value, value, value]),
    range: { max: value, min: value },
  };
}

describe("useViewport3DChunkedScalarColors", () => {
  it("merges chunked scalar buffers over the synchronous field render model", () => {
    const sync = colorBuffer(1);
    const asyncOrientation = colorBuffer(2);
    const base: Viewport3DFieldRenderModel = {
      complexFieldVector: null,
      fullVectorSegments: null,
      partVectorSegments: new Map(),
      scalarColors: sync,
      scalarColorsByPartAndMode: new Map(),
      scalarColorsByMode: new Map([["orientation", sync]]),
      visualizationPhaseRad: null,
    };

    const result = mergeViewport3DFieldScalarColors(
      base,
      new Map([["orientation", asyncOrientation]]),
      "orientation",
    );

    expect(result?.scalarColors).toBe(asyncOrientation);
    expect(result?.scalarColorsByMode.get("orientation")).toBe(asyncOrientation);
  });

  it("keeps chunked buffers out of React state and clears them on cleanup", () => {
    const source = readFileSync(sourceUrl, "utf8");

    expect(source).toContain("const chunkedScalarColorBuffers = new WeakMap");
    expect(source).toContain("useReducer");
    expect(source).toContain("chunkedScalarColorReducer");
    expect(source).toContain("releaseChunkedScalarColorToken");
    expect(source).not.toContain("useState");
    expect(source).not.toContain("buffers: Map<string, ScalarColorBuffer>");
  });

  it("keeps the previous chunked buffers visible during compatible field replacement", () => {
    const topology = { nodeCount: 75_000 };
    const fieldVector = {};
    const current = {
      colorPalette: "viridis",
      fieldVector,
      modesKey: "orientation",
      token: {},
      topology,
    };

    expect(
      chunkedScalarColorStateIsCompatible(current, {
        colorPalette: "viridis",
        enabled: true,
        fieldPointCount: 75_000,
        modesKey: "orientation",
        needsChunking: true,
        topology,
      }),
    ).toBe(true);
  });

  it("drops previous chunked buffers when topology or mode compatibility changes", () => {
    const topology = { nodeCount: 75_000 };
    const fieldVector = {};
    const current = {
      colorPalette: "viridis",
      fieldVector,
      modesKey: "orientation",
      token: {},
      topology,
    };

    expect(
      chunkedScalarColorStateIsCompatible(current, {
        colorPalette: "viridis",
        enabled: true,
        fieldPointCount: 75_000,
        modesKey: "orientation",
        needsChunking: true,
        topology: { nodeCount: 75_000 },
      }),
    ).toBe(false);
    expect(
      chunkedScalarColorStateIsCompatible(current, {
        colorPalette: "viridis",
        enabled: true,
        fieldPointCount: 75_000,
        modesKey: "magnitude",
        needsChunking: true,
        topology,
      }),
    ).toBe(false);
    expect(
      chunkedScalarColorStateIsCompatible(current, {
        colorPalette: "viridis",
        enabled: true,
        fieldPointCount: 10_000,
        modesKey: "orientation",
        needsChunking: false,
        topology,
      }),
    ).toBe(false);
  });

  it("does not start overlapping chunked color builds while a previous build is pending", () => {
    const currentFieldVector = {};
    expect(
      shouldStartChunkedScalarColorBuild({
        builtFieldVector: null,
        currentFieldVector,
        eligibleForChunkedBuild: true,
        pending: false,
      }),
    ).toBe(true);
    expect(
      shouldStartChunkedScalarColorBuild({
        builtFieldVector: null,
        currentFieldVector,
        eligibleForChunkedBuild: true,
        pending: true,
      }),
    ).toBe(false);
    expect(
      shouldStartChunkedScalarColorBuild({
        builtFieldVector: currentFieldVector,
        currentFieldVector,
        eligibleForChunkedBuild: true,
        pending: false,
      }),
    ).toBe(false);
  });
});
