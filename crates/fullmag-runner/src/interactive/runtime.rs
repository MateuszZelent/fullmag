use std::path::Path;
use std::sync::atomic::AtomicBool;

use crate::artifact_pipeline::ArtifactPipeline;
use crate::artifacts;
use crate::types::{
    ExecutedRun, LivePreviewField, LivePreviewRequest, RunError, RunResult, StepAction, StepStats,
    StepUpdate,
};
use fullmag_ir::{ExecutionPlanIR, ProblemIR, StudyIR};

use super::backend::{BackendGeometry, InteractiveBackend};
use super::cache::DisplayCache;
use super::display::{DisplayKind, DisplayPayload, DisplaySelection, DisplaySelectionState};

pub(crate) fn build_atomic_terminal_update(
    backend: &mut dyn InteractiveBackend,
    plan: &ExecutionPlanIR,
    display_revision: u64,
    executed: &ExecutedRun,
) -> Result<Option<StepUpdate>, RunError> {
    if !crate::interactive_runtime::should_materialize_terminal_fields(executed.result.status) {
        return Ok(None);
    }
    let final_stats = executed.result.steps.last().cloned().unwrap_or_default();
    let final_m = executed
        .result
        .final_magnetization
        .iter()
        .flat_map(|value| value.iter().copied())
        .collect::<Vec<_>>();
    let (grid, fem_mesh_generation_id) = match backend.geometry() {
        BackendGeometry::Fdm { grid } => (grid, None),
        BackendGeometry::Fem { mesh } => ([0u32, 0, 0], mesh.generation_id),
    };
    let cached_preview_fields = {
        let request = LivePreviewRequest {
            revision: display_revision,
            quantity: "m".to_string(),
            component: "3D".to_string(),
            layer: 0,
            all_layers: true,
            every_n: 1,
            x_chosen_size: 0,
            y_chosen_size: 0,
            auto_scale_enabled: false,
            max_points: 0,
        };
        let quantities = crate::ObservationProviderResolver::from_backend_plan(&plan.backend_plan)
            .terminal_snapshot_quantity_ids();
        let mut fields = backend
            .snapshot_vector_fields(&quantities, &request)
            .map_err(|error| RunError {
                message: format!(
                    "completed solve could not be finalized because terminal field materialization failed: {}",
                    error.message
                ),
            })?;
        let materialized_at_unix_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        for field in &mut fields {
            field.source_step = final_stats.step;
            field.source_time_seconds = Some(final_stats.time);
            field.source_revision = final_stats.step;
            field.materialized_at_unix_ms = materialized_at_unix_ms;
        }
        Some(fields)
    };

    Ok(Some(StepUpdate {
        coupled_checkpoint: None,
        stats: final_stats,
        grid,
        fem_mesh_generation_id,
        magnetization: Some(final_m),
        preview_field: None,
        cached_preview_fields,
        hysteresis_field_m_t: None,
        hysteresis_point_index: None,
        hysteresis_settle_step_index: None,
        hysteresis_settle_step_kind: None,
        hysteresis_settle_step_method: None,
        scalar_row_due: true,
        terminal_field_snapshot: false,
        finished: true,
    }))
}

pub(crate) fn publish_atomic_terminal_update(
    backend: &mut dyn InteractiveBackend,
    plan: &ExecutionPlanIR,
    display_revision: u64,
    executed: &ExecutedRun,
    on_step: &mut dyn FnMut(StepUpdate) -> StepAction,
) -> Result<(), RunError> {
    if let Some(terminal_update) =
        build_atomic_terminal_update(backend, plan, display_revision, executed)?
    {
        on_step(terminal_update);
    }
    Ok(())
}

