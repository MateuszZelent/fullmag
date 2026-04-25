import { describe, expect, it } from "vitest";

import {
  decideFieldVectorFetch,
  mapResourceQuantities,
} from "../useDataPlaneBridge";

describe("decideFieldVectorFetch", () => {
  it("skips 3D vector fetch in 2D mode (slice API path)", () => {
    const decision = decideFieldVectorFetch({
      viewMode: "2d",
      component: "magnitude",
    });
    expect(decision).toEqual({
      shouldFetch: false,
      component: "full",
    });
  });

  it("requests selected scalar component in 3D when possible", () => {
    const decision = decideFieldVectorFetch({
      viewMode: "3d",
      component: "x",
    });
    expect(decision).toEqual({
      shouldFetch: true,
      component: "x",
    });
  });

  it("falls back to full payload for orientation/full-vector rendering", () => {
    const decision = decideFieldVectorFetch({
      viewMode: "3d",
      component: "3D",
    });
    expect(decision).toEqual({
      shouldFetch: true,
      component: "full",
    });
  });

  it("skips legacy full vector fetch for FEM 3D scoped rendering", () => {
    const decision = decideFieldVectorFetch({
      viewMode: "3d",
      component: "3D",
      isFemBackend: true,
    });
    expect(decision).toEqual({
      shouldFetch: false,
      component: "full",
    });
  });
});

describe("mapResourceQuantities", () => {
  it("keeps preview quantities selectable when the field catalog is empty", () => {
    const [magnetization] = mapResourceQuantities(
      {
        quantities: [
          {
            id: "m",
            label: "Magnetization",
            unit: "dimensionless",
            location: "node",
            domain: "magnetic_only",
            n_comp: 3,
            normalization_hint: "unit_vector",
            interactive_preview: true,
            supports_preview_2d: true,
            supports_preview_3d: true,
            supports_history: false,
            supports_export: true,
            quick_access_label: "M",
            scalar_metric_key: null,
            shape: "vector_field",
          },
        ],
      },
      { quantities: [] },
    );

    expect(magnetization).toMatchObject({
      id: "m",
      available: true,
      data_available: false,
    });
  });

  it("tracks materialized field availability separately from selectability", () => {
    const [exchange] = mapResourceQuantities(
      {
        quantities: [
          {
            id: "H_ex",
            label: "Exchange Field",
            unit: "A/m",
            location: "node",
            domain: "magnetic_only",
            n_comp: 3,
            normalization_hint: "max_abs",
            interactive_preview: true,
            supports_preview_2d: true,
            supports_preview_3d: true,
            supports_history: false,
            supports_export: true,
            quick_access_label: "H_ex",
            scalar_metric_key: null,
            shape: "vector_field",
          },
        ],
      },
      {
        quantities: [
          {
            quantity_id: "H_ex",
            label: "Exchange Field",
            kind: "vector_field",
            components: 3,
            location: "node",
            unit: "A/m",
            available: true,
          },
        ],
      },
    );

    expect(exchange).toMatchObject({
      id: "H_ex",
      available: true,
      data_available: true,
    });
  });
});
