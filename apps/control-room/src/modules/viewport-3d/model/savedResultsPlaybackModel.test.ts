import { describe, expect, it } from "vitest";
import { savedFrameColors, savedGridGeometry } from "./savedResultsPlaybackModel";
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
