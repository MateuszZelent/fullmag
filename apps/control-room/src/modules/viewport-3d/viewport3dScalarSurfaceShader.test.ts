import { BufferGeometry } from "three";
import { describe, expect, it } from "vitest";

import type { ScalarColorBuffer } from "./viewport3dFieldMapping";
import {
  applyScalarShaderColorBuffer,
  canApplyScalarShaderColorBuffer,
  createScalarSurfaceShaderMaterial,
  updateScalarSurfaceShaderMaterial,
  VIEWPORT_3D_COMPLEX_IMAG_VALUE_ATTRIBUTE,
  VIEWPORT_3D_COMPLEX_REAL_VALUE_ATTRIBUTE,
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

function complexBuffer(): ScalarColorBuffer {
  return {
    colors: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]),
    colorMode: "x",
    colorPalette: "viridis",
    complexImagValues: new Float32Array([
      0, 1, 0,
      0, 0, 1,
    ]),
    complexPhaseRad: Math.PI / 2,
    complexRealValues: new Float32Array([
      1, 0, 0,
      0, 1, 0,
    ]),
    range: { max: 1, min: -1 },
    scalarValues: new Float32Array([1, 0]),
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

  it("applies complex-value attributes for shader-side mode phase projection", () => {
    const geometry = new BufferGeometry();
    const buffer = complexBuffer();

    expect(canApplyScalarShaderColorBuffer(buffer, 2)).toBe(true);
    expect(applyScalarShaderColorBuffer(geometry, buffer, 2)).toBe(true);
    expect(
      Array.from(
        geometry.getAttribute(VIEWPORT_3D_COMPLEX_REAL_VALUE_ATTRIBUTE).array,
      ),
    ).toEqual([
      1, 0, 0,
      0, 1, 0,
    ]);
    expect(
      Array.from(
        geometry.getAttribute(VIEWPORT_3D_COMPLEX_IMAG_VALUE_ATTRIBUTE).array,
      ),
    ).toEqual([
      0, 1, 0,
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

  it("creates a shader material with complex phase uniforms", () => {
    const material = createScalarSurfaceShaderMaterial(complexBuffer(), {
      depthTest: true,
      depthWrite: true,
      opacity: 1,
      polygonOffset: false,
      polygonOffsetFactor: 0,
      polygonOffsetUnits: 0,
      side: 0,
      transparent: false,
    });

    expect(material.uniforms.fmPhaseRad.value).toBe(Math.PI / 2);
    expect(material.uniforms.fmColorModeId.value).toBe(2);
    expect(material.vertexShader).toContain(
      VIEWPORT_3D_COMPLEX_REAL_VALUE_ATTRIBUTE,
    );
    expect(material.vertexShader).toContain("scalarFromVector");
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

  it("sets Floquet uniforms when Floquet parameters are present in the buffer", () => {
    const buffer = complexBuffer();
    buffer.wavevectorKf = [1, 2, 3];
    buffer.cellOrigin = [0.1, 0.2, 0.3];
    buffer.floquetSpatialConvention = "dst_equals_src_exp_minus_i_k_dot_delta_r";
    buffer.phasorConvention = "exp_minus_i_omega_t";

    const material = createScalarSurfaceShaderMaterial(buffer, {
      depthTest: true,
      depthWrite: true,
      opacity: 0.8,
      polygonOffset: false,
      polygonOffsetFactor: 0,
      polygonOffsetUnits: 0,
      side: 0,
      transparent: true,
    });

    expect(material.uniforms.fmWavevectorKf.value).toEqual([1, 2, 3]);
    expect(material.uniforms.fmCellOrigin.value).toEqual([0.1, 0.2, 0.3]);
    expect(material.uniforms.fmSpatialPhaseSign.value).toBe(-1);
    expect(material.uniforms.fmTemporalPhaseSign.value).toBe(-1);
    expect(material.uniforms.fmFloquetActive.value).toBe(1);

    // Update with alternative conventions
    const nextBuffer = complexBuffer();
    nextBuffer.wavevectorKf = [0, 0, 0];
    nextBuffer.cellOrigin = [0, 0, 0];
    nextBuffer.floquetSpatialConvention = "dst_equals_src_exp_plus_i_k_dot_delta_r";
    nextBuffer.phasorConvention = "exp_i_omega_t";

    updateScalarSurfaceShaderMaterial(material, nextBuffer, 0.8);
    expect(material.uniforms.fmSpatialPhaseSign.value).toBe(1);
    expect(material.uniforms.fmTemporalPhaseSign.value).toBe(1);
    expect(material.uniforms.fmFloquetActive.value).toBe(1);

    material.dispose();
  });
});
