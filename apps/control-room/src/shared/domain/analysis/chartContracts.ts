import {
  chartUnitsCompatible,
  resolveChartUnit,
  type ChartDimension,
} from "./chartUnits";

export type ChartDescriptorKind =
  | "convergence"
  | "dispersion"
  | "energy"
  | "frequency_response"
  | "history"
  | "spectrum";

export type ChartDescriptorStatus =
  | "degraded"
  | "empty"
  | "error"
  | "idle"
  | "loading"
  | "ready"
  | "stale"
  | "unsupported";

export type ChartScientificTrust =
  | "canonical"
  | "degraded"
  | "derived"
  | "unverified";

export interface ChartSourceIdentity {
  artifactId?: string;
  resourceKey: string;
  resourceRevision: number;
  runId?: string;
  stageId?: string;
}

export interface ChartAxisDescriptor {
  canonicalUnit: string;
  dimension: ChartDimension;
  displayUnit: string;
  id: string;
  label: string;
}

export interface ChartSeriesDescriptor {
  axisId: string;
  canonicalUnit: string;
  id: string;
  label: string;
  quantity: string;
}

export interface ChartDescriptor {
  axes: ChartAxisDescriptor[];
  id: string;
  kind: ChartDescriptorKind;
  series: ChartSeriesDescriptor[];
  source: ChartSourceIdentity;
  status: ChartDescriptorStatus;
  title: string;
  trust: ChartScientificTrust;
}

const FORBIDDEN_PAYLOAD_FIELDS = [
  "data",
  "dataset",
  "option",
  "points",
  "rows",
  "samples",
  "typedArray",
] as const;

const DESCRIPTOR_KINDS = new Set<ChartDescriptorKind>([
  "convergence",
  "dispersion",
  "energy",
  "frequency_response",
  "history",
  "spectrum",
]);
const DESCRIPTOR_STATUSES = new Set<ChartDescriptorStatus>([
  "degraded",
  "empty",
  "error",
  "idle",
  "loading",
  "ready",
  "stale",
  "unsupported",
]);
const TRUST_VALUES = new Set<ChartScientificTrust>([
  "canonical",
  "degraded",
  "derived",
  "unverified",
]);

export function assertChartDescriptor(value: unknown): ChartDescriptor {
  const descriptor = record(value, "descriptor");
  for (const field of FORBIDDEN_PAYLOAD_FIELDS) {
    if (field in descriptor) {
      throw new TypeError(
        `ChartDescriptor must not contain payload or renderer field ${field}.`,
      );
    }
  }
  requiredString(descriptor.id, "id");
  requiredString(descriptor.title, "title");
  if (!DESCRIPTOR_KINDS.has(descriptor.kind as ChartDescriptorKind)) {
    throw invalid("kind");
  }
  if (!DESCRIPTOR_STATUSES.has(descriptor.status as ChartDescriptorStatus)) {
    throw invalid("status");
  }
  if (!TRUST_VALUES.has(descriptor.trust as ChartScientificTrust)) {
    throw invalid("trust");
  }

  const source = record(descriptor.source, "source");
  requiredString(source.resourceKey, "source.resourceKey");
  requiredRevision(source.resourceRevision, "source.resourceRevision");

  if (!Array.isArray(descriptor.axes) || descriptor.axes.length === 0) {
    throw invalid("axes");
  }
  const axes = descriptor.axes.map((value, index) =>
    assertAxis(value, `axes[${index}]`),
  );
  const axisById = new Map<string, ChartAxisDescriptor>();
  for (const axis of axes) {
    if (axisById.has(axis.id)) {
      throw new TypeError(`ChartDescriptor has duplicate axis ${axis.id}.`);
    }
    axisById.set(axis.id, axis);
  }

  if (!Array.isArray(descriptor.series)) throw invalid("series");
  const series = descriptor.series.map((value, index) => {
    const item = assertSeries(value, `series[${index}]`);
    const axis = axisById.get(item.axisId);
    if (!axis) throw invalid(`series[${index}].axisId`);
    if (!chartUnitsCompatible(item.canonicalUnit, axis.canonicalUnit)) {
      throw invalid(`series[${index}].canonicalUnit`);
    }
    return item;
  });

  return {
    axes,
    id: descriptor.id as string,
    kind: descriptor.kind as ChartDescriptorKind,
    series,
    source: {
      artifactId: optionalString(source.artifactId),
      resourceKey: source.resourceKey as string,
      resourceRevision: source.resourceRevision as number,
      runId: optionalString(source.runId),
      stageId: optionalString(source.stageId),
    },
    status: descriptor.status as ChartDescriptorStatus,
    title: descriptor.title as string,
    trust: descriptor.trust as ChartScientificTrust,
  };
}

function assertAxis(value: unknown, path: string): ChartAxisDescriptor {
  const axis = record(value, path);
  const id = requiredString(axis.id, `${path}.id`);
  const canonicalUnit = requiredString(
    axis.canonicalUnit,
    `${path}.canonicalUnit`,
  );
  const displayUnit = requiredString(axis.displayUnit, `${path}.displayUnit`);
  const unit = resolveChartUnit(canonicalUnit);
  if (!unit || unit.dimension !== axis.dimension) {
    throw invalid(`${path}.dimension`);
  }
  if (!chartUnitsCompatible(canonicalUnit, displayUnit)) {
    throw invalid(`${path}.displayUnit`);
  }
  return {
    canonicalUnit,
    dimension: axis.dimension as ChartDimension,
    displayUnit,
    id,
    label: requiredString(axis.label, `${path}.label`),
  };
}

function assertSeries(value: unknown, path: string): ChartSeriesDescriptor {
  const series = record(value, path);
  return {
    axisId: requiredString(series.axisId, `${path}.axisId`),
    canonicalUnit: requiredString(
      series.canonicalUnit,
      `${path}.canonicalUnit`,
    ),
    id: requiredString(series.id, `${path}.id`),
    label: requiredString(series.label, `${path}.label`),
    quantity: requiredString(series.quantity, `${path}.quantity`),
  };
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(path);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw invalid(path);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredRevision(value: unknown, path: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw invalid(path);
}

function invalid(path: string): TypeError {
  return new TypeError(`Invalid ChartDescriptor field ${path}.`);
}
