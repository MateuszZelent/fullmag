//! Rust-side adapter for the native CPU stage Oersted callback.
//!
//! The numerical solve remains owned by `steady_transport`; this module only
//! owns the C ABI lifetime, stage identity, attempt transaction and the small
//! amount of provenance needed to reject a partial publication.

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
            descriptor.stage_coupling == FEM_STAGE_OERSTED_CALLBACK_POLICY
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
    view_template: ResolvedFemConservativeCurrentViewIR,
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
        if !plan_requests_stage_oersted_callback(plan) {
            return Ok(None);
        }
        let Some(prepared) = preflight_transport_plans(plan)?.into_iter().next() else {
            return Ok(None);
        };
        let Some(descriptor) = prepared.resolved.fem_cpu_double.as_ref() else {
            return Ok(None);
        };
        if descriptor.stage_coupling != FEM_STAGE_OERSTED_CALLBACK_POLICY {
            return Ok(None);
        }
        let view = descriptor
            .conservative_current_view
            .clone()
            .ok_or_else(|| RunError {
                message: "FEM stage Oersted callback requires a resolved conservative RT0 view"
                    .into(),
            })?;
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
        serde_json::json!({
            "schema": "fem_stage_oersted_callback.v1",
            "policy": FEM_STAGE_OERSTED_CALLBACK_POLICY,
            "device_lane": "cpu_native",
            "begin_count": begin_count,
            "commit_count": commit_count,
            "rollback_count": rollback_count,
            "evaluate_count": evaluate_count,
            "accepted_observation": self.accepted_observation,
            "last_observation": self.last_observation,
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
        let mut request = self.request_template.clone();
        request.magnetization = magnetization;
        let mut view = self.view_template.clone();
        let envelope_multiplier = self
            .time_envelope
            .as_ref()
            .map(|envelope| evaluate_time_envelope(envelope, evaluation_time_s))
            .transpose()?
            .unwrap_or(1.0);
        match &mut view.closure {
            fullmag_ir::ConservativeCurrentClosureIR::ClosedGeometry { source_cuts, .. } => {
                for cut in source_cuts {
                    cut.potential_drop_v *= envelope_multiplier;
                    if !cut.potential_drop_v.is_finite() {
                        return Err(
                            "stage Oersted envelope produced a non-finite source-cut potential"
                                .into(),
                        );
                    }
                }
            }
            fullmag_ir::ConservativeCurrentClosureIR::ExternalLead { .. } => {
                return Err(
                    "stage Oersted envelope requires closed_geometry; external_lead is not stage-qualified"
                        .into(),
                );
            }
        }
        if !envelope_multiplier.is_finite() {
            return Err("stage Oersted time envelope evaluated to a non-finite multiplier".into());
        }
        view.identity.evaluated_envelope_multiplier = envelope_multiplier;
        view.identity.evaluation_time_s = evaluation_time_s;
        view.identity.stage_identity = stage_identity;
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
        if field.len() != out_h_xyz_len as usize || field.iter().any(|value| !value.is_finite()) {
            return Err("stage Oersted solve returned an invalid H_oe field".into());
        }
        let source_view_identity_digest = result
            .oersted_source_view_identity_digest
            .unwrap_or(result.view_identity_digest);
        if source_view_identity_digest.is_empty() {
            return Err("stage Oersted solve published no source-view identity digest".into());
        }
        unsafe {
            ptr::copy_nonoverlapping(field.as_ptr(), out_h_xyz_apm, field.len());
            *out_source_state_revision = source_state_revision(
                &view.identity.source_state_revision,
                evaluation_time_s,
                stage_identity,
                envelope_multiplier,
            );
        }
        let observation = StageOerstedObservation {
            stage_identity,
            evaluation_time_s,
            envelope_multiplier,
            source_state_revision: source_state_revision(
                &view.identity.source_state_revision,
                evaluation_time_s,
                stage_identity,
                envelope_multiplier,
            ),
            source_view_identity_digest,
            field_sha256: sha256_f64_slice(&field),
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
