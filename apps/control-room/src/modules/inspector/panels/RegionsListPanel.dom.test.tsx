import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { KernelContext } from "@/kernel/KernelContext";
import type { KernelApi } from "@/kernel/types";
import {
  installSimulationPreparationTestDom,
  TestElement,
  TestEvent,
  TestNode,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { InspectorFooter } from "../InspectorFooter";
import {
  createInspectorEditSessionStore,
  InspectorEditSessionProvider,
} from "../InspectorEditSession";

const mocks = vi.hoisted(() => ({
  createRegion: vi.fn(),
  identity: {
    requestScopeEpoch: "1",
    sessionEpoch: "1",
    sessionId: "session-a",
  } as { requestScopeEpoch: string; sessionEpoch: string; sessionId: string } | null,
  readScene: vi.fn(),
  recordHistory: vi.fn(),
  sceneData: null as unknown,
  selectionSet: vi.fn(),
  sessionScopeKey: "session=session-a&epoch=1&request_scope_epoch=1",
  syncScript: vi.fn(),
}));

vi.mock("@/kernel/authoring/authoringHistoryMutation", () => ({
  authoringWriteOptions: (baseRevision: number | null, sessionScopeKey: string) => ({
    baseRevision,
    sessionScopeKey,
  }),
  runAuthoringMutationWithHistory: async (
    _context: unknown,
    _label: string,
    mutation: (preparation: { baseRevision: number }) => Promise<unknown>,
  ) => mutation({ baseRevision: 10 }),
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
  useModelRegionDiagnosticsResource: () => ({ data: null, status: "ready" }),
  useModelRegionsResource: () => ({
    data: { geometry_realization_revision: 0, regions: [] },
    status: "ready",
  }),
  useSceneResource: () => ({ data: mocks.sceneData, status: "ready" }),
}));

vi.mock("@/kernel/resources/useSessionStatus", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/kernel/resources/useSessionStatus")>(),
  useSessionResourceIdentity: () => mocks.identity,
  useSessionStatusSelector: (selector: (status: { data: null }) => unknown) =>
    selector({ data: null }),
}));

vi.mock("./regionAuthoringInvalidation", () => ({
  publishRegionAuthoringScene: vi.fn(),
}));

vi.mock("./ObjectMagneticTexturePanelViewModel", async (importOriginal) => ({
  ...await importOriginal<typeof import("./ObjectMagneticTexturePanelViewModel")>(),
  syncAuthoringScriptBestEffort: mocks.syncScript,
}));

import { RegionsListPanel } from "./RegionsListPanel";

