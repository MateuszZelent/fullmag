import type {
  CouplingListResource,
  HysteresisExecutionTreeResource,
  MaterialParameterFieldListResource,
  MeshRegionMembershipResource,
  RegionListResource,
  SceneResource,
  StageExecutionResource,
} from "@/kernel/api/apiTypes";
import { isVisualizationAirboxIdentity } from "@/kernel/selection/selectionTypes";
import { apmFromTesla } from "@/shared/domain/physics/torqueUnits";
import { resolveRegionMeshLifecycle } from "@/shared/domain/mesh/regionMeshLifecycle";

import type {
  ExplorerNodeStatus,
  ModelTreeCouplingSnapshot,
  ModelTreeFieldDriveSnapshot,
  ModelTreeMaterialSnapshot,
  ModelTreeHysteresisSettleStepSnapshot,
  ModelTreeMaterialFieldSnapshot,
  ModelTreeObjectSnapshot,
  ModelTreeObjectRegionSnapshot,
  ModelTreePhysicsInteractionSnapshot,
  ModelTreeSnapshot,
} from "../explorerTypes";

interface SceneLike {
  [key: string]: unknown;
  current_modules?: unknown;
  field_drives?: unknown;
  magnetization_assets?: unknown;
  materials?: unknown;
  objects?: SceneResource["objects"] | unknown;
  study?: unknown;
  universe?: unknown;
}

type SceneObjectResource = NonNullable<SceneResource["objects"]>[number];
type SceneMaterialParameterAssignment = NonNullable<
  SceneObjectResource["material_parameter_fields"]
>[number];

interface ModelTreeResourceInputs {
  couplings?: CouplingListResource | null;
  materialFields?: MaterialParameterFieldListResource | null;
  regions?: RegionListResource | null;
  regionMemberships?: readonly MeshRegionMembershipResource[] | null;
}

export function modelTreeSnapshotFromScene(
  scene: SceneLike | null | undefined,
  resources: ModelTreeResourceInputs = {},
): ModelTreeSnapshot {
  const materials = sceneMaterials(scene?.materials);
  const materialById = new Map(
    materials.map((material) => [material.id, material]),
  );
  const magnetizationAssets = sceneMagnetizationAssets(
    scene?.magnetization_assets,
  );
  const magnetizationById = new Map(
    magnetizationAssets.map((asset) => [asset.id, asset]),
  );
  const materialFieldsByObject = materialFieldsByOwner(
    resources.materialFields,
    scene?.objects,
  );
  const authoredRegionsByObject = authoredRegionsByOwner(
    resources.regions,
    scene?.objects,
    materialFieldsByObject,
    resources.regionMemberships,
  );
  return {
    couplings: couplingSnapshots(resources.couplings, scene),
    fieldDrives: fieldDriveSnapshots(scene?.field_drives),
    materials,
    objects: Array.isArray(scene?.objects)
      ? scene.objects.reduce<ModelTreeObjectSnapshot[]>((objects, object) => {
          if (isSyntheticAirboxSceneObject(object)) return objects;
          const snapshot = sceneObjectSnapshot(
            object,
            materialById,
            magnetizationById,
            authoredRegionsByObject,
            materialFieldsByObject,
          );
          if (snapshot) {
            objects.push(snapshot);
          }
          return objects;
        }, [])
      : [],
    physicsInteractions: scenePhysicsInteractions(scene?.objects),
    study: sceneStudySnapshot(scene?.study),
    universe: sceneUniverseSnapshot(scene?.universe),
  };
}

function fieldDriveSnapshots(value: unknown): ModelTreeFieldDriveSnapshot[] {
  const state = recordValue(value);
  const drives = Array.isArray(state?.drives) ? state.drives : [];
  return drives.flatMap((candidate) => {
    const drive = recordValue(candidate);
    const id = stringValue(drive?.id);
    if (!drive || !id) return [];
    return [{
      enabled: drive.enabled !== false,
      id,
      label: stringValue(drive.name) ?? id,
      targetKind: stringValue(recordValue(drive.target)?.kind) ?? "unresolved",
      waveformKind: stringValue(recordValue(drive.waveform)?.kind) ?? "unresolved",
    }];
  });
}

