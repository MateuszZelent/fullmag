import type { ObjectPatchRequest } from "@/kernel/api/apiTypes";

export interface MaterialAssignmentDraft {
  materialRef: string;
}

export function normalizeMaterialRef(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "unassigned") return null;
  return trimmed;
}

export function materialAssignmentDraftFromRef(
  materialRef: string,
): MaterialAssignmentDraft {
  return {
    materialRef: normalizeMaterialRef(materialRef) ?? "",
  };
}

export function buildMaterialAssignmentPatch(
  draft: MaterialAssignmentDraft,
  baseRevision: number | null,
): ObjectPatchRequest {
  return {
    base_revision: baseRevision,
    material_ref: normalizeMaterialRef(draft.materialRef),
  };
}
