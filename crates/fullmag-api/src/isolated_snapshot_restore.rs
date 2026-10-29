//! Private pre-listen hydration of an explicitly selected held run in a verified copy.
//!
//! The isolated snapshot request and native read-only receipt are a distinct authority.
//! This module never constructs an old reattach proof or invokes its admission path.
use std::{
    collections::BTreeSet,
    fs,
    path::Path,
    sync::{Arc, atomic::Ordering},
};

use anyhow::{Context, Result, bail};
use fullmag_application::{RunId, RunSpecification};
use fullmag_authoring::SceneDocument;
use fullmag_session::runtime_service::{
    retained_held_manual_runs::RetainedHeldManualRunPin,
    retained_terminal_runs::RetainedTerminalRunPin,
};
use fullmag_session::{FmsTaskLifecycle, FmsTaskReadiness, SessionStore};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    development_accepted_restore::{
        AcceptedRunReattachIdentity, AcceptedSnapshotProjection, build_accepted_snapshot,
        scene_from_definition,
    },
    types::{AppState, CurrentLiveRequestContext},
};

const START_ENV: &str = "FULLMAG_ISOLATED_SNAPSHOT_START";
const SHA_ENV: &str = "FULLMAG_ISOLATED_SNAPSHOT_START_SHA256";
const CONTROL_ROOT: &str = "/opt/fullmag/control/isolated-snapshot";
const START_PATH: &str = "/opt/fullmag/control/isolated-snapshot/start.json";
const START_SCHEMA: &str = "fullmag.isolated-snapshot-start.v1";
const REQUEST_SCHEMA: &str = "runtime_service_retained_snapshot_validation_request.v1";
const RECEIPT_SCHEMA: &str = "runtime_service_retained_snapshot_validation.v1";
const MAX_DOCUMENT: usize = 8 * 1024 * 1024;
const CONFLICTING_ENV: &[&str] = &[
    "FULLMAG_DEVELOPMENT_ACCEPTED_REATTACH_STDIN",
    "FULLMAG_DEVELOPMENT_RESTORE_STDIN",
    "FULLMAG_STARTUP_SCRIPT",
    "FULLMAG_STARTUP_PROVENANCE",
    "FULLMAG_STARTUP_API",
    "FULLMAG_STARTUP_PROVENANCE_SHA256",
    "FULLMAG_STARTUP_HELPER_SHA256",
    "FULLMAG_STARTUP_RECEIPT_KEY",
];

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Start {
    schema: String,
    allow_script_replay: bool,
    request_sha256: String,
    config_sha256: String,
    source_manifest_sha256: String,
    copied_content_sha256: String,
    restore_run_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    schema_version: String,
    request_id: String,
    source_manifest_sha256: String,
    retained_terminal_runs: Vec<RetainedTerminalRunPin>,
    retained_held_manual_runs: Vec<RetainedHeldManualRunPin>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    schema_version: String,
    state: String,
    request_sha256: String,
    config_sha256: String,
    source_manifest_sha256: String,
    run_ids: Vec<String>,
    terminal_count: usize,
    held_count: usize,
    owner_changed: bool,
    compute_started: bool,
}

struct Authority {
    start: Start,
    selected: RetainedHeldManualRunPin,
    receipt_sha256: String,
    config_store_root: std::path::PathBuf,
}

struct LiveBinding {
    session_id: String,
    session_epoch: u64,
    request_id: String,
    source_sha256: String,
}

struct Loaded {
    authority: Authority,
    specification: RunSpecification,
    scene: SceneDocument,
    binding: LiveBinding,
    total_steps: usize,
}

fn digest(value: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        bail!("isolated snapshot requires a lowercase SHA-256 digest");
    }
    Ok(())
}

fn read(root: &Path, name: &str, expected: Option<&str>) -> Result<Vec<u8>> {
    let bytes =
        fullmag_session::repository_path::read_bounded_regular_file(root, name, MAX_DOCUMENT)?;
    if let Some(expected) = expected {
        digest(expected)?;
        if fullmag_session::hex_sha256(&bytes) != expected {
            bail!("isolated snapshot digest mismatch for {name}");
        }
    }
    Ok(bytes)
}

