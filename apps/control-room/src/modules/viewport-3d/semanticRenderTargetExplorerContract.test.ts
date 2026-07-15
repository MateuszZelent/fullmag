import { describe, expect, it } from "vitest";

import {
  buildSemanticRenderTargetCatalog,
  resolveSemanticTargetForMeshPart,
  semanticRenderTargetCarriersFromManifest,
} from "@/kernel/selection/semanticRenderTargetCatalog";
import {
  buildModelTree,
  flattenExplorerNodes,
} from "@/modules/explorer/builders/buildModelTree";

import { viewportSelectionForMeshPart } from "./viewport3dSelection";

describe("semantic render target to Explorer contract", () => {
  it("publishes the production Airbox pair under only the canonical Explorer branch", () => {
    const parts = semanticRenderTargetCarriersFromManifest({
      mesh_parts: [
        {
          boundary_face_count: 60,
          boundary_face_start: 0,
          element_count: 175,
          element_start: 0,
          id: "part:__air__",
          label: "Airbox",
          node_count: 32,
          node_start: 0,
          role: "air",
        },
      ],
      object_segments: [
        {
          boundary_face_count: 60,
          boundary_face_start: 0,
          element_count: 175,
          element_start: 0,
          node_count: 32,
          node_start: 0,
          object_id: "__air__",
        },
      ],
    });
    const catalog = buildSemanticRenderTargetCatalog({
      parts,
      sceneObjectIds: new Set(["__air__"]),
    });
    const fallbackParts = catalog.entries
      .filter((entry) => entry.targetKind === "part")
      .flatMap((entry) =>
        entry.carrierIds.map((id) => ({
          id,
          label: entry.label,
          visualizationTargetId: entry.targetId,
        })),
      );
    const tree = buildModelTree({
      mesh: { partCount: parts.length, visualizationPartFallbacks: fallbackParts },
      objects: [{ id: "__air__", label: "Synthetic air" }],
    });
    const nodeIds = flattenExplorerNodes(tree).map((node) => node.id);

    expect(parts.map((part) => part.id)).toEqual(["part:__air__"]);
    expect(nodeIds.filter((nodeId) => nodeId === "model:airbox")).toHaveLength(1);
    expect(nodeIds.some((nodeId) => nodeId.includes("__air__"))).toBe(false);
    expect(nodeIds.some((nodeId) => nodeId.includes("unassigned"))).toBe(false);
  });

  it("gives every pickable FEM carrier exactly one visible Explorer address", () => {
    const parts = [
      { id: "part:__air__", label: "Airbox carrier", role: "carrier" },
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
      .flatMap((entry) =>
        entry.carrierIds.slice(0, 1).map((carrierId) => ({
          id: carrierId,
          label: entry.label,
          visualizationTargetId: entry.targetId,
        })),
      );
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
