import { describe, expect, it, vi } from "vitest";

import { buildViewRibbonGroups } from "../view";
import type { RibbonBuildContext } from "../../registry/ribbonRegistry";
import type { RibbonMenuNode } from "../../registry/ribbonMenuTypes";

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
    activeTransformScope: null,
    viewMode: "3D",
    sidebarVisible: true,
    previewPending: false,
    airboxVisible: false,
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
    meshRenderMode: "surface+edges",
    meshOpacity: 80,
    selectedObjectOpacity: 55,
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
      "view-selected-display",
      "view-manipulate",
      "view-snapshot-export",
      "view-display",
    ]);
  });

  it("exposes rich quantity controls and keeps disabled quantity reasons", () => {
    const group = buildViewRibbonGroups(baseContext())[0];
    const quantity = group.actions.find((action) => action.id === "view-quantity");
    expect(quantity?.menu).toBeTruthy();

    const source = findNode(quantity?.menu ?? [], "quantity:source");
    const everyN = findNode(quantity?.menu ?? [], "quantity:every-n");

    expect(source).toMatchObject({ type: "radio-group", value: "m" });
    expect(source?.type === "radio-group" ? source.items[1] : null).toMatchObject({
      value: "H_eff",
      disabled: true,
      disabledReason: "Quantity is not available for this run",
    });
    expect(everyN).toMatchObject({ type: "slider", value: 4, min: 1, max: 32 });
  });

  it("keeps selected opacity per-object rather than reading global opacity", () => {
    const selected = buildViewRibbonGroups(baseContext())[1];
    const opacity = selected.actions.find((action) => action.id === "view-selected-opacity");
    const slider = findNode(opacity?.menu ?? [], "selected-opacity:slider");

    expect(slider).toMatchObject({ type: "slider", value: 55 });
  });

  it("keeps selected display visible but disabled without selection", () => {
    const selected = buildViewRibbonGroups(baseContext({ selectedObjectId: null }))[1];
    expect(selected.actions.every((action) => action.disabled)).toBe(true);
    expect(selected.actions[0].tooltip).toBe("Select object to edit object display");
  });
});
