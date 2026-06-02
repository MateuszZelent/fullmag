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

pub mod engine;
pub mod integrators;
pub mod relax;
