import { describe, expect, it } from "vitest";

import type { PlanarFieldMetaResource } from "../../../kernel/api/apiTypes";
import { validateCoherentPlanarBundle } from "./coherentPlanarBundle";

describe("coherentPlanarBundle", () => {
  const mockMeta: PlanarFieldMetaResource = {
    basis_order: 1,
    canonical_unit: "A/m",
    carrier_revision: "10",
    component: "magnitude",
    etag: "mock-etag",
    field_revision: "20",
    field_source: "fdm",
    fold_count: 0,
    frame: {
      bounds_uv_m: [0, 1, 0, 1],
      normal: [0, 0, 1],
      origin_m: [0, 0, 0],
      u_axis: [1, 0, 0],
      v_axis: [0, 1, 0],
    },
    generation_id: "gen-1",
    integration_order: 1,
    links: {
      empty_mask: "/mask",
      mesh_overlay: "/mesh",
      probe: "/probe",
      render_png: "/png",
      scalar: "/scalar",
      vectors: "/vectors",
    },
    mesh_overlay_descriptor: {
      available: false,
      boundary_classification: "none",
      geometry_source: "none",
    },
    mesh_revision: "5",
    non_injective: false,
    occupancy: {
      empty: 0,
      occupied: 4,
      occupied_measure: 1,
      partial: 0,
    },
    operator: { kind: "plane_sample" },
    overlap_count: 0,
    pixel_size_m: [0.5, 0.5],
    quantity_id: "m",
    resolution: [2, 2],
    sample_support: "cut_surface",
    sample_token: "planar-sample-v3:test-token",
    sampler_version: "v1",
    sampling_execution: "gpu",
    sampling_method: "fem_plane",
    scene_revision: "1",
    schema_version: "2.0.0",
    scope_kind: "all",
    source: {
      kind: "default",
      default_slice_hash: "xy",
      default_slice_revision: "1",
      domain_generation_id: "gen-1",
    },
  };

  function makeTestFmvp({
    grid = [2, 2, 1] as [number, number, number],
    nComp = 1,
    quantityId = "m",
    values = [1, 2, 3, 4],
  }: {
    grid?: [number, number, number];
    nComp?: number;
    quantityId?: string;
    values?: number[];
  } = {}): ArrayBuffer {
    const buffer = new ArrayBuffer(48 + values.length * 8);
    const view = new DataView(buffer);
    for (const [index, code] of [..."FMVP"].entries()) {
      view.setUint8(index, code.charCodeAt(0));
    }
    view.setUint8(4, 2);
    view.setUint8(5, 1);
    view.setUint8(6, nComp);
    view.setUint32(12, values.length, true);
    view.setUint32(16, grid[0], true);
    view.setUint32(20, grid[1], true);
    view.setUint32(24, grid[2], true);
    new TextEncoder().encodeInto(quantityId, new Uint8Array(buffer, 28, 16));
    new Float64Array(buffer, 48).set(values);
    return buffer;
  }

  it("validates successfully when mandatory scalar and mask match resolution, but headerless scalar is NOT scientific ready (TS10)", () => {
    // 2x2 = 4 elements
    const scalarBuffer = new Float64Array([1, 2, 3, 4]).buffer;
    const maskBuffer = new Uint8Array([1, 1, 1, 1]).buffer;

    const res = validateCoherentPlanarBundle(mockMeta, scalarBuffer, maskBuffer, null, {
      scalarToken: mockMeta.sample_token,
      maskToken: mockMeta.sample_token,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.bundle.isScientificReady).toBe(false); // TS10: headerless is not scientific ready
      expect(res.bundle.sampleToken).toBe("planar-sample-v3:test-token");
      expect(res.bundle.resolution).toEqual([2, 2]);
      expect(res.bundle.scalarData.length).toBe(4);
      expect(res.bundle.maskData.length).toBe(4);
    }
  });

  it("marks isScientificReady as true when scalar is FMVP and origins match (TS10)", () => {
    const fmvpBuffer = makeTestFmvp();
    const maskBuffer = new Uint8Array([1, 1, 1, 1]).buffer;

    const res = validateCoherentPlanarBundle(mockMeta, fmvpBuffer, maskBuffer, null, {
      scalarToken: mockMeta.sample_token,
      maskToken: mockMeta.sample_token,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.bundle.isScientificReady).toBe(true);
      expect(res.bundle.sampleToken).toBe("planar-sample-v3:test-token");
      expect(res.bundle.resolution).toEqual([2, 2]);
      expect(res.bundle.scalarData.length).toBe(4);
      expect(res.bundle.maskData.length).toBe(4);
    }
  });

  it("marks isScientificReady as false when buffer origins are omitted (TS04)", () => {
    const scalarBuffer = new Float64Array([1, 2, 3, 4]).buffer;
    const maskBuffer = new Uint8Array([1, 1, 1, 1]).buffer;

    const res = validateCoherentPlanarBundle(mockMeta, scalarBuffer, maskBuffer);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.bundle.isScientificReady).toBe(false);
    }
  });

  it("rejects when mask is missing (scientific integrity requirement)", () => {
    const scalarBuffer = new Float64Array([1, 2, 3, 4]).buffer;
    const res = validateCoherentPlanarBundle(mockMeta, scalarBuffer, null);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("missing_mandatory_mask");
    }
  });

  it("rejects when scalar buffer length does not match resolution", () => {
    // only 3 elements instead of 4
    const scalarBuffer = new Float64Array([1, 2, 3]).buffer;
    const maskBuffer = new Uint8Array([1, 1, 1, 1]).buffer;

    const res = validateCoherentPlanarBundle(mockMeta, scalarBuffer, maskBuffer);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain("scalar_buffer_size_mismatch");
    }
  });

  it("rejects when mask length does not match resolution", () => {
    const scalarBuffer = new Float64Array([1, 2, 3, 4]).buffer;
    const maskBuffer = new Uint8Array([1, 1, 1]).buffer; // 3 instead of 4

    const res = validateCoherentPlanarBundle(mockMeta, scalarBuffer, maskBuffer);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain("mask_buffer_size_mismatch");
    }
  });

  it("rejects empty sample token (TS04)", () => {
    const scalarBuffer = new Float64Array([1, 2, 3, 4]).buffer;
    const maskBuffer = new Uint8Array([1, 1, 1, 1]).buffer;
    const res = validateCoherentPlanarBundle(
      { ...mockMeta, sample_token: "" },
      scalarBuffer,
      maskBuffer,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("missing_sample_token");
    }
  });

  it("rejects zero or non-positive resolution", () => {
    const res = validateCoherentPlanarBundle(
      { ...mockMeta, resolution: [0, 0] },
      new ArrayBuffer(0),
      new ArrayBuffer(0),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain("invalid_resolution");
    }
  });

  it("rejects invalid or missing bounds", () => {
    const scalarBuffer = new Float64Array([1, 2, 3, 4]).buffer;
    const maskBuffer = new Uint8Array([1, 1, 1, 1]).buffer;
    const res = validateCoherentPlanarBundle(
      { ...mockMeta, frame: { ...mockMeta.frame, bounds_uv_m: [0, 1] as unknown as [number, number, number, number] } },
      scalarBuffer,
      maskBuffer,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("invalid_bounds");
    }
  });

  it("rejects non-integer fractional resolution (TS06)", () => {
    const res = validateCoherentPlanarBundle(
      { ...mockMeta, resolution: [2.5, 2] },
      new ArrayBuffer(0),
      new ArrayBuffer(0),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain("invalid_resolution");
    }
  });

  it("rejects non-strictly-increasing reversed bounds (TS05)", () => {
    const scalarBuffer = new Float64Array([1, 2, 3, 4]).buffer;
    const maskBuffer = new Uint8Array([1, 1, 1, 1]).buffer;
    const res = validateCoherentPlanarBundle(
      {
        ...mockMeta,
        frame: {
          ...mockMeta.frame,
          bounds_uv_m: [1, 0, 0, 1], // reversed u min > max
        },
      },
      scalarBuffer,
      maskBuffer,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("invalid_bounds");
    }
  });

  it("rejects buffer origin token mismatch (TS03)", () => {
    const scalarBuffer = new Float64Array([1, 2, 3, 4]).buffer;
    const maskBuffer = new Uint8Array([1, 1, 1, 1]).buffer;
    const res = validateCoherentPlanarBundle(
      mockMeta,
      scalarBuffer,
      maskBuffer,
      null,
      { scalarToken: "other-origin-token" },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain("identity_mismatch");
    }
  });

  it("rejects FMVP scalar payload with mismatched quantityId (TS07)", () => {
    const fmvpBuffer = makeTestFmvp({ quantityId: "H_eff" }); // meta expects "m"
    const maskBuffer = new Uint8Array([1, 1, 1, 1]).buffer;
    const res = validateCoherentPlanarBundle(mockMeta, fmvpBuffer, maskBuffer);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain("quantity_mismatch");
    }
  });

  it("rejects FMVP scalar payload with mismatched grid shape (TS08)", () => {
    const fmvpBuffer = makeTestFmvp({ grid: [4, 1, 1] }); // meta expects [2, 2, 1]
    const maskBuffer = new Uint8Array([1, 1, 1, 1]).buffer;
    const res = validateCoherentPlanarBundle(mockMeta, fmvpBuffer, maskBuffer);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain("grid_shape_mismatch");
    }
  });

  it("rejects FMVP scalar payload with mismatched component count", () => {
    // 2x2 grid, but nComp = 3 (vector payload of 12 numbers instead of 4 scalars)
    const fmvpBuffer = makeTestFmvp({ grid: [2, 2, 1], nComp: 3, values: new Array(12).fill(1) });
    const maskBuffer = new Uint8Array([1, 1, 1, 1]).buffer;
    const res = validateCoherentPlanarBundle(mockMeta, fmvpBuffer, maskBuffer);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain("component_count_mismatch");
    }
  });

  it("rejects TS09 payload (1 point with 4 components instead of 2x2 scalars)", () => {
    const fmvpBuffer = makeTestFmvp({ grid: [1, 1, 1], nComp: 4, values: [1, 2, 3, 4] });
    const maskBuffer = new Uint8Array([1, 1, 1, 1]).buffer;
    const res = validateCoherentPlanarBundle(mockMeta, fmvpBuffer, maskBuffer);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain("grid_shape_mismatch");
    }
  });

  it("rejects occupancy mask with invalid code > 4 (TS09)", () => {
    const scalarBuffer = new Float64Array([1, 2, 3, 4]).buffer;
    const maskBuffer = new Uint8Array([1, 255, 1, 1]).buffer; // code 255 is invalid
    const res = validateCoherentPlanarBundle(mockMeta, scalarBuffer, maskBuffer);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain("invalid_occupancy_mask_code");
    }
  });

  it("rejects vectors FMVP with mismatched quantityId or component count", () => {
    const scalarBuffer = makeTestFmvp({ quantityId: "m" });
    const maskBuffer = new Uint8Array([1, 1, 1, 1]).buffer;
    // 2x2 grid with 3 components = 12 values
    const vectorsWrongQty = makeTestFmvp({
      grid: [2, 2, 1],
      nComp: 3,
      quantityId: "B_ext",
      values: new Array(12).fill(1),
    });
    const resWrongQty = validateCoherentPlanarBundle(mockMeta, scalarBuffer, maskBuffer, vectorsWrongQty);
    expect(resWrongQty.ok).toBe(false);
    if (!resWrongQty.ok) {
      expect(resWrongQty.reason).toContain("quantity_mismatch");
    }

    const vectorsWrongComp = makeTestFmvp({
      grid: [2, 2, 1],
      nComp: 1,
      quantityId: "m",
      values: [1, 2, 3, 4],
    });
    const resWrongComp = validateCoherentPlanarBundle(mockMeta, scalarBuffer, maskBuffer, vectorsWrongComp);
    expect(resWrongComp.ok).toBe(false);
    if (!resWrongComp.ok) {
      expect(resWrongComp.reason).toContain("component_count_mismatch");
    }
  });
});
