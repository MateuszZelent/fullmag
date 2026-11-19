//! Accepted FEM GPU state identity.
//!
//! This envelope is deliberately separate from the FEM CPU accepted state.
//! It consumes the application-decoded native snapshot, the typed native GPU
//! execution receipt, and the host allocation's already validated device UUID.
//! It never infers device identity from a plan or from a CPU-compatible field.

use fullmag_application::MagnetizationStateArtifact;
use fullmag_quantities::{
    accepted_state_digests, AcceptedPrimaryCarrier, AcceptedStateGeneration, AcceptedStateId,
    AcceptedStateRef, ObservationClock,
};
use fullmag_runner::{FemGpuExecutionReceipt, FemGpuMinimizerExecutionReceipt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const FEM_GPU_ACCEPTED_STATE_SNAPSHOT_SCHEMA: &str =
    "fullmag.fem.gpu.accepted-state-snapshot.v1";
pub const FEM_GPU_ACCEPTED_STATE_SNAPSHOT_FILE: &str =
    "solver/fem_gpu_accepted_state_snapshot.v1.json";

pub const FEM_GPU_NATIVE_LOCAL_NODE_VALUES_CARRIER: &str =
    "fem.gpu.native-local-node-values-f64le.v1";
pub const FEM_GPU_NATIVE_LOCAL_NODE_MAP_CARRIER: &str = "fem.gpu.native-local-node-map.v1";
pub const FEM_GPU_NATIVE_INDEXED_GEOMETRY_CARRIER: &str = "fem.gpu.native-indexed-geometry.v1";
pub const FEM_GPU_EXECUTION_RECEIPT_CARRIER: &str = "fem.gpu.execution-receipt.v1";

const FEM_GPU_PRIMARY_CARRIERS: [&str; 4] = [
    FEM_GPU_NATIVE_LOCAL_NODE_VALUES_CARRIER,
    FEM_GPU_NATIVE_LOCAL_NODE_MAP_CARRIER,
    FEM_GPU_NATIVE_INDEXED_GEOMETRY_CARRIER,
    FEM_GPU_EXECUTION_RECEIPT_CARRIER,
];
const FEM_GPU_EXECUTION_IDENTITY_FORMAT: &[u8] = b"fullmag.fem.gpu.execution-identity.v1";
const MAX_GPU_UUID_BYTES: usize = 256;

/// Accepted-state identity for one completed native FEM GPU endpoint.
///
/// The payload remains in the typed study artifact. This compact envelope
/// binds its native values, node map, indexed geometry, and the exact device
/// execution evidence without duplicating the state-sized payload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct FemGpuAcceptedStateSnapshotV1 {
    pub schema_version: String,
    pub clock: ObservationClock,
    pub values_sha256: String,
    pub native_node_map_sha256: String,
    pub native_indexed_geometry_sha256: String,
    pub gpu_uuid: String,
    pub gpu_execution_receipt_sha256: String,
    pub gpu_execution_identity_sha256: String,
    pub clock_digest: String,
    pub state_digest: String,
    pub primary_carrier_ids: Vec<String>,
}

