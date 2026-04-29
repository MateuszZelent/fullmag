import { describe, expect, it } from "vitest";
import {
  collectFemViewportSharedColorFields,
  femViewportLayerColorFieldsKey,
  type FemViewportRenderLayer,
} from "../FemViewportScene";

function layer(id: string, colorField: FemViewportRenderLayer["viewState"]["colorField"]): FemViewportRenderLayer {
  return {
    part: { id, role: "magnetic_object" },
    viewState: { colorField } as FemViewportRenderLayer["viewState"],
    boundaryFaceIndices: null,
    elementIndices: null,
    surfaceFaces: null,
    isSelected: false,
    meshColor: "#ffffff",
    edgeColor: "#ffffff",
  };
}

describe("FemViewportScene shared color fields", () => {
  it("keys visible layers by color fields only", () => {
    expect(femViewportLayerColorFieldsKey([
      layer("a", "orientation"),
      layer("b", "x"),
    ])).toBe(femViewportLayerColorFieldsKey([
      layer("c", "orientation"),
      layer("d", "x"),
    ]));
  });

  it("deduplicates mesh-part color fields", () => {
    expect(
      collectFemViewportSharedColorFields({
        hasMeshParts: true,
        visibleLayers: [
          layer("a", "orientation"),
          layer("b", "x"),
          layer("c", "orientation"),
        ],
        airColorField: "none",
        magneticColorField: "magnitude",
        magneticVisibilityMode: "hide",
        quantityDomain: "magnetic_only",
      }),
    ).toEqual(["orientation", "x"]);
  });

  it("uses air and magnetic fields for non-part rendering", () => {
    expect(
      collectFemViewportSharedColorFields({
        hasMeshParts: false,
        visibleLayers: [],
        airColorField: "quality",
        magneticColorField: "magnitude",
        magneticVisibilityMode: "hide",
        quantityDomain: "full_domain",
      }),
    ).toEqual(["quality", "magnitude"]);
  });

  it("uses neutral magnetic colors for ghost mode", () => {
    expect(
      collectFemViewportSharedColorFields({
        hasMeshParts: false,
        visibleLayers: [],
        airColorField: "quality",
        magneticColorField: "magnitude",
        magneticVisibilityMode: "ghost",
        quantityDomain: "full_domain",
      }),
    ).toEqual(["quality", "none"]);
  });
});