/// Unified interactive runtime facade.
///
/// Owns a backend (FDM or FEM) and tracks display state + revision counters.
/// This is the single type that the CLI should hold instead of a manual
/// `enum { Fdm(...), Fem(...) }` with delegation boilerplate.
pub struct InteractiveRuntime {
    backend: Box<dyn InteractiveBackend>,
    frozen_spins_activation_set: crate::constraints::FrozenSpinsActivationSet,
    state_revision: u64,
    display_revision: u64,
    selected_display: DisplaySelection,
    display_cache: DisplayCache,
}

fn prepare_runtime_frozen_spins_activation_set(
    previous: Option<crate::constraints::FrozenSpinsActivationSet>,
    active_constraint_ids: std::collections::BTreeSet<String>,
    explicit_reactivation: bool,
) -> Result<crate::constraints::FrozenSpinsActivationSet, RunError> {
    let previous = previous.unwrap_or_default();
    if active_constraint_ids.is_empty() && previous.resolved_constraint_set_revision == 0 {
        return Ok(previous);
    }
    let prepared = if explicit_reactivation {
        previous.prepare_reactivation(active_constraint_ids)
    } else {
        previous.prepare_transition(active_constraint_ids)
    };
    prepared.map_err(|error| RunError {
        message: format!("preparing Frozen Spins runtime activation metadata failed: {error}"),
    })
}

fn frozen_spins_resolved_identity_changed(
    before: Option<&crate::constraints::FrozenSpinsRuntimeStatus>,
    after: Option<&crate::constraints::FrozenSpinsRuntimeStatus>,
) -> bool {
    match (before, after) {
        (None, None) => false,
        (Some(_), None) | (None, Some(_)) => true,
        (Some(before), Some(after)) => {
            before.active_constraint_ids != after.active_constraint_ids
                || before.topology_fingerprint != after.topology_fingerprint
                || before.source_state_revision != after.source_state_revision
                || before.mask_sha256 != after.mask_sha256
                || before.reference_sha256 != after.reference_sha256
                || before.active_site_count != after.active_site_count
                || before.frozen_site_count != after.frozen_site_count
                || before.free_site_count != after.free_site_count
        }
    }
}

impl InteractiveRuntime {
    pub(crate) fn new_with_frozen_spins_activation_set(
        backend: Box<dyn InteractiveBackend>,
        previous: Option<crate::constraints::FrozenSpinsActivationSet>,
        explicit_reactivation: bool,
    ) -> Result<Self, RunError> {
        let active_constraint_ids = backend
            .frozen_spins_runtime_status()
            .map(|status| status.active_constraint_ids)
            .unwrap_or_default();
        let frozen_spins_activation_set = prepare_runtime_frozen_spins_activation_set(
            previous,
            active_constraint_ids,
            explicit_reactivation,
        )?;
        Ok(Self {
            backend,
            frozen_spins_activation_set,
            state_revision: 0,
            display_revision: 0,
            selected_display: DisplaySelection::default(),
            display_cache: DisplayCache::new(),
        })
    }

    /// Upload new magnetization into the backend.
    /// Increments `state_revision`.
    pub fn upload_magnetization(&mut self, magnetization: &[[f64; 3]]) -> Result<(), RunError> {
        self.backend.upload_magnetization(magnetization)?;
        self.state_revision += 1;
        self.display_cache.invalidate();
        Ok(())
    }

    /// Check if the backend matches the given problem.
    pub fn matches_problem(&self, problem: &ProblemIR) -> Result<bool, RunError> {
        self.backend.matches_problem(problem)
    }

    /// Check if the backend matches an already materialized plan.
    pub fn matches_plan(&self, plan: &ExecutionPlanIR) -> Result<bool, RunError> {
        self.backend.matches_plan(plan)
    }

    /// Check whether an execution stage can continue on the existing backend
    /// context without rebuilding solver-owned state.
    pub fn can_continue_with_plan(&self, plan: &ExecutionPlanIR) -> Result<bool, RunError> {
        self.backend.can_continue_with_plan(plan)
    }

