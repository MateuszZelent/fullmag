import { describe, expect, it, vi } from "vitest";

import { VISUALIZATION_STATE_PATH } from "../api/apiPaths";
import type {
  VisualizationStatePatch,
  VisualizationStateResource,
} from "../api/apiTypes";
import { CommandRegistry } from "../commands/CommandRegistry";
import { createCommandContext } from "../commands/commandContext";
import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import { SelectionController } from "../selection/SelectionController";
import { ControlRoomApiError } from "../api/ControlRoomApi";

import {
  FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET,
  ObjectVisualizationController,
} from "./ObjectVisualizationController";
import { VisualizationRegistrySyncController } from "./VisualizationRegistrySyncController";
import { VISUALIZATION_TARGET_COMMANDS } from "./visualizationCommandContributions";

describe("visualization target commands", () => {
  it("patches the selected object through the command registry payload", async () => {
    const commands = new CommandRegistry();
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    const visualization = new ObjectVisualizationController();
    const queuedPatches: VisualizationStatePatch[] = [];
    for (const command of VISUALIZATION_TARGET_COMMANDS) {
      commands.register(command);
    }
    selection.set(
      {
        kind: "object.visualization",
        label: "Free layer",
        nodeId: "model:object:free-layer:visualization",
        objectId: "free-layer",
      },
      "test",
    );
    const result = await commands.execute(
      "visualization.target.set-vectors-visible",
      {
        resourceData: {
          [VISUALIZATION_STATE_PATH]: {
            overrides: [],
            revision: 7,
          },
        },
        selection,
        source: "test" as const,
        visualization,
        visualizationSync: {
          queuePatch: (patch: VisualizationStatePatch) => queuedPatches.push(patch),
        } as never,
      },
      true,
    );

    expect(result.status).toBe("completed");
    expect(queuedPatches).toEqual([
      {
        overrides: [
          {
            display: { vectors: { visible: true } },
            scope: "object",
            scope_id: "free-layer",
          },
        ],
      },
    ]);
    expect(visualization.getSnapshot().overrides).not.toHaveProperty(
      "object:free-layer",
    );
  });

  it("passes the canonical target identity to the session synchronizer", async () => {
    const commands = new CommandRegistry();
    const visualization = new ObjectVisualizationController();
    const queuePatch = vi.fn();
    for (const command of VISUALIZATION_TARGET_COMMANDS) {
      commands.register(command);
    }

    const result = await commands.execute(
      "visualization.target.set-vectors-visible",
      {
        resourceData: {
          [VISUALIZATION_STATE_PATH]: { overrides: [], revision: 7 },
        },
        source: "test",
        visualization,
        visualizationSync: { queuePatch } as never,
        visualizationTarget: FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET,
      },
      true,
    );

    expect(result).toMatchObject({ status: "completed" });
    expect(queuePatch).toHaveBeenCalledWith(
      {
        overrides: [
          {
            display: { vectors: { visible: true } },
            scope: "fdm_domain",
            scope_id: "fdm-universe-outside-support",
          },
        ],
      },
      ["fdm-universe-outside-support"],
    );
  });

  it("maps ordinary render-mode commands to the corresponding display passes", async () => {
    const commands = new CommandRegistry();
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    const visualization = new ObjectVisualizationController();
    const queuedPatches: VisualizationStatePatch[] = [];
    for (const command of VISUALIZATION_TARGET_COMMANDS) {
      commands.register(command);
    }
    selection.set(
      {
        kind: "object.visualization",
        label: "Free layer",
        nodeId: "model:object:free-layer:visualization",
        objectId: "free-layer",
      },
      "test",
    );
    const context = {
      resourceData: {
        [VISUALIZATION_STATE_PATH]: { overrides: [], revision: 7 },
      },
      selection,
      source: "test" as const,
      visualization,
      visualizationSync: {
        queuePatch: (patch: VisualizationStatePatch) => queuedPatches.push(patch),
      } as never,
    };
    await expect(
      commands.execute("visualization.target.set-render-mode", context, "wireframe"),
    ).resolves.toMatchObject({ status: "completed" });
    expect(queuedPatches[0]).toMatchObject({
      overrides: [{
        display: {
          points: { visible: false },
          surface: { visible: false },
          wireframe: { visible: true },
        },
        scope: "object",
        scope_id: "free-layer",
      }],
    });

    await expect(
      commands.execute("visualization.target.set-render-mode", context, "points"),
    ).resolves.toMatchObject({ status: "completed" });
    expect(queuedPatches[1]).toMatchObject({
      overrides: [{
        display: {
          points: { visible: true },
          surface: { visible: false },
          wireframe: { visible: false },
        },
        scope: "object",
        scope_id: "free-layer",
      }],
    });

    await expect(
      commands.execute("visualization.target.set-render-mode", context, "off"),
    ).resolves.toMatchObject({ status: "completed" });
    expect(queuedPatches[2]).toMatchObject({
      overrides: [{
        display: {
          points: { visible: false },
          surface: { visible: false },
          wireframe: { visible: false },
        },
        scope: "object",
        scope_id: "free-layer",
      }],
    });
  });

  it("routes session-scoped FDM target settings through the visualization resource", async () => {
    const commands = new CommandRegistry();
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    const visualization = new ObjectVisualizationController();
    const queuedPatches: VisualizationStatePatch[] = [];
    for (const command of VISUALIZATION_TARGET_COMMANDS) {
      commands.register(command);
    }
    selection.set(
      {
        kind: "airbox.visualization",
        label: "Visualization",
        nodeId: "model:airbox:visualization",
        objectId: null,
        ref: {
          kind: "mesh.grid.universe-outside-support",
          nodeId: "model:airbox:visualization",
          scope: "universe-outside-support",
          type: "fdm-domain",
          visualizationTargetId: "fdm-universe-outside-support",
        },
      },
      "test",
    );

    const target = {
      id: "fdm-universe-outside-support",
      kind: "fdm-domain" as const,
      label: "Airbox",
    };
    const context = {
        resourceData: {
          [VISUALIZATION_STATE_PATH]: {
            overrides: [],
            revision: 7,
          },
        },
        selection,
        source: "test" as const,
        visualization,
        visualizationSync: {
          queuePatch: (patch: VisualizationStatePatch) => queuedPatches.push(patch),
        } as never,
        visualizationTarget: target,
      };
    const result = await commands.execute(
      "visualization.target.set-vectors-visible",
      context,
      true,
    );

    expect(result).toMatchObject({ status: "completed" });
    expect(queuedPatches).toEqual([
      {
        overrides: [
          {
            display: { vectors: { visible: true } },
            scope: "fdm_domain",
            scope_id: target.id,
          },
        ],
      },
    ]);
    expect(visualization.getSnapshot().overrides).not.toHaveProperty(target.id);

    await expect(
      commands.execute(
        "visualization.target.set-render-mode",
        context,
        "surface",
      ),
    ).resolves.toMatchObject({ status: "failed" });
    expect(visualization.getSettings(target)).toMatchObject({
      renderMode: "wireframe",
      shaderVisible: false,
      wireframeVisible: true,
    });
  });

  it("rejects unavailable field-style commands for the FDM Airbox target", async () => {
    const commands = new CommandRegistry();
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    const visualization = new ObjectVisualizationController();
    for (const command of VISUALIZATION_TARGET_COMMANDS) {
      commands.register(command);
    }
    selection.set(
      {
        kind: "airbox.visualization",
        label: "Visualization",
        nodeId: "model:airbox:visualization",
        objectId: null,
        ref: {
          kind: "mesh.grid.universe-outside-support",
          nodeId: "model:airbox:visualization",
          scope: "universe-outside-support",
          type: "fdm-domain",
          visualizationTargetId: "fdm-universe-outside-support",
        },
      },
      "test",
    );

    const target = {
      id: "fdm-universe-outside-support",
      kind: "fdm-domain" as const,
      label: "Airbox",
    };
    const queuedPatches: VisualizationStatePatch[] = [];
    const result = await commands.execute(
      "visualization.target.set-surface-color-source",
      {
        resourceData: {
          [VISUALIZATION_STATE_PATH]: { overrides: [], revision: 7 },
        },
        selection,
        source: "test",
        visualization,
        visualizationSync: {
          queuePatch: (patch: VisualizationStatePatch) => queuedPatches.push(patch),
        } as never,
        visualizationTarget: target,
      },
      "inherit",
    );

    expect(result.status).toBe("failed");
    expect(queuedPatches).toEqual([]);
    expect(visualization.getSnapshot().overrides).toEqual({});
  });

  it("does not let command palette or shortcut commands change passes on a hidden target", async () => {
    const commands = new CommandRegistry();
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    const visualization = new ObjectVisualizationController();
    for (const command of VISUALIZATION_TARGET_COMMANDS) {
      commands.register(command);
    }
    selection.set(
      {
        kind: "object.visualization",
        label: "Free layer",
        nodeId: "model:object:free-layer:visualization",
        objectId: "free-layer",
      },
      "test",
    );
    visualization.patchTarget(
      { id: "object:free-layer", kind: "object" },
      { visible: false, wireframeVisible: true },
    );

    const hiddenContext = { selection, source: "shortcut" as const, visualization };
    expect(
      commands.get("visualization.target.set-wireframe-visible")?.isEnabled?.(
        hiddenContext,
      ),
    ).toBe(false);
    expect(
      await commands.execute(
        "visualization.target.set-wireframe-visible",
        hiddenContext,
        false,
      ),
    ).toMatchObject({ status: "failed" });
    expect(
      commands.get("visualization.target.set-geometry-scope")?.isEnabled?.(
        hiddenContext,
      ),
    ).toBe(false);
    expect(
      await commands.execute(
        "visualization.target.set-geometry-scope",
        hiddenContext,
        "surface",
      ),
    ).toMatchObject({ status: "failed" });
    expect(visualization.getSettings({ id: "object:free-layer", kind: "object" }))
      .toMatchObject({
        geometryScope: "surface",
        visible: false,
        wireframeVisible: true,
      });
    expect(
      commands.get("visualization.target.set-visible")?.isEnabled?.(hiddenContext),
    ).toBe(true);
  });

  it("patches the selected region target without changing its parent object", async () => {
    const commands = new CommandRegistry();
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    const visualization = new ObjectVisualizationController();
    const queuedPatches: VisualizationStatePatch[] = [];
    for (const command of VISUALIZATION_TARGET_COMMANDS) {
      commands.register(command);
    }
    selection.set(
      {
        kind: "object.region.visualization",
        label: "Core",
        nodeId: "model:object:free-layer:regions:core:visualization",
        objectId: "free-layer",
        ref: {
          kind: "object.region.visualization",
          nodeId: "model:object:free-layer:regions:core:visualization",
          objectId: "free-layer",
          regionId: "region:core",
          type: "scene-object",
          visualizationTargetId: "region:free-layer:region%3Acore",
        },
      },
      "test",
    );
    visualization.patchTarget(
      { id: "region:free-layer:region%3Acore", kind: "region" },
      { visible: true },
    );

    const result = await commands.execute(
      "visualization.target.set-wireframe-visible",
      {
        resourceData: {
          [VISUALIZATION_STATE_PATH]: { overrides: [], revision: 7 },
        },
        selection,
        source: "test",
        visualization,
        visualizationSync: {
          queuePatch: (patch: VisualizationStatePatch) => queuedPatches.push(patch),
        } as never,
      },
      false,
    );

    expect(result.status).toBe("completed");
    expect(queuedPatches).toEqual([
      {
        overrides: [
          {
            display: { wireframe: { visible: false } },
            scope: "region",
            scope_id: "region:free-layer:region%3Acore",
          },
        ],
      },
    ]);
    expect(visualization.getSnapshot().overrides).toMatchObject({
      "region:free-layer:region%3Acore": { visible: true },
    });
    expect(visualization.getSnapshot().overrides).not.toHaveProperty(
      "object:free-layer",
    );
  });

  it("removes the serialized surface color override when Inherited is selected", async () => {
    const commands = new CommandRegistry();
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    const visualization = new ObjectVisualizationController();
    const queuedPatches: VisualizationStatePatch[] = [];
    for (const command of VISUALIZATION_TARGET_COMMANDS) {
      commands.register(command);
    }
    selection.set(
      {
        kind: "object.visualization",
        label: "Free layer",
        nodeId: "model:object:free-layer:visualization",
        objectId: "free-layer",
      },
      "test",
    );

    const result = await commands.execute(
      "visualization.target.set-surface-color-source",
      {
        selection,
        source: "test",
        visualization,
        visualizationSync: {
          queuePatch: (patch: VisualizationStatePatch) => queuedPatches.push(patch),
        } as never,
        resourceData: {
          [VISUALIZATION_STATE_PATH]: {
            overrides: [
              {
                scope: "object",
                scope_id: "free-layer",
                style: { surface_color_source: "component_x" },
              },
            ],
          } as VisualizationStateResource,
        },
      },
      "inherit",
    );

    expect(result.status).toBe("completed");
    expect(queuedPatches).toEqual([{ overrides: [] }]);
  });

  it("clears selected object overrides through the command registry", async () => {
    const commands = new CommandRegistry();
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    const visualization = new ObjectVisualizationController();
    const queuedPatches: VisualizationStatePatch[] = [];
    for (const command of VISUALIZATION_TARGET_COMMANDS) {
      commands.register(command);
    }
    selection.set(
      {
        kind: "object.visualization",
        label: "Free layer",
        nodeId: "model:object:free-layer:visualization",
        objectId: "free-layer",
      },
      "test",
    );
    visualization.patchTargetPending(
      { id: "object:free-layer", kind: "object" },
      { surfaceOpacityPercent: 35 },
      7,
    );
    const result = await commands.execute(
      "visualization.target.clear-overrides",
      {
        resourceData: {
          [VISUALIZATION_STATE_PATH]: {
            overrides: [
              {
                scope: "object",
                scope_id: "free-layer",
                display: { surface: { opacity: 0.35 } },
              },
            ],
            revision: 7,
          },
        },
        selection,
        source: "test",
        visualization,
        visualizationSync: {
          queuePatch: (patch: VisualizationStatePatch) => queuedPatches.push(patch),
        } as never,
      },
    );

    expect(result.status).toBe("completed");
    expect(queuedPatches).toEqual([{ overrides: [] }]);
    expect(visualization.getSnapshot().overrides).toEqual({});
    expect(visualization.getSnapshot().pendingOverrides).toEqual({});
  });

  it("patches and clears a mesh-part selection as a part even when it has an owning object", async () => {
    const commands = new CommandRegistry();
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    const visualization = new ObjectVisualizationController();
    const queuedPatches: VisualizationStatePatch[] = [];
    for (const command of VISUALIZATION_TARGET_COMMANDS) {
      commands.register(command);
    }
    selection.set(
      {
        kind: "mesh-part",
        label: "Projection film",
        nodeId: "part-film",
        objectId: "projection-film",
        ref: {
          kind: "mesh-part",
          nodeId: "part-film",
          objectId: "projection-film",
          type: "mesh-part",
          visualizationTargetId: "mesh-part:part-film",
        },
      },
      "test",
    );

    const setResult = await commands.execute(
      "visualization.target.set-vectors-visible",
      {
        resourceData: {
          [VISUALIZATION_STATE_PATH]: { overrides: [], revision: 7 },
        },
        selection,
        source: "test",
        visualization,
        visualizationSync: {
          queuePatch: (patch: VisualizationStatePatch) => queuedPatches.push(patch),
        } as never,
        visualizationTarget: { id: "part-film", kind: "part" },
      },
      false,
    );

    expect(setResult.status).toBe("completed");
    expect(queuedPatches).toEqual([
      {
        overrides: [
          {
            display: { vectors: { visible: false } },
            scope: "part",
            scope_id: "part-film",
          },
        ],
      },
    ]);

    const clearResult = await commands.execute(
      "visualization.target.clear-overrides",
      {
        resourceData: {
          [VISUALIZATION_STATE_PATH]: { overrides: [], revision: 7 },
        },
        selection,
        source: "test",
        visualization,
        visualizationSync: {
          queuePatch: (patch: VisualizationStatePatch) => queuedPatches.push(patch),
        } as never,
        visualizationTarget: { id: "part-film", kind: "part" },
      },
    );

    expect(clearResult.status).toBe("completed");
    expect(queuedPatches[1]).toEqual({ overrides: [] });
  });

  it("uses a Ribbon-provided canonical target after createCommandContext", async () => {
    const commands = new CommandRegistry();
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    const visualization = new ObjectVisualizationController();
    const queuedPatches: VisualizationStatePatch[] = [];
    for (const command of VISUALIZATION_TARGET_COMMANDS) {
      commands.register(command);
    }
    selection.set(
      {
        kind: "mesh-part",
        label: "Film mesh",
        nodeId: "part-film",
        objectId: null,
        ref: {
          kind: "mesh-part",
          nodeId: "part-film",
          objectId: null,
          type: "mesh-part",
          visualizationTargetId: "mesh-part:part-film",
        },
      },
      "test",
    );

    const context = createCommandContext(
      "ribbon",
      {
        selection,
        visualization,
        visualizationSync: {
          queuePatch: (patch: VisualizationStatePatch) => queuedPatches.push(patch),
        },
      } as never,
      {
        resourceData: {
          [VISUALIZATION_STATE_PATH]: { overrides: [], revision: 7 },
        },
        visualizationTarget: { id: "object:projection-film", kind: "object" },
      },
    );
    const result = await commands.execute(
      "visualization.target.set-vectors-visible",
      context,
      false,
    );

    expect(result.status).toBe("completed");
    expect(queuedPatches).toEqual([
      {
        overrides: [
          {
            display: { vectors: { visible: false } },
            scope: "object",
            scope_id: "projection-film",
          },
        ],
      },
    ]);
    expect(visualization.getSnapshot().overrides).toEqual({});
  });

  it("writes selected object target patches to backend-owned visualization overrides when state is available", async () => {
    const commands = new CommandRegistry();
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    const visualization = new ObjectVisualizationController();
    const queuedPatches: VisualizationStatePatch[] = [];
    const immediatePatches: VisualizationStatePatch[] = [];
    const visualizationState = {
      overrides: [],
      revision: 7,
    } as unknown as VisualizationStateResource;
    for (const command of VISUALIZATION_TARGET_COMMANDS) {
      commands.register(command);
    }
    selection.set(
      {
        kind: "object.visualization",
        label: "Free layer",
        nodeId: "model:object:free-layer:visualization",
        objectId: "free-layer",
      },
      "test",
    );

    const result = await commands.execute(
      "visualization.target.set-vectors-visible",
      {
        api: {
          visualization: {
            patch: async (patch: VisualizationStatePatch) => {
              immediatePatches.push(patch);
              return {
                ...visualizationState,
                ...patch,
                revision: 8,
              } as VisualizationStateResource;
            },
          },
        } as never,
        resourceData: {
          [VISUALIZATION_STATE_PATH]: visualizationState,
        },
        resources: {
          invalidate: () => undefined,
        } as never,
        selection,
        source: "test",
        visualization,
        visualizationSync: {
          queuePatch: (patch: VisualizationStatePatch) => {
            queuedPatches.push(patch);
          },
        } as never,
      },
      false,
    );

    expect(result.status).toBe("completed");
    expect(immediatePatches).toEqual([]);
    expect(queuedPatches).toEqual([
      {
        overrides: [
          {
            display: {
              vectors: {
                visible: false,
              },
            },
            scope: "object",
            scope_id: "free-layer",
          },
        ],
      },
    ]);
  });

  it("fails closed for a session-scoped object when visualization state is unavailable", async () => {
    const commands = new CommandRegistry();
    const visualization = new ObjectVisualizationController();
    for (const command of VISUALIZATION_TARGET_COMMANDS) {
      commands.register(command);
    }

    const result = await commands.execute(
      "visualization.target.set-wireframe-color",
      {
        source: "inspector",
        visualization,
        visualizationTarget: { id: "object:film", kind: "object" },
      },
      "#123456",
    );

    expect(result).toMatchObject({ status: "failed" });
    expect(visualization.getSnapshot().overrides).not.toHaveProperty(
      "object:film",
    );
  });

  it("does not persist ordinary object settings locally when visualization state is unavailable", async () => {
    const commands = new CommandRegistry();
    const visualization = new ObjectVisualizationController();
    for (const command of VISUALIZATION_TARGET_COMMANDS) {
      commands.register(command);
    }

    const result = await commands.execute(
      "visualization.target.set-vectors-visible",
      {
        source: "inspector",
        visualization,
        visualizationTarget: { id: "object:film", kind: "object" },
      },
      true,
    );

    expect(result).toMatchObject({
      status: "failed",
      message: "Visualization state resource is unavailable.",
    });
    expect(
      visualization.getSettings({ id: "object:film", kind: "object" }).vectorsVisible,
    ).toBe(false);
    expect(visualization.getSnapshot().overrides).not.toHaveProperty(
      "object:film",
    );
  });

  it("does not clear ordinary object settings locally when visualization state is unavailable", async () => {
    const commands = new CommandRegistry();
    const visualization = new ObjectVisualizationController();
    const target = { id: "object:film", kind: "object" as const };
    for (const command of VISUALIZATION_TARGET_COMMANDS) {
      commands.register(command);
    }
    visualization.patchTarget(target, { vectorsVisible: true });

    const result = await commands.execute(
      "visualization.target.clear-overrides",
      {
        source: "inspector",
        visualization,
        visualizationTarget: target,
      },
    );

    expect(result).toMatchObject({
      status: "failed",
      message: "Visualization state resource is unavailable.",
    });
    expect(visualization.getSettings(target).vectorsVisible).toBe(true);
  });

  it("keeps object color optimistic through the shared sync and acknowledges its revision", async () => {
    const commands = new CommandRegistry();
    const visualization = new ObjectVisualizationController();
    const remote = { overrides: [], revision: 7 } as unknown as VisualizationStateResource;
    const patchedStates: VisualizationStateResource[] = [];
    const sync = new VisualizationRegistrySyncController({
      api: {
        patch: async (patch) => {
          const next = {
            ...remote,
            ...patch,
            revision: 8,
          } as VisualizationStateResource;
          patchedStates.push(next);
          return next;
        },
      },
      retryBaseDelayMs: 0,
    });
    for (const command of VISUALIZATION_TARGET_COMMANDS) {
      commands.register(command);
    }
    sync.observeRemoteState(remote);

    const result = await commands.execute(
      "visualization.target.set-wireframe-color",
      {
        resourceData: { [VISUALIZATION_STATE_PATH]: remote },
        source: "inspector",
        visualization,
        visualizationSync: sync,
        visualizationTarget: { id: "object:film", kind: "object" },
      },
      "#123456",
    );

    expect(result).toMatchObject({ status: "completed" });
    expect(sync.applyOptimisticState(remote)?.overrides).toEqual([
      {
        scope: "object",
        scope_id: "film",
        style: { wireframe_color: "#123456" },
      },
    ]);

    await sync.flushNow();

    expect(patchedStates).toHaveLength(1);
    expect(patchedStates[0]?.revision).toBe(8);
    expect(sync.getSnapshot()).toMatchObject({
      inflightPatch: null,
      pendingPatch: null,
      lastRemoteRevision: 8,
      mutation: { status: "succeeded", targetId: "object:film" },
    });
    expect(sync.applyOptimisticState(patchedStates[0])?.overrides).toEqual(
      patchedStates[0]?.overrides,
    );
  });

  it("rolls back an optimistic object color when the shared session mutation is rejected", async () => {
    const commands = new CommandRegistry();
    const visualization = new ObjectVisualizationController();
    const remote = { overrides: [], revision: 7 } as unknown as VisualizationStateResource;
    const sync = new VisualizationRegistrySyncController({
      api: {
        patch: async () => {
          throw new ControlRoomApiError("invalid color", 400, "req-color");
        },
      },
      retryBaseDelayMs: 0,
    });
    for (const command of VISUALIZATION_TARGET_COMMANDS) {
      commands.register(command);
    }
    sync.observeRemoteState(remote);

    await commands.execute(
      "visualization.target.set-shader-mono-color",
      {
        resourceData: { [VISUALIZATION_STATE_PATH]: remote },
        source: "inspector",
        visualization,
        visualizationSync: sync,
        visualizationTarget: { id: "object:film", kind: "object" },
      },
      "#654321",
    );
    expect(sync.applyOptimisticState(remote)?.overrides).toHaveLength(1);

    await sync.flushNow();

    expect(sync.applyOptimisticState(remote)).toBe(remote);
    expect(sync.getSnapshot().error?.message).toBe("invalid color");
    expect(sync.getSnapshot()).toMatchObject({
      mutation: {
        requestId: "req-color",
        status: "rejected",
        targetId: "object:film",
      },
      pendingPatch: null,
      inflightPatch: null,
    });
  });

  it("routes FDM native-layer colors through the session visualization resource", async () => {
    const commands = new CommandRegistry();
    const visualization = new ObjectVisualizationController();
    const target = {
      id: "fdm-native-layer:film",
      kind: "fdm-native-layer" as const,
    };
    const queuedPatches: VisualizationStatePatch[] = [];
    for (const command of VISUALIZATION_TARGET_COMMANDS) {
      commands.register(command);
    }

    const result = await commands.execute(
      "visualization.target.set-wireframe-color",
      {
        resourceData: {
          [VISUALIZATION_STATE_PATH]: {
            overrides: [],
            revision: 7,
          },
        },
        source: "inspector",
        visualization,
        visualizationSync: {
          queuePatch: (patch: VisualizationStatePatch) => queuedPatches.push(patch),
        } as never,
        visualizationTarget: target,
      },
      "#123456",
    );

    expect(result).toMatchObject({ status: "completed" });
    expect(queuedPatches).toEqual([
      {
        overrides: [
          {
            scope: "fdm_native_layer",
            scope_id: target.id,
            style: { wireframe_color: "#123456" },
          },
        ],
      },
    ]);
    expect(visualization.getSnapshot().overrides).not.toHaveProperty(target.id);
  });
});
