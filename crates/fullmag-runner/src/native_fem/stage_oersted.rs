//! Rust-side adapter for the native CPU stage Oersted callback.
//!
//! The numerical solve remains owned by `steady_transport`; this module only
//! owns the C ABI lifetime, stage identity, attempt transaction and the small
//! amount of provenance needed to reject a partial publication.

use super::stage_coupled::{StageM2CoupledProvider, FEM_STAGE_TRANSPORT_OERSTED_CALLBACK_POLICY};
use super::steady_transport::{
    preflight_transport_plans, solve_native_fem_steady_transport_rt0,
    NativeFemSteadyTransportOerstedMethod, NativeFemSteadyTransportRequest,
};
use crate::time_envelope::evaluate_time_envelope;
use crate::types::RunError;
use fullmag_fem_sys as ffi;
use fullmag_ir::{FemPlanIR, ResolvedFemConservativeCurrentViewIR, TimeEnvelopeIR};
use sha2::{Digest, Sha256};
use std::ffi::{c_char, c_void};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr;

pub(crate) const FEM_STAGE_OERSTED_CALLBACK_POLICY: &str = "fem_stage_oersted_callback.v1";

pub(crate) fn plan_requests_stage_oersted_callback(plan: &FemPlanIR) -> bool {
    plan.spin_transport_plans.iter().any(|transport| {
        transport.fem_cpu_double.as_ref().is_some_and(|descriptor| {
            matches!(
                descriptor.stage_coupling.as_str(),
                FEM_STAGE_OERSTED_CALLBACK_POLICY | FEM_STAGE_TRANSPORT_OERSTED_CALLBACK_POLICY
            )
        })
    })
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub(crate) struct StageOerstedObservation {
    pub stage_identity: u64,
    pub evaluation_time_s: f64,
    pub envelope_multiplier: f64,
    pub source_state_revision: u64,
    pub source_view_identity_digest: String,
    pub field_sha256: String,
}

pub(crate) struct StageOerstedProvider {
    request_template: NativeFemSteadyTransportRequest,
    view_template: Option<ResolvedFemConservativeCurrentViewIR>,
    coupled_evaluator: Option<StageM2CoupledProvider>,
    time_envelope: Option<TimeEnvelopeIR>,
    method: NativeFemSteadyTransportOerstedMethod,
    target_points: Option<Vec<[f64; 3]>>,
    attempt_active: bool,
    pending_observation: Option<StageOerstedObservation>,
    accepted_observation: Option<StageOerstedObservation>,
    last_observation: Option<StageOerstedObservation>,
    begin_count: u64,
    commit_count: u64,
    rollback_count: u64,
    evaluate_count: u64,
}

impl StageOerstedProvider {
    pub(crate) fn from_plan(plan: &FemPlanIR) -> Result<Option<Self>, RunError> {
        Self::from_plan_with_coupled(plan, None)
    }

    pub(crate) fn from_plan_with_coupled(
        plan: &FemPlanIR,
        coupled_evaluator: Option<StageM2CoupledProvider>,
    ) -> Result<Option<Self>, RunError> {
        if !plan_requests_stage_oersted_callback(plan) {
            return Ok(None);
        }
        let Some(prepared) = preflight_transport_plans(plan)?.into_iter().next() else {
            return Ok(None);
        };
        let Some(descriptor) = prepared.resolved.fem_cpu_double.as_ref() else {
            return Ok(None);
        };
        let is_combined = descriptor.stage_coupling == FEM_STAGE_TRANSPORT_OERSTED_CALLBACK_POLICY;
        if !is_combined && descriptor.stage_coupling != FEM_STAGE_OERSTED_CALLBACK_POLICY {
            return Ok(None);
        }
        if is_combined && coupled_evaluator.is_none() {
            return Err(RunError {
                message: "combined FEM M2 stage Oersted callback was requested but its shared evaluator could not be materialized".into(),
            });
        }
        let view = if is_combined {
            None
        } else {
            Some(
                descriptor
                    .conservative_current_view
                    .clone()
                    .ok_or_else(|| RunError {
                        message:
                            "FEM stage Oersted callback requires a resolved conservative RT0 view"
                                .into(),
                    })?,
            )
        };
        let time_envelope = descriptor.time_envelope.clone();
        let method = match plan.oersted_realization {
            Some(fullmag_ir::OerstedRealization::FemVectorPotential) => {
                NativeFemSteadyTransportOerstedMethod::FemVectorPotential
            }
            _ => NativeFemSteadyTransportOerstedMethod::DirectTetraQuadrature,
        };
        let target_points = match method {
            NativeFemSteadyTransportOerstedMethod::DirectTetraQuadrature => {
                Some(plan.mesh.nodes.clone())
            }
            // OE-F2 publishes the nodal H1 projection even when no explicit
            // point list is requested; `Some(empty)` selects that ABI branch.
            NativeFemSteadyTransportOerstedMethod::FemVectorPotential => Some(Vec::new()),
        };
        Ok(Some(Self {
            request_template: prepared.request,
            view_template: view,
            coupled_evaluator,
            time_envelope,
            method,
            target_points,
            attempt_active: false,
            pending_observation: None,
            accepted_observation: None,
            last_observation: None,
            begin_count: 0,
            commit_count: 0,
            rollback_count: 0,
            evaluate_count: 0,
        }))
    }

    pub(crate) fn callback(&mut self) -> ffi::fullmag_fem_stage_oersted_callback_v1 {
        ffi::fullmag_fem_stage_oersted_callback_v1 {
            abi_version: ffi::FULLMAG_FEM_STAGE_OERSTED_CALLBACK_ABI_VERSION,
            reserved_flags: 0,
            struct_size: std::mem::size_of::<ffi::fullmag_fem_stage_oersted_callback_v1>() as u64,
            user_data: self as *mut Self as *mut c_void,
            evaluate: Some(Self::evaluate_callback),
            begin_attempt: Some(Self::begin_attempt_callback),
            commit_attempt: Some(Self::commit_attempt_callback),
            rollback_attempt: Some(Self::rollback_attempt_callback),
        }
    }

    pub(crate) fn counters(&self) -> (u64, u64, u64, u64) {
        (
            self.begin_count,
            self.commit_count,
            self.rollback_count,
            self.evaluate_count,
        )
    }

    pub(crate) fn telemetry(&self) -> serde_json::Value {
        let (begin_count, commit_count, rollback_count, evaluate_count) = self.counters();
        let policy = if self.coupled_evaluator.is_some() {
            FEM_STAGE_TRANSPORT_OERSTED_CALLBACK_POLICY
        } else {
            FEM_STAGE_OERSTED_CALLBACK_POLICY
        };
        serde_json::json!({
            "schema": "fem_stage_oersted_callback.v1",
            "policy": policy,
            "device_lane": "cpu_native",
            "begin_count": begin_count,
            "commit_count": commit_count,
            "rollback_count": rollback_count,
            "evaluate_count": evaluate_count,
            "accepted_observation": self.accepted_observation,
            "last_observation": self.last_observation,
            "shared_evaluator": self.coupled_evaluator.as_ref().map(StageM2CoupledProvider::telemetry),
        })
    }

    fn evaluate(
        &mut self,
        m_xyz: *const f64,
        m_xyz_len: u64,
        evaluation_time_s: f64,
        stage_identity: u64,
        out_h_xyz_apm: *mut f64,
        out_h_xyz_len: u64,
        out_source_state_revision: *mut u64,
    ) -> Result<(), String> {
        if !evaluation_time_s.is_finite() {
            return Err("stage Oersted evaluation time is non-finite".into());
        }
        if m_xyz_len == 0 || m_xyz_len % 3 != 0 {
            return Err(
                "stage Oersted magnetization length must be a non-zero xyz multiple".into(),
            );
        }
        if out_h_xyz_len != m_xyz_len {
            return Err(format!(
                "stage Oersted output length {} differs from magnetization length {}",
                out_h_xyz_len, m_xyz_len
            ));
        }
        if m_xyz.is_null() || out_h_xyz_apm.is_null() || out_source_state_revision.is_null() {
            return Err("stage Oersted callback received a null data pointer".into());
        }
        let m_flat = unsafe { std::slice::from_raw_parts(m_xyz, m_xyz_len as usize) };
        if m_flat.iter().any(|value| !value.is_finite()) {
            return Err("stage Oersted magnetization contains a non-finite value".into());
        }
        let magnetization = m_flat
            .chunks_exact(3)
            .map(|chunk| [chunk[0], chunk[1], chunk[2]])
            .collect::<Vec<_>>();
        let (
            field,
            source_view_identity_digest,
            source_revision,
            envelope_multiplier,
            field_sha256,
        ) = if let Some(coupled) = self.coupled_evaluator.as_ref() {
            let evaluation = coupled.evaluate(&magnetization, evaluation_time_s, stage_identity)?;
            (
                evaluation.oersted_h_xyz_apm,
                evaluation.source_state_digest,
                evaluation.source_state_revision,
                evaluation.envelope_multiplier,
                evaluation.field_sha256,
            )
        } else {
            let mut request = self.request_template.clone();
            request.magnetization = magnetization;
            let mut view = self.view_template.clone().ok_or_else(|| {
                "stage Oersted callback has no conservative current view".to_string()
            })?;
            let envelope_multiplier = self
                .time_envelope
                .as_ref()
                .map(|envelope| evaluate_time_envelope(envelope, evaluation_time_s))
                .transpose()?
                .unwrap_or(1.0);
            apply_stage_envelope_to_closure(&mut view.closure, envelope_multiplier)?;
            view.identity.evaluated_envelope_multiplier = envelope_multiplier;
            view.identity.evaluation_time_s = evaluation_time_s;
            view.identity.stage_identity = stage_identity;
            let (field, source_view_identity_digest) = if envelope_multiplier == 0.0 {
                let field = vec![0.0; out_h_xyz_len as usize];
                let digest = stage_zero_source_view_identity_digest(
                    &view,
                    evaluation_time_s,
                    stage_identity,
                );
                (field, digest)
            } else {
                let result = solve_native_fem_steady_transport_rt0(
                    &request,
                    &view,
                    self.method,
                    self.target_points.as_deref(),
                )
                .map_err(|error| error.message)?;
                let field = result
                    .oersted_h_xyz_apm
                    .ok_or_else(|| "stage Oersted solve published no H_oe field".to_string())?;
                let digest = result
                    .oersted_source_view_identity_digest
                    .unwrap_or(result.view_identity_digest);
                (field, digest)
            };
            let source_revision = source_state_revision(
                &view.identity.source_state_revision,
                evaluation_time_s,
                stage_identity,
                envelope_multiplier,
            );
            let field_sha256 = sha256_f64_slice(&field);
            (
                field,
                source_view_identity_digest,
                source_revision,
                envelope_multiplier,
                field_sha256,
            )
        };
        if field.len() != out_h_xyz_len as usize || field.iter().any(|value| !value.is_finite()) {
            return Err("stage Oersted solve returned an invalid H_oe field".into());
        }
        if source_view_identity_digest.is_empty() {
            return Err("stage Oersted solve published no source-view identity digest".into());
        }
        unsafe {
            ptr::copy_nonoverlapping(field.as_ptr(), out_h_xyz_apm, field.len());
            *out_source_state_revision = source_revision;
        }
        let observation = StageOerstedObservation {
            stage_identity,
            evaluation_time_s,
            envelope_multiplier,
            source_state_revision: source_revision,
            source_view_identity_digest,
            field_sha256,
        };
        self.last_observation = Some(observation.clone());
        self.pending_observation = Some(observation);
        self.evaluate_count = self.evaluate_count.saturating_add(1);
        Ok(())
    }

    fn begin_attempt(
        &mut self,
        target_step: u64,
        attempt_identity: u64,
        time_start_s: f64,
        dt_seconds: f64,
    ) -> Result<(), String> {
        if self.attempt_active {
            return Err("stage Oersted attempt is already active".into());
        }
        if !time_start_s.is_finite() || !dt_seconds.is_finite() || dt_seconds <= 0.0 {
            return Err("stage Oersted attempt carries invalid time or dt".into());
        }
        let _ = (target_step, attempt_identity);
        self.attempt_active = true;
        self.pending_observation = None;
        self.begin_count = self.begin_count.saturating_add(1);
        Ok(())
    }

    fn commit_attempt(&mut self) -> Result<(), String> {
        if !self.attempt_active {
            return Err("stage Oersted commit has no active attempt".into());
        }
        let observation = self
            .pending_observation
            .take()
            .ok_or_else(|| "stage Oersted commit has no evaluated stage".to_string())?;
        self.accepted_observation = Some(observation);
        self.attempt_active = false;
        self.commit_count = self.commit_count.saturating_add(1);
        Ok(())
    }

    fn rollback_attempt(&mut self) -> Result<(), String> {
        if !self.attempt_active {
            return Err("stage Oersted rollback has no active attempt".into());
        }
        self.pending_observation = None;
        self.attempt_active = false;
        self.rollback_count = self.rollback_count.saturating_add(1);
        Ok(())
    }

    unsafe extern "C" fn evaluate_callback(
        user_data: *mut c_void,
        m_xyz: *const f64,
        m_xyz_len: u64,
        evaluation_time_s: f64,
        stage_identity: u64,
        out_h_xyz_apm: *mut f64,
        out_h_xyz_len: u64,
        out_source_state_revision: *mut u64,
        error_message: *mut c_char,
        error_message_capacity: u64,
    ) -> i32 {
        let result = catch_unwind(AssertUnwindSafe(|| {
            if user_data.is_null() {
                return Err("stage Oersted evaluate user_data is null".to_string());
            }
            (*user_data.cast::<Self>()).evaluate(
                m_xyz,
                m_xyz_len,
                evaluation_time_s,
                stage_identity,
                out_h_xyz_apm,
                out_h_xyz_len,
                out_source_state_revision,
            )
        }));
        match result {
            Ok(Ok(())) => 0,
            Ok(Err(error)) => {
                write_error(error_message, error_message_capacity, &error);
                -1
            }
            Err(_) => {
                write_error(
                    error_message,
                    error_message_capacity,
                    "panic in stage Oersted evaluate callback",
                );
                -1
            }
        }
    }

    unsafe extern "C" fn begin_attempt_callback(
        user_data: *mut c_void,
        target_step: u64,
        attempt_identity: u64,
        time_start_s: f64,
        dt_seconds: f64,
        error_message: *mut c_char,
        error_message_capacity: u64,
    ) -> i32 {
        attempt_callback(
            user_data,
            error_message,
            error_message_capacity,
            |provider| {
                provider.begin_attempt(target_step, attempt_identity, time_start_s, dt_seconds)
            },
        )
    }

    unsafe extern "C" fn commit_attempt_callback(
        user_data: *mut c_void,
        _target_step: u64,
        _attempt_identity: u64,
        _time_start_s: f64,
        _dt_seconds: f64,
        error_message: *mut c_char,
        error_message_capacity: u64,
    ) -> i32 {
        attempt_callback(
            user_data,
            error_message,
            error_message_capacity,
            |provider| provider.commit_attempt(),
        )
    }

    unsafe extern "C" fn rollback_attempt_callback(
        user_data: *mut c_void,
        _target_step: u64,
        _attempt_identity: u64,
        _time_start_s: f64,
        _dt_seconds: f64,
        error_message: *mut c_char,
        error_message_capacity: u64,
    ) -> i32 {
        attempt_callback(
            user_data,
            error_message,
            error_message_capacity,
            |provider| provider.rollback_attempt(),
        )
    }
}

fn apply_stage_envelope_to_closure(
    closure: &mut fullmag_ir::ConservativeCurrentClosureIR,
    envelope_multiplier: f64,
) -> Result<(), String> {
    if !envelope_multiplier.is_finite() {
        return Err("stage Oersted time envelope evaluated to a non-finite multiplier".into());
    }
    match closure {
        fullmag_ir::ConservativeCurrentClosureIR::ClosedGeometry { source_cuts, .. } => {
            for cut in source_cuts {
                cut.potential_drop_v *= envelope_multiplier;
                if !cut.potential_drop_v.is_finite() {
                    return Err(
                        "stage Oersted envelope produced a non-finite source-cut potential".into(),
                    );
                }
            }
        }
        fullmag_ir::ConservativeCurrentClosureIR::ExternalLead {
            outer_electrode_potential_drop_v,
            ..
        } => {
            *outer_electrode_potential_drop_v *= envelope_multiplier;
            if !outer_electrode_potential_drop_v.is_finite() {
                return Err(
                    "stage Oersted envelope produced a non-finite external-lead potential".into(),
                );
            }
        }
    }
    Ok(())
}

fn stage_zero_source_view_identity_digest(
    view: &ResolvedFemConservativeCurrentViewIR,
    evaluation_time_s: f64,
    stage_identity: u64,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"fem_stage_oersted_zero_source.v1");
    for value in [
        view.identity.source_module_id.as_str(),
        view.identity.source_state_revision.as_str(),
        view.identity.source_field_digest.as_str(),
        view.identity.conductivity_digest.as_str(),
        view.identity.mesh_revision.as_str(),
        view.identity.topology_revision.as_str(),
        view.identity.geometry_digest.as_str(),
        view.identity.envelope_revision.as_str(),
        view.identity.envelope_digest.as_str(),
    ] {
        hasher.update((value.len() as u64).to_le_bytes());
        hasher.update(value.as_bytes());
    }
    hasher.update(view.identity.evaluated_envelope_multiplier.to_le_bytes());
    match &view.closure {
        fullmag_ir::ConservativeCurrentClosureIR::ClosedGeometry {
            operator_version,
            revision,
            digest,
            ..
        }
        | fullmag_ir::ConservativeCurrentClosureIR::ExternalLead {
            operator_version,
            revision,
            digest,
            ..
        } => {
            for value in [operator_version, revision, digest] {
                hasher.update((value.len() as u64).to_le_bytes());
                hasher.update(value.as_bytes());
            }
        }
    }
    hasher.update(evaluation_time_s.to_le_bytes());
    hasher.update(stage_identity.to_le_bytes());
    format!("sha256:{:x}", hasher.finalize())
}

