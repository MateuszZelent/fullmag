//! One-shot field evaluation of a prepared initial state (ADR 0071).
//!
//! The magnetization is the resolved plan's own initial input, observed at
//! step 0 of its stage before any solver step. It is not an accepted solver
//! state, so the result carries the preparation identity instead of an
//! `AcceptedStateRef` and never claims execution provenance.

use std::collections::BTreeMap;

use fullmag_ir::{BackendPlanIR, ExecutionPlanIR, ProblemIR};
use fullmag_quantities::{ObservationClock, QuantityId};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::accepted_materialization::{
    evaluate_lane_observables, observation_evaluator_identity, LaneObservationInput,
    ObservationOrigin,
};
use crate::{AcceptedMaterializationLane, AcceptedMaterializedField};

pub const PREPARED_QUANTITY_BUNDLE_SCHEMA: &str = "prepared_quantity_bundle.v1";

/// Exact prepared state the fields belong to. A different preparation, plan
/// or initial magnetization must never adopt these fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PreparedStateIdentity {
    pub run_id: String,
    pub task_id: String,
    pub step_id: String,
    pub preparation_id: String,
    pub plan_fingerprint: String,
    /// `live_preview_values_sha256` of the flattened prepared magnetization.
    pub magnetization_values_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PreparedMaterializationBatch {
    pub schema_version: String,
    pub identity: PreparedStateIdentity,
    pub clock: ObservationClock,
    pub lane: AcceptedMaterializationLane,
    pub evaluator_build_identity: Value,
    pub fields: Vec<AcceptedMaterializedField>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub unavailable_scopes: BTreeMap<String, String>,
    /// Canonical global energy IDs mapped to evaluated joule values.
    pub energies: BTreeMap<String, f64>,
}

pub struct PreparedMaterializationRequest<'a> {
    pub plan: &'a ExecutionPlanIR,
    pub problem: &'a ProblemIR,
    pub identity: &'a PreparedStateIdentity,
    pub lane: AcceptedMaterializationLane,
    pub values: &'a [[f64; 3]],
    /// The exact layout of the published prepared magnetization.
    pub layout: &'a Value,
    /// Empty selects every active catalog field for this exact lane/plan.
    pub requested_quantity_ids: &'a [QuantityId],
}

/// Observation clock of a prepared state: step 0 at its stage origin.
pub fn prepared_observation_clock(plan: &ExecutionPlanIR) -> Result<ObservationClock, String> {
    let time_seconds = match &plan.backend_plan {
        BackendPlanIR::Fdm(plan) => plan.time_stage.start_time_s,
        BackendPlanIR::Fem(plan) => plan.time_stage.start_time_s,
        // Multilayer plans carry no stage clock; their prepared state is
        // published at t = 0.
        BackendPlanIR::FdmMultilayer(_) => 0.0,
        _ => return Err("prepared-state evaluation supports only FDM and FEM time-domain plans".into()),
    };
    let clock = ObservationClock { accepted_step: 0, time_seconds, dt_seconds: None };
    clock.validate().map_err(|error| error.to_string())?;
    Ok(clock)
}

pub fn materialize_prepared_observables(
    request: &PreparedMaterializationRequest<'_>,
) -> Result<PreparedMaterializationBatch, String> {
    validate_identity(request)?;
    let clock = prepared_observation_clock(request.plan)?;
    let input = LaneObservationInput {
        plan: request.plan,
        problem: request.problem,
        lane: request.lane,
        clock,
        values: request.values,
        layout: request.layout,
        requested_quantity_ids: request.requested_quantity_ids,
        origin: ObservationOrigin::Prepared,
    };
    let observations = evaluate_lane_observables(&input)?;
    Ok(PreparedMaterializationBatch {
        schema_version: PREPARED_QUANTITY_BUNDLE_SCHEMA.into(),
        identity: request.identity.clone(),
        clock,
        lane: request.lane,
        evaluator_build_identity: observation_evaluator_identity(
            &input,
            crate::artifacts::build_identity_json(),
        ),
        fields: observations.fields,
        unavailable_scopes: observations.unavailable_scopes,
        energies: observations.energies,
    })
}

fn validate_identity(request: &PreparedMaterializationRequest<'_>) -> Result<(), String> {
    let identity = request.identity;
    for (value, field) in [
        (identity.run_id.as_str(), "run_id"),
        (identity.task_id.as_str(), "task_id"),
        (identity.step_id.as_str(), "step_id"),
        (identity.preparation_id.as_str(), "preparation_id"),
        (identity.plan_fingerprint.as_str(), "plan_fingerprint"),
    ] {
        if value.trim().is_empty() {
            return Err(format!("prepared state identity has an empty {field}"));
        }
    }
    if request.values.is_empty() || request.values.iter().flatten().any(|value| !value.is_finite()) {
        return Err("prepared magnetization must contain finite three-component samples".into());
    }
    let flattened = request.values.iter().flatten().copied().collect::<Vec<_>>();
    if crate::types::live_preview_values_sha256(&flattened) != identity.magnetization_values_sha256 {
        return Err("prepared magnetization differs from its bound identity".into());
    }
    if request.layout.get("backend").and_then(Value::as_str).is_none() {
        return Err("prepared magnetization layout has no backend".into());
    }
    Ok(())
}
