//! One-shot materialization from an immutable accepted solver state.
//!
//! This module never advances a solver. It binds observations captured from
//! the original context, or reconstructs an evaluator only when the resolved
//! plan and accepted artifact contain all required primary inputs.

use std::collections::{BTreeMap, BTreeSet};

use fullmag_ir::{BackendPlanIR, ExecutionPlanIR, ProblemIR};
use fullmag_quantities::{AcceptedStateRef, ObservationClock, QuantityId, QuantityShape};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{quantities::QuantitySpec, types::LivePreviewField, RuntimeEngineId};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AcceptedMaterializationLane {
    FdmCpu,
    FdmGpu,
    FemCpu,
    FemGpu,
}

#[derive(Debug, Clone)]
pub struct AcceptedMagnetizationInput {
    pub values: Vec<[f64; 3]>,
    /// The exact canonical layout object from the accepted state artifact.
    pub layout: Value,
    /// Content-addressed hash of the exact accepted state artifact bytes.
    pub content_sha256: String,
    pub native_state_snapshot: Option<
        fullmag_quantities::fem_state_snapshot_receipt::FemLocalNodeSnapshotReceipt,
    >,
    pub native_node_map: Option<fullmag_quantities::fem_local_node_map::FemLocalNodeIndexMap>,
    pub provenance: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AcceptedMaterializedField {
    pub quantity_id: String,
    pub carrier_id: String,
    /// `magnetic`, `layer_native`, or `airbox`.
    pub role: String,
    pub n_comp: usize,
    pub values: Vec<f64>,
    pub layout: Value,
    /// Preserve native nodal projection semantics for cell-like quantities.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spatial_kind: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AcceptedMaterializationBatch {
    pub source: AcceptedStateRef,
    pub clock: ObservationClock,
    /// The plan digest already bound by the accepted-state identity.
    pub plan_sha256: String,
    pub lane: AcceptedMaterializationLane,
    pub magnetization_content_sha256: String,
    /// The evaluator may run during recovery of a completed solver receipt.
    /// Preserve its own build identity instead of attributing new fields to
    /// the binary that originally produced the accepted magnetization.
    #[serde(default)]
    pub evaluator_build_identity: Value,
    pub fields: Vec<AcceptedMaterializedField>,
    /// Scope-specific observations that are not available on this accepted
    /// execution lane. Other materialized scopes remain usable.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub unavailable_scopes: BTreeMap<String, String>,
    /// Canonical global energy IDs mapped to evaluated joule values.
    pub energies: BTreeMap<String, f64>,
}

pub struct AcceptedMaterializationRequest<'a> {
    pub plan: &'a ExecutionPlanIR,
    pub problem: &'a ProblemIR,
    pub source: &'a AcceptedStateRef,
    /// Canonical digest of the original accepted plan before installing the
    /// accepted magnetization into its snapshot copy.
    pub accepted_plan_digest: &'a str,
    pub lane: AcceptedMaterializationLane,
    pub clock: ObservationClock,
    pub magnetization: &'a AcceptedMagnetizationInput,
    /// Empty selects every active catalog field for this exact lane/plan.
    pub requested_quantity_ids: &'a [QuantityId],
}

/// Canonical active spatial catalog for the resolved observation lane. Used
/// for admission budgets as well as completeness checks; no backend is created.
pub fn accepted_observation_quantity_ids(
    plan: &ExecutionPlanIR, lane: AcceptedMaterializationLane,
) -> Result<Vec<&'static str>, String> {
    let (ids, _) = requested_field_ids(&[])?;
    Ok(match (&plan.backend_plan, lane) {
        (BackendPlanIR::Fdm(plan), AcceptedMaterializationLane::FdmCpu) =>
            crate::quantities::active_fdm_preview_quantities(crate::dispatch::FdmEngine::CpuReference, plan, &ids),
        (BackendPlanIR::Fdm(plan), AcceptedMaterializationLane::FdmGpu) =>
            crate::quantities::active_fdm_preview_quantities(crate::dispatch::FdmEngine::CudaFdm, plan, &ids),
        (BackendPlanIR::FdmMultilayer(plan), AcceptedMaterializationLane::FdmCpu | AcceptedMaterializationLane::FdmGpu) =>
            crate::quantities::active_fdm_multilayer_preview_quantities(plan, &ids),
        (BackendPlanIR::Fem(plan), AcceptedMaterializationLane::FemCpu) =>
            crate::quantities::active_fem_preview_quantities(crate::dispatch::FemEngine::CpuNative, plan, &ids),
        (BackendPlanIR::Fem(plan), AcceptedMaterializationLane::FemGpu) =>
            crate::quantities::active_fem_preview_quantities(crate::dispatch::FemEngine::NativeGpu, plan, &ids),
        _ => return Err("observation lane differs from the execution plan".into()),
    })
}

/// Observations copied from the original solver handle, before its primary
/// inputs (drive clock, transport, thermal sample, constraints) are released.
/// This is not a restart checkpoint or an accepted-state identity. The worker
/// must bind it to the final immutable state before publishing it in CAS.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapturedSolverObservables {
    pub schema_version: String,
    pub carrier: crate::types::LiveMagnetizationCarrier,
    pub magnetization_values_sha256: String,
    pub fields: Vec<AcceptedMaterializedField>,
    pub energies: BTreeMap<String, f64>,
    pub evaluator_build_identity: Value,
}

