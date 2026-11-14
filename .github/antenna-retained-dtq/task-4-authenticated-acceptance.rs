// Installed in an explicitly owned ephemeral CI source tree by task-4-register-ci.py.
// Requires a canonical test-only Running fixture; no Completed history or lease is rewritten.
use std::collections::{BTreeMap, HashMap};
use std::path::{Component, Path, PathBuf};
use fullmag_antenna_artifacts::retained_current::{RetainedCurrentFieldBundleAny, RetainedCurrentParent};
use fullmag_session::{SessionStore, FmsSessionManifest, FmsWorkspaceManifest, SaveProfile};
use fullmag_session::accepted_provenance::{AcceptedProvenanceContext, plan_accepted_provenance};

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ExpectedPayload { path: PathBuf, sha256: String }

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Fixture {
    prepublication_store: PathBuf,
    archive_source_store: PathBuf,
    candidate_bundle: PathBuf,
    expected_payloads: BTreeMap<String, ExpectedPayload>,
    project_id: String,
    run_id: String,
    task_id: String,
    attempt_id: String,
    ownership_epoch: u64,
    child_object_ref: String,
    expected_parent: RetainedCurrentParent,
    expected_source_preparation: fullmag_ir::AntennaSourcePreparationReceiptPinsIR,
    expected_sample_carrier: fullmag_antenna_artifacts::AntennaSampleCarrier,
    expected_child_content_digest: String,
    expected_run_spec_fingerprint: String,
    provenance_context: AcceptedProvenanceContext,
    archive_session: FmsSessionManifest,
    archive_workspace: FmsWorkspaceManifest,
    archive_documents: BTreeMap<String, PathBuf>,
}

fn input_path(root: &Path, relative: &Path) -> anyhow::Result<PathBuf> {
    anyhow::ensure!(!relative.as_os_str().is_empty() && relative.components().all(|c| matches!(c, Component::Normal(_))),
        "fixture inputs must use relative normal path components");
    let mut path = root.to_path_buf();
    for component in relative.components() {
        path.push(component.as_os_str());
        anyhow::ensure!(!std::fs::symlink_metadata(&path)?.file_type().is_symlink(), "fixture inputs refuse links");
    }
    let path = path.canonicalize()?;
    anyhow::ensure!(path.starts_with(root), "fixture input escapes its root");
    Ok(path)
}

fn require_external_temporary_root(temporary_root: &Path, sources: [&Path; 2]) -> anyhow::Result<()> {
    anyhow::ensure!(sources.iter().all(|source| !temporary_root.starts_with(source)),
        "managed test temporary root must not equal or lie inside either source store");
    Ok(())
}

fn require_disjoint_owned_source(owned: &Path, source: &Path) -> anyhow::Result<()> {
    anyhow::ensure!(!owned.starts_with(source) && !source.starts_with(owned),
        "owned test tree and source store must be disjoint in both directions");
    Ok(())
}

#[test]
fn dtq_v2_temp_root_nested_in_source_is_rejected_before_copy() -> anyhow::Result<()> {
    let directory = tempfile::tempdir()?;
    let test_root = directory.path().canonicalize()?;
    let accepted = test_root.join("accepted");
    let archive = test_root.join("archive");
    std::fs::create_dir(&accepted)?;
    std::fs::create_dir(&archive)?;
    let accepted_nested = accepted.join("managed-temp");
    let archive_nested = archive.join("managed-temp");
    std::fs::create_dir(&accepted_nested)?;
    std::fs::create_dir(&archive_nested)?;
    let accepted = accepted.canonicalize()?;
    let archive = archive.canonicalize()?;
    let accepted_nested = accepted_nested.canonicalize()?;
    let archive_nested = archive_nested.canonicalize()?;
    for rejected in [&accepted, &archive, &accepted_nested, &archive_nested] {
        assert!(require_external_temporary_root(rejected, [&accepted, &archive]).is_err());
    }
    for source in [&accepted, &archive] {
        assert!(require_disjoint_owned_source(source, source).is_err());
        assert!(require_disjoint_owned_source(&source.join("owned"), source).is_err());
        assert!(require_disjoint_owned_source(&test_root, source).is_err());
    }
    require_external_temporary_root(&test_root, [&accepted, &archive])?;
    require_disjoint_owned_source(&test_root.join("safe-owned"), &accepted)?;
    require_disjoint_owned_source(&test_root.join("safe-owned"), &archive)?;
    // No source copy or destination is created, even for the rejected layouts.
    assert_eq!(std::fs::read_dir(&accepted_nested)?.count(), 0);
    assert_eq!(std::fs::read_dir(&archive_nested)?.count(), 0);
    assert_eq!(std::fs::read_dir(&test_root)?.count(), 2);
    Ok(())
}

