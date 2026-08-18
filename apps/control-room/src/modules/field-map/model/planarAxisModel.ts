export type PlanarAxisVector = readonly [number, number, number];

export type PlanarAxisPreset = "oblique" | "xy" | "xz" | "yz";

export interface PlanarDisplayLengthUnit {
  scale: number;
  symbol: "m" | "mm" | "nm" | "µm";
}

export interface PlanarAxisFrame {
  normal: PlanarAxisVector;
  origin: PlanarAxisVector;
  uAxis: PlanarAxisVector;
  vAxis: PlanarAxisVector;
}

export interface PlanarAxisTick {
  endpoint: boolean;
  label: string;
  positionPx: number;
  value: number;
  zero: boolean;
}

export interface ResolvedPlanarAxis {
  directionWorld: PlanarAxisVector;
  label: string;
  rangeMetres: readonly [number, number];
  stepMetres: number;
  ticks: readonly PlanarAxisTick[];
}

export interface ResolvedPlanarAxes {
  cut: {
    directionWorld: PlanarAxisVector;
    label: string;
  };
  displayLengthUnit: PlanarDisplayLengthUnit;
  horizontal: ResolvedPlanarAxis;
  preset: PlanarAxisPreset;
  vertical: ResolvedPlanarAxis;
}

const CARTESIAN_TOLERANCE = 1e-9;
const MAX_TICK_CANDIDATES = 64;
const NICE_MANTISSAS = [1, 2, 2.5, 5, 10] as const;

interface AxisTransform {
  offset: number;
  sign: -1 | 1;
}

interface AxisLabels {
  cut: string;
  horizontal: string;
  horizontalWorldAxis: 0 | 1 | 2 | null;
  preset: PlanarAxisPreset;
  vertical: string;
  verticalWorldAxis: 0 | 1 | 2 | null;
}

export function resolvePlanarAxes(
  frame: PlanarAxisFrame,
  bounds: readonly [number, number, number, number],
  viewport: readonly [number, number, number, number],
  plotWidthPx: number,
  plotHeightPx: number,
): ResolvedPlanarAxes {
  const horizontalLocalRange = safeRange(viewport[0], viewport[1], bounds[0], bounds[1]);
  const verticalLocalRange = safeRange(viewport[2], viewport[3], bounds[2], bounds[3]);
  const largestVisibleSpan = Math.max(
    Math.abs(horizontalLocalRange[1] - horizontalLocalRange[0]),
    Math.abs(verticalLocalRange[1] - verticalLocalRange[0]),
  );
  const displayLengthUnit = resolveDisplayLengthUnit(largestVisibleSpan);
  const labels = resolveCartesianLabels(frame);
  const origin = finiteVector(frame.origin, [0, 0, 0]);
  const horizontalDirection = finiteVector(frame.uAxis, [1, 0, 0]);
  const verticalDirection = finiteVector(frame.vAxis, [0, 1, 0]);
  const normalDirection = finiteVector(frame.normal, [0, 0, 1]);
  const horizontalTransform = axisTransform(
    labels.horizontalWorldAxis,
    origin,
    horizontalDirection,
  );
  const verticalTransform = axisTransform(
    labels.verticalWorldAxis,
    origin,
    verticalDirection,
  );

  return {
    cut: {
      directionWorld: normalDirection,
      label: labels.cut,
    },
    displayLengthUnit,
    horizontal: buildAxis(
      "horizontal",
      labels.horizontal,
      horizontalDirection,
      horizontalLocalRange,
      plotWidthPx,
      displayLengthUnit,
      horizontalTransform,
    ),
    preset: labels.preset,
    vertical: buildAxis(
      "vertical",
      labels.vertical,
      verticalDirection,
      verticalLocalRange,
      plotHeightPx,
      displayLengthUnit,
      verticalTransform,
    ),
  };
}

function resolveCartesianLabels(frame: PlanarAxisFrame): AxisLabels {
  if (!hasConsistentRightHandedNormal(frame)) return obliqueLabels();
  if (isWorldAxis(frame.uAxis, 0) && isWorldAxis(frame.vAxis, 1)) {
    return {
      cut: "z",
      horizontal: "x",
      horizontalWorldAxis: 0,
      preset: "xy",
      vertical: "y",
      verticalWorldAxis: 1,
    };
  }
  if (isWorldAxis(frame.uAxis, 0) && isWorldAxis(frame.vAxis, 2)) {
    return {
      cut: "y",
      horizontal: "x",
      horizontalWorldAxis: 0,
      preset: "xz",
      vertical: "z",
      verticalWorldAxis: 2,
    };
  }
  if (isWorldAxis(frame.uAxis, 1) && isWorldAxis(frame.vAxis, 2)) {
    return {
      cut: "x",
      horizontal: "y",
      horizontalWorldAxis: 1,
      preset: "yz",
      vertical: "z",
      verticalWorldAxis: 2,
    };
  }
  return obliqueLabels();
}

