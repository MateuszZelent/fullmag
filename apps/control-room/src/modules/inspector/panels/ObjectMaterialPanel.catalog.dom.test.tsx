import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MaterialLibraryEntryResource, SceneMaterialResource, SceneResource } from "@/kernel/api/apiTypes";
import { installSimulationPreparationTestDom, TestElement, TestEvent, TestNode } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import type { Selection } from "@/kernel/selection/selectionTypes";

const mocks = vi.hoisted(() => ({
  identity: { sessionId: "A", sessionEpoch: "1", requestScopeEpoch: "1" },
  scope: "session=A&epoch=1&request_scope_epoch=1",
  scene: {} as SceneResource,
  dialog: null as null | {
    open: boolean; modelMaterial?: SceneMaterialResource;
    onUseMaterial?: (entry: MaterialLibraryEntryResource) => Promise<void>;
  },
  create: vi.fn(), sceneRequest: vi.fn(), patchObject: vi.fn(), record: vi.fn(),
  invalidate: vi.fn(), publish: vi.fn(),
}));

vi.mock("@/kernel/KernelContext", () => ({ useKernel: () => ({
  api: { resourceCacheScope: "inspector-catalog-test", model: {
    createMaterial: mocks.create, scene: mocks.sceneRequest, patchObject: mocks.patchObject,
  } },
  authoringHistory: { getGeneration: () => 0, record: mocks.record },
  commands: { getSessionScopeKey: () => mocks.scope },
  resources: { invalidate: mocks.invalidate },
}) }));
vi.mock("@/kernel/resources/useSessionStatus", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/kernel/resources/useSessionStatus")>()),
  useSessionResourceIdentity: () => mocks.identity,
}));
vi.mock("@/kernel/layout/MaterialLibraryDialog", () => ({ MaterialLibraryDialog: (props: NonNullable<typeof mocks.dialog>) => {
  mocks.dialog = props;
  return null;
} }));
vi.mock("@/kernel/resources/geometryLifecycleResources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/kernel/resources/geometryLifecycleResources")>()),
  publishCommittedSceneResource: (...args: unknown[]) => mocks.publish(...args),
  useSceneResource: () => ({ data: mocks.scene, status: "ready", error: null, refetch: vi.fn(), revision: mocks.scene.revision }),
  useMaterialResource: (id: string | null) => {
    const material = mocks.scene.materials?.find((candidate) => candidate.id === id);
    return { data: material ? { ...material, scene_revision: mocks.scene.revision } : null,
      status: "ready", error: null, refetch: vi.fn(), revision: mocks.scene.revision };
  },
  useObjectInteractionResource: () => ({ data: { present: false, params: {} }, status: "ready", error: null, refetch: vi.fn() }),
}));
vi.mock("./ObjectAbsorbingBoundaryPanel", () => ({ ObjectAbsorbingBoundaryPanel: () => null }));

import { ObjectMaterialPanel } from "./ObjectMaterialPanel";

const entry: MaterialLibraryEntryResource = {
  id: "builtin:permalloy", kind: "builtin", revision: 1, name: "Permalloy", summary: "Seed parameters",
  properties: { Ms: 800000, Aex: 1.3e-11, alpha: 0.01, Dind: null, Dbulk: null },
  references: [{ label: "Sample", citation: "Film A" }, { url: "https://example.org/method" }],
};
function scene(): SceneResource {
  return {
    revision: 10, scene_revision: 10,
    objects: ["object-a", "object-b"].map((id) => ({
      id, name: id, material_ref: "mat:shared",
      physics_stack: [{ kind: "exchange", enabled: true }],
      geometry: { geometry_kind: "box", geometry_params: { size: [1e-7, 1e-7, 1e-8] } },
      transform: { rotation_quat: [0, 0, 0, 1], scale: [1, 1, 1], translation: [0, 0, 0], pivot: [0, 0, 0] },
    })),
    materials: [{ id: "mat:shared", name: "Shared sample", properties: { ...entry.properties }, references: entry.references }],
  };
}
function selection(objectId = "object-a"): Selection {
  return { kind: "object.root", label: objectId, objectId, moduleSource: "explorer", nodeId: `model:object:${objectId}`,
    ref: { kind: "object.root", nodeId: `model:object:${objectId}`, objectId, type: "scene-object", visualizationTargetId: `object:${objectId}` } };
}
function elements(root: TestNode, predicate: (element: TestElement) => boolean): TestElement[] {
  const result: TestElement[] = [];
  const visit = (node: TestNode) => {
    if (node instanceof TestElement && predicate(node)) result.push(node);
    node.childNodes.forEach(visit);
  };
  visit(root);
  return result;
}
function button(root: TestNode, text: string): TestElement {
  const found = elements(root, (element) => element.tagName === "BUTTON" && element.textContent === text)[0];
  if (!found) throw new Error(`Missing button ${text}`);
  return found;
}
function input(root: TestNode, label: string): TestElement {
  const found = elements(root, (element) => element.getAttribute("aria-label") === label)[0];
  if (!found) throw new Error(`Missing field ${label}`);
  return found;
}
function changeInput(root: TestNode, label: string, value: string): void {
  const control = input(root, label);
  const nativeInput = control as TestElement & { type?: string };
  nativeInput.type ??= control.getAttribute("type") ?? "text";
  const setter = Object.getOwnPropertyDescriptor(TestElement.prototype, "value")?.set;
  if (!setter) throw new Error("Missing test input setter");
  setter.call(control, value);
  control.dispatchEvent(new TestEvent("input", { bubbles: true }));
}
async function mountPanel() {
  const dom = installSimulationPreparationTestDom();
  const container = dom.document.createElement("div");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container as unknown as Element);
  await act(async () => root.render(<ObjectMaterialPanel selection={selection()} />));
  return { dom, container, root, async dispose() { await act(async () => root.unmount()); dom.restore(); } };
}
function commit(id: string, name: string, properties: SceneMaterialResource["properties"], references: unknown, _options: unknown, asset: { source: unknown; assignToObjectId: string }) {
  const committed = {
    ...mocks.scene, revision: 11, scene_revision: 11,
    materials: [...mocks.scene.materials ?? [], { id, name, properties, references, source: asset.source }],
    objects: mocks.scene.objects?.map((object) => object.id === asset.assignToObjectId ? { ...object, material_ref: id } : object),
  } as SceneResource;
  return { committed_scene: committed, scene_revision: 11, transaction_kind: "create_material" };
}

