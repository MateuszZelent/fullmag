import { afterEach, describe, expect, it, vi } from "vitest";

import { instanceTabVisibility } from "@/kernel/layout/instanceTabVisibility";

import {
  createHiddenDocumentResourcePauseController,
  createHiddenInstanceTabResourcePauseController,
  isSessionDataPlaneResourceKey,
} from "./hiddenInstanceTabResourcePolicy";
import { ResourceRuntimeStore } from "./ResourceRuntimeStore";

afterEach(() => instanceTabVisibility.resetForTests());

describe("createHiddenInstanceTabResourcePauseController", () => {
  it("holds one pause of every resource while the tab is hidden", () => {
    const release = vi.fn();
    const beginPauseMatching = vi.fn(() => release);
    const stop = createHiddenInstanceTabResourcePauseController({
      runtimeStore: { beginPauseMatching },
    });
    expect(beginPauseMatching).not.toHaveBeenCalled();

    instanceTabVisibility.setVisible(false);
    instanceTabVisibility.setVisible(false);
    expect(beginPauseMatching).toHaveBeenCalledTimes(1);
    const predicate = (beginPauseMatching.mock.calls[0] as unknown as [(key: string) => boolean])[0];
    expect(predicate("/v2/sessions/current/status")).toBe(true);
    expect(predicate("/v2/sessions/current/data/fields")).toBe(true);

    instanceTabVisibility.setVisible(true);
    expect(release).toHaveBeenCalledTimes(1);

    instanceTabVisibility.setVisible(false);
    stop();
    expect(beginPauseMatching).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
    instanceTabVisibility.setVisible(true);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("starts paused when the tab is already hidden", () => {
    instanceTabVisibility.setVisible(false);
    const beginPauseMatching = vi.fn(() => () => {});
    createHiddenInstanceTabResourcePauseController({ runtimeStore: { beginPauseMatching } })();
    expect(beginPauseMatching).toHaveBeenCalledTimes(1);
  });

  it("defers loads while hidden and loads the latest request once on return", async () => {
    const store = new ResourceRuntimeStore<string>();
    const stop = createHiddenInstanceTabResourcePauseController({ runtimeStore: store });
    const resourceKey = "/v2/sessions/current/status";
    const load = vi.fn(async () => "status");

    instanceTabVisibility.setVisible(false);
    await store.ensureLoad({ externalRevision: 1, load, resolveRevision: () => 1, resourceKey });
    await store.ensureLoad({ externalRevision: 2, load, resolveRevision: () => 2, resourceKey });
    expect(load).not.toHaveBeenCalled();

    instanceTabVisibility.setVisible(true);
    await vi.waitFor(() => expect(store.getSnapshot(resourceKey)).toMatchObject({ status: "ready" }));
    expect(load).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot(resourceKey)).toMatchObject({ data: "status", revision: 2 });
    stop();
  });
});

class FakeDocumentVisibility {
  hidden = false;
  private readonly listeners = new Set<() => void>();
  addEventListener(_type: "visibilitychange", listener: () => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: "visibilitychange", listener: () => void): void {
    this.listeners.delete(listener);
  }
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    for (const listener of this.listeners) listener();
  }
}

describe("createHiddenDocumentResourcePauseController", () => {
  it("pauses only data-plane resources while the browser tab is hidden", () => {
    expect(isSessionDataPlaneResourceKey("/v2/sessions/current/status")).toBe(false);
    expect(
      isSessionDataPlaneResourceKey(
        "session=s&epoch=1|/v2/sessions/current/data/fields/m/samples/vector?component=full",
      ),
    ).toBe(true);
    expect(
      isSessionDataPlaneResourceKey("/v2/sessions/current/data/fields#viewport-3d:part-field-vectors:a"),
    ).toBe(true);

    const visibility = new FakeDocumentVisibility();
    const release = vi.fn();
    const beginPauseMatching = vi.fn(() => release);
    const stop = createHiddenDocumentResourcePauseController({
      runtimeStore: { beginPauseMatching },
      visibility,
    });
    expect(beginPauseMatching).not.toHaveBeenCalled();

    visibility.setHidden(true);
    visibility.setHidden(true);
    expect(beginPauseMatching).toHaveBeenCalledWith(isSessionDataPlaneResourceKey);
    expect(beginPauseMatching).toHaveBeenCalledTimes(1);

    visibility.setHidden(false);
    expect(release).toHaveBeenCalledTimes(1);
    stop();
  });

  it("replays a data-plane load interrupted by hiding the tab", async () => {
    const visibility = new FakeDocumentVisibility();
    const store = new ResourceRuntimeStore<string>();
    const stop = createHiddenDocumentResourcePauseController({ runtimeStore: store, visibility });
    const resourceKey = "/v2/sessions/current/data/fields/m/samples/vector";
    let calls = 0;
    const load = vi.fn(({ signal }: { signal: AbortSignal }) => {
      calls += 1;
      if (calls === 1) {
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      }
      return Promise.resolve("field");
    });

    void store.ensureLoad({ externalRevision: 1, load, resolveRevision: () => 1, resourceKey });
    expect(load).toHaveBeenCalledTimes(1);

    visibility.setHidden(true);
    visibility.setHidden(false);

    await vi.waitFor(() =>
      expect(store.getSnapshot(resourceKey)).toMatchObject({ data: "field", status: "ready" }),
    );
    expect(load).toHaveBeenCalledTimes(2);
    stop();
  });
});