describe("RegionsListPanel priority draft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.identity = {
      requestScopeEpoch: "1",
      sessionEpoch: "1",
      sessionId: "session-a",
    };
    mocks.sessionScopeKey = "session=session-a&epoch=1&request_scope_epoch=1";
    mocks.sceneData = sceneFor("object-a", "object-b");
    mocks.readScene.mockImplementation(async () => mocks.sceneData);
    mocks.createRegion.mockImplementation(async (objectId, payload) =>
      createdScene(objectId as string, payload as Record<string, unknown>),
    );
    mocks.syncScript.mockResolvedValue(null);
  });

  it("blocks invalid and uncommitted priority text from Create and Inspector Apply", async () => {
    const harness = await mountPanel("object-a");
    try {
      await addRegion(harness.container);
      await editInput(findInput(harness.container, "Priority"), "");
      expect(findInput(harness.container, "Priority").value).toBe("");
      expect(findButton(harness.container, "Apply").disabled).toBe(true);
      await clickButton(harness.container, "Create");
      expect(mocks.createRegion).not.toHaveBeenCalled();

      await editInput(findInput(harness.container, "Priority"), "-");
      expect(findButton(harness.container, "Apply").disabled).toBe(true);

      await clickButton(harness.container, "Create");
      expect(mocks.createRegion).not.toHaveBeenCalled();
      expect(harness.container.textContent).toContain("Complete or correct Priority");

      await editInput(findInput(harness.container, "Priority"), "0.0");
      expect(findInput(harness.container, "Priority").value).toBe("0.0");
      expect(findButton(harness.container, "Apply").disabled).toBe(true);
      await clickButton(harness.container, "Create");
      expect(mocks.createRegion).not.toHaveBeenCalled();
      expect(harness.container.textContent).toContain("Commit Priority");

      await clickButton(harness.container, "Cancel");
      await addRegion(harness.container);
      expect(findInput(harness.container, "Priority").value).toBe("0");
    } finally {
      await harness.dispose();
    }
  });

  it.each([
    { action: "Apply", commit: "blur", text: "0.0", priority: 0 },
    { action: "Create", commit: "enter", text: "-2", priority: -2 },
  ] as const)("commits legal priority $text before $action", async ({ action, commit, text, priority }) => {
    const harness = await mountPanel("object-a");
    try {
      await addRegion(harness.container);
      await editInput(findInput(harness.container, "Name"), `region-${priority}`);
      const priorityInput = findInput(harness.container, "Priority");
      await editInput(priorityInput, text);
      expect(findButton(harness.container, "Apply").disabled).toBe(true);

      await act(async () => {
        if (commit === "blur") {
          priorityInput.dispatchEvent(new TestEvent("focusout", { bubbles: true }));
        } else {
          priorityInput.dispatchEvent(new TestEvent("keydown", { bubbles: true, key: "Enter" }));
        }
      });
      expect(findButton(harness.container, "Apply").disabled).toBe(false);

      await clickButton(harness.container, action);
      expect(mocks.createRegion).toHaveBeenCalledOnce();
      expect(mocks.createRegion.mock.calls[0]?.[1]).toEqual(
        expect.objectContaining({ priority }),
      );
      expect(harness.container.textContent).toContain("Object region created.");

      await addRegion(harness.container);
      expect(findInput(harness.container, "Priority").value).toBe("0");
    } finally {
      await harness.dispose();
    }
  });

  it("preserves a later raw edit when the submitted create receives its acknowledgement", async () => {
    let finishCreate: (scene: unknown) => void = () => {
      throw new Error("Create has not started.");
    };
    mocks.createRegion.mockImplementation(() =>
      new Promise((resolve) => {
        finishCreate = (scene) => resolve(scene);
      }),
    );
    const harness = await mountPanel("object-a");
    try {
      await addRegion(harness.container);
      await editInput(findInput(harness.container, "Name"), "pending-region");
      await clickButton(harness.container, "Create");
      await flushPromises();
      expect(mocks.createRegion).toHaveBeenCalledOnce();

      const priorityInput = findInput(harness.container, "Priority");
      await editInput(priorityInput, "-");
      await act(async () => {
        finishCreate(
          createdScene("object-a", { name: "pending-region", priority: 0 }),
        );
        await flushPromises();
      });

      expect(findInput(harness.container, "Priority").value).toBe("-");
      expect(findButton(harness.container, "Apply").disabled).toBe(true);
    } finally {
      await harness.dispose();
    }
  });

  it("clears draft text when the edited object or session changes", async () => {
    const harness = await mountPanel("object-a");
    try {
      await addRegion(harness.container);
      await editInput(findInput(harness.container, "Name"), "object-a draft");
      await editInput(findInput(harness.container, "Priority"), "-");

      await harness.render("object-b");
      await addRegion(harness.container);
      expect(findInput(harness.container, "Name").value).toBe("");
      expect(findInput(harness.container, "Priority").value).toBe("0");

      await editInput(findInput(harness.container, "Priority"), "-");
      mocks.identity = {
        requestScopeEpoch: "2",
        sessionEpoch: "2",
        sessionId: "session-b",
      };
      mocks.sessionScopeKey = "session=session-b&epoch=2&request_scope_epoch=2";
      await harness.render("object-b");
      await addRegion(harness.container);
      expect(findInput(harness.container, "Priority").value).toBe("0");
    } finally {
      await harness.dispose();
    }
  });
});

