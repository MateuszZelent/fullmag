"use client";

import { Play } from "lucide-react";

import { Button } from "@/shared/ui/Button";
import { formatFrequencyHz } from "@/shared/domain/analysis/frequencyUnits";

import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { FrequencyDomainCalculationModeSection } from "./FrequencyDomainCalculationModeSection";
import { StageInspectorFrame, type StageInspectorFrameProps } from "./StageInspectorFrame";

export function FrequencyResponseStageInspector(props: StageInspectorFrameProps) {
  return renderFrequencyResponseStageInspector(props);
}

function renderFrequencyResponseStageInspector(props: StageInspectorFrameProps) {
  const draft = props.draft;
  const stage = props.stage;
  const authoringView = props.authoringView ?? "overview";
  const showCommandCenter = authoringView === "overview";
  const showCalculationMode = authoringView === "calculation_mode";
  const hasDraftErrors = props.validation.some((issue) => issue.severity === "error");
  const saveStageDisabled = props.authoringBusy || !draft || hasDraftErrors;
  const runResponseDisabledReason =
    saveStageDisabled
      ? "Save a valid FrequencyResponse stage before running this workflow."
      : props.runtimeCommandDisabledReason?.("study.run") ??
        "Study run command is unavailable in this inspector.";
  const validationSummary = summarizeValidation(props.validation);
  const boundarySummary = summarizeBoundary(
    draft?.bc,
    draft?.magnetostaticBc,
  );
  const excitationSummary = summarizeExcitation(
    draft?.excitationField,
    draft?.excitationPhaseRad,
  );
  const sweepSummary = summarizeFrequencySweep(draft?.frequenciesHz);
  const equilibriumSummary = summarizeEquilibrium(
    draft?.equilibriumSource,
    draft?.equilibriumArtifact,
  );
  return (
    <>
      <StageInspectorFrame
        {...props}
        expectedKind="frequency_response"
        kindLabel="Frequency Response"
      />
      {showCalculationMode ? (
        <FrequencyDomainCalculationModeSection
          draft={draft}
          family="frequency_response"
          onUpdateDraft={props.onUpdateDraft}
          validation={props.validation}
        />
      ) : null}
      {authoringView === "setup" ? (
        <InspectorGroup
          title="Study Settings"
          badge="direct solve"
        >
          <FieldRow
            label="Calculation workflow"
            value="fmr_response; response_map readiness is reported in diagnostics"
          />
          <FieldRow
            label="Direct solve"
            value="(i omega B - L) q = f"
          />
          <FieldRow
            label="Executable lane"
            value="FEM magnetic-only CPU response; double precision"
          />
          <FieldRow
            label="Operator preset"
            value="linearized_llg harmonic response"
          />
          <FieldRow
            label="Boundary preset"
            value={`${boundarySummary.spinWave}; ${boundarySummary.magnetostatic}; ${draft?.kSampling || "k = 0"}`}
          />
          <FieldRow
            label="Frequency summary"
            value={formatFrequencyDraftList(draft?.frequenciesHz)}
          />
          <FieldRow
            label="Output family"
            value={draft?.observable ?? "not set"}
          />
          <FieldRow
            label="Unsupported lanes"
            value="GPU response, nonzero-k Floquet response, dynamic demag-k, magnetoelastic response"
          />
        </InspectorGroup>
      ) : null}
      {authoringView === "excitation" ? (
        <InspectorGroup
          title="Excitation"
          badge="phasor"
        >
          <FieldRow
            label="Drive vector"
            value={`${draft?.excitationField ?? "not set"} A/m`}
          />
          <FieldRow
            label="Excitation phase"
            value={`${draft?.excitationPhaseRad ?? "not set"} rad`}
          />
          <FieldRow
            label="Phase display"
            value={excitationSummary.phaseDegrees}
          />
          <FieldRow
            label="Vector validation"
            value={excitationSummary.vectorValidation}
          />
          <FieldRow
            label="Phase validation"
            value={excitationSummary.phaseValidation}
          />
          <FieldRow
            label="Source selector"
            value="field phasor; antenna/source support is reported in diagnostics"
          />
          <FieldRow
            label="Projection"
            value="projected into local tangent plane"
          />
          <FieldRow
            label="Phasor convention"
            value="delta_h exp(i omega t + phase_rad)"
          />
          <FieldRow
            label="Backend semantics"
            value="driven harmonic solve consumes the same canonical FrequencyResponse stage"
          />
        </InspectorGroup>
      ) : null}
      {authoringView === "equilibrium" ? (
        <InspectorGroup
          title="Linearization Point"
          badge={equilibriumSummary.source}
        >
          <FieldRow
            label="Equilibrium source"
            value={equilibriumSummary.sourceLabel}
          />
          <FieldRow
            label="Response readiness"
            value="same equilibrium can be reused for modal comparison"
          />
          <FieldRow
            label="Provenance link"
            value={equilibriumSummary.provenance}
          />
          <FieldRow
            label="Artifact readiness"
            value={equilibriumSummary.artifactReadiness}
          />
        </InspectorGroup>
      ) : null}
      {authoringView === "solver" ? (
        <InspectorGroup
          title="Solver Configuration"
          badge={draft?.deviceTarget ?? "device"}
        >
          <FieldRow
            label="Requested execution"
            value={`${draft?.deviceTarget ?? "cpu"}; double precision production slice`}
          />
          <FieldRow
            label="Solver lane"
            value="matrix_free_solver; krylov_solver = gmres"
          />
          <FieldRow
            label="Tolerance policy"
            value="response residuals and solver status are published through response diagnostics"
          />
          <FieldRow
            label="Plan fields"
          value="mesh, FE order, equilibrium, material, operator, excitation, frequencies, precision, demag realization"
          />
          <FieldRow
            label="Progress"
            value={`${stage?.progressPercent ?? 0}%`}
          />
          <FieldRow
            label="Runtime metric"
            value={stage?.runtimeMetric?.value ?? "not available"}
          />
          <FieldRow
            label="Unsupported lanes"
            value="GPU response, single precision, nonzero-k response, magnetoelastic response"
          />
        </InspectorGroup>
      ) : null}
      {authoringView === "sweep" ? (
        <InspectorGroup
          title="Frequency Sweep"
          badge={draft?.observable ?? "observable"}
        >
          <FieldRow
            label="Frequency grid"
            value={formatFrequencyDraftList(draft?.frequenciesHz)}
          />
          <FieldRow
            label="Frequency count"
            value={`${sweepSummary.count} point(s)`}
          />
          <FieldRow
            label="Estimated artifacts"
            value={`${sweepSummary.count} frequency-point artifact(s)`}
          />
          <FieldRow
            label="Deduplication"
            value={sweepSummary.deduplication}
          />
          <FieldRow
            label="Frequency validation"
            value={sweepSummary.validation}
          />
          <FieldRow
            label="Authoring units"
            value="Hz input; results display auto-scales to MHz/GHz"
          />
          <FieldRow
            label="Observable"
            value={draft?.observable ?? "not set"}
          />
          <FieldRow
            label="Partial artifacts"
            value="write per-frequency point artifacts for progress/resume visibility"
          />
          <FieldRow
            label="Expected result"
            value="amplitude, phase, absorbed power, susceptibility, and response fields"
          />
        </InspectorGroup>
      ) : null}
      {authoringView === "outputs" ? (
        <InspectorGroup
          title="Output"
          badge={draft?.observable ?? "outputs"}
        >
          <FieldRow
            label="Primary observable"
            value={draft?.observable ?? "not set"}
          />
          <FieldRow
            label="Complex magnetization response"
            value="required for 3D response field visualization"
          />
          <FieldRow
            label="Susceptibility tensor"
            value={
              draft?.observable === "susceptibility_tensor"
                ? "enabled by observable susceptibility_tensor"
                : "available when observable requests tensor output"
            }
          />
          <FieldRow
            label="Absorbed power density"
            value="published for FMR absorption charts when backend provides it"
          />
          <FieldRow
            label="Response amplitude/phase"
            value="required for FMR sweep chart and peak table"
          />
          <FieldRow
            label="Frequency point metadata"
            value="one JSON metadata artifact per solved frequency"
          />
          <FieldRow
            label="Response field payload"
            value="complex vector payload for selected frequency 3D field"
          />
          <FieldRow
            label="Diagnostics output"
            value="response/diagnostics/solver.v1.json plus progress/cancel resources"
          />
          <FieldRow
            label="Artifact bundle"
            value="magnetic_response_sweep.v2.json, frequency_points, field_payloads"
          />
        </InspectorGroup>
      ) : null}
      {authoringView === "diagnostics" ? (
        <InspectorGroup
          title="Diagnostics"
          badge={validationSummary.badge}
        >
          <FieldRow label="UI validation" value={validationSummary.summary} />
          <FieldRow
            label="IR validation"
            value="FrequencyResponse stage lowers to FemFrequencyResponsePlanIR"
          />
          <FieldRow
            label="Planner rejection reasons"
            value="GPU response, single precision, nonzero-k response, magnetoelastic response"
          />
          <FieldRow
            label="Capability matrix"
            value="magnetic CPU partial production; GPU and nonzero-k response unsupported"
          />
          <FieldRow
            label="Response progress resource"
            value="response/progress.v1.json and response/cancel_requested.v1.json"
          />
          <FieldRow
            label="Diagnostics artifact"
            value="response/diagnostics/solver.v1.json"
          />
          <FieldRow
            label="Static periodic diagnostics"
            value="shared periodic pair resource when static-periodic response is selected"
          />
          <FieldRow
            label="Runtime stop reason"
            value={stage?.stopReason ?? "not available"}
          />
          <FieldRow
            label="Published artifacts"
            value={stage?.artifactRefs.length ? stage.artifactRefs.join(", ") : "none"}
          />
        </InspectorGroup>
      ) : null}
      {authoringView === "boundary" ? (
        <InspectorGroup
          title="Boundary"
          badge={boundarySummary.spinWave}
        >
          <FieldRow label="Spin-wave BC" value={boundarySummary.spinWave} />
          <FieldRow
            label="Magnetostatic BC"
            value={boundarySummary.magnetostatic}
          />
          <FieldRow
            label="Current production slice"
            value="k = 0 free/open or static-periodic response"
          />
          <FieldRow
            label="Static periodic"
            value="requires validated mesh.periodic_node_pairs"
          />
          <FieldRow
            label="Floquet/Bloch response"
            value="disabled until nonzero-k driven response is supported"
          />
          <FieldRow
            label="Periodic pair selector"
            value="open Frequency Response Periodic Pairs"
          />
          <FieldRow
            label="Static periodic diagnostics"
            value="projection, node pair count, frame mismatch, and drive mismatch"
          />
          <FieldRow
            label="Response-map handoff"
            value="open k/f grid when nonzero-k response becomes available"
          />
        </InspectorGroup>
      ) : null}
      {authoringView === "periodic_pairs" ? (
        <InspectorGroup
          title="Periodic Pairs"
          badge={boundarySummary.spinWave}
        >
          <FieldRow label="Spin-wave BC" value={boundarySummary.spinWave} />
          <FieldRow
            label="Magnetostatic BC"
            value={boundarySummary.magnetostatic}
          />
          <FieldRow
            label="Periodic pair source"
            value="shared-domain mesh periodic_pairs.v1 resource"
          />
          <FieldRow
            label="Current production slice"
            value="k = 0 free/open or static-periodic magnetic response"
          />
          <FieldRow
            label="Nonzero-k response"
            value="readiness is reported by response diagnostics"
          />
          <FieldRow
            label="Validation"
            value="requires periodic-pair metadata before response_map can run"
          />
        </InspectorGroup>
      ) : null}
      {authoringView === "k_grid" ? (
        <InspectorGroup
          title="k/f Grid"
          badge={draft?.kSampling || "k-grid"}
        >
          <FieldRow label="Spin-wave BC" value={boundarySummary.spinWave} />
          <FieldRow
            label="Magnetostatic BC"
            value={boundarySummary.magnetostatic}
          />
          <FieldRow label="k vector" value={draft?.kVector || "not set"} />
          <FieldRow label="k grid" value={draft?.kSampling || "not set"} />
          <FieldRow
            label="Workflow"
            value="response_map over frequency x k when authored and supported by diagnostics"
          />
          <FieldRow
            label="Frequency coupling"
            value={formatFrequencyDraftList(draft?.frequenciesHz)}
          />
          <FieldRow
            label="Unsupported lane"
            value="nonzero-k driven response rejected until backend exposes it"
          />
        </InspectorGroup>
      ) : null}
      {showCommandCenter ? (
        <InspectorGroup
          title="Driven Response Command Center"
          badge="FrequencyResponse"
        >
          <FieldRow
            label="Calculation workflow"
            value="fmr_response / response_map"
          />
          <FieldRow
            label="Equilibrium source"
            value={draft?.equilibriumSource ?? "not set"}
          />
          <FieldRow
            label="Operator"
            value="linearized LLG harmonic response"
          />
          <FieldRow
            label="Boundary/k sampling"
            value={`${boundarySummary.spinWave}; ${boundarySummary.magnetostatic}; ${draft?.kSampling || "k = 0"}`}
          />
          <FieldRow
            label="Excitation phasor"
            value={`${draft?.excitationField ?? "not set"} A/m; phase ${draft?.excitationPhaseRad ?? "0"} rad`}
          />
          <FieldRow
            label="Frequency sweep"
            value={formatFrequencyDraftList(draft?.frequenciesHz)}
          />
          <FieldRow
            label="Outputs"
            value="response amplitude, response phase, susceptibility, absorbed power, response fields, diagnostics"
          />
          <FieldRow
            label="Current native production CPU slice"
            value="FEM magnetic-only k=0 CPU response; double precision"
          />
          <FieldRow
            label="Unsupported lanes"
            value="GPU response, nonzero-k Floquet response, dynamic demag-k, magnetoelastic response"
          />
          <FieldRow
            label="Latest progress"
            value={`${stage?.progressPercent ?? 0}%`}
          />
          <div className="fm-inspector-toolbar">
            <Button
              disabled={saveStageDisabled}
              size="sm"
              title="Save stage draft before running this workflow"
              type="button"
              variant="secondary"
              onClick={props.onCommit}
            >
              Validate driven response
            </Button>
            <Button
              disabled={runResponseDisabledReason !== null}
              size="sm"
              title={runResponseDisabledReason ?? "Run the saved driven response sweep"}
              type="button"
              variant="primary"
              onClick={() => props.runRuntimeCommand?.("study.run")}
            >
              <Play size={13} aria-hidden="true" />
              Run response sweep
            </Button>
          </div>
          {runResponseDisabledReason ? (
            <FieldRow label="Run readiness" value={runResponseDisabledReason} />
          ) : null}
          <FieldRow
            label="Export canonical Python"
            value="Canonical Python export is available after the saved stage patch is materialized"
          />
        </InspectorGroup>
      ) : null}
      {showCommandCenter ? (
        <>
      <InspectorGroup
        title="Frequency Sweep"
        badge={draft?.observable ?? "observable"}
      >
        <FieldRow
          label="Frequencies"
          value={formatFrequencyDraftList(draft?.frequenciesHz)}
        />
        <FieldRow
          label="Excitation"
          value={draft?.excitationField ?? "not set"}
        />
        <FieldRow
          label="Observable"
          value={draft?.observable ?? "not set"}
        />
      </InspectorGroup>
      <InspectorGroup
        title="Linearization State"
      >
        <FieldRow
          label="Equilibrium source"
          value={draft?.equilibriumSource ?? "not set"}
        />
        <FieldRow
          label="Equilibrium artifact"
          value={draft?.equilibriumArtifact || "not set"}
        />
        <FieldRow label="Damping policy" value={draft?.dampingPolicy ?? "not set"} />
        <FieldRow label="Include demag" value={draft?.includeDemag ? "yes" : "no"} />
      </InspectorGroup>
      <InspectorGroup title="Spin-Wave Sampling">
        <FieldRow label="Spin-wave BC" value={boundarySummary.spinWave} />
        <FieldRow
          label="Magnetostatic BC"
          value={boundarySummary.magnetostatic}
        />
        <FieldRow label="k vector" value={draft?.kVector || "not set"} />
        <FieldRow label="k sampling" value={draft?.kSampling || "not set"} />
      </InspectorGroup>
      <InspectorGroup title="Frequency Results">
        <FieldRow label="Status" value={stage?.status ?? "not started"} />
        <FieldRow
          label="Computed response"
          value={stage?.runtimeMetric?.value ?? "not available"}
        />
        <FieldRow
          label="Artifacts"
          value={stage?.artifactRefs.length ? stage.artifactRefs.join(", ") : "none"}
        />
      </InspectorGroup>
        </>
      ) : null}
    </>
  );
}

