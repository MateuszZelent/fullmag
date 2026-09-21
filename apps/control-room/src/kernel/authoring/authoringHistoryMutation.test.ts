import { describe, expect, it, vi } from "vitest";

import { MODEL_SCENE_PATH } from "../api/apiPaths";

import { runAuthoringMutationWithHistory } from "./authoringHistoryMutation";

function scene(revision: number) {
  return {
    revision,
    scene_revision: revision,
    objects: [],
    couplings: [],
  } as never;
}

describe("runAuthoringMutationWithHistory", () => {
  it("fences the write to the captured revision and records one semantic entry", async () => {
    const before = scene(7);
    const after = scene(8);
    const record = vi.fn();
    const mutation = vi.fn(async ({ baseRevision }: { baseRevision: number | null }) => {
      expect(baseRevision).toBe(7);
      return after;
    });

    const result = await runAuthoringMutationWithHistory(
      {
        api: { model: { scene: vi.fn(async () => before) } } as never,
        authoringHistory: { record } as never,
      },
      "Duplicate region core",
      mutation,
    );

    expect(result).toBe(after);
    expect(mutation).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith({
      after,
      before,
      committedRevision: 8,
      label: "Duplicate region core",
    });
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
});
