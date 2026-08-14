import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  discretization: "fdm",
  planarActivate: null as (() => void) | null,
  queuePatch: vi.fn(),
  resourceCalls: [] as Array<{ enabled: boolean; name: string }>,
}));

function resourceCall(name: string, enabled: boolean): void {
  testState.resourceCalls.push({ enabled, name });
}

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => ({
    resources: {
      getRevision: () => null,
      subscribe: () => () => undefined,
    },
    visualizationSync: {
      queuePatch: testState.queuePatch,
    },
  }),
}));

vi.mock("@/kernel/resources/useSessionStatus", () => ({
  useSessionStatusSelector: (selector: (status: unknown) => unknown) =>
    selector({
      data: {
        capabilities: { explicit_topology: true },
        domain: { discretization: testState.discretization },
        resources: { domain_generation_id: 1, mesh_revision: 1 },
      },
    }),
}));

vi.mock("@/kernel/resources/studyRuntimeResources", () => ({
  shouldLoadRuntimeMeshManifest: () => true,
  useFieldCatalogResource: ({ enabled }: { enabled: boolean }) => {
    resourceCall("field-catalog", enabled);
    return { data: null, error: null, revision: null, status: "idle" };
  },
}));

vi.mock("@/kernel/visualization/useVisualizationStateResource", () => ({
  useVisualizationStateResource: ({ enabled = true }: { enabled?: boolean } = {}) => {
    resourceCall("visualization-state", enabled);
    return {
      data: enabled ? {
        overrides: [],
        planar: {
          active_monitor_id: "plane-1",
          component: "magnitude",
          layers: { boundaries: false, contours: false, mesh: false, probes: false, raster: true, vectors: true },
          quality: "interactive",
          quantity_id: "m",
          resolution: { height: 256, vector_budget: 512, width: 512 },
          vector_style: { color_mode: "orientation", length_mode: "uniform", scale: 1 },
          interaction: { pan_u_m: 0, pan_v_m: 0, zoom: 1 },
          colormap: "viridis",
          view_scope: { kind: "monitor_target" },
        },
        revision: 1,
      } : null,
      error: null,
      rawData: null,
      revision: 1,
      status: enabled ? "ready" : "idle",
    };
  },
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
  useFdmMultilayerLayoutResource: () => ({
    data: null,
    error: null,
    revision: null,
    status: "idle",
  }),
  useDomainMetaResource: ({ enabled }: { enabled: boolean }) => {
    resourceCall("domain-meta", enabled);
    return {
      data: enabled
        ? {
            bounds: { max: [1, 1, 1], min: [0, 0, 0] },
            discretization: "fdm",
            domain_id: "domain-1",
            generation_id: "generation-1",
            grid: { origin: [0, 0, 0], shape: [1, 1, 1], spacing: [1, 1, 1] },
            units: { length: "m" },
          }
        : null,
      error: null,
      revision: 1,
      status: enabled ? "ready" : "idle",
    };
  },
  useFdmRegionMembershipResource: ({ enabled }: { enabled: boolean }) => {
    resourceCall("fdm-membership", enabled);
    return {
      data: enabled
        ? {
            cell_count: 1,
            freshness: "current",
            grid_fingerprint: "grid-1",
          }
        : null,
      error: null,
      revision: 1,
      status: enabled ? "ready" : "idle",
    };
  },
  useFdmRegionMembershipBinaryResource: (
    _regionId: string | null,
    { enabled }: { enabled: boolean },
  ) => {
    resourceCall("fdm-membership-binary", enabled);
    return {
      availability: enabled
        ? { reason: "loading", status: "pending" }
        : { reason: "loading", status: "pending" },
      data: null,
      error: null,
      revision: null,
      status: enabled ? "idle" : "idle",
    };
  },
  useMeshRegionMembershipResource: (
    _ownerObjectId: string | null | undefined,
    _regionId: string | null | undefined,
    { enabled }: { enabled: boolean },
  ) => {
    resourceCall("region-memberships", enabled);
    return { data: null, error: null, revision: null, status: "idle" };
  },
  useMeshSharedDomainManifestResource: ({ enabled }: { enabled: boolean }) => {
    resourceCall("shared-domain-manifest", enabled);
    return { data: null, error: null, revision: null, status: "idle" };
  },
  useSceneResource: ({ enabled }: { enabled: boolean }) => {
    resourceCall("scene", enabled);
    return { data: null, error: null, revision: null, status: "idle" };
  },
}));

