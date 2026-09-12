//! Terminal mesh-command receipts shared by the runtime publisher and API ledger.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MESH_COMMAND_OUTCOME_LIMIT: usize = 256;
pub const MESH_STATE_POLICY: &str = "reinitialize_from_model";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeshCommandStatus {
    Completed,
    Failed,
    Rejected,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MeshCommandOutcome {
    pub command_id: String,
    pub build_id: String,
    pub status: MeshCommandStatus,
    pub state_policy: String,
    pub completed_at_unix_ms: u128,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_generation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub fn record_mesh_command_outcome(workspace: &mut Value, outcome: &MeshCommandOutcome) {
    let outcomes = workspace["command_outcomes"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut outcomes: Vec<_> = outcomes
        .into_iter()
        .filter(|entry| entry["command_id"].as_str() != Some(&outcome.command_id))
        .collect();
    outcomes.push(serde_json::to_value(outcome).expect("mesh receipt is serializable"));
    if outcomes.len() > MESH_COMMAND_OUTCOME_LIMIT {
        outcomes.drain(..outcomes.len() - MESH_COMMAND_OUTCOME_LIMIT);
    }
    workspace["command_outcomes"] = Value::Array(outcomes);
}

pub fn mesh_command_outcome(workspace: &Value, command_id: &str) -> Option<MeshCommandOutcome> {
    workspace
        .get("command_outcomes")?
        .as_array()?
        .iter()
        .rev()
        .find(|entry| entry["command_id"].as_str() == Some(command_id))
        .and_then(|entry| serde_json::from_value(entry.clone()).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn receipt(index: usize) -> MeshCommandOutcome {
        MeshCommandOutcome {
            command_id: format!("command-{index}"),
            build_id: format!("mesh:command-{index}"),
            status: MeshCommandStatus::Completed,
            state_policy: MESH_STATE_POLICY.to_string(),
            completed_at_unix_ms: 100,
            mesh_generation_id: Some(format!("generation-{index}")),
            error: None,
        }
    }

    #[test]
    fn receipts_preserve_each_command_through_coalesced_snapshots_and_bound_storage() {
        let mut workspace = serde_json::json!({});
        for index in 0..=MESH_COMMAND_OUTCOME_LIMIT {
            record_mesh_command_outcome(&mut workspace, &receipt(index));
        }
        assert!(mesh_command_outcome(&workspace, "command-0").is_none());
        assert_eq!(
            mesh_command_outcome(&workspace, "command-1"),
            Some(receipt(1))
        );
        assert_eq!(
            workspace["command_outcomes"].as_array().unwrap().len(),
            MESH_COMMAND_OUTCOME_LIMIT
        );
        let round_trip: Value = serde_json::from_str(&workspace.to_string()).unwrap();
        assert_eq!(
            mesh_command_outcome(&round_trip, "command-256"),
            Some(receipt(256))
        );
    }
}
