//! Strict durable manifest for a materialized dataset backed by a SolutionSet.
//!
//! A materialized dataset is a metadata index over an immutable typed tensor.
//! The SolutionSet remains the owner of the tensor artifact and its CAS graph;
//! this manifest records the exact owner tuple and the coverage needed to
//! resolve the field without consulting a mutable live-session path.

use crate::cas::CasStore;
use crate::solution_tensor_field::TENSOR_FIELD_BINDING_SCHEMA;
use crate::solution_tensor_source::{
    read_solution_tensor_artifact, validate_solution_tensor_descriptor,
    verify_solution_tensor_payload, PinnedSolutionTensorSource, MAX_SOLUTION_TENSOR_METADATA_BYTES,
    SOLUTION_TENSOR_SCHEMA,
};
use crate::{SessionStore, TensorDescriptor, TensorDtype};
use anyhow::{bail, Context, Result};
use fullmag_quantities::{
    ApproximationPolicy, DatasetAvailability, DatasetDefinition, DatasetDefinitionRef,
    DatasetEvaluationPolicy, DatasetFieldRef, DatasetItem, DatasetSample, DatasetSource,
    DatasetStatus, EvaluationPrecision, MaterializedDataset, MaterializedDatasetRef,
    SelectionReference, SolutionArtifactKind, SolutionArtifactRef, SolutionSet,
    UnavailableDataPolicy, DATASET_CONTRACT_SCHEMA_VERSION,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::Path;

/// Immutable CAS schema for a dataset manifest carried by a SolutionSet.
pub const MATERIALIZED_DATASET_SCHEMA: &str = "fullmag.materialized_dataset.v1";

/// Maximum serialized size of the dataset manifest and its embedded definition.
pub const MAX_MATERIALIZED_DATASET_METADATA_BYTES: u64 = 4 * 1024 * 1024;

/// Coverage of the tensor payload referenced by one materialized field.
///
/// `total_elements` excludes the component axis, matching the dataset slice
/// contract. The typed tensor root remains authoritative for the individual
/// chunk references and byte offsets; this summary is checked against it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MaterializedDatasetTensorCoverage {
    pub total_elements: u64,
    pub component_count: u32,
    pub dtype: TensorDtype,
    pub endian: String,
    pub total_bytes: u64,
    pub chunk_count: u32,
}

/// Storage identity for the single typed field supported by this increment.
///
/// The duplicated semantic IDs are intentional: they make a damaged or
/// hand-edited manifest fail before any owner or payload lookup can occur.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MaterializedDatasetFieldSource {
    pub sample_id: String,
    pub item_id: String,
    pub field_id: String,
    pub source: PinnedSolutionTensorSource,
    pub group_id: String,
    pub producer_id: String,
    pub producer_version: String,
    pub tensor_artifact: SolutionArtifactRef,
    pub tensor_schema_id: String,
    pub tensor_byte_length: u64,
    pub plane: fullmag_quantities::DatasetSlicePlane,
    pub accepted_state: Option<fullmag_quantities::AcceptedStateId>,
    pub coverage: MaterializedDatasetTensorCoverage,
}

/// Strict immutable dataset manifest stored as a SolutionSet artifact.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MaterializedDatasetManifest {
    pub schema_version: String,
    pub definition: DatasetDefinition,
    pub dataset: MaterializedDataset,
    pub field: MaterializedDatasetFieldSource,
}

/// Explicit v1 name retained for callers that prefer schema-qualified types.
pub type MaterializedDatasetManifestV1 = MaterializedDatasetManifest;

impl MaterializedDatasetManifest {
    /// Construct the first durable dataset manifest for a recorded tensor.
    ///
    /// The caller supplies the exact prospective SolutionSet revision. The
    /// tensor must already be a member artifact of that revision, but the
    /// manifest artifact itself is intentionally created afterwards.
    pub fn from_recorded_tensor(
        solution: &SolutionSet,
        member_id: &str,
        tensor_artifact: &SolutionArtifactRef,
        descriptor: &TensorDescriptor,
    ) -> Result<Self> {
        solution
            .validate()
            .map_err(|error| anyhow::anyhow!(error.to_string()))
            .context("validating prospective SolutionSet for dataset manifest")?;
        if solution.revision == 0 {
            bail!("materialized dataset owner SolutionSet revision must be positive");
        }
        let member = solution
            .members
            .iter()
            .find(|member| member.member_id == member_id)
            .context("dataset tensor member is missing from the SolutionSet")?;
        let recorded = member
            .artifacts
            .iter()
            .find(|artifact| artifact.artifact_id == tensor_artifact.artifact_id)
            .context("dataset tensor artifact is missing from the SolutionSet member")?;
        if recorded != tensor_artifact {
            bail!("dataset tensor artifact differs from the SolutionSet record");
        }
        let binding = descriptor
            .field_binding
            .as_ref()
            .context("recorded tensor has no immutable field binding")?;
        if binding.format != TENSOR_FIELD_BINDING_SCHEMA {
            bail!("recorded tensor has an unsupported field binding schema");
        }
        validate_solution_tensor_descriptor(descriptor)?;
        if tensor_artifact.schema_id != SOLUTION_TENSOR_SCHEMA
            || tensor_artifact.object_ref.is_empty()
            || tensor_artifact.byte_length == 0
        {
            bail!("recorded dataset tensor artifact has an invalid schema or identity");
        }

        let source = PinnedSolutionTensorSource {
            run_id: solution.run_id.clone(),
            solution_set_id: solution.solution_set_id.clone(),
            solution_revision: solution.revision,
            member_id: member.member_id.clone(),
            artifact_id: tensor_artifact.artifact_id.clone(),
            tensor_object_ref: tensor_artifact.object_ref.clone(),
            run_spec_digest: solution.provenance.run_spec_digest.clone(),
        };
        source.validate()?;

        let definition_id = format!("definition:{}", binding.dataset.dataset_id);
        let dataset_source = DatasetSource::PinnedSolution {
            solution_id: solution.solution_set_id.clone(),
            solution_revision: solution.revision,
        };
        let definition = DatasetDefinition {
            schema_version: DATASET_CONTRACT_SCHEMA_VERSION.to_string(),
            definition_id: definition_id.clone(),
            revision: binding.dataset.revision,
            source: dataset_source.clone(),
            domain_selection: SelectionReference {
                selection_id: binding
                    .descriptor
                    .active_support
                    .support_fingerprint
                    .clone(),
                selection_revision: 1,
            },
            axes: Vec::new(),
            transforms: Vec::new(),
            evaluation_policy: DatasetEvaluationPolicy {
                precision: match tensor_artifact_byte_dtype(descriptor)? {
                    TensorDtype::F32 => EvaluationPrecision::F32,
                    TensorDtype::F64 => EvaluationPrecision::F64,
                    _ => bail!("materialized dataset supports only F32 and F64 tensors"),
                },
                approximation: ApproximationPolicy::ExactOnly,
                unavailable_data: UnavailableDataPolicy::Fail,
            },
        };

        let field = DatasetFieldRef {
            field_id: binding.field_id.clone(),
            resource_key: Some(tensor_artifact.artifact_id.clone()),
            status: DatasetStatus {
                availability: DatasetAvailability::Ready,
                reason: None,
                actions: Vec::new(),
            },
            descriptor: binding.descriptor.clone(),
        };
        let dataset = MaterializedDataset {
            schema_version: DATASET_CONTRACT_SCHEMA_VERSION.to_string(),
            dataset_id: binding.dataset.dataset_id.clone(),
            revision: binding.dataset.revision,
            definition: DatasetDefinitionRef {
                definition_id,
                revision: binding.dataset.revision,
            },
            source: dataset_source,
            status: DatasetStatus {
                availability: DatasetAvailability::Ready,
                reason: None,
                actions: Vec::new(),
            },
            axes: Vec::new(),
            samples: vec![DatasetSample {
                sample_id: binding.sample_id.clone(),
                coordinates: std::collections::BTreeMap::new(),
                items: vec![DatasetItem {
                    item_id: binding.item_id.clone(),
                    fields: vec![field],
                }],
            }],
            branches: Vec::new(),
        };

        let storage = MaterializedDatasetFieldSource {
            sample_id: binding.sample_id.clone(),
            item_id: binding.item_id.clone(),
            field_id: binding.field_id.clone(),
            source,
            group_id: binding.group_id.clone(),
            producer_id: binding.producer_id.clone(),
            producer_version: binding.producer_version.clone(),
            tensor_artifact: tensor_artifact.clone(),
            tensor_schema_id: SOLUTION_TENSOR_SCHEMA.to_string(),
            tensor_byte_length: tensor_artifact.byte_length,
            plane: binding.plane,
            accepted_state: tensor_artifact.accepted_state.clone(),
            coverage: coverage_from_tensor(descriptor)?,
        };
        let manifest = Self {
            schema_version: MATERIALIZED_DATASET_SCHEMA.to_string(),
            definition,
            dataset,
            field: storage,
        };
        manifest.validate()?;
        validate_materialized_dataset_tensor(&manifest, descriptor)?;
        Ok(manifest)
    }

