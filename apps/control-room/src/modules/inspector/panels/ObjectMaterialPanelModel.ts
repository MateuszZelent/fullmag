import type {
  AuthoringTransactionResponse,
  MaterialPatchRequest,
  MaterialPropertiesResource,
  MaterialLibraryEntryResource,
  MaterialReferenceResource,
  SceneMaterialSource,
  MaterialResource,
  ObjectPatchRequest,
  SceneResource,
} from "@/kernel/api/apiTypes";

import { authoringWriteOptions } from "@/kernel/authoring/authoringHistoryMutation";
import {
  materialPropertiesFromDraft,
} from "@/shared/domain/material/materialLibrary";

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
      references: MaterialReferenceResource[],
      options?: { baseRevision?: number; sessionScopeKey?: string },
      asset?: { source?: SceneMaterialSource | null; assignToObjectId?: string },
    ): Promise<AuthoringTransactionResponse>;
    patchObject(
      objectId: string,
      patch: ObjectPatchRequest,
      options?: { sessionScopeKey?: string },
    ): Promise<SceneResource>;
  };
}

export class MaterialAssignmentAfterCreateError extends Error {
  readonly assignmentBaseRevision: number;
  readonly created: AuthoringTransactionResponse;
  readonly deferredAnisotropy: ValidatedCreateMaterialDraft["anisotropy"];
  readonly materialId: string;
  readonly objectId: string;
  readonly sessionScopeKey: string | null;

  constructor(
    objectId: string,
    materialId: string,
    created: AuthoringTransactionResponse,
    deferredAnisotropy: ValidatedCreateMaterialDraft["anisotropy"],
    cause: unknown,
    sessionScopeKey?: string | null,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "MaterialAssignmentAfterCreateError";
    this.assignmentBaseRevision = created.scene_revision;
    this.created = created;
    this.deferredAnisotropy = deferredAnisotropy;
    this.materialId = materialId;
    this.objectId = objectId;
    this.sessionScopeKey = sessionScopeKey ?? null;
  }

