//! Backend-neutral identity for one accepted solver state.

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
    InvalidSnapshotSchema,
    InvalidPrimaryCarrierSet,
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
            Self::InvalidSnapshotSchema => {
                formatter.write_str("accepted state snapshot schema is unsupported")
            }
            Self::InvalidPrimaryCarrierSet => {
                formatter.write_str("accepted state snapshot primary carrier set is invalid")
            }
            Self::InvalidDigest { field } => {
                write!(formatter, "accepted state {field} must be canonical sha256")
            }
        }
    }
}

impl std::error::Error for AcceptedStateIdentityError {}

pub fn is_canonical_sha256(value: &str) -> bool {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return false;
    };
    hex.len() == 64
        && hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
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