impl FemGpuAcceptedStateSnapshotV1 {
    /// Build the accepted state only from a native GPU FEM field and a device
    /// UUID already validated by the host allocation boundary.
    pub(crate) fn from_magnetization_state(
        state: &MagnetizationStateArtifact,
        gpu_uuid: &str,
    ) -> Result<Self, String> {
        validate_gpu_uuid(gpu_uuid)?;
        if state.layout.get("backend").and_then(Value::as_str) != Some("fem")
            || state.layout.get("fe_order").and_then(Value::as_u64) != Some(1)
            || state
                .layout
                .get("n_nodes")
                .and_then(Value::as_u64)
                .and_then(|count| usize::try_from(count).ok())
                != Some(state.values.len())
        {
            return Err("accepted FEM GPU state requires H1/P1 nodal layout".into());
        }
        if fullmag_application::decode_magnetization_field_semantics(state)
            .map_err(|error| error.to_string())?
            .is_none()
        {
            return Err(
                "accepted FEM GPU state requires explicit H1/P1 field_semantics metadata".into(),
            );
        }

        let provenance = &state.provenance;
        if provenance.get("execution_engine").and_then(Value::as_str) != Some("fem_native_gpu")
            || provenance
                .get("resolved_execution_engine")
                .and_then(Value::as_str)
                .is_some_and(|engine| engine != "fem_native_gpu")
            || provenance.get("execution_mode").and_then(Value::as_str) != Some("strict")
            || provenance
                .get("resolved_fallback")
                .is_some_and(|fallback| !fallback.is_null())
            || provenance
                .get("lossy_fallback_used")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        {
            return Err(
                "accepted FEM GPU state has non-native, non-strict, or fallback provenance".into(),
            );
        }

        let gpu_execution_receipt_sha256 = if let Some(value) = provenance
            .get("fem_gpu_minimizer_execution_receipt")
            .filter(|value| !value.is_null())
        {
            let receipt: FemGpuMinimizerExecutionReceipt =
                serde_json::from_value(value.clone()).map_err(|error| error.to_string())?;
            if provenance.get("requested_energy_minimizer").and_then(Value::as_str)
                != Some(receipt.algorithm.as_str())
                || provenance.get("resolved_energy_minimizer").and_then(Value::as_str)
                    != Some(receipt.algorithm.as_str())
                || provenance.get("fem_gpu_execution_receipt").is_some_and(|value| !value.is_null())
            {
                return Err("accepted FEM GPU minimizer receipt differs from its algorithm provenance".into());
            }
            receipt.validate_strict_device()
                .map_err(|error| format!("native FEM GPU minimizer receipt rejected: {error}"))?;
            canonical_receipt_sha256(&receipt)?
        } else {
            if matches!(
                provenance.get("resolved_energy_minimizer").and_then(Value::as_str),
                Some("projected_gradient_bb" | "nonlinear_cg")
            ) {
                return Err("accepted FEM GPU minimizer has no native minimizer execution receipt".into());
            }
            let receipt: FemGpuExecutionReceipt = provenance
                .get("fem_gpu_execution_receipt")
                .ok_or_else(|| "accepted FEM GPU state has no native GPU execution receipt".to_string())
                .and_then(|value| {
                    serde_json::from_value(value.clone()).map_err(|error| error.to_string())
                })?;
            if receipt.requested != "strict_device"
                || receipt.precision != "double"
                || receipt.device_ordinal != 0
                || receipt.accepted_step_count == 0
            {
                return Err("accepted FEM GPU state requires strict_device double precision on device ordinal 0".into());
            }
            receipt.validate_strict_device()
                .map_err(|error| format!("native FEM GPU receipt rejected: {error}"))?;
            canonical_receipt_sha256(&receipt)?
        };

        let native_snapshot = state
            .native_state_snapshot
            .as_ref()
            .ok_or_else(|| "accepted FEM GPU state has no native snapshot receipt".to_string())?;
        let map = state
            .native_node_map
            .as_ref()
            .ok_or_else(|| "accepted FEM GPU state has no native node map".to_string())?;
        native_snapshot.validate_snapshot(
            state.step,
            state.time_s,
            state.solver_dt_s,
            &state.values,
        )?;
        native_snapshot.validate_node_map(Some(map))?;
        let native_node_map_sha256 = native_snapshot
            .native_node_map_sha256
            .as_deref()
            .ok_or_else(|| "native snapshot receipt has no node-map digest".to_string())?;
        let native_indexed_geometry_sha256 = native_snapshot
            .native_indexed_geometry_sha256
            .as_deref()
            .ok_or_else(|| "native snapshot receipt has no indexed-geometry digest".to_string())?;
        let dt_seconds = crate::accepted_fem_state::accepted_fem_clock_dt_seconds(state)?;
        if state.step == 0
            || !state.time_s.is_finite()
            || state.time_s < 0.0
            || !native_snapshot.snapshot_time_s.is_finite()
            || native_snapshot.snapshot_time_s < 0.0
            || !native_snapshot.snapshot_solver_dt_s.is_finite()
            || !fullmag_quantities::is_canonical_sha256(&native_snapshot.values_sha256)
            || !fullmag_quantities::is_canonical_sha256(native_node_map_sha256)
            || !fullmag_quantities::is_canonical_sha256(native_indexed_geometry_sha256)
        {
            return Err(
                "accepted FEM GPU final state requires a valid native time and canonical native digests".into(),
            );
        }
        if map.content_sha256()? != native_node_map_sha256 {
            return Err("native node map differs from its snapshot receipt".into());
        }

        let gpu_execution_identity =
            execution_identity_carrier_bytes(&gpu_execution_receipt_sha256, gpu_uuid);
        let gpu_execution_identity_sha256 = sha256_bytes(&gpu_execution_identity);
        let clock = ObservationClock {
            accepted_step: native_snapshot.snapshot_step,
            time_seconds: native_snapshot.snapshot_time_s,
            dt_seconds,
        };
        let digests = accepted_state_digests(
            clock,
            &[
                AcceptedPrimaryCarrier {
                    carrier_id: FEM_GPU_NATIVE_LOCAL_NODE_VALUES_CARRIER,
                    canonical_bytes: native_snapshot.values_sha256.as_bytes(),
                },
                AcceptedPrimaryCarrier {
                    carrier_id: FEM_GPU_NATIVE_LOCAL_NODE_MAP_CARRIER,
                    canonical_bytes: native_node_map_sha256.as_bytes(),
                },
                AcceptedPrimaryCarrier {
                    carrier_id: FEM_GPU_NATIVE_INDEXED_GEOMETRY_CARRIER,
                    canonical_bytes: native_indexed_geometry_sha256.as_bytes(),
                },
                AcceptedPrimaryCarrier {
                    carrier_id: FEM_GPU_EXECUTION_RECEIPT_CARRIER,
                    canonical_bytes: &gpu_execution_identity,
                },
            ],
        )
        .map_err(|error| error.to_string())?;
        let snapshot = Self {
            schema_version: FEM_GPU_ACCEPTED_STATE_SNAPSHOT_SCHEMA.into(),
            clock,
            values_sha256: native_snapshot.values_sha256.clone(),
            native_node_map_sha256: native_node_map_sha256.into(),
            native_indexed_geometry_sha256: native_indexed_geometry_sha256.into(),
            gpu_uuid: gpu_uuid.into(),
            gpu_execution_receipt_sha256,
            gpu_execution_identity_sha256,
            clock_digest: digests.clock_digest,
            state_digest: digests.state_digest,
            primary_carrier_ids: FEM_GPU_PRIMARY_CARRIERS
                .iter()
                .map(|carrier| (*carrier).to_owned())
                .collect(),
        };
        snapshot.validate()?;
        Ok(snapshot)
    }

    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.schema_version != FEM_GPU_ACCEPTED_STATE_SNAPSHOT_SCHEMA
            || !fullmag_quantities::is_canonical_sha256(&self.values_sha256)
            || !fullmag_quantities::is_canonical_sha256(&self.native_node_map_sha256)
            || !fullmag_quantities::is_canonical_sha256(&self.native_indexed_geometry_sha256)
            || !fullmag_quantities::is_canonical_sha256(&self.gpu_execution_receipt_sha256)
            || !fullmag_quantities::is_canonical_sha256(&self.gpu_execution_identity_sha256)
            || self.primary_carrier_ids
                != FEM_GPU_PRIMARY_CARRIERS
                    .iter()
                    .map(|carrier| (*carrier).to_owned())
                    .collect::<Vec<_>>()
        {
            return Err("invalid accepted FEM GPU state snapshot identity".into());
        }
        validate_gpu_uuid(&self.gpu_uuid)?;
        let execution_identity =
            execution_identity_carrier_bytes(&self.gpu_execution_receipt_sha256, &self.gpu_uuid);
        if sha256_bytes(&execution_identity) != self.gpu_execution_identity_sha256 {
            return Err(
                "accepted FEM GPU execution identity digest does not match its receipt or device UUID".into(),
            );
        }
        let digests = accepted_state_digests(
            self.clock,
            &[
                AcceptedPrimaryCarrier {
                    carrier_id: FEM_GPU_NATIVE_LOCAL_NODE_VALUES_CARRIER,
                    canonical_bytes: self.values_sha256.as_bytes(),
                },
                AcceptedPrimaryCarrier {
                    carrier_id: FEM_GPU_NATIVE_LOCAL_NODE_MAP_CARRIER,
                    canonical_bytes: self.native_node_map_sha256.as_bytes(),
                },
                AcceptedPrimaryCarrier {
                    carrier_id: FEM_GPU_NATIVE_INDEXED_GEOMETRY_CARRIER,
                    canonical_bytes: self.native_indexed_geometry_sha256.as_bytes(),
                },
                AcceptedPrimaryCarrier {
                    carrier_id: FEM_GPU_EXECUTION_RECEIPT_CARRIER,
                    canonical_bytes: &execution_identity,
                },
            ],
        )
        .map_err(|error| error.to_string())?;
        if self.clock_digest != digests.clock_digest || self.state_digest != digests.state_digest {
            return Err("accepted FEM GPU state digest does not match its carriers".into());
        }
        Ok(())
    }

    pub(crate) fn to_accepted_state_ref(
        &self,
        run_id: &str,
        stage_id: &str,
        runtime_epoch: u64,
        domain_digest: &str,
        plan_digest: &str,
    ) -> Result<AcceptedStateRef, String> {
        self.validate()?;
        if domain_digest.is_empty() || plan_digest.is_empty() {
            return Err("accepted FEM GPU state requires domain and plan digests".into());
        }
        let execution_identity =
            execution_identity_carrier_bytes(&self.gpu_execution_receipt_sha256, &self.gpu_uuid);
        let identity = AcceptedStateId::from_canonical_state(
            run_id.to_owned(),
            Some(stage_id.to_owned()),
            self.clock,
            &[
                AcceptedPrimaryCarrier {
                    carrier_id: FEM_GPU_NATIVE_LOCAL_NODE_VALUES_CARRIER,
                    canonical_bytes: self.values_sha256.as_bytes(),
                },
                AcceptedPrimaryCarrier {
                    carrier_id: FEM_GPU_NATIVE_LOCAL_NODE_MAP_CARRIER,
                    canonical_bytes: self.native_node_map_sha256.as_bytes(),
                },
                AcceptedPrimaryCarrier {
                    carrier_id: FEM_GPU_NATIVE_INDEXED_GEOMETRY_CARRIER,
                    canonical_bytes: self.native_indexed_geometry_sha256.as_bytes(),
                },
                AcceptedPrimaryCarrier {
                    carrier_id: FEM_GPU_EXECUTION_RECEIPT_CARRIER,
                    canonical_bytes: &execution_identity,
                },
            ],
            domain_digest.to_owned(),
            plan_digest.to_owned(),
        )
        .map_err(|error| error.to_string())?;
        Ok(AcceptedStateRef {
            id: identity,
            generation: AcceptedStateGeneration {
                runtime_epoch,
                accepted_revision: self.clock.accepted_step,
            },
        })
    }
}