function isSyntheticAirboxSceneObject(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  return isVisualizationAirboxIdentity({
    id: stringValue(object.id),
    role: stringValue(object.role),
  });
}

export function modelTreeSnapshotWithStageExecution(
  snapshot: ModelTreeSnapshot,
  stageExecution: StageExecutionResource | null | undefined,
): ModelTreeSnapshot {
  if (!snapshot.study || !stageExecution?.stages.length) return snapshot;

  const runtimeByStageId = new Map<
    string,
    (typeof stageExecution.stages)[number]
  >();
  for (const stage of stageExecution.stages) {
    if (typeof stage.stage_id === "string") {
      runtimeByStageId.set(stage.stage_id, stage);
    }
  }

  return {
    ...snapshot,
    study: {
      ...snapshot.study,
      stages: snapshot.study.stages.map((stage, index) => {
        const runtimeStage =
          (stage.stageId ? runtimeByStageId.get(stage.stageId) : undefined) ??
          stageExecution.stages.find((candidate) => candidate.index === index) ??
          stageExecution.stages[index] ??
          null;
        const runtimeStatus =
          runtimeStage?.status ?? stageExecution.stage_statuses[index] ?? null;
        return {
          ...stage,
          stageId: runtimeStage?.stage_id ?? stage.stageId,
          status: explorerStatusFromRuntimeStage(runtimeStatus) ?? stage.status,
          stateTransition:
            runtimeStage?.state_transition ?? stage.stateTransition ?? null,
          stateTransitionKind:
            runtimeStage?.state_transition_kind ??
            stage.stateTransitionKind ??
            null,
          stateTransitionReason:
            runtimeStage?.state_transition_reason ??
            stage.stateTransitionReason ??
            null,
          stateTransferOperatorKind:
            runtimeStage?.state_transfer_operator_kind ??
            stage.stateTransferOperatorKind ??
            null,
          stateTransitionUiPresentation:
            runtimeStage?.state_transition_ui_presentation ??
            stage.stateTransitionUiPresentation ??
            null,
          hysteresisCurrentFieldMt:
            runtimeStage?.current_field_mT ?? stage.hysteresisCurrentFieldMt ?? null,
          hysteresisCurrentPointIndex:
            runtimeStage?.current_point_index ??
            stage.hysteresisCurrentPointIndex ??
            null,
          hysteresisCurrentSettleStepIndex:
            runtimeStage?.current_settle_step_index ??
            stage.hysteresisCurrentSettleStepIndex ??
            null,
          hysteresisCurrentSettleStepKind:
            runtimeStage?.current_settle_step_kind ??
            stage.hysteresisCurrentSettleStepKind ??
            null,
          hysteresisCurrentSettleStepMethod:
            runtimeStage?.current_settle_step_method ??
            stage.hysteresisCurrentSettleStepMethod ??
            null,
        };
      }),
    },
  };
}

export function modelTreeSnapshotWithHysteresisExecutionTree(
  snapshot: ModelTreeSnapshot,
  executionTree: HysteresisExecutionTreeResource | null | undefined,
): ModelTreeSnapshot {
  if (!snapshot.study || !executionTree) return snapshot;

  return {
    ...snapshot,
    study: {
      ...snapshot.study,
      stages: snapshot.study.stages.map((stage) => {
        if (stage.stageId !== executionTree.stage_id) return stage;
        return {
          ...stage,
          hysteresisExecutionTree: executionTree,
        };
      }),
    },
  };
}

function explorerStatusFromRuntimeStage(
  status: string | null | undefined,
): ExplorerNodeStatus | null {
  if (!status) return null;
  const normalized = status.toLowerCase();
  if (
    normalized === "queued" ||
    normalized === "running" ||
    normalized === "paused" ||
    normalized === "completed" ||
    normalized === "skipped" ||
    normalized === "cancelled" ||
    normalized === "failed"
  ) {
    return normalized;
  }
  if (normalized === "error" || normalized === "rejected") return "failed";
  if (normalized === "warning") return "warning";
  return null;
}

