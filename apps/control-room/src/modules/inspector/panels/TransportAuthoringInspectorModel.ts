import type {
  KnownSceneCurrentTransport,
  KnownSceneSpinTransport,
  SceneCurrentTransport,
  SceneSpinTransport,
} from "@/kernel/api/apiTypes";
import {
  transportIdentity,
  type TransportFamily,
} from "@/shared/domain/physics/transportRecognition";

const ELEMENTARY_CHARGE_C = 1.602176634e-19;

export interface CurrentTransportDraft {
  boundaries: string;
  conductivity: string;
  coupling: "one_way" | "bidirectional";
  currentDensity: string;
  domain: string;
  gauge: "dirichlet_reference" | "zero_mean";
  materials: string;
  model: "prescribed_density" | "ohmic_poisson" | "magnetoresistive_poisson";
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
  executionDiscretization: "auto" | "fdm" | "fem";
  executionMode: "strict" | "extended";
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
  reciprocalNonlinear: string;
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
    density_of_states_per_spin_Jinv_m3?: unknown;
    spin_capacitance_As_per_V_m3?: unknown;
  };
}

const pretty = (value: unknown): string => JSON.stringify(value, null, 2);

export function readonlyTransportPayload(value: SceneCurrentTransport | SceneSpinTransport): string {
  return pretty(value);
}

