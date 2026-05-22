//! Finite-difference micromagnetics engine.
//!
//! This module owns the Rust FDM reference implementation. The crate root keeps
//! temporary `fdm_*` compatibility modules while callers migrate to this layout.

pub(crate) mod demo;
pub(crate) mod fft;
pub mod fft_backend;
pub(crate) mod fields;
pub(crate) mod integrators;
pub(crate) mod problem;
pub(crate) mod state;
pub(crate) mod types;

pub use demo::{run_reference_exchange_demo, ReferenceDemoReport};

pub use fft::{
    compute_newell_kernel_spectra, compute_newell_kernel_spectra_thin_film_2d,
    compute_periodic_newell_kernel_spectra, DemagKernelSpectra, FftWorkspace,
};

pub use problem::ExchangeLlgProblem;

pub use state::{
    AbmHistory, AbmHistorySoA, EffectiveFieldObservables, ExchangeLlgState, ExchangeLlgStateSoA,
    IntegratorBuffers, RhsEvaluation, SolverSession, StepReport,
};

pub use types::{
    neighbor_index, AdaptiveStepConfig, AxisBoundary, CellSize, CubicAnisotropyConfig,
    EffectiveFieldTerms, EngineError, EvaluationRequest, FdmBoundaryPolicy, GridShape, LlgConfig,
    MagnetoelasticTermConfig, MaterialParameters, OerstedCylinderConfig, Result,
    SlonczewskiSttConfig, SotConfig, TimeIntegrator, UniaxialAnisotropyConfig, ZhangLiSttConfig,
};
