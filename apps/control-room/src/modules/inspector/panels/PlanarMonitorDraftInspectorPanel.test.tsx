import { act } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
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
  create: vi.fn(),
  invalidate: vi.fn(),
  setActiveViewportMainModule: vi.fn(),
  setFocusedSlot: vi.fn(),
  setPanelVisible: vi.fn(),
  setSelection: vi.fn(),
  refetch: vi.fn(),
  collection: { monitors: [] as unknown[], scene_revision: 7 },
}));

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => ({
    api: { model: { planarMonitors: { create: mocks.create } } },
    layout: {
      setActiveViewportMainModule: mocks.setActiveViewportMainModule,
      setFocusedSlot: mocks.setFocusedSlot,
      setPanelVisible: mocks.setPanelVisible,
    },
    resources: { invalidate: mocks.invalidate },
    selection: { set: mocks.setSelection },
  }),
}));

vi.mock("@/kernel/resources/planarMonitorResources", () => ({
  usePlanarMonitorsResource: () => ({
    data: mocks.collection,
    refetch: mocks.refetch,
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
    const serverHtml = renderToStaticMarkup(<PlanarMonitorDraftInspectorPanel />);
    beginPlanarMonitorDraft();
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const serverParagraph = dom.document.createElement("p");
    serverParagraph.setAttribute("class", "fm-mesh-empty");
    serverParagraph.setAttribute("role", "note");
    serverParagraph.appendChild(dom.document.createTextNode("No editable planar monitor draft."));
    container.appendChild(serverParagraph);
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
    const draft = beginPlanarMonitorDraft();
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<PlanarMonitorDraftInspectorPanel />));
      await act(async () => change(findControl(container, "Target kind"), "magnetic_domain"));
      await act(async () => findButton(container, "Apply monitor").click());

      expect(mocks.create).toHaveBeenCalledWith({
        expected_scene_revision: 7,
        monitor: uiRoundtripFixture().create,
      });
      expect(crossSectionWorkspaceStore.getSnapshot().planarMonitorDraft).toBeNull();
      expect(mocks.invalidate).toHaveBeenCalledWith(expect.any(String), 8);
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
      expect(mocks.create).toHaveBeenCalledWith({
        expected_scene_revision: 7,
        monitor: { ...draft.monitor, id: "midplane_3", name: "Midplane 3" },
      });
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
