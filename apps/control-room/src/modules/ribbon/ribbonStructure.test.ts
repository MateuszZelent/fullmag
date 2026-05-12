import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ALL_TAB_CONTENT } from "./ribbonContributions";
import { buildRibbonTabContent } from "./ribbonContributions";
import { resolveRibbonIconColor } from "./RibbonGroupsRow";
import { RIBBON_TABS } from "./ribbonTypes";
import { VISUALIZATION_STATE_PATH } from "@/kernel/api/apiPaths";
import type {
  VisualizationStatePatch,
  VisualizationStateResource,
} from "@/kernel/api/apiTypes";
import {
  AIRBOX_VISUALIZATION_TARGET,
  ObjectVisualizationController,
} from "@/kernel/visualization/ObjectVisualizationController";
import { CommandRegistry } from "@/kernel/commands/CommandRegistry";

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

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
        group.actions
          .filter((action) => action.iconColor && !resolveRibbonIconColor(action.iconColor))
          .map((action) => `${content.tabId}/${group.id}/${action.id}`),
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

  it("enables selected display controls from the object visualization registry", () => {
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
    const renderAction = selectedGroup?.actions.find(
      (action) => action.id === "view-selected-render",
    );
    const visibilityNode = renderAction?.menu?.find(
      (node) => node.type === "checkbox" && node.id === "selected:visible",
    );
    const frameNode = renderAction?.menu?.find(
      (node) => node.type === "checkbox" && node.id === "selected:frame",
    );

    expect(renderAction?.disabled).toBe(false);
    expect(visibilityNode).toMatchObject({
      checked: true,
      disabled: false,
    });
    expect(frameNode).toMatchObject({
      checked: false,
      disabled: false,
    });

    if (frameNode?.type !== "checkbox") {
      throw new Error("Expected selected frame checkbox control");
    }

    frameNode.onCheckedChange?.(true);

    expect(visualization.getSettings({ id: "free-layer", kind: "object" }))
      .toMatchObject({ boundsVisible: true });
  });

  it("wires the global Airbox ribbon menu to the airbox visualization target", () => {
    const visualization = new ObjectVisualizationController();
    const content = buildRibbonTabContent("view", {
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

    visibleNode.onCheckedChange?.(false);
    vectorsNode.onCheckedChange?.(true);

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

    expect(visibleNode).toMatchObject({ checked: true });
    expect(vectorsNode).toMatchObject({ checked: false });
    if (visibleNode?.type !== "checkbox" || vectorsNode?.type !== "checkbox") {
      throw new Error("Expected airbox checkbox controls");
    }

    visibleNode.onCheckedChange?.(false);
    vectorsNode.onCheckedChange?.(true);

    expect(patches).toEqual([
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
      ]),
    );
  });

  it("patches airbox vector controls through canonical visualization state", () => {
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
    expect(thicknessNode).toMatchObject({ value: 1 });
    expect(coloringNode).toMatchObject({ value: "orientation" });

    if (
      densityNode?.type !== "slider" ||
      thicknessNode?.type !== "slider" ||
      coloringNode?.type !== "radio-group"
    ) {
      throw new Error("Expected airbox vector controls");
    }

    densityNode.onValueChange?.(256);
    thicknessNode.onValueChange?.(1.6);
    coloringNode.onValueChange?.("x");

    expect(patches).toEqual([
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
    const content = buildRibbonTabContent("view", {
      ...context,
      selection: {
        kind: "airbox.visualization",
        label: "Airbox Visualization",
        moduleSource: "test",
        nodeId: "model:airbox:visualization",
        objectId: null,
        ref: null,
      },
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

    visibleNode.onCheckedChange?.(true);
    frameNode.onCheckedChange?.(true);

    expect(patches).toEqual([
      {
        layers: {
          airbox: {
            visible: true,
          },
        },
      },
    ]);
    expect(context.visualization.getSettings(AIRBOX_VISUALIZATION_TARGET))
      .toMatchObject({ boundsVisible: true });
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

  it("wires the global Frame ribbon menu to object and part display defaults", () => {
    const visualization = new ObjectVisualizationController();
    const content = buildRibbonTabContent("view", {
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

    expect(frameNode).toMatchObject({
      checked: false,
      disabled: false,
    });

    if (frameNode?.type !== "checkbox") {
      throw new Error("Expected object frame checkbox control");
    }

    frameNode.onCheckedChange?.(true);

    expect(visualization.getSettings({ id: "free-layer", kind: "object" }))
      .toMatchObject({ boundsVisible: true });
    expect(visualization.getSettings({ id: "part-a", kind: "part" }))
      .toMatchObject({ boundsVisible: true });
  });

  it("focuses the airbox ribbon action by selecting the airbox visualization node", () => {
    const selectionSet = vi.fn();
    const content = buildRibbonTabContent("view", {
      commandContext: {
        selection: { set: selectionSet } as never,
        source: "ribbon",
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

    focusNode.onSelect?.();

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

    sourceNode.onValueChange?.("H_demag");
    overlayNode.onCheckedChange?.(false);

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

  it("patches canonical visualization state from global Vectors controls", () => {
    const { context, patches } = createVisualizationRibbonContext({
      field_component: "magnitude",
      layers: {
        vectors: {
          density: 1200,
          domain: "auto",
          visible: false,
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
    const vectorsAction = content?.groups
      .find((group) => group.id === "view-global-display")
      ?.actions.find((action) => action.id === "view-vectors");
    const visibleNode = vectorsAction?.menu?.find(
      (node) => node.type === "checkbox" && node.id === "vectors:visible",
    );
    const densityNode = vectorsAction?.menu?.find(
      (node) => node.type === "slider" && node.id === "vectors:density",
    );

    expect(visibleNode).toMatchObject({ checked: false });
    expect(densityNode).toMatchObject({ value: 1200 });
    if (visibleNode?.type !== "checkbox" || densityNode?.type !== "slider") {
      throw new Error("Expected vector visibility and density controls");
    }

    visibleNode.onCheckedChange?.(true);
    densityNode.onValueChange?.(2048);

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
  });

  it("patches canonical visualization state from global Mesh View controls", () => {
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

    renderModeNode.onValueChange?.("points");
    opacityNode.onValueChange?.(45);

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
    const orientationGroup = content?.groups.find(
      (group) => group.id === "view-orientation-tools",
    );
    const viewCubeAction = orientationGroup?.actions.find(
      (action) => action.id === "viewport-3d.toggle-viewcube",
    );
    const hslAction = orientationGroup?.actions.find(
      (action) => action.id === "view-hsl-reference",
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

  return {
    context: {
      api: {
        visualization: {
          patch: async (patch: VisualizationStatePatch) => {
            patches.push(patch);
            return {
              ...visualizationState,
              revision: 40 + patches.length,
            } as VisualizationStateResource;
          },
        },
      },
      resources: {
        invalidate: (resourceKey: string, revision: number | string) => {
          invalidations.push([resourceKey, revision]);
        },
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
      visualizationState: visualizationState as VisualizationStateResource,
    },
    invalidations,
    patches,
  };
}
