import { FrontSide, ShaderMaterial } from "three";
import { describe, expect, it } from "vitest";

import type { DecodedComplexFieldVector } from "@/kernel/api/codecs";
import { createLivePhaseUniform } from "@/kernel/visualization/livePhaseUniform";

import {
  bindScalarSurfacePhaseUniform,
  createScalarSurfaceShaderMaterial,
  updateScalarSurfaceShaderMaterial,
} from "../viewport3dScalarSurfaceShader";
import type { ScalarColorBuffer } from "../viewport3dFieldMapping";
import {
  buildComplexVectorGlyphsFromSegments,
  COMPLEX_VECTOR_GLYPH_ANCHOR_ATTRIBUTE,
  COMPLEX_VECTOR_GLYPH_IMAG_ATTRIBUTE,
  COMPLEX_VECTOR_GLYPH_REAL_ATTRIBUTE,
  complexVectorGlyphColorRange,
  createComplexVectorGlyphGeometry,
  createComplexVectorGlyphMaterial,
  projectComplexVectorGlyph,
  updateComplexVectorGlyphMaterial,
} from "./complexVectorGlyphs";

function complexField(): DecodedComplexFieldVector {
  return {
    componentCount: 3,
    dtype: "complex128",
    grid: [2, 1, 1],
    pointCount: 2,
    quantityId: "analysis:eigen:sample-0000:mode-0001",
    valueCount: 12,
    values: new Float64Array([
      // point 0: Re = (1, 0, 0), Im = (0, 1, 0) -> circular in the xy plane
      1, 0, 0, 1, 0, 0,
      // point 1: Re = (0, 0, 3), Im = (0, 0, 4) -> linear along z
      0, 0, 0, 0, 3, 4,
    ]),
  };
}

// Two fixed-length (2) segments: glyph 0 centered at (0,0,0), glyph 1 at (5,0,0).
function segments(): Float32Array {
  return new Float32Array([
    -1, 0, 0, 1, 0, 0, 1,
    5, -1, 0, 5, 1, 0, 1,
  ]);
}

function glyphOptions(phase: ReturnType<typeof createLivePhaseUniform> | number) {
  return {
    colorMode: "orientation",
    colorRange: { max: 1, min: 0 },
    headLengthRatio: 0.28,
    headRadiusRatio: 0.1,
    monoColor: "#ffffff",
    opacity: 1,
    palette: "viridis",
    phase,
    shaftRadiusRatio: 0.035,
  };
}

