use crate::types::RunError;
use crate::types::{LiveParallelExecutionTelemetry, StepAction};

#[derive(Debug, Clone, Default)]
pub(crate) struct FemEigenLinearProgress {
    pub linear_iteration: u64,
    pub linear_residual_norm: Option<f64>,
    pub linear_solver_role: &'static str,
    pub linear_ksp_type: Option<&'static str>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct FemEigenProgress {
    pub phase: &'static str,
    pub phase_index: u32,
    pub phase_count: u32,
    pub percent: f64,
    pub solver_kind: &'static str,
    pub active_nodes: usize,
    pub effective_dof: usize,
    pub requested_modes: usize,
    pub candidate_modes: usize,
    pub computed_modes: usize,
    pub iteration: Option<u32>,
    pub max_iterations: Option<u32>,
    pub residual: Option<f64>,
    pub linear_solve: Option<FemEigenLinearProgress>,
    pub warning: Option<&'static str>,
    /// Native frequency-window telemetry, when the solver is traversing
    /// adaptive base/refinement subwindows.  These fields intentionally stay
    /// optional so dense/LOBPCG paths keep their existing event contract.
    pub window_phase: Option<&'static str>,
    pub current_subwindow: Option<u32>,
    pub total_subwindows: Option<u32>,
    pub subwindow_elapsed_seconds: Option<f64>,
    pub window_elapsed_seconds: Option<f64>,
    /// Latest real adaptive FEM CPU admission sample, when available.
    pub parallel_execution: Option<LiveParallelExecutionTelemetry>,
}

pub(crate) type FemEigenProgressCallback<'a> =
    dyn FnMut(FemEigenProgress) -> StepAction + Send + 'a;

pub(super) fn emit_fem_eigen_progress(
    progress: &mut Option<&mut FemEigenProgressCallback<'_>>,
    event: FemEigenProgress,
) -> Result<(), RunError> {
    if let Some(callback) = progress.as_deref_mut() {
        match callback(event) {
            StepAction::Continue => {}
            StepAction::Stop | StepAction::Pause => {
                return Err(RunError {
                    message: "FEM eigen solve was interrupted by runtime control".to_string(),
                });
            }
        }
    }
    Ok(())
}

