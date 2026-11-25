//! H-only children of complete verified v2 content; durable owner admission belongs to runtime.
mod retained_direct_execution;
pub use retained_direct_execution::{ProducedRetainedDirectField, verify_retained_direct_field_for_publication, execute_retained_direct_field_inspection_observed_typed};
use super::{AntennaSampleCarrier, closed_loop_v2::{self, invalid, ClosedLoopAcceptedSourceInputV2},
    surface_rt0_evidence_v1::{SurfaceRt0EvidenceV1, SurfaceRt0Snapshot}};
use crate::{types::{AuxiliaryArtifact, RunError}, AntennaOperationProgressObserver};
use crate::solver_profile::{SolverProfileConfig, SolverProfileOperationOutcome, SolverProfileState};
#[cfg(feature = "fem-gpu")]
use crate::native_fem::NativeFemSurfaceRt0Profile;
#[cfg(not(feature = "fem-gpu"))]
#[derive(Default)]
struct NativeFemSurfaceRt0Profile {
    available: bool, accounting_issue: bool, operator_wall_time_ns: u64,
    native_call_wall_ns: Option<u64>, phase_wall_time_ns: [u64; 9],
}
use fullmag_antenna_artifacts::retained_current::*;
use fullmag_ir::{AntennaFieldSamplingPlanIR, AntennaFieldSolveStageIR,
    AntennaRetainedPreparationFieldPlanIR, BackendTarget, ConservativeCurrentSourceIR, CurrentModuleIR,
    ExecutionDevice, ExecutionMode, ExecutionPrecision, RequestedTransportExecutionIR};
use serde_json::Value;
use std::{collections::BTreeMap, sync::atomic::{AtomicBool, Ordering}};

/// Content verification is not a substitute for load_saved_inspection's durable owner proof.
/// Private fields prevent construction from caller-authored accepted-source labels.
pub struct VerifiedRetainedCurrentParentContent {
    parent: RetainedCurrentParent,
    source: ClosedLoopAcceptedSourceInputV2,
    source_object_id: String,
    current_transport_id: String,
    port_mode_id: String,
}

impl VerifiedRetainedCurrentParentContent {
    /// Count from the already decoded and authenticated original source; no new physical read.
    pub fn source_cell_count(&self) -> u64 { self.source.cells.len() as u64 }

    pub fn validate_source_intent(&self, problem: &fullmag_ir::ProblemIR, stage: &AntennaFieldSolveStageIR)
        -> Result<(), RunError> {
        validate_verified_source_intent(&self.source, &self.source_object_id, &self.current_transport_id,
            &self.port_mode_id, problem, stage)
    }
}

/// Full immutable source content, without durable store authority or a parent capsule.
/// Private fields keep decoded source metadata and its authored preimage inseparable.
pub struct VerifiedRetainedCurrentSourceContent {
    source: ClosedLoopAcceptedSourceInputV2,
    native_stage_id: String,
    source_object_id: String,
    current_transport_id: String,
    port_mode_id: String,
}

impl VerifiedRetainedCurrentSourceContent {
    pub fn validate_source_intent(&self, problem: &fullmag_ir::ProblemIR, stage: &AntennaFieldSolveStageIR)
        -> Result<(), RunError> {
        validate_verified_source_intent(&self.source, &self.source_object_id, &self.current_transport_id,
            &self.port_mode_id, problem, stage)
    }

    pub fn authored_input_json(&self) -> &[u8] { &self.source.authored_input_json }

    pub fn source_digests(&self) -> ParentCurrentDigests {
        let metadata = &self.source.metadata;
        ParentCurrentDigests {
            prepared_execution_digest: format!("sha256:{}", metadata.prepared_execution_digest),
            accepted_charge_field_digest: format!("sha256:{}", metadata.accepted_charge_field_digest),
            accepted_source_state_digest: format!("sha256:{}", metadata.accepted_source_state_digest),
            view_identity_digest: format!("sha256:{}", metadata.view_identity_digest),
            current_balance_certificate_digest: format!("sha256:{}", metadata.current_balance_certificate_digest),
        }
    }

    /// No repeated physical verification: bind already verified content to exact evidence bytes.
    /// The runtime must still establish the durable owner and portable evidence closure.
    pub fn bind_parent(self, parent: &RetainedCurrentParent, capsule_bytes: &[u8])
        -> Result<VerifiedRetainedCurrentParentContent, RunError> {
        artifact(validate_parent_evidence_bytes(parent, capsule_bytes))?;
        if self.native_stage_id != parent.owner.native_stage_id {
            return Err(invalid("retained parent native stage differs"));
        }
        bind_source_digests(parent, &self.source)?;
        Ok(VerifiedRetainedCurrentParentContent { parent: parent.clone(), source: self.source,
            source_object_id: self.source_object_id, current_transport_id: self.current_transport_id,
            port_mode_id: self.port_mode_id })
    }
}

