/**
 * Layer C: Authoring Commands
 *
 * Each command is a pure function that takes a SceneDraft and returns a new SceneDraft.
 * No React. No side-effects. No fetching. Fully testable.
 *
 * The authoring store dispatches these commands and manages the draft lifecycle.
 */

import { buildDefaultMagnetizationAsset } from "@/lib/session/magnetizationCanonical";
import type { SceneDocument, SceneObject, Transform3D, ScriptBuilderMaterialEntry, ScriptBuilderPerGeometryMeshEntry } from "@/lib/session/types";

// ─── Add Node ───────────────────────────────────────────────────

export interface AddNodeParams {
  name: string;
  geometryKind: string;
  geometryParams: Record<string, unknown>;
  materialProperties?: ScriptBuilderMaterialEntry;
  translation?: [number, number, number];
}

export function addNode(draft: SceneDocument, params: AddNodeParams): SceneDocument {
  const objectId = params.name;
  const materialId = `mat:${params.name}`;
  const magnetizationId = `mag:${params.name}`;

  const newObject: SceneObject = {
    id: objectId,
    name: params.name,
    geometry: {
      geometry_kind: params.geometryKind,
      geometry_params: params.geometryParams,
      bounds_min: null,
      bounds_max: null,
    },
    transform: {
      translation: params.translation ?? [0, 0, 0],
      rotation_quat: [0, 0, 0, 1],
      scale: [1, 1, 1],
      pivot: [0, 0, 0],
    },
    material_ref: materialId,
    region_name: null,
    magnetization_ref: magnetizationId,
    physics_stack: [],
    object_mesh: null,
    mesh_override: null,
    visible: true,
    locked: false,
    tags: [],
  };

  return {
    ...draft,
    objects: [...draft.objects, newObject],
    materials: [
      ...draft.materials,
      {
        id: materialId,
        name: `${params.name} material`,
        properties: params.materialProperties ?? { Ms: null, Aex: null, alpha: 0.01, Dind: null },
      },
    ],
    magnetization_assets: [
      ...draft.magnetization_assets,
      buildDefaultMagnetizationAsset(params.name, [1, 0, 0]),
    ],
  };
}

// ─── Delete Node ────────────────────────────────────────────────

export function deleteNode(draft: SceneDocument, nodeId: string): SceneDocument {
  const object = draft.objects.find((o) => o.id === nodeId || o.name === nodeId);
  if (!object) return draft;

  return {
    ...draft,
    objects: draft.objects.filter((o) => o.id !== object.id),
    materials: draft.materials.filter((m) => m.id !== object.material_ref),
    magnetization_assets: draft.magnetization_assets.filter(
      (a) => a.id !== object.magnetization_ref,
    ),
  };
}

// ─── Rename Node ────────────────────────────────────────────────

export function renameNode(draft: SceneDocument, nodeId: string, newName: string): SceneDocument {
  return {
    ...draft,
    objects: draft.objects.map((o) =>
      o.id === nodeId || o.name === nodeId ? { ...o, name: newName } : o,
    ),
  };
}

// ─── Set Material Parameter ─────────────────────────────────────

export function setMaterialParameter(
  draft: SceneDocument,
  materialId: string,
  key: string,
  value: unknown,
): SceneDocument {
  return {
    ...draft,
    materials: draft.materials.map((m) =>
      m.id === materialId
        ? { ...m, properties: { ...m.properties, [key]: value } }
        : m,
    ),
  };
}

// ─── Assign Magnetization Preset ────────────────────────────────

export function assignMagnetizationPreset(
  draft: SceneDocument,
  assetId: string,
  presetKind: string,
  presetParams: Record<string, unknown>,
  value: [number, number, number] | null,
): SceneDocument {
  return {
    ...draft,
    magnetization_assets: draft.magnetization_assets.map((a) =>
      a.id === assetId
        ? {
            ...a,
            kind: "preset",
            preset_kind: presetKind,
            preset_params: presetParams,
            value: value ?? a.value,
          }
        : a,
    ),
  };
}

// ─── Update Texture Transform ───────────────────────────────────

export function updateTextureTransform(
  draft: SceneDocument,
  assetId: string,
  transform: Partial<Transform3D>,
): SceneDocument {
  return {
    ...draft,
    magnetization_assets: draft.magnetization_assets.map((a) =>
      a.id === assetId
        ? {
            ...a,
            texture_transform: {
              ...a.texture_transform,
              ...transform,
            },
          }
        : a,
    ),
  };
}

// ─── Set Mesh Settings ──────────────────────────────────────────

export function setMeshOverride(
  draft: SceneDocument,
  objectId: string,
  meshOverride: ScriptBuilderPerGeometryMeshEntry | null,
): SceneDocument {
  return {
    ...draft,
    objects: draft.objects.map((o) =>
      o.id === objectId || o.name === objectId
        ? { ...o, mesh_override: meshOverride }
        : o,
    ),
  };
}

// ─── Translate Object ──────────────────────────────────────────

export function translateObject(
  draft: SceneDocument,
  objectId: string,
  dx: number,
  dy: number,
  dz: number,
): SceneDocument {
  return {
    ...draft,
    objects: draft.objects.map((o) => {
      if (o.id !== objectId && o.name !== objectId) return o;
      const [cx, cy, cz] = o.transform.translation;
      return {
        ...o,
        transform: {
          ...o.transform,
          translation: [cx + dx, cy + dy, cz + dz] as [number, number, number],
        },
      };
    }),
  };
}

// ─── Duplicate Node ────────────────────────────────────────────

export function duplicateNode(draft: SceneDocument, nodeId: string): SceneDocument {
  const source = draft.objects.find((o) => o.id === nodeId || o.name === nodeId);
  if (!source) return draft;

  const existingNames = new Set(draft.objects.map((o) => o.name));
  let copyName = `${source.name}_copy`;
  let counter = 1;
  while (existingNames.has(copyName)) {
    copyName = `${source.name}_copy${counter}`;
    counter++;
  }

  const newMaterialId = `mat:${copyName}`;
  const newMagId = `mag:${copyName}`;

  const sourceMaterial = draft.materials.find((m) => m.id === source.material_ref);
  const sourceMag = draft.magnetization_assets.find((a) => a.id === source.magnetization_ref);

  return {
    ...draft,
    objects: [
      ...draft.objects,
      {
        ...source,
        id: copyName,
        name: copyName,
        material_ref: newMaterialId,
        magnetization_ref: newMagId,
      },
    ],
    materials: [
      ...draft.materials,
      ...(sourceMaterial
        ? [{ ...sourceMaterial, id: newMaterialId, name: `${copyName} material` }]
        : []),
    ],
    magnetization_assets: [
      ...draft.magnetization_assets,
      ...(sourceMag
        ? [{ ...sourceMag, id: newMagId, name: `${copyName} magnetization` }]
        : []),
    ],
  };
}
