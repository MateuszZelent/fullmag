"use client";

import { Activity, RotateCw } from "lucide-react";

import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import {
  useFrequencyDomainEigenModeFieldMetaResource,
  useFrequencyDomainEigenModeResource,
  useFrequencyDomainEigenSpectrumResource,
  useFrequencyDomainManifestResource,
} from "@/kernel/resources/studyRuntimeResources";
import {
  buildEigenSpectrumChartModel,
  eigenModeFieldAvailable,
  frequencyDomainManifestPayload,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import { buildEigenResidualSummary, readEigenModeResourcePayload } from "@/shared/domain/analysis/eigenResidualSummary";
import { formatFrequencyHz } from "@/shared/domain/analysis/frequencyUnits";
import { phasorAdapter } from "@/shared/domain/analysis/phasorConventionAdapter";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import {
  canPlotSelectedFieldIn3D,
  modeFieldComponentOptions,
  selectedField3DPlotStatus,
} from "./FrequencyDomainHelpers";
import { EigenModePhaseControls } from "./EigenModePhaseControls";
import {
  buildEigenModeIdentityViewModel,
  formatSignedWavevectorKf,
  isEigenModeInspectorSelection,
  isCurrentEigenModeOverlay,
  phaseRadForEigenModeViewChange,
  type EigenModeOverlayIdentity,
} from "./EigenModeInspectorModel";
import {
  FrequencyDomainModeDisplayControls,
  analysisFieldViewLabel,
  isActiveAnalysisFieldView,
  normalizeAnalysisFieldView,
  useFrequencyDomainModeDisplaySettings,
} from "../FrequencyDomainModeDisplayControls";

export function EigenModeInspectorPanel({
  selection,
}: InspectorPanelProps) {
  const summary = useEigenModeSummary(selection);
  const kernel = useKernel();
  const modeDisplaySettings = useFrequencyDomainModeDisplaySettings({
    activation: {
      commandId: "analysis.eigen.plot-mode-3d",
      componentBasis: summary.componentBasis,
      componentCount: summary.componentCount,
      defaultPhaseRad: 0,
      fieldId: summary.fieldId,
      label: summary.modeIdentity,
      source: "eigen-mode",
      valueKind: summary.valueKind,
    },
    sourceDetail: "results.eigen.mode",
  });
  const activeOverlay = modeDisplaySettings.activeAnalysisFieldOverlay;
  const activeOverlayMatchesSelection = isCurrentEigenModeOverlay(
    activeOverlay,
    summary.overlayIdentity,
  );
  const selectedOverlay = activeOverlayMatchesSelection ? activeOverlay : null;
  const phaseRad = phaseRadForEigenModeViewChange(
    activeOverlay,
    summary.overlayIdentity,
  );
  const phaseDisabledReason = !summary.field3DReady
    ? summary.field3DStatus
    : activeOverlay
      ? "A different field is active. Plot the selected eigen mode to enable its phase controls."
      : "Plot the selected eigen mode to enable phase controls; a newly plotted mode starts at 0°.";
  const componentLabel = selectedOverlay
    ? summary.componentOptions.find(
        (option) => option.value === modeDisplaySettings.component,
      )?.label ?? modeDisplaySettings.component
    : "not active for selected mode";
  const selectedAnimationRateHz = selectedOverlay?.animation?.animationRateHz;
  const visualCycleRateHz =
    selectedAnimationRateHz != null && selectedAnimationRateHz > 0
      ? selectedAnimationRateHz
      : 1;

  const setPhase = (nextPhaseRad: number): void => {
    if (!summary.field3DReady || !activeOverlayMatchesSelection) return;
    void kernel.commands.execute(
      "analysis.eigen.set-mode-3d-phase",
      createCommandContext("inspector", kernel, {
        sourceDetail: "results.eigen.mode",
      }),
      { phaseRad: nextPhaseRad },
    );
  };
  const setAnimation = (next: {
    animatePhase: boolean;
    animationRateHz: number;
  }): void => {
    if (!summary.field3DReady || !activeOverlayMatchesSelection) return;
    void kernel.commands.execute(
      "analysis.eigen.set-mode-3d-animation",
      createCommandContext("inspector", kernel, {
        sourceDetail: "results.eigen.mode",
      }),
      next,
    );
  };

  return (
    <div
      data-inspector-owner="frequency-domain.eigen-mode"
      data-inspector-surface="eigen-mode"
    >
      <InspectorGroup title="Selected eigen mode" badge={summary.badge}>
        <FieldRow label="Mode identity" value={summary.modeIdentity} />
        <FieldRow label="Sample ID" value={summary.sampleId} />
        <FieldRow label="Mode ID" value={summary.modeId} />
        <FieldRow label="Branch" value={summary.branchId} />
        <FieldRow label="Frequency" value={summary.frequencyDisplay} />
        <FieldRow label="Signed k vector" value={summary.wavevectorDisplay} />
        <FieldRow
          label="k-path coordinate"
          value={summary.kPathCoordinateDisplay}
        />
        <FieldRow
          label="Current view"
          value={
            selectedOverlay
              ? analysisFieldViewLabel(normalizeAnalysisFieldView(selectedOverlay.query.view))
              : "not active for selected mode"
          }
        />
        <FieldRow label="Current component" value={componentLabel} />
        <EigenModePhaseControls
          animatePhase={selectedOverlay?.animation?.animatePhase ?? false}
          animationRateHz={visualCycleRateHz}
          disabled={!summary.field3DReady || !activeOverlayMatchesSelection}
          disabledReason={
            !summary.field3DReady || !activeOverlayMatchesSelection
              ? phaseDisabledReason
              : null
          }
          phaseRad={phaseRad}
          onAnimationChange={setAnimation}
          onSetPhase={setPhase}
        />
      </InspectorGroup>
      <InspectorGroup
        title="Eigen Mode 3D Visualization"
        badge={summary.actionBadge}
      >
        <FieldRow label="Field ID" value={summary.fieldIdLabel} />
        <FieldRow label="Field resource" value={summary.fieldResource} />
        <FieldRow label="Default view" value={summary.defaultViewLabel} />
        <FieldRow label="Phase convention" value={summary.phaseConvention} />
        <FieldRow
          label="Shared style preset"
          value="one shared eigen/response mode visualization preset; switching modes keeps color, shader, vector, phase, and colormap controls"
        />
        <FieldRow
          label="Volume inspection roadmap"
          value="clip planes and shader opacity remain planned for internal-mode inspection"
        />
        {activeOverlayMatchesSelection ? (
          <FrequencyDomainModeDisplayControls
            componentOptions={summary.componentOptions}
            disabled={!summary.field3DReady}
            labelPrefix="Eigen mode"
            settings={modeDisplaySettings}
            viewDefaultValue={summary.defaultView}
            viewOptions={summary.availableViewValues}
          />
        ) : (
          <small role="status">
            {summary.field3DReady
              ? "Plot the selected eigen mode to change its current view or component."
              : summary.field3DStatus}
          </small>
        )}
        <EigenMode3DActions
          currentOverlayMatchesSelection={activeOverlayMatchesSelection}
          settings={modeDisplaySettings}
          summary={summary}
        />
      </InspectorGroup>
      <InspectorGroup title="Eigen Mode Control" badge={summary.badge}>
        <FieldRow label="Canonical object" value="Eigenmodes mode" />
        <FieldRow label="Imaginary frequency" value={summary.imaginaryFrequency} />
        <FieldRow label="Decay rate (Gamma)" value={summary.decayRate} />
        <FieldRow label="Linewidth (FWHM)" value={summary.linewidthFwhm} />
        <FieldRow label="Q-factor" value={summary.qualityFactor} />
        <FieldRow label="Angular frequency" value={summary.angularFrequency} />
        <FieldRow label="Mode field" value={summary.fieldStatus} />
        <FieldRow label="Mode field resource" value={summary.fieldResource} />
        <FieldRow label="Available field views" value={summary.availableViews} />
        <FieldRow label="Absolute residual (L2)" value={summary.residualAbsoluteL2} />
        <FieldRow label="Relative residual (L2)" value={summary.residualRelativeL2} />
        <FieldRow label="Residual scope" value={summary.residualScope} />
        <FieldRow label="Spectrum residual (type unspecified)" value={summary.residualSpectrumReported} />
        <FieldRow label="Tangent leakage max" value={summary.tangentLeakageMax} />
        <FieldRow label="Dominant polarization" value={summary.dominantPolarization} />
        <FieldRow label="3D workflow" value={summary.workflow} />
      </InspectorGroup>
    </div>
  );
}

EigenModeInspectorPanel.displayName = "EigenModeInspectorPanel";

function EigenMode3DActions({
  currentOverlayMatchesSelection,
  settings,
  summary,
}: {
  currentOverlayMatchesSelection: boolean;
  settings: ReturnType<typeof useFrequencyDomainModeDisplaySettings>;
  summary: ReturnType<typeof useEigenModeSummary>;
}) {
  const kernel = useKernel();
  const plot = (
    view:
      | "phase_rotated_real"
      | "real"
      | "imag"
      | "abs"
      | "phase",
  ): void => {
    if (!summary.field3DReady) return;
    if (currentOverlayMatchesSelection) {
      settings.setView(view);
      return;
    }
    void kernel.commands.execute(
      "analysis.eigen.plot-mode-3d",
      createCommandContext("inspector", kernel, {
        sourceDetail: "results.eigen.mode",
      }),
      {
        fieldId: summary.fieldId,
        label: summary.modeIdentity,
        phaseRad: 0,
        source: "eigen-mode",
        view,
      },
    );
  };
  const disabled = !summary.field3DReady;
  const actions = [
    {
      icon: RotateCw,
      label: "Rotated",
      title: "Plot selected eigen mode with phase-rotated real display",
      variant: "secondary" as const,
      view: "phase_rotated_real" as const,
    },
    {
      icon: Activity,
      label: "Real",
      title: "Plot selected eigen mode real component",
      variant: "secondary" as const,
      view: "real" as const,
    },
    {
      icon: Activity,
      label: "Imag",
      title: "Plot selected eigen mode imaginary component",
      variant: "secondary" as const,
      view: "imag" as const,
    },
    {
      icon: Activity,
      label: "Abs",
      title: "Plot selected eigen mode complex magnitude",
      variant: "secondary" as const,
      view: "abs" as const,
    },
    {
      icon: RotateCw,
      label: "Phase",
      title: "Plot selected eigen mode phase",
      variant: "secondary" as const,
      view: "phase" as const,
    },
  ];

  return (
    <div
      aria-label="Selected eigen mode 3D visualization controls"
      className="fm-frequency-domain-visualization-actions"
    >
      {actions.map((entry) => {
        const Icon = entry.icon;
        const isActive =
          currentOverlayMatchesSelection &&
          isActiveAnalysisFieldView(
            settings,
            summary.fieldId,
            "eigen-mode",
            entry.view,
          );
        return (
          <Button
            aria-label={entry.title}
            aria-pressed={isActive}
            className="fm-inspector-action-button"
            disabled={disabled}
            key={entry.view}
            size="sm"
            title={disabled ? summary.field3DStatus : entry.title}
            type="button"
            variant={isActive ? "primary" : entry.variant}
            onClick={() => plot(entry.view)}
          >
            <Icon aria-hidden="true" size={13} />
            <span>{entry.label}</span>
          </Button>
        );
      })}
    </div>
  );
}

function useEigenModeSummary(selection: InspectorPanelProps["selection"]) {
  const ref = selection.ref?.type === "frequency-domain" ? selection.ref : null;
  const sampleIndex = ref?.sampleIndex ?? null;
  const modeIndex = ref?.modeIndex ?? null;
  const spectrum = useFrequencyDomainEigenSpectrumResource();
  const eigenMode = useFrequencyDomainEigenModeResource(sampleIndex, modeIndex);
  const fieldMeta = useFrequencyDomainEigenModeFieldMetaResource(
    sampleIndex,
    modeIndex,
  );
  const spectrumModel = buildEigenSpectrumChartModel(spectrum.data);
  const spectrumPoint = spectrumModel.points.find(
    (point) =>
      point.sampleIndex === sampleIndex && point.rawModeIndex === modeIndex,
  );
  const modePayload = readEigenModeResourcePayload(eigenMode.data, sampleIndex, modeIndex);
  const componentSummary = record(modePayload?.component_summary);
  const frequencyHz =
    finiteNumber(ref?.frequencyHz) ??
    finiteNumber(modePayload?.frequency_real_hz) ??
    spectrumPoint?.frequencyHz ??
    null;
  const imaginaryFrequencyHz =
    finiteNumber(modePayload?.frequency_imag_hz) ??
    spectrumPoint?.imaginaryFrequencyHz ??
    null;
  const angularFrequency = finiteNumber(modePayload?.angular_frequency_rad_per_s);
  const residual = buildEigenResidualSummary(modePayload, spectrumPoint?.residualNorm);
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
    modeId: ref?.modeId,
    modeIndex,
    resourceRef: fieldResource,
    sampleId: ref?.sampleId,
    sampleIndex,
  });
  const overlayIdentity: EigenModeOverlayIdentity = {
    analysisRunId: ref?.analysisRunId ?? null,
    analysisStageId: ref?.analysisStageId ?? null,
    artifactRevision: ref?.artifactRevision ?? null,
    fieldId,
    frequencyHz: finiteNumber(ref?.frequencyHz),
    kPathCoordinateRadPerM: finiteNumber(ref?.kPathCoordinateRadPerM),
    modeId: ref?.modeId ?? null,
    modeIndex,
    nodeId: ref?.nodeId ?? null,
    sampleId: ref?.sampleId ?? null,
    sampleIndex,
    wavevectorKf: ref?.wavevectorKf ?? null,
  };
  const availableViews = fieldMeta.data?.available_views ?? [];
  const defaultView = fieldMeta.data?.default_view ?? availableViews[0] ?? null;
  const dominantPolarization = stringValue(modePayload?.dominant_polarization);
  const realSamples = finiteNumber(componentSummary?.real_sample_count);
  const imagSamples = finiteNumber(componentSummary?.imag_sample_count);
  const fieldMetaRecord = record(fieldMeta.data);
  const phaseConvention =
    stringValue(record(fieldMetaRecord?.field_units)?.phase_convention) ??
    stringValue(record(modePayload?.metadata)?.phase_convention) ??
    "exp(-i omega t)";

  const manifest = useFrequencyDomainManifestResource();
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const physics = record(manifestPayload?.physics);
  const rawPhasorConvention =
    stringValue(physics?.phase_convention) ?? "exp_i_omega_t";
  const phasorConv = rawPhasorConvention.includes("exp_minus")
    ? "exp_minus_i_omega_t"
    : "exp_i_omega_t";
  const { decayRateSign } = phasorAdapter(phasorConv);

  const decayRateHz =
    imaginaryFrequencyHz != null ? decayRateSign * imaginaryFrequencyHz : null;
  const linewidthFwhmHz =
    decayRateHz != null ? 2 * Math.abs(decayRateHz) : null;
  const qualityFactor =
    frequencyHz != null && linewidthFwhmHz && linewidthFwhmHz > 0
      ? frequencyHz / linewidthFwhmHz
      : null;
  const identityReady = isEigenModeInspectorSelection(ref?.kind, overlayIdentity);
  const field3DReady =
    identityReady &&
    fieldMeta.status === "ready" &&
    canPlotSelectedFieldIn3D(fieldMeta.data);
  const field3DStatus = !identityReady
    ? "selected eigen mode identity incomplete"
    : fieldMeta.status === "ready"
      ? selectedField3DPlotStatus(fieldMeta.data)
      : fieldMeta.status === "loading"
        ? "mode field metadata loading"
        : fieldMeta.status === "error"
          ? "mode field metadata unavailable"
          : "mode field metadata not available";

  return {
    actionBadge: field3DReady ? "3D field ready" : "3D unavailable",
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
    decayRate:
      decayRateHz == null ? "not available" : formatFrequency(decayRateHz),
    linewidthFwhm:
      linewidthFwhmHz == null
        ? "not available"
        : formatFrequency(linewidthFwhmHz),
    qualityFactor:
      qualityFactor == null ? "not available" : formatNumber(qualityFactor),
    modeIdentity: identity.label,
    modeId: identity.modeId ?? "not available",
    overlayIdentity,
    branchId: identity.branchId ?? "not available",
    sampleId: identity.sampleId ?? "not available",
    wavevectorDisplay: formatSignedWavevectorKf(ref?.wavevectorKf),
    kPathCoordinateDisplay:
      overlayIdentity.kPathCoordinateRadPerM === null
        ? "not available"
        : `${formatNumber(overlayIdentity.kPathCoordinateRadPerM)} rad/m`,
    phaseConvention,
    residualAbsoluteL2: formatNumberOrUnavailable(residual.absoluteL2),
    residualRelativeL2: formatNumberOrUnavailable(residual.relativeL2),
    residualScope: residual.scope,
    residualSpectrumReported: formatNumberOrUnavailable(residual.reportedSpectrumResidual),
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
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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
