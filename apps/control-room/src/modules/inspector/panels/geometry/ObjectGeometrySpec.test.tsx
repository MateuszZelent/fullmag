import { type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Selection } from "@/kernel/selection/selectionTypes";

import {
  findElement,
  findElements,
  mountWave4TestElement,
} from "../model-roots/wave4TestDom.test-support";

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

const mocks = vi.hoisted(() => ({
  sceneData: {
    revision: 12,
    materials: [{ id: "py", name: "Permalloy", properties: { Ms: 8e5, alpha: 0.008 } }],
    couplings: [],
    objects: [
      {
        id: "arch-1",
        name: "Curved Strip",
        role: "magnet",
        visible: true,
        material_ref: "py",
        tags: ["mesh:ready"],
        geometry: {
          geometry_kind: "ArchWaveguide",
          geometry_params: {
            profile_kind: "circular_arc",
            length: 400e-9,
            width: 50e-9,
            height: 10e-9,
            arch_height: 20e-9,
            z0: 0,
            arc_radius: 120e-9,
            arc_angle_rad: Math.PI / 2,
          },
        },
        transform: {
          translation: [0, 0, 0],
          rotation_quat: [0, 0, 0, 1],
          scale: [2, 2, 1],
          pivot: [0, 0, 0],
        },
      },
    ],
  },
  patchObjectGeometry: vi.fn().mockResolvedValue({ revision: 13 }),
  commitTransaction: vi.fn().mockResolvedValue({ committed_scene: { revision: 13 }, scene_revision: 13 }),
  setSelection: vi.fn(),
}));

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => ({
    api: {
      model: {
        patchObjectGeometry: mocks.patchObjectGeometry,
        patchObject: vi.fn().mockResolvedValue({ revision: 13 }),
        commitTransaction: mocks.commitTransaction,
        frozenSpins: { create: vi.fn(), patch: vi.fn() },
      },
    },
    commands: { execute: vi.fn(), getSessionScopeKey: () => "s1" },
    layout: { get: () => ({ activeViewportMainModuleId: "viewport-3d" }), setPanelVisible: vi.fn() },
    resources: { invalidate: vi.fn() },
    selection: { set: mocks.setSelection },
  }),
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
  MESH_BUILD_CURRENT_RESOURCE_KEY: "mesh-current",
  MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY: "mesh-last",
  publishCommittedSceneResource: vi.fn(),
  useSceneResource: () => ({ data: mocks.sceneData, status: "ready", error: null }),
  useGeometryValidationResource: () => ({ data: null, status: "ready", error: null }),
}));

vi.mock("@/kernel/resources/frozenSpinsResources", () => ({
  useFrozenSpinsCollectionResource: () => ({ data: { definitions: [] }, status: "ready" }),
}));

vi.mock("@/kernel/object-extensions/useObjectExtensionActivation", () => ({
  useObjectExtensionActivation: () => ({
    activation: { enabledByObjectId: {} },
    setEnabled: vi.fn(),
  }),
}));

import { eulerDegToQuat, quatToEulerDeg } from "../model-roots/SpecInspectorHost";
import { ObjectOverviewInspectorPanel } from "../object/ObjectOverviewSpec";
import {
  bakeScaleIntoDraft,
  BuilderPrimitiveInspectorPanel,
  createPolygonVertexRow,
  GeometryObjectInspectorPanel,
  validateArchWaveguide,
  validateSimplePolygon,
  validateTorusRadii,
  validateTubeRadii,
} from "./ObjectGeometrySpec";

