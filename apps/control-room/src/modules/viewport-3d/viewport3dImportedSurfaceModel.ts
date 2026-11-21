import type { ImportedSourceSurfaceResource } from "@/kernel/api/apiTypes";
import type { DecodedTopology } from "@/kernel/api/codecs";
import type { Viewport3DBounds } from "./viewport3dRenderModel";

export interface ImportedSurfaceSource {
  descriptor: ImportedSourceSurfaceResource;
  topology: DecodedTopology;
}
export interface ImportedSurfacePreview {
  bounds: Viewport3DBounds;
  positions: Float64Array;
  triangles: Uint32Array;
  surfaceId: string;
}

/** Adapt source-only local SI triangles; no volume cells or physics are inferred. */
export function buildImportedSurfacePreview(source: ImportedSurfaceSource, transformValue: unknown): ImportedSurfacePreview {
  const { descriptor, topology } = source;
  if (descriptor.purpose !== "authoring_source_surface" || descriptor.solver_eligible !== false
      || descriptor.coordinate_frame !== "object_local" || descriptor.coordinate_unit !== "m"
      || topology.formatVersion !== 2 || topology.cellCount !== 0
      || topology.nodeCount !== descriptor.node_count || topology.facetCount !== descriptor.triangle_count
      || !topology.facetTypes?.every(type => type === 1) || !topology.facetNodes
      || topology.facetNodes.length !== descriptor.triangle_count * 3) {
    throw new Error("Imported surface topology differs from its source descriptor.");
  }
  const transform = (transformValue ?? {}) as Record<string, unknown>;
  const vector = (value: unknown, fallback: number[], length: number): number[] => {
    const values = value ?? fallback;
    if (!Array.isArray(values) || values.length !== length
        || !values.every(value => typeof value === "number" && Number.isFinite(value))) {
      throw new Error("Imported surface transform requires finite coordinates.");
    }
    return values;
  };
  const translation = vector(transform.translation, [0, 0, 0], 3);
  const scale = vector(transform.scale, [1, 1, 1], 3);
  const pivot = vector(transform.pivot, [0, 0, 0], 3);
  const [qx, qy, qz, qw] = vector(transform.rotation_quat, [0, 0, 0, 1], 4);
  if (scale.some(value => value <= 0) || pivot.some(value => value !== 0)
      || Math.abs(Math.hypot(qx, qy, qz, qw) - 1) > 1e-9) {
    throw new Error("Imported surface requires a positive scale, unit quaternion and zero pivot.");
  }
  const positions = new Float64Array(topology.positions.length);
  const lower: [number, number, number] = [Infinity, Infinity, Infinity];
  const upper: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    const x = topology.positions[i] * scale[0];
    const y = topology.positions[i + 1] * scale[1];
    const z = topology.positions[i + 2] * scale[2];
    const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
    positions[i] = x + qw * tx + qy * tz - qz * ty + translation[0];
    positions[i + 1] = y + qw * ty + qz * tx - qx * tz + translation[1];
    positions[i + 2] = z + qw * tz + qx * ty - qy * tx + translation[2];
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[i + axis];
      if (!Number.isFinite(value)) throw new Error("Imported surface world coordinates are not finite.");
      lower[axis] = Math.min(lower[axis], value);
      upper[axis] = Math.max(upper[axis], value);
    }
  }
  const center: [number, number, number] = [0, 0, 0], size: [number, number, number] = [0, 0, 0];
  for (let axis = 0; axis < 3; axis += 1) {
    size[axis] = upper[axis] - lower[axis];
    center[axis] = lower[axis] + size[axis] / 2;
    if (!Number.isFinite(size[axis]) || !Number.isFinite(center[axis])) throw new Error("Imported surface bounds are not finite.");
  }
  return { bounds: { center, size, radius: Math.hypot(...size) / 2 }, positions,
    triangles: topology.facetNodes, surfaceId: descriptor.surface_id };
}


export interface ImportedSurfaceCollection {
  sources: Map<string, ImportedSurfaceSource>;
  diagnostics: Array<{ objectId: string; message: string }>;
}

export function isImportedStlGeometry(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const geometry = value as Record<string, unknown>;
  if (geometry.geometry_kind !== "ImportedGeometry") return false;
  const params = (geometry.geometry_params ?? {}) as Record<string, unknown>;
  return Boolean(geometry.source_asset)
    || (typeof params.source === "string" && params.source.toLowerCase().endsWith(".stl"))
    || (typeof params.format === "string" && params.format.toLowerCase() === "stl");
}

/** A failed object must not erase healthy source geometry in the same scene. */
export async function loadImportedSurfaceSources(
  objectIds: readonly string[],
  load: (objectId: string) => Promise<ImportedSurfaceSource>,
  signal: AbortSignal,
): Promise<ImportedSurfaceCollection> {
  const collection: ImportedSurfaceCollection = { sources: new Map(), diagnostics: [] };
  await objectIds.reduce<Promise<void>>(
    (pending, objectId) => pending.then(async () => {
      if (signal.aborted) throw new DOMException("Source load aborted", "AbortError");
      try {
        collection.sources.set(objectId, await load(objectId));
      } catch (error) {
        if (signal.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
        collection.diagnostics.push({ objectId, message: error instanceof Error ? error.message : "STL source unavailable." });
      }
    }),
    Promise.resolve(),
  );
  return collection;
}