vi.mock("@/kernel/visualization/useObjectVisualization", () => ({
  useObjectVisualizationController: () => ({
    clearTarget: vi.fn(),
    patchTarget: vi.fn(),
    patchTargetPending: vi.fn(),
    patchViewportPreferences: vi.fn(),
  }),
  useObjectVisualizationSelector: (selector: (snapshot: unknown) => unknown) =>
    selector({
      defaults: {},
      overrides: {},
      pendingOverrides: {},
      version: 1,
      viewportPreferenceDefaults: {},
      viewportPreferences: {},
    }),
}));

vi.mock("@/kernel/selection/visualizationTargetResolver", () => ({
  visualizationSceneObjectIds: () => new Set<string>(),
}));
vi.mock("@/kernel/layout/useLayout", () => ({
  useLayoutSelector: (selector: (layout: unknown) => unknown) =>
    selector({ activeModuleTab: "model" }),
}));
vi.mock("@/modules/viewport-3d/public", () => ({
  manifestRenderableCarriers: () => [],
}));
vi.mock("../primitives/FieldRow", () => ({
  FieldRow: ({ label, value }: { label: React.ReactNode; value: React.ReactNode }) => (
    <div>{label}:{value}</div>
  ),
}));
vi.mock("../primitives/FeedbackBanner", () => ({ FeedbackBanner: () => null }));
vi.mock("../primitives/InspectorGroup", () => ({
  InspectorGroup: ({
    children,
    title,
  }: {
    children?: React.ReactNode;
    title?: React.ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}));
vi.mock("./ObjectVisualizationOverview", () => ({
  ObjectVisualizationOverview: () => null,
}));
vi.mock("../visualization/PlanarVisualizationSection", () => ({
  PlanarVisualizationSection: () => null,
}));
vi.mock("../visualization/VisualizationContextSwitch", () => ({
  VisualizationContextSwitch: () => null,
  VisualizationContextSwitchControl: ({ onPlanarActivate }: { onPlanarActivate?: () => void }) => {
    testState.planarActivate = onPlanarActivate ?? null;
    return null;
  },
  useVisualizationViewContext: () => "3d",
}));
vi.mock("./ObjectVisualizationTargetSection", () => {
  const Component = () => null;
  return {
    ColorField: Component,
    VisualizationDisplayPassesSection: Component,
    VisualizationGeometryScopeSection: Component,
    VisualizationOverridesSection: Component,
    VisualizationPointsSection: Component,
    VisualizationQuantitySection: Component,
    VisualizationRadioGroup: Component,
    VisualizationRenderModeSection: Component,
    VisualizationSurfaceColoringSection: Component,
    VisualizationToggleButton: Component,
    VisualizationVectorsSection: Component,
    VisualizationWireframeSection: Component,
  };
});

import type { Selection } from "@/kernel/selection/selectionTypes";
import { resolveInspectorPanel } from "../inspectorRegistry";
import { ObjectVisualizationPanel } from "./ObjectVisualizationPanel";

const selection: Selection = {
  kind: "object.visualization",
  label: "Film visualization",
  moduleSource: "inspector",
  nodeId: "model:object:film:visualization",
  objectId: "film",
  ref: {
    kind: "object.visualization",
    nodeId: "model:object:film:visualization",
    objectId: "film",
    type: "scene-object",
    visualizationTargetId: "object:film",
  },
};

const airboxSelection: Selection = {
  kind: "airbox.visualization",
  label: "Airbox visualization",
  moduleSource: "inspector",
  nodeId: "model:universe:airbox:visualization",
  objectId: null,
  ref: {
    kind: "airbox.visualization",
    nodeId: "model:universe:airbox:visualization",
    type: "airbox",
    visualizationTargetId: "airbox",
  },
};

const airboxDebugSelection: Selection = {
  kind: "airbox.visualization.debug",
  label: "Airbox visualization debug",
  moduleSource: "inspector",
  nodeId: "model:airbox:visualization:debug",
  objectId: null,
  ref: {
    kind: "airbox.visualization.debug",
    nodeId: "model:airbox:visualization:debug",
    type: "airbox",
    visualizationTargetId: "airbox",
  },
};

const objectDebugSelection: Selection = {
  kind: "object.visualization.debug",
  label: "Film visualization debug",
  moduleSource: "inspector",
  nodeId: "model:object:film:visualization:debug",
  objectId: "film",
  ref: {
    kind: "object.visualization.debug",
    nodeId: "model:object:film:visualization:debug",
    objectId: "film",
    type: "scene-object",
    visualizationTargetId: "object:film",
  },
};

const objectRegionDebugSelection: Selection = {
  kind: "object.region.visualization.debug",
  label: "Film core visualization debug",
  moduleSource: "inspector",
  nodeId: "model:object:film:regions:core:visualization:debug",
  objectId: "film",
  ref: {
    kind: "object.region.visualization.debug",
    nodeId: "model:object:film:regions:core:visualization:debug",
    objectId: "film",
    regionId: "core",
    type: "scene-object",
    visualizationTargetId: "region:film:core",
  },
};

const meshPartSelection: Selection = {
  kind: "mesh-part",
  label: "Film volume",
  moduleSource: "inspector",
  nodeId: "resources:mesh:part:film-volume",
  objectId: "film",
  ref: {
    carrierPartId: "film-volume",
    kind: "mesh-part",
    nodeId: "resources:mesh:part:film-volume",
    objectId: "film",
    type: "mesh-part",
    visualizationTargetId: "part:film-volume",
  },
};

function renderResolvedInspector(selectionValue: Selection): string {
  const contribution = resolveInspectorPanel({ kind: selectionValue.kind });
  if (!contribution) throw new Error(`Missing route for ${selectionValue.kind}`);
  const Component = contribution.component;
  return renderToStaticMarkup(<Component selection={selectionValue} />);
}

describe("ObjectVisualizationPanel lane routing", () => {
  it("gives object, Airbox, and mesh-part routes distinct owner identities", () => {
    testState.discretization = "fdm";

    const object = renderResolvedInspector(selection);
    expect(object).toContain('data-inspector-owner="object.visualization"');
    expect(object).toContain("Object visualization");
    expect(object).toContain("Target scope:Magnetic object");
    expect(object).toContain("Target ID:object:film");
    expect(object).toContain("canonical object visualization target");
    expect(object).toContain("Display passes, quantity, vectors, wireframe");

    const airbox = renderResolvedInspector(airboxSelection);
    expect(airbox).toContain('data-inspector-owner="airbox.visualization"');
    expect(airbox).toContain("Airbox visualization");
    expect(airbox).toContain("Target scope:Airbox");
    expect(airbox).toContain("Target ID:fdm-domain");
    expect(airbox).toContain("Airbox-specific bounds and field support");
    expect(airbox).toContain("Airbox extent, display passes, field quantity");

    const meshPart = renderResolvedInspector(meshPartSelection);
    expect(meshPart).toContain('data-inspector-owner="mesh-part.visualization"');
    expect(meshPart).toContain("Mesh-part visualization");
    expect(meshPart).toContain("Target scope:Mesh part");
    expect(meshPart).toContain("Target ID:part:film-volume");
    expect(meshPart).toContain("canonical mesh-part target");
    expect(meshPart).toContain("Part visibility, render mode, vectors, wireframe");
  });

  it("gives every visualization debug route its own owner component", () => {
    const debugKinds = [
      "airbox.visualization.debug",
      "object.visualization.debug",
      "object.region.visualization.debug",
    ] as const;
    const owners = debugKinds.map((kind) => resolveInspectorPanel({ kind }));

    expect(new Set(owners.map((owner) => owner?.component)).size).toBe(
      debugKinds.length,
    );
    expect(owners.map((owner) => owner?.title)).toEqual([
      "Airbox Visualization Debug",
      "Object Visualization Debug",
      "Region Visualization Debug",
    ]);
  });

  it("renders route-specific debug owner contracts around the shared diagnostic body", () => {
    testState.discretization = "fdm";

    const routes = [
      {
        action: "Inspect Airbox render adoption and export bounded evidence",
        capability:
          "Airbox FEM viewport snapshots, field carriers, and exact transport metadata",
        owner: "airbox.visualization.debug",
        selection: airboxDebugSelection,
        target: "Airbox target (airbox)",
        title: "Airbox Visualization Debug",
      },
      {
        action: "Inspect object render adoption and export bounded evidence",
        capability:
          "Object-scoped FEM viewport snapshots, field carriers, and exact transport metadata",
        owner: "object.visualization.debug",
        selection: objectDebugSelection,
        target: "Magnetic object target (object:film)",
        title: "Object Visualization Debug",
      },
      {
        action: "Inspect region overlay adoption and export bounded evidence",
        capability:
          "Region overlay snapshots with part-scoped carriers and exact transport metadata",
        owner: "object.region.visualization.debug",
        selection: objectRegionDebugSelection,
        target: "Object region target (region:film:core)",
        title: "Region Visualization Debug",
      },
    ] as const;

    for (const route of routes) {
      const html = renderResolvedInspector(route.selection);

      expect(html).toContain(`data-inspector-owner="${route.owner}"`);
      expect(html).toContain(`<h2>${route.title}</h2>`);
      expect(html).toContain(`Owner:${route.owner}`);
      expect(html).toContain(`Target:${route.target}`);
      expect(html).toContain(`Capabilities:${route.capability}`);
      expect(html).toContain(`Actions:${route.action}`);
      expect(html).toContain("No active 3D viewport");
      expect(html).toContain(
        "Activate the 3D center surface to observe adopted render data.",
      );
    }
  });

  it("keeps a normal explicit-FDM object visualization route on the object target", () => {
    testState.discretization = "fdm";
    testState.resourceCalls.length = 0;

    const html = renderToStaticMarkup(<ObjectVisualizationPanel selection={selection} />);

    expect(html).toContain("Target ID:object:film");
    expect(testState.resourceCalls).toEqual(
      expect.arrayContaining([
        { name: "domain-meta", enabled: true },
        { name: "fdm-membership", enabled: true },
        { name: "visualization-state", enabled: false },
        { name: "scene", enabled: false },
        { name: "shared-domain-manifest", enabled: false },
      ]),
    );
  });

  it("maps shared 3D quiver intent through the 2D context activation without copying 3D geometry settings", () => {
    testState.discretization = "fdm";
    testState.queuePatch.mockClear();
    testState.planarActivate = null;

    renderToStaticMarkup(<ObjectVisualizationPanel selection={selection} />);
    const activate = testState.planarActivate as (() => void) | null;
    expect(activate).not.toBeNull();
    activate?.();

    expect(testState.queuePatch).toHaveBeenCalledWith({
      planar: {
        resolution: {
          height: 256,
          vector_budget: 1200,
          width: 512,
        },
        vector_style: {
          color_mode: "orientation",
          length_mode: "uniform",
          scale: 1,
        },
      },
    });
    expect(JSON.stringify(testState.queuePatch.mock.calls)).not.toContain("vectorThickness");
    expect(JSON.stringify(testState.queuePatch.mock.calls)).not.toContain("vectorSurfaceOffset");
    expect(testState.queuePatch).toHaveBeenCalledTimes(1);
  });

  it("uses FEM resources only after the status resolves to FEM", () => {
    testState.discretization = "fem";
    testState.resourceCalls.length = 0;

    renderToStaticMarkup(<ObjectVisualizationPanel selection={selection} />);

    expect(testState.resourceCalls).toEqual(
      expect.arrayContaining([
        { name: "domain-meta", enabled: false },
        { name: "fdm-membership", enabled: false },
        { name: "visualization-state", enabled: true },
        { name: "scene", enabled: true },
      ]),
    );
  });

  it("does not fall back to either lane while status is unresolved", () => {
    testState.discretization = "";
    testState.resourceCalls.length = 0;

    const html = renderToStaticMarkup(<ObjectVisualizationPanel selection={selection} />);

    expect(html).not.toContain("Structured grid cells");
    for (const name of [
      "domain-meta",
      "fdm-membership",
      "visualization-state",
      "scene",
      "shared-domain-manifest",
    ]) {
      expect(testState.resourceCalls.find((call) => call.name === name)).toMatchObject({
        enabled: false,
      });
    }
  });
});
