import type {
  FieldDriveListResource,
  RegionalFieldDriveResource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";

export interface RegionalFieldDrivePanelModel {
  drive: RegionalFieldDriveResource | null;
  driveId: string | null;
  mode: "found" | "missing" | "unselected";
  sceneRevision: number | null;
}

export interface RegionalFieldDriveSelectorOptions {
  objects: Array<{ id: string; label: string }>;
  regionsByObject: Record<string, Array<{ id: string; label: string }>>;
  timeEvolutionStages: Array<{ id: string; label: string }>;
}

type JsonRecord = Record<string, unknown>;

export function regionalFieldDriveSelectorOptions(
  scene: SceneResource | null,
): RegionalFieldDriveSelectorOptions {
  const objects = (scene?.objects ?? []).map((object) => ({
    id: object.id,
    label: object.name?.trim() ? `${object.name} (${object.id})` : object.id,
  }));
  const regionsByObject = Object.fromEntries(
    (scene?.objects ?? []).map((object) => [
      object.id,
      (object.regions ?? []).flatMap((region) => {
        const id = region.region_id?.trim();
        if (!id) return [];
        return [{
          id,
          label: region.name.trim() ? `${region.name} (${id})` : id,
        }];
      }),
    ]),
  );
  const study = isRecord(scene?.study) ? scene.study : null;
  const stages = Array.isArray(study?.stages) ? study.stages : [];
  const timeEvolutionStages = stages.flatMap((value, index) => {
    if (!isRecord(value)) return [];
    const kind = typeof value.kind === "string" ? value.kind : null;
    const id =
      typeof value.stage_id === "string"
        ? value.stage_id
        : typeof value.id === "string"
          ? value.id
          : null;
    if (!id || kind !== "run") return [];
    return [{ id, label: `${id} (run ${index + 1})` }];
  });
  return { objects, regionsByObject, timeEvolutionStages };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveRegionalFieldDrivePanelModel(
  selection: Selection,
  resource: FieldDriveListResource | null,
): RegionalFieldDrivePanelModel {
  const driveId =
    selection.ref?.type === "physics-field-drive"
      ? selection.ref.fieldDriveId
      : null;
  if (!driveId) {
    return { drive: null, driveId: null, mode: "unselected", sceneRevision: null };
  }
  const drive = resource?.drives.find((candidate) => candidate.id === driveId) ?? null;
  return {
    drive,
    driveId,
    mode: drive ? "found" : "missing",
    sceneRevision: resource?.scene_revision ?? null,
  };
}
