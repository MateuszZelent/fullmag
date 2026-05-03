"use client";

import { useCallback, useMemo } from "react";
import { AlertTriangle, BarChart3, CheckCircle2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { fmtSI } from "@/lib/format";
import type { FemLiveMesh, FemMeshPart, MeshQualityStats } from "@/lib/session/types";
import {
  getFemElementCount,
  readFemElementMarker,
  readFemElementNode,
  readFemNode,
} from "@/lib/session/femTopology";

import { useCommand, useModel } from "../../runs/control-room/context-hooks";
import { SidebarSection } from "./primitives";

type QualityMetric = "gamma" | "sicn";

export interface DomainStatisticsRow {
  id: string;
  marker: number;
  label: string;
  role: string;
  objectId: string | null;
  elementCount: number;
  boundaryFaceCount: number | null;
  quality: MeshQualityStats;
  status: "ok" | "warn" | "error";
  warnings: string[];
}

export interface WorstElementView {
  id: string;
  elementIndex: number;
  marker: number | null;
  scopeLabel: string | null;
  gamma: number | null;
  sicn: number | null;
  volume: number | null;
  centroid: number[] | null;
}

type DiagnosticSeverity = "error" | "warn" | "info";

interface MeshDiagnosticView {
  category: "Artifact freshness" | "Quality source" | "Airbox" | "Objects" | "Backend operations" | "Quality";
  severity: DiagnosticSeverity;
  message: string;
  recommendation: string;
}

export interface MeshOperationStatusView {
  kind: string;
  scope: string;
  requested: boolean;
  status: "applied" | "skipped" | "fallback" | "failed" | string;
  requestedMethod: string | null;
  actualMethod: string | null;
  reason: string | null;
}

export interface ThinFilmDiagnosticView {
  geometryName: string;
  isThinFilm: boolean;
  thickness: number | null;
  lateralSize: number | null;
  aspectRatio: number | null;
  requestedLayers: number | null;
  estimatedLayersFromHmax: number | null;
  hmaxToThicknessRatio: number | null;
  requestedMethod: string | null;
  actualMethod: string;
  warnings: string[];
}

interface ComputedTetraMetric {
  elementIndex: number;
  marker: number | null;
  gamma: number;
  sicn: number;
  volume: number;
  signedVolume: number;
  centroid: [number, number, number];
}

interface ComputedMeshQualityFallback {
  globalQuality: MeshQualityStats;
  rows: DomainStatisticsRow[];
  worstElements: WorstElementView[];
  volumeTotal: number;
  invertedCount: number;
  degenerateCount: number;
}

function finiteNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function qualityValue(quality: MeshQualityStats, metric: QualityMetric, key: "min" | "p5" | "mean" | "max"): number | null {
  if (metric === "gamma") {
    switch (key) {
      case "min": return finiteNumber(quality.gamma_min);
      case "p5": return null;
      case "mean": return finiteNumber(quality.gamma_mean);
      case "max": return null;
    }
  }
  switch (key) {
    case "min": return finiteNumber(quality.sicn_min);
    case "p5": return finiteNumber(quality.sicn_p5);
    case "mean": return finiteNumber(quality.sicn_mean);
    case "max": return finiteNumber(quality.sicn_max);
  }
}

function histogramFor(quality: MeshQualityStats, metric: QualityMetric): number[] {
  const bins = metric === "gamma" ? quality.gamma_histogram : quality.sicn_histogram;
  return Array.isArray(bins) ? bins.map((value) => Number(value) || 0) : [];
}

function qualityStatus(quality: MeshQualityStats): DomainStatisticsRow["status"] {
  const gammaMin = finiteNumber(quality.gamma_min);
  const sicnP5 = finiteNumber(quality.sicn_p5);
  const sicnMin = finiteNumber(quality.sicn_min);
  if ((gammaMin != null && gammaMin <= 0.02) || (sicnMin != null && sicnMin <= 0.0)) return "error";
  if ((gammaMin != null && gammaMin < 0.08) || (sicnP5 != null && sicnP5 < 0.1)) return "warn";
  return "ok";
}

function warningsFor(quality: MeshQualityStats, role: string): string[] {
  const warnings: string[] = [];
  const gammaMin = finiteNumber(quality.gamma_min);
  const sicnP5 = finiteNumber(quality.sicn_p5);
  const sicnMin = finiteNumber(quality.sicn_min);
  const volumeMin = finiteNumber(quality.volume_min);
  const volumeMax = finiteNumber(quality.volume_max);
  if (sicnMin != null && sicnMin <= 0.0) warnings.push("Inverted or invalid-quality tetrahedra suspected.");
  if (gammaMin != null && gammaMin < 0.08) warnings.push("Very low gamma quality in this scope.");
  if (sicnP5 != null && sicnP5 < 0.1) warnings.push("Worst 5% SICN tail is below FEM quality target.");
  if (volumeMin != null && volumeMax != null && volumeMin > 0 && volumeMax / volumeMin > 1e5) {
    warnings.push("Extreme element volume ratio.");
  }
  if (role === "magnetic_object" && quality.n_elements < 16) {
    warnings.push("Very few tetrahedra in magnetic object scope.");
  }
  return warnings;
}

function volumeRatio(quality: MeshQualityStats): number | null {
  const min = finiteNumber(quality.volume_min);
  const max = finiteNumber(quality.volume_max);
  if (min == null || max == null || min <= 0) return null;
  return max / min;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function statisticMetricValue(
  globalScope: Record<string, unknown> | null,
  metric: "gamma" | "sicn",
  key: "min" | "p05" | "mean" | "max",
): number | null {
  const metricRecord = asRecord(globalScope?.[metric]);
  return finiteNumber(metricRecord?.[key]);
}

function statisticVolumeValue(
  globalScope: Record<string, unknown> | null,
  key: "min" | "max" | "mean" | "std" | "ratio" | "total",
): number | null {
  const volumeRecord = asRecord(globalScope?.volume);
  return finiteNumber(volumeRecord?.[key]);
}

function formatQuality(value: number | null): string {
  return value == null ? "-" : value.toFixed(3);
}

function formatRatio(value: number | null): string {
  if (value == null) return "-";
  if (value >= 1e4 || value < 1e-2) return value.toExponential(2);
  return value.toFixed(1);
}

function formatInteger(value: number | null): string {
  return value == null ? "-" : Math.round(value).toLocaleString();
}

function optionMeters(value: string | undefined): number | null {
  if (!value) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function histogramCounts(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (typeof entry === "number") return Number.isFinite(entry) ? entry : 0;
    const record = asRecord(entry);
    return finiteNumber(record?.count) ?? 0;
  });
}

function metricRecordValue(record: Record<string, unknown> | null, key: "min" | "p05" | "mean" | "max"): number {
  return finiteNumber(record?.[key]) ?? 0;
}

function qualityFromStatisticsScope(scope: Record<string, unknown>): MeshQualityStats {
  const sicn = asRecord(scope.sicn);
  const gamma = asRecord(scope.gamma);
  const volume = asRecord(scope.volume);
  const elementCount = finiteNumber(scope.element_count) ?? 0;
  const gammaMin = metricRecordValue(gamma, "min");
  const gammaMean = metricRecordValue(gamma, "mean");
  const sicnMean = metricRecordValue(sicn, "mean");
  return {
    n_elements: elementCount,
    sicn_min: metricRecordValue(sicn, "min"),
    sicn_max: metricRecordValue(sicn, "max"),
    sicn_mean: sicnMean,
    sicn_p5: metricRecordValue(sicn, "p05"),
    sicn_histogram: histogramCounts(sicn?.histogram),
    gamma_min: gammaMin,
    gamma_mean: gammaMean,
    gamma_histogram: histogramCounts(gamma?.histogram),
    volume_min: finiteNumber(volume?.min) ?? 0,
    volume_max: finiteNumber(volume?.max) ?? 0,
    volume_mean: finiteNumber(volume?.mean) ?? 0,
    volume_std: finiteNumber(volume?.std) ?? 0,
    avg_quality: gammaMean || sicnMean || gammaMin,
  };
}

function percentile(sortedValues: readonly number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.max(0, Math.min(sortedValues.length - 1, (sortedValues.length - 1) * p));
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  if (lo === hi) return sortedValues[lo] ?? 0;
  const frac = index - lo;
  return (sortedValues[lo] ?? 0) * (1 - frac) + (sortedValues[hi] ?? 0) * frac;
}

function histogram(values: readonly number[], bins: number, min: number, max: number): number[] {
  const counts = Array.from({ length: bins }, () => 0);
  const width = max - min || 1;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    const raw = Math.floor(((value - min) / width) * bins);
    const index = Math.max(0, Math.min(bins - 1, raw));
    counts[index] += 1;
  }
  return counts;
}

