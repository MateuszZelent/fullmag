import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  ALL_TAB_CONTENT,
  buildRibbonTabContent,
  resolveRibbonVisualizationTarget,
} from "./ribbonContributions";
import {
  RIBBON_CROSS_SECTION_BEGIN_DRAFT_COMMAND,
  RIBBON_COMMANDS,
  RIBBON_PHYSICS_SELECT_INTERACTION_COMMAND,
  RIBBON_VISUALIZATION_APPLY_GLOBAL_QUANTITY_COMMAND,
  RIBBON_VISUALIZATION_PATCH_TARGET_COMMAND,
  RIBBON_VISUALIZATION_RESET_AIRBOX_COMMAND,
  visualizationTargetCommandInput,
} from "./ribbonCommands";
import {
  resolveRibbonActionTriggerState,
  resolveRibbonIconColor,
  RibbonGroupsRow,
} from "./RibbonGroupsRow";
import { RIBBON_TABS, type RibbonMenuNode } from "./ribbonTypes";
import {
  MESHING_CAPABILITIES_PATH,
  MODEL_GEOMETRY_VALIDATION_PATH,
  SIMULATION_COMMANDS_PATH,
  SIMULATION_SOLVER_STATUS_PATH,
  SIMULATION_STAGES_EXECUTION_PATH,
  VISUALIZATION_STATE_PATH,
} from "@/kernel/api/apiPaths";
import type {
  VisualizationStatePatch,
  VisualizationStateResource,
} from "@/kernel/api/apiTypes";
import { CommandRegistry } from "@/kernel/commands/CommandRegistry";
import type { CommandContext } from "@/kernel/commands/commandTypes";
import { SESSION_STATUS_RESOURCE_KEY } from "@/kernel/resources/useSessionStatus";
import { visualizationTargetIdForSceneObject } from "@/kernel/selection/selectionTypes";
import { STUDY_RUNTIME_COMMANDS } from "@/kernel/runtime/studyRuntimeCommandContributions";
import {
  AIRBOX_VISUALIZATION_TARGET,
  ObjectVisualizationController,
} from "@/kernel/visualization/ObjectVisualizationController";
import { VISUALIZATION_TARGET_COMMANDS } from "@/kernel/visualization/visualizationCommandContributions";
import {
  crossSectionWorkspaceStore,
  resetCrossSectionWorkspaceForTests,
} from "@/kernel/workspace/crossSectionWorkspace";
import { GEOMETRY_LIFECYCLE_COMMANDS } from "@/kernel/authoring/geometryLifecycleCommandContributions";
import { MAGNETIZATION_TEXTURE_COMMANDS } from "@/kernel/authoring/magnetization-texture/commands";
import { REGION_COMMANDS } from "@/kernel/authoring/regionCommandContributions";
import { SHELL_COMMANDS } from "@/kernel/layout/shellCommands";
import { ANALYSIS_FIELD_OVERLAY_COMMANDS } from "@/kernel/visualization/analysisFieldOverlayCommandContributions";
import { ALL_MODULES } from "@/modules/registry";

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

function createRibbonCommandRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  for (const command of [...RIBBON_COMMANDS, ...VISUALIZATION_TARGET_COMMANDS]) {
    registry.register(command);
  }
  return registry;
}

function createControlRoomCommandRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  for (const command of [
    ...SHELL_COMMANDS,
    ...GEOMETRY_LIFECYCLE_COMMANDS,
    ...STUDY_RUNTIME_COMMANDS,
    ...MAGNETIZATION_TEXTURE_COMMANDS,
    ...REGION_COMMANDS,
    ...VISUALIZATION_TARGET_COMMANDS,
    ...ANALYSIS_FIELD_OVERLAY_COMMANDS,
    ...RIBBON_COMMANDS,
  ]) {
    if (!registry.get(command.id)) registry.register(command);
  }
  for (const manifest of ALL_MODULES) {
    for (const command of manifest.contributes?.commands ?? []) {
      if (!registry.get(command.id)) registry.register(command);
    }
  }
  return registry;
}

function selectedMeshObject() {
  return {
    kind: "object.mesh" as const,
    label: "Box mesh",
    moduleSource: "test",
    nodeId: "model:object:box:mesh",
    objectId: "box",
    ref: {
      kind: "object.mesh" as const,
      nodeId: "model:object:box:mesh",
      objectId: "box",
      type: "scene-object" as const,
      visualizationTargetId: visualizationTargetIdForSceneObject("box"),
    },
  };
}

type RibbonNodeTestContext = Omit<
  Partial<CommandContext>,
  "api" | "resources" | "selection"
> & {
  api?: unknown;
  resources?: unknown;
  selection?: unknown;
  visualizationState?: VisualizationStateResource | null;
};

async function runRibbonNode(
  node: RibbonMenuNode,
  value: unknown,
  context: RibbonNodeTestContext,
) {
  const registry = createRibbonCommandRegistry();
  const staticSelection =
    context.selection &&
    typeof context.selection === "object" &&
    !("get" in context.selection) &&
    !("set" in context.selection);
  const selection = staticSelection
    ? ({
        get: () => context.selection,
      } as unknown as CommandContext["selection"])
    : (context.selection as CommandContext["selection"]);
  const resourceData =
    context.visualizationState &&
    !context.resourceData?.[VISUALIZATION_STATE_PATH]
      ? {
          ...context.resourceData,
          [VISUALIZATION_STATE_PATH]: context.visualizationState,
        }
      : context.resourceData;
  const commandId =
    "commandId" in node && typeof node.commandId === "string"
      ? node.commandId
      : node.id;
  const commandInput =
    "commandInput" in node && typeof node.commandInput === "function"
      ? node.commandInput(value as never)
      : "commandInput" in node && node.commandInput !== undefined
        ? node.commandInput
        : value;
  const result = await registry.execute(
    commandId,
    {
      source: "test",
      ...context,
      resourceData,
      selection,
    } as CommandContext,
    commandInput,
  );
  expect(result, result.message).toMatchObject({ status: "completed" });
}

function clickableRibbonCommandGaps(content: NonNullable<ReturnType<typeof buildRibbonTabContent>>, commands: CommandRegistry): string[] {
  const gaps: string[] = [];

  for (const group of content.groups) {
    for (const action of group.actions) {
      const actionPath = `${content.tabId}/${group.id}/${action.id}`;
      const triggerState = resolveRibbonActionTriggerState({
        disabled: action.disabled,
        hasMenu: Boolean(action.menu?.length),
        splitButton: action.splitButton,
      });
      if (
        !triggerState.disabled &&
        (triggerState.runsActionFromButton ||
          triggerState.runsActionFromSplitBody)
      ) {
        const commandId = action.commandId ?? action.id;
        if (!commands.get(commandId)) {
          gaps.push(`${actionPath} -> ${commandId}`);
        }
      }
      for (const gap of clickableRibbonMenuCommandGaps(
        action.menu ?? [],
        commands,
        actionPath,
        triggerState.disabled,
      )) {
        gaps.push(gap);
      }
    }
  }

  return gaps;
}

function clickableRibbonMenuCommandGaps(
  nodes: readonly RibbonMenuNode[],
  commands: CommandRegistry,
  parentPath: string,
  parentDisabled: boolean,
): string[] {
  if (parentDisabled) return [];
  const gaps: string[] = [];

  for (const node of nodes) {
    const nodePath = `${parentPath}/${node.id}`;
    if (node.type === "label" || node.type === "separator" || node.type === "status") {
      continue;
    }
    if (node.type === "submenu") {
      gaps.push(
        ...clickableRibbonMenuCommandGaps(
          node.nodes,
          commands,
          nodePath,
          Boolean(node.disabled),
        ),
      );
      continue;
    }
    if (node.type === "radio-group") {
      if (node.disabled) continue;
      for (const item of node.items) {
        if (item.disabled) continue;
        const commandId = item.commandId ?? node.commandId ?? node.id;
        if (!commands.get(commandId)) {
          gaps.push(`${nodePath}:${item.value} -> ${commandId}`);
        }
      }
      continue;
    }
    if (node.disabled) continue;
    const commandId = node.commandId ?? node.id;
    if (!commands.get(commandId)) {
      gaps.push(`${nodePath} -> ${commandId}`);
    }
  }

  return gaps;
}

