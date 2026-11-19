/**
 * Read-only summary of the Study stage actions of a mask antenna
 * (`add_mask_field_drive`, `update_mask_field_drive`; ADR 0081).
 *
 * The stage payload stays the preserved raw stage: this module only reads it.
 */

export interface MaskStageFunctionSummary {
  /** `name(B01 = 0.0002, wavelength = 2.79e-7)`, `array 1200 x 200 x 15` or `1 (static)`. */
  call: string;
  /** Equations of the function, one per output; empty for an array mask. */
  outputs: readonly string[];
}

export interface MaskStageTermSummary {
  label: string;
  mask: MaskStageFunctionSummary;
  time: MaskStageFunctionSummary;
}

export interface MaskFieldDriveStageSummary {
  action: "add" | "update";
  driveId: string;
  driveName: string | null;
  frame: string | null;
  kindLabel: "Add Antenna" | "Update Antenna";
  /** New parameter values of an Update, as `name = value` lists. */
  maskParameters: string | null;
  shape: string | null;
  target: string | null;
  /** Term selected by an Update (name or index); null selects the only term. */
  term: string | null;
  terms: readonly MaskStageTermSummary[];
  timeOrigin: string | null;
  timeParameters: string | null;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function formatNumber(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : String(value);
}

function parameterList(parameters: unknown): string {
  if (!Array.isArray(parameters)) return "";
  return parameters
    .map((entry) => {
      const parameter = asRecord(entry);
      return parameter ? `${String(parameter.name)} = ${formatNumber(parameter.value)}` : "";
    })
    .filter(Boolean)
    .join(", ");
}

function parameterPatch(values: unknown): string | null {
  const record = asRecord(values);
  if (!record) return null;
  const entries = Object.entries(record);
  if (entries.length === 0) return null;
  return entries.map(([name, value]) => `${name} = ${formatNumber(value)}`).join(", ");
}

function functionSummary(value: unknown): MaskStageFunctionSummary | null {
  const record = asRecord(value);
  if (!record) return null;
  const outputs = Array.isArray(record.outputs)
    ? record.outputs.filter((output): output is string => typeof output === "string")
    : [];
  return {
    call: `${text(record.name) ?? "function"}(${parameterList(record.parameters)})`,
    outputs,
  };
}

function maskSummary(value: unknown): MaskStageFunctionSummary {
  const record = asRecord(value);
  if (record?.kind === "function") {
    return functionSummary(record.function) ?? { call: "function", outputs: [] };
  }
  if (record?.kind === "sampled") {
    const size = Array.isArray(record.size) ? record.size.join(" x ") : "";
    return { call: size ? `array ${size}` : "array", outputs: [] };
  }
  return { call: "not declared", outputs: [] };
}

function targetLabel(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;
  if (record.kind === "global") return "all magnets";
  if (record.kind === "object") return `object ${String(record.object_id ?? "")}`.trim();
  if (record.kind === "region") {
    return `region ${String(record.region_id ?? "")} of ${String(record.object_id ?? "")}`.trim();
  }
  return text(record.kind);
}

function shapeLabel(value: unknown): string | null {
  const record = asRecord(value);
  const kind = text(record?.kind);
  if (!record || !kind) return null;
  const size = Array.isArray(record.size) ? ` ${record.size.join(" x ")} m` : "";
  return `${kind}${size}`;
}

function stagePayload(rawStage: unknown): JsonRecord | null {
  const record = asRecord(rawStage);
  if (!record) return null;
  // A pipeline node keeps the action under `payload`; a flat stage is the action.
  return asRecord(record.payload) ?? record;
}

/** Summary of a mask-antenna stage action, or null for any other stage. */
export function summarizeMaskFieldDriveStage(
  rawStage: unknown,
): MaskFieldDriveStageSummary | null {
  const payload = stagePayload(rawStage);
  const kind = text(payload?.kind);
  if (!payload || !kind) return null;
  if (kind === "add_mask_field_drive") {
    const drive = asRecord(payload.drive);
    if (!drive) return null;
    const terms = Array.isArray(drive.terms) ? drive.terms : [];
    return {
      action: "add",
      driveId: text(drive.id) ?? "not declared",
      driveName: text(drive.name),
      frame: text(drive.frame),
      kindLabel: "Add Antenna",
      maskParameters: null,
      shape: shapeLabel(drive.shape),
      target: targetLabel(drive.target),
      term: null,
      terms: terms.map((entry, index) => {
        const term = asRecord(entry) ?? {};
        return {
          label: text(term.name) ?? `term ${index}`,
          mask: maskSummary(term.mask),
          time: functionSummary(term.time) ?? { call: "1 (static)", outputs: [] },
        };
      }),
      timeOrigin: text(drive.time_origin),
      timeParameters: null,
    };
  }
  if (kind === "update_mask_field_drive") {
    const term = payload.term;
    return {
      action: "update",
      driveId: text(payload.drive_id) ?? "not declared",
      driveName: null,
      frame: null,
      kindLabel: "Update Antenna",
      maskParameters: parameterPatch(payload.mask_parameters),
      shape: null,
      target: null,
      term: typeof term === "string" || typeof term === "number" ? String(term) : null,
      terms: [],
      timeOrigin: null,
      timeParameters: parameterPatch(payload.time_parameters),
    };
  }
  return null;
}
