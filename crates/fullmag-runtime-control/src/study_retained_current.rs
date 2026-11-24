//! Retained-current source admission through the canonical durable inspection fence.
//! No claim, lease, source solve, write transaction or CAS mutation occurs here.
use anyhow::{bail, Context, Result};
use fullmag_antenna_artifacts::retained_current::{
    CasObjectRef, ParentCurrentDigests, ParentInspectionOwner, RetainedCurrentParent,
    ParentEvidenceCapsule, ParentEvidenceRecordObject, PARENT_EVIDENCE_SCHEMA, MAX_RECORD_BYTES_TOTAL,
    MAX_METADATA_BYTES, PARENT_CODEC_ID, PARENT_CODEC_VERSION, PARENT_MANIFEST_SCHEMA,
    validate_parent_evidence_bytes,
};
use fullmag_application::{ProjectId, RunId};
use fullmag_ir::AntennaRetainedCurrentSourceIR;
use fullmag_runner::{VerifiedRetainedCurrentParentContent, VerifiedRetainedCurrentSourceContent};
use fullmag_session::SessionStore;
use fullmag_session::accepted_provenance::{
    plan_accepted_provenance_with_record_budget, plan_accepted_store_provenance_with_record_budget,
    AcceptedProvenanceContext, AcceptedStoreProvenanceContext, AcceptedEvidenceManifest,
    AcceptedProvenanceRecordKind, AcceptedProvenanceSourceRecord,
};
use std::collections::BTreeMap;
use sha2::{Digest, Sha256};

/// The private content and owner can only be returned after the complete durable read.
/// This is a read snapshot, not a substitute for preparation/publication revalidation.
pub struct LoadedSavedRetainedCurrent {
    owner: ParentInspectionOwner,
    content: VerifiedRetainedCurrentSourceContent,
}

impl LoadedSavedRetainedCurrent {
    pub fn owner(&self) -> &ParentInspectionOwner { &self.owner }
    pub fn source_digests(&self) -> ParentCurrentDigests { self.content.source_digests() }
    pub fn authored_input_json(&self) -> &[u8] { self.content.authored_input_json() }
    pub fn validate_source_intent(&self, problem: &fullmag_ir::ProblemIR, stage: &fullmag_ir::AntennaFieldSolveStageIR)
        -> Result<()> {
        self.content.validate_source_intent(problem, stage).map_err(|error| anyhow::anyhow!(error.to_string()))
    }

    /// Bind the exact detached evidence without repeating the physical source verifier.
    /// Portable closure validation and live publication revalidation remain mandatory.
    pub fn bind_evidence(self, capsule_bytes: &[u8]) -> Result<VerifiedRetainedCurrentParentContent> {
        if capsule_bytes.is_empty() || capsule_bytes.len() as u64 > MAX_METADATA_BYTES {
            bail!("retained current parent evidence exceeds its metadata bound");
        }
        let parent = RetainedCurrentParent { owner: self.owner, source: self.content.source_digests(),
            evidence_capsule: CasObjectRef { object_ref: format!("{:x}", Sha256::digest(capsule_bytes)),
                byte_count: capsule_bytes.len() as u64 } };
        self.content.bind_parent(&parent, capsule_bytes).map_err(|error| anyhow::anyhow!(error.to_string()))
    }
}

/// Require the exact public locator in the same native read transaction as
/// Succeeded/Completed, accepted inputs, preparation, output catalog and full v2 verification.
pub fn load_saved_retained_current(
    store: &SessionStore, project: &ProjectId, source: &AntennaRetainedCurrentSourceIR,
) -> Result<LoadedSavedRetainedCurrent> {
    validate_locator_project(project, source)?;
    let transaction = super::study_inspection_integrity::acquire_inspection_read_transaction(
        store, std::time::Duration::from_secs(5))?;
    read_saved_retained_current(store, &transaction, project, source, |loaded, _| Ok(loaded))
}

