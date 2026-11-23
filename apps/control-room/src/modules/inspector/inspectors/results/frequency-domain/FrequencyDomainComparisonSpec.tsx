"use client";

import { EmptyState } from "@/shared/ui/EmptyState";
import type { InspectorPanelProps } from "../../../inspectorTypes";
import { FieldRow } from "../../../primitives/FieldRow";
import { InspectorGroup } from "../../../primitives/InspectorGroup";
import { Activity, Eye } from "lucide-react";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import type { FmrModalDrivenComparisonPoint } from "@/shared/domain/analysis/frequencyDomainChartModels";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { useFmrComparisonSummary } from "../../../panels/frequency-domain/frequencyDomainEigenFmrSummaries";
import {
  formatFmrModalPairLabel,
  formatFmrDrivenPairLabel,
  formatFmrPairFieldHandoff,
  formatFmrPairAmplitudeRatio,
  formatFrequency,
} from "../../../panels/frequency-domain/frequencyDomainResultFormatting";
import { FmrComparisonPairTable } from "./frequencyDomainShared";

export function FmrComparisonInspectorContent(props: InspectorPanelProps) {
  void props;
  const summary = useFmrComparisonSummary();
  const kernel = useKernel();
  const openModalPair = (pair: FmrModalDrivenComparisonPoint): void => {
    const modeRef = pair.modalPeak.modeRef;
    if (!modeRef) return;
    const nodeId = `results:eigen:sample:${modeRef.sampleIndex}:mode:${modeRef.rawModeIndex}`;
    kernel.selection.set(
      {
        kind: "results.eigen.mode",
        label: `Mode ${modeRef.rawModeIndex}`,
        nodeId,
        objectId: null,
        ref: {
          fieldId: pair.modalPeak.fieldId ?? undefined,
          kind: "results.eigen.mode",
          modeIndex: modeRef.rawModeIndex,
          nodeId,
          resourceRef: pair.modalPeak.fieldResourceKey ?? undefined,
          sampleIndex: modeRef.sampleIndex,
          type: "frequency-domain",
        },
      },
      "inspector",
    );
  };
  const openDrivenPair = (pair: FmrModalDrivenComparisonPoint): void => {
    const frequencyPointIndex = pair.drivenPeak.frequencyPointIndex;
    if (frequencyPointIndex == null) return;
    const nodeId = `results:frequency-response:frequency-points:${frequencyPointIndex}`;
    kernel.selection.set(
      {
        kind: "results.frequency_response.frequency_point",
        label: `Frequency point ${frequencyPointIndex}`,
        nodeId,
        objectId: null,
        ref: {
          fieldId: pair.drivenPeak.fieldId ?? undefined,
          frequencyIndex: frequencyPointIndex,
          kind: "results.frequency_response.frequency_point",
          nodeId,
          resourceRef: pair.drivenPeak.fieldResourceKey ?? undefined,
          type: "frequency-domain",
        },
      },
      "inspector",
    );
  };
  const plotModalPair = (pair: FmrModalDrivenComparisonPoint): void => {
    if (!pair.modalPeak.fieldId) return;
    void kernel.commands.execute(
      "analysis.eigen.plot-mode-3d",
      createCommandContext("inspector", kernel, {
        sourceDetail: "results.frequency_domain.comparison",
      }),
      {
        fieldId: pair.modalPeak.fieldId,
        label: formatFmrModalPairLabel(pair),
        phaseRad: 0,
        source: "eigen-mode",
        view: "phase_rotated_real",
      },
    );
  };
  const plotDrivenPair = (pair: FmrModalDrivenComparisonPoint): void => {
    if (!pair.drivenPeak.fieldId) return;
    void kernel.commands.execute(
      "analysis.frequency-response.plot-response-field-3d",
      createCommandContext("inspector", kernel, {
        sourceDetail: "results.frequency_domain.comparison",
      }),
      {
        fieldId: pair.drivenPeak.fieldId,
        frequencyIndex: pair.drivenPeak.frequencyPointIndex,
        label: formatFmrDrivenPairLabel(pair),
        phaseRad: 0,
        source: "frequency-response",
        view: "phase_rotated_real",
      },
    );
  };

  return (
    <div data-inspector-surface="fmr-comparison">
      <InspectorGroup
        title="FMR Modal vs Driven Comparison"
        badge={summary.badge}
      >
        <FieldRow
          label="Canonical comparison"
          value="Eigenmodes resonance vs FrequencyResponse peak"
        />
        <FieldRow label="Comparison readiness" value={summary.readiness} />
        <FieldRow label="Modal resonance" value={summary.modalResonance} />
        <FieldRow label="Driven peak" value={summary.drivenPeak} />
        <FieldRow label="Frequency offset" value={summary.frequencyOffset} />
        <FieldRow label="Peak amplitude ratio" value={summary.amplitudeRatio} />
        <FieldRow label="Spatial overlap (eta_j)" value={summary.spatialOverlap} />
        <FieldRow label="Modal field" value={summary.modalOverlay} />
        <FieldRow label="Driven field" value={summary.drivenOverlay} />
        <FieldRow label="Validation state" value={summary.validationState} />
        <FieldRow label="Resources" value={summary.resources} />
      </InspectorGroup>
      <InspectorGroup
        title="FMR Comparison Browser"
        badge={`${summary.pairs.length} pair(s)`}
      >
        <FmrComparisonPairBrowser
          onOpenDriven={openDrivenPair}
          onOpenModal={openModalPair}
          onPlotDriven={plotDrivenPair}
          onPlotModal={plotModalPair}
          pairs={summary.pairs}
        />
      </InspectorGroup>
      <InspectorGroup
        title="FMR Modal-Driven Pair Table"
        badge={`${summary.pairs.length} pair(s)`}
      >
        <FmrComparisonPairTable pairs={summary.pairs} />
      </InspectorGroup>
      <InspectorGroup
        title="FMR Comparison Actions"
        badge={summary.actionBadge}
      >
        <FieldRow label="Modal target" value={summary.modalActionTarget} />
        <FieldRow label="Driven target" value={summary.drivenActionTarget} />
        <FmrComparisonActions summary={summary} />
      </InspectorGroup>
    </div>
  );
}