fn copy_regular_tree(source: &Path, destination: &Path) -> anyhow::Result<()> {
    let metadata = std::fs::symlink_metadata(source)?;
    anyhow::ensure!(metadata.is_dir() && !metadata.file_type().is_symlink(), "fixture root must be a regular directory");
    std::fs::create_dir(destination)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        anyhow::ensure!(!kind.is_symlink(), "fixture copy refuses links");
        let output = destination.join(entry.file_name());
        if kind.is_dir() { copy_regular_tree(&entry.path(), &output)?; }
        else { anyhow::ensure!(kind.is_file(), "fixture copy refuses special files"); std::fs::copy(entry.path(), output)?; }
    }
    Ok(())
}

fn remove_owned_source_copy(owned: &Path, target: &Path) -> anyhow::Result<()> {
    let canonical = target.canonicalize()?;
    anyhow::ensure!(canonical.parent() == Some(owned)
        && matches!(canonical.file_name().and_then(|n| n.to_str()), Some("accepted-source" | "archive-source")),
        "only a direct, newly owned test source copy may be removed");
    std::fs::remove_dir_all(&canonical)?;
    anyhow::ensure!(!target.exists(), "old test source copy remains accessible");
    Ok(())
}

fn commit_event(store: &SessionStore, coordinator: &mut fullmag_application::DurableWorkerCoordinator,
    event: fullmag_application::WorkerEvent) -> anyhow::Result<()> {
    let checkpoint = coordinator.checkpoint();
    let envelope = fullmag_application::WorkerEventEnvelope {
        schema_version: coordinator.protocol_schema().into(), message_id: uuid::Uuid::new_v4().simple().to_string(),
        sequence: checkpoint.event_sequence.checked_add(1).ok_or_else(|| anyhow::anyhow!("fixture event sequence exhausted"))?,
        claim: checkpoint.claim.identity(), event,
    };
    let mut publication_error = None;
    coordinator.commit_event(envelope, |transition| crate::commit_transition(store, transition).map(|_| ()).map_err(|error| {
        publication_error = Some(error);
        fullmag_application::CoordinatorError::Invalid("fixture durable event publication failed".into())
    })).map_err(|error| publication_error.unwrap_or_else(|| anyhow::anyhow!(error)))?;
    Ok(())
}

fn assert_bundle(bundle: &RetainedCurrentFieldBundleAny, fixture: &Fixture,
    expected: &BTreeMap<String, Vec<u8>>) -> anyhow::Result<()> {
    anyhow::ensure!(matches!(bundle, RetainedCurrentFieldBundleAny::DirectV2(_)), "fixture must use direct v2");
    let m = bundle.manifest();
    anyhow::ensure!(bundle.payloads() == expected, "four payload bytes differ from independently pinned expectation");
    anyhow::ensure!(m.parent() == &fixture.expected_parent && m.sample_carrier() == &fixture.expected_sample_carrier,
        "child owner/parent/topology differs from independent expectation");
    anyhow::ensure!(m.content_digest() == fixture.expected_child_content_digest && m.status() == "inspection_only"
        && m.qualification() == "not_verified", "child content/status/provenance differs");
    Ok(())
}

