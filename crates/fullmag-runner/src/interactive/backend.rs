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

    /// Return the lightweight solver-owned Frozen Spins activation
    /// certificate, if this backend has an active or historically retained
    /// constraint set.
    fn frozen_spins_runtime_status(&self) -> Option<crate::constraints::FrozenSpinsRuntimeStatus> {
        None
    }

    /// Check whether the backend is compatible with the given problem
    /// without needing to rebuild.
    fn matches_problem(&self, problem: &ProblemIR) -> Result<bool, RunError>;

    /// Check whether the backend is compatible with an already materialized
    /// execution plan.
    fn matches_plan(&self, plan: &ExecutionPlanIR) -> Result<bool, RunError>;

    /// Check whether a stage can continue on this backend without replacing
    /// its physical solver context. Unlike `matches_plan`, this ignores
    /// stage-local execution controls such as relaxation algorithm and
    /// timestep policy.
    fn can_continue_with_plan(&self, plan: &ExecutionPlanIR) -> Result<bool, RunError>;

    /// Apply stage-scoped state after `can_continue_with_plan` has confirmed
    /// that the physical solver context can be retained. Backends with no
    /// mutable stage-owned physics may use the default no-op.
    fn apply_stage_plan(&mut self, plan: &ExecutionPlanIR) -> Result<(), RunError> {
        if self.can_continue_with_plan(plan)? {
            Ok(())
        } else {
            Err(RunError {
                message: "interactive runtime context mismatch; caller must rebuild runtime before applying the stage plan".to_string(),
            })
        }
    }

    /// Whether this backend can atomically recapture an explicitly edited
    /// Frozen Spins constraint without replacing its physical context.
    fn supports_frozen_spins_reactivation_in_place(&self) -> bool {
        false
    }

    /// Apply an authoring-triggered Frozen Spins reactivation. This differs
    /// from a continuous stage transition: every active constraint receives a
    /// new epoch and CaptureCurrentAtActivation observes the current solver m.
    fn apply_frozen_spins_reactivation_plan(
        &mut self,
        _plan: &ExecutionPlanIR,
    ) -> Result<(), RunError> {
        Err(RunError {
            message: "interactive backend requires rebuild for explicit Frozen Spins reactivation"
                .to_string(),
        })
    }

    /// The geometry of the backend (grid for FDM, mesh for FEM).
    fn geometry(&self) -> BackendGeometry;

    /// Apply solver-profile settings that need backend-owned runtime state.
    ///
    /// The generic profile ring buffer is owned by the caller. Backends only
    /// need this when native phase timing must be enabled at the solver layer.
    fn set_solver_profile_config(
        &mut self,
        _config: &crate::SolverProfileConfig,
    ) -> Result<(), RunError> {
        Ok(())
    }

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
