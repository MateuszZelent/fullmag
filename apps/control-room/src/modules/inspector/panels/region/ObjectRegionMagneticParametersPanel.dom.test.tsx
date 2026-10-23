import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  installSimulationPreparationTestDom,
  TestEvent,
  TestElement,
  TestNode,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { QuantityFieldDraftScope } from "../../primitives/QuantityField";
import { createQuantityFieldDraftStore } from "../../primitives/quantityFieldDraftStore";

const sessionA = {
  sessionId: "A",
  sessionEpoch: "1",
  requestScopeEpoch: "1",
} as const;
const sessionAScopeKey = "session=A&epoch=1&request_scope_epoch=1";

const mocks = vi.hoisted(() => ({
  currentSessionScopeKey: "session=A&epoch=1&request_scope_epoch=1" as string | null,
  historyGeneration: 0,
  patchMaterialFields: vi.fn(),
  publishScene: vi.fn(),
  readScene: vi.fn(),
  recordHistory: vi.fn(),
  syncAuthoringScript: vi.fn(),
  sessionIdentity: null as unknown,
  sceneData: { objects: [], materials: [] },
}));

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => ({
    api: {
      model: {
        patchObjectMaterialFields: mocks.patchMaterialFields,
        scene: mocks.readScene,
        syncAuthoringScript: mocks.syncAuthoringScript,
      },
    },
    authoringHistory: {
      getGeneration: () => mocks.historyGeneration,
      record: mocks.recordHistory,
    },
    commands: { getSessionScopeKey: () => mocks.currentSessionScopeKey },
    resources: {},
  }),
}));

