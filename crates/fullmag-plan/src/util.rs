use fullmag_ir::{DeclaredUniverseIR, DomainFrameIR, ProblemIR};
use serde_json::Value;

pub(crate) const MU0: f64 = 4.0 * std::f64::consts::PI * 1e-7;
pub(crate) const PLACEMENT_TOLERANCE: f64 = 1e-12;
pub(crate) const GRID_TOLERANCE: f64 = 1e-6;

/// Returns `true` when the user requested a CUDA device via `runtime_metadata`.
pub(crate) fn runtime_requests_cuda(problem: &ProblemIR) -> bool {
    problem
        .problem_meta
        .runtime_metadata
        .get("runtime_selection")
        .and_then(|v| v.get("device"))
        .and_then(|v| v.as_str())
        .is_some_and(|d| d == "cuda" || d == "gpu")
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
    if requested_demag_realization.requires_airbox() {
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

/// Generate deterministic random unit vectors from a seed.
pub fn generate_random_unit_vectors(seed: u64, count: usize) -> Vec<[f64; 3]> {
    // Simple xorshift64-based PRNG for deterministic random unit vectors.
    let mut state = seed;
    let mut vectors = Vec::with_capacity(count);

    for _ in 0..count {
        // Generate 3 random f64 in [-1, 1]
        let mut components = [0.0f64; 3];
        loop {
            for c in &mut components {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                *c = (state as f64 / u64::MAX as f64) * 2.0 - 1.0;
            }
            let norm = (components[0] * components[0]
                + components[1] * components[1]
                + components[2] * components[2])
                .sqrt();
            if norm > 1e-10 {
                components[0] /= norm;
                components[1] /= norm;
                components[2] /= norm;
                break;
            }
        }
        vectors.push(components);
    }
    vectors
}
