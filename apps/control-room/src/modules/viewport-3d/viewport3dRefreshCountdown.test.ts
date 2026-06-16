import { describe, expect, it } from "vitest";

import {
  EMPTY_VIEWPORT_3D_REFRESH_SAMPLE,
  resolveViewport3DRefreshCountdownDisplay,
  resolveViewport3DRefreshCountdownNextTickDelay,
  updateViewport3DRefreshSample,
} from "./viewport3dRefreshCountdown";

describe("viewport3dRefreshCountdown", () => {
  it("counts down from the observed field refresh interval", () => {
    const first = updateViewport3DRefreshSample(
      EMPTY_VIEWPORT_3D_REFRESH_SAMPLE,
      { nowMs: 1_000, revision: "field-a", status: "ready" },
    );
    const second = updateViewport3DRefreshSample(first, {
      nowMs: 2_000,
      revision: "field-b",
      status: "ready",
    });

    const display = resolveViewport3DRefreshCountdownDisplay({
      enabled: true,
      nowMs: 2_700,
      sample: second,
      status: "ready",
    });

    expect(display).toMatchObject({
      detail: "0.3s",
      state: "counting",
      title: "Next field sync",
    });
    expect(display?.progress).toBeGreaterThan(0.65);
    expect(display?.progress).toBeLessThan(0.75);
  });

  it("flashes as updated immediately after a new field revision arrives", () => {
    const sample = updateViewport3DRefreshSample(
      EMPTY_VIEWPORT_3D_REFRESH_SAMPLE,
      { nowMs: 1_000, revision: 12, status: "ready" },
    );

    expect(
      resolveViewport3DRefreshCountdownDisplay({
        enabled: true,
        nowMs: 1_100,
        sample,
        status: "ready",
      }),
    ).toMatchObject({
      detail: "updated",
      progress: 1,
      state: "updated",
    });
  });

  it("shows syncing while the resource is stale or loading", () => {
    expect(
      resolveViewport3DRefreshCountdownDisplay({
        enabled: true,
        nowMs: 1_000,
        sample: EMPTY_VIEWPORT_3D_REFRESH_SAMPLE,
        status: "stale",
      }),
    ).toMatchObject({
      detail: "syncing",
      state: "syncing",
    });
  });

  it("is hidden when field refresh telemetry is disabled", () => {
    expect(
      resolveViewport3DRefreshCountdownDisplay({
        enabled: false,
        nowMs: 1_000,
        sample: EMPTY_VIEWPORT_3D_REFRESH_SAMPLE,
        status: "ready",
      }),
    ).toBeNull();
  });

  it("schedules only meaningful countdown ticks instead of a fixed 100 ms loop", () => {
    const sample = updateViewport3DRefreshSample(
      EMPTY_VIEWPORT_3D_REFRESH_SAMPLE,
      { nowMs: 1_000, revision: 12, status: "ready" },
    );

    expect(
      resolveViewport3DRefreshCountdownNextTickDelay({
        enabled: true,
        nowMs: 1_100,
        sample,
        status: "ready",
      }),
    ).toBe(550);
    expect(
      resolveViewport3DRefreshCountdownNextTickDelay({
        enabled: true,
        nowMs: 1_700,
        sample,
        status: "ready",
      }),
    ).toBe(300);
    expect(
      resolveViewport3DRefreshCountdownNextTickDelay({
        enabled: true,
        nowMs: 2_100,
        sample,
        status: "ready",
      }),
    ).toBeNull();
    expect(
      resolveViewport3DRefreshCountdownNextTickDelay({
        enabled: true,
        nowMs: 1_100,
        sample,
        status: "loading",
      }),
    ).toBeNull();
  });
});
