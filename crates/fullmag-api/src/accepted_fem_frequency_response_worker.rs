//! Accepted FEM driven response. Harmonic outputs are analysis artifacts,
//! never a new accepted magnetization state.

use anyhow::{bail, Context, Result};
use fullmag_application::{
    decode_frequency_response_index_bundle, decode_frequency_response_point_bundle,
    encode_frequency_response_index_bundle, encode_frequency_response_point_bundle,
    validate_frequency_response_sweep_bundles, FrequencyResponseBundleIdentity,
    FrequencyResponseBundleManifest, FrequencyResponsePayloadReference,
    FrequencyResponsePointMetadata, FrequencyResponsePointReference, PreparationBinding,
    FREQUENCY_RESPONSE_BUNDLE_MAX_BYTES, FREQUENCY_RESPONSE_CODEC_VERSION,
    FREQUENCY_RESPONSE_INDEX_CODEC_ID, FREQUENCY_RESPONSE_POINT_CODEC_ID,
};
use fullmag_authoring::{StudyOutputPort, StudyPortDataKind};
use fullmag_ir::{BackendPlanIR, BackendTarget, ExecutionMode, ExecutionPrecision};
use fullmag_runner::{
    AcceptedFrequencyResponseArtifactLimits, ArtifactFileBytes, RunStatus, RuntimeEngineId,
    StageFemMeshAsset,
};
use fullmag_runtime_control::{AcceptedStudySnapshot, AcceptedWorkerStep, StudyOutputPayload};
use fullmag_session::SessionStore;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// Frozen before the durable started receipt. The common worker owns lifecycle
/// fencing, storage reservation and recovery; this adapter owns no scheduler.
pub(crate) struct PreparedFrequencyResponse {
    pub(crate) case_id: String,
    pub(crate) problem: fullmag_ir::ProblemIR,
    pub(crate) execution_plan: fullmag_ir::ExecutionPlanIR,
    pub(crate) stage_mesh: StageFemMeshAsset,
    pub(crate) bundle_identity: FrequencyResponseBundleIdentity,
    pub(crate) artifact_identity: fullmag_runner::eigen::FrequencyDomainArtifactIdentity,
    pub(crate) preparation_plan_fingerprint: String,
    pub(crate) plan_digest: String,
    pub(crate) output_storage_budget: u64,
    pub(crate) required_free_storage_bytes: u64,
    pub(crate) memory_budget: u64,
    pub(crate) artifact_limits: AcceptedFrequencyResponseArtifactLimits,
    pub(crate) resolved_device: String,
    pub(crate) gpu_uuid: Option<String>,
}

impl PreparedFrequencyResponse {
    pub(crate) fn frequency_plan(&self) -> &fullmag_ir::FemFrequencyResponsePlanIR {
        let BackendPlanIR::FemFrequencyResponse(plan) = &self.execution_plan.backend_plan else {
            unreachable!("prepared driven response retains its plan variant")
        };
        plan
    }
}

pub(crate) enum FrequencyResponseOutcome {
    Completed {
        outputs: Vec<StudyOutputPayload>,
        completed_frequency_count: usize,
        published_root: PathBuf,
    },
    Cancelled {
        completed_frequency_count: usize,
    },
}

fn validate_request(
    request: &fullmag_application::RequestedExecution,
    resolved_device: &str,
    gpu_uuid: Option<&str>,
) -> Result<()> {
    if request.backend != "fem"
        || request.precision != "double"
        || request.mode != "strict"
        || !matches!(request.device.as_str(), "cpu" | "gpu" | "auto")
        || (request.device != "auto" && request.device != resolved_device)
    {
        bail!("driven response requires the exact fem/<device>/double/strict accepted request");
    }
    match (resolved_device, gpu_uuid) {
        ("cpu", None) => Ok(()),
        ("gpu", Some(uuid)) if !uuid.trim().is_empty() => Ok(()),
        _ => bail!("driven response runtime device and authoritative lease UUID differ"),
    }
}

fn validate_terminal_frequency_count(
    completed: u64,
    expected: usize,
    cancelled: bool,
) -> Result<usize> {
    let completed = usize::try_from(completed).context("native frequency count overflow")?;
    if completed > expected || (!cancelled && completed != expected) {
        bail!("native driven response did not complete the exact declared frequency grid");
    }
    Ok(completed)
}

