import { readFileSync } from "node:fs";

import { act, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { KernelContext } from "@/kernel/KernelContext";
import type { KernelApi } from "@/kernel/types";
import { useCrossSectionWorkspaceSelector } from "@/kernel/workspace/useCrossSectionWorkspace";
import {
  beginCrossSectionDraft,
  crossSectionWorkspaceStore,
  resetCrossSectionWorkspaceForTests,
  updateCrossSectionDraft,
  type CrossSectionDraft,
} from "@/kernel/workspace/crossSectionWorkspace";
import {
  installSimulationPreparationTestDom,
  TestElement,
  TestEvent,
  TestNode,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

import {
  createInspectorEditSessionStore,
  InspectorEditSessionProvider,
} from "../InspectorEditSession";
import { CrossSectionDraftEditor as UnwrappedCrossSectionDraftEditor } from "./CrossSectionDraftEditor";

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
  kernel: null as unknown,
  queuePatch: vi.fn(),
  sessionIdentity: null as unknown,
  setActiveViewportMainModule: vi.fn(),
  setFocusedSlot: vi.fn(),
  setPanelVisible: vi.fn(),
  setSelection: vi.fn(),
}));

vi.mock("@/kernel/KernelContext", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/kernel/KernelContext")>();
  return {
    ...original,
    useKernel: () => mocks.kernel,
  };
});

function createTestKernel(): KernelApi {
  return {
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
      get: () => null,
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
  } as unknown as KernelApi;
}

function TestProviders({
  children,
  editSessionStore,
}: {
  children: ReactNode;
  editSessionStore?: ReturnType<typeof createInspectorEditSessionStore>;
}) {
  return (
    <KernelContext.Provider value={mocks.kernel as KernelApi}>
      <InspectorEditSessionProvider store={editSessionStore}>
        {children}
      </InspectorEditSessionProvider>
    </KernelContext.Provider>
  );
}

function CrossSectionDraftEditor(
  props: ComponentProps<typeof UnwrappedCrossSectionDraftEditor>,
) {
  return (
    <TestProviders>
      <UnwrappedCrossSectionDraftEditor {...props} />
    </TestProviders>
  );
}

