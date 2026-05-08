import { beforeEach, describe, expect, it } from "vitest";

import {
  buildViewportFieldDataCacheKey,
  clearGlobalViewportFieldDataCache,
  getGlobalBinaryFieldCacheStats,
  getGlobalBinaryFieldFrame,
  putGlobalBinaryFieldFrame,
} from "../binaryFieldCache";

describe("global viewport field data cache", () => {
  beforeEach(() => {
    clearGlobalViewportFieldDataCache();
  });

  it("keys field data by document/runtime identity, revision, quantity, component and scope", () => {
    const base = {
      identity: {
        sessionId: "session-a",
        runId: "run-a",
        meshGenerationId: "gen:mesh-a",
      },
      fieldRevision: 12,
      quantityId: "m",
      component: "full",
      scopeKey: "full",
      nComp: 3,
      grid: [16, 8, 1],
    };

    expect(buildViewportFieldDataCacheKey(base)).toBe(
      "viewport-field:session-a:run-a:gen:mesh-a:12:m:full:full:3:16x8x1",
    );
    expect(
      buildViewportFieldDataCacheKey({
        ...base,
        identity: { ...base.identity, runId: "run-b" },
      }),
    ).not.toBe(buildViewportFieldDataCacheKey(base));
  });

  it("keeps binary frames in a module-level cache outside hook lifetime", () => {
    const key = buildViewportFieldDataCacheKey({
      identity: {
        sessionId: "session-a",
        runId: "run-a",
        meshGenerationId: "gen:mesh-a",
      },
      fieldRevision: 1,
      quantityId: "m",
      component: "full",
      scopeKey: "full",
      nComp: 3,
      grid: [1, 1, 1],
    });
    const frame = {
      key,
      quantityId: "m",
      values: new Float64Array([1, 2, 3]),
      nComp: 3,
      grid: [1, 1, 1] as [number, number, number],
    };

    putGlobalBinaryFieldFrame(frame);

    expect(getGlobalBinaryFieldFrame(key)).toBe(frame);
    expect(getGlobalBinaryFieldCacheStats().entries).toBe(1);
  });
});