function FmrComparisonActions({
  summary,
}: {
  summary: ReturnType<typeof useFmrComparisonSummary>;
}) {
  const kernel = useKernel();
  const openModal = (): void => {
    const modeRef = summary.modalPeakPoint?.modeRef;
    if (!modeRef) return;
    const nodeId = `results:eigen:sample:${modeRef.sampleIndex}:mode:${modeRef.rawModeIndex}`;
    kernel.selection.set(
      {
        kind: "results.eigen.mode",
        label: `Mode ${modeRef.rawModeIndex}`,
        nodeId,
        objectId: null,
        ref: {
          fieldId: summary.modalPeakPoint?.fieldId ?? undefined,
          kind: "results.eigen.mode",
          modeIndex: modeRef.rawModeIndex,
          nodeId,
          resourceRef: summary.modalPeakPoint?.fieldResourceKey ?? undefined,
          sampleIndex: modeRef.sampleIndex,
          type: "frequency-domain",
        },
      },
      "inspector",
    );
  };
  const openDriven = (): void => {
    const frequencyPointIndex = summary.drivenPeakPoint?.frequencyPointIndex;
    if (frequencyPointIndex == null) return;
    const nodeId = `results:frequency-response:frequency-points:${frequencyPointIndex}`;
    kernel.selection.set(
      {
        kind: "results.frequency_response.frequency_point",
        label: `Frequency point ${frequencyPointIndex}`,
        nodeId,
        objectId: null,
        ref: {
          fieldId: summary.drivenPeakPoint?.fieldId ?? undefined,
          frequencyIndex: frequencyPointIndex,
          kind: "results.frequency_response.frequency_point",
          nodeId,
          resourceRef: summary.drivenPeakPoint?.fieldResourceKey ?? undefined,
          type: "frequency-domain",
        },
      },
      "inspector",
    );
  };
  const plotModal = (): void => {
    if (!summary.modalPeakPoint?.fieldId) return;
    void kernel.commands.execute(
      "analysis.eigen.plot-mode-3d",
      createCommandContext("inspector", kernel, {
        sourceDetail: "results.frequency_domain.comparison",
      }),
      {
        fieldId: summary.modalPeakPoint.fieldId,
        label: summary.modalActionTarget,
        phaseRad: 0,
        source: "eigen-mode",
        view: "phase_rotated_real",
      },
    );
  };
  const plotDriven = (): void => {
    if (!summary.drivenPeakPoint?.fieldId) return;
    void kernel.commands.execute(
      "analysis.frequency-response.plot-response-field-3d",
      createCommandContext("inspector", kernel, {
        sourceDetail: "results.frequency_domain.comparison",
      }),
      {
        fieldId: summary.drivenPeakPoint.fieldId,
        frequencyIndex: summary.drivenPeakPoint.frequencyPointIndex,
        label: summary.drivenActionTarget,
        phaseRad: 0,
        source: "frequency-response",
        view: "phase_rotated_real",
      },
    );
  };

  return (
    <div className="fm-frequency-domain-table__actions">
      <Button
        aria-label="Open the modal eigenmode behind this comparison"
        className="fm-inspector-action-button"
        disabled={!summary.modalPeakPoint?.modeRef}
        disabledReason="No modal eigenmode is linked to this comparison"
        size="sm"
        type="button"
        variant="secondary"
        onClick={openModal}
      >
        <Eye size={13} aria-hidden="true" />
        <span>Open modal mode</span>
      </Button>
      <Button
        aria-label="Open the driven response point behind this comparison"
        className="fm-inspector-action-button"
        disabled={summary.drivenPeakPoint?.frequencyPointIndex == null}
        disabledReason="No driven response point is linked to this comparison"
        size="sm"
        type="button"
        variant="secondary"
        onClick={openDriven}
      >
        <Eye size={13} aria-hidden="true" />
        <span>Open driven point</span>
      </Button>
      <Button
        aria-label="Plot the modal comparison field in 3D"
        className="fm-inspector-action-button"
        disabled={!summary.modalPeakPoint?.fieldId}
        disabledReason="Modal comparison field is missing"
        size="sm"
        type="button"
        variant="primary"
        onClick={plotModal}
      >
        <Activity size={13} aria-hidden="true" />
        <span>Plot modal field</span>
      </Button>
      <Button
        aria-label="Plot the driven comparison field in 3D"
        className="fm-inspector-action-button"
        disabled={!summary.drivenPeakPoint?.fieldId}
        disabledReason="Driven comparison field is missing"
        size="sm"
        type="button"
        variant="primary"
        onClick={plotDriven}
      >
        <Activity size={13} aria-hidden="true" />
        <span>Plot driven field</span>
      </Button>
    </div>
  );
}

