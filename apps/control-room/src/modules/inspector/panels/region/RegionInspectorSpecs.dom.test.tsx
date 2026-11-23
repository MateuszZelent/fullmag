import { act, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Selection } from "@/kernel/selection/selectionTypes";
import { ObjectVisualizationController } from "@/kernel/visualization/ObjectVisualizationController";

import { TopologicalChargeExtensionPanel } from "../../extensions/topological-charge/TopologicalChargeExtensionPanel";
import { FrozenSpinsInspectorPanel } from "../constraint/FrozenSpinsInspectorPanel";
import { ObjectAbsorbingBoundaryInspectorPanel } from "../constraint/ObjectExtensionsSpecs";
import {
  findElement,
  findElements,
  mountWave4TestElement,
  TestEvent,
} from "../model-roots/wave4TestDom.test-support";
import {
  cloneRegionForDuplicate,
  parseRegionMaterialTransition,
  parseRegionScalarFieldParam,
  parseRegionShapeState,
  serializeRegionMaterialTransition,
  serializeRegionScalarFieldParam,
  serializeRegionShapeState,
} from "./regionInspectorHelpers";
import {
  assignDescendingPrecedencePriorities,
  extractSelectionTarget,
  ObjectRegionMagneticParametersInspectorPanel,
  ObjectRegionMeshInspectorPanel,
  ObjectRegionOverviewInspectorPanel,
  RegionsCollectionInspectorPanel,
  resolveCanonicalRegionMeshLane,
} from "../../inspectors/objects/regions";