/// Pure accepted-input preflight. No attempt files or native solver calls.
pub(crate) fn prepare(
    store: &SessionStore,
    accepted: &AcceptedStudySnapshot,
    step: &AcceptedWorkerStep,
    study_step: &fullmag_authoring::StudyStep,
    case_id: &str,
    runtime: &crate::accepted_study_worker::AcceptedFemRuntime,
    artifact_identity: &fullmag_runner::eigen::FrequencyDomainArtifactIdentity,
    scope_id: &str,
) -> Result<PreparedFrequencyResponse> {
    fullmag_session::repository_path::validate_store_id(case_id)?;
    artifact_identity.validate()?;
    validate_request(
        &step.resolved_input.requested_execution,
        &runtime.resolved_device,
        runtime.gpu_uuid.as_deref(),
    )?;
    if !matches!(
        &study_step.acceptance,
        fullmag_authoring::StudyAcceptancePolicy::Any
    ) || !matches!(
        &study_step.kind,
        fullmag_authoring::StudyStepKind::Primitive {
            stage_kind: fullmag_authoring::StudyPrimitiveStageKind::FrequencyResponse
        }
    ) {
        bail!("driven response requires its explicit primitive and Any acceptance policy");
    }
    if step.until_seconds.is_some()
        || !accepted.run.specification.seeds.is_empty()
        || !step.problem.problem_meta.seeds.is_empty()
        || accepted
            .run
            .specification
            .parameters
            .get(crate::accepted_solver_profile::PARAMETER)
            .is_some()
    {
        bail!("driven response has no time horizon, seed or solver-profile adapter");
    }
    crate::accepted_study_worker::validate_accepted_inspection_run_parameters(
        &accepted.run.specification,
        &step.step_id,
    )?;
    let session_id = accepted
        .run
        .specification
        .parameters
        .pointer("/live_workspace/session_id")
        .and_then(serde_json::Value::as_str)
        .context("accepted driven response requires its immutable UI session binding")?;
    if artifact_identity.session_id != session_id
        || artifact_identity.run_id != step.claim.run_id.as_str()
        || artifact_identity.stage_id != step.step_id
        || artifact_identity.runtime_id
            != format!(
                "runtime:fr:{}:epoch-{}",
                step.claim.attempt_id.as_str(),
                step.claim.ownership_epoch.value()
            )
        || scope_id != "scope:driven-response"
    {
        bail!("driven response artifact identity differs from its immutable accepted attempt");
    }
    let preparation = accepted
        .read_task_preparation_receipt(store, step.claim.task_id.as_str())
        .context("load exact accepted driven-response preparation")?;
    if PreparationBinding::from_receipt(&preparation)? != step.resolved_input.preparation
        || preparation.plan.requested_backend != BackendTarget::Fem
        || preparation.plan.resolved_backend != BackendTarget::Fem
    {
        bail!("driven response preparation differs from the durable worker input");
    }
    let spaces = preparation
        .certificates
        .iter()
        .filter_map(|c| c.space.as_ref())
        .collect::<Vec<_>>();
    if spaces.len() != 1
        || spaces[0].fe_family.as_deref() != Some("H1")
        || spaces[0].fe_order != Some(1)
        || !spaces[0].local_dof_count.is_some_and(|n| n > 0)
        || !spaces[0].true_dof_count.is_some_and(|n| n > 0)
    {
        bail!("driven response requires exactly one native H1/P1 preparation certificate");
    }
    let execution_plan =
        crate::accepted_study_worker::materialize_resolved_study_inputs(store, step)?;
    let BackendPlanIR::FemFrequencyResponse(plan) = &execution_plan.backend_plan else {
        bail!("accepted driven response requires its dedicated FEM frequency-response plan");
    };
    validate_plan_scope(&step.problem, &execution_plan, &runtime.resolved_device)?;
    validate_declared_outputs(&study_step.outputs, plan.frequencies_hz.values_hz.len())?;
    let descriptor = fullmag_runner::frequency_response_input_descriptor(plan)
        .map_err(|e| anyhow::anyhow!(e.to_string()))?;
    let plan_digest = if step.resolved_input.plan_fingerprint.starts_with("sha256:") {
        step.resolved_input.plan_fingerprint.clone()
    } else {
        format!("sha256:{}", step.resolved_input.plan_fingerprint)
    };
    let bundle_identity = FrequencyResponseBundleIdentity {
        session_id: artifact_identity.session_id.clone(),
        run_id: artifact_identity.run_id.clone(),
        task_id: step.claim.task_id.as_str().to_owned(),
        stage_id: artifact_identity.stage_id.clone(),
        scope_id: scope_id.to_owned(),
        runtime_id: artifact_identity.runtime_id.clone(),
        attempt_id: step.claim.attempt_id.as_str().to_owned(),
        ownership_epoch: step.claim.ownership_epoch.value(),
        case_id: case_id.to_owned(),
        plan_fingerprint: plan_digest.clone(),
        topology_fingerprint: descriptor.topology_fingerprint,
        equilibrium_sha256: descriptor.equilibrium_sha256,
        equilibrium_verified: false,
    };
    let memory_budget = step.claim.lease.budget.memory_bytes;
    let artifact_limits = artifact_limits(memory_budget, step.claim.lease.budget.storage_bytes);
    let output_storage_budget = artifact_limits.max_total_output_bytes;
    let estimate =
        fullmag_runner::preflight_frequency_response_artifact_resources(plan, artifact_limits)
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
    let required_free_storage_bytes = storage_reservation_bytes(estimate)
        .context("driven-response storage reserve overflow")?;
    if required_free_storage_bytes > step.claim.lease.budget.storage_bytes {
        bail!("driven-response native and published closure exceed accepted scratch budget");
    }
    let stage_mesh = StageFemMeshAsset::build_from_backend_plan(&execution_plan.backend_plan)
        .context("driven-response stage mesh identity missing")?;
    let mut problem = step.problem.clone();
    problem.problem_meta.runtime_metadata.insert(
        "runtime_device_override".into(),
        serde_json::json!({"device": runtime.resolved_device, "source": "managed_launcher"}),
    );
    let preflight = fullmag_runner::resolve_session_runtime_for_plan_and_preview(
        &problem,
        &execution_plan,
        u64::MAX,
    )
    .map_err(|e| anyhow::anyhow!(e.to_string()))?;
    let expected_engine = if runtime.resolved_device == "gpu" {
        RuntimeEngineId::FemNativeGpu
    } else {
        RuntimeEngineId::FemFrequencyResponseProductionCpu
    };
    if preflight.resolved_backend != "fem"
        || preflight.resolved_device != runtime.resolved_device
        || preflight.resolved_precision != "double"
        || preflight.resolved_engine_id.as_deref() != Some(expected_engine.as_str())
        || preflight.resolved_fallback.is_some()
    {
        bail!(
            "accepted driven-response preflight expected FEM/{}/double engine {}; resolved {}/{}/{} engine {:?}, fallback {:?}",
            runtime.resolved_device,
            expected_engine.as_str(),
            preflight.resolved_backend,
            preflight.resolved_device,
            preflight.resolved_precision,
            preflight.resolved_engine_id,
            preflight.resolved_fallback,
        );
    }
    Ok(PreparedFrequencyResponse {
        case_id: case_id.to_owned(),
        problem,
        execution_plan,
        stage_mesh,
        bundle_identity,
        artifact_identity: artifact_identity.clone(),
        preparation_plan_fingerprint: preparation.plan_fingerprint,
        plan_digest,
        output_storage_budget,
        required_free_storage_bytes,
        memory_budget,
        artifact_limits,
        resolved_device: runtime.resolved_device.clone(),
        gpu_uuid: runtime.gpu_uuid.clone(),
    })
}

