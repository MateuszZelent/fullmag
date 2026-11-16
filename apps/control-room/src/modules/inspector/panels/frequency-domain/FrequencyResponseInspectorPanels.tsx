"use client";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { StudyProgressBar } from "../StudyProgressBar";
import { Activity, Play, RotateCw } from "lucide-react";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import { useFrequencyDomainManifestResource } from "@/kernel/resources/studyRuntimeResources";
import { frequencyDomainManifestPayload } from "@/shared/domain/analysis/frequencyDomainChartModels";
import type { FrequencyResponsePoint } from "@/shared/domain/analysis/frequencyDomainChartModels";
import { Button } from "@/shared/ui/Button";
import {
  FrequencyDomainModeDisplayControls,
  isActiveAnalysisFieldView,
  useFrequencyDomainModeDisplaySettings,
} from "../FrequencyDomainModeDisplayControls";
import { FrequencyDomainResponseChart } from "../FrequencyDomainCharts";
import {
  FrequencyDomainResponsePointTable,
  type FrequencyDomainResponsePointAction,
} from "../FrequencyDomainTables";
import {
  FrequencyResponsePointResidualFields,
  useFrequencyResponsePointSummary,
  useFrequencyResponseFrequencyPointsSummary,
  useFrequencyResponseProgressSummary,
  useFrequencyResponseCancelRequestedSummary,
  useFrequencyResponseObservableSummary,
  useFrequencyResponseSweepSummary,
  useFrequencyResponseDiagnosticsSummary,
} from "./frequencyDomainResponseSummaries";
import {
  record,
  isDrivenExcitationMissing,
  formatFrequency,
} from "./frequencyDomainResultFormatting";

export function buildFrequencyResponsePlotCommandInput({
  fieldId,
  frequencyIndex,
  label,
  phaseRad,
  view,
}: {
  fieldId: string;
  frequencyIndex?: number | null;
  label: string;
  phaseRad: number;
  view: FrequencyDomainResponsePointAction;
}) {
  return {
    fieldId,
    ...(frequencyIndex == null ? {} : { frequencyIndex }),
    label,
    phaseRad,
    source: "frequency-response" as const,
    view,
  };
}

// ---------------------------------------------------------------------------
// Primary result inspector panels — these are referenced by name in the
// registry and tests. The FMR/eigen/response panels below are dedicated
// surfaces; generic fallback is kept only for still-transitional groups.
// ---------------------------------------------------------------------------

export function FrequencyResponsePointInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useFrequencyResponsePointSummary(props);
  const modeDisplaySettings = useFrequencyDomainModeDisplaySettings({
    activation: {
      commandId: "analysis.frequency-response.plot-response-field-3d",
      componentBasis: summary.componentBasis,
      componentCount: summary.componentCount,
      defaultPhaseRad: summary.defaultPhaseRad,
      fieldId: summary.fieldId,
      label: summary.frequencyDisplay,
      source: "frequency-response",
      valueKind: summary.valueKind,
    },
    sourceDetail: "results.frequency_response.frequency_point",
  });

  return (
    <div data-inspector-surface="frequency-response-point">
      <InspectorGroup
        title="Response Frequency Point Control"
        badge={summary.badge}
      >
        <FieldRow label="Canonical object" value="FrequencyResponse point" />
        <FieldRow label="Frequency" value={summary.frequencyDisplay} />
        <FieldRow label="Resource" value={summary.resourceKey} />
        <FieldRow label="Artifact" value={summary.artifactPath} />
        <FieldRow label="Observable rows" value={summary.observableRows} />
        <FieldRow label="Response amplitude" value={summary.amplitude} />
        <FieldRow label="Response phase" value={summary.phase} />
        <FieldRow
          label="Absorbed power density"
          value={summary.absorbedPowerDensity}
        />
        <FrequencyResponsePointResidualFields residuals={summary.residuals} />
        <FieldRow label="3D field" value={summary.fieldStatus} />
        <FieldRow label="Available field views" value={summary.availableViews} />
        <FieldRow label="Provenance" value={summary.provenance} />
      </InspectorGroup>
      <InspectorGroup
        title="Response Point 3D Visualization"
        badge={summary.actionBadge}
      >
        <FieldRow label="Field ID" value={summary.fieldIdLabel} />
        <FieldRow label="Field resource" value={summary.fieldResource} />
        <FieldRow label="Default view" value={summary.defaultViewLabel} />
        <FieldRow label="Default phase" value={summary.defaultPhaseLabel} />
        <FieldRow
          label="Complex response convention"
          value="phasor response; view controls select real, imaginary, magnitude, phase, or phase-rotated real"
        />
        <FrequencyDomainModeDisplayControls
          componentOptions={summary.componentOptions}
          disabled={!summary.field3DReady}
          labelPrefix="Response point"
          settings={modeDisplaySettings}
          viewDefaultValue={summary.defaultView}
          viewOptions={summary.availableViewValues}
        />
        <FrequencyResponsePoint3DActions
          settings={modeDisplaySettings}
          summary={summary}
        />
      </InspectorGroup>
    </div>
  );
}

