mod charge;
mod oersted;
mod reciprocal_constitutive;
mod spin_drift_diffusion;
mod transient_spin;

pub use charge::{
    ChargeBalanceDiagnostics, ChargeBoundaryConditions, ChargeSolution, ChargeSolverConfig,
    OrientedFaceFluxes, PotentialGauge, StructuredChargeProblem,
};
pub use oersted::biot_savart_midpoint_field;
pub use reciprocal_constitutive::{ReciprocalConstitutiveMaterial, ReciprocalConstitutiveResponse};

pub use spin_drift_diffusion::{
    InternalSpinContact, OrientedSpinFaceFluxes, OrientedSpinInterface, ReactionChannels,
    SpinBalanceDiagnostics, SpinBoundaryCondition, SpinBoundaryConditions,
    SpinDriftDiffusionProblem, SpinFluxOperator, SpinInterfaceFluxObservation, SpinInterfaceLaw,
    SpinMaterialFields, SpinReactionLengths, SpinSolution, SpinSolverConfig, SpinSolverTelemetry,
    SpinTorqueTargets, StructuredSpinFace,
};
pub use transient_spin::{
    TransientSpinIntegrator, TransientSpinMaterial, TransientSpinSolverConfig, TransientSpinState,
    TransientStepAttempt, TransientStepTelemetry,
};

#[cfg(test)]
mod spin_drift_diffusion_tests;
