import { act, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Selection } from "@/kernel/selection/selectionTypes";

import {
  findElement,
  findElements,
  mountWave4TestElement,
  type TestElement,
  TestEvent,
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
vi.mock("@radix-ui/react-popover", () => ({
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Anchor: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Close: ({ children }: { children?: ReactNode }) => <>{children}</>,
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

const mocks = vi.hoisted(() => ({
  sceneData: {
    revision: 21,
    materials: [
      {
        id: "shared-co",
        name: "Cobalt Film",
        properties: { Ms: 1.42e6, Aex: 30e-12, alpha: 0.01 },
      },
    ],
    objects: [
      {
        id: "disk-a",
        name: "Disk A",
        role: "magnet",
        material_ref: "shared-co",
        physics_stack: [
          {
            kind: "uniaxial_anisotropy",
            enabled: true,
            params: { ku1: -2.0e5, ku2: 1.5e5, axis: [0, 0, 1] },
          },
        ],
      },
      {
        id: "disk-b",
        name: "Disk B",
        role: "magnet",
        material_ref: "shared-co",
      },
    ],
  },
  createMaterial: vi.fn().mockResolvedValue({ committed_scene: { revision: 22 }, scene_revision: 22 }),
  patchMaterialAsset: vi.fn().mockResolvedValue({ committed_scene: { revision: 22 }, scene_revision: 22 }),
  patchObjectInteraction: vi.fn().mockResolvedValue({ scene_revision: 23 }),
  patchObject: vi.fn().mockResolvedValue({ revision: 22 }),
}));

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => ({
    api: {
      model: {
        createMaterial: mocks.createMaterial,
        patchMaterialAsset: mocks.patchMaterialAsset,
        patchObjectInteraction: mocks.patchObjectInteraction,
        patchObject: mocks.patchObject,
      },
    },
    commands: { execute: vi.fn(), getSessionScopeKey: () => "s1" },
    layout: { get: () => ({ activeViewportMainModuleId: "viewport-3d" }), setPanelVisible: vi.fn() },
    resources: { invalidate: vi.fn() },
    selection: { set: vi.fn() },
  }),
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
  publishCommittedSceneResource: vi.fn(),
  useSceneResource: () => ({ data: mocks.sceneData, status: "ready", error: null }),
}));

vi.mock("@/kernel/layout/MaterialLibraryDialog", () => ({
  MaterialLibraryDialog: () => null,
}));

import {
  buildUniaxialInteractionPayload,
  classifyUniaxialAnisotropyRegime,
  computeExchangeLengthMeters,
  ObjectMaterialInspectorPanel,
  orthogonalizeAxisGramSchmidt,
  REFERENCE_MATERIALS_CATALOG,
  validateBornCubicStability,
} from "./ObjectMaterialSpec";

describe("ObjectMaterialSpec (Task 15 — Unified Material & P0 Ku2)", () => {
  let mounted: ReturnType<typeof mountWave4TestElement> | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    mocks.createMaterial.mockClear();
    mocks.patchMaterialAsset.mockClear();
    mocks.patchObjectInteraction.mockClear();
  });

  it("ships 9+ curated reference materials and preserves Ku2 losslessly in uniaxial interaction payloads", () => {
    expect(REFERENCE_MATERIALS_CATALOG.length).toBeGreaterThanOrEqual(9);
    const cobalt = REFERENCE_MATERIALS_CATALOG.find((m) => m.id === "preset-cobalt");
    expect(cobalt?.ku1).toBe(4.5e5);
    expect(cobalt?.ku2).toBe(1.5e5);

    const payload = buildUniaxialInteractionPayload({
      uniaxialEnabled: true,
      ku1: -2.0e5,
      ku2: 1.5e5,
      uniaxialAxis: [0, 0, 2],
    });
    expect(payload).toEqual({
      enabled: true,
      present: true,
      params: {
        ku1: -2.0e5,
        ku2: 1.5e5,
        axis: [0, 0, 1],
      },
    });

    // Easy cone classification for Ku1 = -200 kJ/m^3, Ku2 = +150 kJ/m^3 -> sin^2(theta) = 2/3
    const regime = classifyUniaxialAnisotropyRegime(-2.0e5, 1.5e5);
    expect(regime.label).toContain("Easy cone");
    expect(regime.coneAngleDeg).toBeCloseTo(54.7356, 2);

    // Permalloy exchange length ~ 5.69 nm
    const lex = computeExchangeLengthMeters(8.0e5, 13e-12);
    expect((lex ?? 0) * 1e9).toBeCloseTo(5.6858, 2);

    // Gram-Schmidt orthogonalization & Born stability
    const ortho = orthogonalizeAxisGramSchmidt([1, 0, 0], [0.5, 0.5, 0]);
    expect(ortho[0]).toBeCloseTo(0, 6);
    expect(ortho[1]).toBeCloseTo(1, 6);
    expect(validateBornCubicStability(210e9, 250e9, 80e9)).toMatch(/C11 - C12 > 0/);
    expect(validateBornCubicStability(210e9, 130e9, 80e9)).toBeNull();
  });

  it("renders Ku2 field, shared-material warning with Duplicate & Unlink, and commits Cobalt preset with Ku2 via Apply", async () => {
    const sel: Selection = {
      kind: "object.material",
      label: "Material",
      moduleSource: "explorer",
      nodeId: "model:object:disk-a:material",
      objectId: "disk-a",
      ref: null,
    };
    mounted = mountWave4TestElement(<ObjectMaterialInspectorPanel selection={sel} />);

    // Renders both Ku1 and Ku2 rows + Easy cone regime + Shared across 2 objects warning
    expect(mounted.host.textContent).toContain("First-order uniaxial constant");
    expect(mounted.host.textContent).toContain("Second-order uniaxial constant");
    expect(mounted.host.textContent).toContain("Easy cone");
    expect(mounted.host.textContent).toContain("Shared across 2 objects");
    expect(findElements(mounted.host, (el) => el.tagName === "SELECT")).toHaveLength(0);

    // Pick hcp Cobalt (which has Ku1 = 450 kJ/m^3 AND Ku2 = 150 kJ/m^3) from the reference catalog
    const cobaltBtn = findElement(
      mounted.host,
      (el) => el.getAttribute("data-preset-id") === "preset-cobalt",
    );
    expect(cobaltBtn).not.toBeNull();
    act(() => {
      cobaltBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });

    // Click Apply in the CommitBar -> must create material AND patch uniaxial_anisotropy with ku2 = 1.5e5!
    const applyBtn = findElement(
      mounted.host,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Apply")),
    );
    expect(applyBtn).not.toBeNull();
    await act(async () => {
      applyBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });

    expect(mocks.createMaterial).toHaveBeenCalledTimes(1);
    expect(mocks.patchObjectInteraction).toHaveBeenCalledWith(
      "disk-a",
      "uniaxial_anisotropy",
      expect.objectContaining({
        enabled: true,
        params: expect.objectContaining({
          ku1: 4.5e5,
          ku2: 1.5e5,
        }),
      }),
    );
  });

  it("edits Ms + Ku1 on an already-assigned material and commits plain-number patchMaterialAsset while preserving Ku2 = 150 kJ/m³", async () => {
    type TestInputCompat = TestElement & {
      _valueTracker?: { setValue: (next: string) => void };
      _onPropertyChange?: (event: {
        propertyName: string;
        target: TestElement;
        srcElement: TestElement;
      }) => void;
      attachEvent?: (
        name: string,
        fn: (event: {
          propertyName: string;
          target: TestElement;
          srcElement: TestElement;
        }) => void,
      ) => void;
      detachEvent?: () => void;
    };
    const editQuantityInput = (input: TestElement, nextText: string) => {
      const compat = input as TestInputCompat;
      compat.attachEvent ??= (_name, fn) => {
        compat._onPropertyChange = fn;
      };
      compat.detachEvent ??= () => {
        compat._onPropertyChange = undefined;
      };
      input.focus();
      input.dispatchEvent(new TestEvent("focusin", { bubbles: true }));
      const prev = input.value;
      input.value = nextText;
      compat._valueTracker?.setValue(prev);
      if (compat._onPropertyChange) {
        compat._onPropertyChange({
          propertyName: "value",
          target: input,
          srcElement: input,
        });
      } else {
        input.dispatchEvent(new TestEvent("input", { bubbles: true }));
      }
      input.dispatchEvent(new TestEvent("focusout", { bubbles: true }));
    };

    const sel: Selection = {
      kind: "object.material",
      label: "Material",
      moduleSource: "explorer",
      nodeId: "model:object:disk-a:material",
      objectId: "disk-a",
      ref: null,
    };
    mounted = mountWave4TestElement(<ObjectMaterialInspectorPanel selection={sel} />);

    const msRow = findElement(
      mounted.host,
      (el) => el.getAttribute("data-row") === "ms",
      "Ms row",
    );
    const msInput = findElement(
      msRow,
      (el) => el.tagName === "INPUT" && el.getAttribute("data-slot") === "input-group-control",
      "Ms quantity input",
    );
    const ku1Row = findElement(
      mounted.host,
      (el) => el.getAttribute("data-row") === "ku1",
      "Ku1 row",
    );
    const ku1Input = findElement(
      ku1Row,
      (el) => el.tagName === "INPUT" && el.getAttribute("data-slot") === "input-group-control",
      "Ku1 quantity input",
    );

    act(() => {
      editQuantityInput(msInput, "1500");
      editQuantityInput(ku1Input, "-250");
    });

    const applyBtn = findElement(
      mounted.host,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Apply")),
    );
    expect(applyBtn).not.toBeNull();
    await act(async () => {
      applyBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });

    expect(mocks.createMaterial).not.toHaveBeenCalled();
    expect(mocks.patchMaterialAsset).toHaveBeenCalledWith(
      "shared-co",
      {
        name: "Cobalt Film",
        properties: {
          Ms: 1.5e6,
          Aex: 30e-12,
          alpha: 0.01,
          Dind: null,
          Dbulk: null,
        },
      },
      { baseRevision: 21 },
    );
    expect(mocks.patchObjectInteraction).toHaveBeenCalledWith(
      "disk-a",
      "uniaxial_anisotropy",
      {
        base_revision: 22,
        enabled: true,
        present: true,
        params: {
          ku1: -2.5e5,
          ku2: 1.5e5,
          axis: [0, 0, 1],
        },
      },
    );
  });
});
