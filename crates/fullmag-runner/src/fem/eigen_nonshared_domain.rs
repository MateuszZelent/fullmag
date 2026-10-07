//! Private provenance transport for the non-shared Floquet matrix pencil.
//!
//! This module deliberately does not reuse `SharedDomainLinearizationState`.
//! The non-shared path owns a different operator (a runner-provided matrix
//! pencil) and therefore needs a separate source/identity record.

use super::eigen_digest::shared_domain_content_digest;
use super::eigen_equilibrium_contract::{
    AcceptedFemRelaxStageHandoff, LoadedEquilibriumArtifact,
};
use super::eigen_policy::{
    native_modal_damping_policy, native_modal_equilibrium_source_kind,
    native_modal_k_vector, native_modal_spin_wave_bc_kind, resolved_demag_realization,
};
use crate::artifacts::build_identity_json;
use crate::types::RunError;
use fullmag_engine::fem::MeshTopology;
use fullmag_engine::{EffectiveFieldObservables, Vector3};
use fullmag_ir::{FemEigenPlanIR, KSamplingIR, SpinWaveBoundaryKindIR};
use nalgebra::DMatrix;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub(super) const NONSHARED_FLOQUET_OPERATOR_IDENTITY_SCHEMA: &str =
    "nonshared_floquet_operator_identity.v1";
const NONSHARED_FLOQUET_SOURCE_STATE_SCHEMA: &str = "nonshared_floquet_source_state.v1";
const NONSHARED_FLOQUET_IDENTITY_PREIMAGE_SCHEMA: &str =
    "nonshared_floquet_operator_identity_preimage.v1";
const NONSHARED_FLOQUET_EXACT_REPLAY_REFS_SCHEMA: &str =
    "nonshared_floquet_exact_replay_refs.v1";
const NONSHARED_FLOQUET_SOURCE_STATE_PREIMAGE_SCHEMA: &str =
    "nonshared_floquet_source_state_preimage.v1";
const NONSHARED_FLOQUET_OPERATOR_INPUT_PREIMAGE_SCHEMA: &str =
    "nonshared_floquet_operator_input_preimage.v1";
const NONSHARED_FLOQUET_MATRIX_PENCIL_PREIMAGE_SCHEMA: &str =
    "nonshared_floquet_matrix_pencil_preimage.v1";
const NONSHARED_FLOQUET_MESH_PAYLOAD_PREIMAGE_SCHEMA: &str =
    "nonshared_floquet_mesh_payload.v1";
const NONSHARED_FLOQUET_PHYSICAL_SOURCE_PREIMAGE_SCHEMA: &str =
    "nonshared_floquet_physical_source_preimage.v1";
const NONSHARED_FLOQUET_NATIVE_INPUT_DIAGNOSTICS_SCHEMA: &str =
    "nonshared_floquet_native_input_diagnostics.v1";
const NONSHARED_FLOQUET_NATIVE_INPUT_DIAGNOSTICS_PREIMAGE_SCHEMA: &str =
    "nonshared_floquet_native_input_diagnostics_preimage.v1";
const NONSHARED_FLOQUET_NATIVE_INPUT_DIAGNOSTICS_REFS_SCHEMA: &str =
    "nonshared_floquet_native_input_diagnostics_refs.v1";
const NONSHARED_FLOQUET_NATIVE_INPUT_DIAGNOSTICS_DIGEST_FIELD: &str =
    "nonshared_floquet_native_input_diagnostics_sha256";

#[derive(Debug, Clone)]
pub(super) struct NonSharedFloquetSidecar {
    pub(super) relative_path: String,
    pub(super) bytes: Vec<u8>,
}

#[derive(Debug, Clone)]
pub(super) struct NonSharedFloquetProvenance {
    pub(super) source_state: Value,
    pub(super) source_state_sha256: String,
    pub(super) operator_identity: Value,
    pub(super) operator_identity_sha256: String,
    pub(super) operator_identity_preimage_json: Vec<u8>,
    pub(super) matrix_pencil_sha256: String,
    pub(super) operator_diagnostics_sha256: String,
    pub(super) operator_diagnostics_schema: String,
    pub(super) source_replay_qualified: bool,
    pub(super) mesh_payload_kind: String,
    pub(super) mesh_payload_sha256: String,
    pub(super) mesh_payload_path: String,
    pub(super) mesh_payload_json: Vec<u8>,
    pub(super) exact_replay_refs: Value,
    pub(super) exact_replay_sidecars: Vec<NonSharedFloquetSidecar>,
    pub(super) sidecars: Vec<NonSharedFloquetSidecar>,
    pub(super) native_input_diagnostics_refs: Option<Value>,
}

impl NonSharedFloquetProvenance {
    /// Fields safe to append to the JSON string passed through the existing
    /// native diagnostics boundary.  Large fields (m0 and exact payloads) are
    /// kept in artifacts, not copied into the C ABI input string.
    pub(super) fn native_input_diagnostics(&self) -> Value {
        json!({
            "nonshared_floquet_provenance_schema": NONSHARED_FLOQUET_OPERATOR_IDENTITY_SCHEMA,
            "nonshared_floquet_provenance_status": if self.source_replay_qualified {
                "verified_source_handoff"
            } else {
                "NOT_VERIFIED"
            },
            "nonshared_floquet_operator_identity_sha256": self.operator_identity_sha256,
            "nonshared_floquet_source_state_sha256": self.source_state_sha256,
            "nonshared_floquet_matrix_pencil_sha256": self.matrix_pencil_sha256,
            "nonshared_floquet_mesh_payload_sha256": self.mesh_payload_sha256,
            "nonshared_floquet_mesh_payload_kind": self.mesh_payload_kind,
            "nonshared_floquet_source_mesh_node_count": self.operator_identity["source_mesh_node_count"],
            "nonshared_floquet_source_field_origins_verified": self.operator_identity[
                "source_field_origins_verified"
            ],
            "nonshared_floquet_source_field_lengths_verified": self.operator_identity[
                "source_field_lengths_verified"
            ],
            "nonshared_floquet_exact_replay_refs": self.exact_replay_refs.clone(),
            "nonshared_floquet_source_mesh_payload_status": self.operator_identity[
                "source_replay_status"
            ],
            "nonshared_floquet_operator_identity": {
                "schema_version": self.operator_identity["schema_version"],
                "content_sha256": self.operator_identity["content_sha256"],
                "sample_index": self.operator_identity["sample_index"],
                "operator_input_signature_sha256": self.operator_identity["operator_input_signature_sha256"],
                "source_state_sha256": self.operator_identity["source_state_sha256"],
                "matrix_pencil_sha256": self.operator_identity["matrix_pencil_sha256"],
                "source_replay_qualified": self.operator_replay_qualified(),
            },
        })
    }

