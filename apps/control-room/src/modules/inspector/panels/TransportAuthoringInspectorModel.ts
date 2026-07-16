import type {
  KnownSceneCurrentTransport,
  KnownSceneSpinTransport,
  SceneCurrentTransport,
  SceneSpinTransport,
} from "@/kernel/api/apiTypes";

export interface CurrentTransportDraft {
  boundaries: string;
  conductivity: string;
  coupling: "one_way" | "bidirectional";
  currentDensity: string;
  domain: string;
  gauge: "dirichlet_reference" | "zero_mean";
  materials: string;
  model: "prescribed_density" | "ohmic_poisson";
  name: string;
  solveRegion: string;
  solverAbsoluteTolerance: string;
  solverEngine: string;
  solverMaxIterations: string;
  solverOperatorVersion: string;
  solverPhysicalResidualVersion: string;
  solverRelativeTolerance: string;
}

export interface SpinTransportDraft {
  boundaries: string;
  constitutiveVersion: string;
  currentSourceId: string;
  domain: string;
  executionDevice: "auto" | "cpu" | "gpu";
  executionDiscretization: "auto" | "fdm" | "fem" | "hybrid";
  executionMode: "strict" | "extended" | "hybrid";
  executionPrecision: "single" | "double";
  id: string;
  interfaces: string;
  materials: string;
  mode: "steady" | "transient";
  schemaVersion: string;
  solverAbsoluteTolerance: string;
  solverDefaultExternalBoundary: string;
  solverEngine: string;
  solverMaxIterations: string;
  solverOperatorVersion: string;
  solverPhysicalResidualVersion: string;
  solverRelativeTolerance: string;
}

export type TransportFamily = "current_transport" | "spin_transport";

export function transportIdentity(
  family: TransportFamily,
  resource: SceneCurrentTransport | SceneSpinTransport,
): string | null {
  const value = family === "current_transport"
    ? (resource as { name?: unknown }).name
    : (resource as { id?: unknown }).id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function transportSelectionKey(
  family: TransportFamily,
  resource: SceneCurrentTransport | SceneSpinTransport,
  index: number,
): string {
  const id = transportIdentity(family, resource);
  return id === null ? `position:${index}` : `id:${id}`;
}

export function resolveTransportRecord<T extends SceneCurrentTransport | SceneSpinTransport>(
  family: TransportFamily,
  items: readonly T[],
  address: {
    resourceId?: string | null;
    resourceIndex?: number | null;
    selectionKey?: string | null;
  },
): T | null {
  if (address.resourceId !== undefined && address.resourceId !== null) {
    return items.find((item) => transportIdentity(family, item) === address.resourceId) ?? null;
  }

  if (address.selectionKey?.startsWith("id:")) {
    const id = address.selectionKey.slice(3);
    return items.find((item) => transportIdentity(family, item) === id) ?? null;
  }

  const positionalIndex = address.selectionKey?.startsWith("position:")
    ? Number.parseInt(address.selectionKey.slice("position:".length), 10)
    : address.resourceIndex;
  if (positionalIndex === undefined || positionalIndex === null || !Number.isInteger(positionalIndex)) {
    return null;
  }
  const candidate = items[positionalIndex] ?? null;
  return candidate && transportIdentity(family, candidate) === null ? candidate : null;
}

interface SpinMaterialAssignmentDraftValue {
  material?: {
    capacitance_formula_version?: unknown;
    spin_capacitance_As_per_V_m3?: unknown;
  };
}

const pretty = (value: unknown): string => JSON.stringify(value, null, 2);

export function readonlyTransportPayload(value: SceneCurrentTransport | SceneSpinTransport): string {
  return pretty(value);
}

type JsonObject = Record<string, unknown>;

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

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(isFiniteNumber);
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
    && isNumberArray(value.orientation)
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
      && isNumberArray(value.normal_a_to_b)
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
      "g_sml_Spm2",
      "g_up_Spm2",
      "id",
      "kind",
      "normal_side",
      "normal_to_ferromagnet",
    ])
    && typeof value.absorption === "string"
    && isRegionRef(value.ferromagnet_side)
    && typeof value.formula_version === "string"
    && isFiniteNumber(value.g_down_Spm2)
    && isFiniteNumber(value.g_i_Spm2)
    && isFiniteNumber(value.g_r_Spm2)
    && isFiniteNumber(value.g_sml_Spm2)
    && isFiniteNumber(value.g_up_Spm2)
    && isRegionRef(value.normal_side)
    && isNumberArray(value.normal_to_ferromagnet);
}

