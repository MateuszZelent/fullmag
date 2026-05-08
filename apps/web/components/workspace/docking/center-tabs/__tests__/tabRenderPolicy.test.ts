import { describe, expect, it } from "vitest";

import {
  resolveWorkspaceTabRenderDecision,
  shouldRenderWorkspaceTabPanel,
} from "../tabRenderPolicy";

describe("workspace center tab render policy", () => {
  it("renders the active WebGL tab", () => {
    expect(
      shouldRenderWorkspaceTabPanel(
        { id: "core:3d", kind: "viewport-3d", mountPolicy: "active-only" },
        "core:3d",
      ),
    ).toBe(true);
    expect(
      resolveWorkspaceTabRenderDecision(
        { id: "core:3d", kind: "viewport-3d", mountPolicy: "hidden-mounted" },
        "core:3d",
      ).forceMount,
    ).toBe(true);
  });

  it("unmounts hidden core viewport tabs instead of keeping WebGL alive", () => {
    expect(
      resolveWorkspaceTabRenderDecision(
        { id: "core:3d", kind: "viewport-3d", mountPolicy: "hidden-mounted" },
        "core:2d",
      ),
    ).toEqual({
      render: false,
      visible: false,
      forceMount: false,
      reason: "active-only-hidden",
    });
    expect(
      resolveWorkspaceTabRenderDecision(
        { id: "core:2d", kind: "viewport-2d", mountPolicy: "hidden-mounted" },
        "core:3d",
      ),
    ).toEqual({
      render: false,
      visible: false,
      forceMount: false,
      reason: "active-only-hidden",
    });
    expect(
      resolveWorkspaceTabRenderDecision(
        { id: "result:quantity", kind: "result-quantity", mountPolicy: "hidden-mounted" },
        "core:3d",
      ),
    ).toEqual({
      render: false,
      visible: false,
      forceMount: false,
      reason: "active-only-hidden",
    });
  });

  it("hidden-mounts only non-WebGL tabs with hidden-mounted policy", () => {
    expect(
      resolveWorkspaceTabRenderDecision(
        { id: "core:analyze", kind: "analyze", mountPolicy: "hidden-mounted" },
        "core:3d",
      ),
    ).toEqual({
      render: true,
      visible: false,
      forceMount: true,
      reason: "hidden-mounted",
    });
  });

  it("unmounts hidden non-WebGL active-only tabs", () => {
    expect(
      resolveWorkspaceTabRenderDecision(
        { id: "core:charts", kind: "viewport-charts", mountPolicy: "active-only" },
        "core:3d",
      ),
    ).toEqual({
      render: false,
      visible: false,
      forceMount: false,
      reason: "active-only-hidden",
    });
  });

  it("force-mounts an active hidden-mounted non-WebGL tab", () => {
    expect(
      resolveWorkspaceTabRenderDecision(
        { id: "core:analyze", kind: "analyze", mountPolicy: "hidden-mounted" },
        "core:analyze",
      ),
    ).toEqual({
      render: true,
      visible: true,
      forceMount: true,
      reason: "active",
    });
  });

  it("renders nothing without an active tab", () => {
    expect(
      shouldRenderWorkspaceTabPanel(
        { id: "core:3d", kind: "viewport-3d", mountPolicy: "active-only" },
        null,
      ),
    ).toBe(false);
  });
});
