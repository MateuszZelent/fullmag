import type {
  AuthoringTransactionRequest,
  JsonObject,
} from "@/kernel/api/apiTypes";
import {
  resolveActiveLaneOperation,
  type ActiveLaneCapabilitySnapshot,
} from "@/kernel/resources/useActiveLaneCapabilities";

type JsonRecord = Record<string, unknown>;

const FDM_DEMAG_REALIZATIONS = [
  "auto",
  "single_grid",
  "multilayer_convolution",
] as const;

const FDM_ONLY_DEMAG_REALIZATIONS = [
  "single_grid",
  "multilayer_convolution",
] as const;

export const FDM_SINGLE_GRID_MULTI_BODY_REASON =
  "multi-body FDM currently supports only the multilayer_convolution strategy; 'single_grid' for multiple magnets is not yet executable";

export interface StudyGlobalDraft {
  demagEnabled: boolean;
  demagRealization: string;
  externalField: string;
  exchangeEnabled: boolean;
  femDemagSolverPolicy: string;
  fdm?: StudyFdmDraft;
  requestedBackend: string;
  requestedCpuThreads: string;
  requestedDevice: string;
  requestedMode: string;
  requestedPrecision: string;
  solver: StudySolverDraft;
}

export interface StudyFdmDraft {
  boundaryCorrection: string;
  boundaryDeltaMin: string;
  boundaryPhiFloor: string;
  commonCells: string;
  commonCellsXy: string;
  defaultCell: string;
  demagExplain: boolean;
  demagMode: string;
  demagStrategy: string;
  perMagnet: string;
}

export type FdmGridVector = [number, number, number];

export interface FdmGridPreviewEntry {
  objectId: string;
  cell: FdmGridVector;
  geometryExtent: FdmGridVector;
  extent: FdmGridVector;
  counts: FdmGridVector;
  cellCount: number;
}

export interface FdmGridPreview {
  lane: "fdm";
  entries: FdmGridPreviewEntry[];
  totalCellCount: number;
}

export interface StudyAdaptiveTimestepDraft {
  atol: string;
  dtInitial: string;
  dtMax: string;
  dtMin: string;
  growthLimit: string;
  maxSpinRotation: string;
  normTolerance: string;
  rtol: string;
  safety: string;
  shrinkLimit: string;
}

export interface StudySolverDraft {
  adaptiveTimestep: StudyAdaptiveTimestepDraft | null;
  demagInterval: string;
  dtInitial: string;
  dtMax: string;
  dtMin: string;
  energyTolerance: string;
  fixDt: string;
  integrator: string;
  maxErr: string;
  maxRelaxSteps: string;
  relaxAlgorithm: string;
  timestepMode: "adaptive_advanced" | "adaptive_max_error" | "auto" | "fixed";
  torqueTolerance: string;
}

export interface StudyGlobalDraftValidation {
  message: string;
  severity: "error" | "warning";
}

export interface StudyExecutionDiscretizationContext {
  baseRevision?: number | null;
  requestedBackend?: string | null;
  requestedDiscretization?: string | null;
  sessionDiscretization?: string | null;
}

/**
 * FDM-specific authoring follows the newest concrete discretization before
 * falling back to the current resolved session. Only `fdm` and `fem` settle
 * the lane; `auto`, `hybrid`, and unresolved values defer to the next source.
 */
export function isExplicitFdmStudy({
  requestedBackend,
  requestedDiscretization,
  sessionDiscretization,
}: StudyExecutionDiscretizationContext): boolean {
  const backend = normalizeDiscretization(requestedBackend);
  if (backend === "fdm") return true;
  if (backend === "fem") return false;

  const requestedLane = normalizeDiscretization(requestedDiscretization);
  if (requestedLane === "fdm") return true;
  if (requestedLane === "fem") return false;

  return normalizeDiscretization(sessionDiscretization) === "fdm";
}

const DEFAULT_STUDY_GLOBAL_DRAFT: StudyGlobalDraft = {
  demagEnabled: true,
  demagRealization: "auto",
  externalField: "",
  exchangeEnabled: true,
  femDemagSolverPolicy: "",
  requestedBackend: "auto",
  requestedCpuThreads: "",
  requestedDevice: "auto",
  requestedMode: "strict",
  requestedPrecision: "double",
  solver: createSolverDraft(null),
};

