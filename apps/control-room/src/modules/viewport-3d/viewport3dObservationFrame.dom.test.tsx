import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { resolveViewport3DObservationRunAvailability, useViewport3DObservationFrameMagnetization } from "./viewport3dResources";

const mocks = vi.hoisted(() => ({
  activeRunId: "run-a" as string | null, status: "ready", error: null as Error | null,
  refreshError: null as Error | null,
  identity: { sessionId: "frames", sessionEpoch: "1", requestScopeEpoch: "1" },
  field: { sourceId: "frame-a", sourceKind: "observation_frame", quantityId: "m" },
  enabled: [] as boolean[], refetchRun: vi.fn(), refetchField: vi.fn(), magnetization: vi.fn(),
}));
vi.mock("@/kernel/KernelContext", () => ({ useKernel: () => ({ api: { data: { observationFrames: { magnetization: mocks.magnetization } } } }) }));
vi.mock("@/kernel/resources/useSessionStatus", async (original) => ({
  ...(await original<typeof import("@/kernel/resources/useSessionStatus")>()),
  useSessionResourceIdentity: () => mocks.identity,
}));
vi.mock("@/kernel/resources/studyRuntimeResources", async (original) => ({
  ...(await original<typeof import("@/kernel/resources/studyRuntimeResources")>()),
  useCurrentRunResource: () => ({ data: mocks.activeRunId ? { run_id: mocks.activeRunId } : null, status: mocks.status, error: mocks.error, refreshError: mocks.refreshError, refetch: mocks.refetchRun }),
}));
vi.mock("@/kernel/resources/useResource", () => ({
  // Deliberately retain a warm payload even while disabled: the pin gate must
  // hide it rather than relying on the resource hook to clear old data.
  useResource: ({ enabled }: { enabled: boolean }) => {
    mocks.enabled.push(enabled);
    return { data: { data: mocks.field, etag: "frame-a:7", responseMetadata: null }, status: "ready", error: null, revision: "frame-a:7", refetch: mocks.refetchField };
  },
}));

describe("pinned observation active-run gate", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.enabled = []; mocks.activeRunId = "run-a";
    mocks.status = "ready"; mocks.error = null; mocks.refreshError = null;
  });

  it("hides a retained warm payload in B and restores the same pin on return to A", async () => {
    const harness = await mountField();
    try {
      expect(harness.value().data).toBe(mocks.field);
      expect(mocks.enabled.at(-1)).toBe(true);
      mocks.activeRunId = "run-b";
      await harness.render();
      expect(mocks.enabled.at(-1)).toBe(false);
      expect(harness.value()).toMatchObject({ data: null, availableForActiveRun: false, payloadRevision: null, responseMetadata: null, status: "error" });
      expect(harness.value().error?.message).toContain("active run is run-b");
      await harness.render(); // A retained payload cannot reopen the gate.
      expect(harness.value().data).toBeNull();
      mocks.activeRunId = "run-a";
      await harness.render();
      expect(harness.value().data).toBe(mocks.field);
      expect(mocks.enabled.at(-1)).toBe(true);
    } finally { await harness.dispose(); }
  });

  it.each(["loading", "stale", "error", "refresh-error", "no-run"])("does not adopt cached data while run identity is unconfirmed: %s", async (state) => {
    if (state === "no-run") mocks.activeRunId = null;
    else if (state === "refresh-error") { mocks.status = "stale"; mocks.refreshError = new Error("Run refresh failed"); }
    else mocks.status = state;
    if (state === "error") mocks.error = new Error("Run load failed");
    const harness = await mountField();
    try {
      expect(mocks.enabled.at(-1)).toBe(false);
      expect(harness.value().data).toBeNull();
      expect(harness.value().availableForActiveRun).toBe(false);
      harness.value().refetch();
      expect(mocks.refetchRun).toHaveBeenCalledTimes(1);
      expect(mocks.refetchField).not.toHaveBeenCalled();
    } finally { await harness.dispose(); }
  });

  it("rejects a pin without run identity", () => {
    expect(resolveViewport3DObservationRunAvailability(null, { data: null, status: "ready", error: null })).toMatchObject({ available: false, status: "error" });
  });
});

async function mountField() {
  const dom = installSimulationPreparationTestDom();
  const container = dom.document.createElement("div");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container as unknown as Element);
  let current: ReturnType<typeof useViewport3DObservationFrameMagnetization> | null = null;
  function Probe() {
    const value = useViewport3DObservationFrameMagnetization("frame-a", true, "run-a");
    current = value;
    return <span>{value.data ? "historical field" : value.runStatusMessage}</span>;
  }
  const render = () => act(async () => root.render(<Probe />));
  await render();
  return {
    render,
    value: () => { if (!current) throw new Error("Observation probe is not mounted"); return current; },
    dispose: async () => { await act(async () => root.unmount()); dom.restore(); },
  };
}
