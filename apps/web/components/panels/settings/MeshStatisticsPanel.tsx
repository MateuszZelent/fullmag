"use client";

import { useMemo } from "react";
import { AlertTriangle, BarChart3, CheckCircle2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { fmtSI } from "@/lib/format";
import type { FemMeshPart, MeshQualityStats } from "@/lib/session/types";

import { useCommand, useModel } from "../../runs/control-room/context-hooks";
import { SidebarSection } from "./primitives";

type QualityMetric = "gamma" | "sicn";

interface DomainStatisticsRow {
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

function formatQuality(value: number | null): string {
  return value == null ? "-" : value.toFixed(3);
}

function formatRatio(value: number | null): string {
  if (value == null) return "-";
  if (value >= 1e4 || value < 1e-2) return value.toExponential(2);
  return value.toFixed(1);
}

function optionMeters(value: string | undefined): number | null {
  if (!value) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
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
      <div className="flex h-20 items-end gap-0.5 rounded-lg border border-border/30 bg-background/45 px-2 py-2">
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

export default function MeshStatisticsPanel() {
  const model = useModel();
  const cmd = useCommand();

  const mesh = model.effectiveFemMesh;
  const meshWorkspace = model.meshWorkspace;
  const meshQualityData = model.meshQualityData;
  const perDomainRows = useMemo(
    () => buildDomainRows(mesh?.per_domain_quality ?? null, mesh?.mesh_parts ?? []),
    [mesh?.mesh_parts, mesh?.per_domain_quality],
  );

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

  const structuredSummary = meshWorkspace?.mesh_quality_summary ?? null;
  const globalWarnings = [
    ...(model.meshConfigDirty ? ["Displayed mesh is stale relative to current mesh-affecting settings."] : []),
    ...(model.meshOptions.optimizeIters > 1 && !model.meshOptions.optimize.trim()
      ? ["Optimize iterations are configured but no optimizer method is selected; iterations will be ignored."]
      : []),
    ...thinFilmWarnings(
      mesh?.mesh_parts ?? [],
      optionMeters(model.meshOptions.minimumElementSize || model.meshOptions.hmin),
      optionMeters(model.meshOptions.maximumElementSize || model.meshOptions.hmax),
    ),
    ...(globalQuality ? warningsFor(globalQuality, "global") : []),
    ...perDomainRows.flatMap((row) => row.warnings.map((warning) => `${row.label}: ${warning}`)),
  ];

  const primaryHistogramQuality = globalQuality ?? perDomainRows[0]?.quality ?? null;
  const elementCount = mesh?.elements.length ?? structuredSummary?.n_elements ?? globalQuality?.n_elements ?? 0;
  const nodeCount = mesh?.nodes.length ?? 0;
  const boundaryFaceCount = mesh?.boundary_faces.length ?? 0;
  const meshName = mesh?.mesh_name ?? meshWorkspace?.mesh_summary?.mesh_name ?? "study_domain";

  return (
    <div className="flex flex-col px-2 pt-4">
      <SidebarSection
        title="Mesh Statistics"
        badge={model.meshConfigDirty ? "stale" : "current"}
        defaultOpen={true}
      >
        <div className="grid gap-3">
          <div className="flex items-start justify-between gap-3 rounded-lg border border-border/35 bg-background/45 p-3">
            <div className="grid gap-1">
              <div className="flex items-center gap-2 text-[0.78rem] font-semibold text-foreground">
                <BarChart3 size={14} className="text-primary" />
                <span>{meshName}</span>
              </div>
              <div className="text-[0.68rem] leading-relaxed text-muted-foreground">
                COMSOL-like statistics for the realized shared-domain solver mesh. Surface-only aspect ratio diagnostics are kept separate from tetrahedral volume quality.
              </div>
            </div>
            <div className="text-right text-[0.62rem] font-mono text-muted-foreground">
              {cmd.workspaceStatus.replaceAll("_", " ")}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <StatTile label="Nodes" value={nodeCount.toLocaleString()} />
            <StatTile label="Tetrahedra" value={Number(elementCount).toLocaleString()} />
            <StatTile label="Boundary faces" value={boundaryFaceCount.toLocaleString()} />
            <StatTile label="Domains" value={perDomainRows.length.toLocaleString()} />
            <StatTile label="Gamma min" value={formatQuality(globalQuality ? qualityValue(globalQuality, "gamma", "min") : finiteNumber(structuredSummary?.gamma_min))} />
            <StatTile label="SICN p5" value={formatQuality(globalQuality ? qualityValue(globalQuality, "sicn", "p5") : finiteNumber(structuredSummary?.sicn_p5))} />
            <StatTile label="Avg quality" value={formatQuality(globalQuality?.avg_quality ?? finiteNumber(structuredSummary?.avg_quality))} />
            <StatTile label="Volume ratio" value={formatRatio(globalQuality ? volumeRatio(globalQuality) : null)} />
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
          <EmptyStats message="No tetrahedral quality histogram is available. Enable Extract quality metrics and rebuild the solver mesh." />
        )}
      </SidebarSection>

      <SidebarSection title="Global / Airbox / Objects" defaultOpen={true}>
        {perDomainRows.length > 0 ? (
          <div className="overflow-hidden rounded-lg border border-border/35">
            <div className="grid grid-cols-[1.25fr_0.65fr_0.65fr_0.65fr_0.65fr] gap-2 border-b border-border/30 bg-muted/20 px-2.5 py-2 text-[0.58rem] font-bold uppercase tracking-wider text-muted-foreground">
              <span>Scope</span>
              <span>Elems</span>
              <span>Gamma min</span>
              <span>SICN p5</span>
              <span>Status</span>
            </div>
            {perDomainRows.map((row) => (
              <div key={row.id} className="grid grid-cols-[1.25fr_0.65fr_0.65fr_0.65fr_0.65fr] gap-2 border-b border-border/20 px-2.5 py-2.5 last:border-b-0">
                <div className="min-w-0">
                  <div className="truncate text-[0.72rem] font-semibold text-foreground/90" title={row.label}>{row.label}</div>
                  <div className="font-mono text-[0.6rem] text-muted-foreground">
                    {roleLabel(row.role)} · marker {row.marker}
                  </div>
                </div>
                <MetricCell value={row.elementCount.toLocaleString()} />
                <MetricCell value={formatQuality(qualityValue(row.quality, "gamma", "min"))} />
                <MetricCell value={formatQuality(qualityValue(row.quality, "sicn", "p5"))} />
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

      <SidebarSection title="Warnings" defaultOpen={globalWarnings.length > 0}>
        {globalWarnings.length > 0 ? (
          <div className="grid gap-2">
            {globalWarnings.map((warning) => (
              <div key={warning} className="flex gap-2 rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-[0.72rem] leading-relaxed text-warning/90">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>{warning}</span>
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

      {globalQuality ? (
        <SidebarSection title="Volume Statistics" defaultOpen={false}>
          <div className="grid gap-1.5 rounded-lg border border-border/30 bg-background/45 p-2.5 text-xs">
            <InfoLine label="Volume min" value={fmtSI(globalQuality.volume_min, "m^3")} />
            <InfoLine label="Volume max" value={fmtSI(globalQuality.volume_max, "m^3")} />
            <InfoLine label="Volume mean" value={fmtSI(globalQuality.volume_mean, "m^3")} />
            <InfoLine label="Volume std" value={fmtSI(globalQuality.volume_std, "m^3")} />
          </div>
        </SidebarSection>
      ) : null}
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 rounded-lg border border-border/35 bg-background/45 px-2.5 py-2">
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
    <div className="rounded-lg border border-dashed border-border/40 bg-background/30 px-3 py-2 text-[0.74rem] leading-relaxed text-muted-foreground">
      {message}
    </div>
  );
}
