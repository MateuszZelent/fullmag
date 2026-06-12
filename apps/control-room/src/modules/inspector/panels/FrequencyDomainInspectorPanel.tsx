"use client";

import { useRef, useState } from "react";

import {
  ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH,
  MESHING_PERIODIC_PAIRS_PATH,
} from "@/kernel/api/apiPaths";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import {
  useFrequencyDomainEigenModeFieldMetaResource,
  useFrequencyDomainEigenModeResource,
  useFrequencyDomainEigenBranchesResource,
  useFrequencyDomainEigenDispersionResource,
  useFrequencyDomainEigenSpectrumResource,
  useFrequencyDomainManifestResource,
  useFrequencyDomainResponseFieldMetaResource,
  useFrequencyDomainResponseCancelRequestedResource,
  useFrequencyDomainResponseFrequencyPointResource,
  useFrequencyDomainResponseProgressResource,
  useFrequencyDomainResponseSweepResource,
  useMeshPeriodicPairsResource,
} from "@/kernel/resources/studyRuntimeResources";
import {
  buildEigenDispersionChartModel,
  buildEigenBranchesModel,
  buildEigenSpectrumChartModel,
  buildFrequencyResponseChartModel,
  routeFrequencyDomainCalculationMode,
} from "@/shared/domain/analysis/frequencyDomainChartModels";

import type { InspectorPanelProps } from "../inspectorTypes";
import { FieldRow } from "../primitives/FieldRow";
import { InspectorSection } from "../primitives/InspectorSection";

const DEFAULT_ANALYSIS_FIELD_VIEW = "phase_rotated_real";
const ANALYSIS_FIELD_VIEW_OPTIONS = [
  DEFAULT_ANALYSIS_FIELD_VIEW,
  "real",
  "imag",
  "amplitude",
  "phase",
] as const;

function formatBoolean(value: boolean | null | undefined): string {
  if (value === true) return "yes";
  if (value === false) return "no";
  return "not available";
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "resource load failed";
}

function familyLabel(kind: string | null): string {
  if (!kind) return "Frequency-domain";
  if (kind.startsWith("results.eigen")) return "Modal eigen / dispersion";
  if (kind.startsWith("results.frequency_response")) {
    return "Driven frequency response";
  }
  if (kind.startsWith("resources.analysis.eigen")) return "Eigen resource";
  if (kind.startsWith("resources.analysis.frequency_response")) {
    return "Frequency-response resource";
  }
  if (kind === "resources.mesh.periodic_pairs") {
    return "Periodic / Floquet mesh resource";
  }
  if (kind.startsWith("jobs.frequency_domain")) return "Frequency-domain job";
  if (kind.startsWith("diagnostics.frequency_domain")) {
    return "Frequency-domain diagnostics";
  }
  return "Frequency-domain";
}

