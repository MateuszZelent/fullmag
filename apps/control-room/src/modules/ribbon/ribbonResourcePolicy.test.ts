import { describe, expect, it } from "vitest";

import { ribbonTabNeedsRuntimeResources } from "./ribbonResourcePolicy";

describe("ribbon runtime resource policy", () => {
  it("loads runtime command resources for every tab that exposes study run controls", () => {
    expect(ribbonTabNeedsRuntimeResources("home")).toBe(true);
    expect(ribbonTabNeedsRuntimeResources("study")).toBe(true);
  });

  it("does not load runtime command resources for unrelated tabs", () => {
    expect(ribbonTabNeedsRuntimeResources("view")).toBe(false);
    expect(ribbonTabNeedsRuntimeResources("mesh")).toBe(false);
  });
});
