import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { KernelContext } from "@/kernel/KernelContext";
import type { KernelApi } from "@/kernel/types";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { installSimulationPreparationTestDom, TestElement, type TestNode } from "@/kernel/layout/simulationPreparationTestDom.test-support";

import { InspectorEditSessionProvider } from "../InspectorEditSession";
import { CouplingInspectorPanel } from "./CouplingInspectorPanel";

const mocks = vi.hoisted(() => ({
  identity: { sessionId: "A", sessionEpoch: "1", requestScopeEpoch: "1" } as { sessionId: string; sessionEpoch: string; requestScopeEpoch: string } | null,
  scope: "session=A&epoch=1&request_scope_epoch=1" as string | null,
  generation: 0,
  status: "ready",
  refreshError: null as Error | null,
  error: null as Error | null,
  patch: vi.fn(), delete: vi.fn(), sync: vi.fn(), scene: vi.fn(), record: vi.fn(),
  publish: vi.fn(), invalidate: vi.fn(),
}));

vi.mock("@/kernel/resources/useSessionStatus", () => ({ useSessionResourceIdentity: () => mocks.identity }));
vi.mock("@/kernel/resources/geometryLifecycleResources", async (original) => ({
  ...(await original<typeof import("@/kernel/resources/geometryLifecycleResources")>()),
  publishCommittedSceneResource: mocks.publish,
  useModelCouplingsResource: () => ({
    data: { scene_revision: 17, couplings: ["A", "B"].map((coupling_id) => ({ coupling_id, coupling_kind: "exchange", enabled: true, params: {} })) },
    status: mocks.status, refreshError: mocks.refreshError, error: mocks.error,
  }),
}));

const ack = { committed_scene: { revision: 18 }, scene_revision: 18 };