/// Exactly one full original v2 verifier, with the same budget and stage/output/port fences.
/// This validates content only; canonical saved-inspection admission supplies owner authority.
pub fn verify_retained_current_source_content(
    manifest_bytes: &[u8], artifacts: &[AuxiliaryArtifact], stage_id: &str, output_id: &str,
    port_mode_id: &str, content_digest: &str, max_bytes: usize,
) -> Result<VerifiedRetainedCurrentSourceContent, RunError> {
    let manifest = super::closed_loop_public_inspection::validate_inspection_envelope(
        manifest_bytes, artifacts, stage_id, output_id, port_mode_id, content_digest, max_bytes)?;
    let source = closed_loop_v2::verify_and_decode_source(manifest_bytes, artifacts, true)?;
    validate_parent_field_realization(&manifest)?;
    let text = |key: &str| manifest[key].as_str().filter(|s| !s.is_empty())
        .map(str::to_owned).ok_or_else(|| invalid("verified parent selector missing"));
    Ok(VerifiedRetainedCurrentSourceContent { source, native_stage_id: stage_id.to_owned(),
        source_object_id: text("source_object_id")?, current_transport_id: text("current_transport_id")?,
        port_mode_id: port_mode_id.to_owned() })
}

/// Compatibility content entry point; durable owner admission remains mandatory at runtime.
pub fn verify_retained_current_parent_content(
    manifest_bytes: &[u8], artifacts: &[AuxiliaryArtifact], parent: &RetainedCurrentParent,
    capsule_bytes: &[u8],
) -> Result<VerifiedRetainedCurrentParentContent, RunError> {
    artifact(validate_parent_evidence_bytes(parent, capsule_bytes))?;
    // Bound before the temporary identity read. The shared envelope and original verifier
    // reject duplicate JSON and authenticate every selector against the complete payloads.
    if manifest_bytes.is_empty() || manifest_bytes.len() > super::ANTENNA_FIELD_MANIFEST_MAX_BYTES {
        return Err(invalid("retained parent manifest byte bound"));
    }
    let manifest: Value = serde_json::from_slice(manifest_bytes).map_err(|_| invalid("verified parent JSON"))?;
    let text = |key: &str| manifest[key].as_str().ok_or_else(|| invalid("verified parent selector missing"));
    verify_retained_current_source_content(manifest_bytes, artifacts, &parent.owner.native_stage_id,
        text("solution_id")?, text("port_mode_id")?, text("content_digest")?, MAX_PACKAGE_BYTES as usize)?
        .bind_parent(parent, capsule_bytes)
}

pub struct ProducedRetainedCurrentField {
    pub manifest: RetainedCurrentFieldManifest,
    pub payloads: BTreeMap<String, Vec<u8>>,
}

#[derive(Clone, Copy)]
enum RetainedFieldContract { Current, PreparationAsset }

fn require_retained_field_contract(stage: &AntennaFieldSolveStageIR, contract: RetainedFieldContract)
    -> Result<(), RunError> {
    if stage.retained_source_preparation.is_some() != matches!(contract, RetainedFieldContract::PreparationAsset) {
        return Err(invalid("retained field requires its exact source-preparation contract; v1 cannot execute an asset"));
    }
    Ok(())
}

fn canonical_retained_field_facts(
    problem: &fullmag_ir::ProblemIR, stage: &AntennaFieldSolveStageIR, contract: RetainedFieldContract,
) -> Result<(AntennaFieldSamplingPlanIR, RequestedTransportExecutionIR), RunError> {
    require_retained_field_contract(stage, contract)?;
    let [port] = stage.port_mode_ids.as_slice() else { return Err(invalid("retained field port is not unique")); };
    let [output] = stage.outputs.as_slice() else { return Err(invalid("retained field output is not unique")); };
    let (actual_stage, sampling, execution) = match contract {
        RetainedFieldContract::Current => {
            let plan = fullmag_plan::validate_retained_current_field_operation(problem, &stage.id, port, &output.id)
                .map_err(|error| invalid(&format!("retained canonical operation differs: {error}")))?;
            (plan.stage, plan.field_sampling, plan.requested_execution)
        }
        RetainedFieldContract::PreparationAsset => {
            let plan = fullmag_plan::validate_retained_preparation_field_operation(problem, &stage.id, port, &output.id)
                .map_err(|error| invalid(&format!("retained preparation canonical operation differs: {error}")))?;
            (plan.stage, plan.field_sampling, plan.requested_execution)
        }
    };
    if actual_stage != *stage { return Err(invalid("retained field stage differs from its canonical operation")); }
    Ok((sampling, execution))
}

