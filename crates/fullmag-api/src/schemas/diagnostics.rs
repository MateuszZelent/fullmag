use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SolverProfileCommandConfig {
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

impl Default for SolverProfileCommandConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            sample_every: default_sample_every(),
            max_samples: default_max_samples(),
            emit_engine_log: false,
            persist_artifact: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SolverProfileThreadingResource {
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

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SolverProfilePhaseResource {
    pub id: String,
    pub label: String,
    pub wall_time_ns: u64,
    pub percent_of_total: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SolverProfileStepSampleResource {
    pub step: u64,
    pub time: f64,
    pub dt: f64,
    pub total_ns: u64,
    pub phase_sum_ns: u64,
    pub missing_ns: u64,
    pub phases: Vec<SolverProfilePhaseResource>,
    pub demag_subphase_sum_ns: u64,
    pub demag_subphases: Vec<SolverProfilePhaseResource>,
    pub rhs_evaluations: u32,
    pub rejected_attempts: u32,
    pub demag_solves: u32,
    pub poisson_iterations: u32,
    pub poisson_final_residual: f64,
    pub threading: SolverProfileThreadingResource,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
pub struct SolverProfileAggregatesResource {
    pub sample_count: usize,
    pub average_total_ns: u64,
    pub max_total_ns: u64,
    pub average_exchange_ns: u64,
    pub average_demag_ns: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SolverProfileResource {
    pub revision: u64,
    pub state: String,
    pub config: SolverProfileCommandConfig,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub threading: Option<SolverProfileThreadingResource>,
    pub latest_samples: Vec<SolverProfileStepSampleResource>,
    pub aggregates: SolverProfileAggregatesResource,
    pub artifact_refs: Vec<String>,
}

impl Default for SolverProfileResource {
    fn default() -> Self {
        Self {
            revision: 0,
            state: "disabled".to_string(),
            config: SolverProfileCommandConfig::default(),
            threading: None,
            latest_samples: Vec::new(),
            aggregates: SolverProfileAggregatesResource::default(),
            artifact_refs: Vec::new(),
        }
    }
}

fn default_sample_every() -> u64 {
    1
}

fn default_max_samples() -> usize {
    128
}
