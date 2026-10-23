import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { KernelContext } from "@/kernel/KernelContext";
import type { KernelApi } from "@/kernel/types";
import { installSimulationPreparationTestDom, TestElement, TestEvent, type TestNode } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { createInspectorEditSessionStore, InspectorEditSessionProvider } from "../InspectorEditSession";
import { TransportAuthoringInspector } from "./TransportAuthoringInspector";

const scope = "session=transport-test&epoch=1&request_scope_epoch=1";
const items = ["A", "B"].map((id) => ({
  id, schema_version: "spin_transport.v1", current_source_id: "charge", mode: "steady",
  domain: [], materials: [], interfaces: [], boundaries: [],
  constitutive_version: "transport_constitutive.one_way.fullmag.v1",
  requested_execution: { device: "cpu", discretization: "fdm", execution_mode: "strict", precision: "double" },
  solver: { default_external_boundary: "spin_insulating", engine: "gmres", linear: { absolute_tolerance: 0, max_iterations: 1000, relative_tolerance: 1e-10 }, operator_version: "fv_spin_upwind_v1", physical_residual_version: "transport_balance_integrated_l2.v1" },
}));

vi.mock("@/kernel/resources/spinAuthoringResources", async (original) => ({
  ...(await original<typeof import("@/kernel/resources/spinAuthoringResources")>()),
  invalidateSpinAuthoringResources: vi.fn(),
  useSpinAuthoringGeometryResource: () => ({ data: { revision: 7, objects: [], current_transports: [], spin_transports: items }, status: "ready" }),
  useCurrentTransportsResource: () => ({ data: { items: [], scene_revision: 7 }, status: "ready" }),
  useSpinTransportsResource: () => ({ data: { items, scene_revision: 7 }, status: "ready" }),
}));
vi.mock("@/kernel/resources/geometryLifecycleResources", async (original) => ({
  ...(await original<typeof import("@/kernel/resources/geometryLifecycleResources")>()),
  publishCommittedSceneResource: vi.fn(),
}));
vi.mock("@/kernel/resources/useSessionStatus", () => ({
  useSessionResourceIdentity: () => ({ sessionId: "transport-test", sessionEpoch: "1", requestScopeEpoch: "1" }),
  useSessionStatusSelector: (selector: (status: unknown) => unknown) => selector({ data: { capabilities: { transport_authoring: {
    contract_version: "spin-transport-capabilities.v1",
    m1_one_way_steady: { authoring_allowed: true, reason: "Fixture M1", status: "semantic_only" },
  } } }, status: "ready" }),
}));

describe("transport resource owner switching", () => {
  it("preserves a dirty resource until Revert and then permits a clean switch", async () => {
    const harness = await mountTransport();
    try {
      await harness.choose("Resource", "id:A");
      await harness.choose("Requested device", "auto");
      expect(harness.sessions.getCurrentSession()?.dirty).toBe(true);
      expect(harness.control("Resource").disabled).toBe(true);
      expect(harness.container.textContent).toContain("Apply or Revert changes before switching resources.");
      await harness.choose("Resource", "id:B");
      expect(harness.control("Id").value).toBe("A");
      expect(harness.control("Requested device").value).toBe("auto");
      await act(async () => harness.sessions.getCurrentSession()?.reset());
      expect(harness.control("Resource").disabled).toBe(false);
      await harness.choose("Resource", "id:B");
      expect(harness.control("Id").value).toBe("B");
      expect(harness.control("Requested device").value).toBe("cpu");
    } finally { await harness.dispose(); }
  });

  it("keeps the resource owner through a pending ACK and unlocks after accepted Apply", async () => {
    const harness = await mountTransport();
    try {
      await harness.choose("Resource", "id:A");
      await harness.choose("Requested device", "auto");
      await harness.validate();
      expect(harness.sessions.getCurrentSession()?.valid).toBe(true);
      let applying: Promise<boolean> | undefined;
      await act(async () => { applying = harness.sessions.getCurrentSession()?.apply(); await Promise.resolve(); });
      expect(harness.replace).toHaveBeenCalledTimes(1);
      expect(harness.control("Resource").disabled).toBe(true);
      await harness.choose("Resource", "id:B");
      expect(harness.control("Id").value).toBe("A");
      await act(async () => { harness.acknowledge(); await applying; });
      expect(harness.sessions.getCurrentSession()?.dirty).toBe(false);
      expect(harness.control("Resource").disabled).toBe(false);
      await harness.choose("Resource", "id:B");
      expect(harness.control("Id").value).toBe("B");
      expect(harness.replace).toHaveBeenCalledTimes(1);
    } finally { await harness.dispose(); }
  });
});

async function mountTransport() {
  const dom = installSimulationPreparationTestDom();
  // Drive only the validation debounce; React's own task queue stays real.
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  Object.assign(dom.document.defaultView!, {
    setTimeout: (callback: () => void) => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: (id: number) => timers.delete(id),
  });
  const sessions = createInspectorEditSessionStore();
  const container = dom.document.createElement("div");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container as unknown as Element);
  let acknowledge: (() => void) | undefined;
  const replace = vi.fn((_id: string, request: { resource: unknown }) => new Promise((resolve) => {
    acknowledge = () => resolve({ resource: request.resource, scene_revision: 8, committed_scene: { revision: 8 } });
  }));
  const kernel = {
    api: { model: { replaceSpinTransport: replace, validateTransport: vi.fn(async () => ({ semantic: { valid: true, issues: [] }, execution: { authoring_allowed: true, reason: "Fixture validation", qualification: "semantic_only" } })) } },
    commands: { getSessionScopeKey: () => scope },
    resources: { invalidate: vi.fn() }, selection: { get: () => null },
  } as unknown as KernelApi;
  await act(async () => root.render(
    <KernelContext.Provider value={kernel}><InspectorEditSessionProvider store={sessions}>
      <TransportAuthoringInspector family="spin_transport" />
    </InspectorEditSessionProvider></KernelContext.Provider>,
  ));
  const control = (label: string) => find(container, (element) => element.getAttribute("aria-label") === label);
  return {
    container, control, sessions, replace,
    choose: async (label: string, value: string) => act(async () => {
      const select = control(label); select.value = value; select.dispatchEvent(new TestEvent("change", { bubbles: true }));
    }),
    validate: async () => act(async () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach((callback) => callback()); await Promise.resolve(); }),
    acknowledge: () => { if (!acknowledge) throw new Error("No transport write is pending"); acknowledge(); },
    dispose: async () => { await act(async () => root.unmount()); dom.restore(); },
  };
}

function find(node: TestNode, predicate: (element: TestElement) => boolean): TestElement {
  if (node instanceof TestElement && predicate(node)) return node;
  for (const child of node.childNodes) { try { return find(child, predicate); } catch { /* Continue through the next subtree. */ } }
  throw new Error("Missing transport control");
}