pub(crate) fn storage_reservation_bytes(
    estimate: fullmag_runner::AcceptedFrequencyResponseResourceEstimate,
) -> Option<u64> {
    estimate.native_output_bytes_upper_bound.checked_mul(2)?
        .checked_add(estimate.publisher_output_bytes_upper_bound.checked_mul(4)?)?
        .checked_add(estimate.scratch_bytes_upper_bound)
}

pub(crate) fn validate_plan_scope(
    problem: &fullmag_ir::ProblemIR,
    execution_plan: &fullmag_ir::ExecutionPlanIR,
    requested_device: &str,
) -> Result<()> {
    let BackendPlanIR::FemFrequencyResponse(plan) = &execution_plan.backend_plan else {
        bail!("expected a FEM frequency-response plan");
    };
    if problem.backend_policy.requested_backend != BackendTarget::Fem
        || problem.backend_policy.execution_precision != ExecutionPrecision::Double
        || problem.validation_profile.execution_mode != ExecutionMode::Strict
        || execution_plan.common.requested_backend != BackendTarget::Fem
        || execution_plan.common.resolved_backend != BackendTarget::Fem
        || execution_plan.common.execution_mode != ExecutionMode::Strict
        || plan.precision != ExecutionPrecision::Double
        || plan.fe_order != 1
        || plan.equilibrium != fullmag_ir::EquilibriumSourceIR::Provided
        || plan.spin_wave_bc.kind() != fullmag_ir::SpinWaveBoundaryKindIR::Free
        || plan.magnetostatic_bc != fullmag_ir::MagnetostaticBoundaryConditionIR::Open
        || !plan.mesh.periodic_node_pairs.is_empty()
        || !plan.mesh.periodic_boundary_pairs.is_empty()
        || !plan.periodic_constraint_sets.is_empty()
        || !match &plan.k_sampling {
            None => true,
            Some(fullmag_ir::KSamplingIR::Single { k_vector }) => {
                k_vector.iter().all(|v| *v == 0.0)
            }
            _ => false,
        }
    {
        bail!("accepted driven response supports only provided H1/P1 double/strict free Gamma k=0");
    }
    if !matches!(requested_device, "cpu" | "gpu") {
        bail!("accepted driven response requires an explicit CPU or GPU request");
    }
    let requested = match plan.requested_device {
        fullmag_ir::ExecutionDevice::Cpu => "cpu",
        fullmag_ir::ExecutionDevice::Gpu => "gpu",
        fullmag_ir::ExecutionDevice::Auto => "auto",
    };
    if requested != requested_device {
        bail!("driven-response plan device differs from preserved requested intent");
    }
    let method = plan.solver_policy.as_ref().and_then(|p| p.method);
    if (requested_device == "gpu"
        && (requested != "gpu"
            || method != Some(fullmag_ir::FrequencyResponseSolverMethodIR::GpuOperatorHostKrylov)))
        || (requested_device == "cpu"
            && !matches!(
                method,
                None | Some(fullmag_ir::FrequencyResponseSolverMethodIR::Auto)
            ))
    {
        bail!("accepted driven response requires native CPU Auto or explicit GPU operator/host Krylov");
    }
    Ok(())
}

