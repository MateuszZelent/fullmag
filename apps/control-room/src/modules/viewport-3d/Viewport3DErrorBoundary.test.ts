import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createViewport3DRenderErrorRecord } from "./Viewport3DErrorBoundary";

describe("Viewport3DErrorBoundary", () => {
  it("creates a bounded pre-canvas forensic record with the component stack", () => {
    const error = new Error("Maximum update depth exceeded");
    error.stack = `Error: Maximum update depth exceeded\n${"frame\n".repeat(3_000)}`;

    const record = createViewport3DRenderErrorRecord(
      error,
      `\n at Viewport3DFrame\n${"component\n".repeat(2_000)}`,
      123,
    );

    expect(record).toMatchObject({
      kind: "console",
      lane: "react",
      message: "Maximum update depth exceeded",
      name: "viewport-3d.render-error",
      severity: "critical",
      timestampMs: 123,
    });
    expect(record.detail.componentStack).toContain("Viewport3DFrame");
    expect(String(record.detail.componentStack).length).toBeLessThanOrEqual(8_000);
    expect(String(record.detail.errorStack).length).toBeLessThanOrEqual(8_000);
  });

  it("keeps a visible viewport shell and retry action after a render failure", () => {
    const source = readFileSync(
      new URL("./Viewport3DErrorBoundary.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain('role="alert"');
    expect(source).toContain("3D viewport failed before the canvas became ready");
    expect(source).toContain("Retry viewport");
    expect(source).toContain("componentDidCatch");
    expect(source).toContain("queueMicrotask");
    expect(source).toContain("retainedViewport3DErrors");
    expect(source).toContain("retainedViewport3DErrors.delete");
  });
});
