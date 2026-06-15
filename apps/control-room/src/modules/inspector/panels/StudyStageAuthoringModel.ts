import type { AuthoringTransactionRequest, JsonObject, JsonValue } from "@/kernel/api/apiTypes";
import {
  DEFAULT_HYSTERESIS_BRANCH_MODE,
  DEFAULT_HYSTERESIS_FIELD_MAX_MT,
  DEFAULT_HYSTERESIS_FIELD_MIN_MT,
  DEFAULT_HYSTERESIS_FIELD_STEP_MT,
  DEFAULT_HYSTERESIS_INITIAL_PROTOCOL,
  DEFAULT_HYSTERESIS_MEASUREMENT_AXIS,
  DEFAULT_HYSTERESIS_ORIENTATION_PRESET,
  DEFAULT_HYSTERESIS_SETTLE_STEP,
  DEFAULT_HYSTERESIS_STORAGE,
} from "@/shared/domain/study/hysteresisDefaults";

type JsonRecord = Record<string, unknown>;

const SUPPORTED_FIELD_SEGMENT_ENDPOINT_POLICIES = new Set([
  "include_stop",
  "skip_start",
  "include_both",
]);
const SUPPORTED_SETTLE_STEP_KINDS = new Set([
  "relax",
  "minimize",
  "dynamics_settle",
]);
const SUPPORTED_SETTLE_METHODS_BY_KIND: Record<string, Set<string>> = {
  dynamics_settle: new Set(["heun_dynamics_settle"]),
  minimize: new Set([
    "projected_gradient_bb",
    "nonlinear_cg",
    "tangent_plane_implicit",
  ]),
  relax: new Set([
    "llg_overdamped",
    "projected_gradient_bb",
    "nonlinear_cg",
    "tangent_plane_implicit",
  ]),
};
const SUPPORTED_SETTLE_NON_CONVERGENCE_POLICIES = new Set([
  "continue_with_warning",
  "stop_stage",
  "run_next_algorithm",
  "retry_with_smaller_dt",
]);
const SUPPORTED_HYSTERESIS_STORAGE_MAGNETIZATION = new Set([
  "none",
  "selected",
  "every_n",
  "every_step",
  "key_events",
]);
const SUPPORTED_HYSTERESIS_ORIENTATION_PRESETS = new Set([
  "oop_positive",
  "oop_negative",
  "in_plane_x",
  "in_plane_y",
]);
const SUPPORTED_HYSTERESIS_MEASUREMENT_AXES = new Set([
  "field_axis",
  "sample_normal",
  "easy_axis",
  "custom",
]);
const SUPPORTED_SPECTRAL_NORMALIZATIONS = [
  "unit_l2",
  "unit_max_amplitude",
] as const;
const SUPPORTED_SPECTRAL_DAMPING_POLICIES = ["ignore", "include"] as const;
const SUPPORTED_SPECTRAL_EQUILIBRIUM_SOURCES = [
  "provided",
  "relax",
  "artifact",
] as const;
const SUPPORTED_EIGEN_CALCULATION_MODES = [
  "fmr_modal",
  "free_modes",
  "dispersion_modal",
] as const;
const SUPPORTED_RESPONSE_CALCULATION_MODES = [
  "fmr_response",
  "response_map",
] as const;
const SPECTRAL_NORMALIZATION_ALIASES: Record<string, string> = {
  max_component: "unit_max_amplitude",
};
const SPECTRAL_DAMPING_POLICY_ALIASES: Record<string, string> = {
  full: "include",
  linearized: "include",
};
const SPECTRAL_EQUILIBRIUM_SOURCE_ALIASES: Record<string, string> = {
  current_state: "provided",
};
const MAX_HYSTERESIS_AUTHORING_FIELD_POINTS = 10_000;

export type StudyStageDraftKind =
  | "change_device"
  | "eigenmodes"
  | "frequency_response"
  | "hysteresis"
  | "relax"
  | "run"
  | "save_state";

export interface StudyStageDraft {
  algorithm: string;
  artifactName: string;
  bc: string;
  calculationMode: string;
  count: string;
  dampingPolicy: string;
  dataset: string;
  deviceTarget: string;
  dt: string;
  dtMin: string;
  energyTolerance: string;
  equilibriumArtifact: string;
  equilibriumSource: string;
  excitationField: string;
  excitationPhaseRad: string;
  fieldEvery: string;
  fieldMaxMt: string;
  fieldMinMt: string;
  fieldStepMt: string;
  fieldSteps: string;
  format: string;
  frequenciesHz: string;
  includeDemag: boolean;
  kind: StudyStageDraftKind;
  kSampling: string;
  kVector: string;
  maxError: string;
  maxPhysicalTime: string;
  maxPseudotime: string;
  maxSteps: string;
  normalization: string;
  observable: string;
  relaxAlpha: string;
  solver: string;
  stageId: string;
  startField: string;
  stopField: string;
  target: string;
  targetFrequency: string;
  frequencyMin: string;
  frequencyMax: string;
  torqueTolerance: string;
  untilSeconds: string;
  // Hysteresis expansion fields
  protocolKind: string;
  initialStatePolicy: string;
  initialStateRef: string;
  orientationMode: string;
  thetaDeg: string;
  phiDeg: string;
  customDirection: string;
  measurementAxis: string;
  measurementAxisCustomVector: string;
  fieldScheduleMode: string;
  fieldSegments: string;
  denseWindows: string;
  saturationMode: string;
  maxProbeField: string;
  saturationThresholds: string;
  settlePipelineMode: string;
  settleSteps: string;
  settleBranches: string;
  minorLoops: string;
  storagePolicy: string;
  storageEstimateAcknowledged: boolean;
}

export interface StudyStageDraftValidation {
  message: string;
  severity: "error" | "warning";
}

const DEFAULT_RELAX_STAGE_DRAFT: StudyStageDraft = {
  algorithm: "llg_overdamped",
  artifactName: "state_snapshot",
  bc: "free",
  calculationMode: "",
  count: "10",
  dampingPolicy: "ignore",
  dataset: "",
  deviceTarget: "cpu",
  dt: "auto",
  dtMin: "",
  energyTolerance: "",
  equilibriumArtifact: "",
  equilibriumSource: "relax",
  excitationField: "0, 0, 1",
  excitationPhaseRad: "0",
  fieldEvery: "",
  fieldMaxMt: "",
  fieldMinMt: "",
  fieldStepMt: "",
  fieldSteps: "",
  format: "",
  frequenciesHz: "1e9",
  includeDemag: true,
  kind: "relax",
  kSampling: "",
  kVector: "",
  maxError: "",
  maxPhysicalTime: "",
  maxPseudotime: "",
  maxSteps: "50000",
  normalization: "unit_l2",
  observable: "susceptibility_tensor",
  relaxAlpha: "1",
  solver: "rk23",
  stageId: "",
  startField: "0, 0, -0.1",
  stopField: "0, 0, 0.1",
  target: "lowest",
  targetFrequency: "",
  frequencyMin: "",
  frequencyMax: "",
  torqueTolerance: "1e-6",
  untilSeconds: "",
  protocolKind: "",
  initialStatePolicy: "",
  initialStateRef: "",
  orientationMode: "",
  thetaDeg: "",
  phiDeg: "",
  customDirection: "",
  measurementAxis: "",
  measurementAxisCustomVector: "",
  fieldScheduleMode: "",
  fieldSegments: "",
  denseWindows: "",
  saturationMode: "",
  maxProbeField: "",
  saturationThresholds: "",
  settlePipelineMode: "",
  settleSteps: "",
  settleBranches: "",
  minorLoops: "",
  storagePolicy: "",
  storageEstimateAcknowledged: false,
};

const DEFAULT_RUN_STAGE_DRAFT: StudyStageDraft = {
  algorithm: "llg_overdamped",
  artifactName: "state_snapshot",
  bc: "free",
  calculationMode: "",
  count: "10",
  dampingPolicy: "ignore",
  dataset: "",
  deviceTarget: "cpu",
  dt: "auto",
  dtMin: "",
  energyTolerance: "",
  equilibriumArtifact: "",
  equilibriumSource: "relax",
  excitationField: "0, 0, 1",
  excitationPhaseRad: "0",
  fieldEvery: "",
  fieldMaxMt: "",
  fieldMinMt: "",
  fieldStepMt: "",
  fieldSteps: "",
  format: "",
  frequenciesHz: "1e9",
  includeDemag: true,
  kind: "run",
  kSampling: "",
  kVector: "",
  maxError: "",
  maxPhysicalTime: "",
  maxPseudotime: "",
  maxSteps: "",
  normalization: "unit_l2",
  observable: "susceptibility_tensor",
  relaxAlpha: "",
  solver: "",
  stageId: "",
  startField: "0, 0, -0.1",
  stopField: "0, 0, 0.1",
  target: "lowest",
  targetFrequency: "",
  frequencyMin: "",
  frequencyMax: "",
  torqueTolerance: "",
  untilSeconds: "1e-9",
  protocolKind: "",
  initialStatePolicy: "",
  initialStateRef: "",
  orientationMode: "",
  thetaDeg: "",
  phiDeg: "",
  customDirection: "",
  measurementAxis: "",
  measurementAxisCustomVector: "",
  fieldScheduleMode: "",
  fieldSegments: "",
  denseWindows: "",
  saturationMode: "",
  maxProbeField: "",
  saturationThresholds: "",
  settlePipelineMode: "",
  settleSteps: "",
  settleBranches: "",
  minorLoops: "",
  storagePolicy: "",
  storageEstimateAcknowledged: false,
};

const DEFAULT_EIGENMODES_STAGE_DRAFT: StudyStageDraft = {
  ...DEFAULT_RELAX_STAGE_DRAFT,
  algorithm: "",
  calculationMode: "fmr_modal",
  dt: "",
  kind: "eigenmodes",
  maxSteps: "",
  relaxAlpha: "",
  solver: "",
  torqueTolerance: "",
};

const DEFAULT_FREQUENCY_RESPONSE_STAGE_DRAFT: StudyStageDraft = {
  ...DEFAULT_EIGENMODES_STAGE_DRAFT,
  calculationMode: "fmr_response",
  equilibriumSource: "provided",
  kind: "frequency_response",
};

const DEFAULT_SAVE_STATE_STAGE_DRAFT: StudyStageDraft = {
  ...DEFAULT_RUN_STAGE_DRAFT,
  kind: "save_state",
  untilSeconds: "",
};

const DEFAULT_CHANGE_DEVICE_STAGE_DRAFT: StudyStageDraft = {
  ...DEFAULT_RUN_STAGE_DRAFT,
  deviceTarget: "cpu",
  kind: "change_device",
  untilSeconds: "",
};

