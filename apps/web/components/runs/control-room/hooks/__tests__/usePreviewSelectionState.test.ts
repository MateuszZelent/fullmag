import { describe, expect, it } from "vitest";

import { resolveCachedFieldQuantities } from "../usePreviewSelectionState";
import type { LatestFieldFrame, QuantityDescriptor } from "@/lib/session/types";

function quantity(
  id: string,
  dataAvailable: boolean,
): QuantityDescriptor {
  return {
    id,
    label: id,
    kind: "vector_field",
    unit: "",
    available: true,
    data_available: dataAvailable,
    location: "node",
    domain: "magnetic_only",
    n_comp: 3,
    normalization_hint: "unit_vector",
    interactive_preview: true,
    supports_preview_2d: true,
    supports_preview_3d: true,
    supports_history: false,
    supports_export: true,
    quick_access_label: id,
    scalar_metric_key: null,
    shape: "vector_field",
  };
}

function frame(quantityId: string, topologySignature: string | null): LatestFieldFrame {
  return {
    quantity_id: quantityId,
    unit: "",
    n_comp: 3,
    grid: [1, 1, 1],
    values: new Float64Array(0),
    active_mask: null,
    location: "node",
    domain: "magnetic_only",
    topology_signature: topologySignature,
    field_revision: 1,
    source_step: 1,
    source_time: null,
  };
}

describe("resolveCachedFieldQuantities", () => {
  it("treats resource-catalog data_available quantities as cached without raw frames", () => {
    const quantities = new Map([
      ["m", quantity("m", true)],
      ["H_demag", quantity("H_demag", true)],
      ["H_eff", quantity("H_eff", false)],
    ]);

    const cached = resolveCachedFieldQuantities({
      activeFemGenerationSignature: "gen:current",
      quantityDescriptorById: quantities,
      runtimeLatestFieldFrames: {},
    });

    expect([...cached].sort()).toEqual(["H_demag", "m"]);
  });

  it("keeps metadata-only latest field frames while rejecting stale FEM generations", () => {
    const cached = resolveCachedFieldQuantities({
      activeFemGenerationSignature: "gen:current",
      quantityDescriptorById: new Map(),
      runtimeLatestFieldFrames: {
        m: frame("m", "gen:current"),
        stale: frame("stale", "gen:old"),
        unscoped: frame("unscoped", null),
      },
    });

    expect([...cached].sort()).toEqual(["m", "unscoped"]);
  });
});
