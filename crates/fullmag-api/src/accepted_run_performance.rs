//! Read-only automatic telemetry for one exact catalog-pinned accepted attempt.
//! This diagnostic never supplies physical completion or replays execution.
use std::path::Path;

use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde_json::json;
use fullmag_session::{FmsTaskLifecycle, SessionStore};
use crate::schemas::diagnostics::{
    RunPerformancePointResource, RunPerformanceResource, RunPerformanceSolverClockResource,
};

const MAX_LIVE_BYTES: usize = 128 * 1024;
const MAX_RECEIPT_BYTES: usize = 2 * 1024 * 1024;
const MAX_POINTS: usize = 120;
const OBSERVATION_BUSY_RETRY_BUDGET: std::time::Duration = std::time::Duration::from_millis(100);

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
struct AcceptedIdentity {
    run_id: String,
    task_id: String,
    step_id: String,
    attempt_id: String,
    ownership_epoch: u64,
}

#[derive(Deserialize)]
struct RecorderIdentity { accepted_identity: AcceptedIdentity }

#[derive(Deserialize)]
struct LiveRecord {
    schema_version: String,
    identity: RecorderIdentity,
    sample_sequence: u64,
    state: String,
    elapsed_monotonic_ns: u64,
    first_step_index: Option<u64>,
    step_index: Option<u64>,
    #[serde(default)]
    solver_clock: Option<RunPerformanceSolverClockResource>,
    #[serde(default)]
    stage_start_time_s: Option<f64>,
    unique_step_callback_records: u64,
    rows_dropped: u64,
    collection_overhead_ns: Option<u64>,
    latest_step_wall_ns: Option<u64>,
    latest_rejected_attempts: Option<u64>,
    latest_evaluate_host_wall_ns: Option<u64>,
    gpu_scope: String,
    gpu_unavailable_reason: Option<String>,
    points: Vec<RunPerformancePointResource>,
}

fn validate(record: &LiveRecord, expected: &AcceptedIdentity) -> Result<()> {
    if record.schema_version != "fullmag.run_performance_live.v1"
        || &record.identity.accepted_identity != expected
        || record.sample_sequence == 0 || record.points.len() > MAX_POINTS
        || record.gpu_scope != "whole_device"
        || !matches!(record.state.as_str(), "running" | "completed" | "cancelled" | "error")
        || record.gpu_unavailable_reason.as_ref().is_some_and(|reason| reason.len() > 512)
        || record.first_step_index.zip(record.step_index).is_some_and(|(first, last)| first > last)
        || record.solver_clock.is_some_and(|clock| {
            !clock.time_s.is_finite() || clock.time_s < 0.0
                || !clock.dt_s.is_finite() || clock.dt_s < 0.0
                || record.step_index != Some(clock.step_index)
        })
        || record.stage_start_time_s.is_some_and(|time_s| !time_s.is_finite() || time_s < 0.0)
    { bail!("invalid performance record identity or bounds"); }
    let nonnegative = |value: Option<f64>| value.is_none_or(|value| value.is_finite() && value >= 0.0);
    let mut previous = 0;
    for point in &record.points {
        if point.elapsed_monotonic_ns < previous || point.elapsed_monotonic_ns > record.elapsed_monotonic_ns
            || !nonnegative(point.cpu_percent) || !nonnegative(point.gpu_percent)
            || !nonnegative(point.gpu_power_watts) || point.gpu_percent.is_some_and(|value| value > 100.0)
            || point.step_index.zip(record.step_index).is_some_and(|(step, last)| step > last)
            || point.step_index.zip(record.first_step_index).is_some_and(|(step, first)| step < first)
        { bail!("invalid performance sample clock, step or physical value"); }
        previous = point.elapsed_monotonic_ns;
    }
    Ok(())
}

pub(crate) fn unavailable(run_id: Option<String>, reason: &str) -> RunPerformanceResource {
    RunPerformanceResource {
        revision: fullmag_session::canonical_json_sha256(&json!([run_id, reason])),
        state: "unavailable".into(), reason: Some(reason.into()), run_id,
        task_id: None, step_id: None, attempt_id: None, ownership_epoch: None,
        stage_index: None,
        sample_sequence: 0, elapsed_monotonic_ns: 0, first_step_index: None, step_index: None,
        solver_clock: None, progress_fraction: None,
        unique_step_callback_records: 0, rows_dropped: 0, collection_overhead_ns: None,
        latest_step_wall_ns: None, latest_rejected_attempts: None, latest_evaluate_host_wall_ns: None,
        gpu_scope: "whole_device".into(), gpu_unavailable_reason: None, points: vec![],
    }
}

pub(crate) fn is_observation_busy(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| cause.is::<fullmag_session::StoreWriterBusy>()
        || matches!(cause.downcast_ref::<std::fs::TryLockError>(),
            Some(std::fs::TryLockError::WouldBlock))
        || cause.downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::WouldBlock))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SelectedAttempt {
    run_id: String,
    task_id: String,
    step_id: String,
    stage_index: u32,
    attempt_id: String,
    ownership_epoch: u64,
}

pub(crate) fn is_terminal_run_status(status: &str) -> bool {
    matches!(status, "completed" | "succeeded" | "failed" | "cancelled" | "interrupted" | "stopped" | "closed")
}

fn is_terminal_task_lifecycle(lifecycle: FmsTaskLifecycle) -> bool {
    matches!(lifecycle, FmsTaskLifecycle::Succeeded | FmsTaskLifecycle::Failed
        | FmsTaskLifecycle::Cancelled | FmsTaskLifecycle::Interrupted)
}

fn selected_attempt(
    run_id: &str,
    stage_index: u32,
    step_id: &str,
    task: &fullmag_session::FmsTaskCatalogEntry,
) -> Result<SelectedAttempt> {
    Ok(SelectedAttempt {
        run_id: run_id.into(),
        task_id: task.task_id.clone(),
        step_id: step_id.into(),
        stage_index,
        attempt_id: task.attempt_id.clone().context("performance attempt missing")?,
        ownership_epoch: task.ownership_epoch.context("performance epoch missing")?,
    })
}