function sceneMaterials(value: unknown): ModelTreeMaterialSnapshot[] {
  if (!Array.isArray(value)) return [];

  return value.reduce<ModelTreeMaterialSnapshot[]>((materials, item) => {
    if (!item || typeof item !== "object") return materials;
    const material = item as Record<string, unknown>;
    const id = stringValue(material.id);
    if (!id) return materials;
    materials.push({
      id,
      label: stringValue(material.name) ?? id,
      propertyKeys: materialPropertyKeys(material.properties),
    });
    return materials;
  }, []);
}

interface SceneMagnetizationAssetSnapshot {
  id: string;
  kind: string | null;
  label: string;
  textureTransformAvailable: boolean;
}

function sceneMagnetizationAssets(
  value: unknown,
): SceneMagnetizationAssetSnapshot[] {
  if (!Array.isArray(value)) return [];

  return value.reduce<SceneMagnetizationAssetSnapshot[]>((assets, item) => {
    if (!item || typeof item !== "object") return assets;
    const asset = item as Record<string, unknown>;
    const id = stringValue(asset.id);
    if (!id) return assets;
    const kind = stringValue(asset.kind);
    assets.push({
      id,
      kind,
      label:
        stringValue(asset.ui_label) ??
        stringValue(asset.name) ??
        stringValue(asset.preset_kind) ??
        kind ??
        id,
      textureTransformAvailable:
        kind === "preset_texture" && Boolean(asset.texture_transform),
    });
    return assets;
  }, []);
}

function materialPropertyKeys(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const keys: string[] = [];
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry !== null && entry !== undefined) {
      keys.push(key);
    }
  }
  return keys.sort();
}

function scenePhysicsInteractions(
  objects: unknown,
): ModelTreePhysicsInteractionSnapshot[] {
  if (!Array.isArray(objects)) return [];

  const byKind = new Map<string, { enabledCount: number; objectCount: number }>();

  for (const object of objects) {
    if (!object || typeof object !== "object") continue;
    const stack = (object as Record<string, unknown>).physics_stack;
    if (!Array.isArray(stack)) continue;

    for (const value of stack) {
      if (!value || typeof value !== "object") continue;
      const interaction = value as Record<string, unknown>;
      const kind = stringValue(interaction.kind);
      if (!kind) continue;
      const current = byKind.get(kind) ?? { enabledCount: 0, objectCount: 0 };
      current.objectCount += 1;
      if (interaction.enabled !== false) {
        current.enabledCount += 1;
      }
      byKind.set(kind, current);
    }
  }

  return Array.from(byKind.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, counts]) => ({
      enabledCount: counts.enabledCount,
      id: kind,
      label: interactionLabel(kind),
      objectCount: counts.objectCount,
    }));
}

function sceneObjectSnapshot(
  value: unknown,
  materialById: ReadonlyMap<string, ModelTreeMaterialSnapshot>,
  magnetizationById: ReadonlyMap<string, SceneMagnetizationAssetSnapshot>,
  authoredRegionsByObject: ReadonlyMap<string, ModelTreeObjectRegionSnapshot[]>,
  materialFieldsByObject: ReadonlyMap<string, ModelTreeMaterialFieldSnapshot[]>,
): ModelTreeObjectSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const object = value as Record<string, unknown>;
  const id = stringValue(object.id);
  if (!id) return null;
  const materialRef = stringValue(object.material_ref);
  const material = materialRef ? materialById.get(materialRef) : undefined;
  const magnetizationRef = stringValue(object.magnetization_ref);
  const magnetization = magnetizationRef
    ? magnetizationById.get(magnetizationRef)
    : undefined;
  const regionId = stringValue(object.region_name) ?? `region:${id}`;
  const regionMagnetizationRef = regionOverrideMagnetizationRef(
    object.region_overrides,
    regionId,
  );
  const regionMagnetization = regionMagnetizationRef
    ? magnetizationById.get(regionMagnetizationRef)
    : undefined;

  return {
    geometryKind: geometryKind(object.geometry),
    id,
    label: stringValue(object.name) ?? id,
    magnetization: magnetizationRef,
    magnetizationKind: magnetization?.kind,
    magnetizationLabel: magnetization?.label,
    material: materialRef,
    materialLabel: material?.label ?? materialRef,
    materialPropertyKeys: material?.propertyKeys,
    meshStatus: meshStatusFromTags(object.tags),
    objectRole: sceneObjectRole(object),
    physicsInteractions: sceneObjectPhysicsInteractions(
      object.physics_stack,
      materialHasDind(material),
      materialHasDbulk(material),
    ),
    region: stringValue(object.region_name),
    regionId,
    regionMagnetization: regionMagnetizationRef,
    regionMagnetizationKind: regionMagnetization?.kind,
    regionMagnetizationLabel: regionMagnetization?.label,
    regions: authoredRegionsByObject.get(id) ?? [],
    materialFields: materialFieldsByObject.get(id) ?? [],
    textureTransformAvailable:
      magnetization?.textureTransformAvailable ?? false,
  };
}

