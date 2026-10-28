//! Prepared full-volume inspection through one native V/RT0/J/H owner.
use super::closed_loop_v2::invalid;
use crate::types::{AuxiliaryArtifact, RunError};
use crate::solver_profile::{SolverProfileConfig, SolverProfileOperationOutcome, SolverProfileState};
#[cfg(feature = "fem-gpu")]
use crate::native_fem::NativeFemSurfaceRt0Profile;
#[cfg(not(feature = "fem-gpu"))]
#[derive(Default)]
struct NativeFemSurfaceRt0Profile {
    available: bool,
    accounting_issue: bool,
    operator_wall_time_ns: u64,
    native_call_wall_ns: Option<u64>,
    phase_wall_time_ns: [u64; 9],
}
use fullmag_ir::{BackendTarget, ExecutionDevice, ExecutionMode, ExecutionPrecision,
    RequestedTransportExecutionIR, ResolvedAntennaClosedLoopCurrentInputIR};
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use crate::{AntennaOperationPhase, AntennaOperationProgress, AntennaOperationProgressObserver};

fn tagged(value: &serde_json::Value) -> Result<String, RunError> {
    fullmag_ir::transport_identity::tagged_json_digest(value).map_err(|reason| invalid(&reason))
}

pub(crate) fn prepared_stage_identity(stage_id: &str, port_mode_id: &str,
    output_id: &str, source_revision: &str) -> Result<u64, RunError> {
    let digest = tagged(&json!({"schema":"antenna_closed_loop_stage_identity.v2",
        "stage_id":stage_id,"port_mode_id":port_mode_id,"output_id":output_id,
        "source_revision":source_revision}))?;
    let hex = digest.strip_prefix("sha256:").ok_or_else(|| invalid("stage digest prefix"))?;
    let prefix = hex.get(..16).ok_or_else(|| invalid("stage digest length"))?;
    u64::from_str_radix(prefix,16).map_err(|_| invalid("stage digest encoding"))
}

pub(crate) fn static_envelope_digest(source_module_id: &str, source_revision: &str)
    -> Result<String, RunError> {
    tagged(&json!({"schema":"antenna_closed_loop_static_envelope.v2",
        "source_module_id":source_module_id,"source_revision":source_revision,"multiplier":1.0}))
}

fn check_cancelled(cancelled: Option<&AtomicBool>) -> Result<(), RunError> {
    if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        return Err(invalid("inspection cancelled; native solve is non-preemptive and no artifact is published"));
    }
    Ok(())
}

/// A controlled return from the prepared, in-memory CPU ABI. This is not
/// proof that an arbitrary native crash or a later publication is recoverable.
#[derive(Debug)]
pub enum ClosedLoopExecutionError {
    NativeCallFailed { status: KnownNativeCallFailure, message: String },
    Other(RunError),
}
impl std::fmt::Display for ClosedLoopExecutionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NativeCallFailed { status, message } => write!(f, "prepared native call failed ({status:?}): {message}"),
            Self::Other(error) => std::fmt::Display::fmt(error, f),
        }
    }
}
impl std::error::Error for ClosedLoopExecutionError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KnownNativeCallFailure { Invalid, Unavailable, Internal }

pub(crate) fn known_native_call_failure(status: i32) -> Option<KnownNativeCallFailure> {
    match status {
        -1 => Some(KnownNativeCallFailure::Invalid),
        -2 => Some(KnownNativeCallFailure::Unavailable),
        -3 => Some(KnownNativeCallFailure::Internal),
        _ => None,
    }
}

fn classify_execution_error(error: RunError, status: Option<KnownNativeCallFailure>) -> ClosedLoopExecutionError {
    match status {
        Some(status) => ClosedLoopExecutionError::NativeCallFailed { status, message: error.message },
        None => ClosedLoopExecutionError::Other(error),
    }
}

pub fn execute_antenna_closed_loop_inspection_typed(
    input: &ResolvedAntennaClosedLoopCurrentInputIR,
    requested: &RequestedTransportExecutionIR, output_id: &str, cancelled: Option<&AtomicBool>,
) -> Result<Vec<AuxiliaryArtifact>, ClosedLoopExecutionError> {
    let mut native_status = None;
    execute_closed_loop(input, requested, output_id, cancelled, Some(&mut native_status), None, None)
        .map_err(|error| classify_execution_error(error, native_status))
}