describe("complex vector glyphs", () => {
  it("derives anchors and phase-independent complex parts from segments", () => {
    const glyphs = buildComplexVectorGlyphsFromSegments({
      anchorMode: "center",
      buildKey: "glyphs:test",
      complexField: complexField(),
      sampleIndices: new Uint32Array([0, 1]),
      segments: segments(),
    });

    expect(glyphs?.count).toBe(2);
    expect(glyphs?.glyphLength).toBeCloseTo(2);
    expect(Array.from(glyphs?.anchors ?? [])).toEqual([0, 0, 0, 5, 0, 0]);
    expect(Array.from(glyphs?.complexReal ?? [])).toEqual([1, 0, 0, 0, 0, 3]);
    expect(Array.from(glyphs?.complexImag ?? [])).toEqual([0, 1, 0, 0, 0, 4]);
    expect(glyphs?.magnitudeEnvelopeMax).toBeCloseTo(5);
    expect(glyphs?.componentEnvelopeMax).toEqual([1, 1, 5]);

    const tail = buildComplexVectorGlyphsFromSegments({
      anchorMode: "tail",
      buildKey: "glyphs:test",
      complexField: complexField(),
      sampleIndices: new Uint32Array([0, 1]),
      segments: segments(),
    });
    expect(Array.from(tail?.anchors ?? [])).toEqual([-1, 0, 0, 5, -1, 0]);
  });

  it("caches glyphs per segment build so animation never rebuilds them", () => {
    const field = complexField();
    const segmentBuild = segments();
    const input = {
      anchorMode: "center" as const,
      buildKey: "glyphs:cached",
      complexField: field,
      sampleIndices: new Uint32Array([0, 1]),
      segments: segmentBuild,
    };
    expect(buildComplexVectorGlyphsFromSegments(input)).toBe(
      buildComplexVectorGlyphsFromSegments(input),
    );
  });

  it("projects Re cos(theta) - Im sin(theta) like the vertex shader", () => {
    const glyphs = buildComplexVectorGlyphsFromSegments({
      anchorMode: "center",
      buildKey: "glyphs:projection",
      complexField: complexField(),
      sampleIndices: new Uint32Array([0, 1]),
      segments: segments(),
    })!;
    const quarter = projectComplexVectorGlyph(glyphs, 0, Math.PI / 2);
    expect(quarter[0]).toBeCloseTo(0);
    expect(quarter[1]).toBeCloseTo(-1);
    const linear = projectComplexVectorGlyph(glyphs, 1, Math.PI / 2);
    expect(linear[2]).toBeCloseTo(-4);
    expect(complexVectorGlyphColorRange(glyphs, "z")).toEqual({ max: 5, min: -5 });
    expect(complexVectorGlyphColorRange(glyphs, "magnitude")).toEqual({ max: 5, min: 0 });
  });

  it("uploads instance attributes once and binds the shared phase uniform", () => {
    const glyphs = buildComplexVectorGlyphsFromSegments({
      anchorMode: "center",
      buildKey: "glyphs:gpu",
      complexField: complexField(),
      sampleIndices: new Uint32Array([0, 1]),
      segments: segments(),
    })!;
    const geometry = createComplexVectorGlyphGeometry(glyphs, "head");
    expect(geometry.instanceCount).toBe(2);
    expect(geometry.getAttribute(COMPLEX_VECTOR_GLYPH_ANCHOR_ATTRIBUTE).array).toBe(glyphs.anchors);
    expect(geometry.getAttribute(COMPLEX_VECTOR_GLYPH_REAL_ATTRIBUTE).array).toBe(glyphs.complexReal);
    expect(geometry.getAttribute(COMPLEX_VECTOR_GLYPH_IMAG_ATTRIBUTE).array).toBe(glyphs.complexImag);

    const uniform = createLivePhaseUniform(0.5);
    const material = createComplexVectorGlyphMaterial({
      depthTest: true,
      depthWrite: true,
      side: FrontSide,
    });
    updateComplexVectorGlyphMaterial(material, glyphs, glyphOptions(uniform));
    expect(material).toBeInstanceOf(ShaderMaterial);
    expect(material.uniforms.fmPhaseRad).toBe(uniform);
    expect(material.vertexShader).toContain("complexReal * cos(theta) - complexImag * sin(theta)");

    // A phase step only writes the shared cell; the material sees it as-is.
    uniform.value = 2.5;
    expect(material.uniforms.fmPhaseRad?.value).toBe(2.5);

    // Switching to a static phase never writes into the shared cell.
    updateComplexVectorGlyphMaterial(material, glyphs, glyphOptions(1));
    expect(material.uniforms.fmPhaseRad).not.toBe(uniform);
    expect(material.uniforms.fmPhaseRad?.value).toBe(1);
    expect(uniform.value).toBe(2.5);
  });
});

describe("scalar surface phase uniform binding", () => {
  function complexBuffer(overrides: Partial<ScalarColorBuffer> = {}): ScalarColorBuffer {
    return {
      colorMode: "x",
      colors: new Float32Array(0),
      complexImagValues: new Float32Array([0, 0, 0]),
      complexPhaseRad: 0.25,
      complexRealValues: new Float32Array([1, 0, 0]),
      range: { max: 2, min: -2 },
      ...overrides,
    };
  }

  it("shares a live phase cell with the material and restores a private one", () => {
    const uniform = createLivePhaseUniform(1.5);
    const material = createScalarSurfaceShaderMaterial(
      complexBuffer({ complexPhaseUniform: uniform }),
      {
        depthTest: true,
        depthWrite: true,
        opacity: 1,
        polygonOffset: false,
        polygonOffsetFactor: 0,
        polygonOffsetUnits: 0,
        side: FrontSide,
        transparent: false,
      },
    );
    expect(material.uniforms.fmPhaseRad).toBe(uniform);
    uniform.value = 3;
    expect(material.uniforms.fmPhaseRad?.value).toBe(3);

    updateScalarSurfaceShaderMaterial(material, complexBuffer(), 1);
    expect(material.uniforms.fmPhaseRad).not.toBe(uniform);
    expect(material.uniforms.fmPhaseRad?.value).toBe(0.25);
    expect(uniform.value).toBe(3);

    bindScalarSurfacePhaseUniform(material, complexBuffer({ complexPhaseUniform: uniform }));
    expect(material.uniforms.fmPhaseRad).toBe(uniform);
  });

  it("normalizes complex scalar values with the range uniforms", () => {
    const material = createScalarSurfaceShaderMaterial(complexBuffer(), {
      depthTest: true,
      depthWrite: true,
      opacity: 1,
      polygonOffset: false,
      polygonOffsetFactor: 0,
      polygonOffsetUnits: 0,
      side: FrontSide,
      transparent: false,
    });
    expect(material.vertexShader).toContain(
      "(scalarFromVector(projected) - fmScalarMin) / scalarSpan",
    );
    expect(material.uniforms.fmScalarMin?.value).toBe(-2);
    expect(material.uniforms.fmScalarMax?.value).toBe(2);
  });
});