function sub(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a: readonly number[], b: readonly number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function norm(a: readonly number[]): number {
  return Math.sqrt(dot(a, a));
}

function triangleArea(a: readonly number[], b: readonly number[], c: readonly number[]): number {
  return 0.5 * norm(cross(sub(b, a), sub(c, a)));
}

function solve3x3(
  rows: [[number, number, number], [number, number, number], [number, number, number]],
  rhs: [number, number, number],
): [number, number, number] | null {
  const [a, b, c] = rows;
  const det = dot(a, cross(b, c));
  if (!Number.isFinite(det) || Math.abs(det) < 1e-300) return null;
  return [
    dot(rhs, cross(b, c)) / det,
    dot(a, cross(rhs, c)) / det,
    dot(a, cross(b, rhs)) / det,
  ];
}

function squaredNorm(a: readonly number[]): number {
  return dot(a, a);
}

function tetraCircumradius(
  a: readonly number[],
  b: readonly number[],
  c: readonly number[],
  d: readonly number[],
): number {
  const center = solve3x3(
    [
      [2 * (b[0] - a[0]), 2 * (b[1] - a[1]), 2 * (b[2] - a[2])],
      [2 * (c[0] - a[0]), 2 * (c[1] - a[1]), 2 * (c[2] - a[2])],
      [2 * (d[0] - a[0]), 2 * (d[1] - a[1]), 2 * (d[2] - a[2])],
    ],
    [
      squaredNorm(b) - squaredNorm(a),
      squaredNorm(c) - squaredNorm(a),
      squaredNorm(d) - squaredNorm(a),
    ],
  );
  return center ? norm(sub(center, a)) : 0;
}

function statsFromTetraMetrics(metrics: readonly ComputedTetraMetric[]): MeshQualityStats {
  if (metrics.length === 0) {
    return {
      n_elements: 0,
      sicn_min: 0,
      sicn_max: 0,
      sicn_mean: 0,
      sicn_p5: 0,
      sicn_histogram: Array.from({ length: 20 }, () => 0),
      gamma_min: 0,
      gamma_mean: 0,
      gamma_histogram: Array.from({ length: 20 }, () => 0),
      volume_min: 0,
      volume_max: 0,
      volume_mean: 0,
      volume_std: 0,
      avg_quality: 0,
    };
  }
  const gamma = metrics.map((entry) => entry.gamma);
  const sicn = metrics.map((entry) => entry.sicn);
  const volumes = metrics.map((entry) => entry.volume);
  const gammaMean = gamma.reduce((sum, value) => sum + value, 0) / gamma.length;
  const sicnMean = sicn.reduce((sum, value) => sum + value, 0) / sicn.length;
  const volumeMean = volumes.reduce((sum, value) => sum + value, 0) / volumes.length;
  const volumeStd = Math.sqrt(
    volumes.reduce((sum, value) => sum + (value - volumeMean) ** 2, 0) / volumes.length,
  );
  const sortedSicn = [...sicn].sort((a, b) => a - b);
  return {
    n_elements: metrics.length,
    sicn_min: Math.min(...sicn),
    sicn_max: Math.max(...sicn),
    sicn_mean: sicnMean,
    sicn_p5: percentile(sortedSicn, 0.05),
    sicn_histogram: histogram(sicn, 20, -1, 1),
    gamma_min: Math.min(...gamma),
    gamma_mean: gammaMean,
    gamma_histogram: histogram(gamma, 20, 0, 1),
    volume_min: Math.min(...volumes),
    volume_max: Math.max(...volumes),
    volume_mean: volumeMean,
    volume_std: volumeStd,
    avg_quality: gammaMean,
  };
}

function partForComputedGroup(
  parts: readonly FemMeshPart[],
  usedPartIds: Set<string>,
  marker: number | null,
  metrics: readonly ComputedTetraMetric[],
): FemMeshPart | null {
  if (marker === 0) {
    const air = parts.find((part) => !usedPartIds.has(part.id) && part.role === "air");
    if (air) return air;
  }
  const first = metrics[0]?.elementIndex ?? -1;
  const last = metrics[metrics.length - 1]?.elementIndex ?? -1;
  return (
    parts.find((part) =>
      !usedPartIds.has(part.id) &&
      part.element_count === metrics.length &&
      first >= part.element_start &&
      last < part.element_start + part.element_count,
    ) ??
    parts.find((part) => !usedPartIds.has(part.id) && part.element_count === metrics.length) ??
    null
  );
}

function computeMeshQualityFallback(mesh: FemLiveMesh | null | undefined): ComputedMeshQualityFallback | null {
  if (!mesh) return null;
  const elementCount = getFemElementCount(mesh);
  if (elementCount <= 0) return null;
  const metrics: ComputedTetraMetric[] = [];
  for (let elementIndex = 0; elementIndex < elementCount; elementIndex += 1) {
    const indices = [0, 1, 2, 3].map((localIndex) =>
      readFemElementNode(mesh, elementIndex, localIndex),
    );
    if (indices.some((index) => index == null)) continue;
    const a = readFemNode(mesh, indices[0]!);
    const b = readFemNode(mesh, indices[1]!);
    const c = readFemNode(mesh, indices[2]!);
    const d = readFemNode(mesh, indices[3]!);
    if (!a || !b || !c || !d) continue;
    const signedVolume = dot(sub(b, a), cross(sub(c, a), sub(d, a))) / 6;
    const volume = Math.abs(signedVolume);
    const surfaceArea =
      triangleArea(a, b, c) +
      triangleArea(a, b, d) +
      triangleArea(a, c, d) +
      triangleArea(b, c, d);
    const inradius = surfaceArea > 0 ? (3 * volume) / surfaceArea : 0;
    const circumradius = tetraCircumradius(a, b, c, d);
    const gamma = circumradius > 0
      ? Math.max(0, Math.min(1, (3 * inradius) / circumradius))
      : 0;
    const orientation = signedVolume < 0 ? -1 : 1;
    metrics.push({
      elementIndex,
      marker: readFemElementMarker(mesh, elementIndex),
      gamma,
      sicn: orientation * gamma,
      volume,
      signedVolume,
      centroid: [
        (a[0] + b[0] + c[0] + d[0]) / 4,
        (a[1] + b[1] + c[1] + d[1]) / 4,
        (a[2] + b[2] + c[2] + d[2]) / 4,
      ],
    });
  }
  if (metrics.length === 0) return null;
  const groups = new Map<number, ComputedTetraMetric[]>();
  for (const metric of metrics) {
    const marker = metric.marker ?? -1;
    const group = groups.get(marker);
    if (group) group.push(metric);
    else groups.set(marker, [metric]);
  }
  const usedPartIds = new Set<string>();
  const parts = mesh.mesh_parts ?? [];
  const rows = Array.from(groups.entries()).map(([marker, group]) => {
    const quality = statsFromTetraMetrics(group);
    const markerValue = marker === -1 ? 0 : marker;
    const part = partForComputedGroup(parts, usedPartIds, marker === -1 ? null : marker, group);
    if (part) usedPartIds.add(part.id);
    const role = part?.role ?? (marker === 0 ? "air" : "domain");
    const label = part?.label ?? part?.object_id ?? (marker === 0 ? "Airbox" : marker === -1 ? "Unclassified domain" : `Domain ${marker}`);
    return {
      id: part?.id ?? `computed:${marker}`,
      marker: markerValue,
      label,
      role,
      objectId: part?.object_id ?? null,
      elementCount: quality.n_elements,
      boundaryFaceCount: part?.boundary_face_count ?? null,
      quality,
      status: qualityStatus(quality),
      warnings: warningsFor(quality, role),
    } satisfies DomainStatisticsRow;
  }).sort((a, b) => {
    const roleRank = (row: DomainStatisticsRow) => row.role === "air" ? 0 : row.role === "magnetic_object" ? 1 : 2;
    return roleRank(a) - roleRank(b) || a.marker - b.marker;
  });
  const worstElements = [...metrics]
    .sort((a, b) => a.gamma - b.gamma)
    .slice(0, 12)
    .map((entry) => ({
      id: `computed-worst:${entry.elementIndex}`,
      elementIndex: entry.elementIndex,
      marker: entry.marker,
      scopeLabel: null,
      gamma: entry.gamma,
      sicn: entry.sicn,
      volume: entry.volume,
      centroid: entry.centroid,
    }));
  return {
    globalQuality: statsFromTetraMetrics(metrics),
    rows,
    worstElements,
    volumeTotal: metrics.reduce((sum, entry) => sum + entry.volume, 0),
    invertedCount: metrics.filter((entry) => entry.signedVolume < 0).length,
    degenerateCount: metrics.filter((entry) => entry.volume <= 0 || entry.gamma <= 0).length,
  };
}

export function buildRowsFromMeshStatisticsReport(report: Record<string, unknown> | null | undefined): DomainStatisticsRow[] {
  const scopes = Array.isArray(report?.scopes) ? report.scopes : [];
  return scopes.flatMap((entry, index) => {
    const scope = asRecord(entry);
    if (!scope) return [];
    const quality = qualityFromStatisticsScope(scope);
    const role = stringOrNull(scope.role) ?? stringOrNull(scope.kind) ?? "domain";
    const label = stringOrNull(scope.label) ?? (role === "air" ? "Airbox" : `Scope ${index + 1}`);
    const marker = finiteNumber(scope.marker);
    return [{
      id: stringOrNull(scope.id) ?? `scope:${index}`,
      marker: marker == null ? index : marker,
      label,
      role,
      objectId: stringOrNull(scope.object_id),
      elementCount: quality.n_elements,
      boundaryFaceCount: finiteNumber(scope.boundary_face_count),
      quality,
      status: qualityStatus(quality),
      warnings: [
        ...warningsFor(quality, role),
        ...(Array.isArray(scope.warnings) ? scope.warnings.filter((warning): warning is string => typeof warning === "string") : []),
      ],
    }];
  });
}

export function parseWorstElements(report: Record<string, unknown> | null | undefined): WorstElementView[] {
  const raw = Array.isArray(report?.worst_elements) ? report.worst_elements : [];
  return raw.flatMap((entry, index) => {
    const record = asRecord(entry);
    if (!record) return [];
    const elementIndex = finiteNumber(record.element_index);
    if (elementIndex == null) return [];
    const centroid = Array.isArray(record.centroid)
      ? record.centroid.map((value) => finiteNumber(value)).filter((value): value is number => value != null)
      : null;
    return [{
      id: `worst:${elementIndex}:${index}`,
      elementIndex,
      marker: finiteNumber(record.marker),
      scopeLabel: stringOrNull(record.scope_label),
      gamma: finiteNumber(record.gamma),
      sicn: finiteNumber(record.sicn),
      volume: finiteNumber(record.volume),
      centroid: centroid && centroid.length === 3 ? centroid : null,
    }];
  });
}

export function parseOperationStatuses(summary: Record<string, unknown> | null | undefined): MeshOperationStatusView[] {
  const raw = Array.isArray(summary?.operation_statuses) ? summary.operation_statuses : [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const kind = stringOrNull(record.kind);
    const status = stringOrNull(record.status);
    if (!kind || !status) return [];
    return [{
      kind,
      scope: stringOrNull(record.scope) ?? "global",
      requested: Boolean(record.requested),
      status,
      requestedMethod: stringOrNull(record.requested_method),
      actualMethod: stringOrNull(record.actual_method),
      reason: stringOrNull(record.reason),
    }];
  });
}

