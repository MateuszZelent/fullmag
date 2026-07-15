mod charge;
mod oersted;
mod spin_drift_diffusion;

pub use charge::{
    ChargeBalanceDiagnostics, ChargeBoundaryConditions, ChargeSolution, ChargeSolverConfig,
    OrientedFaceFluxes, PotentialGauge, StructuredChargeProblem,
};
pub use oersted::biot_savart_midpoint_field;

pub use spin_drift_diffusion::{
    OrientedSpinFaceFluxes, ReactionChannels, SpinBalanceDiagnostics, SpinBoundaryCondition,
    SpinBoundaryConditions, SpinDriftDiffusionProblem, SpinMaterialFields, SpinReactionLengths,
    SpinSolution, SpinSolverConfig,
};

#[cfg(test)]
mod spin_drift_diffusion_tests;
