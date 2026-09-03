/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import { beforeEach, describe, expect, it } from "vitest";

import { useAnalyzeStore } from "../useAnalyzeStore";

describe("useAnalyzeStore", () => {
  beforeEach(() => {
    useAnalyzeStore.setState({
      selection: {
        domain: "eigenmodes",
        tab: "spectrum",
        selectedModeIndex: null,
        sampleIndex: null,
        branchId: null,
        selectedChannel: null,
        refreshNonce: 0,
      },
      queries: {},
    });
  });

  it("increments refresh nonce", () => {
    useAnalyzeStore.getState().refresh();
    expect(useAnalyzeStore.getState().selection.refreshNonce).toBe(1);
  });

  it("stores query state by key", () => {
    const key = {
      domain: "eigenmodes" as const,
      tab: "spectrum",
      selectionFingerprint: "mode:1",
      refreshNonce: 0,
    };
    useAnalyzeStore.getState().setQuery(key, { status: "loading", requestedAt: 123 });
    const cacheKey = JSON.stringify(key);
    expect(useAnalyzeStore.getState().queries[cacheKey]?.status).toBe("loading");
    expect(useAnalyzeStore.getState().queries[cacheKey]?.requestedAt).toBe(123);
  });
});
