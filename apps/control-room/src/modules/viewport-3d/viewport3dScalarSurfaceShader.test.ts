import { BufferGeometry } from "three";
import { describe, expect, it } from "vitest";

import type { ScalarColorBuffer } from "./viewport3dFieldMapping";
import {
  applyScalarShaderColorBuffer,
  canApplyScalarShaderColorBuffer,
  createScalarSurfaceShaderMaterial,
  updateScalarSurfaceShaderMaterial,
  VIEWPORT_3D_SCALAR_VALUE_ATTRIBUTE,
  VIEWPORT_3D_VECTOR_VALUE_ATTRIBUTE,
} from "./viewport3dScalarSurfaceShader";

function scalarBuffer(values: number[]): ScalarColorBuffer {
  return {
    colors: new Float32Array(0),
    colorMode: "magnitude",
    colorPalette: "inferno",
    range: { max: Math.max(...values), min: Math.min(...values) },
    scalarValues: new Float32Array(values),
  };
}

function orientationBuffer(values: number[]): ScalarColorBuffer {
  return {
    colors: new Float32Array(0),
    colorMode: "orientation",
    colorPalette: "viridis",
    range: { max: 1, min: 0 },
    vectorValues: new Float32Array(values),
  };
}

describe("viewport3dScalarSurfaceShader", () => {
  it("applies scalar-value attributes for GPU palette coloring", () => {
    const geometry = new BufferGeometry();
    const buffer = scalarBuffer([0, 1, 2]);

    expect(canApplyScalarShaderColorBuffer(buffer, 3)).toBe(true);
    expect(applyScalarShaderColorBuffer(geometry, buffer, 3)).toBe(true);
    expect(
      Array.from(
        geometry.getAttribute(VIEWPORT_3D_SCALAR_VALUE_ATTRIBUTE).array,
      ),
    ).toEqual([0, 1, 2]);
  });

  it("applies vector-value attributes for GPU orientation coloring", () => {
    const geometry = new BufferGeometry();
    const buffer = orientationBuffer([
      1, 0, 0,
      0, 0, 1,
    ]);

    expect(canApplyScalarShaderColorBuffer(buffer, 2)).toBe(true);
    expect(applyScalarShaderColorBuffer(geometry, buffer, 2)).toBe(true);
    expect(
      Array.from(
        geometry.getAttribute(VIEWPORT_3D_VECTOR_VALUE_ATTRIBUTE).array,
      ),
    ).toEqual([
      1, 0, 0,
      0, 0, 1,
    ]);
  });

  it("creates a shader material with scalar range and palette uniforms", () => {
    const material = createScalarSurfaceShaderMaterial(scalarBuffer([2, 4]), {
      depthTest: true,
      depthWrite: true,
      opacity: 0.7,
      polygonOffset: false,
      polygonOffsetFactor: 0,
      polygonOffsetUnits: 0,
      side: 0,
      transparent: true,
    });

    expect(material.uniforms.fmOpacity.value).toBe(0.7);
    expect(material.uniforms.fmScalarMin.value).toBe(2);
    expect(material.uniforms.fmScalarMax.value).toBe(4);
    expect(material.uniforms.fmPaletteId.value).toBe(2);
    expect(material.vertexShader).toContain(VIEWPORT_3D_SCALAR_VALUE_ATTRIBUTE);
    material.dispose();
  });

  it("creates a shader material with orientation color mode uniforms", () => {
    const material = createScalarSurfaceShaderMaterial(
      orientationBuffer([1, 0, 0]),
      {
        depthTest: true,
        depthWrite: true,
        opacity: 1,
        polygonOffset: false,
        polygonOffsetFactor: 0,
        polygonOffsetUnits: 0,
        side: 0,
        transparent: false,
      },
    );

    expect(material.uniforms.fmColorModeId.value).toBe(1);
    expect(material.vertexShader).toContain(VIEWPORT_3D_VECTOR_VALUE_ATTRIBUTE);
    material.dispose();
  });

  it("switches shader programs when updating between scalar and orientation modes", () => {
    const material = createScalarSurfaceShaderMaterial(scalarBuffer([2, 4]), {
      depthTest: true,
      depthWrite: true,
      opacity: 0.7,
      polygonOffset: false,
      polygonOffsetFactor: 0,
      polygonOffsetUnits: 0,
      side: 0,
      transparent: true,
    });

    const scalarVertexShader = material.vertexShader;
    const scalarFragmentShader = material.fragmentShader;
    const initialVersion = material.version;

    updateScalarSurfaceShaderMaterial(
      material,
      orientationBuffer([1, 0, 0, 0, 0, 1]),
      0.4,
    );

    expect(material.uniforms.fmColorModeId.value).toBe(1);
    expect(material.uniforms.fmOpacity.value).toBe(0.4);
    expect(material.vertexShader).toContain(VIEWPORT_3D_VECTOR_VALUE_ATTRIBUTE);
    expect(material.vertexShader).not.toBe(scalarVertexShader);
    expect(material.fragmentShader).not.toBe(scalarFragmentShader);
    expect(material.version).toBeGreaterThan(initialVersion);

    const orientationVersion = material.version;

    updateScalarSurfaceShaderMaterial(material, scalarBuffer([5, 9]), 0.6);

    expect(material.uniforms.fmColorModeId.value).toBe(0);
    expect(material.uniforms.fmOpacity.value).toBe(0.6);
    expect(material.vertexShader).toContain(VIEWPORT_3D_SCALAR_VALUE_ATTRIBUTE);
    expect(material.vertexShader).toBe(scalarVertexShader);
    expect(material.fragmentShader).toBe(scalarFragmentShader);
    expect(material.version).toBeGreaterThan(orientationVersion);

    material.dispose();
  });
});
