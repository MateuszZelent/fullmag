import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { KernelContext } from "@/kernel/KernelContext";
import type { KernelApi } from "@/kernel/types";
import type { Selection } from "@/kernel/selection/selectionTypes";
import type { ResourceStatus } from "@/kernel/resources/resourceTypes";
import { installSimulationPreparationTestDom, TestElement, TestEvent, type TestNode } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { createInspectorEditSessionStore, InspectorEditSessionProvider } from "../InspectorEditSession";
import { SpinInterfaceInspectorPanel } from "./SpinInterfaceInspector";

const mocks = vi.hoisted(() => ({
  projectionRevision: 7, ownerRevision: 7, geometryRevision: 7,
  projectionStatus: "ready" as ResourceStatus, ownerStatus: "ready" as ResourceStatus, geometryStatus: "ready" as ResourceStatus,
  projectionError: null as Error | null, ownerError: null as Error | null, geometryError: null as Error | null,
  projected: [] as Record<string, unknown>[], owned: [] as Record<string, unknown>[],
  refetchProjection: vi.fn(), refetchOwner: vi.fn(), refetchGeometry: vi.fn(),
}));
const scope = "session=interface-test&epoch=1&request_scope_epoch=1";
const known = (id: string) => ({ id, kind: "mixing_conductance", normal_side: { object_id: "stack", region_id: "n" },
  ferromagnet_side: { object_id: "stack", region_id: "f" }, normal_to_ferromagnet: [0, 0, 1],
  g_up_Spm2: 1, g_down_Spm2: 2, g_r_Spm2: 3, g_i_Spm2: 4,
  formula_version: "magnetoelectronic.fullmag.v2", absorption: "full_absorption" });

vi.mock("@/kernel/resources/spinAuthoringResources", async (original) => ({
  ...(await original<typeof import("@/kernel/resources/spinAuthoringResources")>()),
  invalidateSpinAuthoringResources: vi.fn(),
  useSpinInterfacesResource: () => ({ data: { scene_revision: mocks.projectionRevision, items: mocks.projected.map((entry) => ({
    owner_spin_transport_id: "spin", interface_id: entry.id, known: true, interface: entry,
  })) }, status: mocks.projectionStatus, error: null, refreshError: mocks.projectionError, refetch: mocks.refetchProjection }),
  useSpinTransportsResource: () => ({ data: { scene_revision: mocks.ownerRevision, items: [{
    id: "spin", mode: "steady", interfaces: mocks.owned,
  }] }, status: mocks.ownerStatus, error: null, refreshError: mocks.ownerError, refetch: mocks.refetchOwner }),
  useSpinAuthoringGeometryResource: () => ({ data: { revision: mocks.geometryRevision,
    objects: [{ id: "stack", regions: [{ region_id: "n" }, { region_id: "f" }] }], current_transports: [], spin_transports: [],
  }, status: mocks.geometryStatus, error: null, refreshError: mocks.geometryError, refetch: mocks.refetchGeometry }),
  useSpinInterfaceMeshEvidenceResource: () => ({ data: null, status: "idle", refetch: vi.fn() }),
}));
vi.mock("@/kernel/resources/geometryLifecycleResources", async (original) => ({
  ...(await original<typeof import("@/kernel/resources/geometryLifecycleResources")>()), publishCommittedSceneResource: vi.fn(),
}));
vi.mock("@/kernel/resources/useSessionStatus", () => ({
  useSessionResourceIdentity: () => ({ sessionId: "interface-test", sessionEpoch: "1", requestScopeEpoch: "1" }),
  useSessionStatusSelector: (selector: (status: unknown) => unknown) => selector({ data: { capabilities: { transport_authoring: {
    contract_version: "spin-transport-capabilities.v1", m1_one_way_steady: { authoring_allowed: true, reason: "Fixture M1", status: "semantic_only" },
  } } } }),
}));