async function mountPanel(objectId: string) {
  const dom = installSimulationPreparationTestDom();
  const container = dom.document.createElement("div");
  const root = createRoot(container as unknown as Element);
  const editSessionStore = createInspectorEditSessionStore();
  const kernel = {
    api: {
      model: {
        createRegion: mocks.createRegion,
        scene: mocks.readScene,
      },
    },
    authoringHistory: {
      getGeneration: () => 0,
      record: mocks.recordHistory,
    },
    commands: { getSessionScopeKey: () => mocks.sessionScopeKey },
    resources: {},
    selection: { set: mocks.selectionSet },
  } as unknown as KernelApi;
  const render = (selectedObjectId: string) => root.render(
    <KernelContext.Provider value={kernel}>
      <InspectorEditSessionProvider store={editSessionStore}>
        <RegionsListPanel selection={selectionFor(selectedObjectId)} />
        <InspectorFooter focusDisabled onFocus={() => undefined} />
      </InspectorEditSessionProvider>
    </KernelContext.Provider>,
  );
  await act(async () => {
    render(objectId);
    await flushPromises();
  });

  return {
    container,
    dispose: async () => {
      await act(async () => root.unmount());
      dom.restore();
    },
    render: async (selectedObjectId: string) => act(async () => render(selectedObjectId)),
  };
}

async function addRegion(container: TestNode): Promise<void> {
  await clickButton(container, "Add Region");
}

async function clickButton(container: TestNode, text: string): Promise<void> {
  await act(async () => {
    findButton(container, text).click();
    await flushPromises();
  });
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function editInput(input: TestElement, value: string): Promise<void> {
  await act(async () => {
    input.value = value;
    input.dispatchEvent(new TestEvent("input", { bubbles: true }));
  });
}

function findInput(container: TestNode, label: string): TestElement {
  const input = findElements(
    container,
    (element) => element.tagName === "INPUT" && element.getAttribute("aria-label") === label,
  )[0];
  if (!input) throw new Error(`Missing ${label} input`);
  return input;
}

function findButton(container: TestNode, text: string): TestElement {
  const button = findElements(
    container,
    (element) => element.tagName === "BUTTON" && element.textContent.includes(text),
  )[0];
  if (!button) throw new Error(`Missing ${text} button`);
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

function selectionFor(objectId: string) {
  const nodeId = `model:object:${objectId}:regions`;
  return {
    kind: "object.regions",
    label: "Object regions",
    moduleSource: "test",
    nodeId,
    objectId,
    ref: {
      kind: "object.regions",
      nodeId,
      objectId,
      type: "scene-object",
      visualizationTargetId: `object:${objectId}`,
    },
  } as never;
}

function sceneFor(...objectIds: string[]) {
  return {
    objects: objectIds.map((id) => ({
      geometry: {
        bounds_max: [1, 1, 1],
        bounds_min: [-1, -1, -1],
        geometry_kind: "Box",
        geometry_params: { size: [2, 2, 2] },
      },
      id,
      name: id,
      regions: [],
    })),
    revision: 10,
    scene_revision: 10,
  };
}

function createdScene(objectId: string, payload: Record<string, unknown>) {
  const current = mocks.sceneData as ReturnType<typeof sceneFor>;
  const nextRevision = current.revision + 1;
  const objects = current.objects.map((object) => object.id === objectId
    ? {
        ...object,
        regions: [
          ...object.regions,
          { ...payload, region_id: `region-${nextRevision}` },
        ],
      }
    : object);
  const committed = { ...current, objects, revision: nextRevision, scene_revision: nextRevision };
  mocks.sceneData = committed;
  return committed;
}