    pub(super) fn artifact_diagnostics(&self) -> Value {
        json!({
            "nonshared_floquet_provenance_schema": NONSHARED_FLOQUET_OPERATOR_IDENTITY_SCHEMA,
            "nonshared_floquet_provenance_status": if self.source_replay_qualified {
                "verified_source_handoff"
            } else {
                "NOT_VERIFIED"
            },
            "nonshared_floquet_operator_identity_sha256": self.operator_identity_sha256,
            "nonshared_floquet_source_state_sha256": self.source_state_sha256,
            "nonshared_floquet_matrix_pencil_sha256": self.matrix_pencil_sha256,
            "nonshared_floquet_mesh_payload_sha256": self.mesh_payload_sha256,
            "nonshared_floquet_mesh_payload_kind": self.mesh_payload_kind,
            "nonshared_floquet_source_mesh_node_count": self.operator_identity["source_mesh_node_count"],
            "nonshared_floquet_source_field_origins_verified": self.operator_identity[
                "source_field_origins_verified"
            ],
            "nonshared_floquet_source_field_lengths_verified": self.operator_identity[
                "source_field_lengths_verified"
            ],
            "nonshared_floquet_exact_replay_refs": self.exact_replay_refs.clone(),
            "nonshared_floquet_source_mesh_payload_status": self.operator_identity[
                "source_replay_status"
            ],
            "nonshared_floquet_source_replay_qualified": self.source_replay_qualified,
            "nonshared_floquet_native_input_diagnostics_status": if self.native_input_diagnostics_refs.is_some() {
                "published_exact"
            } else {
                "NOT_VERIFIED"
            },
            "nonshared_floquet_native_input_diagnostics_exact_refs": self
                .native_input_diagnostics_refs
                .clone()
                .unwrap_or(Value::Null),
        })
    }

    /// Publish the exact JSON bytes sent through the native C ABI.
    ///
    /// The historical `operator_diagnostics_sha256` is intentionally left
    /// untouched: it names the base diagnostics object used while building
    /// the operator-input digest.  This additive sidecar binds the final
    /// post-provenance JSON without putting a self-reference into
    /// `exact_replay_refs`, which is itself part of that C ABI payload.
    pub(super) fn finalize_native_input_diagnostics(
        &mut self,
        operator_diagnostics: &mut Value,
        sample_index: usize,
    ) -> Result<String, RunError> {
        if !operator_diagnostics.is_object() {
            return Err(RunError {
                message: "nonshared_floquet_native_input_diagnostics_requires_json_object"
                    .to_string(),
            });
        }
        let final_path = format!(
            "eigen/metadata/sample_{sample_index:04}/nonshared_source/native_input_operator_diagnostics.v1.json"
        );
        let preimage_path = format!(
            "eigen/metadata/sample_{sample_index:04}/nonshared_source/native_input_operator_diagnostics_preimage.v1.json"
        );
        if self
            .sidecars
            .iter()
            .any(|sidecar| sidecar.relative_path == final_path || sidecar.relative_path == preimage_path)
        {
            return Err(RunError {
                message: "nonshared_floquet_native_input_diagnostics_sidecar_already_published"
                    .to_string(),
            });
        }
        {
            let object = operator_diagnostics
                .as_object_mut()
                .ok_or_else(|| RunError {
                    message: "nonshared_floquet_native_input_diagnostics_requires_json_object"
                        .to_string(),
                })?;
            if object.contains_key(NONSHARED_FLOQUET_NATIVE_INPUT_DIAGNOSTICS_DIGEST_FIELD) {
                return Err(RunError {
                    message: "nonshared_floquet_native_input_diagnostics_digest_already_present"
                        .to_string(),
                });
            }
            object.insert(
                "nonshared_floquet_native_input_diagnostics_schema".to_string(),
                json!(NONSHARED_FLOQUET_NATIVE_INPUT_DIAGNOSTICS_SCHEMA),
            );
            object.insert(
                "nonshared_floquet_native_input_diagnostics_sample_index".to_string(),
                json!(sample_index),
            );
            object.insert(
                "nonshared_floquet_native_input_diagnostics_path".to_string(),
                json!(&final_path),
            );
            object.insert(
                "nonshared_floquet_native_input_diagnostics_preimage_path".to_string(),
                json!(&preimage_path),
            );
            object.insert(
                "operator_diagnostics_sha256".to_string(),
                json!(&self.operator_diagnostics_sha256),
            );
            object.insert(
                "operator_diagnostics_schema".to_string(),
                json!(&self.operator_diagnostics_schema),
            );
            object.insert(
                NONSHARED_FLOQUET_NATIVE_INPUT_DIAGNOSTICS_DIGEST_FIELD.to_string(),
                json!(""),
            );
        }

        let preimage_bytes = serde_json::to_vec(&*operator_diagnostics).map_err(|error| RunError {
            message: format!(
                "nonshared_floquet_native_input_diagnostics_preimage_serialization_failed: {error}"
            ),
        })?;
        let preimage_sha256 = raw_sha256(&preimage_bytes);
        operator_diagnostics
            .as_object_mut()
            .ok_or_else(|| RunError {
                message: "nonshared_floquet_native_input_diagnostics_requires_json_object"
                    .to_string(),
            })?
            .insert(
                NONSHARED_FLOQUET_NATIVE_INPUT_DIAGNOSTICS_DIGEST_FIELD.to_string(),
                json!(&preimage_sha256),
            );
        let final_bytes = serde_json::to_vec(&*operator_diagnostics).map_err(|error| RunError {
            message: format!(
                "nonshared_floquet_native_input_diagnostics_serialization_failed: {error}"
            ),
        })?;
        let final_json = String::from_utf8(final_bytes.clone()).map_err(|error| RunError {
            message: format!(
                "nonshared_floquet_native_input_diagnostics_not_utf8: {error}"
            ),
        })?;
        let final_sha256 = raw_sha256(&final_bytes);

        self.native_input_diagnostics_refs = Some(json!({
            "schema_version": NONSHARED_FLOQUET_NATIVE_INPUT_DIAGNOSTICS_REFS_SCHEMA,
            "sample_index": sample_index,
            "payload": exact_preimage_ref_with_sample(
                NONSHARED_FLOQUET_NATIVE_INPUT_DIAGNOSTICS_SCHEMA,
                &final_path,
                &final_bytes,
                Some(&final_sha256),
                sample_index,
            ),
            "preimage": exact_preimage_ref_with_sample(
                NONSHARED_FLOQUET_NATIVE_INPUT_DIAGNOSTICS_PREIMAGE_SCHEMA,
                &preimage_path,
                &preimage_bytes,
                Some(&preimage_sha256),
                sample_index,
            ),
        }));
        self.sidecars.extend([
            NonSharedFloquetSidecar {
                relative_path: final_path,
                bytes: final_bytes,
            },
            NonSharedFloquetSidecar {
                relative_path: preimage_path,
                bytes: preimage_bytes,
            },
        ]);
        Ok(final_json)
    }

    fn operator_replay_qualified(&self) -> bool {
        self.operator_identity
            .get("source_replay_qualified")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }

