//! Read-only automatic telemetry for one exact catalog-pinned accepted attempt.
//! This diagnostic never supplies physical completion or replays execution.
use std::path::Path;

use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde_json::json;
use fullmag_session::{FmsTaskLifecycle, SessionStore};
use crate::schemas::diagnostics::{RunPerformancePointResource, RunPerformanceResource};

const MAX_LIVE_BYTES: usize = 128 * 1024;
const MAX_RECEIPT_BYTES: usize = 2 * 1024 * 1024;
const MAX_POINTS: usize = 120;

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
        sample_sequence: 0, elapsed_monotonic_ns: 0, first_step_index: None, step_index: None,
        unique_step_callback_records: 0, rows_dropped: 0, collection_overhead_ns: None,
        latest_step_wall_ns: None, latest_rejected_attempts: None, latest_evaluate_host_wall_ns: None,
        gpu_scope: "whole_device".into(), gpu_unavailable_reason: None, points: vec![],
    }
}

fn is_observation_busy(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| cause.is::<fullmag_session::StoreWriterBusy>()
        || matches!(cause.downcast_ref::<std::fs::TryLockError>(),
            Some(std::fs::TryLockError::WouldBlock))
        || cause.downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::WouldBlock))
}

pub(crate) fn load(root: &Path, run_id: &str, stage_ids: &[String]) -> Result<RunPerformanceResource> {
    let _elapsed = crate::live_accepted_projection::ProjectionPhaseTimer::new("performance_load");
    match load_verified(root, run_id, stage_ids) {
        Ok(resource) => Ok(resource),
        // A busy read observed no new authority. Let resource-hook error
        // semantics retain the previous sample instead of publishing N/A.
        Err(error) if is_observation_busy(&error) => Err(error),
        Err(error) => {
            tracing::debug!(error = %format!("{error:#}"), "automatic performance unavailable for the pinned attempt");
            Ok(unavailable(Some(run_id.into()), "No verified performance snapshot for the current attempt"))
        }
    }
}

fn load_verified(root: &Path, run_id: &str, stage_ids: &[String]) -> Result<RunPerformanceResource> {
    fullmag_session::repository_path::validate_store_id(run_id)?;
    let store = SessionStore::open_existing(root)?;
    // Fence task selection and receipt/lease checks against an epoch transition.
    let _read = {
        let _elapsed = crate::live_accepted_projection::ProjectionPhaseTimer::new("performance_fence");
        store.read_transaction().context("read accepted performance fence")?
    };
    let catalog = store
        .read_run_catalog_in_transaction(run_id, &_read)?
        .context("performance run catalog missing")?;
    let mut candidates = Vec::new();
    for (order, step_id) in stage_ids.iter().enumerate() {
        let task_id = fullmag_session::task_id_for_study_step(run_id, step_id)?;
        if let Some(task) = catalog.tasks.iter().find(|task| task.task_id == task_id) {
            if task.attempt_id.is_some() && task.ownership_epoch.is_some() {
                candidates.push((order, step_id, task));
            }
        }
    }
    let running = candidates.iter().filter(|(_, _, task)| matches!(task.lifecycle,
        FmsTaskLifecycle::Running | FmsTaskLifecycle::Stopping)).copied().collect::<Vec<_>>();
    let (_, step_id, task) = if running.len() == 1 { *running.first().unwrap() }
        else if running.is_empty() { candidates.into_iter().max_by_key(|(order, _, _)| *order)
            .context("no verified performance task")? }
        else { bail!("parallel performance attempt selection is ambiguous"); };
    let expected = AcceptedIdentity {
        run_id: run_id.into(), task_id: task.task_id.clone(), step_id: step_id.clone(),
        attempt_id: task.attempt_id.clone().context("performance attempt missing")?,
        ownership_epoch: task.ownership_epoch.context("performance epoch missing")?,
    };
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
    Ok(RunPerformanceResource {
        revision: fullmag_session::canonical_json_sha256(&json!([
            expected.run_id, expected.task_id, expected.step_id, expected.attempt_id,
            expected.ownership_epoch, record.sample_sequence, public_state])),
        state: public_state,
        reason: finalizing.then(|| "Runner telemetry is final; accepted task publication is pending".into()),
        run_id: Some(expected.run_id), task_id: Some(expected.task_id),
        step_id: Some(expected.step_id), attempt_id: Some(expected.attempt_id), ownership_epoch: Some(expected.ownership_epoch),
        sample_sequence: record.sample_sequence, elapsed_monotonic_ns: record.elapsed_monotonic_ns,
        first_step_index: record.first_step_index, step_index: record.step_index,
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
        for change in 0..8 {
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
                _ => record.identity.accepted_identity.step_id = "other".into(),
            }
            assert!(validate(&record, &expected).is_err());
        }
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
        let error = load(store.root(), "run", &[]).unwrap_err();
        assert!(is_observation_busy(&error));
        drop(writer);
        assert_eq!(load(store.root(), "run", &[]).unwrap().state, "unavailable");
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
        let resource = load_verified(store.root(), "run", &["stage".into()]).unwrap();
        assert_eq!(resource.state, "running");
        assert_eq!(resource.attempt_id.as_deref(), Some("attempt"));
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
    let (run_id, stage_ids) = {
        let guard = state.current_live_state.read().await;
        let Some(snapshot) = guard.as_ref() else { return Ok(()); };
        crate::ensure_current_live_request_context(snapshot, &context,
            state.current_live_session_epoch.load(std::sync::atomic::Ordering::Acquire))?;
        let Some(run_id) = snapshot.run.as_ref().map(|run| run.run_id.clone()) else { return Ok(()); };
        let stages = snapshot.stage_execution.as_ref().map(|execution| execution.stages.iter()
            .filter_map(|stage| stage.stage_id.clone()).collect::<Vec<_>>()).unwrap_or_default();
        (run_id, stages)
    };
    let load_run = run_id.clone();
    let loaded = crate::live_accepted_projection::observe_projection_phase(
        "performance", tokio::task::spawn_blocking(move || load(&root, &load_run, &stage_ids)),
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
