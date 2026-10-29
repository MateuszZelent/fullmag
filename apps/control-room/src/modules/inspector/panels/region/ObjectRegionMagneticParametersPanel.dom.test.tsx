import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  installSimulationPreparationTestDom,
  TestElement,
  TestNode,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

const sessionA = {
  sessionId: "A",
  sessionEpoch: "1",
  requestScopeEpoch: "1",
} as const;
const sessionAScopeKey = "session=A&epoch=1&request_scope_epoch=1";

const mocks = vi.hoisted(() => ({
  currentSessionScopeKey: "session=A&epoch=1&request_scope_epoch=1" as string | null,
  historyGeneration: 0,
  patchMaterialFields: vi.fn(),
  publishScene: vi.fn(),
  readScene: vi.fn(),
  recordHistory: vi.fn(),
  sessionIdentity: null as unknown,
  sceneData: { objects: [], materials: [] },
}));

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => ({
    api: {
      model: {
        patchObjectMaterialFields: mocks.patchMaterialFields,
        scene: mocks.readScene,
      },
    },
    authoringHistory: {
      getGeneration: () => mocks.historyGeneration,
      record: mocks.recordHistory,
    },
    commands: { getSessionScopeKey: () => mocks.currentSessionScopeKey },
    resources: {},
  }),
}));

