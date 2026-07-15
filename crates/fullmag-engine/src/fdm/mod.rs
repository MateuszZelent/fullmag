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

pub use cpu::state::{
    AbmHistory, AbmHistorySoA, ExchangeLlgState, ExchangeLlgStateSoA, IntegratorBuffers,
    SolverSession,
};
pub use shared::observables::{EffectiveFieldObservables, RhsEvaluation, StepReport};

pub use shared::VectorFieldSoA;

pub use shared::terms::{
    CubicAnisotropyConfig, EffectiveFieldTerms, MagnetoelasticTermConfig, OerstedCylinderConfig,
    SlonczewskiSttConfig, SotConfig, SotFormula, UniaxialAnisotropyConfig, ZhangLiSttConfig,
};
pub use shared::types::{
    neighbor_index, AdaptiveStepConfig, AxisBoundary, CellSize, EngineError, EvaluationRequest,
    FdmBoundaryPolicy, FdmDemagBoundary, GridShape, LlgConfig, MaterialParameters, Result,
    ResolvedFdmPeriodicWorkspace, TimeIntegrator,
};
