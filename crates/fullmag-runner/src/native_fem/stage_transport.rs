//! Rust-side adapter for the native CPU reciprocal transport torque callback.
//!
//! The callback owns one full FEM M2 solve per exact RK stage.  It publishes
//! the solver's direct Gilbert torque in 1/s; the native backend adds that
//! vector to the LLG RHS and keeps the attempt transaction separate from the
//! Oersted interaction.

use super::stage_coupled::{StageM2CoupledProvider, FEM_STAGE_TRANSPORT_OERSTED_CALLBACK_POLICY};
use super::steady_transport::{
    preflight_transport_plans, solve_native_fem_steady_transport, NativeFemSteadyTransportRequest,
};
use crate::time_envelope::evaluate_time_envelope;
use crate::types::RunError;
use fullmag_fem_sys as ffi;
use fullmag_ir::{FemPlanIR, TimeEnvelopeIR, TransportCouplingIR};
use sha2::{Digest, Sha256};
use std::ffi::{c_char, c_void};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr;

pub(crate) const FEM_STAGE_TRANSPORT_CALLBACK_POLICY: &str = "fem_stage_transport_callback.v1";

pub(crate) fn plan_requests_stage_transport_callback(plan: &FemPlanIR) -> bool {
    plan.spin_transport_plans.iter().any(|transport| {
        transport.resolved_coupling == TransportCouplingIR::Bidirectional
            && transport.fem_cpu_double.as_ref().is_some_and(|descriptor| {
                matches!(
                    descriptor.stage_coupling.as_str(),
                    FEM_STAGE_TRANSPORT_CALLBACK_POLICY
                        | FEM_STAGE_TRANSPORT_OERSTED_CALLBACK_POLICY
                ) && descriptor.torque_target.is_some()
            })
    })
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub(crate) struct StageTransportObservation {
    pub stage_identity: u64,
    pub evaluation_time_s: f64,
    pub envelope_multiplier: f64,
    pub source_state_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_state_digest: Option<String>,
    pub torque_sha256: String,
    pub torque_l2_per_s: f64,
}

pub(crate) struct StageTransportProvider {
    request_template: NativeFemSteadyTransportRequest,
    time_envelope: Option<TimeEnvelopeIR>,
    coupled_evaluator: Option<StageM2CoupledProvider>,
    attempt_active: bool,
    pending_observation: Option<StageTransportObservation>,
    accepted_observation: Option<StageTransportObservation>,
    last_observation: Option<StageTransportObservation>,
    begin_count: u64,
    commit_count: u64,
    rollback_count: u64,
    evaluate_count: u64,
}

impl StageTransportProvider {
    pub(crate) fn from_plan(plan: &FemPlanIR) -> Result<Option<Self>, RunError> {
        Self::from_plan_with_coupled(plan, None)
    }

    pub(crate) fn from_plan_with_coupled(
        plan: &FemPlanIR,
        coupled_evaluator: Option<StageM2CoupledProvider>,
    ) -> Result<Option<Self>, RunError> {
        if !plan_requests_stage_transport_callback(plan) {
            return Ok(None);
        }
        let Some(prepared) = preflight_transport_plans(plan)?.into_iter().next() else {
            return Ok(None);
        };
        let Some(descriptor) = prepared.resolved.fem_cpu_double.as_ref() else {
            return Ok(None);
        };
        let is_combined = descriptor.stage_coupling == FEM_STAGE_TRANSPORT_OERSTED_CALLBACK_POLICY;
        if (!is_combined && descriptor.stage_coupling != FEM_STAGE_TRANSPORT_CALLBACK_POLICY)
            || descriptor.torque_target.is_none()
        {
            return Ok(None);
        }
        if is_combined && coupled_evaluator.is_none() {
            return Err(RunError {
                message: "combined FEM M2 stage transport callback was requested but its shared evaluator could not be materialized".into(),
            });
        }
        if prepared.request.constitutive_model
            != super::steady_transport::NativeFemSteadyTransportConstitutiveModel::ReciprocalM2
        {
            return Err(RunError {
                message: "stage transport callback requires a reciprocal FEM M2 request".into(),
            });
        }
        Ok(Some(Self {
            request_template: prepared.request,
            time_envelope: descriptor.time_envelope.clone(),
            coupled_evaluator,
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

    pub(crate) fn callback(&mut self) -> ffi::fullmag_fem_stage_transport_callback_v1 {
        ffi::fullmag_fem_stage_transport_callback_v1 {
            abi_version: ffi::FULLMAG_FEM_STAGE_TRANSPORT_CALLBACK_ABI_VERSION,
            reserved_flags: 0,
            struct_size: std::mem::size_of::<ffi::fullmag_fem_stage_transport_callback_v1>() as u64,
            user_data: self as *mut Self as *mut c_void,
            evaluate: Some(Self::evaluate_callback),
            begin_attempt: Some(Self::begin_attempt_callback),
            commit_attempt: Some(Self::commit_attempt_callback),
            rollback_attempt: Some(Self::rollback_attempt_callback),
        }
    }

    pub(crate) fn telemetry(&self) -> serde_json::Value {
        let policy = if self.coupled_evaluator.is_some() {
            FEM_STAGE_TRANSPORT_OERSTED_CALLBACK_POLICY
        } else {
            FEM_STAGE_TRANSPORT_CALLBACK_POLICY
        };
        serde_json::json!({
            "schema": "fem_stage_transport_callback.v1",
            "policy": policy,
            "device_lane": "cpu_native",
            "begin_count": self.begin_count,
            "commit_count": self.commit_count,
            "rollback_count": self.rollback_count,
            "evaluate_count": self.evaluate_count,
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
        out_torque_xyz_per_s: *mut f64,
        out_torque_xyz_len: u64,
        out_source_state_revision: *mut u64,
    ) -> Result<(), String> {
        if !evaluation_time_s.is_finite() {
            return Err("stage transport evaluation time is non-finite".into());
        }
        if m_xyz_len == 0 || m_xyz_len % 3 != 0 {
            return Err(
                "stage transport magnetization length must be a non-zero xyz multiple".into(),
            );
        }
        if out_torque_xyz_len != m_xyz_len {
            return Err(format!(
                "stage transport output length {} differs from magnetization length {}",
                out_torque_xyz_len, m_xyz_len
            ));
        }
        if m_xyz.is_null() || out_torque_xyz_per_s.is_null() || out_source_state_revision.is_null()
        {
            return Err("stage transport callback received a null data pointer".into());
        }
        let m_flat = unsafe { std::slice::from_raw_parts(m_xyz, m_xyz_len as usize) };
        if m_flat.iter().any(|value| !value.is_finite()) {
            return Err("stage transport magnetization contains a non-finite value".into());
        }
        let magnetization = m_flat
            .chunks_exact(3)
            .map(|chunk| [chunk[0], chunk[1], chunk[2]])
            .collect::<Vec<_>>();
        let (
            flat_torque,
            envelope_multiplier,
            source_state_revision,
            source_state_digest,
            torque_sha256,
        ) = if let Some(coupled) = self.coupled_evaluator.as_ref() {
            let evaluation = coupled.evaluate(&magnetization, evaluation_time_s, stage_identity)?;
            (
                evaluation.torque_xyz_per_s,
                evaluation.envelope_multiplier,
                evaluation.source_state_revision,
                Some(evaluation.source_state_digest),
                evaluation.torque_sha256,
            )
        } else {
            let mut request = self.request_template.clone();
            request.magnetization = magnetization;
            let envelope_multiplier = self
                .time_envelope
                .as_ref()
                .map(|envelope| evaluate_time_envelope(envelope, evaluation_time_s))
                .transpose()?
                .unwrap_or(1.0);
            if !envelope_multiplier.is_finite() {
                return Err(
                    "stage transport time envelope evaluated to a non-finite multiplier".into(),
                );
            }
            apply_charge_source_envelope(&mut request.charge_dirichlet, envelope_multiplier)?;
            let result =
                solve_native_fem_steady_transport(&request).map_err(|error| error.message)?;
            if result.torque_xyz_per_s.len() * 3 != m_xyz_len as usize
                || result
                    .torque_xyz_per_s
                    .iter()
                    .flatten()
                    .any(|value| !value.is_finite())
            {
                return Err("stage transport solve returned an invalid torque field".into());
            }
            let flat_torque = result
                .torque_xyz_per_s
                .iter()
                .flatten()
                .copied()
                .collect::<Vec<_>>();
            let source_state_revision = source_state_revision(
                &request.constitutive_version,
                evaluation_time_s,
                stage_identity,
                envelope_multiplier,
            );
            let torque_sha256 = sha256_f64_slice(&flat_torque);
            (
                flat_torque,
                envelope_multiplier,
                source_state_revision,
                None,
                torque_sha256,
            )
        };
        let torque_l2_per_s = flat_torque
            .iter()
            .map(|value| value * value)
            .sum::<f64>()
            .sqrt();
        unsafe {
            ptr::copy_nonoverlapping(
                flat_torque.as_ptr(),
                out_torque_xyz_per_s,
                flat_torque.len(),
            );
            *out_source_state_revision = source_state_revision;
        }
        let observation = StageTransportObservation {
            stage_identity,
            evaluation_time_s,
            envelope_multiplier,
            source_state_revision,
            source_state_digest,
            torque_sha256,
            torque_l2_per_s,
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
            return Err("stage transport attempt is already active".into());
        }
        if !time_start_s.is_finite() || !dt_seconds.is_finite() || dt_seconds <= 0.0 {
            return Err("stage transport attempt carries invalid time or dt".into());
        }
        let _ = (target_step, attempt_identity);
        self.attempt_active = true;
        self.pending_observation = None;
        self.begin_count = self.begin_count.saturating_add(1);
        Ok(())
    }

    fn commit_attempt(&mut self) -> Result<(), String> {
        if !self.attempt_active {
            return Err("stage transport commit has no active attempt".into());
        }
        let observation = self
            .pending_observation
            .take()
            .ok_or_else(|| "stage transport commit has no evaluated stage".to_string())?;
        self.accepted_observation = Some(observation);
        self.attempt_active = false;
        self.commit_count = self.commit_count.saturating_add(1);
        Ok(())
    }

    fn rollback_attempt(&mut self) -> Result<(), String> {
        if !self.attempt_active {
            return Err("stage transport rollback has no active attempt".into());
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
        out_torque_xyz_per_s: *mut f64,
        out_torque_xyz_len: u64,
        out_source_state_revision: *mut u64,
        error_message: *mut c_char,
        error_message_capacity: u64,
    ) -> i32 {
        let result = catch_unwind(AssertUnwindSafe(|| {
            if user_data.is_null() {
                return Err("stage transport evaluate user_data is null".to_string());
            }
            (*user_data.cast::<Self>()).evaluate(
                m_xyz,
                m_xyz_len,
                evaluation_time_s,
                stage_identity,
                out_torque_xyz_per_s,
                out_torque_xyz_len,
                out_source_state_revision,
            )
        }));
        finish_callback(result, error_message, error_message_capacity)
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
        let result = catch_unwind(AssertUnwindSafe(|| {
            if user_data.is_null() {
                return Err("stage transport begin user_data is null".to_string());
            }
            (*user_data.cast::<Self>()).begin_attempt(
                target_step,
                attempt_identity,
                time_start_s,
                dt_seconds,
            )
        }));
        finish_callback(result, error_message, error_message_capacity)
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
        let result = catch_unwind(AssertUnwindSafe(|| {
            if user_data.is_null() {
                return Err("stage transport commit user_data is null".to_string());
            }
            (*user_data.cast::<Self>()).commit_attempt()
        }));
        finish_callback(result, error_message, error_message_capacity)
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
        let result = catch_unwind(AssertUnwindSafe(|| {
            if user_data.is_null() {
                return Err("stage transport rollback user_data is null".to_string());
            }
            (*user_data.cast::<Self>()).rollback_attempt()
        }));
        finish_callback(result, error_message, error_message_capacity)
    }
}

fn source_state_revision(
    constitutive_version: &str,
    evaluation_time_s: f64,
    stage_identity: u64,
    envelope_multiplier: f64,
) -> u64 {
    let mut hasher = Sha256::new();
    hasher.update(constitutive_version.as_bytes());
    hasher.update(evaluation_time_s.to_le_bytes());
    hasher.update(stage_identity.to_le_bytes());
    hasher.update(envelope_multiplier.to_le_bytes());
    let digest = hasher.finalize();
    u64::from_le_bytes(
        digest[..8]
            .try_into()
            .expect("sha256 prefix has eight bytes"),
    )
}

pub(crate) fn apply_charge_source_envelope(
    charge_dirichlet: &mut [(u32, f64)],
    envelope_multiplier: f64,
) -> Result<(), String> {
    if !envelope_multiplier.is_finite() {
        return Err("stage transport envelope produced a non-finite multiplier".into());
    }
    let reference_potential_v = charge_dirichlet
        .first()
        .map(|(_, value)| *value)
        .unwrap_or(0.0);
    if !reference_potential_v.is_finite() {
        return Err("stage transport charge reference is non-finite".into());
    }
    for (_, value) in charge_dirichlet {
        *value = reference_potential_v + envelope_multiplier * (*value - reference_potential_v);
        if !value.is_finite() {
            return Err("stage transport envelope produced a non-finite voltage drive".into());
        }
    }
    Ok(())
}

fn sha256_f64_slice(values: &[f64]) -> String {
    let mut hasher = Sha256::new();
    for value in values {
        hasher.update(value.to_le_bytes());
    }
    format!("{:x}", hasher.finalize())
}

fn finish_callback(
    result: Result<Result<(), String>, Box<dyn std::any::Any + Send>>,
    error_message: *mut c_char,
    error_message_capacity: u64,
) -> i32 {
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
                "panic in stage transport callback",
            );
            -1
        }
    }
}

fn write_error(error_message: *mut c_char, capacity: u64, error: &str) {
    if error_message.is_null() || capacity == 0 {
        return;
    }
    let bytes = error.as_bytes();
    let limit = (capacity as usize).saturating_sub(1);
    let length = bytes.len().min(limit);
    unsafe {
        ptr::copy_nonoverlapping(bytes.as_ptr().cast::<c_char>(), error_message, length);
        *error_message.add(length) = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::apply_charge_source_envelope;

    #[test]
    fn source_envelope_scales_voltage_differences_about_reference() {
        let mut values = vec![(11_u32, 2.0), (12_u32, 5.0), (13_u32, -1.0)];
        apply_charge_source_envelope(&mut values, 0.25).expect("finite envelope");
        assert_eq!(values, vec![(11, 2.0), (12, 2.75), (13, 1.25)]);
    }
}