pub(crate) fn artifact_limits(
    memory_bytes: u64,
    storage_bytes: u64,
) -> AcceptedFrequencyResponseArtifactLimits {
    AcceptedFrequencyResponseArtifactLimits {
        max_total_output_bytes: (storage_bytes / 2).min(memory_bytes / 8),
        max_peak_working_bytes: memory_bytes / 2,
        max_native_source_bytes: storage_bytes / 2,
        max_native_dense_json_bytes: memory_bytes / 2,
        ..Default::default()
    }
}

/// Fail before native writer side effects: its fixed path buffers require room
/// for the deepest Zarr metadata member and the terminating NUL byte.
pub(crate) fn validate_native_output_path(root: &Path, frequency_count: usize) -> Result<()> {
    let index = frequency_count
        .checked_sub(1)
        .context("empty driven-response frequency grid")?;
    let longest = root.join(format!(
        "response/field_payloads.zarr/frequency_{index:04}/vector_tangent_complex/.zarray"
    ));
    let text = longest
        .to_str()
        .context("native driven-response output path must be UTF-8")?;
    if !root.is_absolute() || text.as_bytes().len() >= 255 || text.as_bytes().contains(&0) {
        bail!("native driven-response output path exceeds the fixed 256-byte writer buffer");
    }
    Ok(())
}

