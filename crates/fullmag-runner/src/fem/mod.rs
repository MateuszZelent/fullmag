//! FEM execution layer — relaxation, integrators, and engine dispatch.
//!
//! Module layout:
//! ```text
//! fem/
//! ├── mod.rs            — re-exports and module root
//! ├── engine.rs         — FemEngine enum, resolution helpers, availability
//! ├── relax/
//! │   ├── mod.rs        — execute_fem_relax() entry point
//! │   ├── algorithm.rs  — algorithm → execution-lane mapping
//! │   ├── llg_overdamped.rs — LLG overdamped config and provenance
//! │   └── stop.rs       — FEM stop criteria and convergence windows
//! └── integrators/
//!     ├── mod.rs        — integrator selection dispatch
//!     ├── fixed.rs      — Heun / RK4 fixed-step config
//!     └── adaptive.rs   — RK23 / RK45 adaptive-step config
//! ```
//!
//! Entry point for higher-level code: `fem::relax::execute_fem_relax(engine, plan, …)`.

pub(crate) mod eigen_anisotropy;
pub(crate) mod eigen_capability;
pub(crate) mod eigen_certificate;
pub(crate) mod eigen_constants;
pub(crate) mod eigen_digest;
pub(crate) mod eigen_equilibrium;
pub(crate) mod eigen_equilibrium_contract;
pub(crate) mod eigen_execution;
pub(crate) mod eigen_execution_resolution;
pub(crate) mod eigen_math;
pub(crate) mod eigen_native_artifacts;
pub(crate) mod eigen_native_result;
pub(crate) mod eigen_native_window;
pub(crate) mod eigen_operator;
pub(crate) mod eigen_output;
mod eigen_path;
pub(crate) use eigen_path::execute_fem_eigen_path;
#[cfg(test)]
pub(crate) use eigen_path::test_support;
pub(crate) mod eigen_policy;
pub(crate) mod eigen_progress;
pub(crate) mod eigen_projection;
pub(crate) mod eigen_reduction;
pub(crate) mod eigen_shared_domain;
pub(crate) mod eigen_shared_domain_geometry;
pub(crate) mod eigen_solve;
pub(crate) mod eigen_sweep;
#[cfg(test)]
mod eigen_tests;
#[cfg(test)]
pub(crate) fn real_bounded_k0_problem(
    requested_device: &str,
    runtime_override: Option<serde_json::Value>,
) -> fullmag_ir::ProblemIR {
    eigen_tests::real_bounded_k0_problem(requested_device, runtime_override)
}
pub(crate) mod eigen_types;
pub mod engine;
pub(crate) mod equilibrium_identity;
pub mod integrators;
pub mod relax;
