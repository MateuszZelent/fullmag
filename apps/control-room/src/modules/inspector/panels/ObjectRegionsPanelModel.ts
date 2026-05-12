import type {
  RegionListResource,
  RegionPatchRequest,
  SceneResource,
} from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";

interface JsonRecord {
  [key: string]: unknown;
}

export interface ObjectRegionPanelModel {
  enabled: boolean;
  magnetizationRef: string;
  materialRef: string;
  mode: "committed" | "missing";
  objectId: string;
  regionId: string;
  regionName: string;
  revision: number | null;
  source: string;
}

export interface ObjectRegionDraft {
  enabled: boolean;
  name: string;
}

function asRecord(value: unknown): JsonRecord | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function selectedObjectId(selection: Selection): string | null {
  return selection.ref?.type === "scene-object"
    ? selection.ref.objectId
    : selection.objectId;
}

function sceneObjectForSelection(
  selection: Selection,
  scene: SceneResource | null,
): { object: JsonRecord | null; objectId: string | null; revision: number | null } {
  const objectId = selectedObjectId(selection);
  const sceneRecord = asRecord(scene);
  const object = Array.isArray(sceneRecord?.objects)
    ? sceneRecord.objects
        .map(asRecord)
        .find((entry) => asString(entry?.id) === objectId) ?? null
    : null;

  return {
    object,
    objectId,
    revision: asNumber(sceneRecord?.revision),
  };
}

function regionForObject(
  objectId: string | null,
  object: JsonRecord | null,
  regions: RegionListResource | null,
): RegionListResource["regions"][number] | null {
  if (!objectId) return null;
  const objectRegionName = asString(object?.region_name);
  return (
    regions?.regions.find((region) => {
      return (
        region.source_object_ids.includes(objectId) ||
        region.region_id === `region:${objectId}` ||
        (objectRegionName ? region.name === objectRegionName : false)
      );
    }) ?? null
  );
}

export function resolveObjectRegionPanelModel(
  selection: Selection,
  scene: SceneResource | null,
  regions: RegionListResource | null,
): ObjectRegionPanelModel {
  const { object, objectId, revision } = sceneObjectForSelection(selection, scene);
  const region = regionForObject(objectId, object, regions);
  const fallbackName =
    asString(object?.region_name) ?? asString(object?.name) ?? objectId ?? "none";

  if (!object || !objectId) {
    return {
      enabled: false,
      magnetizationRef: "unassigned",
      materialRef: "unassigned",
      mode: "missing",
      objectId: objectId ?? "none",
      regionId: objectId ? `region:${objectId}` : "none",
      regionName: fallbackName,
      revision,
      source: "missing",
    };
  }

  return {
    enabled: region?.enabled ?? object.visible !== false,
    magnetizationRef:
      region?.magnetization_ref ?? asString(object.magnetization_ref) ?? "unassigned",
    materialRef: region?.material_ref ?? asString(object.material_ref) ?? "unassigned",
    mode: "committed",
    objectId,
    regionId: region?.region_id ?? `region:${objectId}`,
    regionName: region?.name ?? fallbackName,
    revision,
    source: region?.source ?? "scene-object",
  };
}

export function objectRegionDraftFromModel(
  model: ObjectRegionPanelModel,
): ObjectRegionDraft {
  return {
    enabled: model.enabled,
    name: model.regionName === "unassigned" ? "" : model.regionName,
  };
}

export function objectRegionDraftKey(model: ObjectRegionPanelModel): string {
  return [
    model.objectId,
    model.regionId,
    model.regionName,
    model.enabled ? "enabled" : "disabled",
    model.revision ?? "unknown",
  ].join(":");
}

export function buildObjectRegionPatch(
  draft: ObjectRegionDraft,
): RegionPatchRequest {
  return {
    enabled: draft.enabled,
    name: draft.name.trim(),
  };
}
