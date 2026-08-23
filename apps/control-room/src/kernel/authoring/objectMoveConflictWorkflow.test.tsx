import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ControlRoomApiError } from "@/kernel/api/ControlRoomApi";
import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import { CommandRegistry } from "@/kernel/commands/CommandRegistry";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { KernelContext } from "@/kernel/KernelContext";
import { LayoutController } from "@/kernel/layout/LayoutController";
import { SelectionController } from "@/kernel/selection/SelectionController";
import { RIBBON_COMMANDS } from "@/modules/ribbon/ribbonCommands";
import {
  createMoveGestureController,
  Viewport3DMoveToolLayer,
} from "@/modules/viewport-3d/MoveObjectGizmo";
import { buildViewport3DPrimitiveRenderModel } from "@/modules/viewport-3d/viewport3dPrimitiveModel";

import { ObjectMoveToolController } from "./ObjectMoveToolController";
import {
  commitObjectMoveWorkflow,
  rebaseObjectMoveConflict,
  type ObjectMoveConflict,
} from "./objectMoveConflictWorkflow";

describe("object move integration", () => {
  it("runs Ribbon Move, preserves an absolute draft through 409/refetch/rebase, and clears it only after retry ACK", async () => {
    const bus = new EventBus<KernelEventMap>();
    const layout = new LayoutController(bus);
    const selection = new SelectionController(bus);
    const objectMoveTool = new ObjectMoveToolController();
    selection.set({
      kind: "object.root",
      label: "Magnet",
      nodeId: "model:object:magnet",
      objectId: "magnet",
      ref: {
        kind: "object.root",
        nodeId: "model:object:magnet",
        objectId: "magnet",
        type: "scene-object",
        visualizationTargetId: "object:magnet",
      },
    }, "test");
    const sceneAt41 = {
      objects: [{
        geometry: { geometry_kind: "Box", geometry_params: { size: [2e-9, 2e-9, 2e-9] } },
        id: "magnet",
        name: "Magnet",
        role: "magnet",
        transform: { translation: [1e-9, 0, 0] },
      }],
      revision: 41,
    };
    const commands = new CommandRegistry();
    for (const command of RIBBON_COMMANDS) commands.register(command);
    const commandContext = {
      api: {} as never,
      layout,
      objectMoveTool,
      resourceData: { [MODEL_SCENE_PATH]: sceneAt41 },
      selection,
      source: "test" as const,
    };

    expect(await commands.execute("geometry.move-selected", commandContext)).toEqual({
      status: "completed",
    });
    const primitiveModel = buildViewport3DPrimitiveRenderModel(sceneAt41, null);
    const mounted = renderToStaticMarkup(
      createElement(
        KernelContext.Provider,
        { value: { objectMoveTool } as never },
        createElement(Viewport3DMoveToolLayer, {
          moveDraftResetRevision: 0,
          moveToolObjectId: objectMoveTool.getSnapshot()?.objectId ?? null,
          onCommit: vi.fn(),
          primitiveModel,
          selectedObjectId: "magnet",
        }),
      ),
    );
    expect(mounted).toContain("name=\"move-gizmo:magnet\"");

    const commitTransaction = vi
      .fn()
      .mockRejectedValueOnce(
        new ControlRoomApiError("stale", 409, "request-1", "revision_conflict"),
      )
      .mockResolvedValueOnce({ scene_revision: 43 });
    const invalidate = vi.fn();
    const draftChanges = vi.fn();
    const gestureActiveChanges = vi.fn();
    const release = vi.fn();
    let conflict: ObjectMoveConflict | null = null;
    let resetRevision = 0;
    const commit = (objectId: string, translation: [number, number, number], baseRevision: number) =>
      commitObjectMoveWorkflow({
        api: { model: { commitTransaction } } as never,
        baseRevision,
        objectId,
        onAcknowledged: () => {
          draftChanges(null);
          resetRevision += 1;
          conflict = null;
        },
        onConflict: (next) => { conflict = next; },
        resources: { invalidate } as never,
        translation,
      });
    const gesture = createMoveGestureController({
      baseRevision: 41,
      objectId: "magnet",
      onCommit: commit,
      onDraftChange: draftChanges,
      onGestureActiveChange: gestureActiveChanges,
      origin: [1e-9, 0, 0],
    });

    gesture.begin("x", 7, [0, 0, 0], vi.fn(), release);
    gesture.move(7, [4e-9, 0, 0]);
    await gesture.end(7);

    expect(commitTransaction).toHaveBeenCalledTimes(1);
    expect(commitTransaction.mock.calls[0]?.[0]).toMatchObject({
      base_revision: 41,
      transform: { translation: [5e-9, 0, 0] },
    });
    expect(draftChanges).not.toHaveBeenLastCalledWith(null);
    expect(conflict).toMatchObject({
      baseRevision: 41,
      phase: "conflict",
      translation: [5e-9, 0, 0],
    });
    expect(invalidate).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(gestureActiveChanges.mock.calls).toEqual([[true], [false]]);

    const refetchStates: string[] = [];
    refetchStates.push("loading");
    const sceneAt42 = { ...sceneAt41, revision: 42 };
    refetchStates.push("ready");
    conflict = rebaseObjectMoveConflict(conflict!, sceneAt42.revision);
    expect(conflict.translation).toEqual([5e-9, 0, 0]);
    expect(refetchStates).toEqual(["loading", "ready"]);

    await commit(conflict.objectId, conflict.translation, conflict.baseRevision);

    expect(commitTransaction).toHaveBeenCalledTimes(2);
    expect(commitTransaction.mock.calls[1]?.[0]).toMatchObject({
      base_revision: 42,
      transform: { translation: [5e-9, 0, 0] },
    });
    expect(invalidate).toHaveBeenCalledTimes(7);
    expect(invalidate.mock.calls.every(([, revision]) => revision === 43)).toBe(true);
    expect(draftChanges).toHaveBeenLastCalledWith(null);
    expect(resetRevision).toBe(1);
    expect(conflict).toBeNull();
  });
});