function formatList(values: readonly string[] | null | undefined): string {
  return values && values.length > 0 ? values.join(", ") : "not reported";
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

function formatNumber(value: unknown, unit = ""): string {
  const parsed = finiteNumber(value);
  if (parsed == null) return "not available";
  return `${parsed}${unit}`;
}

function arrayLength(value: unknown): string {
  return Array.isArray(value) ? String(value.length) : "not available";
}

function normalizeAnalysisFieldView(value: string | null | undefined): string {
  if (value === "abs" || value === "complex") return "amplitude";
  return value && ANALYSIS_FIELD_VIEW_OPTIONS.includes(
    value as (typeof ANALYSIS_FIELD_VIEW_OPTIONS)[number],
  )
    ? value
    : DEFAULT_ANALYSIS_FIELD_VIEW;
}

function analysisFieldViewLabel(value: string): string {
  if (value === "real") return "Real";
  if (value === "imag") return "Imag";
  if (value === "amplitude") return "Abs";
  if (value === "phase") return "Phase";
  return "Phase-rotated real";
}

function analysisFieldViewOptions(
  availableViews: readonly string[] | null | undefined,
  defaultView: string | null | undefined,
): string[] {
  const normalized = (availableViews ?? ANALYSIS_FIELD_VIEW_OPTIONS).map(
    normalizeAnalysisFieldView,
  );
  const options = Array.from(new Set(normalized));
  const normalizedDefault = normalizeAnalysisFieldView(defaultView);
  if (!options.includes(normalizedDefault)) {
    options.unshift(normalizedDefault);
  }
  return options.length > 0 ? options : [DEFAULT_ANALYSIS_FIELD_VIEW];
}

export function FrequencyDomainInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const [commandMessage, setCommandMessage] = useState<string | null>(null);
  const analysisFieldViewSelectRef = useRef<HTMLSelectElement | null>(null);
  const analysisFieldPhaseInputRef = useRef<HTMLInputElement | null>(null);
  const analysisFieldAnimationRateInputRef = useRef<HTMLInputElement | null>(null);
  const frequencyDomainRef =
    selection.ref?.type === "frequency-domain" ? selection.ref : null;
  const manifest = useFrequencyDomainManifestResource();
  const spectrum = useFrequencyDomainEigenSpectrumResource({
    enabled:
      selection.kind?.includes("eigen") ||
      selection.kind?.includes("fmr") ||
      selection.kind?.includes("frequency_domain") ||
      false,
  });
  const branches = useFrequencyDomainEigenBranchesResource({
    enabled:
      selection.kind?.includes("branch") ||
      selection.kind?.includes("dispersion") ||
      false,
  });
  const dispersion = useFrequencyDomainEigenDispersionResource({
    enabled:
      selection.kind?.includes("dispersion") ||
      selection.kind?.includes("k_path") ||
      false,
  });
  const responseSweep = useFrequencyDomainResponseSweepResource({
    enabled:
      selection.kind?.includes("frequency_response") ||
      selection.kind?.includes("response") ||
      selection.kind?.includes("fmr") ||
      false,
  });
  const responseProgress = useFrequencyDomainResponseProgressResource({
    enabled:
      selection.kind?.includes("frequency_response") ||
      selection.kind?.includes("response") ||
      selection.kind?.includes("fmr") ||
      false,
  });
  const responseCancelRequested =
    useFrequencyDomainResponseCancelRequestedResource({
      enabled:
        selection.kind?.includes("frequency_response") ||
        selection.kind?.includes("response") ||
        selection.kind?.includes("fmr") ||
        false,
    });
  const periodicPairs = useMeshPeriodicPairsResource({
    enabled:
      selection.kind === "resources.mesh.periodic_pairs" ||
      selection.kind?.includes("periodic_pairs") ||
      selection.kind?.includes("periodic_floquet") ||
      false,
  });
  const eigenModeFieldMeta = useFrequencyDomainEigenModeFieldMetaResource(
    frequencyDomainRef?.sampleIndex,
    frequencyDomainRef?.modeIndex,
    {
      enabled: selection.kind?.includes("eigen") ?? false,
    },
  );
  const eigenMode = useFrequencyDomainEigenModeResource(
    frequencyDomainRef?.sampleIndex,
    frequencyDomainRef?.modeIndex,
    {
      enabled: selection.kind === "results.eigen.mode",
    },
  );
  const responseFieldMeta = useFrequencyDomainResponseFieldMetaResource(
    frequencyDomainRef?.frequencyIndex,
    {
      enabled: selection.kind?.includes("frequency_response") ?? false,
    },
  );
  const responseFrequencyPoint = useFrequencyDomainResponseFrequencyPointResource(
    frequencyDomainRef?.frequencyIndex,
    {
      enabled:
        (selection.kind?.includes("frequency_response") ||
          selection.kind?.includes("response")) ??
        false,
    },
  );
  const data = manifest.data;
  const spectrumModel = buildEigenSpectrumChartModel(spectrum.data);
  const branchesModel = buildEigenBranchesModel(branches.data);
  const dispersionModel = buildEigenDispersionChartModel(dispersion.data);
  const responseModel = buildFrequencyResponseChartModel(responseSweep.data);
  const chartRoute = routeFrequencyDomainCalculationMode(data?.result_manifest?.payload);
  const selectedFieldMeta = responseFieldMeta.data ?? eigenModeFieldMeta.data;
  const selectedFieldId = selectedFieldMeta?.field_id ?? frequencyDomainRef?.fieldId ?? null;
  const selectedFieldStatus =
    responseFieldMeta.status !== "idle"
      ? responseFieldMeta.status
      : eigenModeFieldMeta.status;
  const resourceStatus =
    manifest.status === "ready" && data
      ? "ready"
      : manifest.status === "error"
        ? "failed"
        : manifest.status;
  const responseFrequencyPointPayload = record(responseFrequencyPoint.data?.payload);
  const eigenModePayload = record(eigenMode.data);
  const selectedBranch = branchesModel.branches.find(
    (branch) => branch.branchId === frequencyDomainRef?.branchId,
  );
  const selectedObservablePoints = responseModel.points.filter(
    (point) => point.observableId === frequencyDomainRef?.observableId,
  );
  const selectedObservableFrequencies = selectedObservablePoints.map(
    (point) => point.frequencyHz,
  );
  const selectedObservableAmplitudes = selectedObservablePoints
    .map((point) => point.amplitude)
    .filter((value): value is number => value != null);
  const selectedFieldViewOptions = analysisFieldViewOptions(
    selectedFieldMeta?.available_views,
    selectedFieldMeta?.default_view,
  );
  const selectedFieldViewOptionsKey = selectedFieldViewOptions.join("|");
  const defaultAnalysisFieldView = normalizeAnalysisFieldView(
    selectedFieldMeta?.default_view,
  );

  return (
    <div className="fm-inspector-panel">
      <InspectorSection
        title={familyLabel(selection.kind)}
        badge={resourceStatus}
      >
        <FieldRow label="Selection kind" value={selection.kind ?? "none"} />
        <FieldRow label="Node ID" value={selection.nodeId ?? "not selected"} />
        <FieldRow
          label="Selected resource"
          value={frequencyDomainRef?.resourceRef ?? "not selected"}
        />
        <FieldRow
          label="Selected artifact"
          value={frequencyDomainRef?.artifactPath ?? "not selected"}
        />
        <FieldRow label="Manifest resource" value={manifest.status} />
        <FieldRow label="Resource revision" value={manifest.revision ?? "n/a"} />
        {manifest.error ? (
          <FieldRow label="Load error" value={formatError(manifest.error)} />
        ) : null}
      </InspectorSection>

      <InspectorSection title="Solver Family Contract" badge={data?.schema_version ?? "missing"}>
        <FieldRow
          label="Family namespace"
          value={data?.family_namespace ?? "frequencyDomain"}
        />
        <FieldRow
          label="Driven namespace"
          value={
            data?.existing_frequency_response_namespace_preserved
              ? "frequencyResponse preserved"
              : "not reported"
          }
        />
        <FieldRow label="Modal namespace" value={data?.eigen_namespace ?? "eigen"} />
        <FieldRow
          label="Floquet nonzero-k demag"
          value={formatBoolean(data?.floquet_nonzero_k_demag_supported)}
        />
      </InspectorSection>

      <InspectorSection
        title="Periodic / Floquet Boundary Conditions"
        badge={periodicPairs.data?.schema_version ?? periodicPairs.status}
      >
        <FieldRow
          label="Periodic pairs resource"
          value={frequencyDomainRef?.resourceRef ?? MESHING_PERIODIC_PAIRS_PATH}
        />
        <FieldRow
          label="Periodic pairs status"
          value={periodicPairs.data ? "ready" : periodicPairs.status}
        />
        <FieldRow
          label="Pair count"
          value={
            periodicPairs.data ? String(periodicPairs.data.pairs.length) : "not loaded"
          }
        />
        <FieldRow
          label="Mesh revision"
          value={
            periodicPairs.data ? String(periodicPairs.data.revision) : "not loaded"
          }
        />
        {periodicPairs.data?.pairs.slice(0, 3).map((pair) => (
          <FieldRow
            key={pair.pair_id}
            label={`Pair ${pair.pair_id}`}
            value={`${pair.status}; markers ${pair.marker_a}/${pair.marker_b}; paired nodes ${pair.paired_node_count}`}
          />
        ))}
        <FieldRow
          label="Static periodic PBC"
          value={data?.capabilities.boundary.static_periodic.status ?? "unknown"}
        />
        <FieldRow
          label="Periodic diagnostics"
          value={
            data?.capabilities.boundary.periodic_pair_diagnostics.status ??
            "unknown"
          }
        />
        <FieldRow
          label="Floquet modal"
          value={data?.capabilities.boundary.floquet_modal.status ?? "unknown"}
        />
        <FieldRow
          label="Floquet response"
          value={data?.capabilities.boundary.floquet_response.status ?? "unknown"}
        />
        <FieldRow
          label="Dynamic demag-k"
          value={data?.capabilities.demag.floquet_dynamic_k.status ?? "unknown"}
        />
        <FieldRow
          label="Demag-k policy"
          value={
            data?.capabilities.demag.floquet_dynamic_k.reason ??
            "nonzero-k demag status not reported"
          }
        />
        {periodicPairs.error ? (
          <FieldRow
            label="Periodic pairs error"
            value={formatError(periodicPairs.error)}
          />
        ) : null}
      </InspectorSection>

      <InspectorSection title="Driven Response Solver" badge={data?.response.status ?? "unknown"}>
        <FieldRow
          label="Study kind"
          value={data?.response.study_kind ?? "frequency_response"}
        />
        <FieldRow
          label="Driven response"
          value={formatBoolean(data?.response.driven_response_available)}
        />
        <FieldRow
          label="Floquet response"
          value={formatBoolean(data?.response.floquet_response_available)}
        />
        <FieldRow label="GPU lane" value={formatBoolean(data?.response.gpu_available)} />
        <FieldRow label="Reason" value={data?.response.reason ?? "not reported"} />
      </InspectorSection>

      <InspectorSection
        title="Response Cancellation"
        badge={responseCancelRequested.data?.status ?? responseCancelRequested.status}
      >
        <FieldRow
          label="Cancel state"
          value={responseCancelRequested.data?.status ?? "not requested"}
        />
        <FieldRow
          label="Completed frequencies"
          value={
            responseCancelRequested.data
              ? `${responseCancelRequested.data.completed_frequency_points}/${responseCancelRequested.data.total_frequency_points}`
              : "not available"
          }
        />
        <FieldRow
          label="Partial artifacts"
          value={formatBoolean(
            responseCancelRequested.data?.partial_artifacts_available,
          )}
        />
        <FieldRow
          label="Cancel manifest"
          value={
            responseCancelRequested.data?.latest_artifact_manifest_path ??
            "not available"
          }
        />
        <FieldRow
          label="Cancel resource"
          value={ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH}
        />
        <FieldRow
          label="Cancel progress JSON"
          value={responseCancelRequested.data?.progress_json ?? "not available"}
        />
        {responseCancelRequested.error ? (
          <FieldRow
            label="Cancel resource error"
            value={formatError(responseCancelRequested.error)}
          />
        ) : null}
      </InspectorSection>

      <InspectorSection title="Modal Eigen Solver" badge={data?.eigenmodes.status ?? "unknown"}>
        <FieldRow
          label="Study kind"
          value={data?.eigenmodes.study_kind ?? "eigenmodes"}
        />
        <FieldRow
          label="Modal solver"
          value={formatBoolean(data?.eigenmodes.modal_solver_available)}
        />
        <FieldRow
          label="Floquet modal"
          value={formatBoolean(data?.eigenmodes.floquet_modal_available)}
        />
        <FieldRow label="GPU lane" value={formatBoolean(data?.eigenmodes.gpu_available)} />
        <FieldRow label="Reason" value={data?.eigenmodes.reason ?? "not reported"} />
      </InspectorSection>

      <InspectorSection title="Plot Readiness" badge="manifest-driven">
        <FieldRow
          label="FMR modal spectrum"
          value={
            data?.eigenmodes.modal_solver_available
              ? "can be exposed by modal artifacts"
              : "blocked"
          }
        />
        <FieldRow
          label="FMR response sweep"
          value={
            data?.response.driven_response_available
              ? "can be exposed by response artifacts"
              : "blocked"
          }
        />
        <FieldRow
          label="Dispersion"
          value={
            data?.floquet_nonzero_k_demag_supported
              ? "Floquet demag-k allowed"
              : "nonzero-k demag rejected"
          }
        />
        <FieldRow
          label="3D mode plotting"
          value="waiting for mode-field artifacts"
        />
      </InspectorSection>

      <InspectorSection title="Selected Field Metadata" badge={selectedFieldStatus}>
        <FieldRow
          label="Field ID"
          value={selectedFieldId ?? "not selected"}
        />
        <FieldRow
          label="Frequency index"
          value={
            frequencyDomainRef?.frequencyIndex != null
              ? String(frequencyDomainRef.frequencyIndex)
              : "not selected"
          }
        />
        <FieldRow
          label="Mode sample"
          value={
            frequencyDomainRef?.sampleIndex != null
              ? String(frequencyDomainRef.sampleIndex)
              : "not selected"
          }
        />
        <FieldRow
          label="Mode index"
          value={
            frequencyDomainRef?.modeIndex != null
              ? String(frequencyDomainRef.modeIndex)
              : "not selected"
          }
        />
        <FieldRow
          label="Default 3D view"
          value={selectedFieldMeta?.default_view ?? "not available"}
        />
        <FieldRow
          label="Default phase"
          value={
            selectedFieldMeta?.default_phase_rad != null
              ? `${selectedFieldMeta.default_phase_rad} rad`
              : "not available"
          }
        />
        <FieldRow
          label="Available views"
          value={formatList(selectedFieldMeta?.available_views)}
        />
        <FieldRow
          label="3D mode view"
          value={
            <select
              aria-label="Frequency-domain 3D field view"
              className="fm-inspector-select"
              defaultValue={defaultAnalysisFieldView}
              disabled={!selectedFieldId}
              key={`${selectedFieldId ?? "none"}:${selectedFieldViewOptionsKey}:${defaultAnalysisFieldView}`}
              ref={analysisFieldViewSelectRef}
            >
              {selectedFieldViewOptions.map((view) => (
                <option key={view} value={view}>
                  {analysisFieldViewLabel(view)}
                </option>
              ))}
            </select>
          }
        />
        <FieldRow
          label="Data-plane resource"
          value={selectedFieldMeta?.resource_key ?? "not available"}
        />
        <FieldRow
          label="Set phase"
          value={
            <input
              aria-label="Frequency-domain 3D phase"
              className="fm-inspector-input"
              defaultValue={String(selectedFieldMeta?.default_phase_rad ?? 0)}
              disabled={!selectedFieldId}
              key={`${selectedFieldId ?? "none"}:phase`}
              ref={analysisFieldPhaseInputRef}
              step="0.1"
              type="number"
            />
          }
        />
        <FieldRow
          label="Animation rate"
          value={
            <input
              aria-label="Frequency-domain mode animation rate"
              className="fm-inspector-input"
              defaultValue="1"
              disabled={!selectedFieldId || !selection.kind?.includes("eigen")}
              key={`${selectedFieldId ?? "none"}:animation-rate`}
              max="10"
              min="0.05"
              ref={analysisFieldAnimationRateInputRef}
              step="0.05"
              type="number"
            />
          }
        />
        <button
          className="fm-inspector-action-button"
          disabled={!selectedFieldId}
          type="button"
          onClick={() => {
            const commandId = selection.kind?.includes("eigen")
              ? "analysis.eigen.plot-mode-3d"
              : "analysis.frequency-response.plot-response-field-3d";
            void kernel.commands
              .execute(
                commandId,
                createCommandContext("inspector", kernel, {
                  sourceDetail: selection.kind ?? "frequency-domain",
                }),
                {
                  fieldId: selectedFieldId,
                  label: selection.label ?? selectedFieldId,
                  phaseRad: selectedFieldMeta?.default_phase_rad ?? 0,
                  source: selection.kind?.includes("eigen")
                    ? "eigen-mode"
                    : "frequency-response",
                  view:
                    analysisFieldViewSelectRef.current?.value ??
                    defaultAnalysisFieldView,
                },
              )
              .then((result) => {
                setCommandMessage(result.message ?? result.status);
              });
          }}
        >
          Plot in 3D
        </button>
        <button
          className="fm-inspector-action-button"
          disabled={!selectedFieldId || !selection.kind?.includes("eigen")}
          type="button"
          onClick={() => {
            void kernel.commands
              .execute(
                "analysis.eigen.set-mode-3d-phase",
                createCommandContext("inspector", kernel, {
                  sourceDetail: selection.kind ?? "frequency-domain",
                }),
                {
                  phaseRad: finiteNumber(
                    analysisFieldPhaseInputRef.current?.value,
                  ) ?? 0,
                },
              )
              .then((result) => {
                setCommandMessage(result.message ?? result.status);
              });
          }}
        >
          Set phase
        </button>
        <button
          className="fm-inspector-action-button"
          disabled={!selectedFieldId || !selection.kind?.includes("eigen")}
          type="button"
          onClick={() => {
            void kernel.commands
              .execute(
                "analysis.eigen.set-mode-3d-animation",
                createCommandContext("inspector", kernel, {
                  sourceDetail: selection.kind ?? "frequency-domain",
                }),
                {
                  animatePhase: true,
                  animationRateHz:
                    finiteNumber(
                      analysisFieldAnimationRateInputRef.current?.value,
                    ) ?? 1,
                },
              )
              .then((result) => {
                setCommandMessage(result.message ?? result.status);
              });
          }}
        >
          Animate mode phase
        </button>
        <button
          className="fm-inspector-action-button"
          disabled={!selectedFieldId || !selection.kind?.includes("eigen")}
          type="button"
          onClick={() => {
            void kernel.commands
              .execute(
                "analysis.eigen.set-mode-3d-animation",
                createCommandContext("inspector", kernel, {
                  sourceDetail: selection.kind ?? "frequency-domain",
                }),
                {
                  animatePhase: false,
                  animationRateHz:
                    finiteNumber(
                      analysisFieldAnimationRateInputRef.current?.value,
                    ) ?? 1,
                },
              )
              .then((result) => {
                setCommandMessage(result.message ?? result.status);
              });
          }}
        >
          Pause mode phase
        </button>
        <button
          className="fm-inspector-action-button"
          type="button"
          onClick={() => {
            void kernel.commands
              .execute(
                "analysis.frequency-domain.clear-3d-overlay",
                createCommandContext("inspector", kernel, {
                  sourceDetail: "frequency-domain",
                }),
              )
              .then((result) => {
                setCommandMessage(result.message ?? result.status);
              });
          }}
        >
          Clear 3D overlay
        </button>
        {commandMessage ? (
          <FieldRow label="3D command" value={commandMessage} />
        ) : null}
      </InspectorSection>

      <InspectorSection
        title="Selected Eigen Mode"
        badge={eigenMode.status}
      >
        <FieldRow
          label="Mode resource"
          value={
            frequencyDomainRef?.sampleIndex != null &&
            frequencyDomainRef?.modeIndex != null
              ? `eigen/modes/sample_${String(frequencyDomainRef.sampleIndex).padStart(4, "0")}/mode_${String(frequencyDomainRef.modeIndex).padStart(4, "0")}.json`
              : "not selected"
          }
        />
        <FieldRow
          label="Sample index"
          value={
            frequencyDomainRef?.sampleIndex != null
              ? String(frequencyDomainRef.sampleIndex)
              : "not selected"
          }
        />
        <FieldRow
          label="Raw mode index"
          value={
            frequencyDomainRef?.modeIndex != null
              ? String(frequencyDomainRef.modeIndex)
              : "not selected"
          }
        />
        <FieldRow
          label="Mode frequency"
          value={formatNumber(eigenModePayload?.frequency_real_hz, " Hz")}
        />
        <FieldRow
          label="Imaginary frequency"
          value={formatNumber(eigenModePayload?.frequency_imag_hz, " Hz")}
        />
        <FieldRow
          label="Angular frequency"
          value={formatNumber(
            eigenModePayload?.angular_frequency_rad_per_s,
            " rad/s",
          )}
        />
        <FieldRow
          label="Residual"
          value={formatNumber(eigenModePayload?.residual_norm)}
        />
        <FieldRow
          label="Tangent leakage max"
          value={formatNumber(eigenModePayload?.tangent_leakage_max_abs)}
        />
        <FieldRow
          label="Dominant polarization"
          value={
            typeof eigenModePayload?.dominant_polarization === "string"
              ? eigenModePayload.dominant_polarization
              : "not available"
          }
        />
        <FieldRow
          label="Real samples"
          value={arrayLength(eigenModePayload?.real)}
        />
        <FieldRow
          label="Imag samples"
          value={arrayLength(eigenModePayload?.imag)}
        />
        {eigenMode.error ? (
          <FieldRow
            label="Mode resource error"
            value={formatError(eigenMode.error)}
          />
        ) : null}
      </InspectorSection>

      <InspectorSection
        title="Selected Eigen Branch"
        badge={branches.status}
      >
        <FieldRow
          label="Branch ID"
          value={frequencyDomainRef?.branchId ?? "not selected"}
        />
        <FieldRow
          label="Branch label"
          value={selectedBranch?.label ?? "not available"}
        />
        <FieldRow
          label="Tracked points"
          value={
            selectedBranch ? String(selectedBranch.points.length) : "not available"
          }
        />
        <FieldRow
          label="Sample range"
          value={
            selectedBranch?.sampleMin != null && selectedBranch.sampleMax != null
              ? `${selectedBranch.sampleMin}-${selectedBranch.sampleMax}`
              : "not available"
          }
        />
        <FieldRow
          label="Frequency range"
          value={
            selectedBranch?.frequencyMinHz != null &&
            selectedBranch.frequencyMaxHz != null
              ? `${(selectedBranch.frequencyMinHz / 1e9).toFixed(6)}-${(selectedBranch.frequencyMaxHz / 1e9).toFixed(6)} GHz`
              : "not available"
          }
        />
        <FieldRow
          label="Min tracking confidence"
          value={formatNumber(selectedBranch?.trackingConfidenceMin)}
        />
        <FieldRow
          label="Min overlap"
          value={formatNumber(selectedBranch?.overlapPrevMin)}
        />
        <FieldRow
          label="Branch resource"
          value={frequencyDomainRef?.resourceRef ?? "not selected"}
        />
        {branches.error ? (
          <FieldRow
            label="Branch resource error"
            value={formatError(branches.error)}
          />
        ) : null}
      </InspectorSection>

      <InspectorSection
        title="Selected Response Frequency Point"
        badge={responseFrequencyPoint.data?.status ?? responseFrequencyPoint.status}
      >
        <FieldRow
          label="Frequency point resource"
          value={responseFrequencyPoint.data?.resource_key ?? "not selected"}
        />
        <FieldRow
          label="Frequency point artifact"
          value={responseFrequencyPoint.data?.artifact_path ?? "not selected"}
        />
        <FieldRow
          label="Frequency"
          value={formatNumber(responseFrequencyPointPayload?.frequency_hz, " Hz")}
        />
        <FieldRow
          label="Angular frequency"
          value={formatNumber(
            responseFrequencyPointPayload?.angular_frequency_rad_per_s,
            " rad/s",
          )}
        />
        <FieldRow
          label="Absorbed power density"
          value={formatNumber(
            responseFrequencyPointPayload?.absorbed_power_density,
            " W/m^3",
          )}
        />
        <FieldRow
          label="Residual"
          value={formatNumber(responseFrequencyPointPayload?.residual_l2_norm)}
        />
        <FieldRow
          label="Relative residual"
          value={formatNumber(
            responseFrequencyPointPayload?.relative_residual_l2_norm,
          )}
        />
        <FieldRow
          label="Amplitude entries"
          value={arrayLength(responseFrequencyPointPayload?.response_amplitude)}
        />
        <FieldRow
          label="Phase entries"
          value={arrayLength(responseFrequencyPointPayload?.response_phase)}
        />
        {responseFrequencyPoint.error ? (
          <FieldRow
            label="Frequency point error"
            value={formatError(responseFrequencyPoint.error)}
          />
        ) : null}
      </InspectorSection>

      <InspectorSection
        title="Selected Response Observable"
        badge={responseSweep.status}
      >
        <FieldRow
          label="Observable ID"
          value={frequencyDomainRef?.observableId ?? "not selected"}
        />
        <FieldRow
          label="Observable points"
          value={String(selectedObservablePoints.length)}
        />
        <FieldRow
          label="Frequency range"
          value={
            selectedObservableFrequencies.length > 0
              ? `${Math.min(...selectedObservableFrequencies)}-${Math.max(...selectedObservableFrequencies)} Hz`
              : "not available"
          }
        />
        <FieldRow
          label="Mean amplitude"
          value={
            selectedObservableAmplitudes.length > 0
              ? formatNumber(
                  selectedObservableAmplitudes.reduce(
                    (sum, value) => sum + value,
                    0,
                  ) / selectedObservableAmplitudes.length,
                )
              : "not available"
          }
        />
        <FieldRow
          label="Sweep resource"
          value={frequencyDomainRef?.resourceRef ?? "not selected"}
        />
      </InspectorSection>

      <InspectorSection title="Chart Resources" badge="resource-driven">
        <FieldRow
          label="Primary chart"
          value={`${chartRoute.primaryChart} (${chartRoute.mode})`}
        />
        <FieldRow
          label="Chart route"
          value={
            chartRoute.status === "available"
              ? "available"
              : chartRoute.unavailableReason ?? "unavailable"
          }
        />
        <FieldRow
          label="Response data source"
          value={responseModel.dataSourceVersion}
        />
        <FieldRow
          label="Response diagnostics"
          value={
            responseModel.diagnostics.length > 0
              ? responseModel.diagnostics.join("; ")
              : "none"
          }
        />
        <FieldRow
          label="Eigen spectrum"
          value={`${spectrumModel.points.length} points, ${spectrumModel.droppedPointCount} dropped`}
        />
        <FieldRow
          label="Dispersion"
          value={`${dispersionModel.points.length} points, ${dispersionModel.series.length} series`}
        />
        <FieldRow
          label="Driven response"
          value={`${responseModel.points.length} points, ${responseModel.series.length} series`}
        />
        <FieldRow
          label="Response progress"
          value={`${responseProgress.data?.completed_frequency_points ?? 0}/${responseProgress.data?.total_frequency_points ?? 0} frequency points`}
        />
        <FieldRow
          label="Response sweep complete"
          value={formatBoolean(responseProgress.data?.complete)}
        />
        <FieldRow
          label="Partial response artifacts"
          value={formatBoolean(responseProgress.data?.partial_artifacts_available)}
        />
        <FieldRow
          label="Spectrum resource"
          value={spectrum.data?.status ?? spectrum.status}
        />
        <FieldRow
          label="Response resource"
          value={responseSweep.data?.status ?? responseSweep.status}
        />
      </InspectorSection>
    </div>
  );
}
