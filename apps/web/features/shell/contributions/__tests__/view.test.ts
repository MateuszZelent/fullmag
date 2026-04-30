import { describe, expect, it, vi } from "vitest";

import { buildViewRibbonGroups } from "../view";
import type { RibbonBuildContext } from "../../registry/ribbonRegistry";
import type { RibbonMenuNode } from "../../registry/ribbonMenuTypes";
import type { Slice2DToolbarState } from "@/src/features/slice2d";

const slice2DToolbar: Slice2DToolbarState = {
  quantityId: "m",
  component: "magnitude",
  axis: "z",
  mode: "single",
  layerIndex: 0,
  positionPercent: 50,
  thicknessPercent: null,
  colormap: "viridis",
  autoContrast: true,
  showPrimitives: true,
  showMesh: true,
  showMagneticTexture: true,
  showAirbox: false,
  airboxRenderMode: "wireframe",
  showAirboxVectors: false,
  showQuantity: true,
  showVectors: true,
  renderMode: "heatmap",
};

function baseContext(overrides: Partial<RibbonBuildContext> = {}): RibbonBuildContext {
  return {
    isFemBackend: true,
    domainCapabilities: null,
    canRun: true,
    canRelax: true,
    canPause: false,
    canStop: false,
    canSkip: false,
    runAction: "run",
    runLabel: "Run",
    meshGenerating: false,
    meshConfigDirty: false,
    meshTargetLabel: null,
    selectedObjectId: "obj-1",
    selectedNodeId: null,
    selectedNodeKind: null,
    objectViewMode: "context",
    activeTransformScope: null,
    viewMode: "3D",
    sidebarVisible: true,
    previewPending: false,
    viewport3DStatus: "active",
    viewport3DStatusReason: "3D visualization is active.",
    viewport3DStatusDetail: "FEM mesh: 2048 nodes, 12881 elements.",
    airboxVisible: false,
    quantityShaderVisible: true,
    viewportAxesScope: "universe",
    universeWireframeVisible: true,
    viewportLegendVisible: false,
    studyNodeContext: null,
    quickPreviewTargets: [
      { id: "m", shortLabel: "m", available: true },
      { id: "H_eff", shortLabel: "H_eff", available: false },
    ],
    selectedQuantity: "m",
    requestedPreviewComponent: "3D",
    requestedPreviewEveryN: 4,
    requestedPreviewAutoScale: true,
    requestedPreviewQuantityDataStatus: "ready",
    primitiveVisible: true,
    magneticTextureVisible: true,
    magneticTextureDensity: 65_536,
    femVectorGlyphBudget: 1_200,
    meshRenderMode: "surface+edges",
    meshOpacity: 80,
    selectedObjectTextureVisible: true,
    selectedObjectOpacity: 55,
    selectedObjectRenderMode: "inherit",
    meshClipEnabled: false,
    meshClipAxis: "z",
    meshClipPos: 50,
    meshClipFlip: false,
    meshShowArrows: true,
    femArrowColorMode: "orientation",
    femArrowMonoColor: "#38d9ff",
    femArrowAlpha: 0.8,
    femArrowLengthScale: 1.2,
    femArrowThickness: 1.1,
    femVectorDomainFilter: "auto",
    femFerromagnetVisibilityMode: "ghost",
    airMeshOpacity: 28,
    airMeshRenderMode: "surface+edges",
    airMeshGeometryVisible: true,
    airMeshSurfaceVisible: true,
    airMeshWireframeVisible: true,
    airMeshPointsVisible: false,
    airMeshWireframeScope: "surface",
    airMeshPointsScope: "surface",
    airMeshVectorsScope: "surface",
    slice2DEnabled: false,
    slice2DToolbar,
    slice2DDiagnostics: null,
    antennaSources: [],
    selectedAntennaName: null,
    canSyncScriptBuilder: false,
    scriptSyncBusy: false,
    run: vi.fn(),
    can: vi.fn(() => true),
    builderEnabled: true,
    builderDirtyGeometry: false,
    builderDirtyMesh: false,
    builderHasRealization: true,
    builderSceneObjectCount: 1,
    builderSelectedPrimitiveId: "prim-1",
    geometryCapabilities: null,
    ...overrides,
  };
}

