import { describe, expect, it } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";

import {
  useFemGeometryMaterials,
  type FemGeometryMaterialParams,
} from "../useFemGeometryMaterials";

type HookArgs = Parameters<typeof useFemGeometryMaterials>[0];

function renderMaterialsHook(args: HookArgs): FemGeometryMaterialParams {
  let result: FemGeometryMaterialParams | null = null;

  function Probe() {
    result = useFemGeometryMaterials(args);
    return null;
  }

  renderToString(React.createElement(Probe));

  if (!result) {
    throw new Error("useFemGeometryMaterials did not render");
  }
  return result;
}

describe("useFemGeometryMaterials", () => {
  it("returns opaque surface policy when opacity=100 and no mesh edges", () => {
    const result = renderMaterialsHook({
      opacity: 100,
      highlight: false,
      showMeshEdges: false,
      hasFieldColormap: false,
    });

    expect(result.isTransparent).toBe(false);
    expect(result.opacityVal).toBe(1);
    // surfacePolicy must not be the transparent context variant
    expect(result.surfacePolicy.depthWrite).toBe(true);
  });

  it("uses transparent policy when opacity < 100", () => {
    const result = renderMaterialsHook({
      opacity: 50,
      highlight: false,
      showMeshEdges: false,
      hasFieldColormap: false,
    });

    expect(result.isTransparent).toBe(true);
    expect(result.opacityVal).toBeCloseTo(0.5);
  });

  it("forces transparent policy and clamps opacity when showMeshEdges=true", () => {
    const result = renderMaterialsHook({
      opacity: 100,
      highlight: false,
      showMeshEdges: true,
      hasFieldColormap: false,
    });

    expect(result.isTransparent).toBe(true);
    expect(result.opacityVal).toBeCloseTo(0.35);
  });

  it("resolves highlight edge color when highlight=true", () => {
    const result = renderMaterialsHook({
      opacity: 100,
      highlight: true,
      showMeshEdges: false,
      hasFieldColormap: false,
    });

    // default highlight color
    expect(result.resolvedEdgeColor).toBe("#67e8f9");
  });

  it("resolves custom edgeColor over uniformColor", () => {
    const result = renderMaterialsHook({
      opacity: 100,
      highlight: false,
      uniformColor: "#ff0000",
      edgeColor: "#00ff00",
      showMeshEdges: false,
      hasFieldColormap: false,
    });

    expect(result.resolvedEdgeColor).toBe("#00ff00");
  });

  it("uses gray edge color when field colormap is active (no explicit edgeColor)", () => {
    const result = renderMaterialsHook({
      opacity: 100,
      highlight: false,
      showMeshEdges: false,
      hasFieldColormap: true,
    });

    expect(result.resolvedEdgeColor).toBe("#d1d5db");
  });

  it("exposes all required policy references", () => {
    const result = renderMaterialsHook({
      opacity: 100,
      highlight: false,
      showMeshEdges: false,
      hasFieldColormap: false,
    });

    expect(result.edgePolicy).toBeDefined();
    expect(result.hiddenEdgePolicy).toBeDefined();
    expect(result.pointPolicy).toBeDefined();
    expect(result.selectionEdgePolicy).toBeDefined();
  });
});
