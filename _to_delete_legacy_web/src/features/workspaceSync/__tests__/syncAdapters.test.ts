import { describe, expect, it } from "vitest";

import {
  selectionFromControlRoomState,
  selectionIdentityFromInteractionTarget,
} from "../syncAdapters";

describe("workspace sync adapters", () => {
  it("maps Control Room mesh entity selection to cross-surface selection", () => {
    expect(
      selectionFromControlRoomState({
        selectedObjectId: "obj-a",
        selectedEntityId: "part-a",
        selectedSidebarNodeId: "mesh-obj-a",
        sourceSurface: "mesh",
      }),
    ).toEqual({
      primary: { kind: "mesh_part", id: "part-a" },
      multi: [{ kind: "scene_object", id: "obj-a" }],
      sourceSurface: "mesh",
      mappedSceneObjectId: "obj-a",
    });
  });

  it("maps object-only legacy selection to a scene object identity", () => {
    expect(
      selectionFromControlRoomState({
        selectedObjectId: "obj-b",
        selectedEntityId: null,
        selectedSidebarNodeId: "obj-obj-b",
      }).primary,
    ).toEqual({ kind: "scene_object", id: "obj-b" });
  });

  it("maps interaction mesh targets without leaking FEM/FDM-specific branches", () => {
    expect(
      selectionIdentityFromInteractionTarget({
        kind: "mesh_domain",
        scope: "object",
        objectId: "obj-c",
      }),
    ).toEqual({ kind: "scene_object", id: "obj-c" });
    expect(
      selectionIdentityFromInteractionTarget({
        kind: "builder_primitive",
        primitiveId: "prim-1",
      }),
    ).toEqual({ kind: "primitive", id: "prim-1" });
  });
});
