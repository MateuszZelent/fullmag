"use client";

import React from "react";
import { formatFrequencyHz } from "@/shared/domain/analysis/frequencyUnits";
import { FormField } from "../primitives/FormField";
import {
  relaxationAlgorithmAvailability,
  type StudyStageDraft,
  type StudyStageDraftKind,
} from "./StudyStageAuthoringModel";
import {
  HysteresisStageDraftFields,
} from "./HysteresisStageDraftFields";
import { type FrequencyDomainAuthoringView } from "./stages/StageInspectorFrame";
import { StageAutosaveSection } from "./stages/StageAutosaveSection";

export function StudyStageDraftEditor({
  algorithmsAvailable,
  draft,
  demagEnabled = false,
  index,
  onUpdate,
  requestedBackend = "auto",
  requestedDevice = "auto",
  requestedMode = "strict",
  requestedPrecision = "double",
  validation,
  view = "overview",
}: {
  draft: StudyStageDraft;
  demagEnabled?: boolean;
  algorithmsAvailable?: readonly string[];
  index: number;
  onUpdate: (patch: Partial<StudyStageDraft>) => void;
  requestedBackend?: string;
  requestedDevice?: string;
  requestedMode?: string;
  requestedPrecision?: string;
  validation: readonly { message: string; severity: "error" | "warning" }[];
  view?: FrequencyDomainAuthoringView;
}) {
  return (
    <div className="fm-study-stage-editor">
      <div className="fm-study-stage-editor__header">
        <strong>
          Stage {index + 1}: {studyStageDraftKindLabel(draft.kind)}
        </strong>
        <span data-has-issues={validation.length > 0 ? "true" : undefined}>
          {validation.length === 0 ? "valid" : `${validation.length} issue(s)`}
        </span>
      </div>
      {validation.length > 0 ? (
        <ul className="fm-inspector-validation-list">
          {validation.map((issue) => (
            <li key={`${issue.severity}:${issue.message}`}>
              {issue.severity}: {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
      <FormField
        disabled={draft.kind === "unsupported"}
        label="Kind"
        type="select"
        value={draft.kind}
        onChange={(event) =>
          onUpdate({ kind: event.target.value as StudyStageDraftKind })
        }
      >
        <option value="relax">Relax</option>
        <option value="add_field_drive">Add antenna</option>
        <option value="table_autosave">Table autosave</option>
        <option value="autosave">Autosave</option>
        <option value="fft_response">FFT response</option>
        <option value="run">Run</option>
        <option value="hysteresis">Hysteresis</option>
        <option value="eigenmodes">Eigenmodes</option>
        <option value="frequency_response">Frequency response</option>
        <option value="save_state">Save state</option>
        <option value="change_device">Change device</option>
        {draft.kind === "unsupported" ? (
          <option value="unsupported">Unsupported (read-only)</option>
        ) : null}
      </FormField>
      <FormField
        disabled={draft.kind === "unsupported"}
        label="Stage ID"
        value={draft.stageId}
        onChange={(event) => onUpdate({ stageId: event.target.value })}
      />
      {draft.kind === "unsupported" ? (
        <div className="fm-study-stage-note">
          This stage kind is not supported by the current editor. Its original
          payload is preserved losslessly and cannot be edited here.
        </div>
      ) : draft.kind === "add_field_drive" ? (
        <div className="fm-study-stage-note">
          The ordered instruction adds its field drive to the current simulation
          state. Full antenna controls and the sampled source FFT are shown below.
        </div>
      ) : draft.kind === "table_autosave" ? (
        <div className="fm-study-stage-note">
          Zero-duration instruction that turns the shared table sampling clock ON
          or OFF for following Run stages. t_sampling and FFT-clock diagnostics
          are shown below.
        </div>
      ) : draft.kind === "autosave" ? (
        <div className="fm-study-stage-note">
          Zero-duration instruction that enables, replaces, or disables one
          periodic output, or clears all periodic outputs for following Run stages.
        </div>
      ) : draft.kind === "fft_response" ? (
        <div className="fm-study-stage-note">
          Zero-duration instruction that turns Gamma response FFT analysis ON or
          OFF for following Run stages. It uses the active table-autosave clock.
        </div>
      ) : draft.kind === "run" ? (
        <>
          <FormField
            label="Until"
            unit="s"
            value={draft.untilSeconds}
            onChange={(event) => onUpdate({ untilSeconds: event.target.value })}
          />
          <StageAutosaveSection
            draft={draft.stageAutosave}
            owner="run"
            onChange={(stageAutosave) => onUpdate({ stageAutosave })}
          />
        </>
      ) : draft.kind === "hysteresis" ? (
        <HysteresisStageDraftFields
          algorithmsAvailable={algorithmsAvailable}
          draft={draft}
          onUpdate={onUpdate}
        />
      ) : draft.kind === "eigenmodes" ? (
        <EigenmodesStageDraftFields
          draft={draft}
          onUpdate={onUpdate}
          view={view}
        />
      ) : draft.kind === "frequency_response" ? (
        <FrequencyResponseStageDraftFields
          draft={draft}
          onUpdate={onUpdate}
          view={view}
        />
      ) : draft.kind === "save_state" ? (
        <SaveStateStageDraftFields draft={draft} onUpdate={onUpdate} />
      ) : draft.kind === "change_device" ? (
        <ChangeDeviceStageDraftFields draft={draft} onUpdate={onUpdate} />
      ) : (
        <RelaxStageDraftFields
          algorithmsAvailable={algorithmsAvailable}
          draft={draft}
          demagEnabled={demagEnabled}
          onUpdate={onUpdate}
          requestedBackend={requestedBackend}
          requestedDevice={requestedDevice}
          requestedMode={requestedMode}
          requestedPrecision={requestedPrecision}
        />
      )}
    </div>
  );
}

function studyStageDraftKindLabel(kind: StudyStageDraftKind): string {
  if (kind === "unsupported") return "Unsupported (read-only)";
  if (kind === "add_field_drive") return "Add Antenna";
  if (kind === "table_autosave") return "Table Autosave";
  if (kind === "autosave") return "Autosave";
  if (kind === "fft_response") return "FFT Response";
  if (kind === "eigenmodes") return "Eigenmodes";
  if (kind === "frequency_response") return "Frequency Response";
  if (kind === "hysteresis") return "Hysteresis";
  if (kind === "save_state") return "Save State";
  if (kind === "change_device") return "Change Device";
  if (kind === "run") return "Run";
  return "Relax";
}

function ChangeDeviceStageDraftFields({
  draft,
  onUpdate,
}: {
  draft: StudyStageDraft;
  onUpdate: (patch: Partial<StudyStageDraft>) => void;
}) {
  return (
    <FormField
      label="Execution device"
      type="select"
      value={draft.deviceTarget ?? "auto"}
      onChange={(event) => onUpdate({ deviceTarget: event.target.value })}
    >
      <option value="cpu">CPU</option>
      <option value="gpu">GPU</option>
      <option value="cuda">CUDA</option>
      <option value="auto">Auto</option>
    </FormField>
  );
}

function RelaxStageDraftFields({
  algorithmsAvailable,
  draft,
  demagEnabled,
  onUpdate,
  requestedBackend,
  requestedDevice,
  requestedMode,
  requestedPrecision,
}: {
  draft: StudyStageDraft;
  demagEnabled: boolean;
  algorithmsAvailable?: readonly string[];
  onUpdate: (patch: Partial<StudyStageDraft>) => void;
  requestedBackend: string;
  requestedDevice: string;
  requestedMode: string;
  requestedPrecision: string;
}) {
  const tpiEligible =
    requestedMode === "extended" &&
    requestedBackend === "fem" &&
    requestedDevice === "cpu";
  const availability = (value: string) =>
    relaxationAlgorithmAvailability(value, {
      algorithmsAvailable,
      backend: requestedBackend,
      demagEnabled,
      device: requestedDevice,
      mode: requestedMode,
    });
  const algorithmSupported = (value: string) => availability(value).supported;
  const adaptiveSupported =
    algorithmSupported("llg_overdamped") &&
    requestedPrecision === "double" &&
    (requestedBackend === "fem" || requestedDevice === "cpu");
  return (
    <>
      <FormField
        label="Algorithm"
        type="select"
        value={draft.algorithm}
        onChange={(event) => {
          const algorithm = event.target.value;
          onUpdate(
            algorithm === "llg_overdamped"
              ? { algorithm }
              : {
                  algorithm,
                  demagInterval: "",
                  dt: "",
                  dtMin: "",
                  fieldEvery: "",
                  maxError: "",
                  maxRelaxationTime: "",
                  relaxAlpha: "",
                  solver: "",
                },
          );
        }}
      >
        <option value="llg_overdamped" disabled={!algorithmSupported("llg_overdamped")}>
          LLG overdamped{algorithmSupported("llg_overdamped") ? "" : " (not advertised by active session)"}
        </option>
        <option value="projected_gradient_bb" disabled={!algorithmSupported("projected_gradient_bb")}>
          Projected gradient BB
          {algorithmSupported("projected_gradient_bb")
            ? ""
            : ` — ${availability("projected_gradient_bb").reason}`}
        </option>
        <option value="nonlinear_cg" disabled={!algorithmSupported("nonlinear_cg")}>
          Nonlinear CG{algorithmSupported("nonlinear_cg") ? "" : " (not advertised by active session)"}
        </option>
        {tpiEligible || draft.algorithm === "tangent_plane_implicit" ? (
          <option
            value="tangent_plane_implicit"
            disabled={
              !tpiEligible || !algorithmSupported("tangent_plane_implicit")
            }
          >
            Tangent-plane implicit (development CPU only)
            {algorithmSupported("tangent_plane_implicit")
              ? ""
              : ` — ${availability("tangent_plane_implicit").reason}`}
          </option>
        ) : null}
      </FormField>
      <FormField
        label="Torque tol"
        unit="A/m"
        hint="Canonical max |m × H_eff| threshold; tesla is a derived display conversion."
        value={draft.torqueTolerance}
        onChange={(event) => onUpdate({ torqueTolerance: event.target.value })}
      />
      <FormField
        label="Energy tol"
        unit="J"
        value={draft.energyTolerance}
        onChange={(event) => onUpdate({ energyTolerance: event.target.value })}
      />
      <FormField
        label="Max steps"
        value={draft.maxSteps}
        onChange={(event) => onUpdate({ maxSteps: event.target.value })}
      />
      {draft.algorithm === "llg_overdamped" ? (
        <>
          <FormField
            label="Max relaxation time"
            unit="s"
            value={draft.maxRelaxationTime}
            onChange={(event) => onUpdate({ maxRelaxationTime: event.target.value })}
          />
          <FormField
            label="Relax alpha"
            value={draft.relaxAlpha}
            onChange={(event) => onUpdate({ relaxAlpha: event.target.value })}
          />
          <FormField
            label="Integrator"
            hint="Per-integrator capability reasons are not published; the active-session planner validates this choice."
            type="select"
            value={draft.solver}
            onChange={(event) => onUpdate({ solver: event.target.value })}
          >
            <option value="">Default</option>
            <option value="rk23">RK23</option>
            <option value="rk45">RK45</option>
            <option value="heun">Heun</option>
          </FormField>
          <FormField
            label="Timestep mode"
            hint={adaptiveSupported ? undefined : "Adaptive FDM requires an explicit CPU device and advertised LLG capability."}
            type="select"
            value={draft.timestepMode}
            onChange={(event) =>
              onUpdate(
                event.target.value === "fixed"
                  ? {
                      dt: "",
                      dtMin: "",
                      maxError: "",
                      timestepConflict: false,
                      timestepMode: "fixed",
                    }
                  : event.target.value === "adaptive"
                    ? {
                        dt: "",
                        timestepConflict: false,
                        timestepMode: "adaptive",
                      }
                    : {
                        dt: "",
                        dtMin: "",
                        maxError: "",
                        timestepConflict: false,
                        timestepMode: "auto",
                      },
              )
            }
          >
            <option value="auto">Auto</option>
            <option value="fixed">Fixed</option>
            <option value="adaptive" disabled={!adaptiveSupported}>Adaptive</option>
          </FormField>
          {draft.timestepMode === "fixed" ? (
            <FormField
              label="Fixed dt"
              unit="s"
              value={draft.dt}
              onChange={(event) => onUpdate({ dt: event.target.value })}
            />
          ) : draft.timestepMode === "adaptive" ? (
            <>
              <FormField
                label="Initial dt"
                unit="s"
                value={draft.dt}
                onChange={(event) => onUpdate({ dt: event.target.value })}
              />
              <FormField
                label="Adaptive dt min"
                unit="s"
                value={draft.dtMin}
                onChange={(event) => onUpdate({ dtMin: event.target.value })}
              />
              <FormField label="Adaptive dt max" unit="s" value={draft.dtMax} onChange={(event) => onUpdate({ dtMax: event.target.value })} />
              <FormField
                label="Tolerance mode"
                type="select"
                value={draft.toleranceMode}
                onChange={(event) => onUpdate({ toleranceMode: event.target.value as StudyStageDraft["toleranceMode"] })}
              >
                <option value="max_error">Maximum vector error</option>
                <option value="advanced">Advanced atol/rtol</option>
              </FormField>
              {draft.toleranceMode === "advanced" ? (
                <>
                  <FormField label="Absolute tolerance" value={draft.atol} onChange={(event) => onUpdate({ atol: event.target.value })} />
                  <FormField label="Relative tolerance" value={draft.rtol} onChange={(event) => onUpdate({ rtol: event.target.value })} />
                  <FormField label="Safety factor" value={draft.safety} onChange={(event) => onUpdate({ safety: event.target.value })} />
                  <FormField label="Growth limit" value={draft.growthLimit} onChange={(event) => onUpdate({ growthLimit: event.target.value })} />
                  <FormField label="Shrink limit" value={draft.shrinkLimit} onChange={(event) => onUpdate({ shrinkLimit: event.target.value })} />
                  <FormField label="Max spin rotation" value={draft.maxSpinRotation} onChange={(event) => onUpdate({ maxSpinRotation: event.target.value })} />
                  <FormField label="Norm tolerance" value={draft.normTolerance} onChange={(event) => onUpdate({ normTolerance: event.target.value })} />
                </>
              ) : (
                <FormField
                  label="Maximum embedded vector error"
                  hint="Absolute maximum node/cell embedded-vector error."
                  value={draft.maxError}
                  onChange={(event) => onUpdate({ maxError: event.target.value })}
                />
              )}
            </>
          ) : null}
          <FormField
            label="Demag interval"
            unit="s"
            value={draft.demagInterval}
            onChange={(event) => onUpdate({ demagInterval: event.target.value })}
          />
          <FormField
            label="Field every"
            hint="Push field samples every N solver steps."
            value={draft.fieldEvery}
            onChange={(event) => onUpdate({ fieldEvery: event.target.value })}
          />
        </>
      ) : null}
      <StageAutosaveSection
        draft={draft.stageAutosave}
        owner="relax"
        onChange={(stageAutosave) => onUpdate({ stageAutosave })}
      />
    </>
  );
}

function EigenmodesStageDraftFields({
  draft,
  onUpdate,
  view,
}: {
  draft: StudyStageDraft;
  onUpdate: (patch: Partial<StudyStageDraft>) => void;
  view: FrequencyDomainAuthoringView;
}) {
  if (view === "calculation_mode") {
    return <CalculationModeDraftField draft={draft} onUpdate={onUpdate} />;
  }
  if (view === "solver" || view === "outputs") {
    return (
      <>
        {view === "solver" ? (
          <SpectralStageDraftFields
            draft={draft}
            onUpdate={onUpdate}
            view="solver"
          />
        ) : null}
        <FormField
          label="Mode count"
          value={draft.count}
          onChange={(event) => onUpdate({ count: event.target.value })}
        />
        <EigenmodeTargetFields draft={draft} onUpdate={onUpdate} />
      </>
    );
  }
  if (view !== "overview") {
    return (
      <SpectralStageDraftFields
        draft={draft}
        onUpdate={onUpdate}
        view={view}
      />
    );
  }
  return (
    <>
      <SpectralStageDraftFields
        draft={draft}
        onUpdate={onUpdate}
        view="overview"
      />
      <FormField
        label="Mode count"
        value={draft.count}
        onChange={(event) => onUpdate({ count: event.target.value })}
      />
      <EigenmodeTargetFields draft={draft} onUpdate={onUpdate} />
    </>
  );
}

function BiasFieldSweepDraftFields({
  draft,
  onUpdate,
}: {
  draft: StudyStageDraft;
  onUpdate: (patch: Partial<StudyStageDraft>) => void;
}) {
  return (
    <>
      <FormField
        label="Bias field sweep samples"
        hint="Canonical unit A/m; enter one [Hx, Hy, Hz] vector per line. Leave empty for a single-field solve."
        type="textarea"
        rows={4}
        value={draft.biasFieldSamplesApm}
        onChange={(event) =>
          onUpdate({ biasFieldSamplesApm: event.target.value })
        }
      />
      <FormField
        label="Bias field equilibrium policy"
        hint="Each sample must publish its own accepted equilibrium before modal solve."
        type="select"
        value={draft.biasFieldEquilibriumPolicy}
        onChange={(event) =>
          onUpdate({ biasFieldEquilibriumPolicy: event.target.value })
        }
      >
        <option value="relax_each">Relax each sample</option>
        <option value="continuation">Continue from previous sample</option>
      </FormField>
      <FormField
        label="Bias field continuation seed"
        hint="The seed applies to the first sample; continuation then uses the previous accepted equilibrium."
        type="select"
        value={draft.biasFieldContinuationSeed}
        onChange={(event) =>
          onUpdate({ biasFieldContinuationSeed: event.target.value })
        }
      >
        <option value="initial_state">Initial state</option>
        <option value="previous_accepted_equilibrium">
          Previous accepted equilibrium
        </option>
      </FormField>
    </>
  );
}

function EigenmodeTargetFields({
  draft,
  onUpdate,
}: {
  draft: StudyStageDraft;
  onUpdate: (patch: Partial<StudyStageDraft>) => void;
}) {
  return (
    <>
      <FormField
        label="Target"
        type="select"
        value={draft.target}
        onChange={(event) => onUpdate({ target: event.target.value })}
      >
        <option value="lowest">Lowest frequency</option>
        <option value="nearest">Nearest frequency</option>
        <option value="frequency_window">Frequency window</option>
      </FormField>
      {draft.target === "nearest" ? (
        <FormField
          label="Target frequency"
          unit="Hz"
          hint={frequencyDraftPreview(draft.targetFrequency)}
          value={draft.targetFrequency}
          onChange={(event) => onUpdate({ targetFrequency: event.target.value })}
        />
      ) : null}
      {draft.target === "frequency_window" ? (
        <>
          <FormField
            label="Frequency min"
            unit="Hz"
            hint={frequencyDraftPreview(draft.frequencyMin)}
            value={draft.frequencyMin}
            onChange={(event) => onUpdate({ frequencyMin: event.target.value })}
          />
          <FormField
            label="Frequency max"
            unit="Hz"
            hint={frequencyDraftPreview(draft.frequencyMax)}
            value={draft.frequencyMax}
            onChange={(event) => onUpdate({ frequencyMax: event.target.value })}
          />
        </>
      ) : null}
    </>
  );
}

function FrequencyResponseStageDraftFields({
  draft,
  onUpdate,
  view,
}: {
  draft: StudyStageDraft;
  onUpdate: (patch: Partial<StudyStageDraft>) => void;
  view: FrequencyDomainAuthoringView;
}) {
  if (view === "calculation_mode") {
    return <CalculationModeDraftField draft={draft} onUpdate={onUpdate} />;
  }
  if (view === "excitation") {
    return (
      <>
        <FormField
          label="Excitation"
          unit="A/m"
          value={draft.excitationField}
          onChange={(event) => onUpdate({ excitationField: event.target.value })}
        />
        <FormField
          label="Excitation phase"
          unit="rad"
          value={draft.excitationPhaseRad}
          onChange={(event) =>
            onUpdate({ excitationPhaseRad: event.target.value })
          }
        />
      </>
    );
  }
  if (view === "sweep") {
    return (
      <FormField
        label="Frequencies"
        hint={frequencyListDraftPreview(draft.frequenciesHz)}
        value={draft.frequenciesHz}
        onChange={(event) => onUpdate({ frequenciesHz: event.target.value })}
      />
    );
  }
  if (view === "outputs") {
    return (
      <FormField
        label="Observable"
        value={draft.observable}
        onChange={(event) => onUpdate({ observable: event.target.value })}
      />
    );
  }
  if (view !== "overview") {
    return (
      <SpectralStageDraftFields
        draft={draft}
        onUpdate={onUpdate}
        view={view}
      />
    );
  }
  return (
    <>
      <SpectralStageDraftFields
        draft={draft}
        onUpdate={onUpdate}
        view="overview"
      />
      <FormField
        label="Frequencies"
        hint={frequencyListDraftPreview(draft.frequenciesHz)}
        value={draft.frequenciesHz}
        onChange={(event) => onUpdate({ frequenciesHz: event.target.value })}
      />
      <FormField
        label="Excitation"
        unit="A/m"
        value={draft.excitationField}
        onChange={(event) => onUpdate({ excitationField: event.target.value })}
      />
      <FormField
        label="Excitation phase"
        unit="rad"
        value={draft.excitationPhaseRad}
        onChange={(event) => onUpdate({ excitationPhaseRad: event.target.value })}
      />
      <FormField
        label="Observable"
        value={draft.observable}
        onChange={(event) => onUpdate({ observable: event.target.value })}
      />
    </>
  );
}

function frequencyDraftPreview(value: string | null | undefined): string {
  const parsed = Number(value ?? "");
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return "Stored as Hz; preview not available";
  }
  return `Stored as Hz; preview ${formatFrequencyHz(parsed)}`;
}

function frequencyListDraftPreview(value: string | null | undefined): string {
  const frequencies = parseNumberList(value).filter(
    (entry) => Number.isFinite(entry) && entry > 0,
  );
  if (!frequencies.length) {
    return "Comma or whitespace separated values in Hz.";
  }
  return `Stored as Hz; preview ${frequencies
    .map((entry) => formatFrequencyHz(entry))
    .join(", ")}`;
}

function parseNumberList(value: string | null | undefined): number[] {
  return String(value ?? "")
    .split(/[\s,;]+/)
    .flatMap((entry) => {
      const parsed = Number(entry.trim());
      return Number.isFinite(parsed) ? [parsed] : [];
    });
}

function CalculationModeDraftField({
  draft,
  onUpdate,
}: {
  draft: StudyStageDraft;
  onUpdate: (patch: Partial<StudyStageDraft>) => void;
}) {
  const options =
    draft.kind === "frequency_response"
      ? [
          ["fmr_response", "FMR response"],
          ["response_map", "Response map"],
        ]
      : [
          ["fmr_modal", "FMR modal"],
          ["free_modes", "Free modes"],
          ["dispersion_modal", "Dispersion modal"],
        ];
  return (
    <FormField
      label="Calculation mode"
      type="select"
      value={draft.calculationMode}
      onChange={(event) => onUpdate({ calculationMode: event.target.value })}
    >
      {options.map(([value, label]) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </FormField>
  );
}

function SaveStateStageDraftFields({
  draft,
  onUpdate,
}: {
  draft: StudyStageDraft;
  onUpdate: (patch: Partial<StudyStageDraft>) => void;
}) {
  return (
    <>
      <FormField
        label="Artifact"
        value={draft.artifactName}
        onChange={(event) => onUpdate({ artifactName: event.target.value })}
      />
      <FormField
        label="Format"
        value={draft.format}
        onChange={(event) => onUpdate({ format: event.target.value })}
      />
      <FormField
        label="Dataset"
        value={draft.dataset}
        onChange={(event) => onUpdate({ dataset: event.target.value })}
      />
    </>
  );
}

function SpectralStageDraftFields({
  draft,
  onUpdate,
  view,
}: {
  draft: StudyStageDraft;
  onUpdate: (patch: Partial<StudyStageDraft>) => void;
  view: FrequencyDomainAuthoringView;
}) {
  const showEquilibrium = view === "overview" || view === "equilibrium";
  const showOperator =
    view === "overview" || view === "operator" || view === "solver";
  const showBoundary =
    view === "overview" ||
    view === "setup" ||
    view === "boundary" ||
    view === "periodic_pairs";
  const showKSampling =
    view === "overview" ||
    view === "setup" ||
    view === "k_sampling" ||
    view === "k_path" ||
    view === "k_grid";
  const showBiasFieldSweep =
    draft.kind === "eigenmodes" &&
    (view === "overview" || view === "setup");
  return (
    <>
      {showOperator ? (
        <>
          {draft.kind === "eigenmodes" ? (
            <FormField
              label="Operator"
              type="select"
              value={draft.operator}
              onChange={(event) => onUpdate({ operator: event.target.value })}
            >
              <option value="linearized_llg">Linearized LLG</option>
              <option value="full_2x2">Full 2x2</option>
            </FormField>
          ) : null}
          {draft.kind === "frequency_response" ? (
            <div className="fm-study-stage-note">
              Solver implementation is resolved from device, precision, certificates,
              and active capabilities.
            </div>
          ) : null}
          <FormField
            label="Include demag"
            checked={draft.includeDemag}
            type="checkbox"
            onChange={(event) =>
              onUpdate({ includeDemag: event.target.checked })
            }
          />
          <FormField
            label="Normalization"
            type="select"
            value={draft.normalization}
            onChange={(event) =>
              onUpdate({ normalization: event.target.value })
            }
          >
            <option value="unit_l2">Unit L2</option>
            <option value="unit_max_amplitude">Unit max amplitude</option>
          </FormField>
          <FormField
            label="Damping"
            type="select"
            value={draft.dampingPolicy}
            onChange={(event) =>
              onUpdate({ dampingPolicy: event.target.value })
            }
          >
            <option value="ignore">Ignore</option>
            <option value="include">Include</option>
          </FormField>
        </>
      ) : null}
      {showEquilibrium ? (
        <>
          <FormField
            label="Equilibrium"
            type="select"
            value={draft.equilibriumSource}
            onChange={(event) =>
              onUpdate({ equilibriumSource: event.target.value })
            }
          >
            <option value="relax">Relax stage</option>
            <option value="provided">Provided state</option>
            <option value="artifact">Named artifact</option>
          </FormField>
          <FormField
            label="Eq artifact"
            value={draft.equilibriumArtifact}
            onChange={(event) =>
              onUpdate({ equilibriumArtifact: event.target.value })
            }
          />
        </>
      ) : null}
      {showKSampling ? (
        <>
          <FormField
            label="k vector"
            value={draft.kVector}
            onChange={(event) => onUpdate({ kVector: event.target.value })}
          />
          <FormField
            label="k sampling"
            hint="JSON object."
            type="textarea"
            rows={3}
            value={draft.kSampling}
            onChange={(event) => onUpdate({ kSampling: event.target.value })}
          />
          {draft.kind === "eigenmodes" ? (
            <FormField
              label="k path"
              hint="Label:kx,ky,kz; Label:kx,ky,kz | samples=n,n"
              type="textarea"
              rows={3}
              value={draft.kPath}
              onChange={(event) => onUpdate({ kPath: event.target.value })}
            />
          ) : null}
        </>
      ) : null}
      {showBiasFieldSweep ? (
        <BiasFieldSweepDraftFields draft={draft} onUpdate={onUpdate} />
      ) : null}
      {showBoundary ? (
        <>
          <FormField
            label="BC"
            hint="Boundary condition name or JSON object."
            value={draft.bc}
            onChange={(event) => onUpdate({ bc: event.target.value })}
          />
          {draft.kind === "eigenmodes" || draft.kind === "frequency_response" ? (
            <FormField
              label="Magnetostatic BC"
              type="select"
              value={draft.magnetostaticBc}
              onChange={(event) =>
                onUpdate({ magnetostaticBc: event.target.value })
              }
            >
              <option value="open">Open</option>
              <option value="periodic_airbox_k0">Periodic airbox k=0</option>
              <option value="floquet_airbox">Floquet airbox</option>
            </FormField>
          ) : null}
        </>
      ) : null}
    </>
  );
}
