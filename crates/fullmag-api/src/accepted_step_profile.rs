//! Bounded diagnostics for the same accepted native FEM worker attempt.
use super::super::accepted_worker_execution_receipt::WorkerExecutionReceiptIdentity;
use anyhow::{bail, Context, Result};
use fullmag_runner::{SolverProfileConfig, SolverProfileSnapshot, SolverProfileState, StepStats};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::Path;

const FILE: &str = "worker_step_profile.v1.json";
const SCHEMA: &str = "worker_step_profile.v1";
const MAX_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Outcome {
    Completed,
    Cancelled,
    Failed,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    schema_version: String,
    identity: WorkerExecutionReceiptIdentity,
    config_sha256: String,
    outcome: Outcome,
    profile: SolverProfileSnapshot,
}

/// Deduplicate callback/final readback at the accepted-step boundary. A final
/// sample uses the runner's existing zero-step finalization implementation.
pub(crate) struct Capture {
    state: SolverProfileState,
    last: Option<StepStats>,
    finalized: bool,
}
impl Capture {
    pub(crate) fn new(config: SolverProfileConfig) -> Self {
        Self {
            state: SolverProfileState::new(config),
            last: None,
            finalized: false,
        }
    }
    pub(crate) fn observe(&mut self, stats: &StepStats) {
        if self.finalized
            || !self.state.config().enabled
            || stats.step == 0
            || self
                .last
                .as_ref()
                .is_some_and(|previous| stats.step <= previous.step)
        {
            return;
        }
        self.state.record_step(stats);
        self.last = Some(stats.clone());
    }
    pub(crate) fn finish(&mut self, final_stats: Option<&StepStats>) {
        if self.finalized || !self.state.config().enabled {
            return;
        }
        if let Some(stats) = final_stats {
            self.observe(stats);
        }
        self.finalized = true;
        if let Some(stats) = final_stats.or(self.last.as_ref()) {
            self.state.force_record_step(stats);
        }
    }
    pub(crate) fn persist(
        &self,
        attempt: &Path,
        identity: &WorkerExecutionReceiptIdentity,
        outcome: Outcome,
    ) -> Result<()> {
        if !self.state.config().enabled {
            return Ok(());
        }
        let mut profile = self.state.snapshot();
        // The runner's zero-step finalization sample deliberately starts from
        // default StepStats. Retain the last observed worker threading context
        // without changing its scientific step accounting or timing formulas.
        if let Some(stats) = &self.last {
            let threading =
                fullmag_runner::SolverProfileStepSample::from_step_stats(stats).threading;
            profile.threading = Some(threading.clone());
            for sample in profile
                .latest_samples
                .iter_mut()
                .filter(|sample| sample.span_step_count == 0)
            {
                sample.threading = threading.clone();
            }
        }
        validate_snapshot(&profile)?;
        let receipt = Receipt {
            schema_version: SCHEMA.into(),
            identity: identity.clone(),
            config_sha256: super::digest(self.state.config())?,
            outcome,
            profile,
        };
        if serde_json::to_vec_pretty(&receipt)?.len() as u64 > MAX_BYTES {
            bail!("accepted FEM profile exceeds 32 MiB");
        }
        crate::accepted_study_worker::write_immutable_attempt_receipt(attempt, FILE, &receipt)
    }
}