/// Accept only complete fields with the producer's exact clock and carrier.
/// Sampled display previews and delayed fields from another step are skipped.
pub fn capture_solver_observables(
    update: &crate::types::StepUpdate,
) -> Result<Option<CapturedSolverObservables>, String> {
    let (Some(carrier), Some(m)) =
        (update.magnetization_carrier.as_ref(), update.magnetization.as_ref())
    else { return Ok(None); };
    carrier.source_clock.validate().map_err(|error| error.to_string())?;
    if carrier.source_clock.accepted_step != update.stats.step
        || carrier.source_clock.time_seconds.to_bits() != update.stats.time.to_bits()
        || carrier.source_clock.dt_seconds != (update.stats.dt > 0.0).then_some(update.stats.dt)
        || m.is_empty() || m.len() % 3 != 0 || m.iter().any(|value| !value.is_finite())
    { return Ok(None); }
    let backend = carrier.layout.get("backend").and_then(Value::as_str).unwrap_or_default();
    let (carrier_id, role) = match backend {
        "fdm" => ("fdm:magnetic", "magnetic"),
        "fdm_multilayer" => ("fdm_multilayer:native_layers", "layer_native"),
        "fem" if carrier.fem_local_node_map.is_some() => ("fem:local_nodes", "magnetic"),
        _ => return Ok(None),
    };
    let mut seen = BTreeSet::new();
    let mut fields = Vec::new();
    for snapshot in update.cached_preview_fields.iter().flatten().chain(update.preview_field.iter()) {
        let Ok(id) = crate::quantities::normalized_quantity_name(&snapshot.quantity) else { continue; };
        if seen.contains(id) || snapshot.source_step != carrier.source_clock.accepted_step
            || snapshot.source_time_seconds.map(f64::to_bits) != Some(carrier.source_clock.time_seconds.to_bits())
        { continue; }
        let Some(spec) = crate::quantities::quantity_spec(id) else { continue; };
        if id == "m" && (snapshot.vector_field_values.len() != m.len()
            || snapshot.vector_field_values.iter().zip(m).any(|(left, right)| left.to_bits() != right.to_bits()))
        { return Err("captured field generation has a different magnetization payload".into()); }
        if !crate::quantities::field_materialization_quantity_ids().contains(&id)
            || !matches!(spec.shape, QuantityShape::VectorField | QuantityShape::SpatialScalar)
        { continue; }
        let Ok(mut complete) = fields_from_preview(vec![snapshot.clone()], &[id],
            carrier.layout.clone(), carrier_id, role, m.len() / 3, carrier.source_clock)
        else { continue; };
        seen.insert(id);
        fields.append(&mut complete);
    }
    if fields.is_empty() { return Ok(None); }
    Ok(Some(CapturedSolverObservables {
        schema_version: "fullmag.captured_solver_observables.v1".into(),
        carrier: carrier.clone(),
        magnetization_values_sha256: crate::types::live_preview_values_sha256(m),
        fields,
        energies: energies_from_stats(&update.stats)?,
        evaluator_build_identity: crate::artifacts::build_identity_json(),
    }))
}

/// Bind original-context observations to the exact final accepted state.
/// Unlike reconstruction this preserves history-dependent primary inputs.
pub fn materialize_captured_observables(
    request: &AcceptedMaterializationRequest<'_>,
    capture: CapturedSolverObservables,
) -> Result<AcceptedMaterializationBatch, String> {
    validate_request(request)?;
    let flattened = request.magnetization.values.iter().flatten().copied().collect::<Vec<_>>();
    if capture.schema_version != "fullmag.captured_solver_observables.v1"
        || capture.carrier.layout != request.magnetization.layout
        || capture.carrier.source_clock != request.clock
        || capture.carrier.source_clock.digest().map_err(|error| error.to_string())?
            != request.source.id.clock_digest
        || capture.magnetization_values_sha256 != crate::types::live_preview_values_sha256(&flattened)
    { return Err("captured observations differ from the final accepted state or clock".into()); }
    // Exact layout validation also checks every multilayer offset and count.
    crate::materialize_study_magnetization_input(request.plan,
        &capture.carrier.layout, &request.magnetization.values).map_err(|error| error.to_string())?;
    if let BackendPlanIR::Fem(plan) = &request.plan.backend_plan {
        validate_fem_snapshot_identity(plan, request.magnetization, request.clock)?;
        let accepted_map = request.magnetization.native_node_map.as_ref()
            .ok_or_else(|| "accepted FEM node map missing".to_string())?;
        let captured_map = capture.carrier.fem_local_node_map.as_ref()
            .ok_or_else(|| "captured FEM node map missing".to_string())?;
        if captured_map.node_count != request.magnetization.values.len()
            || captured_map.local_node_index_map_sha256 != accepted_map.content_sha256().map_err(|error| error.to_string())?
            || captured_map.mesh_generation_id != crate::types::fem_plan_mesh_generation_id(plan)
        { return Err("captured FEM carrier differs from the accepted native map".into()); }
    } else if capture.carrier.fem_local_node_map.is_some() {
        return Err("FDM observations cannot use a FEM node map".into());
    }
    validate_provenance(request.magnetization, match request.lane {
        AcceptedMaterializationLane::FdmCpu => if matches!(request.plan.backend_plan, BackendPlanIR::FdmMultilayer(_)) { "cpu_reference_multilayer" } else { "fdm_cpu_reference" },
        AcceptedMaterializationLane::FdmGpu => if matches!(request.plan.backend_plan, BackendPlanIR::FdmMultilayer(_)) { "fdm_multilayer_cuda" } else { "fdm_cuda" },
        AcceptedMaterializationLane::FemCpu => "fem_cpu_native",
        AcceptedMaterializationLane::FemGpu => "fem_native_gpu",
    })?;
    let mut seen = BTreeSet::new();
    let (expected_carrier, expected_role) = match request.plan.backend_plan {
        BackendPlanIR::Fdm(_) => ("fdm:magnetic", "magnetic"),
        BackendPlanIR::FdmMultilayer(_) => ("fdm_multilayer:native_layers", "layer_native"),
        BackendPlanIR::Fem(_) => ("fem:local_nodes", "magnetic"),
        _ => return Err("captured observations have no accepted spatial carrier".into()),
    };
    for field in &capture.fields {
        let spec = crate::quantities::quantity_spec(&field.quantity_id)
            .ok_or_else(|| "captured quantity is unknown".to_string())?;
        if !matches!(spec.shape, QuantityShape::VectorField | QuantityShape::SpatialScalar)
            || field.n_comp != spec.n_comp as usize || field.n_comp == 0
            || field.values.len() != request.magnetization.values.len().saturating_mul(field.n_comp)
            || field.values.iter().any(|value| !value.is_finite())
            || field.layout != request.magnetization.layout
            || field.role != expected_role || field.carrier_id != expected_carrier
            || (field.quantity_id == "m" && field.values.iter().zip(&flattened)
                .any(|(left, right)| left.to_bits() != right.to_bits()))
            || !seen.insert(field.quantity_id.as_str())
        { return Err("captured field has an invalid or ambiguous carrier".into()); }
    }
    let (requested, implicit_default) = requested_field_ids(request.requested_quantity_ids)?;
    let active = accepted_observation_quantity_ids(request.plan, request.lane)?;
    for id in select_active_quantities(&requested, &active, implicit_default)? {
        if !seen.contains(id) { return Err(format!("captured solver omitted {id}")); }
    }
    if capture.energies.values().any(|value| !value.is_finite())
        || ["E_total", "E_ex", "E_demag", "E_ext", "E_ani", "E_dmi"].iter()
            .any(|id| !capture.energies.contains_key(*id))
    { return Err("captured energy decomposition is invalid".into()); }
    let mut batch = AcceptedMaterializationBatch {
        source: request.source.clone(), clock: request.clock,
        plan_sha256: request.accepted_plan_digest.into(), lane: request.lane,
        magnetization_content_sha256: request.magnetization.content_sha256.clone(),
        evaluator_build_identity: observation_evaluator_identity(&accepted_lane_input(request), capture.evaluator_build_identity),
        fields: capture.fields, unavailable_scopes: BTreeMap::new(), energies: capture.energies,
    };
    append_airbox_observations(&accepted_lane_input(request), &mut batch.fields, &mut batch.unavailable_scopes)?;
    Ok(batch)
}

