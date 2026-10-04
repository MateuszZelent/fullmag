//! Durable, token-bound transport for a controlled development UI restart.
//!
//! This module stores only bounded, typed restart intent and its public result.
//! Process ownership, API replacement, and the canonical scene remain private
//! to the native launcher/coordinator. Every publication is create-only from
//! the caller's point of view: an identical replay is accepted, while a
//! different payload is a conflict.

use std::fs;
use std::path::Path;

use anyhow::{bail, Context, Result};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

pub const RESTART_REQUEST_SCHEMA: &str = "fullmag.development-ui-restart-request.v1";
pub const RESTART_RESULT_SCHEMA: &str = "fullmag.development-ui-restart-result.v1";
pub const RESTART_SLOT_SCHEMA: &str = "fullmag.development-ui-restart-slot.v1";

/// One bounded UI restart intent. The secret itself never crosses this
/// boundary; status_token_sha256 is the only status authorization proof.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RestartRequest {
    pub schema: String,
    pub request_id: String,
    pub status_token_sha256: String,
    pub old_api_instance_id: String,
    pub generation_id: String,
    pub session_id: Option<String>,
    pub session_epoch: u64,
    pub editor: Value,
    pub workspace: Value,
    pub project_document: Value,
}

/// The coordinator's public terminal observation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RestartResultState {
    Ready,
    Failed,
    Unknown,
}

/// One immutable result for a restart request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RestartResult {
    pub schema: String,
    pub request_id: String,
    pub old_api_instance_id: String,
    pub generation_id: String,
    pub request_sha256: String,
    pub status_token_sha256: String,
    pub state: RestartResultState,
    pub new_api_instance_id: Option<String>,
    pub session_id: Option<String>,
    pub session_epoch: Option<u64>,
    pub editor: Option<Value>,
    pub workspace: Option<Value>,
    pub project_document: Option<Value>,
    pub public_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RestartSlot {
    schema: String,
    request_id: String,
    generation_id: String,
    old_api_instance_id: String,
    request_sha256: String,
}

const MAX_RECORD_BYTES: usize = 32 * 1024 * 1024;
const MAX_PUBLIC_REASON_BYTES: usize = 4096;
const MAX_SESSION_ID_BYTES: usize = 512;

fn validate_scope(root: &Path, worktree: &str) -> Result<()> {
    crate::repository_path::validate_store_id(worktree)?;
    crate::repository_path::reject_link(root)?;
    if !root.is_dir() {
        bail!("restart transport root is not a directory");
    }
    Ok(())
}

fn validate_schema(value: &str, expected: &str, field: &str) -> Result<()> {
    if value != expected {
        bail!("{field} has unsupported schema {value}");
    }
    Ok(())
}

fn validate_uuid(value: &str, field: &str) -> Result<()> {
    let uuid = Uuid::parse_str(value).with_context(|| format!("{field} is not a UUID"))?;
    if uuid.is_nil() || uuid.to_string() != value {
        bail!("{field} must be a canonical non-nil UUID");
    }
    Ok(())
}

fn validate_lower_hex(value: &str, length: usize, field: &str) -> Result<()> {
    if value.len() != length
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        bail!("{field} must be lowercase hexadecimal with {length} characters");
    }
    Ok(())
}

fn validate_optional_session_id(value: Option<&str>) -> Result<()> {
    let Some(value) = value else { return Ok(()) };
    if value.is_empty()
        || value.len() > MAX_SESSION_ID_BYTES
        || value.bytes().any(|byte| byte.is_ascii_control())
    {
        bail!("session_id is not a bounded portable value");
    }
    Ok(())
}

fn validate_public_reason(value: Option<&str>) -> Result<()> {
    if let Some(value) = value {
        if value.len() > MAX_PUBLIC_REASON_BYTES
            || value.bytes().any(|byte| byte.is_ascii_control())
        {
            bail!("public_reason is not a bounded public message");
        }
    }
    Ok(())
}

fn validate_request_shape(request: &RestartRequest) -> Result<()> {
    validate_schema(&request.schema, RESTART_REQUEST_SCHEMA, "request.schema")?;
    validate_uuid(&request.request_id, "request.request_id")?;
    validate_lower_hex(
        &request.status_token_sha256,
        64,
        "request.status_token_sha256",
    )?;
    validate_uuid(&request.old_api_instance_id, "request.old_api_instance_id")?;
    validate_lower_hex(&request.generation_id, 32, "request.generation_id")?;
    validate_optional_session_id(request.session_id.as_deref())?;
    if request.session_id.is_none() && request.session_epoch != 0 {
        bail!("a request without a session must use session_epoch zero");
    }
    if request.session_id.is_some() && request.session_epoch == 0 {
        bail!("a request with a session must use a nonzero session_epoch");
    }
    if !request.editor.is_object()
        || !request.workspace.is_object()
        || !request.project_document.is_object()
    {
        bail!("restart request UI payloads must be JSON objects");
    }
    Ok(())
}

