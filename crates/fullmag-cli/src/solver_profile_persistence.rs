use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};

use anyhow::{Context, Result};

const PROFILE_PERSIST_QUEUE_CAPACITY: usize = 16;
type PersistFailureReporter = Arc<dyn Fn(String) + Send + Sync + 'static>;
type PersistCompletionReporter = Arc<dyn Fn() + Send + Sync + 'static>;

pub(crate) struct SolverProfilePersistJob {
    pub(crate) artifact_dir: PathBuf,
    pub(crate) sample: fullmag_runner::SolverProfileStepSample,
}

impl SolverProfilePersistJob {
    #[cfg(test)]
    pub(crate) fn test_fixture(step: u64) -> Self {
        let mut profile = fullmag_runner::SolverProfileState::default();
        profile.set_config(fullmag_runner::SolverProfileConfig {
            enabled: true,
            sample_every: 1,
            ..fullmag_runner::SolverProfileConfig::default()
        });
        let sample = profile
            .force_record_step(&fullmag_runner::StepStats {
                step,
                ..fullmag_runner::StepStats::default()
            })
            .expect("enabled profile fixture sample");
        Self {
            artifact_dir: PathBuf::new(),
            sample,
        }
    }
}

#[derive(Default)]
struct PersistFailureState {
    message: Option<String>,
    reported: bool,
}

#[derive(Clone)]
pub(crate) struct SolverProfilePersistWorker {
    tx: mpsc::SyncSender<SolverProfilePersistJob>,
    failed: Arc<AtomicBool>,
    failure: Arc<Mutex<PersistFailureState>>,
    failure_reporter: Arc<Mutex<Option<PersistFailureReporter>>>,
    completion_reporter: Arc<Mutex<Option<PersistCompletionReporter>>>,
}

impl SolverProfilePersistWorker {
    pub(crate) fn spawn() -> Self {
        Self::spawn_with_sink(write_profile_sample)
    }

    pub(crate) fn spawn_with_sink<Sink>(mut sink: Sink) -> Self
    where
        Sink: FnMut(SolverProfilePersistJob) -> Result<()> + Send + 'static,
    {
        let (tx, rx) = mpsc::sync_channel(PROFILE_PERSIST_QUEUE_CAPACITY);
        let failed = Arc::new(AtomicBool::new(false));
        let failure = Arc::new(Mutex::new(PersistFailureState::default()));
        let failure_reporter = Arc::new(Mutex::new(None));
        let completion_reporter: Arc<Mutex<Option<PersistCompletionReporter>>> =
            Arc::new(Mutex::new(None));
        let worker_failed = Arc::clone(&failed);
        let worker_failure = Arc::clone(&failure);
        let worker_failure_reporter = Arc::clone(&failure_reporter);
        let worker_completion_reporter = Arc::clone(&completion_reporter);
        std::thread::Builder::new()
            .name("fullmag-solver-profile-persist".to_string())
            .spawn(move || {
                while let Ok(job) = rx.recv() {
                    match sink(job) {
                        Ok(()) => {
                            let callback = worker_completion_reporter
                                .lock()
                                .ok()
                                .and_then(|slot| slot.clone());
                            if let Some(callback) = callback {
                                callback();
                            }
                        }
                        Err(error) => {
                            let message = format!("solver profile persistence failed: {error:#}");
                            if mark_failed(&worker_failed, &worker_failure, message.clone()) {
                                report_failure(&worker_failure, &worker_failure_reporter, message);
                            }
                            break;
                        }
                    }
                }
            })
            .expect("solver profile persistence worker should spawn");
        Self {
            tx,
            failed,
            failure,
            failure_reporter,
            completion_reporter,
        }
    }

    pub(crate) fn bind_failure_reporter<Reporter>(&self, reporter: Reporter)
    where
        Reporter: Fn(String) + Send + Sync + 'static,
    {
        if let Ok(mut slot) = self.failure_reporter.lock() {
            *slot = Some(Arc::new(reporter));
        }
    }

    pub(crate) fn bind_completion_reporter<Reporter>(&self, reporter: Reporter)
    where
        Reporter: Fn() + Send + Sync + 'static,
    {
        if let Ok(mut slot) = self.completion_reporter.lock() {
            *slot = Some(Arc::new(reporter));
        }
    }