    /// Validate only the bounded, owner-independent manifest structure.
    pub fn validate(&self) -> Result<()> {
        validate_manifest_structure(self)
    }
}

/// Parse a complete, hash-bound dataset manifest artifact.
pub fn parse_materialized_dataset_artifact(
    bytes: &[u8],
    artifact: &SolutionArtifactRef,
) -> Result<MaterializedDatasetManifest> {
    validate_manifest_artifact_metadata(artifact)?;
    if bytes.len() as u64 != artifact.byte_length {
        bail!("materialized dataset manifest byte length differs from its artifact");
    }
    if crate::cas::hex_sha256(bytes) != artifact.object_ref {
        bail!("materialized dataset manifest bytes do not match its CAS identity");
    }
    let manifest: MaterializedDatasetManifest =
        serde_json::from_slice(bytes).context("parsing materialized dataset manifest")?;
    manifest.validate()?;
    if artifact.accepted_state != manifest.field.accepted_state {
        bail!("materialized dataset artifact accepted state differs from its manifest");
    }
    Ok(manifest)
}

/// A materialized dataset resolved from one exact containing SolutionSet
/// revision. The `owner` may be an older immutable revision when the manifest
/// is carried forward by a later SolutionSet revision.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedMaterializedDataset {
    pub manifest: MaterializedDatasetManifest,
    pub manifest_artifact: SolutionArtifactRef,
    pub containing_solution_revision: u64,
    pub owner: SolutionSet,
}

/// Read and verify one materialized dataset from an exact SolutionSet
/// revision. Missing members or artifacts are absence (`Ok(None)`); a found
/// artifact with the wrong schema or kind is a corrupt/unsupported record and
/// fails closed.
pub fn read_materialized_dataset_artifact(
    store: &SessionStore,
    containing: &SolutionSet,
    member_id: &str,
    artifact_id: &str,
) -> Result<Option<ResolvedMaterializedDataset>> {
    let Some(resolved) =
        resolve_materialized_dataset_metadata(store, containing, member_id, artifact_id, None)?
    else {
        return Ok(None);
    };
    verify_solution_tensor_payload(store.cas(), &resolved.manifest.field.tensor_artifact)?;
    Ok(Some(resolved))
}

/// A bounded read certifies its returned ranges, not the complete field.
pub struct ResolvedMaterializedDatasetSlice {
    pub dataset: ResolvedMaterializedDataset,
    pub field: crate::solution_tensor_field::ResolvedSolutionFieldSlice,
}

/// The selected immutable manifest or semantic field differs from the request.
#[derive(Debug)]
pub struct MaterializedDatasetSliceIdentityMismatch;

impl std::fmt::Display for MaterializedDatasetSliceIdentityMismatch {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("materialized dataset slice identity differs from the pinned request")
    }
}

impl std::error::Error for MaterializedDatasetSliceIdentityMismatch {}

/// Read v1 Values bytes through their exact durable owner and existing slice
/// adapter. No discovery, live topology, state transfer, or solver is involved.
/// The manifest and tensor metadata are verified, and only touched CAS chunks
/// are verified during the payload read. Untouched chunks are not certified.
pub fn read_materialized_dataset_slice(
    store: &SessionStore,
    containing: &SolutionSet,
    member_id: &str,
    artifact_id: &str,
    expected_manifest_object_ref: &str,
    request: &fullmag_quantities::DatasetFieldSliceRequest,
) -> Result<Option<ResolvedMaterializedDatasetSlice>> {
    crate::cas::validate_hash(expected_manifest_object_ref)?;
    request
        .validate()
        .context("invalid materialized dataset slice request")?;
    let Some(dataset) = resolve_materialized_dataset_metadata(
        store,
        containing,
        member_id,
        artifact_id,
        Some(expected_manifest_object_ref),
    )?
    else {
        return Ok(None);
    };
    let manifest = &dataset.manifest;
    if request.dataset.dataset_id != manifest.dataset.dataset_id
        || request.dataset.revision != manifest.dataset.revision
        || request.sample_id != manifest.field.sample_id
        || request.item_id != manifest.field.item_id
        || request.field_id != manifest.field.field_id
    {
        return Err(MaterializedDatasetSliceIdentityMismatch.into());
    }
    let coverage = &manifest.field.coverage;
    if request
        .element_offset
        .checked_add(request.element_count)
        .is_none_or(|end| end > coverage.total_elements)
    {
        return Err(fullmag_quantities::DatasetSliceError::ElementRangeOutsideField.into());
    }
    let bytes_per_value = match coverage.dtype {
        TensorDtype::F32 => 4_u64,
        TensorDtype::F64 => 8_u64,
        _ => bail!("validated materialized dataset has unsupported dtype"),
    };
    let payload_bytes = request
        .element_count
        .checked_mul(u64::from(coverage.component_count))
        .and_then(|values| values.checked_mul(bytes_per_value))
        .context("materialized dataset slice size overflow")?;
    if payload_bytes > request.max_response_bytes {
        return Err(fullmag_quantities::DatasetSliceError::ResponseExceedsRequestBudget.into());
    }
    let field = crate::solution_tensor_field::read_pinned_solution_field_slice(
        store,
        request,
        std::slice::from_ref(&manifest.field.source),
    )?;
    validate_materialized_slice_values(&field.slice)?;
    Ok(Some(ResolvedMaterializedDatasetSlice { dataset, field }))
}

fn validate_materialized_slice_values(
    slice: &crate::dataset_slice_adapter::TensorDatasetSliceRead,
) -> Result<()> {
    use fullmag_quantities::{DatasetNumericPrecision, DatasetSliceError};
    let width = slice.manifest.precision.byte_size() as usize;
    for (part, bytes) in slice.manifest.parts.iter().zip(&slice.part_bytes) {
        for (index, scalar) in bytes.chunks_exact(width).enumerate() {
            let finite = match slice.manifest.precision {
                DatasetNumericPrecision::F32 => {
                    f32::from_le_bytes(scalar.try_into().expect("aligned F32 slice part"))
                        .is_finite()
                }
                DatasetNumericPrecision::F64 => {
                    f64::from_le_bytes(scalar.try_into().expect("aligned F64 slice part"))
                        .is_finite()
                }
            };
            if !finite {
                return Err(DatasetSliceError::NonFinitePayloadValue {
                    plane: part.plane,
                    value_index: (part.plane_offset_bytes / width as u64) as usize + index,
                }
                .into());
            }
        }
    }
    Ok(())
}

