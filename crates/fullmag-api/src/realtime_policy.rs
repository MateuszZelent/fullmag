use crate::error::ApiError;
use crate::schemas::realtime::{
    RealtimeCommunicationPolicy, RealtimeCommunicationPolicyPatch,
    RealtimeCommunicationPolicyResource,
};
use fullmag_session::communication_policy::{
    LIVE_ERROR_RETRY_MS, LIVE_REALTIME_COALESCE_WINDOW_MS,
    LIVE_REALTIME_DIAGNOSTICS_SUMMARY_WINDOW_MS, LIVE_REALTIME_FIELD_SAMPLE_COALESCE_WINDOW_MS,
    LIVE_REALTIME_HEARTBEAT_SECS, LIVE_REALTIME_RECONNECT_MS, LIVE_REALTIME_REPLAY_CAPACITY,
    LIVE_SCALAR_TELEMETRY_INTERVAL_MS, LIVE_STATUS_REFRESH_MS, LIVE_TABLE_ROWS_MIN_REFETCH_MS,
};

pub(crate) const CURRENT_LIVE_REALTIME_REPLAY_CAPACITY: usize = LIVE_REALTIME_REPLAY_CAPACITY;
pub(crate) const CURRENT_LIVE_REALTIME_HEARTBEAT_SECS: u64 = LIVE_REALTIME_HEARTBEAT_SECS;
pub(crate) const CURRENT_LIVE_REALTIME_COALESCE_WINDOW_MS: u32 = LIVE_REALTIME_COALESCE_WINDOW_MS;
pub(crate) const CURRENT_LIVE_REALTIME_FIELD_SAMPLE_COALESCE_WINDOW_MS: u32 =
    LIVE_REALTIME_FIELD_SAMPLE_COALESCE_WINDOW_MS;
pub(crate) const CURRENT_LIVE_SCALAR_TELEMETRY_PUBLISH_MS: u32 =
    LIVE_SCALAR_TELEMETRY_INTERVAL_MS as u32;
pub(crate) const CURRENT_LIVE_TABLE_ROWS_MIN_REFETCH_MS: u32 = LIVE_TABLE_ROWS_MIN_REFETCH_MS;
pub(crate) const CURRENT_LIVE_REALTIME_DIAGNOSTICS_SUMMARY_WINDOW_MS: u32 =
    LIVE_REALTIME_DIAGNOSTICS_SUMMARY_WINDOW_MS;
pub(crate) const CURRENT_LIVE_REALTIME_RECONNECT_MS: u32 = LIVE_REALTIME_RECONNECT_MS;
pub(crate) const CURRENT_LIVE_STATUS_REFRESH_MS: u32 = LIVE_STATUS_REFRESH_MS;
pub(crate) const CURRENT_LIVE_ERROR_RETRY_MS: u32 = LIVE_ERROR_RETRY_MS;

#[derive(Debug, Clone)]
pub(crate) struct CurrentLiveRealtimePolicyState {
    pub revision: u64,
    pub defaults: RealtimeCommunicationPolicy,
    pub effective: RealtimeCommunicationPolicy,
}

impl Default for CurrentLiveRealtimePolicyState {
    fn default() -> Self {
        let defaults = current_live_realtime_communication_policy_defaults();
        Self {
            revision: 0,
            defaults: defaults.clone(),
            effective: defaults,
        }
    }
}

pub(crate) fn current_live_realtime_communication_policy_defaults() -> RealtimeCommunicationPolicy {
    RealtimeCommunicationPolicy {
        resource_batch_changed_enabled: true,
        scalar_sample_enabled: true,
        field_samples_enabled: true,
        scalar_table_rows_enabled: true,
        lifecycle_events_enabled: true,
        diagnostics_enabled: true,
        heartbeat_enabled: true,
        visualization_client_acks_enabled: true,
        ws_replay_capacity: CURRENT_LIVE_REALTIME_REPLAY_CAPACITY as u32,
        ws_heartbeat_ms: CURRENT_LIVE_REALTIME_HEARTBEAT_SECS.saturating_mul(1_000) as u32,
        ws_reconnect_ms: CURRENT_LIVE_REALTIME_RECONNECT_MS,
        lifecycle_coalesce_ms: CURRENT_LIVE_REALTIME_COALESCE_WINDOW_MS,
        table_rows_min_refetch_ms: CURRENT_LIVE_TABLE_ROWS_MIN_REFETCH_MS,
        field_sample_publish_ms: CURRENT_LIVE_REALTIME_FIELD_SAMPLE_COALESCE_WINDOW_MS,
        scalar_telemetry_publish_ms: CURRENT_LIVE_SCALAR_TELEMETRY_PUBLISH_MS,
        diagnostics_summary_ms: CURRENT_LIVE_REALTIME_DIAGNOSTICS_SUMMARY_WINDOW_MS,
        status_refresh_ms: CURRENT_LIVE_STATUS_REFRESH_MS,
        error_retry_ms: CURRENT_LIVE_ERROR_RETRY_MS,
    }
}