pub(super) fn native_modal_progress_event(
    raw: &str,
    solver_kind: &'static str,
    active_nodes: usize,
    effective_dof: usize,
    requested_modes: usize,
) -> Option<FemEigenProgress> {
    let value = serde_json::from_str::<serde_json::Value>(raw).ok()?;
    let object = value.as_object()?;
    let solver_phase = object
        .get("solver_phase")
        .and_then(serde_json::Value::as_str);
    let raw_window_phase = object
        .get("window_phase")
        .and_then(serde_json::Value::as_str);
    let phase = match (solver_phase, raw_window_phase) {
        (Some("cancelling_shift_invert"), _) => "cancelling_native_shift_invert",
        (_, Some("base")) => "solving_native_frequency_window_base",
        (_, Some("refinement")) => "solving_native_frequency_window_refinement",
        (Some("solving_shift_invert"), _) => "solving_native_shift_invert",
        (Some("solving_contour_interval"), _) => "solving_native_contour_interval",
        _ => "solving_native_shift_invert",
    };
    let as_usize = |key: &str| {
        object
            .get(key)
            .and_then(serde_json::Value::as_u64)
            .and_then(|value| usize::try_from(value).ok())
            .unwrap_or(0)
    };
    let as_u32 = |key: &str| {
        object
            .get(key)
            .and_then(serde_json::Value::as_u64)
            .and_then(|value| u32::try_from(value).ok())
    };
    let as_f64 = |key: &str| {
        object
            .get(key)
            .and_then(serde_json::Value::as_f64)
            .filter(|value| value.is_finite())
    };
    let residual_source_ksp_norm = object
        .get("residual_source")
        .and_then(serde_json::Value::as_str)
        == Some("ksp_norm");
    let residual = if residual_source_ksp_norm {
        None
    } else {
        object
            .get("current_residual_relative_l2")
            .or_else(|| object.get("residual_relative"))
            .and_then(serde_json::Value::as_f64)
            .filter(|value| value.is_finite())
    };
    let linear_solve = if residual_source_ksp_norm {
        let linear_iteration = object
            .get("linear_iteration")
            .and_then(serde_json::Value::as_u64);
        let linear_solver_role = object
            .get("linear_solver_role")
            .and_then(serde_json::Value::as_str)
            .and_then(|role| match role {
                "poisson" => Some("poisson"),
                "shift_invert" => Some("shift_invert"),
                _ => None,
            });
        match (linear_iteration, linear_solver_role) {
            (Some(linear_iteration), Some(linear_solver_role)) => {
                let linear_residual_norm = as_f64("linear_residual_norm")
                    .filter(|value| *value >= 0.0);
                let linear_ksp_type = object
                    .get("linear_ksp_type")
                    .and_then(serde_json::Value::as_str)
                    .and_then(|ksp_type| match ksp_type {
                        "gmres" => Some("gmres"),
                        "fgmres" => Some("fgmres"),
                        "preonly" => Some("preonly"),
                        _ => None,
                    });
                Some(FemEigenLinearProgress {
                    linear_iteration,
                    linear_residual_norm,
                    linear_solver_role,
                    linear_ksp_type,
                })
            }
            _ => None,
        }
    } else {
        None
    };
    let warning = (phase == "cancelling_native_shift_invert").then_some("cancel_requested");
    let subwindow_position = as_u32("current_subwindow")
        .zip(as_u32("total_subwindows"))
        .filter(|(current, total)| *current > 0 && *total > 0);
    let percent = subwindow_position
        .map(|(current, total)| {
            35.0 + 45.0 * f64::from(current.min(total)) / f64::from(total)
        })
        .unwrap_or(35.0);
    Some(FemEigenProgress {
        phase,
        phase_index: 3,
        phase_count: 5,
        percent,
        solver_kind,
        active_nodes,
        effective_dof,
        requested_modes,
        candidate_modes: as_usize("candidate_mode_count"),
        computed_modes: as_usize("accepted_mode_count"),
        iteration: as_u32("outer_iteration"),
        max_iterations: as_u32("max_outer_iterations").filter(|value| *value > 0),
        residual,
        linear_solve,
        warning,
        window_phase: match raw_window_phase {
            Some("base") => Some("base"),
            Some("refinement") => Some("refinement"),
            _ => None,
        },
        current_subwindow: subwindow_position.map(|(current, _)| current),
        total_subwindows: subwindow_position.map(|(_, total)| total),
        subwindow_elapsed_seconds: as_f64("subwindow_elapsed_seconds"),
        window_elapsed_seconds: as_f64("window_elapsed_seconds"),
        parallel_execution: None,
    })
}

#[cfg(test)]
mod tests {
    use super::native_modal_progress_event;

    #[test]
    fn native_frequency_window_progress_preserves_window_telemetry() {
        let event = native_modal_progress_event(
            r#"{
                "solver_phase":"solving_shift_invert",
                "window_phase":"refinement",
                "outer_iteration":23,
                "max_outer_iterations":300,
                "current_subwindow":17,
                "total_subwindows":34,
                "subwindow_elapsed_seconds":4.25,
                "window_elapsed_seconds":71.5,
                "current_residual_relative_l2":2.0e-9,
                "candidate_mode_count":8,
                "accepted_mode_count":4
            }"#,
            "cpu_sparse_lobpcg",
            5156,
            10312,
            8,
        )
        .expect("valid native progress event");

