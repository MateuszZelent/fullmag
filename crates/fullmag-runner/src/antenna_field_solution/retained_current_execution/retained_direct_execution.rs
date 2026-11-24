//! Typed retained DTQ producer. Durable source/asset ownership is established by the worker.
use super::*;
use fullmag_ir::AntennaRetainedDirectFieldPlanV2;

pub struct ProducedRetainedDirectField {
    pub manifest: RetainedCurrentFieldManifestV2,
    pub payloads: BTreeMap<String, Vec<u8>>,
}

pub fn execute_retained_direct_field_inspection_observed_typed(
    problem: &fullmag_ir::ProblemIR, parent: &VerifiedRetainedCurrentParentContent,
    plan: &AntennaRetainedDirectFieldPlanV2, capsule_bytes: &[u8], cancelled: Option<&AtomicBool>,
    config: Option<&SolverProfileConfig>, profile: &mut SolverProfileState,
    observer: Option<&AntennaOperationProgressObserver<'_>>,
) -> Result<ProducedRetainedDirectField, RunError> {
    let enabled = config.filter(|config| config.enabled);
    if enabled.is_none() && observer.is_none() {
        return execute(problem, parent, plan, capsule_bytes, cancelled, None);
    }
    let started = std::time::Instant::now();
    let observe = |progress| forward_field_progress(observer, progress, started.elapsed().as_secs_f64());
    let observed: Option<&AntennaOperationProgressObserver<'_>> = observer.map(|_| &observe as _);
    let result = execute(problem, parent, plan, capsule_bytes, cancelled, observed);
    if let Some(config) = enabled {
        let config = config.clone().normalized();
        if profile.config() != &config { profile.set_config(config); }
        let outcome = if result.is_ok() { SolverProfileOperationOutcome::Completed }
            else if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) { SolverProfileOperationOutcome::Cancelled }
            else { SolverProfileOperationOutcome::Failed };
        profile.record_antenna_operation(outcome, started.elapsed().as_nanos().min(u128::from(u64::MAX)) as u64,
            None, None, [0; 8], false);
    }
    result
}

