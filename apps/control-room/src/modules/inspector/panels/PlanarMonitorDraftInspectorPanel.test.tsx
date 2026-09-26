import { act } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { renderToString, renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  installSimulationPreparationTestDom,
  TestElement,
  TestEvent,
  TestNode,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import {
  beginPlanarMonitorDraft,
  crossSectionWorkspaceStore,
  resetCrossSectionWorkspaceForTests,
} from "@/kernel/workspace/crossSectionWorkspace";

import { PlanarMonitorDraftInspectorPanel } from "./PlanarMonitorDraftInspectorPanel";

const mocks = vi.hoisted(() => ({
  authoringHistory: undefined as { record: ReturnType<typeof vi.fn>; getGeneration?: () => number } | undefined,
  create: vi.fn(),
  currentSessionScopeKey: "session=A&epoch=1&request_scope_epoch=1" as string | null,
  historyGeneration: 0,
  invalidate: vi.fn(),
  scene: vi.fn(),
  setActiveViewportMainModule: vi.fn(),
  setFocusedSlot: vi.fn(),
  setPanelVisible: vi.fn(),
  setSelection: vi.fn(),
  queuePatch: vi.fn(),
  refetch: vi.fn(),
  sessionIdentity: null as unknown,
  collection: { monitors: [] as unknown[], scene_revision: 7 },
}));

const sessionA = {
  sessionId: "A",
  sessionEpoch: "1",
  requestScopeEpoch: "1",
} as const;
const sessionAScopeKey = "session=A&epoch=1&request_scope_epoch=1";

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => ({
    api: { model: { planarMonitors: { create: mocks.create }, scene: mocks.scene } },
    authoringHistory: mocks.authoringHistory
      ? { ...mocks.authoringHistory, getGeneration: () => mocks.historyGeneration }
      : undefined,
    commands: { getSessionScopeKey: () => mocks.currentSessionScopeKey },
    layout: {
      setActiveViewportMainModule: mocks.setActiveViewportMainModule,
      setFocusedSlot: mocks.setFocusedSlot,
      setPanelVisible: mocks.setPanelVisible,
    },
    resources: { invalidate: mocks.invalidate },
    selection: { set: mocks.setSelection },
    visualizationSync: { queuePatch: mocks.queuePatch },
  }),
}));

vi.mock("@/kernel/resources/useSessionStatus", () => ({
  useSessionResourceIdentity: () => mocks.sessionIdentity,
}));

vi.mock("@/kernel/resources/planarMonitorResources", () => ({
  usePlanarMonitorsResource: () => ({
    data: mocks.collection,
    refetch: mocks.refetch,
  }),
}));

vi.mock("@/kernel/visualization/useVisualizationStateResource", () => ({
  useVisualizationStateResource: () => ({
    data: { planar: { source: { kind: "default" } } },
  }),
}));

vi.mock("./usePlanarMonitorDefinitionAvailability", () => ({
  usePlanarMonitorDefinitionAvailability: () => ({}),
}));

