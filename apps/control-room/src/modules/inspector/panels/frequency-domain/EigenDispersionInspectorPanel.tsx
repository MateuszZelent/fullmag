"use client";

import { GitBranch, History, LineChart, Scale, Target, Waves } from "lucide-react";
import type { InspectorPanelProps } from "../../inspectorTypes";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorOverviewFrame } from "../../primitives/InspectorOverviewFrame";
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
      {/* Shared Results Inspector recipe (spec 32 §12): metrics, one primary card, nav sections. */}
      <InspectorOverviewFrame
        metrics={[
          { label: "Points", value: summary.badge, tone: summary.dispersionPointCount > 0 ? "success" : "neutral" },
          { label: "Branches", value: String(summary.branchCount), tone: "neutral" },
          {
            label: "Comparison",
            value: summary.referenceComparisonStatus.replaceAll("_", " "),
            tone: summary.referenceComparisonStatus === "matching"
              ? "success"
              : summary.referenceComparisonStatus === "no_data"
                ? "neutral"
                : "warning",
          },
          { label: "Selected", value: selectedPoint ? dispersionPointLabel(selectedPoint) : "none", tone: selectedPoint ? "success" : "neutral" },
        ]}
        primary={
          <>
            <FieldRow label="Frequency range" value={summary.frequencyRange} />
            <FieldRow label="k-path span" value={summary.kPathSpan} />
            <FieldRow label="Path sampling" value={summary.pathSampling} />
            <FieldRow label="Path labels" value={summary.pathLabels} />
            <FieldRow
              label="Branch tracking"
              value={`${summary.branchCount} branch(es), ${summary.trackedPointCount} tracked point(s)`}
            />
          </>
        }
        primaryIcon={<Waves size={18} strokeWidth={1.5} />}
        primaryTitle="Dispersion relation"
        sections={[
          {
            id: "reference",
            defaultOpen: true,
            title: "Reference & comparison",
            icon: <Scale size={16} strokeWidth={1.5} />,
            summary: summary.referenceComparisonStatus.replaceAll("_", " "),
            content: (
              <>
                <FieldRow label="Analytic reference" value={summary.analyticReference} />
                <FieldRow label="Comparison status" value={summary.referenceComparison} />
                <FieldRow label="Validation intent" value={summary.validationIntent} />
              </>
            ),
          },
          {
            id: "selected-point",
            defaultOpen: true,
            title: "Selected Dispersion Point",
            icon: <Target size={16} strokeWidth={1.5} />,
            summary: selectedPoint ? dispersionPointLabel(selectedPoint) : "not selected",
            content: (
              <>
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
              </>
            ),
          },
          {
            id: "chart",
            defaultOpen: true,
            title: "Dispersion Chart",
            icon: <LineChart size={16} strokeWidth={1.5} />,
            summary: summary.badge,
            content: (
              <FrequencyDomainDispersionChart
                model={summary.dispersionModel}
                onSelectPoint={selectPoint}
              />
            ),
          },
          {
            id: "branches",
            defaultOpen: true,
            title: "Dispersion Branch Table",
            icon: <GitBranch size={16} strokeWidth={1.5} />,
            summary: `${summary.branchCount} branch(es)`,
            content: (
              <FrequencyDomainBranchTable
                branches={summary.branchesModel.branches}
                onSelectBranch={selectBranch}
              />
            ),
          },
          {
            id: "provenance",
            title: "Provenance & capabilities",
            icon: <History size={16} strokeWidth={1.5} />,
            summary: "Eigen Dispersion Inspector",
            defaultOpen: false,
            content: (
              <>
                <FieldRow label="Canonical workflow" value="dispersion_modal -> StudyIR::Eigenmodes" />
                <FieldRow label="Dispersion resource" value={summary.dispersionResource} />
                <FieldRow label="Path metadata artifact" value={summary.pathMetadataArtifact} />
                <FieldRow label="Floquet gate" value={summary.floquetGate} />
                <FieldRow label="Capability summary" value={summary.capabilitySummary} />
              </>
            ),
          },
        ]}
      />
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
