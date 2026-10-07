//! Read-only validation for the cold development handoff commit boundary.
//!
//! This module proves that a staged capsule, its target bundle, and an
//! owner-bound cold-store fence still match the frozen API workspace. It does
//! not publish a commit, release a fence, or shut down the API.

use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

use anyhow::{bail, Context, Result};
use chrono::DateTime;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    router_v2::handlers::platform::{
        development_backend::DevelopmentBackendConfig, development_restart::RestartableWorkspace,
    },
    types::AppState,
};

const HANDOFF_V2_SCHEMA: &str = "fullmag.development-authoring-handoff.v2";
const EMPTY_HANDOFF_SCHEMA: &str = "fullmag.development-empty-workspace-handoff.v1";
const BUNDLE_SCHEMA: &str = "fullmag.native-runtime-bundle.v1";
const BUNDLE_ID_BYTES: usize = 32;
const MAX_SNAPSHOT_BYTES: usize = 64 * 1024 * 1024;
const MAX_BUNDLE_MANIFEST_BYTES: usize = 256 * 1024;
const MAX_BINARY_BYTES: usize = 256 * 1024 * 1024;
const MAX_BUNDLE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_ASSET_COUNT: usize = 512;
const MAX_VALIDATOR_REQUEST_BYTES: usize = MAX_SNAPSHOT_BYTES + 16 * 1024;
const MAX_VALIDATOR_ACK_BYTES: usize = 16 * 1024;
const VALIDATOR_REQUEST_SCHEMA: &str = "fullmag.development-cold-handoff-validation-request.v1";
const VALIDATOR_ACK_SCHEMA: &str = "fullmag.development-cold-handoff-validation-ack.v1";
const MAX_VALIDATOR_FILE_BYTES: usize = 256 * 1024 * 1024;
const WINDOWS_MSVC_TARGET: &str = "x86_64-pc-windows-msvc";

const BINARY_NAMES: [&str; 13] = [
    "fullmag.exe",
    "fullmag-api.exe",
    "fullmag-ui.exe",
    "fullmag-api-accepted-worker.exe",
    "fullmag-api-accepted-fem-preparer.exe",
    "fullmag-api-accepted-fem-preparation-supervisor.exe",
    "fullmag-api-accepted-fem-preparation-scheduler.exe",
    "fullmag-api-accepted-supervisor.exe",
    "fullmag-api-accepted-scheduler.exe",
    "fullmag-runtime-service.exe",
    "fullmag-api-resource-pool.exe",
    "fullmag-api-preparation-resource-pool.exe",
    "fullmag-api-preparation-retry.exe",
];

/// Owner-authenticated fields required to commit a staged cold handoff.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ColdCommitRequest {
    pub(crate) handoff_id: String,
    pub(crate) snapshot_sha256: String,
    pub(crate) target_build_id: String,
    pub(crate) candidate_bundle_id: String,
    pub(crate) candidate_manifest_sha256: String,
}