describe("PlanarMonitorDraftInspectorPanel", () => {
  beforeEach(() => {
    resetCrossSectionWorkspaceForTests();
    vi.clearAllMocks();
    mocks.collection.monitors = [];
    mocks.collection.scene_revision = 7;
    mocks.authoringHistory = undefined;
    mocks.currentSessionScopeKey = sessionAScopeKey;
    mocks.historyGeneration = 0;
    mocks.sessionIdentity = sessionA;
    mocks.scene.mockReset();
    mocks.create.mockResolvedValue({
      monitor: beginPlanarMonitorDraft().monitor,
      scene_revision: 8,
    });
    resetCrossSectionWorkspaceForTests();
  });

  it("renders only canonical monitor geometry and transaction actions", () => {
    beginPlanarMonitorDraft();

    const html = renderToStaticMarkup(<PlanarMonitorDraftInspectorPanel />);

    expect(html).toContain("No editable planar monitor draft");
  });

  it("hydrates the server empty snapshot before observing the live draft", async () => {
    const serverHtml = renderToString(<PlanarMonitorDraftInspectorPanel />);
    beginPlanarMonitorDraft();
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    (container as unknown as { innerHTML: string }).innerHTML = serverHtml;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let root: ReturnType<typeof hydrateRoot>;
    try {
      await act(async () => {
        root = hydrateRoot(container as unknown as Element, <PlanarMonitorDraftInspectorPanel />);
        await Promise.resolve();
      });
      expect(serverHtml).toContain("No editable planar monitor draft");
      expect(consoleError.mock.calls.flat().join(" ")).not.toContain("hydration");
    } finally {
      await act(async () => root!.unmount());
      consoleError.mockRestore();
      dom.restore();
    }
  });

  it("creates the exact canonical draft with the resource scene revision", async () => {
    beginPlanarMonitorDraft();
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<PlanarMonitorDraftInspectorPanel />));
      await act(async () => change(findControl(container, "Target kind"), "magnetic_domain"));
      await act(async () => findButton(container, "Apply monitor").click());

      expect(mocks.create).toHaveBeenCalledWith(
        {
          expected_scene_revision: 7,
          monitor: uiRoundtripFixture().create,
        },
        { sessionScopeKey: sessionAScopeKey },
      );
      expect(crossSectionWorkspaceStore.getSnapshot().planarMonitorDraft).toBeNull();
      expect(mocks.invalidate).toHaveBeenCalledWith(expect.any(String), 8);
      expect(mocks.queuePatch).toHaveBeenCalledWith({
        planar: {
          source: { kind: "monitor", monitor_id: "planar_monitor_1" },
        },
      });
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("records a created monitor against the captured canonical scene revision", async () => {
    const record = vi.fn();
    mocks.authoringHistory = { record };
    const before = { objects: [], revision: 7 };
    const after = { objects: [{ id: "planar_monitor_1" }], revision: 8 };
    mocks.scene.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    beginPlanarMonitorDraft();
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<PlanarMonitorDraftInspectorPanel />));
      await act(async () => findButton(container, "Apply monitor").click());

      expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
        expected_scene_revision: 7,
      }), { sessionScopeKey: sessionAScopeKey });
      expect(record).toHaveBeenCalledWith(expect.objectContaining({
        before,
        after,
        committedRevision: 8,
        label: "Create planar monitor",
      }));
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("does not publish workspace effects when the session changes before create ACK", async () => {
    const draft = beginPlanarMonitorDraft();
    let finishCreate: ((value: unknown) => void) | null = null;
    const createResult = new Promise((resolve) => {
      finishCreate = resolve;
    });
    mocks.create.mockReturnValue(createResult);
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<PlanarMonitorDraftInspectorPanel />));
      await act(async () => {
        findButton(container, "Apply monitor").click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({ expected_scene_revision: 7 }),
        { sessionScopeKey: sessionAScopeKey },
      );
      mocks.currentSessionScopeKey = "session=B&epoch=2&request_scope_epoch=2";
      mocks.historyGeneration += 1;
      await act(async () => {
        finishCreate?.({
          monitor: draft.monitor,
          scene_revision: 8,
        });
        await createResult;
      });

      expect(crossSectionWorkspaceStore.getSnapshot().planarMonitorDraft).toEqual(draft);
      expect(mocks.invalidate).not.toHaveBeenCalled();
      expect(mocks.queuePatch).not.toHaveBeenCalled();
      expect(mocks.setSelection).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("fails closed when the active session identity is unavailable", async () => {
    beginPlanarMonitorDraft();
    mocks.currentSessionScopeKey = null;
    mocks.sessionIdentity = null;
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<PlanarMonitorDraftInspectorPanel />));
      await act(async () => findButton(container, "Apply monitor").click());

      expect(mocks.scene).not.toHaveBeenCalled();
      expect(mocks.create).not.toHaveBeenCalled();
      expect(container.textContent).toContain("Session identity is not ready");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("allocates a unique identity when a second create collides with the collection", async () => {
    const draft = beginPlanarMonitorDraft();
    mocks.collection.monitors = [draft.monitor, { ...draft.monitor, id: "midplane_2", name: "Midplane 2" }];
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<PlanarMonitorDraftInspectorPanel />));
      await act(async () => findButton(container, "Apply monitor").click());
      expect(mocks.create).toHaveBeenCalledWith(
        {
          expected_scene_revision: 7,
          monitor: { ...draft.monitor, id: "midplane_3", name: "Midplane 3" },
        },
        { sessionScopeKey: sessionAScopeKey },
      );
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("keeps local changes and exposes reload after a 409 conflict", async () => {
    const draft = beginPlanarMonitorDraft();
    mocks.create.mockRejectedValueOnce({ status: 409, code: "scene_revision_conflict" });
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<PlanarMonitorDraftInspectorPanel />));
      await act(async () => findButton(container, "Apply monitor").click());

      expect(crossSectionWorkspaceStore.getSnapshot().planarMonitorDraft).toEqual(draft);
      expect(container.textContent).toContain("scene changed");
      await act(async () => findButton(container, "Reload current monitors").click());
      expect(mocks.refetch).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("does not classify a non-revision 409 as a reload conflict", async () => {
    beginPlanarMonitorDraft();
    mocks.create.mockRejectedValueOnce({ status: 409, code: "duplicate_planar_monitor_id" });
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<PlanarMonitorDraftInspectorPanel />));
      await act(async () => findButton(container, "Apply monitor").click());
      expect(container.textContent).not.toContain("scene changed");
      expect(container.textContent).not.toContain("Reload current monitors");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});

function findButton(root: TestNode, text: string): TestElement {
  const button = findElements(root, (element) =>
    element.tagName === "BUTTON" && element.textContent.includes(text))[0];
  if (!button) throw new Error(`Missing button ${text}`);
  return button;
}

function findControl(root: TestNode, label: string): TestElement {
  const control = findElements(root, (element) => element.getAttribute("aria-label") === label)[0];
  if (!control) throw new Error(`Missing control ${label}`);
  return control;
}

function change(element: TestElement, value: string): void {
  element.value = value;
  element.dispatchEvent(new TestEvent("change", { bubbles: true }));
}

function findElements(root: TestNode, predicate: (element: TestElement) => boolean): TestElement[] {
  const found: TestElement[] = [];
  const visit = (node: TestNode) => {
    if (node instanceof TestElement && predicate(node)) found.push(node);
    node.childNodes.forEach(visit);
  };
  visit(root);
  return found;
}

function uiRoundtripFixture(): { create: unknown; patch: unknown } {
  return JSON.parse(readFileSync(
    new URL("../../../../../../packages/fullmag-py/tests/fixtures/planar_monitor_ui_roundtrip.json", import.meta.url),
    "utf8",
  ));
}