fn validate_transport(path: &str, sha: &str, conflicting: bool) -> Result<()> {
    if path != START_PATH || conflicting {
        bail!(
            "isolated snapshot requires its fixed private path without other restore/startup inputs"
        );
    }
    digest(sha)
}

fn load_authority(root: &Path, start_sha: &str) -> Result<Authority> {
    let start: Start = serde_json::from_slice(&read(root, "start.json", Some(start_sha))?)?;
    if start.schema != START_SCHEMA || start.allow_script_replay {
        bail!("isolated snapshot startup contract rejects script replay");
    }
    let request: Request =
        serde_json::from_slice(&read(root, "request.json", Some(&start.request_sha256))?)?;
    let configuration: Value = serde_json::from_slice(&read(
        root,
        "original-config.json",
        Some(&start.config_sha256),
    )?)?;
    let config_store_root = std::path::PathBuf::from(
        configuration
            .get("store_root")
            .and_then(Value::as_str)
            .context("isolated snapshot original config has no store root")?,
    );
    if !config_store_root.is_absolute() {
        bail!("isolated snapshot config store root must be absolute");
    }
    let source: Value = serde_json::from_slice(&read(
        root,
        "source-manifest.json",
        Some(&start.source_manifest_sha256),
    )?)?;
    read(
        root,
        "copied-content.json",
        Some(&start.copied_content_sha256),
    )?;
    if source.get("restore_run_id").and_then(Value::as_str) != Some(start.restore_run_id.as_str()) {
        bail!("isolated snapshot selected run differs from source manifest");
    }
    let request_id = uuid::Uuid::parse_str(&request.request_id)?;
    if request.schema_version != REQUEST_SCHEMA
        || request_id.to_string() != request.request_id
        || request.source_manifest_sha256 != start.source_manifest_sha256
        || request.retained_held_manual_runs.is_empty()
        || request.retained_held_manual_runs.len() + request.retained_terminal_runs.len() > 128
    {
        bail!("isolated snapshot request identity or retained union is invalid");
    }
    let mut ids = BTreeSet::new();
    for (run_id, intent, catalog) in request
        .retained_terminal_runs
        .iter()
        .map(|p| (&p.run_id, &p.run_intent_sha256, &p.run_catalog_sha256))
        .chain(
            request
                .retained_held_manual_runs
                .iter()
                .map(|p| (&p.run_id, &p.run_intent_sha256, &p.run_catalog_sha256)),
        )
    {
        fullmag_session::repository_path::validate_store_id(run_id)?;
        digest(intent)?;
        digest(catalog)?;
        if !ids.insert(run_id.clone()) {
            bail!("isolated snapshot retained run pins overlap");
        }
    }
    for pin in &request.retained_terminal_runs {
        if let Some(sha) = &pin.artifact_catalog_sha256 {
            digest(sha)?;
        }
    }
    let selected = request
        .retained_held_manual_runs
        .iter()
        .find(|p| p.run_id == start.restore_run_id)
        .cloned()
        .context("isolated snapshot selected run is not an explicitly pinned held-manual run")?;
    let receipt_bytes = read(root, "native-validation.json", None)?;
    let receipt: Receipt = serde_json::from_slice(&receipt_bytes)?;
    if receipt.schema_version != RECEIPT_SCHEMA
        || receipt.state != "validated-read-only"
        || receipt.request_sha256 != start.request_sha256
        || receipt.config_sha256 != start.config_sha256
        || receipt.source_manifest_sha256 != start.source_manifest_sha256
        || receipt.run_ids != ids.into_iter().collect::<Vec<_>>()
        || receipt.terminal_count != request.retained_terminal_runs.len()
        || receipt.held_count != request.retained_held_manual_runs.len()
        || receipt.owner_changed
        || receipt.compute_started
    {
        bail!("isolated snapshot native read-only receipt differs from its exact request");
    }
    Ok(Authority {
        start,
        selected,
        receipt_sha256: fullmag_session::hex_sha256(&receipt_bytes),
        config_store_root,
    })
}

