//! Imported H-only visualization. Detached evidence never becomes a live source grant.
use super::*;
use fullmag_antenna_artifacts::retained_current::{
    parse_retained_current_manifest_any, retained_current_field_manifest_length_any,
    RetainedCurrentFieldBundleAny, RetainedCurrentFieldManifestRef,
    RETAINED_CURRENT_FIELD_CODEC_ID, RETAINED_CURRENT_FIELD_CODEC_VERSION,
    MAX_METADATA_BYTES,
};
use fullmag_authoring::{StudyOutputPort, StudyPortDataKind, StudyStepKind};

// Separate from the API's view/cache budget: a private fail-closed allocation
// reserve for this new decoder. It is not an authorization or a process RSS claim.
const IMPORTED_RETAINED_TEMPORARY_ALLOCATION_CEILING_BYTES: u64 = 128 * 1024 * 1024;
const IMPORTED_RETAINED_READ_WORKSPACE_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Default)]
struct ImportedRetainedAllocationReserve { metadata_bytes: u64, package_bytes: u64 }
impl ImportedRetainedAllocationReserve {
    fn check(metadata: u64, packages: u64) -> Result<()> {
        // Reuse the existing inspection transport's 16x framing/decoding reserve.
        // Cumulative reads include both closures and model documents, even after
        // scratch buffers drop; the two whole package lengths are reserved together.
        let reserve = metadata.checked_add(packages).and_then(|n| n.checked_mul(16))
            .and_then(|n| n.checked_add(IMPORTED_RETAINED_READ_WORKSPACE_BYTES))
            .context("imported retained temporary allocation reserve overflow")?;
        if reserve > IMPORTED_RETAINED_TEMPORARY_ALLOCATION_CEILING_BYTES {
            bail!("imported retained temporary allocation reserve exceeds 128 MiB");
        }
        Ok(())
    }
    fn metadata(&mut self, bytes: u64) -> Result<()> {
        let total = self.metadata_bytes.checked_add(bytes).context("imported retained metadata reserve overflow")?;
        Self::check(total, self.package_bytes)?;
        self.metadata_bytes = total;
        Ok(())
    }
    fn packages(&mut self, child: u64, parent: u64) -> Result<()> {
        let total = child.checked_add(parent).context("imported retained package reserve overflow")?;
        Self::check(self.metadata_bytes, total)?;
        self.package_bytes = total;
        Ok(())
    }
}

fn read_import_metadata(store: &SessionStore, object: &str, reserve: &mut ImportedRetainedAllocationReserve) -> Result<Option<Vec<u8>>> {
    let length = store.cas().verified_length(object)?.context("imported retained metadata CAS absent")?;
    reserve.metadata(length)?;
    store.cas().get_bounded(object, MAX_METADATA_BYTES)
}

// The pinned genesis is historical decode-budget evidence only. Deserializing it
// neither admits a reader nor installs/replays its claim, lease or journal.
fn historical_package_budget(task: &fullmag_session::FmsTaskCatalogEntry, run: &RunId,
    attempt: &str, epoch: u64) -> Result<usize> {
    let genesis = task.coordinator_genesis.as_ref().context("imported retained historical budget absent")?;
    let checkpoint: CoordinatorCheckpoint = serde_json::from_value(genesis.checkpoint.clone())?;
    let claim = &checkpoint.claim;
    if checkpoint.schema_version != "coordinator_checkpoint.v1" || checkpoint.command_sequence != 0
        || checkpoint.event_sequence != 0 || claim.run_id != *run || claim.task_id.as_str() != task.task_id {
        bail!("imported retained historical budget belongs to another preparation");
    }
    exact_attempt(Some(claim.attempt_id.as_str()), Some(claim.ownership_epoch.value()), attempt, epoch)?;
    crate::study_inspection::inspection_bundle_budget(claim)
}

