import type {
  MaskFieldDriveListResource,
  MaskFieldDriveResource,
  MaskFunctionResource,
} from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";

import {
  defaultMaskShape,
  sameJson,
  setTermParameter,
  termFunction,
  updateTerm,
  type MaskFunctionRole,
  type MaskShapeKind,
} from "../../../panels/MaskAntennaPanelModel";

import { UNSELECTED_OBJECT, UNSELECTED_REGION } from "./fieldDriveShared";

export type RawInputs = Record<string, string>;
export type ReadyTerms = MaskFieldDriveResource["terms"];

export interface MaskAntennaDraftState {
  base: MaskFieldDriveResource | null;
  key: string;
  value: MaskFieldDriveResource | null;
}

export interface AcknowledgedMaskAntenna {
  drive: MaskFieldDriveResource;
  key: string;
  revision: number;
}

export interface MaskAntennaTemplateDraft {
  id: string;
  name: string;
  enabled: boolean;
  targetKind: "global" | "object" | "region";
  targetObjectId: string;
  targetRegionId: string;
  frame: "world" | "local";
  timeOrigin: "stage_local" | "absolute";
  shapeKind: MaskShapeKind;
  stageScopeKind: "all_time_evolution" | "stage_ids";
  selectedStageIds: readonly string[];
  termsCount: number;
  drive: MaskFieldDriveResource | null;
}

export const MASK_OUTPUT_LABELS = ["Bx", "By", "Bz"] as const;
export const NEW_READY_CALL = "new";
export const UNSELECTED_READY_ANTENNA = "__select_ready_antenna__";
export const READY_TERMS_PENDING_REASON = "Wait for the ready antenna terms before applying.";
export const SCENE_CHANGED_REASON =
  "This antenna changed in the scene in fields you also edited. Keep your values or load the scene version.";

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PYTHON_KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class",
  "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global",
  "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return",
  "try", "while", "with", "yield",
]);

export function isValidScriptIdentifier(name: string): boolean {
  return IDENTIFIER_RE.test(name) && !PYTHON_KEYWORDS.has(name);
}

export function maskAntennaNodeId(driveId: string): string {
  return `model:physics:mask-antennas:${driveId}`;
}

export function buildMaskAntennaSelection(
  drive: { id: string; name: string },
): Omit<Selection, "moduleSource"> {
  const nodeId = maskAntennaNodeId(drive.id);
  return {
    kind: "physics.field-drive",
    label: drive.name || drive.id,
    nodeId,
    objectId: null,
    ref: {
      fieldDriveId: drive.id,
      fieldDriveKind: "mask",
      kind: "physics.field-drive",
      nodeId,
      type: "physics-field-drive",
    },
  };
}

export function readyCallTerms(drive: MaskFieldDriveResource, callIndex: number): ReadyTerms {
  return drive.terms.filter((term) => term.origin?.call_index === callIndex);
}