fn validate_gpu_uuid(gpu_uuid: &str) -> Result<(), String> {
    if gpu_uuid.is_empty()
        || gpu_uuid.len() > MAX_GPU_UUID_BYTES
        || gpu_uuid
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace())
    {
        return Err("accepted FEM GPU state requires a canonical non-empty device UUID".into());
    }
    Ok(())
}

fn canonical_receipt_sha256(receipt: &impl Serialize) -> Result<String, String> {
    let value = serde_json::to_value(receipt).map_err(|error| error.to_string())?;
    Ok(format!(
        "sha256:{}",
        fullmag_session::canonical_json_sha256(&value)
    ))
}

fn execution_identity_carrier_bytes(receipt_sha256: &str, gpu_uuid: &str) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(
        FEM_GPU_EXECUTION_IDENTITY_FORMAT.len() + receipt_sha256.len() + gpu_uuid.len() + 24,
    );
    push_length_prefixed(&mut bytes, FEM_GPU_EXECUTION_IDENTITY_FORMAT);
    push_length_prefixed(&mut bytes, receipt_sha256.as_bytes());
    push_length_prefixed(&mut bytes, gpu_uuid.as_bytes());
    bytes
}

fn push_length_prefixed(bytes: &mut Vec<u8>, value: &[u8]) {
    bytes.extend_from_slice(&(value.len() as u64).to_be_bytes());
    bytes.extend_from_slice(value);
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("sha256:{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_runner::FemGpuExecutionClass;
    use serde_json::json;

    fn digest(ch: char) -> String {
        format!("sha256:{}", ch.to_string().repeat(64))
    }

    fn strict_gpu_receipt() -> FemGpuExecutionReceipt {
        FemGpuExecutionReceipt {
            requested: "strict_device".into(),
            resolved: "device_resident".into(),
            executed: "cuda_fem".into(),
            execution_class: FemGpuExecutionClass::DeviceResident,
            device_ordinal: 0,
            precision: "double".into(),
            integrator: "heun".into(),
            required_operator_mask: 0x3ff,
            resolved_device_operator_mask: 0x3ff,
            resolved_host_operator_mask: 0,
            resolved_unknown_operator_mask: 0,
            executed_device_operator_mask: 0x3ff,
            executed_host_operator_mask: 0,
            executed_unknown_operator_mask: 0,
            fallback_count: 0,
            accepted_step_count: 4,
            rejected_attempt_count: 0,
            failed_attempt_count: 0,
            hot_loop_compute_h2d_bytes: 0,
            hot_loop_compute_d2h_bytes: 0,
            hot_loop_compute_host_sync_count: 0,
            accounting_valid: true,
        }
    }

    fn gpu_artifact_fixture() -> MagnetizationStateArtifact {
        use fullmag_quantities::fem_local_node_map::{
            FemLocalNodeIndexMap, FEM_LOCAL_NODE_MAP_SCHEMA,
        };
        use fullmag_quantities::fem_native_indexed_geometry::FemNativeIndexedGeometryHasher;
        use fullmag_quantities::fem_state_field::FemP1MagnetizationFieldSemantics;
        use fullmag_quantities::fem_state_snapshot_receipt::FemLocalNodeSnapshotReceipt;
        use fullmag_quantities::{
            FemMaterialFieldLocation, FemRepresentationReceipt, FemStateRepresentation,
        };

        let values = vec![
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [1.0, 1.0, 0.0],
        ];
        let topology_fingerprint = format!("sha256:{}", "c".repeat(64));
        let semantics = FemP1MagnetizationFieldSemantics::new(
            &topology_fingerprint,
            values.len(),
            vec![true; values.len()],
        )
        .expect("canonical FEM P1 semantics");
        let mut layout = json!({
            "backend": "fem",
            "fe_order": 1,
            "n_nodes": values.len(),
            "n_elements": 1,
            "topology_fingerprint": topology_fingerprint,
        });
        layout["field_semantics"] = serde_json::to_value(semantics).unwrap();

        let map = FemLocalNodeIndexMap {
            schema_version: FEM_LOCAL_NODE_MAP_SCHEMA.into(),
            local_node_count: values.len() as u64,
            mfem_local_dof_count: values.len() as u64,
            mfem_true_dof_count: values.len() as u64,
            core_periodic_class_count: values.len() as u64,
            core_periodic_map_revision: 0,
            canonical_node_to_mfem_local_dof: vec![0, 1, 2, 3],
            local_node_to_core_class: vec![0, 1, 2, 3],
            core_class_representatives: vec![0, 1, 2, 3],
        };
        map.validate().expect("canonical native node map");

        let representation = FemRepresentationReceipt {
            schema_version: 1,
            state_space: FemStateRepresentation::LocalNodeAos,
            ms_location: FemMaterialFieldLocation::Scalar,
            a_location: FemMaterialFieldLocation::Scalar,
            local_node_count: values.len() as u64,
            true_node_count: values.len() as u64,
            periodic_map_revision: 0,
            representation_copy_count: 0,
            gather_scatter_bytes: 0,
            invalid_space_assertion_count: 0,
            hot_loop_representation_copy_count: 0,
            hot_loop_gather_scatter_bytes: 0,
        };
        let mut native_snapshot =
            FemLocalNodeSnapshotReceipt::capture(4, 4.0e-12, 1.0e-12, &values, representation)
                .expect("native snapshot receipt");
        native_snapshot.native_node_map_sha256 = Some(map.content_sha256().unwrap());

        let mut geometry = FemNativeIndexedGeometryHasher::new(4, 1).unwrap();
        geometry
            .append_nodes(&[
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ])
            .unwrap();
        geometry
            .append_cells(&[[1, 0, 1, 2, 3, 0, 0, 0, 0]])
            .unwrap();
        native_snapshot.native_indexed_geometry_sha256 = Some(geometry.finish().unwrap());

        MagnetizationStateArtifact {
            step: 4,
            time_s: 4.0e-12,
            solver_dt_s: 1.0e-12,
            space_fingerprint: fullmag_application::study_state_layout_sha256(&layout).unwrap(),
            layout,
            provenance: json!({
                "execution_engine": "fem_native_gpu",
                "execution_mode": "strict",
                "fem_gpu_execution_receipt": serde_json::to_value(strict_gpu_receipt()).unwrap(),
            }),
            values,
            native_state_snapshot: Some(native_snapshot),
            native_node_map: Some(map),
        }
    }

    #[test]
    fn constructor_accepts_canonical_native_gpu_artifact_and_binds_clock() {
        let state = gpu_artifact_fixture();
        let snapshot =
            FemGpuAcceptedStateSnapshotV1::from_magnetization_state(&state, "GPU-test-0")
                .expect("native GPU artifact is accepted");
        assert_eq!(snapshot.clock.accepted_step, state.step);
        assert_eq!(
            snapshot.clock.time_seconds.to_bits(),
            state.time_s.to_bits()
        );
        assert_eq!(snapshot.clock.dt_seconds, Some(state.solver_dt_s));
        assert!(snapshot
            .to_accepted_state_ref("run-1", "stage-1", 9, &digest('e'), &digest('f'))
            .is_ok());
    }

    #[test]
    fn constructor_rejects_cpu_hybrid_fallback_missing_proofs_and_unknown_receipt_fields() {
        let mut cpu = gpu_artifact_fixture();
        cpu.provenance["execution_engine"] = json!("fem_cpu_native");
        assert!(
            FemGpuAcceptedStateSnapshotV1::from_magnetization_state(&cpu, "GPU-test-0").is_err()
        );

        let mut hybrid = gpu_artifact_fixture();
        let hybrid_receipt = hybrid.provenance["fem_gpu_execution_receipt"]
            .as_object_mut()
            .unwrap();
        hybrid_receipt.insert("requested".into(), json!("hybrid"));
        hybrid_receipt.insert("resolved".into(), json!("hybrid_cpu_poisson"));
        hybrid_receipt.insert("executed".into(), json!("cuda_fem_hybrid_cpu_poisson"));
        hybrid_receipt.insert("execution_class".into(), json!("hybrid_cpu_poisson"));
        assert!(
            FemGpuAcceptedStateSnapshotV1::from_magnetization_state(&hybrid, "GPU-test-0").is_err()
        );

        let mut fallback = gpu_artifact_fixture();
        fallback.provenance["resolved_fallback"] = json!({"occurred": true});
        assert!(
            FemGpuAcceptedStateSnapshotV1::from_magnetization_state(&fallback, "GPU-test-0")
                .is_err()
        );

        let mut missing_map = gpu_artifact_fixture();
        missing_map.native_node_map = None;
        assert!(FemGpuAcceptedStateSnapshotV1::from_magnetization_state(
            &missing_map,
            "GPU-test-0"
        )
        .is_err());

        let mut missing_geometry = gpu_artifact_fixture();
        missing_geometry
            .native_state_snapshot
            .as_mut()
            .unwrap()
            .native_indexed_geometry_sha256 = None;
        assert!(FemGpuAcceptedStateSnapshotV1::from_magnetization_state(
            &missing_geometry,
            "GPU-test-0"
        )
        .is_err());

        let mut unknown_receipt = gpu_artifact_fixture();
        unknown_receipt.provenance["fem_gpu_execution_receipt"]["future_field"] = json!(true);
        assert!(FemGpuAcceptedStateSnapshotV1::from_magnetization_state(
            &unknown_receipt,
            "GPU-test-0"
        )
        .is_err());
    }

    fn snapshot_fixture() -> FemGpuAcceptedStateSnapshotV1 {
        let clock = ObservationClock {
            accepted_step: 7,
            time_seconds: 7.0e-12,
            dt_seconds: Some(1.0e-12),
        };
        let gpu_uuid = "GPU-test-0";
        let receipt_sha256 = digest('a');
        let values_sha256 = digest('b');
        let node_map_sha256 = digest('c');
        let geometry_sha256 = digest('d');
        let execution_identity = execution_identity_carrier_bytes(&receipt_sha256, gpu_uuid);
        let digests = accepted_state_digests(
            clock,
            &[
                AcceptedPrimaryCarrier {
                    carrier_id: FEM_GPU_NATIVE_LOCAL_NODE_VALUES_CARRIER,
                    canonical_bytes: values_sha256.as_bytes(),
                },
                AcceptedPrimaryCarrier {
                    carrier_id: FEM_GPU_NATIVE_LOCAL_NODE_MAP_CARRIER,
                    canonical_bytes: node_map_sha256.as_bytes(),
                },
                AcceptedPrimaryCarrier {
                    carrier_id: FEM_GPU_NATIVE_INDEXED_GEOMETRY_CARRIER,
                    canonical_bytes: geometry_sha256.as_bytes(),
                },
                AcceptedPrimaryCarrier {
                    carrier_id: FEM_GPU_EXECUTION_RECEIPT_CARRIER,
                    canonical_bytes: &execution_identity,
                },
            ],
        )
        .expect("fixture digests");
        FemGpuAcceptedStateSnapshotV1 {
            schema_version: FEM_GPU_ACCEPTED_STATE_SNAPSHOT_SCHEMA.into(),
            clock,
            values_sha256,
            native_node_map_sha256: node_map_sha256,
            native_indexed_geometry_sha256: geometry_sha256,
            gpu_uuid: gpu_uuid.into(),
            gpu_execution_receipt_sha256: receipt_sha256,
            gpu_execution_identity_sha256: sha256_bytes(&execution_identity),
            clock_digest: digests.clock_digest,
            state_digest: digests.state_digest,
            primary_carrier_ids: FEM_GPU_PRIMARY_CARRIERS
                .iter()
                .map(|carrier| (*carrier).to_owned())
                .collect(),
        }
    }

    #[test]
    fn gpu_snapshot_round_trip_binds_uuid_and_receipt_identity() {
        let snapshot = snapshot_fixture();
        snapshot.validate().expect("valid GPU snapshot");
        let wire = serde_json::to_value(&snapshot).expect("serialize snapshot");
        assert_eq!(
            serde_json::from_value::<FemGpuAcceptedStateSnapshotV1>(wire).unwrap(),
            snapshot
        );

        let mut changed_uuid = snapshot.clone();
        changed_uuid.gpu_uuid = "GPU-other-0".into();
        assert!(changed_uuid.validate().is_err());

        let mut changed_receipt = snapshot.clone();
        changed_receipt.gpu_execution_receipt_sha256 = digest('e');
        assert!(changed_receipt.validate().is_err());
    }

    #[test]
    fn gpu_snapshot_rejects_unknown_fields_and_wrong_carrier_set() {
        let snapshot = snapshot_fixture();
        let mut wire = serde_json::to_value(&snapshot).expect("serialize snapshot");
        wire["future_field"] = json!(true);
        assert!(serde_json::from_value::<FemGpuAcceptedStateSnapshotV1>(wire).is_err());

        let mut wrong = snapshot;
        wrong.primary_carrier_ids.swap(0, 1);
        assert!(wrong.validate().is_err());
    }
}
