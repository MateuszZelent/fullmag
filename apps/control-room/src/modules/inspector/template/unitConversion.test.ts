import { describe, expect, it } from "vitest";

import {
  computeDragScrubValueSI,
  formatQuantityDisplay,
  parseQuantityInputToSI,
} from "./unitConversion";

describe("unitConversion", () => {
  it("formats SI quantities into display units with Unicode minus and clean precision", () => {
    expect(formatQuantityDisplay(8e5, 1e3)).toBe("800");
    expect(formatQuantityDisplay(8e5, 1e6)).toBe("0.8");
    const mu0ToSi = 1 / (4e-7 * Math.PI);
    expect(formatQuantityDisplay(8e5, mu0ToSi)).toMatch(/^1\.0053/);
    expect(formatQuantityDisplay(0, 1e3)).toBe("0");
    expect(formatQuantityDisplay(-0, 1e3)).toBe("0");
    expect(formatQuantityDisplay(-2.5e-3, 1)).toBe("−0.0025");
    expect(formatQuantityDisplay(-1.5e-4, 1)).toBe("−1.5e−4");
  });

  it("parses complete scientific and comma-decimal inputs while returning null for partial drafts", () => {
    expect(parseQuantityInputToSI("1.5e-", 1e3)).toBeNull();
    expect(parseQuantityInputToSI("-", 1e3)).toBeNull();
    expect(parseQuantityInputToSI(".", 1e3)).toBeNull();
    expect(parseQuantityInputToSI("", 1e3)).toBeNull();
    expect(parseQuantityInputToSI("1.5e+", 1e3)).toBeNull();
    expect(parseQuantityInputToSI("abc", 1e3)).toBeNull();

    expect(parseQuantityInputToSI("0.00", 1e3)).toBe(0);
    expect(parseQuantityInputToSI("2,5", 1e3)).toBe(2500);
    expect(parseQuantityInputToSI("1.5e-1", 1e3)).toBe(150);
    expect(parseQuantityInputToSI("−1.5e−1", 1e3)).toBe(-150);
  });

  it("computes linear and logarithmic drag-scrub values with Shift/Alt modifiers and clamping", () => {
    // Logarithmic: 120 px = 1 decade (10x)
    expect(
      computeDragScrubValueSI({
        startValueSI: 1e-11,
        deltaPx: 120,
        stepDisplay: 0.1,
        toSiFactor: 1e-12,
        mode: "log",
        shiftKey: false,
        altKey: false,
      }),
    ).toBeCloseTo(1e-10, 15);

    // Shift (x10): +12 px = 1 decade
    expect(
      computeDragScrubValueSI({
        startValueSI: 1e-11,
        deltaPx: 12,
        stepDisplay: 0.1,
        toSiFactor: 1e-12,
        mode: "log",
        shiftKey: true,
        altKey: false,
      }),
    ).toBeCloseTo(1e-10, 15);

    // Alt (x0.1): +120 px = 10^0.1 * start
    const altLog = computeDragScrubValueSI({
      startValueSI: 1e-11,
      deltaPx: 120,
      stepDisplay: 0.1,
      toSiFactor: 1e-12,
      mode: "log",
      shiftKey: false,
      altKey: true,
    });
    expect(Math.abs(altLog - 10 ** 0.1 * 1e-11) / (10 ** 0.1 * 1e-11)).toBeLessThan(1e-3);

    // Linear with Shift, Alt, and [min, max] clamping
    expect(
      computeDragScrubValueSI({
        startValueSI: 8e5,
        deltaPx: 10,
        stepDisplay: 1,
        toSiFactor: 1e3,
        mode: "lin",
        shiftKey: false,
        altKey: false,
      }),
    ).toBe(8.1e5);

    expect(
      computeDragScrubValueSI({
        startValueSI: 8e5,
        deltaPx: 10,
        stepDisplay: 1,
        toSiFactor: 1e3,
        mode: "lin",
        shiftKey: true,
        altKey: false,
        max: 8.5e5,
      }),
    ).toBe(8.5e5);

    expect(
      computeDragScrubValueSI({
        startValueSI: 1e4,
        deltaPx: -50,
        stepDisplay: 1,
        toSiFactor: 1e3,
        mode: "lin",
        shiftKey: false,
        altKey: true,
        min: 6e3,
      }),
    ).toBe(6e3);
  });
});