/// API discovery uses a streaming typed discriminator before loading either full
/// model. This selects allocation defense only; the delegated loader still proves
/// the complete detached closure. Legacy public import entry points are unchanged.
pub fn load_imported_study_evidence_for_inspection(
    store: &SessionStore, run: &RunId, expected_closure: &str,
) -> Result<Option<ImportedStudyEvidence>> {
    use fullmag_session::accepted_provenance::{AcceptedProvenanceManifest, AcceptedProvenanceRecordKind,
        MAX_ACCEPTED_PROVENANCE_RECORD_BYTES};
    use fullmag_session::repository_path::read_bounded_regular_file;
    let _transaction = acquire_inspection_read_transaction(store, std::time::Duration::from_secs(5))?;
    let retained = {
        let session = store.current_session()?.context("imported session manifest absent")?;
        let reference = session.accepted_provenance_ref.context("imported accepted evidence reference absent")?;
        let bytes = read_bounded_regular_file(store.root(), "imports/accepted_provenance/manifest.json",
            MAX_ACCEPTED_PROVENANCE_RECORD_BYTES)?;
        let manifest: AcceptedProvenanceManifest = serde_json::from_slice(&bytes)?;
        manifest.validate()?;
        if session.format != fullmag_session::FMS_SESSION_FORMAT_V2
            || reference.accepted_run_id != run.as_str() || reference.closure_sha256 != expected_closure
            || manifest.accepted_run_id != run.as_str() || manifest.closure_sha256 != expected_closure
            || session.session_id != manifest.captured_live_session_id {
            bail!("imported discovery closure differs from the observation");
        }
        let mut intents = manifest.records.iter().filter(|record| record.kind == AcceptedProvenanceRecordKind::RunIntent);
        let record = intents.next().context("imported discovery RunIntent absent")?;
        if intents.next().is_some() { bail!("imported discovery RunIntent is not unique"); }
        let bytes = read_bounded_regular_file(store.root(), &format!("imports/{}", record.archive_path),
            MAX_ACCEPTED_PROVENANCE_RECORD_BYTES)?;
        if bytes.len() as u64 != record.byte_count || fullmag_session::hex_sha256(&bytes) != record.content_sha256 {
            bail!("imported discovery RunIntent differs from its exact record");
        }
        let intent: fullmag_session::FmsRunIntent = serde_json::from_slice(&bytes)?;
        intent.validate()?;
        if intent.run_id != run.as_str() { bail!("imported discovery RunIntent belongs to another run"); }
        match intent.study_object_ref.as_deref() {
            Some(object) => imported_study_contains_retained_field(store, object)?,
            None => false,
        }
    }; // Drop discriminator scratch before the full typed reader.
    if retained {
        let mut reserve = ImportedRetainedAllocationReserve::default();
        load_imported_study_evidence_with_allocation_guard(store, run, expected_closure,
            Some(&mut |bytes| reserve.metadata(bytes)))
    } else {
        load_imported_study_evidence(store, run, expected_closure)
    }
}

#[derive(serde::Deserialize)]
struct StudyKindProbe { #[serde(default)] steps: StudyStepsProbe }
#[derive(serde::Deserialize)]
struct StudyStepProbe { kind: StudyOperationProbe }
#[derive(serde::Deserialize)]
struct StudyOperationProbe { kind: String }
#[derive(Default)]
struct StudyStepsProbe(bool);
impl<'de> serde::Deserialize<'de> for StudyStepsProbe {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct StepsVisitor;
        impl<'de> serde::de::Visitor<'de> for StepsVisitor {
            type Value = StudyStepsProbe;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str("Study steps") }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut steps: A) -> std::result::Result<Self::Value, A::Error> {
                let mut retained = false;
                while let Some(step) = steps.next_element::<StudyStepProbe>()? {
                    retained |= step.kind.kind == "retained_current_field_inspection";
                }
                Ok(StudyStepsProbe(retained))
            }
        }
        deserializer.deserialize_seq(StepsVisitor)
    }
}

fn imported_study_contains_retained_field(store: &SessionStore, object: &str) -> Result<bool> {
    use std::io::Read;
    use sha2::{Digest, Sha256};
    let path = fullmag_session::repository_path::checked_path(store.root(), &format!("objects/sha256/{object}"))?;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW); }
    #[cfg(windows)] { use std::os::windows::fs::OpenOptionsExt; options.custom_flags(0x0020_0000); }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    #[cfg(windows)]
    let reparse = { use std::os::windows::fs::MetadataExt; metadata.file_attributes() & 0x400 != 0 };
    #[cfg(not(windows))] let reparse = false;
    if !metadata.is_file() || reparse || metadata.len() > crate::MAX_ACCEPTED_MODEL_DOCUMENT_BYTES {
        bail!("imported discovery Study CAS is not a bounded regular file");
    }
    struct HashReader { file: std::fs::File, hash: Sha256, bytes: u64, maximum: u64 }
    impl Read for HashReader {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            let count = self.file.read(buffer)?;
            self.bytes = self.bytes.checked_add(count as u64)
                .filter(|n| *n <= self.maximum).ok_or_else(|| std::io::Error::new(
                    std::io::ErrorKind::InvalidData, "imported Study exceeds its document bound"))?;
            self.hash.update(&buffer[..count]);
            Ok(count)
        }
    }
    let reader = HashReader { file, hash: Sha256::new(), bytes: 0, maximum: crate::MAX_ACCEPTED_MODEL_DOCUMENT_BYTES };
    let mut buffered = std::io::BufReader::new(reader);
    let mut decoder = serde_json::Deserializer::from_reader(&mut buffered);
    let probe: StudyKindProbe = serde::Deserialize::deserialize(&mut decoder)?;
    decoder.end()?; // Consume the complete document, including its trailing bytes.
    let reader = buffered.into_inner();
    if reader.bytes != metadata.len() || format!("{:x}", reader.hash.finalize()) != object {
        bail!("imported discovery Study CAS digest or byte count differs");
    }
    Ok(probe.steps.0)
}