fn select_attempt(
    run_id: &str,
    stages: &[(u32, String)],
    catalog: &fullmag_session::FmsRunCatalog,
    allow_terminal_fallback: bool,
) -> Result<Option<SelectedAttempt>> {
    let mut stage_tasks = Vec::new();
    for (stage_index, step_id) in stages {
        let task_id = fullmag_session::task_id_for_study_step(run_id, step_id)?;
        if let Some(task) = catalog.tasks.iter().find(|task| task.task_id == task_id) {
            stage_tasks.push((*stage_index, step_id.as_str(), task));
        }
    }

    let running = stage_tasks.iter().filter(|(_, _, task)| matches!(task.lifecycle,
        FmsTaskLifecycle::Running | FmsTaskLifecycle::Stopping)).copied().collect::<Vec<_>>();
    if running.len() > 1 {
        bail!("parallel performance attempt selection is ambiguous");
    }
    if let Some((stage_index, step_id, task)) = running.first() {
        return selected_attempt(run_id, *stage_index, *step_id, *task).map(Some);
    }

    // A running run can be between attempts while the next accepted task is
    // queued or preparing. The previous completed task is historical during
    // that handoff and must not be projected as the current solver clock.
    if !allow_terminal_fallback
        || stage_tasks.iter().any(|(_, _, task)| !is_terminal_task_lifecycle(task.lifecycle))
    {
        return Ok(None);
    }

    // For a terminal run only, retain the latest accepted task's terminal
    // telemetry. Do not skip a newer terminal task whose identity is missing
    // and accidentally fall back to an older stage.
    stage_tasks.into_iter()
        .max_by_key(|(stage_index, _, _)| *stage_index)
        .map(|(stage_index, step_id, task)| selected_attempt(run_id, stage_index, step_id, task))
        .transpose()
}

fn resource_attempt(resource: &RunPerformanceResource) -> Option<SelectedAttempt> {
    Some(SelectedAttempt {
        run_id: resource.run_id.clone()?,
        task_id: resource.task_id.clone()?,
        step_id: resource.step_id.clone()?,
        stage_index: resource.stage_index?,
        attempt_id: resource.attempt_id.clone()?,
        ownership_epoch: resource.ownership_epoch?,
    })
}

fn has_observation(resource: &RunPerformanceResource) -> bool {
    resource.state != "unavailable"
        || resource.sample_sequence != 0
        || resource.elapsed_monotonic_ns != 0
        || resource.first_step_index.is_some()
        || resource.step_index.is_some()
        || resource.solver_clock.is_some()
        || resource.progress_fraction.is_some()
        || resource.unique_step_callback_records != 0
        || resource.rows_dropped != 0
        || resource.collection_overhead_ns.is_some()
        || resource.latest_step_wall_ns.is_some()
        || resource.latest_rejected_attempts.is_some()
        || resource.latest_evaluate_host_wall_ns.is_some()
        || !resource.points.is_empty()
}

pub(crate) enum AttemptRevalidation {
    Current(fullmag_session::ReadTransaction),
    Changed,
}

/// Re-read the current catalog under a shared store fence and compare every
/// identity component before the route returns a previously loaded sample.
pub(crate) fn revalidate_attempt(
    root: &Path,
    run_id: &str,
    stages: &[(u32, String)],
    allow_terminal_fallback: bool,
    resource: &RunPerformanceResource,
) -> Result<AttemptRevalidation> {
    let store = SessionStore::open_existing(root)?;
    let transaction = store.read_transaction().context("revalidate accepted performance fence")?;
    let catalog = store.read_run_catalog(run_id)?.context("performance run catalog missing")?;
    let current = select_attempt(run_id, stages, &catalog, allow_terminal_fallback)?;
    let expected = resource_attempt(resource);
    if (has_observation(resource) && expected.is_none())
        || expected.as_ref().is_some_and(|expected| current.as_ref() != Some(expected))
    {
        return Ok(AttemptRevalidation::Changed);
    }
    Ok(AttemptRevalidation::Current(transaction))
}

pub(crate) fn load(
    root: &Path,
    run_id: &str,
    stages: &[(u32, String)],
    allow_terminal_fallback: bool,
) -> Result<RunPerformanceResource> {
    let _elapsed = crate::live_accepted_projection::ProjectionPhaseTimer::new("performance_load");
    let deadline = std::time::Instant::now() + OBSERVATION_BUSY_RETRY_BUDGET;
    let mut busy_retries = 0_u32;
    loop {
        match load_verified(root, run_id, stages, allow_terminal_fallback) {
            Ok(resource) => return Ok(resource),
            // Heartbeat acknowledgements and other short publications briefly
            // hold the exclusive store lease. Retry the complete fenced read
            // for a bounded interval so a transient collision does not hide
            // live telemetry; never read around the fence or reuse an
            // unverified partial observation.
            Err(error) if is_observation_busy(&error)
                && std::time::Instant::now() < deadline =>
            {
                let delay_ms = (5_u64 << busy_retries.min(2)).min(20);
                busy_retries = busy_retries.saturating_add(1);
                std::thread::sleep(std::time::Duration::from_millis(delay_ms)
                    .min(deadline.saturating_duration_since(std::time::Instant::now())));
            }
            // A busy read observed no new authority. Once the short retry
            // budget expires, resource-hook error semantics retain the
            // previous same-identity sample rather than publishing N/A.
            Err(error) if is_observation_busy(&error) => return Err(error),
            Err(error) => {
                tracing::debug!(error = %format!("{error:#}"), "automatic performance unavailable for the pinned attempt");
                return Ok(unavailable(Some(run_id.into()), "No verified performance snapshot for the current attempt"));
            }
        }
    }
}