fn validate_result_shape(result: &RestartResult) -> Result<()> {
    validate_schema(&result.schema, RESTART_RESULT_SCHEMA, "result.schema")?;
    validate_uuid(&result.request_id, "result.request_id")?;
    validate_uuid(&result.old_api_instance_id, "result.old_api_instance_id")?;
    validate_lower_hex(&result.generation_id, 32, "result.generation_id")?;
    validate_lower_hex(&result.request_sha256, 64, "result.request_sha256")?;
    validate_lower_hex(
        &result.status_token_sha256,
        64,
        "result.status_token_sha256",
    )?;
    validate_optional_session_id(result.session_id.as_deref())?;
    validate_public_reason(result.public_reason.as_deref())?;

    match result.state {
        RestartResultState::Ready => {
            let Some(new_api_instance_id) = result.new_api_instance_id.as_deref() else {
                bail!("a ready result must identify the fresh API instance");
            };
            validate_uuid(new_api_instance_id, "result.new_api_instance_id")?;
            if result.editor.is_none()
                || result.workspace.is_none()
                || result.project_document.is_none()
            {
                bail!("a ready result must carry all UI restoration payloads");
            }
            if !result
                .editor
                .as_ref()
                .is_some_and(|value| value.is_object())
                || !result
                    .workspace
                    .as_ref()
                    .is_some_and(|value| value.is_object())
                || !result
                    .project_document
                    .as_ref()
                    .is_some_and(|value| value.is_object())
            {
                bail!("a ready result UI payload must be a JSON object");
            }
            let Some(session_epoch) = result.session_epoch else {
                bail!("a ready result must carry session_epoch");
            };
            if result.session_id.is_none() && session_epoch != 0 {
                bail!("a ready result without a session must use session_epoch zero");
            }
            if result.session_id.is_some() && session_epoch == 0 {
                bail!("a ready result with a session must use a nonzero session_epoch");
            }
        }
        RestartResultState::Failed | RestartResultState::Unknown => {
            if result.new_api_instance_id.is_some()
                || result.session_id.is_some()
                || result.session_epoch.is_some()
                || result.editor.is_some()
                || result.workspace.is_some()
                || result.project_document.is_some()
            {
                bail!("a non-ready result cannot carry a replacement or restoration payload");
            }
        }
    }
    Ok(())
}

fn canonical_record_bytes<T: Serialize>(record: &T) -> Result<Vec<u8>> {
    let value = serde_json::to_value(record).context("serializing restart transport record")?;
    let bytes = crate::canonical_json_bytes(&value);
    if bytes.len() > MAX_RECORD_BYTES {
        bail!("restart transport record exceeds the 32 MiB encoded limit");
    }
    Ok(bytes)
}

fn decode_canonical_record<T>(bytes: &[u8], description: &str) -> Result<T>
where
    T: DeserializeOwned + Serialize,
{
    if bytes.len() > MAX_RECORD_BYTES {
        bail!("{description} exceeds the 32 MiB encoded limit");
    }
    let record: T =
        serde_json::from_slice(bytes).with_context(|| format!("decoding {description}"))?;
    let canonical = canonical_record_bytes(&record)?;
    if canonical != bytes {
        bail!("{description} is not canonical or was modified");
    }
    Ok(record)
}

fn request_relative(worktree: &str, request_id: &str, leaf: &str) -> String {
    format!("runtimes/{worktree}/development-restarts/{request_id}/{leaf}")
}

fn slot_relative(worktree: &str, old_api_instance_id: &str) -> String {
    format!("runtimes/{worktree}/development-restart-slot-{old_api_instance_id}.json")
}

fn read_optional(root: &Path, relative: &str) -> Result<Option<Vec<u8>>> {
    let path = crate::repository_path::checked_path(root, relative)?;
    match fs::symlink_metadata(&path) {
        Ok(_) => {
            crate::repository_path::read_bounded_regular_file(root, relative, MAX_RECORD_BYTES)
                .map(Some)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error).with_context(|| format!("checking {relative}")),
    }
}

fn read_required(root: &Path, relative: &str, description: &str) -> Result<Vec<u8>> {
    read_optional(root, relative)?.ok_or_else(|| anyhow::anyhow!("{description} is absent"))
}

fn acquire_writer(root: &Path) -> Result<crate::WriteTransaction> {
    let writer = crate::writer::Writer::new(root.to_path_buf());
    writer.acquire()
}

