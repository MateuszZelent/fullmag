import type { AuthoringTransactionRequest, JsonObject } from "@/kernel/api/apiTypes";

type JsonRecord = Record<string, unknown>;

export type StudyStageDraftKind =
  | "eigenmodes"
  | "frequency_response"
  | "hysteresis"
  | "relax"
  | "run"
  | "save_state";

export interface StudyStageDraft {
  algorithm: string;
  artifactName: string;
  bc: string;
  count: string;
  dampingPolicy: string;
  dataset: string;
  dt: string;
  dtMin: string;
  energyTolerance: string;
  equilibriumArtifact: string;
  equilibriumSource: string;
  excitationField: string;
  fieldEvery: string;
  fieldSteps: string;
  format: string;
  frequenciesHz: string;
  includeDemag: boolean;
  kind: StudyStageDraftKind;
  kSampling: string;
  kVector: string;
  maxError: string;
  maxPhysicalTime: string;
  maxPseudotime: string;
  maxSteps: string;
  normalization: string;
  observable: string;
  relaxAlpha: string;
  solver: string;
  stageId: string;
  startField: string;
  stopField: string;
  target: string;
  targetFrequency: string;
  torqueTolerance: string;
  untilSeconds: string;
}

export interface StudyStageDraftValidation {
  message: string;
  severity: "error" | "warning";
}

const DEFAULT_RELAX_STAGE_DRAFT: StudyStageDraft = {
  algorithm: "llg_overdamped",
  artifactName: "state_snapshot",
  bc: "free",
  count: "10",
  dampingPolicy: "ignore",
  dataset: "",
  dt: "auto",
  dtMin: "",
  energyTolerance: "",
  equilibriumArtifact: "",
  equilibriumSource: "relax",
  excitationField: "0, 0, 1",
  fieldEvery: "",
  fieldSteps: "",
  format: "",
  frequenciesHz: "1e9",
  includeDemag: true,
  kind: "relax",
  kSampling: "",
  kVector: "",
  maxError: "",
  maxPhysicalTime: "",
  maxPseudotime: "",
  maxSteps: "50000",
  normalization: "unit_l2",
  observable: "susceptibility_tensor",
  relaxAlpha: "1",
  solver: "rk23",
  stageId: "",
  startField: "0, 0, -0.1",
  stopField: "0, 0, 0.1",
  target: "lowest",
  targetFrequency: "",
  torqueTolerance: "1e-6",
  untilSeconds: "",
};

const DEFAULT_RUN_STAGE_DRAFT: StudyStageDraft = {
  algorithm: "llg_overdamped",
  artifactName: "state_snapshot",
  bc: "free",
  count: "10",
  dampingPolicy: "ignore",
  dataset: "",
  dt: "auto",
  dtMin: "",
  energyTolerance: "",
  equilibriumArtifact: "",
  equilibriumSource: "relax",
  excitationField: "0, 0, 1",
  fieldEvery: "",
  fieldSteps: "",
  format: "",
  frequenciesHz: "1e9",
  includeDemag: true,
  kind: "run",
  kSampling: "",
  kVector: "",
  maxError: "",
  maxPhysicalTime: "",
  maxPseudotime: "",
  maxSteps: "",
  normalization: "unit_l2",
  observable: "susceptibility_tensor",
  relaxAlpha: "",
  solver: "",
  stageId: "",
  startField: "0, 0, -0.1",
  stopField: "0, 0, 0.1",
  target: "lowest",
  targetFrequency: "",
  torqueTolerance: "",
  untilSeconds: "1e-9",
};

const DEFAULT_EIGENMODES_STAGE_DRAFT: StudyStageDraft = {
  ...DEFAULT_RELAX_STAGE_DRAFT,
  algorithm: "",
  dt: "",
  kind: "eigenmodes",
  maxSteps: "",
  relaxAlpha: "",
  solver: "",
  torqueTolerance: "",
};

const DEFAULT_FREQUENCY_RESPONSE_STAGE_DRAFT: StudyStageDraft = {
  ...DEFAULT_EIGENMODES_STAGE_DRAFT,
  equilibriumSource: "provided",
  kind: "frequency_response",
};

const DEFAULT_SAVE_STATE_STAGE_DRAFT: StudyStageDraft = {
  ...DEFAULT_RUN_STAGE_DRAFT,
  kind: "save_state",
  untilSeconds: "",
};