fn validate_retained_preparation_plan(problem: &fullmag_ir::ProblemIR, plan: &AntennaRetainedPreparationFieldPlanIR)
    -> Result<(), RunError> {
    require_retained_field_contract(&plan.stage, RetainedFieldContract::PreparationAsset)?;
    let [port] = plan.stage.port_mode_ids.as_slice() else { return Err(invalid("retained preparation port is not unique")); };
    let [output] = plan.stage.outputs.as_slice() else { return Err(invalid("retained preparation output is not unique")); };
    let canonical = fullmag_plan::validate_retained_preparation_field_operation(problem, &plan.stage.id, port, &output.id)
        .map_err(|error| invalid(&format!("retained preparation canonical operation differs: {error}")))?;
    if &canonical != plan { return Err(invalid("retained preparation plan facts differ from canonical lowering")); }
    Ok(())
}

/// The prepared asset is input evidence only; the opaque verified current remains mandatory.
pub fn execute_retained_preparation_field_inspection(
    problem: &fullmag_ir::ProblemIR, parent: &VerifiedRetainedCurrentParentContent,
    plan: &AntennaRetainedPreparationFieldPlanIR, capsule_bytes: &[u8], cancelled: Option<&AtomicBool>,
    observer: Option<&AntennaOperationProgressObserver<'_>>,
) -> Result<ProducedRetainedCurrentField, RunError> {
    check_cancelled(cancelled)?;
    validate_retained_preparation_plan(problem, plan)?;
    execute_retained_current_field_inspection_inner(problem, parent, &plan.stage, &plan.field_sampling,
        &plan.requested_execution, RetainedFieldContract::PreparationAsset, capsule_bytes, cancelled, None, observer)
}

/// Same field operator and profiler as v1, through the separate canonical asset contract.
pub fn execute_retained_preparation_field_inspection_observed_typed(
    problem: &fullmag_ir::ProblemIR, parent: &VerifiedRetainedCurrentParentContent,
    plan: &AntennaRetainedPreparationFieldPlanIR, capsule_bytes: &[u8], cancelled: Option<&AtomicBool>,
    config: Option<&SolverProfileConfig>, profile: &mut SolverProfileState,
    observer: Option<&AntennaOperationProgressObserver<'_>>,
) -> Result<ProducedRetainedCurrentField, RunError> {
    check_cancelled(cancelled)?;
    validate_retained_preparation_plan(problem, plan)?;
    execute_retained_field_inspection_observed(problem, parent, &plan.stage, &plan.field_sampling,
        &plan.requested_execution, RetainedFieldContract::PreparationAsset, capsule_bytes, cancelled, config, profile, observer)
}

/// No charge path exists here. Unsupported native builds return an explicit error.
/// The caller owns admission, immutable parent proof, cancellation and output publication.
pub fn execute_retained_current_field_inspection(
    problem: &fullmag_ir::ProblemIR, parent: &VerifiedRetainedCurrentParentContent, stage: &AntennaFieldSolveStageIR,
    sampling: &AntennaFieldSamplingPlanIR, execution: &RequestedTransportExecutionIR,
    capsule_bytes: &[u8], cancelled: Option<&AtomicBool>,
    observer: Option<&AntennaOperationProgressObserver<'_>>,
) -> Result<ProducedRetainedCurrentField, RunError> {
    execute_retained_current_field_inspection_inner(problem, parent, stage, sampling, execution,
        RetainedFieldContract::Current, capsule_bytes, cancelled, None, observer)
}

/// Observe/profile only the H evaluation; no physical time step or transport solve is created.
pub fn execute_retained_current_field_inspection_observed_typed(
    problem: &fullmag_ir::ProblemIR, parent: &VerifiedRetainedCurrentParentContent, stage: &AntennaFieldSolveStageIR,
    sampling: &AntennaFieldSamplingPlanIR, execution: &RequestedTransportExecutionIR,
    capsule_bytes: &[u8], cancelled: Option<&AtomicBool>, config: Option<&SolverProfileConfig>,
    profile: &mut SolverProfileState, observer: Option<&AntennaOperationProgressObserver<'_>>,
) -> Result<ProducedRetainedCurrentField, RunError> {
    execute_retained_field_inspection_observed(problem, parent, stage, sampling, execution,
        RetainedFieldContract::Current, capsule_bytes, cancelled, config, profile, observer)
}

