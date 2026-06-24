import { BufferAttribute, BufferGeometry } from "three";
import { describe, expect, it } from "vitest";

import type { ScalarColorBuffer } from "../viewport3dFieldMapping";
import { createViewport3DScalarColorUploadPlan } from "./useViewport3DScalarColorUpload";

function scalarColorBuffer(vertexCount: number): ScalarColorBuffer {
  const colors = new Float32Array(vertexCount * 3);
  for (let index = 0; index < colors.length; index += 1) {
    colors[index] = index + 1;
  }
  return {
    colors,
    range: { max: colors.length, min: 1 },
  };
}

describe("createViewport3DScalarColorUploadPlan", () => {
  it("splits scalar color buffers into upload chunks before visible adoption", () => {
    const geometry = new BufferGeometry();
    const colorBuffer = scalarColorBuffer(5);
    const uploadPlan = createViewport3DScalarColorUploadPlan(
      geometry,
      colorBuffer,
      5,
      2,
    );

    expect(uploadPlan).not.toBeNull();
    expect(uploadPlan?.chunks.map((chunk) => chunk.itemCount)).toEqual([
      2, 2, 1,
    ]);
    expect(uploadPlan?.estimatedBytes).toBe(colorBuffer.colors.byteLength);
    expect(geometry.hasAttribute("color")).toBe(false);

    for (const chunk of uploadPlan?.chunks ?? []) {
      chunk.upload();
    }
    expect(geometry.hasAttribute("color")).toBe(false);

    uploadPlan?.onVisible();
    const attribute = geometry.getAttribute("color") as BufferAttribute;
    expect(attribute).toBeInstanceOf(BufferAttribute);
    expect(Array.from(attribute.array as Float32Array)).toEqual(
      Array.from(colorBuffer.colors),
    );
    expect(attribute.version).toBeGreaterThan(0);
  });

  it("reuses an existing compatible scalar color attribute", () => {
    const geometry = new BufferGeometry();
    const existing = new BufferAttribute(new Float32Array(6), 3);
    geometry.setAttribute("color", existing);
    const colorBuffer = scalarColorBuffer(2);

    const uploadPlan = createViewport3DScalarColorUploadPlan(
      geometry,
      colorBuffer,
      2,
      1,
    );

    for (const chunk of uploadPlan?.chunks ?? []) {
      chunk.upload();
    }
    uploadPlan?.onVisible();

    expect(geometry.getAttribute("color")).toBe(existing);
    expect(Array.from(existing.array as Float32Array)).toEqual(
      Array.from(colorBuffer.colors),
    );
  });
});