const DEFAULT_HYSTERESIS_STAGE_DRAFT: StudyStageDraft = {
  ...DEFAULT_RELAX_STAGE_DRAFT,
  algorithm: "",
  dt: "",
  fieldSteps: "21",
  kind: "hysteresis",
  maxSteps: "",
  relaxAlpha: "",
  solver: "",
  startField: "0, 0, -0.1",
  stopField: "0, 0, 0.1",
};

export function createStudyStageDraft(
  stage: unknown,
  index: number,
): StudyStageDraft {
  const record = asRecord(stage);
  const kind = stageKind(record);
  if (kind === "run") {
    return {
      ...DEFAULT_RUN_STAGE_DRAFT,
      stageId: stringValue(record?.stage_id ?? record?.id, `stage-${index + 1}`),
      untilSeconds: scalarText(
        record?.until_seconds ??
          record?.until ??
          record?.max_physical_time_s,
        DEFAULT_RUN_STAGE_DRAFT.untilSeconds,
      ),
    };
  }
  if (kind === "eigenmodes") {
    return spectralDraft(DEFAULT_EIGENMODES_STAGE_DRAFT, record, index);
  }
  if (kind === "frequency_response") {
    return {
      ...spectralDraft(DEFAULT_FREQUENCY_RESPONSE_STAGE_DRAFT, record, index),
      excitationField: vectorText(record?.excitation_field_au_per_m, "0, 0, 1"),
      frequenciesHz: listText(record?.frequencies_hz, DEFAULT_FREQUENCY_RESPONSE_STAGE_DRAFT.frequenciesHz),
      observable: scalarText(record?.observable, DEFAULT_FREQUENCY_RESPONSE_STAGE_DRAFT.observable),
    };
  }
  if (kind === "save_state") {
    return {
      ...DEFAULT_SAVE_STATE_STAGE_DRAFT,
      artifactName: scalarText(
        record?.artifact_name,
        DEFAULT_SAVE_STATE_STAGE_DRAFT.artifactName,
      ),
      dataset: scalarText(record?.dataset, ""),
      format: scalarText(record?.format, ""),
      stageId: stringValue(record?.stage_id ?? record?.id, `stage-${index + 1}`),
    };
  }
  if (kind === "hysteresis") {
    return {
      ...DEFAULT_HYSTERESIS_STAGE_DRAFT,
      fieldSteps: scalarText(
        record?.field_steps ?? record?.steps ?? record?.hysteresis_steps,
        DEFAULT_HYSTERESIS_STAGE_DRAFT.fieldSteps,
      ),
      stageId: stringValue(record?.stage_id ?? record?.id, `stage-${index + 1}`),
      startField: vectorText(
        record?.start_field ?? record?.hysteresis_start_field,
        DEFAULT_HYSTERESIS_STAGE_DRAFT.startField,
      ),
      stopField: vectorText(
        record?.stop_field ?? record?.hysteresis_stop_field,
        DEFAULT_HYSTERESIS_STAGE_DRAFT.stopField,
      ),
      torqueTolerance: scalarText(
        record?.torque_tolerance ??
          record?.hysteresis_torque_tolerance ??
          record?.torque_tolerance_apm,
        DEFAULT_HYSTERESIS_STAGE_DRAFT.torqueTolerance,
      ),
    };
  }

  return {
    ...DEFAULT_RELAX_STAGE_DRAFT,
    algorithm: scalarText(
      record?.algorithm ?? record?.relax_algorithm,
      DEFAULT_RELAX_STAGE_DRAFT.algorithm,
    ),
    dt: scalarText(record?.dt, DEFAULT_RELAX_STAGE_DRAFT.dt),
    dtMin: scalarText(record?.dt_min, ""),
    energyTolerance: scalarText(record?.energy_tolerance, ""),
    fieldEvery: scalarText(
      asRecord(record?.field_refresh)?.every_n ??
        record?.field_every_n,
      "",
    ),
    kind: "relax",
    maxError: scalarText(record?.max_error, ""),
    maxPhysicalTime: scalarText(record?.max_physical_time_s, ""),
    maxPseudotime: scalarText(record?.max_pseudotime_s, ""),
    maxSteps: scalarText(record?.max_steps, DEFAULT_RELAX_STAGE_DRAFT.maxSteps),
    relaxAlpha: scalarText(record?.relax_alpha, DEFAULT_RELAX_STAGE_DRAFT.relaxAlpha),
    solver: scalarText(record?.solver, DEFAULT_RELAX_STAGE_DRAFT.solver),
    stageId: stringValue(record?.stage_id ?? record?.id, `stage-${index + 1}`),
    torqueTolerance: scalarText(
      record?.torque_tolerance ??
        record?.torque_tolerance_apm ??
        record?.tol,
      DEFAULT_RELAX_STAGE_DRAFT.torqueTolerance,
    ),
    untilSeconds: scalarText(
      record?.until_seconds ??
        record?.max_physical_time_s ??
        record?.max_pseudotime_s,
      "",
    ),
  };
}

