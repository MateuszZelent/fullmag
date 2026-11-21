import { act, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Selection } from "@/kernel/selection/selectionTypes";

import {
  findElement,
  findElements,
  mountWave4TestElement,
  TestEvent,
} from "./wave4TestDom.test-support";

vi.mock("@radix-ui/react-tooltip", () => ({
  Provider: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Content: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
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
  Value: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
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

const mocks = vi.hoisted(() => ({
  sceneData: {
    revision: 7,
    study: { name: "Spin-Wave Waveguide", description: "Dispersion test", demag_enabled: true },
    universe: { id: "universe", name: "Universe", size: [1e-6, 500e-9, 100e-9] },
    materials: [{ id: "py", name: "Permalloy", properties: { Ms: 8e5, Aex: 13e-12, alpha: 0.008 } }],
    couplings: [
      {
        id: "cpl-rkky",
        name: "RKKY Spacer",
        kind: "rkky",
        enabled: true,
        endpoint_a: { kind: "object", object_id: "strip-a" },
        endpoint_b: { kind: "object", object_id: "strip-b" },
        j_rkky: -1.2e-3,
      },
    ],
    objects: [
      {
        id: "strip-a",
        name: "Strip A",
        role: "magnet",
        visible: true,
        material_ref: "py",
        geometry: { geometry_kind: "Box", geometry_params: { size: [500e-9, 100e-9, 10e-9] } },
        regions: [{ region_id: "edge", name: "Edge" }],
      },
    ],
  },
  readinessChecks: [
    { id: "mesh-missing", status: "warning", category: "mesh", message: "Mesh build recommended." },
  ],
  setSelection: vi.fn(),
  patchStudy: vi.fn().mockResolvedValue({}),
  commitTransaction: vi.fn().mockResolvedValue({ committed_scene: { revision: 8 }, scene_revision: 8 }),
}));

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => ({
    api: {
      model: {
        patchStudy: mocks.patchStudy,
        commitTransaction: mocks.commitTransaction,
        patchObject: vi.fn().mockResolvedValue({ revision: 8 }),
        createCoupling: vi.fn().mockResolvedValue({ committed_scene: {}, scene_revision: 8 }),
        patchCoupling: vi.fn().mockResolvedValue({ committed_scene: {}, scene_revision: 8 }),
        deleteCoupling: vi.fn().mockResolvedValue({ committed_scene: {}, scene_revision: 8 }),
        replaceFieldDrive: vi.fn().mockResolvedValue({ committed_scene: {}, scene_revision: 8 }),
        deleteFieldDrive: vi.fn().mockResolvedValue({ committed_scene: {}, scene_revision: 8 }),
        replaceMaskFieldDrive: vi.fn().mockResolvedValue({ committed_scene: {}, scene_revision: 8 }),
        deleteMaskFieldDrive: vi.fn().mockResolvedValue({ committed_scene: {}, scene_revision: 8 }),
        authoringScript: vi.fn().mockResolvedValue({ script: "# test" }),
        frozenSpins: {
          create: vi.fn().mockResolvedValue({}),
          patch: vi.fn().mockResolvedValue({}),
        },
      },
    },
    commands: {
      execute: vi.fn(),
      getSessionScopeKey: () => "session-1",
    },
    layout: {
      get: () => ({ activeViewportMainModuleId: "viewport-3d" }),
      setPanelVisible: vi.fn(),
    },
    resources: {
      invalidate: vi.fn(),
      setOptimisticData: vi.fn(),
    },
    selection: {
      set: mocks.setSelection,
    },
  }),
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
  MESH_SUMMARY_RESOURCE_KEY: "mesh-summary",
  publishCommittedSceneResource: vi.fn(),
  useSceneResource: () => ({ data: mocks.sceneData, status: "ready", error: null }),
  useMeshSummaryResource: () => ({ data: null, status: "ready", error: null }),
  useModelCouplingsResource: () => ({ data: { items: mocks.sceneData.couplings }, status: "ready" }),
}));

vi.mock("@/kernel/resources/studyRuntimeResources", () => ({
  useModelReadinessResource: () => ({
    data: { checks: mocks.readinessChecks },
    status: "ready",
  }),
}));

vi.mock("@/kernel/resources/useActiveLaneCapabilities", () => ({
  useActiveLaneCapabilities: () => ({ lane: "fdm" }),
}));

vi.mock("@/kernel/resources/planarMonitorResources", () => ({
  usePlanarMonitorsResource: () => ({ data: { monitors: [] }, status: "ready" }),
}));

vi.mock("@/kernel/resources/frozenSpinsResources", () => ({
  useFrozenSpinsCollectionResource: () => ({ data: { definitions: [] }, status: "ready" }),
}));

vi.mock("@/kernel/resources/physicsGraphResources", () => ({
  usePhysicsGraphResource: () => ({
    data: {
      schema_version: "physics_graph.v1",
      modules: [
        {
          id: "orphan-drive",
          kind: "regional_field_drive",
          applies_to: [{ kind: "object", object_id: "deleted-obj" }],
        },
      ],
      edges: [],
    },
    status: "ready",
  }),
}));

vi.mock("@/kernel/resources/fieldDriveResources", () => ({
  useFieldDrivesResource: () => ({
    data: {
      items: [
        {
          id: "rf-1",
          name: "Sinc Excitation",
          enabled: true,
          waveform: { kind: "sinc_pulse" },
          target: { kind: "global" },
        },
      ],
    },
    status: "ready",
  }),
}));