function findNode(nodes: RibbonMenuNode[], id: string): RibbonMenuNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.type === "submenu") {
      const nested = findNode(node.nodes, id);
      if (nested) return nested;
    }
  }
  return null;
}

describe("View ribbon contribution", () => {
  it("builds the five target VIEW groups", () => {
    const groups = buildViewRibbonGroups(baseContext());
    expect(groups.map((group) => group.id)).toEqual([
      "view-global-display",
      "view-slice-2d",
      "view-selected-display",
      "view-manipulate",
      "view-snapshot-export",
      "view-display",
    ]);
  });

  it("exposes 2D slice controls through the View ribbon", () => {
    const run = vi.fn();
    const sliceGroup = buildViewRibbonGroups(
      baseContext({
        run,
        viewMode: "2D",
        slice2DEnabled: true,
        slice2DToolbar: { ...slice2DToolbar, axis: "y", mode: "slab", showAirbox: true },
      }),
    )[1];

    expect(sliceGroup.id).toBe("view-slice-2d");
    expect(sliceGroup.actions.every((action) => !action.disabled)).toBe(true);

    const axis = findNode(sliceGroup.actions.find((action) => action.id === "view-slice-plane")?.menu ?? [], "slice:plane:axis");
    const mode = findNode(sliceGroup.actions.find((action) => action.id === "view-slice-plane")?.menu ?? [], "slice:plane:mode");
    expect(sliceGroup.actions.map((action) => action.id)).toEqual([
      "view-slice-quantity",
      "view-slice-vectors",
      "view-slice-airbox",
      "view-slice-layers",
      "view-slice-plane",
    ]);

    const render = findNode(sliceGroup.actions.find((action) => action.id === "view-slice-layers")?.menu ?? [], "slice:layers:render-mode");
    const airbox = findNode(sliceGroup.actions.find((action) => action.id === "view-slice-airbox")?.menu ?? [], "slice:airbox:visible");
    const airboxRender = findNode(sliceGroup.actions.find((action) => action.id === "view-slice-airbox")?.menu ?? [], "slice:airbox:render-mode");
    const vectors = findNode(sliceGroup.actions.find((action) => action.id === "view-slice-vectors")?.menu ?? [], "slice:vectors:visible");

    expect(axis).toMatchObject({ type: "radio-group", value: "y" });
    expect(mode).toMatchObject({ type: "radio-group", value: "slab" });
    expect(render).toMatchObject({ type: "radio-group", value: "heatmap" });
    expect(airbox).toMatchObject({ type: "checkbox", checked: true });
    expect(airboxRender).toMatchObject({ type: "radio-group", value: "wireframe" });
    expect(vectors).toMatchObject({ type: "checkbox", checked: true });

    axis?.onValueChange?.("x");
    expect(run).toHaveBeenCalledWith({ id: "viewport.set-slice-axis", axis: "x" });
  });

  it("keeps 2D airbox controls off the 3D airbox command path", () => {
    const run = vi.fn();
    const sliceGroup = buildViewRibbonGroups(
      baseContext({
        run,
        viewMode: "2D",
        slice2DEnabled: true,
        slice2DToolbar: {
          ...slice2DToolbar,
          showAirbox: true,
          airboxRenderMode: "wireframe",
        },
      }),
    )[1];
    const menu = sliceGroup.actions.find((action) => action.id === "view-slice-airbox")?.menu ?? [];
    const visible = findNode(menu, "slice:airbox:visible");
    const renderMode = findNode(menu, "slice:airbox:render-mode");
    const vectors = findNode(menu, "slice:airbox:vectors");

    if (
      visible?.type !== "checkbox" ||
      renderMode?.type !== "radio-group" ||
      vectors?.type !== "checkbox"
    ) {
      throw new Error("2D airbox controls missing");
    }

    visible.onCheckedChange(false);
    renderMode.onValueChange("points");
    vectors.onCheckedChange(true);

    expect(run).toHaveBeenNthCalledWith(1, {
      id: "viewport.set-slice-airbox",
      visible: false,
    });
    expect(run).toHaveBeenNthCalledWith(2, {
      id: "viewport.set-slice-airbox-render-mode",
      renderMode: "points",
    });
    expect(run).toHaveBeenNthCalledWith(3, {
      id: "viewport.set-slice-airbox-vectors",
      visible: true,
    });
    expect(run).not.toHaveBeenCalledWith(expect.objectContaining({
      id: "viewport.set-airbox-display",
    }));
  });

  it("keeps 2D slice controls visible but disabled outside 2D mode", () => {
    const sliceGroup = buildViewRibbonGroups(baseContext({ viewMode: "3D", slice2DEnabled: false }))[1];

    expect(sliceGroup.id).toBe("view-slice-2d");
    expect(sliceGroup.actions.every((action) => action.disabled)).toBe(true);
    expect(sliceGroup.actions[0].tooltip).toBe("Switch to 2D Slice to edit slice controls");
  });

  it("exposes rich quantity controls and keeps disabled quantity reasons", () => {
    const group = buildViewRibbonGroups(baseContext())[0];
    const viewportStatus = group.actions.find((action) => action.id === "view-3d-status");
    const texture = group.actions.find((action) => action.id === "view-primitive");
    const vectors = group.actions.find((action) => action.id === "view-vectors");
    const quantity = group.actions.find((action) => action.id === "view-quantity");
    expect(viewportStatus).toMatchObject({
      label: "3D Active",
      active: true,
      tooltip: "3D visualization is active.",
    });
    expect(findNode(viewportStatus?.menu ?? [], "3d-status:reason")).toMatchObject({
      type: "status",
      value: "3D visualization is active.",
      tone: "success",
    });
    expect(texture?.menu).toBeTruthy();
    expect(vectors?.menu).toBeTruthy();
    expect(quantity?.menu).toBeTruthy();

    const source = findNode(quantity?.menu ?? [], "quantity:source");
    const shader = findNode(quantity?.menu ?? [], "quantity:overlay-visible");
    const primitiveVisible = findNode(texture?.menu ?? [], "primitive:visible");
    const textureVisible = findNode(texture?.menu ?? [], "primitive:texture-visible");
    const textureComponent = findNode(texture?.menu ?? [], "primitive:texture-component");
    const vectorComponent = findNode(vectors?.menu ?? [], "vectors:component");
    const vectorDensity = findNode(vectors?.menu ?? [], "vectors:density");
    const vectorColoring = findNode(quantity?.menu ?? [], "quantity:vector-coloring");

    expect(source).toMatchObject({ type: "radio-group", value: "m" });
    expect(shader).toMatchObject({ type: "checkbox", checked: true });
    expect(primitiveVisible).toMatchObject({ type: "checkbox", checked: true });
    expect(textureVisible).toMatchObject({ type: "checkbox", checked: true });
    expect(texture).toMatchObject({ label: "Primitive" });
    expect(findNode(quantity?.menu ?? [], "quantity:component")).toBeNull();
    expect(findNode(quantity?.menu ?? [], "quantity:every-n")).toBeNull();
    expect(textureComponent).toMatchObject({ type: "radio-group", value: "3D" });
    expect(vectorComponent).toMatchObject({ type: "radio-group", value: "3D" });
    expect(vectorDensity).toMatchObject({ type: "slider", value: 1200, min: 8, max: 4096 });
    expect(vectorColoring).toMatchObject({ type: "radio-group", value: "orientation" });
    expect(source?.type === "radio-group" ? source.items[1] : null).toMatchObject({
      value: "H_eff",
      disabled: true,
      disabledReason: "Quantity is not available for this run",
    });
  });

  it("keeps selected opacity per-object rather than reading global opacity", () => {
    const selected = buildViewRibbonGroups(baseContext())[2];
    const opacity = selected.actions.find((action) => action.id === "view-selected-opacity");
    const slider = findNode(opacity?.menu ?? [], "selected-opacity:slider");

    expect(slider).toMatchObject({ type: "slider", value: 55 });
  });

  it("exposes object context and isolate controls in the display group", () => {
    const display = buildViewRibbonGroups(baseContext({ viewMode: "2D", objectViewMode: "isolate" }))[5];

    expect(display.actions.map((action) => action.id)).toContain("view-object-context");
    expect(display.actions.map((action) => action.id)).toContain("view-object-isolate");
    expect(display.actions.find((action) => action.id === "view-object-context")).toMatchObject({
      disabled: false,
      active: false,
    });
    expect(display.actions.find((action) => action.id === "view-object-isolate")).toMatchObject({
      disabled: false,
      active: true,
    });
  });

  it("exposes a direct dimension frame toggle in the display group", () => {
    const run = vi.fn();
    const display = buildViewRibbonGroups(baseContext({ run, universeWireframeVisible: true }))[5];
    const frame = display.actions.find((action) => action.id === "view-dimension-frame");
    const axes = display.actions.find((action) => action.id === "view-axes");

    expect(frame).toMatchObject({
      label: "Frame",
      active: true,
    });
    expect(findNode(axes?.menu ?? [], "axes:wireframe")).toMatchObject({
      type: "checkbox",
      label: "Dimension frame",
      checked: true,
    });

    frame?.action?.();

    expect(run).toHaveBeenCalledWith({ id: "viewport.toggle-universe-wireframe" });
  });

  it("shows separate primitive and texture toggles in global display", () => {
    const groups = buildViewRibbonGroups(baseContext({ quantityShaderVisible: false, magneticTextureVisible: true }));
    const global = groups[0];
    const selected = groups[2];

    expect(global.actions.map((action) => action.id)).toContain("view-primitive");
    expect(selected.actions.map((action) => action.id)).toContain("view-selected-texture");
    expect(findNode(global.actions.find((action) => action.id === "view-primitive")?.menu ?? [], "primitive:visible")).toMatchObject({
      type: "checkbox",
      checked: true,
    });
    expect(findNode(global.actions.find((action) => action.id === "view-primitive")?.menu ?? [], "primitive:texture-visible")).toMatchObject({
      type: "checkbox",
      checked: true,
    });
    expect(findNode(selected.actions.find((action) => action.id === "view-selected-texture")?.menu ?? [], "selected-texture:visible")).toMatchObject({
      type: "checkbox",
      checked: true,
    });
  });

  it("dispatches primitive and texture toggles through separate commands", () => {
    const run = vi.fn();
    const global = buildViewRibbonGroups(baseContext({ run }))[0];
    const primitive = global.actions.find((action) => action.id === "view-primitive");
    const primitiveVisible = findNode(primitive?.menu ?? [], "primitive:visible");
    const textureVisible = findNode(primitive?.menu ?? [], "primitive:texture-visible");

    if (primitiveVisible?.type !== "checkbox" || textureVisible?.type !== "checkbox") {
      throw new Error("Expected primitive and texture visibility checkboxes");
    }

    primitiveVisible.onCheckedChange?.(false);
    textureVisible.onCheckedChange?.(false);

    expect(run).toHaveBeenCalledWith({ id: "viewport.toggle-primitives", visible: false });
    expect(run).toHaveBeenCalledWith({ id: "viewport.toggle-magnetic-texture", visible: false });
  });

  it("shows inactive 3D visualization reasons in the View ribbon", () => {
    const group = buildViewRibbonGroups(baseContext({
      viewport3DStatus: "inactive",
      viewport3DStatusReason: "All 3D layers are disabled.",
      viewport3DStatusDetail: "Enable Primitive, Mesh View, Quantity, Texture, Vectors, or Airbox.",
    }))[0];
    const viewportStatus = group.actions.find((action) => action.id === "view-3d-status");

    expect(viewportStatus).toMatchObject({
      label: "3D Inactive",
      active: false,
      tooltip: "All 3D layers are disabled.",
    });
    expect(findNode(viewportStatus?.menu ?? [], "3d-status:reason")).toMatchObject({
      type: "status",
      label: "Hidden reason",
      value: "All 3D layers are disabled.",
      tone: "danger",
    });
    expect(findNode(viewportStatus?.menu ?? [], "3d-status:detail")).toMatchObject({
      type: "status",
      value: "Enable Primitive, Mesh View, Quantity, Texture, Vectors, or Airbox.",
    });
  });

  it("keeps selected display visible but disabled without selection", () => {
    const selected = buildViewRibbonGroups(baseContext({ selectedObjectId: null }))[2];
    expect(selected.actions.every((action) => action.disabled)).toBe(true);
    expect(selected.actions[0].tooltip).toBe("Select object to edit object display");
  });

  it("disables isolate in the display group when no object is selected", () => {
    const display = buildViewRibbonGroups(baseContext({ selectedObjectId: null }))[5];
    const isolate = display.actions.find((action) => action.id === "view-object-isolate");

    expect(isolate).toMatchObject({
      disabled: true,
      tooltip: "Select object to isolate it",
    });
  });

  it("exposes independent airbox shaded wireframe points and vector controls", () => {
    const global = buildViewRibbonGroups(baseContext({ airboxVisible: true }))[0];
    const airbox = global.actions.find((action) => action.id === "view-airbox");

    expect(findNode(airbox?.menu ?? [], "airbox:points-section")).toMatchObject({
      type: "label",
      label: "Points",
      badge: "off",
    });
    expect(findNode(airbox?.menu ?? [], "airbox:vectors-section")).toMatchObject({
      type: "label",
      label: "Vectors",
      badge: "off",
    });
    expect(findNode(airbox?.menu ?? [], "airbox:shaded")).toMatchObject({
      type: "checkbox",
      checked: true,
    });
    expect(findNode(airbox?.menu ?? [], "airbox:wireframe")).toMatchObject({
      type: "checkbox",
      checked: true,
    });
    expect(findNode(airbox?.menu ?? [], "airbox:points")).toMatchObject({
      type: "checkbox",
      checked: false,
    });
    expect(findNode(airbox?.menu ?? [], "airbox:vectors")).toMatchObject({
      type: "checkbox",
      checked: false,
    });
    expect(findNode(airbox?.menu ?? [], "airbox:wireframe-scope")).toMatchObject({
      type: "radio-group",
      value: "surface",
    });
    expect(findNode(airbox?.menu ?? [], "airbox:points-scope")).toMatchObject({
      type: "radio-group",
      value: "surface",
      disabled: true,
      disabledReason: "Enable Airbox points first",
    });
    expect(findNode(airbox?.menu ?? [], "airbox:vectors-scope")).toMatchObject({
      type: "radio-group",
      value: "surface",
      disabled: true,
      disabledReason: "Enable Airbox vectors first",
    });
    expect(findNode(airbox?.menu ?? [], "airbox:vectors-submenu")).toMatchObject({
      type: "submenu",
    });
  });

  it("dispatches independent airbox points and vectors toggles", () => {
    const run = vi.fn();
    const global = buildViewRibbonGroups(baseContext({ airboxVisible: true, run }))[0];
    const airbox = global.actions.find((action) => action.id === "view-airbox");

    const points = findNode(airbox?.menu ?? [], "airbox:points");
    const vectors = findNode(airbox?.menu ?? [], "airbox:vectors");

    if (points?.type !== "checkbox" || vectors?.type !== "checkbox") {
      throw new Error("Airbox point/vector toggles missing");
    }

    points.onCheckedChange(true);
    vectors.onCheckedChange(true);

    expect(run).toHaveBeenNthCalledWith(1, {
      id: "viewport.set-airbox-display",
      patch: { points: true },
    });
    expect(run).toHaveBeenNthCalledWith(2, {
      id: "viewport.set-airbox-display",
      patch: { vectors: true },
    });
  });

  it("shows airbox points independently from shaded and wireframe when render mode cannot encode it", () => {
    const global = buildViewRibbonGroups(baseContext({
      airboxVisible: true,
      airMeshRenderMode: "surface+edges",
      airMeshSurfaceVisible: true,
      airMeshWireframeVisible: true,
      airMeshPointsVisible: true,
      airMeshPointsScope: "full",
    }))[0];
    const airbox = global.actions.find((action) => action.id === "view-airbox");

    expect(findNode(airbox?.menu ?? [], "airbox:header")).toMatchObject({
      badge: "points/full + wire/surface + shaded",
    });
    expect(findNode(airbox?.menu ?? [], "airbox:shaded")).toMatchObject({
      checked: true,
    });
    expect(findNode(airbox?.menu ?? [], "airbox:wireframe")).toMatchObject({
      checked: true,
    });
    expect(findNode(airbox?.menu ?? [], "airbox:points")).toMatchObject({
      checked: true,
    });
    expect(findNode(airbox?.menu ?? [], "airbox:points-scope")).toMatchObject({
      disabled: false,
      value: "full",
    });
  });

  it("dispatches airbox full extent patches for wireframe points and vectors", () => {
    const run = vi.fn();
    const global = buildViewRibbonGroups(
      baseContext({
        airboxVisible: true,
        airMeshRenderMode: "points",
        femVectorDomainFilter: "airbox_only",
        meshShowArrows: true,
        run,
      }),
    )[0];
    const airbox = global.actions.find((action) => action.id === "view-airbox");

    const wireframeScope = findNode(airbox?.menu ?? [], "airbox:wireframe-scope");
    const pointsScope = findNode(airbox?.menu ?? [], "airbox:points-scope");
    const vectorsScope = findNode(airbox?.menu ?? [], "airbox:vectors-scope");

    if (wireframeScope?.type !== "radio-group" || pointsScope?.type !== "radio-group" || vectorsScope?.type !== "radio-group") {
      throw new Error("Airbox extent controls missing");
    }

    wireframeScope.onValueChange("full");
    pointsScope.onValueChange("full");
    vectorsScope.onValueChange("full");

    expect(run).toHaveBeenNthCalledWith(1, {
      id: "viewport.set-airbox-display",
      patch: { wireframeScope: "full" },
    });
    expect(run).toHaveBeenNthCalledWith(2, {
      id: "viewport.set-airbox-display",
      patch: { pointsScope: "full" },
    });
    expect(run).toHaveBeenNthCalledWith(3, {
      id: "viewport.set-airbox-display",
      patch: { vectorsScope: "full" },
    });
  });

  it("shows independent points and vectors extents in the airbox badge", () => {
    const global = buildViewRibbonGroups(
      baseContext({
        airboxVisible: true,
        airMeshRenderMode: "points",
        airMeshSurfaceVisible: false,
        airMeshWireframeVisible: false,
        airMeshPointsVisible: true,
        airMeshPointsScope: "full",
        airMeshVectorsScope: "surface",
        femVectorDomainFilter: "airbox_only",
        meshShowArrows: true,
      }),
    )[0];
    const airbox = global.actions.find((action) => action.id === "view-airbox");

    expect(findNode(airbox?.menu ?? [], "airbox:header")).toMatchObject({
      type: "label",
      badge: "points/full + vectors/surface",
    });
  });

  it("tracks airbox vector checkbox by domain and global vector visibility", () => {
    const globalWithAirboxVectors = buildViewRibbonGroups(
      baseContext({ femVectorDomainFilter: "airbox_only", meshShowArrows: false, airboxVisible: true }),
    )[0];
    const airboxWithAirboxVectors = globalWithAirboxVectors.actions.find((action) => action.id === "view-airbox");

    expect(findNode(airboxWithAirboxVectors?.menu ?? [], "airbox:vectors")).toMatchObject({
      type: "checkbox",
      checked: false,
    });

    const globalWithAirboxVectorsVisible = buildViewRibbonGroups(
      baseContext({ femVectorDomainFilter: "airbox_only", meshShowArrows: true, airboxVisible: true }),
    )[0];
    const airboxWithAirboxVectorsVisible = globalWithAirboxVectorsVisible.actions.find((action) => action.id === "view-airbox");

    expect(findNode(airboxWithAirboxVectorsVisible?.menu ?? [], "airbox:vectors")).toMatchObject({
      type: "checkbox",
      checked: true,
    });
  });

  it("enables selected render mode controls and dispatches the selected-render command", () => {
    const run = vi.fn();
    const selected = buildViewRibbonGroups(baseContext({ run, selectedObjectRenderMode: "wireframe" }))[2];
    const render = findNode(selected.actions.find((action) => action.id === "view-selected-render")?.menu ?? [], "selected:render-mode");
    expect(render).toMatchObject({
      type: "radio-group",
      disabled: false,
      value: "wireframe",
    });
    expect((render as any).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "inherit" }),
        expect.objectContaining({ value: "surface" }),
        expect.objectContaining({ value: "wireframe" }),
        expect.objectContaining({ value: "surface+edges" }),
        expect.objectContaining({ value: "points" }),
      ]),
    );

    render?.onValueChange?.("points");
    expect(run).toHaveBeenCalledWith({ id: "viewport.set-selected-render-mode", renderMode: "points" });
  });
});