describe("ribbon structure", () => {
  it("routes selected mesh parts through the canonical visualization target resolver", () => {
    const target = resolveRibbonVisualizationTarget({
      sceneObjectIds: new Set(),
      selectedMeshPart: {
        geometry_id: "projection-film",
        id: "part-film",
        object_id: null,
      },
      selection: {
        kind: "mesh-part",
        label: "Film mesh",
        moduleSource: "test",
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
      visualizationState: {
        targets: {
          airbox: {},
          objects: [],
          parts: [{ scope: "part", scope_id: "part-film" }],
        },
      } as never,
    });

    expect(target).toMatchObject({ id: "part-film", kind: "part" });
    expect(target && `part:${target.id}`).toBe("part:part-film");
  });

  it("keeps a selected mesh part scoped to the part before its manifest arrives", () => {
    expect(
      resolveRibbonVisualizationTarget({
        sceneObjectIds: new Set(),
        selectedMeshPart: null,
        selection: {
          kind: "mesh-part",
          label: "Film mesh",
          moduleSource: "test",
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
        visualizationState: null,
      }),
    ).toMatchObject({ id: "part-film", kind: "part" });
  });

  it("preserves canonical object ownership and scene-validated geometry aliases for selected mesh parts", () => {
    const selection = {
      kind: "mesh-part",
      label: "Film mesh",
      moduleSource: "test",
      nodeId: "part-film",
      objectId: "projection-film",
      ref: {
        kind: "mesh-part" as const,
        nodeId: "part-film",
        objectId: "projection-film",
        type: "mesh-part" as const,
        visualizationTargetId: "mesh-part:part-film" as const,
      },
    };

    expect(
      resolveRibbonVisualizationTarget({
        sceneObjectIds: new Set(["projection-film"]),
        selectedMeshPart: { id: "part-film", object_id: "projection-film" },
        selection,
        visualizationState: { targets: { airbox: {}, objects: [], parts: [] } } as never,
      }),
    ).toMatchObject({ id: "object:projection-film", kind: "object" });
    expect(
      resolveRibbonVisualizationTarget({
        sceneObjectIds: new Set(["projection-film"]),
        selectedMeshPart: { geometry_id: "projection-film", id: "part-film", object_id: null },
        selection,
        visualizationState: { targets: { airbox: {}, objects: [], parts: [] } } as never,
      }),
    ).toMatchObject({ id: "object:projection-film", kind: "object" });
  });

  it("defines visible content and dropdown structure for every ribbon tab", () => {
    for (const tab of RIBBON_TABS) {
      const content = ALL_TAB_CONTENT[tab.id];

      expect(content, tab.id).toBeDefined();
      expect(content.groups.length, tab.id).toBeGreaterThan(0);
      expect(
        content.groups.some((group) =>
          group.actions.some((action) => action.menu && action.menu.length > 0),
        ),
        tab.id,
      ).toBe(true);
    }
  });

  it("keeps field state save and load in the Home project group", () => {
    const homeProjectActions = ALL_TAB_CONTENT.home.groups
      .find((group) => group.id === "project")
      ?.actions.map((action) => action.id);
    const studyControlActions = ALL_TAB_CONTENT.study.groups
      .find((group) => group.id === "control")
      ?.actions.map((action) => action.id);

    expect(homeProjectActions).toEqual(
      expect.arrayContaining([
        "study.save-field-state",
        "study.load-field-state",
      ]),
    );
    expect(studyControlActions).not.toEqual(
      expect.arrayContaining([
        "study.save-field-state",
        "study.load-field-state",
      ]),
    );
  });

  it("wires Home workspace shortcuts to concrete workspace commands", () => {
    const commands = createControlRoomCommandRegistry();
    const layout = {
      get: () => ({
        activeViewportMainModuleId: "viewport-3d",
        panelVisible: {
          bottom: true,
          left: true,
          right: true,
        },
      }),
    } as unknown as CommandContext["layout"];
    const visualization = new ObjectVisualizationController();
    const content = buildRibbonTabContent("home", {
      commands,
      commandContext: {
        layout,
        source: "test",
      },
      selection: {
        kind: null,
        label: null,
        moduleSource: null,
        nodeId: null,
        objectId: null,
        ref: null,
      },
      visualization,
      visualizationSnapshot: visualization.getSnapshot(),
    });
    const workspaceGroup = content?.groups.find(
      (group) => group.id === "workspace",
    );
    const threeDimensionalAction = workspaceGroup?.actions.find(
      (action) => action.id === "viewport-3d.open",
    );
    const twoDimensionalAction = workspaceGroup?.actions.find(
      (action) => action.id === "ws-2d",
    );
    const analysisAction = workspaceGroup?.actions.find(
      (action) => action.id === "ws-analyze",
    );
    const liveChartsAction = workspaceGroup?.actions.find(
      (action) => action.id === "ws-live-charts",
    );
    const panelAction = workspaceGroup?.actions.find(
      (action) => action.id === "ws-panel",
    );

    expect(twoDimensionalAction).toMatchObject({
      commandId: "field-map.open",
      disabled: false,
    });
    expect(threeDimensionalAction).toMatchObject({
      id: "viewport-3d.open",
      splitButton: true,
    });
    expect(analysisAction).toMatchObject({
      commandId: "analysis-plots.open",
      disabled: false,
    });
    expect(liveChartsAction).toMatchObject({
      commandId: "live-charts.open",
      disabled: false,
      label: "Live Charts",
    });
    expect(panelAction).toMatchObject({
      disabled: false,
      menu: expect.arrayContaining([
        expect.objectContaining({
          commandId: "panels:explorer:toggle",
          id: "home-panels:explorer",
          type: "checkbox",
        }),
        expect.objectContaining({
          commandId: "panels:inspector:toggle",
          id: "home-panels:inspector",
          type: "checkbox",
        }),
        expect.objectContaining({
          commandId: "panels:footer:toggle",
          id: "home-panels:bottom-dock",
          type: "checkbox",
        }),
        expect.objectContaining({
          disabled: true,
          id: "home-panels:reset-layout",
        }),
      ]),
    });
  });

  it("keeps ribbon visual tokens theme-driven instead of hardcoded", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/modules/ribbon/ribbonContributions.tsx"),
      "utf8",
    );

    expect(source).not.toMatch(/#[0-9a-f]{3,8}/i);
    expect(source).toContain("var(--fm-accent)");
  });

  it("uses canonical energy-density quantity ids in result menus", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/modules/ribbon/ribbonContributions.tsx"),
      "utf8",
    );

    expect(source).not.toContain('"energy_density"');
    expect(source).toContain('"eden_total"');
  });

  it("normalizes legacy utility icon colors to design tokens", () => {
    expect(resolveRibbonIconColor("text-emerald-400")).toBe("var(--fm-success)");
    expect(resolveRibbonIconColor("text-sky-300")).toBe("var(--fm-accent)");
    expect(resolveRibbonIconColor("text-muted-foreground")).toBe(
      "var(--fm-text-muted)",
    );
    expect(resolveRibbonIconColor("var(--fm-warning)")).toBe("var(--fm-warning)");
  });

  it("resolves every contributed action icon color", () => {
    const unresolved = Object.values(ALL_TAB_CONTENT).flatMap((content) =>
      content.groups.flatMap((group) =>
        group.actions.flatMap((action) =>
          action.iconColor && !resolveRibbonIconColor(action.iconColor)
            ? [`${content.tabId}/${group.id}/${action.id}`]
            : [],
        ),
      ),
    );

    expect(unresolved).toEqual([]);
  });

  it("keeps every clickable ribbon action command-backed", () => {
    const commands = createControlRoomCommandRegistry();
    const visualization = new ObjectVisualizationController();
    const context = {
      api: {} as never,
      commandContext: {
        api: {} as never,
        resourceData: {
          [MODEL_GEOMETRY_VALIDATION_PATH]: { diagnostics: [] },
          [SESSION_STATUS_RESOURCE_KEY]: {
            capabilities: {
              binary_fields: true,
              eigen_modes: true,
              explicit_topology: true,
            },
            domain: {
              discretization: "fem",
            },
            resources: {
              mesh_revision: 0,
              scene_revision: 1,
            },
          },
          [SIMULATION_COMMANDS_PATH]: { commands: [] },
          [SIMULATION_SOLVER_STATUS_PATH]: { runtime_state: "idle" },
          [SIMULATION_STAGES_EXECUTION_PATH]: {
            active_stage_index: null,
            revision: 1,
            runtime_state: "idle",
            stages: [],
          },
        },
        source: "test" as const,
      },
      commands,
      selection: {
        kind: null,
        label: null,
        moduleSource: null,
        nodeId: null,
        objectId: null,
        ref: null,
      },
      visualization,
      visualizationSnapshot: visualization.getSnapshot(),
      visualizationState: null,
    };
    const gaps = RIBBON_TABS.flatMap((tab) => {
      const content = buildRibbonTabContent(tab.id, context);
      return content ? clickableRibbonCommandGaps(content, commands) : [];
    });

    expect(gaps).toEqual([]);
  });

  it("starts an editable 2D cross-section draft from the View ribbon", async () => {
    resetCrossSectionWorkspaceForTests();
    const content = buildRibbonTabContent("view", {
      commands: createRibbonCommandRegistry(),
      selection: {
        kind: null,
        label: null,
        moduleSource: null,
        nodeId: null,
        objectId: null,
        ref: null,
      },
      visualization: new ObjectVisualizationController(),
      visualizationSnapshot: new ObjectVisualizationController().getSnapshot(),
      visualizationState: {
        clip: {
          axis: "z",
          enabled: true,
          flipped: false,
          position_percent: 62.5,
        },
        revision: 3,
        slice: {
          axis: "z",
          mesh_color_scale: "viridis",
          mesh_filter_expression: "quality < 0.3",
          mesh_quality_metric: "skewness",
          mesh_shrink_factor: 0.8,
          position_percent: 62.5,
          show_mesh: true,
        },
      } as VisualizationStateResource,
    });

    expect(
      content?.groups
        .find((group) => group.id === "view-slice-2d")
        ?.actions.map((action) => action.id),
    ).toContain(RIBBON_CROSS_SECTION_BEGIN_DRAFT_COMMAND);

    const { context, invalidations, patches } = createVisualizationRibbonContext({
      clip: {
        axis: "z",
        enabled: true,
        flipped: false,
        position_percent: 62.5,
      },
      revision: 3,
      slice: {
        axis: "z",
        mesh_color_scale: "viridis",
        mesh_filter_expression: "quality < 0.3",
        mesh_quality_metric: "skewness",
        mesh_shrink_factor: 0.8,
        position_percent: 62.5,
        show_mesh: true,
      },
    });
    const selectionSet = vi.fn();
    const setPanelVisible = vi.fn();
    const setFocusedSlot = vi.fn();
    const result = await context.commands.execute(
      RIBBON_CROSS_SECTION_BEGIN_DRAFT_COMMAND,
      {
        ...context.commandContext,
        layout: {
          setFocusedSlot,
          setPanelVisible,
        } as never,
        selection: {
          set: selectionSet,
        } as never,
      },
    );

    expect(result).toMatchObject({ status: "completed" });
    expect(
      crossSectionWorkspaceStore.getSnapshot().planarMonitorDraft,
    ).toEqual({
      frameExtent: "universe",
      id: "draft",
      name: "Midplane",
      plane: "xy",
      positionPercent: 62.5,
      rotationDegrees: 0,
    });
    expect(crossSectionWorkspaceStore.getSnapshot().draft).toBeNull();
    expect(selectionSet).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "model.planar.monitor.draft",
        nodeId: "model:definitions:planar-monitors:draft",
      }),
      "test",
    );
    expect(selectionSet).toHaveBeenCalledTimes(1);
    expect(setPanelVisible).toHaveBeenCalledWith("left", true);
    expect(setPanelVisible).toHaveBeenCalledWith("right", true);
    expect(setFocusedSlot).toHaveBeenCalledWith("viewport-main");
    expect(patches).toEqual([]);
    expect(invalidations).toEqual([]);
    resetCrossSectionWorkspaceForTests();
  });

  it("keeps ribbon labels bounded inside fixed action geometry", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/design/styles/ribbon.css"),
      "utf8",
    );

    expect(source).toContain("--fm-ribbon-action-width");
    expect(source).toContain("-webkit-line-clamp: 2");
    expect(source).toContain("overflow-wrap: anywhere");
    expect(source).toContain(".fm-ribbon-group::before");
  });

  it("renders disabled ribbon action reasons on a hoverable shell", () => {
    const html = renderToStaticMarkup(
      createElement(RibbonGroupsRow, {
        groups: [
          {
            id: "control",
            title: "Control",
            actions: [
              {
                id: "study.run",
                icon: null,
                label: "Compute",
                disabled: true,
                tooltip:
                  "Build a shared-domain mesh before running FEM runtime commands.",
              },
            ],
          },
        ],
      }),
    );

    expect(html).toContain("fm-ribbon-action-shell");
    expect(html).toContain(
      'title="Build a shared-domain mesh before running FEM runtime commands."',
    );
  });

  it("does not execute pure-menu ribbon actions through the button body", () => {
    expect(
      resolveRibbonActionTriggerState({
        disabled: false,
        hasMenu: true,
        splitButton: false,
      }),
    ).toMatchObject({
      disabled: false,
      runsActionFromButton: false,
      runsActionFromSplitBody: false,
    });
  });

  it("keeps disabled menu ribbon actions non-clickable", () => {
    expect(
      resolveRibbonActionTriggerState({
        disabled: true,
        hasMenu: true,
        splitButton: false,
      }),
    ).toMatchObject({
      disabled: true,
      runsActionFromButton: false,
      runsActionFromSplitBody: false,
    });
  });

  it("keeps split-button bodies command-backed while the chevron opens the menu", () => {
    expect(
      resolveRibbonActionTriggerState({
        disabled: false,
        hasMenu: true,
        splitButton: true,
      }),
    ).toMatchObject({
      disabled: false,
      runsActionFromButton: false,
      runsActionFromSplitBody: true,
    });
  });

  it("enables selected display controls from the object visualization registry", async () => {
    const visualization = new ObjectVisualizationController();
    const content = buildRibbonTabContent("view", {
      selection: {
        kind: "object.visualization",
        label: "Free layer",
        moduleSource: "test",
        nodeId: "model:object:free-layer:visualization",
        objectId: "free-layer",
        ref: null,
      },
      visualization,
      visualizationSnapshot: visualization.getSnapshot(),
    });
    const selectedGroup = content?.groups.find(
      (group) => group.id === "view-selected-display",
    );
    const textureAction = selectedGroup?.actions.find(
      (action) => action.id === "view-selected-texture",
    );
    const renderAction = selectedGroup?.actions.find(
      (action) => action.id === "view-selected-render",
    );
    const surfaceColoringNode = textureAction?.menu?.find(
      (node) =>
        node.type === "radio-group" &&
        node.id === "selected-texture:surface-coloring",
    );
    const solidColorNode = textureAction?.menu?.find(
      (node) => node.type === "color" && node.id === "selected-texture:solid-color",
    );
    const vectorAlphaNode = textureAction?.menu?.find(
      (node) => node.type === "slider" && node.id === "selected-texture:vector-alpha",
    );
    const visibilityNode = renderAction?.menu?.find(
      (node) => node.type === "checkbox" && node.id === "selected:visible",
    );
    const frameNode = renderAction?.menu?.find(
      (node) => node.type === "checkbox" && node.id === "selected:frame",
    );
    const wireframeOpacityNode = renderAction?.menu?.find(
      (node) => node.type === "slider" && node.id === "selected:wireframe-opacity",
    );

    expect(textureAction?.disabled).toBe(false);
    expect(renderAction?.disabled).toBe(false);
    expect(surfaceColoringNode).toMatchObject({
      disabled: false,
      value: "inherit",
    });
    expect(solidColorNode).toMatchObject({
      disabled: false,
      value: "var(--fm-surface-magnetic)",
    });
    expect(vectorAlphaNode).toMatchObject({ value: 100 });
    expect(visibilityNode).toMatchObject({
      checked: true,
      disabled: false,
    });
    expect(frameNode).toMatchObject({
      checked: false,
      disabled: false,
    });

    if (
      frameNode?.type !== "checkbox" ||
      surfaceColoringNode?.type !== "radio-group" ||
      solidColorNode?.type !== "color" ||
      vectorAlphaNode?.type !== "slider" ||
      wireframeOpacityNode?.type !== "slider"
    ) {
      throw new Error("Expected selected display style controls");
    }

    const commandContext = {
      selection: {
        get: () => ({
          kind: "object.visualization",
          label: "Free layer",
          moduleSource: "test",
          nodeId: "model:object:free-layer:visualization",
          objectId: "free-layer",
          ref: null,
        }),
      } as never,
      visualization,
    };
    await runRibbonNode(frameNode, true, commandContext);
    await runRibbonNode(surfaceColoringNode, "solid", commandContext);
    await runRibbonNode(solidColorNode, "#ff0000", commandContext);
    await runRibbonNode(vectorAlphaNode, 48, commandContext);
    await runRibbonNode(wireframeOpacityNode, 64, commandContext);

    expect(visualization.getSettings({ id: "object:free-layer", kind: "object" }))
      .toMatchObject({
        boundsVisible: true,
        shaderColorMode: "monochrome",
        shaderMonoColor: "#ff0000",
        surfaceColorSource: "solid",
        vectorAlphaPercent: 48,
        wireframeOpacityPercent: 64,
      });
  });

  it("disables selected pass controls but keeps Visible and Clear available for a hidden target", () => {
    const visualization = new ObjectVisualizationController();
    visualization.patchTarget(
      { id: "object:free-layer", kind: "object" },
      { visible: false, wireframeVisible: true },
    );
    const content = buildRibbonTabContent("view", {
      selection: {
        kind: "object.visualization",
        label: "Free layer",
        moduleSource: "test",
        nodeId: "model:object:free-layer:visualization",
        objectId: "free-layer",
        ref: null,
      },
      visualization,
      visualizationSnapshot: visualization.getSnapshot(),
    });
    const renderAction = content?.groups
      .find((group) => group.id === "view-selected-display")
      ?.actions.find((action) => action.id === "view-selected-render");
    const node = (id: string) => renderAction?.menu?.find((entry) => entry.id === id);

    expect(node("selected:visible")).toMatchObject({ disabled: false, checked: false });
    expect(node("selected:wireframe")).toMatchObject({ disabled: true, checked: false });
    expect(node("selected:clear")).toMatchObject({ disabled: false });
  });

  it("lets the selected surface color picker switch the target to solid coloring", async () => {
    const visualization = new ObjectVisualizationController();
    const content = buildRibbonTabContent("view", {
      selection: {
        kind: "object.visualization",
        label: "Free layer",
        moduleSource: "test",
        nodeId: "model:object:free-layer:visualization",
        objectId: "free-layer",
        ref: null,
      },
      visualization,
      visualizationSnapshot: visualization.getSnapshot(),
    });
    const selectedGroup = content?.groups.find(
      (group) => group.id === "view-selected-display",
    );
    const textureAction = selectedGroup?.actions.find(
      (action) => action.id === "view-selected-texture",
    );
    const solidColorNode = textureAction?.menu?.find(
      (node) => node.type === "color" && node.id === "selected-texture:solid-color",
    );

    expect(solidColorNode).toMatchObject({ disabled: false });
    if (solidColorNode?.type !== "color") {
      throw new Error("Expected selected surface color picker");
    }

    await runRibbonNode(solidColorNode, "#336699", {
      selection: {
        get: () => ({
          kind: "object.visualization",
          label: "Free layer",
          moduleSource: "test",
          nodeId: "model:object:free-layer:visualization",
          objectId: "free-layer",
          ref: null,
        }),
      } as never,
      visualization,
    });

    expect(visualization.getSettings({ id: "object:free-layer", kind: "object" }))
      .toMatchObject({
        shaderColorMode: "monochrome",
        shaderMonoColor: "#336699",
        surfaceColorSource: "solid",
      });
  });

  it("resolves selected object vectors from the canonical global visualization state", async () => {
    const { context, invalidations, patches } = createVisualizationRibbonContext({
      layers: {
        vectors: {
          density: 512,
          domain: "full_domain",
          visible: true,
        },
      },
      vector_glyphs: true,
    });
    const selection = {
      kind: "object.visualization" as const,
      label: "Free layer",
      moduleSource: "test",
      nodeId: "model:object:free-layer:visualization",
      objectId: "free-layer",
      ref: null,
    };
    const content = buildRibbonTabContent("view", {
      ...context,
      selection,
    });
    const selectedGroup = content?.groups.find(
      (group) => group.id === "view-selected-display",
    );
    const textureAction = selectedGroup?.actions.find(
      (action) => action.id === "view-selected-texture",
    );
    const vectorNode = textureAction?.menu?.find(
      (node) => node.type === "checkbox" && node.id === "selected-texture:vectors",
    );
    const vectorScopeNode = textureAction?.menu?.find(
      (node) =>
        node.type === "radio-group" &&
        node.id === "selected-texture:vector-scope",
    );

    expect(vectorNode).toMatchObject({
      checked: true,
      commandId: "visualization.target.set-vectors-visible",
      disabled: false,
    });
    expect(vectorScopeNode).toMatchObject({
      disabled: false,
      value: "full",
    });
    if (vectorScopeNode?.type !== "radio-group") {
      throw new Error("Expected selected target vector scope control");
    }

    await runRibbonNode(vectorScopeNode, "surface", { ...context, selection });

    expect(patches).toEqual([
      {
        overrides: [
          {
            display: { geometry_scope: "surface" },
            scope: "object",
            scope_id: "free-layer",
          },
        ],
      },
    ]);
    await vi.waitFor(() =>
      expect(invalidations).toEqual([[VISUALIZATION_STATE_PATH, 41]]),
    );
  });

  it("patches selected target quantity through backend-owned overrides", async () => {
    const { context, invalidations, patches } =
      createVisualizationRibbonContext({
        active_quantity_id: "m",
        overrides: [],
        quantity: { active_quantity_id: "m" },
        revision: 7,
      });
    const selection = {
      kind: "object.visualization" as const,
      label: "Free layer",
      moduleSource: "test",
      nodeId: "model:object:free-layer:visualization",
      objectId: "free-layer",
      ref: null,
    };
    const content = buildRibbonTabContent("view", {
      ...context,
      selection,
    });
    const selectedGroup = content?.groups.find(
      (group) => group.id === "view-selected-display",
    );
    const textureAction = selectedGroup?.actions.find(
      (action) => action.id === "view-selected-texture",
    );
    const quantityNode = textureAction?.menu?.find(
      (node) =>
        node.type === "radio-group" && node.id === "selected-texture:quantity",
    );

    expect(quantityNode).toMatchObject({
      commandId: RIBBON_VISUALIZATION_PATCH_TARGET_COMMAND,
      value: "m",
    });
    if (quantityNode?.type !== "radio-group") {
      throw new Error("Expected selected target quantity control");
    }

    await runRibbonNode(quantityNode, "h_eff", { ...context, selection });

    expect(patches).toEqual([
      {
        overrides: [
          {
            quantity: { active_quantity_id: "H_eff" },
            scope: "object",
            scope_id: "free-layer",
          },
        ],
      },
    ]);
    await vi.waitFor(() =>
      expect(invalidations).toEqual([[VISUALIZATION_STATE_PATH, 41]]),
    );
  });

  it("switches selected scalar quantities to colormap surface coloring", async () => {
    const { context, invalidations, patches } =
      createVisualizationRibbonContext({
        active_quantity_id: "m",
        overrides: [],
        quantity: { active_quantity_id: "m" },
        revision: 7,
      });
    const selection = {
      kind: "object.visualization" as const,
      label: "Free layer",
      moduleSource: "test",
      nodeId: "model:object:free-layer:visualization",
      objectId: "free-layer",
      ref: null,
    };
    const content = buildRibbonTabContent("view", {
      ...context,
      selection,
    });
    const selectedGroup = content?.groups.find(
      (group) => group.id === "view-selected-display",
    );
    const textureAction = selectedGroup?.actions.find(
      (action) => action.id === "view-selected-texture",
    );
    const quantityNode = textureAction?.menu?.find(
      (node) =>
        node.type === "radio-group" && node.id === "selected-texture:quantity",
    );

    expect(quantityNode?.type === "radio-group" ? quantityNode.items : []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "torque" }),
        expect.objectContaining({ value: "eden_total" }),
      ]),
    );
    if (quantityNode?.type !== "radio-group") {
      throw new Error("Expected selected target quantity control");
    }

    await runRibbonNode(quantityNode, "eden_total", { ...context, selection });

    expect(patches).toEqual([
      {
        overrides: [
          {
            quantity: { active_quantity_id: "eden_total" },
            scope: "object",
            scope_id: "free-layer",
            style: { surface_color_source: "colormap" },
          },
        ],
      },
    ]);
    await vi.waitFor(() =>
      expect(invalidations).toEqual([[VISUALIZATION_STATE_PATH, 41]]),
    );
  });

  it("patches selected airbox quantity through backend-owned overrides", async () => {
    const { context, invalidations, patches } =
      createVisualizationRibbonContext({
        active_quantity_id: "m",
        overrides: [],
        quantity: { active_quantity_id: "m" },
        revision: 7,
      });
    const selection = {
      kind: "airbox.visualization" as const,
      label: "Airbox",
      moduleSource: "test",
      nodeId: "model:airbox:visualization",
      objectId: null,
      ref: null,
    };
    const content = buildRibbonTabContent("view", {
      ...context,
      selection,
    });
    const selectedGroup = content?.groups.find(
      (group) => group.id === "view-selected-display",
    );
    const textureAction = selectedGroup?.actions.find(
      (action) => action.id === "view-selected-texture",
    );
    const quantityNode = textureAction?.menu?.find(
      (node) =>
        node.type === "radio-group" && node.id === "selected-texture:quantity",
    );

    expect(quantityNode).toMatchObject({
      commandId: RIBBON_VISUALIZATION_PATCH_TARGET_COMMAND,
      value: "H_demag",
    });
    if (quantityNode?.type !== "radio-group") {
      throw new Error("Expected selected airbox quantity control");
    }

    await runRibbonNode(quantityNode, "h_eff", { ...context, selection });

    expect(patches).toEqual([
      {
        overrides: [
          {
            quantity: { active_quantity_id: "H_eff" },
            scope: "airbox",
            scope_id: "airbox",
          },
        ],
      },
    ]);
    await vi.waitFor(() =>
      expect(invalidations).toEqual([[VISUALIZATION_STATE_PATH, 41]]),
    );
  });

  it("patches selected region display controls through region-scoped overrides", async () => {
    const { context, invalidations, patches } = createVisualizationRibbonContext({
      overrides: [],
      quantity: { active_quantity_id: "m" },
      revision: 7,
    });
    const selection = {
      kind: "object.region.visualization" as const,
      label: "Core",
      moduleSource: "test",
      nodeId: "model:object:free-layer:regions:core:visualization",
      objectId: "free-layer",
      ref: {
        kind: "object.region.visualization" as const,
        nodeId: "model:object:free-layer:regions:core:visualization",
        objectId: "free-layer",
        regionId: "region:core",
        type: "scene-object" as const,
        visualizationTargetId: visualizationTargetIdForSceneObject(
          "free-layer",
          "region:core",
        ),
      },
    };
    context.visualization.patchTarget(
      {
        id: visualizationTargetIdForSceneObject("free-layer", "region:core"),
        kind: "region",
      },
      { visible: true },
    );
    context.visualizationSnapshot = context.visualization.getSnapshot();
    const content = buildRibbonTabContent("view", {
      ...context,
      selection,
    });
    const selectedGroup = content?.groups.find(
      (group) => group.id === "view-selected-display",
    );
    const renderAction = selectedGroup?.actions.find(
      (action) => action.id === "view-selected-render",
    );
    const wireframeNode = renderAction?.menu?.find(
      (node) => node.type === "checkbox" && node.id === "selected:wireframe",
    );

    expect(wireframeNode).toMatchObject({
      checked: false,
      commandId: "visualization.target.set-wireframe-visible",
      disabled: false,
    });
    if (wireframeNode?.type !== "checkbox") {
      throw new Error("Expected selected region wireframe control");
    }

    await runRibbonNode(wireframeNode, false, { ...context, selection });

    expect(patches).toEqual([
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
    await vi.waitFor(() =>
      expect(invalidations).toEqual([[VISUALIZATION_STATE_PATH, 41]]),
    );
  });

  it("resolves selected region coloring from owner object settings before region overrides", async () => {
    const { context, patches } = createVisualizationRibbonContext({
      overrides: [
        {
          scope: "object",
          scope_id: "free-layer",
          style: { surface_color_source: "component_y" },
        },
      ],
      quantity: { active_quantity_id: "m" },
      revision: 7,
    });
    const selection = {
      kind: "object.region.visualization" as const,
      label: "Core",
      moduleSource: "test",
      nodeId: "model:object:free-layer:regions:core:visualization",
      objectId: "free-layer",
      ref: {
        kind: "object.region.visualization" as const,
        nodeId: "model:object:free-layer:regions:core:visualization",
        objectId: "free-layer",
        regionId: "region:core",
        type: "scene-object" as const,
        visualizationTargetId: visualizationTargetIdForSceneObject(
          "free-layer",
          "region:core",
        ),
      },
    };
    context.visualization.patchTarget(
      {
        id: visualizationTargetIdForSceneObject("free-layer", "region:core"),
        kind: "region",
      },
      { visible: true },
    );
    context.visualizationSnapshot = context.visualization.getSnapshot();
    const content = buildRibbonTabContent("view", {
      ...context,
      selection,
    });
    const selectedGroup = content?.groups.find(
      (group) => group.id === "view-selected-display",
    );
    const textureAction = selectedGroup?.actions.find(
      (action) => action.id === "view-selected-texture",
    );
    const surfaceColoringNode = textureAction?.menu?.find(
      (node) =>
        node.type === "radio-group" &&
        node.id === "selected-texture:surface-coloring",
    );

    expect(surfaceColoringNode).toMatchObject({
      commandId: "visualization.target.set-surface-color-source",
      value: "inherit",
    });
    if (surfaceColoringNode?.type !== "radio-group") {
      throw new Error("Expected selected region surface color control");
    }

    await runRibbonNode(surfaceColoringNode, "component_x", {
      ...context,
      selection,
    });

    expect(patches).toEqual([
      {
        overrides: [
          {
            scope: "object",
            scope_id: "free-layer",
            style: {
              surface_color_source: "component_y",
            },
          },
          {
            scope: "region",
            scope_id: "region:free-layer:region%3Acore",
            style: {
              surface_color_source: "component_x",
            },
          },
        ],
      },
    ]);
  });

  it("patches selected region quantity through region-scoped overrides", async () => {
    const { context, invalidations, patches } = createVisualizationRibbonContext({
      overrides: [],
      quantity: { active_quantity_id: "m" },
      revision: 7,
    });
    const selection = {
      kind: "object.region.visualization" as const,
      label: "Core",
      moduleSource: "test",
      nodeId: "model:object:free-layer:regions:core:visualization",
      objectId: "free-layer",
      ref: {
        kind: "object.region.visualization" as const,
        nodeId: "model:object:free-layer:regions:core:visualization",
        objectId: "free-layer",
        regionId: "region:core",
        type: "scene-object" as const,
        visualizationTargetId: visualizationTargetIdForSceneObject(
          "free-layer",
          "region:core",
        ),
      },
    };
    const content = buildRibbonTabContent("view", {
      ...context,
      selection,
    });
    const selectedGroup = content?.groups.find(
      (group) => group.id === "view-selected-display",
    );
    const textureAction = selectedGroup?.actions.find(
      (action) => action.id === "view-selected-texture",
    );
    const quantityNode = textureAction?.menu?.find(
      (node) =>
        node.type === "radio-group" && node.id === "selected-texture:quantity",
    );

    expect(quantityNode).toMatchObject({
      commandId: RIBBON_VISUALIZATION_PATCH_TARGET_COMMAND,
      value: "m",
    });
    if (quantityNode?.type !== "radio-group") {
      throw new Error("Expected selected region quantity control");
    }

    await runRibbonNode(quantityNode, "h_demag", { ...context, selection });

    expect(patches).toEqual([
      {
        overrides: [
          {
            quantity: { active_quantity_id: "H_demag" },
            scope: "region",
            scope_id: "region:free-layer:region%3Acore",
          },
        ],
      },
    ]);
    await vi.waitFor(() =>
      expect(invalidations).toEqual([[VISUALIZATION_STATE_PATH, 41]]),
    );
  });

  it("keeps the explicit ribbon target command backed by visualization overrides", async () => {
    const { context, invalidations, patches } = createVisualizationRibbonContext({
      overrides: [],
      revision: 7,
    });

    const result = await context.commands.execute(
      RIBBON_VISUALIZATION_PATCH_TARGET_COMMAND,
      context.commandContext as CommandContext,
      visualizationTargetCommandInput(
        { id: "free-layer", kind: "object", label: "Free layer" },
        { vectorsVisible: false },
      ),
    );

    expect(result).toMatchObject({ status: "completed" });
    expect(patches).toEqual([
      {
        overrides: [
          {
            display: { vectors: { visible: false } },
            scope: "object",
            scope_id: "free-layer",
          },
        ],
      },
    ]);
    expect(invalidations).toEqual([[VISUALIZATION_STATE_PATH, 41]]);
  });

  it("routes physics interaction choices through the command registry", async () => {
    const content = buildRibbonTabContent("physics", {
      commands: createRibbonCommandRegistry(),
      selection: {
        kind: "object.physics",
        label: "Free layer physics",
        moduleSource: "test",
        nodeId: "model:object:free-layer:physics",
        objectId: "free-layer",
        ref: null,
      },
      visualization: new ObjectVisualizationController(),
      visualizationSnapshot: new ObjectVisualizationController().getSnapshot(),
    });
    const coreGroup = content?.groups.find((group) => group.id === "physics-core");
    const interactionAction = coreGroup?.actions.find(
      (action) => action.id === "physics-interactions",
    );
    const interactionItems = interactionAction?.menu?.filter(
      (node) => node.type === "item" && node.commandId === RIBBON_PHYSICS_SELECT_INTERACTION_COMMAND,
    );

    expect(interactionItems?.map((node) => node.type === "item" ? node.commandInput : null)).toEqual([
      { interactionId: "exchange" },
      { interactionId: "demag" },
      { interactionId: "zeeman" },
      { interactionId: "current_transport" },
      { interactionId: "spin_torque" },
      { interactionId: "interfacial_dmi" },
      { interactionId: "bulk_dmi" },
      { interactionId: "uniaxial_anisotropy" },
      { interactionId: "cubic_anisotropy" },
      { interactionId: "oersted_field" },
      { interactionId: "magnetoelastic" },
    ]);

    const registry = createRibbonCommandRegistry();
    const selections: unknown[] = [];
    const result = await registry.execute(
      RIBBON_PHYSICS_SELECT_INTERACTION_COMMAND,
      {
        selection: {
          get: () => ({
            kind: "object.physics",
            label: "Free layer physics",
            moduleSource: "test",
            nodeId: "model:object:free-layer:physics",
            objectId: "free-layer",
            ref: null,
          }),
          set: (selection: unknown) => selections.push(selection),
        } as never,
        source: "test",
      },
      { interactionId: "oersted_field" },
    );

    expect(result).toEqual({ status: "completed" });
    expect(selections).toEqual([
      expect.objectContaining({
        kind: "object.physics",
        label: "Regional field source",
        nodeId: "model:object:free-layer:physics:oersted_field",
        objectId: "free-layer",
      }),
    ]);
  });

  it("keeps unsupported Physics shell workflows disabled", () => {
    const unsupportedIds = new Set([
      "physics-add-dmi",
      "physics-add-ku",
      "physics-global",
      "manage-rf",
      "add-cpw",
    ]);
    const matchedIds = new Set<string>();

    for (const group of ALL_TAB_CONTENT.physics.groups) {
      for (const action of group.actions) {
        if (unsupportedIds.has(action.id)) {
          matchedIds.add(action.id);
          expect(action.disabled, action.id).toBe(true);
        }
      }
    }
    expect(matchedIds).toEqual(unsupportedIds);
  });

  it("wires Physics Microstrip to the geometry antenna command", () => {
    const rfGroup = ALL_TAB_CONTENT.physics.groups.find(
      (group) => group.id === "rf-sources",
    );

    const microstripAction = rfGroup?.actions.find(
      (action) => action.id === "add-microstrip",
    );

    expect(microstripAction).toMatchObject({
      commandId: "geometry.add-microstrip-antenna",
    });
    expect(microstripAction?.disabled).not.toBe(true);
  });

  it("wires global Surface and Texture ribbon menus to object and part display defaults", async () => {
    const visualization = new ObjectVisualizationController();
    const content = buildRibbonTabContent("view", {
      commandContext: { source: "test", visualization },
      commands: createRibbonCommandRegistry(),
      selection: {
        kind: null,
        label: null,
        moduleSource: null,
        nodeId: null,
        objectId: null,
        ref: null,
      },
      sessionStatus: {
        resources: { field_revision: 12, fields_revision: 12 },
      } as never,
      visualization,
      visualizationSnapshot: visualization.getSnapshot(),
    });
    const globalGroup = content?.groups.find(
      (group) => group.id === "view-global-display",
    );
    const surfaceAction = globalGroup?.actions.find(
      (action) => action.id === "view-surface",
    );
    const textureAction = globalGroup?.actions.find(
      (action) => action.id === "view-texture",
    );
    const surfaceVisibleNode = surfaceAction?.menu?.find(
      (node) => node.type === "checkbox" && node.id === "surface:visible",
    );
    const textureSourceNode = textureAction?.menu?.find(
      (node) => node.type === "radio-group" && node.id === "texture:source",
    );
    const textureStatusNode = textureAction?.menu?.find(
      (node) => node.type === "status" && node.id === "texture:field-status",
    );

    expect(surfaceVisibleNode).toMatchObject({ checked: true });
    expect(textureSourceNode).toMatchObject({ value: "orientation" });
    expect(textureStatusNode).toMatchObject({
      tone: "success",
      value: "available r12",
    });
    if (
      surfaceVisibleNode?.type !== "checkbox" ||
      textureSourceNode?.type !== "radio-group"
    ) {
      throw new Error("Expected global surface and texture controls");
    }

    const commandContext = { visualization };
    await runRibbonNode(surfaceVisibleNode, false, commandContext);
    await runRibbonNode(textureSourceNode, "component_y", commandContext);

    expect(visualization.getSettings({ id: "free-layer", kind: "object" }))
      .toMatchObject({
        shaderColorMode: "y",
        shaderVisible: false,
        surfaceColorSource: "component_y",
      });
    expect(visualization.getSettings({ id: "part-a", kind: "part" }))
      .toMatchObject({
        shaderColorMode: "y",
        shaderVisible: false,
        surfaceColorSource: "component_y",
      });
  });

  it("persists selected airbox vector style separately from display state", async () => {
    const { context, invalidations, patches } =
      createVisualizationRibbonContext({
        layers: {
          airbox: {
            opacity: 0.28,
            points: { opacity: 1, visible: true },
            surface: { opacity: 1, visible: false },
            vectors: { density: 128, domain: "airbox_only", visible: true },
            visible: true,
            wireframe: { opacity: 1, visible: true },
          },
        },
        revision: 7,
      });
    const selection = {
      kind: "airbox.visualization" as const,
      label: "Airbox Visualization",
      moduleSource: "test",
      nodeId: "model:airbox:visualization",
      objectId: null,
      ref: null,
    };
    const content = buildRibbonTabContent("view", {
      ...context,
      selection,
    });
    const selectedGroup = content?.groups.find(
      (group) => group.id === "view-selected-display",
    );
    const textureAction = selectedGroup?.actions.find(
      (action) => action.id === "view-selected-texture",
    );
    const renderAction = selectedGroup?.actions.find(
      (action) => action.id === "view-selected-render",
    );
    const surfaceColoringNode = textureAction?.menu?.find(
      (node) =>
        node.type === "radio-group" &&
        node.id === "selected-texture:surface-coloring",
    );
    const vectorThicknessNode = textureAction?.menu?.find(
      (node) =>
        node.type === "slider" &&
        node.id === "selected-texture:vector-thickness",
    );
    const wireframeColorNode = renderAction?.menu?.find(
      (node) => node.type === "color" && node.id === "selected:wireframe-color",
    );
    const pointColorNode = renderAction?.menu?.find(
      (node) => node.type === "color" && node.id === "selected:point-color",
    );
    const visibleNode = renderAction?.menu?.find(
      (node) => node.type === "checkbox" && node.id === "selected:visible",
    );

    expect(surfaceColoringNode).toBeUndefined();
    expect(vectorThicknessNode).toMatchObject({ disabled: false, value: 1 });
    expect(wireframeColorNode).toMatchObject({
      disabled: false,
      value: "var(--fm-airbox-wire)",
    });
    expect(pointColorNode).toMatchObject({
      disabled: false,
      value: "var(--fm-info)",
    });

    if (
      vectorThicknessNode?.type !== "slider" ||
      wireframeColorNode?.type !== "color" ||
      pointColorNode?.type !== "color" ||
      visibleNode?.type !== "checkbox"
    ) {
      throw new Error("Expected selected airbox style controls");
    }

    const commandContext = { ...context, selection };
    await runRibbonNode(vectorThicknessNode, 2.4, commandContext);
    await runRibbonNode(wireframeColorNode, "#ffffff", commandContext);
    await runRibbonNode(pointColorNode, "#66eeff", commandContext);
    await runRibbonNode(visibleNode, false, commandContext);

    expect(patches).toHaveLength(4);
    expect(patches).toMatchObject([
      { overrides: [{ style: { vector_thickness: 2.4 } }] },
      { overrides: [{ style: { wireframe_color: "#ffffff" } }] },
      { overrides: [{ style: { point_color: "#66eeff" } }] },
      { layers: { airbox: { visible: false } } },
    ]);
    await vi.waitFor(() =>
      expect(invalidations).toEqual([
        [VISUALIZATION_STATE_PATH, 41],
        [VISUALIZATION_STATE_PATH, 42],
        [VISUALIZATION_STATE_PATH, 43],
        [VISUALIZATION_STATE_PATH, 44],
      ]),
    );
  });

  it("keeps mixed local airbox controls out of pending backend overlays", async () => {
    const { context, patches } = createVisualizationRibbonContext({ revision: 7 });
    const result = await context.commands.execute(
      RIBBON_VISUALIZATION_PATCH_TARGET_COMMAND,
      context.commandContext,
      visualizationTargetCommandInput(AIRBOX_VISUALIZATION_TARGET, {
        vectorCenteringEnabled: false,
        visible: false,
      }),
    );

    expect(result).toMatchObject({ status: "completed" });
    expect(context.visualization.getSnapshot()).toMatchObject({
      pendingOverrides: {
        airbox: { baseRevision: 7, patch: { visible: false } },
      },
      viewportPreferences: {
        airbox: { vectorCenteringEnabled: false },
      },
    });
    expect(patches).toMatchObject([{ layers: { airbox: { visible: false } } }]);
    expect(JSON.stringify(patches)).not.toContain("vectorCenteringEnabled");
  });

  it("wires the global Airbox ribbon menu to the airbox visualization target", async () => {
    const visualization = new ObjectVisualizationController();
    const content = buildRibbonTabContent("view", {
      commandContext: { source: "test", visualization },
      commands: createRibbonCommandRegistry(),
      selection: {
        kind: null,
        label: null,
        moduleSource: null,
        nodeId: null,
        objectId: null,
        ref: null,
      },
      visualization,
      visualizationSnapshot: visualization.getSnapshot(),
    });
    const airboxAction = content?.groups
      .find((group) => group.id === "view-global-display")
      ?.actions.find((action) => action.id === "view-airbox");
    const visibleNode = airboxAction?.menu?.find(
      (node) => node.type === "checkbox" && node.id === "airbox:visible",
    );
    const vectorsNode = airboxAction?.menu?.find(
      (node) => node.type === "checkbox" && node.id === "airbox:vectors",
    );

    expect(airboxAction?.disabled).toBe(false);
    expect(visibleNode).toMatchObject({
      checked: true,
      disabled: false,
    });
    expect(vectorsNode).toMatchObject({
      checked: false,
      disabled: false,
    });

    if (visibleNode?.type !== "checkbox" || vectorsNode?.type !== "checkbox") {
      throw new Error("Expected airbox checkbox controls");
    }

    await runRibbonNode(visibleNode, false, { visualization });
    await runRibbonNode(vectorsNode, true, { visualization });

    expect(visualization.getSettings(AIRBOX_VISUALIZATION_TARGET)).toMatchObject({
      vectorsVisible: true,
      visible: false,
    });
  });

  it("patches canonical visualization state from global Airbox controls", async () => {
    const { context, invalidations, patches } =
      createVisualizationRibbonContext({
        layers: {
          airbox: {
            points: { opacity: 1, visible: false },
            surface: { opacity: 0.28, visible: false },
            vectors: { density: 128, domain: "airbox_only", visible: false },
            visible: true,
            wireframe: { opacity: 1, visible: true },
          },
        },
        revision: 7,
      });
    const content = buildRibbonTabContent("view", context);
    const airboxAction = content?.groups
      .find((group) => group.id === "view-global-display")
      ?.actions.find((action) => action.id === "view-airbox");
    const visibleNode = airboxAction?.menu?.find(
      (node) => node.type === "checkbox" && node.id === "airbox:visible",
    );
    const vectorsNode = airboxAction?.menu?.find(
      (node) => node.type === "checkbox" && node.id === "airbox:vectors",
    );
    const extentNode = airboxAction?.menu?.find(
      (node) => node.type === "radio-group" && node.id === "airbox:extent",
    );
    const renderModeNode = airboxAction?.menu?.find(
      (node) => node.type === "radio-group" && node.id === "airbox:render-mode",
    );

    expect(visibleNode).toMatchObject({ checked: true });
    expect(vectorsNode).toMatchObject({ checked: false });
    expect(extentNode).toMatchObject({
      disabled: false,
      value: "full",
    });
    expect(renderModeNode).toMatchObject({
      disabled: false,
      value: "wireframe",
    });
    expect(airboxAction?.menu?.some((node) =>
      [
        "airbox:shaded",
        "airbox:wireframe",
        "airbox:frame",
        "airbox:points",
        "airbox:wireframe-scope",
        "airbox:points-scope",
        "airbox:vectors-scope",
      ].includes(node.id)
    )).toBe(false);
    if (
      visibleNode?.type !== "checkbox" ||
      vectorsNode?.type !== "checkbox" ||
      extentNode?.type !== "radio-group" ||
      renderModeNode?.type !== "radio-group"
    ) {
      throw new Error("Expected airbox display controls");
    }

    await runRibbonNode(extentNode, "surface", context);
    await runRibbonNode(visibleNode, false, context);
    await runRibbonNode(vectorsNode, true, context);

    expect(patches).toMatchObject([
      {
        overrides: [
          {
            display: {
              geometry_scope: "surface",
            },
            scope: "airbox",
            scope_id: "airbox",
          },
        ],
      },
      {
        layers: {
          airbox: {
            visible: false,
          },
        },
      },
      {
        layers: {
          airbox: {
            vectors: {
              domain: "airbox_only",
              visible: true,
            },
          },
        },
      },
    ]);
    await vi.waitFor(() =>
      expect(invalidations).toEqual([
        [VISUALIZATION_STATE_PATH, 41],
        [VISUALIZATION_STATE_PATH, 42],
        [VISUALIZATION_STATE_PATH, 43],
      ]),
    );
  });

  it("resets airbox layers and removes its override through the ribbon command", async () => {
    const { context, patches } = createVisualizationRibbonContext({
      overrides: [
        {
          scope: "airbox",
          scope_id: "airbox",
          quantity: { active_quantity_id: "H_eff" },
          style: { vector_alpha: 0.4 },
        },
        {
          scope: "object",
          scope_id: "film",
          quantity: { active_quantity_id: "m" },
        },
      ],
      revision: 7,
    });
    const content = buildRibbonTabContent("view", context);
    const airboxAction = content?.groups
      .find((group) => group.id === "view-global-display")
      ?.actions.find((action) => action.id === "view-airbox");
    const resetNode = airboxAction?.menu?.find(
      (node) => node.type === "item" && node.id === "airbox:reset",
    );

    expect(resetNode).toMatchObject({
      commandId: RIBBON_VISUALIZATION_RESET_AIRBOX_COMMAND,
    });
    if (resetNode?.type !== "item") {
      throw new Error("Expected airbox reset control");
    }

    await runRibbonNode(resetNode, undefined, context.commandContext);

    expect(patches).toEqual([
      {
        layers: {
          airbox: {
            bounds: { opacity: 1, visible: false },
            points: { opacity: 1, visible: false },
            surface: { opacity: 0.28, visible: false },
            vectors: { density: 1200, domain: "airbox_only", visible: false },
            visible: true,
            wireframe: { opacity: 1, visible: false },
          },
        },
        overrides: [
          {
            scope: "object",
            scope_id: "film",
            quantity: { active_quantity_id: "m" },
          },
        ],
      },
    ]);
  });

  it("patches airbox vector controls through canonical visualization state", async () => {
    const { context, patches } = createVisualizationRibbonContext({
      layers: {
        airbox: {
          opacity: 0.28,
          points: { opacity: 1, visible: false },
          surface: { opacity: 1, visible: false },
          vectors: { density: 128, domain: "airbox_only", visible: true },
          visible: true,
          wireframe: { opacity: 1, visible: true },
        },
      },
      vector_style: {
        alpha: 0.9,
        color_mode: "orientation",
        length_scale: 1,
        thickness: 1,
      },
      overrides: [
        {
          scope: "airbox",
          scope_id: "airbox",
          style: {
            vector_length_scale: 1.8,
            vector_thickness: 1.2,
          },
        },
      ],
    });
    const content = buildRibbonTabContent("view", context);
    const airboxAction = content?.groups
      .find((group) => group.id === "view-global-display")
      ?.actions.find((action) => action.id === "view-airbox");
    const extentNode = airboxAction?.menu?.find(
      (node) => node.type === "radio-group" && node.id === "airbox:extent",
    );
    const vectorSizeNode = airboxAction?.menu?.find(
      (node) => node.type === "submenu" && node.id === "airbox:vectors-submenu",
    );
    const vectorColorsNode = airboxAction?.menu?.find(
      (node) => node.type === "submenu" && node.id === "airbox:vector-colors",
    );

    if (vectorSizeNode?.type !== "submenu" || vectorColorsNode?.type !== "submenu") {
      throw new Error("Expected airbox vector submenus");
    }

    const densityNode = vectorSizeNode.nodes.find(
      (node) => node.type === "slider" && node.id === "airbox:vectors-density",
    );
    const lengthNode = vectorSizeNode.nodes.find(
      (node) => node.type === "slider" && node.id === "airbox:vectors-length",
    );
    const thicknessNode = vectorSizeNode.nodes.find(
      (node) => node.type === "slider" && node.id === "airbox:vectors-thickness",
    );
    const coloringNode = vectorColorsNode.nodes.find(
      (node) => node.type === "radio-group" && node.id === "airbox:vector-coloring",
    );

    expect(densityNode).toMatchObject({ value: 128 });
    expect(extentNode).toMatchObject({ disabled: false, value: "full" });
    expect(lengthNode).toMatchObject({ value: 1.8 });
    expect(thicknessNode).toMatchObject({ value: 1.2 });
    expect(coloringNode).toMatchObject({ value: "orientation" });

    if (
      densityNode?.type !== "slider" ||
      lengthNode?.type !== "slider" ||
      extentNode?.type !== "radio-group" ||
      thicknessNode?.type !== "slider" ||
      coloringNode?.type !== "radio-group"
    ) {
      throw new Error("Expected airbox vector controls");
    }

    await runRibbonNode(extentNode, "surface", context);
    await runRibbonNode(densityNode, 256, context);
    await runRibbonNode(lengthNode, 2.4, context);
    await runRibbonNode(thicknessNode, 1.6, context);
    await runRibbonNode(coloringNode, "x", context);

    expect(patches).toHaveLength(5);
    expect(patches[0]).toMatchObject({
      overrides: [
        {
          display: {
            geometry_scope: "surface",
          },
          scope: "airbox",
          scope_id: "airbox",
        },
      ],
    });
    expect(patches[1]).toMatchObject({
      layers: {
        airbox: {
          vectors: {
            density: 256,
            domain: "airbox_only",
          },
        },
      },
    });
    expect(patches[2]).toMatchObject({
      overrides: [
        {
          scope: "airbox",
          scope_id: "airbox",
          style: {
            vector_length_scale: 2.4,
            vector_thickness: 1.2,
          },
        },
      ],
    });
    expect(patches[2]).not.toHaveProperty("vector_style");
    expect(patches[3]).toMatchObject({
      overrides: [
        {
          scope: "airbox",
          scope_id: "airbox",
          style: {
            vector_length_scale: 1.8,
            vector_thickness: 1.6,
          },
        },
      ],
    });
    expect(patches[3]).not.toHaveProperty("vector_style");
    expect(patches[4]).toMatchObject({
      overrides: [
        {
          scope: "airbox",
          scope_id: "airbox",
          style: { vector_color_mode: "x" },
        },
      ],
    });
  });

  it("keeps selected airbox display controls synchronized with canonical state", async () => {
    const { context, invalidations, patches } =
      createVisualizationRibbonContext({
        layers: {
          airbox: {
            opacity: 0.28,
            points: { opacity: 1, visible: false },
            surface: { opacity: 1, visible: false },
            vectors: { density: 128, domain: "airbox_only", visible: false },
            visible: false,
            wireframe: { opacity: 1, visible: true },
          },
        },
        revision: 7,
      });
    const selection = {
      kind: "airbox.visualization" as const,
      label: "Airbox Visualization",
      moduleSource: "test",
      nodeId: "model:airbox:visualization",
      objectId: null,
      ref: null,
    };
    const content = buildRibbonTabContent("view", {
      ...context,
      selection,
    });
    const selectedGroup = content?.groups.find(
      (group) => group.id === "view-selected-display",
    );
    const renderAction = selectedGroup?.actions.find(
      (action) => action.id === "view-selected-render",
    );
    const visibleNode = renderAction?.menu?.find(
      (node) => node.type === "checkbox" && node.id === "selected:visible",
    );
    const renderModeNode = renderAction?.menu?.find(
      (node) => node.type === "radio-group" && node.id === "selected:render-mode",
    );

    expect(visibleNode).toMatchObject({ checked: false });
    expect(renderModeNode).toMatchObject({
      value: "wireframe",
      disabled: true,
    });
    expect(renderAction?.menu?.some((node) =>
      ["selected:frame", "selected:wireframe", "selected:points"].includes(node.id)
    )).toBe(false);

    if (
      visibleNode?.type !== "checkbox" ||
      renderModeNode?.type !== "radio-group"
    ) {
      throw new Error("Expected selected airbox display controls");
    }

    const commandContext = { ...context, selection };
    await runRibbonNode(visibleNode, true, commandContext);

    expect(patches).toMatchObject([
      {
        layers: {
          airbox: {
            visible: true,
          },
        },
      },
    ]);
    expect(context.visualization.getSettings(AIRBOX_VISUALIZATION_TARGET))
      .toMatchObject({ boundsVisible: false });
    await vi.waitFor(() =>
      expect(invalidations).toEqual([[VISUALIZATION_STATE_PATH, 41]]),
    );
  });

  it("shows hidden airbox pass controls as inactive in the global View menu", () => {
    const { context } = createVisualizationRibbonContext({
      layers: {
        airbox: {
          opacity: 0.28,
          points: { opacity: 1, visible: true },
          surface: { opacity: 1, visible: true },
          vectors: { density: 128, domain: "airbox_only", visible: true },
          visible: false,
          wireframe: { opacity: 1, visible: true },
        },
      },
    });
    const content = buildRibbonTabContent("view", context);
    const airboxAction = content?.groups
      .find((group) => group.id === "view-global-display")
      ?.actions.find((action) => action.id === "view-airbox");
    const visibleNode = airboxAction?.menu?.find(
      (node) => node.type === "checkbox" && node.id === "airbox:visible",
    );
    const renderModeNode = airboxAction?.menu?.find(
      (node) => node.type === "radio-group" && node.id === "airbox:render-mode",
    );
    const vectorsNode = airboxAction?.menu?.find(
      (node) => node.type === "checkbox" && node.id === "airbox:vectors",
    );

    expect(visibleNode).toMatchObject({ checked: false, disabled: false });
    expect(renderModeNode).toMatchObject({ value: "points", disabled: true });
    expect(vectorsNode).toMatchObject({ checked: false, disabled: true });
  });

  it("wires the global Frame ribbon menu to object and part display defaults", async () => {
    const visualization = new ObjectVisualizationController();
    const content = buildRibbonTabContent("view", {
      commandContext: { source: "test", visualization },
      commands: createRibbonCommandRegistry(),
      selection: {
        kind: null,
        label: null,
        moduleSource: null,
        nodeId: null,
        objectId: null,
        ref: null,
      },
      visualization,
      visualizationSnapshot: visualization.getSnapshot(),
    });
    const frameAction = content?.groups
      .find((group) => group.id === "view-display")
      ?.actions.find((action) => action.id === "view-dimension-frame");
    const frameNode = frameAction?.menu?.find(
      (node) => node.type === "checkbox" && node.id === "frame:object-bounds",
    );
    const dimensionModeNode = frameAction?.menu?.find(
      (node) => node.type === "radio-group" && node.id === "frame:dimension-mode",
    );
    const gridDensityNode = frameAction?.menu?.find(
      (node) => node.type === "radio-group" && node.id === "frame:grid-density",
    );
    const scaleLabelsNode = frameAction?.menu?.find(
      (node) => node.type === "checkbox" && node.id === "frame:scale-labels",
    );
    const scaleUnitNode = frameAction?.menu?.find(
      (node) => node.type === "radio-group" && node.id === "frame:scale-unit",
    );

    expect(frameAction).toMatchObject({
      id: "view-dimension-frame",
      label: "Frame",
    });
    expect(dimensionModeNode).toMatchObject({
      value: "floor",
      items: [
        expect.objectContaining({
          commandId: "viewport-3d.dimension-frame-floor",
          value: "floor",
        }),
        expect.objectContaining({
          commandId: "viewport-3d.dimension-frame-cage",
          value: "cage",
        }),
        expect.objectContaining({
          commandId: "viewport-3d.dimension-frame-off",
          value: "off",
        }),
      ],
    });
    expect(gridDensityNode).toMatchObject({
      value: "auto",
      items: [
        expect.objectContaining({
          commandId: "viewport-3d.dimension-density-auto",
          value: "auto",
        }),
        expect.objectContaining({
          commandId: "viewport-3d.dimension-density-coarse",
          value: "coarse",
        }),
        expect.objectContaining({
          commandId: "viewport-3d.dimension-density-fine",
          value: "fine",
        }),
      ],
    });
    expect(scaleLabelsNode).toMatchObject({
      checked: true,
      commandId: "viewport-3d.scale-labels-toggle",
    });
    expect(scaleUnitNode).toMatchObject({
      value: "auto",
      items: [
        expect.objectContaining({
          commandId: "viewport-3d.scale-unit-auto",
          value: "auto",
        }),
        expect.objectContaining({
          commandId: "viewport-3d.scale-unit-nm",
          value: "nm",
        }),
        expect.objectContaining({
          commandId: "viewport-3d.scale-unit-um",
          value: "um",
        }),
        expect.objectContaining({
          commandId: "viewport-3d.scale-unit-mm",
          value: "mm",
        }),
        expect.objectContaining({
          commandId: "viewport-3d.scale-unit-m",
          value: "m",
        }),
      ],
    });

    expect(frameNode).toMatchObject({
      checked: false,
      disabled: false,
    });

    if (frameNode?.type !== "checkbox") {
      throw new Error("Expected object frame checkbox control");
    }

    await runRibbonNode(frameNode, true, { visualization });

    expect(visualization.getSettings({ id: "free-layer", kind: "object" }))
      .toMatchObject({ boundsVisible: true });
    expect(visualization.getSettings({ id: "part-a", kind: "part" }))
      .toMatchObject({ boundsVisible: true });
  });

  it("focuses the airbox ribbon action by selecting the airbox visualization node", async () => {
    const selectionSet = vi.fn();
    const content = buildRibbonTabContent("view", {
      commandContext: {
        selection: { set: selectionSet } as never,
        source: "ribbon",
      },
      commands: createRibbonCommandRegistry(),
      selection: {
        kind: null,
        label: null,
        moduleSource: null,
        nodeId: null,
        objectId: null,
        ref: null,
      },
      visualization: new ObjectVisualizationController(),
      visualizationSnapshot: new ObjectVisualizationController().getSnapshot(),
    });
    const airboxAction = content?.groups
      .find((group) => group.id === "view-global-display")
      ?.actions.find((action) => action.id === "view-airbox");
    const focusNode = airboxAction?.menu?.find(
      (node) => node.type === "item" && node.id === "airbox:focus",
    );

    expect(focusNode).toMatchObject({ disabled: false });
    if (focusNode?.type !== "item") {
      throw new Error("Expected airbox focus menu item");
    }

    await runRibbonNode(focusNode, undefined, {
      selection: { set: selectionSet } as never,
      source: "ribbon",
    });

    expect(selectionSet).toHaveBeenCalledWith(
      {
        kind: "airbox.visualization",
        label: "Airbox Visualization",
        nodeId: "model:airbox:visualization",
        objectId: null,
      },
      "ribbon",
    );
  });

  it("patches canonical visualization state from global Quantity controls", async () => {
    const { context, invalidations, patches } =
      createVisualizationRibbonContext({
        active_quantity_id: "m",
        layers: {
          quantity_overlay: { visible: true },
        },
        quantity: {
          active_quantity_id: "m",
          auto_contrast: true,
          colormap: "viridis",
          field_component: "magnitude",
        },
        revision: 7,
      });
    const content = buildRibbonTabContent("view", context);
    const quantityAction = content?.groups
      .find((group) => group.id === "view-global-display")
      ?.actions.find((action) => action.id === "view-quantity");
    const sourceNode = quantityAction?.menu?.find(
      (node) => node.type === "radio-group" && node.id === "quantity:source",
    );
    const overlayNode = quantityAction?.menu?.find(
      (node) => node.type === "checkbox" && node.id === "quantity:overlay-visible",
    );

    expect(sourceNode).toMatchObject({ value: "m" });
    expect(overlayNode).toMatchObject({ checked: true });
    if (sourceNode?.type !== "radio-group" || overlayNode?.type !== "checkbox") {
      throw new Error("Expected quantity source and overlay controls");
    }

    await runRibbonNode(sourceNode, "H_demag", context);
    await runRibbonNode(overlayNode, false, context);

    expect(patches).toEqual([
      {
        active_quantity_id: "H_demag",
        quantity: { active_quantity_id: "H_demag" },
      },
      {
        layers: { quantity_overlay: { visible: false } },
      },
    ]);
    await vi.waitFor(() =>
      expect(invalidations).toEqual([
        [VISUALIZATION_STATE_PATH, 41],
        [VISUALIZATION_STATE_PATH, 42],
      ]),
    );
  });

  it("patches canonical visualization state from Results quantity shortcuts", async () => {
    const { context, invalidations, patches } =
      createVisualizationRibbonContext({
        active_quantity_id: "m",
        quantity: { active_quantity_id: "m" },
        revision: 7,
      });
    const content = buildRibbonTabContent("results", context);
    const quantityGroup = content?.groups.find((group) => group.id === "quantity");
    const hEffAction = quantityGroup?.actions.find(
      (action) => action.id === "res-heff",
    );
    const energyAction = quantityGroup?.actions.find(
      (action) => action.id === "res-energy",
    );
    const mAction = quantityGroup?.actions.find((action) => action.id === "res-m");
    const sourceNode = mAction?.menu?.find(
      (node) => node.type === "radio-group" && node.id === "results-quantity:radio",
    );

    expect(hEffAction).toMatchObject({
      active: false,
      commandId: RIBBON_VISUALIZATION_APPLY_GLOBAL_QUANTITY_COMMAND,
    });
    expect(energyAction).toMatchObject({
      active: false,
      commandId: RIBBON_VISUALIZATION_APPLY_GLOBAL_QUANTITY_COMMAND,
    });
    expect(sourceNode).toMatchObject({
      commandId: RIBBON_VISUALIZATION_APPLY_GLOBAL_QUANTITY_COMMAND,
      value: "m",
    });
    expect(sourceNode?.type === "radio-group" ? sourceNode.items : []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "torque" }),
        expect.objectContaining({ value: "eden_total" }),
      ]),
    );
    if (
      !hEffAction?.commandId ||
      !energyAction?.commandId ||
      sourceNode?.type !== "radio-group"
    ) {
      throw new Error("Expected Results quantity controls");
    }

    await createRibbonCommandRegistry().execute(hEffAction.commandId, {
      ...context,
      input:
        typeof hEffAction.commandInput === "function"
          ? hEffAction.commandInput(undefined)
          : hEffAction.commandInput,
      source: "ribbon",
    } as unknown as CommandContext);
    await createRibbonCommandRegistry().execute(energyAction.commandId, {
      ...context,
      input:
        typeof energyAction.commandInput === "function"
          ? energyAction.commandInput(undefined)
          : energyAction.commandInput,
      source: "ribbon",
    } as unknown as CommandContext);
    await runRibbonNode(sourceNode, "H_demag", context);

    expect(patches).toEqual([
      {
        active_quantity_id: "H_eff",
        quantity: { active_quantity_id: "H_eff" },
      },
      {
        active_quantity_id: "eden_total",
        quantity: { active_quantity_id: "eden_total" },
      },
      {
        active_quantity_id: "H_demag",
        quantity: { active_quantity_id: "H_demag" },
      },
    ]);
    await vi.waitFor(() =>
      expect(invalidations).toEqual([
        [VISUALIZATION_STATE_PATH, 41],
        [VISUALIZATION_STATE_PATH, 42],
        [VISUALIZATION_STATE_PATH, 43],
      ]),
    );
  });

  it("flushes global Quantity changes immediately through visualization sync", async () => {
    const { context, patches } = createVisualizationRibbonContext({
      active_quantity_id: "m",
      quantity: {
        active_quantity_id: "m",
        auto_contrast: true,
        colormap: "viridis",
        field_component: "magnitude",
      },
      revision: 7,
    });
    const queuedPatches: VisualizationStatePatch[] = [];
    const flushNow = vi.fn(async () => undefined);
    const content = buildRibbonTabContent("view", context);
    const quantityAction = content?.groups
      .find((group) => group.id === "view-global-display")
      ?.actions.find((action) => action.id === "view-quantity");
    const sourceNode = quantityAction?.menu?.find(
      (node) => node.type === "radio-group" && node.id === "quantity:source",
    );

    if (sourceNode?.type !== "radio-group") {
      throw new Error("Expected quantity source control");
    }

    await runRibbonNode(sourceNode, "H_eff", {
      ...context,
      visualizationSync: {
        flushNow,
        queuePatch: (patch: VisualizationStatePatch) => {
          queuedPatches.push(patch);
        },
      } as never,
    });

    expect(queuedPatches).toEqual([
      {
        active_quantity_id: "H_eff",
        quantity: { active_quantity_id: "H_eff" },
      },
    ]);
    expect(flushNow).toHaveBeenCalledTimes(1);
    expect(patches).toEqual([]);
  });

  it("does not mark canonical-equivalent target quantities as mixed", () => {
    const { context } =
      createVisualizationRibbonContext({
        active_quantity_id: "H_eff",
        overrides: [
          {
            scope: "object",
            scope_id: "free-layer",
            quantity: { active_quantity_id: "h_eff" },
          },
        ],
        quantity: {
          active_quantity_id: "H_eff",
          auto_contrast: true,
          colormap: "viridis",
          field_component: "magnitude",
        },
        revision: 7,
      });
    const content = buildRibbonTabContent("view", context);
    const quantityAction = content?.groups
      .find((group) => group.id === "view-global-display")
      ?.actions.find((action) => action.id === "view-quantity");
    const mixedNode = quantityAction?.menu?.find(
      (node) => node.type === "status" && node.id === "quantity:mixed-targets",
    );

    expect(quantityAction?.iconColor).toBe("text-sky-300");
    expect(mixedNode).toBeUndefined();
  });

  it("canonicalizes selected target quantity radio values", () => {
    const { context } =
      createVisualizationRibbonContext({
        active_quantity_id: "H_eff",
        overrides: [
          {
            scope: "object",
            scope_id: "free-layer",
            quantity: { active_quantity_id: "h_eff" },
          },
        ],
        quantity: { active_quantity_id: "H_eff" },
        revision: 7,
      });
    const selection = {
      kind: "object.visualization" as const,
      label: "Free layer",
      moduleSource: "test",
      nodeId: "model:object:free-layer:visualization",
      objectId: "free-layer",
      ref: null,
    };
    const content = buildRibbonTabContent("view", {
      ...context,
      selection,
    });
    const selectedGroup = content?.groups.find(
      (group) => group.id === "view-selected-display",
    );
    const textureAction = selectedGroup?.actions.find(
      (action) => action.id === "view-selected-texture",
    );
    const quantityNode = textureAction?.menu?.find(
      (node) =>
        node.type === "radio-group" && node.id === "selected-texture:quantity",
    );

    expect(quantityNode).toMatchObject({
      value: "H_eff",
    });
  });

  it("marks global Quantity controls as mixed and can clear per-target quantities", async () => {
    const { context, invalidations, patches } =
      createVisualizationRibbonContext({
        active_quantity_id: "m",
        layers: {
          quantity_overlay: { visible: true },
        },
        overrides: [
          {
            scope: "airbox",
            scope_id: "airbox",
            quantity: { active_quantity_id: "h_eff" },
          },
          {
            scope: "object",
            scope_id: "free-layer",
            display: { visible: true },
            quantity: { active_quantity_id: "h_demag" },
          },
        ],
        quantity: {
          active_quantity_id: "m",
          auto_contrast: true,
          colormap: "viridis",
          field_component: "magnitude",
        },
        revision: 7,
      });
    const content = buildRibbonTabContent("view", context);
    const quantityAction = content?.groups
      .find((group) => group.id === "view-global-display")
      ?.actions.find((action) => action.id === "view-quantity");
    const sourceNode = quantityAction?.menu?.find(
      (node) => node.type === "radio-group" && node.id === "quantity:source",
    );
    const mixedNode = quantityAction?.menu?.find(
      (node) => node.type === "status" && node.id === "quantity:mixed-targets",
    );

    expect(quantityAction?.iconColor).toBe("text-amber-300");
    expect(mixedNode).toMatchObject({
      tone: "warning",
      value: "2 target overrides",
    });
    if (sourceNode?.type !== "radio-group") {
      throw new Error("Expected quantity source control");
    }
    expect(sourceNode.commandId).toBe(
      RIBBON_VISUALIZATION_APPLY_GLOBAL_QUANTITY_COMMAND,
    );

    await runRibbonNode(sourceNode, "h_ex", context);

    expect(patches).toEqual([
      {
        active_quantity_id: "H_ex",
        overrides: [
          {
            scope: "object",
            scope_id: "free-layer",
            display: { visible: true },
          },
        ],
        quantity: { active_quantity_id: "H_ex" },
      },
    ]);
    await vi.waitFor(() =>
      expect(invalidations).toEqual([[VISUALIZATION_STATE_PATH, 41]]),
    );
  });

  it("patches canonical visualization state from global Vectors controls", async () => {
    const { context, patches } = createVisualizationRibbonContext({
      field_component: "magnitude",
      layers: {
        vectors: {
          domain: "auto",
          visible: false,
        },
      },
      sampling: { max_glyphs: 58 },
      vector_style: {
        alpha: 0.9,
        color_mode: "orientation",
        length_scale: 1,
        thickness: 1,
      },
    });
    const content = buildRibbonTabContent("view", context);
    const vectorsAction = content?.groups
      .find((group) => group.id === "view-global-display")
      ?.actions.find((action) => action.id === "view-vectors");
    const visibleNode = vectorsAction?.menu?.find(
      (node) => node.type === "checkbox" && node.id === "vectors:visible",
    );
    const densityNode = vectorsAction?.menu?.find(
      (node) => node.type === "slider" && node.id === "vectors:density",
    );
    const scopeNode = vectorsAction?.menu?.find(
      (node) =>
        node.type === "radio-group" && node.id === "vectors:geometry-scope",
    );
    const placementNode = vectorsAction?.menu?.find(
      (node) => node.type === "submenu" && node.id === "vectors:placement",
    );
    const centeringNode = placementNode?.type === "submenu"
      ? placementNode.nodes.find(
          (node) =>
            node.type === "checkbox" && node.id === "vectors:centered-anchor",
        )
      : undefined;
    const surfaceOffsetNode = placementNode?.type === "submenu"
      ? placementNode.nodes.find(
          (node) =>
            node.type === "checkbox" && node.id === "vectors:surface-offset",
        )
      : undefined;

    expect(visibleNode).toMatchObject({ checked: false });
    expect(densityNode).toMatchObject({ value: 58 });
    expect(scopeNode).toMatchObject({ value: "full" });
    expect(centeringNode).toMatchObject({ checked: true });
    expect(surfaceOffsetNode).toMatchObject({ checked: false });
    if (
      visibleNode?.type !== "checkbox" ||
      densityNode?.type !== "slider" ||
      scopeNode?.type !== "radio-group" ||
      centeringNode?.type !== "checkbox" ||
      surfaceOffsetNode?.type !== "checkbox"
    ) {
      throw new Error("Expected vector visibility, density, scope and placement controls");
    }

    await runRibbonNode(visibleNode, true, context);
    await runRibbonNode(densityNode, 2048, context);
    await runRibbonNode(scopeNode, "surface", context);
    await runRibbonNode(centeringNode, false, context);
    await runRibbonNode(surfaceOffsetNode, true, context);

    expect(patches).toEqual([
      {
        layers: { vectors: { visible: true } },
        vector_glyphs: true,
      },
      {
        layers: { vectors: { density: 2048 } },
        sampling: { max_glyphs: 2048 },
        vector_density: 2048,
      },
    ]);
    expect(context.visualization.getDefaultSettings("object")).toMatchObject({
      geometryScope: "surface",
      vectorCenteringEnabled: false,
      vectorSurfaceOffsetEnabled: true,
    });
    expect(context.visualization.getDefaultSettings("part")).toMatchObject({
      geometryScope: "surface",
      vectorCenteringEnabled: false,
      vectorSurfaceOffsetEnabled: true,
    });
    expect(context.visualization.getSnapshot().viewportPreferenceDefaults).toEqual({
      object: {
        vectorCenteringEnabled: false,
        vectorSurfaceOffsetEnabled: true,
      },
      part: {
        vectorCenteringEnabled: false,
        vectorSurfaceOffsetEnabled: true,
      },
    });
  });

  it("patches canonical visualization state from global Mesh View controls", async () => {
    const { context, patches } = createVisualizationRibbonContext({
      layers: {
        points: { opacity: 1, visible: false },
        surface: { opacity: 1, visible: true },
        wireframe: { opacity: 1, visible: false },
      },
    });
    const content = buildRibbonTabContent("view", context);
    const meshAction = content?.groups
      .find((group) => group.id === "view-global-display")
      ?.actions.find((action) => action.id === "view-render-layers");
    const renderModeNode = meshAction?.menu?.find(
      (node) => node.type === "radio-group" && node.id === "layers:mesh-mode",
    );
    const opacityNode = meshAction?.menu?.find(
      (node) => node.type === "slider" && node.id === "layers:opacity",
    );

    expect(renderModeNode).toMatchObject({ value: "surface" });
    expect(opacityNode).toMatchObject({ value: 100 });
    if (renderModeNode?.type !== "radio-group" || opacityNode?.type !== "slider") {
      throw new Error("Expected mesh render-mode and opacity controls");
    }

    await runRibbonNode(renderModeNode, "points", context);
    await runRibbonNode(opacityNode, 45, context);

    expect(patches).toEqual([
      {
        layers: {
          points: { visible: true },
          surface: { visible: false },
          wireframe: { visible: false },
        },
      },
      {
        layers: {
          points: { opacity: 0.45 },
          surface: { opacity: 0.45 },
          wireframe: { opacity: 0.45 },
        },
      },
    ]);
  });

  it("patches canonical visualization clip state from the Clip ribbon controls", async () => {
    const { context, patches } = createVisualizationRibbonContext({
      clip: {
        axis: "z",
        enabled: false,
        flipped: false,
        position_percent: 50,
      },
    });
    const content = buildRibbonTabContent("view", context);
    const clipAction = content?.groups
      .find((group) => group.id === "view-selected-display")
      ?.actions.find((action) => action.id === "view-selected-clip");
    const enabledNode = clipAction?.menu?.find(
      (node) => node.type === "checkbox" && node.id === "selected-clip:enabled",
    );
    const axisNode = clipAction?.menu?.find(
      (node) => node.type === "radio-group" && node.id === "selected-clip:axis",
    );
    const positionNode = clipAction?.menu?.find(
      (node) => node.type === "slider" && node.id === "selected-clip:position",
    );
    const flippedNode = clipAction?.menu?.find(
      (node) => node.type === "checkbox" && node.id === "selected-clip:flipped",
    );

    expect(clipAction).toMatchObject({ active: false, disabled: false });
    expect(enabledNode).toMatchObject({ checked: false });
    expect(axisNode).toMatchObject({ value: "z" });
    expect(positionNode).toMatchObject({ value: 50 });
    if (
      enabledNode?.type !== "checkbox" ||
      axisNode?.type !== "radio-group" ||
      positionNode?.type !== "slider" ||
      flippedNode?.type !== "checkbox"
    ) {
      throw new Error("Expected active clip ribbon controls");
    }

    await runRibbonNode(enabledNode, true, context);
    await runRibbonNode(axisNode, "x", context);
    await runRibbonNode(positionNode, 62.5, context);
    await runRibbonNode(flippedNode, true, context);

    expect(patches).toEqual([
      { clip: { enabled: true } },
      { clip: { axis: "x", enabled: true } },
      { clip: { enabled: true, position_percent: 62.5 } },
      { clip: { enabled: true, flipped: true } },
    ]);
  });

  it("routes the View 2D group through the field-map command source", () => {
    const { context } = createVisualizationRibbonContext({});
    const content = buildRibbonTabContent("view", context);
    const sliceGroup = content?.groups.find((group) => group.id === "view-slice-2d");
    const actionIds = sliceGroup?.actions.map((action) => action.id);
    const menuNodeIds =
      sliceGroup?.actions.flatMap((action) =>
        (action.menu ?? []).map((node) => node.id),
      ) ?? [];

    expect(sliceGroup).toMatchObject({
      subtitle: "planar monitor",
      title: "2D View",
    });
    expect(actionIds).toEqual([
      RIBBON_CROSS_SECTION_BEGIN_DRAFT_COMMAND,
      "field-map.open",
      "field-map.export-png",
    ]);
    expect(menuNodeIds).not.toEqual(
      expect.arrayContaining([
        "slice:plane:axis",
        "slice:plane:position",
        "slice:quality:metric",
        "slice:quality:color-scale",
        "slice:quality:filter",
        "slice:quality:shrink",
      ]),
    );
    expect(content?.groups.map((group) => group.title)).not.toContain("2D Slice");
    expect(actionIds).not.toEqual(
      expect.arrayContaining([
        "view-slice-plane",
        "view-slice-layers",
        "view-slice-quality",
      ]),
    );
  });

  it("wires View orientation controls to command ids", () => {
    const commands = new CommandRegistry();
    commands.register({
      id: "viewport-3d.toggle-viewcube",
      title: "Toggle 3D Box",
      group: "viewport-3d",
      scope: "viewport",
      isActive: () => true,
      run: () => ({ status: "completed" }),
    });
    commands.register({
      id: "viewport-3d.hsl-reference-auto",
      title: "HSL Reference Auto",
      group: "viewport-3d",
      scope: "viewport",
      isActive: () => true,
      run: () => ({ status: "completed" }),
    });
    commands.register({
      id: "viewport-3d.hsl-reference-on",
      title: "HSL Reference On",
      group: "viewport-3d",
      scope: "viewport",
      isActive: () => false,
      run: () => ({ status: "completed" }),
    });
    commands.register({
      id: "viewport-3d.hsl-reference-off",
      title: "HSL Reference Off",
      group: "viewport-3d",
      scope: "viewport",
      isActive: () => false,
      run: () => ({ status: "completed" }),
    });
    commands.register({
      id: "viewport-3d.open-camera-dialog",
      title: "Open 3D Camera Controls",
      group: "viewport-3d",
      scope: "viewport",
      isActive: () => false,
      run: () => ({ status: "completed" }),
    });
    commands.register({
      id: "viewport-3d.rotation-camera",
      title: "Use Free Camera Rotation",
      group: "viewport-3d",
      scope: "viewport",
      isActive: () => true,
      run: () => ({ status: "completed" }),
    });
    commands.register({
      id: "viewport-3d.rotation-object",
      title: "Use Object Rotation",
      group: "viewport-3d",
      scope: "viewport",
      isActive: () => false,
      run: () => ({ status: "completed" }),
    });
    commands.register({
      id: "viewport-3d.inspect-toggle",
      title: "Inspect Field Value",
      group: "viewport-3d",
      scope: "viewport",
      isActive: () => true,
      run: () => ({ status: "completed" }),
    });
    commands.register({
      id: "viewport-3d.capture-frame",
      title: "Capture 3D Frame",
      group: "viewport-3d",
      scope: "viewport",
      isActive: () => false,
      run: () => ({ status: "completed" }),
    });
    commands.register({
      id: "viewport-3d.profile-interactive",
      title: "Interactive 3D Profile",
      group: "viewport-3d",
      scope: "viewport",
      isActive: () => false,
      run: () => ({ status: "completed" }),
    });
    commands.register({
      id: "viewport-3d.profile-figure",
      title: "Figure 3D Profile",
      group: "viewport-3d",
      scope: "viewport",
      isActive: () => true,
      run: () => ({ status: "completed" }),
    });
    commands.register({
      id: "viewport-3d.profile-capture",
      title: "Capture 3D Profile",
      group: "viewport-3d",
      scope: "viewport",
      isActive: () => false,
      run: () => ({ status: "completed" }),
    });
    commands.register({
      id: "viewport-3d.profile-balanced",
      title: "Balanced 3D Profile",
      group: "viewport-3d",
      scope: "viewport",
      isActive: () => false,
      run: () => ({ status: "completed" }),
    });
    commands.register({
      id: "viewport-3d.profile-interactive-lite",
      title: "Interactive Lite 3D Profile",
      group: "viewport-3d",
      scope: "viewport",
      isActive: () => false,
      run: () => ({ status: "completed" }),
    });

    const content = buildRibbonTabContent("view", {
      commands,
      commandContext: { source: "test" },
      selection: {
        kind: null,
        label: null,
        moduleSource: null,
        nodeId: null,
        objectId: null,
        ref: null,
      },
      visualization: new ObjectVisualizationController(),
      visualizationSnapshot: new ObjectVisualizationController().getSnapshot(),
    });
    const homeContent = buildRibbonTabContent("home", {
      commands,
      commandContext: { source: "test" },
      selection: {
        kind: null,
        label: null,
        moduleSource: null,
        nodeId: null,
        objectId: null,
        ref: null,
      },
      visualization: new ObjectVisualizationController(),
      visualizationSnapshot: new ObjectVisualizationController().getSnapshot(),
    });
    const workspaceGroup = homeContent?.groups.find(
      (group) => group.id === "workspace",
    );
    const homeCameraAction = workspaceGroup?.actions.find(
      (action) => action.id === "home-camera-rotation",
    );
    const homeRotationNode = homeCameraAction?.menu?.find(
      (node) => node.type === "radio-group" && node.id === "home-camera:rotation-mode",
    );
    const orientationGroup = content?.groups.find(
      (group) => group.id === "view-orientation-tools",
    );
    const manipulateGroup = content?.groups.find(
      (group) => group.id === "view-manipulate",
    );
    const globalGroup = content?.groups.find(
      (group) => group.id === "view-global-display",
    );
    const qualityAction = globalGroup?.actions.find(
      (action) => action.id === "view-render-quality",
    );
    const qualityNode = qualityAction?.menu?.find(
      (node) => node.type === "radio-group" && node.id === "3d-quality:profile",
    );
    const captureNode = qualityAction?.menu?.find(
      (node) => node.type === "item" && node.id === "3d-quality:capture-frame",
    );
    const viewCubeAction = orientationGroup?.actions.find(
      (action) => action.id === "viewport-3d.toggle-viewcube",
    );
    const inspectAction = manipulateGroup?.actions.find(
      (action) => action.id === "viewport-3d.inspect-toggle",
    );
    const hslAction = orientationGroup?.actions.find(
      (action) => action.id === "view-hsl-reference",
    );
    const displayGroup = content?.groups.find(
      (group) => group.id === "view-display",
    );
    const cameraAction = displayGroup?.actions.find(
      (action) => action.id === "view-camera",
    );
    const topographyAction = displayGroup?.actions.find(
      (action) => action.id === "view-topography",
    );
    const cameraParametersNode = cameraAction?.menu?.find(
      (node) => node.type === "item" && node.id === "camera:parameters",
    );
    const topographyEnabledNode = topographyAction?.menu?.find(
      (node) => node.type === "checkbox" && node.id === "topography:enabled",
    );
    const topographyComponentNode = topographyAction?.menu?.find(
      (node) => node.type === "radio-group" && node.id === "topography:component",
    );
    const viewRotationNode = cameraAction?.menu?.find(
      (node) => node.type === "radio-group" && node.id === "view-camera:rotation-mode",
    );
    const hslNode = hslAction?.menu?.find(
      (node) => node.type === "radio-group" && node.id === "orientation:hsl-reference",
    );

    expect(viewCubeAction).toMatchObject({
      active: true,
      id: "viewport-3d.toggle-viewcube",
      label: "3D Box",
    });
    expect(inspectAction).toMatchObject({
      active: true,
      id: "viewport-3d.inspect-toggle",
      label: "Inspect",
    });
    expect(hslAction).toMatchObject({
      active: true,
      label: "HSL Sphere",
    });
    expect(hslNode).toMatchObject({
      value: "auto",
      items: [
        expect.objectContaining({
          commandId: "viewport-3d.hsl-reference-auto",
          value: "auto",
        }),
        expect.objectContaining({
          commandId: "viewport-3d.hsl-reference-on",
          value: "on",
        }),
        expect.objectContaining({
          commandId: "viewport-3d.hsl-reference-off",
          value: "off",
        }),
      ],
    });
    expect(hslNode).not.toHaveProperty("onValueChange");
    expect(qualityAction).toMatchObject({
      active: true,
      label: "Quality",
    });
    expect(qualityNode).toMatchObject({
      value: "figure",
      items: [
        expect.objectContaining({
          commandId: "viewport-3d.profile-interactive-lite",
          value: "interactive-lite",
        }),
        expect.objectContaining({
          commandId: "viewport-3d.profile-interactive",
          value: "interactive",
        }),
        expect.objectContaining({
          commandId: "viewport-3d.profile-balanced",
          value: "balanced",
        }),
        expect.objectContaining({
          commandId: "viewport-3d.profile-figure",
          value: "figure",
        }),
        expect.objectContaining({
          commandId: "viewport-3d.profile-capture",
          value: "capture",
        }),
      ],
    });
    expect(captureNode).toMatchObject({
      commandId: "viewport-3d.capture-frame",
      label: "Capture current frame",
    });
    expect(cameraParametersNode).toMatchObject({
      commandId: "viewport-3d.open-camera-dialog",
      label: "Camera parameters",
    });
    expect(topographyAction).toMatchObject({
      disabled: false,
      label: "Topography",
    });
    expect(topographyEnabledNode).toMatchObject({
      commandId: "viewport-3d.fdm-topography-toggle",
      type: "checkbox",
    });
    expect(topographyComponentNode).toMatchObject({
      value: "z",
      items: expect.arrayContaining([
        expect.objectContaining({
          commandId: "viewport-3d.fdm-topography-component-magnitude",
          value: "magnitude",
        }),
      ]),
    });
    expect(viewRotationNode).toMatchObject({
      value: "camera",
      items: [
        expect.objectContaining({
          commandId: "viewport-3d.rotation-camera",
          value: "camera",
        }),
        expect.objectContaining({
          commandId: "viewport-3d.rotation-object",
          value: "object",
        }),
      ],
    });
    expect(homeCameraAction).toMatchObject({
      active: true,
      label: "Camera",
    });
    expect(homeRotationNode).toMatchObject({
      value: "camera",
      items: [
        expect.objectContaining({
          commandId: "viewport-3d.rotation-camera",
          value: "camera",
        }),
        expect.objectContaining({
          commandId: "viewport-3d.rotation-object",
          value: "object",
        }),
      ],
    });
  });

  it("mirrors command registry disabled state into ribbon actions", () => {
    const commands = new CommandRegistry();
    commands.register({
      id: "mesh.build-selected",
      title: "Build Selected Mesh",
      group: "mesh",
      scope: "selection",
      disabledReason: () => "Select a scene object to build its mesh.",
      isEnabled: () => false,
      run: () => ({ status: "completed" }),
    });

    const content = buildRibbonTabContent("geometry", {
      commands,
      commandContext: { source: "test" },
      selection: {
        kind: null,
        label: null,
        moduleSource: null,
        nodeId: null,
        objectId: null,
        ref: null,
      },
      visualization: new ObjectVisualizationController(),
      visualizationSnapshot: new ObjectVisualizationController().getSnapshot(),
    });

    const buildAction = content?.groups
      .find((group) => group.id === "builder-lifecycle")
      ?.actions.find((action) => action.id === "mesh.build-selected");

    expect(buildAction).toMatchObject({
      disabled: true,
      tooltip: "Select a scene object to build its mesh.",
    });
  });

  it("keeps unsupported Mesh policy controls disabled while wiring 3D view navigation", () => {
    const commands = createControlRoomCommandRegistry();
    const visualization = new ObjectVisualizationController();
    const content = buildRibbonTabContent("mesh", {
      commands,
      commandContext: { source: "test" },
      selection: {
        kind: null,
        label: null,
        moduleSource: null,
        nodeId: null,
        objectId: null,
        ref: null,
      },
      visualization,
      visualizationSnapshot: visualization.getSnapshot(),
    });
    const transitionAction = content?.groups
      .find((group) => group.id === "size")
      ?.actions.find((action) => action.id === "transitions");
    const mesherAction = content?.groups
      .find((group) => group.id === "method")
      ?.actions.find((action) => action.id === "mesher");
    const mesh3dAction = content?.groups
      .find((group) => group.id === "mesh-view")
      ?.actions.find((action) => action.id === "mesh-3d");

    expect(transitionAction).toMatchObject({
      disabled: true,
      label: "Transitions",
    });
    expect(mesherAction).toMatchObject({
      disabled: true,
      label: "Mesher",
    });
    expect(mesh3dAction).toMatchObject({
      commandId: "viewport-3d.open",
      disabled: false,
      label: "3D View",
    });
  });

  it("shows the server capability reason on mesh build actions", () => {
    const commands = createControlRoomCommandRegistry();
    const visualization = new ObjectVisualizationController();
    const content = buildRibbonTabContent("mesh", {
      commands,
      commandContext: { source: "test" },
      meshCapabilities: {
        revision: 3,
        mesh_capabilities: {
          fem: {
            status: "unsupported",
            reason: "FEM mesh authoring is unavailable for this session.",
          },
        },
      },
      resources: { invalidate: vi.fn() },
      selection: {
        kind: null,
        label: null,
        moduleSource: null,
        nodeId: null,
        objectId: null,
        ref: null,
      },
      visualization,
      visualizationSnapshot: visualization.getSnapshot(),
    });

    const buildAction = content?.groups
      .find((group) => group.id === "build")
      ?.actions.find((action) => action.id === "mesh.build-selected");

    expect(buildAction).toMatchObject({
      disabled: true,
      tooltip: "FEM mesh authoring is unavailable for this session.",
    });
  });

  it("prefers explicit supported mesh capability data over an unsupported top-level fallback", () => {
    const commands = createControlRoomCommandRegistry();
    const visualization = new ObjectVisualizationController();
    const content = buildRibbonTabContent("mesh", {
      commands,
      commandContext: {
        resourceData: {
          [MESHING_CAPABILITIES_PATH]: {
            revision: 4,
            mesh_capabilities: { fem: { status: "supported" } },
          },
        },
        source: "test",
      },
      meshCapabilities: {
        revision: 3,
        mesh_capabilities: {
          fem: {
            status: "unsupported",
            reason: "Top-level fallback must not override explicit support.",
          },
        },
      },
      resources: { invalidate: vi.fn() },
      selection: selectedMeshObject(),
      visualization,
      visualizationSnapshot: visualization.getSnapshot(),
    });

    const buildAction = content?.groups
      .find((group) => group.id === "build")
      ?.actions.find((action) => action.id === "mesh.build-selected");

    expect(buildAction).toMatchObject({ disabled: false });
    expect(buildAction?.tooltip).not.toBe(
      "Top-level fallback must not override explicit support.",
    );
  });

  it("prefers explicit unsupported mesh capability data over a supported top-level fallback", () => {
    const commands = createControlRoomCommandRegistry();
    const visualization = new ObjectVisualizationController();
    const content = buildRibbonTabContent("mesh", {
      commands,
      commandContext: {
        resourceData: {
          [MESHING_CAPABILITIES_PATH]: {
            revision: 4,
            mesh_capabilities: {
              fem: {
                status: "unsupported",
                reason: "Explicit session capability blocks FEM meshing.",
              },
            },
          },
        },
        source: "test",
      },
      meshCapabilities: {
        revision: 3,
        mesh_capabilities: { fem: { status: "supported" } },
      },
      resources: { invalidate: vi.fn() },
      selection: selectedMeshObject(),
      visualization,
      visualizationSnapshot: visualization.getSnapshot(),
    });

    const buildAction = content?.groups
      .find((group) => group.id === "build")
      ?.actions.find((action) => action.id === "mesh.build-selected");

    expect(buildAction).toMatchObject({
      disabled: true,
      tooltip: "Explicit session capability blocks FEM meshing.",
    });
  });

  it("keeps Study script sync disabled until a command contract exists", () => {
    const content = buildRibbonTabContent("study", {
      commands: createControlRoomCommandRegistry(),
      commandContext: { source: "test" },
      selection: {
        kind: null,
        label: null,
        moduleSource: null,
        nodeId: null,
        objectId: null,
        ref: null,
      },
      visualization: new ObjectVisualizationController(),
      visualizationSnapshot: new ObjectVisualizationController().getSnapshot(),
    });
    const syncAction = content?.groups
      .find((group) => group.id === "builder-sync")
      ?.actions.find((action) => action.id === "study-sync");
    const syncMenuItems =
      syncAction?.menu?.filter((node) => node.type === "item") ?? [];

    expect(syncAction).toMatchObject({
      disabled: true,
      label: "Sync Script",
    });
    expect(syncMenuItems.map((node) => node.disabled)).toEqual([true, true, true]);
  });

  it("keeps Automation script sync disabled until a command contract exists", () => {
    const syncAction = ALL_TAB_CONTENT.automation.groups
      .find((group) => group.id === "automation-sync")
      ?.actions.find((action) => action.id === "automation-sync-script");
    const syncMenuItems =
      syncAction?.menu?.filter((node) => node.type === "item") ?? [];

    expect(syncAction).toMatchObject({
      disabled: true,
      label: "Sync Script",
    });
    expect(syncMenuItems.map((node) => node.disabled)).toEqual([true, true, true]);
  });

  it("keeps unsupported Study composite workflows disabled", () => {
    const unsupportedIds = new Set([
      "study-sweep-relax",
      "study-sweep-snap",
      "study-relax-run",
      "study-param-sweep",
      "study-current-sweep",
    ]);
    const compositeActions =
      ALL_TAB_CONTENT.study.groups.find((group) => group.id === "study-composite")
        ?.actions ?? [];

    for (const action of compositeActions) {
      if (unsupportedIds.has(action.id)) {
        expect(action.disabled, action.id).toBe(true);
      }
    }
  });

  it("wires Study navigation buttons to local selection commands", () => {
    const content = buildRibbonTabContent("study", {
      commands: createControlRoomCommandRegistry(),
      commandContext: { source: "test" },
      selection: {
        kind: null,
        label: null,
        moduleSource: null,
        nodeId: null,
        objectId: null,
        ref: null,
      },
      visualization: new ObjectVisualizationController(),
      visualizationSnapshot: new ObjectVisualizationController().getSnapshot(),
    });
    const navigationGroup = content?.groups.find((group) => group.id === "navigate");

    expect(
      navigationGroup?.actions.find((action) => action.id === "study-overview"),
    ).toMatchObject({
      commandId: "study.open-overview",
      disabled: false,
    });
    expect(
      navigationGroup?.actions.find((action) => action.id === "study-stages"),
    ).toMatchObject({
      commandId: "study.open-stages",
      disabled: false,
    });
  });

  it("wires Results export buttons to concrete export commands", () => {
    const content = buildRibbonTabContent("results", {
      commands: createControlRoomCommandRegistry(),
      commandContext: {
        api: {
          commands: { submit: vi.fn() },
          persistence: { exports: { create: vi.fn() } },
        } as never,
        resourceData: {
          [MODEL_GEOMETRY_VALIDATION_PATH]: { diagnostics: [] },
          [SIMULATION_COMMANDS_PATH]: { commands: [] },
          [SIMULATION_SOLVER_STATUS_PATH]: { runtime_state: "idle" },
          [SIMULATION_STAGES_EXECUTION_PATH]: {
            active_stage_index: 0,
            revision: 1,
            runtime_state: "idle",
            stages: [{ stage_id: "stage-000" }],
          },
        },
        source: "test",
      },
      selection: {
        kind: null,
        label: null,
        moduleSource: null,
        nodeId: null,
        objectId: null,
        ref: null,
      },
      visualization: new ObjectVisualizationController(),
      visualizationSnapshot: new ObjectVisualizationController().getSnapshot(),
      visualizationState: null,
    });
    const exportGroup = content?.groups.find(
      (group) => group.id === "results-export",
    );

    expect(exportGroup?.actions.find((action) => action.id === "export-vtk"))
      .toMatchObject({
        commandId: "study.save-vtk",
        disabled: false,
      });
    expect(exportGroup?.actions.find((action) => action.id === "export-state"))
      .toMatchObject({
        commandId: "study.export-state",
        disabled: false,
      });
  });

  it("keeps unsupported Results analysis workflows disabled", () => {
    const unsupportedIds = new Set([
      "results-spectrum",
      "results-vortex-add",
      "results-add-spectrum",
      "results-dispersion",
      "results-modes",
    ]);
    const analyzeGroup = ALL_TAB_CONTENT.results.groups.find(
      (group) => group.id === "analyze",
    );
    const matchedIds = new Set<string>();

    for (const action of analyzeGroup?.actions ?? []) {
      if (unsupportedIds.has(action.id)) {
        matchedIds.add(action.id);
        expect(action.disabled, action.id).toBe(true);
      }
    }
    expect(matchedIds).toEqual(unsupportedIds);
  });

  it("keeps unsupported Results time-domain workflows disabled", () => {
    const unsupportedIds = new Set([
      "add-time-traces",
      "add-fft",
      "add-trajectory",
      "add-orbit",
    ]);
    const timeDomainGroup = ALL_TAB_CONTENT.results.groups.find(
      (group) => group.id === "results-vortex",
    );
    const matchedIds = new Set<string>();

    for (const action of timeDomainGroup?.actions ?? []) {
      if (unsupportedIds.has(action.id)) {
        matchedIds.add(action.id);
        expect(action.disabled, action.id).toBe(true);
      }
    }
    expect(matchedIds).toEqual(unsupportedIds);
  });

  it("keeps unsupported Results plot and workspace workflows disabled", () => {
    const unsupportedIds = new Set([
      "results-chart",
      "results-snapshot",
      "add-quantity-ws",
      "add-table-ws",
    ]);
    const matchedIds = new Set<string>();

    for (const group of ALL_TAB_CONTENT.results.groups) {
      for (const action of group.actions) {
        if (unsupportedIds.has(action.id)) {
          matchedIds.add(action.id);
          expect(action.disabled, action.id).toBe(true);
        }
      }
    }
    expect(matchedIds).toEqual(unsupportedIds);
  });

  it("keeps unsupported Materials edit and transform workflows disabled", () => {
    const unsupportedIds = new Set([
      "mat-params",
      "mat-dmi",
      "mat-ku",
      "mat-texture-inspector",
      "mat-transform-scope",
      "mat-transform-tool",
    ]);
    const matchedIds = new Set<string>();

    for (const group of ALL_TAB_CONTENT.materials.groups) {
      for (const action of group.actions) {
        if (unsupportedIds.has(action.id)) {
          matchedIds.add(action.id);
          expect(action.disabled, action.id).toBe(true);
        }
      }
    }
    expect(matchedIds).toEqual(unsupportedIds);
  });

  it("exposes study compute commands through the Study control group", () => {
    const commands = new CommandRegistry();
    for (const command of STUDY_RUNTIME_COMMANDS) {
      commands.register(command);
    }

    const content = buildRibbonTabContent("study", {
      commands,
      commandContext: {
        api: { commands: { submit: vi.fn() } } as never,
        resourceData: {
          [MODEL_GEOMETRY_VALIDATION_PATH]: { diagnostics: [] },
          [SESSION_STATUS_RESOURCE_KEY]: {
            capabilities: {
              binary_fields: true,
              explicit_topology: false,
            },
            domain: {
              discretization: "fdm",
            },
            resources: {
              mesh_revision: 0,
              scene_revision: 1,
            },
          },
          [SIMULATION_COMMANDS_PATH]: { commands: [] },
          [SIMULATION_SOLVER_STATUS_PATH]: { runtime_state: "idle" },
          [SIMULATION_STAGES_EXECUTION_PATH]: {
            active_stage_index: null,
            revision: 1,
            runtime_state: "idle",
            stages: [],
          },
        },
        source: "test" as const,
      },
      selection: {
        kind: null,
        label: null,
        moduleSource: null,
        nodeId: null,
        objectId: null,
        ref: null,
      },
      visualization: new ObjectVisualizationController(),
      visualizationSnapshot: new ObjectVisualizationController().getSnapshot(),
    });

    const computeFieldsAction = content?.groups
      .find((group) => group.id === "control")
      ?.actions.find((action) => action.id === "study.compute-fields");
    const computeAction = content?.groups
      .find((group) => group.id === "control")
      ?.actions.find((action) => action.id === "study.run");

    expect(computeFieldsAction).toMatchObject({
      disabled: false,
      label: "Compute Fields",
    });
    expect(computeAction).toMatchObject({
      disabled: false,
      label: "Compute",
    });
    expect(computeAction?.splitButton).toBeUndefined();
    expect(computeAction?.menu).toBeUndefined();
  });

  it("wires the Home Compute group to the study runtime command registry", () => {
    const commands = new CommandRegistry();
    for (const command of STUDY_RUNTIME_COMMANDS) {
      commands.register(command);
    }

    const content = buildRibbonTabContent("home", {
      commands,
      commandContext: {
        api: { commands: { submit: vi.fn() } } as never,
        resourceData: {
          [MODEL_GEOMETRY_VALIDATION_PATH]: { diagnostics: [] },
          [SESSION_STATUS_RESOURCE_KEY]: {
            capabilities: {
              binary_fields: true,
              explicit_topology: false,
            },
            domain: {
              discretization: "fdm",
            },
            resources: {
              mesh_revision: 0,
              scene_revision: 1,
            },
          },
          [SIMULATION_COMMANDS_PATH]: { commands: [] },
          [SIMULATION_SOLVER_STATUS_PATH]: { runtime_state: "idle" },
          [SIMULATION_STAGES_EXECUTION_PATH]: {
            active_stage_index: null,
            revision: 1,
            runtime_state: "idle",
            stages: [],
          },
        },
        source: "test" as const,
      },
      selection: {
        kind: null,
        label: null,
        moduleSource: null,
        nodeId: null,
        objectId: null,
        ref: null,
      },
      visualization: new ObjectVisualizationController(),
      visualizationSnapshot: new ObjectVisualizationController().getSnapshot(),
    });

    const computeGroup = content?.groups.find((group) => group.id === "compute");
    const computeAction = computeGroup?.actions.find(
      (action) => action.id === "study.run",
    );
    const resumeAction = computeGroup?.actions.find(
      (action) => action.id === "study.resume",
    );
    const discardAction = computeGroup?.actions.find(
      (action) => action.id === "study.discard-paused-state",
    );

    expect(computeGroup?.actions.some((action) => action.id === "run")).toBe(
      false,
    );
    expect(computeAction).toMatchObject({
      disabled: false,
      label: "Compute",
    });
    expect(computeAction?.splitButton).toBeUndefined();
    expect(computeAction?.menu).toBeUndefined();
    expect(resumeAction).toMatchObject({
      disabled: true,
      label: "Resume",
    });
    expect(discardAction).toMatchObject({
      disabled: true,
      label: "Discard",
    });
  });

  it("enables paused-state discard from the Home Compute group", () => {
    const commands = new CommandRegistry();
    for (const command of STUDY_RUNTIME_COMMANDS) {
      commands.register(command);
    }

    const content = buildRibbonTabContent("home", {
      commands,
      commandContext: {
        api: { commands: { submit: vi.fn() } } as never,
        resourceData: {
          [MODEL_GEOMETRY_VALIDATION_PATH]: { diagnostics: [] },
          [SESSION_STATUS_RESOURCE_KEY]: {
            capabilities: {
              binary_fields: true,
              explicit_topology: false,
            },
            domain: {
              discretization: "fdm",
            },
            resources: {
              mesh_revision: 0,
              scene_revision: 1,
            },
          },
          [SIMULATION_COMMANDS_PATH]: { commands: [] },
          [SIMULATION_SOLVER_STATUS_PATH]: { runtime_state: "paused" },
          [SIMULATION_STAGES_EXECUTION_PATH]: {
            active_stage_index: 0,
            revision: 2,
            runtime_state: "paused",
            stages: [{ status: "paused" }],
          },
        },
        source: "test" as const,
      },
      selection: {
        kind: null,
        label: null,
        moduleSource: null,
        nodeId: null,
        objectId: null,
        ref: null,
      },
      visualization: new ObjectVisualizationController(),
      visualizationSnapshot: new ObjectVisualizationController().getSnapshot(),
    });

    const discardAction = content?.groups
      .find((group) => group.id === "compute")
      ?.actions.find((action) => action.id === "study.discard-paused-state");

    expect(discardAction).toMatchObject({
      disabled: false,
      label: "Discard",
    });
  });

  it("shows FEM mesh readiness reason on disabled Home and Study Compute actions", () => {
    const commands = new CommandRegistry();
    for (const command of STUDY_RUNTIME_COMMANDS) {
      commands.register(command);
    }
    const commandContext = {
      api: { commands: { submit: vi.fn() } } as never,
      resourceData: {
        [MODEL_GEOMETRY_VALIDATION_PATH]: { diagnostics: [] },
        [SESSION_STATUS_RESOURCE_KEY]: {
          capabilities: {
            binary_fields: true,
            explicit_topology: false,
          },
          domain: {
            discretization: "fem",
          },
          resources: {
            mesh_revision: 0,
            scene_revision: 1,
          },
        },
        [SIMULATION_COMMANDS_PATH]: { commands: [] },
        [SIMULATION_SOLVER_STATUS_PATH]: { runtime_state: "idle" },
        [SIMULATION_STAGES_EXECUTION_PATH]: {
          active_stage_index: null,
          revision: 1,
          runtime_state: "idle",
          stages: [],
        },
      },
      source: "test" as const,
    };
    const context = {
      commands,
      commandContext,
      selection: {
        kind: null,
        label: null,
        moduleSource: null,
        nodeId: null,
        objectId: null,
        ref: null,
      },
      visualization: new ObjectVisualizationController(),
      visualizationSnapshot: new ObjectVisualizationController().getSnapshot(),
    };

    const homeContent = buildRibbonTabContent("home", context);
    const studyContent = buildRibbonTabContent("study", context);
    const homeComputeAction = homeContent?.groups
      .find((group) => group.id === "compute")
      ?.actions.find((action) => action.id === "study.run");
    const studyComputeAction = studyContent?.groups
      .find((group) => group.id === "control")
      ?.actions.find((action) => action.id === "study.run");

    expect(homeComputeAction).toMatchObject({
      disabled: true,
      tooltip:
        "Build a current shared-domain mesh before running. Open Mesh Jobs or Build Shared-Domain Mesh.",
    });
    expect(studyComputeAction).toMatchObject({
      disabled: true,
      tooltip:
        "Build a current shared-domain mesh before running. Open Mesh Jobs or Build Shared-Domain Mesh.",
    });
  });

  it("marks active study runtime commands in the Study control group", () => {
    const commands = new CommandRegistry();
    for (const command of STUDY_RUNTIME_COMMANDS) {
      commands.register(command);
    }

    const content = buildRibbonTabContent("study", {
      commands,
      commandContext: {
        api: { commands: { submit: vi.fn() } } as never,
        resourceData: {
          [MODEL_GEOMETRY_VALIDATION_PATH]: { diagnostics: [] },
          [SESSION_STATUS_RESOURCE_KEY]: {
            capabilities: {
              binary_fields: true,
              explicit_topology: false,
            },
            domain: {
              discretization: "fdm",
            },
            resources: {
              mesh_revision: 0,
              scene_revision: 1,
            },
          },
          [SIMULATION_COMMANDS_PATH]: {
            commands: [
              {
                command_id: "cmd-run",
                kind: "solve",
                status: "running",
              },
            ],
          },
          [SIMULATION_SOLVER_STATUS_PATH]: { runtime_state: "idle" },
          [SIMULATION_STAGES_EXECUTION_PATH]: {
            active_stage_index: null,
            revision: 1,
            runtime_state: "idle",
            stages: [],
          },
        },
        source: "test" as const,
      },
      selection: {
        kind: null,
        label: null,
        moduleSource: null,
        nodeId: null,
        objectId: null,
        ref: null,
      },
      visualization: new ObjectVisualizationController(),
      visualizationSnapshot: new ObjectVisualizationController().getSnapshot(),
    });

    const computeAction = content?.groups
      .find((group) => group.id === "control")
      ?.actions.find((action) => action.id === "study.run");

    expect(computeAction).toMatchObject({
      active: true,
      activeCommandId: "cmd-run",
      disabled: true,
      tooltip: "A runtime command is already active.",
    });
  });

  it("exposes .fms import through the Study control group command", () => {
    const commands = new CommandRegistry();
    for (const command of STUDY_RUNTIME_COMMANDS) {
      commands.register(command);
    }

    const content = buildRibbonTabContent("study", {
      commands,
      commandContext: {
        api: {
          persistence: {
            imports: {
              commit: vi.fn(),
              inspect: vi.fn(),
            },
          },
        } as never,
        source: "test" as const,
      },
      selection: {
        kind: null,
        label: null,
        moduleSource: null,
        nodeId: null,
        objectId: null,
        ref: null,
      },
      visualization: new ObjectVisualizationController(),
      visualizationSnapshot: new ObjectVisualizationController().getSnapshot(),
    });

    const importAction = content?.groups
      .find((group) => group.id === "control")
      ?.actions.find((action) => action.id === "study.import-state");
    const importCommand = commands.get("study.import-state");

    expect(importAction).toMatchObject({
      disabled: false,
      label: "Import State",
    });
    expect(importCommand?.shortcut).toBe("Ctrl+O");
  });

  it("exposes object draft commit from the Geometry lifecycle group", () => {
    const lifecycleGroup = ALL_TAB_CONTENT.geometry.groups.find(
      (group) => group.id === "builder-lifecycle",
    );

    expect(lifecycleGroup?.actions.map((action) => action.id)).toEqual(
      expect.arrayContaining([
        "geometry.commit-object-draft",
        "mesh.build-selected",
      ]),
    );
  });

  it("exposes microstrip antenna creation from the Geometry create group", () => {
    const createGroup = ALL_TAB_CONTENT.geometry.groups.find(
      (group) => group.id === "builder-create",
    );

    expect(createGroup?.actions.map((action) => action.id)).toEqual(
      expect.arrayContaining(["geometry.add-microstrip-antenna"]),
    );
  });

  it("routes Thin Film to the enabled geometry command", () => {
    const thinFilmAction = ALL_TAB_CONTENT.geometry.groups
      .find((group) => group.id === "builder-create")
      ?.actions.find((action) => action.id === "geometry.add-thin-film");

    expect(thinFilmAction).toMatchObject({
      id: "geometry.add-thin-film",
      label: "Thin Film",
    });
    expect(thinFilmAction).not.toHaveProperty("disabled");
  });

  it("keeps unsupported Geometry builder controls explicitly disabled", () => {
    const unsupportedIds = new Set([
      "builder-add-ellipsoid",
      "builder-add-disk",
      "builder-add-pillar",
      "builder-add-nanowire",
      "builder-add-ring",
      "builder-add-triangular_prism",
      "builder-add-cone",
      "builder-add-capsule",
      "builder-add-tube",
      "builder-add-wedge",
      "builder-add-polygon_prism",
      "builder-tool-move",
      "builder-tool-rotate",
      "builder-tool-scale",
      "builder-mode-camera",
      "builder-mode-manipulate",
      "builder-toggle-snap",
      "builder-validate",
      "builder-show-universe",
    ]);
    const actions = ALL_TAB_CONTENT.geometry.groups.flatMap(
      (group) => group.actions,
    );

    for (const action of actions) {
      if (unsupportedIds.has(action.id)) {
        expect(action.disabled, action.id).toBe(true);
      }
    }
    const frameAllAction = actions.find((action) => action.id === "builder-frame-all");

    expect(frameAllAction).toMatchObject({
      commandId: "viewport-3d.fit",
    });
    expect(frameAllAction).not.toHaveProperty("disabled");
  });

  it("exposes concrete study stage authoring commands in the Study ribbon", () => {
    const addStageGroup = ALL_TAB_CONTENT.study.groups.find(
      (group) => group.id === "add-stage",
    );
    const selectionGroup = ALL_TAB_CONTENT.study.groups.find(
      (group) => group.id === "study-selection",
    );

    expect(addStageGroup?.actions.map((action) => action.id)).toEqual(
      expect.arrayContaining([
        "study.add-relax-stage",
        "study.add-field-drive-stage",
        "study.add-table-autosave-stage",
        "study.add-autosave-stage",
        "study.add-fft-response-stage",
        "study.add-run-stage",
        "study.add-hysteresis-stage",
        "study.add-eigenmodes-stage",
        "study.add-frequency-response-stage",
        "study.add-save-state-stage",
      ]),
    );
    expect(selectionGroup?.actions.map((action) => action.id)).toEqual(
      expect.arrayContaining(["study.remove-selected-stage"]),
    );
  });
});

