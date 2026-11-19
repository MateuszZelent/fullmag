import { decodeTopology } from "./codecs/topologyCodec";
import { decodeSavedSupport } from "./codecs/savedSupportCodec";
import type { components } from "./generated/openapi-v2-types";
export type SavedPlaybackResource = components["schemas"]["SavedPlaybackResource"];

/** Decode the source-owned little-endian AoS xyz payload; never reinterpret a malformed frame. */
export function decodeSavedPlaybackFrame(buffer: ArrayBuffer, cells: number): Float64Array {
  if (!Number.isSafeInteger(cells) || cells <= 0 || cells > Math.floor(64 * 1024 * 1024 / 24)
      || buffer.byteLength !== cells * 24) throw new Error("Saved frame size differs from its geometry.");
  const data = new Float64Array(cells * 3);
  const view = new DataView(buffer);
  for (let i = 0; i < data.length; i++) {
    const value = view.getFloat64(i * 8, true);
    if (!Number.isFinite(value)) throw new Error("Saved frame contains non-finite values.");
    data[i] = value;
  }
  return data;
}


export function savedPlaybackNodeCount(source: SavedPlaybackResource): number {
  const count=source.fem_mesh?.node_count ?? source.grid_cells_xyz?.reduce((a,b)=>a*b,1);
  if (!count || !Number.isSafeInteger(count) || count > Math.floor(64*1024*1024/24)) throw new Error("Saved field has an invalid node count.");
  return count;
}


export async function decodeSavedPlaybackGeometry(topologyBody: ArrayBuffer, supportBody: ArrayBuffer,
  mesh: NonNullable<SavedPlaybackResource["fem_mesh"]>, signal?: AbortSignal) {
  if (!mesh.topology_byte_length || !mesh.topology_sha256 || !mesh.support_byte_length || !mesh.support_sha256 ||
      topologyBody.byteLength!==mesh.topology_byte_length || !/^[a-f0-9]{64}$/.test(mesh.topology_sha256)) throw new Error("Saved geometry binary identity is missing or invalid.");
  signal?.throwIfAborted();
  const digest=await crypto.subtle.digest("SHA-256",topologyBody);
  signal?.throwIfAborted();
  const hash=Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,"0")).join("");
  if(hash!==mesh.topology_sha256) throw new Error("Saved topology checksum differs from its manifest.");
  const topology=decodeTopology(topologyBody);
  if(topology.nodeCount!==mesh.node_count || topology.elementCount!==mesh.cell_count || topology.boundaryFaceCount!==mesh.facet_count) throw new Error("Saved topology differs from its manifest.");
  const support=await decodeSavedSupport(supportBody,{nodeCount:String(mesh.node_count),byteLength:String(mesh.support_byte_length),sha256:mesh.support_sha256},signal);
  return {topology,support};
}
