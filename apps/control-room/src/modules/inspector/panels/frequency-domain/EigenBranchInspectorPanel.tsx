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
  buildEigenBranchesModel,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import type {
  EigenBranch,
  EigenBranchPoint,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import { formatFrequencyHz, formatFrequencyRangeHz } from "@/shared/domain/analysis/frequencyUnits";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import {
  branchIdFromNodeId,
  branchSamplesCsv,
  buildEigenBranchModeOpenSelectionRef,
  buildEigenBranchModePlotHandoff,
  buildEigenBranchPointViewModel,
  buildEigenBranchResultManifestOwner,
  hasReadyOrRetainedSnapshot,
  selectedDatasetIdentity,
} from "./EigenBranchInspectorModel";
import type {
  EigenBranchModePlotHandoff,
  EigenBranchResultManifestOwner,
  FrequencyDomainDatasetIdentity,
} from "./EigenBranchInspectorModel";

export function EigenBranchInspectorPanel({
  selection,
}: InspectorPanelProps) {
  const summary = useEigenBranchSummary(selection);
  const datasetIdentity = selectedDatasetIdentity(selection);

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
          datasetIdentity={datasetIdentity}
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
  datasetIdentity,
  manifestOwner,
  manifestStatus,
  resourceStatus,
}: {
  artifact: FrequencyDomainJsonArtifactResource | null;
  branch: EigenBranch | null;
  datasetIdentity: FrequencyDomainDatasetIdentity;
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
  const openMode = (
    point: EigenBranchPoint,
    modeRef: Extract<SelectionRef, { type: "frequency-domain" }>,
  ): void => {
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
              datasetIdentity,
            );
            const openModeRef =
              handoff?.selectionRef ??
              buildEigenBranchModeOpenSelectionRef(
                branch.branchId,
                point,
                resourceStatus,
                artifact,
                manifestStatus,
                manifestOwner,
                datasetIdentity,
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
                    disabled={!openModeRef}
                    size="sm"
                    title={
                      openModeRef
                        ? `Open sample ${point.sampleIndex} mode ${point.rawModeIndex}`
                        : "Current eigen-mode result owner identity is unavailable"
                    }
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      if (openModeRef) openMode(point, openModeRef);
                    }}
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