#[test]
fn dtq_v2_publication_completion_cold_read_same_bytes() -> anyhow::Result<()> {
    let config = std::env::var_os("FULLMAG_DTQ_AUTHENTICATED_FIXTURE_JSON")
        .ok_or_else(|| anyhow::anyhow!("NOT VERIFIED: dedicated legal prepublication fixture JSON is required"))?;
    let config = PathBuf::from(config).canonicalize()?;
    let root = config.parent().ok_or_else(|| anyhow::anyhow!("fixture parent absent"))?.to_path_buf();
    let fixture: Fixture = serde_json::from_slice(&std::fs::read(&config)?)?;
    let temporary_root = std::env::var_os("FULLMAG_DTQ_TEST_TEMP_ROOT")
        .ok_or_else(|| anyhow::anyhow!("explicit managed test temporary root required"))?;
    let temporary_root = PathBuf::from(temporary_root).canonicalize()?;
    let original_accepted = input_path(&root, &fixture.prepublication_store)?;
    let original_archive = input_path(&root, &fixture.archive_source_store)?;
    anyhow::ensure!(original_accepted != original_archive, "fixture requires separate immutable source stores");
    require_external_temporary_root(&temporary_root, [&original_accepted, &original_archive])?;
    let directory = tempfile::Builder::new().prefix("retained-dtq-acceptance-").tempdir_in(&temporary_root)?;
    let owned = directory.path().canonicalize()?;
    require_disjoint_owned_source(&owned, &original_accepted)?;
    require_disjoint_owned_source(&owned, &original_archive)?;
    let accepted_copy = owned.join("accepted-source");
    let archive_copy = owned.join("archive-source");
    copy_regular_tree(&original_accepted, &accepted_copy)?;
    copy_regular_tree(&original_archive, &archive_copy)?;
    let expected = fixture.expected_payloads.iter().map(|(key, pin)| {
        let bytes = std::fs::read(input_path(&root, &pin.path)?)?;
        anyhow::ensure!(fullmag_session::hex_sha256(&bytes) == pin.sha256, "expected payload pin differs: {key}");
        Ok((key.clone(), bytes))
    }).collect::<anyhow::Result<BTreeMap<_,_>>>()?;
    anyhow::ensure!(expected.keys().map(String::as_str).collect::<Vec<_>>() == ["evidence", "h_raw", "sample_cells", "sample_xyz"],
        "fixture must pin exactly four payloads");
    let bytes = std::fs::read(input_path(&root, &fixture.candidate_bundle)?)?;
    anyhow::ensure!(fullmag_session::hex_sha256(&bytes) == fixture.child_object_ref, "candidate package CAS pin differs");
    let project = fullmag_application::ProjectId::parse(fixture.project_id.clone())?;
    let run = fullmag_application::RunId::parse(fixture.run_id.clone())?;
    let live = SessionStore::open_existing(&accepted_copy)?;
    let accepted = crate::load_accepted_study_snapshot(&live, &run, &project)?;
    anyhow::ensure!(accepted.run.specification.fingerprint()? == fixture.expected_run_spec_fingerprint,
        "immutable accepted RunSpec differs from expected fixture");
    let catalog = live.read_run_catalog(&fixture.run_id)?.ok_or_else(|| anyhow::anyhow!("fixture catalog absent"))?;
    let task = catalog.tasks.iter().find(|task| task.task_id == fixture.task_id).ok_or_else(|| anyhow::anyhow!("fixture task absent"))?;
    anyhow::ensure!(task.lifecycle == fullmag_session::FmsTaskLifecycle::Running && task.artifact_ids.is_empty(),
        "fixture must be legal Running prepublication state; Completed history is never rewritten");
    let genesis = task.coordinator_genesis.as_ref().ok_or_else(|| anyhow::anyhow!("fixture historical claim absent"))?;
    let checkpoint: fullmag_application::CoordinatorCheckpoint = serde_json::from_value(genesis.checkpoint.clone())?;
    let claim = checkpoint.claim;
    anyhow::ensure!(claim.attempt_id.as_str() == fixture.attempt_id && claim.ownership_epoch.value() == fixture.ownership_epoch,
        "fixture claim pins differ");
    let step = accepted.study.steps.iter().find(|step|
        fullmag_session::task_id_for_study_step(&fixture.run_id, &step.step_id).ok().as_deref() == Some(fixture.task_id.as_str()))
        .ok_or_else(|| anyhow::anyhow!("fixture accepted step absent"))?;
    let receipt = accepted.read_task_preparation(&live, &fixture.task_id)?;
    let fullmag_application::AcceptedPreparationReceipt::RetainedAssetField(receipt) = receipt
        else { anyhow::bail!("fixture direct source preparation receipt absent"); };
    anyhow::ensure!(receipt.plan.source_preparation == fixture.expected_source_preparation, "nine source preparation pins differ");
    let existing = live.read_artifact_catalog(&fixture.run_id)?;
    anyhow::ensure!(existing.as_ref().is_none_or(|catalog| !catalog.entries.iter().any(|entry|
        entry.task_id == fixture.task_id && entry.attempt_id == fixture.attempt_id && entry.ownership_epoch == fixture.ownership_epoch)),
        "fixture already contains current publication; provide a legal prepublication fixture");
    let recovered = crate::recover_coordinator(&live, &claim)?;
    anyhow::ensure!(recovered.coordinator.phase() == fullmag_application::CoordinatorPhase::Running
        && !recovered.events.iter().any(|entry| matches!(&entry.event, fullmag_application::WorkerEvent::Completed { .. })),
        "fixture must have a legal Running causal journal without Completed");
    let mut coordinator = fullmag_application::DurableWorkerCoordinator::new(recovered.coordinator);
    commit_event(&live, &mut coordinator, fullmag_application::WorkerEvent::Completing)?;
    let payload = crate::StudyOutputPayload {port_id:"inspection".into(),case_id:"default".into(),
        codec_id:fullmag_antenna_artifacts::retained_current::RETAINED_CURRENT_FIELD_CODEC_ID.into(),codec_version:"v2".into(),bytes};
    crate::publish_study_outputs(&live, &accepted, &claim, &step.step_id, &[payload], None, None)?;
    crate::validate_study_task_completion(&live, &claim)?;
    commit_event(&live, &mut coordinator, fullmag_application::WorkerEvent::Completed {
        assessment: fullmag_application::ScientificAssessment::Unassessed })?;
    anyhow::ensure!(coordinator.phase() == fullmag_application::CoordinatorPhase::Terminal,
        "real Completed publication did not reach terminal phase");
    let (saved_integrity, published) = crate::load_saved_retained_current_field_inspection(&live, &project, &run,
        &fixture.task_id, &fixture.attempt_id, fixture.ownership_epoch, &fixture.child_object_ref)?;
    assert_bundle(&published, &fixture, &expected)?;
    anyhow::ensure!(saved_integrity["publication"] == "inspection_only" && saved_integrity["qualification"] == "not_verified",
        "saved publication status differs");
    let provenance = plan_accepted_provenance(&accepted_copy, &fixture.provenance_context)?;
    anyhow::ensure!(provenance.manifest.accepted_run_id == fixture.run_id, "archive provenance selected another run");
    let closure = provenance.manifest.closure_sha256.clone();
    let documents = fixture.archive_documents.iter().map(|(name,path)|
        Ok((name.clone(),std::fs::read(input_path(&root,path)?)?))).collect::<anyhow::Result<HashMap<_,_>>>()?;
    let archive_source = SessionStore::open_existing(&archive_copy)?;
    let mut session = fixture.archive_session.clone();
    anyhow::ensure!(session.format == fullmag_session::FMS_SESSION_FORMAT_V2 && session.profile == SaveProfile::Archive
        && session.run_refs == [format!("runs/{}/run_manifest.json",fixture.run_id)], "fixture requires explicit v2 Archive session");
    session.accepted_provenance_ref = Some(fullmag_session::FmsAcceptedProvenanceReference {
        manifest_ref:fullmag_session::FMS_ACCEPTED_PROVENANCE_MANIFEST_REF.into(),
        accepted_run_id:fixture.run_id.clone(),closure_sha256:closure.clone() });
    let archive_path = owned.join("retained-dtq.fms");
    let mut archive = std::fs::OpenOptions::new().write(true).read(true).create_new(true).open(&archive_path)?;
    fullmag_session::fms::pack_fms_with_accepted_provenance(&mut archive, &archive_source, &session,
        &fixture.archive_workspace, &fullmag_session::FmsExportProfile::for_profile(SaveProfile::Archive),
        &documents, &fullmag_session::fms::PackOptions::default(), &provenance)?;
    use std::io::{Seek, SeekFrom};
    archive.seek(SeekFrom::Start(0))?;
    let staging = owned.join("staging");std::fs::create_dir(&staging)?;
    let preflight = fullmag_session::fms::preflight_fms_staged(archive, &[], &staging)?;
    preflight.reachability.require_complete()?;
    let cold = SessionStore::open(owned.join("cold-store"))?;
    anyhow::ensure!(cold.current_session()?.is_none() && cold.read_run_catalog(&fixture.run_id)?.is_none()
        && cold.read_run_catalog(&fixture.expected_parent.owner.run_id)?.is_none(), "destination must be pristine");
    let imported = fullmag_session::fms::unpack_fms_staged_readonly(&preflight, &cold)?;
    anyhow::ensure!(serde_json::to_vec(&imported)? == serde_json::to_vec(&session)? && imported.accepted_provenance_ref.as_ref().is_some_and(|r|
        r.accepted_run_id == fixture.run_id && r.closure_sha256 == closure), "imported archive provenance differs");
    drop(preflight);drop(archive_source);drop(provenance);drop(coordinator);drop(accepted);drop(catalog);drop(live);
    remove_owned_source_copy(&owned, &accepted_copy)?;
    remove_owned_source_copy(&owned, &archive_copy)?;
    anyhow::ensure!(!accepted_copy.exists() && !archive_copy.exists(), "old copied stores must be inaccessible before cold read");
    for old_run in [&fixture.run_id, &fixture.expected_parent.owner.run_id] {
        anyhow::ensure!(cold.read_run_catalog(old_run)?.is_none() && cold.read_run_intent(old_run)?.is_none(),
            "portable import installed active child or parent authority");
    }
    let (integrity, loaded) = crate::load_imported_retained_current_field_inspection(&cold, &run, &closure,
        &fixture.task_id, &fixture.attempt_id, fixture.ownership_epoch, &fixture.child_object_ref)?;
    assert_bundle(&loaded, &fixture, &expected)?;
    anyhow::ensure!(loaded == published && integrity["closure_sha256"] == closure && integrity["current_source"] == false
        && integrity["llg"] == false && integrity["qualification"] == "not_verified" && integrity["publication"] == "inspection_only",
        "portable full H/topology/owner/provenance/status differs from actual publication");
    let detached = crate::load_imported_study_evidence_for_inspection(&cold,&run,&closure)?
        .ok_or_else(||anyhow::anyhow!("portable accepted evidence absent"))?;
    anyhow::ensure!(detached.accepted.run.specification.fingerprint()? == fixture.expected_run_spec_fingerprint,
        "portable accepted provenance changed RunSpec");
    anyhow::ensure!(original_accepted.exists() && original_archive.exists(), "original fixture must remain untouched");
    Ok(())
}