describe("ObjectMaterialPanel database lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.identity = { sessionId: "A", sessionEpoch: "1", requestScopeEpoch: "1" };
    mocks.scope = "session=A&epoch=1&request_scope_epoch=1";
    mocks.scene = scene(); mocks.dialog = null;
    mocks.sceneRequest.mockImplementation(async () => mocks.scene);
    mocks.publish.mockImplementation((_resources: unknown, committed: SceneResource) => { mocks.scene = committed; });
    mocks.create.mockImplementation(async (...args: Parameters<typeof commit>) => commit(...args));
  });

  it("imports once with complete source and references, records history, and preserves the panel root", async () => {
    const view = await mountPanel();
    try {
      const panelRoot = elements(view.container, (element) => element.className === "fm-inspector-panel")[0];
      await act(async () => button(view.container, "Choose from database").click());
      expect(mocks.dialog?.open).toBe(true);
      await act(async () => { await mocks.dialog?.onUseMaterial?.(entry); });
      expect(mocks.create).toHaveBeenCalledOnce();
      expect(mocks.patchObject).not.toHaveBeenCalled();
      expect(mocks.create.mock.calls[0]?.[5]).toMatchObject({ assignToObjectId: "object-a", source: { catalog_id: entry.id, catalog_revision: 1, references: entry.references } });
      expect(mocks.record).toHaveBeenCalledOnce();
      expect(mocks.publish).toHaveBeenCalledOnce();
      expect(elements(view.container, (element) => element.className === "fm-inspector-panel")[0]).toBe(panelRoot);
      expect(view.container.textContent).toContain("Unmodified copy");
    } finally { await view.dispose(); }
  });

  it("keeps unrelated inputs enabled and edits made during the assignment ACK", async () => {
    let resolve!: (value: ReturnType<typeof commit>) => void;
    let argumentsAtStart: Parameters<typeof commit> | null = null;
    mocks.create.mockImplementation((...args: Parameters<typeof commit>) => {
      argumentsAtStart = args;
      return new Promise<ReturnType<typeof commit>>((done) => { resolve = done; });
    });
    const view = await mountPanel();
    try {
      await act(async () => button(view.container, "Choose from database").click());
      let pending!: Promise<void>;
      await act(async () => { pending = mocks.dialog!.onUseMaterial!(entry); await Promise.resolve(); });
      expect(input(view.container, "Ms").disabled).toBe(false);
      expect(input(view.container, "Ku1").disabled).toBe(true);
      await act(async () => changeInput(view.container, "Ms", "975000"));
      const focused = input(view.container, "Ms"); focused.focus();
      await act(async () => { resolve(commit(...argumentsAtStart!)); await pending; });
      expect(input(view.container, "Ms")).toBe(focused);
      expect(input(view.container, "Ms").value).toBe("975000");
      expect(view.dom.document.activeElement).toBe(focused);
      expect(input(view.container, "New alpha").value).toBe("0.01");
    } finally { await view.dispose(); }
  });

  it("rejects a duplicate submit while the synchronous mutation lease is held", async () => {
    let resolve!: (value: ReturnType<typeof commit>) => void;
    let response: ReturnType<typeof commit> | null = null;
    mocks.create.mockImplementation((...args: Parameters<typeof commit>) => {
      response = commit(...args);
      return new Promise<ReturnType<typeof commit>>((done) => { resolve = done; });
    });
    const view = await mountPanel();
    try {
      await act(async () => button(view.container, "Choose from database").click());
      let pending!: Promise<void>;
      await act(async () => { pending = mocks.dialog!.onUseMaterial!(entry); await Promise.resolve(); });
      await act(async () => {
        await expect(mocks.dialog!.onUseMaterial!(entry)).rejects.toThrow("did not complete");
      });
      expect(mocks.create).toHaveBeenCalledOnce();
      await act(async () => { resolve(response!); await pending; });
      expect(mocks.create).toHaveBeenCalledOnce();
      expect(mocks.record).toHaveBeenCalledOnce();
    } finally { await view.dispose(); }
  });

  it("ignores a late ACK after the session scope changes", async () => {
    let resolve!: (value: ReturnType<typeof commit>) => void;
    let response: ReturnType<typeof commit> | null = null;
    mocks.create.mockImplementation((...args: Parameters<typeof commit>) => {
      response = commit(...args);
      return new Promise<ReturnType<typeof commit>>((done) => { resolve = done; });
    });
    const view = await mountPanel();
    try {
      await act(async () => button(view.container, "Choose from database").click());
      let pending!: Promise<void>;
      await act(async () => { pending = mocks.dialog!.onUseMaterial!(entry).catch(() => undefined); await Promise.resolve(); });
      mocks.identity = { sessionId: "B", sessionEpoch: "2", requestScopeEpoch: "2" };
      mocks.scope = "session=B&epoch=2&request_scope_epoch=2";
      mocks.scene = { ...scene(), revision: 30, scene_revision: 30 };
      await act(async () => view.root.render(<ObjectMaterialPanel selection={selection()} />));
      await act(async () => { resolve(response!); await pending; });
      expect(mocks.publish).not.toHaveBeenCalled();
      expect(mocks.record).not.toHaveBeenCalled();
      expect(mocks.dialog?.open).toBe(false);
      expect(mocks.scene.revision).toBe(30);
    } finally { await view.dispose(); }
  });

  it("copies only the selected object's shared material and leaves physics untouched", async () => {
    const view = await mountPanel();
    try {
      expect(view.container.textContent).toContain("2 objects");
      await act(async () => button(view.container, "Make independent copy").click());
      expect(mocks.create).toHaveBeenCalledOnce();
      const [first, second] = mocks.scene.objects ?? [];
      expect(first?.material_ref).not.toBe("mat:shared");
      expect(second?.material_ref).toBe("mat:shared");
      expect(mocks.patchObject).not.toHaveBeenCalled();
      expect(first?.physics_stack).toEqual([{ kind: "exchange", enabled: true }]);
      expect(second?.physics_stack).toEqual([{ kind: "exchange", enabled: true }]);
      expect(mocks.create.mock.calls[0]?.[5]).toEqual({ source: null, assignToObjectId: "object-a" });
    } finally { await view.dispose(); }
  });

  it("does not copy displayed material parameters using a newer history revision", async () => {
    const view = await mountPanel();
    try {
      const changed = {
        ...scene(), revision: 11, scene_revision: 11,
        materials: [{ ...scene().materials![0], properties: { ...entry.properties, Ms: 930000 } }],
      };
      mocks.sceneRequest.mockResolvedValue(changed);
      await act(async () => button(view.container, "Make independent copy").click());
      expect(mocks.create).not.toHaveBeenCalled();
      expect(view.container.textContent).toContain("Review the refreshed model before making a copy.");
    } finally { await view.dispose(); }
  });

  it("shows a changed model copy against its pinned source with SI differences", async () => {
    mocks.scene.materials = [{
      ...mocks.scene.materials![0],
      properties: { ...entry.properties, Ms: 900000 },
      source: { catalog_id: entry.id, catalog_revision: entry.revision, name: entry.name,
        kind: entry.kind, properties: { ...entry.properties }, references: entry.references },
    }];
    const view = await mountPanel();
    try {
      expect(view.container.textContent).toContain("Modified in model");
      expect(view.container.textContent).toContain("Permalloy · version 1");
      expect(view.container.textContent).toContain("Ms: 800000 → 900000 A/m");
    } finally { await view.dispose(); }
  });

  it("opens global save with the committed model material without mutating the scene", async () => {
    const view = await mountPanel();
    try {
      await act(async () => button(view.container, "Save copy to database").click());
      expect(mocks.dialog?.open).toBe(true);
      expect(mocks.dialog?.modelMaterial?.id).toBe("mat:shared");
      expect(mocks.dialog?.onUseMaterial).toBeUndefined();
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.record).not.toHaveBeenCalled();
    } finally { await view.dispose(); }
  });
});
