//! Interactive session supervisor.
//!
//! Owns the session-level context (IDs, paths, timestamps, plan summaries)
//! needed by the interactive command loop to publish session/run manifests.
//!
//! The supervisor does NOT own the runtime itself — that stays in
//! `InteractiveRuntimeHost`. Instead, the supervisor provides the context
//! struct that the runtime actor needs when publishing state transitions.

use std::path::PathBuf;

use fullmag_ir::{BackendTarget, ExecutionMode, ExecutionPrecision};

use crate::args::{backend_target_name, execution_mode_name, execution_precision_name};
use crate::step_utils::stage_artifact_dir;
use crate::types::*;

/// Session-level context needed to build manifests during interactive dispatch.
///
/// This struct is populated once when the interactive mode begins and
/// passed by reference to the command loop and state-transition helpers.
pub(crate) struct InteractiveSessionContext {
    pub session_id: String,
    pub run_id: String,
    pub interactive_requested: bool,
    pub script_path: PathBuf,
    pub final_problem_name: String,
    pub requested_backend: BackendTarget,
    pub execution_mode: ExecutionMode,
    pub precision: ExecutionPrecision,
    pub artifact_dir: PathBuf,
    #[allow(dead_code)]
    pub workspace_dir: PathBuf,
    pub started_at_unix_ms: u128,
    #[allow(dead_code)]
    pub field_every_n: u64,
}

impl InteractiveSessionContext {
    /// Build a session manifest with the given status.
    pub(crate) fn build_session(
        &self,
        status: &str,
        plan_summary: &serde_json::Value,
        now_unix_ms: u128,
    ) -> SessionManifest {
        let runtime = crate::orchestrator::requested_runtime_selection(
            backend_target_name(self.requested_backend),
            false,
            "auto",
            execution_precision_name(self.precision),
            execution_mode_name(self.execution_mode),
            None,
        );
        crate::orchestrator::build_session_manifest(
            &self.session_id,
            &self.run_id,
            status,
            self.interactive_requested,
            &self.script_path,
            &self.final_problem_name,
            &runtime,
            &self.artifact_dir,
            self.started_at_unix_ms,
            now_unix_ms,
            plan_summary.clone(),
        )
    }

    /// Build a run manifest from aggregated steps with the given status.
    pub(crate) fn build_run(
        &self,
        status: &str,
        aggregated_steps: &[fullmag_runner::StepStats],
    ) -> RunManifest {
        crate::orchestrator::run_manifest_from_steps(
            &self.run_id,
            &self.session_id,
            status,
            &self.artifact_dir,
            aggregated_steps,
        )
    }

    /// Create a stage artifact directory path.
    #[allow(dead_code)]
    pub(crate) fn stage_artifact_dir(
        &self,
        stage_index: usize,
        stage_count: usize,
        entrypoint_kind: &str,
    ) -> PathBuf {
        stage_artifact_dir(
            &self.workspace_dir,
            &self.artifact_dir,
            stage_index,
            stage_count,
            entrypoint_kind,
        )
    }
}

/// Outcome of a single iteration of the interactive command loop.
#[derive(Debug)]
#[allow(dead_code)]
pub(crate) enum InteractiveLoopOutcome {
    /// Continue processing commands.
    Continue,
    /// The interactive session should close.
    Close,
}

/// Holds a paused interactive stage that can be resumed.
#[allow(dead_code)]
pub(crate) struct PausedInteractiveStage {
    pub command: SessionCommand,
    pub source_kind: String,
}
