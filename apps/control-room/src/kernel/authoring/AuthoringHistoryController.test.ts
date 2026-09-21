import { describe, expect, it, vi } from "vitest";

import type { SceneResource } from "../api/apiTypes";

import { AuthoringHistoryController } from "./AuthoringHistoryController";

function scene(revision: number, marker: string): SceneResource {
  return {
    editor: { marker },
    revision,
    scene: {
      authoring_schema: "scene.v2",
      id: "scene-test",
      name: "History test",
      source_of_truth: "test",
    },
    version: "scene.v2",
  } as SceneResource;
}

describe("AuthoringHistoryController", () => {
  it("commits revision-fenced semantic undo and redo through replace_scene", async () => {
    let current = scene(2, "after");
    const commitTransaction = vi.fn(async (request: { base_revision?: number | null }) => {
      const nextRevision = (request.base_revision ?? 0) + 1;
      current = scene(nextRevision, nextRevision === 3 ? "before" : "after");
      return {
        committed_scene: current,
        scene_revision: nextRevision,
        transaction_kind: "replace_scene",
      };
    });
    const api = {
      model: {
        commitTransaction,
        scene: vi.fn(async () => current),
      },
    };
    const resources = { invalidate: vi.fn() } as never;
    const history = new AuthoringHistoryController(api, resources);

    history.record({
      after: scene(2, "after"),
      before: scene(1, "before"),
      committedRevision: 2,
      label: "Edit geometry",
    });

    await expect(history.undo()).resolves.toMatchObject({
      message: "Undid Edit geometry.",
      status: "completed",
    });
    expect(commitTransaction).toHaveBeenCalledWith({
      base_revision: 2,
      kind: "replace_scene",
      scene: expect.objectContaining({
        editor: { marker: "before" },
      }),
    });
    expect(history.getSnapshot()).toMatchObject({
      canRedo: true,
      canUndo: false,
      redoLabel: "Edit geometry",
    });

    await expect(history.redo()).resolves.toMatchObject({
      message: "Redid Edit geometry.",
      status: "completed",
    });
    expect(commitTransaction).toHaveBeenLastCalledWith({
      base_revision: 3,
      kind: "replace_scene",
      scene: expect.objectContaining({
        editor: { marker: "after" },
      }),
    });
    expect(history.getSnapshot()).toMatchObject({
      canRedo: false,
      canUndo: true,
      undoLabel: "Edit geometry",
    });
  });

  it("refuses to overwrite an external scene revision", async () => {
    let current = scene(2, "after");
    const commitTransaction = vi.fn();
    const api = {
      model: {
        commitTransaction,
        scene: vi.fn(async () => current),
      },
    };
    const history = new AuthoringHistoryController(
      api,
      { invalidate: vi.fn() } as never,
    );
    history.record({
      after: scene(2, "after"),
      before: scene(1, "before"),
      committedRevision: 2,
      label: "Edit geometry",
    });

    current = scene(7, "external");
    await expect(history.undo()).resolves.toMatchObject({
      message: "Undo stopped: the scene changed outside history at revision 7.",
      status: "failed",
    });
    expect(commitTransaction).not.toHaveBeenCalled();
    expect(history.getSnapshot()).toMatchObject({ canUndo: true, canRedo: false });
  });

  it("clears history when the project or session changes", () => {
    const history = new AuthoringHistoryController(
      {
        model: {
          commitTransaction: vi.fn(),
          scene: vi.fn(),
        },
      },
      { invalidate: vi.fn() } as never,
    );
    history.record({
      after: scene(2, "after"),
      before: scene(1, "before"),
      committedRevision: 2,
      label: "Edit geometry",
    });
    history.clear();
    expect(history.getSnapshot()).toMatchObject({
      canRedo: false,
      canUndo: false,
      undoLabel: null,
      redoLabel: null,
    });
  });
});
