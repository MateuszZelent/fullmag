import { describe, expect, it } from "vitest";

import {
  buildSemanticRenderTargetCatalog,
  resolveSemanticTargetForMeshPart,
} from "@/kernel/selection/semanticRenderTargetCatalog";
import {
  buildModelTree,
  flattenExplorerNodes,
} from "@/modules/explorer/builders/buildModelTree";

import { viewportSelectionForMeshPart } from "./viewport3dSelection";

describe("semantic render target to Explorer contract", () => {
  it("gives every pickable FEM carrier exactly one visible Explorer address", () => {
    const parts = [
      { id: "part:__air__", label: "Airbox", role: "air" },
      {
        id: "part:film",
        label: "Film volume",
        object_id: "film_geom",
        role: "magnetic",
      },
      {
        id: "part:orphan",
        label: "Recovered volume",
        object_id: "deleted-object",
        role: "magnetic",
      },
    ];
    const catalog = buildSemanticRenderTargetCatalog({
      parts,
      sceneObjectIds: new Set(["film", "__air__"]),
    });
    const fallbackParts = catalog.entries
      .filter((entry) => entry.targetKind === "part")
      .map((entry) => ({ id: entry.targetId, label: entry.label }));
    const tree = buildModelTree({
      mesh: { partCount: parts.length, visualizationPartFallbacks: fallbackParts },
      objects: [
        { id: "film", label: "Film" },
        { id: "__air__", label: "Synthetic air" },
      ],
    });
    const nodeIds = flattenExplorerNodes(tree).map((node) => node.id);

    expect(nodeIds).not.toContain("model:object:__air__");
    expect(nodeIds.filter((nodeId) => nodeId === "model:airbox")).toHaveLength(1);

    for (const part of parts) {
      const address = resolveSemanticTargetForMeshPart(catalog, part);
      expect(address).not.toBeNull();
      const selection = viewportSelectionForMeshPart(address!, {
        carrierPartId: part.id,
        label: part.label,
      });
      expect(nodeIds.filter((nodeId) => nodeId === selection.nodeId)).toHaveLength(1);
      expect(
        selection.ref && "visualizationTargetId" in selection.ref
          ? selection.ref.visualizationTargetId
          : null,
      ).toBe(address?.targetId);
    }
  });
});
