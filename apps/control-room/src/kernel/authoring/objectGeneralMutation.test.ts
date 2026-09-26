import { describe, expect, it, vi } from "vitest";

import { EMPTY_SELECTION, type Selection } from "../selection/selectionTypes";
import {
  deleteObjectWithHistory,
  patchObjectIdentityWithHistory,
} from "./objectGeneralMutation";

function scene(revision: number) {
  return {
    objects: [{ object_id: "magnet", name: "magnet" }],
    revision,
    scene_revision: revision,
  } as never;
}

function selectedObject(): Selection {
  return {
    kind: "object.root",
    label: "magnet",
    moduleSource: "geometry-authoring",
    nodeId: "model:object:magnet",
    objectId: "magnet",
    ref: null,
  };
}

describe("Object General authoring mutations", () => {
  it("records identity edits against the captured scene revision and session", async () => {
    const before = scene(7);
    const after = scene(8);
    const record = vi.fn();
    const patchObject = vi.fn(async () => after);
    const sceneRead = vi.fn(async () => before);

    await patchObjectIdentityWithHistory({
      api: { model: { patchObject, scene: sceneRead } } as never,
      authoringHistory: { record } as never,
      sessionScopeKey: "session=test&epoch=1",
      source: "inspector",
    } as never, {
      baseRevision: 6,
      name: "Updated magnet",
      notes: "new notes",
      objectId: "magnet",
    });

    expect(sceneRead).toHaveBeenCalledWith({ sessionScopeKey: "session=test&epoch=1" });
    expect(patchObject).toHaveBeenCalledWith("magnet", {
      base_revision: 7,
      name: "Updated magnet",
      notes: "new notes",
    }, { sessionScopeKey: "session=test&epoch=1" });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      after,
      before,
      committedRevision: 8,
      label: "Edit identity Updated magnet",
    }));
  });

  it("clears the deleted object's selection before recording history", async () => {
    const before = scene(10);
    const after = {
      objects: [],
      revision: 11,
      scene_revision: 11,
    } as never;
    let currentSelection = selectedObject();
    const clear = vi.fn((source: string) => {
      currentSelection = { ...EMPTY_SELECTION, moduleSource: source };
    });
    const record = vi.fn();
    const commitTransaction = vi.fn(async () => ({
      committed_scene: after,
      scene_revision: 11,
      transaction_kind: "delete_object",
    }));

    await deleteObjectWithHistory({
      api: { model: { commitTransaction, scene: vi.fn(async () => before) } } as never,
      authoringHistory: { record } as never,
      selection: { clear, get: () => currentSelection } as never,
      sessionScopeKey: "session=test&epoch=2",
      source: "inspector",
    } as never, {
      baseRevision: 9,
      name: "magnet",
      objectId: "magnet",
    });

    expect(commitTransaction).toHaveBeenCalledWith({
      base_revision: 10,
      kind: "delete_object",
      object_id: "magnet",
    }, { sessionScopeKey: "session=test&epoch=2" });
    expect(clear).toHaveBeenCalledWith("geometry-authoring");
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      after,
      before,
      beforeWorkspaceState: expect.objectContaining({ selection: selectedObject() }),
      afterWorkspaceState: expect.objectContaining({ selection: expect.objectContaining({
        kind: null,
        objectId: null,
      }) }),
      committedRevision: 11,
      label: "Delete magnet",
    }));
  });

  it("does not capture a newer selection made while object deletion is pending", async () => {
    const before = scene(12);
    const after = {
      objects: [],
      revision: 13,
      scene_revision: 13,
    } as never;
    let currentSelection = selectedObject();
    const clear = vi.fn();
    const record = vi.fn();
    const commitTransaction = vi.fn(async () => {
      currentSelection = {
        ...selectedObject(),
        label: "newer selection",
        nodeId: "model:object:newer",
        objectId: "newer",
      };
      return {
        committed_scene: after,
        scene_revision: 13,
        transaction_kind: "delete_object",
      };
    });

    await deleteObjectWithHistory({
      api: { model: { commitTransaction, scene: vi.fn(async () => before) } } as never,
      authoringHistory: { record } as never,
      selection: { clear, get: () => currentSelection } as never,
      source: "inspector",
    } as never, {
      baseRevision: 11,
      name: "magnet",
      objectId: "magnet",
    });

    expect(clear).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      afterWorkspaceState: { selection: selectedObject() },
    }));
  });
});
