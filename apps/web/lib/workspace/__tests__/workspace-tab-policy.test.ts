import { describe, expect, it } from "vitest";

import {
  isWebGLWorkspaceTabKind,
  resolveWorkspaceTabMountPolicy,
} from "../workspace-tab-policy";

describe("workspace tab mount policy", () => {
  it("classifies WebGL viewport tabs centrally", () => {
    expect(isWebGLWorkspaceTabKind("viewport-3d")).toBe(true);
    expect(isWebGLWorkspaceTabKind("viewport-2d")).toBe(true);
    expect(isWebGLWorkspaceTabKind("result-quantity")).toBe(true);
    expect(isWebGLWorkspaceTabKind("viewport-charts")).toBe(false);
    expect(isWebGLWorkspaceTabKind("analyze")).toBe(false);
  });

  it("keeps only the primary 3D viewport warm", () => {
    expect(
      resolveWorkspaceTabMountPolicy({
        id: "core:3d",
        kind: "viewport-3d",
        requestedMountPolicy: "active-only",
      }),
    ).toBe("hidden-mounted");
  });

  it("forces non-primary WebGL tabs to active-only even when warm mounting is requested", () => {
    expect(
      resolveWorkspaceTabMountPolicy({
        id: "core:2d",
        kind: "viewport-2d",
        requestedMountPolicy: "hidden-mounted",
      }),
    ).toBe("active-only");
    expect(
      resolveWorkspaceTabMountPolicy({
        id: "result:quantity",
        kind: "result-quantity",
        requestedMountPolicy: "hidden-mounted",
      }),
    ).toBe("active-only");
  });

  it("preserves hidden-mounted policy for non-WebGL tabs", () => {
    expect(
      resolveWorkspaceTabMountPolicy({
        kind: "analyze",
        requestedMountPolicy: "hidden-mounted",
      }),
    ).toBe("hidden-mounted");
  });
});