fn validate_snapshot(profile: &SolverProfileSnapshot) -> Result<()> {
    if !profile.config.enabled
        || !profile.config.persist_artifact
        || profile.config.emit_engine_log
        || profile.config != profile.config.clone().normalized()
        || profile.config.max_samples > 4096
        || profile.latest_samples.len() > profile.config.max_samples
        || !profile.operation_samples.is_empty()
        || profile.persistence_failed
    {
        bail!("invalid bounded accepted FEM step profile shape");
    }
    // A roundtrip rejects nonfinite required float fields (serde emits null
    // for them). Explicit checks cover the scientific sample scalars too.
    let _: SolverProfileSnapshot = serde_json::from_value(serde_json::to_value(profile)?)?;
    let reference = fullmag_runner::SolverProfileStepSample::from_step_stats(&StepStats::default());
    let phase_ids: BTreeSet<_> = reference
        .phases
        .iter()
        .chain(reference.demag_subphases.iter())
        .map(|phase| phase.id.as_str())
        .collect();
    if !profile.artifact_refs.is_empty() || profile.live_publisher.is_some() {
        bail!("accepted FEM profile has foreign writer/artifact metadata");
    }
    let mut previous_step = None;
    for (index, sample) in profile.latest_samples.iter().enumerate() {
        // Preserve the producer's phase vocabulary and timing interpretation.
        // In particular, event-enqueue and device-elapsed measurements must
        // never be re-labelled as blocking CPU waits by a saved receipt.
        if sample.timing_semantics != reference.timing_semantics
            || !sample.phases.iter().map(|phase| &phase.id)
                .eq(reference.phases.iter().map(|phase| &phase.id))
            || !sample.demag_subphases.iter().map(|phase| &phase.id)
                .eq(reference.demag_subphases.iter().map(|phase| &phase.id))
        {
            bail!("incomplete accepted FEM phases or changed timing semantics");
        }
        if !sample.time.is_finite()
            || !sample.dt.is_finite()
            || !sample.poisson_final_residual.is_finite()
            || sample.time < 0.0
            || sample.dt < 0.0
            || sample.span_first_step > sample.span_last_step
            || sample.step != sample.span_last_step
            || sample.span_step_count
                > sample
                    .span_last_step
                    .saturating_sub(sample.span_first_step)
                    .saturating_add(1)
            || previous_step.is_some_and(|previous| {
                sample.span_first_step < previous
                    || sample.span_step_count > 0 && sample.span_first_step == previous
            })
            || sample.trace.is_some()
            || sample.sample_kinds.len() > 5
            || sample.span_step_count == 0 && index + 1 != profile.latest_samples.len()
        {
            bail!("invalid accepted FEM sample scalar/span/sequence");
        }
        if sample.span_step_count == 0
            && !sample
                .sample_kinds
                .iter()
                .any(|kind| serde_json::to_value(kind).is_ok_and(|value| value == "finalization"))
        {
            bail!("zero-step profile sample must be finalization");
        }
        let kinds: BTreeSet<_> = sample
            .sample_kinds
            .iter()
            .map(serde_json::to_string)
            .collect::<std::result::Result<_, _>>()?;
        if kinds.len() != sample.sample_kinds.len() {
            bail!("duplicate accepted FEM sample kind");
        }
        let mut seen = BTreeSet::new();
        for phase in sample.phases.iter().chain(sample.demag_subphases.iter()) {
            if !phase_ids.contains(phase.id.as_str())
                || !seen.insert(phase.id.as_str())
                || phase.label.is_empty()
                || phase.label.len() > 256
                || !phase.percent_of_total.is_finite()
            {
                bail!("unknown or invalid accepted FEM profile phase");
            }
        }
        let mut windows = BTreeSet::new();
        for window in &sample.phase_windows {
            if !phase_ids.contains(window.id.as_str()) || !windows.insert(window.id.as_str()) {
                bail!("unknown or duplicate accepted FEM phase window");
            }
        }
        previous_step = Some(sample.span_last_step);
    }
    Ok(())
}