fn execute_retained_field_inspection_observed(
    problem: &fullmag_ir::ProblemIR, parent: &VerifiedRetainedCurrentParentContent, stage: &AntennaFieldSolveStageIR,
    sampling: &AntennaFieldSamplingPlanIR, execution: &RequestedTransportExecutionIR, contract: RetainedFieldContract,
    capsule_bytes: &[u8], cancelled: Option<&AtomicBool>, config: Option<&SolverProfileConfig>,
    profile: &mut SolverProfileState, observer: Option<&AntennaOperationProgressObserver<'_>>,
) -> Result<ProducedRetainedCurrentField, RunError> {
    require_retained_field_contract(stage, contract)?;
    let enabled = config.filter(|config| config.enabled);
    if enabled.is_none() && observer.is_none() {
        return execute_retained_current_field_inspection_inner(problem, parent, stage, sampling, execution,
            contract, capsule_bytes, cancelled, None, None);
    }
    let started = std::time::Instant::now();
    let observe = |progress: crate::AntennaOperationProgress| {
        forward_field_progress(observer, progress, started.elapsed().as_secs_f64());
    };
    let observed: Option<&AntennaOperationProgressObserver<'_>> = observer.map(|_| &observe as _);
    crate::antenna_operation_progress::notify(observed, crate::AntennaOperationProgress {
        phase: crate::AntennaOperationPhase::EvaluatingField, completed_targets: 0,
        total_targets: sampling.positions_xyz_m.len() as u64, source_cells: parent.source_cell_count(),
        elapsed_seconds: 0.0,
    });
    let Some(config) = enabled else {
        return execute_retained_current_field_inspection_inner(problem, parent, stage, sampling, execution,
            contract, capsule_bytes, cancelled, None, observed);
    };
    let config = config.clone().normalized();
    if profile.config() != &config { profile.set_config(config); }
    let mut native = NativeFemSurfaceRt0Profile::default();
    let result = execute_retained_current_field_inspection_inner(problem, parent, stage, sampling, execution,
        contract, capsule_bytes, cancelled, Some(&mut native), observed);
    let outcome = if result.is_ok() { SolverProfileOperationOutcome::Completed }
        else if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) { SolverProfileOperationOutcome::Cancelled }
        else { SolverProfileOperationOutcome::Failed };
    let mut phases = [0; 8];
    let operator_ns = if native.available {
        phases.copy_from_slice(&native.phase_wall_time_ns[..8]); Some(native.operator_wall_time_ns)
    } else { None };
    profile.record_antenna_operation(outcome,
        started.elapsed().as_nanos().min(u128::from(u64::MAX)) as u64,
        operator_ns, native.native_call_wall_ns, phases, native.accounting_issue);
    result
}

// Frozen source setup uses the older ABI vocabulary, not a new transport solve.
fn forward_field_progress(
    observer: Option<&AntennaOperationProgressObserver<'_>>,
    mut progress: crate::AntennaOperationProgress, elapsed_seconds: f64,
) {
    if matches!(progress.phase, crate::AntennaOperationPhase::PreparingSource
        | crate::AntennaOperationPhase::SolvingPotential
        | crate::AntennaOperationPhase::ReconstructingCurrent) { return; }
    progress.elapsed_seconds = elapsed_seconds;
    crate::antenna_operation_progress::notify(observer, progress);
}

