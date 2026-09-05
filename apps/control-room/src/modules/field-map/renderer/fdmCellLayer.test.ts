import { LinearFilter, type Mesh, NearestFilter } from "three";
import { describe, expect, it } from "vitest";

import { PLANAR_OCCUPANCY } from "../model/planarOccupancy";
import {
  createFdmCellMaterial,
  createFdmCellQuadGeometry,
  createFdmDataTexture,
  disposeFdmCellMesh,
  updateFdmCellMaterial,
  updateFdmCellQuadGeometry,
  updateFdmDataTexture,
} from "./fdmCellLayer";

describe("fdmCellLayer", () => {
  it("creates quad geometry with origin offset subtraction", () => {
    const bounds: [number, number, number, number] = [100, 200, 300, 400];
    const originOffset: [number, number] = [150, 350];

    const geometry = createFdmCellQuadGeometry(bounds, originOffset);
    const positions = geometry.getAttribute("position").array as Float32Array;

    // x0 = 100 - 150 = -50, x1 = 200 - 150 = 50
    // y0 = 300 - 350 = -50, y1 = 400 - 350 = 50
    expect(positions[0]).toBeCloseTo(-50);
    expect(positions[1]).toBeCloseTo(-50);
    expect(positions[3]).toBeCloseTo(50);
    expect(positions[4]).toBeCloseTo(-50);

    updateFdmCellQuadGeometry(geometry, [110, 210, 310, 410], originOffset);
    expect(positions[0]).toBeCloseTo(-40);
    expect(positions[1]).toBeCloseTo(-40);

    geometry.dispose();
  });

  it("configures NearestFilter for native P0 cells and distinguishes empty gaps from zero-field cells", () => {
    const scalar = new Float32Array([
      0.0, // occupied cell with zero field: f = 0
      5.0, // occupied cell
      Number.NaN, // unoccupied / hole
      10.0, // empty mask cell
    ]);
    const mask = new Uint8Array([
      PLANAR_OCCUPANCY.occupied, // occupied (0)
      PLANAR_OCCUPANCY.occupied, // occupied (0)
      PLANAR_OCCUPANCY.empty, // empty (1)
      PLANAR_OCCUPANCY.empty, // empty (1)
    ]);

    const texture = createFdmDataTexture(scalar, [2, 2], mask, false);

    expect(texture.magFilter).toBe(NearestFilter);
    expect(texture.minFilter).toBe(NearestFilter);

    const data = texture.image.data as Float32Array;

    // Pixel 0: f=0 in material -> value=0, occupied=1.0 (must NOT be discarded!)
    expect(data[0]).toBe(0.0);
    expect(data[1]).toBe(1.0);

    // Pixel 1: f=5 in material -> value=5, occupied=1.0
    expect(data[4]).toBe(5.0);
    expect(data[5]).toBe(1.0);

    // Pixel 2: NaN in hole -> value=0, occupied=0.0 (discarded in shader!)
    expect(data[9]).toBe(0.0);

    // Pixel 3: mask=0 -> value=0, occupied=0.0 (discarded in shader!)
    expect(data[13]).toBe(0.0);

    // Update with smooth = true switches to LinearFilter
    updateFdmDataTexture(texture, scalar, [2, 2], mask, true);
    expect(texture.magFilter).toBe(LinearFilter);
    expect(texture.minFilter).toBe(LinearFilter);

    texture.dispose();
  });

  it("creates and updates unlit FDM cell shader material", () => {
    const texture = createFdmDataTexture(new Float32Array([1]), [1, 1]);
    const material = createFdmCellMaterial(texture, {
      colormap: "viridis",
      opacity: 0.9,
      range: { max: 100, min: 0 },
    });

    expect(material.toneMapped).toBe(false);
    expect(material.transparent).toBe(true);
    expect(material.uniforms.fmFieldTexture.value).toBe(texture);
    expect(material.uniforms.fmScalarMin.value).toBe(0);
    expect(material.uniforms.fmScalarMax.value).toBe(100);
    expect(material.uniforms.fmOpacity.value).toBe(0.9);

    updateFdmCellMaterial(material, texture, {
      colormap: "coolwarm",
      opacity: 1,
      range: { max: 50, min: -50 },
    });

    expect(material.uniforms.fmPaletteId.value).toBe(1); // coolwarm
    expect(material.uniforms.fmScalarMin.value).toBe(-50);
    expect(material.uniforms.fmScalarMax.value).toBe(50);
    expect(material.uniforms.fmOpacity.value).toBe(1);

    texture.dispose();
    material.dispose();
  });

  it("safely disposes mesh and its underlying data texture", () => {
    const geometry = createFdmCellQuadGeometry([0, 1, 0, 1]);
    const texture = createFdmDataTexture(new Float32Array([1]), [1, 1]);
    const material = createFdmCellMaterial(texture, { range: { max: 1, min: 0 } });
    const mesh = { geometry, material } as unknown as Mesh;

    expect(() => disposeFdmCellMesh(mesh)).not.toThrow();
  });
});
