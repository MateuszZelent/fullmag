mod charge;
mod oersted;
mod spin_drift_diffusion;

pub use charge::{
    ChargeBalanceDiagnostics, ChargeBoundaryConditions, ChargeSolution, ChargeSolverConfig,
    OrientedFaceFluxes, PotentialGauge, StructuredChargeProblem,
};
pub use oersted::biot_savart_midpoint_field;

pub use spin_drift_diffusion::{
    InternalSpinContact, OrientedSpinFaceFluxes, OrientedSpinInterface, ReactionChannels,
    SpinBalanceDiagnostics, SpinBoundaryCondition, SpinBoundaryConditions,
    SpinDriftDiffusionProblem, SpinFluxOperator, SpinInterfaceFluxObservation, SpinInterfaceLaw,
    SpinMaterialFields, SpinReactionLengths, SpinSolution, SpinSolverConfig, SpinSolverTelemetry,
    SpinTorqueTargets, StructuredSpinFace,
};

#[cfg(test)]
mod spin_drift_diffusion_tests;
