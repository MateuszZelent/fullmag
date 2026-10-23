import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { KernelContext } from "@/kernel/KernelContext";
import type { KernelApi } from "@/kernel/types";
import { installSimulationPreparationTestDom, TestElement, TestEvent, type TestNode } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { createInspectorEditSessionStore, InspectorEditSessionProvider } from "../InspectorEditSession";
import { SpinAuthoringInspector } from "./SpinAuthoringInspector";

const torque = { kind: "zhang_li", id: "A", current_density: [1, 0, 0], degree: 0.4, beta: 0.01 };
const oersted = { kind: "oersted_cylinder", id: "A", center: [0, 0, 0], axis: [0, 0, 1], radius: 1e-9, current: 1 };
const scope = "session=spin-test&epoch=1&request_scope_epoch=1";
vi.mock("@/kernel/resources/spinAuthoringResources", async (original) => ({
  ...(await original<typeof import("@/kernel/resources/spinAuthoringResources")>()),
  invalidateSpinAuthoringResources: vi.fn(),
  useCurrentTransportsResource: () => ({ data: { items: [], scene_revision: 7 }, status: "ready" }),
  useSpinTorquesResource: () => ({ data: { items: [torque], scene_revision: 7 }, status: "ready" }),
  useOerstedFieldsResource: () => ({ data: { items: [oersted], scene_revision: 7 }, status: "ready" }),
}));
vi.mock("@/kernel/resources/useSessionStatus", () => ({
  useSessionResourceIdentity: () => ({ sessionId: "spin-test", sessionEpoch: "1", requestScopeEpoch: "1" }),
  useSessionStatusSelector: (selector: (status: unknown) => unknown) => selector({ data: { capabilities: { transport_authoring: {
    m1_one_way_steady: { authoring_allowed: true, reason: "Fixture M1", status: "semantic_only" },
  } } } }),
}));

describe("Spin Torque and Oersted revision fences", () => {
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
});

async function mountSpin(family: "spin_torque" | "oersted_field", historyRevision: number) {
  const dom = installSimulationPreparationTestDom();
  const timers = new Map<number, () => void>(); let nextTimer = 0;
  Object.assign(dom.document.defaultView!, { setTimeout: (callback: () => void) => { const id = ++nextTimer; timers.set(id, callback); return id; }, clearTimeout: (id: number) => timers.delete(id) });
  const scene = vi.fn(async () => ({ revision: historyRevision, scene_revision: historyRevision, objects: [] }));
  const replace = vi.fn(async (_id: string, request: { resource: unknown }) => ({ resource: request.resource, scene_revision: 8, committed_scene: { revision: 8, objects: [] } }));
  const remove = vi.fn(async () => ({ scene_revision: 8, committed_scene: { revision: 8, objects: [] } }));
  const kernel = { api: { model: { scene, replaceSpinTorque: replace, replaceOerstedField: replace,
    deleteSpinTorque: remove, deleteOerstedField: remove,
    validateTransport: vi.fn(async () => ({ semantic: { valid: true, issues: [] }, execution: { authoring_allowed: true, reason: "Fixture validation", qualification: "semantic_only" } })),
  } }, authoringHistory: { record: vi.fn(), getGeneration: () => 0 }, commands: { getSessionScopeKey: () => scope },
    resources: { invalidate: vi.fn() }, selection: { get: () => null },
  } as unknown as KernelApi;
  const sessions = createInspectorEditSessionStore(); const container = dom.document.createElement("div");
  const { createRoot } = await import("react-dom/client"); const root = createRoot(container as unknown as Element);
  await act(async () => root.render(<KernelContext.Provider value={kernel}><InspectorEditSessionProvider store={sessions}>
    <SpinAuthoringInspector family={family} resourceId="A" />
  </InspectorEditSessionProvider></KernelContext.Provider>));
  return { container, sessions, scene, replace, remove,
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
