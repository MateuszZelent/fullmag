use super::eigen_digest::{is_sha256_digest, shared_domain_content_digest};
use super::eigen_types::{AcceptedEquilibriumCriterion, SharedDomainLinearizationState};
use crate::types::ExecutedRun;
use crate::types::RunError;
use crate::types::StageFemMeshIdentity;
use fullmag_engine::fem::MeshTopology;
use fullmag_engine::Vector3;
use fullmag_ir::EquilibriumSourceIR;
use fullmag_ir::FemEigenPlanIR;
use fullmag_ir::KSamplingIR;
use sha2::{Digest, Sha256};

/// Immutable execution input produced by an accepted FEM relaxation stage and
/// consumed by one following single-k eigen stage.
///
/// This is intentionally distinct from [`AcceptedFemEigenEquilibriumHandoff`],
/// which carries a post-linearization state between samples of one k path.
pub(super) const ACCEPTED_FEM_RELAX_STAGE_HANDOFF_V2: &str = "AcceptedFemRelaxStageHandoff.v2";
#[allow(dead_code)] // Wired by the next migration slice; defined here to freeze the namespace now.
pub(super) const ACCEPTED_FEM_RELAX_STAGE_HANDOFF_V3: &str = "AcceptedFemRelaxStageHandoff.v3";
pub(super) const LINEARIZATION_IDENTITY_V2: &str = "linearization_identity.v2";
pub(super) const LINEARIZATION_IDENTITY_PREIMAGE_V1: &str = "linearization_identity_preimage.v1";
/// Exact consumer plan bytes used to populate
/// `LinearizationIdentityV2.consumer_plan_snapshot_sha256`.
///
/// The sidecar is the raw `serde_json::to_vec(FemEigenPlanIR)` output.  It is
/// deliberately not wrapped in an envelope: adding an envelope would make
/// the published bytes differ from the identity preimage digest.
pub(super) const CONSUMER_PLAN_SNAPSHOT_FILENAME: &str = "consumer_plan_snapshot.v1.json";
pub const FEM_RELAXATION_PRODUCER_PROVENANCE_V1: &str =
    "fem_relaxation_producer_provenance.v1";
pub const FEM_RELAXATION_PRODUCER_PLAN_NAMESPACE_V1: &str =
    "fem_relaxation.producer_plan.v1";
pub const FEM_RELAXATION_PRODUCER_PROVENANCE_RELATIVE_PATH: &str =
    "equilibrium/producer_provenance.v1.json";

/// Exact orchestration identity supplied by the caller that owns a producer
/// relaxation.  This is intentionally separate from the current consumer's
/// run metadata: a modal stage must never relabel an imported relaxation with
/// its own run or stage identifiers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FemRelaxationProducerStageIdentity {
    pub(crate) run_id: String,
    pub(crate) stage_id: String,
    pub(crate) stage_kind: String,
}

impl FemRelaxationProducerStageIdentity {
    pub(crate) fn from_problem(problem: &fullmag_ir::ProblemIR) -> Option<Self> {
        let metadata = &problem.problem_meta.runtime_metadata;
        let read = |key: &str| {
            metadata
                .get(key)
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(str::to_owned)
        };
        Some(Self {
            run_id: read("producer_run_id")?,
            stage_id: read("producer_stage_id")?,
            stage_kind: read("producer_stage_kind")?,
        })
    }

    /// Derive the identity of the internal relaxation that owns one bias
    /// field sample.  The orchestration run remains the same, while the
    /// sample is a distinct executed producer stage.  This prevents a
    /// multi-sample sweep from publishing one stale stage identity for every
    /// exact payload bundle.
    pub(crate) fn for_bias_field_sample(&self, sample_position: usize) -> Self {
        Self {
            run_id: self.run_id.clone(),
            stage_id: format!(
                "{}:bias-field-sample-{sample_position:04}",
                self.stage_id
            ),
            stage_kind: "bias_field_relaxation".to_string(),
        }
    }
}

