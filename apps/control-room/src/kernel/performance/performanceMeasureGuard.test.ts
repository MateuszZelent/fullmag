import { describe, expect, it, vi } from "vitest";

import { installPerformanceMeasureGuard } from "./performanceMeasureGuard";

type TestMeasureFn = (
  measureName: string,
  startOrMeasureOptions?: string | PerformanceMeasureOptions,
  endMark?: string,
) => PerformanceMeasure;

function performanceMeasure(name: string): PerformanceMeasure {
  return { name } as PerformanceMeasure;
}

describe("performance measure guard", () => {
  it("retries DataCloneError measurements without the clone-heavy detail", () => {
    const calls: Array<{
      endMark?: string;
      name: string;
      options?: string | PerformanceMeasureOptions;
    }> = [];
    const measure: TestMeasureFn = vi.fn((name, options, endMark) => {
      calls.push({ endMark, name, options });
      if (typeof options === "object" && options && "detail" in options) {
        throw new DOMException(
          "Data cannot be cloned, out of memory.",
          "DataCloneError",
        );
      }
      return performanceMeasure(name);
    });
    const target = {
      measure,
    };

    expect(installPerformanceMeasureGuard(target)).toBe(true);

    expect(
      target.measure("ReactComponent", {
        detail: { props: new Array(10_000).fill("x") },
        end: 12,
        start: 4,
      }),
    ).toMatchObject({ name: "ReactComponent" });

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({
      endMark: undefined,
      name: "ReactComponent",
      options: { end: 12, start: 4 },
    });
  });

  it("does not swallow non-clone performance errors", () => {
    const measure: TestMeasureFn = vi.fn(() => {
      throw new DOMException("The mark does not exist.", "SyntaxError");
    });
    const target = {
      measure,
    };

    installPerformanceMeasureGuard(target);

    expect(() =>
      target.measure("ReactComponent", {
        detail: { props: ["small"] },
        start: "missing-start",
      }),
    ).toThrow("The mark does not exist.");
  });

  it("does not wrap the same performance target twice", () => {
    const measure: TestMeasureFn = vi.fn((name) => performanceMeasure(name));
    const target = {
      measure,
    };

    expect(installPerformanceMeasureGuard(target)).toBe(true);
    const wrapped = target.measure;

    expect(installPerformanceMeasureGuard(target)).toBe(false);
    expect(target.measure).toBe(wrapped);
  });
});