/// Optional operation profiling does not create a synthetic LLG step or
/// alter scientific artifacts. The report is retained on controlled failure.
pub fn execute_antenna_closed_loop_inspection_profiled_typed(
    input: &ResolvedAntennaClosedLoopCurrentInputIR,
    requested: &RequestedTransportExecutionIR, output_id: &str, cancelled: Option<&AtomicBool>,
    config: &SolverProfileConfig, profile: &mut SolverProfileState,
) -> Result<Vec<AuxiliaryArtifact>, ClosedLoopExecutionError> {
    execute_antenna_closed_loop_inspection_observed_typed(input, requested, output_id, cancelled,
        Some(config), profile, None)
}

/// Observe the existing numerical operation without creating physical steps.
/// Field completion does not imply durable output publication.
pub fn execute_antenna_closed_loop_inspection_observed_typed(
    input: &ResolvedAntennaClosedLoopCurrentInputIR,
    requested: &RequestedTransportExecutionIR, output_id: &str, cancelled: Option<&AtomicBool>,
    config: Option<&SolverProfileConfig>, profile: &mut SolverProfileState,
    observer: Option<&AntennaOperationProgressObserver<'_>>,
) -> Result<Vec<AuxiliaryArtifact>, ClosedLoopExecutionError> {
    if observer.is_none() && config.is_none_or(|config| !config.enabled) {
        return execute_antenna_closed_loop_inspection_typed(input, requested, output_id, cancelled);
    }
    let started = std::time::Instant::now();
    let observe = |mut progress: AntennaOperationProgress| {
        progress.elapsed_seconds = started.elapsed().as_secs_f64();
        crate::antenna_operation_progress::notify(observer, progress);
    };
    let observed: Option<&AntennaOperationProgressObserver<'_>> = observer.map(|_| &observe as _);
    crate::antenna_operation_progress::notify(observed, AntennaOperationProgress {
        phase: AntennaOperationPhase::PreparingSource, completed_targets: 0,
        total_targets: input.field_sampling.positions_xyz_m.len() as u64,
        source_cells: input.source_mesh.cell_count() as u64, elapsed_seconds: 0.0,
    });
    let Some(config) = config.filter(|config| config.enabled) else {
        let mut native_status = None;
        return execute_closed_loop(input, requested, output_id, cancelled,
            Some(&mut native_status), None, observed)
            .map_err(|error| classify_execution_error(error, native_status));
    };
    let config = config.clone().normalized();
    if profile.config() != &config {
        profile.set_config(config);
    }
    let mut native_status = None;
    let mut native_profile = NativeFemSurfaceRt0Profile::default();
    let result = execute_closed_loop(input, requested, output_id, cancelled,
        Some(&mut native_status), Some(&mut native_profile), observed);
    let total_wall_time_ns = started.elapsed().as_nanos().min(u128::from(u64::MAX)) as u64;
    let outcome = if result.is_ok() {
        SolverProfileOperationOutcome::Completed
    } else if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        SolverProfileOperationOutcome::Cancelled
    } else {
        SolverProfileOperationOutcome::Failed
    };
    let mut phases = [0; 8];
    let native_operator_wall_ns = if native_profile.available {
        phases.copy_from_slice(&native_profile.phase_wall_time_ns[..8]);
        Some(native_profile.operator_wall_time_ns)
    } else {
        None
    };
    profile.record_antenna_operation(outcome, total_wall_time_ns,
        native_operator_wall_ns, native_profile.native_call_wall_ns, phases, native_profile.accounting_issue);
    result.map_err(|error| classify_execution_error(error, native_status))
}

pub fn execute_antenna_closed_loop_inspection(input: &ResolvedAntennaClosedLoopCurrentInputIR,
    requested: &RequestedTransportExecutionIR, output_id: &str, cancelled: Option<&AtomicBool>)
    -> Result<Vec<AuxiliaryArtifact>, RunError> {
    execute_closed_loop(input, requested, output_id, cancelled, None, None, None)
}

