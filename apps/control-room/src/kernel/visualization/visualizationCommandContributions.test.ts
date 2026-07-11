import { describe, expect, it } from "vitest";

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

import { ObjectVisualizationController } from "./ObjectVisualizationController";
import { VISUALIZATION_TARGET_COMMANDS } from "./visualizationCommandContributions";

describe("visualization target commands", () => {
  it("patches the selected object through the command registry payload", async () => {
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
    const result = await commands.execute(
      "visualization.target.set-vectors-visible",
      {
        selection,
        source: "test",
        visualization,
      },
      true,
    );

    expect(result.status).toBe("completed");
    expect(visualization.getSettings({ id: "object:free-layer", kind: "object" }))
      .toMatchObject({
        vectorsVisible: true,
      });
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
        selection,
        source: "test",
        visualization,
      },
      false,
    );

    expect(result.status).toBe("completed");
    expect(
      visualization.getSettings({
        id: "region:free-layer:region%3Acore",
        kind: "region",
      }),
    ).toMatchObject({
      wireframeVisible: false,
    });
    expect(visualization.getSettings({ id: "free-layer", kind: "object" }))
      .toMatchObject({
        wireframeVisible: true,
      });
  });

  it("clears selected object overrides through the command registry", async () => {
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
      {
        id: "object:free-layer",
        kind: "object",
      },
      {
        opacityPercent: 35,
      },
    );

    const result = await commands.execute(
      "visualization.target.clear-overrides",
      {
        selection,
        source: "test",
        visualization,
      },
    );

    expect(result.status).toBe("completed");
    expect(visualization.getSettings({ id: "object:free-layer", kind: "object" }))
      .toMatchObject({
        opacityPercent: 100,
      });
  });

  it("patches and clears a mesh-part selection as a part even when it has an owning object", async () => {
    const commands = new CommandRegistry();
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    const visualization = new ObjectVisualizationController();
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
        selection,
        source: "test",
        visualization,
        visualizationTarget: { id: "part-film", kind: "part" },
      },
      false,
    );

    expect(setResult.status).toBe("completed");
    expect(visualization.getSettings({ id: "part-film", kind: "part" }))
      .toMatchObject({ vectorsVisible: false });
    expect(visualization.getSnapshot().overrides).toMatchObject({
      "part:part-film": { vectorsVisible: false },
    });
    expect(visualization.getSnapshot().overrides).not.toHaveProperty(
      "object:projection-film",
    );

    const clearResult = await commands.execute(
      "visualization.target.clear-overrides",
      {
        selection,
        source: "test",
        visualization,
        visualizationTarget: { id: "part-film", kind: "part" },
      },
    );

    expect(clearResult.status).toBe("completed");
    expect(visualization.getSnapshot().overrides).not.toHaveProperty(
      "part:part-film",
    );
  });

  it("uses a Ribbon-provided canonical target after createCommandContext", async () => {
    const commands = new CommandRegistry();
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    const visualization = new ObjectVisualizationController();
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
      { selection, visualization } as never,
      { visualizationTarget: { id: "object:projection-film", kind: "object" } },
    );
    const result = await commands.execute(
      "visualization.target.set-vectors-visible",
      context,
      false,
    );

    expect(result.status).toBe("completed");
    expect(visualization.getSnapshot().overrides).toMatchObject({
      "object:projection-film": { vectorsVisible: false },
    });
    expect(visualization.getSnapshot().overrides).not.toHaveProperty(
      "part:part-film",
    );
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
});
