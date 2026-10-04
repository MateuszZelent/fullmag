//! Admission regressions. Compilation remains pending while the unit-test build ban is active.
use super::*;

fn snapshot(now: Instant) -> ResourceSnapshot {
    ResourceSnapshot {
        sampled_at: now,
        sampled_at_unix_ms: 1,
        allocated_cpu_cores: 8.0,
        cpu_busy_percent: 10.0,
        cpu_available_cores: 7.2,
        memory_limit_bytes: 16 << 30,
        memory_available_bytes: 14 << 30,
        allocation_sources: vec!["cgroup_v2_cpu_max".into()],
    }
}
fn adaptive() -> AdaptiveAdmission {
    AdaptiveAdmission::new(ParallelExecutionPolicyIR {
        mode: ParallelExecutionModeIR::Adaptive,
        ..Default::default()
    })
    .unwrap()
}

#[test]
fn a_successful_whole_probe_is_required_before_ramping() {
    let mut admission = adaptive();
    let now = Instant::now();
    assert!(admission.completed_probe().is_err());
    admission
        .observe(WorkerPeak {
            cpu_cores: 0.5,
            rss_bytes: 1 << 30,
        })
        .unwrap();
    let resources = snapshot(now);
    assert_eq!(
        admission
            .decide(Some(&resources), 1, 0.5, 1 << 30, 8, now)
            .desired_workers,
        1
    );
    admission.completed_probe().unwrap();
    assert_eq!(
        admission
            .decide(Some(&resources), 1, 0.5, 1 << 30, 8, now)
            .desired_workers,
        2
    );
    assert_eq!(
        admission
            .decide(Some(&resources), 2, 1.0, 2 << 30, 8, now)
            .desired_workers,
        2
    );
}

#[test]
fn stale_missing_or_invalid_samples_never_open_admission() {
    let mut admission = adaptive();
    let now = Instant::now();
    let resources = snapshot(now);
    assert_eq!(admission.decide(None, 2, 0.0, 0, 8, now).desired_workers, 0);
    let decision = admission.decide(Some(&resources), 0, 0.0, 0, 8, now + Duration::from_secs(3));
    assert_eq!(decision.reason, "telemetry_stale");
    let mut invalid = snapshot(now);
    invalid.cpu_busy_percent = f64::NAN;
    assert_eq!(
        admission
            .decide(Some(&invalid), 0, 0.0, 0, 8, now)
            .desired_workers,
        0
    );
}

#[test]
fn summed_shared_rss_cannot_create_new_memory_headroom() {
    let mut admission = adaptive();
    admission
        .observe(WorkerPeak {
            cpu_cores: 1.0,
            rss_bytes: 2 << 30,
        })
        .unwrap();
    admission.completed_probe().unwrap();
    let now = Instant::now();
    let mut resources = snapshot(now);
    resources.memory_available_bytes = 1 << 30;
    let decision = admission.decide(Some(&resources), 4, 4.0, 32 << 30, 8, now);
    assert_eq!(decision.desired_workers, 0);
    assert_eq!(decision.reason, "resource_pressure_drain_no_new_admission");
}

#[test]
fn minimum_worker_granularity_is_explicit_on_one_cpu() {
    let mut admission = adaptive();
    admission
        .observe(WorkerPeak {
            cpu_cores: 1.0,
            rss_bytes: 1 << 30,
        })
        .unwrap();
    admission.completed_probe().unwrap();
    let now = Instant::now();
    let mut resources = snapshot(now);
    resources.allocated_cpu_cores = 1.0;
    resources.cpu_available_cores = 0.9;
    let decision = admission.decide(Some(&resources), 0, 0.0, 0, 8, now);
    assert_eq!(decision.desired_workers, 1);
    assert_eq!(decision.reason, "minimum_worker_exceeds_soft_cpu_target");
}

#[test]
fn io_phase_does_not_erase_previous_peak_or_worker_cap() {
    let mut admission = adaptive();
    admission.policy.max_workers = Some(2);
    admission
        .observe(WorkerPeak {
            cpu_cores: 2.0,
            rss_bytes: 2 << 30,
        })
        .unwrap();
    admission
        .observe(WorkerPeak {
            cpu_cores: 0.0,
            rss_bytes: 1,
        })
        .unwrap();
    admission.completed_probe().unwrap();
    assert_eq!(admission.peak.cpu_cores, 2.0);
    assert_eq!(admission.peak.rss_bytes, 2 << 30);
    let now = Instant::now();
    let resources = snapshot(now);
    assert_eq!(
        admission
            .decide(Some(&resources), 2, 0.0, 0, 8, now)
            .desired_workers,
        2
    );
}

