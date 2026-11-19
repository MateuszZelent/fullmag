import type { JsonObject } from "@/kernel/api/apiTypes";

export type StageAutosaveLayout = "continuous" | "separate";
export type StageAutosaveFormat = "zarr" | "hdf5" | "txt";

export interface StageAutosaveFieldDraft {
  cadence: string;
  quantity: string;
}

export interface StageAutosaveDraft {
  enabled: boolean;
  fields: StageAutosaveFieldDraft[];
  format: StageAutosaveFormat;
  layout: StageAutosaveLayout;
  tableEnabled: boolean;
  tableCadence: string;
  tableQuantities: string;
  target: string;
}

export type StageAutosaveOwnerKind = "relax" | "run";

export const DEFAULT_STAGE_AUTOSAVE_DRAFT: StageAutosaveDraft = {
  enabled: false,
  fields: [],
  format: "zarr",
  layout: "continuous",
  tableEnabled: true,
  tableCadence: "10",
  tableQuantities: "step, mx, my, mz, e_ex, e_demag, e_total, max_torque_T",
  target: "main",
};

export function stageAutosaveDraftFromValue(
  value: unknown,
  owner: StageAutosaveOwnerKind,
): StageAutosaveDraft {
  const record = asRecord(value);
  if (!record) return structuredClone(DEFAULT_STAGE_AUTOSAVE_DRAFT);
  const table = asRecord(record.table);
  const fields = Array.isArray(record.fields) ? record.fields : [];
  return {
    enabled: true,
    fields: fields.flatMap((value) => {
      const field = asRecord(value);
      if (!field || typeof field.quantity !== "string") return [];
      return [{
        cadence: scalarText(owner === "relax" ? field.every_steps : field.every_seconds),
        quantity: field.quantity,
      }];
    }),
    format: isFormat(record.format) ? record.format : "zarr",
    layout: record.layout === "separate" ? "separate" : "continuous",
    tableEnabled: table !== null,
    tableCadence: scalarText(
      owner === "relax" ? table?.every_steps : table?.sample_period_s,
      owner === "relax" ? "10" : "1e-12",
    ),
    tableQuantities: Array.isArray(table?.quantities)
      ? table.quantities.map(String).join(", ")
      : DEFAULT_STAGE_AUTOSAVE_DRAFT.tableQuantities,
    target: typeof record.target === "string" ? record.target : "main",
  };
}

export function stageAutosaveDraftToValue(
  draft: StageAutosaveDraft,
  owner: StageAutosaveOwnerKind,
): JsonObject | null {
  if (!draft.enabled) return null;
  const cadenceKey = owner === "relax" ? "every_steps" : "sample_period_s";
  const fieldCadenceKey = owner === "relax" ? "every_steps" : "every_seconds";
  return {
    fields: draft.fields.map((field) => ({
      [fieldCadenceKey]: requiredPositiveNumber(field.cadence, `field ${field.quantity} cadence`, owner),
      kind: "field_autosave",
      quantity: field.quantity.trim(),
    })),
    format: draft.format,
    kind: "stage_autosave",
    layout: draft.layout,
    ...(draft.tableEnabled
      ? {
          table: {
            [cadenceKey]: requiredPositiveNumber(draft.tableCadence, "table cadence", owner),
            kind: "table_autosave",
            quantities: commaSeparatedValues(draft.tableQuantities),
            table_id: "default",
          },
        }
      : {}),
    target: draft.target.trim(),
  } as JsonObject;
}

export function validateStageAutosaveDraft(
  draft: StageAutosaveDraft,
  owner: StageAutosaveOwnerKind,
): string[] {
  if (!draft.enabled) return [];
  const errors: string[] = [];
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(draft.target)) {
    errors.push("Autosave target must start with a letter or digit and use only letters, digits, '.', '_' or '-'.");
  }
  if (!draft.tableEnabled && draft.fields.length === 0) {
    errors.push("Stage autosave requires a scalar table or at least one field.");
  }
  if (draft.format === "txt" && draft.fields.length > 0) {
    errors.push("TXT autosave supports scalar tables only; remove field outputs or choose Zarr/HDF5.");
  }
  if (draft.tableEnabled) {
    validateCadence(errors, draft.tableCadence, "Table cadence", owner);
    if (commaSeparatedValues(draft.tableQuantities).length === 0) {
      errors.push("Autosave table requires at least one quantity.");
    }
  }
  const quantities = new Set<string>();
  for (const field of draft.fields) {
    const quantity = field.quantity.trim();
    if (!quantity) errors.push("Every autosave field requires a quantity.");
    else if (quantities.has(quantity)) errors.push(`Autosave field '${quantity}' is duplicated.`);
    quantities.add(quantity);
    validateCadence(errors, field.cadence, `Field '${quantity || "unnamed"}' cadence`, owner);
  }
  return errors;
}

function validateCadence(
  errors: string[],
  value: string,
  label: string,
  owner: StageAutosaveOwnerKind,
) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || (owner === "relax" && !Number.isInteger(parsed))) {
    errors.push(`${label} must be a positive ${owner === "relax" ? "integer accepted-step count" : "physical-time interval in seconds"}.`);
  }
}

function requiredPositiveNumber(value: string, label: string, owner: StageAutosaveOwnerKind): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || (owner === "relax" && !Number.isInteger(parsed))) {
    throw new Error(`${label} must be a positive ${owner === "relax" ? "integer" : "number"}`);
  }
  return parsed;
}

function commaSeparatedValues(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function scalarText(value: unknown, fallback = ""): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isFormat(value: unknown): value is StageAutosaveFormat {
  return value === "zarr" || value === "hdf5" || value === "txt";
}
