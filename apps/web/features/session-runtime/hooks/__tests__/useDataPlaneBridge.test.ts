import { describe, expect, it } from "vitest";

import {
  appendScalarRowsBounded,
  decideFieldVectorFetch,
  isNegativeDataPlaneResponse,
  mapResourceQuantities,
} from "../useDataPlaneBridge";
import { LiveApiError } from "@/src/api/client/errors/LiveApiError";

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

  it("fetches full vector payloads for FEM 3D quantities", () => {
    const decision = decideFieldVectorFetch({
      viewMode: "3d",
      component: "3D",
      isFemBackend: true,
    });
    expect(decision).toEqual({
      shouldFetch: true,
      component: "full",
    });
  });
});

describe("isNegativeDataPlaneResponse", () => {
  it("treats not-found and no-content responses as negative-cacheable", () => {
    expect(isNegativeDataPlaneResponse(LiveApiError.httpError(404, "missing", undefined, "mesh"))).toBe(true);
    expect(isNegativeDataPlaneResponse(LiveApiError.httpError(204, "empty", undefined, "mesh"))).toBe(true);
  });

  it("treats empty binary payloads as negative-cacheable", () => {
    expect(isNegativeDataPlaneResponse(new ArrayBuffer(0))).toBe(true);
    expect(isNegativeDataPlaneResponse(new Uint8Array(0))).toBe(true);
  });

  it("does not negative-cache ordinary failures", () => {
    expect(isNegativeDataPlaneResponse(LiveApiError.httpError(500, "boom", undefined, "mesh"))).toBe(false);
    expect(isNegativeDataPlaneResponse(new Error("network"))).toBe(false);
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

describe("appendScalarRowsBounded", () => {
  it("keeps only the newest scalar rows within the configured limit", () => {
    const rows = appendScalarRowsBounded(
      [
        { step: 1 } as any,
        { step: 2 } as any,
      ],
      [
        { step: 3 } as any,
        { step: 4 } as any,
      ],
      3,
    );

    expect(rows.map((row) => row.step)).toEqual([2, 3, 4]);
  });

  it("reuses the existing array when no rows are appended", () => {
    const current = [{ step: 1 } as any];
    expect(appendScalarRowsBounded(current, [], 3)).toBe(current);
  });
});

describe("resolveQuantityDomainForDisplay", () => {
  it("no test block currently", () => {
    expect(true).toBe(true);
  });
});
