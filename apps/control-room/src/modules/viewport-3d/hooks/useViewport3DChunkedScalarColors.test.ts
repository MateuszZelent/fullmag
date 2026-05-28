import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { ScalarColorBuffer } from "../viewport3dFieldMapping";
import type { Viewport3DFieldRenderModel } from "../viewport3dRenderModel";
import { mergeViewport3DFieldScalarColors } from "./useViewport3DChunkedScalarColors";

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
      fullVectorSegments: null,
      partVectorSegments: new Map(),
      scalarColors: sync,
      scalarColorsByPartAndMode: new Map(),
      scalarColorsByMode: new Map([["orientation", sync]]),
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
    expect(source).toContain("chunkedScalarColorBuffers.delete(current.token)");
    expect(source).not.toContain("buffers: Map<string, ScalarColorBuffer>");
  });
});
