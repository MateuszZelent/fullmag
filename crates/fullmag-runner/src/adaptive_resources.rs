//! Conservative resource admission for isolated eigensolve processes.
//! Missing or stale telemetry closes admission; CPU targets are not OS quotas.
use fullmag_ir::{ParallelExecutionModeIR, ParallelExecutionPolicyIR};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize)]
pub struct ResourceSnapshot {
    #[serde(skip)]
    pub(crate) sampled_at: Instant,
    pub sampled_at_unix_ms: u64,
    pub allocated_cpu_cores: f64,
    pub cpu_busy_percent: f64,
    /// Free capacity after affinity and cgroup constraints, in CPU cores.
    pub cpu_available_cores: f64,
    pub memory_limit_bytes: u64,
    pub memory_available_bytes: u64,
    pub allocation_sources: Vec<String>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct WorkerPeak {
    /// CPU demand envelope for admission. A short or sparsely observed child
    /// uses its resolved thread budget; this is not a measured peak.
    pub cpu_cores: f64,
    /// Measured process resident-memory high-water mark.
    pub rss_bytes: u64,
}

/// One worker measurement; the first sample has no CPU counter interval.
pub struct WorkerSample {
    pub peak: WorkerPeak,
    pub cpu_interval: Option<Duration>,
}

/// Worker-local sampling failure. Only process-owned `/proc/<pid>` exit races
/// may use a later validated terminal resource response as reconciliation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerSampleError {
    ProcessExitRace(WorkerProcessExitRace),
    Other(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerProcessExitRace {
    HighWaterMarkUnavailable,
    ProcFileNotFound(String),
}

impl std::fmt::Display for WorkerProcessExitRace {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::HighWaterMarkUnavailable => {
                formatter.write_str("worker memory high water mark unavailable")
            }
            Self::ProcFileNotFound(path) => {
                write!(formatter, "worker process file disappeared: {path}")
            }
        }
    }
}

impl From<String> for WorkerSampleError {
    fn from(error: String) -> Self {
        Self::Other(error)
    }
}

