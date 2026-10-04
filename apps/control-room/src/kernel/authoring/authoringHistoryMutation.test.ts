import { describe, expect, it, vi } from "vitest";

import { MODEL_SCENE_PATH } from "../api/apiPaths";
import type { Selection } from "../selection/selectionTypes";
import { AuthoringHistoryController } from "./AuthoringHistoryController";
import { SessionCommandCancelledError } from "../commands/commandSessionScope";
import { createCommandContext } from "../commands/commandContext";
import type { KernelApi } from "../types";

import {
  captureAuthoringMutationFence,
  prepareAuthoringMutation,
  recordAuthoringMutationHistory,
  runAuthoringMutationWithHistory,
} from "./authoringHistoryMutation";

function scene(revision: number) {
  return {
    revision,
    scene_revision: revision,
    objects: [],
    couplings: [],
  } as never;
}

describe("runAuthoringMutationWithHistory", () => {
  it("fences authoring side effects to the captured session and history generation", () => {
    let currentSessionScopeKey: string | null = "session=A&epoch=1";
    let historyGeneration = 4;
    const kernel = {
      api: {} as never,
      authoringHistory: { getGeneration: () => historyGeneration } as never,
      commands: { getSessionScopeKey: () => currentSessionScopeKey },
    } as unknown as KernelApi;
    const context = captureAuthoringMutationFence(
      createCommandContext("inspector", kernel, {
        sessionScopeKey: "session=A&epoch=1",
      }),
    );

    expect(context.isCurrentSessionScope?.()).toBe(true);
    currentSessionScopeKey = "session=B&epoch=2";
    expect(context.isCurrentSessionScope?.()).toBe(false);
    currentSessionScopeKey = "session=A&epoch=1";
    historyGeneration += 1;
    expect(context.isCurrentSessionScope?.()).toBe(false);
  });

  it("treats missing session identity as obsolete instead of allowing an unscoped mutation", () => {
    const kernel = {
      api: {} as never,
      commands: { getSessionScopeKey: () => null },
    } as unknown as KernelApi;
    const context = captureAuthoringMutationFence(
      createCommandContext("inspector", kernel, { sessionScopeKey: null }),
    );

    expect(context.sessionScopeKey).toBeNull();
    expect(context.isCurrentSessionScope?.()).toBe(false);
  });

  it("does not send a mutation when scope changes during the history scene read", async () => {
    let current = true;
    const mutation = vi.fn();
    await expect(runAuthoringMutationWithHistory(
      {
        api: { model: { scene: vi.fn(async () => { current = false; return scene(7); }) } } as never,
        authoringHistory: { record: vi.fn() } as never,
        isCurrentSessionScope: () => current,
      },
      "Edit in previous session",
      mutation,
    )).rejects.toBeInstanceOf(SessionCommandCancelledError);
    expect(mutation).not.toHaveBeenCalled();
  });

  it("does not record an ACK after the command's resource scope becomes obsolete", async () => {
    let current = true;
    const record = vi.fn();
    const sceneReader = vi.fn(async () => scene(7));
    await runAuthoringMutationWithHistory(
      {
        api: { model: { scene: sceneReader } } as never,
        authoringHistory: { record } as never,
        isCurrentSessionScope: () => current,
      },
      "Edit in previous session",
      async () => { current = false; return { scene_revision: 8 }; },
    );
    expect(record).not.toHaveBeenCalled();
    expect(sceneReader).toHaveBeenCalledOnce();
  });

  it("keeps an initially empty history empty after a session clear during a mutation", async () => {
    const api = { model: { scene: vi.fn(async () => scene(7)), commitTransaction: vi.fn() } };
    const history = new AuthoringHistoryController(api, { invalidate: vi.fn() } as never);
    await runAuthoringMutationWithHistory(
      { api: api as never, authoringHistory: history },
      "First edit in previous session",
      async () => {
        history.clear();
        return scene(8);
      },
    );
    expect(history.getSnapshot()).toMatchObject({ canUndo: false, canRedo: false });
  });

  it("does not restore cleared history when a mutation ACK arrives late", async () => {
    let generation = 0;
    const record = vi.fn();
    const after = scene(8);
    const result = await runAuthoringMutationWithHistory(
      {
        api: { model: { scene: vi.fn(async () => scene(7)) } } as never,
        authoringHistory: { record, getGeneration: () => generation } as never,
      },
      "Edit in previous session",
      async () => {
        generation += 1;
        return after;
      },
    );
    expect(result).toBe(after);
    expect(record).not.toHaveBeenCalled();
  });

  it("does not restore cleared history during the post-ACK scene read", async () => {
    let generation = 0;
    const record = vi.fn();
    const sceneReader = vi.fn()
      .mockResolvedValueOnce(scene(7))
      .mockImplementationOnce(async () => {
        generation += 1;
        return scene(8);
      });
    await runAuthoringMutationWithHistory(
      {
        api: { model: { scene: sceneReader } } as never,
        authoringHistory: { record, getGeneration: () => generation } as never,
      },
      "Edit in previous session",
      async () => ({ scene_revision: 8 }),
    );
    expect(sceneReader).toHaveBeenCalledTimes(2);
    expect(record).not.toHaveBeenCalled();
  });

  it("records an explicitly authored selection transition", async () => {
    const before = scene(7);
    const after = scene(8);
    const record = vi.fn();
    const beforeSelection: Selection = {
      kind: "object.root",
      label: "Before",
      moduleSource: "explorer",
      nodeId: "model:object:before",
      objectId: "before",
      ref: null,
    };
    const afterSelection: Selection = {
      kind: "object.root",
      label: "After",
      moduleSource: "geometry-authoring",
      nodeId: "model:object:after",
      objectId: "after",
      ref: null,
    };
    let currentSelection = beforeSelection;
    const mutation = vi.fn(async ({ baseRevision }: { baseRevision: number | null }) => {
      expect(baseRevision).toBe(7);
      currentSelection = afterSelection;
      return after;
    });

    const result = await runAuthoringMutationWithHistory(
      {
        api: { model: { scene: vi.fn(async () => before) } } as never,
        authoringHistory: { record } as never,
        selection: { get: () => currentSelection } as never,
      },
      "Duplicate region core",
      mutation,
      undefined,
      { captureWorkspaceStateAfter: true },
    );

    expect(result).toBe(after);
    expect(mutation).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith({
      after,
      afterWorkspaceState: {
        selection: afterSelection,
      },
      before,
      beforeWorkspaceState: {
        selection: beforeSelection,
      },
      committedRevision: 8,
      label: "Duplicate region core",
    });
  });

  it("does not absorb a newer workspace selection into an unrelated mutation", async () => {
    const before = scene(15);
    const after = scene(16);
    const record = vi.fn();
    const beforeSelection: Selection = {
      kind: "object.root",
      label: "Before",
      moduleSource: "explorer",
      nodeId: "model:object:before",
      objectId: "before",
      ref: null,
    };
    let currentSelection = beforeSelection;
    const mutation = async () => {
      currentSelection = {
        ...beforeSelection,
        label: "Selected while request was pending",
        objectId: "newer",
        nodeId: "model:object:newer",
      };
      return after;
    };

    await runAuthoringMutationWithHistory(
      {
        api: { model: { scene: vi.fn(async () => before) } } as never,
        authoringHistory: { record } as never,
        selection: { get: () => currentSelection } as never,
      },
      "Edit geometry",
      mutation,
    );

    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      afterWorkspaceState: {
        selection: beforeSelection,
      },
    }));
  });

  it("uses the cached scene when the authoritative read is unavailable", async () => {
    const before = scene(10);
    const after = scene(11);
    const record = vi.fn();

    await runAuthoringMutationWithHistory(
      {
        api: {
          model: {
            scene: vi.fn(async () => {
              throw new Error("temporary read failure");
            }),
          },
        } as never,
        authoringHistory: { record } as never,
        resourceData: { [MODEL_SCENE_PATH]: before },
      },
      "Reorder regions",
      async ({ baseRevision }) => {
        expect(baseRevision).toBe(10);
        return after;
      },
    );

    expect(record).toHaveBeenCalledOnce();
  });

  it("does not add history when the mutation does not advance the scene", async () => {
    const before = scene(12);
    const record = vi.fn();

    await runAuthoringMutationWithHistory(
      {
        api: { model: { scene: vi.fn(async () => before) } } as never,
        authoringHistory: { record } as never,
      },
      "No-op mutation",
      async () => before,
    );

    expect(record).not.toHaveBeenCalled();
  });

  it("refetches the full scene when an ACK contains only a revision", async () => {
    const before = scene(20);
    const after = scene(21);
    const record = vi.fn();
    const sceneReader = vi
      .fn()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);

    await runAuthoringMutationWithHistory(
      {
        api: { model: { scene: sceneReader } } as never,
        authoringHistory: { record } as never,
      },
      "Update field drive",
      async () => ({ scene_revision: 21 }),
    );

    expect(sceneReader).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledWith({
      after,
      before,
      committedRevision: 21,
      label: "Update field drive",
    });
  });

  it("records a partial multi-step ACK as its own reversible scene transition", async () => {
    const before = scene(30);
    const after = scene(31);
    const record = vi.fn();
    const context = {
      api: { model: { scene: vi.fn(async () => before) } } as never,
      authoringHistory: { record } as never,
    };
    const preparation = await prepareAuthoringMutation(context);

    await recordAuthoringMutationHistory(
      context,
      "Create material (assignment pending)",
      preparation,
      after,
    );

    expect(record).toHaveBeenCalledWith({
      after,
      before,
      committedRevision: 31,
      label: "Create material (assignment pending)",
    });
  });

  it("does not capture a newer selection when recording an unrelated direct mutation", async () => {
    const before = scene(40);
    const after = scene(41);
    const beforeSelection: Selection = {
      kind: "object.root",
      label: "Before",
      moduleSource: "explorer",
      nodeId: "model:object:before",
      objectId: "before",
      ref: null,
    };
    let currentSelection = beforeSelection;
    const record = vi.fn();
    const context = {
      api: { model: { scene: vi.fn(async () => before) } } as never,
      authoringHistory: { record } as never,
      selection: { get: () => currentSelection } as never,
    };
    const preparation = await prepareAuthoringMutation(context);
    currentSelection = {
      ...beforeSelection,
      label: "Selected while request was pending",
      nodeId: "model:object:newer",
      objectId: "newer",
    };

    await recordAuthoringMutationHistory(
      context,
      "Edit geometry",
      preparation,
      after,
    );

    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      afterWorkspaceState: { selection: beforeSelection },
    }));
  });
});
