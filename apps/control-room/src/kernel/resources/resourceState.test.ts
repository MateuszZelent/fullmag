import { describe, expect, it } from "vitest";

import {
  markResourceError,
  markResourceLoading,
  markResourceReady,
  resourceDataRevision,
  resourceHasDisplayableData,
  type ResourceState,
} from "./resourceState";

describe("resource state transitions", () => {
  it("keeps current data stale while a newer revision is loading", () => {
    const current: ResourceState<{ value: string }> = {
      data: { value: "old" },
      error: null,
      revision: 1,
      status: "ready",
    };

    expect(markResourceLoading(current, 2)).toEqual({
      data: { value: "old" },
      dataRevision: 1,
      error: null,
      revision: 2,
      status: "stale",
    });
  });

  it("keeps stale data visible when a refresh fails", () => {
    const error = new Error("offline");
    const current = markResourceReady(
      {
        data: null,
        error: null,
        revision: null,
        status: "loading",
      },
      { value: "fresh" },
      3,
    );

    expect(markResourceError(current, error)).toEqual({
      data: { value: "fresh" },
      dataRevision: 3,
      error,
      revision: 3,
      status: "error",
    });
  });

  it("surfaces a failed refresh while the previous payload stays visible (LR-09)", () => {
    const error = new Error("offline");
    const failed: ResourceState<{ value: string }> = {
      data: { value: "old" },
      error,
      revision: 1,
      status: "error",
    };

    const next = markResourceLoading(failed, 2);

    expect(next.status).toBe("stale");
    expect(next.data).toEqual({ value: "old" });
    expect(next.error).toBeNull();
    expect(next.refreshError).toBe(error);
  });

  it("keeps reporting the failed refresh across further retries", () => {
    const error = new Error("offline");
    const first = markResourceLoading(
      { data: { value: "old" }, error, revision: 1, status: "error" },
      2,
    );

    expect(markResourceLoading(first, 3).refreshError).toBe(error);
  });

  it("clears the failed refresh once new data arrives", () => {
    const error = new Error("offline");
    const stale = markResourceLoading(
      { data: { value: "old" }, error, revision: 1, status: "error" },
      2,
    );

    expect(markResourceReady(stale, { value: "new" }, 2).refreshError).toBeUndefined();
  });

  it("does not invent a refresh error when there is nothing to keep showing", () => {
    const next = markResourceLoading(
      { data: null, error: new Error("offline"), revision: 1, status: "error" },
      2,
    );

    expect(next.status).toBe("loading");
    expect(next.refreshError).toBeUndefined();
  });

  it("keeps the data revision stable across repeated background refreshes", () => {
    const ready = markResourceReady<{ value: string }>(
      { data: null, error: null, revision: null, status: "loading" },
      { value: "first" },
      "etag-1",
    );
    const firstRefresh = markResourceLoading(ready, 7);
    const secondRefresh = markResourceLoading(firstRefresh, 8);

    expect(resourceDataRevision(ready)).toBe("etag-1");
    expect(resourceDataRevision(firstRefresh)).toBe("etag-1");
    expect(resourceDataRevision(secondRefresh)).toBe("etag-1");
    expect(secondRefresh.revision).toBe(8);

    const settled = markResourceReady(secondRefresh, { value: "second" }, "etag-2");
    expect(resourceDataRevision(settled)).toBe("etag-2");
  });

  it("reports no data revision without data and falls back to revision for hand-built states", () => {
    expect(
      resourceDataRevision({ data: null, dataRevision: 4, revision: 4 }),
    ).toBeNull();
    expect(resourceDataRevision({ data: { value: "x" }, revision: 5 })).toBe(5);
    expect(
      resourceDataRevision(
        markResourceLoading(
          { data: { value: "x" }, error: null, revision: 5, status: "ready" },
          6,
        ),
      ),
    ).toBe(5);
  });

  it("treats stale data as displayable but not loading or errored states", () => {
    expect(resourceHasDisplayableData({ data: { v: 1 }, status: "ready" })).toBe(true);
    expect(resourceHasDisplayableData({ data: { v: 1 }, status: "stale" })).toBe(true);
    expect(resourceHasDisplayableData({ data: null, status: "stale" })).toBe(false);
    expect(resourceHasDisplayableData({ data: { v: 1 }, status: "error" })).toBe(false);
    expect(resourceHasDisplayableData({ data: null, status: "loading" })).toBe(false);
  });
});