#[test]
fn wider_host_load_does_not_become_leaf_allocation_load() {
    let now = Instant::now();
    let mut admission = adaptive();
    admission
        .observe(WorkerPeak {
            cpu_cores: 1.0,
            rss_bytes: 1 << 30,
        })
        .unwrap();
    admission.completed_probe().unwrap();
    let mut resources = snapshot(now);
    // 12-core affinity at 80% load leaves 2.4 cores; the 4-core leaf uses 1.
    resources.allocated_cpu_cores = 4.0;
    resources.cpu_busy_percent = 25.0;
    resources.cpu_available_cores = 2.4;
    assert_eq!(
        admission
            .decide(Some(&resources), 1, 1.0, 1 << 30, 8, now)
            .desired_workers,
        2
    );
}

#[test]
fn external_cpu_capacity_pressure_cannot_be_erased_by_idle_leaf() {
    let now = Instant::now();
    let mut admission = adaptive();
    admission
        .observe(WorkerPeak {
            cpu_cores: 1.0,
            rss_bytes: 1 << 30,
        })
        .unwrap();
    admission.completed_probe().unwrap();
    let mut resources = snapshot(now);
    resources.allocated_cpu_cores = 4.0;
    resources.cpu_busy_percent = 0.0;
    resources.cpu_available_cores = 0.2;
    assert_eq!(
        admission
            .decide(Some(&resources), 0, 0.0, 0, 8, now)
            .desired_workers,
        0
    );
    resources.cpu_available_cores = f64::NAN;
    assert_eq!(
        admission.decide(Some(&resources), 0, 0.0, 0, 8, now).reason,
        "telemetry_invalid"
    );
}

#[test]
fn minimum_worker_exception_does_not_ignore_external_cpu_pressure() {
    let now = Instant::now();
    let mut admission = adaptive();
    admission
        .observe(WorkerPeak {
            cpu_cores: 1.0,
            rss_bytes: 1 << 30,
        })
        .unwrap();
    admission.completed_probe().unwrap();
    let mut resources = snapshot(now);
    resources.allocated_cpu_cores = 1.0;
    resources.cpu_busy_percent = 0.0;
    resources.cpu_available_cores = 0.2;
    assert_eq!(
        admission
            .decide(Some(&resources), 0, 0.0, 0, 8, now)
            .desired_workers,
        0
    );
}

#[test]
fn no_pending_samples_reports_actual_active_count_without_new_admission() {
    let now = Instant::now();
    let mut admission = adaptive();
    for active in [2, 1, 0] {
        let decision = admission.decide(None, active, 0.0, 0, 0, now);
        assert_eq!(decision.desired_workers, active);
        assert_eq!(decision.reason, "no_pending_samples");
    }
}

#[test]
fn idle_active_workers_cannot_overcommit_the_calibrated_cpu_envelope() {
    let mut admission = adaptive();
    admission
        .observe(WorkerPeak {
            cpu_cores: 1.0,
            rss_bytes: 1 << 20,
        })
        .unwrap();
    admission.completed_probe().unwrap();
    let now = Instant::now();
    let resources = snapshot(now);
    // Seven workers in an IO phase must not admit an eighth: the measured
    // CPU envelope is 1.1 cores and the complete pool budget is 7.2 cores.
    let result = admission.decide(Some(&resources), 7, 0.0, 0, 20, now);
    assert_eq!(result.desired_workers, 6);
    assert_eq!(result.reason, "resource_pressure_drain_no_new_admission");
}

#[test]
fn idle_active_workers_cannot_overcommit_the_calibrated_memory_envelope() {
    let mut admission = adaptive();
    admission
        .observe(WorkerPeak {
            cpu_cores: 0.1,
            rss_bytes: 4 << 30,
        })
        .unwrap();
    admission.completed_probe().unwrap();
    let now = Instant::now();
    let mut resources = snapshot(now);
    resources.memory_available_bytes = resources.memory_limit_bytes;
    // 80% of 16 GiB minus 1 GiB reserve permits two 5 GiB peak envelopes,
    // regardless of the workers' current low working set.
    let result = admission.decide(Some(&resources), 2, 0.0, 0, 20, now);
    assert_eq!(result.desired_workers, 2);
}