function obliqueLabels(): AxisLabels {
  return {
    cut: "normal",
    horizontal: "x′",
    horizontalWorldAxis: null,
    preset: "oblique",
    vertical: "y′",
    verticalWorldAxis: null,
  };
}

function hasConsistentRightHandedNormal(frame: PlanarAxisFrame): boolean {
  const [ux, uy, uz] = frame.uAxis;
  const [vx, vy, vz] = frame.vAxis;
  const expected: PlanarAxisVector = [
    uy * vz - uz * vy,
    uz * vx - ux * vz,
    ux * vy - uy * vx,
  ];
  return frame.normal.every(
    (component, index) => Number.isFinite(component) &&
      Math.abs(component - expected[index]) <= CARTESIAN_TOLERANCE,
  );
}

function isWorldAxis(vector: PlanarAxisVector, axis: 0 | 1 | 2): boolean {
  return vector.every((component, index) => Number.isFinite(component) && (
    index === axis
      ? Math.abs(Math.abs(component) - 1) <= CARTESIAN_TOLERANCE
      : Math.abs(component) <= CARTESIAN_TOLERANCE
  ));
}

function finiteVector(
  vector: PlanarAxisVector,
  fallback: PlanarAxisVector,
): PlanarAxisVector {
  return vector.every(Number.isFinite) ? vector : fallback;
}

function safeRange(
  primaryStart: number,
  primaryEnd: number,
  fallbackStart: number,
  fallbackEnd: number,
): readonly [number, number] {
  if (Number.isFinite(primaryStart) && Number.isFinite(primaryEnd) && primaryStart !== primaryEnd) {
    return [primaryStart, primaryEnd];
  }
  if (
    Number.isFinite(fallbackStart) &&
    Number.isFinite(fallbackEnd) &&
    fallbackStart !== fallbackEnd
  ) {
    return [fallbackStart, fallbackEnd];
  }
  return [0, 1];
}

function axisTransform(
  worldAxis: 0 | 1 | 2 | null,
  origin: PlanarAxisVector,
  direction: PlanarAxisVector,
): AxisTransform {
  if (worldAxis === null) return { offset: 0, sign: 1 };
  return {
    offset: origin[worldAxis],
    sign: direction[worldAxis] < 0 ? -1 : 1,
  };
}

function resolveDisplayLengthUnit(spanMetres: number): PlanarDisplayLengthUnit {
  if (spanMetres < 1e-6) return { scale: 1e9, symbol: "nm" };
  if (spanMetres < 1e-3) return { scale: 1e6, symbol: "µm" };
  if (spanMetres < 1) return { scale: 1e3, symbol: "mm" };
  return { scale: 1, symbol: "m" };
}

function buildAxis(
  orientation: "horizontal" | "vertical",
  label: string,
  directionWorld: PlanarAxisVector,
  localRange: readonly [number, number],
  pixelExtent: number,
  displayLengthUnit: PlanarDisplayLengthUnit,
  transform: AxisTransform,
): ResolvedPlanarAxis {
  const span = Math.abs(localRange[1] - localRange[0]);
  const safePixelExtent = finitePixelExtent(pixelExtent);
  const targetTickCount = Math.max(
    2,
    Math.min(12, Math.floor(safePixelExtent / 80) + 1),
  );
  const stepMetres = niceStep(span / Math.max(1, targetTickCount - 1));
  const rangeMetres = [
    worldValue(localRange[0], transform),
    worldValue(localRange[1], transform),
  ] as const;
  const ticks = buildTicks(
    orientation,
    localRange,
    rangeMetres,
    stepMetres,
    safePixelExtent,
    displayLengthUnit,
    transform,
  );
  return { directionWorld, label, rangeMetres, stepMetres, ticks };
}

function finitePixelExtent(value: number): number {
  return Number.isFinite(value) && value > 0
    ? Math.min(value, 1_000_000)
    : 1;
}

