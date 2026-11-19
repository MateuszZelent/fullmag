//! Lossy, bounded diagnostics for an accepted antenna operation.
use super::{AcceptedLiveObservationHeader, ACCEPTED_LIVE_OBSERVATION_FILE, ACCEPTED_LIVE_OBSERVATION_SCHEMA};
use anyhow::{bail, Result};
use fullmag_runner::{AntennaOperationPhase as Phase, AntennaOperationProgress as Progress, AntennaOperationProgressObserver};
use fullmag_runtime_control::AcceptedWorkerStep;
use std::{path::Path, sync::{atomic::{AtomicBool, Ordering}, Mutex}, thread, time::{Duration, Instant}};

fn rank(phase: Phase) -> u8 {
    match phase {
        Phase::PreparingSource => 0, Phase::SolvingPotential => 1,
        Phase::ReconstructingCurrent => 2, Phase::EvaluatingField => 3,
        Phase::ValidatingResult => 4, Phase::PublishingResult => 5,
    }
}

fn valid(progress: &Progress) -> bool {
    progress.is_valid() && match progress.phase {
        Phase::PreparingSource | Phase::SolvingPotential | Phase::ReconstructingCurrent =>
            progress.completed_targets == 0,
        Phase::EvaluatingField => true,
        Phase::ValidatingResult | Phase::PublishingResult =>
            progress.completed_targets == progress.total_targets,
    }
}

pub(crate) fn follows(previous: &Progress, next: &Progress) -> bool {
    valid(next) && previous.total_targets == next.total_targets
        && previous.source_cells == next.source_cells
        && rank(next.phase) >= rank(previous.phase)
        && next.completed_targets >= previous.completed_targets
        && next.elapsed_seconds >= previous.elapsed_seconds
}

pub(super) fn validate_header_payload(header: &AcceptedLiveObservationHeader) -> Result<()> {
    if header.sequence == 0 || header.written_at_unix_ms == 0 {
        bail!("accepted live observation has an invalid sequence or publication time");
    }
    match (&header.stats, &header.operation_progress) {
        (Some(_), None) => Ok(()),
        (None, Some(progress)) if valid(progress) && header.magnetization.is_none()
            && header.realization == "fem_cpu" => Ok(()),
        _ => bail!("accepted live observation requires exactly one valid solver or antenna payload"),
    }
}

struct PublisherStop<'a> {
    stopped: &'a AtomicBool,
    thread: thread::Thread,
}
impl Drop for PublisherStop<'_> {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        self.thread.unpark();
    }
}

