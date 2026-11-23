"use client";

import { Box, GitBranch, History, LineChart, Pin, Scale, Target, Waves } from "lucide-react";
import type { InspectorPanelProps } from "../../inspectorTypes";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorOverviewFrame } from "../../primitives/InspectorOverviewFrame";
import { PIN_MODE_VISUALIZATION_COMMAND } from "@/kernel/analysis-modules/postprocessingCommandContributions";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { buildEigenBranchSelectionRef, buildEigenDispersionPointSelectionRef, eigenModeFieldAvailable, type EigenBranch } from "@/shared/domain/analysis/frequencyDomainChartModels";
import type { EigenDispersionPoint } from "@/shared/domain/analysis/frequencyDomainChartModels";
import { formatFrequencyHz } from "@/shared/domain/analysis/frequencyUnits";
import { Button } from "@/shared/ui/Button";
import { FrequencyDomainDispersionChart } from "../FrequencyDomainCharts";
import { FrequencyDomainBranchTable } from "../FrequencyDomainTables";

import {
  buildEigenDispersionPointViewModel,
  useEigenDispersionInspectorSummary,
} from "./EigenDispersionInspectorModel";
import { buildEigenDispersionPointHandoffContext } from "./EigenDispersionInspectorPanel.model";

export function EigenDispersionInspectorPanel({
  onSelectDispersionSelection,
  selection,
}: InspectorPanelProps & {
  onSelectDispersionSelection?: (next: Omit<Selection, "moduleSource">) => void;
}) {
  const kernel = useKernel();
  const summary = useEigenDispersionInspectorSummary();
  const selectedPoint = selectedDispersionPoint(selection, summary.dispersionModel.points);
  const selectedPointModel = selectedPoint
    ? buildEigenDispersionPointViewModel(selectedPoint)
    : null;
  const selectedGroupVelocity = selectedPoint
    ? dispersionPointGroupVelocityMPerS(summary.dispersionModel.points, selectedPoint)
    : null;

  const selectPoint = (point: EigenDispersionPoint): void => {
    const rawRef = buildEigenDispersionPointSelectionRef(
      point,
      buildEigenDispersionPointHandoffContext(selection),
    );
    const selKind = selection.kind;
    const keepPhysicsFirstKind =
      selKind === "results.dispersion.modal.relation" ||
      selKind === "results.dispersion.modal.branches";
    const resolvedKind: string = keepPhysicsFirstKind ? selKind : rawRef.kind;
    const ref =
      keepPhysicsFirstKind && rawRef.type === "frequency-domain"
        ? {
            ...rawRef,
            kind: resolvedKind,
            modeIndex: point.rawModeIndex,
            sampleIndex: point.sampleIndex,
          }
        : rawRef;
    const nextSelection: Omit<Selection, "moduleSource"> = {
      kind: resolvedKind,
      label: dispersionPointLabel(point),
      nodeId: keepPhysicsFirstKind ? (selection.nodeId ?? ref.nodeId) : ref.nodeId,
      objectId: null,
      ref,
    };
    onSelectDispersionSelection?.(nextSelection);
    kernel.selection.set(nextSelection, "inspector");
  };
  const activateSelectedModeIn3D = (): void => {
    if (!selectedPoint || !eigenModeFieldAvailable(selectedPoint) || !selectedPoint.modeFieldId) {
      return;
    }
    void kernel.commands.execute(
      "analysis.eigen.plot-mode-3d",
      createCommandContext("inspector", kernel, {
        sourceDetail: selection.kind ?? "results.dispersion.modal.relation",
      }),
      {
        fieldId: selectedPoint.modeFieldId,
        label: dispersionPointLabel(selectedPoint),
        phaseRad: 0,
        source: "eigen-mode",
        view: "phase_rotated_real",
      },
    );
  };
  const selectBranch = (branch: EigenBranch): void => {
    const ref = buildEigenBranchSelectionRef(branch);
    const keepBranchesKind = selection.kind === "results.dispersion.modal.branches";
    kernel.selection.set(
      {
        kind: keepBranchesKind ? "results.dispersion.modal.branches" : ref.kind,
        label: branch.label ?? `Branch ${branch.branchId}`,
        nodeId: keepBranchesKind ? (selection.nodeId ?? ref.nodeId) : ref.nodeId,
        objectId: null,
        ref: keepBranchesKind && ref.type === "frequency-domain"
          ? { ...ref, kind: "results.dispersion.modal.branches" }
          : ref,
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
                  label="Group velocity"
                  value={
                    selectedGroupVelocity != null
                      ? `${(selectedGroupVelocity * 1e-3).toFixed(3)} km/s`
                      : selectedPoint
                        ? "—"
                        : "not selected"
                  }
                />
                <FieldRow
                  label="Mode field"
                  value={selectedPointModel ? (selectedPointModel.fieldAvailable ? "available" : "missing") : "not selected"}
                />
                <FieldRow
                  label="Validation warning"
                  value={selectedPoint ? dispersionPointWarning(selectedPoint) : "not selected"}
                />
                {selectedPoint ? (
                  <div className="fm-frequency-domain-table__actions">
                    <Button
                      aria-label="Activate Mode in 3D"
                      className="fm-inspector-action-button"
                      disabled={!selectedPointModel?.fieldAvailable || !selectedPoint.modeFieldId}
                      disabledReason="Mode field artifact is not published for this (k, f) sample"
                      size="sm"
                      type="button"
                      variant="primary"
                      onClick={activateSelectedModeIn3D}
                    >
                      <Box aria-hidden="true" size={13} />
                      <span>Activate in 3D</span>
                    </Button>
                    <Button
                      aria-label="Pin Mode Visualization"
                      className="fm-inspector-action-button"
                      disabled={!selectedPointModel?.fieldAvailable || !selectedPoint.modeFieldId}
                      disabledReason="Mode field artifact is required to pin a 3D visualization"
                      size="sm"
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        void kernel.commands.execute(
                          PIN_MODE_VISUALIZATION_COMMAND,
                          createCommandContext("inspector", kernel, {
                            sourceDetail: selection.kind ?? "results.dispersion.modal.relation",
                          }),
                        );
                      }}
                    >
                      <Pin aria-hidden="true" size={13} />
                      <span>Pin Mode Visualization</span>
                    </Button>
                  </div>
                ) : null}
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
              <div className="grid gap-2">
                <FrequencyDomainDispersionChart
                  model={summary.dispersionModel}
                  onSelectPoint={selectPoint}
                />
                {summary.dispersionModel.points.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label="Dispersion sample quick selector">
                    {summary.dispersionModel.points.map((pt) => {
                      const active =
                        selectedPoint?.sampleIndex === pt.sampleIndex &&
                        selectedPoint?.rawModeIndex === pt.rawModeIndex;
                      return (
                        <Button
                          aria-label={`Select dispersion point sample ${pt.sampleIndex} mode ${pt.rawModeIndex}`}
                          key={`${pt.sampleIndex}:${pt.rawModeIndex}`}
                          size="sm"
                          type="button"
                          variant={active ? "primary" : "secondary"}
                          onClick={() => selectPoint(pt)}
                        >
                          {`k#${pt.sampleIndex} · ${(pt.frequencyHz * 1e-9).toFixed(2)} GHz`}
                        </Button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
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

const DISPERSION_POINT_SELECTION_KINDS = new Set([
  "results.eigen.dispersion",
  "results.dispersion.modal.relation",
  "results.dispersion.modal.branches",
  "results.dispersion.modal.mode_at_k",
]);

function selectedDispersionPoint(
  selection: InspectorPanelProps["selection"],
  points: readonly EigenDispersionPoint[],
): EigenDispersionPoint | null {
  if (!selection.kind || !DISPERSION_POINT_SELECTION_KINDS.has(selection.kind)) return null;
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

function dispersionPointGroupVelocityMPerS(
  points: readonly EigenDispersionPoint[],
  target: EigenDispersionPoint,
): number | null {
  const branchPts = points
    .filter((pt) =>
      target.branchId
        ? pt.branchId === target.branchId
        : pt.rawModeIndex === target.rawModeIndex,
    )
    .toSorted((a, b) => a.pathS - b.pathS);
  const idx = branchPts.findIndex(
    (pt) =>
      pt.sampleIndex === target.sampleIndex &&
      pt.rawModeIndex === target.rawModeIndex,
  );
  if (idx < 0 || branchPts.length < 2) return null;
  const left = branchPts[Math.max(0, idx - 1)]!;
  const right = branchPts[Math.min(branchPts.length - 1, idx + 1)]!;
  const dk = right.pathS - left.pathS;
  if (!Number.isFinite(dk) || Math.abs(dk) < 1e-12) return null;
  return (2 * Math.PI * (right.frequencyHz - left.frequencyHz)) / dk;
}