export function parseThinFilmDiagnostics(summary: Record<string, unknown> | null | undefined): ThinFilmDiagnosticView[] {
  const raw = Array.isArray(summary?.thin_film_diagnostics) ? summary.thin_film_diagnostics : [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const geometryName = stringOrNull(record.geometry_name);
    if (!geometryName) return [];
    return [{
      geometryName,
      isThinFilm: Boolean(record.is_thin_film),
      thickness: finiteNumber(record.thickness),
      lateralSize: finiteNumber(record.lateral_size),
      aspectRatio: finiteNumber(record.aspect_ratio),
      requestedLayers: finiteNumber(record.requested_layers),
      estimatedLayersFromHmax: finiteNumber(record.estimated_layers_from_hmax),
      hmaxToThicknessRatio: finiteNumber(record.hmax_to_thickness_ratio),
      requestedMethod: stringOrNull(record.requested_method),
      actualMethod: stringOrNull(record.actual_method) ?? "free_tetrahedral",
      warnings: Array.isArray(record.warnings)
        ? record.warnings.filter((warning): warning is string => typeof warning === "string")
        : [],
    }];
  });
}

function thinFilmWarnings(parts: FemMeshPart[], hmin: number | null, hmax: number | null): string[] {
  const warnings: string[] = [];
  for (const part of parts) {
    if (part.role !== "magnetic_object" || !part.bounds_min || !part.bounds_max) continue;
    const spans = part.bounds_max.map((max, index) => Math.abs(max - part.bounds_min![index]));
    const thickness = Math.min(...spans.filter((span) => Number.isFinite(span) && span > 0));
    if (!Number.isFinite(thickness) || thickness <= 0) continue;
    const label = part.label || part.object_id || part.id;
    if (hmin != null && thickness / hmin < 4) {
      warnings.push(`${label}: fewer than 4 minimum-size elements through the thinnest dimension.`);
    }
    if (hmax != null && thickness / hmax < 2) {
      warnings.push(`${label}: maximum element size is too large for thin-film thickness.`);
    }
  }
  return warnings;
}