pub(crate) fn execute(
    prepared: &PreparedFrequencyResponse,
    _step: &AcceptedWorkerStep,
    native_root: &Path,
    autosave_root: &Path,
    interrupt: Option<&AtomicBool>,
    on_progress: impl FnMut(fullmag_runner::StepUpdate) -> fullmag_runner::StepAction + Send,
) -> Result<FrequencyResponseOutcome> {
    let plan = prepared.frequency_plan();
    validate_native_output_path(native_root, plan.frequencies_hz.values_hz.len())?;
    if interrupt.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        return Ok(FrequencyResponseOutcome::Cancelled {
            completed_frequency_count: 0,
        });
    }
    let result = fullmag_runner::run_planned_problem_with_live_preview_and_artifact_identity(
        &prepared.problem,
        &prepared.execution_plan,
        Some(&prepared.stage_mesh.identity),
        0.0,
        native_root,
        autosave_root,
        u64::MAX,
        &fullmag_runner::DisplaySelectionState::default,
        interrupt,
        false,
        on_progress,
        &prepared.artifact_identity,
    )
    .map_err(|e| anyhow::anyhow!(e.to_string()))
    .context("execute accepted native driven response")?;
    let cancelled = result.status == RunStatus::Cancelled;
    if !cancelled && result.status != RunStatus::Completed {
        bail!("native driven response failed");
    }
    let count = validate_terminal_frequency_count(
        result
            .steps
            .last()
            .context("native response has no terminal frequency count")?
            .step,
        plan.frequencies_hz.values_hz.len(),
        cancelled,
    )?;
    // final_magnetization is the input M0 in this native workflow, not an output state.
    drop(result);
    if cancelled {
        return Ok(FrequencyResponseOutcome::Cancelled {
            completed_frequency_count: count,
        });
    }
    let published_root = native_root.join("published");
    let artifacts = fullmag_runner::collect_publish_accepted_frequency_response_artifacts(
        plan,
        &prepared.artifact_identity,
        native_root,
        &published_root,
        prepared.artifact_limits,
    )
    .map_err(|e| anyhow::anyhow!(e.to_string()))?;
    if artifacts.points.len() != count {
        bail!("published point count differs from native completion");
    }
    let metadata = serde_json::json!({
        "requested_device": prepared.frequency_plan().requested_device,
        "resolved_device": prepared.resolved_device,
        "executed_realization": if prepared.resolved_device == "gpu" { "gpu_operator_host_krylov" } else { "production_cpu_host_gmres" },
        "lease_gpu_uuid": prepared.gpu_uuid,
        "native_execution_uuid_verified": false,
        "alpha": plan.material.damping, "gamma0_m_per_a_s": plan.gyromagnetic_ratio,
        "bias_a_per_m": plan.external_field, "excitation": plan.excitation,
        "equilibrium_verified": false,
    });
    let mut outputs = Vec::with_capacity(count + 1);
    let mut references = Vec::with_capacity(count);
    for point in artifacts.points {
        let port_id = format!("response-frequency-{:06}", point.frequency_index);
        let (payloads, files) = bundle_files(point.files)?;
        let manifest = FrequencyResponseBundleManifest {
            schema_version: "fullmag.fem.driven_response_point.v1".into(),
            status: "complete".into(),
            study_product: "driven_response".into(),
            identity: prepared.bundle_identity.clone(),
            frequency_count: count as u64,
            payloads,
            native_metadata: metadata.clone(),
            point: Some(FrequencyResponsePointMetadata {
                index: point.frequency_index,
                frequency_hz: point.frequency_hz,
                port_id: port_id.clone(),
                converged: point.converged,
                relative_residual_l2: point.relative_residual_l2_norm,
                solver_relative_tolerance: point.solver_relative_tolerance,
            }),
            points: Vec::new(),
        };
        let bytes = encode_frequency_response_point_bundle(
            &serde_json::to_vec(&manifest)?,
            &files,
            usize::try_from(prepared.artifact_limits.max_point_bundle_bytes)?,
        )?;
        references.push(FrequencyResponsePointReference {
            index: point.frequency_index,
            frequency_hz: point.frequency_hz,
            port_id: port_id.clone(),
            bundle_sha256: fullmag_session::hex_sha256(&bytes),
        });
        outputs.push(StudyOutputPayload {
            port_id,
            case_id: prepared.case_id.clone(),
            codec_id: FREQUENCY_RESPONSE_POINT_CODEC_ID.into(),
            codec_version: FREQUENCY_RESPONSE_CODEC_VERSION.into(),
            bytes,
        });
    }
    let (payloads, files) = bundle_files(artifacts.global_files)?;
    let mut metadata = metadata;
    metadata["generation"] = serde_json::to_value(&artifacts.artifact_generation)?;
    let manifest = FrequencyResponseBundleManifest {
        schema_version: "fullmag.fem.driven_response_index.v1".into(),
        status: "complete".into(),
        study_product: "driven_response".into(),
        identity: prepared.bundle_identity.clone(),
        frequency_count: count as u64,
        payloads,
        native_metadata: metadata,
        point: None,
        points: references,
    };
    let manifest_bytes = serde_json::to_vec(&manifest)?;
    if manifest_bytes.len() as u64 > prepared.artifact_limits.max_index_bytes {
        bail!("driven-response index metadata byte limit");
    }
    let bytes = encode_frequency_response_index_bundle(
        &manifest_bytes,
        &files,
        usize::try_from(prepared.artifact_limits.max_global_bundle_bytes)?,
    )?;
    outputs.insert(
        0,
        StudyOutputPayload {
            port_id: "response".into(),
            case_id: prepared.case_id.clone(),
            codec_id: FREQUENCY_RESPONSE_INDEX_CODEC_ID.into(),
            codec_version: FREQUENCY_RESPONSE_CODEC_VERSION.into(),
            bytes,
        },
    );
    drop(files);
    validate_outputs(
        &outputs,
        &prepared.bundle_identity,
        plan,
        prepared.output_storage_budget,
        prepared.memory_budget,
    )?;
    Ok(FrequencyResponseOutcome::Completed {
        outputs,
        completed_frequency_count: count,
        published_root,
    })
}