fn execute_retained_current_field_inspection_inner(
    problem: &fullmag_ir::ProblemIR, parent: &VerifiedRetainedCurrentParentContent, stage: &AntennaFieldSolveStageIR,
    sampling: &AntennaFieldSamplingPlanIR, execution: &RequestedTransportExecutionIR, contract: RetainedFieldContract,
    capsule_bytes: &[u8], cancelled: Option<&AtomicBool>,
    native_profile: Option<&mut NativeFemSurfaceRt0Profile>,
    observer: Option<&AntennaOperationProgressObserver<'_>>,
) -> Result<ProducedRetainedCurrentField, RunError> {
    check_cancelled(cancelled)?;
    let (canonical_sampling, canonical_execution) = canonical_retained_field_facts(problem, stage, contract)?;
    if &canonical_sampling != sampling || &canonical_execution != execution {
        return Err(invalid("retained field sampling or execution facts differ from canonical lowering"));
    }
    artifact(validate_parent_evidence_bytes(&parent.parent, capsule_bytes))?;
    let policy = stage.surface_field_policy.as_ref().ok_or_else(|| invalid("explicit retained surface policy absent"))?;
    let retained = stage.retained_current_source.as_ref().ok_or_else(|| invalid("typed retained source absent"))?;
    if !parent.parent.owner.matches_source(retained)
        || stage.conservative_current_view_ref.is_some()
        || stage.source_object_id != parent.source_object_id
        || stage.current_transport_id != parent.current_transport_id
        || stage.port_mode_ids != [parent.port_mode_id.clone()]
        || stage.oersted_realization != fullmag_ir::AntennaOerstedRealizationIR::AnalyticRt0Surface
        || stage.model != fullmag_ir::AntennaFieldModelIR::QuasistaticConductionBiotSavart3d
        || stage.field_sampling_domain != sampling.domain
        || stage.outputs.len() != 1 || stage.outputs[0].quantity != "H_ant_basis"
        || !policy.validation_errors("surface_field_policy").is_empty()
        || execution.discretization != BackendTarget::Fem || execution.device != ExecutionDevice::Cpu
        || execution.precision != ExecutionPrecision::Double || execution.execution_mode != ExecutionMode::Strict {
        return Err(invalid("retained child source/port/sampling/operator/execution mismatch"));
    }
    parent.validate_source_intent(problem, stage)?;
    let cells = sampling.cells.require_tet4().map_err(|_| invalid("retained sampling requires Tet4"))?;
    let carrier = AntennaSampleCarrier {domain:sampling.domain.clone(), carrier_kind:sampling.carrier_kind.clone(),
        location:sampling.location.clone(), topology_digest:sampling.topology_digest.clone()};
    closed_loop_v2::validate_sampling_mesh(&carrier, &sampling.positions_xyz_m, &cells)?;
    // Refuse metadata and mandatory work before the native wrapper allocates its buffers.
    let pairs = (parent.source.cells.len() as u64).checked_mul(sampling.positions_xyz_m.len() as u64)
        .ok_or_else(|| invalid("retained pair overflow"))?;
    if pairs > policy.limits.total[0] || parent.source.cells.len() as u64 > policy.limits.per_target[0] {
        return Err(invalid("retained field exceeds explicit pair policy"));
    }
    let payload_bound = (sampling.positions_xyz_m.len() as u64).checked_mul(48)
        .and_then(|n| (cells.len() as u64).checked_mul(16).and_then(|c| n.checked_add(c)))
        .and_then(|n| n.checked_add(policy.limits.total[9])).and_then(|n| n.checked_add(176))
        .ok_or_else(|| invalid("retained payload aggregate overflow"))?;
    if payload_bound > MAX_PACKAGE_BYTES { return Err(invalid("retained payload capacity exceeds package bound")); }
    let snapshot = evaluate(parent, &sampling.positions_xyz_m, policy, native_profile, observer)?;
    check_cancelled(cancelled)?;
    let evidence = SurfaceRt0EvidenceV1::new(snapshot, parent.source.metadata.source_current_a,
        parent.source.metadata.source_absolute_flux_a, parent.source.metadata.current_balance_certificate_digest.clone())?;
    evidence.verify_source_binding(&parent.source.metadata.view_identity_digest,
        &parent.source.metadata.accepted_source_state_digest)?;
    evidence.verify_policy_binding(&serde_json::to_value(policy).map_err(|_| invalid("retained policy JSON"))?)?;
    let mut payloads = BTreeMap::new();
    payloads.insert("sample_xyz".into(), f64_bytes(sampling.positions_xyz_m.iter().flatten().copied())?);
    let mut topology = Vec::new();
    topology.try_reserve_exact(cells.len().checked_mul(16).ok_or_else(|| invalid("sampling topology overflow"))?)
        .map_err(|_| invalid("sampling topology allocation"))?;
    for index in cells.iter().flatten() { topology.extend_from_slice(&index.to_le_bytes()); }
    payloads.insert("sample_cells".into(), topology);
    payloads.insert("h_raw".into(), f64_bytes(evidence.snapshot.targets.iter().flat_map(|row| row.h_xyz_apm))?);
    payloads.insert("evidence".into(), evidence.encode()?);
    let reference = |key: &str, layout: &str, unit: &str| -> Result<RetainedCurrentPayloadRef, RunError> {
        let bytes = payloads.get(key).ok_or_else(|| invalid("retained payload absent"))?;
        Ok(RetainedCurrentPayloadRef {sha256:super::sha256(bytes), byte_count:bytes.len() as u64,
            layout:layout.into(), unit:unit.into()})
    };
    let mut manifest = RetainedCurrentFieldManifest {schema_version:RETAINED_CURRENT_FIELD_SCHEMA.into(),
        status:"inspection_only".into(), qualification:"not_verified".into(), content_digest:String::new(),
        stage_id:stage.id.clone(), output_id:stage.outputs[0].id.clone(), port_mode_id:parent.port_mode_id.clone(),
        source_object_id:parent.source_object_id.clone(), current_transport_id:parent.current_transport_id.clone(),
        parent:parent.parent.clone(), sample_carrier:carrier, source_vertex_count:parent.source.vertex_xyz_m.len() as u64,
        source_cell_count:parent.source.cells.len() as u64, target_count:sampling.positions_xyz_m.len() as u64,
        sample_cell_count:cells.len() as u64, requested_intent:stage.clone(),
        resolved_execution:RetainedCurrentResolvedExecution {requested_execution:execution.clone(), execution:execution.clone(),
            operator_version:RETAINED_CURRENT_OPERATOR.into(), basis_version:RETAINED_CURRENT_BASIS.into(),
            evidence_schema:RETAINED_CURRENT_EVIDENCE_SCHEMA.into()}, field_policy:policy.clone(),
        payloads:RetainedCurrentPayloads {sample_xyz:reference("sample_xyz","sample_xyz_f64_le","m")?,
            sample_cells:reference("sample_cells","tet4_u32_le","1")?,
            h_raw:reference("h_raw","sample_xyz_f64_le","A/m")?,
            evidence:reference("evidence",RETAINED_CURRENT_EVIDENCE_SCHEMA,"1")?} };
    manifest.content_digest = artifact(manifest.expected_content_digest())?;
    artifact(validate_payloads(&manifest, &payloads))?;
    Ok(ProducedRetainedCurrentField {manifest,payloads})
}