export function createStudyGlobalDraft(scene: unknown): StudyGlobalDraft {
  const study = asRecord(asRecord(scene)?.study);
  const requestedBackend = stringValue(
    study?.requested_backend,
    DEFAULT_STUDY_GLOBAL_DRAFT.requestedBackend,
  );
  const legacyDemagRealization = stringValue(
    study?.demag_realization,
    DEFAULT_STUDY_GLOBAL_DRAFT.demagRealization,
  );
  const fdm = asRecord(study?.fdm);
  return {
    demagEnabled: booleanValue(study?.demag_enabled, true),
    demagRealization: stringValue(
      asRecord(fdm?.demag)?.strategy,
      legacyDemagRealization,
    ),
    externalField: vectorText(
      study?.external_field,
      DEFAULT_STUDY_GLOBAL_DRAFT.externalField,
    ),
    exchangeEnabled: booleanValue(study?.exchange_enabled, true),
    femDemagSolverPolicy: objectText(study?.fem_demag_solver_policy),
    ...(normalizeDiscretization(requestedBackend) === "fdm"
      ? { fdm: createFdmDraft(fdm, legacyDemagRealization) }
      : {}),
    requestedBackend,
    requestedCpuThreads: scalarText(study?.requested_cpu_threads, ""),
    requestedDevice: stringValue(
      study?.requested_device,
      DEFAULT_STUDY_GLOBAL_DRAFT.requestedDevice,
    ),
    requestedMode: stringValue(
      study?.requested_mode,
      DEFAULT_STUDY_GLOBAL_DRAFT.requestedMode,
    ),
    requestedPrecision: stringValue(
      study?.requested_precision,
      DEFAULT_STUDY_GLOBAL_DRAFT.requestedPrecision,
    ),
    solver: createSolverDraft(study?.solver),
  };
}

export function validateStudyGlobalDraft(
  draft: StudyGlobalDraft,
  capabilities?: {
    activeLane?: ActiveLaneCapabilitySnapshot | null;
    algorithmsAvailable?: readonly string[];
    magneticObjectCount?: number;
    magneticObjectIds?: readonly string[];
    requestedDiscretization?: string | null;
    sessionDiscretization?: string | null;
  },
): StudyGlobalDraftValidation[] {
  const issues: StudyGlobalDraftValidation[] = [];
  if (capabilities?.activeLane !== undefined) {
    const operationReasons = new Set<string>();
    for (const operationId of [
      "study.relaxation",
      "study.time_integration",
    ] as const) {
      const operation = resolveActiveLaneOperation(
        capabilities.activeLane,
        operationId,
      );
      if (!operation.enabled && !operationReasons.has(operation.reason)) {
        operationReasons.add(operation.reason);
        issues.push({
          message: operation.reason,
          severity:
            operation.state === "semantic_only" || operation.state === "deferred"
              ? "warning"
              : "error",
        });
      }
    }
  }
  if (!draft.requestedBackend.trim()) {
    issues.push({ message: "Backend is required.", severity: "error" });
  }
  if (!draft.requestedDevice.trim()) {
    issues.push({ message: "Device is required.", severity: "error" });
  }
  if (!draft.requestedPrecision.trim()) {
    issues.push({ message: "Precision is required.", severity: "error" });
  }
  if (!draft.requestedMode.trim()) {
    issues.push({ message: "Execution mode is required.", severity: "error" });
  }
  if (draft.externalField.trim() && !optionalVector3(draft.externalField)) {
    issues.push({
      message: "External field must contain three finite numbers.",
      severity: "error",
    });
  }
  if (draft.requestedCpuThreads.trim()) {
    const threads = Number(draft.requestedCpuThreads.trim());
    if (!Number.isInteger(threads) || threads <= 0) {
      issues.push({
        message: "CPU threads must be a positive integer.",
        severity: "error",
      });
    }
  }
  validateSolverDraft(issues, draft.solver, draft, capabilities);
  const explicitFdm = isExplicitFdmStudy({
    requestedBackend: draft.requestedBackend,
    requestedDiscretization: capabilities?.requestedDiscretization,
    sessionDiscretization: capabilities?.sessionDiscretization,
  });
  if (explicitFdm) {
    validateFdmDraft(
      issues,
      draft.fdm,
      draft.demagRealization,
      capabilities?.magneticObjectIds,
    );
    if (
      capabilities?.magneticObjectCount !== undefined &&
      capabilities.magneticObjectCount > 1 &&
      fdmDemagStrategyForDraft(draft) === "single_grid"
    ) {
      issues.push({
        message: FDM_SINGLE_GRID_MULTI_BODY_REASON,
        severity: "error",
      });
    }
  } else {
    validateOptionalJsonObject(
      issues,
      draft.femDemagSolverPolicy,
      "FEM demag policy",
    );
  }
  return issues;
}

