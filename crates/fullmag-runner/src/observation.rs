//! Backend-neutral post-stage observation provider policy.

/// Execution lane whose accepted state backs post-stage observations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObservationLane {
    FdmRegular,
    FdmMultilayer,
    FemMagneticOnly,
    FemSharedAir,
}

/// Exactly one source policy is selected for each quantity and lane.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObservationProviderPolicy {
    RetainedRuntime,
    DeterministicReconstruction,
    ImmutableTerminalSnapshot,
    UnavailableAfterStage,
}

pub fn observation_provider_policy(
    lane: ObservationLane,
    quantity_id: &str,
) -> ObservationProviderPolicy {
    if crate::quantities::normalize_quantity_id(quantity_id).is_err() {
        return ObservationProviderPolicy::UnavailableAfterStage;
    }

    match lane {
        ObservationLane::FdmRegular | ObservationLane::FemMagneticOnly => {
            ObservationProviderPolicy::RetainedRuntime
        }
        ObservationLane::FdmMultilayer => {
            ObservationProviderPolicy::DeterministicReconstruction
        }
        ObservationLane::FemSharedAir => {
            ObservationProviderPolicy::ImmutableTerminalSnapshot
        }
    }
}
