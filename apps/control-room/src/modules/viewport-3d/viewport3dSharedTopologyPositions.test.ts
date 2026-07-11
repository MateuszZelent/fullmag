import { BufferGeometry } from "three";
import { describe, expect, it } from "vitest";

import {
  attachViewport3DSharedTopologyPosition,
} from "./viewport3dSharedTopologyPositions";

describe("attachViewport3DSharedTopologyPosition", () => {
  it("shares one topology position attribute until the final geometry owner disposes", () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const first = new BufferGeometry();
    const second = new BufferGeometry();

    attachViewport3DSharedTopologyPosition(first, positions);
    attachViewport3DSharedTopologyPosition(second, positions);

    const firstPosition = first.getAttribute("position");
    expect(second.getAttribute("position")).toBe(firstPosition);

    first.dispose();
    expect(first.hasAttribute("position")).toBe(false);
    expect(second.getAttribute("position")).toBe(firstPosition);

    second.dispose();
    expect(second.getAttribute("position")).toBe(firstPosition);
  });

  it("releases a finished topology ownership group before creating a replacement", () => {
    const firstPositions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const replacementPositions = new Float32Array([
      0, 0, 0,
      2, 0, 0,
      0, 2, 0,
    ]);
    const first = new BufferGeometry();
    attachViewport3DSharedTopologyPosition(first, firstPositions);
    const firstAttribute = first.getAttribute("position");

    first.dispose();

    const replacement = new BufferGeometry();
    attachViewport3DSharedTopologyPosition(replacement, replacementPositions);
    expect(replacement.getAttribute("position")).not.toBe(firstAttribute);
    replacement.dispose();
  });

  it.each([1, 10, 100])(
    "keeps full-topology position storage constant for %i FEM parts across surface, wireframe, points, bounds, and fallback passes",
    (partCount) => {
      const positions = new Float32Array(3 * 64);
      const geometries = Array.from({ length: partCount * 5 }, () => new BufferGeometry());
      for (const geometry of geometries) {
        attachViewport3DSharedTopologyPosition(geometry, positions);
      }

      const attributes = new Set(geometries.map((geometry) => geometry.getAttribute("position")));
      const uploadedPositionBytes = [...attributes].reduce(
        (total, attribute) => total + attribute.array.byteLength,
        0,
      );
      expect(attributes.size).toBe(1);
      expect(uploadedPositionBytes).toBe(positions.byteLength);

      geometries.forEach((geometry) => geometry.dispose());
    },
  );
});
