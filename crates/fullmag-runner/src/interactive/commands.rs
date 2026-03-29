use serde::{Deserialize, Serialize};

/// Typed control commands replacing string-based `kind` field.
///
/// These map 1:1 to the current `SessionCommand.kind` strings used by the API,
/// but provide compile-time exhaustiveness checking.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LiveControlCommand {
    /// Execute a time-evolution segment.
    Run {
        until_seconds: f64,
        #[serde(skip_serializing_if = "Option::is_none")]
        max_steps: Option<u64>,
    },
    /// Execute a relaxation segment.
    Relax {
        #[serde(skip_serializing_if = "Option::is_none")]
        until_seconds: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        max_steps: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        torque_tolerance: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        energy_tolerance: Option<f64>,
    },
    /// Pause the current running segment.
    Pause,
    /// Resume after pause.
    Resume,
    /// Break the current segment and return to `awaiting_command`.
    Break,
    /// Close the interactive session entirely.
    Close,

    /// Change the displayed quantity / component / layer.
    SetDisplaySelection(super::DisplaySelection),
    /// Refresh the display from current backend state.
    RefreshDisplay,
}

/// A control command with a monotonic sequence number for total ordering.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SequencedCommand {
    pub seq: u64,
    pub session_id: String,
    pub issued_at_unix_ms: u64,
    pub command: LiveControlCommand,
}