/// Build identity captured at the producer artifact boundary.
///
/// This is deliberately a typed copy of the four fields written by
/// `RunMetadata`; consumers must never replace it with their current process
/// identity.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FemRelaxationProducerBuildIdentity {
    pub built_at_utc: String,
    pub git_commit: String,
    pub worktree_state: String,
    pub source_snapshot_sha256: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FemRelaxationProducerPlanSnapshot {
    pub namespace: String,
    pub encoding: String,
    pub preimage_json: String,
    pub raw_sha256: String,
    pub framed_sha256: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FemRelaxationProducerPayloadRef {
    pub path: String,
    pub schema_version: String,
    pub raw_bytes_sha256: String,
    pub content_sha256: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FemRelaxationProducerPayloads {
    pub accepted_fields: FemRelaxationProducerPayloadRef,
    pub certified_fields: FemRelaxationProducerPayloadRef,
    pub recomputed_certificate: FemRelaxationProducerPayloadRef,
}

/// Exact provenance for the three FEM relaxation payloads consumed by a
/// verified eigen handoff.  The sidecar is additive; historical V1/V2
/// payload schemas and their digests remain unchanged.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FemRelaxationProducerProvenance {
    pub schema_version: String,
    pub source_run_id: String,
    pub source_stage_id: String,
    pub source_stage_kind: String,
    pub producer_build_identity: FemRelaxationProducerBuildIdentity,
    pub producer_plan_snapshot: FemRelaxationProducerPlanSnapshot,
    pub source_mesh_topology_sha256: String,
    pub equilibrium_content_sha256: String,
    pub equilibrium_material_signature: String,
    pub equilibrium_static_physics_signature: String,
    pub equilibrium_boundary_signature: String,
    pub payloads: FemRelaxationProducerPayloads,
    pub cross_build_policy: String,
}

/// Exact bytes captured from the producer relaxation run.  The typed values
/// are still validated independently; these bytes are retained so Python and
/// other consumers can replay the producer's JSON without reserializing it.
#[derive(Debug, Clone)]
pub struct AcceptedFemRelaxExactArtifacts {
    pub accepted_fields_json: Vec<u8>,
    pub certified_fields_json: Vec<u8>,
    pub recomputed_certificate_json: Vec<u8>,
}

impl FemRelaxationProducerProvenance {
    /// Validate a producer sidecar against the exact payload bytes and the
    /// target relaxation identity.  This is the only sidecar entry point used
    /// by the verified handoff; a matching node count alone is insufficient.
    pub fn validate_for_handoff(
        &self,
        source_run_id: &str,
        source_stage_id: &str,
        source_stage_kind: &str,
        source_plan: &fullmag_ir::FemPlanIR,
        accepted_fields: &crate::types::CertifiedFemEquilibriumFields,
        certified_fields: &crate::types::CertifiedFemEquilibriumFields,
        recomputed_certificate: &crate::types::RecomputedFemLinearizationCertificateV1,
        exact_artifacts: &AcceptedFemRelaxExactArtifacts,
    ) -> Result<(), RunError> {
        let reject = |reason: &str| RunError {
            message: format!("fem_relaxation_producer_provenance_invalid: {reason}"),
        };
        if self.schema_version != FEM_RELAXATION_PRODUCER_PROVENANCE_V1 {
            return Err(reject("schema_version"));
        }
        if self.source_run_id.trim().is_empty()
            || self.source_stage_id.trim().is_empty()
            || self.source_stage_kind.trim().is_empty()
            || source_run_id.trim().is_empty()
            || source_stage_id.trim().is_empty()
            || source_stage_kind.trim().is_empty()
        {
            return Err(reject("source identity is empty"));
        }
        if self.source_run_id != source_run_id
            || self.source_stage_id != source_stage_id
            || self.source_stage_kind != source_stage_kind
        {
            return Err(reject("source run/stage identity mismatch"));
        }
        if self.cross_build_policy != "same_source_snapshot_required" {
            return Err(reject("unknown cross_build_policy"));
        }
        validate_producer_build_identity(&self.producer_build_identity)?;
        if self.producer_plan_snapshot.namespace != FEM_RELAXATION_PRODUCER_PLAN_NAMESPACE_V1
            || self.producer_plan_snapshot.encoding != "utf-8-json-bytes"
        {
            return Err(reject("producer plan encoding or namespace"));
        }
        let plan_bytes = self.producer_plan_snapshot.preimage_json.as_bytes();
        if bytes_sha256(plan_bytes) != self.producer_plan_snapshot.raw_sha256
            || framed_sha256(
                &self.producer_plan_snapshot.namespace,
                plan_bytes,
            ) != self.producer_plan_snapshot.framed_sha256
        {
            return Err(reject("producer plan exact bytes digest mismatch"));
        }
        let expected_plan_bytes = serde_json::to_vec(source_plan).map_err(|error| RunError {
            message: format!(
                "fem_relaxation_producer_provenance_invalid: source plan serialization: {error}"
            ),
        })?;
        if plan_bytes != expected_plan_bytes.as_slice() {
            return Err(reject("producer plan snapshot does not bind source plan"));
        }
        for (name, signature) in [
            ("source_mesh_topology_sha256", &self.source_mesh_topology_sha256),
            ("equilibrium_content_sha256", &self.equilibrium_content_sha256),
            (
                "equilibrium_material_signature",
                &self.equilibrium_material_signature,
            ),
            (
                "equilibrium_static_physics_signature",
                &self.equilibrium_static_physics_signature,
            ),
            (
                "equilibrium_boundary_signature",
                &self.equilibrium_boundary_signature,
            ),
        ] {
            if !is_strict_sha256_digest(signature) {
                return Err(reject(name));
            }
        }
        let source_identity =
            super::equilibrium_identity::EquilibriumIdentitySignaturesV1::from_relax_plan(
                source_plan,
            )?;
        if self.equilibrium_material_signature != source_identity.equilibrium_material_signature
            || self.equilibrium_static_physics_signature
                != source_identity.equilibrium_static_physics_signature
            || self.equilibrium_boundary_signature != source_identity.equilibrium_boundary_signature
        {
            return Err(reject("physical equilibrium signature mismatch"));
        }
        let source_mesh = crate::types::FemMeshPayload::from(source_plan);
        if self.source_mesh_topology_sha256
            != crate::types::fem_mesh_topology_fingerprint(&source_mesh)
        {
            return Err(reject("source mesh topology mismatch"));
        }
        if self.source_mesh_topology_sha256 != recomputed_certificate.mesh_topology_sha256 {
            return Err(reject("certificate mesh topology mismatch"));
        }
        if self.equilibrium_content_sha256 != recomputed_certificate.equilibrium_content_sha256 {
            return Err(reject("equilibrium content mismatch"));
        }
        validate_producer_payload_ref(
            "accepted_fields",
            &self.payloads.accepted_fields,
            exact_artifacts.accepted_fields_json.as_slice(),
            &accepted_fields.schema_version,
            &accepted_fields.content_sha256,
            crate::types::CertifiedFemEquilibriumFields::accepted_artifact_path_for_material(
                &source_plan.material,
            ),
        )?;
        validate_producer_payload_ref(
            "certified_fields",
            &self.payloads.certified_fields,
            exact_artifacts.certified_fields_json.as_slice(),
            &certified_fields.schema_version,
            &certified_fields.content_sha256,
            crate::types::CertifiedFemEquilibriumFields::artifact_paths_for_material(
                &source_plan.material,
            )
            .0,
        )?;
        validate_producer_payload_ref(
            "recomputed_certificate",
            &self.payloads.recomputed_certificate,
            exact_artifacts.recomputed_certificate_json.as_slice(),
            &recomputed_certificate.schema_version,
            &recomputed_certificate.content_sha256,
            crate::types::CertifiedFemEquilibriumFields::artifact_paths_for_material(
                &source_plan.material,
            )
            .1,
        )?;
        if accepted_fields.schema_version != certified_fields.schema_version
            || certified_fields.schema_version.ends_with(".v1")
                != recomputed_certificate.schema_version.ends_with(".v1")
            || accepted_fields.schema_version.ends_with(".v2")
                != recomputed_certificate.schema_version.ends_with(".v2")
            || crate::types::certified_equilibrium_fields_sha256(accepted_fields)
                != accepted_fields.content_sha256
            || crate::types::certified_equilibrium_fields_sha256(certified_fields)
                != certified_fields.content_sha256
            || crate::types::recomputed_fem_linearization_certificate_sha256(
                recomputed_certificate,
            )? != recomputed_certificate.content_sha256
        {
            return Err(reject("payload family or content digest mismatch"));
        }
        Ok(())
    }
}

fn validate_producer_build_identity(
    identity: &FemRelaxationProducerBuildIdentity,
) -> Result<(), RunError> {
    if identity.built_at_utc.trim().is_empty()
        || identity.git_commit.trim().is_empty()
        || identity.worktree_state.trim().is_empty()
        || !is_strict_source_snapshot_sha256(&identity.source_snapshot_sha256)
    {
        return Err(RunError {
            message: "fem_relaxation_producer_provenance_invalid: producer build identity"
                .to_string(),
        });
    }
    Ok(())
}

fn validate_producer_payload_ref(
    name: &str,
    reference: &FemRelaxationProducerPayloadRef,
    bytes: &[u8],
    expected_schema: &str,
    expected_content_sha256: &str,
    expected_path: &str,
) -> Result<(), RunError> {
    let reject = |reason: &str| RunError {
        message: format!(
            "fem_relaxation_producer_provenance_invalid: {name} {reason}"
        ),
    };
    if reference.path != expected_path
        || reference.path.trim().is_empty()
        || reference.path.starts_with('/')
        || reference.path.starts_with('\\')
        || reference.path.contains(':')
        || reference.path.split(['/', '\\']).any(|part| part == "..")
        || reference.schema_version != expected_schema
        || !is_strict_sha256_digest(&reference.raw_bytes_sha256)
        || !is_strict_sha256_digest(&reference.content_sha256)
        || reference.raw_bytes_sha256 != bytes_sha256(bytes)
        || reference.content_sha256 != expected_content_sha256
    {
        return Err(reject("path, schema, or digest mismatch"));
    }
    Ok(())
}

fn framed_sha256(namespace: &str, bytes: &[u8]) -> String {
    let mut hash = Sha256::new();
    hash.update(namespace.as_bytes());
    hash.update([0_u8]);
    hash.update((bytes.len() as u64).to_le_bytes());
    hash.update(bytes);
    format!("sha256:{:x}", hash.finalize())
}

/// Build the sidecar at the producer artifact boundary.  The caller supplies
/// the exact bytes that will be written; no consumer-side serialization is
/// involved in the hashes below.
pub(crate) fn fem_relaxation_producer_provenance_from_exact_artifacts(
    source_run_id: &str,
    source_stage_id: &str,
    source_stage_kind: &str,
    source_plan: &fullmag_ir::FemPlanIR,
    equilibrium_magnetization: &[[f64; 3]],
    producer_build_identity: serde_json::Value,
    accepted_fields_path: &str,
    accepted_fields_json: &[u8],
    certified_fields_path: &str,
    certified_fields_json: &[u8],
    recomputed_certificate_path: &str,
    recomputed_certificate_json: &[u8],
) -> Result<FemRelaxationProducerProvenance, RunError> {
    let accepted_fields = serde_json::from_slice::<crate::types::CertifiedFemEquilibriumFields>(
        accepted_fields_json,
    )
    .map_err(|error| RunError {
        message: format!(
            "fem_relaxation_producer_provenance_accepted_fields_decode_failed: {error}"
        ),
    })?;
    let certified_fields = serde_json::from_slice::<crate::types::CertifiedFemEquilibriumFields>(
        certified_fields_json,
    )
    .map_err(|error| RunError {
        message: format!(
            "fem_relaxation_producer_provenance_certified_fields_decode_failed: {error}"
        ),
    })?;
    let recomputed_certificate = serde_json::from_slice::<
        crate::types::RecomputedFemLinearizationCertificateV1,
    >(recomputed_certificate_json)
    .map_err(|error| RunError {
        message: format!(
            "fem_relaxation_producer_provenance_certificate_decode_failed: {error}"
        ),
    })?;
    let build_identity: FemRelaxationProducerBuildIdentity =
        serde_json::from_value(producer_build_identity).map_err(|error| RunError {
            message: format!(
                "fem_relaxation_producer_provenance_build_identity_decode_failed: {error}"
            ),
        })?;
    validate_producer_build_identity(&build_identity)?;
    let plan_bytes = serde_json::to_vec(source_plan).map_err(|error| RunError {
        message: format!(
            "fem_relaxation_producer_provenance_plan_serialization_failed: {error}"
        ),
    })?;
    let plan_preimage_json = String::from_utf8(plan_bytes.clone()).map_err(|error| RunError {
        message: format!(
            "fem_relaxation_producer_provenance_plan_not_utf8: {error}"
        ),
    })?;
    let source_identity =
        super::equilibrium_identity::EquilibriumIdentitySignaturesV1::from_relax_plan(source_plan)?;
    let source_mesh = crate::types::FemMeshPayload::from(source_plan);
    let provenance = FemRelaxationProducerProvenance {
        schema_version: FEM_RELAXATION_PRODUCER_PROVENANCE_V1.to_string(),
        source_run_id: source_run_id.to_string(),
        source_stage_id: source_stage_id.to_string(),
        source_stage_kind: source_stage_kind.to_string(),
        producer_build_identity: build_identity,
        producer_plan_snapshot: FemRelaxationProducerPlanSnapshot {
            namespace: FEM_RELAXATION_PRODUCER_PLAN_NAMESPACE_V1.to_string(),
            encoding: "utf-8-json-bytes".to_string(),
            preimage_json: plan_preimage_json,
            raw_sha256: bytes_sha256(&plan_bytes),
            framed_sha256: framed_sha256(FEM_RELAXATION_PRODUCER_PLAN_NAMESPACE_V1, &plan_bytes),
        },
        source_mesh_topology_sha256: crate::types::fem_mesh_topology_fingerprint(&source_mesh),
        equilibrium_content_sha256: crate::types::recomputed_fem_equilibrium_content_sha256(
            equilibrium_magnetization,
        ),
        equilibrium_material_signature: source_identity.equilibrium_material_signature,
        equilibrium_static_physics_signature: source_identity
            .equilibrium_static_physics_signature,
        equilibrium_boundary_signature: source_identity.equilibrium_boundary_signature,
        payloads: FemRelaxationProducerPayloads {
            accepted_fields: FemRelaxationProducerPayloadRef {
                path: accepted_fields_path.to_string(),
                schema_version: accepted_fields.schema_version.clone(),
                raw_bytes_sha256: bytes_sha256(accepted_fields_json),
                content_sha256: accepted_fields.content_sha256.clone(),
            },
            certified_fields: FemRelaxationProducerPayloadRef {
                path: certified_fields_path.to_string(),
                schema_version: certified_fields.schema_version.clone(),
                raw_bytes_sha256: bytes_sha256(certified_fields_json),
                content_sha256: certified_fields.content_sha256.clone(),
            },
            recomputed_certificate: FemRelaxationProducerPayloadRef {
                path: recomputed_certificate_path.to_string(),
                schema_version: recomputed_certificate.schema_version.clone(),
                raw_bytes_sha256: bytes_sha256(recomputed_certificate_json),
                content_sha256: recomputed_certificate.content_sha256.clone(),
            },
        },
        cross_build_policy: "same_source_snapshot_required".to_string(),
    };
    provenance.validate_for_handoff(
        source_run_id,
        source_stage_id,
        source_stage_kind,
        source_plan,
        &accepted_fields,
        &certified_fields,
        &recomputed_certificate,
        &AcceptedFemRelaxExactArtifacts {
            accepted_fields_json: accepted_fields_json.to_vec(),
            certified_fields_json: certified_fields_json.to_vec(),
            recomputed_certificate_json: recomputed_certificate_json.to_vec(),
        },
    )?;
    Ok(provenance)
}

/// Canonical sample-local copy of the producer sidecar.  The payload refs
/// inside the sidecar deliberately retain the producer's source paths; the
/// sample-local path identifies which modal result consumed that source
/// bundle and is what the multi-k manifest indexes.
pub(crate) fn fem_relaxation_producer_provenance_sample_relative_path(
    sample_index: usize,
) -> String {
    format!(
        "eigen/metadata/sample_{sample_index:04}/producer_provenance.v1.json"
    )
}

pub(super) fn consumer_plan_snapshot_relative_path(sample_index: usize) -> String {
    format!(
        "eigen/metadata/sample_{sample_index:04}/{CONSUMER_PLAN_SNAPSHOT_FILENAME}"
    )
}

/// Serialize the consumer plan once at the artifact boundary.  The returned
/// bytes are both the sidecar payload and the input to the identity digest;
/// consumers therefore have an exact replay preimage rather than a
/// reconstruction opportunity.
pub(super) fn consumer_plan_snapshot_bytes(
    plan: &FemEigenPlanIR,
) -> Result<Vec<u8>, RunError> {
    serde_json::to_vec(plan).map_err(|error| RunError {
        message: format!("consumer_plan_snapshot_serialization_failed: {error}"),
    })
}

pub(super) fn consumer_plan_snapshot_bytes_and_sha256(
    plan: &FemEigenPlanIR,
) -> Result<(Vec<u8>, String), RunError> {
    let bytes = consumer_plan_snapshot_bytes(plan)?;
    let digest = bytes_sha256(&bytes);
    Ok((bytes, digest))
}

#[derive(Debug, Clone)]
pub(super) struct AcceptedFemRelaxStageReplayPayload {
    pub(super) accepted_fields: crate::types::CertifiedFemEquilibriumFields,
    pub(super) certified_fields: crate::types::CertifiedFemEquilibriumFields,
    pub(super) recomputed_certificate:
        crate::types::RecomputedFemLinearizationCertificateV1,
    pub(super) accepted_fields_json: Vec<u8>,
    pub(super) certified_fields_json: Vec<u8>,
    pub(super) recomputed_certificate_json: Vec<u8>,
    /// Exact UTF-8 JSON bytes used as the certificate digest preimage. Keep
    /// this beside the typed certificate so downstream non-shared replay can
    /// publish the producer preimage without substituting the certificate
    /// body or reserializing it independently.
    pub(super) recomputed_certificate_preimage_json: String,
    pub(super) producer_provenance: FemRelaxationProducerProvenance,
    /// Bytes read from the producer sidecar.  Keep these separate from the
    /// typed value: serde round-tripping can change whitespace and object
    /// member order, which would invalidate an exact replay claim.
    pub(super) producer_provenance_json: Vec<u8>,
    pub(super) producer_build_identity: serde_json::Value,
    pub(super) producer_plan_snapshot_sha256: String,
    pub(super) equilibrium_material_signature: String,
    pub(super) equilibrium_material_preimage_json: String,
    pub(super) equilibrium_static_physics_signature: String,
    pub(super) equilibrium_static_physics_preimage_json: String,
    pub(super) equilibrium_boundary_signature: String,
    pub(super) equilibrium_boundary_preimage_json: String,
    pub(super) material_provenance_signature: String,
    pub(super) material_provenance_preimage_json: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(super) struct LinearizationIdentityV2 {
    pub(super) schema_version: String,
    pub(super) sample_index: usize,
    pub(super) equilibrium_artifact_schema: String,
    pub(super) linearization_state_schema: String,
    pub(super) accepted_fields_schema: String,
    pub(super) certified_fields_schema: String,
    pub(super) recomputed_certificate_schema: String,
    pub(super) handoff_schema_version: String,
    pub(super) handoff_content_sha256: String,
    pub(super) source_run_id: String,
    pub(super) source_stage_id: String,
    pub(super) source_stage_kind: String,
    pub(super) producer_plan_snapshot_sha256: String,
    pub(super) consumer_plan_snapshot_sha256: String,
    pub(super) producer_build_identity: serde_json::Value,
    pub(super) consumer_build_identity: serde_json::Value,
    pub(super) producer_source_snapshot_sha256: String,
    pub(super) consumer_source_snapshot_sha256: String,
    pub(super) cross_build_policy: String,
    pub(super) source_mesh_topology_sha256: String,
    pub(super) modal_mesh_topology_fingerprint_v3: String,
    pub(super) node_count: usize,
    pub(super) equilibrium_content_sha256: String,
    pub(super) equilibrium_artifact_path: String,
    pub(super) equilibrium_artifact_sha256: String,
    pub(super) linearization_state_path: String,
    pub(super) linearization_state_sha256: String,
    pub(super) equilibrium_material_signature: String,
    pub(super) equilibrium_material_preimage_json: String,
    pub(super) equilibrium_static_physics_signature: String,
    pub(super) equilibrium_static_physics_preimage_json: String,
    pub(super) equilibrium_boundary_signature: String,
    pub(super) equilibrium_boundary_preimage_json: String,
    pub(super) material_signature: String,
    pub(super) material_identity_kind: String,
    pub(super) material_provenance_signature: String,
    pub(super) material_provenance_scope: String,
    pub(super) material_provenance_preimage_json: String,
    pub(super) producer_material_provenance_signature: String,
    pub(super) producer_material_provenance_preimage_json: String,
    pub(super) accepted_fields_content_sha256: String,
    pub(super) accepted_fields_path: String,
    pub(super) certified_fields_content_sha256: String,
    pub(super) certified_fields_path: String,
    pub(super) recomputed_certificate_content_sha256: String,
    pub(super) recomputed_certificate_path: String,
    pub(super) accepted_fields_bytes_sha256: String,
    pub(super) certified_fields_bytes_sha256: String,
    pub(super) recomputed_certificate_bytes_sha256: String,
    pub(super) recomputed_certificate_preimage_json: String,
    pub(super) recomputed_certificate_preimage_sha256: String,
    pub(super) content_sha256: String,
}

/// Exact, independently replayable preimage for one `linearization_identity.v2`
/// record.  The identity itself is published as a human-readable JSON
/// artifact, while this sidecar carries the compact serde bytes that were
/// actually framed and hashed by the producer.  It intentionally has no
/// self-digest: `identity_content_sha256` is the digest of the linked identity
/// and the two SHA fields bind the supplied preimage bytes without introducing
/// a circular hash.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(super) struct LinearizationIdentityPreimageV1 {
    pub(super) schema_version: String,
    pub(super) identity_schema: String,
    pub(super) identity_preimage_json: String,
    pub(super) identity_preimage_sha256: String,
    pub(super) identity_content_sha256: String,
}

impl AcceptedFemRelaxStageReplayPayload {
    fn from_exact_artifacts(
        source_run_id: &str,
        source_stage_id: &str,
        source_stage_kind: &str,
        source_plan: &fullmag_ir::FemPlanIR,
        accepted_fields: crate::types::CertifiedFemEquilibriumFields,
        certified_fields: crate::types::CertifiedFemEquilibriumFields,
        recomputed_certificate: crate::types::RecomputedFemLinearizationCertificateV1,
        exact_artifacts: AcceptedFemRelaxExactArtifacts,
        producer_provenance: FemRelaxationProducerProvenance,
        producer_provenance_json: Vec<u8>,
    ) -> Result<Self, RunError> {
        let decoded_accepted = serde_json::from_slice::<
            crate::types::CertifiedFemEquilibriumFields,
        >(&exact_artifacts.accepted_fields_json)
        .map_err(|error| RunError {
            message: format!(
                "relax_stage_handoff_accepted_fields_exact_bytes_invalid: {error}"
            ),
        })?;
        let decoded_certified = serde_json::from_slice::<
            crate::types::CertifiedFemEquilibriumFields,
        >(&exact_artifacts.certified_fields_json)
        .map_err(|error| RunError {
            message: format!(
                "relax_stage_handoff_certified_fields_exact_bytes_invalid: {error}"
            ),
        })?;
        let decoded_recomputed = serde_json::from_slice::<
            crate::types::RecomputedFemLinearizationCertificateV1,
        >(&exact_artifacts.recomputed_certificate_json)
        .map_err(|error| RunError {
            message: format!(
                "relax_stage_handoff_recomputed_certificate_exact_bytes_invalid: {error}"
            ),
        })?;
        if decoded_accepted != accepted_fields {
            return Err(RunError {
                message: "relax_stage_handoff_accepted_fields_exact_bytes_value_mismatch"
                    .to_string(),
            });
        }
        if decoded_certified != certified_fields {
            return Err(RunError {
                message: "relax_stage_handoff_certified_fields_exact_bytes_value_mismatch"
                    .to_string(),
            });
        }
        if decoded_recomputed != recomputed_certificate {
            return Err(RunError {
                message:
                    "relax_stage_handoff_recomputed_certificate_exact_bytes_value_mismatch"
                        .to_string(),
            });
        }
        producer_provenance.validate_for_handoff(
            source_run_id,
            source_stage_id,
            source_stage_kind,
            source_plan,
            &accepted_fields,
            &certified_fields,
            &recomputed_certificate,
            &exact_artifacts,
        )?;
        let decoded_producer_provenance =
            serde_json::from_slice::<FemRelaxationProducerProvenance>(
                &producer_provenance_json,
            )
            .map_err(|error| RunError {
                message: format!(
                    "relax_stage_handoff_producer_provenance_exact_bytes_invalid: {error}"
                ),
            })?;
        if decoded_producer_provenance != producer_provenance {
            return Err(RunError {
                message:
                    "relax_stage_handoff_producer_provenance_exact_bytes_value_mismatch"
                        .to_string(),
            });
        }
        let producer_build_identity = serde_json::to_value(
            &producer_provenance.producer_build_identity,
        )
        .map_err(|error| RunError {
            message: format!(
                "linearization_identity_producer_build_identity_encode_failed: {error}"
            ),
        })?;
        let producer_plan_snapshot_sha256 =
            producer_provenance.producer_plan_snapshot.framed_sha256.clone();
        let source_identity =
            super::equilibrium_identity::EquilibriumIdentitySignaturesV1::from_relax_plan(
                source_plan,
            )?;
        let (material_provenance_signature, material_provenance_preimage_json) =
            raw_material_provenance(source_plan)?;
        let recomputed_certificate_preimage_bytes =
            crate::types::recomputed_fem_linearization_certificate_preimage_bytes(
                &recomputed_certificate,
            )?;
        let recomputed_certificate_preimage_json =
            String::from_utf8(recomputed_certificate_preimage_bytes).map_err(|error| {
                RunError {
                    message: format!(
                        "relax_stage_handoff_recomputed_certificate_preimage_not_utf8: {error}"
                    ),
                }
            })?;
        Ok(Self {
            accepted_fields,
            certified_fields,
            recomputed_certificate,
            accepted_fields_json: exact_artifacts.accepted_fields_json,
            certified_fields_json: exact_artifacts.certified_fields_json,
            recomputed_certificate_json: exact_artifacts.recomputed_certificate_json,
            recomputed_certificate_preimage_json,
            producer_provenance,
            producer_provenance_json,
            producer_build_identity,
            producer_plan_snapshot_sha256,
            equilibrium_material_signature: source_identity.equilibrium_material_signature,
            equilibrium_material_preimage_json: source_identity
                .equilibrium_material_preimage_json,
            equilibrium_static_physics_signature: source_identity
                .equilibrium_static_physics_signature,
            equilibrium_static_physics_preimage_json: source_identity
                .equilibrium_static_physics_preimage_json,
            equilibrium_boundary_signature: source_identity.equilibrium_boundary_signature,
            equilibrium_boundary_preimage_json: source_identity
                .equilibrium_boundary_preimage_json,
            material_provenance_signature,
            material_provenance_preimage_json,
        })
    }
}

fn raw_material_provenance(
    source_plan: &fullmag_ir::FemPlanIR,
) -> Result<(String, String), RunError> {
    let bytes = serde_json::to_vec(&source_plan.material).map_err(|error| RunError {
        message: format!("linearization_identity_material_preimage_serialization_failed: {error}"),
    })?;
    let preimage = String::from_utf8(bytes.clone()).map_err(|error| RunError {
        message: format!("linearization_identity_material_preimage_not_utf8: {error}"),
    })?;
    let signature = super::eigen_digest::shared_domain_content_digest(
        "material_signature",
        &source_plan.material,
    )?;
    Ok((signature, preimage))
}

fn strict_build_identity_snapshot(
    identity: &serde_json::Value,
    role: &str,
) -> Result<String, RunError> {
    let snapshot = identity
        .get("source_snapshot_sha256")
        .and_then(serde_json::Value::as_str)
        .filter(|value| is_strict_source_snapshot_sha256(value))
        .ok_or_else(|| RunError {
            message: format!(
                "linearization_identity_missing_{role}_source_snapshot_sha256"
            ),
        })?;
    Ok(snapshot.to_string())
}

pub(super) fn validate_linearization_identity_source_snapshots(
    identity: &LinearizationIdentityV2,
) -> Result<(), RunError> {
    if identity.cross_build_policy != "same_source_snapshot_required" {
        return Err(RunError {
            message: "linearization_identity_cross_build_policy_violation".to_string(),
        });
    }

    let producer_build_snapshot =
        strict_build_identity_snapshot(&identity.producer_build_identity, "producer")?;
    let consumer_build_snapshot =
        strict_build_identity_snapshot(&identity.consumer_build_identity, "consumer")?;

    if !is_strict_source_snapshot_sha256(&identity.producer_source_snapshot_sha256)
        || !is_strict_source_snapshot_sha256(&identity.consumer_source_snapshot_sha256)
    {
        return Err(RunError {
            message: "linearization_identity_source_snapshot_format_invalid".to_string(),
        });
    }
    if identity.producer_source_snapshot_sha256 != producer_build_snapshot
        || identity.consumer_source_snapshot_sha256 != consumer_build_snapshot
    {
        return Err(RunError {
            message: "linearization_identity_source_snapshot_binding_mismatch".to_string(),
        });
    }
    if producer_build_snapshot != consumer_build_snapshot
        || identity.producer_source_snapshot_sha256
            != identity.consumer_source_snapshot_sha256
    {
        return Err(RunError {
            message: "linearization_identity_cross_build_source_snapshot_mismatch".to_string(),
        });
    }
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(super) struct AcceptedFemRelaxStageHandoffV2Record {
    pub(super) schema_version: String,
    pub(super) source_run_id: String,
    pub(super) source_stage_id: String,
    pub(super) source_stage_kind: String,
    pub(super) stage_fem_mesh_generation_id: String,
    pub(super) source_mesh_topology_sha256: String,
    pub(super) node_count: usize,
    pub(super) indexing_sha256: String,
    pub(super) part_registry_sha256: String,
    pub(super) completion_sha256: String,
    pub(super) completion: fullmag_ir::StageCompletionIR,
    pub(super) acceptance: AcceptedEquilibriumCriterion,
    pub(super) equilibrium_content_sha256: String,
    pub(super) content_sha256: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)] // Wired by the next migration slice.
pub(super) struct AcceptedFemRelaxStageHandoffV3HashPreimage {
    pub(super) schema_version: String,
    pub(super) legacy_v2_content_sha256: String,
    pub(super) acceptance_certificate_sha256: String,
    pub(super) certified_fields_content_sha256: String,
    pub(super) equilibrium_material_signature: String,
    pub(super) equilibrium_static_physics_signature: String,
    pub(super) equilibrium_boundary_signature: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(super) struct AcceptedFemRelaxStageHandoffV3Record {
    pub(super) schema_version: String,
    pub(super) source_run_id: String,
    pub(super) source_stage_id: String,
    pub(super) source_stage_kind: String,
    pub(super) stage_fem_mesh_generation_id: String,
    pub(super) source_mesh_topology_sha256: String,
    pub(super) node_count: usize,
    pub(super) indexing_sha256: String,
    pub(super) part_registry_sha256: String,
    pub(super) completion_sha256: String,
    pub(super) completion: fullmag_ir::StageCompletionIR,
    pub(super) acceptance: AcceptedEquilibriumCriterion,
    pub(super) equilibrium_content_sha256: String,
    pub(super) legacy_v2_content_sha256: String,
    pub(super) acceptance_certificate_sha256: String,
    pub(super) equilibrium_magnetization: Vec<Vector3>,
    pub(super) certified_fields: crate::types::CertifiedFemEquilibriumFields,
    pub(super) certified_fields_content_sha256: String,
    pub(super) equilibrium_material_signature: String,
    pub(super) equilibrium_static_physics_signature: String,
    pub(super) equilibrium_boundary_signature: String,
    pub(super) content_sha256: String,
}

impl AcceptedEquilibriumCriterion {
    pub(super) fn metric_kind_name(&self) -> &'static str {
        match self.metric_kind {
            fullmag_ir::StageMetricKind::MaxTorqueApm => "max_torque_apm",
            fullmag_ir::StageMetricKind::TotalEnergyPlateauRangeJ => "total_energy_plateau_range_j",
            _ => unreachable!("accepted equilibrium uses only torque or energy"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct AcceptedFemRelaxStageHandoff {
    pub(super) schema_version: String,
    pub(super) source_run_id: String,
    pub(super) source_stage_id: String,
    pub(super) source_stage_kind: String,
    pub(super) stage_fem_mesh_generation_id: String,
    pub(super) source_mesh_topology_sha256: String,
    pub(super) node_count: usize,
    pub(super) indexing_sha256: String,
    pub(super) part_registry_sha256: String,
    pub(super) completion_sha256: String,
    pub(super) completion: fullmag_ir::StageCompletionIR,
    pub(super) acceptance: AcceptedEquilibriumCriterion,
    pub(super) equilibrium_content_sha256: String,
    pub(super) equilibrium_magnetization: Vec<Vector3>,
    pub(super) certified_fields: crate::types::CertifiedFemEquilibriumFields,
    pub(super) legacy_v2_content_sha256: String,
    pub(super) acceptance_certificate_sha256: String,
    pub(super) equilibrium_material_signature: String,
    pub(super) equilibrium_static_physics_signature: String,
    pub(super) equilibrium_boundary_signature: String,
    pub(super) content_sha256: String,
    pub(super) verified_replay: Option<AcceptedFemRelaxStageReplayPayload>,
}

impl AcceptedFemRelaxStageHandoff {
    /// Construct a handoff only after independently replaying the native
    /// accepted endpoint against the refreshed/recomputed endpoint.  The
    /// accepted payload is deliberately passed separately from the certified
    /// payload so callers cannot satisfy this gate with a second decode of the
    /// same artifact.  Production callers in the runner and CLI must use this
    /// constructor; the legacy constructor remains available for compatibility
    /// with older in-crate fixtures and serialized handoffs.
    pub fn from_completed_relax_verified(
        source_run_id: &str,
        source_stage_id: &str,
        source_stage_kind: &str,
        source_stage_is_relaxation: bool,
        source_plan: &fullmag_ir::FemPlanIR,
        source_mesh: &crate::types::FemMeshPayload,
        completion: &fullmag_ir::StageCompletionIR,
        equilibrium_magnetization: Vec<Vector3>,
        accepted_fields: crate::types::CertifiedFemEquilibriumFields,
        certified_fields: crate::types::CertifiedFemEquilibriumFields,
        recomputed_certificate: crate::types::RecomputedFemLinearizationCertificateV1,
    ) -> Result<Self, RunError> {
        crate::validate_recomputed_fem_linearization_certificate(
            source_plan,
            source_mesh,
            &equilibrium_magnetization,
            &accepted_fields,
            &certified_fields,
            &recomputed_certificate,
        )?;
        Self::from_completed_relax(
            source_run_id,
            source_stage_id,
            source_stage_kind,
            source_stage_is_relaxation,
            source_plan,
            source_mesh,
            completion,
            equilibrium_magnetization,
            certified_fields,
        )
    }

    /// Verified constructor used by live producers.  In addition to the
    /// typed replay gate it retains the exact JSON bytes emitted by the
    /// relaxation stage.  The older verified constructor above remains a
    /// compatibility API, but cannot advertise an exact-byte R4 identity.
    pub fn from_completed_relax_verified_with_exact_artifacts(
        source_run_id: &str,
        source_stage_id: &str,
        source_stage_kind: &str,
        source_stage_is_relaxation: bool,
        source_plan: &fullmag_ir::FemPlanIR,
        source_mesh: &crate::types::FemMeshPayload,
        completion: &fullmag_ir::StageCompletionIR,
        equilibrium_magnetization: Vec<Vector3>,
        accepted_fields: crate::types::CertifiedFemEquilibriumFields,
        certified_fields: crate::types::CertifiedFemEquilibriumFields,
        recomputed_certificate: crate::types::RecomputedFemLinearizationCertificateV1,
        exact_artifacts: AcceptedFemRelaxExactArtifacts,
    ) -> Result<Self, RunError> {
        let _ = (
            source_run_id,
            source_stage_id,
            source_stage_kind,
            source_stage_is_relaxation,
            source_plan,
            source_mesh,
            completion,
            equilibrium_magnetization,
            accepted_fields,
            certified_fields,
            recomputed_certificate,
            exact_artifacts,
        );
        Err(RunError {
            message: "relax_stage_handoff_exact_producer_provenance_required".to_string(),
        })
    }

    /// Verified constructor that requires the producer-published sidecar and
    /// its original bytes.  The sidecar is validated against those exact
    /// bytes before the handoff can advertise `verified_replay`.
    pub fn from_completed_relax_verified_with_exact_artifacts_and_provenance(
        source_run_id: &str,
        source_stage_id: &str,
        source_stage_kind: &str,
        source_stage_is_relaxation: bool,
        source_plan: &fullmag_ir::FemPlanIR,
        source_mesh: &crate::types::FemMeshPayload,
        completion: &fullmag_ir::StageCompletionIR,
        equilibrium_magnetization: Vec<Vector3>,
        accepted_fields: crate::types::CertifiedFemEquilibriumFields,
        certified_fields: crate::types::CertifiedFemEquilibriumFields,
        recomputed_certificate: crate::types::RecomputedFemLinearizationCertificateV1,
        exact_artifacts: AcceptedFemRelaxExactArtifacts,
        producer_provenance: FemRelaxationProducerProvenance,
        producer_provenance_json: Vec<u8>,
    ) -> Result<Self, RunError> {
        crate::validate_recomputed_fem_linearization_certificate(
            source_plan,
            source_mesh,
            &equilibrium_magnetization,
            &accepted_fields,
            &certified_fields,
            &recomputed_certificate,
        )?;
        let replay = AcceptedFemRelaxStageReplayPayload::from_exact_artifacts(
            source_run_id,
            source_stage_id,
            source_stage_kind,
            source_plan,
            accepted_fields.clone(),
            certified_fields.clone(),
            recomputed_certificate.clone(),
            exact_artifacts,
            producer_provenance,
            producer_provenance_json,
        )?;
        let mut handoff = Self::from_completed_relax(
            source_run_id,
            source_stage_id,
            source_stage_kind,
            source_stage_is_relaxation,
            source_plan,
            source_mesh,
            completion,
            equilibrium_magnetization,
            certified_fields,
        )?;
        handoff.verified_replay = Some(replay);
        Ok(handoff)
    }

    pub(super) fn from_completed_relax(
        source_run_id: &str,
        source_stage_id: &str,
        source_stage_kind: &str,
        source_stage_is_relaxation: bool,
        source_plan: &fullmag_ir::FemPlanIR,
        source_mesh: &crate::types::FemMeshPayload,
        completion: &fullmag_ir::StageCompletionIR,
        equilibrium_magnetization: Vec<Vector3>,
        certified_fields: crate::types::CertifiedFemEquilibriumFields,
    ) -> Result<Self, RunError> {
        if source_run_id.trim().is_empty()
            || source_stage_id.trim().is_empty()
            || source_stage_kind.trim().is_empty()
            || !source_stage_is_relaxation
        {
            return Err(RunError {
                message: "relax_stage_handoff_invalid_source_stage: source run/stage identity must name an executed relaxation stage"
                    .to_string(),
            });
        }
        let acceptance = accepted_equilibrium_criterion(completion)?;
        if equilibrium_magnetization.len() != source_mesh.nodes.len()
            || equilibrium_magnetization
                .iter()
                .flatten()
                .any(|value| !value.is_finite())
        {
            return Err(RunError {
                message: format!(
                    "relax_stage_handoff_invalid_equilibrium: expected {} finite vectors, got {}",
                    source_mesh.nodes.len(),
                    equilibrium_magnetization.len()
                ),
            });
        }
        validate_certified_equilibrium_fields(&certified_fields, source_mesh.nodes.len())?;
        if certified_fields.h_anisotropy_a_per_m.is_some()
            != source_plan.material.uniaxial_anisotropy.is_some()
        {
            return Err(RunError {
                message: "relax_stage_handoff_anisotropy_schema_material_mismatch".to_string(),
            });
        }
        let source_plan_mesh = crate::types::FemMeshPayload::from(source_plan);
        if crate::types::fem_mesh_topology_fingerprint(&source_plan_mesh)
            != crate::types::fem_mesh_topology_fingerprint(source_mesh)
        {
            return Err(RunError {
                message: "relax_stage_handoff_source_plan_mesh_identity_mismatch".to_string(),
            });
        }
        // Publishing a native relaxation state must not instantiate the tet4-only
        // reference solver. Validate the full typed mesh, then use the same
        // magnetic-node membership as the native runtime (including mixed cells).
        fullmag_ir::validate_mesh_for_execution(&source_plan.mesh).map_err(|errors| RunError {
            message: format!(
                "relax_stage_handoff_source_mesh_topology_invalid: {}",
                errors.join("; ")
            ),
        })?;
        let source_magnetic_nodes =
            crate::preview::mesh_quantity_active_mask("m", &source_plan.mesh)
                .expect("magnetization has a magnetic-only spatial domain");
        validate_handoff_m0_norms(&equilibrium_magnetization, &source_magnetic_nodes)?;
        let source_signatures =
            crate::fem::equilibrium_identity::EquilibriumIdentitySignaturesV1::from_relax_plan(
                source_plan,
            )?;

        let source_mesh_topology_sha256 = crate::types::fem_mesh_topology_fingerprint(source_mesh);
        let stage_fem_mesh_generation_id = source_mesh
            .generation_id
            .as_deref()
            .ok_or_else(|| RunError {
                message: "relax_stage_handoff_missing_mesh_generation_id".to_string(),
            })?
            .to_string();
        // `generation_id` is the cache-invalidating stage identity.  Since the
        // current master carries a payload/cache identity (rather than the
        // topology SHA itself), bind both identities independently.  Accept
        // the historical topology-SHA form during migration, but reject an
        // identity which does not come from the source plan/payload.
        let expected_generation_id = crate::types::FemMeshPayload::from(source_plan)
            .generation_id
            .unwrap_or_default();
        if (stage_fem_mesh_generation_id != expected_generation_id
            && stage_fem_mesh_generation_id != source_mesh_topology_sha256)
            || !is_sha256_digest(&source_mesh_topology_sha256)
        {
            return Err(RunError {
                message: "relax_stage_handoff_mesh_generation_or_topology_identity_mismatch"
                    .to_string(),
            });
        }

        let indexing_sha256 = shared_domain_content_digest(
            "relax_stage_mesh_indexing",
            &serde_json::json!({
                "cells": source_mesh.cells,
                "element_markers": source_mesh.element_markers,
                "facets": source_mesh.facets,
                "boundary_markers": source_mesh.boundary_markers,
                "periodic_boundary_pairs": source_mesh.periodic_boundary_pairs,
                "periodic_node_pairs": source_mesh.periodic_node_pairs,
            }),
        )?;
        let part_registry_sha256 = shared_domain_content_digest(
            "relax_stage_mesh_part_registry",
            &serde_json::json!({
                "object_segments": source_mesh.object_segments,
                "mesh_parts": source_mesh.mesh_parts,
                "domain_mesh_mode": source_mesh.domain_mesh_mode,
                "domain_frame": source_mesh.domain_frame,
            }),
        )?;
        let completion_sha256 = shared_domain_content_digest(
            "relax_stage_completion",
            &serde_json::to_value(completion).map_err(|error| RunError {
                message: format!("relax_stage_handoff_completion_serialization_failed: {error}"),
            })?,
        )?;
        let acceptance_certificate_sha256 = shared_domain_content_digest(
            "relax_stage_acceptance_certificate",
            &serde_json::to_value(&acceptance).map_err(|error| RunError {
                message: format!("relax_stage_handoff_acceptance_serialization_failed: {error}"),
            })?,
        )?;
        let equilibrium_content_sha256 = vector_field_content_sha256(&equilibrium_magnetization);
        let node_count = source_mesh.nodes.len();
        let v2_record = AcceptedFemRelaxStageHandoffV2Record {
            schema_version: ACCEPTED_FEM_RELAX_STAGE_HANDOFF_V2.to_string(),
            source_run_id: source_run_id.to_string(),
            source_stage_id: source_stage_id.to_string(),
            source_stage_kind: source_stage_kind.to_string(),
            stage_fem_mesh_generation_id: stage_fem_mesh_generation_id.clone(),
            source_mesh_topology_sha256: source_mesh_topology_sha256.clone(),
            node_count,
            indexing_sha256: indexing_sha256.clone(),
            part_registry_sha256: part_registry_sha256.clone(),
            completion_sha256: completion_sha256.clone(),
            completion: completion.clone(),
            acceptance: acceptance.clone(),
            equilibrium_content_sha256: equilibrium_content_sha256.clone(),
            content_sha256: String::new(),
        };
        let legacy_v2_content_sha256 = relax_stage_handoff_v2_content_sha256(&v2_record)?;
        let v3_preimage = AcceptedFemRelaxStageHandoffV3HashPreimage {
            schema_version: ACCEPTED_FEM_RELAX_STAGE_HANDOFF_V3.to_string(),
            legacy_v2_content_sha256: legacy_v2_content_sha256.clone(),
            acceptance_certificate_sha256: acceptance_certificate_sha256.clone(),
            certified_fields_content_sha256: certified_fields.content_sha256.clone(),
            equilibrium_material_signature: source_signatures
                .equilibrium_material_signature
                .clone(),
            equilibrium_static_physics_signature: source_signatures
                .equilibrium_static_physics_signature
                .clone(),
            equilibrium_boundary_signature: source_signatures
                .equilibrium_boundary_signature
                .clone(),
        };
        let content_sha256 = relax_stage_handoff_v3_content_sha256(&v3_preimage)?;
        Ok(Self {
            schema_version: ACCEPTED_FEM_RELAX_STAGE_HANDOFF_V3.to_string(),
            source_run_id: source_run_id.to_string(),
            source_stage_id: source_stage_id.to_string(),
            source_stage_kind: source_stage_kind.to_string(),
            stage_fem_mesh_generation_id,
            source_mesh_topology_sha256,
            node_count,
            indexing_sha256,
            part_registry_sha256,
            completion_sha256,
            completion: completion.clone(),
            acceptance,
            equilibrium_content_sha256,
            equilibrium_magnetization,
            certified_fields,
            legacy_v2_content_sha256,
            acceptance_certificate_sha256,
            equilibrium_material_signature: source_signatures.equilibrium_material_signature,
            equilibrium_static_physics_signature: source_signatures
                .equilibrium_static_physics_signature,
            equilibrium_boundary_signature: source_signatures.equilibrium_boundary_signature,
            content_sha256,
            verified_replay: None,
        })
    }

    /// Validate the pre-conversion relaxation target.  This intentionally
    /// accepts only the authored `RelaxedInitialState`/single-k shape; the
    /// caller must run the separate provided-continuation validator after it
    /// changes the source marker.
    pub(super) fn validate_target_plan(&self, plan: &FemEigenPlanIR) -> Result<(), RunError> {
        self.validate_plan_binding(plan, false)
    }

    /// Validate the post-conversion continuation target.  A multi-k path may
    /// reuse one accepted static relaxation, but a field sweep may not: each
    /// sweep sample is a different physical equilibrium.  All m0, mesh,
    /// material, static-physics, boundary and handoff digests are still
    /// checked by the shared binding routine.
    pub(super) fn validate_provided_continuation_plan(
        &self,
        plan: &FemEigenPlanIR,
    ) -> Result<(), RunError> {
        self.validate_plan_binding(plan, true)
    }

    fn validate_plan_binding(
        &self,
        plan: &FemEigenPlanIR,
        provided_continuation: bool,
    ) -> Result<(), RunError> {
        if self.schema_version != ACCEPTED_FEM_RELAX_STAGE_HANDOFF_V3 {
            return Err(RunError {
                message: "relax_stage_handoff_v3_schema_version_mismatch".to_string(),
            });
        }
        let accepted = accepted_equilibrium_criterion(&self.completion)?;
        if accepted != self.acceptance {
            return Err(RunError {
                message: "relax_stage_handoff_acceptance_certificate_mismatch".to_string(),
            });
        }
        let completion_sha256 = shared_domain_content_digest(
            "relax_stage_completion",
            &serde_json::to_value(&self.completion).map_err(|error| RunError {
                message: format!("relax_stage_handoff_completion_serialization_failed: {error}"),
            })?,
        )?;
        if completion_sha256 != self.completion_sha256 {
            return Err(RunError {
                message: "relax_stage_handoff_completion_sha256_mismatch".to_string(),
            });
        }
        let acceptance_certificate_sha256 = shared_domain_content_digest(
            "relax_stage_acceptance_certificate",
            &serde_json::to_value(&self.acceptance).map_err(|error| RunError {
                message: format!("relax_stage_handoff_acceptance_serialization_failed: {error}"),
            })?,
        )?;
        if acceptance_certificate_sha256 != self.acceptance_certificate_sha256 {
            return Err(RunError {
                message: "relax_stage_handoff_acceptance_certificate_sha256_mismatch".to_string(),
            });
        }
        validate_certified_equilibrium_fields(&self.certified_fields, self.node_count)?;
        if self.certified_fields.h_anisotropy_a_per_m.is_some()
            != plan.material.uniaxial_anisotropy.is_some()
        {
            return Err(RunError {
                message: "relax_stage_handoff_anisotropy_schema_material_mismatch".to_string(),
            });
        }
        let target_signatures =
            crate::fem::equilibrium_identity::EquilibriumIdentitySignaturesV1::from_eigen_plan(
                plan,
            )?;
        if target_signatures.equilibrium_material_signature != self.equilibrium_material_signature {
            return Err(RunError {
                message: "relax_stage_handoff_equilibrium_material_signature_mismatch".to_string(),
            });
        }
        if target_signatures.equilibrium_static_physics_signature
            != self.equilibrium_static_physics_signature
        {
            return Err(RunError {
                message: "relax_stage_handoff_equilibrium_static_physics_signature_mismatch"
                    .to_string(),
            });
        }
        if target_signatures.equilibrium_boundary_signature != self.equilibrium_boundary_signature {
            return Err(RunError {
                message: "relax_stage_handoff_equilibrium_boundary_signature_mismatch".to_string(),
            });
        }
        if provided_continuation {
            if !matches!(plan.equilibrium, EquilibriumSourceIR::Provided) {
                return Err(RunError {
                    message:
                        "relax_stage_handoff_requires_provided_equilibrium_continuation_target"
                            .to_string(),
                });
            }
            if !plan.bias_field_samples.is_empty() {
                return Err(RunError {
                    message:
                        "relax_stage_handoff_provided_continuation_rejects_bias_field_sweep"
                            .to_string(),
                });
            }
        } else {
            if !matches!(plan.equilibrium, EquilibriumSourceIR::RelaxedInitialState) {
                return Err(RunError {
                    message: "relax_stage_handoff_requires_relaxed_initial_state_target"
                        .to_string(),
                });
            }
            if matches!(plan.k_sampling, Some(KSamplingIR::Path { .. }))
                || !plan.bias_field_samples.is_empty()
            {
                return Err(RunError {
                    message: "relax_stage_handoff_requires_single_k_target".to_string(),
                });
            }
        }
        let target_mesh = crate::types::FemMeshPayload::from(plan);
        let target_topology = crate::types::fem_mesh_topology_fingerprint(&target_mesh);
        let target_generation = target_mesh.generation_id.as_deref().unwrap_or_default();
        let target_indexing = shared_domain_content_digest(
            "relax_stage_mesh_indexing",
            &serde_json::json!({
                "cells": target_mesh.cells,
                "element_markers": target_mesh.element_markers,
                "facets": target_mesh.facets,
                "boundary_markers": target_mesh.boundary_markers,
                "periodic_boundary_pairs": target_mesh.periodic_boundary_pairs,
                "periodic_node_pairs": target_mesh.periodic_node_pairs,
            }),
        )?;
        let target_parts = shared_domain_content_digest(
            "relax_stage_mesh_part_registry",
            &serde_json::json!({
                "object_segments": target_mesh.object_segments,
                "mesh_parts": target_mesh.mesh_parts,
                "domain_mesh_mode": target_mesh.domain_mesh_mode,
                "domain_frame": target_mesh.domain_frame,
            }),
        )?;
        let generation_matches = target_generation == self.stage_fem_mesh_generation_id
            // Historical handoffs used the topology SHA as generation ID;
            // their target still proves identity through the explicit
            // topology field below.
            || (self.stage_fem_mesh_generation_id == self.source_mesh_topology_sha256
                && target_topology == self.source_mesh_topology_sha256);
        if !generation_matches
            || target_topology != self.source_mesh_topology_sha256
            || target_mesh.nodes.len() != self.node_count
            || target_indexing != self.indexing_sha256
            || target_parts != self.part_registry_sha256
        {
            return Err(RunError {
                message: "relax_stage_handoff_mesh_identity_mismatch: generation/topology/node indexing/part registry must match exactly"
                    .to_string(),
            });
        }
        let target_equilibrium_sha256 =
            vector_field_content_sha256(&plan.equilibrium_magnetization);
        let target_topology = MeshTopology::from_ir(&plan.mesh).map_err(|error| RunError {
            message: format!("relax_stage_handoff_target_mesh_topology_invalid: {error}"),
        })?;
        validate_handoff_m0_norms(
            &plan.equilibrium_magnetization,
            &target_topology
                .magnetic_node_volumes
                .iter()
                .map(|volume| *volume > 0.0)
                .collect::<Vec<_>>(),
        )?;
        if target_equilibrium_sha256 != self.equilibrium_content_sha256
            || plan.equilibrium_magnetization != self.equilibrium_magnetization
        {
            return Err(RunError {
                message: "relax_stage_handoff_equilibrium_content_mismatch".to_string(),
            });
        }
        let legacy_v2_content_sha256 = relax_stage_handoff_v2_content_sha256(&self.v2_record())?;
        if legacy_v2_content_sha256 != self.legacy_v2_content_sha256 {
            return Err(RunError {
                message: "relax_stage_handoff_v2_content_sha256_mismatch".to_string(),
            });
        }
        let recomputed = relax_stage_handoff_v3_content_sha256(&self.v3_hash_preimage())?;
        if recomputed != self.content_sha256 {
            return Err(RunError {
                message: "relax_stage_handoff_content_sha256_mismatch".to_string(),
            });
        }
        Ok(())
    }

    pub(super) fn v3_hash_preimage(&self) -> AcceptedFemRelaxStageHandoffV3HashPreimage {
        AcceptedFemRelaxStageHandoffV3HashPreimage {
            schema_version: self.schema_version.clone(),
            legacy_v2_content_sha256: self.legacy_v2_content_sha256.clone(),
            acceptance_certificate_sha256: self.acceptance_certificate_sha256.clone(),
            certified_fields_content_sha256: self.certified_fields.content_sha256.clone(),
            equilibrium_material_signature: self.equilibrium_material_signature.clone(),
            equilibrium_static_physics_signature: self.equilibrium_static_physics_signature.clone(),
            equilibrium_boundary_signature: self.equilibrium_boundary_signature.clone(),
        }
    }

    #[cfg(test)]
    pub(super) fn legacy_v2_provenance_json(&self) -> serde_json::Value {
        serde_json::to_value(self.v2_record()).expect("frozen v2 handoff must serialize")
    }

    pub(super) fn provenance_json(&self) -> serde_json::Value {
        serde_json::to_value(self.v3_record()).expect("typed v3 handoff must serialize")
    }

    pub fn content_sha256(&self) -> &str {
        &self.content_sha256
    }

    pub fn equilibrium_content_sha256(&self) -> &str {
        &self.equilibrium_content_sha256
    }

    pub(super) fn acceptance_json(&self) -> serde_json::Value {
        serde_json::to_value(&self.acceptance)
            .expect("accepted equilibrium criterion must serialize")
    }

    pub(super) fn verified_replay(&self) -> Option<&AcceptedFemRelaxStageReplayPayload> {
        self.verified_replay.as_ref()
    }

    /// Serialize the producer sidecar exactly as the modal result publishes
    /// it.  This is sourced from the validated producer payload retained in
    /// the handoff; it must never be reconstructed from consumer metadata.
    pub(crate) fn producer_provenance_sidecar_bytes(&self) -> Result<Vec<u8>, RunError> {
        let replay = self.verified_replay.as_ref().ok_or_else(|| RunError {
            message: "relax_stage_handoff_missing_verified_producer_provenance".to_string(),
        })?;
        Ok(replay.producer_provenance_json.clone())
    }

    pub(super) fn build_linearization_identity_v2(
        &self,
        plan: &FemEigenPlanIR,
        state: &SharedDomainLinearizationState,
        sample_index: usize,
        equilibrium_artifact_path: String,
        linearization_state_path: String,
        modal_mesh_topology_fingerprint_v3: String,
        consumer_build_identity: serde_json::Value,
    ) -> Result<(LinearizationIdentityV2, Vec<u8>), RunError> {
        let replay = self.verified_replay.as_ref().ok_or_else(|| RunError {
            message: "linearization_identity_missing_verified_replay_payload".to_string(),
        })?;
        let equilibrium_artifact_schema = required_object_string(
            &state.equilibrium_artifact,
            "schema_version",
            "equilibrium_artifact",
        )?;
        let linearization_state_schema = required_object_string(
            &state.linearization_state,
            "schema_version",
            "linearization_state",
        )?;
        let (canonical_material, accepted_schema, artifact_material_signature) =
            match (equilibrium_artifact_schema.as_str(), linearization_state_schema.as_str()) {
                ("equilibrium_artifact.v7", "LinearizationState.v6") => (
                    false,
                    "CertifiedFemEquilibriumFields.v1",
                    required_object_string(
                        &state.equilibrium_artifact,
                        "material_signature",
                        "equilibrium_artifact",
                    )?,
                ),
                ("equilibrium_artifact.v8", "LinearizationState.v7") => (
                    true,
                    "CertifiedFemEquilibriumFields.v2",
                    required_object_string(
                        &state.equilibrium_artifact,
                        "material_signature",
                        "equilibrium_artifact",
                    )?,
                ),
                _ => {
                    return Err(RunError {
                        message: "linearization_identity_equilibrium_state_schema_pair_invalid"
                            .to_string(),
                    })
                }
            };
        let expected_recomputed_schema = if canonical_material {
            "RecomputedFemLinearizationCertificate.v2"
        } else {
            "RecomputedFemLinearizationCertificate.v1"
        };
        if replay.accepted_fields.schema_version != accepted_schema
            || replay.certified_fields.schema_version != accepted_schema
            || replay.recomputed_certificate.schema_version != expected_recomputed_schema
        {
            return Err(RunError {
                message: "linearization_identity_replay_schema_family_mismatch".to_string(),
            });
        }
        let expected_material_kind = if canonical_material {
            "canonical_equilibrium_material.v2"
        } else {
            "raw_material.v1"
        };
        if canonical_material {
            if required_object_string(
                &state.equilibrium_artifact,
                "material_identity_kind",
                "equilibrium_artifact",
            )? != expected_material_kind
                || required_object_string(
                    &state.linearization_state,
                    "material_identity_kind",
                    "linearization_state",
                )? != expected_material_kind
            {
                return Err(RunError {
                    message: "linearization_identity_canonical_material_kind_mismatch"
                        .to_string(),
                });
            }
        } else if state.equilibrium_artifact.get("material_identity_kind").is_some()
            || state
                .linearization_state
                .get("material_identity_kind")
                .is_some()
        {
            return Err(RunError {
                message: "linearization_identity_legacy_material_artifact_advertises_v2_identity"
                    .to_string(),
            });
        }
        let (consumer_material_provenance_signature, consumer_material_preimage) =
            raw_material_provenance_from_eigen_plan(plan)?;
        if canonical_material {
            for (name, value) in [
                ("equilibrium_artifact", &state.equilibrium_artifact),
                ("linearization_state", &state.linearization_state),
            ] {
                if required_object_string(value, "material_provenance_signature", name)?
                    != consumer_material_provenance_signature
                    || required_object_string(value, "material_provenance_scope", name)?
                        != "materialization_plan"
                {
                    return Err(RunError {
                        message: format!(
                            "linearization_identity_{name}_raw_material_provenance_mismatch"
                        ),
                    });
                }
            }
        }
        let producer_build_snapshot_sha256 =
            strict_build_identity_snapshot(&replay.producer_build_identity, "producer")?;
        let consumer_source_snapshot_sha256 =
            strict_build_identity_snapshot(&consumer_build_identity, "consumer")?;
        if producer_build_snapshot_sha256 != consumer_source_snapshot_sha256 {
            return Err(RunError {
                message: "linearization_identity_cross_build_source_snapshot_mismatch"
                    .to_string(),
            });
        }
        let target_identity =
            super::equilibrium_identity::EquilibriumIdentitySignaturesV1::from_eigen_plan(plan)?;
        for (name, source, target) in [
            (
                "material",
                &replay.equilibrium_material_signature,
                &target_identity.equilibrium_material_signature,
            ),
            (
                "static_physics",
                &replay.equilibrium_static_physics_signature,
                &target_identity.equilibrium_static_physics_signature,
            ),
            (
                "boundary",
                &replay.equilibrium_boundary_signature,
                &target_identity.equilibrium_boundary_signature,
            ),
        ] {
            if source != target {
                return Err(RunError {
                    message: format!(
                        "linearization_identity_{name}_signature_mismatch"
                    ),
                });
            }
        }
        let (consumer_plan_snapshot_bytes, consumer_plan_snapshot_sha256) =
            consumer_plan_snapshot_bytes_and_sha256(plan)?;
        let recomputed_preimage_bytes = replay.recomputed_certificate_preimage_json.as_bytes();
        let recomputed_certificate_preimage_json =
            replay.recomputed_certificate_preimage_json.clone();
        let recomputed_certificate_preimage_sha256 = format!(
            "sha256:{:x}",
            Sha256::digest(recomputed_preimage_bytes)
        );
        if replay.recomputed_certificate.content_sha256
            != crate::types::recomputed_fem_linearization_certificate_sha256(
                &replay.recomputed_certificate,
            )?
        {
            return Err(RunError {
                message: "linearization_identity_recomputed_certificate_digest_mismatch"
                    .to_string(),
            });
        }
        if artifact_material_signature
            != if canonical_material {
                replay.equilibrium_material_signature.clone()
            } else {
                consumer_material_provenance_signature.clone()
            }
        {
            return Err(RunError {
                message: "linearization_identity_material_signature_mismatch".to_string(),
            });
        }
        let accepted_path = format!(
            "eigen/metadata/sample_{sample_index:04}/accepted_fem_equilibrium_fields.{}.json",
            if accepted_schema.ends_with(".v2") { "v2" } else { "v1" }
        );
        let certified_path = format!(
            "eigen/metadata/sample_{sample_index:04}/certified_fem_equilibrium_fields.{}.json",
            if accepted_schema.ends_with(".v2") { "v2" } else { "v1" }
        );
        let recomputed_path = format!(
            "eigen/metadata/sample_{sample_index:04}/recomputed_fem_linearization_certificate.{}.json",
            if accepted_schema.ends_with(".v2") { "v2" } else { "v1" }
        );
        let mut identity = Self::linearization_identity_v2_preimage(
            sample_index,
            equilibrium_artifact_schema,
            linearization_state_schema,
            accepted_schema.to_string(),
            replay.certified_fields.schema_version.clone(),
            replay.recomputed_certificate.schema_version.clone(),
            self,
            plan,
            state,
            modal_mesh_topology_fingerprint_v3,
            artifact_material_signature,
            expected_material_kind.to_string(),
            consumer_material_provenance_signature,
            consumer_material_preimage,
            accepted_path,
            certified_path,
            recomputed_path,
            equilibrium_artifact_path,
            linearization_state_path,
            consumer_plan_snapshot_sha256,
            consumer_build_identity,
            consumer_source_snapshot_sha256,
            recomputed_certificate_preimage_json,
            recomputed_certificate_preimage_sha256,
        )?;
        identity.content_sha256 = linearization_identity_v2_content_sha256(&identity)?;
        if !is_strict_sha256_digest(&identity.content_sha256)
            || producer_build_snapshot_sha256 != identity.producer_source_snapshot_sha256
        {
            return Err(RunError {
                message: "linearization_identity_provenance_binding_invalid".to_string(),
            });
        }
        Ok((identity, consumer_plan_snapshot_bytes))
    }

    #[allow(clippy::too_many_arguments)]
    fn linearization_identity_v2_preimage(
        sample_index: usize,
        equilibrium_artifact_schema: String,
        linearization_state_schema: String,
        accepted_fields_schema: String,
        certified_fields_schema: String,
        recomputed_certificate_schema: String,
        handoff: &Self,
        plan: &FemEigenPlanIR,
        state: &SharedDomainLinearizationState,
        modal_mesh_topology_fingerprint_v3: String,
        material_signature: String,
        material_identity_kind: String,
        material_provenance_signature: String,
        material_provenance_preimage_json: String,
        accepted_fields_path: String,
        certified_fields_path: String,
        recomputed_certificate_path: String,
        equilibrium_artifact_path: String,
        linearization_state_path: String,
        consumer_plan_snapshot_sha256: String,
        consumer_build_identity: serde_json::Value,
        consumer_source_snapshot_sha256: String,
        recomputed_certificate_preimage_json: String,
        recomputed_certificate_preimage_sha256: String,
    ) -> Result<LinearizationIdentityV2, RunError> {
        let replay = handoff.verified_replay.as_ref().ok_or_else(|| RunError {
            message: "linearization_identity_missing_verified_replay_payload".to_string(),
        })?;
        let producer_source_snapshot_sha256 =
            strict_build_identity_snapshot(&replay.producer_build_identity, "producer")?;
        let consumer_material_signature = material_signature.clone();
        let mut identity = LinearizationIdentityV2 {
            schema_version: LINEARIZATION_IDENTITY_V2.to_string(),
            sample_index,
            equilibrium_artifact_schema,
            linearization_state_schema,
            accepted_fields_schema,
            certified_fields_schema,
            recomputed_certificate_schema,
            handoff_schema_version: handoff.schema_version.clone(),
            handoff_content_sha256: handoff.content_sha256.clone(),
            source_run_id: handoff.source_run_id.clone(),
            source_stage_id: handoff.source_stage_id.clone(),
            source_stage_kind: handoff.source_stage_kind.clone(),
            producer_plan_snapshot_sha256: replay.producer_plan_snapshot_sha256.clone(),
            consumer_plan_snapshot_sha256,
            producer_build_identity: replay.producer_build_identity.clone(),
            consumer_build_identity,
            producer_source_snapshot_sha256,
            consumer_source_snapshot_sha256,
            cross_build_policy: "same_source_snapshot_required".to_string(),
            source_mesh_topology_sha256: handoff.source_mesh_topology_sha256.clone(),
            modal_mesh_topology_fingerprint_v3,
            node_count: handoff.node_count,
            equilibrium_content_sha256: handoff.equilibrium_content_sha256.clone(),
            equilibrium_artifact_path,
            equilibrium_artifact_sha256: state.equilibrium_artifact_digest.clone(),
            linearization_state_path,
            linearization_state_sha256: state.linearization_state_digest.clone(),
            equilibrium_material_signature: replay.equilibrium_material_signature.clone(),
            equilibrium_material_preimage_json: replay.equilibrium_material_preimage_json.clone(),
            equilibrium_static_physics_signature: replay
                .equilibrium_static_physics_signature
                .clone(),
            equilibrium_static_physics_preimage_json: replay
                .equilibrium_static_physics_preimage_json
                .clone(),
            equilibrium_boundary_signature: replay.equilibrium_boundary_signature.clone(),
            equilibrium_boundary_preimage_json: replay.equilibrium_boundary_preimage_json.clone(),
            material_signature: consumer_material_signature,
            material_identity_kind,
            material_provenance_signature,
            material_provenance_scope: "materialization_plan".to_string(),
            material_provenance_preimage_json,
            producer_material_provenance_signature: replay
                .material_provenance_signature
                .clone(),
            producer_material_provenance_preimage_json: replay
                .material_provenance_preimage_json
                .clone(),
            accepted_fields_content_sha256: replay.accepted_fields.content_sha256.clone(),
            accepted_fields_path,
            certified_fields_content_sha256: replay.certified_fields.content_sha256.clone(),
            certified_fields_path,
            recomputed_certificate_content_sha256: replay
                .recomputed_certificate
                .content_sha256
                .clone(),
            recomputed_certificate_path,
            accepted_fields_bytes_sha256: bytes_sha256(&replay.accepted_fields_json),
            certified_fields_bytes_sha256: bytes_sha256(&replay.certified_fields_json),
            recomputed_certificate_bytes_sha256: bytes_sha256(&replay.recomputed_certificate_json),
            recomputed_certificate_preimage_json,
            recomputed_certificate_preimage_sha256,
            content_sha256: String::new(),
        };
        identity.content_sha256 = linearization_identity_v2_content_sha256(&identity)?;
        if !is_strict_sha256_digest(&identity.content_sha256)
            || plan.mesh.nodes.len() != identity.node_count
        {
            return Err(RunError {
                message: "linearization_identity_handoff_node_binding_invalid".to_string(),
            });
        }
        Ok(identity)
    }

    pub(super) fn v2_record(&self) -> AcceptedFemRelaxStageHandoffV2Record {
        AcceptedFemRelaxStageHandoffV2Record {
            schema_version: ACCEPTED_FEM_RELAX_STAGE_HANDOFF_V2.to_string(),
            source_run_id: self.source_run_id.clone(),
            source_stage_id: self.source_stage_id.clone(),
            source_stage_kind: self.source_stage_kind.clone(),
            stage_fem_mesh_generation_id: self.stage_fem_mesh_generation_id.clone(),
            source_mesh_topology_sha256: self.source_mesh_topology_sha256.clone(),
            node_count: self.node_count,
            indexing_sha256: self.indexing_sha256.clone(),
            part_registry_sha256: self.part_registry_sha256.clone(),
            completion_sha256: self.completion_sha256.clone(),
            completion: self.completion.clone(),
            acceptance: self.acceptance.clone(),
            equilibrium_content_sha256: self.equilibrium_content_sha256.clone(),
            content_sha256: self.legacy_v2_content_sha256.clone(),
        }
    }

    pub(super) fn v3_record(&self) -> AcceptedFemRelaxStageHandoffV3Record {
        AcceptedFemRelaxStageHandoffV3Record {
            schema_version: self.schema_version.clone(),
            source_run_id: self.source_run_id.clone(),
            source_stage_id: self.source_stage_id.clone(),
            source_stage_kind: self.source_stage_kind.clone(),
            stage_fem_mesh_generation_id: self.stage_fem_mesh_generation_id.clone(),
            source_mesh_topology_sha256: self.source_mesh_topology_sha256.clone(),
            node_count: self.node_count,
            indexing_sha256: self.indexing_sha256.clone(),
            part_registry_sha256: self.part_registry_sha256.clone(),
            completion_sha256: self.completion_sha256.clone(),
            completion: self.completion.clone(),
            acceptance: self.acceptance.clone(),
            equilibrium_content_sha256: self.equilibrium_content_sha256.clone(),
            legacy_v2_content_sha256: self.legacy_v2_content_sha256.clone(),
            acceptance_certificate_sha256: self.acceptance_certificate_sha256.clone(),
            equilibrium_magnetization: self.equilibrium_magnetization.clone(),
            certified_fields: self.certified_fields.clone(),
            certified_fields_content_sha256: self.certified_fields.content_sha256.clone(),
            equilibrium_material_signature: self.equilibrium_material_signature.clone(),
            equilibrium_static_physics_signature: self.equilibrium_static_physics_signature.clone(),
            equilibrium_boundary_signature: self.equilibrium_boundary_signature.clone(),
            content_sha256: self.content_sha256.clone(),
        }
    }
}

fn validate_handoff_m0_norms(
    equilibrium: &[Vector3],
    magnetic_nodes: &[bool],
) -> Result<(), RunError> {
    if equilibrium.len() != magnetic_nodes.len() {
        return Err(RunError {
            message: format!(
                "relax_stage_handoff_m0_norm_mismatch: topology has {} nodes, equilibrium has {}",
                magnetic_nodes.len(),
                equilibrium.len()
            ),
        });
    }
    for (node, magnetization) in equilibrium.iter().enumerate() {
        let norm = magnetization
            .iter()
            .map(|component| component * component)
            .sum::<f64>()
            .sqrt();
        if !norm.is_finite() {
            return Err(RunError {
                message: format!(
                    "relax_stage_handoff_m0_norm_mismatch: node {node} has non-finite norm"
                ),
            });
        }
        if !magnetic_nodes[node] {
            continue;
        }
        let norm_error = (norm - 1.0).abs();
        if norm_error > 1.0e-8 {
            return Err(RunError {
                message: format!(
                    "relax_stage_handoff_m0_norm_mismatch: node {node} has norm error {norm_error:.3e}"
                ),
            });
        }
    }
    Ok(())
}

fn required_object_string(
    value: &serde_json::Value,
    field: &str,
    object_name: &str,
) -> Result<String, RunError> {
    value
        .get(field)
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| RunError {
            message: format!(
                "linearization_identity_{object_name}_missing_{field}"
            ),
        })
}

fn raw_material_provenance_from_eigen_plan(
    plan: &FemEigenPlanIR,
) -> Result<(String, String), RunError> {
    let bytes = serde_json::to_vec(&plan.material).map_err(|error| RunError {
        message: format!("linearization_identity_material_preimage_serialization_failed: {error}"),
    })?;
    let preimage = String::from_utf8(bytes.clone()).map_err(|error| RunError {
        message: format!("linearization_identity_material_preimage_not_utf8: {error}"),
    })?;
    let signature = super::eigen_digest::shared_domain_content_digest(
        "material_signature",
        &plan.material,
    )?;
    Ok((signature, preimage))
}

fn bytes_sha256(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn is_strict_sha256_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

// BuildIdentity preserves the canonical managed build-info raw hex format.
// Payload and physical signature digests above use a different, prefixed format.
fn is_strict_source_snapshot_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn linearization_identity_v2_preimage_bytes(
    identity: &LinearizationIdentityV2,
) -> Result<Vec<u8>, RunError> {
    if identity.schema_version != LINEARIZATION_IDENTITY_V2 {
        return Err(RunError {
            message: "linearization_identity_v2_schema_version_mismatch".to_string(),
        });
    }
    validate_linearization_identity_source_snapshots(identity)?;
    let mut preimage = identity.clone();
    preimage.content_sha256.clear();
    serde_json::to_vec(&preimage).map_err(|error| RunError {
        message: format!("linearization_identity_v2_preimage_serialization_failed: {error}"),
    })
}

fn linearization_identity_v2_framed_digest(preimage: &[u8]) -> String {
    let mut hash = Sha256::new();
    hash.update(LINEARIZATION_IDENTITY_V2.as_bytes());
    hash.update([0u8]);
    hash.update((preimage.len() as u64).to_le_bytes());
    hash.update(preimage);
    format!("sha256:{:x}", hash.finalize())
}

pub(super) fn linearization_identity_v2_content_sha256_from_preimage_bytes(
    preimage: &[u8],
) -> String {
    linearization_identity_v2_framed_digest(preimage)
}

fn linearization_identity_v2_content_sha256(
    identity: &LinearizationIdentityV2,
) -> Result<String, RunError> {
    let preimage = linearization_identity_v2_preimage_bytes(identity)?;
    Ok(linearization_identity_v2_framed_digest(&preimage))
}

pub(super) fn linearization_identity_v2_preimage_sidecar_bytes(
    identity: &LinearizationIdentityV2,
) -> Result<Vec<u8>, RunError> {
    let preimage = linearization_identity_v2_preimage_bytes(identity)?;
    let identity_preimage_json = String::from_utf8(preimage.clone()).map_err(|error| RunError {
        message: format!("linearization_identity_v2_preimage_not_utf8: {error}"),
    })?;
    let identity_content_sha256 = linearization_identity_v2_framed_digest(&preimage);
    if identity.content_sha256 != identity_content_sha256 {
        return Err(RunError {
            message: "linearization_identity_v2_content_digest_mismatch_before_sidecar"
                .to_string(),
        });
    }
    let sidecar = LinearizationIdentityPreimageV1 {
        schema_version: LINEARIZATION_IDENTITY_PREIMAGE_V1.to_string(),
        identity_schema: LINEARIZATION_IDENTITY_V2.to_string(),
        identity_preimage_json,
        identity_preimage_sha256: bytes_sha256(&preimage),
        identity_content_sha256,
    };
    serde_json::to_vec_pretty(&sidecar).map_err(|error| RunError {
        message: format!("linearization_identity_preimage_v1_serialization_failed: {error}"),
    })
}

fn accepted_equilibrium_criterion(
    completion: &fullmag_ir::StageCompletionIR,
) -> Result<AcceptedEquilibriumCriterion, RunError> {
    let accepted_metric = match (completion.reason, completion.metric) {
        (
            Some(fullmag_ir::StageStopReason::Torque),
            Some(fullmag_ir::StageMetricKind::MaxTorqueApm),
        ) => Some(("torque", fullmag_ir::StageMetricKind::MaxTorqueApm)),
        (
            Some(fullmag_ir::StageStopReason::Energy),
            Some(fullmag_ir::StageMetricKind::TotalEnergyPlateauRangeJ),
        ) => Some((
            "energy",
            fullmag_ir::StageMetricKind::TotalEnergyPlateauRangeJ,
        )),
        _ => None,
    };
    let accepted_values = match (completion.metric_value, completion.threshold) {
        (Some(value), Some(threshold))
            if value.is_finite()
                && threshold.is_finite()
                && threshold >= 0.0
                && value <= threshold =>
        {
            Some((value, threshold))
        }
        _ => None,
    };
    let (Some((criterion, metric_kind)), Some((metric_value, threshold))) =
        (accepted_metric, accepted_values)
    else {
        return Err(RunError {
            message: "relax_stage_handoff_completion_not_accepted: completion must be completed, converged, use a coherent equilibrium metric, and satisfy its threshold"
                .to_string(),
        });
    };
    if completion.status != "completed" || !completion.converged {
        return Err(RunError {
            message: "relax_stage_handoff_completion_not_accepted: completion must be completed, converged, use a coherent equilibrium metric, and satisfy its threshold"
                .to_string(),
        });
    }
    Ok(AcceptedEquilibriumCriterion {
        criterion: criterion.to_string(),
        metric_kind,
        metric_value,
        threshold,
        unit: metric_kind.unit().to_string(),
        status: completion.status.clone(),
        converged: completion.converged,
        stop_reason: completion
            .reason
            .expect("accepted completion has a stop reason"),
    })
}

fn vector_field_content_sha256(values: &[Vector3]) -> String {
    let mut hash = Sha256::new();
    hash.update(b"AcceptedFemRelaxStageHandoff.m0.v1\0");
    hash.update((values.len() as u64).to_le_bytes());
    for vector in values {
        for value in vector {
            hash.update(value.to_bits().to_le_bytes());
        }
    }
    format!("sha256:{:x}", hash.finalize())
}

pub(super) fn relax_stage_handoff_v2_content_sha256(
    record: &AcceptedFemRelaxStageHandoffV2Record,
) -> Result<String, RunError> {
    if record.schema_version != ACCEPTED_FEM_RELAX_STAGE_HANDOFF_V2 {
        return Err(RunError {
            message: "relax_stage_handoff_v2_schema_version_mismatch".to_string(),
        });
    }
    let completion_json = serde_json::to_vec(&record.completion).map_err(|error| RunError {
        message: format!("relax_stage_handoff_completion_serialization_failed: {error}"),
    })?;
    let acceptance_json = serde_json::to_vec(&record.acceptance).map_err(|error| RunError {
        message: format!("relax_stage_handoff_acceptance_serialization_failed: {error}"),
    })?;
    let node_count = (record.node_count as u64).to_le_bytes();
    let mut hash = Sha256::new();
    hash.update(b"AcceptedFemRelaxStageHandoff.v2\0");
    for field in [
        record.source_run_id.as_bytes(),
        record.source_stage_id.as_bytes(),
        record.source_stage_kind.as_bytes(),
        record.stage_fem_mesh_generation_id.as_bytes(),
        record.source_mesh_topology_sha256.as_bytes(),
        node_count.as_slice(),
        record.indexing_sha256.as_bytes(),
        record.part_registry_sha256.as_bytes(),
        record.completion_sha256.as_bytes(),
        completion_json.as_slice(),
        acceptance_json.as_slice(),
        record.equilibrium_content_sha256.as_bytes(),
    ] {
        hash.update((field.len() as u64).to_le_bytes());
        hash.update(field);
    }
    Ok(format!("sha256:{:x}", hash.finalize()))
}

#[allow(dead_code)] // Wired by the next migration slice.
pub(super) fn relax_stage_handoff_v3_content_sha256(
    preimage: &AcceptedFemRelaxStageHandoffV3HashPreimage,
) -> Result<String, RunError> {
    if preimage.schema_version != ACCEPTED_FEM_RELAX_STAGE_HANDOFF_V3 {
        return Err(RunError {
            message: "relax_stage_handoff_v3_schema_version_mismatch".to_string(),
        });
    }
    let mut hash = Sha256::new();
    hash.update(b"AcceptedFemRelaxStageHandoff.v3\0");
    for field in [
        preimage.legacy_v2_content_sha256.as_bytes(),
        preimage.acceptance_certificate_sha256.as_bytes(),
        preimage.certified_fields_content_sha256.as_bytes(),
        preimage.equilibrium_material_signature.as_bytes(),
        preimage.equilibrium_static_physics_signature.as_bytes(),
        preimage.equilibrium_boundary_signature.as_bytes(),
    ] {
        hash.update((field.len() as u64).to_le_bytes());
        hash.update(field);
    }
    Ok(format!("sha256:{:x}", hash.finalize()))
}

pub(crate) fn validate_certified_equilibrium_fields(
    fields: &crate::types::CertifiedFemEquilibriumFields,
    expected_node_count: usize,
) -> Result<(), RunError> {
    let valid_shape = expected_node_count > 0
        && match fields.schema_version.as_str() {
            "CertifiedFemEquilibriumFields.v1" => fields.h_anisotropy_a_per_m.is_none(),
            "CertifiedFemEquilibriumFields.v2" => fields.h_anisotropy_a_per_m.as_ref().is_some_and(|view| view.len() == expected_node_count),
            _ => false,
        }
        && fields.h_ex_a_per_m.len() == expected_node_count
        && fields.h_demag_a_per_m.len() == expected_node_count
        && fields.h_ext_a_per_m.len() == expected_node_count
        && fields.h_eff_a_per_m.len() == expected_node_count
        && fields.phi_a.len() == expected_node_count;
    let finite = [
        &fields.h_ex_a_per_m,
        &fields.h_demag_a_per_m,
        &fields.h_ext_a_per_m,
        &fields.h_eff_a_per_m,
    ]
    .into_iter()
    .flat_map(|values| values.iter())
    .flat_map(|value| value.iter())
    .all(|value| value.is_finite())
        && fields.phi_a.iter().all(|value| value.is_finite())
        && fields.h_anisotropy_a_per_m.iter().flatten().flatten().all(|value| value.is_finite());
    let digest = crate::types::certified_equilibrium_fields_sha256(fields);
    if !valid_shape || !finite || fields.content_sha256 != digest {
        return Err(RunError {
            message: "relax_stage_handoff_certified_fields_invalid: native static fields must be finite, complete, and digest-bound"
                .to_string(),
        });
    }
    let decomposes_exactly = fields
        .h_ex_a_per_m
        .iter()
        .zip(&fields.h_demag_a_per_m)
        .zip(&fields.h_ext_a_per_m)
        .zip(&fields.h_eff_a_per_m)
        .enumerate()
        .all(|(node, (((h_ex, h_demag), h_ext), h_eff))| {
            (0..3).all(|component| {
                let exchange_demag = h_ex[component] + h_demag[component];
                let before_external = fields
                    .h_anisotropy_a_per_m
                    .as_ref()
                    .map_or(exchange_demag, |anisotropy| {
                        exchange_demag + anisotropy[node][component]
                    });
                h_eff[component] == before_external + h_ext[component]
            })
        });
    if !decomposes_exactly {
        return Err(RunError {
            message: "relax_stage_handoff_certified_fields_decomposition_mismatch: H_eff must equal the schema-defined native field sum exactly"
                .to_string(),
        });
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub(crate) struct AcceptedFemEigenEquilibriumHandoff {
    pub(super) stage_mesh_identity: StageFemMeshIdentity,
    pub(super) source_mesh_topology_sha256: String,
    pub(super) equilibrium_magnetization: Vec<Vector3>,
    pub(super) equilibrium_artifact_sha256: String,
    pub(super) linearization_state_sha256: String,
    pub(super) content_sha256: String,
}

impl AcceptedFemEigenEquilibriumHandoff {
    pub(crate) fn from_accepted_linearization(
        plan: &FemEigenPlanIR,
        equilibrium_magnetization: Vec<Vector3>,
        equilibrium_artifact_sha256: String,
        linearization_state_sha256: String,
    ) -> Result<Self, RunError> {
        if equilibrium_magnetization.len() != plan.mesh.nodes.len()
            || equilibrium_magnetization
                .iter()
                .flatten()
                .any(|value| !value.is_finite())
        {
            return Err(RunError {
                message: format!(
                    "relax_to_eigen_handoff_invalid_equilibrium: expected {} finite vectors, got {}",
                    plan.mesh.nodes.len(),
                    equilibrium_magnetization.len()
                ),
            });
        }
        if !is_sha256_digest(&equilibrium_artifact_sha256)
            || !is_sha256_digest(&linearization_state_sha256)
        {
            return Err(RunError {
                message: "relax_to_eigen_handoff_invalid_digest: equilibrium and linearization identities must be sha256 digests"
                    .to_string(),
            });
        }
        let stage_mesh_identity = StageFemMeshIdentity::from_fem_eigen_plan(plan);
        let source_mesh_topology_sha256 = plan.mesh.topology_fingerprint_v6();
        if !is_sha256_digest(&source_mesh_topology_sha256)
            || stage_mesh_identity.generation_id().trim().is_empty()
        {
            return Err(RunError {
                message: "relax_to_eigen_stage_mesh_identity_or_topology_invalid".to_string(),
            });
        }
        let payload = serde_json::json!({
            "schema_version": "AcceptedFemEigenEquilibriumHandoff.v1",
            "stage_fem_mesh_generation_id": stage_mesh_identity.generation_id(),
            "source_mesh_topology_sha256": &source_mesh_topology_sha256,
            "equilibrium_artifact_sha256": &equilibrium_artifact_sha256,
            "linearization_state_sha256": &linearization_state_sha256,
        });
        let content_sha256 = shared_domain_content_digest("relax_to_eigen_handoff", &payload)?;
        Ok(Self {
            stage_mesh_identity,
            source_mesh_topology_sha256,
            equilibrium_magnetization,
            equilibrium_artifact_sha256,
            linearization_state_sha256,
            content_sha256,
        })
    }

    pub(crate) fn validate_target_plan(&self, plan: &FemEigenPlanIR) -> Result<(), RunError> {
        let target_identity = StageFemMeshIdentity::from_fem_eigen_plan(plan);
        let target_topology_sha256 = plan.mesh.topology_fingerprint_v6();
        if target_identity != self.stage_mesh_identity
            || !is_sha256_digest(&target_topology_sha256)
            || target_topology_sha256 != self.source_mesh_topology_sha256
        {
            return Err(RunError {
                message: format!(
                    "relax_to_eigen_mesh_identity_mismatch: source generation/topology='{}'/'{}', target generation/topology='{}'/'{}'",
                    self.stage_mesh_identity.generation_id(),
                    self.source_mesh_topology_sha256,
                    target_identity.generation_id(),
                    target_topology_sha256,
                ),
            });
        }
        Ok(())
    }

    pub(super) fn validate_consumed_linearization(
        &self,
        plan: &FemEigenPlanIR,
        equilibrium: &[Vector3],
        state: &SharedDomainLinearizationState,
    ) -> Result<(), RunError> {
        self.validate_target_plan(plan)?;
        if equilibrium != self.equilibrium_magnetization {
            return Err(RunError {
                message:
                    "relax_to_eigen_equilibrium_mismatch: provided state differs from accepted relax state"
                        .to_string(),
            });
        }
        if state.equilibrium_artifact_digest != self.equilibrium_artifact_sha256
            || state.linearization_state_digest != self.linearization_state_sha256
        {
            return Err(RunError {
                message: format!(
                    "relax_to_eigen_linearization_mismatch: accepted equilibrium/linearization='{}/{}', consumed='{}/{}'",
                    self.equilibrium_artifact_sha256,
                    self.linearization_state_sha256,
                    state.equilibrium_artifact_digest,
                    state.linearization_state_digest,
                ),
            });
        }
        Ok(())
    }

    pub(crate) fn equilibrium_magnetization(&self) -> &[Vector3] {
        &self.equilibrium_magnetization
    }

    pub(crate) fn content_sha256(&self) -> &str {
        &self.content_sha256
    }

    pub(crate) fn source_mesh_topology_sha256(&self) -> &str {
        &self.source_mesh_topology_sha256
    }

    pub(super) fn provenance_json(&self) -> serde_json::Value {
        serde_json::json!({
            "schema_version": "AcceptedFemEigenEquilibriumHandoff.v1",
            "stage_fem_mesh_generation_id": self.stage_mesh_identity.generation_id(),
            "source_mesh_topology_sha256": self.source_mesh_topology_sha256,
            "equilibrium_artifact_sha256": self.equilibrium_artifact_sha256,
            "linearization_state_sha256": self.linearization_state_sha256,
            "content_sha256": self.content_sha256,
        })
    }
}

pub(crate) fn accepted_relax_to_eigen_handoff_from_run(
    plan: &FemEigenPlanIR,
    run: &ExecutedRun,
) -> Result<AcceptedFemEigenEquilibriumHandoff, RunError> {
    let summary = run
        .auxiliary_artifacts
        .iter()
        .find(|artifact| artifact.relative_path == "eigen/metadata/eigen_summary.json")
        .ok_or_else(|| RunError {
            message: "missing_relax_to_eigen_handoff_summary".to_string(),
        })
        .and_then(|artifact| {
            serde_json::from_slice::<serde_json::Value>(&artifact.bytes).map_err(|error| RunError {
                message: format!("invalid_relax_to_eigen_handoff_summary: {error}"),
            })
        })?;
    let diagnostics = summary
        .get("solver_diagnostics")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| RunError {
            message: "missing_relax_to_eigen_handoff_diagnostics".to_string(),
        })?;
    let handoff_json = diagnostics
        .get("relax_to_eigen_handoff")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| RunError {
            message: "missing_relax_to_eigen_handoff_binding".to_string(),
        })?;
    let required = |field: &str| -> Result<String, RunError> {
        handoff_json
            .get(field)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| RunError {
                message: format!("missing_relax_to_eigen_handoff_field: {field}"),
            })
    };
    let schema = required("schema_version")?;
    let source_topology = required("source_mesh_topology_sha256")?;
    let diagnostic_string =
        |field: &str| diagnostics.get(field).and_then(serde_json::Value::as_str);
    let (equilibrium_artifact, linearization_state, expected_declared_source_topology) =
        match schema.as_str() {
            "AcceptedFemEigenEquilibriumHandoff.v1" => (
                required("equilibrium_artifact_sha256")?,
                required("linearization_state_sha256")?,
                plan.mesh.topology_fingerprint_v6(),
            ),
            "AcceptedFemRelaxStageHandoff.v3" => (
                diagnostic_string("equilibrium_artifact_sha256")
                    .map(str::to_string)
                    .ok_or_else(|| RunError {
                        message:
                            "missing_relax_to_eigen_handoff_field: equilibrium_artifact_sha256"
                                .to_string(),
                    })?,
                diagnostic_string("linearization_state_sha256")
                    .map(str::to_string)
                    .ok_or_else(|| RunError {
                        message: "missing_relax_to_eigen_handoff_field: linearization_state_sha256"
                            .to_string(),
                    })?,
                plan.mesh
                    .mixed_topology_fingerprint_v3()
                    .map_err(|error| RunError {
                        message: format!(
                            "relax_to_eigen_handoff_source_topology_fingerprint_failed: {error}"
                        ),
                    })?,
            ),
            _ => {
                return Err(RunError {
                    message: format!("unsupported_relax_to_eigen_handoff_schema: {schema}"),
                });
            }
        };
    let declared_content = required("content_sha256")?;
    let handoff = AcceptedFemEigenEquilibriumHandoff::from_accepted_linearization(
        plan,
        run.result.final_magnetization.clone(),
        equilibrium_artifact.clone(),
        linearization_state.clone(),
    )?;
    let content_identity_matches = if schema == "AcceptedFemEigenEquilibriumHandoff.v1" {
        declared_content == handoff.content_sha256()
            && diagnostic_string("relax_to_eigen_handoff_sha256") == Some(declared_content.as_str())
    } else {
        is_sha256_digest(&declared_content)
            && diagnostic_string("relax_to_eigen_handoff_sha256") == Some(declared_content.as_str())
    };
    if source_topology != expected_declared_source_topology
        || !content_identity_matches
        || diagnostic_string("relax_to_eigen_source_mesh_topology_sha256")
            != Some(source_topology.as_str())
        || diagnostic_string("equilibrium_artifact_sha256") != Some(equilibrium_artifact.as_str())
        || diagnostic_string("linearization_state_sha256") != Some(linearization_state.as_str())
    {
        return Err(RunError {
            message: "relax_to_eigen_handoff_summary_identity_mismatch".to_string(),
        });
    }
    Ok(handoff)
}

#[derive(Debug, Clone)]
pub(super) struct LoadedEquilibriumArtifact {
    pub(super) value: serde_json::Value,
    pub(super) m0: Vec<Vector3>,
    pub(super) h_eff0: Vec<Vector3>,
    pub(super) h_demag0: Vec<Vector3>,
    pub(super) phi0: Vec<f64>,
    pub(super) equilibrium_id: String,
    pub(super) producer_run_id: String,
    pub(super) content_sha256: String,
    pub(super) mesh_signature: String,
    pub(super) material_signature: String,
    pub(super) physics_signature: String,
    pub(super) boundary_signature: String,
    pub(super) static_demag_signature: String,
    pub(super) demag_model: String,
    pub(super) m0_norm_tolerance: f64,
    pub(super) phi0_requirement: String,
    pub(super) periodic_mesh_certificate: serde_json::Value,
    pub(super) acceptance_certificate: AcceptedEquilibriumCriterion,
    pub(super) completion_sha256: String,
}

pub(super) fn certified_equilibrium_artifact_filenames(
    equilibrium_schema: Option<&str>,
    linearization_schema: Option<&str>,
) -> Result<(&'static str, &'static str), RunError> {
    match (equilibrium_schema, linearization_schema) {
        (Some("equilibrium_artifact.v7"), Some("LinearizationState.v6")) =>
            Ok(("equilibrium_artifact.v7.json", "linearization_state.v6.json")),
        (Some("equilibrium_artifact.v8"), Some("LinearizationState.v7")) =>
            Ok(("equilibrium_artifact.v8.json", "linearization_state.v7.json")),
        _ => Err(RunError {
            message: "equilibrium_artifact_schema_pair_invalid: publication requires an explicit supported equilibrium/linearization pair".to_string(),
        }),
    }
}

#[cfg(test)]
mod producer_provenance_tests {
    use super::*;

    #[test]
    fn bias_field_sample_identity_keeps_caller_run_and_binds_sample_stage() {
        let caller = FemRelaxationProducerStageIdentity {
            run_id: "run-123".to_string(),
            stage_id: "stage-004".to_string(),
            stage_kind: "fem_eigen".to_string(),
        };
        let sample = caller.for_bias_field_sample(7);
        assert_eq!(sample.run_id, "run-123");
        assert_eq!(sample.stage_id, "stage-004:bias-field-sample-0007");
        assert_eq!(sample.stage_kind, "bias_field_relaxation");
        assert_ne!(sample.stage_id, caller.stage_id);
        assert_ne!(sample.stage_kind, caller.stage_kind);
    }

    #[test]
    fn producer_plan_framed_digest_binds_namespace_length_and_exact_bytes() {
        let namespace = FEM_RELAXATION_PRODUCER_PLAN_NAMESPACE_V1;
        let original = br#"{"plan":1}"#;
        let mut mutated = original.to_vec();
        let mutation_index = mutated.len() - 2;
        mutated[mutation_index] = b'2';

        assert_ne!(framed_sha256(namespace, original), framed_sha256(namespace, &mutated));
        assert_ne!(framed_sha256(namespace, original), framed_sha256("other", original));
        assert_ne!(framed_sha256(namespace, original), framed_sha256(namespace, b"{"));
    }

    #[test]
    fn producer_build_identity_rejects_missing_or_noncanonical_snapshot() {
        let mut identity = FemRelaxationProducerBuildIdentity {
            built_at_utc: "2026-10-01T00:00:00Z".to_string(),
            git_commit: "abc".to_string(),
            worktree_state: "clean".to_string(),
            source_snapshot_sha256: format!("{:x}", Sha256::digest(b"source")),
        };
        assert!(validate_producer_build_identity(&identity).is_ok());

        let canonical_snapshot = identity.source_snapshot_sha256.clone();
        identity.source_snapshot_sha256 = format!("sha256:{canonical_snapshot}");
        assert!(validate_producer_build_identity(&identity).is_err());
        identity.source_snapshot_sha256 = canonical_snapshot;

        identity.source_snapshot_sha256 = identity.source_snapshot_sha256.to_uppercase();
        assert!(validate_producer_build_identity(&identity).is_err());

        identity.source_snapshot_sha256 = String::new();
        assert!(validate_producer_build_identity(&identity).is_err());
    }

    #[test]
    fn build_identity_snapshot_preserves_managed_raw_hex_and_rejects_payload_digest_format() {
        let snapshot = "ab".repeat(32);
        let identity = serde_json::json!({"source_snapshot_sha256": snapshot});
        assert_eq!(
            strict_build_identity_snapshot(&identity, "producer").unwrap(),
            snapshot
        );
        for invalid in [
            format!("sha256:{snapshot}"),
            snapshot.to_uppercase(),
            "a".repeat(63),
            String::new(),
        ] {
            assert!(strict_build_identity_snapshot(
                &serde_json::json!({"source_snapshot_sha256": invalid}),
                "producer"
            )
            .is_err());
        }
        assert!(is_strict_sha256_digest(&format!("sha256:{snapshot}")));
        assert!(!is_strict_sha256_digest(&snapshot));
    }

    #[test]
    fn producer_payload_ref_rejects_path_escape_and_byte_mutation() {
        let bytes = b"payload";
        let mut reference = FemRelaxationProducerPayloadRef {
            path: "equilibrium/payload.v1.json".to_string(),
            schema_version: "Payload.v1".to_string(),
            raw_bytes_sha256: bytes_sha256(bytes),
            content_sha256: bytes_sha256(b"content"),
        };
        assert!(validate_producer_payload_ref(
            "payload",
            &reference,
            bytes,
            "Payload.v1",
            &reference.content_sha256,
            "equilibrium/payload.v1.json",
        )
        .is_ok());

        reference.path = "../payload.v1.json".to_string();
        assert!(validate_producer_payload_ref(
            "payload",
            &reference,
            bytes,
            "Payload.v1",
            &reference.content_sha256,
            "equilibrium/payload.v1.json",
        )
        .is_err());

        reference.path = "equilibrium/payload.v1.json".to_string();
        reference.raw_bytes_sha256 = bytes_sha256(b"different");
        assert!(validate_producer_payload_ref(
            "payload",
            &reference,
            bytes,
            "Payload.v1",
            &reference.content_sha256,
            "equilibrium/payload.v1.json",
        )
        .is_err());
    }

    #[test]
    fn producer_sidecar_schema_rejects_unknown_fields() {
        let digest = bytes_sha256(b"digest");
        let payload_ref = FemRelaxationProducerPayloadRef {
            path: "equilibrium/payload.v1.json".to_string(),
            schema_version: "Payload.v1".to_string(),
            raw_bytes_sha256: digest.clone(),
            content_sha256: digest.clone(),
        };
        let provenance = FemRelaxationProducerProvenance {
            schema_version: FEM_RELAXATION_PRODUCER_PROVENANCE_V1.to_string(),
            source_run_id: "run".to_string(),
            source_stage_id: "stage".to_string(),
            source_stage_kind: "relaxation".to_string(),
            producer_build_identity: FemRelaxationProducerBuildIdentity {
                built_at_utc: "2026-10-01T00:00:00Z".to_string(),
                git_commit: "abc".to_string(),
                worktree_state: "clean".to_string(),
                source_snapshot_sha256: "a".repeat(64),
            },
            producer_plan_snapshot: FemRelaxationProducerPlanSnapshot {
                namespace: FEM_RELAXATION_PRODUCER_PLAN_NAMESPACE_V1.to_string(),
                encoding: "utf-8-json-bytes".to_string(),
                preimage_json: "{}".to_string(),
                raw_sha256: digest.clone(),
                framed_sha256: digest.clone(),
            },
            source_mesh_topology_sha256: digest.clone(),
            equilibrium_content_sha256: digest.clone(),
            equilibrium_material_signature: digest.clone(),
            equilibrium_static_physics_signature: digest.clone(),
            equilibrium_boundary_signature: digest,
            payloads: FemRelaxationProducerPayloads {
                accepted_fields: payload_ref.clone(),
                certified_fields: payload_ref.clone(),
                recomputed_certificate: payload_ref,
            },
            cross_build_policy: "same_source_snapshot_required".to_string(),
        };
        let mut value = serde_json::to_value(provenance).expect("sidecar must serialize");
        value
            .as_object_mut()
            .expect("sidecar must be an object")
            .insert("unexpected".to_string(), serde_json::Value::Bool(true));
        assert!(serde_json::from_value::<FemRelaxationProducerProvenance>(value).is_err());
    }
}