export function createDefaultStudyStageDraft(
  kind: StudyStageDraftKind,
  stageCount: number,
): StudyStageDraft {
  const base =
    kind === "run"
      ? DEFAULT_RUN_STAGE_DRAFT
      : kind === "eigenmodes"
        ? DEFAULT_EIGENMODES_STAGE_DRAFT
        : kind === "frequency_response"
          ? DEFAULT_FREQUENCY_RESPONSE_STAGE_DRAFT
          : kind === "hysteresis"
            ? DEFAULT_HYSTERESIS_STAGE_DRAFT
            : kind === "save_state"
              ? DEFAULT_SAVE_STATE_STAGE_DRAFT
              : DEFAULT_RELAX_STAGE_DRAFT;
  return {
    ...base,
    kind,
    stageId: `${kind}-${stageCount + 1}`,
  };
}

export function studyStageDraftToSceneStage(
  draft: StudyStageDraft,
): JsonObject {
  if (draft.kind === "run") {
    return {
      entrypoint_kind: "flat_run",
      kind: "run",
      stage_id: requiredText(draft.stageId, "run"),
      until_seconds: requiredNumber(draft.untilSeconds, "until_seconds"),
    };
  }
  if (draft.kind === "eigenmodes") {
    const stage = spectralSceneStage(draft, "eigenmodes");
    stage.count = requiredInteger(draft.count, "count");
    stage.eigen_count = stage.count;
    stage.target = requiredText(draft.target, "lowest");
    stage.eigen_target = stage.target;
    setOptionalNumber(stage, "target_frequency", draft.targetFrequency);
    setOptionalNumber(stage, "eigen_target_frequency", draft.targetFrequency);
    return stage;
  }
  if (draft.kind === "frequency_response") {
    const stage = spectralSceneStage(draft, "frequency_response");
    stage.frequencies_hz = requiredNumberList(draft.frequenciesHz, "frequencies_hz");
    stage.frequency_values_hz = stage.frequencies_hz;
    stage.excitation_field_au_per_m = requiredVector3(
      draft.excitationField,
      "excitation_field_au_per_m",
    );
    stage.frequency_excitation_field_au_per_m =
      stage.excitation_field_au_per_m;
    stage.observable = requiredText(draft.observable, "susceptibility_tensor");
    stage.frequency_observable = stage.observable;
    return stage;
  }
  if (draft.kind === "save_state") {
    const stage: JsonObject = {
      artifact_name: requiredText(draft.artifactName, "state_snapshot"),
      entrypoint_kind: "flat_save_state",
      kind: "save_state",
      stage_id: requiredText(draft.stageId, "save-state"),
    };
    setOptionalText(stage, "format", draft.format);
    setOptionalText(stage, "dataset", draft.dataset);
    return stage;
  }
  if (draft.kind === "hysteresis") {
    const startField = requiredVector3(draft.startField, "start_field");
    const stopField = requiredVector3(draft.stopField, "stop_field");
    const torqueTolerance = requiredNumber(
      draft.torqueTolerance,
      "torque_tolerance",
    );
    return {
      entrypoint_kind: "flat_hysteresis",
      field_steps: requiredInteger(draft.fieldSteps, "field_steps"),
      hysteresis_start_field: startField,
      hysteresis_stop_field: stopField,
      hysteresis_torque_tolerance: torqueTolerance,
      kind: "hysteresis",
      stage_id: requiredText(draft.stageId, "hysteresis"),
      start_field: startField,
      stop_field: stopField,
      torque_tolerance: torqueTolerance,
    };
  }

  const stage: JsonObject = {
    algorithm: requiredText(draft.algorithm, "llg_overdamped"),
    entrypoint_kind: "flat_relax",
    kind: "relax",
    max_steps: requiredInteger(draft.maxSteps, "max_steps"),
    relax_algorithm: requiredText(draft.algorithm, "llg_overdamped"),
    stage_id: requiredText(draft.stageId, "relax"),
    torque_tolerance: requiredNumber(draft.torqueTolerance, "torque_tolerance"),
  };

  setOptionalNumber(stage, "energy_tolerance", draft.energyTolerance);
  setOptionalNumber(stage, "max_physical_time_s", draft.maxPhysicalTime);
  setOptionalNumber(stage, "max_pseudotime_s", draft.maxPseudotime);
  setOptionalNumber(stage, "max_error", draft.maxError);
  setOptionalNumber(stage, "dt_min", draft.dtMin);
  setOptionalNumber(stage, "relax_alpha", draft.relaxAlpha);
  setOptionalText(stage, "solver", draft.solver);
  setOptionalText(stage, "integrator", draft.solver);
  if (draft.dt.trim() === "auto" || draft.dt.trim().length === 0) {
    stage.dt = "auto";
    stage.fixed_timestep = "";
  } else {
    stage.dt = requiredNumber(draft.dt, "dt");
    stage.fixed_timestep = stage.dt;
  }
  const fieldEvery = optionalInteger(draft.fieldEvery);
  if (fieldEvery !== null) {
    stage.field_refresh = { every_n: fieldEvery };
  }

  return stage;
}

