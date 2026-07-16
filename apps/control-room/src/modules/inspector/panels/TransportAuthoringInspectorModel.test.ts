import { describe, expect, it } from "vitest";

import {
  buildCurrentTransport,
  buildSpinTransport,
  currentTransportDraft,
  isKnownCurrentTransport,
  isKnownSpinTransport,
  readonlyTransportPayload,
  spinTransportDraft,
} from "./TransportAuthoringInspectorModel";

describe("transport authoring drafts", () => {
  it("round-trips every complete charge-transport field", () => {
    const resource = {
      kind: "current_transport" as const,
      model: "ohmic_poisson" as const,
      name: "charge",
      coupling: "bidirectional" as const,
      domain: [{ object_id: "stack", region_id: "normal" }],
      materials: [{ region: { object_id: "stack", region_id: "normal" }, material: { sigma_Spm: 5.8e7 } }],
      boundaries: [{ id: "left", kind: "voltage_electrode" as const, potential_V: 0.1, surfaces: [{ object_id: "stack", surface_id: "x_min", orientation: [-1, 0, 0] }] }],
      gauge: "dirichlet_reference" as const,
      solver: { engine: "cg", linear: { relative_tolerance: 1e-10, absolute_tolerance: 1e-14, max_iterations: 123 }, operator_version: "charge.v1", physical_residual_version: "balance.v1" },
      solve_region: "legacy",
      conductivity_s_per_m: 12,
    };
    expect(buildCurrentTransport(currentTransportDraft(resource))).toEqual(resource);
  });

  it("round-trips every spin-transport field including requested execution", () => {
    const resource = {
      schema_version: "spin_transport.v1",
      id: "spin",
      current_source_id: "charge",
      mode: "steady" as const,
      domain: [{ object_id: "stack", region_id: "normal" }],
      materials: [{ region: { object_id: "stack", region_id: "normal" }, material: { sigma_s_Spm: 2, polarization_p: 0.4, theta_sh: 0.1, lambda_sf_m: 1e-9, lambda_j_m: 2e-9, lambda_phi_m: "disabled" as const } }],
      interfaces: [{ id: "nf", kind: "transparent" as const, side_a: { object_id: "stack", region_id: "normal" }, side_b: { object_id: "stack", region_id: "free" }, normal_a_to_b: [1, 0, 0] }],
      boundaries: [{ id: "sink", kind: "spin_sink" as const, surfaces: [{ object_id: "stack", surface_id: "x_max", orientation: [1, 0, 0] }] }],
      solver: { engine: "gmres", linear: { relative_tolerance: 1e-9, absolute_tolerance: 1e-13, max_iterations: 321 }, physical_residual_version: "spin.balance.v1", operator_version: "spin.v1", default_external_boundary: "spin_insulating" },
      requested_execution: { discretization: "fem" as const, device: "cpu" as const, precision: "double" as const, execution_mode: "extended" as const },
      constitutive_version: "constitutive.v1",
    };
    expect(buildSpinTransport(spinTransportDraft(resource))).toEqual(resource);
  });

  it("preserves transient spin capacitance provenance in every material assignment", () => {
    const draft = spinTransportDraft();
    draft.mode = "transient";
    draft.materials = JSON.stringify([{
      material: {
        capacitance_formula_version: "dos_constant.fullmag.v1",
        lambda_j_m: "disabled",
        lambda_phi_m: "disabled",
        lambda_sf_m: 1e-9,
        polarization_p: 0.4,
        sigma_s_Spm: 2,
        spin_capacitance_As_per_V_m3: 3.5,
        theta_sh: 0.1,
      },
      region: { object_id: "stack", region_id: "normal" },
    }]);

    expect(buildSpinTransport(draft)).toMatchObject({
      materials: [{ material: {
        capacitance_formula_version: "dos_constant.fullmag.v1",
        spin_capacitance_As_per_V_m3: 3.5,
      } }],
      mode: "transient",
    });
  });

  it("rejects transient materials without the paired capacitance fields", () => {
    const draft = spinTransportDraft();
    draft.mode = "transient";
    draft.materials = JSON.stringify([{
      material: {
        lambda_j_m: "disabled",
        lambda_phi_m: "disabled",
        lambda_sf_m: 1e-9,
        polarization_p: 0.4,
        sigma_s_Spm: 2,
        theta_sh: 0.1,
      },
      region: { object_id: "stack", region_id: "normal" },
    }]);

    expect(() => buildSpinTransport(draft)).toThrow(/transient mode requires spin_capacitance/);
  });

  it("classifies unknown records as read-only without rewriting payloads", () => {
    const unknown = { kind: "future", id: "future", nested: { raw: [1, 2, 3] } };
    expect(isKnownCurrentTransport(unknown)).toBe(false);
    expect(isKnownSpinTransport(unknown)).toBe(false);
    expect(JSON.parse(readonlyTransportPayload(unknown))).toEqual(unknown);
  });
});
