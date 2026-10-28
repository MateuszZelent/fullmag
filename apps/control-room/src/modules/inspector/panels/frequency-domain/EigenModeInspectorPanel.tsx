"use client";

import { Play, Pause } from "lucide-react";

import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import {
  useFrequencyDomainEigenModeFieldMetaResource,
  useFrequencyDomainEigenModeResource,
} from "@/kernel/resources/studyRuntimeResources";
import {
  eigenModeFieldAvailable,
  frequencyDomainManifestPayload,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import {
  buildEigenResidualSummary,
  readEigenModeResourcePayload,
  type EigenResidualSummary,
} from "@/shared/domain/analysis/eigenResidualSummary";
import { formatModeWavevector, modeResultLabel, sameModeResultOwner } from "@/shared/domain/analysis/modeResultPresentation";
import { formatFrequencyHz } from "@/shared/domain/analysis/frequencyUnits";
import {
  finiteModalScalar,
  modalDampingObservables,
  resolveModalPhasorConvention,
  type ModalDampingObservables,
} from "@/shared/domain/analysis/modalDampingObservables";
import { Button } from "@/shared/ui/Button";
import { EigenModePicker, useEigenModeBrowserData } from "./EigenModePicker";
import { ModeVisualizationPhaseControl } from "../ModeVisualizationInspectorPanel";

import { useInspectorActiveTab } from "../../InspectorTabState";
import type { InspectorPanelProps } from "../../inspectorTypes";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import {
  canPlotSelectedFieldIn3D,
  modeFieldComponentOptions,
  selectedField3DPlotStatus,
} from "./FrequencyDomainHelpers";
import {
  FrequencyDomainModeDisplayControls,
  analysisFieldViewLabel,
  normalizeAnalysisFieldView,
  useFrequencyDomainModeDisplaySettings,
} from "../FrequencyDomainModeDisplayControls";

export interface EigenModeIdentityViewModel {
  branchId: string | null;
  fieldId: string | null;
  label: string;
  modeIndex: number | null;
  resourceRef: string | null;
  sampleIndex: number | null;
}

export function buildEigenModeIdentityViewModel(input: {
  branchId?: string | null;
  fieldId?: string | null;
  modeIndex?: number | null;
  resourceRef?: string | null;
  sampleIndex?: number | null;
}): EigenModeIdentityViewModel {
  const sampleIndex = input.sampleIndex ?? null;
  const modeIndex = input.modeIndex ?? null;
  return {
    branchId: input.branchId ?? null,
    fieldId: input.fieldId ?? null,
    label:
      sampleIndex == null || modeIndex == null
        ? "not selected"
        : `sample ${sampleIndex}, mode ${modeIndex}`,
    modeIndex,
    resourceRef: input.resourceRef ?? null,
    sampleIndex,
  };
}

export function EigenModeInspectorPanel({
  selection,
}: InspectorPanelProps) {
  const kernel = useKernel();
  const summary = useEigenModeSummary(selection);
  const activeTab = useInspectorActiveTab();
  const modeDisplaySettings = useFrequencyDomainModeDisplaySettings({
    activation: {
      commandId: "analysis.eigen.plot-mode-3d",
      componentBasis: summary.componentBasis,
      componentCount: summary.componentCount,
      defaultPhaseRad: 0,
      fieldId: summary.fieldId,
      label: summary.physicalLabel,
      source: "eigen-mode",
      valueKind: summary.valueKind,
    },
    sourceDetail: "results.eigen.mode",
  });

  return (
    <div
      data-inspector-owner="frequency-domain.eigen-mode"
      data-inspector-surface="eigen-mode"
    >
      {activeTab === "overview" ? <>
        <EigenModePicker samples={summary.samples} selection={selection} />
        <InspectorGroup title="Selected eigenmode">
          <FieldRow label="Mode field" value={summary.field3DReady ? "Available" : summary.field3DStatus} />
          <FieldRow label="3D field request" value={sameModeResultOwner(modeDisplaySettings.activeAnalysisFieldOverlay?.modeIntent, summary.owner) ? "Selected mode requested; rendering status is shown in the viewport" : modeDisplaySettings.activeAnalysisFieldOverlay ? "Another mode is active. Show this mode to replace it." : "Not activated"} />
          <EigenMode3DActions settings={modeDisplaySettings} summary={summary} />
        </InspectorGroup>
        <p className="fm-result-inspector__help">Select a point on the dispersion chart, then show its field in 3D. Field amplitude is normalized, not a driven-wave amplitude.</p>
        <InspectorGroup title="Phase & playback" collapsible defaultOpen={false}>
          <ModeVisualizationPhaseControl
            key={summary.fieldId}
            disabled={!summary.field3DReady || !sameModeResultOwner(modeDisplaySettings.activeAnalysisFieldOverlay?.modeIntent, summary.owner)}
            animate={modeDisplaySettings.activeAnalysisFieldOverlay?.animation?.animatePhase ?? false}
            animationDirection={modeDisplaySettings.activeAnalysisFieldOverlay?.animation?.direction ?? 1}
            animationLoop={modeDisplaySettings.activeAnalysisFieldOverlay?.animation?.loop ?? true}
            animationRateHz={modeDisplaySettings.activeAnalysisFieldOverlay?.animation?.animationRateHz || 1}
            phaseRad={String(modeDisplaySettings.activeAnalysisFieldOverlay?.visualizationPhaseRad ?? 0)}
            onAnimationChange={(animation) => kernel.analysisFieldOverlay.update({
              animation,
              query: { ...modeDisplaySettings.activeAnalysisFieldOverlay?.query, view: "phase_rotated_real" },
            })}
            onSetPhase={(value) => kernel.analysisFieldOverlay.update({
              animation: { ...modeDisplaySettings.activeAnalysisFieldOverlay?.animation, animatePhase: false, animationRateHz: modeDisplaySettings.activeAnalysisFieldOverlay?.animation?.animationRateHz || 1 },
              visualizationPhaseRad: Number(value),
              query: { ...modeDisplaySettings.activeAnalysisFieldOverlay?.query, view: "phase_rotated_real" },
            })}
          />
          <p className="fm-result-inspector__help">Playback speed is visual only. Choose a signed component or vectors to see precession; magnitude can remain constant.</p>
        </InspectorGroup>
        <InspectorGroup title="Appearance" collapsible defaultOpen={false}>
          {!sameModeResultOwner(modeDisplaySettings.activeAnalysisFieldOverlay?.modeIntent, summary.owner) ? <p className="fm-result-inspector__help">Show this mode in 3D before changing its appearance.</p> : null}
          <FrequencyDomainModeDisplayControls
            componentOptions={summary.componentOptions}
            disabled={!summary.field3DReady || !sameModeResultOwner(modeDisplaySettings.activeAnalysisFieldOverlay?.modeIntent, summary.owner)}
            labelPrefix="Eigen mode"
            settings={modeDisplaySettings}
            viewDefaultValue={summary.defaultView}
            viewOptions={summary.availableViewValues}
          />
        </InspectorGroup>
      </> : null}
      {activeTab === "data" ? <InspectorGroup title="Mode observables">
        <FieldRow label="Frequency" value={summary.frequencyDisplay} />
        <FieldRow label="Wavevector" value={summary.wavevectorLabel} />
        <FieldRow label="Imaginary frequency" value={summary.imaginaryFrequency} />
        <FieldRow label="Angular frequency" value={summary.angularFrequency} />
        <FieldRow label="Temporal phasor convention" value={summary.phaseConvention} />
        <EigenModeDampingFields damping={summary.damping} />
        <FieldRow label="Mode identity" value={summary.modeIdentity} />
        <FieldRow label="Field ID" value={summary.fieldIdLabel} />
      </InspectorGroup> : null}
      {activeTab === "diagnostics" ? <>
        <InspectorGroup title="Mode residual">
          <EigenModeResidualFields residual={summary.residual} />
          <FieldRow label="Certification tolerance" value={summary.certificationTolerance} />
          <FieldRow label="Producer certificate" value={summary.certificationStatus} />
          <FieldRow label="Tangent leakage max" value={summary.tangentLeakageMax} />
        </InspectorGroup>
        <p className="fm-result-inspector__help">A residual certificate applies to this mode and its stated operator scope. Mesh, airbox and spectrum completeness require separate qualification.</p>
      </> : null}
    </div>
  );
}

EigenModeInspectorPanel.displayName = "EigenModeInspectorPanel";

export function EigenModeResidualFields({
  residual,
}: {
  residual: EigenResidualSummary;
}) {
  return (
    <>
      {residual.absoluteL2 !== null ? <FieldRow label="Absolute residual (L2)" value={formatNumberOrUnavailable(residual.absoluteL2)} /> : null}
      <FieldRow
        label="Relative residual (L2)"
        value={formatNumberOrUnavailable(residual.relativeL2)}
      />
      <FieldRow label="Residual scope" value={residual.scope} />
      {residual.reportedSpectrumResidual !== null ? <FieldRow label="Spectrum residual (type unspecified)" value={formatNumberOrUnavailable(residual.reportedSpectrumResidual)} /> : null}
    </>
  );
}

export function EigenModeDampingFields({
  damping,
}: {
  damping: ModalDampingObservables;
}) {
  return (
    <>
      <FieldRow
        label="Decay rate Γ / 2π (Hz)"
        value={
          damping.decayRateHz == null
            ? "not available"
            : formatFrequency(damping.decayRateHz)
        }
      />
      <FieldRow
        label="Stability"
        value={damping.stability}
        status={damping.stability}
      />
      <FieldRow
        label="Lifetime"
        value={
          damping.lifetimeSeconds == null
            ? damping.stability === "undamped" ? "No decay in this model" : damping.stability === "growing" ? "Growing mode; no decay lifetime" : "Cannot determine without frequency and phasor convention"
            : formatNumber(damping.lifetimeSeconds) + " s"
        }
      />
      <FieldRow
        label="Linewidth (FWHM)"
        value={
          damping.linewidthFwhmHz == null
            ? damping.stability === "not available" ? "Unknown frequency or phasor convention" : "No decaying oscillatory resonance"
            : formatFrequency(damping.linewidthFwhmHz)
        }
      />
      <FieldRow
        label="Q-factor"
        value={
          damping.qualityFactor == null
            ? damping.stability === "undamped" && damping.linewidthFwhmHz === 0 ? "Unbounded for this undamped oscillator" : damping.stability === "not available" ? "Unknown frequency or phasor convention" : "No finite resonance quality factor"
            : formatNumber(damping.qualityFactor)
        }
      />
    </>
  );
}

function EigenMode3DActions({
  settings,
  summary,
}: {
  settings: ReturnType<typeof useFrequencyDomainModeDisplaySettings>;
  summary: ReturnType<typeof useEigenModeSummary>;
}) {
  const kernel = useKernel();
  const plot = (view: string): void => {
    if (!summary.field3DReady) return;
    const animate = view === "animate";
    void kernel.commands.execute(
      animate
        ? "analysis.frequency-domain.set-3d-animation"
        : "analysis.eigen.plot-mode-3d",
      createCommandContext("inspector", kernel, {
        sourceDetail: "results.eigen.mode",
      }),
      {
        animatePhase: animate ? true : undefined,
        animationRateHz: animate ? settings.activeAnalysisFieldOverlay?.animation?.animationRateHz || 1 : undefined,
        fieldId: summary.fieldId,
        label: summary.physicalLabel,
        phaseRad: sameModeResultOwner(settings.activeAnalysisFieldOverlay?.modeIntent, summary.owner)
          ? settings.activeAnalysisFieldOverlay?.visualizationPhaseRad ?? 0 : 0,
        source: "eigen-mode",
        view: animate ? "phase_rotated_real" : view,
      },
    );
  };
  const stopAnimation = (): void => {
    if (!summary.field3DReady) return;
    void kernel.commands.execute(
      "analysis.frequency-domain.stop-3d-animation",
      createCommandContext("inspector", kernel, {
        sourceDetail: "results.eigen.mode",
      }),
    );
  };
  const disabled = !summary.field3DReady;

  return (
    <div
      aria-label="Selected eigen mode 3D visualization controls"
      className="fm-frequency-domain-visualization-actions"
    >
      <Button aria-label="Show selected eigen mode in 3D" className="fm-inspector-action-button" disabled={disabled} size="sm" title={disabled ? summary.field3DStatus : "Show the selected mode field"} variant="primary" onClick={() => plot(normalizeAnalysisFieldView(settings.view))}>
        Show mode in 3D
      </Button>
      <Button aria-label="Animate selected eigen mode phase in 3D" disabled={disabled} size="sm" variant="secondary" onClick={() => plot("animate")}><Play aria-hidden="true" size={13} /> Animate</Button>
      <Button
        aria-label="Stop selected eigen mode animation"
        className="fm-inspector-action-button"
        disabled={disabled || !sameModeResultOwner(settings.activeAnalysisFieldOverlay?.modeIntent, summary.owner)}
        size="sm"
        title={
          disabled ? summary.field3DStatus : "Stop selected eigen mode animation"
        }
        type="button"
        variant="secondary"
        onClick={stopAnimation}
      >
        <Pause aria-hidden="true" size={13} />
        <span>Stop</span>
      </Button>
      <Button aria-label="Show dispersion chart and selected mode together" disabled={disabled} size="sm" variant="secondary" onClick={async () => {
        const result = await kernel.commands.execute("ribbon.analysis.show-chart-and-field", createCommandContext("inspector", kernel));
        if (result.status === "completed") plot(normalizeAnalysisFieldView(settings.view));
      }}>Chart + mode</Button>
      <Button size="sm" variant="secondary" onClick={() => kernel.layout.setActiveViewportMainModule("analysis-plots")}>Back to chart</Button>
      {sameModeResultOwner(settings.activeAnalysisFieldOverlay?.modeIntent, summary.owner) ? <Button size="sm" variant="secondary" onClick={() => void kernel.commands.execute("viewport-3d.fit", createCommandContext("inspector", kernel, { sourceDetail: "results.eigen.mode" }))}>Fit mode</Button> : null}
    </div>
  );
}

function useEigenModeSummary(selection: InspectorPanelProps["selection"]) {
  const ref = selection.ref?.type === "frequency-domain" ? selection.ref : null;
  const sampleIndex = ref?.sampleIndex ?? null;
  const modeIndex = ref?.modeIndex ?? null;
  const { samples, spectrumModel, manifest } = useEigenModeBrowserData();
  const eigenMode = useFrequencyDomainEigenModeResource(sampleIndex, modeIndex);
  const fieldMeta = useFrequencyDomainEigenModeFieldMetaResource(
    sampleIndex,
    modeIndex,
  );
  const spectrumPoint = spectrumModel.points.find(
    (point) =>
      point.sampleIndex === sampleIndex && point.rawModeIndex === modeIndex,
  );
  const modePayload = readEigenModeResourcePayload(eigenMode.data, sampleIndex, modeIndex);
  const componentSummary = record(modePayload?.component_summary);
  const frequencyHz =
    finiteNumber(modePayload?.frequency_real_hz) ??
    spectrumPoint?.frequencyHz ??
    null;
  const imaginaryFrequencyHz =
    finiteNumber(modePayload?.frequency_imag_hz) ??
    spectrumPoint?.imaginaryFrequencyHz ??
    null;
  const angularFrequency = finiteNumber(modePayload?.angular_frequency_rad_per_s);
  const residual = buildEigenResidualSummary(
    modePayload,
    spectrumPoint?.residualNorm,
    spectrumPoint?.residualRelativeL2,
  );
  const tangentLeakage =
    finiteNumber(modePayload?.tangent_leakage_max_abs) ??
    spectrumPoint?.tangentLeakageMax ??
    null;
  const spectrumFieldAvailable =
    spectrumPoint == null || eigenModeFieldAvailable(spectrumPoint);
  const fieldId = spectrumFieldAvailable
    ? ref?.fieldId ?? fieldMeta.data?.field_id ?? spectrumPoint?.modeFieldId ?? null
    : null;
  const fieldResource = spectrumFieldAvailable
    ? ref?.resourceRef ??
      fieldMeta.data?.resource_key ??
      spectrumPoint?.modeFieldResourceKey ??
      null
    : null;
  const identity = buildEigenModeIdentityViewModel({
    branchId: ref?.branchId,
    fieldId,
    modeIndex,
    resourceRef: fieldResource,
    sampleIndex,
  });
  const availableViews = fieldMeta.data?.available_views ?? [];
  const defaultView = fieldMeta.data?.default_view ?? availableViews[0] ?? null;
  const dominantPolarization = stringValue(modePayload?.dominant_polarization);
  const realSamples = finiteNumber(componentSummary?.real_sample_count);
  const imagSamples = finiteNumber(componentSummary?.imag_sample_count);
  const fieldMetaRecord = record(fieldMeta.data);


  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const physics = record(manifestPayload?.physics);
  const rawPhasorConvention = resolveModalPhasorConvention(modePayload, physics);
  const phaseConvention = rawPhasorConvention ?? "Temporal phasor convention not published";
  const wavevector = ref?.wavevectorKf ?? modePayload?.k_vector;
  const wavevectorLabel = formatModeWavevector(wavevector);
  const certificate = record(modePayload?.block_residuals);
  const damping = modalDampingObservables(
    frequencyHz,
    imaginaryFrequencyHz,
    rawPhasorConvention,
  );
  const field3DReady =
    fieldMeta.status === "ready" && canPlotSelectedFieldIn3D(fieldMeta.data);
  const field3DStatus =
    fieldMeta.status === "ready"
      ? selectedField3DPlotStatus(fieldMeta.data)
      : fieldMeta.status === "loading"
        ? "mode field metadata loading"
        : fieldMeta.status === "error"
          ? "mode field metadata unavailable"
          : "mode field metadata not available";

  return {
    samples,
    owner: ref,
    wavevectorLabel,
    certificationTolerance: formatNumberOrUnavailable(finiteNumber(certificate?.certification_tolerance)),
    certificationStatus: certificate?.certified === true ? "Accepted for the reported residual scope" : certificate?.certified === false ? "Rejected" : "Not published",
    actionBadge: field3DReady ? "Mode field available" : "3D unavailable",
    angularFrequency:
      angularFrequency == null
        ? "not available"
        : `${formatNumber(angularFrequency)} rad/s`,
    availableViews: availableViews.length
      ? availableViews.join(", ")
      : "not available",
    availableViewValues: normalizedAnalysisFieldViewOptions(
      availableViews,
      defaultView,
    ),
    badge:
      sampleIndex == null || modeIndex == null
        ? "unselected"
        : eigenMode.status === "ready"
          ? `sample ${sampleIndex}, mode ${modeIndex}`
          : eigenMode.status,
    componentBasis: stringValue(fieldMetaRecord?.component_basis),
    componentCount: finiteNumber(fieldMetaRecord?.component_count),
    componentOptions:
      fieldMeta.status === "ready"
        ? modeFieldComponentOptions(fieldMeta.data)
        : [],
    dominantPolarization: dominantPolarization ?? "not available",
    defaultView: normalizeAnalysisFieldView(defaultView),
    defaultViewLabel: defaultView
      ? analysisFieldViewLabel(defaultView)
      : "not available",
    fieldId,
    fieldIdLabel: fieldId ?? "not available",
    fieldResource: fieldResource ?? "not available",
    field3DReady,
    field3DStatus,
    fieldStatus: fieldId
      ? `${fieldId}; ${
          fieldMeta.status === "ready"
            ? selectedField3DPlotStatus(fieldMeta.data)
            : "metadata unavailable"
        }`
      : "mode field missing",
    frequencyDisplay: formatFrequency(frequencyHz),
    imaginaryFrequency: formatFrequency(imaginaryFrequencyHz),
    damping,
    modeIdentity: identity.label,
    physicalLabel: modeResultLabel(wavevector, frequencyHz),
    phaseConvention,
    residual,
    tangentLeakageMax: formatNumberOrUnavailable(tangentLeakage),
    valueKind: stringValue(fieldMetaRecord?.value_kind),
    workflow:
      field3DReady && availableViews.length
        ? `phasor reconstruction; ${realSamples ?? "?"} real samples, ${imagSamples ?? "?"} imag samples`
        : field3DStatus,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return finiteModalScalar(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toPrecision(4);
}

function formatNumberOrUnavailable(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value)
    ? "not available"
    : formatNumber(value);
}

function formatFrequency(valueHz: number | null | undefined): string {
  return formatFrequencyHz(valueHz);
}

function normalizedAnalysisFieldViewOptions(
  availableViews: readonly string[] | null | undefined,
  defaultView: string | null | undefined,
): readonly string[] {
  const defaultValue = normalizeAnalysisFieldView(defaultView);
  const normalized = new Set<string>();
  for (const view of availableViews?.length
    ? availableViews
    : ["phase_rotated_real", "real", "imag", "abs", "phase"]) {
    const normalizedView = normalizeAnalysisFieldView(view);
    if (normalizedView !== defaultValue) normalized.add(normalizedView);
  }
  return [defaultValue, ...normalized];
}