function fdmDemagStrategyForDraft(draft: StudyGlobalDraft): string {
  const strategy = draft.fdm?.demagStrategy;
  return normalizeDemagStrategy(
    strategy === "auto" ? draft.demagRealization : strategy ?? draft.demagRealization,
  );
}

export function buildStudyGlobalMergePatch(
  draft: StudyGlobalDraft,
  context: StudyExecutionDiscretizationContext = {},
): AuthoringTransactionRequest {
  const laneContext = {
    requestedBackend: context.requestedBackend ?? draft.requestedBackend,
    requestedDiscretization: context.requestedDiscretization,
    sessionDiscretization: context.sessionDiscretization,
  } satisfies StudyExecutionDiscretizationContext;
  const explicitFdm = isExplicitFdmStudy(laneContext);
  const normalizedDemagRealization = normalizeDemagRealizationForLane(
    draft.demagRealization,
    laneContext,
  );
  const study: JsonObject = {
    demag_enabled: draft.demagEnabled,
    demag_realization: explicitFdm ? null : normalizedDemagRealization,
    exchange_enabled: draft.exchangeEnabled,
    requested_backend: requiredText(draft.requestedBackend, "auto"),
    requested_device: requiredText(draft.requestedDevice, "auto"),
    requested_mode: requiredText(draft.requestedMode, "strict"),
    requested_precision: requiredText(draft.requestedPrecision, "double"),
  };
  if (explicitFdm) {
    study.fdm = fdmDraftToScene(
      draft.fdm ?? createFdmDraft(null, normalizedDemagRealization),
    );
  }
  study.external_field = optionalVector3(draft.externalField);
  study.fem_demag_solver_policy = explicitFdm
    ? null
    : optionalJsonObject(draft.femDemagSolverPolicy);
  const requestedCpuThreads = optionalPositiveInteger(draft.requestedCpuThreads);
  study.requested_cpu_threads = requestedCpuThreads;
  study.solver = solverDraftToScene(draft.solver);
  return {
    kind: "merge_patch",
    ...(context.baseRevision === undefined || context.baseRevision === null
      ? {}
      : { base_revision: context.baseRevision }),
    merge_patch: {
      study,
    },
  };
}

function createSolverDraft(value: unknown): StudySolverDraft {
  const solver = asRecord(value);
  const advanced = asRecord(solver?.adaptive_timestep);
  const fixDt = scalarText(solver?.fixed_timestep, "");
  const hasConvenienceAdaptive = ["dt_initial", "dt_min", "dt_max", "max_err"].some(
    (key) => solver?.[key] !== undefined && solver[key] !== null && solver[key] !== "",
  );
  return {
    adaptiveTimestep: advanced
      ? {
          atol: scalarText(advanced.atol, ""),
          dtInitial: scalarText(advanced.dt_initial, ""),
          dtMax: scalarText(advanced.dt_max, ""),
          dtMin: scalarText(advanced.dt_min, ""),
          growthLimit: scalarText(advanced.growth_limit, "2"),
          maxSpinRotation: scalarText(advanced.max_spin_rotation, ""),
          normTolerance: scalarText(advanced.norm_tolerance, ""),
          rtol: scalarText(advanced.rtol, ""),
          safety: scalarText(advanced.safety, "0.9"),
          shrinkLimit: scalarText(advanced.shrink_limit, "0.2"),
        }
      : null,
    demagInterval: scalarText(solver?.demag_interval_s, ""),
    dtInitial: scalarText(solver?.dt_initial, ""),
    dtMax: scalarText(solver?.dt_max, ""),
    dtMin: scalarText(solver?.dt_min, ""),
    energyTolerance: scalarText(solver?.energy_tolerance, ""),
    fixDt,
    integrator: scalarText(solver?.integrator, ""),
    maxErr: scalarText(solver?.max_err, ""),
    maxRelaxSteps: scalarText(solver?.max_relax_steps, ""),
    relaxAlgorithm: scalarText(solver?.relax_algorithm, ""),
    timestepMode: fixDt
      ? "fixed"
      : advanced
        ? "adaptive_advanced"
        : hasConvenienceAdaptive
          ? "adaptive_max_error"
          : "auto",
    torqueTolerance: scalarText(solver?.torque_tolerance, ""),
  };
}