fn load_verified(
    root: &Path,
    run_id: &str,
    stages: &[(u32, String)],
    allow_terminal_fallback: bool,
) -> Result<RunPerformanceResource> {
    fullmag_session::repository_path::validate_store_id(run_id)?;
    let store = SessionStore::open_existing(root)?;
    // Fence task selection and receipt/lease checks against an epoch transition.
    let _read = {
        let _elapsed = crate::live_accepted_projection::ProjectionPhaseTimer::new("performance_fence");
        store.read_transaction().context("read accepted performance fence")?
    };
    let catalog = store.read_run_catalog(run_id)?.context("performance run catalog missing")?;
    let selected = select_attempt(run_id, stages, &catalog, allow_terminal_fallback)?
        .context("no verified performance task")?;
    let stage_index = selected.stage_index;
    let expected = AcceptedIdentity {
        run_id: selected.run_id,
        task_id: selected.task_id,
        step_id: selected.step_id,
        attempt_id: selected.attempt_id,
        ownership_epoch: selected.ownership_epoch,
    };
    let task = catalog.tasks.iter().find(|task| task.task_id == expected.task_id)
        .context("selected performance task disappeared from the fenced catalog")?;
    for id in [&expected.task_id, &expected.attempt_id] {
        fullmag_session::repository_path::validate_store_id(id)?;
    }
    let attempt = format!("runs/{run_id}/worker-attempts/{}/{}/epoch-{}",
        expected.task_id, expected.attempt_id, expected.ownership_epoch);
    // The execution receipt identity is the existing immutable worker binding.
    let started: serde_json::Value = serde_json::from_slice(
        &fullmag_session::repository_path::read_bounded_regular_file(root,
            &format!("{attempt}/worker_execution_started.v1.json"), MAX_RECEIPT_BYTES)?)?;
    let identity = started.get("identity").context("performance started identity missing")?;
    let claim: fullmag_application::TaskClaim = serde_json::from_value(
        identity.get("claim").context("performance receipt claim missing")?.clone())?;
    if claim.run_id.as_str() != expected.run_id || claim.task_id.as_str() != expected.task_id
        || claim.attempt_id.as_str() != expected.attempt_id
        || claim.ownership_epoch.value() != expected.ownership_epoch
        || task.resource_id.as_deref() != Some(claim.lease.resource_id.as_str())
        || identity.get("schema_version").and_then(|value| value.as_str()) != Some("fullmag.accepted_worker_execution.v1")
        || identity.get("start_sequence").and_then(|value| value.as_u64()).is_none_or(|sequence| sequence == 0)
    { bail!("performance started receipt does not bind the pinned attempt"); }
    if task.lifecycle == FmsTaskLifecycle::Succeeded {
        let completed: serde_json::Value = serde_json::from_slice(
            &fullmag_session::repository_path::read_bounded_regular_file(root,
                &format!("{attempt}/worker_execution_completed.v1.json"), MAX_RECEIPT_BYTES)?)?;
        if completed.get("identity") != Some(identity)
            || completed.get("status").and_then(|value| value.as_str()) != Some("completed")
            || !matches!(completed.get("schema_version").and_then(|value| value.as_str()),
                Some("fullmag.accepted_worker_execution.v1" | "fullmag.accepted_worker_execution.v2"
                    | "fullmag.accepted_worker_execution.v3" | "fullmag.accepted_worker_execution.v4"))
        { bail!("performance completed receipt does not bind the terminal attempt"); }
    } else if matches!(task.lifecycle, FmsTaskLifecycle::Running | FmsTaskLifecycle::Stopping) {
        // load_current_task_claim is a writer/recovery helper. Calling it
        // under this shared read fence would conflict with our own reader.
        // Observe the exact immutable receipt-pinned lease without mutation.
        let lease = store.read_resource_lease(run_id, claim.lease.resource_id.as_str(),
            claim.lease.lease_token.as_str())?.context("performance active lease missing")?;
        validate_active_lease(task, &claim, &lease)?;
    } else if matches!(task.lifecycle, FmsTaskLifecycle::Failed | FmsTaskLifecycle::Cancelled | FmsTaskLifecycle::Interrupted) {
        // Failed/cancelled workers do not write a completed execution receipt.
        // Their existing process-exit receipt plus released exact lease proves
        // this attempt ended; it supplies no scientific completion evidence.
        let lease = store.read_resource_lease(run_id, claim.lease.resource_id.as_str(),
            claim.lease.lease_token.as_str())?.context("terminal performance lease missing")?;
        let receipts = store.list_worker_process_exit_receipts(run_id)?;
        let matching = receipts.iter().filter(|receipt|
            receipt.run_id == expected.run_id && receipt.task_id == expected.task_id
            && receipt.attempt_id == expected.attempt_id && receipt.ownership_epoch == expected.ownership_epoch
            && receipt.resource_id == claim.lease.resource_id.as_str()
            && receipt.lease_token == claim.lease.lease_token.as_str()
            && receipt.lease_heartbeat_sequence == lease.heartbeat_sequence).collect::<Vec<_>>();
        if matching.len() != 1 || lease.state != fullmag_session::FmsResourceLeaseState::Released
            || lease.run_id != expected.run_id || lease.task_id != expected.task_id
            || lease.attempt_id != expected.attempt_id || lease.ownership_epoch != expected.ownership_epoch {
            bail!("terminal performance exit receipt does not bind the released exact lease");
        }
    } else { bail!("terminal performance receipt proof unavailable for this lifecycle"); }
    let bytes = fullmag_session::repository_path::read_bounded_regular_file(root,
        &format!("{attempt}/performance/live.v1.json"), MAX_LIVE_BYTES)?;
    let record: LiveRecord = serde_json::from_slice(&bytes)?;
    validate(&record, &expected)?;
    if task.lifecycle == FmsTaskLifecycle::Succeeded && record.state != "completed" {
        bail!("performance state differs from terminal task receipt");
    }
    if matches!(task.lifecycle, FmsTaskLifecycle::Cancelled) && record.state != "cancelled"
        || matches!(task.lifecycle, FmsTaskLifecycle::Failed | FmsTaskLifecycle::Interrupted) && record.state != "error" {
        bail!("performance state differs from the terminal exit proof");
    }
    let finalizing = matches!(task.lifecycle, FmsTaskLifecycle::Running | FmsTaskLifecycle::Stopping)
        && record.state != "running";
    let public_state = if finalizing { "finalizing".to_owned() } else { record.state.clone() };
    let progress_fraction = record.solver_clock.and_then(|clock| {
        let duration = accepted_stage_duration_seconds(&store, run_id, &expected.step_id)?;
        let start = record.stage_start_time_s?;
        fraction_from_clock(clock.time_s, start, duration)
    });
    Ok(RunPerformanceResource {
        revision: fullmag_session::canonical_json_sha256(&json!([
            expected.run_id, expected.task_id, expected.step_id, expected.attempt_id,
            expected.ownership_epoch, record.sample_sequence, public_state])),
        state: public_state,
        reason: finalizing.then(|| "Runner telemetry is final; accepted task publication is pending".into()),
        run_id: Some(expected.run_id), task_id: Some(expected.task_id),
        step_id: Some(expected.step_id), stage_index: Some(stage_index),
        attempt_id: Some(expected.attempt_id), ownership_epoch: Some(expected.ownership_epoch),
        sample_sequence: record.sample_sequence, elapsed_monotonic_ns: record.elapsed_monotonic_ns,
        first_step_index: record.first_step_index, step_index: record.step_index,
        solver_clock: record.solver_clock, progress_fraction,
        unique_step_callback_records: record.unique_step_callback_records, rows_dropped: record.rows_dropped,
        collection_overhead_ns: record.collection_overhead_ns, latest_step_wall_ns: record.latest_step_wall_ns,
        latest_rejected_attempts: record.latest_rejected_attempts,
        latest_evaluate_host_wall_ns: record.latest_evaluate_host_wall_ns,
        gpu_scope: record.gpu_scope,
        gpu_unavailable_reason: record.gpu_unavailable_reason.map(|reason|
            if reason.len() <= 128 && reason.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_') {
                reason
            } else { "gpu_telemetry_unavailable".into() }),
        points: record.points,
    })
}

