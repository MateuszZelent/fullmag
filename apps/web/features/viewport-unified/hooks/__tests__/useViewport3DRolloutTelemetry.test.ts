import { describe, expect, it } from "vitest";

import { buildViewport3DRolloutPerfSamples } from "../useViewport3DRolloutTelemetry";

describe("buildViewport3DRolloutPerfSamples", () => {
  it("emits one route-selected sample for primary routes", () => {
    expect(
      buildViewport3DRolloutPerfSamples({
        routeState: {
          route: "fem-3d",
          fallbackUsed: false,
        },
        cutover: true,
        timestampMs: 123,
      }),
    ).toEqual([
      {
        scope: "Viewport3DRollout",
        phase: "route-selected",
        durationMs: 0,
        timestampMs: 123,
        meta: {
          route: "fem-3d",
          fallbackUsed: false,
          cutover: true,
        },
      },
    ]);
  });

  it("emits fallback diagnostics when route selection used a fallback", () => {
    expect(
      buildViewport3DRolloutPerfSamples({
        routeState: {
          route: "fem-bounds-fallback",
          fallbackUsed: true,
        },
        cutover: false,
        timestampMs: 456,
      }).map((sample) => sample.phase),
    ).toEqual(["route-selected", "fallback-used"]);
  });
});
