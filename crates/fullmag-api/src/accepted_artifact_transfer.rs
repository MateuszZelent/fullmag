//! Builds a Fullmag-owned transfer manifest from one accepted, completed
//! Study task. Network authorization and broker transfer are deliberately
//! owned by a later MicroLab contract adapter.

use anyhow::{bail, Context, Result};
use fullmag_application::{
    ArtifactTransferDirectionV1, ArtifactTransferEntryV1, ArtifactTransferManifestV1,
    ArtifactTransferProvenanceV1, AttemptId, RunId, RunSpecification, TaskId,
    STUDY_MAGNETIZATION_CODEC_ID, STUDY_MAGNETIZATION_CODEC_VERSION, STUDY_SCALAR_CODEC_ID,
    STUDY_SCALAR_CODEC_VERSION,
};
use fullmag_authoring::{StudyPlan, StudyPortDataKind};
use fullmag_session::{FmsArtifactStatus, FmsStudyOutputManifest, SessionStore};

const MAX_STUDY_OUTPUT_MANIFEST_BYTES: u64 = 16 * 1024 * 1024;

/// Materialize a transfer manifest only for the exact durable successful
/// attempt named by the caller. This is a local source adapter, not an HTTP
/// route or authorization check; a future MicroLab adapter must apply its
/// own principal, allocation and scoped-grant checks before sending bytes.
#[allow(dead_code)]
pub(crate) fn build_accepted_output_transfer_manifest(
    store: &SessionStore,
    run_id: &str,
    task_id: &str,
    attempt_id: &str,
) -> Result<ArtifactTransferManifestV1> {
    fullmag_session::repository_path::validate_store_id(run_id)
        .context("output transfer run ID is invalid")?;
    fullmag_session::repository_path::validate_store_id(task_id)
        .context("output transfer task ID is invalid")?;
    fullmag_session::repository_path::validate_store_id(attempt_id)
        .context("output transfer attempt ID is invalid")?;
    let run_id =
        RunId::parse(run_id.to_owned()).map_err(|error| anyhow::anyhow!(error.to_string()))?;
    TaskId::parse(task_id.to_owned()).map_err(|error| anyhow::anyhow!(error.to_string()))?;
    AttemptId::parse(attempt_id.to_owned()).map_err(|error| anyhow::anyhow!(error.to_string()))?;

    let intent = store
        .read_run_intent(run_id.as_str())?
        .context("output transfer requires a durable accepted RunIntent")?;
    let specification: RunSpecification = serde_json::from_value(intent.specification.clone())
        .context("accepted output transfer RunSpec is invalid")?;
    specification
        .validate()
        .map_err(|error| anyhow::anyhow!(error.to_string()))
        .context("validate the accepted output transfer RunSpec")?;
    if specification.run_id != run_id || specification.fingerprint()? != intent.payload_sha256 {
        bail!("accepted output transfer RunSpec identity or fingerprint differs from intent");
    }
    let definition_ref = intent
        .definition_object_ref
        .as_deref()
        .context("accepted output transfer has no immutable project definition")?;
    if definition_ref != specification.snapshot.definition_sha256
        || store.cas().verified_length(definition_ref)?.is_none()
    {
        bail!("accepted project definition is missing or differs from its RunSpec snapshot");
    }
    let study_ref = intent
        .study_object_ref
        .as_deref()
        .context("accepted output transfer has no immutable Study object")?;
    if study_ref != specification.study.plan_sha256 {
        bail!("accepted Study object differs from its RunSpec reference");
    }
    let study_bytes = read_bounded_cas_object(store, study_ref, MAX_STUDY_OUTPUT_MANIFEST_BYTES)
        .context("read the bounded accepted StudyPlan")?;
    let study: StudyPlan = serde_json::from_slice(&study_bytes)
        .context("accepted StudyPlan is not a typed document")?;
    study
        .validate()
        .map_err(|error| anyhow::anyhow!(error.to_string()))
        .context("validate the accepted StudyPlan")?;
    if study.canonical_sha256()? != study_ref
        || study.study_id != specification.study.study_id.as_str()
        || study.schema_version != specification.study.plan_version
    {
        bail!("accepted StudyPlan differs from its immutable RunSpec reference");
    }
    let catalog_ref = intent
        .study_catalog_object_ref
        .as_deref()
        .context("accepted output transfer has no immutable Study catalog")?;
    if catalog_ref != specification.study_catalog_sha256
        || store.cas().verified_length(catalog_ref)?.is_none()
    {
        bail!("accepted Study catalog is missing or differs from its RunSpec reference");
    }

    let run_catalog = store
        .read_run_catalog(run_id.as_str())?
        .context("output transfer requires a durable run catalog")?;
    let task = run_catalog
        .tasks
        .iter()
        .find(|task| task.task_id == task_id)
        .context("output transfer task is absent from the run catalog")?;
    let ownership_epoch = task
        .ownership_epoch
        .context("output transfer task has no ownership epoch")?;
    if task.lifecycle != fullmag_session::FmsTaskLifecycle::Succeeded
        || task.attempt_id.as_deref() != Some(attempt_id)
        || task.resolved_input_fingerprint.is_none()
        || task.artifact_ids.is_empty()
    {
        bail!("output transfer does not identify the exact successful task attempt");
    }

    let artifact_catalog = store
        .read_artifact_catalog(run_id.as_str())?
        .context("output transfer requires a durable artifact catalog")?;
    artifact_catalog
        .validate()
        .context("validate the accepted output artifact catalog")?;

    let mut output_manifests = artifact_catalog.entries.iter().filter(|entry| {
        entry.artifact_type == "study_output_manifest"
            && entry.task_id == task_id
            && entry.attempt_id == attempt_id
            && entry.ownership_epoch == ownership_epoch
            && entry.status == FmsArtifactStatus::Published
            && entry.required
            && entry.study_output.is_none()
            && task.artifact_ids.contains(&entry.artifact_id)
    });
    let output_manifest_artifact = output_manifests
        .next()
        .context("output transfer requires a published manifest for this exact attempt")?;
    if output_manifests.next().is_some() {
        bail!("output transfer found an ambiguous output manifest for this attempt");
    }
    let output_manifest_ref = output_manifest_artifact
        .object_ref
        .as_deref()
        .context("published output manifest has no CAS reference")?;
    if output_manifest_ref != output_manifest_artifact.content_sha256 {
        bail!("output manifest CAS reference differs from its catalog digest");
    }
    let output_manifest_bytes =
        read_bounded_cas_object(store, output_manifest_ref, MAX_STUDY_OUTPUT_MANIFEST_BYTES)
            .context("read the bounded, verified Study output manifest")?;
    let output_manifest: FmsStudyOutputManifest = serde_json::from_slice(&output_manifest_bytes)
        .context("published Study output manifest is not a typed document")?;
    output_manifest
        .validate()
        .context("validate the published Study output manifest")?;
    if output_manifest.accepted_state_ref.is_some() || output_manifest.observation_source.is_some()
    {
        bail!("output transfer does not yet represent accepted-state or observation-source references");
    }
    if output_manifest.run_id != run_id.as_str()
        || output_manifest.task_id != task_id
        || output_manifest.attempt_id != attempt_id
        || output_manifest.ownership_epoch != ownership_epoch
    {
        bail!("Study output manifest differs from the requested task attempt");
    }

    let step = study
        .steps
        .iter()
        .find(|step| step.step_id == output_manifest.step_id)
        .context("Study output manifest names a step outside the accepted Study")?;
    let task_output_artifacts = artifact_catalog
        .entries
        .iter()
        .filter(|entry| {
            entry.task_id == task_id
                && entry.attempt_id == attempt_id
                && entry.ownership_epoch == ownership_epoch
                && entry
                    .study_output
                    .as_ref()
                    .is_some_and(|output| output.step_id == output_manifest.step_id)
        })
        .collect::<Vec<_>>();
    if task_output_artifacts.len() != output_manifest.outputs.len() {
        bail!("Study output manifest and task-owned catalog have different output coverage");
    }

    let provenance = ArtifactTransferProvenanceV1 {
        project_id: specification.snapshot.project_id.as_str().to_owned(),
        definition_revision: specification.snapshot.definition_revision,
        run_id: Some(run_id.as_str().to_owned()),
        task_id: Some(task_id.to_owned()),
        attempt_id: Some(attempt_id.to_owned()),
    };
    let mut artifacts = Vec::with_capacity(output_manifest.outputs.len());
    for output in &output_manifest.outputs {
        let declared = step
            .outputs
            .iter()
            .find(|declared| declared.port_id == output.port_id)
            .with_context(|| {
                format!(
                    "accepted Study step `{}` does not declare output `{}`",
                    output_manifest.step_id, output.port_id
                )
            })?;
        if study_port_data_kind_label(declared.data_kind) != output.data_kind {
            bail!("Study output data kind differs from its accepted port declaration");
        }
        validate_json_output_codec(output)?;

        let mut matching_catalog_entries = artifact_catalog
            .entries
            .iter()
            .filter(|entry| entry.artifact_id == output.artifact_id);
        let catalog_entry = matching_catalog_entries
            .next()
            .context("Study output is missing from the durable artifact catalog")?;
        if matching_catalog_entries.next().is_some() {
            bail!("Study output artifact identity is ambiguous in the catalog");
        }
        let catalog_output = catalog_entry
            .study_output
            .as_ref()
            .context("Study output catalog entry has no typed output lineage")?;
        if !task.artifact_ids.contains(&output.artifact_id)
            || catalog_entry.task_id != task_id
            || catalog_entry.attempt_id != attempt_id
            || catalog_entry.ownership_epoch != ownership_epoch
            || catalog_entry.status != FmsArtifactStatus::Published
            || !catalog_entry.required
            || catalog_entry.artifact_type != output.data_kind
            || catalog_entry.object_ref.as_deref() != Some(output.object_ref.as_str())
            || catalog_entry.content_sha256 != output.content_sha256
            || catalog_output.step_id != output_manifest.step_id
            || catalog_output.port_id != output.port_id
            || catalog_output.case_id != output.case_id
        {
            bail!("Study output differs from its exact published task-attempt catalog entry");
        }
        let byte_length = store
            .cas()
            .verified_length(&output.object_ref)?
            .context("published Study output is missing from CAS")?;
        if byte_length == 0 {
            bail!("published Study output is empty");
        }
        artifacts.push(ArtifactTransferEntryV1 {
            artifact_id: output.artifact_id.clone(),
            logical_name: catalog_entry.logical_path.clone(),
            role: output.data_kind.clone(),
            sha256: output.content_sha256.clone(),
            byte_length,
            media_type: "application/json".into(),
            codec_id: output.codec_id.clone(),
            codec_version: output.codec_version.clone(),
            provenance: provenance.clone(),
            read_only: false,
        });
    }

    ArtifactTransferManifestV1::new(
        specification.snapshot.project_id.as_str(),
        specification.snapshot.definition_revision,
        run_id.as_str(),
        task_id,
        attempt_id,
        ArtifactTransferDirectionV1::Output,
        artifacts,
    )
    .map_err(anyhow::Error::msg)
    .context("seal the exact accepted output transfer manifest")
}

