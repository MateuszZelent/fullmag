import { describe, expect, it } from "vitest";

import { navigatorFieldSweepFromResource } from "@/modules/results-navigator/public";

import { buildFrequencyDomainFieldSweepInspectorModel } from "./FrequencyDomainFieldSweepInspectorModel";

describe("FrequencyDomainFieldSweepInspectors", () => {
  it("projects typed counts, axis, topology and field availability for a selected sample", () => {
    const payload = navigatorFieldSweepFromResource({
      artifact_path: "eigen/field_sweep.v1.json",
      missing_reason: null,
      payload: {
        schema_version: "eigen/field_sweep.v1",
        requested_sample_count: 15,
        completed_sample_count: 15,
        scan_axis: {
          kind: "bias_field",
          coordinate: "bias_field_a_per_m",
          unit: "A/m",
          display_conversions: [{ name: "mu0_H", unit: "T", scale: 1.2566370614e-6 }],
        },
        samples: [{
          sample_id: "bias-field-sample-0007",
          sample_index: 7,
          bias_field_a_per_m: [47_000, 0, 0],
          bias_field_mu0_t: [0.059, 0, 0],
          branch_ids: [0, 2],
          modes: [{
            sample_id: "bias-field-sample-0007",
            mode_id: "sample-0007/mode-0000",
            raw_mode_index: 0,
            frequency_hz: 2e9,
            angular_frequency_rad_per_s: 4 * Math.PI * 1e9,
            mode_artifact_path: "eigen/modes/sample_0007/mode_0000.json",
            mode_field_id: "field-7-0",
            mode_field_resource_key: "data/fields/field-7-0",
            source_revision: "sha256:spectrum",
            status: "complete",
          }],
          topology: {
            mesh_id: "mesh:test",
            topology_revision: "mesh-rev:7",
            indexing: "global_xyz",
            sample_axis: "sample",
            mode_axis: "mode",
            node_count: 4,
          },
          status: "complete",
        }],
        units: {
          frequency: "Hz",
          angular_frequency: "rad/s",
          bias_field: "A/m",
          bias_field_display: "T",
        },
        topology: {
          mesh_id: "mesh:test",
          topology_revision: "mesh-rev:7",
          indexing: "global_xyz",
          sample_axis: "sample",
          mode_axis: "mode",
          node_count: 4,
        },
      },
      resource_key: "analysis:eigen:field-sweep",
      revision: "sha256:field-sweep",
      schema_version: "eigen/field_sweep.v1",
      status: "ready",
    } as never);

    expect(payload).not.toBeNull();
    const model = buildFrequencyDomainFieldSweepInspectorModel(
      payload!,
      "bias-field-sample-0007",
    );

    expect(model).toMatchObject({
      axis: "bias_field / bias_field_a_per_m [A/m]",
      completedSamples: "15",
      fieldAvailability: "1/1 available",
      selectedCoordinates: "H=[47000, 0, 0] A/m; μ₀H=[0.059, 0, 0] T",
      selectedSample: "μ₀ Hx = 59.0 mT (bias-field-sample-0007)",
      sampleStatus: "complete",
      topology: "mesh:test / mesh-rev:7 / global_xyz",
      units: "H: A/m → T; f: Hz; ω: rad/s",
      requestedSamples: "15",
    });
    expect(model.conversions).toContain("mu0_H [T]");
  });
});
