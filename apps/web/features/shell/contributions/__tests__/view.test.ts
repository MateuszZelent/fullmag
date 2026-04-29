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
    const vectors = findNode(sliceGroup.actions.find((action) => action.id === "view-slice-vectors")?.menu ?? [], "slice:vectors:visible");

    expect(axis).toMatchObject({ type: "radio-group", value: "y" });
    expect(mode).toMatchObject({ type: "radio-group", value: "slab" });
    expect(render).toMatchObject({ type: "radio-group", value: "heatmap" });
    expect(airbox).toMatchObject({ type: "checkbox", checked: true });
    expect(vectors).toMatchObject({ type: "checkbox", checked: true });

    axis?.onValueChange?.("x");
    expect(run).toHaveBeenCalledWith({ id: "viewport.set-slice-axis", axis: "x" });
  });

  it("keeps 2D slice controls visible but disabled outside 2D mode", () => {
    const sliceGroup = buildViewRibbonGroups(baseContext({ viewMode: "3D", slice2DEnabled: false }))[1];

    expect(sliceGroup.id).toBe("view-slice-2d");
    expect(sliceGroup.actions.every((action) => action.disabled)).toBe(true);
    expect(sliceGroup.actions[0].tooltip).toBe("Switch to 2D Slice to edit slice controls");
  });

  it("exposes rich quantity controls and keeps disabled quantity reasons", () => {
    const group = buildViewRibbonGroups(baseContext())[0];
    const texture = group.actions.find((action) => action.id === "view-texture");
    const vectors = group.actions.find((action) => action.id === "view-vectors");
    const quantity = group.actions.find((action) => action.id === "view-quantity");
    expect(texture?.menu).toBeTruthy();
    expect(vectors?.menu).toBeTruthy();
    expect(quantity?.menu).toBeTruthy();

    const source = findNode(quantity?.menu ?? [], "quantity:source");
    const shader = findNode(quantity?.menu ?? [], "quantity:overlay-visible");
    const textureVisible = findNode(texture?.menu ?? [], "texture:visible");
    const textureComponent = findNode(texture?.menu ?? [], "texture:component");
    const vectorComponent = findNode(vectors?.menu ?? [], "vectors:component");
    const vectorDensity = findNode(vectors?.menu ?? [], "vectors:density");
    const vectorColoring = findNode(quantity?.menu ?? [], "quantity:vector-coloring");

    expect(source).toMatchObject({ type: "radio-group", value: "m" });
    expect(shader).toMatchObject({ type: "checkbox", checked: true });
    expect(textureVisible).toMatchObject({ type: "checkbox", checked: true });
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

  it("shows dedicated texture actions in global and selected display groups", () => {
    const groups = buildViewRibbonGroups(baseContext({ quantityShaderVisible: false, magneticTextureVisible: true }));
    const global = groups[0];
    const selected = groups[2];

    expect(global.actions.map((action) => action.id)).toContain("view-texture");
    expect(selected.actions.map((action) => action.id)).toContain("view-selected-texture");
    expect(findNode(global.actions.find((action) => action.id === "view-texture")?.menu ?? [], "texture:visible")).toMatchObject({
      type: "checkbox",
      checked: true,
    });
    expect(findNode(selected.actions.find((action) => action.id === "view-selected-texture")?.menu ?? [], "selected-texture:visible")).toMatchObject({
      type: "checkbox",
      checked: true,
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
    expect(findNode(airbox?.menu ?? [], "airbox:render-mode")).toMatchObject({
      type: "radio-group",
      value: "surface+edges",
    });
    const renderMode = findNode(airbox?.menu ?? [], "airbox:render-mode");
    expect(renderMode?.type === "radio-group" ? renderMode.items : null).toContainEqual({
      value: "mesh",
      label: "Full mesh",
    });
    expect(findNode(airbox?.menu ?? [], "airbox:vectors-submenu")).toMatchObject({
      type: "submenu",
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
