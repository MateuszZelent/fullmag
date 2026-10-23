import { act, type ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KernelContext } from "@/kernel/KernelContext";
import type { KernelApi } from "@/kernel/types";
import type { ResourceStatus } from "@/kernel/resources/resourceTypes";
import { installSimulationPreparationTestDom, TestElement, TestEvent, type TestNode } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { createInspectorEditSessionStore, InspectorEditSessionProvider } from "../InspectorEditSession";
import { SpinAuthoringInspector } from "./SpinAuthoringInspector";

const torque = { kind: "zhang_li", id: "A", current_density: [1, 0, 0], degree: 0.4, beta: 0.01 };
const oersted = { kind: "oersted_cylinder", id: "A", center: [0, 0, 0], axis: [0, 0, 1], radius: 1e-9, current: 1 };
const scope = "session=spin-test&epoch=1&request_scope_epoch=1";
const state = vi.hoisted(() => ({
  revision: 7, status: "ready" as ResourceStatus, error: null as Error | null,
  torques: [] as Record<string, unknown>[], oersted: [] as Record<string, unknown>[],
  sessionId: "spin-test", historyGeneration: 0, refetch: vi.fn(),
}));
vi.mock("@/kernel/resources/spinAuthoringResources", async (original) => ({
  ...(await original<typeof import("@/kernel/resources/spinAuthoringResources")>()),
  invalidateSpinAuthoringResources: vi.fn(),
  useCurrentTransportsResource: () => ({ data: { items: [], scene_revision: state.revision }, status: "ready", refetch: state.refetch }),
  useSpinTorquesResource: () => ({ data: { items: state.torques, scene_revision: state.revision }, status: state.status, error: null, refreshError: state.error, refetch: state.refetch }),
  useOerstedFieldsResource: () => ({ data: { items: state.oersted, scene_revision: state.revision }, status: state.status, error: null, refreshError: state.error, refetch: state.refetch }),
}));
vi.mock("@/kernel/resources/useSessionStatus", () => ({
  useSessionResourceIdentity: () => ({ sessionId: state.sessionId, sessionEpoch: "1", requestScopeEpoch: "1" }),
  useSessionStatusSelector: (selector: (status: unknown) => unknown) => selector({ data: { capabilities: { transport_authoring: {
    m1_one_way_steady: { authoring_allowed: true, reason: "Fixture M1", status: "semantic_only" },
  } } } }),
}));

