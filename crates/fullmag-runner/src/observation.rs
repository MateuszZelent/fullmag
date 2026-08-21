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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ObservationProviderResolver {
    lane: Option<ObservationLane>,
}

impl ObservationProviderResolver {
    pub fn from_backend_plan(plan: &fullmag_ir::BackendPlanIR) -> Self {
        use fullmag_ir::{BackendPlanIR, FemDomainMeshModeIR};
        let lane = match plan {
            BackendPlanIR::Fdm(_) => Some(ObservationLane::FdmRegular),
            BackendPlanIR::FdmMultilayer(_) => Some(ObservationLane::FdmMultilayer),
            BackendPlanIR::Fem(fem)
                if fem.domain_mesh_mode == FemDomainMeshModeIR::SharedDomainMeshWithAir =>
            {
                Some(ObservationLane::FemSharedAir)
            }
            BackendPlanIR::Fem(_) => Some(ObservationLane::FemMagneticOnly),
            BackendPlanIR::FemEigen(_) | BackendPlanIR::FemFrequencyResponse(_) => None,
        };
        Self { lane }
    }

    pub fn policy(self, quantity_id: &str) -> ObservationProviderPolicy {
        self.lane
            .map(|lane| observation_provider_policy(lane, quantity_id))
            .unwrap_or(ObservationProviderPolicy::UnavailableAfterStage)
    }

    pub fn retains_idle_runtime(self) -> bool {
        self.policy("m") == ObservationProviderPolicy::RetainedRuntime
    }

    pub fn uses_deterministic_reconstruction(self) -> bool {
        self.policy("m") == ObservationProviderPolicy::DeterministicReconstruction
    }

    pub fn terminal_snapshot_quantity_ids(self) -> Vec<&'static str> {
        crate::quantities::field_materialization_quantity_ids()
            .into_iter()
            .filter(|quantity_id| {
                matches!(
                    self.policy(quantity_id),
                    ObservationProviderPolicy::RetainedRuntime
                        | ObservationProviderPolicy::ImmutableTerminalSnapshot
                )
            })
            .collect()
    }
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
        ObservationLane::FdmMultilayer => ObservationProviderPolicy::DeterministicReconstruction,
        ObservationLane::FemSharedAir => ObservationProviderPolicy::ImmutableTerminalSnapshot,
    }
}