/// The native callback only tries to copy one snapshot. All filesystem and
/// serialization work runs on this scoped publisher, without session-store locks.
pub(super) fn with_progress<T>(
    attempt: &Path,
    step: &AcceptedWorkerStep,
    input: &fullmag_ir::ResolvedAntennaClosedLoopCurrentInputIR,
    execute: impl FnOnce(&AntennaOperationProgressObserver<'_>) -> T,
) -> T {
    let initial = Progress {
        phase: Phase::PreparingSource, completed_targets: 0,
        total_targets: input.field_sampling.positions_xyz_m.len() as u64,
        source_cells: input.conductivity_spm_per_element.len() as u64,
        elapsed_seconds: 0.0,
    };
    let latest = Mutex::new(initial);
    let stopped = AtomicBool::new(false);
    thread::scope(|scope| {
        let publisher = thread::Builder::new().name("antenna-progress".into()).spawn_scoped(scope, || {
            let started = Instant::now();
            let mut sequence = 0;
            let mut reported_failure = false;
            let mut next_write = Instant::now();
            loop {
                let now = Instant::now();
                if now < next_write && !stopped.load(Ordering::Acquire) {
                    thread::park_timeout(next_write.duration_since(now));
                    continue;
                }
                let mut progress = *latest.lock().unwrap_or_else(|error| error.into_inner());
                progress.elapsed_seconds = progress.elapsed_seconds.max(started.elapsed().as_secs_f64());
                if valid(&progress) {
                    let header = AcceptedLiveObservationHeader {
                        schema_version: ACCEPTED_LIVE_OBSERVATION_SCHEMA.into(),
                        run_id: step.claim.run_id.as_str().into(),
                        task_id: step.claim.task_id.as_str().into(),
                        step_id: step.step_id.clone(),
                        attempt_id: step.claim.attempt_id.as_str().into(),
                        ownership_epoch: step.claim.ownership_epoch.value(),
                        realization: "fem_cpu".into(),
                        sequence: sequence + 1,
                        written_at_unix_ms: std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|duration| duration.as_millis() as u64).unwrap_or(0),
                        stats: None, operation_progress: Some(progress), magnetization: None,
                    };
                    let result = serde_json::to_vec(&header).map_err(anyhow::Error::from)
                        .and_then(|bytes| super::write_live_file_atomically(
                            attempt, ACCEPTED_LIVE_OBSERVATION_FILE, &bytes));
                    match result {
                        Ok(()) => sequence += 1,
                        Err(error) if !reported_failure => {
                            reported_failure = true;
                            eprintln!("accepted antenna progress publication unavailable: {error:#}");
                        }
                        Err(_) => {}
                    }
                }
                if stopped.load(Ordering::Acquire) { break; }
                next_write = Instant::now() + Duration::from_millis(500);
            }
        });
        let publisher = match publisher {
            Ok(publisher) => publisher,
            Err(error) => {
                eprintln!("accepted antenna progress publisher unavailable: {error}");
                return execute(&|_| {});
            }
        };
        let stop = PublisherStop { stopped: &stopped, thread: publisher.thread().clone() };
        let observer = |progress: Progress| {
            if let Ok(mut current) = latest.try_lock() {
                if follows(&current, &progress) { *current = progress; }
            }
        };
        let result = execute(&observer);
        drop(stop);
        let _ = publisher.join();
        // Retain the last bounded diagnostic for the exact task attempt;
        // the durable task/output catalog alone owns the terminal outcome.
        result
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn progress(phase: Phase, completed: u64) -> Progress {
        Progress { phase, completed_targets: completed, total_targets: 20,
            source_cells: 1856, elapsed_seconds: 10.0 }
    }
    #[test]
    fn progress_rejects_invalid_counts_clock_phase_and_regressions() {
        let previous = progress(Phase::EvaluatingField, 4);
        assert!(follows(&previous, &progress(Phase::EvaluatingField, 5)));
        assert!(!follows(&previous, &progress(Phase::EvaluatingField, 3)));
        assert!(!follows(&previous, &progress(Phase::SolvingPotential, 0)));
        assert!(!valid(&progress(Phase::ValidatingResult, 19)));
        assert!(!valid(&progress(Phase::EvaluatingField, 21)));
        for elapsed in [f64::NAN, f64::INFINITY, -1.0] {
            assert!(!valid(&Progress { elapsed_seconds: elapsed, ..previous }));
        }
        assert!(!follows(&previous, &Progress { source_cells: 99, ..previous }));
        assert!(!follows(&previous, &Progress { total_targets: 99, ..previous }));
    }
    #[test]
    fn headers_allow_legacy_solver_or_operation_but_never_both() {
        let mut header = AcceptedLiveObservationHeader {
            schema_version: ACCEPTED_LIVE_OBSERVATION_SCHEMA.into(), run_id: "run-a".into(),
            task_id: "task-a".into(), step_id: "step-a".into(), attempt_id: "attempt-a".into(),
            ownership_epoch: 1, realization: "fem_cpu".into(), sequence: 1,
            written_at_unix_ms: 1, stats: Some(fullmag_runner::StepStats::default()),
            operation_progress: None, magnetization: None,
        };
        let encoded = serde_json::to_value(&header).unwrap();
        assert!(encoded.get("operation_progress").is_none());
        let legacy: AcceptedLiveObservationHeader = serde_json::from_value(encoded).unwrap();
        assert!(validate_header_payload(&legacy).is_ok());
        header.operation_progress = Some(progress(Phase::EvaluatingField, 4));
        assert!(validate_header_payload(&header).is_err());
        header.stats = None;
        assert!(validate_header_payload(&header).is_ok());
        header.realization = "fdm_cpu".into();
        assert!(validate_header_payload(&header).is_err());
        header.realization = "fem_cpu".into();
        header.operation_progress = None;
        assert!(validate_header_payload(&header).is_err());
    }

    #[test]
    fn reader_rejects_foreign_attempt_identity_and_zero_sequence() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("runs/run-a/worker-attempts/task-a/attempt-a/epoch-1");
        std::fs::create_dir_all(&path).unwrap();
        let header = AcceptedLiveObservationHeader {
            schema_version: ACCEPTED_LIVE_OBSERVATION_SCHEMA.into(), run_id: "run-a".into(),
            task_id: "task-a".into(), step_id: "step-a".into(), attempt_id: "attempt-a".into(),
            ownership_epoch: 1, realization: "fem_cpu".into(), sequence: 1,
            written_at_unix_ms: 1, stats: None,
            operation_progress: Some(progress(Phase::EvaluatingField, 4)), magnetization: None,
        };
        for field in ["run_id", "task_id", "step_id", "attempt_id", "ownership_epoch", "sequence"] {
            let mut changed = serde_json::to_value(&header).unwrap();
            changed[field] = if field == "ownership_epoch" { serde_json::json!(2) }
                else if field == "sequence" { serde_json::json!(0) }
                else { serde_json::json!("foreign") };
            std::fs::write(path.join(ACCEPTED_LIVE_OBSERVATION_FILE),
                serde_json::to_vec(&changed).unwrap()).unwrap();
            assert!(super::super::read_accepted_live_observation(root.path(),
                "run-a", "task-a", "step-a", "attempt-a", 1, None).is_err(), "{field}");
        }
        std::fs::write(path.join(ACCEPTED_LIVE_OBSERVATION_FILE),
            serde_json::to_vec(&header).unwrap()).unwrap();
        let read = super::super::read_accepted_live_observation(root.path(),
            "run-a", "task-a", "step-a", "attempt-a", 1, None).unwrap().unwrap();
        assert_eq!(read.header.operation_progress, header.operation_progress);
        assert!(read.magnetization_values.is_none());
        assert!(read.fields.is_empty());
    }

}