/// Validated inputs for the one-shot `SessionStore` commit operation.
pub(crate) struct ValidatedColdCommit {
    pub(crate) store: fullmag_session::SessionStore,
    pub(crate) fence: fullmag_session::store::DevelopmentAdmissionFence,
    pub(crate) accepted_store_binding: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ColdCompletionRequest {
    pub(crate) handoff_id: String,
    pub(crate) snapshot_sha256: String,
    pub(crate) target_build_id: String,
    pub(crate) candidate_bundle_id: String,
    pub(crate) candidate_manifest_sha256: String,
    pub(crate) commit_sha256: String,
}

pub(crate) struct ValidatedColdCompletion {
    pub(crate) store: fullmag_session::SessionStore,
    pub(crate) commit: fullmag_session::store::DevelopmentHandoffCommit,
    pub(crate) replacement: fullmag_session::store::DevelopmentReplacementIdentity,
}

/// The owner supplies this request only after waiting its exact old API child.
/// Disk metadata alone is not process-exit evidence. The new API independently
/// binds the capsule, actual running candidate, restored provenance and store.
pub(crate) fn validate_cold_completion(
    state: &AppState,
    workspace: &RestartableWorkspace,
    request: &ColdCompletionRequest,
    deadline: Instant,
) -> Result<ValidatedColdCompletion> {
    ensure_before_deadline(deadline, "cold completion validation")?;
    validate_uuid(&request.handoff_id, "completion handoff ID")?;
    for digest in [
        &request.snapshot_sha256,
        &request.target_build_id,
        &request.candidate_manifest_sha256,
        &request.commit_sha256,
    ] {
        validate_lower_hex(digest, 64, "completion digest")?;
    }
    validate_lower_hex(&request.candidate_bundle_id, 32, "completion candidate ID")?;
    if env::var_os("FULLMAG_RUNTIME_SERVICE_CONFIG").is_some() {
        bail!("cold completion is unavailable with a configured runtime service");
    }
    let DevelopmentBackendConfig::Managed {
        storage_root,
        worktree,
        current,
        ..
    } = &state.development_backend
    else {
        bail!("cold completion requires managed development identity");
    };
    let root = state
        .submit_store_root
        .as_deref()
        .context("completion store is not configured")?;
    if fullmag_runtime_control::accepted_store::writable_product_state_path(root).as_deref()
        != Some(root)
    {
        bail!("completion store is not an existing canonical path");
    }
    validate_managed_store_location(storage_root, worktree, root)?;
    let store = fullmag_session::SessionStore::open_existing(root.to_path_buf())?;
    require_cold_store(&store)?;
    let raw_commit = fullmag_session::repository_path::read_bounded_regular_file(
        root,
        "development/HANDOFF-COMMIT.json",
        16 * 1024,
    )?;
    if fullmag_session::hex_sha256(&raw_commit) != request.commit_sha256 {
        bail!("completion commit differs from the owner's exit-bound pin");
    }
    let commit = store
        .read_development_handoff_commit()?
        .context("completion commit is absent")?;
    if commit.handoff_id != request.handoff_id
        || commit.snapshot_sha256 != request.snapshot_sha256
        || commit.target_build_id != request.target_build_id
        || commit.api_instance_id == state.request_scope_instance_id
        || store.read_development_idle_fence()?.as_ref() != Some(&commit.fence)
    {
        bail!("completion commit and exact fence do not match replacement");
    }
    let snapshot_relative = format!(
        "runtimes/{worktree}/development-handoffs/{}/snapshot.json",
        request.handoff_id
    );
    let raw_snapshot = fullmag_session::repository_path::read_bounded_regular_file(
        storage_root,
        &snapshot_relative,
        MAX_SNAPSHOT_BYTES,
    )?;
    if fullmag_session::hex_sha256(&raw_snapshot) != request.snapshot_sha256 {
        bail!("completion capsule differs from accepted snapshot");
    }
    let snapshot: HandoffSnapshot = serde_json::from_slice(&raw_snapshot)?;
    let (session_id, epoch, scene) = match workspace {
        RestartableWorkspace::NoSession {
            api_instance_id,
            session_epoch,
        } if api_instance_id == &state.request_scope_instance_id
            && *session_epoch == 0
            && snapshot.binding.session_id.is_none() =>
        {
            (None, 0, Value::Null)
        }
        RestartableWorkspace::Session {
            identity,
            scene_document,
        } => {
            let old_session = snapshot
                .binding
                .session_id
                .as_ref()
                .context("session completion capsule is empty")?;
            if identity.api_instance_id != state.request_scope_instance_id
                || identity.session_epoch != 1
                || &identity.session_id == old_session
                || identity.run_id.is_some()
                || !state
                    .development_restored_authoring
                    .get()
                    .is_some_and(|provenance| {
                        provenance.matches(
                            &identity.api_instance_id,
                            &identity.session_id,
                            &identity.scene_id,
                            identity.session_epoch,
                        )
                    })
            {
                bail!("completion workspace is not the fresh privately restored authoring session");
            }
            (
                Some(identity.session_id.clone()),
                1,
                serde_json::to_value(scene_document)?,
            )
        }
        _ => bail!("completion workspace state differs from accepted capsule"),
    };
    if snapshot.binding.api_instance_id != commit.api_instance_id
        || snapshot.binding.target_build_id != commit.target_build_id
    {
        bail!("completion capsule does not identify the committed old API and target");
    }
    let expected = ExpectedWorkspaceBinding {
        state: if session_id.is_some() {
            "session"
        } else {
            "no_session"
        },
        api_instance_id: commit.api_instance_id.clone(),
        session_id: snapshot.binding.session_id.clone(),
        session_epoch: snapshot.binding.session_epoch,
        generation_id: snapshot.binding.generation_id.clone(),
        source_build_id: snapshot.binding.source_build_id.clone(),
        source_sha256: snapshot.binding.source_sha256.clone(),
        target_build_id: commit.target_build_id.clone(),
        scene: scene.clone(),
    };
    let capsule_request = ColdCommitRequest {
        handoff_id: request.handoff_id.clone(),
        snapshot_sha256: request.snapshot_sha256.clone(),
        target_build_id: request.target_build_id.clone(),
        candidate_bundle_id: request.candidate_bundle_id.clone(),
        candidate_manifest_sha256: request.candidate_manifest_sha256.clone(),
    };
    validate_snapshot(&snapshot, &expected, &capsule_request, None)?;
    validate_capsule_semantics(
        state,
        storage_root,
        worktree,
        &snapshot.binding,
        &capsule_request,
        snapshot.assets.len(),
        Some(&scene),
        deadline,
    )?;
    validate_candidate_bundle(
        storage_root,
        worktree,
        &request.candidate_bundle_id,
        &request.target_build_id,
        &request.candidate_manifest_sha256,
        deadline,
    )?;
    let manifest_relative = format!(
        "runtimes/{worktree}/native-bundles/{}/manifest.json",
        request.candidate_bundle_id
    );
    let raw_manifest = fullmag_session::repository_path::read_bounded_regular_file(
        storage_root,
        &manifest_relative,
        MAX_BUNDLE_MANIFEST_BYTES,
    )?;
    if fullmag_session::hex_sha256(&raw_manifest) != request.candidate_manifest_sha256 {
        bail!("completion candidate manifest changed during validation");
    }
    let manifest: RuntimeBundleManifest = serde_json::from_slice(&raw_manifest)?;
    let build = fullmag_build_info::identity();
    if manifest.source.git_commit != build.git_commit
        || manifest.source.source_snapshot_sha256 != build.source_snapshot_sha256
        || manifest.source.backend_source_sha256 != current.source_sha256
        || manifest
            .source
            .build_version
            .get("product_version")
            .and_then(Value::as_str)
            != Some(current.id.as_str())
        || current.id != fullmag_build_info::version()
    {
        bail!("completion candidate does not identify the actual running build");
    }
    let expected_api = fullmag_session::repository_path::checked_path(
        storage_root,
        &format!(
            "runtimes/{worktree}/native-bundles/{}/bin/fullmag-api.exe",
            request.candidate_bundle_id
        ),
    )?;
    if fs::canonicalize(env::current_exe()?)? != fs::canonicalize(expected_api)? {
        bail!("completion API was not launched from the requested sealed candidate");
    }
    if store.read_development_handoff_commit()?.as_ref() != Some(&commit)
        || store.read_development_idle_fence()?.as_ref() != Some(&commit.fence)
        || fullmag_session::repository_path::read_bounded_regular_file(
            root,
            "development/HANDOFF-COMMIT.json",
            16 * 1024,
        )? != raw_commit
    {
        bail!("completion store markers changed during validation");
    }
    ensure_before_deadline(deadline, "cold completion validation")?;
    let replacement = fullmag_session::store::DevelopmentReplacementIdentity {
        api_instance_id: state.request_scope_instance_id.clone(),
        session_id,
        session_epoch: epoch,
        scene_document_sha256: fullmag_session::canonical_json_sha256(&scene),
        target_build_id: commit.target_build_id.clone(),
        accepted_store_binding: commit.accepted_store_binding.clone(),
    };
    Ok(ValidatedColdCompletion {
        store,
        commit,
        replacement,
    })
}

pub(crate) fn validate_cold_commit(
    state: &AppState,
    workspace: &RestartableWorkspace,
    nonce: &str,
    owner_token: &str,
    request: &ColdCommitRequest,
    deadline: Instant,
) -> Result<ValidatedColdCommit> {
    ensure_before_deadline(deadline, "cold handoff validation")?;
    validate_uuid(nonce, "acquisition nonce")?;
    validate_lower_hex(owner_token, 32, "owner token")?;
    validate_uuid(&request.handoff_id, "handoff ID")?;
    validate_lower_hex(&request.snapshot_sha256, 64, "snapshot SHA-256")?;
    validate_lower_hex(&request.target_build_id, 64, "target build ID")?;
    validate_lower_hex(
        &request.candidate_bundle_id,
        BUNDLE_ID_BYTES,
        "candidate bundle ID",
    )?;
    validate_lower_hex(
        &request.candidate_manifest_sha256,
        64,
        "candidate bundle manifest SHA-256",
    )?;

    if env::var_os("FULLMAG_RUNTIME_SERVICE_CONFIG").is_some() {
        bail!("cold handoff is unavailable while a runtime service is configured");
    }

    let DevelopmentBackendConfig::Managed {
        storage_root,
        worktree,
        generation,
        current,
        ..
    } = &state.development_backend
    else {
        bail!("cold handoff requires frozen managed development identity");
    };
    if fullmag_runtime_control::accepted_store::writable_product_state_path(storage_root).as_ref()
        != Some(storage_root)
    {
        bail!("frozen development storage root is no longer canonical");
    }
    fullmag_session::repository_path::validate_store_id(worktree)
        .context("invalid frozen development worktree ID")?;
    validate_uuid_spelling(generation, "development generation ID")?;
    validate_bounded_text(&current.id, "current source build ID")?;
    validate_lower_hex(&current.source_sha256, 64, "current source SHA-256")?;
    validate_uuid(&state.request_scope_instance_id, "API instance ID")?;

    let expected = expected_workspace_binding(
        &state.request_scope_instance_id,
        workspace,
        generation,
        &current.id,
        &current.source_sha256,
        &request.target_build_id,
    )
    .context("cold_commit_phase:workspace_binding")?;

    let store_root = state
        .submit_store_root
        .as_deref()
        .context("accepted store is not configured")?;
    if fullmag_runtime_control::accepted_store::writable_product_state_path(store_root).as_deref()
        != Some(store_root)
    {
        bail!("accepted store is not an existing canonical path");
    }
    validate_managed_store_location(storage_root, worktree, store_root)
        .context("cold_commit_phase:store_location")?;
    let accepted_store_binding = fullmag_runtime_control::accepted_store::store_binding(store_root)
        .context("accepted store binding is unavailable")?;
    validate_lower_hex(&accepted_store_binding, 64, "accepted-store binding")?;

    let store = fullmag_session::SessionStore::open_existing(store_root.to_path_buf())
        .context("opening existing accepted store")?;
    if store.root() != store_root {
        bail!("accepted store changed during validation");
    }
    require_cold_store(&store).context("cold_commit_phase:store_admission")?;
    let fence = store
        .read_development_idle_fence()?
        .context("cold handoff admission fence is absent")?;
    if fence.owner_token != owner_token || fence.nonce != nonce {
        bail!("cold handoff admission fence belongs to another acquisition");
    }
    if store.read_development_handoff_commit()?.is_some() {
        bail!("accepted store already contains a development handoff commit");
    }
    ensure_before_deadline(deadline, "cold store and fence validation")?;

    let snapshot_relative = format!(
        "runtimes/{worktree}/development-handoffs/{}/snapshot.json",
        request.handoff_id
    );
    let snapshot_bytes = fullmag_session::repository_path::read_bounded_regular_file(
        storage_root,
        &snapshot_relative,
        MAX_SNAPSHOT_BYTES,
    )
    .context("reading bounded staged handoff snapshot")?;
    ensure_before_deadline(deadline, "staged handoff snapshot read")?;
    let snapshot_sha256 = fullmag_session::hex_sha256(&snapshot_bytes);
    if snapshot_sha256 != request.snapshot_sha256 {
        bail!("staged handoff snapshot digest differs from the commit request");
    }
    ensure_before_deadline(deadline, "staged handoff snapshot digest")?;
    let snapshot: HandoffSnapshot =
        serde_json::from_slice(&snapshot_bytes).context("parsing strict handoff snapshot")?;
    validate_snapshot(&snapshot, &expected, request, Some(&expected.scene))
        .context("cold_commit_phase:snapshot_binding")?;
    let expected_binding = handoff_binding(&expected);
    validate_capsule_semantics(
        state,
        storage_root,
        worktree,
        &expected_binding,
        request,
        snapshot.assets.len(),
        None,
        deadline,
    )
    .context("cold_commit_phase:capsule_semantics")?;

    ensure_before_deadline(deadline, "candidate bundle validation")?;
    validate_candidate_bundle(
        storage_root,
        worktree,
        &request.candidate_bundle_id,
        &request.target_build_id,
        &request.candidate_manifest_sha256,
        deadline,
    )
    .context("cold_commit_phase:candidate_bundle")?;
    ensure_before_deadline(deadline, "cold handoff validation")?;

    Ok(ValidatedColdCommit {
        store,
        fence,
        accepted_store_binding,
    })
}

struct ExpectedWorkspaceBinding {
    state: &'static str,
    api_instance_id: String,
    session_id: Option<String>,
    session_epoch: u64,
    generation_id: String,
    source_build_id: String,
    source_sha256: String,
    target_build_id: String,
    scene: Value,
}

fn expected_workspace_binding(
    api_instance_id: &str,
    workspace: &RestartableWorkspace,
    generation_id: &str,
    source_build_id: &str,
    source_sha256: &str,
    target_build_id: &str,
) -> Result<ExpectedWorkspaceBinding> {
    let (state, workspace_api_id, session_id, session_epoch, scene) = match workspace {
        RestartableWorkspace::NoSession {
            api_instance_id,
            session_epoch,
        } => (
            "no_session",
            api_instance_id.as_str(),
            None,
            *session_epoch,
            Value::Null,
        ),
        RestartableWorkspace::Session {
            identity,
            scene_document,
        } => (
            "session",
            identity.api_instance_id.as_str(),
            Some(identity.session_id.clone()),
            identity.session_epoch,
            serde_json::to_value(scene_document).context("encoding captured SceneDocument")?,
        ),
    };
    if workspace_api_id != api_instance_id {
        bail!("captured workspace belongs to another API instance");
    }
    if let Some(session_id) = session_id.as_deref() {
        validate_session_id(session_id)?;
    }
    validate_uuid_spelling(generation_id, "development generation ID")?;
    validate_bounded_text(source_build_id, "current source build ID")?;
    validate_lower_hex(source_sha256, 64, "current source SHA-256")?;
    validate_lower_hex(target_build_id, 64, "target build ID")?;
    Ok(ExpectedWorkspaceBinding {
        state,
        api_instance_id: api_instance_id.to_owned(),
        session_id,
        session_epoch,
        generation_id: generation_id.to_owned(),
        source_build_id: source_build_id.to_owned(),
        source_sha256: source_sha256.to_owned(),
        target_build_id: target_build_id.to_owned(),
        scene,
    })
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct HandoffBinding {
    api_instance_id: String,
    #[serde(deserialize_with = "deserialize_present_option")]
    session_id: Option<String>,
    session_epoch: u64,
    generation_id: String,
    source_build_id: String,
    source_sha256: String,
    target_build_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)] // The unused payload sections must still be present and typed.
struct HandoffPayload {
    scene: Value,
    editor: Value,
    workspace: Value,
    project_document: Value,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct HandoffSnapshot {
    schema: String,
    snapshot_id: String,
    binding: HandoffBinding,
    payload: HandoffPayload,
    component_sha256: BTreeMap<String, String>,
    payload_sha256: String,
    assets: Vec<Value>,
}

fn validate_snapshot(
    snapshot: &HandoffSnapshot,
    expected: &ExpectedWorkspaceBinding,
    request: &ColdCommitRequest,
    expected_source_scene: Option<&Value>,
) -> Result<()> {
    let expected_schema = if expected.state == "no_session" {
        EMPTY_HANDOFF_SCHEMA
    } else {
        HANDOFF_V2_SCHEMA
    };
    if snapshot.schema != expected_schema || snapshot.snapshot_id != request.handoff_id {
        bail!("staged handoff schema or identity differs from the acquired workspace");
    }
    validate_uuid(&snapshot.snapshot_id, "snapshot ID")?;
    let binding = &snapshot.binding;
    validate_uuid(&binding.api_instance_id, "snapshot API instance ID")?;
    validate_uuid_spelling(&binding.generation_id, "snapshot generation ID")?;
    validate_bounded_text(&binding.source_build_id, "snapshot source build ID")?;
    validate_lower_hex(&binding.source_sha256, 64, "snapshot source SHA-256")?;
    validate_lower_hex(&binding.target_build_id, 64, "snapshot target build ID")?;
    if binding.api_instance_id != expected.api_instance_id
        || binding.session_id != expected.session_id
        || binding.session_epoch != expected.session_epoch
        || binding.generation_id != expected.generation_id
        || binding.source_build_id != expected.source_build_id
        || binding.source_sha256 != expected.source_sha256
        || binding.target_build_id != expected.target_build_id
    {
        bail!("staged handoff binding differs from the frozen API workspace");
    }
    if expected_source_scene.is_some_and(|scene| &snapshot.payload.scene != scene) {
        bail!("staged handoff source scene differs from the captured authoring scene");
    }
    validate_lower_hex(&snapshot.payload_sha256, 64, "payload SHA-256")?;
    validate_exact_hash_fields(&snapshot.component_sha256)?;
    if snapshot.assets.len() > MAX_ASSET_COUNT {
        bail!("staged handoff asset list exceeds its entry limit");
    }
    if expected.state == "no_session" && !snapshot.assets.is_empty() {
        bail!("empty-workspace handoff contains assets");
    }
    Ok(())
}

fn handoff_binding(expected: &ExpectedWorkspaceBinding) -> HandoffBinding {
    HandoffBinding {
        api_instance_id: expected.api_instance_id.clone(),
        session_id: expected.session_id.clone(),
        session_epoch: expected.session_epoch,
        generation_id: expected.generation_id.clone(),
        source_build_id: expected.source_build_id.clone(),
        source_sha256: expected.source_sha256.clone(),
        target_build_id: expected.target_build_id.clone(),
    }
}

#[derive(Serialize)]
struct SemanticValidationRequest<'a> {
    schema: &'static str,
    storage_root: &'a str,
    worktree_id: &'a str,
    handoff_id: &'a str,
    snapshot_sha256: &'a str,
    binding: &'a HandoffBinding,
    verify_restored_scene: bool,
    restored_scene: Option<&'a Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SemanticValidationAck {
    schema: String,
    storage_root: String,
    worktree_id: String,
    handoff_id: String,
    snapshot_sha256: String,
    binding: HandoffBinding,
    asset_count: usize,
    restored_scene_matches: bool,
}

fn validate_capsule_semantics(
    state: &AppState,
    storage_root: &Path,
    worktree: &str,
    binding: &HandoffBinding,
    request: &ColdCommitRequest,
    asset_count: usize,
    restored_scene: Option<&Value>,
    deadline: Instant,
) -> Result<()> {
    ensure_before_deadline(deadline, "semantic capsule validator startup")?;
    if env::var("FULLMAG_NATIVE_RUNTIME_ACTIVE").ok().as_deref() != Some("1")
        || env::var("FULLMAG_STORAGE_PROFILE").ok().as_deref() != Some("windows-native-fdm-cpu-dev")
    {
        bail!("semantic capsule validator requires the managed native development profile");
    }

    let repo_root = canonical_trusted_directory(&state.repo_root, "API repository root")?;
    let helper = fullmag_session::repository_path::checked_path(
        &repo_root,
        "scripts/windows/validate_commit_handoff.py",
    )
    .context("resolving trusted cold handoff validator")?;
    validate_regular_file_no_reparse(&helper, "trusted cold handoff validator")?;
    let helper =
        fs::canonicalize(helper).context("canonicalizing trusted cold handoff validator")?;

    let python_relative =
        format!("builds/{worktree}/windows-native-fdm-cpu-dev/python/fullmag/Scripts/python.exe");
    let expected_python =
        fullmag_session::repository_path::checked_path(storage_root, &python_relative)
            .context("resolving managed development Python")?;
    validate_regular_file_no_reparse(&expected_python, "managed development Python")?;
    let configured_python = env::var_os("FULLMAG_PYTHON")
        .map(PathBuf::from)
        .context("managed development Python is not configured")?;
    validate_absolute_regular_chain(&configured_python, "configured development Python")?;
    let expected_python =
        fs::canonicalize(expected_python).context("canonicalizing managed development Python")?;
    let configured_python = fs::canonicalize(configured_python)
        .context("canonicalizing configured development Python")?;
    if expected_python != configured_python {
        bail!("FULLMAG_PYTHON does not identify this worktree's managed development Python");
    }
    ensure_before_deadline(deadline, "semantic capsule validator launch")?;

    let storage_text = storage_root
        .to_str()
        .context("managed storage root is not valid UTF-8")?;
    let request_value = SemanticValidationRequest {
        schema: VALIDATOR_REQUEST_SCHEMA,
        storage_root: storage_text,
        worktree_id: worktree,
        handoff_id: &request.handoff_id,
        snapshot_sha256: &request.snapshot_sha256,
        binding,
        verify_restored_scene: restored_scene.is_some(),
        restored_scene,
    };
    let request_bytes = serde_json::to_vec(&request_value)
        .context("encoding semantic capsule validation request")?;
    if request_bytes.len() > MAX_VALIDATOR_REQUEST_BYTES {
        bail!("semantic capsule validation request exceeds its limit");
    }
    let output = run_semantic_validator(
        &configured_python,
        &helper,
        &repo_root,
        request_bytes,
        deadline,
    )?;
    ensure_before_deadline(deadline, "semantic capsule validation response")?;
    let ack: SemanticValidationAck =
        serde_json::from_slice(&output).context("parsing semantic capsule validation ACK")?;
    if ack.schema != VALIDATOR_ACK_SCHEMA
        || ack.worktree_id != worktree
        || ack.handoff_id != request.handoff_id
        || ack.snapshot_sha256 != request.snapshot_sha256
        || ack.binding != *binding
        || ack.asset_count != asset_count
        || ack.restored_scene_matches != restored_scene.is_some()
    {
        bail!("semantic capsule validation ACK differs from the frozen request");
    }
    let ack_storage = PathBuf::from(&ack.storage_root);
    validate_absolute_directory_chain(&ack_storage, "semantic ACK storage root")?;
    if fs::canonicalize(ack_storage)? != fs::canonicalize(storage_root)? {
        bail!("semantic capsule validation ACK names another storage root");
    }
    Ok(())
}

pub(crate) fn cold_commit_failure_stage(error: &anyhow::Error) -> &'static str {
    // Emit only source-owned labels. Never return the underlying error text.
    let mut stage = "validate_cold_commit";
    for cause in error.chain() {
        stage = match cause.to_string().as_str() {
            "cold_commit_phase:workspace_binding" => "workspace_binding",
            "cold_commit_phase:store_location" => "store_location",
            "cold_commit_phase:store_admission" => "store_admission",
            "cold_commit_phase:snapshot_binding" => "snapshot_binding",
            "cold_commit_phase:capsule_semantics" => "capsule_semantics",
            "cold_commit_phase:candidate_bundle" => "candidate_bundle",
            "cold_commit_phase:deadline" => "validation_deadline",
            _ => stage,
        };
    }
    stage
}

