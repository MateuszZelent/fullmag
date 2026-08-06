import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  discretization: "fdm",
  resourceCalls: [] as Array<{ enabled: boolean; name: string }>,
}));

function resourceCall(name: string, enabled: boolean): void {
  testState.resourceCalls.push({ enabled, name });
}

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => ({
    visualizationSync: {
      queuePatch: vi.fn(),
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
  useVisualizationStateResource: ({ enabled }: { enabled: boolean }) => {
    resourceCall("visualization-state", enabled);
    return {
      data: enabled ? { overrides: [], revision: 1 } : null,
      error: null,
      rawData: null,
      revision: 1,
      status: enabled ? "ready" : "idle",
    };
  },
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
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
  InspectorGroup: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
vi.mock("./ObjectVisualizationOverview", () => ({
  ObjectVisualizationOverview: () => null,
}));
vi.mock("../visualization/PlanarVisualizationSection", () => ({
  PlanarVisualizationSection: () => null,
}));
vi.mock("../visualization/VisualizationContextSwitch", () => ({
  VisualizationContextSwitch: () => null,
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

describe("ObjectVisualizationPanel lane routing", () => {
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
