import { Button } from "@/shared/ui/Button";
import type { MeshBuildSnapshotRow } from "@/shared/domain/mesh/meshBuildSnapshots";
import type { MeshPolicyDiffRow } from "@/shared/domain/mesh/meshPolicyDiff";

import { MeshBuildParameterDiff } from "./MeshBuildParameterDiff";

export interface MeshBuildSummaryRow {
  label: string;
  value: string;
}

export function MeshBuildConfirmDialogContent({
  commandId,
  commandStatus,
  currentSummary,
  diffRows,
  errorMessage,
  mode,
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
  mode?: "pre-build" | "submitting" | "post-build" | "error";
  newSummary?: readonly MeshBuildSummaryRow[];
  onApplyBuild: () => void;
  onCancel: () => void;
  onOpenMeshJobs: () => void;
  postBuildRows?: readonly MeshBuildSnapshotRow[];
  targetLabel: string;
}) {
  const phase = mode ?? "pre-build";
  const buildButtonLabel =
    phase === "submitting" ? "Submitting..." : "Accept & Build";

  return (
    <div className="fm-mesh-build-confirm">
      <section className="fm-mesh-build-confirm__section" aria-label="Mesh build target">
        <h3 className="fm-mesh-build-confirm__section-title">Mesh Build Confirmation</h3>
        <dl className="fm-dialog__details">
          <div className="fm-dialog__details-row">
            <dt className="fm-dialog__details-label">Target</dt>
            <dd className="fm-dialog__details-value">{targetLabel}</dd>
          </div>
          <div className="fm-dialog__details-row">
            <dt className="fm-dialog__details-label">Command</dt>
            <dd className="fm-dialog__details-value">{commandId ?? "none"}</dd>
          </div>
          <div className="fm-dialog__details-row">
            <dt className="fm-dialog__details-label">Command state</dt>
            <dd className="fm-dialog__details-value">{commandStatus}</dd>
          </div>
        </dl>
      </section>

      {phase === "error" && errorMessage ? (
        <section
          className="fm-mesh-build-confirm__section fm-mesh-build-confirm__banner fm-mesh-build-confirm__banner--error"
          aria-label="Mesh build error"
        >
          <h3 className="fm-mesh-build-confirm__section-title">Build Error</h3>
          <p className="fm-mesh-build-confirm__empty">{errorMessage}</p>
        </section>
      ) : null}

      {phase === "post-build" ? (
        <MeshBuildPostBuildSummary rows={postBuildRows ?? []} />
      ) : null}

      <MeshBuildParameterDiff rows={diffRows} />

      <section className="fm-mesh-build-confirm__section" aria-label="Current mesh summary">
        <h3 className="fm-mesh-build-confirm__section-title">Current Mesh Summary</h3>
        <dl className="fm-dialog__details">
          {currentSummary.map((row) => (
            <div className="fm-dialog__details-row" key={row.label}>
              <dt className="fm-dialog__details-label">{row.label}</dt>
              <dd className="fm-dialog__details-value">{row.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="fm-mesh-build-confirm__section" aria-label="New mesh request">
        <h3 className="fm-mesh-build-confirm__section-title">New Mesh Request</h3>
        <dl className="fm-dialog__details">
          {(newSummary ?? []).map((row) => (
            <div className="fm-dialog__details-row" key={row.label}>
              <dt className="fm-dialog__details-label">{row.label}</dt>
              <dd className="fm-dialog__details-value">{row.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <div className="fm-mesh-build-confirm__actions">
        <Button size="sm" type="button" variant="ghost" onClick={onCancel}>
          {phase === "post-build" ? "Close" : "Cancel"}
        </Button>
        <Button size="sm" type="button" variant="secondary" onClick={onOpenMeshJobs}>
          Open Mesh Jobs
        </Button>
        {phase === "post-build" ? null : (
          <Button
            disabled={phase === "submitting"}
            size="sm"
            type="button"
            variant="primary"
            onClick={onApplyBuild}
          >
            {buildButtonLabel}
          </Button>
        )}
      </div>
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
      className="fm-mesh-build-confirm__section"
      aria-label="Mesh build result summary"
    >
      <h3 className="fm-mesh-build-confirm__section-title">Build Result Summary</h3>
      {visibleRows.length === 0 ? (
        <p className="fm-mesh-build-confirm__empty">
          Mesh resources were published and rendered by the viewport.
        </p>
      ) : (
        <div
          className="fm-mesh-build-confirm__diff fm-mesh-build-confirm__diff--summary"
          role="table"
        >
          <div
            className="fm-mesh-build-confirm__diff-row fm-mesh-build-confirm__diff-row--header"
            role="row"
          >
            <span role="columnheader">Metric</span>
            <span role="columnheader">Current</span>
            <span role="columnheader">New</span>
            <span role="columnheader">Group</span>
          </div>
          {visibleRows.map((row) => (
            <div className="fm-mesh-build-confirm__diff-row" key={row.id} role="row">
              <span role="cell">{row.label}</span>
              <span role="cell">{row.currentValue}</span>
              <span role="cell">{row.nextValue}</span>
              <span role="cell">{row.group}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