fn bundle_files(
    files: Vec<ArtifactFileBytes>,
) -> Result<(
    BTreeMap<String, FrequencyResponsePayloadReference>,
    BTreeMap<String, Vec<u8>>,
)> {
    let mut payloads = BTreeMap::new();
    let mut bytes = BTreeMap::new();
    for file in files {
        let reference = FrequencyResponsePayloadReference {
            byte_length: u64::try_from(file.bytes.len())?,
            sha256: fullmag_session::hex_sha256(&file.bytes),
            role: file.role.bundle_role().into(),
        };
        if payloads
            .insert(file.relative_path.clone(), reference)
            .is_some()
            || bytes.insert(file.relative_path, file.bytes).is_some()
        {
            bail!("duplicate published driven-response file");
        }
    }
    Ok((payloads, bytes))
}

/// Validate immutable CAS outputs on initial publication and recovery, before
/// any replay decision. Aggregate bytes are bounded before decoder allocations.
pub(crate) fn validate_outputs(
    outputs: &[StudyOutputPayload],
    expected_identity: &FrequencyResponseBundleIdentity,
    plan: &fullmag_ir::FemFrequencyResponsePlanIR,
    max_output_bytes: u64,
    memory_budget: u64,
) -> Result<()> {
    let ports = outputs
        .iter()
        .map(|p| StudyOutputPort {
            port_id: p.port_id.clone(),
            data_kind: StudyPortDataKind::Artifact,
        })
        .collect::<Vec<_>>();
    validate_declared_outputs(&ports, plan.frequencies_hz.values_hz.len())?;
    let total = outputs
        .iter()
        .try_fold(0_u64, |n, output| n.checked_add(output.bytes.len() as u64))
        .context("driven-response result size overflow")?;
    if total > max_output_bytes || total.checked_mul(4).is_none_or(|n| n > memory_budget) {
        bail!("driven-response recovery exceeds aggregate output or peak RAM budget");
    }
    let map_working_bytes = u64::try_from(plan.mesh.nodes.len())?
        .checked_mul(16)
        .context("driven-response input-map bound overflow")?;
    if map_working_bytes > memory_budget / 4 {
        bail!("driven-response recovery input map exceeds peak RAM reserve");
    }
    let descriptor = fullmag_runner::frequency_response_input_descriptor(plan)
        .map_err(|e| anyhow::anyhow!(e.to_string()))?;
    if expected_identity.topology_fingerprint != descriptor.topology_fingerprint
        || expected_identity.equilibrium_sha256 != descriptor.equilibrium_sha256
        || expected_identity.equilibrium_verified
    {
        bail!("driven-response recovered identity differs from the exact provided input");
    }
    let mut decoded_index = None;
    let mut decoded_points = BTreeMap::new();
    for output in outputs {
        if output.case_id != expected_identity.case_id
            || output.codec_version != FREQUENCY_RESPONSE_CODEC_VERSION
        {
            bail!("driven-response output case or codec version differs from accepted identity");
        }
        if output.port_id == "response" {
            if output.codec_id != FREQUENCY_RESPONSE_INDEX_CODEC_ID {
                bail!("driven-response index codec mismatch");
            }
            decoded_index = Some(decode_frequency_response_index_bundle(
                &output.bytes,
                FREQUENCY_RESPONSE_BUNDLE_MAX_BYTES,
            )?);
        } else {
            if output.codec_id != FREQUENCY_RESPONSE_POINT_CODEC_ID {
                bail!("driven-response point codec mismatch");
            }
            let bundle = decode_frequency_response_point_bundle(
                &output.bytes,
                FREQUENCY_RESPONSE_BUNDLE_MAX_BYTES,
            )?;
            let point = bundle
                .manifest()
                .point
                .as_ref()
                .context("driven-response point metadata missing")?;
            if output.port_id != point.port_id {
                bail!("driven-response outer port differs from point metadata");
            }
            decoded_points.insert(point.index, bundle);
        }
    }
    let index = decoded_index.context("driven-response index output missing")?;
    if &index.manifest().identity != expected_identity {
        bail!("driven-response immutable bundle identity mismatch");
    }
    let points = decoded_points.into_values().collect::<Vec<_>>();
    validate_frequency_response_sweep_bundles(
        &index,
        &points,
        &plan.frequencies_hz.values_hz,
        max_output_bytes,
    )?;
    Ok(())
}