    pub(super) fn identity_sidecars(
        &self,
        sample_index: usize,
    ) -> Result<Vec<NonSharedFloquetSidecar>, RunError> {
        let identity_bytes = serde_json::to_vec_pretty(&self.operator_identity).map_err(|error| {
            RunError {
                message: format!("nonshared_floquet_identity_serialization_failed: {error}"),
            }
        })?;
        let preimage_string = String::from_utf8(self.operator_identity_preimage_json.clone())
            .map_err(|error| RunError {
                message: format!("nonshared_floquet_identity_preimage_not_utf8: {error}"),
            })?;
        let preimage_digest = raw_sha256(&self.operator_identity_preimage_json);
        let preimage = json!({
            "schema_version": NONSHARED_FLOQUET_IDENTITY_PREIMAGE_SCHEMA,
            "identity_schema": NONSHARED_FLOQUET_OPERATOR_IDENTITY_SCHEMA,
            "identity_preimage_json": preimage_string,
            "identity_preimage_sha256": preimage_digest,
            "identity_content_sha256": self.operator_identity_sha256,
        });
        let preimage_bytes = serde_json::to_vec_pretty(&preimage).map_err(|error| RunError {
            message: format!("nonshared_floquet_identity_preimage_serialization_failed: {error}"),
        })?;
        Ok([
            NonSharedFloquetSidecar {
                relative_path: format!(
                    "eigen/metadata/sample_{sample_index:04}/nonshared_floquet_operator_identity.v1.json"
                ),
                bytes: identity_bytes,
            },
            NonSharedFloquetSidecar {
                relative_path: format!(
                    "eigen/metadata/sample_{sample_index:04}/nonshared_floquet_operator_identity_preimage.v1.json"
                ),
                bytes: preimage_bytes,
            },
            NonSharedFloquetSidecar {
                relative_path: format!(
                    "eigen/metadata/sample_{sample_index:04}/nonshared_floquet_source_state.v1.json"
                ),
                bytes: serde_json::to_vec_pretty(&self.source_state).map_err(|error| RunError {
                    message: format!("nonshared_floquet_source_state_serialization_failed: {error}"),
                })?,
            },
            NonSharedFloquetSidecar {
                relative_path: self.mesh_payload_path.clone(),
                bytes: self.mesh_payload_json.clone(),
            },
        ]
        .into_iter()
        .chain(self.exact_replay_sidecars.clone())
        .collect())
    }
}

