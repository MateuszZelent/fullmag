//! Session state management: publish, refresh, default state.

use crate::artifacts::collect_artifacts;
use crate::error::ApiError;
use crate::quantities::{build_quantities, extract_fem_mesh_from_metadata};
use crate::router_v2::handlers::data::field_resolution::{
    field_values_hash, field_values_match_current_domain, flatten_json_field_values,
    json_field_grid, json_field_matches_current_domain, json_field_payload_signature,
    live_magnetization_values_ref,
};
use crate::router_v2::handlers::data::fields::{
    load_fdm_multilayer_airbox_carrier, resolved_fdm_multilayer_airbox_field,
};
use crate::router_v2::handlers::data::resolved_spatial_field::resolve_current_spatial_field;
use crate::router_v2::handlers::sessions::status::domain_generation_id;
use crate::types::*;
use fullmag_runner::{LivePreviewField, RuntimeStatus};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::{Path, PathBuf};

pub(crate) async fn current_live_session_id(state: &AppState) -> Result<String, ApiError> {
    let current = state.current_live_state.read().await;
    current
        .as_ref()
        .map(|snapshot| snapshot.session.session_id.clone())
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))
}

pub(crate) fn build_runtime_status_view(status_code: &str) -> RuntimeStatusView {
    let kind = RuntimeStatus::from_status_code(status_code);
    RuntimeStatusView {
        kind,
        code: status_code.to_string(),
        is_busy: kind.is_busy(),
        can_accept_commands: kind.can_accept_commands(),
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct CommandLedgerRevisions {
    pub commands_revision: u64,
    pub command_completion_revision: u64,
    pub command_queue_revision: u64,
}

pub(crate) fn command_queue_revision_from_parts(
    commands_revision: u64,
    command_completion_revision: u64,
) -> u64 {
    command_completion_revision.saturating_add(commands_revision)
}

pub(crate) fn command_ledger_revisions(
    ledger: &VecDeque<TrackedCommandRecord>,
) -> CommandLedgerRevisions {
    let commands_revision = ledger.len() as u64;
    let command_completion_revision = ledger
        .iter()
        .filter_map(|record| record.completed_at_unix_ms)
        .filter_map(|value| u64::try_from(value).ok())
        .max()
        .unwrap_or_else(|| ledger.back().map(|record| record.command.seq).unwrap_or(0));
    CommandLedgerRevisions {
        commands_revision,
        command_completion_revision,
        command_queue_revision: command_queue_revision_from_parts(
            commands_revision,
            command_completion_revision,
        ),
    }
}

pub(crate) fn effective_runtime_status_code(snapshot: &SessionStateResponse) -> String {
    if snapshot.session.status == "waiting_for_compute" {
        return snapshot.session.status.clone();
    }

    if let Some(stage_execution) = snapshot.stage_execution.as_ref() {
        return stage_execution.runtime_state.as_str().to_string();
    }

    snapshot
        .live_state
        .as_ref()
        .map(|state| state.status.clone())
        .unwrap_or_else(|| snapshot.session.status.clone())
}

pub(crate) fn refresh_runtime_status(snapshot: &mut SessionStateResponse) {
    snapshot.runtime_status = build_runtime_status_view(&effective_runtime_status_code(snapshot));
}

pub(crate) fn reconcile_command_ledger_from_stage_execution(
    ledger: &mut VecDeque<TrackedCommandRecord>,
    snapshot: &SessionStateResponse,
    completed_at_unix_ms: u128,
) -> bool {
    let Some(stage_execution) = snapshot.stage_execution.as_ref() else {
        return false;
    };

    let mut changed = false;
    for stage in &stage_execution.stages {
        let Some(command_id) = stage.command_id.as_deref() else {
            continue;
        };
        let Some(record) = ledger
            .iter_mut()
            .find(|record| record.command.command_id == command_id)
        else {
            continue;
        };
        changed |= reconcile_command_record_from_stage(record, stage, completed_at_unix_ms);
    }
    changed
}

pub(crate) fn reconcile_dispatched_command_ledger_from_snapshot(
    ledger: &mut VecDeque<TrackedCommandRecord>,
    snapshot: &SessionStateResponse,
    completed_at_unix_ms: u128,
) -> bool {
    let mut changed = false;
    for record in ledger.iter_mut() {
        if record.status != CommandLifecycleState::Dispatched || record.completion_status.is_some()
        {
            continue;
        }

        let Some(completion_status) = infer_dispatched_command_completion(record, snapshot) else {
            continue;
        };

        changed |= set_command_lifecycle(
            record,
            command_lifecycle_for_completion(completion_status),
            Some(completion_status),
            Some(completed_at_unix_ms),
        );
    }
    changed
}

fn infer_dispatched_command_completion(
    record: &TrackedCommandRecord,
    snapshot: &SessionStateResponse,
) -> Option<CommandCompletionState> {
    match record.command.kind.as_str() {
        "compute_fields" if command_has_terminal_log(record, snapshot, "Compute fields failed") => {
            Some(CommandCompletionState::Failed)
        }
        "compute_fields"
            if command_readiness_matches_requirements(record, snapshot)
                .ok()
                .is_some_and(|ready| ready) =>
        {
            Some(CommandCompletionState::Completed)
        }
        "compute_energies"
            if command_has_terminal_log(record, snapshot, "Compute energies failed") =>
        {
            Some(CommandCompletionState::Failed)
        }
        "compute_energies"
            if command_has_terminal_log(record, snapshot, "Energies computed")
                || !snapshot.scalar_rows.is_empty()
                || snapshot_runtime_accepts_commands(snapshot) =>
        {
            Some(CommandCompletionState::Completed)
        }
        "set_solver_profile"
            if command_has_terminal_log(record, snapshot, "Solver profiler command rejected") =>
        {
            Some(CommandCompletionState::Failed)
        }
        "set_solver_profile" if solver_profile_command_applied(record, snapshot) => {
            Some(CommandCompletionState::Completed)
        }
        "remesh" => remesh_command_completion(record, snapshot),
        "load_state"
            if command_has_terminal_log(record, snapshot, "Failed to load workspace state") =>
        {
            Some(CommandCompletionState::Failed)
        }
        "load_state"
            if command_has_terminal_log(record, snapshot, "Loaded workspace state from") =>
        {
            Some(CommandCompletionState::Completed)
        }
        "pause" if snapshot_runtime_is(snapshot, RuntimeLifecycleState::Paused) => {
            Some(CommandCompletionState::Completed)
        }
        "resume" if snapshot_runtime_resumed(snapshot) => Some(CommandCompletionState::Completed),
        "skip" if snapshot_has_skipped_stage(snapshot) || snapshot_runtime_is_idle(snapshot) => {
            Some(CommandCompletionState::Completed)
        }
        "stop" if snapshot_runtime_is_terminal_or_idle(snapshot) => {
            Some(CommandCompletionState::Completed)
        }
        "close" if snapshot_runtime_is(snapshot, RuntimeLifecycleState::Completed) => {
            Some(CommandCompletionState::Completed)
        }
        "run" | "relax" | "solve" if snapshot_runtime_is_terminal_or_idle(snapshot) => {
            if snapshot_runtime_is(snapshot, RuntimeLifecycleState::Failed)
                || command_has_terminal_log(record, snapshot, "failed")
                || command_has_terminal_log(record, snapshot, "Error")
            {
                Some(CommandCompletionState::Failed)
            } else if snapshot_runtime_is(snapshot, RuntimeLifecycleState::Cancelled)
                || command_has_terminal_log(record, snapshot, "cancelled")
            {
                Some(CommandCompletionState::Cancelled)
            } else {
                Some(CommandCompletionState::Completed)
            }
        }
        _ => None,
    }
}

fn command_lifecycle_for_completion(
    completion_status: CommandCompletionState,
) -> CommandLifecycleState {
    match completion_status {
        CommandCompletionState::Failed => CommandLifecycleState::Failed,
        CommandCompletionState::Rejected => CommandLifecycleState::Rejected,
        _ => CommandLifecycleState::Completed,
    }
}

fn command_has_terminal_log(
    record: &TrackedCommandRecord,
    snapshot: &SessionStateResponse,
    marker: &str,
) -> bool {
    let min_timestamp = record
        .dispatched_at_unix_ms
        .unwrap_or(record.command.created_at_unix_ms);
    snapshot
        .engine_log
        .iter()
        .any(|entry| entry.timestamp_unix_ms >= min_timestamp && entry.message.contains(marker))
}

pub(crate) fn command_readiness_matches_requirements(
    record: &TrackedCommandRecord,
    snapshot: &SessionStateResponse,
) -> Result<bool, String> {
    if record.command.kind != "compute_fields" {
        return Ok(true);
    }
    let requirements = &record.command.field_materialization_requirements;
    if requirements.is_empty() {
        return Ok(false);
    }
    let current_generation = domain_generation_id(snapshot);
    for requirement in requirements {
        if requirement.generation_id != current_generation {
            return Ok(false);
        }
        if requirement.quantity_ids.is_empty() {
            return Err(format!(
                "field materialization requirement for scope '{}' has no quantities",
                requirement.scope_kind
            ));
        }
        for quantity_id in &requirement.quantity_ids {
            let quantity = fullmag_quantities::quantity_spec(quantity_id)
                .ok_or_else(|| format!("unknown materialization quantity '{quantity_id}'"))?;
            if let Some(status) = snapshot.live_state.as_ref().and_then(|state| {
                state
                    .latest_step
                    .field_materialization_states
                    .iter()
                    .rev()
                    .find(|status| status.quantity == *quantity_id)
            }) {
                if status.state != fullmag_runner::LiveFieldMaterializationState::Complete {
                    return Ok(false);
                }
            }

            match requirement.scope_kind.as_str() {
                "full" => {
                    if requirement.scope_id.is_some() || requirement.carrier_fingerprint.is_some() {
                        return Err(
                            "full-domain materialization requirement has an invalid scope identity"
                                .to_string(),
                        );
                    }
                    let resolved = resolve_current_spatial_field(
                        snapshot,
                        quantity_id,
                        quantity.n_comp as usize,
                    )
                    .map_err(|error| error.to_string())?;
                    if resolved.is_none() {
                        return Ok(false);
                    }
                }
                "airbox" => {
                    if requirement.scope_id.as_deref() != Some("airbox") {
                        return Err(
                            "Airbox materialization requirement has an invalid scope identity"
                                .to_string(),
                        );
                    }
                    let Some(carrier) = load_fdm_multilayer_airbox_carrier(snapshot)
                        .map_err(|error| format!("Airbox carrier resolution failed: {error}"))?
                    else {
                        return Ok(false);
                    };
                    if !carrier.published_quantities.contains(quantity_id)
                        || carrier.unavailable_quantities.contains_key(quantity_id)
                    {
                        return Ok(false);
                    }
                    if requirement
                        .carrier_fingerprint
                        .as_deref()
                        .is_some_and(|expected| expected != carrier.carrier_fingerprint)
                    {
                        return Ok(false);
                    }
                    resolved_fdm_multilayer_airbox_field(
                        snapshot,
                        quantity_id,
                        quantity.n_comp as usize,
                        &carrier,
                    )
                    .map_err(|error| error.to_string())?;
                }
                other => {
                    return Err(format!("unsupported field materialization scope '{other}'"));
                }
            }
        }
    }
    Ok(true)
}

fn snapshot_runtime_accepts_commands(snapshot: &SessionStateResponse) -> bool {
    snapshot.runtime_status.can_accept_commands && !snapshot.runtime_status.is_busy
}

fn solver_profile_command_applied(
    record: &TrackedCommandRecord,
    snapshot: &SessionStateResponse,
) -> bool {
    if !command_has_terminal_log(record, snapshot, "Solver profiler ") {
        return false;
    }

    let Some(profile) = record.command.profile.clone() else {
        return false;
    };
    let Ok(requested) = serde_json::from_value::<fullmag_runner::SolverProfileConfig>(profile)
        .map(fullmag_runner::SolverProfileConfig::normalized)
    else {
        return false;
    };
    let actual = &snapshot.solver_profile.config;
    snapshot.solver_profile.revision > 0
        && actual.enabled == requested.enabled
        && actual.sample_every == requested.sample_every
        && actual.sample_interval_wall_ms == requested.sample_interval_wall_ms
        && actual.max_samples == requested.max_samples
        && actual.emit_engine_log == requested.emit_engine_log
        && actual.persist_artifact == requested.persist_artifact
}

fn remesh_command_completion(
    record: &TrackedCommandRecord,
    snapshot: &SessionStateResponse,
) -> Option<CommandCompletionState> {
    if command_has_terminal_log(record, snapshot, "Remesh failed")
        || command_has_terminal_log(record, snapshot, "Cannot remesh")
    {
        return Some(CommandCompletionState::Failed);
    }
    if command_has_terminal_log(record, snapshot, "Remesh complete") {
        return Some(CommandCompletionState::Completed);
    }
    None
}

fn snapshot_runtime_is(snapshot: &SessionStateResponse, expected: RuntimeLifecycleState) -> bool {
    snapshot
        .stage_execution
        .as_ref()
        .is_some_and(|stage_execution| stage_execution.runtime_state == expected)
        || effective_runtime_status_code(snapshot) == expected.as_str()
}

fn snapshot_runtime_resumed(snapshot: &SessionStateResponse) -> bool {
    if snapshot_runtime_is(snapshot, RuntimeLifecycleState::Paused) {
        return false;
    }

    snapshot
        .stage_execution
        .as_ref()
        .is_some_and(|stage_execution| {
            matches!(
                stage_execution.runtime_state,
                RuntimeLifecycleState::Running
                    | RuntimeLifecycleState::AwaitingCommand
                    | RuntimeLifecycleState::Completed
            )
        })
        || matches!(
            effective_runtime_status_code(snapshot).as_str(),
            "running" | "awaiting_command" | "completed"
        )
}

fn snapshot_has_skipped_stage(snapshot: &SessionStateResponse) -> bool {
    snapshot
        .stage_execution
        .as_ref()
        .is_some_and(|stage_execution| {
            stage_execution
                .stages
                .iter()
                .any(|stage| stage.status == StageLifecycleState::Skipped)
        })
}

fn snapshot_runtime_is_idle(snapshot: &SessionStateResponse) -> bool {
    snapshot
        .stage_execution
        .as_ref()
        .is_some_and(|stage_execution| {
            stage_execution.runtime_state == RuntimeLifecycleState::AwaitingCommand
                && stage_execution.active_stage_index.is_none()
        })
        || effective_runtime_status_code(snapshot)
            == RuntimeLifecycleState::AwaitingCommand.as_str()
}

fn snapshot_runtime_is_terminal_or_idle(snapshot: &SessionStateResponse) -> bool {
    snapshot
        .stage_execution
        .as_ref()
        .is_some_and(|stage_execution| {
            matches!(
                stage_execution.runtime_state,
                RuntimeLifecycleState::AwaitingCommand
                    | RuntimeLifecycleState::Completed
                    | RuntimeLifecycleState::Cancelled
                    | RuntimeLifecycleState::Failed
            ) && stage_execution.active_stage_index.is_none()
        })
        || matches!(
            effective_runtime_status_code(snapshot).as_str(),
            "awaiting_command" | "completed" | "cancelled" | "failed"
        )
}

fn reconcile_command_record_from_stage(
    record: &mut TrackedCommandRecord,
    stage: &StageExecutionRecord,
    completed_at_unix_ms: u128,
) -> bool {
    if matches!(
        record.status,
        CommandLifecycleState::Completed
            | CommandLifecycleState::Rejected
            | CommandLifecycleState::Failed
    ) {
        return false;
    }

    match stage.status {
        StageLifecycleState::Running | StageLifecycleState::Paused => {
            set_command_lifecycle(record, CommandLifecycleState::Running, None, None)
        }
        StageLifecycleState::Completed | StageLifecycleState::Skipped => set_command_lifecycle(
            record,
            CommandLifecycleState::Completed,
            Some(CommandCompletionState::Completed),
            Some(
                stage
                    .completed_at_unix_ms
                    .map(u128::from)
                    .unwrap_or(completed_at_unix_ms),
            ),
        ),
        StageLifecycleState::Cancelled | StageLifecycleState::Stopped => set_command_lifecycle(
            record,
            CommandLifecycleState::Completed,
            Some(CommandCompletionState::Cancelled),
            Some(
                stage
                    .completed_at_unix_ms
                    .map(u128::from)
                    .unwrap_or(completed_at_unix_ms),
            ),
        ),
        StageLifecycleState::Failed => set_command_lifecycle(
            record,
            CommandLifecycleState::Failed,
            Some(CommandCompletionState::Failed),
            Some(
                stage
                    .completed_at_unix_ms
                    .map(u128::from)
                    .unwrap_or(completed_at_unix_ms),
            ),
        ),
        StageLifecycleState::Pending | StageLifecycleState::Unknown => false,
    }
}

fn set_command_lifecycle(
    record: &mut TrackedCommandRecord,
    status: CommandLifecycleState,
    completion_status: Option<CommandCompletionState>,
    completed_at_unix_ms: Option<u128>,
) -> bool {
    let mut changed = false;
    if record.status != status {
        record.status = status;
        changed = true;
    }
    if record.completion_status != completion_status {
        record.completion_status = completion_status;
        changed = true;
    }
    if completed_at_unix_ms.is_some() && record.completed_at_unix_ms != completed_at_unix_ms {
        record.completed_at_unix_ms = completed_at_unix_ms;
        changed = true;
    }
    changed
}

fn merge_stage_execution_linkage(
    existing: Option<&StageExecutionState>,
    incoming: &mut StageExecutionState,
) {
    let Some(existing) = existing else {
        return;
    };

    for (index, incoming_record) in incoming.stages.iter_mut().enumerate() {
        let Some(existing_record) = existing.stages.get(index) else {
            continue;
        };
        let same_command = incoming_record.command_id.is_some()
            && incoming_record.command_id == existing_record.command_id;
        if !same_command {
            continue;
        }
        merge_stage_record_linkage(existing_record, incoming_record);
    }
}

fn merge_stage_record_linkage(
    existing: &StageExecutionRecord,
    incoming: &mut StageExecutionRecord,
) {
    for artifact_ref in &existing.artifact_refs {
        if !incoming
            .artifact_refs
            .iter()
            .any(|incoming_ref| incoming_ref == artifact_ref)
        {
            incoming.artifact_refs.push(artifact_ref.clone());
        }
    }
    if incoming.checkpoint_ref.is_none() {
        incoming.checkpoint_ref = existing.checkpoint_ref.clone();
    }
    if incoming.loaded_state_ref.is_none() {
        incoming.loaded_state_ref = existing.loaded_state_ref.clone();
    }
    if incoming.resume_from_checkpoint_ref.is_none() {
        incoming.resume_from_checkpoint_ref = existing.resume_from_checkpoint_ref.clone();
    }
    if incoming.state_transition.is_none() {
        incoming.state_transition = existing.state_transition.clone();
    }
    if incoming.state_transition_kind.is_none() {
        incoming.state_transition_kind = existing.state_transition_kind.clone();
    }
    if incoming.state_transition_reason.is_none() {
        incoming.state_transition_reason = existing.state_transition_reason.clone();
    }
    if incoming.state_transfer_operator_kind.is_none() {
        incoming.state_transfer_operator_kind = existing.state_transfer_operator_kind.clone();
    }
    if incoming.state_transition_ui_presentation.is_none() {
        incoming.state_transition_ui_presentation =
            existing.state_transition_ui_presentation.clone();
    }
    if incoming.progress_percent.is_none() {
        incoming.progress_percent = existing.progress_percent;
    }
    if incoming.progress_label.is_none() {
        incoming.progress_label = existing.progress_label.clone();
    }
    if incoming.progress_detail.is_none() {
        incoming.progress_detail = existing.progress_detail.clone();
    }
    if incoming.last_progress_unix_ms.is_none() {
        incoming.last_progress_unix_ms = existing.last_progress_unix_ms;
    }
}

fn next_revision(current: u64) -> u64 {
    current.wrapping_add(1).max(1)
}

fn bump_mesh_revision(current: &mut SessionStateResponse) {
    current.mesh_revision = next_revision(current.mesh_revision);
}

fn bump_mesh_build_revision(current: &mut SessionStateResponse) {
    current.mesh_build_revision = next_revision(current.mesh_build_revision);
}

fn bump_field_catalog_revision(current: &mut SessionStateResponse) {
    current.field_catalog_revision = next_revision(current.field_catalog_revision);
}

fn bump_stage_execution_revision(current: &mut SessionStateResponse) {
    current.stage_execution_revision = next_revision(current.stage_execution_revision);
}

fn field_payload_revision(value: &Value) -> Option<u64> {
    value
        .get("field_revision")
        .and_then(Value::as_u64)
        .or_else(|| value.get("revision").and_then(Value::as_u64))
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct FieldSourcePrecedence {
    pub(crate) source_step: u64,
    pub(crate) source_revision: u64,
    pub(crate) source_time_seconds: Option<f64>,
    pub(crate) materialized_at_unix_ms: u64,
}

impl FieldSourcePrecedence {
    fn scientific_cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.source_step
            .cmp(&other.source_step)
            .then_with(|| self.source_revision.cmp(&other.source_revision))
            .then_with(
                || match (self.source_time_seconds, other.source_time_seconds) {
                    (Some(left), Some(right)) => left.total_cmp(&right),
                    (Some(_), None) => std::cmp::Ordering::Greater,
                    (None, Some(_)) => std::cmp::Ordering::Less,
                    (None, None) => std::cmp::Ordering::Equal,
                },
            )
    }

    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.scientific_cmp(other).then_with(|| {
            self.materialized_at_unix_ms
                .cmp(&other.materialized_at_unix_ms)
        })
    }
}

pub(crate) fn latest_field_source_precedence(
    snapshot: &SessionStateResponse,
    value: &Value,
) -> FieldSourcePrecedence {
    FieldSourcePrecedence {
        source_step: value
            .get("source_step")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        source_revision: value
            .get("source_revision")
            .and_then(Value::as_u64)
            .or_else(|| field_payload_revision(value))
            .unwrap_or(0),
        source_time_seconds: valid_source_time(
            value.get("source_time_seconds").and_then(Value::as_f64),
        ),
        materialized_at_unix_ms: value
            .get("materialized_at_unix_ms")
            .and_then(Value::as_u64)
            .unwrap_or_else(|| {
                snapshot
                    .live_state
                    .as_ref()
                    .map(|state| state.updated_at_unix_ms.min(u64::MAX as u128) as u64)
                    .unwrap_or(0)
            }),
    }
}

pub(crate) fn preview_field_source_precedence(field: &LivePreviewField) -> FieldSourcePrecedence {
    FieldSourcePrecedence {
        source_step: field.source_step,
        source_revision: field.source_revision,
        source_time_seconds: valid_source_time(field.source_time_seconds),
        materialized_at_unix_ms: field.materialized_at_unix_ms,
    }
}

fn valid_source_time(source_time_seconds: Option<f64>) -> Option<f64> {
    source_time_seconds.filter(|time| time.is_finite() && *time >= 0.0)
}

pub(crate) fn preview_cache_precedes_latest(
    snapshot: &SessionStateResponse,
    quantity: &str,
) -> bool {
    let Some(preview) = snapshot.preview_cache.get(quantity) else {
        return false;
    };
    let Some(latest) = snapshot.latest_fields.get(quantity) else {
        return true;
    };
    // The preview cache is the explicit materialized-field channel. A genuinely
    // newer source generation wins first. Within one generation, complete
    // scientific-time provenance precedes wall-clock materialization time.
    // An exact tie keeps preview-cache authority.
    match preview_field_source_precedence(preview)
        .cmp(&latest_field_source_precedence(snapshot, latest))
    {
        std::cmp::Ordering::Greater => true,
        std::cmp::Ordering::Less => false,
        std::cmp::Ordering::Equal => true,
    }
}

fn bump_field_sample_revision(
    current: &mut SessionStateResponse,
    quantity: &str,
    baseline_revision: Option<u64>,
) {
    let entry = current
        .field_quantity_revisions
        .entry(quantity.to_string())
        .or_insert(0);
    let baseline_revision = baseline_revision.unwrap_or(0);
    if *entry == 0 {
        *entry = baseline_revision.max(1);
    } else if baseline_revision > *entry {
        *entry = baseline_revision;
    } else {
        *entry = next_revision(*entry);
    }
    if current.field_samples_revision == 0 {
        current.field_samples_revision = (*entry).max(1);
    } else {
        current.field_samples_revision = next_revision(current.field_samples_revision.max(*entry));
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum ResolvedCurrentFieldSource<'a> {
    Latest(&'a Value),
    Preview(&'a LivePreviewField),
    LegacyLiveMagnetization { values: &'a [f64], grid: [u32; 3] },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EffectiveFieldSourceKind {
    Latest,
    Preview,
    LegacyLiveMagnetization,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct EffectiveFieldSource {
    kind: EffectiveFieldSourceKind,
    source_step: Option<u64>,
    source_revision: Option<u64>,
    materialized_at_unix_ms: Option<u64>,
    baseline_revision: Option<u64>,
    config_revision: Option<u64>,
    value_count: usize,
    grid: [u32; 3],
    payload_hash: u64,
}

impl EffectiveFieldSource {
    fn baseline_revision(&self) -> Option<u64> {
        self.baseline_revision
    }
}

fn latest_field_has_explicit_provenance(value: &Value) -> bool {
    [
        "source_step",
        "source_revision",
        "materialized_at_unix_ms",
        "field_revision",
        "revision",
    ]
    .iter()
    .any(|key| value.get(*key).and_then(Value::as_u64).is_some())
}

pub(crate) fn resolved_current_field_source<'a>(
    snapshot: &'a SessionStateResponse,
    quantity: &str,
    n_comp: usize,
) -> Option<ResolvedCurrentFieldSource<'a>> {
    let latest = snapshot
        .latest_fields
        .get(quantity)
        .filter(|value| json_field_matches_current_domain(snapshot, quantity, n_comp, value));
    let preview = snapshot.preview_cache.get(quantity).filter(|field| {
        field_values_match_current_domain(snapshot, quantity, n_comp, &field.vector_field_values)
    });
    let cached_source = match (latest, preview) {
        (Some(_), Some(field)) if preview_cache_precedes_latest(snapshot, quantity) => {
            Some(ResolvedCurrentFieldSource::Preview(field))
        }
        (Some(value), _) => Some(ResolvedCurrentFieldSource::Latest(value)),
        (None, Some(field)) => Some(ResolvedCurrentFieldSource::Preview(field)),
        (None, None) => None,
    };

    let cached_source_is_authoritative = match cached_source {
        Some(ResolvedCurrentFieldSource::Preview(_)) => true,
        Some(ResolvedCurrentFieldSource::Latest(value)) => {
            latest_field_has_explicit_provenance(value)
        }
        Some(ResolvedCurrentFieldSource::LegacyLiveMagnetization { .. }) | None => false,
    };
    if quantity != "m" || cached_source_is_authoritative {
        return cached_source;
    }

    live_magnetization_values_ref(snapshot)
        .map(|(values, grid)| ResolvedCurrentFieldSource::LegacyLiveMagnetization { values, grid })
        .or(cached_source)
}

fn effective_field_source(
    snapshot: &SessionStateResponse,
    quantity: &str,
) -> Option<EffectiveFieldSource> {
    let n_comp = fullmag_quantities::quantity_spec(quantity)
        .map(|spec| spec.n_comp as usize)
        .unwrap_or(3);
    match resolved_current_field_source(snapshot, quantity, n_comp)? {
        ResolvedCurrentFieldSource::Latest(value) => {
            let (value_count, payload_hash) = json_field_payload_signature(value);
            let point_count = value_count / n_comp;
            Some(EffectiveFieldSource {
                kind: EffectiveFieldSourceKind::Latest,
                source_step: value.get("source_step").and_then(Value::as_u64),
                source_revision: value.get("source_revision").and_then(Value::as_u64),
                materialized_at_unix_ms: value
                    .get("materialized_at_unix_ms")
                    .and_then(Value::as_u64),
                baseline_revision: field_payload_revision(value),
                config_revision: None,
                value_count,
                grid: json_field_grid(value).unwrap_or([point_count as u32, 1, 1]),
                payload_hash,
            })
        }
        ResolvedCurrentFieldSource::Preview(field) => Some(EffectiveFieldSource {
            kind: EffectiveFieldSourceKind::Preview,
            source_step: Some(field.source_step),
            source_revision: Some(field.source_revision),
            materialized_at_unix_ms: Some(field.materialized_at_unix_ms),
            baseline_revision: None,
            config_revision: Some(field.config_revision),
            value_count: field.vector_field_values.len(),
            grid: field.preview_grid,
            payload_hash: field_values_hash(&field.vector_field_values),
        }),
        ResolvedCurrentFieldSource::LegacyLiveMagnetization { values, grid } => {
            Some(EffectiveFieldSource {
                kind: EffectiveFieldSourceKind::LegacyLiveMagnetization,
                source_step: None,
                source_revision: None,
                materialized_at_unix_ms: None,
                baseline_revision: None,
                config_revision: None,
                value_count: values.len(),
                grid,
                payload_hash: field_values_hash(values),
            })
        }
    }
}

fn capture_effective_field_sources(
    snapshot: &SessionStateResponse,
    quantities: &BTreeSet<String>,
) -> BTreeMap<String, Option<EffectiveFieldSource>> {
    quantities
        .iter()
        .map(|quantity| {
            (
                quantity.clone(),
                effective_field_source(snapshot, quantity.as_str()),
            )
        })
        .collect()
}

fn apply_effective_field_source_delta(
    current: &mut SessionStateResponse,
    previous_sources: BTreeMap<String, Option<EffectiveFieldSource>>,
) {
    let mut catalog_changed = false;
    for (quantity, previous_source) in previous_sources {
        let next_source = effective_field_source(current, quantity.as_str());
        if previous_source == next_source {
            continue;
        }
        if previous_source.is_some() != next_source.is_some() {
            catalog_changed = true;
        }
        if previous_source.is_some() || next_source.is_some() {
            let baseline_revision = next_source
                .as_ref()
                .and_then(EffectiveFieldSource::baseline_revision)
                .or_else(|| {
                    previous_source
                        .as_ref()
                        .and_then(EffectiveFieldSource::baseline_revision)
                });
            bump_field_sample_revision(current, quantity.as_str(), baseline_revision);
        }
    }
    if catalog_changed {
        bump_field_catalog_revision(current);
    }
}

fn stage_execution_changed(
    previous: Option<&StageExecutionState>,
    next: Option<&StageExecutionState>,
) -> bool {
    match (previous, next) {
        (None, None) => false,
        (None, Some(_)) | (Some(_), None) => true,
        (Some(prev), Some(next)) => {
            prev.runtime_state != next.runtime_state
                || prev.active_stage_index != next.active_stage_index
                || prev.active_stage_kind != next.active_stage_kind
                || prev.total_stages != next.total_stages
                || prev.completed_stage_indexes != next.completed_stage_indexes
                || prev.stage_statuses != next.stage_statuses
                || prev.stages != next.stages
        }
    }
}

fn mesh_statistics_signature(mesh_workspace: &Value) -> Value {
    mesh_workspace
        .get("mesh_statistics")
        .cloned()
        .or_else(|| {
            mesh_workspace
                .get("last_build_summary")
                .and_then(|summary| summary.get("mesh_statistics"))
                .cloned()
        })
        .unwrap_or(Value::Null)
}

fn mesh_resource_signature(mesh_workspace: &Value) -> Value {
    json!({
        "mesh_summary": mesh_workspace.get("mesh_summary").cloned().unwrap_or(Value::Null),
        "mesh_quality_summary": mesh_workspace.get("mesh_quality_summary").cloned().unwrap_or(Value::Null),
        "mesh_statistics": mesh_statistics_signature(mesh_workspace),
        "mesh_capabilities": mesh_workspace.get("mesh_capabilities").cloned().unwrap_or(Value::Null),
        "mesh_adaptivity_state": mesh_workspace.get("mesh_adaptivity_state").cloned().unwrap_or(Value::Null),
        "effective_airbox_target": mesh_workspace.get("effective_airbox_target").cloned().unwrap_or(Value::Null),
        "effective_per_object_targets": mesh_workspace
            .get("effective_per_object_targets")
            .cloned()
            .unwrap_or(Value::Null),
    })
}

fn mesh_build_resource_signature(mesh_workspace: &Value) -> Value {
    json!({
        "active_build": mesh_workspace.get("active_build").cloned().unwrap_or(Value::Null),
        "mesh_pipeline_status": mesh_workspace.get("mesh_pipeline_status").cloned().unwrap_or(Value::Null),
        "mesh_history": mesh_workspace.get("mesh_history").cloned().unwrap_or(Value::Null),
        "last_build_summary": mesh_workspace.get("last_build_summary").cloned().unwrap_or(Value::Null),
        "last_build_error": mesh_workspace.get("last_build_error").cloned().unwrap_or(Value::Null),
        "effective_airbox_target": mesh_workspace.get("effective_airbox_target").cloned().unwrap_or(Value::Null),
        "effective_per_object_targets": mesh_workspace
            .get("effective_per_object_targets")
            .cloned()
            .unwrap_or(Value::Null),
    })
}

fn apply_mesh_workspace_update(current: &mut SessionStateResponse, mesh_workspace: Value) {
    let previous_mesh_signature = current.mesh_workspace.as_ref().map(mesh_resource_signature);
    let previous_build_signature = current
        .mesh_workspace
        .as_ref()
        .map(mesh_build_resource_signature);
    let next_mesh_signature = mesh_resource_signature(&mesh_workspace);
    let next_build_signature = mesh_build_resource_signature(&mesh_workspace);
    if let Some(source_scene_revision) =
        successful_mesh_build_source_scene_revision(&mesh_workspace)
    {
        clear_mesh_dirty_tags_for_built_scene(current, source_scene_revision);
    }
    current.mesh_workspace = Some(mesh_workspace);
    if previous_build_signature.as_ref() != Some(&next_build_signature) {
        bump_mesh_build_revision(current);
    }
    if previous_mesh_signature.as_ref() != Some(&next_mesh_signature) {
        bump_mesh_revision(current);
    }
}

fn successful_mesh_build_source_scene_revision(mesh_workspace: &Value) -> Option<u64> {
    if mesh_workspace
        .get("active_build")
        .map(|value| !value.is_null())
        .unwrap_or(false)
    {
        return None;
    }
    if mesh_workspace
        .get("last_build_error")
        .and_then(Value::as_str)
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
    {
        return None;
    }
    let summary = mesh_workspace.get("last_build_summary")?;
    summary
        .get("source_scene_revision")
        .and_then(Value::as_u64)
        .or_else(|| {
            summary
                .get("geometry_realization")
                .and_then(|realization| realization.get("source_scene_revision"))
                .and_then(Value::as_u64)
        })
}

fn clear_mesh_dirty_tags_for_built_scene(
    current: &mut SessionStateResponse,
    source_scene_revision: u64,
) {
    let Some(scene) = current.scene_document.as_mut() else {
        return;
    };
    if scene.revision != source_scene_revision {
        return;
    }
    for object in &mut scene.objects {
        object.tags.retain(|tag| tag != "mesh:dirty");
    }
}

fn fem_mesh_identity(mesh: &fullmag_runner::FemMeshPayload) -> String {
    fullmag_runner::fem_mesh_topology_fingerprint(mesh)
}

fn is_solver_domain_fem_mesh(mesh: &fullmag_runner::FemMeshPayload) -> bool {
    !mesh.cells.is_empty()
}

fn apply_fem_mesh_update(
    current: &mut SessionStateResponse,
    fem_mesh: fullmag_runner::FemMeshPayload,
) {
    if !is_solver_domain_fem_mesh(&fem_mesh) {
        return;
    }

    let changed =
        current.fem_mesh.as_ref().map(fem_mesh_identity) != Some(fem_mesh_identity(&fem_mesh));
    if changed {
        clear_mesh_dirty_tags_for_solver_mesh(current, &fem_mesh);
    }
    current.fem_mesh = Some(fem_mesh);
    if changed {
        bump_mesh_revision(current);
        bump_mesh_build_revision(current);
    }
}

fn clear_mesh_dirty_tags_for_solver_mesh(
    current: &mut SessionStateResponse,
    mesh: &fullmag_runner::FemMeshPayload,
) {
    let Some(scene) = current.scene_document.as_mut() else {
        return;
    };
    let scene_object_ids = scene
        .objects
        .iter()
        .filter(|object| object.visible)
        .map(|object| object.id.clone())
        .collect::<BTreeSet<_>>();
    if scene_object_ids.is_empty() {
        return;
    }

    let mesh_object_ids = mesh
        .object_segments
        .iter()
        .map(|segment| segment.object_id.clone())
        .chain(
            mesh.mesh_parts
                .iter()
                .filter_map(|part| part.object_id.clone()),
        )
        .collect::<BTreeSet<_>>();
    if !scene_object_ids.is_subset(&mesh_object_ids) {
        return;
    }

    for object in &mut scene.objects {
        object.tags.retain(|tag| tag != "mesh:dirty");
    }
}

pub(crate) fn default_current_live_state(req: &CurrentLiveSnapshotRequest) -> SessionStateResponse {
    let now = unix_time_millis_now();
    let run_id = req
        .session
        .as_ref()
        .map(|session| session.run_id.clone())
        .or_else(|| req.run.as_ref().map(|run| run.run_id.clone()))
        .unwrap_or_else(|| format!("run-{}", req.session_id));
    let status = req
        .session
        .as_ref()
        .map(|session| session.status.clone())
        .or_else(|| req.session_status.clone())
        .or_else(|| req.live_state.as_ref().map(|state| state.status.clone()))
        .or_else(|| req.run.as_ref().map(|run| run.status.clone()))
        .unwrap_or_else(|| "bootstrapping".to_string());
    let artifact_dir = req
        .session
        .as_ref()
        .map(|session| session.artifact_dir.clone())
        .or_else(|| req.run.as_ref().map(|run| run.artifact_dir.clone()))
        .unwrap_or_default();

    let simulation_preparation_revision = req
        .simulation_preparation
        .as_ref()
        .map(|preparation| preparation.revision)
        .unwrap_or_default();

    SessionStateResponse {
        session_protocol_version: "2026-04-04".to_string(),
        capability_profile_version: "2026-04-04".to_string(),
        session: req.session.clone().unwrap_or(SessionManifest {
            session_id: req.session_id.clone(),
            run_id,
            status: status.clone(),
            interactive_session_requested: false,
            script_path: String::new(),
            problem_name: "Local Live Workspace".to_string(),
            requested_backend: "auto".to_string(),
            explicit_selection: false,
            authored_requested_device: "auto".to_string(),
            requested_device: "auto".to_string(),
            requested_precision: "double".to_string(),
            requested_mode: "strict".to_string(),
            requested_cpu_threads: None,
            execution_mode: "strict".to_string(),
            precision: "double".to_string(),
            resolved_backend: None,
            resolved_device: None,
            resolved_precision: None,
            resolved_mode: None,
            resolved_runtime_family: None,
            resolved_engine_id: None,
            resolved_worker: None,
            resolved_cpu_threads: None,
            resolved_fallback: None,
            fem_crossover_decision: None,
            artifact_dir,
            started_at_unix_ms: now,
            finished_at_unix_ms: now,
            plan_summary: serde_json::json!({}),
        }),
        run: None,
        live_state: None,
        coupled_checkpoint: req.coupled_checkpoint.clone(),
        runtime_status: build_runtime_status_view(&status),
        capabilities: None,
        metadata: None,
        mesh_workspace: None,
        stage_execution: None,
        simulation_preparation: req.simulation_preparation.clone(),
        scene_document: None,
        scalar_rows: Vec::new(),
        engine_log: Vec::new(),
        solver_profile: req.solver_profile.clone().unwrap_or_default(),
        quantities: Vec::new(),
        fem_mesh: None,
        latest_fields: LatestFields::default(),
        preview_cache: CachedPreviewFields::default(),
        artifacts: Vec::new(),
        display_selection: CurrentDisplaySelection::default(),
        preview_config: CurrentPreviewConfig::default(),
        preview: None,
        builder_adapter: None,
        state_version: 0,
        scalar_revision: 0,
        mesh_revision: 0,
        mesh_build_revision: 0,
        field_catalog_revision: 0,
        field_samples_revision: 0,
        field_quantity_revisions: BTreeMap::new(),
        accepted_terminal_field_generation: None,
        terminal_field_generations: BTreeMap::new(),
        stage_execution_revision: 0,
        simulation_preparation_revision,
        region_realization_revisions: fullmag_authoring::RegionRealizationRevisions::default(),
    }
}

fn merge_simulation_preparation(
    current: &mut SessionStateResponse,
    incoming: Option<SimulationPreparationSnapshot>,
) {
    let Some(incoming) = incoming else {
        return;
    };
    let should_replace = current
        .simulation_preparation
        .as_ref()
        .map(|existing| incoming.revision >= existing.revision)
        .unwrap_or(true);
    if should_replace {
        current.simulation_preparation_revision = incoming.revision;
        current.simulation_preparation = Some(incoming);
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct CurrentLiveApplyFlags {
    has_metadata: bool,
    has_latest_fields: bool,
    has_preview_fields: bool,
    has_run: bool,
    has_scalar_row: bool,
    clear_preview_cache: bool,
}

pub(crate) fn apply_current_live_metadata(current: &mut SessionStateResponse, metadata: Value) {
    current.metadata = Some(metadata);
    if let Some(metadata) = current.metadata.as_ref() {
        // A session can be reused while switching execution lanes.  The FEM
        // mesh is solver-domain state, not scene authoring geometry; retain it
        // only for a FEM execution plan so a stale FEM topology cannot make a
        // new FDM domain look like FEM to domain/field endpoints.
        let backend_is_fdm = metadata
            .get("execution_plan")
            .and_then(|plan| plan.get("backend_plan"))
            .and_then(|plan| plan.get("kind"))
            .and_then(Value::as_str)
            .is_some_and(|kind| kind.eq_ignore_ascii_case("fdm"))
            || metadata
                .get("artifact_layout")
                .and_then(|layout| layout.get("backend"))
                .and_then(Value::as_str)
                .is_some_and(|backend| backend.eq_ignore_ascii_case("fdm"));
        if backend_is_fdm {
            current.fem_mesh = None;
        }

        current.solver_profile.timestep_qualification = metadata
            .get("timestep_qualification")
            .map(|value| serde_json::from_value(value.clone()).unwrap_or_default());
        if let Some(value) = metadata.get("capabilities") {
            current.capabilities = serde_json::from_value(value.clone()).ok();
        }
        if let Some(value) = metadata
            .get("capability_profile_version")
            .and_then(serde_json::Value::as_str)
        {
            current.capability_profile_version = value.to_string();
        }
        if let Some(value) = metadata
            .get("session_protocol_version")
            .and_then(serde_json::Value::as_str)
        {
            current.session_protocol_version = value.to_string();
        }

        // REDO ETAP 4: Extract realized parameter fields from execution plan and populate latest_fields
        if let Some(plan_val) = metadata.get("execution_plan") {
            let mut ms_field = None;
            let mut a_field = None;
            let mut alpha_field = None;
            let mut dind_field = None;
            let mut dbulk_field = None;
            let mut fdm_grid = None;
            let mut sample_count = None;

            if let Some(backend_plan) = plan_val.get("backend_plan") {
                let kind = backend_plan
                    .get("kind")
                    .and_then(|k| k.as_str())
                    .unwrap_or("");
                if kind == "fdm" {
                    if let Some(material) = backend_plan.get("material") {
                        if let Some(val) = material
                            .get("ms_field")
                            .and_then(|v| serde_json::from_value::<Vec<f64>>(v.clone()).ok())
                        {
                            ms_field = Some(val);
                        } else if let Some(value) =
                            finite_material_scalar(material, "saturation_magnetisation")
                        {
                            ms_field = Some(vec![value; 1]);
                        }
                        if let Some(val) = material
                            .get("a_field")
                            .and_then(|v| serde_json::from_value::<Vec<f64>>(v.clone()).ok())
                        {
                            a_field = Some(val);
                        } else if let Some(value) =
                            finite_material_scalar(material, "exchange_stiffness")
                        {
                            a_field = Some(vec![value; 1]);
                        }
                        if let Some(val) = material
                            .get("alpha_field")
                            .and_then(|v| serde_json::from_value::<Vec<f64>>(v.clone()).ok())
                        {
                            alpha_field = Some(val);
                        } else if let Some(value) = finite_material_scalar(material, "damping") {
                            alpha_field = Some(vec![value; 1]);
                        }
                    }
                    if let Some(val) = backend_plan
                        .get("dind_field")
                        .and_then(|v| serde_json::from_value::<Vec<f64>>(v.clone()).ok())
                    {
                        dind_field = Some(val);
                    } else if let Some(value) =
                        finite_material_scalar(backend_plan, "interfacial_dmi")
                    {
                        dind_field = Some(vec![value; 1]);
                    }
                    if let Some(val) = backend_plan
                        .get("dbulk_field")
                        .and_then(|v| serde_json::from_value::<Vec<f64>>(v.clone()).ok())
                    {
                        dbulk_field = Some(val);
                    } else if let Some(value) = finite_material_scalar(backend_plan, "bulk_dmi") {
                        dbulk_field = Some(vec![value; 1]);
                    }
                    if let Some(grid) = backend_plan
                        .get("grid")
                        .and_then(|g| g.get("cells"))
                        .and_then(|c| serde_json::from_value::<[u32; 3]>(c.clone()).ok())
                    {
                        fdm_grid = Some(grid);
                        sample_count = material_field_grid_sample_count(grid);
                    }
                } else if kind == "fem" {
                    if let Some(material) = backend_plan.get("material") {
                        if let Some(val) = material
                            .get("ms_field")
                            .and_then(|v| serde_json::from_value::<Vec<f64>>(v.clone()).ok())
                        {
                            ms_field = Some(val);
                        } else if let Some(value) =
                            finite_material_scalar(material, "saturation_magnetisation")
                        {
                            ms_field = Some(vec![value; 1]);
                        }
                        if let Some(val) = material
                            .get("a_field")
                            .and_then(|v| serde_json::from_value::<Vec<f64>>(v.clone()).ok())
                        {
                            a_field = Some(val);
                        } else if let Some(value) =
                            finite_material_scalar(material, "exchange_stiffness")
                        {
                            a_field = Some(vec![value; 1]);
                        }
                        if let Some(val) = material
                            .get("alpha_field")
                            .and_then(|v| serde_json::from_value::<Vec<f64>>(v.clone()).ok())
                        {
                            alpha_field = Some(val);
                        } else if let Some(value) = finite_material_scalar(material, "damping") {
                            alpha_field = Some(vec![value; 1]);
                        }
                    }
                    if let Some(val) = backend_plan
                        .get("dind_field")
                        .and_then(|v| serde_json::from_value::<Vec<f64>>(v.clone()).ok())
                    {
                        dind_field = Some(val);
                    } else if let Some(value) =
                        finite_material_scalar(backend_plan, "interfacial_dmi")
                    {
                        dind_field = Some(vec![value; 1]);
                    }
                    if let Some(val) = backend_plan
                        .get("dbulk_field")
                        .and_then(|v| serde_json::from_value::<Vec<f64>>(v.clone()).ok())
                    {
                        dbulk_field = Some(val);
                    } else if let Some(value) = finite_material_scalar(backend_plan, "bulk_dmi") {
                        dbulk_field = Some(vec![value; 1]);
                    }
                    sample_count = current.fem_mesh.as_ref().map(|mesh| mesh.nodes.len());
                }
            }

            expand_uniform_material_field(&mut ms_field, sample_count);
            expand_uniform_material_field(&mut a_field, sample_count);
            expand_uniform_material_field(&mut alpha_field, sample_count);
            expand_uniform_material_field(&mut dind_field, sample_count);
            expand_uniform_material_field(&mut dbulk_field, sample_count);

            if let Some(vals) = ms_field {
                let val = if let Some(grid) = fdm_grid {
                    json!({
                        "layout": { "grid_cells": grid },
                        "values": vals
                    })
                } else {
                    json!({
                        "values": vals
                    })
                };
                current.latest_fields.insert("mat_ms".to_string(), val);
            }
            if let Some(vals) = a_field {
                let val = if let Some(grid) = fdm_grid {
                    json!({
                        "layout": { "grid_cells": grid },
                        "values": vals
                    })
                } else {
                    json!({
                        "values": vals
                    })
                };
                current.latest_fields.insert("mat_aex".to_string(), val);
            }
            if let Some(vals) = alpha_field {
                let val = if let Some(grid) = fdm_grid {
                    json!({
                        "layout": { "grid_cells": grid },
                        "values": vals
                    })
                } else {
                    json!({
                        "values": vals
                    })
                };
                current.latest_fields.insert("mat_alpha".to_string(), val);
            }
            if let Some(vals) = dind_field {
                let val = if let Some(grid) = fdm_grid {
                    json!({
                        "layout": { "grid_cells": grid },
                        "values": vals
                    })
                } else {
                    json!({
                        "values": vals
                    })
                };
                current.latest_fields.insert("mat_dind".to_string(), val);
            }
            if let Some(vals) = dbulk_field {
                let val = if let Some(grid) = fdm_grid {
                    json!({
                        "layout": { "grid_cells": grid },
                        "values": vals
                    })
                } else {
                    json!({
                        "values": vals
                    })
                };
                current.latest_fields.insert("mat_dbulk".to_string(), val);
            }
        }
    }
}

fn finite_material_scalar(value: &Value, key: &str) -> Option<f64> {
    value
        .get(key)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
}

fn material_field_grid_sample_count(grid: [u32; 3]) -> Option<usize> {
    grid.into_iter().try_fold(1usize, |count, axis| {
        let axis = usize::try_from(axis).ok()?;
        count.checked_mul(axis)
    })
}

fn expand_uniform_material_field(field: &mut Option<Vec<f64>>, sample_count: Option<usize>) {
    let Some(sample_count) = sample_count.filter(|count| *count > 1) else {
        return;
    };
    let Some(values) = field.as_mut() else {
        return;
    };
    if values.len() != 1 {
        return;
    }
    values.resize(sample_count, values[0]);
}

fn expand_uniform_material_latest_fields(latest_fields: &mut LatestFields, sample_count: usize) {
    if sample_count <= 1 {
        return;
    }
    for quantity in ["mat_ms", "mat_aex", "mat_alpha", "mat_dind", "mat_dbulk"] {
        let Some(value) = latest_fields.get(quantity) else {
            continue;
        };
        let values = flatten_json_field_values(value);
        if values.len() != 1 {
            continue;
        }
        latest_fields.insert(
            quantity.to_string(),
            json!({
                "values": vec![values[0]; sample_count]
            }),
        );
    }
}

fn finalize_current_live_apply(
    current: &mut SessionStateResponse,
    flags: CurrentLiveApplyFlags,
) -> Result<(), ApiError> {
    if let Some(run) = current.run.as_ref() {
        current.session.run_id = run.run_id.clone();
        if current.session.artifact_dir.is_empty() {
            current.session.artifact_dir = run.artifact_dir.clone();
        }
    }

    if current.fem_mesh.is_none() {
        current.fem_mesh = current
            .metadata
            .as_ref()
            .and_then(extract_fem_mesh_from_metadata);
    }
    if let Some(node_count) = current.fem_mesh.as_ref().map(|mesh| mesh.nodes.len()) {
        expand_uniform_material_latest_fields(&mut current.latest_fields, node_count);
    }

    if matches!(
        current.session.status.as_str(),
        "completed" | "failed" | "cancelled"
    ) {
        current.session.finished_at_unix_ms = unix_time_millis_now();
    }

    refresh_runtime_status(current);
    let quantities_inputs_changed = flags.has_metadata
        || flags.has_latest_fields
        || flags.has_preview_fields
        || flags.clear_preview_cache
        || flags.has_run
        || current.quantities.is_empty()
        || (flags.has_scalar_row && current.scalar_rows.len() == 1);
    if quantities_inputs_changed {
        let field_location = if current.fem_mesh.is_some() {
            "node"
        } else {
            "cell"
        };
        current.quantities = build_quantities(
            &current.latest_fields,
            &current.preview_cache,
            current.live_state.as_ref(),
            current.run.as_ref(),
            current.metadata.as_ref(),
            &current.scalar_rows,
            field_location,
        );
    }

    let finished = current
        .live_state
        .as_ref()
        .map(|state| state.latest_step.finished)
        .unwrap_or(false);
    let artifact_dir = current_artifact_dir(current);
    let membership_was_published =
        artifact_entries_include_complete_fdm_membership(&current.artifacts);
    let membership_appeared_on_disk = !membership_was_published
        && artifact_dir
            .as_deref()
            .is_some_and(artifact_dir_has_complete_fdm_membership);
    if finished || (current.artifacts.is_empty() && flags.has_run) || membership_appeared_on_disk {
        let mut artifacts = read_artifacts_from_dir(artifact_dir.as_deref())?;
        let membership_is_published = artifact_entries_include_complete_fdm_membership(&artifacts);
        if !membership_was_published && membership_is_published {
            current.region_realization_revisions = current.region_realization_revisions.advance(
                fullmag_authoring::RegionRealizationImpact {
                    membership: true,
                    ..fullmag_authoring::RegionRealizationImpact::default()
                },
            );
        }
        if let Some(provenance) = region_owned_artifact_provenance(current) {
            for artifact in &mut artifacts {
                if artifact.region_owned_provenance.is_none() {
                    artifact.region_owned_provenance = Some(provenance.clone());
                }
            }
        }
        current.artifacts = artifacts;
    }

    Ok(())
}

fn artifact_entries_include_complete_fdm_membership(artifacts: &[ArtifactEntry]) -> bool {
    let has = |path: &str| artifacts.iter().any(|artifact| artifact.path == path);
    (has("mesh/fdm_region_membership.v2.json") && has("mesh/fdm_region_membership.v2.bin"))
        || (has("mesh/fdm_region_membership.v1.json") && has("mesh/fdm_region_membership.v1.bin"))
}

fn artifact_dir_has_complete_fdm_membership(artifact_dir: &Path) -> bool {
    let has = |path: &str| artifact_dir.join(path).is_file();
    (has("mesh/fdm_region_membership.v2.json") && has("mesh/fdm_region_membership.v2.bin"))
        || (has("mesh/fdm_region_membership.v1.json") && has("mesh/fdm_region_membership.v1.bin"))
}

fn annotate_solver_profile_api_visibility(
    profile: &mut crate::schemas::diagnostics::SolverProfileResource,
    duration_ns: u64,
) {
    let revision = profile.revision;
    let Some(trace) = profile
        .latest_samples
        .iter_mut()
        .rev()
        .find_map(|sample| sample.trace.as_mut())
    else {
        return;
    };
    if trace.api_revision.is_some() {
        return;
    }
    trace.segments.insert(
        "api_revision_visibility_ns".to_string(),
        crate::schemas::diagnostics::SolverTraceSegmentResource {
            kind:
                crate::schemas::diagnostics::SolverTraceSegmentKindResource::ApiRevisionVisibility,
            duration_ns,
            clock_domain:
                crate::schemas::diagnostics::SolverTraceClockDomainResource::ServerMonotonic,
        },
    );
    trace.api_revision = Some(revision);
    if matches!(
        trace.completeness,
        crate::schemas::diagnostics::SolverTraceCompletenessResource::ServerOnly
    ) {
        trace.completeness = crate::schemas::diagnostics::SolverTraceCompletenessResource::Partial;
    }
}

fn annotate_solver_profile_publisher_apply(
    profile: &mut crate::schemas::diagnostics::SolverProfileResource,
    duration_ns: u64,
) {
    let Some(trace) = profile
        .latest_samples
        .iter_mut()
        .rev()
        .find_map(|sample| sample.trace.as_mut())
    else {
        return;
    };
    if trace.segments.contains_key("publisher_apply_ns") {
        return;
    }
    trace.segments.insert(
        "publisher_apply_ns".to_string(),
        crate::schemas::diagnostics::SolverTraceSegmentResource {
            kind: crate::schemas::diagnostics::SolverTraceSegmentKindResource::PublisherApply,
            duration_ns,
            clock_domain:
                crate::schemas::diagnostics::SolverTraceClockDomainResource::ServerMonotonic,
        },
    );
    if matches!(
        trace.completeness,
        crate::schemas::diagnostics::SolverTraceCompletenessResource::ServerOnly
    ) {
        trace.completeness = crate::schemas::diagnostics::SolverTraceCompletenessResource::Partial;
    }
}

enum TerminalFieldReplacementAdmission {
    Apply,
    Duplicate,
}

fn validate_terminal_field_replacement(
    current: &SessionStateResponse,
    replace_latest_fields: bool,
    latest_fields: Option<&LatestFields>,
    field_generation: Option<&CurrentLiveFieldGeneration>,
    clear_preview_cache: bool,
) -> Result<TerminalFieldReplacementAdmission, ApiError> {
    if !replace_latest_fields {
        return Ok(TerminalFieldReplacementAdmission::Apply);
    }
    if latest_fields.is_none() {
        return Err(ApiError::bad_request(
            "terminal_field_replace_requires_latest_fields",
        ));
    }
    if !clear_preview_cache {
        return Err(ApiError::bad_request(
            "terminal_field_replace_requires_preview_cache_clear",
        ));
    }
    let Some(incoming) = field_generation else {
        return Err(ApiError::bad_request(
            "terminal_field_replace_requires_generation",
        ));
    };
    if let Some(accepted) = current.accepted_terminal_field_generation.as_ref() {
        if accepted.run_id == incoming.run_id {
            if incoming.sequence < accepted.sequence {
                return Err(ApiError::conflict("stale_terminal_field_generation"));
            }
            if incoming.sequence == accepted.sequence {
                return Ok(TerminalFieldReplacementAdmission::Duplicate);
            }
        } else if current
            .terminal_field_generations
            .contains_key(&incoming.run_id)
        {
            return Err(ApiError::conflict("stale_terminal_field_generation"));
        }
    }
    Ok(TerminalFieldReplacementAdmission::Apply)
}

pub(crate) fn apply_current_live_snapshot(
    current: &mut SessionStateResponse,
    req: CurrentLiveSnapshotRequest,
) -> Result<(), ApiError> {
    let apply_start = std::time::Instant::now();
    if matches!(
        validate_terminal_field_replacement(
            current,
            req.replace_latest_fields,
            req.latest_fields.as_ref(),
            req.field_generation.as_ref(),
            req.clear_preview_cache,
        )?,
        TerminalFieldReplacementAdmission::Duplicate
    ) {
        return Ok(());
    }
    let mut affected_field_quantities = BTreeSet::new();
    if let Some(latest_fields) = req.latest_fields.as_ref() {
        affected_field_quantities.extend(
            latest_fields
                .entries()
                .map(|(quantity, _)| quantity.clone()),
        );
    }
    if req.replace_latest_fields {
        affected_field_quantities.extend(
            current
                .latest_fields
                .entries()
                .map(|(quantity, _)| quantity.clone()),
        );
    }
    if req.clear_preview_cache {
        affected_field_quantities.extend(
            current
                .preview_cache
                .iter()
                .map(|(quantity, _)| quantity.clone()),
        );
    }
    if let Some(preview_fields) = req.preview_fields.as_ref() {
        affected_field_quantities.extend(preview_fields.iter().map(|field| field.quantity.clone()));
    }
    if let Some(preview_field) = current
        .live_state
        .as_ref()
        .and_then(|live_state| live_state.latest_step.preview_field.as_ref())
    {
        affected_field_quantities.insert(preview_field.quantity.clone());
    }
    if req.live_state.is_some() || req.fem_mesh.is_some() {
        affected_field_quantities.insert("m".to_string());
    }
    if let Some(live_state) = req.live_state.as_ref() {
        if let Some(preview_field) = live_state.latest_step.preview_field.as_ref() {
            affected_field_quantities.insert(preview_field.quantity.clone());
        }
    }
    let previous_field_sources =
        capture_effective_field_sources(current, &affected_field_quantities);
    let previous_stage_execution = current.stage_execution.clone();
    let flags = CurrentLiveApplyFlags {
        has_metadata: req.metadata.is_some(),
        has_latest_fields: req.latest_fields.is_some(),
        has_preview_fields: req.preview_fields.is_some(),
        has_run: req.run.is_some(),
        has_scalar_row: req.latest_scalar_row.is_some(),
        clear_preview_cache: req.clear_preview_cache,
    };

    if let Some(session) = req.session {
        current.session = session;
    }
    current.session.session_id = req.session_id.clone();

    if let Some(status) = req.session_status {
        current.session.status = status;
    }
    if let Some(metadata) = req.metadata {
        apply_current_live_metadata(current, metadata);
    }
    if let Some(mesh_workspace) = req.mesh_workspace {
        apply_mesh_workspace_update(current, mesh_workspace);
    }
    merge_simulation_preparation(current, req.simulation_preparation);
    if let Some(mut stage_execution) = req.stage_execution {
        merge_stage_execution_linkage(current.stage_execution.as_ref(), &mut stage_execution);
        current.stage_execution = Some(stage_execution);
        if stage_execution_changed(
            previous_stage_execution.as_ref(),
            current.stage_execution.as_ref(),
        ) {
            bump_stage_execution_revision(current);
        }
    }
    if let Some(run) = req.run {
        current.session.run_id = run.run_id.clone();
        current.session.artifact_dir = run.artifact_dir.clone();
        current.run = Some(run);
    }
    if let Some(mut live_state) = req.live_state {
        if current.run.is_none() && current.session.status == "bootstrapping" {
            current.session.status = live_state.status.clone();
        }
        if let Some(fem_mesh) = live_state.latest_step.fem_mesh.take() {
            apply_fem_mesh_update(current, fem_mesh);
        }
        current.live_state = Some(live_state);
    }
    if let Some(coupled_checkpoint) = req.coupled_checkpoint {
        current.coupled_checkpoint = Some(coupled_checkpoint);
    }
    if let Some(fem_mesh) = req.fem_mesh {
        apply_fem_mesh_update(current, fem_mesh);
    }
    if let Some(row) = req.latest_scalar_row {
        if upsert_scalar_row(&mut current.scalar_rows, row) {
            current.scalar_revision = next_revision(current.scalar_revision);
        }
    }
    if let Some(latest_fields) = req.latest_fields {
        if req.replace_latest_fields {
            current.latest_fields = latest_fields;
        } else {
            merge_latest_fields(&mut current.latest_fields, latest_fields);
        }
    }
    if req.replace_latest_fields {
        if let Some(generation) = req.field_generation.as_ref() {
            current
                .terminal_field_generations
                .insert(generation.run_id.clone(), generation.sequence);
        }
        current.accepted_terminal_field_generation = req.field_generation;
    }
    if req.clear_preview_cache {
        current.preview_cache = CachedPreviewFields::default();
    }
    // Promote the active preview field into preview_cache so that API
    // query handlers (get_field_meta, get_field_vector, etc.) can find
    // it.  Without this, the field is only reachable via
    // live_state.latest_step.preview_field, which those handlers do not
    // consult, causing a 404 when the user switches to a non-"m" quantity.
    // This runs after a cache clear but before the explicit preview-field
    // batch. The latter is the terminal/cache-authoritative channel and must
    // win an equal-generation conflict with a carried active field.
    if !req.replace_latest_fields {
        if let Some(preview_field) = current
            .live_state
            .as_ref()
            .and_then(|ls| ls.latest_step.preview_field.clone())
        {
            merge_cached_preview_fields(&mut current.preview_cache, vec![preview_field]);
        }
    }
    if let Some(preview_fields) = req.preview_fields {
        merge_authoritative_cached_preview_fields(&mut current.preview_cache, preview_fields);
    }
    if let Some(engine_log) = req.engine_log {
        current.engine_log = engine_log;
    }
    let profile_visibility_start = std::time::Instant::now();
    if let Some(mut solver_profile) = req.solver_profile {
        if solver_profile.timestep_qualification.is_none() {
            solver_profile.timestep_qualification =
                current.solver_profile.timestep_qualification.clone();
        }
        current.solver_profile = solver_profile;
        annotate_solver_profile_api_visibility(
            &mut current.solver_profile,
            profile_visibility_start
                .elapsed()
                .as_nanos()
                .min(u128::from(u64::MAX)) as u64,
        );
    }
    apply_effective_field_source_delta(current, previous_field_sources);

    let result = finalize_current_live_apply(current, flags);
    if result.is_ok() {
        annotate_solver_profile_publisher_apply(
            &mut current.solver_profile,
            apply_start.elapsed().as_nanos().min(u128::from(u64::MAX)) as u64,
        );
    }
    result
}

pub(crate) fn apply_current_live_session_frame(
    current: &mut SessionStateResponse,
    frame: CurrentLiveSessionFrameRequest,
) -> Result<(), ApiError> {
    let previous_stage_execution = current.stage_execution.clone();
    let flags = CurrentLiveApplyFlags {
        has_metadata: frame.metadata.is_some(),
        has_run: frame.run.is_some(),
        ..CurrentLiveApplyFlags::default()
    };

    if let Some(session) = frame.session {
        current.session = session;
    }
    current.session.session_id = frame.session_id;

    if let Some(status) = frame.session_status {
        current.session.status = status;
    }
    if let Some(metadata) = frame.metadata {
        apply_current_live_metadata(current, metadata);
    }
    if let Some(mesh_workspace) = frame.mesh_workspace {
        apply_mesh_workspace_update(current, mesh_workspace);
    }
    merge_simulation_preparation(current, frame.simulation_preparation);
    if let Some(mut stage_execution) = frame.stage_execution {
        merge_stage_execution_linkage(current.stage_execution.as_ref(), &mut stage_execution);
        current.stage_execution = Some(stage_execution);
        if stage_execution_changed(
            previous_stage_execution.as_ref(),
            current.stage_execution.as_ref(),
        ) {
            bump_stage_execution_revision(current);
        }
    }
    if let Some(run) = frame.run {
        current.session.run_id = run.run_id.clone();
        current.session.artifact_dir = run.artifact_dir.clone();
        current.run = Some(run);
    }

    finalize_current_live_apply(current, flags)
}

pub(crate) fn apply_current_live_runtime_frame(
    current: &mut SessionStateResponse,
    frame: CurrentLiveRuntimeFrameRequest,
) -> Result<(), ApiError> {
    let apply_start = std::time::Instant::now();
    let mut affected_field_quantities = BTreeSet::new();
    if let Some(preview_field) = current
        .live_state
        .as_ref()
        .and_then(|live_state| live_state.latest_step.preview_field.as_ref())
    {
        affected_field_quantities.insert(preview_field.quantity.clone());
    }
    if frame.live_state.is_some() || frame.fem_mesh.is_some() {
        affected_field_quantities.insert("m".to_string());
    }
    if let Some(live_state) = frame.live_state.as_ref() {
        if let Some(preview_field) = live_state.latest_step.preview_field.as_ref() {
            affected_field_quantities.insert(preview_field.quantity.clone());
        }
    }
    let previous_field_sources =
        capture_effective_field_sources(current, &affected_field_quantities);
    if let Some(mut live_state) = frame.live_state {
        if current.run.is_none() && current.session.status == "bootstrapping" {
            current.session.status = live_state.status.clone();
        }
        if let Some(fem_mesh) = live_state.latest_step.fem_mesh.take() {
            apply_fem_mesh_update(current, fem_mesh);
        }
        // Preserve heavy payload fields from the previous state when the
        // incoming frame does not carry them.  The CLI only sends
        // magnetization every `field_every_n` steps (typically 50) but
        // publishes scalar progress every ~5 s.  Without this carry-forward
        // the API-side cached state loses magnetization on intermediate
        // frames, causing the control-room 3D viewport to show stale /
        // static textures and vectors.
        if let Some(prev) = current.live_state.as_ref() {
            if live_state.latest_step.magnetization.is_none() {
                live_state.latest_step.magnetization = prev.latest_step.magnetization.clone();
            }
            if live_state.latest_step.fem_mesh_generation_id.is_none() {
                live_state.latest_step.fem_mesh_generation_id =
                    prev.latest_step.fem_mesh_generation_id.clone();
            }
            if live_state.latest_step.preview_field.is_none() {
                live_state.latest_step.preview_field = prev.latest_step.preview_field.clone();
            }
        }
        // Promote the active preview field into preview_cache so that API
        // query handlers (get_field_meta, get_field_vector, etc.) can find
        // it — same rationale as in apply_current_live_snapshot.
        if let Some(preview_field) = live_state.latest_step.preview_field.clone() {
            merge_cached_preview_fields(&mut current.preview_cache, vec![preview_field]);
        }
        current.live_state = Some(live_state);
    }
    if let Some(fem_mesh) = frame.fem_mesh {
        apply_fem_mesh_update(current, fem_mesh);
    }
    if let Some(engine_log) = frame.engine_log {
        current.engine_log = engine_log;
    }
    let profile_visibility_start = std::time::Instant::now();
    if let Some(mut solver_profile) = frame.solver_profile {
        if solver_profile.timestep_qualification.is_none() {
            solver_profile.timestep_qualification =
                current.solver_profile.timestep_qualification.clone();
        }
        current.solver_profile = solver_profile;
        annotate_solver_profile_api_visibility(
            &mut current.solver_profile,
            profile_visibility_start
                .elapsed()
                .as_nanos()
                .min(u128::from(u64::MAX)) as u64,
        );
    }
    apply_effective_field_source_delta(current, previous_field_sources);

    let result = finalize_current_live_apply(current, CurrentLiveApplyFlags::default());
    if result.is_ok() {
        annotate_solver_profile_publisher_apply(
            &mut current.solver_profile,
            apply_start.elapsed().as_nanos().min(u128::from(u64::MAX)) as u64,
        );
    }
    result
}

pub(crate) fn apply_current_live_scalar_frame(
    current: &mut SessionStateResponse,
    frame: CurrentLiveScalarFrameRequest,
) -> Result<(), ApiError> {
    if let Some(row) = frame.latest_scalar_row {
        if upsert_scalar_row(&mut current.scalar_rows, row) {
            current.scalar_revision = next_revision(current.scalar_revision);
        }
    }

    finalize_current_live_apply(
        current,
        CurrentLiveApplyFlags {
            has_scalar_row: true,
            ..CurrentLiveApplyFlags::default()
        },
    )
}

pub(crate) fn apply_current_live_field_frame(
    current: &mut SessionStateResponse,
    frame: CurrentLiveFieldFrameRequest,
) -> Result<(), ApiError> {
    if matches!(
        validate_terminal_field_replacement(
            current,
            frame.replace_latest_fields,
            frame.latest_fields.as_ref(),
            frame.field_generation.as_ref(),
            frame.clear_preview_cache,
        )?,
        TerminalFieldReplacementAdmission::Duplicate
    ) {
        return Ok(());
    }
    let mut affected_field_quantities = BTreeSet::new();
    if let Some(latest_fields) = frame.latest_fields.as_ref() {
        affected_field_quantities.extend(
            latest_fields
                .entries()
                .map(|(quantity, _)| quantity.clone()),
        );
    }
    if frame.replace_latest_fields {
        affected_field_quantities.extend(
            current
                .latest_fields
                .entries()
                .map(|(quantity, _)| quantity.clone()),
        );
    }
    if frame.clear_preview_cache {
        affected_field_quantities.extend(
            current
                .preview_cache
                .iter()
                .map(|(quantity, _)| quantity.clone()),
        );
    }
    if let Some(preview_fields) = frame.preview_fields.as_ref() {
        affected_field_quantities.extend(preview_fields.iter().map(|field| field.quantity.clone()));
    }
    let previous_field_sources =
        capture_effective_field_sources(current, &affected_field_quantities);
    let has_latest_fields = frame.latest_fields.is_some();
    let has_preview_fields = frame.preview_fields.is_some();
    if let Some(latest_fields) = frame.latest_fields {
        if frame.replace_latest_fields {
            current.latest_fields = latest_fields;
        } else {
            merge_latest_fields(&mut current.latest_fields, latest_fields);
        }
    }
    if frame.replace_latest_fields {
        if let Some(generation) = frame.field_generation.as_ref() {
            current
                .terminal_field_generations
                .insert(generation.run_id.clone(), generation.sequence);
        }
        current.accepted_terminal_field_generation = frame.field_generation;
    }
    if frame.clear_preview_cache {
        current.preview_cache = CachedPreviewFields::default();
    }
    if let Some(preview_fields) = frame.preview_fields {
        // An explicit field frame is the cache-authoritative channel, just
        // like the explicit preview-field batch in a full snapshot. It must
        // replace a runtime-carried active preview at the same generation.
        merge_authoritative_cached_preview_fields(&mut current.preview_cache, preview_fields);
    }
    apply_effective_field_source_delta(current, previous_field_sources);

    finalize_current_live_apply(
        current,
        CurrentLiveApplyFlags {
            has_latest_fields,
            has_preview_fields,
            clear_preview_cache: frame.clear_preview_cache,
            ..CurrentLiveApplyFlags::default()
        },
    )
}

pub(crate) fn current_artifact_dir(current: &SessionStateResponse) -> Option<PathBuf> {
    let from_run = current
        .run
        .as_ref()
        .map(|run| run.artifact_dir.as_str())
        .filter(|path| !path.is_empty())
        .map(PathBuf::from);
    let from_session = (!current.session.artifact_dir.is_empty())
        .then(|| PathBuf::from(&current.session.artifact_dir));
    from_run.or(from_session)
}

pub(crate) fn read_artifacts_from_dir(
    artifact_dir: Option<&Path>,
) -> Result<Vec<ArtifactEntry>, ApiError> {
    let Some(artifact_dir) = artifact_dir else {
        return Ok(Vec::new());
    };
    if !artifact_dir.exists() {
        return Ok(Vec::new());
    }
    let mut artifacts = Vec::new();
    collect_artifacts(artifact_dir, artifact_dir, &mut artifacts)?;
    Ok(artifacts)
}

pub(crate) fn upsert_scalar_row(rows: &mut Vec<ScalarRow>, row: ScalarRow) -> bool {
    match rows.last_mut() {
        Some(last) if row.step < last.step => false,
        Some(last) if row.step == last.step => {
            *last = row;
            true
        }
        _ => {
            rows.push(row);
            true
        }
    }
}

pub(crate) fn merge_latest_fields(current: &mut LatestFields, incoming: LatestFields) {
    for (quantity, value) in incoming.into_inner() {
        current.insert(quantity, value);
    }
}

pub(crate) fn merge_cached_preview_fields(
    current: &mut CachedPreviewFields,
    incoming: Vec<LivePreviewField>,
) {
    merge_cached_preview_fields_with_precedence(
        current,
        incoming,
        CachedPreviewMergePrecedence::StrictlyNewer,
    );
}

fn merge_authoritative_cached_preview_fields(
    current: &mut CachedPreviewFields,
    incoming: Vec<LivePreviewField>,
) {
    merge_cached_preview_fields_with_precedence(
        current,
        incoming,
        CachedPreviewMergePrecedence::AuthoritativeEqualGeneration,
    );
}

#[derive(Clone, Copy)]
enum CachedPreviewMergePrecedence {
    StrictlyNewer,
    AuthoritativeEqualGeneration,
}

fn merge_cached_preview_fields_with_precedence(
    current: &mut CachedPreviewFields,
    incoming: Vec<LivePreviewField>,
    precedence: CachedPreviewMergePrecedence,
) {
    for field in incoming {
        let incoming_precedence = preview_field_source_precedence(&field);
        let should_insert = current.get(&field.quantity).is_none_or(|cached| {
            match incoming_precedence.scientific_cmp(&preview_field_source_precedence(cached)) {
                std::cmp::Ordering::Greater => true,
                std::cmp::Ordering::Less => false,
                std::cmp::Ordering::Equal => matches!(
                    precedence,
                    CachedPreviewMergePrecedence::AuthoritativeEqualGeneration
                ),
            }
        });
        if should_insert {
            current.insert(field);
        }
    }
}

pub(crate) fn unix_time_millis_now() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn api_visibility_annotation_binds_trace_to_profile_revision() {
        let mut runner_sample =
            fullmag_runner::SolverProfileStepSample::from_step_stats(&fullmag_runner::StepStats {
                step: 4,
                ..fullmag_runner::StepStats::default()
            });
        runner_sample.trace = Some(fullmag_runner::SolverTrace::server_only(
            fullmag_runner::SolverTraceId::new("run-1", 0, 4, 0).unwrap(),
        ));
        let mut profile = crate::schemas::diagnostics::SolverProfileResource::default();
        profile.revision = 17;
        profile.latest_samples =
            vec![serde_json::from_value(serde_json::to_value(runner_sample).unwrap()).unwrap()];

        annotate_solver_profile_api_visibility(&mut profile, 23);

        let trace = profile.latest_samples[0]
            .trace
            .as_ref()
            .expect("trace should be present");
        assert_eq!(trace.api_revision, Some(17));
        assert_eq!(
            trace.completeness,
            crate::schemas::diagnostics::SolverTraceCompletenessResource::Partial
        );
        assert_eq!(
            trace
                .segments
                .get("api_revision_visibility_ns")
                .expect("API visibility segment")
                .duration_ns,
            23
        );

        annotate_solver_profile_publisher_apply(&mut profile, 41);
        assert_eq!(
            profile.latest_samples[0]
                .trace
                .as_ref()
                .expect("trace should remain present")
                .segments
                .get("publisher_apply_ns")
                .expect("publisher apply segment")
                .duration_ns,
            41
        );
    }

    #[test]
    fn api_trace_annotations_do_not_relabel_profile_history() {
        let mut profile = crate::schemas::diagnostics::SolverProfileResource::default();
        profile.revision = 9;
        profile.latest_samples = (0..2)
            .map(|step| {
                let mut sample = fullmag_runner::SolverProfileStepSample::from_step_stats(
                    &fullmag_runner::StepStats {
                        step,
                        ..fullmag_runner::StepStats::default()
                    },
                );
                sample.trace = Some(fullmag_runner::SolverTrace::server_only(
                    fullmag_runner::SolverTraceId::new("run-1", 0, step, step).unwrap(),
                ));
                serde_json::from_value(serde_json::to_value(sample).unwrap()).unwrap()
            })
            .collect();

        annotate_solver_profile_api_visibility(&mut profile, 5);
        annotate_solver_profile_publisher_apply(&mut profile, 7);

        assert!(profile.latest_samples[0]
            .trace
            .as_ref()
            .expect("historical trace")
            .api_revision
            .is_none());
        assert!(profile.latest_samples[0]
            .trace
            .as_ref()
            .expect("historical trace")
            .segments
            .get("publisher_apply_ns")
            .is_none());
        let newest = profile.latest_samples[1]
            .trace
            .as_ref()
            .expect("newest trace");
        assert_eq!(newest.api_revision, Some(9));
        assert_eq!(newest.segments["publisher_apply_ns"].duration_ns, 7);
    }

    fn simulation_preparation(revision: u64) -> SimulationPreparationSnapshot {
        serde_json::from_value(json!({
            "preparation_id": "prep-test",
            "revision": revision,
            "status": "running",
            "active_stage_id": "validation",
            "started_at_unix_ms": 1_700_000_000_000_u64,
            "completed_at_unix_ms": null,
            "stages": [],
            "log_tail": [],
            "failure": null
        }))
        .expect("preparation fixture should deserialize")
    }

    #[test]
    fn current_session_keeps_newest_preparation_revision() {
        let mut current = default_current_live_state(&CurrentLiveSnapshotRequest {
            session_id: "test-session".to_string(),
            session: None,
            session_status: None,
            metadata: None,
            mesh_workspace: None,
            stage_execution: None,
            simulation_preparation: Some(simulation_preparation(7)),
            run: None,
            live_state: None,
            coupled_checkpoint: None,
            latest_scalar_row: None,
            latest_fields: None,
            replace_latest_fields: false,
            field_generation: None,
            preview_fields: None,
            clear_preview_cache: false,
            engine_log: None,
            solver_profile: None,
            fem_mesh: None,
        });

        apply_current_live_session_frame(
            &mut current,
            CurrentLiveSessionFrameRequest {
                session_id: "test-session".to_string(),
                session: None,
                session_status: None,
                metadata: None,
                mesh_workspace: None,
                stage_execution: None,
                simulation_preparation: Some(simulation_preparation(6)),
                run: None,
            },
        )
        .expect("older session frame should be accepted");

        assert_eq!(
            current
                .simulation_preparation
                .as_ref()
                .expect("preparation snapshot")
                .revision,
            7
        );
        assert_eq!(current.simulation_preparation_revision, 7);

        let mut equal_revision = simulation_preparation(7);
        equal_revision.status = "ready".to_string();
        apply_current_live_session_frame(
            &mut current,
            CurrentLiveSessionFrameRequest {
                session_id: "test-session".to_string(),
                session: None,
                session_status: None,
                metadata: None,
                mesh_workspace: None,
                stage_execution: None,
                simulation_preparation: Some(equal_revision),
                run: None,
            },
        )
        .expect("equal-revision session frame should be accepted");
        assert_eq!(
            current
                .simulation_preparation
                .as_ref()
                .expect("equal-revision preparation snapshot")
                .status,
            "ready"
        );

        apply_current_live_session_frame(
            &mut current,
            CurrentLiveSessionFrameRequest {
                session_id: "test-session".to_string(),
                session: None,
                session_status: None,
                metadata: None,
                mesh_workspace: None,
                stage_execution: None,
                simulation_preparation: Some(simulation_preparation(8)),
                run: None,
            },
        )
        .expect("newer session frame should be accepted");
        assert_eq!(
            current
                .simulation_preparation
                .as_ref()
                .expect("newer preparation snapshot")
                .revision,
            8
        );
        assert_eq!(current.simulation_preparation_revision, 8);
    }

    fn scalar_row(step: u64, e_total: f64) -> ScalarRow {
        ScalarRow {
            step,
            time: step as f64 * 1e-12,
            solver_dt: 1e-12,
            error_estimate: None,
            max_error: None,
            dt_suggested: None,
            rejected_attempts: 0,
            pseudo_time_s: None,
            active_runtime_s: None,
            mx: 0.0,
            my: 0.0,
            mz: 1.0,
            e_ex: 0.0,
            e_demag: 0.0,
            e_ext: 0.0,
            e_ani: 0.0,
            e_dmi: 0.0,
            e_total,
            max_dm_dt: 0.0,
            max_h_eff: 0.0,
            max_h_demag: 0.0,
            max_torque_Apm: 0.0,
            max_torque_T: 0.0,
            per_object_scalars: HashMap::new(),
            table_expressions: Vec::new(),
        }
    }

    fn live_state_with_magnetization(step: u64, magnetization: Vec<f64>) -> LiveState {
        LiveState {
            status: "running".to_string(),
            updated_at_unix_ms: 1_700_000_000_000 + step as u128,
            latest_step: StepUpdateView {
                step,
                time: step as f64 * 1e-12,
                dt: 1e-12,
                pseudo_time_s: None,
                e_ex: 0.0,
                e_demag: 0.0,
                e_ext: 0.0,
                e_ani: 0.0,
                e_dmi: 0.0,
                e_total: 0.0,
                max_dm_dt: 0.0,
                max_h_eff: 0.0,
                max_h_demag: 0.0,
                max_torque_Apm: 0.0,
                max_torque_T: 0.0,
                wall_time_ns: 0,
                grid: [2, 1, 1],
                fem_mesh_generation_id: None,
                fem_mesh: None,
                magnetization: Some(magnetization),
                per_object_scalars: Default::default(),
                field_materialization_states: Vec::new(),
                preview_field: None,
                finished: false,
            },
        }
    }

    #[test]
    fn upsert_scalar_row_replaces_latest_sample() {
        let mut rows = vec![scalar_row(1, 1.0), scalar_row(2, 2.0)];

        assert!(upsert_scalar_row(&mut rows, scalar_row(2, 3.0)));

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1].step, 2);
        assert_eq!(rows[1].e_total, 3.0);
    }

    #[test]
    fn upsert_scalar_row_rejects_older_samples() {
        let mut rows = vec![scalar_row(1, 1.0), scalar_row(3, 3.0)];

        assert!(!upsert_scalar_row(&mut rows, scalar_row(2, 2.0)));

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].step, 1);
        assert_eq!(rows[1].step, 3);
    }

    #[test]
    fn metadata_material_fields_use_canonical_preview_quantity_ids() {
        let mut current = default_current_live_state(&CurrentLiveSnapshotRequest {
            session_id: "test-session".to_string(),
            coupled_checkpoint: None,
            session: None,
            session_status: None,
            metadata: None,
            mesh_workspace: None,
            stage_execution: None,
            simulation_preparation: None,
            run: None,
            live_state: None,
            latest_scalar_row: None,
            latest_fields: None,
            replace_latest_fields: false,
            field_generation: None,
            preview_fields: None,
            clear_preview_cache: false,
            engine_log: None,
            solver_profile: None,
            fem_mesh: None,
        });

        current.fem_mesh = Some(domain_fem_mesh("stale-fem-domain"));
        apply_current_live_metadata(
            &mut current,
            json!({
                "execution_plan": {
                    "backend_plan": {
                        "kind": "fdm",
                        "grid": { "cells": [2, 1, 1] },
                        "material": {
                            "ms_field": [800000.0, 400000.0],
                            "a_field": [1.3e-11, 1.1e-11],
                            "alpha_field": [0.01, 0.02]
                        },
                        "dind_field": [0.0, 0.001],
                        "dbulk_field": [0.0, 1000.0]
                    }
                }
            }),
        );

        assert!(current.fem_mesh.is_none());
        assert!(current.latest_fields.get("mat_ms").is_some());
        assert!(current.latest_fields.get("mat_aex").is_some());
        assert!(current.latest_fields.get("mat_alpha").is_some());
        assert!(current.latest_fields.get("mat_dind").is_some());
        assert!(current.latest_fields.get("mat_dbulk").is_some());
        assert!(current.latest_fields.get("Ms").is_none());
        assert!(current.latest_fields.get("Aex").is_none());
    }

    #[test]
    fn metadata_uniform_material_constants_publish_material_quantities() {
        let mut current = default_current_live_state(&CurrentLiveSnapshotRequest {
            session_id: "test-session".to_string(),
            coupled_checkpoint: None,
            session: None,
            session_status: None,
            metadata: None,
            mesh_workspace: None,
            stage_execution: None,
            simulation_preparation: None,
            run: None,
            live_state: None,
            latest_scalar_row: None,
            latest_fields: None,
            replace_latest_fields: false,
            field_generation: None,
            preview_fields: None,
            clear_preview_cache: false,
            engine_log: None,
            solver_profile: None,
            fem_mesh: None,
        });

        apply_current_live_metadata(
            &mut current,
            json!({
                "execution_plan": {
                    "backend_plan": {
                        "kind": "fdm",
                        "grid": { "cells": [2, 2, 1] },
                        "material": {
                            "saturation_magnetisation": 800000.0,
                            "exchange_stiffness": 1.3e-11,
                            "damping": 0.02
                        }
                    }
                }
            }),
        );

        let ms_values = current
            .latest_fields
            .get("mat_ms")
            .map(flatten_json_field_values)
            .expect("uniform Ms should be published as material quantity");
        assert_eq!(ms_values, vec![800000.0; 4]);
        let aex_values = current
            .latest_fields
            .get("mat_aex")
            .map(flatten_json_field_values)
            .expect("uniform Aex should be published as material quantity");
        assert_eq!(aex_values, vec![1.3e-11; 4]);
        let alpha_values = current
            .latest_fields
            .get("mat_alpha")
            .map(flatten_json_field_values)
            .expect("uniform alpha should be published as material quantity");
        assert_eq!(alpha_values, vec![0.02; 4]);
    }

    #[test]
    fn surface_preview_mesh_update_does_not_replace_domain_mesh() {
        let mut current = test_current_snapshot();
        let domain_mesh = domain_fem_mesh("domain-gen-1");

        apply_fem_mesh_update(&mut current, domain_mesh);
        let mesh_revision = current.mesh_revision;

        apply_fem_mesh_update(&mut current, surface_preview_mesh());

        let mesh = current.fem_mesh.as_ref().expect("domain mesh is preserved");
        assert_eq!(mesh.mesh_id, "domain-mesh-id");
        assert_eq!(mesh.generation_id.as_deref(), Some("domain-gen-1"));
        assert_eq!(current.mesh_revision, mesh_revision);
    }

    #[test]
    fn runtime_frame_accepts_stage_mesh_once_and_preserves_it_across_steps() {
        let mut current = test_current_snapshot();
        let session_id = current.session.session_id.clone();
        apply_current_live_runtime_frame(
            &mut current,
            CurrentLiveRuntimeFrameRequest {
                session_id: session_id.clone(),
                live_state: None,
                engine_log: None,
                solver_profile: None,
                fem_mesh: Some(domain_fem_mesh("domain-gen-1")),
            },
        )
        .expect("initial stage mesh frame should apply");
        let mesh_revision = current.mesh_revision;

        for _ in 0..12 {
            apply_current_live_runtime_frame(
                &mut current,
                CurrentLiveRuntimeFrameRequest {
                    session_id: session_id.clone(),
                    live_state: None,
                    engine_log: None,
                    solver_profile: None,
                    fem_mesh: None,
                },
            )
            .expect("generation-only step frame should preserve stage mesh");
        }

        assert_eq!(current.mesh_revision, mesh_revision);
        assert_eq!(
            current
                .fem_mesh
                .as_ref()
                .and_then(|mesh| mesh.generation_id.as_deref()),
            Some("domain-gen-1")
        );
    }

    #[test]
    fn fem_mesh_identity_changes_for_same_count_connectivity_change() {
        let mut current = test_current_snapshot();
        let first_mesh = domain_fem_mesh("domain-gen-1");
        let mut remeshed = domain_fem_mesh("domain-gen-1");
        remeshed.set_tet4_cells(vec![[0, 1, 3, 2]]);

        apply_fem_mesh_update(&mut current, first_mesh);
        let mesh_revision = current.mesh_revision;
        let mesh_build_revision = current.mesh_build_revision;

        apply_fem_mesh_update(&mut current, remeshed);

        assert!(current.mesh_revision > mesh_revision);
        assert!(current.mesh_build_revision > mesh_build_revision);
    }

    #[test]
    fn fem_mesh_identity_ignores_non_topological_part_order_change() {
        let mut current = test_current_snapshot();
        let mut first_mesh = domain_fem_mesh("domain-gen-1");
        first_mesh.mesh_parts = vec![
            test_mesh_part("part:a", vec![0, 1, 2]),
            test_mesh_part("part:b", vec![1, 2, 3]),
        ];
        let mut remeshed = first_mesh.clone();
        remeshed.mesh_parts.swap(0, 1);

        apply_fem_mesh_update(&mut current, first_mesh);
        let mesh_revision = current.mesh_revision;
        let mesh_build_revision = current.mesh_build_revision;

        apply_fem_mesh_update(&mut current, remeshed);

        assert_eq!(current.mesh_revision, mesh_revision);
        assert_eq!(current.mesh_build_revision, mesh_build_revision);
    }

    #[test]
    fn mesh_statistics_update_bumps_mesh_revision() {
        let mut current = test_current_snapshot();

        apply_mesh_workspace_update(
            &mut current,
            json!({
                "mesh_summary": { "nodes": 4, "elements": 2 },
                "last_build_summary": {
                    "kind": "mesh_build_summary",
                    "mesh_statistics": {
                        "scopes": [
                            { "kind": "airbox", "marker": 0, "element_count": 10 }
                        ]
                    }
                }
            }),
        );
        let mesh_revision = current.mesh_revision;

        apply_mesh_workspace_update(
            &mut current,
            json!({
                "mesh_summary": { "nodes": 4, "elements": 2 },
                "last_build_summary": {
                    "kind": "mesh_build_summary",
                    "mesh_statistics": {
                        "scopes": [
                            { "kind": "airbox", "marker": 0, "element_count": 59_244 }
                        ]
                    }
                }
            }),
        );

        assert!(current.mesh_revision > mesh_revision);
    }

    #[test]
    fn indeterminate_mesh_heartbeat_bumps_only_build_revision() {
        let mut current = test_current_snapshot();
        apply_mesh_workspace_update(
            &mut current,
            json!({
                "mesh_summary": { "nodes": 4, "elements": 2 },
                "mesh_pipeline_status": [{
                    "id": "meshing",
                    "status": "active",
                    "duration_ms": 10_000,
                    "attempt_index": 2,
                    "algorithm_3d": "HXT",
                    "attempt_status": "active",
                    "progress_label": "Attempt 2 — HXT — progress indeterminate"
                }]
            }),
        );
        let mesh_revision = current.mesh_revision;
        let mesh_build_revision = current.mesh_build_revision;

        apply_mesh_workspace_update(
            &mut current,
            json!({
                "mesh_summary": { "nodes": 4, "elements": 2 },
                "mesh_pipeline_status": [{
                    "id": "meshing",
                    "status": "active",
                    "duration_ms": 25_000,
                    "attempt_index": 2,
                    "algorithm_3d": "HXT",
                    "attempt_status": "active",
                    "progress_label": "Attempt 2 — HXT — progress indeterminate"
                }]
            }),
        );

        assert_eq!(current.mesh_revision, mesh_revision);
        assert!(current.mesh_build_revision > mesh_build_revision);
    }

    #[test]
    fn scalar_frame_revisions_track_latest_replacements_not_stale_rows() {
        let mut current = default_current_live_state(&CurrentLiveSnapshotRequest {
            session_id: "test-session".to_string(),
            coupled_checkpoint: None,
            session: None,
            session_status: None,
            metadata: None,
            mesh_workspace: None,
            stage_execution: None,
            simulation_preparation: None,
            run: None,
            live_state: None,
            latest_scalar_row: None,
            latest_fields: None,
            replace_latest_fields: false,
            field_generation: None,
            preview_fields: None,
            clear_preview_cache: false,
            engine_log: None,
            solver_profile: None,
            fem_mesh: None,
        });

        apply_current_live_scalar_frame(
            &mut current,
            CurrentLiveScalarFrameRequest {
                session_id: "test-session".to_string(),
                latest_scalar_row: Some(scalar_row(2, 2.0)),
            },
        )
        .expect("first scalar frame should apply");
        assert_eq!(current.scalar_revision, 1);
        assert_eq!(current.scalar_rows.len(), 1);

        apply_current_live_scalar_frame(
            &mut current,
            CurrentLiveScalarFrameRequest {
                session_id: "test-session".to_string(),
                latest_scalar_row: Some(scalar_row(2, 3.0)),
            },
        )
        .expect("latest scalar replacement should apply");
        assert_eq!(current.scalar_revision, 2);
        assert_eq!(current.scalar_rows.len(), 1);
        assert_eq!(current.scalar_rows[0].e_total, 3.0);

        apply_current_live_scalar_frame(
            &mut current,
            CurrentLiveScalarFrameRequest {
                session_id: "test-session".to_string(),
                latest_scalar_row: Some(scalar_row(1, 1.0)),
            },
        )
        .expect("stale scalar frame should be ignored without failing");
        assert_eq!(current.scalar_revision, 2);
        assert_eq!(current.scalar_rows.len(), 1);
        assert_eq!(current.scalar_rows[0].step, 2);
    }

    #[test]
    fn live_magnetization_revision_tracks_runtime_values_when_latest_field_exists() {
        let mut current = test_current_snapshot();
        let stale_latest_fields: LatestFields = serde_json::from_value(json!({
            "m": {
                "values": [
                    [9.0, 9.0, 9.0],
                    [8.0, 8.0, 8.0]
                ],
                "layout": {
                    "grid_cells": [2, 1, 1]
                }
            }
        }))
        .expect("mock latest_fields should deserialize");

        apply_current_live_snapshot(
            &mut current,
            CurrentLiveSnapshotRequest {
                session_id: "test-session".to_string(),
                coupled_checkpoint: None,
                session: None,
                session_status: None,
                metadata: None,
                mesh_workspace: None,
                stage_execution: None,
                simulation_preparation: None,
                run: None,
                live_state: Some(live_state_with_magnetization(
                    1,
                    vec![1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
                )),
                latest_scalar_row: None,
                latest_fields: Some(stale_latest_fields),
                replace_latest_fields: false,
                field_generation: None,
                preview_fields: None,
                clear_preview_cache: false,
                engine_log: None,
                solver_profile: None,
                fem_mesh: None,
            },
        )
        .expect("initial live frame should apply");
        let first_quantity_revision = current
            .field_quantity_revisions
            .get("m")
            .copied()
            .expect("live magnetization should publish a quantity revision");
        let first_sample_revision = current.field_samples_revision;

        apply_current_live_snapshot(
            &mut current,
            CurrentLiveSnapshotRequest {
                session_id: "test-session".to_string(),
                coupled_checkpoint: None,
                session: None,
                session_status: None,
                metadata: None,
                mesh_workspace: None,
                stage_execution: None,
                simulation_preparation: None,
                run: None,
                live_state: Some(live_state_with_magnetization(
                    10,
                    vec![0.0, 1.0, 0.0, -1.0, 0.0, 0.0],
                )),
                latest_scalar_row: None,
                latest_fields: None,
                replace_latest_fields: false,
                field_generation: None,
                preview_fields: None,
                clear_preview_cache: false,
                engine_log: None,
                solver_profile: None,
                fem_mesh: None,
            },
        )
        .expect("updated live frame should apply");

        assert!(
            current.field_quantity_revisions["m"] > first_quantity_revision,
            "live magnetization must bump the m field revision even when stale latest_fields.m remains"
        );
        assert!(
            current.field_samples_revision > first_sample_revision,
            "field samples revision must advance so realtime emits fields:samples and field-vector ETags change"
        );
    }

    #[test]
    fn stage_execution_reconciliation_marks_matching_command_terminal() {
        let mut current = default_current_live_state(&CurrentLiveSnapshotRequest {
            session_id: "test-session".to_string(),
            coupled_checkpoint: None,
            session: None,
            session_status: None,
            metadata: None,
            mesh_workspace: None,
            stage_execution: None,
            simulation_preparation: None,
            run: None,
            live_state: None,
            latest_scalar_row: None,
            latest_fields: None,
            replace_latest_fields: false,
            field_generation: None,
            preview_fields: None,
            clear_preview_cache: false,
            engine_log: None,
            solver_profile: None,
            fem_mesh: None,
        });
        current.stage_execution = Some(StageExecutionState {
            total_stages: 1,
            completed_stage_indexes: vec![0],
            stages: vec![StageExecutionRecord {
                stage_id: None,
                kind: None,
                status: StageLifecycleState::Completed,
                command_id: Some("cmd-stage-0".into()),
                started_at_unix_ms: Some(1_700_000_000_000),
                completed_at_unix_ms: Some(1_700_000_001_000),
                reason: None,
                converged: false,
                metric: None,
                artifact_refs: Vec::new(),
                checkpoint_ref: None,
                loaded_state_ref: None,
                resume_from_checkpoint_ref: None,
                state_transition: None,
                state_transition_kind: None,
                state_transition_reason: None,
                state_transfer_operator_kind: None,
                state_transition_ui_presentation: None,
                metric_name: None,
                metric_value: None,
                threshold: None,
                progress_percent: None,
                progress_label: None,
                progress_detail: None,
                last_progress_unix_ms: None,
                current_field_m_t: None,
                current_point_index: None,
                current_settle_step_index: None,
                current_settle_step_kind: None,
                current_settle_step_method: None,
            }],
            stage_statuses: vec![StageLifecycleState::Completed],
            active_stage_index: None,
            active_stage_kind: None,
            runtime_state: RuntimeLifecycleState::Completed,
        });

        let mut ledger = VecDeque::from([TrackedCommandRecord {
            command: session_command("cmd-stage-0", "run"),
            request_id: None,
            status: CommandLifecycleState::Dispatched,
            dispatched_at_unix_ms: Some(1_700_000_000_500),
            completed_at_unix_ms: None,
            completion_status: None,
            error: None,
        }]);

        assert!(reconcile_command_ledger_from_stage_execution(
            &mut ledger,
            &current,
            1_700_000_002_000
        ));

        let record = ledger.front().expect("ledger record should remain");
        assert_eq!(record.status, CommandLifecycleState::Completed);
        assert_eq!(
            record.completion_status,
            Some(CommandCompletionState::Completed)
        );
        assert_eq!(record.completed_at_unix_ms, Some(1_700_000_001_000));
    }

    #[test]
    fn snapshot_reconciliation_marks_compute_commands_terminal() {
        let mut current = test_current_snapshot();
        current.metadata = Some(json!({
            "artifact_layout": {
                "backend": "fdm",
                "grid_cells": [1, 1, 1]
            }
        }));
        current.latest_fields =
            serde_json::from_value(json!({"m": {"generation": 1}})).expect("valid fields fixture");
        current.scalar_rows.push(scalar_row(1, 2.0));

        let mut fields_command = tracked_command("cmd-fields", "compute_fields");
        fields_command.command.field_materialization_requirements =
            vec![crate::schemas::runtime::FieldMaterializationRequirement {
                quantity_ids: vec!["m".to_string()],
                scope_kind: "full".to_string(),
                scope_id: None,
                generation_id: domain_generation_id(&current),
                carrier_fingerprint: None,
            }];
        merge_cached_preview_fields(&mut current.preview_cache, vec![preview_field("m")]);
        let mut ledger = VecDeque::from([
            fields_command,
            tracked_command("cmd-energies", "compute_energies"),
        ]);

        assert!(reconcile_dispatched_command_ledger_from_snapshot(
            &mut ledger,
            &current,
            1_700_000_002_000
        ));

        for record in ledger {
            assert_eq!(record.status, CommandLifecycleState::Completed);
            assert_eq!(
                record.completion_status,
                Some(CommandCompletionState::Completed)
            );
            assert_eq!(record.completed_at_unix_ms, Some(1_700_000_002_000));
        }
    }

    #[test]
    fn snapshot_reconciliation_marks_ready_compute_energies_terminal_without_scalar_rows() {
        let mut current = test_current_snapshot();
        current.session.status = "waiting_for_compute".to_string();
        current.runtime_status = build_runtime_status_view("waiting_for_compute");

        let mut ledger = VecDeque::from([tracked_command("cmd-energies", "compute_energies")]);

        assert!(reconcile_dispatched_command_ledger_from_snapshot(
            &mut ledger,
            &current,
            1_700_000_002_000
        ));

        let record = ledger.front().expect("ledger record should remain");
        assert_eq!(record.status, CommandLifecycleState::Completed);
        assert_eq!(
            record.completion_status,
            Some(CommandCompletionState::Completed)
        );
        assert_eq!(record.completed_at_unix_ms, Some(1_700_000_002_000));
    }

    #[test]
    fn runtime_status_prefers_waiting_for_compute_gate_over_stale_live_state() {
        let mut current = test_current_snapshot();
        current.session.status = "waiting_for_compute".to_string();
        current.live_state = Some(LiveState {
            status: "running".to_string(),
            updated_at_unix_ms: 1_700_000_000_000,
            latest_step: StepUpdateView {
                step: 0,
                time: 0.0,
                dt: 0.0,
                pseudo_time_s: None,
                e_ex: 0.0,
                e_demag: 0.0,
                e_ext: 0.0,
                e_ani: 0.0,
                e_dmi: 0.0,
                e_total: 0.0,
                max_dm_dt: 0.0,
                max_h_eff: 0.0,
                max_h_demag: 0.0,
                max_torque_Apm: 0.0,
                max_torque_T: 0.0,
                wall_time_ns: 0,
                grid: [1, 1, 1],
                fem_mesh_generation_id: None,
                fem_mesh: None,
                magnetization: None,
                per_object_scalars: Default::default(),
                field_materialization_states: Vec::new(),
                preview_field: None,
                finished: false,
            },
        });

        refresh_runtime_status(&mut current);

        assert_eq!(
            effective_runtime_status_code(&current),
            "waiting_for_compute"
        );
        assert_eq!(
            current.runtime_status.kind,
            RuntimeStatus::WaitingForCompute
        );
        assert!(!current.runtime_status.is_busy);
        assert!(current.runtime_status.can_accept_commands);
    }

    #[test]
    fn runtime_status_prefers_stage_execution_over_stale_live_state() {
        let mut current = test_current_snapshot();
        current.session.status = "awaiting_command".to_string();
        current.stage_execution = Some(test_stage_execution(
            RuntimeLifecycleState::AwaitingCommand,
            None,
            StageLifecycleState::Skipped,
        ));
        current.live_state = Some(LiveState {
            status: "paused".to_string(),
            updated_at_unix_ms: 1_700_000_000_000,
            latest_step: StepUpdateView {
                step: 0,
                time: 0.0,
                dt: 0.0,
                pseudo_time_s: None,
                e_ex: 0.0,
                e_demag: 0.0,
                e_ext: 0.0,
                e_ani: 0.0,
                e_dmi: 0.0,
                e_total: 0.0,
                max_dm_dt: 0.0,
                max_h_eff: 0.0,
                max_h_demag: 0.0,
                max_torque_Apm: 0.0,
                max_torque_T: 0.0,
                wall_time_ns: 0,
                grid: [1, 1, 1],
                fem_mesh_generation_id: None,
                fem_mesh: None,
                magnetization: None,
                per_object_scalars: Default::default(),
                field_materialization_states: Vec::new(),
                preview_field: None,
                finished: false,
            },
        });

        refresh_runtime_status(&mut current);

        assert_eq!(effective_runtime_status_code(&current), "awaiting_command");
        assert_eq!(current.runtime_status.kind, RuntimeStatus::AwaitingCommand);
        assert!(!current.runtime_status.is_busy);
        assert!(current.runtime_status.can_accept_commands);
    }

    #[test]
    fn snapshot_reconciliation_does_not_complete_compute_fields_from_unrelated_preview_cache() {
        let mut current = test_current_snapshot();
        merge_cached_preview_fields(&mut current.preview_cache, vec![preview_field("m")]);

        let mut ledger = VecDeque::from([tracked_command("cmd-fields", "compute_fields")]);

        assert!(!reconcile_dispatched_command_ledger_from_snapshot(
            &mut ledger,
            &current,
            1_700_000_002_000
        ));

        let record = ledger.front().expect("ledger record should remain");
        assert_eq!(record.status, CommandLifecycleState::Dispatched);
        assert_eq!(record.completion_status, None);
        assert_eq!(record.completed_at_unix_ms, None);
    }

    #[test]
    fn snapshot_reconciliation_requires_each_requested_quantity_for_current_generation() {
        let mut current = test_current_snapshot();
        current.metadata = Some(json!({
            "artifact_layout": {
                "backend": "fdm",
                "grid_cells": [1, 1, 1]
            }
        }));
        let generation_id = domain_generation_id(&current);
        let mut command = session_command("cmd-fields", "compute_fields");
        command.field_materialization_requirements =
            vec![crate::schemas::runtime::FieldMaterializationRequirement {
                quantity_ids: vec!["H_demag".to_string()],
                scope_kind: "full".to_string(),
                scope_id: None,
                generation_id,
                carrier_fingerprint: None,
            }];
        merge_cached_preview_fields(&mut current.preview_cache, vec![preview_field("m")]);
        let mut ledger = VecDeque::from([TrackedCommandRecord {
            command,
            request_id: None,
            status: CommandLifecycleState::Dispatched,
            dispatched_at_unix_ms: Some(1_700_000_000_500),
            completed_at_unix_ms: None,
            completion_status: None,
            error: None,
        }]);

        assert!(!reconcile_dispatched_command_ledger_from_snapshot(
            &mut ledger,
            &current,
            1_700_000_002_000
        ));

        merge_cached_preview_fields(&mut current.preview_cache, vec![preview_field("H_demag")]);
        assert!(reconcile_dispatched_command_ledger_from_snapshot(
            &mut ledger,
            &current,
            1_700_000_003_000
        ));
        assert_eq!(
            ledger.front().and_then(|record| record.completion_status),
            Some(CommandCompletionState::Completed)
        );
    }

    #[test]
    fn snapshot_reconciliation_does_not_accept_pending_materialization_status() {
        let mut current = test_current_snapshot();
        let generation_id = domain_generation_id(&current);
        let mut command = session_command("cmd-fields", "compute_fields");
        command.field_materialization_requirements =
            vec![crate::schemas::runtime::FieldMaterializationRequirement {
                quantity_ids: vec!["H_demag".to_string()],
                scope_kind: "full".to_string(),
                scope_id: None,
                generation_id,
                carrier_fingerprint: None,
            }];
        merge_cached_preview_fields(&mut current.preview_cache, vec![preview_field("H_demag")]);
        let mut live_state = live_state_with_magnetization(0, vec![1.0, 0.0, 0.0]);
        live_state.latest_step.field_materialization_states =
            vec![fullmag_runner::LiveFieldMaterializationStatus {
                quantity: "H_demag".to_string(),
                source_step: 0,
                request_revision: 1,
                state: fullmag_runner::LiveFieldMaterializationState::Pending,
                error: None,
            }];
        current.live_state = Some(live_state);
        let mut ledger = VecDeque::from([TrackedCommandRecord {
            command,
            request_id: None,
            status: CommandLifecycleState::Dispatched,
            dispatched_at_unix_ms: Some(1_700_000_000_500),
            completed_at_unix_ms: None,
            completion_status: None,
            error: None,
        }]);

        assert!(!reconcile_dispatched_command_ledger_from_snapshot(
            &mut ledger,
            &current,
            1_700_000_002_000
        ));
        assert_eq!(
            ledger.front().map(|record| record.status),
            Some(CommandLifecycleState::Dispatched)
        );
    }

    #[test]
    fn snapshot_reconciliation_marks_local_commands_terminal() {
        let mut current = test_current_snapshot();
        current.session.status = "completed".to_string();
        current.solver_profile.revision = 1;
        current.solver_profile.config = crate::schemas::diagnostics::SolverProfileCommandConfig {
            enabled: true,
            sample_every: 2,
            sample_interval_wall_ms: 0,
            max_samples: 7,
            emit_engine_log: true,
            persist_artifact: false,
        };
        current.mesh_workspace = Some(json!({
            "active_build": null,
            "last_build_summary": {
                "mesh_target": "study_domain",
                "mesh_reason": "user_requested",
                "n_nodes": 16,
                "n_elements": 8
            }
        }));
        current.engine_log = vec![
            engine_log(
                1_700_000_000_600,
                "system",
                "Solver profiler enabled (sample_every=2, max_samples=7)",
            ),
            engine_log(
                1_700_000_000_700,
                "success",
                "Remesh complete - 16 nodes, 8 elements",
            ),
            engine_log(
                1_700_000_000_800,
                "success",
                "Loaded workspace state from state.h5 (16 vectors)",
            ),
        ];

        let mut profile_command = session_command("cmd-profile", "set_solver_profile");
        profile_command.profile = Some(json!({
            "enabled": true,
            "sample_every": 2,
            "max_samples": 7,
            "emit_engine_log": true,
            "persist_artifact": false
        }));
        let mut ledger = VecDeque::from([
            TrackedCommandRecord {
                command: profile_command,
                request_id: None,
                status: CommandLifecycleState::Dispatched,
                dispatched_at_unix_ms: Some(1_700_000_000_500),
                completed_at_unix_ms: None,
                completion_status: None,
                error: None,
            },
            tracked_command("cmd-remesh", "remesh"),
            tracked_command("cmd-load", "load_state"),
            tracked_command("cmd-close", "close"),
        ]);

        assert!(reconcile_dispatched_command_ledger_from_snapshot(
            &mut ledger,
            &current,
            1_700_000_002_000
        ));

        for record in ledger {
            assert_eq!(record.status, CommandLifecycleState::Completed);
            assert_eq!(
                record.completion_status,
                Some(CommandCompletionState::Completed)
            );
            assert_eq!(record.completed_at_unix_ms, Some(1_700_000_002_000));
        }
    }

    #[test]
    fn snapshot_reconciliation_marks_local_command_failures_terminal() {
        let mut current = test_current_snapshot();
        current.mesh_workspace = Some(json!({
            "active_build": null,
            "last_build_error": "gmsh exited non-zero"
        }));
        current.engine_log = vec![engine_log(
            1_700_000_000_700,
            "error",
            "Remesh failed: gmsh exited non-zero",
        )];

        let mut ledger = VecDeque::from([tracked_command("cmd-remesh", "remesh")]);

        assert!(reconcile_dispatched_command_ledger_from_snapshot(
            &mut ledger,
            &current,
            1_700_000_002_000
        ));

        let record = ledger.front().expect("ledger record should remain");
        assert_eq!(record.status, CommandLifecycleState::Failed);
        assert_eq!(
            record.completion_status,
            Some(CommandCompletionState::Failed)
        );
        assert_eq!(record.completed_at_unix_ms, Some(1_700_000_002_000));
    }

    #[test]
    fn snapshot_reconciliation_marks_runtime_control_commands_terminal() {
        let mut paused = test_current_snapshot();
        paused.stage_execution = Some(test_stage_execution(
            RuntimeLifecycleState::Paused,
            Some(0),
            StageLifecycleState::Paused,
        ));
        let mut pause_ledger = VecDeque::from([tracked_command("cmd-pause", "pause")]);
        assert!(reconcile_dispatched_command_ledger_from_snapshot(
            &mut pause_ledger,
            &paused,
            1_700_000_002_000
        ));
        assert_eq!(
            pause_ledger
                .front()
                .and_then(|record| record.completion_status),
            Some(CommandCompletionState::Completed)
        );

        let mut resumed = test_current_snapshot();
        resumed.stage_execution = Some(test_stage_execution(
            RuntimeLifecycleState::Running,
            Some(0),
            StageLifecycleState::Running,
        ));
        let mut resume_ledger = VecDeque::from([tracked_command("cmd-resume", "resume")]);
        assert!(reconcile_dispatched_command_ledger_from_snapshot(
            &mut resume_ledger,
            &resumed,
            1_700_000_003_000
        ));
        assert_eq!(
            resume_ledger
                .front()
                .and_then(|record| record.completion_status),
            Some(CommandCompletionState::Completed)
        );
    }

    #[test]
    fn snapshot_reconciliation_marks_skip_and_stop_terminal() {
        let mut skipped = test_current_snapshot();
        skipped.stage_execution = Some(test_stage_execution(
            RuntimeLifecycleState::AwaitingCommand,
            None,
            StageLifecycleState::Skipped,
        ));
        let mut skip_ledger = VecDeque::from([tracked_command("cmd-skip", "skip")]);
        assert!(reconcile_dispatched_command_ledger_from_snapshot(
            &mut skip_ledger,
            &skipped,
            1_700_000_002_000
        ));
        assert_eq!(
            skip_ledger
                .front()
                .and_then(|record| record.completion_status),
            Some(CommandCompletionState::Completed)
        );

        let mut stopped = test_current_snapshot();
        stopped.stage_execution = Some(test_stage_execution(
            RuntimeLifecycleState::AwaitingCommand,
            None,
            StageLifecycleState::Stopped,
        ));
        let mut stop_ledger = VecDeque::from([tracked_command("cmd-stop", "stop")]);
        assert!(reconcile_dispatched_command_ledger_from_snapshot(
            &mut stop_ledger,
            &stopped,
            1_700_000_003_000
        ));
        assert_eq!(
            stop_ledger
                .front()
                .and_then(|record| record.completion_status),
            Some(CommandCompletionState::Completed)
        );
    }

    #[test]
    fn session_frame_preserves_stage_checkpoint_linkage_for_same_command() {
        let mut current = default_current_live_state(&CurrentLiveSnapshotRequest {
            session_id: "test-session".to_string(),
            coupled_checkpoint: None,
            session: None,
            session_status: None,
            metadata: None,
            mesh_workspace: None,
            stage_execution: None,
            simulation_preparation: None,
            run: None,
            live_state: None,
            latest_scalar_row: None,
            latest_fields: None,
            replace_latest_fields: false,
            field_generation: None,
            preview_fields: None,
            clear_preview_cache: false,
            engine_log: None,
            solver_profile: None,
            fem_mesh: None,
        });
        current.stage_execution = Some(StageExecutionState {
            total_stages: 1,
            completed_stage_indexes: Vec::new(),
            stages: vec![StageExecutionRecord {
                stage_id: None,
                kind: None,
                status: StageLifecycleState::Paused,
                command_id: Some("cmd-stage-0".into()),
                started_at_unix_ms: Some(1_700_000_000_000),
                completed_at_unix_ms: None,
                reason: None,
                converged: false,
                metric: None,
                artifact_refs: vec!["artifacts/stage-000".into(), "cp-common-state".into()],
                checkpoint_ref: Some("cp-000042".into()),
                loaded_state_ref: Some("cp-common-state".into()),
                resume_from_checkpoint_ref: Some("cp-000041".into()),
                state_transition: Some("restored".into()),
                state_transition_kind: Some("load_state".into()),
                state_transition_reason: Some("checkpoint_load".into()),
                state_transfer_operator_kind: Some("checkpoint_load".into()),
                state_transition_ui_presentation: Some("boundary_bar".into()),
                metric_name: None,
                metric_value: None,
                threshold: None,
                progress_percent: None,
                progress_label: None,
                progress_detail: None,
                last_progress_unix_ms: None,
                current_field_m_t: None,
                current_point_index: None,
                current_settle_step_index: None,
                current_settle_step_kind: None,
                current_settle_step_method: None,
            }],
            stage_statuses: vec![StageLifecycleState::Paused],
            active_stage_index: Some(0),
            active_stage_kind: Some("relax".into()),
            runtime_state: RuntimeLifecycleState::Paused,
        });

        apply_current_live_session_frame(
            &mut current,
            CurrentLiveSessionFrameRequest {
                session_id: "test-session".to_string(),
                session: None,
                session_status: None,
                metadata: None,
                mesh_workspace: None,
                stage_execution: Some(StageExecutionState {
                    total_stages: 1,
                    completed_stage_indexes: vec![0],
                    stages: vec![StageExecutionRecord {
                        stage_id: None,
                        kind: None,
                        status: StageLifecycleState::Completed,
                        command_id: Some("cmd-stage-0".into()),
                        started_at_unix_ms: Some(1_700_000_000_000),
                        completed_at_unix_ms: Some(1_700_000_001_000),
                        reason: None,
                        converged: false,
                        metric: None,
                        artifact_refs: vec!["artifacts/stage-000".into()],
                        checkpoint_ref: None,
                        loaded_state_ref: None,
                        resume_from_checkpoint_ref: None,
                        state_transition: None,
                        state_transition_kind: None,
                        state_transition_reason: None,
                        state_transfer_operator_kind: None,
                        state_transition_ui_presentation: None,
                        metric_name: None,
                        metric_value: None,
                        threshold: None,
                        progress_percent: None,
                        progress_label: None,
                        progress_detail: None,
                        last_progress_unix_ms: None,
                        current_field_m_t: None,
                        current_point_index: None,
                        current_settle_step_index: None,
                        current_settle_step_kind: None,
                        current_settle_step_method: None,
                    }],
                    stage_statuses: vec![StageLifecycleState::Completed],
                    active_stage_index: None,
                    active_stage_kind: None,
                    runtime_state: RuntimeLifecycleState::Completed,
                }),
                simulation_preparation: None,
                run: None,
            },
        )
        .expect("session frame should apply");

        let record = current
            .stage_execution
            .as_ref()
            .and_then(|state| state.stages.first())
            .expect("stage execution record should be present");
        assert_eq!(record.checkpoint_ref.as_deref(), Some("cp-000042"));
        assert_eq!(record.loaded_state_ref.as_deref(), Some("cp-common-state"));
        assert_eq!(
            record.resume_from_checkpoint_ref.as_deref(),
            Some("cp-000041")
        );
        assert_eq!(record.state_transition.as_deref(), Some("restored"));
        assert!(record
            .artifact_refs
            .iter()
            .any(|artifact_ref| artifact_ref == "cp-common-state"));
    }

    fn session_command(command_id: &str, kind: &str) -> SessionCommand {
        SessionCommand {
            seq: 1,
            command_id: command_id.to_string(),
            kind: kind.to_string(),
            created_at_unix_ms: 1_700_000_000_000,
            target: None,
            reason: None,
            precondition: None,
            client_intent_id: None,
            requested_at_unix_ms: None,
            until_seconds: None,
            max_steps: None,
            torque_tolerance: None,
            energy_tolerance: None,
            integrator: None,
            fixed_timestep: None,
            max_error: None,
            solver_policy: None,
            relax_algorithm: None,
            relax_alpha: None,
            mesh_options: None,
            mesh_target: None,
            mesh_reason: None,
            state_path: None,
            state_format: None,
            state_dataset: None,
            state_sample_index: None,
            display_selection: None,
            preview_config: None,
            stages: None,
            profile: None,
            field_materialization_requirements: Vec::new(),
        }
    }

    fn tracked_command(command_id: &str, kind: &str) -> TrackedCommandRecord {
        TrackedCommandRecord {
            command: session_command(command_id, kind),
            request_id: None,
            status: CommandLifecycleState::Dispatched,
            dispatched_at_unix_ms: Some(1_700_000_000_500),
            completed_at_unix_ms: None,
            completion_status: None,
            error: None,
        }
    }

    fn preview_field(quantity: &str) -> LivePreviewField {
        LivePreviewField {
            active_mask: None,
            applied_layer_stride: 1,
            applied_x_chosen_size: 1,
            applied_y_chosen_size: 1,
            auto_downscale_message: None,
            auto_downscaled: false,
            config_revision: 1,
            source_step: 0,
            source_time_seconds: None,
            source_revision: 1,
            materialized_at_unix_ms: 0,
            materialization_wall_time_ns: 0,
            original_grid: [1, 1, 1],
            preview_grid: [1, 1, 1],
            quantity: quantity.to_string(),
            quantity_domain: "cell".to_string(),
            spatial_kind: "vector".to_string(),
            unit: "A/m".to_string(),
            vector_field_values: vec![1.0, 0.0, 0.0],
            x_chosen_size: 1,
            y_chosen_size: 1,
        }
    }

    #[test]
    fn terminal_preview_json_transport_preserves_f64_bits() {
        let artifact_values = vec![
            5762.548134664166,
            -6246.828452439119,
            5154.102054176682,
            -1718.9201656167345,
            -7885.426098082194,
            1836.8474621392222,
            10338.286900101315,
            15173.812325455918,
            7491.904612481956,
            3390.0267837822926,
            21990.013757105164,
            -17004.747455698853,
            8123.414559350708,
            -3214.715903969464,
            -12671.236050772604,
            12097.26745275608,
            987.6351830018867,
            -1455.731818429477,
            -11407.751914450959,
            6112.129305304056,
            9797.166009175871,
            -20989.00984124621,
            -6803.9894437105695,
            -1176.6040005960192,
            -5120.223204986794,
            -19370.337149302362,
            17141.856040955292,
            -5302.631973672777,
            -11772.335655363348,
            -13193.865270991333,
        ];
        let mut field = preview_field("H_demag");
        field.vector_field_values = artifact_values.clone();

        let json = serde_json::to_vec(&vec![field]).expect("field frame should serialize");
        let decoded: Vec<LivePreviewField> =
            serde_json::from_slice(&json).expect("field frame should deserialize");
        let decoded_values = &decoded[0].vector_field_values;

        assert_eq!(
            decoded_values
                .iter()
                .map(|value| value.to_bits())
                .collect::<Vec<_>>(),
            artifact_values
                .iter()
                .map(|value| value.to_bits())
                .collect::<Vec<_>>(),
            "internal field-frame JSON transport must preserve exact f64 payload bits",
        );
    }

    fn engine_log(timestamp_unix_ms: u128, level: &str, message: &str) -> EngineLogEntry {
        EngineLogEntry {
            timestamp_unix_ms,
            level: level.to_string(),
            message: message.to_string(),
            source: None,
            phase_id: None,
            command_id: None,
        }
    }

    fn test_current_snapshot() -> SessionStateResponse {
        default_current_live_state(&CurrentLiveSnapshotRequest {
            session_id: "test-session".to_string(),
            coupled_checkpoint: None,
            session: None,
            session_status: None,
            metadata: None,
            mesh_workspace: None,
            stage_execution: None,
            simulation_preparation: None,
            run: None,
            live_state: None,
            latest_scalar_row: None,
            latest_fields: None,
            replace_latest_fields: false,
            field_generation: None,
            preview_fields: None,
            clear_preview_cache: false,
            engine_log: None,
            solver_profile: None,
            fem_mesh: None,
        })
    }

    #[test]
    fn publishing_fdm_membership_artifact_bumps_membership_revision_once() {
        let artifact_dir = std::env::temp_dir().join(format!(
            "fullmag-membership-publication-{}-{}",
            std::process::id(),
            unix_time_millis_now(),
        ));
        std::fs::create_dir_all(&artifact_dir).expect("artifact fixture directory should exist");
        std::fs::write(artifact_dir.join("run.json"), b"{}")
            .expect("pre-membership artifact should be written");

        let mut current = test_current_snapshot();
        current.session.artifact_dir = artifact_dir.display().to_string();
        finalize_current_live_apply(
            &mut current,
            CurrentLiveApplyFlags {
                has_run: true,
                ..CurrentLiveApplyFlags::default()
            },
        )
        .expect("initial artifact catalog should load");
        let initial_revision = current.region_realization_revisions.membership;

        let mesh_dir = artifact_dir.join("mesh");
        std::fs::create_dir_all(&mesh_dir).expect("mesh artifact directory should exist");
        std::fs::write(mesh_dir.join("fdm_region_membership.v2.json"), b"{}")
            .expect("FMRM descriptor should be published");
        std::fs::write(mesh_dir.join("fdm_region_membership.v2.bin"), b"FMRM")
            .expect("FMRM binary should be published");

        finalize_current_live_apply(&mut current, CurrentLiveApplyFlags::default())
            .expect("new FMRM artifact should refresh the catalog");
        assert_eq!(
            current.region_realization_revisions.membership,
            initial_revision + 1
        );
        assert!(current
            .artifacts
            .iter()
            .any(|artifact| artifact.path == "mesh/fdm_region_membership.v2.json"));

        finalize_current_live_apply(&mut current, CurrentLiveApplyFlags::default())
            .expect("unchanged FMRM artifact should remain stable");
        assert_eq!(
            current.region_realization_revisions.membership,
            initial_revision + 1
        );

        std::fs::remove_dir_all(&artifact_dir).expect("artifact fixture should be removed");
    }

    #[test]
    fn live_metadata_publishes_fail_closed_timestep_qualification() {
        let mut current = test_current_snapshot();
        apply_current_live_metadata(
            &mut current,
            json!({
                "timestep_qualification": {
                    "capability_id": "llg_td_policy_v1",
                    "qualification_id": "explicit_adaptive_fem_gpu_double",
                    "backend": "fem",
                    "device": "gpu",
                    "precision": "double",
                    "integrator": "rk45",
                    "timestep_policy": "adaptive",
                    "validation_state": "unvalidated",
                    "qualification_registry_version": "fullmag.llg_timestep_qualification_registry.v1"
                }
            }),
        );

        let qualification = current
            .solver_profile
            .timestep_qualification
            .expect("metadata should populate timestep qualification diagnostics");
        assert_eq!(qualification.validation_state.as_str(), "unvalidated");
        assert_eq!(qualification.integrator, "rk45");
        assert_eq!(qualification.timestep_policy, "adaptive");
        assert_eq!(
            qualification.qualification_registry_version,
            "fullmag.llg_timestep_qualification_registry.v1"
        );
        assert!(qualification.qualification_artifact_sha256.is_none());
        assert!(qualification.validated_scope.is_none());
    }

    fn region_owned_scene_document(revision: u64) -> fullmag_authoring::SceneDocument {
        let mut scene: fullmag_authoring::SceneDocument = serde_json::from_value(json!({
            "version": "1",
            "revision": revision,
            "scene": {
                "id": "scene-region-owned",
                "name": "Region-owned artifact test"
            },
            "objects": [{
                "id": "body",
                "name": "Body",
                "geometry": {
                    "geometry_kind": "box",
                    "geometry_params": { "size": [1.0e-7, 1.0e-7, 1.0e-8] }
                },
                "material_ref": "mat:body",
                "magnetization_ref": "mag:body",
                "transform": {
                    "translation": [0.0, 0.0, 0.0],
                    "rotation_quat": [0.0, 0.0, 0.0, 1.0],
                    "scale": [1.0, 1.0, 1.0]
                },
                "tags": []
            }],
            "materials": [],
            "magnetization_assets": [],
            "couplings": [],
            "current_modules": {},
            "study": {},
            "outputs": {},
            "editor": {}
        }))
        .expect("region-owned scene should deserialize");
        let region: fullmag_authoring::SceneObjectRegion = serde_json::from_value(json!({
            "region_id": "body:core",
            "owner_object": "body",
            "name": "Core",
            "enabled": true,
            "shape": {
                "kind": "box",
                "size": [5.0e-8, 5.0e-8, 1.0e-8],
                "center": [0.0, 0.0, 0.0]
            },
            "frame": "object",
            "priority": 4,
            "mesh_policy": null,
            "material_overrides": [],
            "texture_override": null,
            "realization_policy": "inherit"
        }))
        .expect("region should deserialize");
        scene.objects[0].regions.push(region);
        scene
    }

    #[test]
    fn disk_reloaded_finished_artifacts_keep_region_owned_provenance() {
        let artifact_dir = std::env::temp_dir().join(format!(
            "fullmag-region-owned-artifacts-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&artifact_dir);
        std::fs::create_dir_all(artifact_dir.join("results"))
            .expect("artifact result directory should be created");
        std::fs::write(artifact_dir.join("results/final.json"), "{}")
            .expect("artifact file should be written");

        let mut current = test_current_snapshot();
        current.scene_document = Some(region_owned_scene_document(57));

        apply_current_live_snapshot(
            &mut current,
            CurrentLiveSnapshotRequest {
                session_id: "test-session".to_string(),
                coupled_checkpoint: None,
                session: None,
                session_status: None,
                metadata: None,
                mesh_workspace: None,
                stage_execution: None,
                simulation_preparation: None,
                run: Some(RunManifest {
                    run_id: "run-region-owned".to_string(),
                    session_id: "test-session".to_string(),
                    status: "completed".to_string(),
                    total_steps: 1,
                    final_time: Some(1.0e-12),
                    final_e_ex: None,
                    final_e_demag: None,
                    final_e_ext: None,
                    final_e_ani: None,
                    final_e_dmi: None,
                    final_e_total: None,
                    artifact_dir: artifact_dir.display().to_string(),
                }),
                live_state: Some(LiveState {
                    status: "completed".to_string(),
                    updated_at_unix_ms: 1_700_000_000_001,
                    latest_step: StepUpdateView {
                        step: 1,
                        time: 1.0e-12,
                        dt: 1.0e-12,
                        pseudo_time_s: None,
                        e_ex: 0.0,
                        e_demag: 0.0,
                        e_ext: 0.0,
                        e_ani: 0.0,
                        e_dmi: 0.0,
                        e_total: 0.0,
                        max_dm_dt: 0.0,
                        max_h_eff: 0.0,
                        max_h_demag: 0.0,
                        max_torque_Apm: 0.0,
                        max_torque_T: 0.0,
                        wall_time_ns: 0,
                        grid: [1, 1, 1],
                        fem_mesh_generation_id: None,
                        fem_mesh: None,
                        magnetization: Some(vec![0.0, 0.0, 1.0]),
                        per_object_scalars: Default::default(),
                        field_materialization_states: Vec::new(),
                        preview_field: None,
                        finished: true,
                    },
                }),
                latest_scalar_row: None,
                latest_fields: None,
                replace_latest_fields: false,
                field_generation: None,
                preview_fields: None,
                clear_preview_cache: false,
                engine_log: None,
                solver_profile: None,
                fem_mesh: None,
            },
        )
        .expect("finished snapshot should reload artifacts");

        let artifact = current
            .artifacts
            .iter()
            .find(|entry| entry.path == "results/final.json")
            .expect("finished run artifact should be listed");
        let provenance = artifact
            .region_owned_provenance
            .as_ref()
            .expect("disk artifact should carry region-owned provenance");
        assert_eq!(provenance.scene_revision, 57);
        assert_eq!(provenance.authored_region_count, 1);
        assert_eq!(provenance.material_parameter_field_count, 0);
        assert_eq!(provenance.coupling_count, 0);

        std::fs::remove_dir_all(artifact_dir).expect("temp artifact directory should be removed");
    }

    fn domain_fem_mesh(generation_id: &str) -> fullmag_runner::FemMeshPayload {
        fullmag_runner::FemMeshPayload {
            mesh_name: "domain-mesh".to_string(),
            mesh_id: "domain-mesh-id".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ],
            cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
            element_markers: vec![1],
            facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
            boundary_markers: vec![1],
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
            domain_mesh_mode: Some("shared_domain".to_string()),
            domain_frame: None,
            generation_id: Some(generation_id.to_string()),
            per_domain_quality: Default::default(),
            build_report: None,
        }
    }

    fn test_mesh_part(id: &str, node_indices: Vec<u32>) -> fullmag_runner::FemMeshPartPayload {
        fullmag_runner::FemMeshPartPayload {
            id: id.to_string(),
            label: id.to_string(),
            role: "magnetic_object".to_string(),
            object_id: Some(id.to_string()),
            geometry_id: None,
            material_id: None,
            element_start: 0,
            element_count: 1,
            boundary_face_start: 0,
            boundary_face_count: 1,
            boundary_face_indices: vec![0],
            node_start: 0,
            node_count: node_indices.len() as u32,
            node_indices,
            facet_global_ordinals: vec![0],
            bounds_min: None,
            bounds_max: None,
        }
    }

    fn surface_preview_mesh() -> fullmag_runner::FemMeshPayload {
        fullmag_runner::FemMeshPayload {
            mesh_name: "surface-preview".to_string(),
            mesh_id: "surface-preview-id".to_string(),
            nodes: vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
            cells: fullmag_ir::FemConnectivityIR::empty(),
            element_markers: Vec::new(),
            facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
            boundary_markers: vec![1],
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
            domain_mesh_mode: None,
            domain_frame: None,
            generation_id: None,
            per_domain_quality: Default::default(),
            build_report: None,
        }
    }

    fn test_stage_execution(
        runtime_state: RuntimeLifecycleState,
        active_stage_index: Option<usize>,
        stage_status: StageLifecycleState,
    ) -> StageExecutionState {
        StageExecutionState {
            total_stages: 1,
            completed_stage_indexes: Vec::new(),
            stages: vec![StageExecutionRecord {
                stage_id: None,
                kind: None,
                status: stage_status,
                command_id: None,
                started_at_unix_ms: Some(1_700_000_000_000),
                completed_at_unix_ms: None,
                reason: None,
                converged: false,
                metric: None,
                artifact_refs: Vec::new(),
                checkpoint_ref: None,
                loaded_state_ref: None,
                resume_from_checkpoint_ref: None,
                state_transition: None,
                state_transition_kind: None,
                state_transition_reason: None,
                state_transfer_operator_kind: None,
                state_transition_ui_presentation: None,
                metric_name: None,
                metric_value: None,
                threshold: None,
                progress_percent: None,
                progress_label: None,
                progress_detail: None,
                last_progress_unix_ms: None,
                current_field_m_t: None,
                current_point_index: None,
                current_settle_step_index: None,
                current_settle_step_kind: None,
                current_settle_step_method: None,
            }],
            stage_statuses: vec![stage_status],
            active_stage_index,
            active_stage_kind: Some("relax".into()),
            runtime_state,
        }
    }

    #[test]
    fn snapshot_promotes_active_preview_field_into_preview_cache() {
        let mut current = test_current_snapshot();
        assert!(current.preview_cache.get("H_eff").is_none());
        let legacy_mesh = domain_fem_mesh("legacy-domain-gen");

        let req = CurrentLiveSnapshotRequest {
            session_id: "test-session".to_string(),
            coupled_checkpoint: None,
            session: None,
            session_status: None,
            metadata: None,
            mesh_workspace: None,
            stage_execution: None,
            simulation_preparation: None,
            run: None,
            live_state: Some(LiveState {
                status: "running".into(),
                updated_at_unix_ms: 1_700_000_000_000,
                latest_step: StepUpdateView {
                    step: 10,
                    time: 1e-9,
                    dt: 1e-13,
                    pseudo_time_s: None,
                    e_ex: 0.0,
                    e_demag: 0.0,
                    e_ext: 0.0,
                    e_ani: 0.0,
                    e_dmi: 0.0,
                    e_total: 0.0,
                    max_dm_dt: 0.0,
                    max_h_eff: 0.0,
                    max_h_demag: 0.0,
                    max_torque_Apm: 0.0,
                    max_torque_T: 0.0,
                    wall_time_ns: 100,
                    grid: [1, 1, 1],
                    fem_mesh_generation_id: None,
                    fem_mesh: Some(legacy_mesh),
                    magnetization: None,
                    per_object_scalars: Default::default(),
                    field_materialization_states: Vec::new(),
                    preview_field: Some(preview_field("H_eff")),
                    finished: false,
                },
            }),
            latest_scalar_row: None,
            latest_fields: None,
            replace_latest_fields: false,
            field_generation: None,
            preview_fields: None,
            clear_preview_cache: false,
            engine_log: None,
            solver_profile: None,
            fem_mesh: None,
        };
        apply_current_live_snapshot(&mut current, req).unwrap();

        assert_eq!(
            current
                .fem_mesh
                .as_ref()
                .and_then(|mesh| mesh.generation_id.as_deref()),
            Some("legacy-domain-gen")
        );
        assert!(current
            .live_state
            .as_ref()
            .unwrap()
            .latest_step
            .fem_mesh
            .is_none());

        let cached = current
            .preview_cache
            .get("H_eff")
            .expect("active preview field should be promoted into preview_cache");
        assert_eq!(cached.quantity, "H_eff");
    }

    #[test]
    fn cached_preview_merge_never_regresses_source_provenance() {
        let mut current = CachedPreviewFields::default();
        let mut terminal = preview_field("H_demag");
        terminal.source_step = 52;
        terminal.source_revision = 4;
        terminal.materialized_at_unix_ms = 1_700_000_000_456;
        terminal.vector_field_values = vec![0.0, 1.0, 0.0];
        merge_cached_preview_fields(&mut current, vec![terminal]);

        let mut carried_active = preview_field("H_demag");
        carried_active.source_step = 0;
        carried_active.source_revision = 4;
        carried_active.materialized_at_unix_ms = 1_700_000_000_100;
        carried_active.vector_field_values = vec![1.0, 0.0, 0.0];
        merge_cached_preview_fields(&mut current, vec![carried_active]);

        let cached = current.get("H_demag").expect("terminal cached field");
        assert_eq!(cached.source_step, 52);
        assert_eq!(cached.vector_field_values, vec![0.0, 1.0, 0.0]);
    }

    #[test]
    fn cached_preview_merge_is_idempotent_and_accepts_only_newer_generation() {
        let mut current = CachedPreviewFields::default();
        let mut established = preview_field("H_demag");
        established.source_step = 52;
        established.source_revision = 4;
        established.materialized_at_unix_ms = 1_700_000_000_200;
        established.vector_field_values = vec![0.0, 0.0, 52.0];
        merge_cached_preview_fields(&mut current, vec![established.clone()]);
        merge_cached_preview_fields(&mut current, vec![established.clone()]);

        let mut equal_generation_conflict = established.clone();
        equal_generation_conflict.materialized_at_unix_ms += 1;
        equal_generation_conflict.vector_field_values = vec![0.0, 0.0, 0.0];
        merge_cached_preview_fields(&mut current, vec![equal_generation_conflict]);
        assert_eq!(current.get("H_demag"), Some(&established));

        let mut newer = established.clone();
        newer.source_step = 53;
        newer.vector_field_values = vec![0.0, 0.0, 53.0];
        merge_cached_preview_fields(&mut current, vec![newer.clone()]);
        assert_eq!(current.get("H_demag"), Some(&newer));
    }

    #[test]
    fn snapshot_terminal_cache_wins_equal_provenance_conflict_with_active_preview() {
        let mut current = test_current_snapshot();
        let mut carried_active = preview_field("H_demag");
        carried_active.source_step = 52;
        carried_active.source_revision = 7;
        carried_active.materialized_at_unix_ms = 1_700_000_000_200;
        carried_active.vector_field_values = vec![0.0, 0.0, 0.0];
        let mut terminal = carried_active.clone();
        terminal.vector_field_values = vec![0.0, 0.0, 52.0];

        let req = CurrentLiveSnapshotRequest {
            session_id: "test-session".to_string(),
            session: None,
            session_status: None,
            metadata: None,
            mesh_workspace: None,
            stage_execution: None,
            simulation_preparation: None,
            run: None,
            live_state: Some(LiveState {
                status: "completed".into(),
                updated_at_unix_ms: 1_700_000_000_300,
                latest_step: StepUpdateView {
                    step: 52,
                    time: 52e-13,
                    dt: 1e-13,
                    pseudo_time_s: None,
                    e_ex: 0.0,
                    e_demag: 0.0,
                    e_ext: 0.0,
                    e_ani: 0.0,
                    e_dmi: 0.0,
                    e_total: 0.0,
                    max_dm_dt: 0.0,
                    max_h_eff: 0.0,
                    max_h_demag: 0.0,
                    max_torque_Apm: 0.0,
                    max_torque_T: 0.0,
                    wall_time_ns: 100,
                    grid: [1, 1, 1],
                    fem_mesh_generation_id: None,
                    fem_mesh: None,
                    magnetization: None,
                    per_object_scalars: Default::default(),
                    field_materialization_states: Vec::new(),
                    preview_field: Some(carried_active),
                    finished: true,
                },
            }),
            coupled_checkpoint: None,
            latest_scalar_row: None,
            latest_fields: None,
            replace_latest_fields: false,
            field_generation: None,
            preview_fields: Some(vec![terminal.clone()]),
            clear_preview_cache: false,
            engine_log: None,
            solver_profile: None,
            fem_mesh: None,
        };

        apply_current_live_snapshot(&mut current, req).unwrap();

        let cached = current
            .preview_cache
            .get("H_demag")
            .expect("terminal H_demag cache entry");
        assert_eq!(cached.vector_field_values, terminal.vector_field_values);
        assert_eq!(cached.source_step, terminal.source_step);
        assert_eq!(cached.source_revision, terminal.source_revision);
        assert_eq!(
            cached.materialized_at_unix_ms,
            terminal.materialized_at_unix_ms
        );
    }

    #[test]
    fn field_frame_terminal_cache_wins_equal_provenance_conflict_with_runtime_preview() {
        let mut current = test_current_snapshot();
        let mut runtime_preview = preview_field("H_demag");
        runtime_preview.source_step = 52;
        runtime_preview.source_revision = 7;
        runtime_preview.materialized_at_unix_ms = 1_700_000_000_200;
        runtime_preview.vector_field_values = vec![0.0, 0.0, 0.0];
        merge_cached_preview_fields(&mut current.preview_cache, vec![runtime_preview]);

        let mut terminal = preview_field("H_demag");
        terminal.source_step = 52;
        terminal.source_revision = 7;
        terminal.materialized_at_unix_ms = 1_700_000_000_200;
        terminal.vector_field_values = vec![0.0, 0.0, 52.0];

        apply_current_live_field_frame(
            &mut current,
            CurrentLiveFieldFrameRequest {
                session_id: "test-session".to_string(),
                latest_fields: None,
                replace_latest_fields: false,
                field_generation: None,
                preview_fields: Some(vec![terminal.clone()]),
                clear_preview_cache: false,
            },
        )
        .expect("terminal field frame should apply");

        let cached = current
            .preview_cache
            .get("H_demag")
            .expect("terminal H_demag cache entry");
        assert_eq!(cached.vector_field_values, terminal.vector_field_values);
        assert_eq!(cached.source_step, terminal.source_step);
        assert_eq!(cached.source_revision, terminal.source_revision);

        let mut older = terminal.clone();
        older.source_step = 51;
        older.vector_field_values = vec![0.0, 0.0, 51.0];
        apply_current_live_field_frame(
            &mut current,
            CurrentLiveFieldFrameRequest {
                session_id: "test-session".to_string(),
                latest_fields: None,
                replace_latest_fields: false,
                field_generation: None,
                preview_fields: Some(vec![older]),
                clear_preview_cache: false,
            },
        )
        .expect("older authoritative field frame should be ignored");

        let cached = current
            .preview_cache
            .get("H_demag")
            .expect("newer terminal H_demag cache entry");
        assert_eq!(cached.vector_field_values, terminal.vector_field_values);
        assert_eq!(cached.source_step, terminal.source_step);
        assert_eq!(cached.source_revision, terminal.source_revision);
    }

    #[test]
    fn effective_field_source_tracks_shared_latest_preview_precedence_without_revision_churn() {
        let mut current = test_current_snapshot();
        current.latest_fields = serde_json::from_value(json!({
            "H_demag": {
                "values": [[9.0, 9.0, 9.0]],
                "field_revision": 7,
                "source_step": 52,
                "source_revision": 7,
                "materialized_at_unix_ms": 1_700_000_000_100_u64
            }
        }))
        .expect("latest H_demag field");
        current
            .field_quantity_revisions
            .insert("H_demag".to_string(), 7);
        current.field_samples_revision = 7;

        let mut terminal = preview_field("H_demag");
        terminal.source_step = 52;
        terminal.source_revision = 7;
        terminal.materialized_at_unix_ms = 1_700_000_000_200;
        terminal.vector_field_values = vec![0.0, 0.0, 52.0];

        apply_current_live_field_frame(
            &mut current,
            CurrentLiveFieldFrameRequest {
                session_id: "test-session".to_string(),
                latest_fields: None,
                replace_latest_fields: false,
                field_generation: None,
                preview_fields: Some(vec![terminal.clone()]),
                clear_preview_cache: false,
            },
        )
        .expect("terminal field frame should apply");

        assert_eq!(
            effective_field_source(&current, "H_demag").map(|source| source.kind),
            Some(EffectiveFieldSourceKind::Preview),
            "newer terminal preview must supersede stale latest_fields at the same source generation"
        );
        let terminal_revision = current.field_quantity_revisions["H_demag"];
        assert!(terminal_revision > 7);

        apply_current_live_field_frame(
            &mut current,
            CurrentLiveFieldFrameRequest {
                session_id: "test-session".to_string(),
                latest_fields: None,
                replace_latest_fields: false,
                field_generation: None,
                preview_fields: Some(vec![terminal]),
                clear_preview_cache: false,
            },
        )
        .expect("duplicate terminal field frame should apply idempotently");
        assert_eq!(
            current.field_quantity_revisions["H_demag"], terminal_revision,
            "an exact duplicate must not create artificial revision churn"
        );

        let genuinely_newer_latest: LatestFields = serde_json::from_value(json!({
            "H_demag": {
                "values": [[53.0, 53.0, 53.0]],
                "field_revision": terminal_revision + 1,
                "source_step": 53,
                "source_revision": 8,
                "materialized_at_unix_ms": 1_700_000_000_300_u64
            }
        }))
        .expect("newer latest H_demag field");
        apply_current_live_field_frame(
            &mut current,
            CurrentLiveFieldFrameRequest {
                session_id: "test-session".to_string(),
                latest_fields: Some(genuinely_newer_latest),
                replace_latest_fields: false,
                field_generation: None,
                preview_fields: None,
                clear_preview_cache: false,
            },
        )
        .expect("newer latest field frame should apply");

        assert_eq!(
            effective_field_source(&current, "H_demag").map(|source| source.kind),
            Some(EffectiveFieldSourceKind::Latest)
        );
        assert!(current.field_quantity_revisions["H_demag"] > terminal_revision);
    }

    #[test]
    fn equal_generation_complete_latest_precedes_later_incomplete_preview() {
        let mut current = test_current_snapshot();
        current.latest_fields = serde_json::from_value(json!({
            "H_demag": {
                "values": [[4.0, 0.0, 0.0]],
                "source_step": 4,
                "source_revision": 4,
                "materialized_at_unix_ms": 1_700_000_000_400_u64,
                "source_time_seconds": 4.0e-13,
                "layout": { "grid_cells": [1, 1, 1] }
            }
        }))
        .expect("latest H_demag field");
        let mut preview = preview_field("H_demag");
        preview.source_step = 4;
        preview.source_revision = 4;
        preview.materialized_at_unix_ms = 1_700_000_000_500;
        preview.source_time_seconds = None;
        current.preview_cache.insert(preview);

        assert!(
            !preview_cache_precedes_latest(&current, "H_demag"),
            "an equal-generation preview without source time must not hide a complete latest field"
        );
        assert!(matches!(
            resolved_current_field_source(&current, "H_demag", 3),
            Some(ResolvedCurrentFieldSource::Latest(value))
                if value.get("source_time_seconds").and_then(Value::as_f64) == Some(4.0e-13)
        ));
    }

    #[test]
    fn equal_generation_complete_preview_precedes_later_incomplete_latest() {
        let mut current = test_current_snapshot();
        current.latest_fields = serde_json::from_value(json!({
            "H_demag": {
                "values": [[4.0, 0.0, 0.0]],
                "source_step": 4,
                "source_revision": 4,
                "materialized_at_unix_ms": 1_700_000_000_500_u64,
                "layout": { "grid_cells": [1, 1, 1] }
            }
        }))
        .expect("latest H_demag field");
        let mut preview = preview_field("H_demag");
        preview.source_step = 4;
        preview.source_revision = 4;
        preview.materialized_at_unix_ms = 1_700_000_000_400;
        preview.source_time_seconds = Some(4.0e-13);
        current.preview_cache.insert(preview);

        assert!(preview_cache_precedes_latest(&current, "H_demag"));
        assert!(matches!(
            resolved_current_field_source(&current, "H_demag", 3),
            Some(ResolvedCurrentFieldSource::Preview(field))
                if field.source_time_seconds == Some(4.0e-13)
        ));
    }

    #[test]
    fn equal_generation_with_equally_complete_provenance_keeps_preview_authority() {
        let mut current = test_current_snapshot();
        current.latest_fields = serde_json::from_value(json!({
            "H_demag": {
                "values": [[4.0, 0.0, 0.0]],
                "source_step": 4,
                "source_revision": 4,
                "materialized_at_unix_ms": 1_700_000_000_400_u64,
                "source_time_seconds": 4.0e-13,
                "layout": { "grid_cells": [1, 1, 1] }
            }
        }))
        .expect("latest H_demag field");
        let mut preview = preview_field("H_demag");
        preview.source_step = 4;
        preview.source_revision = 4;
        preview.materialized_at_unix_ms = 1_700_000_000_400;
        preview.source_time_seconds = Some(4.0e-13);
        current.preview_cache.insert(preview);

        assert!(preview_cache_precedes_latest(&current, "H_demag"));
        assert!(matches!(
            resolved_current_field_source(&current, "H_demag", 3),
            Some(ResolvedCurrentFieldSource::Preview(_))
        ));
    }

    #[test]
    fn equal_generation_later_scientific_time_precedes_wall_clock_in_both_directions() {
        let mut current = test_current_snapshot();
        current.latest_fields = serde_json::from_value(json!({
            "H_demag": {
                "values": [[4.0, 0.0, 0.0]],
                "source_step": 4,
                "source_revision": 4,
                "source_time_seconds": 5.0e-13,
                "materialized_at_unix_ms": 1_700_000_000_100_u64,
                "layout": { "grid_cells": [1, 1, 1] }
            }
        }))
        .expect("latest H_demag field");
        let mut preview = preview_field("H_demag");
        preview.source_step = 4;
        preview.source_revision = 4;
        preview.source_time_seconds = Some(4.0e-13);
        preview.materialized_at_unix_ms = 1_700_000_000_900;
        current.preview_cache.insert(preview);

        assert!(
            !preview_cache_precedes_latest(&current, "H_demag"),
            "later latest scientific time must beat a later preview wall clock"
        );

        let mut latest = current
            .latest_fields
            .get("H_demag")
            .cloned()
            .expect("latest H_demag field");
        latest["source_time_seconds"] = json!(4.0e-13);
        latest["materialized_at_unix_ms"] = json!(1_700_000_000_900_u64);
        current.latest_fields.insert("H_demag".to_string(), latest);
        let mut preview = current
            .preview_cache
            .get("H_demag")
            .cloned()
            .expect("preview H_demag field");
        preview.source_time_seconds = Some(5.0e-13);
        preview.materialized_at_unix_ms = 1_700_000_000_100;
        current.preview_cache.insert(preview);

        assert!(
            preview_cache_precedes_latest(&current, "H_demag"),
            "later preview scientific time must beat a later latest wall clock"
        );
    }

    #[test]
    fn cached_preview_merge_uses_scientific_time_within_one_generation() {
        let mut current = CachedPreviewFields::default();
        let mut established = preview_field("H_demag");
        established.source_step = 4;
        established.source_revision = 4;
        established.source_time_seconds = Some(5.0e-13);
        established.materialized_at_unix_ms = 100;
        established.vector_field_values = vec![5.0, 0.0, 0.0];
        merge_cached_preview_fields(&mut current, vec![established.clone()]);

        let mut older_time = established.clone();
        older_time.source_time_seconds = Some(4.0e-13);
        older_time.materialized_at_unix_ms = 900;
        older_time.vector_field_values = vec![4.0, 0.0, 0.0];
        merge_authoritative_cached_preview_fields(&mut current, vec![older_time]);
        assert_eq!(current.get("H_demag"), Some(&established));

        let mut newer_time = established.clone();
        newer_time.source_time_seconds = Some(6.0e-13);
        newer_time.materialized_at_unix_ms = 50;
        newer_time.vector_field_values = vec![6.0, 0.0, 0.0];
        merge_cached_preview_fields(&mut current, vec![newer_time.clone()]);
        assert_eq!(current.get("H_demag"), Some(&newer_time));
    }

    #[test]
    fn genuinely_newer_field_wins_before_source_time_completeness() {
        let mut current = test_current_snapshot();
        current.latest_fields = serde_json::from_value(json!({
            "H_demag": {
                "values": [[5.0, 0.0, 0.0]],
                "source_step": 5,
                "source_revision": 4,
                "materialized_at_unix_ms": 1_700_000_000_400_u64,
                "layout": { "grid_cells": [1, 1, 1] }
            }
        }))
        .expect("newer latest H_demag field");
        let mut preview = preview_field("H_demag");
        preview.source_step = 4;
        preview.source_revision = 4;
        preview.materialized_at_unix_ms = 1_700_000_000_400;
        preview.source_time_seconds = Some(4.0e-13);
        current.preview_cache.insert(preview);

        assert!(!preview_cache_precedes_latest(&current, "H_demag"));
        assert!(matches!(
            resolved_current_field_source(&current, "H_demag", 3),
            Some(ResolvedCurrentFieldSource::Latest(value))
                if value.get("source_step").and_then(Value::as_u64) == Some(5)
        ));
    }

    #[test]
    fn latest_field_same_provenance_changed_payload_bumps_once_without_duplicate_churn() {
        let mut current = test_current_snapshot();
        let field = |values: Vec<Vec<f64>>| -> LatestFields {
            serde_json::from_value(json!({
                "H_demag": {
                    "values": values,
                    "field_revision": 7,
                    "source_step": 52,
                    "source_revision": 7,
                    "materialized_at_unix_ms": 1_700_000_000_100_u64,
                    "layout": { "grid_cells": [2, 1, 1] }
                }
            }))
            .expect("latest H_demag field")
        };
        let apply = |current: &mut SessionStateResponse, latest_fields: LatestFields| {
            apply_current_live_field_frame(
                current,
                CurrentLiveFieldFrameRequest {
                    session_id: "test-session".to_string(),
                    latest_fields: Some(latest_fields),
                    replace_latest_fields: false,
                    field_generation: None,
                    preview_fields: None,
                    clear_preview_cache: false,
                },
            )
            .expect("latest field frame should apply");
        };

        apply(
            &mut current,
            field(vec![vec![1.0, 0.0, 0.0], vec![1.0, 0.0, 0.0]]),
        );
        let first_revision = current.field_quantity_revisions["H_demag"];

        let changed = vec![vec![0.0, 1.0, 0.0], vec![0.0, -1.0, 0.0]];
        apply(&mut current, field(changed.clone()));
        let changed_revision = current.field_quantity_revisions["H_demag"];
        assert!(
            changed_revision > first_revision,
            "changed values must advance the field revision even when provenance is duplicated"
        );

        apply(&mut current, field(changed));
        assert_eq!(
            current.field_quantity_revisions["H_demag"], changed_revision,
            "an exact duplicate payload and provenance must not create revision churn"
        );
    }

    #[test]
    fn terminal_authoritative_field_frame_replaces_stale_fields_without_replay_churn() {
        let mut current = test_current_snapshot();
        current.latest_fields = serde_json::from_value(json!({
            "H_dmi": {
                "values": [[1.0, 0.0, 0.0]],
                "source_step": 10,
                "source_revision": 10,
                "materialized_at_unix_ms": 100_u64,
                "layout": { "grid_cells": [1, 1, 1] }
            }
        }))
        .expect("previous-run H_dmi field");

        let terminal_frame = || {
            serde_json::from_value(json!({
                "session_id": "test-session",
                "replace_latest_fields": true,
                "field_generation": { "run_id": "test-run", "sequence": 11 },
                "clear_preview_cache": true,
                "latest_fields": {
                    "H_eff": {
                        "values": [[0.0, 1.0, 0.0]],
                        "source_step": 11,
                        "source_revision": 11,
                        "materialized_at_unix_ms": 110_u64,
                        "layout": { "grid_cells": [1, 1, 1] }
                    }
                }
            }))
            .expect("terminal field frame")
        };

        apply_current_live_field_frame(&mut current, terminal_frame())
            .expect("terminal field frame should apply");
        assert!(
            current.latest_fields.get("H_dmi").is_none(),
            "a terminal authoritative frame must remove a quantity absent from the next run"
        );
        assert!(current.latest_fields.get("H_eff").is_some());
        let catalog_revision = current.field_catalog_revision;
        let sample_revision = current.field_samples_revision;
        let h_dmi_revision = current.field_quantity_revisions["H_dmi"];
        assert!(catalog_revision > 0);
        assert!(sample_revision > 0);
        assert!(h_dmi_revision > 0);

        apply_current_live_field_frame(&mut current, terminal_frame())
            .expect("identical terminal replay should apply");
        assert_eq!(current.field_catalog_revision, catalog_revision);
        assert_eq!(current.field_samples_revision, sample_revision);
        assert_eq!(current.field_quantity_revisions["H_dmi"], h_dmi_revision);
    }

    #[test]
    fn empty_authoritative_field_frame_clears_the_latest_set() {
        let mut current = test_current_snapshot();
        current.latest_fields = serde_json::from_value(json!({
            "H_dmi": { "values": [[1.0, 0.0, 0.0]], "layout": { "grid_cells": [1, 1, 1] } }
        }))
        .expect("previous field");
        let frame = serde_json::from_value(json!({
            "session_id": "test-session",
            "replace_latest_fields": true,
            "field_generation": { "run_id": "test-run", "sequence": 11 },
            "clear_preview_cache": true,
            "latest_fields": {}
        }))
        .expect("empty terminal field frame");

        apply_current_live_field_frame(&mut current, frame).expect("empty frame should apply");
        assert_eq!(current.latest_fields.len(), 0);
    }

    #[test]
    fn replacement_without_a_complete_field_snapshot_is_rejected() {
        let mut current = test_current_snapshot();
        let frame = CurrentLiveFieldFrameRequest {
            session_id: "test-session".to_string(),
            latest_fields: None,
            replace_latest_fields: true,
            field_generation: None,
            preview_fields: None,
            clear_preview_cache: false,
        };

        let error = apply_current_live_field_frame(&mut current, frame)
            .expect_err("replace without fields and cache clear must be invalid");
        assert_eq!(error.status, axum::http::StatusCode::BAD_REQUEST);
    }

    #[test]
    fn replacement_requires_preview_cache_clear() {
        let mut current = test_current_snapshot();
        let frame = CurrentLiveFieldFrameRequest {
            session_id: "test-session".to_string(),
            latest_fields: Some(LatestFields::default()),
            replace_latest_fields: true,
            field_generation: None,
            preview_fields: None,
            clear_preview_cache: false,
        };

        let error = apply_current_live_field_frame(&mut current, frame)
            .expect_err("replace without cache clear must be invalid");
        assert_eq!(error.status, axum::http::StatusCode::BAD_REQUEST);
    }

    #[test]
    fn stale_terminal_field_generation_is_rejected_without_revision_churn() {
        let mut current = test_current_snapshot();
        let terminal_frame = |sequence: u64, value: f64| {
            serde_json::from_value(json!({
                "session_id": "test-session",
                "replace_latest_fields": true,
                "clear_preview_cache": true,
                "field_generation": { "run_id": "run-1", "sequence": sequence },
                "latest_fields": {
                    "H_eff": {
                        "values": [[value, 0.0, 0.0]],
                        "layout": { "grid_cells": [1, 1, 1] }
                    }
                }
            }))
            .expect("terminal field frame")
        };

        apply_current_live_field_frame(&mut current, terminal_frame(2, 2.0))
            .expect("newer generation should apply");
        let catalog_revision = current.field_catalog_revision;
        let sample_revision = current.field_samples_revision;
        let error = apply_current_live_field_frame(&mut current, terminal_frame(1, 1.0))
            .expect_err("older generation must be rejected");

        assert_eq!(error.status, axum::http::StatusCode::CONFLICT);
        assert_eq!(current.field_catalog_revision, catalog_revision);
        assert_eq!(current.field_samples_revision, sample_revision);
        assert_eq!(
            current.latest_fields.get("H_eff").expect("newer H_eff")["values"][0][0],
            serde_json::json!(2.0)
        );
    }

    #[test]
    fn terminal_snapshot_exposes_completed_runtime_and_final_fields_together() {
        let mut current = test_current_snapshot();
        let mut completed = live_state_with_magnetization(9, vec![0.0, 0.0, 1.0]);
        completed.status = "completed".to_string();
        completed.latest_step.finished = true;
        let request: CurrentLiveSnapshotRequest = serde_json::from_value(json!({
            "session_id": "test-session",
            "live_state": completed,
            "replace_latest_fields": true,
            "field_generation": { "run_id": "run-atomic", "sequence": 3 },
            "clear_preview_cache": true,
            "latest_fields": {
                "m": {
                    "values": [[0.0, 0.0, 1.0]],
                    "layout": { "grid_cells": [1, 1, 1], "spatial_kind": "grid" }
                },
                "H_eff": {
                    "values": [[0.0, 1.0, 0.0]],
                    "layout": { "grid_cells": [1, 1, 1], "spatial_kind": "grid" }
                }
            }
        }))
        .expect("terminal snapshot");

        apply_current_live_snapshot(&mut current, request)
            .expect("terminal snapshot should apply atomically");

        assert_eq!(
            current
                .live_state
                .as_ref()
                .map(|state| state.status.as_str()),
            Some("completed")
        );
        assert!(current
            .live_state
            .as_ref()
            .is_some_and(|state| state.latest_step.finished));
        assert!(current.latest_fields.get("m").is_some());
        assert!(current.latest_fields.get("H_eff").is_some());
        assert_eq!(current.preview_cache.iter().count(), 0);
    }

    #[test]
    fn ordinary_live_field_frame_keeps_incremental_merge_semantics() {
        let mut current = test_current_snapshot();
        let first = serde_json::from_value(json!({
            "session_id": "test-session",
            "latest_fields": { "H_dmi": { "values": [[1.0, 0.0, 0.0]], "layout": { "grid_cells": [1, 1, 1] } } }
        }))
        .expect("first incremental frame");
        let second = serde_json::from_value(json!({
            "session_id": "test-session",
            "latest_fields": { "H_eff": { "values": [[0.0, 1.0, 0.0]], "layout": { "grid_cells": [1, 1, 1] } } }
        }))
        .expect("second incremental frame");

        apply_current_live_field_frame(&mut current, first).expect("first frame should apply");
        apply_current_live_field_frame(&mut current, second).expect("second frame should apply");
        assert!(current.latest_fields.get("H_dmi").is_some());
        assert!(current.latest_fields.get("H_eff").is_some());
    }

    #[test]
    fn snapshot_promotes_active_preview_field_after_clear_preview_cache() {
        let mut current = test_current_snapshot();
        // Seed with an old cached field that should be wiped.
        merge_cached_preview_fields(&mut current.preview_cache, vec![preview_field("H_demag")]);
        assert!(current.preview_cache.get("H_demag").is_some());

        // Set up live_state with active preview field = H_eff.
        current.live_state = Some(LiveState {
            status: "running".into(),
            updated_at_unix_ms: 1_700_000_000_000,
            latest_step: StepUpdateView {
                step: 10,
                time: 1e-9,
                dt: 1e-13,
                pseudo_time_s: None,
                e_ex: 0.0,
                e_demag: 0.0,
                e_ext: 0.0,
                e_ani: 0.0,
                e_dmi: 0.0,
                e_total: 0.0,
                max_dm_dt: 0.0,
                max_h_eff: 0.0,
                max_h_demag: 0.0,
                max_torque_Apm: 0.0,
                max_torque_T: 0.0,
                wall_time_ns: 100,
                grid: [1, 1, 1],
                fem_mesh_generation_id: None,
                fem_mesh: None,
                magnetization: None,
                per_object_scalars: Default::default(),
                field_materialization_states: Vec::new(),
                preview_field: Some(preview_field("H_eff")),
                finished: false,
            },
        });

        // Apply a snapshot with clear_preview_cache = true but no new
        // preview_fields or live_state.  This simulates a mesh change where the
        // runner clears old cached fields.
        let req = CurrentLiveSnapshotRequest {
            session_id: "test-session".to_string(),
            coupled_checkpoint: None,
            session: None,
            session_status: None,
            metadata: None,
            mesh_workspace: None,
            stage_execution: None,
            simulation_preparation: None,
            run: None,
            live_state: None,
            latest_scalar_row: None,
            latest_fields: None,
            replace_latest_fields: false,
            field_generation: None,
            preview_fields: None,
            clear_preview_cache: true,
            engine_log: None,
            solver_profile: None,
            fem_mesh: None,
        };
        apply_current_live_snapshot(&mut current, req).unwrap();

        // H_demag should have been wiped by clear_preview_cache.
        assert!(
            current.preview_cache.get("H_demag").is_none(),
            "old cached H_demag should be cleared"
        );
        // H_eff from live_state.latest_step.preview_field should be
        // re-promoted after the cache clear.
        let cached = current
            .preview_cache
            .get("H_eff")
            .expect("active preview field should survive clear_preview_cache");
        assert_eq!(cached.quantity, "H_eff");
        assert!(
            current.field_quantity_revisions.contains_key("H_eff"),
            "promoted active preview field should publish a field revision"
        );
        assert!(
            current.field_catalog_revision > 0,
            "promoted active preview field should update the field catalog revision"
        );
    }

    #[test]
    fn runtime_frame_promotes_carried_preview_field_with_field_revision() {
        let mut current = test_current_snapshot();
        current.live_state = Some(LiveState {
            status: "running".into(),
            updated_at_unix_ms: 1_700_000_000_000,
            latest_step: StepUpdateView {
                step: 10,
                time: 1e-9,
                dt: 1e-13,
                pseudo_time_s: None,
                e_ex: 0.0,
                e_demag: 0.0,
                e_ext: 0.0,
                e_ani: 0.0,
                e_dmi: 0.0,
                e_total: 0.0,
                max_dm_dt: 0.0,
                max_h_eff: 0.0,
                max_h_demag: 0.0,
                max_torque_Apm: 0.0,
                max_torque_T: 0.0,
                wall_time_ns: 100,
                grid: [1, 1, 1],
                fem_mesh_generation_id: None,
                fem_mesh: None,
                magnetization: None,
                per_object_scalars: Default::default(),
                field_materialization_states: Vec::new(),
                preview_field: Some(preview_field("H_eff")),
                finished: false,
            },
        });

        apply_current_live_runtime_frame(
            &mut current,
            CurrentLiveRuntimeFrameRequest {
                session_id: "test-session".to_string(),
                live_state: Some(LiveState {
                    status: "running".into(),
                    updated_at_unix_ms: 1_700_000_001_000,
                    latest_step: StepUpdateView {
                        step: 11,
                        time: 1.1e-9,
                        dt: 1e-13,
                        pseudo_time_s: None,
                        e_ex: 0.0,
                        e_demag: 0.0,
                        e_ext: 0.0,
                        e_ani: 0.0,
                        e_dmi: 0.0,
                        e_total: 0.0,
                        max_dm_dt: 0.0,
                        max_h_eff: 0.0,
                        max_h_demag: 0.0,
                        max_torque_Apm: 0.0,
                        max_torque_T: 0.0,
                        wall_time_ns: 100,
                        grid: [1, 1, 1],
                        fem_mesh_generation_id: None,
                        fem_mesh: None,
                        magnetization: None,
                        per_object_scalars: Default::default(),
                        field_materialization_states: Vec::new(),
                        preview_field: None,
                        finished: false,
                    },
                }),
                engine_log: None,
                solver_profile: None,
                fem_mesh: None,
            },
        )
        .expect("runtime frame should apply");

        assert!(
            current.preview_cache.get("H_eff").is_some(),
            "carried active preview field should be promoted into preview_cache"
        );
        assert!(
            current.field_quantity_revisions.contains_key("H_eff"),
            "carried active preview field should publish a field revision"
        );
    }
}
