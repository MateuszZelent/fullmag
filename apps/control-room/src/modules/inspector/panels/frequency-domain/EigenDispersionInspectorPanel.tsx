"use client";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { useKernel } from "@/kernel/KernelContext";
import {
  buildEigenBranchSelectionRef,
  buildEigenDispersionPointSelectionRef,
  type EigenBranch,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import type { EigenDispersionPoint } from "@/shared/domain/analysis/frequencyDomainChartModels";
import { formatFrequencyHz } from "@/shared/domain/analysis/frequencyUnits";
import { FrequencyDomainDispersionChart } from "../FrequencyDomainCharts";
import { FrequencyDomainBranchTable } from "../FrequencyDomainTables";
import { ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH } from "@/kernel/api/apiPaths";
import {
  buildEigenDispersionPointViewModel,
  useEigenDispersionInspectorSummary,
} from "./EigenDispersionInspectorModel";

export function EigenDispersionInspectorPanel({
  selection,
}: InspectorPanelProps) {
  const kernel = useKernel();
  const summary = useEigenDispersionInspectorSummary();
  const selectedPoint = selectedDispersionPoint(selection, summary.dispersionModel.points);
  const selectedPointModel = selectedPoint
    ? buildEigenDispersionPointViewModel(selectedPoint)
    : null;

  const selectPoint = (point: EigenDispersionPoint): void => {
    const ref = buildEigenDispersionPointSelectionRef(point, {
      calculationMode: "dispersion_modal",
      resourceRef: ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH,
    });
    kernel.selection.set(
      {
        kind: ref.kind,
        label: dispersionPointLabel(point),
        nodeId: ref.nodeId,
        objectId: null,
        ref,
      },
      "inspector",
    );
  };
  const selectBranch = (branch: EigenBranch): void => {
    const ref = buildEigenBranchSelectionRef(branch);
    kernel.selection.set(
      {
        kind: ref.kind,
        label: branch.label ?? `Branch ${branch.branchId}`,
        nodeId: ref.nodeId,
        objectId: null,
        ref,
      },
      "inspector",
    );
  };

  return (
    <div
      data-inspector-owner="frequency-domain.eigen-dispersion"
      data-inspector-surface="eigen-dispersion"
    >
      <InspectorGroup title="Eigen Dispersion Inspector" badge={summary.badge}>
        <FieldRow label="Canonical workflow" value="dispersion_modal -> StudyIR::Eigenmodes" />
        <FieldRow label="Dispersion resource" value={summary.dispersionResource} />
        <FieldRow label="Path metadata artifact" value={summary.pathMetadataArtifact} />
        <FieldRow label="Path sampling" value={summary.pathSampling} />
        <FieldRow label="Path labels" value={summary.pathLabels} />
        <FieldRow label="Frequency range" value={summary.frequencyRange} />
        <FieldRow label="k-path span" value={summary.kPathSpan} />
        <FieldRow
          label="Branch tracking"
          value={`${summary.branchCount} branch(es), ${summary.trackedPointCount} tracked point(s)`}
        />
        <FieldRow label="Analytic reference" value={summary.analyticReference} />
        <FieldRow label="Validation intent" value={summary.validationIntent} />
        <FieldRow label="Floquet gate" value={summary.floquetGate} />
        <FieldRow label="Capability summary" value={summary.capabilitySummary} />
      </InspectorGroup>
      <InspectorGroup
        title="Selected Dispersion Point"
        badge={selectedPoint ? dispersionPointLabel(selectedPoint) : "not selected"}
      >
        <FieldRow
          label="Point identity"
          value={selectedPoint ? dispersionPointLabel(selectedPoint) : "not selected"}
        />
        <FieldRow
          label="k-path coordinate"
          value={selectedPointModel ? `${formatNumber(selectedPointModel.pathCoordinate)} ${selectedPointModel.pathUnit}` : "not selected"}
        />
        <FieldRow
          label="Frequency"
          value={selectedPointModel ? formatFrequencyHz(selectedPointModel.frequencyHz) : "not selected"}
        />
        <FieldRow
          label="Linewidth (FWHM)"
          value={selectedPointModel ? formatFrequencyHz(selectedPointModel.linewidthHz) : "not selected"}
        />
        <FieldRow
          label="Residual"
          value={selectedPoint ? formatNumberOrUnavailable(selectedPoint.residualNorm) : "not selected"}
        />
        <FieldRow
          label="Branch provenance"
          value={selectedPointModel?.branchId ?? "not available"}
        />
        <FieldRow
          label="Mode field"
          value={selectedPointModel ? (selectedPointModel.fieldAvailable ? "available" : "missing") : "not selected"}
        />
        <FieldRow
          label="Validation warning"
          value={selectedPoint ? dispersionPointWarning(selectedPoint) : "not selected"}
        />
      </InspectorGroup>
      <InspectorGroup title="Dispersion Chart" badge={summary.badge}>
        <FrequencyDomainDispersionChart
          model={summary.dispersionModel}
          onSelectPoint={selectPoint}
        />
      </InspectorGroup>
      <InspectorGroup
        title="Dispersion Branch Table"
        badge={`${summary.branchCount} branch(es)`}
      >
        <FrequencyDomainBranchTable
          branches={summary.branchesModel.branches}
          onSelectBranch={selectBranch}
        />
      </InspectorGroup>
    </div>
  );
}

function selectedDispersionPoint(
  selection: InspectorPanelProps["selection"],
  points: readonly EigenDispersionPoint[],
): EigenDispersionPoint | null {
  if (selection.kind !== "results.eigen.dispersion") return null;
  const ref = selection.ref?.type === "frequency-domain" ? selection.ref : null;
  if (ref?.sampleIndex == null || ref.modeIndex == null) return null;
  return (
    points.find(
      (point) =>
        point.sampleIndex === ref.sampleIndex &&
        point.rawModeIndex === ref.modeIndex,
    ) ?? null
  );
}

function dispersionPointLabel(point: EigenDispersionPoint): string {
  const sample = `sample ${point.sampleIndex}`;
  const mode = `mode ${point.rawModeIndex}`;
  return point.sampleLabel ? `${point.sampleLabel} ${sample}, ${mode}` : `${sample}, ${mode}`;
}

function dispersionPointWarning(point: EigenDispersionPoint): string {
  const warnings = [
    point.relativeError == null
      ? null
      : `analytic rel. error ${formatNumber(point.relativeError)}`,
    point.overlap == null ? null : `overlap ${formatNumber(point.overlap)}`,
    point.validationGeometry == null ? null : point.validationGeometry,
  ].filter((value): value is string => Boolean(value));
  return warnings.length > 0 ? warnings.join("; ") : "none reported";
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "not available";
  return Number.isInteger(value) ? String(value) : value.toPrecision(4);
}

function formatNumberOrUnavailable(value: number | null): string {
  return value == null ? "not available" : formatNumber(value);
}