fn accepted_stage_duration_seconds(store: &SessionStore, run_id: &str, step_id: &str) -> Option<f64> {
    let intent = store.read_run_intent(run_id).ok()??;
    let specification: fullmag_application::RunSpecification =
        serde_json::from_value(intent.specification).ok()?;
    if specification.validate().is_err() || specification.run_id.as_str() != run_id {
        return None;
    }
    let study_ref = &specification.study;
    if intent.study_object_ref.as_deref() != Some(study_ref.plan_sha256.as_str()) {
        return None;
    }
    let bytes = store.cas().get_bounded(
        &study_ref.plan_sha256,
        fullmag_session::MAX_TERMINAL_CATALOG_METADATA_BYTES,
    ).ok()??;
    let study: fullmag_authoring::StudyPlan = serde_json::from_slice(&bytes).ok()?;
    if study.validate().is_err()
        || study.study_id != study_ref.study_id.as_str()
        || study.schema_version != study_ref.plan_version
        || study.canonical_sha256().ok()?.as_str() != study_ref.plan_sha256
    {
        return None;
    }
    study.steps.iter()
        .find(|step| step.step_id == step_id)
        .and_then(|step| step.until_seconds)
        .filter(|duration| duration.is_finite() && *duration > 0.0)
}

fn fraction_from_clock(time_s: f64, start_time_s: f64, duration_s: f64) -> Option<f64> {
    if !time_s.is_finite() || time_s < 0.0
        || !start_time_s.is_finite() || start_time_s < 0.0
        || !duration_s.is_finite() || duration_s <= 0.0
        || time_s < start_time_s
    {
        return None;
    }
    Some(((time_s - start_time_s) / duration_s).clamp(0.0, 1.0))
}