describe("ObjectOverviewSpec & ObjectGeometrySpec (Task 14)", () => {
  let mounted: ReturnType<typeof mountWave4TestElement> | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    mocks.patchObjectGeometry.mockClear();
    mocks.commitTransaction.mockClear();
  });

  it("enforces P1 ArchWaveguide validation: rejects R_arc <= w/2 and |Δθ| >= 360° or <= 0°", () => {
    const folded = validateArchWaveguide({
      archProfile: "circular_arc",
      length: 400e-9,
      width: 50e-9,
      height: 10e-9,
      archHeight: 15e-9,
      archRadius: 20e-9,
      archAngleRad: Math.PI / 3,
    });
    expect(folded.valid).toBe(false);
    expect(folded.errors.archRadius).toMatch(/exceed half-width w\/2/i);

    const overlapping = validateArchWaveguide({
      archProfile: "circular_arc",
      length: 400e-9,
      width: 50e-9,
      height: 10e-9,
      archHeight: 15e-9,
      archRadius: 100e-9,
      archAngleRad: 2 * Math.PI,
    });
    expect(overlapping.valid).toBe(false);
    expect(overlapping.errors.archAngleRad).toMatch(/less than 360/i);

    const valid = validateArchWaveguide({
      archProfile: "circular_arc",
      length: 400e-9,
      width: 50e-9,
      height: 10e-9,
      archHeight: 15e-9,
      archRadius: 100e-9,
      archAngleRad: Math.PI / 2,
    });
    expect(valid.valid).toBe(true);
  });

  it("validates Tube R_in < R_out, Torus r_min < R_maj, simple Polygon, Euler<->Quat roundtrip, and Bake Scale", () => {
    expect(validateTubeRadii(50e-9, 30e-9)).toMatch(/strictly smaller/i);
    expect(validateTubeRadii(20e-9, 50e-9)).toBeNull();

    expect(validateTorusRadii(40e-9, 45e-9)).toMatch(/strictly smaller/i);
    expect(validateTorusRadii(80e-9, 20e-9)).toBeNull();

    const bowtie = [
      createPolygonVertexRow(0, 0, "a"),
      createPolygonVertexRow(10e-9, 10e-9, "b"),
      createPolygonVertexRow(0, 10e-9, "c"),
      createPolygonVertexRow(10e-9, 0, "d"),
    ];
    expect(validateSimplePolygon(bowtie)).toMatch(/self-intersects/i);

    const q = eulerDegToQuat([30, -25, 60]);
    const back = quatToEulerDeg(q);
    expect(back[0]).toBeCloseTo(30, 2);
    expect(back[1]).toBeCloseTo(-25, 2);
    expect(back[2]).toBeCloseTo(60, 2);

    const baked = bakeScaleIntoDraft({
      primitiveKind: "Box",
      sizeX: 100e-9,
      sizeY: 50e-9,
      sizeZ: 10e-9,
      scale: [2, 3, 0.5],
    } as never);
    expect(baked.sizeX).toBeCloseTo(200e-9, 15);
    expect(baked.sizeY).toBeCloseTo(150e-9, 15);
    expect(baked.sizeZ).toBeCloseTo(5e-9, 15);
    expect(baked.scale).toEqual([1, 1, 1]);
  });

  it("renders ObjectOverviewInspectorPanel cleanly without geometry dimension inputs, color pickers, or 'unavailable' strings", () => {
    const sel: Selection = {
      kind: "object.root",
      label: "Curved Strip",
      moduleSource: "explorer",
      nodeId: "model:object:arch-1",
      objectId: "arch-1",
      ref: null,
    };
    mounted = mountWave4TestElement(<ObjectOverviewInspectorPanel selection={sel} />);

    expect(
      findElement(mounted.host, (el) => el.getAttribute("data-slot") === "inspector-root"),
    ).not.toBeNull();
    expect(mounted.host.textContent).toContain("Curved Strip");
    expect(mounted.host.textContent).toContain("Absorbing boundary (SAL)");
    expect(mounted.host.textContent).toContain("Frozen spins constraint");
    expect(mounted.host.textContent).toContain("Topological charge Q");
    expect(mounted.host.textContent).not.toMatch(/\bunavailable\b/i);
    expect(mounted.host.textContent).not.toMatch(/\bunknown\b/i);
    expect(
      findElements(mounted.host, (el) => el.getAttribute("type") === "color"),
    ).toHaveLength(0);
  });

  it("renders GeometryObjectInspectorPanel with mesh-stale warning and distinct BuilderPrimitiveInspectorPanel", () => {
    const geomSel: Selection = {
      kind: "object.geometry",
      label: "Geometry",
      moduleSource: "explorer",
      nodeId: "model:object:arch-1:geometry",
      objectId: "arch-1",
      ref: null,
    };
    mounted = mountWave4TestElement(<GeometryObjectInspectorPanel selection={geomSel} />);

    expect(mounted.host.textContent).toContain("Geometry edits invalidate realized mesh");
    expect(mounted.host.textContent).toContain("Centerline arc radius");
    expect(GeometryObjectInspectorPanel).not.toBe(BuilderPrimitiveInspectorPanel);

    const builderSel: Selection = {
      kind: "builder.primitive",
      label: "New Torus",
      moduleSource: "explorer",
      nodeId: "builder:primitive:torus",
      objectId: null,
      ref: null,
    };
    mounted.rerender(<BuilderPrimitiveInspectorPanel selection={builderSel} />);
    expect(mounted.host.textContent).toContain("Major ring radius");
  });
});
