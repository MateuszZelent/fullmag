import { buildVertexScalarColors } from "../viewport3dFieldMapping";
import { MAX_ANTENNA_DISPLAY_PAYLOAD_BYTES } from "./antennaFieldOverlayModel";
import type { prepareArtifactFieldOverlay } from "./artifactFieldOverlayModel";

type Prepared = ReturnType<typeof prepareArtifactFieldOverlay>;
const faceProjections = new WeakMap<Prepared, ReturnType<typeof buildFaceProjection>>();

/** Average only the three owned trace slots of each exterior face. */
function buildFaceProjection(data: Prepared) {
  const indices = data.surfaceTriangles;
  if (!indices) throw new Error("Face projection requires an owned boundary.");
  const corners = indices.length, components = data.scalar ? 1 : 3;
  // Expanded coordinates, physical values, shader attributes and sequential indices.
  if (corners * (12 + components * 8 + components * 4 + 4) > MAX_ANTENNA_DISPLAY_PAYLOAD_BYTES) throw new Error("Owned face projection exceeds the display payload budget.");
  const positions = new Float32Array(corners * 3), values = new Float64Array(corners * components);
  for (let face = 0; face < corners; face += 3) {
    for (let component = 0; component < components; component++) {
      let mean = 0;
      for (let corner = 0; corner < 3; corner++) mean += data.field.values[indices[face + corner] * components + component] / 3;
      for (let corner = 0; corner < 3; corner++) values[(face + corner) * components + component] = mean;
    }
    for (let corner = 0; corner < 3; corner++) positions.set(data.positions.subarray(indices[face + corner] * 3, indices[face + corner] * 3 + 3), (face + corner) * 3);
  }
  const scalarValues = data.scalar ? buildVertexScalarColors({ ...data.field, pointCount: corners, values }, corners, corners, "magnitude", "viridis")?.scalarValues ?? null : null;
  if (data.scalar && !scalarValues) throw new Error("Owned face potential has no scalar buffer.");
  return { positions, triangles: Uint32Array.from({ length: corners }, (_, index) => index), values, scalarValues,
    vectorValues: data.scalar ? new Float32Array(0) : Float32Array.from(values, value => value / data.surfaceVectorScale) };
}

export function artifactSurfaceProjection(data: Prepared, mode: string | undefined, enabled: boolean) {
  if (!enabled || !mode || mode === "raw_nodal") return data.rawSurface;
  if (mode !== "surface_faces") throw new Error("Thickness projection is unavailable for this owned artifact carrier; choose raw nodal or surface faces.");
  let projection = faceProjections.get(data);
  if (!projection) { projection = buildFaceProjection(data); faceProjections.set(data, projection); }
  return projection;
}
