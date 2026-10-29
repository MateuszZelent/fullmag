//! Self-contained M3 composite codec. This is not an ExactResume admission gate.
//!
//! The store/restore owner must additionally validate the original admitted plan,
//! common checkpoint, primary carriers/generation, source identities and committed
//! output CAS prefix before restoring any live state.

use super::{
    checkpoint_identity, checkpoint_module_contract_from_plan, compare_checkpoint_identity,
    compare_checkpoint_module_contracts, run_error, validate_complete_coupled_checkpoint,
    FdmCoupledCheckpoint,
};
use crate::artifact_json::UnambiguousJson;
use crate::constraints::{FrozenSpinsActivationSet, FrozenSpinsCheckpointV1};
use crate::schedules::{
    collect_field_schedules, collect_scalar_schedules, is_due, same_time, OutputSchedule,
};
use crate::types::RunError;
use fullmag_ir::{FdmPlanIR, OutputIR, ProblemIR, StudyIR, StudyKindIR};
use fullmag_quantities::{is_canonical_sha256, AcceptedStateRef, ObservationClock};
use fullmag_session::types::{canonical_json_bytes, canonical_json_sha256};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;

pub(crate) const COMPOSITE_M3_SCHEMA_V2: &str = "fullmag.fdm.coupled_m3_checkpoint.v2";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct FdmCompositeCheckpointV2 {
    pub schema: String,
    pub payload_sha256: String,
    pub coupled: FdmCoupledCheckpoint,
    pub frozen_spins: Option<FrozenSpinsCheckpointV1>,
    pub frozen_activation_set: FrozenSpinsActivationSet,
    pub stage_frame: CompositeStageFrameV2,
    pub accepted_frame: CompositeAcceptedFrameV2,
    pub output_frame: CompositeOutputFrameV2,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CompositeStageFrameV2 {
    pub run_id: String,
    pub stage_id: String,
    pub stage_index: u64,
    pub stage_kind: CompositeStageKindV2,
    pub problem_ir_sha256: String,
    pub original_fdm_plan_sha256: String,
    pub stage_definition_sha256: String,
    pub original_stage_start_s: f64,
    pub original_stage_end_s: f64,
    pub waveform_origin_s: f64,
    pub stepping: CompositeSteppingV2,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum CompositeStageKindV2 {
    TimeEvolution,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum CompositeSteppingV2 {
    Fixed {
        nominal_grid_origin_s: f64,
        nominal_dt_s: f64,
    },
    Adaptive {
        controller_policy_sha256: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CompositeAcceptedFrameV2 {
    pub state_ref: AcceptedStateRef,
    pub step: u64,
    pub time_s: f64,
    pub last_dt_s: f64,
    pub last_step: CompositeLastStepV2,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum CompositeLastStepV2 {
    SingleArs {
        start_time_s: f64,
        inner_dt_s: f64,
    },
    TwoHalfArs {
        start_time_s: f64,
        split_time_s: f64,
        first_inner_dt_s: f64,
        second_inner_dt_s: f64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CompositeOutputFrameV2 {
    pub origin_s: f64,
    pub configuration_sha256: String,
    pub scalar_schedules: Vec<CompositeOutputCursorV2>,
    pub field_schedules: Vec<CompositeOutputCursorV2>,
    pub default_scalar_last_sampled_time_s: Option<f64>,
    pub initial_sample_committed: bool,
    pub final_sample_committed: bool,
    pub committed_manifest: Option<CompositeOutputManifestBindingV2>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CompositeOutputCursorV2 {
    pub output_index: u64,
    pub schedule_index: u64,
    pub name: String,
    pub every_seconds: f64,
    pub next_time: f64,
    pub last_sampled_time: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CompositeOutputManifestBindingV2 {
    pub catalog_revision: u64,
    pub artifact_id: String,
    pub object_ref: String,
    pub content_sha256: String,
}

/// Private payload prevents a codec check from being represented as admission.
/// Contextual owners must inspect the payload and complete their own gates.
#[derive(Debug)]
pub(crate) struct CodecCheckedCompositeV2(FdmCompositeCheckpointV2);

impl CodecCheckedCompositeV2 {
    pub(crate) fn payload(&self) -> &FdmCompositeCheckpointV2 {
        &self.0
    }

    /// Checks only the original admitted stage/plan gate, not ExactResume.
    ///
    /// Callers must obtain these inputs from the immutable admission owner,
    /// before any resumed-segment metadata or initial-state substitution. The
    /// ordinal is the position in the original StudyPlan.steps, including any
    /// disabled entries; it is not an accepted-step count. The duration comes
    /// from AcceptedWorkerStep.until_seconds, passed unchanged to the existing
    /// runner (stage start + duration). It is not CLI ResumeJson's absolute end.
    /// resolved_outputs must be the exact final original runtime list from the
    /// existing runtime_outputs_with_table_autosave owner, including implicit
    /// table cadence. The original plan must already have passed admission and
    /// canonical planning; this method does not reconstruct it from a segment.
    /// Common state, accepted primary carriers/generation and durable output CAS
    /// still require their own contextual gates after this method succeeds.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn validate_for_original_stage(
        &self,
        original_problem: &ProblemIR,
        original_plan: &FdmPlanIR,
        admitted_run_id: &str,
        admitted_stage_id: &str,
        admitted_stage_index: Option<u64>,
        admitted_until_seconds: Option<f64>,
        resolved_outputs: &[OutputIR],
    ) -> Result<(), RunError> {
        let ordinal = admitted_stage_index
            .ok_or_else(|| run_error("composite_v2_original_stage_ordinal_missing"))?;
        let duration = admitted_until_seconds
            .ok_or_else(|| run_error("composite_v2_original_stage_duration_missing"))?;
        let stage = &self.0.stage_frame;
        require(
            !admitted_run_id.trim().is_empty()
                && !admitted_stage_id.trim().is_empty()
                && original_plan.time_stage.active_stage_id.as_deref() == Some(admitted_stage_id),
            "original_stage_identity_missing_or_mismatch",
        )?;
        require(
            stage.run_id == admitted_run_id
                && stage.stage_id == admitted_stage_id
                && stage.stage_index == ordinal,
            "original_stage_identity_mismatch",
        )?;
        require(
            matches!(&original_problem.study, StudyIR::TimeEvolution { .. })
                && original_plan.time_stage.study_kind == StudyKindIR::TimeEvolution
                && original_plan.relaxation.is_none(),
            "original_stage_not_time_evolution",
        )?;
        let start = original_plan.time_stage.start_time_s;
        let end = start + duration;
        // The original plan's existing accessor owns legacy waveform defaults.
        // No clock is inferred from the checkpoint time, ordinal or step count.
        let waveform_origin = original_plan.time_stage.waveform_origin_time_s();
        require(
            start.is_finite()
                && start >= 0.0
                && duration.is_finite()
                && duration > 0.0
                && end.is_finite()
                && end > start
                && waveform_origin.is_finite()
                && bits_equal(stage.original_stage_start_s, start)
                && bits_equal(stage.waveform_origin_s, waveform_origin)
                && bits_equal(self.0.output_frame.origin_s, start),
            "original_stage_clock_mismatch",
        )?;
        require(
            bits_equal(stage.original_stage_end_s, end),
            "stage_endpoint_mismatch",
        )?;
        let original_problem_value = serde_json::to_value(original_problem).map_err(|error| {
            run_error(format!(
                "composite_v2_original_problem_serialization: {error}"
            ))
        })?;
        let stage_definition = serde_json::json!({
            "study": &original_problem.study,
            "time_stage": &original_plan.time_stage,
        });
        require(
            stage.problem_ir_sha256 == canonical_json_sha256(&original_problem_value)
                && stage.stage_definition_sha256 == canonical_json_sha256(&stage_definition)
                && stage.original_fdm_plan_sha256
                    == super::super::reference::fdm_abm3_plan_sha256(original_plan)?,
            "original_problem_or_plan_digest_mismatch",
        )?;
        match (&stage.stepping, &original_plan.adaptive_timestep) {
            (
                CompositeSteppingV2::Fixed {
                    nominal_grid_origin_s,
                    nominal_dt_s,
                },
                None,
            ) => {
                let original_dt = original_plan
                    .fixed_timestep
                    .ok_or_else(|| run_error("composite_v2_original_nominal_dt_missing"))?;
                require(
                    original_dt.is_finite()
                        && original_dt > 0.0
                        && bits_equal(*nominal_grid_origin_s, start)
                        && bits_equal(*nominal_dt_s, original_dt),
                    "original_fixed_policy_mismatch",
                )?;
            }
            (
                CompositeSteppingV2::Adaptive {
                    controller_policy_sha256,
                },
                Some(policy),
            ) => {
                let policy_value = serde_json::to_value(policy).map_err(|error| {
                    run_error(format!(
                        "composite_v2_original_policy_serialization: {error}"
                    ))
                })?;
                require(
                    *controller_policy_sha256 == canonical_json_sha256(&policy_value),
                    "original_adaptive_policy_mismatch",
                )?;
            }
            _ => return Err(run_error("composite_v2_original_stepping_kind_mismatch")),
        }
        let vector_count = original_plan
            .grid
            .cells
            .iter()
            .try_fold(1usize, |count, cells| {
                usize::try_from(*cells)
                    .ok()
                    .filter(|cells| *cells > 0)
                    .and_then(|cells| count.checked_mul(cells))
            })
            .ok_or_else(|| run_error("composite_v2_original_grid_shape_invalid"))?;
        validate_complete_coupled_checkpoint(&self.0.coupled, vector_count)?;
        require(
            original_plan
                .spin_transport_plans
                .iter()
                .any(|plan| plan.fdm_cpu_double_transient.is_some()),
            "original_plan_requires_transient_m3",
        )?;
        // These are the same pure identity/module validators used by
        // FdmSpinTransportWorkflow::restore_coupled_checkpoint. No workflow is
        // created, restored or mutated for this gate.
        compare_checkpoint_identity(
            &self.0.coupled.identity,
            &checkpoint_identity(original_plan)?,
        )?;
        let expected_modules = original_plan
            .spin_transport_plans
            .iter()
            .map(checkpoint_module_contract_from_plan)
            .collect::<Result<Vec<_>, _>>()?;
        compare_checkpoint_module_contracts(&self.0.coupled.accepted.modules, &expected_modules)?;
        match (&self.0.frozen_spins, &original_plan.frozen_spins) {
            (Some(checkpoint), Some(plan)) => {
                checkpoint.validate_for_plan(plan).map_err(|error| {
                    run_error(format!("composite_v2_original_frozen_plan: {error}"))
                })?;
                checkpoint
                    .validate_problem_sha256(&stage.original_fdm_plan_sha256)
                    .map_err(|error| {
                        run_error(format!("composite_v2_original_frozen_problem: {error}"))
                    })?;
            }
            (None, None) => {}
            _ => return Err(run_error("composite_v2_original_frozen_presence_mismatch")),
        }
        self.validate_original_outputs(resolved_outputs)?;
        Ok(())
    }

    fn validate_original_outputs(&self, outputs: &[OutputIR]) -> Result<(), RunError> {
        require(
            self.0.output_frame.configuration_sha256
                == canonical_json_sha256(&serde_json::json!({ "outputs": outputs })),
            "original_output_configuration_mismatch",
        )?;
        let scalar_schedules = collect_scalar_schedules(outputs)?;
        let field_schedules = collect_field_schedules(outputs)?;
        require(
            scalar_schedules.len() == self.0.output_frame.scalar_schedules.len()
                && field_schedules.len() == self.0.output_frame.field_schedules.len(),
            "original_output_cursor_count_mismatch",
        )?;
        // Index association follows the existing collectors, including repeated
        // names and qualified Snapshot components. Other output families remain
        // in the complete configuration hash; this is not their runtime gate.
        let mut scalar_index = 0;
        let mut field_index = 0;
        for (output_index, output) in outputs.iter().enumerate() {
            match output {
                OutputIR::Scalar { .. } | OutputIR::ScalarResolvedAuto { .. } => {
                    validate_original_cursor(
                        &self.0.output_frame.scalar_schedules[scalar_index],
                        &scalar_schedules[scalar_index],
                        output_index,
                        scalar_index,
                    )?;
                    scalar_index += 1;
                }
                OutputIR::Field { .. }
                | OutputIR::FieldResolvedAuto { .. }
                | OutputIR::Snapshot { .. } => {
                    validate_original_cursor(
                        &self.0.output_frame.field_schedules[field_index],
                        &field_schedules[field_index],
                        output_index,
                        field_index,
                    )?;
                    field_index += 1;
                }
                _ => {}
            }
        }
        Ok(())
    }
}

fn require(valid: bool, reason: &str) -> Result<(), RunError> {
    if valid {
        Ok(())
    } else {
        Err(run_error(format!("composite_v2_{reason}")))
    }
}

fn hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn bits_equal(left: f64, right: f64) -> bool {
    left.to_bits() == right.to_bits()
}

fn vectors_equal(left: &[[f64; 3]], right: &[[f64; 3]]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .flatten()
            .zip(right.iter().flatten())
            .all(|(a, b)| bits_equal(*a, *b))
}

fn required_nullable(value: &Value, field: &str) -> Result<(), RunError> {
    require(
        value
            .as_object()
            .is_some_and(|object| object.contains_key(field)),
        "required_nullable_missing",
    )
}

/// Raw bytes are mandatory: Value-only callers cannot establish duplicate-key refusal.
pub(crate) fn decode_composite_m3_codec_v2(
    bytes: &[u8],
    vector_count: usize,
) -> Result<CodecCheckedCompositeV2, RunError> {
    let UnambiguousJson(raw) = serde_json::from_slice::<UnambiguousJson>(bytes)
        .map_err(|error| run_error(format!("composite_v2_strict_json: {error}")))?;
    required_nullable(&raw, "frozen_spins")?;
    let output = &raw["output_frame"];
    required_nullable(output, "default_scalar_last_sampled_time_s")?;
    required_nullable(output, "committed_manifest")?;
    for collection in ["scalar_schedules", "field_schedules"] {
        if let Some(cursors) = output[collection].as_array() {
            for cursor in cursors {
                required_nullable(cursor, "last_sampled_time")?;
            }
        }
    }
    let decoded: FdmCompositeCheckpointV2 = serde_json::from_value(raw.clone())
        .map_err(|error| run_error(format!("composite_v2_typed_json: {error}")))?;
    let typed = serde_json::to_value(&decoded)
        .map_err(|error| run_error(format!("composite_v2_serialization: {error}")))?;
    // Recursive equality covers legacy ignored fields/defaults, skipped Options,
    // integer/float representation and BTreeSet ordering/deduplication.
    require(
        canonical_json_bytes(&raw) == canonical_json_bytes(&typed),
        "typed_roundtrip_mismatch",
    )?;
    require(
        decoded.schema == COMPOSITE_M3_SCHEMA_V2 && hex64(&decoded.payload_sha256),
        "schema_or_digest_invalid",
    )?;
    let mut unhashed = raw;
    unhashed["payload_sha256"] = Value::String(String::new());
    require(
        canonical_json_sha256(&unhashed) == decoded.payload_sha256,
        "payload_digest_mismatch",
    )?;
    decoded.validate_self_contained(vector_count)?;
    Ok(CodecCheckedCompositeV2(decoded))
}

impl FdmCompositeCheckpointV2 {
    /// Assigns only the outer hash. Never repairs children or admits ExactResume.
    pub(crate) fn encode_codec_only(&self, vector_count: usize) -> Result<Vec<u8>, RunError> {
        let mut value = serde_json::to_value(self)
            .map_err(|error| run_error(format!("composite_v2_serialization: {error}")))?;
        value["payload_sha256"] = Value::String(String::new());
        value["payload_sha256"] = Value::String(canonical_json_sha256(&value));
        let bytes = canonical_json_bytes(&value);
        decode_composite_m3_codec_v2(&bytes, vector_count)?;
        Ok(bytes)
    }

    fn validate_self_contained(&self, vector_count: usize) -> Result<(), RunError> {
        validate_complete_coupled_checkpoint(&self.coupled, vector_count)?;
        let stage = &self.stage_frame;
        let accepted = &self.accepted_frame;
        let coupled = &self.coupled;
        require(
            !stage.run_id.trim().is_empty()
                && !stage.stage_id.trim().is_empty()
                && hex64(&stage.problem_ir_sha256)
                && hex64(&stage.stage_definition_sha256)
                && is_canonical_sha256(&stage.original_fdm_plan_sha256)
                && stage.original_stage_start_s.is_finite()
                && stage.original_stage_start_s >= 0.0
                && stage.original_stage_end_s.is_finite()
                && stage.original_stage_end_s > stage.original_stage_start_s
                && stage.waveform_origin_s.is_finite()
                && accepted.time_s.is_finite()
                && accepted.time_s >= stage.original_stage_start_s
                && accepted.time_s <= stage.original_stage_end_s
                && accepted.last_dt_s.is_finite()
                && accepted.last_dt_s > 0.0,
            "stage_or_accepted_frame_invalid",
        )?;
        require(
            accepted.step == coupled.accepted_steps
                && bits_equal(accepted.time_s, coupled.time_s)
                && bits_equal(accepted.time_s, coupled.accepted.evaluated_time_s)
                && bits_equal(accepted.last_dt_s, coupled.previous_dt_s),
            "accepted_clock_mismatch",
        )?;
        accepted
            .state_ref
            .validate()
            .map_err(|error| run_error(format!("composite_v2_state_ref: {error}")))?;
        let id = &accepted.state_ref.id;
        let clock = ObservationClock {
            accepted_step: accepted.step,
            time_seconds: accepted.time_s,
            dt_seconds: Some(accepted.last_dt_s),
        };
        let clock_digest = clock
            .digest()
            .map_err(|error| run_error(format!("composite_v2_clock: {error}")))?;
        require(
            id.run_id == stage.run_id
                && id.stage_id.as_deref() == Some(stage.stage_id.as_str())
                && id.accepted_step == accepted.step
                && id.clock_digest == clock_digest,
            "accepted_identity_mismatch",
        )?;
        // State/domain/plan digests and generation need the real accepted primary
        // carriers and common checkpoint. The accepted plan digest and original
        // FDM plan hash have separate owners; do not infer equality from names.
        let (start, inner_dt) = match (&stage.stepping, &accepted.last_step) {
            (
                CompositeSteppingV2::Fixed {
                    nominal_grid_origin_s,
                    nominal_dt_s,
                },
                CompositeLastStepV2::SingleArs {
                    start_time_s,
                    inner_dt_s,
                },
            ) => {
                require(
                    bits_equal(*nominal_grid_origin_s, stage.original_stage_start_s)
                        && nominal_dt_s.is_finite()
                        && *nominal_dt_s > 0.0
                        && (*nominal_grid_origin_s + *nominal_dt_s).is_finite()
                        && *nominal_grid_origin_s + *nominal_dt_s > *nominal_grid_origin_s
                        && bits_equal(*inner_dt_s, accepted.last_dt_s),
                    "fixed_history_invalid",
                )?;
                (*start_time_s, *inner_dt_s)
            }
            (
                CompositeSteppingV2::Adaptive {
                    controller_policy_sha256,
                },
                CompositeLastStepV2::TwoHalfArs {
                    start_time_s,
                    split_time_s,
                    first_inner_dt_s,
                    second_inner_dt_s,
                },
            ) => {
                require(
                    hex64(controller_policy_sha256)
                        && first_inner_dt_s.is_finite()
                        && *first_inner_dt_s > 0.0
                        && second_inner_dt_s.is_finite()
                        && *second_inner_dt_s > 0.0
                        && split_time_s.is_finite()
                        && *split_time_s > *start_time_s
                        && accepted.time_s > *split_time_s
                        && bits_equal(*first_inner_dt_s, 0.5 * accepted.last_dt_s)
                        && bits_equal(*split_time_s, *start_time_s + *first_inner_dt_s)
                        && bits_equal(*second_inner_dt_s, accepted.time_s - *split_time_s)
                        && bits_equal(*split_time_s + *second_inner_dt_s, accepted.time_s),
                    "adaptive_history_invalid",
                )?;
                (*start_time_s, *second_inner_dt_s)
            }
            _ => return Err(run_error("composite_v2_stepping_history_mismatch")),
        };
        require(
            start.is_finite()
                && start >= stage.original_stage_start_s
                && accepted.time_s > start
                && bits_equal(start + accepted.last_dt_s, accepted.time_s),
            "last_step_interval_invalid",
        )?;
        for state in coupled.transient_states.values() {
            require(
                bits_equal(state.time_s, accepted.time_s)
                    && state
                        .previous_dt_s
                        .is_some_and(|dt| bits_equal(dt, inner_dt)),
                "transient_clock_or_inner_history_mismatch",
            )?;
        }
        // Existing complete validation checks values numerically; v2 requires bits.
        for module in &coupled.accepted.modules {
            let state = &coupled.transient_states[&module.module_id];
            require(
                vectors_equal(&module.spin_potential_volts, &state.spin_potential_v),
                "accepted_spin_bits_mismatch",
            )?;
        }
        self.validate_frozen(vector_count)?;
        self.validate_outputs()?;
        Ok(())
    }

    fn validate_frozen(&self, vector_count: usize) -> Result<(), RunError> {
        let activation = &self.frozen_activation_set;
        require(
            activation
                .constraint_activation_epochs
                .iter()
                .all(|(id, epoch)| !id.trim().is_empty() && *epoch > 0)
                && activation
                    .active_constraint_ids
                    .iter()
                    .all(|id| activation.constraint_activation_epochs.contains_key(id))
                && (activation.constraint_activation_epochs.is_empty()
                    || activation.resolved_constraint_set_revision > 0),
            "activation_history_invalid",
        )?;
        let Some(frozen) = &self.frozen_spins else {
            return require(
                activation.active_constraint_ids.is_empty(),
                "missing_active_frozen_child",
            );
        };
        frozen
            .validate_structure(vector_count)
            .map_err(|error| run_error(format!("composite_v2_frozen_structure: {error}")))?;
        frozen
            .validate_problem_sha256(&self.stage_frame.original_fdm_plan_sha256)
            .map_err(|error| run_error(format!("composite_v2_frozen_problem: {error}")))?;
        let ids = frozen
            .constraint_ids
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>();
        require(
            frozen.constraint_activation_epochs == activation.constraint_activation_epochs
                && frozen.active_constraint_ids == activation.active_constraint_ids
                && frozen.resolved_constraint_set_revision
                    == activation.resolved_constraint_set_revision
                && !activation.active_constraint_ids.is_empty()
                && activation
                    .active_constraint_ids
                    .iter()
                    .filter_map(|id| activation.constraint_activation_epochs.get(id).copied())
                    .max()
                    == Some(frozen.activation.epoch)
                && ids == activation.active_constraint_ids
                && ids.len() == frozen.constraint_ids.len()
                && frozen.step == self.accepted_frame.step
                && bits_equal(frozen.time_s, self.accepted_frame.time_s)
                && bits_equal(frozen.dt, self.accepted_frame.last_dt_s)
                && vectors_equal(&frozen.magnetization, &self.coupled.magnetization),
            "frozen_state_or_activation_mismatch",
        )?;
        for (index, (magnetization, reference)) in frozen
            .magnetization
            .iter()
            .zip(&frozen.reference)
            .enumerate()
        {
            // Packed-mask shape/hash were validated by the existing frozen owner.
            if frozen.mask_bits[index / 8] & (1 << (index % 8)) != 0 {
                require(
                    vectors_equal(
                        std::slice::from_ref(magnetization),
                        std::slice::from_ref(reference),
                    ),
                    "frozen_reference_mismatch",
                )?;
            }
        }
        Ok(())
    }

    fn validate_outputs(&self) -> Result<(), RunError> {
        let output = &self.output_frame;
        let time = self.accepted_frame.time_s;
        let start = self.stage_frame.original_stage_start_s;
        require(
            bits_equal(output.origin_s, start)
                && hex64(&output.configuration_sha256)
                && (!output.final_sample_committed
                    || bits_equal(time, self.stage_frame.original_stage_end_s))
                && (output.scalar_schedules.is_empty()
                    || output.default_scalar_last_sampled_time_s.is_none()),
            "output_frame_invalid",
        )?;
        let mut output_indices = BTreeSet::new();
        for collection in [&output.scalar_schedules, &output.field_schedules] {
            for (index, cursor) in collection.iter().enumerate() {
                require(
                    cursor.schedule_index == index as u64
                        && output_indices.insert(cursor.output_index)
                        && !cursor.name.trim().is_empty()
                        && cursor.every_seconds.is_finite()
                        && cursor.every_seconds > 0.0
                        && cursor.next_time.is_finite()
                        && !is_due(time, cursor.next_time),
                    "output_cursor_invalid",
                )?;
                let phase = (cursor.next_time - output.origin_s) / cursor.every_seconds;
                let tick = phase.round();
                let expected = output.origin_s + tick * cursor.every_seconds;
                let before = output.origin_s + (tick - 1.0) * cursor.every_seconds;
                let after = output.origin_s + (tick + 1.0) * cursor.every_seconds;
                require(
                    phase.is_finite()
                        && tick >= 1.0
                        && tick < 9007199254740992.0
                        && expected.is_finite()
                        && before.is_finite()
                        && after.is_finite()
                        && same_time(expected, cursor.next_time)
                        && before < expected
                        && expected < after
                        && !same_time(before, expected)
                        && !same_time(expected, after),
                    "output_phase_unrepresentable_or_ambiguous",
                )?;
                validate_sample_time(cursor.last_sampled_time, start, time)?;
            }
        }
        validate_sample_time(output.default_scalar_last_sampled_time_s, start, time)?;
        let has_samples = output.initial_sample_committed
            || output.final_sample_committed
            || output.default_scalar_last_sampled_time_s.is_some()
            || output
                .scalar_schedules
                .iter()
                .chain(&output.field_schedules)
                .any(|cursor| cursor.last_sampled_time.is_some());
        match &output.committed_manifest {
            Some(binding) => require(
                has_samples
                    && binding.catalog_revision > 0
                    && !binding.artifact_id.trim().is_empty()
                    && hex64(&binding.object_ref)
                    && hex64(&binding.content_sha256)
                    && binding.object_ref == binding.content_sha256,
                "output_manifest_binding_invalid",
            )?,
            None => require(!has_samples, "outputs_not_committed")?,
        }
        // Only binding consistency is checked here. Publication/status/CAS bytes,
        // prefix coverage, resolved schedules and boundary flags need the store.
        Ok(())
    }
}

fn validate_sample_time(sample: Option<f64>, start: f64, time: f64) -> Result<(), RunError> {
    require(
        sample.is_none_or(|value| value.is_finite() && value >= start && value <= time),
        "sample_time_invalid",
    )
}

fn validate_original_cursor(
    cursor: &CompositeOutputCursorV2,
    schedule: &OutputSchedule,
    output_index: usize,
    schedule_index: usize,
) -> Result<(), RunError> {
    require(
        cursor.output_index
            == u64::try_from(output_index)
                .map_err(|_| run_error("composite_v2_original_output_index_overflow"))?
            && cursor.schedule_index
                == u64::try_from(schedule_index)
                    .map_err(|_| run_error("composite_v2_original_schedule_index_overflow"))?
            && cursor.name == schedule.name
            && bits_equal(cursor.every_seconds, schedule.every_seconds),
        "original_output_cursor_identity_mismatch",
    )
}