function sceneObjectRole(
  object: Record<string, unknown>,
): ModelTreeObjectSnapshot["objectRole"] {
  const role = stringValue(object.role);
  if (role === "antenna") return "antenna";
  if (role && role !== "magnet") return "auxiliary";
  const hint = recordValue(object.visualization_hint);
  if (stringValue(hint?.role) === "antenna") return "antenna";
  const tags = Array.isArray(object.tags) ? object.tags : [];
  if (tags.includes("role:antenna")) return "antenna";
  return "magnet";
}

function authoredRegionsByOwner(
  resource: RegionListResource | null | undefined,
  sceneObjects: unknown,
  materialFieldsByObject: ReadonlyMap<string, ModelTreeMaterialFieldSnapshot[]>,
  memberships: readonly MeshRegionMembershipResource[] | null | undefined,
): Map<string, ModelTreeObjectRegionSnapshot[]> {
  const byObject = new Map<string, ModelTreeObjectRegionSnapshot[]>();
  const membershipByRegionId = new Map(
    (memberships ?? []).map((membership) => [membership.region_id, membership]),
  );
  if (resource?.regions?.length) {
    for (const region of resource.regions) {
      if (region.source !== "authored_object_region") continue;
      const owner = stringValue(region.owner_object_id);
      if (!owner) continue;
      const fields = materialFieldsByObject.get(owner) ?? [];
      pushRegionSnapshot(
        byObject,
        owner,
        {
          enabled: region.enabled !== false,
          id: region.region_id,
          label: region.name,
          materialFieldCount: Math.max(
            region.material_parameter_fields?.length ?? 0,
            fields.filter((field) => field.regionId === region.region_id).length,
          ),
          materialOverrideCount: region.material_overrides?.length ?? 0,
          meshPolicyActive: Boolean(region.mesh_policy),
          meshLifecycleStatus: resolveRegionMeshLifecycle({
            build: null,
            draftDirty: false,
            membership: membershipByRegionId.get(region.region_id),
            policyEnabled: Boolean(region.mesh_policy),
            supported: true,
          }).status,
          priority: region.priority ?? null,
          realizationPolicy: region.realization_policy ?? null,
          realizationStatus: region.realization_status ?? null,
          shapeKind: shapeKind(region.shape),
          source: region.source,
          textureOverrideActive: Boolean(region.texture_override),
        },
      );
    }
    return sortRegionMap(byObject);
  }

  if (!Array.isArray(sceneObjects)) return byObject;
  for (const objectValue of sceneObjects) {
    const object = recordValue(objectValue);
    const objectId = stringValue(object?.id);
    if (!objectId || !Array.isArray(object?.regions)) continue;
    const fields = materialFieldsByObject.get(objectId) ?? [];
    for (const regionValue of object.regions) {
      const region = recordValue(regionValue);
      const id = stringValue(region?.region_id) ?? stringValue(region?.name);
      if (!id) continue;
      pushRegionSnapshot(byObject, objectId, {
        enabled: booleanValue(region?.enabled) ?? true,
        id,
        label: stringValue(region?.name) ?? id,
        materialFieldCount: fields.filter((field) => field.regionId === id).length,
        materialOverrideCount: arrayLength(region?.material_overrides),
        meshPolicyActive: Boolean(region?.mesh_policy),
        meshLifecycleStatus: resolveRegionMeshLifecycle({
          build: null,
          draftDirty: false,
          membership: membershipByRegionId.get(id),
          policyEnabled: Boolean(region?.mesh_policy),
          supported: true,
        }).status,
        priority: numberValue(region?.priority),
        realizationPolicy: stringValue(region?.realization_policy),
        realizationStatus: null,
        shapeKind: shapeKind(region?.shape),
        source: "authored_object_region",
        textureOverrideActive: Boolean(region?.texture_override),
      });
    }
  }
  return sortRegionMap(byObject);
}

