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

function formatBounds(
  bounds: { min: [number, number, number]; max: [number, number, number] } | null | undefined,
): string {
  if (!bounds) return "Extent derived from scene bounding box";
  const fmt = (v: number) => {
    const abs = Math.abs(v);
    if (abs >= 1e-3 && abs < 1) return `${(v * 1e3).toFixed(2)} mm`;
    if (abs >= 1e-6 && abs < 1e-3) return `${(v * 1e6).toFixed(2)} µm`;
    if (abs > 0 && abs < 1e-6) return `${(v * 1e9).toFixed(2)} nm`;
    return `${v.toFixed(3)} m`;
  };
  return `[${bounds.min.map(fmt).join(", ")}] to [${bounds.max.map(fmt).join(", ")}]`;
}

function formatShape(shape: [number, number, number] | null | undefined): string {
  if (!shape) return "Materialized upon build";
  return `${shape[0]} × ${shape[1]} × ${shape[2]}`;
}

function formatSpacing(spacing: [number, number, number] | null | undefined): string {
  if (!spacing) return "Derived from domain configuration";
  const fmt = (v: number) => {
    const abs = Math.abs(v);
    if (abs >= 1e-3 && abs < 1) return `${(v * 1e3).toFixed(2)} mm`;
    if (abs >= 1e-6 && abs < 1e-3) return `${(v * 1e6).toFixed(2)} µm`;
    if (abs > 0 && abs < 1e-6) return `${(v * 1e9).toFixed(2)} nm`;
    return `${v.toExponential(2)} m`;
  };
  return `[${spacing.map(fmt).join(", ")}]`;
}

export function FdmGridBuildConfirmContent({
  commandId,
  commandStatus,
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
    phase === "submitting" ? "Rebuilding grid in progress…" : "Build Grid & Materialize Masks";

  return (
    <div className="fm-mesh-build-confirm" data-fdm-grid-build-phase={phase}>
      <section className="fm-mesh-build-confirm__section" aria-label="Structured grid build target">
        <h3 className="fm-mesh-build-confirm__section-title">FDM Structured Grid & Mask Refresh</h3>
        <dl className="fm-dialog__details">
          <div className="fm-dialog__details-row">
            <dt className="fm-dialog__details-label">Target</dt>
            <dd className="fm-dialog__details-value">Committed scene geometry & magnetic support</dd>
          </div>
          <div className="fm-dialog__details-row">
            <dt className="fm-dialog__details-label">Command</dt>
            <dd className="fm-dialog__details-value">{commandId ?? "grid.build-fdm"}</dd>
          </div>
          <div className="fm-dialog__details-row">
            <dt className="fm-dialog__details-label">Command state</dt>
            <dd className="fm-dialog__details-value">{commandStatus}</dd>
          </div>
        </dl>
      </section>

      {(phase === "error" || phase === "waiting") && errorMessage ? (
        <section
          aria-label="Grid build error"
          className="fm-mesh-build-confirm__section fm-mesh-build-confirm__banner fm-mesh-build-confirm__banner--error"
        >
          <h3 className="fm-mesh-build-confirm__section-title">
            {phase === "error" ? "Build Error" : "Observation paused"}
          </h3>
          <p className="fm-mesh-build-confirm__empty">{errorMessage}</p>
        </section>
      ) : null}

      {phase === "post-build" ? (
        <section aria-label="Grid build completed" className="fm-mesh-build-confirm__section fm-mesh-build-confirm__banner">
          <h3 className="fm-mesh-build-confirm__section-title">Grid & Masks Materialized</h3>
          <p className="fm-mesh-build-confirm__empty">
            {rendered
              ? "Published grid dimensions and membership masks rendered in the viewport."
              : "New grid revision published. Viewport update complete."}
          </p>
        </section>
      ) : null}

      {!ready && phase === "pre-build" ? (
        <p className="fm-mesh-build-confirm__empty">
          {stale
            ? "The model changed after this confirmation was prepared. Review an updated preflight."
            : "Loading current scene geometry baseline…"}
        </p>
      ) : null}

      <section className="fm-mesh-build-confirm__section" aria-label="Source scene geometry">
        <h3 className="fm-mesh-build-confirm__section-title">Committed Scene Geometry</h3>
        <dl className="fm-dialog__details">
          <div className="fm-dialog__details-row">
            <dt className="fm-dialog__details-label">Scene revision</dt>
            <dd className="fm-dialog__details-value">
              {sceneRevision != null ? `Revision ${sceneRevision}` : "loading"}
            </dd>
          </div>
          <div className="fm-dialog__details-row">
            <dt className="fm-dialog__details-label">Authored objects</dt>
            <dd className="fm-dialog__details-value">
              {objectsCount} {objectsCount === 1 ? "object" : "objects"}
            </dd>
          </div>
          <div className="fm-dialog__details-row">
            <dt className="fm-dialog__details-label">Geometry extents</dt>
            <dd className="fm-dialog__details-value font-mono">{formatBounds(geometryBounds)}</dd>
          </div>
        </dl>
      </section>

      <section className="fm-mesh-build-confirm__section" aria-label="FDM grid resolution & dimensions">
        <h3 className="fm-mesh-build-confirm__section-title">FDM Grid & Discretization</h3>
        <dl className="fm-dialog__details">
          <div className="fm-dialog__details-row">
            <dt className="fm-dialog__details-label">Cell size (Δx, Δy, Δz)</dt>
            <dd className="fm-dialog__details-value font-mono">{formatSpacing(gridSpacing)}</dd>
          </div>
          <div className="fm-dialog__details-row">
            <dt className="fm-dialog__details-label">Grid dimensions (Nx, Ny, Nz)</dt>
            <dd className="fm-dialog__details-value font-mono">{formatShape(gridShape)}</dd>
          </div>
          <div className="fm-dialog__details-row">
            <dt className="fm-dialog__details-label">Total grid cells</dt>
            <dd className="fm-dialog__details-value">
              {totalCells != null ? totalCells.toLocaleString("en-US") : "Calculated upon build"}
            </dd>
          </div>
          <div className="fm-dialog__details-row">
            <dt className="fm-dialog__details-label">Estimated mask memory</dt>
            <dd className="fm-dialog__details-value">
              {gridMemoryMB != null ? `${gridMemoryMB.toFixed(2)} MB` : "Calculated upon build"}
            </dd>
          </div>
          {membershipRevision != null ? (
            <div className="fm-dialog__details-row">
              <dt className="fm-dialog__details-label">Current mask revision</dt>
              <dd className="fm-dialog__details-value">{membershipRevision}</dd>
            </div>
          ) : null}
        </dl>
      </section>

      <div className="fm-mesh-build-confirm__actions">
        <Button size="sm" type="button" variant="ghost" onClick={onCancel}>
          {phase === "pre-build" ? "Cancel" : "Close"}
        </Button>
        {onOpenMeshOverview ? (
          <Button size="sm" type="button" variant="secondary" onClick={onOpenMeshOverview}>
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
            {buildButtonLabel}
          </Button>
        )}
      </div>
    </div>
  );
}
