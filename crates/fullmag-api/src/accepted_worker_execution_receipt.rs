use anyhow::{bail, Context, Result};
use fullmag_ir::ExecutionPlanIR;
use fullmag_session::SessionStore;
use serde::{Deserialize, Serialize};
use std::path::Path;

pub(super) const WORKER_EXECUTION_STARTED_RECEIPT: &str = "worker_execution_started.v1.json";
pub(super) const WORKER_EXECUTION_RECEIPT_SCHEMA: &str = "fullmag.accepted_worker_execution.v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct WorkerExecutionReceiptIdentity {
    pub(super) schema_version: String,
    pub(super) claim: fullmag_application::TaskClaim,
    pub(super) start_message_id: String,
    pub(super) start_sequence: u64,
    pub(super) case_id: String,
    pub(super) plan_fingerprint: String,
}

impl WorkerExecutionReceiptIdentity {
    pub(super) fn matches_same_attempt(&self, current: &Self) -> bool {
        self.schema_version == current.schema_version
            && self.claim.is_same_or_renewed_by(&current.claim)
            && self.start_message_id == current.start_message_id
            && self.start_sequence == current.start_sequence
            && self.case_id == current.case_id
            && self.plan_fingerprint == current.plan_fingerprint
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct WorkerExecutionStartedReceipt {
    pub(super) identity: WorkerExecutionReceiptIdentity,
}

pub(super) fn worker_execution_identity_from_plan(
    start: &fullmag_application::WorkerCommandEnvelope,
    claim: &fullmag_application::TaskClaim,
    execution_plan: &ExecutionPlanIR,
    case_id: &str,
) -> Result<WorkerExecutionReceiptIdentity> {
    let plan_fingerprint = fullmag_session::canonical_json_sha256(
        &serde_json::to_value(execution_plan)
            .context("serialize accepted worker execution plan for receipt")?,
    );
    Ok(WorkerExecutionReceiptIdentity {
        schema_version: WORKER_EXECUTION_RECEIPT_SCHEMA.into(),
        claim: claim.clone(),
        start_message_id: start.message_id.clone(),
        start_sequence: start.sequence,
        case_id: case_id.to_owned(),
        plan_fingerprint,
    })
}

/// Validate a terminal attempt without reopening the active-claim execution
/// path. Its receipt fingerprints the accepted plan, before materialization.
pub(super) fn validate_reported_native_failure_started(
    store: &SessionStore,
    attempt: &Path,
    claim: &fullmag_application::TaskClaim,
    start: &fullmag_application::WorkerCommandEnvelope,
) -> Result<()> {
    let intent = store.read_run_intent(claim.run_id.as_str())?
        .context("reported failure has no accepted run intent")?;
    let specification: fullmag_application::RunSpecification =
        serde_json::from_value(intent.specification)?;
    if specification.run_id != claim.run_id || !start.claim.matches_claim(claim) {
        bail!("reported failure Start differs from its accepted run or claim");
    }
    let accepted = fullmag_runtime_control::load_accepted_study_snapshot(
        store, &claim.run_id, &specification.snapshot.project_id,
    )?;
    let mut steps = accepted.lowered.steps.iter().filter(|step|
        fullmag_session::task_id_for_study_step(claim.run_id.as_str(), &step.step_id)
            .is_ok_and(|task_id| task_id == claim.task_id.as_str()));
    let step = steps.next().context("reported failure has no accepted step")?;
    if steps.next().is_some() {
        bail!("reported failure has an ambiguous accepted step");
    }
    let plan = step.execution_plan.as_ref()
        .context("reported failure has no accepted execution plan")?;
    let expected = worker_execution_identity_from_plan(start, claim, plan, "default")?;
    let bytes = fullmag_session::repository_path::read_bounded_regular_file(
        attempt, WORKER_EXECUTION_STARTED_RECEIPT, 1024 * 1024,
    )?;
    let started: WorkerExecutionStartedReceipt = serde_json::from_slice(&bytes)?;
    if !started.identity.matches_same_attempt(&expected) {
        bail!("reported failure Started identity differs from its accepted plan");
    }
    Ok(())
}