function pushRegionSnapshot(
  byObject: Map<string, ModelTreeObjectRegionSnapshot[]>,
  objectId: string,
  region: ModelTreeObjectRegionSnapshot,
): void {
  const regions = byObject.get(objectId) ?? [];
  if (!regions.some((candidate) => candidate.id === region.id)) {
    regions.push(region);
  }
  byObject.set(objectId, regions);
}

function sortRegionMap(
  byObject: Map<string, ModelTreeObjectRegionSnapshot[]>,
): Map<string, ModelTreeObjectRegionSnapshot[]> {
  for (const [objectId, regions] of byObject) {
    byObject.set(
      objectId,
      regions.toSorted((left, right) => {
        const leftPriority = left.priority ?? 0;
        const rightPriority = right.priority ?? 0;
        if (leftPriority !== rightPriority) return rightPriority - leftPriority;
        return left.label.localeCompare(right.label);
      }),
    );
  }
  return byObject;
}

function materialFieldsByOwner(
  resource: MaterialParameterFieldListResource | null | undefined,
  sceneObjects: unknown,
): Map<string, ModelTreeMaterialFieldSnapshot[]> {
  const fields = new Map<string, ModelTreeMaterialFieldSnapshot[]>();
  const pushField = (field: ModelTreeMaterialFieldSnapshot) => {
    const ownerFields = fields.get(field.ownerObjectId) ?? [];
    if (!ownerFields.some((candidate) => candidate.id === field.id)) {
      ownerFields.push(field);
    }
    fields.set(field.ownerObjectId, ownerFields);
  };

  if (resource?.fields?.length) {
    for (const field of resource.fields) {
      pushField({
        id: field.assignment_id,
        label: materialFieldLabel(field.parameter, field.unit),
        ownerObjectId: field.owner_object_id,
        parameter: field.parameter,
        realizationStatus: field.realization_status ?? null,
        regionId: field.source_region_id ?? null,
        unit: field.unit ?? null,
      });
    }
    return fields;
  }

  if (!Array.isArray(sceneObjects)) return fields;
  for (const objectValue of sceneObjects) {
    const object = recordValue(objectValue);
    const ownerObjectId = stringValue(object?.id);
    if (!ownerObjectId) {
      continue;
    }
    for (const field of sceneMaterialParameterAssignments(
      object?.material_parameter_fields,
    )) {
      const owner = field.owner_object || ownerObjectId;
      const unit = field.value.unit ?? null;
      pushField({
        id: field.assignment_id,
        label: materialFieldLabel(field.parameter, unit),
        ownerObjectId: owner,
        parameter: field.parameter,
        realizationStatus: null,
        regionId: field.region_id ?? null,
        unit,
      });
    }
  }
  return fields;
}

function sceneMaterialParameterAssignments(
  value: unknown,
): SceneMaterialParameterAssignment[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is SceneMaterialParameterAssignment => {
    const assignment = recordValue(item);
    const field = recordValue(assignment?.value);
    return Boolean(
      stringValue(assignment?.assignment_id) &&
        stringValue(assignment?.owner_object) &&
        stringValue(assignment?.parameter) &&
        stringValue(field?.kind),
    );
  });
}

