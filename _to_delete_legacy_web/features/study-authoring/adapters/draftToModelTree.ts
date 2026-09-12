/**
 * Layer C: Adapters – Draft → Model Tree
 *
 * Transforms the local authoring draft into the tree structure
 * used by the sidebar model tree UI.
 */

import type { SceneDocument, SceneObject, MagnetizationAsset } from "@/lib/session/types";

export interface ModelTreeNode {
  id: string;
  label: string;
  type: "object" | "material" | "magnetization" | "module" | "stage" | "universe";
  parentId: string | null;
  children: string[];
  objectId: string | null;
  icon: string;
  isLeaf: boolean;
}

export function draftToModelTree(draft: SceneDocument | null): ModelTreeNode[] {
  if (!draft) return [];

  const nodes: ModelTreeNode[] = [];

  // Universe root
  nodes.push({
    id: "universe",
    label: "Universe",
    type: "universe",
    parentId: null,
    children: draft.objects.map((o) => o.id),
    objectId: null,
    icon: "box",
    isLeaf: false,
  });

  // Object nodes
  for (const object of draft.objects) {
    nodes.push({
      id: object.id,
      label: object.name,
      type: "object",
      parentId: "universe",
      children: [`${object.id}:material`, `${object.id}:magnetization`],
      objectId: object.id,
      icon: "cube",
      isLeaf: false,
    });

    // Material sub-node
    const material = draft.materials.find((m) => m.id === object.material_ref);
    nodes.push({
      id: `${object.id}:material`,
      label: material?.name ?? "Material",
      type: "material",
      parentId: object.id,
      children: [],
      objectId: object.id,
      icon: "atom",
      isLeaf: true,
    });

    // Magnetization sub-node
    const mag = draft.magnetization_assets.find((m) => m.id === object.magnetization_ref);
    nodes.push({
      id: `${object.id}:magnetization`,
      label: mag?.name ?? "Magnetization",
      type: "magnetization",
      parentId: object.id,
      children: [],
      objectId: object.id,
      icon: "compass",
      isLeaf: true,
    });
  }

  return nodes;
}
