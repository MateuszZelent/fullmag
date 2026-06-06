export type RegionOverlayTheme = "latte" | "mocha";
export type RegionOverlayShapeKind = "box" | "cylinder" | "sphere";

type NumericVector3 = readonly [number, number, number];
type NumericQuaternion = readonly [number, number, number, number];

interface JsonRecord {
  [key: string]: unknown;
}

export interface RegionOverlayInput {
  enabled?: boolean | null;
  frame?: string | null;
  name?: string | null;
  owner_object_id?: string | null;
  owner_transform?: unknown;
  owner_translation?: unknown;
  priority?: number | null;
  region_id?: string | null;
  shape?: unknown;
}

export interface RegionOverlayOptions {
  selectedObjectId?: string | null;
  selectedRegionId?: string | null;
  theme?: RegionOverlayTheme;
}

export interface RegionOverlayStyle {
  fillOpacity: number;
  wireframeOpacity: number;
  wireframeScale: number;
}

export interface RegionOverlayTransform {
  position: NumericVector3;
  quaternion: NumericQuaternion;
  scale: NumericVector3;
}

interface RegionOverlayBaseModel {
  color: string;
  enabled: boolean;
  label: string;
  objectId: string;
  priority: number | null;
  regionId: string;
  selected: boolean;
  slot: number;
  style: RegionOverlayStyle;
  transform: RegionOverlayTransform;
}

export interface RegionOverlayBoxModel extends RegionOverlayBaseModel {
  center: NumericVector3;
  kind: "box";
  size: NumericVector3;
}

export interface RegionOverlayCylinderModel extends RegionOverlayBaseModel {
  axis: NumericVector3;
  center: NumericVector3;
  height: number;
  kind: "cylinder";
  radius: number;
}

export interface RegionOverlaySphereModel extends RegionOverlayBaseModel {
  center: NumericVector3;
  kind: "sphere";
  radius: number;
}

export type RegionOverlayModel =
  | RegionOverlayBoxModel
  | RegionOverlayCylinderModel
  | RegionOverlaySphereModel;

const REGION_COLORS = {
  latte: [
    "var(--fm-region-overlay-0)",
    "var(--fm-region-overlay-1)",
    "var(--fm-region-overlay-2)",
    "var(--fm-region-overlay-3)",
    "var(--fm-region-overlay-4)",
    "var(--fm-region-overlay-5)",
    "var(--fm-region-overlay-6)",
    "var(--fm-region-overlay-7)",
  ],
  mocha: [
    "var(--fm-region-overlay-0)",
    "var(--fm-region-overlay-1)",
    "var(--fm-region-overlay-2)",
    "var(--fm-region-overlay-3)",
    "var(--fm-region-overlay-4)",
    "var(--fm-region-overlay-5)",
    "var(--fm-region-overlay-6)",
    "var(--fm-region-overlay-7)",
  ],
} satisfies Record<RegionOverlayTheme, readonly string[]>;

const DEFAULT_CENTER: NumericVector3 = [0, 0, 0];
const DEFAULT_AXIS: NumericVector3 = [0, 0, 1];
const DEFAULT_QUATERNION: NumericQuaternion = [0, 0, 0, 1];
const DEFAULT_SCALE: NumericVector3 = [1, 1, 1];

export function resolveRegionOverlayColor(
  slot: number,
  theme: RegionOverlayTheme = "mocha",
): string {
  const palette = REGION_COLORS[theme];
  return palette[positiveModulo(slot, palette.length)];
}

export function resolveRegionOverlayStyle({
  enabled,
  selected,
}: {
  enabled: boolean;
  selected: boolean;
}): RegionOverlayStyle {
  return {
    fillOpacity: enabled ? (selected ? 0.25 : 0.14) : 0.08,
    wireframeOpacity: enabled ? (selected ? 1 : 0.72) : 0.38,
    wireframeScale: selected ? 1.008 : 1.004,
  };
}

export function buildRegionOverlayModels(
  regions: readonly RegionOverlayInput[],
  options: RegionOverlayOptions = {},
): RegionOverlayModel[] {
  return [...regions]
    .filter((region) => {
      const selectedObjectId = nonEmptyString(options.selectedObjectId);
      if (!selectedObjectId) return true;
      return nonEmptyString(region.owner_object_id) === selectedObjectId;
    })
    .sort(compareRegionOverlayInputs)
    .flatMap((region, index) =>
      normalizeRegionOverlayModel(region, index, options),
    );
}

