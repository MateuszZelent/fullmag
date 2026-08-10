use fullmag_ir::{FemEigenDispersionValidationIR, FemEigenK0KittelValidationIR};
use num_complex::Complex64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EigenSolverModel {
    ReferenceScalarTangent,
    ReferenceFull2x2Tangent,
    ReferenceThinFilmDeBvKalinikosN0,
    ReferenceK0KittelSyntheticDemagFactor,
    LinearizedLlgTangentPlane,
    ProductionCpuShiftInvert,
    ProductionGpuDenseK0Macrospin,
    ProductionGpuModalDeviceKrylov,
}

impl EigenSolverModel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ReferenceScalarTangent => "reference_scalar_tangent",
            Self::ReferenceFull2x2Tangent => "reference_full_2x2_tangent",
            Self::ReferenceThinFilmDeBvKalinikosN0 => "reference_thin_film_de_bv_kalinikos_n0",
            Self::ReferenceK0KittelSyntheticDemagFactor => {
                "reference_k0_kittel_synthetic_demag_factor"
            }
            Self::LinearizedLlgTangentPlane => "linearized_llg_tangent_plane",
            Self::ProductionCpuShiftInvert => "slepc_multi_shift_invert_production_cpu_dense",
            Self::ProductionGpuDenseK0Macrospin => "gpu_dense_k0_macrospin_modal_eigen",
            Self::ProductionGpuModalDeviceKrylov => "gpu_modal_device_krylov",
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
    pub mass_norm: Option<f64>,
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
    pub node_mass_weights: Option<Vec<f64>>,
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
    pub solver_diagnostics: Option<serde_json::Value>,
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
pub struct DispersionAnalyticReferenceContext {
    pub external_field: [f64; 3],
    pub exchange_stiffness: f64,
    pub saturation_magnetisation: f64,
    pub gyromagnetic_ratio: f64,
}

#[derive(Debug, Clone)]
pub struct K0KittelPeriodicAirboxDemagMetrics {
    pub mesh_resolution_m: f64,
    pub airbox_size_m: f64,
    pub phi_dof_count: u64,
    pub augmented_phi_dof_count: u64,
    pub poisson_constraint_relative_residual: f64,
    pub magnetic_pair_count: u64,
    pub airbox_pair_count: u64,
    pub effective_magnetisation_a_per_m: f64,
    pub relative_kittel_frequency_error: f64,
}

#[derive(Debug, Clone)]
pub struct PathSolveResult {
    pub samples: Vec<SingleKSolveResult>,
    pub branches: Vec<TrackedBranch>,
    pub solver_model: EigenSolverModel,
    pub notes: Vec<String>,
    pub include_demag: bool,
    pub dispersion_validation: Option<FemEigenDispersionValidationIR>,
    pub k0_kittel_validation: Option<FemEigenK0KittelValidationIR>,
    pub dispersion_analytic_reference: Option<DispersionAnalyticReferenceContext>,
    pub k0_kittel_periodic_airbox_demag: Option<K0KittelPeriodicAirboxDemagMetrics>,
}
