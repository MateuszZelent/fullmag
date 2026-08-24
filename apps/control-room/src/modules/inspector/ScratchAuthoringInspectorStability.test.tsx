import { act } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AuthoringTransactionResponse,
  SceneResource,
} from "@/kernel/api/apiTypes";
import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { KernelContext } from "@/kernel/KernelContext";
import { DiagnosticRecorderController } from "@/kernel/performance/diagnostic-recorder/DiagnosticRecorderController";
import { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
import {
  resetSharedResourceRuntimeStoreForTests,
  sharedResourceRuntimeStore,
} from "@/kernel/resources/ResourceRuntimeStore";
import { resolveMaterialResourceKey } from "@/kernel/resources/geometryLifecycleResources";
import { SESSION_STATUS_RESOURCE_KEY } from "@/kernel/resources/useSessionStatus";
import type { KernelApi } from "@/kernel/types";
import type { Selection } from "@/kernel/selection/selectionTypes";
import {
  findElement,
  findElements,
  installSimulationPreparationTestDom,
  TestElement,
  TestEvent,
  type TestNode,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

import { ObjectMaterialPanel } from "./panels/ObjectMaterialPanel";

const SESSION_STATUS = {
  resources: { scene_revision: 21 },
  session: { session_id: "scratch-session", session_epoch: "scratch-session@1" },
} as never;

interface Fixture {
  createMaterial: ReturnType<typeof vi.fn>;
  interactionLoad: ReturnType<typeof vi.fn>;
  invalidate: ReturnType<typeof vi.spyOn>;
  kernel: KernelApi;
  materialLoad: ReturnType<typeof vi.fn>;
  patchObject: ReturnType<typeof vi.fn>;
  resources: ResourceInvalidationController;
  sceneLoad: ReturnType<typeof vi.fn>;
  statusLoad: ReturnType<typeof vi.fn>;
}

const selectionA: Selection = {
  kind: "object.magnetic-parameters",
  label: "Object A",
  moduleSource: "inspector",
  nodeId: "object:object-a:magnetic-parameters",
  objectId: "object-a",
  ref: null,
};

const selectionB: Selection = {
  ...selectionA,
  label: "Object B",
  nodeId: "object:object-b:magnetic-parameters",
  objectId: "object-b",
};

describe("scratch material Inspector stability", () => {
  beforeEach(() => {
    resetSharedResourceRuntimeStoreForTests();
  });

  afterEach(() => {
    resetSharedResourceRuntimeStoreForTests();
    vi.useRealTimers();
  });

  it("hydrates with production resource hooks and keeps root, focus, scroll, drafts and requests bounded across both ACKs", async () => {
    let resolveAssignment!: (value: SceneResource) => void;
    const fixture = createFixture();
    fixture.createMaterial.mockResolvedValue(createdMaterialAck());
    fixture.patchObject.mockImplementation(
      () => new Promise<SceneResource>((resolve) => {
        resolveAssignment = resolve;
      }),
    );
    const mounted = await mountFixture(fixture, selectionA);
    try {
      expect(mounted.consoleError.mock.calls.flat().join(" ")).not.toContain("hydration");
      await waitForText(mounted.container, "object-a");

      const panelRoot = mounted.container.querySelector(".fm-inspector-panel");
      if (!panelRoot) throw new Error("Object Inspector root missing");
      panelRoot.scrollTop = 73;
      const nameInput = input(mounted.container, "New material name");
      nameInput.focus();
      await act(async () => {
        changeInput(nameInput, "CoFeB");
        changeInput(input(mounted.container, "New material ID"), "mat:cofeb");
        changeInput(input(mounted.container, "New Ms"), "1.1e6");
        changeInput(input(mounted.container, "New A"), "1.3e-11");
        changeInput(input(mounted.container, "New Ku1"), "4e5");
      });
      await act(async () => {
        changeInput(input(mounted.container, "New anisotropy axis X"), "1");
      });
      expect(input(mounted.container, "New Ku1").value).toBe("4e5");
      expect(input(mounted.container, "New anisotropy axis X").disabled).toBe(false);
      expect(input(mounted.container, "New anisotropy axis X").value).toBe("1");

      await act(async () => {
        button(mounted.container, "Create and assign").click();
        await Promise.resolve();
      });
      expect(fixture.createMaterial).toHaveBeenCalledOnce();
      expect(fixture.patchObject).toHaveBeenCalledWith("object-a", {
        base_revision: 22,
        material_ref: "mat:cofeb",
      });
      expect(mounted.container.querySelector(".fm-inspector-panel") === panelRoot).toBe(true);
      expect(mounted.document.activeElement === nameInput).toBe(true);
      expect(panelRoot.scrollTop).toBe(73);
      expect(button(mounted.container, "Create and assign").disabled).toBe(true);

      await act(async () => {
        resolveAssignment(assignedScene(23, "mat:cofeb"));
        await Promise.resolve();
      });
      expect(mounted.container.querySelector(".fm-inspector-panel") === panelRoot).toBe(true);
      expect(mounted.document.activeElement === nameInput).toBe(true);
      expect(panelRoot.scrollTop).toBe(73);
      expect(input(mounted.container, "New anisotropy axis X").value).toBe("1");
      expect(mounted.container.textContent).toContain("Ku1 draft is ready");

      const invalidationCounts = new Map<string, number>();
      for (const [resourceKey] of fixture.invalidate.mock.calls as [string, unknown][]) {
        invalidationCounts.set(resourceKey, (invalidationCounts.get(resourceKey) ?? 0) + 1);
      }
      expect(invalidationCounts.get(MODEL_SCENE_PATH)).toBe(2);
      expect(invalidationCounts.get(SESSION_STATUS_RESOURCE_KEY)).toBe(2);
      expect(Math.max(...invalidationCounts.values())).toBeLessThanOrEqual(2);
      expect([...invalidationCounts.keys()].join(" ")).not.toContain("topology");
      expect(resolveMaterialResourceKey("mat:cofeb")).toBeDefined();
      expect(sharedResourceRuntimeStore.stats().listenerCount).toBeLessThanOrEqual(8);
      expect(findElements(mounted.container, (element) => {
        const className = element.getAttribute("class") ?? "";
        return className.includes("animate-opacity") ||
          className.includes("transition-opacity") ||
          (element.getAttribute("style") ?? "").includes("opacity");
      }).length).toBe(0);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps invalid SI edits local and never retries a conflict from stale A after A→B→A", async () => {
    const fixture = createFixture();
    fixture.createMaterial.mockResolvedValue(createdMaterialAck("mat:free-layer"));
    fixture.patchObject.mockRejectedValueOnce(new Error("revision conflict"));
    const mounted = await mountFixture(fixture, selectionA);
    try {
      await waitForText(mounted.container, "object-a");
      await act(async () => changeInput(input(mounted.container, "New Ms"), "0"));
      await act(async () => {
        changeInput(input(mounted.container, "New material ID"), "mat:free-layer");
      });
      await act(async () => button(mounted.container, "Create and assign").click());
      expect(fixture.createMaterial).not.toHaveBeenCalled();
      expect(mounted.container.textContent).toContain("Ms must be greater than 0 A/m.");

      await act(async () => changeInput(input(mounted.container, "New Ms"), "8e5"));
      await act(async () => button(mounted.container, "Create and assign").click());
      expect(fixture.createMaterial).toHaveBeenCalledOnce();
      expect(mounted.container.textContent).toContain("assignment failed");
      const staleRetry = button(mounted.container, "Retry assignment");
      expect(button(mounted.container, "Create and assign").disabled).toBe(true);

      await act(async () => {
        mounted.root.render(
          <KernelContext.Provider value={fixture.kernel}>
            <ObjectMaterialPanel selection={selectionB} />
          </KernelContext.Provider>,
        );
        await Promise.resolve();
      });
      expect(mounted.container.textContent).toContain("object-b");
      expect(mounted.container.textContent).not.toContain("assignment failed");

      await act(async () => {
        mounted.root.render(
          <KernelContext.Provider value={fixture.kernel}>
            <ObjectMaterialPanel selection={selectionA} />
          </KernelContext.Provider>,
        );
        await Promise.resolve();
      });
      expect(mounted.container.textContent).toContain("object-a");
      expect(mounted.container.textContent).not.toContain("Retry assignment");
      staleRetry.click();
      expect(fixture.patchObject).toHaveBeenCalledOnce();
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not unlock Rebase before a real loading/stale→ready refetch and preserves the created material after conflict", async () => {
    const fixture = createFixture();
    const refreshedScene = deferred<SceneResource>();
    fixture.sceneLoad
      .mockResolvedValueOnce(scene(21))
      .mockImplementationOnce(() => refreshedScene.promise);
    fixture.createMaterial.mockResolvedValue(createdMaterialAck("mat:free-layer"));
    fixture.patchObject
      .mockRejectedValueOnce(new Error("revision conflict"))
      .mockResolvedValueOnce(assignedScene(25, "mat:free-layer"));
    const mounted = await mountFixture(fixture, selectionA);
    try {
      await waitForText(mounted.container, "object-a");
      await act(async () => {
        changeInput(input(mounted.container, "New material ID"), "mat:free-layer");
      });
      await act(async () => button(mounted.container, "Create and assign").click());
      expect(fixture.createMaterial).toHaveBeenCalledOnce();
      expect(button(mounted.container, "Create and assign").disabled).toBe(true);
      expect(button(mounted.container, "Rebase assignment").disabled).toBe(true);

      await act(async () => button(mounted.container, "Refresh scene").click());
      await act(async () => {
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(fixture.sceneLoad).toHaveBeenCalledTimes(2);
      expect(button(mounted.container, "Rebase assignment").disabled).toBe(true);
      refreshedScene.resolve(scene(24));
      await flushResource();
      expect(button(mounted.container, "Rebase assignment").disabled).toBe(false);

      await act(async () => button(mounted.container, "Rebase assignment").click());
      expect(button(mounted.container, "Retry assignment").disabled).toBe(false);
      await act(async () => button(mounted.container, "Retry assignment").click());
      expect(fixture.createMaterial).toHaveBeenCalledOnce();
      expect(fixture.patchObject).toHaveBeenCalledTimes(2);
      expect(fixture.patchObject).toHaveBeenLastCalledWith("object-a", {
        base_revision: 24,
        material_ref: "mat:free-layer",
      });
    } finally {
      await mounted.cleanup();
    }
  });
});

function createFixture(): Fixture {
  const bus = new EventBus<KernelEventMap>();
  const resources = new ResourceInvalidationController(bus);
  const sceneLoad = vi.fn().mockResolvedValue(scene(21));
  const statusLoad = vi.fn().mockResolvedValue(SESSION_STATUS);
  const materialLoad = vi.fn().mockResolvedValue(null);
  const interactionLoad = vi.fn().mockResolvedValue({
    enabled: false,
    interaction_kind: "uniaxial_anisotropy",
    object_id: "object-a",
    params: {},
    present: false,
    scene_revision: 21,
  });
  const createMaterial = vi.fn();
  const patchObject = vi.fn();
  const patchObjectInteraction = vi.fn().mockResolvedValue({ scene_revision: 22 });
  const patchMaterial = vi.fn().mockResolvedValue({ scene_revision: 22 });
  const invalidate = vi.spyOn(resources, "invalidate");
  const kernel = {
    api: {
      model: {
        createMaterial,
        material: materialLoad,
        objectInteraction: interactionLoad,
        patchMaterial,
        patchObject,
        patchObjectInteraction,
        scene: sceneLoad,
      },
      sessions: { current: { status: statusLoad } },
    },
    bus,
    diagnosticRecorder: new DiagnosticRecorderController({ config: { enabled: false } }),
    resources,
  } as unknown as KernelApi;
  return {
    createMaterial,
    interactionLoad,
    invalidate,
    kernel,
    materialLoad,
    patchObject,
    resources,
    sceneLoad,
    statusLoad,
  };
}

async function mountFixture(fixture: Fixture, selection: Selection) {
  const serverHtml = renderToString(
    <KernelContext.Provider value={fixture.kernel}>
      <ObjectMaterialPanel selection={selection} />
    </KernelContext.Provider>,
  );
  const dom = installSimulationPreparationTestDom();
  const container = dom.document.createElement("div");
  container.innerHTML = serverHtml;
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  let root!: Root;
  await act(async () => {
    root = hydrateRoot(
      container as unknown as Element,
      <KernelContext.Provider value={fixture.kernel}>
        <ObjectMaterialPanel selection={selection} />
      </KernelContext.Provider>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  await flushResource();
  return {
    container,
    consoleError,
    document: dom.document,
    root,
    cleanup: async () => {
      await act(async () => root.unmount());
      consoleError.mockRestore();
      dom.restore();
    },
  };
}

function scene(revision: number): SceneResource {
  return {
    materials: [],
    objects: [
      sceneObject("object-a", "Object A"),
      sceneObject("object-b", "Object B"),
    ],
    revision,
  } as unknown as SceneResource;
}

function sceneObject(id: string, name: string, materialRef: string | null = null) {
  return {
    geometry: { geometry_kind: "Box", geometry_params: { size: [1e-7, 1e-7, 1e-8] } },
    id,
    material_ref: materialRef,
    name,
    transform: { translation: [0, 0, 0] },
  };
}

function createdMaterialAck(materialId = "mat:cofeb"): AuthoringTransactionResponse {
  return {
    committed_scene: {
      ...scene(22),
      materials: [{ id: materialId, name: "CoFeB" }],
      revision: 22,
    },
    scene_revision: 22,
    transaction_kind: "create_material",
  } as unknown as AuthoringTransactionResponse;
}

function assignedScene(revision: number, materialRef: string): SceneResource {
  return {
    ...scene(revision),
    objects: [
      sceneObject("object-a", "Object A", materialRef),
      sceneObject("object-b", "Object B"),
    ],
  } as unknown as SceneResource;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function flushResource(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function waitForText(container: TestNode, text: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (container.textContent.includes(text)) return;
    await flushResource();
  }
  throw new Error(`Expected text ${text} in ${container.textContent}`);
}

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

function changeInput(element: TestElement, value: string, eventName = "input"): void {
  element.value = value;
  element.dispatchEvent(new TestEvent(eventName, { bubbles: true }));
}
