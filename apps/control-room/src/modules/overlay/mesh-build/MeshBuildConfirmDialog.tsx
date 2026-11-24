import { AlertTriangle, CheckCircle2, Info, Loader2, Play } from "lucide-react";

import { Button } from "@/shared/ui/Button";
import type { MeshBuildSnapshotRow } from "@/shared/domain/mesh/meshBuildSnapshots";
import type { MeshPolicyDiffRow } from "@/shared/domain/mesh/meshPolicyDiff";

import { MeshBuildParameterDiff } from "./MeshBuildParameterDiff";

export interface MeshBuildSummaryRow {
  label: string;
  value: string;
}

function compactTargetName(targetLabel: string): string {
  if (/shared[- ]domain/i.test(targetLabel)) return "Shared domain";
  return targetLabel;
}

function findSummaryValue(
  rows: readonly MeshBuildSummaryRow[] | undefined,
  labelPattern: RegExp,
): string | null {
  const found = rows?.find((row) => labelPattern.test(row.label));
  return found?.value ?? null;
}

export interface MeshBuildConfirmFooterProps {
  mode?: "pre-build" | "submitting" | "waiting" | "post-build" | "error";
  ready?: boolean;
  stale?: boolean;
  onApplyBuild: () => void;
  onCancel: () => void;
  onOpenMeshJobs: () => void;
  onRefresh?: () => void;
  onResumeObservation?: () => void;
}

export function MeshBuildConfirmFooter({
  mode,
  onApplyBuild,
  onCancel,
  onOpenMeshJobs,
  onRefresh,
  onResumeObservation,
  ready = true,
  stale = false,
}: MeshBuildConfirmFooterProps) {
  const phase = mode ?? "pre-build";
  const buildButtonLabel =
    phase === "submitting" ? "Build in progress" : "Accept & Build";

  return (
    <>
      <div className="fm-mesh-build-confirm__footer-group">
        <Button size="sm" type="button" variant="ghost" onClick={onCancel}>
          {phase === "pre-build" ? "Cancel" : "Close"}
        </Button>
        {stale && phase === "pre-build" ? (
          <Button size="sm" type="button" variant="secondary" onClick={onRefresh}>
            Refresh preflight
          </Button>
        ) : null}
        {phase === "waiting" ? (
          <Button
            size="sm"
            type="button"
            variant="secondary"
            onClick={onResumeObservation}
          >
            Resume observation
          </Button>
        ) : null}
      </div>
      <div className="fm-mesh-build-confirm__footer-group">
        <Button
          size="sm"
          type="button"
          variant="secondary"
          onClick={onOpenMeshJobs}
        >
          Open Mesh Jobs
        </Button>
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
              <Play aria-hidden="true" size={12} />
            )}
            <span>{buildButtonLabel}</span>
          </Button>
        )}
      </div>
    </>
  );
}

