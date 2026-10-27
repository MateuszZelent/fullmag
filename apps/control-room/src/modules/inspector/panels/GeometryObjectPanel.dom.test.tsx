import { act, useEffect, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ControlRoomApiError } from "@/kernel/api/ControlRoomApi";
import { AUTHORING_MUTATION_DEPENDENTS } from "@/kernel/authoring/authoringMutationInvalidation";
import {
  geometryObjectEditSessionTargetKey,
  resolveCommittedGeometryObjectDraft,
} from "@/kernel/authoring/object-edit/objectEditDraftModel";
import type { ObjectEditSessionController } from "@/kernel/authoring/object-edit/ObjectEditSessionController";
import type { GeometryObjectDraft } from "@/kernel/authoring/object-edit/objectEditTypes";
import {
  installSimulationPreparationTestDom,
  TestElement,
  TestEvent,
  TestNode,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import type { Selection } from "@/kernel/selection/selectionTypes";

import {
  InspectorEditSessionProvider,
  inspectorActionState,
  useInspectorEditSession,
} from "../InspectorEditSession";
import { GeometryObjectPanel } from "./GeometryObjectPanel";

const mocks = vi.hoisted(() => ({
  commitTransaction: vi.fn(),
  patchObject: vi.fn(),
  invalidate: vi.fn(),
  readScene: vi.fn(),
  recordHistory: vi.fn(),
  refetch: vi.fn(),
  historyGeneration: 0,
  sessionScopeKey: "session=A&epoch=1" as string | null,
  sceneResource: {
    data: { objects: [] as unknown[], revision: 12 },
    error: null as Error | null,
    revision: 12,
    status: "ready",
  },
  selectionState: null as unknown,
  select: vi.fn(),
  publishCommittedScene: vi.fn(),
  objectEditSession: null as ObjectEditSessionController<GeometryObjectDraft> | null,
}));

vi.mock("@/kernel/KernelContext", async (importOriginal) => {
  const { ObjectEditSessionController } = await import(
    "@/kernel/authoring/object-edit/ObjectEditSessionController"
  );
  mocks.objectEditSession ??= new ObjectEditSessionController();
  return {
    ...(await importOriginal<typeof import("@/kernel/KernelContext")>()),
    useKernel: () => ({
      api: { model: { commitTransaction: mocks.commitTransaction, patchObject: mocks.patchObject, scene: mocks.readScene } },
      authoringHistory: {
        getGeneration: () => mocks.historyGeneration,
        record: mocks.recordHistory,
      },
      commands: { getSessionScopeKey: () => mocks.sessionScopeKey },
      objectEditSession: mocks.objectEditSession,
      resources: { invalidate: mocks.invalidate },
      selection: {
        get: () => mocks.selectionState,
        set: (selection: unknown, source: unknown) => {
          mocks.selectionState = selection;
          mocks.select(selection, source);
        },
      },
    }),
  };
});

vi.mock("@/kernel/resources/geometryLifecycleResources", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/kernel/resources/geometryLifecycleResources")>();
  return {
    ...original,
    publishCommittedSceneResource: mocks.publishCommittedScene,
    useGeometryValidationResource: () => ({ data: null, status: "ready" }),
    useSceneResource: () => ({ ...mocks.sceneResource, refetch: mocks.refetch }),
  };
});

const selection: Selection = {
  kind: "builder.primitive",
  label: "New box",
  moduleSource: "test",
  nodeId: "geometry:draft:box",
  objectId: null,
  ref: null,
};