fn ensure_before_deadline(deadline: Instant, operation: &str) -> Result<()> {
    if Instant::now() >= deadline {
        return Err(anyhow::anyhow!(
            "absolute cold handoff deadline expired during {operation}"
        ))
        .context("cold_commit_phase:deadline");
    }
    Ok(())
}

enum ValidatorEvent {
    InputWritten(bool),
    OutputRead(std::result::Result<Vec<u8>, ()>),
}

fn run_semantic_validator(
    python: &Path,
    helper: &Path,
    repo_root: &Path,
    request: Vec<u8>,
    deadline: Instant,
) -> Result<Vec<u8>> {
    ensure_before_deadline(deadline, "semantic capsule validator launch")?;
    let mut command = Command::new(python);
    command
        .arg("-B")
        .arg(helper)
        .arg("--repo-root")
        .arg(repo_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env_remove("FULLMAG_DEVELOPMENT_OWNER_TOKEN");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .context("starting managed semantic capsule validator")?;
    if child.id() == 0 {
        let _ = kill_and_wait_validator(&mut child);
        bail!("semantic capsule validator has an invalid process identity");
    }
    let Some(stdin) = child.stdin.take() else {
        let _ = kill_and_wait_validator(&mut child);
        bail!("semantic capsule validator stdin is unavailable");
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = kill_and_wait_validator(&mut child);
        bail!("semantic capsule validator stdout is unavailable");
    };

    let (sender, receiver) = mpsc::channel();
    let writer_sender = sender.clone();
    let writer = match thread::Builder::new()
        .name("cold-handoff-validator-stdin".to_owned())
        .spawn(move || {
            let mut stdin = stdin;
            let success = stdin.write_all(&request).is_ok() && stdin.flush().is_ok();
            drop(stdin);
            let _ = writer_sender.send(ValidatorEvent::InputWritten(success));
        }) {
        Ok(thread) => thread,
        Err(_) => {
            let _ = kill_and_wait_validator(&mut child);
            bail!("starting semantic capsule validator input transport failed");
        }
    };
    let reader_sender = sender.clone();
    let reader = match thread::Builder::new()
        .name("cold-handoff-validator-stdout".to_owned())
        .spawn(move || {
            let output = read_bounded_validator_output(stdout);
            let _ = reader_sender.send(ValidatorEvent::OutputRead(output));
        }) {
        Ok(thread) => thread,
        Err(_) => {
            let _ = kill_and_wait_validator(&mut child);
            let _ = writer.join();
            bail!("starting semantic capsule validator output transport failed");
        }
    };
    drop(sender);

    let mut input_written = None;
    let mut output = None;
    let mut failure = None;
    loop {
        while let Ok(event) = receiver.try_recv() {
            if let Err(error) = record_validator_event(event, &mut input_written, &mut output) {
                failure = Some(error);
                break;
            }
        }
        if failure.is_some() {
            break;
        }
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {}
            Err(_) => {
                failure = Some("cannot observe semantic capsule validator process");
                break;
            }
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            failure = Some("semantic capsule validator exceeded the acquisition deadline");
            break;
        }
        match receiver.recv_timeout(remaining.min(Duration::from_millis(20))) {
            Ok(event) => {
                if let Err(error) = record_validator_event(event, &mut input_written, &mut output) {
                    failure = Some(error);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                if input_written != Some(true) || output.is_none() {
                    failure = Some("semantic capsule validator transport closed unexpectedly");
                } else {
                    thread::sleep(remaining.min(Duration::from_millis(10)));
                }
            }
        }
    }
    if failure.is_some() {
        let _ = child.kill();
    }
    let exit_status = child
        .wait()
        .context("waiting for semantic capsule validator exit")?;
    let writer_result = writer.join();
    let reader_result = reader.join();
    if writer_result.is_err() || reader_result.is_err() {
        failure = Some("semantic capsule validator transport panicked");
    }
    while let Ok(event) = receiver.try_recv() {
        if let Err(error) = record_validator_event(event, &mut input_written, &mut output) {
            failure = Some(error);
        }
    }
    if let Some(error) = failure {
        bail!(error);
    }
    if !exit_status.success() {
        bail!("semantic capsule validator failed");
    }
    if input_written != Some(true) {
        bail!("semantic capsule validator did not receive the complete request");
    }
    output.context("semantic capsule validator returned no ACK")
}

fn read_bounded_validator_output(stdout: impl Read) -> std::result::Result<Vec<u8>, ()> {
    let mut output = Vec::new();
    stdout
        .take((MAX_VALIDATOR_ACK_BYTES + 1) as u64)
        .read_to_end(&mut output)
        .map_err(|_| ())?;
    if output.len() > MAX_VALIDATOR_ACK_BYTES {
        return Err(());
    }
    Ok(output)
}

fn record_validator_event(
    event: ValidatorEvent,
    input_written: &mut Option<bool>,
    output: &mut Option<Vec<u8>>,
) -> std::result::Result<(), &'static str> {
    match event {
        ValidatorEvent::InputWritten(value) => {
            if input_written.replace(value).is_some() || !value {
                return Err("semantic capsule validator request transport failed");
            }
        }
        ValidatorEvent::OutputRead(Ok(bytes)) => {
            if output.replace(bytes).is_some() {
                return Err("semantic capsule validator produced duplicate output");
            }
        }
        ValidatorEvent::OutputRead(Err(())) => {
            return Err("semantic capsule validator output exceeded its limit or failed");
        }
    }
    Ok(())
}