pub(crate) fn load(
    attempt: &Path,
    identity: &WorkerExecutionReceiptIdentity,
    config: &SolverProfileConfig,
) -> Result<Option<SolverProfileSnapshot>> {
    let metadata = match std::fs::symlink_metadata(attempt.join(FILE)) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_BYTES {
        bail!("accepted FEM profile is nonregular or exceeds the 32 MiB read cap");
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(attempt.join(FILE))?;
    let opened = file.metadata()?;
    if !opened.is_file() || opened.len() != metadata.len() || opened.len() > MAX_BYTES {
        bail!("accepted FEM profile changed before bounded read");
    }
    use std::io::Read;
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 != opened.len() || bytes.len() as u64 > MAX_BYTES {
        bail!("accepted FEM profile changed during bounded read");
    }
    let receipt: Receipt =
        serde_json::from_slice(&bytes).context("parse bounded FEM step profile")?;
    if receipt.schema_version != SCHEMA
        || !receipt.identity.matches_same_attempt(identity)
        || receipt.config_sha256 != super::digest(config)?
        || receipt.profile.config != *config
    {
        bail!("accepted FEM step profile differs from its immutable attempt/configuration");
    }
    validate_snapshot(&receipt.profile)?;
    Ok(Some(receipt.profile))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn enabled() -> SolverProfileConfig {
        SolverProfileConfig {
            enabled: true,
            sample_every: 1,
            sample_interval_wall_ms: 0,
            max_samples: 4,
            persist_artifact: true,
            emit_engine_log: false,
        }
    }
    #[test]
    fn callback_and_terminal_readback_never_double_count_an_accepted_step() {
        let mut capture = Capture::new(enabled());
        let stats = StepStats {
            step: 1,
            time: 1e-12,
            dt: 1e-12,
            wall_time_ns: 20,
            ..StepStats::default()
        };
        capture.observe(&StepStats::default());
        capture.observe(&stats);
        capture.observe(&stats);
        capture.finish(Some(&stats));
        capture.finish(Some(&stats));
        let profile = capture.state.snapshot();
        assert_eq!(
            profile
                .latest_samples
                .iter()
                .map(|s| s.span_step_count)
                .sum::<u64>(),
            1
        );
        assert_eq!(profile.latest_samples.last().unwrap().span_step_count, 0);
        validate_snapshot(&profile).unwrap();
    }
    #[test]
    fn disabled_capture_allocates_no_samples_and_does_not_persist() {
        let mut capture = Capture::new(SolverProfileConfig::default());
        capture.observe(&StepStats {
            step: 1,
            ..StepStats::default()
        });
        capture.finish(None);
        assert!(capture.state.snapshot().latest_samples.is_empty());
    }
    #[test]
    fn malformed_nonfinite_foreign_phase_and_operation_samples_are_rejected() {
        let mut capture = Capture::new(enabled());
        capture.observe(&StepStats {
            step: 1,
            ..StepStats::default()
        });
        let profile = capture.state.snapshot();
        let mut invalid = profile.clone();
        invalid.latest_samples[0].time = f64::NAN;
        assert!(validate_snapshot(&invalid).is_err());
        let mut invalid = profile.clone();
        invalid.latest_samples[0].phases[0].id = "foreign".into();
        assert!(validate_snapshot(&invalid).is_err());
        let mut invalid = profile.clone();
        invalid.latest_samples[0].phases.pop();
        assert!(validate_snapshot(&invalid).is_err());
        let mut invalid = profile.clone();
        invalid.latest_samples[0].demag_subphases.pop();
        assert!(validate_snapshot(&invalid).is_err());
        let mut invalid = profile.clone();
        invalid.latest_samples[0].timing_semantics.clear();
        assert!(validate_snapshot(&invalid).is_err());
        let mut invalid = profile;
        invalid.latest_samples[0].span_first_step = 2;
        assert!(validate_snapshot(&invalid).is_err());
    }
    fn identity() -> WorkerExecutionReceiptIdentity {
        use fullmag_application::*;
        WorkerExecutionReceiptIdentity {
            schema_version: "fullmag.accepted_worker_execution.v1".into(),
            claim: TaskClaim {
                run_id: RunId::parse("run-profile").unwrap(),
                task_id: TaskId::parse("task-profile").unwrap(),
                attempt_id: AttemptId::parse("attempt-profile").unwrap(),
                ownership_epoch: OwnershipEpoch::INITIAL,
                lease: ResourceLease::new(
                    "cpu",
                    ResourceKind::Cpu,
                    ResourceBudget {
                        cpu_millis: 1000,
                        memory_bytes: 1024,
                        gpu_memory_bytes: 0,
                        storage_bytes: 1024,
                    },
                )
                .unwrap(),
            },
            start_message_id: "start-profile".into(),
            start_sequence: 1,
            case_id: "default".into(),
            plan_fingerprint: "a".repeat(64),
        }
    }
    #[test]
    fn finalization_persistence_preserves_the_last_real_threading_context() {
        let temporary = tempfile::tempdir().unwrap();
        let mut capture = Capture::new(enabled());
        let stats = StepStats {
            step: 1,
            requested_fem_omp_threads: 40,
            effective_fem_omp_threads: 2,
            fem_cpu_thread_cap_reason: 2,
            ..StepStats::default()
        };
        capture.observe(&stats);
        capture.finish(Some(&stats));
        let identity = identity();
        capture
            .persist(temporary.path(), &identity, Outcome::Completed)
            .unwrap();
        let profile = load(temporary.path(), &identity, &enabled())
            .unwrap()
            .unwrap();
        let threading = profile.threading.as_ref().unwrap();
        assert_eq!(threading.requested_omp_threads, 40);
        assert_eq!(threading.effective_omp_threads, 2);
        assert_eq!(threading.cap_reason, "auto-small-mesh-cap");
        let finalization = profile.latest_samples.last().unwrap();
        assert_eq!(finalization.span_step_count, 0);
        assert_eq!(finalization.threading, *threading);
        assert_eq!(
            profile
                .latest_samples
                .iter()
                .map(|sample| sample.span_step_count)
                .sum::<u64>(),
            1
        );
    }

    #[test]
    fn terminal_outcomes_roundtrip_only_for_the_exact_attempt_and_config() {
        for outcome in [Outcome::Completed, Outcome::Cancelled, Outcome::Failed] {
            let temporary = tempfile::tempdir().unwrap();
            let mut capture = Capture::new(enabled());
            capture.observe(&StepStats {
                step: 1,
                ..StepStats::default()
            });
            capture.finish(None);
            let identity = identity();
            capture
                .persist(temporary.path(), &identity, outcome)
                .unwrap();
            let receipt: Receipt =
                serde_json::from_slice(&std::fs::read(temporary.path().join(FILE)).unwrap())
                    .unwrap();
            assert_eq!(receipt.outcome, outcome);
            assert!(load(temporary.path(), &identity, &enabled())
                .unwrap()
                .is_some());
            let mut foreign = identity.clone();
            foreign.case_id = "foreign".into();
            assert!(load(temporary.path(), &foreign, &enabled()).is_err());
            foreign = identity.clone();
            foreign.start_sequence += 1;
            assert!(load(temporary.path(), &foreign, &enabled()).is_err());
            let mut config = enabled();
            config.sample_every = 2;
            assert!(load(temporary.path(), &identity, &config).is_err());
        }
    }
    #[test]
    fn malformed_oversized_and_missing_receipts_are_bounded() {
        let temporary = tempfile::tempdir().unwrap();
        let identity = identity();
        assert!(load(temporary.path(), &identity, &enabled())
            .unwrap()
            .is_none());
        std::fs::write(temporary.path().join(FILE), b"{").unwrap();
        assert!(load(temporary.path(), &identity, &enabled()).is_err());
        std::fs::File::create(temporary.path().join(FILE))
            .unwrap()
            .set_len(MAX_BYTES + 1)
            .unwrap();
        assert!(load(temporary.path(), &identity, &enabled())
            .unwrap_err()
            .to_string()
            .contains("32 MiB"));
        let disabled = Capture::new(SolverProfileConfig::default());
        disabled
            .persist(
                &temporary.path().join("does-not-exist"),
                &identity,
                Outcome::Completed,
            )
            .unwrap();
        assert!(!temporary.path().join("does-not-exist").exists());
    }
    #[test]
    fn persistence_failure_is_reported_without_claiming_a_valid_receipt() {
        let temporary = tempfile::tempdir().unwrap();
        let capture = Capture::new(enabled());
        assert!(capture
            .persist(
                &temporary.path().join("missing"),
                &identity(),
                Outcome::Failed
            )
            .is_err());
        assert!(load(temporary.path(), &identity(), &enabled())
            .unwrap()
            .is_none());
    }
}