describe("Spin Torque and Oersted revision fences", () => {
  beforeEach(() => {
    vi.clearAllMocks(); state.revision = 7; state.status = "ready"; state.error = null;
    state.sessionId = "spin-test"; state.historyGeneration = 0;
    state.torques = [torque, { ...torque, id: "B", degree: 0.8 }];
    state.oersted = [oersted, { ...oersted, id: "B", current: 2 }];
  });
  it.each([
    { family: "spin_torque", action: "save" }, { family: "spin_torque", action: "delete" },
    { family: "oersted_field", action: "save" }, { family: "oersted_field", action: "delete" },
  ] as const)("does not raise a stale $family $action payload to a newer history revision", async ({ family, action }) => {
    const h = await mountSpin(family, 8);
    try {
      if (action === "save") await h.edit(family === "spin_torque" ? "Polarization degree" : "Current", "0.5");
      await h.validate();
      expect(h.sessions.getCurrentSession()?.valid).toBe(true);
      await act(async () => {
        if (action === "save") expect(await h.sessions.getCurrentSession()?.apply()).toBe(false);
        else h.button("Delete").click();
      });
      expect(h.scene).toHaveBeenCalledTimes(1);
      expect(h.replace).not.toHaveBeenCalled(); expect(h.remove).not.toHaveBeenCalled();
      expect(h.container.textContent).toContain("Scene revision changed before authoring");
      if (action === "save") expect(h.sessions.getCurrentSession()?.dirty).toBe(true);
    } finally { await h.dispose(); }
  });

  it.each(["spin_torque", "oersted_field"] as const)("retains the validated revision when history matches for %s", async (family) => {
    const h = await mountSpin(family, 7);
    try {
      await h.edit(family === "spin_torque" ? "Polarization degree" : "Current", "0.5"); await h.validate();
      await act(async () => { expect(await h.sessions.getCurrentSession()?.apply()).toBe(true); });
      expect(h.replace).toHaveBeenCalledExactlyOnceWith("A", expect.objectContaining({ base_revision: 7 }), expect.objectContaining({ sessionScopeKey: scope }));
      expect(h.container.textContent).toContain("Authoring resource committed");
    } finally { await h.dispose(); }
  });
  it.each(["spin_torque", "oersted_field"] as const)("preserves later raw edits through the %s ACK and its resource refresh", async (family) => {
    const h = await mountSpin(family, 7, { deferred: true });
    const fields = fieldNames(family);
    try {
      await h.edit(fields.primary, "0.5"); await h.validate();
      let applying: Promise<boolean> | boolean | undefined;
      await act(async () => { applying = h.sessions.getCurrentSession()?.apply(); });
      expect(h.replace).toHaveBeenCalledTimes(1);
      await h.edit(fields.secondary, fields.later);
      await act(async () => { expect(await h.sessions.getCurrentSession()?.apply()).toBe(false); await h.sessions.getCurrentSession()?.reset(); });
      expect(h.control(fields.secondary).value).toBe(fields.later);
      await act(async () => { h.acknowledge(); await applying; });
      expect(h.sessions.getCurrentSession()).toMatchObject({ dirty: true, valid: false });
      expect(h.control(fields.secondary).value).toBe(fields.later);
      setIncoming(family, h.replace.mock.calls[0]![1].resource as Record<string, unknown>, 8);
      await h.render(); await h.validate();
      expect(h.control(fields.secondary).value).toBe(fields.later);
      expect(h.sessions.getCurrentSession()).toMatchObject({ dirty: true, valid: true });
      expect(h.replace).toHaveBeenCalledTimes(1);
    } finally { await h.dispose(); }
  });

  it.each(["spin_torque", "oersted_field"] as const)("adopts independent %s updates without making adopted fields local edits", async (family) => {
    const h = await mountSpin(family, 7); const fields = fieldNames(family);
    try {
      await h.edit(fields.primary, "0.5");
      setIncoming(family, { [fields.secondaryKey]: fields.server }, 8); await h.render();
      expect(h.control(fields.primary).value).toBe("0.5");
      expect(h.control(fields.secondary).value).toBe(String(fields.server));
      await h.edit(fields.third, fields.thirdValue);
      setIncoming(family, { [fields.secondaryKey]: fields.server * 2 }, 9); await h.render();
      expect(h.control(fields.secondary).value).toBe(String(fields.server * 2));
      expect(h.control(fields.third).value).toBe(fields.thirdValue);
      expect(h.container.textContent).not.toContain("Conflicting fields");
    } finally { await h.dispose(); }
  });

  it.each(["spin_torque", "oersted_field"] as const)("keeps a same-field %s conflict blocked through other edits until Revert", async (family) => {
    const h = await mountSpin(family, 7); const fields = fieldNames(family);
    try {
      await h.edit(fields.primary, "0.5"); setIncoming(family, { [fields.primaryKey]: 0.6 }, 8); await h.render();
      expect(h.control(fields.primary).value).toBe("0.5");
      expect(h.container.textContent).toContain("Conflicting fields");
      await h.edit(fields.secondary, fields.later); await h.validate();
      expect(h.sessions.getCurrentSession()?.valid).toBe(false);
      await act(async () => { expect(await h.sessions.getCurrentSession()?.apply()).toBe(false); });
      expect(h.replace).not.toHaveBeenCalled();
      await act(async () => h.button("Revert").click());
      expect(h.control(fields.primary).value).toBe("0.6");
      expect(h.container.textContent).not.toContain("Conflicting fields");
      expect(h.sessions.getCurrentSession()?.dirty).toBe(false);
    } finally { await h.dispose(); }
  });

  it.each(["spin_torque", "oersted_field"] as const)("guards the local %s selector while dirty and unlocks it after Revert", async (family) => {
    const h = await mountSpin(family, 7, { local: true }); const fields = fieldNames(family);
    try {
      await h.choose("Resource", "A"); await h.edit(fields.primary, "0.5");
      expect(h.control("Resource").disabled).toBe(true); await h.choose("Resource", "B");
      expect(h.control(fields.id).value).toBe("A"); expect(h.control(fields.primary).value).toBe("0.5");
      await act(async () => h.button("Revert").click()); await h.choose("Resource", "B");
      expect(h.control(fields.id).value).toBe("B");
    } finally { await h.dispose(); }
  });

  it.each(["spin_torque", "oersted_field"] as const)("guards the local %s selector and duplicate Apply through a pending ACK", async (family) => {
    const h = await mountSpin(family, 7, { local: true, deferred: true }); const fields = fieldNames(family);
    try {
      await h.choose("Resource", "A"); await h.edit(fields.primary, "0.5"); await h.validate();
      let applying: Promise<boolean> | boolean | undefined;
      await act(async () => { applying = h.sessions.getCurrentSession()?.apply(); });
      await h.choose("Resource", "B");
      expect(h.control(fields.id).value).toBe("A");
      await act(async () => { expect(await h.sessions.getCurrentSession()?.apply()).toBe(false); });
      expect(h.replace).toHaveBeenCalledTimes(1);
      await act(async () => { h.acknowledge(); await applying; });
      expect(h.sessions.getCurrentSession()?.dirty).toBe(false);
      await h.choose("Resource", "B"); expect(h.control(fields.id).value).toBe("B");
    } finally { await h.dispose(); }
  });

  it.each(["owner", "session", "history"] as const)("does not publish late ACK state into a changed %s", async (change) => {
    const h = await mountSpin("spin_torque", 7, { deferred: true });
    try {
      await h.edit("Polarization degree", "0.5"); await h.validate();
      let applying: Promise<boolean> | boolean | undefined;
      await act(async () => { applying = h.sessions.getCurrentSession()?.apply(); });
      if (change === "session") state.sessionId = "other-session";
      if (change === "history") state.historyGeneration++;
      await h.render(change === "owner" ? { resourceId: "B" } : {});
      await h.edit("Non-adiabaticity beta", "7e-2");
      await act(async () => { h.acknowledge(); await applying; });
      expect(h.control("Torque id").value).toBe(change === "owner" ? "B" : "A");
      expect(h.control("Non-adiabaticity beta").value).toBe("7e-2");
      expect(h.container.textContent).not.toContain("Authoring resource committed");
    } finally { await h.dispose(); }
  });

  it("does not send a write if the target changes during candidate validation", async () => {
    const h = await mountSpin("spin_torque", 7);
    try {
      await h.edit("Polarization degree", "0.5"); await h.validate();
      let finish!: (value: Awaited<ReturnType<typeof h.validateTransport>>) => void;
      h.validateTransport.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
      let applying: Promise<boolean> | boolean | undefined;
      await act(async () => { applying = h.sessions.getCurrentSession()?.apply(); });
      await h.render({ resourceId: "B" });
      await act(async () => { finish({ semantic: { valid: true, issues: [] }, execution: { authoring_allowed: true, reason: "Fixture validation", qualification: "semantic_only" } }); await applying; });
      expect(h.replace).not.toHaveBeenCalled(); expect(h.control("Torque id").value).toBe("B");
    } finally { await h.dispose(); }
  });

  it("does not roll back a newer server revision through an older ACK", async () => {
    const h = await mountSpin("spin_torque", 7, { deferred: true });
    try {
      await h.edit("Polarization degree", "0.5"); await h.validate();
      let applying: Promise<boolean> | boolean | undefined;
      await act(async () => { applying = h.sessions.getCurrentSession()?.apply(); });
      setIncoming("spin_torque", { degree: 0.5, beta: 0.03 }, 9); await h.render();
      await h.edit("Non-adiabaticity beta", "2e-2");
      await act(async () => { h.acknowledge(); expect(await applying).toBe(false); });
      expect(h.control("Non-adiabaticity beta").value).toBe("2e-2");
      expect(h.container.textContent).toContain("newer server revision");
      expect(h.sessions.getCurrentSession()?.dirty).toBe(true);
    } finally { await h.dispose(); }
  });

  it.each(["spin_torque", "oersted_field"] as const)("retains a missing %s target draft and blocks mutation", async (family) => {
    const h = await mountSpin(family, 7); const fields = fieldNames(family);
    try {
      await h.edit(fields.primary, "0.5");
      if (family === "spin_torque") state.torques = []; else state.oersted = [];
      state.revision = 8; await h.render();
      expect(h.control(fields.id).value).toBe("A"); expect(h.control(fields.primary).value).toBe("0.5");
      expect(h.container.textContent).toContain("target is unavailable");
      await act(async () => { expect(await h.sessions.getCurrentSession()?.apply()).toBe(false); });
      expect(h.replace).not.toHaveBeenCalled();
    } finally { await h.dispose(); }
  });

  it.each(["spin_torque", "oersted_field"] as const)("blocks a retained %s refresh error and recovers without discarding edits", async (family) => {
    const h = await mountSpin(family, 7); const fields = fieldNames(family);
    try {
      await h.edit(fields.primary, "0.5"); await h.validate();
      state.error = new Error("Authoring refresh failed"); await h.render();
      expect(h.sessions.getCurrentSession()?.valid).toBe(false);
      expect(h.container.textContent).toContain("Authoring refresh failed");
      await act(async () => h.button("Refresh authoring resources").click());
      expect(state.refetch).toHaveBeenCalledTimes(2);
      state.error = null; await h.render(); await h.validate();
      expect(h.control(fields.primary).value).toBe("0.5");
      expect(h.sessions.getCurrentSession()).toMatchObject({ dirty: true, valid: true });
    } finally { await h.dispose(); }
  });

  it("adopts a created resource identity and preserves it while its catalog catches up", async () => {
    const h = await mountSpin("spin_torque", 7, { local: true, deferred: true });
    try {
      await h.edit("Torque id", "created,opaque"); await h.edit("Polarization degree", "0.5"); await h.validate();
      let applying: Promise<boolean> | boolean | undefined;
      await act(async () => { applying = h.sessions.getCurrentSession()?.apply(); });
      expect(h.create).toHaveBeenCalledTimes(1);
      await h.edit("Non-adiabaticity beta", "2e-2");
      await act(async () => { h.acknowledge(); await applying; });
      expect(h.control("Resource").value).toBe("created,opaque");
      expect(h.container.textContent).toContain("unconfirmed; preserved");
      expect(h.control("Non-adiabaticity beta").value).toBe("2e-2");
      expect(h.sessions.getCurrentSession()?.dirty).toBe(true);
      state.torques = [...state.torques, h.create.mock.calls[0]![0].resource as Record<string, unknown>]; state.revision = 8;
      await h.render(); expect(h.control("Torque id").value).toBe("created,opaque");
      expect(h.control("Non-adiabaticity beta").value).toBe("2e-2");
    } finally { await h.dispose(); }
  });

  it("does not acknowledge an earlier view after an A to B to A round trip", async () => {
    const h = await mountSpin("spin_torque", 7, { deferred: true });
    try {
      await h.edit("Polarization degree", "0.5"); await h.validate();
      let applying: Promise<boolean> | boolean | undefined;
      await act(async () => { applying = h.sessions.getCurrentSession()?.apply(); });
      await h.render({ resourceId: "B" }); await h.render({ resourceId: "A" });
      await h.edit("Non-adiabaticity beta", "7e-2");
      await act(async () => { h.acknowledge(); expect(await applying).toBe(false); });
      expect(h.control("Non-adiabaticity beta").value).toBe("7e-2");
      expect(h.container.textContent).not.toContain("Authoring resource committed");
    } finally { await h.dispose(); }
  });

  it("permits an unchanged valid new default without requiring an artificial edit", async () => {
    const h = await mountSpin("spin_torque", 7, { local: true });
    try {
      await h.validate(); expect(h.sessions.getCurrentSession()).toMatchObject({ dirty: false, valid: true });
      expect(h.button("Create").disabled).toBe(false);
      await act(async () => h.button("Create").click());
      expect(h.create).toHaveBeenCalledTimes(1);
      expect(h.control("Torque id").value).toBe("spin-torque");
    } finally { await h.dispose(); }
  });

  it("serializes two immediate Apply calls before React publishes pending state", async () => {
    const h = await mountSpin("spin_torque", 7, { deferred: true });
    try {
      await h.edit("Polarization degree", "0.5"); await h.validate();
      let first: Promise<boolean> | boolean | undefined, second: Promise<boolean> | boolean | undefined;
      await act(async () => { const session = h.sessions.getCurrentSession(); first = session?.apply(); second = session?.apply(); });
      expect(await second).toBe(false); expect(h.replace).toHaveBeenCalledTimes(1);
      await act(async () => { h.acknowledge(); await first; });
    } finally { await h.dispose(); }
  });

  it("keeps edits and blocks replay after an ACK returns the wrong identity", async () => {
    const h = await mountSpin("spin_torque", 7);
    try {
      await h.edit("Polarization degree", "0.5"); await h.validate();
      h.replace.mockResolvedValueOnce({ resource: { ...torque, id: "wrong" }, scene_revision: 8, committed_scene: { revision: 8, objects: [] } });
      await act(async () => { expect(await h.sessions.getCurrentSession()?.apply()).toBe(false); });
      expect(h.container.textContent).toContain("returned authoring definition is unconfirmed");
      expect(h.sessions.getCurrentSession()).toMatchObject({ dirty: true, valid: false });
      await act(async () => { expect(await h.sessions.getCurrentSession()?.apply()).toBe(false); });
      expect(h.replace).toHaveBeenCalledTimes(1);
      setIncoming("spin_torque", { degree: 0.5 }, 8); await h.render();
      expect(h.control("Polarization degree").value).toBe("0.5");
      expect(h.sessions.getCurrentSession()?.dirty).toBe(false);
    } finally { await h.dispose(); }
  });

  it("prefers a stable ID over a stale index after reorder", async () => {
    const h = await mountSpin("spin_torque", 7);
    try {
      await h.render({ resourceIndex: 0 }); state.torques = [...state.torques].reverse(); await h.render();
      expect(h.control("Torque id").value).toBe("A");
    } finally { await h.dispose(); }
  });

  it("fails closed when a legacy positional target changes identity", async () => {
    const h = await mountSpin("spin_torque", 7, { indexOnly: true });
    try {
      state.torques = [...state.torques].reverse(); await h.render();
      expect(h.control("Torque id").value).toBe("A");
      expect(h.container.textContent).toContain("positional identity changed");
      expect(h.sessions.getCurrentSession()?.valid).toBe(false);
    } finally { await h.dispose(); }
  });
});

