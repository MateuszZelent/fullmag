//! Relaxation orchestration helpers.
//!
//! This top-level module is intentionally a facade. Keep shared stop criteria,
//! provenance mapping, vector math, and reference direct-minimizer solvers in
//! focused submodules so runner code does not grow a second solver tree.

pub(crate) mod convergence;
pub(crate) mod direct_minimizer;
mod direct_minimizer_reference;
pub(crate) mod provenance;
pub(crate) mod vector_math;

pub(crate) use convergence::{
    approximate_max_torque, effective_max_torque_apm, infer_stage_completion,
    llg_overdamped_uses_pure_damping, relaxation_converged, relaxation_stop_criteria_satisfied,
    EnergyPlateauRangeJ, RelaxationEnergyPlateauWindow, RELAXATION_ENERGY_PLATEAU_WINDOW_STEPS,
};
pub(crate) use direct_minimizer_reference::{execute_nonlinear_cg, execute_projected_gradient_bb};
pub(crate) use provenance::{
    apply_energy_minimizer_provenance, CPU_SOA_DIRECT_MINIMIZER_REALIZATION,
};
