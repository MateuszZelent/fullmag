import { describe, expect, it } from "vitest";

import {
  createFemCutSurfaceGeometry,
  createFemCutSurfaceMaterial,
  disposeFemCutSurfaceMesh,
  FEM_SCALAR_VALUE_ATTRIBUTE,
  FEM_VECTOR_VALUE_ATTRIBUTE,
  paletteIdFromName,
  triangulateCutPolygons,
  updateFemCutSurfaceGeometry,
  updateFemCutSurfaceMaterial,
  vectorModeId,
} from "./femCutSurfaceLayer";

describe("femCutSurfaceLayer", () => {
  it("triangulates convex quad cuts without artificial folding for affine fields", () => {
    // Quad vertices in UV: [0, 0], [2, 0], [2, 1], [0, 1]
    const polygonVertices = new Float32Array([
      0, 0,
      2, 0,
      2, 1,
      0, 1,
    ]);
    const polygonOffsets = new Uint32Array([0, 4]);

    // Exact affine field: f(u, v) = 3*u + 5*v + 2
    const affineField = (_idx: number, u: number, v: number) => 3 * u + 5 * v + 2;

    const { scalarValues, triangleCount, verticesUv } = triangulateCutPolygons(
      polygonOffsets,
      polygonVertices,
      undefined,
      affineField,
    );

    // Quad is split into 2 triangles: (0, 1, 2) and (0, 2, 3)
    expect(triangleCount).toBe(2);
    expect(verticesUv.length).toBe(2 * 3 * 2); // 2 triangles * 3 vertices * 2 coords
    expect(scalarValues.length).toBe(2 * 3); // 6 vertices

    // Triangle 1: (0,0), (2,0), (2,1)
    expect(scalarValues[0]).toBe(affineField(0, 0, 0)); // 2
    expect(scalarValues[1]).toBe(affineField(1, 2, 0)); // 8
    expect(scalarValues[2]).toBe(affineField(2, 2, 1)); // 13

    // Triangle 2: (0,0), (2,1), (0,1)
    expect(scalarValues[3]).toBe(affineField(0, 0, 0)); // 2
    expect(scalarValues[4]).toBe(affineField(2, 2, 1)); // 13
    expect(scalarValues[5]).toBe(affineField(3, 0, 1)); // 7

    // For any barycentric point on triangle 1, e.g. center (4/3, 1/3):
    // interpolated = (2 + 8 + 13) / 3 = 23 / 3 = 7.6667
    // exact = 3 * (4/3) + 5 * (1/3) + 2 = 4 + 5/3 + 2 = 23 / 3.
    // Exact match confirms no folding or affine distortion!
    const tri1Interp = (scalarValues[0]! + scalarValues[1]! + scalarValues[2]!) / 3;
    const tri1Exact = affineField(0, 4 / 3, 1 / 3);
    expect(tri1Interp).toBeCloseTo(tri1Exact, 10);
  });

  it("preserves discontinuous fields across adjacent cut elements with separate vertices", () => {
    // Two adjacent triangles sharing edge from (1, 0) to (1, 1):
    // Element 0: (0, 0), (1, 0), (1, 1) with field = 100
    // Element 1: (1, 0), (2, 0), (1, 1) with field = 200
    const polygonVertices = new Float32Array([
      0, 0,
      1, 0,
      1, 1,
      1, 0,
      2, 0,
      1, 1,
    ]);
    const polygonOffsets = new Uint32Array([0, 3, 6]);
    const parentElementIds = new Uint32Array([10, 20]);

    const { scalarValues, triangleCount } = triangulateCutPolygons(
      polygonOffsets,
      polygonVertices,
      parentElementIds,
      (_idx, _u, _v, parentElemId) => (parentElemId === 10 ? 100 : 200),
    );

    expect(triangleCount).toBe(2);
    // Element 10 triangle values are all 100
    expect(scalarValues[0]).toBe(100);
    expect(scalarValues[1]).toBe(100);
    expect(scalarValues[2]).toBe(100);
    // Element 20 triangle values are all 200, despite sharing vertex (1,0) and (1,1)
    expect(scalarValues[3]).toBe(200);
    expect(scalarValues[4]).toBe(200);
    expect(scalarValues[5]).toBe(200);
  });

  it("subtracts origin offset to maintain high precision for nanometer / large coordinate systems", () => {
    const originOffset: [number, number] = [1_000_000, 2_000_000];
    const verticesUv = new Float32Array([
      1_000_001, 2_000_002,
      1_000_003, 2_000_004,
      1_000_005, 2_000_006,
    ]);
    const scalarValues = new Float32Array([10, 20, 30]);

    const geometry = createFemCutSurfaceGeometry({
      originOffset,
      scalarValues,
      verticesUv,
    });

    const positions = geometry.getAttribute("position").array as Float32Array;
    expect(positions[0]).toBeCloseTo(1);
    expect(positions[1]).toBeCloseTo(2);
    expect(positions[2]).toBe(0);
    expect(positions[3]).toBeCloseTo(3);
    expect(positions[4]).toBeCloseTo(4);
    expect(positions[6]).toBeCloseTo(5);
    expect(positions[7]).toBeCloseTo(6);

    // Updates in-place
    updateFemCutSurfaceGeometry(geometry, {
      originOffset,
      scalarValues: new Float32Array([40, 50, 60]),
      verticesUv,
    });
    const updatedScalars = geometry.getAttribute(FEM_SCALAR_VALUE_ATTRIBUTE).array as Float32Array;
    expect(updatedScalars[0]).toBe(40);
    expect(updatedScalars[1]).toBe(50);
    expect(updatedScalars[2]).toBe(60);

    geometry.dispose();
  });

  it("constructs an unlit shader material with scalar-before-LUT evaluation and palette stops", () => {
    const material = createFemCutSurfaceMaterial({
      colormap: "coolwarm",
      opacity: 0.85,
      range: { max: 10, min: -10 },
    });

    expect(material.toneMapped).toBe(false);
    expect(material.transparent).toBe(true);
    expect(material.uniforms.fmOpacity.value).toBe(0.85);
    expect(material.uniforms.fmPaletteId.value).toBe(1); // coolwarm
    expect(material.uniforms.fmScalarMin.value).toBe(-10);
    expect(material.uniforms.fmScalarMax.value).toBe(10);
    expect(material.uniforms.fmColorModeId.value).toBe(0);

    // Palette change without reallocating shader program
    updateFemCutSurfaceMaterial(material, {
      colormap: "inferno",
      opacity: 1,
      range: { max: 5, min: 0 },
      vectorMode: "magnitude",
    });

    expect(material.uniforms.fmPaletteId.value).toBe(2); // inferno
    expect(material.uniforms.fmColorModeId.value).toBe(5); // magnitude
    expect(material.uniforms.fmScalarMin.value).toBe(0);
    expect(material.uniforms.fmScalarMax.value).toBe(5);
    expect(material.uniforms.fmOpacity.value).toBe(1);
    expect(material.transparent).toBe(false);

    material.dispose();
  });

  it("maps palette names and vector mode identifiers deterministically", () => {
    expect(paletteIdFromName("viridis")).toBe(0);
    expect(paletteIdFromName("coolwarm")).toBe(1);
    expect(paletteIdFromName("inferno")).toBe(2);
    expect(paletteIdFromName("jet")).toBe(3);
    expect(paletteIdFromName("magma")).toBe(4);
    expect(paletteIdFromName("twilight")).toBe(5);
    expect(paletteIdFromName("grayscale")).toBe(6);

    expect(vectorModeId("scalar")).toBe(0);
    expect(vectorModeId("orientation")).toBe(1);
    expect(vectorModeId("x")).toBe(2);
    expect(vectorModeId("y")).toBe(3);
    expect(vectorModeId("z")).toBe(4);
    expect(vectorModeId("magnitude")).toBe(5);
  });

  it("safely disposes mesh resources", () => {
    const geometry = createFemCutSurfaceGeometry({
      scalarValues: new Float32Array([1, 2, 3]),
      verticesUv: new Float32Array([0, 0, 1, 0, 0, 1]),
    });
    const material = createFemCutSurfaceMaterial({
      range: { max: 1, min: 0 },
    });
    const mesh = {
      geometry,
      material,
    } as any;

    expect(() => disposeFemCutSurfaceMesh(mesh)).not.toThrow();
  });
});
