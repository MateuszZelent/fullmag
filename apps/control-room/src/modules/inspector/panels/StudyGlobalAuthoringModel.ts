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
  tableAutosaveEnabled: boolean;
  tableQuantities: string;
  tSampling: string;
  outputs: StudyGlobalOutputDraft[];
}

export interface StudyGlobalOutputDraft {
  enabled: boolean;
  everySeconds: string;
  kind: "field" | "scalar";
  name: string;
  raw?: JsonObject;
  readOnly?: boolean;
}

export interface StudyGlobalDraftValidation {
  message: string;
  severity: "error" | "warning";
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
  solver: "",
  tableAutosaveEnabled: false,
  tableQuantities: "t, step, mx, my, mz, e_total, max_torque",
  tSampling: "5e-13",
  outputs: [
    { enabled: true, everySeconds: "1e-12", kind: "field", name: "m" },
    {
      enabled: true,
      everySeconds: "1e-12",
      kind: "scalar",
      name: "E_total",
    },
  ],
};

export function createStudyGlobalDraft(scene: unknown): StudyGlobalDraft {
  const study = asRecord(asRecord(scene)?.study);
  const tableAutosave = asRecord(
    study?.table_autosave ?? study?.tableautosave,
  );
  const outputValues = Array.isArray(study?.outputs) ? study.outputs : null;
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
    tableAutosaveEnabled: tableAutosave !== null,
    tableQuantities: Array.isArray(tableAutosave?.quantities)
      ? tableAutosave.quantities.map(String).join(", ")
      : DEFAULT_STUDY_GLOBAL_DRAFT.tableQuantities,
    tSampling: scalarText(
      tableAutosave?.sample_period_s ?? tableAutosave?.every_seconds,
      DEFAULT_STUDY_GLOBAL_DRAFT.tSampling,
    ),
    outputs: outputValues
      ? outputValues.map(globalOutputDraft)
      : DEFAULT_STUDY_GLOBAL_DRAFT.outputs.map((output) => ({ ...output })),
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
  if (draft.tableAutosaveEnabled) {
    if (!positiveFiniteNumber(draft.tSampling)) {
      issues.push({
        message: "Global t_sampling must be a positive finite number.",
        severity: "error",
      });
    }
    if (commaSeparatedValues(draft.tableQuantities).length === 0) {
      issues.push({
        message: "Global table autosave requires at least one quantity.",
        severity: "error",
      });
    }
  }
  const enabledOutputs = draft.outputs.filter((output) => output.enabled);
  if (enabledOutputs.length === 0) {
    issues.push({
      message: "Global autosave requires at least one enabled output.",
      severity: "error",
    });
  }
  for (const output of enabledOutputs) {
    if (!output.name.trim()) {
      issues.push({
        message: "Global autosave output name is required.",
        severity: "error",
      });
    }
    if (!positiveFiniteNumber(output.everySeconds)) {
      issues.push({
        message: `Global autosave ${output.name || "output"} cadence must be a positive finite number.`,
        severity: "error",
      });
    }
  }
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
  study.table_autosave = draft.tableAutosaveEnabled
    ? {
        kind: "table_autosave",
        quantities: commaSeparatedValues(draft.tableQuantities),
        sample_period_s: Number(draft.tSampling),
        table_id: "default",
      }
    : null;
  study.outputs = draft.outputs
    .filter((output) => output.enabled)
    .map((output) => {
      if (output.readOnly && output.raw) {
        return structuredClone(output.raw);
      }
      return {
        every_seconds: Number(output.everySeconds),
        kind: output.kind,
        name: output.name.trim(),
      } satisfies JsonObject;
    });
  return {
    kind: "merge_patch",
    merge_patch: {
      study,
    },
  };
}

function globalOutputDraft(value: unknown): StudyGlobalOutputDraft {
  const record = asRecord(value);
  const kind = record?.kind;
  const supported = kind === "field" || kind === "scalar";
  return {
    enabled: record?.enabled !== false,
    everySeconds: scalarText(record?.every_seconds, ""),
    kind: kind === "scalar" ? "scalar" : "field",
    name: scalarText(record?.name ?? record?.field ?? record?.scalar, ""),
    raw:
      record && !supported
        ? (structuredClone(record) as JsonObject)
        : undefined,
    readOnly: !supported,
  };
}

function commaSeparatedValues(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function positiveFiniteNumber(value: string): boolean {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed > 0;
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