vi.mock("@/kernel/resources/useSessionStatus", () => ({
  useSessionResourceIdentity: () => mocks.sessionIdentity,
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/kernel/resources/geometryLifecycleResources")
  >();
  return {
    ...actual,
    useSceneResource: () => ({ data: mocks.sceneData, status: "ready" }),
  };
});

vi.mock("../regionAuthoringInvalidation", () => ({
  publishRegionAuthoringScene: mocks.publishScene,
}));

vi.mock("../ObjectRegionsPanel", () => ({
  PhysicalScalarField: () => null,
}));

vi.mock("./shared", () => ({
  ObjectRegionActionsSection: () => null,
  ObjectRegionInlineDiagnostics: () => null,
  ObjectRegionMetadataSection: () => null,
}));

import { ObjectRegionMagneticParametersPanel } from "./ObjectRegionMagneticParametersPanel";
import type { RegionSubPanelProps } from "./shared";

describe("ObjectRegionMagneticParametersPanel session fence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentSessionScopeKey = sessionAScopeKey;
    mocks.historyGeneration = 0;
    mocks.sessionIdentity = sessionA;
    mocks.sceneData = { objects: [], materials: [] };
    mocks.readScene.mockResolvedValue({
      objects: [],
      revision: 10,
      scene_revision: 10,
    });
    mocks.patchMaterialFields.mockResolvedValue({
      committed_scene: { objects: [], revision: 11, scene_revision: 11 },
      scene_revision: 11,
    });
    mocks.syncAuthoringScript.mockResolvedValue({});
  });

  it("keeps clean Apply Fields disabled without submitting a write", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<ObjectRegionMagneticParametersPanel {...panelProps()} />));
      expect(findButton(container, "Apply Fields").disabled).toBe(true);
      await act(async () => findButton(container, "Apply Fields").click());
      expect(mocks.readScene).not.toHaveBeenCalled();
      expect(mocks.patchMaterialFields).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("keeps empty and sign-only field priorities as invalid raw drafts", async () => {
    const draftStore = createQuantityFieldDraftStore();
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () =>
        root.render(
          <QuantityFieldDraftScope store={draftStore}>
            <ObjectRegionMagneticParametersPanel {...panelProps()} />
          </QuantityFieldDraftScope>,
        ),
      );
      await act(async () => findButton(container, "Add Field").click());

      const priority = findPriorityInputs(container)[0];
      if (!priority) throw new Error("Missing material field priority input");
      expect(priority.value).toBe("5");

      await act(async () => editInput(priority, ""));
      expect(priority.value).toBe("");
      expect(draftStore.getSummary().invalidLabels).toEqual(["Priority"]);
      expect(findButton(container, "Apply Fields").disabled).toBe(true);

      await act(async () => editInput(priority, "-"));
      expect(priority.value).toBe("-");
      expect(draftStore.getSummary().invalidLabels).toEqual(["Priority"]);
      expect(findButton(container, "Apply Fields").disabled).toBe(true);
      expect(mocks.readScene).not.toHaveBeenCalled();
      expect(mocks.patchMaterialFields).not.toHaveBeenCalled();

      await act(async () => findButton(container, "Revert Fields").click());
      expect(draftStore.getSummary().pendingCount).toBe(0);
      expect(findPriorityInputs(container)).toHaveLength(0);
      expect(findButton(container, "Apply Fields").disabled).toBe(true);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("commits explicit zero and negative field priorities without changing their meaning", async () => {
    const draftStore = createQuantityFieldDraftStore();
    mocks.sceneData = {
      objects: [
        {
          id: "object-a",
          material_parameter_fields: [
            materialFieldAssignment("field-a", 1),
            materialFieldAssignment("field-b", 2),
          ],
        },
      ],
      materials: [],
    } as never;
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () =>
        root.render(
          <QuantityFieldDraftScope store={draftStore}>
            <ObjectRegionMagneticParametersPanel {...panelProps()} />
          </QuantityFieldDraftScope>,
        ),
      );
      const priorities = findPriorityInputs(container);
      expect(priorities).toHaveLength(2);
      const negativePriority = priorities[0];
      const zeroPriority = priorities[1];
      if (!negativePriority || !zeroPriority) {
        throw new Error("Missing field priority inputs");
      }

      await act(async () => {
        editInput(negativePriority, "-2");
        negativePriority.dispatchEvent(new TestEvent("focusout", { bubbles: true }));
      });
      await act(async () => {
        editInput(zeroPriority, "0");
        zeroPriority.dispatchEvent(new TestEvent("focusout", { bubbles: true }));
      });
      expect(draftStore.getSummary().pendingCount).toBe(0);
      await act(async () => findButton(container, "Apply Fields").click());

      expect(mocks.patchMaterialFields).toHaveBeenCalledOnce();
      const submittedFields = mocks.patchMaterialFields.mock.calls[0]?.[1];
      expect(submittedFields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ priority: -2 }),
          expect.objectContaining({ priority: 0 }),
        ]),
      );
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("removing one field clears only its raw priority draft and Revert clears the remainder", async () => {
    const draftStore = createQuantityFieldDraftStore();
    mocks.sceneData = {
      objects: [
        {
          id: "object-a",
          material_parameter_fields: [
            materialFieldAssignment("field-a", 1),
            materialFieldAssignment("field-b", 2),
          ],
        },
      ],
      materials: [],
    } as never;
    const props = {
      ...panelProps(),
      removeQuantityFieldDraftKeys: (keys: readonly string[]) => {
        for (const key of keys) draftStore.remove(key);
      },
    };
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () =>
        root.render(
          <QuantityFieldDraftScope store={draftStore}>
            <ObjectRegionMagneticParametersPanel {...props} />
          </QuantityFieldDraftScope>,
        ),
      );
      await act(async () => findButton(container, "Add Field").click());

      const priorities = findPriorityInputs(container);
      expect(priorities).toHaveLength(3);
      const firstPriority = priorities[0];
      const secondPriority = priorities[1];
      if (!firstPriority || !secondPriority) {
        throw new Error("Missing material field priority inputs");
      }
      await act(async () => editInput(firstPriority, "-"));
      await act(async () => editInput(secondPriority, "1e+"));
      expect(findButton(container, "Apply Fields").disabled).toBe(true);
      expect(draftStore.getSummary().pendingCount).toBe(2);

      await act(async () => findButton(container, "Remove Field").click());
      expect(findPriorityInputs(container)).toHaveLength(2);
      expect(findPriorityInputs(container)[0]?.value).toBe("1e+");
      expect(findButton(container, "Apply Fields").disabled).toBe(true);
      expect(draftStore.getSummary().pendingCount).toBe(1);

      await act(async () => findButton(container, "Revert Fields").click());
      expect(draftStore.getSummary().pendingCount).toBe(0);
      expect(findPriorityInputs(container).map((input) => input.value)).toEqual(["1", "2"]);
      expect(findButton(container, "Apply Fields").disabled).toBe(true);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("sends the material-field write with the scoped canonical revision", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<ObjectRegionMagneticParametersPanel {...panelProps()} />));
      await act(async () => findButton(container, "Add Field").click());
      expect(findButton(container, "Apply Fields").disabled).toBe(false);
      await act(async () => findButton(container, "Apply Fields").click());

      expect(mocks.readScene).toHaveBeenCalledWith({ sessionScopeKey: sessionAScopeKey });
      expect(mocks.patchMaterialFields).toHaveBeenCalledWith(
        "object-a",
        [expect.objectContaining({
          owner_object: "object-a",
          region_id: "region-a",
          parameter: "ms",
          value: expect.objectContaining({ kind: "linear", base: 800e3 }),
        })],
        { baseRevision: 10, sessionScopeKey: sessionAScopeKey },
      );
      expect(mocks.recordHistory).toHaveBeenCalledOnce();
      expect(mocks.publishScene).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ scene_revision: 11 }),
        11,
        undefined,
        sessionAScopeKey,
        undefined,
      );
      expect(mocks.syncAuthoringScript).toHaveBeenCalledOnce();
      expect(mocks.syncAuthoringScript).toHaveBeenCalledWith(
        {},
        { sessionScopeKey: sessionAScopeKey },
      );
      expect(container.textContent).toContain("Material fields updated.");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("waits for the material-field ACK before syncing the captured session", async () => {
    let finishPatch: ((value: unknown) => void) | null = null;
    const patchResult = new Promise((resolve) => {
      finishPatch = resolve;
    });
    mocks.patchMaterialFields.mockReturnValue(patchResult);

    let finishSync: ((value: unknown) => void) | null = null;
    const syncResult = new Promise((resolve) => {
      finishSync = resolve;
    });
    mocks.syncAuthoringScript.mockReturnValue(syncResult);

    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<ObjectRegionMagneticParametersPanel {...panelProps()} />));
      await act(async () => findButton(container, "Add Field").click());
      await act(async () => {
        findButton(container, "Apply Fields").click();
        await flushMicrotasks();
      });

      expect(mocks.patchMaterialFields).toHaveBeenCalledOnce();
      expect(mocks.syncAuthoringScript).not.toHaveBeenCalled();
      expect(mocks.publishScene).not.toHaveBeenCalled();

      await act(async () => {
        finishPatch?.({
          committed_scene: { objects: [], revision: 11, scene_revision: 11 },
          scene_revision: 11,
        });
        await flushMicrotasks();
      });

      expect(mocks.publishScene).toHaveBeenCalledOnce();
      expect(mocks.syncAuthoringScript).toHaveBeenCalledOnce();
      expect(mocks.syncAuthoringScript).toHaveBeenCalledWith(
        {},
        { sessionScopeKey: sessionAScopeKey },
      );
      expect(container.textContent).not.toContain("Material fields updated.");

      await act(async () => {
        finishSync?.({});
        await flushMicrotasks();
      });
      expect(container.textContent).toContain("Material fields updated.");
      expect(mocks.patchMaterialFields).toHaveBeenCalledOnce();
      expect(mocks.syncAuthoringScript).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("does not sync when the material-field mutation is rejected", async () => {
    mocks.patchMaterialFields.mockRejectedValueOnce(new Error("field mutation rejected"));
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<ObjectRegionMagneticParametersPanel {...panelProps()} />));
      await act(async () => findButton(container, "Add Field").click());
      await act(async () => {
        findButton(container, "Apply Fields").click();
        await flushMicrotasks();
      });

      expect(mocks.patchMaterialFields).toHaveBeenCalledOnce();
      expect(mocks.publishScene).not.toHaveBeenCalled();
      expect(mocks.syncAuthoringScript).not.toHaveBeenCalled();
      expect(container.textContent).toContain("field mutation rejected");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("keeps the field ACK successful when script sync fails without replaying the write", async () => {
    mocks.syncAuthoringScript.mockRejectedValueOnce(new Error("script rewrite unavailable"));
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<ObjectRegionMagneticParametersPanel {...panelProps()} />));
      await act(async () => findButton(container, "Add Field").click());
      await act(async () => {
        findButton(container, "Apply Fields").click();
        await flushMicrotasks();
      });

      expect(mocks.patchMaterialFields).toHaveBeenCalledOnce();
      expect(mocks.syncAuthoringScript).toHaveBeenCalledOnce();
      expect(mocks.syncAuthoringScript).toHaveBeenCalledWith(
        {},
        { sessionScopeKey: sessionAScopeKey },
      );
      expect(container.textContent).toContain(
        "Material fields updated. Authoring script sync skipped: script rewrite unavailable",
      );
      expect(mocks.patchMaterialFields).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("does not publish sync feedback after the captured session changes", async () => {
    let finishSync: ((value: unknown) => void) | null = null;
    const syncResult = new Promise((resolve) => {
      finishSync = resolve;
    });
    mocks.syncAuthoringScript.mockReturnValue(syncResult);
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<ObjectRegionMagneticParametersPanel {...panelProps()} />));
      await act(async () => findButton(container, "Add Field").click());
      await act(async () => {
        findButton(container, "Apply Fields").click();
        await flushMicrotasks();
      });

      expect(mocks.syncAuthoringScript).toHaveBeenCalledWith(
        {},
        { sessionScopeKey: sessionAScopeKey },
      );
      mocks.currentSessionScopeKey = "session=B&epoch=2&request_scope_epoch=2";
      mocks.historyGeneration += 1;
      await act(async () => {
        finishSync?.({});
        await flushMicrotasks();
      });

      expect(mocks.patchMaterialFields).toHaveBeenCalledOnce();
      expect(mocks.syncAuthoringScript).toHaveBeenCalledOnce();
      expect(container.textContent).not.toContain("Material fields updated.");
      expect(container.textContent).not.toContain("Authoring script sync skipped:");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("scopes deferred sync feedback to the committed region owner", async () => {
    let finishSync: ((value: unknown) => void) | null = null;
    const syncResult = new Promise((resolve) => {
      finishSync = resolve;
    });
    mocks.syncAuthoringScript.mockReturnValueOnce(syncResult);

    const propsA = panelProps();
    const propsB = {
      ...propsA,
      model: {
        ...propsA.model,
        objectId: "object-b",
        regionId: "region-b",
      },
    };
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<ObjectRegionMagneticParametersPanel {...propsA} />));
      await act(async () => findButton(container, "Add Field").click());
      await act(async () => {
        findButton(container, "Apply Fields").click();
        await flushMicrotasks();
      });

      expect(mocks.patchMaterialFields).toHaveBeenCalledOnce();
      expect(mocks.syncAuthoringScript).toHaveBeenCalledOnce();
      expect(mocks.syncAuthoringScript).toHaveBeenCalledWith(
        {},
        { sessionScopeKey: sessionAScopeKey },
      );

      await act(async () => root.render(<ObjectRegionMagneticParametersPanel {...propsB} />));
      expect(container.textContent).not.toContain("Material fields updated.");

      await act(async () => {
        finishSync?.({});
        await flushMicrotasks();
      });
      expect(container.textContent).not.toContain("Material fields updated.");

      await act(async () => findButton(container, "Add Field").click());
      await act(async () => findButton(container, "Apply Fields").click());

      expect(mocks.patchMaterialFields).toHaveBeenCalledTimes(2);
      expect(mocks.patchMaterialFields.mock.calls[1]?.[0]).toBe("object-b");
      expect(mocks.patchMaterialFields.mock.calls[1]?.[1]).toEqual(
        expect.arrayContaining([expect.objectContaining({ region_id: "region-b" })]),
      );
      expect(mocks.syncAuthoringScript).toHaveBeenCalledTimes(2);
      expect(container.textContent).toContain("Material fields updated.");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("does not accept a deferred sync result after the owner changes away and back", async () => {
    let finishSync: ((value: unknown) => void) | null = null;
    const syncResult = new Promise((resolve) => {
      finishSync = resolve;
    });
    mocks.syncAuthoringScript.mockReturnValueOnce(syncResult);

    const propsA = panelProps();
    const propsB = {
      ...propsA,
      model: {
        ...propsA.model,
        objectId: "object-b",
        regionId: "region-b",
      },
    };
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<ObjectRegionMagneticParametersPanel {...propsA} />));
      await act(async () => findButton(container, "Add Field").click());
      await act(async () => {
        findButton(container, "Apply Fields").click();
        await flushMicrotasks();
      });

      await act(async () => root.render(<ObjectRegionMagneticParametersPanel {...propsB} />));
      await act(async () => root.render(<ObjectRegionMagneticParametersPanel {...propsA} />));
      await act(async () => {
        finishSync?.({});
        await flushMicrotasks();
      });

      expect(mocks.patchMaterialFields).toHaveBeenCalledOnce();
      expect(mocks.syncAuthoringScript).toHaveBeenCalledOnce();
      expect(container.textContent).not.toContain("Material fields updated.");
      expect(container.textContent).not.toContain("Authoring script sync skipped:");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("does not publish history or scene effects when the session changes before ACK", async () => {
    let finishPatch: ((value: unknown) => void) | null = null;
    const patchResult = new Promise((resolve) => {
      finishPatch = resolve;
    });
    mocks.patchMaterialFields.mockReturnValue(patchResult);
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<ObjectRegionMagneticParametersPanel {...panelProps()} />));
      await act(async () => findButton(container, "Add Field").click());
      expect(findButton(container, "Apply Fields").disabled).toBe(false);
      await act(async () => {
        findButton(container, "Apply Fields").click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mocks.patchMaterialFields).toHaveBeenCalledWith(
        "object-a",
        [expect.objectContaining({
          owner_object: "object-a",
          region_id: "region-a",
          parameter: "ms",
          value: expect.objectContaining({ kind: "linear", base: 800e3 }),
        })],
        expect.objectContaining({ sessionScopeKey: sessionAScopeKey }),
      );
      mocks.currentSessionScopeKey = "session=B&epoch=2&request_scope_epoch=2";
      mocks.historyGeneration += 1;
      await act(async () => {
        finishPatch?.({
          committed_scene: { objects: [], revision: 11, scene_revision: 11 },
          scene_revision: 11,
        });
        await patchResult;
      });

      expect(mocks.recordHistory).not.toHaveBeenCalled();
      expect(mocks.publishScene).not.toHaveBeenCalled();
      expect(container.textContent).not.toContain("Material fields updated.");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("fails closed when the session identity is unavailable", async () => {
    mocks.sessionIdentity = null;
    mocks.currentSessionScopeKey = null;
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<ObjectRegionMagneticParametersPanel {...panelProps()} />));
      await act(async () => findButton(container, "Add Field").click());
      expect(findButton(container, "Apply Fields").disabled).toBe(false);
      await act(async () => findButton(container, "Apply Fields").click());

      expect(mocks.readScene).not.toHaveBeenCalled();
      expect(mocks.patchMaterialFields).not.toHaveBeenCalled();
      expect(container.textContent).toContain("Session identity is not ready");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});

