import type { JsonObject, ObjectPatchRequest } from "@/kernel/api/apiTypes";

export const ABSORBING_BOUNDARY_FACES = ["x+", "x-", "y+", "y-", "z+", "z-"] as const;
export const ABSORBING_BOUNDARY_PROFILES = [
  "linear",
  "quadratic",
  "smootherstep",
] as const;
export const ABSORBING_BOUNDARY_FRAMES = ["object", "universe"] as const;

export interface AbsorbingBoundaryDraft {
  enabled: boolean;
  totalWidth: string;
  rampWidth: string;
  maxDamping: string;
  faces: string[];
  profile: string;
  frame: string;
}

type RecordValue = Record<string, unknown>;

function asRecord(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

function asNumberString(value: unknown, fallback: string): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : fallback;
}

export function absorbingBoundaryDraftFromObject(object: unknown): AbsorbingBoundaryDraft {
  const config = asRecord(asRecord(object)?.absorbing_boundary);
  const faces = Array.isArray(config?.faces)
    ? config.faces.filter((face): face is string => typeof face === "string")
    : [];
  return {
    enabled: config !== null,
    totalWidth: asNumberString(config?.total_width_m, "4e-7"),
    rampWidth: asNumberString(config?.ramp_width_m, "3e-7"),
    maxDamping: asNumberString(config?.max_damping, "0.5"),
    faces,
    profile: typeof config?.profile === "string" ? config.profile : "smootherstep",
    frame: typeof config?.frame === "string" ? config.frame : "object",
  };
}

export function absorbingBoundaryDraftKey(draft: AbsorbingBoundaryDraft): string {
  return JSON.stringify(draft);
}

export function buildAbsorbingBoundaryPatch(
  draft: AbsorbingBoundaryDraft,
  baseRevision: number | null,
): { error: string } | { patch: ObjectPatchRequest } {
  if (!draft.enabled) {
    return { patch: { base_revision: baseRevision, absorbing_boundary: null } };
  }
  const totalWidth = Number(draft.totalWidth);
  const rampWidth = Number(draft.rampWidth);
  const maxDamping = Number(draft.maxDamping);
  if (!Number.isFinite(totalWidth) || totalWidth <= 0) {
    return { error: "Total width must be a finite positive number." };
  }
  if (!Number.isFinite(rampWidth) || rampWidth <= 0 || rampWidth > totalWidth) {
    return { error: "Ramp width must be positive and no greater than total width." };
  }
  if (!Number.isFinite(maxDamping) || maxDamping < 0) {
    return { error: "Maximum damping must be finite and non-negative." };
  }
  const faces = [...new Set(draft.faces)].filter((face) =>
    (ABSORBING_BOUNDARY_FACES as readonly string[]).includes(face),
  );
  if (faces.length === 0) return { error: "Select at least one boundary face." };
  if (!(ABSORBING_BOUNDARY_PROFILES as readonly string[]).includes(draft.profile)) {
    return { error: "Select a supported damping profile." };
  }
  if (!(ABSORBING_BOUNDARY_FRAMES as readonly string[]).includes(draft.frame)) {
    return { error: "Select a supported coordinate frame." };
  }
  const boundary: JsonObject = {
    total_width_m: totalWidth,
    ramp_width_m: rampWidth,
    max_damping: maxDamping,
    faces,
    profile: draft.profile,
    frame: draft.frame,
  };
  return { patch: { base_revision: baseRevision, absorbing_boundary: boundary } };
}
