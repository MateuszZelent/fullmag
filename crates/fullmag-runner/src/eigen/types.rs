use num_complex::Complex64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EigenSolverModel {
    ReferenceScalarTangent,
    ReferenceFull2x2Tangent,
    LinearizedLlgTangentPlane,
    ProductionCpuShiftInvert,
}

impl EigenSolverModel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ReferenceScalarTangent => "reference_scalar_tangent",
            Self::ReferenceFull2x2Tangent => "reference_full_2x2_tangent",
            Self::LinearizedLlgTangentPlane => "linearized_llg_tangent_plane",
            Self::ProductionCpuShiftInvert => "slepc_multi_shift_invert_production_cpu_dense",
        }
    }
}

#[derive(Debug, Clone)]
pub struct KSampleDescriptor {
    pub sample_index: usize,
    pub label: Option<String>,
    pub segment_index: Option<usize>,
    pub path_s: f64,
    pub t_in_segment: f64,
    pub k_vector: [f64; 3],
}

#[derive(Debug, Clone)]
pub struct SingleKModeResult {
    pub raw_mode_index: usize,
    pub branch_id: Option<usize>,
    pub frequency_real_hz: f64,
    pub frequency_imag_hz: f64,
    pub angular_frequency_rad_per_s: f64,
    pub eigenvalue_real: f64,
    pub eigenvalue_imag: f64,
    pub norm: f64,
    pub max_amplitude: f64,
    pub residual_norm: Option<f64>,
    pub residual_linf: Option<f64>,
    pub tangent_leakage_mean_abs: Option<f64>,
    pub tangent_leakage_max_abs: Option<f64>,
    pub dominant_polarization: String,
    pub reduced_vector: Option<Vec<Complex64>>,
    pub lifted_real: Option<Vec<[f64; 3]>>,
    pub lifted_imag: Option<Vec<[f64; 3]>>,
    pub amplitude: Option<Vec<f64>>,
    pub phase: Option<Vec<f64>>,
}

impl SingleKModeResult {
    pub fn frequency_hz(&self) -> f64 {
        self.frequency_real_hz
    }
}

#[derive(Debug, Clone)]
pub struct SingleKSolveResult {
    pub sample: KSampleDescriptor,
    pub modes: Vec<SingleKModeResult>,
    pub relaxation_steps: u64,
    pub solver_model: EigenSolverModel,
    pub solver_notes: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct TrackedBranchPoint {
    pub sample_index: usize,
    pub raw_mode_index: usize,
    pub frequency_real_hz: f64,
    pub frequency_imag_hz: f64,
    pub tracking_confidence: f64,
    pub overlap_prev: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct TrackedBranch {
    pub branch_id: usize,
    pub label: Option<String>,
    pub points: Vec<TrackedBranchPoint>,
}

#[derive(Debug, Clone)]
pub struct PathSolveResult {
    pub samples: Vec<SingleKSolveResult>,
    pub branches: Vec<TrackedBranch>,
    pub solver_model: EigenSolverModel,
    pub notes: Vec<String>,
}
