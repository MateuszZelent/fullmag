import type {
  AuthoringTransactionRequest,
  JsonObject,
} from "@/kernel/api/apiTypes";

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

export interface StudyGlobalDraft {
  demagEnabled: boolean;
  demagRealization: string;
  externalField: string;
  exchangeEnabled: boolean;
  femDemagSolverPolicy: string;
  requestedBackend: string;
  requestedCpuThreads: string;
  requestedDevice: string;
  requestedMode: string;
  requestedPrecision: string;
  solver: StudySolverDraft;
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
  requestedBackend?: string | null;
  requestedDiscretization?: string | null;
  sessionDiscretization?: string | null;
}

/**
 * FDM-specific authoring is enabled only when the lane is explicit in the
 * request or in the current session. An `auto` value never becomes FDM by
 * inference; the current session may still report an explicit resolved lane.
 */
export function isExplicitFdmStudy({
  requestedBackend,
  requestedDiscretization,
  sessionDiscretization,
}: StudyExecutionDiscretizationContext): boolean {
  return [
    requestedBackend,
    requestedDiscretization,
    sessionDiscretization,
  ].some((value) => normalizeDiscretization(value) === "fdm");
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
  return {
    demagEnabled: booleanValue(study?.demag_enabled, true),
    demagRealization: stringValue(
      study?.demag_realization,
      DEFAULT_STUDY_GLOBAL_DRAFT.demagRealization,
    ),
    externalField: vectorText(
      study?.external_field,
      DEFAULT_STUDY_GLOBAL_DRAFT.externalField,
    ),
    exchangeEnabled: booleanValue(study?.exchange_enabled, true),
    femDemagSolverPolicy: objectText(study?.fem_demag_solver_policy),
    requestedBackend: stringValue(
      study?.requested_backend,
      DEFAULT_STUDY_GLOBAL_DRAFT.requestedBackend,
    ),
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
    algorithmsAvailable?: readonly string[];
    requestedDiscretization?: string | null;
    sessionDiscretization?: string | null;
  },
): StudyGlobalDraftValidation[] {
  const issues: StudyGlobalDraftValidation[] = [];
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
    if (
      !FDM_DEMAG_REALIZATIONS.includes(
        normalizeDemagRealization(draft.demagRealization) as (typeof FDM_DEMAG_REALIZATIONS)[number],
      )
    ) {
      issues.push({
        message:
          "FDM demag realization must be auto, single_grid, or multilayer_convolution.",
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
  const study: JsonObject = {
    demag_enabled: draft.demagEnabled,
    demag_realization: normalizeDemagRealizationForLane(
      draft.demagRealization,
      laneContext,
    ),
    exchange_enabled: draft.exchangeEnabled,
    requested_backend: requiredText(draft.requestedBackend, "auto"),
    requested_device: requiredText(draft.requestedDevice, "auto"),
    requested_mode: requiredText(draft.requestedMode, "strict"),
    requested_precision: requiredText(draft.requestedPrecision, "double"),
  };
  study.external_field = optionalVector3(draft.externalField);
  study.fem_demag_solver_policy = explicitFdm
    ? null
    : optionalJsonObject(draft.femDemagSolverPolicy);
  const requestedCpuThreads = optionalPositiveInteger(draft.requestedCpuThreads);
  study.requested_cpu_threads = requestedCpuThreads;
  study.solver = solverDraftToScene(draft.solver);
  return {
    kind: "merge_patch",
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
    demag_interval_s: optionalNumber(draft.demagInterval),
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
    solver.fixed_timestep = optionalNumber(draft.fixDt);
  } else if (draft.timestepMode === "adaptive_max_error") {
    solver.dt_initial = optionalNumber(draft.dtInitial);
    solver.dt_min = optionalNumber(draft.dtMin);
    solver.dt_max = optionalNumber(draft.dtMax);
    solver.max_err = optionalNumber(draft.maxErr);
  } else if (draft.timestepMode === "adaptive_advanced") {
    const advanced = draft.adaptiveTimestep;
    solver.adaptive_timestep = advanced
      ? {
          atol: optionalNumber(advanced.atol),
          rtol: optionalNumber(advanced.rtol),
          dt_initial: optionalNumber(advanced.dtInitial),
          dt_min: optionalNumber(advanced.dtMin),
          dt_max: optionalNumber(advanced.dtMax),
          safety: optionalNumber(advanced.safety),
          growth_limit: optionalNumber(advanced.growthLimit),
          shrink_limit: optionalNumber(advanced.shrinkLimit),
          max_spin_rotation: optionalNumber(advanced.maxSpinRotation),
          norm_tolerance: optionalNumber(advanced.normTolerance),
        }
      : null;
  }
  return solver;
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
    if (Number(advanced.atol) === 0 && Number(advanced.rtol) === 0) {
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
  const safety = Number(adaptive.safety);
  const growth = Number(adaptive.growthLimit);
  const shrink = Number(adaptive.shrinkLimit);
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
  const min = Number(minimum);
  const max = maximum.trim() ? Number(maximum) : null;
  if (Number.isFinite(min) && max !== null && Number.isFinite(max) && max < min) {
    issues.push({
      message: "Adaptive dt max must be greater than or equal to dt min.",
      severity: "error",
    });
  }
  const first = initial.trim() ? Number(initial) : null;
  if (
    first !== null &&
    Number.isFinite(first) &&
    (first < min || (max !== null && first > max))
  ) {
    issues.push({ message: "Initial dt must lie within adaptive bounds.", severity: "error" });
  }
}

function validatePositiveText(
  issues: StudyGlobalDraftValidation[],
  value: string,
  label: string,
): void {
  const parsed = Number(value);
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
  const parsed = Number(value);
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
