import { describe, expect, it } from "vitest";

import {
  resolveFieldMapCapabilities,
  resolvePlanarInspectorCapabilities,
} from "./fieldMapCapabilities";

describe("field-map capabilities", () => {
  it("returns stable reasons instead of enabled controls that do nothing", () => {
    expect(
      resolveFieldMapCapabilities({
        meshOverlayAvailable: false,
        spatial: false,
        vectorComponents: 0,
      }),
    ).toEqual({
      contours: { enabled: false, reasonCode: "quantity_not_spatial" },
      mesh: { enabled: false, reasonCode: "mesh_overlay_unavailable" },
      vectors: { enabled: false, reasonCode: "quantity_not_spatial" },
    });
  });
});

describe("planar inspector capabilities", () => {
  const quantity = { available: true, components: 3, location: "node" };

  it.each([
    ["exact", { available: true, boundaryClassification: "exact", codec: "fmcs.v4" }, "fem", { kind: "monitor_target" as const }, true, true, true],
    ["degraded", { available: true, boundaryClassification: "degraded_v3", codec: "fmcs.v4" }, "fem", { kind: "monitor_target" as const }, true, false, true],
    ["unavailable", { available: false, boundaryClassification: "exact", codec: "fmcs.v4" }, "fem", { kind: "monitor_target" as const }, false, false, true],
    ["wrong codec", { available: true, boundaryClassification: "exact", codec: "fmcs.v3" }, "fem", { kind: "monitor_target" as const }, false, false, true],
    ["FDM mesh part", { available: true, boundaryClassification: "exact", codec: "fmcs.v4" }, "fdm", { kind: "mesh_part" as const }, false, false, false],
  ] as const)("fails closed for %s descriptors and scope", (_name, descriptor, discretization, scope, mesh, boundaries, raster) => {
    const result = resolvePlanarInspectorCapabilities({
      descriptor,
      discretization,
      metaAvailable: true,
      occupancyAvailable: true,
      quantity,
      scopeKind: scope.kind,
    });

    expect(result.mesh.enabled).toBe(mesh);
    expect(result.boundaries.enabled).toBe(boundaries);
    expect(result.bounds.enabled).toBe(raster);
    expect(result.points.enabled).toBe(raster);
    expect(result.raster.enabled).toBe(raster);
  });

  it("fails closed for points until canonical metadata and occupancy are materialized", () => {
    const input = {
      descriptor: { available: true, boundaryClassification: "exact", codec: "fmcs.v4" },
      discretization: "fem",
      quantity,
      scopeKind: "monitor_target" as const,
    };
    expect(resolvePlanarInspectorCapabilities(input).points).toEqual({
      enabled: false,
      reasonCode: "planar_meta_unavailable",
    });
    expect(resolvePlanarInspectorCapabilities({ ...input, metaAvailable: true }).points).toEqual({
      enabled: false,
      reasonCode: "occupancy_mask_unavailable",
    });
    expect(resolvePlanarInspectorCapabilities({ ...input, metaAvailable: true }).bounds.enabled).toBe(true);
  });

  it("disables vectors for a scalar spatial quantity with a stable reason", () => {
    expect(
      resolvePlanarInspectorCapabilities({
        descriptor: { available: true, boundaryClassification: "exact", codec: "fmcs.v4" },
        discretization: "fem",
        metaAvailable: true,
        occupancyAvailable: true,
        quantity: { available: true, components: 1, location: "cell" },
        scopeKind: "monitor_target",
      }).vectors,
    ).toEqual({ enabled: false, reasonCode: "quantity_not_vector" });
  });
});
