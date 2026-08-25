//! Finite-difference micromagnetics engine.
//!
//! This module owns the Rust FDM reference implementation. Shared physics
//! contracts live under `fdm/shared`; CPU execution lives under `fdm/cpu`.

pub mod cpu;
pub(crate) mod demo;
pub mod shared;

pub use demo::{run_reference_exchange_demo, ReferenceDemoReport};

pub use cpu::fft::{
    compute_newell_kernel_spectra, compute_newell_kernel_spectra_thin_film_2d,
    compute_periodic_newell_kernel_spectra, DemagKernelSpectra, FftWorkspace,
};

pub use shared::problem::ExchangeLlgProblem;

/// Maximum RK23 RHS evaluations for the canonical adaptive CPU oracle workload.
///
/// The gate allows five percent over the measured 2,364-evaluation baseline.
pub const FDM_CPU_ADAPTIVE_RK23_MAX_RHS_EVALS_TO_ORACLE: u32 = 2_483;
/// Maximum RK45 RHS evaluations for the canonical adaptive CPU oracle workload.
///
/// The gate allows five percent over the measured 128-evaluation baseline.
pub const FDM_CPU_ADAPTIVE_RK45_MAX_RHS_EVALS_TO_ORACLE: u32 = 135;

pub use cpu::state::{
    AbmHistory, AbmHistorySoA, AdaptiveAttemptDecision, AdaptiveAttemptReason,
    AdaptiveAttemptRecord, ExchangeLlgState, ExchangeLlgStateSoA, IntegratorBuffers, SolverSession,
    MAX_ADAPTIVE_ATTEMPT_RECORDS,
};
pub use shared::observables::{EffectiveFieldObservables, RhsEvaluation, StepReport};

pub use shared::VectorFieldSoA;

pub use shared::terms::{
    CubicAnisotropyConfig, EffectiveFieldTerms, MagnetoelasticTermConfig, OerstedCylinderConfig,
    RegionalFieldDriveTerm, SlonczewskiFormula, SlonczewskiSttConfig, SotConfig, SotFormula,
    UniaxialAnisotropyConfig, ZhangLiFormula, ZhangLiSttConfig,
};
pub use shared::types::{
    neighbor_index, AdaptiveStepConfig, AxisBoundary, CellSize, CoupledImexArk2Stage,
    CoupledImexArk2Tableau, EngineError, EngineErrorCode, EvaluationRequest, ExternalStageTerms,
    FdmBoundaryPolicy, FdmDemagBoundary, GridShape, LlgConfig, MaterialParameters,
    ResolvedFdmPeriodicWorkspace, Result, TimeIntegrator, TransportStageErrorBudget,
};