fn validate_child_contract(
    kind: &StudyStepKind, enabled: bool, ports: &[StudyOutputPort],
    output: &fullmag_session::FmsStudyOutputManifestEntry, expected_object: &str,
) -> Result<()> {
    if !enabled || !matches!(kind, StudyStepKind::RetainedCurrentFieldInspection { .. })
        || ports != [StudyOutputPort { port_id: "inspection".into(), data_kind: StudyPortDataKind::Artifact }]
        || output.port_id != "inspection" || output.case_id != "default" || output.data_kind != "artifact"
        || output.codec_id != RETAINED_CURRENT_FIELD_CODEC_ID
        || !matches!(output.codec_version.as_str(), "v1" | "v2")
        || output.object_ref != expected_object || output.content_sha256 != expected_object {
        bail!("imported retained field requires its exact enabled Artifact inspection/default codec and CAS");
    }
    Ok(())
}

/// Read-only imported child; current accepted-store journals, claims and leases are neither required nor installed.
pub fn load_imported_retained_current_field_inspection(
    store: &SessionStore, run: &RunId, expected_closure: &str, task_id: &str,
    attempt: &str, epoch: u64, expected_object: &str,
) -> Result<(serde_json::Value, RetainedCurrentFieldBundleAny)> {
    let _transaction = acquire_inspection_read_transaction(store, std::time::Duration::from_secs(5))?;
    let mut reserve = ImportedRetainedAllocationReserve::default();
    let evidence = load_imported_study_evidence_with_allocation_guard(
        store, run, expected_closure, Some(&mut |bytes| reserve.metadata(bytes)),
    )?
        .context("imported retained field has no accepted Study")?;
    let accepted = &evidence.accepted;
    let step = accepted.study.steps.iter().find(|step|
        fullmag_session::task_id_for_study_step(run.as_str(), &step.step_id).ok().as_deref() == Some(task_id))
        .context("imported retained field is not an accepted step")?;
    let StudyStepKind::RetainedCurrentFieldInspection { stage_id, port_mode_id, output_id } = &step.kind
        else { bail!("imported retained field cannot decode another operation kind"); };
    let task = evidence.catalog.tasks.iter().find(|task| task.task_id == task_id)
        .context("imported retained field task absent")?;
    if task.lifecycle != FmsTaskLifecycle::Succeeded { bail!("imported retained field is not succeeded"); }
    exact_attempt(task.attempt_id.as_deref(), task.ownership_epoch, attempt, epoch)?;
    let lowered = accepted.lowered.steps.iter().find(|entry| entry.step_id == step.step_id)
        .context("imported retained lowering absent")?;
    if task.input_fingerprint != fullmag_application::study_task_input_fingerprint(&accepted.run.specification, lowered)? {
        bail!("imported retained field fingerprint differs from accepted inputs");
    }
    let problem = accepted.catalog.entries().iter().find(|entry| entry.step_id() == step.step_id)
        .context("imported retained ProblemIR absent")?.problem();
    let direct = match lowered.execution_plan.as_ref().map(|plan| &plan.backend_plan) {
        Some(fullmag_ir::BackendPlanIR::AntennaRetainedDirectFieldInspection(plan)) => {
            let canonical = fullmag_plan::validate_retained_direct_field_operation(problem, stage_id, port_mode_id, output_id)?;
            if plan != &canonical { bail!("imported DTQ carrier differs from canonical lowering"); }
            Some(canonical)
        }
        Some(fullmag_ir::BackendPlanIR::AntennaRetainedPreparationFieldInspection(_)) => {
            bail!("portable surface preparation asset inspection remains unsupported: use its authenticated source-asset reader");
        }
        _ => None,
    };
    let legacy = if direct.is_none() {
        let operation = fullmag_plan::validate_retained_current_field_operation(problem, stage_id, port_mode_id, output_id)?;
        if !matches!(lowered.execution_plan.as_ref().map(|plan| &plan.backend_plan),
            Some(fullmag_ir::BackendPlanIR::AntennaRetainedCurrentFieldInspection(carrier)) if carrier == &operation) {
            bail!("imported retained carrier differs from canonical accepted lowering");
        }
        Some(operation)
    } else { None };
    let preparation = evidence.preparations.get(task_id).context("imported retained preparation absent")?;
    let legacy_receipt = if direct.is_none() { Some(accepted.bind_retained_current_preparation(preparation, task_id)?) } else { None };
    let direct_receipt = if direct.is_some() { Some(accepted.bind_retained_asset_field_preparation(preparation, task_id)?) } else { None };
    let artifacts = evidence.artifacts.as_ref().context("imported retained artifact catalog absent")?;
    let matching = |entry: &&fullmag_session::FmsArtifactCatalogEntry| entry.task_id == task_id
        && entry.attempt_id == attempt && entry.ownership_epoch == epoch;
    let manifests = artifacts.entries.iter().filter(matching)
        .filter(|entry| entry.artifact_type == "study_output_manifest").collect::<Vec<_>>();
    let [manifest_entry] = manifests.as_slice() else { bail!("imported retained completion manifest is not unique"); };
    let manifest_ref = manifest_entry.object_ref.as_deref().context("imported retained completion CAS absent")?;
    if manifest_entry.status != fullmag_session::FmsArtifactStatus::Published
        || manifest_entry.content_sha256 != manifest_ref || !task.artifact_ids.contains(&manifest_entry.artifact_id) {
        bail!("imported retained completion manifest is not exactly published");
    }
    let manifest_bytes = read_import_metadata(store, manifest_ref, &mut reserve)?
        .context("imported retained completion bytes absent")?;
    let output_manifest: fullmag_session::FmsStudyOutputManifest = serde_json::from_slice(&manifest_bytes)?;
    output_manifest.validate()?;
    if output_manifest.run_id != run.as_str() || output_manifest.task_id != task_id
        || output_manifest.step_id != step.step_id || output_manifest.attempt_id != attempt
        || output_manifest.ownership_epoch != epoch || output_manifest.outputs.len() != 1
        || output_manifest.accepted_state_ref.is_some() || output_manifest.observation_source.is_some() {
        bail!("imported retained completion identity differs from its nonmagnetic operation");
    }
    let output = &output_manifest.outputs[0];
    validate_child_contract(&step.kind, step.enabled, &step.outputs, output, expected_object)?;
    let outputs = artifacts.entries.iter().filter(matching)
        .filter(|entry| entry.artifact_type == "artifact" && entry.study_output.is_some()).collect::<Vec<_>>();
    let [artifact] = outputs.as_slice() else { bail!("imported retained output artifact is not unique"); };
    let identity = fullmag_session::FmsStudyArtifactOutput {
        step_id: step.step_id.clone(), port_id: output.port_id.clone(), case_id: output.case_id.clone(),
    };
    if artifact.artifact_id != output.artifact_id
        || artifact.status != fullmag_session::FmsArtifactStatus::Published || artifact.artifact_type != "artifact"
        || artifact.object_ref.as_deref() != Some(expected_object) || artifact.content_sha256 != expected_object
        || artifact.study_output.as_ref() != Some(&identity) || !task.artifact_ids.contains(&artifact.artifact_id) {
        bail!("imported retained output differs from its exact completion");
    }
    let maximum = historical_package_budget(task, run, attempt, epoch)?;
    reserve.metadata(16)?;
    let header = store.cas().get_verified_range(expected_object, 0, 16, MAX_METADATA_BYTES)?
        .context("imported retained field package absent")?;
    if header.object_length > maximum as u64 { bail!("imported retained field exceeds its historical decode budget"); }
    let manifest_length = retained_current_field_manifest_length_any(&header.bytes, header.object_length)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    reserve.metadata(manifest_length as u64)?;
    let manifest_range = store.cas().get_verified_range(expected_object, 16, manifest_length as u64, MAX_METADATA_BYTES)?
        .context("imported retained manifest absent")?;
    if manifest_range.object_length != header.object_length { bail!("imported retained package length changed"); }
    let child_manifest = parse_retained_current_manifest_any(&manifest_range.bytes)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let child = child_manifest.as_ref();
    let version = if direct.is_some() { "v2" } else { "v1" };
    if output.codec_version != version || child.codec_version() != version
        || (&header.bytes[..8] == b"FMARCF1\0") != (version == "v1") {
        bail!("imported retained codec, manifest and accepted typed operation differ");
    }
    reserve.packages(header.object_length, child.parent().owner.package.byte_count)?;
    // No whole child buffer is held while the full original source is verified.
    let (parent, capsule_bytes, authentic) = load_detached_parent_content(store, expected_object, child, &mut reserve)?;
    let bytes = store.cas().get_bounded(expected_object, maximum as u64)?
        .context("imported retained field package absent")?;
    if bytes.len() as u64 != header.object_length { bail!("imported retained package length changed"); }
    // The source content was fully verified independently of this receipt and child metadata.
    let bundle = if let Some(operation) = &direct {
        let authentic = authentic.as_ref().context("imported DTQ authentic source projection absent")?;
        let reference = operation.stage.retained_source_preparation.as_ref().context("imported DTQ asset absent")?;
        // Reserve the input document before the shared binding reader allocates it.
        let length = store.cas().verified_length(&reference.content_sha256)?.context("imported DTQ asset CAS absent")?;
        reserve.metadata(length)?;
        crate::load_retained_source_preparation_binding(store, &accepted.run, problem, &operation.stage, authentic)?;
        direct_receipt.as_ref().context("imported DTQ receipt absent")?.validate_for(
            &accepted.run.specification, task_id, lowered, problem, child.parent(), &authentic.source_preparation)?;
        RetainedCurrentFieldBundleAny::DirectV2(crate::study_retained_current_field::validate_retained_direct_field_content(
            &bytes, maximum, problem, operation, child.parent(), &parent, &capsule_bytes)?)
    } else {
        legacy_receipt.as_ref().context("imported retained receipt absent")?.validate_for(
            &accepted.run.specification, task_id, lowered, problem, child.parent())?;
        RetainedCurrentFieldBundleAny::SurfaceV1(crate::study_retained_current_field::validate_retained_current_field_content(
            &bytes, maximum, problem, legacy.as_ref().context("imported retained operation absent")?,
            child.parent(), &parent, &capsule_bytes)?)
    };
    Ok((serde_json::json!({
        "schema": "fullmag.imported_retained_current_field_integrity.v1", "status": "pass",
        "project_id": accepted.run.specification.snapshot.project_id.as_str(),
        "run_id": run.as_str(), "task_id": task_id, "attempt_id": attempt,
        "ownership_epoch": epoch, "object_ref": expected_object, "artifact_id": artifact.artifact_id,
        "closure_sha256": expected_closure, "read_only": true,
        "publication": "inspection_only", "qualification": "not_verified",
        "completion_evidence": "detached_accepted_records", "current_source": false, "llg": false,
    }), bundle))
}