const DEFAULT_HYSTERESIS_STAGE_DRAFT: StudyStageDraft = {
  ...DEFAULT_RELAX_STAGE_DRAFT,
  algorithm: "",
  dt: "",
  fieldMaxMt: String(DEFAULT_HYSTERESIS_FIELD_MAX_MT),
  fieldMinMt: String(DEFAULT_HYSTERESIS_FIELD_MIN_MT),
  fieldStepMt: String(DEFAULT_HYSTERESIS_FIELD_STEP_MT),
  fieldSteps: "21",
  kind: "hysteresis",
  maxSteps: "",
  relaxAlpha: "",
  solver: "",
  startField: "0, 0, -0.1",
  stopField: "0, 0, 0.1",
  protocolKind: DEFAULT_HYSTERESIS_BRANCH_MODE,
  initialStatePolicy: DEFAULT_HYSTERESIS_INITIAL_PROTOCOL,
  initialStateRef: "",
  orientationMode: "preset",
  thetaDeg: "0",
  phiDeg: "0",
  customDirection: DEFAULT_HYSTERESIS_ORIENTATION_PRESET,
  measurementAxis: DEFAULT_HYSTERESIS_MEASUREMENT_AXIS,
  measurementAxisCustomVector: "",
  fieldScheduleMode: "simple",
  fieldSegments: "[]",
  denseWindows: "[]",
  saturationMode: "none",
  maxProbeField: "300.0",
  saturationThresholds: "1e-3, 1e-2",
  settlePipelineMode: "sequence",
  settleSteps: JSON.stringify([DEFAULT_HYSTERESIS_SETTLE_STEP]),
  settleBranches: "[]",
  minorLoops: "[]",
  storagePolicy: JSON.stringify(DEFAULT_HYSTERESIS_STORAGE),
  storageEstimateAcknowledged: false,
};

export function createStudyStageDraft(
  stage: unknown,
  index: number,
): StudyStageDraft {
  const record = asRecord(stage);
  const kind = stageKind(record);
  if (kind === "run") {
    return {
      ...DEFAULT_RUN_STAGE_DRAFT,
      stageId: stringValue(record?.stage_id ?? record?.id, `stage-${index + 1}`),
      untilSeconds: scalarText(
        record?.until_seconds ??
          record?.until ??
          record?.max_physical_time_s,
        DEFAULT_RUN_STAGE_DRAFT.untilSeconds,
      ),
    };
  }
  if (kind === "eigenmodes") {
    return spectralDraft(DEFAULT_EIGENMODES_STAGE_DRAFT, record, index);
  }
  if (kind === "frequency_response") {
    return {
      ...spectralDraft(DEFAULT_FREQUENCY_RESPONSE_STAGE_DRAFT, record, index),
      excitationField: vectorText(
        record?.excitation_field_au_per_m ?? record?.frequency_excitation_field_au_per_m,
        "0, 0, 1",
      ),
      excitationPhaseRad: scalarText(
        record?.excitation_phase_rad ?? record?.frequency_excitation_phase_rad,
        "0",
      ),
      frequenciesHz: listText(
        record?.frequencies_hz ?? record?.frequency_values_hz,
        DEFAULT_FREQUENCY_RESPONSE_STAGE_DRAFT.frequenciesHz,
      ),
      observable: scalarText(
        record?.observable ?? record?.frequency_observable,
        DEFAULT_FREQUENCY_RESPONSE_STAGE_DRAFT.observable,
      ),
    };
  }
  if (kind === "change_device") {
    return {
      ...DEFAULT_CHANGE_DEVICE_STAGE_DRAFT,
      deviceTarget: scalarText(
        record?.device,
        DEFAULT_CHANGE_DEVICE_STAGE_DRAFT.deviceTarget,
      ),
      stageId: stringValue(record?.stage_id ?? record?.id, `stage-${index + 1}`),
    };
  }
  if (kind === "save_state") {
    return {
      ...DEFAULT_SAVE_STATE_STAGE_DRAFT,
      artifactName: scalarText(
        record?.artifact_name,
        DEFAULT_SAVE_STATE_STAGE_DRAFT.artifactName,
      ),
      dataset: scalarText(record?.dataset, ""),
      format: scalarText(record?.format, ""),
      stageId: stringValue(record?.stage_id ?? record?.id, `stage-${index + 1}`),
    };
  }
  if (kind === "hysteresis") {
    const orientation = asRecord(record?.orientation);
    let orientationMode = "global";
    let thetaDeg = "0";
    let phiDeg = "0";
    let customDirection = "0, 0, 1";
    if (orientation) {
      if (orientation.kind === "preset") {
        orientationMode = "preset";
        customDirection = scalarText(orientation.preset_name, "");
      } else if (orientation.kind === "sample") {
        orientationMode = "sample";
        thetaDeg = scalarText(orientation.theta, "0");
        phiDeg = scalarText(orientation.phi, "0");
      } else if (orientation.kind === "global") {
        orientationMode = "global";
        customDirection = Array.isArray(orientation.vector) ? orientation.vector.join(", ") : "";
      }
    } else if (record?.direction) {
      customDirection = Array.isArray(record.direction) ? record.direction.join(", ") : String(record.direction);
    }
    const measurementAxisDraft = measurementAxisDraftFields(
      record?.measurement_axis,
      "field_axis",
    );

    const saturation = asRecord(record?.saturation);
    let saturationMode = "none";
    let maxProbeField = "300.0";
    let saturationThresholds = "1e-3, 1e-2";
    if (saturation) {
      saturationMode = scalarText(saturation.mode, "auto");
      maxProbeField = String(saturation.max_field_mT ?? 300.0);
      saturationThresholds = `${saturation.susceptibility_threshold ?? 1e-3}, ${saturation.transverse_threshold ?? 1e-2}`;
    }

    const settlePipeline = asRecord(record?.settle_pipeline);
    let settlePipelineMode = "sequence";
    let settleSteps = "[]";
    let settleBranches = "[]";
    if (settlePipeline) {
      settlePipelineMode = scalarText(settlePipeline.kind, "sequence");
      if (settlePipeline.steps) {
        settleSteps = JSON.stringify(settlePipeline.steps);
      } else if (settlePipeline.default) {
        settleSteps = JSON.stringify([settlePipeline.default]);
      }
      if (settlePipeline.branches) {
        settleBranches = JSON.stringify(settlePipeline.branches);
      }
    }

    const fieldSchedule = asRecord(record?.field_schedule);
    let fieldScheduleMode = "simple";
    let fieldSegments = "[]";
    if (fieldSchedule && Array.isArray(fieldSchedule.segments)) {
      fieldScheduleMode = "piecewise";
      fieldSegments = JSON.stringify(fieldSchedule.segments);
    }

    const legacyStartField = record?.start_field ?? record?.hysteresis_start_field;
    const legacyStopField = record?.stop_field ?? record?.hysteresis_stop_field;
    const legacyFieldSteps = record?.field_steps ?? record?.steps ?? record?.hysteresis_steps;
    const legacyFieldRange = legacyVectorSweepToMilliteslaRange(
      legacyStartField,
      legacyStopField,
      legacyFieldSteps,
    );

    return {
      ...DEFAULT_HYSTERESIS_STAGE_DRAFT,
      fieldMaxMt: scalarText(
        record?.field_max_mT,
        legacyFieldRange.max ?? DEFAULT_HYSTERESIS_STAGE_DRAFT.fieldMaxMt,
      ),
      fieldMinMt: scalarText(
        record?.field_min_mT,
        legacyFieldRange.min ?? DEFAULT_HYSTERESIS_STAGE_DRAFT.fieldMinMt,
      ),
      fieldStepMt: scalarText(
        record?.field_step_mT,
        legacyFieldRange.step ?? DEFAULT_HYSTERESIS_STAGE_DRAFT.fieldStepMt,
      ),
      fieldSteps: scalarText(
        legacyFieldSteps,
        DEFAULT_HYSTERESIS_STAGE_DRAFT.fieldSteps,
      ),
      stageId: stringValue(record?.stage_id ?? record?.id, `stage-${index + 1}`),
      startField: vectorText(
        legacyStartField,
        DEFAULT_HYSTERESIS_STAGE_DRAFT.startField,
      ),
      stopField: vectorText(
        legacyStopField,
        DEFAULT_HYSTERESIS_STAGE_DRAFT.stopField,
      ),
      torqueTolerance: scalarText(
        record?.torque_tolerance ??
          record?.hysteresis_torque_tolerance ??
          record?.torque_tolerance_apm,
        DEFAULT_HYSTERESIS_STAGE_DRAFT.torqueTolerance,
      ),
      protocolKind: scalarText(
        record?.branch_mode ?? record?.protocol_kind,
        "major_loop",
      ),
      initialStatePolicy: scalarText(
        record?.initial_protocol ?? record?.initial_state_policy,
        "positive_saturation",
      ),
      initialStateRef: scalarText(
        record?.initial_state_ref ?? record?.initialStateRef,
        "",
      ),
      orientationMode,
      thetaDeg,
      phiDeg,
      customDirection,
      ...measurementAxisDraft,
      fieldScheduleMode,
      fieldSegments,
      denseWindows: objectText(
        record?.schedule_refinements ?? record?.dense_windows,
      ),
      saturationMode,
      maxProbeField,
      saturationThresholds,
      settlePipelineMode,
      settleSteps,
      settleBranches,
      minorLoops: objectText(record?.minor_loops),
      storagePolicy: record?.storage
        ? JSON.stringify(record.storage)
        : DEFAULT_HYSTERESIS_STAGE_DRAFT.storagePolicy,
      storageEstimateAcknowledged:
        DEFAULT_HYSTERESIS_STAGE_DRAFT.storageEstimateAcknowledged,
    };
  }

  return {
    ...DEFAULT_RELAX_STAGE_DRAFT,
    algorithm: scalarText(
      record?.algorithm ?? record?.relax_algorithm,
      DEFAULT_RELAX_STAGE_DRAFT.algorithm,
    ),
    dt: scalarText(record?.dt, DEFAULT_RELAX_STAGE_DRAFT.dt),
    dtMin: scalarText(record?.dt_min, ""),
    energyTolerance: scalarText(record?.energy_tolerance, ""),
    fieldEvery: scalarText(
      asRecord(record?.field_refresh)?.every_n ??
        record?.field_every_n,
      "",
    ),
    kind: "relax",
    maxError: scalarText(record?.max_error, ""),
    maxPhysicalTime: scalarText(record?.max_physical_time_s, ""),
    maxPseudotime: scalarText(record?.max_pseudotime_s, ""),
    maxSteps: scalarText(record?.max_steps, DEFAULT_RELAX_STAGE_DRAFT.maxSteps),
    relaxAlpha: scalarText(record?.relax_alpha, DEFAULT_RELAX_STAGE_DRAFT.relaxAlpha),
    solver: scalarText(record?.solver, DEFAULT_RELAX_STAGE_DRAFT.solver),
    stageId: stringValue(record?.stage_id ?? record?.id, `stage-${index + 1}`),
    torqueTolerance: scalarText(
      record?.torque_tolerance ??
        record?.torque_tolerance_apm ??
        record?.tol,
      DEFAULT_RELAX_STAGE_DRAFT.torqueTolerance,
    ),
    untilSeconds: scalarText(
      record?.until_seconds ??
        record?.max_physical_time_s ??
        record?.max_pseudotime_s,
      "",
    ),
  };
}

export function createDefaultStudyStageDraft(
  kind: StudyStageDraftKind,
  stageCount: number,
): StudyStageDraft {
  const base =
    kind === "run"
      ? DEFAULT_RUN_STAGE_DRAFT
      : kind === "eigenmodes"
        ? DEFAULT_EIGENMODES_STAGE_DRAFT
        : kind === "frequency_response"
          ? DEFAULT_FREQUENCY_RESPONSE_STAGE_DRAFT
          : kind === "hysteresis"
            ? DEFAULT_HYSTERESIS_STAGE_DRAFT
            : kind === "save_state"
              ? DEFAULT_SAVE_STATE_STAGE_DRAFT
              : kind === "change_device"
                ? DEFAULT_CHANGE_DEVICE_STAGE_DRAFT
                : DEFAULT_RELAX_STAGE_DRAFT;
  return {
    ...base,
    kind,
    stageId: `${kind}-${stageCount + 1}`,
  };
}