pub(crate) fn read_saved_retained_current<'a, T>(
    store: &SessionStore, transaction: impl Into<super::study_inspection_integrity::SavedInspectionFence<'a>>, project: &ProjectId,
    source: &AntennaRetainedCurrentSourceIR,
    finish: impl FnOnce(LoadedSavedRetainedCurrent, super::study_inspection_integrity::SavedInspectionReadContext<'_>) -> Result<T>,
) -> Result<T> {
    let AntennaRetainedCurrentSourceIR::PublishedInspection { project_id, run_id, task_id, attempt_id,
        ownership_epoch, artifact_id, object_ref } = source;
    let run = RunId::parse(run_id.clone())?;
    let epoch: u64 = ownership_epoch.parse().context("retained source epoch is not u64")?;
    super::study_inspection_integrity::read_saved_inspection(
        store, transaction, project, &run, task_id, attempt_id, epoch, object_ref, Some(artifact_id),
        super::study_inspection::load_accepted_retained_current_source_bytes,
        |_, content, context| {
            let fullmag_authoring::StudyStepKind::ClosedLoopInspection { stage_id, .. } = &context.step.kind
                else { bail!("retained parent lost its original closed-loop operation"); };
            let owner = ParentInspectionOwner { project_id: project_id.clone(), run_id: run_id.clone(),
                study_step_id: context.step.step_id.clone(), native_stage_id: stage_id.clone(),
                task_id: task_id.clone(), attempt_id: attempt_id.clone(), ownership_epoch: ownership_epoch.clone(),
                artifact_id: artifact_id.clone(), package: CasObjectRef { object_ref: object_ref.clone(),
                    byte_count: context.package_byte_count as u64 },
                package_codec_id: PARENT_CODEC_ID.into(), package_codec_version: PARENT_CODEC_VERSION.into(),
                manifest_schema: PARENT_MANIFEST_SCHEMA.into(),
                output_manifest_artifact_id: context.output_manifest.artifact_id.clone(),
                output_manifest: CasObjectRef { object_ref: context.output_manifest.object_ref.clone()
                    .context("verified completion manifest has no CAS")?,
                    byte_count: context.output_manifest_byte_count as u64 } };
            owner.validate_metadata().map_err(|error| anyhow::anyhow!(error.message))?;
            finish(LoadedSavedRetainedCurrent { owner, content }, context)
        })
}

/// Durable source plus owned evidence metadata from one shared snapshot.
/// Large parent CAS payloads remain in the existing store, never in this map.
pub struct LoadedSavedRetainedCurrentEvidence {
    parent: RetainedCurrentParent,
    content: VerifiedRetainedCurrentParentContent,
    provenance: AcceptedEvidenceManifest,
    metadata_objects: BTreeMap<String, Vec<u8>>,
}

impl LoadedSavedRetainedCurrentEvidence {
    pub fn parent(&self) -> &RetainedCurrentParent { &self.parent }
    pub fn verified_parent(&self) -> &VerifiedRetainedCurrentParentContent { &self.content }
    pub fn provenance(&self) -> &AcceptedEvidenceManifest { &self.provenance }
    pub fn metadata_objects(&self) -> &BTreeMap<String, Vec<u8>> { &self.metadata_objects }
    pub fn capsule_bytes(&self) -> &[u8] {
        &self.metadata_objects[&self.parent.evidence_capsule.object_ref]
    }
}

/// Capture portable evidence before releasing the same lock that authenticated J.
/// Callers must persist metadata only after return and revalidate at worker/publication.
pub fn load_saved_retained_current_with_evidence(
    store: &SessionStore, project: &ProjectId, source: &AntennaRetainedCurrentSourceIR,
    context: &AcceptedProvenanceContext,
) -> Result<LoadedSavedRetainedCurrentEvidence> {
    validate_locator_project(project, source)?;
    validate_evidence_context(store, source, context)?;
    let transaction = super::study_inspection_integrity::acquire_inspection_read_transaction(
        store, std::time::Duration::from_secs(5))?;
    let captured = read_saved_retained_current(store, &transaction, project, source,
        |loaded, read| capture_parent_evidence(store, loaded, ParentCaptureContext::Live(context), &read))?;
    drop(transaction);
    Ok(captured)
}

/// Capture accepted-store provenance without requiring or inventing a live UI identity.
/// The store owner derives both identities; callers cannot supply a substitute context.
pub fn load_saved_retained_current_with_store_evidence(
    store: &SessionStore, project: &ProjectId, source: &AntennaRetainedCurrentSourceIR,
) -> Result<LoadedSavedRetainedCurrentEvidence> {
    validate_locator_project(project, source)?;
    let AntennaRetainedCurrentSourceIR::PublishedInspection { run_id, .. } = source;
    let binding = crate::accepted_store::store_binding(store.root())
        .context("retained parent store has no stable binding")?;
    let context = AcceptedStoreProvenanceContext {
        source_store_binding: format!("sha256:{binding}"), accepted_run_id: run_id.clone(),
    };
    context.validate()?;
    let transaction = super::study_inspection_integrity::acquire_inspection_read_transaction(
        store, std::time::Duration::from_secs(5))?;
    let captured = read_saved_retained_current(store, &transaction, project, source,
        |loaded, read| capture_parent_evidence(store, loaded, ParentCaptureContext::Store(&context), &read))?;
    drop(transaction);
    Ok(captured)
}

