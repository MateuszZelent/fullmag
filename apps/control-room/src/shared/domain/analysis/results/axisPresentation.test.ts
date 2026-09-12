import { describe, expect, it } from "vitest";

import type {
  AnalysisResultAxisResource,
  AnalysisResultAxisValueResource,
} from "@/kernel/api/apiTypes";

import {
  analysisResultAxisDisplayUnits,
  analysisResultAxisPresentation,
  formatAnalysisResultAxisValue,
} from "./axisPresentation";

const frequencyAxis = {
  axis_id: "frequency",
  cardinality: 3,
  inline_values: null,
  label: "Frequency",
  ordering: "ascending",
  preferred_display_units: ["GHz", "MHz"],
  projections: [],
  role: "spectral",
  semantic_id: "frequency_hz",
  symbol: "f",
  unit_si: "Hz",
  value_kind: "scalar",
  values_resource_key: null,
} satisfies AnalysisResultAxisResource;

const scalarValue = {
  category: null,
  entity_ref: null,
  label: null,
  scalar_si: 2.5e9,
  status: "ready",
  token: "frequency:2500000000",
  vector3_si: null,
} satisfies AnalysisResultAxisValueResource;

describe("analysis result axis presentation", () => {
  it("keeps canonical units available and preserves declared preference order", () => {
    expect(analysisResultAxisDisplayUnits(frequencyAxis)).toEqual(["GHz", "MHz", "Hz"]);
    expect(analysisResultAxisPresentation(frequencyAxis).displayUnit).toBe("GHz");
    expect(analysisResultAxisPresentation(frequencyAxis, "GHz").displayUnit).toBe("GHz");
  });

  it("converts scalar display values without changing their identity token", () => {
    expect(formatAnalysisResultAxisValue(frequencyAxis, scalarValue, "GHz")).toBe("2.50000 GHz");
    expect(scalarValue.token).toBe("frequency:2500000000");
  });

  it("keeps an API-authored label when a vector projection has no safe scalar conversion", () => {
    const axis = {
      ...frequencyAxis,
      preferred_display_units: ["mT"],
      projections: [{ label: "mu0 H", operation: "vector", projection_id: "mu0_H", unit: "mT" }],
      unit_si: "A/m",
      value_kind: "vector3",
    } satisfies AnalysisResultAxisResource;
    const value = {
      ...scalarValue,
      label: "mu0 Hx = 75 mT",
      scalar_si: null,
      token: "bias:75mT",
      vector3_si: [59683.1, 0, 0],
    } satisfies AnalysisResultAxisValueResource;

    expect(formatAnalysisResultAxisValue(axis, value, "mT")).toBe("mu0 Hx = 75 mT");
  });
});
