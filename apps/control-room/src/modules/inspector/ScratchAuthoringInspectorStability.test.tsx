import { act, useEffect, useState } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AuthoringTransactionResponse,
  MaterialPropertiesResource,
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
import { SelectionController } from "@/kernel/selection/SelectionController";
import {
  createInspectorEditSessionStore,
  InspectorEditSessionProvider,
  type InspectorEditSessionStore,
} from "./InspectorEditSession";
import { InspectorFooter } from "./InspectorFooter";
import {
  InspectorDirtySelectionGuard,
  shouldGuardInspectorSelection,
} from "./InspectorDirtySelectionGuard";
import {
  findElement,
  findElements,
  installSimulationPreparationTestDom,
  TestElement,
  TestEvent,
  type TestNode,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

import { ObjectMaterialPanel } from "./panels/ObjectMaterialPanel";

// The lightweight test DOM does not implement Radix portals. Keep the guard
// and its buttons real while rendering the dialog inline for this test.
vi.mock("@/shared/ui/Dialog", () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <>{children}</> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <section role="dialog">{children}</section>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

const SESSION_STATUS = {
  resources: { scene_revision: 21 },
  session: { session_id: "scratch-session", session_epoch: "scratch-session@1", request_scope_epoch: "test-api:1" },
} as never;

const SESSION_SCOPE_KEY =
  "session=scratch-session&epoch=scratch-session%401&request_scope_epoch=test-api%3A1";

interface Fixture {
  createMaterial: ReturnType<typeof vi.fn>;
  interactionLoad: ReturnType<typeof vi.fn>;
  invalidate: ReturnType<typeof vi.spyOn>;
  kernel: KernelApi;
  materialLoad: ReturnType<typeof vi.fn>;
  patchMaterialAsset: ReturnType<typeof vi.fn>;
  patchObject: ReturnType<typeof vi.fn>;
  patchObjectInteraction: ReturnType<typeof vi.fn>;
  resources: ResourceInvalidationController;
  selection: SelectionController;
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
    let resolveAssignment: ((value: SceneResource) => void) | null = null;
    const fixture = createFixture();
    fixture.createMaterial.mockResolvedValue(
      createdMaterialAck("mat:cofeb", {
        Aex: 1.3e-11,
        Dbulk: null,
        Dind: null,
        Ms: 1.1e6,
        alpha: 0.01,
      }),
    );
    fixture.patchObject.mockImplementation(
      () => new Promise<SceneResource>((resolve) => {
        resolveAssignment = resolve;
      }),
    );
    const mounted = await mountFixture(fixture, selectionA);
    try {
      expect(mounted.consoleError.mock.calls.flat().join(" ")).not.toContain("hydration");
      await waitForText(mounted.container, "object-a");
      // Session identity is read by several mounted hooks (sessions list +
      // status); the bound below is relative to the mounted baseline so it
      // still catches listeners leaking across the two ACKs.
      const mountedListenerCount = sharedResourceRuntimeStore.stats().listenerCount;

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
      }, { sessionScopeKey: SESSION_SCOPE_KEY });
      expect(mounted.container.querySelector(".fm-inspector-panel") === panelRoot).toBe(true);
      expect(mounted.document.activeElement === nameInput).toBe(true);
      expect(panelRoot.scrollTop).toBe(73);
      expect(button(mounted.container, "Create and assign").disabled).toBe(true);

      await act(async () => {
        if (!resolveAssignment) throw new Error("The assignment request did not start");
        resolveAssignment(assignedScene(23, "mat:cofeb", {
          Aex: 1.3e-11,
          Dbulk: null,
          Dind: null,
          Ms: 1.1e6,
          alpha: 0.01,
        }));
        await Promise.resolve();
      });
      expect(mounted.container.querySelector(".fm-inspector-panel") === panelRoot).toBe(true);
      expect(mounted.document.activeElement === nameInput).toBe(true);
      expect(panelRoot.scrollTop).toBe(73);
      expect(input(mounted.container, "New anisotropy axis X").value).toBe("0");
      expect(Number(input(mounted.container, "Axis X").value)).toBeCloseTo(Math.SQRT1_2);
      expect(Number(input(mounted.container, "Axis Y").value)).toBe(0);
      expect(Number(input(mounted.container, "Axis Z").value)).toBeCloseTo(Math.SQRT1_2);
      expect(mounted.container.textContent).toContain("Ku1 draft is ready");
      expect(findElements(mounted.container, (element) =>
        element.tagName === "INPUT" && ["Ms", "Aex"].includes(element.getAttribute("aria-label") ?? ""),
      )).toHaveLength(0);

      const invalidationCounts = new Map<string, number>();
      for (const [resourceKey] of fixture.invalidate.mock.calls as [string, unknown][]) {
        invalidationCounts.set(resourceKey, (invalidationCounts.get(resourceKey) ?? 0) + 1);
      }
      expect(invalidationCounts.get(MODEL_SCENE_PATH)).toBe(2);
      expect(invalidationCounts.get(SESSION_STATUS_RESOURCE_KEY)).toBe(2);
      expect(Math.max(...invalidationCounts.values())).toBeLessThanOrEqual(2);
      expect([...invalidationCounts.keys()].join(" ")).not.toContain("topology");
      expect(resolveMaterialResourceKey("mat:cofeb")).toBeDefined();
      expect(sharedResourceRuntimeStore.stats().listenerCount)
        .toBeLessThanOrEqual(mountedListenerCount + 1);
      expect(findElements(mounted.container, (element) => {
        const className = element.getAttribute("class") ?? "";
        return className.includes("animate-opacity") ||
          className.includes("transition-opacity") ||
          (element.getAttribute("style") ?? "").includes("opacity");
      }).length).toBe(0);

      // Scalar parameters belong to the Material child, not the assignment
      // child. Navigate only after checking stability through both ACKs.
      await act(async () => {
        mounted.root.render(
          <KernelContext.Provider value={fixture.kernel}>
            <ObjectMaterialPanel selection={{
              ...selectionA,
              kind: "object.material",
              nodeId: "object:object-a:material",
            }} />
          </KernelContext.Provider>,
        );
        await Promise.resolve();
      });
      expect(mounted.container.querySelector(".fm-inspector-panel") === panelRoot).toBe(true);
      expect(input(mounted.container, "Ms").value).toBe("1100000");
      expect(input(mounted.container, "Aex").value).toBe("1.3e-11");
    } finally {
      resolveAssignment?.(assignedScene(23, "mat:cofeb", {
        Aex: 1.3e-11,
        Dbulk: null,
        Dind: null,
        Ms: 1.1e6,
        alpha: 0.01,
      }));
      await flushResource();
      await mounted.cleanup();
    }
  });

  it("blocks global Apply for dirty parameters and anisotropy while separate local actions keep fresh history revisions", async () => {
    const initialProperties = {
      Aex: 1.3e-11,
      Dbulk: null,
      Dind: null,
      Ms: 8e5,
      alpha: 0.01,
    };
    let currentProperties: MaterialPropertiesResource = initialProperties;
    let currentScene = materialScene(21, currentProperties);
    const fixture = createFixture();
    fixture.sceneLoad.mockImplementation(async () => currentScene);
    fixture.materialLoad.mockImplementation(async () => ({
      id: "mat:old",
      name: "Old material",
      properties: currentProperties,
      scene_revision: currentScene.revision,
    }));
    fixture.interactionLoad.mockResolvedValue({
      enabled: true,
      interaction_kind: "uniaxial_anisotropy",
      object_id: "object-a",
      params: { axis: [0, 0, 1], ku1: 3e5 },
      present: true,
      scene_revision: 21,
    });
    const historyRecord = vi.fn();
    Object.assign(fixture.kernel, {
      authoringHistory: {
        getGeneration: () => 0,
        record: historyRecord,
        subscribe: () => () => undefined,
      },
    });
    fixture.patchMaterialAsset.mockImplementation(async (_materialId, patch) => {
      currentProperties = { ...currentProperties, ...patch.properties };
      currentScene = materialScene(22, currentProperties);
      return {
        committed_scene: currentScene,
        scene_revision: 22,
        transaction_kind: "patch_material",
      } as unknown as AuthoringTransactionResponse;
    });
    fixture.patchObjectInteraction.mockImplementation(async () => {
      currentScene = materialScene(23, currentProperties);
      return {
        committed_scene: currentScene,
        scene_revision: 23,
        transaction_kind: "patch_object_interaction",
      } as unknown as AuthoringTransactionResponse;
    });

    const editSessionStore = createInspectorEditSessionStore();
    const mounted = await mountFixture(
      fixture,
      { ...selectionA, kind: "object", nodeId: "object:object-a" },
      { editSessionStore, withFooter: true, withGuard: true },
    );
    try {
      await waitForText(mounted.container, "Old material");
      await act(async () => {
        changeInput(input(mounted.container, "Ms"), "1000000");
        changeInput(input(mounted.container, "Ku1"), "400000");
      });

      const session = editSessionStore.getCurrentSession();
      if (!session) throw new Error("ObjectMaterialPanel did not register its Inspector session");
      expect(session.dirty).toBe(true);
      expect(session.valid).toBe(true);
      expect(session.applyBlockReason).toContain("Apply Parameters and Apply Anisotropy");
      expect(shouldGuardInspectorSelection(session)).toBe(true);
      expect(exactButton(mounted.container, "Apply").disabled).toBe(true);
      expect(exactButton(mounted.container, "Revert").disabled).toBe(false);
      await act(async () => {
        fixture.selection.set({
          kind: selectionB.kind,
          label: selectionB.label,
          nodeId: selectionB.nodeId,
          objectId: selectionB.objectId,
          ref: selectionB.ref,
        }, "test");
      });
      expect(mounted.container.textContent).toContain("Unapplied Inspector changes");
      expect(mounted.container.textContent).toContain("Apply Parameters and Apply Anisotropy");
      expect(exactButton(mounted.container, "Apply and continue").disabled).toBe(true);
      expect(exactButton(mounted.container, "Discard").disabled).toBe(false);
      expect(fixture.selection.get().objectId).toBe("object-a");
      await act(async () => exactButton(mounted.container, "Cancel").click());
      expect(fixture.patchMaterialAsset).not.toHaveBeenCalled();
      expect(fixture.patchObjectInteraction).not.toHaveBeenCalled();
      await act(async () => exactButton(mounted.container, "Apply").click());
      expect(fixture.patchMaterialAsset).not.toHaveBeenCalled();
      expect(fixture.patchObjectInteraction).not.toHaveBeenCalled();

      await act(async () => {
        expect(await session.apply()).toBe(false);
      });
      expect(mounted.container.textContent).toContain(
        "Use Apply Parameters and Apply Anisotropy as separate writes",
      );
      expect(fixture.patchMaterialAsset).not.toHaveBeenCalled();
      expect(fixture.patchObjectInteraction).not.toHaveBeenCalled();

      await act(async () => exactButton(mounted.container, "Apply Parameters").click());
      await flushResource();
      expect(fixture.patchMaterialAsset).toHaveBeenCalledOnce();
      expect(fixture.patchMaterialAsset.mock.calls[0][0]).toBe("mat:old");
      expect(fixture.patchMaterialAsset.mock.calls[0][2]).toMatchObject({
        baseRevision: 21,
        sessionScopeKey: SESSION_SCOPE_KEY,
      });
      expect(historyRecord).toHaveBeenCalledOnce();

      await act(async () => exactButton(mounted.container, "Apply Anisotropy").click());
      await flushResource();
      expect(fixture.patchObjectInteraction).toHaveBeenCalledOnce();
      expect(fixture.patchObjectInteraction.mock.calls[0][2]).toMatchObject({
        base_revision: 22,
        params: { axis: [0, 0, 1], ku1: 400000 },
      });
      expect(historyRecord).toHaveBeenCalledTimes(2);
    } finally {
      await mounted.cleanup();
    }
  });

  it("guards a staged Create and Assign form, blocks implicit global Apply, and Revert clears it", async () => {
    const fixture = createFixture();
    const editSessionStore = createInspectorEditSessionStore();
    const mounted = await mountFixture(
      fixture,
      { ...selectionA, kind: "object", nodeId: "object:object-a" },
      { editSessionStore, withFooter: true, withGuard: true },
    );
    try {
      await waitForText(mounted.container, "object-a");
      await act(async () => changeInput(input(mounted.container, "New material name"), "Unsaved material"));

      const session = editSessionStore.getCurrentSession();
      if (!session) throw new Error("ObjectMaterialPanel did not register its Inspector session");
      expect(session.dirty).toBe(true);
      expect(session.valid).toBe(true);
      expect(session.applyBlockReason).toContain("global Apply does not create materials");
      expect(shouldGuardInspectorSelection(session)).toBe(true);
      expect(exactButton(mounted.container, "Apply").disabled).toBe(true);
      expect(exactButton(mounted.container, "Revert").disabled).toBe(false);
      await act(async () => expect(await session.apply()).toBe(false));
      expect(fixture.createMaterial).not.toHaveBeenCalled();

      await act(async () => {
        fixture.selection.set({
          kind: selectionB.kind,
          label: selectionB.label,
          nodeId: selectionB.nodeId,
          objectId: selectionB.objectId,
          ref: selectionB.ref,
        }, "test");
      });
      expect(mounted.container.textContent).toContain("Unapplied Inspector changes");
      expect(mounted.container.textContent).toContain("Create and assign");
      expect(exactButton(mounted.container, "Discard").disabled).toBe(false);
      await act(async () => exactButton(mounted.container, "Discard").click());
      await waitForText(mounted.container, "object-b");
      expect(fixture.selection.get().objectId).toBe("object-b");
      expect(fixture.createMaterial).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("locks Create and Assign synchronously across global/local writers and rebases edits made while ACK is pending", async () => {
    const fixture = createFixture();
    const createAck = deferred<AuthoringTransactionResponse>();
    const assignmentAck = deferred<SceneResource>();
    fixture.createMaterial.mockReturnValue(createAck.promise);
    fixture.patchObject.mockImplementation(() => assignmentAck.promise);
    const editSessionStore = createInspectorEditSessionStore();
    const mounted = await mountFixture(
      fixture,
      { ...selectionA, kind: "object", nodeId: "object:object-a" },
      { editSessionStore, withFooter: true, withGuard: true },
    );
    let racedGlobalApply: Promise<boolean> | null = null;
    try {
      await waitForText(mounted.container, "object-a");
      await act(async () => {
        changeInput(input(mounted.container, "New material ID"), "mat:cofeb");
        button(mounted.container, "Create and assign").click();
        const session = editSessionStore.getCurrentSession();
        if (!session) throw new Error("ObjectMaterialPanel did not register its Inspector session");
        expect(session.applying).toBe(true);
        expect(session.dirty).toBe(true);
        racedGlobalApply = session.apply();
        // This button still has its pre-render enabled state. Its callback
        // must lose the same synchronous object lease and issue no write.
        button(mounted.container, "Apply Assignment").click();
        fixture.selection.set({
          kind: selectionB.kind,
          label: selectionB.label,
          nodeId: selectionB.nodeId,
          objectId: selectionB.objectId,
          ref: selectionB.ref,
        }, "test");
      });
      expect(await racedGlobalApply).toBe(false);
      expect(fixture.patchObject).not.toHaveBeenCalled();
      expect(fixture.createMaterial).toHaveBeenCalledOnce();
      expect(fixture.createMaterial).toHaveBeenCalledWith(
        "mat:cofeb",
        "Object A material",
        expect.objectContaining({ Ms: 8e5 }),
        [],
        { baseRevision: 21, sessionScopeKey: SESSION_SCOPE_KEY },
      );
      expect(mounted.container.textContent).toContain("Unapplied Inspector changes");
      expect(exactButton(mounted.container, "Apply and continue").disabled).toBe(true);
      expect(exactButton(mounted.container, "Discard").disabled).toBe(true);
      expect(fixture.selection.get().objectId).toBe("object-a");
      await act(async () => exactButton(mounted.container, "Cancel").click());

      await flushResource();
      expect(fixture.createMaterial).toHaveBeenCalledOnce();
      await act(async () => {
        changeInput(input(mounted.container, "New material name"), "Edited during create ACK");
        createAck.resolve(createdMaterialAck("mat:cofeb", {
          Aex: 1.3e-11,
          Dbulk: null,
          Dind: null,
          Ms: 1.1e6,
          alpha: 0.01,
        }));
      });
      await flushResource();
      expect(fixture.patchObject).toHaveBeenCalledOnce();
      expect(fixture.patchObject).toHaveBeenCalledWith("object-a", {
        base_revision: 22,
        material_ref: "mat:cofeb",
      }, { sessionScopeKey: SESSION_SCOPE_KEY });
      expect(input(mounted.container, "New material name").disabled).toBe(false);
      expect(input(mounted.container, "New material name").value).toBe("Edited during create ACK");
      expect(editSessionStore.getCurrentSession()?.applying).toBe(true);
      expect(await editSessionStore.getCurrentSession()?.apply()).toBe(false);

      await act(async () => assignmentAck.resolve(assignedScene(23, "mat:cofeb", {
        Aex: 1.3e-11,
        Dbulk: null,
        Dind: null,
        Ms: 1.1e6,
        alpha: 0.01,
      })));
      await flushResource();
      expect(input(mounted.container, "New material name").value).toBe("Edited during create ACK");
      expect(editSessionStore.getCurrentSession()?.applying).toBe(false);
      expect(editSessionStore.getCurrentSession()?.dirty).toBe(true);
      expect(editSessionStore.getCurrentSession()?.applyBlockReason).toContain("Use Create and assign");
      expect(fixture.patchObject).toHaveBeenCalledOnce();
    } finally {
      createAck.resolve(createdMaterialAck("mat:cofeb"));
      assignmentAck.resolve(assignedScene(23, "mat:cofeb"));
      await flushResource();
      await mounted.cleanup();
    }
  });

  it("serializes an anisotropy write against the nested boundary writer and preserves the boundary draft", async () => {
    const properties = {
      Aex: 1.3e-11,
      Dbulk: null,
      Dind: null,
      Ms: 8e5,
      alpha: 0.01,
    };
    let currentScene = {
      ...materialScene(21, properties),
      objects: [
        {
          ...sceneObject("object-a", "Object A", "mat:old"),
          absorbing_boundary: {
            total_width_m: 4e-7,
            ramp_width_m: 3e-7,
            max_damping: 0.5,
            faces: ["x+"],
            profile: "smootherstep",
            frame: "universe",
          },
        },
        sceneObject("object-b", "Object B"),
      ],
    } as unknown as SceneResource;
    const anisotropyAck = deferred<AuthoringTransactionResponse>();
    const fixture = createFixture();
    Object.assign(fixture.kernel, {
      authoringHistory: {
        getGeneration: () => 0,
        record: vi.fn(),
        subscribe: () => () => undefined,
      },
    });
    fixture.sceneLoad.mockImplementation(async () => currentScene);
    fixture.materialLoad.mockResolvedValue({
      id: "mat:old",
      name: "Old material",
      properties,
      scene_revision: currentScene.revision,
    });
    fixture.interactionLoad.mockResolvedValue({
      enabled: true,
      interaction_kind: "uniaxial_anisotropy",
      object_id: "object-a",
      params: { axis: [0, 0, 1], ku1: 3e5 },
      present: true,
      scene_revision: 21,
    });
    fixture.patchObjectInteraction.mockReturnValue(anisotropyAck.promise);
    fixture.patchObject.mockImplementation(async (_objectId, patch) => {
      const nextObject = {
        ...currentScene.objects?.find((candidate) => candidate.id === "object-a"),
        absorbing_boundary: patch.absorbing_boundary,
      };
      currentScene = {
        ...currentScene,
        revision: 23,
        objects: [nextObject, sceneObject("object-b", "Object B")],
      } as unknown as SceneResource;
      return currentScene;
    });
    const editSessionStore = createInspectorEditSessionStore();
    const mounted = await mountFixture(
      fixture,
      { ...selectionA, kind: "object", nodeId: "object:object-a" },
      { editSessionStore, withFooter: true, withGuard: true },
    );
    try {
      await waitForText(mounted.container, "Old material");
      await act(async () => {
        changeInput(input(mounted.container, "Ku1"), "400000");
        changeInput(input(mounted.container, "Total width"), "5e-7");
      });
      await act(async () => {
        button(mounted.container, "Apply Anisotropy").click();
        // This stale enabled button must fail the shared lease before calling
        // patchObject, even before React publishes disabled state.
        button(mounted.container, "Apply boundary").click();
      });
      await flushResource();
      expect(fixture.patchObjectInteraction).toHaveBeenCalledOnce();
      expect(fixture.patchObject).not.toHaveBeenCalled();
      expect(input(mounted.container, "Total width").disabled).toBe(false);
      expect(input(mounted.container, "Total width").value).toBe("5e-7");
      const savingSession = editSessionStore.getCurrentSession();
      expect(savingSession?.applying).toBe(true);
      expect(savingSession?.dirty).toBe(true);

      currentScene = { ...currentScene, revision: 22 } as SceneResource;
      await act(async () => anisotropyAck.resolve({
        committed_scene: currentScene,
        revision: 22,
        scene_revision: 22,
        transaction_kind: "patch_object_interaction",
      } as unknown as AuthoringTransactionResponse));
      await flushResource();
      expect(editSessionStore.getCurrentSession()?.applying).toBe(false);
      expect(input(mounted.container, "Total width").value).toBe("5e-7");
      expect(editSessionStore.getCurrentSession()?.dirty).toBe(true);

      await act(async () => button(mounted.container, "Apply boundary").click());
      await flushResource();
      expect(fixture.patchObject).toHaveBeenCalledOnce();
      expect(fixture.patchObject.mock.calls[0][1]).toMatchObject({
        base_revision: 22,
        absorbing_boundary: { total_width_m: 5e-7 },
      });
    } finally {
      anisotropyAck.resolve({
        committed_scene: currentScene,
        revision: 22,
        scene_revision: 22,
        transaction_kind: "patch_object_interaction",
      } as unknown as AuthoringTransactionResponse);
      await flushResource();
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
      }, { sessionScopeKey: SESSION_SCOPE_KEY });
    } finally {
      await mounted.cleanup();
    }
  });
});