impl From<&'static str> for WorkerSampleError {
    fn from(error: &'static str) -> Self {
        Self::Other(error.into())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdmissionDecision {
    pub desired_workers: usize,
    pub reason: String,
    pub cpu_target_kind: String,
}

/// Retains peak demand across phases: an idle/IO phase cannot erase a mesh peak.
/// The first worker must finish before admitting peers, to calibrate all phases.
pub struct AdaptiveAdmission {
    pub policy: ParallelExecutionPolicyIR,
    peak: WorkerPeak,
    calibrated: bool,
    last_increase: Option<Instant>,
    cooldown: Duration,
}

impl AdaptiveAdmission {
    pub fn new(policy: ParallelExecutionPolicyIR) -> Result<Self, String> {
        policy.validate()?;
        Ok(Self {
            policy,
            peak: WorkerPeak::default(),
            calibrated: false,
            last_increase: None,
            cooldown: Duration::from_secs(5),
        })
    }

    pub fn observe(&mut self, measured: WorkerPeak) -> Result<(), String> {
        if !measured.cpu_cores.is_finite() || measured.cpu_cores < 0.0 {
            return Err("invalid worker CPU measurement".into());
        }
        self.peak.cpu_cores = self.peak.cpu_cores.max(measured.cpu_cores);
        self.peak.rss_bytes = self.peak.rss_bytes.max(measured.rss_bytes);
        Ok(())
    }

    pub fn completed_probe(&mut self) -> Result<(), String> {
        if self.peak.rss_bytes == 0 || self.peak.cpu_cores <= 0.0 {
            return Err(
                "probe completed without measured CPU and RSS; admission remains closed".into(),
            );
        }
        self.calibrated = true;
        Ok(())
    }

    pub fn decide(
        &mut self,
        snapshot: Option<&ResourceSnapshot>,
        active: usize,
        own_cpu_cores: f64,
        _own_rss_bytes: u64,
        pending: usize,
        now: Instant,
    ) -> AdmissionDecision {
        let decision = |desired_workers, reason: &str| AdmissionDecision {
            desired_workers,
            reason: reason.into(),
            cpu_target_kind: "soft_admission_target".into(),
        };
        if pending == 0 {
            return decision(active, "no_pending_samples");
        }
        let Some(resources) = snapshot else {
            return decision(0, "telemetry_unavailable");
        };
        if !(resources.allocated_cpu_cores.is_finite()
            && resources.allocated_cpu_cores > 0.0
            && resources.cpu_busy_percent.is_finite()
            && (0.0..=100.0).contains(&resources.cpu_busy_percent)
            && resources.cpu_available_cores.is_finite()
            && resources.cpu_available_cores >= 0.0
            && resources.cpu_available_cores <= resources.allocated_cpu_cores
            && resources.memory_limit_bytes > 0
            && resources.memory_available_bytes <= resources.memory_limit_bytes
            && own_cpu_cores.is_finite()
            && own_cpu_cores >= 0.0)
        {
            return decision(0, "telemetry_invalid");
        }
        if now.saturating_duration_since(resources.sampled_at) > Duration::from_secs(2) {
            return decision(0, "telemetry_stale");
        }
        let cpu_budget = resources.allocated_cpu_cores * self.policy.max_cpu_percent / 100.0;
        let total_busy = resources.allocated_cpu_cores * resources.cpu_busy_percent / 100.0;
        // Use currently measured headroom for NEW workers. Reusing own CPU from a
        // different sampling interval would falsely erase competing demand.
        let cpu_per_worker = if self.calibrated {
            // Use the measured peak, including helper threads, with a CPU admission margin.
            self.peak.cpu_cores * 1.10
        } else {
            self.policy.threads_per_worker as f64
        };
        let target_headroom_cpu = (cpu_budget - total_busy).max(0.0);
        // Percentages from different allocations cannot be compared. The
        // sampler intersects their free capacities in cores before admission.
        let headroom_cpu = target_headroom_cpu.min(resources.cpu_available_cores);
        let mut cpu_capacity = if total_busy >= cpu_budget || resources.cpu_available_cores == 0.0 {
            0
        } else {
            active.saturating_add((headroom_cpu / cpu_per_worker).floor() as usize)
        };
        // A single indivisible worker may exceed this soft target on small allocations.
        let minimum_worker_exceeds_target = active == 0
            && cpu_capacity == 0
            && headroom_cpu > 0.0
            && cpu_per_worker > cpu_budget
            && resources.cpu_available_cores >= target_headroom_cpu;
        if minimum_worker_exceeds_target {
            cpu_capacity = 1;
        }
        // Current headroom alone is insufficient when active workers are in
        // an IO phase. Reserve the calibrated envelope for the COMPLETE pool
        // as well, so their simultaneous return to compute cannot admit an
        // unbounded team. Competing load still constrains new admission above.
        if self.calibrated {
            let pool_cpu_capacity = (cpu_budget / cpu_per_worker).floor() as usize;
            cpu_capacity =
                cpu_capacity.min(pool_cpu_capacity.max(usize::from(minimum_worker_exceeds_target)));
        }
        let allowed_memory =
            (resources.memory_limit_bytes as f64 * self.policy.max_memory_percent / 100.0) as u64;
        // RSS can double-count shared pages across workers. The allocator's actual
        // available memory is authoritative; never subtract summed RSS from it.
        let usable = resources
            .memory_available_bytes
            .saturating_sub(resources.memory_limit_bytes.saturating_sub(allowed_memory))
            .saturating_sub(self.policy.memory_reserve_bytes);
        // A 25% peak margin protects against neighboring k points needing larger workspaces.
        let worker_memory = self
            .peak
            .rss_bytes
            .saturating_add(self.peak.rss_bytes / 4)
            .max(1);
        let current_memory_capacity = if usable == 0 {
            0
        } else {
            active.saturating_add(usize::try_from(usable / worker_memory).unwrap_or(usize::MAX))
        };
        // Available memory includes currently idle workers' released pages.
        // Keep capacity for their calibrated peak without treating summed RSS
        // as reclaimable memory or mixing different sampling intervals.
        let memory_capacity = if self.calibrated {
            let pool_memory_budget =
                allowed_memory.saturating_sub(self.policy.memory_reserve_bytes);
            current_memory_capacity
                .min(usize::try_from(pool_memory_budget / worker_memory).unwrap_or(usize::MAX))
        } else {
            current_memory_capacity
        };
        let hard_worker_bound = self
            .policy
            .max_workers
            .map(|value| value as usize)
            .unwrap_or(usize::MAX);
        let mut target = cpu_capacity
            .min(memory_capacity)
            .min(hard_worker_bound)
            .min(active.saturating_add(pending));
        if !self.calibrated || self.policy.mode == ParallelExecutionModeIR::Serial {
            target = target.min(1);
        }
        if !self.calibrated && usable == 0 {
            return decision(0, "insufficient_memory_for_probe");
        }
        if target > active {
            if self
                .last_increase
                .is_some_and(|last| now.saturating_duration_since(last) < self.cooldown)
            {
                return decision(active, "ramp_cooldown");
            }
            target = target.min(active + 1);
            self.last_increase = Some(now);
        }
        decision(
            target,
            if !self.calibrated {
                if target == 0 {
                    if memory_capacity == 0 {
                        "waiting_memory_headroom_for_probe"
                    } else {
                        "waiting_cpu_headroom_for_probe"
                    }
                } else {
                    "calibrating_first_sample"
                }
            } else if target < active {
                "resource_pressure_drain_no_new_admission"
            } else {
                if target == 0 {
                    if memory_capacity == 0 {
                        "insufficient_memory_for_worker"
                    } else {
                        "cpu_target_exhausted"
                    }
                } else if minimum_worker_exceeds_target {
                    "minimum_worker_exceeds_soft_cpu_target"
                } else {
                    "measured_cpu_and_memory_budget"
                }
            },
        )
    }
}

#[cfg(target_os = "linux")]
#[path = "adaptive_resources_linux.rs"]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::ResourceSampler;

#[cfg(not(target_os = "linux"))]
pub struct ResourceSampler;
#[cfg(not(target_os = "linux"))]
impl ResourceSampler {
    pub fn new() -> Result<Self, String> {
        Err("adaptive process telemetry requires Linux managed runtime; unsupported host is not assumed idle".into())
    }
    pub fn sample(&mut self) -> Result<ResourceSnapshot, String> {
        Err("telemetry_unavailable".into())
    }
    pub fn forget_worker(&mut self, _pid: u32) {}
    pub fn worker_peak(&mut self, _pid: u32) -> Result<WorkerSample, WorkerSampleError> {
        Err(WorkerSampleError::Other("telemetry_unavailable".into()))
    }
}

#[cfg(test)]
#[path = "adaptive_resources_tests.rs"]
mod tests;
