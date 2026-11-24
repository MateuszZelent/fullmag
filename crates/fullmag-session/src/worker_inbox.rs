//! Claim-scoped worker receipts. Application owns command semantics; storage
//! enforces identity, monotonic pending/applied publication and archive safety.
use crate::durability::{atomic_write, confirm_publication};
use crate::repository_path::{checked_path, create_parent, validate_store_id};
use crate::{canonical_json_sha256, SessionStore};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FmsWorkerInboxRecord {
    pub payload_sha256: String,
    pub payload: Value,
}

impl FmsWorkerInboxRecord {
    pub fn new(payload: Value) -> Result<Self> {
        let record = Self {
            payload_sha256: canonical_json_sha256(&payload),
            payload,
        };
        record.validate()?;
        Ok(record)
    }

    fn field(&self, name: &str) -> Result<&str> {
        self.payload["claim"][name]
            .as_str()
            .context("worker inbox claim field missing")
    }

    pub fn relative_path(&self) -> Result<String> {
        self.validate()?;
        let identity = serde_json::json!([
            self.field("run_id")?,
            self.field("task_id")?,
            self.field("attempt_id")?,
            self.payload["claim"]["ownership_epoch"],
        ]);
        Ok(format!(
            "runs/{}/worker_inbox/{}.json",
            self.field("run_id")?,
            canonical_json_sha256(&identity)
        ))
    }

    pub fn validate(&self) -> Result<()> {
        if self.payload["schema_version"] != "worker_inbox.v1"
            || self.payload_sha256 != canonical_json_sha256(&self.payload)
        {
            bail!("worker inbox schema or digest mismatch");
        }
        for name in ["run_id", "task_id", "attempt_id", "lease_token"] {
            validate_store_id(self.field(name)?)?;
        }
        if self.payload["claim"]["ownership_epoch"]
            .as_u64()
            .unwrap_or(0)
            == 0
        {
            bail!("worker inbox epoch must be positive");
        }
        let applied = self.payload["applied"]
            .as_array()
            .context("worker inbox applied must be an array")?;
        let pending = self
            .payload
            .get("pending")
            .context("worker inbox pending field missing")?;
        let mut message_ids = std::collections::HashSet::new();
        let mut protocol_schema: Option<String> = None;
        for (index, envelope) in applied
            .iter()
            .chain((!pending.is_null()).then_some(pending))
            .enumerate()
        {
            let schema_version = envelope["schema_version"]
                .as_str()
                .context("worker protocol schema version missing")?;
            if !matches!(
                schema_version,
                "worker_protocol.v1"
                    | "worker_protocol.v2"
                    | "worker_protocol.v3"
                    | "worker_protocol.v4"
                    | "worker_protocol.v5"
                    | "worker_protocol.v6"
                    | "worker_protocol.v7"
            ) || protocol_schema
                .as_deref()
                .is_some_and(|previous| previous != schema_version)
                || envelope["claim"] != self.payload["claim"]
                || envelope["sequence"].as_u64() != Some(index as u64 + 1)
            {
                bail!("worker inbox command identity or sequence mismatch");
            }
            protocol_schema = Some(schema_version.to_owned());
            let message_id = envelope["message_id"]
                .as_str()
                .context("worker message id missing")?;
            validate_store_id(message_id)?;
            if !message_ids.insert(message_id) {
                bail!("worker inbox message id is duplicated");
            }
        }
        Ok(())
    }

    fn advances(&self, previous: &Self) -> bool {
        if self.payload["claim"] != previous.payload["claim"] {
            return false;
        }
        let old = previous.payload["applied"]
            .as_array()
            .expect("validated applied");
        let new = self.payload["applied"]
            .as_array()
            .expect("validated applied");
        let pending = &previous.payload["pending"];
        if pending.is_null() {
            new == old && !self.payload["pending"].is_null()
        } else {
            self.payload["pending"].is_null()
                && new.len() == old.len() + 1
                && new[..old.len()] == old[..]
                && new.last() == Some(pending)
        }
    }
}