function createFixture(): Fixture {
  const bus = new EventBus<KernelEventMap>();
  const selection = new SelectionController(bus);
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
  const patchMaterialAsset = vi.fn();
  const patchMaterial = vi.fn().mockResolvedValue({ scene_revision: 22 });
  const invalidate = vi.spyOn(resources, "invalidate");
  const kernel = {
    api: {
      model: {
        createMaterial,
        material: materialLoad,
        objectInteraction: interactionLoad,
        patchMaterial,
        patchMaterialAsset,
        patchObject,
        patchObjectInteraction,
        scene: sceneLoad,
      },
      sessions: {
        current: { status: statusLoad },
        list: vi.fn().mockResolvedValue({
          schema_version: "2.0.0",
          sessions: [
            { current: true, name: "scratch", session_id: "scratch-session", status: "active" },
          ],
        }),
      },
    },
    bus,
    commands: { getSessionScopeKey: () => SESSION_SCOPE_KEY },
    diagnosticRecorder: new DiagnosticRecorderController({ config: { enabled: false } }),
    resources,
    selection,
  } as unknown as KernelApi;
  return {
    createMaterial,
    interactionLoad,
    invalidate,
    kernel,
    materialLoad,
    patchObject,
    patchMaterialAsset,
    patchObjectInteraction,
    resources,
    selection,
    sceneLoad,
    statusLoad,
  };
}