fn validate_live_binding(specification: &RunSpecification) -> Result<LiveBinding> {
    let live = specification
        .parameters
        .get("live_workspace")
        .and_then(Value::as_object)
        .context("isolated snapshot accepted run has no live workspace binding")?;
    let text = |key: &str| -> Result<String> {
        Ok(live
            .get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .with_context(|| format!("isolated snapshot live workspace has no {key}"))?
            .to_owned())
    };
    let session_id = text("session_id")?;
    let session_epoch = live
        .get("session_epoch")
        .and_then(Value::as_u64)
        .filter(|e| *e > 0)
        .context("isolated snapshot session epoch must be positive")?;
    let request_id = text("request_idempotency_key")?;
    let source_sha256 = text("startup_source_sha256")?;
    digest(&source_sha256)?;
    let command = live
        .get("command")
        .context("isolated snapshot has no immutable startup command")?;
    if live.get("scene_revision").and_then(Value::as_u64)
        != Some(specification.snapshot.definition_revision)
        || command.get("kind").and_then(Value::as_str) != Some("startup_script")
        || command.get("request_id").and_then(Value::as_str) != Some(request_id.as_str())
        || command.get("source_sha256").and_then(Value::as_str) != Some(source_sha256.as_str())
    {
        bail!("isolated snapshot immutable startup binding is inconsistent");
    }
    let policy = specification
        .parameters
        .get(fullmag_session::ACCEPTED_RUN_START_POLICY_KEY)
        .context("isolated snapshot run has no manual start policy")?;
    if policy.get("schema_version").and_then(Value::as_str) != Some("accepted_run_start_policy.v1")
        || policy.get("mode").and_then(Value::as_str) != Some("manual")
    {
        bail!("isolated snapshot selected run is not held by an explicit manual gate");
    }
    Ok(LiveBinding {
        session_id,
        session_epoch,
        request_id,
        source_sha256,
    })
}

fn validate_selected_files(store_root: &Path, pin: &RetainedHeldManualRunPin) -> Result<()> {
    let prefix = format!("runs/{}", pin.run_id);
    // Physical absence also rejects dangling links; a policy interpretation alone is insufficient.
    match fs::symlink_metadata(store_root.join(&prefix).join("start_release.json")) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        _ => {
            bail!("isolated snapshot selected run has a physical start release or unreadable gate")
        }
    }
    read(
        store_root,
        &format!("{prefix}/run_intent.json"),
        Some(&pin.run_intent_sha256),
    )?;
    read(
        store_root,
        &format!("{prefix}/run_catalog.json"),
        Some(&pin.run_catalog_sha256),
    )?;
    Ok(())
}

fn validate_store_binding(config_store_root: &Path, opened_store_root: &Path) -> Result<()> {
    if fs::canonicalize(config_store_root)
        .context("canonicalize isolated snapshot config store root")?
        != opened_store_root
    {
        bail!("isolated snapshot API store differs from the native-validated copied store");
    }
    Ok(())
}

