use std::path::Path;

use crate::artifact_pipeline::ArtifactPipeline;
use crate::artifacts;
use crate::types::{
    LivePreviewField, LivePreviewRequest, RunError, RunResult, StepAction, StepUpdate,
};
use fullmag_ir::ProblemIR;

use super::backend::{BackendGeometry, InteractiveBackend};
use super::display::{DisplayKind, DisplayPayload, DisplaySelection};

/// Unified interactive runtime facade.
///
/// Owns a backend (FDM or FEM) and tracks display state + revision counters.
/// This is the single type that the CLI should hold instead of a manual
/// `enum { Fdm(...), Fem(...) }` with delegation boilerplate.
pub struct InteractiveRuntime {
    backend: Box<dyn InteractiveBackend>,
    state_revision: u64,
    display_revision: u64,
    selected_display: DisplaySelection,
}

impl InteractiveRuntime {
    /// Create a new runtime wrapping the given backend.
    pub(crate) fn new(backend: Box<dyn InteractiveBackend>) -> Self {
        Self {
            backend,
            state_revision: 0,
            display_revision: 0,
            selected_display: DisplaySelection::default(),
        }
    }

    /// Upload new magnetization into the backend.
    /// Increments `state_revision`.
    pub fn upload_magnetization(&mut self, magnetization: &[[f64; 3]]) -> Result<(), RunError> {
        self.backend.upload_magnetization(magnetization)?;
        self.state_revision += 1;
        Ok(())
    }

    /// Check if the backend matches the given problem.
    pub fn matches_problem(&self, problem: &ProblemIR) -> Result<bool, RunError> {
        self.backend.matches_problem(problem)
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

    /// Change the display selection. Returns the new display payload
    /// computed from the current backend state.
    pub fn set_display_selection(
        &mut self,
        selection: DisplaySelection,
    ) -> Result<DisplayPayload, RunError> {
        self.selected_display = selection;
        self.display_revision += 1;
        self.refresh_display()
    }

    /// Refresh the display from the current backend state without changing selection.
    pub fn refresh_display(&mut self) -> Result<DisplayPayload, RunError> {
        let selection = &self.selected_display;
        match selection.kind {
            DisplayKind::VectorField | DisplayKind::SpatialScalar => {
                let request = selection.to_preview_request(self.display_revision);
                let field = self.backend.snapshot_preview(&request)?;
                Ok(DisplayPayload::from_vector_field(field))
            }
            DisplayKind::GlobalScalar => {
                // For global scalars, we need step stats. Compute a zero-step snapshot
                // by reading the current state observables via a preview of "m" to get stats.
                // This is a lightweight path — the backend computes scalar metrics internally.
                Err(RunError {
                    message: format!(
                        "global scalar display for '{}' is not yet implemented via runtime query; \
                         use step stats from the last executed segment instead",
                        selection.quantity
                    ),
                })
            }
        }
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
        preview_request: &(dyn Fn() -> LivePreviewRequest + Send + Sync),
        mut on_step: impl FnMut(StepUpdate) -> StepAction + Send,
    ) -> Result<RunResult, RunError> {
        let plan = fullmag_plan::plan(problem)?;

        let mut artifact_pipeline = ArtifactPipeline::start(
            output_dir.to_path_buf(),
            artifacts::build_field_context(problem, &plan),
            crate::artifact_pipeline::DEFAULT_ARTIFACT_PIPELINE_CAPACITY,
        )?;
        let artifact_writer = Some(artifact_pipeline.sender());

        let executed_result = self.backend.execute_streaming(
            problem,
            until_seconds,
            field_every_n,
            preview_request,
            artifact_writer,
            &mut on_step,
        );
        let pipeline_summary = artifact_pipeline.finish();

        let executed = match executed_result {
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

        if let Err(error) = artifacts::write_artifacts(
            output_dir,
            problem,
            &plan,
            &executed,
            Some(&pipeline_summary),
        ) {
            return Err(RunError {
                message: format!("Failed to write artifacts: {}", error),
            });
        }

        // Emit the final "finished" StepUpdate.
        let final_stats = executed
            .result
            .steps
            .last()
            .cloned()
            .unwrap_or_default();
        let final_m: Vec<f64> = executed
            .result
            .final_magnetization
            .iter()
            .flat_map(|v| v.iter().copied())
            .collect();

        let (grid, fem_mesh) = match self.backend.geometry() {
            BackendGeometry::Fdm { grid } => (grid, None),
            BackendGeometry::Fem { mesh } => ([0u32, 0, 0], Some(mesh)),
        };

        on_step(StepUpdate {
            stats: final_stats,
            grid,
            fem_mesh,
            magnetization: Some(final_m),
            preview_field: None,
            scalar_row_due: true,
            finished: true,
        });

        self.state_revision += 1;
        Ok(executed.result)
    }
}
