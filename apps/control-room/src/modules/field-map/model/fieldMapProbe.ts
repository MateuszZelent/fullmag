export interface ProbeFrame {
  origin: readonly [number, number, number];
  uAxis: readonly [number, number, number];
  vAxis: readonly [number, number, number];
}

export type PlanarProbeKind =
  | "raster_cell"
  | "raster_preview"
  | "interpolated_raster_preview"
  | "continuous_evaluation";

export interface LocalProbeOptions {
  continuous?: boolean;
  probeKind?: PlanarProbeKind;
}

export interface LocalProbeResult {
  index: number;
  occupancy: string;
  probeKind?: PlanarProbeKind;
  requestedPoint?: [number, number];
  sampledPoint?: [number, number];
  value: number | null;
}

export function localProbe(
  u: number,
  v: number,
  bounds: readonly [number, number, number, number],
  resolution: readonly [number, number],
  values: ArrayLike<number>,
  mask?: ArrayLike<number>,
  options?: LocalProbeOptions,
): LocalProbeResult {
  if (
    !Number.isFinite(u) ||
    !Number.isFinite(v) ||
    u < bounds[0] ||
    u > bounds[1] ||
    v < bounds[2] ||
    v > bounds[3]
  ) {
    const res: LocalProbeResult = {
      index: -1,
      occupancy: "outside_extent",
      value: null,
    };
    if (options?.probeKind || options?.continuous) {
      res.probeKind = options?.probeKind ?? (options?.continuous ? "interpolated_raster_preview" : "raster_cell");
      res.requestedPoint = [u, v];
    }
    return res;
  }
  const uSpan = Math.max(1e-15, bounds[1] - bounds[0]);
  const vSpan = Math.max(1e-15, bounds[3] - bounds[2]);
  const du = uSpan / resolution[0];
  const dv = vSpan / resolution[1];

  const x = Math.min(
    resolution[0] - 1,
    Math.max(0, Math.floor(((u - bounds[0]) / uSpan) * resolution[0])),
  );
  const y = Math.min(
    resolution[1] - 1,
    Math.max(0, Math.floor(((v - bounds[2]) / vSpan) * resolution[1])),
  );
  const index = y * resolution[0] + x;
  const occupancyCode = mask?.[index];
  const renderable = isRenderablePlanarOccupancy(occupancyCode);

  let sampledValue = renderable ? (values[index] ?? null) : null;

  if (options?.continuous && renderable && resolution[0] > 1 && resolution[1] > 1) {
    const xCell = (u - bounds[0]) / du - 0.5;
    const yCell = (v - bounds[2]) / dv - 0.5;

    const c0 = Math.max(0, Math.min(resolution[0] - 2, Math.floor(xCell)));
    const c1 = c0 + 1;
    const r0 = Math.max(0, Math.min(resolution[1] - 2, Math.floor(yCell)));
    const r1 = r0 + 1;

    const fx = xCell - c0;
    const fy = yCell - r0;

    const idx00 = r0 * resolution[0] + c0;
    const idx10 = r0 * resolution[0] + c1;
    const idx01 = r1 * resolution[0] + c0;
    const idx11 = r1 * resolution[0] + c1;

    const occ00 = isRenderablePlanarOccupancy(mask?.[idx00]);
    const occ10 = isRenderablePlanarOccupancy(mask?.[idx10]);
    const occ01 = isRenderablePlanarOccupancy(mask?.[idx01]);
    const occ11 = isRenderablePlanarOccupancy(mask?.[idx11]);

    if (occ00 && occ10 && occ01 && occ11) {
      const v00 = values[idx00] ?? 0;
      const v10 = values[idx10] ?? 0;
      const v01 = values[idx01] ?? 0;
      const v11 = values[idx11] ?? 0;
      if (
        Number.isFinite(v00) &&
        Number.isFinite(v10) &&
        Number.isFinite(v01) &&
        Number.isFinite(v11)
      ) {
        const w00 = (1 - fx) * (1 - fy);
        const w10 = fx * (1 - fy);
        const w01 = (1 - fx) * fy;
        const w11 = fx * fy;
        sampledValue = w00 * v00 + w10 * v10 + w01 * v01 + w11 * v11;
      }
    } else {
      const cfx = Math.max(0, Math.min(1, fx));
      const cfy = Math.max(0, Math.min(1, fy));
      let weightSum = 0;
      let valSum = 0;

      const w00 = (1 - cfx) * (1 - cfy);
      if (occ00) {
        const vVal = values[idx00] ?? 0;
        if (Number.isFinite(vVal)) {
          valSum += w00 * vVal;
          weightSum += w00;
        }
      }
      const w10 = cfx * (1 - cfy);
      if (occ10) {
        const vVal = values[idx10] ?? 0;
        if (Number.isFinite(vVal)) {
          valSum += w10 * vVal;
          weightSum += w10;
        }
      }
      const w01 = (1 - cfx) * cfy;
      if (occ01) {
        const vVal = values[idx01] ?? 0;
        if (Number.isFinite(vVal)) {
          valSum += w01 * vVal;
          weightSum += w01;
        }
      }
      const w11 = cfx * cfy;
      if (occ11) {
        const vVal = values[idx11] ?? 0;
        if (Number.isFinite(vVal)) {
          valSum += w11 * vVal;
          weightSum += w11;
        }
      }

      if (weightSum > 1e-6) {
        sampledValue = valSum / weightSum;
      }
    }
  }

  const res: LocalProbeResult = {
    index,
    occupancy: planarOccupancyLabel(occupancyCode),
    value: sampledValue,
  };
  if (options) {
    res.probeKind = options.probeKind ?? (options.continuous ? "interpolated_raster_preview" : "raster_cell");
    res.requestedPoint = [u, v];
    res.sampledPoint = options.continuous
      ? [u, v]
      : [bounds[0] + (x + 0.5) * du, bounds[2] + (y + 0.5) * dv];
  }
  return res;
}

export function continuousPlanarProbe(
  u: number,
  v: number,
  bounds: readonly [number, number, number, number],
  resolution: readonly [number, number],
  values: ArrayLike<number>,
  mask?: ArrayLike<number>,
): LocalProbeResult {
  return localProbe(u, v, bounds, resolution, values, mask, {
    continuous: true,
    probeKind: "interpolated_raster_preview",
  });
}

export function probeWorldCoordinate(
  u: number,
  v: number,
  frame: ProbeFrame,
): [number, number, number] {
  return [0, 1, 2].map(
    (axis) =>
      frame.origin[axis]! +
      u * frame.uAxis[axis]! +
      v * frame.vAxis[axis]!,
  ) as [number, number, number];
}
import {
  isRenderablePlanarOccupancy,
  planarOccupancyLabel,
} from "./planarOccupancy";