fn resolve_materialized_dataset_metadata(
    store: &SessionStore,
    containing: &SolutionSet,
    member_id: &str,
    artifact_id: &str,
    expected_manifest_object_ref: Option<&str>,
) -> Result<Option<ResolvedMaterializedDataset>> {
    containing
        .validate()
        .map_err(|error| anyhow::anyhow!(error.to_string()))
        .context("validating containing SolutionSet for materialized dataset read")?;

    let Some(member) = containing
        .members
        .iter()
        .find(|member| member.member_id == member_id)
    else {
        return Ok(None);
    };
    let Some(manifest_artifact) = member
        .artifacts
        .iter()
        .find(|artifact| artifact.artifact_id == artifact_id)
    else {
        return Ok(None);
    };
    if manifest_artifact.kind != SolutionArtifactKind::Other
        || manifest_artifact.schema_id != MATERIALIZED_DATASET_SCHEMA
    {
        bail!("selected materialized dataset artifact has unsupported schema or kind");
    }
    if expected_manifest_object_ref.is_some_and(|expected| expected != manifest_artifact.object_ref)
    {
        return Err(MaterializedDatasetSliceIdentityMismatch.into());
    }

    // Resolve the durable run owner before opening any CAS payload. This
    // protects the reader from accepting a structurally valid artifact whose
    // SolutionSet has lost its immutable accepted-submit provenance.
    crate::solution_tensor_source::verify_solution_tensor_run_owner(store.root(), containing)?;

    let manifest = read_materialized_dataset_manifest(store.cas(), manifest_artifact)?;
    validate_containing_dataset_manifest(containing, member, &manifest)?;

    let owner = if manifest.field.source.solution_revision == containing.revision {
        containing.clone()
    } else {
        let owner = store
            .solution_sets()
            .read_revision(
                &manifest.field.source.solution_set_id,
                manifest.field.source.solution_revision,
            )?
            .context("materialized dataset pinned owner revision is missing")?;
        owner
    };
    validate_materialized_dataset_owner(&manifest, &owner)?;

    // Source and owner identity are fenced before opening any tensor chunk.
    // A corrupt payload must not hide that the selected historical owner is
    // not the one named by the containing revision.
    let tensor = read_solution_tensor_artifact(store.cas(), &manifest.field.tensor_artifact)?;
    validate_materialized_dataset_tensor(&manifest, &tensor)?;

    Ok(Some(ResolvedMaterializedDataset {
        manifest,
        manifest_artifact: manifest_artifact.clone(),
        containing_solution_revision: containing.revision,
        owner,
    }))
}

/// Verify that a manifest points at one exact SolutionSet revision/member/artifact.
pub fn validate_materialized_dataset_owner(
    manifest: &MaterializedDatasetManifest,
    solution: &SolutionSet,
) -> Result<()> {
    validate_manifest_structure(manifest)?;
    solution
        .validate()
        .map_err(|error| anyhow::anyhow!(error.to_string()))
        .context("validating materialized dataset owner SolutionSet")?;
    if solution.revision == 0 {
        bail!("materialized dataset owner SolutionSet revision must be positive");
    }
    let source = &manifest.field.source;
    if source.run_id != solution.run_id
        || source.solution_set_id != solution.solution_set_id
        || source.solution_revision != solution.revision
        || source.run_spec_digest != solution.provenance.run_spec_digest
    {
        bail!("materialized dataset source does not match the exact SolutionSet owner");
    }
    let (solution_id, solution_revision) = match &manifest.dataset.source {
        DatasetSource::PinnedSolution {
            solution_id,
            solution_revision,
        } => (solution_id, *solution_revision),
        DatasetSource::ExplicitResolvedLiveSource { .. } => {
            bail!("materialized dataset must be pinned to a SolutionSet")
        }
    };
    if solution_id != &solution.solution_set_id || solution_revision != solution.revision {
        bail!("materialized dataset semantic source differs from its pinned owner");
    }
    match &manifest.definition.source {
        DatasetSource::PinnedSolution {
            solution_id,
            solution_revision,
        } if solution_id == &solution.solution_set_id
            && *solution_revision == solution.revision => {}
        _ => bail!("materialized dataset definition source differs from its pinned owner"),
    }

    let member = solution
        .members
        .iter()
        .find(|member| member.member_id == source.member_id)
        .context("materialized dataset owner member is missing")?;
    let artifact = member
        .artifacts
        .iter()
        .find(|artifact| artifact.artifact_id == source.artifact_id)
        .context("materialized dataset owner tensor artifact is missing")?;
    if artifact != &manifest.field.tensor_artifact
        || artifact.object_ref != source.tensor_object_ref
        || artifact.byte_length != manifest.field.tensor_byte_length
        || artifact.schema_id != SOLUTION_TENSOR_SCHEMA
        || artifact.accepted_state != manifest.field.accepted_state
    {
        bail!("materialized dataset tensor artifact differs from its owner record");
    }
    Ok(())
}

/// Verify the typed tensor metadata and exact coverage recorded by a manifest.
pub fn validate_materialized_dataset_tensor(
    manifest: &MaterializedDatasetManifest,
    descriptor: &TensorDescriptor,
) -> Result<()> {
    validate_manifest_structure(manifest)?;
    validate_solution_tensor_descriptor(descriptor)?;
    let binding = descriptor
        .field_binding
        .as_ref()
        .context("materialized dataset tensor has no field binding")?;
    let dataset_field = dataset_field(manifest)?;
    if binding.format != TENSOR_FIELD_BINDING_SCHEMA
        || binding.dataset
            != (MaterializedDatasetRef {
                dataset_id: manifest.dataset.dataset_id.clone(),
                revision: manifest.dataset.revision,
            })
        || binding.sample_id != manifest.field.sample_id
        || binding.item_id != manifest.field.item_id
        || binding.field_id != manifest.field.field_id
        || binding.group_id != manifest.field.group_id
        || binding.producer_id != manifest.field.producer_id
        || binding.producer_version != manifest.field.producer_version
        || binding.plane != manifest.field.plane
        || binding.descriptor != dataset_field.descriptor
    {
        bail!("materialized dataset field binding differs from its semantic field");
    }
    if manifest.field.tensor_artifact.kind != SolutionArtifactKind::State
        || manifest.field.tensor_artifact.schema_id != SOLUTION_TENSOR_SCHEMA
        || manifest.field.tensor_artifact.object_ref != manifest.field.source.tensor_object_ref
        || manifest.field.tensor_artifact.byte_length != manifest.field.tensor_byte_length
    {
        bail!("materialized dataset tensor artifact metadata is inconsistent");
    }
    let coverage = coverage_from_tensor(descriptor)?;
    if coverage != manifest.field.coverage {
        bail!("materialized dataset tensor coverage differs from its typed root");
    }
    Ok(())
}

/// Verify one manifest artifact and its complete typed tensor closure.
pub fn verify_materialized_dataset_payload(
    cas: &CasStore,
    artifact: &SolutionArtifactRef,
) -> Result<MaterializedDatasetManifest> {
    let manifest = read_materialized_dataset_manifest(cas, artifact)?;
    let tensor = verify_solution_tensor_payload(cas, &manifest.field.tensor_artifact)?;
    validate_materialized_dataset_tensor(&manifest, &tensor)?;
    Ok(manifest)
}

fn read_materialized_dataset_manifest(
    cas: &CasStore,
    artifact: &SolutionArtifactRef,
) -> Result<MaterializedDatasetManifest> {
    validate_manifest_artifact_metadata(artifact)?;
    let range = cas
        .get_verified_range(
            &artifact.object_ref,
            0,
            artifact.byte_length,
            MAX_MATERIALIZED_DATASET_METADATA_BYTES,
        )?
        .context("materialized dataset manifest CAS object is missing")?;
    if range.object_length != artifact.byte_length {
        bail!("materialized dataset manifest CAS length differs from its artifact");
    }
    parse_materialized_dataset_artifact(&range.bytes, artifact)
}

/// Verify every recognized dataset artifact carried by one SolutionSet.
///
/// Historical manifests may pin an earlier immutable revision. That owner is
/// read without recovery or mutation; the supplied solution is used only when
/// its revision is the exact pinned owner.
pub(crate) fn verify_materialized_datasets_for_solution(
    root: &Path,
    cas: &CasStore,
    solution: &SolutionSet,
) -> Result<()> {
    solution
        .validate()
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let mut dataset_revisions = BTreeSet::new();
    for member in &solution.members {
        for artifact in &member.artifacts {
            if artifact.schema_id != MATERIALIZED_DATASET_SCHEMA {
                continue;
            }
            let manifest = verify_materialized_dataset_payload(cas, artifact)?;
            register_dataset_revision(&mut dataset_revisions, &manifest)?;
            validate_containing_dataset_manifest(solution, member, &manifest)?;
            if manifest.field.source.solution_revision == solution.revision {
                validate_materialized_dataset_owner(&manifest, solution)?;
            } else {
                let historical_store = SessionStore::open_existing(root)?;
                let historical = historical_store
                    .solution_sets()
                    .read_revision(
                        &manifest.field.source.solution_set_id,
                        manifest.field.source.solution_revision,
                    )?
                    .context("historical materialized dataset owner revision is missing")?;
                validate_materialized_dataset_owner(&manifest, &historical)?;
            }
        }
    }
    Ok(())
}

