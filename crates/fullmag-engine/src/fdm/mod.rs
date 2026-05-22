//! Finite-difference micromagnetics engine.
//!
//! This module owns the Rust FDM reference implementation. The crate root keeps
//! temporary `fdm_*` compatibility modules while callers migrate to this layout.

pub(crate) mod cpu;
pub(crate) mod demo;
pub mod shared;

pub use demo::{run_reference_exchange_demo, ReferenceDemoReport};

pub(crate) mod fft {
    pub use super::cpu::fft::*;
}

pub mod fft_backend {
    pub use super::cpu::fft_backend::*;
}

pub(crate) mod state {
    pub use super::cpu::state::*;
    pub use super::shared::observables::*;
}

pub(crate) mod problem {
    pub use super::shared::problem::*;
}

pub(crate) mod types {
    pub use super::shared::terms::*;
    pub use super::shared::types::*;
}

pub use fft::{
    compute_newell_kernel_spectra, compute_newell_kernel_spectra_thin_film_2d,
    compute_periodic_newell_kernel_spectra, DemagKernelSpectra, FftWorkspace,
};

pub use problem::ExchangeLlgProblem;

pub use state::{
    AbmHistory, AbmHistorySoA, EffectiveFieldObservables, ExchangeLlgState, ExchangeLlgStateSoA,
    IntegratorBuffers, RhsEvaluation, SolverSession, StepReport,
};

pub use shared::VectorFieldSoA;

pub use types::{
    neighbor_index, AdaptiveStepConfig, AxisBoundary, CellSize, CubicAnisotropyConfig,
    EffectiveFieldTerms, EngineError, EvaluationRequest, FdmBoundaryPolicy, GridShape, LlgConfig,
    MagnetoelasticTermConfig, MaterialParameters, OerstedCylinderConfig, Result,
    SlonczewskiSttConfig, SotConfig, TimeIntegrator, UniaxialAnisotropyConfig, ZhangLiSttConfig,
};
