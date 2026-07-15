import { describe, expect, it } from "vitest";

import {
  buildSemanticRenderTargetCatalog,
  resolveSemanticTargetForMeshPart,
  semanticRenderTargetCarriersFromManifest,
} from "./semanticRenderTargetCatalog";
import { isVisualizationAirboxIdentity } from "./selectionTypes";

describe("semantic render target catalog", () => {
  it("never addresses the Universe outer boundary as a render target", () => {
    const catalog = buildSemanticRenderTargetCatalog({
      parts: [
        {
          id: "part:outer-boundary",
          label: "Outer Boundary",
          role: "outer_boundary",
        },
      ],
      sceneObjectIds: new Set(),
    });

    expect(catalog.byCarrierId.has("part:outer-boundary")).toBe(false);
    expect(catalog.entries.some((entry) => entry.targetKind === "part")).toBe(false);
  });

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

  it("maps the legacy __airbox__ object and carrier aliases only to Airbox", () => {
    const part = { id: "__airbox__", label: "Legacy airbox", role: "magnetic" };
    const catalog = buildSemanticRenderTargetCatalog({
      parts: [part],
      sceneObjectIds: new Set(["film", "__airbox__"]),
    });

    expect(resolveSemanticTargetForMeshPart(catalog, part)).toMatchObject({
      targetId: "airbox",
      targetKind: "airbox",
    });
    expect(catalog.entries.some((entry) => entry.targetId === "object:__airbox__")).toBe(false);
    expect(catalog.entries.some((entry) => entry.targetKind === "part")).toBe(false);
  });

  it("maps the canonical part:__air__ carrier id to Airbox even when its role is degraded", () => {
    const part = { id: "part:__air__", label: "Exterior air", role: "carrier" };
    const catalog = buildSemanticRenderTargetCatalog({
      parts: [part],
      sceneObjectIds: new Set(["film"]),
    });

    expect(resolveSemanticTargetForMeshPart(catalog, part)).toMatchObject({
      carrierIds: ["part:__air__"],
      targetId: "airbox",
      targetKind: "airbox",
    });
    expect(catalog.entries.some((entry) => entry.targetKind === "part")).toBe(false);
  });

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
      targetId: "part:part:orphan",
      targetKind: "part",
    });
    expect(catalog.entries.some((entry) => entry.targetId === "object:deleted-object")).toBe(false);
  });

  it("names every orphan fallback as a canonical part target even when the carrier id is raw", () => {
    const part = {
      id: "recovered-volume",
      label: "Recovered volume",
      role: "magnetic",
    };
    const catalog = buildSemanticRenderTargetCatalog({
      parts: [part],
      sceneObjectIds: new Set(),
    });

    expect(resolveSemanticTargetForMeshPart(catalog, part)).toMatchObject({
      explorerNodeId: "model:mesh:unassigned:recovered-volume",
      targetId: "part:recovered-volume",
      targetKind: "part",
    });
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
  it("recognizes reserved Airbox ownership fields without capturing a plain air name", () => {
    expect(isVisualizationAirboxIdentity({ object_id: "__air__" })).toBe(true);
    expect(isVisualizationAirboxIdentity({ geometry_id: "__air___geom" })).toBe(true);
    expect(isVisualizationAirboxIdentity({ id: "air" })).toBe(false);
    expect(isVisualizationAirboxIdentity({ id: "air", role: "air" })).toBe(true);
  });

  it("keeps the realized outer boundary out of orphan render targets", () => {
    const carriers = semanticRenderTargetCarriersFromManifest({
      mesh_parts: [
        {
          boundary_face_count: 128,
          boundary_face_start: 0,
          element_count: 0,
          element_start: 0,
          id: "part:outer-boundary",
          label: "Outer Boundary",
          node_count: 0,
          node_start: 0,
          role: "outer_boundary",
        },
      ],
      object_segments: [],
    });

    expect(carriers).toEqual([]);
    const catalog = buildSemanticRenderTargetCatalog({
      parts: carriers,
      sceneObjectIds: new Set(),
    });
    expect(catalog.byCarrierId.has("part:outer-boundary")).toBe(false);
    expect(catalog.entries.some((entry) => entry.targetKind === "part")).toBe(false);
  });

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

    const catalog = buildSemanticRenderTargetCatalog({
      parts: carriers,
      sceneObjectIds: new Set(),
    });
    expect(resolveSemanticTargetForMeshPart(catalog, carriers[0]!)).toMatchObject({
      explorerNodeId: "model:mesh:unassigned:segment%3Adeleted-object%3A0",
      targetId: "part:segment:deleted-object:0",
    });
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

  it("collapses the production Airbox mesh part and object segment into one semantic carrier", () => {
    const carriers = semanticRenderTargetCarriersFromManifest({
      mesh_parts: [
        {
          boundary_face_count: 60,
          boundary_face_start: 0,
          element_count: 175,
          element_start: 0,
          geometry_id: null,
          id: "part:__air__",
          label: "Airbox",
          node_count: 32,
          node_start: 0,
          object_id: null,
          role: "air",
        },
      ],
      object_segments: [
        {
          boundary_face_count: 60,
          boundary_face_start: 0,
          element_count: 175,
          element_start: 0,
          geometry_id: null,
          node_count: 32,
          node_start: 0,
          object_id: "__air__",
        },
      ],
    });
    const catalog = buildSemanticRenderTargetCatalog({
      parts: carriers,
      sceneObjectIds: new Set(["__air__"]),
    });

    expect(carriers.map((carrier) => carrier.id)).toEqual(["part:__air__"]);
    expect(catalog.byTargetId.get("airbox")?.carrierIds).toEqual([
      "part:__air__",
    ]);
    expect(catalog.entries.filter((entry) => entry.targetKind === "part")).toEqual([]);
  });

  it("keeps a segment-only Airbox out of unassigned semantic targets", () => {
    const carriers = semanticRenderTargetCarriersFromManifest({
      mesh_parts: [],
      object_segments: [
        {
          boundary_face_count: 60,
          boundary_face_start: 0,
          element_count: 175,
          element_start: 0,
          geometry_id: null,
          node_count: 32,
          node_start: 0,
          object_id: "__air__",
        },
      ],
    });
    const catalog = buildSemanticRenderTargetCatalog({
      parts: carriers,
      sceneObjectIds: new Set(),
    });

    expect(carriers).toMatchObject([
      {
        carrierKind: "object-segment",
        fieldCapable: false,
        label: "Airbox",
        role: "air",
      },
    ]);
    expect(catalog.byTargetId.get("airbox")?.carrierIds).toHaveLength(1);
    expect(catalog.entries.filter((entry) => entry.targetKind === "part")).toEqual([]);
  });

  it("rejects blank and duplicate mesh carrier ids before Explorer addressing", () => {
    const meshPart = {
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
    };
    const carriers = semanticRenderTargetCarriersFromManifest({
      mesh_parts: [
        { ...meshPart, id: "   " },
        meshPart,
        { ...meshPart, label: "Duplicate film" },
      ],
      object_segments: [],
    });

    expect(carriers.map((carrier) => carrier.id)).toEqual(["part:film"]);
  });
});