function roleLabel(role: string): string {
  switch (role) {
    case "air": return "Airbox";
    case "magnetic_object": return "Object";
    case "interface": return "Interface";
    case "outer_boundary": return "Outer boundary";
    case "global": return "Global";
    default: return role.replaceAll("_", " ");
  }
}

function verdictFromQuality(quality: MeshQualityStats | null, qualitySource: string | null): { label: string; tone: DomainStatisticsRow["status"]; detail: string } {
  if (!quality || qualitySource === "topology") {
    return {
      label: "Missing quality",
      tone: "warn",
      detail: "Mesh topology is available, but Gmsh tetrahedral quality metrics were not extracted for this build.",
    };
  }
  const sourcePrefix = qualitySource === "frontend-topology"
    ? "Frontend topology fallback quality"
    : "Extracted tetrahedral quality metrics";
  const gammaMin = finiteNumber(quality.gamma_min);
  const sicnP5 = finiteNumber(quality.sicn_p5);
  if ((gammaMin != null && gammaMin < 0.03) || (sicnP5 != null && sicnP5 < 0.05)) {
    return {
      label: "Poor",
      tone: "error",
      detail: `${sourcePrefix} shows worst tetrahedra below the FEM quality target; inspect worst elements before trusting physics.`,
    };
  }
  if ((gammaMin != null && gammaMin < 0.08) || (sicnP5 != null && sicnP5 < 0.1)) {
    return {
      label: "Check",
      tone: "warn",
      detail: `${sourcePrefix} shows a low quality tail. Results may still run, but the mesh should be refined or optimized.`,
    };
  }
  return {
    label: "Usable",
    tone: "ok",
    detail: `${sourcePrefix} is above the current warning thresholds.`,
  };
}

function uniquePartMatch(parts: FemMeshPart[], usedPartIds: Set<string>, predicate: (part: FemMeshPart) => boolean): FemMeshPart | null {
  const matches = parts.filter((part) => !usedPartIds.has(part.id) && predicate(part));
  return matches.length === 1 ? matches[0] : null;
}

function buildDomainRows(
  perDomainQuality: Record<number, MeshQualityStats> | null | undefined,
  parts: FemMeshPart[],
): DomainStatisticsRow[] {
  if (!perDomainQuality) return [];
  const usedPartIds = new Set<string>();
  return Object.entries(perDomainQuality)
    .map(([markerRaw, quality]) => {
      const marker = Number(markerRaw);
      const q = quality as MeshQualityStats;
      const airPart = Number.isFinite(marker) && marker === 0
        ? uniquePartMatch(parts, usedPartIds, (part) => part.role === "air")
        : null;
      const exactMagneticPart = uniquePartMatch(
        parts,
        usedPartIds,
        (part) => part.role === "magnetic_object" && part.element_count === q.n_elements,
      );
      const fallbackRolePart = uniquePartMatch(
        parts,
        usedPartIds,
        (part) => part.element_count === q.n_elements,
      );
      const part = airPart ?? exactMagneticPart ?? fallbackRolePart;
      if (part) usedPartIds.add(part.id);
      const role = part?.role ?? (marker === 0 ? "air" : "domain");
      const label = part?.label ?? part?.object_id ?? (marker === 0 ? "Airbox" : `Domain ${marker}`);
      const status = qualityStatus(q);
      return {
        id: part?.id ?? `domain:${marker}`,
        marker,
        label,
        role,
        objectId: part?.object_id ?? null,
        elementCount: q.n_elements,
        boundaryFaceCount: part?.boundary_face_count ?? null,
        quality: q,
        status,
        warnings: warningsFor(q, role),
      };
    })
    .sort((a, b) => {
      const roleRank = (row: DomainStatisticsRow) => row.role === "global" ? 0 : row.role === "air" ? 1 : row.role === "magnetic_object" ? 2 : 3;
      return roleRank(a) - roleRank(b) || a.marker - b.marker;
    });
}

function HistogramBars({ bins, metric }: { bins: number[]; metric: QualityMetric }) {
  const max = Math.max(...bins, 1);
  const range = metric === "gamma" ? "0..1" : "-1..1";
  return (
    <div className="grid gap-1">
      <div className="flex h-20 items-end gap-0.5 rounded-lg border border-border/10 bg-card/40 px-2 py-2">
        {bins.length > 0 ? bins.map((count, index) => (
          <div
            key={`${index}:${count}`}
            className={cn(
              "min-w-0 flex-1 rounded-t-sm",
              metric === "gamma" ? "bg-emerald-400/70" : "bg-cyan-400/70",
            )}
            style={{ height: `${Math.max(2, (count / max) * 100)}%` }}
            title={`${count} elements`}
          />
        )) : (
          <div className="flex h-full w-full items-center justify-center text-[0.7rem] text-muted-foreground">
            Histogram unavailable
          </div>
        )}
      </div>
      <div className="flex justify-between text-[0.62rem] font-mono text-muted-foreground">
        <span>{range.split("..")[0]}</span>
        <span>{metric.toUpperCase()}</span>
        <span>{range.split("..")[1]}</span>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: DomainStatisticsRow["status"] }) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[0.58rem] font-bold uppercase tracking-wider",
        status === "ok" && "bg-success/15 text-success",
        status === "warn" && "bg-warning/15 text-warning",
        status === "error" && "bg-error/15 text-error",
      )}
    >
      {status}
    </span>
  );
}

function OperationStatusBadge({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[0.58rem] font-bold uppercase tracking-wider",
        normalized === "applied" && "bg-success/15 text-success",
        normalized === "skipped" && "bg-muted/40 text-muted-foreground",
        normalized === "fallback" && "bg-warning/15 text-warning",
        normalized === "failed" && "bg-error/15 text-error",
      )}
    >
      {status}
    </span>
  );
}

