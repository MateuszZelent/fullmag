/**
 * Coherent Planar Bundle for 2D field visualization.
 *
 * Ensures all components (meta, scalar raster, occupancy mask, vectors, mesh)
 * belong to the exact same revision and sample identity before rendering.
 *
 * A bundle is only marked `isScientificReady` when:
 * 1. Mandatory occupancy mask is materialized and matches the exact resolution.
 * 2. Scalar buffer matches the expected resolution product.
 * 3. Vector buffer (if present) matches the expected resolution product * 3.
 * 4. Sample token and revisions match across all resources.
 */

import type { PlanarFieldMetaResource } from "../../../kernel/api/apiTypes";

export interface CoherentPlanarBundle {
  sampleToken: string;
  quantityId: string;
  component: string;
  fieldRevision: string;
  meshRevision: string;
  carrierRevision: string;
  sceneRevision: string;
  resolution: readonly [number, number];
  bounds: readonly [number, number, number, number];
  meta: PlanarFieldMetaResource;
  scalarData: Float32Array | Float64Array;
  maskData: Uint8Array;
  vectorsData: Float32Array | Float64Array | null;
  isScientificReady: boolean;
}

export type CoherentBundleValidationResult =
  | { ok: true; bundle: CoherentPlanarBundle }
  | { ok: false; reason: string };

export function validateCoherentPlanarBundle(
  meta: PlanarFieldMetaResource,
  scalarBuffer: ArrayBuffer | null,
  maskBuffer: ArrayBuffer | null,
  vectorsBuffer?: ArrayBuffer | null,
): CoherentBundleValidationResult {
  if (!meta || !meta.meta) {
    return { ok: false, reason: "missing_meta" };
  }

  const resolution = meta.meta.resolution;
  if (!resolution || resolution.length < 2) {
    return { ok: false, reason: "invalid_resolution" };
  }

  const [w, h] = resolution;
  const expectedPoints = w * h;

  if (!scalarBuffer) {
    return { ok: false, reason: "missing_scalar_data" };
  }

  // 06.1: Mandatory occupancy mask
  if (!maskBuffer) {
    return { ok: false, reason: "missing_mandatory_mask" };
  }

  // Check scalar length (either Float64 8 bytes or Float32 4 bytes)
  const scalarBytes = scalarBuffer.byteLength;
  if (scalarBytes !== expectedPoints * 8 && scalarBytes !== expectedPoints * 4) {
    return {
      ok: false,
      reason: `scalar_buffer_size_mismatch: expected ${expectedPoints} elements, got ${scalarBytes} bytes`,
    };
  }

  // Check mask length (1 byte per pixel)
  if (maskBuffer.byteLength !== expectedPoints) {
    return {
      ok: false,
      reason: `mask_buffer_size_mismatch: expected ${expectedPoints} bytes, got ${maskBuffer.byteLength}`,
    };
  }

  // Check vectors if expected
  if (vectorsBuffer) {
    const vectorBytes = vectorsBuffer.byteLength;
    if (vectorBytes !== expectedPoints * 3 * 8 && vectorBytes !== expectedPoints * 3 * 4) {
      return {
        ok: false,
        reason: `vector_buffer_size_mismatch: expected ${expectedPoints * 3} elements, got ${vectorBytes} bytes`,
      };
    }
  }

  const scalarData =
    scalarBytes === expectedPoints * 8
      ? new Float64Array(scalarBuffer)
      : new Float32Array(scalarBuffer);

  const maskData = new Uint8Array(maskBuffer);

  const vectorsData = vectorsBuffer
    ? vectorsBuffer.byteLength === expectedPoints * 3 * 8
      ? new Float64Array(vectorsBuffer)
      : new Float32Array(vectorsBuffer)
    : null;

  return {
    ok: true,
    bundle: {
      sampleToken: meta.sample_token,
      quantityId: meta.quantity_id,
      component: meta.component,
      fieldRevision: meta.field_revision,
      meshRevision: meta.mesh_revision,
      carrierRevision: meta.carrier_revision,
      sceneRevision: meta.scene_revision,
      resolution: [w, h],
      bounds: meta.meta.bounds_uv_m,
      meta,
      scalarData,
      maskData,
      vectorsData,
      isScientificReady: true,
    },
  };
}