fn load(store_root: &Path, control_root: &Path, start_sha: &str) -> Result<Loaded> {
    let authority = load_authority(control_root, start_sha)?;
    let store = SessionStore::open_existing(store_root)?;
    validate_store_binding(&authority.config_store_root, store.root())?;
    validate_selected_files(store.root(), &authority.selected)?;
    let run_id = RunId::parse(authority.selected.run_id.clone()).map_err(anyhow::Error::msg)?;
    let intent = store
        .read_run_intent(run_id.as_str())?
        .context("isolated snapshot selected RunIntent is missing")?;
    let project_id =
        crate::live_accepted_execution::accepted_project_id_from_intent(&intent, &run_id)?;
    let accepted =
        fullmag_runtime_control::load_accepted_study_snapshot(&store, &run_id, &project_id)?;
    let specification = accepted.run.specification.clone();
    if accepted.run.intent != intent
        || specification.run_id != run_id
        || specification.snapshot.project_id != project_id
    {
        bail!("isolated snapshot immutable accepted study identity differs");
    }
    let binding = validate_live_binding(&specification)?;
    let scene = scene_from_definition(&accepted.run.definition_bytes, &specification)?;
    if scene.revision != specification.snapshot.definition_revision {
        bail!("isolated snapshot accepted scene revision differs");
    }
    let catalog = store
        .read_run_catalog(run_id.as_str())?
        .context("isolated snapshot selected catalog is missing")?;
    if catalog.tasks.is_empty()
        || !catalog.tasks.iter().all(|task| {
            task.lifecycle == FmsTaskLifecycle::Accepted
                && matches!(&task.readiness, FmsTaskReadiness::Blocked { .. })
        })
        || store.accepted_run_start_permitted(run_id.as_str())?
    {
        bail!("isolated snapshot selected run is not fully held awaiting Compute");
    }
    let anchor = store
        .read_preparation_receipt(run_id.as_str())?
        .context("isolated snapshot accepted preparation anchor is missing")?;
    anchor.validate()?;
    let preparation: fullmag_application::PreparationReceipt =
        serde_json::from_value(anchor.payload.clone())?;
    preparation
        .validate()
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let source = preparation
        .accepted_run_source
        .as_ref()
        .context("isolated snapshot preparation has no accepted source")?;
    if source.run_id != run_id
        || !accepted.lowered.steps.iter().any(|step| {
            step.step_id == source.step_id
                && matches!(step.status, fullmag_plan::StudyStepLoweringStatus::Planned)
        })
        || !fullmag_runtime_control::accepted_run_step_is_scheduler_ready_from_snapshot(
            &store,
            &run_id,
            &source.step_id,
            &accepted,
        )?
    {
        bail!("isolated snapshot accepted preparation is not bound to a ready step");
    }
    let task_id = fullmag_session::task_id_for_study_step(run_id.as_str(), &source.step_id)?;
    // Typed accepted receipt loading revalidates plan/input fingerprints and native CAS evidence.
    accepted.read_task_preparation_receipt(&store, &task_id)?;
    let task = store
        .read_task_preparation_receipt(run_id.as_str(), &task_id)?
        .context("isolated snapshot task preparation is missing")?;
    let stage = store
        .read_accepted_stage_preparation_receipt(run_id.as_str(), &source.step_id)?
        .context("isolated snapshot stage preparation is missing")?;
    if task.preparation_id != anchor.preparation_id
        || task.plan_fingerprint != anchor.plan_fingerprint
        || task.payload != anchor.payload
        || !stage.matches_task_receipt(&task)
    {
        bail!("isolated snapshot preparation anchor differs from immutable task/stage evidence");
    }
    validate_selected_files(store.root(), &authority.selected)?;
    Ok(Loaded {
        authority,
        specification,
        scene,
        binding,
        total_steps: catalog.tasks.len(),
    })
}

fn metadata(loaded: &Loaded) -> Value {
    json!({
        "schema": START_SCHEMA,
        "run_id": loaded.authority.selected.run_id,
        "project_id": loaded.specification.snapshot.project_id.as_str(),
        "session_epoch": loaded.binding.session_epoch,
        "source_request_id": loaded.binding.request_id,
        "source_sha256": loaded.binding.source_sha256,
        "source_manifest_sha256": loaded.authority.start.source_manifest_sha256,
        "request_sha256": loaded.authority.start.request_sha256,
        "native_validation_sha256": loaded.authority.receipt_sha256,
        "allow_script_replay": false,
    })
}

