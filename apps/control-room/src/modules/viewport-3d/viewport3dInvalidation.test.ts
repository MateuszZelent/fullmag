import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildViewport3DResourceFrameKey } from "./viewport3dInvalidation";

describe("buildViewport3DResourceFrameKey", () => {
  it("changes when viewport resources settle or fail", () => {
    const loading = buildViewport3DResourceFrameKey([
      { id: "scene", revision: null, status: "loading" },
      { id: "field", revision: null, status: "loading" },
    ]);
    const ready = buildViewport3DResourceFrameKey([
      { id: "scene", revision: 4, status: "ready" },
      { id: "field", revision: 9, status: "ready" },
    ]);
    const failed = buildViewport3DResourceFrameKey([
      { error: "404 /model/scene", id: "scene", revision: null, status: "error" },
      { id: "field", revision: null, status: "loading" },
    ]);

    expect(ready).not.toBe(loading);
    expect(failed).not.toBe(loading);
    expect(failed).toContain("404 /model/scene");
  });

  it("batches R3F invalidation on a microtask instead of a timer", () => {
    const source = readFileSync(
      new URL("./viewport3dBatchedInvalidate.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("queueMicrotask(flushPendingInvalidates)");
    expect(source).not.toContain("setTimeout(flushPendingInvalidates");
    expect(source).not.toContain("clearTimeout(pendingTimer)");
  });
});
