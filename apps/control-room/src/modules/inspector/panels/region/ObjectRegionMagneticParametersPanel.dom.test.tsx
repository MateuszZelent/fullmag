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

vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
  useSceneResource: () => ({ data: mocks.sceneData, status: "ready" }),
}));

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

  it("sends the material-field write with the scoped canonical revision", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<ObjectRegionMagneticParametersPanel {...panelProps()} />));
      await act(async () => findButton(container, "Apply Fields").click());

      expect(mocks.readScene).toHaveBeenCalledWith({ sessionScopeKey: sessionAScopeKey });
      expect(mocks.patchMaterialFields).toHaveBeenCalledWith(
        "object-a",
        [],
        { baseRevision: 10, sessionScopeKey: sessionAScopeKey },
      );
      expect(mocks.recordHistory).toHaveBeenCalledOnce();
      expect(mocks.publishScene).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ scene_revision: 11 }),
        11,
        undefined,
        sessionAScopeKey,
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
      await act(async () => {
        findButton(container, "Apply Fields").click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mocks.patchMaterialFields).toHaveBeenCalledWith(
        "object-a",
        [],
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
      await act(async () => findButton(container, "Apply Fields").click());

      expect(mocks.readScene).not.toHaveBeenCalled();
      expect(mocks.patchMaterialFields).not.toHaveBeenCalled();
      expect(container.textContent).toContain("Session identity is not ready");
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
