import {
  decodePlanarMeshOverlay,
  type PlanarMeshOverlay,
} from "@/kernel/api/codecs/crossSectionCodec";
import { decodeFdmPlanarGridOverlay } from "@/kernel/api/codecs/fdmPlanarGridOverlayCodec";

export type { PlanarMeshOverlay };

export function decodePlanarMeshOverlayForDescriptor(
  buffer: ArrayBuffer,
  descriptor: { codec?: string | null },
  segmentBudget = 200_000,
): PlanarMeshOverlay {
  const magic = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength)));
  const decoded = magic === "FMFG"
    ? decodeFdmPlanarGridOverlay(buffer, segmentBudget)
    : magic === "FMCS"
      ? decodePlanarMeshOverlay(buffer, segmentBudget)
      : (() => { throw new Error(`Unsupported planar mesh overlay payload magic: ${magic || "empty"}`); })();
  if (decoded.codec !== descriptor.codec) {
    throw new Error(`Planar mesh overlay codec mismatch: descriptor ${descriptor.codec}, payload ${decoded.codec}`);
  }
  return decoded;
}