function couplingSnapshots(
  resource: CouplingListResource | null | undefined,
  scene: SceneLike | null | undefined,
): ModelTreeCouplingSnapshot[] {
  if (resource?.couplings?.length) {
    return resource.couplings.map((coupling) => ({
      enabled: coupling.enabled !== false,
      id: coupling.coupling_id,
      kind: coupling.coupling_kind,
      label: couplingLabel(
        coupling.coupling_kind,
        endpointLabel(coupling.source),
        endpointLabel(coupling.target),
      ),
      realizationStatus: coupling.realization_status ?? null,
      sourceLabel: endpointLabel(coupling.source),
      targetLabel: endpointLabel(coupling.target),
    }));
  }

  const sceneRecord = recordValue(scene);
  if (!Array.isArray(sceneRecord?.couplings)) return [];
  return sceneRecord.couplings.reduce<ModelTreeCouplingSnapshot[]>(
    (couplings, couplingValue) => {
      const coupling = recordValue(couplingValue);
      const id = stringValue(coupling?.coupling_id);
      const kind = stringValue(coupling?.kind);
      if (!id || !kind) return couplings;
      const sourceLabel = endpointLabel(coupling?.source);
      const targetLabel = endpointLabel(coupling?.target);
      couplings.push({
        enabled: booleanValue(coupling?.enabled) ?? true,
        id,
        kind,
        label: couplingLabel(kind, sourceLabel, targetLabel),
        realizationStatus: null,
        sourceLabel,
        targetLabel,
      });
      return couplings;
    },
    [],
  );
}

function regionOverrideMagnetizationRef(
  overrides: unknown,
  regionId: string,
): string | null {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    return null;
  }
  const override = (overrides as Record<string, unknown>)[regionId];
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    return null;
  }
  return stringValue((override as Record<string, unknown>).magnetization_ref);
}

function sceneObjectPhysicsInteractions(
  value: unknown,
  materialDindEnabled: boolean,
  materialDbulkEnabled: boolean,
): ModelTreePhysicsInteractionSnapshot[] {
  const byKind = new Map<string, { enabledCount: number; objectCount: number }>();
  byKind.set("exchange", { enabledCount: 1, objectCount: 1 });
  byKind.set("demag", { enabledCount: 1, objectCount: 1 });
  if (materialDindEnabled) {
    byKind.set("interfacial_dmi", { enabledCount: 1, objectCount: 1 });
  }
  if (materialDbulkEnabled) {
    byKind.set("bulk_dmi", { enabledCount: 1, objectCount: 1 });
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const interaction = item as Record<string, unknown>;
      const kind = stringValue(interaction.kind);
      if (!kind) continue;
      byKind.set(kind, {
        enabledCount: interaction.enabled === false ? 0 : 1,
        objectCount: 1,
      });
    }
  }

  return interactionOrder.reduce<ModelTreePhysicsInteractionSnapshot[]>(
    (interactions, kind) => {
      const counts = byKind.get(kind);
      if (!counts) return interactions;
      interactions.push({
        enabledCount: counts.enabledCount,
        id: kind,
        label: interactionLabel(kind),
        objectCount: counts.objectCount,
      });
      return interactions;
    },
    [],
  );
}

const interactionOrder = [
  "exchange",
  "demag",
  "interfacial_dmi",
  "bulk_dmi",
  "uniaxial_anisotropy",
] as const;

function materialHasDind(
  material: ModelTreeMaterialSnapshot | undefined,
): boolean {
  return Boolean(
    material?.propertyKeys.some((key) => key.toLowerCase() === "dind"),
  );
}

function materialHasDbulk(
  material: ModelTreeMaterialSnapshot | undefined,
): boolean {
  return Boolean(
    material?.propertyKeys.some((key) => key.toLowerCase() === "dbulk"),
  );
}

function sceneUniverseSnapshot(value: unknown): ModelTreeSnapshot["universe"] {
  const universe = value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};

  return {
    id: stringValue(universe.id) ?? "universe",
    label: stringValue(universe.name) ?? "Universe",
    size: vector3(universe.size),
  };
}

