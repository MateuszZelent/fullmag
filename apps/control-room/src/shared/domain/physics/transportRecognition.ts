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

function isChargeSolver(value: unknown, coupling: unknown): boolean {
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
    && value.operator_version === "fv_charge_harmonic_v1"
    && value.physical_residual_version === "charge_balance_integrated_l2.v1";
}

function isSpinSolver(value: unknown, constitutiveVersion: unknown): boolean {
  if (!isObject(value)) return false;
  if (!hasOnlyKeys(value, [
    "default_external_boundary",
    "engine",
    "linear",
    "operator_version",
    "physical_residual_version",
  ]) || !isLinearSolver(value.linear)) return false;
  const expectedOperator = constitutiveVersion === "transport_constitutive.one_way.fullmag.v1"
    ? "fv_spin_upwind_v1"
    : constitutiveVersion === "transport_constitutive.reciprocal.fullmag.v1"
      ? "fdm_coupled_charge_spin_fv_block_gmres.v1"
      : null;
  return expectedOperator !== null
    && (value.engine === "auto" || value.engine === "gmres")
    && value.operator_version === expectedOperator
    && value.physical_residual_version === "transport_balance_integrated_l2.v1"
    && (value.default_external_boundary === "spin_insulating"
      || value.default_external_boundary === "reject_unassigned");
}

function isChargeMaterialAssignment(value: unknown): boolean {
  if (!isObject(value) || !hasOnlyKeys(value, ["material", "region"]) || !isObject(value.material)) {
    return false;
  }
  return hasOnlyKeys(value.material, ["sigma_Spm"])
    && isFiniteNumber(value.material.sigma_Spm)
    && isRegionRef(value.region);
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
    && ["auto", "fdm", "fem", "hybrid"].includes(value.discretization as string)
    && ["extended", "hybrid", "strict"].includes(value.execution_mode as string)
    && ["double", "single"].includes(value.precision as string);
}

export function isKnownCurrentTransport(value: SceneCurrentTransport): value is KnownSceneCurrentTransport {
  if (!isObject(value) || !hasOnlyKeys(value, [
    "boundaries",
    "conductivity_s_per_m",
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
  ])) return false;
  return value.kind === "current_transport"
    && ["ohmic_poisson", "prescribed_density"].includes(value.model as string)
    && transportIdentity("current_transport", value) !== null
    && (value.boundaries === undefined || isArrayOf(value.boundaries, isChargeBoundary))
    && (value.conductivity_s_per_m === undefined
      || value.conductivity_s_per_m === null
      || isFiniteNumber(value.conductivity_s_per_m))
    && (value.coupling === undefined || value.coupling === "one_way" || value.coupling === "bidirectional")
    && (value.current_density === undefined || value.current_density === null || isVec3(value.current_density))
    && (value.domain === undefined || isArrayOf(value.domain, isRegionRef))
    && (value.gauge === undefined
      || value.gauge === null
      || value.gauge === "dirichlet_reference"
      || value.gauge === "zero_mean")
    && (value.materials === undefined || isArrayOf(value.materials, isChargeMaterialAssignment))
    && (value.solve_region === undefined || value.solve_region === null || typeof value.solve_region === "string")
    && (value.solver === undefined || value.solver === null || isChargeSolver(value.solver, value.coupling));
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