fn validate_containing_dataset_manifest(
    containing: &SolutionSet,
    member: &fullmag_quantities::SolutionMember,
    manifest: &MaterializedDatasetManifest,
) -> Result<()> {
    let source = &manifest.field.source;
    if source.member_id != member.member_id {
        bail!("materialized dataset member binding differs from its containing member");
    }
    let current_tensor = member
        .artifacts
        .iter()
        .find(|candidate| candidate.artifact_id == manifest.field.tensor_artifact.artifact_id)
        .context("materialized dataset tensor artifact is missing from its containing revision")?;
    if current_tensor != &manifest.field.tensor_artifact {
        bail!("materialized dataset tensor artifact changed in its containing revision");
    }
    if source.run_id != containing.run_id
        || source.solution_set_id != containing.solution_set_id
        || source.run_spec_digest != containing.provenance.run_spec_digest
        || source.solution_revision == 0
        || source.solution_revision > containing.revision
    {
        bail!("materialized dataset owner is outside the containing SolutionSet");
    }
    Ok(())
}

/// Build and pin a dataset-manifest artifact for a prospective SolutionSet.
///
/// A valid legacy tensor without a field binding, or a valid typed field that
/// is outside this increment's single real-values contract, is preserved as
/// an opaque solution artifact and returns `Ok(None)`. Malformed roots and
/// malformed bindings remain errors.
pub fn build_materialized_dataset_artifact(
    cas: &CasStore,
    solution: &SolutionSet,
    member_id: &str,
    tensor_artifact: &SolutionArtifactRef,
) -> Result<Option<SolutionArtifactRef>> {
    let metadata = read_solution_tensor_artifact(cas, tensor_artifact)
        .context("reading recorded tensor before dataset-manifest publication")?;
    let Some(binding) = metadata.field_binding.as_ref() else {
        return Ok(None);
    };
    if binding.descriptor.complex_encoding != fullmag_quantities::ComplexEncoding::Real
        || binding.descriptor.harmonic_convention.is_some()
        || binding.plane != fullmag_quantities::DatasetSlicePlane::Values
    {
        return Ok(None);
    }
    let descriptor = verify_solution_tensor_payload(cas, tensor_artifact)
        .context("verifying recorded tensor before dataset-manifest publication")?;
    let manifest = MaterializedDatasetManifest::from_recorded_tensor(
        solution,
        member_id,
        tensor_artifact,
        &descriptor,
    )?;
    let bytes = serde_json::to_vec_pretty(&manifest)
        .context("serializing materialized dataset manifest")?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_MATERIALIZED_DATASET_METADATA_BYTES {
        bail!("materialized dataset manifest exceeds its metadata budget");
    }
    let object_ref = cas.put(&bytes)?;
    Ok(Some(SolutionArtifactRef {
        artifact_id: format!("materialized-dataset-{object_ref}"),
        kind: SolutionArtifactKind::Other,
        schema_id: MATERIALIZED_DATASET_SCHEMA.to_string(),
        object_ref,
        byte_length: bytes.len() as u64,
        accepted_state: tensor_artifact.accepted_state.clone(),
    }))
}

fn validate_manifest_artifact_metadata(artifact: &SolutionArtifactRef) -> Result<()> {
    if artifact.kind != SolutionArtifactKind::Other
        || artifact.schema_id != MATERIALIZED_DATASET_SCHEMA
        || artifact.byte_length == 0
        || artifact.byte_length > MAX_MATERIALIZED_DATASET_METADATA_BYTES
    {
        bail!("materialized dataset manifest schema or metadata budget is invalid");
    }
    crate::cas::validate_hash(&artifact.object_ref)?;
    let expected_id = format!("materialized-dataset-{}", artifact.object_ref);
    if artifact.artifact_id != expected_id {
        bail!("materialized dataset manifest artifact_id is not canonical");
    }
    Ok(())
}

fn register_dataset_revision(
    revisions: &mut BTreeSet<(String, u64)>,
    manifest: &MaterializedDatasetManifest,
) -> Result<()> {
    if !revisions.insert((
        manifest.dataset.dataset_id.clone(),
        manifest.dataset.revision,
    )) {
        bail!("materialized dataset revision is duplicated in the containing SolutionSet");
    }
    Ok(())
}

fn validate_manifest_structure(manifest: &MaterializedDatasetManifest) -> Result<()> {
    if manifest.schema_version != MATERIALIZED_DATASET_SCHEMA {
        bail!("unsupported materialized dataset manifest schema");
    }
    manifest
        .definition
        .validate()
        .map_err(|error| anyhow::anyhow!(error.to_string()))
        .context("validating materialized dataset definition")?;
    manifest
        .dataset
        .validate()
        .map_err(|error| anyhow::anyhow!(error.to_string()))
        .context("validating materialized dataset record")?;
    if manifest.definition.revision == 0
        || manifest.dataset.revision == 0
        || manifest.definition.revision != manifest.dataset.revision
        || manifest.dataset.definition.definition_id != manifest.definition.definition_id
        || manifest.dataset.definition.revision != manifest.definition.revision
        || manifest.dataset.source != manifest.definition.source
    {
        bail!("materialized dataset definition and result identity differ");
    }
    let source = match &manifest.dataset.source {
        DatasetSource::PinnedSolution {
            solution_id,
            solution_revision,
        } => {
            if solution_revision == &0 {
                bail!("materialized dataset source revision must be positive");
            }
            (solution_id, *solution_revision)
        }
        DatasetSource::ExplicitResolvedLiveSource { .. } => {
            bail!("materialized dataset source must be a pinned SolutionSet")
        }
    };
    match &manifest.definition.source {
        DatasetSource::PinnedSolution {
            solution_id,
            solution_revision,
        } if solution_id == source.0 && *solution_revision == source.1 => {}
        _ => bail!("materialized dataset definition is not pinned to its result source"),
    }
    if manifest.field.source.solution_set_id != *source.0
        || manifest.field.source.solution_revision != source.1
    {
        bail!("materialized dataset field owner differs from its pinned result source");
    }
    if manifest.definition.domain_selection.selection_revision != 1
        || manifest.definition.domain_selection.selection_id
            != manifest
                .dataset
                .samples
                .first()
                .and_then(|sample| sample.items.first())
                .and_then(|item| item.fields.first())
                .map(|field| field.descriptor.active_support.support_fingerprint.as_str())
                .unwrap_or_default()
    {
        bail!("materialized dataset domain selection is not the field support identity");
    }
    if !manifest.definition.axes.is_empty() || !manifest.definition.transforms.is_empty() {
        bail!("v1 materialized dataset does not support axes or transforms");
    }
    if manifest.dataset.axes.len() != 0
        || manifest.dataset.samples.len() != 1
        || !manifest.dataset.branches.is_empty()
    {
        bail!("v1 materialized dataset must contain one sample and no branches");
    }
    let sample = &manifest.dataset.samples[0];
    if !sample.coordinates.is_empty() || sample.items.len() != 1 {
        bail!("v1 materialized dataset sample must contain one item without coordinates");
    }
    if sample.items[0].fields.len() != 1 {
        bail!("v1 materialized dataset item must contain one field");
    }
    let dataset_field = &sample.items[0].fields[0];
    if dataset_field.status.availability != DatasetAvailability::Ready
        || dataset_field.resource_key.as_deref()
            != Some(manifest.field.tensor_artifact.artifact_id.as_str())
        || manifest.dataset.status.availability != DatasetAvailability::Ready
    {
        bail!("v1 materialized dataset field must be ready and addressable");
    }
    if manifest.field.sample_id != sample.sample_id
        || manifest.field.item_id != sample.items[0].item_id
        || manifest.field.field_id != dataset_field.field_id
    {
        bail!("materialized dataset storage identity differs from its semantic field");
    }
    manifest.field.source.validate()?;
    if let Some(accepted_state) = &manifest.field.accepted_state {
        accepted_state
            .validate()
            .map_err(|error| anyhow::anyhow!(error.to_string()))
            .context("validating materialized dataset accepted state")?;
        if accepted_state.run_id != manifest.field.source.run_id {
            bail!("materialized dataset accepted state belongs to another run");
        }
    }
    for (field, value) in [
        ("materialized field group_id", &manifest.field.group_id),
        (
            "materialized field producer_id",
            &manifest.field.producer_id,
        ),
        (
            "materialized field producer_version",
            &manifest.field.producer_version,
        ),
    ] {
        validate_text_id(field, value)?;
    }
    if manifest.field.tensor_schema_id != SOLUTION_TENSOR_SCHEMA
        || manifest.field.tensor_artifact.kind != SolutionArtifactKind::State
        || manifest.field.tensor_artifact.schema_id != SOLUTION_TENSOR_SCHEMA
        || manifest.field.tensor_artifact.object_ref != manifest.field.source.tensor_object_ref
        || manifest.field.tensor_artifact.artifact_id != manifest.field.source.artifact_id
        || manifest.field.tensor_artifact.byte_length != manifest.field.tensor_byte_length
        || manifest.field.tensor_byte_length == 0
        || manifest.field.tensor_byte_length > MAX_SOLUTION_TENSOR_METADATA_BYTES
        || manifest.field.accepted_state != manifest.field.tensor_artifact.accepted_state
    {
        bail!("materialized dataset tensor storage identity is inconsistent");
    }
    if !matches!(
        manifest.field.coverage.dtype,
        TensorDtype::F32 | TensorDtype::F64
    ) || manifest.field.coverage.endian != "little"
        || manifest.field.coverage.total_elements == 0
        || manifest.field.coverage.component_count == 0
        || manifest.field.coverage.total_bytes == 0
        || manifest.field.coverage.chunk_count == 0
    {
        bail!("materialized dataset tensor coverage is invalid");
    }
    let expected_precision = match manifest.field.coverage.dtype {
        TensorDtype::F32 => EvaluationPrecision::F32,
        TensorDtype::F64 => EvaluationPrecision::F64,
        _ => unreachable!("coverage dtype was checked above"),
    };
    if manifest.definition.evaluation_policy.precision != expected_precision
        || manifest.definition.evaluation_policy.approximation != ApproximationPolicy::ExactOnly
        || manifest.definition.evaluation_policy.unavailable_data != UnavailableDataPolicy::Fail
    {
        bail!("materialized dataset evaluation policy differs from its exact tensor coverage");
    }
    if dataset_field.descriptor.complex_encoding != fullmag_quantities::ComplexEncoding::Real
        || dataset_field.descriptor.harmonic_convention.is_some()
        || manifest.field.plane != fullmag_quantities::DatasetSlicePlane::Values
    {
        bail!("v1 materialized dataset supports only one real values field");
    }
    Ok(())
}