function summarizeBoundary(
  spinWaveValue: string | null | undefined,
  magnetostaticValue: string | null | undefined,
) {
  return {
    magnetostatic: formatMagnetostaticBc(magnetostaticValue),
    spinWave: formatSpinWaveBc(spinWaveValue),
  };
}

function formatSpinWaveBc(value: string | null | undefined): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return "not authored";
  const parsed = parseObject(trimmed);
  if (parsed) {
    const kind = String(parsed.kind ?? "custom");
    const axes = Array.isArray(parsed.axes)
      ? parsed.axes.map(String).filter(Boolean)
      : [];
    if (kind === "periodic") {
      return axes.length ? `periodic; axes ${axes.join(", ")}` : "periodic";
    }
    if (kind === "floquet") {
      const kVector = Array.isArray(parsed.k_vector_rad_per_m)
        ? parsed.k_vector_rad_per_m.map(String).join(", ")
        : Array.isArray(parsed.floquet_k_vector_rad_per_m)
          ? parsed.floquet_k_vector_rad_per_m.map(String).join(", ")
          : "";
      return kVector ? `floquet; k [${kVector}] rad/m` : "floquet";
    }
    return kind;
  }
  if (trimmed === "free" || trimmed === "open") return "free/open";
  return trimmed;
}