function FmrComparisonPairBrowser({
  onOpenDriven,
  onOpenModal,
  onPlotDriven,
  onPlotModal,
  pairs,
}: {
  onOpenDriven: (pair: FmrModalDrivenComparisonPoint) => void;
  onOpenModal: (pair: FmrModalDrivenComparisonPoint) => void;
  onPlotDriven: (pair: FmrModalDrivenComparisonPoint) => void;
  onPlotModal: (pair: FmrModalDrivenComparisonPoint) => void;
  pairs: readonly FmrModalDrivenComparisonPoint[];
}) {
  if (pairs.length === 0) {
    return (
      <EmptyState className="fm-frequency-domain-table-empty" role="status" size="compact" heading="No modal-driven FMR comparison pairs available." />
    );
  }

  return (
    <div className="fm-frequency-domain-comparison-browser">
      {pairs.map((pair) => (
        <article
          className="fm-frequency-domain-comparison-card"
          data-status={
            pair.modalPeak.fieldId && pair.drivenPeak.fieldId
              ? "ready"
              : "partial"
          }
          key={`${pair.modalPeak.frequencyHz}:${pair.modalPeak.modeRef?.sampleIndex ?? "sample"}:${pair.modalPeak.modeRef?.rawModeIndex ?? "mode"}:${pair.drivenPeak.frequencyHz}:${pair.drivenPeak.frequencyPointIndex ?? "point"}`}
        >
          <div className="fm-frequency-domain-comparison-card__header">
            <div>
              <span className="fm-frequency-domain-comparison-card__eyebrow">
                modal-driven detuning
              </span>
              <h4>{formatFrequency(pair.detuningHz)}</h4>
            </div>
            <Badge variant="secondary">
              {pair.modalPeak.validationStatus}/{pair.drivenPeak.validationStatus}
            </Badge>
          </div>
          <div className="fm-frequency-domain-comparison-card__grid">
            <FieldRow label="Modal" value={formatFmrModalPairLabel(pair)} />
            <FieldRow label="Driven" value={formatFmrDrivenPairLabel(pair)} />
            <FieldRow
              label="Modal field"
              value={pair.modalPeak.fieldId ? "field-ready" : "missing"}
            />
            <FieldRow
              label="Driven field"
              value={pair.drivenPeak.fieldId ? "field-ready" : "missing"}
            />
            <FieldRow
              label="Amplitude ratio"
              value={formatFmrPairAmplitudeRatio(pair)}
            />
            <FieldRow
              label="Field handoff"
              value={formatFmrPairFieldHandoff(pair)}
            />
          </div>
          <div className="fm-frequency-domain-comparison-card__actions">
            <Button
              aria-label="Open the modal eigenmode in the inspector"
              className="fm-inspector-action-button"
              disabled={!pair.modalPeak.modeRef}
              disabledReason="This comparison has no linked modal eigenmode"
              size="sm"
              type="button"
              variant="secondary"
              onClick={() => onOpenModal(pair)}
            >
              <Eye size={13} aria-hidden="true" />
              <span>Modal</span>
            </Button>
            <Button
              aria-label="Open the driven response point in the inspector"
              className="fm-inspector-action-button"
              disabled={pair.drivenPeak.frequencyPointIndex == null}
              disabledReason="This comparison has no linked driven response point"
              size="sm"
              type="button"
              variant="secondary"
              onClick={() => onOpenDriven(pair)}
            >
              <Eye size={13} aria-hidden="true" />
              <span>Driven</span>
            </Button>
            <Button
              aria-label="Plot the modal comparison field in 3D"
              className="fm-inspector-action-button"
              disabled={!pair.modalPeak.fieldId}
              disabledReason="Modal comparison field is missing"
              size="sm"
              type="button"
              variant="primary"
              onClick={() => onPlotModal(pair)}
            >
              <Activity size={13} aria-hidden="true" />
              <span>Plot modal</span>
            </Button>
            <Button
              aria-label="Plot the driven comparison field in 3D"
              className="fm-inspector-action-button"
              disabled={!pair.drivenPeak.fieldId}
              disabledReason="Driven comparison field is missing"
              size="sm"
              type="button"
              variant="primary"
              onClick={() => onPlotDriven(pair)}
            >
              <Activity size={13} aria-hidden="true" />
              <span>Plot driven</span>
            </Button>
          </div>
        </article>
      ))}
    </div>
  );
}
