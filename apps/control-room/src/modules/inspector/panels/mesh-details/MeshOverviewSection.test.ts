import { describe, expect, it } from "vitest";

import { resolveMeshTopologyCounts } from "./meshTopologyCounts";

describe("mesh topology counts", () => {
  it("accepts only typed shared-domain manifest counts", () => {
    expect(
      resolveMeshTopologyCounts({
        node_count: 120,
        element_count: 240,
        boundary_face_count: 80,
      }),
    ).toEqual({
      node_count: 120,
      element_count: 240,
      boundary_face_count: 80,
    });
    expect(
      resolveMeshTopologyCounts({
        mesh_summary: { node_count: 999, element_count: 999 },
      }),
    ).toBeNull();
  });

  it("fails closed per field for invalid manifest counts", () => {
    expect(
      resolveMeshTopologyCounts({
        node_count: -1,
        element_count: 12.5,
        boundary_face_count: 4,
      }),
    ).toEqual({
      node_count: null,
      element_count: null,
      boundary_face_count: 4,
    });
  });
});