function panelProps(): RegionSubPanelProps {
  return {
    model: {
      objectId: "object-a",
      regionId: "region-a",
      revision: 9,
      materialRef: "material-a",
      materialOverrideCount: 0,
      materialFieldCount: 0,
      priority: 5,
    } as RegionSubPanelProps["model"],
    draft: { materialOverrides: [] } as unknown as RegionSubPanelProps["draft"],
    pending: false,
    draftDirty: false,
    buildRegion: async () => undefined,
    regionMeshLifecycle: null,
    canWriteRegion: true,
    meshLane: "fdm",
    updateDraft: () => undefined,
    updateShape: () => undefined,
    updateShapeVector: () => undefined,
    updateMeshPolicy: () => undefined,
    updateMaterialOverride: () => undefined,
    addMaterialOverride: () => undefined,
    removeMaterialOverride: () => undefined,
    materialFields: null,
    couplingDependencies: [],
    applyRegion: async () => true,
    duplicateRegion: async () => undefined,
    deleteRegion: async () => undefined,
    revert: () => undefined,
    feedback: null,
  };
}

function materialFieldAssignment(assignmentId: string, priority: number) {
  return {
    assignment_id: assignmentId,
    conflict_policy: "higher_priority_wins",
    owner_object_id: "object-a",
    parameter: "ms",
    priority,
    region_id: "region-a",
    value: { kind: "constant", unit: "A/m", value: 800e3 },
  };
}

function editInput(input: TestElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new TestEvent("input", { bubbles: true }));
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function findPriorityInputs(root: TestNode): TestElement[] {
  return findElements(
    root,
    (element) =>
      element.tagName === "INPUT" &&
      element.getAttribute("aria-label") === "Priority",
  );
}

function findButton(root: TestNode, text: string): TestElement {
  const button = findElements(root, (element) =>
    element.tagName === "BUTTON" && element.textContent.includes(text),
  )[0];
  if (!button) throw new Error(`Missing button ${text}`);
  return button;
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
