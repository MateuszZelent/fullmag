//! Cold, read-only integrity gate for one explicitly pinned historical tensor.

use anyhow::{bail, Context, Result};
use fullmag_session::{
    solution_tensor_source::PinnedSolutionTensorSource, FmsArtifactCatalog, FmsArtifactStatus,
    FmsStudyOutputManifest, FmsStudyOutputManifestEntry, SessionStore,
};
use std::io::Read;

const MAX_CATALOG_BYTES: u64 = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;

/// Resolve the source from its durable attempt manifest, then check the full
/// saved field, local-node map and indexed geometry. Legacy receipts are still
/// readable through the compatibility reader, but cannot pass this new gate.
pub fn verify_pinned_native_fem_snapshot(
    store: &SessionStore,
    pinned: &PinnedSolutionTensorSource,
    source_artifact_id: &str,
) -> Result<fullmag_quantities::fem_state_snapshot_receipt::FemLocalNodeSnapshotReceipt> {
    pinned.validate()?;
    fullmag_session::repository_path::validate_store_id(source_artifact_id)?;
    let resolved = fullmag_session::solution_tensor_source::resolve_solution_tensor(store, pinned)?;
    let binding = resolved
        .tensor
        .field_binding
        .as_ref()
        .context("saved snapshot tensor has no field binding")?;
    if binding.item_id != source_artifact_id {
        bail!("saved snapshot source artifact differs from the pinned tensor binding");
    }
    let owner = store
        .solution_sets()
        .read_revision(&pinned.solution_set_id, pinned.solution_revision)?
        .context("saved snapshot exact owner revision is missing")?;
    let member = owner
        .members
        .iter()
        .find(|member| member.member_id == pinned.member_id)
        .context("saved snapshot exact owner member is missing")?;
    let path = fullmag_session::repository_path::checked_path(
        store.root(),
        &format!("runs/{}/artifact_catalog.json", pinned.run_id),
    )?;
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(MAX_CATALOG_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_CATALOG_BYTES {
        bail!("saved snapshot artifact catalog exceeds metadata budget");
    }
    let catalog: FmsArtifactCatalog = serde_json::from_slice(&bytes)?;
    catalog.validate()?;
    if catalog.run_id != pinned.run_id {
        bail!("saved snapshot artifact catalog belongs to another run");
    }
    let source = catalog
        .entries
        .iter()
        .find(|entry| entry.artifact_id == source_artifact_id)
        .context("saved snapshot source artifact is absent from the catalog")?;
    if source.status != FmsArtifactStatus::Published || source.study_output.is_none() {
        bail!("saved snapshot source is not a published study output");
    }
    let lineage = source
        .study_output
        .as_ref()
        .context("saved source lineage missing")?;
    if member.task_id != source.task_id
        || member.attempt_id != source.attempt_id
        || member.ownership_epoch != source.ownership_epoch
        || member.stage_id != lineage.step_id
        || member.case_id.as_deref() != Some(lineage.case_id.as_str())
    {
        bail!("saved snapshot catalog source differs from its pinned member attempt");
    }
    let mut manifests = catalog.entries.iter().filter(|entry| {
        entry.artifact_type == "study_output_manifest"
            && entry.status == FmsArtifactStatus::Published
            && entry.task_id == source.task_id
            && entry.attempt_id == source.attempt_id
            && entry.ownership_epoch == source.ownership_epoch
    });
    let carrier = manifests
        .next()
        .context("saved snapshot attempt manifest is missing")?;
    if manifests.next().is_some() {
        bail!("saved snapshot attempt manifest is ambiguous");
    }
    let object_ref = carrier
        .object_ref
        .as_deref()
        .context("saved snapshot manifest has no CAS reference")?;
    if object_ref != carrier.content_sha256 {
        bail!("saved snapshot manifest CAS identity mismatch");
    }
    // The producer stores the attempt manifest in the metadata member (case
    // None), separate from the case containing the state and its tensor.
    let mut owner_carriers = owner
        .members
        .iter()
        .filter(|candidate| {
            candidate.case_id.is_none()
                && candidate.task_id == member.task_id
                && candidate.attempt_id == member.attempt_id
                && candidate.ownership_epoch == member.ownership_epoch
                && candidate.stage_id == member.stage_id
        })
        .flat_map(|candidate| &candidate.artifacts)
        .filter(|artifact| artifact.artifact_id == carrier.artifact_id);
    let owner_carrier = owner_carriers
        .next()
        .context("saved snapshot manifest is absent from exact owner")?;
    if owner_carriers.next().is_some()
        || owner_carrier.object_ref != object_ref
        || owner_carrier.kind != fullmag_quantities::SolutionArtifactKind::Diagnostic
    {
        bail!("saved snapshot manifest differs from its exact owner artifact");
    }
    let length = store
        .cas()
        .verified_length(object_ref)?
        .context("saved snapshot manifest CAS object is missing")?;
    if length == 0 || length > MAX_MANIFEST_BYTES {
        bail!("saved snapshot manifest exceeds metadata budget or is empty");
    }
    if owner_carrier.byte_length != length {
        bail!("saved snapshot manifest length differs from exact owner");
    }
    let payload = store
        .cas()
        .get_verified_range(object_ref, 0, length, MAX_MANIFEST_BYTES)?
        .context("saved snapshot manifest CAS object disappeared")?;
    if payload.object_length != length {
        bail!("saved snapshot manifest changed length during read");
    }
    let manifest: FmsStudyOutputManifest = serde_json::from_slice(&payload.bytes)?;
    manifest.validate()?;
    // The producer uses its current schema id for the carrier, including
    // compatible historical payloads, so the exact owner follows that rule.
    if owner_carrier.schema_id != fullmag_session::FMS_STUDY_OUTPUT_MANIFEST_SCHEMA
        || manifest
            .accepted_state_ref
            .as_ref()
            .map(|reference| &reference.id)
            != resolved.artifact.accepted_state.as_ref()
    {
        bail!("saved snapshot manifest schema or accepted state differs from pinned tensor");
    }
    let output = select_output(&catalog, &manifest, source_artifact_id)?;
    if source.artifact_type != output.data_kind {
        bail!("saved snapshot catalog artifact type differs from manifest output");
    }
    let receipt = super::read_pinned_study_tensor_snapshot(store, pinned, output)?
        .context("legacy saved source has no native snapshot receipt")?;
    if receipt.native_node_map_sha256.is_none() || receipt.native_indexed_geometry_sha256.is_none()
    {
        bail!("saved snapshot gate requires native map and indexed geometry receipts");
    }
    Ok(receipt)
}

fn select_output<'a>(
    catalog: &FmsArtifactCatalog,
    manifest: &'a FmsStudyOutputManifest,
    source_artifact_id: &str,
) -> Result<&'a FmsStudyOutputManifestEntry> {
    let source = catalog
        .entries
        .iter()
        .find(|entry| entry.artifact_id == source_artifact_id)
        .context("saved snapshot source disappeared from catalog")?;
    let lineage = source
        .study_output
        .as_ref()
        .context("saved snapshot source has no lineage")?;
    if manifest.run_id != catalog.run_id
        || manifest.task_id != source.task_id
        || manifest.attempt_id != source.attempt_id
        || manifest.ownership_epoch != source.ownership_epoch
        || manifest.step_id != lineage.step_id
    {
        bail!("saved snapshot manifest differs from its historical source attempt");
    }
    let mut outputs = manifest
        .outputs
        .iter()
        .filter(|output| output.artifact_id == source_artifact_id);
    let output = outputs
        .next()
        .context("saved snapshot source is absent from attempt manifest")?;
    if outputs.next().is_some()
        || output.port_id != lineage.port_id
        || output.case_id != lineage.case_id
        || output.object_ref != source.content_sha256
        || source.object_ref.as_deref() != Some(output.object_ref.as_str())
        || output.content_sha256 != source.content_sha256
    {
        bail!("saved snapshot manifest output differs from its catalog source");
    }
    Ok(output)
}

#[cfg(test)]
#[path = "saved_snapshot_gate/tests.rs"]
mod tests;
