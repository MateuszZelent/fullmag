//! Cooperative checkpoint interface for solver step loops.
//!
//! Provides [`CheckpointContext`] — a per-segment control poller that wraps
//! the display selection callback and interrupt flag, returning typed
//! [`RuntimeControlOutcome`] values instead of raw booleans.

use std::sync::atomic::{AtomicBool, Ordering};

use crate::interactive::commands::RuntimeControlOutcome;
use crate::interactive::display::DisplaySelectionState;
use crate::interactive_runtime::display_refresh_due;

/// Context for polling runtime control within a solver step loop.
///
/// Created at segment entry and used after each step to check for
/// pending pause, break, close, or display-refresh requests.
pub(crate) struct CheckpointContext<'a> {
    /// Callback that returns the current display selection state from the control plane.
    pub display_selection: &'a (dyn Fn() -> DisplaySelectionState + Send + Sync),
    /// Shared flag set by the control thread when an interrupt-class command arrives.
    pub interrupt_requested: Option<&'a AtomicBool>,
    /// Last display revision that was published. Updated by the step loop after emitting preview.
    pub last_preview_revision: Option<u64>,
}

impl<'a> CheckpointContext<'a> {
    /// Poll for pending control actions.
    ///
    /// This should be called after each solver step (or more frequently for
    /// backends that support mid-step checkpointing).
    ///
    /// Returns:
    /// - `Continue` — no pending control, keep stepping
    /// - `PauseRequested` — the user requested pause; the loop should yield cleanly
    /// - `BreakRequested` — the user requested break; end the segment
    /// - `CloseRequested` — the session is closing
    pub fn check_control(&self) -> RuntimeControlOutcome {
        // Check interrupt first — it's the fast path for pause/break/close
        if let Some(flag) = self.interrupt_requested {
            if flag.load(Ordering::Relaxed) {
                // Clear the flag so we don't re-trigger on next poll.
                // The specific interrupt type (pause vs break vs close) is
                // determined by the orchestrator when it processes the
                // StepAction::Stop from our on_step callback.
                //
                // For now, we report PauseRequested as the default interrupt
                // outcome. The orchestrator differentiates based on the actual
                // command in the queue.
                flag.store(false, Ordering::Relaxed);
                return RuntimeControlOutcome::PauseRequested;
            }
        }

        RuntimeControlOutcome::Continue
    }

    /// Check if a display refresh is due at the given step.
    ///
    /// This wraps the existing `display_refresh_due()` logic and returns
    /// the current display state for preview construction.
    #[allow(dead_code)]
    pub fn display_refresh_check(&self, step: u64) -> Option<DisplaySelectionState> {
        let display_state = (self.display_selection)();
        if display_refresh_due(self.last_preview_revision, &display_state, step) {
            Some(display_state)
        } else {
            None
        }
    }

    /// Record that a display refresh was published for the given revision.
    pub fn mark_display_refreshed(&mut self, revision: u64) {
        self.last_preview_revision = Some(revision);
    }
}

/// Outcome of a solver segment execution.
///
/// Extends the simple `cancelled: bool` with typed reasons for termination.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunOutcome {
    /// The segment ran to its target time/convergence criterion.
    Completed,
    /// The segment was interrupted by a control command (StepAction::Stop).
    /// The orchestrator determines the specific action (pause/break/close)
    /// from the command queue.
    Interrupted,
}
