//! Session state management: publish, refresh, default state.

use crate::artifacts::collect_artifacts;
use crate::error::ApiError;
use crate::quantities::{build_quantities, extract_fem_mesh_from_metadata};
use crate::router_v2::handlers::data::field_resolution::{
    field_values_match_current_domain, flatten_json_field_values, live_magnetization_values,
};
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
            if command_has_terminal_log(record, snapshot, "Field snapshots computed")
                || snapshot_has_field_readback(snapshot) =>
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

fn snapshot_has_field_readback(snapshot: &SessionStateResponse) -> bool {
    snapshot.latest_fields.len() > 0 || snapshot.preview_cache.iter().next().is_some()
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

#[derive(Debug, Clone, PartialEq)]
enum EffectiveFieldSource {
    Latest(Value),
    Preview(LivePreviewField),
    LiveMagnetization { len: usize, hash: u64 },
}

impl EffectiveFieldSource {
    fn baseline_revision(&self) -> Option<u64> {
        match self {
            Self::Latest(value) => field_payload_revision(value),
            Self::Preview(_) | Self::LiveMagnetization { .. } => None,
        }
    }
}

fn live_magnetization_hash(values: &[f64]) -> u64 {
    values.iter().fold(1469598103934665603_u64, |hash, value| {
        hash.wrapping_mul(1099511628211)
            .wrapping_add(value.to_bits())
    })
}

fn effective_field_source(
    snapshot: &SessionStateResponse,
    quantity: &str,
) -> Option<EffectiveFieldSource> {
    let n_comp = fullmag_quantities::quantity_spec(quantity)
        .map(|spec| spec.n_comp as usize)
        .unwrap_or(3);
    if quantity == "m" {
        if let Some((values, _grid)) = live_magnetization_values(snapshot) {
            return Some(EffectiveFieldSource::LiveMagnetization {
                len: values.len(),
                hash: live_magnetization_hash(&values),
            });
        }
    }
    if let Some(value) = snapshot.latest_fields.get(quantity) {
        let values = flatten_json_field_values(value);
        if field_values_match_current_domain(snapshot, quantity, n_comp, &values) {
            return Some(EffectiveFieldSource::Latest(value.clone()));
        }
    }
    if let Some(field) = snapshot.preview_cache.get(quantity) {
        if field_values_match_current_domain(snapshot, quantity, n_comp, &field.vector_field_values)
        {
            return Some(EffectiveFieldSource::Preview(field.clone()));
        }
    }
    None
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
    format!(
        "{}:{}:{}:{}:{}",
        mesh.generation_id.as_deref().unwrap_or(""),
        mesh.mesh_id,
        mesh.nodes.len(),
        mesh.elements.len(),
        mesh.boundary_faces.len()
    )
}

fn is_solver_domain_fem_mesh(mesh: &fullmag_runner::FemMeshPayload) -> bool {
    !mesh.elements.is_empty()
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
            artifact_dir,
            started_at_unix_ms: now,
            finished_at_unix_ms: now,
            plan_summary: serde_json::json!({}),
        }),
        run: None,
        live_state: None,
        runtime_status: build_runtime_status_view(&status),
        capabilities: None,
        metadata: None,
        mesh_workspace: None,
        stage_execution: None,
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
        stage_execution_revision: 0,
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