export function MeshBuildConfirmDialogContent({
  commandId,
  currentSummary,
  diffRows,
  errorMessage,
  globalHmaxLabel,
  hideFooter = false,
  mode,
  objectsCount,
  ready = true,
  sceneRevision,
  stale = false,
  onRefresh,
  onResumeObservation,
  rendered = false,
  newSummary,
  onApplyBuild,
  onCancel,
  onOpenMeshJobs,
  postBuildRows,
  targetLabel,
}: {
  commandId: string | null;
  commandStatus: string;
  currentSummary: readonly MeshBuildSummaryRow[];
  diffRows: readonly MeshPolicyDiffRow[];
  errorMessage?: string | null;
  globalHmaxLabel?: string | null;
  hideFooter?: boolean;
  mode?: "pre-build" | "submitting" | "waiting" | "post-build" | "error";
  objectsCount?: number | null;
  ready?: boolean;
  sceneRevision?: number | null;
  stale?: boolean;
  onRefresh?: () => void;
  onResumeObservation?: () => void;
  rendered?: boolean;
  newSummary?: readonly MeshBuildSummaryRow[];
  onApplyBuild: () => void;
  onCancel: () => void;
  onOpenMeshJobs: () => void;
  postBuildRows?: readonly MeshBuildSnapshotRow[];
  targetLabel: string;
}) {
  const phase = mode ?? "pre-build";
  const requestsExactLayeredPrism = diffRows.some(
    (row) =>
      (row.path === "topology" && row.draftValue === "prismatic") ||
      (row.path === "mesh_strategy" && row.draftValue === "swept_prism"),
  );

  const changedCount = diffRows.filter((row) => row.state !== "unchanged").length;
  const resolvedSceneRev =
    sceneRevision != null
      ? `Rev ${sceneRevision}`
      : (() => {
          const val = findSummaryValue(currentSummary, /^scene revision$/i);
          return val ? `Rev ${val}` : "Baseline";
        })();
  const resolvedObjects =
    objectsCount != null
      ? String(objectsCount)
      : findSummaryValue(currentSummary, /revision/i) ?? "—";

  const kpis = [
    { label: "Target", value: compactTargetName(targetLabel) },
    {
      label: "Global h_max",
      value:
        globalHmaxLabel ??
        (changedCount > 0
          ? `${changedCount} ${changedCount === 1 ? "change" : "changes"}`
          : "Policy default"),
    },
    {
      label: objectsCount != null ? "Objects" : "Mesh rev",
      value: resolvedObjects,
    },
    { label: "Scene rev", value: resolvedSceneRev },
  ] as const;

  const filteredNewSummary = (newSummary ?? []).filter(
    (row) => row.label.toLowerCase() !== "command",
  );

  return (
    <div className="flex min-w-0 flex-col gap-3.5">
      {/* Top 4-tile KPI summary strip */}
      <div
        aria-label="Mesh build target"
        className="grid grid-cols-2 gap-2 sm:grid-cols-4"
      >
        {kpis.map((kpi) => (
          <div
            key={kpi.label}
            className="flex min-w-0 flex-col gap-1 rounded-[var(--fm-radius-field)] border border-[var(--fm-border-subtle)] bg-[var(--fm-section-bg)] px-3 py-2.5"
          >
            <span className="truncate text-[var(--fm-font-size-2xs)] font-semibold uppercase tracking-wider text-[var(--fm-text-muted)]">
              {kpi.label}
            </span>
            <span className="truncate font-mono text-sm font-semibold tabular-nums text-[var(--fm-text-primary)]">
              {kpi.value}
            </span>
          </div>
        ))}
      </div>

      {/* Status banners */}
      {(phase === "error" || phase === "waiting") && errorMessage ? (
        <section
          aria-label="Mesh build error"
          className="flex items-start gap-2.5 rounded-md border border-[var(--fm-danger)] bg-[color-mix(in_srgb,var(--fm-danger)_10%,var(--fm-bg-panel))] px-3.5 py-2.5"
        >
          <AlertTriangle
            aria-hidden="true"
            className="mt-0.5 shrink-0 text-[var(--fm-danger-text)]"
            size={15}
          />
          <div className="min-w-0 space-y-0.5">
            <h3 className="m-0 text-xs font-semibold text-[var(--fm-danger-text)]">
              {phase === "error" ? "Build Error" : "Build observation paused"}
            </h3>
            <p className="m-0 text-xs text-[var(--fm-text-secondary)]">
              {errorMessage}
            </p>
          </div>
        </section>
      ) : null}

      {phase === "post-build" ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-2.5 rounded-md border border-[color-mix(in_srgb,var(--fm-success)_45%,var(--fm-border-subtle))] bg-[color-mix(in_srgb,var(--fm-success)_10%,var(--fm-bg-panel))] px-3.5 py-2.5">
            <CheckCircle2
              aria-hidden="true"
              className="mt-0.5 shrink-0 text-[var(--fm-success-text)]"
              size={15}
            />
            <p className="m-0 text-xs text-[var(--fm-text-secondary)]">
              {rendered
                ? "Published mesh revision rendered in the viewport."
                : "New mesh revision published. Viewport rendering has not been confirmed."}
            </p>
          </div>
          <MeshBuildPostBuildSummary rows={postBuildRows ?? []} />
        </div>
      ) : null}

      {requestsExactLayeredPrism ? (
        <section
          aria-label="Exact layered prism requirements"
          className="flex items-start gap-2.5 rounded-md border border-[color-mix(in_srgb,var(--fm-accent)_40%,var(--fm-border-subtle))] bg-[color-mix(in_srgb,var(--fm-accent)_8%,var(--fm-bg-panel))] px-3.5 py-2.5"
        >
          <Info
            aria-hidden="true"
            className="mt-0.5 shrink-0 text-[var(--fm-accent-text)]"
            size={15}
          />
          <div className="min-w-0 space-y-0.5">
            <h3 className="m-0 text-xs font-semibold text-[var(--fm-text-primary)]">
              Strict no-fallback
            </h3>
            <p className="m-0 text-xs text-[var(--fm-text-secondary)]">
              The build must realize the requested prism, pyramid, and tetrahedra families exactly;
              unsupported lanes reject before execution. A one-layer result still requires
              layer-convergence evidence before scientific qualification.
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
              : "Loading the target policy and current mesh baseline…"}
          </span>
        </div>
      ) : null}

      <MeshBuildParameterDiff rows={diffRows} />

      {/* Aligned Specification Cards */}
      {currentSummary.length > 0 ? (
        <section
          aria-label="Current mesh summary"
          className="overflow-hidden rounded-[var(--fm-radius-field)] border border-[var(--fm-border-subtle)] bg-[var(--fm-section-bg)]"
        >
          <div className="border-b border-[var(--fm-border-subtle)] bg-[color-mix(in_oklab,var(--fm-raised-bg)_58%,transparent)] px-3.5 py-2">
            <h3 className="m-0 text-xs font-semibold text-[var(--fm-text-primary)]">
              Current Mesh Summary
            </h3>
          </div>
          <dl className="m-0 divide-y divide-[var(--fm-border-subtle)]">
            {currentSummary.map((row) => (
              <div
                key={row.label}
                className="flex items-center justify-between gap-4 px-3.5 py-2"
              >
                <dt className="shrink-0 text-xs text-[var(--fm-text-muted)]">
                  {row.label}
                </dt>
                <dd className="m-0 text-right font-mono text-xs tabular-nums text-[var(--fm-text-primary)]">
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {filteredNewSummary.length > 0 ? (
        <section
          aria-label="New mesh request"
          className="overflow-hidden rounded-[var(--fm-radius-field)] border border-[var(--fm-border-subtle)] bg-[var(--fm-section-bg)]"
        >
          <div className="flex items-center justify-between gap-2 border-b border-[var(--fm-border-subtle)] bg-[color-mix(in_oklab,var(--fm-raised-bg)_58%,transparent)] px-3.5 py-2">
            <h3 className="m-0 text-xs font-semibold text-[var(--fm-text-primary)]">
              New Mesh Request
            </h3>
            <span className="sr-only">Mesh Build Confirmation</span>
          </div>
          <dl className="m-0 divide-y divide-[var(--fm-border-subtle)]">
            {filteredNewSummary.map((row) => (
              <div
                key={row.label}
                className="flex items-center justify-between gap-4 px-3.5 py-2"
              >
                <dt className="shrink-0 text-xs text-[var(--fm-text-muted)]">
                  {row.label}
                </dt>
                <dd className="m-0 text-right font-mono text-xs tabular-nums text-[var(--fm-text-primary)]">
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ) : (
        <span className="sr-only">Mesh Build Confirmation</span>
      )}

      {/* Compact subtle command metadata line */}
      <p className="m-0 px-0.5 font-mono text-xs tabular-nums text-[var(--fm-text-muted)]">
        {commandId ?? "mesh.build"} · {targetLabel}
      </p>

      {/* Inline footer fallback when rendered standalone outside DialogFooter */}
      {!hideFooter ? (
        <div className="mt-1 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--fm-border-subtle)] pt-3.5">
          <MeshBuildConfirmFooter
            mode={mode}
            ready={ready}
            stale={stale}
            onApplyBuild={onApplyBuild}
            onCancel={onCancel}
            onOpenMeshJobs={onOpenMeshJobs}
            onRefresh={onRefresh}
            onResumeObservation={onResumeObservation}
          />
        </div>
      ) : null}
    </div>
  );
}

function MeshBuildPostBuildSummary({
  rows,
}: {
  rows: readonly MeshBuildSnapshotRow[];
}) {
  const visibleRows = rows.filter(
    (row) => row.currentValue !== "unknown" || row.nextValue !== "unknown",
  );

  return (
    <section
      aria-label="Mesh build result summary"
      className="fm-mesh-build-confirm__section"
    >
      <h3 className="fm-mesh-build-confirm__section-title">Build Result Summary</h3>
      {visibleRows.length === 0 ? (
        <p className="fm-mesh-build-confirm__empty">
          Mesh resources were published. Detailed metrics are not available.
        </p>
      ) : (
        <table className="fm-mesh-build-confirm__diff fm-mesh-build-confirm__diff--summary">
          <thead>
            <tr className="fm-mesh-build-confirm__diff-row fm-mesh-build-confirm__diff-row--header">
              <th scope="col">Metric</th>
              <th scope="col">Current</th>
              <th scope="col">New</th>
              <th scope="col">Group</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => {
              const hasChanged = row.currentValue !== row.nextValue;
              return (
                <tr
                  key={row.id}
                  className="fm-mesh-build-confirm__diff-row"
                  data-state={hasChanged ? "changed" : "unchanged"}
                >
                  <td className="fm-mesh-build-confirm__metric">{row.label}</td>
                  <td>{row.currentValue}</td>
                  <td
                    className={
                      hasChanged ? "fm-mesh-build-confirm__metric--changed" : ""
                    }
                  >
                    {row.nextValue}
                  </td>
                  <td className="fm-mesh-build-confirm__metric-group">
                    {row.group}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
