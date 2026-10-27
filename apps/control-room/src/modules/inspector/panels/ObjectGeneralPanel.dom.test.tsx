import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  installSimulationPreparationTestDom,
  TestElement,
  TestEvent,
  TestNode,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import {
  geometryObjectEditSessionTargetKey,
  resolveCommittedGeometryObjectDraft,
} from "@/kernel/authoring/object-edit/objectEditDraftModel";
import type { ObjectEditSessionController } from "@/kernel/authoring/object-edit/ObjectEditSessionController";
import type { GeometryObjectDraft } from "@/kernel/authoring/object-edit/objectEditTypes";
import {
  InspectorEditSessionProvider,
  inspectorActionState,
  useInspectorEditSession,
} from "../InspectorEditSession";
import type { Selection } from "@/kernel/selection/selectionTypes";

import { InspectorFooter } from "../InspectorFooter";
import { ObjectGeneralPanel } from "./ObjectGeneralPanel";
import { GeometryObjectPanel } from "./GeometryObjectPanel";

const mocks = vi.hoisted(() => ({
  commitTransaction: vi.fn(),
  getSessionScopeKey: vi.fn(() => "session=A&epoch=1" as string | null),
  historyGeneration: 0,
  invalidate: vi.fn(),
  objectEditSession: null as ObjectEditSessionController<GeometryObjectDraft> | null,
  patchObject: vi.fn(),
  publishCommittedScene: vi.fn(),
  readScene: vi.fn(),
  recordHistory: vi.fn(),
  sceneData: {
    objects: [{
      geometry: { geometry_kind: "Box", geometry_params: { size: [1e-7, 1e-7, 1e-8] } },
      id: "object-a",
      name: "Magnet",
      notes: "Original notes",
      transform: {
        pivot: [0, 0, 0],
        rotation_quat: [0, 0, 0, 1],
        scale: [1, 1, 1],
        translation: [0, 0, 0],
      },
    }],
    revision: 10,
    scene_revision: 10,
  } as unknown,
}));

vi.mock("@/kernel/KernelContext", async () => {
  const React = await import("react");
  const { ObjectEditSessionController } = await import(
    "@/kernel/authoring/object-edit/ObjectEditSessionController"
  );
  mocks.objectEditSession ??= new ObjectEditSessionController();
  return {
    KernelContext: React.createContext(null),
    useKernel: () => ({
      api: {
        model: {
          commitTransaction: mocks.commitTransaction,
          patchObject: mocks.patchObject,
          scene: mocks.readScene,
        },
      },
      authoringHistory: {
        getGeneration: () => mocks.historyGeneration,
        record: mocks.recordHistory,
      },
      commands: { execute: vi.fn(), getSessionScopeKey: mocks.getSessionScopeKey },
      objectEditSession: mocks.objectEditSession,
      resources: { invalidate: mocks.invalidate },
      selection: { get: () => null, set: vi.fn(), clear: vi.fn() },
      layout: {},
    }),
  };
});

vi.mock("@/kernel/resources/geometryLifecycleResources", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("@/kernel/resources/geometryLifecycleResources")
  >();
  return {
    ...original,
    publishCommittedSceneResource: mocks.publishCommittedScene,
    useGeometryValidationResource: () => ({ data: null, status: "ready" }),
    useSceneResource: () => ({ data: mocks.sceneData, status: "ready" }),
  };
});

vi.mock("@/kernel/resources/studyRuntimeResources", () => ({
  useObjectMetricsResource: () => ({ data: null, status: "idle" }),
}));

vi.mock("@/kernel/visualization/useVisualizationStateResource", () => ({
  useVisualizationStateResource: () => ({ data: null, optimisticData: null }),
}));

vi.mock("@/kernel/visualization/useObjectVisualization", () => ({
  useObjectVisualizationSelector: () => null,
}));

vi.mock("@/modules/inspector/extensions/ObjectExtensionsSection", () => ({
  ObjectExtensionsSection: () => null,
}));

const selection: Selection = {
  kind: "object.root",
  label: "Magnet",
  moduleSource: "test",
  nodeId: "model:object:object-a",
  objectId: "object-a",
  ref: {
    kind: "object.root",
    nodeId: "model:object:object-a",
    objectId: "object-a",
    type: "scene-object",
    visualizationTargetId: "object:object-a",
  },
};

