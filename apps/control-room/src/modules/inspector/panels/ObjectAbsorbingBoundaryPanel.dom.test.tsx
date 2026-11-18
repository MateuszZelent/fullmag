import { MESHING_SHARED_DOMAIN_MANIFEST_PATH } from "@/kernel/api/apiPaths";
import { act, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  installSimulationPreparationTestDom,
  TestElement,
  TestEvent,
  TestNode,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

const mocks = vi.hoisted(() => ({
  getSessionScopeKey: vi.fn(() => "session=A&epoch=1" as string | null),
  historyGeneration: 0,
  invalidate: vi.fn(),
  patchObject: vi.fn(),
  readScene: vi.fn(),
  recordHistory: vi.fn(),
  sceneData: {
    objects: [] as Array<{ id: string; absorbing_boundary?: Record<string, unknown> }>,
    revision: 10,
  },
}));

vi.mock("@/kernel/KernelContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/kernel/KernelContext")>();
  return {
    ...actual,
    useKernel: () => ({
    api: {
      model: {
        patchObject: mocks.patchObject,
        scene: mocks.readScene,
      },
    },
    authoringHistory: {
      getGeneration: () => mocks.historyGeneration,
      record: mocks.recordHistory,
    },
    commands: { getSessionScopeKey: mocks.getSessionScopeKey },
    resources: { invalidate: mocks.invalidate },
  }),
  };
});

vi.mock("@/kernel/resources/geometryLifecycleResources", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("@/kernel/resources/geometryLifecycleResources")
  >();
  return {
    ...original,
    useSceneResource: () => ({ data: mocks.sceneData, status: "ready", sessionScopeKey: "session=A&epoch=1" }),
  };
});

import { createInspectorEditSessionStore, InspectorEditSessionProvider, type InspectorEditSessionStore } from "../InspectorEditSession";
import { InspectorFooter } from "../InspectorFooter";
import { shouldGuardInspectorSelection } from "../InspectorDirtySelectionGuard";
import { ObjectMaterialPanelEditSessionBridge } from "./ObjectMaterialPanelEditSessionBridge";
import { ObjectAbsorbingBoundaryInspectorPanel, ObjectAbsorbingBoundaryPanel } from "./ObjectAbsorbingBoundaryPanel";
import { createObjectMaterialMutationCoordinator } from "./ObjectMaterialPanelEditSession";

function ObjectMaterialCompositionHarness({
  boundaryStore,
  materialApply,
  materialDirty,
  parentStore,
}: {
  boundaryStore: InspectorEditSessionStore;
  materialApply: () => Promise<boolean>;
  materialDirty: boolean;
  parentStore: InspectorEditSessionStore;
}) {
  const [mutationCoordinator] = useState(createObjectMaterialMutationCoordinator);
  const mutationScopeKey = "session=A&epoch=1|object-a";
  return (
    <InspectorEditSessionProvider store={parentStore}>
      <ObjectMaterialPanelEditSessionBridge
        absorbingBoundaryEditSessionStore={boundaryStore}
        materialSession={{
          apply: materialApply,
          applying: false,
          dirty: materialDirty,
          mode: "staged",
          reset: () => undefined,
          valid: true,
        }}
        mutationCoordinator={mutationCoordinator}
        mutationScopeKey={mutationScopeKey}
      />
      <InspectorFooter onFocus={() => undefined} />
      <InspectorEditSessionProvider store={boundaryStore}>
        <ObjectAbsorbingBoundaryPanel
          objectId="object-a"
          scene={mocks.sceneData}
          view="activation"
          sessionScopeKey="session=A&epoch=1"
          mutationCoordinator={mutationCoordinator}
        />
      </InspectorEditSessionProvider>
    </InspectorEditSessionProvider>
  );
}

function BoundaryEditorHarness() {
  const [store] = useState(createInspectorEditSessionStore);
  return (
    <InspectorEditSessionProvider store={store}>
      <ObjectAbsorbingBoundaryInspectorPanel selection={{
        kind: "object.absorbing-boundary",
        label: "Absorbing Boundary",
        moduleSource: "explorer",
        nodeId: "model:object:object-a:magnetic-parameters:absorbing-boundary",
        objectId: "object-a",
        ref: null,
      }} />
      <InspectorFooter onFocus={() => undefined} />
    </InspectorEditSessionProvider>
  );
}

