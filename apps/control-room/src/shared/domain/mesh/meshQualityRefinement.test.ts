import { describe, expect, it } from "vitest";

import { normalizeMeshQualityStatistics } from "./qualityStatistics";
import { resolveMeshQualityRefinementState } from "./meshQualityRefinement";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

describe("mesh quality refinement planning", () => {
  it("builds a local Box size field for the worst element when quality gates fail", () => {
    const statistics = normalizeMeshQualityStatistics({
      global: {
        edge_length: { mean: 4e-9 },
        element_count: 24,
        gamma: { min: 0.04, mean: 0.5 },
        sicn: { p05: 0.2, mean: 0.6 },
      },
      worst_elements: [
        {
          centroid: [1e-8, 2e-8, 3e-9],
          element_index: 7,
          gamma: 0.04,
          scope_label: "Domain 1",
          sicn: 0.2,
        },
      ],
    });

    const state = resolveMeshQualityRefinementState(statistics);

    expect(state.status).toBe("ready");
    expect(state.reason).toContain("gamma");
    expect(state.plan).toMatchObject({
      elementIndex: 7,
      metric: "gamma",
      targetHmax: 2e-9,
      fieldRadius: 8e-9,
    });
    expect(state.plan?.meshOptions).toMatchObject({
      compute_quality: true,
      per_element_quality: true,
      quality_refinement: {
        element_index: 7,
        kind: "worst_element_box",
        metric: "gamma",
        threshold: 0.08,
      },
      size_fields: [
        {
          kind: "Box",
          source: "quality_threshold_refinement",
          params: {
            VIn: 2e-9,
            VOut: 1e22,
          },
        },
      ],
    });
    const sizeFields = state.plan?.meshOptions.size_fields;
    const field = Array.isArray(sizeFields) ? asRecord(sizeFields[0]) : null;
    const params = asRecord(field?.params);
    expect(params?.XMin).toBeCloseTo(2e-9);
    expect(params?.XMax).toBeCloseTo(1.8e-8);
  });

  it("does not refine when published quality thresholds are already satisfied", () => {
    const statistics = normalizeMeshQualityStatistics({
      global: {
        edge_length: { mean: 4e-9 },
        gamma: { min: 0.2 },
        sicn: { p05: 0.3 },
      },
      worst_elements: [
        {
          centroid: [1e-8, 2e-8, 3e-9],
          element_index: 7,
          gamma: 0.2,
          scope_label: "Domain 1",
          sicn: 0.3,
        },
      ],
    });

    const state = resolveMeshQualityRefinementState(statistics);

    expect(state).toEqual({
      plan: null,
      reason: "Quality thresholds are satisfied.",
      status: "not_required",
    });
  });

  it("builds a local repair plan for SICN-only breaches from SICN-ranked centroids", () => {
    const statistics = normalizeMeshQualityStatistics({
      global: {
        edge_length: { mean: 4e-9 },
        gamma: { min: 0.2 },
        sicn: { p05: 0.05 },
      },
      worst_elements: [
        {
          centroid: [1e-8, 2e-8, 3e-9],
          element_index: 7,
          gamma: 0.2,
          scope_label: "Domain 1",
          sicn: 0.05,
        },
      ],
      worst_elements_by_metric: {
        sicn: [
          {
            centroid: [3e-8, 2e-8, 1e-9],
            element_index: 9,
            gamma: 0.2,
            scope_label: "Domain 1",
            sicn: 0.05,
          },
        ],
      },
    });

    const state = resolveMeshQualityRefinementState(statistics);

    expect(state.status).toBe("ready");
    expect(state.reason).toContain("sicn");
    expect(state.plan).toMatchObject({
      elementIndex: 9,
      metric: "sicn",
      threshold: 0.1,
      value: 0.05,
    });
    expect(state.plan?.meshOptions.quality_refinement).toMatchObject({
      element_index: 9,
      metric: "sicn",
      threshold: 0.1,
    });
  });

  it("does not use legacy gamma-ranked worst elements for SICN-only breaches", () => {
    const statistics = normalizeMeshQualityStatistics({
      global: {
        edge_length: { mean: 4e-9 },
        gamma: { min: 0.2 },
        sicn: { p05: 0.05 },
      },
      worst_elements: [
        {
          centroid: [1e-8, 2e-8, 3e-9],
          element_index: 7,
          gamma: 0.2,
          scope_label: "Domain 1",
          sicn: 0.2,
        },
      ],
    });

    const state = resolveMeshQualityRefinementState(statistics);

    expect(state).toEqual({
      plan: null,
      reason: "SICN-ranked worst-element centroid is required for local refinement.",
      status: "unavailable",
    });
  });
});