/// Build a private source/identity record for the runner-provided non-shared
/// operator.  This is intentionally additive: the native ABI still receives
/// one JSON string, while the exact source payloads remain immutable sidecars.
pub(super) fn build_nonshared_floquet_provenance(
    plan: &FemEigenPlanIR,
    topology: &MeshTopology,
    source_artifact: Option<&LoadedEquilibriumArtifact>,
    source_relax_handoff: Option<&AcceptedFemRelaxStageHandoff>,
    equilibrium: &[Vector3],
    observables: &EffectiveFieldObservables,
    stiffness_field: &DMatrix<f64>,
    tangent_mass: &DMatrix<f64>,
    gyrotropic_row_major: &[f64],
    active_nodes: usize,
    sample_index: usize,
    operator_diagnostics: &Value,
) -> Result<NonSharedFloquetProvenance, RunError> {
    if !matches!(
        plan.spin_wave_bc.kind(),
        fullmag_ir::SpinWaveBoundaryKindIR::Floquet
    ) {
        return Err(RunError {
            message: "nonshared_floquet_provenance_requires_floquet_boundary".to_string(),
        });
    }
    let mesh_topology_v3 = plan
        .mesh
        .mixed_topology_fingerprint_v3()
        .map_err(|error| RunError {
            message: format!("nonshared_floquet_mesh_identity_invalid: {error}"),
        })?;
    let mesh_topology_v6 = plan.mesh.topology_fingerprint_v6();
    let modal_mesh_payload_json = serde_json::to_vec(&plan.mesh).map_err(|error| RunError {
        message: format!("nonshared_floquet_modal_mesh_serialization_failed: {error}"),
    })?;
    let modal_mesh_payload_sha256 = raw_sha256(&modal_mesh_payload_json);
    let source_replay = source_relax_handoff.and_then(|handoff| handoff.verified_replay());
    let producer_plan_snapshot = if let Some(replay) = source_replay {
        let snapshot = &replay.producer_provenance.producer_plan_snapshot;
        let plan_bytes = snapshot.preimage_json.as_bytes().to_vec();
        let source_plan = serde_json::from_slice::<fullmag_ir::FemPlanIR>(&plan_bytes).map_err(
            |error| RunError {
                message: format!(
                    "nonshared_floquet_producer_plan_snapshot_decode_failed: {error}"
                ),
            },
        )?;
        let source_mesh = crate::types::FemMeshPayload::from(&source_plan);
        let source_mesh_json = serde_json::to_vec(&source_mesh).map_err(|error| RunError {
            message: format!("nonshared_floquet_source_mesh_serialization_failed: {error}"),
        })?;
        Some((
            source_mesh_json,
            plan_bytes,
            snapshot.namespace.clone(),
            snapshot.raw_sha256.clone(),
            snapshot.framed_sha256.clone(),
        ))
    } else {
        None
    };
    let producer_artifact_mesh_payload = source_artifact
        .and_then(|artifact| artifact.value.get("mesh"))
        .filter(|mesh| {
            [
                "mesh_name",
                "mesh_id",
                "nodes",
                "cells",
                "facets",
                "element_markers",
                "boundary_markers",
                "periodic_boundary_pairs",
                "periodic_node_pairs",
            ]
            .iter()
            .all(|key| mesh.get(*key).is_some())
        })
        .map(|mesh| {
            serde_json::from_value::<crate::types::FemMeshPayload>(mesh.clone()).map_err(
                |error| RunError {
                    message: format!(
                        "nonshared_floquet_source_mesh_payload_invalid: {error}"
                    ),
                },
            )
        })
        .transpose()?;
    let producer_mesh_payload_present =
        producer_plan_snapshot.is_some() || producer_artifact_mesh_payload.is_some();
    let (mesh_payload_kind, mesh_payload_json, mesh_payload_sha256, mesh_payload_path) =
        if let Some((payload, _, _, _, _)) = producer_plan_snapshot.as_ref() {
            (
                "producer_plan_snapshot_mesh".to_string(),
                payload.clone(),
                raw_sha256(payload),
                format!(
                    "eigen/metadata/sample_{sample_index:04}/nonshared_source/source_mesh.json"
                ),
            )
        } else if let Some(mesh) = producer_artifact_mesh_payload.as_ref() {
            let payload = serde_json::to_vec(mesh).map_err(|error| RunError {
                message: format!("nonshared_floquet_source_mesh_serialization_failed: {error}"),
            })?;
            (
                "producer_artifact_mesh".to_string(),
                payload.clone(),
                raw_sha256(&payload),
                format!(
                    "eigen/metadata/sample_{sample_index:04}/nonshared_source/source_mesh.json"
                ),
            )
        } else {
            (
                "consumer_plan_mesh_only".to_string(),
                modal_mesh_payload_json.clone(),
                modal_mesh_payload_sha256.clone(),
                format!(
                    "eigen/metadata/sample_{sample_index:04}/nonshared_modal_mesh.json"
                ),
            )
        };
    let (source_m0, source_m0_origin) = source_artifact
        .map(|artifact| artifact.m0.clone())
        .filter(|values| !values.is_empty())
        .map(|values| (values, "certified_equilibrium_artifact_m0"))
        .or_else(|| {
            source_relax_handoff
                .map(|handoff| (handoff.equilibrium_magnetization.clone(), "verified_relax_handoff_m0"))
        })
        .unwrap_or_else(|| {
            (
                equilibrium.to_vec(),
                "modal_equilibrium_NOT_VERIFIED_as_source_m0",
            )
        });
    let (source_h_eff0, source_h_eff0_origin) = source_artifact
        .map(|artifact| artifact.h_eff0.clone())
        .filter(|values| !values.is_empty())
        .map(|values| (values, "certified_equilibrium_artifact_h_eff0"))
        .or_else(|| {
            source_relax_handoff.map(|handoff| {
                (
                    handoff.certified_fields.h_eff_a_per_m.clone(),
                    "verified_relax_handoff_h_eff0",
                )
            })
        })
        .unwrap_or_else(|| {
            (
                observables.effective_field.clone(),
                "modal_observables_NOT_VERIFIED_as_source_h_eff0",
            )
        });
    let (source_h_demag0, source_h_demag0_origin) = source_artifact
        .map(|artifact| artifact.h_demag0.clone())
        .filter(|values| !values.is_empty())
        .map(|values| (values, "certified_equilibrium_artifact_h_demag0"))
        .or_else(|| {
            source_relax_handoff.map(|handoff| {
                (
                    handoff.certified_fields.h_demag_a_per_m.clone(),
                    "verified_relax_handoff_h_demag0",
                )
            })
        })
        .unwrap_or_else(|| {
            (
                observables.demag_field.clone(),
                "modal_observables_NOT_VERIFIED_as_source_h_demag0",
            )
        });
    let (source_phi0, source_phi0_origin) = source_artifact
        .map(|artifact| artifact.phi0.clone())
        .filter(|values| !values.is_empty())
        .map(|values| (values, "certified_equilibrium_artifact_phi0"))
        .or_else(|| {
            source_relax_handoff.map(|handoff| {
                (
                    handoff.certified_fields.phi_a.clone(),
                    "verified_relax_handoff_phi0",
                )
            })
        })
        .unwrap_or_else(|| (Vec::new(), "NOT_VERIFIED_source_phi0_missing"));
    validate_vector_field("equilibrium", equilibrium)?;
    validate_vector_field("source_m0", &source_m0)?;
    validate_vector_field("source_h_eff0", &source_h_eff0)?;
    validate_vector_field("source_h_demag0", &source_h_demag0)?;
    validate_scalar_field("source_phi0", &source_phi0)?;

    // The producer mesh is part of the replay contract.  A source field that
    // merely contains finite values is not enough: accepting a truncated or
    // consumer-sized field would bind the modal record to the wrong node
    // ordering.  Parse the exact published mesh payload and keep the result
    // as a qualification fact; a malformed/unknown payload remains
    // NOT_VERIFIED instead of becoming a consumer-mesh fallback.
    let producer_mesh_node_count = serde_json::from_slice::<Value>(&mesh_payload_json)
        .ok()
        .and_then(|mesh| {
            mesh.get("nodes")
                .and_then(Value::as_array)
                .map(Vec::len)
        });
    let source_field_origins_verified = [
        source_m0_origin,
        source_h_eff0_origin,
        source_h_demag0_origin,
        source_phi0_origin,
    ]
    .iter()
    .all(|origin| !origin.contains("NOT_VERIFIED"));
    let source_field_lengths_verified = producer_mesh_node_count.is_some_and(|node_count| {
        source_m0.len() == node_count
            && source_h_eff0.len() == node_count
            && source_h_demag0.len() == node_count
            && source_phi0.len() == node_count
    });

    let source_m0_sha256 = shared_domain_content_digest("nonshared_source_m0", &source_m0)?;
    let equilibrium_sha256 = shared_domain_content_digest("nonshared_modal_equilibrium", equilibrium)?;
    let h_eff0_sha256 = shared_domain_content_digest("nonshared_source_h_eff0", &source_h_eff0)?;
    let h_demag0_sha256 =
        shared_domain_content_digest("nonshared_source_h_demag0", &source_h_demag0)?;
    let phi0_sha256 = shared_domain_content_digest("nonshared_source_phi0", &source_phi0)?;
    let material_plan = serde_json::to_value(&plan.material).map_err(|error| RunError {
        message: format!("nonshared_floquet_material_serialization_failed: {error}"),
    })?;
    let physics_plan = json!({
        "enable_exchange": plan.enable_exchange,
        "enable_demag": plan.enable_demag,
        "external_field_a_per_m": plan.external_field,
        "gyromagnetic_ratio": plan.gyromagnetic_ratio,
        "operator": plan.operator,
        "demag_realization": resolved_demag_realization(plan).map(|value| value.provenance_name()),
    });
    let boundary_plan = json!({
        "spin_wave_bc": plan.spin_wave_bc,
        "periodic_node_pairs": plan.mesh.periodic_node_pairs,
        "periodic_boundary_pairs": plan.mesh.periodic_boundary_pairs,
    });
    let physics_signature = shared_domain_content_digest("nonshared_physics_signature", &physics_plan)?;
    let boundary_signature =
        shared_domain_content_digest("nonshared_boundary_signature", &boundary_plan)?;
    let material_signature = source_artifact
        .map(|artifact| artifact.material_signature.clone())
        .unwrap_or_else(|| {
            shared_domain_content_digest("nonshared_material_plan", &material_plan)
                .unwrap_or_else(|_| "NOT_VERIFIED".to_string())
        });
    let source_replay_available = source_replay.is_some();
    let source_replay_qualified = source_replay_available
        && producer_mesh_payload_present
        && source_field_origins_verified
        && source_field_lengths_verified;
    let source_replay_status = if source_replay_qualified {
        "producer_plan_snapshot_verified"
    } else if mesh_payload_kind == "consumer_plan_mesh_only" {
        "NOT_VERIFIED_producer_payload_not_published"
    } else if !source_replay_available {
        "NOT_VERIFIED_source_replay_missing"
    } else if !producer_mesh_payload_present {
        "NOT_VERIFIED_producer_payload_not_published"
    } else if !source_field_origins_verified {
        "NOT_VERIFIED_source_field_origin"
    } else if !source_field_lengths_verified {
        "NOT_VERIFIED_source_field_length"
    } else {
        "NOT_VERIFIED_source_replay_invalid"
    };
    let source_handoff_value = source_relax_handoff.map(|handoff| handoff.provenance_json());
    let producer_provenance_value = source_replay
        .map(|replay| {
            serde_json::to_value(&replay.producer_provenance).map_err(|error| RunError {
                message: format!("nonshared_floquet_producer_provenance_serialization_failed: {error}"),
            })
        })
        .transpose()?;
    let producer_build_identity = source_replay.map(|replay| replay.producer_build_identity.clone());
    let source_handoff_sha256 = source_relax_handoff.map(|handoff| handoff.content_sha256().to_string());
    let producer_plan_snapshot_metadata = producer_plan_snapshot.as_ref().map(
        |(_, _, namespace, raw_sha256, framed_sha256)| {
            json!({
                "namespace": namespace,
                "encoding": "utf-8-json-bytes",
                "path": format!(
                    "eigen/metadata/sample_{sample_index:04}/nonshared_source/producer_plan_snapshot.v1.json"
                ),
                "raw_sha256": raw_sha256,
                "framed_sha256": framed_sha256,
            })
        },
    );
    let source_mesh_topology_sha256 = source_replay
        .map(|replay| replay.producer_provenance.source_mesh_topology_sha256.clone())
        .or_else(|| source_artifact.map(|artifact| artifact.mesh_signature.clone()));
    let source_artifact_metadata = source_artifact.map(|artifact| {
        json!({
            "equilibrium_id": artifact.equilibrium_id,
            "producer_run_id": artifact.producer_run_id,
            "content_sha256": artifact.content_sha256,
            "mesh_signature": artifact.mesh_signature,
            "material_signature": artifact.material_signature,
            "physics_signature": artifact.physics_signature,
            "boundary_signature": artifact.boundary_signature,
            "static_demag_signature": artifact.static_demag_signature,
            "demag_model": artifact.demag_model,
            "completion_sha256": artifact.completion_sha256,
        })
    });
    let consumer_build_identity = build_identity_json();
    let source_root = format!(
        "eigen/metadata/sample_{sample_index:04}/nonshared_source"
    );
    let source_state_preimage_path =
        format!("{source_root}/nonshared_floquet_source_state_preimage.v1.json");
    let operator_input_preimage_path =
        format!("{source_root}/nonshared_floquet_operator_input_preimage.v1.json");
    let matrix_pencil_preimage_path =
        format!("{source_root}/nonshared_floquet_matrix_pencil_preimage.v1.json");
    let physical_source_preimages = if let Some(replay) = source_replay {
        vec![
            (
                "equilibrium_material".to_string(),
                format!("{source_root}/equilibrium_material_preimage.v1.json"),
                exact_json_preimage_bytes(
                    "equilibrium_material",
                    &replay.equilibrium_material_preimage_json,
                )?,
                replay.equilibrium_material_signature.clone(),
                "EquilibriumMaterialSignaturePreimage.v1".to_string(),
            ),
            (
                "equilibrium_static_physics".to_string(),
                format!("{source_root}/equilibrium_static_physics_preimage.v1.json"),
                exact_json_preimage_bytes(
                    "equilibrium_static_physics",
                    &replay.equilibrium_static_physics_preimage_json,
                )?,
                replay.equilibrium_static_physics_signature.clone(),
                "EquilibriumStaticPhysicsSignaturePreimage.v1".to_string(),
            ),
            (
                "equilibrium_boundary".to_string(),
                format!("{source_root}/equilibrium_boundary_preimage.v1.json"),
                exact_json_preimage_bytes(
                    "equilibrium_boundary",
                    &replay.equilibrium_boundary_preimage_json,
                )?,
                replay.equilibrium_boundary_signature.clone(),
                "EquilibriumBoundarySignaturePreimage.v1".to_string(),
            ),
            (
                "material_provenance".to_string(),
                format!("{source_root}/material_provenance_preimage.v1.json"),
                exact_json_preimage_bytes(
                    "material_provenance",
                    &replay.material_provenance_preimage_json,
                )?,
                replay.material_provenance_signature.clone(),
                "material_signature".to_string(),
            ),
        ]
    } else {
        Vec::new()
    };
    let physical_source_preimage_refs = if physical_source_preimages.is_empty() {
        Value::Null
    } else {
        let mut refs = serde_json::Map::new();
        for (key, path, bytes, signature, semantic_namespace) in &physical_source_preimages {
            refs.insert(
                key.clone(),
                exact_preimage_ref_with_namespace(
                    NONSHARED_FLOQUET_PHYSICAL_SOURCE_PREIMAGE_SCHEMA,
                    path,
                    bytes,
                    Some(signature),
                    semantic_namespace,
                ),
            );
        }
        Value::Object(refs)
    };

    let matrix_pencil = matrix_pencil_value(
        plan,
        stiffness_field,
        tangent_mass,
        gyrotropic_row_major,
        active_nodes,
    )?;
    let matrix_pencil_sha256 =
        shared_domain_content_digest("nonshared_floquet_matrix_pencil", &matrix_pencil)?;
    let matrix_pencil_preimage_json = serde_json::to_vec(&matrix_pencil).map_err(|error| {
        RunError {
            message: format!("nonshared_floquet_matrix_pencil_serialization_failed: {error}"),
        }
    })?;
    let matrix_pencil_preimage_sha256 = raw_sha256(&matrix_pencil_preimage_json);
    if matrix_pencil_preimage_sha256 != matrix_pencil_sha256 {
        return Err(RunError {
            message: "nonshared_floquet_matrix_pencil_digest_preimage_mismatch".to_string(),
        });
    }
    let operator_diagnostics_sha256 =
        shared_domain_content_digest("nonshared_operator_diagnostics", operator_diagnostics)?;
    let operator_diagnostics_schema = operator_diagnostics
        .get("schema_version")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| RunError {
            message: "nonshared_floquet_operator_diagnostics_schema_missing".to_string(),
        })?
        .to_string();
    let floquet_pairs = floquet_pair_values(plan, topology)?;
    let operator_input = json!({
        "schema_version": "nonshared_floquet_operator_input.v1",
        "assembly_kind": if matches!(plan.spin_wave_bc.kind(), SpinWaveBoundaryKindIR::Floquet) {
            "runner_full_2x2_bloch_floquet"
        } else {
            "runner_full_2x2_nonshared"
        },
        "matrix_equation": "K_omega(k) q = lambda B(k) q",
        "source_equilibrium_sha256": equilibrium_sha256,
        "source_m0_sha256": source_m0_sha256,
        "source_m0_origin": source_m0_origin,
        "mesh_topology_sha256": mesh_topology_v3,
        "mesh_topology_v6": mesh_topology_v6,
        "source_mesh_topology_sha256": source_mesh_topology_sha256,
        "mesh_payload_kind": mesh_payload_kind,
        "mesh_payload_sha256": mesh_payload_sha256,
        "mesh_payload_path": mesh_payload_path,
        "producer_plan_snapshot": producer_plan_snapshot_metadata,
        "material_signature": material_signature,
        "physics_signature": physics_signature,
        "boundary_signature": boundary_signature,
        "source_equilibrium_material_signature": source_replay
            .map(|replay| replay.equilibrium_material_signature.clone()),
        "source_equilibrium_static_physics_signature": source_replay
            .map(|replay| replay.equilibrium_static_physics_signature.clone()),
        "source_equilibrium_boundary_signature": source_replay
            .map(|replay| replay.equilibrium_boundary_signature.clone()),
        "source_material_provenance_signature": source_replay
            .map(|replay| replay.material_provenance_signature.clone()),
        "source_replay_status": source_replay_status,
        "damping_policy": native_modal_damping_policy(plan.damping_policy),
        "alpha": plan.material.damping,
        "k_vector_rad_m": native_modal_k_vector(plan.k_sampling.as_ref()),
        "spin_wave_bc_kind": native_modal_spin_wave_bc_kind(&plan.spin_wave_bc),
        "phase_convention": format!("{:?}", plan.spin_wave_bc.phase_convention()),
        "floquet_pairs": floquet_pairs,
        "matrix_pencil_sha256": matrix_pencil_sha256,
        "matrix_pencil_shape": matrix_shape(stiffness_field),
        "operator_diagnostics_sha256": operator_diagnostics_sha256,
        "operator_diagnostics_schema": operator_diagnostics.get("schema_version"),
        "active_node_count": active_nodes,
        "tangent_dof_count": stiffness_field.nrows(),
        "equilibrium_source_kind": native_modal_equilibrium_source_kind(&plan.equilibrium),
        "include_exchange": plan.enable_exchange,
        "include_demag": plan.enable_demag && plan.operator.include_demag,
    });
    let operator_input_signature_sha256 =
        shared_domain_content_digest("nonshared_floquet_operator_input", &operator_input)?;
    let operator_input_preimage_json = serde_json::to_vec(&operator_input).map_err(|error| {
        RunError {
            message: format!("nonshared_floquet_operator_input_serialization_failed: {error}"),
        }
    })?;
    let operator_input_preimage_sha256 = raw_sha256(&operator_input_preimage_json);
    if operator_input_preimage_sha256 != operator_input_signature_sha256 {
        return Err(RunError {
            message: "nonshared_floquet_operator_input_digest_preimage_mismatch".to_string(),
        });
    }
    let mesh_payload_ref = exact_preimage_ref_with_sample(
        NONSHARED_FLOQUET_MESH_PAYLOAD_PREIMAGE_SCHEMA,
        &mesh_payload_path,
        &mesh_payload_json,
        Some(&mesh_payload_sha256),
        sample_index,
    );
    let exact_replay_refs = json!({
        "schema_version": NONSHARED_FLOQUET_EXACT_REPLAY_REFS_SCHEMA,
        "operator_input": exact_preimage_ref(
            NONSHARED_FLOQUET_OPERATOR_INPUT_PREIMAGE_SCHEMA,
            &operator_input_preimage_path,
            &operator_input_preimage_json,
            Some(&operator_input_signature_sha256),
        ),
        "matrix_pencil": exact_preimage_ref(
            NONSHARED_FLOQUET_MATRIX_PENCIL_PREIMAGE_SCHEMA,
            &matrix_pencil_preimage_path,
            &matrix_pencil_preimage_json,
            Some(&matrix_pencil_sha256),
        ),
        "mesh_payload": mesh_payload_ref,
        "physical_source": physical_source_preimage_refs,
    });

    let mut source_state = json!({
        "schema_version": NONSHARED_FLOQUET_SOURCE_STATE_SCHEMA,
        "content_sha256": "",
        "variant": "nonshared_floquet",
        "sample_index": sample_index,
        "source_replay_available": source_replay_available,
        "source_replay_qualified": source_replay_qualified,
        "source_replay_status": source_replay_status,
        "source_field_origins_verified": source_field_origins_verified,
        "source_field_lengths_verified": source_field_lengths_verified,
        "source_mesh_node_count": producer_mesh_node_count,
        "exact_replay_refs": exact_replay_refs.clone(),
        "source_artifact": source_artifact_metadata,
        "source_relax_handoff_sha256": source_handoff_sha256,
        "source_relax_handoff": source_handoff_value,
        "producer_provenance": producer_provenance_value,
        "producer_plan_snapshot": producer_plan_snapshot_metadata,
        "producer_build_identity": producer_build_identity,
        "consumer_build_identity": consumer_build_identity,
        "mesh": {
            "topology_fingerprint_v3": mesh_topology_v3,
            "topology_fingerprint_v6": mesh_topology_v6,
            "source_mesh_topology_sha256": source_mesh_topology_sha256,
            "node_count": equilibrium.len(),
            "source_node_count": source_m0.len(),
            "producer_mesh_node_count": producer_mesh_node_count,
            "source_field_origins_verified": source_field_origins_verified,
            "source_field_lengths_verified": source_field_lengths_verified,
            "payload_kind": mesh_payload_kind,
            "payload_sha256": mesh_payload_sha256,
            "payload_path": mesh_payload_path,
            // Keep the nested mesh record aligned with the authoritative
            // replay gate.  A published producer mesh by itself does not
            // qualify the source fields when the replay payload/origins or
            // lengths are missing or inconsistent.
            "source_mesh_payload_status": source_replay_status,
        },
        "equilibrium": {
            "m0": source_m0,
            "m0_origin": source_m0_origin,
            "m0_sha256": source_m0_sha256,
            "runtime_equilibrium_sha256": equilibrium_sha256,
            "h_eff0_a_per_m": source_h_eff0,
            "h_eff0_origin": source_h_eff0_origin,
            "h_eff0_sha256": h_eff0_sha256,
            "h_demag0_a_per_m": source_h_demag0,
            "h_demag0_origin": source_h_demag0_origin,
            "h_demag0_sha256": h_demag0_sha256,
            "phi0_a": source_phi0,
            "phi0_origin": source_phi0_origin,
            "phi0_sha256": phi0_sha256,
        },
        "material": {
            "plan": material_plan,
            "signature": material_signature,
            "identity_status": if source_artifact.is_some() { "source_artifact" } else { "NOT_VERIFIED" },
        },
        "static_physics": {
            "signature": physics_signature,
            "plan": physics_plan,
        },
        "boundary": {
            "signature": boundary_signature,
            "plan": boundary_plan,
        },
        "damping": {
            "policy": native_modal_damping_policy(plan.damping_policy),
            "alpha": plan.material.damping,
            "unit": "1",
        },
        "k_sampling": plan.k_sampling,
        "operator": {
            "input_signature_sha256": operator_input_signature_sha256,
            "matrix_pencil_sha256": matrix_pencil_sha256,
            "matrix_pencil_shape": matrix_shape(stiffness_field),
        },
        "status": if source_replay_qualified { "source_verified" } else { "NOT_VERIFIED" },
    });
    let source_state_preimage = serde_json::to_vec(&source_state).map_err(|error| RunError {
        message: format!("nonshared_floquet_source_state_serialization_failed: {error}"),
    })?;
    let source_state_sha256 = raw_sha256(&source_state_preimage);
    source_state["content_sha256"] = json!(source_state_sha256);
    let source_state_preimage_ref = exact_preimage_ref(
        NONSHARED_FLOQUET_SOURCE_STATE_PREIMAGE_SCHEMA,
        &source_state_preimage_path,
        &source_state_preimage,
        Some(&source_state_sha256),
    );
    let mut final_exact_replay_refs = exact_replay_refs
        .as_object()
        .cloned()
        .ok_or_else(|| RunError {
            message: "nonshared_floquet_exact_replay_refs_not_object".to_string(),
        })?;
    final_exact_replay_refs.insert("source_state".to_string(), source_state_preimage_ref);
    let final_exact_replay_refs = Value::Object(final_exact_replay_refs);
    let mut exact_replay_sidecars = vec![
        NonSharedFloquetSidecar {
            relative_path: source_state_preimage_path,
            bytes: source_state_preimage,
        },
        NonSharedFloquetSidecar {
            relative_path: operator_input_preimage_path,
            bytes: operator_input_preimage_json,
        },
        NonSharedFloquetSidecar {
            relative_path: matrix_pencil_preimage_path,
            bytes: matrix_pencil_preimage_json,
        },
    ];
    exact_replay_sidecars.extend(
        physical_source_preimages
            .into_iter()
            .map(|(_, relative_path, bytes, _, _)| NonSharedFloquetSidecar {
                relative_path,
                bytes,
            }),
    );

    let mut operator_identity = json!({
        "schema_version": NONSHARED_FLOQUET_OPERATOR_IDENTITY_SCHEMA,
        "content_sha256": "",
        "sample_index": sample_index,
        "variant": "nonshared_floquet",
        "source_replay_qualified": source_replay_qualified,
        "source_replay_available": source_replay_available,
        "source_replay_status": source_replay_status,
        "source_field_origins_verified": source_field_origins_verified,
        "source_field_lengths_verified": source_field_lengths_verified,
        "source_mesh_node_count": producer_mesh_node_count,
        "exact_replay_refs": final_exact_replay_refs.clone(),
        "source_state_sha256": source_state_sha256,
        "operator_input_signature_sha256": operator_input_signature_sha256,
        "matrix_pencil_sha256": matrix_pencil_sha256,
        "mesh_topology_sha256": mesh_topology_v3,
        "source_mesh_topology_sha256": source_mesh_topology_sha256,
        "mesh_payload_kind": mesh_payload_kind,
        "mesh_payload_sha256": mesh_payload_sha256,
        "mesh_payload_path": mesh_payload_path,
        "producer_plan_snapshot": producer_plan_snapshot_metadata,
        "material_signature": material_signature,
        "physics_signature": physics_signature,
        "boundary_signature": boundary_signature,
        "damping_policy": native_modal_damping_policy(plan.damping_policy),
        "alpha": plan.material.damping,
        "k_vector_rad_m": native_modal_k_vector(plan.k_sampling.as_ref()),
        "phase_convention": format!("{:?}", plan.spin_wave_bc.phase_convention()),
        "floquet_pairs": operator_input["floquet_pairs"],
        "consumer_build_identity": consumer_build_identity,
        "producer_build_identity": producer_build_identity,
        "source_handoff_sha256": source_handoff_sha256,
        "status": if source_replay_qualified { "source_verified" } else { "NOT_VERIFIED" },
    });
    let operator_identity_preimage_json = serde_json::to_vec(&operator_identity).map_err(|error| {
        RunError {
            message: format!("nonshared_floquet_identity_serialization_failed: {error}"),
        }
    })?;
    let operator_identity_sha256 = raw_sha256(&operator_identity_preimage_json);
    operator_identity["content_sha256"] = json!(operator_identity_sha256);

    let mut provenance = NonSharedFloquetProvenance {
        source_state,
        source_state_sha256,
        operator_identity,
        operator_identity_sha256,
        operator_identity_preimage_json,
        matrix_pencil_sha256,
        operator_diagnostics_sha256,
        operator_diagnostics_schema,
        source_replay_qualified,
        mesh_payload_kind,
        mesh_payload_sha256,
        mesh_payload_path,
        mesh_payload_json,
        exact_replay_refs: final_exact_replay_refs,
        exact_replay_sidecars,
        sidecars: Vec::new(),
        native_input_diagnostics_refs: None,
    };
    provenance.sidecars = provenance.identity_sidecars(sample_index)?;
    if let Some((_, plan_bytes, _, _, _)) = producer_plan_snapshot {
        provenance.sidecars.push(NonSharedFloquetSidecar {
            relative_path: format!(
                "eigen/metadata/sample_{sample_index:04}/nonshared_source/producer_plan_snapshot.v1.json"
            ),
            bytes: plan_bytes,
        });
    }
    if let Some(replay) = source_replay {
        provenance.sidecars.extend([
            NonSharedFloquetSidecar {
                relative_path: format!(
                    "eigen/metadata/sample_{sample_index:04}/nonshared_source/accepted_fields.json"
                ),
                bytes: replay.accepted_fields_json.clone(),
            },
            NonSharedFloquetSidecar {
                relative_path: format!(
                    "eigen/metadata/sample_{sample_index:04}/nonshared_source/certified_fields.json"
                ),
                bytes: replay.certified_fields_json.clone(),
            },
            NonSharedFloquetSidecar {
                relative_path: format!(
                    "eigen/metadata/sample_{sample_index:04}/nonshared_source/recomputed_certificate.json"
                ),
                bytes: replay.recomputed_certificate_json.clone(),
            },
            NonSharedFloquetSidecar {
                relative_path: format!(
                    "eigen/metadata/sample_{sample_index:04}/nonshared_source/recomputed_certificate_preimage.json"
                ),
                bytes: replay.recomputed_certificate_preimage_json.as_bytes().to_vec(),
            },
        ]);
    }
    Ok(provenance)
}

