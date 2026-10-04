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
  invalidate: vi.fn(),
  recordHistory: vi.fn(),
  readScene: vi.fn(),
  commitTransaction: vi.fn(),
  syncAuthoringScript: vi.fn(),
  sessionIdentity: null as unknown,
  sceneData: { objects: [], materials: [] },
}));

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => ({
    api: {
      model: {
        commitTransaction: mocks.commitTransaction,
        scene: mocks.readScene,
        syncAuthoringScript: mocks.syncAuthoringScript,
      },
    },
    authoringHistory: {
      getGeneration: () => mocks.historyGeneration,
      record: mocks.recordHistory,
    },
    commands: {
      execute: vi.fn(),
      getSessionScopeKey: () => mocks.currentSessionScopeKey,
    },
    resources: {},
  }),
}));

vi.mock("@/kernel/resources/useSessionStatus", () => ({
  useSessionResourceIdentity: () => mocks.sessionIdentity,
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
  useSceneResource: () => ({ data: mocks.sceneData, status: "ready" }),
  useModelRegionsResource: () => ({ data: { items: [] }, status: "ready" }),
}));

vi.mock("@/kernel/authoring/authoringMutationInvalidation", () => ({
  acknowledgedAuthoringSceneRevision: (response: { scene_revision: number }) =>
    response.scene_revision,
  invalidateAuthoringMutationDependents: mocks.invalidate,
}));

vi.mock("@/kernel/resources/useActiveLaneCapabilities", () => ({
  resolveActiveLaneOperation: () => ({ enabled: true }),
  useActiveLaneCapabilities: () => ({}),
}));

vi.mock("../ObjectMagneticTexturePanelModel", () => ({
  buildMagnetizationTransactionRequest: () => ({
    base_revision: 8,
    kind: "patch_magnetization",
  }),
  buildObjectMagneticTextureAssetDraft: () => ({ id: "texture-a" }),
  objectMagneticTextureDraftDirty: () => true,
  objectMagneticTextureDraftFromModel: () => ({
    magnetizationRef: "",
    presetKind: "uniform",
  }),
  objectMagneticTextureDraftIdentityKey: () => "identity-a",
  objectMagneticTextureDraftKey: () => "draft-a",
  resolveObjectMagneticTexturePanelModel: () => ({
    mode: "committed",
    objectId: "object-a",
    regionId: "region-a",
  }),
}));

vi.mock("../inspectorDraftState", () => ({
  initialInspectorDraftState: ({ baseDraft, baseKey, identityKey }: {
    baseDraft: unknown;
    baseKey: string;
    identityKey: string;
  }) => ({ baseDraft, baseKey, dirty: false, draft: baseDraft, identityKey }),
  resolveInspectorDraftState: ({ baseDraft, state }: {
    baseDraft: unknown;
    state: { draft: unknown };
  }) => ({ dirty: true, draft: state.draft ?? baseDraft }),
  updateInspectorDraftState: vi.fn(),
}));

vi.mock("./shared", () => ({ ObjectRegionMetadataSection: () => null }));

vi.mock("../ObjectMagneticTexturePanel", () => ({
  MagneticTextureActionsSection: ({
    feedback,
    onClear,
    onSave,
    pending,
  }: {
    feedback: { message: string } | null;
    onClear: () => void;
    onSave: () => void;
    pending: boolean;
  }) => (
    <div>
      <button disabled={pending} onClick={onSave} type="button">Save texture</button>
      <button disabled={pending} onClick={onClear} type="button">Clear texture</button>
      {feedback ? <div>{feedback.message}</div> : null}
    </div>
  ),
  MagneticTextureAssignmentSection: () => null,
  MagneticTexturePresetParametersSection: () => null,
  MagneticTextureRawAssetSection: () => null,
}));

import { ObjectRegionTexturePanel } from "./ObjectRegionTexturePanel";
import type { RegionSubPanelProps } from "./shared";

describe("ObjectRegionTexturePanel session fence", () => {
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
    mocks.commitTransaction.mockResolvedValue({
      committed_scene: { objects: [], revision: 11, scene_revision: 11 },
      scene_revision: 11,
    });
    mocks.syncAuthoringScript.mockResolvedValue({});
  });

  it("sends the texture commit and follow-up sync to the captured session", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<ObjectRegionTexturePanel {...panelProps()} />));
      await act(async () => findButton(container, "Save texture").click());

      expect(mocks.readScene).toHaveBeenCalledWith({ sessionScopeKey: sessionAScopeKey });
      expect(mocks.commitTransaction).toHaveBeenCalledWith(
        { base_revision: 10, kind: "patch_magnetization" },
        { baseRevision: 10, sessionScopeKey: sessionAScopeKey },
      );
      expect(mocks.recordHistory).toHaveBeenCalledOnce();
      expect(mocks.invalidate).toHaveBeenCalledOnce();
      expect(mocks.syncAuthoringScript).toHaveBeenCalledWith(
        {},
        { sessionScopeKey: sessionAScopeKey },
      );
      expect(container.textContent).toContain("Magnetic texture saved.");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("does not publish scene effects or sync after the session changes before ACK", async () => {
    let finishCommit: ((value: unknown) => void) | null = null;
    const commitResult = new Promise((resolve) => {
      finishCommit = resolve;
    });
    mocks.commitTransaction.mockReturnValue(commitResult);
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<ObjectRegionTexturePanel {...panelProps()} />));
      await act(async () => {
        findButton(container, "Save texture").click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mocks.commitTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ base_revision: 10 }),
        expect.objectContaining({ sessionScopeKey: sessionAScopeKey }),
      );
      mocks.currentSessionScopeKey = "session=B&epoch=2&request_scope_epoch=2";
      mocks.historyGeneration += 1;
      await act(async () => {
        finishCommit?.({
          committed_scene: { objects: [], revision: 11, scene_revision: 11 },
          scene_revision: 11,
        });
        await commitResult;
      });

      expect(mocks.recordHistory).not.toHaveBeenCalled();
      expect(mocks.invalidate).not.toHaveBeenCalled();
      expect(mocks.syncAuthoringScript).not.toHaveBeenCalled();
      expect(container.textContent).not.toContain("Magnetic texture saved.");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("fails closed when no session identity is available", async () => {
    mocks.currentSessionScopeKey = null;
    mocks.sessionIdentity = null;
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<ObjectRegionTexturePanel {...panelProps()} />));
      await act(async () => findButton(container, "Save texture").click());

      expect(mocks.readScene).not.toHaveBeenCalled();
      expect(mocks.commitTransaction).not.toHaveBeenCalled();
      expect(container.textContent).toContain("Session identity is not ready");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});

function panelProps(): RegionSubPanelProps {
  return {
    model: { objectId: "object-a", regionId: "region-a" },
    meshLane: "fdm" as const,
  } as unknown as RegionSubPanelProps;
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
