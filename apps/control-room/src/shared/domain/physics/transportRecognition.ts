import type {
  KnownSceneCurrentTransport,
  KnownSceneSpinTransport,
  SceneCurrentTransport,
  SceneSpinTransport,
} from "@/kernel/api/apiTypes";

type JsonObject = Record<string, unknown>;

export type TransportFamily = "current_transport" | "spin_transport";

export function transportIdentity(
  family: TransportFamily,
  resource: SceneCurrentTransport | SceneSpinTransport,
): string | null {
  const value = family === "current_transport"
    ? (resource as { name?: unknown }).name
    : (resource as { id?: unknown }).id;
  if (typeof value !== "string") return null;
  return value.trim().length > 0 ? value : null;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: JsonObject, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isVec3(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every(isFiniteNumber);
}

function isArrayOf(value: unknown, predicate: (item: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(predicate);
}

function isRegionRef(value: unknown): boolean {
  return isObject(value)
    && hasOnlyKeys(value, ["object_id", "region_id"])
    && typeof value.object_id === "string"
    && (value.region_id === undefined || value.region_id === null || typeof value.region_id === "string");
}

function isSurfaceRef(value: unknown): boolean {
  return isObject(value)
    && hasOnlyKeys(value, ["object_id", "orientation", "surface_id"])
    && typeof value.object_id === "string"
    && isVec3(value.orientation)
    && typeof value.surface_id === "string";
}

function isLinearSolver(value: unknown): boolean {
  return isObject(value)
    && hasOnlyKeys(value, ["absolute_tolerance", "max_iterations", "relative_tolerance"])
    && isFiniteNumber(value.absolute_tolerance)
    && typeof value.max_iterations === "number"
    && Number.isInteger(value.max_iterations)
    && value.max_iterations >= 0
    && isFiniteNumber(value.relative_tolerance);
}

function isChargeSolver(value: unknown, coupling: unknown, hasStructuredClosure: boolean): boolean {
  if (!isObject(value)
    || !hasOnlyKeys(value, ["engine", "linear", "operator_version", "physical_residual_version"])
    || !isLinearSolver(value.linear)) return false;
  if (coupling === "bidirectional") {
    return value.engine === "block_gmres"
      && value.operator_version === "fdm_coupled_charge_spin_fv_block_gmres.v1"
      && value.physical_residual_version === "transport_balance_integrated_l2.v1";
  }
  return (coupling === undefined || coupling === "one_way")
    && value.engine === "cg"
    && value.operator_version === (hasStructuredClosure
      ? "fv_charge_harmonic_source_cut_v1"
      : "fv_charge_harmonic_v1")
    && value.physical_residual_version === "charge_balance_integrated_l2.v1";
}

function isStructuredCurrentDrive(value: unknown): boolean {
  return isObject(value)
    && hasOnlyKeys(value, ["drive_id", "kind", "potential_jump_V", "schema_version"])
    && typeof value.drive_id === "string"
    && value.drive_id.trim().length > 0
    && value.kind === "impressed_potential_jump"
    && isFiniteNumber(value.potential_jump_V)
    && value.potential_jump_V !== 0
    && value.schema_version === "impressed_potential_jump.v1";
}

function isStructuredCurrentSourceCut(value: unknown): boolean {
  return isObject(value)
    && hasOnlyKeys(value, ["circuit_id", "drive", "plane", "region", "source_cut_id"])
    && typeof value.circuit_id === "string"
    && value.circuit_id.trim().length > 0
    && isStructuredCurrentDrive(value.drive)
    && isObject(value.plane)
    && hasOnlyKeys(value.plane, ["axis", "normal", "offset_m"])
    && ["x", "y", "z"].includes(value.plane.axis as string)
    && ["positive_axis", "negative_axis"].includes(value.plane.normal as string)
    && isFiniteNumber(value.plane.offset_m)
    && isRegionRef(value.region)
    && typeof value.source_cut_id === "string"
    && value.source_cut_id.trim().length > 0;
}

function isStructuredCurrentClosure(value: unknown): boolean {
  if (!isObject(value)
    || !hasOnlyKeys(value, ["closure_id", "kind", "schema_version", "source_cuts"])
    || typeof value.closure_id !== "string"
    || value.closure_id.trim().length === 0
    || value.kind !== "closed_geometry"
    || value.schema_version !== "structured_current_closure.v1"
    || !Array.isArray(value.source_cuts)
    || !value.source_cuts.every(isStructuredCurrentSourceCut)
    || value.source_cuts.length === 0) return false;
  const cuts = value.source_cuts as JsonObject[];
  const unique = (key: "circuit_id" | "source_cut_id"): boolean => {
    const values = cuts.map((cut) => cut[key]);
    return new Set(values).size === values.length;
  };
  const driveIds = cuts.map((cut) => (cut.drive as JsonObject).drive_id);
  return unique("source_cut_id")
    && unique("circuit_id")
    && new Set(driveIds).size === driveIds.length;
}

function isTimeEnvelopePoint(value: unknown): boolean {
  return isObject(value)
    && hasOnlyKeys(value, ["time_s", "value"])
    && isFiniteNumber(value.time_s)
    && isFiniteNumber(value.value);
}

function isTimeEnvelope(value: unknown): boolean {
  if (!isObject(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "constant":
      return hasOnlyKeys(value, ["kind", "value"]) && isFiniteNumber(value.value);
    case "sinusoidal":
      return hasOnlyKeys(value, ["amplitude", "frequency_hz", "kind", "offset", "phase_rad"])
        && [value.amplitude, value.frequency_hz, value.offset, value.phase_rad].every(isFiniteNumber);
    case "pulse":
      return hasOnlyKeys(value, ["amplitude", "kind", "t_off_s", "t_on_s"])
        && [value.amplitude, value.t_off_s, value.t_on_s].every(isFiniteNumber);
    case "piecewise_linear":
      return hasOnlyKeys(value, ["kind", "points"])
        && isArrayOf(value.points, isTimeEnvelopePoint);
    case "sinc":
      return hasOnlyKeys(value, ["amplitude", "bandwidth_hz", "center_s", "kind", "offset"])
        && [value.amplitude, value.bandwidth_hz, value.center_s, value.offset].every(isFiniteNumber);
    case "tabulated":
      return hasOnlyKeys(value, ["artifact_ref", "bandwidth_hz", "extrapolation", "interpolation", "kind"])
        && typeof value.artifact_ref === "string"
        && (value.bandwidth_hz === undefined || value.bandwidth_hz === null || isFiniteNumber(value.bandwidth_hz))
        && ["zero", "hold", "error"].includes(value.extrapolation as string)
        && ["linear", "previous"].includes(value.interpolation as string);
    default:
      return false;
  }
}

function isSpinSolver(value: unknown, constitutiveVersion: unknown): boolean {
  if (!isObject(value)) return false;
  if (!hasOnlyKeys(value, [
    "default_external_boundary",
    "engine",
    "linear",
    "operator_version",
    "physical_residual_version",
    "reciprocal_nonlinear",
  ]) || !isLinearSolver(value.linear)) return false;
  const expectedOperator = constitutiveVersion === "transport_constitutive.one_way.fullmag.v1"
    ? "fv_spin_upwind_v1"
    : constitutiveVersion === "transport_constitutive.reciprocal.fullmag.v1"
      ? "fdm_coupled_charge_spin_fv_block_gmres.v1"
      : null;
  const nonlinear = value.reciprocal_nonlinear;
  const validNonlinear = nonlinear === undefined
    || (isObject(nonlinear)
      && hasOnlyKeys(nonlinear, [
        "eta_transport",
        "gmres_restart",
        "max_picard_iterations",
        "relative_update_tolerance",
      ])
      && typeof nonlinear.gmres_restart === "number"
      && Number.isInteger(nonlinear.gmres_restart)
      && nonlinear.gmres_restart > 0
      && typeof nonlinear.max_picard_iterations === "number"
      && Number.isInteger(nonlinear.max_picard_iterations)
      && nonlinear.max_picard_iterations > 0
      && isFiniteNumber(nonlinear.relative_update_tolerance)
      && nonlinear.relative_update_tolerance > 0
      && isFiniteNumber(nonlinear.eta_transport)
      && nonlinear.eta_transport > 0
      && nonlinear.eta_transport <= 1);
  return expectedOperator !== null
    && (value.engine === "auto" || value.engine === "gmres")
    && value.operator_version === expectedOperator
    && value.physical_residual_version === "transport_balance_integrated_l2.v1"
    && (value.default_external_boundary === "spin_insulating"
      || value.default_external_boundary === "reject_unassigned")
    && validNonlinear
    && (constitutiveVersion === "transport_constitutive.reciprocal.fullmag.v1"
      ? nonlinear !== undefined
      : nonlinear === undefined);
}

function isChargeMaterialAssignment(value: unknown, reciprocal: boolean): boolean {
  if (!isObject(value) || !hasOnlyKeys(value, ["material", "region"]) || !isObject(value.material)) {
    return false;
  }
  const materialKeys = [
    "sigma_Spm",
    "sigma_parallel_Spm",
    "sigma_perpendicular_Spm",
    "sigma_AHE_Spm",
  ] as const;
  if (!hasOnlyKeys(value.material, materialKeys) || !isFiniteNumber(value.material.sigma_Spm)) {
    return false;
  }
  const hasTensor = [
    value.material.sigma_parallel_Spm,
    value.material.sigma_perpendicular_Spm,
    value.material.sigma_AHE_Spm,
  ].some((item) => item !== undefined && item !== null);
  const completeTensor = isFiniteNumber(value.material.sigma_parallel_Spm)
    && value.material.sigma_parallel_Spm > 0
    && isFiniteNumber(value.material.sigma_perpendicular_Spm)
    && value.material.sigma_perpendicular_Spm > 0
    && isFiniteNumber(value.material.sigma_AHE_Spm);
  return isRegionRef(value.region)
    && (reciprocal ? completeTensor : !hasTensor);
}

function isChargeBoundary(value: unknown): boolean {
  if (!isObject(value) || typeof value.id !== "string" || !isArrayOf(value.surfaces, isSurfaceRef)) {
    return false;
  }
  if (value.kind === "voltage_electrode") {
    return hasOnlyKeys(value, ["id", "kind", "potential_V", "surfaces"])
      && isFiniteNumber(value.potential_V);
  }
  if (value.kind === "normal_current_electrode") {
    return hasOnlyKeys(value, ["id", "kind", "outward_current_density_Apm2", "surfaces"])
      && isFiniteNumber(value.outward_current_density_Apm2);
  }
  return value.kind === "insulating" && hasOnlyKeys(value, ["id", "kind", "surfaces"]);
}

function isReactionLength(value: unknown): boolean {
  return isFiniteNumber(value) || value === "disabled";
}

function isSpinMemoryLossReservoir(value: unknown): boolean {
  return isObject(value)
    && hasOnlyKeys(value, ["formula_version", "g_f_Spm2", "g_lattice_Spm2", "g_n_Spm2"])
    && value.formula_version === "sml_reservoir.fullmag.v2"
    && isFiniteNumber(value.g_f_Spm2)
    && value.g_f_Spm2 >= 0
    && isFiniteNumber(value.g_n_Spm2)
    && value.g_n_Spm2 >= 0
    && isFiniteNumber(value.g_lattice_Spm2)
    && value.g_lattice_Spm2 > 0;
}

function isSpinMaterialAssignment(value: unknown): boolean {
  if (!isObject(value) || !hasOnlyKeys(value, ["material", "region"]) || !isObject(value.material)) {
    return false;
  }
  const material = value.material;
  return hasOnlyKeys(material, [
    "capacitance_formula_version",
    "density_of_states_per_spin_Jinv_m3",
    "lambda_j_m",
    "lambda_phi_m",
    "lambda_sf_m",
    "polarization_p",
    "sigma_s_Spm",
    "spin_capacitance_As_per_V_m3",
    "theta_sh",
  ])
    && (material.capacitance_formula_version === undefined
      || material.capacitance_formula_version === null
      || typeof material.capacitance_formula_version === "string")
    && isReactionLength(material.lambda_j_m)
    && isReactionLength(material.lambda_phi_m)
    && isFiniteNumber(material.lambda_sf_m)
    && isFiniteNumber(material.polarization_p)
    && isFiniteNumber(material.sigma_s_Spm)
    && (material.spin_capacitance_As_per_V_m3 === undefined
      || material.spin_capacitance_As_per_V_m3 === null
      || isFiniteNumber(material.spin_capacitance_As_per_V_m3))
    && (material.density_of_states_per_spin_Jinv_m3 === undefined
      || material.density_of_states_per_spin_Jinv_m3 === null
      || isFiniteNumber(material.density_of_states_per_spin_Jinv_m3))
    && isFiniteNumber(material.theta_sh)
    && isRegionRef(value.region);
}

function isSpinInterface(value: unknown): boolean {
  if (!isObject(value) || typeof value.id !== "string") return false;
  if (value.kind === "transparent") {
    return hasOnlyKeys(value, ["id", "kind", "normal_a_to_b", "side_a", "side_b"])
      && isVec3(value.normal_a_to_b)
      && isRegionRef(value.side_a)
      && isRegionRef(value.side_b);
  }
  return value.kind === "mixing_conductance"
    && hasOnlyKeys(value, [
      "absorption",
      "ferromagnet_side",
      "formula_version",
      "g_down_Spm2",
      "g_i_Spm2",
      "g_r_Spm2",
      "g_up_Spm2",
      "id",
      "kind",
      "normal_side",
      "normal_to_ferromagnet",
      "spin_memory_loss",
    ])
    && value.absorption === "full_absorption"
    && isRegionRef(value.ferromagnet_side)
    && value.formula_version === "magnetoelectronic.fullmag.v2"
    && isFiniteNumber(value.g_down_Spm2)
    && isFiniteNumber(value.g_i_Spm2)
    && isFiniteNumber(value.g_r_Spm2)
    && isFiniteNumber(value.g_up_Spm2)
    && isRegionRef(value.normal_side)
    && isVec3(value.normal_to_ferromagnet)
    && (value.spin_memory_loss === undefined || isSpinMemoryLossReservoir(value.spin_memory_loss));
}

function isSpinBoundary(value: unknown): boolean {
  if (!isObject(value) || typeof value.id !== "string" || typeof value.kind !== "string") return false;
  if (["spin_insulating", "spin_sink"].includes(value.kind)) {
    return hasOnlyKeys(value, ["id", "kind", "surfaces"])
      && isArrayOf(value.surfaces, isSurfaceRef);
  }
  if (value.kind === "specified_spin_potential") {
    return hasOnlyKeys(value, ["id", "kind", "spin_potential_V", "surfaces"])
      && isVec3(value.spin_potential_V)
      && isArrayOf(value.surfaces, isSurfaceRef);
  }
  if (value.kind === "specified_spin_flux") {
    return hasOnlyKeys(value, ["id", "kind", "normal_spin_flux_Apm2", "surfaces"])
      && isVec3(value.normal_spin_flux_Apm2)
      && isArrayOf(value.surfaces, isSurfaceRef);
  }
  return value.kind === "periodic_spin"
    && hasOnlyKeys(value, ["id", "kind", "minus_surface", "plus_surface", "translation_m"])
    && isSurfaceRef(value.minus_surface)
    && isSurfaceRef(value.plus_surface)
    && isVec3(value.translation_m);
}

function isRequestedExecution(value: unknown): boolean {
  return isObject(value)
    && hasOnlyKeys(value, ["device", "discretization", "execution_mode", "precision"])
    && ["auto", "cpu", "gpu"].includes(value.device as string)
    && ["auto", "fdm", "fem"].includes(value.discretization as string)
    && ["extended", "strict"].includes(value.execution_mode as string)
    && ["double", "single"].includes(value.precision as string);
}

export function isKnownCurrentTransport(value: SceneCurrentTransport): value is KnownSceneCurrentTransport {
  if (!isObject(value) || !hasOnlyKeys(value, [
    "boundaries",
    "conductivity_s_per_m",
    "conservative_current_view",
    "coupling",
    "current_density",
    "domain",
    "gauge",
    "kind",
    "materials",
    "model",
    "name",
    "solve_region",
    "solver",
    "structured_current_closure",
    "time_envelope",
  ])) return false;
  const hasStructuredClosure = value.structured_current_closure !== undefined
    && value.structured_current_closure !== null;
  return value.kind === "current_transport"
    && ["ohmic_poisson", "magnetoresistive_poisson", "prescribed_density"].includes(value.model as string)
    && transportIdentity("current_transport", value) !== null
    && (value.boundaries === undefined || isArrayOf(value.boundaries, isChargeBoundary))
    && (value.conductivity_s_per_m === undefined
      || value.conductivity_s_per_m === null
      || isFiniteNumber(value.conductivity_s_per_m))
    && (value.conservative_current_view === undefined
      || value.conservative_current_view === null
      || isObject(value.conservative_current_view))
    && (!hasStructuredClosure
      || value.conservative_current_view === undefined
      || value.conservative_current_view === null)
    && (value.coupling === undefined || value.coupling === "one_way" || value.coupling === "bidirectional")
    && (value.current_density === undefined || value.current_density === null || isVec3(value.current_density))
    && (value.domain === undefined || isArrayOf(value.domain, isRegionRef))
    && (value.gauge === undefined
      || value.gauge === null
      || value.gauge === "dirichlet_reference"
      || value.gauge === "zero_mean")
    && (value.model !== "magnetoresistive_poisson" || value.coupling === "bidirectional")
    && (!hasStructuredClosure || (value.model === "ohmic_poisson" && value.coupling === "one_way"))
    && (value.materials === undefined || isArrayOf(
      value.materials,
      (item) => isChargeMaterialAssignment(
        item,
        value.model === "magnetoresistive_poisson" || value.coupling === "bidirectional",
      ),
    ))
    && (value.solve_region === undefined || value.solve_region === null || typeof value.solve_region === "string")
    && (!hasStructuredClosure || isStructuredCurrentClosure(value.structured_current_closure))
    && (value.time_envelope === undefined || value.time_envelope === null || isTimeEnvelope(value.time_envelope))
    && (value.solver === undefined
      ? !hasStructuredClosure
      : value.solver === null
        ? !hasStructuredClosure
        : isChargeSolver(value.solver, value.coupling, hasStructuredClosure));
}

export function isKnownSpinTransport(value: SceneSpinTransport): value is KnownSceneSpinTransport {
  if (!isObject(value) || !hasOnlyKeys(value, [
    "boundaries",
    "constitutive_version",
    "current_source_id",
    "domain",
    "id",
    "interfaces",
    "materials",
    "mode",
    "requested_execution",
    "schema_version",
    "solver",
  ])) return false;
  return value.schema_version === "spin_transport.v1"
    && transportIdentity("spin_transport", value) !== null
    && typeof value.current_source_id === "string"
    && (value.mode === "steady" || value.mode === "transient")
    && isArrayOf(value.domain, isRegionRef)
    && isArrayOf(value.materials, isSpinMaterialAssignment)
    && (value.interfaces === undefined || isArrayOf(value.interfaces, isSpinInterface))
    && (value.boundaries === undefined || isArrayOf(value.boundaries, isSpinBoundary))
    && isSpinSolver(value.solver, value.constitutive_version)
    && isRequestedExecution(value.requested_execution)
    && (value.constitutive_version === "transport_constitutive.one_way.fullmag.v1"
      || value.constitutive_version === "transport_constitutive.reciprocal.fullmag.v1");
}
