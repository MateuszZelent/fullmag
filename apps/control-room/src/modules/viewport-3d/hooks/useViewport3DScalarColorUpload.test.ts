import { BufferAttribute, BufferGeometry } from "three";
import { describe, expect, it } from "vitest";

import type { ScalarColorBuffer } from "../viewport3dFieldMapping";
import {
  canRetainViewport3DScalarUploadBuffer,
  createViewport3DScalarColorUploadPlan,
  createViewport3DScalarShaderColorUploadPlan,
} from "./useViewport3DScalarColorUpload";
import {
  VIEWPORT_3D_SCALAR_VALUE_ATTRIBUTE,
  VIEWPORT_3D_VECTOR_VALUE_ATTRIBUTE,
} from "../viewport3dScalarSurfaceShader";

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

describe("canRetainViewport3DScalarUploadBuffer", () => {
  it("keeps a visible scalar upload only for the same semantic layer", () => {
    const geometry = new BufferGeometry();
    const buffer = scalarColorBuffer(2);

    expect(
      canRetainViewport3DScalarUploadBuffer({
        allowRetention: true,
        buffer,
        geometry,
        requestedGeometry: geometry,
        requestedRetentionKey: "part=a|mode=x|quantity=m|palette=viridis",
        retentionKey: "part=a|mode=x|quantity=m|palette=viridis",
      }),
    ).toBe(true);

    expect(
      canRetainViewport3DScalarUploadBuffer({
        allowRetention: true,
        buffer,
        geometry,
        requestedGeometry: geometry,
        requestedRetentionKey: "part=a|mode=y|quantity=m|palette=viridis",
        retentionKey: "part=a|mode=x|quantity=m|palette=viridis",
      }),
    ).toBe(false);

    expect(
      canRetainViewport3DScalarUploadBuffer({
        allowRetention: false,
        buffer,
        geometry,
        requestedGeometry: geometry,
        requestedRetentionKey: "part=a|mode=x|quantity=m|palette=viridis",
        retentionKey: "part=a|mode=x|quantity=m|palette=viridis",
      }),
    ).toBe(false);
  });
});

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

describe("createViewport3DScalarShaderColorUploadPlan", () => {
  it("splits scalar shader attributes into upload chunks before visible adoption", () => {
    const geometry = new BufferGeometry();
    const scalarValues = new Float32Array([1, 2, 3, 4, 5]);
    const colorBuffer: ScalarColorBuffer = {
      colors: new Float32Array(),
      colorMode: "x",
      range: { max: 5, min: 1 },
      scalarValues,
    };

    const uploadPlan = createViewport3DScalarShaderColorUploadPlan(
      geometry,
      colorBuffer,
      5,
      2,
    );

    expect(uploadPlan).not.toBeNull();
    expect(uploadPlan?.chunks.map((chunk) => chunk.itemCount)).toEqual([
      2, 2, 1,
    ]);
    expect(uploadPlan?.estimatedBytes).toBe(scalarValues.byteLength);
    expect(geometry.hasAttribute(VIEWPORT_3D_SCALAR_VALUE_ATTRIBUTE)).toBe(false);

    for (const chunk of uploadPlan?.chunks ?? []) {
      chunk.upload();
    }
    expect(geometry.hasAttribute(VIEWPORT_3D_SCALAR_VALUE_ATTRIBUTE)).toBe(false);

    uploadPlan?.onVisible();
    const attribute = geometry.getAttribute(
      VIEWPORT_3D_SCALAR_VALUE_ATTRIBUTE,
    ) as BufferAttribute;
    expect(attribute).toBeInstanceOf(BufferAttribute);
    expect(Array.from(attribute.array as Float32Array)).toEqual(
      Array.from(scalarValues),
    );
    expect(attribute.version).toBeGreaterThan(0);
  });

  it("reuses compatible shader attributes while retaining inactive slots", () => {
    const geometry = new BufferGeometry();
    const scalarAttribute = new BufferAttribute(new Float32Array(2), 1);
    geometry.setAttribute(VIEWPORT_3D_SCALAR_VALUE_ATTRIBUTE, scalarAttribute);
    geometry.setAttribute(
      VIEWPORT_3D_VECTOR_VALUE_ATTRIBUTE,
      new BufferAttribute(new Float32Array(6).fill(1), 3),
    );
    const scalarValues = new Float32Array([7, 9]);
    const colorBuffer: ScalarColorBuffer = {
      colors: new Float32Array(),
      colorMode: "x",
      range: { max: 9, min: 7 },
      scalarValues,
    };

    const uploadPlan = createViewport3DScalarShaderColorUploadPlan(
      geometry,
      colorBuffer,
      2,
      1,
    );

    for (const chunk of uploadPlan?.chunks ?? []) {
      chunk.upload();
    }
    uploadPlan?.onVisible();

    expect(geometry.getAttribute(VIEWPORT_3D_SCALAR_VALUE_ATTRIBUTE)).toBe(
      scalarAttribute,
    );
    expect(Array.from(scalarAttribute.array as Float32Array)).toEqual([7, 9]);
    expect(geometry.hasAttribute(VIEWPORT_3D_VECTOR_VALUE_ATTRIBUTE)).toBe(true);
  });

  it("retains inactive shader slots so mode switches reuse their GPU attribute identities", () => {
    const geometry = new BufferGeometry();
    const scalarValues = new Float32Array([1, 2]);
    const vectorValues = new Float32Array([1, 2, 3, 4, 5, 6]);

    for (const buffer of [
      {
        colors: new Float32Array(),
        colorMode: "scalar",
        range: { max: 2, min: 1 },
        scalarValues,
      },
      {
        colors: new Float32Array(),
        colorMode: "orientation",
        range: { max: 1, min: 0 },
        vectorValues,
      },
      {
        colors: new Float32Array(),
        colorMode: "scalar",
        range: { max: 2, min: 1 },
        scalarValues,
      },
    ] satisfies ScalarColorBuffer[]) {
      const plan = createViewport3DScalarShaderColorUploadPlan(
        geometry,
        buffer,
        2,
        2,
      );
      for (const chunk of plan?.chunks ?? []) chunk.upload();
      plan?.onVisible();
    }

    expect(geometry.getAttribute(VIEWPORT_3D_SCALAR_VALUE_ATTRIBUTE)).toBeInstanceOf(
      BufferAttribute,
    );
    expect(geometry.getAttribute(VIEWPORT_3D_VECTOR_VALUE_ATTRIBUTE)).toBeInstanceOf(
      BufferAttribute,
    );
  });
});
