import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KernelContext } from "../KernelContext";
import { ControlRoomApiError } from "../api/ControlRoomApi";
import { DATA_OBSERVATION_FRAMES_PATH } from "../api/apiPaths";
import type { ObservationFrameListQuery, ObservationFrameListResource } from "../api/apiTypes";
import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import { installSimulationPreparationTestDom } from "../layout/simulationPreparationTestDom.test-support";
import { DiagnosticRecorderController } from "../performance/diagnostic-recorder/DiagnosticRecorderController";
import type { KernelApi } from "../types";
import { ResourceInvalidationController } from "./ResourceInvalidationController";
import { resetSharedResourceRuntimeStoreForTests } from "./ResourceRuntimeStore";
import { useObservationFrameListPages } from "./useObservationFrameListPages";

const session = vi.hoisted(() => ({
  identity: { sessionId: "a", sessionEpoch: "1", requestScopeEpoch: "1" },
}));
vi.mock("./useSessionStatus", () => ({
  useSessionResourceIdentity: () => session.identity,
}));

function page(prefix: string, size: number, more = false, runId = "run-a"): ObservationFrameListResource {
  const frames = Array.from({ length: size }, (_, index) => {
    const frameId = prefix + index;
    return {
      adapter_id: "fem",
      frame_id: frameId,
      run_id: runId,
      stage_id: "stage-a",
      accepted_state_ref: {
        generation: { runtime_epoch: 1, accepted_revision: index + 1 },
      },
    } as ObservationFrameListResource["frames"][number];
  });
  return { run_id: runId, frames, next_cursor: more ? frames.at(-1)!.frame_id : null };
}

describe("observation frame paging with the shared resource loader", () => {
  afterEach(() => {
    resetSharedResourceRuntimeStoreForTests();
    session.identity = { sessionId: "a", sessionEpoch: "1", requestScopeEpoch: "1" };
    vi.useRealTimers();
  });

  it("waits for the refresh acknowledgement even with a ready cache and retains one selected frame", async () => {
    const h = await mount("old9");
    try {
      await h.tick();
      await h.accept(0, page("old", 50, true));
      expect(h.ids()).toHaveLength(50);
      await act(async () => { h.read().refetch(); h.read().refetch(); });
      expect(h.read().loading).toBe(true);
      expect(h.ids()).toHaveLength(50);
      await h.tick();
      expect(h.requests.map((r) => r.query.cursor)).toEqual([undefined, undefined]);
      expect(h.ids()[0]).toBe("old0");
      await h.render("old10");
      await h.accept(1, page("new", 50, true));
      expect(h.read().loading).toBe(false);
      expect(h.ids()).toEqual([...Array.from({ length: 50 }, (_, i) => "new" + i), "old10"]);

      await h.render(null);
      expect(h.ids()).toHaveLength(50);
      await h.render("old10");
      expect(h.ids()).not.toContain("old10");
    } finally { await h.dispose(); }
  });

  it("settles an acknowledged refresh even when the API reuses the same page object", async () => {
    const h = await mount();
    try {
      const unchanged = page("same", 2);
      await h.tick();
      await h.accept(0, unchanged);
      await act(async () => h.read().refetch());
      expect(h.read().loading).toBe(true);
      await h.tick();
      await h.accept(1, unchanged);
      expect(h.read().loading).toBe(false);
      expect(h.ids()).toEqual(["same0", "same1"]);
    } finally { await h.dispose(); }
  });

  it("loads more on demand and refreshes only the loaded window as one update", async () => {
    const h = await mount();
    try {
      await h.tick();
      await h.accept(0, page("old", 2, true));
      expect(h.requests).toHaveLength(1);
      await act(async () => { h.read().loadMore(); h.read().loadMore(); });
      await h.tick();
      expect(h.requests.map((r) => r.query.cursor)).toEqual([undefined, "old1"]);
      await h.accept(1, page("older", 2, true));
      expect(h.ids()).toEqual(["old0", "old1", "older0", "older1"]);

      await act(async () => h.read().refetch());
      await h.tick();
      await h.accept(2, page("new", 2, true));
      expect(h.read().loading).toBe(true);
      expect(h.ids()).toEqual(["old0", "old1", "older0", "older1"]);
      expect(h.requests.map((r) => r.query.cursor)).toEqual([undefined, "old1", undefined, "new1"]);
      await h.accept(3, page("newer", 2, true));
      expect(h.ids()).toEqual(["new0", "new1", "newer0", "newer1"]);
      expect(h.requests).toHaveLength(4);
    } finally { await h.dispose(); }
  });

  it("keeps the previous pages after failure and retries the same cursor", async () => {
    const h = await mount();
    try {
      await h.tick();
      await h.accept(0, page("a", 2, true));
      await act(async () => h.read().loadMore());
      await h.tick();
      const failure = new ControlRoomApiError("page unavailable", 404);
      await act(async () => h.requests[1].reject(failure));
      expect(h.ids()).toEqual(["a0", "a1"]);
      expect(h.read().refreshError).toBe(failure);
      expect(h.read().loading).toBe(false);

      await act(async () => { h.read().retry(); h.read().retry(); });
      await h.tick();
      expect(h.requests.map((r) => r.query.cursor)).toEqual([undefined, "a1", "a1"]);
      await h.accept(2, page("b", 2));
      expect(h.ids()).toEqual(["a0", "a1", "b0", "b1"]);
      expect(h.read().refreshError).toBeNull();
    } finally { await h.dispose(); }
  });

  it("rejects overlapping pages and keeps the previous cursor window", async () => {
    const h = await mount();
    try {
      await h.tick();
      await h.accept(0, page("a", 2, true));
      await act(async () => h.read().loadMore());
      await h.tick();
      await h.accept(1, page("a", 1));
      expect(h.ids()).toEqual(["a0", "a1"]);
      expect(h.read().refreshError?.message).toContain("repeated a frame");
    } finally { await h.dispose(); }
  });

  it("fences a late acknowledgement by session and run identity", async () => {
    const h = await mount();
    try {
      await h.tick();
      await h.accept(0, page("a", 2, true));
      await act(async () => h.read().loadMore());
      await h.tick();
      session.identity = { sessionId: "b", sessionEpoch: "2", requestScopeEpoch: "3" };
      await h.render(null, "run-b");
      await h.tick();
      expect(h.requests[1].signal.aborted).toBe(true);
      expect(h.requests[2].sessionScopeKey).toContain("session=b&epoch=2");
      await h.accept(1, page("late-a", 2));
      expect(h.ids()).toEqual([]);
      await h.accept(2, page("new-b", 1, false, "run-b"));
      expect(h.ids()).toEqual(["new-b0"]);
    } finally { await h.dispose(); }
  });

  it("revalidates the same page window on a canonical resource revision", async () => {
    const h = await mount();
    try {
      await h.tick();
      await h.accept(0, page("a", 2));
      await act(async () => h.resources.invalidate(DATA_OBSERVATION_FRAMES_PATH, 2));
      expect(h.ids()).toEqual(["a0", "a1"]);
      await h.tick();
      await h.accept(1, page("updated", 1));
      expect(h.ids()).toEqual(["updated0"]);
    } finally { await h.dispose(); }
  });
});