/// Caller retains the native shared transaction covering both task and lease.
/// This is a diagnostic observation, never a publication/admission authority.
fn validate_active_lease(
    task: &fullmag_session::FmsTaskCatalogEntry,
    claim: &fullmag_application::TaskClaim,
    lease: &fullmag_session::FmsResourceLease,
) -> Result<()> {
    use fullmag_application::ResourceKind;
    use fullmag_session::{FmsResourceKind, FmsResourceLeaseState, FmsTaskReadiness};
    let kind = match claim.lease.kind {
        ResourceKind::Cpu => FmsResourceKind::Cpu,
        ResourceKind::Gpu => FmsResourceKind::Gpu,
        ResourceKind::Storage => FmsResourceKind::Storage,
        ResourceKind::Meshing => FmsResourceKind::Meshing,
    };
    if task.readiness != FmsTaskReadiness::Ready
        || !matches!(task.lifecycle, FmsTaskLifecycle::Running | FmsTaskLifecycle::Stopping)
        || task.task_id != claim.task_id.as_str()
        || task.attempt_id.as_deref() != Some(claim.attempt_id.as_str())
        || task.ownership_epoch != Some(claim.ownership_epoch.value())
        || task.resource_id.as_deref() != Some(claim.lease.resource_id.as_str())
        || lease.state != FmsResourceLeaseState::Active
        || lease.run_id != claim.run_id.as_str() || lease.task_id != claim.task_id.as_str()
        || lease.attempt_id != claim.attempt_id.as_str()
        || lease.ownership_epoch != claim.ownership_epoch.value()
        || lease.resource_id != claim.lease.resource_id
        || lease.lease_token != claim.lease.lease_token.as_str()
        || lease.kind != kind || lease.budget.cpu_millis != claim.lease.budget.cpu_millis
        || lease.budget.memory_bytes != claim.lease.budget.memory_bytes
        || lease.budget.gpu_memory_bytes != claim.lease.budget.gpu_memory_bytes
        || lease.budget.storage_bytes != claim.lease.budget.storage_bytes
        || lease.heartbeat_sequence < claim.lease.heartbeat_sequence {
        bail!("performance active task/lease differs from the pinned claim");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task_entry(
        run_id: &str,
        step_id: &str,
        lifecycle: FmsTaskLifecycle,
        attempt_id: Option<&str>,
        ownership_epoch: Option<u64>,
    ) -> fullmag_session::FmsTaskCatalogEntry {
        fullmag_session::FmsTaskCatalogEntry {
            task_id: fullmag_session::task_id_for_study_step(run_id, step_id).unwrap(),
            input_fingerprint: "a".repeat(64),
            lifecycle,
            readiness: fullmag_session::FmsTaskReadiness::Ready,
            observation: None,
            attempt_id: attempt_id.map(str::to_owned),
            ownership_epoch,
            resolved_input_fingerprint: None,
            artifact_ids: vec![],
            resource_id: None,
            coordinator_watermark: None,
            coordinator_genesis: None,
        }
    }

    fn run_catalog(tasks: Vec<fullmag_session::FmsTaskCatalogEntry>) -> fullmag_session::FmsRunCatalog {
        fullmag_session::FmsRunCatalog {
            schema_version: fullmag_session::FMS_RUN_CATALOG_SCHEMA.into(),
            run_id: "run".into(),
            revision: 1,
            updated_at: chrono::Utc::now(),
            tasks,
        }
    }

    fn observed_resource(identity: SelectedAttempt) -> RunPerformanceResource {
        let mut resource = unavailable(Some(identity.run_id.clone()), "test fixture");
        resource.state = "running".into();
        resource.task_id = Some(identity.task_id);
        resource.step_id = Some(identity.step_id);
        resource.stage_index = Some(identity.stage_index);
        resource.attempt_id = Some(identity.attempt_id);
        resource.ownership_epoch = Some(identity.ownership_epoch);
        resource.sample_sequence = 1;
        resource
    }

    #[test]
    fn active_stage_handoff_does_not_select_the_prior_completed_attempt() {
        let catalog = run_catalog(vec![
            task_entry("run", "stage-0", FmsTaskLifecycle::Succeeded, Some("attempt-0"), Some(1)),
            task_entry("run", "stage-1", FmsTaskLifecycle::Queued, None, None),
        ]);
        let selected = select_attempt(
            "run",
            &[(0, "stage-0".into()), (1, "stage-1".into())],
            &catalog,
            false,
        )
        .unwrap();

        assert_eq!(selected, None);
    }

    #[test]
    fn terminal_run_selects_the_latest_completed_attempt() {
        let catalog = run_catalog(vec![
            task_entry("run", "stage-0", FmsTaskLifecycle::Succeeded, Some("attempt-0"), Some(1)),
            task_entry("run", "stage-1", FmsTaskLifecycle::Succeeded, Some("attempt-1"), Some(2)),
        ]);
        let selected = select_attempt(
            "run",
            &[(0, "stage-0".into()), (1, "stage-1".into())],
            &catalog,
            true,
        )
        .unwrap()
        .unwrap();

        assert_eq!(selected.stage_index, 1);
        assert_eq!(selected.step_id, "stage-1");
        assert_eq!(selected.attempt_id, "attempt-1");
        assert_eq!(selected.ownership_epoch, 2);
    }

    #[test]
    fn same_stage_retry_is_rejected_by_the_final_catalog_fence() {
        use fullmag_session::{FmsRunCatalog, FMS_RUN_CATALOG_SCHEMA};

        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("store")).unwrap();
        let task = task_entry("run", "stage", FmsTaskLifecycle::Running, Some("attempt-new"), Some(2));
        store.commit_run_catalog(&FmsRunCatalog {
            schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
            run_id: "run".into(),
            revision: 1,
            updated_at: chrono::Utc::now(),
            tasks: vec![task],
        }).unwrap();

        let current = SelectedAttempt {
            run_id: "run".into(),
            task_id: fullmag_session::task_id_for_study_step("run", "stage").unwrap(),
            step_id: "stage".into(),
            stage_index: 0,
            attempt_id: "attempt-new".into(),
            ownership_epoch: 2,
        };
        let current_resource = observed_resource(current.clone());
        let verified = revalidate_attempt(
            store.root(), "run", &[(0, "stage".into())], false, &current_resource,
        ).unwrap();
        let AttemptRevalidation::Current(fence) = verified else {
            panic!("the exact current attempt should remain publishable");
        };
        assert!(store.write_transaction().is_err(), "the final shared fence must exclude writers");
        drop(fence);

        let mut old_attempt = current;
        old_attempt.attempt_id = "attempt-old".into();
        old_attempt.ownership_epoch = 1;
        let stale_resource = observed_resource(old_attempt);
        assert!(matches!(revalidate_attempt(
            store.root(), "run", &[(0, "stage".into())], false, &stale_resource,
        ).unwrap(), AttemptRevalidation::Changed));
        let writer = store.write_transaction().expect("a rejected stale sample releases its fence");
        drop(writer);
    }

    fn fixture() -> (LiveRecord, AcceptedIdentity) {
        let identity = AcceptedIdentity {
            run_id: "run".into(), task_id: "task".into(), step_id: "stage".into(),
            attempt_id: "attempt".into(), ownership_epoch: 1,
        };
        let record = LiveRecord {
            schema_version: "fullmag.run_performance_live.v1".into(),
            identity: RecorderIdentity { accepted_identity: identity.clone() },
            sample_sequence: 1, state: "running".into(), elapsed_monotonic_ns: 10,
            first_step_index: Some(0), step_index: Some(2), unique_step_callback_records: 3,
            solver_clock: Some(RunPerformanceSolverClockResource { step_index: 2, time_s: 2.0e-9, dt_s: 0.0 }),
            stage_start_time_s: Some(0.0),
            rows_dropped: 0, collection_overhead_ns: None, latest_step_wall_ns: Some(5),
            latest_rejected_attempts: None, latest_evaluate_host_wall_ns: None,
            gpu_scope: "whole_device".into(), gpu_unavailable_reason: None,
            points: vec![RunPerformancePointResource {
                elapsed_monotonic_ns: 10, step_index: Some(2), cpu_percent: Some(250.0),
                rss_bytes: Some(1024), gpu_percent: Some(0.0), gpu_memory_bytes: Some(1024), gpu_power_watts: None,
            }],
        };
        (record, identity)
    }

    #[test]
    fn bounded_performance_rejects_foreign_attempts_and_invalid_samples() {
        let (record, expected) = fixture();
        assert!(validate(&record, &expected).is_ok());
        for change in 0..4 {
            let mut foreign = expected.clone();
            match change {
                0 => foreign.run_id = "other".into(),
                1 => foreign.task_id = "other".into(),
                2 => foreign.attempt_id = "other".into(),
                _ => foreign.ownership_epoch += 1,
            }
            assert!(validate(&record, &foreign).is_err());
        }
        for change in 0..11 {
            let (mut record, expected) = fixture();
            match change {
                0 => record.points[0].cpu_percent = Some(f64::NAN),
                1 => record.points[0].gpu_percent = Some(101.0),
                2 => record.points[0].gpu_power_watts = Some(-1.0),
                3 => record.points[0].elapsed_monotonic_ns = 11,
                4 => record.points[0].step_index = Some(3),
                5 => record.points.resize(121, record.points[0].clone()),
                6 => record.points.push(RunPerformancePointResource {
                    elapsed_monotonic_ns: 5, ..record.points[0].clone()
                }),
                7 => record.identity.accepted_identity.step_id = "other".into(),
                8 => record.solver_clock.as_mut().unwrap().step_index += 1,
                9 => record.solver_clock.as_mut().unwrap().time_s = f64::NAN,
                _ => record.solver_clock.as_mut().unwrap().dt_s = -1.0,
            }
            assert!(validate(&record, &expected).is_err());
        }
    }

    #[test]
    fn bounded_solver_clock_preserves_zero_dt_and_uses_nonzero_stage_origin() {
        let (record, expected) = fixture();
        assert!(validate(&record, &expected).is_ok());
        assert_eq!(record.solver_clock.unwrap().dt_s, 0.0);
        let fraction = fraction_from_clock(27.488e-9, 20e-9, 20e-9).unwrap();
        assert!((fraction - 0.3744).abs() < 1e-12);
        assert_eq!(fraction_from_clock(50e-9, 20e-9, 20e-9), Some(1.0));
        assert_eq!(fraction_from_clock(19e-9, 20e-9, 20e-9), None);
        assert_eq!(fraction_from_clock(1e-9, 0.0, 0.0), None);
    }

    #[test]
    fn stage_duration_is_read_from_the_exact_accepted_immutable_plan() {
        use fullmag_application::{
            ProjectId, ProjectSnapshot, RequestedExecution, RequestedResourceBudget,
            RunSpecification, StudyId, StudyReference,
        };
        use fullmag_authoring::{StudyPlan, STUDY_PLAN_SCHEMA_VERSION_V2};

        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        let study: StudyPlan = serde_json::from_value(json!({
            "schema_version": STUDY_PLAN_SCHEMA_VERSION_V2,
            "study_id": "study-progress",
            "revision": 1,
            "steps": [{
                "step_id": "stage-run",
                "label": "Run",
                "kind": { "kind": "primitive", "stage_kind": "run" },
                "model": { "model_id": "model-one", "version": "v1" },
                "solver_config": { "preset_id": "solver-default", "version": "v1" },
                "discretization": { "recipe_id": "mesh-default", "version": "v1" },
                "execution_profile": { "profile_id": "exec-auto", "version": "v1" },
                "until_seconds": 20e-9,
                "acceptance": { "kind": "any" },
                "acquisition": "exclusive"
            }]
        })).unwrap();
        study.validate().unwrap();
        let plan_sha256 = study.canonical_sha256().unwrap();
        let specification = RunSpecification::new(
            ProjectSnapshot {
                project_id: ProjectId::parse("project-progress").unwrap(),
                definition_revision: 1,
                definition_sha256: "a".repeat(64),
            },
            StudyReference {
                study_id: StudyId::parse("study-progress").unwrap(),
                plan_version: study.schema_version.clone(),
                plan_sha256: plan_sha256.clone(),
            },
            "b".repeat(64),
            json!({}),
            RequestedExecution {
                backend: "fdm".into(), device: "cpu".into(), precision: "double".into(),
                mode: "strict".into(), minimum_resources: Some(RequestedResourceBudget {
                    cpu_millis: 100, memory_bytes: 1024, gpu_memory_bytes: 0, storage_bytes: 1024,
                }),
            },
        );
        specification.validate().unwrap();
        let run_id = specification.run_id.as_str().to_owned();
        let study_bytes = study.canonical_json_bytes().unwrap();
        assert_eq!(store.cas().put(&study_bytes).unwrap(), plan_sha256);
        let mut intent = fullmag_session::FmsRunIntent::new(
            run_id.clone(), "performance-progress-intent", serde_json::to_value(specification).unwrap(),
        );
        intent.study_object_ref = Some(plan_sha256.clone());
        store.commit_run_intent(&intent).unwrap();

        assert_eq!(accepted_stage_duration_seconds(&store, &run_id, "stage-run"), Some(20e-9));
        assert_eq!(accepted_stage_duration_seconds(&store, &run_id, "foreign-stage"), None);
    }

    #[test]
    fn performance_reads_are_bounded_and_never_follow_symlinks() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("oversized"), vec![b' '; MAX_LIVE_BYTES + 1]).unwrap();
        assert!(fullmag_session::repository_path::read_bounded_regular_file(
            directory.path(), "oversized", MAX_LIVE_BYTES).is_err());
        #[cfg(unix)] {
            std::os::unix::fs::symlink("oversized", directory.path().join("linked")).unwrap();
            assert!(fullmag_session::repository_path::read_bounded_regular_file(
                directory.path(), "linked", MAX_LIVE_BYTES).is_err());
        }
    }

    #[test]
    fn busy_performance_observation_is_retryable_but_missing_authority_is_unavailable() {
        for error in [
            anyhow::Error::new(fullmag_session::StoreWriterBusy),
            anyhow::Error::new(std::fs::TryLockError::WouldBlock),
            anyhow::Error::new(std::io::Error::from(std::io::ErrorKind::WouldBlock)),
        ] {
            assert!(is_observation_busy(&error.context("nested read context")));
        }
        assert!(!is_observation_busy(&anyhow::anyhow!("foreign attempt")));
        assert!(!is_observation_busy(&anyhow::Error::new(
            std::io::Error::from(std::io::ErrorKind::NotFound))));
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("store")).unwrap();
        let writer = store.write_transaction().unwrap();
        let error = load(store.root(), "run", &[], false).unwrap_err();
        assert!(is_observation_busy(&error));
        drop(writer);
        assert_eq!(load(store.root(), "run", &[], false).unwrap().state, "unavailable");
    }

    #[test]
    fn performance_read_retries_a_short_store_writer_lease_without_dropping_the_fence() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("store")).unwrap();
        let root = store.root().to_path_buf();
        let writer_root = root.clone();
        let (held_tx, held_rx) = std::sync::mpsc::channel();
        let writer = std::thread::spawn(move || {
            let writer_store = SessionStore::open_existing(&writer_root).unwrap();
            let lease = writer_store.write_transaction().unwrap();
            held_tx.send(()).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(35));
            drop(lease);
        });
        held_rx.recv_timeout(std::time::Duration::from_secs(1)).unwrap();

        let resource = load(&root, "run", &[], false).unwrap();
        assert_eq!(resource.state, "unavailable");
        writer.join().unwrap();
    }

    #[test]
    fn running_performance_uses_exact_lease_under_shared_fence_without_writer_recovery() {
        use fullmag_application::{TaskClaim, RunId, TaskId, AttemptId, OwnershipEpoch,
            ResourceLease, ResourceBudget, ResourceKind};
        use fullmag_session::{FmsTaskCatalogEntry, FmsTaskReadiness, FmsCoordinatorWatermark,
            FmsRunCatalog, FmsResourceLease, FmsResourceLeaseState, FmsResourceKind,
            FmsResourceBudget, FMS_RUN_CATALOG_SCHEMA, FMS_RESOURCE_LEASE_SCHEMA};
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("store")).unwrap();
        let task_id = fullmag_session::task_id_for_study_step("run", "stage").unwrap();
        let claim = TaskClaim {
            run_id: RunId::parse("run").unwrap(), task_id: TaskId::parse(&task_id).unwrap(),
            attempt_id: AttemptId::parse("attempt").unwrap(), ownership_epoch: OwnershipEpoch::new(1).unwrap(),
            lease: ResourceLease::new("cpu-performance", ResourceKind::Cpu,
                ResourceBudget { cpu_millis: 100, memory_bytes: 1024, gpu_memory_bytes: 0, storage_bytes: 1024 }).unwrap(),
        };
        let task = FmsTaskCatalogEntry {
            task_id: task_id.clone(), input_fingerprint: "a".repeat(64), lifecycle: FmsTaskLifecycle::Running,
            readiness: FmsTaskReadiness::Ready, observation: None, attempt_id: Some("attempt".into()),
            ownership_epoch: Some(1), resolved_input_fingerprint: None, artifact_ids: vec![],
            resource_id: Some(claim.lease.resource_id.clone()), coordinator_watermark: Some(FmsCoordinatorWatermark::default()),
            coordinator_genesis: None,
        };
        let now = chrono::Utc::now();
        store.commit_run_catalog(&FmsRunCatalog {
            schema_version: FMS_RUN_CATALOG_SCHEMA.into(), run_id: "run".into(), revision: 1,
            updated_at: now, tasks: vec![task.clone()],
        }).unwrap();
        let lease = FmsResourceLease {
            schema_version: FMS_RESOURCE_LEASE_SCHEMA.into(), resource_id: claim.lease.resource_id.clone(),
            kind: FmsResourceKind::Cpu,
            budget: FmsResourceBudget { cpu_millis: 100, memory_bytes: 1024, gpu_memory_bytes: 0, storage_bytes: 1024 },
            run_id: "run".into(), task_id: task_id.clone(), attempt_id: "attempt".into(), ownership_epoch: 1,
            lease_token: claim.lease.lease_token.as_str().into(), state: FmsResourceLeaseState::Active,
            acquired_at: now, heartbeat_at: now, heartbeat_sequence: 0, released_at: None, host_launch_binding: None,
        };
        store.commit_resource_lease(&lease).unwrap();
        let attempt = store.root().join(format!("runs/run/worker-attempts/{task_id}/attempt/epoch-1"));
        std::fs::create_dir_all(attempt.join("performance")).unwrap();
        std::fs::write(attempt.join("worker_execution_started.v1.json"), serde_json::to_vec(&json!({
            "identity": { "schema_version": "fullmag.accepted_worker_execution.v1", "claim": claim,
                "start_sequence": 2, "start_message_id": "start", "case_id": "default", "plan_fingerprint": "a".repeat(64) }
        })).unwrap()).unwrap();
        std::fs::write(attempt.join("performance/live.v1.json"), serde_json::to_vec(&json!({
            "schema_version": "fullmag.run_performance_live.v1", "identity": { "accepted_identity": {
                "run_id": "run", "task_id": task_id, "step_id": "stage", "attempt_id": "attempt", "ownership_epoch": 1
            } }, "sample_sequence": 1, "state": "running", "elapsed_monotonic_ns": 1,
            "first_step_index": null, "step_index": null, "unique_step_callback_records": 0,
            "rows_dropped": 0, "collection_overhead_ns": null, "latest_step_wall_ns": null,
            "latest_rejected_attempts": null, "latest_evaluate_host_wall_ns": null,
            "gpu_scope": "whole_device", "gpu_unavailable_reason": "not_applicable_cpu_realization", "points": []
        })).unwrap()).unwrap();
        let reader = store.read_transaction().unwrap();
        assert!(store.write_transaction().is_err(), "the shared fence must still exclude writers");
        let resource = load_verified(store.root(), "run", &[(0, "stage".into())], false).unwrap();
        assert_eq!(resource.state, "running");
        assert_eq!(resource.attempt_id.as_deref(), Some("attempt"));
        assert_eq!(resource.stage_index, Some(0));
        assert!(resource.solver_clock.is_none());
        assert_eq!(resource.progress_fraction, None);
        let observed = store.read_resource_lease("run", &claim.lease.resource_id,
            claim.lease.lease_token.as_str()).unwrap().unwrap();
        assert!(validate_active_lease(&task, &claim, &observed).is_ok());
        for change in 0..5 {
            let mut invalid = observed.clone();
            match change {
                0 => invalid.state = FmsResourceLeaseState::Released,
                1 => invalid.attempt_id = "foreign".into(),
                2 => invalid.ownership_epoch += 1,
                3 => invalid.lease_token = "foreign".into(),
                _ => invalid.budget.memory_bytes += 1,
            }
            assert!(validate_active_lease(&task, &claim, &invalid).is_err());
        }
        drop(reader);
    }

    #[test]
    fn unavailable_performance_does_not_invent_measurements() {
        let resource = unavailable(Some("run".into()), "No verified attempt");
        assert_eq!(resource.state, "unavailable");
        assert!(resource.points.is_empty() && resource.task_id.is_none());
        assert!(resource.stage_index.is_none() && resource.solver_clock.is_none());
        assert!(resource.progress_fraction.is_none());
        assert!(resource.collection_overhead_ns.is_none() && resource.latest_step_wall_ns.is_none());
    }
}