describe("CouplingInspectorPanel mutation ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.identity = { sessionId: "A", sessionEpoch: "1", requestScopeEpoch: "1" };
    mocks.scope = "session=A&epoch=1&request_scope_epoch=1";
    mocks.generation = 0;
    mocks.status = "ready";
    mocks.refreshError = null;
    mocks.error = null;
    mocks.patch.mockResolvedValue(ack);
    mocks.delete.mockResolvedValue(ack);
    mocks.scene.mockResolvedValue({ revision: 17 });
    mocks.sync.mockResolvedValue({});
  });

  it.each(["no-scope", "loading", "stale", "error", "refresh-error"])("blocks writes when the source is not current: %s", async (state) => {
    if (state === "no-scope") { mocks.identity = null; mocks.scope = null; }
    if (state === "loading" || state === "stale" || state === "error") mocks.status = state;
    if (state === "error") mocks.error = new Error("Cannot read couplings");
    if (state === "refresh-error") mocks.refreshError = new Error("Cannot refresh couplings");
    const harness = await mountPanel();
    try {
      expect(harness.button("Disable Coupling").disabled).toBe(true);
      expect(harness.button("Delete Coupling").disabled).toBe(true);
      await act(async () => { harness.button("Disable Coupling").click(); harness.button("Delete Coupling").click(); });
      expect(mocks.patch).not.toHaveBeenCalled();
      expect(mocks.delete).not.toHaveBeenCalled();
    } finally { await harness.dispose(); }
  });

  it("sends one scoped write before rerender and publishes/syncs only after ACK", async () => {
    const mutation = deferred<typeof ack>();
    mocks.patch.mockReturnValue(mutation.promise);
    const harness = await mountPanel();
    try {
      await act(async () => { harness.button("Disable Coupling").click(); harness.button("Disable Coupling").click(); });
      expect(mocks.patch).toHaveBeenCalledExactlyOnceWith("A", { enabled: false }, { baseRevision: 17, sessionScopeKey: mocks.scope });
      expect(harness.button("Delete Coupling").disabled).toBe(true);
      expect(mocks.publish).not.toHaveBeenCalled();
      expect(mocks.invalidate).not.toHaveBeenCalled();
      expect(mocks.sync).not.toHaveBeenCalled();
      await act(async () => { mutation.resolve(ack); await mutation.promise; });
      expect(mocks.publish).toHaveBeenCalledTimes(1);
      expect(mocks.invalidate).toHaveBeenCalledWith(expect.stringContaining("model/couplings"), 18);
      expect(mocks.invalidate).toHaveBeenCalledWith(expect.stringContaining("region-diagnostics"), 18);
      expect(mocks.sync).toHaveBeenCalledExactlyOnceWith({}, { sessionScopeKey: mocks.scope });
      expect(harness.container.textContent).toContain("Coupling updated.");
    } finally { await harness.dispose(); }
  });

  it("uses the same scoped transaction contract for Delete", async () => {
    const harness = await mountPanel();
    try {
      await act(async () => harness.button("Delete Coupling").click());
      expect(mocks.delete).toHaveBeenCalledExactlyOnceWith("A", { baseRevision: 17, sessionScopeKey: mocks.scope });
      expect(mocks.sync).toHaveBeenCalledTimes(1);
      expect(harness.container.textContent).toContain("Coupling deleted.");
    } finally { await harness.dispose(); }
  });

  it("blocks a stale resource revision before sending the write", async () => {
    mocks.scene.mockResolvedValue({ revision: 18 });
    const harness = await mountPanel();
    try {
      await act(async () => harness.button("Disable Coupling").click());
      expect(mocks.patch).not.toHaveBeenCalled();
      expect(mocks.publish).not.toHaveBeenCalled();
      expect(mocks.sync).not.toHaveBeenCalled();
      expect(harness.container.textContent).toContain("The scene changed before the coupling action.");
    } finally { await harness.dispose(); }
  });

  it("does not publish or sync an incoherent ACK", async () => {
    mocks.patch.mockResolvedValue({ scene_revision: 18, committed_scene: { revision: 19 } });
    const harness = await mountPanel();
    try {
      await act(async () => harness.button("Disable Coupling").click());
      expect(mocks.patch).toHaveBeenCalledTimes(1);
      expect(mocks.publish).not.toHaveBeenCalled();
      expect(mocks.sync).not.toHaveBeenCalled();
      expect(harness.container.textContent).toContain("The coupling ACK omitted a coherent committed scene.");
      expect(harness.container.textContent).not.toContain("Coupling updated.");
    } finally { await harness.dispose(); }
  });

  it("does not publish or sync a rejected transaction", async () => {
    mocks.patch.mockRejectedValue(new Error("Revision conflict"));
    const harness = await mountPanel();
    try {
      await act(async () => harness.button("Disable Coupling").click());
      expect(harness.container.textContent).toContain("Revision conflict");
      expect(mocks.publish).not.toHaveBeenCalled();
      expect(mocks.sync).not.toHaveBeenCalled();
    } finally { await harness.dispose(); }
  });

  it.each([false, true])("publishes an accepted same-session ACK without retargeting feedback (return to A: %s)", async (returnToA) => {
    const mutation = deferred<typeof ack>();
    mocks.patch.mockReturnValue(mutation.promise);
    const harness = await mountPanel();
    try {
      await act(async () => harness.button("Disable Coupling").click());
      await harness.render("B");
      if (returnToA) await harness.render("A");
      await act(async () => { mutation.resolve(ack); await mutation.promise; });
      expect(mocks.publish).toHaveBeenCalledTimes(1);
      expect(mocks.sync).toHaveBeenCalledTimes(1);
      expect(harness.container.textContent).not.toContain("Coupling updated.");
    } finally { await harness.dispose(); }
  });

  it("ignores stale session/history results after A to B to A", async () => {
    const mutation = deferred<typeof ack>();
    mocks.patch.mockReturnValue(mutation.promise);
    const harness = await mountPanel();
    try {
      await act(async () => harness.button("Disable Coupling").click());
      mocks.generation += 1;
      mocks.scope = "session=B&epoch=1&request_scope_epoch=1";
      mocks.identity = { sessionId: "B", sessionEpoch: "1", requestScopeEpoch: "1" };
      await harness.render("A");
      mocks.generation += 1;
      mocks.scope = "session=A&epoch=1&request_scope_epoch=1";
      mocks.identity = { sessionId: "A", sessionEpoch: "1", requestScopeEpoch: "1" };
      await harness.render("A");
      await act(async () => { mutation.resolve(ack); await mutation.promise; });
      expect(mocks.publish).not.toHaveBeenCalled();
      expect(mocks.invalidate).not.toHaveBeenCalled();
      expect(mocks.sync).not.toHaveBeenCalled();
      expect(harness.container.textContent).not.toContain("Coupling updated.");
    } finally { await harness.dispose(); }
  });

  it("reports script sync failure as a committed change without replay", async () => {
    mocks.sync.mockRejectedValue(new Error("Script sync unavailable"));
    const harness = await mountPanel();
    try {
      await act(async () => harness.button("Disable Coupling").click());
      expect(mocks.patch).toHaveBeenCalledTimes(1);
      expect(mocks.publish).toHaveBeenCalledTimes(1);
      expect(mocks.sync).toHaveBeenCalledTimes(1);
      expect(harness.container.textContent).toContain("Coupling updated.");
      expect(harness.container.textContent).toContain("Script sync unavailable");
      expect(find(harness.container, (element) => element.getAttribute("data-kind") === "warning").getAttribute("role")).toBe("alert");
    } finally { await harness.dispose(); }
  });
});

async function mountPanel() {
  const dom = installSimulationPreparationTestDom();
  const container = dom.document.createElement("div");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container as unknown as Element);
  const kernel = {
    api: { resourceCacheScope: "coupling-client", model: { patchCoupling: mocks.patch, deleteCoupling: mocks.delete, syncAuthoringScript: mocks.sync, scene: mocks.scene } },
    commands: { getSessionScopeKey: () => mocks.scope },
    resources: { invalidate: mocks.invalidate },
    selection: { get: () => null },
    authoringHistory: { getGeneration: () => mocks.generation, record: mocks.record },
  } as unknown as KernelApi;
  const render = async (id = "A") => act(async () => root.render(
    <KernelContext.Provider value={kernel}>
      <InspectorEditSessionProvider><CouplingInspectorPanel selection={selection(id)} /></InspectorEditSessionProvider>
    </KernelContext.Provider>,
  ));
  await render();
  return {
    container, render,
    button: (text: string) => find(container, (element) => element.tagName === "BUTTON" && element.textContent.includes(text)),
    dispose: async () => { await act(async () => root.unmount()); dom.restore(); },
  };
}

function selection(id: string): Selection {
  const nodeId = `model:physics:couplings:${id}`;
  return { kind: "physics.coupling", label: id, nodeId, objectId: null, ref: { type: "physics-coupling", kind: "physics.coupling", couplingId: id, nodeId } };
}

function find(node: TestNode, predicate: (element: TestElement) => boolean): TestElement {
  if (node instanceof TestElement && predicate(node)) return node;
  for (const child of node.childNodes) { try { return find(child, predicate); } catch { /* Continue through the next subtree. */ } }
  throw new Error("Missing coupling control");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}
