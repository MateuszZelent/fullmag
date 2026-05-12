import { beforeEach, describe, expect, it } from "vitest";

import {
  getFrontendPerfSamples,
  recordFrontendPerfSample,
} from "../frontendPerfDebug";

describe("frontendPerfDebug", () => {
  beforeEach(() => {
    (globalThis as { window?: { __FULLMAG_FRONTEND_PERF__?: unknown } }).window = {};
  });

  it("stores only bounded scalar metadata", () => {
    recordFrontendPerfSample({
      scope: "x".repeat(220),
      phase: "update",
      durationMs: Number.POSITIVE_INFINITY,
      timestampMs: Number.NaN,
      meta: Object.fromEntries(
        Array.from({ length: 30 }, (_, index) => [
          `key-${index}`,
          index === 0 ? "v".repeat(220) : index,
        ]),
      ),
    });

    const sample = getFrontendPerfSamples()[0];

    expect(sample.scope).toHaveLength(160);
    expect(sample.durationMs).toBe(0);
    expect(sample.timestampMs).toBe(0);
    expect(Object.keys(sample.meta ?? {})).toHaveLength(24);
    expect(sample.meta?.["key-0"]).toHaveLength(160);
  });
});
