//! Read-only detail for an exact allocation in the configured local host ledger.

use std::{path::PathBuf, sync::Arc};

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    response::Response,
};
use fullmag_session::host_resource_ledger::{
    HostReservationIdentity, HostReservationOwner, HostResourceReservation,
    HostResourceReservationState,
};
use sha2::{Digest, Sha256};

use crate::{
    error::ApiError,
    router_v2::handlers::shared::{conditional_json_response, stable_strong_etag},
    schemas::{
        compute_allocations::{
            ComputeAllocationOwner, ComputeAllocationResource, ComputeAllocationState,
        },
        compute_nodes::ComputeNodePolicyBudget,
    },
    types::AppState,
};

#[utoipa::path(
    get,
    path = "/v2/platform/compute/allocations/{allocation_id}",
    params(("allocation_id" = String, Path, description = "Stable opaque allocation identity")),
    responses(
        (status = 200, description = "Read-only allocation detail without operational tokens", body = ComputeAllocationResource),
        (status = 304, description = "The allocation is unchanged for the supplied ETag"),
        (status = 404, description = "The allocation is not present in the configured local host ledger"),
        (status = 503, description = "The configured local host ledger could not be safely read")
    ),
    tag = "platform"
)]
pub async fn get_compute_allocation(
    State(state): State<Arc<AppState>>,
    Path(allocation_id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let store_root = state.submit_store_root.clone();
    let explicit_config_path =
        std::env::var_os("FULLMAG_RUNTIME_SERVICE_CONFIG").map(PathBuf::from);
    let lookup_id = allocation_id.clone();
    let resource = tokio::task::spawn_blocking(move || {
        let ledger = super::compute_nodes::open_current_compute_node_ledger(
            store_root.as_deref(),
            explicit_config_path,
        )?;
        let snapshot = fullmag_runtime_control::retry_store_writer_busy(|| ledger.read())
            .map_err(allocation_storage_error)?;
        let mut matching_reservation = None;
        for reservation in &snapshot.reservations {
            if allocation_id_for_reservation(reservation)? == lookup_id {
                matching_reservation = Some(reservation);
                break;
            }
        }
        let reservation = matching_reservation.ok_or_else(|| {
                ApiError::not_found_with_code(
                    "compute_allocation_not_found",
                    "The allocation is not present in the configured local host ledger.",
                )
            })?;
        allocation_resource(&ledger.node_id(), reservation)
    })
    .await
    .map_err(|error| ApiError::internal(format!("compute allocation read task failed: {error}")))??;

    let bytes = serde_json::to_vec(&resource)
        .map_err(|error| ApiError::internal(format!("serialize compute allocation: {error}")))?;
    let etag = stable_strong_etag(&format!(
        "compute-allocation:{}:{:x}",
        state.request_scope_instance_id,
        Sha256::digest(bytes)
    ));
    Ok(conditional_json_response(&headers, &etag, &resource))
}

fn allocation_storage_error(error: impl std::fmt::Display) -> ApiError {
    tracing::warn!(error = %error, "compute allocation ledger read failed");
    ApiError::with_status_and_code(
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        "compute_allocation_unavailable",
        "The configured local host ledger could not be safely read.",
    )
}

fn allocation_id_for_reservation(
    reservation: &HostResourceReservation,
) -> Result<String, ApiError> {
    allocation_id_for_identity(&reservation.identity)
}

fn allocation_id_for_identity(identity: &HostReservationIdentity) -> Result<String, ApiError> {
    // The ID remains stable across allocation-state transitions and deliberately
    // excludes the lease token and launch-gate tokens.
    let material = serde_json::json!({
        "store_id": &identity.store_id,
        "run_id": &identity.run_id,
        "task_id": &identity.task_id,
        "resource_id": &identity.resource_id,
        "owner": &identity.owner,
    });
    let bytes = serde_json::to_vec(&material)
        .map_err(|error| ApiError::internal(format!("serialize allocation identity: {error}")))?;
    Ok(format!("allocation:v1:sha256:{:x}", Sha256::digest(bytes)))
}

fn allocation_resource(
    node_id: &str,
    reservation: &HostResourceReservation,
) -> Result<ComputeAllocationResource, ApiError> {
    let owner = match &reservation.identity.owner {
        HostReservationOwner::Solver {
            attempt_id,
            ownership_epoch,
        } => ComputeAllocationOwner::Solver {
            attempt_id: attempt_id.clone(),
            ownership_epoch: *ownership_epoch,
        },
        HostReservationOwner::Preparation {
            preparation_attempt_id,
        } => ComputeAllocationOwner::Preparation {
            preparation_attempt_id: preparation_attempt_id.clone(),
        },
    };
    let state = match reservation.state {
        HostResourceReservationState::Tentative => ComputeAllocationState::Tentative,
        HostResourceReservationState::Committed => ComputeAllocationState::Committed,
        HostResourceReservationState::Quarantined => ComputeAllocationState::Quarantined,
        HostResourceReservationState::Released => ComputeAllocationState::Released,
    };
    let budget = ComputeNodePolicyBudget {
        cpu_millis: reservation.budget.cpu_millis,
        memory_bytes: reservation.budget.memory_bytes,
        gpu_memory_bytes: reservation.budget.gpu_memory_bytes,
        storage_bytes: reservation.budget.storage_bytes,
    };
    let parallelism = serde_json::to_value(&reservation.parallelism)
        .map_err(|error| ApiError::internal(format!("serialize allocation parallelism: {error}")))?;
    Ok(ComputeAllocationResource {
        schema_version: "compute_allocation.v1".into(),
        allocation_id: allocation_id_for_reservation(reservation)?,
        node_id: node_id.into(),
        host_id: reservation.host_id.clone(),
        run_id: reservation.identity.run_id.clone(),
        task_id: reservation.identity.task_id.clone(),
        resource_id: reservation.identity.resource_id.clone(),
        owner,
        state,
        budget,
        cpu_ids: reservation.cpu_ids.clone(),
        exclusive_gpu_uuids: reservation.exclusive_gpu_uuids.clone(),
        gpu_vram_bytes_by_uuid: reservation.gpu_vram_bytes_by_uuid.clone(),
        policy_revision: reservation.policy_revision,
        node_policy_revision: reservation.node_policy_revision,
        host_owner_epoch: reservation.host_owner_epoch,
        compute_node_owner_id: reservation.compute_node_owner_id.clone(),
        compute_node_owner_epoch: reservation.compute_node_owner_epoch,
        topology_sha256: reservation.topology_sha256.clone(),
        scheduling_priority: reservation.scheduling_priority,
        parallelism,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allocation_storage_failure_matches_the_public_unavailable_contract() {
        let error = allocation_storage_error("private-ledger-path: writer busy");
        assert_eq!(error.status, axum::http::StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(error.code.as_deref(), Some("compute_allocation_unavailable"));
        assert!(!error.message.contains("private-ledger-path"));
        assert!(!error.message.contains("writer busy"));
    }

    fn identity(lease_token: &str) -> HostReservationIdentity {
        HostReservationIdentity {
            store_id: format!("sha256:{}", "1".repeat(64)),
            run_id: "run-1".into(),
            task_id: "task-1".into(),
            resource_id: "compute.cpu".into(),
            owner: HostReservationOwner::Solver {
                attempt_id: "attempt-1".into(),
                ownership_epoch: 1,
            },
            lease_token: lease_token.into(),
        }
    }

    #[test]
    fn public_allocation_identity_does_not_expose_or_depend_on_lease_token() {
        let first = allocation_id_for_identity(&identity("secret-one")).unwrap();
        let second = allocation_id_for_identity(&identity("secret-two")).unwrap();

        assert_eq!(first, second);
        assert!(!first.contains("secret"));
        assert!(first.starts_with("allocation:v1:sha256:"));
    }
}