export function validateStudyStageDraft(
  draft: StudyStageDraft,
): StudyStageDraftValidation[] {
  const issues: StudyStageDraftValidation[] = [];
  if (!draft.stageId.trim()) {
    issues.push({ message: "Stage ID is required.", severity: "error" });
  }
  if (draft.kind === "run") {
    validatePositiveNumber(issues, draft.untilSeconds, "Until seconds", true);
    return issues;
  }
  if (draft.kind === "eigenmodes") {
    validatePositiveInteger(issues, draft.count, "Mode count", true);
    validatePositiveNumber(issues, draft.targetFrequency, "Target frequency", false);
    validateOptionalVector3(issues, draft.kVector, "k vector");
    validateOptionalJson(issues, draft.kSampling, "k sampling");
    validateJsonOrString(issues, draft.bc, "BC");
    return issues;
  }
  if (draft.kind === "frequency_response") {
    validatePositiveNumberList(issues, draft.frequenciesHz, "Frequencies");
    validateRequiredVector3(issues, draft.excitationField, "Excitation field");
    validateOptionalVector3(issues, draft.kVector, "k vector");
    validateOptionalJson(issues, draft.kSampling, "k sampling");
    validateJsonOrString(issues, draft.bc, "BC");
    return issues;
  }
  if (draft.kind === "save_state") {
    if (!draft.artifactName.trim()) {
      issues.push({ message: "Artifact name is required.", severity: "error" });
    }
    return issues;
  }
  if (draft.kind === "hysteresis") {
    validatePositiveNumber(issues, draft.torqueTolerance, "Torque tolerance", true);
    validateRequiredVector3(issues, draft.startField, "Start field");
    validateRequiredVector3(issues, draft.stopField, "Stop field");
    validatePositiveInteger(issues, draft.fieldSteps, "Field steps", true);
    return issues;
  }

  validatePositiveNumber(issues, draft.torqueTolerance, "Torque tolerance", true);
  validatePositiveInteger(issues, draft.maxSteps, "Max steps", true);
  validatePositiveNumber(issues, draft.energyTolerance, "Energy tolerance", false);
  validatePositiveNumber(issues, draft.maxPhysicalTime, "Max physical time", false);
  validatePositiveNumber(issues, draft.maxPseudotime, "Max pseudotime", false);
  validatePositiveNumber(issues, draft.relaxAlpha, "Relax alpha", false);
  validatePositiveNumber(issues, draft.maxError, "Max error", false);
  validatePositiveNumber(issues, draft.dtMin, "dt_min", false);
  validatePositiveInteger(issues, draft.fieldEvery, "Field refresh", false);
  if (draft.dt.trim() && draft.dt.trim() !== "auto") {
    validatePositiveNumber(issues, draft.dt, "dt", true);
  }
  if (draft.algorithm !== "llg_overdamped") {
    const hasLlgOnly =
      draft.solver.trim() ||
      draft.dt.trim() ||
      draft.dtMin.trim() ||
      draft.maxError.trim();
    if (hasLlgOnly) {
      issues.push({
        message:
          "solver, dt, dt_min, and max_error apply only to llg_overdamped.",
        severity: "warning",
      });
    }
  }
  return issues;
}

export function buildStudyStagesMergePatch(
  stages: readonly StudyStageDraft[],
): AuthoringTransactionRequest {
  return {
    kind: "merge_patch",
    merge_patch: {
      study: {
        stages: stages.map(studyStageDraftToSceneStage),
      },
    },
  };
}

