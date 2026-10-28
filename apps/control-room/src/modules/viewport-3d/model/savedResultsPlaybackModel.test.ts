import { describe, expect, it } from "vitest";
import { savedCameraDistance, savedFrameColors, savedGridGeometry, savedSurfaceGeometry } from "./savedResultsPlaybackModel";
import type { SavedPlaybackResource } from "@/kernel/api/savedResultsPlayback";
describe("saved FDM field adapter",()=>{
  it("keeps x-fastest physical cell centers in micrometre render units",()=>{
    const s={grid_cells_xyz:[2,2,1],cell_size_m:[5e-9,5e-9,20e-9],origin_m:[-5e-9,-5e-9,-10e-9]} as SavedPlaybackResource;
    const g=savedGridGeometry(s);
    expect(g.count).toBe(4); expect(g.center).toEqual([0,0,0]);
    expect(g.positions[0]).toBeCloseTo(-0.0025);
    expect(g.positions[3]).toBeCloseTo(0.0025);
    expect(g.positions[7]).toBeCloseTo(0.0025);
  });
  it("uses the requested component and preserves a fixed scale between frames",()=>{
    const a=savedFrameColors(new Float64Array([0,1,-0.1,0,1,0.1]),2,0.5);
    const b=savedFrameColors(new Float64Array([0,1,-0.2,0,1,0.2]),2,0.5);
    expect(a.limit).toBe(0.5); expect(b.limit).toBe(0.5);
    expect(a.colors).not.toEqual(b.colors);
    expect(savedFrameColors(new Float64Array(6),2,null).limit).toBeGreaterThan(0);
  });
});


describe("saved FEM nodal surface adapter",()=>{
  const topology={
    nodeCount:5,positions:new Float64Array([0,0,0,1e-6,0,0,0,1e-6,0,0,0,1e-6,0,0,-1e-6]),
    elementCount:2,indices:new Uint32Array([0,1,2,3,0,2,1,4]),
    elementMarkers:new Uint32Array([1,2]),boundaryFaceCount:0,boundaryFaces:new Uint32Array(),boundaryMarkers:new Uint32Array(),
    cellCount:2,cellTypes:new Uint32Array([1,1]),cellOffsets:new Uint32Array([0,4,8]),cellNodes:new Uint32Array([0,1,2,3,0,2,1,4]),
  };
  it("preserves canonical node indices and extracts the magnetic interface against inactive cells",()=>{
    const geometry=savedSurfaceGeometry(topology,{nodeCount:5,bits:new Uint8Array([15])});
    expect(geometry.kind).toBe("surface");
    expect(geometry.positions[3]).toBe(1);
    expect(geometry.indices).toHaveLength(12);
    expect(Array.from(geometry.indices).every(node=>node<4)).toBe(true);
    expect(geometry.center).toEqual([0.5,0.5,0.5]);
    expect(geometry.size).toEqual([1,1,1]);
    expect(Array.from(geometry.activeNodes)).toEqual([1,1,1,1,0]);
  });
  it("excludes inactive values from automatic scale without reordering the nodal colors",()=>{
    const values=new Float64Array([0,0,0.1,0,0,-0.2,0,0,0.3,0,0,0.4,0,0,1000]);
    const result=savedFrameColors(values,2,null,new Uint8Array([1,1,1,1,0]));
    expect(result.limit).toBe(0.4);
    expect(result.colors).toHaveLength(15);
    expect(result.colors.slice(0,3)).not.toEqual(result.colors.slice(3,6));
  });
  it("rejects support from a different mesh and an empty active surface",()=>{
    expect(()=>savedSurfaceGeometry(topology,{nodeCount:4,bits:new Uint8Array([15])})).toThrow(/differ/);
    expect(()=>savedSurfaceGeometry(topology,{nodeCount:5,bits:new Uint8Array([3])})).toThrow(/no fully active/);
  });
});


it("fits a volumetric saved mesh inside both perspective axes including a narrow viewport",()=>{
  const radius=Math.sqrt(3)/2;
  for(const aspect of [0.5,0.95,2]) {
    const distance=savedCameraDistance([1,1,1],aspect);
    const halfAngle=Math.atan(Math.tan(Math.PI/8)*Math.min(1,aspect));
    expect(Math.asin(radius/distance)).toBeLessThan(halfAngle);
  }
  expect(savedCameraDistance([1,1,1],0.5)).toBeGreaterThan(savedCameraDistance([1,1,1],1));
});