unsafe fn attempt_callback(
    user_data: *mut c_void,
    error_message: *mut c_char,
    error_message_capacity: u64,
    operation: impl FnOnce(&mut StageOerstedProvider) -> Result<(), String>,
) -> i32 {
    let result = catch_unwind(AssertUnwindSafe(|| {
        if user_data.is_null() {
            return Err("stage Oersted attempt user_data is null".to_string());
        }
        operation(&mut *user_data.cast::<StageOerstedProvider>())
    }));
    match result {
        Ok(Ok(())) => 0,
        Ok(Err(error)) => {
            write_error(error_message, error_message_capacity, &error);
            -1
        }
        Err(_) => {
            write_error(
                error_message,
                error_message_capacity,
                "panic in stage Oersted attempt callback",
            );
            -1
        }
    }
}

fn write_error(buffer: *mut c_char, capacity: u64, message: &str) {
    if buffer.is_null() || capacity == 0 {
        return;
    }
    let bytes = message.as_bytes();
    let length = bytes.len().min(capacity.saturating_sub(1) as usize);
    unsafe {
        let target = std::slice::from_raw_parts_mut(buffer.cast::<u8>(), capacity as usize);
        target[..length].copy_from_slice(&bytes[..length]);
        target[length] = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stage_envelope_scales_external_lead_drive() {
        let mut closure = fullmag_ir::ConservativeCurrentClosureIR::ExternalLead {
            operator_version: "fem_closed_current_extension.v1".into(),
            revision: "lead-r1".into(),
            digest: "sha256:lead".into(),
            drive_id: "drive".into(),
            outer_electrode_potential_drop_v: 0.2,
            lead_mesh: fullmag_ir::MeshIR {
                mesh_name: "external_lead".into(),
                nodes: vec![[0.0, 0.0, 0.0]; 4],
                cells: fullmag_ir::FemConnectivityIR {
                    types: vec![fullmag_ir::FemCellTypeIR::Tet4],
                    offsets: vec![0, 4],
                    nodes: vec![0, 1, 2, 3],
                    global_ordinals: vec![0],
                    mesh_parts: Vec::new(),
                },
                element_markers: vec![1],
                facets: fullmag_ir::FemFacetConnectivityIR {
                    types: vec![fullmag_ir::FemFacetTypeIR::Tri3; 4],
                    roles: vec![fullmag_ir::FemFacetRoleIR::Exterior; 4],
                    offsets: vec![0, 3, 6, 9, 12],
                    nodes: vec![0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3],
                    global_ordinals: vec![0, 1, 2, 3],
                },
                boundary_markers: vec![10, 11, 12, 13],
                periodic_node_pairs: Vec::new(),
                periodic_boundary_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            },
            lead_conductivity_spm_per_element: vec![5.8e7],
            lead_stable_vertex_ids: vec![101, 102, 103, 104],
            interface_pairs: vec![([10, 20, 30], [101, 102, 103])],
            minus_outer_electrode_face_vertex_ids: vec![[101, 102, 104]],
            plus_outer_electrode_face_vertex_ids: vec![[101, 103, 104]],
            lead_conductivity_digest: "sha256:sigma".into(),
        };

        apply_stage_envelope_to_closure(&mut closure, 0.5)
            .expect("finite envelope should scale the external drive");
        match closure {
            fullmag_ir::ConservativeCurrentClosureIR::ExternalLead {
                outer_electrode_potential_drop_v,
                ..
            } => assert_eq!(outer_electrode_potential_drop_v, 0.1),
            _ => panic!("test closure changed kind"),
        }
    }

    #[test]
    fn external_lead_stage_callback_solves_oersted_and_commits_observation() {
        let (request_template, view) =
            super::super::steady_transport::test_external_lead_request_and_view();
        let target_points = request_template.mesh.nodes.clone();
        let magnetization = request_template
            .magnetization
            .iter()
            .flatten()
            .copied()
            .collect::<Vec<_>>();
        let mut provider = StageOerstedProvider {
            request_template,
            view_template: Some(view),
            coupled_evaluator: None,
            time_envelope: None,
            method: NativeFemSteadyTransportOerstedMethod::DirectTetraQuadrature,
            target_points: Some(target_points),
            attempt_active: false,
            pending_observation: None,
            accepted_observation: None,
            last_observation: None,
            begin_count: 0,
            commit_count: 0,
            rollback_count: 0,
            evaluate_count: 0,
        };
        let mut field = vec![f64::NAN; magnetization.len()];
        let mut source_state_revision = 0_u64;

        provider
            .begin_attempt(1, 11, 0.0, 1.0e-13)
            .expect("external-lead stage attempt must begin");
        provider
            .evaluate(
                magnetization.as_ptr(),
                magnetization.len() as u64,
                0.0,
                101,
                field.as_mut_ptr(),
                field.len() as u64,
                &mut source_state_revision,
            )
            .expect("external-lead stage callback must solve and reconstruct H_oe");
        assert!(field.iter().all(|value| value.is_finite()));
        assert!(field.iter().any(|value| value.abs() > 0.0));
        assert_ne!(source_state_revision, 0);
        provider
            .commit_attempt()
            .expect("evaluated external-lead stage must commit");

        assert_eq!(provider.counters(), (1, 1, 0, 1));
        let telemetry = provider.telemetry();
        assert_eq!(telemetry["policy"], FEM_STAGE_OERSTED_CALLBACK_POLICY);
        assert_eq!(telemetry["accepted_observation"]["stage_identity"], 101);
        assert_eq!(
            telemetry["accepted_observation"]["source_state_revision"],
            source_state_revision
        );
        assert!(telemetry["accepted_observation"]["field_sha256"]
            .as_str()
            .is_some_and(|digest| digest.starts_with("sha256:")));

        let accepted_before_rollback = telemetry["accepted_observation"].clone();
        let mut rejected_field = vec![f64::NAN; magnetization.len()];
        let mut rejected_revision = 0_u64;
        provider
            .begin_attempt(2, 22, 1.0e-13, 1.0e-13)
            .expect("external-lead rejected attempt must begin");
        provider
            .evaluate(
                magnetization.as_ptr(),
                magnetization.len() as u64,
                1.0e-13,
                202,
                rejected_field.as_mut_ptr(),
                rejected_field.len() as u64,
                &mut rejected_revision,
            )
            .expect("external-lead rejected candidate must still solve");
        provider
            .rollback_attempt()
            .expect("external-lead candidate must roll back transactionally");
        let rolled_back = provider.telemetry();
        assert_eq!(provider.counters(), (2, 1, 1, 2));
        assert_eq!(
            rolled_back["accepted_observation"],
            accepted_before_rollback
        );

        let mut retry_field = vec![f64::NAN; magnetization.len()];
        let mut retry_revision = 0_u64;
        provider
            .begin_attempt(2, 23, 1.0e-13, 1.0e-13)
            .expect("external-lead retry must begin");
        provider
            .evaluate(
                magnetization.as_ptr(),
                magnetization.len() as u64,
                1.0e-13,
                202,
                retry_field.as_mut_ptr(),
                retry_field.len() as u64,
                &mut retry_revision,
            )
            .expect("external-lead retry must reproduce the candidate solve");
        provider
            .commit_attempt()
            .expect("external-lead retry must commit");
        assert_eq!(provider.counters(), (3, 2, 1, 3));
        assert_eq!(retry_field, rejected_field);
        assert_eq!(retry_revision, rejected_revision);
        assert_eq!(
            provider.telemetry()["accepted_observation"]["stage_identity"],
            202
        );
    }
}

fn source_state_revision(
    value: &str,
    evaluation_time_s: f64,
    stage_identity: u64,
    envelope_multiplier: f64,
) -> u64 {
    let mut preimage = Vec::with_capacity(value.len() + 24);
    preimage.extend_from_slice(value.as_bytes());
    preimage.extend_from_slice(&evaluation_time_s.to_le_bytes());
    preimage.extend_from_slice(&stage_identity.to_le_bytes());
    preimage.extend_from_slice(&envelope_multiplier.to_le_bytes());
    let digest = Sha256::digest(preimage);
    u64::from_le_bytes(digest[..8].try_into().expect("sha256 has eight bytes"))
}

fn sha256_f64_slice(values: &[f64]) -> String {
    let mut hasher = Sha256::new();
    for value in values {
        hasher.update(value.to_le_bytes());
    }
    format!("sha256:{:x}", hasher.finalize())
}
