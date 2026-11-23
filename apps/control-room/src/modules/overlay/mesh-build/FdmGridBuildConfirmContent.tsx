import { AlertTriangle, CheckCircle2, Grid3X3, Loader2 } from "lucide-react";

import { Button } from "@/shared/ui/Button";

export interface FdmGridBuildConfirmContentProps {
  commandId: string | null;
  commandStatus: string;
  errorMessage?: string | null;
  geometryBounds?: {
    max: [number, number, number];
    min: [number, number, number];
  } | null;
  gridMemoryMB?: number | null;
  gridShape?: [number, number, number] | null;
  gridSpacing?: [number, number, number] | null;
  membershipRevision?: number | null;
  mode?: "pre-build" | "submitting" | "waiting" | "post-build" | "error";
  objectsCount: number;
  onApplyBuild: () => void;
  onCancel: () => void;
  onOpenMeshOverview?: () => void;
  ready?: boolean;
  rendered?: boolean;
  sceneRevision?: number | null;
  stale?: boolean;
  totalCells?: number | null;
}

function resolveLengthUnit(values: readonly number[]): {
  scale: number;
  unit: string;
} {
  const maxAbs = values.reduce((acc, v) => Math.max(acc, Math.abs(v)), 0);
  if (maxAbs > 0 && maxAbs < 1e-6) return { scale: 1e9, unit: "nm" };
  if (maxAbs >= 1e-6 && maxAbs < 1e-3) return { scale: 1e6, unit: "µm" };
  if (maxAbs >= 1e-3 && maxAbs < 1) return { scale: 1e3, unit: "mm" };
  return { scale: 1, unit: "m" };
}

function formatCompactNumber(value: number, maxDecimals = 2): string {
  if (Math.abs(value) < 1e-12) return "0";
  return Number(value.toFixed(maxDecimals)).toString();
}

function formatBounds(
  bounds:
    | { min: [number, number, number]; max: [number, number, number] }
    | null
    | undefined,
): string {
  if (!bounds) return "Derived from scene bounding box";
  const all = [...bounds.min, ...bounds.max];
  const { scale, unit } = resolveLengthUnit(all);
  const minStr = bounds.min
    .map((v) => formatCompactNumber(v * scale, 2))
    .join(", ");
  const maxStr = bounds.max
    .map((v) => formatCompactNumber(v * scale, 2))
    .join(", ");
  return `[${minStr}] → [${maxStr}] ${unit}`;
}

function formatShape(
  shape: [number, number, number] | null | undefined,
): string {
  if (!shape) return "Pending";
  return `${shape[0]} × ${shape[1]} × ${shape[2]}`;
}

function formatCellSize(
  spacing: [number, number, number] | null | undefined,
): string {
  if (!spacing) return "Pending";
  const { scale, unit } = resolveLengthUnit(spacing);
  const parts = spacing.map((v) => formatCompactNumber(v * scale, 2));
  return `${parts.join(" × ")} ${unit}`;
}

