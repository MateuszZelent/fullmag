//! Backend-neutral post-stage observation provider policy.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ObservationClock {
    pub accepted_step: u64,
    pub time_seconds: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dt_seconds: Option<f64>,
}

impl ObservationClock {
    pub fn validate(&self) -> Result<(), AcceptedStateIdentityError> {
        if !self.time_seconds.is_finite() {
            return Err(AcceptedStateIdentityError::NonFiniteTime);
        }
        if self
            .dt_seconds
            .is_some_and(|dt_seconds| !dt_seconds.is_finite() || dt_seconds <= 0.0)
        {
            return Err(AcceptedStateIdentityError::InvalidTimestep);
        }
        Ok(())
    }

    pub fn canonical_bytes(&self) -> Result<Vec<u8>, AcceptedStateIdentityError> {
        self.validate()?;
        let mut bytes = Vec::with_capacity(128);
        push_canonical_field(&mut bytes, b"fullmag.observation-clock.v1");
        push_canonical_field(&mut bytes, &self.accepted_step.to_be_bytes());
        push_canonical_field(&mut bytes, &self.time_seconds.to_bits().to_be_bytes());
        match self.dt_seconds {
            Some(dt_seconds) => {
                push_canonical_field(&mut bytes, &[1]);
                push_canonical_field(&mut bytes, &dt_seconds.to_bits().to_be_bytes());
            }
            None => push_canonical_field(&mut bytes, &[0]),
        }
        Ok(bytes)
    }

