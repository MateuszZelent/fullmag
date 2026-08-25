import { describe, expect, it, vi } from "vitest";

import {
  PROBLEM_IR_03_RIGID_TRANSFORM_REASON,
  createMoveGestureController,
  installMoveGestureTerminalListeners,
  moveAxisPointerHandlers,
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

    controller.begin("x", 4, [0, 0, 0], capture, release);
    controller.move(4, [2e-9, 8e-9, 0]);
    controller.move(4, [5e-9, 9e-9, 0]);

    expect(capture).toHaveBeenCalledWith(4);
    expect(onCommit).not.toHaveBeenCalled();
    expect(onDraftChange).toHaveBeenLastCalledWith({
      objectId: "magnet-x",
      origin: [1e-9, 2e-9, 3e-9],
      translation: [6e-9, 2e-9, 3e-9],
    });

    await controller.end(4);

    expect(release).toHaveBeenCalledWith(4);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("magnet-x", [6e-9, 2e-9, 3e-9], 17);
    expect(onDraftChange).toHaveBeenLastCalledWith(null);
  });

  it("preserves the final draft when the commit reports a revision conflict", async () => {
    const onDraftChange = vi.fn();
    const controller = createMoveGestureController({
      baseRevision: 3,
      objectId: "stale-magnet",
      onCommit: vi.fn().mockResolvedValue(false),
      onDraftChange,
      origin: [0, 0, 0],
    });
    controller.begin("y", 8, [0, 0, 0], vi.fn(), vi.fn());
    controller.move(8, [0, 7e-9, 0]);

    await controller.end(8);

    expect(onDraftChange).toHaveBeenLastCalledWith({
      objectId: "stale-magnet",
      origin: [0, 0, 0],
      translation: [0, 7e-9, 0],
    });
  });

  it("explicitly cancels once, clears the draft, restores OrbitControls, and sends no request", () => {
    const onDraftChange = vi.fn();
    const onCommit = vi.fn();
    const onGestureActiveChange = vi.fn();
    const release = vi.fn();
    const controller = createMoveGestureController({
      baseRevision: 9,
      objectId: "magnet-y",
      onCommit,
      onDraftChange,
      onGestureActiveChange,
      origin: [0, 0, 0],
    });

    controller.begin("z", 2, [0, 0, 0], vi.fn(), release);
    controller.move(2, [0, 0, 3e-9]);
    expect(controller.cancel()).toBe(true);
    expect(controller.cancel()).toBe(false);

    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(2);
    expect(onDraftChange).toHaveBeenLastCalledWith(null);
    expect(onGestureActiveChange.mock.calls).toEqual([[true], [false]]);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it.each(["Escape", "unmount"])(
    "wires %s to release capture once, clear the draft, restore OrbitControls, and send no request",
    (path) => {
      const onCommit = vi.fn();
      const release = vi.fn();
      const onDraftChange = vi.fn();
      const onGestureActiveChange = vi.fn();
      const controller = createMoveGestureController({
        baseRevision: 9,
        objectId: "lifecycle-magnet",
        onCommit,
        onDraftChange,
        onGestureActiveChange,
        origin: [0, 0, 0],
      });
      const keydown: { listener: ((event: Event) => void) | null } = {
        listener: null,
      };
      const target = {
        addEventListener: vi.fn((_type: string, listener: EventListenerOrEventListenerObject) => {
          keydown.listener = listener as (event: Event) => void;
        }),
        removeEventListener: vi.fn(),
      } as never;
      const cleanup = installMoveGestureTerminalListeners(controller, target);
      controller.begin("z", 6, [0, 0, 0], vi.fn(), release);
      controller.move(6, [0, 0, 9e-9]);

      if (path === "Escape") {
        keydown.listener?.({ key: "Escape", preventDefault: vi.fn() } as never);
      } else {
        cleanup();
      }

      expect(release).toHaveBeenCalledOnce();
      expect(onDraftChange).toHaveBeenLastCalledWith(null);
      expect(onGestureActiveChange.mock.calls).toEqual([[true], [false]]);
      expect(onCommit).not.toHaveBeenCalled();
      cleanup();
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it("restores OrbitControls and releases capture when commit throws", async () => {
    const release = vi.fn();
    const onGestureActiveChange = vi.fn();
    const controller = createMoveGestureController({
      baseRevision: 9,
      objectId: "magnet-error",
      onCommit: vi.fn().mockRejectedValue(new Error("network")),
      onDraftChange: vi.fn(),
      onGestureActiveChange,
      origin: [0, 0, 0],
    });
    controller.begin("x", 3, [0, 0, 0], vi.fn(), release);

    await expect(controller.end(3)).rejects.toThrow("network");

    expect(release).toHaveBeenCalledOnce();
    expect(onGestureActiveChange.mock.calls).toEqual([[true], [false]]);
    expect(controller.cancel()).toBe(false);
  });

  it("wires R3F pointercancel and lostpointercapture to the idempotent terminal cleanup", () => {
    const releasePointerCapture = vi.fn();
    const onCommit = vi.fn();
    const controller = createMoveGestureController({
      baseRevision: 1,
      objectId: "wired-magnet",
      onCommit,
      onDraftChange: vi.fn(),
      origin: [0, 0, 0],
    });
    const handlers = moveAxisPointerHandlers(controller, "x");
    const event = {
      point: { x: 0, y: 0, z: 0 },
      pointerId: 11,
      stopPropagation: vi.fn(),
      target: { releasePointerCapture, setPointerCapture: vi.fn() },
    } as never;

    handlers.onPointerDown(event);
    handlers.onPointerCancel(event);
    handlers.onLostPointerCapture(event);

    expect(releasePointerCapture).toHaveBeenCalledOnce();
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
