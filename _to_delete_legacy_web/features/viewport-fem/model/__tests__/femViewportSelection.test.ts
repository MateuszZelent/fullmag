/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import { describe, expect, it } from "vitest";

import {
  resolveViewportSelectionScope,
  scopeTargetPartIds,
  scopeLabel,
} from "../femViewportSelection";
import type { FemMeshPart } from "@/lib/session/types";

function makePart(partial: Partial<FemMeshPart>): FemMeshPart {
  return {
    id: "part-1",
    label: "Part",
    role: "magnetic_object",
    object_id: "obj-1",
    geometry_id: "geo-1",
    material_id: "mat-1",
    element_start: 0,
    element_count: 1,
    boundary_face_start: 0,
    boundary_face_count: 1,
    boundary_face_indices: [0],
    node_start: 0,
    node_count: 3,
    node_indices: [0, 1, 2],
    surface_faces: [[0, 1, 2]],
    bounds_min: [0, 0, 0],
    bounds_max: [1, 1, 1],
    ...partial,
  };
}

describe("resolveViewportSelectionScope", () => {
  const airPart = makePart({ id: "air-1", role: "air", object_id: "air" });
  const shell = makePart({ id: "shell-1", label: "nanoflower_shell", object_id: "obj-nf" });
  const core = makePart({ id: "core-1", label: "nanoflower_core", object_id: "obj-nf" });
  const otherObj = makePart({ id: "other-1", label: "disk", object_id: "obj-disk" });
  const allParts = [airPart, shell, core, otherObj];

  it("returns universe when nothing is selected", () => {
    const scope = resolveViewportSelectionScope({
      selectedSidebarNodeId: null,
      selectedObjectId: null,
      selectedEntityId: null,
      meshParts: allParts,
    });
    expect(scope).toEqual({ kind: "universe" });
  });

  it("returns airbox scope for universe-airbox node", () => {
    const scope = resolveViewportSelectionScope({
      selectedSidebarNodeId: "universe-airbox",
      selectedObjectId: null,
      selectedEntityId: null,
      meshParts: allParts,
    });
    expect(scope).toEqual({ kind: "airbox", partId: "air-1" });
  });

  it("returns airbox scope for universe-airbox-mesh node", () => {
    const scope = resolveViewportSelectionScope({
      selectedSidebarNodeId: "universe-airbox-mesh",
      selectedObjectId: null,
      selectedEntityId: null,
      meshParts: allParts,
    });
    expect(scope).toEqual({ kind: "airbox", partId: "air-1" });
  });

  it("returns object scope with all part IDs for composite object", () => {
    const scope = resolveViewportSelectionScope({
      selectedSidebarNodeId: "obj-nf",
      selectedObjectId: "obj-nf",
      selectedEntityId: null,
      meshParts: allParts,
    });
    expect(scope).toEqual({
      kind: "object",
      objectId: "obj-nf",
      partIds: ["shell-1", "core-1"],
    });
  });

  it("returns part scope for explicit entity selection", () => {
    const scope = resolveViewportSelectionScope({
      selectedSidebarNodeId: null,
      selectedObjectId: null,
      selectedEntityId: "other-1",
      meshParts: allParts,
    });
    expect(scope).toEqual({ kind: "part", partId: "other-1" });
  });

  it("object selection takes priority over entity selection", () => {
    const scope = resolveViewportSelectionScope({
      selectedSidebarNodeId: null,
      selectedObjectId: "obj-nf",
      selectedEntityId: "other-1",
      meshParts: allParts,
    });
    expect(scope.kind).toBe("object");
  });

  it("airbox sidebar node takes priority over object selection", () => {
    const scope = resolveViewportSelectionScope({
      selectedSidebarNodeId: "universe-airbox",
      selectedObjectId: "obj-nf",
      selectedEntityId: null,
      meshParts: allParts,
    });
    expect(scope.kind).toBe("airbox");
  });
});

describe("scopeTargetPartIds", () => {
  it("returns all visible for universe scope", () => {
    const result = scopeTargetPartIds({ kind: "universe" }, ["a", "b", "c"]);
    expect(result).toEqual(["a", "b", "c"]);
  });

  it("returns object part IDs for object scope", () => {
    const result = scopeTargetPartIds(
      { kind: "object", objectId: "obj-1", partIds: ["p1", "p2"] },
      ["p1", "p2", "p3"],
    );
    expect(result).toEqual(["p1", "p2"]);
  });

  it("returns single part for airbox scope", () => {
    const result = scopeTargetPartIds({ kind: "airbox", partId: "air-1" }, ["air-1", "p1"]);
    expect(result).toEqual(["air-1"]);
  });

  it("returns single part for part scope", () => {
    const result = scopeTargetPartIds({ kind: "part", partId: "p2" }, ["p1", "p2", "p3"]);
    expect(result).toEqual(["p2"]);
  });
});

describe("scopeLabel", () => {
  const shell = makePart({ id: "shell-1", label: "nanoflower_shell", object_id: "obj-nf" });
  const core = makePart({ id: "core-1", label: "nanoflower_core", object_id: "obj-nf" });
  const airPart = makePart({ id: "air-1", role: "air", label: "Airbox" });

  it("returns 'All visible' for universe", () => {
    expect(scopeLabel({ kind: "universe" }, [])).toBe("All visible");
  });

  it("returns 'Airbox' for airbox scope", () => {
    expect(scopeLabel({ kind: "airbox", partId: "air-1" }, [airPart])).toBe("Airbox");
  });

  it("returns part label for part scope", () => {
    expect(scopeLabel({ kind: "part", partId: "shell-1" }, [shell])).toBe(
      "Selected: nanoflower_shell",
    );
  });

  it("returns object label with part count for object scope", () => {
    const label = scopeLabel(
      { kind: "object", objectId: "obj-nf", partIds: ["shell-1", "core-1"] },
      [shell, core],
    );
    expect(label).toContain("nanoflower");
    expect(label).toContain("2 parts");
  });
});
