use crate::artifact_pipeline::ArtifactPipelineSender;
use crate::types::{
    ExecutedRun, ExecutionProvenance, FemMeshPayload, LivePreviewField, LivePreviewRequest,
    RunError, StepAction, StepStats, StepUpdate,
};
use fullmag_ir::{ExecutionPlanIR, ProblemIR};
use std::sync::atomic::AtomicBool;

/// Geometry information stored by a backend, used for final step updates.
#[derive(Debug, Clone)]
pub enum BackendGeometry {
    Fdm { grid: [u32; 3] },
    Fem { mesh: FemMeshPayload },
}

/// Abstraction over FDM and FEM interactive backends.
///
/// All query methods take `&mut self` because GPU backends may need to:
/// - synchronize device
/// - use scratch buffers
/// - transiently recompute derived fields
///
/// This is consistent with the actor/serial-executor model where
/// the backend is touched from exactly one thread at a time.
pub(crate) trait InteractiveBackend {
    /// Upload new magnetization state into the backend.
    fn upload_magnetization(&mut self, magnetization: &[[f64; 3]]) -> Result<(), RunError>;

    /// Snapshot a single preview field for the given request.
    fn snapshot_preview(
        &mut self,
        request: &LivePreviewRequest,
    ) -> Result<LivePreviewField, RunError>;

    /// Snapshot multiple vector fields at once (e.g. H_ex, H_demag, H_ext, H_eff).
    fn snapshot_vector_fields(
        &mut self,
        quantities: &[&str],
        request: &LivePreviewRequest,
    ) -> Result<Vec<LivePreviewField>, RunError>;

    /// Snapshot scalar diagnostics for the current backend state without stepping.
    fn snapshot_step_stats(&mut self) -> Result<StepStats, RunError>;

    /// Get execution provenance info (engine, precision, device).
    fn execution_provenance(&self) -> ExecutionProvenance;

    /// Check whether the backend is compatible with the given problem
    /// without needing to rebuild.
    fn matches_problem(&self, problem: &ProblemIR) -> Result<bool, RunError>;

    /// Check whether the backend is compatible with an already materialized
    /// execution plan.
    fn matches_plan(&self, plan: &ExecutionPlanIR) -> Result<bool, RunError>;

    /// The geometry of the backend (grid for FDM, mesh for FEM).
    fn geometry(&self) -> BackendGeometry;

    /// Execute a simulation segment with live preview streaming.
    ///
    /// The backend consumes an already materialized execution plan so
    /// interactive compute does not re-sample initial textures.
    fn execute_streaming(
        &mut self,
        problem: &ProblemIR,
        plan: &ExecutionPlanIR,
        until_seconds: f64,
        field_every_n: u64,
        display_selection: &(dyn Fn() -> crate::DisplaySelectionState + Send + Sync),
        interrupt_requested: Option<&AtomicBool>,
        artifact_writer: Option<ArtifactPipelineSender>,
        on_step: &mut dyn FnMut(StepUpdate) -> StepAction,
    ) -> Result<ExecutedRun, RunError>;

    // --- Cooperative checkpoint interface (Phase 0: flag only) ---

    /// Whether this backend supports cooperative mid-step checkpoints.
    ///
    /// When `true`, the runtime may poll for pending display refreshes,
    /// pause requests, etc. without waiting for the current solver step
    /// to complete.
    ///
    /// Default: `false` — the backend only responds to control between steps.
    #[allow(dead_code)]
    fn supports_cooperative_checkpoints(&self) -> bool {
        false
    }
}
