//! Consolidated typed command bridge.
//!
//! Wraps `fullmag_runner::parse_session_command()` so that call sites
//! never need to repeat the 6-argument conversion from `SessionCommand`
//! field-by-field.

use crate::types::SessionCommand;
use fullmag_runner::LiveControlCommand;

/// Classify a legacy `SessionCommand` into a typed `LiveControlCommand`.
///
/// Returns `None` for orchestrator-only commands such as `"load_state"`,
/// `"save_vtk"`, `"remesh"`, `"solve"`,  which are not part of the live
/// control protocol.
pub(crate) fn classify_command(command: &SessionCommand) -> Option<LiveControlCommand> {
    fullmag_runner::parse_session_command(
        &command.kind,
        command.until_seconds,
        command.max_steps,
        command.torque_tolerance,
        command.energy_tolerance,
        command.display_selection.as_ref(),
        command.stages.clone(),
    )
}

/// Whether the command classification represents a runtime interrupt
/// that should wake the solver step loop.
pub(crate) fn is_interrupt_command(typed: &LiveControlCommand) -> bool {
    matches!(
        typed,
        LiveControlCommand::Pause
            | LiveControlCommand::Break
            | LiveControlCommand::Close
            | LiveControlCommand::SkipStage
    )
}
