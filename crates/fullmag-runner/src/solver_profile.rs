use std::collections::VecDeque;

use serde::{Deserialize, Serialize};

use crate::types::StepStats;

const DEFAULT_SAMPLE_EVERY: u64 = 1;
const DEFAULT_MAX_SAMPLES: usize = 128;
const MAX_PROFILE_SAMPLES: usize = 4096;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SolverProfileConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_sample_every")]
    pub sample_every: u64,
    #[serde(default = "default_max_samples")]
    pub max_samples: usize,
    #[serde(default)]
    pub emit_engine_log: bool,
    #[serde(default)]
    pub persist_artifact: bool,
}

impl Default for SolverProfileConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            sample_every: DEFAULT_SAMPLE_EVERY,
            max_samples: DEFAULT_MAX_SAMPLES,
            emit_engine_log: false,
            persist_artifact: false,
        }
    }
}

impl SolverProfileConfig {
    pub fn normalized(mut self) -> Self {
        if self.sample_every == 0 {
            self.sample_every = DEFAULT_SAMPLE_EVERY;
        }
        if self.max_samples == 0 {
            self.max_samples = DEFAULT_MAX_SAMPLES;
        }
        self.max_samples = self.max_samples.min(MAX_PROFILE_SAMPLES);
        self
    }
}

fn default_sample_every() -> u64 {
    DEFAULT_SAMPLE_EVERY
}

