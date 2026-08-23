import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MODEL_READINESS_PATH, MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import {
  findElement,
  findElements,
  installSimulationPreparationTestDom,
  TestElement,
  TestEvent,
  type TestNode,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { SESSION_STATUS_RESOURCE_KEY } from "@/kernel/resources/useSessionStatus";

import { ObjectMaterialPanel } from "./panels/ObjectMaterialPanel";

const mocks = vi.hoisted(() => ({
  createMaterial: vi.fn(),
  invalidate: vi.fn(),
  patchObject: vi.fn(),
  patchObjectInteraction: vi.fn(),
  patchMaterial: vi.fn(),
  publishScene: vi.fn(),
  refetchScene: vi.fn(),
  scene: {
    data: {
      materials: [] as unknown[],
      objects: [{ id: "object-7", material_ref: null, name: "Free layer" }] as unknown[],
      revision: 21,
    },
    error: null,
    revision: 21,
    status: "ready",
  },
}));

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => ({
    api: {
      model: {
        createMaterial: mocks.createMaterial,
        patchMaterial: mocks.patchMaterial,
        patchObject: mocks.patchObject,
        patchObjectInteraction: mocks.patchObjectInteraction,
      },
    },
    resources: { invalidate: mocks.invalidate },
  }),
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/kernel/resources/geometryLifecycleResources")>();
  return {
    ...original,
    publishCommittedSceneResource: mocks.publishScene,
    useMaterialResource: () => ({ data: null, error: null, revision: null, status: "ready" }),
    useObjectInteractionResource: () => ({
      data: { params: {}, present: false, scene_revision: 21 },
      error: null,
      revision: 21,
      status: "ready",
    }),
    useSceneResource: () => ({ ...mocks.scene, refetch: mocks.refetchScene }),
  };
});

const selection: Selection = {
  kind: "object.magnetic-parameters",
  label: "Free layer",
  moduleSource: "inspector",
  nodeId: "object:object-7:magnetic-parameters",
  objectId: "object-7",
  ref: null,
};