fn execute(
    problem: &fullmag_ir::ProblemIR, parent: &VerifiedRetainedCurrentParentContent,
    plan: &AntennaRetainedDirectFieldPlanV2, capsule_bytes: &[u8], cancelled: Option<&AtomicBool>,
    observer: Option<&AntennaOperationProgressObserver<'_>>,
) -> Result<ProducedRetainedDirectField, RunError> {
    check_cancelled(cancelled)?;
    let stage = &plan.stage;
    let [port] = stage.port_mode_ids.as_slice() else { return Err(invalid("retained DTQ port is not unique")); };
    let [output] = stage.outputs.as_slice() else { return Err(invalid("retained DTQ output is not unique")); };
    let canonical = fullmag_plan::validate_retained_direct_field_operation(problem, &stage.id, port, &output.id)
        .map_err(|error| invalid(&format!("retained DTQ canonical operation differs: {error}")))?;
    if &canonical != plan { return Err(invalid("retained DTQ plan differs from canonical lowering")); }
    artifact(validate_parent_evidence_bytes(&parent.parent, capsule_bytes))?;
    let source = stage.retained_current_source.as_ref().ok_or_else(|| invalid("retained DTQ source locator absent"))?;
    if !parent.parent.owner.matches_source(source) || parent.source_object_id != stage.source_object_id
        || parent.current_transport_id != stage.current_transport_id || parent.port_mode_id != *port {
        return Err(invalid("retained DTQ exact parent/source/port identity differs"));
    }
    // The opaque content carries the original V/J and authored preimage, never fitted J samples.
    parent.validate_source_intent(problem, stage)?;
    let sampling = &plan.field_sampling;
    let cells = sampling.cells.require_tet4().map_err(|_| invalid("retained DTQ target requires Tet4"))?;
    let carrier = AntennaSampleCarrier { domain: sampling.domain.clone(), carrier_kind: sampling.carrier_kind.clone(),
        location: sampling.location.clone(), topology_digest: sampling.topology_digest.clone() };
    closed_loop_v2::validate_sampling_mesh(&carrier, &sampling.positions_xyz_m, &cells)?;
    let policy = artifact(RetainedCurrentDirectFieldPolicyV2::for_solver_policy(&stage.solver_policy))?;
    let pairs = parent.source_cell_count().checked_mul(sampling.positions_xyz_m.len() as u64)
        .ok_or_else(|| invalid("retained DTQ pair count overflow"))?;
    if pairs > policy.maximum_source_target_pairs { return Err(invalid("retained DTQ exceeds closed pair budget")); }
    let payload_bound = (sampling.positions_xyz_m.len() as u64).checked_mul(144)
        .and_then(|n| (cells.len() as u64).checked_mul(16).and_then(|c| n.checked_add(c)))
        .and_then(|n| n.checked_add(296)).ok_or_else(|| invalid("retained DTQ payload size overflow"))?;
    if payload_bound > MAX_PACKAGE_BYTES { return Err(invalid("retained DTQ payload exceeds package bound")); }
    let budget = fullmag_ir::antenna_closed_loop_direct_budget(&stage.solver_policy)
        .ok_or_else(|| invalid("retained DTQ requires a closed direct profile"))?;
    crate::antenna_operation_progress::notify(observer, crate::AntennaOperationProgress {
        phase: crate::AntennaOperationPhase::EvaluatingField, completed_targets: 0,
        total_targets: sampling.positions_xyz_m.len() as u64, source_cells: parent.source_cell_count(), elapsed_seconds: 0.0,
    });
    let evidence = evaluate_direct(parent, &sampling.positions_xyz_m, budget, observer)?;
    check_cancelled(cancelled)?;
    let mut payloads = BTreeMap::new();
    payloads.insert("sample_xyz".into(), f64_bytes(sampling.positions_xyz_m.iter().flatten().copied())?);
    let mut topology = Vec::new();
    topology.try_reserve_exact(cells.len().checked_mul(16).ok_or_else(|| invalid("retained DTQ target topology overflow"))?)
        .map_err(|_| invalid("retained DTQ target topology allocation"))?;
    for index in cells.iter().flatten() { topology.extend_from_slice(&index.to_le_bytes()); }
    payloads.insert("sample_cells".into(), topology);
    payloads.insert("h_raw".into(), f64_bytes(evidence.snapshot.targets.iter().flat_map(|row| row.h_xyz_apm))?);
    payloads.insert("evidence".into(), evidence.encode()?);
    let reference = |key: &str, layout: &str, unit: &str| -> Result<RetainedCurrentPayloadRef, RunError> {
        let bytes = payloads.get(key).ok_or_else(|| invalid("retained DTQ payload absent"))?;
        Ok(RetainedCurrentPayloadRef { sha256: super::super::sha256(bytes), byte_count: bytes.len() as u64,
            layout: layout.into(), unit: unit.into() })
    };
    let mut manifest = RetainedCurrentFieldManifestV2 {
        schema_version: RETAINED_CURRENT_FIELD_SCHEMA_V2.into(), status: "inspection_only".into(),
        qualification: "not_verified".into(), content_digest: String::new(), stage_id: stage.id.clone(),
        output_id: output.id.clone(), port_mode_id: parent.port_mode_id.clone(), source_object_id: parent.source_object_id.clone(),
        current_transport_id: parent.current_transport_id.clone(), parent: parent.parent.clone(), sample_carrier: carrier,
        source_vertex_count: parent.source.vertex_xyz_m.len() as u64, source_cell_count: parent.source_cell_count(),
        target_count: sampling.positions_xyz_m.len() as u64, sample_cell_count: cells.len() as u64,
        requested_intent: stage.clone(), resolved_execution: RetainedCurrentResolvedExecution {
            requested_execution: plan.requested_execution.clone(), execution: plan.requested_execution.clone(),
            operator_version: RETAINED_CURRENT_OPERATOR_V2.into(), basis_version: RETAINED_CURRENT_BASIS.into(),
            evidence_schema: RETAINED_CURRENT_EVIDENCE_SCHEMA_V2.into() }, direct_field_policy: policy,
        payloads: RetainedCurrentPayloads { sample_xyz: reference("sample_xyz", "sample_xyz_f64_le", "m")?,
            sample_cells: reference("sample_cells", "tet4_u32_le", "1")?, h_raw: reference("h_raw", "sample_xyz_f64_le", "A/m")?,
            evidence: reference("evidence", RETAINED_CURRENT_EVIDENCE_SCHEMA_V2, "1")? },
    };
    manifest.content_digest = artifact(manifest.expected_content_digest())?;
    artifact(validate_payloads_v2(&manifest, &payloads))?;
    Ok(ProducedRetainedDirectField { manifest, payloads })
}

