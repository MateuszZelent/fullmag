//! Native, read-only validation for an explicitly pinned retained snapshot.

use std::fs;
use std::path::Path;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use fullmag_session::cas::hex_sha256;
use fullmag_session::runtime_service::retained_cancelled_runs::MAX_RETAINED_CANCELLED_RUN_PINS;
use fullmag_session::runtime_service::retained_held_manual_runs::RetainedHeldManualRunPin;
use fullmag_session::runtime_service::retained_terminal_runs::RetainedTerminalRunPin;
use fullmag_session::runtime_service::{
    validate_retained_snapshot, RuntimeServiceConfig,
};
use fullmag_session::store::SessionStore;

const REQUEST_SCHEMA: &str = "runtime_service_retained_snapshot_validation_request.v1";
const RECEIPT_SCHEMA: &str = "runtime_service_retained_snapshot_validation.v1";
const MAX_CONFIG_BYTES: usize = 65_536;
const MAX_REQUEST_BYTES: usize = 256 * 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RetainedSnapshotValidationRequest {
    schema_version: String,
    request_id: String,
    source_manifest_sha256: String,
    retained_terminal_runs: Vec<RetainedTerminalRunPin>,
    retained_held_manual_runs: Vec<RetainedHeldManualRunPin>,
}

impl RetainedSnapshotValidationRequest {
    fn validate(&self) -> Result<()> {
        if self.schema_version != REQUEST_SCHEMA {
            bail!("unsupported retained snapshot validation request schema");
        }
        let request_id = Uuid::parse_str(&self.request_id)
            .context("retained snapshot validation request id is not a UUID")?;
        if request_id.to_string() != self.request_id {
            bail!("retained snapshot validation request id must be a canonical UUID");
        }
        validate_sha256(
            &self.source_manifest_sha256,
            "source manifest SHA-256",
        )?;
        let total = self
            .retained_terminal_runs
            .len()
            .checked_add(self.retained_held_manual_runs.len())
            .context("retained snapshot run count overflow")?;
        if self.retained_held_manual_runs.is_empty()
            || total > MAX_RETAINED_CANCELLED_RUN_PINS
        {
            bail!("retained snapshot requires at least one held-manual run and at most 128 combined runs");
        }
        Ok(())
    }
}

#[derive(Debug, Serialize)]
pub(crate) struct RetainedSnapshotValidationReceipt {
    schema_version: &'static str,
    state: &'static str,
    request_sha256: String,
    config_sha256: String,
    source_manifest_sha256: String,
    run_ids: Vec<String>,
    terminal_count: usize,
    held_count: usize,
    owner_changed: bool,
    compute_started: bool,
}

pub(crate) fn validate(
    store_path: &Path,
    config_path: &Path,
    config_sha256: &str,
    request_path: &Path,
    request_sha256: &str,
) -> Result<RetainedSnapshotValidationReceipt> {
    let configuration_bytes = read_sha256_pinned_file(
        config_path,
        config_sha256,
        MAX_CONFIG_BYTES,
        "runtime service config",
    )?;
    let configuration: RuntimeServiceConfig = serde_json::from_slice(&configuration_bytes)
        .context("parse pinned runtime service config")?;
    configuration.validate()?;

    let request_bytes = read_sha256_pinned_file(
        request_path,
        request_sha256,
        MAX_REQUEST_BYTES,
        "retained snapshot request",
    )?;
    let request: RetainedSnapshotValidationRequest = serde_json::from_slice(&request_bytes)
        .context("parse pinned retained snapshot request")?;
    request.validate()?;

    let explicit_store_root = canonical_existing_directory(store_path, "explicit store")?;
    let configured_store_root =
        canonical_existing_directory(&configuration.store_root, "config store root")?;
    if explicit_store_root != configured_store_root {
        bail!("explicit store path does not equal the runtime config store root");
    }

    // This is the only store opening operation in this command. It neither
    // initializes missing state nor obtains a writer transaction.
    let store = SessionStore::open_existing(store_path)?;
    if store.root() != explicit_store_root {
        bail!("session store root changed during retained snapshot validation");
    }
    let run_ids = validate_retained_snapshot(
        &store,
        &configuration,
        &request.retained_terminal_runs,
        &request.retained_held_manual_runs,
    )?;

    Ok(RetainedSnapshotValidationReceipt {
        schema_version: RECEIPT_SCHEMA,
        state: "validated-read-only",
        request_sha256: hex_sha256(&request_bytes),
        config_sha256: hex_sha256(&configuration_bytes),
        source_manifest_sha256: request.source_manifest_sha256,
        run_ids,
        terminal_count: request.retained_terminal_runs.len(),
        held_count: request.retained_held_manual_runs.len(),
        owner_changed: false,
        compute_started: false,
    })
}