describe("scratch material Inspector stability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createMaterial.mockReset();
    mocks.patchObject.mockReset();
    mocks.scene.data = {
      materials: [],
      objects: [{ id: "object-7", material_ref: null, name: "Free layer" }],
      revision: 21,
    };
    mocks.scene.revision = 21;
    mocks.scene.status = "ready";
  });

  it("keeps the Object Inspector root, focus, scroll, and unrelated controls stable through both ACKs", async () => {
    let resolveAssignment!: (value: { objects: unknown[]; revision: number }) => void;
    mocks.createMaterial.mockResolvedValue({
      committed_scene: {
        materials: [{ id: "mat:cofeb", name: "CoFeB" }],
        objects: mocks.scene.data.objects,
        revision: 22,
      },
      scene_revision: 22,
      transaction_kind: "create_material",
    });
    mocks.patchObject.mockImplementation(() => new Promise((resolve) => {
      resolveAssignment = resolve;
    }));
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    let milestone = "initial render";
    try {
      await act(async () => root.render(<ObjectMaterialPanel selection={selection} />));
      const panelRoot = container.querySelector(".fm-inspector-panel");
      if (!panelRoot) throw new Error("Object Inspector root missing");
      panelRoot.scrollTop = 73;
      const nameInput = input(container, "New material name");
      nameInput.focus();
      milestone = "input edits";
      await act(async () => {
        changeInput(nameInput, "CoFeB");
        changeInput(input(container, "New material ID"), "mat:cofeb");
        changeInput(input(container, "New Ms"), "1.1e6");
        changeInput(input(container, "New A"), "1.3e-11");
        changeInput(input(container, "New Ku1"), "4e5");
      });

      milestone = "create ACK and assignment pending";
      await act(async () => {
        button(container, "Create and assign").click();
        await Promise.resolve();
      });

      expect(container.querySelector(".fm-inspector-panel") === panelRoot).toBe(true);
      expect(dom.document.activeElement === nameInput).toBe(true);
      expect(panelRoot.scrollTop).toBe(73);
      expect(button(container, "Create and assign").disabled).toBe(true);
      expect(button(container, "Apply Assignment").disabled).toBe(false);
      expect(button(container, "Apply Anisotropy").disabled).toBe(false);
      expect(button(container, "Revert").disabled).toBe(false);
      expect(mocks.publishScene).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ revision: 22 }),
        22,
        undefined,
        false,
      );

      milestone = "assignment ACK";
      await act(async () => resolveAssignment({
        objects: [{ id: "object-7", material_ref: "mat:cofeb" }],
        revision: 23,
      }));

      expect(container.querySelector(".fm-inspector-panel") === panelRoot).toBe(true);
      expect(dom.document.activeElement === nameInput).toBe(true);
      expect(panelRoot.scrollTop).toBe(73);
      expect(container.textContent).toContain("Ku1 draft is ready; apply anisotropy separately.");
      expect(mocks.createMaterial).toHaveBeenCalledOnce();
      expect(mocks.patchObject).toHaveBeenCalledWith("object-7", {
        base_revision: 22,
        material_ref: "mat:cofeb",
      });
      const invalidationCounts = new Map<string, number>();
      for (const [resourceKey] of mocks.invalidate.mock.calls as [string, unknown][]) {
        invalidationCounts.set(resourceKey, (invalidationCounts.get(resourceKey) ?? 0) + 1);
      }
      expect(invalidationCounts.get(MODEL_SCENE_PATH)).toBe(2);
      expect(invalidationCounts.get(MODEL_READINESS_PATH)).toBe(2);
      expect(invalidationCounts.get(SESSION_STATUS_RESOURCE_KEY)).toBe(2);
      expect(Math.max(...invalidationCounts.values())).toBeLessThanOrEqual(2);
      expect([...invalidationCounts.keys()].join(" ")).not.toContain("topology");
      expect(findElements(container, (element) => {
        const className = element.getAttribute("class") ?? "";
        return className.includes("animate-opacity") ||
          className.includes("transition-opacity") ||
          (element.getAttribute("style") ?? "").includes("opacity");
      }).length).toBe(0);
    } catch (error) {
      throw new Error(
        `Stability failure after ${milestone}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
      );
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("keeps the created material after assignment conflict and requires refetch plus explicit rebase before retry", async () => {
    mocks.createMaterial.mockResolvedValue({
      committed_scene: {
        materials: [{ id: "mat:free-layer", name: "Free layer material" }],
        objects: mocks.scene.data.objects,
        revision: 22,
      },
      scene_revision: 22,
      transaction_kind: "create_material",
    });
    mocks.patchObject
      .mockRejectedValueOnce(new Error("revision conflict"))
      .mockResolvedValueOnce({
        materials: [{ id: "mat:free-layer", name: "Free layer material" }],
        objects: [{ id: "object-7", material_ref: "mat:free-layer" }],
        revision: 25,
      });
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<ObjectMaterialPanel selection={selection} />));
      await act(async () => button(container, "Create and assign").click());

      expect(container.textContent).toContain("Material was created and remains in the library");
      expect(mocks.publishScene).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ revision: 22 }),
        22,
        undefined,
        false,
      );
      expect(button(container, "Rebase assignment").disabled).toBe(true);
      expect(button(container, "Retry assignment").disabled).toBe(true);

      await act(async () => button(container, "Refresh scene").click());
      mocks.scene.data = {
        materials: [{ id: "mat:free-layer", name: "Free layer material" }],
        objects: [{ id: "object-7", material_ref: null, name: "Free layer" }],
        revision: 24,
      };
      mocks.scene.revision = 24;
      await act(async () => root.render(<ObjectMaterialPanel selection={selection} />));
      expect(button(container, "Rebase assignment").disabled).toBe(false);
      await act(async () => button(container, "Rebase assignment").click());
      expect(button(container, "Retry assignment").disabled).toBe(false);
      await act(async () => button(container, "Retry assignment").click());

      expect(mocks.createMaterial).toHaveBeenCalledOnce();
      expect(mocks.patchObject).toHaveBeenCalledTimes(2);
      expect(mocks.patchObject).toHaveBeenLastCalledWith("object-7", {
        base_revision: 24,
        material_ref: "mat:free-layer",
      });
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});

function input(root: TestNode, label: string): TestElement {
  return findElement(
    root,
    (element) => element.tagName === "INPUT" && element.getAttribute("aria-label") === label,
    `input ${label}`,
  );
}

function button(root: TestNode, text: string): TestElement {
  return findElement(
    root,
    (element) => element.tagName === "BUTTON" && element.textContent.includes(text),
    `button ${text}`,
  );
}

function changeInput(element: TestElement, value: string): void {
  element.value = value;
  element.dispatchEvent(new TestEvent("input", { bubbles: true }));
}
