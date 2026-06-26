import { describe, expect, it } from "vitest";

import type { TopologicalChargeResource } from "@/kernel/api/apiTypes";

import { resolveTopologicalChargePanelModel } from "./topologicalChargeModel";

const readyResource: TopologicalChargeResource = {
  charge: -0.9823412,
  computed_at_unix_ms: 1_772_000_000_000,
  domain_generation_id: "domain-7",
  field_revision: 42,
  integer_error: 0.0176588,
  mesh_generation_id: "mesh-gen-9",
  mesh_revision: 17,
  method: "berg-luscher",
  nearest_integer: -1,
  object_id: "permalloy_ring",
  plane: "auto",
  polarity: "negative",
  quantity_id: "m",
  revision: 91,
  sample_count: 4096,
  sample_grid: {
    nx: 64,
    ny: 64,
    plane: "xy",
  },
  status: "ready",
  valid_sample_count: 4088,
  warnings: [
    {
      code: "mesh_surface_incomplete",
      message: "Object surface has missing faces; volume slice was used.",
    },
  ],
};

describe("topologicalChargeModel", () => {
  it("formats a ready topological charge result with provenance and warnings", () => {
    expect(resolveTopologicalChargePanelModel("ready", readyResource)).toEqual({
      banner: {
        kind: "warning",
        message: "Object surface has missing faces; volume slice was used.",
      },
      rows: [
        { label: "Object", value: "permalloy_ring" },
        { label: "Fetch state", value: "ready" },
        { label: "Status", value: "ready" },
        { label: "Quantity", value: "m" },
        { label: "Q", value: "-0.982341" },
        { label: "Nearest integer", value: "-1" },
        { label: "Integer error", value: "0.017659" },
        { label: "Polarity", value: "negative" },
        { label: "Sampling", value: "xy 64 x 64, 4088/4096 valid" },
        { label: "Method", value: "berg-luscher" },
        { label: "Field revision", value: "42" },
        { label: "Mesh revision", value: "17" },
        { label: "Domain generation", value: "domain-7" },
        { label: "Mesh generation", value: "mesh-gen-9" },
      ],
    });
  });

  it("renders missing resources without pretending a charge is available", () => {
    expect(resolveTopologicalChargePanelModel("loading", null)).toEqual({
      banner: undefined,
      rows: [
        { label: "Object", value: "none" },
        { label: "Fetch state", value: "loading" },
        { label: "Status", value: "loading" },
        { label: "Quantity", value: "m" },
        { label: "Q", value: "unavailable" },
        { label: "Nearest integer", value: "unavailable" },
        { label: "Integer error", value: "unavailable" },
        { label: "Polarity", value: "unavailable" },
        { label: "Sampling", value: "unavailable" },
        { label: "Method", value: "unavailable" },
        { label: "Field revision", value: "unavailable" },
        { label: "Mesh revision", value: "unavailable" },
        { label: "Domain generation", value: "unavailable" },
        { label: "Mesh generation", value: "unavailable" },
      ],
    });
  });

  it("uses an error banner for non-ready analysis statuses", () => {
    expect(
      resolveTopologicalChargePanelModel("ready", {
        ...readyResource,
        charge: null,
        integer_error: null,
        nearest_integer: null,
        sample_grid: null,
        status: "insufficient_samples",
        warnings: [],
      }).banner,
    ).toEqual({
      kind: "warning",
      message: "Topological charge status: insufficient samples.",
    });
  });
});