fn read_sha256_pinned_file(
    path: &Path,
    expected_sha256: &str,
    maximum: usize,
    label: &str,
) -> Result<Vec<u8>> {
    validate_sha256(expected_sha256, &format!("{label} expected SHA-256"))?;
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        bail!("{label} path must be absolute without parent traversal");
    }
    let parent = path.parent().context("bounded input file parent missing")?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .context("bounded input file name is not UTF-8")?;
    let bytes = fullmag_session::repository_path::read_bounded_regular_file(parent, name, maximum)
        .with_context(|| format!("read bounded {label}"))?;
    if hex_sha256(&bytes) != expected_sha256 {
        bail!("{label} SHA-256 does not match the supplied pin");
    }
    Ok(bytes)
}

fn validate_sha256(value: &str, field: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        bail!("{field} must be 64 lowercase hexadecimal characters");
    }
    Ok(())
}

fn canonical_existing_directory(path: &Path, label: &str) -> Result<std::path::PathBuf> {
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        bail!("{label} path must be absolute without parent traversal");
    }
    let canonical = fs::canonicalize(path).with_context(|| format!("canonicalize {label}"))?;
    if !canonical.is_dir() {
        bail!("{label} path is not a directory");
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn valid_request_value() -> Value {
        json!({
            "schema_version": REQUEST_SCHEMA,
            "request_id": "00000000-0000-4000-8000-000000000001",
            "source_manifest_sha256": "c".repeat(64),
            "retained_terminal_runs": [],
            "retained_held_manual_runs": [{
                "run_id": "held-manual-1",
                "run_intent_sha256": "a".repeat(64),
                "run_catalog_sha256": "b".repeat(64),
                "start_release": "absent"
            }]
        })
    }

    fn parse_request(value: &Value) -> Result<RetainedSnapshotValidationRequest> {
        let request: RetainedSnapshotValidationRequest = serde_json::from_value(value.clone())?;
        request.validate()?;
        Ok(request)
    }

    #[test]
    fn request_rejects_unknown_top_level_fields() {
        let mut value = valid_request_value();
        value["unexpected"] = json!(true);
        assert!(parse_request(&value).is_err());
    }

    #[test]
    fn request_rejects_an_unsupported_schema_version() {
        let mut value = valid_request_value();
        value["schema_version"] = json!("runtime_service_retained_snapshot_validation_request.v2");
        assert!(parse_request(&value).is_err());
    }

    #[test]
    fn request_rejects_a_released_held_manual_start_gate() {
        let mut value = valid_request_value();
        value["retained_held_manual_runs"][0]["start_release"] = json!("released");
        assert!(parse_request(&value).is_err());
    }

    #[test]
    fn pinned_file_hash_drift_is_reported_before_json_parsing() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("request.json");
        fs::write(&path, b"{").unwrap();

        let error = read_sha256_pinned_file(
            &path,
            &"0".repeat(64),
            MAX_REQUEST_BYTES,
            "retained snapshot request",
        )
        .unwrap_err();
        assert!(error.to_string().contains("SHA-256"));
    }
}
