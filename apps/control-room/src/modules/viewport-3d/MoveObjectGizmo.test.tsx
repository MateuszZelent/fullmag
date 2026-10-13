import { describe, expect, it, vi } from "vitest";
import { Ray, Vector3 } from "three";

import {
  createMoveGestureController,
  installMoveGestureTerminalListeners,
  moveAxisPointerHandlers,
} from "./MoveObjectGizmo";
import { isMoveCommitPending } from "./moveCommitLock";
import { MODEL_GEOMETRY_REALIZATION_CURRENT_PATH, SIMULATION_PREPARATION_PATH } from "@/kernel/api/apiPaths";
import {
  commitObjectTranslation,
  PROBLEM_IR_03_RIGID_TRANSFORM_REASON,
} from "@/kernel/authoring/objectTranslationMutation";

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
    expect(onCommit).toHaveBeenCalledWith("magnet-x", [6e-9, 2e-9, 3e-9], 17, {
      lockHeldByGesture: true,
    });
    expect(onDraftChange).toHaveBeenLastCalledWith(null);
  });

  it("uses the live ray beyond the captured shaft instead of a stale intersection", async () => {
    const onCommit = vi.fn().mockResolvedValue(true);
    const controller = createMoveGestureController({
      baseRevision: 1, objectId: "ray-magnet", onCommit,
      onDraftChange: vi.fn(), origin: [0, 0, 0],
    });
    controller.begin("x", 7, [0, 0, 0], vi.fn(), vi.fn(),
      new Ray(new Vector3(0, 0, 1), new Vector3(0, 0, -1)));
    controller.move(7, [0, 0, 0],
      new Ray(new Vector3(35e-9, 0, 1), new Vector3(0, 0, -1)));
    await controller.end(7);
    expect(onCommit).toHaveBeenCalledWith("ray-magnet", [35e-9, 0, 0], 1, {
      lockHeldByGesture: true,
    });
  });

  it("fences native pointer cancellation and releases the reservation once", () => {
    const onCommit = vi.fn();
    const release = vi.fn();
    const onGestureActiveChange = vi.fn();
    const controller = createMoveGestureController({
      baseRevision: 1, objectId: "cancel-magnet", onCommit,
      onDraftChange: vi.fn(), onGestureActiveChange, origin: [0, 0, 0],
    });
    const target = new EventTarget();
    const cleanup = installMoveGestureTerminalListeners(controller, target);
    controller.begin("x", 7, [0, 0, 0], vi.fn(), release);
    const unrelated = new Event("pointercancel");
    Object.defineProperty(unrelated, "pointerId", { value: 8 });
    target.dispatchEvent(unrelated);
    expect(release).not.toHaveBeenCalled();
    const cancelled = new Event("lostpointercapture");
    Object.defineProperty(cancelled, "pointerId", { value: 7 });
    target.dispatchEvent(cancelled);
    target.dispatchEvent(cancelled);
    expect(release).toHaveBeenCalledExactlyOnceWith(7);
    expect(onGestureActiveChange.mock.calls).toEqual([[true], [false]]);
    expect(onCommit).not.toHaveBeenCalled();
    cleanup();
  });

  it("does not capture or publish a preview when the session rejects a gesture reservation", () => {
    const onBeginGesture = vi.fn(() => false);
    const onDraftChange = vi.fn();
    const onGestureActiveChange = vi.fn();
    const capture = vi.fn();
    const onCommit = vi.fn();
    const controller = createMoveGestureController({
      baseRevision: 12,
      objectId: "pending-magnet",
      onBeginGesture,
      onCommit,
      onDraftChange,
      onGestureActiveChange,
      origin: [0, 0, 0],
    });

    controller.begin("x", 13, [0, 0, 0], capture, vi.fn());
    controller.move(13, [2e-9, 0, 0]);

    expect(onBeginGesture).toHaveBeenCalledOnce();
    expect(capture).not.toHaveBeenCalled();
    expect(onDraftChange).not.toHaveBeenCalled();
    expect(onGestureActiveChange).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("releases a reservation after pointer capture throws and permits the next gesture", async () => {
    let reserved = false;
    const onBeginGesture = vi.fn(() => {
      if (reserved) return false;
      reserved = true;
      return true;
    });
    const onGestureActiveChange = vi.fn((active: boolean) => { if (!active) reserved = false; });
    const onDraftChange = vi.fn();
    const onCommit = vi.fn().mockResolvedValue(true);
    const release = vi.fn();
    const controller = createMoveGestureController({
      baseRevision: 12,
      objectId: "capture-magnet",
      onBeginGesture,
      onGestureActiveChange,
      onDraftChange,
      onCommit,
      origin: [0, 0, 0],
    });
    expect(() => controller.begin("x", 1, [0, 0, 0], () => { throw new Error("capture rejected"); }, release)).not.toThrow();
    controller.move(1, [2e-9, 0, 0]);
    await controller.end(1);
    expect(reserved).toBe(false);
    expect(onGestureActiveChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(onDraftChange).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledExactlyOnceWith(1);
    controller.begin("x", 2, [0, 0, 0], vi.fn(), release);
    controller.move(2, [3e-9, 0, 0]);
    await controller.end(2);
    expect(onBeginGesture).toHaveBeenCalledTimes(2);
    expect(onCommit).toHaveBeenCalledOnce();
    expect(reserved).toBe(false);
  });

  it("reserves before capture, ignores a duplicate pointer, and releases before staging", async () => {
    const events: string[] = [];
    const onBeginGesture = vi.fn(() => {
      events.push("reserved");
      return true;
    });
    const onCommit = vi.fn(() => {
      events.push("stage");
      return true;
    });
    const onDraftChange = vi.fn();
    const onGestureActiveChange = vi.fn((active: boolean) => {
      events.push(active ? "orbit-blocked" : "reservation-released");
    });
    const capture = vi.fn(() => events.push("capture"));
    const release = vi.fn(() => events.push("capture-released"));
    const duplicateCapture = vi.fn();
    const controller = createMoveGestureController({
      baseRevision: 13,
      objectId: "gesture-magnet",
      onBeginGesture,
      onCommit,
      onDraftChange,
      onGestureActiveChange,
      origin: [0, 0, 0],
    });

    controller.begin("x", 14, [0, 0, 0], capture, release);
    controller.begin("y", 14, [0, 0, 0], duplicateCapture, vi.fn());
    controller.move(14, [4e-9, 0, 0]);
    await controller.end(14);

    expect(onBeginGesture).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledOnce();
    expect(duplicateCapture).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(onGestureActiveChange.mock.calls).toEqual([[true], [false]]);
    expect(events.indexOf("reserved")).toBeLessThan(events.indexOf("capture"));
    expect(events.indexOf("reservation-released")).toBeLessThan(events.indexOf("stage"));
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

  it("clears a no-op click without sending a commit", async () => {
    const onCommit = vi.fn();
    const onDraftChange = vi.fn();
    const controller = createMoveGestureController({
      baseRevision: 3,
      objectId: "stationary-magnet",
      onCommit,
      onDraftChange,
      origin: [1e-9, 2e-9, 3e-9],
    });

    controller.begin("x", 2, [0, 0, 0], vi.fn(), vi.fn());
    await controller.end(2);

    expect(onCommit).not.toHaveBeenCalled();
    expect(onDraftChange).toHaveBeenLastCalledWith(null);
  });

  it("blocks another gesture until the first move promise settles", async () => {
    let resolveCommit: ((result: boolean) => void) | undefined;
    const onCommit = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveCommit = resolve;
    }));
    const first = createMoveGestureController({
      baseRevision: 1,
      objectId: "magnet-a",
      onCommit,
      onDraftChange: vi.fn(),
      origin: [0, 0, 0],
    });
    const secondCapture = vi.fn();
    const second = createMoveGestureController({
      baseRevision: 1,
      objectId: "magnet-b",
      onCommit,
      onDraftChange: vi.fn(),
      origin: [0, 0, 0],
    });

    first.begin("x", 1, [0, 0, 0], vi.fn(), vi.fn());
    first.move(1, [1e-9, 0, 0]);
    const pending = first.end(1);
    expect(isMoveCommitPending(onCommit)).toBe(true);
    second.begin("y", 2, [0, 0, 0], secondCapture, vi.fn());

    expect(secondCapture).not.toHaveBeenCalled();
    expect(onCommit).toHaveBeenCalledOnce();
    resolveCommit?.(true);
    await pending;
    expect(isMoveCommitPending(onCommit)).toBe(false);
  });

  it("explicitly cancels once, clears the draft, restores OrbitControls, and sends no request", () => {
    const onDraftChange = vi.fn();
    const onCommit = vi.fn();
    const onGestureActiveChange = vi.fn();
    const onBeginGesture = vi.fn(() => true);
    const release = vi.fn();
    const controller = createMoveGestureController({
      baseRevision: 9,
      objectId: "magnet-y",
      onCommit,
      onBeginGesture,
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
    expect(onBeginGesture).toHaveBeenCalledOnce();
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
      const onBeginGesture = vi.fn(() => true);
      const controller = createMoveGestureController({
        baseRevision: 9,
        objectId: "lifecycle-magnet",
        onCommit,
        onBeginGesture,
        onDraftChange,
        onGestureActiveChange,
        origin: [0, 0, 0],
      });
      const keydown: { listener: ((event: Event) => void) | null } = {
        listener: null,
      };
      const target = {
        addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
          if (type === "keydown") keydown.listener = listener as (event: Event) => void;
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
      expect(onBeginGesture).toHaveBeenCalledOnce();
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
    controller.move(3, [1e-9, 0, 0]);

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

  it("handles a rejected pointerup promise without leaving a commit lock or unhandled rejection", async () => {
    const onCommit = vi.fn().mockRejectedValue(new Error("network"));
    const controller = createMoveGestureController({
      baseRevision: 1,
      objectId: "rejected-magnet",
      onCommit,
      onDraftChange: vi.fn(),
      origin: [0, 0, 0],
    });
    const handlers = moveAxisPointerHandlers(controller, "x");
    const event: Record<string, unknown> = {
      point: { x: 0, y: 0, z: 0 },
      pointerId: 11,
      stopPropagation: vi.fn(),
      target: { releasePointerCapture: vi.fn(), setPointerCapture: vi.fn() },
    };

    handlers.onPointerDown(event as never);
    handlers.onPointerMove({ ...event, point: { x: 1e-9, y: 0, z: 0 } } as never);
    expect(() => handlers.onPointerUp(event as never)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onCommit).toHaveBeenCalledOnce();
    expect(isMoveCommitPending(onCommit)).toBe(false);
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
    expect(invalidate).toHaveBeenCalledTimes(9);
    expect(new Set(invalidate.mock.calls.map(([resourceKey]) => resourceKey)).size).toBe(9);
    expect(invalidate).toHaveBeenCalledWith(MODEL_GEOMETRY_REALIZATION_CURRENT_PATH, 22);
    // Simulation preparation is keyed by a scene-scoped revision token; every
    // other dependent receives the numeric scene revision.
    expect(
      invalidate.mock.calls.every(([resourceKey, revision]) =>
        revision === (resourceKey === SIMULATION_PREPARATION_PATH ? "scene:22" : 22),
      ),
    ).toBe(true);
  });

  it("pins the translation request and drops stale-session ACK invalidations", async () => {
    let current = true;
    const commitTransaction = vi.fn().mockImplementation(async () => {
      current = false;
      return { scene_revision: 22 };
    });
    const invalidate = vi.fn();

    await commitObjectTranslation({
      api: { model: { commitTransaction } } as never,
      baseRevision: 21,
      isCurrentSessionScope: () => current,
      objectId: "magnet-z",
      resources: { invalidate } as never,
      sessionScopeKey: "session=A&epoch=1",
      translation: [4e-9, 5e-9, 6e-9],
    });

    expect(commitTransaction).toHaveBeenCalledWith(
      {
        base_revision: 21,
        kind: "commit_object_transform",
        object_id: "magnet-z",
        transform: { translation: [4e-9, 5e-9, 6e-9] },
      },
      { sessionScopeKey: "session=A&epoch=1" },
    );
    expect(invalidate).not.toHaveBeenCalled();
  });
});
