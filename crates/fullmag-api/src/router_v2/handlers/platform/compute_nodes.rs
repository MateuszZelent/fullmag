//! Read-only resource for the snapshot published by the local host runtime.

use std::{path::PathBuf, sync::Arc};

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    response::Response,
};
use chrono::Utc;
use fullmag_session::compute_node_snapshot::{
    SampleFreshness, COMPUTE_NODE_SAMPLE_STALE_AFTER_SECONDS,
    COMPUTE_NODE_SNAPSHOT_SCHEMA_V2,
};
use sha2::{Digest, Sha256};

use crate::{
    error::ApiError,
    router_v2::handlers::shared::{conditional_json_response, stable_strong_etag},
    schemas::compute_nodes::{
        ComputeNodePolicyResource, ComputeNodePolicyStatusResource, ComputeNodeResource,
        ComputeNodesResource, ComputeNodesState,
    },
    types::AppState,
};

#[utoipa::path(
    get,
    path = "/v2/platform/compute/nodes",
    responses(
        (status = 200, description = "Latest read-only local compute-node snapshot and its freshness", body = ComputeNodesResource),
        (status = 304, description = "Compute-node snapshot is unchanged for the supplied ETag"),
        (status = 503, description = "Configured host inventory could not be safely observed")
    ),
    tag = "platform"
)]
pub async fn get_compute_nodes(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let resource = load_compute_nodes(&state).await?;

    let etag = resource_etag(&resource)?;
    Ok(conditional_json_response(&headers, &etag, &resource))
}

