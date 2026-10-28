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
    objects: [] as Array<{ id: string; absorbing_boundary?: unknown }>,
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
    useSceneResource: () => ({ data: mocks.sceneData, status: "ready" }),
  };
});

import { createInspectorEditSessionStore, InspectorEditSessionProvider, type InspectorEditSessionStore } from "../InspectorEditSession";
import { InspectorFooter } from "../InspectorFooter";
import { shouldGuardInspectorSelection } from "../InspectorDirtySelectionGuard";
import { ObjectMaterialPanelEditSessionBridge } from "./ObjectMaterialPanelEditSessionBridge";
import { ObjectAbsorbingBoundaryPanel } from "./ObjectAbsorbingBoundaryPanel";
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
          baseRevision={10}
          mutationCoordinator={mutationCoordinator}
          mutationScopeKey={mutationScopeKey}
        />
      </InspectorEditSessionProvider>
    </InspectorEditSessionProvider>
  );
}

describe("ObjectAbsorbingBoundaryPanel session fence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionScopeKey.mockReturnValue("session=A&epoch=1");
    mocks.historyGeneration = 0;
    mocks.sceneData = { objects: [{ id: "object-a" }], revision: 10 };
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

  it("routes a child-only draft through the global Footer and selection guard", async () => {
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

      const totalWidth = findControl(container, "Total width");
      totalWidth.value = "5e-7";
      await act(async () => totalWidth.dispatchEvent(new TestEvent("input", { bubbles: true })));

      expect(parentStore.getCurrentSession()?.dirty).toBe(true);
      expect(boundaryStore.getCurrentSession()?.dirty).toBe(true);
      expect(shouldGuardInspectorSelection(parentStore.getCurrentSession())).toBe(true);
      expect(findButton(container, "Apply").disabled).toBe(false);
      await act(async () => findButton(container, "Apply").click());

      expect(mocks.patchObject).toHaveBeenCalledOnce();
      expect(materialApply).not.toHaveBeenCalled();
      expect(parentStore.getCurrentSession()?.dirty).toBe(false);
      expect(shouldGuardInspectorSelection(parentStore.getCurrentSession())).toBe(false);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("blocks global Apply for two dirty drafts, then routes each after the other ACKs", async () => {
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

      const totalWidth = findControl(container, "Total width");
      totalWidth.value = "5e-7";
      await act(async () => totalWidth.dispatchEvent(new TestEvent("input", { bubbles: true })));

      const combined = parentStore.getCurrentSession();
      expect(combined?.dirty).toBe(true);
      expect(combined?.valid).toBe(true);
      expect(combined?.applyBlockReason).toContain("separate server writes");
      expect(shouldGuardInspectorSelection(combined)).toBe(true);
      expect(findButton(container, "Apply").disabled).toBe(true);
      expect(container.textContent).toContain("Apply or revert one draft");
      expect(materialApply).not.toHaveBeenCalled();
      expect(mocks.patchObject).not.toHaveBeenCalled();

      await act(async () => findButton(container, "Apply boundary").click());
      expect(mocks.patchObject).toHaveBeenCalledOnce();
      expect(materialApply).not.toHaveBeenCalled();
      expect(parentStore.getCurrentSession()?.dirty).toBe(true);
      expect(parentStore.getCurrentSession()?.applyBlockReason).toBeUndefined();
      expect(findButton(container, "Apply").disabled).toBe(false);

      await act(async () => findButton(container, "Apply").click());
      expect(materialApply).toHaveBeenCalledOnce();
      expect(mocks.patchObject).toHaveBeenCalledOnce();
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
        <ObjectAbsorbingBoundaryPanel objectId="object-a" baseRevision={10} />,
      ));
      await act(async () => findButton(container, "Apply boundary").click());

      expect(mocks.readScene).toHaveBeenCalledWith({
        sessionScopeKey: "session=A&epoch=1",
      });
      expect(mocks.patchObject).toHaveBeenCalledWith(
        "object-a",
        { base_revision: 10, absorbing_boundary: null },
        { baseRevision: 10, sessionScopeKey: "session=A&epoch=1" },
      );
      expect(mocks.recordHistory).toHaveBeenCalledOnce();
      expect(mocks.invalidate).toHaveBeenCalledWith(expect.any(String), 11);
      expect(container.textContent).toContain("Absorbing boundary updated.");
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
        <ObjectAbsorbingBoundaryPanel objectId="object-a" baseRevision={10} />,
      ));
      await act(async () => {
        findButton(container, "Apply boundary").click();
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
        <ObjectAbsorbingBoundaryPanel objectId="object-a" baseRevision={10} />,
      ));
      const totalWidth = findControl(container, "Total width");
      totalWidth.value = "5e-7";
      await act(async () => totalWidth.dispatchEvent(new TestEvent("input", { bubbles: true })));
      await act(async () => {
        findButton(container, "Apply boundary").click();
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

      await act(async () => {
        finishPatch?.({
          committed_scene: {
            objects: [{
              id: "object-a",
              absorbing_boundary: {
                total_width_m: 5e-7,
                ramp_width_m: 3e-7,
                max_damping: 0.5,
                faces: ["x+"],
                profile: "smootherstep",
                frame: "universe",
              },
            }],
            revision: 11,
            scene_revision: 11,
          },
          revision: 11,
          scene_revision: 11,
        });
        await patchResult;
      });

      expect(findControl(container, "Total width").value).toBe("5e-7");
      expect(findControl(container, "Ramp width").value).toBe("2e-7");
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
        <ObjectAbsorbingBoundaryPanel objectId="object-a" baseRevision={10} />,
      ));
      await act(async () => findButton(container, "Apply boundary").click());

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
