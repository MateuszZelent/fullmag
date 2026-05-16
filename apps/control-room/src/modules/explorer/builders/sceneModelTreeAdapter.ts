import type { StageExecutionResource } from "@/kernel/api/apiTypes";

import type {
  ExplorerNodeStatus,
  ModelTreeMaterialSnapshot,
  ModelTreeObjectSnapshot,
  ModelTreePhysicsInteractionSnapshot,
  ModelTreeSnapshot,
} from "../explorerTypes";

interface SceneLike {
  [key: string]: unknown;
  magnetization_assets?: unknown;
  materials?: unknown;
  objects?: unknown;
  study?: unknown;
  universe?: unknown;
}

export function modelTreeSnapshotFromScene(
  scene: SceneLike | null | undefined,
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
  return {
    materials,
    objects: Array.isArray(scene?.objects)
      ? scene.objects
          .map((object) =>
            sceneObjectSnapshot(object, materialById, magnetizationById),
          )
          .filter((object): object is ModelTreeObjectSnapshot => Boolean(object))
      : [],
    physicsInteractions: scenePhysicsInteractions(scene?.objects),
    study: sceneStudySnapshot(scene?.study),
    universe: sceneUniverseSnapshot(scene?.universe),
  };
}

export function modelTreeSnapshotWithStageExecution(
  snapshot: ModelTreeSnapshot,
  stageExecution: StageExecutionResource | null | undefined,
): ModelTreeSnapshot {
  if (!snapshot.study || !stageExecution?.stages.length) return snapshot;

  return {
    ...snapshot,
    study: {
      ...snapshot.study,
      stages: snapshot.study.stages.map((stage, index) => {
        const runtimeStage = stageExecution.stages[index] ?? null;
        const runtimeStatus =
          runtimeStage?.status ?? stageExecution.stage_statuses[index] ?? null;
        return {
          ...stage,
          stageId: runtimeStage?.stage_id ?? stage.stageId,
          status: explorerStatusFromRuntimeStage(runtimeStatus) ?? stage.status,
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

  return value
    .map((item): ModelTreeMaterialSnapshot | null => {
      if (!item || typeof item !== "object") return null;
      const material = item as Record<string, unknown>;
      const id = stringValue(material.id);
      if (!id) return null;
      return {
        id,
        label: stringValue(material.name) ?? id,
        propertyKeys: materialPropertyKeys(material.properties),
      };
    })
    .filter((material): material is ModelTreeMaterialSnapshot =>
      Boolean(material),
    );
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

  return value
    .map((item): SceneMagnetizationAssetSnapshot | null => {
      if (!item || typeof item !== "object") return null;
      const asset = item as Record<string, unknown>;
      const id = stringValue(asset.id);
      if (!id) return null;
      const kind = stringValue(asset.kind);
      return {
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
      };
    })
    .filter((asset): asset is SceneMagnetizationAssetSnapshot =>
      Boolean(asset),
    );
}

function materialPropertyKeys(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== null && entry !== undefined)
    .map(([key]) => key)
    .sort();
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
    physicsInteractions: sceneObjectPhysicsInteractions(
      object.physics_stack,
      materialHasDind(material),
    ),
    region: stringValue(object.region_name),
    regionId,
    regionMagnetization: regionMagnetizationRef,
    regionMagnetizationKind: regionMagnetization?.kind,
    regionMagnetizationLabel: regionMagnetization?.label,
    textureTransformAvailable:
      magnetization?.textureTransformAvailable ?? false,
  };
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
  materialDmiEnabled: boolean,
): ModelTreePhysicsInteractionSnapshot[] {
  const byKind = new Map<string, { enabledCount: number; objectCount: number }>();
  byKind.set("exchange", { enabledCount: 1, objectCount: 1 });
  byKind.set("demag", { enabledCount: 1, objectCount: 1 });
  if (materialDmiEnabled) {
    byKind.set("interfacial_dmi", { enabledCount: 1, objectCount: 1 });
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

  return interactionOrder
    .filter((kind) => byKind.has(kind))
    .map((kind) => {
      const counts = byKind.get(kind)!;
      return {
        enabledCount: counts.enabledCount,
        id: kind,
        label: interactionLabel(kind),
        objectCount: counts.objectCount,
      };
    });
}

const interactionOrder = [
  "exchange",
  "demag",
  "interfacial_dmi",
  "uniaxial_anisotropy",
] as const;

function materialHasDind(
  material: ModelTreeMaterialSnapshot | undefined,
): boolean {
  return Boolean(
    material?.propertyKeys.some((key) => key.toLowerCase() === "dind"),
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
    energyTolerance: scalarText(stage.energy_tolerance),
    index,
    kind,
    maxSteps: scalarText(stage.max_steps),
    stageId: stringValue(stage.stage_id) ?? stringValue(stage.id),
    torqueTolerance: scalarText(stage.torque_tolerance),
    untilSeconds: scalarText(stage.until_seconds),
  };
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

function meshStatusFromTags(value: unknown): ExplorerNodeStatus {
  const tags = Array.isArray(value) ? value.filter((tag) => typeof tag === "string") : [];
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

  return kind
    .split("_")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function scalarText(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function vector3(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const [x, y, z] = value;
  if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") {
    return null;
  }
  return [x, y, z];
}