fn kill_and_wait_validator(child: &mut Child) -> Result<ExitStatus> {
    if !matches!(child.try_wait(), Ok(Some(_))) {
        // An observation error does not prove exit. Still attempt cleanup of
        // this exact child and always perform its terminal wait.
        let _ = child.kill();
    }
    child
        .wait()
        .context("waiting for semantic capsule validator process")
}

fn canonical_trusted_directory(path: &Path, operation: &str) -> Result<PathBuf> {
    validate_absolute_directory_chain(path, operation)?;
    fs::canonicalize(path).with_context(|| format!("canonicalizing {operation}"))
}

fn validate_absolute_regular_chain(path: &Path, operation: &str) -> Result<()> {
    validate_absolute_path_chain(path, false, operation)
}

fn validate_absolute_directory_chain(path: &Path, operation: &str) -> Result<()> {
    validate_absolute_path_chain(path, true, operation)
}

fn validate_absolute_path_chain(path: &Path, directory_leaf: bool, operation: &str) -> Result<()> {
    if !path.is_absolute() {
        bail!("{operation} must be an absolute path");
    }
    let components = path.ancestors().collect::<Vec<_>>();
    for (index, component) in components.iter().rev().enumerate() {
        let metadata = fs::symlink_metadata(component)
            .with_context(|| format!("inspecting {operation} path component"))?;
        #[cfg(windows)]
        let reparse = {
            use std::os::windows::fs::MetadataExt;
            metadata.file_attributes() & 0x400 != 0
        };
        #[cfg(not(windows))]
        let reparse = false;
        if metadata.file_type().is_symlink() || reparse {
            bail!("{operation} path contains a link or reparse point");
        }
        let is_leaf = index + 1 == components.len();
        if is_leaf {
            if (directory_leaf && !metadata.is_dir()) || (!directory_leaf && !metadata.is_file()) {
                bail!("{operation} has the wrong filesystem type");
            }
        } else if !metadata.is_dir() {
            bail!("{operation} path ancestor is not a directory");
        }
    }
    Ok(())
}

