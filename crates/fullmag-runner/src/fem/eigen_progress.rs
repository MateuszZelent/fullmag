use crate::types::RunError;
use crate::types::StepAction;

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
    pub warning: Option<&'static str>,
    /// Native frequency-window telemetry, when the solver is traversing
    /// adaptive base/refinement subwindows.  These fields intentionally stay
    /// optional so dense/LOBPCG paths keep their existing event contract.
    pub window_phase: Option<&'static str>,
    pub current_subwindow: Option<u32>,
    pub total_subwindows: Option<u32>,
    pub subwindow_elapsed_seconds: Option<f64>,
    pub window_elapsed_seconds: Option<f64>,
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
            .unwrap_or(0)
    };
    let as_f64 = |key: &str| {
        object
            .get(key)
            .and_then(serde_json::Value::as_f64)
            .filter(|value| value.is_finite())
    };
    let residual = object
        .get("current_residual_relative_l2")
        .or_else(|| object.get("residual_relative"))
        .and_then(serde_json::Value::as_f64)
        .filter(|value| value.is_finite());
    let warning = (phase == "cancelling_native_shift_invert").then_some("cancel_requested");
    let current_subwindow = as_u32("current_subwindow");
    let total_subwindows = as_u32("total_subwindows");
    let is_window_progress = current_subwindow > 0 && total_subwindows > 0;
    let percent = if is_window_progress {
        35.0 + 45.0 * f64::from(current_subwindow.min(total_subwindows))
            / f64::from(total_subwindows)
    } else {
        35.0
    };
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
        iteration: Some(if is_window_progress {
            current_subwindow
        } else {
            as_u32("outer_iteration")
        }),
        max_iterations: if is_window_progress {
            Some(total_subwindows)
        } else {
            object
                .get("max_outer_iterations")
                .and_then(serde_json::Value::as_u64)
                .and_then(|value| u32::try_from(value).ok())
        },
        residual,
        warning,
        window_phase: match raw_window_phase {
            Some("base") => Some("base"),
            Some("refinement") => Some("refinement"),
            _ => None,
        },
        current_subwindow: is_window_progress.then_some(current_subwindow),
        total_subwindows: is_window_progress.then_some(total_subwindows),
        subwindow_elapsed_seconds: as_f64("subwindow_elapsed_seconds"),
        window_elapsed_seconds: as_f64("window_elapsed_seconds"),
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
        assert_eq!(event.iteration, Some(17));
        assert_eq!(event.max_iterations, Some(34));
        assert_eq!(event.residual, Some(2.0e-9));
    }
}
