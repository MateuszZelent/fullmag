import { BufferAttribute, BufferGeometry } from "three";
import { describe, expect, it } from "vitest";

import type { DecodedFieldVector } from "@/kernel/api/codecs";

import {
  applyVertexScalarColors,
  canApplyVertexScalarColors,
} from "./viewport3dGeometryColors";
import { magnitudeColorRgb } from "./viewport3dVectorColoring";

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

    expect(Array.from(firstAttribute.array)).toEqual(
      Array.from(Float32Array.from([...magnitudeColorRgb(0), ...magnitudeColorRgb(1)])),
    );

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
    expect(Array.from(secondAttribute.array)).toEqual(
      Array.from(Float32Array.from([...magnitudeColorRgb(1), ...magnitudeColorRgb(0)])),
    );
  });

  it("removes stale vertex colors when the field has more points than the topology", () => {
    const geometry = new BufferGeometry();

    // First apply colors for a 2-vertex topology with a 2-point field.
    applyVertexScalarColors(geometry, vectorField([1, 0, 0, 0, 1, 0]), 2);
    expect(geometry.hasAttribute("color")).toBe(true);

    // Field now has MORE points than the topology vertex count → stale, remove.
    expect(applyVertexScalarColors(geometry, vectorField([1, 0, 0, 0, 1, 0]), 1)).toBe(
      false,
    );
    expect(geometry.hasAttribute("color")).toBe(false);
    expect(canApplyVertexScalarColors(vectorField([1, 0, 0, 0, 1, 0]), 1)).toBe(false);
  });

  it("accepts partial field coverage (field covers fewer nodes than topology)", () => {
    const geometry = new BufferGeometry();

    // Field has 1 point (magnetic domain), topology has 2 vertices (magnetic + airbox).
    // This is the primary use-case for FEM meshes with an airbox.
    expect(
      applyVertexScalarColors(geometry, vectorField([1, 0, 0]), 2),
    ).toBe(true);
    expect(geometry.hasAttribute("color")).toBe(true);
    expect(canApplyVertexScalarColors(vectorField([1, 0, 0]), 2)).toBe(true);
  });
});
