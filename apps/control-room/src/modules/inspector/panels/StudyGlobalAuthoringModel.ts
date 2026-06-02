import type {
  AuthoringTransactionRequest,
  JsonObject,
} from "@/kernel/api/apiTypes";

type JsonRecord = Record<string, unknown>;

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
  solver: string;
}

export interface StudyGlobalDraftValidation {
  message: string;
  severity: "error" | "warning";
}

export const DEFAULT_STUDY_GLOBAL_DRAFT: StudyGlobalDraft = {
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
  solver: "",
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
    solver: objectText(study?.solver),
  };
}

export function validateStudyGlobalDraft(
  draft: StudyGlobalDraft,
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
  validateOptionalJsonObject(issues, draft.solver, "Solver");
  validateOptionalJsonObject(
    issues,
    draft.femDemagSolverPolicy,
    "FEM demag policy",
  );
  return issues;
}

export function buildStudyGlobalMergePatch(
  draft: StudyGlobalDraft,
): AuthoringTransactionRequest {
  const study: JsonObject = {
    demag_enabled: draft.demagEnabled,
    demag_realization: requiredText(draft.demagRealization, "auto"),
    exchange_enabled: draft.exchangeEnabled,
    requested_backend: requiredText(draft.requestedBackend, "auto"),
    requested_device: requiredText(draft.requestedDevice, "auto"),
    requested_mode: requiredText(draft.requestedMode, "strict"),
    requested_precision: requiredText(draft.requestedPrecision, "double"),
  };
  study.external_field = optionalVector3(draft.externalField);
  study.fem_demag_solver_policy = optionalJsonObject(draft.femDemagSolverPolicy);
  const requestedCpuThreads = optionalPositiveInteger(draft.requestedCpuThreads);
  study.requested_cpu_threads = requestedCpuThreads;
  study.solver = optionalJsonObject(draft.solver) ?? {};
  return {
    kind: "merge_patch",
    merge_patch: {
      study,
    },
  };
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

function optionalVector3(value: string): number[] | null {
  const values = value
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(Number);
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