function LiveCrossSectionDraftEditor() {
  const liveDraft = useCrossSectionWorkspaceSelector((state) => state.draft);
  return <UnwrappedCrossSectionDraftEditor draft={liveDraft} />;
}

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
    resetCrossSectionWorkspaceForTests();
    mocks.historyGeneration = 0;
    mocks.kernel = createTestKernel();
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
    const { createRoot } = await import("react-dom/client");
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
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<CrossSectionDraftEditor draft={draft} />));
      await act(async () => {
        findButton(container, "Apply monitor").click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(findButton(container, "Discard").getAttribute("disabled")).toBe("");
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
    const { createRoot } = await import("react-dom/client");
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

  it("blocks local and global Apply for raw numeric text and clears it on Discard", async () => {
    beginCrossSectionDraft();
    const editSessionStore = createInspectorEditSessionStore();
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () =>
        root.render(
          <TestProviders editSessionStore={editSessionStore}>
            <LiveCrossSectionDraftEditor />
          </TestProviders>,
        ),
      );

      const edgeWidth = findInput(container, "Edge width");
      await act(async () => editInput(edgeWidth, "4.5"));

      const applyButton = findButton(container, "Apply monitor");
      expect(applyButton.getAttribute("disabled")).toBe("");
      expect(editSessionStore.getCurrentSession()).toMatchObject({
        applyBlockReason: "Correct Edge width before applying.",
        dirty: true,
        valid: false,
      });
      const session = editSessionStore.getCurrentSession();
      expect(session).not.toBeNull();
      let applied: boolean | undefined;
      await act(async () => {
        applied = await session!.apply();
      });
      expect(applied).toBe(false);
      expect(mocks.domainMeta).not.toHaveBeenCalled();
      expect(mocks.create).not.toHaveBeenCalled();

      await act(async () => editInput(edgeWidth, "3.5"));
      expect(editSessionStore.getCurrentSession()).toMatchObject({
        applyBlockReason: "Commit or discard the pending cross-section numeric edits.",
        dirty: true,
        valid: false,
      });
      const pendingValidSession = editSessionStore.getCurrentSession();
      expect(pendingValidSession).not.toBeNull();
      await act(async () => {
        applied = await pendingValidSession!.apply();
      });
      expect(applied).toBe(false);
      expect(mocks.domainMeta).not.toHaveBeenCalled();
      expect(mocks.create).not.toHaveBeenCalled();

      await act(async () => findButton(container, "Discard").click());
      expect(crossSectionWorkspaceStore.getSnapshot().draft).toBeNull();
      expect(editSessionStore.getCurrentSession()).toBeNull();

      await act(async () => beginCrossSectionDraft());
      expect(findInput(container, "Edge width").value).toBe("1.5");
      expect(mocks.create).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("clears raw text when the session owner changes while keeping the draft values", async () => {
    beginCrossSectionDraft();
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    const render = () =>
      root.render(
        <TestProviders>
          <LiveCrossSectionDraftEditor />
        </TestProviders>,
      );
    try {
      await act(async () => render());
      const edgeWidth = findInput(container, "Edge width");
      await act(async () => editInput(edgeWidth, "4.5"));
      expect(edgeWidth.value).toBe("4.5");

      await act(async () =>
        updateCrossSectionDraft({ edgeWidth: 2, name: "Retitled draft" }),
      );
      expect(findInput(container, "Edge width").value).toBe("4.5");

      mocks.currentSessionScopeKey = "session=B&epoch=2&request_scope_epoch=2";
      mocks.sessionIdentity = {
        sessionId: "B",
        sessionEpoch: "2",
        requestScopeEpoch: "2",
      };
      await act(async () => render());

      expect(findInput(container, "Edge width").value).toBe("2");
      expect(crossSectionWorkspaceStore.getSnapshot().draft?.edgeWidth).toBe(2);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("preserves raw edits typed while a create ACK is pending", async () => {
    beginCrossSectionDraft();
    let finishCreate: ((value: unknown) => void) | null = null;
    const createResult = new Promise((resolve) => {
      finishCreate = resolve;
    });
    mocks.create.mockReturnValue(createResult);
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () =>
        root.render(
          <TestProviders>
            <LiveCrossSectionDraftEditor />
          </TestProviders>,
        ),
      );
      await act(async () => {
        findButton(container, "Apply monitor").click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mocks.create).toHaveBeenCalledOnce();

      const position = findInput(container, "Position");
      await act(async () => editInput(position, "12."));
      expect(position.value).toBe("12.");
      expect(findButton(container, "Discard").getAttribute("disabled")).toBe("");

      await act(async () => {
        finishCreate?.({
          monitor: { id: "monitor-a", name: draft.name },
          scene_revision: 8,
        });
        await createResult;
      });

      expect(crossSectionWorkspaceStore.getSnapshot().draft).not.toBeNull();
      expect(findInput(container, "Position").value).toBe("12.");
      expect(mocks.queuePatch).not.toHaveBeenCalled();
      expect(mocks.setSelection).not.toHaveBeenCalled();
      expect(mocks.invalidate).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("preserves a replacement draft and raw input when an earlier create ACK resolves", async () => {
    beginCrossSectionDraft();
    let finishCreate: ((value: unknown) => void) | null = null;
    const createResult = new Promise((resolve) => {
      finishCreate = resolve;
    });
    mocks.create.mockReturnValue(createResult);
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () =>
        root.render(
          <TestProviders>
            <LiveCrossSectionDraftEditor />
          </TestProviders>,
        ),
      );
      await act(async () => {
        findButton(container, "Apply monitor").click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mocks.create).toHaveBeenCalledOnce();

      let replacementDraft: CrossSectionDraft | null = null;
      await act(async () => {
        beginCrossSectionDraft();
        updateCrossSectionDraft({ edgeWidth: 2.5, name: "Replacement draft" });
        replacementDraft = crossSectionWorkspaceStore.getSnapshot().draft;
      });
      expect(replacementDraft).not.toBeNull();

      const edgeWidth = findInput(container, "Edge width");
      await act(async () => editInput(edgeWidth, "3."));
      expect(edgeWidth.value).toBe("3.");

      await act(async () => {
        finishCreate?.({
          monitor: { id: "monitor-a", name: draft.name },
          scene_revision: 8,
        });
        await createResult;
      });

      expect(crossSectionWorkspaceStore.getSnapshot().draft).toBe(replacementDraft);
      expect(
        crossSectionWorkspaceStore.getSnapshot().draft?.name,
      ).toBe("Replacement draft");
      expect(crossSectionWorkspaceStore.getSnapshot().draft?.edgeWidth).toBe(2.5);
      expect(findInput(container, "Edge width").value).toBe("3.");
      expect(mocks.create).toHaveBeenCalledOnce();
      expect(mocks.queuePatch).not.toHaveBeenCalled();
      expect(mocks.setSelection).not.toHaveBeenCalled();
      expect(mocks.setActiveViewportMainModule).not.toHaveBeenCalled();
      expect(mocks.invalidate).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("ignores a delayed create ACK after the session changes A to B and back to A", async () => {
    beginCrossSectionDraft();
    const submittedDraft = crossSectionWorkspaceStore.getSnapshot().draft;
    let finishCreate: ((value: unknown) => void) | null = null;
    const createResult = new Promise((resolve) => {
      finishCreate = resolve;
    });
    mocks.create.mockReturnValue(createResult);
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    const render = () =>
      root.render(
        <TestProviders>
          <LiveCrossSectionDraftEditor />
        </TestProviders>,
      );
    try {
      await act(async () => render());
      await act(async () => {
        mocks.kernel = {
          ...(mocks.kernel as KernelApi),
          authoringHistory: {
            getGeneration: () => mocks.historyGeneration,
          },
        } as unknown as KernelApi;
        render();
      });
      await act(async () => {
        findButton(container, "Apply monitor").click();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mocks.create).toHaveBeenCalledOnce();

      await act(async () => {
        mocks.historyGeneration += 1;
        mocks.currentSessionScopeKey = "session=B&epoch=2&request_scope_epoch=2";
        mocks.sessionIdentity = {
          sessionId: "B",
          sessionEpoch: "2",
          requestScopeEpoch: "2",
        };
        render();
      });
      await act(async () => {
        mocks.historyGeneration += 1;
        mocks.currentSessionScopeKey = sessionAScopeKey;
        mocks.sessionIdentity = sessionA;
        render();
      });

      await act(async () => {
        finishCreate?.({
          monitor: { id: "monitor-a", name: draft.name },
          scene_revision: 8,
        });
        await createResult;
      });

      expect(crossSectionWorkspaceStore.getSnapshot().draft).toBe(submittedDraft);
      expect(mocks.create).toHaveBeenCalledOnce();
      expect(mocks.queuePatch).not.toHaveBeenCalled();
      expect(mocks.setSelection).not.toHaveBeenCalled();
      expect(mocks.setActiveViewportMainModule).not.toHaveBeenCalled();
      expect(mocks.invalidate).not.toHaveBeenCalled();
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

function findInput(root: TestNode, label: string): TestElement {
  const input = findElements(
    root,
    (element) =>
      element.tagName === "INPUT" && element.getAttribute("aria-label") === label,
  )[0];
  if (!input) throw new Error(`Missing input ${label}`);
  return input;
}

function editInput(input: TestElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new TestEvent("input", { bubbles: true }));
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
