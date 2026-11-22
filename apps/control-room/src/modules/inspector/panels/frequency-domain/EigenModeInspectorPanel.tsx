"use client";

import { Activity, Pin, Play, RotateCw } from "lucide-react";

import { PIN_MODE_VISUALIZATION_COMMAND } from "@/kernel/analysis-modules/postprocessingCommandContributions";
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
import {
  buildEigenResidualSummary,
  readEigenModeResourcePayload,
  type EigenResidualSummary,
} from "@/shared/domain/analysis/eigenResidualSummary";
import { formatFrequencyHz } from "@/shared/domain/analysis/frequencyUnits";
import {
  finiteModalScalar,
  modalDampingObservables,
  resolveModalPhasorConvention,
  type ModalDampingObservables,
} from "@/shared/domain/analysis/modalDampingObservables";
import { modalSpectrumMatchesSelection } from "@/shared/domain/analysis/modalResultNodeIdentity";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import {
  canPlotSelectedFieldIn3D,
  modeFieldComponentOptions,
  selectedField3DPlotStatus,
} from "./FrequencyDomainHelpers";
import { FrequencyDomainModeDisplayControls, useFrequencyDomainModeDisplaySettings } from "../FrequencyDomainModeDisplayControls";
import { analysisFieldViewLabel, isActiveAnalysisFieldView, normalizeAnalysisFieldView } from "../FrequencyDomainModeDisplayControls.model";
import { buildEigenModeIdentityViewModel } from "./EigenModeInspectorPanel.model";

const EIGEN_MODE_3D_ACTIONS = [
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
      <InspectorGroup title={summary.modeIdentity} summary={summary.frequencyDisplay}>
        <FieldRow label="Mode field" value={summary.fieldStatus} />
        <EigenMode3DActions settings={modeDisplaySettings} summary={summary} />
      </InspectorGroup>
      <InspectorGroup collapsible title="Display">
        <FrequencyDomainModeDisplayControls
          componentOptions={summary.componentOptions}
          disabled={!summary.field3DReady}
          labelPrefix="Eigen mode"
          settings={modeDisplaySettings}
          viewDefaultValue={summary.defaultView}
          viewOptions={summary.availableViewValues}
        />
      </InspectorGroup>
      <InspectorGroup collapsible defaultOpen={false} title="Mode details">
        <FieldRow label="Imaginary frequency" value={summary.imaginaryFrequency} />
        <EigenModeDampingFields damping={summary.damping} />
        <FieldRow label="Angular frequency" value={summary.angularFrequency} />
        <EigenModeResidualFields residual={summary.residual} />
        <FieldRow label="Tangent leakage max" value={summary.tangentLeakageMax} />
        <FieldRow label="Dominant polarization" value={summary.dominantPolarization} />
        <FieldRow label="Phase convention" value={summary.phaseConvention} />
        <FieldRow label="Field ID" value={summary.fieldIdLabel} />
        <FieldRow label="Field resource" value={summary.fieldResource} />
      </InspectorGroup>
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
      <FieldRow
        label="Absolute residual (L2)"
        value={formatNumberOrUnavailable(residual.absoluteL2)}
      />
      <FieldRow
        label="Relative residual (L2)"
        value={formatNumberOrUnavailable(residual.relativeL2)}
      />
      <FieldRow label="Residual scope" value={residual.scope} />
      <FieldRow
        label="Spectrum residual (type unspecified)"
        value={formatNumberOrUnavailable(residual.reportedSpectrumResidual)}
      />
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
            ? "not available"
            : formatNumber(damping.lifetimeSeconds) + " s"
        }
      />
      <FieldRow
        label="Linewidth (FWHM)"
        value={
          damping.linewidthFwhmHz == null
            ? "not available"
            : formatFrequency(damping.linewidthFwhmHz)
        }
      />
      <FieldRow
        label="Q-factor"
        value={
          damping.qualityFactor == null
            ? "not available"
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
  const plot = (
    view:
      | "phase_rotated_real"
      | "real"
      | "imag"
      | "abs"
      | "phase"
      | "animate",
  ): void => {
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
    <div role="group"
      aria-label="Selected eigen mode 3D visualization controls"
      className="fm-frequency-domain-visualization-actions"
    >
      {EIGEN_MODE_3D_ACTIONS.map((entry) => {
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
            disabledReason={summary.field3DStatus}
            key={entry.view}
            size="sm"
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
        disabledReason={summary.field3DStatus}
        size="sm"
        type="button"
        variant="secondary"
        onClick={stopAnimation}
      >
        <RotateCw aria-hidden="true" size={13} />
        <span>Stop animate</span>
      </Button>
      <Button
        aria-label="Pin Mode Visualization"
        className="fm-inspector-action-button"
        disabled={!summary.fieldId}
        disabledReason="Mode field payload is required to pin a 3D visualization"
        size="sm"
        type="button"
        variant="secondary"
        onClick={() => {
          void kernel.commands.execute(
            PIN_MODE_VISUALIZATION_COMMAND,
            createCommandContext("inspector", kernel, {
              sourceDetail: "results.eigen.mode",
            }),
          );
        }}
      >
        <Pin aria-hidden="true" size={13} />
        <span>Pin Mode Visualization</span>
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
  const modePublication = eigenMode.status === "ready" && eigenMode.data?.status === "ready"
    ? eigenMode.data
    : null;
  const spectrumPublication = spectrum.status === "ready" && spectrum.data?.status === "ready"
    ? spectrum.data
    : null;
  const publication = modePublication ?? spectrumPublication;
  const publicationMatches = modalSpectrumMatchesSelection(publication, ref);
  const spectrumModel = buildEigenSpectrumChartModel(
    modalSpectrumMatchesSelection(spectrumPublication, ref) ? spectrumPublication : null,
  );
  const spectrumPoint = spectrumModel.points.find(
    (point) =>
      point.sampleIndex === sampleIndex && point.rawModeIndex === modeIndex,
  );
  const modePayload = modalSpectrumMatchesSelection(modePublication, ref)
    ? readEigenModeResourcePayload(modePublication, sampleIndex, modeIndex)
    : null;
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
  const phaseConvention =
    stringValue(record(fieldMetaRecord?.field_units)?.phase_convention) ??
    stringValue(record(modePayload?.metadata)?.phase_convention) ??
    "not available";

  const manifest = useFrequencyDomainManifestResource();
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const physics = record(manifestPayload?.physics);
  const rawPhasorConvention = resolveModalPhasorConvention(modePayload, physics);
  const damping = modalDampingObservables(
    frequencyHz,
    imaginaryFrequencyHz,
    rawPhasorConvention,
  );
  const generationId = publication?.generation_id ?? null;
  const field3DReady = publicationMatches && fieldMeta.status === "ready" &&
    (!generationId || fieldMeta.data?.generation_id === generationId) &&
    canPlotSelectedFieldIn3D(fieldMeta.data);
  const field3DStatus =
    fieldMeta.status === "ready"
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
    fieldStatus: !publicationMatches
      ? "Mode field unavailable for this run and stage"
      : fieldId
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
