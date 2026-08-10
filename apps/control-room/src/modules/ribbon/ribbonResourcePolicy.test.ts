import { describe, expect, it } from "vitest";

import {
  ribbonTabNeedsRuntimeResources,
  ribbonTabNeedsSessionStatusResources,
} from "./ribbonResourcePolicy";

describe("ribbon runtime resource policy", () => {
  it("loads runtime command resources for every tab that exposes study run controls", () => {
    expect(ribbonTabNeedsRuntimeResources("home")).toBe(true);
    expect(ribbonTabNeedsRuntimeResources("study")).toBe(true);
  });

  it("does not load runtime command resources for unrelated tabs", () => {
    expect(ribbonTabNeedsRuntimeResources("view")).toBe(false);
    expect(ribbonTabNeedsRuntimeResources("mesh")).toBe(false);
  });

  it("loads session status for Geometry lane gating without loading mesh resources", () => {
    expect(ribbonTabNeedsSessionStatusResources("geometry", false)).toBe(true);
    expect(ribbonTabNeedsSessionStatusResources("geometry", true)).toBe(true);
  });

  it("loads session status for Physics and View lane-gated controls", () => {
    expect(ribbonTabNeedsSessionStatusResources("physics", false)).toBe(true);
    expect(ribbonTabNeedsSessionStatusResources("view", false)).toBe(true);
  });

  it("keeps unrelated tabs status-free unless another resource policy needs it", () => {
    expect(ribbonTabNeedsSessionStatusResources("definitions", false)).toBe(false);
    expect(ribbonTabNeedsSessionStatusResources("view", true)).toBe(true);
  });
});
