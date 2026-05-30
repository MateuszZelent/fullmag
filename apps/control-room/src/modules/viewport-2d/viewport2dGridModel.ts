export interface Viewport2DGridBounds {
  uMax: number;
  uMin: number;
  vMax: number;
  vMin: number;
}

export interface Viewport2DGridTick {
  label: string;
  role: "axis" | "grid";
  value: number;
}

export interface Viewport2DGridModel {
  colors: Float32Array;
  lineCount: number;
  positions: Float32Array;
  uTicks: Viewport2DGridTick[];
  vTicks: Viewport2DGridTick[];
}

export interface Viewport2DGridOptions {
  axisColor?: readonly [number, number, number];
  gridColor?: readonly [number, number, number];
  targetTickCount?: number;
}

const GRID_Z = -0.02;
const DEFAULT_TARGET_TICK_COUNT = 6;
const MAX_TICK_COUNT = 200;

export function buildViewport2DGridModel(
  bounds: Viewport2DGridBounds,
  options: Viewport2DGridOptions = {},
): Viewport2DGridModel {
  const normalized = normalizeBounds(bounds);
  const targetTickCount = clampInteger(
    options.targetTickCount ?? DEFAULT_TARGET_TICK_COUNT,
    2,
    24,
  );
  const gridColor = options.gridColor ?? [0.32, 0.36, 0.42];
  const axisColor = options.axisColor ?? [0.72, 0.78, 0.86];
  const uTicks = buildTicks(normalized.uMin, normalized.uMax, targetTickCount);
  const vTicks = buildTicks(normalized.vMin, normalized.vMax, targetTickCount);
  const lineCount = uTicks.length + vTicks.length;
  const positions = new Float32Array(lineCount * 6);
  const colors = new Float32Array(lineCount * 6);
  let line = 0;

  for (const tick of uTicks) {
    writeLine(
      positions,
      colors,
      line,
      tick.value,
      normalized.vMin,
      tick.value,
      normalized.vMax,
      tick.role,
      gridColor,
      axisColor,
    );
    line++;
  }
  for (const tick of vTicks) {
    writeLine(
      positions,
      colors,
      line,
      normalized.uMin,
      tick.value,
      normalized.uMax,
      tick.value,
      tick.role,
      gridColor,
      axisColor,
    );
    line++;
  }

  return { colors, lineCount, positions, uTicks, vTicks };
}

function buildTicks(
  min: number,
  max: number,
  targetTickCount: number,
): Viewport2DGridTick[] {
  const span = max - min;
  const step = niceStep(span / Math.max(1, targetTickCount));
  const first = Math.ceil(min / step);
  const last = Math.floor(max / step);
  const ticks: Viewport2DGridTick[] = [];

  for (
    let index = first;
    index <= last && ticks.length < MAX_TICK_COUNT;
    index++
  ) {
    const value = normalizeZero(index * step, step);
    ticks.push({
      label: formatTickValue(value),
      role: value === 0 ? "axis" : "grid",
      value,
    });
  }

  return ticks;
}

function writeLine(
  positions: Float32Array,
  colors: Float32Array,
  line: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  role: Viewport2DGridTick["role"],
  gridColor: readonly [number, number, number],
  axisColor: readonly [number, number, number],
): void {
  const positionOffset = line * 6;
  positions[positionOffset] = x1;
  positions[positionOffset + 1] = y1;
  positions[positionOffset + 2] = GRID_Z;
  positions[positionOffset + 3] = x2;
  positions[positionOffset + 4] = y2;
  positions[positionOffset + 5] = GRID_Z;

  const color = role === "axis" ? axisColor : gridColor;
  for (let vertex = 0; vertex < 2; vertex++) {
    const colorOffset = positionOffset + vertex * 3;
    colors[colorOffset] = color[0];
    colors[colorOffset + 1] = color[1];
    colors[colorOffset + 2] = color[2];
  }
}

function niceStep(rawStep: number): number {
  if (!Number.isFinite(rawStep) || rawStep <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / power;
  if (normalized <= 1) return power;
  if (normalized <= 2) return 2 * power;
  if (normalized <= 5) return 5 * power;
  return 10 * power;
}

function normalizeBounds(bounds: Viewport2DGridBounds): Viewport2DGridBounds {
  const u = normalizeAxis(bounds.uMin, bounds.uMax);
  const v = normalizeAxis(bounds.vMin, bounds.vMax);
  return {
    uMax: u.max,
    uMin: u.min,
    vMax: v.max,
    vMin: v.min,
  };
}

function normalizeAxis(first: number, second: number): { max: number; min: number } {
  if (!Number.isFinite(first) || !Number.isFinite(second)) {
    return { max: 0.5, min: -0.5 };
  }

  const min = Math.min(first, second);
  const max = Math.max(first, second);
  if (Math.abs(max - min) > Number.EPSILON) {
    return { max, min };
  }

  return { max: max + 0.5, min: min - 0.5 };
}

function normalizeZero(value: number, step: number): number {
  return Math.abs(value) <= step * 1e-9 ? 0 : Number(value.toPrecision(12));
}

function formatTickValue(value: number): string {
  if (value === 0) return "0";
  const magnitude = Math.abs(value);
  if (magnitude >= 1_000 || magnitude < 0.001) {
    return value.toExponential(2);
  }
  return Number(value.toPrecision(4)).toString();
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}