describe("Spin Interface resource and draft ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectionRevision = mocks.ownerRevision = mocks.geometryRevision = 7;
    mocks.projectionStatus = mocks.ownerStatus = mocks.geometryStatus = "ready";
    mocks.projectionError = mocks.ownerError = mocks.geometryError = null;
    mocks.projected = [known("A"), known("B")];
    mocks.owned = [known("A"), known("B")];
  });

  it("keeps a dirty local interface until Revert and guards both selectors", async () => {
    const h = await mountInterface();
    try {
      await h.choose("Owning spin transport", "spin"); await h.choose("Interface", "A");
      await h.edit("g_up", "9");
      expect(h.sessions.getCurrentSession()?.dirty).toBe(true);
      for (const label of ["Interface", "Owning spin transport"]) expect(h.control(label).disabled).toBe(true);
      await h.choose("Interface", "B"); await h.choose("Owning spin transport", "");
      expect(h.control("Interface id").value).toBe("A");
      expect(h.control("g_up").value).toBe("9");
      expect(h.container.textContent).toContain("Apply or Revert changes before switching");
      await act(async () => h.sessions.getCurrentSession()?.reset());
      expect(h.control("Interface").disabled).toBe(false);
      await h.choose("Interface", "B"); expect(h.control("Interface id").value).toBe("B");
    } finally { await h.dispose(); }
  });

  it("keeps the owner through a pending ACK and does not reset its draft", async () => {
    const h = await mountInterface();
    try {
      await h.choose("Owning spin transport", "spin"); await h.choose("Interface", "A");
      await h.edit("g_up", "9"); await h.validate();
      let applying: Promise<boolean> | boolean | undefined;
      await act(async () => { applying = h.sessions.getCurrentSession()?.apply(); await Promise.resolve(); });
      expect(h.replace).toHaveBeenCalledTimes(1);
      await h.choose("Interface", "B"); await h.choose("Owning spin transport", "");
      await act(async () => h.sessions.getCurrentSession()?.reset());
      expect(h.control("Interface id").value).toBe("A"); expect(h.control("g_up").value).toBe("9");
      await act(async () => { h.acknowledge(); await applying; });
      expect(h.sessions.getCurrentSession()?.dirty).toBe(false);
      expect(h.control("Interface").disabled).toBe(false);
    } finally { await h.dispose(); }
  });

  it("does not overwrite newer owner fields through an older projection", async () => {
    const h = await mountInterface();
    try {
      await h.choose("Owning spin transport", "spin"); await h.choose("Interface", "A");
      mocks.ownerRevision = mocks.geometryRevision = 8;
      mocks.owned = [{ ...known("A"), g_r_Spm2: 30 }, known("B")];
      await h.render(); await h.edit("g_up", "9"); await h.validate();
      expect(h.sessions.getCurrentSession()?.valid).toBe(false);
      expect(await h.sessions.getCurrentSession()?.apply()).toBe(false);
      expect(h.replace).not.toHaveBeenCalled();
      mocks.projectionRevision = 8; mocks.projected = mocks.owned;
      await h.render(); await h.validate();
      expect(h.control("g_r").value).toBe("30"); expect(h.control("g_up").value).toBe("9");
      let applying: Promise<boolean> | boolean | undefined;
      await act(async () => { applying = h.sessions.getCurrentSession()?.apply(); await Promise.resolve(); });
      expect(h.replace).toHaveBeenCalledWith("spin", expect.objectContaining({ base_revision: 8, resource: expect.objectContaining({
        interfaces: [expect.objectContaining({ id: "A", g_up_Spm2: 9, g_r_Spm2: 30 }), known("B")],
      }) }), expect.anything());
      await act(async () => { h.acknowledge(); await applying; });
    } finally { await h.dispose(); }
  });

  it.each(["projection-stale", "projection-error", "owner-error", "geometry-error", "geometry-revision"])("guards writes with %s while retaining the draft", async (state) => {
    const h = await mountInterface();
    try {
      await h.choose("Owning spin transport", "spin"); await h.choose("Interface", "A");
      await h.edit("g_up", "9"); await h.validate();
      expect(h.sessions.getCurrentSession()?.valid).toBe(true);
      if (state === "projection-stale") mocks.projectionStatus = "stale";
      if (state === "projection-error") mocks.projectionError = new Error("Projection failed");
      if (state === "owner-error") mocks.ownerError = new Error("Owner failed");
      if (state === "geometry-error") mocks.geometryError = new Error("Geometry failed");
      if (state === "geometry-revision") mocks.geometryRevision = 6;
      await h.render();
      expect(h.sessions.getCurrentSession()?.valid).toBe(false);
      expect(await h.sessions.getCurrentSession()?.apply()).toBe(false);
      expect(h.replace).not.toHaveBeenCalled(); expect(h.control("g_up").value).toBe("9");
      expect(h.container.textContent).toContain("Confirm matching current");
    } finally { await h.dispose(); }
  });

  it("refreshes every required source and recovers from a geometry error without losing edits", async () => {
    const h = await mountInterface();
    try {
      await h.choose("Owning spin transport", "spin"); await h.choose("Interface", "A");
      await h.edit("g_up", "9"); await h.validate();
      mocks.geometryError = new Error("Geometry refresh failed"); await h.render();
      expect(h.sessions.getCurrentSession()?.valid).toBe(false);
      await act(async () => find(h.container, (element) => element.tagName === "BUTTON"
        && element.textContent === "Refresh interface and mesh evidence").click());
      expect(mocks.refetchGeometry).toHaveBeenCalledTimes(1);
      expect(mocks.refetchProjection).toHaveBeenCalledTimes(1);
      expect(mocks.refetchOwner).toHaveBeenCalledTimes(1);
      mocks.geometryError = null; await h.render(); await h.validate();
      expect(h.sessions.getCurrentSession()).toMatchObject({ valid: true, dirty: true });
      expect(h.control("g_up").value).toBe("9"); expect(h.replace).not.toHaveBeenCalled();
    } finally { await h.dispose(); }
  });

  it("resolves stable interface ID before a stale positional index after reorder", async () => {
    const h = await mountInterface({ kind: "physics.spin-interface", nodeId: "A", objectId: null, label: "A", moduleSource: "explorer",
      ref: { kind: "physics.spin-interface", nodeId: "A", type: "spin-interface", spinInterfaceOwnerId: "spin", spinInterfaceId: "A", spinInterfaceIndex: 0 } });
    try {
      mocks.projected = [known("B"), known("A")]; await h.render();
      expect(h.control("Interface id").value).toBe("A");
    } finally { await h.dispose(); }
  });
});

