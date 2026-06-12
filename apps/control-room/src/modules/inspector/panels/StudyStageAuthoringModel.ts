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

export type StudyStageDraftKind =
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
  count: string;
  dampingPolicy: string;
  dataset: string;
  dt: string;
  dtMin: string;
  energyTolerance: string;
  equilibriumArtifact: string;
  equilibriumSource: string;
  excitationField: string;
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
  torqueTolerance: string;
  untilSeconds: string;
  // Hysteresis expansion fields
  protocolKind: string;
  initialStatePolicy: string;
  orientationMode: string;
  thetaDeg: string;
  phiDeg: string;
  customDirection: string;
  measurementAxis: string;
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
}

export interface StudyStageDraftValidation {
  message: string;
  severity: "error" | "warning";
}

const DEFAULT_RELAX_STAGE_DRAFT: StudyStageDraft = {
  algorithm: "llg_overdamped",
  artifactName: "state_snapshot",
  bc: "free",
  count: "10",
  dampingPolicy: "ignore",
  dataset: "",
  dt: "auto",
  dtMin: "",
  energyTolerance: "",
  equilibriumArtifact: "",
  equilibriumSource: "relax",
  excitationField: "0, 0, 1",
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
  torqueTolerance: "1e-6",
  untilSeconds: "",
  protocolKind: "",
  initialStatePolicy: "",
  orientationMode: "",
  thetaDeg: "",
  phiDeg: "",
  customDirection: "",
  measurementAxis: "",
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
};

const DEFAULT_RUN_STAGE_DRAFT: StudyStageDraft = {
  algorithm: "llg_overdamped",
  artifactName: "state_snapshot",
  bc: "free",
  count: "10",
  dampingPolicy: "ignore",
  dataset: "",
  dt: "auto",
  dtMin: "",
  energyTolerance: "",
  equilibriumArtifact: "",
  equilibriumSource: "relax",
  excitationField: "0, 0, 1",
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
  torqueTolerance: "",
  untilSeconds: "1e-9",
  protocolKind: "",
  initialStatePolicy: "",
  orientationMode: "",
  thetaDeg: "",
  phiDeg: "",
  customDirection: "",
  measurementAxis: "",
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
};

const DEFAULT_EIGENMODES_STAGE_DRAFT: StudyStageDraft = {
  ...DEFAULT_RELAX_STAGE_DRAFT,
  algorithm: "",
  dt: "",
  kind: "eigenmodes",
  maxSteps: "",
  relaxAlpha: "",
  solver: "",
  torqueTolerance: "",
};

const DEFAULT_FREQUENCY_RESPONSE_STAGE_DRAFT: StudyStageDraft = {
  ...DEFAULT_EIGENMODES_STAGE_DRAFT,
  equilibriumSource: "provided",
  kind: "frequency_response",
};

