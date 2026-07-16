import { describe, expect, it } from "vitest";

import {
  buildCurrentTransport,
  buildSpinTransport,
  currentTransportDraft,
  isKnownCurrentTransport,
  isKnownSpinTransport,
  readonlyTransportPayload,
  resolveTransportRecord,
  spinTransportDraft,
  transportSelectionKey,
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
      solver: { engine: "block_gmres", linear: { relative_tolerance: 1e-10, absolute_tolerance: 1e-14, max_iterations: 123 }, operator_version: "fdm_coupled_charge_spin_fv_block_gmres.v1", physical_residual_version: "transport_balance_integrated_l2.v1" },
      solve_region: "legacy",
      conductivity_s_per_m: 12,
    };
    expect(isKnownCurrentTransport(resource)).toBe(true);
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
      solver: { engine: "gmres", linear: { relative_tolerance: 1e-9, absolute_tolerance: 1e-13, max_iterations: 321 }, physical_residual_version: "transport_balance_integrated_l2.v1", operator_version: "fv_spin_upwind_v1", default_external_boundary: "spin_insulating" },
      requested_execution: { discretization: "fem" as const, device: "cpu" as const, precision: "double" as const, execution_mode: "extended" as const },
      constitutive_version: "transport_constitutive.one_way.fullmag.v1",
    };
    expect(isKnownSpinTransport(resource)).toBe(true);
    expect(isKnownSpinTransport({
      ...resource,
      constitutive_version: "transport_constitutive.reciprocal.fullmag.v1",
      solver: {
        ...resource.solver,
        operator_version: "fdm_coupled_charge_spin_fv_block_gmres.v1",
      },
    })).toBe(true);
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

  it("fails closed for a future current model that otherwise matches the known shape", () => {
    const future = {
      coupling: "one_way",
      current_density: [1, 2, 3],
      future_solver_metadata: { exact: ["keep", 7] },
      kind: "current_transport",
      model: "magnetoresistive_poisson.v2",
      name: "future-charge",
    };

    expect(isKnownCurrentTransport(future)).toBe(false);
    expect(JSON.parse(readonlyTransportPayload(future))).toEqual(future);
  });

  it("fails closed for future constitutive and operator versions in a known spin schema", () => {
    const future = {
      boundaries: [],
      constitutive_version: "transport_constitutive.future.fullmag.v2",
      current_source_id: "charge",
      domain: [],
      id: "future-spin",
      interfaces: [],
      materials: [],
      mode: "steady",
      requested_execution: {
        device: "cpu",
        discretization: "fdm",
        execution_mode: "strict",
        precision: "double",
      },
      schema_version: "spin_transport.v1",
      solver: {
        default_external_boundary: "spin_insulating",
        engine: "gmres",
        linear: { absolute_tolerance: 1e-12, max_iterations: 10, relative_tolerance: 1e-8 },
        operator_version: "v2",
        physical_residual_version: "v2",
      },
    };

    expect(isKnownSpinTransport(future)).toBe(false);
    expect(JSON.parse(readonlyTransportPayload(future))).toEqual(future);
  });

  it("accepts only the canonical mixing absorption and formula versions", () => {
    const mixing = {
      absorption: "full_absorption",
      ferromagnet_side: { object_id: "stack", region_id: "free" },
      formula_version: "magnetoelectronic.fullmag.v1",
      g_down_Spm2: 2,
      g_i_Spm2: 3,
      g_r_Spm2: 4,
      g_sml_Spm2: 5,
      g_up_Spm2: 6,
      id: "nf",
      kind: "mixing_conductance",
      normal_side: { object_id: "stack", region_id: "normal" },
      normal_to_ferromagnet: [1, 0, 0],
    };
    const resource = {
      boundaries: [],
      constitutive_version: "transport_constitutive.one_way.fullmag.v1",
      current_source_id: "charge",
      domain: [],
      id: "mixing-spin",
      interfaces: [mixing],
      materials: [],
      mode: "steady",
      requested_execution: {
        device: "cpu",
        discretization: "fdm",
        execution_mode: "strict",
        precision: "double",
      },
      schema_version: "spin_transport.v1",
      solver: {
        default_external_boundary: "spin_insulating",
        engine: "gmres",
        linear: { absolute_tolerance: 1e-12, max_iterations: 10, relative_tolerance: 1e-8 },
        operator_version: "fv_spin_upwind_v1",
        physical_residual_version: "transport_balance_integrated_l2.v1",
      },
    };

    expect(isKnownSpinTransport(resource)).toBe(true);
    expect(isKnownSpinTransport({
      ...resource,
      interfaces: [{ ...mixing, absorption: "partial_absorption.v2" }],
    })).toBe(false);
    expect(isKnownSpinTransport({
      ...resource,
      interfaces: [{ ...mixing, formula_version: "magnetoelectronic.fullmag.v2" }],
    })).toBe(false);
  });

  it("fails closed when generated required transport fields are incomplete", () => {
    expect(isKnownCurrentTransport({ kind: "current_transport", model: "prescribed_density" })).toBe(false);
    expect(isKnownSpinTransport({
      current_source_id: "charge",
      id: "partial",
      requested_execution: {},
      schema_version: "spin_transport.v1",
    })).toBe(false);
  });

  it("resolves a stable spin transport id before a stale list index", () => {
    const first = { id: "first", schema_version: "spin_transport.v1" };
    const selected = { id: "selected", schema_version: "spin_transport.v1" };

    expect(resolveTransportRecord("spin_transport", [first, selected], {
      resourceId: "selected",
      resourceIndex: 0,
    })).toBe(selected);
  });

  it("uses a positional identity only for genuinely id-less unknown records", () => {
    const first = { future_kind: "charge.v9", opaque: { value: 1 } };
    const second = { future_kind: "charge.v10", opaque: { value: 2 } };

    expect(transportSelectionKey("current_transport", first, 0)).toBe("position:0");
    expect(transportSelectionKey("current_transport", second, 1)).toBe("position:1");
    expect(resolveTransportRecord("current_transport", [first, second], {
      selectionKey: "position:1",
    })).toBe(second);
    expect(resolveTransportRecord("current_transport", [first, second], {
      resourceIndex: 0,
    })).toBe(first);
    expect(resolveTransportRecord("current_transport", [{ name: "stable" }, second], {
      resourceIndex: 0,
    })).toBeNull();
  });
});