fn default_max_samples() -> usize {
    DEFAULT_MAX_SAMPLES
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SolverProfileThreading {
    pub requested_omp_threads: i32,
    pub effective_omp_threads: i32,
    pub thread_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mfem_device: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub openmp_compiled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub openmp_available: Option<bool>,
}

impl SolverProfileThreading {
    fn from_stats(stats: &StepStats) -> Self {
        let thread_mode = if stats.requested_fem_omp_threads <= 0 {
            "unknown"
        } else if stats.requested_fem_omp_threads == stats.effective_fem_omp_threads {
            "requested"
        } else {
            "resolved"
        };
        Self {
            requested_omp_threads: stats.requested_fem_omp_threads,
            effective_omp_threads: stats.effective_fem_omp_threads,
            thread_mode: thread_mode.to_string(),
            mfem_device: None,
            openmp_compiled: None,
            openmp_available: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SolverProfilePhaseSample {
    pub id: String,
    pub label: String,
    pub wall_time_ns: u64,
    pub percent_of_total: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SolverProfileStepSample {
    pub step: u64,
    pub time: f64,
    pub dt: f64,
    pub total_ns: u64,
    pub phase_sum_ns: u64,
    pub missing_ns: u64,
    pub phases: Vec<SolverProfilePhaseSample>,
    pub demag_subphase_sum_ns: u64,
    pub demag_subphases: Vec<SolverProfilePhaseSample>,
    pub rhs_evaluations: u32,
    pub rejected_attempts: u32,
    pub demag_solves: u32,
    pub poisson_iterations: u32,
    pub poisson_final_residual: f64,
    pub threading: SolverProfileThreading,
}

impl SolverProfileStepSample {
    pub fn from_step_stats(stats: &StepStats) -> Self {
        let total_ns = stats.wall_time_ns;
        let demag_subphase_sum_ns = stats
            .demag_assemble_wall_time_ns
            .saturating_add(stats.demag_solver_setup_wall_time_ns)
            .saturating_add(stats.demag_solver_apply_wall_time_ns)
            .saturating_add(stats.demag_recover_wall_time_ns)
            .saturating_add(stats.demag_energy_wall_time_ns);
        let demag_total_ns = stats.demag_wall_time_ns.max(demag_subphase_sum_ns);
        let phase_sum_ns = stats
            .exchange_wall_time_ns
            .saturating_add(demag_total_ns)
            .saturating_add(stats.extra_energy_wall_time_ns)
            .saturating_add(stats.snapshot_wall_time_ns)
            .saturating_add(stats.preview_wall_time_ns)
            .saturating_add(stats.cached_preview_wall_time_ns);

        Self {
            step: stats.step,
            time: stats.time,
            dt: stats.dt,
            total_ns,
            phase_sum_ns,
            missing_ns: total_ns.saturating_sub(phase_sum_ns),
            phases: vec![
                phase("rhs_total", "RHS total", stats.rhs_wall_time_ns, total_ns),
                phase(
                    "exchange",
                    "Exchange",
                    stats.exchange_wall_time_ns,
                    total_ns,
                ),
                phase("demag_total", "Demag total", demag_total_ns, total_ns),
                phase(
                    "local_terms",
                    "Local terms",
                    stats.extra_energy_wall_time_ns,
                    total_ns,
                ),
                phase(
                    "snapshot",
                    "Snapshot",
                    stats.snapshot_wall_time_ns,
                    total_ns,
                ),
                phase("preview", "Preview", stats.preview_wall_time_ns, total_ns),
                phase(
                    "cached_preview",
                    "Cached preview",
                    stats.cached_preview_wall_time_ns,
                    total_ns,
                ),
                phase(
                    "unattributed",
                    "Unattributed",
                    total_ns.saturating_sub(phase_sum_ns),
                    total_ns,
                ),
            ],
            demag_subphase_sum_ns,
            demag_subphases: vec![
                phase(
                    "demag_assemble",
                    "Demag assemble",
                    stats.demag_assemble_wall_time_ns,
                    total_ns,
                ),
                phase(
                    "demag_solver_setup",
                    "Demag solver setup",
                    stats.demag_solver_setup_wall_time_ns,
                    total_ns,
                ),
                phase(
                    "demag_solver_apply",
                    "Demag solver apply",
                    stats.demag_solver_apply_wall_time_ns,
                    total_ns,
                ),
                phase(
                    "demag_recover",
                    "Demag recover",
                    stats.demag_recover_wall_time_ns,
                    total_ns,
                ),
                phase(
                    "demag_energy",
                    "Demag energy",
                    stats.demag_energy_wall_time_ns,
                    total_ns,
                ),
            ],
            rhs_evaluations: stats.rhs_evals,
            rejected_attempts: stats.rejected_attempts,
            demag_solves: stats.demag_solves,
            poisson_iterations: stats.poisson_iterations,
            poisson_final_residual: stats.poisson_final_residual,
            threading: SolverProfileThreading::from_stats(stats),
        }
    }

    pub fn compact_log_line(&self) -> String {
        format!(
            "solver-profile step={} total={} exchange={} demag={} demag.solve={} rhs={} sync={} omp={}/{}",
            self.step,
            format_duration_ns(self.total_ns),
            format_duration_ns(phase_time(&self.phases, "exchange")),
            format_duration_ns(phase_time(&self.phases, "demag_total")),
            format_duration_ns(phase_time(&self.demag_subphases, "demag_solver_apply")),
            format_duration_ns(phase_time(&self.phases, "rhs_total")),
            format_duration_ns(self.missing_ns),
            self.threading.requested_omp_threads,
            self.threading.effective_omp_threads,
        )
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct SolverProfileAggregates {
    pub sample_count: usize,
    pub average_total_ns: u64,
    pub max_total_ns: u64,
    pub average_exchange_ns: u64,
    pub average_demag_ns: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SolverProfileSnapshot {
    pub revision: u64,
    pub state: String,
    pub config: SolverProfileConfig,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub threading: Option<SolverProfileThreading>,
    pub latest_samples: Vec<SolverProfileStepSample>,
    pub aggregates: SolverProfileAggregates,
    pub artifact_refs: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct SolverProfileState {
    config: SolverProfileConfig,
    revision: u64,
    samples: VecDeque<SolverProfileStepSample>,
    artifact_refs: Vec<String>,
}

impl Default for SolverProfileState {
    fn default() -> Self {
        Self::new(SolverProfileConfig::default())
    }
}

impl SolverProfileState {
    pub fn new(config: SolverProfileConfig) -> Self {
        Self {
            config: config.normalized(),
            revision: 0,
            samples: VecDeque::new(),
            artifact_refs: Vec::new(),
        }
    }

    pub fn config(&self) -> &SolverProfileConfig {
        &self.config
    }

    pub fn set_config(&mut self, config: SolverProfileConfig) {
        let config = config.normalized();
        if !config.enabled {
            self.samples.clear();
        }
        self.config = config;
        self.trim_samples();
        self.revision = self.revision.wrapping_add(1);
    }

    pub fn record_step(&mut self, stats: &StepStats) -> Option<SolverProfileStepSample> {
        if !self.config.enabled {
            return None;
        }
        if self.config.sample_every > 1 && stats.step % self.config.sample_every != 0 {
            return None;
        }

        let sample = SolverProfileStepSample::from_step_stats(stats);
        self.samples.push_back(sample.clone());
        self.trim_samples();
        self.revision = self.revision.wrapping_add(1);
        Some(sample)
    }

    pub fn add_artifact_ref(&mut self, artifact_ref: impl Into<String>) {
        let artifact_ref = artifact_ref.into();
        if !self
            .artifact_refs
            .iter()
            .any(|existing| existing == &artifact_ref)
        {
            self.artifact_refs.push(artifact_ref);
            self.revision = self.revision.wrapping_add(1);
        }
    }

    pub fn snapshot(&self) -> SolverProfileSnapshot {
        let latest_samples: Vec<_> = self.samples.iter().cloned().collect();
        SolverProfileSnapshot {
            revision: self.revision,
            state: if self.config.enabled {
                "active"
            } else {
                "disabled"
            }
            .to_string(),
            config: self.config.clone(),
            threading: latest_samples.last().map(|sample| sample.threading.clone()),
            aggregates: aggregate_samples(&latest_samples),
            latest_samples,
            artifact_refs: self.artifact_refs.clone(),
        }
    }

    fn trim_samples(&mut self) {
        while self.samples.len() > self.config.max_samples {
            self.samples.pop_front();
        }
    }
}

fn aggregate_samples(samples: &[SolverProfileStepSample]) -> SolverProfileAggregates {
    if samples.is_empty() {
        return SolverProfileAggregates::default();
    }
    let sample_count = samples.len();
    let total_sum: u128 = samples.iter().map(|sample| sample.total_ns as u128).sum();
    let exchange_sum: u128 = samples
        .iter()
        .map(|sample| phase_time(&sample.phases, "exchange") as u128)
        .sum();
    let demag_sum: u128 = samples
        .iter()
        .map(|sample| phase_time(&sample.phases, "demag_total") as u128)
        .sum();
    SolverProfileAggregates {
        sample_count,
        average_total_ns: (total_sum / sample_count as u128) as u64,
        max_total_ns: samples
            .iter()
            .map(|sample| sample.total_ns)
            .max()
            .unwrap_or(0),
        average_exchange_ns: (exchange_sum / sample_count as u128) as u64,
        average_demag_ns: (demag_sum / sample_count as u128) as u64,
    }
}

fn phase(id: &str, label: &str, wall_time_ns: u64, total_ns: u64) -> SolverProfilePhaseSample {
    SolverProfilePhaseSample {
        id: id.to_string(),
        label: label.to_string(),
        wall_time_ns,
        percent_of_total: if total_ns > 0 {
            (wall_time_ns as f64 / total_ns as f64) * 100.0
        } else {
            0.0
        },
    }
}

fn phase_time(phases: &[SolverProfilePhaseSample], id: &str) -> u64 {
    phases
        .iter()
        .find(|phase| phase.id == id)
        .map(|phase| phase.wall_time_ns)
        .unwrap_or(0)
}

fn format_duration_ns(ns: u64) -> String {
    if ns >= 1_000_000_000 {
        format!("{:.3}s", ns as f64 / 1_000_000_000.0)
    } else if ns >= 1_000_000 {
        format!("{:.3}ms", ns as f64 / 1_000_000.0)
    } else if ns >= 1_000 {
        format!("{:.3}us", ns as f64 / 1_000.0)
    } else {
        format!("{ns}ns")
    }
}