function solverDraftToScene(draft: StudySolverDraft): JsonObject {
  const hasCommon = [
    draft.integrator,
    draft.demagInterval,
    draft.relaxAlgorithm,
    draft.torqueTolerance,
    draft.energyTolerance,
    draft.maxRelaxSteps,
  ].some((value) => value.trim());
  if (draft.timestepMode === "auto" && !hasCommon) return {};

  const solver: JsonObject = {
    adaptive_timestep: null,
    demag_interval_s: optionalNumericText(draft.demagInterval),
    dt_initial: null,
    dt_max: null,
    dt_min: null,
    energy_tolerance: draft.energyTolerance,
    fixed_timestep: null,
    integrator: draft.integrator,
    max_err: null,
    max_relax_steps: draft.maxRelaxSteps,
    relax_algorithm: draft.relaxAlgorithm,
    torque_tolerance: draft.torqueTolerance,
  };
  if (draft.timestepMode === "fixed") {
    solver.fixed_timestep = optionalNumericText(draft.fixDt);
  } else if (draft.timestepMode === "adaptive_max_error") {
    solver.dt_initial = optionalNumericText(draft.dtInitial);
    solver.dt_min = optionalNumericText(draft.dtMin);
    solver.dt_max = optionalNumericText(draft.dtMax);
    solver.max_err = optionalNumericText(draft.maxErr);
  } else if (draft.timestepMode === "adaptive_advanced") {
    const advanced = draft.adaptiveTimestep;
    solver.adaptive_timestep = advanced
      ? {
          atol: optionalNumericText(advanced.atol),
          rtol: optionalNumericText(advanced.rtol),
          dt_initial: optionalNumericText(advanced.dtInitial),
          dt_min: optionalNumericText(advanced.dtMin),
          dt_max: optionalNumericText(advanced.dtMax),
          safety: optionalNumericText(advanced.safety),
          growth_limit: optionalNumericText(advanced.growthLimit),
          shrink_limit: optionalNumericText(advanced.shrinkLimit),
          max_spin_rotation: optionalNumericText(advanced.maxSpinRotation),
          norm_tolerance: optionalNumericText(advanced.normTolerance),
        }
      : null;
  }
  return solver;
}

function createFdmDraft(
  value: JsonRecord | null,
  legacyStrategy: string,
): StudyFdmDraft {
  const fdm = value;
  const demag = asRecord(fdm?.demag);
  return {
    boundaryCorrection: stringValue(fdm?.boundary_correction, ""),
    boundaryDeltaMin: scalarText(fdm?.boundary_delta_min, ""),
    boundaryPhiFloor: scalarText(fdm?.boundary_phi_floor, ""),
    commonCells: vectorTextOfLength(demag?.common_cells, 3),
    commonCellsXy: vectorTextOfLength(demag?.common_cells_xy, 2),
    defaultCell: vectorText(fdm?.default_cell, ""),
    demagExplain: booleanValue(demag?.explain, true),
    demagMode: stringValue(demag?.mode, "auto"),
    demagStrategy: stringValue(demag?.strategy, legacyStrategy || "auto"),
    perMagnet: objectText(fdm?.per_magnet ?? fdm?.per_object_grid),
  };
}

function fdmDraftToScene(draft: StudyFdmDraft): JsonObject {
  const demag: JsonObject = {
    strategy: normalizeDemagStrategy(draft.demagStrategy),
    mode: normalizeDemagMode(draft.demagMode),
    common_cells: optionalPositiveIntegerVector(draft.commonCells, 3),
    common_cells_xy: optionalPositiveIntegerVector(draft.commonCellsXy, 2),
    explain: draft.demagExplain,
  };
  return {
    default_cell: optionalVector3(draft.defaultCell),
    per_magnet: optionalJsonObject(draft.perMagnet),
    demag,
    boundary_correction: draft.boundaryCorrection.trim() || null,
    boundary_phi_floor: optionalNumber(draft.boundaryPhiFloor),
    boundary_delta_min: optionalNumber(draft.boundaryDeltaMin),
  };
}

/**
 * Calculate the structured-grid coverage implied by the authored FDM policy.
 * This is a preview only: no mesh/topology resource is materialized here.
 */
