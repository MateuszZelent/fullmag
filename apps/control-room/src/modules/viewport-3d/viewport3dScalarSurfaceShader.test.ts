import { readFileSync } from "node:fs";
import { BufferGeometry } from "three";
import { describe, expect, it } from "vitest";

import type { ScalarColorBuffer } from "./viewport3dFieldMapping";
import {
  applyScalarShaderColorBuffer,
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

  it("includes NaN/Inf sentinel detection in scalar fragment shader (S-05/S-06)", () => {
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

    expect(material.fragmentShader).toContain("bool bad = !(v == v) || abs(v) > 3.0e38;");
    expect(material.fragmentShader).toContain(
      "float t = bad ? 0.5 : clamp(v, 0.0, 1.0);",
    );
    expect(material.fragmentShader).toContain(
      "vec3 base = srgbToLinearVec3(bad ? vec3(0.85, 0.0, 0.85) : paletteColor(t));",
    );
    expect(material.fragmentShader).not.toContain("float span = max(fmScalarMax - fmScalarMin, 1e-12);");

    material.dispose();
  });

  it("moves the relative-epsilon degenerate-range guard to CPU (plain scalar) / vertex shader (complex scalar) — S-07", () => {
    // The fragment shader no longer re-derives t via (v - min) / span at
    // float32 precision: vScalarValue arrives pre-normalized either from
    // the CPU (plain scalar buffers, see viewport3dFieldMapping.ts /
    // viewport3dFieldColorBuildModel.ts's normalizeScalarValueForShaderAttribute)
    // or from COMPLEX_SCALAR_SURFACE_VERTEX_SHADER (complex/modal buffers).
    const scalarMaterial = createScalarSurfaceShaderMaterial(scalarBuffer([0, 1]), {
      depthTest: true,
      depthWrite: true,
      opacity: 1,
      polygonOffset: false,
      polygonOffsetFactor: 0,
      polygonOffsetUnits: 0,
      side: 0,
      transparent: false,
    });
    expect(scalarMaterial.fragmentShader).not.toContain("float scale = max(abs(fmScalarMax), abs(fmScalarMin));");
    expect(scalarMaterial.fragmentShader).not.toContain("bool degenerate = span <= 1e-6 * max(scale, 1.0);");
    scalarMaterial.dispose();

    const complexMaterial = createScalarSurfaceShaderMaterial(complexBuffer(), {
      depthTest: true,
      depthWrite: true,
      opacity: 1,
      polygonOffset: false,
      polygonOffsetFactor: 0,
      polygonOffsetUnits: 0,
      side: 0,
      transparent: false,
    });
    expect(complexMaterial.vertexShader).toContain("uniform float fmScalarMin;");
    expect(complexMaterial.vertexShader).toContain("uniform float fmScalarMax;");
    expect(complexMaterial.vertexShader).toContain("float scale = max(abs(fmScalarMax), abs(fmScalarMin));");
    expect(complexMaterial.vertexShader).toContain("bool degenerate = span <= 1e-6 * max(scale, 1.0);");
    expect(complexMaterial.vertexShader).toContain(
      "bool rawBad = !(rawScalar == rawScalar) || abs(rawScalar) > 3.0e38;",
    );
    expect(complexMaterial.vertexShader).toContain(
      "vScalarValue = rawBad\n    ? rawScalar\n    : (degenerate ? 0.5 : clamp((rawScalar - fmScalarMin) / span, 0.0, 1.0));",
    );
    complexMaterial.dispose();
  });

  it("sanitizes fmScalarMin and fmScalarMax uniforms to 0 when buffer.range contains NaN or non-finite values", () => {
    const badBuffer = scalarBuffer([0, 1]);
    badBuffer.range = { max: Number.NaN, min: Number.POSITIVE_INFINITY };

    const material = createScalarSurfaceShaderMaterial(badBuffer, {
      depthTest: true,
      depthWrite: true,
      opacity: 1,
      polygonOffset: false,
      polygonOffsetFactor: 0,
      polygonOffsetUnits: 0,
      side: 0,
      transparent: false,
    });

    expect(material.uniforms.fmScalarMin.value).toBe(0);
    expect(material.uniforms.fmScalarMax.value).toBe(0);

    const updateBuffer = scalarBuffer([0, 1]);
    updateBuffer.range = { max: Number.NEGATIVE_INFINITY, min: Number.NaN };
    updateScalarSurfaceShaderMaterial(material, updateBuffer, 1);

    expect(material.uniforms.fmScalarMin.value).toBe(0);
    expect(material.uniforms.fmScalarMax.value).toBe(0);

    material.dispose();
  });
});