async function mountInterface(selection: Selection = { kind: "physics.spin-interface", nodeId: "new", objectId: null, label: "New interface", moduleSource: "explorer" }) {
  const dom = installSimulationPreparationTestDom();
  const timers = new Map<number, () => void>(); let nextTimer = 0;
  Object.assign(dom.document.defaultView!, { setTimeout: (callback: () => void) => { const id = ++nextTimer; timers.set(id, callback); return id; }, clearTimeout: (id: number) => timers.delete(id) });
  const sessions = createInspectorEditSessionStore(); const container = dom.document.createElement("div");
  const { createRoot } = await import("react-dom/client"); const root = createRoot(container as unknown as Element);
  let acknowledge: (() => void) | undefined;
  const replace = vi.fn((_id: string, request: { resource: unknown; base_revision: number }) => new Promise((resolve) => {
    acknowledge = () => resolve({ resource: request.resource, scene_revision: request.base_revision + 1, committed_scene: { revision: request.base_revision + 1 } });
  }));
  const kernel = { api: { model: { replaceSpinTransport: replace, validateTransport: vi.fn(async () => ({ semantic: { valid: true, issues: [] },
    execution: { authoring_allowed: true, reason: "Fixture validation", qualification: "semantic_only" } })) } },
    commands: { getSessionScopeKey: () => scope }, resources: { invalidate: vi.fn() }, selection: { get: () => null },
  } as unknown as KernelApi;
  const render = () => act(async () => root.render(<KernelContext.Provider value={kernel}><InspectorEditSessionProvider store={sessions}>
    <SpinInterfaceInspectorPanel selection={selection} />
  </InspectorEditSessionProvider></KernelContext.Provider>));
  await render();
  const control = (label: string) => find(container, (element) => element.getAttribute("aria-label") === label);
  return { container, control, sessions, replace, render,
    choose: (label: string, value: string) => act(async () => { const element = control(label); element.value = value; element.dispatchEvent(new TestEvent("change", { bubbles: true })); }),
    edit: (label: string, value: string) => act(async () => { const element = control(label); const setter = Object.getOwnPropertyDescriptor(TestElement.prototype, "value")?.set;
      if (!setter) throw new Error("Missing native input setter"); setter.call(element, value); element.dispatchEvent(new TestEvent("input", { bubbles: true })); }),
    validate: () => act(async () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach((callback) => callback()); await Promise.resolve(); }),
    acknowledge: () => { if (!acknowledge) throw new Error("No interface write pending"); acknowledge(); },
    dispose: async () => { await act(async () => root.unmount()); dom.restore(); },
  };
}

function find(node: TestNode, predicate: (element: TestElement) => boolean): TestElement {
  if (node instanceof TestElement && predicate(node)) return node;
  for (const child of node.childNodes) { try { return find(child, predicate); } catch { /* Continue through siblings. */ } }
  throw new Error("Missing interface control");
}
