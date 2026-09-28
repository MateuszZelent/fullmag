//! Backend-neutral post-stage observation provider policy.

use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AcceptedStateId {
    pub run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage_id: Option<String>,
    pub accepted_step: u64,
    pub clock_digest: String,
    pub state_digest: String,
    pub domain_digest: String,
    pub plan_digest: String,
}

impl AcceptedStateId {
    pub fn validate(&self) -> Result<(), AcceptedStateIdentityError> {
        if self.run_id.trim().is_empty() {
            return Err(AcceptedStateIdentityError::EmptyRunId);
        }
        if self
            .stage_id
            .as_deref()
            .is_some_and(|stage_id| stage_id.trim().is_empty())
        {
            return Err(AcceptedStateIdentityError::EmptyStageId);
        }
        for (field, digest) in [
            ("clock_digest", self.clock_digest.as_str()),
            ("state_digest", self.state_digest.as_str()),
            ("domain_digest", self.domain_digest.as_str()),
            ("plan_digest", self.plan_digest.as_str()),
        ] {
            if !is_canonical_sha256(digest) {
                return Err(AcceptedStateIdentityError::InvalidDigest { field });
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AcceptedStateGeneration {
    pub runtime_epoch: u64,
    pub accepted_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AcceptedStateRef {
    pub id: AcceptedStateId,
    pub generation: AcceptedStateGeneration,
}

impl AcceptedStateRef {
    pub fn validate(&self) -> Result<(), AcceptedStateIdentityError> {
        self.id.validate()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcceptedStateIdentityError {
    EmptyRunId,
    EmptyStageId,
    InvalidDigest { field: &'static str },
}

impl fmt::Display for AcceptedStateIdentityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyRunId => formatter.write_str("accepted state run_id must not be empty"),
            Self::EmptyStageId => formatter.write_str("accepted state stage_id must not be empty"),
            Self::InvalidDigest { field } => {
                write!(formatter, "accepted state {field} must be canonical sha256")
            }
        }
    }
}

impl std::error::Error for AcceptedStateIdentityError {}

fn is_canonical_sha256(value: &str) -> bool {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return false;
    };
    hex.len() == 64
        && hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

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

#[cfg(test)]
mod tests {
    use super::{
        AcceptedStateGeneration, AcceptedStateId, AcceptedStateIdentityError, AcceptedStateRef,
    };

    fn digest(character: char) -> String {
        format!("sha256:{}", character.to_string().repeat(64))
    }

    fn accepted_state_ref() -> AcceptedStateRef {
        AcceptedStateRef {
            id: AcceptedStateId {
                run_id: "run-7".into(),
                stage_id: Some("stage-003".into()),
                accepted_step: 42,
                clock_digest: digest('a'),
                state_digest: digest('b'),
                domain_digest: digest('c'),
                plan_digest: digest('d'),
            },
            generation: AcceptedStateGeneration {
                runtime_epoch: 9,
                accepted_revision: 17,
            },
        }
    }

    #[test]
    fn accepted_state_ref_round_trips_without_merging_generation_into_identity() {
        let reference = accepted_state_ref();
        reference.validate().expect("valid accepted state ref");

        let encoded = serde_json::to_vec(&reference).expect("serialize accepted state ref");
        let decoded: AcceptedStateRef =
            serde_json::from_slice(&encoded).expect("deserialize accepted state ref");
        assert_eq!(decoded, reference);

        let mut with_unknown_field =
            serde_json::to_value(&reference).expect("serialize accepted state ref");
        with_unknown_field["unexpected"] = serde_json::json!(true);
        assert!(serde_json::from_value::<AcceptedStateRef>(with_unknown_field).is_err());

        let mut next_generation = reference.clone();
        next_generation.generation.accepted_revision += 1;
        assert_eq!(next_generation.id, reference.id);
        assert_ne!(next_generation, reference);
    }

    #[test]
    fn accepted_state_ref_rejects_empty_scope_and_noncanonical_digests() {
        let mut reference = accepted_state_ref();
        reference.id.run_id.clear();
        assert_eq!(
            reference.validate(),
            Err(AcceptedStateIdentityError::EmptyRunId)
        );

        let mut reference = accepted_state_ref();
        reference.id.stage_id = Some(" ".into());
        assert_eq!(
            reference.validate(),
            Err(AcceptedStateIdentityError::EmptyStageId)
        );

        let mut reference = accepted_state_ref();
        reference.id.state_digest = format!("sha256:{}", "A".repeat(64));
        assert_eq!(
            reference.validate(),
            Err(AcceptedStateIdentityError::InvalidDigest {
                field: "state_digest"
            })
        );
    }

    #[test]
    fn accepted_state_identity_keeps_run_and_stage_in_equality() {
        let reference = accepted_state_ref();

        let mut other_run = reference.clone();
        other_run.id.run_id = "run-8".into();
        assert_ne!(other_run.id, reference.id);

        let mut other_stage = reference.clone();
        other_stage.id.stage_id = Some("stage-004".into());
        assert_ne!(other_stage.id, reference.id);
    }
}