/// Application calls this after its canonical bundle encoder establishes the external CAS.
/// Raw capsule pinning precedes graph inspection. No new framing or CAS authority is minted.
pub fn verify_retained_current_field_for_publication(
    problem: &fullmag_ir::ProblemIR, produced: &ProducedRetainedCurrentField, parent: &VerifiedRetainedCurrentParentContent,
    capsule_bytes: &[u8], child_package_object_ref: &str,
) -> Result<(), RunError> {
    require_retained_field_contract(&produced.manifest.requested_intent, RetainedFieldContract::Current)?;
    verify_retained_field_for_publication_inner(problem, produced, parent, capsule_bytes,
        child_package_object_ref, RetainedFieldContract::Current)
}

/// Separate asset publication contract; the output codec and physical verifier remain shared.
pub fn verify_retained_preparation_field_for_publication(
    problem: &fullmag_ir::ProblemIR, produced: &ProducedRetainedCurrentField, parent: &VerifiedRetainedCurrentParentContent,
    capsule_bytes: &[u8], child_package_object_ref: &str,
) -> Result<(), RunError> {
    require_retained_field_contract(&produced.manifest.requested_intent, RetainedFieldContract::PreparationAsset)?;
    verify_retained_field_for_publication_inner(problem, produced, parent, capsule_bytes,
        child_package_object_ref, RetainedFieldContract::PreparationAsset)
}

fn verify_retained_field_for_publication_inner(
    problem: &fullmag_ir::ProblemIR, produced: &ProducedRetainedCurrentField, parent: &VerifiedRetainedCurrentParentContent,
    capsule_bytes: &[u8], child_package_object_ref: &str, contract: RetainedFieldContract,
) -> Result<(), RunError> {
    let (sampling, execution) = canonical_retained_field_facts(problem, &produced.manifest.requested_intent, contract)?;
    artifact(validate_payloads(&produced.manifest, &produced.payloads))?;
    if produced.manifest.resolved_execution.requested_execution != execution
        || produced.manifest.resolved_execution.execution != execution {
        return Err(invalid("retained publication execution differs from its canonical field operation"));
    }
    if produced.manifest.parent != parent.parent
        || produced.manifest.source_object_id != parent.source_object_id
        || produced.manifest.current_transport_id != parent.current_transport_id
        || produced.manifest.port_mode_id != parent.port_mode_id
        || produced.manifest.source_cell_count != parent.source.cells.len() as u64
        || produced.manifest.source_vertex_count != parent.source.vertex_xyz_m.len() as u64 {
        return Err(invalid("retained publication parent/count mismatch"));
    }
    parent.validate_source_intent(problem, &produced.manifest.requested_intent)?;
    artifact(validate_parent_evidence_bytes(&produced.manifest.parent, capsule_bytes))?;
    artifact(validate_no_child_cycle(child_package_object_ref, &produced.manifest, capsule_bytes))?;
    let evidence = SurfaceRt0EvidenceV1::decode(&produced.payloads["evidence"])?;
    evidence.verify_source_binding(&parent.source.metadata.view_identity_digest,
        &parent.source.metadata.accepted_source_state_digest)?;
    evidence.verify_policy_binding(&serde_json::to_value(&produced.manifest.field_policy)
        .map_err(|_| invalid("retained policy JSON"))?)?;
    if evidence.signed_normalization_a.to_bits() != parent.source.metadata.source_current_a.to_bits()
        || evidence.source_absolute_flux_a.to_bits() != parent.source.metadata.source_absolute_flux_a.to_bits()
        || evidence.current_balance_certificate_digest != parent.source.metadata.current_balance_certificate_digest {
        return Err(invalid("retained publication signed source normalization differs"));
    }
    let positions = xyz(&produced.payloads["sample_xyz"])?;
    let raw = xyz(&produced.payloads["h_raw"])?;
    let per_a = raw.iter().map(|v| v.map(|x| x * evidence.scale_per_a)).collect::<Vec<_>>();
    evidence.verify_binding(&positions, &raw, &per_a)?;
    let cells = produced.payloads["sample_cells"].chunks_exact(16).map(|row|
        std::array::from_fn(|i| u32::from_le_bytes(row[i*4..i*4+4].try_into().expect("four bytes"))))
        .collect::<Vec<[u32;4]>>();
    if produced.manifest.sample_carrier.domain != sampling.domain
        || produced.manifest.sample_carrier.carrier_kind != sampling.carrier_kind
        || produced.manifest.sample_carrier.location != sampling.location
        || produced.manifest.sample_carrier.topology_digest != sampling.topology_digest
        || positions != sampling.positions_xyz_m
        || cells != sampling.cells.require_tet4().map_err(|_| invalid("retained publication sampling requires Tet4"))? {
        return Err(invalid("retained publication sampling differs from its canonical target carrier"));
    }
    closed_loop_v2::validate_sampling_mesh(&produced.manifest.sample_carrier, &positions, &cells)
}

