"use client";

import { Activity, Download, Eye } from "lucide-react";

import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import { ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH } from "@/kernel/api/apiPaths";
import type { FrequencyDomainJsonArtifactResource } from "@/kernel/api/apiTypes";
import type { SelectionRef } from "@/kernel/selection/selectionTypes";
import {
  useFrequencyDomainEigenBranchesResource,
  useFrequencyDomainEigenDispersionResource,
  useFrequencyDomainManifestResource,
} from "@/kernel/resources/studyRuntimeResources";
import {
  buildEigenBranchDetailChartModel,
  buildEigenBranchPointModeSelectionRef,
  buildEigenBranchesModel,
  eigenModeFieldAvailable,
  frequencyDomainManifestPayload,
  frequencyDomainResultContextFromManifest,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import type {
  EigenBranch,
  EigenBranchPoint,
  FrequencyDomainResultContext,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import { formatFrequencyHz, formatFrequencyRangeHz } from "@/shared/domain/analysis/frequencyUnits";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";

export interface EigenBranchPointViewModel {
  branchId: string;
  fieldAvailable: boolean;
  frequencyHz: number;
  modeIndex: number;
  pointId: string;
  sampleIndex: number;
}

export interface EigenBranchModePlotHandoff {
  commandInput: Record<string, unknown>;
  selectionRef: Extract<SelectionRef, { type: "frequency-domain" }> & {
    frequencyHz: number;
    representation: "complex-vector-xyz";
  };
}

const EIGEN_MODE_FIELD_REPRESENTATION = "complex-vector-xyz" as const;
const EIGEN_MODE_FIELD_VIEW = "phase_rotated_real" as const;

export interface EigenBranchResultManifestOwner {
  artifactSetId: string;
  resultContext: FrequencyDomainResultContext;
  runId: string;
  sessionId: string;
  stageId: string;
}

export function buildEigenBranchResultManifestOwner(
  manifestResource: unknown,
): EigenBranchResultManifestOwner | null {
  const resultManifest = record(record(manifestResource)?.result_manifest);
  const payload = record(frequencyDomainManifestPayload(manifestResource));
  const sessionId = resultManifest?.session_id;
  const artifactSetId = resultManifest?.artifact_set_id;
  const runId = resultManifest?.run_id;
  const stageId = resultManifest?.stage_id;
  if (
    resultManifest?.status !== "ready" ||
    !payload ||
    !isNonEmptyString(sessionId) ||
    !isNonEmptyString(artifactSetId) ||
    !isNonEmptyString(runId) ||
    !isNonEmptyString(stageId)
  ) {
    return null;
  }

  return {
    artifactSetId,
    resultContext: frequencyDomainResultContextFromManifest({
      ...payload,
      // The owned resource envelope is authoritative over legacy payload placeholders.
      run_id: runId,
      stage_id: stageId,
    }),
    runId,
    sessionId,
    stageId,
  };
}

export function buildEigenBranchModePlotHandoff(
  branchId: string,
  point: EigenBranchPoint,
  resourceStatus: string,
  artifact: FrequencyDomainJsonArtifactResource | null | undefined,
  manifestStatus: string,
  manifestOwner: EigenBranchResultManifestOwner | null,
): EigenBranchModePlotHandoff | null {
  const sessionId = artifact?.session_id;
  const artifactSetId = artifact?.artifact_set_id;
  const runId = artifact?.run_id;
  const stageId = artifact?.stage_id;
  const artifactRevision = artifact?.revision;
  const artifactPath = artifact?.artifact_path;
  const resourceRef = point.modeFieldResourceKey;
  const manifestContext = manifestOwner?.resultContext;
  const equilibriumId = manifestContext?.equilibriumId;
  const kContextKind = manifestContext?.classification?.kContext.kind;
  const studyProduct = manifestContext?.studyProduct;
  const wavevectorKf = point.wavevectorKf;
  if (
    !hasReadyOrRetainedSnapshot(resourceStatus) ||
    artifact?.status !== "ready" ||
    !hasReadyOrRetainedSnapshot(manifestStatus) ||
    !eigenModeFieldAvailable(point) ||
    !isNonEmptyString(sessionId) ||
    !isNonEmptyString(artifactSetId) ||
    !isNonEmptyString(runId) ||
    !isNonEmptyString(stageId) ||
    !isNonEmptyString(artifactRevision) ||
    !isNonEmptyString(artifactPath) ||
    !manifestOwner ||
    !manifestContext ||
    manifestOwner.sessionId !== sessionId ||
    manifestOwner.artifactSetId !== artifactSetId ||
    manifestOwner.runId !== runId ||
    manifestOwner.stageId !== stageId ||
    manifestContext.runId !== runId ||
    manifestContext.stageId !== stageId ||
    studyProduct !== "modal_eigen" ||
    !isNonEmptyString(equilibriumId) ||
    !kContextKind ||
    !isNonEmptyString(resourceRef) ||
    !isNonEmptyString(point.modeId) ||
    !isNonEmptyString(point.sampleId) ||
    !isNonNegativeInteger(point.sampleIndex) ||
    !isNonNegativeInteger(point.rawModeIndex) ||
    !Number.isFinite(point.frequencyRealHz)
  ) {
    return null;
  }
  if (
    (kContextKind === "fixed_k" ||
      kContextKind === "k_path" ||
      kContextKind === "k_grid") &&
    !isFiniteVector3(wavevectorKf)
  ) {
    return null;
  }
  if (
    kContextKind === "k_path" &&
    (point.pathS == null || !Number.isFinite(point.pathS))
  ) {
    return null;
  }
  if (
    kContextKind === "fixed_k" &&
    wavevectorKf?.every((component) => component === 0)
  ) {
    return null;
  }
  if (
    kContextKind === "gamma" &&
    wavevectorKf?.some((component) => Math.abs(component) > 1e-12)
  ) {
    return null;
  }

  const selectionRef = buildEigenBranchPointModeSelectionRef(
    branchId,
    point,
    {
      analysisRunId: runId,
      analysisStageId: stageId,
      artifactPath,
      artifactRevision,
      equilibriumId,
      kContextKind,
      normalization: manifestContext.normalization,
      representation: EIGEN_MODE_FIELD_REPRESENTATION,
      resourceRef,
      studyProduct,
    },
  );
  if (selectionRef.type !== "frequency-domain" || !selectionRef.fieldId) {
    return null;
  }

  return {
    commandInput: {
      artifactRevision,
      fieldId: selectionRef.fieldId,
      frequencyHz: point.frequencyRealHz,
      equilibriumId,
      kContextKind,
      kPathCoordinateRadPerM: point.pathS ?? undefined,
      label: `sample ${point.sampleIndex}, mode ${point.rawModeIndex}`,
      modeIndex: point.rawModeIndex,
      phaseRad: 0,
      representation: EIGEN_MODE_FIELD_REPRESENTATION,
      resourceRef,
      runId,
      sampleIndex: point.sampleIndex,
      source: "eigen-mode",
      stageId,
      studyProduct,
      normalization: manifestContext.normalization ?? undefined,
      view: EIGEN_MODE_FIELD_VIEW,
      wavevectorKf,
    },
    selectionRef: {
      ...selectionRef,
      frequencyHz: point.frequencyRealHz,
      representation: EIGEN_MODE_FIELD_REPRESENTATION,
    },
  };
}

export function buildEigenBranchPointViewModel(
  branchId: string,
  point: EigenBranchPoint,
): EigenBranchPointViewModel {
  return {
    branchId,
    fieldAvailable: eigenModeFieldAvailable(point),
    frequencyHz: point.frequencyRealHz,
    modeIndex: point.rawModeIndex,
    pointId: `results:eigen:branch:${branchId}:sample:${point.sampleIndex}:mode:${point.rawModeIndex}`,
    sampleIndex: point.sampleIndex,
  };
}

export function EigenBranchInspectorPanel({
  selection,
}: InspectorPanelProps) {
  const summary = useEigenBranchSummary(selection);

  return (
    <div
      data-inspector-owner="frequency-domain.eigen-branch"
      data-inspector-surface="eigen-branch-detail"
    >
      <InspectorGroup title="Eigen Branch Detail" badge={summary.badge}>
        <FieldRow label="Branch identity" value={summary.branchIdentity} />
        <FieldRow label="Branch resource" value={summary.branchResource} />
        <FieldRow label="Frequency range" value={summary.frequencyRange} />
        <FieldRow label="Tracked points" value={summary.trackedPoints} />
        <FieldRow label="Continuity" value={summary.continuity} />
        <FieldRow label="Representative mode" value={summary.representativeMode} />
        <FieldRow label="3D handoff" value={summary.handoff} />
      </InspectorGroup>
      <InspectorGroup
        title="Branch Continuity Charts"
        badge={summary.chartBadge}
      >
        <BranchContinuityCharts branch={summary.branch} />
      </InspectorGroup>
      <InspectorGroup
        title="Tracked Branch Samples"
        badge={summary.sampleTableBadge}
      >
        <BranchSampleTable
          artifact={summary.branchArtifact}
          branch={summary.branch}
          manifestOwner={summary.manifestOwner}
          manifestStatus={summary.manifestStatus}
          resourceStatus={summary.branchArtifactStatus}
        />
      </InspectorGroup>
    </div>
  );
}

function BranchContinuityCharts({ branch }: { branch: EigenBranch | null }) {
  const chartModel = buildEigenBranchDetailChartModel(branch);

  if (!branch || chartModel.frequencySeries.length === 0) {
    return (
      <div className="fm-frequency-domain-chart__empty" role="status">
        No branch continuity samples available.
      </div>
    );
  }

  return (
    <div className="fm-frequency-domain-branch-charts">
      <div
        aria-label="Frequency-domain branch frequency chart"
        className="fm-frequency-domain-chart"
        data-renderer="summary"
      >
        <div className="fm-frequency-domain-chart__header">
          <span>Frequency vs sample</span>
          <small>{formatFrequencyRange(chartModel.frequencySeries.map((point) => point.valueHz))}</small>
        </div>
        <div className="fm-frequency-domain-chart__canvas" />
        <div className="fm-frequency-domain-chart__summary">
          {chartModel.frequencySeries.map((point) => (
            <span key={`${point.sampleIndex}:${point.label}`}>
              {point.label}: {formatFrequency(point.valueHz)}
            </span>
          ))}
        </div>
      </div>
      <div
        aria-label="Frequency-domain branch overlap chart"
        className="fm-frequency-domain-chart"
        data-renderer="summary"
      >
        <div className="fm-frequency-domain-chart__header">
          <span>Overlap vs sample</span>
          <small>
            {chartModel.overlapSeries.length > 0
              ? `${chartModel.overlapSeries.length} overlap point(s)`
              : "overlap unavailable"}
          </small>
        </div>
        <div className="fm-frequency-domain-chart__canvas" />
        <div className="fm-frequency-domain-chart__summary">
          {chartModel.overlapSeries.length > 0 ? (
            chartModel.overlapSeries.map((point) => (
              <span key={`${point.sampleIndex}:${point.label}`}>
                {point.label}: {formatCompactNumberOrDash(point.value)}
              </span>
            ))
          ) : (
            <span>overlap unavailable for first tracked point</span>
          )}
        </div>
      </div>
    </div>
  );
}

function BranchSampleTable({
  artifact,
  branch,
  manifestOwner,
  manifestStatus,
  resourceStatus,
}: {
  artifact: FrequencyDomainJsonArtifactResource | null;
  branch: EigenBranch | null;
  manifestOwner: EigenBranchResultManifestOwner | null;
  manifestStatus: string;
  resourceStatus: string;
}) {
  const kernel = useKernel();

  if (!branch || branch.points.length === 0) {
    return (
      <div className="fm-frequency-domain-table-empty" role="status">
        No tracked samples available for this branch.
      </div>
    );
  }

  const rows = branch.points.toSorted(
    (left, right) =>
      left.sampleIndex - right.sampleIndex ||
      left.rawModeIndex - right.rawModeIndex,
  );
  const openMode = (point: EigenBranchPoint): void => {
    const modeRef = buildEigenBranchPointModeSelectionRef(
      branch.branchId,
      point,
    );
    kernel.selection.set(
      {
        kind: modeRef.kind,
        label: `sample ${point.sampleIndex}, mode ${point.rawModeIndex}`,
        nodeId: modeRef.nodeId,
        objectId: null,
        ref: modeRef,
      },
      "inspector",
    );
  };
  const plotMode = (
    point: EigenBranchPoint,
    handoff: EigenBranchModePlotHandoff | null,
  ): void => {
    if (!handoff) return;
    kernel.selection.set(
      {
        kind: handoff.selectionRef.kind,
        label: `sample ${point.sampleIndex}, mode ${point.rawModeIndex}`,
        nodeId: handoff.selectionRef.nodeId,
        objectId: null,
        ref: handoff.selectionRef,
      },
      "inspector",
    );
    void kernel.commands.execute(
      "analysis.eigen.plot-mode-3d",
      createCommandContext("inspector", kernel, {
        sourceDetail: "results.eigen.branch",
      }),
      handoff.commandInput,
    );
  };
  const exportBranchCsv = (): void => {
    void navigator.clipboard.writeText(branchSamplesCsv(branch));
  };

  return (
    <div className="fm-frequency-domain-table-wrap">
      <table
        aria-label="Frequency-domain branch sample table"
        className="fm-frequency-domain-table"
      >
        <thead>
          <tr>
            <th>Sample</th>
            <th>Raw mode</th>
            <th>Frequency</th>
            <th>Imag freq.</th>
            <th>Overlap</th>
            <th>Residual</th>
            <th>Mode field</th>
            <th className="fm-frequency-domain-table__actions-heading">
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((point) => {
            const rowModel = buildEigenBranchPointViewModel(branch.branchId, point);
            const hasModeField = rowModel.fieldAvailable;
            const handoff = buildEigenBranchModePlotHandoff(
              branch.branchId,
              point,
              resourceStatus,
              artifact,
              manifestStatus,
              manifestOwner,
            );
            const rowKey = `${point.sampleIndex}:${point.rawModeIndex}`;
            return (
              <tr
                data-status={hasModeField ? "ready" : "missing"}
                key={rowKey}
              >
                <td>{point.sampleIndex}</td>
                <td>{point.rawModeIndex}</td>
                <td>{formatFrequency(point.frequencyRealHz)}</td>
                <td>{formatFrequency(point.frequencyImagHz)}</td>
                <td>{formatCompactNumberOrDash(point.overlapPrev)}</td>
                <td>{formatResidual(point.residualNorm)}</td>
                <td>{hasModeField ? "available" : "missing"}</td>
                <td className="fm-frequency-domain-table__actions">
                  <Button
                    aria-label={`Open sample ${point.sampleIndex} mode ${point.rawModeIndex}`}
                    className="fm-inspector-action-button"
                    size="sm"
                    title={`Open sample ${point.sampleIndex} mode ${point.rawModeIndex}`}
                    type="button"
                    variant="secondary"
                    onClick={() => openMode(point)}
                  >
                    <Eye aria-hidden="true" size={13} />
                    <span>Open mode</span>
                  </Button>
                  <Button
                    aria-label={`Plot sample ${point.sampleIndex} mode ${point.rawModeIndex} in 3D`}
                    className="fm-inspector-action-button"
                    disabled={!handoff}
                    size="sm"
                    title={
                      !hasModeField
                        ? "Mode field artifact is missing"
                        : handoff
                          ? `Plot sample ${point.sampleIndex} mode ${point.rawModeIndex} in 3D`
                          : "Current mode field owner identity is unavailable"
                    }
                    type="button"
                    variant="primary"
                    onClick={() => plotMode(point, handoff)}
                  >
                    <Activity aria-hidden="true" size={13} />
                    <span>Plot 3D</span>
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="fm-frequency-domain-table__actions">
        <Button
          aria-label="Export branch CSV"
          className="fm-inspector-action-button"
          size="sm"
          title="Export branch CSV"
          type="button"
          variant="secondary"
          onClick={exportBranchCsv}
        >
          <Download aria-hidden="true" size={13} />
          <span>Export branch CSV</span>
        </Button>
      </div>
    </div>
  );
}

function branchSamplesCsv(branch: EigenBranch): string {
  const rows = branch.points
    .toSorted(
      (left, right) =>
        left.sampleIndex - right.sampleIndex ||
        left.rawModeIndex - right.rawModeIndex,
    )
    .map((point) =>
      [
        branch.branchId,
        point.sampleIndex,
        point.sampleId ?? `sample-${String(point.sampleIndex).padStart(4, "0")}`,
        point.rawModeIndex,
        point.modeId ??
          `sample-${String(point.sampleIndex).padStart(4, "0")}/mode-${String(point.rawModeIndex).padStart(4, "0")}`,
        point.pathS ?? "",
        point.wavevectorKf?.[0] ?? "",
        point.wavevectorKf?.[1] ?? "",
        point.wavevectorKf?.[2] ?? "",
        point.frequencyRealHz,
        point.frequencyImagHz ?? "",
        point.overlapPrev ?? "",
        point.residualNorm ?? "",
        eigenModeFieldAvailable(point),
        eigenModeFieldAvailable(point)
          ? point.modeFieldId ?? point.modeFieldResourceKey ?? ""
          : "",
      ].join(","),
    );

  return [
    "branch_id,sample_index,sample_id,raw_mode_index,mode_id,path_s_rad_per_m,kx_rad_per_m,ky_rad_per_m,kz_rad_per_m,frequency_real_hz,frequency_imag_hz,overlap_prev,residual_norm,mode_field_available,mode_field",
    ...rows,
  ].join("\n");
}

function useEigenBranchSummary(selection: InspectorPanelProps["selection"]) {
  const ref = selection.ref?.type === "frequency-domain" ? selection.ref : null;
  const branchId = ref?.branchId ?? branchIdFromNodeId(selection.nodeId);
  const manifest = useFrequencyDomainManifestResource();
  const branches = useFrequencyDomainEigenBranchesResource();
  const dispersion = useFrequencyDomainEigenDispersionResource();
  const manifestOwner = hasReadyOrRetainedSnapshot(manifest.status)
    ? buildEigenBranchResultManifestOwner(manifest.data)
    : null;
  const branchesModel = buildEigenBranchesModel(branches.data, dispersion.data);
  const branch =
    branchesModel.branches.find((candidate) => candidate.branchId === branchId) ??
    branchesModel.branches[0] ??
    null;
  const sampleValues = branch?.points.map((point) => point.sampleIndex) ?? [];
  const representativePoint = branch?.points[0] ?? null;

  return {
    badge: branch ? `${branch.points.length} point(s)` : branches.status,
    branchArtifact: branches.data ?? null,
    branchArtifactStatus: branches.status,
    manifestOwner,
    manifestStatus: manifest.status,
    branch,
    branchIdentity: branch
      ? `${branch.branchId}; ${branch.label ?? "unlabeled"}`
      : "not available",
    branchResource: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH,
    chartBadge: branch ? `${branch.points.length} sample(s)` : branches.status,
    continuity: branch
      ? `min overlap ${formatCompactNumberOrUnavailable(branch.overlapPrevMin)}; min confidence ${formatCompactNumberOrUnavailable(branch.trackingConfidenceMin)}`
      : "not available",
    frequencyRange: branch
      ? formatFrequencyRange(branch.points.map((point) => point.frequencyRealHz))
      : "not available",
    handoff: representativePoint
      ? "open representative mode and plot its field payload"
      : "requires mode field metadata",
    representativeMode: representativePoint
      ? `sample ${representativePoint.sampleIndex}, mode ${representativePoint.rawModeIndex}, ${formatFrequency(representativePoint.frequencyRealHz)}`
      : "not available",
    sampleTableBadge: branch ? `${branch.points.length} row(s)` : branches.status,
    trackedPoints:
      branch && sampleValues.length
        ? `${branch.points.length} point(s); samples ${Math.min(
            ...sampleValues,
          )}-${Math.max(...sampleValues)}`
        : "not available",
  };
}

// A stale hook retains its last successful envelope. Availability and owner
// identity are checked separately before creating a plot command.
function hasReadyOrRetainedSnapshot(status: string): boolean {
  return status === "ready" || status === "stale";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function isFiniteVector3(
  value: readonly [number, number, number] | null | undefined,
): value is readonly [number, number, number] {
  return value !== undefined && value !== null && value.every(Number.isFinite);
}

function branchIdFromNodeId(nodeId: string | null): string | null {
  if (!nodeId) return null;
  const marker = ":branch:";
  const markerIndex = nodeId.lastIndexOf(marker);
  return markerIndex >= 0 ? nodeId.slice(markerIndex + marker.length) : null;
}

function formatFrequency(valueHz: number | null | undefined): string {
  return formatFrequencyHz(valueHz);
}

function formatFrequencyRange(valuesHz: readonly number[]): string {
  return formatFrequencyRangeHz(valuesHz);
}

function formatCompactNumberOrUnavailable(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "not available";
  return `${Number(value.toPrecision(6))}`;
}

function formatCompactNumberOrDash(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  return `${Number(value.toPrecision(6))}`;
}

function formatResidual(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  if (value !== 0 && Math.abs(value) < 1e-3) return value.toExponential(2);
  return `${Number(value.toPrecision(6))}`;
}