fn matrix_pencil_value(
    plan: &FemEigenPlanIR,
    stiffness_field: &DMatrix<f64>,
    tangent_mass: &DMatrix<f64>,
    gyrotropic_row_major: &[f64],
    active_nodes: usize,
) -> Result<Value, RunError> {
    let base_tangent_dof = active_nodes.checked_mul(2).ok_or_else(|| RunError {
        message: "nonshared_floquet_matrix_dimension_overflow".to_string(),
    })?;
    // The direct runner pencil has two tangent components per active node.
    // The complex Bloch/Floquet entry point first embeds the complex pair into
    // a real block and then duplicates that block for the real/imaginary
    // modal vector, so its native pencil is twice as large.  Both are real
    // representations of the same physical operator; record which one was
    // received instead of rejecting the latter as a malformed mesh-sized
    // matrix.
    let embedded_tangent_dof = base_tangent_dof.checked_mul(2).ok_or_else(|| RunError {
        message: "nonshared_floquet_matrix_embedding_dimension_overflow".to_string(),
    })?;
    let expected = if stiffness_field.nrows() == base_tangent_dof {
        base_tangent_dof
    } else if stiffness_field.nrows() == embedded_tangent_dof {
        embedded_tangent_dof
    } else {
        0
    };
    if expected == 0
        || stiffness_field.ncols() != expected
        || tangent_mass.nrows() != expected
        || tangent_mass.ncols() != expected
        || gyrotropic_row_major.len() != expected.saturating_mul(expected)
    {
        return Err(RunError {
            message: format!(
                "nonshared_floquet_matrix_shape_invalid: stiffness={}x{}, mass={}x{}, gyrotropic_values={}, expected={} or {} square DOF",
                stiffness_field.nrows(),
                stiffness_field.ncols(),
                tangent_mass.nrows(),
                tangent_mass.ncols(),
                gyrotropic_row_major.len(),
                base_tangent_dof,
                embedded_tangent_dof,
            ),
        });
    }
    let stiffness_field_values = matrix_values(stiffness_field)?;
    let tangent_mass_values = matrix_values(tangent_mass)?;
    let stiffness_omega_values = stiffness_field_values
        .iter()
        .map(|value| value * plan.gyromagnetic_ratio)
        .collect::<Vec<_>>();
    if gyrotropic_row_major
        .iter()
        .any(|value| !value.is_finite())
    {
        return Err(RunError {
            message: "nonshared_floquet_gyrotropic_matrix_contains_nonfinite_value".to_string(),
        });
    }
    Ok(json!({
        "schema_version": "nonshared_floquet_matrix_pencil.v1",
        "row_major": true,
        "dimension": expected,
        "active_node_count": active_nodes,
        "tangent_dof_count": expected,
        "embedding": if expected == base_tangent_dof {
            "direct_real_tangent"
        } else {
            "complex_bloch_real_embedding"
        },
        "stiffness_field_a_per_m": stiffness_field_values,
        "stiffness_omega_rad_s": stiffness_omega_values,
        "gyrotropic": gyrotropic_row_major,
        "tangent_mass": tangent_mass_values,
    }))
}