fn validate_verified_source_intent(
    source: &ClosedLoopAcceptedSourceInputV2, object_id: &str, module_id: &str, port_id: &str,
    problem: &fullmag_ir::ProblemIR, stage: &AntennaFieldSolveStageIR,
) -> Result<(), RunError> {
    if stage.source_object_id != object_id || stage.current_transport_id != module_id
        || stage.port_mode_ids != [port_id.to_owned()] {
        return Err(invalid("retained source object/module/port identity changed"));
    }
    let preimage: Value = serde_json::from_slice(&source.authored_input_json)
        .map_err(|_| invalid("verified source authored preimage is not JSON"))?;
    let definition = problem.current_modules.iter().find_map(|module| match module {
        CurrentModuleIR::CurrentTransport { name, definition: Some(definition), .. } if name == module_id => Some(definition),
        _ => None,
    }).ok_or_else(|| invalid("retained source current definition is absent"))?;
    let validation = match definition.conservative_current_source.as_ref() {
        Some(ConservativeCurrentSourceIR::ClosedGeometryPotentialJump(_)) => {
            require_retained_field_contract(stage, RetainedFieldContract::Current)?;
            fullmag_plan::validate_retained_current_authored_source(problem, stage, &preimage, &source.conductivity_spm)
        }
        Some(ConservativeCurrentSourceIR::RetainedPreparationAsset(_)) => {
            require_retained_field_contract(stage, RetainedFieldContract::PreparationAsset)?;
            fullmag_plan::validate_retained_preparation_authored_source(problem, stage, &preimage, &source.conductivity_spm)
        }
        _ => return Err(invalid("retained field source kind cannot authorize the verified current")),
    };
    validation.map_err(|error| invalid(&format!("retained source physics differs: {}", error.reasons.join("; "))))
}

