//! Shared FEM M2 stage evaluation for the transport torque and Oersted field.
//!
//! The reciprocal M2 contract has one physical source state per exact RK
//! stage.  This adapter owns that solve and lets the two legacy native
//! callbacks read the same result, so the backend can keep its append-only
//! callback ABI while avoiding two independent charge--spin solves.

use super::steady_transport::{
    preflight_transport_plans, solve_native_fem_steady_transport,
    solved_current_midpoint_biot_savart_field, NativeFemSteadyTransportRequest,
};
use crate::time_envelope::evaluate_time_envelope;
use crate::types::RunError;
use fullmag_ir::{FemPlanIR, TimeEnvelopeIR, TransportCouplingIR};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};

pub(crate) const FEM_STAGE_TRANSPORT_OERSTED_CALLBACK_POLICY: &str =
    "fem_stage_transport_oersted_callback.v1";

#[derive(Debug, Clone)]
pub(crate) struct StageM2CoupledEvaluation {
    pub envelope_multiplier: f64,
    pub source_state_revision: u64,
    pub source_state_digest: String,
    pub torque_xyz_per_s: Vec<f64>,
    pub oersted_h_xyz_apm: Vec<f64>,
    pub torque_sha256: String,
    pub field_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct StageM2Key {
    magnetization_sha256: String,
    evaluation_time_bits: u64,
    stage_identity: u64,
    envelope_bits: u64,
}

#[derive(Default)]
struct StageM2Cache {
    key: Option<StageM2Key>,
    evaluation: Option<StageM2CoupledEvaluation>,
    solve_count: u64,
    cache_hit_count: u64,
}

struct StageM2CoupledInner {
    request_template: NativeFemSteadyTransportRequest,
    charge_element_mask: Vec<bool>,
    time_envelope: Option<TimeEnvelopeIR>,
    cache: Mutex<StageM2Cache>,
}

/// Cloneable handle shared by the stage Oersted and stage transport adapters.
/// The cache is deliberately bounded to the last exact stage and is replaced
/// when the RK driver advances to a new stage or retries an attempt.
#[derive(Clone)]
pub(crate) struct StageM2CoupledProvider {
    inner: Arc<StageM2CoupledInner>,
}

impl StageM2CoupledProvider {
    pub(crate) fn from_plan(plan: &FemPlanIR) -> Result<Option<Self>, RunError> {
        let Some(prepared) = preflight_transport_plans(plan)?.into_iter().next() else {
            return Ok(None);
        };
        let Some(descriptor) = prepared.resolved.fem_cpu_double.as_ref() else {
            return Ok(None);
        };
        if prepared.resolved.resolved_coupling != TransportCouplingIR::Bidirectional
            || descriptor.stage_coupling != FEM_STAGE_TRANSPORT_OERSTED_CALLBACK_POLICY
        {
            return Ok(None);
        }
        if descriptor.conservative_current_view.is_some() {
            return Err(RunError {
                message: "combined FEM M2 stage Oersted currently requires the H1/P1 solved-current realization; closure-aware RT0/external-lead coupling remains fail-closed".into(),
            });
        }
        if descriptor.charge_domain.element_mask.len() != plan.mesh.cell_count()
            || descriptor
                .charge_domain
                .element_mask
                .iter()
                .any(|selected| !selected)
        {
            return Err(RunError {
                message: "combined FEM M2 stage Oersted requires a complete charge element mask"
                    .into(),
            });
        }
        Ok(Some(Self {
            inner: Arc::new(StageM2CoupledInner {
                request_template: prepared.request,
                charge_element_mask: descriptor.charge_domain.element_mask.clone(),
                time_envelope: descriptor.time_envelope.clone(),
                cache: Mutex::new(StageM2Cache::default()),
            }),
        }))
    }

