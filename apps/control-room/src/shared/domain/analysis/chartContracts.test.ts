import { describe, expect, it } from "vitest";

import {
  assertChartDescriptor,
  type ChartDescriptor,
} from "./chartContracts";
import {
  chartUnitsCompatible,
  convertChartUnitValue,
  resolveChartUnit,
} from "./chartUnits";

function descriptor(): ChartDescriptor {
  return {
    id: "table:default:history",
    kind: "history",
    title: "Scalar history",
    source: {
      resourceKey: "/v2/sessions/current/data/tables/default/rows",
      resourceRevision: 4,
      runId: "run-1",
      stageId: "stage-1",
    },
    axes: [
      {
        id: "x",
        canonicalUnit: "s",
        dimension: "time",
        displayUnit: "ns",
        label: "Time",
      },
      {
        id: "m",
        canonicalUnit: "1",
        dimension: "dimensionless",
        displayUnit: "1",
        label: "Magnetization",
      },
    ],
    series: [
      {
        axisId: "m",
        canonicalUnit: "1",
        id: "mx",
        label: "mx",
        quantity: "m.x",
      },
    ],
    status: "ready",
    trust: "canonical",
  };
}

describe("chart units", () => {
  it("converts compatible SI display scales without changing dimensions", () => {
    expect(chartUnitsCompatible("Hz", "GHz")).toBe(true);
    expect(convertChartUnitValue(2.5e9, "Hz", "GHz")).toBe(2.5);
    expect(convertChartUnitValue(3, "ns", "s")).toBeCloseTo(3e-9);
    expect(resolveChartUnit("GHz")).toMatchObject({
      canonicalUnit: "Hz",
      dimension: "frequency",
      scaleToCanonical: 1e9,
    });
  });

  it("fails closed for incompatible or unknown unit changes", () => {
    expect(chartUnitsCompatible("J", "A/m")).toBe(false);
    expect(chartUnitsCompatible("mystery", "other")).toBe(false);
    expect(() => convertChartUnitValue(1, "J", "A/m")).toThrow(
      "Incompatible chart units",
    );
  });
});

describe("ChartDescriptor", () => {
  it("accepts a payload-free semantic descriptor", () => {
    expect(assertChartDescriptor(descriptor())).toEqual(descriptor());
  });

  it.each(["points", "rows", "data", "option"])(
    "rejects renderer or payload field %s",
    (field) => {
      const value = { ...descriptor(), [field]: [] };

      expect(() => assertChartDescriptor(value)).toThrow(field);
    },
  );

  it("rejects series assigned to a dimensionally incompatible axis", () => {
    const value = descriptor();
    value.series[0] = {
      ...value.series[0],
      canonicalUnit: "J",
    };

    expect(() => assertChartDescriptor(value)).toThrow(
      "series[0].canonicalUnit",
    );
  });

  it("requires revisioned source identity and unique axes", () => {
    const missingRevision = descriptor();
    missingRevision.source.resourceRevision = Number.NaN;
    expect(() => assertChartDescriptor(missingRevision)).toThrow(
      "source.resourceRevision",
    );

    const duplicateAxis = descriptor();
    duplicateAxis.axes.push({ ...duplicateAxis.axes[0] });
    expect(() => assertChartDescriptor(duplicateAxis)).toThrow(
      "duplicate axis",
    );
  });
});