impl SessionStore {
    pub fn commit_worker_inbox(&self, record: &FmsWorkerInboxRecord) -> Result<()> {
        let relative = record.relative_path()?;
        let _transaction = self.write_transaction()?;
        let catalog = self
            .read_run_catalog(record.field("run_id")?)?
            .context("worker inbox requires run catalog")?;
        let task = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == record.field("task_id").unwrap_or_default())
            .context("worker inbox task missing")?;
        if task.attempt_id.as_deref() != Some(record.field("attempt_id")?)
            || task.ownership_epoch != record.payload["claim"]["ownership_epoch"].as_u64()
        {
            bail!("worker inbox ownership fence rejected");
        }
        let path = checked_path(self.root(), &relative)?;
        if let Some(bytes) = self.read_document(&relative)? {
            let previous: FmsWorkerInboxRecord = serde_json::from_slice(&bytes)?;
            previous.validate()?;
            if previous.relative_path()? != relative {
                bail!("worker inbox path identity mismatch");
            }
            if &previous == record {
                return confirm_publication(&path);
            }
            if !record.advances(&previous) {
                bail!("worker inbox cannot skip or rewrite accepted history");
            }
        } else if !record.payload["applied"]
            .as_array()
            .expect("validated applied")
            .is_empty()
            || record.payload["pending"].is_null()
        {
            bail!("first worker inbox publication must be pending sequence one");
        }
        let resource_id = task
            .resource_id
            .as_deref()
            .context("worker inbox task has no assigned resource")?;
        let claim = &record.payload["claim"];
        let lease_token = claim["lease_token"]
            .as_str()
            .context("worker inbox token missing")?;
        let current_lease = self
            .read_resource_lease(record.field("run_id")?, resource_id, lease_token)?
            .context("active resource lease is missing")?;
        self.require_active_resource_lease(
            record.field("run_id")?,
            record.field("task_id")?,
            record.field("attempt_id")?,
            claim["ownership_epoch"]
                .as_u64()
                .context("worker inbox epoch missing")?,
            resource_id,
            lease_token,
            current_lease.heartbeat_sequence,
        )?;
        atomic_write(
            &create_parent(self.root(), &relative)?,
            &serde_json::to_vec_pretty(record)?,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn v6_payload() -> Value {
        let claim = json!({"run_id":"run-h-only", "task_id":"task-h-only",
            "attempt_id":"attempt-h-only", "ownership_epoch":1, "lease_token":"lease-h-only"});
        json!({"schema_version":"worker_inbox.v1", "claim":claim,
            "applied":[{"schema_version":"worker_protocol.v6", "message_id":"prepare-h-only",
                "sequence":1, "claim":claim, "command":{"kind":"prepare"}}],
            "pending":{"schema_version":"worker_protocol.v6", "message_id":"start-h-only",
                "sequence":2, "claim":claim, "command":{"kind":"start"}}})
    }

    fn v7_payload() -> Value {
        let mut payload = v6_payload();
        payload["applied"][0]["schema_version"] = json!("worker_protocol.v7");
        payload["pending"]["schema_version"] = json!("worker_protocol.v7");
        payload
    }

    #[test]
    fn v7_inbox_preserves_pending_prepare_start_and_applied_publication() {
        let pending_start = FmsWorkerInboxRecord::new(v7_payload()).unwrap();
        let mut pending_prepare = pending_start.payload.clone();
        let prepare = pending_prepare["applied"].as_array_mut().unwrap().remove(0);
        pending_prepare["pending"] = prepare;
        let pending_prepare = FmsWorkerInboxRecord::new(pending_prepare).unwrap();
        let mut applied_prepare = pending_prepare.payload.clone();
        let prepare = applied_prepare["pending"].take();
        applied_prepare["applied"].as_array_mut().unwrap().push(prepare);
        let applied_prepare = FmsWorkerInboxRecord::new(applied_prepare).unwrap();
        assert!(applied_prepare.advances(&pending_prepare));
        assert!(pending_start.advances(&applied_prepare));
        let mut applied_start = pending_start.payload.clone();
        let start = applied_start["pending"].take();
        applied_start["applied"].as_array_mut().unwrap().push(start);
        let applied_start = FmsWorkerInboxRecord::new(applied_start).unwrap();
        assert!(applied_start.advances(&pending_start));
        assert_eq!(pending_prepare.relative_path().unwrap(), applied_start.relative_path().unwrap());
        let restored: FmsWorkerInboxRecord = serde_json::from_slice(&serde_json::to_vec(&applied_start).unwrap()).unwrap();
        restored.validate().unwrap();
        assert_eq!(restored, applied_start);
        let mut rewritten = applied_start.payload.clone();
        rewritten["applied"][0]["message_id"] = json!("rewritten-prepare");
        assert!(!FmsWorkerInboxRecord::new(rewritten).unwrap().advances(&pending_start));
    }

    #[test]
    fn v7_inbox_rejects_unknown_mixed_protocol_claim_and_sequence_changes() {
        let payload = v7_payload();
        for (pointer, value) in [
            ("/schema_version", json!("worker_inbox.v2")),
            ("/pending/schema_version", json!("worker_protocol.v6")),
            ("/applied/0/schema_version", json!("worker_protocol.v6")),
            ("/pending/schema_version", json!("worker_protocol.v8")),
            ("/pending/claim/run_id", json!("run-other")),
            ("/pending/claim/task_id", json!("task-other")),
            ("/pending/claim/attempt_id", json!("attempt-other")),
            ("/pending/claim/ownership_epoch", json!(2)),
            ("/pending/claim/lease_token", json!("lease-other")),
            ("/pending/sequence", json!(0)),
            ("/pending/sequence", json!(1)),
            ("/pending/sequence", json!(3)),
            ("/pending/message_id", json!("prepare-h-only")),
        ] {
            let mut changed = payload.clone();
            *changed.pointer_mut(pointer).unwrap() = value;
            assert!(FmsWorkerInboxRecord::new(changed).is_err(), "accepted changed {pointer}");
        }
        // A homogeneous unknown stream must fail independently of mixed-version checks.
        let mut unknown = payload;
        unknown["applied"][0]["schema_version"] = json!("worker_protocol.v8");
        unknown["pending"]["schema_version"] = json!("worker_protocol.v8");
        assert!(FmsWorkerInboxRecord::new(unknown).is_err());
    }

    #[test]
    fn v6_inbox_preserves_claim_sequence_and_protocol_fences() {
        let payload = v6_payload();
        let before = FmsWorkerInboxRecord::new(payload.clone()).unwrap();
        let mut applied = payload.clone();
        let pending = applied["pending"].take();
        applied["applied"].as_array_mut().unwrap().push(pending);
        let after = FmsWorkerInboxRecord::new(applied).unwrap();
        assert!(after.advances(&before));
        for (pointer, value) in [
            ("/pending/schema_version", json!("worker_protocol.v5")),
            ("/pending/schema_version", json!("worker_protocol.v7")),
            ("/pending/claim/ownership_epoch", json!(2)),
            ("/pending/sequence", json!(3)),
            ("/pending/message_id", json!("prepare-h-only")),
        ] {
            let mut changed = payload.clone();
            *changed.pointer_mut(pointer).unwrap() = value;
            assert!(FmsWorkerInboxRecord::new(changed).is_err(), "accepted changed {pointer}");
        }
    }
}