vi.mock("@radix-ui/react-tooltip", () => ({
  Provider: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Content: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("@radix-ui/react-hover-card", () => ({
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@radix-ui/react-dropdown-menu", () => ({
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Group: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Sub: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SubTrigger: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SubContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Item: ({
    children,
    disabled,
    onSelect,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onSelect?: () => void;
  }) => (
    <button disabled={disabled} type="button" onClick={() => onSelect?.()}>
      {children}
    </button>
  ),
  CheckboxItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  RadioGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  RadioItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ItemIndicator: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Label: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Separator: () => <hr />,
}));
vi.mock("@radix-ui/react-context-menu", () => ({
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Group: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Sub: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SubTrigger: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SubContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Item: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  CheckboxItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  RadioGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  RadioItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ItemIndicator: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Label: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Separator: () => <hr />,
}));
vi.mock("@radix-ui/react-dialog", () => ({
  Root: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
    open ? <div>{children}</div> : null,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Overlay: () => <div />,
  Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Title: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  Description: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  Close: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("@radix-ui/react-alert-dialog", () => ({
  Root: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
    open ? <div>{children}</div> : null,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Overlay: () => <div />,
  Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Title: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  Description: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  Action: ({
    children,
    disabled,
    onClick,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button disabled={disabled} type="button" onClick={disabled ? undefined : onClick}>
      {children}
    </button>
  ),
  Cancel: ({ children }: { children?: ReactNode }) => <button type="button">{children}</button>,
}));
vi.mock("@radix-ui/react-select", () => ({
  Root: ({
    children,
    onValueChange,
    value,
  }: {
    children?: ReactNode;
    onValueChange?: (v: string) => void;
    value?: string;
  }) => (
    <div data-select-value={value} onClick={() => undefined}>
      {children}
      {onValueChange ? null : null}
    </div>
  ),
  Trigger: ({ children }: { children?: ReactNode }) => <button type="button">{children}</button>,
  Value: ({ children, placeholder }: { children?: ReactNode; placeholder?: string }) => (
    <span>{children ?? placeholder}</span>
  ),
  Icon: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Viewport: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Group: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Label: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Item: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ItemText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  ItemIndicator: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  ScrollUpButton: () => null,
  ScrollDownButton: () => null,
  Separator: () => <hr />,
}));
vi.mock("@radix-ui/react-tabs", () => ({
  Root: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  List: ({ children }: { children?: ReactNode }) => <div role="tablist">{children}</div>,
  Trigger: ({ children }: { children?: ReactNode }) => (
    <button role="tab" type="button">
      {children}
    </button>
  ),
  Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/shared/charts/ScientificEChart", () => ({
  ScientificEChart: ({ ariaLabel }: { ariaLabel: string }) => (
    <div aria-label={ariaLabel} data-slot="mock-scientific-echart" />
  ),
}));
vi.mock("../MeshQualityStatisticsView", () => ({
  MeshQualityStatisticsView: ({
    statistics,
  }: {
    statistics: { elementCount?: number | null } | null;
  }) => (
    <div data-slot="mock-mesh-quality-statistics">
      {statistics ? `Quality elements: ${statistics.elementCount ?? 0}` : "No quality stats"}
    </div>
  ),
}));

function buildDefaultSceneData() {
  return {
    revision: 31,
    materials: [
      {
        id: "py",
        name: "Permalloy",
        properties: { Ms: 8e5, Aex: 13e-12, alpha: 0.008 },
      },
    ],
    couplings: [] as Record<string, unknown>[],
    objects: [
      {
        id: "film",
        name: "Waveguide Film",
        role: "magnet",
        material_ref: "py",
        geometry: {
          kind: "box",
          size: [200e-9, 100e-9, 20e-9],
        },
        absorbing_boundary: {
          layers: [
            {
              layer_id: "sal-1",
              name: "Left/Right Ramp",
              enabled: true,
              total_width_m: 50e-9,
              ramp_width_m: 40e-9,
              max_damping: 0.5,
              profile: "smootherstep",
              frame: "object",
              geometry: { kind: "faces", faces: ["x+", "x-"] },
            },
          ],
        },
        regions: [
          {
            region_id: "reg-core",
            name: "Skyrmion Core",
            enabled: true,
            frame: "object",
            priority: 5,
            realization_policy: "conformal",
            shape: {
              kind: "cylinder",
              axis: [0, 1, 0],
              center: [0, 0, 0],
              radius: 30e-9,
              height: 10e-9,
            },
            mesh_policy: {
              maximum_element_size: 2e-9,
              minimum_element_size: 0.5e-9,
              transition_distance: 15e-9,
              order: 2,
            },
            texture_override: {
              initial_magnetization: {
                kind: "uniform",
                direction: [0, 0, 1],
              },
            },
          },
          {
            region_id: "reg-rim",
            name: "Outer Rim",
            enabled: true,
            frame: "object",
            priority: 1,
            realization_policy: "inherit",
            shape: {
              kind: "sphere",
              center: [5e-9, 0, 0],
              radius: 8e-9,
            },
          },
        ] as Record<string, unknown>[],
        material_parameter_fields: [
          {
            assignment_id: "f-ms",
            owner_object: "film",
            region_id: "reg-core",
            parameter: "ms",
            priority: 5,
            conflict_policy: "higher_priority_wins",
            value: { kind: "constant", unit: "A/m", value: 6e5 },
          },
          {
            assignment_id: "f-ku2",
            owner_object: "film",
            region_id: "reg-core",
            parameter: "ku2",
            priority: 5,
            conflict_policy: "higher_priority_wins",
            value: { kind: "constant", unit: "J/m^3", value: 1.2e5 },
          },
        ] as Record<string, unknown>[],
      },
    ],
  };
}

const mocks = vi.hoisted(() => ({
  activeLane: { lane: null as "fem" | "fdm" | null },
  sceneData: null as unknown as ReturnType<typeof buildDefaultSceneData>,
  diagnosticsData: {
    diagnostics: [] as Record<string, unknown>[],
    scene_revision: 31,
  },
  materialFieldsData: {
    fields: [] as Record<string, unknown>[],
  },
  fdmDomainData: null as Record<string, unknown> | null,
  fdmMembershipData: null as Record<string, unknown> | null,
  fdmBinaryData: null as Record<string, unknown> | null,
  meshQualityData: null as Record<string, unknown> | null,
  createObjectRegion: vi
    .fn()
    .mockResolvedValue({ committed_scene: { revision: 32, objects: [] }, scene_revision: 32 }),
  patchObjectRegion: vi
    .fn()
    .mockResolvedValue({ committed_scene: { revision: 32, objects: [] }, scene_revision: 32 }),
  deleteObjectRegion: vi
    .fn()
    .mockResolvedValue({ committed_scene: { revision: 32, objects: [] }, scene_revision: 32 }),
  patchObjectMaterialFields: vi
    .fn()
    .mockResolvedValue({ committed_scene: { revision: 32, objects: [] }, scene_revision: 32 }),
  commitTransaction: vi
    .fn()
    .mockResolvedValue({ committed_scene: { revision: 32, objects: [] }, scene_revision: 32 }),
  syncAuthoringScript: vi.fn().mockResolvedValue({}),
  executeCommand: vi.fn().mockResolvedValue({ status: "ok" }),
  historyRecord: vi.fn(),
  queueVizPatch: vi.fn().mockReturnValue({ transactionId: "tx-viz-1" }),
  vizController: null as unknown as ObjectVisualizationController,
}));

mocks.sceneData = buildDefaultSceneData();
mocks.vizController = new ObjectVisualizationController();

vi.mock("@/kernel/KernelContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/kernel/KernelContext")>();
  return {
    ...actual,
    useKernel: () => ({
      api: {
        model: {
          scene: vi.fn().mockResolvedValue(mocks.sceneData),
          commitTransaction: mocks.commitTransaction,
          createObjectRegion: mocks.createObjectRegion,
          patchObjectRegion: mocks.patchObjectRegion,
          deleteObjectRegion: mocks.deleteObjectRegion,
          patchObjectMaterialFields: mocks.patchObjectMaterialFields,
          patchObject: vi.fn().mockResolvedValue({ revision: 32 }),
          syncAuthoringScript: mocks.syncAuthoringScript,
          frozenSpins: {
            create: vi.fn().mockResolvedValue({}),
            patch: vi.fn().mockResolvedValue({}),
            delete: vi.fn().mockResolvedValue({}),
            preview: vi.fn().mockResolvedValue({ selected_count: 128 }),
          },
        },
      },
      authoringHistory: {
        getGeneration: () => 1,
        record: mocks.historyRecord,
      },
      commands: { execute: mocks.executeCommand, getSessionScopeKey: () => "s1" },
      layout: {
        get: () => ({ activeViewportMainModuleId: "viewport-3d" }),
        setPanelVisible: vi.fn(),
      },
      resources: { invalidate: vi.fn() },
      selection: { get: () => null, set: vi.fn() },
      visualization: mocks.vizController,
      visualizationSync: {
        getSnapshot: () => ({ lastRemoteRevision: 5, version: 1 }),
        queuePatch: mocks.queueVizPatch,
        subscribe: () => () => undefined,
      },
    }),
  };
});

vi.mock("@/kernel/resources/geometryLifecycleResources", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/kernel/resources/geometryLifecycleResources")>();
  return {
    ...actual,
    publishCommittedSceneResource: vi.fn(),
    useSceneResource: () => ({ data: mocks.sceneData, status: "ready", error: null }),
    useModelRegionDiagnosticsResource: () => ({
      data: mocks.diagnosticsData,
      status: "ready",
      error: null,
    }),
    useModelCouplingsResource: () => ({
      data: { couplings: mocks.sceneData.couplings },
      status: "ready",
      error: null,
    }),
    useModelMaterialFieldsResource: () => ({
      data: mocks.materialFieldsData,
      status: "ready",
      error: null,
    }),
    useDomainMetaResource: () => ({
      data: mocks.fdmDomainData,
      status: mocks.fdmDomainData ? "ready" : "idle",
      error: null,
    }),
    useFdmRegionMembershipResource: () => ({
      data: mocks.fdmMembershipData,
      status: mocks.fdmMembershipData ? "ready" : "idle",
      error: null,
    }),
    useFdmRegionMembershipBinaryResource: () => ({
      data: mocks.fdmBinaryData,
      status: mocks.fdmBinaryData ? "ready" : "idle",
      error: null,
    }),
    useMeshRegionMembershipResource: () => ({
      data: {
        freshness: "current",
        mesh_generation_id: "gen-42",
        mesh_part_ids: ["part-core"],
        realization: "conformal",
        region_membership_revision: 7,
        topology_fingerprint: "fp-tetra-99",
      },
      status: "ready",
      error: null,
    }),
    useMeshBuildCurrent: () => ({
      data: { active_build: null, last_build_error: null, mesh_pipeline_status: [] },
      status: "ready",
      error: null,
    }),
    useMeshRegionQualityResource: () => ({
      data: mocks.meshQualityData,
      status: mocks.meshQualityData ? "ready" : "idle",
      error: null,
    }),
  };
});

vi.mock("@/kernel/resources/useActiveLaneCapabilities", () => ({
  useActiveLaneCapabilities: () => mocks.activeLane,
}));

vi.mock("@/kernel/resources/useSessionScopedResourceKey", () => ({
  useSessionScopedResourceKey: (key: string) => ({
    resourceKey: `session=s1&epoch=e1&request_scope_epoch=r1|${key}`,
    sessionIdentity: { requestScopeEpoch: "r1", sessionEpoch: "e1", sessionId: "s1" },
  }),
}));

const frozenDefinitionResourceData = {
  definition: {
    id: "pin-edge",
    name: "Edge Pinning",
    enabled: true,
    schema_version: "fullmag.frozen-spins.v1" as const,
    selector: { kind: "in_object" as const, object_id: "film" },
    reference: { kind: "capture_current_at_activation" as const },
    membership: { kind: "static" as const },
    activation: { kind: "all_stages" as const },
  },
  revision: 7,
};

vi.mock("@/kernel/resources/frozenSpinsResources", () => ({
  FROZEN_SPINS_ACTIVE_PREVIEW_RESOURCE_KEY: "frozen-preview",
  frozenSpinsCollectionResourceKey: () => "frozen-list",
  frozenSpinsDefinitionResourceKey: (id: string) => `frozen:${id}`,
  useFrozenSpinsDefinitionResource: () => ({
    data: frozenDefinitionResourceData,
    error: null,
  }),
  useFrozenSpinsCollectionResource: () => ({
    data: {
      definitions: [
        {
          id: "pin-edge",
          name: "Edge Pinning",
          enabled: true,
          selector: { kind: "in_object", object_id: "film" },
          reference_policy: { kind: "fixed_vector", direction: [0, 0, 1] },
          membership_policy: "recompute_on_remesh",
          activation: { kind: "all_stages" },
        },
      ],
    },
    status: "ready",
  }),
}));

vi.mock("@/kernel/resources/studyRuntimeResources", () => ({
  useFieldMetaResource: () => ({ data: null, refetch: vi.fn() }),
  useSolverStatusResource: () => ({ data: null, status: "ready", refetch: vi.fn() }),
  useObjectTopologicalChargeResource: () => ({
    status: "ready",
    refetch: vi.fn(),
    data: {
      schema_version: "topological_charge.v2",
      object_id: "film",
      status: "ready",
      trust: "certified_converged",
      charge: -0.998412,
      nearest_integer: -1,
      integer_error: 0.001588,
      resolved_support: { plane: "xy", support: "layer_profile" },
      quality: {
        valid_vertex_count: 800,
        total_vertex_count: 800,
        valid_triangle_count: 1500,
        total_triangle_count: 1500,
      },
      profile: [
        {
          index: 0,
          coordinate_m: -5e-9,
          integration_weight_m: 5e-9,
          status: "ready",
          trust: "certified",
          charge: -0.9985,
        },
        {
          index: 1,
          coordinate_m: 5e-9,
          integration_weight_m: 5e-9,
          status: "ready",
          trust: "certified",
          charge: -0.9983,
        },
      ],
      warnings: [
        { code: "boundary_tilt", severity: "warning", message: "Edge canting detected." },
        { code: "coarse_cut", severity: "error", message: "High gradient near core." },
      ],
    },
  }),
}));

describe("RegionInspectorSpecs & Constraints/Extensions (Task 16 + Wave 4 Slice D Parity)", () => {
  let mounted: ReturnType<typeof mountWave4TestElement> | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    mocks.activeLane = { lane: null };
    mocks.sceneData = buildDefaultSceneData();
    mocks.diagnosticsData = { diagnostics: [], scene_revision: 31 };
    mocks.materialFieldsData = { fields: [] };
    mocks.fdmDomainData = null;
    mocks.fdmMembershipData = null;
    mocks.fdmBinaryData = null;
    mocks.meshQualityData = null;
    mocks.vizController = new ObjectVisualizationController();
    mocks.createObjectRegion.mockClear();
    mocks.patchObjectRegion.mockClear();
    mocks.deleteObjectRegion.mockClear();
    mocks.patchObjectMaterialFields.mockClear();
    mocks.commitTransaction.mockClear();
    mocks.syncAuthoringScript.mockClear();
    mocks.executeCommand.mockClear();
    mocks.historyRecord.mockClear();
    mocks.queueVizPatch.mockClear();
  });

  it("enforces single canonical meshLane semantics without 'unknown'", () => {
    const pending = resolveCanonicalRegionMeshLane(null, null);
    expect(pending.lane).toBe("pending");
    expect(pending.factValue).toBeNull();
    expect(pending.diagnosticLabel).toBe("Pending study discretization");
  });

  it("resolves selection.ref first and supports both :regions: and :region: nodeIds with colons inside regionId", () => {
    expect(
      extractSelectionTarget({
        kind: "object.region.magnetic-parameters",
        label: "Material",
        moduleSource: "explorer",
        nodeId: "model:object:film:region:region:free-layer:magnetic-parameters",
        objectId: "film",
        ref: null,
      }),
    ).toEqual({ objectId: "film", regionId: "region:free-layer" });

    for (const suffix of [
      "material",
      "mesh",
      "texture",
      "visualization",
      "geometry",
      "shape",
      "diagnostics",
    ]) {
      expect(
        extractSelectionTarget({
          kind: "object.region",
          label: "Free Layer",
          moduleSource: "explorer",
          nodeId: `model:object:film:regions:region:free-layer:${suffix}`,
          objectId: null,
          ref: null,
        }),
      ).toEqual({ objectId: "film", regionId: "region:free-layer" });
    }

    expect(
      extractSelectionTarget({
        kind: "object.region",
        label: "From Ref",
        moduleSource: "viewport-3d",
        nodeId: "other:node",
        objectId: "wrong",
        ref: { type: "scene-object", objectId: "film", regionId: "reg:via-ref" },
      }),
    ).toEqual({ objectId: "film", regionId: "reg:via-ref" });
  });

  it("renders RegionsCollection, RegionOverview, RegionMaterialOverrides (with Reset to Inherited & Ku2), and RegionMesh with history", async () => {
    const regionsSel: Selection = {
      kind: "object.regions",
      label: "Regions",
      moduleSource: "explorer",
      nodeId: "model:object:film:regions",
      objectId: "film",
      ref: null,
    };
    mounted = mountWave4TestElement(<RegionsCollectionInspectorPanel selection={regionsSel} />);
    expect(mounted.host.textContent).toContain("Skyrmion Core");
    expect(mounted.host.textContent).toContain("Outer Rim");
    expect(mounted.host.textContent).toContain("texture");
    expect(mounted.host.textContent).toContain("sphere");

    const moveDownBtn = findElement(
      mounted.host,
      (el) => el.tagName === "BUTTON" && el.getAttribute("aria-label") === "Move Skyrmion Core down",
    );
    expect(moveDownBtn).not.toBeNull();
    await act(async () => {
      moveDownBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(mocks.commitTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "merge_patch",
        merge_patch: {
          objects: [
            expect.objectContaining({
              id: "film",
              regions: [
                expect.objectContaining({ region_id: "reg-rim", priority: 5 }),
                expect.objectContaining({ region_id: "reg-core", priority: 1 }),
              ],
            }),
          ],
        },
      }),
      expect.objectContaining({ sessionScopeKey: "s1" }),
    );
    expect(mocks.historyRecord).toHaveBeenCalled();

    // Region Overview via singular `:region:` nodeId
    const regSel: Selection = {
      kind: "object.region",
      label: "Skyrmion Core",
      moduleSource: "explorer",
      nodeId: "model:object:film:region:reg-core",
      objectId: "film",
      ref: null,
    };
    mounted.rerender(<ObjectRegionOverviewInspectorPanel selection={regSel} />);
    expect(mounted.host.textContent).toContain("Pending study discretization");
    expect(mounted.host.textContent).toContain("Precedence priority");
    expect(mounted.host.textContent).toContain("Coordinate frame");
    expect(mounted.host.textContent).toContain("Cylinder axis");
    expect(mounted.host.textContent).not.toMatch(/\bunknown\b/i);

    // Region Material Overrides + 1-click Reset to Inherited
    mocks.commitTransaction.mockClear();
    const matSel: Selection = {
      kind: "object.region.magnetic-parameters",
      label: "Material",
      moduleSource: "explorer",
      nodeId: "model:object:film:regions:reg-core:magnetic-parameters",
      objectId: "film",
      ref: null,
    };
    mounted.rerender(<ObjectRegionMagneticParametersInspectorPanel selection={matSel} />);
    expect(mounted.host.textContent).toContain("Second-order uniaxial Ku2");
    const resetBtn = findElement(
      mounted.host,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Reset to Inherited")),
    );
    expect(resetBtn).not.toBeNull();
    act(() => {
      resetBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    const applyBtn = findElement(
      mounted.host,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Apply")),
    );
    await act(async () => {
      applyBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(mocks.commitTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.patchObjectRegion).not.toHaveBeenCalled();
    expect(mocks.patchObjectMaterialFields).not.toHaveBeenCalled();
    expect(mocks.commitTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "merge_patch",
        merge_patch: {
          objects: [
            expect.objectContaining({
              id: "film",
              material_parameter_fields: [],
            }),
          ],
        },
      }),
      expect.objectContaining({ sessionScopeKey: "s1" }),
    );

    // Region Mesh Policy
    const meshSel: Selection = {
      kind: "object.region.mesh",
      label: "Mesh",
      moduleSource: "explorer",
      nodeId: "model:object:film:regions:reg-core:mesh",
      objectId: "film",
      ref: null,
    };
    mounted.rerender(<ObjectRegionMeshInspectorPanel selection={meshSel} />);
    expect(mounted.host.textContent).toContain("Maximum element size");
    expect(mounted.host.textContent).toContain("Minimum element size");
    expect(mounted.host.textContent).toContain("Transition distance");
    expect(mounted.host.textContent).toContain("Element order");
    expect(mounted.host.textContent).not.toContain("Overlap conflict resolution");
  });

  it("wires Highlight all region volumes in 3D to kernel.visualization and kernel.visualizationSync", () => {
    const regionsSel: Selection = {
      kind: "object.regions",
      label: "Regions",
      moduleSource: "explorer",
      nodeId: "model:object:film:regions",
      objectId: "film",
      ref: null,
    };
    mounted = mountWave4TestElement(<RegionsCollectionInspectorPanel selection={regionsSel} />);

    const highlightSwitch = findElement(
      mounted.host,
      (el) =>
        el.getAttribute("role") === "switch" &&
        el.getAttribute("aria-label") === "Highlight all region volumes in 3D",
    );
    expect(highlightSwitch).not.toBeNull();
    expect(highlightSwitch?.getAttribute("aria-checked")).toBe("false");

    act(() => {
      highlightSwitch?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });

    expect(mocks.queueVizPatch).toHaveBeenCalledTimes(1);
    const coreSettings = mocks.vizController.getSettings({
      id: "region:film:reg-core",
      kind: "region",
      label: "Skyrmion Core",
    });
    expect(coreSettings.visible).toBe(true);
    expect(coreSettings.boundsVisible).toBe(true);
    const reQueriedSwitch = findElement(
      mounted.host,
      (el) =>
        el.getAttribute("role") === "switch" &&
        el.getAttribute("aria-label") === "Highlight all region volumes in 3D",
    );
    expect(reQueriedSwitch?.getAttribute("aria-checked")).toBe("true");
  });

  it("round-trips sphere, cylinder axis, through_disk, layer_z_slice, half_space, and boolean_expr without coercion", async () => {
    const ownerBounds = {
      center: [0, 0, 0] as [number, number, number],
      size: [200e-9, 100e-9, 20e-9] as [number, number, number],
    };

    // Sphere starter creation uses ownerBounds
    const regionsSel: Selection = {
      kind: "object.regions",
      label: "Regions",
      moduleSource: "explorer",
      nodeId: "model:object:film:regions",
      objectId: "film",
      ref: null,
    };
    mounted = mountWave4TestElement(<RegionsCollectionInspectorPanel selection={regionsSel} />);
    const sphereStarter = findElement(
      mounted.host,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Sphere Sub-volume")),
    );
    expect(sphereStarter).not.toBeNull();
    await act(async () => {
      sphereStarter?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(mocks.createObjectRegion).toHaveBeenCalledWith(
      "film",
      expect.objectContaining({
        frame: "object",
        shape: expect.objectContaining({ kind: "sphere", radius: 5e-9 }),
      }),
      expect.objectContaining({ sessionScopeKey: "s1" }),
    );

    // Sphere Overview mount preserves sphere shapeMode (never coerced to box)
    const rimSel: Selection = {
      kind: "object.region",
      label: "Outer Rim",
      moduleSource: "explorer",
      nodeId: "model:object:film:region:reg-rim",
      objectId: "film",
      ref: null,
    };
    mounted.rerender(<ObjectRegionOverviewInspectorPanel selection={rimSel} />);
    expect(mounted.host.textContent).toContain("sphere");
    expect(mounted.host.textContent).toContain("Radius");

    // Cylinder non-Z axis round-trip
    const cylIn = {
      kind: "cylinder" as const,
      axis: [0, 1, 0],
      center: [2e-9, 0, 0],
      radius: 4e-9,
      height: 20e-9,
    };
    const cylParsed = parseRegionShapeState(cylIn, "film", ownerBounds);
    expect(cylParsed.shapeMode).toBe("cylinder");
    expect(cylParsed.axis).toEqual([0, 1, 0]);
    const cylOut = serializeRegionShapeState({ ...cylParsed, frame: "object" }, ownerBounds);
    expect(cylOut).toEqual({
      kind: "cylinder",
      axis: [0, 1, 0],
      center: [2e-9, 0, 0],
      radius: 4e-9,
      height: 20e-9,
    });

    // through_disk does NOT reload as cylinder
    const diskOut = serializeRegionShapeState(
      {
        ...cylParsed,
        shapeMode: "through_disk",
        center: [10e-9, -5e-9, 0],
        radius: 12e-9,
        frame: "object",
      },
      ownerBounds,
    );
    const diskReloaded = parseRegionShapeState(diskOut, "film", ownerBounds);
    expect(diskReloaded.shapeMode).toBe("through_disk");
    expect(diskReloaded.radius).toBe(12e-9);
    expect(diskReloaded.center[0]).toBe(10e-9);

    // layer_z_slice does NOT reload as box
    const sliceOut = serializeRegionShapeState(
      {
        ...cylParsed,
        shapeMode: "layer_z_slice",
        zMin: -6e-9,
        zMax: 4e-9,
        frame: "object",
      },
      ownerBounds,
    );
    const sliceReloaded = parseRegionShapeState(sliceOut, "film", ownerBounds);
    expect(sliceReloaded.shapeMode).toBe("layer_z_slice");
    expect(sliceReloaded.zMin).toBe(-6e-9);
    expect(sliceReloaded.zMax).toBe(4e-9);

    // half_space reads csg.expression.origin & normal
    const hsOut = serializeRegionShapeState(
      {
        ...cylParsed,
        shapeMode: "half_space",
        halfSpaceOrigin: [1e-9, 2e-9, 3e-9],
        halfSpaceNormal: [0, 1, 0],
        frame: "world",
      },
      ownerBounds,
    );
    const hsReloaded = parseRegionShapeState(hsOut, "film", ownerBounds);
    expect(hsReloaded.shapeMode).toBe("half_space");
    expect(hsReloaded.halfSpaceOrigin).toEqual([1e-9, 2e-9, 3e-9]);
    expect(hsReloaded.halfSpaceNormal).toEqual([0, 1, 0]);

    // boolean_expr reads csg.expression.selector
    const boolSelector = {
      kind: "and" as const,
      expressions: [{ kind: "in_object" as const, object_id: "film" }],
    };
    const boolOut = serializeRegionShapeState(
      {
        ...cylParsed,
        shapeMode: "boolean_expr",
        selectorExpr: boolSelector,
        frame: "object",
      },
      ownerBounds,
    );
    const boolReloaded = parseRegionShapeState(boolOut, "film", ownerBounds);
    expect(boolReloaded.shapeMode).toBe("boolean_expr");
    expect(boolReloaded.selectorExpr).toEqual(boolSelector);
  });

  it("parses OpenAPI diagnostics[], guards source/target couplings on delete, and deep-clones on Duplicate Region", async () => {
    mocks.diagnosticsData = {
      diagnostics: [
        {
          diagnostic_id: "diag-world-1",
          owner_object_id: "film",
          region_id: "reg-core",
          severity: "warning",
          code: "region_world_frame_materialization_unsupported",
          message: "World-frame region requires explicit realized materialization.",
          realization_status: "projected_pending",
          capability_gate: null,
        },
      ],
      scene_revision: 31,
    };
    mocks.sceneData.couplings = [
      {
        coupling_id: "cpl-rkky",
        kind: "rkky",
        enabled: true,
        source: { kind: "region", object: "film", region_id: "reg-core" },
        target: { kind: "object", object: "film" },
      },
    ];

    // 1. object.regions row delete guard blocks deletion when source/target coupling exists
    const regionsSel: Selection = {
      kind: "object.regions",
      label: "Regions",
      moduleSource: "explorer",
      nodeId: "model:object:film:regions",
      objectId: "film",
      ref: null,
    };
    mounted = mountWave4TestElement(<RegionsCollectionInspectorPanel selection={regionsSel} />);
    const deleteRowBtn = findElement(
      mounted.host,
      (el) => el.tagName === "BUTTON" && el.getAttribute("aria-label") === "Delete Skyrmion Core",
    );
    act(() => {
      deleteRowBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(mounted.host.textContent).toContain("Delete Coupling first");
    expect(mounted.host.textContent).toContain("cpl-rkky (source)");
    const confirmDeleteBtn = findElement(
      mounted.host,
      (el) => el.tagName === "BUTTON" && el.textContent === "Delete region",
    );
    expect(confirmDeleteBtn?.hasAttribute("disabled")).toBe(true);
    await act(async () => {
      confirmDeleteBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(mocks.deleteObjectRegion).not.toHaveBeenCalled();

    // 2. object.region renders OpenAPI diagnostics, Duplicate Region deep-clone, and header delete guard
    const coreSel: Selection = {
      kind: "object.region",
      label: "Skyrmion Core",
      moduleSource: "explorer",
      nodeId: "model:object:film:region:reg-core",
      objectId: "film",
      ref: null,
    };
    mounted.rerender(<ObjectRegionOverviewInspectorPanel selection={coreSel} />);
    expect(mounted.host.textContent).toContain("region_world_frame_materialization_unsupported");
    expect(mounted.host.textContent).toContain("World-frame region requires explicit realized materialization.");

    const dupMenuBtn = findElement(
      mounted.host,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Duplicate Region")),
    );
    expect(dupMenuBtn).not.toBeNull();
    await act(async () => {
      dupMenuBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(mocks.createObjectRegion).toHaveBeenCalledTimes(1);
    const createdClone = mocks.createObjectRegion.mock.calls[0]?.[1] as Record<string, unknown>;
    const originalRegion = mocks.sceneData.objects[0]!.regions[0]!;
    expect(createdClone.mesh_policy).toEqual(originalRegion.mesh_policy);
    expect(createdClone.mesh_policy).not.toBe(originalRegion.mesh_policy);

    // Direct helper verification of structuredClone isolation
    const helperClone = cloneRegionForDuplicate(
      originalRegion as unknown as Parameters<typeof cloneRegionForDuplicate>[0],
      "reg-copy",
      "Copy",
    );
    expect(helperClone.shape).not.toBe(originalRegion.shape);

    // Header Delete Region is guarded by coupling
    const headerDeleteItem = findElement(
      mounted.host,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Delete Region")),
    );
    act(() => {
      headerDeleteItem?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    const confirmHeaderBtns = findElements(
      mounted.host,
      (el) => el.tagName === "BUTTON" && el.textContent === "Delete Region",
    );
    await act(async () => {
      confirmHeaderBtns[confirmHeaderBtns.length - 1]?.dispatchEvent(
        new TestEvent("click", { bubbles: true }),
      );
    });
    expect(mocks.deleteObjectRegion).not.toHaveBeenCalled();
  });

  it("supports material_overrides, canonical material_transition, metric linear gradient (/ spanM), real radial center/radius, Python function summary, and FEM realization stats", async () => {
    mocks.activeLane = { lane: "fem" };
    const coreRegion = mocks.sceneData.objects[0]!.regions[0]!;
    coreRegion.material_overrides = [
      {
        parameter: "aex",
        priority: 3,
        conflict_policy: "higher_priority_wins",
        value: { kind: "constant", unit: "J/m", value: 11e-12 },
      },
    ];
    coreRegion.material_transition = {
      kind: "mesh_relative",
      cells: 4,
      scope: "inside",
    };

    mocks.sceneData.objects[0]!.material_parameter_fields = [
      {
        assignment_id: "fn-dind",
        owner_object: "film",
        region_id: "reg-core",
        parameter: "dind",
        priority: 2,
        value: {
          kind: "function",
          frame: "object",
          unit: "J/m^2",
          function: {
            name: "dmi_profile",
            locals: [{ name: "r", expression: "hypot(x, y)" }],
            outputs: ["d0 * exp(-r / lam)"],
            parameters: [{ name: "d0", value: 1.5e-3 }],
          },
        },
      },
      {
        assignment_id: "rad-ku1",
        owner_object: "film",
        region_id: "reg-core",
        parameter: "ku1",
        priority: 4,
        conflict_policy: "error",
        value: {
          kind: "radial",
          frame: "world",
          unit: "J/m^3",
          center: [4e-9, -3e-9, 2e-9],
          radius: 18e-9,
          inside: 5e5,
          outside: 1e5,
        },
      },
    ];
    mocks.materialFieldsData = {
      fields: [
        {
          assignment_id: "rad-ku1",
          realization_status: "realized",
          sample_count: 512,
          min: 1e5,
          max: 5e5,
          mean: 3.1e5,
          unit: "J/m^3",
          warnings: ["steep radial step"],
        },
      ],
    };

    // Metric linear slope math: delta / spanM (never off by 10^7!)
    const builtLinear = serializeRegionScalarFieldParam({
      assignmentId: "lin-ms",
      conflictPolicy: "higher_priority_wins",
      direction: [1, 0, 0],
      endValue: 6e5,
      femLane: true,
      frame: "object",
      mode: "linear_gradient",
      objectId: "film",
      paramName: "ms",
      priority: 7,
      radialCenter: [0, 0, 0],
      radialRadius: 25e-9,
      rawFunction: null,
      regionId: "reg-core",
      spanM: 100e-9,
      value: 8e5,
    });
    expect(builtLinear?.value).toEqual({
      kind: "linear",
      frame: "object",
      unit: "A/m",
      base: 8e5,
      gradient: [-2e12, 0, 0],
    });
    const reparsedLinear = parseRegionScalarFieldParam({
      assignments: [builtLinear!],
      defaultCenter: [0, 0, 0],
      defaultPriority: 0,
      defaultRadius: 25e-9,
      defaultSpan: [100e-9, 50e-9, 10e-9],
      fallbackValue: 8e5,
      paramName: "ms",
      regionId: "reg-core",
    });
    expect(reparsedLinear.value).toBeCloseTo(8e5, 5);
    expect(reparsedLinear.endValue).toBeCloseTo(6e5, 5);
    expect(reparsedLinear.direction).toEqual([1, 0, 0]);

    // Radial preserves real center & radius
    const builtRadial = serializeRegionScalarFieldParam({
      assignmentId: "rad-ku1",
      conflictPolicy: "error",
      direction: [1, 0, 0],
      endValue: 1e5,
      femLane: true,
      frame: "world",
      mode: "radial",
      objectId: "film",
      paramName: "ku1",
      priority: 4,
      radialCenter: [4e-9, -3e-9, 2e-9],
      radialRadius: 18e-9,
      rawFunction: null,
      regionId: "reg-core",
      spanM: 50e-9,
      value: 5e5,
    });
    expect(builtRadial?.value).toEqual({
      kind: "radial",
      frame: "world",
      unit: "J/m^3",
      center: [4e-9, -3e-9, 2e-9],
      radius: 18e-9,
      inside: 5e5,
      outside: 1e5,
    });

    // Transition helper round-trip
    const parsedTrans = parseRegionMaterialTransition(coreRegion.material_transition);
    expect(parsedTrans).toMatchObject({
      transitionKind: "mesh_relative",
      transitionCells: 4,
      transitionScope: "inside",
    });
    expect(serializeRegionMaterialTransition(parsedTrans)).toEqual({
      kind: "mesh_relative",
      cells: 4,
      scope: "inside",
    });

    const matSel: Selection = {
      kind: "object.region.magnetic-parameters",
      label: "Material",
      moduleSource: "explorer",
      nodeId: "model:object:film:region:reg-core:magnetic-parameters",
      objectId: "film",
      ref: null,
    };
    mounted = mountWave4TestElement(
      <ObjectRegionMagneticParametersInspectorPanel selection={matSel} />,
    );

    // Constitutive override, Python function summary, and FEM realization stats all rendered
    expect(mounted.host.textContent).toContain("Override: aex");
    expect(mounted.host.textContent).toContain("def dmi_profile(x, y, z)");
    expect(mounted.host.textContent).toContain("d0 * exp(-r / lam)");
    expect(mounted.host.textContent).toContain("hypot(x, y)");
    expect(mounted.host.textContent).toContain("512");
    expect(mounted.host.textContent).toContain("steep radial step");
    expect(mounted.host.textContent).toContain("Transition cells");

    // Add a constitutive override and switch transition toSharp -> patches BOTH region & fields (preserving fn-dind!)
    const addOvrBtn = findElement(
      mounted.host,
      (el) =>
        el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Add Constitutive Override")),
    );
    act(() => {
      addOvrBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    const sharpBtn = findElement(
      mounted.host,
      (el) => el.tagName === "BUTTON" && el.textContent === "Sharp",
    );
    act(() => {
      sharpBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });

    const applyBtn = findElement(
      mounted.host,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Apply")),
    );
    await act(async () => {
      applyBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });

    expect(mocks.commitTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.patchObjectRegion).not.toHaveBeenCalled();
    expect(mocks.patchObjectMaterialFields).not.toHaveBeenCalled();
    expect(mocks.commitTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "merge_patch",
        merge_patch: {
          objects: [
            expect.objectContaining({
              id: "film",
              regions: expect.arrayContaining([
                expect.objectContaining({
                  region_id: "reg-core",
                  material_overrides: expect.arrayContaining([
                    expect.objectContaining({ parameter: "aex" }),
                    expect.objectContaining({ parameter: "ms" }),
                  ]),
                  material_transition: { kind: "sharp" },
                }),
              ]),
            }),
          ],
        },
      }),
      expect.objectContaining({ sessionScopeKey: "s1" }),
    );
  });

  it("preserves all 4 FEM mesh_policy fields + top-level realization_policy, triggers Build Mesh, and renders FDM cell membership", async () => {
    mocks.activeLane = { lane: "fem" };
    mocks.meshQualityData = {
      quality: {
        global: {
          element_count: 1024,
        },
        quality_source: "gmsh",
        worst_elements: [],
      },
    };
    const coreRegion = mocks.sceneData.objects[0]!.regions[0]!;
    coreRegion.realization_policy = "project";

    const meshSel: Selection = {
      kind: "object.region.mesh",
      label: "Mesh",
      moduleSource: "explorer",
      nodeId: "model:object:film:region:reg-core:mesh",
      objectId: "film",
      ref: null,
    };
    mounted = mountWave4TestElement(<ObjectRegionMeshInspectorPanel selection={meshSel} />);

    // FEM quality statistics + Build Mesh rendered
    expect(mounted.host.textContent).toContain("Region Quality Distributions");
    expect(mounted.host.textContent).toContain("Quality elements: 1024");

    // Switch top-level realizationMode from "project" -> "conformal" and Apply: all 4 mesh_policy fields preserved!
    const conformalBtn = findElement(
      mounted.host,
      (el) => el.tagName === "BUTTON" && el.textContent === "Conformal",
    );
    act(() => {
      conformalBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    const applyBtn = findElement(
      mounted.host,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Apply")) &&
        !el.textContent?.includes("Build Mesh"),
    );
    await act(async () => {
      applyBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(mocks.patchObjectRegion).toHaveBeenCalledWith(
      "film",
      "reg-core",
      {
        realization_policy: "conformal",
        mesh_policy: {
          maximum_element_size: 2e-9,
          minimum_element_size: 0.5e-9,
          transition_distance: 15e-9,
          order: 2,
        },
      },
      expect.objectContaining({ sessionScopeKey: "s1" }),
    );

    // Click Build Mesh -> executes mesh.build-shared-domain
    const buildBtns = findElements(
      mounted.host,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Build Mesh")),
    );
    expect(buildBtns.length).toBeGreaterThan(0);
    await act(async () => {
      buildBtns[0]?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(mocks.executeCommand).toHaveBeenCalledWith(
      "mesh.build-shared-domain",
      expect.objectContaining({
        input: { object_id: "film", region_id: "reg-core" },
      }),
    );

    // Switch to FDM lane -> renders structured-grid cell counts & percentage fraction
    mocks.activeLane = { lane: "fdm" };
    mocks.fdmDomainData = {
      discretization: "fdm",
      grid: {
        origin: [0, 0, 0],
        spacing: [2e-9, 2e-9, 2e-9],
        shape: [10, 5, 2],
      },
    };
    mocks.fdmMembershipData = {
      grid_fingerprint: "fdm-grid-abc",
      cell_count: 100,
      counts: [10, 5, 2],
      origin_m: [0, 0, 0],
      cell_m: [2e-9, 2e-9, 2e-9],
      freshness: "current",
      object_ids: ["film"],
      region_legend: [
        {
          numeric_id: 1,
          object_id: "film",
          priority: 5,
          region_id: "reg-core",
        },
      ],
    };
    const cellIds = new Uint16Array(100);
    cellIds.fill(0xffff);
    for (let i = 0; i < 25; i += 1) {
      cellIds[i] = 1;
    }
    mocks.fdmBinaryData = {
      semanticStatus: "canonical",
      gridFingerprint: "fdm-grid-abc",
      cellCount: 100,
      counts: [10, 5, 2],
      regionIds: cellIds,
    };

    mounted.rerender(<ObjectRegionMeshInspectorPanel selection={meshSel} />);
    expect(mounted.host.textContent).toContain("FDM structured-grid region membership");
    expect(mounted.host.textContent).toContain("25 active (25.0%)");
    expect(mounted.host.textContent).toContain("fdm-grid-abc");
  });

  it("renders AbsorbingBoundary ('Target region' + ScientificEChart), FrozenSpins, and TopologicalCharge (pure MathML, zero raw LaTeX, all warnings)", () => {
    const salSel: Selection = {
      kind: "object.absorbing-boundary",
      label: "Absorbing Boundary",
      moduleSource: "explorer",
      nodeId: "model:object:film:absorbing-boundary",
      objectId: "film",
      ref: null,
    };
    mounted = mountWave4TestElement(<ObjectAbsorbingBoundaryInspectorPanel selection={salSel} />);
    expect(mounted.host.textContent).toContain("Target region");
    expect(mounted.host.textContent).not.toContain("Target material");
    expect(
      findElement(mounted.host, (el) => el.getAttribute("data-slot") === "mock-scientific-echart"),
    ).not.toBeNull();

    const frozenSel: Selection = {
      kind: "object.frozen-spins",
      label: "Edge Pinning",
      moduleSource: "explorer",
      nodeId: "model:object:film:frozen-spins:pin-edge",
      objectId: "film",
      ref: null,
    };
    mounted.rerender(<FrozenSpinsInspectorPanel selection={frozenSel} />);
    expect(mounted.host.textContent).toContain("Edge Pinning");
    expect(mounted.host.textContent).toContain("Preview mask");

    const tcSel: Selection = {
      kind: "object.extension.topological-charge",
      label: "Topological Charge",
      moduleSource: "explorer",
      nodeId: "model:object:film:extensions:topological-charge",
      objectId: "film",
      ref: null,
    };
    mounted.rerender(<TopologicalChargeExtensionPanel selection={tcSel} />);
    expect(mounted.host.textContent).toContain("-0.998412");
    expect(mounted.host.textContent).toContain("High gradient near core.");
    expect(mounted.host.textContent).toContain("Edge canting detected.");
    expect(mounted.host.textContent).not.toContain("\\Sigma");
    expect(mounted.host.textContent).not.toContain("\\hat{\\mathbf m}");
    expect(mounted.host.textContent).not.toMatch(/\bunavailable\b/i);
    expect(findElements(mounted.host, (el) => el.tagName === "SELECT")).toHaveLength(0);
  });

  it("commits combined constitutive overrides, transition, and scalar fields in one atomic merge_patch and breaks equal-priority ties on reorder", async () => {
    expect(assignDescendingPrecedencePriorities([5, 1])).toEqual([5, 1]);
    expect(assignDescendingPrecedencePriorities([0, 0])).toEqual([1, 0]);
    expect(assignDescendingPrecedencePriorities([5, 5, 1])).toEqual([6, 5, 1]);

    const coreRegion = mocks.sceneData.objects[0]!.regions[0]!;
    coreRegion.material_overrides = [
      {
        parameter: "aex",
        priority: 5,
        conflict_policy: "higher_priority_wins",
        value: { kind: "constant", unit: "J/m", value: 11e-12 },
      },
    ];
    coreRegion.material_transition = {
      kind: "metric",
      width: 6e-9,
      scope: "boundary",
    };

    const matSel: Selection = {
      kind: "object.region.magnetic-parameters",
      label: "Material",
      moduleSource: "explorer",
      nodeId: "model:object:film:regions:reg-core:magnetic-parameters",
      objectId: "film",
      ref: null,
    };
    mounted = mountWave4TestElement(
      <ObjectRegionMagneticParametersInspectorPanel selection={matSel} />,
    );

    // Simultaneously edit scalar material_parameter_fields (reset) + constitutive overrides + transition
    act(() => {
      findElement(
        mounted!.host,
        (el) =>
          el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Reset to Inherited")),
      )?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    act(() => {
      findElement(
        mounted!.host,
        (el) =>
          el.tagName === "BUTTON" &&
          Boolean(el.textContent?.includes("Add Constitutive Override")),
      )?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    act(() => {
      findElement(
        mounted!.host,
        (el) => el.tagName === "BUTTON" && el.textContent === "Sharp",
      )?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });

    await act(async () => {
      findElement(
        mounted!.host,
        (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Apply")),
      )?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });

    // Single atomic transaction — never two sequential API writes!
    expect(mocks.commitTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.patchObjectRegion).not.toHaveBeenCalled();
    expect(mocks.patchObjectMaterialFields).not.toHaveBeenCalled();
    expect(mocks.commitTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "merge_patch",
        merge_patch: {
          objects: [
            expect.objectContaining({
              id: "film",
              material_parameter_fields: [],
              regions: expect.arrayContaining([
                expect.objectContaining({
                  region_id: "reg-core",
                  material_overrides: [
                    expect.objectContaining({ parameter: "ms" }),
                  ],
                  material_transition: { kind: "sharp" },
                }),
              ]),
            }),
          ],
        },
      }),
      expect.objectContaining({ sessionScopeKey: "s1" }),
    );
  });
});