export function FdmGridBuildConfirmContent({
  commandId,
  errorMessage,
  geometryBounds,
  gridMemoryMB,
  gridShape,
  gridSpacing,
  membershipRevision,
  mode,
  objectsCount,
  onApplyBuild,
  onCancel,
  onOpenMeshOverview,
  ready = true,
  rendered = false,
  sceneRevision,
  stale = false,
  totalCells,
}: FdmGridBuildConfirmContentProps) {
  const phase = mode ?? "pre-build";
  const buildButtonLabel =
    phase === "submitting"
      ? "Rebuilding grid…"
      : "Build Grid & Materialize Masks";

  const kpis = [
    { label: "Grid", value: formatShape(gridShape) },
    {
      label: "Total cells",
      value:
        totalCells != null ? totalCells.toLocaleString("en-US") : "Pending",
    },
    { label: "Cell size", value: formatCellSize(gridSpacing) },
    {
      label: "Mask memory",
      value: gridMemoryMB != null ? `${gridMemoryMB.toFixed(2)} MB` : "Pending",
    },
  ] as const;

  return (
    <div
      className="flex min-w-0 flex-col gap-3.5"
      data-fdm-grid-build-phase={phase}
    >
      {/* Top 4-tile KPI summary strip */}
      <div
        aria-label="FDM grid resolution & dimensions"
        className="grid grid-cols-2 gap-2 sm:grid-cols-4"
      >
        {kpis.map((kpi) => (
          <div
            key={kpi.label}
            className="flex min-w-0 flex-col gap-1 rounded-md border border-[var(--fm-border-subtle)] bg-[var(--fm-bg-panel)] px-3 py-2.5"
          >
            <span className="truncate text-[var(--fm-font-size-xs)] font-medium uppercase tracking-wider text-[var(--fm-text-muted)]">
              {kpi.label}
            </span>
            <span className="truncate font-mono text-sm font-semibold tabular-nums text-[var(--fm-text-primary)]">
              {kpi.value}
            </span>
          </div>
        ))}
      </div>

      {/* Status banners (error / post-build / preflight loading or stale) */}
      {(phase === "error" || phase === "waiting") && errorMessage ? (
        <section
          aria-label="Grid build error"
          className="flex items-start gap-2.5 rounded-md border border-[var(--fm-danger)] bg-[color-mix(in_srgb,var(--fm-danger)_10%,var(--fm-bg-panel))] px-3.5 py-2.5"
        >
          <AlertTriangle
            aria-hidden="true"
            className="mt-0.5 shrink-0 text-[var(--fm-danger-text)]"
            size={15}
          />
          <div className="min-w-0 space-y-0.5">
            <h3 className="m-0 text-xs font-semibold text-[var(--fm-danger-text)]">
              {phase === "error" ? "Build Error" : "Observation paused"}
            </h3>
            <p className="m-0 text-xs text-[var(--fm-text-secondary)]">
              {errorMessage}
            </p>
          </div>
        </section>
      ) : null}

      {phase === "post-build" ? (
        <section
          aria-label="Grid build completed"
          className="flex items-start gap-2.5 rounded-md border border-[color-mix(in_srgb,var(--fm-success)_45%,var(--fm-border-subtle))] bg-[color-mix(in_srgb,var(--fm-success)_10%,var(--fm-bg-panel))] px-3.5 py-2.5"
        >
          <CheckCircle2
            aria-hidden="true"
            className="mt-0.5 shrink-0 text-[var(--fm-success-text)]"
            size={15}
          />
          <div className="min-w-0 space-y-0.5">
            <h3 className="m-0 text-xs font-semibold text-[var(--fm-success-text)]">
              Grid &amp; Masks Materialized
            </h3>
            <p className="m-0 text-xs text-[var(--fm-text-secondary)]">
              {rendered
                ? "Published grid dimensions and membership masks rendered in the viewport."
                : "New grid revision published. Viewport update complete."}
            </p>
          </div>
        </section>
      ) : null}

      {!ready && phase === "pre-build" ? (
        <div className="flex items-center gap-2 rounded-md border border-[var(--fm-border-subtle)] bg-[var(--fm-bg-panel)] px-3.5 py-2 text-xs text-[var(--fm-text-muted)]">
          <Loader2
            aria-hidden="true"
            className="shrink-0 animate-spin text-[var(--fm-accent-text)]"
            size={13}
          />
          <span>
            {stale
              ? "The model changed after this confirmation was prepared. Review an updated preflight."
              : "Loading current scene geometry baseline…"}
          </span>
        </div>
      ) : null}

      {/* Aligned Specification List */}
      <section
        aria-label="Source scene geometry"
        className="overflow-hidden rounded-md border border-[var(--fm-border-subtle)] bg-[var(--fm-bg-panel)]"
      >
        <div className="border-b border-[var(--fm-border-subtle)] bg-[var(--fm-bg-elevated)] px-3.5 py-2">
          <h3 className="m-0 text-xs font-semibold text-[var(--fm-text-primary)]">
            FDM Structured Grid &amp; Mask Refresh
          </h3>
        </div>
        <dl className="m-0 divide-y divide-[var(--fm-border-subtle)]">
          <div className="flex items-center justify-between gap-4 px-3.5 py-2">
            <dt className="shrink-0 text-xs text-[var(--fm-text-muted)]">
              Target
            </dt>
            <dd className="m-0 text-right font-mono text-xs tabular-nums text-[var(--fm-text-primary)]">
              Committed scene geometry &amp; magnetic support
            </dd>
          </div>
          <div className="flex items-center justify-between gap-4 px-3.5 py-2">
            <dt className="shrink-0 text-xs text-[var(--fm-text-muted)]">
              Authored objects
            </dt>
            <dd className="m-0 text-right font-mono text-xs tabular-nums text-[var(--fm-text-primary)]">
              {objectsCount} {objectsCount === 1 ? "object" : "objects"}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-4 px-3.5 py-2">
            <dt className="shrink-0 text-xs text-[var(--fm-text-muted)]">
              Geometry extents
            </dt>
            <dd className="m-0 text-right font-mono text-xs tabular-nums text-[var(--fm-text-primary)]">
              {formatBounds(geometryBounds)}
            </dd>
          </div>
          {membershipRevision != null ? (
            <div className="flex items-center justify-between gap-4 px-3.5 py-2">
              <dt className="shrink-0 text-xs text-[var(--fm-text-muted)]">
                Current mask revision
              </dt>
              <dd className="m-0 text-right font-mono text-xs tabular-nums text-[var(--fm-text-primary)]">
                Revision {membershipRevision}
              </dd>
            </div>
          ) : null}
        </dl>
      </section>

      {/* Compact subtle command metadata line */}
      <p className="m-0 px-0.5 font-mono text-xs tabular-nums text-[var(--fm-text-muted)]">
        {commandId ?? "grid.build-fdm"} ·{" "}
        {sceneRevision != null ? `Revision ${sceneRevision}` : "Scene baseline"}
      </p>

      {/* Polished Footer Actions */}
      <div className="mt-1 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--fm-border-subtle)] pt-3.5">
        <Button size="sm" type="button" variant="ghost" onClick={onCancel}>
          {phase === "pre-build" ? "Cancel" : "Close"}
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          {onOpenMeshOverview ? (
            <Button
              size="sm"
              type="button"
              variant="secondary"
              onClick={onOpenMeshOverview}
            >
              Mesh Overview
            </Button>
          ) : null}
          {phase !== "pre-build" && phase !== "submitting" ? null : (
            <Button
              disabled={phase === "submitting" || !ready}
              size="sm"
              type="button"
              variant="primary"
              onClick={onApplyBuild}
            >
              {phase === "submitting" ? (
                <Loader2
                  aria-hidden="true"
                  className="animate-spin"
                  size={13}
                />
              ) : (
                <Grid3X3 aria-hidden="true" size={13} />
              )}
              <span>{buildButtonLabel}</span>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