export function resolveFdmGridPreview(
  scene: unknown,
  draft: StudyGlobalDraft,
): FdmGridPreview {
  const objects = asRecord(scene)?.objects;
  if (!Array.isArray(objects)) {
    return { lane: "fdm", entries: [], totalCellCount: 0 };
  }
  const fdm = draft.fdm;
  if (!fdm) return { lane: "fdm", entries: [], totalCellCount: 0 };

  const defaultCell = optionalPositiveVector3(fdm.defaultCell);
  const overrides = parseFdmPerMagnetOverrides(fdm.perMagnet);
  const entries: FdmGridPreviewEntry[] = [];
  for (const rawObject of objects) {
    const object = asRecord(rawObject);
    if (object?.role !== "magnet") continue;
    const objectId = typeof object.id === "string" ? object.id.trim() : "";
    if (!objectId) continue;
    const cell = overrides[objectId] ?? defaultCell;
    if (!cell) continue;
    const geometryExtent = geometryExtentForFdmPreview(object);
    if (!geometryExtent || geometryExtent.some((value) => value <= 0)) continue;
    const counts = geometryExtent.map((extent, index) =>
      Math.max(1, Math.ceil(extent / cell[index])),
    ) as FdmGridVector;
    const extent = counts.map((count, index) =>
      Number((count * cell[index]).toPrecision(15)),
    ) as FdmGridVector;
    const cellCount = counts[0] * counts[1] * counts[2];
    entries.push({ objectId, cell, geometryExtent, extent, counts, cellCount });
  }
  return {
    lane: "fdm",
    entries,
    totalCellCount: entries.reduce((total, entry) => total + entry.cellCount, 0),
  };
}

