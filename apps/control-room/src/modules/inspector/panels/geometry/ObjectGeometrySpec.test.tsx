import { act, createContext, useContext, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ControlRoomApiError } from "@/kernel/api/ControlRoomApi";
import { AUTHORING_MUTATION_DEPENDENTS } from "@/kernel/authoring/authoringMutationInvalidation";
import { primitiveDraftOverlayStore } from "@/kernel/authoring/geometryLifecycleCommands";
import { ObjectEditSessionController } from "@/kernel/authoring/object-edit/ObjectEditSessionController";
import type { GeometryObjectDraft } from "@/kernel/authoring/object-edit/objectEditTypes";
import { updateQuantityFieldSI } from "@/kernel/authoring/object-edit/quantityDraftFields";
import { TestElement } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import type { Selection } from "@/kernel/selection/selectionTypes";

import {
  findElements,
  mountWave4TestElement,
  TestEvent,
} from "../model-roots/wave4TestDom.test-support";

const TabsMockCtx = createContext<{
  value?: string;
  onValueChange?: (val: string) => void;
}>({});

const SelectMockCtx = createContext<{
  value?: string;
  onValueChange?: (val: string) => void;
}>({});

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
  Root: ({
    children,
    value,
    onValueChange,
  }: {
    children?: ReactNode;
    value?: string;
    onValueChange?: (v: string) => void;
  }) => (
    <SelectMockCtx.Provider value={{ value, onValueChange }}>
      <div>{children}</div>
    </SelectMockCtx.Provider>
  ),
  Trigger: ({ children }: { children?: ReactNode }) => <button type="button">{children}</button>,
  Value: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
  Icon: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Viewport: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Group: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Label: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Item: ({ children, value }: { children?: ReactNode; value: string }) => {
    const ctx = useContext(SelectMockCtx);
    return (
      <button
        data-select-value={value}
        type="button"
        onClick={() => ctx.onValueChange?.(value)}
      >
        {children}
      </button>
    );
  },
  ItemText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  ItemIndicator: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  ScrollUpButton: () => null,
  ScrollDownButton: () => null,
  Separator: () => <hr />,
}));
vi.mock("@radix-ui/react-tabs", () => ({
  Root: ({
    children,
    value,
    onValueChange,
  }: {
    children?: ReactNode;
    value?: string;
    onValueChange?: (v: string) => void;
  }) => (
    <TabsMockCtx.Provider value={{ value, onValueChange }}>
      <div>{children}</div>
    </TabsMockCtx.Provider>
  ),
  List: ({ children }: { children?: ReactNode }) => <div role="tablist">{children}</div>,
  Trigger: ({ children, value }: { children?: ReactNode; value: string }) => {
    const ctx = useContext(TabsMockCtx);
    return (
      <button
        aria-selected={ctx.value === value ? "true" : "false"}
        data-tab-value={value}
        role="tab"
        type="button"
        onClick={() => ctx.onValueChange?.(value)}
      >
        {children}
      </button>
    );
  },
  Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

function defaultArchObject() {
  return {
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
  };
}

const mocks = vi.hoisted(() => ({
  sceneData: {
    revision: 12,
    materials: [{ id: "py", name: "Permalloy", properties: { Ms: 8e5, alpha: 0.008 } }],
    couplings: [] as unknown[],
    objects: [] as Record<string, unknown>[],
  },
  sceneStatus: "ready" as "ready" | "loading" | "error",
  sessionIdentity: {
    sessionId: "s1",
    sessionEpoch: 1,
    requestScopeEpoch: 1,
  } as { sessionId: string; sessionEpoch: number; requestScopeEpoch: number } | null,
  sessionScopeKey: "session=s1&epoch=1&request_scope_epoch=1" as string | null,
  historyGeneration: 0,
  recordHistory: vi.fn(),
  readScene: vi.fn(),
  refetchScene: vi.fn(),
  invalidate: vi.fn(),
  publishCommittedScene: vi.fn(),
  patchObjectGeometry: vi.fn().mockResolvedValue({ revision: 13 }),
  commitTransaction: vi.fn(),
  selectionState: null as unknown,
  setSelection: vi.fn(),
  objectEditSession: null as ObjectEditSessionController<GeometryObjectDraft> | null,
}));

vi.mock("@/kernel/KernelContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/kernel/KernelContext")>();
  const { ObjectEditSessionController: SessionCtrl } = await import(
    "@/kernel/authoring/object-edit/ObjectEditSessionController"
  );
  mocks.objectEditSession ??= new SessionCtrl();
  return {
    ...actual,
    useKernel: () => ({
      api: {
        resourceCacheScope: "test-scope",
        model: {
          scene: mocks.readScene,
          patchObjectGeometry: mocks.patchObjectGeometry,
          patchObject: vi.fn().mockResolvedValue({ revision: 13 }),
          commitTransaction: mocks.commitTransaction,
          frozenSpins: { create: vi.fn(), patch: vi.fn() },
        },
      },
      authoringHistory: {
        getGeneration: () => mocks.historyGeneration,
        record: mocks.recordHistory,
      },
      commands: { execute: vi.fn(), getSessionScopeKey: () => mocks.sessionScopeKey },
      layout: {
        get: () => ({ activeViewportMainModuleId: "viewport-3d" }),
        setPanelVisible: vi.fn(),
      },
      objectEditSession: mocks.objectEditSession,
      resources: {
        invalidate: mocks.invalidate,
        subscribe: () => () => undefined,
        getRevision: () => null,
      },
      selection: {
        get: () => mocks.selectionState,
        set: (sel: unknown, src: unknown) => {
          mocks.selectionState = sel;
          mocks.setSelection(sel, src);
        },
      },
    }),
  };
});

vi.mock("@/kernel/resources/useSessionScopedResourceKey", () => ({
  useSessionScopedResourceKey: (unscopedKey: string) => ({
    resourceKey: mocks.sessionScopeKey ? `${mocks.sessionScopeKey}|${unscopedKey}` : unscopedKey,
    sessionIdentity: mocks.sessionIdentity,
  }),
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
  MESH_BUILD_CURRENT_RESOURCE_KEY: "mesh-current",
  MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY: "mesh-last",
  publishCommittedSceneResource: mocks.publishCommittedScene,
  useSceneResource: () => ({
    data: mocks.sceneData,
    status: mocks.sceneStatus,
    error: null,
    refetch: mocks.refetchScene,
    sessionScopeKey: mocks.sessionScopeKey,
  }),
  useGeometryValidationResource: () => ({ data: null, status: "ready", error: null }),
}));

vi.mock("@/kernel/resources/frozenSpinsResources", () => ({
  useFrozenSpinsCollectionResource: () => ({ data: { definitions: [] }, status: "ready" }),
}));

vi.mock("@/kernel/resources/studyRuntimeResources", () => ({
  useObjectMetricsResource: () => ({ data: null, status: "ready", error: null }),
}));

vi.mock("@/kernel/object-extensions/useObjectExtensionActivation", () => ({
  useObjectExtensionActivation: () => ({
    activation: { enabledByObjectId: {} },
    setEnabled: vi.fn(),
  }),
}));

import { eulerDegToQuat, quatToEulerDeg } from "../model-roots/SpecInspectorHost";
import { resetPersistedInspectorModeTabs } from "../../template/useInspectorSpecController";
import { ObjectOverviewInspectorPanel } from "../object/ObjectOverviewSpec";
import {
  applyUniformScaleChange,
  bakeScaleIntoDraft,
  buildBaselineFromScene,
  BuilderPrimitiveInspectorPanel,
  canBakeScaleIntoDraft,
  createPolygonVertexRow,
  GeometryObjectInspectorPanel,
  resolveMeshStatusFromObject,
  resolvePreviewOverlayDraft,
  serializeGeometryPayload,
  serializeTransformPayload,
  validateArchWaveguide,
  validateSimplePolygon,
  validateTorusRadii,
  validateTubeRadii,
} from "../../inspectors/objects/geometry";

function queryFirst(
  host: TestElement,
  predicate: (el: TestElement) => boolean,
): TestElement | null {
  return findElements(host, predicate)[0] ?? null;
}

type TestInputCompat = TestElement & {
  _valueTracker?: { setValue: (v: string) => void };
  _onPropertyChange?: (ev: {
    propertyName: string;
    target: TestElement;
    srcElement: TestElement;
  }) => void;
  attachEvent?: (
    name: string,
    listener: (ev: {
      propertyName: string;
      target: TestElement;
      srcElement: TestElement;
    }) => void,
  ) => void;
  detachEvent?: (name: string) => void;
};

function attachReactInputShim(input: TestElement): TestInputCompat {
  const compat = input as TestInputCompat;
  if (!compat.attachEvent) {
    compat.attachEvent = (_name, listener) => {
      compat._onPropertyChange = listener;
    };
    compat.detachEvent = () => {
      compat._onPropertyChange = undefined;
    };
  }
  return compat;
}

function setInputValue(input: TestElement, nextValue: string) {
  act(() => {
    const compat = attachReactInputShim(input);
    input.focus();
    input.dispatchEvent(new TestEvent("focusin", { bubbles: true }));
    const previous = input.value;
    input.value = nextValue;
    compat._valueTracker?.setValue(previous);
    if (compat._onPropertyChange) {
      compat._onPropertyChange({
        propertyName: "value",
        target: input,
        srcElement: input,
      });
      return;
    }
    input.dispatchEvent(new TestEvent("input", { bubbles: true }));
  });
}

function findButtonByText(host: TestElement, label: string): TestElement {
  const exact = findElements(
    host,
    (el) => el.tagName === "BUTTON" && (el.textContent ?? "").trim() === label,
  )[0];
  if (exact) return exact;
  const including = findElements(
    host,
    (el) => el.tagName === "BUTTON" && (el.textContent ?? "").includes(label),
  )[0];
  if (!including) {
    throw new Error(`Button "${label}" not found`);
  }
  return including;
}

describe("ObjectOverviewSpec & ObjectGeometrySpec (Wave 4 Parity)", () => {
  let mounted: ReturnType<typeof mountWave4TestElement> | null = null;

  beforeEach(() => {
    resetPersistedInspectorModeTabs();
    primitiveDraftOverlayStore.clear();
    mocks.objectEditSession?.clear();
    mocks.sceneData = {
      revision: 12,
      materials: [{ id: "py", name: "Permalloy", properties: { Ms: 8e5, alpha: 0.008 } }],
      couplings: [],
      objects: [defaultArchObject()],
    };
    mocks.sceneStatus = "ready";
    mocks.sessionIdentity = {
      sessionId: "s1",
      sessionEpoch: 1,
      requestScopeEpoch: 1,
    };
    mocks.sessionScopeKey = "session=s1&epoch=1&request_scope_epoch=1";
    mocks.historyGeneration = 0;
    mocks.selectionState = null;
    mocks.readScene.mockReset().mockImplementation(async () => mocks.sceneData);
    mocks.refetchScene.mockReset();
    mocks.recordHistory.mockReset();
    mocks.invalidate.mockReset();
    mocks.publishCommittedScene.mockReset();
    mocks.patchObjectGeometry.mockClear();
    mocks.setSelection.mockReset();
    mocks.commitTransaction.mockReset().mockImplementation(async () => ({
      committed_scene: {
        ...mocks.sceneData,
        revision: 13,
      },
      scene_revision: 13,
      transaction_kind: "patch_object_geometry",
    }));
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    primitiveDraftOverlayStore.clear();
    mocks.objectEditSession?.clear();
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

    const boxDraft = buildBaselineFromScene(
      {
        kind: "builder.primitive",
        label: "New box",
        moduleSource: "explorer",
        nodeId: "builder:primitive:box",
        objectId: null,
        ref: null,
      },
      null,
      true,
    );
    const baked = bakeScaleIntoDraft({
      ...boxDraft,
      sizeX: 100e-9,
      sizeY: 50e-9,
      sizeZ: 10e-9,
      scale: [2, 3, 0.5],
    });
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
      queryFirst(mounted.host, (el) => el.getAttribute("data-slot") === "inspector-root"),
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

  it("syncs 3D Move Gizmo objectEditSession live, blocks on active gesture, and clears dirty on Apply & Revert", async () => {
    const geomSel: Selection = {
      kind: "object.geometry",
      label: "Geometry",
      moduleSource: "explorer",
      nodeId: "model:object:arch-1:geometry",
      objectId: "arch-1",
      ref: null,
    };
    mounted = mountWave4TestElement(<GeometryObjectInspectorPanel selection={geomSel} />);

    const session = mocks.objectEditSession!;
    const activeIdentity = session.getSnapshot().identity;
    expect(activeIdentity?.objectId).toBe("arch-1");
    expect(session.getSnapshot().dirty).toBe(false);

    // Switch to Transform tab
    act(() => {
      queryFirst(mounted!.host, (el) => el.getAttribute("data-tab-value") === "transform")?.click();
    });

    // Simulate 3D Move Gizmo dragging object to X = 250 nm
    act(() => {
      session.updateDraft(activeIdentity!, (draft) =>
        updateQuantityFieldSI(draft, "translation.0", 250e-9),
      );
    });

    expect(session.getSnapshot().dirty).toBe(true);
    const txInput = queryFirst(
      mounted.host,
      (el) => el.getAttribute("aria-label") === "Center translation x",
    );
    expect(txInput).not.toBeNull();
    expect(Number(txInput!.value)).toBeCloseTo(250, 6);

    // Active 3D gesture locks Apply & Revert
    let gestureToken = 0;
    act(() => {
      gestureToken = session.beginGesture(mocks.sessionScopeKey);
    });
    const applyBtnDuringGesture = findButtonByText(mounted.host, "Apply");
    expect(applyBtnDuringGesture.disabled).toBe(true);

    act(() => {
      session.endGesture(gestureToken);
    });
    expect(findButtonByText(mounted.host, "Apply").disabled).toBe(false);

    // Apply commits with sessionScopeKey, records history, invalidates dependents, and clears objectEditSession.dirty
    mocks.commitTransaction.mockResolvedValueOnce({
      committed_scene: {
        ...mocks.sceneData,
        revision: 13,
        objects: [
          {
            ...defaultArchObject(),
            transform: {
              translation: [250e-9, 0, 0],
              rotation_quat: [0, 0, 0, 1],
              scale: [2, 2, 1],
              pivot: [0, 0, 0],
            },
          },
        ],
      },
      scene_revision: 13,
      transaction_kind: "patch_object_geometry",
    });

    await act(async () => {
      findButtonByText(mounted!.host, "Apply").click();
    });

    expect(mocks.commitTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "patch_object_geometry",
        object_id: "arch-1",
        base_revision: 12,
        transform: expect.objectContaining({
          translation: [250e-9, 0, 0],
        }),
      }),
      { sessionScopeKey: "session=s1&epoch=1&request_scope_epoch=1" },
    );
    expect(mocks.recordHistory).toHaveBeenCalledOnce();
    expect(session.getSnapshot().dirty).toBe(false);
    for (const depKey of AUTHORING_MUTATION_DEPENDENTS.geometry) {
      expect(mocks.invalidate.mock.calls.some(([k]) => k === depKey)).toBe(true);
    }

    // Drag gizmo again and Revert -> clears objectEditSession.dirty back to false
    act(() => {
      session.updateDraft(session.getSnapshot().identity!, (draft) =>
        updateQuantityFieldSI(draft, "translation.1", -75e-9),
      );
    });
    expect(session.getSnapshot().dirty).toBe(true);

    act(() => {
      findButtonByText(mounted!.host, "Revert").click();
    });
    expect(session.getSnapshot().dirty).toBe(false);
  });

  it("allows immediate clean Apply on builder.primitive with Material, Region, disambiguated name, and history", async () => {
    mocks.sceneData = {
      ...mocks.sceneData,
      objects: [
        ...mocks.sceneData.objects,
        {
          id: "existing-box",
          name: "New box",
          role: "magnet",
          geometry: { geometry_kind: "Box", geometry_params: { size: [100e-9, 100e-9, 10e-9] } },
          transform: { translation: [0, 0, 0], rotation_quat: [0, 0, 0, 1], scale: [1, 1, 1], pivot: [0, 0, 0] },
        },
      ],
    };

    const boxBuilderSel: Selection = {
      kind: "builder.primitive",
      label: "New box",
      moduleSource: "ribbon",
      nodeId: "builder:primitive:box",
      objectId: null,
      ref: null,
    };

    mounted = mountWave4TestElement(<BuilderPrimitiveInspectorPanel selection={boxBuilderSel} />);

    // Apply button is immediately visible and enabled with dirtyFields.size === 0
    const applyBtn = findButtonByText(mounted.host, "Apply");
    expect(applyBtn.disabled).toBe(false);
    expect(mounted.host.textContent).toContain("New box 2");
    expect(mounted.host.textContent).toContain("Material");
    expect(mounted.host.textContent).toContain("Region");

    // Select Material = "py" and enter Region = "top_layer"
    const pyOption = queryFirst(
      mounted.host,
      (el) => el.getAttribute("data-select-value") === "py",
    );
    expect(pyOption).not.toBeNull();
    act(() => {
      pyOption!.click();
    });

    const regionInput = queryFirst(
      mounted.host,
      (el) => el.getAttribute("placeholder") === "Optional region name",
    );
    expect(regionInput).not.toBeNull();
    setInputValue(regionInput!, "top_layer");

    mocks.commitTransaction.mockImplementationOnce(async (req: Record<string, unknown>) => ({
      committed_scene: {
        ...mocks.sceneData,
        revision: 13,
        objects: [...mocks.sceneData.objects, { id: req.object_id, name: req.name }],
      },
      scene_revision: 13,
      transaction_kind: "create_object",
    }));

    await act(async () => {
      findButtonByText(mounted!.host, "Apply").click();
    });

    expect(mocks.commitTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "create_object",
        base_revision: 12,
        name: "New box 2",
        material_ref: "py",
        region_name: "top_layer",
      }),
      { sessionScopeKey: "session=s1&epoch=1&request_scope_epoch=1" },
    );
    expect(mocks.recordHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        committedRevision: 13,
        label: "Create New box 2",
      }),
    );
    expect(mocks.setSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "object.root",
        label: "New box 2",
      }),
      "geometry-authoring",
    );
  });

  it("keeps primitiveDraftOverlayStore alive across Shape/Transform/CSG tabs, computes Cone dims, and retains lastValidSI", () => {
    const coneSel: Selection = {
      kind: "builder.primitive",
      label: "New cone",
      moduleSource: "ribbon",
      nodeId: "builder:primitive:cone",
      objectId: null,
      ref: null,
    };

    mounted = mountWave4TestElement(<BuilderPrimitiveInspectorPanel selection={coneSel} />);

    // Cone default: bottomRadius=50nm, topRadius=25nm, height=10nm -> outer diameter = 100nm
    const initialOverlay = primitiveDraftOverlayStore.getSnapshot();
    expect(initialOverlay).not.toBeNull();
    expect(initialOverlay?.kind).toBe("Cylinder");
    expect(initialOverlay?.dimensions).toEqual([100e-9, 10e-9, 100e-9]);

    // Switch to Transform tab -> overlay MUST stay published (never cleared)
    act(() => {
      queryFirst(mounted!.host, (el) => el.getAttribute("data-tab-value") === "transform")?.click();
    });
    expect(primitiveDraftOverlayStore.getSnapshot()).not.toBeNull();
    expect(primitiveDraftOverlayStore.getSnapshot()?.dimensions).toEqual([100e-9, 10e-9, 100e-9]);

    // Switch to Boolean CSG tab -> overlay MUST stay published
    act(() => {
      queryFirst(mounted!.host, (el) => el.getAttribute("data-tab-value") === "csg")?.click();
    });
    expect(primitiveDraftOverlayStore.getSnapshot()).not.toBeNull();

    // Pure lastValidSI check on transient invalid edits
    const baseCone = buildBaselineFromScene(coneSel, null, true);
    const transientInvalid = resolvePreviewOverlayDraft(
      { ...baseCone, height: -5e-9 },
      baseCone,
    );
    expect(transientInvalid.dimensions).toEqual([100e-9, 10e-9, 100e-9]);
    expect(transientInvalid.errors.height).toMatch(/greater than 0/i);

    // Unmount clears overlay
    mounted.unmount();
    mounted = null;
    expect(primitiveDraftOverlayStore.getSnapshot()).toBeNull();
  });

  it("wires uniformScale aspect-ratio locking and resolves 'mesh:building' state pill", () => {
    expect(applyUniformScaleChange([1, 1, 1], [2.5, 1, 1], true)).toEqual([2.5, 2.5, 2.5]);
    expect(applyUniformScaleChange([2, 4, 1], [3, 4, 1], true)).toEqual([3, 6, 1.5]);
    expect(applyUniformScaleChange([2, 4, 1], [3, 4, 1], false)).toEqual([3, 4, 1]);

    const boxSel: Selection = {
      kind: "builder.primitive",
      label: "New box",
      moduleSource: "ribbon",
      nodeId: "builder:primitive:box",
      objectId: null,
      ref: null,
    };
    mounted = mountWave4TestElement(<BuilderPrimitiveInspectorPanel selection={boxSel} />);

    act(() => {
      queryFirst(mounted!.host, (el) => el.getAttribute("data-tab-value") === "transform")?.click();
    });

    const sxInput = queryFirst(
      mounted.host,
      (el) => el.getAttribute("aria-label") === "Scale factors (sx, sy, sz) x",
    );
    const syInput = queryFirst(
      mounted.host,
      (el) => el.getAttribute("aria-label") === "Scale factors (sx, sy, sz) y",
    );
    const szInput = queryFirst(
      mounted.host,
      (el) => el.getAttribute("aria-label") === "Scale factors (sx, sy, sz) z",
    );
    expect(sxInput).not.toBeNull();
    setInputValue(sxInput!, "3.5");
    expect(Number(syInput!.value)).toBeCloseTo(3.5, 6);
    expect(Number(szInput!.value)).toBeCloseTo(3.5, 6);

    expect(
      resolveMeshStatusFromObject({
        id: "m1",
        tags: ["mesh:building"],
      }),
    ).toEqual({ tone: "live", label: "Mesh building" });
  });

  it("serializes distinct canonical pivot representations for centroid, origin, and custom and round-trips losslessly", () => {
    const sel: Selection = {
      kind: "object.geometry",
      label: "Geometry",
      moduleSource: "explorer",
      nodeId: "model:object:p-obj:geometry",
      objectId: "p-obj",
      ref: null,
    };
    const baseDraft = buildBaselineFromScene(
      { ...sel, kind: "builder.primitive", nodeId: "builder:primitive:box" },
      null,
      true,
    );

    const centroidTx = serializeTransformPayload({
      ...baseDraft,
      translation: [100e-9, -40e-9, 0],
      pivotMode: "centroid",
    });
    const originTx = serializeTransformPayload({
      ...baseDraft,
      translation: [100e-9, -40e-9, 0],
      pivotMode: "origin",
    });
    const originAtZeroTx = serializeTransformPayload({
      ...baseDraft,
      translation: [0, 0, 0],
      pivotMode: "origin",
    });
    const customTx = serializeTransformPayload({
      ...baseDraft,
      translation: [100e-9, -40e-9, 0],
      pivotMode: "custom",
      pivotCustom: [15e-9, 25e-9, -5e-9],
    });

    expect(centroidTx.pivot).toEqual([0, 0, 0]);
    expect(originTx.pivot).toEqual([-100e-9, 40e-9, 0]);
    expect(originTx).not.toEqual(centroidTx);
    expect(originAtZeroTx).not.toEqual(
      serializeTransformPayload({ ...baseDraft, translation: [0, 0, 0], pivotMode: "centroid" }),
    );
    expect(customTx.pivot).toEqual([15e-9, 25e-9, -5e-9]);

    // Round-trip pure Rust Transform3D (without pivot_mode key) for non-zero translation
    const rustOriginScene = {
      revision: 1,
      objects: [
        {
          id: "p-obj",
          name: "Box",
          geometry: { geometry_kind: "Box", geometry_params: { size: [100e-9, 100e-9, 10e-9] } },
          transform: {
            translation: [100e-9, -40e-9, 0],
            rotation_quat: [0, 0, 0, 1],
            scale: [1, 1, 1],
            pivot: [-100e-9, 40e-9, 0],
          },
        },
      ],
    };
    expect(buildBaselineFromScene(sel, rustOriginScene, false).pivotMode).toBe("origin");

    // Round-trip origin at [0, 0, 0] translation
    const zeroOriginScene = {
      revision: 2,
      objects: [
        {
          id: "p-obj",
          name: "Box",
          geometry: { geometry_kind: "Box", geometry_params: { size: [100e-9, 100e-9, 10e-9] } },
          transform: originAtZeroTx,
        },
      ],
    };
    expect(buildBaselineFromScene(sel, zeroOriginScene, false).pivotMode).toBe("origin");

    // Round-trip custom pivot
    const customScene = {
      revision: 3,
      objects: [
        {
          id: "p-obj",
          name: "Box",
          geometry: { geometry_kind: "Box", geometry_params: { size: [100e-9, 100e-9, 10e-9] } },
          transform: customTx,
        },
      ],
    };
    const hydratedCustom = buildBaselineFromScene(sel, customScene, false);
    expect(hydratedCustom.pivotMode).toBe("custom");
    expect(hydratedCustom.pivotCustom).toEqual([15e-9, 25e-9, -5e-9]);
  });

  it("renders a single controlled PolygonExtrusion vertex editor that updates immediately on onChange, Revert, and Bake Scale", () => {
    mocks.sceneData = {
      ...mocks.sceneData,
      objects: [
        {
          id: "poly-1",
          name: "Custom Prism",
          role: "magnet",
          geometry: {
            geometry_kind: "PolygonExtrusion",
            geometry_params: {
              height: 20e-9,
              axis: "z",
              vertices: [
                [-50e-9, -30e-9],
                [50e-9, -30e-9],
                [50e-9, 30e-9],
                [-50e-9, 30e-9],
              ],
            },
          },
          transform: {
            translation: [0, 0, 0],
            rotation_quat: [0, 0, 0, 1],
            scale: [2, 3, 1],
            pivot: [0, 0, 0],
          },
        },
      ],
    };

    const polySel: Selection = {
      kind: "object.geometry",
      label: "Geometry",
      moduleSource: "explorer",
      nodeId: "model:object:poly-1:geometry",
      objectId: "poly-1",
      ref: null,
    };
    mounted = mountWave4TestElement(<GeometryObjectInspectorPanel selection={polySel} />);

    // Single vertex editor, zero duplicate <table>
    expect(
      findElements(mounted.host, (el) => el.getAttribute("data-slot") === "polygon-vertex-editor"),
    ).toHaveLength(1);
    expect(findElements(mounted.host, (el) => el.tagName === "TABLE")).toHaveLength(0);

    const v1x = queryFirst(
      mounted.host,
      (el) => el.getAttribute("aria-label") === "Vertex 1 X (nm)",
    );
    expect(v1x).not.toBeNull();
    expect(v1x!.value).toBe("-50");

    // Edit via onChange WITHOUT blur -> immediately marks draft dirty
    setInputValue(v1x!, "-80");
    expect(findButtonByText(mounted.host, "Apply").disabled).toBe(false);

    // Revert immediately updates the controlled input back to "-50"
    act(() => {
      findButtonByText(mounted!.host, "Revert").click();
    });
    expect(v1x!.value).toBe("-50");

    // Bake Scale into Dimensions ([2, 3, 1]) updates controlled vertex input to -100 nm
    act(() => {
      queryFirst(mounted!.host, (el) => el.getAttribute("data-tab-value") === "transform")?.click();
    });
    act(() => {
      findButtonByText(mounted!.host, "Bake Scale into Dimensions").click();
    });
    act(() => {
      queryFirst(mounted!.host, (el) => el.getAttribute("data-tab-value") === "shape")?.click();
    });
    const bakedV1x = queryFirst(
      mounted.host,
      (el) => el.getAttribute("aria-label") === "Vertex 1 X (nm)",
    );
    expect(bakedV1x?.value).toBe("-100");
  });

  it("recovers from 409 scene_revision_conflict via Refetch Scene -> Rebase Draft -> Retry Apply", async () => {
    const geomSel: Selection = {
      kind: "object.geometry",
      label: "Geometry",
      moduleSource: "explorer",
      nodeId: "model:object:arch-1:geometry",
      objectId: "arch-1",
      ref: null,
    };
    mounted = mountWave4TestElement(<GeometryObjectInspectorPanel selection={geomSel} />);

    // Stage an edit via 3D Move Gizmo
    const session = mocks.objectEditSession!;
    act(() => {
      session.updateDraft(session.getSnapshot().identity!, (draft) =>
        updateQuantityFieldSI(draft, "translation.0", 120e-9),
      );
    });

    // First Apply rejects with 409 scene_revision_conflict
    mocks.commitTransaction.mockRejectedValueOnce(
      new ControlRoomApiError(
        "Scene revision conflict at rev 12",
        409,
        "req-1",
        "scene_revision_conflict",
      ),
    );

    await act(async () => {
      findButtonByText(mounted!.host, "Apply").click();
    });

    expect(
      queryFirst(mounted.host, (el) => el.getAttribute("data-revision-conflict") === "true"),
    ).not.toBeNull();

    // Step 1: Refetch Scene updates scene revision to 14
    mocks.refetchScene.mockImplementationOnce(() => {
      mocks.sceneData = {
        ...mocks.sceneData,
        revision: 14,
      };
    });
    act(() => {
      findElements(
        mounted!.host,
        (el) => el.tagName === "BUTTON" && (el.textContent ?? "").trim() === "Refetch Scene",
      )[0]?.click();
    });
    mounted.rerender(<GeometryObjectInspectorPanel selection={geomSel} />);

    // Step 2: Rebase Draft
    act(() => {
      findElements(
        mounted!.host,
        (el) => el.tagName === "BUTTON" && (el.textContent ?? "").trim() === "Rebase Draft",
      )[0]?.click();
    });

    // Step 3: Retry Apply succeeds against rev 14
    mocks.commitTransaction.mockResolvedValueOnce({
      committed_scene: {
        ...mocks.sceneData,
        revision: 15,
        objects: [
          {
            ...defaultArchObject(),
            transform: {
              translation: [120e-9, 0, 0],
              rotation_quat: [0, 0, 0, 1],
              scale: [2, 2, 1],
              pivot: [0, 0, 0],
            },
          },
        ],
      },
      scene_revision: 15,
      transaction_kind: "patch_object_geometry",
    });

    await act(async () => {
      findElements(
        mounted!.host,
        (el) => el.tagName === "BUTTON" && (el.textContent ?? "").trim() === "Retry Apply",
      )[0]?.click();
    });

    expect(mocks.commitTransaction).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "patch_object_geometry",
        object_id: "arch-1",
        base_revision: 14,
      }),
      { sessionScopeKey: "session=s1&epoch=1&request_scope_epoch=1" },
    );
    expect(
      queryFirst(mounted.host, (el) => el.getAttribute("data-revision-conflict") === "true"),
    ).toBeNull();
    expect(session.getSnapshot().dirty).toBe(false);
  });

  it("bakes uniform ImportedMesh scale into unit_scale and disables non-uniform ImportedMesh scale baking", () => {
    const importedObjUniform = {
      id: "mesh-import-1",
      name: "CAD Housing",
      role: "magnet",
      geometry: {
        geometry_kind: "ImportedMesh",
        geometry_params: {
          asset_path: "assets/housing.stl",
          unit_scale: 1e-3,
        },
      },
      transform: {
        translation: [0, 0, 0],
        rotation_quat: [0, 0, 0, 1],
        scale: [2.5, 2.5, 2.5],
        pivot: [0, 0, 0],
      },
    };

    const importedSel: Selection = {
      kind: "object.geometry",
      label: "Geometry",
      moduleSource: "explorer",
      nodeId: "model:object:mesh-import-1:geometry",
      objectId: "mesh-import-1",
      ref: null,
    };

    const uniformDraft = buildBaselineFromScene(
      importedSel,
      { objects: [importedObjUniform], materials: [], revision: 1 } as never,
      false,
    );
    expect(canBakeScaleIntoDraft(uniformDraft)).toEqual({ ok: true });
    const bakedUniform = bakeScaleIntoDraft(uniformDraft);
    expect(bakedUniform).toEqual({
      meshUnitScale: 2.5e-3,
      scale: [1, 1, 1],
    });
    expect(serializeGeometryPayload({ ...uniformDraft, ...bakedUniform })).toEqual({
      geometry_kind: "ImportedMesh",
      geometry_params: {
        asset_path: "assets/housing.stl",
        unit_scale: 2.5e-3,
      },
    });

    // Non-uniform ImportedMesh scale keeps scale & unit_scale untouched and disables UI button with clear message
    const importedObjNonUniform = {
      ...importedObjUniform,
      transform: {
        ...importedObjUniform.transform,
        scale: [2, 3, 1],
      },
    };
    mocks.sceneData = {
      ...mocks.sceneData,
      objects: [importedObjNonUniform],
    };

    const nonUniformDraft = buildBaselineFromScene(
      importedSel,
      mocks.sceneData as never,
      false,
    );
    const nonUniformCheck = canBakeScaleIntoDraft(nonUniformDraft);
    expect(nonUniformCheck.ok).toBe(false);
    expect(bakeScaleIntoDraft(nonUniformDraft)).toEqual({});

    mounted = mountWave4TestElement(<GeometryObjectInspectorPanel selection={importedSel} />);
    act(() => {
      queryFirst(mounted!.host, (el) => el.getAttribute("data-tab-value") === "transform")?.click();
    });

    const bakeBtn = findButtonByText(mounted.host, "Bake Scale into Dimensions");
    expect(bakeBtn.disabled).toBe(true);
    expect(mounted.host.textContent).toContain(
      "ImportedMesh only supports uniform unit_scale baking (sx = sy = sz).",
    );
  });
});