fn load_detached_parent_content(
    store: &SessionStore, child_object: &str, child: RetainedCurrentFieldManifestRef<'_>,
    reserve: &mut ImportedRetainedAllocationReserve,
) -> Result<(fullmag_runner::VerifiedRetainedCurrentParentContent, Vec<u8>,
    Option<fullmag_antenna_artifacts::source_preparation::AntennaSourcePreparationAssetDocument>)> {
    let allocation = std::cell::RefCell::new(reserve);
    let detached = fullmag_session::accepted_provenance::validate_retained_current_parent_evidence_any(
        child_object, child,
        |object| read_import_metadata(store, object, &mut allocation.borrow_mut()),
        |object, offset, length| {
            allocation.borrow_mut().metadata(length)?;
            store.cas().get_verified_range(object, offset, length, MAX_METADATA_BYTES)
        },
    )?;
    let owner = &child.parent().owner;
    let run = RunId::parse(owner.run_id.clone())?;
    let evidence = load_detached_study_evidence_from_records(
        store, &run, detached.manifest.records(), &detached.records,
        Some(&mut |bytes| allocation.borrow_mut().metadata(bytes)),
    )?.context("imported retained parent has no immutable accepted Study")?;
    let accepted = &evidence.accepted;
    if accepted.run.specification.snapshot.project_id.as_str() != owner.project_id {
        bail!("imported retained parent project differs from its capsule");
    }
    let step = accepted.study.steps.iter().find(|step| step.step_id == owner.study_step_id)
        .context("imported retained parent step absent")?;
    let StudyStepKind::ClosedLoopInspection { stage_id, .. } = &step.kind
        else { bail!("imported H-only child cannot become a full current parent"); };
    if !step.enabled || stage_id != &owner.native_stage_id {
        bail!("imported retained parent operation is disabled or differs from its native stage");
    }
    let lowered = accepted.lowered.steps.iter().find(|entry| entry.step_id == step.step_id)
        .context("imported retained parent lowering absent")?;
    let task = evidence.catalog.tasks.iter().find(|entry| entry.task_id == owner.task_id)
        .context("imported retained parent task absent")?;
    if task.input_fingerprint != fullmag_application::study_task_input_fingerprint(&accepted.run.specification, lowered)? {
        bail!("imported retained parent fingerprint differs from accepted source intent");
    }
    let preparation = evidence.preparations.get(&owner.task_id).context("imported retained parent preparation absent")?;
    let source_receipt = accepted.bind_closed_inspection_preparation(preparation, &owner.task_id)?;
    let problem = accepted.catalog.entries().iter().find(|entry| entry.step_id() == step.step_id)
        .context("imported retained parent ProblemIR absent")?.problem();
    let output_bytes = read_import_metadata(store, &owner.output_manifest.object_ref, &mut allocation.borrow_mut())?
        .context("imported retained parent output manifest absent")?;
    let output: fullmag_session::FmsStudyOutputManifest = serde_json::from_slice(&output_bytes)?;
    let [port] = step.outputs.as_slice() else { bail!("imported retained parent accepted output port is not unique"); };
    let [item] = output.outputs.as_slice() else { bail!("imported retained parent output is not unique"); };
    if port.data_kind != StudyPortDataKind::Artifact || item.port_id != port.port_id {
        bail!("imported retained parent output differs from its accepted port");
    }
    let maximum = historical_package_budget(task, &run, &owner.attempt_id, owner.ownership_epoch.parse()?)?;
    if owner.package.byte_count > maximum as u64 { bail!("imported retained parent exceeds its historical decode budget"); }
    let parent_bytes = store.cas().get_bounded(&owner.package.object_ref, owner.package.byte_count)?
        .context("imported retained parent package absent")?;
    if parent_bytes.len() as u64 != owner.package.byte_count {
        bail!("imported retained parent package differs from its pinned byte count");
    }
    // Exactly one canonical full v2 source verifier. No live-store reader, fake claim or second physical decoder.
    let source = crate::study_inspection::load_accepted_retained_current_source_bytes(
        problem, step, &parent_bytes, maximum,
    )?;
    let capsule_bytes = read_import_metadata(store, &child.parent().evidence_capsule.object_ref, &mut allocation.borrow_mut())?
        .context("imported retained parent capsule absent")?;
    let parent = source.bind_parent(child.parent(), &capsule_bytes)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let authentic = if matches!(child, RetainedCurrentFieldManifestRef::DirectV2(_)) {
        let StudyStepKind::ClosedLoopInspection { stage_id, port_mode_id, output_id } = &step.kind
            else { bail!("imported DTQ source must be the original full closed-loop operation"); };
        let operation = fullmag_plan::validate_closed_loop_operation(problem, stage_id, port_mode_id, output_id)?;
        let fullmag_plan::AntennaFieldSolveExecutionPlan::ClosedLoopInspection { input, .. } = operation
            else { bail!("imported DTQ source projection selected another family"); };
        let receipt = &source_receipt;
        let mut raw = None;
        for record in detached.manifest.records().iter().filter(|record|
            record.kind == fullmag_session::accepted_provenance::AcceptedProvenanceRecordKind::TaskPreparationReceipt) {
            let bytes = detached.records.get(&record.archive_path).context("imported DTQ source receipt bytes absent")?;
            let durable: fullmag_session::FmsTaskPreparationReceipt = serde_json::from_slice(bytes)?;
            if durable.task_id == owner.task_id {
                if raw.replace(bytes).is_some() { bail!("imported DTQ source receipt is not unique"); }
            }
        }
        let raw = raw.context("imported DTQ exact source receipt record absent")?;
        let durable: fullmag_session::FmsTaskPreparationReceipt = serde_json::from_slice(raw)?;
        if &durable != preparation || durable.run_id != owner.run_id || durable.step_id != owner.study_step_id
            || durable.preparation_id != receipt.preparation_id || durable.plan_fingerprint != receipt.plan_fingerprint
            || durable.input_fingerprint != task.input_fingerprint {
            bail!("imported DTQ source receipt differs from independently authenticated source");
        }
        let document = fullmag_antenna_artifacts::source_preparation::AntennaSourcePreparationAssetDocument {
            schema_version: fullmag_antenna_artifacts::source_preparation::ANTENNA_SOURCE_PREPARATION_ASSET_SCHEMA.into(),
            parent_owner: owner.clone(), source_pins: child.parent().source.clone(), source_mesh: input.source_mesh,
            source_object_segments: input.source_object_segments, prepared_source: input.source,
            authored_input_preimage: input.authored_input_preimage,
            source_preparation: fullmag_ir::AntennaSourcePreparationReceiptPinsIR {
                receipt_schema_version: durable.schema_version, run_id: durable.run_id, task_id: durable.task_id,
                step_id: durable.step_id, input_fingerprint: durable.input_fingerprint,
                preparation_id: durable.preparation_id, plan_fingerprint: durable.plan_fingerprint,
                payload_sha256: durable.payload_sha256, receipt_sha256: fullmag_session::hex_sha256(raw),
            },
        };
        document.validate().map_err(|error| anyhow::anyhow!(error.to_string()))?;
        Some(document)
    } else { None };
    Ok((parent, capsule_bytes, authentic))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn output() -> fullmag_session::FmsStudyOutputManifestEntry {
        fullmag_session::FmsStudyOutputManifestEntry {
            port_id: "inspection".into(), case_id: "default".into(), data_kind: "artifact".into(),
            codec_id: RETAINED_CURRENT_FIELD_CODEC_ID.into(), codec_version: RETAINED_CURRENT_FIELD_CODEC_VERSION.into(),
            artifact_id: "artifact-child".into(), object_ref: "a".repeat(64), content_sha256: "a".repeat(64),
        }
    }
    #[test]
    fn imported_child_accepts_only_its_explicit_nonmagnetic_contract() {
        let kind = StudyStepKind::RetainedCurrentFieldInspection {
            stage_id: "field".into(), port_mode_id: "port".into(), output_id: "field-output".into(),
        };
        let ports = [StudyOutputPort { port_id: "inspection".into(), data_kind: StudyPortDataKind::Artifact }];
        let valid = output();
        validate_child_contract(&kind, true, &ports, &valid, &valid.object_ref).unwrap();
        assert!(validate_child_contract(&kind, false, &ports, &valid, &valid.object_ref).is_err());
        let legacy = StudyStepKind::ClosedLoopInspection {
            stage_id: "field".into(), port_mode_id: "port".into(), output_id: "field-output".into(),
        };
        assert!(validate_child_contract(&legacy, true, &ports, &valid, &valid.object_ref).is_err());
        let magnetic_ports = [StudyOutputPort { port_id: "inspection".into(), data_kind: StudyPortDataKind::State }];
        assert!(validate_child_contract(&kind, true, &magnetic_ports, &valid, &valid.object_ref).is_err());
        for field in ["codec", "version", "case", "kind", "port", "object", "hash"] {
            let mut wrong = valid.clone();
            match field {
                "codec" => wrong.codec_id = fullmag_application::ANTENNA_INSPECTION_BUNDLE_CODEC_ID.into(),
                "version" => wrong.codec_version = "v3".into(),
                "case" => wrong.case_id = "foreign".into(),
                "kind" => wrong.data_kind = "state".into(),
                "port" => wrong.port_id = "m".into(),
                "object" => wrong.object_ref = "b".repeat(64),
                _ => wrong.content_sha256 = "b".repeat(64),
            }
            assert!(validate_child_contract(&kind, true, &ports, &wrong, &valid.object_ref).is_err());
        }
    }
    #[test]
    fn imported_combined_package_reserve_refuses_before_a_whole_package_read() {
        let mut reserve = ImportedRetainedAllocationReserve::default();
        reserve.metadata(1024 * 1024).unwrap();
        // Either package fits the reserve individually; their simultaneous decode
        // footprints do not. Refusal leaves the previous accounting unchanged.
        assert!(ImportedRetainedAllocationReserve::check(1024 * 1024, 4 * 1024 * 1024).is_ok());
        let error = reserve.packages(4 * 1024 * 1024, 4 * 1024 * 1024).unwrap_err();
        assert!(error.to_string().contains("temporary allocation reserve"));
        assert_eq!(reserve.package_bytes, 0);
        assert!(reserve.packages(u64::MAX, 1).is_err());
        assert!(reserve.metadata(u64::MAX).is_err());
        assert_eq!(reserve.metadata_bytes, 1024 * 1024);
    }
    #[test]
    fn imported_metadata_size_is_charged_before_reading_or_parsing_its_body() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        // CAS integrity is valid, but even raw metadata alone cannot fit the new
        // decoder reserve. This must fail before attempting JSON or package decode.
        let bytes = vec![b'x'; 9 * 1024 * 1024];
        let object = store.cas().put(&bytes).unwrap();
        drop(bytes);
        let mut reserve = ImportedRetainedAllocationReserve::default();
        let error = read_import_metadata(&store, &object, &mut reserve).unwrap_err();
        assert!(error.to_string().contains("temporary allocation reserve"));
        assert_eq!(reserve.metadata_bytes, 0);
        assert_eq!(store.cas().verified_length(&object).unwrap(), Some(9 * 1024 * 1024));
    }
    #[test]
    fn imported_discovery_streams_the_whole_typed_study_and_rejects_ambiguous_tags() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        let retained = br#"{"steps":[{"kind":{"kind":"retained_current_field_inspection"},"unused":{"nested":[1,2,3]}}]}"#;
        let object = store.cas().put(retained).unwrap();
        assert!(imported_study_contains_retained_field(&store, &object).unwrap());
        let legacy = store.cas().put(br#"{"steps":[{"kind":{"kind":"closed_loop_inspection"}}]}"#).unwrap();
        assert!(!imported_study_contains_retained_field(&store, &legacy).unwrap());
        for ambiguous in [
            br#"{"steps":[],"steps":[{"kind":{"kind":"retained_current_field_inspection"}}]}"#.as_slice(),
            br#"{"steps":[{"kind":{"kind":"retained_current_field_inspection"},"kind":{"kind":"closed_loop_inspection"}}]}"#.as_slice(),
            br#"{"steps":[{"kind":{"kind":"retained_current_field_inspection","kind":"closed_loop_inspection"}}]}"#.as_slice(),
            br#"{"steps":[{"kind":{"kind":"retained_current_field_inspection"}}]} trailing"#.as_slice(),
        ] {
            let object = store.cas().put(ambiguous).unwrap();
            assert!(imported_study_contains_retained_field(&store, &object).is_err());
        }
        // A true kind near the front must not bypass authentication of the suffix.
        let damaged = retained.iter().map(|byte| if *byte == b'3' { b'4' } else { *byte }).collect::<Vec<_>>();
        std::fs::write(store.root().join(format!("objects/sha256/{object}")), damaged).unwrap();
        assert!(imported_study_contains_retained_field(&store, &object).unwrap_err().to_string().contains("digest"));
    }
    #[test]
    fn imported_model_preflight_includes_compiled_and_captured_runtime_assets() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        let object = store.cas().put(&vec![b'x'; 3 * 1024 * 1024]).unwrap();
        // Distinct immutable asset IDs can reference identical bytes, yet canonical
        // source validation reads each record. All three reads must be reserved.
        let assets = [fullmag_application::SCRIPT_PIPELINE_SOURCE_ASSET_ID, "script-file-source", "script-file-runtime"]
            .map(|id| fullmag_application::ImmutableAssetReference { asset_id: id.into(), content_sha256: object.clone() });
        let references = assets.iter().map(|asset| (asset.asset_id.clone(), asset.content_sha256.clone())).collect();
        let mut reserve = ImportedRetainedAllocationReserve::default();
        let error = reserve_imported_immutable_asset_reads(&store, &assets, &references,
            &mut |bytes| reserve.metadata(bytes)).unwrap_err();
        assert!(error.to_string().contains("temporary allocation reserve"));
        assert_eq!(reserve.metadata_bytes, 6 * 1024 * 1024);
        let mut wrong = references.clone();
        wrong.insert(assets[0].asset_id.clone(), "a".repeat(64));
        assert!(reserve_imported_immutable_asset_reads(&store, &assets, &wrong,
            &mut |_| panic!("unbound asset must fail before allocation admission")).is_err());
    }
    #[test]
    fn incomplete_import_refuses_without_creating_parent_history_or_modifying_store_bytes() {
        fn snapshot(root: &std::path::Path) -> std::collections::BTreeMap<std::path::PathBuf, String> {
            let mut files = std::collections::BTreeMap::new();
            let mut pending = vec![root.to_path_buf()];
            while let Some(directory) = pending.pop() {
                for entry in std::fs::read_dir(directory).unwrap() {
                    let entry = entry.unwrap();
                    if entry.file_type().unwrap().is_dir() { pending.push(entry.path()); }
                    else {
                        files.insert(entry.path().strip_prefix(root).unwrap().to_path_buf(),
                            fullmag_session::hex_sha256(&std::fs::read(entry.path()).unwrap()));
                    }
                }
            }
            files
        }
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        let before = snapshot(directory.path());
        let run = RunId::parse("run-import-child").unwrap();
        let error = load_imported_retained_current_field_inspection(
            &store, &run, &format!("sha256:{}", "b".repeat(64)),
            "task-import-child", "attempt-import-child", 1, &"a".repeat(64),
        ).err().expect("an absent imported observation must never become an execution source");
        assert!(error.to_string().contains("imported session manifest absent"));
        assert_eq!(snapshot(directory.path()), before);
    }

}
