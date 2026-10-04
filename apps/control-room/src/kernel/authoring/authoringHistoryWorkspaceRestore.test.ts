import { describe, expect, it, vi } from "vitest";

import type { SceneResource } from "../api/apiTypes";
import { EMPTY_SELECTION, type Selection } from "../selection/selectionTypes";
import type { AuthoringHistoryWorkspaceTransition } from "./AuthoringHistoryController";
import { applyAuthoringHistoryWorkspaceTransition } from "./authoringHistoryWorkspaceRestore";

function objectSelection(objectId: string): Selection {
  const nodeId = `model:object:${objectId}`;
  return {
    kind: "object.root",
    label: objectId,
    moduleSource: "geometry-authoring",
    nodeId,
    objectId,
    ref: {
      kind: "object.root",
      nodeId,
      objectId,
      type: "scene-object",
      visualizationTargetId: `object:${objectId}`,
    },
  };
}

function restoredScene(...objectIds: string[]): SceneResource {
  return {
    objects: objectIds.map((id) => ({ id })),
  };
}

function transition(
  scene: SceneResource,
  expectedSelection: Selection,
  restoreSelection: Selection,
): AuthoringHistoryWorkspaceTransition {
  return {
    expected: {
      selection: expectedSelection,
    },
    restore: {
      selection: restoreSelection,
    },
    scene,
  };
}

describe("applyAuthoringHistoryWorkspaceTransition", () => {
  it("restores a deleted object's selection when it has not changed", () => {
    const magnet = objectSelection("magnet");
    const selection = {
      clear: vi.fn(),
      get: () => EMPTY_SELECTION,
      set: vi.fn(),
    };
    applyAuthoringHistoryWorkspaceTransition(
      { selection } as never,
      transition(restoredScene("magnet"), EMPTY_SELECTION, magnet),
    );

    expect(selection.set).toHaveBeenCalledWith({
      kind: magnet.kind,
      label: magnet.label,
      nodeId: magnet.nodeId,
      objectId: magnet.objectId,
      ref: magnet.ref,
    }, "authoring-history");
  });

  it("recovers from an undone creation without keeping a selection for the removed object", () => {
    const created = objectSelection("created");
    const previous = objectSelection("magnet");
    const selection = {
      clear: vi.fn(),
      get: () => created,
      set: vi.fn(),
    };

    applyAuthoringHistoryWorkspaceTransition(
      { selection } as never,
      transition(restoredScene("magnet"), created, previous),
    );

    expect(selection.set).toHaveBeenCalledWith({
      kind: previous.kind,
      label: previous.label,
      nodeId: previous.nodeId,
      objectId: previous.objectId,
      ref: previous.ref,
    }, "authoring-history");
    expect(selection.clear).not.toHaveBeenCalled();
  });

  it("keeps a newer valid selection instead of time-travelling the workspace", () => {
    const current = objectSelection("newer");
    const expected = objectSelection("magnet");
    const selection = {
      clear: vi.fn(),
      get: () => current,
      set: vi.fn(),
    };
    applyAuthoringHistoryWorkspaceTransition(
      { selection } as never,
      transition(restoredScene("magnet", "newer"), expected, objectSelection("before")),
    );

    expect(selection.set).not.toHaveBeenCalled();
    expect(selection.clear).not.toHaveBeenCalled();
  });
});
