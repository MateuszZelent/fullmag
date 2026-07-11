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
});