export function studyStageDraftToSceneStage(
  draft: StudyStageDraft,
): JsonObject {
  if (draft.kind === "run") {
    return {
      entrypoint_kind: "flat_run",
      kind: "run",
      stage_id: requiredText(draft.stageId, "run"),
      until_seconds: requiredNumber(draft.untilSeconds, "until_seconds"),
    };
  }
  if (draft.kind === "eigenmodes") {
    const stage = spectralSceneStage(draft, "eigenmodes");
    stage.count = requiredInteger(draft.count, "count");
    stage.eigen_count = stage.count;
    stage.target = requiredText(draft.target, "lowest");
    stage.eigen_target = stage.target;
    setOptionalNumber(stage, "target_frequency", draft.targetFrequency);
    setOptionalNumber(stage, "eigen_target_frequency", draft.targetFrequency);
    setOptionalNumber(stage, "frequency_min", draft.frequencyMin);
    setOptionalNumber(stage, "frequency_max", draft.frequencyMax);
    setOptionalNumber(stage, "eigen_frequency_min", draft.frequencyMin);
    setOptionalNumber(stage, "eigen_frequency_max", draft.frequencyMax);
    return stage;
  }
  if (draft.kind === "frequency_response") {
    const stage = spectralSceneStage(draft, "frequency_response");
    stage.frequencies_hz = requiredNumberList(draft.frequenciesHz, "frequencies_hz");
    stage.frequency_values_hz = stage.frequencies_hz;
    stage.excitation_field_au_per_m = requiredVector3(
      draft.excitationField,
      "excitation_field_au_per_m",
    );
    stage.frequency_excitation_field_au_per_m =
      stage.excitation_field_au_per_m;
    stage.excitation_phase_rad = requiredSignedNumber(
      draft.excitationPhaseRad,
      "excitation_phase_rad",
    );
    stage.frequency_excitation_phase_rad = stage.excitation_phase_rad;
    stage.observable = requiredText(draft.observable, "susceptibility_tensor");
    stage.frequency_observable = stage.observable;
    return stage;
  }
  if (draft.kind === "save_state") {
    const stage: JsonObject = {
      artifact_name: requiredText(draft.artifactName, "state_snapshot"),
      entrypoint_kind: "flat_save_state",
      kind: "save_state",
      stage_id: requiredText(draft.stageId, "save-state"),
    };
    setOptionalText(stage, "format", draft.format);
    setOptionalText(stage, "dataset", draft.dataset);
    return stage;
  }
  if (draft.kind === "change_device") {
    return {
      device: requiredDeviceTarget(draft.deviceTarget),
      entrypoint_kind: "flat_change_device",
      kind: "change_device",
      stage_id: requiredText(draft.stageId, "change-device"),
    };
  }
  if (draft.kind === "hysteresis") {
    const torqueTolerance = requiredNumber(
      draft.torqueTolerance,
      "torque_tolerance",
    );

    // Build orientation object
    let orientation: JsonObject | null = null;
    if (draft.orientationMode === "preset") {
      orientation = {
        kind: "preset",
        preset_name: requiredHysteresisOrientationPreset(draft.customDirection),
      };
    } else if (draft.orientationMode === "sample") {
      orientation = {
        kind: "sample",
        theta: requiredSignedNumber(draft.thetaDeg, "theta"),
        phi: requiredSignedNumber(draft.phiDeg, "phi"),
      };
    } else if (draft.orientationMode === "global") {
      orientation = {
        kind: "global",
        vector: requiredNonZeroVector3(draft.customDirection, "custom_direction"),
      };
    }

    // Build saturation object
    let saturation: JsonObject | null = null;
    if (draft.saturationMode && draft.saturationMode !== "none") {
      const thresholds = finiteNumberList(draft.saturationThresholds);
      saturation = {
        mode: draft.saturationMode,
        max_field_mT: requiredNumber(draft.maxProbeField, "max_probe_field"),
        susceptibility_threshold: thresholds[0] ?? 1e-3,
        transverse_threshold: thresholds[1] ?? 1e-2,
      };
    }

    // Build settle pipeline
    let settle_pipeline: JsonObject | null = null;
    if (draft.settleSteps.trim() && draft.settleSteps.trim() !== "[]") {
      const steps = parseJsonArrayValue(draft.settleSteps.trim());
      if (draft.settlePipelineMode === "sequence") {
        settle_pipeline = {
          kind: "sequence",
          steps,
        };
      } else if (draft.settlePipelineMode === "tree") {
        const branches = draft.settleBranches.trim() && draft.settleBranches.trim() !== "[]"
          ? parseJsonArrayValue(draft.settleBranches.trim())
          : [];
        const alwaysBranches = steps.slice(1).map((step) => ({
          when: "always",
          run: step,
        }));
        settle_pipeline = {
          kind: "tree",
          default: steps[0] || {
            kind: "relax",
            method: "llg_overdamped",
            alpha: 1.0,
            torque_tolerance: 1e-5,
            max_steps: 10000,
            on_non_convergence: "continue_with_warning",
          },
          branches: [...alwaysBranches, ...branches],
        };
      }
    }

    // Build field schedule or default simple min/max
    let field_schedule: JsonObject | null = null;
    if (draft.fieldScheduleMode === "piecewise" && draft.fieldSegments.trim() && draft.fieldSegments.trim() !== "[]") {
      field_schedule = {
        segments: parseJsonArrayValue(draft.fieldSegments.trim()).map(
          normalizeHysteresisFieldSegment,
        ),
      };
    }

    // Parse other JSON fields
    const schedule_refinements = draft.denseWindows.trim() && draft.denseWindows.trim() !== "[]"
      ? parseJsonArrayValue(draft.denseWindows.trim()).map(
        normalizeHysteresisDenseWindow,
      )
      : null;
    const minor_loops = draft.minorLoops.trim() && draft.minorLoops.trim() !== "[]"
      ? parseJsonArrayValue(draft.minorLoops.trim()).map(
        normalizeHysteresisMinorLoop,
      )
      : null;
    const storage = draft.storagePolicy.trim()
      ? parseJsonObjectValue(draft.storagePolicy.trim())
      : null;

    const result: JsonObject = {
      entrypoint_kind: "flat_hysteresis",
      field_max_mT: requiredNumber(draft.fieldMaxMt, "field_max_mT"),
      field_min_mT: requiredSignedNumber(draft.fieldMinMt, "field_min_mT"),
      field_step_mT: requiredNumber(draft.fieldStepMt, "field_step_mT"),
      kind: "hysteresis",
      stage_id: requiredText(draft.stageId, "hysteresis"),
      measurement_axis: parseMeasurementAxisDraft(draft),
      branch_mode: draft.protocolKind || "major_loop",
      initial_protocol: draft.initialStatePolicy || "positive_saturation",
    };

    if (draft.initialStateRef.trim()) {
      result.initial_state_ref = draft.initialStateRef.trim();
    }
    if (orientation) result.orientation = orientation;
    if (saturation) result.saturation = saturation;
    if (settle_pipeline) result.settle_pipeline = settle_pipeline;
    if (field_schedule) result.field_schedule = field_schedule;
    if (schedule_refinements) result.schedule_refinements = schedule_refinements;
    if (minor_loops) result.minor_loops = minor_loops;
    if (storage) result.storage = storage;

    result.hysteresis_torque_tolerance = torqueTolerance;
    result.torque_tolerance = torqueTolerance;

    return result;
  }

  const stage: JsonObject = {
    algorithm: requiredText(draft.algorithm, "llg_overdamped"),
    entrypoint_kind: "flat_relax",
    kind: "relax",
    max_steps: requiredInteger(draft.maxSteps, "max_steps"),
    relax_algorithm: requiredText(draft.algorithm, "llg_overdamped"),
    stage_id: requiredText(draft.stageId, "relax"),
    torque_tolerance: requiredNumber(draft.torqueTolerance, "torque_tolerance"),
  };

  setOptionalNumber(stage, "energy_tolerance", draft.energyTolerance);
  setOptionalNumber(stage, "max_physical_time_s", draft.maxPhysicalTime);
  setOptionalNumber(stage, "max_pseudotime_s", draft.maxPseudotime);
  setOptionalNumber(stage, "max_error", draft.maxError);
  setOptionalNumber(stage, "dt_min", draft.dtMin);
  setOptionalNumber(stage, "relax_alpha", draft.relaxAlpha);
  setOptionalText(stage, "solver", draft.solver);
  setOptionalText(stage, "integrator", draft.solver);
  if (draft.dt.trim() === "auto" || draft.dt.trim().length === 0) {
    stage.dt = "auto";
    stage.fixed_timestep = "";
  } else {
    stage.dt = requiredNumber(draft.dt, "dt");
    stage.fixed_timestep = stage.dt;
  }
  const fieldEvery = optionalInteger(draft.fieldEvery);
  if (fieldEvery !== null) {
    stage.field_refresh = { every_n: fieldEvery };
  }

  return stage;
}

