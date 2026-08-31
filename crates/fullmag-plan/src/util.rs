use fullmag_ir::{DeclaredUniverseIR, DomainFrameIR, ProblemIR, StudyIR};
use serde_json::Value;

pub(crate) fn active_stage_id(problem: &ProblemIR) -> Option<&str> {
    problem
        .problem_meta
        .runtime_metadata
        .get("active_stage_id")
        .and_then(Value::as_str)
}

pub(crate) fn frozen_spins_source_state_revision(
    problem: &ProblemIR,
) -> Result<Option<u64>, String> {
    let Some(value) = problem
        .problem_meta
        .runtime_metadata
        .get(fullmag_ir::FROZEN_SPINS_SOURCE_STATE_REVISION_METADATA_KEY)
    else {
        return Ok(None);
    };
    value
        .as_u64()
        .filter(|revision| *revision > 0)
        .map(Some)
        .ok_or_else(|| {
            format!(
                "runtime_metadata.{} must be a positive integer",
                fullmag_ir::FROZEN_SPINS_SOURCE_STATE_REVISION_METADATA_KEY
            )
        })
}

pub(crate) fn time_stage_context(problem: &ProblemIR) -> fullmag_ir::TimeStageContextIR {
    fullmag_ir::TimeStageContextIR {
        active_stage_id: active_stage_id(problem).map(str::to_owned),
        start_time_s: problem
            .problem_meta
            .runtime_metadata
            .get("stage_start_time_s")
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
    }
}

pub(crate) fn field_drive_is_active(
    drive: &fullmag_ir::RegionalFieldDriveIR,
    problem: &ProblemIR,
) -> bool {
    if !drive.enabled {
        return false;
    }
    match &drive.activation {
        fullmag_ir::DriveActivationIR::AllTimeEvolution {} => {
            matches!(problem.study, StudyIR::TimeEvolution { .. })
        }
        fullmag_ir::DriveActivationIR::StageIds { stage_ids } => active_stage_id(problem)
            .is_some_and(|active| stage_ids.iter().any(|stage_id| stage_id == active)),
    }
}

pub(crate) const MU0: f64 = 4.0 * std::f64::consts::PI * 1e-7;
pub(crate) const GRID_TOLERANCE: f64 = 1e-6;

/// Returns `true` when the user requested a CUDA device via `runtime_metadata`.
pub(crate) fn runtime_requests_cuda(problem: &ProblemIR) -> bool {
    runtime_device_request(problem).is_some_and(|d| d == "cuda" || d == "gpu")
}

pub(crate) fn runtime_device_request(problem: &ProblemIR) -> Option<&str> {
    problem
        .problem_meta
        .runtime_metadata
        .get("runtime_device_override")
        .or_else(|| {
            problem
                .problem_meta
                .runtime_metadata
                .get("runtime_selection")
        })
        .and_then(|v| v.get("device"))
        .and_then(|v| v.as_str())
}

#[cfg(test)]
mod tests {
    use super::runtime_requests_cuda;
    use fullmag_ir::ProblemIR;

    #[test]
    fn managed_gpu_override_is_used_without_rewriting_authored_selection() {
        let mut problem = ProblemIR::bootstrap_example();
        problem.problem_meta.runtime_metadata.insert(
            "runtime_selection".to_string(),
            serde_json::json!({"device": "auto"}),
        );
        assert!(!runtime_requests_cuda(&problem));

        problem.problem_meta.runtime_metadata.insert(
            "runtime_device_override".to_string(),
            serde_json::json!({"device": "gpu", "source": "managed_launcher"}),
        );
        assert!(runtime_requests_cuda(&problem));
        assert_eq!(
            problem.problem_meta.runtime_metadata["runtime_selection"]["device"],
            "auto"
        );
    }
}

pub(crate) fn mesh_workflow_metadata(
    problem: &ProblemIR,
) -> Option<&serde_json::Map<String, Value>> {
    problem
        .problem_meta
        .runtime_metadata
        .get("mesh_workflow")
        .and_then(|value| value.as_object())
}