fn read_bounded_cas_object(
    store: &SessionStore,
    object_ref: &str,
    max_bytes: u64,
) -> Result<Vec<u8>> {
    let byte_length = store
        .cas()
        .verified_length(object_ref)?
        .context("required typed document is missing from CAS")?;
    if byte_length == 0 || byte_length > max_bytes {
        bail!("typed CAS document is empty or exceeds its transfer decode limit");
    }
    let range = store
        .cas()
        .get_verified_range(object_ref, 0, byte_length, max_bytes)?
        .context("typed CAS document disappeared during verified read")?;
    if range.object_length != byte_length || range.bytes.len() as u64 != byte_length {
        bail!("typed CAS document length changed during verified read");
    }
    Ok(range.bytes)
}

fn study_port_data_kind_label(kind: StudyPortDataKind) -> &'static str {
    match kind {
        StudyPortDataKind::InitialState => "initial_state",
        StudyPortDataKind::State => "state",
        StudyPortDataKind::Field => "field",
        StudyPortDataKind::Scalar => "scalar",
        StudyPortDataKind::Table => "table",
        StudyPortDataKind::Mesh => "mesh",
        StudyPortDataKind::Operator => "operator",
        StudyPortDataKind::Artifact => "artifact",
        StudyPortDataKind::RunRecord => "run_record",
    }
}

