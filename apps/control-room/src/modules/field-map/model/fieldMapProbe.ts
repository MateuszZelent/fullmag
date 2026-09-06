export interface ProbeFrame {
  origin: readonly [number, number, number];
  uAxis: readonly [number, number, number];
  vAxis: readonly [number, number, number];
}

export interface LocalProbeOptions {
  continuous?: boolean;
  probeKind?: "raster_preview" | "continuous_evaluation";
}

export interface LocalProbeResult {
  index: number;
  occupancy: string;
  probeKind?: "raster_preview" | "continuous_evaluation";
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
    if (options?.probeKind) {
      res.probeKind = options.probeKind;
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

    const fx = Math.max(0, Math.min(1, xCell - c0));
    const fy = Math.max(0, Math.min(1, yCell - r0));

    const idx00 = r0 * resolution[0] + c0;
    const idx10 = r0 * resolution[0] + c1;
    const idx01 = r1 * resolution[0] + c0;
    const idx11 = r1 * resolution[0] + c1;

    const occ00 = isRenderablePlanarOccupancy(mask?.[idx00]);
    const occ10 = isRenderablePlanarOccupancy(mask?.[idx10]);
    const occ01 = isRenderablePlanarOccupancy(mask?.[idx01]);
    const occ11 = isRenderablePlanarOccupancy(mask?.[idx11]);

    let weightSum = 0;
    let valSum = 0;

    const w00 = (1 - fx) * (1 - fy);
    if (occ00) {
      const vVal = values[idx00] ?? 0;
      if (Number.isFinite(vVal)) {
        valSum += w00 * vVal;
        weightSum += w00;
      }
    }
    const w10 = fx * (1 - fy);
    if (occ10) {
      const vVal = values[idx10] ?? 0;
      if (Number.isFinite(vVal)) {
        valSum += w10 * vVal;
        weightSum += w10;
      }
    }
    const w01 = (1 - fx) * fy;
    if (occ01) {
      const vVal = values[idx01] ?? 0;
      if (Number.isFinite(vVal)) {
        valSum += w01 * vVal;
        weightSum += w01;
      }
    }
    const w11 = fx * fy;
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

  const res: LocalProbeResult = {
    index,
    occupancy: planarOccupancyLabel(occupancyCode),
    value: sampledValue,
  };
  if (options) {
    if (options.probeKind) res.probeKind = options.probeKind;
    res.requestedPoint = [u, v];
    res.sampledPoint = [
      bounds[0] + (x + 0.5) * du,
      bounds[2] + (y + 0.5) * dv,
    ];
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
    probeKind: "continuous_evaluation",
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
