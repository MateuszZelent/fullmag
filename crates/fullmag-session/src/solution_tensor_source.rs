//! Resolve a tensor through its immutable solution owner, never from a path
//! or a caller-supplied descriptor. Tensor bytes keep their existing schema.

use crate::{CasStore, FmsRunIntent, SessionStore, TensorDescriptor};
use anyhow::{bail, Context, Result};
use fullmag_quantities::{
    AcceptedStateId, ScientificAssessment, SolutionArtifactRef, SolutionExecutionStatus,
    SolutionSetManifestState, SolutionSetProvenance,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::io::Read;

pub const SOLUTION_TENSOR_SCHEMA: &str = "fullmag.tensor.v1";
pub const MAX_SOLUTION_TENSOR_METADATA_BYTES: u64 = 4 * 1024 * 1024;
pub const MAX_SOLUTION_TENSOR_CHUNKS: usize = 16_384;
const MAX_RUN_INTENT_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PinnedSolutionTensorSource {
    pub run_id: String,
    pub solution_set_id: String,
    pub solution_revision: u64,
    pub member_id: String,
    pub artifact_id: String,
    /// Bare lowercase CAS hash, independent of presentation or active session.
    pub tensor_object_ref: String,
    pub run_spec_digest: String,
}

impl PinnedSolutionTensorSource {
    pub fn validate(&self) -> Result<()> {
        crate::repository_path::validate_store_id(&self.run_id)?;
        for id in [&self.solution_set_id, &self.member_id, &self.artifact_id] {
            if id.trim().is_empty() || id.len() > 1024 || id.chars().any(char::is_control) {
                bail!("solution tensor identity is empty, too long or contains control characters");
            }
        }
        if self.solution_revision == 0
            || !fullmag_quantities::is_canonical_sha256(&self.run_spec_digest)
        {
            bail!(
                "solution tensor requires a positive pinned revision and canonical RunSpec digest"
            );
        }
        crate::cas::validate_hash(&self.tensor_object_ref)
    }
}

/// Resolved metadata is not a whole-field integrity or scientific certificate.
/// Payload chunks are verified by the publication barrier and actual CAS reads.
pub struct ResolvedSolutionTensor {
    pub source: PinnedSolutionTensorSource,
    pub artifact: SolutionArtifactRef,
    pub tensor: TensorDescriptor,
    pub manifest_state: SolutionSetManifestState,
    pub execution_status: SolutionExecutionStatus,
    pub member_execution_status: SolutionExecutionStatus,
    pub scientific_assessment: ScientificAssessment,
    pub member_scientific_assessment: ScientificAssessment,
    pub provenance: SolutionSetProvenance,
    pub accepted_state: Option<AcceptedStateId>,
}

pub fn resolve_solution_tensor(
    store: &SessionStore,
    source: &PinnedSolutionTensorSource,
) -> Result<ResolvedSolutionTensor> {
    source.validate()?;
    // Keep this read bounded even if a caller opens an untrusted existing store.
    let path = crate::repository_path::checked_path(
        store.root(),
        &format!("runs/{}/run_intent.json", source.run_id),
    )?;
    let mut bytes = Vec::new();
    std::fs::File::open(&path)
        .context("solution tensor run intent is missing")?
        .take(MAX_RUN_INTENT_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_RUN_INTENT_BYTES {
        bail!("solution tensor run intent exceeds metadata budget");
    }
    let intent: FmsRunIntent = serde_json::from_slice(&bytes)?;
    intent.validate()?;
    if intent.run_id != source.run_id
        || format!("sha256:{}", intent.payload_sha256) != source.run_spec_digest
    {
        bail!("solution tensor RunSpec owner mismatch");
    }
    let solution = store
        .solution_sets()
        .read_revision(&source.solution_set_id, source.solution_revision)?
        .context("pinned solution tensor revision is missing")?;
    if solution.run_id != source.run_id
        || solution.provenance.run_spec_digest != source.run_spec_digest
    {
        bail!("solution tensor run or RunSpec provenance mismatch");
    }
    let member = solution
        .members
        .iter()
        .find(|member| member.member_id == source.member_id)
        .context("pinned solution tensor member is missing")?;
    let artifact = member
        .artifacts
        .iter()
        .find(|artifact| artifact.artifact_id == source.artifact_id)
        .context("pinned solution tensor artifact is missing")?;
    if artifact.object_ref != source.tensor_object_ref
        || artifact.schema_id != SOLUTION_TENSOR_SCHEMA
    {
        bail!("pinned solution artifact is not the requested tensor object/schema");
    }
    let tensor = read_solution_tensor_artifact(store.cas(), artifact)?;
    Ok(ResolvedSolutionTensor {
        source: source.clone(),
        artifact: artifact.clone(),
        tensor,
        manifest_state: solution.manifest_state,
        execution_status: solution.execution_status,
        member_execution_status: member.execution_status,
        scientific_assessment: solution.scientific_assessment.clone(),
        member_scientific_assessment: member.scientific_assessment.clone(),
        provenance: solution.provenance.clone(),
        accepted_state: artifact.accepted_state.clone(),
    })
}

pub(crate) fn read_solution_tensor_artifact(
    cas: &CasStore,
    artifact: &SolutionArtifactRef,
) -> Result<TensorDescriptor> {
    validate_metadata_length(artifact)?;
    let range = cas
        .get_verified_range(
            &artifact.object_ref,
            0,
            artifact.byte_length,
            MAX_SOLUTION_TENSOR_METADATA_BYTES,
        )?
        .context("solution tensor descriptor CAS object is missing")?;
    if range.object_length != artifact.byte_length {
        bail!("solution tensor descriptor length mismatch");
    }
    parse_solution_tensor_artifact(&range.bytes, artifact)
}

pub(crate) fn validate_metadata_length(artifact: &SolutionArtifactRef) -> Result<()> {
    if artifact.schema_id != SOLUTION_TENSOR_SCHEMA
        || artifact.byte_length == 0
        || artifact.byte_length > MAX_SOLUTION_TENSOR_METADATA_BYTES
    {
        bail!("solution tensor descriptor schema or metadata byte budget is invalid");
    }
    crate::cas::validate_hash(&artifact.object_ref)
}

pub(crate) fn parse_solution_tensor_artifact(
    bytes: &[u8],
    artifact: &SolutionArtifactRef,
) -> Result<TensorDescriptor> {
    validate_metadata_length(artifact)?;
    if bytes.len() as u64 != artifact.byte_length
        || crate::cas::hex_sha256(bytes) != artifact.object_ref
    {
        bail!("solution tensor descriptor bytes do not match pinned CAS identity/length");
    }
    let descriptor: TensorDescriptor = serde_json::from_slice(bytes)?;
    validate_solution_tensor_descriptor(&descriptor)?;
    Ok(descriptor)
}

pub(crate) fn validate_solution_tensor_descriptor(descriptor: &TensorDescriptor) -> Result<()> {
    if descriptor.format != SOLUTION_TENSOR_SCHEMA
        || descriptor.endian != "little"
        || descriptor.name.trim().is_empty()
        || descriptor.name.chars().any(char::is_control)
        || descriptor.shape.len() != descriptor.logical_axes.len()
        || descriptor.shape.len() > 32
        || descriptor.chunks.is_empty()
        || descriptor.chunks.len() > MAX_SOLUTION_TENSOR_CHUNKS
    {
        bail!("solution tensor descriptor format, axes or chunk budget is invalid");
    }
    let mut axes = BTreeSet::new();
    for axis in &descriptor.logical_axes {
        if axis.trim().is_empty() || axis.chars().any(char::is_control) || !axes.insert(axis) {
            bail!("solution tensor axes are empty, duplicated or contain controls");
        }
    }
    let total_values = descriptor
        .shape
        .iter()
        .try_fold(1usize, |total, dimension| total.checked_mul(*dimension))
        .context("solution tensor shape overflow")?;
    let width = descriptor.dtype.byte_size();
    let total_bytes = total_values
        .checked_mul(width)
        .context("solution tensor byte size overflow")?;
    if total_bytes == 0 {
        bail!("solution tensor has no material payload");
    }
    let mut chunks = descriptor.chunks.iter().collect::<Vec<_>>();
    chunks.sort_unstable_by_key(|chunk| chunk.offset);
    let mut cursor = 0usize;
    for chunk in chunks {
        crate::cas::validate_hash(&chunk.object_ref)?;
        if chunk
            .sha256
            .as_ref()
            .is_some_and(|hash| hash != &chunk.object_ref)
            || chunk.length == 0
            || chunk.offset != cursor
            || chunk.offset % width != 0
            || chunk.length % width != 0
        {
            bail!("solution tensor chunk identity, coverage or scalar alignment mismatch");
        }
        cursor = cursor
            .checked_add(chunk.length)
            .context("solution tensor chunk range overflow")?;
        if cursor > total_bytes {
            bail!("solution tensor chunk exceeds shape");
        }
    }
    if cursor != total_bytes {
        bail!("solution tensor chunks do not cover shape");
    }
    Ok(())
}

/// Called under the SessionStore writer lease before publishing a tensor root.
pub(crate) fn verify_solution_tensor_payload(
    cas: &CasStore,
    artifact: &SolutionArtifactRef,
) -> Result<TensorDescriptor> {
    let descriptor = read_solution_tensor_artifact(cas, artifact)?;
    for chunk in &descriptor.chunks {
        let length = cas
            .verified_length(&chunk.object_ref)?
            .context("solution tensor payload chunk is missing")?;
        if length != chunk.length as u64 {
            bail!("solution tensor payload chunk length mismatch");
        }
    }
    Ok(descriptor)
}

#[cfg(test)]
#[path = "solution_tensor_source_tests.rs"]
mod tests;
