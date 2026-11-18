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
      title: "Estimated next field sync",
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

  it("waits for another revision after the first field refresh flash", () => {
    const first = updateViewport3DRefreshSample(
      EMPTY_VIEWPORT_3D_REFRESH_SAMPLE,
      { nowMs: 1_000, revision: "field-a", status: "ready" },
    );
    const repeated = updateViewport3DRefreshSample(first, {
      nowMs: 1_700,
      revision: "field-a",
      status: "ready",
    });

    expect(repeated).toBe(first);
    expect(repeated.pulseId).toBe(1);
    expect(resolveViewport3DRefreshCountdownDisplay({
      enabled: true,
      nowMs: 1_700,
      sample: repeated,
      status: "ready",
    })).toMatchObject({
      ariaLabel: "Waiting for new field data",
      detail: "no new data",
      progress: 0,
      state: "waiting",
      title: "Field data",
    });
    expect(resolveViewport3DRefreshCountdownNextTickDelay({
      enabled: true,
      nowMs: 1_700,
      sample: repeated,
      status: "ready",
    })).toBeNull();
  });

  it("stops estimating after the second field sample becomes overdue", () => {
    const first = updateViewport3DRefreshSample(
      EMPTY_VIEWPORT_3D_REFRESH_SAMPLE,
      { nowMs: 1_000, revision: "field-a", status: "ready" },
    );
    const second = updateViewport3DRefreshSample(first, {
      nowMs: 2_000,
      revision: "field-b",
      status: "ready",
    });

    expect(second.pulseId).toBe(2);
    expect(resolveViewport3DRefreshCountdownDisplay({
      enabled: true,
      nowMs: 3_100,
      sample: second,
      status: "ready",
    })).toMatchObject({
      ariaLabel: "No new field data received",
      detail: "no new data",
      progress: 0,
      state: "waiting",
      title: "Field data",
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

  it("keeps both payload and requested revisions visible while syncing", () => {
    expect(
      resolveViewport3DRefreshCountdownDisplay({
        enabled: true,
        nowMs: 1_000,
        payloadRevision: 41,
        requestedRevision: 42,
        sample: EMPTY_VIEWPORT_3D_REFRESH_SAMPLE,
        status: "stale",
      }),
    ).toMatchObject({
      detail: "r41 → r42",
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
    const first = updateViewport3DRefreshSample(
      EMPTY_VIEWPORT_3D_REFRESH_SAMPLE,
      { nowMs: 1_000, revision: 12, status: "ready" },
    );

    expect(
      resolveViewport3DRefreshCountdownNextTickDelay({
        enabled: true,
        nowMs: 1_100,
        sample: first,
        status: "ready",
      }),
    ).toBe(550);
    expect(
      resolveViewport3DRefreshCountdownNextTickDelay({
        enabled: true,
        nowMs: 1_700,
        sample: first,
        status: "ready",
      }),
    ).toBeNull();

    const second = updateViewport3DRefreshSample(first, {
      nowMs: 2_000,
      revision: 13,
      status: "ready",
    });
    expect(second.pulseId).toBe(2);
    expect(
      resolveViewport3DRefreshCountdownNextTickDelay({
        enabled: true,
        nowMs: 2_700,
        sample: second,
        status: "ready",
      }),
    ).toBe(300);
    expect(
      resolveViewport3DRefreshCountdownNextTickDelay({
        enabled: true,
        nowMs: 3_000,
        sample: second,
        status: "ready",
      }),
    ).toBeNull();
    expect(
      resolveViewport3DRefreshCountdownNextTickDelay({
        enabled: true,
        nowMs: 2_100,
        sample: second,
        status: "loading",
      }),
    ).toBeNull();
  });
});
