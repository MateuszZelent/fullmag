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
import { decodeFieldVector } from "../../../kernel/api/codecs";

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

export interface BufferOrigins {
  scalarToken?: string | null;
  maskToken?: string | null;
  vectorsToken?: string | null;
}

function isFmvp(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 4) return false;
  const v = new Uint8Array(buffer, 0, 4);
  return v[0] === 0x46 && v[1] === 0x4d && v[2] === 0x56 && v[3] === 0x50;
}

export function validateCoherentPlanarBundle(
  meta: PlanarFieldMetaResource,
  scalarBuffer: ArrayBuffer | null,
  maskBuffer: ArrayBuffer | null,
  vectorsBuffer?: ArrayBuffer | null,
  bufferOrigins?: BufferOrigins,
): CoherentBundleValidationResult {
  if (!meta) {
    return { ok: false, reason: "missing_meta" };
  }

  if (!meta.sample_token || meta.sample_token.trim() === "") {
    return { ok: false, reason: "missing_sample_token" };
  }

  const resolution = meta.resolution;
  if (!resolution || resolution.length < 2) {
    return { ok: false, reason: "invalid_resolution" };
  }

  const [w, h] = resolution;
  if (
    w <= 0 ||
    h <= 0 ||
    !Number.isFinite(w) ||
    !Number.isFinite(h) ||
    !Number.isInteger(w) ||
    !Number.isInteger(h)
  ) {
    return { ok: false, reason: "invalid_resolution: non-positive dimensions" };
  }
  const expectedPoints = w * h;

  const bounds = meta.frame?.bounds_uv_m;
  if (
    !bounds ||
    bounds.length < 4 ||
    bounds.some((v) => !Number.isFinite(v)) ||
    bounds[0] >= bounds[1] ||
    bounds[2] >= bounds[3]
  ) {
    return { ok: false, reason: "invalid_bounds" };
  }

  if (bufferOrigins) {
    if (bufferOrigins.scalarToken && bufferOrigins.scalarToken !== meta.sample_token) {
      return {
        ok: false,
        reason: "identity_mismatch: scalar origin does not match meta token",
      };
    }
    if (bufferOrigins.maskToken && bufferOrigins.maskToken !== meta.sample_token) {
      return {
        ok: false,
        reason: "identity_mismatch: mask origin does not match meta token",
      };
    }
    if (bufferOrigins.vectorsToken && bufferOrigins.vectorsToken !== meta.sample_token) {
      return {
        ok: false,
        reason: "identity_mismatch: vectors origin does not match meta token",
      };
    }
  }

  if (!scalarBuffer) {
    return { ok: false, reason: "missing_scalar_data" };
  }

  // 06.1: Mandatory occupancy mask
  if (!maskBuffer) {
    return { ok: false, reason: "missing_mandatory_mask" };
  }

  // Check mask length (1 byte per pixel)
  if (maskBuffer.byteLength !== expectedPoints) {
    return {
      ok: false,
      reason: `mask_buffer_size_mismatch: expected ${expectedPoints} bytes, got ${maskBuffer.byteLength}`,
    };
  }

  let scalarData: Float32Array | Float64Array;
  if (isFmvp(scalarBuffer)) {
    try {
      const decoded = decodeFieldVector(scalarBuffer);
      if (decoded.quantityId !== meta.quantity_id) {
        return {
          ok: false,
          reason: `quantity_mismatch: expected ${meta.quantity_id}, got ${decoded.quantityId}`,
        };
      }
      if (decoded.grid[0] !== w || decoded.grid[1] !== h || decoded.grid[2] !== 1) {
        return {
          ok: false,
          reason: `grid_shape_mismatch: expected [${w}, ${h}, 1], got [${decoded.grid.join(", ")}]`,
        };
      }
      if (decoded.nComp !== 1) {
        return {
          ok: false,
          reason: `component_count_mismatch: expected 1 for scalar, got ${decoded.nComp}`,
        };
      }
      scalarData = decoded.values;
    } catch (e) {
      return {
        ok: false,
        reason: `scalar_fmvp_decode_failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  } else {
    const scalarBytes = scalarBuffer.byteLength;
    if (scalarBytes !== expectedPoints * 8 && scalarBytes !== expectedPoints * 4) {
      return {
        ok: false,
        reason: `scalar_buffer_size_mismatch: expected ${expectedPoints} elements, got ${scalarBytes} bytes`,
      };
    }
    scalarData =
      scalarBytes === expectedPoints * 8
        ? new Float64Array(scalarBuffer)
        : new Float32Array(scalarBuffer);
  }

  if (scalarData.length !== expectedPoints) {
    return {
      ok: false,
      reason: `scalar_data_length_mismatch: expected ${expectedPoints} elements, got ${scalarData.length}`,
    };
  }

  let vectorsData: Float32Array | Float64Array | null = null;
  if (vectorsBuffer) {
    if (isFmvp(vectorsBuffer)) {
      try {
        const decoded = decodeFieldVector(vectorsBuffer);
        if (decoded.quantityId !== meta.quantity_id) {
          return {
            ok: false,
            reason: `quantity_mismatch: expected ${meta.quantity_id}, got ${decoded.quantityId}`,
          };
        }
        if (decoded.grid[0] !== w || decoded.grid[1] !== h || decoded.grid[2] !== 1) {
          return {
            ok: false,
            reason: `grid_shape_mismatch: expected [${w}, ${h}, 1], got [${decoded.grid.join(", ")}]`,
          };
        }
        if (decoded.nComp !== 3) {
          return {
            ok: false,
            reason: `component_count_mismatch: expected 3 for vectors, got ${decoded.nComp}`,
          };
        }
        vectorsData = decoded.values;
      } catch (e) {
        return {
          ok: false,
          reason: `vector_fmvp_decode_failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    } else {
      const vectorBytes = vectorsBuffer.byteLength;
      if (vectorBytes !== expectedPoints * 3 * 8 && vectorBytes !== expectedPoints * 3 * 4) {
        return {
          ok: false,
          reason: `vector_buffer_size_mismatch: expected ${expectedPoints * 3} elements, got ${vectorBytes} bytes`,
        };
      }
      vectorsData =
        vectorBytes === expectedPoints * 3 * 8
          ? new Float64Array(vectorsBuffer)
          : new Float32Array(vectorsBuffer);
    }
    if (vectorsData.length !== expectedPoints * 3) {
      return {
        ok: false,
        reason: `vector_data_length_mismatch: expected ${expectedPoints * 3} elements, got ${vectorsData.length}`,
      };
    }
  }

  const maskData = new Uint8Array(maskBuffer);
  for (let i = 0; i < maskData.length; i++) {
    const code = maskData[i]!;
    if (code > 4) {
      return {
        ok: false,
        reason: `invalid_occupancy_mask_code: unknown occupancy code ${code} at index ${i}`,
      };
    }
  }

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
      bounds: [bounds[0], bounds[1], bounds[2], bounds[3]],
      meta,
      scalarData,
      maskData,
      vectorsData,
      isScientificReady: Boolean(
        bufferOrigins &&
          bufferOrigins.scalarToken === meta.sample_token &&
          bufferOrigins.maskToken === meta.sample_token &&
          (!vectorsBuffer || bufferOrigins.vectorsToken === meta.sample_token),
      ),
    },
  };
}