function DiagnosticSeverityBadge({ severity }: { severity: DiagnosticSeverity }) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[0.58rem] font-bold uppercase tracking-wider",
        severity === "error" && "bg-error/15 text-error",
        severity === "warn" && "bg-warning/15 text-warning",
        severity === "info" && "bg-primary/10 text-primary",
      )}
    >
      {severity}
    </span>
  );
}

function diagnosticSeverityFromRow(status: DomainStatisticsRow["status"]): DiagnosticSeverity {
  return status === "error" ? "error" : status === "warn" ? "warn" : "info";
}

export default function MeshStatisticsPanel() {
  const model = useModel();
  const cmd = useCommand();

  const mesh = model.effectiveFemMesh;
  const meshWorkspace = model.meshWorkspace;
  const meshQualityData = model.meshQualityData;
  const meshStatistics = asRecord(meshWorkspace?.mesh_statistics);
  const meshStatisticsGlobal = asRecord(meshStatistics?.global);
  const reportQualitySource = stringOrNull(meshStatistics?.quality_source);
  const reportHasExtractedQuality = Boolean(reportQualitySource && reportQualitySource !== "topology");
  const globalQuality = meshQualityData
    ? {
        n_elements: meshQualityData.nElements,
        sicn_min: meshQualityData.sicnMin,
        sicn_max: meshQualityData.sicnMax,
        sicn_mean: meshQualityData.sicnMean,
        sicn_p5: meshQualityData.sicnP5,
        sicn_histogram: meshQualityData.sicnHistogram,
        gamma_min: meshQualityData.gammaMin,
        gamma_mean: meshQualityData.gammaMean,
        gamma_histogram: meshQualityData.gammaHistogram,
        volume_min: meshQualityData.volumeMin,
        volume_max: meshQualityData.volumeMax,
        volume_mean: meshQualityData.volumeMean,
        volume_std: meshQualityData.volumeStd,
        avg_quality: meshQualityData.avgQuality,
      } satisfies MeshQualityStats
    : null;
  const hasBackendQualitySummary = Boolean(globalQuality);
  const computedQualityFallback = useMemo(
    () => reportHasExtractedQuality || hasBackendQualitySummary ? null : computeMeshQualityFallback(mesh),
    [hasBackendQualitySummary, mesh, reportHasExtractedQuality],
  );
  const perDomainRows = useMemo(
    () => {
      const reportRows = reportHasExtractedQuality ? buildRowsFromMeshStatisticsReport(meshStatistics) : [];
      return reportRows.length > 0
        ? reportRows
        : computedQualityFallback?.rows.length
          ? computedQualityFallback.rows
          : buildDomainRows(mesh?.per_domain_quality ?? null, mesh?.mesh_parts ?? []);
    },
    [computedQualityFallback, mesh?.mesh_parts, mesh?.per_domain_quality, meshStatistics, reportHasExtractedQuality],
  );
  const worstElements = useMemo(
    () => {
      const reportWorst = reportHasExtractedQuality ? parseWorstElements(meshStatistics) : [];
      return reportWorst.length > 0 ? reportWorst : computedQualityFallback?.worstElements ?? [];
    },
    [computedQualityFallback?.worstElements, meshStatistics, reportHasExtractedQuality],
  );

  const structuredSummary = meshWorkspace?.mesh_quality_summary ?? null;
  const operationStatuses = useMemo(
    () => parseOperationStatuses(meshWorkspace?.last_build_summary),
    [meshWorkspace?.last_build_summary],
  );
  const thinFilmDiagnostics = useMemo(
    () => parseThinFilmDiagnostics(meshWorkspace?.last_build_summary),
    [meshWorkspace?.last_build_summary],
  );
  const statisticsGlobalQuality = reportHasExtractedQuality && meshStatisticsGlobal
    ? qualityFromStatisticsScope(meshStatisticsGlobal)
    : null;
  const primaryHistogramQuality = statisticsGlobalQuality ?? globalQuality ?? computedQualityFallback?.globalQuality ?? perDomainRows[0]?.quality ?? null;
  const qualitySource = reportHasExtractedQuality
    ? reportQualitySource
    : hasBackendQualitySummary
      ? "gmsh-summary"
      : computedQualityFallback
      ? "frontend-topology"
      : reportQualitySource;
  const qualityVerdict = verdictFromQuality(primaryHistogramQuality, qualitySource);
  const missingTetraQualityWarning = !primaryHistogramQuality || qualitySource === "topology"
    ? "This mesh artifact was built without tetrahedral quality metrics. New builds compute these metrics automatically; rebuild the solver mesh before using it for physics validation."
    : null;
  const frontendFallbackWarning = computedQualityFallback && !reportHasExtractedQuality
    ? "Tetra quality was computed in the browser from mesh topology because the current artifact lacks backend Gmsh quality metrics; rebuild to persist backend statistics."
    : null;
  const diagnostics = useMemo<MeshDiagnosticView[]>(() => {
    const entries: MeshDiagnosticView[] = [];
    if (model.meshConfigDirty) {
      entries.push({
        category: "Artifact freshness",
        severity: "warn",
        message: "Displayed mesh is stale relative to current mesh-affecting settings.",
        recommendation: "Rebuild mesh before accepting the quality verdict.",
      });
    }
    if (frontendFallbackWarning) {
      entries.push({
        category: "Quality source",
        severity: model.meshConfigDirty ? "warn" : "error",
        message: frontendFallbackWarning,
        recommendation: "Use Rebuild Solver Mesh so backend Gmsh statistics are persisted.",
      });
    }
    if (missingTetraQualityWarning) {
      entries.push({
        category: "Quality source",
        severity: "warn",
        message: missingTetraQualityWarning,
        recommendation: "Enable quality extraction and rebuild the solver mesh.",
      });
    }
    if (model.meshOptions.optimizeIters > 1 && !model.meshOptions.optimize.trim()) {
      entries.push({
        category: "Backend operations",
        severity: "warn",
        message: "Optimize iterations are configured but no optimizer method is selected; iterations will be ignored.",
        recommendation: "Select Netgen optimizer or set iterations to 0.",
      });
    }
    for (const warning of thinFilmWarnings(
      mesh?.mesh_parts ?? [],
      optionMeters(model.meshOptions.minimumElementSize || model.meshOptions.hmin),
      optionMeters(model.meshOptions.maximumElementSize || model.meshOptions.hmax),
    )) {
      entries.push({
        category: "Objects",
        severity: "warn",
        message: warning,
        recommendation: "Reduce object hmax or use a validation mesh profile for thin-film checks.",
      });
    }
    for (const status of operationStatuses) {
      if (status.status !== "fallback" && status.status !== "failed" && status.status !== "skipped") continue;
      entries.push({
        category: "Backend operations",
        severity: status.status === "failed" ? "error" : "warn",
        message: `${status.kind} (${status.scope}) ${status.status}${status.reason ? `: ${status.reason}` : ""}`,
        recommendation: status.status === "skipped"
          ? "Check requested method settings."
          : "Inspect actual method before trusting mesh assumptions.",
      });
    }
    for (const diagnostic of thinFilmDiagnostics) {
      for (const warning of diagnostic.warnings) {
        entries.push({
          category: "Objects",
          severity: "warn",
          message: `${diagnostic.geometryName}: ${warning}`,
          recommendation: "Use enough through-thickness resolution or accept free-tet fallback explicitly.",
        });
      }
    }
    for (const warning of statisticsGlobalQuality ? warningsFor(statisticsGlobalQuality, "global") : globalQuality ? warningsFor(globalQuality, "global") : []) {
      entries.push({
        category: "Quality",
        severity: warning.includes("invalid") || warning.includes("Very low") ? "error" : "warn",
        message: warning,
        recommendation: "Inspect worst elements and compare backend Gmsh statistics after rebuild.",
      });
    }
    for (const row of perDomainRows) {
      const category = row.role === "air" ? "Airbox" : "Objects";
      const severity = diagnosticSeverityFromRow(row.status);
      for (const warning of row.warnings) {
        entries.push({
          category,
          severity,
          message: `${row.label}: ${warning}`,
          recommendation: row.role === "air"
            ? "Increase airbox hmin or reduce abrupt transition-field spread."
            : "Inspect worst elements in this object and adjust local hmax/optimizer.",
        });
      }
    }
    return entries;
  }, [
    frontendFallbackWarning,
    globalQuality,
    mesh?.mesh_parts,
    missingTetraQualityWarning,
    model.meshConfigDirty,
    model.meshOptions.hmax,
    model.meshOptions.hmin,
    model.meshOptions.maximumElementSize,
    model.meshOptions.minimumElementSize,
    model.meshOptions.optimize,
    model.meshOptions.optimizeIters,
    operationStatuses,
    perDomainRows,
    statisticsGlobalQuality,
    thinFilmDiagnostics,
  ]);
  const diagnosticCounts = diagnostics.reduce(
    (counts, diagnostic) => {
      counts[diagnostic.severity] += 1;
      return counts;
    },
    { error: 0, warn: 0, info: 0 } satisfies Record<DiagnosticSeverity, number>,
  );
  const diagnosticsByCategory = diagnostics.reduce((groups, diagnostic) => {
    const group = groups.get(diagnostic.category);
    if (group) group.push(diagnostic);
    else groups.set(diagnostic.category, [diagnostic]);
    return groups;
  }, new Map<MeshDiagnosticView["category"], MeshDiagnosticView[]>());

  const elementCount =
    mesh?.elements.length ??
    finiteNumber(meshStatisticsGlobal?.element_count) ??
    structuredSummary?.n_elements ??
    globalQuality?.n_elements ??
    0;
  const nodeCount =
    mesh?.nodes.length ??
    finiteNumber(meshStatisticsGlobal?.node_count) ??
    0;
  const boundaryFaceCount =
    mesh?.boundary_faces.length ??
    finiteNumber(meshStatisticsGlobal?.boundary_face_count) ??
    0;
  const meshName = mesh?.mesh_name ?? meshWorkspace?.mesh_summary?.mesh_name ?? "study_domain";
  const volumeRatioValue = statisticVolumeValue(meshStatisticsGlobal, "ratio")
    ?? (statisticsGlobalQuality ? volumeRatio(statisticsGlobalQuality) : null)
    ?? (globalQuality ? volumeRatio(globalQuality) : null)
    ?? (computedQualityFallback ? volumeRatio(computedQualityFallback.globalQuality) : null);
  const exportPayload = reportHasExtractedQuality && meshStatistics ? meshStatistics : {
    mesh_name: meshName,
    quality_source: computedQualityFallback ? "frontend-topology" : qualitySource ?? "topology",
    global: computedQualityFallback
      ? {
          element_count: computedQualityFallback.globalQuality.n_elements,
          node_count: nodeCount,
          boundary_face_count: boundaryFaceCount,
          gamma: {
            min: computedQualityFallback.globalQuality.gamma_min,
            mean: computedQualityFallback.globalQuality.gamma_mean,
            histogram: computedQualityFallback.globalQuality.gamma_histogram,
          },
          sicn: {
            min: computedQualityFallback.globalQuality.sicn_min,
            p05: computedQualityFallback.globalQuality.sicn_p5,
            mean: computedQualityFallback.globalQuality.sicn_mean,
            max: computedQualityFallback.globalQuality.sicn_max,
            histogram: computedQualityFallback.globalQuality.sicn_histogram,
          },
          volume: {
            min: computedQualityFallback.globalQuality.volume_min,
            max: computedQualityFallback.globalQuality.volume_max,
            mean: computedQualityFallback.globalQuality.volume_mean,
            std: computedQualityFallback.globalQuality.volume_std,
            ratio: volumeRatio(computedQualityFallback.globalQuality),
            total: computedQualityFallback.volumeTotal,
          },
          inverted_count: computedQualityFallback.invertedCount,
          degenerate_count: computedQualityFallback.degenerateCount,
        }
      : structuredSummary,
    scopes: perDomainRows.map((row) => ({
      id: row.id,
      label: row.label,
      role: row.role,
      marker: row.marker,
      element_count: row.elementCount,
      boundary_face_count: row.boundaryFaceCount,
      quality: row.quality,
      warnings: row.warnings,
    })),
    worst_elements: worstElements,
  };
  const handleExportStatistics = useCallback(() => {
    const blob = new Blob([`${JSON.stringify(exportPayload, null, 2)}\n`], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${meshName || "mesh"}-statistics.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }, [exportPayload, meshName]);
  const handleRebuildStatisticsMesh = useCallback(() => {
    void model.handleStudyDomainMeshGenerate("mesh_statistics_refresh");
  }, [model]);

  return (
    <div className="flex flex-col px-2 pt-4">
      <SidebarSection
        title="Mesh Statistics"
        badge={model.meshConfigDirty ? "stale" : "current"}
        defaultOpen={true}
      >
        <div className="grid gap-3">
          <div className="flex items-start justify-between gap-3 rounded-lg border border-border/10 bg-card/40 p-3">
            <div className="grid gap-1">
              <div className="flex items-center gap-2 text-[0.78rem] font-semibold text-foreground">
                <BarChart3 size={14} className="text-primary" />
                <span>{meshName}</span>
              </div>
              <div className="text-[0.68rem] leading-relaxed text-muted-foreground">
                COMSOL-like statistics for the realized shared-domain solver mesh. Tetrahedral quality is computed automatically during new mesh builds; surface-only diagnostics remain separate.
              </div>
            </div>
            <div className="text-right text-[0.62rem] font-mono text-muted-foreground">
              {cmd.workspaceStatus.replaceAll("_", " ")}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="rounded-lg border border-primary/35 bg-primary/10 px-2.5 py-1.5 text-[0.68rem] font-semibold text-primary transition-colors hover:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-45"
              onClick={handleRebuildStatisticsMesh}
              disabled={model.meshGenerating}
            >
              {model.meshGenerating ? "Building..." : "Rebuild Solver Mesh"}
            </button>
            <button
              type="button"
              className="rounded-lg border border-border/10 bg-card/60 px-2.5 py-1.5 text-[0.68rem] font-semibold text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
              onClick={handleExportStatistics}
            >
              Export Stats JSON
            </button>
          </div>
          <div className="grid grid-cols-4 gap-2">
            <StatTile label="Freshness" value={model.meshConfigDirty ? "stale" : "current"} />
            <StatTile label="Quality source" value={qualitySource ?? "topology"} />
            <StatTile label="Errors" value={diagnosticCounts.error.toLocaleString()} />
            <StatTile label="Warnings" value={diagnosticCounts.warn.toLocaleString()} />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <StatTile label="Nodes" value={nodeCount.toLocaleString()} />
            <StatTile label="Tetrahedra" value={Number(elementCount).toLocaleString()} />
            <StatTile label="Boundary faces" value={boundaryFaceCount.toLocaleString()} />
            <StatTile label="Domains" value={perDomainRows.length.toLocaleString()} />
            <StatTile label="Gamma min" value={formatQuality(statisticMetricValue(meshStatisticsGlobal, "gamma", "min") ?? (primaryHistogramQuality ? qualityValue(primaryHistogramQuality, "gamma", "min") : finiteNumber(structuredSummary?.gamma_min)))} />
            <StatTile label="SICN p5" value={formatQuality(statisticMetricValue(meshStatisticsGlobal, "sicn", "p05") ?? (primaryHistogramQuality ? qualityValue(primaryHistogramQuality, "sicn", "p5") : finiteNumber(structuredSummary?.sicn_p5)))} />
            <StatTile label="Avg quality" value={formatQuality(statisticsGlobalQuality?.avg_quality ?? globalQuality?.avg_quality ?? computedQualityFallback?.globalQuality.avg_quality ?? finiteNumber(structuredSummary?.avg_quality))} />
            <StatTile label="Volume ratio" value={formatRatio(volumeRatioValue)} />
          </div>
          <div className="rounded-lg border border-border/10 bg-card/40 p-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div>
                <div className="text-[0.72rem] font-semibold text-foreground/90">Quality Verdict</div>
                <div className="mt-0.5 text-[0.66rem] leading-relaxed text-muted-foreground">
                  {qualityVerdict.detail}
                </div>
              </div>
              <StatusBadge status={qualityVerdict.tone} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <StatTile label="Source" value={qualitySource ?? (primaryHistogramQuality ? "gmsh" : "topology")} />
              <StatTile label="Verdict" value={qualityVerdict.label} />
              <StatTile label="Inverted" value={formatInteger(finiteNumber(meshStatisticsGlobal?.inverted_count) ?? computedQualityFallback?.invertedCount ?? null)} />
              <StatTile label="Degenerate" value={formatInteger(finiteNumber(meshStatisticsGlobal?.degenerate_count) ?? computedQualityFallback?.degenerateCount ?? null)} />
              <StatTile label="Volume total" value={fmtSI(statisticVolumeValue(meshStatisticsGlobal, "total") ?? computedQualityFallback?.volumeTotal ?? 0, "m^3")} />
              <StatTile label="Volume mean" value={fmtSI(statisticVolumeValue(meshStatisticsGlobal, "mean") ?? primaryHistogramQuality?.volume_mean ?? 0, "m^3")} />
            </div>
          </div>
        </div>
      </SidebarSection>

      <SidebarSection title="Element Quality Histogram" defaultOpen={true}>
        {primaryHistogramQuality ? (
          <div className="grid gap-4">
            <HistogramBars bins={histogramFor(primaryHistogramQuality, "gamma")} metric="gamma" />
            <HistogramBars bins={histogramFor(primaryHistogramQuality, "sicn")} metric="sicn" />
          </div>
        ) : (
          <EmptyStats message="No tetrahedral quality histogram is available on this existing artifact. Rebuild the solver mesh to generate Gmsh quality metrics automatically." />
        )}
      </SidebarSection>

      <SidebarSection title="Global / Airbox / Objects" defaultOpen={true}>
        {perDomainRows.length > 0 ? (
          <div className="overflow-hidden rounded-lg border border-border/10 bg-card/40">
            <div className="grid grid-cols-[1.2fr_0.55fr_0.55fr_0.55fr_0.55fr_0.55fr] gap-2 border-b border-border/10 bg-card/40 px-2.5 py-2 text-[0.58rem] font-bold uppercase tracking-wider text-muted-foreground">
              <span>Scope</span>
              <span>Elems</span>
              <span>Gamma min</span>
              <span>SICN p5</span>
              <span>Vol ratio</span>
              <span>Status</span>
            </div>
            {perDomainRows.map((row) => (
              <div key={row.id} className="grid grid-cols-[1.2fr_0.55fr_0.55fr_0.55fr_0.55fr_0.55fr] gap-2 border-b border-border/10 px-2.5 py-2.5 last:border-b-0">
                <div className="min-w-0">
                  <div className="truncate text-[0.72rem] font-semibold text-foreground/90" title={row.label}>{row.label}</div>
                  <div className="font-mono text-[0.6rem] text-muted-foreground">
                    {roleLabel(row.role)} · marker {row.marker}
                  </div>
                </div>
                <MetricCell value={row.elementCount.toLocaleString()} />
                <MetricCell value={formatQuality(qualityValue(row.quality, "gamma", "min"))} />
                <MetricCell value={formatQuality(qualityValue(row.quality, "sicn", "p5"))} />
                <MetricCell value={formatRatio(volumeRatio(row.quality))} />
                <div className="flex items-center justify-end">
                  <StatusBadge status={row.status} />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyStats message="Per-domain quality is not available for this mesh. Rebuild with per-element quality enabled to classify airbox and object scopes." />
        )}
      </SidebarSection>

      <SidebarSection title="Worst Elements" defaultOpen={worstElements.length > 0}>
        {worstElements.length > 0 ? (
          <div className="overflow-hidden rounded-lg border border-border/10 bg-card/40">
            <div className="grid grid-cols-[0.8fr_0.55fr_0.65fr_0.65fr] gap-2 border-b border-border/10 bg-card/40 px-2.5 py-2 text-[0.58rem] font-bold uppercase tracking-wider text-muted-foreground">
              <span>Element</span>
              <span>Scope</span>
              <span>Gamma</span>
              <span>Volume</span>
            </div>
            {worstElements.map((element) => (
              <div key={element.id} className="grid grid-cols-[0.8fr_0.55fr_0.65fr_0.65fr] gap-2 border-b border-border/10 px-2.5 py-2 last:border-b-0">
                <div className="min-w-0">
                  <div className="font-mono text-[0.68rem] font-semibold text-foreground/90">
                    #{element.elementIndex}
                  </div>
                  {element.centroid ? (
                    <div className="truncate font-mono text-[0.56rem] text-muted-foreground" title={element.centroid.map((value) => fmtSI(value, "m")).join(", ")}>
                      centroid {element.centroid.map((value) => fmtSI(value, "m")).join(", ")}
                    </div>
                  ) : null}
                </div>
                <MetricCell value={element.scopeLabel ?? perDomainRows.find((row) => row.marker === element.marker)?.label ?? (element.marker == null ? "-" : `marker ${element.marker}`)} />
                <MetricCell value={formatQuality(element.gamma)} />
                <MetricCell value={element.volume == null ? "-" : fmtSI(element.volume, "m^3")} />
              </div>
            ))}
          </div>
        ) : (
          <EmptyStats message="Worst-element diagnostics are unavailable. Rebuild with per-element quality enabled to inspect low-quality tetrahedra." />
        )}
      </SidebarSection>

      <SidebarSection title="Backend Operations" defaultOpen={operationStatuses.length > 0 || thinFilmDiagnostics.length > 0}>
        {operationStatuses.length > 0 || thinFilmDiagnostics.length > 0 ? (
          <div className="grid gap-3">
            {operationStatuses.length > 0 ? (
              <div className="grid gap-2">
                {operationStatuses.map((operation, index) => (
                  <div key={`${operation.kind}:${operation.scope}:${index}`} className="rounded-lg border border-border/10 bg-card/40 px-3 py-2">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-[0.72rem] font-semibold text-foreground/90">
                          {operation.kind.replaceAll("_", " ")} · {operation.scope}
                        </div>
                        <div className="mt-0.5 font-mono text-[0.62rem] text-muted-foreground">
                          {operation.requestedMethod ?? "auto"} → {operation.actualMethod ?? "none"}
                        </div>
                      </div>
                      <OperationStatusBadge status={operation.status} />
                    </div>
                    {operation.reason ? (
                      <div className="mt-1.5 text-[0.68rem] leading-relaxed text-muted-foreground">
                        {operation.reason}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
            {thinFilmDiagnostics.length > 0 ? (
              <div className="grid gap-2">
                {thinFilmDiagnostics.map((diagnostic) => (
                  <div key={diagnostic.geometryName} className="rounded-lg border border-border/10 bg-card/40 px-3 py-2">
                    <div className="flex items-center justify-between gap-3">
                      <div className="truncate text-[0.72rem] font-semibold text-foreground/90">
                        Thin-film · {diagnostic.geometryName}
                      </div>
                      <span className="font-mono text-[0.6rem] uppercase tracking-wider text-muted-foreground">
                        {diagnostic.actualMethod}
                      </span>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-2 text-[0.66rem]">
                      <InfoLine label="Thickness" value={diagnostic.thickness != null ? fmtSI(diagnostic.thickness, "m") : "-"} />
                      <InfoLine label="Aspect" value={diagnostic.aspectRatio != null ? diagnostic.aspectRatio.toFixed(1) : "-"} />
                      <InfoLine label="Req layers" value={diagnostic.requestedLayers != null ? String(Math.round(diagnostic.requestedLayers)) : "-"} />
                      <InfoLine label="Est layers" value={diagnostic.estimatedLayersFromHmax != null ? String(Math.round(diagnostic.estimatedLayersFromHmax)) : "-"} />
                    </div>
                    {diagnostic.warnings.length > 0 ? (
                      <div className="mt-2 grid gap-1">
                        {diagnostic.warnings.map((warning) => (
                          <div key={warning} className="text-[0.68rem] leading-relaxed text-warning">
                            {warning}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <EmptyStats message="No backend operation statuses are available yet. Rebuild the shared-domain mesh to capture actual methods and fallbacks." />
        )}
      </SidebarSection>

      <SidebarSection title="Warnings" defaultOpen={diagnostics.length > 0}>
        {diagnostics.length > 0 ? (
          <div className="grid gap-3">
            <div className="grid grid-cols-3 gap-2">
              <StatTile label="Errors" value={diagnosticCounts.error.toLocaleString()} />
              <StatTile label="Warnings" value={diagnosticCounts.warn.toLocaleString()} />
              <StatTile label="Info" value={diagnosticCounts.info.toLocaleString()} />
            </div>
            {Array.from(diagnosticsByCategory.entries()).map(([category, entries]) => (
              <div key={category} className="grid gap-2">
                <div className="text-[0.6rem] font-bold uppercase tracking-wider text-muted-foreground">{category}</div>
                {entries.map((diagnostic) => (
                  <div
                    key={`${diagnostic.category}:${diagnostic.severity}:${diagnostic.message}`}
                    className={cn(
                      "grid gap-1 rounded-lg border px-3 py-2 text-[0.72rem] leading-relaxed",
                      diagnostic.severity === "error" && "border-error/25 bg-error/10 text-error/90",
                      diagnostic.severity === "warn" && "border-warning/25 bg-warning/10 text-warning/90",
                      diagnostic.severity === "info" && "border-primary/20 bg-primary/10 text-primary/90",
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex gap-2">
                        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                        <span>{diagnostic.message}</span>
                      </div>
                      <DiagnosticSeverityBadge severity={diagnostic.severity} />
                    </div>
                    <div className="pl-5 text-[0.64rem] text-muted-foreground">
                      {diagnostic.recommendation}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <div className="flex gap-2 rounded-lg border border-success/25 bg-success/10 px-3 py-2 text-[0.72rem] text-success/90">
            <CheckCircle2 size={14} />
            <span>No mesh statistics warnings from the currently loaded quality data.</span>
          </div>
        )}
      </SidebarSection>

      {globalQuality || meshStatisticsGlobal ? (
        <SidebarSection title="Volume Statistics" defaultOpen={false}>
          <div className="grid gap-1.5 rounded-lg border border-border/10 bg-card/40 p-2.5 text-xs">
            <InfoLine label="Volume min" value={fmtSI(statisticVolumeValue(meshStatisticsGlobal, "min") ?? globalQuality?.volume_min ?? 0, "m^3")} />
            <InfoLine label="Volume max" value={fmtSI(statisticVolumeValue(meshStatisticsGlobal, "max") ?? globalQuality?.volume_max ?? 0, "m^3")} />
            <InfoLine label="Volume mean" value={fmtSI(statisticVolumeValue(meshStatisticsGlobal, "mean") ?? globalQuality?.volume_mean ?? 0, "m^3")} />
            <InfoLine label="Volume std" value={fmtSI(statisticVolumeValue(meshStatisticsGlobal, "std") ?? globalQuality?.volume_std ?? 0, "m^3")} />
          </div>
        </SidebarSection>
      ) : null}
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 rounded-lg border border-border/10 bg-card/40 px-2.5 py-2">
      <span className="text-[0.58rem] font-bold uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="font-mono text-xs font-semibold text-foreground/90">{value}</span>
    </div>
  );
}

function MetricCell({ value }: { value: string }) {
  return <div className="self-center text-right font-mono text-[0.68rem] text-foreground/90">{value}</div>;
}

function InfoLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[96px_1fr] gap-2">
      <span className="text-[0.62rem] font-bold uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="font-mono text-foreground/90">{value}</span>
    </div>
  );
}

function EmptyStats({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border/10 bg-card/40 px-3 py-2 text-[0.74rem] leading-relaxed text-muted-foreground">
      {message}
    </div>
  );
}
