import type {
  MaterialPatchRequest,
  MaterialResource,
  ObjectPatchRequest,
} from "@/kernel/api/apiTypes";

export interface MaterialAssignmentDraft {
  materialRef: string;
}

export interface MagneticParametersDraft extends MaterialAssignmentDraft {
  aex: string;
  alpha: string;
  dind: string;
  dbulk: string;
  materialName: string;
  ms: string;
}

export function normalizeMaterialRef(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "unassigned") return null;
  return trimmed;
}

export function materialAssignmentDraftFromRef(
  materialRef: string | null | undefined,
): MaterialAssignmentDraft {
  return {
    materialRef: normalizeMaterialRef(materialRef ?? "") ?? "",
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

export function magneticParametersDraftFromResource(
  materialRef: string | null | undefined,
  material: MaterialResource | null | undefined,
): MagneticParametersDraft {
  return {
    aex: formatOptionalNumber(material?.properties.Aex),
    alpha: formatRequiredNumber(material?.properties.alpha, 0.01),
    dind: formatOptionalNumber(material?.properties.Dind),
    dbulk: formatOptionalNumber(material?.properties.Dbulk),
    materialName: material?.name ?? "",
    materialRef: normalizeMaterialRef(materialRef ?? "") ?? "",
    ms: formatOptionalNumber(material?.properties.Ms),
  };
}

export function materialParametersDraftKey(
  materialRef: string | null | undefined,
  material: MaterialResource | null | undefined,
): string {
  return [
    normalizeMaterialRef(materialRef ?? "") ?? "",
    material?.id ?? "missing",
    material?.name ?? "",
    formatOptionalNumber(material?.properties.Ms),
    formatOptionalNumber(material?.properties.Aex),
    formatRequiredNumber(material?.properties.alpha, 0.01),
    formatOptionalNumber(material?.properties.Dind),
    formatOptionalNumber(material?.properties.Dbulk),
  ].join(":");
}

export function buildMaterialParametersPatch(
  draft: MagneticParametersDraft,
): { error: string } | { patch: MaterialPatchRequest } {
  const ms = parseOptionalNumber(draft.ms, "Ms");
  if ("error" in ms) return ms;
  const aex = parseOptionalNumber(draft.aex, "Aex");
  if ("error" in aex) return aex;
  const alpha = parseRequiredNumber(draft.alpha, "alpha");
  if ("error" in alpha) return alpha;
  const dind = parseOptionalNumber(draft.dind, "Dind");
  if ("error" in dind) return dind;
  const dbulk = parseOptionalNumber(draft.dbulk, "Dbulk");
  if ("error" in dbulk) return dbulk;

  const name = draft.materialName.trim();
  return {
    patch: {
      name: name || null,
      properties: {
        Aex: aex.value,
        Dind: dind.value,
        Dbulk: dbulk.value,
        Ms: ms.value,
        alpha: alpha.value,
      },
    },
  };
}

function formatOptionalNumber(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function formatRequiredNumber(
  value: number | null | undefined,
  fallback: number,
): string {
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : String(fallback);
}

function parseOptionalNumber(
  value: string,
  label: string,
): { error: string } | { value: number | null } {
  const trimmed = value.trim();
  if (!trimmed) return { value: null };
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    return { error: `${label} must be a finite SI value.` };
  }
  return { value: parsed };
}

function parseRequiredNumber(
  value: string,
  label: string,
): { error: string } | { value: number } {
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed)) {
    return { error: `${label} must be a finite SI value.` };
  }
  return { value: parsed };
}