pub fn materialize_accepted_observables(
    request: &AcceptedMaterializationRequest<'_>,
) -> Result<AcceptedMaterializationBatch, String> {
    validate_request(request)?;
    let input = accepted_lane_input(request);
    let observations = evaluate_lane_observables(&input)?;
    Ok(AcceptedMaterializationBatch {
        source: request.source.clone(),
        clock: request.clock,
        plan_sha256: request.source.id.plan_digest.clone(),
        lane: request.lane,
        magnetization_content_sha256: request.magnetization.content_sha256.clone(),
        evaluator_build_identity: observation_evaluator_identity(&input, crate::artifacts::build_identity_json()),
        fields: observations.fields,
        unavailable_scopes: observations.unavailable_scopes,
        energies: observations.energies,
    })
}

fn accepted_lane_input<'a>(request: &'a AcceptedMaterializationRequest<'a>) -> LaneObservationInput<'a> {
    LaneObservationInput {
        plan: request.plan,
        problem: request.problem,
        lane: request.lane,
        clock: request.clock,
        values: &request.magnetization.values,
        layout: &request.magnetization.layout,
        requested_quantity_ids: request.requested_quantity_ids,
        origin: ObservationOrigin::Accepted(request.magnetization),
    }
}

/// Where the evaluated magnetization came from. Only an accepted state carries
/// execution provenance and native snapshot receipts that must be verified; a
/// prepared initial state is the plan's own input, evaluated before any step.
pub(crate) enum ObservationOrigin<'a> {
    Accepted(&'a AcceptedMagnetizationInput),
    Prepared,
}

/// One observation-only evaluation of an exact magnetization on one lane.
pub(crate) struct LaneObservationInput<'a> {
    pub(crate) plan: &'a ExecutionPlanIR,
    pub(crate) problem: &'a ProblemIR,
    pub(crate) lane: AcceptedMaterializationLane,
    pub(crate) clock: ObservationClock,
    pub(crate) values: &'a [[f64; 3]],
    pub(crate) layout: &'a Value,
    /// Empty selects every active catalog field for this exact lane/plan.
    pub(crate) requested_quantity_ids: &'a [QuantityId],
    pub(crate) origin: ObservationOrigin<'a>,
}

impl LaneObservationInput<'_> {
    fn validate_engine(&self, expected_engine: &str) -> Result<(), String> {
        match self.origin {
            ObservationOrigin::Accepted(magnetization) => validate_provenance(magnetization, expected_engine),
            ObservationOrigin::Prepared => Ok(()),
        }
    }

    fn accepted_engine(&self) -> Result<&str, String> {
        match self.origin {
            ObservationOrigin::Accepted(magnetization) => magnetization.provenance
                .get("execution_engine").and_then(Value::as_str)
                .ok_or_else(|| "accepted GPU engine is missing".to_string()),
            // The multilayer CUDA engine variant is chosen while solving; a
            // prepared state has not resolved it yet.
            ObservationOrigin::Prepared => Err(
                "prepared-state evaluation does not support the multilayer CUDA lane".to_string(),
            ),
        }
    }
}

pub(crate) struct LaneObservations {
    pub(crate) fields: Vec<AcceptedMaterializedField>,
    pub(crate) unavailable_scopes: BTreeMap<String, String>,
    pub(crate) energies: BTreeMap<String, f64>,
}

