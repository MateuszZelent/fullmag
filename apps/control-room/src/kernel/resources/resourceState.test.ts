import { describe, expect, it } from "vitest";

import {
  markResourceError,
  markResourceLoading,
  markResourceReady,
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
});
