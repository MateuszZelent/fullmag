//! Read-only resource for the snapshot published by the local host runtime.

use std::{path::PathBuf, sync::Arc};

use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use fullmag_session::compute_node_snapshot::{
    SampleFreshness, COMPUTE_NODE_SAMPLE_STALE_AFTER_SECONDS,
    COMPUTE_NODE_SNAPSHOT_SCHEMA_V2,
};
use fullmag_session::{
    compute_node_policy::NodePolicy,
    host_resource_ledger::{HostResourceLedger, HostResourceLedgerSnapshot},
};
use sha2::{Digest, Sha256};

use crate::{
    error::ApiError,
    router_v2::handlers::shared::{conditional_json_response, stable_strong_etag},
    schemas::compute_nodes::{
        ComputeNodeParallelismPattern, ComputeNodePolicyBudget,
        ComputeNodePolicyDocumentResource, ComputeNodePolicyResource,
        ComputeNodePolicyStatusResource, ComputeNodePolicyUpdate,
        ComputeNodePolicyUpdateRequest, ComputeNodeResource, ComputeNodesResource,
        ComputeNodesState,
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

#[utoipa::path(
    get,
    path = "/v2/platform/compute/nodes/{node_id}/policy",
    params(("node_id" = String, Path, description = "Stable compute-node identity")),
    responses(
        (status = 200, description = "Current operator policy and live admission status", body = ComputeNodePolicyResource),
        (status = 404, description = "The requested compute node is not configured"),
        (status = 503, description = "The configured host policy could not be safely read")
    ),
    tag = "platform"
)]
pub async fn get_compute_node_policy(
    State(state): State<Arc<AppState>>,
    Path(node_id): Path<String>,
) -> Result<Response, ApiError> {
    let resource = load_compute_node_policy(&state, node_id.clone()).await?;
    let etag = node_policy_etag(&node_id, resource.policy.revision);
    let mut response = Json(resource).into_response();
    response.headers_mut().insert(
        header::ETAG,
        HeaderValue::from_str(&etag).map_err(|error| {
            ApiError::internal(format!("compute-node policy ETag is invalid: {error}"))
        })?,
    );
    Ok(response)
}