  retry(api: MaterialCreateAssignApi, latestBaseRevision: number): Promise<SceneResource> {
    const options = this.sessionScopeKey
      ? { sessionScopeKey: this.sessionScopeKey }
      : undefined;
    const patch = {
      base_revision: latestBaseRevision,
      material_ref: this.materialId,
    };
    return options
      ? api.model.patchObject(this.objectId, patch, options)
      : api.model.patchObject(this.objectId, patch);
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
  if (!draft.ms.trim()) return { error: "Ms is required." };
  if (!draft.aex.trim()) return { error: "Aex is required." };
  const parsed = materialPropertiesFromDraft({
    Ms: draft.ms, Aex: draft.aex, alpha: draft.alpha, Dind: "", Dbulk: "",
  });
  if ("error" in parsed) return { error: parsed.error.replace("finite decimal SI", "finite SI") };
  const anisotropy = buildUniaxialAnisotropyPatch(draft.ku1, draft.anisotropyAxis);
  if ("error" in anisotropy) return anisotropy;
  return {
    value: {
      anisotropy: anisotropy.value,
      materialId,
      name,
      properties: parsed.properties,
    },
  };
}

export interface MaterialAssetAssignment {
  materialId: string;
  name: string;
  properties: MaterialPropertiesResource;
  references: MaterialReferenceResource[];
  source: SceneMaterialSource | null;
}

function copySource(source: SceneMaterialSource | null | undefined): SceneMaterialSource | null {
  return source ? {
    ...source,
    properties: { ...source.properties },
    references: (source.references ?? []).map((reference) => ({ ...reference })),
  } : null;
}

export function materialAssetFromLibraryEntry(entry: MaterialLibraryEntryResource): MaterialAssetAssignment {
  return {
    materialId: `mat:${crypto.randomUUID()}`,
    name: entry.name,
    properties: { ...entry.properties },
    references: (entry.references ?? []).map((reference) => ({ ...reference })),
    source: {
      catalog_id: entry.id,
      catalog_revision: entry.revision,
      name: entry.name,
      kind: entry.kind,
      properties: { ...entry.properties },
      references: (entry.references ?? []).map((reference) => ({ ...reference })),
    },
  };
}

export function independentMaterialAsset(material: MaterialResource): MaterialAssetAssignment {
  return {
    materialId: `mat:${crypto.randomUUID()}`,
    name: `${material.name} copy`,
    properties: { ...material.properties },
    references: (material.references ?? []).map((reference) => ({ ...reference })),
    source: copySource(material.source),
  };
}

export function buildMaterialAssetAssignment(
  asset: MaterialAssetAssignment,
): { error: string } | { value: MaterialAssetAssignment } {
  if (!asset.materialId.trim()) return { error: "Material id must not be empty." };
  if (!asset.name.trim()) return { error: "Material name must not be empty." };
  const text = (value: number | null | undefined): string => value == null ? "" : String(value);
  const parsed = materialPropertiesFromDraft({
    Ms: text(asset.properties.Ms), Aex: text(asset.properties.Aex),
    alpha: text(asset.properties.alpha), Dind: text(asset.properties.Dind), Dbulk: text(asset.properties.Dbulk),
  });
  if ("error" in parsed) return { error: parsed.error };
  // Null Ms/Aex are valid authoring values. The model's readiness gate owns
  // whether this incomplete material can be used for a computation.
  return { value: {
    materialId: asset.materialId,
    name: asset.name.trim(),
    properties: parsed.properties,
    references: asset.references.map((reference) => ({ ...reference })),
    source: copySource(asset.source),
  } };
}

/** One server transaction creates an independent asset and assigns it. */
export async function createMaterialAssetThenAssign(
  api: MaterialCreateAssignApi,
  objectId: string,
  asset: MaterialAssetAssignment,
  baseRevision: number,
  shouldContinue: () => boolean,
  sessionScopeKey?: string | null,
): Promise<{
  assigned: SceneResource;
  created: AuthoringTransactionResponse;
  deferredAnisotropy: null;
  materialId: string;
}> {
  const validated = buildMaterialAssetAssignment(asset);
  if ("error" in validated) throw new Error(validated.error);
  if (!shouldContinue()) throw new Error("Material assignment scope is no longer active.");
  const input = validated.value;
  const created = await api.model.createMaterial(
    input.materialId, input.name, input.properties, input.references,
    authoringWriteOptions(baseRevision, sessionScopeKey),
    { source: input.source, assignToObjectId: objectId },
  );
  return {
    assigned: created.committed_scene,
    created,
    deferredAnisotropy: null,
    materialId: input.materialId,
  };
}

export async function createMaterialThenAssign(
  api: MaterialCreateAssignApi,
  objectId: string,
  draft: CreateMaterialDraft,
  baseRevision: number,
  onMaterialCreated?: (created: AuthoringTransactionResponse) => void,
  shouldContinue?: () => boolean,
  sessionScopeKey?: string | null,
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
    {
      baseRevision,
      ...(sessionScopeKey ? { sessionScopeKey } : {}),
    },
  );
  onMaterialCreated?.(created);
  if (shouldContinue && !shouldContinue()) {
    throw new MaterialAssignmentAfterCreateError(
      objectId,
      materialId,
      created,
      anisotropy,
      new Error("Material assignment transaction scope is no longer active."),
      sessionScopeKey,
    );
  }
  try {
    const patch = {
      base_revision: created.scene_revision,
      material_ref: materialId,
    };
    const assignmentOptions = sessionScopeKey
      ? { sessionScopeKey }
      : undefined;
    const assigned = assignmentOptions
      ? await api.model.patchObject(objectId, patch, assignmentOptions)
      : await api.model.patchObject(objectId, patch);
    return { assigned, created, deferredAnisotropy: anisotropy, materialId };
  } catch (error) {
    throw new MaterialAssignmentAfterCreateError(
      objectId,
      materialId,
      created,
      anisotropy,
      error,
      sessionScopeKey,
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

export interface AcknowledgedAssignmentBaseOverride {
  baseDraft: MagneticParametersDraft;
  baseKey: string;
  identityKey: string;
  materialId: string;
  objectId: string;
  sceneRevision: number | null;
  scopeKey: string;
  scopeToken: symbol;
}

export function sceneResourceRevision(
  scene: Pick<SceneResource, "revision" | "scene_revision"> | null | undefined,
): number | null {
  const revision = scene?.scene_revision ?? scene?.revision;
  return typeof revision === "number" && Number.isFinite(revision) ? revision : null;
}

export function acknowledgedAssignmentBaseDecision({
  override,
  currentSceneBaseKey,
  currentResourceBaseKey,
  currentMaterialId,
  currentObjectId,
  currentSceneRevision,
  currentScopeKey,
  currentScopeToken,
}: {
  override: AcknowledgedAssignmentBaseOverride;
  currentSceneBaseKey: string | null;
  currentResourceBaseKey: string;
  currentMaterialId: string | null;
  currentObjectId: string;
  currentSceneRevision: number | null;
  currentScopeKey: string;
  currentScopeToken: symbol;
}): "use" | "rebase" | "discard" {
  if (override.scopeKey !== currentScopeKey || override.scopeToken !== currentScopeToken ||
    override.objectId !== currentObjectId) {
    return "discard";
  }
  if (override.sceneRevision === null || currentSceneRevision === null ||
    currentSceneRevision < override.sceneRevision) {
    return "use";
  }
  if (override.materialId !== currentMaterialId) return "discard";
  if (!currentSceneBaseKey) return "use";
  if (currentSceneRevision > override.sceneRevision ||
    currentSceneBaseKey !== override.baseKey || currentResourceBaseKey === currentSceneBaseKey) {
    return "rebase";
  }
  return "use";
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
  material: MaterialResource | NonNullable<SceneResource["materials"]>[number] | null | undefined,
): MagneticParametersDraft {
  return {
    aex: formatOptionalNumber(material?.properties?.Aex),
    alpha: formatRequiredNumber(material?.properties?.alpha, 0.01),
    dind: formatOptionalNumber(material?.properties?.Dind),
    dbulk: formatOptionalNumber(material?.properties?.Dbulk),
    materialName: material?.name ?? "",
    materialRef: normalizeMaterialRef(materialRef ?? "") ?? "",
    ms: formatOptionalNumber(material?.properties?.Ms),
  };
}

export function assignedMaterialParametersDraft(
  materialId: string,
  scene: SceneResource,
): MagneticParametersDraft {
  const material = scene.materials?.find((entry) => entry.id === materialId);
  if (!material) {
    throw new Error(`Assigned material '${materialId}' is missing from the acknowledged scene.`);
  }
  return magneticParametersDraftFromResource(materialId, material);
}

export function materialParametersDraftKey(
  materialRef: string | null | undefined,
  material: MaterialResource | null | undefined,
): string {
  return [
    normalizeMaterialRef(materialRef ?? "") ?? "",
    material?.id ?? "missing",
    material?.name ?? "",
    formatOptionalNumber(material?.properties?.Ms),
    formatOptionalNumber(material?.properties?.Aex),
    formatRequiredNumber(material?.properties?.alpha, 0.01),
    formatOptionalNumber(material?.properties?.Dind),
    formatOptionalNumber(material?.properties?.Dbulk),
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

const MAGNETIC_PARAMETER_DRAFT_FIELDS = [
  "aex",
  "alpha",
  "dbulk",
  "dind",
  "materialName",
  "materialRef",
  "ms",
] as const satisfies readonly (keyof MagneticParametersDraft)[];

/** Validate scene material data into the resource shape used by the material hook. */
export function magneticParameterMaterialResourceFromSceneResource(
  materialId: string,
  scene: Pick<SceneResource, "materials" | "revision" | "scene_revision">,
): MaterialResource | null {
  const material = scene.materials?.find((candidate) => candidate.id === materialId);
  if (!material || !material.id || typeof material.name !== "string") return null;
  const properties = material.properties;
  const aex = properties?.Aex;
  const dbulk = properties?.Dbulk;
  const dind = properties?.Dind;
  const ms = properties?.Ms;
  const alpha = typeof properties?.alpha === "number" && Number.isFinite(properties.alpha)
    ? properties.alpha
    : 0.01;
  if (!isOptionalFiniteNumber(aex) || !isOptionalFiniteNumber(dbulk)
    || !isOptionalFiniteNumber(dind) || !isOptionalFiniteNumber(ms)) {
    return null;
  }
  const resource: MaterialResource = {
    id: material.id,
    name: material.name,
    properties: {
      Aex: aex ?? null,
      Dbulk: dbulk ?? null,
      Dind: dind ?? null,
      Ms: ms ?? null,
      alpha,
    },
    references: (material.references ?? []).map((reference) => ({ ...reference })),
    source: copySource(material.source),
    scene_revision: scene.scene_revision ?? scene.revision ?? 0,
  };
  return resource;
}

/** Read the material values from an acknowledged scene mutation response. */
export function magneticParametersDraftFromSceneResource(
  materialId: string,
  scene: Pick<SceneResource, "materials" | "revision" | "scene_revision">,
): MagneticParametersDraft | null {
  const material = magneticParameterMaterialResourceFromSceneResource(materialId, scene);
  return material ? magneticParametersDraftFromResource(materialId, material) : null;
}

/**
 * Rebase a completed assignment onto the committed material while retaining
 * only real pre-existing edits and fields edited since the operation began.
 */
export function rebaseMagneticParametersDraftAfterAssignment({
  previousBaseDraft,
  draftAtStart,
  currentDraft,
  committedBaseDraft,
  startingRevisions,
  currentRevisions,
}: {
  previousBaseDraft: MagneticParametersDraft;
  draftAtStart: MagneticParametersDraft;
  currentDraft: MagneticParametersDraft;
  committedBaseDraft: MagneticParametersDraft;
  startingRevisions: ReadonlyMap<keyof MagneticParametersDraft, number>;
  currentRevisions: ReadonlyMap<keyof MagneticParametersDraft, number>;
}): MagneticParametersDraft {
  const rebased = { ...committedBaseDraft };
  for (const field of MAGNETIC_PARAMETER_DRAFT_FIELDS) {
    const dirtyBefore = magneticParameterFieldDirty(
      field,
      draftAtStart[field],
      previousBaseDraft[field],
    );
    const changedDuring = (currentRevisions.get(field) ?? 0)
      !== (startingRevisions.get(field) ?? 0);
    if (dirtyBefore || changedDuring) {
      Object.assign(rebased, { [field]: currentDraft[field] });
    }
  }
  return rebased;
}

function magneticParameterFieldDirty(
  field: keyof MagneticParametersDraft,
  value: string,
  baseValue: string,
): boolean {
  if (field === "materialName" || field === "materialRef") return value !== baseValue;
  return numericTextDirty(value, baseValue);
}

function isOptionalFiniteNumber(value: unknown): value is number | null | undefined {
  return value === undefined || value === null
    || (typeof value === "number" && Number.isFinite(value));
}

function numericTextDirty(value: string, baseValue: string): boolean {
  if (!value.trim() || !baseValue.trim()) return value.trim() !== baseValue.trim();
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
  const parsed = materialPropertiesFromDraft({
    Ms: draft.ms, Aex: draft.aex, alpha: draft.alpha, Dind: draft.dind, Dbulk: draft.dbulk,
  });
  if ("error" in parsed) return { error: parsed.error.replace("finite decimal SI", "finite SI") };

  const name = draft.materialName.trim();
  return {
    patch: {
      name: name || null,
      properties: parsed.properties,
    },
  };
}

function formatOptionalNumber(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function formatRequiredNumber(
  value: unknown,
  fallback: number,
): string {
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : String(fallback);
}
