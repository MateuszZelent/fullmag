import { readFileSync } from "node:fs";

import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CrossSectionDraft } from "@/kernel/workspace/crossSectionWorkspace";
import {
  installSimulationPreparationTestDom,
  TestElement,
  TestNode,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

import { CrossSectionDraftEditor } from "./CrossSectionDraftEditor";

const sessionA = {
  sessionId: "A",
  sessionEpoch: "1",
  requestScopeEpoch: "1",
} as const;
const sessionAScopeKey = "session=A&epoch=1&request_scope_epoch=1";

const mocks = vi.hoisted(() => ({
  currentSessionScopeKey: "session=A&epoch=1&request_scope_epoch=1" as string | null,
  create: vi.fn(),
  domainMeta: vi.fn(),
  historyGeneration: 0,
  invalidate: vi.fn(),
  queuePatch: vi.fn(),
  sessionIdentity: null as unknown,
  setActiveViewportMainModule: vi.fn(),
  setFocusedSlot: vi.fn(),
  setPanelVisible: vi.fn(),
  setSelection: vi.fn(),
}));

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => ({
    api: {
      data: { domain: { meta: mocks.domainMeta } },
      model: {
        scene: vi.fn(),
        planarMonitors: {
          create: mocks.create,
          list: vi.fn(),
        },
      },
    },
    authoringHistory: undefined,
    commands: { getSessionScopeKey: () => mocks.currentSessionScopeKey },
    layout: {
      setActiveViewportMainModule: mocks.setActiveViewportMainModule,
      setFocusedSlot: mocks.setFocusedSlot,
      setPanelVisible: mocks.setPanelVisible,
    },
    selection: {
      set: mocks.setSelection,
    },
    resources: {
      invalidate: mocks.invalidate,
      getRevision: vi.fn(() => 0),
      subscribe: vi.fn(() => () => undefined),
    },
    visualizationSync: {
      queuePatch: mocks.queuePatch,
    },
  }),
}));

vi.mock("@/kernel/resources/planarMonitorResources", () => ({
  usePlanarMonitorsResource: () => ({
    data: { monitors: [], scene_revision: 7 },
  }),
}));

vi.mock("@/kernel/resources/useSessionStatus", () => ({
  useSessionResourceIdentity: () => mocks.sessionIdentity,
}));

vi.mock("@/kernel/visualization/useVisualizationStateResource", () => ({
  useVisualizationStateResource: () => ({
    data: { planar: { source: { kind: "default" } } },
  }),
}));

const draft: CrossSectionDraft = {
  colorScale: "viridis",
  edgeWidth: 1.5,
  filterExpression: "quality < 0.3",
  frameExtent: "universe",
  id: "draft",
  includeWireframe: true,
  metric: "skewness",
  name: "Draft Cross-Section",
  plane: "xy",
  positionPercent: 50,
  rotationDegrees: 0,
  shrinkFactor: 0.8,
};
const crossSectionDraftEditorSourceUrl = new URL(
  "./CrossSectionDraftEditor.tsx",
  import.meta.url,
);

describe("CrossSectionDraftEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentSessionScopeKey = sessionAScopeKey;
    mocks.sessionIdentity = sessionA;
    mocks.domainMeta.mockResolvedValue({
      bounds: { max: [1, 1, 1], min: [-1, -1, -1] },
    });
    mocks.create.mockResolvedValue({
      monitor: { id: "monitor-a", name: draft.name },
      scene_revision: 8,
    });
  });

  it("renders the editable cut-frame controls without exposing unsupported frame geometry as active choices", () => {
    const html = renderToStaticMarkup(<CrossSectionDraftEditor draft={draft} />);

    expect(html).toContain("Cut Frame");
    expect(html).toContain("Draft Cross-Section");
    expect(html).toContain("Universe");
    expect(html).toContain('disabled="" value="magnetic_domain"');
    expect(html).toContain('disabled="" value="object_bounds"');
    expect(html).toContain('disabled="" value="custom"');
    expect(html).toContain('aria-label="Rotation"');
    expect(html).toContain('max="180"');
    expect(html).toContain('min="-180"');
    expect(html).not.toContain('aria-label="Rotation" disabled=""');
    expect(html).toContain("Apply monitor");
  });

  it("keeps draft frame edits local and selects a committed monitor through planar state", () => {
    const source = readFileSync(crossSectionDraftEditorSourceUrl, "utf8");

    expect(source).toContain("updateCrossSectionDraft(patch);");
    expect(source).toContain(
      'planar: { source: { kind: "monitor", monitor_id: monitor.id } }',
    );
    expect(source).not.toContain("fieldMapStore");
    expect(source).not.toContain("crossSectionVisualizationPatchFromDraft");
  });

  it("pins domain metadata and monitor creation to the same active session", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<CrossSectionDraftEditor draft={draft} />));
      await act(async () => findButton(container, "Apply monitor").click());

      expect(mocks.domainMeta).toHaveBeenCalledWith({ sessionScopeKey: sessionAScopeKey });
      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({ expected_scene_revision: 7 }),
        { sessionScopeKey: sessionAScopeKey },
      );
      expect(mocks.queuePatch).toHaveBeenCalledOnce();
      expect(mocks.setSelection).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("does not publish the create ACK after the session changes", async () => {
    let finishCreate: ((value: unknown) => void) | null = null;
    const createResult = new Promise((resolve) => {
      finishCreate = resolve;
    });
    mocks.create.mockReturnValue(createResult);
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<CrossSectionDraftEditor draft={draft} />));
      await act(async () => {
        findButton(container, "Apply monitor").click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mocks.create).toHaveBeenCalledWith(
        expect.any(Object),
        { sessionScopeKey: sessionAScopeKey },
      );
      mocks.currentSessionScopeKey = "session=B&epoch=2&request_scope_epoch=2";
      await act(async () => {
        finishCreate?.({
          monitor: { id: "monitor-a", name: draft.name },
          scene_revision: 8,
        });
        await createResult;
      });

      expect(mocks.queuePatch).not.toHaveBeenCalled();
      expect(mocks.invalidate).not.toHaveBeenCalled();
      expect(mocks.setSelection).not.toHaveBeenCalled();
      expect(mocks.setActiveViewportMainModule).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("fails closed if no session identity is ready", async () => {
    mocks.currentSessionScopeKey = null;
    mocks.sessionIdentity = null;
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<CrossSectionDraftEditor draft={draft} />));
      await act(async () => findButton(container, "Apply monitor").click());

      expect(mocks.domainMeta).not.toHaveBeenCalled();
      expect(mocks.create).not.toHaveBeenCalled();
      expect(container.textContent).toContain("Session identity is not ready");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});

function findButton(root: TestNode, text: string): TestElement {
  const button = findElements(root, (element) =>
    element.tagName === "BUTTON" && element.textContent.includes(text),
  )[0];
  if (!button) throw new Error(`Missing button ${text}`);
  return button;
}

function findElements(root: TestNode, predicate: (element: TestElement) => boolean): TestElement[] {
  const found: TestElement[] = [];
  const visit = (node: TestNode): void => {
    if (node instanceof TestElement && predicate(node)) found.push(node);
    node.childNodes.forEach(visit);
  };
  visit(root);
  return found;
}
