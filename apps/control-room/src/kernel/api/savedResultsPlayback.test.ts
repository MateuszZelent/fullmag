import { describe, expect, it } from "vitest";
import { decodeSavedPlaybackFrame, decodeSavedPlaybackGeometry, savedPlaybackNodeCount, type SavedPlaybackResource } from "./savedResultsPlayback";
describe("saved frame binary decoding", () => {
  it("preserves xyz components including a final cell", () => {
    const buffer = new ArrayBuffer(48); const view = new DataView(buffer);
    [1,2,3,-4,5,6].forEach((v,i) => view.setFloat64(i*8,v,true));
    expect([...decodeSavedPlaybackFrame(buffer,2)]).toEqual([1,2,3,-4,5,6]);
  });
  it("rejects partial chunks, nonfinite values and oversized grids", () => {
    expect(() => decodeSavedPlaybackFrame(new ArrayBuffer(16),1)).toThrow();
    const b = new ArrayBuffer(24); new DataView(b).setFloat64(8,NaN,true);
    expect(() => decodeSavedPlaybackFrame(b,1)).toThrow();
    expect(() => decodeSavedPlaybackFrame(new ArrayBuffer(0),1e9)).toThrow();
  });
});


it("decodes nodal FEM extents without pretending it is a regular grid",()=>{
  expect(savedPlaybackNodeCount({fem_mesh:{node_count:5}} as unknown as SavedPlaybackResource)).toBe(5);
  expect(savedPlaybackNodeCount({grid_cells_xyz:[2,3,4]} as SavedPlaybackResource)).toBe(24);
  expect(()=>savedPlaybackNodeCount({} as SavedPlaybackResource)).toThrow(/node count/);
});


it("verifies geometry content identity and canonical node counts before publishing buffers",async()=>{
  const topology=new ArrayBuffer(144),view=new DataView(topology);
  new Uint8Array(topology,0,4).set(new TextEncoder().encode("FMMT"));
  view.setUint8(4,1);view.setUint8(5,1);view.setUint32(8,4,true);view.setUint32(12,1,true);
  new Float64Array(topology,32,12).set([0,0,0,1e-6,0,0,0,1e-6,0,0,0,1e-6]);
  new Uint32Array(topology,128,4).set([0,1,2,3]);
  const support=new ArrayBuffer(25),sv=new DataView(support);
  new Uint8Array(support,0,4).set(new TextEncoder().encode("FMSP"));
  sv.setUint16(4,1,true);sv.setBigUint64(8,BigInt(4),true);sv.setBigUint64(16,BigInt(1),true);sv.setUint8(24,15);
  const hash=async(buffer:ArrayBuffer)=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",buffer)),v=>v.toString(16).padStart(2,"0")).join("");
  const mesh={node_count:4,cell_count:1,facet_count:0,geometry_sha256:"a".repeat(64),topology_byte_length:144,topology_sha256:await hash(topology),support_byte_length:25,support_sha256:await hash(support)};
  const result=await decodeSavedPlaybackGeometry(topology,support,mesh);
  expect(result.topology.nodeCount).toBe(4);
  expect(result.support.bits[0]).toBe(15);
  const corrupt=topology.slice(0);new Uint8Array(corrupt)[32]=1;
  await expect(decodeSavedPlaybackGeometry(corrupt,support,mesh)).rejects.toThrow(/checksum/);
  await expect(decodeSavedPlaybackGeometry(topology,support,{...mesh,node_count:5})).rejects.toThrow(/differs/);
  await expect(decodeSavedPlaybackGeometry(topology,support,{...mesh,support_sha256:"b".repeat(64)})).rejects.toThrow(/checksum/);
});
