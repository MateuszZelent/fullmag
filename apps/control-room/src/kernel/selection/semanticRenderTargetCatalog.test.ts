import { describe, expect, it } from "vitest";

import {
  buildSemanticRenderTargetCatalog,
  resolveSemanticTargetForMeshPart,
  semanticRenderTargetCarriersFromManifest,
} from "./semanticRenderTargetCatalog";

describe("semantic render target catalog", () => {
  it.each(["air", "airbox"])(
    "maps a %s carrier to the single canonical Airbox address",
    (role) => {
      const part = { id: "part:__air__", label: "Exterior air", role };
      const catalog = buildSemanticRenderTargetCatalog({
        parts: [part],
        sceneObjectIds: new Set(["film", "__air__"]),
      });

      expect(resolveSemanticTargetForMeshPart(catalog, part)).toMatchObject({
        carrierIds: ["part:__air__"],
        explorerNodeId: "model:airbox",
        targetId: "airbox",
        targetKind: "airbox",
      });
      expect(catalog.entries.filter((entry) => entry.targetId === "airbox")).toHaveLength(1);
      expect(catalog.entries.some((entry) => entry.targetId === "object:__air__")).toBe(false);
    },
  );

  it("maps an owned magnetic carrier to its existing authored object", () => {
    const part = {
      id: "part:film",
      label: "Film volume",
      object_id: "film_geom",
      role: "magnetic",
    };
    const catalog = buildSemanticRenderTargetCatalog({
      parts: [part],
      sceneObjectIds: new Set(["film"]),
    });

    expect(resolveSemanticTargetForMeshPart(catalog, part)).toMatchObject({
      carrierIds: ["part:film"],
      explorerNodeId: "model:object:film",
      targetId: "object:film",
      targetKind: "object",
    });
  });

  it("uses geometry ownership only when the canonical scene object exists", () => {
    const part = {
      geometry_id: "ring_geom",
      id: "part:ring",
      label: "Ring",
      object_id: null,
      role: "magnetic_object",
    };
    const catalog = buildSemanticRenderTargetCatalog({
      parts: [part],
      sceneObjectIds: new Set(["ring"]),
    });

    expect(resolveSemanticTargetForMeshPart(catalog, part)?.targetId).toBe("object:ring");
  });

  it("turns a stale owner into an explicit Explorer fallback instead of a ghost object", () => {
    const part = {
      id: "part:orphan",
      label: "Recovered volume",
      object_id: "deleted-object",
      role: "magnetic",
    };
    const catalog = buildSemanticRenderTargetCatalog({
      parts: [part],
      sceneObjectIds: new Set(["film"]),
    });

    expect(resolveSemanticTargetForMeshPart(catalog, part)).toMatchObject({
      explorerNodeId: "model:mesh:unassigned:part%3Aorphan",
      targetId: "part:orphan",
      targetKind: "part",
    });
    expect(catalog.entries.some((entry) => entry.targetId === "object:deleted-object")).toBe(false);
  });

  it("deduplicates repeated carrier ids", () => {
    const part = { id: "part:film", label: "Film", object_id: "film" };
    const catalog = buildSemanticRenderTargetCatalog({
      parts: [part, part],
      sceneObjectIds: new Set(["film"]),
    });

    expect(resolveSemanticTargetForMeshPart(catalog, part)?.carrierIds).toEqual(["part:film"]);
  });
});

describe("semanticRenderTargetCarriersFromManifest", () => {
  it("includes a degraded object segment when no mesh part owns it", () => {
    const carriers = semanticRenderTargetCarriersFromManifest({
      mesh_parts: [],
      object_segments: [
        {
          boundary_face_count: 0,
          boundary_face_start: 0,
          element_count: 1,
          element_start: 0,
          geometry_id: "recovered-geometry",
          node_count: 4,
          node_start: 0,
          object_id: "deleted-object",
        },
      ],
    });

    expect(carriers).toEqual([
      expect.objectContaining({
        id: "segment:deleted-object:0",
        label: "deleted-object",
        object_id: "deleted-object",
        role: "magnetic",
      }),
    ]);
  });

  it("does not duplicate an object segment already owned by a mesh part", () => {
    const carriers = semanticRenderTargetCarriersFromManifest({
      mesh_parts: [
        {
          boundary_face_count: 0,
          boundary_face_start: 0,
          element_count: 1,
          element_start: 0,
          id: "part:film",
          label: "Film",
          node_count: 4,
          node_start: 0,
          object_id: "film",
          role: "magnetic",
        },
      ],
      object_segments: [
        {
          boundary_face_count: 0,
          boundary_face_start: 0,
          element_count: 1,
          element_start: 0,
          geometry_id: "film",
          node_count: 4,
          node_start: 0,
          object_id: "film",
        },
      ],
    });

    expect(carriers.map((carrier) => carrier.id)).toEqual(["part:film"]);
  });
});