function formatMagnetostaticBc(value: string | null | undefined): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return "not authored";
  if (trimmed === "open") return "open";
  if (trimmed === "periodic_airbox_k0") return "periodic_airbox_k0";
  if (trimmed === "floquet_airbox") return "floquet_airbox";
  return trimmed;
}

function parseObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function formatFrequencyDraftList(value: string | null | undefined): string {
  const frequencies = (value ?? "").split(/[,\s]+/).flatMap((entry) => {
    const frequency = Number(entry);
    return Number.isFinite(frequency) ? [frequency] : [];
  });
  if (!frequencies.length) return "not set";
  return frequencies.map((entry) => formatFrequencyHz(entry)).join(", ");
}

function summarizeExcitation(
  fieldValue: string | null | undefined,
  phaseValue: string | null | undefined,
) {
  const vector = parseNumberList(fieldValue);
  const phase = Number(phaseValue ?? "");
  const vectorFinite = vector.length === 3 && vector.every(Number.isFinite);
  const vectorNonzero = vectorFinite && vector.some((entry) => entry !== 0);
  const phaseFinite = Number.isFinite(phase);

  return {
    phaseDegrees: phaseFinite
      ? `${formatCompactNumber((phase * 180) / Math.PI)} deg`
      : "not available",
    phaseValidation: phaseFinite ? "finite phase" : "phase must be finite",
    vectorValidation: vectorFinite
      ? vectorNonzero
        ? "finite nonzero vector"
        : "zero vector invalid"
      : "three finite components required",
  };
}

