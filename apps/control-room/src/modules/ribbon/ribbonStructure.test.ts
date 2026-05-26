import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ALL_TAB_CONTENT } from "./ribbonContributions";
import { buildRibbonTabContent } from "./ribbonContributions";
import {
  RIBBON_COMMANDS,
  RIBBON_PHYSICS_SELECT_INTERACTION_COMMAND,
  RIBBON_VISUALIZATION_PATCH_TARGET_COMMAND,
  visualizationTargetCommandInput,
} from "./ribbonCommands";
import { resolveRibbonIconColor, RibbonGroupsRow } from "./RibbonGroupsRow";
import { RIBBON_TABS, type RibbonMenuNode } from "./ribbonTypes";
import {
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
import { STUDY_RUNTIME_COMMANDS } from "@/kernel/runtime/studyRuntimeCommandContributions";
import {
  AIRBOX_VISUALIZATION_TARGET,
  ObjectVisualizationController,
} from "@/kernel/visualization/ObjectVisualizationController";
import { VISUALIZATION_TARGET_COMMANDS } from "@/kernel/visualization/visualizationCommandContributions";

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

describe("ribbon structure", () => {
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

    expect(visualization.getSettings({ id: "free-layer", kind: "object" }))
      .toMatchObject({
        boundsVisible: true,
        shaderColorMode: "monochrome",
        shaderMonoColor: "#ff0000",
        surfaceColorSource: "solid",
        vectorAlphaPercent: 48,
        wireframeOpacityPercent: 64,
      });
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

    expect(visualization.getSettings({ id: "free-layer", kind: "object" }))
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

  it("keeps selected airbox style controls local while visibility patches canonical state", async () => {
    const { context, invalidations, patches } =
      createVisualizationRibbonContext({
        layers: {
          airbox: {
            opacity: 0.28,
            points: { opacity: 1, visible: false },
            surface: { opacity: 1, visible: true },
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
    const visibleNode = renderAction?.menu?.find(
      (node) => node.type === "checkbox" && node.id === "selected:visible",
    );

    expect(surfaceColoringNode).toMatchObject({
      disabled: false,
      value: "inherit",
    });
    expect(vectorThicknessNode).toMatchObject({ disabled: false, value: 1 });
    expect(wireframeColorNode).toMatchObject({
      disabled: false,
      value: "var(--fm-airbox-wire)",
    });

    if (
      surfaceColoringNode?.type !== "radio-group" ||
      vectorThicknessNode?.type !== "slider" ||
      wireframeColorNode?.type !== "color" ||
      visibleNode?.type !== "checkbox"
    ) {
      throw new Error("Expected selected airbox style controls");
    }

    const commandContext = { ...context, selection };
    await runRibbonNode(surfaceColoringNode, "component_x", commandContext);
    await runRibbonNode(vectorThicknessNode, 2.4, commandContext);
    await runRibbonNode(wireframeColorNode, "#ffffff", commandContext);
    await runRibbonNode(visibleNode, false, commandContext);

    expect(context.visualization.getSettings(AIRBOX_VISUALIZATION_TARGET))
      .toMatchObject({
        shaderColorMode: "x",
        surfaceColorSource: "component_x",
        vectorThickness: 2.4,
        wireframeColor: "#ffffff",
      });
    expect(patches).toEqual([
      {
        layers: {
          airbox: {
            visible: false,
          },
        },
      },
    ]);
    await vi.waitFor(() =>
      expect(invalidations).toEqual([[VISUALIZATION_STATE_PATH, 41]]),
    );
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
            opacity: 0.28,
            points: { opacity: 1, visible: false },
            surface: { opacity: 1, visible: false },
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
    const wireframeScopeNode = airboxAction?.menu?.find(
      (node) => node.type === "radio-group" && node.id === "airbox:wireframe-scope",
    );

    expect(visibleNode).toMatchObject({ checked: true });
    expect(vectorsNode).toMatchObject({ checked: false });
    expect(wireframeScopeNode).toMatchObject({
      disabled: false,
      value: "full",
    });
    if (
      visibleNode?.type !== "checkbox" ||
      vectorsNode?.type !== "checkbox" ||
      wireframeScopeNode?.type !== "radio-group"
    ) {
      throw new Error("Expected airbox display controls");
    }

    await runRibbonNode(wireframeScopeNode, "surface", context);
    await runRibbonNode(visibleNode, false, context);
    await runRibbonNode(vectorsNode, true, context);

    expect(context.visualization.getSettings(AIRBOX_VISUALIZATION_TARGET))
      .toMatchObject({ geometryScope: "surface" });
    expect(patches).toEqual([
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
    });
    const content = buildRibbonTabContent("view", context);
    const airboxAction = content?.groups
      .find((group) => group.id === "view-global-display")
      ?.actions.find((action) => action.id === "view-airbox");
    const vectorScopeNode = airboxAction?.menu?.find(
      (node) => node.type === "radio-group" && node.id === "airbox:vectors-scope",
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
    const thicknessNode = vectorSizeNode.nodes.find(
      (node) => node.type === "slider" && node.id === "airbox:vectors-thickness",
    );
    const coloringNode = vectorColorsNode.nodes.find(
      (node) => node.type === "radio-group" && node.id === "airbox:vector-coloring",
    );

    expect(densityNode).toMatchObject({ value: 128 });
    expect(vectorScopeNode).toMatchObject({ disabled: false, value: "full" });
    expect(thicknessNode).toMatchObject({ value: 1 });
    expect(coloringNode).toMatchObject({ value: "orientation" });

    if (
      densityNode?.type !== "slider" ||
      vectorScopeNode?.type !== "radio-group" ||
      thicknessNode?.type !== "slider" ||
      coloringNode?.type !== "radio-group"
    ) {
      throw new Error("Expected airbox vector controls");
    }

    await runRibbonNode(vectorScopeNode, "surface", context);
    await runRibbonNode(densityNode, 256, context);
    await runRibbonNode(thicknessNode, 1.6, context);
    await runRibbonNode(coloringNode, "x", context);

    expect(context.visualization.getSettings(AIRBOX_VISUALIZATION_TARGET))
      .toMatchObject({ geometryScope: "surface" });
    expect(patches).toEqual([
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
            vectors: {
              density: 256,
              domain: "airbox_only",
            },
          },
        },
      },
      {
        vector_style: { thickness: 1.6 },
      },
      {
        vector_style: { color_mode: "x" },
      },
    ]);
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
    const frameNode = renderAction?.menu?.find(
      (node) => node.type === "checkbox" && node.id === "selected:frame",
    );
    const wireframeNode = renderAction?.menu?.find(
      (node) => node.type === "checkbox" && node.id === "selected:wireframe",
    );

    expect(visibleNode).toMatchObject({ checked: false });
    expect(frameNode).toMatchObject({ checked: false });
    expect(wireframeNode).toMatchObject({
      checked: false,
      disabled: true,
    });

    if (
      visibleNode?.type !== "checkbox" ||
      frameNode?.type !== "checkbox" ||
      wireframeNode?.type !== "checkbox"
    ) {
      throw new Error("Expected selected airbox display controls");
    }

    const commandContext = { ...context, selection };
    await runRibbonNode(visibleNode, true, commandContext);
    await runRibbonNode(frameNode, true, commandContext);

    expect(patches).toEqual([
      {
        layers: {
          airbox: {
            visible: true,
          },
        },
      },
      {
        layers: {
          airbox: {
            bounds: {
              visible: true,
            },
          },
        },
      },
    ]);
    expect(context.visualization.getSettings(AIRBOX_VISUALIZATION_TARGET))
      .toMatchObject({ boundsVisible: false });
    await vi.waitFor(() =>
      expect(invalidations).toEqual([
        [VISUALIZATION_STATE_PATH, 41],
        [VISUALIZATION_STATE_PATH, 42],
      ]),
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
    const wireframeNode = airboxAction?.menu?.find(
      (node) => node.type === "checkbox" && node.id === "airbox:wireframe",
    );
    const shadedNode = airboxAction?.menu?.find(
      (node) => node.type === "checkbox" && node.id === "airbox:shaded",
    );
    const vectorsNode = airboxAction?.menu?.find(
      (node) => node.type === "checkbox" && node.id === "airbox:vectors",
    );

    expect(visibleNode).toMatchObject({ checked: false, disabled: false });
    expect(wireframeNode).toMatchObject({ checked: false, disabled: true });
    expect(shadedNode).toMatchObject({ checked: false, disabled: true });
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
    const hslAction = orientationGroup?.actions.find(
      (action) => action.id === "view-hsl-reference",
    );
    const displayGroup = content?.groups.find(
      (group) => group.id === "view-display",
    );
    const cameraAction = displayGroup?.actions.find(
      (action) => action.id === "view-camera",
    );
    const cameraParametersNode = cameraAction?.menu?.find(
      (node) => node.type === "item" && node.id === "camera:parameters",
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

    expect(computeGroup?.actions.some((action) => action.id === "run")).toBe(
      false,
    );
    expect(computeAction).toMatchObject({
      disabled: false,
      label: "Compute",
    });
    expect(computeAction?.splitButton).toBeUndefined();
    expect(computeAction?.menu).toBeUndefined();
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
      tooltip: "Build a shared-domain mesh before running FEM runtime commands.",
    });
    expect(studyComputeAction).toMatchObject({
      disabled: true,
      tooltip: "Build a shared-domain mesh before running FEM runtime commands.",
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
      visualization,
      visualizationSnapshot: visualization.getSnapshot(),
      visualizationState: visualizationState as VisualizationStateResource,
    },
    invalidations,
    patches,
  };
}
