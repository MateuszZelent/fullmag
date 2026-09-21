//! Shared admission policy for manual mesh replacement.

use std::collections::VecDeque;

use fullmag_runner::RuntimeStatus;

use crate::session::effective_runtime_status_code;
use crate::types::{CommandLifecycleState, SessionStateResponse, TrackedCommandRecord};

pub(super) fn is_compute_command(kind: &str) -> bool {
    matches!(
        kind,
        "run" | "relax" | "solve" | "compute_fields" | "compute_energies" | "apply_frozen_spins"
    )
}

fn is_active(record: &TrackedCommandRecord) -> bool {
    matches!(
        record.status,
        CommandLifecycleState::Queued
            | CommandLifecycleState::Accepted
            | CommandLifecycleState::Dispatched
            | CommandLifecycleState::Running
    )
}

pub(super) fn has_active_mesh_command(ledger: &VecDeque<TrackedCommandRecord>) -> bool {
    ledger.iter().any(|record| {
        is_active(record) && matches!(record.command.kind.as_str(), "remesh" | "fdm_grid_refresh")
    })
}

pub(super) fn is_active_mesh_or_compute_command(record: &TrackedCommandRecord) -> bool {
    is_active(record)
        && (matches!(record.command.kind.as_str(), "remesh" | "fdm_grid_refresh")
            || is_compute_command(&record.command.kind))
}

pub(super) fn remesh_disabled_reason(
    snapshot: Option<&SessionStateResponse>,
    ledger: &VecDeque<TrackedCommandRecord>,
) -> Option<String> {
    let Some(snapshot) = snapshot else {
        return Some("Runtime state is unavailable.".into());
    };
    let state = RuntimeStatus::from_status_code(&effective_runtime_status_code(snapshot));
    match state {
        RuntimeStatus::Running => {
            return Some("Stop the running stage before rebuilding the mesh.".into());
        }
        RuntimeStatus::Paused => {
            return Some(
                "Stop the paused stage before rebuilding the mesh; Resume uses its current mesh."
                    .into(),
            );
        }
        RuntimeStatus::AwaitingCommand | RuntimeStatus::WaitingForCompute => {}
        _ => return Some("Runtime is not ready to rebuild the mesh.".into()),
    }
    if ledger.iter().any(is_active_mesh_or_compute_command) {
        return Some("A mesh or compute command is already active.".into());
    }
    None
}