fn bind_source_digests(parent: &RetainedCurrentParent, source: &ClosedLoopAcceptedSourceInputV2) -> Result<(), RunError> {
    for (expected, actual) in [
        (&parent.source.prepared_execution_digest,&source.metadata.prepared_execution_digest),
        (&parent.source.accepted_charge_field_digest,&source.metadata.accepted_charge_field_digest),
        (&parent.source.accepted_source_state_digest,&source.metadata.accepted_source_state_digest),
        (&parent.source.view_identity_digest,&source.metadata.view_identity_digest),
        (&parent.source.current_balance_certificate_digest,&source.metadata.current_balance_certificate_digest),
    ] {
        if expected != &format!("sha256:{actual}") { return Err(invalid("retained parent source digest mismatch")); }
    }
    closed_loop_v2::normalization_scale(source.metadata.source_current_a, source.metadata.source_absolute_flux_a)?;
    Ok(())
}
fn artifact<T>(result: Result<T, fullmag_antenna_artifacts::ArtifactError>) -> Result<T, RunError> {
    result.map_err(|e| invalid(&e.message))
}
fn check_cancelled(cancelled: Option<&AtomicBool>) -> Result<(), RunError> {
    if cancelled.is_some_and(|flag| flag.load(Ordering::Relaxed)) { return Err(invalid("retained field cancelled")); }
    Ok(())
}
fn f64_bytes(values: impl Iterator<Item=f64>) -> Result<Vec<u8>, RunError> {
    let mut bytes = Vec::new();
    for value in values {
        if !value.is_finite() || bytes.len() as u64 >= MAX_PACKAGE_BYTES - 8 {
            return Err(invalid("retained nonfinite or oversized numeric payload"));
        }
        bytes.try_reserve(8).map_err(|_| invalid("retained numeric allocation"))?;
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    Ok(bytes)
}
fn xyz(bytes: &[u8]) -> Result<Vec<[f64;3]>, RunError> {
    if bytes.is_empty() || bytes.len()%24 != 0 || bytes.len() as u64 > MAX_PACKAGE_BYTES {
        return Err(invalid("retained XYZ framing"));
    }
    let mut rows = Vec::new();
    rows.try_reserve_exact(bytes.len()/24).map_err(|_| invalid("retained XYZ allocation"))?;
    for row in bytes.chunks_exact(24) {
        rows.push(std::array::from_fn(|i| f64::from_le_bytes(row[i*8..i*8+8].try_into().expect("eight bytes"))));
    }
    Ok(rows)
}
#[cfg(feature="fem-gpu")]
fn evaluate(parent: &VerifiedRetainedCurrentParentContent, points: &[[f64;3]],
    policy: &fullmag_ir::AntennaSurfaceFieldPolicyIR, profile: Option<&mut NativeFemSurfaceRt0Profile>,
    observer: Option<&AntennaOperationProgressObserver<'_>>,
) -> Result<SurfaceRt0Snapshot, RunError> {
    crate::native_fem::evaluate_retained_rt0_surface(&parent.source, points, policy, profile, observer)
}
#[cfg(not(feature="fem-gpu"))]
fn evaluate(_parent: &VerifiedRetainedCurrentParentContent, _points: &[[f64;3]],
    _policy: &fullmag_ir::AntennaSurfaceFieldPolicyIR, _profile: Option<&mut NativeFemSurfaceRt0Profile>,
    _observer: Option<&AntennaOperationProgressObserver<'_>>,
) -> Result<SurfaceRt0Snapshot, RunError> {
    Err(invalid("retained H-only native runtime unavailable; no charge or device fallback"))
}

// Preserve the original evidence family; the full v2 verifier above proves its physics.
fn validate_parent_field_realization(manifest: &Value) -> Result<(), RunError> {
    let intent = manifest.get("requested_intent").and_then(Value::as_object)
        .ok_or_else(|| invalid("retained parent requested intent absent"))?;
    let direct = manifest["direct_evidence_schema"] == super::direct_quadrature_v2::SCHEMA
        && !intent.contains_key("oersted_realization") && !intent.contains_key("surface_field_policy");
    let surface = manifest["direct_evidence_schema"] == RETAINED_CURRENT_EVIDENCE_SCHEMA
        && intent.get("oersted_realization").and_then(Value::as_str) == Some("analytic_rt0_surface")
        && intent.contains_key("surface_field_policy");
    if !direct && !surface { return Err(invalid("retained parent field evidence is unsupported or mixed")); }
    Ok(())
}

#[cfg(test)]
mod retained_parent_realization_tests {
    use super::*;
    #[test]
    fn retained_source_preparation_requires_its_separate_compute_and_publication_contract() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/runtime/antenna-standalone-pipeline.json")).unwrap();
        let mut stage: AntennaFieldSolveStageIR = serde_json::from_value(
            fixture["ir"]["antenna_field_solve_stages"][0].clone()).unwrap();
        require_retained_field_contract(&stage, RetainedFieldContract::Current).unwrap();
        assert!(require_retained_field_contract(&stage, RetainedFieldContract::PreparationAsset).is_err());
        stage.retained_source_preparation = Some(fullmag_ir::AntennaSourcePreparationAssetRefIR {
            asset_id: "script-file-preparation".into(), content_sha256: "a".repeat(64),
        });
        assert!(require_retained_field_contract(&stage, RetainedFieldContract::Current).is_err());
        require_retained_field_contract(&stage, RetainedFieldContract::PreparationAsset).unwrap();
    }

    #[test]
    fn retained_field_observation_never_reports_a_new_charge_solve() {
        use crate::{AntennaOperationPhase as Phase, AntennaOperationProgress as Progress};
        let seen = std::sync::Mutex::new(Vec::new());
        let observer = |progress: Progress| seen.lock().unwrap().push(progress);
        for phase in [Phase::PreparingSource, Phase::SolvingPotential, Phase::ReconstructingCurrent,
            Phase::EvaluatingField, Phase::ValidatingResult, Phase::PublishingResult] {
            let completed = if matches!(phase, Phase::ValidatingResult | Phase::PublishingResult) { 247 } else { 0 };
            forward_field_progress(Some(&observer), Progress { phase, completed_targets: completed,
                total_targets: 247, source_cells: 14_304, elapsed_seconds: 0.0 }, 7.0);
        }
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 3);
        assert_eq!(seen[0].phase, Phase::EvaluatingField);
        assert_eq!(seen[1].phase, Phase::ValidatingResult);
        assert_eq!(seen[2].phase, Phase::PublishingResult);
        assert!(seen.iter().all(|progress| progress.total_targets == 247
            && progress.source_cells == 14_304 && progress.elapsed_seconds == 7.0));
    }

    #[test]
    fn actual_direct_and_surface_parents_keep_their_original_evidence_family() {
        let direct = serde_json::json!({"direct_evidence_schema":super::super::direct_quadrature_v2::SCHEMA,
            "requested_intent":{}});
        assert!(validate_parent_field_realization(&direct).is_ok());
        let surface = serde_json::json!({"direct_evidence_schema":RETAINED_CURRENT_EVIDENCE_SCHEMA,
            "requested_intent":{"oersted_realization":"analytic_rt0_surface","surface_field_policy":{}}});
        assert!(validate_parent_field_realization(&surface).is_ok());
        for invalid in [
            serde_json::json!({"direct_evidence_schema":"unknown","requested_intent":{}}),
            serde_json::json!({"direct_evidence_schema":RETAINED_CURRENT_EVIDENCE_SCHEMA,"requested_intent":{}}),
            serde_json::json!({"direct_evidence_schema":super::super::direct_quadrature_v2::SCHEMA,
                "requested_intent":{"oersted_realization":"analytic_rt0_surface"}}),
            serde_json::json!({"direct_evidence_schema":super::super::direct_quadrature_v2::SCHEMA,
                "requested_intent":{"surface_field_policy":{}}}),
            serde_json::json!({"direct_evidence_schema":super::super::direct_quadrature_v2::SCHEMA}),
        ] { assert!(validate_parent_field_realization(&invalid).is_err()); }
    }
}
