import type {
  AuthoringTransactionResponse,
  MaterialPatchRequest,
  MaterialPropertiesResource,
  MaterialResource,
  ObjectPatchRequest,
  SceneResource,
} from "@/kernel/api/apiTypes";

export interface CreateMaterialDraft {
  aex: string;
  alpha: string;
  anisotropyAxis: readonly [string, string, string];
  ku1: string;
  materialId: string;
  ms: string;
  name: string;
}

export interface ValidatedCreateMaterialDraft {
  anisotropy: { axis: [number, number, number]; ku1: number } | null;
  materialId: string;
  name: string;
  properties: MaterialPropertiesResource;
}

interface MaterialCreateAssignApi {
  model: {
    createMaterial(
      materialId: string,
      name: string,
      properties: MaterialPropertiesResource,
      references: [],
      options: { baseRevision: number },
    ): Promise<AuthoringTransactionResponse>;
    patchObject(objectId: string, patch: ObjectPatchRequest): Promise<SceneResource>;
  };
}

export class MaterialAssignmentAfterCreateError extends Error {
  readonly assignmentBaseRevision: number;
  readonly created: AuthoringTransactionResponse;
  readonly deferredAnisotropy: ValidatedCreateMaterialDraft["anisotropy"];
  readonly materialId: string;
  readonly objectId: string;

  constructor(
    objectId: string,
    materialId: string,
    created: AuthoringTransactionResponse,
    deferredAnisotropy: ValidatedCreateMaterialDraft["anisotropy"],
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "MaterialAssignmentAfterCreateError";
    this.assignmentBaseRevision = created.scene_revision;
    this.created = created;
    this.deferredAnisotropy = deferredAnisotropy;
    this.materialId = materialId;
    this.objectId = objectId;
  }

  retry(api: MaterialCreateAssignApi, latestBaseRevision: number): Promise<SceneResource> {
    return api.model.patchObject(this.objectId, {
      base_revision: latestBaseRevision,
      material_ref: this.materialId,
    });
  }
}

export function buildUniaxialAnisotropyPatch(
  ku1Text: string,
  axisText: readonly [string, string, string],
): { error: string } | { value: { axis: [number, number, number]; ku1: number } | null } {
  if (!ku1Text.trim()) return { value: null };
  const ku1 = Number(ku1Text.trim());
  if (!Number.isFinite(ku1)) {
    return { error: "Ku1 must be a finite SI value." };
  }
  const axis = axisText.map((component) => Number(component.trim()));
  if (axis.some((component) => !Number.isFinite(component))) {
    return { error: "Anisotropy axis components must be finite SI values." };
  }
  const norm = Math.hypot(...axis);
  if (norm === 0) return { error: "Anisotropy axis must be non-zero." };
  return {
    value: {
      axis: axis.map((component) => component / norm) as [number, number, number],
      ku1,
    },
  };
}

export function buildCreateMaterialDraft(
  draft: CreateMaterialDraft,
): { error: string } | { value: ValidatedCreateMaterialDraft } {
  const materialId = draft.materialId.trim();
  if (!materialId) return { error: "Material id must not be empty." };
  const name = draft.name.trim();
  if (!name) return { error: "Material name must not be empty." };
  const ms = Number(draft.ms.trim());
  if (!Number.isFinite(ms)) return { error: "Ms must be a finite SI value." };
  if (ms <= 0) return { error: "Ms must be greater than 0 A/m." };
  const aex = Number(draft.aex.trim());
  if (!Number.isFinite(aex)) return { error: "A must be a finite SI value." };
  if (aex <= 0) return { error: "A must be greater than 0 J/m." };
  const alpha = Number(draft.alpha.trim());
  if (!Number.isFinite(alpha)) return { error: "alpha must be a finite SI value." };
  if (alpha < 0) return { error: "alpha must be greater than or equal to 0." };
  const anisotropy = buildUniaxialAnisotropyPatch(draft.ku1, draft.anisotropyAxis);
  if ("error" in anisotropy) return anisotropy;
  return {
    value: {
      anisotropy: anisotropy.value,
      materialId,
      name,
      properties: {
        Aex: aex,
        Dbulk: null,
        Dind: null,
        Ms: ms,
        alpha,
      },
    },
  };
}

export async function createMaterialThenAssign(
  api: MaterialCreateAssignApi,
  objectId: string,
  draft: CreateMaterialDraft,
  baseRevision: number,
  onMaterialCreated?: (created: AuthoringTransactionResponse) => void,
  shouldContinue?: () => boolean,
): Promise<{
  assigned: SceneResource;
  created: AuthoringTransactionResponse;
  deferredAnisotropy: ValidatedCreateMaterialDraft["anisotropy"];
  materialId: string;
}> {
  const validated = buildCreateMaterialDraft(draft);
  if ("error" in validated) throw new Error(validated.error);
  const { anisotropy, materialId, name, properties } = validated.value;
  const created = await api.model.createMaterial(
    materialId,
    name,
    properties,
    [],
    { baseRevision },
  );
  onMaterialCreated?.(created);
  if (shouldContinue && !shouldContinue()) {
    throw new MaterialAssignmentAfterCreateError(
      objectId,
      materialId,
      created,
      anisotropy,
      new Error("Material assignment transaction scope is no longer active."),
    );
  }
  try {
    const assigned = await api.model.patchObject(objectId, {
      base_revision: created.scene_revision,
      material_ref: materialId,
    });
    return { assigned, created, deferredAnisotropy: anisotropy, materialId };
  } catch (error) {
    throw new MaterialAssignmentAfterCreateError(
      objectId,
      materialId,
      created,
      anisotropy,
      error,
    );
  }
}

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

export function magneticParametersDraftDirty(
  draft: MagneticParametersDraft,
  baseDraft: MagneticParametersDraft,
): boolean {
  return (
    draft.materialRef !== baseDraft.materialRef ||
    draft.materialName !== baseDraft.materialName ||
    numericTextDirty(draft.ms, baseDraft.ms) ||
    numericTextDirty(draft.aex, baseDraft.aex) ||
    numericTextDirty(draft.alpha, baseDraft.alpha) ||
    numericTextDirty(draft.dind, baseDraft.dind) ||
    numericTextDirty(draft.dbulk, baseDraft.dbulk)
  );
}

function numericTextDirty(value: string, baseValue: string): boolean {
  const parsed = Number(value);
  const baseParsed = Number(baseValue);
  if (Number.isFinite(parsed) && Number.isFinite(baseParsed)) {
    return parsed !== baseParsed;
  }
  return value.trim() !== baseValue.trim();
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
