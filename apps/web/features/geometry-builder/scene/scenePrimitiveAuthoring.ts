"use client";

import type { GeometryPresetKind } from "@/lib/geometryPresetCatalog";
import { createSceneObjectFromGeometryPreset } from "@/lib/session/sceneObjectFactory";
import type {
  SceneDocument,
  ScriptBuilderUniverseState,
} from "@/lib/session/types";
import type { PrimitiveKind } from "../model/types";

type BoundsOverlay = {
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
};

export interface ScenePrimitiveAuthoringUpdate {
  scene: SceneDocument;
  mergePatch: Record<string, unknown>;
  selectedObjectId: string;
}

export function geometryPresetForPrimitiveKind(kind: PrimitiveKind): GeometryPresetKind {
  switch (kind) {
    case "box":
    case "cylinder":
    case "sphere":
    case "disk":
    case "thin_film":
    case "pillar":
    case "nanowire":
    case "ring":
      return kind;
    case "ellipsoid":
      return "sphere";
    case "tube":
      return "ring";
    default:
      return "box";
  }
}

export function geometryHalfExtentMeters(
  geometryKind: string,
  params: Record<string, unknown>,
): [number, number, number] {
  if (geometryKind === "Box" && Array.isArray(params.size) && params.size.length === 3) {
    const size = params.size.map((value) => Number(value));
    if (size.every((value) => Number.isFinite(value) && value > 0)) {
      return [size[0] / 2, size[1] / 2, size[2] / 2];
    }
  }
  if (geometryKind === "Cylinder") {
    const radius = Number(params.radius);
    const height = Number(params.height);
    if (Number.isFinite(radius) && radius > 0 && Number.isFinite(height) && height > 0) {
      return [radius, radius, height / 2];
    }
  }
  if (geometryKind === "Ellipsoid") {
    const rx = Number(params.rx);
    const ry = Number(params.ry);
    const rz = Number(params.rz);
    if ([rx, ry, rz].every((value) => Number.isFinite(value) && value > 0)) {
      return [rx, ry, rz];
    }
  }
  return [50e-9, 25e-9, 5e-9];
}

export function expandUniverseToIncludeBounds(
  universe: ScriptBuilderUniverseState | null,
  boundsMin: [number, number, number],
  boundsMax: [number, number, number],
): ScriptBuilderUniverseState | null {
  if (!universe?.size || !universe.center) {
    return universe;
  }
  const currentMin = universe.center.map(
    (component, axis) => component - universe.size![axis] / 2,
  ) as [number, number, number];
  const currentMax = universe.center.map(
    (component, axis) => component + universe.size![axis] / 2,
  ) as [number, number, number];
  const padding = universe.padding ?? [0, 0, 0];
  const nextMin = currentMin.map(
    (component, axis) => Math.min(component, boundsMin[axis] - padding[axis]),
  ) as [number, number, number];
  const nextMax = currentMax.map(
    (component, axis) => Math.max(component, boundsMax[axis] + padding[axis]),
  ) as [number, number, number];
  return {
    ...universe,
    center: nextMin.map((component, axis) => 0.5 * (component + nextMax[axis])) as [
      number,
      number,
      number,
    ],
    size: nextMin.map((component, axis) => nextMax[axis] - component) as [
      number,
      number,
      number,
    ],
  };
}

export function createScenePrimitiveAuthoringUpdate(input: {
  scene: SceneDocument;
  kind: PrimitiveKind;
  placementOverlay?: BoundsOverlay | null;
}): ScenePrimitiveAuthoringUpdate {
  const { scene, kind, placementOverlay } = input;
  const created = createSceneObjectFromGeometryPreset(
    geometryPresetForPrimitiveKind(kind),
    scene.objects,
  );
  const halfExtent = geometryHalfExtentMeters(
    created.object.geometry.geometry_kind,
    created.object.geometry.geometry_params,
  );
  const center = placementOverlay
    ? ([
        placementOverlay.boundsMax[0] + Math.max(halfExtent[0] * 0.5, 5e-9) + halfExtent[0],
        0.5 * (placementOverlay.boundsMin[1] + placementOverlay.boundsMax[1]),
        0.5 * (placementOverlay.boundsMin[2] + placementOverlay.boundsMax[2]),
      ] as [number, number, number])
    : created.object.transform.translation;
  const object = {
    ...created.object,
    tags: Array.from(new Set([...(created.object.tags ?? []), "mesh:dirty"])),
    transform: {
      ...created.object.transform,
      translation: center,
    },
  };
  const boundsMin = center.map((component, axis) => component - halfExtent[axis]) as [
    number,
    number,
    number,
  ];
  const boundsMax = center.map((component, axis) => component + halfExtent[axis]) as [
    number,
    number,
    number,
  ];
  const selectedObjectId = object.name || object.id;
  const universe = expandUniverseToIncludeBounds(scene.universe, boundsMin, boundsMax);
  const universeMesh = expandUniverseToIncludeBounds(scene.study.universe_mesh, boundsMin, boundsMax);
  const objects = [...scene.objects, object];
  const materials = [...scene.materials, created.material];
  const magnetizationAssets = [...scene.magnetization_assets, created.magnetization];
  const editor: SceneDocument["editor"] = {
    ...scene.editor,
    active_transform_scope: "object",
    gizmo_mode: "translate",
    selected_object_id: selectedObjectId,
    selected_entity_id: `geo-${selectedObjectId}`,
    focused_entity_id: selectedObjectId,
  };

  return {
    selectedObjectId,
    scene: {
      ...scene,
      revision: scene.revision + 1,
      universe,
      study: {
        ...scene.study,
        universe_mesh: universeMesh,
      },
      objects,
      materials,
      magnetization_assets: magnetizationAssets,
      editor,
    },
    mergePatch: {
      universe,
      study: {
        universe_mesh: universeMesh,
      },
      objects,
      materials,
      magnetization_assets: magnetizationAssets,
      editor: {
        active_transform_scope: "object",
        gizmo_mode: "translate",
        selected_object_id: selectedObjectId,
        selected_entity_id: `geo-${selectedObjectId}`,
        focused_entity_id: selectedObjectId,
      },
    },
  };
}
