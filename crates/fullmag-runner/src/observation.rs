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