export function validateStudyStageDraft(
  draft: StudyStageDraft,
): StudyStageDraftValidation[] {
  const issues: StudyStageDraftValidation[] = [];
  if (!draft.stageId.trim()) {
    issues.push({ message: "Stage ID is required.", severity: "error" });
  }
  if (draft.kind === "run") {
    validatePositiveNumber(issues, draft.untilSeconds, "Until seconds", true);
    return issues;
  }
  if (draft.kind === "eigenmodes") {
    validateSpectralOptions(issues, draft, SUPPORTED_EIGEN_CALCULATION_MODES);
    validatePositiveInteger(issues, draft.count, "Mode count", true);
    validatePositiveNumber(
      issues,
      draft.targetFrequency,
      "Target frequency",
      draft.target === "nearest",
    );
    validatePositiveNumber(
      issues,
      draft.frequencyMin,
      "Frequency min",
      draft.target === "frequency_window",
    );
    validatePositiveNumber(
      issues,
      draft.frequencyMax,
      "Frequency max",
      draft.target === "frequency_window",
    );
    if (draft.target === "frequency_window") {
      const min = Number(draft.frequencyMin);
      const max = Number(draft.frequencyMax);
      if (Number.isFinite(min) && Number.isFinite(max) && min >= max) {
        issues.push({
          message: "Frequency min must be less than frequency max.",
          severity: "error",
        });
      }
    }
    validateOptionalVector3(issues, draft.kVector, "k vector");
    validateOptionalJson(issues, draft.kSampling, "k sampling");
    validateJsonOrString(issues, draft.bc, "BC");
    return issues;
  }
  if (draft.kind === "frequency_response") {
    validateSpectralOptions(issues, draft, SUPPORTED_RESPONSE_CALCULATION_MODES);
    validatePositiveNumberList(issues, draft.frequenciesHz, "Frequencies");
    validateRequiredVector3(issues, draft.excitationField, "Excitation field");
    validateFiniteNumber(issues, draft.excitationPhaseRad, "Excitation phase", true);
    validateOptionalVector3(issues, draft.kVector, "k vector");
    validateOptionalJson(issues, draft.kSampling, "k sampling");
    validateJsonOrString(issues, draft.bc, "BC");
    return issues;
  }
  if (draft.kind === "save_state") {
    if (!draft.artifactName.trim()) {
      issues.push({ message: "Artifact name is required.", severity: "error" });
    }
    return issues;
  }
  if (draft.kind === "change_device") {
    validateDeviceTarget(issues, draft.deviceTarget);
    return issues;
  }
  if (draft.kind === "hysteresis") {
    validatePositiveNumber(issues, draft.torqueTolerance, "Torque tolerance", true);
    validateSignedNumber(issues, draft.fieldMinMt, "Minimum field", true);
    validateSignedNumber(issues, draft.fieldMaxMt, "Maximum field", true);
    validatePositiveNumber(issues, draft.fieldStepMt, "Field step", true);
    validateSimpleHysteresisFieldSchedule(issues, draft);
    validateHysteresisInitialState(issues, draft);
    validateHysteresisOrientation(issues, draft);
    validateHysteresisMeasurementAxis(issues, draft);
    if (draft.saturationMode && draft.saturationMode !== "none") {
      validatePositiveNumber(issues, draft.maxProbeField, "Max probe field", true);
      validateHysteresisSaturationProbe(issues, draft);
    }
    if (draft.settleSteps.trim() && draft.settleSteps.trim() !== "[]") {
      validateJsonArray(issues, draft.settleSteps, "Settle steps", validateSettleStep);
      validateSettlePipelineSemantics(issues, draft);
      validateSettleAppliesToSemantics(issues, draft);
    } else {
      issues.push({
        message: "Settle pipeline requires at least one step.",
        severity: "error",
      });
    }
    if (draft.settleBranches.trim() && draft.settleBranches.trim() !== "[]") {
      validateJsonArray(issues, draft.settleBranches, "Settle branches", validateSettleBranch);
    }
    if (draft.fieldSegments.trim() && draft.fieldSegments.trim() !== "[]") {
      validateJsonArray(issues, draft.fieldSegments, "Field segments", validateFieldSegment);
      validateFieldSegmentSchedule(issues, draft.fieldSegments);
    }
    if (draft.denseWindows.trim() && draft.denseWindows.trim() !== "[]") {
      validateJsonArray(issues, draft.denseWindows, "Dense windows", validateDenseWindow);
      validateDenseWindowOverlaps(issues, draft.denseWindows);
    }
    if (draft.minorLoops.trim() && draft.minorLoops.trim() !== "[]") {
      validateJsonArray(issues, draft.minorLoops, "Minor loops", validateMinorLoop);
      validateMinorLoopEnvelope(issues, draft);
    }
    if (draft.storagePolicy.trim()) {
      validateJsonObject(issues, draft.storagePolicy, "Storage policy");
      validateHysteresisStoragePolicy(issues, draft.storagePolicy);
      validateHysteresisStorageAcknowledgement(issues, draft);
    }

    return issues;
  }

  validatePositiveNumber(issues, draft.torqueTolerance, "Torque tolerance", true);
  validatePositiveInteger(issues, draft.maxSteps, "Max steps", true);
  validatePositiveNumber(issues, draft.energyTolerance, "Energy tolerance", false);
  validatePositiveNumber(issues, draft.maxPhysicalTime, "Max physical time", false);
  validatePositiveNumber(issues, draft.maxPseudotime, "Max pseudotime", false);
  validatePositiveNumber(issues, draft.relaxAlpha, "Relax alpha", false);
  validatePositiveNumber(issues, draft.maxError, "Max error", false);
  validatePositiveNumber(issues, draft.dtMin, "dt_min", false);
  validatePositiveInteger(issues, draft.fieldEvery, "Field refresh", false);
  if (draft.dt.trim() && draft.dt.trim() !== "auto") {
    validatePositiveNumber(issues, draft.dt, "dt", true);
  }
  if (draft.algorithm !== "llg_overdamped") {
    const hasLlgOnly =
      draft.solver.trim() ||
      draft.dt.trim() ||
      draft.dtMin.trim() ||
      draft.maxError.trim();
    if (hasLlgOnly) {
      issues.push({
        message:
          "solver, dt, dt_min, and max_error apply only to llg_overdamped.",
        severity: "warning",
      });
    }
  }
  return issues;
}

function validateSpectralOptions(
  issues: StudyStageDraftValidation[],
  draft: StudyStageDraft,
  calculationModes: readonly string[],
): void {
  validateSupportedText(
    issues,
    draft.calculationMode,
    calculationModes,
    "Calculation mode",
  );
  validateSupportedText(
    issues,
    draft.normalization,
    SUPPORTED_SPECTRAL_NORMALIZATIONS,
    "Normalization",
  );
  validateSupportedText(
    issues,
    draft.dampingPolicy,
    SUPPORTED_SPECTRAL_DAMPING_POLICIES,
    "Damping policy",
  );
  validateSupportedText(
    issues,
    draft.equilibriumSource,
    SUPPORTED_SPECTRAL_EQUILIBRIUM_SOURCES,
    "Equilibrium source",
  );
}

function validateSupportedText(
  issues: StudyStageDraftValidation[],
  value: string,
  supported: readonly string[],
  label: string,
): void {
  if (supported.includes(value)) return;
  issues.push({
    message: `${label} must be ${joinOptions(supported)}.`,
    severity: "error",
  });
}

function joinOptions(options: readonly string[]): string {
  if (options.length <= 1) return options[0] ?? "";
  if (options.length === 2) return `${options[0]} or ${options[1]}`;
  return `${options.slice(0, -1).join(", ")}, or ${
    options[options.length - 1]
  }`;
}

export function buildStudyStagesMergePatch(
  stages: readonly StudyStageDraft[],
): AuthoringTransactionRequest {
  return {
    kind: "merge_patch",
    merge_patch: {
      study: {
        stages: stages.map(studyStageDraftToSceneStage),
      },
    },
  };
}

function validatePositiveNumber(
  issues: StudyStageDraftValidation[],
  value: string,
  label: string,
  required: boolean,
): void {
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) {
      issues.push({ message: `${label} is required.`, severity: "error" });
    }
    return;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    issues.push({
      message: `${label} must be a positive finite number.`,
      severity: "error",
    });
  }
}

function validateSignedNumber(
  issues: StudyStageDraftValidation[],
  value: string,
  label: string,
  required: boolean,
): void {
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) {
      issues.push({ message: `${label} is required.`, severity: "error" });
    }
    return;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    issues.push({
      message: `${label} must be a finite number.`,
      severity: "error",
    });
  }
}

function validateFiniteNumber(
  issues: StudyStageDraftValidation[],
  value: string,
  label: string,
  required: boolean,
): void {
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) {
      issues.push({ message: `${label} is required.`, severity: "error" });
    }
    return;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    issues.push({
      message: `${label} must be a finite number.`,
      severity: "error",
    });
  }
}

function validateDeviceTarget(
  issues: StudyStageDraftValidation[],
  value: string,
): void {
  if (!isSupportedDeviceTarget(value.trim().toLowerCase())) {
    issues.push({
      message: "Device must be cpu, gpu, cuda, cuda:<index>, or auto.",
      severity: "error",
    });
  }
}

function isSupportedDeviceTarget(value: string): boolean {
  if (value === "cpu" || value === "gpu" || value === "cuda" || value === "auto") {
    return true;
  }
  const index = value.startsWith("cuda:") ? value.slice("cuda:".length) : "";
  return index.length > 0 && /^[0-9]+$/.test(index);
}

function validateJsonArray(
  issues: StudyStageDraftValidation[],
  value: string,
  label: string,
  validateItem?: (
    issues: StudyStageDraftValidation[],
    item: unknown,
    index: number,
  ) => void,
): void {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      issues.push({ message: `${label} must be a valid JSON array.`, severity: "error" });
      return;
    }
    parsed.forEach((item, index) => validateItem?.(issues, item, index));
  } catch {
    issues.push({ message: `${label} must be a valid JSON array.`, severity: "error" });
  }
}

function validateJsonObject(
  issues: StudyStageDraftValidation[],
  value: string,
  label: string,
): void {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      issues.push({
        message: `${label} must be a valid JSON object.`,
        severity: "error",
      });
    }
  } catch {
    issues.push({
      message: `${label} must be a valid JSON object.`,
      severity: "error",
    });
  }
}

function validateHysteresisStorageAcknowledgement(
  issues: StudyStageDraftValidation[],
  draft: StudyStageDraft,
): void {
  const storage = parseJsonObjectForValidation(draft.storagePolicy);
  const magnetization =
    typeof storage?.magnetization === "string" ? storage.magnetization : null;
  if (
    magnetization === "every_step" &&
    !draft.storageEstimateAcknowledged
  ) {
    issues.push({
      message: "Every-step magnetization storage requires storage estimate acknowledgement.",
      severity: "error",
    });
  }
}

function validateHysteresisStoragePolicy(
  issues: StudyStageDraftValidation[],
  value: string,
): void {
  const storage = parseJsonObjectForValidation(value);
  if (!storage) return;

  const magnetization = stringObjectValue(storage.magnetization).trim();
  if (!magnetization) {
    issues.push({
      message: "Storage policy magnetization is required.",
      severity: "error",
    });
  } else if (!SUPPORTED_HYSTERESIS_STORAGE_MAGNETIZATION.has(magnetization)) {
    issues.push({
      message: "Storage policy magnetization must be none, selected, every_n, every_step, or key_events.",
      severity: "error",
    });
  }

  const everyN = finiteObjectNumber(storage.every_n ?? storage.everyN);
  if (everyN !== null && (!Number.isInteger(everyN) || everyN < 0)) {
    issues.push({
      message: "Storage policy every_n must be a non-negative integer.",
      severity: "error",
    });
  }
  if (
    (magnetization === "selected" || magnetization === "every_n") &&
    (everyN === null || everyN <= 0)
  ) {
    issues.push({
      message: "Storage policy every_n must be positive when magnetization is selected or every_n.",
      severity: "error",
    });
  }

  const threshold = finiteObjectNumber(
    storage.key_event_threshold_dm ?? storage.keyEventThresholdDm,
  );
  if (threshold !== null && threshold <= 0) {
    issues.push({
      message: "Storage policy key_event_threshold_dm must be a positive finite number.",
      severity: "error",
    });
  }
}

function validateHysteresisSaturationProbe(
  issues: StudyStageDraftValidation[],
  draft: StudyStageDraft,
): void {
  if (!draft.saturationMode.trim()) {
    issues.push({
      message: "Saturation mode is required.",
      severity: "error",
    });
  }
  const thresholds = strictFiniteNumberList(draft.saturationThresholds);
  if (thresholds === null || thresholds.length !== 2) {
    issues.push({
      message: "Saturation thresholds must contain susceptibility and transverse thresholds.",
      severity: "error",
    });
    return;
  }
  const [susceptibility, transverse] = thresholds;
  if (susceptibility === undefined || susceptibility <= 0) {
    issues.push({
      message: "Saturation susceptibility threshold must be a positive finite number.",
      severity: "error",
    });
  }
  if (transverse === undefined || transverse <= 0) {
    issues.push({
      message: "Saturation transverse threshold must be a positive finite number.",
      severity: "error",
    });
  }
}

