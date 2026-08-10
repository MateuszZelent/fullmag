import type {
  FieldDriveListResource,
  RegionalFieldDriveResource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";

export interface RegionalFieldDrivePanelModel {
  drive: RegionalFieldDriveResource | null;
  driveId: string | null;
  mode: "create" | "found" | "missing" | "unselected";
  sceneRevision: number | null;
}

export interface RegionalFieldDriveSelectorOptions {
  objects: Array<{ id: string; label: string }>;
  regionsByObject: Record<string, Array<{ id: string; label: string }>>;
  timeEvolutionStages: Array<{ id: string; label: string }>;
}

export interface RegionalFieldDriveSamplingContext {
  samplePeriodS: number | null;
  solverDtS: number | null;
  durationS: number | null;
}

interface RegionalFieldDriveMutationApi {
  createFieldDrive(request: {
    base_revision: number;
    drive: RegionalFieldDriveResource;
  }): Promise<{ scene_revision: number }>;
  replaceFieldDrive(
    driveId: string,
    request: {
      base_revision: number;
      drive: RegionalFieldDriveResource;
    },
  ): Promise<{ scene_revision: number }>;
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

export function regionalFieldDriveSamplingContext(
  scene: SceneResource | null,
  activation: RegionalFieldDriveResource["activation"] | null,
): RegionalFieldDriveSamplingContext {
  const study = isRecord(scene?.study) ? scene.study : null;
  const outputs = isRecord(scene?.outputs) ? scene.outputs : null;
  const sampling = isRecord(study?.sampling) ? study.sampling : null;
  const tableAutosave = firstRecord(
    outputs?.table_autosave,
    outputs?.tableautosave,
    sampling?.table_autosave,
    sampling?.tableautosave,
  );
  const stages = Array.isArray(study?.stages) ? study.stages.filter(isRecord) : [];
  const selectedStage = stages.find((stage) => {
    if (stage.kind !== "run") return false;
    if (activation?.kind !== "stage_ids") return true;
    const id = typeof stage.stage_id === "string" ? stage.stage_id : stage.id;
    return typeof id === "string" && activation.stage_ids.includes(id);
  });
  const solver = isRecord(study?.solver) ? study.solver : null;
  return {
    samplePeriodS: firstPositiveNumber(
      tableAutosave?.sample_period_s,
      tableAutosave?.every_seconds,
      selectedStage?.output_every_seconds,
      selectedStage?.output_every,
    ),
    solverDtS: firstPositiveNumber(solver?.dt_seconds, solver?.dt, study?.dt_seconds, study?.dt),
    durationS: firstPositiveNumber(
      selectedStage?.until_seconds,
      selectedStage?.until,
      selectedStage?.duration_s,
    ),
  };
}

function firstRecord(...values: unknown[]): JsonRecord | null {
  return values.find(isRecord) ?? null;
}

function firstPositiveNumber(...values: unknown[]): number | null {
  const value = values.find((candidate) =>
    typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0,
  );
  return typeof value === "number" ? value : null;
}

export function resolveRegionalFieldDrivePanelModel(
  selection: Selection,
  resource: FieldDriveListResource | null,
): RegionalFieldDrivePanelModel {
  const createRequested =
    selection.ref?.type === "physics-field-drive" &&
    selection.ref.draft === true;
  if (createRequested) {
    return {
      drive: createRegionalFieldDriveDraft(resource?.drives ?? []),
      driveId: null,
      mode: "create",
      sceneRevision: resource?.scene_revision ?? null,
    };
  }
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

export function createRegionalFieldDriveDraft(
  existing: readonly RegionalFieldDriveResource[],
): RegionalFieldDriveResource {
  const ids = new Set(existing.map((drive) => drive.id));
  let id = "field-drive";
  let suffix = 2;
  while (ids.has(id)) {
    id = `field-drive-${suffix}`;
    suffix += 1;
  }
  return {
    activation: { kind: "all_time_evolution" },
    amplitude_B_T: 1e-3,
    direction: [0, 1, 0],
    enabled: true,
    id,
    kind: "regional",
    name: "Global field drive",
    spatial_profile: { kind: "uniform" },
    target: { kind: "global" },
    time_origin: "stage_local",
    waveform: { kind: "constant" },
  };
}

export function commitRegionalFieldDrive(
  api: RegionalFieldDriveMutationApi,
  mode: "create" | "found",
  baseRevision: number,
  drive: RegionalFieldDriveResource,
): Promise<{ scene_revision: number }> {
  const request = { base_revision: baseRevision, drive };
  return mode === "create"
    ? api.createFieldDrive(request)
    : api.replaceFieldDrive(drive.id, request);
}