function sceneStudySnapshot(value: unknown): ModelTreeSnapshot["study"] {
  const study = value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};

  return {
    demagRealization: stringValue(study.demag_realization),
    externalField: vector3(study.external_field),
    requestedBackend: stringValue(study.requested_backend),
    requestedDevice: stringValue(study.requested_device),
    requestedMode: stringValue(study.requested_mode),
    requestedPrecision: stringValue(study.requested_precision),
    stages: Array.isArray(study.stages)
      ? study.stages.map(sceneStudyStageSnapshot)
      : [],
  };
}

function sceneStudyStageSnapshot(
  value: unknown,
  index: number,
): NonNullable<ModelTreeSnapshot["study"]>["stages"][number] {
  const stage = value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
  const kind = stringValue(stage.kind) ?? "run";

  return {
    artifactName: stringValue(stage.artifact_name),
    boundaryCondition:
      boundaryConditionKind(stage.bc) ??
      boundaryConditionKind(stage.spin_wave_bc) ??
      boundaryConditionKind(stage.eigen_spin_wave_bc) ??
      boundaryConditionKind(stage.frequency_spin_wave_bc),
    calculationMode:
      stringValue(stage.calculation_mode) ??
      stringValue(stage.eigen_calculation_mode) ??
      stringValue(stage.frequency_calculation_mode),
    device: stringValue(stage.device),
    energyTolerance: scalarText(stage.energy_tolerance),
    hysteresisBranchMode: stringValue(stage.branch_mode) ?? stringValue(stage.branchMode),
    hysteresisFieldMaxMt: scalarText(stage.field_max_mT),
    hysteresisFieldMinMt: scalarText(stage.field_min_mT),
    hysteresisFieldStepMt: scalarText(stage.field_step_mT),
    hysteresisInitialProtocol:
      stringValue(stage.initial_protocol) ?? stringValue(stage.initialProtocol),
    hysteresisSaturationMode:
      hysteresisSaturationMode(stage.saturation) ??
      hysteresisSaturationMode(stage.saturationPolicy),
    hysteresisSettleSteps: hysteresisSettleSteps(stage.settle_pipeline),
    index,
    kind,
    kSamplingKind:
      kSamplingKind(stage.k_sampling) ??
      kSamplingKind(stage.eigen_k_sampling) ??
      kSamplingKind(stage.frequency_k_sampling) ??
      kPathSamplingKind(stage.k_path) ??
      kPathSamplingKind(stage.eigen_k_path),
    maxSteps: scalarText(stage.max_steps),
    stageId: stringValue(stage.stage_id) ?? stringValue(stage.id),
    torqueTolerance: stageTorqueToleranceApm(stage),
    untilSeconds: scalarText(stage.until_seconds),
  };
}

function boundaryConditionKind(value: unknown): string | null {
  const record = recordValue(value);
  return stringValue(record?.kind) ?? stringValue(value);
}

function kSamplingKind(value: unknown): string | null {
  const record = recordValue(value);
  if (!record) return null;
  const kind = stringValue(record.kind);
  if (kind) return kind;
  if (record.path != null) return "path";
  if (record.grid != null) return "grid";
  if (record.points != null || record.vectors != null) return "explicit";
  return null;
}

function kPathSamplingKind(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return "path";
  const record = recordValue(value);
  if (!record) return null;
  return record.path != null ? "path" : null;
}

function hysteresisSaturationMode(value: unknown): string | null {
  const saturation = recordValue(value);
  if (!saturation) return null;
  return stringValue(saturation.mode) ?? "configured";
}

