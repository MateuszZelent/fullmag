import { describe, expect, it } from "vitest";

import type { PlanarFieldMetaResource } from "../../../kernel/api/apiTypes";
import { validateCoherentPlanarBundle } from "./coherentPlanarBundle";

describe("coherentPlanarBundle", () => {
  const mockMeta: PlanarFieldMetaResource = {
    carrier_revision: "10",
    component: "magnitude",
    field_revision: "20",
    generation_id: "gen-1",
    links: {
      empty_mask: "/mask",
      mesh_overlay: "/mesh",
      probe: "/probe",
      render_png: "/png",
      scalar: "/scalar",
      vectors: "/vectors",
    },
    mesh_revision: "5",
    meta: {
      basis_order: 1,
      bounds_uv_m: [0, 1, 0, 1],
      empty_count: 0,
      fold_count: 0,
      integration_order: 1,
      non_injective: false,
      occupied_count: 4,
      occupied_measure: 1,
      overlap_count: 0,
      partial_count: 0,
      resolution: [2, 2],
      sampler_version: "v1",
      sampling_method: "fem_plane",
    },
    occupancy: {
      empty_count: 0,
      fold_count: 0,
      non_injective: false,
      occupied_count: 4,
      occupied_measure: 1,
      overlap_count: 0,
      partial_count: 0,
    },
    quantity_id: "m",
    sample_token: "planar-sample-v3:test-token",
    scene_revision: "1",
    source: {
      default_slice_plane: "xy",
      default_slice_position_fraction: 0.5,
      default_slice_revision: "1",
      kind: "default",
      operator: { operator: "plane_sample" },
      source_revision: "1",
    },
    unit: "A/m",
  };

  it("validates successfully when mandatory scalar and mask match resolution", () => {
    // 2x2 = 4 elements
    const scalarBuffer = new Float64Array([1, 2, 3, 4]).buffer;
    const maskBuffer = new Uint8Array([1, 1, 1, 1]).buffer;

    const res = validateCoherentPlanarBundle(mockMeta, scalarBuffer, maskBuffer);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.bundle.isScientificReady).toBe(true);
      expect(res.bundle.sampleToken).toBe("planar-sample-v3:test-token");
      expect(res.bundle.resolution).toEqual([2, 2]);
      expect(res.bundle.scalarData.length).toBe(4);
      expect(res.bundle.maskData.length).toBe(4);
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
});
