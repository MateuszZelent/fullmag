import type {
  ExplorerNodeStatus,
  ModelTreeMaterialSnapshot,
  ModelTreeObjectSnapshot,
  ModelTreePhysicsInteractionSnapshot,
  ModelTreeSnapshot,
} from "../explorerTypes";

interface SceneLike {
  [key: string]: unknown;
  objects?: unknown;
  universe?: unknown;
}

export function modelTreeSnapshotFromScene(
  scene: SceneLike | null | undefined,
): ModelTreeSnapshot {
  return {
    materials: sceneMaterials(scene?.materials),
    objects: Array.isArray(scene?.objects)
      ? scene.objects
          .map(sceneObjectSnapshot)
          .filter((object): object is ModelTreeObjectSnapshot => Boolean(object))
      : [],
    physicsInteractions: scenePhysicsInteractions(scene?.objects),
    universe: sceneUniverseSnapshot(scene?.universe),
  };
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

function materialPropertyKeys(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>).sort();
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

function sceneObjectSnapshot(value: unknown): ModelTreeObjectSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const object = value as Record<string, unknown>;
  const id = stringValue(object.id);
  if (!id) return null;

  return {
    geometryKind: geometryKind(object.geometry),
    id,
    label: stringValue(object.name) ?? id,
    magnetization: stringValue(object.magnetization_ref),
    material: stringValue(object.material_ref),
    meshStatus: meshStatusFromTags(object.tags),
  };
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

function vector3(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const [x, y, z] = value;
  if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") {
    return null;
  }
  return [x, y, z];
}
