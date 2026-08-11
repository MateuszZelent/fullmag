"use client";

import { Activity, Play, RotateCw } from "lucide-react";

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
  frequencyDomainManifestPayload,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import { formatFrequencyHz } from "@/shared/domain/analysis/frequencyUnits";
import { phasorAdapter } from "@/shared/domain/analysis/phasorConventionAdapter";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import {
  FrequencyDomainModeDisplayControls,
  analysisFieldViewLabel,
  isActiveAnalysisFieldView,
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
  const summary = useEigenModeSummary(selection);
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

  return (
    <div
      data-inspector-owner="frequency-domain.eigen-mode"
      data-inspector-surface="eigen-mode"
    >
      <InspectorGroup title="Eigen Mode Control" badge={summary.badge}>
        <FieldRow label="Canonical object" value="Eigenmodes mode" />
        <FieldRow label="Mode identity" value={summary.modeIdentity} />
        <FieldRow label="Frequency" value={summary.frequencyDisplay} />
        <FieldRow label="Imaginary frequency" value={summary.imaginaryFrequency} />
        <FieldRow label="Decay rate (Gamma)" value={summary.decayRate} />
        <FieldRow label="Linewidth (FWHM)" value={summary.linewidthFwhm} />
        <FieldRow label="Q-factor" value={summary.qualityFactor} />
        <FieldRow label="Angular frequency" value={summary.angularFrequency} />
        <FieldRow label="Mode field" value={summary.fieldStatus} />
        <FieldRow label="Mode field resource" value={summary.fieldResource} />
        <FieldRow label="Available field views" value={summary.availableViews} />
        <FieldRow label="Residual" value={summary.residual} />
        <FieldRow label="Tangent leakage max" value={summary.tangentLeakageMax} />
        <FieldRow label="Dominant polarization" value={summary.dominantPolarization} />
        <FieldRow label="3D workflow" value={summary.workflow} />
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
        <FrequencyDomainModeDisplayControls
          disabled={!summary.fieldId}
          labelPrefix="Eigen mode"
          settings={modeDisplaySettings}
          viewDefaultValue={summary.defaultView}
          viewOptions={summary.availableViewValues}
        />
        <EigenMode3DActions settings={modeDisplaySettings} summary={summary} />
      </InspectorGroup>
    </div>
  );
}

EigenModeInspectorPanel.displayName = "EigenModeInspectorPanel";

function EigenMode3DActions({
  settings,
  summary,
}: {
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
      | "phase"
      | "animate",
  ): void => {
    if (!summary.fieldId) return;
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
        animationRateHz: animate ? 1 : undefined,
        fieldId: summary.fieldId,
        label: summary.modeIdentity,
        phaseRad: 0,
        source: "eigen-mode",
        view: animate ? "phase_rotated_real" : view,
      },
    );
  };
  const stopAnimation = (): void => {
    if (!summary.fieldId) return;
    void kernel.commands.execute(
      "analysis.frequency-domain.stop-3d-animation",
      createCommandContext("inspector", kernel, {
        sourceDetail: "results.eigen.mode",
      }),
    );
  };
  const disabled = !summary.fieldId;
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
    {
      icon: Play,
      label: "Animate",
      title: "Animate selected eigen mode phase in 3D",
      variant: "secondary" as const,
      view: "animate" as const,
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
          entry.view !== "animate" &&
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
            title={disabled ? "Mode field payload is missing" : entry.title}
            type="button"
            variant={isActive ? "primary" : entry.variant}
            onClick={() => plot(entry.view)}
          >
            <Icon aria-hidden="true" size={13} />
            <span>{entry.label}</span>
          </Button>
        );
      })}
      <Button
        aria-label="Stop selected eigen mode animation"
        className="fm-inspector-action-button"
        disabled={disabled}
        size="sm"
        title={
          disabled
            ? "Mode field payload is missing"
            : "Stop selected eigen mode animation"
        }
        type="button"
        variant="secondary"
        onClick={stopAnimation}
      >
        <RotateCw aria-hidden="true" size={13} />
        <span>Stop animate</span>
      </Button>
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
  const modePayload = record(eigenMode.data);
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
  const residual =
    finiteNumber(modePayload?.residual_norm) ??
    spectrumPoint?.residualNorm ??
    null;
  const tangentLeakage =
    finiteNumber(modePayload?.tangent_leakage_max_abs) ??
    spectrumPoint?.tangentLeakageMax ??
    null;
  const fieldId =
    ref?.fieldId ??
    fieldMeta.data?.field_id ??
    spectrumPoint?.modeFieldId ??
    null;
  const fieldResource =
    ref?.resourceRef ??
    fieldMeta.data?.resource_key ??
    spectrumPoint?.modeFieldResourceKey ??
    null;
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

  return {
    actionBadge: fieldId ? "3D field ready" : "field missing",
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
    dominantPolarization: dominantPolarization ?? "not available",
    defaultView: normalizeAnalysisFieldView(defaultView),
    defaultViewLabel: defaultView
      ? analysisFieldViewLabel(defaultView)
      : "not available",
    fieldId,
    fieldIdLabel: fieldId ?? "not available",
    fieldResource: fieldResource ?? "not available",
    fieldStatus: fieldId ? `${fieldId}; field-ready` : "mode field missing",
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
    phaseConvention,
    residual: formatNumberOrUnavailable(residual),
    tangentLeakageMax: formatNumberOrUnavailable(tangentLeakage),
    valueKind: stringValue(fieldMetaRecord?.value_kind),
    workflow:
      fieldId && availableViews.length
        ? `phasor reconstruction; ${realSamples ?? "?"} real samples, ${imagSamples ?? "?"} imag samples`
        : "field payload required for 3D phasor field",
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