/// Rebuild the exact published closure from immutable typed CAS bytes. This
/// operation never reads a mutable native attempt and never calls the solver.
pub(crate) fn restore_published_closure(
    outputs: &[StudyOutputPayload],
    prepared: &PreparedFrequencyResponse,
    destination: &Path,
) -> Result<fullmag_runner::artifact_generation::GenerationCommit> {
    use fullmag_runner::artifact_generation::{
        GenerationCommit, GenerationMember, PublicationOwner,
    };
    validate_outputs(
        outputs,
        &prepared.bundle_identity,
        prepared.frequency_plan(),
        prepared.output_storage_budget,
        prepared.memory_budget,
    )?;
    let mut expected: Option<GenerationCommit> = None;
    let mut files = BTreeMap::new();
    let mut members = BTreeMap::new();
    for output in outputs {
        let bundle = if output.port_id == "response" {
            decode_frequency_response_index_bundle(
                &output.bytes,
                FREQUENCY_RESPONSE_BUNDLE_MAX_BYTES,
            )?
        } else {
            decode_frequency_response_point_bundle(
                &output.bytes,
                FREQUENCY_RESPONSE_BUNDLE_MAX_BYTES,
            )?
        };
        if output.port_id == "response" {
            expected = Some(serde_json::from_value(
                bundle
                    .manifest()
                    .native_metadata
                    .get("generation")
                    .cloned()
                    .context("driven-response immutable generation metadata missing")?,
            )?);
        }
        for (path, payload) in bundle.payloads() {
            let member = GenerationMember {
                byte_length: u64::try_from(payload.len())?,
                sha256: fullmag_session::frequency_domain_artifact_generation::digest(payload),
            };
            if members.insert(path.clone(), member).is_some()
                || files.insert(path.clone(), payload.clone()).is_some()
            {
                bail!("recovered driven-response closure contains duplicate paths");
            }
        }
    }
    let expected = expected.context("driven-response immutable index generation missing")?;
    let owner = PublicationOwner {
        run_id: prepared.bundle_identity.run_id.clone(),
        stage_id: prepared.bundle_identity.stage_id.clone(),
        stage_kind: "frequency_response".into(),
    };
    if expected.content.producer.as_ref() != Some(&owner)
        || expected.content.members != members
        || fullmag_session::frequency_domain_artifact_generation::generation_id(&expected.content)?
            != expected.generation_id
    {
        bail!("recovered driven-response closure differs from the immutable generation");
    }
    let published =
        fullmag_runner::artifact_generation::publish_immutable(destination, Some(owner), files)?;
    if published != expected {
        bail!("restored driven-response generation identity changed");
    }
    Ok(published)
}