/// Reauthenticate the live parent while keeping the exact historical preparation capsule.
/// Unrelated task/catalog changes do not require recapturing the whole parent run.
pub fn load_saved_retained_current_with_pinned_evidence(
    store: &SessionStore, project: &ProjectId, source: &AntennaRetainedCurrentSourceIR,
    expected_parent: &RetainedCurrentParent,
) -> Result<LoadedSavedRetainedCurrentEvidence> {
    validate_pinned_parent_locator(project, source, expected_parent)?;
    let transaction = super::study_inspection_integrity::acquire_inspection_read_transaction(
        store, std::time::Duration::from_secs(5))?;
    let captured = read_pinned_retained_current(store, &transaction, project, source, expected_parent)?;
    drop(transaction);
    Ok(captured)
}

/// Publication-only: keep the same reentrant exclusive store fence until return.
/// Callers retain their outer writer through the immutable catalog commit.
pub(crate) fn load_pinned_retained_current_for_publication(
    store: &SessionStore, project: &ProjectId, source: &AntennaRetainedCurrentSourceIR,
    expected_parent: &RetainedCurrentParent,
) -> Result<LoadedSavedRetainedCurrentEvidence> {
    validate_pinned_parent_locator(project, source, expected_parent)?;
    let transaction = store.write_transaction()?;
    let captured = read_pinned_retained_current(store, &transaction, project, source, expected_parent)?;
    drop(transaction);
    Ok(captured)
}

pub(crate) fn validate_pinned_parent_locator(
    project: &ProjectId, source: &AntennaRetainedCurrentSourceIR, parent: &RetainedCurrentParent,
) -> Result<()> {
    validate_locator_project(project, source)?;
    parent.validate_metadata().map_err(|error| anyhow::anyhow!(error.message))?;
    if !parent.owner.matches_source(source) { bail!("pinned retained parent differs from the authored locator"); }
    Ok(())
}

fn read_pinned_retained_current<'a>(
    store: &SessionStore, transaction: impl Into<super::study_inspection_integrity::SavedInspectionFence<'a>>,
    project: &ProjectId, source: &AntennaRetainedCurrentSourceIR, expected_parent: &RetainedCurrentParent,
) -> Result<LoadedSavedRetainedCurrentEvidence> {
    read_pinned_retained_current_with(store, transaction, project, source, expected_parent,
        |evidence, _| Ok(evidence))
}

pub(crate) fn read_pinned_retained_current_with<'a, T>(
    store: &SessionStore, transaction: impl Into<super::study_inspection_integrity::SavedInspectionFence<'a>>,
    project: &ProjectId, source: &AntennaRetainedCurrentSourceIR, expected_parent: &RetainedCurrentParent,
    finish: impl FnOnce(LoadedSavedRetainedCurrentEvidence,
        super::study_inspection_integrity::SavedInspectionReadContext<'_>) -> Result<T>,
) -> Result<T> {
    read_saved_retained_current(store, transaction, project, source, |loaded, read| {
        if loaded.owner() != &expected_parent.owner || loaded.source_digests() != expected_parent.source {
            bail!("pinned retained parent differs from the current authenticated source");
        }
        let (provenance, metadata_objects) = read_pinned_parent_evidence(store, expected_parent, &read)?;
        let capsule_bytes = metadata_objects.get(&expected_parent.evidence_capsule.object_ref)
            .context("validated pinned parent capsule is missing")?;
        let content = loaded.content.bind_parent(expected_parent, capsule_bytes)
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        finish(LoadedSavedRetainedCurrentEvidence {
            parent: expected_parent.clone(), content, provenance, metadata_objects,
        }, read)
    })
}

