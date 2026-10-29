//! Backend-neutral post-stage observation provider policy.

pub use fullmag_quantities::{
    accepted_state_digests, AcceptedPrimaryCarrier, AcceptedStateDigests, AcceptedStateGeneration,
    AcceptedStateId, AcceptedStateIdentityError, AcceptedStateRef, ObservationClock,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const FDM_CPU_ACCEPTED_STATE_SNAPSHOT_SCHEMA: &str =
    "fullmag.fdm.cpu.accepted-state-snapshot.v1";
pub const FDM_CPU_ACCEPTED_STATE_SNAPSHOT_FILE: &str =
    "solver/fdm_cpu_accepted_state_snapshot.v1.json";
pub const FDM_GPU_ACCEPTED_STATE_SNAPSHOT_SCHEMA: &str =
    "fullmag.fdm.gpu.accepted-state-snapshot.v1";
pub const FDM_GPU_ACCEPTED_STATE_SNAPSHOT_FILE: &str =
    "solver/fdm_gpu_accepted_state_snapshot.v1.json";
pub const FDM_MULTILAYER_OBSERVATION_SNAPSHOT_SCHEMA: &str =
    "fullmag.fdm.multilayer.observation-snapshot.v1";
pub const FDM_MULTILAYER_OBSERVATION_SNAPSHOT_FILE: &str =
    "solver/fdm_multilayer_observation_snapshot.v1.json";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FdmCpuAcceptedStateSnapshotV1 {
    pub schema_version: String,
    pub clock: ObservationClock,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transactional_state_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub magnetization_digest: Option<String>,
    pub clock_digest: String,
    pub state_digest: String,
    pub primary_carrier_ids: Vec<String>,
}

impl FdmCpuAcceptedStateSnapshotV1 {
    pub fn from_transactional_state_digest(
        clock: ObservationClock,
        transactional_state_digest: &str,
    ) -> Result<Self, AcceptedStateIdentityError> {
        if !fullmag_quantities::is_canonical_sha256(transactional_state_digest) {
            return Err(AcceptedStateIdentityError::InvalidDigest {
                field: "transactional_state_digest",
            });
        }
        let carrier_id = "fdm.cpu.transactional-state-digest.v1";
        let digests = accepted_state_digests(
            clock,
            &[AcceptedPrimaryCarrier {
                carrier_id,
                canonical_bytes: transactional_state_digest.as_bytes(),
            }],
        )?;
        Ok(Self {
            schema_version: FDM_CPU_ACCEPTED_STATE_SNAPSHOT_SCHEMA.to_string(),
            clock,
            transactional_state_digest: Some(transactional_state_digest.to_string()),
            magnetization_digest: None,
            clock_digest: digests.clock_digest,
            state_digest: digests.state_digest,
            primary_carrier_ids: vec![carrier_id.to_string()],
        })
    }

    pub fn from_transactional_state(
        clock: ObservationClock,
        transactional_state_digest: &str,
        magnetization: &[[f64; 3]],
    ) -> Result<Self, AcceptedStateIdentityError> {
        let mut snapshot =
            Self::from_transactional_state_digest(clock, transactional_state_digest)?;
        snapshot.magnetization_digest = Some(magnetization_digest_f64be(magnetization)?);
        Ok(snapshot)
    }

    pub fn validate(&self) -> Result<(), AcceptedStateIdentityError> {
        if self.schema_version != FDM_CPU_ACCEPTED_STATE_SNAPSHOT_SCHEMA {
            return Err(AcceptedStateIdentityError::InvalidSnapshotSchema);
        }
        self.clock.validate()?;
        if self.clock.digest()? != self.clock_digest {
            return Err(AcceptedStateIdentityError::InvalidDigest {
                field: "clock_digest",
            });
        }
        if let Some(transactional_state_digest) = &self.transactional_state_digest {
            if !fullmag_quantities::is_canonical_sha256(transactional_state_digest) {
                return Err(AcceptedStateIdentityError::InvalidDigest {
                    field: "transactional_state_digest",
                });
            }
            let digests = accepted_state_digests(
                self.clock,
                &[AcceptedPrimaryCarrier {
                    carrier_id: "fdm.cpu.transactional-state-digest.v1",
                    canonical_bytes: transactional_state_digest.as_bytes(),
                }],
            )?;
            if digests.state_digest != self.state_digest {
                return Err(AcceptedStateIdentityError::InvalidDigest {
                    field: "state_digest",
                });
            }
        }
        if self
            .magnetization_digest
            .as_deref()
            .is_some_and(|digest| !fullmag_quantities::is_canonical_sha256(digest))
        {
            return Err(AcceptedStateIdentityError::InvalidDigest {
                field: "magnetization_digest",
            });
        }
        if !fullmag_quantities::is_canonical_sha256(&self.state_digest) {
            return Err(AcceptedStateIdentityError::InvalidDigest {
                field: "state_digest",
            });
        }
        if self.primary_carrier_ids != ["fdm.cpu.transactional-state-digest.v1"] {
            return Err(AcceptedStateIdentityError::InvalidPrimaryCarrierSet);
        }
        Ok(())
    }
}


pub const FDM_CPU_ACCEPTED_STATE_SNAPSHOT_SCHEMA_V2: &str = "fullmag.fdm.cpu.accepted-state-snapshot.v2";
pub const FDM_CPU_ACCEPTED_STATE_SNAPSHOT_FILE_V2: &str = "solver/fdm_cpu_accepted_state_snapshot.v2.json";
pub const TERMINAL_PRIMARY_ROLES: [(&str, &str, &str); 4] = [
    ("fdm.cpu.transactional-state-digest.v1", "fullmag.fdm.engine_accepted_preimage", "solver/accepted-primary/v2/engine.json"),
    ("fdm.cpu.coupled-m3-checkpoint-digest.v1", "fullmag.fdm.coupled_checkpoint", "solver/accepted-primary/v2/coupled.json"),
    ("fdm.cpu.frozen-constraint-state-digest.v1", "fullmag.fdm.frozen_primary_preimage", "solver/accepted-primary/v2/frozen.json"),
    ("fdm.cpu.frozen-activation-set-digest.v1", "fullmag.fdm.frozen_activation_set", "solver/accepted-primary/v2/activation.json"),
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SemanticCarrierV2 {
    pub carrier_id: String,
    pub value_digest: String,
    pub codec_id: String,
    pub codec_version: String,
    pub preimage_sha256: String,
    pub byte_count: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FdmCpuAcceptedStateSnapshotV2 {
    pub schema_version: String,
    pub clock: ObservationClock,
    pub clock_digest: String,
    pub state_digest: String,
    pub magnetization_digest: String,
    pub primary_carriers: Vec<SemanticCarrierV2>,
}

#[derive(Debug, Clone)]
pub struct TerminalPrimaryPreimage {
    pub carrier_id: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct EngineAcceptedPreimageV1 {
    pub schema_version: String,
    pub solver: fullmag_engine::FdmCpuSolverCheckpointV1,
    pub thermal_seed: u64,
    pub thermal_step: u64,
    pub thermal_dt_s: f64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct FrozenPrimaryPreimageV1 {
    pub schema_version: String,
    #[serde(deserialize_with = "required_frozen_primary_option")]
    pub frozen_spins: Option<crate::constraints::FrozenSpinsCheckpointV1>,
}

fn required_frozen_primary_option<'de, D>(deserializer: D)
    -> Result<Option<crate::constraints::FrozenSpinsCheckpointV1>, D::Error>
where D: serde::Deserializer<'de> {
    Option::deserialize(deserializer)
}

fn terminal_identity_error(message: impl Into<String>) -> crate::types::RunError {
    crate::types::RunError { message: message.into() }
}

impl FdmCpuAcceptedStateSnapshotV2 {
    pub(crate) fn from_terminal_preimages(
        clock: ObservationClock,
        magnetization: &[[f64; 3]],
        preimages: &[TerminalPrimaryPreimage],
        value_digests: &[String; 4],
    ) -> Result<Self, crate::types::RunError> {
        if preimages.len() != TERMINAL_PRIMARY_ROLES.len() {
            return Err(terminal_identity_error("terminal primary package requires four preimages"));
        }
        let mut primary_carriers = Vec::with_capacity(4);
        for ((id, codec, _), value_digest) in TERMINAL_PRIMARY_ROLES.iter().zip(value_digests) {
            let raw = preimages.iter().find(|raw| raw.carrier_id == *id)
                .ok_or_else(|| terminal_identity_error("terminal primary preimage is missing"))?;
            primary_carriers.push(SemanticCarrierV2 {
                carrier_id: (*id).into(), value_digest: value_digest.clone(),
                codec_id: (*codec).into(), codec_version: "v1".into(),
                preimage_sha256: format!("{:x}", Sha256::digest(&raw.bytes)),
                byte_count: raw.bytes.len() as u64,
            });
        }
        primary_carriers.sort_by(|left, right| left.carrier_id.cmp(&right.carrier_id));
        let carriers: Vec<_> = primary_carriers.iter().map(|carrier| AcceptedPrimaryCarrier {
            carrier_id: &carrier.carrier_id, canonical_bytes: carrier.value_digest.as_bytes(),
        }).collect();
        let digest = accepted_state_digests(clock, &carriers)
            .map_err(|error| terminal_identity_error(error.to_string()))?;
        let snapshot = Self {
            schema_version: FDM_CPU_ACCEPTED_STATE_SNAPSHOT_SCHEMA_V2.into(), clock,
            clock_digest: digest.clock_digest, state_digest: digest.state_digest,
            magnetization_digest: magnetization_digest_f64be(magnetization)
                .map_err(|error| terminal_identity_error(error.to_string()))?,
            primary_carriers,
        };
        snapshot.validate_metadata()?;
        Ok(snapshot)
    }

    /// Metadata integrity is not validation of the four numerical preimages.
    pub fn validate_metadata(&self) -> Result<(), crate::types::RunError> {
        if self.schema_version != FDM_CPU_ACCEPTED_STATE_SNAPSHOT_SCHEMA_V2
            || self.primary_carriers.len() != 4
            || !fullmag_quantities::is_canonical_sha256(&self.magnetization_digest)
        {
            return Err(terminal_identity_error("invalid terminal accepted snapshot v2"));
        }
        let mut previous: Option<&str> = None;
        for carrier in &self.primary_carriers {
            let role = TERMINAL_PRIMARY_ROLES.iter().find(|role| role.0 == carrier.carrier_id)
                .ok_or_else(|| terminal_identity_error("unknown terminal primary carrier"))?;
            if previous.is_some_and(|id| id >= carrier.carrier_id.as_str())
                || carrier.codec_id != role.1 || carrier.codec_version != "v1"
                || carrier.byte_count == 0
                || carrier.preimage_sha256.len() != 64
                || !carrier.preimage_sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                || !fullmag_quantities::is_canonical_sha256(&carrier.value_digest)
            {
                return Err(terminal_identity_error("invalid terminal carrier metadata"));
            }
            previous = Some(&carrier.carrier_id);
        }
        let carriers: Vec<_> = self.primary_carriers.iter().map(|carrier| AcceptedPrimaryCarrier {
            carrier_id: &carrier.carrier_id, canonical_bytes: carrier.value_digest.as_bytes(),
        }).collect();
        let actual = accepted_state_digests(self.clock, &carriers)
            .map_err(|error| terminal_identity_error(error.to_string()))?;
        if actual.clock_digest != self.clock_digest || actual.state_digest != self.state_digest {
            return Err(terminal_identity_error("terminal accepted snapshot identity differs"));
        }
        Ok(())
    }

    pub fn decode_metadata(bytes: &[u8]) -> Result<Self, crate::types::RunError> {
        if bytes.len() > 64 * 1024 {
            return Err(terminal_identity_error("terminal accepted metadata exceeds 64KiB"));
        }
        let crate::artifact_json::UnambiguousJson(value) = serde_json::from_slice(bytes)
            .map_err(|error| terminal_identity_error(error.to_string()))?;
        let metadata: Self = serde_json::from_value(value)
            .map_err(|error| terminal_identity_error(error.to_string()))?;
        metadata.validate_metadata()?;
        Ok(metadata)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FdmGpuAcceptedStateSnapshotV1 {
    pub schema_version: String,
    pub clock: ObservationClock,
    pub magnetization_digest: String,
    pub clock_digest: String,
    pub state_digest: String,
    pub primary_carrier_ids: Vec<String>,
}

impl FdmGpuAcceptedStateSnapshotV1 {
    pub fn from_final_magnetization(
        clock: ObservationClock,
        magnetization: &[[f64; 3]],
    ) -> Result<Self, AcceptedStateIdentityError> {
        let magnetization_digest = magnetization_digest_f64be(magnetization)?;
        let carrier_id = "fdm.gpu.magnetization-digest.f64be.v1";
        let digests = accepted_state_digests(
            clock,
            &[AcceptedPrimaryCarrier {
                carrier_id,
                canonical_bytes: magnetization_digest.as_bytes(),
            }],
        )?;
        Ok(Self {
            schema_version: FDM_GPU_ACCEPTED_STATE_SNAPSHOT_SCHEMA.to_string(),
            clock,
            magnetization_digest,
            clock_digest: digests.clock_digest,
            state_digest: digests.state_digest,
            primary_carrier_ids: vec![carrier_id.to_string()],
        })
    }

    pub fn validate(&self) -> Result<(), AcceptedStateIdentityError> {
        if self.schema_version != FDM_GPU_ACCEPTED_STATE_SNAPSHOT_SCHEMA {
            return Err(AcceptedStateIdentityError::InvalidSnapshotSchema);
        }
        if !fullmag_quantities::is_canonical_sha256(&self.magnetization_digest) {
            return Err(AcceptedStateIdentityError::InvalidDigest {
                field: "magnetization_digest",
            });
        }
        let carrier_id = "fdm.gpu.magnetization-digest.f64be.v1";
        if self.primary_carrier_ids != [carrier_id] {
            return Err(AcceptedStateIdentityError::InvalidPrimaryCarrierSet);
        }
        let digests = accepted_state_digests(
            self.clock,
            &[AcceptedPrimaryCarrier {
                carrier_id,
                canonical_bytes: self.magnetization_digest.as_bytes(),
            }],
        )?;
        if digests.clock_digest != self.clock_digest {
            return Err(AcceptedStateIdentityError::InvalidDigest {
                field: "clock_digest",
            });
        }
        if digests.state_digest != self.state_digest {
            return Err(AcceptedStateIdentityError::InvalidDigest {
                field: "state_digest",
            });
        }
        Ok(())
    }
}

/// Observation identity for terminal FDM multilayer magnetization.
///
/// This is deliberately not a continuation/restart state: the multilayer
/// runners do not expose the integrator and RNG carriers required to claim
/// that contract. It binds the final M artifact's layout, values, clock, and
/// the actual execution lane/engine so downstream accepted-field work cannot
/// confuse a live preview or a different realization for this terminal M.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FdmMultilayerObservationSnapshotV1 {
    pub schema_version: String,
    pub state_role: String,
    pub clock: ObservationClock,
    pub execution_lane: FdmMultilayerObservationLane,
    pub execution_engine: String,
    pub layout_sha256: String,
    pub magnetization_digest: String,
    pub clock_digest: String,
    pub state_digest: String,
    pub primary_carrier_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FdmMultilayerObservationLane {
    Cpu,
    Gpu,
}

impl FdmMultilayerObservationLane {
    fn accepts_engine(self, execution_engine: &str) -> bool {
        match self {
            Self::Cpu => execution_engine == "cpu_reference_multilayer",
            Self::Gpu => matches!(
                execution_engine,
                "cuda_assisted_multilayer"
                    | "cuda_native_multilayer_convolution"
                    | "cuda_native_multilayer_single_grid"
            ),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Cpu => "cpu",
            Self::Gpu => "gpu",
        }
    }
}

impl FdmMultilayerObservationSnapshotV1 {
    const CARRIER_EXECUTION: &'static str =
        "fdm.multilayer.observation.execution-lane-engine.v1";
    const CARRIER_LAYOUT: &'static str = "fdm.multilayer.observation.layout-json.sha256.v1";
    const CARRIER_MAGNETIZATION: &'static str =
        "fdm.multilayer.observation.magnetization-f64be.sha256.v1";

    pub fn from_final_magnetization(
        clock: ObservationClock,
        execution_lane: FdmMultilayerObservationLane,
        execution_engine: &str,
        layout: &serde_json::Value,
        magnetization: &[[f64; 3]],
    ) -> Result<Self, AcceptedStateIdentityError> {
        if !execution_lane.accepts_engine(execution_engine)
            || layout.get("backend").and_then(serde_json::Value::as_str)
                != Some("fdm_multilayer")
            || layout.get("layout_error").is_some()
        {
            return Err(AcceptedStateIdentityError::InvalidPrimaryCarrierSet);
        }
        let layout_sha256 = observation_layout_digest(layout)?;
        let magnetization_digest = magnetization_digest_f64be(magnetization)?;
        let execution_identity = format!("{}\0{}", execution_lane.as_str(), execution_engine);
        let carriers = [
            AcceptedPrimaryCarrier {
                carrier_id: Self::CARRIER_EXECUTION,
                canonical_bytes: execution_identity.as_bytes(),
            },
            AcceptedPrimaryCarrier {
                carrier_id: Self::CARRIER_LAYOUT,
                canonical_bytes: layout_sha256.as_bytes(),
            },
            AcceptedPrimaryCarrier {
                carrier_id: Self::CARRIER_MAGNETIZATION,
                canonical_bytes: magnetization_digest.as_bytes(),
            },
        ];
        let digests = accepted_state_digests(clock, &carriers)?;
        let snapshot = Self {
            schema_version: FDM_MULTILAYER_OBSERVATION_SNAPSHOT_SCHEMA.to_string(),
            state_role: "observation_only".to_string(),
            clock,
            execution_lane,
            execution_engine: execution_engine.to_string(),
            layout_sha256,
            magnetization_digest,
            clock_digest: digests.clock_digest,
            state_digest: digests.state_digest,
            primary_carrier_ids: vec![
                Self::CARRIER_EXECUTION.to_string(),
                Self::CARRIER_LAYOUT.to_string(),
                Self::CARRIER_MAGNETIZATION.to_string(),
            ],
        };
        snapshot.validate()?;
        Ok(snapshot)
    }

    pub fn validate(&self) -> Result<(), AcceptedStateIdentityError> {
        if self.schema_version != FDM_MULTILAYER_OBSERVATION_SNAPSHOT_SCHEMA
            || self.state_role != "observation_only"
            || !self.execution_lane.accepts_engine(&self.execution_engine)
        {
            return Err(AcceptedStateIdentityError::InvalidSnapshotSchema);
        }
        if !fullmag_quantities::is_canonical_sha256(&self.layout_sha256) {
            return Err(AcceptedStateIdentityError::InvalidDigest {
                field: "layout_sha256",
            });
        }
        if !fullmag_quantities::is_canonical_sha256(&self.magnetization_digest) {
            return Err(AcceptedStateIdentityError::InvalidDigest {
                field: "magnetization_digest",
            });
        }
        let expected_carriers = [
            Self::CARRIER_EXECUTION,
            Self::CARRIER_LAYOUT,
            Self::CARRIER_MAGNETIZATION,
        ];
        let actual_carriers = self
            .primary_carrier_ids
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        if actual_carriers.as_slice() != expected_carriers.as_slice() {
            return Err(AcceptedStateIdentityError::InvalidPrimaryCarrierSet);
        }
        let execution_identity = format!(
            "{}\0{}",
            self.execution_lane.as_str(),
            self.execution_engine
        );
        let digests = accepted_state_digests(
            self.clock,
            &[
                AcceptedPrimaryCarrier {
                    carrier_id: Self::CARRIER_EXECUTION,
                    canonical_bytes: execution_identity.as_bytes(),
                },
                AcceptedPrimaryCarrier {
                    carrier_id: Self::CARRIER_LAYOUT,
                    canonical_bytes: self.layout_sha256.as_bytes(),
                },
                AcceptedPrimaryCarrier {
                    carrier_id: Self::CARRIER_MAGNETIZATION,
                    canonical_bytes: self.magnetization_digest.as_bytes(),
                },
            ],
        )?;
        if digests.clock_digest != self.clock_digest {
            return Err(AcceptedStateIdentityError::InvalidDigest {
                field: "clock_digest",
            });
        }
        if digests.state_digest != self.state_digest {
            return Err(AcceptedStateIdentityError::InvalidDigest {
                field: "state_digest",
            });
        }
        Ok(())
    }

    pub fn validate_against(
        &self,
        layout: &serde_json::Value,
        magnetization: &[[f64; 3]],
    ) -> Result<(), AcceptedStateIdentityError> {
        self.validate()?;
        if observation_layout_digest(layout)? != self.layout_sha256
            || magnetization_digest_f64be(magnetization)? != self.magnetization_digest
        {
            return Err(AcceptedStateIdentityError::InvalidPrimaryCarrierSet);
        }
        Ok(())
    }
}

fn observation_layout_digest(
    layout: &serde_json::Value,
) -> Result<String, AcceptedStateIdentityError> {
    let bytes = serde_json::to_vec(layout)
        .map_err(|_| AcceptedStateIdentityError::InvalidPrimaryCarrierSet)?;
    Ok(format!("sha256:{:x}", Sha256::digest(&bytes)))
}

pub(crate) fn magnetization_digest_f64be(
    magnetization: &[[f64; 3]],
) -> Result<String, AcceptedStateIdentityError> {
    if magnetization.is_empty()
        || magnetization
            .iter()
            .flat_map(|value| value.iter())
            .any(|value| !value.is_finite())
    {
        return Err(AcceptedStateIdentityError::InvalidPrimaryCarrierSet);
    }
    let mut canonical = Vec::with_capacity(8 + magnetization.len() * 24);
    canonical.extend_from_slice(&(magnetization.len() as u64).to_be_bytes());
    for value in magnetization.iter().flat_map(|value| value.iter()) {
        canonical.extend_from_slice(&value.to_bits().to_be_bytes());
    }
    Ok(format!("sha256:{:x}", Sha256::digest(&canonical)))
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
            BackendPlanIR::AntennaFieldOnly(_) => None,
            BackendPlanIR::Fdm(_) => Some(ObservationLane::FdmRegular),
            BackendPlanIR::FdmMultilayer(_) => Some(ObservationLane::FdmMultilayer),
            BackendPlanIR::Fem(fem)
                if fem.domain_mesh_mode == FemDomainMeshModeIR::SharedDomainMeshWithAir =>
            {
                Some(ObservationLane::FemSharedAir)
            }
            BackendPlanIR::Fem(_) => Some(ObservationLane::FemMagneticOnly),
            BackendPlanIR::FemEigen(_)
            | BackendPlanIR::FemFrequencyResponse(_)
            | BackendPlanIR::AntennaExternalLeadInspection(_) => None,
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
        AcceptedStateIdentityError, AcceptedStateRef, FdmGpuAcceptedStateSnapshotV1,
        ObservationClock,
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

    #[test]
    fn fdm_gpu_accepted_state_snapshot_is_content_bound_and_self_validating() {
        let clock = ObservationClock {
            accepted_step: 9,
            time_seconds: 9.0e-14,
            dt_seconds: Some(1.0e-14),
        };
        let first = FdmGpuAcceptedStateSnapshotV1::from_final_magnetization(
            clock,
            &[[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
        )
        .expect("GPU accepted state snapshot");
        first.validate().expect("valid GPU snapshot");

        let changed = FdmGpuAcceptedStateSnapshotV1::from_final_magnetization(
            clock,
            &[[1.0, 0.0, 0.0], [0.0, 0.0, 1.0]],
        )
        .expect("changed GPU accepted state snapshot");
        assert_eq!(changed.clock_digest, first.clock_digest);
        assert_ne!(changed.magnetization_digest, first.magnetization_digest);
        assert_ne!(changed.state_digest, first.state_digest);

        let encoded = serde_json::to_vec(&first).expect("encode GPU snapshot");
        let decoded: FdmGpuAcceptedStateSnapshotV1 =
            serde_json::from_slice(&encoded).expect("decode GPU snapshot");
        assert_eq!(decoded, first);
        decoded.validate().expect("round-trip GPU snapshot");
    }

    #[test]
    fn fdm_gpu_accepted_state_snapshot_rejects_missing_or_nonfinite_magnetization() {
        let clock = ObservationClock {
            accepted_step: 1,
            time_seconds: 1.0e-14,
            dt_seconds: Some(1.0e-14),
        };
        assert_eq!(
            FdmGpuAcceptedStateSnapshotV1::from_final_magnetization(clock, &[]),
            Err(AcceptedStateIdentityError::InvalidPrimaryCarrierSet)
        );
        let nonfinite = [[f64::NAN, 0.0, 1.0]];
        assert_eq!(
            FdmGpuAcceptedStateSnapshotV1::from_final_magnetization(clock, &nonfinite),
            Err(AcceptedStateIdentityError::InvalidPrimaryCarrierSet)
        );
    }
}