    pub(crate) fn try_enqueue(
        &self,
        job: SolverProfilePersistJob,
    ) -> std::result::Result<(), String> {
        if self.persistence_failed() {
            return Err("solver profile persistence is disabled for this run".to_string());
        }
        match self.tx.try_send(job) {
            Ok(()) => Ok(()),
            Err(mpsc::TrySendError::Full(_)) => {
                let message = format!(
                    "solver profile persistence queue is full (capacity={PROFILE_PERSIST_QUEUE_CAPACITY}); persistence disabled for this run"
                );
                mark_failed(&self.failed, &self.failure, message.clone());
                Err(message)
            }
            Err(mpsc::TrySendError::Disconnected(_)) => {
                let message =
                    "solver profile persistence worker disconnected; persistence disabled for this run"
                        .to_string();
                mark_failed(&self.failed, &self.failure, message.clone());
                Err(message)
            }
        }
    }

    pub(crate) fn persistence_failed(&self) -> bool {
        self.failed.load(Ordering::Acquire)
    }

    pub(crate) fn take_failure_message(&self) -> Option<String> {
        let mut state = self.failure.lock().ok()?;
        if state.reported {
            return None;
        }
        let message = state.message.clone()?;
        state.reported = true;
        Some(message)
    }
}

fn mark_failed(failed: &AtomicBool, failure: &Mutex<PersistFailureState>, message: String) -> bool {
    if failed.swap(true, Ordering::AcqRel) {
        return false;
    }
    if let Ok(mut state) = failure.lock() {
        state.message = Some(message);
    }
    true
}

fn report_failure(
    failure: &Mutex<PersistFailureState>,
    reporter: &Mutex<Option<PersistFailureReporter>>,
    message: String,
) {
    let callback = reporter.lock().ok().and_then(|slot| slot.clone());
    let Some(callback) = callback else {
        return;
    };
    if let Ok(mut state) = failure.lock() {
        if state.reported {
            return;
        }
        state.reported = true;
    }
    callback(message);
}

fn write_profile_sample(job: SolverProfilePersistJob) -> Result<()> {
    let diagnostics_dir = job.artifact_dir.join("diagnostics");
    std::fs::create_dir_all(&diagnostics_dir).with_context(|| {
        format!(
            "failed to create solver profile diagnostics directory {}",
            diagnostics_dir.display()
        )
    })?;
    let file = diagnostics_dir.join("solver_profile.jsonl");
    let mut writer = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file)
        .with_context(|| format!("failed to open {}", file.display()))?;
    serde_json::to_writer(&mut writer, &job.sample).with_context(|| {
        format!(
            "failed to serialize solver profile sample to {}",
            file.display()
        )
    })?;
    writer
        .write_all(b"\n")
        .with_context(|| format!("failed to append {}", file.display()))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Condvar, Mutex};
    use std::time::{Duration, Instant};

    use super::{SolverProfilePersistJob, SolverProfilePersistWorker};

    #[test]
    fn bounded_profile_queue_fails_visibly_without_blocking_producer() {
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let sink_gate = Arc::clone(&gate);
        let worker = SolverProfilePersistWorker::spawn_with_sink(move |_| {
            let (lock, ready) = &*sink_gate;
            let mut released = lock.lock().unwrap();
            while !*released {
                released = ready.wait(released).unwrap();
            }
            Ok(())
        });

        let start = Instant::now();
        let mut saw_failure = false;
        for step in 0..64 {
            let result = worker.try_enqueue(SolverProfilePersistJob::test_fixture(step));
            saw_failure |= result.is_err();
            if saw_failure {
                break;
            }
        }
        assert!(start.elapsed() < Duration::from_millis(10));
        assert!(saw_failure, "bounded queue must report Full explicitly");
        assert!(worker.persistence_failed());
        assert!(worker.take_failure_message().is_some());
        assert!(worker.take_failure_message().is_none(), "one error per run");

        let (lock, ready) = &*gate;
        *lock.lock().unwrap() = true;
        ready.notify_all();
    }

    #[test]
    fn completion_reporter_runs_only_after_the_sink_finishes() {
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let sink_gate = Arc::clone(&gate);
        let worker = SolverProfilePersistWorker::spawn_with_sink(move |_| {
            let (lock, ready) = &*sink_gate;
            let mut released = lock.lock().unwrap();
            while !*released {
                released = ready.wait(released).unwrap();
            }
            Ok(())
        });
        let completed = Arc::new(AtomicU64::new(0));
        let reporter_completed = Arc::clone(&completed);
        worker.bind_completion_reporter(move || {
            reporter_completed.fetch_add(1, Ordering::AcqRel);
        });

        worker
            .try_enqueue(SolverProfilePersistJob::test_fixture(1))
            .unwrap();
        assert_eq!(completed.load(Ordering::Acquire), 0);

        let (lock, ready) = &*gate;
        *lock.lock().unwrap() = true;
        ready.notify_all();
        let deadline = Instant::now() + Duration::from_secs(2);
        while completed.load(Ordering::Acquire) == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(completed.load(Ordering::Acquire), 1);
    }
}