function validatePositiveNumber(
  issues: StudyStageDraftValidation[],
  value: string,
  label: string,
  required: boolean,
): void {
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) {
      issues.push({ message: `${label} is required.`, severity: "error" });
    }
    return;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    issues.push({
      message: `${label} must be a positive finite number.`,
      severity: "error",
    });
  }
}

function validatePositiveInteger(
  issues: StudyStageDraftValidation[],
  value: string,
  label: string,
  required: boolean,
): void {
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) {
      issues.push({ message: `${label} is required.`, severity: "error" });
    }
    return;
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    issues.push({
      message: `${label} must be a positive integer.`,
      severity: "error",
    });
  }
}

function stageKind(record: JsonRecord | null): StudyStageDraftKind {
  const kind = String(record?.kind ?? record?.entrypoint_kind ?? "relax");
  const normalized = kind.toLowerCase();
  if (normalized.includes("frequency")) return "frequency_response";
  if (normalized.includes("eigen")) return "eigenmodes";
  if (normalized.includes("hysteresis")) return "hysteresis";
  if (normalized.includes("save")) return "save_state";
  if (normalized.includes("run")) return "run";
  return "relax";
}

function spectralDraft(
  base: StudyStageDraft,
  record: JsonRecord | null,
  index: number,
): StudyStageDraft {
  return {
    ...base,
    bc: scalarOrObjectText(record?.bc, base.bc),
    count: scalarText(record?.count, base.count),
    dampingPolicy: scalarText(record?.damping_policy, base.dampingPolicy),
    equilibriumArtifact: scalarText(record?.equilibrium_artifact, ""),
    equilibriumSource: scalarText(record?.equilibrium_source, base.equilibriumSource),
    includeDemag: booleanValue(record?.include_demag, base.includeDemag),
    kSampling: objectText(record?.k_sampling),
    kVector: vectorText(record?.k_vector, ""),
    normalization: scalarText(record?.normalization, base.normalization),
    stageId: stringValue(record?.stage_id ?? record?.id, `stage-${index + 1}`),
    target: scalarText(record?.target, base.target),
    targetFrequency: scalarText(record?.target_frequency, ""),
  };
}

function spectralSceneStage(
  draft: StudyStageDraft,
  kind: "eigenmodes" | "frequency_response",
): JsonObject {
  const stage: JsonObject = {
    bc: parseJsonOrString(draft.bc, "free"),
    damping_policy: requiredText(draft.dampingPolicy, "ignore"),
    equilibrium_source: requiredText(
      draft.equilibriumSource,
      kind === "eigenmodes" ? "relax" : "provided",
    ),
    include_demag: draft.includeDemag,
    kind,
    normalization: requiredText(draft.normalization, "unit_l2"),
    stage_id: requiredText(draft.stageId, kind),
  };
  stage.entrypoint_kind =
    kind === "eigenmodes" ? "flat_eigenmodes" : "flat_frequency_response";
  setOptionalText(stage, "equilibrium_artifact", draft.equilibriumArtifact);
  setOptionalText(
    stage,
    kind === "eigenmodes"
      ? "eigen_equilibrium_artifact"
      : "frequency_equilibrium_artifact",
    draft.equilibriumArtifact,
  );
  const kVector = optionalVector3(draft.kVector);
  if (kVector) stage.k_vector = kVector;
  const kSampling = optionalJsonObject(draft.kSampling);
  if (kSampling) stage.k_sampling = kSampling;
  if (kind === "eigenmodes") {
    stage.eigen_include_demag = draft.includeDemag;
    stage.eigen_equilibrium_source = stage.equilibrium_source;
    stage.eigen_normalization = stage.normalization;
    stage.eigen_damping_policy = stage.damping_policy;
    if (kVector) stage.eigen_k_vector = kVector;
    if (kSampling) stage.eigen_k_sampling = kSampling;
    stage.eigen_spin_wave_bc = stage.bc;
  } else {
    stage.frequency_include_demag = draft.includeDemag;
    stage.frequency_equilibrium_source = stage.equilibrium_source;
    stage.frequency_normalization = stage.normalization;
    stage.frequency_damping_policy = stage.damping_policy;
    if (kVector) stage.frequency_k_vector = kVector;
    if (kSampling) stage.frequency_k_sampling = kSampling;
    stage.frequency_spin_wave_bc = stage.bc;
  }
  return stage;
}

function scalarText(value: unknown, fallback: string): string {
  if (typeof value === "number" || typeof value === "string") {
    return String(value);
  }
  return fallback;
}

