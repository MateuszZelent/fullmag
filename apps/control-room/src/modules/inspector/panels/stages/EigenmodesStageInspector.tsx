"use client";

import { Play } from "lucide-react";

import { Button } from "@/shared/ui/Button";

import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { FrequencyDomainCalculationModeSection } from "./FrequencyDomainCalculationModeSection";
import { StageInspectorFrame, type StageInspectorFrameProps } from "./StageInspectorFrame";

export function EigenmodesStageInspector(props: StageInspectorFrameProps) {
  return renderEigenmodesStageInspector(props);
}

function renderEigenmodesStageInspector(props: StageInspectorFrameProps) {
  const draft = props.draft;
  const stage = props.stage;
  const authoringView = props.authoringView ?? "overview";
  const showCommandCenter = authoringView === "overview";
  const showCalculationMode = authoringView === "calculation_mode";
  const hasDraftErrors = props.validation.some((issue) => issue.severity === "error");
  const saveStageDisabled = props.authoringBusy || !draft || hasDraftErrors;
  const runModalDisabledReason =
    saveStageDisabled
      ? "Save a valid Eigenmodes stage before running this workflow."
      : props.runtimeCommandDisabledReason?.("study.run") ??
        "Study run command is unavailable in this inspector.";
  const validationSummary = summarizeValidation(props.validation);
  const equilibriumSummary = summarizeEquilibrium(
    draft?.equilibriumSource,
    draft?.equilibriumArtifact,
  );
  const modalDefaults = summarizeModalDefaults(draft);
  const modalRuntime = summarizeModalRuntime(stage, draft);
  return (
    <>
      <StageInspectorFrame
        {...props}
        expectedKind="eigenmodes"
        kindLabel="Eigenmodes"
      />
      {showCalculationMode ? (
        <FrequencyDomainCalculationModeSection
          draft={draft}
          family="eigenmodes"
          onUpdateDraft={props.onUpdateDraft}
          validation={props.validation}
        />
      ) : null}
      {authoringView === "setup" ? (
        <InspectorGroup
          title="Study Settings"
          badge={draft?.target ?? "target"}
        >
          <FieldRow
            label="Mode request"
            value={`count ${draft?.count ?? "not set"}; target ${draft?.target ?? "not set"}`}
          />
          <FieldRow
            label="Target frequency"
            value={draft?.targetFrequency || "not set"}
          />
          <FieldRow
            label="Frequency window"
            value={
              draft?.target === "frequency_window"
                ? `${draft.frequencyMin || "not set"} Hz .. ${draft.frequencyMax || "not set"} Hz`
                : "not selected"
            }
          />
          <FieldRow
            label="Operator preset"
            value="linearized_llg tangent projection"
          />
          <FieldRow
            label="Requested execution"
            value={
              draft?.deviceTarget
                ? `${draft.deviceTarget}; backend/device/precision resolved by planner`
                : "backend/device/precision resolved by planner"
            }
          />
          <FieldRow
            label="Expected result family"
            value="FMR modal spectrum / free modes / dispersion"
          />
          <FieldRow
            label="Non-uniform equilibrium"
            value="valid only when the selected operator supports tangent-space linearization"
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
            label="Physics invariant"
            value="m0 x H0 ~= 0; |m0| = 1"
          />
          <FieldRow
            label="State provenance"
            value={equilibriumSummary.provenance}
          />
          <FieldRow
            label="Artifact readiness"
            value={equilibriumSummary.artifactReadiness}
          />
          <FieldRow
            label="Relaxation prerequisite"
            value={equilibriumSummary.relaxationPrerequisite}
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
            value={
              draft?.deviceTarget
                ? `${draft.deviceTarget}; backend/device/precision resolved by planner`
                : "backend/device/precision resolved by planner"
            }
          />
          <FieldRow
            label="Solver lane"
            value="native SLEPc shift-invert modal lane with reference CPU parity path"
          />
          <FieldRow
            label="Tolerance policy"
            value="residual, window, and tangent-space checks are published through eigen diagnostics"
          />
          <FieldRow
            label="Plan fields"
            value="mesh, FE order, hmax, precision, exchange BC, demag realization, gamma"
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
            label="Stop reason"
            value={stage?.stopReason ?? "not available"}
          />
        </InspectorGroup>
      ) : null}
      {authoringView === "operator" ? (
        <InspectorGroup
          title="Physics and Variables"
          badge="linearized LLG"
        >
          <FieldRow
            label="Operator family"
            value="linearized LLG tangent-space eigenproblem"
          />
          <FieldRow
            label="Demag term"
            value={draft?.includeDemag ? "included" : "excluded"}
          />
          <FieldRow
            label="Operator"
            value={draft?.operator || "linearized_llg"}
          />
          <FieldRow
            label="Normalization"
            value={draft?.normalization ?? "not set"}
          />
          <FieldRow
            label="Damping policy"
            value={draft?.dampingPolicy ?? "not set"}
          />
          <FieldRow
            label="Backend semantics"
            value="shared physics contract; execution resolves CPU/GPU later"
          />
          <FieldRow
            label="Artifacts"
            value="spectrum, selected complex mode fields, residual diagnostics"
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
            value="Eigenmodes stage lowers to StudyIR::Eigenmodes"
          />
          <FieldRow
            label="Planner diagnostics"
            value="backend/device/precision resolved during planning"
          />
          <FieldRow
            label="Capability matrix"
            value="reference CPU modal path ready; native production modal readiness is reported in diagnostics"
          />
          <FieldRow
            label="Eigen diagnostics artifact"
            value="eigen/diagnostics.v2.json"
          />
          <FieldRow
            label="Mode field diagnostics"
            value="tangent leakage, residuals, normalization, and field payload presence"
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
      {authoringView === "outputs" ? (
        <InspectorGroup
          title="Output"
          badge={draft?.target ?? "outputs"}
        >
          <FieldRow
            label="Spectrum output"
            value="eigen/spectrum.v2.json for modal FMR and free-mode tables"
          />
          <FieldRow
            label="Mode metadata"
            value="per-sample/per-mode JSON metadata for selected modes"
          />
          <FieldRow
            label="Mode field payload"
            value="Zarr complex vector payloads for 3D mode visualization"
          />
          <FieldRow
            label="Mode selection"
            value="sample/mode selectors are enabled when spectrum metadata exists"
          />
          <FieldRow
            label="Dispersion output"
            value="eigen/dispersion.csv when k-path sampling is active"
          />
          <FieldRow
            label="Branch tracking output"
            value="eigen/branches.v2.json for branch-aware dispersion"
          />
          <FieldRow
            label="Diagnostics output"
            value="eigen/diagnostics.v2.json for residuals, tangent leakage, and freshness"
          />
          <FieldRow
            label="Storage policy"
            value="JSON metadata and Zarr field payloads; raw binary only as transitional export"
          />
          <FieldRow
            label="Artifact readiness"
            value={stage?.artifactRefs.length ? stage.artifactRefs.join(", ") : "none"}
          />
        </InspectorGroup>
      ) : null}
      {authoringView === "boundary" ? (
        <InspectorGroup
          title="Boundary"
          badge={draft?.bc || "free"}
        >
          <FieldRow label="Boundary condition" value={draft?.bc || "free"} />
          <FieldRow
            label="Supported choices"
            value="free/open; static periodic; Floquet/Bloch"
          />
          <FieldRow
            label="Periodic pair requirement"
            value="static periodic and Floquet require validated periodic pairs"
          />
          <FieldRow label="Single-k vector" value={draft?.kVector || "not set"} />
          <FieldRow
            label="k-path handoff"
            value="open Eigenmodes k-Path for dispersion sampling"
          />
          <FieldRow
            label="Phase convention"
            value="exp(-i k dot delta_r)"
          />
          <FieldRow
            label="Floquet k=0 validation"
            value="Floquet(k=0) == static periodic"
          />
          <FieldRow
            label="Nonzero-k demag gate"
            value={
              draft?.includeDemag
                ? "nonzero-k dynamic demag unsupported while demag is enabled"
                : "demag disabled for this draft"
            }
          />
        </InspectorGroup>
      ) : null}
      {authoringView === "periodic_pairs" ? (
        <InspectorGroup
          title="Periodic Pairs"
          badge={draft?.bc || "periodic pairs"}
        >
          <FieldRow label="Boundary condition" value={draft?.bc || "free"} />
          <FieldRow
            label="Periodic pair source"
            value="shared-domain mesh periodic_pairs.v1 resource"
          />
          <FieldRow
            label="Pair validation"
            value="requires matching periodic boundary faces and displacement vectors"
          />
          <FieldRow
            label="Floquet phase"
            value="exp(-i k dot delta_r) when k-path is active"
          />
          <FieldRow
            label="Demag-k gate"
            value="nonzero-k dynamic demag readiness is reported in diagnostics"
          />
        </InspectorGroup>
      ) : null}
      {authoringView === "k_sampling" || authoringView === "k_path" ? (
        <InspectorGroup
          title={
            authoringView === "k_path"
              ? "k-Path"
              : "Modal k-Space Sampling"
          }
          badge={draft?.bc || "free"}
        >
          <FieldRow label="Boundary condition" value={draft?.bc || "free"} />
          <FieldRow label="k vector" value={draft?.kVector || "not set"} />
          <FieldRow label="k sampling" value={draft?.kSampling || "not set"} />
          <FieldRow label="k path" value={draft?.kPath || "not set"} />
          <FieldRow
            label="Workflow inference"
            value="Gamma/free FMR when empty; dispersion_modal when nonzero k-path is set"
          />
          <FieldRow
            label="Demag-k gate"
            value="nonzero-k demag readiness is reported in diagnostics"
          />
          <FieldRow
            label="Expected result"
            value="branch-aware dispersion and mode-field handoff when artifacts exist"
          />
        </InspectorGroup>
      ) : null}
      {showCommandCenter ? (
        <InspectorGroup
          title="Modal Stage Command Center"
          badge="Eigenmodes"
        >
          <FieldRow
            label="Calculation workflow"
            value="fmr_modal / free_modes / dispersion_modal"
          />
          <FieldRow
            label="Equilibrium source"
            value={draft?.equilibriumSource ?? "not set"}
          />
          <FieldRow
            label="Operator"
            value={draft?.operator || "linearized_llg"}
          />
          <FieldRow
            label="Boundary/k sampling"
            value={`${draft?.bc || "free"}; ${draft?.kPath || draft?.kSampling || "k = 0"}`}
          />
          <FieldRow
            label="Solver request"
            value={`count ${draft?.count ?? "not set"}; target ${draft?.target ?? "not set"}`}
          />
          <FieldRow
            label="Effective modal request"
            value={modalDefaults.request}
          />
          <FieldRow
            label="Effective operator defaults"
            value={modalDefaults.operator}
          />
          <FieldRow
            label="Runtime activity"
            value={modalRuntime.activity}
          />
          <FieldRow
            label="Progress interpretation"
            value={modalRuntime.progress}
          />
          <FieldRow
            label="Outputs"
            value="spectrum, selected mode fields, dispersion, branches, diagnostics"
          />
          <FieldRow
            label="Current validation status"
            value={
              props.validation.length > 0
                ? props.validation.map((issue) => issue.message).join("; ")
                : "valid"
            }
          />
          <FieldRow
            label="Capability status"
            value="modal reference CPU ready; native production modal readiness is reported in diagnostics"
          />
          <FieldRow
            label="Latest manifest links"
            value={
              stage?.artifactRefs.length ? stage.artifactRefs.join(", ") : "none"
            }
          />
          <FieldRow
            label="Requested vs resolved execution"
            value="requested Eigenmodes; resolved backend/device/precision shown after plan"
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
              Validate stage
            </Button>
            <Button
              disabled={runModalDisabledReason !== null}
              size="sm"
              title={runModalDisabledReason ?? "Run the saved modal stage pipeline"}
              type="button"
              variant="primary"
              onClick={() => props.runRuntimeCommand?.("study.run")}
            >
              <Play size={13} aria-hidden="true" />
              Run modal stage
            </Button>
          </div>
          {runModalDisabledReason ? (
            <FieldRow label="Run readiness" value={runModalDisabledReason} />
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
        title="Eigenproblem"
        badge={draft?.target ?? "target"}
      >
        <FieldRow label="Mode count" value={draft?.count ?? "not set"} />
        <FieldRow label="Effective count" value={modalDefaults.count} />
        <FieldRow
          label="Target"
          value={draft?.target ?? "not set"}
        />
        <FieldRow label="Effective target" value={modalDefaults.target} />
        <FieldRow
          label="Target frequency"
          value={draft?.targetFrequency || "not set"}
        />
        <FieldRow
          label="Frequency window"
          value={
            draft?.target === "frequency_window"
              ? `${draft.frequencyMin || "not set"} Hz .. ${draft.frequencyMax || "not set"} Hz`
              : "not selected"
          }
        />
        <FieldRow label="Normalization" value={draft?.normalization ?? "not set"} />
        <FieldRow
          label="Effective normalization"
          value={modalDefaults.normalization}
        />
      </InspectorGroup>
      <InspectorGroup title="Linearization State">
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
          <FieldRow label="Boundary condition" value={draft?.bc || "free"} />
          <FieldRow label="k vector" value={draft?.kVector || "not set"} />
          <FieldRow label="k sampling" value={draft?.kSampling || "not set"} />
          <FieldRow label="k path" value={draft?.kPath || "not set"} />
      </InspectorGroup>
      <InspectorGroup title="Eigenmode Results">
        <FieldRow label="Status" value={stage?.status ?? "not started"} />
        <FieldRow label="Solver activity" value={modalRuntime.activity} />
        <FieldRow label="Progress interpretation" value={modalRuntime.progress} />
        <FieldRow label="Requested modes" value={modalDefaults.count} />
        <FieldRow
          label="Computed modes"
          value={modalRuntime.computedModes}
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
    relaxationPrerequisite:
      normalizedSource === "relax"
        ? "requires completed relaxation stage"
        : "not required",
    source: normalizedSource,
    sourceLabel: normalizedSource.replaceAll("_", " "),
  };
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

function summarizeModalDefaults(draft: StageInspectorFrameProps["draft"]) {
  const count = draft?.count || "10";
  const target = draft?.target || "lowest";
  const normalization = draft?.normalization || "unit_l2";
  const dampingPolicy = draft?.dampingPolicy || "ignore";
  const bc = draft?.bc || "free";
  const equilibriumSource = draft?.equilibriumSource || "relax";
  const includeDemag = draft?.includeDemag ?? true;

  return {
    count,
    normalization,
    operator: `linearized_llg; normalization ${normalization}; damping ${dampingPolicy}; demag ${
      includeDemag ? "included" : "excluded"
    }`,
    request: `count ${count}; target ${target}; equilibrium ${equilibriumSource}; boundary ${bc}`,
    target,
  };
}

function summarizeModalRuntime(
  stage: StageInspectorFrameProps["stage"],
  draft: StageInspectorFrameProps["draft"],
) {
  const status = stage?.status ?? "not started";
  const requestedModes = draft?.count || "10";
  const hasProgress =
    stage != null &&
    (stage.progressLabel != null ||
      stage.progressDetail != null ||
      stage.progressPercent > 0);
  const active = ["accepted", "dispatched", "materializing", "pending", "queued", "running"].includes(
    status.toLowerCase(),
  );

  return {
    activity: active
      ? `${status}; eigensolve stage is active`
      : `${status}; eigensolve stage is not active`,
    computedModes:
      stage?.runtimeMetric?.value ??
      (active ? `requested ${requestedModes}; result artifacts pending` : "not available"),
    progress: hasProgress
      ? `${stage?.progressLabel ?? "progress"}; ${stage?.progressDetail ?? `${stage?.progressPercent ?? 0}%`}`
      : active
        ? "lifecycle is running; modal iteration progress has not been published by the solver yet"
        : "not available",
  };
}
