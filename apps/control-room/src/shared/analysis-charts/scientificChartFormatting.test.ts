import { describe, expect, it } from "vitest";
import {
  axisLabelFormatter,
  detectAxisScale,
  formatAxisName,
  formatAxisNameWithScale,
  formatAxisValue,
  formatScaledAxisValue,
  formatScaledTooltipValue,
  formatTooltipValue,
  sanitizeLabelText,
  scaledAxisLabelFormatter,
} from "./scientificChartFormatting";

describe("sanitizeLabelText", () => {
  it("strips HTML tags but keeps text content", () => {
    expect(sanitizeLabelText("<b>label</b>")).toBe("label");
    // Tags stripped; text content kept — Canvas renders plain text, not HTML
    expect(sanitizeLabelText("<script>alert(1)</script>")).toBe("alert(1)");
  });
  it("handles null and undefined", () => {
    expect(sanitizeLabelText(null)).toBe("");
    expect(sanitizeLabelText(undefined)).toBe("");
  });
  it("truncates at 120 chars", () => {
    expect(sanitizeLabelText("a".repeat(200))).toHaveLength(120);
  });
});

describe("detectAxisScale", () => {
  it("picks ns for nanosecond values", () => {
    const scale = detectAxisScale([1e-9, 2e-9, 5e-9]);
    expect(scale.prefix).toBe("n");
    expect(scale.factor).toBe(1e-9);
  });

  it("picks µ for microsecond values", () => {
    const scale = detectAxisScale([1e-6, 5e-6]);
    expect(scale.prefix).toBe("µ");
  });

  it("picks k for kilo-range values", () => {
    const scale = detectAxisScale([1000, 5000, 10000]);
    expect(scale.prefix).toBe("k");
  });

  it("returns no-scale for empty or all-zero data", () => {
    expect(detectAxisScale([])).toEqual({ factor: 1, prefix: "" });
    expect(detectAxisScale([0, 0])).toEqual({ factor: 1, prefix: "" });
  });

  it("returns no-scale for wide-span data (>3 orders of magnitude)", () => {
    const scale = detectAxisScale([1e-9, 1]); // 9 orders span
    expect(scale.prefix).toBe("");
    expect(scale.factor).toBe(1);
  });

  it("picks no-scale for dimensionless 0..1 data (mx, my, mz)", () => {
    const scale = detectAxisScale([-1, -0.5, 0, 0.5, 1]);
    expect(scale.factor).toBe(1);
    expect(scale.prefix).toBe("");
  });

  it("accepts a one-pass iterable without materializing a second value array", () => {
    function* samples() {
      yield 1e-9;
      yield 2e-9;
      yield 5e-9;
    }

    expect(detectAxisScale(samples() as never)).toEqual({ factor: 1e-9, prefix: "n" });
  });
});

describe("formatAxisNameWithScale", () => {
  it("embeds ns prefix in unit", () => {
    const scale = { factor: 1e-9, prefix: "n" };
    expect(formatAxisNameWithScale("time", "s", scale)).toBe("time [ns]");
  });

  it("handles pre-formatted label with unit brackets (t [s] + ns -> t [ns])", () => {
    const scale = { factor: 1e-9, prefix: "n" };
    expect(formatAxisNameWithScale("t [s]", "s", scale)).toBe("t [ns]");
  });

  it("handles pre-formatted label with GHz scale (f [Hz] + GHz -> f [GHz])", () => {
    const scale = { factor: 1e9, prefix: "G" };
    expect(formatAxisNameWithScale("frequency [Hz]", "Hz", scale)).toBe("frequency [GHz]");
  });

  it("handles empty label", () => {
    const scale = { factor: 1e-6, prefix: "µ" };
    expect(formatAxisNameWithScale("", "s", scale)).toBe("[µs]");
  });

  it("handles no prefix (dimensionless)", () => {
    expect(formatAxisNameWithScale("mx", "", { factor: 1, prefix: "" })).toBe("mx");
  });

  it("handles both empty", () => {
    expect(formatAxisNameWithScale("", "", { factor: 1, prefix: "" })).toBe("");
  });
});

describe("formatScaledAxisValue", () => {
  it("divides by scale factor", () => {
    const scale = { factor: 1e-9, prefix: "n" };
    expect(formatScaledAxisValue(2.5e-9, scale)).toBe("2.5");
    expect(formatScaledAxisValue(1e-9, scale)).toBe("1");
  });

  it("handles zero", () => {
    expect(formatScaledAxisValue(0, { factor: 1e-9, prefix: "n" })).toBe("0");
  });
});

describe("formatScaledTooltipValue", () => {
  it("shows scaled value with SI-prefixed unit", () => {
    const scale = { factor: 1e-9, prefix: "n" };
    expect(formatScaledTooltipValue(2.5e-9, "s", scale)).toBe("2.5 ns");
  });

  it("handles non-finite", () => {
    expect(formatScaledTooltipValue(NaN, "s", { factor: 1, prefix: "" })).toBe("—");
  });
});

describe("formatAxisValue", () => {
  it("formats SI prefixes correctly", () => {
    expect(formatAxisValue(1500)).toBe("1.5 k");
    expect(formatAxisValue(1e-9)).toBe("1 n");
    expect(formatAxisValue(1e-6)).toBe("1 µ");
    expect(formatAxisValue(0)).toBe("0");
    expect(formatAxisValue(Infinity)).toBe("∞");
    expect(formatAxisValue(-Infinity)).toBe("-∞");
    expect(formatAxisValue(NaN)).toBe("—");
  });
});

describe("formatTooltipValue", () => {
  it("appends unit", () => {
    expect(formatTooltipValue(1.5, "J")).toBe("1.5 J");
    expect(formatTooltipValue(1.5, "")).toBe("1.5");
  });
  it("preserves a dimensionless normalized magnetization value", () => {
    expect(formatTooltipValue(0.10317, "")).toBe("0.10317");
  });
  it("handles non-finite", () => {
    expect(formatTooltipValue(NaN, "J")).toBe("—");
  });
});

describe("formatAxisName", () => {
  it("builds label [unit] format", () => {
    expect(formatAxisName("time", "s")).toBe("time [s]");
    expect(formatAxisName("", "s")).toBe("[s]");
    expect(formatAxisName("time", "")).toBe("time");
    expect(formatAxisName("", "")).toBe("");
  });
});

describe("axisLabelFormatter", () => {
  it("returns a formatter function", () => {
    const fmt = axisLabelFormatter(4);
    expect(typeof fmt).toBe("function");
    expect(fmt(1e-6)).toBe("1 µ");
  });
});

describe("scaledAxisLabelFormatter", () => {
  it("divides by scale and returns clean number", () => {
    const fmt = scaledAxisLabelFormatter({ factor: 1e-9, prefix: "n" }, 4);
    expect(fmt(1e-9)).toBe("1");
    expect(fmt(2.5e-9)).toBe("2.5");
    expect(fmt(0)).toBe("0");
  });
});