        assert_eq!(event.phase, "solving_native_frequency_window_refinement");
        assert_eq!(event.window_phase, Some("refinement"));
        assert_eq!(event.current_subwindow, Some(17));
        assert_eq!(event.total_subwindows, Some(34));
        assert_eq!(event.subwindow_elapsed_seconds, Some(4.25));
        assert_eq!(event.window_elapsed_seconds, Some(71.5));
        assert_eq!(event.iteration, Some(23));
        assert_eq!(event.max_iterations, Some(300));
        assert_eq!(event.residual, Some(2.0e-9));
        assert!(event.linear_solve.is_none());
    }

    #[test]
    fn tagged_ksp_norm_never_becomes_a_mode_relative_residual() {
        let event = native_modal_progress_event(
            r#"{
                "solver_phase":"solving_shift_invert",
                "window_phase":"base",
                "outer_iteration":17,
                "max_outer_iterations":300,
                "current_subwindow":23,
                "total_subwindows":50,
                "residual_source":"ksp_norm",
                "current_residual_relative_l2":2.0e-3,
                "residual_relative":4.0e-3,
                "linear_iteration":12,
                "linear_residual_norm":4.5e-8,
                "linear_solver_role":"shift_invert",
                "linear_ksp_type":"fgmres"
            }"#,
            "cpu_sparse_lobpcg",
            5156,
            10312,
            8,
        )
        .expect("valid tagged KSP progress event");

        assert_eq!(event.residual, None);
        assert_eq!(event.iteration, Some(17));
        assert_eq!(event.max_iterations, Some(300));
        assert_eq!(event.current_subwindow, Some(23));
        assert_eq!(event.total_subwindows, Some(50));
        let linear = event.linear_solve.as_ref().expect("typed KSP progress");
        assert_eq!(linear.linear_iteration, 12);
        assert_eq!(linear.linear_residual_norm, Some(4.5e-8));
        assert_eq!(linear.linear_solver_role, "shift_invert");
        assert_eq!(linear.linear_ksp_type, Some("fgmres"));
    }

    #[test]
    fn malformed_ksp_fields_are_filtered_without_invented_values() {
        let event = native_modal_progress_event(
            r#"{
                "residual_source":"ksp_norm",
                "outer_iteration":null,
                "current_subwindow":23,
                "total_subwindows":50,
                "current_residual_relative_l2":1.0e-4,
                "linear_iteration":8,
                "linear_residual_norm":-1.0,
                "linear_solver_role":"poisson",
                "linear_ksp_type":"bicgstab"
            }"#,
            "cpu_sparse_lobpcg",
            5156,
            10312,
            8,
        )
        .expect("valid progress envelope with malformed optional KSP fields");

        assert_eq!(event.iteration, None);
        assert_eq!(event.residual, None);
        let linear = event.linear_solve.as_ref().expect("valid role and iteration");
        assert_eq!(linear.linear_iteration, 8);
        assert_eq!(linear.linear_residual_norm, None);
        assert_eq!(linear.linear_ksp_type, None);

        let unknown_role = native_modal_progress_event(
            r#"{
                "residual_source":"ksp_norm",
                "linear_iteration":8,
                "linear_residual_norm":1.0e-8,
                "linear_solver_role":"unrecognized",
                "linear_ksp_type":"gmres"
            }"#,
            "cpu_sparse_lobpcg",
            5156,
            10312,
            8,
        )
        .expect("unknown categories do not invalidate the outer progress envelope");
        assert!(unknown_role.linear_solve.is_none());

        let negative_iteration = native_modal_progress_event(
            r#"{
                "residual_source":"ksp_norm",
                "linear_iteration":-1,
                "linear_solver_role":"poisson"
            }"#,
            "cpu_sparse_lobpcg",
            5156,
            10312,
            8,
        )
        .expect("negative inner iteration does not invalidate the outer progress envelope");
        assert!(negative_iteration.linear_solve.is_none());
    }

    #[test]
    fn native_modal_cancellation_keeps_ksp_progress_and_warning() {
        let event = native_modal_progress_event(
            r#"{
                "solver_phase":"cancelling_shift_invert",
                "residual_source":"ksp_norm",
                "linear_iteration":4,
                "linear_residual_norm":2.0e-6,
                "linear_solver_role":"poisson",
                "linear_ksp_type":"preonly"
            }"#,
            "cpu_sparse_lobpcg",
            5156,
            10312,
            8,
        )
        .expect("valid cancelling progress event");

        assert_eq!(event.phase, "cancelling_native_shift_invert");
        assert_eq!(event.warning, Some("cancel_requested"));
        assert_eq!(event.residual, None);
        assert_eq!(
            event.linear_solve.as_ref().map(|linear| linear.linear_iteration),
            Some(4)
        );
    }
}
