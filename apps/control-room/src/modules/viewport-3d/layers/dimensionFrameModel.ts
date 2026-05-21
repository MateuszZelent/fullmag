import type { Viewport3DBounds } from "../viewport3dRenderModel";
import type {
  Viewport3DCameraProjection,
  Viewport3DCameraState,
} from "../viewport3dStore";

export type DimensionFrameMode = "off" | "floor" | "cage";
export type DimensionFrameDensity = "auto" | "coarse" | "fine";
export type DimensionFrameUnitMode = "auto" | "nm" | "um" | "mm" | "m";
export type DimensionFrameAxis = "x" | "y" | "z";
export type DimensionFramePlaneId =
  | "xy-min"
  | "x-min"
  | "x-max"
  | "y-min"
  | "y-max";

export interface DimensionFrameOptions {
  bounds: Viewport3DBounds | null;
  cameraProjection: Viewport3DCameraProjection;
  cameraState: Viewport3DCameraState;
  density: DimensionFrameDensity;
  labelsVisible: boolean;
  mode: DimensionFrameMode;
  unitMode: DimensionFrameUnitMode;
}

export interface DimensionFramePlane {
  fixedAxis: DimensionFrameAxis;
  fixedValue: number;
  id: DimensionFramePlaneId;
  uAxis: DimensionFrameAxis;
  vAxis: DimensionFrameAxis;
}

export interface DimensionFrameUnit {
  factor: number;
  id: Exclude<DimensionFrameUnitMode, "auto">;
  label: string;
}

export interface DimensionFrameLabel {
  colorRole: "axis" | "tick" | "unit";
  key: string;
  position: [number, number, number];
  text: string;
}

export interface DimensionFrameModel {
  axisLabels: DimensionFrameLabel[];
  labelScaleWorld: number;
  majorLines: Float32Array;
  minorLines: Float32Array;
  mode: DimensionFrameMode;
  planes: DimensionFramePlane[];
  signature: string;
  tickLabels: DimensionFrameLabel[];
  unit: DimensionFrameUnit;
}

interface ResolvedBounds {
  center: [number, number, number];
  max: [number, number, number];
  min: [number, number, number];
  size: [number, number, number];
}

const AXIS_INDEX: Record<DimensionFrameAxis, 0 | 1 | 2> = {
  x: 0,
  y: 1,
  z: 2,
};
const EMPTY_LINES = new Float32Array();
const FALLBACK_SIZE = 1e-6;
const LABEL_CAP = 36;
const MAJOR_SEGMENT_CAP = 96;
const MINOR_SEGMENT_CAP = 240;
const MINOR_SUBDIVISIONS: Record<DimensionFrameDensity, number> = {
  auto: 4,
  coarse: 4,
  fine: 5,
};
const TARGET_INTERVALS: Record<DimensionFrameDensity, number> = {
  auto: 6,
  coarse: 4,
  fine: 10,
};

export function resolveDimensionFrameUnit(
  maxSpanMeters: number,
  unitMode: DimensionFrameUnitMode,
): DimensionFrameUnit {
  if (unitMode !== "auto") {
    return unitForId(unitMode);
  }
  if (maxSpanMeters < 2e-6) return unitForId("nm");
  if (maxSpanMeters < 2e-3) return unitForId("um");
  if (maxSpanMeters < 2) return unitForId("mm");
  return unitForId("m");
}

export function formatDimensionFrameTickValue(
  valueMeters: number,
  unit: DimensionFrameUnit,
): string {
  if (!Number.isFinite(valueMeters) || Math.abs(valueMeters) < 1e-18) {
    return "0";
  }
  const scaled = valueMeters * unit.factor;
  const rounded = Number(scaled.toPrecision(4));
  return rounded.toString();
}

export function resolveDimensionFrameStep(
  spanMeters: number,
  density: DimensionFrameDensity,
): number {
  const target = TARGET_INTERVALS[density];
  return niceStep(Math.max(spanMeters, 1e-18) / target);
}