const DEFAULT_SAVE_STATE_STAGE_DRAFT: StudyStageDraft = {
  ...DEFAULT_RUN_STAGE_DRAFT,
  kind: "save_state",
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
  orientationMode: "preset",
  thetaDeg: "0",
  phiDeg: "0",
  customDirection: DEFAULT_HYSTERESIS_ORIENTATION_PRESET,
  measurementAxis: DEFAULT_HYSTERESIS_MEASUREMENT_AXIS,
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
      excitationField: vectorText(record?.excitation_field_au_per_m, "0, 0, 1"),
      frequenciesHz: listText(record?.frequencies_hz, DEFAULT_FREQUENCY_RESPONSE_STAGE_DRAFT.frequenciesHz),
      observable: scalarText(record?.observable, DEFAULT_FREQUENCY_RESPONSE_STAGE_DRAFT.observable),
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
      protocolKind: scalarText(record?.branch_mode ?? record?.protocol_kind, "major_loop"),
      initialStatePolicy: scalarText(record?.initial_protocol ?? record?.initial_state_policy, "positive_saturation"),
      orientationMode,
      thetaDeg,
      phiDeg,
      customDirection,
      measurementAxis: measurementAxisText(record?.measurement_axis, "field_axis"),
      fieldScheduleMode,
      fieldSegments,
      denseWindows: objectText(record?.schedule_refinements ?? record?.dense_windows),
      saturationMode,
      maxProbeField,
      saturationThresholds,
      settlePipelineMode,
      settleSteps,
      settleBranches,
      minorLoops: objectText(record?.minor_loops),
      storagePolicy: record?.storage ? JSON.stringify(record.storage) : DEFAULT_HYSTERESIS_STAGE_DRAFT.storagePolicy,
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
        preset_name: draft.customDirection.trim() || "oop_positive",
      };
    } else if (draft.orientationMode === "sample") {
      orientation = {
        kind: "sample",
        theta: Number(draft.thetaDeg.trim() || 0),
        phi: Number(draft.phiDeg.trim() || 0),
      };
    } else if (draft.orientationMode === "global") {
      orientation = {
        kind: "global",
        vector: requiredVector3(draft.customDirection, "custom_direction"),
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
          branches,
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
      measurement_axis: parseMeasurementAxisDraft(draft.measurementAxis),
      branch_mode: draft.protocolKind || "major_loop",
      initial_protocol: draft.initialStatePolicy || "positive_saturation",
    };

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
    validatePositiveInteger(issues, draft.count, "Mode count", true);
    validatePositiveNumber(issues, draft.targetFrequency, "Target frequency", false);
    validateOptionalVector3(issues, draft.kVector, "k vector");
    validateOptionalJson(issues, draft.kSampling, "k sampling");
    validateJsonOrString(issues, draft.bc, "BC");
    return issues;
  }
  if (draft.kind === "frequency_response") {
    validatePositiveNumberList(issues, draft.frequenciesHz, "Frequencies");
    validateRequiredVector3(issues, draft.excitationField, "Excitation field");
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
  if (draft.kind === "hysteresis") {
    validatePositiveNumber(issues, draft.torqueTolerance, "Torque tolerance", true);
    validateSignedNumber(issues, draft.fieldMinMt, "Minimum field", true);
    validateSignedNumber(issues, draft.fieldMaxMt, "Maximum field", true);
    validatePositiveNumber(issues, draft.fieldStepMt, "Field step", true);

    if (draft.orientationMode === "global") {
      validateRequiredVector3(issues, draft.customDirection, "Orientation vector");
    }
    if (draft.orientationMode === "sample") {
      validateFiniteNumber(issues, draft.thetaDeg, "Theta", false);
      validateFiniteNumber(issues, draft.phiDeg, "Phi", false);
    }
    if (draft.saturationMode && draft.saturationMode !== "none") {
      validatePositiveNumber(issues, draft.maxProbeField, "Max probe field", true);
    }
    if (draft.settleSteps.trim() && draft.settleSteps.trim() !== "[]") {
      validateJsonArray(issues, draft.settleSteps, "Settle steps");
    }
    if (draft.settleBranches.trim() && draft.settleBranches.trim() !== "[]") {
      validateJsonArray(issues, draft.settleBranches, "Settle branches");
    }
    if (draft.fieldSegments.trim() && draft.fieldSegments.trim() !== "[]") {
      validateJsonArray(issues, draft.fieldSegments, "Field segments", validateFieldSegment);
    }
    if (draft.denseWindows.trim() && draft.denseWindows.trim() !== "[]") {
      validateJsonArray(issues, draft.denseWindows, "Dense windows");
    }
    if (draft.minorLoops.trim() && draft.minorLoops.trim() !== "[]") {
      validateJsonArray(issues, draft.minorLoops, "Minor loops");
    }
    if (draft.storagePolicy.trim()) {
      validateJsonObject(issues, draft.storagePolicy, "Storage policy");
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
      issues.push({ message: `${label} must be a valid JSON object.`, severity: "error" });
    }
  } catch {
    issues.push({ message: `${label} must be a valid JSON object.`, severity: "error" });
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
    count: scalarText(record?.count, base.count),
    dampingPolicy: scalarText(record?.damping_policy, base.dampingPolicy),
    equilibriumArtifact: scalarText(record?.equilibrium_artifact, ""),
    equilibriumSource: scalarText(record?.equilibrium_source, base.equilibriumSource),
    includeDemag: booleanValue(record?.include_demag, base.includeDemag),
    kSampling: objectText(record?.k_sampling),
    kVector: vectorText(record?.k_vector, ""),
    normalization: scalarText(record?.normalization, base.normalization),
    stageId: stringValue(record?.stage_id ?? record?.id, `stage-${index + 1}`),
    target: scalarText(record?.target, base.target),
    targetFrequency: scalarText(record?.target_frequency, ""),
  };
}

function spectralSceneStage(
  draft: StudyStageDraft,
  kind: "eigenmodes" | "frequency_response",
): JsonObject {
  const stage: JsonObject = {
    bc: parseJsonOrString(draft.bc, "free"),
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
    stage.eigen_include_demag = draft.includeDemag;
    stage.eigen_equilibrium_source = stage.equilibrium_source;
    stage.eigen_normalization = stage.normalization;
    stage.eigen_damping_policy = stage.damping_policy;
    if (kVector) stage.eigen_k_vector = kVector;
    if (kSampling) stage.eigen_k_sampling = kSampling;
    stage.eigen_spin_wave_bc = stage.bc;
  } else {
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

function measurementAxisText(value: unknown, fallback: string): string {
  if (typeof value === "number" || typeof value === "string") {
    return String(value);
  }
  return value === null || value === undefined ? fallback : JSON.stringify(value);
}

function parseMeasurementAxisDraft(value: string): JsonValue {
  const trimmed = value.trim();
  if (!trimmed) return "field_axis";
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    const parsed = JSON.parse(trimmed);
    return isJsonValue(parsed) ? parsed : trimmed;
  } catch {
    return trimmed;
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).every(isJsonValue);
  }
  return false;
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

function optionalVector3(value: string): number[] | null {
  const values = finiteNumberList(value);
  return values.length === 3 ? values : null;
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