pub(crate) fn validate_declared_outputs(
    outputs: &[StudyOutputPort],
    frequency_count: usize,
) -> Result<()> {
    if frequency_count == 0 || frequency_count.checked_add(1) != Some(outputs.len()) {
        bail!("driven response requires one index and one artifact per frequency");
    }
    let mut seen = std::collections::BTreeSet::new();
    for output in outputs {
        if output.data_kind != StudyPortDataKind::Artifact || !seen.insert(output.port_id.as_str())
        {
            bail!("driven-response ports must be unique analysis artifacts");
        }
        if output.port_id == "response" {
            continue;
        }
        let index = output
            .port_id
            .strip_prefix("response-frequency-")
            .and_then(|suffix| suffix.parse::<usize>().ok());
        if !index.is_some_and(|index| {
            index < frequency_count && output.port_id == format!("response-frequency-{index:06}")
        }) {
            bail!("driven-response output does not name a declared frequency");
        }
    }
    if !seen.contains("response") {
        bail!("driven response requires its index artifact");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ports(n: usize) -> Vec<StudyOutputPort> {
        std::iter::once("response".to_owned())
            .chain((0..n).map(|i| format!("response-frequency-{i:06}")))
            .map(|port_id| StudyOutputPort {
                port_id,
                data_kind: StudyPortDataKind::Artifact,
            })
            .collect()
    }

    #[test]
    fn response_storage_reservation_counts_native_publication_and_scratch() {
        let estimate = fullmag_runner::AcceptedFrequencyResponseResourceEstimate {
            native_output_bytes_upper_bound: 10,
            publisher_output_bytes_upper_bound: 20,
            scratch_bytes_upper_bound: 3,
            ..Default::default()
        };
        assert_eq!(storage_reservation_bytes(estimate), Some(103));
        assert_eq!(storage_reservation_bytes(fullmag_runner::AcceptedFrequencyResponseResourceEstimate {
            scratch_bytes_upper_bound: u64::MAX,
            ..estimate
        }), None);
    }

    #[test]
    fn response_request_rejects_wrong_device_and_missing_uuid_without_fallback() {
        let mut request = fullmag_application::RequestedExecution {
            backend: "fem".into(),
            device: "gpu".into(),
            precision: "double".into(),
            mode: "strict".into(),
            minimum_resources: None,
        };
        assert!(validate_request(&request, "gpu", Some("GPU-exact")).is_ok());
        assert!(validate_request(&request, "cpu", None).is_err());
        assert!(validate_request(&request, "gpu", None).is_err());
        assert!(validate_request(&request, "gpu", Some("")).is_err());
        request.device = "auto".into();
        assert!(validate_request(&request, "gpu", Some("GPU-exact")).is_ok());
        assert!(validate_request(&request, "cpu", None).is_ok());
        assert!(validate_request(&request, "cpu", Some("GPU-exact")).is_err());
        request.backend = "fdm".into();
        assert!(validate_request(&request, "cpu", None).is_err());
    }

    #[test]
    fn response_completion_uses_native_frequency_count_and_rejects_prefix_success() {
        assert_eq!(validate_terminal_frequency_count(3, 3, false).unwrap(), 3);
        assert!(validate_terminal_frequency_count(2, 3, false).is_err());
        assert!(validate_terminal_frequency_count(4, 3, false).is_err());
        assert_eq!(validate_terminal_frequency_count(0, 3, true).unwrap(), 0);
        assert_eq!(validate_terminal_frequency_count(2, 3, true).unwrap(), 2);
        assert!(validate_terminal_frequency_count(4, 3, true).is_err());
    }

    #[test]
    fn response_native_output_path_checks_bytes_and_largest_frequency_index() {
        let suffix = "response/field_payloads.zarr/frequency_0000/vector_tangent_complex/.zarray";
        let root_length = 254 - suffix.len() - 1;
        let at_limit = PathBuf::from(format!("/{}", "x".repeat(root_length - 1)));
        assert!(validate_native_output_path(&at_limit, 1).is_ok());
        let too_long = PathBuf::from(format!("/{}", "x".repeat(root_length)));
        assert!(validate_native_output_path(&too_long, 1).is_err());
        assert!(validate_native_output_path(&at_limit, 100_001).is_err());
        assert!(
            validate_native_output_path(Path::new(&format!("/{}", "é".repeat(100))), 1).is_err()
        );
        assert!(validate_native_output_path(Path::new("relative"), 1).is_err());
        assert!(validate_native_output_path(Path::new("/short"), 0).is_err());
    }

    #[test]
    fn exact_declared_frequency_ports_accept_only_complete_unique_analysis_outputs() {
        let valid = ports(2);
        validate_declared_outputs(&valid, 2).unwrap();
        let mut reordered = valid.clone();
        reordered.reverse();
        validate_declared_outputs(&reordered, 2).unwrap();
        for invalid in [
            valid[..2].to_vec(),
            ports(3),
            vec![valid[0].clone(), valid[1].clone(), valid[1].clone()],
            vec![
                valid[0].clone(),
                valid[1].clone(),
                StudyOutputPort {
                    port_id: "response-frequency-000001".into(),
                    data_kind: StudyPortDataKind::State,
                },
            ],
            vec![
                valid[0].clone(),
                valid[1].clone(),
                StudyOutputPort {
                    port_id: "final_state".into(),
                    data_kind: StudyPortDataKind::State,
                },
            ],
            vec![
                valid[0].clone(),
                valid[1].clone(),
                StudyOutputPort {
                    port_id: "response-frequency-1".into(),
                    data_kind: StudyPortDataKind::Artifact,
                },
            ],
            vec![
                valid[1].clone(),
                valid[2].clone(),
                StudyOutputPort {
                    port_id: "response-frequency-000002".into(),
                    data_kind: StudyPortDataKind::Artifact,
                },
            ],
        ] {
            assert!(validate_declared_outputs(&invalid, 2).is_err());
        }
        assert!(validate_declared_outputs(&ports(0), 0).is_err());
        assert!(validate_declared_outputs(&[], usize::MAX).is_err());
    }
}