fn validate_regular_file_no_reparse(path: &Path, operation: &str) -> Result<()> {
    let metadata = fs::symlink_metadata(path).with_context(|| format!("inspecting {operation}"))?;
    #[cfg(windows)]
    let reparse = {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    };
    #[cfg(not(windows))]
    let reparse = false;
    if !metadata.is_file() || metadata.file_type().is_symlink() || reparse {
        bail!("{operation} must be a regular non-reparse file");
    }
    Ok(())
}

fn validate_exact_hash_fields(values: &BTreeMap<String, String>) -> Result<()> {
    let expected = BTreeSet::from([
        "editor".to_owned(),
        "project_document".to_owned(),
        "scene".to_owned(),
        "workspace".to_owned(),
    ]);
    if values.keys().cloned().collect::<BTreeSet<_>>() != expected {
        bail!("staged handoff component hash fields are incomplete or unknown");
    }
    for digest in values.values() {
        validate_lower_hex(digest, 64, "component SHA-256")?;
    }
    Ok(())
}

fn validate_candidate_bundle(
    storage_root: &Path,
    worktree: &str,
    candidate_bundle_id: &str,
    target_build_id: &str,
    expected_manifest_sha256: &str,
    deadline: Instant,
) -> Result<()> {
    ensure_before_deadline(deadline, "candidate bundle inspection")?;
    let bundle_relative = format!("runtimes/{worktree}/native-bundles/{candidate_bundle_id}");
    ensure_real_directory(storage_root, &bundle_relative)?;
    if directory_entries(storage_root, &bundle_relative)?
        != BTreeSet::from(["bin".to_owned(), "manifest.json".to_owned()])
    {
        bail!("candidate runtime bundle has unexpected or missing entries");
    }
    let manifest_relative = format!("{bundle_relative}/manifest.json");
    let manifest_bytes = fullmag_session::repository_path::read_bounded_regular_file(
        storage_root,
        &manifest_relative,
        MAX_BUNDLE_MANIFEST_BYTES,
    )
    .context("reading bounded candidate bundle manifest")?;
    ensure_before_deadline(deadline, "candidate bundle manifest read")?;
    if fullmag_session::hex_sha256(&manifest_bytes) != expected_manifest_sha256 {
        bail!("candidate bundle manifest digest differs from the staged request");
    }
    ensure_before_deadline(deadline, "candidate bundle manifest digest")?;
    let manifest: RuntimeBundleManifest = serde_json::from_slice(&manifest_bytes)
        .context("parsing strict candidate bundle manifest")?;
    validate_bundle_manifest(&manifest, candidate_bundle_id, target_build_id, worktree)?;

    let bin_relative = format!("{bundle_relative}/bin");
    ensure_real_directory(storage_root, &bin_relative)?;
    let expected_entries = BINARY_NAMES
        .iter()
        .map(|name| (*name).to_owned())
        .collect::<BTreeSet<_>>();
    if directory_entries(storage_root, &bin_relative)? != expected_entries {
        bail!("candidate bundle executable directory differs from the fixed allowlist");
    }

    let mut total_bytes = 0_u64;
    for (name, record) in BINARY_NAMES.iter().zip(&manifest.binaries) {
        ensure_before_deadline(deadline, "candidate executable read")?;
        let relative = format!("{bin_relative}/{name}");
        let bytes = fullmag_session::repository_path::read_bounded_regular_file(
            storage_root,
            &relative,
            MAX_BINARY_BYTES,
        )
        .with_context(|| format!("reading candidate executable {name}"))?;
        ensure_before_deadline(deadline, "candidate executable read")?;
        if bytes.is_empty()
            || bytes.len() as u64 != record.size_bytes
            || fullmag_session::hex_sha256(&bytes) != record.sha256
        {
            bail!("candidate executable bytes differ from the bundle manifest: {name}");
        }
        ensure_before_deadline(deadline, "candidate executable digest")?;
        total_bytes = total_bytes
            .checked_add(bytes.len() as u64)
            .context("candidate bundle byte total overflow")?;
        if total_bytes > MAX_BUNDLE_BYTES {
            bail!("candidate bundle executables exceed their total byte budget");
        }
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeBundleManifest {
    schema: String,
    schema_version: u64,
    bundle_id: String,
    created_at_utc: String,
    profile: String,
    compiler_profile: String,
    qualification: String,
    source: RuntimeBundleSource,
    binaries: Vec<RuntimeBundleBinary>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)] // Parse unused publisher metadata to keep the schema closed.
struct RuntimeBundleSource {
    manifest_path: String,
    manifest_sha256: String,
    git_commit: String,
    source_snapshot_sha256: String,
    backend_source_sha256: String,
    #[serde(deserialize_with = "deserialize_present_option")]
    dependency_source_sha256: Option<String>,
    workspace_namespace: String,
    #[serde(deserialize_with = "deserialize_present_option")]
    worktree_state: Option<String>,
    #[serde(deserialize_with = "deserialize_present_option")]
    source_identity_check: Option<String>,
    #[serde(deserialize_with = "deserialize_present_option")]
    source_commit_after: Option<String>,
    #[serde(deserialize_with = "deserialize_present_option")]
    source_snapshot_sha256_after: Option<String>,
    build_version: Value,
    target_triple: String,
    compiler_profile: String,
    cargo_target_dir: String,
    cuda: bool,
    features: Vec<String>,
    executable_sha256: BTreeMap<String, String>,
    #[serde(default, deserialize_with = "deserialize_build_source_snapshot")]
    build_source_snapshot: Option<RuntimeBuildSourceSnapshot>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeBuildSourceSnapshot {
    record_path: String,
    inventory_sha256: String,
    source_root: String,
}

fn deserialize_build_source_snapshot<'de, D>(
    deserializer: D,
) -> std::result::Result<Option<RuntimeBuildSourceSnapshot>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    // Omission is compatible with older bundles; an explicit null is invalid.
    RuntimeBuildSourceSnapshot::deserialize(deserializer).map(Some)
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeBundleBinary {
    name: String,
    path: String,
    sha256: String,
    size_bytes: u64,
}

fn validate_bundle_manifest(
    manifest: &RuntimeBundleManifest,
    candidate_bundle_id: &str,
    target_build_id: &str,
    worktree: &str,
) -> Result<()> {
    if manifest.schema != BUNDLE_SCHEMA
        || manifest.schema_version != 1
        || manifest.bundle_id != candidate_bundle_id
        || manifest.profile != "dev"
        || manifest.compiler_profile != "backend-dev"
        || manifest.qualification != "not_assessed"
        || manifest.binaries.len() != BINARY_NAMES.len()
    {
        bail!("candidate bundle manifest identity or profile is invalid");
    }
    DateTime::parse_from_rfc3339(&manifest.created_at_utc)
        .context("invalid candidate bundle timestamp")?;

    let source = &manifest.source;
    validate_lower_hex(
        &source.manifest_sha256,
        64,
        "candidate source manifest SHA-256",
    )?;
    validate_lower_hex(
        &source.source_snapshot_sha256,
        64,
        "candidate source snapshot SHA-256",
    )?;
    validate_lower_hex(
        &source.backend_source_sha256,
        64,
        "candidate backend source SHA-256",
    )?;
    validate_lower_hex(&source.git_commit, 40, "candidate source commit")?;
    if let Some(digest) = &source.dependency_source_sha256 {
        validate_lower_hex(digest, 64, "candidate dependency source SHA-256")?;
    }
    if let Some(digest) = &source.source_snapshot_sha256_after {
        validate_lower_hex(digest, 64, "candidate post-build source SHA-256")?;
    }
    if source.manifest_sha256 != target_build_id
        || source.workspace_namespace != worktree
        || source.source_identity_check.as_deref() != Some("passed")
        || source.target_triple != WINDOWS_MSVC_TARGET
        || source.compiler_profile != "backend-dev"
        || source.cuda
        || source.features.iter().any(|feature| {
            let lowered = feature.to_ascii_lowercase();
            lowered.contains("cuda") || lowered.contains("fem")
        })
    {
        bail!("candidate bundle source identity or CPU development profile is invalid");
    }
    if let Some(commit) = &source.source_commit_after {
        validate_lower_hex(commit, 40, "candidate post-build source commit")?;
    }
    if let Some(snapshot) = &source.build_source_snapshot {
        validate_lower_hex(
            &snapshot.inventory_sha256,
            64,
            "candidate source inventory SHA-256",
        )?;
        // These fields describe publisher provenance. Do not open them or use
        // them to choose executable paths; the fixed bundle inventory owns that.
        let record = Path::new(&snapshot.record_path);
        let source_root = Path::new(&snapshot.source_root);
        if !record.is_absolute()
            || !source_root.is_absolute()
            || record.file_name().and_then(|name| name.to_str()) != Some("record.json")
            || source_root.file_name().and_then(|name| name.to_str()) != Some("source")
            || record.parent() != source_root.parent()
            || [record, source_root].iter().any(|path| {
                path.components()
                    .any(|component| matches!(component, std::path::Component::ParentDir))
            })
            || snapshot.record_path.chars().any(char::is_control)
            || snapshot.source_root.chars().any(char::is_control)
        {
            bail!("candidate frozen source metadata has invalid locations");
        }
    }
    let build_version = source
        .build_version
        .as_object()
        .context("candidate bundle build version is not an object")?;
    if build_version.get("schema").and_then(Value::as_str) != Some("fullmag.build-version.v1")
        || build_version.get("git_commit").and_then(Value::as_str)
            != Some(source.git_commit.as_str())
        || build_version
            .get("source_snapshot_sha256")
            .and_then(Value::as_str)
            != Some(source.source_snapshot_sha256.as_str())
    {
        bail!("candidate bundle build version does not match its source identity");
    }

    let expected_names = BINARY_NAMES
        .iter()
        .map(|name| (*name).to_owned())
        .collect::<BTreeSet<_>>();
    if source
        .executable_sha256
        .keys()
        .cloned()
        .collect::<BTreeSet<_>>()
        != expected_names
    {
        bail!("candidate source executable hashes differ from the fixed allowlist");
    }
    for (index, (name, record)) in BINARY_NAMES.iter().zip(&manifest.binaries).enumerate() {
        if record.name != *name || record.path != format!("bin/{name}") {
            bail!("candidate manifest binary order/path is invalid at index {index}");
        }
        validate_lower_hex(&record.sha256, 64, "candidate executable SHA-256")?;
        if record.size_bytes == 0 || record.size_bytes > MAX_BINARY_BYTES as u64 {
            bail!("candidate executable size is outside its per-file limit");
        }
        let source_digest = source
            .executable_sha256
            .get(*name)
            .context("candidate source executable hash is missing")?;
        validate_lower_hex(source_digest, 64, "candidate source executable SHA-256")?;
        if source_digest != &record.sha256 {
            bail!("candidate source and bundle executable hashes differ: {name}");
        }
    }
    Ok(())
}

fn validate_managed_store_location(
    storage_root: &Path,
    worktree: &str,
    store_root: &Path,
) -> Result<()> {
    let runs_worktree = storage_root.join("runs").join(worktree);
    let unscoped = runs_worktree.join("session-store");
    if store_root == unscoped.as_path() {
        return Ok(());
    }
    let relative = store_root
        .strip_prefix(&runs_worktree)
        .context("accepted store is outside the managed worktree runs root")?;
    let components = relative.components().collect::<Vec<_>>();
    if components.len() != 3
        || components[0].as_os_str().to_str() != Some("workspaces")
        || components[2].as_os_str().to_str() != Some("session-store")
    {
        bail!("accepted store is not a canonical managed worktree namespace");
    }
    let scope = components[1]
        .as_os_str()
        .to_str()
        .context("accepted-store scope is not UTF-8")?;
    validate_uuid(scope, "accepted-store scope")?;
    Ok(())
}

fn require_cold_store(store: &fullmag_session::SessionStore) -> Result<()> {
    for relative in [
        "runtime-services/APPLICATION.json",
        "runtime-services/OWNER.lock",
        "runtime-services/OWNER.json",
        "runtime-services/LAUNCH.json",
    ] {
        let path = fullmag_session::repository_path::checked_path(store.root(), relative)?;
        match fs::symlink_metadata(path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error).context("cold service metadata outcome is unknown"),
            Ok(_) => bail!("cold service metadata is present; reconciliation is required"),
        }
    }
    Ok(())
}