#[derive(Default)]
pub(crate) struct InvalidationCursor {
    last_identity: Option<(String, u64, String)>,
    sequence: u64,
}

/// Reuse the accepted projector's timer; emit metadata only for a new recorder
/// sequence or catalog-backed lifecycle. No new polling thread or WS samples.
pub(crate) async fn publish_if_changed(
    state: &std::sync::Arc<crate::AppState>,
    cursor: &mut InvalidationCursor,
) -> std::result::Result<(), crate::error::ApiError> {
    let Some(root) = state.submit_store_root.clone() else { return Ok(()); };
    let context = crate::capture_current_live_read_context(state).await?;
    let (run_id, stage_ids, allow_terminal_fallback) = {
        let guard = state.current_live_state.read().await;
        let Some(snapshot) = guard.as_ref() else { return Ok(()); };
        crate::ensure_current_live_request_context(snapshot, &context,
            state.current_live_session_epoch.load(std::sync::atomic::Ordering::Acquire))?;
        let Some(run_id) = snapshot.run.as_ref().map(|run| run.run_id.clone()) else { return Ok(()); };
        let stages = snapshot.stage_execution.as_ref().map(|execution| execution.stages.iter()
            .enumerate().filter_map(|(index, stage)| Some((u32::try_from(index).ok()?, stage.stage_id.clone()?)))
            .collect::<Vec<_>>()).unwrap_or_default();
        let allow_terminal_fallback = snapshot.run.as_ref()
            .is_some_and(|run| is_terminal_run_status(&run.status));
        (run_id, stages, allow_terminal_fallback)
    };
    let load_run = run_id.clone();
    let loaded = crate::live_accepted_projection::observe_projection_phase(
        "performance", tokio::task::spawn_blocking(move ||
            load(&root, &load_run, &stage_ids, allow_terminal_fallback)),
    ).await;
    // Contention observes nothing; an actual missing/changed proof publishes
    // unavailable once so a previous attempt cannot remain current.
    let Ok(Ok(resource)) = loaded else { return Ok(()); };
    let key = (context.session_id.clone(), context.session_epoch, resource.revision);
    if cursor.last_identity.as_ref() == Some(&key) { return Ok(()); }
    {
        let guard = state.current_live_state.read().await;
        let Some(snapshot) = guard.as_ref() else { return Ok(()); };
        crate::ensure_current_live_request_context(snapshot, &context,
            state.current_live_session_epoch.load(std::sync::atomic::Ordering::Acquire))?;
        if snapshot.run.as_ref().map(|run| &run.run_id) != Some(&run_id) { return Ok(()); }
    }
    let sequence = cursor.sequence.saturating_add(1);
    crate::publish_current_live_realtime_resource_changes(state, context.session_id,
        Some(run_id), vec![crate::schemas::realtime::RealtimeResourceChange {
            resource: crate::schemas::realtime::RealtimeResourceName::Diagnostics,
            revision: sequence, resource_id: Some("performance".into()), quantity_ids: vec![],
            broad: false, domain_generation_id: None,
            recommended_fetch: Some("/v2/sessions/current/diagnostics/performance".into()),
        }], true, 1000).await?;
    cursor.last_identity = Some(key);
    cursor.sequence = sequence;
    Ok(())
}