    pub(crate) fn evaluate(
        &self,
        magnetization: &[[f64; 3]],
        evaluation_time_s: f64,
        stage_identity: u64,
    ) -> Result<StageM2CoupledEvaluation, String> {
        if !evaluation_time_s.is_finite() {
            return Err("combined FEM M2 stage evaluation time is non-finite".into());
        }
        if magnetization.len() != self.inner.request_template.mesh.nodes.len()
            || magnetization.is_empty()
            || magnetization
                .iter()
                .flatten()
                .any(|value| !value.is_finite())
        {
            return Err(
                "combined FEM M2 stage magnetization does not match the native mesh or is non-finite"
                    .into(),
            );
        }
        let envelope_multiplier = self
            .inner
            .time_envelope
            .as_ref()
            .map(|envelope| evaluate_time_envelope(envelope, evaluation_time_s))
            .transpose()?
            .unwrap_or(1.0);
        let magnetization_sha256 = sha256_vec3_slice(magnetization);
        let key = StageM2Key {
            magnetization_sha256,
            evaluation_time_bits: evaluation_time_s.to_bits(),
            stage_identity,
            envelope_bits: envelope_multiplier.to_bits(),
        };
        {
            let mut cache = self
                .inner
                .cache
                .lock()
                .map_err(|_| "combined FEM M2 stage cache lock is poisoned".to_string())?;
            if cache.key.as_ref() == Some(&key) {
                if let Some(evaluation) = cache.evaluation.clone() {
                    cache.cache_hit_count = cache.cache_hit_count.saturating_add(1);
                    return Ok(evaluation);
                }
            }
        }

        let mut request = self.inner.request_template.clone();
        request.magnetization = magnetization.to_vec();
        super::stage_transport::apply_charge_source_envelope(
            &mut request.charge_dirichlet,
            envelope_multiplier,
        )?;
        let result = solve_native_fem_steady_transport(&request).map_err(|error| error.message)?;
        let field = solved_current_midpoint_biot_savart_field(
            &request.mesh,
            &self.inner.charge_element_mask,
            &result.charge_current_density_xyz_apm2,
        )
        .map_err(|error| error.message)?;
        let torque_xyz_per_s = result
            .torque_xyz_per_s
            .iter()
            .flatten()
            .copied()
            .collect::<Vec<_>>();
        let expected_len = magnetization.len() * 3;
        if torque_xyz_per_s.len() != expected_len
            || field.len() != expected_len
            || torque_xyz_per_s
                .iter()
                .chain(field.iter())
                .any(|value| !value.is_finite())
        {
            return Err("combined FEM M2 solve returned an invalid torque or Oersted field".into());
        }
        let torque_sha256 = sha256_f64_slice(&torque_xyz_per_s);
        let field_sha256 = sha256_f64_slice(&field);
        let source_state_digest = source_state_digest(
            &request.constitutive_version,
            &request.operator_version,
            &key,
            envelope_multiplier,
            &torque_sha256,
            &field_sha256,
        );
        let source_state_revision = u64::from_le_bytes(
            Sha256::digest(source_state_digest.as_bytes())[..8]
                .try_into()
                .expect("sha256 prefix has eight bytes"),
        );
        let evaluation = StageM2CoupledEvaluation {
            envelope_multiplier,
            source_state_revision,
            source_state_digest,
            torque_xyz_per_s,
            oersted_h_xyz_apm: field,
            torque_sha256,
            field_sha256,
        };
        let mut cache = self
            .inner
            .cache
            .lock()
            .map_err(|_| "combined FEM M2 stage cache lock is poisoned".to_string())?;
        cache.key = Some(key);
        cache.evaluation = Some(evaluation.clone());
        cache.solve_count = cache.solve_count.saturating_add(1);
        Ok(evaluation)
    }

    pub(crate) fn telemetry(&self) -> serde_json::Value {
        let cache = self.inner.cache.lock().ok();
        serde_json::json!({
            "policy": FEM_STAGE_TRANSPORT_OERSTED_CALLBACK_POLICY,
            "solve_count": cache.as_ref().map_or(0, |state| state.solve_count),
            "cache_hit_count": cache.as_ref().map_or(0, |state| state.cache_hit_count),
        })
    }
}

fn sha256_vec3_slice(values: &[[f64; 3]]) -> String {
    let mut hasher = Sha256::new();
    for value in values {
        for component in value {
            hasher.update(component.to_le_bytes());
        }
    }
    format!("sha256:{:x}", hasher.finalize())
}

fn sha256_f64_slice(values: &[f64]) -> String {
    let mut hasher = Sha256::new();
    for value in values {
        hasher.update(value.to_le_bytes());
    }
    format!("sha256:{:x}", hasher.finalize())
}

fn source_state_digest(
    constitutive_version: &str,
    operator_version: &str,
    key: &StageM2Key,
    envelope_multiplier: f64,
    torque_sha256: &str,
    field_sha256: &str,
) -> String {
    let mut hasher = Sha256::new();
    for value in [
        constitutive_version,
        operator_version,
        key.magnetization_sha256.as_str(),
    ] {
        hasher.update((value.len() as u64).to_le_bytes());
        hasher.update(value.as_bytes());
    }
    hasher.update(key.evaluation_time_bits.to_le_bytes());
    hasher.update(key.stage_identity.to_le_bytes());
    hasher.update(envelope_multiplier.to_le_bytes());
    hasher.update(torque_sha256.as_bytes());
    hasher.update(field_sha256.as_bytes());
    format!("sha256:{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::{source_state_digest, StageM2CoupledProvider, StageM2Key};

    #[test]
    fn empty_gpu_transport_plan_does_not_materialize_a_coupled_provider() {
        let mut plan = crate::dispatch::test_tiny_fem_plan();
        plan.mfem_device_string = Some("cuda".into());

        let provider = StageM2CoupledProvider::from_plan(&plan)
            .expect("an empty transport plan must not enter CPU-only transport preflight");

        assert!(provider.is_none());
    }

    #[test]
    fn source_identity_changes_when_stage_inputs_change() {
        let base = StageM2Key {
            magnetization_sha256: "sha256:m".into(),
            evaluation_time_bits: 1,
            stage_identity: 2,
            envelope_bits: 3,
        };
        let first = source_state_digest("c", "o", &base, 1.0, "sha256:t", "sha256:h");
        let mut changed = base.clone();
        changed.stage_identity += 1;
        let second = source_state_digest("c", "o", &changed, 1.0, "sha256:t", "sha256:h");
        assert_ne!(first, second);
    }
}
