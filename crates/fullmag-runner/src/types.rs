//! Public and internal types for the runner.

use serde::{Deserialize, Serialize};
use std::fmt;

// ----- public types -----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunResult {
    pub status: RunStatus,
    pub steps: Vec<StepStats>,
    pub final_magnetization: Vec<[f64; 3]>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepStats {
    pub step: u64,
    pub time: f64,
    pub dt: f64,
    pub e_ex: f64,
    pub e_demag: f64,
    pub e_ext: f64,
    pub e_total: f64,
    pub max_dm_dt: f64,
    pub max_h_eff: f64,
    pub max_h_demag: f64,
    pub wall_time_ns: u64,
}

/// Lightweight update emitted by the runner for live WebSocket streaming.
/// Contains step stats plus optional field snapshot for 3D preview.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepUpdate {
    pub stats: StepStats,
    /// Grid dimensions [nx, ny, nz] for client-side reconstruction.
    pub grid: [u32; 3],
    /// Optional FEM mesh payload for mesh-native preview in the control room.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fem_mesh: Option<FemMeshPayload>,
    /// Magnetization snapshot as flat [mx,my,mz, mx,my,mz, ...].
    /// Sent periodically (not every step) to limit bandwidth.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub magnetization: Option<Vec<f64>>,
    /// true when simulation has completed.
    #[serde(default)]
    pub finished: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FemMeshPayload {
    pub nodes: Vec<[f64; 3]>,
    pub elements: Vec<[u32; 4]>,
    pub boundary_faces: Vec<[u32; 3]>,
}

#[derive(Debug)]
pub struct RunError {
    pub message: String,
}

impl fmt::Display for RunError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "RunError: {}", self.message)
    }
}

impl std::error::Error for RunError {}

impl From<fullmag_plan::PlanError> for RunError {
    fn from(e: fullmag_plan::PlanError) -> Self {
        RunError {
            message: format!("Planning failed:\n{}", e),
        }
    }
}

// ----- execution provenance -----

/// Records which engine and device produced a run.
/// Included in artifact metadata for reproducibility.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionProvenance {
    /// Engine that executed the run: "cpu_reference" or "cuda_fdm".
    pub execution_engine: String,
    /// Numeric precision used: "double" or "single".
    pub precision: String,
    /// Demag operator kind: e.g. "tensor_fft_newell".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub demag_operator_kind: Option<String>,
    /// FFT backend used: "rustfft" (CPU) or "cuFFT" (CUDA).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fft_backend: Option<String>,
    /// GPU device name, if applicable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
    /// GPU compute capability, if applicable (e.g. "8.6").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compute_capability: Option<String>,
    /// CUDA driver version, if applicable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cuda_driver_version: Option<i32>,
    /// CUDA runtime version, if applicable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cuda_runtime_version: Option<i32>,
}

// ----- internal execution types -----

#[derive(Debug, Clone)]
pub(crate) struct ExecutedRun {
    pub result: RunResult,
    pub initial_magnetization: Vec<[f64; 3]>,
    pub field_snapshots: Vec<FieldSnapshot>,
    pub provenance: ExecutionProvenance,
}

#[derive(Debug, Clone)]
pub(crate) struct FieldSnapshot {
    pub name: String,
    pub step: u64,
    pub time: f64,
    pub solver_dt: f64,
    pub values: Vec<[f64; 3]>,
}

#[derive(Debug, Clone)]
pub(crate) struct StateObservables {
    pub magnetization: Vec<[f64; 3]>,
    pub exchange_field: Vec<[f64; 3]>,
    pub demag_field: Vec<[f64; 3]>,
    pub external_field: Vec<[f64; 3]>,
    pub effective_field: Vec<[f64; 3]>,
    pub exchange_energy: f64,
    pub demag_energy: f64,
    pub external_energy: f64,
    pub total_energy: f64,
    pub max_dm_dt: f64,
    pub max_h_eff: f64,
    pub max_h_demag: f64,
}