function validateHysteresisOrientation(
  issues: StudyStageDraftValidation[],
  draft: StudyStageDraft,
): void {
  if (draft.orientationMode === "preset") {
    const preset = draft.customDirection.trim();
    if (!preset) {
      issues.push({
        message: "Orientation preset is required.",
        severity: "error",
      });
      return;
    }
    if (!SUPPORTED_HYSTERESIS_ORIENTATION_PRESETS.has(preset)) {
      issues.push({
        message: `Orientation preset must be ${supportedSetMessage(SUPPORTED_HYSTERESIS_ORIENTATION_PRESETS)}.`,
        severity: "error",
      });
    }
    return;
  }
  if (draft.orientationMode === "sample") {
    validateFiniteNumber(issues, draft.thetaDeg, "Theta", true);
    validateFiniteNumber(issues, draft.phiDeg, "Phi", true);
    return;
  }
  if (draft.orientationMode === "global") {
    validateRequiredVector3(issues, draft.customDirection, "Orientation vector");
    const vector = optionalVector3(draft.customDirection);
    if (vector && isZeroVector3(vector)) {
      issues.push({
        message: "Orientation vector must not be the zero vector.",
        severity: "error",
      });
    }
    return;
  }
  issues.push({
    message: "Orientation mode is required.",
    severity: "error",
  });
}

function validateHysteresisInitialState(
  issues: StudyStageDraftValidation[],
  draft: StudyStageDraft,
): void {
  if (draft.initialStatePolicy !== "checkpoint") return;
  if (!draft.initialStateRef.trim()) {
    issues.push({
      message: "Initial state ref is required for checkpoint starts.",
      severity: "error",
    });
  }
}

function validateHysteresisMeasurementAxis(
  issues: StudyStageDraftValidation[],
  draft: StudyStageDraft,
): void {
  const axis = draft.measurementAxis.trim();
  if (!axis) {
    issues.push({
      message: "Measurement axis is required.",
      severity: "error",
    });
    return;
  }
  if (!SUPPORTED_HYSTERESIS_MEASUREMENT_AXES.has(axis)) {
    issues.push({
      message: `Measurement axis must be ${supportedSetMessage(SUPPORTED_HYSTERESIS_MEASUREMENT_AXES)}.`,
      severity: "error",
    });
    return;
  }
  if (axis !== "custom") return;

  if (!draft.measurementAxisCustomVector.trim()) {
    issues.push({
      message: "Custom measurement axis vector is required.",
      severity: "error",
    });
    return;
  }
  validateRequiredVector3(
    issues,
    draft.measurementAxisCustomVector,
    "Custom measurement axis vector",
  );
  const vector = optionalVector3(draft.measurementAxisCustomVector);
  if (vector && isZeroVector3(vector)) {
    issues.push({
      message: "Custom measurement axis vector must not be the zero vector.",
      severity: "error",
    });
  }
}

function validateSimpleHysteresisFieldSchedule(
  issues: StudyStageDraftValidation[],
  draft: StudyStageDraft,
): void {
  if (draft.fieldScheduleMode === "piecewise") return;
  const fieldMin = finiteObjectNumber(draft.fieldMinMt);
  const fieldMax = finiteObjectNumber(draft.fieldMaxMt);
  const fieldStep = finiteObjectNumber(draft.fieldStepMt);
  if (fieldMin === null || fieldMax === null || fieldStep === null || fieldStep <= 0) {
    return;
  }
  if (sameFieldValue(fieldMin, fieldMax)) {
    issues.push({
      message: "Minimum field and maximum field must differ.",
      severity: "error",
    });
    return;
  }
  if (fieldMax < fieldMin) {
    issues.push({
      message: "Maximum field must be greater than minimum field.",
      severity: "error",
    });
    return;
  }

  const pointCount = estimateSimpleHysteresisFieldPointCount(
    fieldMin,
    fieldMax,
    fieldStep,
    draft.protocolKind,
  );
  if (pointCount > MAX_HYSTERESIS_AUTHORING_FIELD_POINTS) {
    issues.push({
      message: `Simple field schedule has ${pointCount} points; reduce the range, increase the step, or use explicit piecewise segments.`,
      severity: "error",
    });
  }
}

function estimateSimpleHysteresisFieldPointCount(
  fieldMin: number,
  fieldMax: number,
  fieldStep: number,
  protocolKind: string,
): number {
  const descending = estimateFieldSegmentPointCount(fieldMax, fieldMin, fieldStep);
  const ascending = estimateFieldSegmentPointCount(fieldMin, fieldMax, fieldStep);
  if (protocolKind === "virgin_curve") {
    return estimateFieldSegmentPointCount(0, fieldMax, fieldStep);
  }
  if (protocolKind === "virgin_then_major_loop") {
    return (
      estimateFieldSegmentPointCount(0, fieldMax, fieldStep) +
      Math.max(0, descending - 1) +
      Math.max(0, ascending - 1)
    );
  }
  if (protocolKind === "major_loop" || protocolKind === "major_with_minor_loops") {
    return descending + Math.max(0, ascending - 1);
  }
  return ascending;
}

function estimateFieldSegmentPointCount(
  start: number,
  stop: number,
  step: number,
): number {
  if (sameFieldValue(start, stop)) return 1;
  const span = Math.abs(stop - start);
  return Math.floor(Math.max(0, (span - 1e-9) / step)) + 2;
}

function parseJsonObjectForValidation(value: string): JsonRecord | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonRecord)
      : null;
  } catch {
    return null;
  }
}

function validateSettleStep(
  issues: StudyStageDraftValidation[],
  item: unknown,
  index: number,
): void {
  const step = asRecord(item);
  const label = `Settle step ${index + 1}`;
  if (!step) {
    issues.push({ message: `${label} must be a JSON object.`, severity: "error" });
    return;
  }

  const kind = stringObjectValue(step.kind).trim();
  const method = stringObjectValue(step.method).trim();
  if (!kind) {
    issues.push({ message: `${label} requires kind.`, severity: "error" });
  } else if (!SUPPORTED_SETTLE_STEP_KINDS.has(kind)) {
    issues.push({
      message: `${label} kind must be relax, minimize, or dynamics_settle.`,
      severity: "error",
    });
  }
  if (!method) {
    issues.push({ message: `${label} requires method.`, severity: "error" });
  } else if (!SUPPORTED_SETTLE_METHODS_BY_KIND[kind]?.has(method)) {
    issues.push({
      message: `${label} method is not supported for ${kind || "this kind"}.`,
      severity: "error",
    });
  }

  const maxSteps = finiteObjectNumber(step.max_steps ?? step.maxSteps);
  if (maxSteps === null || !Number.isInteger(maxSteps) || maxSteps <= 0) {
    issues.push({
      message: `${label} max_steps must be a positive integer.`,
      severity: "error",
    });
  }

  if (kind === "relax") {
    validatePositiveObjectNumber(issues, step.alpha, `${label} alpha`);
    validatePositiveObjectNumber(
      issues,
      step.torque_tolerance ?? step.torqueTolerance,
      `${label} torque_tolerance`,
    );
  } else if (kind === "minimize") {
    validatePositiveObjectNumber(
      issues,
      step.torque_tolerance ?? step.torqueTolerance,
      `${label} torque_tolerance`,
    );
    validatePositiveObjectNumber(
      issues,
      step.energy_tolerance ?? step.energyTolerance,
      `${label} energy_tolerance`,
    );
  } else if (kind === "dynamics_settle") {
    validatePositiveObjectNumber(issues, step.damping, `${label} damping`);
  }

  const policy = stringObjectValue(
    step.on_non_convergence ?? step.onNonConvergence,
  ).trim();
  if (!policy) {
    issues.push({
      message: `${label} requires on_non_convergence.`,
      severity: "error",
    });
  } else if (!SUPPORTED_SETTLE_NON_CONVERGENCE_POLICIES.has(policy)) {
    issues.push({
      message: `${label} on_non_convergence must be continue_with_warning, stop_stage, run_next_algorithm, or retry_with_smaller_dt.`,
      severity: "error",
    });
  }
  validateSettleRetryPolicy(issues, step, label, policy);
  validateSettleTimesteps(issues, step, label);
}

function validateSettleBranch(
  issues: StudyStageDraftValidation[],
  item: unknown,
  index: number,
): void {
  const branch = asRecord(item);
  const label = `Settle branch ${index + 1}`;
  if (!branch) {
    issues.push({ message: `${label} must be a JSON object.`, severity: "error" });
    return;
  }
  if (!stringObjectValue(branch.when).trim()) {
    issues.push({ message: `${label} requires when.`, severity: "error" });
  }
  validateSettleStep(issues, branch.run, index);
}

function validateSettlePipelineSemantics(
  issues: StudyStageDraftValidation[],
  draft: StudyStageDraft,
): void {
  const steps = parseSettleStepDrafts(draft.settleSteps);
  if (steps.length === 0) return;
  if (draft.settlePipelineMode === "sequence") {
    steps.forEach((step, index) => {
      if (
        step.onNonConvergence === "run_next_algorithm" &&
        index === steps.length - 1
      ) {
        issues.push({
          message: `Settle step ${index + 1} run_next_algorithm requires a following step.`,
          severity: "error",
        });
      }
    });
    return;
  }

  const defaultStep = steps[0];
  if (
    defaultStep?.onNonConvergence === "run_next_algorithm" &&
    !settleBranchesContainFallback(draft.settleBranches)
  ) {
    issues.push({
      message: "Settle tree run_next_algorithm requires a non_converged fallback branch.",
      severity: "error",
    });
  }
}

function validateSettleAppliesToSemantics(
  issues: StudyStageDraftValidation[],
  draft: StudyStageDraft,
): void {
  const availableRoles = availableHysteresisAppliesToRoles(draft);
  const availableBranchIds = availableHysteresisBranchIds(draft);
  validateStepAppliesToList(
    issues,
    parseSettleStepRecords(draft.settleSteps),
    "Settle step",
    availableRoles,
    availableBranchIds,
  );
  validateBranchAppliesToList(
    issues,
    draft.settleBranches,
    availableRoles,
    availableBranchIds,
  );
}

function validateStepAppliesToList(
  issues: StudyStageDraftValidation[],
  steps: JsonRecord[],
  labelPrefix: string,
  availableRoles: Set<string>,
  availableBranchIds: Set<string>,
): void {
  steps.forEach((step, index) => {
    validateAppliesToValue(
      issues,
      step.applies_to ?? step.appliesTo,
      `${labelPrefix} ${index + 1}`,
      availableRoles,
      availableBranchIds,
    );
  });
}

function validateBranchAppliesToList(
  issues: StudyStageDraftValidation[],
  value: string,
  availableRoles: Set<string>,
  availableBranchIds: Set<string>,
): void {
  try {
    const parsed = JSON.parse(value || "[]") as unknown;
    if (!Array.isArray(parsed)) return;
    parsed.forEach((item, index) => {
      const branch = asRecord(item);
      const run = asRecord(branch?.run);
      if (!run) return;
      validateAppliesToValue(
        issues,
        run.applies_to ?? run.appliesTo,
        `Settle branch ${index + 1} run`,
        availableRoles,
        availableBranchIds,
      );
    });
  } catch {
    // validateJsonArray owns malformed JSON errors.
  }
}

