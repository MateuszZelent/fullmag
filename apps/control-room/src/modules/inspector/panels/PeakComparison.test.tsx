import { describe, expect, it } from "vitest";
import type { DecodedComplexFieldVector } from "@/kernel/api/codecs/types";
import { calculateSpatialOverlap } from "@/shared/domain/analysis/frequencyDomainChartModels";

describe("PeakComparison Spatial Overlap and Detuning", () => {
  const createMockField = (
    values: number[],
    pointCount: number,
    componentCount: number = 3
  ): DecodedComplexFieldVector => ({
    dtype: "complex128",
    domainGenerationId: "1",
    formatVersion: 3,
    grid: [pointCount, 1, 1],
    indexing: "full_domain",
    meshTopologyHash: "hash",
    meshTopologyRevision: "rev",
    nodeIndices: null,
    pointCount,
    componentCount,
    quantityId: "dm",
    scopeId: null,
    scopeKind: "magnetic_only",
    valueCount: values.length,
    values: new Float64Array(values),
  });

  it("calculates spatial overlap coefficient correctly for identical real-like fields", () => {
    // 2 nodes, 3 components (X, Y, Z), complex128: 2 * 3 * 2 = 12 values
    // Node 0: dm = [(1, 0), (2, 0), (3, 0)]
    // Node 1: dm = [(4, 0), (5, 0), (6, 0)]
    const values = [
      1, 0, 2, 0, 3, 0, // Node 0
      4, 0, 5, 0, 6, 0, // Node 1
    ];
    const field1 = createMockField(values, 2);
    const field2 = createMockField(values, 2);
    const weights = [1.0, 1.0];

    const eta = calculateSpatialOverlap(field1, field2, weights);
    // Identical fields should have overlap exactly 1.0
    expect(eta).toBeCloseTo(1.0, 5);
  });

  it("calculates spatial overlap coefficient correctly with complex Hermitian conjugate and mass weighting", () => {
    // Node 0: field1 = [(1, 2), (0, 0), (0, 0)]
    //         field2 = [(3, 4), (0, 0), (0, 0)]
    // w0 = 2.0
    // Node 1: field1 = [(0, 0), (5, -6), (0, 0)]
    //         field2 = [(0, 0), (7, 8), (0, 0)]
    // w1 = 0.5
    //
    // Node 0: u0 = 1 + 2i,  v0 = 3 + 4i
    //         u0* v0 = (1 - 2i)(3 + 4i) = 3 + 4i - 6i + 8 = 11 - 2i
    //         |u0|^2 = 1 + 4 = 5
    //         |v0|^2 = 9 + 16 = 25
    // Node 1: u1 = 5 - 6i,  v1 = 7 + 8i
    //         u1* v1 = (5 + 6i)(7 + 8i) = 35 + 40i + 42i - 48 = -13 + 82i
    //         |u1|^2 = 25 + 36 = 61
    //         |v1|^2 = 49 + 64 = 113
    //
    // Sum over nodes:
    // Numerator real = w0 * 11 + w1 * (-13) = 22 - 6.5 = 15.5
    // Numerator imag = w0 * (-2) + w1 * 82 = -4 + 41 = 37
    // Numerator mag^2 = 15.5^2 + 37^2 = 240.25 + 1369 = 1609.25
    // Numerator mag = sqrt(1609.25) approx 40.115458
    //
    // Denominator u = w0 * 5 + w1 * 61 = 10 + 30.5 = 40.5
    // Denominator v = w0 * 25 + w1 * 113 = 50 + 56.5 = 106.5
    // Denominator = sqrt(40.5) * sqrt(106.5) = sqrt(4313.25) approx 65.675338
    //
    // Overlap = 40.115458 / 65.675338 approx 0.6108146
    
    const field1Values = [
      1, 2, 0, 0, 0, 0, // Node 0
      0, 0, 5, -6, 0, 0, // Node 1
    ];
    const field2Values = [
      3, 4, 0, 0, 0, 0, // Node 0
      0, 0, 7, 8, 0, 0, // Node 1
    ];
    
    const field1 = createMockField(field1Values, 2);
    const field2 = createMockField(field2Values, 2);
    const weights = [2.0, 0.5];

    const eta = calculateSpatialOverlap(field1, field2, weights);
    expect(eta).toBeCloseTo(0.6108146, 5);
  });

  it("handles missing modal or driven field payloads gracefully", () => {
    const values = [1, 0, 2, 0, 3, 0];
    const field = createMockField(values, 1);

    expect(calculateSpatialOverlap(null, field, [1.0])).toBeNull();
    expect(calculateSpatialOverlap(field, null, [1.0])).toBeNull();
    expect(calculateSpatialOverlap(undefined, undefined, [1.0])).toBeNull();
  });

  it("clamps overlap coefficient to [0, 1] range even with numerical float precision issues", () => {
    const values = [1e-15, 0, 0, 0, 0, 0];
    const field = createMockField(values, 1);
    
    // Test degenerate empty field vectors
    const zeroField = createMockField([0, 0, 0, 0, 0, 0], 1);
    expect(calculateSpatialOverlap(field, zeroField, [1.0])).toBe(0);
  });
});
