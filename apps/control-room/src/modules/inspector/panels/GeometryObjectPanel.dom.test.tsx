import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ControlRoomApiError } from "@/kernel/api/ControlRoomApi";
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
}));

vi.mock("@/kernel/KernelContext", async () => {
  const React = await import("react");
  return {
    KernelContext: React.createContext(null),
    useKernel: () => ({
      api: { model: { commitTransaction: mocks.commitTransaction, scene: mocks.readScene } },
      authoringHistory: {
        getGeneration: () => mocks.historyGeneration,
        record: mocks.recordHistory,
      },
      commands: { getSessionScopeKey: () => mocks.sessionScopeKey },
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
    mocks.commitTransaction.mockReset();
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
    mocks.commitTransaction.mockResolvedValueOnce({
      committed_scene: after,
      scene_revision: 13,
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
      expect(mocks.invalidate).toHaveBeenCalledTimes(7);
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
      .mockResolvedValueOnce({
        committed_scene: { objects: [{ id: "dirty-box" }], revision: 14 },
        scene_revision: 14,
      });
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
      );
      expect(mocks.invalidate).toHaveBeenCalledTimes(7);
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
      await act(async () => findButton(container, "Apply Draft").click());

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
        transform: { rotation: [0, 0, 0], scale: [1, 1, 1], translation: [0, 0, 0] },
      }],
      revision: 12,
    };
    mocks.commitTransaction.mockResolvedValueOnce({
      committed_scene: { objects: [{ id: "box-1" }], revision: 13 },
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

  it("locks global Apply when committed geometry and translation need separate commits", async () => {
    mocks.sceneResource.data = {
      objects: [{
        geometry: { geometry_kind: "Box", geometry_params: { size: [1e-7, 1e-7, 1e-8] } },
        id: "box-1",
        name: "Box 1",
        transform: { rotation: [0, 0, 0], scale: [1, 1, 1], translation: [0, 0, 0] },
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

      expect(findButton(container, "Global Apply").disabled).toBe(true);
      expect(container.textContent).toContain("Apply geometry and transform separately");
      expect(mocks.commitTransaction).not.toHaveBeenCalled();
      expect(findButton(container, "Global Reset").disabled).toBe(false);
      await act(async () => findButton(container, "Global Reset").click());
      expect(findElements(container, (element) =>
        element.tagName === "INPUT" && element.getAttribute("aria-label") === "Size X")[0]?.value).toBe("1e-7");
      expect(findElements(container, (element) =>
        element.tagName === "INPUT" && element.getAttribute("aria-label") === "Translation X")[0]?.value).toBe("0");
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
    </>
  );
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