describe("GeometryObjectPanel primitive transaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.publishCommittedScene.mockReset();
    mocks.select.mockReset();
    mocks.commitTransaction.mockReset();
    mocks.patchObject.mockReset();
    mocks.objectEditSession?.clear();
    mocks.sceneResource.data = { objects: [], revision: 12 };
    mocks.sceneResource.error = null;
    mocks.sceneResource.revision = 12;
    mocks.sceneResource.status = "ready";
    mocks.historyGeneration = 0;
    mocks.sessionScopeKey = "session=A&epoch=1";
    mocks.selectionState = null;
    mocks.readScene.mockResolvedValue({ objects: [], revision: 12 });
    mocks.refetch.mockImplementation(() => undefined);
  });

  it("keeps unit-only changes local and blocks only the invalid field's unit selector", async () => {
    mocks.sceneResource.data = { revision: 12, objects: [committedObject("unit-box", "Unit box")] };
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<InspectorEditSessionProvider>
        <GeometryObjectPanel selection={committedSelection("unit-box", "Unit box")} />
        <InspectorSessionProbe />
      </InspectorEditSessionProvider>));
      const selector = findElements(container, (element) =>
        element.tagName === "SELECT" && element.getAttribute("aria-label") === "Size X unit")[0];
      expect(selector).toBeTruthy();
      await act(async () => {
        selector.value = "nm";
        selector.dispatchEvent(new TestEvent("change", { bubbles: true }));
      });
      expect(Number(findInput(container, "Size X").value)).toBeCloseTo(100, 10);
      expect(mocks.objectEditSession!.getSnapshot().draft?.quantityFields?.["size.0"]?.unit).toBe("nm");
      expect(findButton(container, "Global Apply").disabled).toBe(true);
      expect(mocks.commitTransaction).not.toHaveBeenCalled();
      expect(mocks.recordHistory).not.toHaveBeenCalled();
      await act(async () => changeInput(container, "Size X", "1e-"));
      expect(findInput(container, "Size X").value).toBe("1e-");
      expect(selector.disabled).toBe(true);
      const otherSelector = findElements(container, (element) =>
        element.tagName === "SELECT" && element.getAttribute("aria-label") === "Size Y unit")[0];
      expect(otherSelector.disabled).toBe(false);
      expect(findInput(container, "Size Y").disabled).toBe(false);
      expect(findButton(container, "Global Apply").disabled).toBe(true);
      expect(mocks.objectEditSession!.getSnapshot().draft?.quantityFields?.["size.0"]?.lastValidSI).toBeCloseTo(1e-7, 22);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("pins the write and drops local history effects when the session changes before ACK", async () => {
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
      await act(async () => root.render(<GeometryObjectPanel selection={selection} />));
      await act(async () => {
        findButton(container, "Apply Draft").click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mocks.readScene).toHaveBeenCalledWith({
        sessionScopeKey: "session=A&epoch=1",
      });
      expect(mocks.commitTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ base_revision: 12, kind: "create_object" }),
        { sessionScopeKey: "session=A&epoch=1" },
      );

      mocks.sessionScopeKey = "session=B&epoch=2";
      mocks.historyGeneration += 1;
      await act(async () => {
        finishCommit?.({
          committed_scene: { objects: [{ id: "late-object" }], revision: 13 },
          scene_revision: 13,
        });
        await commitResult;
        await Promise.resolve();
      });

      expect(mocks.recordHistory).not.toHaveBeenCalled();
      expect(mocks.invalidate).not.toHaveBeenCalled();
      expect(mocks.select).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("records one geometry create from the session-scoped before and committed scenes", async () => {
    const after = {
      objects: [{ id: "new-box" }],
      revision: 13,
    };
    mocks.commitTransaction.mockImplementationOnce(async (request) => {
      after.objects[0]!.id = request.object_id;
      return { committed_scene: after, scene_revision: 13 };
    });
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<GeometryObjectPanel selection={selection} />));
      await act(async () => findButton(container, "Apply Draft").click());

      expect(mocks.recordHistory).toHaveBeenCalledOnce();
      expect(mocks.recordHistory).toHaveBeenCalledWith({
        after,
        afterWorkspaceState: { selection: mocks.select.mock.calls[0]?.[0] },
        before: { objects: [], revision: 12 },
        beforeWorkspaceState: { selection: null },
        committedRevision: 13,
        label: "Create New box",
      });
      expect(mocks.select).toHaveBeenCalledOnce();
      expect(mocks.invalidate).toHaveBeenCalledTimes(AUTHORING_MUTATION_DEPENDENTS.geometry.length);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it.each([false, true])("transfers newer create metadata and geometry, with geometry failure=%s", async (failGeometry) => {
    let finishCommit!: (value: unknown) => void;
    const commitResult = new Promise((resolve) => { finishCommit = resolve; });
    mocks.commitTransaction.mockReturnValue(commitResult);
    mocks.publishCommittedScene.mockImplementation((_resources, committedScene, revision) => {
      mocks.sceneResource.data = committedScene;
      mocks.sceneResource.revision = revision;
    });
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    function SelectionHost() {
      const [currentSelection, setCurrentSelection] = useState(selection);
      mocks.select.mockImplementation((next) => setCurrentSelection(next as Selection));
      return <GeometryObjectPanel selection={currentSelection} />;
    }
    try {
      await act(async () => root.render(
        <InspectorEditSessionProvider>
          <SelectionHost />
          <InspectorSessionProbe />
        </InspectorEditSessionProvider>,
      ));
      await act(async () => changeInput(container, "Size X", "2e-7"));
      await act(async () => {
        findButton(container, "Apply Draft").click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mocks.commitTransaction).toHaveBeenCalledOnce();
      expect(findInput(container, "Size X").value).toBe("2e-7");
      const createdObjectId = mocks.commitTransaction.mock.calls[0]?.[0]?.object_id as string;
      expect(createdObjectId).toBeTruthy();

      await act(async () => changeInput(container, "Size X", "3e-7"));
      await act(async () => {
        changeInput(container, "Name", "Later name");
        changeInput(container, "Material", "later-material");
        changeInput(container, "Region", "later-region");
      });
      expect(findInput(container, "Size X").value).toBe("3e-7");
      await act(async () => {
        finishCommit({
          committed_scene: {
            objects: [{
              geometry: {
                geometry_kind: "Box",
                geometry_params: { size: [2e-7, 1e-7, 1e-8] },
              },
              id: createdObjectId,
              name: "New box",
              transform: {
                pivot: [0, 0, 0],
                rotation_quat: [0, 0, 0, 1],
                scale: [1, 1, 1],
                translation: [0, 0, 0],
              },
            }],
            revision: 13,
          },
          scene_revision: 13,
        });
        await commitResult;
      });

      expect(mocks.objectEditSession!.getSnapshot()).toMatchObject({
        dirty: true,
        draft: { baseRevision: 13, mode: "committed", objectId: createdObjectId, name: "Later name", material: "later-material", region: "later-region", size: ["3e-7", "1e-7", "1e-8"] },
        identity: { objectId: createdObjectId, sessionScopeKey: "session=A&epoch=1" },
      });
      expect(mocks.select).toHaveBeenCalledOnce();
      expect(findInput(container, "Name").value).toBe("Later name");
      expect(findInput(container, "Material").value).toBe("later-material");
      expect(findInput(container, "Region").value).toBe("later-region");
      const createdScene = mocks.sceneResource.data;
      const createdObject = createdScene.objects[0] as Record<string, unknown>;
      const metadataScene = {
        revision: 14,
        objects: [{ ...createdObject, name: "Later name", material_ref: "later-material", region_name: "later-region" }],
      };
      const editedScene = {
        revision: 15,
        objects: [{ ...metadataScene.objects[0], geometry: { geometry_kind: "Box", geometry_params: { size: [3e-7, 1e-7, 1e-8] } } }],
      };
      mocks.readScene.mockImplementation(async () => mocks.sceneResource.data);
      mocks.patchObject.mockResolvedValue(metadataScene);
      if (failGeometry) mocks.commitTransaction.mockRejectedValueOnce(new Error("geometry rejected"));
      else mocks.commitTransaction.mockResolvedValueOnce({ committed_scene: editedScene, scene_revision: 15 });
      await act(async () => {
        findButton(container, "Global Apply").click();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mocks.patchObject).toHaveBeenCalledExactlyOnceWith(createdObjectId, {
        base_revision: 13,
        name: "Later name",
        material_ref: "later-material",
        region_name: "later-region",
      }, { sessionScopeKey: "session=A&epoch=1" });
      expect(mocks.commitTransaction.mock.calls[1]?.[0]).toMatchObject({
        kind: "patch_object_geometry", object_id: createdObjectId, base_revision: 14,
        geometry: { geometry_kind: "Box", geometry_params: { size: [3e-7, 1e-7, 1e-8] } },
      });
      if (failGeometry) {
        expect(mocks.objectEditSession!.getSnapshot()).toMatchObject({
          dirty: true, applyOperationId: null, draft: { baseRevision: 14, name: "Later name", size: ["3e-7", "1e-7", "1e-8"] },
        });
        expect(container.textContent).toContain("Metadata was committed; geometry remains unapplied.");
        mocks.commitTransaction.mockResolvedValueOnce({ committed_scene: editedScene, scene_revision: 15 });
        await act(async () => {
          findButton(container, "Global Apply").click();
          await Promise.resolve();
          await Promise.resolve();
        });
        expect(mocks.patchObject).toHaveBeenCalledOnce();
        expect(mocks.commitTransaction.mock.calls[2]?.[0]?.base_revision).toBe(14);
      }
      expect(mocks.objectEditSession!.getSnapshot()).toMatchObject({ dirty: false, draft: { baseRevision: 15, name: "Later name" } });
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("acknowledges a dirty primitive before the selection guard reads its form", async () => {
    mocks.commitTransaction.mockImplementationOnce(async (request) => ({
      committed_scene: { objects: [{ id: request.object_id }], revision: 13 },
      scene_revision: 13,
    }));
    const activeFormRef = { current: null as ReturnType<typeof useInspectorEditSession> };
    function CaptureForm() {
      const form = useInspectorEditSession();
      useEffect(() => {
        activeFormRef.current = form;
      }, [form]);
      return null;
    }
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <InspectorEditSessionProvider>
          <GeometryObjectPanel selection={selection} />
          <CaptureForm />
        </InspectorEditSessionProvider>,
      ));
      await act(async () => changeInput(container, "Size X", "2e-7"));
      expect(activeFormRef.current?.dirty).toBe(true);
      mocks.select.mockImplementationOnce(() => {
        // The real guard reads this facade synchronously inside selection.set.
        expect(activeFormRef.current?.dirty).toBe(false);
      });
      await act(async () => findButton(container, "Apply Draft").click());
      expect(mocks.commitTransaction).toHaveBeenCalledOnce();
      expect(mocks.select).toHaveBeenCalledOnce();
      expect(mocks.recordHistory).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("requires refetch and rebase after 409 before issuing one retry", async () => {
    mocks.commitTransaction
      .mockRejectedValueOnce(
        new ControlRoomApiError("scene changed", 409, "request-1", "revision_conflict"),
      )
      .mockImplementationOnce(async (request) => ({
        committed_scene: { objects: [{ id: request.object_id }], revision: 14 },
        scene_revision: 14,
      }));
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<GeometryObjectPanel selection={selection} />));
      await act(async () => changeInput(container, "Size X", "2.5e-7"));
      await act(async () => findButton(container, "Apply Draft").click());
      expect(mocks.commitTransaction).toHaveBeenCalledTimes(1);
      expect(mocks.commitTransaction).toHaveBeenLastCalledWith(
        expect.objectContaining({
          base_revision: 12,
          geometry: expect.objectContaining({ geometry_params: { size: [2.5e-7, 1e-7, 1e-8] } }),
          kind: "create_object",
          name: "New box",
        }),
        { sessionScopeKey: "session=A&epoch=1" },
      );
      expect(findButton(container, "Retry Apply").disabled).toBe(true);

      await act(async () => findButton(container, "Refetch Scene").click());
      expect(mocks.refetch).toHaveBeenCalledOnce();
      expect(findButton(container, "Rebase Draft").disabled).toBe(true);

      mocks.sceneResource.status = "loading";
      await act(async () => root.render(<GeometryObjectPanel selection={selection} />));
      expect(findButton(container, "Rebase Draft").disabled).toBe(true);

      mocks.sceneResource.data = { objects: [], revision: 13 };
      mocks.sceneResource.revision = 13;
      mocks.sceneResource.status = "ready";
      mocks.readScene.mockResolvedValue({ objects: [], revision: 13 });
      await act(async () => root.render(<GeometryObjectPanel selection={selection} />));
      expect(findButton(container, "Rebase Draft").disabled).toBe(false);
      await act(async () => findButton(container, "Rebase Draft").click());
      await act(async () => findButton(container, "Retry Apply").click());

      expect(mocks.commitTransaction).toHaveBeenCalledTimes(2);
      expect(mocks.commitTransaction).toHaveBeenLastCalledWith(
        expect.objectContaining({
          base_revision: 13,
          geometry: expect.objectContaining({ geometry_params: { size: [2.5e-7, 1e-7, 1e-8] } }),
          kind: "create_object",
          name: "New box",
        }),
        { sessionScopeKey: "session=A&epoch=1" },
      );
      expect(mocks.publishCommittedScene).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ revision: 14 }),
        14,
        undefined,
        false,
        "session=A&epoch=1",
        undefined,
      );
      expect(mocks.invalidate).toHaveBeenCalledTimes(AUTHORING_MUTATION_DEPENDENTS.geometry.length);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("keeps rebase locked when refetch ends in an error", async () => {
    mocks.commitTransaction.mockRejectedValueOnce(
      new ControlRoomApiError("scene changed", 409, "request-2", "revision_conflict"),
    );
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<GeometryObjectPanel selection={selection} />));
      await act(async () => findButton(container, "Apply Draft").click());
      await act(async () => findButton(container, "Refetch Scene").click());
      mocks.sceneResource.status = "loading";
      await act(async () => root.render(<GeometryObjectPanel selection={selection} />));
      mocks.sceneResource.status = "error";
      mocks.sceneResource.error = new Error("network unavailable");
      await act(async () => root.render(<GeometryObjectPanel selection={selection} />));

      expect(findButton(container, "Rebase Draft").disabled).toBe(true);
      expect(container.textContent).toContain("network unavailable");
      expect(mocks.commitTransaction).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("fails closed and sends no request when the scene revision is unavailable", async () => {
    mocks.sceneResource.data = { objects: [] } as never;
    mocks.sceneResource.revision = null as never;
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<GeometryObjectPanel selection={selection} />));
      expect(findButton(container, "Apply Draft").disabled).toBe(true);
      expect(mocks.commitTransaction).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("sends no request for an invalid primitive dimension", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<GeometryObjectPanel selection={selection} />));
      await act(async () => changeInput(container, "Size X", "0"));
      expect(findButton(container, "Apply Draft").disabled).toBe(true);

      expect(mocks.commitTransaction).not.toHaveBeenCalled();
      expect(container.textContent).toContain("greater than 0");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("registers a committed geometry draft and applies it through its single history owner", async () => {
    mocks.sceneResource.data = {
      objects: [{
        geometry: { geometry_kind: "Box", geometry_params: { size: [1e-7, 1e-7, 1e-8] } },
        id: "box-1",
        name: "Box 1",
        transform: {
          pivot: [0, 0, 0],
          rotation_quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
          translation: [0, 0, 0],
        },
      }],
      revision: 12,
    };
    mocks.commitTransaction.mockResolvedValueOnce({
      committed_scene: {
        objects: [{
          geometry: {
            geometry_kind: "Box",
            geometry_params: { size: [2e-7, 1e-7, 1e-8] },
          },
          id: "box-1",
          name: "Box 1",
          transform: {
            pivot: [0, 0, 0],
            rotation_quat: [0, 0, 0, 1],
            scale: [1, 1, 1],
            translation: [1e-7, 0, 0],
          },
        }],
        revision: 13,
      },
      scene_revision: 13,
    });
    const committedSelection: Selection = {
      kind: "object.root",
      label: "Box 1",
      moduleSource: "test",
      nodeId: "model:object:box-1",
      objectId: "box-1",
      ref: {
        kind: "object.root",
        nodeId: "model:object:box-1",
        objectId: "box-1",
        type: "scene-object",
        visualizationTargetId: "object:box-1",
      },
    };
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <InspectorEditSessionProvider>
          <GeometryObjectPanel selection={committedSelection} />
          <InspectorSessionProbe />
        </InspectorEditSessionProvider>,
      ));
      await act(async () => changeInput(container, "Size X", "2e-7"));
      expect(findButton(container, "Global Apply").disabled).toBe(false);

      await act(async () => findButton(container, "Global Apply").click());

      expect(mocks.commitTransaction).toHaveBeenCalledOnce();
      expect(mocks.commitTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          base_revision: 12,
          geometry: { geometry_kind: "Box", geometry_params: { size: [2e-7, 1e-7, 1e-8] } },
          kind: "patch_object_geometry",
        }),
        { sessionScopeKey: "session=A&epoch=1" },
      );
      expect(mocks.recordHistory).toHaveBeenCalledOnce();
      expect(mocks.readScene).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it.each([false, true])("preserves raw edits across a pending ACK with geometry=%s", async (withGeometry) => {
    const object = {
      id: "box-1", name: "Box 1",
      geometry: { geometry_kind: "Box", geometry_params: { size: [1e-7, 1e-7, 1e-8] } },
      transform: { pivot: [0, 0, 0], rotation_quat: [0, 0, 0, 1], scale: [1, 1, 1], translation: [0, 0, 0] },
    };
    mocks.sceneResource.data = { objects: [object], revision: 12 };
    mocks.readScene.mockImplementation(async () => mocks.sceneResource.data);
    mocks.publishCommittedScene.mockImplementation((_resources, scene, revision) => {
      mocks.sceneResource.data = scene;
      mocks.sceneResource.revision = revision;
    });
    const committedSelection: Selection = {
      kind: "object.root", label: "Box 1", moduleSource: "test",
      nodeId: "model:object:box-1", objectId: "box-1", ref: null,
    };
    let finishAck!: (value: unknown) => void;
    const pendingAck = new Promise((resolve) => { finishAck = resolve; });
    const metadataScene = { objects: [{ ...object, name: "Submitted name" }], revision: 13 };
    if (withGeometry) {
      mocks.patchObject.mockResolvedValue(metadataScene);
      mocks.commitTransaction.mockReturnValue(pendingAck);
    } else mocks.patchObject.mockReturnValue(pendingAck);
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    const panel = () => <InspectorEditSessionProvider>
      <GeometryObjectPanel selection={committedSelection} /><InspectorSessionProbe />
    </InspectorEditSessionProvider>;
    try {
      await act(async () => root.render(panel()));
      await act(async () => {
        changeInput(container, "Name", "Submitted name");
        if (withGeometry) changeInput(container, "Size X", "2e-7");
      });
      await act(async () => {
        findButton(container, "Global Apply").click();
        for (let index = 0; index < 12; index += 1) await Promise.resolve();
      });
      expect(mocks.patchObject).toHaveBeenCalledOnce();
      expect(mocks.commitTransaction).toHaveBeenCalledTimes(withGeometry ? 1 : 0);
      expect(mocks.objectEditSession!.getSnapshot().applyOperationId).not.toBeNull();
      await act(async () => {
        if (withGeometry) changeInput(container, "Size X", "0.2e-6");
        else changeInput(container, "Name", "Newer name");
      });
      const finalScene = withGeometry ? {
        objects: [{ ...metadataScene.objects[0], geometry: { geometry_kind: "Box", geometry_params: { size: [2e-7, 1e-7, 1e-8] } } }], revision: 14,
      } : metadataScene;
      await act(async () => {
        finishAck(withGeometry ? { committed_scene: finalScene, scene_revision: 14 } : finalScene);
        await pendingAck;
      });
      // Re-read the published canonical resource, as the real resource hook does.
      await act(async () => root.render(panel()));
      expect(mocks.objectEditSession!.getSnapshot()).toMatchObject({
        applyOperationId: null, dirty: !withGeometry,
        draft: { baseRevision: withGeometry ? 14 : 13, name: withGeometry ? "Submitted name" : "Newer name" },
      });
      expect(findInput(container, withGeometry ? "Size X" : "Name").value).toBe(withGeometry ? "0.2e-6" : "Newer name");
      if (withGeometry) expect(mocks.commitTransaction.mock.calls[0]?.[0]?.base_revision).toBe(13);
      else expect(mocks.commitTransaction).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
  it("applies geometry and placement in one full-transform transaction", async () => {
    mocks.sceneResource.data = {
      objects: [{
        geometry: { geometry_kind: "Box", geometry_params: { size: [1e-7, 1e-7, 1e-8] } },
        id: "box-1",
        name: "Box 1",
        transform: {
          pivot: [0, 0, 0],
          rotation_quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
          translation: [0, 0, 0],
        },
      }],
      revision: 12,
    };
    const committedSelection: Selection = {
      kind: "object.root",
      label: "Box 1",
      moduleSource: "test",
      nodeId: "model:object:box-1",
      objectId: "box-1",
      ref: {
        kind: "object.root",
        nodeId: "model:object:box-1",
        objectId: "box-1",
        type: "scene-object",
        visualizationTargetId: "object:box-1",
      },
    };
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <InspectorEditSessionProvider>
          <GeometryObjectPanel selection={committedSelection} />
          <InspectorSessionProbe />
        </InspectorEditSessionProvider>,
      ));
      await act(async () => changeInput(container, "Size X", "2e-7"));
      await act(async () => changeInput(container, "Translation X", "1e-7"));

      expect(findButton(container, "Global Apply").disabled).toBe(false);
      mocks.commitTransaction.mockResolvedValueOnce({
        committed_scene: {
          objects: [{
            geometry: {
              geometry_kind: "Box",
              geometry_params: { size: [2e-7, 1e-7, 1e-8] },
            },
            id: "box-1",
            name: "Box 1",
            transform: {
              pivot: [0, 0, 0],
              rotation_quat: [0, 0, 0, 1],
              scale: [1, 1, 1],
              translation: [1e-7, 0, 0],
            },
          }],
          revision: 13,
        },
        scene_revision: 13,
      });

      await act(async () => findButton(container, "Global Apply").click());

      expect(mocks.commitTransaction).toHaveBeenCalledOnce();
      expect(mocks.commitTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          base_revision: 12,
          geometry: { geometry_kind: "Box", geometry_params: { size: [2e-7, 1e-7, 1e-8] } },
          kind: "patch_object_geometry",
          transform: {
            pivot: [0, 0, 0],
            rotation_quat: [0, 0, 0, 1],
            scale: [1, 1, 1],
            translation: [1e-7, 0, 0],
          },
        }),
        { sessionScopeKey: "session=A&epoch=1" },
      );
      expect(mocks.recordHistory).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("does not publish an ACK after another object becomes the current draft owner", async () => {
    const objectA = committedObject("box-a", "Box A");
    const objectB = committedObject("box-b", "Box B");
    const before = { objects: [objectA, objectB], revision: 12 };
    mocks.sceneResource.data = before;
    mocks.readScene.mockResolvedValue(before);
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
          <GeometryObjectPanel selection={committedSelection("box-a", "Box A")} />
          <InspectorSessionProbe />
        </InspectorEditSessionProvider>,
      ));
      await act(async () => changeInput(container, "Size X", "2e-7"));
      await act(async () => {
        findButton(container, "Global Apply").click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mocks.commitTransaction).toHaveBeenCalledOnce();

      const ownerDraft = resolveCommittedGeometryObjectDraft(before as never, "box-b");
      if (!ownerDraft) throw new Error("Expected the next canonical object draft");
      await act(async () => {
        const identity = mocks.objectEditSession!.activate({
          objectId: "box-b",
          sessionScopeKey: "session=A&epoch=1",
          targetKey: geometryObjectEditSessionTargetKey("session=A&epoch=1", ownerDraft),
        }, ownerDraft);
        mocks.objectEditSession!.updateDraft(identity, (draft) => ({
          ...draft,
          translation: ["4e-7", "0", "0"],
        }));
      });
      await act(async () => root.render(
        <InspectorEditSessionProvider>
          <GeometryObjectPanel selection={committedSelection("box-b", "Box B")} />
          <InspectorSessionProbe />
        </InspectorEditSessionProvider>,
      ));

      expect(findButton(container, "Global Apply").disabled).toBe(true);
      expect(findButton(container, "Global Reset").disabled).toBe(true);
      await act(async () => {
        findButton(container, "Force Registered Apply").click();
        await Promise.resolve();
      });
      expect(mocks.commitTransaction).toHaveBeenCalledOnce();

      await act(async () => {
        finishCommit({
          committed_scene: {
            objects: [
              committedObject("box-a", "Box A", [2e-7, 1e-7, 1e-8]),
              objectB,
            ],
            revision: 13,
          },
          scene_revision: 13,
        });
        await commitResult;
      });

      expect(mocks.objectEditSession!.getSnapshot()).toMatchObject({
        dirty: true,
        draft: { baseRevision: 12, objectId: "box-b", translation: ["4e-7", "0", "0"] },
        identity: { objectId: "box-b", sessionScopeKey: "session=A&epoch=1" },
      });
      expect(mocks.publishCommittedScene).not.toHaveBeenCalled();
      expect(mocks.invalidate).not.toHaveBeenCalled();
      expect(container.textContent).not.toContain("Geometry and placement committed.");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("keeps a new session draft when the previous session's Apply ACK arrives late", async () => {
    const before = { objects: [committedObject("box-a", "Box A")], revision: 12 };
    mocks.sceneResource.data = before;
    mocks.readScene.mockResolvedValue(before);
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
          <GeometryObjectPanel selection={committedSelection("box-a", "Box A")} />
          <InspectorSessionProbe />
        </InspectorEditSessionProvider>,
      ));
      await act(async () => changeInput(container, "Size X", "2e-7"));
      await act(async () => {
        findButton(container, "Global Apply").click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mocks.commitTransaction).toHaveBeenCalledOnce();

      mocks.sessionScopeKey = "session=B&epoch=2";
      mocks.historyGeneration += 1;
      await act(async () => root.render(
        <InspectorEditSessionProvider>
          <GeometryObjectPanel selection={committedSelection("box-a", "Box A")} />
          <InspectorSessionProbe />
        </InspectorEditSessionProvider>,
      ));
      await act(async () => changeInput(container, "Size X", "3e-7"));

      await act(async () => {
        finishCommit({
          committed_scene: {
            objects: [committedObject("box-a", "Box A", [2e-7, 1e-7, 1e-8])],
            revision: 13,
          },
          scene_revision: 13,
        });
        await commitResult;
      });

      expect(mocks.objectEditSession!.getSnapshot()).toMatchObject({
        dirty: true,
        draft: { baseRevision: 12, objectId: "box-a", size: ["3e-7", "1e-7", "1e-8"] },
        identity: { objectId: "box-a", sessionScopeKey: "session=B&epoch=2" },
      });
      expect(mocks.publishCommittedScene).not.toHaveBeenCalled();
      expect(mocks.invalidate).not.toHaveBeenCalled();
      expect(container.textContent).not.toContain("Geometry and placement committed.");
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
      <button
        disabled={!state.canApply}
        type="button"
        onClick={() => void session?.apply()}
      >
        Global Apply
        <span>{state.applyReason}</span>
      </button>
      <button
        disabled={!state.canReset}
        type="button"
        onClick={() => void session?.reset()}
      >
        Global Reset
      </button>
      <button type="button" onClick={() => void session?.apply()}>
        Force Registered Apply
      </button>
    </>
  );
}

function findInput(root: TestNode, label: string): TestElement {
  const input = findElements(root, (element) =>
    element.tagName === "INPUT" && element.getAttribute("aria-label") === label)[0];
  if (!input) throw new Error(`Missing input ${label}`);
  return input;
}
function changeInput(root: TestNode, label: string, value: string): void {
  const input = findElements(root, (element) =>
    element.tagName === "INPUT" && element.getAttribute("aria-label") === label)[0];
  if (!input) throw new Error(`Missing input ${label}`);
  const nativeValueSetter = Object.getOwnPropertyDescriptor(
    TestElement.prototype,
    "value",
  )?.set;
  if (!nativeValueSetter) throw new Error("Missing native test input value setter");
  nativeValueSetter.call(input, value);
  input.dispatchEvent(new TestEvent("input", { bubbles: true }));
}

function committedObject(
  id: string,
  name: string,
  size: [number, number, number] = [1e-7, 1e-7, 1e-8],
) {
  return {
    geometry: { geometry_kind: "Box", geometry_params: { size } },
    id,
    name,
    transform: {
      pivot: [0, 0, 0],
      rotation_quat: [0, 0, 0, 1],
      scale: [1, 1, 1],
      translation: [0, 0, 0],
    },
  };
}

function committedSelection(objectId: string, label: string): Selection {
  return {
    kind: "object.root",
    label,
    moduleSource: "test",
    nodeId: `model:object:${objectId}`,
    objectId,
    ref: {
      kind: "object.root",
      nodeId: `model:object:${objectId}`,
      objectId,
      type: "scene-object",
      visualizationTargetId: `object:${objectId}`,
    },
  };
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