fn execute_closed_loop(input: &ResolvedAntennaClosedLoopCurrentInputIR,
    requested: &RequestedTransportExecutionIR, output_id: &str, cancelled: Option<&AtomicBool>,
    native_failure: Option<&mut Option<KnownNativeCallFailure>>,
    native_profile: Option<&mut NativeFemSurfaceRt0Profile>,
    observer: Option<&AntennaOperationProgressObserver<'_>>,
) -> Result<Vec<AuxiliaryArtifact>, RunError> {
    check_cancelled(cancelled)?;
    if let Err(reason) = input.validate_field_policy() {
        return Err(invalid(&reason));
    }
    if requested.discretization != BackendTarget::Fem
        || !matches!(requested.device, ExecutionDevice::Cpu | ExecutionDevice::Auto)
        || requested.precision != ExecutionPrecision::Double
        || requested.execution_mode != ExecutionMode::Strict {
        return Err(invalid("inspection requires FEM CPU/auto strict double; forced GPU and fallback are refused"));
    }
    let authored_request = input.authored_input_preimage.get("requested_execution")
        .ok_or_else(|| invalid("hashed requested execution absent"))?;
    let device = match requested.device {ExecutionDevice::Cpu => "cpu", ExecutionDevice::Auto => "auto",
        _ => return Err(invalid("unsupported requested device"))};
    if authored_request.get("backend").and_then(serde_json::Value::as_str) != Some("fem")
        || authored_request.get("device").and_then(serde_json::Value::as_str) != Some(device)
        || authored_request.get("execution_precision").and_then(serde_json::Value::as_str) != Some("double")
        || authored_request.get("execution_mode").and_then(serde_json::Value::as_str) != Some("strict")
        || input.authored_input_preimage.pointer("/backend_policy/requested_backend").and_then(serde_json::Value::as_str) != Some("fem")
        || input.authored_input_preimage.pointer("/backend_policy/execution_precision").and_then(serde_json::Value::as_str) != Some("double")
        || input.authored_input_preimage.pointer("/validation_profile/execution_mode").and_then(serde_json::Value::as_str) != Some("strict") {
        return Err(invalid("selected execution differs from hashed authoring intent; auto must remain auto"));
    }
    if input.schema_version != "antenna_closed_loop_current_input.v2"
        || input.field_scope != "full_closed_loop.inspection_only.v2"
        || input.stage.source_object_id != input.source.object_id
        || input.port.source_object_id != input.source.object_id
        || input.stage.current_transport_id != input.port.current_transport_id
        || input.stage.port_mode_ids != [input.port.id.clone()]
        || input.port.schema_version != "antenna_port_mode.v3"
        || !input.stage.outputs.iter().any(|output| output.id == output_id && output.quantity == "H_ant_basis")
        || output_id.is_empty() || output_id.len() > 255 || output_id.contains("..")
        || !output_id.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-.".contains(&b)) {
        return Err(invalid("selected prepared stage, port or output differs from owned source"));
    }
    if tagged(&input.authored_input_preimage)? != input.source.authored_input_digest
        || input.source_mesh.mixed_topology_fingerprint_v3().map_err(|reason| invalid(&reason))? != input.source.mesh_digest
        || !input.source.validation_errors("source").is_empty()
        || input.authored_definition.gauge != fullmag_ir::ChargePotentialGaugeIR::ZeroMean
        || input.solver != input.authored_definition.solver
        || input.solver.linear.relative_tolerance != 1e-12 || input.solver.linear.absolute_tolerance != 0.0
        || input.solver.linear.max_iterations == 0 || input.solver.linear.max_iterations > i32::MAX as u32
        || input.algebraic_relative_tolerance != 1e-12 || input.physical_relative_gate != 1e-10
        || input.physical_absolute_gate_a != 1e-18 {
        return Err(invalid("prepared identity, gauge or preregistered numeric policy differs"));
    }
    if input.authored_definition.domain.len() != 1
        || input.authored_definition.domain[0].object_id != input.source.object_id
        || input.authored_definition.domain[0].region_id.is_some()
        || !input.authored_definition.boundaries.is_empty()
        || input.authored_definition.conservative_current_view.is_some()
        || input.authored_definition.external_lead_preparation.is_some()
        || input.authored_definition.structured_current_closure.is_some()
        || !matches!(&input.authored_definition.conservative_current_source,
            Some(fullmag_ir::ConservativeCurrentSourceIR::ClosedGeometryPotentialJump(source)) if source == &input.source)
        || input.stage.conservative_current_view_ref.is_some()
        || input.stage.model != fullmag_ir::AntennaFieldModelIR::QuasistaticConductionBiotSavart3d
        || !matches!(input.stage.oersted_realization, fullmag_ir::AntennaOerstedRealizationIR::DirectTetraQuadrature | fullmag_ir::AntennaOerstedRealizationIR::AnalyticRt0Surface)
        || input.solver.engine != "cg"
        || input.solver.operator_version != "fem_charge_conforming_h1_p1.transparent.v1"
        || input.solver.physical_residual_version != "charge_balance_integrated_l2.v1" {
        return Err(invalid("alternate source, boundary, view or solver contract is refused"));
    }
    let fullmag_ir::ConservativeCurrentClosureIR::ClosedGeometry {source_cuts,..} = &input.source.closure
        else { return Err(invalid("closed source cut absent")); };
    if !matches!(&input.port.normalization,
        Some(fullmag_ir::AntennaPortNormalizationIR::SourceCutRt0 {source_cut_ref,orientation})
            if source_cut_ref == &source_cuts[0].id && orientation == "minus_outward") {
        return Err(invalid("port normalization must select the actual minus-outward source cut"));
    }
    execute_native(input, output_id, cancelled, native_failure, native_profile, observer)
}

