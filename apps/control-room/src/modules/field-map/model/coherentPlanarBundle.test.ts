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

  it("validates successfully when mandatory scalar and mask match resolution and origins match", () => {
    // 2x2 = 4 elements
    const scalarBuffer = new Float64Array([1, 2, 3, 4]).buffer;
    const maskBuffer = new Uint8Array([1, 1, 1, 1]).buffer;

    const res = validateCoherentPlanarBundle(mockMeta, scalarBuffer, maskBuffer, null, {
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
});