async function mount(initialSelection: string | null = null) {
  vi.useFakeTimers();
  const dom = installSimulationPreparationTestDom();
  const element = dom.document.createElement("div");
  const root = createRoot(element as unknown as Element);
  const bus = new EventBus<KernelEventMap>();
  const resources = new ResourceInvalidationController(bus);
  const requests: Array<{
    query: ObservationFrameListQuery;
    sessionScopeKey: string | undefined;
    signal: AbortSignal;
    resolve: (value: ObservationFrameListResource) => void;
    reject: (error: Error) => void;
  }> = [];
  const list = (
    query: ObservationFrameListQuery,
    { sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal },
  ) => new Promise<ObservationFrameListResource>((resolve, reject) => {
    requests.push({ query, sessionScopeKey, signal, resolve, reject });
  });
  const kernel = {
    api: { resourceCacheScope: "observation-pagination-test", data: { observationFrames: { list } } },
    bus,
    diagnosticRecorder: new DiagnosticRecorderController({ config: { enabled: false } }),
    resources,
  } as unknown as KernelApi;

  let value: ReturnType<typeof useObservationFrameListPages> | null = null;
  function Probe({ selectedFrameId, runId }: { selectedFrameId: string | null; runId: string }) {
    value = useObservationFrameListPages({ runId, selectedFrameId });
    return null;
  }
  const render = (selectedFrameId: string | null, runId = "run-a") => act(async () => {
    root.render(<StrictMode><KernelContext.Provider value={kernel}>
      <Probe selectedFrameId={selectedFrameId} runId={runId} />
    </KernelContext.Provider></StrictMode>);
  });
  await render(initialSelection);
  const read = () => {
    if (!value) throw new Error("Pager is not mounted");
    return value;
  };
  return {
    resources, requests, render, read,
    ids: () => read().data?.frames.map((frame) => frame.frame_id) ?? [],
    tick: () => act(async () => { await vi.advanceTimersByTimeAsync(0); }),
    accept: (index: number, data: ObservationFrameListResource) =>
      act(async () => requests[index].resolve(data)),
    dispose: async () => { await act(async () => root.unmount()); dom.restore(); },
  };
}