function validateAppliesToValue(
  issues: StudyStageDraftValidation[],
  value: unknown,
  label: string,
  availableRoles: Set<string>,
  availableBranchIds: Set<string>,
): void {
  if (value === null || value === undefined || value === "") return;
  if (Array.isArray(value)) {
    if (value.length === 0) {
      issues.push({
        message: `${label} applies_to must not be empty.`,
        severity: "error",
      });
      return;
    }
    value.forEach((item) =>
      validateAppliesToValue(issues, item, label, availableRoles, availableBranchIds),
    );
    return;
  }
  if (typeof value === "string") {
    validateAppliesToRole(issues, value, label, availableRoles);
    return;
  }
  const selector = asRecord(value);
  if (!selector) {
    issues.push({
      message: `${label} applies_to must be a role, selector object, or array.`,
      severity: "error",
    });
    return;
  }
  const kind = stringObjectValue(selector.kind ?? selector.type).trim();
  if (kind === "branch_id") {
    const branchId = stringObjectValue(
      selector.branch_id ?? selector.branchId,
    ).trim();
    if (!branchId) {
      issues.push({
        message: `${label} applies_to branch_id selector requires branch_id.`,
        severity: "error",
      });
    } else if (!availableBranchIds.has(branchId)) {
      issues.push({
        message: `${label} applies_to branch_id '${branchId}' does not exist for this hysteresis protocol.`,
        severity: "error",
      });
    }
    return;
  }
  if (kind === "point_selector") {
    if (!asRecord(selector.selector)) {
      issues.push({
        message: `${label} applies_to point_selector requires selector object.`,
        severity: "error",
      });
    }
    return;
  }
  if (kind === "role") {
    validateAppliesToRole(
      issues,
      stringObjectValue(selector.role).trim(),
      label,
      availableRoles,
    );
    return;
  }
  issues.push({
    message: `${label} applies_to selector kind must be branch_id, point_selector, or role.`,
    severity: "error",
  });
}

function validateAppliesToRole(
  issues: StudyStageDraftValidation[],
  role: string,
  label: string,
  availableRoles: Set<string>,
): void {
  const normalized = role.trim();
  if (!normalized) {
    issues.push({ message: `${label} applies_to role is required.`, severity: "error" });
  } else if (normalized === "branch_id" || normalized === "point_selector") {
    issues.push({
      message: `${label} applies_to '${normalized}' requires a selector object.`,
      severity: "error",
    });
  } else if (!availableRoles.has(normalized)) {
    issues.push({
      message: `${label} applies_to role '${normalized}' does not exist for this hysteresis protocol.`,
      severity: "error",
    });
  }
}

function availableHysteresisAppliesToRoles(draft: StudyStageDraft): Set<string> {
  const roles = new Set(["all_points", "key_events", "key_events_only"]);
  if (draft.initialStatePolicy && draft.initialStatePolicy !== "as_authored") {
    roles.add("preparation");
  }
  if (draft.saturationMode && draft.saturationMode !== "none") {
    roles.add("saturation_probe");
  }
  if (
    draft.protocolKind === "major_loop" ||
    draft.protocolKind === "major_with_minor_loops" ||
    draft.protocolKind === "virgin_then_major_loop"
  ) {
    roles.add("major");
  }
  if (
    draft.protocolKind === "virgin_curve" ||
    draft.protocolKind === "virgin_then_major_loop"
  ) {
    roles.add("virgin");
  }
  if (
    draft.protocolKind === "major_with_minor_loops" &&
    draft.minorLoops.trim() &&
    draft.minorLoops.trim() !== "[]"
  ) {
    roles.add("minor");
  }
  return roles;
}

function availableHysteresisBranchIds(draft: StudyStageDraft): Set<string> {
  const branchIds = new Set<string>();
  if (
    draft.protocolKind === "major_loop" ||
    draft.protocolKind === "major_with_minor_loops" ||
    draft.protocolKind === "virgin_then_major_loop"
  ) {
    branchIds.add("descending");
    branchIds.add("ascending");
  }
  if (
    draft.protocolKind === "virgin_curve" ||
    draft.protocolKind === "virgin_then_major_loop"
  ) {
    branchIds.add("virgin");
  }
  return branchIds;
}

function validateSettleRetryPolicy(
  issues: StudyStageDraftValidation[],
  step: JsonRecord,
  label: string,
  policy: string,
): void {
  const retryScale = finiteObjectNumber(
    step.retry_timestep_scale ?? step.retryTimestepScale,
  );
  const retryAttempts = finiteObjectNumber(
    step.retry_max_attempts ?? step.retryMaxAttempts,
  );
  if (retryScale !== null && (retryScale <= 0 || retryScale >= 1)) {
    issues.push({
      message: `${label} retry_timestep_scale must be positive and smaller than 1.`,
      severity: "error",
    });
  }
  if (
    retryAttempts !== null &&
    (!Number.isInteger(retryAttempts) || retryAttempts <= 0)
  ) {
    issues.push({
      message: `${label} retry_max_attempts must be a positive integer.`,
      severity: "error",
    });
  }
  if (policy === "retry_with_smaller_dt" && retryScale === null) {
    issues.push({
      message: `${label} retry_with_smaller_dt requires retry_timestep_scale.`,
      severity: "error",
    });
  }
}

function validateSettleTimesteps(
  issues: StudyStageDraftValidation[],
  step: JsonRecord,
  label: string,
): void {
  const timestep = finiteObjectNumber(
    step.timestep_s ?? step.timestep ?? step.dt,
  );
  const minTimestep = finiteObjectNumber(
    step.timestep_min_s ?? step.dt_min ?? step.dtMin,
  );
  if (timestep !== null && timestep <= 0) {
    issues.push({
      message: `${label} timestep_s must be a positive finite number.`,
      severity: "error",
    });
  }
  if (minTimestep !== null && minTimestep <= 0) {
    issues.push({
      message: `${label} dt_min must be a positive finite number.`,
      severity: "error",
    });
  }
  if (timestep !== null && minTimestep !== null && minTimestep > timestep) {
    issues.push({
      message: `${label} dt_min must be smaller than or equal to timestep_s.`,
      severity: "error",
    });
  }
  validatePositiveObjectNumber(
    issues,
    step.max_pseudotime_s ?? step.maxPseudotimeS,
    `${label} max_pseudotime_s`,
    false,
  );
  validatePositiveObjectNumber(
    issues,
    step.max_physical_time_s ?? step.maxPhysicalTimeS,
    `${label} max_physical_time_s`,
    false,
  );
}

function validatePositiveObjectNumber(
  issues: StudyStageDraftValidation[],
  value: unknown,
  label: string,
  required = true,
): void {
  const parsed = finiteObjectNumber(value);
  if (parsed === null) {
    if (required) {
      issues.push({ message: `${label} must be a positive finite number.`, severity: "error" });
    }
    return;
  }
  if (parsed <= 0) {
    issues.push({ message: `${label} must be a positive finite number.`, severity: "error" });
  }
}

interface SettleStepDraft {
  onNonConvergence: string;
}

function parseSettleStepDrafts(value: string): SettleStepDraft[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        const step = asRecord(item);
        if (!step) return null;
        return {
          onNonConvergence: stringObjectValue(
            step.on_non_convergence ?? step.onNonConvergence,
          ).trim(),
        };
      })
      .filter((step): step is SettleStepDraft => Boolean(step));
  } catch {
    return [];
  }
}

function parseSettleStepRecords(value: string): JsonRecord[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      const step = asRecord(item);
      return step ? [step] : [];
    });
  } catch {
    return [];
  }
}

function settleBranchesContainFallback(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return false;
    return parsed.some((item) => {
      const branch = asRecord(item);
      const when = stringObjectValue(branch?.when).trim();
      return (
        when === "non_converged" ||
        when === "fallback" ||
        when === "run_next_algorithm"
      );
    });
  } catch {
    return false;
  }
}

function stringObjectValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

function validateMinorLoop(
  issues: StudyStageDraftValidation[],
  item: unknown,
  index: number,
): void {
  const loop = asRecord(item);
  const label = `Minor loop ${index + 1}`;
  if (!loop) {
    issues.push({ message: `${label} must be a JSON object.`, severity: "error" });
    return;
  }

  const reversal = finiteObjectNumber(loop.reversal_mT ?? loop.reversalMt);
  const returnField = finiteObjectNumber(loop.return_mT ?? loop.returnMt);
  if (reversal === null) {
    issues.push({
      message: `${label} reversal_mT must be a finite number.`,
      severity: "error",
    });
  }
  if (returnField === null) {
    issues.push({
      message: `${label} return_mT must be a finite number.`,
      severity: "error",
    });
  }
  if (
    reversal !== null &&
    returnField !== null &&
    sameFieldValue(reversal, returnField)
  ) {
    issues.push({
      message: `${label} reversal_mT and return_mT must differ.`,
      severity: "error",
    });
  }
}

function validateMinorLoopEnvelope(
  issues: StudyStageDraftValidation[],
  draft: StudyStageDraft,
): void {
  const loops = parseMinorLoopDrafts(draft.minorLoops);
  if (loops.length === 0) return;
  if (draft.protocolKind !== "major_with_minor_loops") {
    issues.push({
      message: "Minor loops require branch mode major_with_minor_loops.",
      severity: "error",
    });
  }
  const fieldMin = finiteObjectNumber(draft.fieldMinMt);
  const fieldMax = finiteObjectNumber(draft.fieldMaxMt);
  if (fieldMin === null || fieldMax === null) return;
  const lower = Math.min(fieldMin, fieldMax);
  const upper = Math.max(fieldMin, fieldMax);
  for (const loop of loops) {
    if (loop.reversal < lower || loop.reversal > upper) {
      issues.push({
        message: `Minor loop ${loop.index + 1} reversal_mT must be within the field range.`,
        severity: "error",
      });
    }
    if (loop.returnField < lower || loop.returnField > upper) {
      issues.push({
        message: `Minor loop ${loop.index + 1} return_mT must be within the field range.`,
        severity: "error",
      });
    }
  }
}

interface MinorLoopDraft {
  index: number;
  returnField: number;
  reversal: number;
}

function parseMinorLoopDrafts(value: string): MinorLoopDraft[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item, index) => {
        const loop = asRecord(item);
        if (!loop) return null;
        const reversal = finiteObjectNumber(loop.reversal_mT ?? loop.reversalMt);
        const returnField = finiteObjectNumber(loop.return_mT ?? loop.returnMt);
        if (reversal === null || returnField === null) return null;
        return { index, returnField, reversal };
      })
      .filter((loop): loop is MinorLoopDraft => Boolean(loop));
  } catch {
    return [];
  }
}