function FrequencyResponsePoint3DActions({
  settings,
  summary,
}: {
  settings: ReturnType<typeof useFrequencyDomainModeDisplaySettings>;
  summary: ReturnType<typeof useFrequencyResponsePointSummary>;
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
        : "analysis.frequency-response.plot-response-field-3d",
      createCommandContext("inspector", kernel, {
        sourceDetail: "results.frequency_response.frequency_point",
      }),
      {
        animatePhase: animate ? true : undefined,
        animationRateHz: animate ? 1 : undefined,
        fieldId: summary.fieldId,
        frequencyIndex: summary.frequencyIndex,
        label: summary.frequencyDisplay,
        phaseRad: summary.defaultPhaseRad,
        source: "frequency-response",
        view: animate ? "phase_rotated_real" : view,
      },
    );
  };
  const stopAnimation = (): void => {
    if (!summary.field3DReady) return;
    void kernel.commands.execute(
      "analysis.frequency-domain.stop-3d-animation",
      createCommandContext("inspector", kernel, {
        sourceDetail: "results.frequency_response.frequency_point",
      }),
    );
  };
  const disabled = !summary.field3DReady;
  const actions = [
    {
      icon: RotateCw,
      label: "Rotated",
      title: "Plot response field with phase-rotated real display",
      variant: "secondary" as const,
      view: "phase_rotated_real" as const,
    },
    {
      icon: Activity,
      label: "Real",
      title: "Plot response field real component",
      variant: "secondary" as const,
      view: "real" as const,
    },
    {
      icon: Activity,
      label: "Imag",
      title: "Plot response field imaginary component",
      variant: "secondary" as const,
      view: "imag" as const,
    },
    {
      icon: Activity,
      label: "Abs",
      title: "Plot response field complex magnitude",
      variant: "secondary" as const,
      view: "abs" as const,
    },
    {
      icon: RotateCw,
      label: "Phase",
      title: "Plot response field phase",
      variant: "secondary" as const,
      view: "phase" as const,
    },
    {
      icon: Play,
      label: "Animate",
      title: "Animate response field phase in 3D",
      variant: "secondary" as const,
      view: "animate" as const,
    },
  ];

  return (
    <div role="group"
      aria-label="Response point 3D visualization controls"
      className="fm-frequency-domain-visualization-actions"
    >
      {actions.map((entry) => {
        const Icon = entry.icon;
        const isActive =
          entry.view !== "animate" &&
          isActiveAnalysisFieldView(
            settings,
            summary.fieldId,
            "frequency-response",
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
      <Button
        aria-label="Stop response field animation"
        className="fm-inspector-action-button"
        disabled={disabled}
        size="sm"
        title={disabled ? summary.field3DStatus : "Stop response field animation"}
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

export function FrequencyResponseFrequencyPointsInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  return <FrequencyResponsePointCollection surface="frequency-points" />;
}

export function FrequencyResponseFieldsInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  return <FrequencyResponsePointCollection surface="response-fields" />;
}

function FrequencyResponsePointCollection({
  surface,
}: {
  surface: "frequency-points" | "response-fields";
}) {
  const summary = useFrequencyResponseFrequencyPointsSummary();
  const kernel = useKernel();
  const plotPoint = (
    point: FrequencyResponsePoint,
    action: FrequencyDomainResponsePointAction,
  ): void => {
    if (!point.fieldId) return;
    void kernel.commands.execute(
      "analysis.frequency-response.plot-response-field-3d",
      createCommandContext("inspector", kernel, {
        sourceDetail: "results.frequency_response.frequency_points",
      }),
      buildFrequencyResponsePlotCommandInput({
        fieldId: point.fieldId,
        frequencyIndex: point.frequencyIndex,
        label: `response ${formatFrequency(point.frequencyHz)}`,
        phaseRad: 0,
        view: action,
      }),
    );
  };

  return (
    <div data-inspector-surface={`frequency-response-${surface}`}>
      <InspectorGroup
        title={surface === "response-fields" ? "Response Field Resources" : "Response Frequency Points Table"}
        badge={summary.badge}
      >
        <FieldRow
          label="Canonical collection"
          value="FrequencyResponse solved points"
        />
        <FieldRow label="Sweep resource" value={summary.resourceKey} />
        <FieldRow label="Solved frequencies" value={summary.solvedFrequencies} />
        <FieldRow label="Frequency range" value={summary.frequencyRange} />
        <FieldRow label="Amplitude range" value={summary.amplitudeRange} />
        <FieldRow label="Residual coverage" value={summary.residualCoverage} />
        <FieldRow label="Field payloads" value={summary.fieldOverlays} />
        <FieldRow label="Progress state" value={summary.progressState} />
        <FieldRow label="Cancellation state" value={summary.cancellationState} />
        <FieldRow label="3D workflow" value={summary.workflow} />
      </InspectorGroup>
      <InspectorGroup
        title={surface === "response-fields" ? "Available Response Fields" : "Response Frequency Point Table"}
        badge={summary.badge}
      >
        <FrequencyDomainResponsePointTable
          absorbedPowerDensityUnit={summary.absorbedPowerDensityUnit}
          amplitudeUnit={summary.amplitudeUnit}
          onPlotResponsePoint={plotPoint}
          points={summary.responseModel.points}
        />
      </InspectorGroup>
    </div>
  );
}

export function FrequencyResponseProgressInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useFrequencyResponseProgressSummary();

  return (
    <div data-inspector-surface="frequency-response-progress">
      <InspectorGroup title="Response Sweep Progress" badge={summary.badge}>
        <StudyProgressBar
          label="Frequency response sweep progress"
          statusLabel={summary.progressLabel}
          value={summary.progressPercent}
        />
        <FieldRow label="Resource" value={summary.resourceKey} />
        <FieldRow label="Status" value={summary.status} />
        <FieldRow label="Progress" value={summary.progress} />
        <FieldRow label="Current frequency" value={summary.currentFrequency} />
        <FieldRow label="Frequency range" value={summary.frequencyRange} />
        <FieldRow label="Solver progress" value={summary.solverProgress} />
        <FieldRow label="Complete" value={summary.complete} />
        <FieldRow label="Partial artifacts" value={summary.partialArtifacts} />
        <FieldRow
          label="Written point artifacts"
          value={summary.writtenArtifacts}
        />
        <FieldRow label="Latest manifest" value={summary.latestManifest} />
        <FieldRow label="Reason" value={summary.reason} />
      </InspectorGroup>
    </div>
  );
}

export function FrequencyResponseCancelRequestedInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useFrequencyResponseCancelRequestedSummary();

  return (
    <div data-inspector-surface="frequency-response-cancel-requested">
      <InspectorGroup
        title="Response Sweep Cancellation"
        badge={summary.badge}
      >
        <FieldRow label="Resource" value={summary.resourceKey} />
        <FieldRow label="Status" value={summary.status} />
        <FieldRow label="Progress" value={summary.progress} />
        <FieldRow label="Current frequency" value={summary.currentFrequency} />
        <FieldRow label="Frequency range" value={summary.frequencyRange} />
        <FieldRow label="Solver progress" value={summary.solverProgress} />
        <FieldRow label="Complete" value={summary.complete} />
        <FieldRow label="Partial artifacts" value={summary.partialArtifacts} />
        <FieldRow
          label="Written point artifacts"
          value={summary.writtenArtifacts}
        />
        <FieldRow label="Latest manifest" value={summary.latestManifest} />
        <FieldRow label="Reason" value={summary.reason} />
      </InspectorGroup>
    </div>
  );
}

export function FrequencyResponseObservableInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useFrequencyResponseObservableSummary(props);

  return (
    <div data-inspector-surface="frequency-response-observable">
      <InspectorGroup
        title="Response Observable Control"
        badge={summary.badge}
      >
        <FieldRow label="Selected Response Observable" value={summary.observableId} />
        <FieldRow label="Canonical object" value="FrequencyResponse observable" />
        <FieldRow label="Observable" value={summary.observableId} />
        <FieldRow label="Sweep resource" value={summary.resourceKey} />
        <FieldRow label="Frequency range" value={summary.frequencyRange} />
        <FieldRow label="Point count" value={summary.pointCount} />
        <FieldRow label="Mean amplitude" value={summary.meanAmplitude} />
        <FieldRow label="Peak amplitude" value={summary.peakAmplitude} />
        <FieldRow label="Phase range" value={summary.phaseRange} />
        <FieldRow
          label="Max absorbed power density"
          value={summary.maxAbsorbedPowerDensity}
        />
        <FieldRow label="Field payloads" value={summary.fieldOverlayStatus} />
        <FieldRow label="Chart series" value={summary.chartSeriesStatus} />
      </InspectorGroup>
    </div>
  );
}

export function FrequencyResponseObservablesInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useFrequencyResponseSweepSummary();

  return (
    <div data-inspector-surface="frequency-response-observables">
      <InspectorGroup
        title="Frequency Response Observables"
        badge={summary.seriesStatus}
      >
        <FieldRow label="Observable series" value={summary.seriesStatus} />
        <FieldRow label="Frequency range" value={summary.frequencyRange} />
        <FieldRow label="Frequency points" value={summary.pointCount} />
        <FieldRow label="Field payloads" value={summary.fieldOverlayStatus} />
        <FieldRow label="Peak response" value={summary.peakResponse} />
      </InspectorGroup>
    </div>
  );
}

export function FrequencyResponseSweepInspectorPanel(props: InspectorPanelProps) {
  void props;
  const manifest = useFrequencyDomainManifestResource();
  const manifestPayload = record(frequencyDomainManifestPayload(manifest.data));
  const missingExcitation = isDrivenExcitationMissing(manifestPayload);

  const summary = useFrequencyResponseSweepSummary();
  const kernel = useKernel();
  const plotPoint = (point: FrequencyResponsePoint): void => {
    if (!point.fieldId) return;
    void kernel.commands.execute(
      "analysis.frequency-response.plot-response-field-3d",
      createCommandContext("inspector", kernel, {
        sourceDetail: "results.frequency_response.sweep",
      }),
      buildFrequencyResponsePlotCommandInput({
        fieldId: point.fieldId,
        frequencyIndex: point.frequencyIndex,
        label: `response ${formatFrequency(point.frequencyHz)}`,
        phaseRad: 0,
        view: "phase_rotated_real",
      }),
    );
  };

  if (missingExcitation) {
    return (
      <div data-inspector-surface="frequency-response-sweep">
        <InspectorGroup title="Driven Response Validation" badge="blocking">
          <div className="fm-inspector-alert fm-alert-danger">
            <div className="fm-fd-alert__title">Drive source: missing</div>
            <div className="fm-fd-alert__row"><strong>Severity:</strong> blocking</div>
            <div className="fm-fd-alert__row"><strong>Message:</strong> Frequency-domain response requires a dynamic perturbation δh. Without excitation, the response is identically zero.</div>
            <div className="fm-fd-alert__row"><strong>Action:</strong> Add drive source</div>
          </div>
        </InspectorGroup>
      </div>
    );
  }

  return (
    <div data-inspector-surface="frequency-response-sweep">
      <InspectorGroup
        title="Driven Response Sweep Control"
        badge={summary.badge}
      >
        <FieldRow label="Canonical object" value="FrequencyResponse sweep" />
        <FieldRow label="Sweep resource" value={summary.resourceKey} />
        <FieldRow label="Frequency range" value={summary.frequencyRange} />
        <FieldRow label="Frequency points" value={summary.pointCount} />
        <FieldRow label="Observable series" value={summary.seriesStatus} />
        <FieldRow
          label="Response series controls"
          value={summary.responseSeriesControls}
        />
        <FieldRow
          label="Susceptibility component"
          value={summary.susceptibilityComponent}
        />
        <FieldRow label="Phase coverage" value={summary.phaseCoverage} />
        <FieldRow
          label="Absorbed-power coverage"
          value={summary.absorbedPowerCoverage}
        />
        <FieldRow label="Peak response" value={summary.peakResponse} />
        <FieldRow
          label="Max absorbed power density"
          value={summary.maxAbsorbedPowerDensity}
        />
        <FieldRow label="Field payloads" value={summary.fieldOverlayStatus} />
        <FieldRow label="Progress state" value={summary.progressState} />
        <FieldRow label="Cancellation state" value={summary.cancellationState} />
      </InspectorGroup>
      <InspectorGroup title="Driven Response Chart" badge={summary.badge}>
        <FrequencyDomainResponseChart
          model={summary.responseModel}
          onPlotPoint={plotPoint}
        />
      </InspectorGroup>
      <InspectorGroup
        title="Driven Response Point Table"
        badge={summary.badge}
      >
        <FrequencyDomainResponsePointTable
          absorbedPowerDensityUnit={summary.absorbedPowerDensityUnit}
          amplitudeUnit={summary.amplitudeUnit}
          onPlotResponsePoint={(point, action) => {
            if (!point.fieldId) return;
            void kernel.commands.execute(
              "analysis.frequency-response.plot-response-field-3d",
              createCommandContext("inspector", kernel, {
                sourceDetail: "results.frequency_response.sweep",
              }),
              buildFrequencyResponsePlotCommandInput({
                fieldId: point.fieldId,
                frequencyIndex: point.frequencyIndex,
                label: `response ${formatFrequency(point.frequencyHz)}`,
                phaseRad: 0,
                view: action,
              }),
            );
          }}
          points={summary.responseModel.points}
        />
      </InspectorGroup>
    </div>
  );
}

export function FrequencyResponseDiagnosticsInspectorPanel(
  props: InspectorPanelProps,
) {
  void props;
  const summary = useFrequencyResponseDiagnosticsSummary();

  return (
    <div data-inspector-surface="frequency-response-diagnostics">
      <InspectorGroup
        title="Frequency Response Diagnostics"
        badge={summary.badge}
      >
        <FieldRow
          label="Driven availability"
          value={summary.drivenAvailability}
        />
        <FieldRow label="Sweep progress" value={summary.sweepProgress} />
        <FieldRow label="Cancel state" value={summary.cancelState} />
        <FieldRow label="Response fields" value={summary.responseFields} />
        <FieldRow
          label="Krylov preconditioner"
          value={summary.krylovPreconditioner}
        />
        <FieldRow label="Residual coverage" value={summary.residualCoverage} />
        <FieldRow label="Response artifact" value={summary.responseArtifact} />
        <FieldRow label="Capability summary" value={summary.capabilitySummary} />
      </InspectorGroup>
    </div>
  );
}
