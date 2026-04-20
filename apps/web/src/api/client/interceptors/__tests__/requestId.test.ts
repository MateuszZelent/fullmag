import { describe, it, expect } from "vitest";
import { generateRequestId, applyRequestId } from "../requestId";

describe("requestId interceptor", () => {
  it("generateRequestId returns string matching fm-{base36}-{6chars}", () => {
    const id = generateRequestId();
    expect(id).toMatch(/^fm-[a-z0-9]+-[a-z0-9]{6}$/);
  });

  it("generateRequestId produces unique ids", () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateRequestId()));
    expect(ids.size).toBe(50);
  });

  it("applyRequestId sets x-request-id header", () => {
    const headers = new Headers();
    const id = applyRequestId(headers);
    expect(headers.get("x-request-id")).toBe(id);
    expect(id).toMatch(/^fm-/);
  });
});
