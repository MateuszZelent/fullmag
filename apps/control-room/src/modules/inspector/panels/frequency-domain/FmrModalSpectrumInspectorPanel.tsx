"use client";

import { useState } from "react";
import { Eye, RotateCw } from "lucide-react";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import {
  ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH,
} from "@/kernel/api/apiPaths";
import {
  useFrequencyDomainEigenSpectrumResource,
  useFrequencyDomainManifestResource,
} from "@/kernel/resources/studyRuntimeResources";
import {
  buildEigenSpectrumChartModel,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import type {
  EigenSpectrumPoint,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import {
  formatFrequencyHz,
  formatFrequencyRangeHz,
} from "@/shared/domain/analysis/frequencyUnits";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { FrequencyDomainSpectrumChart } from "../FrequencyDomainCharts";
import {
  FrequencyDomainModeTable,
  type FrequencyDomainModeTableAction,
} from "../FrequencyDomainTables";
import { buildFmrModalSpectrumViewModel } from "./FmrModalSpectrumModel";

export function FmrModalSpectrumInspectorPanel(props: InspectorPanelProps) {
  void props;
  const summary = useFmrModalSpectrumSummary();
  const kernel = useKernel();
  const [selectedModeKey, setSelectedModeKey] = useState<string | null>(null);
  const view = buildFmrModalSpectrumViewModel({
    calculationMode: summary.chartRoute.mode,
    points: summary.spectrumModel.points,
    resourceKey: summary.spectrumResource,
    selectedModeKey,
    status: summary.spectrumStatus,
  });

  const selectMode = (point: EigenSpectrumPoint): void => {
    const nodeId = `results:eigen:sample:${point.sampleIndex}:mode:${point.rawModeIndex}`;
    setSelectedModeKey(`${point.sampleIndex}:${point.rawModeIndex}`);
    kernel.selection.set(
      {
        kind: "results.eigen.mode",
        label: `Mode ${point.rawModeIndex}`,
        nodeId,
        objectId: null,
        ref: {
          fieldId: point.modeFieldId ?? undefined,
          kind: "results.eigen.mode",
          modeIndex: point.rawModeIndex,
          nodeId,
          resourceRef: point.modeFieldResourceKey ?? summary.spectrumResource,
          sampleIndex: point.sampleIndex,
          type: "frequency-domain",
        },
      },
      "inspector",
    );
  };
  const plotMode = (
    point: EigenSpectrumPoint,
    action: FrequencyDomainModeTableAction = "phase_rotated_real",
  ): void => {
    if (action === "inspect") {
      selectMode(point);
      return;
    }
    if (!point.modeFieldId) return;
    void kernel.commands.execute(
      "analysis.eigen.plot-mode-3d",
      createCommandContext("inspector", kernel, {
        sourceDetail: "results.frequency_domain.fmr_modal_spectrum",
      }),
      {
        fieldId: point.modeFieldId,
        label: `sample ${point.sampleIndex}, mode ${point.rawModeIndex}`,
        phaseRad: 0,
        source: "eigen-mode",
        view: action,
      },
    );
  };

  return (
    <div
      data-inspector-owner="frequency-domain.fmr-modal-spectrum"
      data-inspector-surface="fmr-modal-spectrum"
    >
      <InspectorGroup
        title="FMR Modal Spectrum Control"
        badge={summary.modalBadge}
      >
        <FieldRow
          label="Mode workflow"
          value="modal k=0 eigenmodes -> resonances -> 3D mode field"
        />
        <FieldRow label="Spectrum resource" value={summary.spectrumResource} />
        <FieldRow
          label="Mode rows"
          value={`${summary.modalModeCount} modes, ${summary.modalFieldCount} 3D fields`}
        />
        <FieldRow label="Frequency span" value={summary.modalFrequencyRange} />
        <FieldRow
          label="Primary resonance"
          value={summary.primaryModalResonance}
        />
        <FieldRow
          label="Residual coverage"
          value={summary.modalResidualCoverage}
        />
        <FieldRow
          label="Damping coverage"
          value={summary.modalDampingCoverage}
        />
        <FieldRow
          label="Field readiness"
          value={summary.modalFieldCount > 0 ? "mode fields available" : "mode fields missing"}
        />
        <FieldRow
          label="Visualization style scope"
          value="shared across all FMR modes; selecting a mode changes field data only"
        />
        <FieldRow label="Chart route" value={summary.modalChartRoute} />
        <FieldRow label="Scientific trust" value={view.trust} />
        <FieldRow
          label="Selected mode"
          value={view.selectedModeKey ?? "none"}
        />
        <FieldRow label="Capability summary" value={summary.capabilitySummary} />
      </InspectorGroup>
      <InspectorGroup
        title="FMR Modal Spectrum Provenance"
        badge={view.trust}
      >
        {view.provenance.map((item) => (
          <FieldRow key={item.label} label={item.label} value={item.value} />
        ))}
      </InspectorGroup>
      <InspectorGroup
        title="FMR Modal Spectrum Chart"
        badge={`${summary.modalModeCount} mode(s)`}
      >
        <FrequencyDomainSpectrumChart
          model={summary.spectrumModel}
          onPlotMode={(point) => plotMode(point)}
          onSelectMode={selectMode}
          selectedModeKey={view.selectedModeKey}
        />
      </InspectorGroup>
      <InspectorGroup
        title="FMR Resonance Browser"
        badge={`${summary.modalModeCount} mode(s)`}
      >
        <FmrResonanceBrowser
          onPlotMode={plotMode}
          onSelectMode={selectMode}
          points={summary.spectrumModel.points}
        />
      </InspectorGroup>
      <InspectorGroup
        title="FMR Modal Mode Table"
        badge={`${summary.modalFieldCount} field(s)`}
      >
        <FrequencyDomainModeTable
          onPlotMode={plotMode}
          points={summary.spectrumModel.points}
          selectedModeKey={view.selectedModeKey}
        />
      </InspectorGroup>
    </div>
  );
}

function FmrResonanceBrowser({
  onPlotMode,
  onSelectMode,
  points,
}: {
  onPlotMode: (
    point: EigenSpectrumPoint,
    action?: FrequencyDomainModeTableAction,
  ) => void;
  onSelectMode: (point: EigenSpectrumPoint) => void;
  points: readonly EigenSpectrumPoint[];
}) {
  if (points.length === 0) {
    return (
      <div className="fm-frequency-domain-table-empty" role="status">
        No modal FMR resonances available.
      </div>
    );
  }

  const sortedPoints = points.toSorted(
    (left, right) =>
      left.sampleIndex - right.sampleIndex ||
      left.frequencyHz - right.frequencyHz ||
      left.rawModeIndex - right.rawModeIndex,
  );

  return (
    <div className="fm-frequency-domain-resonance-browser">
      {sortedPoints.map((point) => (
        <article
          className="fm-frequency-domain-resonance-card"
          data-status={point.modeFieldId ? "ready" : "missing"}
          key={`${point.sampleIndex}:${point.rawModeIndex}:${point.frequencyHz}`}
        >
          <div className="fm-frequency-domain-resonance-card__header">
            <div>
              <span className="fm-frequency-domain-resonance-card__eyebrow">
                sample {point.sampleIndex}, mode {point.rawModeIndex}
              </span>
              <h4>{formatFrequency(point.frequencyHz)}</h4>
            </div>
            <Badge variant="secondary">
              {point.modeFieldId ? "3D-ready" : "field missing"}
            </Badge>
          </div>
          <div className="fm-frequency-domain-resonance-card__grid">
            <FieldRow
              label="Imag frequency"
              value={formatFrequency(point.imaginaryFrequencyHz)}
            />
            <FieldRow
              label="Damping rate"
              value={formatFrequency(point.dampingRateHz)}
            />
            <FieldRow label="Residual" value={formatResidual(point.residualNorm)} />
            <FieldRow
              label="Tangent leakage"
              value={formatResidual(point.tangentLeakageMax)}
            />
            <FieldRow
              label="Branch"
              value={point.branchId ?? "not assigned"}
            />
            <FieldRow
              label="Mode field"
              value={point.modeFieldId ? "field-ready" : "missing"}
            />
          </div>
          <div className="fm-frequency-domain-resonance-card__actions">
            <Button
              className="fm-inspector-action-button"
              size="sm"
              title="Open this eigen mode inspector"
              type="button"
              variant="secondary"
              onClick={() => onSelectMode(point)}
            >
              <Eye size={13} aria-hidden="true" />
              <span>Inspect</span>
            </Button>
            <Button
              className="fm-inspector-action-button"
              disabled={!point.modeFieldId}
              size="sm"
              title={
                point.modeFieldId
                  ? "Plot this modal resonance in 3D"
                  : "This mode has no linked 3D field payload"
              }
              type="button"
              variant="primary"
              onClick={() => onPlotMode(point)}
            >
              <RotateCw size={13} aria-hidden="true" />
              <span>Plot 3D</span>
            </Button>
          </div>
        </article>
      ))}
    </div>
  );
}

function useFmrModalSpectrumSummary() {
  const manifest = useFrequencyDomainManifestResource();
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const spectrumModel = buildEigenSpectrumChartModel(spectrum.data);
  const chartRoute = {
    mode: "fmr_modal",
    primaryChart: "eigen-spectrum",
  };
  const capabilities = frequencyDomainRuntimeCapabilities(manifest.data);
  const modalCapabilities = record(capabilities?.modal);
  const responseCapabilities = record(capabilities?.response);
  const modalFieldCount = spectrumModel.points.filter(
    (point) => point.modeFieldId,
  ).length;
  const modalResidualCount = spectrumModel.points.filter(
    (point) => point.residualNorm != null,
  ).length;
  const modalDampingCount = spectrumModel.points.filter(
    (point) => point.dampingRateHz != null || point.imaginaryFrequencyHz != null,
  ).length;
  const firstModalPoint = spectrumModel.points[0] ?? null;
  const spectrumResource = ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH;

  return {
    capabilitySummary: `reference_cpu: ${capabilityStatus(modalCapabilities?.reference_cpu)}; magnetic_cpu: ${capabilityStatus(responseCapabilities?.magnetic_cpu)}`,
    chartRoute,
    modalBadge:
      spectrum.status === "ready"
        ? `${spectrumModel.points.length} mode(s)`
        : spectrum.status,
    modalChartRoute: `${chartRoute.mode} -> ${chartRoute.primaryChart}`,
    modalDampingCoverage: `${modalDampingCount}/${spectrumModel.points.length} mode(s)`,
    modalFieldCount,
    modalFrequencyRange: formatFrequencyRangeHz(
      spectrumModel.points.map((point) => point.frequencyHz),
    ),
    modalModeCount: spectrumModel.points.length,
    modalResidualCoverage: `${modalResidualCount}/${spectrumModel.points.length} mode(s)`,
    primaryModalResonance: firstModalPoint
      ? `mode ${firstModalPoint.rawModeIndex} at ${formatFrequency(firstModalPoint.frequencyHz)}`
      : "not available",
    spectrumModel,
    spectrumResource,
    spectrumStatus: spectrum.status,
  };
}

function capabilityStatus(value: unknown): string {
  const status = record(value)?.status;
  return typeof status === "string" && status.trim()
    ? status
    : "not available";
}

function frequencyDomainRuntimeCapabilities(
  manifest: unknown,
): Record<string, unknown> | null {
  const manifestRecord = record(manifest);
  const resultManifest = record(manifestRecord?.result_manifest);
  const payload = record(resultManifest?.payload);
  const manifestCapabilities = record(manifestRecord?.capabilities);
  const runtimeCapabilities = record(payload?.capabilities);

  if (manifestCapabilities && runtimeCapabilities) {
    return { ...manifestCapabilities, ...runtimeCapabilities };
  }

  return runtimeCapabilities ?? manifestCapabilities;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function formatResidual(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  if (value !== 0 && Math.abs(value) < 1e-3) return value.toExponential(2);
  return `${Number(value.toPrecision(6))}`;
}

function formatFrequency(valueHz: number | null | undefined): string {
  return formatFrequencyHz(valueHz);
}
