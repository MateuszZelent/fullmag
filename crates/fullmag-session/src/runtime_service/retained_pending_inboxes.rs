//! Explicit v6 pins; pending commands remain immutable history, never replayed.
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use super::retained_terminal_runs::RetainedTerminalRunPin;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RetainedPendingInboxPin {
    pub run_id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub resource_id: String,
    pub ownership_epoch: u64,
    pub inbox_sha256: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "deserialize_digest")]
    pub release_proof_sha256: Option<String>,
}
fn deserialize_digest<'de, D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Option<String>, D::Error> {
    String::deserialize(d).map(Some)
}
pub(super) fn validate_pins(pins: &[RetainedPendingInboxPin], terminal: &[RetainedTerminalRunPin]) -> Result<()> {
    if pins.is_empty() || pins.len() > 128 { bail!("v6 requires 1..128 pending inbox pins"); }
    let mut claims = BTreeSet::new();
    let mut epochs = BTreeSet::new();
    for pin in pins {
        for id in [&pin.run_id, &pin.task_id, &pin.attempt_id, &pin.resource_id] { crate::repository_path::validate_store_id(id)?; }
        super::retained_cancelled_runs::validate_sha256(&pin.inbox_sha256, "inbox_sha256")?;
        if pin.inbox_sha256 == "0".repeat(64) || pin.ownership_epoch == 0
            || !terminal.iter().any(|run| run.run_id == pin.run_id)
            || !claims.insert((&pin.run_id, &pin.task_id, &pin.attempt_id))
            || !epochs.insert((&pin.run_id, &pin.task_id, pin.ownership_epoch)) {
            bail!("v6 inbox pin is duplicate, unbound or invalid");
        }
        match (pin.kind.as_str(), pin.release_proof_sha256.as_deref()) {
            ("failed_final_heartbeat", None) => {},
            ("cancelled_before_spawn", Some(digest)) if digest != "0".repeat(64) => {
                super::retained_cancelled_runs::validate_sha256(digest, "release_proof_sha256")?;
            },
            _ => bail!("v6 pending inbox kind and proof do not match"),
        }
    }
    Ok(())
}

/// V7 absence is explicit evidence, never a fabricated inbox digest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RetainedAbsentInboxPin {
    pub run_id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub resource_id: String,
    pub ownership_epoch: u64,
    pub inbox_absence: String,
    pub release_proof_sha256: String,
}

pub(super) fn validate_absent_pins(
    pins: &[RetainedAbsentInboxPin], terminal: &[RetainedTerminalRunPin],
    pending: &[RetainedPendingInboxPin], histories: &[super::retained_attempt_histories::RetainedAttemptHistoryPin],
) -> Result<()> {
    if pins.is_empty() || pins.len() > 128 { bail!("v7 requires 1..128 absent inbox pins"); }
    let mut claims = BTreeSet::new();
    let mut epochs = BTreeSet::new();
    for pin in pins {
        for id in [&pin.run_id, &pin.task_id, &pin.attempt_id, &pin.resource_id] { crate::repository_path::validate_store_id(id)?; }
        super::retained_cancelled_runs::validate_sha256(&pin.release_proof_sha256, "release_proof_sha256")?;
        if pin.inbox_absence != "directory_absent" || pin.release_proof_sha256 == "0".repeat(64)
            || pin.ownership_epoch == 0 || !terminal.iter().any(|run| run.run_id == pin.run_id)
            || !claims.insert((&pin.run_id, &pin.task_id, &pin.attempt_id))
            || !epochs.insert((&pin.run_id, &pin.task_id, pin.ownership_epoch))
            || pending.iter().any(|other| other.run_id == pin.run_id)
            || histories.iter().any(|other| other.run_id == pin.run_id) {
            bail!("v7 absence pin is duplicate, overlapping, invalid or outside terminal subset");
        }
    }
    Ok(())
}