fn matrix_values(matrix: &DMatrix<f64>) -> Result<Vec<f64>, RunError> {
    let mut values = Vec::with_capacity(matrix.nrows().saturating_mul(matrix.ncols()));
    for row in 0..matrix.nrows() {
        for column in 0..matrix.ncols() {
            let value = matrix[(row, column)];
            if !value.is_finite() {
                return Err(RunError {
                    message: "nonshared_floquet_matrix_contains_nonfinite_value".to_string(),
                });
            }
            values.push(value);
        }
    }
    Ok(values)
}

fn matrix_shape(matrix: &DMatrix<f64>) -> Value {
    json!({"rows": matrix.nrows(), "columns": matrix.ncols(), "ordering": "row_major"})
}

fn floquet_pair_values(
    plan: &FemEigenPlanIR,
    topology: &MeshTopology,
) -> Result<Vec<Value>, RunError> {
    if !matches!(plan.spin_wave_bc.kind(), SpinWaveBoundaryKindIR::Floquet) {
        return Ok(Vec::new());
    }
    let Some(KSamplingIR::Single { k_vector }) = plan.k_sampling.as_ref() else {
        return Ok(Vec::new());
    };
    let requested_pair_ids = plan.spin_wave_bc.boundary_pair_ids();
    let mut pairs = Vec::new();
    for (pair_id, node_a, node_b) in &topology.periodic_node_pairs {
        if !requested_pair_ids.is_empty()
            && !requested_pair_ids.iter().any(|requested| requested == pair_id)
        {
            continue;
        }
        let translation_m = topology
            .periodic_boundary_pairs
            .iter()
            .find(|(boundary_pair_id, _)| boundary_pair_id == pair_id)
            .and_then(|(_, translation)| *translation)
            .ok_or_else(|| RunError {
                message: format!(
                    "nonshared_floquet_pair_translation_missing: {pair_id}"
                ),
            })?;
        let phase_rad = -(k_vector[0] * translation_m[0]
            + k_vector[1] * translation_m[1]
            + k_vector[2] * translation_m[2]);
        pairs.push(json!({
            "pair_id": pair_id,
            "node_a": node_a,
            "node_b": node_b,
            "translation_m": translation_m,
            "phase_rad": phase_rad,
            "phase_convention": format!("{:?}", plan.spin_wave_bc.phase_convention()),
        }));
    }
    Ok(pairs)
}