    /// Commit stage-scoped solver state without replacing the persistent
    /// backend. This is intentionally separate from the compatibility probe:
    /// callers must not mutate a runtime while merely deciding whether it can
    /// be reused.
    pub fn apply_stage_plan(&mut self, plan: &ExecutionPlanIR) -> Result<(), RunError> {
        let before = self.backend.frozen_spins_runtime_status();
        self.backend.apply_stage_plan(plan)?;
        let after = self.backend.frozen_spins_runtime_status();
        if frozen_spins_resolved_identity_changed(before.as_ref(), after.as_ref()) {
            let active_constraint_ids = after
                .as_ref()
                .map(|status| status.active_constraint_ids.clone())
                .unwrap_or_default();
            self.frozen_spins_activation_set = self
                .frozen_spins_activation_set
                .prepare_transition(active_constraint_ids)
                .map_err(|error| RunError {
                    message: format!(
                        "preparing Frozen Spins stage transition metadata failed: {error}"
                    ),
                })?;
        }
        self.state_revision = self.state_revision.saturating_add(1);
        self.display_cache.invalidate();
        Ok(())
    }

    pub fn supports_frozen_spins_reactivation_in_place(&self) -> bool {
        self.backend.supports_frozen_spins_reactivation_in_place()
    }

    pub fn apply_frozen_spins_reactivation_plan(
        &mut self,
        plan: &ExecutionPlanIR,
    ) -> Result<(), RunError> {
        self.backend.apply_frozen_spins_reactivation_plan(plan)?;
        let active_constraint_ids = self
            .backend
            .frozen_spins_runtime_status()
            .map(|status| status.active_constraint_ids)
            .unwrap_or_default();
        self.frozen_spins_activation_set = self
            .frozen_spins_activation_set
            .prepare_reactivation(active_constraint_ids)
            .map_err(|error| RunError {
                message: format!(
                    "preparing explicit Frozen Spins reactivation metadata failed: {error}"
                ),
            })?;
        self.state_revision = self.state_revision.saturating_add(1);
        self.display_cache.invalidate();
        Ok(())
    }

    /// Get the current display selection.
    pub fn selected_display(&self) -> &DisplaySelection {
        &self.selected_display
    }

    /// Returns the current state revision counter.
    pub fn state_revision(&self) -> u64 {
        self.state_revision
    }

    /// Returns the current display revision counter.
    pub fn display_revision(&self) -> u64 {
        self.display_revision
    }

    /// Get the backend geometry (FDM grid or FEM mesh).
    pub fn geometry(&self) -> BackendGeometry {
        self.backend.geometry()
    }

    /// Get execution provenance info.
    pub fn execution_provenance(&self) -> crate::types::ExecutionProvenance {
        self.backend.execution_provenance()
    }

    pub fn frozen_spins_runtime_status(
        &self,
    ) -> Option<crate::constraints::FrozenSpinsRuntimeStatus> {
        let mut status = self.backend.frozen_spins_runtime_status()?;
        status.constraint_activation_epochs = self
            .frozen_spins_activation_set
            .constraint_activation_epochs
            .clone();
        status.active_constraint_ids = self
            .frozen_spins_activation_set
            .active_constraint_ids
            .clone();
        status.resolved_constraint_set_revision = self
            .frozen_spins_activation_set
            .resolved_constraint_set_revision;
        Some(status)
    }

    pub fn frozen_spins_activation_set(&self) -> &crate::constraints::FrozenSpinsActivationSet {
        &self.frozen_spins_activation_set
    }

    /// Change the display selection. Returns the new display payload
    /// computed from the current backend state.
    pub fn set_display_selection(
        &mut self,
        selection: DisplaySelection,
    ) -> Result<DisplayPayload, RunError> {
        self.selected_display = selection;
        self.display_revision += 1;
        self.display_cache.invalidate();
        let payload = self.refresh_display()?;
        Ok(payload)
    }

