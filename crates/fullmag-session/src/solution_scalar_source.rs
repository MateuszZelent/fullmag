//! Resolve one bounded scalar through its immutable solution-set owner.
//!
//! This module verifies the durable identity and CAS envelope only.  The
//! application layer remains responsible for decoding and validating the
//! scientific scalar payload.

use crate::SessionStore;
use anyhow::{bail, Context, Result};
use fullmag_quantities::{
    AcceptedStateId, ScientificAssessment, SolutionArtifactKind, SolutionArtifactRef,
    SolutionExecutionStatus, SolutionSetManifestState, SolutionSetProvenance,
};
use serde::{Deserialize, Serialize};

/// Artifact schema tuple emitted by the typed study producer.
///
/// The embedded payload separately declares `study_scalar.v1`; this session
/// boundary does not decode that payload and only gates the durable artifact
/// tuple here.
pub const SOLUTION_SCALAR_SCHEMA: &str = "fullmag.study.scalar_json@v1";
pub const MAX_SOLUTION_SCALAR_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PinnedSolutionScalarSource {
    pub run_id: String,
    pub solution_set_id: String,
    pub solution_revision: u64,
    pub member_id: String,
    pub artifact_id: String,
    /// Bare lowercase CAS hash pinned by the immutable solution revision.
    pub scalar_object_ref: String,
    /// The exact accepted RunSpec owner digest, in `sha256:<hex>` form.
    pub run_spec_digest: String,
}

impl PinnedSolutionScalarSource {
    pub fn validate(&self) -> Result<()> {
        crate::repository_path::validate_store_id(&self.run_id)?;
        for id in [&self.solution_set_id, &self.member_id, &self.artifact_id] {
            if id.trim().is_empty() || id.len() > 1024 || id.chars().any(char::is_control) {
                bail!("solution scalar identity is empty, too long or contains control characters");
            }
        }
        if self.solution_revision == 0
            || !fullmag_quantities::is_canonical_sha256(&self.run_spec_digest)
        {
            bail!(
                "solution scalar requires a positive pinned revision and canonical RunSpec digest"
            );
        }
        crate::cas::validate_hash(&self.scalar_object_ref)
    }
}

/// CAS bytes and immutable owner metadata for one pinned scalar.
///
/// The bytes are bounded and hash-verified, but intentionally remain opaque
/// here.  This is not a scientific assessment or a runtime qualification.
pub struct ResolvedSolutionScalar {
    pub source: PinnedSolutionScalarSource,
    pub artifact: SolutionArtifactRef,
    pub bytes: Vec<u8>,
    pub manifest_state: SolutionSetManifestState,
    pub execution_status: SolutionExecutionStatus,
    pub member_execution_status: SolutionExecutionStatus,
    pub scientific_assessment: ScientificAssessment,
    pub member_scientific_assessment: ScientificAssessment,
    pub provenance: SolutionSetProvenance,
    pub accepted_state: Option<AcceptedStateId>,
}

pub fn resolve_solution_scalar(
    store: &SessionStore,
    source: &PinnedSolutionScalarSource,
) -> Result<ResolvedSolutionScalar> {
    source.validate()?;
    crate::solution_tensor_source::read_solution_run_owner(
        store.root(),
        &source.run_id,
        &source.run_spec_digest,
    )?;
    let solution = store
        .solution_sets()
        .read_revision(&source.solution_set_id, source.solution_revision)?
        .context("pinned solution scalar revision is missing")?;
    if solution.run_id != source.run_id
        || solution.provenance.run_spec_digest != source.run_spec_digest
    {
        bail!("solution scalar run or RunSpec provenance mismatch");
    }
    let member = solution
        .members
        .iter()
        .find(|member| member.member_id == source.member_id)
        .context("pinned solution scalar member is missing")?;
    let artifact = member
        .artifacts
        .iter()
        .find(|artifact| artifact.artifact_id == source.artifact_id)
        .context("pinned solution scalar artifact is missing")?;
    if artifact.object_ref != source.scalar_object_ref {
        bail!("pinned solution scalar object differs from the requested CAS identity");
    }
    let bytes = read_solution_scalar_artifact(store, artifact)?;
    Ok(ResolvedSolutionScalar {
        source: source.clone(),
        artifact: artifact.clone(),
        bytes,
        manifest_state: solution.manifest_state,
        execution_status: solution.execution_status,
        member_execution_status: member.execution_status,
        scientific_assessment: solution.scientific_assessment.clone(),
        member_scientific_assessment: member.scientific_assessment.clone(),
        provenance: solution.provenance.clone(),
        accepted_state: artifact.accepted_state.clone(),
    })
}

fn read_solution_scalar_artifact(
    store: &SessionStore,
    artifact: &SolutionArtifactRef,
) -> Result<Vec<u8>> {
    if artifact.kind != SolutionArtifactKind::Table
        || artifact.schema_id != SOLUTION_SCALAR_SCHEMA
        || artifact.byte_length == 0
        || artifact.byte_length > MAX_SOLUTION_SCALAR_BYTES
    {
        bail!("solution scalar artifact schema, kind or byte budget is invalid");
    }
    crate::cas::validate_hash(&artifact.object_ref)?;
    let maximum = usize::try_from(MAX_SOLUTION_SCALAR_BYTES)
        .context("solution scalar byte budget exceeds platform limits")?;
    let bytes = crate::repository_path::read_bounded_regular_file(
        store.root(),
        &format!("objects/sha256/{}", artifact.object_ref),
        maximum,
    )
    .context("reading bounded solution scalar CAS object")?;
    if bytes.len() as u64 != artifact.byte_length
        || crate::cas::hex_sha256(&bytes) != artifact.object_ref
    {
        bail!("solution scalar bytes do not match pinned CAS identity or length");
    }
    Ok(bytes)
}

#[cfg(test)]
#[path = "solution_scalar_source_tests.rs"]
mod tests;
