mod charge;
mod coupled_block_linear;
mod coupled_charge_spin;
mod oersted;
mod reciprocal_constitutive;
mod spin_drift_diffusion;
mod transient_spin;

pub use charge::{
    ChargeBalanceDiagnostics, ChargeBoundaryCondition, ChargeBoundaryConditions,
    ChargeInterfaceFluxObservation, ChargeSolution, ChargeSolverConfig,
    OrientedChargeMixingInterface, OrientedFaceFluxes, PotentialGauge, StructuredChargeFace,
    StructuredChargeProblem,
};
pub use coupled_charge_spin::{
    CoupledChargeSpinBoundaryConditions, CoupledChargeSpinMaterialFields, CoupledChargeSpinProblem,
    CoupledChargeSpinSolution, CoupledChargeSpinSolverConfig, CoupledChargeSpinTelemetry,
    CoupledChargeSpinWarmStart, CoupledPicardIterationTelemetry, CoupledTransportOuterErrorBudget,
};
pub use oersted::biot_savart_midpoint_field;
pub use reciprocal_constitutive::{ReciprocalConstitutiveMaterial, ReciprocalConstitutiveResponse};

pub use spin_drift_diffusion::{
    InternalSpinContact, OrientedSpinFaceFluxes, OrientedSpinInterface, ReactionChannels,
    SpinBalanceDiagnostics, SpinBoundaryCondition, SpinBoundaryConditions,
    SpinDriftDiffusionProblem, SpinFluxOperator, SpinInterfaceFluxObservation, SpinInterfaceLaw,
    SpinMaterialFields, SpinMemoryLossFluxObservation, SpinMemoryLossReservoirLaw,
    SpinReactionLengths, SpinSolution, SpinSolverConfig, SpinSolverTelemetry, SpinTorqueTargets,
    StructuredSpinFace, TransientSpinObservation,
};
pub use transient_spin::{
    TransientCoupledRestartIdentity, TransientCoupledState, TransientErrorControllerState,
    TransientSpinCheckpoint, TransientSpinIntegrator, TransientSpinMaterial,
    TransientSpinSolverConfig, TransientSpinState, TransientStepAttempt, TransientStepTelemetry,
};

#[cfg(test)]
mod coupled_charge_spin_tests;
#[cfg(test)]
mod spin_drift_diffusion_tests;