describe("S-02/S-03 · scalar surface shader participates in three.js color-space pipeline", () => {
  const source = readFileSync(
    new URL("./viewport3dScalarSurfaceShader.ts", import.meta.url),
    "utf8",
  ).replace(/\r\n/g, "\n");

  it("defines srgbToLinearVec3 and applies it before writing gl_FragColor", () => {
    expect(source).toContain("vec3 srgbToLinearVec3(vec3 c)");
    expect(source).toContain(
      "vec3 color = srgbToLinearVec3(bad ? vec3(0.85, 0.0, 0.85) : paletteColor(t));",
    );
  });

  it("includes colorspace_fragment exactly once, in the scalar-surface fragment shader", () => {
    const matches = source.match(/#include <colorspace_fragment>/g) ?? [];
    expect(matches).toHaveLength(1);

    const scalarShaderStart = source.indexOf("const SCALAR_SURFACE_FRAGMENT_SHADER");
    const orientationShaderStart = source.indexOf(
      "const ORIENTATION_SURFACE_FRAGMENT_SHADER",
    );
    const includeIndex = source.indexOf("#include <colorspace_fragment>");
    expect(scalarShaderStart).toBeGreaterThanOrEqual(0);
    expect(orientationShaderStart).toBeGreaterThan(scalarShaderStart);
    expect(includeIndex).toBeGreaterThan(scalarShaderStart);
    expect(includeIndex).toBeLessThan(orientationShaderStart);
  });

  it("does not touch the orientation (HSL) fragment shader", () => {
    const orientationShaderStart = source.indexOf(
      "const ORIENTATION_SURFACE_FRAGMENT_SHADER",
    );
    const orientationShaderEnd = source.indexOf("`;", orientationShaderStart + 40);
    const orientationSource = source.slice(orientationShaderStart, orientationShaderEnd);
    expect(orientationSource).not.toContain("colorspace_fragment");
    expect(orientationSource).not.toContain("srgbToLinearVec3");
  });

  it("produces instantiated ShaderMaterial with colorspace_fragment in scalar surface fragment shader", () => {
    const material = createScalarSurfaceShaderMaterial(scalarBuffer([0, 1]), {
      depthTest: true,
      depthWrite: true,
      opacity: 1,
      polygonOffset: false,
      polygonOffsetFactor: 0,
      polygonOffsetUnits: 0,
      side: 0,
      toneMapped: false,
      transparent: false,
    });

    expect(material.fragmentShader).toContain("#include <colorspace_fragment>");
    expect(material.fragmentShader).toContain("srgbToLinearVec3");
    expect(material.toneMapped).toBe(false);

    material.dispose();
  });
});

describe("S-04 · clip plane support in custom ShaderMaterial", () => {
  it("createScalarSurfaceShaderMaterial sets clipping: true", () => {
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

  it("includes clipping_planes chunks in every vertex and fragment shader variant", () => {
    const source = readFileSync(
      new URL("./viewport3dScalarSurfaceShader.ts", import.meta.url),
      "utf8",
    ).replace(/\r\n/g, "\n");
    const parsVertexCount = (source.match(/#include <clipping_planes_pars_vertex>/g) ?? []).length;
    const vertexCount = (source.match(/#include <clipping_planes_vertex>/g) ?? []).length;
    const parsFragmentCount = (source.match(/#include <clipping_planes_pars_fragment>/g) ?? []).length;
    const fragmentCount = (source.match(/#include <clipping_planes_fragment>/g) ?? []).length;

    expect(parsVertexCount).toBe(4);
    expect(vertexCount).toBe(4);
    expect(parsFragmentCount).toBe(2);
    expect(fragmentCount).toBe(2);
  });

  it("declares mvPosition before #include <clipping_planes_vertex> in every vertex shader", () => {
    const source = readFileSync(
      new URL("./viewport3dScalarSurfaceShader.ts", import.meta.url),
      "utf8",
    ).replace(/\r\n/g, "\n");
    // Every occurrence of the clipping_planes_vertex include must be preceded
    // (within a reasonable window) by an mvPosition declaration, since the
    // chunk references `mvPosition` directly.
    const includeIndices: number[] = [];
    let searchFrom = 0;
    for (;;) {
      const idx = source.indexOf("#include <clipping_planes_vertex>", searchFrom);
      if (idx === -1) break;
      includeIndices.push(idx);
      searchFrom = idx + 1;
    }
    expect(includeIndices).toHaveLength(4);
    for (const idx of includeIndices) {
      const preceding = source.slice(Math.max(0, idx - 200), idx);
      expect(preceding).toContain("vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);");
    }
  });

  it("places #include <clipping_planes_fragment> as the first statement in both fragment main()", () => {
    const source = readFileSync(
      new URL("./viewport3dScalarSurfaceShader.ts", import.meta.url),
      "utf8",
    ).replace(/\r\n/g, "\n");
    // For each fragment shader block, the first "void main() {" must be
    // immediately followed by the clipping_planes_fragment include.
    const scalarStart = source.indexOf("const SCALAR_SURFACE_FRAGMENT_SHADER");
    const orientationStart = source.indexOf("const ORIENTATION_SURFACE_FRAGMENT_SHADER");
    for (const [start, end] of [
      [scalarStart, orientationStart],
      [orientationStart, source.length],
    ]) {
      const block = source.slice(start, end);
      const mainIndex = block.indexOf("void main() {");
      const afterMain = block.slice(mainIndex, mainIndex + 80);
      expect(afterMain).toContain("#include <clipping_planes_fragment>");
    }
  });
});

describe("S-08 · scalarSurfaceShaderVariantKey", () => {
  it("returns a stable key that only depends on colorMode + complex-value presence, not on values/phase/range", () => {
    const bufferA = scalarBuffer([0, 1]);
    const bufferB = { ...bufferA, range: { max: 999, min: -999 } };
    expect(scalarSurfaceShaderVariantKey(bufferA)).toBe(
      scalarSurfaceShaderVariantKey(bufferB),
    );
  });

  it("changes when colorMode switches between scalar and orientation", () => {
    const scalar = scalarBuffer([0, 1]);
    const orientation = { ...scalar, colorMode: "orientation" };
    expect(scalarSurfaceShaderVariantKey(scalar)).not.toBe(
      scalarSurfaceShaderVariantKey(orientation),
    );
  });

  it("changes when complex values are present vs. absent", () => {
    const real = scalarBuffer([0, 1]);
    const complex = {
      ...real,
      complexRealValues: new Float32Array([0, 0, 0]),
      complexImagValues: new Float32Array([0, 0, 0]),
    };
    expect(scalarSurfaceShaderVariantKey(real)).not.toBe(
      scalarSurfaceShaderVariantKey(complex),
    );
  });
});



describe("S-01 · view-space normal shading for flat scalar/orientation surfaces", () => {
  it("declares vNormalView and computes it from normalMatrix * normal in every vertex shader variant", () => {
    const source = readFileSync(
      new URL("./viewport3dScalarSurfaceShader.ts", import.meta.url),
      "utf8",
    ).replace(/\r\n/g, "\n");
    const varyingCount = (source.match(/varying vec3 vNormalView;/g) ?? []).length;
    const assignCount = (source.match(/vNormalView = normalMatrix \* normal;/g) ?? []).length;

    expect(varyingCount).toBe(6);
    expect(assignCount).toBe(4);
  });

  it("does not redeclare attribute vec3 normal (three.js injects it automatically for ShaderMaterial)", () => {
    const source = readFileSync(
      new URL("./viewport3dScalarSurfaceShader.ts", import.meta.url),
      "utf8",
    ).replace(/\r\n/g, "\n");
    expect(source).not.toContain("attribute vec3 normal");
    expect(source).not.toContain("uniform mat3 normalMatrix");
  });

  it("declares fmShadeStrength uniform in both fragment shaders and applies it after linear conversion in the scalar shader", () => {
    const source = readFileSync(
      new URL("./viewport3dScalarSurfaceShader.ts", import.meta.url),
      "utf8",
    ).replace(/\r\n/g, "\n");
    const uniformCount = (source.match(/uniform float fmShadeStrength;/g) ?? []).length;
    expect(uniformCount).toBe(2);

    const scalarStart = source.indexOf("const SCALAR_SURFACE_FRAGMENT_SHADER");
    const orientationStart = source.indexOf("const ORIENTATION_SURFACE_FRAGMENT_SHADER");
    const scalarBlock = source.slice(scalarStart, orientationStart);

    expect(scalarBlock).toContain(
      "vec3 base = srgbToLinearVec3(bad ? vec3(0.85, 0.0, 0.85) : paletteColor(t));",
    );
    // The shading multiply must happen strictly after the linear conversion
    // (base is already linear) and strictly before colorspace_fragment does
    // the single output encode.
    const baseIdx = scalarBlock.indexOf("vec3 base = srgbToLinearVec3");
    const mixIdx = scalarBlock.indexOf("mix(1.0, 0.55 + 0.75 * ndl, fmShadeStrength)");
    const colorspaceIdx = scalarBlock.indexOf("#include <colorspace_fragment>");
    expect(baseIdx).toBeGreaterThan(-1);
    expect(mixIdx).toBeGreaterThan(baseIdx);
    expect(colorspaceIdx).toBeGreaterThan(mixIdx);
  });

  it("applies the shading multiplier directly to orientationColor with no srgb/linear conversion", () => {
    const source = readFileSync(
      new URL("./viewport3dScalarSurfaceShader.ts", import.meta.url),
      "utf8",
    ).replace(/\r\n/g, "\n");
    const orientationStart = source.indexOf("const ORIENTATION_SURFACE_FRAGMENT_SHADER");
    const orientationBlock = source.slice(orientationStart);

    expect(orientationBlock).toContain("vec3 base = orientationColor(vVectorValue);");
    expect(orientationBlock).not.toContain("srgbToLinearVec3");
    expect(orientationBlock).not.toContain("colorspace_fragment");
    expect(orientationBlock).toContain(
      "vec3 color = base * mix(1.0, 0.55 + 0.75 * ndl, fmShadeStrength);",
    );
  });

  it("flips the view-space normal by gl_FrontFacing so back faces (e.g. hollow/thin surfaces) still shade correctly", () => {
    const source = readFileSync(
      new URL("./viewport3dScalarSurfaceShader.ts", import.meta.url),
      "utf8",
    ).replace(/\r\n/g, "\n");
    const flipCount = (
      source.match(/normalize\(vNormalView\) \* \(gl_FrontFacing \? 1\.0 : -1\.0\)/g) ?? []
    ).length;
    expect(flipCount).toBe(2);
  });

  it("defaults fmShadeStrength to DEFAULT_SCALAR_SURFACE_SHADE_STRENGTH when no shadeStrength option is given", () => {
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
    expect(material.uniforms.fmShadeStrength.value).toBeCloseTo(0.45);
    material.dispose();
  });

  it("honors an explicit shadeStrength option at construction time, including 0 (flat)", () => {
    const flat = createScalarSurfaceShaderMaterial(scalarBuffer([0, 1]), {
      depthTest: true,
      depthWrite: true,
      opacity: 1,
      polygonOffset: false,
      polygonOffsetFactor: 0,
      polygonOffsetUnits: 0,
      shadeStrength: 0,
      side: 0,
      transparent: false,
    });
    expect(flat.uniforms.fmShadeStrength.value).toBe(0);
    flat.dispose();

    const shaded = createScalarSurfaceShaderMaterial(scalarBuffer([0, 1]), {
      depthTest: true,
      depthWrite: true,
      opacity: 1,
      polygonOffset: false,
      polygonOffsetFactor: 0,
      polygonOffsetUnits: 0,
      shadeStrength: 0.8,
      side: 0,
      transparent: false,
    });
    expect(shaded.uniforms.fmShadeStrength.value).toBe(0.8);
    shaded.dispose();
  });

  it("syncs fmShadeStrength via updateScalarSurfaceShaderMaterial, defaulting when omitted or non-finite", () => {
    const material = createScalarSurfaceShaderMaterial(scalarBuffer([0, 1]), {
      depthTest: true,
      depthWrite: true,
      opacity: 1,
      polygonOffset: false,
      polygonOffsetFactor: 0,
      polygonOffsetUnits: 0,
      shadeStrength: 0.8,
      side: 0,
      transparent: false,
    });

    updateScalarSurfaceShaderMaterial(material, scalarBuffer([0, 2]), 1, 0.1);
    expect(material.uniforms.fmShadeStrength.value).toBe(0.1);

    updateScalarSurfaceShaderMaterial(material, scalarBuffer([0, 2]), 1, undefined);
    expect(material.uniforms.fmShadeStrength.value).toBeCloseTo(0.45);

    updateScalarSurfaceShaderMaterial(material, scalarBuffer([0, 2]), 1, Number.NaN);
    expect(material.uniforms.fmShadeStrength.value).toBeCloseTo(0.45);

    material.dispose();
  });
});

describe("S-12 · safe atan2 and magnitude-of-phase for complex/modal shading", () => {
  it("guards atan(y, x) against the undefined x==y==0 case in both complex vertex shader variants", () => {
    const source = readFileSync(
      new URL("./viewport3dScalarSurfaceShader.ts", import.meta.url),
      "utf8",
    ).replace(/\r\n/g, "\n");
    const safeAtan2Count = (source.match(/float safeAtan2\(float y, float x\) \{/g) ?? []).length;
    expect(safeAtan2Count).toBe(2);
    expect(source).not.toContain("return atan(complexImag, complexReal);");
  });

  it("resolves a single magnitude-weighted phase for representation=phase + component=magnitude instead of length() of three independent angles", () => {
    const source = readFileSync(
      new URL("./viewport3dScalarSurfaceShader.ts", import.meta.url),
      "utf8",
    ).replace(/\r\n/g, "\n");
    const scalarVertexStart = source.indexOf("const COMPLEX_SCALAR_SURFACE_VERTEX_SHADER");
    const orientationVertexStart = source.indexOf("const COMPLEX_ORIENTATION_SURFACE_VERTEX_SHADER");
    const scalarVertexSource = source.slice(scalarVertexStart, orientationVertexStart);

    expect(scalarVertexSource).toContain(
      "phase = safeAtan2(\n        sign(dot(complexImag, complexReal)) * length(complexImag),\n        length(complexReal)\n      );",
    );
    expect(scalarVertexSource).toContain("if (fmRepresentationId == 4) return value.x;");
  });

  it("picks the correct per-axis phase for representation=phase + component=x/y/z", () => {
    const buffer: ScalarColorBuffer = {
      ...complexBuffer(),
      complexRepresentation: "phase",
    };
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
    expect(material.uniforms.fmRepresentationId.value).toBe(4);
    expect(material.vertexShader).toContain("phase = safeAtan2(complexImag.x, complexReal.x);");
    expect(material.vertexShader).toContain("phase = safeAtan2(complexImag.y, complexReal.y);");
    expect(material.vertexShader).toContain("phase = safeAtan2(complexImag.z, complexReal.z);");
    material.dispose();
  });

  it("keeps the orientation (vector) complex path as three independent per-axis phases (no magnitude collapsing)", () => {
    const buffer: ScalarColorBuffer = {
      ...complexBuffer(),
      colorMode: "orientation",
      complexRepresentation: "phase",
    };
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
    expect(material.vertexShader).toContain(
      "return vec3(\n      safeAtan2(complexImag.x, complexReal.x),\n      safeAtan2(complexImag.y, complexReal.y),\n      safeAtan2(complexImag.z, complexReal.z)\n    );",
    );
    // The orientation variant has no fmColorModeId uniform -- phase there is
    // always the raw per-axis vector, unlike the scalar variant.
    expect(material.vertexShader).not.toContain("uniform int fmColorModeId;");
    material.dispose();
  });
});

describe("S-13 · Floquet phase argument reduction before sin/cos", () => {
  it("defines wrapPhase and calls it exactly once, inside the Floquet branch, in both complex vertex shader variants", () => {
    const source = readFileSync(
      new URL("./viewport3dScalarSurfaceShader.ts", import.meta.url),
      "utf8",
    ).replace(/\r\n/g, "\n");

    const wrapPhaseDefCount = (
      source.match(/float wrapPhase\(float value\) \{\n  return mod\(value \+ FM_PI, FM_TWO_PI\) - FM_PI;\n\}/g) ?? []
    ).length;
    expect(wrapPhaseDefCount).toBe(2);

    const wrapPhaseCallCount = (source.match(/theta = wrapPhase\(theta\);/g) ?? []).length;
    expect(wrapPhaseCallCount).toBe(2);

    // Both call sites must be inside the `if (fmFloquetActive == 1)` branch,
    // right after the (potentially huge) spatial phase term is added --
    // never applied to the plain temporal-only phase.
    const floquetBranchPattern =
      /if \(fmFloquetActive == 1\) \{\n {4}theta \+= fmSpatialPhaseSign \* dot\(fmWavevectorKf, position - fmCellOrigin\);\n {4}\/\/ S-13: reduce the argument before it reaches cos\/sin below\.\n {4}theta = wrapPhase\(theta\);\n {2}\}/g;
    const floquetBranchCount = (source.match(floquetBranchPattern) ?? []).length;
    expect(floquetBranchCount).toBe(2);
  });

  it("keeps wrapPhase out of the plain (non-Floquet) scalar and orientation vertex shaders", () => {
    const source = readFileSync(
      new URL("./viewport3dScalarSurfaceShader.ts", import.meta.url),
      "utf8",
    ).replace(/\r\n/g, "\n");
    const scalarVertexStart = source.indexOf("const SCALAR_SURFACE_VERTEX_SHADER");
    const orientationVertexStart = source.indexOf("const ORIENTATION_SURFACE_VERTEX_SHADER");
    const complexVertexStart = source.indexOf("const COMPLEX_SCALAR_SURFACE_VERTEX_SHADER");
    const plainVertexShadersSource = source.slice(scalarVertexStart, complexVertexStart);

    expect(orientationVertexStart).toBeGreaterThan(scalarVertexStart);
    expect(orientationVertexStart).toBeLessThan(complexVertexStart);
    expect(plainVertexShadersSource).not.toContain("wrapPhase");
  });

  it("wraps a large Floquet spatial phase term into the compiled vertex shader source for both complex variants", () => {
    const buffer = complexBuffer();
    buffer.wavevectorKf = [1e7, 0, 0];

    const scalarMaterial = createScalarSurfaceShaderMaterial(buffer, {
      depthTest: true,
      depthWrite: true,
      opacity: 1,
      polygonOffset: false,
      polygonOffsetFactor: 0,
      polygonOffsetUnits: 0,
      side: 0,
      transparent: false,
    });
    expect(scalarMaterial.uniforms.fmFloquetActive.value).toBe(1);
    expect(scalarMaterial.vertexShader).toContain("theta = wrapPhase(theta);");
    scalarMaterial.dispose();

    const orientationBuffer = { ...buffer, colorMode: "orientation" as const };
    const orientationMaterial = createScalarSurfaceShaderMaterial(orientationBuffer, {
      depthTest: true,
      depthWrite: true,
      opacity: 1,
      polygonOffset: false,
      polygonOffsetFactor: 0,
      polygonOffsetUnits: 0,
      side: 0,
      transparent: false,
    });
    expect(orientationMaterial.vertexShader).toContain("theta = wrapPhase(theta);");
    orientationMaterial.dispose();
  });
});
