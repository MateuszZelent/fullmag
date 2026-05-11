import { BufferAttribute, BufferGeometry } from "three";
import { describe, expect, it } from "vitest";

import type { DecodedFieldVector } from "@/kernel/api/codecs";

import {
  applyVertexScalarColors,
  canApplyVertexScalarColors,
} from "./viewport3dGeometryColors";

function vectorField(values: number[], nComp = 3): DecodedFieldVector {
  return {
    dtype: "float64",
    grid: [values.length / nComp, 1, 1],
    nComp,
    pointCount: values.length / nComp,
    quantityId: "m",
    valueCount: values.length,
    values: new Float64Array(values),
  };
}

describe("viewport3dGeometryColors", () => {
  it("updates vertex colors on an existing geometry buffer", () => {
    const geometry = new BufferGeometry();

    expect(
      applyVertexScalarColors(
        geometry,
        vectorField([
          0, 0, 0,
          1, 0, 0,
        ]),
        2,
      ),
    ).toBe(true);

    const firstAttribute = geometry.getAttribute("color") as BufferAttribute;
    const firstVersion = firstAttribute.version;

    expect(Array.from(firstAttribute.array)).toEqual([
      0, expect.closeTo(0.38), 1,
      1, expect.closeTo(0.38), 0,
    ]);

    expect(
      applyVertexScalarColors(
        geometry,
        vectorField([
          1, 0, 0,
          0, 0, 0,
        ]),
        2,
      ),
    ).toBe(true);

    const secondAttribute = geometry.getAttribute("color") as BufferAttribute;

    expect(secondAttribute).toBe(firstAttribute);
    expect(secondAttribute.version).toBeGreaterThan(firstVersion);
    expect(Array.from(secondAttribute.array)).toEqual([
      1, expect.closeTo(0.38), 0,
      0, expect.closeTo(0.38), 1,
    ]);
  });

  it("removes stale vertex colors when the field no longer matches topology", () => {
    const geometry = new BufferGeometry();

    applyVertexScalarColors(geometry, vectorField([1, 0, 0]), 1);
    expect(geometry.hasAttribute("color")).toBe(true);

    expect(applyVertexScalarColors(geometry, vectorField([1, 0, 0]), 2)).toBe(
      false,
    );
    expect(geometry.hasAttribute("color")).toBe(false);
    expect(canApplyVertexScalarColors(vectorField([1, 0, 0]), 2)).toBe(false);
  });
});
