import { describe, expect, it, vi } from "vitest";

import {
  PROBLEM_IR_03_RIGID_TRANSFORM_REASON,
  createMoveGestureController,
} from "./MoveObjectGizmo";
import { commitObjectTranslation } from "@/kernel/authoring/objectTranslationMutation";

describe("MoveObjectGizmo", () => {
  it("keeps pointer movement local and commits the final SI translation once", async () => {
    const onDraftChange = vi.fn();
    const onCommit = vi.fn().mockResolvedValue(undefined);
    const capture = vi.fn();
    const release = vi.fn();
    const controller = createMoveGestureController({
      baseRevision: 17,
      objectId: "magnet-x",
      onCommit,
      onDraftChange,
      origin: [1e-9, 2e-9, 3e-9],
    });

    controller.begin("x", 4, [0, 0, 0], capture);
    controller.move(4, [2e-9, 8e-9, 0]);
    controller.move(4, [5e-9, 9e-9, 0]);

    expect(capture).toHaveBeenCalledWith(4);
    expect(onCommit).not.toHaveBeenCalled();
    expect(onDraftChange).toHaveBeenLastCalledWith({
      objectId: "magnet-x",
      origin: [1e-9, 2e-9, 3e-9],
      translation: [6e-9, 2e-9, 3e-9],
    });

    await controller.end(4, release);

    expect(release).toHaveBeenCalledWith(4);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("magnet-x", [6e-9, 2e-9, 3e-9], 17);
  });

  it("cancels with Escape, restores origin, and sends no request", () => {
    const onDraftChange = vi.fn();
    const onCommit = vi.fn();
    const controller = createMoveGestureController({
      baseRevision: 9,
      objectId: "magnet-y",
      onCommit,
      onDraftChange,
      origin: [0, 0, 0],
    });

    controller.begin("z", 2, [0, 0, 0], vi.fn());
    controller.move(2, [0, 0, 3e-9]);
    expect(controller.cancel()).toBe(true);

    expect(onDraftChange).toHaveBeenLastCalledWith({
      objectId: "magnet-y",
      origin: [0, 0, 0],
      translation: [0, 0, 0],
    });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("publishes the exact canonical-contract reason for Rotate and Scale", () => {
    expect(PROBLEM_IR_03_RIGID_TRANSFORM_REASON).toBe(
      "Rotate and Scale require a canonical geometry contract newer than ProblemIR 0.3.",
    );
  });

  it("uses one revision-safe API transaction and bounded ACK invalidations", async () => {
    const commitTransaction = vi.fn().mockResolvedValue({ scene_revision: 22 });
    const invalidate = vi.fn();

    await commitObjectTranslation({
      api: { model: { commitTransaction } } as never,
      baseRevision: 21,
      objectId: "magnet-z",
      resources: { invalidate } as never,
      translation: [4e-9, 5e-9, 6e-9],
    });

    expect(commitTransaction).toHaveBeenCalledOnce();
    expect(commitTransaction).toHaveBeenCalledWith({
      base_revision: 21,
      kind: "commit_object_transform",
      object_id: "magnet-z",
      transform: { translation: [4e-9, 5e-9, 6e-9] },
    });
    expect(invalidate).toHaveBeenCalledTimes(7);
    expect(new Set(invalidate.mock.calls.map(([resourceKey]) => resourceKey)).size).toBe(7);
    expect(invalidate.mock.calls.every(([, revision]) => revision === 22)).toBe(true);
  });
});
