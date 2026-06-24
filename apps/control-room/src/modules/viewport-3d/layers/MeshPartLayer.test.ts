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
    expect(source).toContain("useViewport3DScalarShaderColorUpload");
    expect(source).toContain("field-scalar-shader");
    expect(source).toContain("<primitive attach=\"material\" object={scalarShaderMaterial} />");
    expect(source).not.toContain("applyScalarShaderColorBuffer");
  });

  it("lets diagnostics bypass field-color buffer application without hiding surfaces", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./MeshPartLayer.tsx", import.meta.url)),
      "utf8",
    );

    expect(source).toContain("viewport3DFieldColorLayersEnabledFromBrowserConfig");
    expect(source).toContain("fieldColorLayersEnabled");
    expect(source).toContain("useViewport3DScalarShaderColorUpload");
    expect(source).toContain("field-scalar-shader");
    expect(source).not.toContain("applyScalarShaderColorBuffer");
  });

  it("uses unlit materials for mesh part fallback surfaces", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./MeshPartLayer.tsx", import.meta.url)),
      "utf8",
    );

    expect(source).toContain("<meshBasicMaterial");
    expect(source).not.toContain("<meshStandardMaterial");
    expect(source).not.toContain("MeshStandardMaterial");
    expect(source).not.toContain("computeVertexNormals");
  });

  it("does not suppress hidden full-volume wireframe behind a shaded magnetic surface", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./MeshPartLayer.tsx", import.meta.url)),
      "utf8",
    );

    expect(source).toContain(
      "renderSettings.wireframeVisible && renderSettings.shaderVisible && edgeGeometry",
    );
    expect(source).not.toContain(
      'renderSettings.geometryScope !== "full" && edgeGeometry',
    );
  });

  it("uses target visibility as the master display gate for mesh-backed parts", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./MeshPartLayer.tsx", import.meta.url)),
      "utf8",
    );

    expect(source).toContain(
      "if (!geometry || !renderSettings.visible || !hasAnyVisibleSubLayer) return null;",
    );
    expect(source).not.toContain(
      "(!renderSettings.visible && !hasAnyVisibleSubLayer)",
    );
  });

  it("does not build point geometry when mesh-backed points are hidden", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./MeshPartLayer.tsx", import.meta.url)),
      "utf8",
    );

    expect(source).toContain("if (!renderSettings.pointsVisible) return null;");
  });

  it("routes mesh part topology geometry adoption through the GPU upload manager", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./MeshPartLayer.tsx", import.meta.url)),
      "utf8",
    );
    const componentSource = source.slice(
      source.indexOf("export const MeshPartLayer"),
    );

    expect(source).toContain("useViewport3DGeometryUpload");
    expect(source).toContain('lane: "topology-index"');
    expect(componentSource).not.toContain("const geometry = useMemo");
    expect(componentSource).not.toContain("const edgeGeometry = useMemo");
    expect(componentSource).not.toContain("const pointGeometry = useMemo");
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

  it("does not touch edge buffers when magnetic-object wireframe is hidden", () => {
    const partModel = {
      get edgeIndices(): Uint32Array {
        throw new Error("surface edges should not be read");
      },
      get volumeEdgeIndices(): Uint32Array {
        throw new Error("volume edges should not be read");
      },
    };

    expect(
      resolveMeshPartWireframeEdgeIndices("full", partModel, false),
    ).toBeNull();
    expect(
      resolveMeshPartWireframeEdgeIndices("surface", partModel, false),
    ).toBeNull();
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