fn validate_json_output_codec(output: &fullmag_session::FmsStudyOutputManifestEntry) -> Result<()> {
    let supported = matches!(
        (
            output.data_kind.as_str(),
            output.codec_id.as_str(),
            output.codec_version.as_str(),
        ),
        (
            "initial_state" | "state",
            STUDY_MAGNETIZATION_CODEC_ID,
            STUDY_MAGNETIZATION_CODEC_VERSION,
        ) | ("scalar", STUDY_SCALAR_CODEC_ID, STUDY_SCALAR_CODEC_VERSION)
    );
    if !supported {
        bail!(
            "unsupported output transfer codec `{}` version `{}` for `{}` port `{}`",
            output.codec_id,
            output.codec_version,
            output.data_kind,
            output.port_id
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_session::FmsStudyOutputManifestEntry;

    fn output(
        data_kind: &str,
        port_id: &str,
        codec_id: &str,
        codec_version: &str,
    ) -> FmsStudyOutputManifestEntry {
        FmsStudyOutputManifestEntry {
            port_id: port_id.into(),
            case_id: "case-1".into(),
            data_kind: data_kind.into(),
            codec_id: codec_id.into(),
            codec_version: codec_version.into(),
            artifact_id: "artifact-1".into(),
            object_ref: "ab".repeat(32),
            content_sha256: "ab".repeat(32),
        }
    }

    #[test]
    fn accepts_known_magnetization_and_scalar_json_codecs() {
        assert!(validate_json_output_codec(&output(
            "state",
            "state",
            STUDY_MAGNETIZATION_CODEC_ID,
            STUDY_MAGNETIZATION_CODEC_VERSION
        ))
        .is_ok());
        assert!(validate_json_output_codec(&output(
            "scalar",
            "total_energy",
            STUDY_SCALAR_CODEC_ID,
            STUDY_SCALAR_CODEC_VERSION
        ))
        .is_ok());
    }

    #[test]
    fn rejects_mismatched_or_unsupported_codec_contracts() {
        assert!(validate_json_output_codec(&output(
            "state",
            "state",
            STUDY_SCALAR_CODEC_ID,
            STUDY_SCALAR_CODEC_VERSION
        ))
        .is_err());
        assert!(validate_json_output_codec(&output(
            "artifact",
            "unrecognized",
            "fullmag.unknown",
            "v1"
        ))
        .is_err());
    }
}
