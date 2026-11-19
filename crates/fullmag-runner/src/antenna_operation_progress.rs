//! Bounded operation diagnostics; never physical observations or LLG steps.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AntennaOperationPhase {
    PreparingSource,
    SolvingPotential,
    ReconstructingCurrent,
    EvaluatingField,
    ValidatingResult,
    PublishingResult,
}

impl AntennaOperationPhase {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::PreparingSource => "preparing_source",
            Self::SolvingPotential => "solving_potential",
            Self::ReconstructingCurrent => "reconstructing_current",
            Self::EvaluatingField => "evaluating_field",
            Self::ValidatingResult => "validating_result",
            Self::PublishingResult => "publishing_result",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AntennaOperationProgress {
    pub phase: AntennaOperationPhase,
    pub completed_targets: u64,
    pub total_targets: u64,
    pub source_cells: u64,
    pub elapsed_seconds: f64,
}

impl AntennaOperationProgress {
    pub fn is_valid(&self) -> bool {
        self.total_targets > 0 && self.source_cells > 0
            && self.completed_targets <= self.total_targets
            && self.elapsed_seconds.is_finite() && self.elapsed_seconds >= 0.0
    }
}

/// Observers copy a snapshot to a bounded latest-value channel; they must not
/// block, serialize fields, access the session store, or control the solver.
pub type AntennaOperationProgressObserver<'a> =
    dyn Fn(AntennaOperationProgress) + Send + Sync + 'a;

pub(crate) fn notify(
    observer: Option<&AntennaOperationProgressObserver<'_>>,
    progress: AntennaOperationProgress,
) {
    if let Some(observer) = observer.filter(|_| progress.is_valid()) {
        // Diagnostic clients must never unwind into a numerical operator.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| observer(progress)));
    }
}