#[cfg(feature = "fem-native")]
fn evaluate_direct(parent: &VerifiedRetainedCurrentParentContent, points: &[[f64; 3]],
    budget: fullmag_ir::AntennaClosedLoopDirectBudgetIR, observer: Option<&AntennaOperationProgressObserver<'_>>,
) -> Result<super::super::direct_quadrature_v2::DirectQuadratureEvidenceV2, RunError> {
    // The numeric adapter performs full validate_closed_loop and verify_retained_dtq_binding
    // before returning evidence; do not allocate a second raw-H copy here.
    crate::native_fem::evaluate_retained_rt0_direct(&parent.source, points, budget, observer)
}
#[cfg(not(feature = "fem-native"))]
fn evaluate_direct(_parent: &VerifiedRetainedCurrentParentContent, _points: &[[f64; 3]],
    _budget: fullmag_ir::AntennaClosedLoopDirectBudgetIR, _observer: Option<&AntennaOperationProgressObserver<'_>>,
) -> Result<super::super::direct_quadrature_v2::DirectQuadratureEvidenceV2, RunError> {
    Err(invalid("retained DTQ native FEM CPU runtime unavailable; no transport or device fallback"))
}

/// Read-only full binding of a child to an independently verified opaque parent.
/// This never evaluates H or invokes a transport solve.
pub fn verify_retained_direct_field_for_publication(
    problem: &fullmag_ir::ProblemIR, produced: &ProducedRetainedDirectField,
    parent: &VerifiedRetainedCurrentParentContent, capsule_bytes: &[u8], child_package_object_ref: &str,
) -> Result<(), RunError> {
    let m = &produced.manifest;
    let [port] = m.requested_intent.port_mode_ids.as_slice() else { return Err(invalid("retained DTQ port is not unique")); };
    let [output] = m.requested_intent.outputs.as_slice() else { return Err(invalid("retained DTQ output is not unique")); };
    let plan = fullmag_plan::validate_retained_direct_field_operation(problem, &m.stage_id, port, &output.id)
        .map_err(|error| invalid(&format!("retained DTQ canonical publication: {error}")))?;
    artifact(validate_payloads_v2(m, &produced.payloads))?;
    if m.requested_intent != plan.stage || m.resolved_execution.requested_execution != plan.requested_execution
        || m.resolved_execution.execution != plan.requested_execution || m.parent != parent.parent
        || m.source_object_id != parent.source_object_id || m.current_transport_id != parent.current_transport_id
        || m.port_mode_id != parent.port_mode_id || m.source_cell_count != parent.source_cell_count()
        || m.source_vertex_count != parent.source.vertex_xyz_m.len() as u64 {
        return Err(invalid("retained DTQ publication parent, source, counts or intent differs"));
    }
    parent.validate_source_intent(problem, &plan.stage)?;
    artifact(validate_parent_evidence_bytes(&m.parent, capsule_bytes))?;
    artifact(validate_no_child_cycle_v2(child_package_object_ref, m, capsule_bytes))?;
    let positions = xyz(&produced.payloads["sample_xyz"])?;
    let raw = xyz(&produced.payloads["h_raw"])?;
    let sampling = &plan.field_sampling;
    let cells = sampling.cells.require_tet4().map_err(|_| invalid("retained DTQ publication requires Tet4"))?;
    if m.sample_carrier.domain != sampling.domain || m.sample_carrier.carrier_kind != sampling.carrier_kind
        || m.sample_carrier.location != sampling.location || m.sample_carrier.topology_digest != sampling.topology_digest
        || m.target_count != positions.len() as u64 || m.sample_cell_count != cells.len() as u64
        || positions.len() != sampling.positions_xyz_m.len()
        || positions.iter().flatten().zip(sampling.positions_xyz_m.iter().flatten()).any(|(a,b)| a.to_bits() != b.to_bits())
        || produced.payloads["sample_cells"].len() != cells.len().checked_mul(16).ok_or_else(|| invalid("retained DTQ topology overflow"))?
        || produced.payloads["sample_cells"].chunks_exact(4).zip(cells.iter().flatten()).any(|(a,b)| a != b.to_le_bytes()) {
        return Err(invalid("retained DTQ publication target carrier differs"));
    }
    closed_loop_v2::validate_sampling_mesh(&m.sample_carrier, &positions, &cells)?;
    let evidence = super::super::direct_quadrature_v2::DirectQuadratureEvidenceV2::decode(&produced.payloads["evidence"])?;
    let budget = fullmag_ir::antenna_closed_loop_direct_budget(&plan.stage.solver_policy)
        .ok_or_else(|| invalid("retained DTQ publication profile absent"))?;
    super::super::retained_dtq_binding::verify_retained_dtq_binding(&evidence, &parent.source.metadata,
        parent.source_cell_count(), &positions, &raw, budget)
}

