import { describe, expect, it } from "vitest";

import {
  REACT_RENDER_PROFILE_MEASURE_PREFIX,
  recordReactRenderMeasure,
  shouldEnableReactRenderProfiler,
} from "./reactRenderProfiler";

describe("react render profiler", () => {
  it("enables profiling from the smoke global, URL flag, or local storage", () => {
    expect(shouldEnableReactRenderProfiler({ explicitFlag: true })).toBe(true);
    expect(
      shouldEnableReactRenderProfiler({
        locationSearch: "?fullmagReactProfiler=1",
      }),
    ).toBe(true);
    expect(
      shouldEnableReactRenderProfiler({
        storageValue: "1",
      }),
    ).toBe(true);
    expect(shouldEnableReactRenderProfiler()).toBe(false);
  });

  it("records render durations as fullmag performance measures", () => {
    const measures: Array<[string, PerformanceMeasureOptions]> = [];

    recordReactRenderMeasure({
      actualDuration: 12.5,
      id: "RibbonModule",
      performanceTarget: {
        measure: (name, options) => {
          measures.push([name, options]);
          return {} as PerformanceMeasure;
        },
      },
      phase: "update",
      startTime: 42,
    });

    expect(REACT_RENDER_PROFILE_MEASURE_PREFIX).toBe("fullmag.react.render.");
    expect(measures).toEqual([
      [
        "fullmag.react.render.RibbonModule.update",
        { duration: 12.5, start: 42 },
      ],
    ]);
  });
});