fn read_pinned_parent_evidence(
    store: &SessionStore, parent: &RetainedCurrentParent,
    read: &super::study_inspection_integrity::SavedInspectionReadContext<'_>,
) -> Result<(AcceptedEvidenceManifest, BTreeMap<String, Vec<u8>>)> {
    let capsule_bytes = read_parent_metadata_object(store, &parent.evidence_capsule)?;
    let capsule = validate_parent_evidence_bytes(parent, &capsule_bytes)
        .map_err(|error| anyhow::anyhow!(error.message))?;
    let manifest_bytes = read_parent_metadata_object(store, &capsule.accepted_provenance_manifest)?;
    let manifest = AcceptedEvidenceManifest::from_bytes(&manifest_bytes)
        .context("pinned retained parent manifest is not typed")?;
    manifest.validate()?;
    let binding = crate::accepted_store::store_binding(store.root())
        .context("pinned retained parent store has no stable binding")?;
    if manifest.accepted_run_id() != parent.owner.run_id
        || manifest.source_store_binding() != format!("sha256:{binding}") {
        bail!("pinned retained parent evidence belongs to another run or live store");
    }
    validate_pinned_record_set(&capsule, &manifest)?;
    let mut records = BTreeMap::new();
    // validate_parent_evidence_bytes bounded the complete record sum before any record allocation.
    for record in &capsule.record_objects {
        let bytes = read_parent_metadata_object(store, &record.object)?;
        records.insert(record.archive_path.clone(), bytes);
    }
    manifest.validate_detached_records_with_exact_cas_and_ranges(&records, |object| {
        store.cas().get_bounded(object, fullmag_session::MAX_TERMINAL_CATALOG_METADATA_BYTES)
    }, |object, offset, length| store.cas().get_verified_range(object, offset, length, MAX_METADATA_BYTES))?;
    // The typed validator proves roles. Streaming byte validation proves every declared dependency.
    for object in manifest.cas_objects() {
        let bytes = store.cas().verified_length(&object.object_ref)?
            .context("pinned retained parent CAS dependency is missing")?;
        if bytes != object.byte_count {
            bail!("pinned retained parent CAS dependency byte count differs");
        }
    }
    validate_parent_closure_owner(store, &parent.owner, &manifest, &records, read)?;
    let mut metadata_objects = BTreeMap::new();
    for record in &capsule.record_objects {
        let bytes = records.remove(&record.archive_path).context("validated parent record disappeared")?;
        metadata_objects.insert(record.object.object_ref.clone(), bytes);
    }
    metadata_objects.insert(capsule.accepted_provenance_manifest.object_ref, manifest_bytes);
    metadata_objects.insert(parent.evidence_capsule.object_ref.clone(), capsule_bytes);
    Ok((manifest, metadata_objects))
}

fn validate_pinned_record_set(
    capsule: &ParentEvidenceCapsule, manifest: &AcceptedEvidenceManifest,
) -> Result<()> {
    let expected = manifest.records().iter().map(|record| (record.archive_path.as_str(),
        (&record.content_sha256, record.byte_count))).collect::<BTreeMap<_, _>>();
    if expected.len() != capsule.record_objects.len()
        || capsule.record_objects.iter().any(|record| {
            expected.get(record.archive_path.as_str())
                != Some(&(&record.object.object_ref, record.object.byte_count))
        }) {
        bail!("pinned retained parent record set differs from its typed provenance manifest");
    }
    Ok(())
}

fn read_parent_metadata_object(store: &SessionStore, object: &CasObjectRef) -> Result<Vec<u8>> {
    object.validate(MAX_METADATA_BYTES).map_err(|error| anyhow::anyhow!(error.message))?;
    let bytes = store.cas().get_bounded(&object.object_ref, object.byte_count)?
        .context("pinned retained parent metadata CAS is missing")?;
    if bytes.len() as u64 != object.byte_count
        || format!("{:x}", Sha256::digest(&bytes)) != object.object_ref {
        bail!("pinned retained parent metadata CAS length/hash differs");
    }
    Ok(bytes)
}

fn validate_evidence_context(
    store: &SessionStore, source: &AntennaRetainedCurrentSourceIR, context: &AcceptedProvenanceContext,
) -> Result<()> {
    context.validate()?;
    let AntennaRetainedCurrentSourceIR::PublishedInspection { run_id, .. } = source;
    let binding = crate::accepted_store::store_binding(store.root()).context("retained parent store has no stable binding")?;
    if context.accepted_run_id != *run_id || context.source_store_binding != format!("sha256:{binding}") {
        bail!("retained parent provenance context belongs to another run or store");
    }
    Ok(())
}

