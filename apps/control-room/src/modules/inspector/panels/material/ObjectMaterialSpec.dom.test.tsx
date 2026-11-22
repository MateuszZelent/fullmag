import { act, createContext, type ReactNode, useContext } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MODEL_MATERIAL_PATH,
  MODEL_OBJECT_INTERACTION_PATH,
  MODEL_SCENE_PATH,
} from "@/kernel/api/apiPaths";
import type {
  MaterialLibraryEntryResource,
  SceneMaterialResource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import { ControlRoomApiError } from "@/kernel/api/ControlRoomApi";
import type { MaterialCatalogSelection } from "@/shared/domain/material/materialLibrary";
import type { Selection } from "@/kernel/selection/selectionTypes";

import {
  findElement,
  findElements,
  mountWave4TestElement,
  type TestElement,
  TestEvent,
} from "../model-roots/wave4TestDom.test-support";

const SelectMockContext = createContext<{
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
  Root: ({
    children,
    value,
    onValueChange,
  }: {
    children?: ReactNode;
    value?: string;
    onValueChange?: (val: string) => void;
  }) => (
    <SelectMockContext.Provider value={{ value, onValueChange }}>
      <div>{children}</div>
    </SelectMockContext.Provider>
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
    const ctx = useContext(SelectMockContext);
    return (
      <button
        data-select-item-value={value}
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

function defaultSceneFixture(): SceneResource {
  return {
    revision: 21,
    materials: [
      {
        id: "shared-co",
        name: "Cobalt Film",
        properties: { Ms: 1.42e6, Aex: 30e-12, alpha: 0.01 },
        references: [
          {
            label: "Co reference",
            url: "https://doi.org/10.1063/1.1724669",
            citation: "J. Appl. Phys. 32, 344S (1961)",
          },
        ],
        source: {
          catalog_id: "builtin:cobalt",
          catalog_revision: 3,
          name: "Cobalt",
          kind: "builtin",
          properties: { Ms: 1.4e6, Aex: 30e-12, alpha: 0.01, Dind: null, Dbulk: null },
          references: [
            {
              label: "Co reference",
              url: "https://doi.org/10.1063/1.1724669",
              citation: "J. Appl. Phys. 32, 344S (1961)",
            },
          ],
        },
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
  };
}

const mocks = vi.hoisted(() => ({
  sceneData: null as unknown as SceneResource,
  sceneRefetch: vi.fn(),
  materialRefetch: vi.fn(),
  uniaxialRefetch: vi.fn(),
  sessionIdentity: {
    sessionId: "s1",
    sessionEpoch: "e1",
    requestScopeEpoch: "r1",
  },
  lastDialogProps: null as null | {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onUseMaterial?: (selection: MaterialCatalogSelection) => Promise<void>;
    modelMaterial?: SceneMaterialResource;
  },
  sceneLoad: vi.fn(),
  createMaterial: vi.fn(),
  patchMaterialAsset: vi.fn(),
  patchObjectInteraction: vi.fn(),
  patchObject: vi.fn(),
  commitTransaction: vi.fn(),
  invalidate: vi.fn(),
  invalidatePrefix: vi.fn(),
  publishCommittedSceneResource: vi.fn(),
  historyRecord: vi.fn(),
}));

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => ({
    api: {
      model: {
        scene: mocks.sceneLoad,
        createMaterial: mocks.createMaterial,
        patchMaterialAsset: mocks.patchMaterialAsset,
        patchObjectInteraction: mocks.patchObjectInteraction,
        patchObject: mocks.patchObject,
        commitTransaction: mocks.commitTransaction,
      },
    },
    authoringHistory: {
      getGeneration: () => 1,
      record: mocks.historyRecord,
    },
    commands: {
      execute: vi.fn(),
      getSessionScopeKey: () => "session=s1&epoch=e1&request_scope_epoch=r1",
    },
    layout: {
      get: () => ({ activeViewportMainModuleId: "viewport-3d" }),
      setPanelVisible: vi.fn(),
    },
    resources: {
      invalidate: mocks.invalidate,
      invalidatePrefix: mocks.invalidatePrefix,
    },
    selection: {
      get: () => null,
      set: vi.fn(),
    },
  }),
}));

vi.mock("@/kernel/resources/useSessionScopedResourceKey", () => ({
  useSessionScopedResourceKey: (unscopedKey: string) => ({
    resourceKey: `session=s1&epoch=e1&request_scope_epoch=r1|${unscopedKey}`,
    sessionIdentity: mocks.sessionIdentity,
  }),
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
  publishCommittedSceneResource: mocks.publishCommittedSceneResource,
  resolveMaterialResourceKey: (materialId: string) =>
    MODEL_MATERIAL_PATH.replace("{material_id}", encodeURIComponent(materialId)),
  resolveObjectInteractionResourceKey: (objectId: string, kind: string) =>
    MODEL_OBJECT_INTERACTION_PATH.replace("{object_id}", encodeURIComponent(objectId)).replace(
      "{interaction_kind}",
      kind,
    ),
  useSceneResource: () => ({
    data: mocks.sceneData,
    status: "ready",
    error: null,
    refetch: mocks.sceneRefetch,
  }),
  useMaterialResource: () => ({
    data: null,
    status: "idle",
    error: null,
    refetch: mocks.materialRefetch,
  }),
  useObjectInteractionResource: () => ({
    data: null,
    status: "idle",
    error: null,
    refetch: mocks.uniaxialRefetch,
  }),
}));

vi.mock("@/kernel/layout/MaterialLibraryDialog", () => ({
  MaterialLibraryDialog: (props: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onUseMaterial?: (selection: MaterialCatalogSelection) => Promise<void>;
    modelMaterial?: SceneMaterialResource;
  }) => {
    mocks.lastDialogProps = props;
    return props.open ? <div data-slot="mock-material-library-dialog" /> : null;
  },
}));

import {
  buildUniaxialInteractionPayload,
  classifyUniaxialAnisotropyRegime,
  computeAnisotropyFieldTesla,
  computeExchangeLengthMeters,
  ObjectMaterialInspectorPanel,
  orthogonalizeAxisGramSchmidt,
  REFERENCE_MATERIALS_CATALOG,
  resolveMaterialPropertiesFromDraft,
  validateBornCubicStability,
} from "./ObjectMaterialSpec";
import { ELECTRON_GAMMA_PER_G } from "../model-roots/SpecInspectorHost";

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

function editTextOrNumberInput(input: TestElement, nextText: string): void {
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
  input.dispatchEvent(new TestEvent("change", { bubbles: true }));
  input.dispatchEvent(new TestEvent("focusout", { bubbles: true }));
}

function makeSelection(objectId = "disk-a"): Selection {
  return {
    kind: "object.material",
    label: "Material",
    moduleSource: "explorer",
    nodeId: `model:object:${objectId}:material`,
    objectId,
    ref: null,
  };
}

function assertNoTemplateInvalidationKeys(): void {
  for (const [resourceKey] of mocks.invalidate.mock.calls as [string, unknown][]) {
    expect(resourceKey).not.toBe(MODEL_MATERIAL_PATH);
    expect(resourceKey).not.toBe(MODEL_OBJECT_INTERACTION_PATH);
    expect(resourceKey).not.toContain("{material_id}");
    expect(resourceKey).not.toContain("{object_id}");
    expect(resourceKey).not.toContain("{interaction_kind}");
  }
}

describe("ObjectMaterialSpec (Wave 4 Feature-Parity & Constitutive Authoring)", () => {
  let mounted: ReturnType<typeof mountWave4TestElement> | null = null;

  beforeEach(() => {
    mocks.sceneData = defaultSceneFixture();
    mocks.lastDialogProps = null;
    mocks.sceneLoad.mockImplementation(async () => mocks.sceneData);
    mocks.createMaterial.mockImplementation(async (matId: string, name: string, properties) => ({
      committed_scene: {
        ...mocks.sceneData,
        revision: 22,
        materials: [...(mocks.sceneData.materials ?? []), { id: matId, name, properties }],
      },
      scene_revision: 22,
    }));
    mocks.patchMaterialAsset.mockResolvedValue({
      committed_scene: { ...defaultSceneFixture(), revision: 22 },
      scene_revision: 22,
    });
    mocks.commitTransaction.mockResolvedValue({
      committed_scene: { ...defaultSceneFixture(), revision: 23 },
      scene_revision: 23,
    });
    mocks.patchObjectInteraction.mockResolvedValue({ scene_revision: 24 });
    mocks.patchObject.mockResolvedValue({ ...defaultSceneFixture(), revision: 22 });
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    vi.clearAllMocks();
  });

  it("ships 9+ curated reference materials and preserves Ku2, Bk, and nullable vs zero DMI helpers", () => {
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

    // Bk = 2 * Ku1 / Ms: for Ku1 = 4.5e5 J/m^3, Ms = 1.5e6 A/m -> 0.6 T
    expect(computeAnisotropyFieldTesla(1.5e6, 4.5e5)).toBeCloseTo(0.6, 6);
    expect(computeAnisotropyFieldTesla(null, 4.5e5)).toBeNull();
    expect(computeAnisotropyFieldTesla(0, 4.5e5)).toBeNull();

    // Explicit 0 DMI must stay 0 when dindSet/dbulkSet is true, and null when unset
    expect(
      resolveMaterialPropertiesFromDraft({
        msSet: false,
        ms: 8e5,
        aexSet: false,
        aex: 13e-12,
        alpha: 0.01,
        dindSet: true,
        dind: 0,
        dbulkSet: true,
        dbulk: 0,
      }),
    ).toEqual({
      Ms: null,
      Aex: null,
      alpha: 0.01,
      Dind: 0,
      Dbulk: 0,
    });

    // Cosine convention E(θ) = -Ku1 cos²θ - Ku2 cos⁴θ (docs/physics/fem_anisotropy_uniaxial.md):
    // Case 1: Ku1 = -2e5, Ku2 = +1.5e5 => Ku2 > 0, Ku1 + Ku2 = -0.5e5 < 0 => Easy plane (NOT easy cone!)
    const easyPlaneRegime = classifyUniaxialAnisotropyRegime(-2.0e5, 1.5e5);
    expect(easyPlaneRegime.label).toBe("Easy plane");
    expect(easyPlaneRegime.coneAngleDeg).toBeNull();

    // Case 2: Ku1 = +1e5, Ku2 = -1.5e5 => Ku2 < 0, c² = -Ku1/(2 Ku2) = 1/3 => Easy cone 54.7°!
    const easyConeRegime = classifyUniaxialAnisotropyRegime(1.0e5, -1.5e5);
    expect(easyConeRegime.label).toContain("Easy cone");
    expect(easyConeRegime.label).toContain("54.7°");
    expect(easyConeRegime.coneAngleDeg).toBeCloseTo(54.7356, 2);

    // Case 3: Easy axis and isotropic
    expect(classifyUniaxialAnisotropyRegime(4.5e5, 1.5e5)).toEqual({
      label: "Easy axis",
      coneAngleDeg: null,
    });
    expect(classifyUniaxialAnisotropyRegime(0, 0).label).toContain("Isotropic");

    const lex = computeExchangeLengthMeters(8.0e5, 13e-12);
    expect((lex ?? 0) * 1e9).toBeCloseTo(5.6858, 2);

    const ortho = orthogonalizeAxisGramSchmidt([1, 0, 0], [0.5, 0.5, 0]);
    expect(ortho[0]).toBeCloseTo(0, 6);
    expect(ortho[1]).toBeCloseTo(1, 6);
    expect(validateBornCubicStability(210e9, 250e9, 80e9)).toMatch(/C11 - C12 > 0/);
    expect(validateBornCubicStability(210e9, 130e9, 80e9)).toBeNull();
  });

  it("renders Ku2, Bk readout, shared-material warning, and commits Cobalt preset with Ku2 & constitutive properties via Apply", async () => {
    mounted = mountWave4TestElement(
      <ObjectMaterialInspectorPanel selection={makeSelection("disk-a")} />,
    );

    expect(mounted.host.textContent).toContain("First-order uniaxial constant");
    expect(mounted.host.textContent).toContain("Second-order uniaxial constant");
    expect(mounted.host.textContent).toContain("Anisotropy field (Bk = 2\u00b7Ku1/Ms)");
    // Bk = 2 * (-2.0e5) / 1.42e6 = -0.2817 T (-281.7 mT)
    expect(mounted.host.textContent).toContain("-281.7 mT");
    // Cosine convention: Ku1 = -2e5, Ku2 = +1.5e5 => Easy plane (NOT easy cone)
    expect(mounted.host.textContent).toContain("Easy plane");
    expect(mounted.host.textContent).toContain("Shared across 2 objects");
    expect(findElements(mounted.host, (el) => el.tagName === "SELECT")).toHaveLength(0);

    const assignFromLibraryBtn = findElement(
      mounted.host,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Assign from Library")),
    );
    act(() => {
      assignFromLibraryBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });

    const cobaltBtn = findElement(
      mounted.host,
      (el) => el.getAttribute("data-preset-id") === "preset-cobalt",
    );
    act(() => {
      cobaltBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    // Reference material shadcn Dialog must auto-close after selecting a preset
    expect(
      findElements(
        mounted.host,
        (el) => el.getAttribute("data-slot") === "reference-materials-popover",
      ),
    ).toHaveLength(0);

    const applyBtn = findElement(
      mounted.host,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Apply")),
    );
    await act(async () => {
      applyBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });

    expect(mocks.createMaterial).toHaveBeenCalledTimes(1);
    expect(mocks.commitTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "merge_patch",
        merge_patch: expect.objectContaining({
          study: expect.objectContaining({
            solver: { gamma: String(2.18 * ELECTRON_GAMMA_PER_G) },
          }),
        }),
      }),
      { sessionScopeKey: "session=s1&epoch=e1&request_scope_epoch=r1" },
    );
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
      { sessionScopeKey: "session=s1&epoch=e1&request_scope_epoch=r1" },
    );
    expect(mocks.historyRecord).toHaveBeenCalledTimes(1);
    assertNoTemplateInvalidationKeys();
  });

  it("edits Ms + Ku1 on an already-assigned material and commits scoped patchMaterialAsset while preserving Ku2 = 150 kJ/m³", async () => {
    mocks.patchObjectInteraction.mockResolvedValueOnce({ scene_revision: 23 });
    mounted = mountWave4TestElement(
      <ObjectMaterialInspectorPanel selection={makeSelection("disk-a")} />,
    );

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
      editTextOrNumberInput(msInput, "1500");
      editTextOrNumberInput(ku1Input, "-250");
    });

    const applyBtn = findElement(
      mounted.host,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Apply")),
    );
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
      { baseRevision: 21, sessionScopeKey: "session=s1&epoch=e1&request_scope_epoch=r1" },
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
      { sessionScopeKey: "session=s1&epoch=e1&request_scope_epoch=r1" },
    );
    expect(mocks.invalidate).toHaveBeenCalledWith(
      "/v2/sessions/current/model/materials/shared-co",
      23,
    );
    expect(mocks.invalidate).toHaveBeenCalledWith(
      "/v2/sessions/current/model/objects/disk-a/interactions/uniaxial_anisotropy",
      23,
    );
    expect(mocks.invalidate).toHaveBeenCalledWith(MODEL_SCENE_PATH, 23);
    assertNoTemplateInvalidationKeys();
  });

  it("persists all 10 extended controls (gamma, landeG, Sync γ, sigma, density, magnetoelasticEnabled, b1, b2, c11, c12, c44) and hydrates them back", async () => {
    mounted = mountWave4TestElement(
      <ObjectMaterialInspectorPanel selection={makeSelection("disk-a")} />,
    );

    // Open Section 5 ("Electrical, mechanical & magnetoelastic") if collapsed
    const transportTrigger = findElement(
      mounted.host,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Electrical, mechanical & magnetoelastic")),
    );
    if (transportTrigger?.getAttribute("aria-expanded") === "false") {
      act(() => {
        transportTrigger.dispatchEvent(new TestEvent("click", { bubbles: true }));
      });
    }

    // 1. Edit landeG to 2.25 and click "Sync γ from Landé g"
    const landeRow = findElement(
      mounted.host,
      (el) => el.getAttribute("data-row") === "landeG",
      "landeG row",
    );
    const landeInput = findElement(
      landeRow,
      (el) => el.tagName === "INPUT",
      "landeG input",
    );
    act(() => {
      editTextOrNumberInput(landeInput, "2.25");
    });

    const syncGammaBtn = findElement(
      mounted.host,
      (el) =>
        el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Sync \u03b3 from Land\u00e9 g")),
      "Sync gamma button",
    );
    act(() => {
      syncGammaBtn.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });

    // 2. Edit sigma (MS/m -> 9.5e6 S/m) and density (kg/m^3 -> 8920)
    const sigmaInput = findElement(
      findElement(mounted.host, (el) => el.getAttribute("data-row") === "sigma", "sigma row"),
      (el) => el.tagName === "INPUT",
      "sigma input",
    );
    const densityInput = findElement(
      findElement(mounted.host, (el) => el.getAttribute("data-row") === "density", "density row"),
      (el) => el.tagName === "INPUT",
      "density input",
    );
    act(() => {
      editTextOrNumberInput(sigmaInput, "9.5");
      editTextOrNumberInput(densityInput, "8920");
    });

    // 3. Toggle magnetoelasticEnabled ON and edit b1, b2, c11, c12, c44
    const meSwitch = findElement(
      findElement(
        mounted.host,
        (el) => el.getAttribute("data-row") === "magnetoelasticEnabled",
        "magnetoelasticEnabled row",
      ),
      (el) => el.getAttribute("role") === "switch",
      "magnetoelastic switch",
    );
    act(() => {
      meSwitch.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });

    const editQtyRow = (rowKey: string, text: string) => {
      const row = findElement(
        mounted!.host,
        (el) => el.getAttribute("data-row") === rowKey,
        `${rowKey} row`,
      );
      const inp = findElement(row, (el) => el.tagName === "INPUT", `${rowKey} input`);
      editTextOrNumberInput(inp, text);
    };

    act(() => {
      editQtyRow("b1", "-15");
      editQtyRow("b2", "-6.5");
      editQtyRow("c11", "240");
      editQtyRow("c12", "140");
      editQtyRow("c44", "95");
    });

    const applyBtn = findElement(
      mounted.host,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Apply")),
    );
    await act(async () => {
      applyBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });

    const expectedGamma = 2.25 * ELECTRON_GAMMA_PER_G;
    expect(mocks.commitTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.commitTransaction).toHaveBeenCalledWith(
      {
        base_revision: 21,
        kind: "merge_patch",
        merge_patch: {
          study: {
            solver: { gamma: String(expectedGamma) },
            visualization_hint: {
              material_constitutive: {
                "shared-co": {
                  gamma: expectedGamma,
                  lande_g: 2.25,
                  conductivity: 9.5e6,
                  density: 8920,
                  magnetoelastic: {
                    enabled: true,
                    b1: -15e6,
                    b2: -6.5e6,
                    c11: 240e9,
                    c12: 140e9,
                    c44: 95e9,
                  },
                },
              },
            },
          },
        },
      },
      { sessionScopeKey: "session=s1&epoch=e1&request_scope_epoch=r1" },
    );

    // Verify round-trip hydration from committed scene
    mounted.unmount();
    mocks.sceneData = {
      ...defaultSceneFixture(),
      revision: 23,
      study: {
        solver: { gamma: String(expectedGamma) },
        visualization_hint: {
          material_constitutive: {
            "shared-co": {
              gamma: expectedGamma,
              lande_g: 2.25,
              conductivity: 9.5e6,
              density: 8920,
              magnetoelastic: {
                enabled: true,
                b1: -15e6,
                b2: -6.5e6,
                c11: 240e9,
                c12: 140e9,
                c44: 95e9,
              },
            },
          },
        },
      },
    };
    mounted = mountWave4TestElement(
      <ObjectMaterialInspectorPanel selection={makeSelection("disk-a")} />,
    );
    expect(mounted.host.textContent).toContain("\u03c3 = 9.50 MS/m \u00b7 \u03c1 = 8920 kg/m\u00b3");
  });

  it("wires MaterialLibraryDialog with modelMaterial and onUseMaterial (with provenance, history, and invalidation)", async () => {
    mounted = mountWave4TestElement(
      <ObjectMaterialInspectorPanel selection={makeSelection("disk-a")} />,
    );

    expect(mocks.lastDialogProps).not.toBeNull();
    expect(mocks.lastDialogProps?.modelMaterial).toEqual(
      expect.objectContaining({
        id: "shared-co",
        name: "Cobalt Film",
      }),
    );
    expect(typeof mocks.lastDialogProps?.onUseMaterial).toBe("function");

    const catalogEntry: MaterialLibraryEntryResource = {
      id: "builtin:permalloy",
      revision: 4,
      name: "Permalloy Ni80Fe20",
      kind: "builtin",
      summary: "Seed Permalloy",
      properties: { Ms: 8e5, Aex: 1.3e-11, alpha: 0.008, Dind: 0, Dbulk: null },
      references: [
        {
          label: "Py reference",
          url: "https://doi.org/10.1063/1.3072096",
          citation: null,
        },
      ],
      source: null,
    };

    await act(async () => {
      await mocks.lastDialogProps?.onUseMaterial?.(catalogEntry);
    });

    expect(mocks.createMaterial).toHaveBeenCalledTimes(1);
    const [createdId, createdName, createdProps, createdRefs, writeOpts, assetMeta] =
      mocks.createMaterial.mock.calls[0] as [
        string,
        string,
        unknown,
        unknown,
        unknown,
        unknown,
      ];
    expect(createdId).toMatch(/^mat:/);
    expect(createdName).toBe("Permalloy Ni80Fe20");
    expect(createdProps).toEqual({
      Ms: 8e5,
      Aex: 1.3e-11,
      alpha: 0.008,
      Dind: 0,
      Dbulk: null,
    });
    expect(createdRefs).toEqual([
      {
        label: "Py reference",
        url: "https://doi.org/10.1063/1.3072096",
        citation: null,
      },
    ]);
    expect(writeOpts).toEqual({ baseRevision: 21, sessionScopeKey: "session=s1&epoch=e1&request_scope_epoch=r1" });
    expect(assetMeta).toEqual({
      assignToObjectId: "disk-a",
      source: expect.objectContaining({
        catalog_id: "builtin:permalloy",
        catalog_revision: 4,
        kind: "builtin",
        name: "Permalloy Ni80Fe20",
      }),
    });
    expect(mocks.historyRecord).toHaveBeenCalledTimes(1);
    expect(mocks.invalidate).toHaveBeenCalledWith(
      `/v2/sessions/current/model/materials/${encodeURIComponent(createdId)}`,
      22,
    );
    assertNoTemplateInvalidationKeys();
  });

  it("unassigns material via patchObject(material_ref: null) when Unassigned is selected on an assigned object", async () => {
    mounted = mountWave4TestElement(
      <ObjectMaterialInspectorPanel selection={makeSelection("disk-a")} />,
    );

    const unassignedItem = findElement(
      mounted.host,
      (el) =>
        el.getAttribute("data-select-item-value") !== null &&
        Boolean(el.textContent?.trim() === "Unassigned"),
      "Unassigned select item",
    );
    act(() => {
      unassignedItem.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });

    const applyBtn = findElement(
      mounted.host,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Apply")),
    );
    await act(async () => {
      applyBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });

    expect(mocks.createMaterial).not.toHaveBeenCalled();
    expect(mocks.patchMaterialAsset).not.toHaveBeenCalled();
    expect(mocks.patchObject).toHaveBeenCalledTimes(1);
    expect(mocks.patchObject).toHaveBeenCalledWith(
      "disk-a",
      { base_revision: 21, material_ref: null },
      { sessionScopeKey: "session=s1&epoch=e1&request_scope_epoch=r1" },
    );
    expect(mocks.historyRecord).toHaveBeenCalledTimes(1);
    assertNoTemplateInvalidationKeys();
  });

  it("preserves source & references provenance on Duplicate & Unlink and renders Material Source + Changes from Source readouts", async () => {
    mounted = mountWave4TestElement(
      <ObjectMaterialInspectorPanel selection={makeSelection("disk-a")} />,
    );

    // Source has Ms = 1.4e6, while model material has Ms = 1.42e6 -> Modified in model!
    expect(mounted.host.textContent).toContain("Material Source");
    expect(mounted.host.textContent).toContain("Modified in model");
    expect(mounted.host.textContent).toContain("Cobalt \u00b7 revision 3");
    expect(mounted.host.textContent).toContain("Built-in");
    expect(mounted.host.textContent).toContain("Ms: 1400000 \u2192 1420000 A/m");
    expect(mounted.host.textContent).toContain("J. Appl. Phys. 32, 344S (1961)");

    const dupBtn = findElement(
      mounted.host,
      (el) =>
        el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Duplicate to unlink")),
      "Duplicate to unlink button",
    );
    await act(async () => {
      dupBtn.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });

    expect(mocks.createMaterial).toHaveBeenCalledTimes(1);
    const [, clonedName, , clonedRefs, clonedOpts, clonedMeta] =
      mocks.createMaterial.mock.calls[0] as [
        string,
        string,
        unknown,
        unknown,
        unknown,
        unknown,
      ];
    expect(clonedName).toBe("Cobalt Film copy");
    expect(clonedRefs).toEqual([
      {
        label: "Co reference",
        url: "https://doi.org/10.1063/1.1724669",
        citation: "J. Appl. Phys. 32, 344S (1961)",
      },
    ]);
    expect(clonedOpts).toEqual({ baseRevision: 21, sessionScopeKey: "session=s1&epoch=e1&request_scope_epoch=r1" });
    expect(clonedMeta).toEqual({
      assignToObjectId: "disk-a",
      source: expect.objectContaining({
        catalog_id: "builtin:cobalt",
        catalog_revision: 3,
        kind: "builtin",
      }),
    });
    expect(mocks.historyRecord).toHaveBeenCalledTimes(1);
    assertNoTemplateInvalidationKeys();
  });

  it("supports custom New material ID on unassigned objects and preserves explicit 0 DMI vs unset null", async () => {
    mocks.sceneData = {
      revision: 30,
      materials: [],
      objects: [
        {
          id: "wire-1",
          name: "Spin Wire",
          role: "magnet",
          material_ref: "",
        },
      ],
    };
    mocks.createMaterial.mockResolvedValueOnce({
      committed_scene: { ...mocks.sceneData, revision: 31 },
      scene_revision: 31,
    });

    mounted = mountWave4TestElement(
      <ObjectMaterialInspectorPanel selection={makeSelection("wire-1")} />,
    );

    // Custom New material ID input is rendered and editable
    const newIdRow = findElement(
      mounted.host,
      (el) => el.getAttribute("data-row") === "newMaterialId",
      "New material ID row",
    );
    const newIdInput = findElement(
      newIdRow,
      (el) => el.tagName === "INPUT",
      "New material ID input",
    );
    expect(newIdInput.value).toBe("mat:spin-wire");

    // Open Section 4 ("Cubic anisotropy & chiral DMI") and toggle dindSet ON (keeping dind = 0!)
    const dmiTrigger = findElement(
      mounted.host,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Cubic anisotropy & chiral DMI")),
    );
    if (dmiTrigger?.getAttribute("aria-expanded") === "false") {
      act(() => {
        dmiTrigger.dispatchEvent(new TestEvent("click", { bubbles: true }));
      });
    }

    const dindSetSwitch = findElement(
      findElement(
        mounted.host,
        (el) => el.getAttribute("data-row") === "dindSet",
        "dindSet row",
      ),
      (el) => el.getAttribute("role") === "switch",
      "dindSet switch",
    );

    act(() => {
      editTextOrNumberInput(newIdInput, "mat:custom-wire-yig");
      dindSetSwitch.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });

    const applyBtn = findElement(
      mounted.host,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Apply")),
    );
    await act(async () => {
      applyBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });

    expect(mocks.createMaterial).toHaveBeenCalledTimes(1);
    expect(mocks.createMaterial).toHaveBeenCalledWith(
      "mat:custom-wire-yig",
      expect.any(String),
      expect.objectContaining({
        Ms: 8e5,
        Aex: 13e-12,
        Dind: 0, // Explicit 0 DMI preserved as numeric 0!
        Dbulk: null, // Unset DMI remains null!
      }),
      [],
      { baseRevision: 30, sessionScopeKey: "session=s1&epoch=e1&request_scope_epoch=r1" },
      { assignToObjectId: "wire-1" },
    );
  });

  it("surfaces HTTP 409 revision conflict notice and Refresh & Rebase action cleanly", async () => {
    mocks.patchMaterialAsset.mockRejectedValueOnce(
      new ControlRoomApiError("scene revision mismatch: base=21, current=25", {
        code: "revision_conflict",
        status: 409,
      }),
    );

    mounted = mountWave4TestElement(
      <ObjectMaterialInspectorPanel selection={makeSelection("disk-a")} />,
    );

    const alphaInput = findElement(
      findElement(mounted.host, (el) => el.getAttribute("data-row") === "alpha", "alpha row"),
      (el) => el.tagName === "INPUT",
      "alpha input",
    );
    act(() => {
      editTextOrNumberInput(alphaInput, "0.02");
    });

    const applyBtn = findElement(
      mounted.host,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Apply")),
    );
    await act(async () => {
      applyBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });

    expect(mounted.host.textContent).toContain("Scene revision conflict (HTTP 409)");
    expect(mocks.sceneRefetch).toHaveBeenCalled();

    const rebaseBtn = findElement(
      mounted.host,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Refresh & Rebase")),
      "Refresh & Rebase button",
    );
    act(() => {
      rebaseBtn.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(mounted.host.textContent).not.toContain("Scene revision conflict (HTTP 409)");
  });

  it("recovers cleanly via Retry Assignment when MaterialAssignmentAfterCreateError occurs after createMaterial", async () => {
    mocks.sceneData = {
      revision: 40,
      materials: [],
      objects: [
        {
          id: "cu-line-1",
          name: "Copper Strip",
          role: "conductor",
          material_ref: "",
        },
      ],
    };

    const createdScene = {
      revision: 41,
      materials: [
        {
          id: "mat:copper-strip",
          name: "Copper Strip Material",
          properties: { Ms: null, Aex: null, alpha: 0.008, Dind: null, Dbulk: null },
        },
      ],
      objects: mocks.sceneData.objects,
    };

    mocks.createMaterial.mockResolvedValueOnce({
      committed_scene: createdScene,
      scene_revision: 41,
    });
    mocks.patchObject
      .mockRejectedValueOnce(
        new ControlRoomApiError("scene revision conflict during assignment", {
          code: "revision_conflict",
          status: 409,
        }),
      )
      .mockResolvedValueOnce({
        ...createdScene,
        revision: 42,
        objects: [
          {
            id: "cu-line-1",
            name: "Copper Strip",
            role: "conductor",
            material_ref: "mat:copper-strip",
          },
        ],
      });

    mounted = mountWave4TestElement(
      <ObjectMaterialInspectorPanel selection={makeSelection("cu-line-1")} />,
    );

    const newIdInput = findElement(
      findElement(
        mounted.host,
        (el) => el.getAttribute("data-row") === "newMaterialId",
        "New material ID row",
      ),
      (el) => el.tagName === "INPUT",
      "New material ID input",
    );
    act(() => {
      editTextOrNumberInput(newIdInput, "mat:copper-strip");
    });

    const applyBtn = findElement(
      mounted.host,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Apply")),
    );
    await act(async () => {
      applyBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });

    // Partial failure surfaced with Retry Assignment quick-fix
    expect(mocks.createMaterial).toHaveBeenCalledTimes(1);
    expect(mocks.patchObject).toHaveBeenCalledTimes(1);
    expect(mounted.host.textContent).toContain("Retry Assignment");

    // Advance scene revision and click Retry Assignment -> assigns mat:copper-strip without crashing on .trim()!
    mocks.sceneData = createdScene;
    const retryBtn = findElement(
      mounted.host,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Retry Assignment")),
      "Retry Assignment button",
    );
    await act(async () => {
      retryBtn.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });

    expect(mocks.patchObject).toHaveBeenCalledTimes(2);
    expect(mocks.patchObject).toHaveBeenLastCalledWith(
      "cu-line-1",
      { base_revision: 41, material_ref: "mat:copper-strip" },
      { sessionScopeKey: "session=s1&epoch=e1&request_scope_epoch=r1" },
    );
    expect(mounted.host.textContent).not.toContain("Retry Assignment");
    assertNoTemplateInvalidationKeys();
  });

  it("renders Easy cone 54.7° for Ku1 = +1e5, Ku2 = -1.5e5 and enforces explicit opt-in physics activation without empty catch", async () => {
    mocks.sceneData = {
      ...defaultSceneFixture(),
      study: { demag_enabled: false, exchange_enabled: false },
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
              params: { ku1: 1.0e5, ku2: -1.5e5, axis: [0, 0, 1] },
            },
          ],
        },
      ],
    };

    mounted = mountWave4TestElement(
      <ObjectMaterialInspectorPanel selection={makeSelection("disk-a")} />,
    );

    // Cosine convention Easy cone 54.7° displayed in UI
    expect(mounted.host.textContent).toContain("Easy cone (\u03b8 = 54.7\u00b0)");
    // Explicit opt-in switch defaults OFF and lists pending physics modules
    const optInRow = findElement(
      mounted.host,
      (el) => el.getAttribute("data-row") === "activateRequiredPhysics",
      "activateRequiredPhysics row",
    );
    const optInSwitch = findElement(
      optInRow,
      (el) => el.getAttribute("role") === "switch",
      "activateRequiredPhysics switch",
    );
    expect(optInSwitch.getAttribute("aria-checked")).toBe("false");
    expect(mounted.host.textContent).toContain(
      "Also enable required physics modules on Apply",
    );
    expect(mounted.host.textContent).toContain("Exchange");
    expect(mounted.host.textContent).toContain("Demag");

    // 1. With opt-in OFF (default), editing alpha and clicking Apply must NOT activate exchange or study demag
    const alphaInput = findElement(
      findElement(
        mounted.host,
        (el) => el.getAttribute("data-row") === "alpha",
        "alpha row",
      ),
      (el) => el.tagName === "INPUT",
      "alpha input",
    );
    act(() => {
      editTextOrNumberInput(alphaInput, "0.015");
    });
    const applyBtn = findElement(
      mounted.host,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Apply")),
    );
    await act(async () => {
      applyBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(mocks.patchObjectInteraction).not.toHaveBeenCalled();
    expect(mocks.commitTransaction).not.toHaveBeenCalled();

    // 2. Toggle explicit opt-in ON and simulate an exchange activation error -> surfaced clearly, never swallowed!
    mocks.patchObjectInteraction.mockRejectedValueOnce(
      new Error("Exchange interaction rejected by active lane"),
    );
    act(() => {
      optInSwitch.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(optInSwitch.getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      applyBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });

    expect(mocks.patchObjectInteraction).toHaveBeenCalledWith(
      "disk-a",
      "exchange",
      expect.objectContaining({ enabled: true, present: true }),
      { sessionScopeKey: "session=s1&epoch=e1&request_scope_epoch=r1" },
    );
    expect(mocks.commitTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "merge_patch",
        merge_patch: {
          study: {
            demag_enabled: true,
            exchange_enabled: true,
          },
        },
      }),
      { sessionScopeKey: "session=s1&epoch=e1&request_scope_epoch=r1" },
    );
    expect(mounted.host.textContent).toContain(
      "Material saved, but physics module activation failed",
    );
    expect(mounted.host.textContent).toContain(
      "Exchange: Exchange interaction rejected by active lane",
    );
  });
}, 25_000);
