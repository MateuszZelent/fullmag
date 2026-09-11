import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { ScalarColorBuffer } from "./viewport3dFieldMapping";
import {
  canApplyScalarShaderColorBuffer,
  createScalarSurfaceShaderMaterial,
  scalarSurfaceShaderVariantKey,
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
  it("validates whether scalar shader color buffer can be applied", () => {
    expect(canApplyScalarShaderColorBuffer(scalarBuffer([0, 1, 2]), 3)).toBe(true);
    expect(
      canApplyScalarShaderColorBuffer(
        orientationBuffer([
          1, 0, 0,
          0, 0, 1,
        ]),
        2,
      ),
    ).toBe(true);
    expect(canApplyScalarShaderColorBuffer(complexBuffer(), 2)).toBe(true);
    expect(canApplyScalarShaderColorBuffer(null, 3)).toBe(false);
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
    expect(material.vertexShader).toContain(
      VIEWPORT_3D_COMPLEX_IMAG_VALUE_ATTRIBUTE,
    );
    expect(material.vertexShader).toContain("scalarFromVector");
    material.dispose();
  });

  it("changes modal representation and component through uniforms without replacing the program", () => {
    const initial = complexBuffer();
    initial.colorMode = "x";
    initial.complexRepresentation = "real";
    initial.colorPalette = "coolwarm";
    const material = createScalarSurfaceShaderMaterial(initial, {
      depthTest: true,
      depthWrite: true,
      opacity: 1,
      polygonOffset: false,
      polygonOffsetFactor: 0,
      polygonOffsetUnits: 0,
      side: 0,
      transparent: false,
    });
    const vertexShader = material.vertexShader;
    const version = material.version;

    expect(material.uniforms.fmRepresentationId.value).toBe(1);
    expect(material.uniforms.fmColorModeId.value).toBe(2);
    expect(material.uniforms.fmPaletteId.value).toBe(1);

    const updated = complexBuffer();
    updated.colorMode = "z";
    updated.complexRepresentation = "imag";
    updated.colorPalette = "coolwarm";
    updateScalarSurfaceShaderMaterial(material, updated, 0.75);

    expect(material.uniforms.fmRepresentationId.value).toBe(2);
    expect(material.uniforms.fmColorModeId.value).toBe(4);
    expect(material.uniforms.fmOpacity.value).toBe(0.75);
    expect(material.vertexShader).toBe(vertexShader);
    expect(material.version).toBe(version);
    material.dispose();
  });

  it("keeps exp(+i omega t) as Re(delta m exp(+i phi))", () => {
    const buffer = complexBuffer();
    buffer.complexRepresentation = "phase_rotated_real";
    buffer.phasorConvention = "exp_i_omega_t";

    const material = createScalarSurfaceShaderMaterial(buffer, {
      depthTest: true,
      depthWrite: true,
      opacity: 1,
      polygonOffset: false,
      polygonOffsetFactor: 0,
      polygonOffsetUnits: 0,
      side: 0,
      transparent: false,
    });

    expect(material.uniforms.fmTemporalPhaseSign.value).toBe(1);
    expect(material.vertexShader).toContain(
      "complexReal * cos(theta) - complexImag * sin(theta)",
    );
    material.dispose();
  });

  it("uses a cyclic palette for modal phase", () => {
    const buffer = complexBuffer();
    buffer.colorPalette = "twilight";
    buffer.complexRepresentation = "phase";
    buffer.range = { max: Math.PI, min: -Math.PI };

    const material = createScalarSurfaceShaderMaterial(buffer, {
      depthTest: true,
      depthWrite: true,
      opacity: 1,
      polygonOffset: false,
      polygonOffsetFactor: 0,
      polygonOffsetUnits: 0,
      side: 0,
      transparent: false,
    });

    expect(material.uniforms.fmPaletteId.value).toBe(5);
    expect(material.fragmentShader).toContain("fmPaletteId == 5");
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

  describe("S-08 · scalarSurfaceShaderVariantKey and GL program stability", () => {
    it("returns a stable key that only depends on colorMode + complex-value presence, not on values/phase/range", () => {
      const bufferA = scalarBuffer([0, 1]);
      const bufferB = {
        ...bufferA,
        colorPalette: "magma",
        complexPhaseRad: Math.PI,
        range: { max: 999, min: -999 },
      };
      expect(scalarSurfaceShaderVariantKey(bufferA)).toBe("scalar:real");
      expect(scalarSurfaceShaderVariantKey(bufferB)).toBe("scalar:real");
      expect(scalarSurfaceShaderVariantKey(bufferA)).toBe(
        scalarSurfaceShaderVariantKey(bufferB),
      );
    });

    it("changes when colorMode switches between scalar and orientation", () => {
      const scalar = scalarBuffer([0, 1]);
      const orientation = orientationBuffer([1, 0, 0, 0, 0, 1]);
      expect(scalarSurfaceShaderVariantKey(scalar)).toBe("scalar:real");
      expect(scalarSurfaceShaderVariantKey(orientation)).toBe("orientation:real");
      expect(scalarSurfaceShaderVariantKey(scalar)).not.toBe(
        scalarSurfaceShaderVariantKey(orientation),
      );
    });

    it("changes when complex values are present vs. absent", () => {
      const real = scalarBuffer([0, 1]);
      const complex = complexBuffer();
      expect(scalarSurfaceShaderVariantKey(real)).toBe("scalar:real");
      expect(scalarSurfaceShaderVariantKey(complex)).toBe("scalar:complex");
      expect(scalarSurfaceShaderVariantKey(real)).not.toBe(
        scalarSurfaceShaderVariantKey(complex),
      );
    });

    it("does not bump material.version when only the phase changes (S-08 GL program stability)", () => {
      const buffer = complexBuffer();
      const material = createScalarSurfaceShaderMaterial(buffer, {
        depthTest: true,
        depthWrite: true,
        opacity: 1,
        polygonOffset: false,
        polygonOffsetFactor: 0,
        polygonOffsetUnits: 0,
        side: 0,
        transparent: false,
      });
      const baselineVersion = material.version;

      for (let step = 0; step < 60; step += 1) {
        updateScalarSurfaceShaderMaterial(
          material,
          { ...buffer, complexPhaseRad: (step / 60) * 2 * Math.PI },
          1,
        );
      }

      expect(material.version).toBe(baselineVersion);
      expect(material.uniforms.fmPhaseRad.value).toBeCloseTo(
        (59 / 60) * 2 * Math.PI,
      );
      material.dispose();
    });
  });
  describe("S-01 · View-space normal shading and shade strength uniform", () => {
    const source = readFileSync(
      new URL("./viewport3dScalarSurfaceShader.ts", import.meta.url),
      "utf8",
    ).replace(/\r\n/g, "\n");

    it("passes fmShadeStrength uniform to material and updates it", () => {
      const material = createScalarSurfaceShaderMaterial(scalarBuffer([1, 2]), {
        depthTest: true,
        depthWrite: true,
        opacity: 1,
        polygonOffset: false,
        polygonOffsetFactor: 0,
        polygonOffsetUnits: 0,
        shadeStrength: 0.6,
        side: 0,
        transparent: false,
      });
      expect(material.uniforms.fmShadeStrength.value).toBe(0.6);

      updateScalarSurfaceShaderMaterial(material, scalarBuffer([1, 2]), 1, 0.2);
      expect(material.uniforms.fmShadeStrength.value).toBe(0.2);
      material.dispose();
    });

    it("defines vNormalView and computes shaded color in fragment shaders", () => {
      expect(source).toContain("varying vec3 vNormalView;");
      expect(source).toContain("vNormalView = normalize(normalMatrix * normal);");
      expect(source).toContain("vec3 shaded = base * mix(1.0, 0.55 + 0.75 * ndl, fmShadeStrength);");
    });
  });

  describe("S-02 / S-03 · sRGB to Linear conversion and color space handling", () => {
    const source = readFileSync(
      new URL("./viewport3dScalarSurfaceShader.ts", import.meta.url),
      "utf8",
    ).replace(/\r\n/g, "\n");

    it("defines srgbToLinearVec3 and encodes linear output with colorspace_fragment", () => {
      expect(source).toContain("vec3 srgbToLinearVec3(vec3 c)");
      expect(source).toContain("#include <colorspace_fragment>");
      expect(source).toContain("vec3 color = srgbToLinearVec3(shaded);");
    });
  });

  describe("S-04 · Clipping planes support", () => {
    const source = readFileSync(
      new URL("./viewport3dScalarSurfaceShader.ts", import.meta.url),
      "utf8",
    ).replace(/\r\n/g, "\n");

    it("enables clipping on ShaderMaterial instances", () => {
      const material = createScalarSurfaceShaderMaterial(scalarBuffer([0, 1]), {
        depthTest: true,
        depthWrite: true,
        opacity: 1,
        polygonOffset: false,
        polygonOffsetFactor: 0,
        polygonOffsetUnits: 0,
        side: 0,
        transparent: false,
      });
      expect(material.clipping).toBe(true);
      material.dispose();
    });

    it("includes clipping plane chunks in vertex and fragment shaders", () => {
      expect(source).toContain("#include <clipping_planes_pars_vertex>");
      expect(source).toContain("#include <clipping_planes_vertex>");
      expect(source).toContain("#include <clipping_planes_pars_fragment>");
      expect(source).toContain("#include <clipping_planes_fragment>");
    });
  });

  describe("S-05 / S-06 · Relative epsilon and NaN sentinel in fragment shader", () => {
    const source = readFileSync(
      new URL("./viewport3dScalarSurfaceShader.ts", import.meta.url),
      "utf8",
    ).replace(/\r\n/g, "\n");

    it("uses relative epsilon for span degeneracy check and sentinel for NaN", () => {
      expect(source).toContain("bool bad = !(v == v) || abs(v) > 3.0e38;");
      expect(source).toContain("bool degenerate = span <= 1e-6 * max(scale, 1.0);");
      expect(source).toContain("vec3(0.85, 0.0, 0.85)");
    });
  });

  describe("S-12 · Safe arctangent and modal phase projection in complex shaders", () => {
    const source = readFileSync(
      new URL("./viewport3dScalarSurfaceShader.ts", import.meta.url),
      "utf8",
    ).replace(/\r\n/g, "\n");

    it("defines safeAtan2 to protect against division by zero at origin", () => {
      expect(source).toContain("float safeAtan2(float y, float x)");
      expect(source).toContain("safeAtan2(complexImag.x, complexReal.x)");
      expect(source).toContain("fmRepresentationId == 4");
    });
  });

  describe("S-13 · Floquet spatial phase wrapping", () => {
    const source = readFileSync(
      new URL("./viewport3dScalarSurfaceShader.ts", import.meta.url),
      "utf8",
    ).replace(/\r\n/g, "\n");

    it("defines wrapPhase and wraps Floquet theta in vertex shaders", () => {
      expect(source).toContain("float wrapPhase(float value)");
      expect(source).toContain("theta = wrapPhase(theta);");
    });
  });
});