#[cfg(feature = "fem-gpu")]
fn execute_native(input: &ResolvedAntennaClosedLoopCurrentInputIR, output_id: &str,
    cancelled: Option<&AtomicBool>, native_failure: Option<&mut Option<KnownNativeCallFailure>>,
    native_profile: Option<&mut NativeFemSurfaceRt0Profile>,
    observer: Option<&AntennaOperationProgressObserver<'_>>) -> Result<Vec<AuxiliaryArtifact>, RunError> {
    use crate::native_fem::{solve_native_fem_prepared_closed_loop_classified, NativeFemPreparedClosedLoopChargeRequest,
        PreparedClosedLoopRuntimeBinding, NativeFemSteadyTransportExecution, NativeFemSteadyTransportGauge};
    use super::closed_loop_v2::{ClosedLoopAcceptedSourceInputV2, ClosedLoopCurrentCellV2,
        ClosedLoopFieldSolutionInputV2, ClosedLoopSourceMetadataV2, ClosedLoopWeakReactionV2};
    let envelope = static_envelope_digest(&input.stage.current_transport_id, &input.source.revision)?;
    // Static charge input has no time envelope; identities are derived from admitted intent.
    let binding = PreparedClosedLoopRuntimeBinding {
        source_module_id: input.stage.current_transport_id.clone(), mesh_revision: input.source.mesh_digest.clone(),
        topology_revision: input.source.mesh_digest.clone(), envelope_revision: envelope.clone(), envelope_digest: envelope,
        stage_identity: prepared_stage_identity(&input.stage.id,&input.port.id,output_id,&input.source.revision)?,
        evaluation_time_s: 0.0, evaluated_envelope_multiplier: 1.0,
    };
    let request = NativeFemPreparedClosedLoopChargeRequest {mesh:input.source_mesh.clone(),
        execution:NativeFemSteadyTransportExecution::CpuDouble, gauge:NativeFemSteadyTransportGauge::ZeroMeanPotential,
        charge_conductivity_spm_per_element:input.conductivity_spm_per_element.clone(),
        relative_tolerance:input.solver.linear.relative_tolerance,absolute_tolerance:input.solver.linear.absolute_tolerance,
        maximum_iterations:input.solver.linear.max_iterations};
    check_cancelled(cancelled)?;
    let mut returned_native_failure = None;
    let solved = solve_native_fem_prepared_closed_loop_classified(&request,input,&binding,Some(&input.field_sampling.positions_xyz_m),Some(&mut returned_native_failure),native_profile,observer);
    check_cancelled(cancelled)?;
    if solved.is_err() {
        if let Some(native_failure) = native_failure { *native_failure = returned_native_failure; }
    }
    let mut solved = solved?;
    crate::antenna_operation_progress::notify(observer, AntennaOperationProgress {
        phase: AntennaOperationPhase::ValidatingResult,
        completed_targets: input.field_sampling.positions_xyz_m.len() as u64,
        total_targets: input.field_sampling.positions_xyz_m.len() as u64,
        source_cells: input.source_mesh.cell_count() as u64, elapsed_seconds: 0.0,
    });
    let accepted = solved.prepared_closed_loop_source_snapshot.take().ok_or_else(|| invalid("native accepted prepared source absent"))?;
    use super::closed_loop_field_evidence::{ClosedLoopFieldSnapshot, ClosedLoopFieldEvidence};
    let (field_snapshot, resolved_field_policy) = match input.stage.oersted_realization {
        fullmag_ir::AntennaOerstedRealizationIR::DirectTetraQuadrature => {
            if input.surface_field_policy.is_some() || input.stage.surface_field_policy.is_some()
                || solved.oersted_surface_snapshot.is_some() {
                return Err(invalid("mixed direct/surface native output or intent"));
            }
            let direct = solved.oersted_quadrature_snapshot.take().ok_or_else(|| invalid("native direct H evidence absent"))?;
            let budget = fullmag_ir::antenna_closed_loop_direct_budget(&input.stage.solver_policy)
                .ok_or_else(|| invalid("unknown closed-loop direct work policy"))?;
            let policy = input.direct_field_policy.as_ref().ok_or_else(||invalid("direct policy absent"))?;
            if policy.policy_version != budget.policy_version
                || direct.maximum_kernel_evaluations != budget.maximum_kernel_evaluations
                || direct.maximum_ledger_leaf_visits != budget.maximum_ledger_leaf_visits
                || direct.base_quadrature_order != policy.base_quadrature_order
                || direct.maximum_subdivision_depth != policy.maximum_subdivision_depth
                || direct.absolute_tolerance_apm != policy.absolute_tolerance_apm || direct.relative_tolerance != policy.relative_tolerance
                || direct.maximum_source_target_pairs != policy.maximum_source_target_pairs
                || direct.source_target_pairs != policy.source_target_pairs || direct.relative_scale_floor_apm != policy.relative_scale_floor_apm {
                return Err(invalid("native direct field evidence differs from selected policy"));
            }
            (ClosedLoopFieldSnapshot::Direct(direct),json!({"policy_version":budget.policy_version,
                "maximum_source_target_pairs":budget.maximum_source_target_pairs,
                "maximum_kernel_evaluations":budget.maximum_kernel_evaluations,
                "maximum_ledger_leaf_visits":budget.maximum_ledger_leaf_visits}))
        },
        fullmag_ir::AntennaOerstedRealizationIR::AnalyticRt0Surface => {
            if input.direct_field_policy.is_some() || solved.oersted_quadrature_snapshot.is_some() {
                return Err(invalid("mixed surface/direct native output or intent"));
            }
            let policy=input.surface_field_policy.as_ref().ok_or_else(||invalid("surface policy absent"))?;
            if input.stage.surface_field_policy.as_ref()!=Some(policy)
                || !policy.validation_errors("surface_field_policy").is_empty() {
                return Err(invalid("surface stage and resolved policy differ or are invalid"));
            }
            let snapshot=solved.oersted_surface_snapshot.take().ok_or_else(||invalid("native surface H evidence absent"))?;
            let expected=serde_json::to_value(policy).map_err(|_|invalid("surface policy serialization"))?;
            if snapshot.policy_binding()!=expected { return Err(invalid("native surface policy differs")); }
            (ClosedLoopFieldSnapshot::Surface(snapshot),expected)
        },
        _=>return Err(invalid("unsupported prepared field method")),
    };
    let raw = accepted.source;
    let mut requested_intent = json!({"source_revision":input.source.revision,"object_id":input.source.object_id,
        "geometry_id":input.source.geometry_id,"source_module_id":binding.source_module_id,
        "mesh_digest":input.source.mesh_digest,"authored_input_digest":input.source.authored_input_digest,
        "materials_digest":input.source.materials_digest,"solver_policy":input.stage.solver_policy,"requested_execution":input.authored_input_preimage.get("requested_execution").ok_or_else(|| invalid("requested authoring execution absent"))?});
    let mut resolved_execution = json!({"mesh_revision":binding.mesh_revision,"topology_revision":binding.topology_revision,
        "envelope_revision":binding.envelope_revision,"envelope_digest":binding.envelope_digest,
        "stable_vertex_id_version":"stable_mesh_vertex_u64.v1","stage_identity":binding.stage_identity.to_string(),
        "evaluation_time_s":binding.evaluation_time_s,"evaluated_envelope_multiplier":binding.evaluated_envelope_multiplier,
        "execution_lane":1,"charge_gauge":2,"maximum_iterations":request.maximum_iterations,
        "charge_relative_tolerance":request.relative_tolerance,"charge_absolute_tolerance":request.absolute_tolerance,
        "algebraic_relative_tolerance":input.algebraic_relative_tolerance,"physical_relative_gate":input.physical_relative_gate,
        "physical_absolute_gate_a":input.physical_absolute_gate_a,
        "direct_field_policy":resolved_field_policy});
    if input.stage.oersted_realization == fullmag_ir::AntennaOerstedRealizationIR::AnalyticRt0Surface {
        requested_intent["oersted_realization"]=json!("analytic_rt0_surface");
        requested_intent["surface_field_policy"]=resolved_field_policy.clone();
        resolved_execution.as_object_mut().ok_or_else(||invalid("resolved provenance shape"))?.remove("direct_field_policy");
        resolved_execution["surface_field_policy"]=resolved_field_policy;
    }
    let current_signature = format!("sha256:{}",accepted.accepted_source_state_digest);
    let sample_carrier = super::AntennaSampleCarrier {domain:input.field_sampling.domain.clone(),
        carrier_kind:input.field_sampling.carrier_kind.clone(),location:input.field_sampling.location.clone(),
        topology_digest:input.field_sampling.topology_digest.clone()};
    let sample_cells = input.field_sampling.cells.require_tet4()
        .map_err(|reason| invalid(&reason))?;
    let source = ClosedLoopAcceptedSourceInputV2 {
        metadata:ClosedLoopSourceMetadataV2 {
            prepared_execution_digest:accepted.prepared_execution_digest,
            accepted_charge_field_digest:accepted.accepted_charge_field_digest,
            accepted_source_state_digest:accepted.accepted_source_state_digest,
            view_identity_digest:solved.view_identity_digest,current_balance_certificate_digest:solved.balance_certificate_digest,
            digest_encoding:accepted.digest_encoding,periodic_operator_version:raw.periodic_operator_version,
            closure_operator_version:raw.closure_operator_version,conservative_current_operator_version:solved.operator_version,
            weak_reaction_ledger_version:raw.weak_reaction_ledger_version,sampling_policy:raw.sampling_policy.into(),
            source_current_orientation:raw.source_current_orientation.into(),source_current_a:raw.source_current_a,
            source_absolute_flux_a:raw.source_absolute_flux_a,potential_jump_v:match &input.source.closure {
                fullmag_ir::ConservativeCurrentClosureIR::ClosedGeometry{source_cuts,..}=>source_cuts[0].potential_drop_v,
                _=>return Err(invalid("closed source cut absent"))},measured_potential_jump_v:raw.potential_jump_v,
            gauge_mean_v:raw.gauge_mean_v,charge_relative_residual:raw.charge_relative_residual,
            max_paired_weak_flux_mismatch_a:raw.max_paired_weak_flux_mismatch_a,
            terminal_observation_currents:accepted.terminal_observation_currents.into_iter().map(|o|(o.id,o.current_a)).collect(),
        },stable_vertex_ids:solved.charge_potential_snapshot.stable_vertex_ids,
        vertex_xyz_m:solved.charge_potential_snapshot.vertex_positions_xyz_m,
        electric_potential_v:solved.charge_potential_snapshot.electric_potential_v,
        conductivity_spm:input.conductivity_spm_per_element.clone(),
        cells:raw.cells.into_iter().map(|c|ClosedLoopCurrentCellV2 {source_element_index:c.source_element_index,
            vertex_ids:c.vertex_ids,vertex_xyz_m:c.vertex_xyz_m,vertex_current_xyz_apm2:c.vertex_current_xyz_apm2,
            center_xyz_m:c.center_xyz_m,center_current_xyz_apm2:c.center_current_xyz_apm2}).collect(),
        canonical_face_records:solved.canonical_face_records,
        paired_weak_reactions:raw.paired_weak_reactions.into_iter().map(|r|ClosedLoopWeakReactionV2 {
            minus_vertex_id:r.minus_vertex_id,plus_vertex_id:r.plus_vertex_id,
            minus_reaction_a:r.minus_reaction_a,plus_reaction_a:r.plus_reaction_a}).collect(),
        prepared_execution_preimage:accepted.prepared_execution_preimage,
        accepted_charge_field_preimage:accepted.accepted_charge_field_preimage,
        accepted_source_state_preimage:accepted.accepted_source_state_preimage,
        canonical_balance_certificate:accepted.canonical_balance_certificate,
        authored_input_json:serde_json::to_vec(&input.authored_input_preimage).map_err(|_| invalid("authored input serialization"))?,
    };
    let retained_evidence=ClosedLoopFieldEvidence::new(field_snapshot.clone(),&source.metadata)?;
    retained_evidence.verify_policy_binding(&requested_intent,&resolved_execution)?;
    retained_evidence.verify_source_binding(&source.metadata,source.cells.len(),input.field_sampling.positions_xyz_m.len())?;
    let field_signature=super::closed_loop_v2::field_signature(&source.metadata.accepted_source_state_digest,
        &sample_carrier,&input.field_sampling.positions_xyz_m,&sample_cells,&retained_evidence)?;
    let artifacts = super::closed_loop_v2::build(&ClosedLoopFieldSolutionInputV2 {
        asset_id:format!("closed-loop-{}",output_id),solution_id:output_id.into(),
        source_object_id:input.source.object_id.clone(),current_transport_id:input.stage.current_transport_id.clone(),
        stage_id:input.stage.id.clone(),port_mode_id:input.port.id.clone(),requested_intent,resolved_execution,
        full_closure:serde_json::to_value(&input.source.closure).map_err(|_| invalid("closure serialization"))?,
        signatures:super::AntennaFieldSolutionSignatures {current_solution_signature:current_signature,
            field_solution_signature:field_signature,target_projection_signatures:Default::default(),dependency_signatures:None},
        source,sample_carrier,sample_cells,
        sample_positions_xyz_m:input.field_sampling.positions_xyz_m.clone(),field_snapshot,
    })?;
    check_cancelled(cancelled)?;
    Ok(artifacts)
}

