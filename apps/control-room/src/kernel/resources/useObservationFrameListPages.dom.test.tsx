import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ObservationFrameListResource } from "../api/apiTypes";
import type { ResourceResult } from "./resourceTypes";
import { installSimulationPreparationTestDom } from "../layout/simulationPreparationTestDom.test-support";
import { useObservationFrameListPages } from "./useObservationFrameListPages";
import { observationFramePage } from "./observationFramePagination.test-support";

const mocks = vi.hoisted(() => ({
  runId: "run-a", identity: { sessionId: "A", sessionEpoch: "1", requestScopeEpoch: "1" },
  snapshots: new Map<string, ResourceResult<ObservationFrameListResource>>(),
  queries: new Set<string>(), pendingRefresh: false, refetch: vi.fn(),
}));
vi.mock("../KernelContext", () => ({ useKernel: () => ({ api: { resourceCacheScope: "frame-pagination" } }) }));
vi.mock("./useSessionStatus", () => ({ useSessionResourceIdentity: () => mocks.identity }));
vi.mock("./observationFrameResources", async (original) => {
  const { useCallback, useState } = await import("react");
  return {
    ...(await original<typeof import("./observationFrameResources")>()),
    useObservationFrameListResource: ({ cursor, runId }: { cursor: string | null; runId: string }) => {
      const [, setToken] = useState(0);
      const refetch = useCallback(() => { mocks.refetch(); setToken((value) => value + 1); }, []);
      const key = `${runId}:${cursor ?? "first"}`;
      mocks.queries.add(key);
      const resource = mocks.snapshots.get(key) ?? { data: null, status: "loading", error: null, revision: null };
      return { ...resource, status: mocks.pendingRefresh ? "stale" : resource.status, refetch };
    },
  };
});

function respond(cursor: string | null, data: ObservationFrameListResource) {
  mocks.pendingRefresh = false;
  mocks.snapshots.set(`${data.run_id}:${cursor ?? "first"}`, { data, error: null, status: "ready", revision: cursor, refetch: mocks.refetch });
}

describe("useObservationFrameListPages", () => {
  beforeEach(() => {
    mocks.snapshots.clear(); mocks.queries.clear(); mocks.pendingRefresh = false;
    mocks.runId = "run-a"; mocks.identity = { sessionId: "A", sessionEpoch: "1", requestScopeEpoch: "1" };
    mocks.refetch.mockReset().mockImplementation(() => { mocks.pendingRefresh = true; });
    respond(null, observationFramePage(["1"], "1"));
  });

  it("does not request another cursor until Load more and keeps the first selected frame", async () => {
    const harness = await mountPages();
    try {
      const selected = harness.value().data!.frames[0];
      expect([...mocks.queries]).toEqual(["run-a:first"]);
      await act(async () => { harness.value().loadMore(); harness.value().loadMore(); });
      expect(harness.value().data!.frames[0]).toBe(selected);
      expect(harness.value().loading).toBe(true);
      respond("1", observationFramePage(["2"], "2")); await harness.render();
      expect(harness.ids()).toEqual(["1", "2"]);
      expect(harness.value().data!.frames[0]).toBe(selected);
      expect([...mocks.queries]).toEqual(["run-a:first", "run-a:1"]);
      expect(mocks.queries.has("run-a:2")).toBe(false);
    } finally { await harness.dispose(); }
  });

  it("retains previous frames after a failed next page and retries the same cursor", async () => {
    const harness = await mountPages();
    try {
      await act(async () => harness.value().loadMore());
      mocks.snapshots.set("run-a:1", { data: null, status: "error", error: new Error("Page unavailable"), revision: null, refetch: mocks.refetch });
      await harness.render();
      expect(harness.ids()).toEqual(["1"]);
      expect(harness.value().refreshError?.message).toBe("Page unavailable");
      await act(async () => { harness.value().retry(); harness.value().retry(); });
      expect(mocks.refetch).toHaveBeenCalledTimes(1);
      respond("1", observationFramePage(["2"])); await harness.render();
      expect(harness.ids()).toEqual(["1", "2"]);
      expect([...mocks.queries]).toEqual(["run-a:first", "run-a:1"]);
    } finally { await harness.dispose(); }
  });

  it.each([false, true])("refreshes only the loaded window with a cached next cursor: %s", async (cached) => {
    const harness = await mountPages();
    try {
      await act(async () => harness.value().loadMore());
      respond("1", observationFramePage(["2"], "2")); await harness.render();
      if (cached) respond("new", observationFramePage(["cached-old"], "cached-old"));
      await act(async () => harness.value().refetch());
      expect(harness.ids()).toEqual(["1", "2"]);
      respond(null, observationFramePage(["1", "new"], "new")); await harness.render();
      expect(harness.ids()).toEqual(["1", "2"]);
      expect(harness.value().loading).toBe(true);
      respond("new", observationFramePage(["2"], "2")); await harness.render();
      expect(harness.ids()).toEqual(["1", "new", "2"]);
      expect(harness.value().loading).toBe(false);
      expect(mocks.queries.has("run-a:2")).toBe(false);
      // A new resource key starts its own read; only a ready cached page needs
      // an explicit refetch. Neither path may accept a cached stale snapshot.
      expect(mocks.refetch).toHaveBeenCalledTimes(cached ? 2 : 1);
    } finally { await harness.dispose(); }
  });

  it.each(["run", "session"])("resets accumulated data when %s changes during pagination", async (owner) => {
    const harness = await mountPages();
    try {
      await act(async () => harness.value().loadMore());
      if (owner === "run") mocks.runId = "run-b";
      else mocks.identity = { sessionId: "B", sessionEpoch: "2", requestScopeEpoch: "2" };
      mocks.snapshots.clear(); await harness.render();
      expect(harness.value().data).toBeNull();
      // A response for an old cursor does not enter the new owner's first page.
      respond("1", observationFramePage(["late-a"])); await harness.render();
      expect(harness.value().data).toBeNull();
      respond(null, observationFramePage(["new-owner"], null, mocks.runId)); await harness.render();
      expect(harness.ids()).toEqual(["new-owner"]);
    } finally { await harness.dispose(); }
  });
});

async function mountPages() {
  const dom = installSimulationPreparationTestDom();
  const container = dom.document.createElement("div");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container as unknown as Element);
  let current: ReturnType<typeof useObservationFrameListPages> | null = null;
  function Probe() { current = useObservationFrameListPages({ runId: mocks.runId }); return null; }
  const render = () => act(async () => root.render(<Probe />));
  await render();
  const value = () => { if (!current) throw new Error("Pager not mounted"); return current; };
  return { render, value, ids: () => value().data?.frames.map((frame) => frame.frame_id), dispose: async () => { await act(async () => root.unmount()); dom.restore(); } };
}
