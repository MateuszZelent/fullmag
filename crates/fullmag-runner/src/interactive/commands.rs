use serde::{Deserialize, Serialize};

// ── Sequence stage definition ────────────────────────────────────────────

/// A single stage within a multi-step execution sequence.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SequenceStage {
    /// Time-evolution stage.
    Run {
        until_seconds: f64,
        #[serde(skip_serializing_if = "Option::is_none")]
        max_steps: Option<u64>,
    },
    /// Relaxation stage.
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
}

impl SequenceStage {
    /// Human-readable label for the stage.
    pub fn label(&self) -> &'static str {
        match self {
            SequenceStage::Run { .. } => "run",
            SequenceStage::Relax { .. } => "relax",
        }
    }

    /// Convert this stage to a standalone `LiveControlCommand`.
    pub fn to_command(&self) -> LiveControlCommand {
        match self.clone() {
            SequenceStage::Run {
                until_seconds,
                max_steps,
            } => LiveControlCommand::Run {
                until_seconds,
                max_steps,
            },
            SequenceStage::Relax {
                until_seconds,
                max_steps,
                torque_tolerance,
                energy_tolerance,
            } => LiveControlCommand::Relax {
                until_seconds,
                max_steps,
                torque_tolerance,
                energy_tolerance,
            },
        }
    }
}

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

    /// Execute a sequence of stages (run/relax) automatically.
    RunSequence { stages: Vec<SequenceStage> },
    /// Skip the current stage in an active sequence and advance to the next one.
    SkipStage,
}

/// A control command with a monotonic sequence number for total ordering.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SequencedCommand {
    pub seq: u64,
    pub session_id: String,
    pub issued_at_unix_ms: u64,
    pub command: LiveControlCommand,
}

/// Outcome from a cooperative checkpoint poll within a running backend.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeControlOutcome {
    /// Continue the current operation.
    Continue,
    /// A pause has been requested — backend should yield cleanly.
    PauseRequested,
    /// A break has been requested — end the current segment cleanly.
    BreakRequested,
    /// Display has been updated — continue execution.
    DisplayUpdated,
    /// Close the runtime entirely.
    CloseRequested,
}

/// Bridge: convert a legacy string-based session command (from the API)
/// into a typed `LiveControlCommand`.
///
/// Returns `None` for command kinds that are not part of the live control
/// protocol (e.g. `"remesh"`, `"save_vtk"`, `"solve"`) — those remain
/// handled by the orchestrator's own dispatch.
pub fn parse_session_command(
    kind: &str,
    until_seconds: Option<f64>,
    max_steps: Option<u64>,
    torque_tolerance: Option<f64>,
    energy_tolerance: Option<f64>,
    display_selection: Option<&super::DisplaySelectionState>,
    stages: Option<Vec<SequenceStage>>,
) -> Option<LiveControlCommand> {
    match kind {
        "run" => Some(LiveControlCommand::Run {
            until_seconds: until_seconds.unwrap_or(0.0),
            max_steps,
        }),
        "relax" => Some(LiveControlCommand::Relax {
            until_seconds,
            max_steps,
            torque_tolerance,
            energy_tolerance,
        }),
        "pause" => Some(LiveControlCommand::Pause),
        "resume" => Some(LiveControlCommand::Resume),
        "stop" | "break" => Some(LiveControlCommand::Break),
        "close" => Some(LiveControlCommand::Close),
        "display_selection_update" | "preview_update" => display_selection
            .cloned()
            .map(|ds| LiveControlCommand::SetDisplaySelection(ds.selection)),
        "preview_refresh" => Some(LiveControlCommand::RefreshDisplay),
        "run_sequence" => {
            let stages = stages.unwrap_or_default();
            if stages.is_empty() {
                None
            } else {
                Some(LiveControlCommand::RunSequence { stages })
            }
        }
        "skip" | "skip_stage" => Some(LiveControlCommand::SkipStage),
        _ => None,
    }
}
