import { act, createContext, useContext, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultArrayAxisSpec } from "@/kernel/authoring/array3dModel";
import { ObjectEditSessionController } from "@/kernel/authoring/object-edit/ObjectEditSessionController";
import type { GeometryObjectDraft } from "@/kernel/authoring/object-edit/objectEditTypes";
import { TestElement } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import type { Selection } from "@/kernel/selection/selectionTypes";

import {
  findElements,
  mountWave4TestElement,
  TestEvent,
} from "../../../panels/model-roots/wave4TestDom.test-support";
import { resetPersistedInspectorModeTabs } from "../../../template/useInspectorSpecController";

const TabsMockCtx = createContext<{
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
  Cancel: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
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
  List: ({ children, className }: { children?: ReactNode; className?: string }) => (
    <div className={className} role="tablist">
      {children}
    </div>
  ),
  Trigger: ({
    children,
    value,
    className,
  }: {
    children?: ReactNode;
    value: string;
    className?: string;
  }) => {
    const ctx = useContext(TabsMockCtx);
    return (
      <button
        aria-selected={ctx.value === value}
        className={className}
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
vi.mock("@radix-ui/react-switch", () => ({
  Root: ({
    checked,
    disabled,
    onCheckedChange,
    "aria-label": ariaLabel,
  }: {
    checked?: boolean;
    disabled?: boolean;
    onCheckedChange?: (v: boolean) => void;
    "aria-label"?: string;
  }) => (
    <button
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      role="switch"
      type="button"
      onClick={() => onCheckedChange?.(!checked)}
    />
  ),
  Thumb: () => null,
}));
vi.mock("@radix-ui/react-collapsible", () => ({
  Root: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

const mocks = vi.hoisted(() => ({
  commitTransaction: vi.fn(),
  invalidate: vi.fn(),
  objectEditSession: null as ObjectEditSessionController<GeometryObjectDraft> | null,
  publishCommittedScene: vi.fn(),
  readScene: vi.fn(),
  recordHistory: vi.fn(),
  sceneData: null as Record<string, unknown> | null,
  setSelection: vi.fn(),
}));

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => {
    mocks.objectEditSession ??= new ObjectEditSessionController<GeometryObjectDraft>();
    return {
      api: {
        model: {
          commitTransaction: mocks.commitTransaction,
          readScene: mocks.readScene,
        },
        resourceCacheScope: "test-scope",
      },
      authoringHistory: {
        getGeneration: () => 0,
        record: mocks.recordHistory,
      },
      commands: {
        execute: vi.fn(),
        getSessionScopeKey: () => "session=s1",
      },
      layout: {
        setPanelVisible: vi.fn(),
      },
      objectEditSession: mocks.objectEditSession,
      resources: {
        invalidate: mocks.invalidate,
      },
      selection: {
        get: () => null,
        set: mocks.setSelection,
      },
    };
  },
}));

vi.mock("@/kernel/resources/useSessionScopedResourceKey", () => ({
  useSessionScopedResourceKey: (path: string) => ({
    key: path,
    sessionIdentity: { sessionId: "s1", sessionEpoch: 1, requestScopeEpoch: 1 },
  }),
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
  publishCommittedSceneResource: mocks.publishCommittedScene,
  useGeometryValidationResource: () => ({ data: null, status: "ready" }),
  useSceneResource: () => ({
    data: mocks.sceneData,
    refetch: vi.fn(),
    sessionScopeKey: "session=s1",
    status: "ready",
  }),
}));

import {
  buildGeometryNodeSelection,
  GeometryNodeInspectorPanel,
  GeometryObjectInspectorPanel,
} from "./index";

function queryFirst(
  root: TestElement,
  predicate: (el: TestElement) => boolean,
): TestElement | null {
  return findElements(root, predicate)[0] ?? null;
}

function assertMaxOnePrimaryInsideCommitBar(host: TestElement): {
  applyButton: TestElement | null;
  count: number;
} {
  const allPrimaryButtons = findElements(
    host,
    (el) =>
      el.tagName === "BUTTON" &&
      (el.getAttribute("class") ?? "").split(/\s+/).includes("fm-button--primary"),
  );
  const commitBar = queryFirst(
    host,
    (el) => el.getAttribute("data-slot") === "inspector-commit-bar",
  );
  const commitBarPrimaryButtons = commitBar
    ? findElements(
        commitBar,
        (el) =>
          el.tagName === "BUTTON" &&
          (el.getAttribute("class") ?? "").split(/\s+/).includes("fm-button--primary"),
      )
    : [];

  expect(allPrimaryButtons.length).toBeLessThanOrEqual(1);
  expect(allPrimaryButtons.length).toBe(commitBarPrimaryButtons.length);
  return {
    applyButton: commitBarPrimaryButtons[0] ?? null,
    count: allPrimaryButtons.length,
  };
}

function setInputValue(input: TestElement, nextValue: string): void {
  act(() => {
    const compat = input as TestElement & {
      _valueTracker?: { setValue: (v: string) => void };
      _onPropertyChange?: (evt: { propertyName: string; target: TestElement; srcElement: TestElement }) => void;
      attachEvent?: (name: string, listener: (evt: { propertyName: string; target: TestElement; srcElement: TestElement }) => void) => void;
      detachEvent?: () => void;
    };
    if (!compat.attachEvent) {
      compat.attachEvent = (_name, listener) => {
        compat._onPropertyChange = listener;
      };
      compat.detachEvent = () => {
        compat._onPropertyChange = undefined;
      };
    }
    input.focus();
    input.dispatchEvent(new TestEvent("focusin", { bubbles: true }));
    const previous = input.value;
    input.value = nextValue;
    compat._valueTracker?.setValue(previous);
    if (compat._onPropertyChange) {
      compat._onPropertyChange({
        propertyName: "value",
        srcElement: input,
        target: input,
      });
      return;
    }
    input.dispatchEvent(new TestEvent("input", { bubbles: true }));
  });
}

describe("Geometry Inspector Ergonomics Redesign (PR 1–3 DOM verification)", () => {
  let mounted: ReturnType<typeof mountWave4TestElement> | null = null;

  beforeEach(() => {
    resetPersistedInspectorModeTabs();
    mocks.objectEditSession?.clear();
    mocks.commitTransaction.mockReset();
    mocks.invalidate.mockReset();
    mocks.publishCommittedScene.mockReset();
    mocks.recordHistory.mockReset();
    mocks.setSelection.mockReset();
    mocks.readScene.mockReset().mockImplementation(async () => mocks.sceneData);
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
  });

  it("renders 2 tabs (Geometry + Placement), Primitive Modifiers bar, header Delete Object, and hides identity Reset Scale", () => {
    mocks.sceneData = {
      materials: [{ id: "py", name: "Permalloy" }],
      objects: [
        {
          geometry: { geometry_kind: "Box", geometry_params: { size: [400e-9, 400e-9, 20e-9] } },
          id: "film_1",
          name: "Film",
          role: "magnet",
          transform: {
            pivot: [0, 0, 0],
            rotation_quat: [0, 0, 0, 1],
            scale: [1, 1, 1],
            translation: [0, 0, 0],
          },
        },
        {
          geometry: { geometry_kind: "Cylinder", geometry_params: { height: 24e-9, radius: 30e-9 } },
          id: "tool_1",
          name: "Tool",
          role: "magnet",
        },
      ],
      revision: 5,
    };

    const sel: Selection = {
      kind: "object.geometry",
      label: "Geometry",
      moduleSource: "explorer",
      nodeId: "model:object:film_1:geometry",
      objectId: "film_1",
      ref: null,
    };

    mounted = mountWave4TestElement(<GeometryObjectInspectorPanel selection={sel} />);

    // Exactly 2 mode tabs: Geometry and Placement
    const tabs = findElements(mounted.host, (el) => el.getAttribute("role") === "tab");
    expect(tabs.map((tab) => (tab.textContent ?? "").trim())).toEqual(["Geometry", "Placement"]);

    // Modifiers & Boolean tools bar visible directly below primitive dimensions
    expect(mounted.host.textContent).toContain("Cut Hole");
    expect(mounted.host.textContent).toContain("Array 3D");
    expect(mounted.host.textContent).toContain("Combine with");
    // Delete Object lives in header overflow menu, not collapsed Object lifecycle section
    expect(mounted.host.textContent).toContain("Delete Object");
    expect(mounted.host.textContent).not.toContain("Object lifecycle");
    expect(assertMaxOnePrimaryInsideCommitBar(mounted.host).applyButton?.disabled).toBe(true);

    // Placement tab hides Reset Scale [1, 1, 1] when scale is already [1, 1, 1]
    act(() => {
      queryFirst(mounted!.host, (el) => el.getAttribute("data-tab-value") === "transform")?.click();
    });
    expect(mounted.host.textContent).not.toContain("Reset Scale [1, 1, 1]");
    expect(assertMaxOnePrimaryInsideCommitBar(mounted.host).count).toBeLessThanOrEqual(1);
  });

  it("expands composite operand inline (Cylinder radius + controlled Array 3D), commits atomically via single CommitBar with Undo, and blocks composite Bake Scale", async () => {
    const holeAxes = [
      defaultArrayAxisSpec("x", { count: 3, direction: "symmetric", enabled: true, pitch_m: 100e-9 }),
      defaultArrayAxisSpec("y", { count: 3, direction: "symmetric", enabled: true, pitch_m: 100e-9 }),
      defaultArrayAxisSpec("z", { count: 1, direction: "positive", enabled: false, pitch_m: 100e-9 }),
    ];
    mocks.sceneData = {
      materials: [{ id: "py", name: "Permalloy" }],
      objects: [
        {
          geometry: {
            geometry_kind: "Difference",
            geometry_params: {
              operands: [
                {
                  enabled: true,
                  geometry: {
                    geometry_kind: "Box",
                    geometry_params: { size: [400e-9, 400e-9, 20e-9] },
                  },
                  label: "Film",
                  operand_id: "op_film",
                },
                {
                  enabled: true,
                  geometry: {
                    geometry_kind: "Array3D",
                    geometry_params: {
                      axes: holeAxes,
                      child: {
                        geometry_kind: "Cylinder",
                        geometry_params: { axis: [0, 0, 1], height: 24e-9, radius: 25e-9 },
                      },
                      merge_overlapping: false,
                    },
                  },
                  label: "Hole",
                  operand_id: "op_hole",
                },
              ],
            },
          },
          id: "film_diff",
          name: "Film",
          role: "magnet",
          transform: {
            pivot: [0, 0, 0],
            rotation_quat: [0, 0, 0, 1],
            scale: [2, 2, 1],
            translation: [0, 0, 0],
          },
        },
      ],
      revision: 10,
    };

    const sel: Selection = {
      kind: "object.geometry",
      label: "Geometry",
      moduleSource: "explorer",
      nodeId: "model:object:film_diff:geometry",
      objectId: "film_diff",
      ref: null,
    };

    mounted = mountWave4TestElement(<GeometryObjectInspectorPanel selection={sel} />);

    // Replaces dead read-only overview with Interactive Geometry Stack
    expect(mounted.host.textContent).not.toContain("Composite geometry overview");
    expect(mounted.host.textContent).toContain("Geometry stack");

    // Click Hole operand row to expand inline
    const holeRowBtn = queryFirst(
      mounted.host,
      (el) => el.tagName === "BUTTON" && (el.textContent ?? "").includes("Hole"),
    );
    expect(holeRowBtn).not.toBeNull();
    act(() => {
      holeRowBtn!.click();
    });

    // Inline Cylinder radius + controlled Array 3D table render with ZERO embedded Apply Array 3D button
    const arrayTableSection = queryFirst(
      mounted.host,
      (el) => el.getAttribute("data-slot") === "array3d-lattice-section",
    );
    expect(arrayTableSection).not.toBeNull();
    expect(arrayTableSection!.textContent).not.toContain("Apply Array 3D");
    const radiusInput = queryFirst(
      mounted.host,
      (el) => el.getAttribute("aria-label") === "Hole radius (nm)",
    );
    const xCountInput = queryFirst(
      mounted.host,
      (el) => el.getAttribute("aria-label") === "X count",
    );
    expect(radiusInput).not.toBeNull();
    expect(xCountInput).not.toBeNull();

    // Edit BOTH radius (25 -> 35 nm) and X count (3 -> 4) in the same view
    setInputValue(radiusInput!, "35");
    setInputValue(xCountInput!, "4");

    // Exactly 1 primary button in the entire rendered DOM, strictly inside CommitBar and enabled!
    const primaryCheck = assertMaxOnePrimaryInsideCommitBar(mounted.host);
    expect(primaryCheck.count).toBe(1);
    expect(primaryCheck.applyButton?.disabled).toBe(false);

    // Placement tab blocks Bake Scale on composite object
    act(() => {
      queryFirst(mounted!.host, (el) => el.getAttribute("data-tab-value") === "transform")?.click();
    });
    const bakeBtn = queryFirst(
      mounted.host,
      (el) => el.tagName === "BUTTON" && (el.textContent ?? "").includes("Bake Scale into Dimensions"),
    );
    expect(bakeBtn?.disabled).toBe(true);
    expect(mounted.host.textContent).toContain("Bake Scale applies to primitive solids only.");

    // Commit both inline edits atomically via the single footer Apply button
    mocks.commitTransaction.mockResolvedValueOnce({
      committed_scene: { ...mocks.sceneData, revision: 11 },
      scene_revision: 11,
      transaction_kind: "patch_object_geometry",
    });
    const applyBtn = queryFirst(
      mounted.host,
      (el) =>
        el.tagName === "BUTTON" &&
        (el.getAttribute("class") ?? "").includes("fm-button--primary"),
    );
    expect(applyBtn).not.toBeNull();
    await act(async () => {
      applyBtn!.click();
    });

    expect(mocks.commitTransaction).toHaveBeenCalledTimes(1);
    const sentReq = mocks.commitTransaction.mock.calls[0]?.[0] as {
      geometry: { geometry_params: { operands: Array<Record<string, unknown>> } };
      kind: string;
    };
    expect(sentReq.kind).toBe("patch_object_geometry");
    const patchedHole = sentReq.geometry.geometry_params.operands[1]?.geometry as {
      geometry_params: { axes: Array<{ count: number }>; child: { geometry_params: { radius: number } } };
    };
    expect(patchedHole.geometry_params.child.geometry_params.radius).toBeCloseTo(35e-9, 15);
    expect(patchedHole.geometry_params.axes[0]?.count).toBe(4);
    expect(mocks.recordHistory).toHaveBeenCalledTimes(1);
  });

  it("renders GeometryNodeInspectorPanel for Array3D with 'Modifier local transform', secondary Edit Unit Geometry, controlled Array 3D, and Undo history", async () => {
    const holeAxes = [
      defaultArrayAxisSpec("x", { count: 3, direction: "symmetric", enabled: true, pitch_m: 100e-9 }),
      defaultArrayAxisSpec("y", { count: 3, direction: "symmetric", enabled: true, pitch_m: 100e-9 }),
      defaultArrayAxisSpec("z", { count: 1, direction: "positive", enabled: false, pitch_m: 100e-9 }),
    ];
    mocks.sceneData = {
      objects: [
        {
          geometry: {
            geometry_kind: "Difference",
            geometry_params: {
              operands: [
                {
                  enabled: true,
                  geometry: { geometry_kind: "Box", geometry_params: { size: [400e-9, 400e-9, 20e-9] } },
                  label: "Film",
                  operand_id: "op_film",
                },
                {
                  enabled: true,
                  geometry: {
                    geometry_kind: "Array3D",
                    geometry_params: {
                      axes: holeAxes,
                      child: {
                        geometry_kind: "Cylinder",
                        geometry_params: { axis: [0, 0, 1], height: 24e-9, radius: 25e-9 },
                      },
                      merge_overlapping: false,
                    },
                  },
                  label: "Hole",
                  operand_id: "op_hole",
                },
              ],
            },
          },
          id: "film_diff",
          name: "Film",
        },
      ],
      revision: 14,
    };

    const nodeSelection: Selection = {
      ...buildGeometryNodeSelection("film_diff", "op_hole", "Hole"),
      moduleSource: "explorer",
    };

    mounted = mountWave4TestElement(<GeometryNodeInspectorPanel selection={nodeSelection} />);

    expect(mounted.host.textContent).toContain("Modifier local transform");
    expect(mounted.host.textContent).not.toContain("Primitive dimensions & local transform");
    expect(mounted.host.textContent).not.toContain("Apply Array 3D");

    const editUnitBtn = queryFirst(
      mounted.host,
      (el) => el.tagName === "BUTTON" && (el.textContent ?? "").includes("Edit Unit Geometry"),
    );
    expect(editUnitBtn).not.toBeNull();
    expect(editUnitBtn!.getAttribute("class") ?? "").not.toContain("fm-button--primary");
    expect(assertMaxOnePrimaryInsideCommitBar(mounted.host).applyButton?.disabled).toBe(true);

    // Stage an Array 3D edit -> CommitBar lights up as the ONLY primary button
    const xCountInput = queryFirst(
      mounted.host,
      (el) => el.getAttribute("aria-label") === "X count",
    );
    expect(xCountInput).not.toBeNull();
    setInputValue(xCountInput!, "5");
    const dirtyCheck = assertMaxOnePrimaryInsideCommitBar(mounted.host);
    expect(dirtyCheck.count).toBe(1);
    expect(dirtyCheck.applyButton?.disabled).toBe(false);

    mocks.commitTransaction.mockResolvedValueOnce({
      committed_scene: { ...mocks.sceneData, revision: 15 },
      scene_revision: 15,
      transaction_kind: "patch_object_geometry",
    });

    const applyBtn = queryFirst(
      mounted.host,
      (el) =>
        el.tagName === "BUTTON" &&
        (el.getAttribute("class") ?? "").includes("fm-button--primary"),
    );
    await act(async () => {
      applyBtn!.click();
    });

    expect(mocks.commitTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.recordHistory).toHaveBeenCalledTimes(1);
  });
});