fn ensure_real_directory(root: &Path, relative: &str) -> Result<PathBuf> {
    let path = fullmag_session::repository_path::checked_path(root, relative)?;
    let metadata = fs::symlink_metadata(&path)?;
    #[cfg(windows)]
    let reparse = {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    };
    #[cfg(not(windows))]
    let reparse = false;
    if !metadata.is_dir() || metadata.file_type().is_symlink() || reparse {
        bail!(
            "handoff or bundle path is not a real directory: {}",
            path.display()
        );
    }
    Ok(path)
}

fn directory_entries(root: &Path, relative: &str) -> Result<BTreeSet<String>> {
    let path = ensure_real_directory(root, relative)?;
    let mut entries = BTreeSet::new();
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| anyhow::anyhow!("directory contains a non-UTF-8 entry"))?;
        if !entries.insert(name) {
            bail!("directory contains duplicate entry names");
        }
    }
    Ok(entries)
}

fn validate_session_id(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        bail!("session ID is not a bounded safe identity");
    }
    Ok(())
}

fn validate_bounded_text(value: &str, field: &str) -> Result<()> {
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        bail!("{field} must be nonempty bounded text");
    }
    Ok(())
}

fn validate_uuid(value: &str, field: &str) -> Result<()> {
    let parsed = uuid::Uuid::parse_str(value).with_context(|| format!("invalid {field}"))?;
    if parsed.is_nil() || parsed.to_string() != value {
        bail!("{field} must be a canonical nonnil UUID");
    }
    Ok(())
}

fn validate_uuid_spelling(value: &str, field: &str) -> Result<()> {
    let parsed = uuid::Uuid::parse_str(value).with_context(|| format!("invalid {field}"))?;
    if value != parsed.to_string() && value != parsed.simple().to_string() {
        bail!("{field} must use lowercase canonical UUID spelling");
    }
    Ok(())
}

fn validate_lower_hex(value: &str, length: usize, field: &str) -> Result<()> {
    if value.len() != length
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!("{field} must be {length} lowercase hexadecimal characters");
    }
    Ok(())
}

fn deserialize_present_option<'de, D, T>(
    deserializer: D,
) -> std::result::Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}