/// Publish one immutable file below the validated runtime namespace.
fn publish_immutable(root: &Path, relative: &str, bytes: &[u8], description: &str) -> Result<()> {
    let destination = crate::repository_path::create_parent(root, relative)?;
    if let Some(existing) = read_optional(root, relative)? {
        if existing == bytes {
            return crate::durability::confirm_publication(&destination);
        }
        bail!("{description} already exists with a different payload");
    }
    crate::durability::atomic_write(&destination, bytes)?;
    let published = read_required(root, relative, description)?;
    if published != bytes {
        bail!("{description} changed during publication");
    }
    Ok(())
}

fn validate_slot(slot: &RestartSlot) -> Result<()> {
    validate_schema(&slot.schema, RESTART_SLOT_SCHEMA, "slot.schema")?;
    validate_uuid(&slot.request_id, "slot.request_id")?;
    validate_lower_hex(&slot.generation_id, 32, "slot.generation_id")?;
    validate_uuid(&slot.old_api_instance_id, "slot.old_api_instance_id")?;
    validate_lower_hex(&slot.request_sha256, 64, "slot.request_sha256")?;
    Ok(())
}

fn read_slot(root: &Path, relative: &str) -> Result<Option<RestartSlot>> {
    let Some(bytes) = read_optional(root, relative)? else {
        return Ok(None);
    };
    let slot: RestartSlot = decode_canonical_record(&bytes, "restart slot")?;
    validate_slot(&slot)?;
    Ok(Some(slot))
}

fn read_request_record(root: &Path, worktree: &str, request_id: &str) -> Result<RestartRequest> {
    let relative = request_relative(worktree, request_id, "request.json");
    let bytes = read_required(root, &relative, "restart request")?;
    let request: RestartRequest = decode_canonical_record(&bytes, "restart request")?;
    validate_request_shape(&request)?;
    if request.request_id != request_id {
        bail!("restart request identity does not match its directory");
    }
    Ok(request)
}

fn request_identity(request: &RestartRequest) -> Result<(Vec<u8>, String)> {
    validate_request_shape(request)?;
    let bytes = canonical_record_bytes(request)?;
    let digest = crate::hex_sha256(&bytes);
    Ok((bytes, digest))
}

fn validate_result_for_request(
    request: &RestartRequest,
    result: &RestartResult,
    request_sha256: &str,
) -> Result<()> {
    validate_result_shape(result)?;
    if result.request_id != request.request_id
        || result.old_api_instance_id != request.old_api_instance_id
        || result.generation_id != request.generation_id
        || result.request_sha256 != request_sha256
        || result.status_token_sha256 != request.status_token_sha256
    {
        bail!("restart result is not bound to the requested generation and token");
    }
    if let Some(new_api_instance_id) = &result.new_api_instance_id {
        if new_api_instance_id == &request.old_api_instance_id {
            bail!("restart result must identify a fresh API instance");
        }
    }
    if result.state == RestartResultState::Ready
        && (result.editor.as_ref() != Some(&request.editor)
            || result.workspace.as_ref() != Some(&request.workspace)
            || result.project_document.as_ref() != Some(&request.project_document))
    {
        bail!("ready restart result payload does not match the captured request");
    }
    Ok(())
}

/// Publish a request and then its generation-bound active slot.
///
/// The request directory is made durable before the slot becomes visible. A
/// post-rename durability error is returned as an uncertain outcome and no
/// record is removed, so the caller can reconcile by identity.
pub fn publish_request(root: &Path, worktree: &str, request: &RestartRequest) -> Result<()> {
    validate_scope(root, worktree)?;
    let (request_bytes, request_sha256) = request_identity(request)?;
    let request_relative = request_relative(worktree, &request.request_id, "request.json");
    let slot_relative = slot_relative(worktree, &request.old_api_instance_id);
    let slot = RestartSlot {
        schema: RESTART_SLOT_SCHEMA.to_owned(),
        request_id: request.request_id.clone(),
        generation_id: request.generation_id.clone(),
        old_api_instance_id: request.old_api_instance_id.clone(),
        request_sha256,
    };
    let slot_bytes = canonical_record_bytes(&slot)?;

    let _transaction = acquire_writer(root)?;
    if let Some(existing) = read_slot(root, &slot_relative)? {
        if existing != slot {
            bail!("the active restart slot belongs to another request or generation");
        }
        // A prior uncertain request publication may have left its slot after
        // the request write became visible. Reconcile that exact request
        // without permitting a different payload to occupy its directory.
        publish_immutable(root, &request_relative, &request_bytes, "restart request")?;
        let slot_path = crate::repository_path::checked_path(root, &slot_relative)?;
        return crate::durability::confirm_publication(&slot_path);
    }
    publish_immutable(root, &request_relative, &request_bytes, "restart request")?;
    publish_immutable(root, &slot_relative, &slot_bytes, "restart active slot")
}