export function buildDimensionFrameModel({
  bounds,
  cameraProjection,
  cameraState,
  density,
  labelsVisible,
  mode,
  unitMode,
}: DimensionFrameOptions): DimensionFrameModel {
  const resolvedBounds = resolveBounds(bounds);
  const maxSpan = Math.max(...resolvedBounds.size, 1e-18);
  const unit = resolveDimensionFrameUnit(maxSpan, unitMode);
  if (mode === "off") {
    return emptyDimensionFrameModel(mode, unit);
  }

  const step = resolveDimensionFrameStep(maxSpan, density);
  const planes = resolveDimensionFramePlanes(mode, resolvedBounds, cameraState);
  const minorStep = step / MINOR_SUBDIVISIONS[density];
  const majorLines: number[] = [];
  const minorLines: number[] = [];

  for (const plane of planes) {
    appendPlaneLines({
      bounds: resolvedBounds,
      lineBuffer: minorLines,
      maxSegments: MINOR_SEGMENT_CAP,
      plane,
      skipStep: step,
      step: minorStep,
    });
    appendPlaneLines({
      bounds: resolvedBounds,
      lineBuffer: majorLines,
      maxSegments: MAJOR_SEGMENT_CAP,
      plane,
      step,
    });
  }

  const labelScaleWorld =
    maxSpan * (cameraProjection === "orthographic" ? 0.034 : 0.042);
  const tickLabels = labelsVisible
    ? buildTickLabels(resolvedBounds, step, unit, mode)
    : [];
  const axisLabels = labelsVisible
    ? buildAxisLabels(resolvedBounds, unit, labelScaleWorld, mode)
    : [];

  return {
    axisLabels,
    labelScaleWorld: Math.max(labelScaleWorld, 1e-12),
    majorLines: new Float32Array(majorLines),
    minorLines: new Float32Array(minorLines),
    mode,
    planes,
    signature: [
      mode,
      density,
      unit.id,
      labelsVisible ? "labels" : "nolabels",
      step,
      ...resolvedBounds.center,
      ...resolvedBounds.size,
      ...planes.map((plane) => plane.id),
    ].join(":"),
    tickLabels,
    unit,
  };
}

function resolveDimensionFramePlanes(
  mode: Exclude<DimensionFrameMode, "off">,
  bounds: ResolvedBounds,
  cameraState: Viewport3DCameraState,
): DimensionFramePlane[] {
  const floor: DimensionFramePlane = {
    fixedAxis: "z",
    fixedValue: bounds.min[2],
    id: "xy-min",
    uAxis: "x",
    vAxis: "y",
  };
  if (mode === "floor") return [floor];

  const xWall: DimensionFramePlane =
    cameraState.position[0] >= cameraState.target[0]
      ? {
          fixedAxis: "x",
          fixedValue: bounds.min[0],
          id: "x-min",
          uAxis: "y",
          vAxis: "z",
        }
      : {
          fixedAxis: "x",
          fixedValue: bounds.max[0],
          id: "x-max",
          uAxis: "y",
          vAxis: "z",
        };
  const yWall: DimensionFramePlane =
    cameraState.position[1] >= cameraState.target[1]
      ? {
          fixedAxis: "y",
          fixedValue: bounds.min[1],
          id: "y-min",
          uAxis: "x",
          vAxis: "z",
        }
      : {
          fixedAxis: "y",
          fixedValue: bounds.max[1],
          id: "y-max",
          uAxis: "x",
          vAxis: "z",
        };

  return [floor, xWall, yWall];
}

