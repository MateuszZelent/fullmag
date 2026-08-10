import { describe, expect, it } from "vitest";

import type { FdmMultilayerLayoutResource } from "@/kernel/api/apiTypes";

import { resolveFdmMultilayerAirboxTargetInspectorModel } from "./fdmMultilayerAirboxTargetInspectorModel";

const layout = {
  airbox: {
    carrier_available: true,
    carrier_fingerprint:
      "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    carrier_revision: 8,
    cell_size_m: [2e-9, 3e-9, 4e-9],
    cells: [5, 4, 3],
    h_demag_available: true,
    h_eff_available: false,
    h_eff_unavailable_reason: "airbox_heff_not_available_v1",
    origin_m: [-4e-9, -6e-9, -8e-9],
    sample_count: 60,
    source_grid_fingerprints: ["sha256:native-a", "sha256:native-b"],
    source_policy: "target_only",
    source_runtime_identity: { backend: "fdm_cpu_reference", precision: "double" },
    target_only: true,
    value_count: 180,
  },
  available: true,
  backend: "fdm_multilayer",
  domain_generation_id: "generation-7",
  execution_revision: 3,
  layers: [],
  layout_revision: 5,
  observation_revision: 6,
  schema_version: "fdm-multilayer-layout.v1",
} satisfies FdmMultilayerLayoutResource;

describe("FDM multilayer Airbox target inspector model", () => {
  it("exposes target-grid, field capability, and carrier provenance without the common FFT grid", () => {
    const model = resolveFdmMultilayerAirboxTargetInspectorModel(layout);

    expect(model.status).toBe("ready");
    if (model.status !== "ready") throw new Error("Expected a published target-only Airbox carrier");
    expect(model.targetGridRows).toEqual([
      { label: "Target-only", value: "yes" },
      { label: "Cells", value: "[5, 4, 3]" },
      { label: "Origin", value: "[-4e-9, -6e-9, -8e-9]", unit: "m" },
      { label: "Cell size", value: "[2e-9, 3e-9, 4e-9]", unit: "m" },
      { label: "Samples", value: "60" },
      { label: "Values", value: "180" },
    ]);
    expect(model.fieldCapabilityRows).toEqual([
      { label: "H_demag", value: "available" },
      { label: "H_eff", value: "unavailable (airbox_heff_not_available_v1)" },
    ]);
    expect(model.provenanceRows).toEqual(expect.arrayContaining([
      { label: "Carrier fingerprint", value: layout.airbox.carrier_fingerprint, mono: true },
      { label: "Runtime", value: '{"backend":"fdm_cpu_reference","precision":"double"}', mono: true },
    ]));
    expect(JSON.stringify(model)).not.toContain("common_transform_layout");
  });

  it("fails closed when the carrier cannot support the exact target grid", () => {
    const model = resolveFdmMultilayerAirboxTargetInspectorModel({
      ...layout,
      airbox: { ...layout.airbox, sample_count: 59 },
    });

    expect(model).toEqual({
      notice: "Target-only Airbox carrier is not published or failed validation.",
      status: "unavailable",
    });
  });

  it("fails closed when a target-only carrier incorrectly claims H_eff", () => {
    const model = resolveFdmMultilayerAirboxTargetInspectorModel({
      ...layout,
      airbox: {
        ...layout.airbox,
        h_eff_available: true,
        h_eff_unavailable_reason: null,
      },
    });

    expect(model).toEqual({
      notice: "Target-only Airbox carrier is not published or failed validation.",
      status: "unavailable",
    });
  });
});