function setActivation(container: TestNode, checked: boolean) {
  const checkbox = findControl(container, "Absorbing Boundary");
  Object.assign(checkbox, { checked });
  checkbox.click();
}

function editWidth(container: TestNode) {
  const field = findControl(container, "Total width");
  field.value = "5e-7";
  field.dispatchEvent(new TestEvent("input", { bubbles: true }));
}

describe("ObjectAbsorbingBoundaryPanel session fence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionScopeKey.mockReturnValue("session=A&epoch=1");
    mocks.historyGeneration = 0;
    mocks.sceneData = {
      objects: [{
        id: "object-a",
        absorbing_boundary: {
          total_width_m: 4e-7,
          ramp_width_m: 3e-7,
          max_damping: 0.6,
          faces: ["y-"],
          profile: "custom",
          expression: "u**2",
          frame: "universe",
        },
      }],
      revision: 10,
    };
    mocks.readScene.mockResolvedValue({
      objects: [{ id: "object-a" }],
      revision: 10,
      scene_revision: 10,
    });
    mocks.patchObject.mockResolvedValue({
      committed_scene: {
        objects: [{ id: "object-a" }],
        revision: 11,
        scene_revision: 11,
      },
      revision: 11,
      scene_revision: 11,
    });
  });

  it("activates a new boundary with a valid initial face through the global footer", async () => {
    mocks.sceneData = { objects: [{ id: "object-a" }], revision: 10 };
    const parentStore = createInspectorEditSessionStore();
    const boundaryStore = createInspectorEditSessionStore();
    const materialApply = vi.fn(async () => true);
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <ObjectMaterialCompositionHarness
          boundaryStore={boundaryStore}
          materialApply={materialApply}
          materialDirty={false}
          parentStore={parentStore}
        />,
      ));

      expect(() => findControl(container, "Total width")).toThrow();
      await act(async () => setActivation(container, true));

      expect(parentStore.getCurrentSession()?.dirty).toBe(true);
      expect(boundaryStore.getCurrentSession()?.dirty).toBe(true);
      expect(shouldGuardInspectorSelection(parentStore.getCurrentSession())).toBe(true);
      expect(findButton(container, "Apply").disabled).toBe(false);
      await act(async () => findButton(container, "Apply").click());

      expect(mocks.patchObject).toHaveBeenCalledOnce();
      expect(mocks.patchObject.mock.calls[0][1].absorbing_boundary).toMatchObject({
        faces: ["x+"], profile: "smootherstep", frame: "object",
      });
      expect(materialApply).not.toHaveBeenCalled();
      expect(parentStore.getCurrentSession()?.dirty).toBe(false);
      expect(shouldGuardInspectorSelection(parentStore.getCurrentSession())).toBe(false);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("blocks global Apply for two dirty drafts until activation returns to its saved state", async () => {
    const parentStore = createInspectorEditSessionStore();
    const boundaryStore = createInspectorEditSessionStore();
    const materialApply = vi.fn(async () => true);
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <ObjectMaterialCompositionHarness
          boundaryStore={boundaryStore}
          materialApply={materialApply}
          materialDirty
          parentStore={parentStore}
        />,
      ));

      await act(async () => setActivation(container, false));

      const combined = parentStore.getCurrentSession();
      expect(combined?.dirty).toBe(true);
      expect(combined?.valid).toBe(true);
      expect(combined?.applyBlockReason).toContain("separate server writes");
      expect(shouldGuardInspectorSelection(combined)).toBe(true);
      expect(findButton(container, "Apply").disabled).toBe(true);
      expect(container.textContent).toContain("Apply or revert one draft");
      expect(materialApply).not.toHaveBeenCalled();
      expect(mocks.patchObject).not.toHaveBeenCalled();

      await act(async () => setActivation(container, true));
      expect(parentStore.getCurrentSession()?.dirty).toBe(true);
      expect(parentStore.getCurrentSession()?.applyBlockReason).toBeUndefined();
      expect(findButton(container, "Apply").disabled).toBe(false);
      await act(async () => findButton(container, "Apply").click());
      expect(materialApply).toHaveBeenCalledOnce();
      expect(mocks.patchObject).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("pins the revisioned write and history read to the active session", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <BoundaryEditorHarness />,
      ));
      await act(async () => editWidth(container));
      await act(async () => findButton(container, "Apply").click());

      expect(mocks.readScene).toHaveBeenCalledWith({
        sessionScopeKey: "session=A&epoch=1",
      });
      expect(mocks.patchObject).toHaveBeenCalledWith(
        "object-a",
        {
          base_revision: 10,
          absorbing_boundary: {
            ...mocks.sceneData.objects[0].absorbing_boundary,
            total_width_m: 5e-7,
          },
        },
        { baseRevision: 10, sessionScopeKey: "session=A&epoch=1" },
      );
      expect(mocks.recordHistory).toHaveBeenCalledOnce();
      expect(mocks.invalidate).toHaveBeenCalledWith(expect.any(String), 11);
      expect(mocks.invalidate).toHaveBeenCalledWith(MESHING_SHARED_DOMAIN_MANIFEST_PATH, "scene:11");
      expect(container.textContent).toContain("Absorbing boundary updated.");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("rejects a draft from a previous resource session before reading history or submitting", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<BoundaryEditorHarness />));
      await act(async () => editWidth(container));
      mocks.getSessionScopeKey.mockReturnValue("session=B&epoch=2");
      await act(async () => findButton(container, "Apply").click());
      expect(mocks.readScene).not.toHaveBeenCalled();
      expect(mocks.patchObject).not.toHaveBeenCalled();
      expect(mocks.recordHistory).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("cancels the write when the session changes during its history read", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<BoundaryEditorHarness />));
      await act(async () => editWidth(container));
      mocks.readScene.mockImplementationOnce(async () => {
        mocks.getSessionScopeKey.mockReturnValue("session=B&epoch=2");
        return mocks.sceneData;
      });
      await act(async () => findButton(container, "Apply").click());
      expect(mocks.readScene).toHaveBeenCalledWith({ sessionScopeKey: "session=A&epoch=1" });
      expect(mocks.patchObject).not.toHaveBeenCalled();
      expect(mocks.invalidate).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("does not publish history or resource effects after the session changes before ACK", async () => {
    let finishPatch: ((value: unknown) => void) | null = null;
    const patchResult = new Promise((resolve) => {
      finishPatch = resolve;
    });
    mocks.patchObject.mockReturnValue(patchResult);
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <BoundaryEditorHarness />,
      ));
      await act(async () => editWidth(container));
      await act(async () => {
        findButton(container, "Apply").click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mocks.patchObject).toHaveBeenCalledWith(
        "object-a",
        expect.objectContaining({ base_revision: 10 }),
        expect.objectContaining({ sessionScopeKey: "session=A&epoch=1" }),
      );
      mocks.getSessionScopeKey.mockReturnValue("session=B&epoch=2");
      mocks.historyGeneration += 1;
      await act(async () => {
        finishPatch?.({
          committed_scene: {
            objects: [{ id: "object-a" }],
            revision: 11,
            scene_revision: 11,
          },
          revision: 11,
          scene_revision: 11,
        });
        await patchResult;
      });

      expect(mocks.recordHistory).not.toHaveBeenCalled();
      expect(mocks.invalidate).not.toHaveBeenCalled();
      expect(container.textContent).not.toContain("Absorbing boundary updated.");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("keeps edits made during a pending write after acknowledging its submitted draft", async () => {
    let finishPatch: ((value: unknown) => void) | null = null;
    const patchResult = new Promise((resolve) => {
      finishPatch = resolve;
    });
    mocks.patchObject.mockReturnValue(patchResult);
    mocks.sceneData = {
      objects: [{
        id: "object-a",
        absorbing_boundary: {
          total_width_m: 4e-7,
          ramp_width_m: 3e-7,
          max_damping: 0.5,
          faces: ["x+"],
          profile: "smootherstep",
          frame: "universe",
        },
      }],
      revision: 10,
    };
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <BoundaryEditorHarness />,
      ));
      const totalWidth = findControl(container, "Total width");
      totalWidth.value = "5.00e-7";
      await act(async () => totalWidth.dispatchEvent(new TestEvent("input", { bubbles: true })));
      await act(async () => {
        findButton(container, "Apply").click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mocks.patchObject).toHaveBeenCalledWith(
        "object-a",
        expect.objectContaining({
          absorbing_boundary: expect.objectContaining({ total_width_m: 5e-7 }),
        }),
        expect.any(Object),
      );
      const rampWidth = findControl(container, "Ramp width");
      rampWidth.value = "2e-7";
      await act(async () => rampWidth.dispatchEvent(new TestEvent("input", { bubbles: true })));

      const committed = {
        objects: [{
          id: "object-a",
          absorbing_boundary: {
            ...mocks.sceneData.objects[0].absorbing_boundary as Record<string, unknown>,
            total_width_m: 5e-7,
          },
        }],
        revision: 11,
      };
      await act(async () => {
        finishPatch?.(committed);
        await patchResult;
      });
      mocks.sceneData = committed;
      await act(async () => root.render(
        <BoundaryEditorHarness />,
      ));

      expect(findControl(container, "Total width").value).toBe("5e-7");
      expect(findControl(container, "Ramp width").value).toBe("2e-7");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("identifies the invalid width while the footer blocks Apply", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<BoundaryEditorHarness />));
      const ramp = findControl(container, "Ramp width");
      ramp.value = "6e-7";
      await act(async () => ramp.dispatchEvent(new TestEvent("input", { bubbles: true })));
      expect(findButton(container, "Apply").disabled).toBe(true);
      expect(container.textContent).toContain("Ramp width must be positive and no greater than total width.");
      expect(ramp.getAttribute("aria-invalid")).toBe("true");
      expect(mocks.patchObject).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("preserves a child draft when the history read observes a newer boundary configuration", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<BoundaryEditorHarness />));
      await act(async () => editWidth(container));
      mocks.readScene.mockResolvedValue({ revision: 11, objects: [{ id: "object-a" }] });
      await act(async () => findButton(container, "Apply").click());
      expect(mocks.patchObject).not.toHaveBeenCalled();
      expect(mocks.recordHistory).not.toHaveBeenCalled();
      expect(container.textContent).toContain("Absorbing boundary changed");
      expect(findControl(container, "Total width").value).toBe("5e-7");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("shows saved settings in the dedicated editor and drops the edit session when disabled externally", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<BoundaryEditorHarness />));
      expect(findControl(container, "Expression").value).toBe("u**2");
      expect(findControl(container, "Maximum damping").value).toBe("0.6");
      expect(findControl(container, "y-")).toHaveProperty("checked", true);
      expect(findButton(container, "Apply").disabled).toBe(true);
      expect(() => findControl(container, "Absorbing Boundary")).toThrow();
      await act(async () => editWidth(container));
      mocks.sceneData = { objects: [{ id: "object-a" }], revision: 11 };
      await act(async () => root.render(<BoundaryEditorHarness />));
      expect(container.textContent).toContain("No absorbing boundary is active");
      expect(() => findButton(container, "Apply")).toThrow();
      expect(mocks.patchObject).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("fails closed until the active session identity is available", async () => {
    mocks.getSessionScopeKey.mockReturnValue(null);
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <BoundaryEditorHarness />,
      ));
      await act(async () => editWidth(container));
      await act(async () => findButton(container, "Apply").click());

      expect(mocks.readScene).not.toHaveBeenCalled();
      expect(mocks.patchObject).not.toHaveBeenCalled();
      expect(container.textContent).toContain("Session identity is not ready");
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
  const control = findElements(
    root,
    (element) => element.getAttribute("aria-label") === label,
  )[0];
  if (!control) throw new Error(`Missing control ${label}`);
  return control;
}

function findElements(
  root: TestNode,
  predicate: (element: TestElement) => boolean,
): TestElement[] {
  const found: TestElement[] = [];
  const visit = (node: TestNode): void => {
    if (node instanceof TestElement && predicate(node)) found.push(node);
    for (const child of node.childNodes) visit(child);
  };
  visit(root);
  return found;
}