function summarizeEquilibrium(
  source: string | null | undefined,
  artifact: string | null | undefined,
) {
  const normalizedSource = source || "provided";
  const artifactPath = artifact?.trim();
  const artifactReadiness =
    normalizedSource === "artifact" || normalizedSource === "provided"
      ? artifactPath
        ? `artifact ${artifactPath}`
        : normalizedSource === "artifact"
          ? "artifact path required"
          : "no artifact required for provided source"
      : `no artifact required for ${normalizedSource} source`;

  return {
    artifactReadiness,
    provenance:
      normalizedSource === "relax"
        ? "relaxed initial state"
        : normalizedSource === "artifact"
          ? "artifact path"
          : "provided current state",
    source: normalizedSource,
    sourceLabel: normalizedSource.replaceAll("_", " "),
  };
}

function parseNumberList(value: string | null | undefined): number[] {
  return (value ?? "").split(/[,\s]+/).flatMap((entry) =>
    entry ? [Number(entry)] : [],
  );
}

function summarizeFrequencySweep(value: string | null | undefined) {
  const frequencies = parseNumberList(value);
  const finite = frequencies.every(Number.isFinite);
  const positive = frequencies.every((entry) => entry > 0);
  const uniqueCount = new Set(frequencies.map((entry) => String(entry))).size;
  const duplicateCount = frequencies.length - uniqueCount;

  return {
    count: frequencies.length,
    deduplication:
      duplicateCount > 0
        ? `${duplicateCount} duplicate(s) require policy`
        : "no duplicates",
    validation:
      frequencies.length === 0
        ? "frequency list required"
        : finite && positive
          ? "all frequencies finite and positive"
          : "all frequencies must be finite and positive",
  };
}

function formatCompactNumber(value: number): string {
  return Number(value.toPrecision(4)).toLocaleString("en-US");
}

function summarizeValidation(
  issues: readonly { message: string; severity: string }[],
) {
  if (issues.length === 0) return { badge: "valid", summary: "valid" };
  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  return {
    badge: errorCount > 0 ? "error" : "warning",
    summary: issues.map((issue) => issue.message).join("; "),
  };
}