export function parseFiniteNumber(text: string): number | null {
  if (text.trim().length === 0) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

export function rawValue(raw: RawInputs, key: string, value: number | undefined): string {
  return raw[key] ?? (value === undefined ? "" : String(value));
}

export function rawError(raw: RawInputs, key: string): string | undefined {
  const text = raw[key];
  return text !== undefined && parseFiniteNumber(text) === null
    ? "Enter a finite number in SI units."
    : undefined;
}

function withComponent(values: readonly number[], index: number, value: number): number[] {
  return values.map((current, position) => (position === index ? value : current));
}

export function applyNumericInput(
  drive: MaskFieldDriveResource,
  key: string,
  value: number,
): MaskFieldDriveResource {
  const [scope, ...rest] = key.split("|");
  if (scope === "position") {
    return { ...drive, position_m: withComponent(drive.position_m, Number(rest[0]), value) };
  }
  if (scope === "shape") {
    const shape = drive.shape;
    const [field, component] = rest;
    if (field === "center") {
      return {
        ...drive,
        shape: { ...shape, center: withComponent(shape.center, Number(component), value) },
      };
    }
    if (field === "size" && shape.kind === "box") {
      return {
        ...drive,
        shape: { ...shape, size: withComponent(shape.size, Number(component), value) },
      };
    }
    if (field === "axis" && shape.kind === "cylinder") {
      return {
        ...drive,
        shape: { ...shape, axis: withComponent(shape.axis, Number(component), value) },
      };
    }
    if (field === "radius" && shape.kind !== "box") {
      return { ...drive, shape: { ...shape, radius: value } };
    }
    if (field === "height" && shape.kind === "cylinder") {
      return { ...drive, shape: { ...shape, height: value } };
    }
    return drive;
  }
  if (scope === "term") {
    const [termKey, role, name] = rest;
    if (!termKey || !role || !name) return drive;
    const index = termKey.startsWith("name:")
      ? drive.terms.findIndex((term) => term.name === termKey.slice(5))
      : Number(termKey);
    return index >= 0 ? setTermParameter(drive, index, role as MaskFunctionRole, name, value) : drive;
  }
  return drive;
}

export function applyRawInputs(
  drive: MaskFieldDriveResource,
  raw: RawInputs,
): MaskFieldDriveResource {
  let result = drive;
  for (const [key, text] of Object.entries(raw)) {
    const value = parseFiniteNumber(text);
    if (value !== null) result = applyNumericInput(result, key, value);
  }
  return result;
}

export function consistentRawInputs(drive: MaskFieldDriveResource, raw: RawInputs): RawInputs {
  return Object.fromEntries(
    Object.entries(raw).filter(([key, text]) => {
      const value = parseFiniteNumber(text);
      return value === null || sameJson(applyNumericInput(drive, key, value), drive);
    }),
  );
}

export function addTermLocalEquation(
  drive: MaskFieldDriveResource,
  termIndex: number,
  role: MaskFunctionRole,
  name: string,
  expression: string,
): MaskFieldDriveResource {
  return updateTerm(drive, termIndex, (term) => {
    const applyFn = (target: MaskFunctionResource): MaskFunctionResource => {
      const existingLocals = target.locals ?? [];
      const existingParams = target.parameters ?? [];
      if (
        existingLocals.some((l) => l.name === name) ||
        existingParams.some((p) => p.name === name)
      ) {
        return target;
      }
      return {
        ...target,
        locals: [...existingLocals, { name, expression: expression.trim() || "0.0" }],
      };
    };
    if (role === "time") {
      return term.time ? { ...term, time: applyFn(term.time) } : term;
    }
    return term.mask.kind === "function"
      ? { ...term, mask: { ...term.mask, function: applyFn(term.mask.function) } }
      : term;
  });
}

export function removeTermLocalEquation(
  drive: MaskFieldDriveResource,
  termIndex: number,
  role: MaskFunctionRole,
  name: string,
): MaskFieldDriveResource {
  return updateTerm(drive, termIndex, (term) => {
    const applyFn = (target: MaskFunctionResource): MaskFunctionResource => ({
      ...target,
      locals: (target.locals ?? []).filter((l) => l.name !== name),
    });
    if (role === "time") {
      return term.time ? { ...term, time: applyFn(term.time) } : term;
    }
    return term.mask.kind === "function"
      ? { ...term, mask: { ...term.mask, function: applyFn(term.mask.function) } }
      : term;
  });
}

export function validateMaskLocalsAndStageActivation(drive: MaskFieldDriveResource): string[] {
  const errors: string[] = [];
  if (drive.activation.kind === "stage_ids" && drive.activation.stage_ids.length === 0) {
    errors.push("Select at least one run stage.");
  }
  drive.terms.forEach((term, index) => {
    const label = `Term ${index + 1}`;
    for (const role of ["mask", "time"] as const) {
      const fn = termFunction(term, role);
      if (!fn) continue;
      const seen = new Set((fn.parameters ?? []).map((p) => p.name));
      for (const local of fn.locals ?? []) {
        if (!isValidScriptIdentifier(local.name)) {
          errors.push(
            `${label}: local '${local.name}' must be an identifier that is not a Python keyword.`,
          );
        }
        if (seen.has(local.name)) {
          errors.push(`${label}: local '${local.name}' duplicates another symbol.`);
        }
        seen.add(local.name);
        if (local.expression.trim().length === 0) {
          errors.push(`${label}: local '${local.name}' needs an expression.`);
        }
      }
    }
  });
  return errors;
}

export function normalizeMaskListResource(
  rawData: unknown,
  fallbackRevisionNum: number | null,
): MaskFieldDriveListResource | null {
  if (!rawData || typeof rawData !== "object") return null;
  const rec = rawData as {
    drives?: MaskFieldDriveResource[];
    items?: MaskFieldDriveResource[];
    scene_revision?: number;
  };
  const drives = Array.isArray(rec.drives)
    ? rec.drives
    : Array.isArray(rec.items)
      ? rec.items
      : [];
  const scene_revision =
    typeof rec.scene_revision === "number"
      ? rec.scene_revision
      : (fallbackRevisionNum ?? 0);
  return { drives, scene_revision };
}

export function toMaskTemplateDraft(drive: MaskFieldDriveResource | null): MaskAntennaTemplateDraft {
  const target = drive?.target ?? { kind: "global" as const };
  return {
    id: drive?.id ?? "",
    name: drive?.name ?? "Mask antenna",
    enabled: drive?.enabled !== false,
    targetKind: target.kind,
    targetObjectId:
      target.kind !== "global" ? (target.object_id || UNSELECTED_OBJECT) : UNSELECTED_OBJECT,
    targetRegionId:
      target.kind === "region" ? (target.region_id || UNSELECTED_REGION) : UNSELECTED_REGION,
    frame: drive?.frame ?? "world",
    timeOrigin: drive?.time_origin ?? "stage_local",
    shapeKind: drive?.shape.kind ?? "box",
    stageScopeKind:
      drive?.activation.kind === "stage_ids" ? "stage_ids" : "all_time_evolution",
    selectedStageIds:
      drive?.activation.kind === "stage_ids" ? drive.activation.stage_ids : [],
    termsCount: drive?.terms.length ?? 0,
    drive,
  };
}

export function applyMaskTemplateFieldChange<K extends keyof MaskAntennaTemplateDraft & string>(
  d: MaskFieldDriveResource,
  key: K,
  value: MaskAntennaTemplateDraft[K],
): MaskFieldDriveResource {
  switch (key) {
    case "id":
      return { ...d, id: String(value) };
    case "name":
      return { ...d, name: String(value) };
    case "enabled":
      return { ...d, enabled: Boolean(value) };
    case "targetKind": {
      const kind = String(value);
      return {
        ...d,
        target:
          kind === "object"
            ? { kind: "object", object_id: "" }
            : kind === "region"
              ? { kind: "region", object_id: "", region_id: "" }
              : { kind: "global" },
      };
    }
    case "targetObjectId": {
      const rawObj = String(value);
      const objectId = rawObj === UNSELECTED_OBJECT ? "" : rawObj;
      if (d.target.kind === "global") return d;
      return {
        ...d,
        target:
          d.target.kind === "region"
            ? { kind: "region", object_id: objectId, region_id: "" }
            : { kind: "object", object_id: objectId },
      };
    }
    case "targetRegionId": {
      const rawReg = String(value);
      const regionId = rawReg === UNSELECTED_REGION ? "" : rawReg;
      return d.target.kind === "region"
        ? { ...d, target: { ...d.target, region_id: regionId } }
        : d;
    }
    case "frame":
      return { ...d, frame: value === "local" ? "local" : "world" };
    case "timeOrigin":
      return {
        ...d,
        time_origin: value === "absolute" ? "absolute" : "stage_local",
      };
    case "shapeKind":
      return { ...d, shape: defaultMaskShape(value as MaskShapeKind) };
    case "stageScopeKind":
      return {
        ...d,
        activation:
          value === "stage_ids"
            ? { kind: "stage_ids", stage_ids: [] }
            : { kind: "all_time_evolution" },
      };
    case "selectedStageIds":
      return {
        ...d,
        activation: {
          kind: "stage_ids",
          stage_ids: [...(value as readonly string[])],
        },
      };
    default:
      return d;
  }
}

export function computeMaskDirtyFields(
  draft: MaskFieldDriveResource | null,
  effectiveSceneDrive: MaskFieldDriveResource | null,
  mode: string,
  own: MaskFieldDriveResource | null,
  rawErrorCount: number,
): ReadonlySet<string> {
  const set = new Set<string>();
  if (!draft) return set;
  if (mode === "create") {
    if (own !== null || rawErrorCount > 0) set.add("drive");
    return set;
  }
  if (!effectiveSceneDrive) return set;
  if (draft.name !== effectiveSceneDrive.name) set.add("name");
  if ((draft.enabled !== false) !== (effectiveSceneDrive.enabled !== false)) set.add("enabled");
  if (!sameJson(draft.target, effectiveSceneDrive.target)) set.add("targetKind");
  if (draft.frame !== effectiveSceneDrive.frame) set.add("frame");
  if (draft.time_origin !== effectiveSceneDrive.time_origin) set.add("timeOrigin");
  if (
    !sameJson(draft.shape, effectiveSceneDrive.shape) ||
    !sameJson(draft.position_m, effectiveSceneDrive.position_m)
  ) {
    set.add("shapeKind");
  }
  if (!sameJson(draft.activation, effectiveSceneDrive.activation)) set.add("stageScopeKind");
  if (!sameJson(draft.terms, effectiveSceneDrive.terms)) set.add("drive");
  if (rawErrorCount > 0 && set.size === 0) set.add("drive");
  return set;
}

export function computeMaskInvalidFields(
  draft: MaskFieldDriveResource | null,
  validationErrors: readonly string[],
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  if (validationErrors.length === 0) return map;
  if (draft && draft.id.trim().length === 0) map.set("id", "The antenna needs an ID.");
  if (draft && draft.name.trim().length === 0) map.set("name", "The antenna needs a name.");
  if (draft && draft.target.kind !== "global" && draft.target.object_id.length === 0) {
    map.set("targetObjectId", "Select the target object.");
  }
  if (draft && draft.target.kind === "region" && draft.target.region_id.length === 0) {
    map.set("targetRegionId", "Select the target region.");
  }
  if (map.size === 0) {
    map.set("drive", validationErrors[0]!);
  }
  return map;
}
