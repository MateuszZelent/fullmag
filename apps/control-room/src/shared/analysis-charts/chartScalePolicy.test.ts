import { describe, expect, it } from "vitest";

import {
  chartAxisName,
  createChartDisplayTransform,
  resolveChartScalePolicy,
} from "./chartScalePolicy";

describe("chart scale policy", () => {
  it("keeps normalized magnetization dimensionless at factor one", () => {
    const transform = createChartDisplayTransform("1", [4.447e-6, 0.97982]);

    expect(transform.factor).toBe(1);
    expect(transform.displayUnit).toBe("");
    expect(transform.formatValue(0.10317)).toBe("0.10317");
    expect(chartAxisName("Normalized magnetization m", transform)).toBe(
      "Normalized magnetization m",
    );
  });

  it("retains SI scaling for physical magnetization", () => {
    const transform = createChartDisplayTransform("A/m", [1e3, 9e5]);

    expect(transform.factor).not.toBe(1e-3);
    expect(chartAxisName("Magnetization M", transform)).toContain("A/m");
  });

  it("honors a compatible persisted display-unit preference", () => {
    const transform = createChartDisplayTransform("s", [1e-9, 2e-9], "ns");

    expect(transform.factor).toBe(1e-9);
    expect(transform.displayUnit).toBe("ns");
    expect(transform.formatValue(2e-9)).toBe("2 ns");
  });

  it.each(["m1", "u1", "µ1", "n1"])(
    "never emits the prefixed dimensionless unit %s",
    (forbidden) => {
      const transform = createChartDisplayTransform("1", [0.10317, 0.97982]);

      expect(chartAxisName("Normalized magnetization m", transform)).not.toContain(
        forbidden,
      );
    },
  );

  it("identifies dimensionless units before choosing a magnitude scale", () => {
    expect(resolveChartScalePolicy("1")).toEqual({
      kind: "dimensionless",
      displayUnit: "",
    });
  });
});
