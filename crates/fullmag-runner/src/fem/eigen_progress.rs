use crate::types::RunError;
use crate::types::StepAction;

#[derive(Debug, Clone)]
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
    let phase = match object
        .get("solver_phase")
        .and_then(serde_json::Value::as_str)
    {
        Some("cancelling_shift_invert") => "cancelling_native_shift_invert",
        Some("solving_shift_invert") => "solving_native_shift_invert",
        Some("solving_contour_interval") => "solving_native_contour_interval",
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
    let residual = object
        .get("current_residual_relative_l2")
        .or_else(|| object.get("residual_relative"))
        .and_then(serde_json::Value::as_f64)
        .filter(|value| value.is_finite());
    let warning = (phase == "cancelling_native_shift_invert").then_some("cancel_requested");
    Some(FemEigenProgress {
        phase,
        phase_index: 3,
        phase_count: 5,
        percent: 35.0,
        solver_kind,
        active_nodes,
        effective_dof,
        requested_modes,
        candidate_modes: as_usize("candidate_mode_count"),
        computed_modes: as_usize("accepted_mode_count"),
        iteration: Some(as_u32("outer_iteration")),
        max_iterations: object
            .get("max_outer_iterations")
            .and_then(serde_json::Value::as_u64)
            .and_then(|value| u32::try_from(value).ok()),
        residual,
        warning,
    })
}