function hysteresisSettleSteps(
  value: unknown,
): ModelTreeHysteresisSettleStepSnapshot[] {
  const pipeline = recordValue(value);
  if (!pipeline) return [];

  const rawSteps =
    Array.isArray(pipeline.steps)
      ? pipeline.steps
      : pipeline.default
        ? [
            pipeline.default,
            ...(Array.isArray(pipeline.branches)
              ? pipeline.branches.flatMap((branch) => {
                  const step = recordValue(branch)?.run;
                  return step == null ? [] : [step];
                })
              : []),
          ]
        : [];

  const steps: ModelTreeHysteresisSettleStepSnapshot[] = [];
  rawSteps.forEach((step, index) => {
    const record = recordValue(step);
    if (record) {
      steps.push({
        alpha: scalarText(record.alpha),
        energyTolerance: scalarText(record.energy_tolerance),
        index,
        kind: stringValue(record.kind) ?? "algorithm",
        maxSteps: scalarText(record.max_steps),
        method: stringValue(record.method),
        nonConvergencePolicy: stringValue(record.on_non_convergence),
        torqueTolerance: scalarText(record.torque_tolerance),
      });
    }
  });
  return steps;
}

function stageTorqueToleranceApm(
  stage: Record<string, unknown>,
): string | number | null {
  const explicitApm = scalarText(stage.torque_tolerance_apm);
  if (explicitApm != null) return explicitApm;
  const legacyApm = scalarText(stage.torque_tolerance);
  if (legacyApm != null) return legacyApm;
  const explicitT = finiteNumberFromScalar(stage.torque_tolerance_T);
  return explicitT === null ? null : apmFromTesla(explicitT);
}

function geometryKind(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const geometry = value as Record<string, unknown>;
  return (
    stringValue(geometry.geometry_kind) ??
    stringValue(geometry.kind) ??
    null
  );
}

function shapeKind(value: unknown): string | null {
  const shape = recordValue(value);
  return stringValue(shape?.kind) ?? stringValue(shape?.geometry_kind);
}

function meshStatusFromTags(value: unknown): ExplorerNodeStatus {
  const tags: string[] = [];
  if (Array.isArray(value)) {
    for (const tag of value) {
      if (typeof tag === "string") {
        tags.push(tag);
      }
    }
  }
  if (tags.includes("mesh:building")) return "mesh-building";
  if (tags.includes("mesh:failed")) return "mesh-failed";
  if (tags.includes("mesh:validation-blocked")) return "validation-blocked";
  if (tags.includes("mesh:dirty")) return "mesh-stale";
  if (tags.includes("mesh:ready")) return "mesh-ready";
  return "primitive-only";
}

function interactionLabel(kind: string): string {
  if (kind === "demag") return "Demagnetization";
  if (kind === "dmi") return "DMI";
  if (kind === "exchange") return "Exchange";
  if (kind === "interfacial_dmi") return "Interfacial DMI";
  if (kind === "uniaxial_anisotropy") return "Uniaxial anisotropy";

  const parts: string[] = [];
  for (const part of kind.split("_")) {
    if (part) {
      parts.push(part[0]?.toUpperCase() + part.slice(1));
    }
  }
  return parts.join(" ");
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function scalarText(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function materialFieldLabel(parameter: string, unit: string | null | undefined): string {
  return unit ? `${parameter} (${unit})` : parameter;
}

function couplingLabel(kind: string, source: string, target: string): string {
  return `${source} -> ${target} ${interactionLabel(kind)}`;
}

function endpointLabel(value: unknown): string {
  const endpoint = recordValue(value);
  if (!endpoint) return "endpoint";
  const object = stringValue(endpoint.object) ?? stringValue(endpoint.object_id);
  const region = stringValue(endpoint.region_id) ?? stringValue(endpoint.region);
  const selector = stringValue(endpoint.selector) ?? stringValue(endpoint.surface);
  if (object && region) return `${object}/${region}`;
  if (object && selector) return `${object}/${selector}`;
  if (object) return object;
  return stringValue(endpoint.label) ?? stringValue(endpoint.kind) ?? "endpoint";
}

function finiteNumberFromScalar(value: unknown): number | null {
  let parsed = NaN;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string") {
    parsed = Number(value);
  }
  return Number.isFinite(parsed) ? parsed : null;
}

function vector3(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const [x, y, z] = value;
  if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") {
    return null;
  }
  return [x, y, z];
}