function fieldNames(family: "spin_torque" | "oersted_field") {
  return family === "spin_torque"
    ? { primary: "Polarization degree", primaryKey: "degree", secondary: "Non-adiabaticity beta", secondaryKey: "beta", later: "2e-2", server: 0.03, third: "Landé g factor", thirdValue: "2", id: "Torque id" }
    : { primary: "Current", primaryKey: "current", secondary: "Radius", secondaryKey: "radius", later: "2e-9", server: 3e-9, third: "Center", thirdValue: "0, 0, 1e-9", id: "Oersted field id" };
}

function setIncoming(family: "spin_torque" | "oersted_field", patch: Record<string, unknown>, revision: number) {
  const key = family === "spin_torque" ? "torques" : "oersted";
  state[key] = state[key].map((entry) => entry.id === "A" ? { ...entry, ...patch } : entry);
  state.revision = revision;
}

async function mountSpin(family: "spin_torque" | "oersted_field", historyRevision: number,
  options: { local?: boolean; deferred?: boolean; indexOnly?: boolean } = {}) {
  const dom = installSimulationPreparationTestDom();
  const timers = new Map<number, () => void>(); let nextTimer = 0;
  Object.assign(dom.document.defaultView!, { setTimeout: (callback: () => void) => { const id = ++nextTimer; timers.set(id, callback); return id; }, clearTimeout: (id: number) => timers.delete(id) });
  const scene = vi.fn(async () => ({ revision: historyRevision, scene_revision: historyRevision, objects: [] }));
  let acknowledge: (() => void) | undefined;
  const reply = (request: { resource?: unknown; base_revision: number }) => {
    const response = { resource: request.resource, scene_revision: request.base_revision + 1, committed_scene: { revision: request.base_revision + 1, objects: [] } };
    return options.deferred ? new Promise<typeof response>((resolve) => { acknowledge = () => resolve(response); }) : Promise.resolve(response);
  };
  const replace = vi.fn((_id: string, request: { resource: unknown; base_revision: number }) => reply(request));
  const create = vi.fn((request: { resource: unknown; base_revision: number }) => reply(request));
  const remove = vi.fn((_id: string, request: { base_revision: number }) => reply(request));
  const validateTransport = vi.fn(async () => ({ semantic: { valid: true, issues: [] }, execution: { authoring_allowed: true, reason: "Fixture validation", qualification: "semantic_only" } }));
  const kernel = { api: { model: { scene, replaceSpinTorque: replace, replaceOerstedField: replace,
    createSpinTorque: create, createOerstedField: create,
    deleteSpinTorque: remove, deleteOerstedField: remove,
    validateTransport,
  } }, authoringHistory: { record: vi.fn(), getGeneration: () => state.historyGeneration }, commands: { getSessionScopeKey: () => `session=${state.sessionId}&epoch=1&request_scope_epoch=1` },
    resources: { invalidate: vi.fn() }, selection: { get: () => null },
  } as unknown as KernelApi;
  const sessions = createInspectorEditSessionStore(); const container = dom.document.createElement("div");
  const { createRoot } = await import("react-dom/client"); const root = createRoot(container as unknown as Element);
  let props: ComponentProps<typeof SpinAuthoringInspector> = { family,
    resourceId: options.local || options.indexOnly ? undefined : "A", resourceIndex: options.indexOnly ? 0 : undefined };
  const render = (next: Partial<typeof props> = {}) => act(async () => {
    props = { ...props, ...next };
    root.render(<KernelContext.Provider value={kernel}><InspectorEditSessionProvider store={sessions}>
      <SpinAuthoringInspector {...props} />
    </InspectorEditSessionProvider></KernelContext.Provider>);
  });
  await render();
  const control = (label: string) => find(container, (element) => element.getAttribute("aria-label") === label);
  return { container, sessions, scene, replace, create, remove, render, control, validateTransport,
    acknowledge: () => { if (!acknowledge) throw new Error("No authoring mutation pending"); acknowledge(); },
    choose: (label: string, value: string) => act(async () => { const select = control(label); select.value = value; select.dispatchEvent(new TestEvent("change", { bubbles: true })); }),
    button: (label: string) => find(container, (element) => element.tagName === "BUTTON" && element.textContent === label),
    edit: (label: string, value: string) => act(async () => { const input = find(container, (element) => element.getAttribute("aria-label") === label);
      const setter = Object.getOwnPropertyDescriptor(TestElement.prototype, "value")?.set; if (!setter) throw new Error("Missing input setter");
      setter.call(input, value); input.dispatchEvent(new TestEvent("input", { bubbles: true })); }),
    validate: () => act(async () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach((callback) => callback()); await Promise.resolve(); }),
    dispose: async () => { await act(async () => root.unmount()); dom.restore(); },
  };
}

function find(node: TestNode, predicate: (element: TestElement) => boolean): TestElement {
  if (node instanceof TestElement && predicate(node)) return node;
  for (const child of node.childNodes) { try { return find(child, predicate); } catch { /* Try the next subtree. */ } }
  throw new Error("Missing spin authoring control");
}