function appendPlaneLines({
  bounds,
  lineBuffer,
  maxSegments,
  plane,
  skipStep,
  step,
}: {
  bounds: ResolvedBounds;
  lineBuffer: number[];
  maxSegments: number;
  plane: DimensionFramePlane;
  skipStep?: number;
  step: number;
}) {
  const uIndex = AXIS_INDEX[plane.uAxis];
  const vIndex = AXIS_INDEX[plane.vAxis];
  const fixedIndex = AXIS_INDEX[plane.fixedAxis];
  for (const value of centeredTicksBetween({
    max: bounds.max[uIndex],
    min: bounds.min[uIndex],
    origin: bounds.center[uIndex],
    step,
  })) {
    if (skipStep && isOnMajorStep(value - bounds.center[uIndex], skipStep)) continue;
    if (lineBuffer.length / 6 >= maxSegments) return;
    pushSegment(
      lineBuffer,
      pointOnPlane(plane, fixedIndex, plane.fixedValue, uIndex, value, vIndex, bounds.min[vIndex]),
      pointOnPlane(plane, fixedIndex, plane.fixedValue, uIndex, value, vIndex, bounds.max[vIndex]),
    );
  }
  for (const value of centeredTicksBetween({
    max: bounds.max[vIndex],
    min: bounds.min[vIndex],
    origin: bounds.center[vIndex],
    step,
  })) {
    if (skipStep && isOnMajorStep(value - bounds.center[vIndex], skipStep)) continue;
    if (lineBuffer.length / 6 >= maxSegments) return;
    pushSegment(
      lineBuffer,
      pointOnPlane(plane, fixedIndex, plane.fixedValue, vIndex, value, uIndex, bounds.min[uIndex]),
      pointOnPlane(plane, fixedIndex, plane.fixedValue, vIndex, value, uIndex, bounds.max[uIndex]),
    );
  }
}

function buildTickLabels(
  bounds: ResolvedBounds,
  step: number,
  unit: DimensionFrameUnit,
  mode: DimensionFrameMode,
): DimensionFrameLabel[] {
  const labels: DimensionFrameLabel[] = [];
  const offset = Math.max(Math.max(...bounds.size) * 0.055, 1e-12);
  for (const x of centeredTicksBetween({
    max: bounds.max[0],
    min: bounds.min[0],
    origin: bounds.center[0],
    step,
  })) {
    labels.push({
      colorRole: "tick",
      key: `tick:x:${x}`,
      position: [x, bounds.min[1] - offset, bounds.min[2]],
      text: formatDimensionFrameTickValue(x - bounds.center[0], unit),
    });
    if (labels.length >= LABEL_CAP) return labels;
  }
  for (const y of centeredTicksBetween({
    max: bounds.max[1],
    min: bounds.min[1],
    origin: bounds.center[1],
    step,
  })) {
    labels.push({
      colorRole: "tick",
      key: `tick:y:${y}`,
      position: [bounds.min[0] - offset, y, bounds.min[2]],
      text: formatDimensionFrameTickValue(y - bounds.center[1], unit),
    });
    if (labels.length >= LABEL_CAP) return labels;
  }
  if (mode === "cage") {
    for (const z of centeredTicksBetween({
      max: bounds.max[2],
      min: bounds.min[2],
      origin: bounds.center[2],
      step,
    })) {
      labels.push({
        colorRole: "tick",
        key: `tick:z:${z}`,
        position: [bounds.min[0] - offset, bounds.min[1] - offset, z],
        text: formatDimensionFrameTickValue(z - bounds.center[2], unit),
      });
      if (labels.length >= LABEL_CAP) return labels;
    }
  }
  return labels;
}

function buildAxisLabels(
  bounds: ResolvedBounds,
  unit: DimensionFrameUnit,
  labelScaleWorld: number,
  mode: DimensionFrameMode,
): DimensionFrameLabel[] {
  const offset = Math.max(labelScaleWorld * 2.2, Math.max(...bounds.size) * 0.07);
  const labels: DimensionFrameLabel[] = [
    {
      colorRole: "axis",
      key: "axis:x",
      position: [bounds.max[0] + offset, bounds.min[1] - offset, bounds.min[2]],
      text: "x",
    },
    {
      colorRole: "axis",
      key: "axis:y",
      position: [bounds.min[0] - offset, bounds.max[1] + offset, bounds.min[2]],
      text: "y",
    },
    {
      colorRole: "unit",
      key: `unit:${unit.id}`,
      position: [bounds.center[0], bounds.min[1] - offset * 2, bounds.min[2]],
      text: unit.label,
    },
  ];
  if (mode === "cage") {
    labels.push({
      colorRole: "axis",
      key: "axis:z",
      position: [bounds.min[0] - offset, bounds.min[1] - offset, bounds.max[2] + offset],
      text: "z",
    });
  }
  return labels;
}