pub(crate) fn shared_domain_mesh_requested(
    problem: &ProblemIR,
    requested_demag_realization: fullmag_ir::RequestedFemDemagIR,
) -> bool {
    let demag_requested = problem
        .energy_terms
        .iter()
        .any(|term| matches!(term, fullmag_ir::EnergyTermIR::Demag { .. }));

    if matches!(
        requested_demag_realization,
        fullmag_ir::RequestedFemDemagIR::Auto
            if demag_requested
    ) {
        return true;
    }

    // Phase-1A: use the `requires_airbox()` method for the canonical check.
    if !matches!(
        requested_demag_realization,
        fullmag_ir::RequestedFemDemagIR::Auto
    ) && requested_demag_realization.requires_airbox()
    {
        return true;
    }

    let Some(mesh_workflow) = mesh_workflow_metadata(problem) else {
        return false;
    };
    if mesh_workflow
        .get("build_target")
        .and_then(|value| value.as_str())
        .is_some_and(|value| value == "domain")
    {
        return true;
    }
    mesh_workflow
        .get("domain_mesh_mode")
        .and_then(|value| value.as_str())
        .is_some_and(|value| {
            matches!(
                value,
                "generated_shared_domain_mesh" | "explicit_shared_domain_mesh"
            )
        })
}

#[derive(Debug, Clone)]
pub(crate) struct StudyUniverseMetadata {
    pub mode: String,
    pub size: Option<[f64; 3]>,
    pub center: [f64; 3],
    pub padding: [f64; 3],
    pub airbox_hmax: Option<f64>,
}

pub(crate) fn study_universe_metadata(problem: &ProblemIR) -> Option<StudyUniverseMetadata> {
    if let Some(domain_frame) = problem_domain_frame(problem) {
        if let Some(declared_universe) = domain_frame.declared_universe {
            return Some(StudyUniverseMetadata::from(&declared_universe));
        }
    }

    let raw = problem
        .problem_meta
        .runtime_metadata
        .get("study_universe")?;
    let declared_universe = DeclaredUniverseIR::from_study_universe_value(raw)?;
    Some(StudyUniverseMetadata::from(&declared_universe))
}

pub(crate) fn problem_domain_frame(problem: &ProblemIR) -> Option<DomainFrameIR> {
    if let Some(raw) = problem.problem_meta.runtime_metadata.get("domain_frame") {
        if let Ok(frame) = serde_json::from_value::<DomainFrameIR>(raw.clone()) {
            return frame.finalized();
        }
    }

    problem
        .problem_meta
        .runtime_metadata
        .get("study_universe")
        .and_then(DeclaredUniverseIR::from_study_universe_value)
        .map(|declared_universe| DomainFrameIR {
            declared_universe: Some(declared_universe),
            ..DomainFrameIR::default()
        })
        .and_then(DomainFrameIR::finalized)
}

impl From<&DeclaredUniverseIR> for StudyUniverseMetadata {
    fn from(value: &DeclaredUniverseIR) -> Self {
        Self {
            mode: value.mode.clone(),
            size: value.size,
            center: value.center.unwrap_or([0.0, 0.0, 0.0]),
            padding: value.padding.unwrap_or([0.0, 0.0, 0.0]),
            airbox_hmax: value.airbox_hmax,
        }
    }
}

fn splitmix64(mut state: u64) -> u64 {
    state = state.wrapping_add(0x9e3779b97f4a7c15);
    let mut result = state;
    result = (result ^ (result >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    result = (result ^ (result >> 27)).wrapping_mul(0x94d049bb133111eb);
    result ^ (result >> 31)
}

fn unit_from_u64(value: u64) -> f64 {
    ((value >> 11) as f64) * (1.0 / 9007199254740992.0)
}
/// Generate deterministic random unit vectors from a seed.
pub fn generate_random_unit_vectors(seed: u64, count: usize) -> Vec<[f64; 3]> {
    let mut vectors = Vec::with_capacity(count);
    for index in 0..count {
        let state = splitmix64(seed.wrapping_add(index as u64));
        let phi_hash = splitmix64(state);
        let cos_hash = splitmix64(phi_hash);
        let phi = unit_from_u64(phi_hash) * std::f64::consts::TAU;
        let cos_theta = unit_from_u64(cos_hash) * 2.0 - 1.0;
        let sin_theta = (1.0 - cos_theta * cos_theta).max(0.0).sqrt();
        vectors.push([sin_theta * phi.cos(), sin_theta * phi.sin(), cos_theta]);
    }
    vectors
}