/// Read the request selected by the old API instance and generation.
pub fn read_pending_request(
    root: &Path,
    worktree: &str,
    old_api_instance_id: &str,
    generation_id: &str,
) -> Result<Option<RestartRequest>> {
    validate_scope(root, worktree)?;
    validate_uuid(old_api_instance_id, "old_api_instance_id")?;
    validate_lower_hex(generation_id, 32, "generation_id")?;
    let slot_relative = slot_relative(worktree, old_api_instance_id);
    let Some(slot) = read_slot(root, &slot_relative)? else {
        return Ok(None);
    };
    if slot.old_api_instance_id != old_api_instance_id || slot.generation_id != generation_id {
        bail!("restart slot is foreign to the requested API generation");
    }
    let request = read_request_record(root, worktree, &slot.request_id)?;
    let (_, request_sha256) = request_identity(&request)?;
    if request.old_api_instance_id != old_api_instance_id
        || request.generation_id != generation_id
        || request_sha256 != slot.request_sha256
    {
        bail!("restart slot does not bind to its immutable request");
    }
    Ok(Some(request))
}

/// Read and authenticate a request for the public status endpoint.
pub fn read_request_for_status(
    root: &Path,
    worktree: &str,
    request_id: &str,
    expected_status_token_sha256: &str,
) -> Result<RestartRequest> {
    validate_scope(root, worktree)?;
    validate_uuid(request_id, "request_id")?;
    validate_lower_hex(
        expected_status_token_sha256,
        64,
        "expected_status_token_sha256",
    )?;
    let request = read_request_record(root, worktree, request_id)?;
    if request.status_token_sha256 != expected_status_token_sha256 {
        bail!("restart request token binding does not match");
    }
    let (_, request_sha256) = request_identity(&request)?;
    let slot_relative = slot_relative(worktree, &request.old_api_instance_id);
    let Some(slot) = read_slot(root, &slot_relative)? else {
        bail!("restart request has no authoritative active slot");
    };
    if slot.request_id != request_id
        || slot.generation_id != request.generation_id
        || slot.old_api_instance_id != request.old_api_instance_id
        || slot.request_sha256 != request_sha256
    {
        bail!("restart request is not bound to its authoritative active slot");
    }
    Ok(request)
}

/// Publish one immutable, token-bound terminal result for a request.
pub fn publish_result(
    root: &Path,
    worktree: &str,
    request: &RestartRequest,
    result: &RestartResult,
) -> Result<()> {
    validate_scope(root, worktree)?;
    let (request_bytes, request_sha256) = request_identity(request)?;
    validate_result_for_request(request, result, &request_sha256)?;
    let result_bytes = canonical_record_bytes(result)?;
    let request_path = request_relative(worktree, &request.request_id, "request.json");
    let result_path = request_relative(worktree, &request.request_id, "result.json");

    let _transaction = acquire_writer(root)?;
    let stored_request = read_required(root, &request_path, "restart request")?;
    if stored_request != request_bytes {
        bail!("restart result cannot be published for an unmatching request");
    }
    let slot_path = slot_relative(worktree, &request.old_api_instance_id);
    let Some(slot) = read_slot(root, &slot_path)? else {
        bail!("restart result cannot be published before its active slot");
    };
    if slot.request_id != request.request_id
        || slot.generation_id != request.generation_id
        || slot.old_api_instance_id != request.old_api_instance_id
        || slot.request_sha256 != request_sha256
    {
        bail!("restart result cannot be published for a foreign active slot");
    }
    publish_immutable(root, &result_path, &result_bytes, "restart result")?;
    let published: RestartResult = decode_canonical_record(
        &read_required(root, &result_path, "restart result")?,
        "restart result",
    )?;
    validate_result_for_request(request, &published, &request_sha256)
}

/// Read a token-authenticated result, if the coordinator has published one.
pub fn read_result(
    root: &Path,
    worktree: &str,
    request_id: &str,
    expected_status_token_sha256: &str,
) -> Result<Option<RestartResult>> {
    let request =
        read_request_for_status(root, worktree, request_id, expected_status_token_sha256)?;
    let result_relative = request_relative(worktree, request_id, "result.json");
    let Some(bytes) = read_optional(root, &result_relative)? else {
        return Ok(None);
    };
    let result: RestartResult = decode_canonical_record(&bytes, "restart result")?;
    let (_, request_sha256) = request_identity(&request)?;
    validate_result_for_request(&request, &result, &request_sha256)?;
    Ok(Some(result))
}