#[utoipa::path(
    get,
    path = "/v2/platform/compute/nodes/{node_id}",
    params(("node_id" = String, Path, description = "Stable compute-node identity")),
    responses(
        (status = 200, description = "Latest read-only compute-node snapshot and its freshness", body = ComputeNodeResource),
        (status = 304, description = "Compute-node snapshot is unchanged for the supplied ETag"),
        (status = 404, description = "The requested compute node is not currently observable"),
        (status = 503, description = "Configured host inventory could not be safely observed")
    ),
    tag = "platform"
)]
pub async fn get_compute_node(
    State(state): State<Arc<AppState>>,
    Path(node_id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let resource = load_compute_nodes(&state)
        .await?
        .nodes
        .into_iter()
        .find(|node| node.node_id == node_id)
        .ok_or_else(|| ApiError::not_found("compute node is not currently observable"))?;
    let etag = resource_etag(&resource)?;
    Ok(conditional_json_response(&headers, &etag, &resource))
}

async fn load_compute_nodes(state: &AppState) -> Result<ComputeNodesResource, ApiError> {
    let store_root = state.submit_store_root.clone();
    let explicit_config_path =
        std::env::var_os("FULLMAG_RUNTIME_SERVICE_CONFIG").map(PathBuf::from);
    tokio::task::spawn_blocking(move || {
        observe_compute_nodes(store_root.as_deref(), explicit_config_path)
    })
    .await
    .map_err(|error| ApiError::internal(format!("compute-node observer task failed: {error}")))?
    .map_err(|error| {
        tracing::warn!(error = %error, "compute-node snapshot observation failed");
        ApiError::with_status_and_code(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "compute_snapshot_unavailable",
            "The configured compute-node snapshot could not be safely observed.",
        )
    })
}

fn observe_compute_nodes(
    store_root: Option<&std::path::Path>,
    explicit_config_path: Option<PathBuf>,
) -> anyhow::Result<ComputeNodesResource> {
    use fullmag_session::{
        host_resource_ledger::HostResourceLedger,
        runtime_service::RuntimeServiceConfig,
    };

    let Some(config_path) = super::runtime_service::resolve_config_path(
        store_root,
        explicit_config_path,
    ) else {
        return Ok(ComputeNodesResource::not_probed());
    };
    let config = RuntimeServiceConfig::read(&config_path)?;
    let Some(binding) = config.host_execution else {
        return Ok(ComputeNodesResource::not_probed());
    };
    let ledger = HostResourceLedger::open(&binding.ledger_root, binding.policy.clone())?;
    let Some(mut snapshot) = ledger.read_compute_node_snapshot()? else {
        return Ok(ComputeNodesResource::not_probed());
    };

    let now = Utc::now();
    snapshot.sample.refresh_freshness_at(now.clone());
    snapshot.validate_at(now.clone())?;
    if snapshot.node_id != ledger.node_id()
        || snapshot.runtime_owner_id != ledger.owner_id()
        || snapshot.owner_epoch != binding.policy.owner_epoch
    {
        anyhow::bail!("compute-node snapshot does not match the configured host owner");
    }

    let host_owner_current = if snapshot.schema_version == COMPUTE_NODE_SNAPSHOT_SCHEMA_V2 {
        ledger
            .active_inventory_owner()?
            .is_some_and(|owner| {
                snapshot.host_owner_id.as_deref() == Some(owner.host_owner_id.as_str())
                    && snapshot.host_owner_epoch == Some(owner.host_owner_epoch)
            })
    } else {
        false
    };

    let current_boot_id =
        fullmag_runtime_control::compute_node_probe::current_host_boot_id(now.clone())?;
    let state = compute_node_state(
        &snapshot.sample.freshness,
        snapshot.boot_id == current_boot_id && host_owner_current,
    );
    let ledger_snapshot = ledger.read()?;
    let node_policy = match ledger_snapshot.node_policy.as_ref() {
        Some(policy) => {
            let status = ledger_snapshot
                .node_policy_status()?
                .ok_or_else(|| anyhow::anyhow!("node policy status is missing"))?;
            let mut policy_snapshot = serde_json::to_value(policy)?;
            if let Some(fields) = policy_snapshot.as_object_mut() {
                fields.remove("host_id");
            }
            Some(ComputeNodePolicyResource {
                policy: policy_snapshot,
                status: ComputeNodePolicyStatusResource {
                    revision: status.revision,
                    active_workers: status.active_workers,
                    draining: status.draining,
                    over_budget: status.over_budget,
                    blocking_reasons: status
                        .blocking_reasons
                        .iter()
                        .map(|reason| reason.as_str().to_owned())
                        .collect(),
                },
            })
        }
        None => None,
    };
    let node = ComputeNodeResource {
        node_id: snapshot.node_id.clone(),
        state,
        stale_after_seconds: COMPUTE_NODE_SAMPLE_STALE_AFTER_SECONDS as u64,
        snapshot: serde_json::to_value(snapshot)?,
        node_policy,
    };
    Ok(ComputeNodesResource {
        schema_version: "compute_nodes.v1".into(),
        state,
        stale_after_seconds: COMPUTE_NODE_SAMPLE_STALE_AFTER_SECONDS as u64,
        nodes: vec![node],
    })
}

fn compute_node_state(freshness: &SampleFreshness, same_boot: bool) -> ComputeNodesState {
    if !same_boot {
        return ComputeNodesState::Unavailable;
    }

    match freshness {
        SampleFreshness::Current => ComputeNodesState::Current,
        SampleFreshness::Stale => ComputeNodesState::Stale,
        SampleFreshness::Unavailable(_) => ComputeNodesState::Unavailable,
    }
}

fn resource_etag(resource: &impl serde::Serialize) -> Result<String, ApiError> {
    let bytes = serde_json::to_vec(resource).map_err(|error| {
        ApiError::internal(format!("serialize compute-node resource: {error}"))
    })?;
    let digest = Sha256::digest(bytes);
    Ok(stable_strong_etag(&format!("compute-nodes:{digest:x}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_host_configuration_is_not_probed_without_creating_store_files() {
        let root = std::env::temp_dir().join(format!(
            "fullmag-compute-nodes-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&root).unwrap();

        let resource = observe_compute_nodes(Some(&root), None).unwrap();

        assert_eq!(resource.state, ComputeNodesState::NotProbed);
        assert_eq!(resource.stale_after_seconds, 30);
        assert!(resource.nodes.is_empty());
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn snapshot_from_previous_boot_is_not_current_for_the_api() {
        assert_eq!(
            compute_node_state(&SampleFreshness::Current, false),
            ComputeNodesState::Unavailable
        );
        assert_eq!(
            compute_node_state(&SampleFreshness::Current, true),
            ComputeNodesState::Current
        );
    }
}