function niceStep(rawStep: number): number {
  if (!(rawStep > 0) || !Number.isFinite(rawStep)) return 1;
  const exponent = Math.floor(Math.log10(rawStep));
  let best = 10 ** exponent;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (
    let candidateExponent = exponent - 1;
    candidateExponent <= exponent + 1;
    candidateExponent += 1
  ) {
    for (const mantissa of NICE_MANTISSAS) {
      const candidate = mantissa * 10 ** candidateExponent;
      const distance = Math.abs(Math.log(candidate / rawStep));
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
  }
  return best;
}

function buildTicks(
  orientation: "horizontal" | "vertical",
  localRange: readonly [number, number],
  displayRange: readonly [number, number],
  step: number,
  pixelExtent: number,
  unit: PlanarDisplayLengthUnit,
  transform: AxisTransform,
): PlanarAxisTick[] {
  const candidates: PlanarAxisTick[] = [];
  addTick(candidates, localRange[0], localRange, pixelExtent, unit, transform, true);
  addTick(candidates, localRange[1], localRange, pixelExtent, unit, transform, true);

  const displayMin = Math.min(displayRange[0], displayRange[1]);
  const displayMax = Math.max(displayRange[0], displayRange[1]);
  if (displayMin < 0 && displayMax > 0) {
    addTick(
      candidates,
      localValue(0, transform),
      localRange,
      pixelExtent,
      unit,
      transform,
      false,
    );
  }

  const first = Math.ceil(displayMin / step);
  const last = Math.floor(displayMax / step);
  for (
    let offset = 0;
    offset < MAX_TICK_CANDIDATES && first + offset <= last;
    offset += 1
  ) {
    const displayValue = first + offset === 0
      ? 0
      : Number(((first + offset) * step).toPrecision(14));
    addTick(
      candidates,
      localValue(displayValue, transform),
      localRange,
      pixelExtent,
      unit,
      transform,
      false,
    );
  }

  candidates.sort((left, right) => left.positionPx - right.positionPx);
  return filterCollidingTicks(candidates, orientation);
}

function addTick(
  ticks: PlanarAxisTick[],
  localTickValue: number,
  localRange: readonly [number, number],
  pixelExtent: number,
  unit: PlanarDisplayLengthUnit,
  transform: AxisTransform,
  endpoint: boolean,
): void {
  if (!Number.isFinite(localTickValue)) return;
  const value = worldValue(localTickValue, transform);
  if (!Number.isFinite(value)) return;
  const positionPx = (
    (localTickValue - localRange[0]) /
    (localRange[1] - localRange[0])
  ) * pixelExtent;
  if (!Number.isFinite(positionPx)) return;
  const displaySpan = Math.abs(
    worldValue(localRange[1], transform) - worldValue(localRange[0], transform),
  );
  const tolerance = Number.EPSILON * Math.max(
    Math.abs(value),
    displaySpan,
    Number.MIN_VALUE,
  ) * 8;
  const existing = ticks.find((tick) => Math.abs(tick.value - value) <= tolerance);
  if (existing) {
    existing.endpoint ||= endpoint;
    existing.zero ||= value === 0;
    return;
  }
  ticks.push({
    endpoint,
    label: formatDisplayValue(value * unit.scale),
    positionPx,
    value,
    zero: value === 0,
  });
}

function worldValue(local: number, transform: AxisTransform): number {
  return transform.offset + local * transform.sign;
}

function localValue(world: number, transform: AxisTransform): number {
  return (world - transform.offset) / transform.sign;
}

function formatDisplayValue(value: number): string {
  if (value === 0) return "0";
  const magnitude = Math.abs(value);
  if (magnitude >= 1e6 || magnitude < 1e-4) {
    return value.toExponential(5)
      .replace(/\.0+(?=e)/, "")
      .replace(/(\.\d*?)0+(?=e)/, "$1");
  }
  return String(Number(value.toPrecision(6)));
}

function filterCollidingTicks(
  ticks: readonly PlanarAxisTick[],
  orientation: "horizontal" | "vertical",
): PlanarAxisTick[] {
  const kept = ticks.filter((tick) => tick.endpoint || tick.zero);
  for (const tick of ticks) {
    if (tick.endpoint || tick.zero) continue;
    if (kept.every((candidate) => !labelsOverlap(tick, candidate, orientation))) {
      kept.push(tick);
    }
  }
  return kept.sort((left, right) => left.positionPx - right.positionPx);
}

function labelsOverlap(
  left: PlanarAxisTick,
  right: PlanarAxisTick,
  orientation: "horizontal" | "vertical",
): boolean {
  const leftHalfExtent = orientation === "horizontal"
    ? Math.max(7, left.label.length * 3.5 + 3)
    : 8;
  const rightHalfExtent = orientation === "horizontal"
    ? Math.max(7, right.label.length * 3.5 + 3)
    : 8;
  return Math.abs(left.positionPx - right.positionPx) < leftHalfExtent + rightHalfExtent;
}