pub(crate) enum ParentCaptureContext<'a> {
    Live(&'a AcceptedProvenanceContext),
    Store(&'a AcceptedStoreProvenanceContext),
}

fn read_parent_plan_records(
    planned: &[AcceptedProvenanceSourceRecord],
    mut read: impl FnMut(&AcceptedProvenanceSourceRecord) -> Result<Vec<u8>>,
) -> Result<BTreeMap<String, Vec<u8>>> {
    let mut records = BTreeMap::new();
    let mut total = 0u64;
    for record in planned {
        total = total.checked_add(record.byte_count).context("retained parent record budget overflow")?;
        if total > MAX_RECORD_BYTES_TOTAL { bail!("retained parent records exceed their aggregate byte budget"); }
        records.insert(record.archive_path.clone(), read(record)?);
    }
    Ok(records)
}

pub(crate) fn capture_parent_evidence(
    store: &SessionStore, loaded: LoadedSavedRetainedCurrent, context: ParentCaptureContext<'_>,
    read: &super::study_inspection_integrity::SavedInspectionReadContext<'_>,
) -> Result<LoadedSavedRetainedCurrentEvidence> {
    let (manifest, records) = match context {
        ParentCaptureContext::Live(context) => {
            let plan = plan_accepted_provenance_with_record_budget(store.root(), context, MAX_RECORD_BYTES_TOTAL)?;
            let records = read_parent_plan_records(&plan.records, |record| plan.read_record(record))?;
            (AcceptedEvidenceManifest::Live(plan.manifest), records)
        }
        ParentCaptureContext::Store(context) => {
            let plan = plan_accepted_store_provenance_with_record_budget(store.root(), context, MAX_RECORD_BYTES_TOTAL)?;
            let records = read_parent_plan_records(&plan.records, |record| plan.read_record(record))?;
            (AcceptedEvidenceManifest::Store(plan.manifest), records)
        }
    };
    manifest.validate_detached_records_with_exact_cas_and_ranges(&records, |object| {
        let bytes = store.cas().get_bounded(object, fullmag_session::MAX_TERMINAL_CATALOG_METADATA_BYTES)?
            .context("retained parent required typed metadata CAS is missing")?;
        Ok(Some(bytes))
    }, |object, offset, length| store.cas().get_verified_range(object, offset, length, MAX_METADATA_BYTES))?;
    validate_parent_closure_owner(store, &loaded.owner, &manifest, &records, read)?;
    let manifest_bytes = bounded_metadata_bytes(&manifest)?;
    let provenance_ref = metadata_ref(&manifest_bytes);
    let capsule = ParentEvidenceCapsule {
        schema_version: PARENT_EVIDENCE_SCHEMA.into(), role: "evidence_only".into(),
        parent_owner: loaded.owner.clone(), accepted_provenance_manifest: provenance_ref.clone(),
        record_objects: manifest.records().iter().map(|record| ParentEvidenceRecordObject {
            archive_path: record.archive_path.clone(), object: CasObjectRef {
                object_ref: record.content_sha256.clone(), byte_count: record.byte_count,
            },
        }).collect(),
    };
    capsule.validate_parent(&loaded.owner).map_err(|error| anyhow::anyhow!(error.message))?;
    let capsule_bytes = bounded_metadata_bytes(&capsule)?;
    let parent = RetainedCurrentParent { owner: loaded.owner.clone(), source: loaded.source_digests(),
        evidence_capsule: metadata_ref(&capsule_bytes) };
    let content = loaded.content.bind_parent(&parent, &capsule_bytes)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let mut metadata_objects = BTreeMap::new();
    for (path, bytes) in records {
        let record = manifest.records().iter().find(|record| record.archive_path == path)
            .context("validated parent record disappeared")?;
        metadata_objects.insert(record.content_sha256.clone(), bytes);
    }
    metadata_objects.insert(provenance_ref.object_ref, manifest_bytes);
    metadata_objects.insert(parent.evidence_capsule.object_ref.clone(), capsule_bytes);
    Ok(LoadedSavedRetainedCurrentEvidence { parent, content, provenance: manifest, metadata_objects })
}

fn validate_parent_closure_owner(
    store: &SessionStore, owner: &ParentInspectionOwner, manifest: &AcceptedEvidenceManifest,
    records: &BTreeMap<String, Vec<u8>>, read: &super::study_inspection_integrity::SavedInspectionReadContext<'_>,
) -> Result<()> {
    if manifest.accepted_run_id() != owner.run_id
        || read.accepted.run.specification.snapshot.project_id.as_str() != owner.project_id
        || read.step.step_id != owner.study_step_id
        || fullmag_session::task_id_for_study_step(&owner.run_id, &owner.study_step_id)? != owner.task_id {
        bail!("retained parent closure differs from the authenticated project/run/step/task");
    }
    let mut catalog = None;
    let mut artifacts = None;
    let mut preparation = None;
    for record in manifest.records() {
        let bytes = records.get(&record.archive_path).context("retained parent detached record missing")?;
        match record.kind {
            AcceptedProvenanceRecordKind::RunIntent => {
                let intent: fullmag_session::FmsRunIntent = serde_json::from_slice(bytes)?;
                if intent != read.accepted.run.intent { bail!("retained parent detached accepted intent changed"); }
            },
            AcceptedProvenanceRecordKind::RunCatalog => catalog = Some(serde_json::from_slice::<fullmag_session::FmsRunCatalog>(bytes)?),
            AcceptedProvenanceRecordKind::ArtifactCatalog => artifacts = Some(serde_json::from_slice::<fullmag_session::FmsArtifactCatalog>(bytes)?),
            AcceptedProvenanceRecordKind::TaskPreparationReceipt => {
                let receipt: fullmag_session::FmsTaskPreparationReceipt = serde_json::from_slice(bytes)?;
                if receipt.task_id == owner.task_id { preparation = Some(receipt); }
            },
            _ => {},
        }
    }
    let catalog = catalog.context("retained parent detached run catalog missing")?;
    let task = catalog.tasks.iter().find(|task| task.task_id == owner.task_id)
        .context("retained parent detached task missing")?;
    if task != read.task || task.lifecycle != fullmag_session::FmsTaskLifecycle::Succeeded
        || task.attempt_id.as_deref() != Some(owner.attempt_id.as_str())
        || task.ownership_epoch.map(|epoch| epoch.to_string()).as_deref() != Some(owner.ownership_epoch.as_str())
        || !task.artifact_ids.contains(&owner.artifact_id) || !task.artifact_ids.contains(&owner.output_manifest_artifact_id) {
        bail!("retained parent detached task/attempt/artifact ownership differs");
    }
    let preparation = preparation.context("retained parent detached preparation missing")?;
    let bound_preparation = read.accepted.bind_closed_inspection_preparation(&preparation, &owner.task_id)?;
    let fullmag_application::AcceptedPreparationReceipt::ClosedLoop(current_preparation) = read.preparation
        else { bail!("retained parent current preparation is not a full source inspection"); };
    if &bound_preparation != current_preparation {
        bail!("retained parent detached preparation differs from the current authenticated receipt");
    }
    let artifacts = artifacts.context("retained parent detached artifact catalog missing")?;
    let selected = artifacts.entries.iter().filter(|entry| entry.task_id == owner.task_id
        && entry.attempt_id == owner.attempt_id && entry.ownership_epoch.to_string() == owner.ownership_epoch).collect::<Vec<_>>();
    let packages = selected.iter().filter(|entry| entry.artifact_type == "artifact" && entry.study_output.is_some()).collect::<Vec<_>>();
    let outputs = selected.iter().filter(|entry| entry.artifact_type == "study_output_manifest").collect::<Vec<_>>();
    if packages.len() != 1 || outputs.len() != 1 || *packages[0] != read.artifact || *outputs[0] != read.output_manifest
        || packages[0].artifact_id != owner.artifact_id || outputs[0].artifact_id != owner.output_manifest_artifact_id
        || packages[0].status != fullmag_session::FmsArtifactStatus::Published || outputs[0].status != fullmag_session::FmsArtifactStatus::Published
        || packages[0].object_ref.as_deref() != Some(owner.package.object_ref.as_str()) || packages[0].content_sha256 != owner.package.object_ref
        || outputs[0].object_ref.as_deref() != Some(owner.output_manifest.object_ref.as_str()) || outputs[0].content_sha256 != owner.output_manifest.object_ref {
        bail!("retained parent detached publication differs from its authenticated output");
    }
    for expected in [&owner.package, &owner.output_manifest] {
        if !manifest.cas_objects().iter().any(|object| object.object_ref == expected.object_ref && object.byte_count == expected.byte_count) {
            bail!("retained parent package/output CAS pin is absent from the typed closure");
        }
    }
    let bytes = store.cas().get_bounded(&owner.output_manifest.object_ref, MAX_METADATA_BYTES)?
        .context("retained parent typed output manifest missing")?;
    if bytes.len() as u64 != owner.output_manifest.byte_count { bail!("retained parent typed manifest length differs"); }
    let output: fullmag_session::FmsStudyOutputManifest = serde_json::from_slice(&bytes)?;
    output.validate()?;
    let [port] = read.step.outputs.as_slice() else { bail!("retained parent accepted output port is not unique"); };
    let [item] = output.outputs.as_slice() else { bail!("retained parent typed output is not unique"); };
    if output.run_id != owner.run_id || output.task_id != owner.task_id || output.step_id != owner.study_step_id
        || output.attempt_id != owner.attempt_id || output.ownership_epoch.to_string() != owner.ownership_epoch
        || output.accepted_state_ref.is_some() || output.observation_source.is_some()
        || port.data_kind != fullmag_authoring::StudyPortDataKind::Artifact
        || item.port_id != port.port_id || item.case_id != "default" || item.data_kind != "artifact"
        || item.artifact_id != owner.artifact_id || item.object_ref != owner.package.object_ref || item.content_sha256 != owner.package.object_ref
        || item.codec_id != PARENT_CODEC_ID || item.codec_version != PARENT_CODEC_VERSION {
        bail!("retained parent typed output/codec differs from its accepted inspection");
    }
    Ok(())
}

fn metadata_ref(bytes: &[u8]) -> CasObjectRef {
    CasObjectRef { object_ref: format!("{:x}", Sha256::digest(bytes)), byte_count: bytes.len() as u64 }
}

fn bounded_metadata_bytes(value: &impl serde::Serialize) -> Result<Vec<u8>> {
    struct Metadata(Vec<u8>);
    impl std::io::Write for Metadata {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if (self.0.len() as u64).checked_add(bytes.len() as u64).is_none_or(|size| size > MAX_METADATA_BYTES) {
                return Err(std::io::Error::other("retained parent metadata byte budget"));
            }
            self.0.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
    }
    let mut output = Metadata(Vec::new());
    serde_json::to_writer(&mut output, value)?;
    Ok(output.0)
}

pub(crate) fn validate_locator_project(project: &ProjectId, source: &AntennaRetainedCurrentSourceIR) -> Result<()> {
    let errors = source.validation_errors("retained_current_source");
    if !errors.is_empty() { bail!("invalid retained current locator: {}", errors.join("; ")); }
    let AntennaRetainedCurrentSourceIR::PublishedInspection { project_id, .. } = source;
    if project_id != project.as_str() { bail!("retained current source belongs to another project"); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_session::accepted_provenance::AcceptedProvenanceManifest;
    fn locator(project_id: &str, epoch: &str) -> AntennaRetainedCurrentSourceIR {
        AntennaRetainedCurrentSourceIR::PublishedInspection { project_id: project_id.into(),
            run_id: "run-parent".into(), task_id: "task-parent".into(), attempt_id: "attempt-parent".into(),
            ownership_epoch: epoch.into(), artifact_id: "artifact-parent".into(), object_ref: "a".repeat(64) }
    }
    #[test]
    fn foreign_locator_is_rejected_before_acquiring_a_corrupt_store_fence() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        std::fs::write(store.root().join("WRITER.lock"), b"invalid").unwrap();
        let error = load_saved_retained_current(&store, &ProjectId::parse("project-child").unwrap(),
            &locator("project-other", "1")).err().unwrap();
        assert!(error.to_string().contains("belongs to another project"));
    }

    #[test]
    fn foreign_project_and_noncanonical_epoch_refuse_before_store_access() {
        let project = ProjectId::parse("project-child").unwrap();
        assert!(validate_locator_project(&project, &locator("project-child", "1")).is_ok());
        assert!(validate_locator_project(&project, &locator("project-other", "1")).is_err());
        for epoch in ["0", "01", "+1", "18446744073709551616"] {
            assert!(validate_locator_project(&project, &locator("project-child", epoch)).is_err());
        }
    }

    #[test]
    fn evidence_context_refuses_foreign_run_or_store_before_corrupt_read_fence() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        std::fs::write(store.root().join("WRITER.lock"), b"invalid").unwrap();
        let binding = crate::accepted_store::store_binding(store.root()).unwrap();
        let valid = AcceptedProvenanceContext {
            source_store_binding: format!("sha256:{binding}"), accepted_run_id: "run-parent".into(),
            captured_live_session_id: "session-evidence".into(), captured_live_session_epoch: 1,
            captured_scene_revision: "1".into(),
        };
        for mismatch in ["run", "store"] {
            let mut context = valid.clone();
            if mismatch == "run" { context.accepted_run_id = "run-other".into(); }
            else { context.source_store_binding = format!("sha256:{}", "0".repeat(64)); }
            let error = load_saved_retained_current_with_evidence(&store,
                &ProjectId::parse("project-child").unwrap(), &locator("project-child", "1"), &context)
                .err().unwrap();
            assert!(error.to_string().contains("another run or store"), "{error:#}");
        }
    }

    fn parent_shape() -> RetainedCurrentParent {
        serde_json::from_value(serde_json::json!({
            "owner":{"project_id":"project-child","run_id":"run-parent","study_step_id":"step-parent",
                "native_stage_id":"stage-parent","task_id":"task-parent","attempt_id":"attempt-parent",
                "ownership_epoch":"1","artifact_id":"artifact-parent",
                "package":{"object_ref":"a".repeat(64),"byte_count":4096},
                "package_codec_id":PARENT_CODEC_ID,"package_codec_version":PARENT_CODEC_VERSION,
                "manifest_schema":PARENT_MANIFEST_SCHEMA,"output_manifest_artifact_id":"output-parent",
                "output_manifest":{"object_ref":"b".repeat(64),"byte_count":256}},
            "source":{"prepared_execution_digest":format!("sha256:{}","1".repeat(64)),
                "accepted_charge_field_digest":format!("sha256:{}","2".repeat(64)),
                "accepted_source_state_digest":format!("sha256:{}","3".repeat(64)),
                "view_identity_digest":format!("sha256:{}","4".repeat(64)),
                "current_balance_certificate_digest":format!("sha256:{}","5".repeat(64))},
            "evidence_capsule":{"object_ref":"c".repeat(64),"byte_count":1024}
        })).unwrap()
    }

    #[test]
    fn pinned_parent_refuses_rebound_owner_before_acquiring_the_source_fence() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        std::fs::write(store.root().join("WRITER.lock"), b"invalid").unwrap();
        let mut parent = parent_shape();
        parent.owner.run_id = "run-other".into();
        let error = load_saved_retained_current_with_pinned_evidence(&store,
            &ProjectId::parse("project-child").unwrap(), &locator("project-child", "1"), &parent)
            .err().unwrap();
        assert!(error.to_string().contains("exact authored locator"));
    }

    #[test]
    fn pinned_metadata_requires_exact_cas_length_and_content() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        let bytes = br#"{"role":"evidence_only"}"#;
        let object = CasObjectRef { object_ref: store.cas().put(bytes).unwrap(), byte_count: bytes.len() as u64 };
        assert_eq!(read_parent_metadata_object(&store, &object).unwrap(), bytes);
        for count in [object.byte_count - 1, object.byte_count + 1, MAX_METADATA_BYTES + 1] {
            let mut invalid = object.clone();invalid.byte_count = count;
            assert!(read_parent_metadata_object(&store, &invalid).is_err());
        }
        let mut invalid = object;invalid.object_ref = "0".repeat(64);
        assert!(read_parent_metadata_object(&store, &invalid).is_err());
    }

    #[test]
    fn pinned_record_set_is_exact_but_independent_of_record_order() {
        use fullmag_session::accepted_provenance::AcceptedProvenanceRecord;
        let context = AcceptedProvenanceContext { source_store_binding: format!("sha256:{}", "f".repeat(64)),
            accepted_run_id: "run-parent".into(), captured_live_session_id: "session-parent".into(),
            captured_live_session_epoch: 1, captured_scene_revision: "1".into() };
        // Record-set binding fixture only; the full reader separately requires typed intent/catalog bytes.
        let records = [(AcceptedProvenanceRecordKind::RunIntent, "run_intent.json", '1'),
            (AcceptedProvenanceRecordKind::RunCatalog, "run_catalog.json", '2')].into_iter().map(|(kind, name, digit)| {
                AcceptedProvenanceRecord { kind, source_path: format!("runs/run-parent/{name}"),
                    archive_path: format!("accepted_provenance/runs/run-parent/{name}"),
                    content_sha256: digit.to_string().repeat(64), byte_count: 256 }
            }).collect::<Vec<_>>();
        let manifest = AcceptedProvenanceManifest::from_context(&context, records, Vec::new()).unwrap();
        let mut capsule = ParentEvidenceCapsule { schema_version: PARENT_EVIDENCE_SCHEMA.into(),
            role: "evidence_only".into(), parent_owner: parent_shape().owner,
            accepted_provenance_manifest: CasObjectRef {object_ref:"d".repeat(64),byte_count:1024},
            record_objects: manifest.records.iter().map(|record| ParentEvidenceRecordObject {
                archive_path:record.archive_path.clone(), object:CasObjectRef {
                    object_ref:record.content_sha256.clone(),byte_count:record.byte_count}}).collect() };
        let manifest = AcceptedEvidenceManifest::Live(manifest);
        capsule.validate_metadata().unwrap();
        validate_pinned_record_set(&capsule, &manifest).unwrap();
        capsule.record_objects.reverse();
        validate_pinned_record_set(&capsule, &manifest).unwrap();
        for field in ["missing", "extra", "path", "hash", "bytes"] {
            let mut invalid = capsule.clone();
            match field {
                "missing" => {invalid.record_objects.pop();},
                "extra" => {let mut record=invalid.record_objects[0].clone();
                    record.archive_path="accepted_provenance/runs/run-parent/unrelated.json".into();
                    invalid.record_objects.push(record);},
                "path" => invalid.record_objects[0].archive_path="accepted_provenance/runs/run-other/run_catalog.json".into(),
                "hash" => invalid.record_objects[0].object.object_ref="9".repeat(64),
                "bytes" => invalid.record_objects[0].object.byte_count+=1,
                _ => unreachable!(),
            }
            assert!(validate_pinned_record_set(&invalid, &manifest).is_err(), "{field}");
        }
    }

    #[test]
    fn metadata_serializer_refuses_overflow_during_write() {
        let small = serde_json::json!({"role":"evidence_only"});
        let bytes = bounded_metadata_bytes(&small).unwrap();
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&bytes).unwrap(), small);
        let oversized = "x".repeat(MAX_METADATA_BYTES as usize);
        let error = bounded_metadata_bytes(&oversized).unwrap_err();
        assert!(error.to_string().contains("metadata byte budget"));
    }
}