function compareRegionOverlayInputs(
  left: RegionOverlayInput,
  right: RegionOverlayInput,
): number {
  const priorityDiff = priorityValue(right.priority) - priorityValue(left.priority);
  if (priorityDiff !== 0) return priorityDiff;
  return String(left.region_id ?? left.name ?? "").localeCompare(
    String(right.region_id ?? right.name ?? ""),
  );
}

function normalizeRegionOverlayModel(
  region: RegionOverlayInput,
  slot: number,
  options: RegionOverlayOptions,
): RegionOverlayModel[] {
  const shape = asRecord(region.shape);
  const regionId = nonEmptyString(region.region_id);
  const objectId = nonEmptyString(region.owner_object_id);
  if (!shape || !regionId || !objectId) return [];

  const enabled = region.enabled !== false;
  const selected = options.selectedRegionId === regionId;
  const frame = nonEmptyString(region.frame)?.toLowerCase() ?? "object";
  const transform =
    frame === "world" ? defaultRegionTransform() : ownerTransform(region);
  const base = {
    color: resolveRegionOverlayColor(slot, options.theme ?? "mocha"),
    enabled,
    label: nonEmptyString(region.name) ?? regionId,
    objectId,
    priority: finiteNumber(region.priority),
    regionId,
    selected,
    slot,
    style: resolveRegionOverlayStyle({ enabled, selected }),
    transform,
  };

  const kind = nonEmptyString(shape.kind ?? shape.type)?.toLowerCase();
  const localCenter = vector3(shape.center) ?? DEFAULT_CENTER;
  const center = localCenter;

  if (kind === "box") {
    const size = vector3(shape.size);
    return size && positiveVector3(size)
      ? [{ ...base, center, kind, size }]
      : [];
  }

  if (kind === "cylinder") {
    const radius = positiveNumber(shape.radius);
    const height = positiveNumber(shape.height);
    const axis = vector3(shape.axis) ?? DEFAULT_AXIS;
    return radius !== null && height !== null && nonZeroVector3(axis)
      ? [{ ...base, axis, center, height, kind, radius }]
      : [];
  }

  if (kind === "sphere") {
    const radius = positiveNumber(shape.radius);
    return radius !== null ? [{ ...base, center, kind, radius }] : [];
  }

  return [];
}

function asRecord(value: unknown): JsonRecord | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveNumber(value: unknown): number | null {
  const numberValue = finiteNumber(value);
  return numberValue !== null && numberValue > 0 ? numberValue : null;
}

function vector3(value: unknown): NumericVector3 | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const values = value.map(finiteNumber);
  return values.every((entry): entry is number => entry !== null)
    ? ([values[0], values[1], values[2]] as NumericVector3)
    : null;
}

function quaternion(value: unknown): NumericQuaternion | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const values = value.map(finiteNumber);
  return values.every((entry): entry is number => entry !== null)
    ? ([values[0], values[1], values[2], values[3]] as NumericQuaternion)
    : null;
}

function positiveVector3(value: NumericVector3): boolean {
  return value.every((entry) => entry > 0);
}

function nonZeroVector3(value: NumericVector3): boolean {
  return value.some((entry) => Math.abs(entry) > 0);
}

function priorityValue(value: unknown): number {
  return finiteNumber(value) ?? Number.POSITIVE_INFINITY;
}

function positiveModulo(value: number, divisor: number): number {
  return ((Math.trunc(value) % divisor) + divisor) % divisor;
}

function defaultRegionTransform(): RegionOverlayTransform {
  return {
    position: DEFAULT_CENTER,
    quaternion: DEFAULT_QUATERNION,
    scale: DEFAULT_SCALE,
  };
}

function ownerTransform(region: RegionOverlayInput): RegionOverlayTransform {
  const transform = asRecord(region.owner_transform);
  return {
    position:
      vector3(transform?.translation) ??
      vector3(region.owner_translation) ??
      DEFAULT_CENTER,
    quaternion: quaternion(transform?.rotation_quat) ?? DEFAULT_QUATERNION,
    scale: vector3(transform?.scale) ?? DEFAULT_SCALE,
  };
}
