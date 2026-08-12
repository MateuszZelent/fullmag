import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  installSimulationPreparationTestDom,
  TestElement,
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
    data: { monitors: [], scene_revision: 7 },
    refetch: mocks.refetch,
  }),
}));

vi.mock("./PlanarMonitorDefinitionEditor", () => ({
  PlanarMonitorDefinitionEditor: () => <div>Canonical monitor editor</div>,
  planarMonitorDefinitionAvailabilityErrors: () => [],
}));

describe("PlanarMonitorDraftInspectorPanel", () => {
  beforeEach(() => {
    resetCrossSectionWorkspaceForTests();
    vi.clearAllMocks();
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

  it("creates the exact canonical draft with the resource scene revision", async () => {
    const draft = beginPlanarMonitorDraft();
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<PlanarMonitorDraftInspectorPanel />));
      await act(async () => findButton(container, "Apply monitor").click());

      expect(mocks.create).toHaveBeenCalledWith({
        expected_scene_revision: 7,
        monitor: draft.monitor,
      });
      expect(crossSectionWorkspaceStore.getSnapshot().planarMonitorDraft).toBeNull();
      expect(mocks.invalidate).toHaveBeenCalledWith(expect.any(String), 8);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("keeps local changes and exposes reload after a 409 conflict", async () => {
    const draft = beginPlanarMonitorDraft();
    mocks.create.mockRejectedValueOnce({ status: 409 });
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
});

function findButton(root: TestNode, text: string): TestElement {
  const button = findElements(root, (element) =>
    element.tagName === "BUTTON" && element.textContent.includes(text))[0];
  if (!button) throw new Error(`Missing button ${text}`);
  return button;
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