#[cfg(not(feature = "fem-gpu"))]
fn execute_native(_input: &ResolvedAntennaClosedLoopCurrentInputIR, _output_id: &str,
    cancelled: Option<&AtomicBool>, _native_failure: Option<&mut Option<KnownNativeCallFailure>>,
    _native_profile: Option<&mut NativeFemSurfaceRt0Profile>,
    _observer: Option<&AntennaOperationProgressObserver<'_>>) -> Result<Vec<AuxiliaryArtifact>, RunError> {
    check_cancelled(cancelled)?;
    Err(invalid("native FEM prepared source feature unavailable; no fallback"))
}

#[cfg(test)]
mod native_failure_tests {
    use super::*;

    #[test]
    fn controlled_return_preserves_diagnostic_and_other_errors_stay_opaque() {
        let error = classify_execution_error(RunError { message: "native diagnostic".into() },
            known_native_call_failure(-3));
        assert!(matches!(error, ClosedLoopExecutionError::NativeCallFailed {
            status: KnownNativeCallFailure::Internal, ref message
        } if message == "native diagnostic"));
        for status in [0, -4, -5, 1, i32::MIN] {
            let error = classify_execution_error(RunError { message: "opaque".into() }, known_native_call_failure(status));
            assert!(matches!(error, ClosedLoopExecutionError::Other(ref error) if error.message == "opaque"));
        }
        let validation = classify_execution_error(invalid("snapshot validation"), None);
        assert!(matches!(validation, ClosedLoopExecutionError::Other(_)));
    }
}