    pub fn digest(&self) -> Result<String, AcceptedStateIdentityError> {
        Ok(sha256_prefixed(&self.canonical_bytes()?))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AcceptedPrimaryCarrier<'a> {
    pub carrier_id: &'a str,
    pub canonical_bytes: &'a [u8],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcceptedStateDigests {
    pub clock_digest: String,
    pub state_digest: String,
}

pub fn accepted_state_digests(
    clock: ObservationClock,
    primary_carriers: &[AcceptedPrimaryCarrier<'_>],
) -> Result<AcceptedStateDigests, AcceptedStateIdentityError> {
    let clock_bytes = clock.canonical_bytes()?;
    if primary_carriers.is_empty() {
        return Err(AcceptedStateIdentityError::MissingPrimaryCarriers);
    }

    let mut carriers = primary_carriers.to_vec();
    carriers.sort_unstable_by(|left, right| left.carrier_id.cmp(right.carrier_id));
    for (index, carrier) in carriers.iter().enumerate() {
        if carrier.carrier_id.trim().is_empty() {
            return Err(AcceptedStateIdentityError::EmptyCarrierId);
        }
        if index > 0 && carriers[index - 1].carrier_id == carrier.carrier_id {
            return Err(AcceptedStateIdentityError::DuplicateCarrierId);
        }
    }

    let mut state_bytes = Vec::new();
    push_canonical_field(&mut state_bytes, b"fullmag.accepted-state.v1");
    push_canonical_field(&mut state_bytes, &clock_bytes);
    push_canonical_field(&mut state_bytes, &(carriers.len() as u64).to_be_bytes());
    for carrier in carriers {
        push_canonical_field(&mut state_bytes, carrier.carrier_id.as_bytes());
        push_canonical_field(&mut state_bytes, carrier.canonical_bytes);
    }

    Ok(AcceptedStateDigests {
        clock_digest: sha256_prefixed(&clock_bytes),
        state_digest: sha256_prefixed(&state_bytes),
    })
}

fn push_canonical_field(destination: &mut Vec<u8>, field: &[u8]) {
    destination.extend_from_slice(&(field.len() as u64).to_be_bytes());
    destination.extend_from_slice(field);
}

fn sha256_prefixed(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut encoded = String::with_capacity(71);
    encoded.push_str("sha256:");
    for byte in digest {
        use fmt::Write as _;
        write!(&mut encoded, "{byte:02x}").expect("writing to String cannot fail");
    }
    encoded
}

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
    pub fn from_canonical_state(
        run_id: impl Into<String>,
        stage_id: Option<String>,
        clock: ObservationClock,
        primary_carriers: &[AcceptedPrimaryCarrier<'_>],
        domain_digest: impl Into<String>,
        plan_digest: impl Into<String>,
    ) -> Result<Self, AcceptedStateIdentityError> {
        let digests = accepted_state_digests(clock, primary_carriers)?;
        let identity = Self {
            run_id: run_id.into(),
            stage_id,
            accepted_step: clock.accepted_step,
            clock_digest: digests.clock_digest,
            state_digest: digests.state_digest,
            domain_digest: domain_digest.into(),
            plan_digest: plan_digest.into(),
        };
        identity.validate()?;
        Ok(identity)
    }

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
    NonFiniteTime,
    InvalidTimestep,
    MissingPrimaryCarriers,
    EmptyCarrierId,
    DuplicateCarrierId,
    InvalidDigest { field: &'static str },
}

impl fmt::Display for AcceptedStateIdentityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyRunId => formatter.write_str("accepted state run_id must not be empty"),
            Self::EmptyStageId => formatter.write_str("accepted state stage_id must not be empty"),
            Self::NonFiniteTime => {
                formatter.write_str("accepted state time_seconds must be finite")
            }
            Self::InvalidTimestep => formatter
                .write_str("accepted state dt_seconds must be finite and greater than zero"),
            Self::MissingPrimaryCarriers => {
                formatter.write_str("accepted state requires at least one primary carrier")
            }
            Self::EmptyCarrierId => {
                formatter.write_str("accepted state primary carrier id must not be empty")
            }
            Self::DuplicateCarrierId => {
                formatter.write_str("accepted state primary carrier ids must be unique")
            }
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
        accepted_state_digests, AcceptedPrimaryCarrier, AcceptedStateGeneration, AcceptedStateId,
        AcceptedStateIdentityError, AcceptedStateRef, ObservationClock,
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
    fn accepted_state_digests_are_order_independent_and_content_bound() {
        let clock = ObservationClock {
            accepted_step: 42,
            time_seconds: 2.5e-12,
            dt_seconds: Some(1.0e-15),
        };
        let magnetization = [1_u8, 2, 3, 4];
        let rng = [9_u8, 8, 7];
        let forward = [
            AcceptedPrimaryCarrier {
                carrier_id: "magnetization.f64le.v1",
                canonical_bytes: &magnetization,
            },
            AcceptedPrimaryCarrier {
                carrier_id: "thermal_rng.v1",
                canonical_bytes: &rng,
            },
        ];
        let reverse = [forward[1], forward[0]];

        let first = accepted_state_digests(clock, &forward).expect("canonical digests");
        let second = accepted_state_digests(clock, &reverse).expect("canonical digests");
        assert_eq!(first, second);
        assert_eq!(
            first.clock_digest,
            "sha256:261d0b553b39c3df26e5190ea8c7454378708dceea3c85f84ff92425961bc98b"
        );
        assert_eq!(
            first.state_digest,
            "sha256:c55aa55ee9c67629dd15e1b9634b99e59edbbbddc6b63fcebd98b505866a35c2"
        );

        let changed_magnetization = [1_u8, 2, 3, 5];
        let changed = accepted_state_digests(
            clock,
            &[
                AcceptedPrimaryCarrier {
                    carrier_id: "magnetization.f64le.v1",
                    canonical_bytes: &changed_magnetization,
                },
                forward[1],
            ],
        )
        .expect("changed canonical digests");
        assert_eq!(changed.clock_digest, first.clock_digest);
        assert_ne!(changed.state_digest, first.state_digest);
    }

    #[test]
    fn accepted_state_digests_reject_ambiguous_or_invalid_inputs() {
        let clock = ObservationClock {
            accepted_step: 0,
            time_seconds: 0.0,
            dt_seconds: None,
        };
        assert_eq!(
            accepted_state_digests(clock, &[]),
            Err(AcceptedStateIdentityError::MissingPrimaryCarriers)
        );

        let carrier = AcceptedPrimaryCarrier {
            carrier_id: "m.v1",
            canonical_bytes: &[1, 2, 3],
        };
        assert_eq!(
            accepted_state_digests(clock, &[carrier, carrier]),
            Err(AcceptedStateIdentityError::DuplicateCarrierId)
        );

        let invalid_clock = ObservationClock {
            accepted_step: 1,
            time_seconds: f64::NAN,
            dt_seconds: Some(1.0e-15),
        };
        assert_eq!(
            accepted_state_digests(invalid_clock, &[carrier]),
            Err(AcceptedStateIdentityError::NonFiniteTime)
        );
    }

    #[test]
    fn accepted_state_id_is_built_from_the_same_canonical_clock() {
        let clock = ObservationClock {
            accepted_step: 7,
            time_seconds: 3.0e-12,
            dt_seconds: None,
        };
        let carrier = AcceptedPrimaryCarrier {
            carrier_id: "magnetization.f64le.v1",
            canonical_bytes: &[0, 1, 2, 3],
        };
        let identity = AcceptedStateId::from_canonical_state(
            "run-7",
            Some("stage-003".into()),
            clock,
            &[carrier],
            digest('c'),
            digest('d'),
        )
        .expect("accepted state identity");

        assert_eq!(identity.accepted_step, clock.accepted_step);
        assert_eq!(identity.clock_digest, clock.digest().expect("clock digest"));
        identity.validate().expect("valid accepted state identity");
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