function parseFdmPerMagnetOverrides(
  value: string,
): Record<string, FdmGridVector> {
  if (!value.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const overrides: Record<string, FdmGridVector> = {};
  for (const [objectId, rawOverride] of Object.entries(parsed)) {
    const cell = optionalPositiveVector3Value(asRecord(rawOverride)?.cell);
    if (cell) overrides[objectId] = cell;
  }
  return overrides;
}

function geometryExtentForFdmPreview(object: JsonRecord): FdmGridVector | null {
  const geometry = asRecord(object.geometry);
  const params = asRecord(geometry?.geometry_params);
  const boundsMin = finiteVector3Value(geometry?.bounds_min);
  const boundsMax = finiteVector3Value(geometry?.bounds_max);
  if (boundsMin && boundsMax) {
    const bounds = boundsMax.map((value, index) => value - boundsMin[index]) as FdmGridVector;
    if (bounds.every((value) => value > 0)) return bounds;
  }

  const geometryKind = String(geometry?.geometry_kind ?? geometry?.kind ?? "").toLowerCase();
  const paramsSize = finiteVector3Value(params?.size ?? params?.dimensions);
  if (paramsSize && paramsSize.every((value) => value > 0)) return paramsSize;
  if (geometryKind === "cylinder") {
    const radius = finitePositiveNumber(params?.radius);
    const height = finitePositiveNumber(params?.height);
    return radius !== null && height !== null
      ? [radius * 2, radius * 2, height]
      : null;
  }
  if (geometryKind === "sphere") {
    const radius = finitePositiveNumber(params?.radius);
    return radius === null ? null : [radius * 2, radius * 2, radius * 2];
  }
  if (geometryKind === "archwaveguide" || geometryKind === "arch_waveguide") {
    const length = finitePositiveNumber(params?.length);
    const width = finitePositiveNumber(params?.width);
    const height = finitePositiveNumber(params?.height);
    const archHeight = finitePositiveNumber(params?.arch_height);
    return length !== null && width !== null && height !== null && archHeight !== null
      ? [length, width, height + archHeight]
      : null;
  }
  return null;
}

function validateFdmDraft(
  issues: StudyGlobalDraftValidation[],
  draft: StudyFdmDraft | undefined,
  legacyStrategy: string,
  magneticObjectIds?: readonly string[],
): void {
  const effective = draft ?? createFdmDraft(null, legacyStrategy);
  const strategy = normalizeDemagStrategy(
    effective.demagStrategy === "auto" ? legacyStrategy : effective.demagStrategy,
  );
  const strategyValid = FDM_DEMAG_REALIZATIONS.includes(
    strategy as (typeof FDM_DEMAG_REALIZATIONS)[number],
  );
  if (!strategyValid) {
    issues.push({
      message:
        "FDM demag realization must be auto, single_grid, or multilayer_convolution.",
      severity: "error",
    });
  }
  const mode = normalizeDemagMode(effective.demagMode);
  if (!(mode === "auto" || mode === "two_d_stack" || mode === "three_d")) {
    issues.push({
      message: "FDM demag mode must be auto, two_d_stack, or three_d.",
      severity: "error",
    });
  }
  const commonCells = optionalPositiveIntegerVector(effective.commonCells, 3);
  const commonCellsXy = optionalPositiveIntegerVector(effective.commonCellsXy, 2);
  if (effective.commonCells.trim() && !commonCells) {
    issues.push({
      message: "FDM common_cells must contain three positive integers.",
      severity: "error",
    });
  }
  if (effective.commonCellsXy.trim() && !commonCellsXy) {
    issues.push({
      message: "FDM common_cells_xy must contain two positive integers.",
      severity: "error",
    });
  }
  if (commonCells && commonCellsXy) {
    issues.push({
      message: "FDM common_cells and common_cells_xy are mutually exclusive.",
      severity: "error",
    });
  }
  if (mode === "two_d_stack" && commonCells) {
    issues.push({
      message: "FDM common_cells is incompatible with two_d_stack mode.",
      severity: "error",
    });
  }
  if (mode === "three_d" && commonCellsXy) {
    issues.push({
      message: "FDM common_cells_xy is incompatible with three_d mode.",
      severity: "error",
    });
  }
  if (effective.boundaryCorrection.trim() && !["none", "volume", "full"].includes(effective.boundaryCorrection.trim())) {
    issues.push({
      message: "FDM boundary correction must be none, volume, or full.",
      severity: "error",
    });
  }
  if (effective.boundaryPhiFloor.trim()) {
    const value = Number(effective.boundaryPhiFloor);
    if (!Number.isFinite(value) || value <= 0 || value >= 1) {
      issues.push({
        message: "FDM boundary phi floor must be between zero and one.",
        severity: "error",
      });
    }
  }
  if (effective.boundaryDeltaMin.trim()) {
    const value = Number(effective.boundaryDeltaMin);
    if (!Number.isFinite(value) || value < 0) {
      issues.push({
        message: "FDM boundary delta minimum must be finite and nonnegative.",
        severity: "error",
      });
    }
  }
  if (effective.defaultCell.trim() && !optionalPositiveVector3(effective.defaultCell)) {
    issues.push({
      message: "FDM default cell must contain three finite positive SI values.",
      severity: "error",
    });
  }
  validateOptionalJsonObject(issues, effective.perMagnet, "FDM per-magnet grids");
  validateFdmPerMagnetOverrides(issues, effective.perMagnet, magneticObjectIds);
  if (strategyValid && !effective.defaultCell.trim() && !effective.perMagnet.trim()) {
    issues.push({
      message: "FDM requires a default cell or per-magnet grid specification.",
      severity: "error",
    });
  }
}

function validateFdmPerMagnetOverrides(
  issues: StudyGlobalDraftValidation[],
  value: string,
  magneticObjectIds?: readonly string[],
): void {
  if (!value.trim()) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const knownIds = magneticObjectIds ? new Set(magneticObjectIds) : null;
  for (const [objectId, rawOverride] of Object.entries(parsed)) {
    if (knownIds && !knownIds.has(objectId)) {
      issues.push({
        message: `FDM per-magnet grid ${objectId} does not match a magnetic object_id.`,
        severity: "error",
      });
    }
    const override = asRecord(rawOverride);
    const cell = override?.cell;
    if (!optionalPositiveVector3Value(cell)) {
      issues.push({
        message: `FDM per-magnet grid ${objectId} cell must contain three finite positive SI values.`,
        severity: "error",
      });
    }
  }
}

function validateSolverDraft(
  issues: StudyGlobalDraftValidation[],
  draft: StudySolverDraft,
  execution: Pick<
    StudyGlobalDraft,
    "requestedBackend" | "requestedDevice" | "requestedPrecision"
  >,
  capabilities?: { algorithmsAvailable?: readonly string[] },
): void {
  if (draft.timestepMode === "fixed") {
    validatePositiveText(issues, draft.fixDt, "Fixed dt");
    return;
  }
  if (draft.timestepMode === "adaptive_max_error") {
    validateAdaptiveExecution(issues, draft.integrator, execution, capabilities);
    validatePositiveText(issues, draft.dtMin, "Adaptive dt min");
    validatePositiveText(issues, draft.dtMax, "Adaptive dt max");
    validatePositiveText(issues, draft.maxErr, "Maximum embedded vector error");
    validateOptionalPositiveText(issues, draft.dtInitial, "Initial dt");
    validateAdaptiveBounds(issues, draft.dtInitial, draft.dtMin, draft.dtMax);
    return;
  }
  if (draft.timestepMode === "adaptive_advanced") {
    validateAdaptiveExecution(issues, draft.integrator, execution, capabilities);
    if (!draft.adaptiveTimestep) {
      issues.push({ message: "Advanced adaptive policy is required.", severity: "error" });
      return;
    }
    const advanced = draft.adaptiveTimestep;
    validateNonnegativeText(issues, advanced.atol, "Absolute tolerance");
    validateNonnegativeText(issues, advanced.rtol, "Relative tolerance");
    if (parseNumericText(advanced.atol) === 0 && parseNumericText(advanced.rtol) === 0) {
      issues.push({ message: "At least one advanced tolerance must be positive.", severity: "error" });
    }
    validatePositiveText(issues, advanced.dtMin, "Adaptive dt min");
    validatePositiveText(issues, advanced.dtMax, "Adaptive dt max");
    validateOptionalPositiveText(issues, advanced.dtInitial, "Initial dt");
    validateAdaptiveBounds(issues, advanced.dtInitial, advanced.dtMin, advanced.dtMax);
    validateController(issues, advanced);
  }
}

function validateAdaptiveExecution(
  issues: StudyGlobalDraftValidation[],
  integrator: string,
  execution: Pick<
    StudyGlobalDraft,
    "requestedBackend" | "requestedDevice" | "requestedPrecision"
  >,
  capabilities?: { algorithmsAvailable?: readonly string[] },
): void {
  if (!matchesAdaptiveIntegrator(integrator)) {
    issues.push({ message: "Adaptive policy requires RK23 or RK45.", severity: "error" });
  }
  if (
    capabilities?.algorithmsAvailable !== undefined &&
    !capabilities.algorithmsAvailable.includes("llg_overdamped")
  ) {
    issues.push({ message: "LLG is not advertised by the active session.", severity: "error" });
  }
  if (
    execution.requestedBackend.trim() &&
    execution.requestedBackend !== "fem" &&
    execution.requestedDevice !== "cpu"
  ) {
    issues.push({
      message: "Adaptive FDM execution requires an explicit CPU device.",
      severity: "error",
    });
  }
  if (execution.requestedPrecision !== "double") {
    issues.push({
      message: "Adaptive execution is qualified only for double precision.",
      severity: "error",
    });
  }
}

function matchesAdaptiveIntegrator(integrator: string): boolean {
  return integrator === "rk23" || integrator === "rk45";
}

function validateController(
  issues: StudyGlobalDraftValidation[],
  adaptive: StudyAdaptiveTimestepDraft,
): void {
  validatePositiveText(issues, adaptive.safety, "Adaptive safety");
  validatePositiveText(issues, adaptive.growthLimit, "Adaptive growth limit");
  validatePositiveText(issues, adaptive.shrinkLimit, "Adaptive shrink limit");
  validateOptionalPositiveText(issues, adaptive.maxSpinRotation, "Max spin rotation");
  validateOptionalPositiveText(issues, adaptive.normTolerance, "Norm tolerance");
  const safety = parseNumericText(adaptive.safety);
  const growth = parseNumericText(adaptive.growthLimit);
  const shrink = parseNumericText(adaptive.shrinkLimit);
  if (Number.isFinite(safety) && safety > 1) {
    issues.push({ message: "Adaptive safety must be at most one.", severity: "error" });
  }
  if (Number.isFinite(growth) && growth <= 1) {
    issues.push({ message: "Adaptive growth limit must be greater than one.", severity: "error" });
  }
  if (Number.isFinite(shrink) && shrink >= 1) {
    issues.push({ message: "Adaptive shrink limit must be less than one.", severity: "error" });
  }
}

function validateAdaptiveBounds(
  issues: StudyGlobalDraftValidation[],
  initial: string,
  minimum: string,
  maximum: string,
): void {
  const min = parseNumericText(minimum);
  const max = maximum.trim() ? parseNumericText(maximum) : null;
  if (Number.isFinite(min) && max !== null && Number.isFinite(max) && max < min) {
    issues.push({
      message: "Adaptive dt max must be greater than or equal to dt min.",
      severity: "error",
    });
  }
  const first = initial.trim() ? parseNumericText(initial) : null;
  if (
    first !== null &&
    Number.isFinite(first) &&
    (min === null || first < min || (max !== null && first > max))
  ) {
    issues.push({ message: "Initial dt must lie within adaptive bounds.", severity: "error" });
  }
}

function validatePositiveText(
  issues: StudyGlobalDraftValidation[],
  value: string,
  label: string,
): void {
  const parsed = parseNumericText(value);
  if (!value.trim() || !Number.isFinite(parsed) || parsed <= 0) {
    issues.push({ message: `${label} must be finite and positive.`, severity: "error" });
  }
}

function validateOptionalPositiveText(
  issues: StudyGlobalDraftValidation[],
  value: string,
  label: string,
): void {
  if (value.trim()) validatePositiveText(issues, value, label);
}

function validateNonnegativeText(
  issues: StudyGlobalDraftValidation[],
  value: string,
  label: string,
): void {
  const parsed = parseNumericText(value);
  if (!value.trim() || !Number.isFinite(parsed) || parsed < 0) {
    issues.push({ message: `${label} must be finite and nonnegative.`, severity: "error" });
  }
}

function optionalNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function optionalNumericText(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return parseNumericText(trimmed) === null ? null : trimmed;
}

const NUMERIC_TEXT_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function parseNumericText(value: string): number | null {
  const trimmed = value.trim();
  if (!NUMERIC_TEXT_PATTERN.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function objectText(value: unknown): string {
  return value === null || value === undefined ? "" : JSON.stringify(value);
}

function scalarText(value: unknown, fallback: string): string {
  if (typeof value === "number" || typeof value === "string") {
    return String(value);
  }
  return fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function vectorText(value: unknown, fallback: string): string {
  return Array.isArray(value) && value.length === 3
    ? value.join(", ")
    : scalarText(value, fallback);
}

function vectorTextOfLength(value: unknown, length: number): string {
  return Array.isArray(value) && value.length === length ? value.join(", ") : "";
}

function requiredText(value: string, fallback: string): string {
  return value.trim() || fallback;
}

function normalizeDiscretization(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}

function normalizeDemagRealization(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeDemagStrategy(value: string): string {
  return normalizeDemagRealization(value) || "auto";
}

function normalizeDemagMode(value: string): string {
  return normalizeDemagRealization(value) || "auto";
}

/**
 * Keep an FDM-only strategy from crossing into a FEM lane when a user changes
 * backend/discretization in a staged draft. The UI and merge-patch builder
 * share this canonicalization so a stale select value cannot be committed.
 */
export function normalizeDemagRealizationForLane(
  value: string,
  context: StudyExecutionDiscretizationContext,
): string {
  const normalized = normalizeDemagRealization(value);
  if (!normalized) return "auto";
  if (isExplicitFdmStudy(context)) {
    return FDM_DEMAG_REALIZATIONS.includes(
      normalized as (typeof FDM_DEMAG_REALIZATIONS)[number],
    )
      ? normalized
      : "auto";
  }
  return FDM_ONLY_DEMAG_REALIZATIONS.includes(
    normalized as (typeof FDM_ONLY_DEMAG_REALIZATIONS)[number],
  )
    ? "auto"
    : normalized;
}

function optionalVector3(value: string): number[] | null {
  const values: number[] = [];
  for (const token of value.split(/[,\s]+/)) {
    const entry = token.trim();
    if (!entry) continue;
    values.push(Number(entry));
  }
  return values.length === 3 && values.every(Number.isFinite) ? values : null;
}

function optionalPositiveVector3(value: string): FdmGridVector | null {
  return optionalPositiveVector3Value(
    value
      .split(/[;,\s]+/)
      .map((token) => token.trim())
      .filter(Boolean)
      .map((token) => Number(token)),
  );
}

function optionalPositiveVector3Value(value: unknown): FdmGridVector | null {
  const values = finiteVector3Value(value);
  return values && values.every((entry) => entry > 0) ? values : null;
}

function finiteVector3Value(value: unknown): FdmGridVector | null {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  ) {
    return null;
  }
  return value as FdmGridVector;
}

function finitePositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function optionalPositiveIntegerVector(value: string, length: number): number[] | null {
  const values: number[] = [];
  for (const token of value.split(/[,\s]+/)) {
    const entry = token.trim();
    if (!entry) continue;
    const parsed = Number(entry);
    if (!Number.isInteger(parsed) || parsed <= 0) return null;
    values.push(parsed);
  }
  return values.length === length ? values : null;
}

function optionalJsonObject(value: string): JsonObject | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed as JsonObject;
}

function optionalPositiveInteger(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function validateOptionalJsonObject(
  issues: StudyGlobalDraftValidation[],
  value: string,
  label: string,
): void {
  if (!value.trim()) return;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      issues.push({
        message: `${label} must be a JSON object.`,
        severity: "error",
      });
    }
  } catch {
    issues.push({
      message: `${label} must be a JSON object.`,
      severity: "error",
    });
  }
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function asRecord(value: unknown): JsonRecord | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}