vi.mock("@/kernel/resources/maskAntennaResources", () => ({
  useMaskFieldDrivesResource: () => ({ data: { items: [] }, status: "ready" }),
}));

vi.mock("@/kernel/layout/MaterialLibraryDialog", () => ({
  MaterialLibraryDialog: () => null,
}));

import {
  CrossObjectPhysicsScopeInspectorPanel,
  DefinitionsRootInspectorPanel,
  FieldDrivesInspectorPanel,
  GlobalPhysicsScopeInspectorPanel,
  ObjectsRootInspectorPanel,
  PhysicsCouplingsInspectorPanel,
  SessionRootInspectorPanel,
  UniverseRootInspectorPanel,
  UnresolvedPhysicsScopeInspectorPanel,
} from "./ModelScopeSpecs";

function makeSelection(kind: Selection["kind"], nodeId: string, label: string): Selection {
  return {
    kind,
    label,
    moduleSource: "explorer",
    nodeId,
    objectId: null,
    ref: null,
  };
}

describe("ModelScopeSpecs (Task 13)", () => {
  let mounted: ReturnType<typeof mountWave4TestElement> | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    mocks.setSelection.mockClear();
    mocks.commitTransaction.mockClear();
  });

  it("renders SessionRootInspectorPanel on InspectorTemplate without 'unknown' facts and jumps to child branches", () => {
    mounted = mountWave4TestElement(
      <SessionRootInspectorPanel
        selection={makeSelection("session.root", "model:session", "Session Model")}
      />,
    );

    expect(
      findElement(mounted.host, (el) => el.getAttribute("data-slot") === "inspector-root"),
    ).not.toBeNull();
    expect(mounted.host.textContent).toContain("Spin-Wave Waveguide");
    expect(mounted.host.textContent).toContain("FDM");
    expect(mounted.host.textContent).not.toMatch(/\bunknown\b/i);

    const openObjectsBtn = findElement(
      mounted.host,
      (el) => el.tagName === "BUTTON" && el.getAttribute("aria-label") === "Open Objects",
    );
    expect(openObjectsBtn).not.toBeNull();
    act(() => {
      openObjectsBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(mocks.setSelection).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "objects.root", nodeId: "model:objects" }),
      "inspector",
    );
  });

  it("renders UniverseRootInspectorPanel without embedding AirboxMeshParametersPanel and fits universe bounds", async () => {
    mounted = mountWave4TestElement(
      <UniverseRootInspectorPanel
        selection={makeSelection("universe.root", "model:universe", "Universe")}
      />,
    );

    expect(mounted.host.textContent).toContain("Magnetic bounding box (AABB)");
    expect(mounted.host.textContent).toContain("Airbox");
    expect(mounted.host.textContent).toContain("Boundary Faces");
    expect(findElements(mounted.host, (el) => el.tagName === "SELECT")).toHaveLength(0);

    const fitButton = findElement(
      mounted.host,
      (el) =>
        el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Fit Airbox to All Objects")),
    );
    expect(fitButton).not.toBeNull();
    await act(async () => {
      fitButton?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(mocks.commitTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "patch_universe" }),
    );
  });

  it("renders ObjectsRoot, DefinitionsRoot, GlobalPhysics, CrossObject, Couplings, FieldDrives, and Unresolved scopes cleanly", () => {
    mounted = mountWave4TestElement(
      <ObjectsRootInspectorPanel
        selection={makeSelection("objects.root", "model:objects", "Objects")}
      />,
    );

    const elements = [
      <ObjectsRootInspectorPanel
        key="objects"
        selection={makeSelection("objects.root", "model:objects", "Objects")}
      />,
      <DefinitionsRootInspectorPanel
        key="defs"
        selection={makeSelection("definitions.root", "model:definitions", "Definitions")}
      />,
      <GlobalPhysicsScopeInspectorPanel
        key="global"
        selection={makeSelection("physics.scope.global", "model:physics:global", "Global Physics")}
      />,
      <CrossObjectPhysicsScopeInspectorPanel
        key="cross"
        selection={makeSelection(
          "physics.scope.cross-object",
          "model:physics:cross-object",
          "Cross-object Interfaces",
        )}
      />,
      <PhysicsCouplingsInspectorPanel
        key="couplings"
        selection={makeSelection("physics.couplings", "model:physics:couplings", "Couplings")}
      />,
      <FieldDrivesInspectorPanel
        key="drives"
        selection={makeSelection(
          "physics.field-drives",
          "model:physics:field-drives",
          "Field Drives",
        )}
      />,
      <UnresolvedPhysicsScopeInspectorPanel
        key="unresolved"
        selection={makeSelection(
          "physics.scope.unresolved",
          "model:physics:unresolved",
          "Unresolved Physics",
        )}
      />,
    ];

    for (const element of elements) {
      mounted.rerender(element);
      expect(
        findElement(mounted.host, (el) => el.getAttribute("data-slot") === "inspector-root"),
      ).not.toBeNull();
      expect(findElements(mounted.host, (el) => el.tagName === "SELECT")).toHaveLength(0);
      expect(mounted.host.textContent).not.toMatch(/\bunknown\b/i);
      expect(mounted.host.textContent).not.toMatch(/\bunavailable\b/i);
    }

    expect(mounted.host.textContent).toContain("deleted-obj");
  });
});