async function mountFixture(
  fixture: Fixture,
  selection: Selection,
  options: {
    editSessionStore?: InspectorEditSessionStore;
    withFooter?: boolean;
    withGuard?: boolean;
  } = {},
) {
  if (options.withGuard) {
    fixture.selection.set({
      kind: selection.kind,
      label: selection.label,
      nodeId: selection.nodeId,
      objectId: selection.objectId,
      ref: selection.ref,
    }, selection.moduleSource);
  }
  const serverHtml = renderToString(
    fixtureTree(fixture, selection, options),
  );
  const dom = installSimulationPreparationTestDom();
  const container = dom.document.createElement("div");
  container.innerHTML = serverHtml;
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  let root!: Root;
  await act(async () => {
    root = hydrateRoot(
      container as unknown as Element,
      fixtureTree(fixture, selection, options),
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  await flushResource();
  // Session-scoped resources only load after the confirmed session identity
  // (session list + status) resolves; edits before that would be re-scoped.
  await waitForText(container, "Scene revision21");
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

function fixtureTree(
  fixture: Fixture,
  selection: Selection,
  options: {
    editSessionStore?: InspectorEditSessionStore;
    withFooter?: boolean;
    withGuard?: boolean;
  },
) {
  const panel = options.withGuard ? (
    <GuardedMaterialPanel fixture={fixture} initialSelection={selection} />
  ) : <ObjectMaterialPanel selection={selection} />;
  const content = options.editSessionStore ? (
    <InspectorEditSessionProvider store={options.editSessionStore}>
      {panel}
      {options.withFooter ? <InspectorFooter onFocus={() => undefined} /> : null}
    </InspectorEditSessionProvider>
  ) : panel;
  return <KernelContext.Provider value={fixture.kernel}>{content}</KernelContext.Provider>;
}

function GuardedMaterialPanel({
  fixture,
  initialSelection,
}: {
  fixture: Fixture;
  initialSelection: Selection;
}) {
  const [selection, setSelection] = useState(initialSelection);
  useEffect(() => fixture.selection.subscribe(setSelection), [fixture]);
  return (
    <InspectorDirtySelectionGuard
      controller={fixture.selection}
      selection={selection}
    >
      {(guardedSelection) => <ObjectMaterialPanel selection={guardedSelection} />}
    </InspectorDirtySelectionGuard>
  );
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

function materialScene(
  revision: number,
  properties: MaterialPropertiesResource,
): SceneResource {
  return {
    ...scene(revision),
    materials: [{ id: "mat:old", name: "Old material", properties, scene_revision: revision }],
    objects: [
      sceneObject("object-a", "Object A", "mat:old"),
      sceneObject("object-b", "Object B"),
    ],
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

function createdMaterialAck(
  materialId = "mat:cofeb",
  properties: MaterialPropertiesResource = {
    Aex: 1.3e-11,
    Dbulk: null,
    Dind: null,
    Ms: 8e5,
    alpha: 0.01,
  },
): AuthoringTransactionResponse {
  return {
    committed_scene: {
      ...scene(22),
      materials: [{ id: materialId, name: "CoFeB", properties }],
      revision: 22,
    },
    scene_revision: 22,
    transaction_kind: "create_material",
  } as unknown as AuthoringTransactionResponse;
}

function assignedScene(
  revision: number,
  materialRef: string,
  properties?: MaterialPropertiesResource,
): SceneResource {
  return {
    ...createdMaterialAck(materialRef, properties).committed_scene,
    revision,
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

function exactButton(root: TestNode, text: string): TestElement {
  return findElement(
    root,
    (element) => element.tagName === "BUTTON" && element.textContent.trim() === text,
    `button exactly named ${text}`,
  );
}

function changeInput(element: TestElement, value: string, eventName = "input"): void {
  element.value = value;
  element.dispatchEvent(new TestEvent(eventName, { bubbles: true }));
}