/// Only the copied store's current-live projection is installed. No native owner,
/// run intent, scientific CAS object, start gate, task claim, or result is written.
pub(crate) async fn restore_before_listen(state: &Arc<AppState>) -> Result<()> {
    let path = std::env::var_os(START_ENV);
    let sha = std::env::var_os(SHA_ENV);
    if path.is_none() && sha.is_none() {
        return Ok(());
    }
    let path = path
        .context("isolated snapshot startup path is missing")?
        .into_string()
        .map_err(|_| anyhow::anyhow!("isolated snapshot startup path is not UTF-8"))?;
    let sha = sha
        .context("isolated snapshot startup SHA-256 is missing")?
        .into_string()
        .map_err(|_| anyhow::anyhow!("isolated snapshot SHA-256 is not UTF-8"))?;
    validate_transport(
        &path,
        &sha,
        CONFLICTING_ENV
            .iter()
            .any(|name| std::env::var_os(name).is_some()),
    )?;
    let store_root = state
        .submit_store_root
        .clone()
        .context("isolated snapshot requires an existing accepted store")?;
    let loaded =
        tokio::task::spawn_blocking(move || load(&store_root, Path::new(CONTROL_ROOT), &sha))
            .await??;
    let authority_metadata = metadata(&loaded);
    let snapshot = build_accepted_snapshot(
        &state.current_workspace_root,
        AcceptedSnapshotProjection {
            run_id: &loaded.specification.run_id,
            specification: &loaded.specification,
            scene: &loaded.scene,
            logical_session_id: &loaded.binding.session_id,
            total_steps: loaded.total_steps,
            terminal_outcome: None,
            preparation_failure: None,
            authority_metadata: json!({"isolated_snapshot_restore": authority_metadata.clone()}),
            accepted_plan_metadata: authority_metadata.clone(),
        },
    )?;
    {
        let _transition = state.current_live_session_transition.lock().await;
        if state.current_live_state.read().await.is_some()
            || state.current_live_session_epoch.load(Ordering::Acquire) != 0
        {
            bail!("isolated snapshot requires a fresh API workspace");
        }
        state
            .current_live_session_epoch
            .store(loaded.binding.session_epoch, Ordering::Release);
        *state.current_live_state.write().await = Some(snapshot);
    }
    let context = CurrentLiveRequestContext {
        session_id: loaded.binding.session_id.clone(),
        run_id: Some(loaded.specification.run_id.as_str().to_owned()),
        session_epoch: loaded.binding.session_epoch,
        request_scope_epoch: format!(
            "{}:{}",
            state.request_scope_instance_id, loaded.binding.session_epoch
        ),
    };
    crate::live_scene_preparation::publish_accepted_frontier_preparation(
        state,
        &context,
        "isolated_snapshot_restore",
    )
    .await
    .map_err(|error| anyhow::anyhow!("isolated snapshot preparation projection failed: {error}"))?;
    let mut current = state.current_live_state.write().await;
    let snapshot = current
        .as_mut()
        .context("isolated snapshot projection lost its live state")?;
    snapshot
        .metadata
        .get_or_insert_with(|| json!({}).into())
        .as_object_mut()
        .context("isolated snapshot projected metadata is not an object")?
        .insert("isolated_snapshot_restore".into(), authority_metadata);
    snapshot.state_version = snapshot.state_version.saturating_add(1);
    let restored_scene_revision = snapshot
        .scene_document
        .as_ref()
        .context("isolated snapshot projection lost its scene document")?
        .revision;
    drop(current);
    // Authority becomes usable only after all validation and exact receipt projection succeed.
    *state.accepted_run_reattach_identity.write().await = Some(AcceptedRunReattachIdentity {
        run_id: loaded.specification.run_id.as_str().to_owned(),
        session_id: loaded.binding.session_id,
        session_epoch: loaded.binding.session_epoch,
        scene_revision: restored_scene_revision,
        proof_sha256: loaded.authority.receipt_sha256,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_application::{
        ProjectId, ProjectSnapshot, RequestedExecution, StudyId, StudyReference,
    };

    fn write_json(root: &Path, name: &str, value: Value) -> String {
        let bytes = serde_json::to_vec(&value).unwrap();
        fs::write(root.join(name), &bytes).unwrap();
        fullmag_session::hex_sha256(&bytes)
    }

    fn authority_fixture(root: &Path, selected: &str) -> String {
        let source = write_json(
            root,
            "source-manifest.json",
            json!({"restore_run_id": selected}),
        );
        let config = write_json(
            root,
            "original-config.json",
            json!({"store_root":"/state/runs/session-store"}),
        );
        let copied = write_json(
            root,
            "copied-content.json",
            json!({"state":{},"user_data":{}}),
        );
        let request = write_json(
            root,
            "request.json",
            json!({
                "schema_version":REQUEST_SCHEMA,"request_id":"12345678-1234-4234-8234-123456789abc",
                "source_manifest_sha256":source,
                "retained_terminal_runs":[],
                "retained_held_manual_runs":[{"run_id":"run-held","run_intent_sha256":"a".repeat(64),
                    "run_catalog_sha256":"b".repeat(64),"start_release":"absent"}]
            }),
        );
        write_json(
            root,
            "native-validation.json",
            json!({
                "schema_version":RECEIPT_SCHEMA,"state":"validated-read-only",
                "request_sha256":request,"config_sha256":config,"source_manifest_sha256":source,
                "run_ids":["run-held"],"terminal_count":0,"held_count":1,
                "owner_changed":false,"compute_started":false
            }),
        );
        write_json(
            root,
            "start.json",
            json!({
                "schema":START_SCHEMA,"allow_script_replay":false,"request_sha256":request,
                "config_sha256":config,"source_manifest_sha256":source,
                "copied_content_sha256":copied,"restore_run_id":selected
            }),
        )
    }

    #[test]
    fn isolated_snapshot_authority_requires_exact_pins_and_native_receipt() {
        let root = tempfile::tempdir().unwrap();
        let sha = authority_fixture(root.path(), "run-held");
        assert_eq!(
            load_authority(root.path(), &sha).unwrap().selected.run_id,
            "run-held"
        );
        assert!(load_authority(root.path(), &"0".repeat(64)).is_err());
        fs::write(root.path().join("original-config.json"), b"{}").unwrap();
        assert!(load_authority(root.path(), &sha).is_err());
        let sha = authority_fixture(root.path(), "run-held");
        let mut receipt: Value =
            serde_json::from_slice(&fs::read(root.path().join("native-validation.json")).unwrap())
                .unwrap();
        receipt["compute_started"] = json!(true);
        write_json(root.path(), "native-validation.json", receipt);
        assert!(load_authority(root.path(), &sha).is_err());
    }

    #[test]
    fn isolated_snapshot_rejects_unpinned_run_and_other_startup_authorities() {
        let root = tempfile::tempdir().unwrap();
        let sha = authority_fixture(root.path(), "run-unpinned");
        assert!(load_authority(root.path(), &sha).is_err());
        // Pin source and meta consistently too: request membership is still mandatory.
        let mut meta: Value =
            serde_json::from_slice(&fs::read(root.path().join("start.json")).unwrap()).unwrap();
        meta["source_manifest_sha256"] = json!(write_json(
            root.path(),
            "source-manifest.json",
            json!({"restore_run_id":"run-unpinned"})
        ));
        let sha = write_json(root.path(), "start.json", meta);
        assert!(load_authority(root.path(), &sha).is_err());
        assert!(validate_transport(START_PATH, &"a".repeat(64), false).is_ok());
        assert!(validate_transport(START_PATH, &"a".repeat(64), true).is_err());
        assert!(validate_transport("/tmp/start.json", &"a".repeat(64), false).is_err());
        assert!(CONFLICTING_ENV.contains(&"FULLMAG_DEVELOPMENT_ACCEPTED_REATTACH_STDIN"));
        assert!(CONFLICTING_ENV.contains(&"FULLMAG_DEVELOPMENT_RESTORE_STDIN"));
        assert!(CONFLICTING_ENV.contains(&"FULLMAG_STARTUP_SCRIPT"));
    }

    #[test]
    fn isolated_snapshot_rejects_config_store_binding_mismatch() {
        let copied = tempfile::tempdir().unwrap();
        let original = tempfile::tempdir().unwrap();
        let canonical_copy = fs::canonicalize(copied.path()).unwrap();
        validate_store_binding(copied.path(), &canonical_copy).unwrap();
        assert!(validate_store_binding(original.path(), &canonical_copy).is_err());
        assert!(validate_store_binding(&copied.path().join("missing"), &canonical_copy).is_err());
    }

    #[test]
    fn isolated_snapshot_rejects_physical_release_and_raw_run_drift() {
        let root = tempfile::tempdir().unwrap();
        let run = root.path().join("runs/run-held");
        fs::create_dir_all(&run).unwrap();
        let intent = b"{\"immutable\":\"intent\"}";
        let catalog = b"{\"immutable\":\"catalog\"}";
        fs::write(run.join("run_intent.json"), intent).unwrap();
        fs::write(run.join("run_catalog.json"), catalog).unwrap();
        let pin = RetainedHeldManualRunPin {
            run_id:"run-held".into(),run_intent_sha256:fullmag_session::hex_sha256(intent),
            run_catalog_sha256:fullmag_session::hex_sha256(catalog),
            start_release:fullmag_session::runtime_service::retained_held_manual_runs::TypedExpectedAbsent::Absent,
        };
        validate_selected_files(root.path(), &pin).unwrap();
        fs::write(run.join("start_release.json"), b"{}").unwrap();
        assert!(validate_selected_files(root.path(), &pin).is_err());
        fs::remove_file(run.join("start_release.json")).unwrap();
        fs::write(run.join("run_catalog.json"), b"{}").unwrap();
        assert!(validate_selected_files(root.path(), &pin).is_err());
        assert_eq!(fs::read(run.join("run_intent.json")).unwrap(), intent);
    }

    fn specification() -> RunSpecification {
        let mut spec = RunSpecification::new(
            ProjectSnapshot {
                project_id: ProjectId::parse("project-held").unwrap(),
                definition_revision: 1,
                definition_sha256: "a".repeat(64),
            },
            StudyReference {
                study_id: StudyId::parse("study-held").unwrap(),
                plan_version: "study_plan.v1".into(),
                plan_sha256: "b".repeat(64),
            },
            "c".repeat(64),
            json!({
                "live_workspace":{"session_id":"session-held","session_epoch":4,"scene_revision":1,
                    "request_idempotency_key":"request-held","startup_source_sha256":"d".repeat(64),
                    "command":{"kind":"startup_script","request_id":"request-held","source_sha256":"d".repeat(64)}},
                "fullmag.accepted_run_start":{"schema_version":"accepted_run_start_policy.v1","mode":"manual"}
            }),
            RequestedExecution {
                backend: "fem".into(),
                device: "gpu".into(),
                precision: "double".into(),
                mode: "strict".into(),
                minimum_resources: None,
            },
        );
        spec.run_id = RunId::parse("run-held").unwrap();
        spec
    }

    #[test]
    fn isolated_snapshot_projects_held_identity_without_creating_durable_work() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("retained-run-sentinel"), b"unchanged").unwrap();
        let spec = specification();
        let binding = validate_live_binding(&spec).unwrap();
        let mut scene = SceneDocument::default();
        scene.revision = 1;
        let snapshot = build_accepted_snapshot(
            root.path(),
            AcceptedSnapshotProjection {
                run_id: &spec.run_id,
                specification: &spec,
                scene: &scene,
                logical_session_id: &binding.session_id,
                total_steps: 2,
                terminal_outcome: None,
                preparation_failure: None,
                authority_metadata: json!({"isolated_snapshot_restore":{"run_id":"run-held"}}),
                accepted_plan_metadata: json!({"run_id":"run-held"}),
            },
        )
        .unwrap();
        let run = snapshot.run.as_ref().unwrap();
        assert_eq!(run.run_id, "run-held");
        assert_eq!(run.session_id, "session-held");
        assert_eq!(run.status, "waiting_for_compute");
        assert_eq!(snapshot.session.status, "awaiting_command");
        assert_eq!(snapshot.session.requested_device, "gpu");
        assert_eq!(snapshot.scene_document.as_ref().unwrap().revision, 1);
        assert!(
            snapshot
                .metadata
                .as_ref()
                .unwrap()
                .get("accepted_run_reattach")
                .is_none()
        );
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
        assert_eq!(
            fs::read(root.path().join("retained-run-sentinel")).unwrap(),
            b"unchanged"
        );
        assert!(!root.path().join("runs").exists());
    }

    #[test]
    fn isolated_snapshot_rejects_nonmanual_or_inconsistent_immutable_binding() {
        let mut spec = specification();
        spec.parameters["live_workspace"]["command"]["request_id"] = json!("different");
        assert!(validate_live_binding(&spec).is_err());
        let mut spec = specification();
        spec.parameters[fullmag_session::ACCEPTED_RUN_START_POLICY_KEY]["mode"] = json!("auto");
        assert!(validate_live_binding(&spec).is_err());
    }
}