    /// Refresh the display from the current backend state without changing selection.
    pub fn refresh_display(&mut self) -> Result<DisplayPayload, RunError> {
        let selection = &self.selected_display;
        let payload = match selection.kind {
            DisplayKind::VectorField | DisplayKind::SpatialScalar => {
                let request = selection.to_preview_request(self.display_revision);
                let field = self.backend.snapshot_preview(&request)?;
                DisplayPayload::from_live_preview_field(selection.kind, field)
            }
            DisplayKind::TensorField => {
                return Err(RunError {
                    message: format!(
                        "tensor field display for '{}' is not supported by the legacy live-preview transport",
                        selection.quantity
                    ),
                });
            }
            DisplayKind::GlobalScalar => {
                let stats = self.backend.snapshot_step_stats()?;
                DisplayPayload::from_global_scalar(&selection.quantity, &stats).ok_or_else(
                    || RunError {
                        message: format!(
                            "global scalar display for '{}' is not available from runtime stats",
                            selection.quantity
                        ),
                    },
                )?
            }
        };
        self.display_cache.put(
            self.state_revision,
            self.selected_display.clone(),
            payload.clone(),
        );
        Ok(payload)
    }

    /// Return the cached display payload if valid, otherwise snapshot and cache.
    ///
    /// This is the preferred method for display reads — it avoids redundant
    /// backend snapshots when neither the state nor the selection has changed.
    pub fn cached_display(&mut self) -> Result<DisplayPayload, RunError> {
        if let Some(cached) = self
            .display_cache
            .get(self.state_revision, &self.selected_display)
        {
            return Ok(cached.clone());
        }
        self.refresh_display()
    }

    /// Snapshot current scalar diagnostics without advancing the simulation.
    pub fn snapshot_step_stats(&mut self) -> Result<StepStats, RunError> {
        self.backend.snapshot_step_stats()
    }

    pub fn set_solver_profile_config(
        &mut self,
        config: &crate::SolverProfileConfig,
    ) -> Result<(), RunError> {
        self.backend.set_solver_profile_config(config)
    }

    /// Snapshot a single preview field for the given request.
    /// This is the backward-compatible path using `LivePreviewRequest`.
    pub fn snapshot_preview(
        &mut self,
        request: &LivePreviewRequest,
    ) -> Result<LivePreviewField, RunError> {
        self.backend.snapshot_preview(request)
    }

    /// Snapshot multiple vector fields at once.
    pub fn snapshot_vector_fields(
        &mut self,
        quantities: &[&str],
        request: &LivePreviewRequest,
    ) -> Result<Vec<LivePreviewField>, RunError> {
        self.backend.snapshot_vector_fields(quantities, request)
    }

    /// Execute a simulation segment, writing artifacts to `output_dir`.
    ///
    /// This is the unified replacement for the separate
    /// `run_problem_with_interactive_fdm_runtime_live_preview` and
    /// `run_problem_with_interactive_fem_runtime_live_preview` functions.
    ///
    /// Handles: planning, artifact pipeline, execution, artifact writing,
    /// and the final finished StepUpdate.
    pub fn execute_streaming(
        &mut self,
        problem: &ProblemIR,
        until_seconds: f64,
        output_dir: &Path,
        field_every_n: u64,
        display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
        interrupt_requested: Option<&AtomicBool>,
        mut on_step: impl FnMut(StepUpdate) -> StepAction + Send,
    ) -> Result<RunResult, RunError> {
        let plan = fullmag_plan::plan(problem)?;
        self.execute_planned_streaming(
            problem,
            &plan,
            until_seconds,
            output_dir,
            field_every_n,
            display_selection,
            interrupt_requested,
            &mut on_step,
        )
    }