function createVisualizationRibbonContext(
  visualizationState: DeepPartial<VisualizationStateResource>,
) {
  const patches: VisualizationStatePatch[] = [];
  const invalidations: Array<[string, number | string]> = [];
  const api = {
    visualization: {
      patch: async (patch: VisualizationStatePatch) => {
        patches.push(patch);
        return {
          ...visualizationState,
          revision: 40 + patches.length,
        } as VisualizationStateResource;
      },
    },
  };
  const resources = {
    invalidate: (resourceKey: string, revision: number | string) => {
      invalidations.push([resourceKey, revision]);
    },
  };
  const visualization = new ObjectVisualizationController();

  return {
    context: {
      api,
      commandContext: {
        api: api as never,
        resourceData: {
          [VISUALIZATION_STATE_PATH]: visualizationState,
        },
        resources: resources as never,
        source: "test" as const,
        visualization,
      },
      commands: createRibbonCommandRegistry(),
      resources,
      selection: {
        kind: null,
        label: null,
        moduleSource: null,
        nodeId: null,
        objectId: null,
        ref: null,
      },
      source: "test" as const,
      visualization,
      visualizationSnapshot: visualization.getSnapshot(),
      visualizationState: visualizationState as VisualizationStateResource,
    },
    invalidations,
    patches,
  };
}