vi.mock("@/kernel/resources/useSessionStatus", () => ({
  useSessionResourceIdentity: () => mocks.sessionIdentity,
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/kernel/resources/geometryLifecycleResources")
  >();
  return {
    ...actual,
    useSceneResource: () => ({ data: mocks.sceneData, status: "ready" }),
  };
});

vi.mock("../regionAuthoringInvalidation", () => ({
  publishRegionAuthoringScene: mocks.publishScene,
}));

vi.mock("../ObjectRegionsPanel", () => ({
  PhysicalScalarField: () => null,
}));

vi.mock("./shared", () => ({
  ObjectRegionActionsSection: () => null,
  ObjectRegionInlineDiagnostics: () => null,
  ObjectRegionMetadataSection: () => null,
}));

import { ObjectRegionMagneticParametersPanel } from "./ObjectRegionMagneticParametersPanel";
import type { RegionSubPanelProps } from "./shared";

describe("ObjectRegionMagneticParametersPanel session fence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentSessionScopeKey = sessionAScopeKey;
    mocks.historyGeneration = 0;
    mocks.sessionIdentity = sessionA;
    mocks.sceneData = { objects: [], materials: [] };
    mocks.readScene.mockResolvedValue({
      objects: [],
      revision: 10,
      scene_revision: 10,
    });
    mocks.patchMaterialFields.mockResolvedValue({
      committed_scene: { objects: [], revision: 11, scene_revision: 11 },
      scene_revision: 11,
    });
  });

  it.each([
    {
      description: "reads Ku1 from an enabled owner anisotropy entry",
      interactionPresent: true,
      enabled: true,
      ku1: 42_000,
      ownerFieldKu1: null,
      localOverride: null,
      expectedParent: "42000 J/m^3 (inherits parent)",
    },
    {
      description: "retains Ku1 when its owner anisotropy entry is disabled",
      interactionPresent: true,
      enabled: false,
      ku1: 31_000,
      ownerFieldKu1: null,
      localOverride: 8_000,
      expectedParent: "31000 J/m^3",
    },
    {
      description: "preserves an explicitly authored zero Ku1",
      interactionPresent: true,
      enabled: true,
      ku1: 0,
      ownerFieldKu1: null,
      localOverride: null,
      expectedParent: "0 J/m^3 (inherits parent)",
    },
    {
      description: "keeps an owner-level Ku1 field ahead of the stack scalar",
      interactionPresent: true,
      enabled: true,
      ku1: 42_000,
      ownerFieldKu1: 25_000,
      localOverride: null,
      expectedParent: "25000 J/m^3 (inherits parent)",
    },
    {
      description: "defaults Ku1 to zero when the owner has no anisotropy entry",
      interactionPresent: false,
      enabled: false,
      ku1: 0,
      ownerFieldKu1: null,
      localOverride: null,
      expectedParent: "0 J/m^3 (inherits parent)",
    },
  ])("$description", async ({
    interactionPresent,
    enabled,
    ku1,
    ownerFieldKu1,
    localOverride,
    expectedParent,
  }) => {
    mocks.sceneData = {
      objects: [{
        id: "object-a",
        physics_stack: interactionPresent ? [{
          enabled,
          kind: "uniaxial_anisotropy",
          params: { axis: [0, 0, 1], ku1 },
        }] : [],
      }],
      materials: [],
    } as unknown as typeof mocks.sceneData;

    const props = panelProps();
    if (ownerFieldKu1 !== null) {
      props.materialFields = {
        fields: [{
          assignment_id: "object-ku1",
          field: { kind: "constant", value: ownerFieldKu1 },
          owner_object_id: "object-a",
          parameter: "ku1",
          unit: "J/m^3",
        }],
        scene_revision: 9,
      } as unknown as RegionSubPanelProps["materialFields"];
    }
    if (localOverride !== null) {
      props.draft.materialOverrides = [{
        conflictPolicy: "error",
        parameter: "ku1",
        priority: 0,
        unit: "J/m^3",
        value: localOverride,
      }];
    }

    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<ObjectRegionMagneticParametersPanel {...props} />));
      expect(fieldRowValue(
        container,
        localOverride === null ? "ku1" : "Inherited parent",
      )).toBe(expectedParent);
      if (localOverride !== null) {
        expect(props.draft.materialOverrides[0]?.value).toBe(localOverride);
      }
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("keeps clean Apply Fields disabled without submitting a write", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<ObjectRegionMagneticParametersPanel {...panelProps()} />));
      expect(findButton(container, "Apply Fields").disabled).toBe(true);
      await act(async () => findButton(container, "Apply Fields").click());
      expect(mocks.readScene).not.toHaveBeenCalled();
      expect(mocks.patchMaterialFields).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("sends the material-field write with the scoped canonical revision", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<ObjectRegionMagneticParametersPanel {...panelProps()} />));
      await act(async () => findButton(container, "Add Field").click());
      expect(findButton(container, "Apply Fields").disabled).toBe(false);
      await act(async () => findButton(container, "Apply Fields").click());

      expect(mocks.readScene).toHaveBeenCalledWith({ sessionScopeKey: sessionAScopeKey });
      expect(mocks.patchMaterialFields).toHaveBeenCalledWith(
        "object-a",
        [expect.objectContaining({
          owner_object: "object-a",
          region_id: "region-a",
          parameter: "ms",
          value: expect.objectContaining({ kind: "linear", base: 800e3 }),
        })],
        { baseRevision: 10, sessionScopeKey: sessionAScopeKey },
      );
      expect(mocks.recordHistory).toHaveBeenCalledOnce();
      expect(mocks.publishScene).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ scene_revision: 11 }),
        11,
        undefined,
        sessionAScopeKey,
        undefined,
      );
      expect(container.textContent).toContain("Material fields updated.");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("does not publish history or scene effects when the session changes before ACK", async () => {
    let finishPatch: ((value: unknown) => void) | null = null;
    const patchResult = new Promise((resolve) => {
      finishPatch = resolve;
    });
    mocks.patchMaterialFields.mockReturnValue(patchResult);
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<ObjectRegionMagneticParametersPanel {...panelProps()} />));
      await act(async () => findButton(container, "Add Field").click());
      expect(findButton(container, "Apply Fields").disabled).toBe(false);
      await act(async () => {
        findButton(container, "Apply Fields").click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mocks.patchMaterialFields).toHaveBeenCalledWith(
        "object-a",
        [expect.objectContaining({
          owner_object: "object-a",
          region_id: "region-a",
          parameter: "ms",
          value: expect.objectContaining({ kind: "linear", base: 800e3 }),
        })],
        expect.objectContaining({ sessionScopeKey: sessionAScopeKey }),
      );
      mocks.currentSessionScopeKey = "session=B&epoch=2&request_scope_epoch=2";
      mocks.historyGeneration += 1;
      await act(async () => {
        finishPatch?.({
          committed_scene: { objects: [], revision: 11, scene_revision: 11 },
          scene_revision: 11,
        });
        await patchResult;
      });

      expect(mocks.recordHistory).not.toHaveBeenCalled();
      expect(mocks.publishScene).not.toHaveBeenCalled();
      expect(container.textContent).not.toContain("Material fields updated.");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("fails closed when the session identity is unavailable", async () => {
    mocks.sessionIdentity = null;
    mocks.currentSessionScopeKey = null;
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<ObjectRegionMagneticParametersPanel {...panelProps()} />));
      await act(async () => findButton(container, "Add Field").click());
      expect(findButton(container, "Apply Fields").disabled).toBe(false);
      await act(async () => findButton(container, "Apply Fields").click());

      expect(mocks.readScene).not.toHaveBeenCalled();
      expect(mocks.patchMaterialFields).not.toHaveBeenCalled();
      expect(container.textContent).toContain("Session identity is not ready");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
  it("shows a retained spatial override without editable scalar controls", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    const props = panelProps();
    props.draft.materialOverrides = [{
      parameter: "ms", value: 800e3, unit: "A/m", priority: 0, conflictPolicy: "error",
      preservedOverride: { parameter: "ms", value: { kind: "linear", base: 800e3, gradient: [1, 0, 0], frame: "object" } },
    }];
    try {
      await act(async () => root.render(<ObjectRegionMagneticParametersPanel {...props} />));
      expect(container.textContent).toContain("ms · linear");
      expect(container.textContent).toContain("preserved unchanged");
      expect(container.textContent).not.toContain("Local override");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});

function panelProps(): RegionSubPanelProps {
  return {
    model: {
      objectId: "object-a",
      regionId: "region-a",
      revision: 9,
      materialRef: "material-a",
      materialOverrideCount: 0,
      materialFieldCount: 0,
    } as RegionSubPanelProps["model"],
    draft: { materialOverrides: [] } as unknown as RegionSubPanelProps["draft"],
    pending: false,
    draftDirty: false,
    buildRegion: async () => undefined,
    regionMeshLifecycle: null,
    canWriteRegion: true,
    meshLane: "fdm",
    updateDraft: () => undefined,
    updateShape: () => undefined,
    updateShapeVector: () => undefined,
    updateMeshPolicy: () => undefined,
    updateMaterialOverride: () => undefined,
    addMaterialOverride: () => undefined,
    removeMaterialOverride: () => undefined,
    materialFields: null,
    couplingDependencies: [],
    applyRegion: async () => true,
    duplicateRegion: async () => undefined,
    deleteRegion: async () => undefined,
    revert: () => undefined,
    feedback: null,
  };
}

function findButton(root: TestNode, text: string): TestElement {
  const button = findElements(root, (element) =>
    element.tagName === "BUTTON" && element.textContent.includes(text),
  )[0];
  if (!button) throw new Error(`Missing button ${text}`);
  return button;
}

function fieldRowValue(root: TestElement, label: string): string {
  const row = root.querySelectorAll(".fm-inspector-field-row").find(
    (candidate) =>
      candidate.querySelector(".fm-inspector-field-row__label")?.textContent === label,
  );
  const value = row?.querySelector(".fm-inspector-field-row__value");
  if (!value) throw new Error(`Missing field row ${label}`);
  return value.textContent;
}

function findElements(
  root: TestNode,
  predicate: (element: TestElement) => boolean,
): TestElement[] {
  const found: TestElement[] = [];
  const visit = (node: TestNode): void => {
    if (node instanceof TestElement && predicate(node)) found.push(node);
    for (const child of node.childNodes) visit(child);
  };
  visit(root);
  return found;
}