function validateFieldSegment(
  issues: StudyStageDraftValidation[],
  item: unknown,
  index: number,
): void {
  const segment = asRecord(item);
  const label = `Field segment ${index + 1}`;
  if (!segment) {
    issues.push({ message: `${label} must be a JSON object.`, severity: "error" });
    return;
  }

  const segmentId = stringValue(segment.segmentId ?? segment.segment_id, "").trim();
  const endpointPolicy = stringValue(segment.endpointPolicy ?? segment.endpoint_policy, "").trim();
  const start = segment.startField ?? segment.start_field ?? segment.start;
  const stop = segment.stopField ?? segment.stop_field ?? segment.stop;
  const step = segment.step ?? segment.step_mT ?? segment.field_step_mT;
  const startValue = typeof start === "number" ? start : Number(String(start ?? "").trim());
  const stopValue = typeof stop === "number" ? stop : Number(String(stop ?? "").trim());
  const stepValue = typeof step === "number" ? step : Number(String(step ?? "").trim());

  if (!segmentId) {
    issues.push({ message: `${label} requires segmentId.`, severity: "error" });
  }
  if (!endpointPolicy) {
    issues.push({ message: `${label} requires endpointPolicy.`, severity: "error" });
  } else if (!SUPPORTED_FIELD_SEGMENT_ENDPOINT_POLICIES.has(endpointPolicy)) {
    issues.push({
      message: `${label} endpointPolicy must be include_stop, skip_start, or include_both.`,
      severity: "error",
    });
  }
  if (!Number.isFinite(startValue)) {
    issues.push({ message: `${label} startField must be a finite number.`, severity: "error" });
  }
  if (!Number.isFinite(stopValue)) {
    issues.push({ message: `${label} stopField must be a finite number.`, severity: "error" });
  }
  if (!Number.isFinite(stepValue) || stepValue <= 0) {
    issues.push({ message: `${label} step must be a positive finite number.`, severity: "error" });
  }
  if (Number.isFinite(startValue) && Number.isFinite(stopValue) && startValue === stopValue) {
    issues.push({ message: `${label} startField and stopField must differ.`, severity: "error" });
  }
}

function validateFieldSegmentSchedule(
  issues: StudyStageDraftValidation[],
  value: string,
): void {
  const segments = parseFieldSegmentDrafts(value);
  if (segments.length < 2) return;

  for (let index = 1; index < segments.length; index += 1) {
    const previous = segments[index - 1];
    const current = segments[index];
    if (!previous || !current) continue;
    if (!Number.isFinite(previous.stop) || !Number.isFinite(current.start)) {
      continue;
    }
    if (sameFieldValue(previous.stop, current.start)) {
      if (
        current.endpointPolicy !== "skip_start" &&
        current.endpointPolicy !== "include_both"
      ) {
        issues.push({
          message: `Field segment ${index + 1} shares a boundary with segment ${index}; choose skip_start or include_both explicitly.`,
          severity: "warning",
        });
      }
    } else {
      issues.push({
        message: `Field segment ${index + 1} starts at ${current.start} mT, leaving a discontinuity after segment ${index} stops at ${previous.stop} mT.`,
        severity: "warning",
      });
    }
  }
}

function validateDenseWindow(
  issues: StudyStageDraftValidation[],
  item: unknown,
  index: number,
): void {
  const window = asRecord(item);
  const label = `Dense window ${index + 1}`;
  if (!window) {
    issues.push({ message: `${label} must be a JSON object.`, severity: "error" });
    return;
  }

  const center = finiteObjectNumber(window.center_mT ?? window.centerMt);
  const halfWidth = finiteObjectNumber(window.half_width_mT ?? window.halfWidthMt);
  const step = finiteObjectNumber(window.step_mT ?? window.stepMt);
  const priority = window.priority;

  if (center === null) {
    issues.push({ message: `${label} center_mT must be a finite number.`, severity: "error" });
  }
  if (halfWidth === null || halfWidth <= 0) {
    issues.push({ message: `${label} half_width_mT must be a positive finite number.`, severity: "error" });
  }
  if (step === null || step <= 0) {
    issues.push({ message: `${label} step_mT must be a positive finite number.`, severity: "error" });
  }
  if (
    priority !== null &&
    priority !== undefined &&
    (!Number.isInteger(Number(priority)) || Number(priority) < 0)
  ) {
    issues.push({ message: `${label} priority must be a non-negative integer.`, severity: "error" });
  }
}

function validateDenseWindowOverlaps(
  issues: StudyStageDraftValidation[],
  value: string,
): void {
  const windows = parseDenseWindowDrafts(value);
  windows.sort((left, right) => left.start - right.start || left.end - right.end);

  let previous: DenseWindowDraft | null = null;
  for (const window of windows) {
    if (previous && window.start < previous.end) {
      if (window.priority === null || previous.priority === null) {
        issues.push({
          message: `Dense window ${window.index + 1} overlaps dense window ${previous.index + 1}; overlapping windows require explicit priority.`,
          severity: "error",
        });
      } else if (window.priority === previous.priority) {
        issues.push({
          message: `Dense window ${window.index + 1} overlaps dense window ${previous.index + 1}; overlapping windows require distinct priority values.`,
          severity: "error",
        });
      }
    }
    if (!previous || window.end > previous.end) {
      previous = window;
    }
  }
}

interface FieldSegmentDraft {
  endpointPolicy: string;
  start: number;
  stop: number;
}

function parseFieldSegmentDrafts(value: string): FieldSegmentDraft[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        const segment = asRecord(item);
        if (!segment) return null;
        const start = finiteObjectNumber(segment.startField ?? segment.start_field ?? segment.start);
        const stop = finiteObjectNumber(segment.stopField ?? segment.stop_field ?? segment.stop);
        const endpointPolicy = stringValue(
          segment.endpointPolicy ?? segment.endpoint_policy,
          "",
        ).trim();
        return start === null || stop === null
          ? null
          : { endpointPolicy, start, stop };
      })
      .filter((segment): segment is FieldSegmentDraft => Boolean(segment));
  } catch {
    return [];
  }
}

interface DenseWindowDraft {
  end: number;
  index: number;
  priority: number | null;
  start: number;
}

function parseDenseWindowDrafts(value: string): DenseWindowDraft[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item, index) => {
        const window = asRecord(item);
        if (!window) return null;
        const center = finiteObjectNumber(window.center_mT ?? window.centerMt);
        const halfWidth = finiteObjectNumber(window.half_width_mT ?? window.halfWidthMt);
        if (center === null || halfWidth === null || halfWidth <= 0) return null;
        const rawPriority = window.priority;
        const priority =
          rawPriority === null || rawPriority === undefined
            ? null
            : Number(rawPriority);
        const validPriority =
          priority !== null && Number.isInteger(priority) && priority >= 0
            ? priority
            : null;
        return {
          end: center + halfWidth,
          index,
          priority: validPriority,
          start: center - halfWidth,
        };
      })
      .filter((window): window is DenseWindowDraft => Boolean(window));
  } catch {
    return [];
  }
}

function finiteObjectNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && !value.trim()) return null;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function sameFieldValue(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-9;
}

function validatePositiveInteger(
  issues: StudyStageDraftValidation[],
  value: string,
  label: string,
  required: boolean,
): void {
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) {
      issues.push({ message: `${label} is required.`, severity: "error" });
    }
    return;
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    issues.push({
      message: `${label} must be a positive integer.`,
      severity: "error",
    });
  }
}

function stageKind(record: JsonRecord | null): StudyStageDraftKind {
  const kind = String(record?.kind ?? record?.entrypoint_kind ?? "relax");
  const normalized = kind.toLowerCase();
  if (normalized.includes("change_device")) return "change_device";
  if (normalized.includes("frequency")) return "frequency_response";
  if (normalized.includes("eigen")) return "eigenmodes";
  if (normalized.includes("hysteresis")) return "hysteresis";
  if (normalized.includes("save")) return "save_state";
  if (normalized.includes("run")) return "run";
  return "relax";
}

function spectralDraft(
  base: StudyStageDraft,
  record: JsonRecord | null,
  index: number,
): StudyStageDraft {
  return {
    ...base,
    bc: scalarOrObjectText(record?.bc, base.bc),
    calculationMode: scalarText(
      record?.calculation_mode,
      base.calculationMode,
    ),
    count: scalarText(record?.count, base.count),
    dampingPolicy: canonicalSpectralOption(
      scalarText(record?.damping_policy, base.dampingPolicy),
      SPECTRAL_DAMPING_POLICY_ALIASES,
    ),
    equilibriumArtifact: scalarText(record?.equilibrium_artifact, ""),
    equilibriumSource: canonicalSpectralOption(
      scalarText(record?.equilibrium_source, base.equilibriumSource),
      SPECTRAL_EQUILIBRIUM_SOURCE_ALIASES,
    ),
    includeDemag: booleanValue(record?.include_demag, base.includeDemag),
    kSampling: objectText(record?.k_sampling),
    kVector: vectorText(record?.k_vector, ""),
    normalization: canonicalSpectralOption(
      scalarText(record?.normalization, base.normalization),
      SPECTRAL_NORMALIZATION_ALIASES,
    ),
    stageId: stringValue(record?.stage_id ?? record?.id, `stage-${index + 1}`),
    target: scalarText(record?.target, base.target),
    targetFrequency: scalarText(record?.target_frequency ?? record?.eigen_target_frequency, ""),
    frequencyMin: scalarText(record?.frequency_min ?? record?.eigen_frequency_min, ""),
    frequencyMax: scalarText(record?.frequency_max ?? record?.eigen_frequency_max, ""),
  };
}

function spectralSceneStage(
  draft: StudyStageDraft,
  kind: "eigenmodes" | "frequency_response",
): JsonObject {
  const stage: JsonObject = {
    bc: parseJsonOrString(draft.bc, "free"),
    calculation_mode: requiredText(
      draft.calculationMode,
      kind === "eigenmodes" ? "fmr_modal" : "fmr_response",
    ),
    damping_policy: requiredText(draft.dampingPolicy, "ignore"),
    equilibrium_source: requiredText(
      draft.equilibriumSource,
      kind === "eigenmodes" ? "relax" : "provided",
    ),
    include_demag: draft.includeDemag,
    kind,
    normalization: requiredText(draft.normalization, "unit_l2"),
    stage_id: requiredText(draft.stageId, kind),
  };
  stage.entrypoint_kind =
    kind === "eigenmodes" ? "flat_eigenmodes" : "flat_frequency_response";
  setOptionalText(stage, "equilibrium_artifact", draft.equilibriumArtifact);
  setOptionalText(
    stage,
    kind === "eigenmodes"
      ? "eigen_equilibrium_artifact"
      : "frequency_equilibrium_artifact",
    draft.equilibriumArtifact,
  );
  const kVector = optionalVector3(draft.kVector);
  if (kVector) stage.k_vector = kVector;
  const kSampling = optionalJsonObject(draft.kSampling);
  if (kSampling) stage.k_sampling = kSampling;
  if (kind === "eigenmodes") {
    stage.eigen_calculation_mode = stage.calculation_mode;
    stage.eigen_include_demag = draft.includeDemag;
    stage.eigen_equilibrium_source = stage.equilibrium_source;
    stage.eigen_normalization = stage.normalization;
    stage.eigen_damping_policy = stage.damping_policy;
    if (kVector) stage.eigen_k_vector = kVector;
    if (kSampling) stage.eigen_k_sampling = kSampling;
    stage.eigen_spin_wave_bc = stage.bc;
  } else {
    stage.frequency_calculation_mode = stage.calculation_mode;
    stage.frequency_include_demag = draft.includeDemag;
    stage.frequency_equilibrium_source = stage.equilibrium_source;
    stage.frequency_normalization = stage.normalization;
    stage.frequency_damping_policy = stage.damping_policy;
    if (kVector) stage.frequency_k_vector = kVector;
    if (kSampling) stage.frequency_k_sampling = kSampling;
    stage.frequency_spin_wave_bc = stage.bc;
  }
  return stage;
}