function isSpinBoundary(value: unknown): boolean {
  if (!isObject(value) || typeof value.id !== "string" || typeof value.kind !== "string") return false;
  if (["spin_insulating", "spin_sink"].includes(value.kind)) {
    return hasOnlyKeys(value, ["id", "kind", "surfaces"])
      && isArrayOf(value.surfaces, isSurfaceRef);
  }
  if (value.kind === "specified_spin_potential") {
    return hasOnlyKeys(value, ["id", "kind", "spin_potential_V", "surfaces"])
      && isNumberArray(value.spin_potential_V)
      && isArrayOf(value.surfaces, isSurfaceRef);
  }
  if (value.kind === "specified_spin_flux") {
    return hasOnlyKeys(value, ["id", "kind", "normal_spin_flux_Apm2", "surfaces"])
      && isNumberArray(value.normal_spin_flux_Apm2)
      && isArrayOf(value.surfaces, isSurfaceRef);
  }
  return value.kind === "periodic_spin"
    && hasOnlyKeys(value, ["id", "kind", "minus_surface", "plus_surface", "translation_m"])
    && isSurfaceRef(value.minus_surface)
    && isSurfaceRef(value.plus_surface)
    && isNumberArray(value.translation_m);
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
    && typeof value.name === "string"
    && (value.boundaries === undefined || isArrayOf(value.boundaries, isChargeBoundary))
    && (value.conductivity_s_per_m === undefined
      || value.conductivity_s_per_m === null
      || isFiniteNumber(value.conductivity_s_per_m))
    && (value.coupling === undefined || value.coupling === "one_way" || value.coupling === "bidirectional")
    && (value.current_density === undefined || value.current_density === null || isNumberArray(value.current_density))
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
    && typeof value.id === "string"
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

export function currentTransportDraft(value?: KnownSceneCurrentTransport | null): CurrentTransportDraft {
  return {
    boundaries: pretty(value?.boundaries ?? []),
    conductivity: value?.conductivity_s_per_m?.toString() ?? "",
    coupling: value?.coupling ?? "one_way",
    currentDensity: pretty(value?.current_density ?? [0, 0, 0]),
    domain: pretty(value?.domain ?? []),
    gauge: value?.gauge ?? "dirichlet_reference",
    materials: pretty(value?.materials ?? []),
    model: value?.model ?? "prescribed_density",
    name: value?.name ?? "current",
    solveRegion: value?.solve_region ?? "",
    solverAbsoluteTolerance: value?.solver?.linear.absolute_tolerance.toString() ?? "1e-14",
    solverEngine: value?.solver?.engine ?? "cg",
    solverMaxIterations: value?.solver?.linear.max_iterations.toString() ?? "1000",
    solverOperatorVersion: value?.solver?.operator_version ?? "fv_charge_harmonic_v1",
    solverPhysicalResidualVersion: value?.solver?.physical_residual_version ?? "charge_balance_integrated_l2.v1",
    solverRelativeTolerance: value?.solver?.linear.relative_tolerance.toString() ?? "1e-10",
  };
}

export function spinTransportDraft(value?: KnownSceneSpinTransport | null): SpinTransportDraft {
  return {
    boundaries: pretty(value?.boundaries ?? []),
    constitutiveVersion: value?.constitutive_version ?? "transport_constitutive.one_way.fullmag.v1",
    currentSourceId: value?.current_source_id ?? "current",
    domain: pretty(value?.domain ?? []),
    executionDevice: value?.requested_execution.device ?? "auto",
    executionDiscretization: value?.requested_execution.discretization ?? "auto",
    executionMode: value?.requested_execution.execution_mode ?? "strict",
    executionPrecision: value?.requested_execution.precision ?? "double",
    id: value?.id ?? "spin-transport",
    interfaces: pretty(value?.interfaces ?? []),
    materials: pretty(value?.materials ?? []),
    mode: value?.mode ?? "steady",
    schemaVersion: value?.schema_version ?? "spin_transport.v1",
    solverAbsoluteTolerance: value?.solver.linear.absolute_tolerance.toString() ?? "1e-14",
    solverDefaultExternalBoundary: value?.solver.default_external_boundary ?? "spin_insulating",
    solverEngine: value?.solver.engine ?? "gmres",
    solverMaxIterations: value?.solver.linear.max_iterations.toString() ?? "1000",
    solverOperatorVersion: value?.solver.operator_version ?? "fv_spin_upwind_v1",
    solverPhysicalResidualVersion: value?.solver.physical_residual_version ?? "transport_balance_integrated_l2.v1",
    solverRelativeTolerance: value?.solver.linear.relative_tolerance.toString() ?? "1e-10",
  };
}

function finite(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be finite.`);
  return parsed;
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

function json<T>(value: string, label: string): T {
  try { return JSON.parse(value) as T; }
  catch { throw new Error(`${label} must be valid JSON.`); }
}

export function buildCurrentTransport(draft: CurrentTransportDraft): SceneCurrentTransport {
  const resource: KnownSceneCurrentTransport = {
    kind: "current_transport",
    model: draft.model,
    name: draft.name.trim(),
    coupling: draft.coupling,
  };
  if (!resource.name) throw new Error("Name is required.");
  if (draft.model === "prescribed_density") {
    resource.current_density = json<number[]>(draft.currentDensity, "Current density");
    if (draft.solveRegion.trim()) resource.solve_region = draft.solveRegion.trim();
    return resource;
  }
  resource.domain = json(draft.domain, "Charge domain");
  resource.materials = json(draft.materials, "Charge materials");
  resource.boundaries = json(draft.boundaries, "Charge boundaries");
  resource.gauge = draft.gauge;
  resource.solver = {
    engine: draft.solverEngine.trim(),
    linear: {
      absolute_tolerance: finite(draft.solverAbsoluteTolerance, "Absolute tolerance"),
      max_iterations: positiveInteger(draft.solverMaxIterations, "Maximum iterations"),
      relative_tolerance: finite(draft.solverRelativeTolerance, "Relative tolerance"),
    },
    operator_version: draft.solverOperatorVersion.trim(),
    physical_residual_version: draft.solverPhysicalResidualVersion.trim(),
  };
  if (draft.conductivity.trim()) resource.conductivity_s_per_m = finite(draft.conductivity, "Conductivity");
  if (draft.solveRegion.trim()) resource.solve_region = draft.solveRegion.trim();
  return resource;
}

export function buildSpinTransport(draft: SpinTransportDraft): SceneSpinTransport {
  if (!draft.id.trim()) throw new Error("Spin transport id is required.");
  const materials = json<SpinMaterialAssignmentDraftValue[]>(draft.materials, "Spin materials");
  if (!Array.isArray(materials)) throw new Error("Spin materials must be a JSON array.");
  materials.forEach(({ material }, index) => {
    const capacitance = material?.spin_capacitance_As_per_V_m3;
    const version = material?.capacitance_formula_version;
    const hasCapacitance = capacitance !== undefined && capacitance !== null;
    const hasVersion = version !== undefined && version !== null;
    if (hasCapacitance !== hasVersion) {
      throw new Error(`Spin material ${index + 1}: spin capacitance and formula version must be authored together.`);
    }
    if (draft.mode === "transient" && !hasCapacitance) {
      throw new Error(`Spin material ${index + 1}: transient mode requires spin_capacitance_As_per_V_m3 and capacitance_formula_version.`);
    }
    if (hasCapacitance && (typeof capacitance !== "number" || !Number.isFinite(capacitance) || capacitance <= 0)) {
      throw new Error(`Spin material ${index + 1}: spin_capacitance_As_per_V_m3 must be finite and greater than zero.`);
    }
    if (hasVersion && (typeof version !== "string" || version.trim() === "")) {
      throw new Error(`Spin material ${index + 1}: capacitance_formula_version must be a non-empty string.`);
    }
  });
  return {
    boundaries: json(draft.boundaries, "Spin boundaries"),
    constitutive_version: draft.constitutiveVersion.trim(),
    current_source_id: draft.currentSourceId.trim(),
    domain: json(draft.domain, "Spin domain"),
    id: draft.id.trim(),
    interfaces: json(draft.interfaces, "Spin interfaces"),
    materials: materials as KnownSceneSpinTransport["materials"],
    mode: draft.mode,
    requested_execution: {
      device: draft.executionDevice,
      discretization: draft.executionDiscretization,
      execution_mode: draft.executionMode,
      precision: draft.executionPrecision,
    },
    schema_version: draft.schemaVersion.trim(),
    solver: {
      default_external_boundary: draft.solverDefaultExternalBoundary.trim(),
      engine: draft.solverEngine.trim(),
      linear: {
        absolute_tolerance: finite(draft.solverAbsoluteTolerance, "Absolute tolerance"),
        max_iterations: positiveInteger(draft.solverMaxIterations, "Maximum iterations"),
        relative_tolerance: finite(draft.solverRelativeTolerance, "Relative tolerance"),
      },
      operator_version: draft.solverOperatorVersion.trim(),
      physical_residual_version: draft.solverPhysicalResidualVersion.trim(),
    },
  };
}
