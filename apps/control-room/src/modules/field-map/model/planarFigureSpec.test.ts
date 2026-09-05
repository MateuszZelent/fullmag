import { describe, expect, it } from "vitest";

import {
  buildPlanarExportManifest,
  createPlanarFigureSpec,
  deserializePlanarFigureSpec,
  serializePlanarFigureSpec,
} from "./planarFigureSpec";
import type { FieldMapRenderModel } from "./fieldMapRenderModel";

const mockModel: FieldMapRenderModel = {
  bounds: [0, 10, 0, 5],
  boundsCenter: [5, 2.5],
  boundsOutline: [0, 10, 0, 5],
  canonicalUnit: "A/m",
  colormap: "viridis",
  component: "magnitude",
  diagnostics: [],
  display: {
    axisUnit: "m",
    legendUnit: "kA/m",
    probeScale: 0.001,
  },
  frame: {
    normal: [0, 0, 1],
    origin: [0, 0, 0],
    uAxis: [1, 0, 0],
    vAxis: [0, 1, 0],
  },
  interaction: {
    panU: 1,
    panV: -2,
    zoom: 1.5,
  },
  layers: {
    boundaries: true,
    bounds: true,
    contours: false,
    mesh: true,
    points: false,
    probes: true,
    raster: true,
    vectors: false,
  },
  mask: new Uint8Array([0, 0, 0, 0]),
  meshOverlay: null,
  meshOverlayDescriptor: undefined,
  pointStyle: { color: "var(--fm-accent)", opacity: 1, size: 3 },
  range: { max: 1000, min: 0 },
  rasterOpacity: 0.9,
  resolution: [2, 2],
  sampleIdentity: '"fm-planar-sha256:test"',
  samplePoints: [],
  scalar: new Float32Array([100, 200, 300, 400]),
  vectors: null,
  vectorBudget: 100,
  vectorScale: 1,
  vectorStyle: { color: "currentColor", colorMode: "orientation", lengthMode: "uniform", opacity: 1, thickness: 1 },
  viewport: [0, 10, 0, 5],
  wireframeStyle: { color: "currentColor", opacity: 0.5 },
};

describe("planar figure spec", () => {
  it("creates a pinned figure spec matching the render model", () => {
    const spec = createPlanarFigureSpec(mockModel, {
      dpi: 300,
      fieldRevision: "rev-42",
      quantityId: "m",
    });

    expect(spec.sampleIdentity).toBe('"fm-planar-sha256:test"');
    expect(spec.fieldRevision).toBe("rev-42");
    expect(spec.quantityId).toBe("m");
    expect(spec.colormap).toBe("viridis");
    expect(spec.range).toEqual({ max: 1000, min: 0, mode: "auto" });
    expect(spec.camera).toEqual({ panU: 1, panV: -2, zoom: 1.5 });
    expect(spec.layers.mesh).toBe(true);
    expect(spec.layers.contours).toBe(false);
  });

  it("serializes and deserializes cleanly without losing precision or fields", () => {
    const spec = createPlanarFigureSpec(mockModel, {
      dpi: 600,
      fieldRevision: "rev-99",
      quantityId: "h_demag",
    });
    const serialized = serializePlanarFigureSpec(spec);
    const deserialized = deserializePlanarFigureSpec(serialized);

    expect(deserialized).toEqual(spec);
  });

  it("builds an export reproducibility manifest with metadata sidecar", () => {
    const spec = createPlanarFigureSpec(mockModel, {
      fieldRevision: "rev-1",
      quantityId: "m",
    });
    const fixedDate = "2026-09-05T20:00:00.000Z";
    const manifest = buildPlanarExportManifest(spec, fixedDate);

    expect(manifest.schemaVersion).toBe("fullmag.planar-figure-manifest.v1");
    expect(manifest.samplerVersion).toBe("fullmag-planar-sampling.v2");
    expect(manifest.exportedAt).toBe(fixedDate);
    expect(manifest.revisions.sampleIdentity).toBe('"fm-planar-sha256:test"');
    expect(manifest.revisions.fieldRevision).toBe("rev-1");
    expect(manifest.datasetSpec.physicalBoundsM).toEqual([0, 10, 0, 5]);
    expect(manifest.datasetSpec.units.canonical).toBe("A/m");
    expect(manifest.datasetSpec.units.display).toBe("kA/m");
  });
});