    /// Execute a simulation segment from an already materialized plan.
    pub fn execute_planned_streaming(
        &mut self,
        problem: &ProblemIR,
        plan: &ExecutionPlanIR,
        until_seconds: f64,
        output_dir: &Path,
        field_every_n: u64,
        display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
        interrupt_requested: Option<&AtomicBool>,
        mut on_step: impl FnMut(StepUpdate) -> StepAction + Send,
    ) -> Result<RunResult, RunError> {
        crate::require_resolved_runtime_sampling(problem, plan)?;
        if matches!(problem.study, StudyIR::Hysteresis { .. }) {
            let stage_asset =
                crate::types::StageFemMeshAsset::build_from_backend_plan(&plan.backend_plan);
            let result = crate::hysteresis::run_planned_hysteresis_with_live_preview(
                problem,
                plan,
                stage_asset.as_ref().map(|asset| &asset.identity),
                until_seconds,
                output_dir,
                field_every_n,
                display_selection,
                interrupt_requested,
                true,
                None,
                &mut on_step,
            )?;
            self.upload_magnetization(&result.final_magnetization)?;
            return Ok(result);
        }

        let mut artifact_pipeline = ArtifactPipeline::start_for_problem_and_plan(
            problem,
            plan,
            output_dir.to_path_buf(),
            artifacts::build_field_context(problem, plan),
            crate::artifact_pipeline::DEFAULT_ARTIFACT_PIPELINE_CAPACITY,
        )?;
        let artifact_writer = Some(artifact_pipeline.sender());
        let runtime_outputs = crate::runtime_outputs_with_table_autosave(problem, plan);
        let mut runtime_plan = plan.clone();
        runtime_plan.output_plan.outputs = runtime_outputs;

        let executed_result = self.backend.execute_streaming(
            problem,
            &runtime_plan,
            until_seconds,
            field_every_n,
            display_selection,
            interrupt_requested,
            artifact_writer,
            &mut on_step,
        );
        let pipeline_summary = artifact_pipeline.finish();

        let mut executed = match executed_result {
            Ok(executed) => executed,
            Err(error) => {
                if let Err(writer_error) = pipeline_summary {
                    return Err(RunError {
                        message: format!(
                            "{}\nartifact pipeline shutdown also failed: {}",
                            error.message, writer_error.message
                        ),
                    });
                }
                return Err(error);
            }
        };
        let pipeline_summary = pipeline_summary?;
        crate::physics_graph_execution::attach_executed_module_ids(problem, &mut executed)?;

        if let Err(error) = artifacts::write_artifacts(
            output_dir,
            problem,
            plan,
            &executed,
            Some(&pipeline_summary),
        ) {
            return Err(RunError {
                message: format!("Failed to write artifacts: {}", error),
            });
        }

        // The backend is still alive here. Build and publish one atomic
        // terminal update after every required finalization step succeeded.
        let display_revision = display_selection().revision;
        publish_atomic_terminal_update(
            self.backend.as_mut(),
            plan,
            display_revision,
            &executed,
            &mut on_step,
        )?;

        self.state_revision += 1;
        self.display_cache.invalidate();
        Ok(executed.result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::artifact_pipeline::ArtifactPipelineSender;
    use crate::types::{ExecutionProvenance, RunStatus};

    #[test]
    fn native_runtime_rebuild_carries_epochs_through_explicit_reactivation_and_stage_gap() {
        let active = ["pin".to_string()].into_iter().collect();
        let initial = prepare_runtime_frozen_spins_activation_set(None, active, false)
            .expect("initial activation");
        assert_eq!(initial.epoch("pin"), Some(1));
        assert_eq!(initial.resolved_constraint_set_revision, 1);

        let active = ["pin".to_string()].into_iter().collect();
        let reactivated = prepare_runtime_frozen_spins_activation_set(Some(initial), active, true)
            .expect("explicit rebuild reactivation");
        assert_eq!(reactivated.epoch("pin"), Some(2));
        assert_eq!(reactivated.resolved_constraint_set_revision, 2);

        let inactive = prepare_runtime_frozen_spins_activation_set(
            Some(reactivated),
            Default::default(),
            false,
        )
        .expect("inactive stage rebuild");
        assert_eq!(inactive.epoch("pin"), Some(2));
        assert!(inactive.active_constraint_ids.is_empty());
        assert_eq!(inactive.resolved_constraint_set_revision, 3);

        let active = ["pin".to_string()].into_iter().collect();
        let reentered = prepare_runtime_frozen_spins_activation_set(Some(inactive), active, false)
            .expect("stage re-entry rebuild");
        assert_eq!(reentered.epoch("pin"), Some(3));
        assert_eq!(reentered.resolved_constraint_set_revision, 4);
    }

    struct SnapshotFailureBackend {
        snapshot_attempts: usize,
    }

    impl InteractiveBackend for SnapshotFailureBackend {
        fn upload_magnetization(&mut self, _magnetization: &[[f64; 3]]) -> Result<(), RunError> {
            Ok(())
        }

        fn snapshot_preview(
            &mut self,
            _request: &LivePreviewRequest,
        ) -> Result<LivePreviewField, RunError> {
            unreachable!("terminal finalization snapshots the field batch")
        }

        fn snapshot_vector_fields(
            &mut self,
            _quantities: &[&str],
            _request: &LivePreviewRequest,
        ) -> Result<Vec<LivePreviewField>, RunError> {
            self.snapshot_attempts += 1;
            Err(RunError {
                message: "injected snapshot failure".to_string(),
            })
        }

        fn snapshot_step_stats(&mut self) -> Result<StepStats, RunError> {
            Ok(StepStats::default())
        }

        fn execution_provenance(&self) -> ExecutionProvenance {
            ExecutionProvenance::default()
        }

        fn matches_problem(&self, _problem: &ProblemIR) -> Result<bool, RunError> {
            Ok(true)
        }

        fn matches_plan(&self, _plan: &ExecutionPlanIR) -> Result<bool, RunError> {
            Ok(true)
        }

        fn can_continue_with_plan(&self, _plan: &ExecutionPlanIR) -> Result<bool, RunError> {
            Ok(true)
        }

        fn geometry(&self) -> BackendGeometry {
            BackendGeometry::Fdm { grid: [1, 1, 1] }
        }

        fn execute_streaming(
            &mut self,
            _problem: &ProblemIR,
            _plan: &ExecutionPlanIR,
            _until_seconds: f64,
            _field_every_n: u64,
            _display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
            _interrupt_requested: Option<&AtomicBool>,
            _artifact_writer: Option<ArtifactPipelineSender>,
            _on_step: &mut dyn FnMut(StepUpdate) -> StepAction,
        ) -> Result<ExecutedRun, RunError> {
            unreachable!("terminal finalization test does not execute the backend")
        }
    }

    #[test]
    fn terminal_snapshot_failure_is_fail_closed_before_callback() {
        let plan = fullmag_plan::plan(&ProblemIR::bootstrap_example())
            .expect("bootstrap FDM problem should plan");
        let executed = ExecutedRun {
            result: RunResult {
                status: RunStatus::Completed,
                steps: vec![StepStats::default()],
                final_magnetization: vec![[1.0, 0.0, 0.0]],
                completion: None,
            },
            initial_magnetization: vec![[1.0, 0.0, 0.0]],
            field_snapshots: Vec::new(),
            field_snapshot_count: 0,
            auxiliary_artifacts: Vec::new(),
            provenance: ExecutionProvenance::default(),
        };
        let mut backend = SnapshotFailureBackend {
            snapshot_attempts: 0,
        };
        let mut callback_count = 0;

        let error = publish_atomic_terminal_update(&mut backend, &plan, 9, &executed, &mut |_| {
            callback_count += 1;
            StepAction::Continue
        })
        .expect_err("injected terminal snapshot failure must propagate");

        assert!(error.message.contains("injected snapshot failure"));
        assert_eq!(backend.snapshot_attempts, 1);
        assert_eq!(callback_count, 0, "partial terminal update must not escape");
        assert_eq!(backend.snapshot_step_stats().unwrap().step, 0);
    }
}
