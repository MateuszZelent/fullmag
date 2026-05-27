import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { resolveMeshPartWireframeEdgeIndices } from "./MeshPartLayer";

describe("MeshPartLayer", () => {
  it("uses the scalar shader material when large scalar buffers skip CPU RGB colors", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./MeshPartLayer.tsx", import.meta.url)),
      "utf8",
    );

    expect(source).toContain("canApplyScalarShaderColorBuffer");
    expect(source).toContain("field-scalar-shader");
    expect(source).toContain("<primitive attach=\"material\" object={scalarShaderMaterial} />");
  });

  it("uses volume edges for full magnetic-object wireframe and surface edges for surface mode", () => {
    const surfaceEdges = new Uint32Array([0, 1, 1, 2]);
    const volumeEdges = new Uint32Array([0, 1, 1, 2, 2, 3, 0, 3]);
    const partModel = {
      edgeIndices: surfaceEdges,
      volumeEdgeIndices: volumeEdges,
    };

    expect(resolveMeshPartWireframeEdgeIndices("full", partModel)).toBe(
      volumeEdges,
    );
    expect(resolveMeshPartWireframeEdgeIndices("surface", partModel)).toBe(
      surfaceEdges,
    );
  });

  it("does not silently downgrade full magnetic-object wireframe to surface edges when volume edges are unavailable", () => {
    const surfaceEdges = new Uint32Array([0, 1, 1, 2]);
    const partModel = {
      edgeIndices: surfaceEdges,
      volumeEdgeIndices: null,
    };

    expect(resolveMeshPartWireframeEdgeIndices("full", partModel)).toBeNull();
    expect(resolveMeshPartWireframeEdgeIndices("surface", partModel)).toBe(
      surfaceEdges,
    );
  });
});
