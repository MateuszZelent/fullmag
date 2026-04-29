import { describe, expect, it } from "vitest";

import {
  resolveWorkspaceTabRenderDecision,
  shouldRenderWorkspaceTabPanel,
} from "../tabRenderPolicy";

describe("workspace center tab render policy", () => {
  it("keeps WebGL viewport tabs active-only even when their state lifecycle is warm", () => {
    expect(
      shouldRenderWorkspaceTabPanel(
        { id: "core:3d", kind: "viewport-3d", lifecycle: "warm" },
        "core:3d",
      ),
    ).toBe(true);
    expect(
      shouldRenderWorkspaceTabPanel(
        { id: "core:3d", kind: "viewport-3d", lifecycle: "warm" },
        "core:2d",
      ),
    ).toBe(false);
    expect(
      shouldRenderWorkspaceTabPanel(
        { id: "core:2d", kind: "viewport-2d", lifecycle: "warm" },
        "core:3d",
      ),
    ).toBe(false);
    expect(
      shouldRenderWorkspaceTabPanel(
        { id: "result:quantity", kind: "result-quantity", lifecycle: "warm" },
        "core:3d",
      ),
    ).toBe(false);
  });

  it("preserves warm mounting for non-WebGL panels and active-only mounting for cold panels", () => {
    expect(
      shouldRenderWorkspaceTabPanel(
        { id: "core:analyze", kind: "analyze", lifecycle: "warm" },
        "core:3d",
      ),
    ).toBe(true);
    expect(
      shouldRenderWorkspaceTabPanel(
        { id: "core:charts", kind: "viewport-charts", lifecycle: "unmount-on-hide" },
        "core:3d",
      ),
    ).toBe(false);
    expect(
      shouldRenderWorkspaceTabPanel(
        { id: "core:charts", kind: "viewport-charts", lifecycle: "unmount-on-hide" },
        "core:charts",
      ),
    ).toBe(true);
    expect(
      shouldRenderWorkspaceTabPanel(
        { id: "core:3d", kind: "viewport-3d", lifecycle: "warm" },
        null,
      ),
    ).toBe(false);
  });

  it("keeps hidden WebGL tabs unmounted by default", () => {
    expect(
      resolveWorkspaceTabRenderDecision(
        { id: "core:3d", kind: "viewport-3d", lifecycle: "warm" },
        "core:charts",
        {
          enableWebGLWarmKeepAlive: false,
          recentWebGLTabId: "core:3d",
        },
      ),
    ).toEqual({
      render: false,
      visible: false,
      forceMount: false,
      reason: "unmounted",
    });
  });

  it("warm-mounts only the most recent hidden WebGL tab when explicitly enabled", () => {
    expect(
      resolveWorkspaceTabRenderDecision(
        { id: "core:3d", kind: "viewport-3d", lifecycle: "warm" },
        "core:charts",
        {
          enableWebGLWarmKeepAlive: true,
          recentWebGLTabId: "core:3d",
        },
      ),
    ).toEqual({
      render: true,
      visible: false,
      forceMount: true,
      reason: "warm-hidden",
    });

    expect(
      resolveWorkspaceTabRenderDecision(
        { id: "core:2d", kind: "viewport-2d", lifecycle: "warm" },
        "core:charts",
        {
          enableWebGLWarmKeepAlive: true,
          recentWebGLTabId: "core:3d",
        },
      ),
    ).toEqual({
      render: false,
      visible: false,
      forceMount: false,
      reason: "warm-disabled",
    });
  });

  it("falls back to unmounting hidden WebGL tabs after warm keepalive context loss", () => {
    expect(
      resolveWorkspaceTabRenderDecision(
        { id: "core:3d", kind: "viewport-3d", lifecycle: "warm" },
        "core:charts",
        {
          enableWebGLWarmKeepAlive: true,
          recentWebGLTabId: "core:3d",
          webGLWarmKeepAliveDisabledByContextLoss: true,
        },
      ),
    ).toEqual({
      render: false,
      visible: false,
      forceMount: false,
      reason: "warm-disabled",
    });
  });
});
