import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  installSimulationPreparationTestDom,
  TestElement,
  TestEvent,
  TestNode,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import {
  InspectorEditSessionProvider,
  inspectorActionState,
  useInspectorEditSession,
} from "../InspectorEditSession";
import type { Selection } from "@/kernel/selection/selectionTypes";

import { ObjectGeneralPanel } from "./ObjectGeneralPanel";

const mocks = vi.hoisted(() => ({
  getSessionScopeKey: vi.fn(() => "session=A&epoch=1" as string | null),
  historyGeneration: 0,
  invalidate: vi.fn(),
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
      transform: { translation: [0, 0, 0] },
    }],
    revision: 10,
    scene_revision: 10,
  } as unknown,
}));

vi.mock("@/kernel/KernelContext", async () => {
  const React = await import("react");
  return {
    KernelContext: React.createContext(null),
    useKernel: () => ({
      api: { model: { patchObject: mocks.patchObject, scene: mocks.readScene } },
      authoringHistory: {
        getGeneration: () => mocks.historyGeneration,
        record: mocks.recordHistory,
      },
      commands: { getSessionScopeKey: mocks.getSessionScopeKey },
      resources: { invalidate: mocks.invalidate },
      selection: { get: () => null, set: vi.fn(), clear: vi.fn() },
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
        transform: { translation: [0, 0, 0] },
      }],
      revision: 10,
      scene_revision: 10,
    };
    mocks.readScene.mockResolvedValue(mocks.sceneData);
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
