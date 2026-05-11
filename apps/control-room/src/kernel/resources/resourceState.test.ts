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
});