/// Evaluate every requested active field and the global energies without
/// advancing a solver. The device follows the lane; there is no fallback.
pub(crate) fn evaluate_lane_observables(
    input: &LaneObservationInput<'_>,
) -> Result<LaneObservations, String> {
    let (requested, implicit_default) = requested_field_ids(input.requested_quantity_ids)?;
    // Reuse the runner's single canonical compatibility check and M installer.
    // Layout equality is exact; no field-order or cross-space inference happens here.
    let materialized_plan = crate::materialize_study_magnetization_input(
        input.plan,
        input.layout,
        input.values,
    )
    .map_err(|error| error.to_string())?;
    let mut fields = Vec::new();
    let mut unavailable_scopes = BTreeMap::new();
    let energies = match (&materialized_plan.backend_plan, input.lane) {
        (BackendPlanIR::Fdm(plan), AcceptedMaterializationLane::FdmCpu) => {
            input.validate_engine("fdm_cpu_reference")?;
            reject_missing_fdm_primary_inputs(plan, false)?;
            let active = crate::quantities::active_fdm_preview_quantities(
                crate::dispatch::FdmEngine::CpuReference,
                plan,
                &requested,
            );
            let selected = select_active_quantities(&requested, &active, implicit_default)?;
            let mut exact_plan = plan.clone();
            set_observation_time(&mut exact_plan.time_stage, input.clock.time_seconds);
            let preview_request = full_resolution_request();
            let snapshots = crate::fdm::cpu::reference::snapshot_vector_fields(
                &exact_plan,
                &selected,
                &preview_request,
            )
            .map_err(|error| error.to_string())?;
            fields.extend(fields_from_preview(
                snapshots,
                &selected,
                input.layout.clone(),
                "fdm:magnetic",
                "magnetic",
                product3_usize(exact_plan.grid.cells)?,
                input.clock,
            )?);
            let (problem, state) = crate::fdm::cpu::reference::build_snapshot_problem_and_state(
                &exact_plan,
            )
            .map_err(|error| error.to_string())?;
            let mut problem = problem;
            problem.terms.per_node_field =
                crate::fdm::cpu::reference::resolved_per_node_external_field_for_count(
                    &exact_plan,
                    state.magnetization().len(),
                    state.time_seconds,
                );
            let observables = crate::fdm::cpu::reference::observe_state(&problem, &state)
                .map_err(|error| error.to_string())?;
            energies_from_observables(&observables)?
        }
        (BackendPlanIR::Fdm(plan), AcceptedMaterializationLane::FdmGpu) => {
            input.validate_engine("fdm_cuda")?;
            reject_missing_fdm_primary_inputs(plan, true)?;
            let active = crate::quantities::active_fdm_preview_quantities(
                crate::dispatch::FdmEngine::CudaFdm,
                plan,
                &requested,
            );
            let selected = select_active_quantities(&requested, &active, implicit_default)?;
            #[cfg(feature = "cuda")]
            {
                let mut exact_plan = plan.clone();
                set_observation_time(&mut exact_plan.time_stage, input.clock.time_seconds);
                let mut backend = crate::fdm::gpu::cuda::native::NativeFdmBackend::create(&exact_plan)
                    .map_err(|error| error.to_string())?;
                backend
                    .upload_magnetization(input.values)
                    .map_err(|error| error.to_string())?;
                let stats = backend
                    .snapshot_step_stats(exact_plan.grid.cells)
                    .map_err(|error| error.to_string())?;
                let snapshots = selected
                    .iter()
                    .map(|quantity| {
                        backend
                            .copy_live_preview_field(
                                &request_for_quantity(quantity),
                                exact_plan.grid.cells,
                                exact_plan.active_mask.as_deref(),
                            )
                            .map_err(|error| error.to_string())
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                fields.extend(fields_from_preview(
                    snapshots,
                    &selected,
                    input.layout.clone(),
                    "fdm:magnetic",
                    "magnetic",
                    product3_usize(exact_plan.grid.cells)?,
                    input.clock,
                )?);
                energies_from_stats(&stats)?
            }
            #[cfg(not(feature = "cuda"))]
            {
                return Err("accepted FDM GPU materialization requires the CUDA feature".into());
            }
        }
        (BackendPlanIR::FdmMultilayer(plan), AcceptedMaterializationLane::FdmCpu) => {
            input.validate_engine("cpu_reference_multilayer")?;
            let active = crate::quantities::active_fdm_multilayer_preview_quantities(plan, &requested);
            let selected = select_active_quantities(&requested, &active, implicit_default)?;
            let exact_plan = plan.clone();
            let observables = crate::fdm::cpu::multilayer_reference::observe_accepted_state(
                &exact_plan,
                input.clock.time_seconds,
            )
            .map_err(|error| error.to_string())?;
            let snapshots = crate::fdm::cpu::multilayer_reference::snapshot_vector_fields(
                &exact_plan,
                &selected,
                &full_resolution_request(),
            )
            .map_err(|error| error.to_string())?;
            let sample_count = input.values.len();
            fields.extend(fields_from_preview(
                snapshots,
                &selected,
                input.layout.clone(),
                "fdm_multilayer:native_layers",
                "layer_native",
                sample_count,
                input.clock,
            )?);
            let energies = energies_from_observables(&observables)?;
            energies
        }
        (BackendPlanIR::FdmMultilayer(plan), AcceptedMaterializationLane::FdmGpu) => {
            input.validate_engine("fdm_multilayer_cuda")?;
            let actual_engine = input.accepted_engine()?;
            let active = crate::quantities::active_fdm_multilayer_preview_quantities(plan, &requested);
            let selected = select_active_quantities(&requested, &active, implicit_default)?;
            #[cfg(feature = "cuda")]
            {
                let exact_plan = plan.clone();
                let (observables, snapshots) = crate::fdm::gpu::cuda::multilayer::snapshot_accepted_multilayer_observables(
                    &exact_plan,
                    input.values,
                    &selected,
                    actual_engine,
                ).map_err(|error| error.to_string())?;
                fields.extend(fields_from_preview(
                    snapshots,
                    &selected,
                    input.layout.clone(),
                    "fdm_multilayer:native_layers",
                    "layer_native",
                    input.values.len(),
                    input.clock,
                )?);
                energies_from_observables(&observables)?
            }
            #[cfg(not(feature = "cuda"))]
            {
                let _ = (actual_engine, selected);
                return Err("accepted FDM multilayer GPU materialization requires the CUDA feature".into());
            }
        }
        (BackendPlanIR::Fem(plan), lane @ (AcceptedMaterializationLane::FemCpu | AcceptedMaterializationLane::FemGpu)) => {
            let gpu = lane == AcceptedMaterializationLane::FemGpu;
            if let ObservationOrigin::Accepted(magnetization) = input.origin {
                validate_fem_snapshot_identity(plan, magnetization, input.clock)?;
            }
            input.validate_engine(if gpu { "fem_native_gpu" } else { "fem_cpu_native" })?;
            reject_missing_fem_primary_inputs(plan)?;
            let active = crate::quantities::active_fem_preview_quantities(
                if gpu { crate::dispatch::FemEngine::NativeGpu } else { crate::dispatch::FemEngine::CpuNative },
                plan,
                &requested,
            );
            let selected = select_active_quantities(&requested, &active, implicit_default)?;
            #[cfg(feature = "fem-native")]
            {
                if gpu && !cfg!(feature = "fem-gpu") {
                    return Err("accepted FEM GPU materialization requires the fem-gpu feature".into());
                }
                let mut exact_plan = plan.clone();
                if exact_plan.mfem_device_string.is_none() {
                    exact_plan.mfem_device_string = Some(if gpu { "cuda" } else { "cpu" }.into());
                }
                if crate::native_fem::native_fem_mfem_device_string_requests_gpu(
                    exact_plan.mfem_device_string.as_deref().unwrap_or("cpu"),
                ) != gpu {
                    return Err("accepted FEM materializer device differs from the accepted lane".into());
                }
                let mut backend = if gpu {
                    crate::native_fem::NativeFemBackend::create(&exact_plan)
                } else {
                    crate::native_fem::NativeFemBackend::create_cpu_with_initial_effective_field(&exact_plan, true)
                }.map_err(|error| error.to_string())?;
                if gpu {
                    backend.set_gpu_execution_request(true).map_err(|error| error.to_string())?;
                }
                // A prepared state is the plan's own nodal input, so it shares
                // the materializer mesh by construction; only an accepted state
                // must prove its native map and representation match.
                if let ObservationOrigin::Accepted(magnetization) = input.origin {
                    let accepted_map = magnetization
                        .native_node_map
                        .as_ref()
                        .ok_or_else(|| "accepted native FEM node map is missing".to_string())?;
                    let observed_map = backend.local_node_index_map().map_err(|error| error.to_string())?;
                    if &observed_map != accepted_map {
                        return Err("accepted FEM node map differs from the materializer mesh".into());
                    }
                    let observed_representation = backend.representation_receipt().map_err(|error| error.to_string())?;
                    let claimed = &magnetization.native_state_snapshot
                        .as_ref().ok_or_else(|| "accepted native FEM snapshot receipt is missing".to_string())?
                        .representation;
                    if observed_representation.state_space != claimed.state_space
                        || observed_representation.local_node_count != claimed.local_node_count
                        || observed_representation.true_node_count != claimed.true_node_count
                        || observed_representation.periodic_map_revision != claimed.periodic_map_revision
                    {
                        return Err("accepted FEM representation differs from the materializer mesh".into());
                    }
                } else if input.values.len() != exact_plan.mesh.nodes.len() {
                    return Err("prepared FEM magnetization does not cover the resolved mesh".into());
                }
                backend.upload_magnetization(input.values)
                    .map_err(|error| error.to_string())?;
                let node_count = exact_plan.mesh.nodes.len();
                let stats = backend.snapshot_step_stats(node_count).map_err(|error| error.to_string())?;
                let snapshots = selected.iter().map(|quantity| {
                    backend.copy_live_preview_field(&request_for_quantity(quantity), node_count)
                        .map_err(|error| error.to_string())
                }).collect::<Result<Vec<_>, _>>()?;
                // The execution receipt is resolved during RK stepping, so it
                // cannot attest a fresh observation-only context. Read the
                // actual native device and operator configuration instead;
                // never manufacture an accepted solver step for this check.
                let observed_device = backend.device_info().map_err(|error| error.to_string())?;
                let observed_operators = backend.gpu_rk_plan_info().map_err(|error| error.to_string())?;
                if observed_device.is_gpu_enabled != gpu
                    || (gpu && (!observed_operators.uses_cuda_kernels
                        || observed_operators.allows_exchange_host_sync
                        || !crate::dispatch::native_fem_gpu_rk_plan_is_device_resident_for_plan(
                            &exact_plan, &observed_operators,
                        ))) {
                    return Err("accepted FEM observation evaluator changed its execution lane".into());
                }
                fields.extend(fields_from_preview(
                    snapshots,
                    &selected,
                    input.layout.clone(),
                    "fem:local_nodes",
                    "magnetic",
                    node_count,
                    input.clock,
                )?);
                energies_from_stats(&stats)?
            }
            #[cfg(not(feature = "fem-native"))]
            {
                return Err("accepted native FEM materialization requires the fem-native feature".into());
            }
        }
        _ => return Err("accepted materialization lane does not match the resolved plan".into()),
    };

    if fields.is_empty() {
        return Err("accepted materialization produced no spatial fields".into());
    }
    append_airbox_observations(input, &mut fields, &mut unavailable_scopes)?;
    Ok(LaneObservations { fields, unavailable_scopes, energies })
}

fn validate_request(request: &AcceptedMaterializationRequest<'_>) -> Result<(), String> {
    request.source.validate().map_err(|error| error.to_string())?;
    request.clock.validate().map_err(|error| error.to_string())?;
    if request.source.id.accepted_step != request.clock.accepted_step
        || request.source.id.clock_digest != request.clock.digest().map_err(|error| error.to_string())?
    {
        return Err("accepted materialization clock differs from the source identity".into());
    }
    if !fullmag_quantities::is_canonical_sha256(request.accepted_plan_digest)
        || request.source.id.plan_digest != request.accepted_plan_digest
    {
        return Err("accepted materialization plan digest differs from the source identity".into());
    }
    // CAS content addresses are the runner/application raw 64-hex form; state
    // identity digests use the `sha256:`-prefixed wire form above.
    if !fullmag_quantities::is_canonical_sha256(&format!(
        "sha256:{}",
        request.magnetization.content_sha256
    )) {
        return Err("accepted magnetization content digest is invalid".into());
    }
    if request.magnetization.values.is_empty()
        || request.magnetization.values.iter().flatten().any(|value| !value.is_finite())
    {
        return Err("accepted magnetization must contain finite three-component samples".into());
    }
    if request.magnetization.provenance.get("execution_engine").and_then(Value::as_str).is_none()
        || request.magnetization.layout.get("backend").and_then(Value::as_str).is_none()
    {
        return Err("accepted state is missing backend layout or execution provenance".into());
    }
    Ok(())
}

pub(crate) fn observation_evaluator_identity(
    input: &LaneObservationInput<'_>, mut identity: Value,
) -> Value {
    if input.lane == AcceptedMaterializationLane::FdmGpu
        && matches!(input.plan.backend_plan, BackendPlanIR::FdmMultilayer(_)) {
        // The GPU Solve identity remains unchanged. Derived visualization
        // components/densities are explicitly host-postprocessed from that
        // execution's exact M and component fields, not a new CPU trajectory.
        let postprocessing = json!({
            "execution_engine": input.accepted_engine().ok(),
            "carrier": "exact_native_layers",
            "host_postprocessed_quantities": ["H_ani_cubic", "H_dmi_bulk", "eden_ex",
                "eden_demag", "eden_ext", "eden_ani", "eden_dmi", "eden_rotated_dmi",
                "eden_total", "mat_ms", "mat_aex", "mat_alpha"],
            "time_domain_steps_performed": 0,
            "host_solver_fallback": false,
        });
        if let Some(object) = identity.as_object_mut() {
            object.insert("observation_postprocessing".into(), postprocessing);
        } else {
            identity = json!({"build_identity": identity,
                "observation_postprocessing": postprocessing});
        }
    }
    identity
}

fn requested_field_ids(requested: &[QuantityId]) -> Result<(Vec<&'static str>, bool), String> {
    let allowed = crate::quantities::field_materialization_quantity_ids();
    let implicit_default = requested.is_empty();
    let ids: Vec<&'static str> = if implicit_default {
        allowed
            .iter()
            .copied()
            .filter(|id| {
                crate::quantities::quantity_spec(id).is_some_and(|spec| {
                    matches!(spec.shape, QuantityShape::VectorField | QuantityShape::SpatialScalar)
                })
            })
            .collect::<Vec<_>>()
    } else {
        requested.iter().map(|id| id.as_str()).collect::<Vec<_>>()
    };
    let mut seen = BTreeSet::new();
    let mut result = Vec::new();
    for id in ids {
        let spec = crate::quantities::quantity_spec(id)
            .ok_or_else(|| format!("accepted quantity '{id}' has no canonical catalog entry"))?;
        if !allowed.contains(&id)
            || !matches!(spec.shape, QuantityShape::VectorField | QuantityShape::SpatialScalar)
        {
            return Err(format!("accepted quantity '{id}' is not a materializable spatial field"));
        }
        if !seen.insert(id) {
            return Err(format!("accepted quantity '{id}' was requested more than once"));
        }
        result.push(id);
    }
    Ok((result, implicit_default))
}

fn select_active_quantities(
    requested: &[&'static str],
    active: &[&'static str],
    implicit_default: bool,
) -> Result<Vec<&'static str>, String> {
    if implicit_default {
        if active.is_empty() {
            return Err("accepted materialization has no active spatial quantities for this plan/lane".into());
        }
        return Ok(active.to_vec());
    }
    let active_set = active.iter().copied().collect::<BTreeSet<_>>();
    if let Some(id) = requested.iter().find(|id| !active_set.contains(**id)) {
        return Err(format!("accepted quantity '{id}' is inactive or unsupported for this plan/lane"));
    }
    Ok(requested.to_vec())
}

fn validate_provenance(
    input: &AcceptedMagnetizationInput,
    expected_engine: &str,
) -> Result<(), String> {
    validate_execution_engine_provenance(&input.provenance, expected_engine)
}

/// Validate the actual engine and precision recorded by an accepted state
/// against the runner's resolution of its exact backend plan. This keeps the
/// provenance aliases in one runner-owned place and rejects plan/lane pairs
/// that the runtime resolver cannot produce.
pub fn validate_accepted_state_execution_provenance(
    plan: &BackendPlanIR,
    engine: RuntimeEngineId,
    provenance: &Value,
) -> Result<(), String> {
    let (expected_engine, expected_precision) = match (plan, engine) {
        (BackendPlanIR::Fdm(plan), RuntimeEngineId::FdmCpuReference) => {
            ("fdm_cpu_reference", plan.precision)
        }
        (BackendPlanIR::Fdm(plan), RuntimeEngineId::FdmCuda) => ("fdm_cuda", plan.precision),
        (BackendPlanIR::FdmMultilayer(plan), RuntimeEngineId::FdmCpuReference) => {
            ("cpu_reference_multilayer", plan.precision)
        }
        (BackendPlanIR::FdmMultilayer(plan), RuntimeEngineId::FdmCuda) => {
            ("fdm_multilayer_cuda", plan.precision)
        }
        (BackendPlanIR::Fem(plan), RuntimeEngineId::FemCpuNative) => {
            ("fem_cpu_native", plan.precision)
        }
        (BackendPlanIR::Fem(plan), RuntimeEngineId::FemNativeGpu) => {
            ("fem_native_gpu", plan.precision)
        }
        _ => {
            return Err("accepted state engine is incompatible with its resolved backend plan".into())
        }
    };

    validate_execution_engine_provenance(provenance, expected_engine)?;
    let expected_precision = match expected_precision {
        fullmag_ir::ExecutionPrecision::Single => "single",
        fullmag_ir::ExecutionPrecision::Double => "double",
    };
    let actual_precision = provenance
        .get("precision")
        .and_then(Value::as_str)
        .ok_or_else(|| "accepted state provenance has no actual precision".to_string())?;
    if actual_precision != expected_precision {
        return Err(format!(
            "accepted state precision '{actual_precision}' differs from resolved plan precision '{expected_precision}'"
        ));
    }
    Ok(())
}

fn validate_execution_engine_provenance(
    provenance: &Value,
    expected_engine: &str,
) -> Result<(), String> {
    let actual = provenance
        .get("execution_engine")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let matches_lane = match expected_engine {
        "fdm_cpu_reference" => matches!(actual, "cpu_reference" | "fdm_cpu_reference"),
        "fdm_cuda" => matches!(actual, "cuda_fdm" | "fdm_cuda"),
        "fdm_multilayer_cuda" => matches!(
            actual,
            "cuda_native_multilayer_convolution" | "cuda_native_multilayer_single_grid"
                | "cuda_assisted_multilayer"
        ),
        other => actual == other,
    };
    if !matches_lane {
        return Err(format!(
            "accepted state engine '{actual}' differs from requested lane '{expected_engine}'"
        ));
    }
    Ok(())
}

fn validate_fem_snapshot_identity(
    plan: &fullmag_ir::FemPlanIR, input: &AcceptedMagnetizationInput, clock: ObservationClock,
) -> Result<(), String> {
    let node_count = plan.mesh.nodes.len();
    let receipt = input.native_state_snapshot.as_ref()
        .ok_or_else(|| "accepted native FEM snapshot receipt is missing".to_string())?;
    let map = input.native_node_map.as_ref()
        .ok_or_else(|| "accepted native FEM node map is missing".to_string())?;
    receipt.validate_snapshot(
        clock.accepted_step,
        clock.time_seconds,
        clock.dt_seconds.unwrap_or(0.0),
        &input.values,
    ).map_err(|error| error.to_string())?;
    receipt.validate_node_map(Some(map)).map_err(|error| error.to_string())?;
    map.validate().map_err(|error| error.to_string())?;
    if usize::try_from(map.local_node_count).ok() != Some(node_count) {
        return Err("accepted FEM node map does not cover the resolved mesh".into());
    }
    Ok(())
}

fn reject_missing_fdm_primary_inputs(plan: &fullmag_ir::FdmPlanIR, gpu: bool) -> Result<(), String> {
    if !plan.spin_transport_plans.is_empty() || !plan.fdm_gpu_charge_transports.is_empty() {
        return Err("accepted FDM field materialization requires additional accepted transport carriers".into());
    }
    if plan.temperature.is_some_and(|value| value > 0.0) {
        return Err("accepted FDM materialization cannot reconstruct the accepted thermal realization".into());
    }
    if !plan.antenna_zeeman_masks.is_empty() || !plan.solved_antenna_drive_bases.is_empty() {
        return Err("accepted FDM materialization cannot reconstruct accepted antenna state".into());
    }
    if plan.frozen_spins.is_some() {
        return Err("accepted FDM materialization cannot reconstruct the original Frozen Spins activation reference".into());
    }
    if gpu && !plan.field_drives.is_empty() {
        return Err("accepted FDM GPU materialization cannot evaluate time-dependent field drives at the accepted clock".into());
    }
    Ok(())
}

fn reject_missing_fem_primary_inputs(plan: &fullmag_ir::FemPlanIR) -> Result<(), String> {
    if !plan.field_drives.is_empty() || !plan.antenna_zeeman_masks.is_empty()
        || !plan.solved_antenna_drive_bases.is_empty() || !plan.current_modules.is_empty()
        || !plan.spin_transport_plans.is_empty() || !plan.charge_transport_plans.is_empty()
    {
        return Err("accepted FEM materialization cannot reconstruct dynamic drive/current carriers".into());
    }
    if plan.frozen_spins.is_some() {
        return Err("accepted FEM materialization cannot reconstruct the original Frozen Spins activation reference".into());
    }
    if plan.temperature.is_some_and(|value| value > 0.0) {
        return Err("accepted FEM materialization cannot reconstruct the accepted thermal realization".into());
    }
    Ok(())
}

fn set_observation_time(stage: &mut fullmag_ir::TimeStageContextIR, time_seconds: f64) {
    let origin = stage.waveform_origin_time_s();
    stage.start_time_s = time_seconds;
    stage.waveform_origin_time_s = Some(origin);
}

fn full_resolution_request() -> crate::types::LivePreviewRequest {
    crate::types::LivePreviewRequest {
        revision: 0,
        quantity: "m".into(),
        component: "3D".into(),
        layer: 0,
        all_layers: true,
        every_n: 1,
        x_chosen_size: 0,
        y_chosen_size: 0,
        auto_scale_enabled: false,
        max_points: u32::MAX,
    }
}

fn request_for_quantity(quantity: &str) -> crate::types::LivePreviewRequest {
    crate::types::LivePreviewRequest { quantity: quantity.into(), ..full_resolution_request() }
}

fn fields_from_preview(
    snapshots: Vec<LivePreviewField>,
    requested: &[&str],
    layout: Value,
    carrier_id: &str,
    role: &str,
    sample_count: usize,
    clock: ObservationClock,
) -> Result<Vec<AcceptedMaterializedField>, String> {
    if snapshots.len() != requested.len() {
        return Err(format!("snapshot evaluator returned {} fields for {} requested quantities", snapshots.len(), requested.len()));
    }
    let mut fields = Vec::with_capacity(snapshots.len());
    let mut seen = BTreeSet::new();
    for mut snapshot in snapshots {
        let id = crate::quantities::normalized_quantity_name(&snapshot.quantity)
            .map_err(|error| error.to_string())?;
        if !requested.contains(&id) || !seen.insert(id) {
            return Err(format!("snapshot evaluator returned unexpected or duplicate quantity '{id}'"));
        }
        let spec: &'static QuantitySpec = crate::quantities::quantity_spec(id)
            .ok_or_else(|| format!("snapshot quantity '{id}' has no catalog spec"))?;
        let expected = sample_count.checked_mul(spec.n_comp as usize)
            .ok_or_else(|| format!("quantity '{id}' value count overflows"))?;
        let full_layout = if layout.get("backend").and_then(Value::as_str) == Some("fem") {
            matches!(snapshot.spatial_kind.as_str(), "mesh"
                | "fem_nodal_conservative_tetra_projection" | "fem_nodal_visualization_projection")
                && snapshot.original_grid == [0, 0, 0]
                && u32::try_from(sample_count).ok().is_some_and(|count| snapshot.preview_grid == [count, 1, 1])
        } else {
            snapshot.preview_grid == snapshot.original_grid
        };
        if spec.n_comp == 0 || snapshot.vector_field_values.len() != expected
            || !full_layout || snapshot.auto_downscaled || snapshot.applied_layer_stride > 1
            || snapshot.vector_field_values.iter().any(|value| !value.is_finite())
        {
            return Err(format!("snapshot quantity '{id}' is not a complete finite carrier"));
        }
        snapshot.source_step = clock.accepted_step;
        snapshot.source_time_seconds = Some(clock.time_seconds);
        fields.push(AcceptedMaterializedField {
            quantity_id: id.into(),
            carrier_id: carrier_id.into(),
            role: role.into(),
            n_comp: spec.n_comp as usize,
            values: snapshot.vector_field_values,
            layout: layout.clone(),
            spatial_kind: Some(snapshot.spatial_kind),
        });
    }
    for id in requested {
        if !seen.contains(id) { return Err(format!("snapshot evaluator omitted requested quantity '{id}'")); }
    }
    Ok(fields)
}

fn airbox_materialized_fields(artifacts: Vec<crate::types::AuxiliaryArtifact>) -> Result<Vec<AcceptedMaterializedField>, String> {
    let mut groups = BTreeMap::<String, Vec<crate::types::AuxiliaryArtifact>>::new();
    for artifact in artifacts {
        for quantity in ["H_demag", "H_eff"] {
            if artifact.relative_path.starts_with(&format!("fields/{quantity}/airbox/")) {
                groups.entry(quantity.into()).or_default().push(artifact);
                break;
            }
        }
    }
    if !groups.contains_key("H_demag") { return Err("Airbox materializer omitted H_demag".into()); }
    groups.into_iter().map(|(quantity, artifacts)| airbox_quantity_field(artifacts, &quantity)).collect()
}

fn airbox_quantity_field(artifacts: Vec<crate::types::AuxiliaryArtifact>, quantity: &str) -> Result<AcceptedMaterializedField, String> {
    let mut manifest_bytes = None;
    let mut field_bytes = None;
    for artifact in artifacts {
        if artifact.relative_path == format!("fields/{quantity}/airbox/manifest.json") {
            manifest_bytes = Some(artifact.bytes);
        } else if artifact.relative_path == format!("fields/{quantity}/airbox/{quantity}.samples.v1.json") {
            field_bytes = Some(artifact.bytes);
        }
    }
    let manifest_raw = manifest_bytes.ok_or_else(|| "Airbox materializer omitted its manifest".to_string())?;
    let field_raw = field_bytes.ok_or_else(|| "Airbox materializer omitted its H_demag samples".to_string())?;
    let field_artifact_json = String::from_utf8(field_raw.clone()).map_err(|_| "Airbox field artifact is not UTF-8".to_string())?;
    let manifest: Value = serde_json::from_slice(&manifest_raw).map_err(|error| format!("parse Airbox manifest: {error}"))?;
    let field_artifact: Value = serde_json::from_slice(&field_raw).map_err(|error| format!("parse Airbox field artifact: {error}"))?;
    let artifact_hash = fullmag_session::hex_sha256(&field_raw);
    if !matches!(manifest.get("schema_version").and_then(Value::as_str),
        Some("fdm_multilayer_observation.v1" | "fdm_multilayer_observation.v2"))
        || field_artifact.get("schema_version").and_then(Value::as_str) != Some("fdm_multilayer_observation_field.v1")
        || manifest.get("field_artifact_sha256").and_then(Value::as_str) != Some(artifact_hash.as_str())
        || manifest.get("unit").and_then(Value::as_str) != Some("A/m")
        || field_artifact.get("unit").and_then(Value::as_str) != Some("A/m")
        || field_artifact.get("observable").and_then(Value::as_str) != Some(quantity)
        || manifest.get("grid") != field_artifact.get("grid") {
        return Err("Airbox artifact hash, schema, grid or units differ from its manifest".into());
    }
    if manifest.get("scope_kind").and_then(Value::as_str) != Some("airbox")
        || manifest.get("quantity_id").and_then(Value::as_str) != Some(quantity)
        || manifest.get("target_only").and_then(Value::as_bool) != Some(true)
        || field_artifact.get("scope_kind").and_then(Value::as_str) != Some("airbox")
        || field_artifact.get("quantity_id").and_then(Value::as_str) != Some(quantity)
    {
        return Err("Airbox materializer returned a non-target or non-H_demag carrier".into());
    }
    let values: Vec<[f64; 3]> = serde_json::from_value(field_artifact.get("values").cloned()
        .ok_or_else(|| "Airbox field artifact has no values".to_string())?)
        .map_err(|error| format!("decode Airbox H_demag values: {error}"))?;
    if values.is_empty() || values.iter().flatten().any(|value| !value.is_finite())
        || manifest.get("sample_count").and_then(Value::as_u64) != Some(values.len() as u64)
    {
        return Err("Airbox H_demag sample payload is incomplete or nonfinite".into());
    }
    let field_generation = manifest.get("field_generation").and_then(Value::as_str)
        .filter(|value| !value.is_empty()).ok_or_else(|| "Airbox carrier generation is missing".to_string())?;
    let grid = manifest.get("grid").cloned().ok_or_else(|| "Airbox target grid is missing".to_string())?;
    let count = grid.get("cells").and_then(Value::as_array).filter(|axes| axes.len() == 3)
        .and_then(|axes| axes.iter().try_fold(1_u64, |count, axis| {
            let axis = axis.as_u64().filter(|axis| *axis > 0)?;
            count.checked_mul(axis)
        })).ok_or_else(|| "Airbox grid cell count is invalid".to_string())?;
    if count != values.len() as u64 { return Err("Airbox grid count differs from values".into()); }
    let values = values.into_iter().flatten().collect::<Vec<_>>();
    let values_hash = crate::types::live_preview_values_sha256(&values);
    Ok(AcceptedMaterializedField {
        quantity_id: quantity.into(),
        carrier_id: field_generation.into(),
        role: "airbox".into(),
        n_comp: 3,
        values,
        layout: json!({
            "manifest": manifest,
            "field_artifact": field_artifact,
            "field_artifact_json": field_artifact_json,
            "validated_field_artifact_sha256": artifact_hash,
            "validated_field_values_sha256": values_hash,
            "grid": grid,
        }),
        spatial_kind: Some("fdm_multilayer_airbox".into()),
    })
}

fn append_airbox_observations(
    input: &LaneObservationInput<'_>,
    fields: &mut Vec<AcceptedMaterializedField>,
    unavailable: &mut BTreeMap<String, String>,
) -> Result<(), String> {
    if !matches!(&input.plan.backend_plan, BackendPlanIR::FdmMultilayer(_))
        || !crate::fdm::cpu::airbox_observation::airbox_observation_requested(input.problem)
        || !fields.iter().any(|field| field.quantity_id == "H_demag")
    { return Ok(()); }
    let plan = crate::materialize_study_magnetization_input(input.plan,
        input.layout, input.values).map_err(|error| error.to_string())?;
    let BackendPlanIR::FdmMultilayer(plan) = &plan.backend_plan else { return Ok(()); };
    let artifacts = match input.lane {
        AcceptedMaterializationLane::FdmCpu =>
            crate::fdm::cpu::airbox_observation::materialize_airbox_observation_snapshot(input.problem, plan),
        AcceptedMaterializationLane::FdmGpu => {
            #[cfg(feature = "cuda")]
            {
                let engine = input.accepted_engine()?;
                crate::fdm::gpu::cuda::multilayer::materialize_airbox_observation_snapshot_gpu(
                    input.problem, plan, engine,
                ).map_err(|error| error.to_string())
            }
            #[cfg(not(feature = "cuda"))]
            { Err("accepted Airbox GPU observation requires the CUDA feature".into()) }
        }
        _ => return Err("multilayer Airbox observation has an invalid lane".into()),
    };
    match artifacts.and_then(airbox_materialized_fields) {
        Ok(airbox_fields) => fields.extend(airbox_fields),
        Err(error) => { unavailable.insert("airbox:H_demag".into(), error); }
    }
    Ok(())
}

fn energies_from_observables(observables: &crate::types::StateObservables) -> Result<BTreeMap<String, f64>, String> {
    let values = [
        (QuantityId::EEx, observables.exchange_energy),
        (QuantityId::EDemag, observables.demag_energy),
        (QuantityId::EExt, observables.external_energy),
        (QuantityId::EDrive, observables.drive_energy),
        (QuantityId::EAni, observables.anisotropy_energy),
        (QuantityId::EDmi, observables.dmi_energy),
        (QuantityId::ERotatedDmi, observables.rotated_dmi_energy),
        (QuantityId::ETotal, observables.total_energy),
    ];
    energy_map(values)
}

fn energies_from_stats(stats: &crate::types::StepStats) -> Result<BTreeMap<String, f64>, String> {
    energy_map([
        (QuantityId::EEx, stats.e_ex),
        (QuantityId::EDemag, stats.e_demag),
        (QuantityId::EExt, stats.e_ext),
        (QuantityId::EDrive, stats.e_drive),
        (QuantityId::EAni, stats.e_ani),
        (QuantityId::EDmi, stats.e_dmi),
        (QuantityId::ERotatedDmi, stats.e_rotated_dmi),
        (QuantityId::ETotal, stats.e_total),
    ])
}

fn energy_map(values: [(QuantityId, f64); 8]) -> Result<BTreeMap<String, f64>, String> {
    let mut result = BTreeMap::new();
    for (id, value) in values {
        if !value.is_finite() { return Err(format!("accepted energy '{}' is nonfinite", id.as_str())); }
        result.insert(id.as_str().into(), value);
    }
    for required in [QuantityId::ETotal, QuantityId::EEx, QuantityId::EDemag, QuantityId::EExt, QuantityId::EAni, QuantityId::EDmi] {
        if !result.contains_key(required.as_str()) { return Err(format!("accepted energy '{}' is missing", required.as_str())); }
    }
    Ok(result)
}

fn product3(values: [u32; 3]) -> Result<u64, String> {
    values.into_iter().try_fold(1u64, |product, value| {
        if value == 0 { return None; }
        product.checked_mul(u64::from(value))
    }).ok_or_else(|| "accepted field grid size is zero or overflows".into())
}

fn product3_usize(values: [u32; 3]) -> Result<usize, String> {
    usize::try_from(product3(values)?).map_err(|_| "accepted field grid exceeds addressable memory".into())
}