fn dataset_field(manifest: &MaterializedDatasetManifest) -> Result<&DatasetFieldRef> {
    manifest
        .dataset
        .samples
        .first()
        .and_then(|sample| sample.items.first())
        .and_then(|item| item.fields.first())
        .context("materialized dataset field is missing")
}

fn tensor_artifact_byte_dtype(descriptor: &TensorDescriptor) -> Result<TensorDtype> {
    if !matches!(descriptor.dtype, TensorDtype::F32 | TensorDtype::F64) {
        bail!("materialized dataset supports only F32 and F64 tensors");
    }
    Ok(descriptor.dtype)
}

fn validate_text_id(field: &str, value: &str) -> Result<()> {
    if value.trim().is_empty() || value.chars().any(char::is_control) {
        bail!("{field} must be non-empty and must not contain control characters");
    }
    Ok(())
}

fn coverage_from_tensor(
    descriptor: &TensorDescriptor,
) -> Result<MaterializedDatasetTensorCoverage> {
    validate_solution_tensor_descriptor(descriptor)?;
    let total_elements = descriptor
        .shape
        .first()
        .copied()
        .context("materialized tensor has no element axis")?;
    let component_count = match descriptor.shape.as_slice() {
        [_] => 1,
        [_, components] => *components,
        _ => bail!("materialized dataset supports scalar or vector tensors only"),
    };
    Ok(MaterializedDatasetTensorCoverage {
        total_elements: u64::try_from(total_elements)
            .context("materialized tensor element count exceeds u64")?,
        component_count: u32::try_from(component_count)
            .context("materialized tensor component count exceeds u32")?,
        dtype: tensor_artifact_byte_dtype(descriptor)?,
        endian: descriptor.endian.clone(),
        total_bytes: u64::try_from(descriptor.total_bytes())
            .context("materialized tensor byte count exceeds u64")?,
        chunk_count: u32::try_from(descriptor.chunks.len())
            .context("materialized tensor chunk count exceeds u32")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::solution_tensor_field::TensorFieldBinding;
    use crate::{FmsRunIntent, TensorChunk, TensorDescriptor};
    use fullmag_quantities::{
        ActiveSupportDescriptor, DatasetFieldDescriptor, FieldAxisDescriptor, FieldFrameDescriptor,
        FieldFrameKind, FieldNormalization, FieldResolution, FieldSampleLocation,
        FieldValueRepresentation, FunctionSpaceDescriptor, FunctionSpaceOrdering,
        MaterializedDatasetRef, QuantityId, ScientificAssessment, ScientificAssessmentStatus,
        SolutionExecutionStatus, SolutionMember, SolutionSetManifestState, SolutionSetProvenance,
        SOLUTION_SET_SCHEMA_VERSION,
    };

    fn digest(letter: char) -> String {
        format!("sha256:{}", letter.to_string().repeat(64))
    }

    fn descriptor() -> fullmag_quantities::DatasetFieldDescriptor {
        let descriptor = DatasetFieldDescriptor {
            quantity_id: QuantityId::M,
            unit: "1".to_string(),
            tensor_rank: 1,
            frame: FieldFrameDescriptor {
                kind: FieldFrameKind::Laboratory,
                frame_id: "frame:lab".to_string(),
            },
            sample_location: FieldSampleLocation::Node,
            active_support: ActiveSupportDescriptor {
                support_fingerprint: digest('c'),
                selection: None,
            },
            function_space: Some(FunctionSpaceDescriptor {
                space_id: "space:fem-h1-p1".to_string(),
                family: "H1".to_string(),
                order: 1,
                vector_dimension: 3,
                ordering: FunctionSpaceOrdering::ByNode,
                basis_id: "basis:fem-h1-p1".to_string(),
                constraints_fingerprint: None,
                partition_fingerprint: None,
                orientation_mapping_ref: None,
            }),
            topology_id: "topology".to_string(),
            carrier_id: "carrier".to_string(),
            layout_digest: digest('d'),
            axes: vec![
                FieldAxisDescriptor {
                    axis_id: "node".to_string(),
                    unit: "1".to_string(),
                    length: 2,
                },
                FieldAxisDescriptor {
                    axis_id: "component".to_string(),
                    unit: "1".to_string(),
                    length: 3,
                },
            ],
            component_axis: Some("component".to_string()),
            complex_encoding: fullmag_quantities::ComplexEncoding::Real,
            harmonic_convention: None,
            normalization: FieldNormalization::None,
            value_representation: FieldValueRepresentation::PhysicalField,
            modal_semantics: None,
            resolution: FieldResolution::Quantitative,
        };
        descriptor.validate().expect("test descriptor is valid");
        descriptor
    }

    fn tensor_artifact() -> SolutionArtifactRef {
        SolutionArtifactRef {
            artifact_id: "tensor".to_string(),
            kind: SolutionArtifactKind::State,
            schema_id: SOLUTION_TENSOR_SCHEMA.to_string(),
            object_ref: "a".repeat(64),
            byte_length: 256,
            accepted_state: None,
        }
    }

    fn legacy_tensor_descriptor(chunk_ref: &str) -> TensorDescriptor {
        TensorDescriptor {
            format: SOLUTION_TENSOR_SCHEMA.to_string(),
            name: "legacy-magnetization".to_string(),
            dtype: TensorDtype::F64,
            shape: vec![2],
            logical_axes: vec!["sample".to_string()],
            endian: "little".to_string(),
            field_binding: None,
            chunks: vec![TensorChunk {
                object_ref: chunk_ref.to_string(),
                offset: 0,
                length: 16,
                sha256: Some(chunk_ref.to_string()),
            }],
        }
    }

    fn manifest() -> MaterializedDatasetManifest {
        let field_descriptor = descriptor();
        let tensor = tensor_artifact();
        let source = PinnedSolutionTensorSource {
            run_id: "run".to_string(),
            solution_set_id: "solution".to_string(),
            solution_revision: 1,
            member_id: "member".to_string(),
            artifact_id: tensor.artifact_id.clone(),
            tensor_object_ref: tensor.object_ref.clone(),
            run_spec_digest: digest('b'),
        };
        let source_ref = DatasetSource::PinnedSolution {
            solution_id: "solution".to_string(),
            solution_revision: 1,
        };
        let definition = DatasetDefinition {
            schema_version: DATASET_CONTRACT_SCHEMA_VERSION.to_string(),
            definition_id: "definition:dataset:test".to_string(),
            revision: 1,
            source: source_ref.clone(),
            domain_selection: SelectionReference {
                selection_id: field_descriptor.active_support.support_fingerprint.clone(),
                selection_revision: 1,
            },
            axes: Vec::new(),
            transforms: Vec::new(),
            evaluation_policy: DatasetEvaluationPolicy {
                precision: EvaluationPrecision::F64,
                approximation: ApproximationPolicy::ExactOnly,
                unavailable_data: UnavailableDataPolicy::Fail,
            },
        };
        let dataset = MaterializedDataset {
            schema_version: DATASET_CONTRACT_SCHEMA_VERSION.to_string(),
            dataset_id: "dataset:test".to_string(),
            revision: 1,
            definition: DatasetDefinitionRef {
                definition_id: definition.definition_id.clone(),
                revision: 1,
            },
            source: source_ref,
            status: DatasetStatus {
                availability: DatasetAvailability::Ready,
                reason: None,
                actions: Vec::new(),
            },
            axes: Vec::new(),
            samples: vec![DatasetSample {
                sample_id: "sample".to_string(),
                coordinates: std::collections::BTreeMap::new(),
                items: vec![DatasetItem {
                    item_id: "item".to_string(),
                    fields: vec![DatasetFieldRef {
                        field_id: "field:m".to_string(),
                        resource_key: Some(tensor.artifact_id.clone()),
                        status: DatasetStatus {
                            availability: DatasetAvailability::Ready,
                            reason: None,
                            actions: Vec::new(),
                        },
                        descriptor: field_descriptor.clone(),
                    }],
                }],
            }],
            branches: Vec::new(),
        };
        MaterializedDatasetManifest {
            schema_version: MATERIALIZED_DATASET_SCHEMA.to_string(),
            definition,
            dataset,
            field: MaterializedDatasetFieldSource {
                sample_id: "sample".to_string(),
                item_id: "item".to_string(),
                field_id: "field:m".to_string(),
                source,
                group_id: "group:test".to_string(),
                producer_id: "producer:test".to_string(),
                producer_version: "1".to_string(),
                tensor_artifact: tensor,
                tensor_schema_id: SOLUTION_TENSOR_SCHEMA.to_string(),
                tensor_byte_length: 256,
                plane: fullmag_quantities::DatasetSlicePlane::Values,
                accepted_state: None,
                coverage: MaterializedDatasetTensorCoverage {
                    total_elements: 2,
                    component_count: 3,
                    dtype: TensorDtype::F64,
                    endian: "little".to_string(),
                    total_bytes: 48,
                    chunk_count: 1,
                },
            },
        }
    }

    fn solution() -> SolutionSet {
        let assessment = ScientificAssessment {
            status: ScientificAssessmentStatus::Converged,
            reason: None,
            evidence_artifact_ids: Vec::new(),
        };
        SolutionSet {
            schema_version: SOLUTION_SET_SCHEMA_VERSION.to_string(),
            solution_set_id: "solution".to_string(),
            revision: 1,
            run_id: "run".to_string(),
            manifest_state: SolutionSetManifestState::Closed,
            execution_status: SolutionExecutionStatus::Succeeded,
            scientific_assessment: assessment.clone(),
            provenance: SolutionSetProvenance {
                run_spec_digest: digest('b'),
                model_digest: digest('b'),
                physics_digest: digest('b'),
                discretization_digest: digest('b'),
                resolved_plan_digest: digest('b'),
                acquisition_digest: digest('b'),
                seed_digest: None,
            },
            members: vec![SolutionMember {
                member_id: "member".to_string(),
                task_id: "task".to_string(),
                attempt_id: "attempt".to_string(),
                ownership_epoch: 1,
                case_id: Some("case".to_string()),
                stage_id: "step".to_string(),
                execution_status: SolutionExecutionStatus::Succeeded,
                scientific_assessment: assessment,
                artifacts: vec![tensor_artifact()],
            }],
            coverage: Vec::new(),
        }
    }

    #[test]
    fn parser_rejects_oversized_or_hash_mismatched_manifest() {
        let mut artifact = SolutionArtifactRef {
            kind: SolutionArtifactKind::Other,
            schema_id: MATERIALIZED_DATASET_SCHEMA.to_string(),
            object_ref: "a".repeat(64),
            byte_length: MAX_MATERIALIZED_DATASET_METADATA_BYTES + 1,
            accepted_state: None,
            artifact_id: format!("materialized-dataset-{}", "a".repeat(64)),
        };
        assert!(parse_materialized_dataset_artifact(&[], &artifact).is_err());
        let bytes = serde_json::to_vec(&manifest()).expect("serialize manifest");
        artifact.byte_length = bytes.len() as u64;
        assert!(parse_materialized_dataset_artifact(&bytes, &artifact).is_err());
        artifact.object_ref = crate::cas::hex_sha256(&bytes);
        artifact.artifact_id = format!("materialized-dataset-{}", artifact.object_ref);
        assert!(parse_materialized_dataset_artifact(&bytes, &artifact).is_ok());
        artifact.artifact_id = "manifest-alias".to_string();
        assert!(parse_materialized_dataset_artifact(&bytes, &artifact).is_err());
    }

    #[test]
    fn duplicate_dataset_revision_is_rejected_across_members() {
        let first = manifest();
        let mut second = manifest();
        second.field.source.member_id = "other-member".to_string();
        let mut revisions = BTreeSet::new();
        assert!(register_dataset_revision(&mut revisions, &first).is_ok());
        assert!(register_dataset_revision(&mut revisions, &second).is_err());
    }

    #[test]
    fn fieldless_legacy_tensor_does_not_create_ready_dataset_manifest() {
        let directory = tempfile::tempdir().expect("temporary legacy tensor store");
        let store = SessionStore::open(directory.path().join("store")).expect("open store");
        let chunk_ref = "a".repeat(64);
        let descriptor = legacy_tensor_descriptor(&chunk_ref);
        let bytes = serde_json::to_vec(&descriptor).expect("serialize legacy descriptor");
        let object_ref = store.cas().put(&bytes).expect("publish legacy descriptor");
        let artifact = SolutionArtifactRef {
            artifact_id: "legacy-tensor".to_string(),
            kind: SolutionArtifactKind::State,
            schema_id: SOLUTION_TENSOR_SCHEMA.to_string(),
            object_ref,
            byte_length: bytes.len() as u64,
            accepted_state: None,
        };
        let result =
            build_materialized_dataset_artifact(store.cas(), &solution(), "member", &artifact)
                .expect("legacy tensor should remain opaque");
        assert!(result.is_none());
    }

    #[test]
    fn structural_identity_rejects_selection_id_and_revision_changes() {
        let mut value = manifest();
        assert!(value.validate().is_ok());
        value.definition.domain_selection.selection_id = digest('e');
        assert!(value.validate().is_err());
        let mut value = manifest();
        value.dataset.revision = 0;
        assert!(value.validate().is_err());
        let mut value = manifest();
        value.field.producer_id.clear();
        assert!(value.validate().is_err());
    }

    #[test]
    fn owner_validation_rejects_cross_run_and_cross_artifact_bindings() {
        let value = manifest();
        let owner = solution();
        assert!(validate_materialized_dataset_owner(&value, &owner).is_ok());
        let mut cross_run = owner.clone();
        cross_run.run_id = "other-run".to_string();
        assert!(validate_materialized_dataset_owner(&value, &cross_run).is_err());
        let mut cross_artifact = value;
        cross_artifact.field.source.artifact_id = "other-tensor".to_string();
        assert!(validate_materialized_dataset_owner(&cross_artifact, &owner).is_err());
        let mut cross_member = manifest();
        cross_member.field.source.member_id = "other-member".to_string();
        assert!(validate_materialized_dataset_owner(&cross_member, &owner).is_err());
    }

    fn tensor_descriptor_for_store(chunk_ref: &str) -> TensorDescriptor {
        let tensor = TensorDescriptor {
            format: SOLUTION_TENSOR_SCHEMA.to_string(),
            name: "magnetization".to_string(),
            dtype: TensorDtype::F64,
            shape: vec![2, 3],
            logical_axes: vec!["node".to_string(), "component".to_string()],
            endian: "little".to_string(),
            field_binding: Some(TensorFieldBinding {
                format: TENSOR_FIELD_BINDING_SCHEMA.to_string(),
                dataset: MaterializedDatasetRef {
                    dataset_id: "dataset:test".to_string(),
                    revision: 1,
                },
                sample_id: "sample".to_string(),
                item_id: "item".to_string(),
                field_id: "field:m".to_string(),
                group_id: "group:test".to_string(),
                producer_id: "producer:test".to_string(),
                producer_version: "1".to_string(),
                plane: fullmag_quantities::DatasetSlicePlane::Values,
                descriptor: descriptor(),
            }),
            chunks: vec![TensorChunk {
                object_ref: chunk_ref.to_string(),
                offset: 0,
                length: 48,
                sha256: Some(chunk_ref.to_string()),
            }],
        };
        validate_solution_tensor_descriptor(&tensor).expect("test tensor descriptor is valid");
        tensor
    }

    struct ReaderFixture {
        _directory: tempfile::TempDir,
        store: SessionStore,
        containing: SolutionSet,
        manifest_artifact_id: String,
    }

    fn reader_fixture(historical_owner: bool) -> ReaderFixture {
        reader_fixture_with_chunks(historical_owner, false)
    }

    fn reader_fixture_with_chunks(historical_owner: bool, split_chunks: bool) -> ReaderFixture {
        let directory = tempfile::tempdir().expect("temporary materialized dataset store");
        let store = SessionStore::open(directory.path().join("store")).expect("open store");
        let intent = FmsRunIntent::new(
            "run",
            "submit-materialized-dataset",
            serde_json::json!({"run_id": "run", "study": "test"}),
        );
        store
            .commit_run_intent(&intent)
            .expect("publish durable run intent");

        let mut owner = solution();
        owner.manifest_state = SolutionSetManifestState::Open;
        owner.execution_status = SolutionExecutionStatus::Running;
        owner.members[0].execution_status = SolutionExecutionStatus::Running;
        owner.provenance.run_spec_digest = format!("sha256:{}", intent.payload_sha256);

        let chunk_ref = store
            .cas()
            .put(&vec![0_u8; 48])
            .expect("publish tensor payload chunk");
        let mut descriptor = tensor_descriptor_for_store(&chunk_ref);
        if split_chunks {
            descriptor.chunks = [vec![0_u8; 24], vec![1_u8; 24]]
                .iter()
                .enumerate()
                .map(|(index, bytes)| {
                    let object_ref = store.cas().put(bytes).expect("publish independent chunk");
                    TensorChunk {
                        object_ref: object_ref.clone(),
                        offset: index * 24,
                        length: 24,
                        sha256: Some(object_ref),
                    }
                })
                .collect();
        }
        let descriptor_bytes = serde_json::to_vec(&descriptor).expect("serialize tensor root");
        let tensor_object_ref = store
            .cas()
            .put(&descriptor_bytes)
            .expect("publish tensor root");
        let tensor_artifact = SolutionArtifactRef {
            artifact_id: "tensor".to_string(),
            kind: SolutionArtifactKind::State,
            schema_id: SOLUTION_TENSOR_SCHEMA.to_string(),
            object_ref: tensor_object_ref,
            byte_length: descriptor_bytes.len() as u64,
            accepted_state: None,
        };
        owner.members[0].artifacts = vec![tensor_artifact.clone()];
        let manifest_artifact =
            build_materialized_dataset_artifact(store.cas(), &owner, "member", &tensor_artifact)
                .expect("build materialized dataset manifest")
                .expect("typed real tensor should produce materialized dataset");

        let containing = if historical_owner {
            store
                .publish_solution_set(&owner)
                .expect("publish historical tensor owner");
            let mut containing = owner.clone();
            containing.revision = 2;
            containing.members[0]
                .artifacts
                .push(manifest_artifact.clone());
            store
                .publish_solution_set(&containing)
                .expect("publish containing revision");
            containing
        } else {
            owner.members[0].artifacts.push(manifest_artifact.clone());
            store
                .publish_solution_set(&owner)
                .expect("publish current materialized dataset owner");
            owner
        };
        ReaderFixture {
            _directory: directory,
            store,
            containing,
            manifest_artifact_id: manifest_artifact.artifact_id,
        }
    }

    fn slice_request_for_fixture() -> fullmag_quantities::DatasetFieldSliceRequest {
        fullmag_quantities::DatasetFieldSliceRequest {
            schema_version: fullmag_quantities::DATASET_SLICE_SCHEMA_VERSION.to_string(),
            dataset: MaterializedDatasetRef {
                dataset_id: "dataset:test".to_string(),
                revision: 1,
            },
            sample_id: "sample".to_string(),
            item_id: "item".to_string(),
            field_id: "field:m".to_string(),
            element_offset: 0,
            element_count: 1,
            max_response_bytes: 24,
        }
    }

    fn fixture_manifest_ref(fixture: &ReaderFixture) -> &str {
        &fixture.containing.members[0]
            .artifacts
            .iter()
            .find(|artifact| artifact.artifact_id == fixture.manifest_artifact_id)
            .expect("fixture manifest artifact")
            .object_ref
    }

    #[test]
    fn bounded_slice_preserves_current_and_historical_owners() {
        for historical in [false, true] {
            let fixture = reader_fixture(historical);
            let request = slice_request_for_fixture();
            let resolved = read_materialized_dataset_slice(
                &fixture.store,
                &fixture.containing,
                "member",
                &fixture.manifest_artifact_id,
                fixture_manifest_ref(&fixture),
                &request,
            )
            .expect("bounded dataset read")
            .expect("fixture dataset");
            assert_eq!(resolved.dataset.owner.revision, 1);
            assert_eq!(
                resolved.dataset.containing_solution_revision,
                if historical { 2 } else { 1 }
            );
            assert_eq!(resolved.field.slice.manifest.payload_bytes, 24);
            assert_eq!(resolved.field.slice.part_bytes.concat(), vec![0_u8; 24]);
            resolved
                .field
                .slice
                .manifest
                .validate_for_request(&request)
                .expect("exact response identity");
        }
    }

    #[test]
    fn bounded_slice_fences_manifest_and_semantic_identity() {
        let fixture = reader_fixture(false);
        let request = slice_request_for_fixture();
        let error = read_materialized_dataset_slice(
            &fixture.store,
            &fixture.containing,
            "member",
            &fixture.manifest_artifact_id,
            &"f".repeat(64),
            &request,
        )
        .err()
        .expect("wrong manifest must fail");
        assert!(error.is::<MaterializedDatasetSliceIdentityMismatch>());
        let mut wrong_field = request;
        wrong_field.field_id = "another-field".to_string();
        let error = read_materialized_dataset_slice(
            &fixture.store,
            &fixture.containing,
            "member",
            &fixture.manifest_artifact_id,
            fixture_manifest_ref(&fixture),
            &wrong_field,
        )
        .err()
        .expect("wrong field must fail");
        assert!(error.is::<MaterializedDatasetSliceIdentityMismatch>());
    }

    #[test]
    fn bounded_slice_rejects_budget_and_outside_field_range() {
        let fixture = reader_fixture(false);
        for request in [
            fullmag_quantities::DatasetFieldSliceRequest {
                max_response_bytes: 23,
                ..slice_request_for_fixture()
            },
            fullmag_quantities::DatasetFieldSliceRequest {
                element_offset: 2,
                ..slice_request_for_fixture()
            },
        ] {
            let error = read_materialized_dataset_slice(
                &fixture.store,
                &fixture.containing,
                "member",
                &fixture.manifest_artifact_id,
                fixture_manifest_ref(&fixture),
                &request,
            )
            .err()
            .expect("invalid bounded request must fail");
            assert!(error.is::<fullmag_quantities::DatasetSliceError>());
        }
    }

    #[test]
    fn bounded_slice_verifies_touched_chunks_without_certifying_unread_chunks() {
        let fixture = reader_fixture_with_chunks(false, true);
        let unread_ref = fixture
            .store
            .cas()
            .put(&vec![1_u8; 24])
            .expect("existing second chunk");
        std::fs::write(
            fixture
                .store
                .root()
                .join("objects/sha256")
                .join(&unread_ref),
            vec![9_u8; 24],
        )
        .expect("corrupt isolated fixture chunk after publication");
        let request = slice_request_for_fixture();
        let resolved = read_materialized_dataset_slice(
            &fixture.store,
            &fixture.containing,
            "member",
            &fixture.manifest_artifact_id,
            fixture_manifest_ref(&fixture),
            &request,
        )
        .expect("untouched corruption is outside this read")
        .expect("fixture dataset");
        assert_eq!(resolved.field.slice.part_bytes.concat(), vec![0_u8; 24]);
        assert!(read_materialized_dataset_artifact(
            &fixture.store,
            &fixture.containing,
            "member",
            &fixture.manifest_artifact_id,
        )
        .is_err());
        let touched = fullmag_quantities::DatasetFieldSliceRequest {
            element_offset: 1,
            ..request
        };
        assert!(read_materialized_dataset_slice(
            &fixture.store,
            &fixture.containing,
            "member",
            &fixture.manifest_artifact_id,
            fixture_manifest_ref(&fixture),
            &touched,
        )
        .is_err());
    }

    #[test]
    fn bounded_slice_numeric_validation_rejects_nonfinite_values() {
        let fixture = reader_fixture(false);
        let mut resolved = read_materialized_dataset_slice(
            &fixture.store,
            &fixture.containing,
            "member",
            &fixture.manifest_artifact_id,
            fixture_manifest_ref(&fixture),
            &slice_request_for_fixture(),
        )
        .expect("valid bounded read")
        .expect("fixture dataset");
        for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            resolved.field.slice.part_bytes[0][0..8].copy_from_slice(&value.to_le_bytes());
            let error = validate_materialized_slice_values(&resolved.field.slice).unwrap_err();
            assert!(matches!(
                error.downcast_ref::<fullmag_quantities::DatasetSliceError>(),
                Some(fullmag_quantities::DatasetSliceError::NonFinitePayloadValue { .. })
            ));
        }
    }

    fn manual_manifest_artifact(
        store: &SessionStore,
        solution: &SolutionSet,
        tensor_artifact: &SolutionArtifactRef,
        tensor: &TensorDescriptor,
        run_spec_digest: String,
    ) -> SolutionArtifactRef {
        let mut manifest = MaterializedDatasetManifest::from_recorded_tensor(
            solution,
            "member",
            tensor_artifact,
            tensor,
        )
        .expect("build manual materialized dataset manifest");
        manifest.field.source.run_spec_digest = run_spec_digest;
        let bytes = serde_json::to_vec_pretty(&manifest).expect("serialize manual manifest");
        let object_ref = store.cas().put(&bytes).expect("publish manual manifest");
        SolutionArtifactRef {
            artifact_id: format!("materialized-dataset-{object_ref}"),
            kind: SolutionArtifactKind::Other,
            schema_id: MATERIALIZED_DATASET_SCHEMA.to_string(),
            object_ref,
            byte_length: bytes.len() as u64,
            accepted_state: None,
        }
    }

    #[test]
    fn reader_resolves_current_and_historical_exact_owner_revisions() {
        let current = reader_fixture(false);
        let resolved = read_materialized_dataset_artifact(
            &current.store,
            &current.containing,
            "member",
            &current.manifest_artifact_id,
        )
        .expect("read current materialized dataset")
        .expect("current materialized dataset is present");
        assert_eq!(resolved.containing_solution_revision, 1);
        assert_eq!(resolved.owner.revision, 1);
        assert_eq!(
            resolved.manifest_artifact.artifact_id,
            current.manifest_artifact_id
        );

        let historical = reader_fixture(true);
        let resolved = read_materialized_dataset_artifact(
            &historical.store,
            &historical.containing,
            "member",
            &historical.manifest_artifact_id,
        )
        .expect("read historical materialized dataset")
        .expect("historical materialized dataset is present");
        assert_eq!(resolved.containing_solution_revision, 2);
        assert_eq!(resolved.owner.revision, 1);
        assert_eq!(
            resolved.owner.solution_set_id,
            historical.containing.solution_set_id
        );
    }

    #[test]
    fn reader_returns_none_only_for_missing_records_and_rejects_owner_mismatches() {
        let fixture = reader_fixture(false);
        assert!(read_materialized_dataset_artifact(
            &fixture.store,
            &fixture.containing,
            "missing-member",
            &fixture.manifest_artifact_id,
        )
        .expect("missing member is an absent resource")
        .is_none());
        assert!(read_materialized_dataset_artifact(
            &fixture.store,
            &fixture.containing,
            "member",
            "missing-artifact",
        )
        .expect("missing artifact is an absent resource")
        .is_none());

        let mut wrong_schema = fixture.containing.clone();
        wrong_schema.members[0].artifacts.push(SolutionArtifactRef {
            artifact_id: "wrong-schema".to_string(),
            kind: SolutionArtifactKind::State,
            schema_id: SOLUTION_TENSOR_SCHEMA.to_string(),
            object_ref: "c".repeat(64),
            byte_length: 1,
            accepted_state: None,
        });
        assert!(read_materialized_dataset_artifact(
            &fixture.store,
            &wrong_schema,
            "member",
            "wrong-schema",
        )
        .is_err());

        let mut changed_tensor = fixture.containing.clone();
        changed_tensor.members[0].artifacts[0].object_ref = "d".repeat(64);
        assert!(read_materialized_dataset_artifact(
            &fixture.store,
            &changed_tensor,
            "member",
            &fixture.manifest_artifact_id,
        )
        .is_err());

        let mut wrong_owner = fixture.containing.clone();
        wrong_owner.provenance.run_spec_digest = digest('e');
        assert!(read_materialized_dataset_artifact(
            &fixture.store,
            &wrong_owner,
            "member",
            &fixture.manifest_artifact_id,
        )
        .is_err());
    }

    #[test]
    fn reader_fences_invalid_owner_before_missing_tensor_chunk() {
        let fixture = reader_fixture(false);
        let mut containing = fixture.containing.clone();
        let missing_chunk_ref = "f".repeat(64);
        let tensor = tensor_descriptor_for_store(&missing_chunk_ref);
        let tensor_bytes = serde_json::to_vec(&tensor).expect("serialize missing-chunk root");
        let tensor_object_ref = fixture
            .store
            .cas()
            .put(&tensor_bytes)
            .expect("publish missing-chunk tensor root");
        let tensor_artifact = SolutionArtifactRef {
            artifact_id: "missing-tensor".to_string(),
            kind: SolutionArtifactKind::State,
            schema_id: SOLUTION_TENSOR_SCHEMA.to_string(),
            object_ref: tensor_object_ref,
            byte_length: tensor_bytes.len() as u64,
            accepted_state: None,
        };
        containing.members[0]
            .artifacts
            .push(tensor_artifact.clone());
        let invalid_owner = manual_manifest_artifact(
            &fixture.store,
            &containing,
            &tensor_artifact,
            &tensor,
            digest('e'),
        );
        containing.members[0].artifacts.push(invalid_owner.clone());
        let owner_error = read_materialized_dataset_artifact(
            &fixture.store,
            &containing,
            "member",
            &invalid_owner.artifact_id,
        )
        .unwrap_err();
        assert!(owner_error
            .to_string()
            .contains("outside the containing SolutionSet"));

        let valid_owner = manual_manifest_artifact(
            &fixture.store,
            &containing,
            &tensor_artifact,
            &tensor,
            containing.provenance.run_spec_digest.clone(),
        );
        containing.members[0].artifacts.push(valid_owner.clone());
        let payload_error = read_materialized_dataset_artifact(
            &fixture.store,
            &containing,
            "member",
            &valid_owner.artifact_id,
        )
        .unwrap_err();
        assert!(payload_error.to_string().contains("missing"));
    }
}
