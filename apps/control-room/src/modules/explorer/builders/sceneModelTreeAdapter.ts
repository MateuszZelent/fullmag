import type { StageExecutionResource } from "@/kernel/api/apiTypes";
import { apmFromTesla } from "@/shared/domain/physics/torqueUnits";

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
      ? scene.objects.reduce<ModelTreeObjectSnapshot[]>((objects, object) => {
          const snapshot = sceneObjectSnapshot(
            object,
            materialById,
            magnetizationById,
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
    torqueTolerance: stageTorqueToleranceApm(stage),
    untilSeconds: scalarText(stage.until_seconds),
  };
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

function scalarText(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
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
