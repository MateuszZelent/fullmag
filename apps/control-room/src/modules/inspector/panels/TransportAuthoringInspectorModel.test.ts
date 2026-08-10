import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  buildCurrentTransport,
  buildSpinTransport,
  currentTransportDraft,
  currentTransportModelPatch,
  currentTransportSupportsPrescribedDensity,
  isKnownCurrentTransport,
  isKnownSpinTransport,
  readonlyTransportPayload,
  resolveTransportRecord,
  TRANSPORT_AUTHORING_DRAFT_INVENTORY,
  spinTransportDraft,
  transportIdentity,
  transportSelectionKey,
} from "./TransportAuthoringInspectorModel";

type ParityManifest = {
  parameters: Array<{
    family: string;
    round_trip: string;
    status: string;
    ui_field: string;
  }>;
};

function parityManifest(): ParityManifest {
  return JSON.parse(readFileSync(
    new URL("../../../../../../docs/specs/spin-transport-authoring-parameter-parity-v1.json", import.meta.url),
    "utf8",
  )) as ParityManifest;
}

describe("transport authoring drafts", () => {
  it("covers every current/spin manifest field with a typed or opaque draft key", () => {
    const manifest = parityManifest();
    for (const parameter of manifest.parameters.filter(({ family }) => family === "current_transport" || family === "spin_transport")) {
      if (parameter.status === "not_applicable" || parameter.ui_field.startsWith("not-exposed:")) continue;
      const inventory = TRANSPORT_AUTHORING_DRAFT_INVENTORY[parameter.family as "current_transport" | "spin_transport"];
      if (parameter.ui_field.startsWith("opaque:")) {
        expect(inventory.opaque).toContain(parameter.ui_field.slice("opaque:".length));
        expect(parameter.round_trip).toBe("preserve_and_reject");
      } else {
        expect(inventory.typed).toContain(parameter.ui_field);
      }
    }
  });

  it("round-trips every complete charge-transport field", () => {
    const resource = {
      kind: "current_transport" as const,
      model: "magnetoresistive_poisson" as const,
      name: " charge ",
      coupling: "bidirectional" as const,
      domain: [{ object_id: "stack", region_id: "normal" }],
      materials: [{ region: { object_id: "stack", region_id: "normal" }, material: { sigma_Spm: 5.8e7, sigma_parallel_Spm: 5.9e7, sigma_perpendicular_Spm: 5.7e7, sigma_AHE_Spm: 1.2e5 } }],
      boundaries: [{ id: "left", kind: "voltage_electrode" as const, potential_V: 0.1, surfaces: [{ object_id: "stack", surface_id: "x_min", orientation: [-1, 0, 0] }] }],
      gauge: "dirichlet_reference" as const,
      solver: { engine: "block_gmres", linear: { relative_tolerance: 1e-10, absolute_tolerance: 1e-14, max_iterations: 123 }, operator_version: "fdm_coupled_charge_spin_fv_block_gmres.v1", physical_residual_version: "transport_balance_integrated_l2.v1" },
      solve_region: "legacy",
      conductivity_s_per_m: 12,
    };
    expect(isKnownCurrentTransport(resource)).toBe(true);
    expect(buildCurrentTransport(currentTransportDraft(resource))).toEqual(resource);
    expect(isKnownCurrentTransport({
      ...resource,
      materials: [{ region: { object_id: "stack" }, material: { sigma_Spm: 5.8e7 } }],
    })).toBe(false);
  });

  it("round-trips the explicit conservative RT0 current view without dropping closure fields", () => {
    const conservativeCurrentView = {
      stable_vertex_ids: [1, 2, 3, 4],
      boundary_faces: [{
        face_vertex_ids: [1, 2, 3],
        role: "source_cut",
        circuit_id: "drive",
      }],
      identity: {
        source_module_id: "charge",
        source_state_revision: "state-1",
        source_field_digest: "field-digest",
        conductivity_digest: "sigma-digest",
        mesh_revision: "mesh-1",
        topology_revision: "topology-1",
        geometry_digest: "geometry-digest",
        envelope_revision: "envelope-1",
        envelope_digest: "envelope-digest",
        evaluated_envelope_multiplier: 1,
        evaluation_time_s: 0,
        stage_identity: 1,
      },
      pins: {
        required_source_state_revision: "state-1",
        required_source_field_digest: "field-digest",
        required_mesh_revision: "mesh-1",
        required_topology_revision: "topology-1",
      },
      closure: {
        kind: "closed_geometry",
        operator_version: "fem_rt0_closed_current.v1",
        revision: "closure-1",
        digest: "closure-digest",
        source_cuts: [{
          id: "cut-x",
          translation_m: [1e-6, 0, 0],
          potential_drop_v: 0.1,
          face_pairs: [{
            minus_face_vertex_ids: [1, 2, 3],
            plus_face_vertex_ids: [1, 2, 4],
          }],
        }],
      },
      algebraic_relative_tolerance: 1e-10,
      physical_relative_gate: 1e-8,
      physical_absolute_gate_a: 1e-12,
      reference_mpi_gather_broadcast: false,
    };
    const resource = {
      kind: "current_transport" as const,
      model: "ohmic_poisson" as const,
      name: "charge",
      coupling: "one_way" as const,
      domain: [{ object_id: "stack" }],
      materials: [{ region: { object_id: "stack" }, material: { sigma_Spm: 5.8e7 } }],
      boundaries: [{ id: "left", kind: "voltage_electrode" as const, potential_V: 0.1, surfaces: [{ object_id: "stack", surface_id: "x_min", orientation: [-1, 0, 0] }] }],
      gauge: "dirichlet_reference" as const,
      solver: { engine: "cg", linear: { relative_tolerance: 1e-10, absolute_tolerance: 1e-14, max_iterations: 123 }, operator_version: "fv_charge_harmonic_v1", physical_residual_version: "charge_balance_integrated_l2.v1" },
      conservative_current_view: conservativeCurrentView,
    };
    expect(isKnownCurrentTransport(resource)).toBe(true);
    const draft = currentTransportDraft(resource);
    expect(JSON.parse(draft.conservativeCurrentView)).toEqual(conservativeCurrentView);
    expect(buildCurrentTransport(draft)).toEqual(resource);

    draft.conservativeCurrentView = "[]";
    expect(() => buildCurrentTransport(draft)).toThrow(/JSON object/);
  });

  it("round-trips the canonical current-source time envelope", () => {
    const resource = {
      kind: "current_transport" as const,
      model: "prescribed_density" as const,
      name: "drive",
      coupling: "one_way" as const,
      current_density: [1e10, 0, 0],
      time_envelope: {
        kind: "sinusoidal" as const,
        amplitude: 0.5,
        frequency_hz: 2e9,
        phase_rad: 0.25,
        offset: 1,
      },
    };
    expect(buildCurrentTransport(currentTransportDraft(resource))).toEqual(resource);
  });

  it("prefills a new object-scoped prescribed-current draft without losing the Poisson domain", () => {
    const draft = currentTransportDraft(null, { objectId: "free-layer" });

    expect(draft.model).toBe("prescribed_density");
    expect(draft.solveRegion).toBe("free-layer");
    expect(JSON.parse(draft.domain)).toEqual([{ object_id: "free-layer" }]);
    expect(buildCurrentTransport(draft)).toMatchObject({
      model: "prescribed_density",
      solve_region: "free-layer",
    });

    Object.assign(draft, currentTransportModelPatch(draft, "ohmic_poisson"));
    expect(buildCurrentTransport(draft)).toMatchObject({
      domain: [{ object_id: "free-layer" }],
      model: "ohmic_poisson",
    });
    expect(buildCurrentTransport(draft)).not.toHaveProperty("solve_region");

    Object.assign(draft, currentTransportModelPatch(draft, "prescribed_density"));
    expect(draft.solveRegion).toBe("free-layer");
  });

  it("uses the exact selected region for a new current solve instead of broadening it to the object", () => {
    const draft = currentTransportDraft(null, {
      objectId: "pillar",
      regionId: "free-layer",
    });

    expect(draft.model).toBe("ohmic_poisson");
    expect(draft.solveRegion).toBe("");
    expect(JSON.parse(draft.domain)).toEqual([{
      object_id: "pillar",
      region_id: "free-layer",
    }]);
    expect(currentTransportSupportsPrescribedDensity(draft)).toBe(false);
    expect(currentTransportModelPatch(draft, "prescribed_density")).toMatchObject({
      model: "ohmic_poisson",
      solveRegion: "",
    });
  });

  it("round-trips every spin-transport field including requested execution", () => {
    const resource = {
      schema_version: "spin_transport.v1",
      id: " spin ",
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
        reciprocal_nonlinear: {
          gmres_restart: 40,
          max_picard_iterations: 4,
          relative_update_tolerance: 1e-9,
          eta_transport: 0.25,
        },
      },
    })).toBe(true);
    expect(isKnownSpinTransport({
      ...resource,
      constitutive_version: "transport_constitutive.reciprocal.fullmag.v1",
      solver: {
        ...resource.solver,
        operator_version: "fdm_coupled_charge_spin_fv_block_gmres.v1",
      },
    })).toBe(false);
    expect(buildSpinTransport(spinTransportDraft(resource))).toEqual(resource);
  });

  it("rejects transport hybrid lanes that the Python and planner contracts cannot execute", () => {
    const discretization = spinTransportDraft();
    (discretization as unknown as { executionDiscretization: string }).executionDiscretization = "hybrid";
    expect(() => buildSpinTransport(discretization)).toThrow(/hybrid.*not supported|unsupported.*hybrid/i);

    const executionMode = spinTransportDraft();
    (executionMode as unknown as { executionMode: string }).executionMode = "hybrid";
    expect(() => buildSpinTransport(executionMode)).toThrow(/hybrid.*not supported|unsupported.*hybrid/i);
  });

  it("preserves transient spin capacitance provenance in every material assignment", () => {
    const draft = spinTransportDraft();
    draft.mode = "transient";
    draft.materials = JSON.stringify([{
      material: {
        capacitance_formula_version: "dos_isotropic_nonmagnetic.fullmag.v1",
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
        capacitance_formula_version: "dos_isotropic_nonmagnetic.fullmag.v1",
        spin_capacitance_As_per_V_m3: 3.5,
      } }],
      mode: "transient",
    });
  });

  it("accepts the canonical DOS adapter without requiring a duplicated scalar capacitance", () => {
    const draft = spinTransportDraft();
    draft.mode = "transient";
    draft.materials = JSON.stringify([{
      material: {
        capacitance_formula_version: "dos_isotropic_nonmagnetic.fullmag.v1",
        density_of_states_per_spin_Jinv_m3: 2.0,
        lambda_j_m: "disabled",
        lambda_phi_m: "disabled",
        lambda_sf_m: 1e-9,
        polarization_p: 0.4,
        sigma_s_Spm: 2,
        theta_sh: 0.1,
      },
      region: { object_id: "stack", region_id: "normal" },
    }]);

    expect(buildSpinTransport(draft)).toMatchObject({
      materials: [{ material: {
        capacitance_formula_version: "dos_isotropic_nonmagnetic.fullmag.v1",
        density_of_states_per_spin_Jinv_m3: 2.0,
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

  it("rejects an unversioned transient DOS convention", () => {
    const draft = spinTransportDraft();
    draft.mode = "transient";
    draft.materials = JSON.stringify([{
      material: {
        capacitance_formula_version: "dos_constant.fullmag.v1",
        spin_capacitance_As_per_V_m3: 3.5,
        lambda_j_m: "disabled",
        lambda_phi_m: "disabled",
        lambda_sf_m: 1e-9,
        polarization_p: 0.4,
        sigma_s_Spm: 2,
        theta_sh: 0.1,
      },
      region: { object_id: "stack", region_id: "normal" },
    }]);

    expect(() => buildSpinTransport(draft)).toThrow(/unsupported capacitance_formula_version/);
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
      formula_version: "magnetoelectronic.fullmag.v2",
      g_down_Spm2: 2,
      g_i_Spm2: 3,
      g_r_Spm2: 4,
      spin_memory_loss: {
        formula_version: "sml_reservoir.fullmag.v2",
        g_f_Spm2: 2,
        g_lattice_Spm2: 3,
        g_n_Spm2: 1,
      },
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
      interfaces: [{ ...mixing, formula_version: "magnetoelectronic.fullmag.v1" }],
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

  it("treats blank current names and spin ids as id-less unsupported records", () => {
    const current = {
      current_density: [1, 0, 0],
      kind: "current_transport",
      model: "prescribed_density",
      name: "   ",
    };
    const spin = {
      boundaries: [],
      constitutive_version: "transport_constitutive.one_way.fullmag.v1",
      current_source_id: "charge",
      domain: [],
      id: "",
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
        operator_version: "fv_spin_upwind_v1",
        physical_residual_version: "transport_balance_integrated_l2.v1",
      },
    };

    expect(isKnownCurrentTransport(current)).toBe(false);
    expect(isKnownSpinTransport(spin)).toBe(false);
    expect(transportSelectionKey("current_transport", current, 3)).toBe("position:3");
    expect(transportSelectionKey("spin_transport", spin, 4)).toBe("position:4");
  });

  it("preserves exact non-blank identities without collapsing surrounding whitespace", () => {
    const exact = { id: "spin", schema_version: "spin_transport.v1" };
    const spaced = { id: " spin ", schema_version: "spin_transport.v1" };

    expect(transportIdentity("spin_transport", exact)).toBe("spin");
    expect(transportIdentity("spin_transport", spaced)).toBe(" spin ");
    expect(transportSelectionKey("spin_transport", exact, 0)).toBe("id:spin");
    expect(transportSelectionKey("spin_transport", spaced, 1)).toBe("id: spin ");
    expect(resolveTransportRecord("spin_transport", [exact, spaced], {
      resourceId: " spin ",
      resourceIndex: 0,
    })).toBe(spaced);
  });

  it("keeps spaced current and spin payload identities distinct from compact identities", () => {
    const spacedCurrentDraft = currentTransportDraft();
    spacedCurrentDraft.name = " charge ";
    const compactCurrentDraft = currentTransportDraft();
    compactCurrentDraft.name = "charge";
    const spacedSpinDraft = spinTransportDraft();
    spacedSpinDraft.id = " spin ";
    const compactSpinDraft = spinTransportDraft();
    compactSpinDraft.id = "spin";

    const spacedCurrent = buildCurrentTransport(spacedCurrentDraft);
    const compactCurrent = buildCurrentTransport(compactCurrentDraft);
    const spacedSpin = buildSpinTransport(spacedSpinDraft);
    const compactSpin = buildSpinTransport(compactSpinDraft);

    expect(spacedCurrent.name).toBe(" charge ");
    expect(spacedSpin.id).toBe(" spin ");
    expect(transportSelectionKey("current_transport", spacedCurrent, 0)).not.toBe(
      transportSelectionKey("current_transport", compactCurrent, 1),
    );
    expect(transportSelectionKey("spin_transport", spacedSpin, 0)).not.toBe(
      transportSelectionKey("spin_transport", compactSpin, 1),
    );
  });

  it("round-trips an exact current identity through the spin source binding", () => {
    const currentDraft = currentTransportDraft();
    currentDraft.name = " charge ";
    const current = buildCurrentTransport(currentDraft);
    const spinDraft = spinTransportDraft();
    spinDraft.currentSourceId = "name" in current && typeof current.name === "string" ? current.name : "";
    const spin = buildSpinTransport(spinDraft);

    expect(current.name).toBe(" charge ");
    expect(spin.current_source_id).toBe(current.name);
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