function scalarText(value: unknown, fallback: string): string {
  if (typeof value === "number" || typeof value === "string") {
    return String(value);
  }
  return fallback;
}

function canonicalSpectralOption(
  value: string,
  aliases: Record<string, string>,
): string {
  return aliases[value] ?? value;
}

function measurementAxisDraftFields(
  value: unknown,
  fallback: string,
): Pick<StudyStageDraft, "measurementAxis" | "measurementAxisCustomVector"> {
  const axis = asRecord(value);
  if (axis?.kind === "custom") {
    return {
      measurementAxis: "custom",
      measurementAxisCustomVector: Array.isArray(axis.vector)
        ? axis.vector.join(", ")
        : "",
    };
  }
  if (typeof value === "number" || typeof value === "string") {
    return {
      measurementAxis: String(value),
      measurementAxisCustomVector: "",
    };
  }
  return {
    measurementAxis: value === null || value === undefined ? fallback : JSON.stringify(value),
    measurementAxisCustomVector: "",
  };
}

function parseMeasurementAxisDraft(draft: StudyStageDraft): JsonValue {
  const axis = draft.measurementAxis.trim();
  if (axis === "custom") {
    return {
      kind: "custom",
      vector: requiredNonZeroVector3(
        draft.measurementAxisCustomVector,
        "measurement_axis.vector",
      ),
    };
  }
  if (SUPPORTED_HYSTERESIS_MEASUREMENT_AXES.has(axis)) {
    return axis || "field_axis";
  }
  throw new Error(
    `measurement_axis must be ${supportedSetMessage(SUPPORTED_HYSTERESIS_MEASUREMENT_AXES)}.`,
  );
}

function listText(value: unknown, fallback: string): string {
  return Array.isArray(value) ? value.join(", ") : scalarText(value, fallback);
}

function vectorText(value: unknown, fallback: string): string {
  return Array.isArray(value) && value.length === 3
    ? value.join(", ")
    : scalarText(value, fallback);
}

function legacyVectorSweepToMilliteslaRange(
  startField: unknown,
  stopField: unknown,
  fieldSteps: unknown,
): { max: string | null; min: string | null; step: string | null } {
  const start = Array.isArray(startField) && typeof startField[2] === "number"
    ? startField[2] * 1000
    : null;
  const stop = Array.isArray(stopField) && typeof stopField[2] === "number"
    ? stopField[2] * 1000
    : null;
  if (start === null || stop === null) {
    return { max: null, min: null, step: null };
  }
  const min = Math.min(start, stop);
  const max = Math.max(start, stop);
  const steps = typeof fieldSteps === "number"
    ? fieldSteps
    : typeof fieldSteps === "string"
      ? Number(fieldSteps)
      : null;
  const step = steps && Number.isFinite(steps) && steps > 1
    ? Math.abs(max - min) / (steps - 1)
    : null;
  return {
    max: String(max),
    min: String(min),
    step: step === null ? null : String(step),
  };
}

function objectText(value: unknown): string {
  return value === null || value === undefined ? "" : JSON.stringify(value);
}

function normalizeHysteresisFieldSegment(value: unknown): JsonObject {
  const segment = asRecord(value);
  if (!segment) {
    return {};
  }
  const normalized: JsonObject = {};
  const start = segment.start ?? segment.startField ?? segment.start_field;
  const stop = segment.stop ?? segment.stopField ?? segment.stop_field;
  const step = segment.step ?? segment.step_mT ?? segment.field_step_mT;
  const segmentId = segment.segment_id ?? segment.segmentId;
  const endpointPolicy = segment.endpoint_policy ?? segment.endpointPolicy;

  if (typeof start === "number") normalized.start = start;
  if (typeof stop === "number") normalized.stop = stop;
  if (typeof step === "number") normalized.step = step;
  if (typeof segmentId === "string") normalized.segment_id = segmentId;
  if (typeof segment.label === "string") normalized.label = segment.label;
  if (typeof endpointPolicy === "string") {
    normalized.endpoint_policy = endpointPolicy;
  }
  if (typeof segment.reason === "string") normalized.reason = segment.reason;
  return normalized;
}

function normalizeHysteresisDenseWindow(value: unknown): JsonObject {
  const window = asRecord(value);
  if (!window) {
    return {};
  }
  const normalized: JsonObject = {};
  const center = window.center_mT ?? window.centerMt;
  const halfWidth = window.half_width_mT ?? window.halfWidthMt;
  const step = window.step_mT ?? window.stepMt;

  if (typeof center === "number") normalized.center_mT = center;
  if (typeof halfWidth === "number") normalized.half_width_mT = halfWidth;
  if (typeof step === "number") normalized.step_mT = step;
  if (typeof window.reason === "string") normalized.reason = window.reason;
  if (typeof window.priority === "number") normalized.priority = window.priority;
  return normalized;
}

function normalizeHysteresisMinorLoop(value: unknown): JsonObject {
  const loop = asRecord(value);
  if (!loop) {
    return {};
  }
  const normalized: JsonObject = {};
  const reversal = loop.reversal_mT ?? loop.reversalMt;
  const returnField = loop.return_mT ?? loop.returnMt;

  if (typeof reversal === "number") normalized.reversal_mT = reversal;
  if (typeof returnField === "number") normalized.return_mT = returnField;
  return normalized;
}

function scalarOrObjectText(value: unknown, fallback: string): string {
  if (typeof value === "number" || typeof value === "string") {
    return String(value);
  }
  if (Boolean(value) && typeof value === "object" && !Array.isArray(value)) {
    return JSON.stringify(value);
  }
  return fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function requiredText(value: string, fallback: string): string {
  return value.trim() || fallback;
}

function requiredDeviceTarget(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (isSupportedDeviceTarget(normalized)) return normalized;
  throw new Error("device must be cpu, gpu, cuda, cuda:<index>, or auto.");
}

function requiredNumber(value: string, field: string): number {
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive finite number.`);
  }
  return parsed;
}

function requiredSignedNumber(value: string, field: string): number {
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} must be a finite number.`);
  }
  return parsed;
}

function requiredInteger(value: string, field: string): number {
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return parsed;
}

function requiredNumberList(value: string, field: string): number[] {
  const values = positiveNumberList(value);
  if (values.length === 0) {
    throw new Error(`${field} requires at least one positive finite number.`);
  }
  return values;
}

function requiredVector3(value: string, field: string): number[] {
  const vector = optionalVector3(value);
  if (!vector) {
    throw new Error(`${field} must contain three finite numbers.`);
  }
  return vector;
}

function requiredNonZeroVector3(value: string, field: string): number[] {
  const vector = requiredVector3(value, field);
  if (isZeroVector3(vector)) {
    throw new Error(`${field} must not be the zero vector.`);
  }
  return vector;
}

function requiredHysteresisOrientationPreset(value: string): string {
  const preset = value.trim();
  if (!preset) {
    throw new Error("orientation.preset_name is required.");
  }
  if (!SUPPORTED_HYSTERESIS_ORIENTATION_PRESETS.has(preset)) {
    throw new Error(
      `orientation.preset_name must be ${supportedSetMessage(SUPPORTED_HYSTERESIS_ORIENTATION_PRESETS)}.`,
    );
  }
  return preset;
}

function optionalVector3(value: string): number[] | null {
  const values = finiteNumberList(value);
  return values.length === 3 ? values : null;
}

function isZeroVector3(vector: readonly number[]): boolean {
  return vector.every((component) => component === 0);
}

function finiteNumberList(value: string): number[] {
  const values: number[] = [];
  for (const token of value.split(/[,\s]+/)) {
    const entry = token.trim();
    if (!entry) continue;
    const parsed = Number(entry);
    if (Number.isFinite(parsed)) {
      values.push(parsed);
    }
  }
  return values;
}

function supportedSetMessage(values: ReadonlySet<string>): string {
  return Array.from(values).join(", ");
}

function strictFiniteNumberList(value: string): number[] | null {
  const values: number[] = [];
  const tokens = value.split(/[,\s]+/).flatMap((token) => {
    const trimmed = token.trim();
    return trimmed ? [trimmed] : [];
  });
  if (tokens.length === 0) return null;
  for (const token of tokens) {
    const parsed = Number(token);
    if (!Number.isFinite(parsed)) return null;
    values.push(parsed);
  }
  return values;
}

function positiveNumberList(value: string): number[] {
  const values: number[] = [];
  for (const entry of finiteNumberList(value)) {
    if (entry > 0) {
      values.push(entry);
    }
  }
  return values;
}

function parseJsonOrString(value: string, fallback: string): JsonObject | string {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  if (!trimmed.startsWith("{")) return trimmed;
  const parsed = JSON.parse(trimmed) as unknown;
  return Boolean(parsed) && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as JsonObject)
    : fallback;
}

function parseJsonArrayValue(value: string): JsonValue[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("JSON value must be an array.");
  }
  return parsed as JsonValue[];
}

function parseJsonObjectValue(value: string): JsonObject {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON value must be an object.");
  }
  return parsed as JsonObject;
}

function optionalJsonObject(value: string): JsonObject | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return parseJsonObjectValue(trimmed);
}

function optionalInteger(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function setOptionalNumber(
  target: JsonObject,
  key: string,
  value: string,
): void {
  const trimmed = value.trim();
  if (!trimmed) return;
  const parsed = Number(trimmed);
  if (Number.isFinite(parsed) && parsed > 0) {
    target[key] = parsed;
  }
}

function setOptionalText(target: JsonObject, key: string, value: string): void {
  const trimmed = value.trim();
  if (trimmed) target[key] = trimmed;
}

function validatePositiveNumberList(
  issues: StudyStageDraftValidation[],
  value: string,
  label: string,
): void {
  if (positiveNumberList(value).length === 0) {
    issues.push({
      message: `${label} requires at least one positive finite number.`,
      severity: "error",
    });
  }
}

function validateRequiredVector3(
  issues: StudyStageDraftValidation[],
  value: string,
  label: string,
): void {
  if (!optionalVector3(value)) {
    issues.push({
      message: `${label} must contain three finite numbers.`,
      severity: "error",
    });
  }
}

function validateOptionalVector3(
  issues: StudyStageDraftValidation[],
  value: string,
  label: string,
): void {
  if (value.trim() && !optionalVector3(value)) {
    issues.push({
      message: `${label} must contain three finite numbers.`,
      severity: "error",
    });
  }
}

function validateOptionalJson(
  issues: StudyStageDraftValidation[],
  value: string,
  label: string,
): void {
  if (!value.trim()) return;
  try {
    optionalJsonObject(value);
  } catch {
    issues.push({
      message: `${label} must be a JSON object.`,
      severity: "error",
    });
  }
}

function validateJsonOrString(
  issues: StudyStageDraftValidation[],
  value: string,
  label: string,
): void {
  const trimmed = value.trim();
  if (!trimmed || !trimmed.startsWith("{")) return;
  try {
    parseJsonOrString(value, "free");
  } catch {
    issues.push({
      message: `${label} must be a boundary condition name or JSON object.`,
      severity: "error",
    });
  }
}

function asRecord(value: unknown): JsonRecord | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}
