import { describe, expect, it } from "vitest";

import { buildViewport3DVectorFieldModel } from "../useViewport3DVectorFieldModel";
import type { DecodedFieldVector } from "@/src/api/codecs/types";

function vector(overrides: Partial<DecodedFieldVector> = {}): DecodedFieldVector {
  return {
    quantityId: "m",
    nComp: 3,
    grid: [2, 2, 1],
    pointCount: 4,
    valueCount: 12,
    dtype: "float64",
    values: new Float64Array(12),
    ...overrides,
  };
}

describe("buildViewport3DVectorFieldModel", () => {
  it("builds ready vector state with deterministic sampled count", () => {
    const model = buildViewport3DVectorFieldModel({
      quantityId: "m",
      fieldRevision: 11,
      domainGenerationId: 7,
      colorComponent: "3D",
      vectorsVisible: true,
      vectorCapabilityEnabled: true,
      quantityComponentCount: 3,
      everyN: 2,
      maxGlyphs: 10,
      adapterPointCount: 4,
      field: vector(),
      loading: false,
      error: null,
    });

    expect(model.status).toBe("ready");
    expect(model.directionComponent).toBe("full");
    expect(model.pointCount).toBe(4);
    expect(model.sampledCount).toBe(2);
  });

  it("reports unsupported scalar quantities without pretending glyphs are ready", () => {
    const model = buildViewport3DVectorFieldModel({
      quantityId: "E_total",
      fieldRevision: 11,
      domainGenerationId: 7,
      colorComponent: "|v|",
      vectorsVisible: true,
      vectorCapabilityEnabled: true,
      quantityComponentCount: 1,
      everyN: 1,
      field: null,
      loading: false,
      error: null,
    });

    expect(model.status).toBe("unsupported");
    expect(model.error).toContain("at least 3 components");
  });

  it("preserves explicit unsupported reasons from the renderer bridge", () => {
    const model = buildViewport3DVectorFieldModel({
      quantityId: "m",
      fieldRevision: 11,
      domainGenerationId: 7,
      colorComponent: "3D",
      vectorsVisible: true,
      vectorCapabilityEnabled: false,
      unsupportedReason: "FEM 3D glyph renderer is not implemented yet.",
      quantityComponentCount: 3,
      everyN: 1,
      field: null,
      loading: false,
      error: null,
    });

    expect(model.status).toBe("unsupported");
    expect(model.error).toBe("FEM 3D glyph renderer is not implemented yet.");
  });

  it("reports point-count mismatch as a first-class diagnostic state", () => {
    const model = buildViewport3DVectorFieldModel({
      quantityId: "m",
      fieldRevision: 11,
      domainGenerationId: 7,
      colorComponent: "x",
      vectorsVisible: true,
      vectorCapabilityEnabled: true,
      quantityComponentCount: 3,
      everyN: 1,
      adapterPointCount: 5,
      field: vector(),
      loading: false,
      error: null,
    });

    expect(model.status).toBe("mismatch");
    expect(model.error).toContain("field.pointCount=4");
    expect(model.error).toContain("adapterPointCount=5");
  });
});