function listText(value: unknown, fallback: string): string {
  return Array.isArray(value) ? value.join(", ") : scalarText(value, fallback);
}

function vectorText(value: unknown, fallback: string): string {
  return Array.isArray(value) && value.length === 3
    ? value.join(", ")
    : scalarText(value, fallback);
}

function objectText(value: unknown): string {
  return value === null || value === undefined ? "" : JSON.stringify(value);
}

function scalarOrObjectText(value: unknown, fallback: string): string {
  if (typeof value === "number" || typeof value === "string") {
    return String(value);
  }
  if (Boolean(value) && typeof value === "object" && !Array.isArray(value)) {
    return JSON.stringify(value);
  }
  return fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function requiredText(value: string, fallback: string): string {
  return value.trim() || fallback;
}

function requiredNumber(value: string, field: string): number {
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive finite number.`);
  }
  return parsed;
}

function requiredInteger(value: string, field: string): number {
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return parsed;
}

function requiredNumberList(value: string, field: string): number[] {
  const values = positiveNumberList(value);
  if (values.length === 0) {
    throw new Error(`${field} requires at least one positive finite number.`);
  }
  return values;
}

function requiredVector3(value: string, field: string): number[] {
  const vector = optionalVector3(value);
  if (!vector) {
    throw new Error(`${field} must contain three finite numbers.`);
  }
  return vector;
}

function optionalVector3(value: string): number[] | null {
  const values = finiteNumberList(value);
  return values.length === 3 ? values : null;
}

function finiteNumberList(value: string): number[] {
  const values: number[] = [];
  for (const token of value.split(/[,\s]+/)) {
    const entry = token.trim();
    if (!entry) continue;
    const parsed = Number(entry);
    if (Number.isFinite(parsed)) {
      values.push(parsed);
    }
  }
  return values;
}

function positiveNumberList(value: string): number[] {
  const values: number[] = [];
  for (const entry of finiteNumberList(value)) {
    if (entry > 0) {
      values.push(entry);
    }
  }
  return values;
}

function parseJsonOrString(value: string, fallback: string): JsonObject | string {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  if (!trimmed.startsWith("{")) return trimmed;
  const parsed = JSON.parse(trimmed) as unknown;
  return Boolean(parsed) && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as JsonObject)
    : fallback;
}

function optionalJsonObject(value: string): JsonObject | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON value must be an object.");
  }
  return parsed as JsonObject;
}

function optionalInteger(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function setOptionalNumber(
  target: JsonObject,
  key: string,
  value: string,
): void {
  const trimmed = value.trim();
  if (!trimmed) return;
  const parsed = Number(trimmed);
  if (Number.isFinite(parsed) && parsed > 0) {
    target[key] = parsed;
  }
}

function setOptionalText(target: JsonObject, key: string, value: string): void {
  const trimmed = value.trim();
  if (trimmed) target[key] = trimmed;
}

function validatePositiveNumberList(
  issues: StudyStageDraftValidation[],
  value: string,
  label: string,
): void {
  if (positiveNumberList(value).length === 0) {
    issues.push({
      message: `${label} requires at least one positive finite number.`,
      severity: "error",
    });
  }
}

function validateRequiredVector3(
  issues: StudyStageDraftValidation[],
  value: string,
  label: string,
): void {
  if (!optionalVector3(value)) {
    issues.push({
      message: `${label} must contain three finite numbers.`,
      severity: "error",
    });
  }
}

function validateOptionalVector3(
  issues: StudyStageDraftValidation[],
  value: string,
  label: string,
): void {
  if (value.trim() && !optionalVector3(value)) {
    issues.push({
      message: `${label} must contain three finite numbers.`,
      severity: "error",
    });
  }
}

function validateOptionalJson(
  issues: StudyStageDraftValidation[],
  value: string,
  label: string,
): void {
  if (!value.trim()) return;
  try {
    optionalJsonObject(value);
  } catch {
    issues.push({
      message: `${label} must be a JSON object.`,
      severity: "error",
    });
  }
}

function validateJsonOrString(
  issues: StudyStageDraftValidation[],
  value: string,
  label: string,
): void {
  const trimmed = value.trim();
  if (!trimmed || !trimmed.startsWith("{")) return;
  try {
    parseJsonOrString(value, "free");
  } catch {
    issues.push({
      message: `${label} must be a boundary condition name or JSON object.`,
      severity: "error",
    });
  }
}

function asRecord(value: unknown): JsonRecord | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}