function objectSelection(objectId: string, label: string): Selection {
  const nodeId = `model:object:${objectId}`;
  return {
    kind: "object.root",
    label,
    moduleSource: "test",
    nodeId,
    objectId,
    ref: {
      kind: "object.root",
      nodeId,
      objectId,
      type: "scene-object",
      visualizationTargetId: `object:${objectId}`,
    },
  };
}

function activateGeneralDraft(
  objectId: string,
  overrides: Partial<GeometryObjectDraft> = {},
): void {
  const canonicalDraft = resolveCommittedGeometryObjectDraft(
    mocks.sceneData as never,
    objectId,
  );
  if (!canonicalDraft || !mocks.objectEditSession) {
    throw new Error("Expected canonical scene object and edit controller");
  }
  const sessionScopeKey = "session=A&epoch=1";
  mocks.objectEditSession.activate({
    objectId,
    sessionScopeKey,
    targetKey: geometryObjectEditSessionTargetKey(sessionScopeKey, canonicalDraft),
  }, { ...canonicalDraft, ...overrides });
}

describe("ObjectGeneralPanel staged identity edits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionScopeKey.mockReturnValue("session=A&epoch=1");
    mocks.historyGeneration = 0;
    mocks.sceneData = {
      objects: [{
        geometry: { geometry_kind: "Box", geometry_params: { size: [1e-7, 1e-7, 1e-8] } },
        id: "object-a",
        name: "Magnet",
        notes: "Original notes",
        transform: {
          pivot: [0, 0, 0],
          rotation_quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
          translation: [0, 0, 0],
        },
      }],
      revision: 10,
      scene_revision: 10,
    };
    mocks.readScene.mockResolvedValue(mocks.sceneData);
    mocks.objectEditSession?.clear();
    mocks.commitTransaction.mockResolvedValue({
      committed_scene: {
        objects: [{
          geometry: { geometry_kind: "Box", geometry_params: { size: [1e-7, 1e-7, 1e-8] } },
          id: "object-a",
          name: "Magnet",
          notes: "Original notes",
          transform: {
            pivot: [0, 0, 0],
            rotation_quat: [0, 0, 0, 1],
            scale: [1, 1, 1],
            translation: [1e-7, 0, 0],
          },
        }],
        revision: 11,
        scene_revision: 11,
      },
      scene_revision: 11,
    });
    mocks.patchObject.mockResolvedValue({
      objects: [{ id: "object-a", name: "Updated magnet", notes: "Original notes" }],
      revision: 11,
      scene_revision: 11,
    });
  });

  it("applies identity through the shared registry and records one mutation-owned history entry", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <InspectorEditSessionProvider>
          <ObjectGeneralPanel selection={selection} />
          <InspectorSessionProbe />
        <InspectorFooter focusDisabled onFocus={() => undefined} />
        </InspectorEditSessionProvider>,
      ));
      await act(async () => changeInput(container, "Name", "Updated magnet"));

      expect(findButton(container, "Global Apply").disabled).toBe(false);
      expect(findButton(container, "Delete").disabled).toBe(true);
      await act(async () => findButton(container, "Global Apply").click());

      expect(mocks.readScene).toHaveBeenCalledWith({ sessionScopeKey: "session=A&epoch=1" });
      expect(mocks.readScene).toHaveBeenCalledOnce();
      expect(mocks.patchObject).toHaveBeenCalledWith(
        "object-a",
        { base_revision: 10, name: "Updated magnet", notes: "Original notes" },
        { sessionScopeKey: "session=A&epoch=1" },
      );
      expect(mocks.recordHistory).toHaveBeenCalledOnce();
      expect(container.textContent).toContain("Object identity committed.");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("keeps identity success feedback across an ACK revision and scopes it to session and object", async () => {
    const beforeObject = {
      geometry: { geometry_kind: "Box", geometry_params: { size: [1e-7, 1e-7, 1e-8] } },
      id: "object-a",
      material_ref: null,
      name: "Magnet",
      notes: "Original notes",
      region_name: null,
      transform: {
        pivot: [0, 0, 0],
        rotation_quat: [0, 0, 0, 1],
        scale: [1, 1, 1],
        translation: [0, 0, 0],
      },
    };
    const beforeScene = {
      objects: [beforeObject],
      revision: 7,
      scene_revision: 7,
    };
    const acknowledgedScene = {
      objects: [
        { ...beforeObject, name: "Updated magnet" },
        { ...beforeObject, id: "object-b", name: "Other magnet" },
      ],
      revision: 8,
      scene_revision: 8,
    };
    mocks.sceneData = beforeScene;
    mocks.readScene.mockReset();
    mocks.readScene.mockResolvedValue(beforeScene);
    mocks.patchObject.mockResolvedValue(acknowledgedScene);

    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    const renderPanel = (activeSelection: Selection) => (
      <InspectorEditSessionProvider>
        <ObjectGeneralPanel selection={activeSelection} />
      <InspectorFooter focusDisabled onFocus={() => undefined} />
        </InspectorEditSessionProvider>
    );
    try {
      await act(async () => root.render(renderPanel(selection)));
      await act(async () => changeInput(container, "Name", "Updated magnet"));
      await act(async () => findButton(container, "Apply").click());

      expect(mocks.patchObject).toHaveBeenCalledWith(
        "object-a",
        { base_revision: 7, name: "Updated magnet", notes: "Original notes" },
        { sessionScopeKey: "session=A&epoch=1" },
      );
      expect(container.textContent).toContain("Object identity committed.");

      // Model the resource rerender caused by publishing the revision-8 ACK.
      mocks.sceneData = acknowledgedScene;
      await act(async () => root.render(renderPanel(selection)));
      expect(container.textContent).toContain("Object identity committed.");

      mocks.getSessionScopeKey.mockReturnValue("session=B&epoch=2");
      await act(async () => root.render(renderPanel(selection)));
      expect(container.textContent).not.toContain("Object identity committed.");

      mocks.getSessionScopeKey.mockReturnValue("session=A&epoch=1");
      await act(async () => root.render(renderPanel(selection)));
      expect(container.textContent).not.toContain("Object identity committed.");

      await act(async () => root.render(renderPanel(objectSelection("object-b", "Other magnet"))));
      expect(container.textContent).not.toContain("Object identity committed.");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("shows and applies retained post-create material and region drafts through the identity patch", async () => {
    const createdScene = {
      objects: [{
        geometry: { geometry_kind: "Box", geometry_params: { size: [1e-7, 1e-7, 1e-8] } },
        id: "object-created",
        material_ref: "material-from-create-ack",
        name: "Created magnet",
        notes: "Created notes",
        region_name: "region-from-create-ack",
        transform: {
          pivot: [0, 0, 0],
          rotation_quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
          translation: [0, 0, 0],
        },
      }],
      revision: 11,
      scene_revision: 11,
    };
    mocks.sceneData = createdScene;
    mocks.readScene.mockResolvedValue(createdScene);
    activateGeneralDraft("object-created", {
      material: "retained-material-raw",
      region: "retained-region-raw",
    });
    const identityAck = {
      ...createdScene,
      objects: [{
        ...createdScene.objects[0],
        material_ref: "retained-material-raw",
        region_name: "applied-region",
      }],
      revision: 12,
      scene_revision: 12,
    };
    mocks.patchObject.mockResolvedValue(identityAck);
    const createdSelection = objectSelection("object-created", "Created magnet");
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <InspectorEditSessionProvider>
          <ObjectGeneralPanel selection={createdSelection} />
        <InspectorFooter focusDisabled onFocus={() => undefined} />
        </InspectorEditSessionProvider>,
      ));

      expect(findInput(container, "Material").value).toBe("retained-material-raw");
      expect(findInput(container, "Region").value).toBe("retained-region-raw");
      await act(async () => changeInput(container, "Region", "applied-region"));
      expect(findButton(container, "Apply").disabled).toBe(false);

      mocks.sceneData = identityAck;
      await act(async () => findButton(container, "Apply").click());

      expect(mocks.patchObject).toHaveBeenCalledWith("object-created", {
        base_revision: 11,
        material_ref: "retained-material-raw",
        name: "Created magnet",
        notes: "Created notes",
        region_name: "applied-region",
      }, { sessionScopeKey: "session=A&epoch=1" });
      expect(mocks.commitTransaction).not.toHaveBeenCalled();
      expect(mocks.recordHistory).toHaveBeenCalledOnce();
      expect(mocks.objectEditSession!.getSnapshot()).toMatchObject({
        dirty: false,
        draft: {
          baseRevision: 12,
          material: "retained-material-raw",
          name: "Created magnet",
          objectId: "object-created",
          region: "applied-region",
        },
      });
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("keeps a newer raw name in the kernel draft when identity ACK arrives", async () => {
    let finishPatch!: (value: unknown) => void;
    const patchResult = new Promise((resolve) => { finishPatch = resolve; });
    mocks.patchObject.mockReturnValue(patchResult);
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <InspectorEditSessionProvider>
          <ObjectGeneralPanel selection={selection} />
        <InspectorFooter focusDisabled onFocus={() => undefined} />
        </InspectorEditSessionProvider>,
      ));
      await act(async () => changeInput(container, "Name", "Submitted name"));

      await act(async () => {
        findButton(container, "Apply").click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mocks.patchObject).toHaveBeenCalledOnce();

      await act(async () => changeInput(container, "Name", "New raw name"));
      expect(mocks.objectEditSession!.getSnapshot().draft?.name).toBe("New raw name");
      const identityAck = {
        objects: [{
          geometry: { geometry_kind: "Box", geometry_params: { size: [1e-7, 1e-7, 1e-8] } },
          id: "object-a",
          material_ref: null,
          name: "Submitted name",
          notes: "Original notes",
          region_name: null,
          transform: {
            pivot: [0, 0, 0],
            rotation_quat: [0, 0, 0, 1],
            scale: [1, 1, 1],
            translation: [0, 0, 0],
          },
        }],
        revision: 11,
        scene_revision: 11,
      };
      mocks.sceneData = identityAck;
      await act(async () => {
        finishPatch(identityAck);
        await patchResult;
      });

      expect(findInput(container, "Name").value).toBe("New raw name");
      expect(mocks.objectEditSession!.getSnapshot()).toMatchObject({
        dirty: true,
        draft: {
          baseRevision: 11,
          name: "New raw name",
          objectId: "object-a",
        },
      });
      expect(mocks.patchObject).toHaveBeenCalledOnce();
      expect(mocks.commitTransaction).not.toHaveBeenCalled();
      expect(mocks.publishCommittedScene).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("suppresses publication when the edit owner changes before identity ACK", async () => {
    let finishPatch!: (value: unknown) => void;
    const patchResult = new Promise((resolve) => { finishPatch = resolve; });
    mocks.patchObject.mockReturnValue(patchResult);
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <InspectorEditSessionProvider>
          <ObjectGeneralPanel selection={selection} />
        <InspectorFooter focusDisabled onFocus={() => undefined} />
        </InspectorEditSessionProvider>,
      ));
      await act(async () => changeInput(container, "Name", "Submitted name"));
      await act(async () => {
        findButton(container, "Apply").click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mocks.patchObject).toHaveBeenCalledOnce();

      const canonical = resolveCommittedGeometryObjectDraft(mocks.sceneData as never, "object-a");
      if (!canonical || !mocks.objectEditSession) throw new Error("Expected current object draft");
      mocks.objectEditSession.clear();
      const newOwner = mocks.objectEditSession.activate({
        objectId: "object-a",
        sessionScopeKey: "session=A&epoch=1",
        targetKey: geometryObjectEditSessionTargetKey("session=A&epoch=1", canonical),
      }, { ...canonical, name: "Other owner raw name" });
      const staleAck = {
        objects: [{
          geometry: { geometry_kind: "Box", geometry_params: { size: [1e-7, 1e-7, 1e-8] } },
          id: "object-a",
          name: "Submitted name",
          notes: "Original notes",
          transform: {
            pivot: [0, 0, 0],
            rotation_quat: [0, 0, 0, 1],
            scale: [1, 1, 1],
            translation: [0, 0, 0],
          },
        }],
        revision: 11,
        scene_revision: 11,
      };
      await act(async () => {
        finishPatch(staleAck);
        await patchResult;
      });

      expect(mocks.objectEditSession.getSnapshot()).toMatchObject({
        identity: newOwner,
        draft: { name: "Other owner raw name" },
      });
      expect(mocks.publishCommittedScene).not.toHaveBeenCalled();
      expect(mocks.invalidate).not.toHaveBeenCalled();
      expect(container.textContent).not.toContain("Object identity committed.");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("keeps newer General metadata through sequential identity and geometry ACKs", async () => {
    const before = mocks.sceneData as {
      objects: Array<Record<string, unknown>>;
      revision: number;
      scene_revision: number;
    };
    const beforeObject = before.objects[0];
    const identityAck = {
      ...before,
      objects: [{ ...beforeObject, name: "Updated magnet" }],
      revision: 11,
      scene_revision: 11,
    };
    mocks.readScene.mockReset();
    mocks.readScene
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(identityAck);
    let finishIdentityPatch!: (value: unknown) => void;
    const identityPatchResult = new Promise((resolve) => {
      finishIdentityPatch = resolve;
    });
    mocks.patchObject.mockReturnValueOnce(identityPatchResult);
    const geometryAck = {
      committed_scene: {
        ...identityAck,
        objects: [{
          ...beforeObject,
          geometry: {
            geometry_kind: "Box",
            geometry_params: { size: [2e-7, 1e-7, 1e-8] },
          },
          name: "Updated magnet",
        }],
        revision: 12,
        scene_revision: 12,
      },
      scene_revision: 12,
    };
    let finishGeometryPatch!: (value: unknown) => void;
    const geometryPatchResult = new Promise((resolve) => {
      finishGeometryPatch = resolve;
    });
    mocks.commitTransaction.mockReturnValueOnce(geometryPatchResult);
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <InspectorEditSessionProvider>
          <ObjectGeneralPanel selection={selection} />
          <GeometryObjectPanel selection={selection} />
          <InspectorSessionProbe />
        <InspectorFooter focusDisabled onFocus={() => undefined} />
        </InspectorEditSessionProvider>,
      ));
      await act(async () => changeInput(container, "Name", "Updated magnet"));
      await act(async () => changeInput(container, "Size X", "2e-7"));

      expect(findButton(container, "Apply").disabled).toBe(false);
      await act(async () => {
        findButton(container, "Apply").click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mocks.patchObject).toHaveBeenCalledOnce();

      await act(async () => changeInput(container, "Name", "Newer raw magnet"));
      expect(mocks.objectEditSession!.getSnapshot().draft?.name).toBe("Newer raw magnet");

      await act(async () => {
        finishIdentityPatch(identityAck);
        await identityPatchResult;
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mocks.commitTransaction).toHaveBeenCalledOnce();
      await act(async () => {
        finishGeometryPatch(geometryAck);
        await geometryPatchResult;
      });

      expect(mocks.patchObject).toHaveBeenCalledWith(
        "object-a",
        { base_revision: 10, name: "Updated magnet" },
        { sessionScopeKey: "session=A&epoch=1" },
      );
      expect(mocks.commitTransaction).toHaveBeenCalledOnce();
      expect(mocks.commitTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          base_revision: 11,
          geometry: { geometry_kind: "Box", geometry_params: { size: [2e-7, 1e-7, 1e-8] } },
          kind: "patch_object_geometry",
          object_id: "object-a",
        }),
        { sessionScopeKey: "session=A&epoch=1" },
      );
      expect(mocks.recordHistory).toHaveBeenCalledTimes(2);
      expect(findInput(container, "Name").value).toBe("Newer raw magnet");
      expect(findButton(container, "Apply").disabled).toBe(false);
      expect(mocks.objectEditSession!.getSnapshot()).toMatchObject({
        dirty: true,
        draft: {
          baseRevision: 12,
          name: "Newer raw magnet",
          notes: "Original notes",
          objectId: "object-a",
        },
      });
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("suppresses history and feedback when the session changes before the identity ACK", async () => {
    let finishPatch!: (value: unknown) => void;
    const patchResult = new Promise((resolve) => { finishPatch = resolve; });
    mocks.patchObject.mockReturnValue(patchResult);
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <InspectorEditSessionProvider>
          <ObjectGeneralPanel selection={selection} />
          <InspectorSessionProbe />
        <InspectorFooter focusDisabled onFocus={() => undefined} />
        </InspectorEditSessionProvider>,
      ));
      await act(async () => changeInput(container, "Name", "Updated magnet"));
      await act(async () => {
        findButton(container, "Global Apply").click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mocks.patchObject).toHaveBeenCalledOnce();

      mocks.getSessionScopeKey.mockReturnValue("session=B&epoch=2");
      mocks.historyGeneration += 1;
      await act(async () => {
        finishPatch({
          objects: [{ id: "object-a", name: "Updated magnet", notes: "Original notes" }],
          revision: 11,
          scene_revision: 11,
        });
        await patchResult;
      });

      expect(mocks.recordHistory).not.toHaveBeenCalled();
      expect(mocks.invalidate).not.toHaveBeenCalled();
      expect(container.textContent).not.toContain("Object identity committed.");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("reflects dirty objectEditSession in inspector action state, shows warning banner, and commits 3D placement via Apply", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <InspectorEditSessionProvider>
          <ObjectGeneralPanel selection={selection} />
          <InspectorSessionProbe />
        <InspectorFooter focusDisabled onFocus={() => undefined} />
        </InspectorEditSessionProvider>,
      ));

      expect(findButton(container, "Global Apply").disabled).toBe(true);
      expect(container.textContent).not.toContain("Uncommitted object changes are pending");

      const baseDraft = resolveCommittedGeometryObjectDraft(mocks.sceneData as never, "object-a");
      if (!baseDraft) throw new Error("Expected base draft");
      const identity = mocks.objectEditSession!.activate({
        objectId: "object-a",
        sessionScopeKey: "session=A&epoch=1",
        targetKey: geometryObjectEditSessionTargetKey("session=A&epoch=1", baseDraft),
      }, baseDraft);

      await act(async () => {
        mocks.objectEditSession!.updateDraft(identity, (draft: GeometryObjectDraft) => ({
          ...draft,
          translation: ["1e-7", "0", "0"],
        }));
      });

      expect(findButton(container, "Global Apply").disabled).toBe(false);
      expect(container.textContent).toContain("Uncommitted object changes are pending");

      await act(async () => findButton(container, "Global Apply").click());

      expect(mocks.commitTransaction).toHaveBeenCalledOnce();
      expect(mocks.objectEditSession!.getSnapshot().dirty).toBe(false);
      expect(container.textContent).toContain("Object placement committed.");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("reverts 3D placement changes and clears objectEditSession on Global Reset", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <InspectorEditSessionProvider>
          <ObjectGeneralPanel selection={selection} />
          <InspectorSessionProbe />
        <InspectorFooter focusDisabled onFocus={() => undefined} />
        </InspectorEditSessionProvider>,
      ));

      const baseDraft = resolveCommittedGeometryObjectDraft(mocks.sceneData as never, "object-a");
      if (!baseDraft) throw new Error("Expected base draft");
      const identity = mocks.objectEditSession!.activate({
        objectId: "object-a",
        sessionScopeKey: "session=A&epoch=1",
        targetKey: geometryObjectEditSessionTargetKey("session=A&epoch=1", baseDraft),
      }, baseDraft);

      await act(async () => {
        mocks.objectEditSession!.updateDraft(identity, (draft: GeometryObjectDraft) => ({
          ...draft,
          translation: ["1e-7", "0", "0"],
        }));
      });

      expect(findButton(container, "Global Reset").disabled).toBe(false);

      await act(async () => findButton(container, "Global Reset").click());

      expect(mocks.objectEditSession!.getSnapshot().dirty).toBe(false);
      expect(findButton(container, "Global Reset").disabled).toBe(true);
      expect(container.textContent).not.toContain("Uncommitted object changes are pending");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("serializes General and Geometry Apply while retaining edits entered during the ACK", async () => {
    let finishCommit!: (value: unknown) => void;
    const commitResult = new Promise((resolve) => { finishCommit = resolve; });
    mocks.commitTransaction.mockReturnValue(commitResult);
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <InspectorEditSessionProvider>
          <ObjectGeneralPanel selection={selection} />
          <GeometryObjectPanel selection={selection} />
          <InspectorSessionProbe />
        <InspectorFooter focusDisabled onFocus={() => undefined} />
        </InspectorEditSessionProvider>,
      ));
      await act(async () => changeInput(container, "Size X", "2e-7"));

      expect(findButton(container, "Apply").disabled).toBe(false);
      await act(async () => {
        findButton(container, "Apply").click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mocks.commitTransaction).toHaveBeenCalledOnce();

      await act(async () => changeInput(container, "Size X", "3e-7"));
      expect(findInput(container, "Size X").value).toBe("3e-7");
      expect(findButton(container, "Global Apply").disabled).toBe(true);
      await act(async () => {
        findButton(container, "Force Registered Apply").click();
        await Promise.resolve();
      });
      expect(mocks.commitTransaction).toHaveBeenCalledOnce();

      await act(async () => {
        finishCommit({
          committed_scene: {
            objects: [{
              geometry: { geometry_kind: "Box", geometry_params: { size: [2e-7, 1e-7, 1e-8] } },
              id: "object-a",
              name: "Magnet",
              notes: "Original notes",
              transform: {
                pivot: [0, 0, 0],
                rotation_quat: [0, 0, 0, 1],
                scale: [1, 1, 1],
                translation: [0, 0, 0],
              },
            }],
            revision: 11,
            scene_revision: 11,
          },
          scene_revision: 11,
        });
        await commitResult;
      });

      expect(mocks.commitTransaction).toHaveBeenCalledOnce();
      expect(mocks.commitTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          base_revision: 10,
          geometry: { geometry_kind: "Box", geometry_params: { size: [2e-7, 1e-7, 1e-8] } },
          kind: "patch_object_geometry",
          object_id: "object-a",
          transform: {
            pivot: [0, 0, 0],
            rotation_quat: [0, 0, 0, 1],
            scale: [1, 1, 1],
            translation: [0, 0, 0],
          },
        }),
        { sessionScopeKey: "session=A&epoch=1" },
      );
      expect(mocks.objectEditSession!.getSnapshot()).toMatchObject({
        dirty: true,
        draft: { baseRevision: 11, objectId: "object-a", size: ["3e-7", "1e-7", "1e-8"] },
      });
      expect(mocks.publishCommittedScene).toHaveBeenCalledOnce();
      expect(mocks.recordHistory).toHaveBeenCalledOnce();
      expect(container.textContent).toContain("Geometry and placement committed.");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});

function InspectorSessionProbe() {
  const session = useInspectorEditSession();
  const state = inspectorActionState(session);
  return (
    <>
      <button disabled={!state.canApply} type="button" onClick={() => void session?.apply()}>
        Global Apply
      </button>
      <button disabled={!state.canReset} type="button" onClick={() => void session?.reset()}>
        Global Reset
      </button>
      <button type="button" onClick={() => void session?.apply()}>
        Force Registered Apply
      </button>
    </>
  );
}

function changeInput(root: TestNode, label: string, value: string): void {
  const input = findInput(root, label);
  const nativeValueSetter = Object.getOwnPropertyDescriptor(
    TestElement.prototype,
    "value",
  )?.set;
  if (!nativeValueSetter) throw new Error("Missing native test input value setter");
  nativeValueSetter.call(input, value);
  input.dispatchEvent(new TestEvent("input", { bubbles: true }));
}

function findInput(root: TestNode, label: string): TestElement {
  const input = findElements(root, (element) =>
    element.tagName === "INPUT" && element.getAttribute("aria-label") === label)[0];
  if (!input) throw new Error(`Missing input ${label}`);
  return input;
}

function findButton(root: TestNode, text: string): TestElement {
  const button = findElements(root, (element) =>
    element.tagName === "BUTTON" && element.textContent.includes(text))[0];
  if (!button) throw new Error(`Missing button ${text}`);
  return button;
}

function findElements(root: TestNode, predicate: (element: TestElement) => boolean): TestElement[] {
  const found: TestElement[] = [];
  const visit = (node: TestNode): void => {
    if (node instanceof TestElement && predicate(node)) found.push(node);
    for (const child of node.childNodes) visit(child);
  };
  visit(root);
  return found;
}