#[utoipa::path(
    put,
    path = "/v2/platform/compute/nodes/{node_id}/policy",
    params(
        ("node_id" = String, Path, description = "Stable compute-node identity"),
        ("If-Match" = String, Header, description = "ETag returned by GET for the policy revision being edited"),
        ("Authorization" = String, Header, description = "Bearer capability issued by the local Fullmag desktop application")
    ),
    request_body = ComputeNodePolicyUpdateRequest,
    responses(
        (status = 200, description = "Policy saved; existing allocations remain unchanged", body = ComputeNodePolicyResource),
        (status = 400, description = "Policy values are invalid for the configured host"),
        (status = 403, description = "A local desktop-operator capability is required"),
        (status = 404, description = "The requested compute node is not configured"),
        (status = 409, description = "The policy changed while it was being edited"),
        (status = 412, description = "If-Match does not identify the current policy revision"),
        (status = 428, description = "If-Match is required"),
        (status = 503, description = "The configured host policy could not be safely updated")
    ),
    tag = "platform"
)]
pub async fn put_compute_node_policy(
    State(state): State<Arc<AppState>>,
    Path(node_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<ComputeNodePolicyUpdateRequest>,
) -> Result<Response, ApiError> {
    if !super::super::super::middleware::compute_operator_auth::is_authorized(
        &headers,
        state.local_compute_operator_token.as_deref(),
    ) {
        return Err(ApiError::with_status_and_code(
            StatusCode::FORBIDDEN,
            "local_compute_operator_required",
            "A local Fullmag desktop operator is required to change host policy.",
        ));
    }
    let if_match = headers
        .get(header::IF_MATCH)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
        .ok_or_else(|| {
            ApiError::with_status_and_code(
                StatusCode::PRECONDITION_REQUIRED,
                "compute_node_policy_if_match_required",
                "Refresh the host policy before applying changes.",
            )
        })?;
    let store_root = state.submit_store_root.clone();
    let explicit_config_path =
        std::env::var_os("FULLMAG_RUNTIME_SERVICE_CONFIG").map(PathBuf::from);
    let policy_node_id = node_id.clone();
    let saved = tokio::task::spawn_blocking(move || {
        update_compute_node_policy(
            store_root.as_deref(),
            explicit_config_path,
            &policy_node_id,
            &if_match,
            request.policy,
        )
    })
    .await
    .map_err(|error| ApiError::internal(format!("compute-node policy update task failed: {error}")))??;
    let etag = node_policy_etag(&node_id, saved.policy.revision);
    let mut response = Json(saved).into_response();
    response.headers_mut().insert(
        header::ETAG,
        HeaderValue::from_str(&etag).map_err(|error| {
            ApiError::internal(format!("compute-node policy ETag is invalid: {error}"))
        })?,
    );
    Ok(response)
}

async fn load_compute_node_policy(
    state: &AppState,
    node_id: String,
) -> Result<ComputeNodePolicyResource, ApiError> {
    let store_root = state.submit_store_root.clone();
    let explicit_config_path =
        std::env::var_os("FULLMAG_RUNTIME_SERVICE_CONFIG").map(PathBuf::from);
    tokio::task::spawn_blocking(move || {
        read_compute_node_policy(store_root.as_deref(), explicit_config_path, &node_id)
    })
    .await
    .map_err(|error| ApiError::internal(format!("compute-node policy read task failed: {error}")))?
}

fn read_compute_node_policy(
    store_root: Option<&std::path::Path>,
    explicit_config_path: Option<PathBuf>,
    node_id: &str,
) -> Result<ComputeNodePolicyResource, ApiError> {
    let ledger = open_compute_node_ledger(store_root, explicit_config_path, node_id)?;
    let snapshot = ledger
        .read()
        .map_err(|error| policy_storage_error("read", error))?;
    policy_resource(&snapshot).map_err(|error| policy_storage_error("project", error))
}

fn update_compute_node_policy(
    store_root: Option<&std::path::Path>,
    explicit_config_path: Option<PathBuf>,
    node_id: &str,
    if_match: &str,
    update: ComputeNodePolicyUpdate,
) -> Result<ComputeNodePolicyResource, ApiError> {
    let ledger = open_compute_node_ledger(store_root, explicit_config_path, node_id)?;
    let snapshot = ledger
        .read()
        .map_err(|error| policy_storage_error("read", error))?;
    let current = snapshot.node_policy.ok_or_else(|| {
        ApiError::with_status_and_code(
            StatusCode::SERVICE_UNAVAILABLE,
            "compute_node_policy_unavailable",
            "No operator policy is configured for this host.",
        )
    })?;
    if if_match != node_policy_etag(node_id, current.revision) {
        return Err(ApiError::with_status_and_code(
            StatusCode::PRECONDITION_FAILED,
            "compute_node_policy_revision_mismatch",
            "The host policy changed. Refresh it and compare the saved values with your draft.",
        ));
    }
    let revision = current.revision.checked_add(1).ok_or_else(|| {
        ApiError::internal("compute-node policy revision overflowed")
    })?;
    let next = node_policy_from_update(current, revision, update);
    next.validate(ledger.policy()).map_err(|error| {
        ApiError::with_status_and_code(
            StatusCode::BAD_REQUEST,
            "compute_node_policy_invalid",
            format!("The proposed host policy is invalid: {error}"),
        )
    })?;
    ledger
        .update_node_policy(revision - 1, next)
        .map_err(|error| {
            if error
                .downcast_ref::<fullmag_session::compute_node_policy::NodePolicyRevisionConflict>()
                .is_some()
            {
                ApiError::conflict_with_code(
                    "compute_node_policy_revision_conflict",
                    "The host policy changed. Refresh it and compare the saved values with your draft.",
                )
            } else {
                policy_storage_error("save", error)
            }
        })?;
    let updated = ledger
        .read()
        .map_err(|error| policy_storage_error("confirm", error))?;
    policy_resource(&updated).map_err(|error| policy_storage_error("confirm", error))
}

fn open_compute_node_ledger(
    store_root: Option<&std::path::Path>,
    explicit_config_path: Option<PathBuf>,
    node_id: &str,
) -> Result<HostResourceLedger, ApiError> {
    let config_path = super::runtime_service::resolve_config_path(store_root, explicit_config_path)
        .ok_or_else(|| {
            ApiError::with_status_and_code(
                StatusCode::SERVICE_UNAVAILABLE,
                "compute_node_policy_unavailable",
                "No host policy is configured for this application.",
            )
        })?;
    let config = fullmag_session::runtime_service::RuntimeServiceConfig::read(&config_path)
        .map_err(|error| policy_storage_error("read configuration for", error))?;
    let binding = config.host_execution.ok_or_else(|| {
        ApiError::with_status_and_code(
            StatusCode::SERVICE_UNAVAILABLE,
            "compute_node_policy_unavailable",
            "No host policy is configured for this application.",
        )
    })?;
    let ledger = HostResourceLedger::open(&binding.ledger_root, binding.policy)
        .map_err(|error| policy_storage_error("open", error))?;
    if ledger.node_id() != node_id {
        return Err(ApiError::not_found_with_code(
            "compute_node_not_found",
            "The requested compute node is not configured.",
        ));
    }
    Ok(ledger)
}

fn node_policy_from_update(
    current: NodePolicy,
    revision: u64,
    update: ComputeNodePolicyUpdate,
) -> NodePolicy {
    NodePolicy {
        schema_version: current.schema_version,
        host_id: current.host_id,
        revision,
        allowed_cpu_ids: update.allowed_cpu_ids,
        allowed_gpu_uuids: update.allowed_gpu_uuids,
        reserved_budget: fullmag_session::FmsResourceBudget {
            cpu_millis: update.reserved_budget.cpu_millis,
            memory_bytes: update.reserved_budget.memory_bytes,
            gpu_memory_bytes: update.reserved_budget.gpu_memory_bytes,
            storage_bytes: update.reserved_budget.storage_bytes,
        },
        reserved_gpu_vram_bytes_by_uuid: update.reserved_gpu_vram_bytes_by_uuid,
        max_parallel_workers: update.max_parallel_workers,
        priority_order: update.priority_order,
        draining: update.draining,
        allowed_parallelism_patterns: update
            .allowed_parallelism_patterns
            .into_iter()
            .map(Into::into)
            .collect(),
    }
}

impl From<ComputeNodeParallelismPattern> for fullmag_ir::compute_resources::ComputeParallelismIR {
    fn from(value: ComputeNodeParallelismPattern) -> Self {
        match value {
            ComputeNodeParallelismPattern::SingleProcess {} => Self::SingleProcess,
            ComputeNodeParallelismPattern::Distributed {
                ranks,
                threads_per_rank,
                ranks_per_node,
                gpus_per_rank,
            } => Self::Distributed {
                ranks,
                threads_per_rank,
                ranks_per_node,
                gpus_per_rank,
            },
        }
    }
}

fn policy_resource(
    snapshot: &HostResourceLedgerSnapshot,
) -> anyhow::Result<ComputeNodePolicyResource> {
    let policy = snapshot
        .node_policy
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("node policy is missing from the host ledger"))?;
    let status = snapshot
        .node_policy_status()?
        .ok_or_else(|| anyhow::anyhow!("node policy status is missing from the host ledger"))?;
    Ok(ComputeNodePolicyResource {
        policy: ComputeNodePolicyDocumentResource {
            schema_version: policy.schema_version.clone(),
            revision: policy.revision,
            allowed_cpu_ids: policy.allowed_cpu_ids.clone(),
            allowed_gpu_uuids: policy.allowed_gpu_uuids.clone(),
            reserved_budget: ComputeNodePolicyBudget {
                cpu_millis: policy.reserved_budget.cpu_millis,
                memory_bytes: policy.reserved_budget.memory_bytes,
                gpu_memory_bytes: policy.reserved_budget.gpu_memory_bytes,
                storage_bytes: policy.reserved_budget.storage_bytes,
            },
            reserved_gpu_vram_bytes_by_uuid: policy.reserved_gpu_vram_bytes_by_uuid.clone(),
            max_parallel_workers: policy.max_parallel_workers,
            priority_order: policy.priority_order.clone(),
            draining: policy.draining,
            allowed_parallelism_patterns: policy
                .allowed_parallelism_patterns
                .iter()
                .cloned()
                .map(Into::into)
                .collect(),
        },
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

impl From<fullmag_ir::compute_resources::ComputeParallelismIR> for ComputeNodeParallelismPattern {
    fn from(value: fullmag_ir::compute_resources::ComputeParallelismIR) -> Self {
        match value {
            fullmag_ir::compute_resources::ComputeParallelismIR::SingleProcess => {
                Self::SingleProcess {}
            }
            fullmag_ir::compute_resources::ComputeParallelismIR::Distributed {
                ranks,
                threads_per_rank,
                ranks_per_node,
                gpus_per_rank,
            } => Self::Distributed {
                ranks,
                threads_per_rank,
                ranks_per_node,
                gpus_per_rank,
            },
        }
    }
}

fn node_policy_etag(node_id: &str, revision: u64) -> String {
    format!("\"compute-node-policy:{node_id}:{revision}\"")
}

fn policy_storage_error(action: &str, error: impl std::fmt::Display) -> ApiError {
    tracing::warn!(action, error = %error, "compute-node policy operation failed");
    ApiError::with_status_and_code(
        StatusCode::SERVICE_UNAVAILABLE,
        "compute_node_policy_unavailable",
        "The configured host policy could not be safely read or updated.",
    )
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
    let node_policy = if ledger_snapshot.node_policy.is_some() {
        Some(policy_resource(&ledger_snapshot)?)
    } else {
        None
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
    use std::collections::{BTreeMap, BTreeSet};

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

    #[test]
    fn node_policy_etag_pins_the_node_and_policy_revision() {
        assert_eq!(
            node_policy_etag("desktop-host", 7),
            "\"compute-node-policy:desktop-host:7\""
        );
    }

    #[tokio::test]
    async fn policy_write_fails_closed_without_the_local_operator_capability() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://localhost:8081"),
        );
        let request = ComputeNodePolicyUpdateRequest {
            policy: ComputeNodePolicyUpdate {
                allowed_cpu_ids: BTreeSet::new(),
                allowed_gpu_uuids: BTreeSet::new(),
                reserved_budget: ComputeNodePolicyBudget {
                    cpu_millis: 0,
                    memory_bytes: 0,
                    gpu_memory_bytes: 0,
                    storage_bytes: 0,
                },
                reserved_gpu_vram_bytes_by_uuid: BTreeMap::new(),
                max_parallel_workers: 1,
                priority_order: Vec::new(),
                draining: false,
                allowed_parallelism_patterns: Vec::new(),
            },
        };

        let result = put_compute_node_policy(
            State(crate::router_v2::tests::test_app_state()),
            Path("node-local".to_string()),
            headers,
            Json(request),
        )
        .await;

        let error = result.expect_err("Origin alone must not authorize host policy writes");
        assert_eq!(error.status, StatusCode::FORBIDDEN);
        assert_eq!(error.code.as_deref(), Some("local_compute_operator_required"));
    }
}