pub(crate) fn current_live_realtime_policy_resource(
    state: &CurrentLiveRealtimePolicyState,
) -> RealtimeCommunicationPolicyResource {
    RealtimeCommunicationPolicyResource {
        revision: state.revision,
        defaults: state.defaults.clone(),
        effective: state.effective.clone(),
    }
}

pub(crate) fn patch_current_live_realtime_policy(
    state: &mut CurrentLiveRealtimePolicyState,
    patch: RealtimeCommunicationPolicyPatch,
) -> Result<RealtimeCommunicationPolicyResource, ApiError> {
    let mut next = if patch.reset.unwrap_or(false) {
        state.defaults.clone()
    } else {
        state.effective.clone()
    };

    apply_bool(
        &mut next.resource_batch_changed_enabled,
        patch.resource_batch_changed_enabled,
    );
    apply_bool(&mut next.scalar_sample_enabled, patch.scalar_sample_enabled);
    apply_bool(&mut next.field_samples_enabled, patch.field_samples_enabled);
    apply_bool(
        &mut next.scalar_table_rows_enabled,
        patch.scalar_table_rows_enabled,
    );
    apply_bool(
        &mut next.lifecycle_events_enabled,
        patch.lifecycle_events_enabled,
    );
    apply_bool(&mut next.diagnostics_enabled, patch.diagnostics_enabled);
    apply_bool(&mut next.heartbeat_enabled, patch.heartbeat_enabled);
    apply_bool(
        &mut next.visualization_client_acks_enabled,
        patch.visualization_client_acks_enabled,
    );

    if let Some(value) = patch.ws_replay_capacity {
        next.ws_replay_capacity = bounded_u32("ws_replay_capacity", value, 1, 100_000)?;
    }
    if let Some(value) = patch.ws_heartbeat_ms {
        next.ws_heartbeat_ms = bounded_u32("ws_heartbeat_ms", value, 250, 300_000)?;
    }
    if let Some(value) = patch.ws_reconnect_ms {
        next.ws_reconnect_ms = bounded_u32("ws_reconnect_ms", value, 100, 300_000)?;
    }
    if let Some(value) = patch.lifecycle_coalesce_ms {
        next.lifecycle_coalesce_ms = bounded_u32("lifecycle_coalesce_ms", value, 0, 60_000)?;
    }
    if let Some(value) = patch.table_rows_min_refetch_ms {
        next.table_rows_min_refetch_ms =
            bounded_u32("table_rows_min_refetch_ms", value, 100, 300_000)?;
    }
    if let Some(value) = patch.field_sample_publish_ms {
        next.field_sample_publish_ms = bounded_u32("field_sample_publish_ms", value, 250, 300_000)?;
    }
    if let Some(value) = patch.scalar_telemetry_publish_ms {
        next.scalar_telemetry_publish_ms =
            bounded_u32("scalar_telemetry_publish_ms", value, 50, 60_000)?;
    }
    if let Some(value) = patch.diagnostics_summary_ms {
        next.diagnostics_summary_ms = bounded_u32("diagnostics_summary_ms", value, 250, 300_000)?;
    }
    if let Some(value) = patch.status_refresh_ms {
        next.status_refresh_ms = bounded_u32("status_refresh_ms", value, 250, 300_000)?;
    }
    if let Some(value) = patch.error_retry_ms {
        next.error_retry_ms = bounded_u32("error_retry_ms", value, 100, 300_000)?;
    }

    if next != state.effective {
        state.revision = state.revision.saturating_add(1);
        state.effective = next;
    }

    Ok(current_live_realtime_policy_resource(state))
}

fn apply_bool(target: &mut bool, value: Option<bool>) {
    if let Some(value) = value {
        *target = value;
    }
}

fn bounded_u32(name: &str, value: u32, min: u32, max: u32) -> Result<u32, ApiError> {
    if value < min || value > max {
        return Err(ApiError::bad_request(format!(
            "{name} must be between {min} and {max} ms/items"
        )));
    }
    Ok(value)
}