function emptyDimensionFrameModel(
  mode: DimensionFrameMode,
  unit: DimensionFrameUnit,
): DimensionFrameModel {
  return {
    axisLabels: [],
    labelScaleWorld: 1e-9,
    majorLines: EMPTY_LINES,
    minorLines: EMPTY_LINES,
    mode,
    planes: [],
    signature: `${mode}:${unit.id}`,
    tickLabels: [],
    unit,
  };
}

function resolveBounds(bounds: Viewport3DBounds | null): ResolvedBounds {
  const center = bounds?.center ?? [0, 0, 0];
  const size = bounds?.size ?? [FALLBACK_SIZE, FALLBACK_SIZE, FALLBACK_SIZE];
  const halfSize = size.map((value) => Math.max(value, 1e-18) / 2) as [
    number,
    number,
    number,
  ];
  return {
    center,
    max: [
      center[0] + halfSize[0],
      center[1] + halfSize[1],
      center[2] + halfSize[2],
    ],
    min: [
      center[0] - halfSize[0],
      center[1] - halfSize[1],
      center[2] - halfSize[2],
    ],
    size: [halfSize[0] * 2, halfSize[1] * 2, halfSize[2] * 2],
  };
}

function niceStep(value: number): number {
  const exponent = Math.floor(Math.log10(Math.max(value, 1e-18)));
  const base = 10 ** exponent;
  const normalized = value / base;
  if (normalized <= 1) return base;
  if (normalized <= 2) return 2 * base;
  if (normalized <= 5) return 5 * base;
  return 10 * base;
}

function ticksBetween(min: number, max: number, step: number): number[] {
  if (!Number.isFinite(step) || step <= 0) return [];
  const ticks: number[] = [];
  const epsilon = step * 1e-6;
  const start = Math.ceil((min - epsilon) / step) * step;
  for (let value = start; value <= max + epsilon; value += step) {
    ticks.push(Number(value.toPrecision(12)));
  }
  return ticks;
}

function centeredTicksBetween({
  max,
  min,
  origin,
  step,
}: {
  max: number;
  min: number;
  origin: number;
  step: number;
}): number[] {
  if (!Number.isFinite(step) || step <= 0) return [];
  const relativeTicks = ticksBetween(min - origin, max - origin, step);
  return relativeTicks.map((value) => Number((origin + value).toPrecision(12)));
}

function isOnMajorStep(value: number, majorStep: number): boolean {
  const nearest = Math.round(value / majorStep) * majorStep;
  return Math.abs(value - nearest) <= Math.max(Math.abs(majorStep) * 1e-6, 1e-18);
}

function pointOnPlane(
  plane: DimensionFramePlane,
  fixedIndex: 0 | 1 | 2,
  fixedValue: number,
  firstIndex: 0 | 1 | 2,
  firstValue: number,
  secondIndex: 0 | 1 | 2,
  secondValue: number,
): [number, number, number] {
  const point: [number, number, number] = [0, 0, 0];
  point[fixedIndex] = fixedValue;
  point[firstIndex] = firstValue;
  point[secondIndex] = secondValue;
  const remainingIndex = remainingAxisIndex(fixedIndex, firstIndex, secondIndex);
  if (remainingIndex !== null) {
    point[remainingIndex] =
      plane.fixedAxis === "x" || plane.fixedAxis === "y" || plane.fixedAxis === "z"
        ? fixedValue
        : 0;
  }
  return point;
}

function remainingAxisIndex(
  a: 0 | 1 | 2,
  b: 0 | 1 | 2,
  c: 0 | 1 | 2,
): 0 | 1 | 2 | null {
  for (const index of [0, 1, 2] as const) {
    if (index !== a && index !== b && index !== c) return index;
  }
  return null;
}

function pushSegment(
  buffer: number[],
  start: [number, number, number],
  end: [number, number, number],
): void {
  buffer.push(...start, ...end);
}

function unitForId(id: Exclude<DimensionFrameUnitMode, "auto">): DimensionFrameUnit {
  if (id === "nm") return { factor: 1e9, id, label: "nm" };
  if (id === "um") return { factor: 1e6, id, label: "um" };
  if (id === "mm") return { factor: 1e3, id, label: "mm" };
  return { factor: 1, id: "m", label: "m" };
}