export {
  isKnownCurrentTransport,
  isKnownSpinTransport,
  transportIdentity,
  type TransportFamily,
} from "@/shared/domain/physics/transportRecognition";

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
    reciprocalNonlinear: pretty(value?.solver.reciprocal_nonlinear ?? {}),
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
  if (!draft.name.trim()) throw new Error("Name is required.");
  const model = draft.coupling === "bidirectional"
    ? "magnetoresistive_poisson"
    : draft.model;
  const resource: KnownSceneCurrentTransport = {
    kind: "current_transport",
    model,
    name: draft.name,
    coupling: draft.coupling,
  };
  if (model === "prescribed_density") {
    resource.current_density = json<number[]>(draft.currentDensity, "Current density");
    if (draft.solveRegion.trim()) resource.solve_region = draft.solveRegion.trim();
    return resource;
  }
  resource.domain = json(draft.domain, "Charge domain");
  resource.materials = json(draft.materials, "Charge materials");
  if (!Array.isArray(resource.materials)) throw new Error("Charge materials must be a JSON array.");
  if (draft.coupling === "bidirectional") {
    resource.materials.forEach((assignment, index) => {
      const material = assignment.material as {
        sigma_parallel_Spm?: unknown;
        sigma_perpendicular_Spm?: unknown;
        sigma_AHE_Spm?: unknown;
      };
      const sigmaParallel = Number(material.sigma_parallel_Spm);
      const sigmaPerpendicular = Number(material.sigma_perpendicular_Spm);
      const sigmaAhe = Number(material.sigma_AHE_Spm);
      if (!Number.isFinite(sigmaParallel)
        || sigmaParallel <= 0
        || !Number.isFinite(sigmaPerpendicular)
        || sigmaPerpendicular <= 0
        || !Number.isFinite(sigmaAhe)) {
        throw new Error(`Charge material ${index + 1}: bidirectional coupling requires finite sigma_parallel_Spm, sigma_perpendicular_Spm, and sigma_AHE_Spm.`);
      }
    });
  }
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
  if (!draft.currentSourceId.trim()) throw new Error("Current source id is required.");
  const requestedDiscretization = draft.executionDiscretization as string;
  const requestedExecutionMode = draft.executionMode as string;
  if (requestedDiscretization === "hybrid" || requestedExecutionMode === "hybrid") {
    throw new Error("Transport hybrid execution is not supported by the Python and planner contracts.");
  }
  const materials = json<SpinMaterialAssignmentDraftValue[]>(draft.materials, "Spin materials");
  if (!Array.isArray(materials)) throw new Error("Spin materials must be a JSON array.");
  materials.forEach(({ material }, index) => {
    const capacitance = material?.spin_capacitance_As_per_V_m3;
    const densityOfStates = material?.density_of_states_per_spin_Jinv_m3;
    const version = material?.capacitance_formula_version;
    const hasCapacitance = capacitance !== undefined && capacitance !== null;
    const hasDensityOfStates = densityOfStates !== undefined && densityOfStates !== null;
    const hasVersion = version !== undefined && version !== null;
    if ((hasCapacitance || hasDensityOfStates) !== hasVersion) {
      throw new Error(`Spin material ${index + 1}: spin capacitance/DOS and formula version must be authored together.`);
    }
    if (draft.mode === "transient" && !hasCapacitance && !hasDensityOfStates) {
      throw new Error(`Spin material ${index + 1}: transient mode requires spin_capacitance_As_per_V_m3 or density_of_states_per_spin_Jinv_m3 and capacitance_formula_version.`);
    }
    if (hasCapacitance && (typeof capacitance !== "number" || !Number.isFinite(capacitance) || capacitance <= 0)) {
      throw new Error(`Spin material ${index + 1}: spin_capacitance_As_per_V_m3 must be finite and greater than zero.`);
    }
    if (hasDensityOfStates && (typeof densityOfStates !== "number" || !Number.isFinite(densityOfStates) || densityOfStates <= 0)) {
      throw new Error(`Spin material ${index + 1}: density_of_states_per_spin_Jinv_m3 must be finite and greater than zero.`);
    }
    if (hasCapacitance && hasDensityOfStates) {
      const expected = ELEMENTARY_CHARGE_C ** 2 * (densityOfStates as number);
      const actual = capacitance as number;
      const tolerance = 1e-12 * Math.max(Math.abs(actual), Math.abs(expected), 1e-300);
      if (Math.abs(actual - expected) > tolerance) {
        throw new Error(`Spin material ${index + 1}: spin_capacitance_As_per_V_m3 must equal e^2 times density_of_states_per_spin_Jinv_m3.`);
      }
    }
    if (hasVersion && (typeof version !== "string" || version.trim() === "")) {
      throw new Error(`Spin material ${index + 1}: capacitance_formula_version must be a non-empty string.`);
    }
    if (hasVersion && version !== "dos_isotropic_nonmagnetic.fullmag.v1") {
      throw new Error(`Spin material ${index + 1}: unsupported capacitance_formula_version; expected dos_isotropic_nonmagnetic.fullmag.v1.`);
    }
  });
  const reciprocalNonlinear = json<Record<string, unknown>>(
    draft.reciprocalNonlinear,
    "Reciprocal nonlinear solver policy",
  );
  const hasReciprocalNonlinear = Object.keys(reciprocalNonlinear).length > 0;
  if (draft.constitutiveVersion === "transport_constitutive.reciprocal.fullmag.v1") {
    if (!hasReciprocalNonlinear) {
      throw new Error("Reciprocal M2 transport requires reciprocal_nonlinear solver policy.");
    }
    const gmresRestart = Number(reciprocalNonlinear.gmres_restart);
    const maxPicardIterations = Number(reciprocalNonlinear.max_picard_iterations);
    const relativeUpdateTolerance = Number(reciprocalNonlinear.relative_update_tolerance);
    const etaTransport = Number(reciprocalNonlinear.eta_transport);
    if (!Number.isInteger(gmresRestart) || gmresRestart <= 0
      || !Number.isInteger(maxPicardIterations) || maxPicardIterations <= 0
      || !Number.isFinite(relativeUpdateTolerance) || relativeUpdateTolerance <= 0
      || !Number.isFinite(etaTransport) || etaTransport <= 0 || etaTransport > 1) {
      throw new Error("Reciprocal nonlinear policy has invalid GMRES/Picard/tolerance parameters.");
    }
  } else if (hasReciprocalNonlinear) {
    throw new Error("reciprocal_nonlinear is valid only for reciprocal M2 transport.");
  }
  return {
    boundaries: json(draft.boundaries, "Spin boundaries"),
    constitutive_version: draft.constitutiveVersion.trim(),
    current_source_id: draft.currentSourceId,
    domain: json(draft.domain, "Spin domain"),
    id: draft.id,
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
      ...(hasReciprocalNonlinear
        ? { reciprocal_nonlinear: reciprocalNonlinear as NonNullable<KnownSceneSpinTransport["solver"]["reciprocal_nonlinear"]> }
        : {}),
    },
  };
}
