import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ObservationFrameResource } from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { installSimulationPreparationTestDom, TestElement, type TestNode } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { observationSourceWorkspaceStore, resetObservationSourceWorkspaceForTests } from "@/kernel/workspace/observationSourceWorkspace";
import { InspectorEditSessionProvider } from "../InspectorEditSession";
import { ObservationFrameInspectorPanel, ObservationFramesOverviewPanel } from "./ObservationFrameInspectorPanel";

const mocks = vi.hoisted(() => ({
  status: "ready", refreshError: null as Error | null, error: null as Error | null,
  frame: null as ObservationFrameResource | null,
  identity: { sessionId: "frames", sessionEpoch: "1", requestScopeEpoch: "1" },
}));
vi.mock("@/kernel/resources/observationFrameResources", () => ({
  useObservationFrameResource: () => ({ data: mocks.frame, status: mocks.status, error: mocks.error, refreshError: mocks.refreshError }),
  useObservationFrameListResource: () => ({ data: { frames: mocks.frame ? [mocks.frame] : [], next_cursor: "another-frame", run_id: "run-a" }, status: mocks.status, error: mocks.error, refreshError: mocks.refreshError }),
}));
vi.mock("@/kernel/resources/useSessionStatus", () => ({ useSessionResourceIdentity: () => mocks.identity }));

const frame: ObservationFrameResource = {
  schema_version: "observation_frame.v1", frame_id: "frame-a", status: "complete",
  run_id: "run-a", stage_id: "stage-a", task_id: "task-a", attempt_id: "attempt-a",
  ownership_epoch: 1, adapter_id: "fdm-cpu", grid_cells: [2, 2, 1], quantity_ids: ["m"],
  state_codec_id: "fullmag.fdm_cpu.observation_state", state_codec_version: "v1", magnetization_href: "/frame-a/m",
  accepted_state_ref: {
    generation: { accepted_revision: 7, runtime_epoch: 2 },
    id: { accepted_step: 10, run_id: "run-a", stage_id: "stage-a", state_digest: "state-a", clock_digest: "clock-a", domain_digest: "domain-a", plan_digest: "plan-a" },
  },
};

function selection(frameId = "frame-a"): Selection {
  const nodeId = `results:frame:${frameId}`;
  return { kind: "results.observation_frame", label: frameId, objectId: null, nodeId, ref: {
    type: "observation-frame", kind: "results.observation_frame", nodeId, frameId,
    runId: "run-a", stageId: "stage-a", adapterId: "fdm-cpu", acceptedStep: 10,
    acceptedRevision: 7, runtimeEpoch: 2, stateDigest: "state-a",
  } };
}

describe("ObservationFrameInspectorPanel pin freshness", () => {
  beforeEach(() => {
    mocks.frame = structuredClone(frame);
    mocks.status = "ready"; mocks.refreshError = null; mocks.error = null;
    resetObservationSourceWorkspaceForTests();
  });

  it.each(["loading", "stale", "error", "refresh-error"])("does not pin retained data while %s", async (state) => {
    if (state === "refresh-error") { mocks.status = "stale"; mocks.refreshError = new Error("Refresh unavailable"); }
    else mocks.status = state;
    if (state === "error") mocks.error = new Error("Frame unavailable");
    const harness = await mountPanel();
    try {
      expect(harness.button("Pin source").disabled).toBe(true);
      await act(async () => harness.button("Pin source").click());
      expect(observationSourceWorkspaceStore.getSnapshot().pinned).toBeNull();
      expect(harness.container.textContent).toContain("pinning is unavailable");
    } finally { await harness.dispose(); }
  });

  it.each(["frame", "run", "stage", "adapter", "step", "revision", "epoch", "digest"])("rejects a descriptor with different %s identity", async (part) => {
    const changed = mocks.frame!;
    if (part === "frame") changed.frame_id = "frame-b";
    if (part === "run") changed.run_id = "run-b";
    if (part === "stage") changed.stage_id = "stage-b";
    if (part === "adapter") changed.adapter_id = "fem-cpu";
    if (part === "step") changed.accepted_state_ref.id.accepted_step += 1;
    if (part === "revision") changed.accepted_state_ref.generation.accepted_revision += 1;
    if (part === "epoch") changed.accepted_state_ref.generation.runtime_epoch += 1;
    if (part === "digest") changed.accepted_state_ref.id.state_digest = "state-b";
    const harness = await mountPanel();
    try {
      expect(harness.button("Pin source").disabled).toBe(true);
      expect(harness.container.textContent).toContain("does not match the selected accepted state");
      await act(async () => harness.button("Pin source").click());
      expect(observationSourceWorkspaceStore.getSnapshot().pinned).toBeNull();
    } finally { await harness.dispose(); }
  });

  it("pins the exact ready identity and permits Unpin after refresh failure", async () => {
    const harness = await mountPanel();
    try {
      await act(async () => harness.button("Pin source").click());
      expect(observationSourceWorkspaceStore.getSnapshot().pinned).toMatchObject({ frameId: "frame-a", runId: "run-a", acceptedRevision: 7 });
      mocks.refreshError = new Error("Refresh unavailable");
      mocks.status = "stale";
      await harness.render();
      expect(harness.button("Source pinned").disabled).toBe(true);
      await act(async () => harness.button("Unpin").click());
      expect(observationSourceWorkspaceStore.getSnapshot().pinned).toBeNull();
    } finally { await harness.dispose(); }
  });

  it("does not label a first-page count as the complete catalog", async () => {
    const harness = await mountPanel(true);
    try {
      expect(harness.container.textContent).toContain("Loaded frames");
      expect(harness.container.textContent).toContain("More snapshots are available beyond this page.");
    } finally { await harness.dispose(); }
  });
});

async function mountPanel(overview = false) {
  const dom = installSimulationPreparationTestDom();
  const container = dom.document.createElement("div");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container as unknown as Element);
  const render = () => act(async () => root.render(<InspectorEditSessionProvider>
    {overview ? <ObservationFramesOverviewPanel /> : <ObservationFrameInspectorPanel selection={selection()} />}
  </InspectorEditSessionProvider>));
  await render();
  return {
    container, render,
    button: (text: string) => find(container, (element) => element.tagName === "BUTTON" && element.textContent.includes(text)),
    dispose: async () => { await act(async () => root.unmount()); dom.restore(); resetObservationSourceWorkspaceForTests(); },
  };
}

function find(node: TestNode, predicate: (element: TestElement) => boolean): TestElement {
  if (node instanceof TestElement && predicate(node)) return node;
  for (const child of node.childNodes) { try { return find(child, predicate); } catch { /* Check the next subtree. */ } }
  throw new Error("Missing observation frame control");
}
