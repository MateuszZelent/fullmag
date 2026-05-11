import type {
  ExplorerNodeStatus,
  ModelTreeObjectSnapshot,
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
    objects: Array.isArray(scene?.objects)
      ? scene.objects
          .map(sceneObjectSnapshot)
          .filter((object): object is ModelTreeObjectSnapshot => Boolean(object))
      : [],
    universe: sceneUniverseSnapshot(scene?.universe),
  };
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