fn validate_vector_field(label: &str, values: &[Vector3]) -> Result<(), RunError> {
    if values.iter().flatten().any(|value| !value.is_finite()) {
        return Err(RunError {
            message: format!("nonshared_floquet_{label}_contains_nonfinite_value"),
        });
    }
    Ok(())
}

fn validate_scalar_field(label: &str, values: &[f64]) -> Result<(), RunError> {
    if values.iter().any(|value| !value.is_finite()) {
        return Err(RunError {
            message: format!("nonshared_floquet_{label}_contains_nonfinite_value"),
        });
    }
    Ok(())
}

fn exact_json_preimage_bytes(label: &str, value: &str) -> Result<Vec<u8>, RunError> {
    let bytes = value.as_bytes().to_vec();
    serde_json::from_slice::<Value>(&bytes).map_err(|error| RunError {
        message: format!(
            "nonshared_floquet_{label}_preimage_is_not_valid_json: {error}"
        ),
    })?;
    Ok(bytes)
}

fn exact_preimage_ref(
    schema: &str,
    path: &str,
    bytes: &[u8],
    semantic_signature: Option<&str>,
) -> Value {
    let mut reference = serde_json::Map::new();
    reference.insert("schema_version".to_string(), json!(schema));
    reference.insert("path".to_string(), json!(path));
    reference.insert("encoding".to_string(), json!("utf-8-json-bytes"));
    reference.insert("byte_length".to_string(), json!(bytes.len()));
    reference.insert("raw_sha256".to_string(), json!(raw_sha256(bytes)));
    if let Some(signature) = semantic_signature {
        reference.insert("semantic_signature".to_string(), json!(signature));
    }
    Value::Object(reference)
}

fn exact_preimage_ref_with_sample(
    schema: &str,
    path: &str,
    bytes: &[u8],
    semantic_signature: Option<&str>,
    sample_index: usize,
) -> Value {
    let mut reference = exact_preimage_ref(schema, path, bytes, semantic_signature);
    if let Some(object) = reference.as_object_mut() {
        object.insert("sample_index".to_string(), json!(sample_index));
    }
    reference
}

fn exact_preimage_ref_with_namespace(
    schema: &str,
    path: &str,
    bytes: &[u8],
    semantic_signature: Option<&str>,
    semantic_namespace: &str,
) -> Value {
    let mut reference = exact_preimage_ref(schema, path, bytes, semantic_signature);
    if let Some(object) = reference.as_object_mut() {
        object.insert(
            "semantic_namespace".to_string(),
            json!(semantic_namespace),
        );
    }
    reference
}

fn raw_sha256(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