fn apply_current_live_metadata(current: &mut SessionStateResponse, metadata: Value) {
    current.metadata = Some(metadata);
    if let Some(metadata) = current.metadata.as_ref() {
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
            .live_state
            .as_ref()
            .and_then(|state| state.latest_step.fem_mesh.clone())
            .or_else(|| {
                current
                    .metadata
                    .as_ref()
                    .and_then(extract_fem_mesh_from_metadata)
            });
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
    if finished || (current.artifacts.is_empty() && flags.has_run) {
        let artifact_dir = current_artifact_dir(current);
        current.artifacts = read_artifacts_from_dir(artifact_dir.as_deref())?;
    }

    Ok(())
}

pub(crate) fn apply_current_live_snapshot(
    current: &mut SessionStateResponse,
    req: CurrentLiveSnapshotRequest,
) -> Result<(), ApiError> {
    let mut affected_field_quantities = BTreeSet::new();
    if let Some(latest_fields) = req.latest_fields.as_ref() {
        affected_field_quantities.extend(
            latest_fields
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
    if req.live_state.is_some() || req.fem_mesh.is_some() {
        affected_field_quantities.insert("m".to_string());
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
    if let Some(live_state) = req.live_state {
        if current.run.is_none() && current.session.status == "bootstrapping" {
            current.session.status = live_state.status.clone();
        }
        if let Some(fem_mesh) = live_state.latest_step.fem_mesh.clone() {
            apply_fem_mesh_update(current, fem_mesh);
        }
        current.live_state = Some(live_state);
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
        merge_latest_fields(&mut current.latest_fields, latest_fields);
    }
    if req.clear_preview_cache {
        current.preview_cache = CachedPreviewFields::default();
    }
    if let Some(preview_fields) = req.preview_fields {
        merge_cached_preview_fields(&mut current.preview_cache, preview_fields);
    }
    if let Some(engine_log) = req.engine_log {
        current.engine_log = engine_log;
    }
    if let Some(solver_profile) = req.solver_profile {
        current.solver_profile = solver_profile;
    }
    apply_effective_field_source_delta(current, previous_field_sources);

    finalize_current_live_apply(current, flags)
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
    let mut affected_field_quantities = BTreeSet::new();
    if frame.live_state.is_some() || frame.fem_mesh.is_some() {
        affected_field_quantities.insert("m".to_string());
    }
    let previous_field_sources =
        capture_effective_field_sources(current, &affected_field_quantities);
    if let Some(mut live_state) = frame.live_state {
        if current.run.is_none() && current.session.status == "bootstrapping" {
            current.session.status = live_state.status.clone();
        }
        if let Some(fem_mesh) = live_state.latest_step.fem_mesh.clone() {
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
            if live_state.latest_step.fem_mesh.is_none() {
                live_state.latest_step.fem_mesh = prev.latest_step.fem_mesh.clone();
            }
            if live_state.latest_step.preview_field.is_none() {
                live_state.latest_step.preview_field = prev.latest_step.preview_field.clone();
            }
        }
        current.live_state = Some(live_state);
    }
    if let Some(fem_mesh) = frame.fem_mesh {
        apply_fem_mesh_update(current, fem_mesh);
    }
    if let Some(engine_log) = frame.engine_log {
        current.engine_log = engine_log;
    }
    if let Some(solver_profile) = frame.solver_profile {
        current.solver_profile = solver_profile;
    }
    apply_effective_field_source_delta(current, previous_field_sources);

    finalize_current_live_apply(current, CurrentLiveApplyFlags::default())
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
    let mut affected_field_quantities = BTreeSet::new();
    if let Some(latest_fields) = frame.latest_fields.as_ref() {
        affected_field_quantities.extend(
            latest_fields
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
        merge_latest_fields(&mut current.latest_fields, latest_fields);
    }
    if frame.clear_preview_cache {
        current.preview_cache = CachedPreviewFields::default();
    }
    if let Some(preview_fields) = frame.preview_fields {
        merge_cached_preview_fields(&mut current.preview_cache, preview_fields);
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
    for field in incoming {
        current.insert(field);
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

    fn scalar_row(step: u64, e_total: f64) -> ScalarRow {
        ScalarRow {
            step,
            time: step as f64 * 1e-12,
            solver_dt: 1e-12,
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
                fem_mesh: None,
                magnetization: Some(magnetization),
                per_object_scalars: Default::default(),
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
    fn scalar_frame_revisions_track_latest_replacements_not_stale_rows() {
        let mut current = default_current_live_state(&CurrentLiveSnapshotRequest {
            session_id: "test-session".to_string(),
            session: None,
            session_status: None,
            metadata: None,
            mesh_workspace: None,
            stage_execution: None,
            run: None,
            live_state: None,
            latest_scalar_row: None,
            latest_fields: None,
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
                session: None,
                session_status: None,
                metadata: None,
                mesh_workspace: None,
                stage_execution: None,
                run: None,
                live_state: Some(live_state_with_magnetization(
                    1,
                    vec![1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
                )),
                latest_scalar_row: None,
                latest_fields: Some(stale_latest_fields),
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
                session: None,
                session_status: None,
                metadata: None,
                mesh_workspace: None,
                stage_execution: None,
                run: None,
                live_state: Some(live_state_with_magnetization(
                    10,
                    vec![0.0, 1.0, 0.0, -1.0, 0.0, 0.0],
                )),
                latest_scalar_row: None,
                latest_fields: None,
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
            session: None,
            session_status: None,
            metadata: None,
            mesh_workspace: None,
            stage_execution: None,
            run: None,
            live_state: None,
            latest_scalar_row: None,
            latest_fields: None,
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
                artifact_refs: Vec::new(),
                checkpoint_ref: None,
                loaded_state_ref: None,
                resume_from_checkpoint_ref: None,
                state_transition: None,
                metric_name: None,
                metric_value: None,
                threshold: None,
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
        current.latest_fields =
            serde_json::from_value(json!({"m": {"generation": 1}})).expect("valid fields fixture");
        current.scalar_rows.push(scalar_row(1, 2.0));

        let mut ledger = VecDeque::from([
            tracked_command("cmd-fields", "compute_fields"),
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
                fem_mesh: None,
                magnetization: None,
                per_object_scalars: Default::default(),
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
                fem_mesh: None,
                magnetization: None,
                per_object_scalars: Default::default(),
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
    fn snapshot_reconciliation_marks_compute_fields_terminal_from_preview_cache() {
        let mut current = test_current_snapshot();
        merge_cached_preview_fields(&mut current.preview_cache, vec![preview_field("m")]);

        let mut ledger = VecDeque::from([tracked_command("cmd-fields", "compute_fields")]);

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
            session: None,
            session_status: None,
            metadata: None,
            mesh_workspace: None,
            stage_execution: None,
            run: None,
            live_state: None,
            latest_scalar_row: None,
            latest_fields: None,
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
                artifact_refs: vec!["artifacts/stage-000".into(), "cp-common-state".into()],
                checkpoint_ref: Some("cp-000042".into()),
                loaded_state_ref: Some("cp-common-state".into()),
                resume_from_checkpoint_ref: Some("cp-000041".into()),
                state_transition: Some("restored".into()),
                metric_name: None,
                metric_value: None,
                threshold: None,
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
                        artifact_refs: vec!["artifacts/stage-000".into()],
                        checkpoint_ref: None,
                        loaded_state_ref: None,
                        resume_from_checkpoint_ref: None,
                        state_transition: None,
                        metric_name: None,
                        metric_value: None,
                        threshold: None,
                    }],
                    stage_statuses: vec![StageLifecycleState::Completed],
                    active_stage_index: None,
                    active_stage_kind: None,
                    runtime_state: RuntimeLifecycleState::Completed,
                }),
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

    fn engine_log(timestamp_unix_ms: u128, level: &str, message: &str) -> EngineLogEntry {
        EngineLogEntry {
            timestamp_unix_ms,
            level: level.to_string(),
            message: message.to_string(),
        }
    }

    fn test_current_snapshot() -> SessionStateResponse {
        default_current_live_state(&CurrentLiveSnapshotRequest {
            session_id: "test-session".to_string(),
            session: None,
            session_status: None,
            metadata: None,
            mesh_workspace: None,
            stage_execution: None,
            run: None,
            live_state: None,
            latest_scalar_row: None,
            latest_fields: None,
            preview_fields: None,
            clear_preview_cache: false,
            engine_log: None,
            solver_profile: None,
            fem_mesh: None,
        })
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
            elements: vec![[0, 1, 2, 3]],
            element_markers: vec![1],
            boundary_faces: vec![[0, 1, 2]],
            boundary_markers: vec![1],
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
            domain_mesh_mode: Some("shared_domain".to_string()),
            domain_frame: None,
            generation_id: Some(generation_id.to_string()),
            per_domain_quality: Default::default(),
        }
    }

    fn surface_preview_mesh() -> fullmag_runner::FemMeshPayload {
        fullmag_runner::FemMeshPayload {
            mesh_name: "surface-preview".to_string(),
            mesh_id: "surface-preview-id".to_string(),
            nodes: vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
            elements: Vec::new(),
            element_markers: Vec::new(),
            boundary_faces: vec![[0, 1, 2]],
            boundary_markers: vec![1],
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
            domain_mesh_mode: None,
            domain_frame: None,
            generation_id: None,
            per_domain_quality: Default::default(),
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
                artifact_refs: Vec::new(),
                checkpoint_ref: None,
                loaded_state_ref: None,
                resume_from_checkpoint_ref: None,
                state_transition: None,
                metric_name: None,
                metric_value: None,
                threshold: None,
            }],
            stage_statuses: vec![stage_status],
            active_stage_index,
            active_stage_kind: Some("relax".into()),
            runtime_state,
        }
    }
}
