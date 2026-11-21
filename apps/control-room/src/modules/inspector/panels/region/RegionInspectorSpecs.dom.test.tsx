import { act, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Selection } from "@/kernel/selection/selectionTypes";

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
  ObjectRegionMagneticParametersInspectorPanel,
  ObjectRegionMeshInspectorPanel,
  ObjectRegionOverviewInspectorPanel,
  RegionsCollectionInspectorPanel,
  resolveCanonicalRegionMeshLane,
} from "./RegionInspectorSpecs";

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
  Item: ({ children, onSelect }: { children?: ReactNode; onSelect?: () => void }) => (
    <button type="button" onClick={() => onSelect?.()}>
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
  Action: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  Cancel: ({ children }: { children?: ReactNode }) => <button type="button">{children}</button>,
}));
vi.mock("@radix-ui/react-select", () => ({
  Root: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
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

const mocks = vi.hoisted(() => ({
  sceneData: {
    revision: 31,
    materials: [{ id: "py", name: "Permalloy", properties: { Ms: 8e5, Aex: 13e-12, alpha: 0.008 } }],
    couplings: [],
    objects: [
      {
        id: "film",
        name: "Waveguide Film",
        role: "magnet",
        material_ref: "py",
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
            shape: { kind: "cylinder", center: [0, 0, 0], radius: 30e-9, height: 10e-9 },
            mesh_policy: { maximum_element_size: 2e-9, realization_policy: "conformal" },
          },
          {
            region_id: "reg-rim",
            name: "Outer Rim",
            enabled: true,
            shape: { kind: "box", center: [0, 0, 0], size: [100e-9, 100e-9, 10e-9] },
          },
        ],
        material_parameter_fields: [
          {
            assignment_id: "f-ms",
            owner_object: "film",
            region_id: "reg-core",
            parameter: "ms",
            value: { kind: "constant", unit: "A/m", value: 6e5 },
          },
          {
            assignment_id: "f-ku2",
            owner_object: "film",
            region_id: "reg-core",
            parameter: "ku2",
            value: { kind: "constant", unit: "J/m^3", value: 1.2e5 },
          },
        ],
      },
    ],
  },
  patchObjectMaterialFields: vi
    .fn()
    .mockResolvedValue({ committed_scene: { revision: 32 }, scene_revision: 32 }),
  commitTransaction: vi
    .fn()
    .mockResolvedValue({ committed_scene: { revision: 32 }, scene_revision: 32 }),
}));

vi.mock("@/kernel/KernelContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/kernel/KernelContext")>();
  return {
    ...actual,
    useKernel: () => ({
      api: {
        model: {
          commitTransaction: mocks.commitTransaction,
          createObjectRegion: vi
            .fn()
            .mockResolvedValue({ committed_scene: { revision: 32 }, scene_revision: 32 }),
          patchObjectRegion: vi
            .fn()
            .mockResolvedValue({ committed_scene: { revision: 32 }, scene_revision: 32 }),
          deleteObjectRegion: vi
            .fn()
            .mockResolvedValue({ committed_scene: { revision: 32 }, scene_revision: 32 }),
          patchObjectMaterialFields: mocks.patchObjectMaterialFields,
          patchObject: vi.fn().mockResolvedValue({ revision: 32 }),
          frozenSpins: {
            create: vi.fn().mockResolvedValue({}),
            patch: vi.fn().mockResolvedValue({}),
            delete: vi.fn().mockResolvedValue({}),
            preview: vi.fn().mockResolvedValue({ selected_count: 128 }),
          },
        },
      },
      commands: { execute: vi.fn(), getSessionScopeKey: () => "s1" },
      layout: { get: () => ({ activeViewportMainModuleId: "viewport-3d" }), setPanelVisible: vi.fn() },
      resources: { invalidate: vi.fn() },
      selection: { set: vi.fn() },
    }),
  };
});

vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
  publishCommittedSceneResource: vi.fn(),
  useSceneResource: () => ({ data: mocks.sceneData, status: "ready", error: null }),
  useModelRegionDiagnosticsResource: () => ({ data: { items: [] }, status: "ready" }),
}));

vi.mock("@/kernel/resources/useActiveLaneCapabilities", () => ({
  useActiveLaneCapabilities: () => ({ lane: null }),
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

describe("RegionInspectorSpecs & Constraints/Extensions (Task 16)", () => {
  let mounted: ReturnType<typeof mountWave4TestElement> | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    mocks.patchObjectMaterialFields.mockClear();
    mocks.commitTransaction.mockClear();
  });

  it("enforces single canonical meshLane semantics without 'unknown'", () => {
    const pending = resolveCanonicalRegionMeshLane(null, null);
    expect(pending.lane).toBe("pending");
    expect(pending.factValue).toBeNull();
    expect(pending.diagnosticLabel).toBe("Pending study discretization");
  });

  it("renders RegionsCollection, RegionOverview, RegionMaterialOverrides (with Reset to Inherited & Ku2), and RegionMesh", async () => {
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

    // Reorder down button calls reorder_object_regions
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
        kind: "reorder_object_regions",
        region_ids: ["reg-rim", "reg-core"],
      }),
    );

    // Region Overview
    const regSel: Selection = {
      kind: "object.region",
      label: "Skyrmion Core",
      moduleSource: "explorer",
      nodeId: "model:object:film:regions:reg-core",
      objectId: "film",
      ref: null,
    };
    mounted.rerender(<ObjectRegionOverviewInspectorPanel selection={regSel} />);
    expect(mounted.host.textContent).toContain("Pending study discretization");
    expect(mounted.host.textContent).not.toMatch(/\bunknown\b/i);

    // Region Material Overrides + 1-click Reset to Inherited
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
    expect(mocks.patchObjectMaterialFields).toHaveBeenCalledWith(
      "film",
      [],
      expect.anything(),
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

    // Frozen Spins
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

    // Topological Charge: pure MathML, ALL warnings rendered, nm coordinates, zero raw LaTeX!
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
});
