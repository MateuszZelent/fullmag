import { describe, expect, it, vi } from "vitest";

import { MODEL_SCENE_PATH } from "../api/apiPaths";
import type { SceneResource } from "../api/apiTypes";
import { sharedResourceRuntimeStore } from "../resources/ResourceRuntimeStore";

import {
  AuthoringHistoryController,
  type AuthoringHistoryWorkspaceState,
} from "./AuthoringHistoryController";

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
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
    const beforeWorkspaceState: AuthoringHistoryWorkspaceState = {
      selection: {
        kind: "object.root",
        label: "Before",
        moduleSource: "explorer",
        nodeId: "model:object:before",
        objectId: "before",
        ref: null,
      },
    };
    const afterWorkspaceState: AuthoringHistoryWorkspaceState = {
      selection: {
        kind: "object.root",
        label: "After",
        moduleSource: "geometry-authoring",
        nodeId: "model:object:after",
        objectId: "after",
        ref: null,
      },
    };
    const onWorkspaceRestored = vi.fn();

    history.record({
      after: scene(2, "after"),
      afterWorkspaceState,
      before: scene(1, "before"),
      beforeWorkspaceState,
      committedRevision: 2,
      label: "Edit geometry",
    });

    await expect(history.undo(undefined, onWorkspaceRestored)).resolves.toMatchObject({
      message: "Undid Edit geometry.",
      status: "completed",
    });
    expect(onWorkspaceRestored).toHaveBeenNthCalledWith(1, {
      expected: afterWorkspaceState,
      restore: beforeWorkspaceState,
      scene: current,
    });
    expect(commitTransaction).toHaveBeenCalledWith({
      base_revision: 2,
      kind: "replace_scene",
      scene: expect.objectContaining({
        editor: { marker: "before" },
      }),
    }, undefined);
    expect(history.getSnapshot()).toMatchObject({
      canRedo: true,
      canUndo: false,
      redoLabel: "Edit geometry",
    });

    await expect(history.redo(undefined, onWorkspaceRestored)).resolves.toMatchObject({
      message: "Redid Edit geometry.",
      status: "completed",
    });
    expect(onWorkspaceRestored).toHaveBeenNthCalledWith(2, {
      expected: beforeWorkspaceState,
      restore: afterWorkspaceState,
      scene: current,
    });
    expect(commitTransaction).toHaveBeenLastCalledWith({
      base_revision: 3,
      kind: "replace_scene",
      scene: expect.objectContaining({
        editor: { marker: "after" },
      }),
    }, undefined);
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

  it("cancels an undo cleared while the scene revision is loading", async () => {
    const sceneRead = deferred<SceneResource>();
    const commitTransaction = vi.fn();
    const history = new AuthoringHistoryController(
      {
        model: {
          commitTransaction,
          scene: vi.fn(() => sceneRead.promise),
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

    const resultPromise = history.undo("session=test&epoch=1");
    expect(history.getSnapshot()).toMatchObject({ pending: true });
    history.clear();
    expect(history.getSnapshot()).toMatchObject({
      canRedo: false,
      canUndo: false,
      pending: true,
    });

    sceneRead.resolve(scene(2, "after"));

    await expect(resultPromise).resolves.toMatchObject({
      status: "cancelled",
    });
    expect(commitTransaction).not.toHaveBeenCalled();
    expect(history.getSnapshot()).toMatchObject({
      canRedo: false,
      canUndo: false,
      pending: false,
    });
  });

  it("does not publish or restore stacks when clear races a transaction ACK", async () => {
    const commitResponse = deferred<{
      committed_scene: SceneResource;
      scene_revision: number;
      transaction_kind: string;
    }>();
    const commitStarted = deferred<void>();
    const current = scene(2, "after");
    const commitTransaction = vi.fn(() => {
      commitStarted.resolve();
      return commitResponse.promise;
    });
    const resources = { invalidate: vi.fn() };
    const history = new AuthoringHistoryController(
      {
        model: {
          commitTransaction,
          scene: vi.fn(async () => current),
        },
      },
      resources as never,
    );
    const sessionScopeKey = "session=test&epoch=1";
    const baseline = scene(2, "baseline");
    const scopedSceneKey = `${sessionScopeKey}|${MODEL_SCENE_PATH}`;
    sharedResourceRuntimeStore.resetForTests();
    sharedResourceRuntimeStore.updateData(MODEL_SCENE_PATH, baseline, 2);
    sharedResourceRuntimeStore.updateData(scopedSceneKey, baseline, 2);
    history.record({
      after: current,
      before: scene(1, "before"),
      committedRevision: 2,
      label: "Edit geometry",
    });

    try {
      const resultPromise = history.undo(sessionScopeKey);
      await commitStarted.promise;
      expect(commitTransaction).toHaveBeenCalledTimes(1);

      history.clear();
      commitResponse.resolve({
        committed_scene: scene(3, "before"),
        scene_revision: 3,
        transaction_kind: "replace_scene",
      });

      await expect(resultPromise).resolves.toMatchObject({
        status: "cancelled",
      });
      expect(resources.invalidate).not.toHaveBeenCalled();
      expect(sharedResourceRuntimeStore.getSnapshot(MODEL_SCENE_PATH)).toMatchObject({
        data: baseline,
        revision: 2,
      });
      expect(sharedResourceRuntimeStore.getSnapshot(scopedSceneKey)).toMatchObject({
        data: baseline,
        revision: 2,
      });
      expect(history.getSnapshot()).toMatchObject({
        canRedo: false,
        canUndo: false,
        pending: false,
      });
    } finally {
      sharedResourceRuntimeStore.resetForTests();
    }
  });
});
