use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::fmt;
use std::time::Instant;

#[cfg(test)]
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(test)]
use std::sync::Arc;

pub const MAX_PREPARATION_LOG_ENTRIES: usize = 200;

#[derive(Debug, Clone, Copy)]
enum ActiveStageMonotonicStart {
    System(Instant),
    #[cfg(test)]
    Manual(u64),
}

#[derive(Debug, Clone)]
enum PreparationMonotonicClock {
    System,
    #[cfg(test)]
    Manual(ManualMonotonicClock),
}

impl Default for PreparationMonotonicClock {
    fn default() -> Self {
        Self::System
    }
}

impl PreparationMonotonicClock {
    fn start(&self) -> ActiveStageMonotonicStart {
        match self {
            Self::System => ActiveStageMonotonicStart::System(Instant::now()),
            #[cfg(test)]
            Self::Manual(clock) => ActiveStageMonotonicStart::Manual(clock.now_ms()),
        }
    }

    #[cfg(not(test))]
    fn elapsed_ms(&self, start: ActiveStageMonotonicStart) -> u64 {
        let ActiveStageMonotonicStart::System(started_at) = start;
        started_at.elapsed().as_millis().min(u64::MAX as u128) as u64
    }

    #[cfg(test)]
    fn elapsed_ms(&self, start: ActiveStageMonotonicStart) -> u64 {
        match (self, start) {
            (Self::System, ActiveStageMonotonicStart::System(started_at)) => {
                started_at.elapsed().as_millis().min(u64::MAX as u128) as u64
            }
            #[cfg(test)]
            (Self::Manual(clock), ActiveStageMonotonicStart::Manual(started_at_ms)) => {
                clock.now_ms().saturating_sub(started_at_ms)
            }
            _ => unreachable!("monotonic clock and start source must match"),
        }
    }
}

#[cfg(test)]
#[derive(Debug, Clone)]
struct ManualMonotonicClock {
    now_ms: Arc<AtomicU64>,
}

#[cfg(test)]
impl ManualMonotonicClock {
    fn new(now_ms: u64) -> Self {
        Self {
            now_ms: Arc::new(AtomicU64::new(now_ms)),
        }
    }

    fn now_ms(&self) -> u64 {
        self.now_ms.load(Ordering::Relaxed)
    }

    fn advance_ms(&self, elapsed_ms: u64) {
        self.now_ms.fetch_add(elapsed_ms, Ordering::Relaxed);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreparationStatus {
    Connecting,
    Running,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreparationStageId {
    RuntimeStartup,
    ScriptMaterialization,
    Validation,
    Planning,
    DomainPreparation,
    Meshing,
    MeshPostprocessing,
    SolverInitialization,
    Ready,
}

impl PreparationStageId {
    const ORDERED: [Self; 9] = [
        Self::RuntimeStartup,
        Self::ScriptMaterialization,
        Self::Validation,
        Self::Planning,
        Self::DomainPreparation,
        Self::Meshing,
        Self::MeshPostprocessing,
        Self::SolverInitialization,
        Self::Ready,
    ];

    fn index(self) -> usize {
        match self {
            Self::RuntimeStartup => 0,
            Self::ScriptMaterialization => 1,
            Self::Validation => 2,
            Self::Planning => 3,
            Self::DomainPreparation => 4,
            Self::Meshing => 5,
            Self::MeshPostprocessing => 6,
            Self::SolverInitialization => 7,
            Self::Ready => 8,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::RuntimeStartup => "Runtime startup",
            Self::ScriptMaterialization => "Script materialization",
            Self::Validation => "Validation",
            Self::Planning => "Planning",
            Self::DomainPreparation => "Domain preparation",
            Self::Meshing => "Meshing",
            Self::MeshPostprocessing => "Mesh postprocessing",
            Self::SolverInitialization => "Solver initialization",
            Self::Ready => "Ready",
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::RuntimeStartup => "runtime_startup",
            Self::ScriptMaterialization => "script_materialization",
            Self::Validation => "validation",
            Self::Planning => "planning",
            Self::DomainPreparation => "domain_preparation",
            Self::Meshing => "meshing",
            Self::MeshPostprocessing => "mesh_postprocessing",
            Self::SolverInitialization => "solver_initialization",
            Self::Ready => "ready",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreparationStageStatus {
    Pending,
    Active,
    Completed,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreparationLogLevel {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreparationClockAdjustment {
    pub observed_at_unix_ms: u64,
    pub stage_started_at_unix_ms: u64,
    pub backward_delta_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreparationStage {
    pub id: PreparationStageId,
    pub label: String,
    pub detail: String,
    pub status: PreparationStageStatus,
    pub started_at_unix_ms: Option<u64>,
    pub completed_at_unix_ms: Option<u64>,
    pub duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clock_adjustment: Option<PreparationClockAdjustment>,
    pub progress_percent: Option<u8>,
    pub progress_label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreparationLogEntry {
    pub timestamp_unix_ms: u64,
    pub level: PreparationLogLevel,
    pub stage_id: PreparationStageId,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreparationFailure {
    pub error_code: String,
    pub summary: String,
    pub detail: Option<String>,
    pub stage_id: PreparationStageId,
    pub diagnostics_correlation_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreparationTransitionError {
    StageRegression {
        requested: PreparationStageId,
        current: PreparationStageId,
    },
    InvalidTerminalTransition {
        stage_id: PreparationStageId,
        status: PreparationStageStatus,
    },
    ProgressPercentOutOfRange {
        stage_id: PreparationStageId,
        progress_percent: u8,
    },
    StageIsNotActive {
        stage_id: PreparationStageId,
        active_stage_id: Option<PreparationStageId>,
    },
    PreparationIsTerminal {
        status: PreparationStatus,
    },
}

impl fmt::Display for PreparationTransitionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::StageRegression { requested, current } => {
                write!(
                    formatter,
                    "cannot transition from {current:?} back to {requested:?}"
                )
            }
            Self::InvalidTerminalTransition { stage_id, status } => {
                write!(formatter, "cannot transition {stage_id:?} from {status:?}")
            }
            Self::ProgressPercentOutOfRange {
                stage_id,
                progress_percent,
            } => write!(
                formatter,
                "progress {progress_percent} is outside 0..=100 for {stage_id:?}"
            ),
            Self::StageIsNotActive {
                stage_id,
                active_stage_id,
            } => write!(
                formatter,
                "{stage_id:?} is not active (active stage: {active_stage_id:?})"
            ),
            Self::PreparationIsTerminal { status } => {
                write!(formatter, "preparation is already terminal: {status:?}")
            }
        }
    }
}

impl std::error::Error for PreparationTransitionError {}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimulationPreparationState {
    pub preparation_id: String,
    pub revision: u64,
    pub status: PreparationStatus,
    pub active_stage_id: Option<PreparationStageId>,
    pub started_at_unix_ms: u64,
    pub completed_at_unix_ms: Option<u64>,
    pub stages: Vec<PreparationStage>,
    pub log_tail: VecDeque<PreparationLogEntry>,
    pub failure: Option<PreparationFailure>,
    #[serde(skip)]
    active_stage_started_at: Option<ActiveStageMonotonicStart>,
    #[serde(skip)]
    monotonic_clock: PreparationMonotonicClock,
}

impl SimulationPreparationState {
    pub fn new(preparation_id: impl Into<String>, started_at_unix_ms: u64) -> Self {
        Self::new_with_clock(
            preparation_id,
            started_at_unix_ms,
            PreparationMonotonicClock::System,
        )
    }

    fn new_with_clock(
        preparation_id: impl Into<String>,
        started_at_unix_ms: u64,
        monotonic_clock: PreparationMonotonicClock,
    ) -> Self {
        Self {
            preparation_id: preparation_id.into(),
            revision: 0,
            status: PreparationStatus::Connecting,
            active_stage_id: None,
            started_at_unix_ms,
            completed_at_unix_ms: None,
            stages: PreparationStageId::ORDERED
                .into_iter()
                .map(|id| PreparationStage {
                    id,
                    label: id.label().to_string(),
                    detail: String::new(),
                    status: PreparationStageStatus::Pending,
                    started_at_unix_ms: None,
                    completed_at_unix_ms: None,
                    duration_ms: None,
                    clock_adjustment: None,
                    progress_percent: None,
                    progress_label: None,
                })
                .collect(),
            log_tail: VecDeque::new(),
            failure: None,
            active_stage_started_at: None,
            monotonic_clock,
        }
    }

    #[cfg(test)]
    fn new_with_monotonic_clock(
        preparation_id: impl Into<String>,
        started_at_unix_ms: u64,
        clock: ManualMonotonicClock,
    ) -> Self {
        Self::new_with_clock(
            preparation_id,
            started_at_unix_ms,
            PreparationMonotonicClock::Manual(clock),
        )
    }

    pub fn begin_stage(
        &mut self,
        stage_id: PreparationStageId,
        timestamp_unix_ms: u64,
        detail: impl Into<String>,
    ) -> Result<(), PreparationTransitionError> {
        self.ensure_not_terminal()?;
        if stage_id == PreparationStageId::Ready {
            return Err(PreparationTransitionError::InvalidTerminalTransition {
                stage_id,
                status: self.stage(stage_id).status,
            });
        }
        self.ensure_forward(stage_id)?;

        if let Some(active_stage_id) = self.active_stage_id {
            if active_stage_id != stage_id {
                return Err(PreparationTransitionError::StageIsNotActive {
                    stage_id,
                    active_stage_id: Some(active_stage_id),
                });
            }
        }

        let detail = detail.into();
        let before = self.semantic_snapshot();
        self.skip_pending_before(stage_id);
        let stage = self.stage_mut(stage_id);
        match stage.status {
            PreparationStageStatus::Pending => {
                stage.status = PreparationStageStatus::Active;
                stage.started_at_unix_ms = Some(timestamp_unix_ms);
                stage.detail = detail;
                self.status = PreparationStatus::Running;
                self.active_stage_id = Some(stage_id);
                self.active_stage_started_at = Some(self.monotonic_clock.start());
            }
            PreparationStageStatus::Active => {
                stage.detail = detail;
            }
            status => {
                return Err(PreparationTransitionError::InvalidTerminalTransition {
                    stage_id,
                    status,
                });
            }
        }
        self.bump_revision_if_semantic_change(before);
        Ok(())
    }

    pub fn update_progress(
        &mut self,
        stage_id: PreparationStageId,
        progress_percent: u8,
        progress_label: impl Into<String>,
        timestamp_unix_ms: u64,
    ) -> Result<(), PreparationTransitionError> {
        if progress_percent > 100 {
            return Err(PreparationTransitionError::ProgressPercentOutOfRange {
                stage_id,
                progress_percent,
            });
        }
        self.ensure_active(stage_id)?;
        let before = self.semantic_snapshot();
        let clock_adjustment = self.clock_adjustment(stage_id, timestamp_unix_ms);
        let duration_ms = self.stage_duration_ms();
        let stage = self.stage_mut(stage_id);
        Self::record_clock_adjustment(stage, clock_adjustment);
        stage.progress_percent = Some(progress_percent);
        stage.progress_label = Some(progress_label.into());
        stage.duration_ms = Some(duration_ms);
        self.bump_revision_if_semantic_change(before);
        Ok(())
    }

    pub fn update_indeterminate_activity(
        &mut self,
        stage_id: PreparationStageId,
        progress_label: impl Into<String>,
        timestamp_unix_ms: u64,
    ) -> Result<(), PreparationTransitionError> {
        self.ensure_active(stage_id)?;
        let before = self.semantic_snapshot();
        let clock_adjustment = self.clock_adjustment(stage_id, timestamp_unix_ms);
        let duration_ms = self.stage_duration_ms();
        let stage = self.stage_mut(stage_id);
        Self::record_clock_adjustment(stage, clock_adjustment);
        stage.progress_percent = None;
        stage.progress_label = Some(progress_label.into());
        stage.duration_ms = Some(duration_ms);
        self.bump_revision_if_semantic_change(before);
        Ok(())
    }

    pub fn complete_stage(
        &mut self,
        stage_id: PreparationStageId,
        timestamp_unix_ms: u64,
        detail: impl Into<String>,
    ) -> Result<(), PreparationTransitionError> {
        self.ensure_active(stage_id)?;
        let before = self.semantic_snapshot();
        let clock_adjustment = self.clock_adjustment(stage_id, timestamp_unix_ms);
        let duration_ms = self.stage_duration_ms();
        let stage = self.stage_mut(stage_id);
        Self::record_clock_adjustment(stage, clock_adjustment);
        stage.status = PreparationStageStatus::Completed;
        stage.completed_at_unix_ms = Some(timestamp_unix_ms);
        stage.duration_ms = Some(duration_ms);
        stage.detail = detail.into();
        self.active_stage_id = None;
        self.active_stage_started_at = None;
        self.bump_revision_if_semantic_change(before);
        Ok(())
    }

    pub fn project_completed_stage(
        &mut self,
        stage_id: PreparationStageId,
        detail: impl Into<String>,
    ) -> Result<(), PreparationTransitionError> {
        self.ensure_not_terminal()?;
        if stage_id == PreparationStageId::Ready {
            return Err(PreparationTransitionError::InvalidTerminalTransition {
                stage_id,
                status: self.stage(stage_id).status,
            });
        }
        self.ensure_forward(stage_id)?;
        if let Some(active_stage_id) = self.active_stage_id {
            if active_stage_id != stage_id {
                return Err(PreparationTransitionError::StageIsNotActive {
                    stage_id,
                    active_stage_id: Some(active_stage_id),
                });
            }
        }

        let before = self.semantic_snapshot();
        self.skip_pending_before(stage_id);
        let stage = self.stage_mut(stage_id);
        match stage.status {
            PreparationStageStatus::Pending | PreparationStageStatus::Active => {
                stage.status = PreparationStageStatus::Completed;
                stage.completed_at_unix_ms = None;
                stage.duration_ms = None;
                stage.detail = detail.into();
                stage.progress_percent = None;
                stage.progress_label = None;
                self.status = PreparationStatus::Running;
                if self.active_stage_id == Some(stage_id) {
                    self.active_stage_id = None;
                    self.active_stage_started_at = None;
                }
            }
            status => {
                return Err(PreparationTransitionError::InvalidTerminalTransition {
                    stage_id,
                    status,
                });
            }
        }
        self.bump_revision_if_semantic_change(before);
        Ok(())
    }

    pub fn project_failed_stage(
        &mut self,
        stage_id: PreparationStageId,
        error_code: impl Into<String>,
        summary: impl Into<String>,
    ) -> Result<(), PreparationTransitionError> {
        self.ensure_not_terminal()?;
        if stage_id == PreparationStageId::Ready {
            return Err(PreparationTransitionError::InvalidTerminalTransition {
                stage_id,
                status: self.stage(stage_id).status,
            });
        }
        self.ensure_forward(stage_id)?;
        if let Some(active_stage_id) = self.active_stage_id {
            if active_stage_id != stage_id {
                return Err(PreparationTransitionError::StageIsNotActive {
                    stage_id,
                    active_stage_id: Some(active_stage_id),
                });
            }
        }

        let error_code = error_code.into();
        let summary = summary.into();
        let before = self.semantic_snapshot();
        self.skip_pending_before(stage_id);
        let stage = self.stage_mut(stage_id);
        match stage.status {
            PreparationStageStatus::Pending | PreparationStageStatus::Active => {
                stage.status = PreparationStageStatus::Failed;
                stage.completed_at_unix_ms = None;
                stage.duration_ms = None;
                stage.detail = summary.clone();
                stage.progress_percent = None;
                stage.progress_label = None;
                self.failure = Some(PreparationFailure {
                    error_code,
                    summary,
                    detail: None,
                    stage_id,
                    diagnostics_correlation_id: None,
                });
                self.status = PreparationStatus::Failed;
                self.active_stage_id = None;
                self.active_stage_started_at = None;
                self.completed_at_unix_ms = None;
            }
            status => {
                return Err(PreparationTransitionError::InvalidTerminalTransition {
                    stage_id,
                    status,
                });
            }
        }
        self.bump_revision_if_semantic_change(before);
        Ok(())
    }

    pub fn skip_stage(
        &mut self,
        stage_id: PreparationStageId,
        detail: impl Into<String>,
    ) -> Result<(), PreparationTransitionError> {
        self.ensure_not_terminal()?;
        if stage_id == PreparationStageId::Ready {
            return Err(PreparationTransitionError::InvalidTerminalTransition {
                stage_id,
                status: self.stage(stage_id).status,
            });
        }
        self.ensure_forward(stage_id)?;
        if let Some(active_stage_id) = self.active_stage_id {
            if active_stage_id != stage_id {
                return Err(PreparationTransitionError::StageIsNotActive {
                    stage_id,
                    active_stage_id: Some(active_stage_id),
                });
            }
        }

        let before = self.semantic_snapshot();
        self.skip_pending_before(stage_id);
        let stage = self.stage_mut(stage_id);
        match stage.status {
            PreparationStageStatus::Pending | PreparationStageStatus::Active => {
                stage.status = PreparationStageStatus::Skipped;
                stage.detail = detail.into();
                stage.progress_percent = None;
                stage.progress_label = None;
                if self.active_stage_id == Some(stage_id) {
                    self.active_stage_id = None;
                    self.active_stage_started_at = None;
                }
            }
            PreparationStageStatus::Skipped => {
                stage.detail = detail.into();
            }
            status => {
                return Err(PreparationTransitionError::InvalidTerminalTransition {
                    stage_id,
                    status,
                });
            }
        }
        self.bump_revision_if_semantic_change(before);
        Ok(())
    }

    pub fn fail_stage(
        &mut self,
        stage_id: PreparationStageId,
        timestamp_unix_ms: u64,
        error_code: impl Into<String>,
        summary: impl Into<String>,
    ) -> Result<(), PreparationTransitionError> {
        self.ensure_active(stage_id)?;
        let before = self.semantic_snapshot();
        let clock_adjustment = self.clock_adjustment(stage_id, timestamp_unix_ms);
        let duration_ms = self.stage_duration_ms();
        let stage = self.stage_mut(stage_id);
        Self::record_clock_adjustment(stage, clock_adjustment);
        stage.status = PreparationStageStatus::Failed;
        stage.completed_at_unix_ms = Some(timestamp_unix_ms);
        stage.duration_ms = Some(duration_ms);
        stage.detail = summary.into();
        self.failure = Some(PreparationFailure {
            error_code: error_code.into(),
            summary: stage.detail.clone(),
            detail: None,
            stage_id,
            diagnostics_correlation_id: None,
        });
        self.status = PreparationStatus::Failed;
        self.active_stage_id = None;
        self.active_stage_started_at = None;
        self.completed_at_unix_ms = Some(timestamp_unix_ms);
        self.bump_revision_if_semantic_change(before);
        Ok(())
    }

    pub fn set_failure_detail(&mut self, detail: Option<String>) {
        let before = self.semantic_snapshot();
        if let Some(failure) = self.failure.as_mut() {
            failure.detail = detail;
        }
        self.bump_revision_if_semantic_change(before);
    }

    pub fn mark_ready(
        &mut self,
        timestamp_unix_ms: u64,
        detail: impl Into<String>,
    ) -> Result<(), PreparationTransitionError> {
        if self.status == PreparationStatus::Ready {
            return Ok(());
        }
        self.ensure_not_terminal()?;
        if self.active_stage_id.is_some() {
            return Err(PreparationTransitionError::StageIsNotActive {
                stage_id: PreparationStageId::Ready,
                active_stage_id: self.active_stage_id,
            });
        }

        let before = self.semantic_snapshot();
        self.skip_pending_before(PreparationStageId::Ready);
        let stage = self.stage_mut(PreparationStageId::Ready);
        stage.status = PreparationStageStatus::Completed;
        stage.started_at_unix_ms = Some(timestamp_unix_ms);
        stage.completed_at_unix_ms = Some(timestamp_unix_ms);
        stage.duration_ms = Some(0);
        stage.detail = detail.into();
        self.status = PreparationStatus::Ready;
        self.completed_at_unix_ms = Some(timestamp_unix_ms);
        self.bump_revision_if_semantic_change(before);
        Ok(())
    }

    pub fn push_log(
        &mut self,
        timestamp_unix_ms: u64,
        level: PreparationLogLevel,
        stage_id: PreparationStageId,
        message: impl Into<String>,
    ) {
        let before = self.semantic_snapshot();
        self.log_tail.push_back(PreparationLogEntry {
            timestamp_unix_ms,
            level,
            stage_id,
            message: message.into(),
        });
        while self.log_tail.len() > MAX_PREPARATION_LOG_ENTRIES {
            self.log_tail.pop_front();
        }
        self.bump_revision_if_semantic_change(before);
    }

    fn stage(&self, stage_id: PreparationStageId) -> &PreparationStage {
        &self.stages[stage_id.index()]
    }

    fn stage_mut(&mut self, stage_id: PreparationStageId) -> &mut PreparationStage {
        &mut self.stages[stage_id.index()]
    }

    fn ensure_not_terminal(&self) -> Result<(), PreparationTransitionError> {
        match self.status {
            PreparationStatus::Ready | PreparationStatus::Failed => {
                Err(PreparationTransitionError::PreparationIsTerminal {
                    status: self.status,
                })
            }
            PreparationStatus::Connecting | PreparationStatus::Running => Ok(()),
        }
    }

    fn ensure_forward(
        &self,
        stage_id: PreparationStageId,
    ) -> Result<(), PreparationTransitionError> {
        let target_index = stage_id.index();
        let latest_terminal_or_active = self
            .stages
            .iter()
            .enumerate()
            .filter(|(_, stage)| stage.status != PreparationStageStatus::Pending)
            .map(|(index, _)| index)
            .max();
        if let Some(current_index) = latest_terminal_or_active {
            if target_index < current_index {
                return Err(PreparationTransitionError::StageRegression {
                    requested: stage_id,
                    current: self.stages[current_index].id,
                });
            }
        }
        Ok(())
    }

    fn ensure_active(
        &self,
        stage_id: PreparationStageId,
    ) -> Result<(), PreparationTransitionError> {
        if self.active_stage_id != Some(stage_id) {
            return Err(PreparationTransitionError::StageIsNotActive {
                stage_id,
                active_stage_id: self.active_stage_id,
            });
        }
        Ok(())
    }

    fn clock_adjustment(
        &self,
        stage_id: PreparationStageId,
        timestamp_unix_ms: u64,
    ) -> Option<PreparationClockAdjustment> {
        let started_at_unix_ms = self
            .stage(stage_id)
            .started_at_unix_ms
            .unwrap_or(timestamp_unix_ms);
        (timestamp_unix_ms < started_at_unix_ms).then(|| PreparationClockAdjustment {
            observed_at_unix_ms: timestamp_unix_ms,
            stage_started_at_unix_ms: started_at_unix_ms,
            backward_delta_ms: started_at_unix_ms - timestamp_unix_ms,
        })
    }

    fn record_clock_adjustment(
        stage: &mut PreparationStage,
        adjustment: Option<PreparationClockAdjustment>,
    ) {
        if adjustment.as_ref().is_some_and(|candidate| {
            stage.clock_adjustment.as_ref().map_or(true, |current| {
                candidate.backward_delta_ms > current.backward_delta_ms
            })
        }) {
            stage.clock_adjustment = adjustment;
        }
    }

    fn stage_duration_ms(&self) -> u64 {
        self.active_stage_started_at
            .map(|started_at| self.monotonic_clock.elapsed_ms(started_at))
            .unwrap_or(0)
    }

    fn skip_pending_before(&mut self, stage_id: PreparationStageId) {
        for stage in &mut self.stages[..stage_id.index()] {
            if stage.status == PreparationStageStatus::Pending {
                stage.status = PreparationStageStatus::Skipped;
                stage.detail = "Not required for this preparation".to_string();
            }
        }
    }

    fn semantic_snapshot(&self) -> serde_json::Value {
        let mut snapshot = self.clone();
        snapshot.revision = 0;
        serde_json::to_value(snapshot).expect("simulation preparation state must serialize")
    }

    fn bump_revision_if_semantic_change(&mut self, before: serde_json::Value) {
        if self.semantic_snapshot() != before {
            self.revision += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preparation_transitions_keep_order_and_bound_log_tail() {
        let clock = ManualMonotonicClock::new(0);
        let mut state =
            SimulationPreparationState::new_with_monotonic_clock("prep-1", 1_000, clock.clone());
        state
            .begin_stage(
                PreparationStageId::RuntimeStartup,
                1_000,
                "Starting runtime",
            )
            .unwrap();
        clock.advance_ms(180);
        state
            .complete_stage(PreparationStageId::RuntimeStartup, 9_180, "Runtime ready")
            .unwrap();
        state
            .begin_stage(
                PreparationStageId::ScriptMaterialization,
                9_180,
                "Materializing script",
            )
            .unwrap();
        for index in 0..205 {
            state.push_log(
                9_180 + index,
                PreparationLogLevel::Info,
                PreparationStageId::ScriptMaterialization,
                format!("entry {index}"),
            );
        }
        assert_eq!(
            state.active_stage_id,
            Some(PreparationStageId::ScriptMaterialization)
        );
        assert_eq!(state.stages[0].duration_ms, Some(180));
        assert_eq!(state.log_tail.len(), MAX_PREPARATION_LOG_ENTRIES);
        assert_eq!(state.log_tail.front().unwrap().message, "entry 5");
        assert_eq!(
            state
                .stages
                .iter()
                .map(|stage| stage.id)
                .collect::<Vec<_>>(),
            vec![
                PreparationStageId::RuntimeStartup,
                PreparationStageId::ScriptMaterialization,
                PreparationStageId::Validation,
                PreparationStageId::Planning,
                PreparationStageId::DomainPreparation,
                PreparationStageId::Meshing,
                PreparationStageId::MeshPostprocessing,
                PreparationStageId::SolverInitialization,
                PreparationStageId::Ready,
            ]
        );
    }

    #[test]
    fn preparation_rejects_regression_and_invalid_percent() {
        let mut state = SimulationPreparationState::new("prep-1", 1_000);
        state
            .begin_stage(PreparationStageId::Planning, 1_100, "Planning")
            .unwrap();
        assert!(state
            .begin_stage(PreparationStageId::Validation, 1_200, "late validation")
            .is_err());
        assert!(state
            .update_progress(PreparationStageId::Planning, 101, "invalid", 1_200)
            .is_err());
    }

    #[test]
    fn preparation_skips_inapplicable_stages_and_keeps_identical_updates_idempotent() {
        let clock = ManualMonotonicClock::new(0);
        let mut state =
            SimulationPreparationState::new_with_monotonic_clock("prep-1", 1_000, clock.clone());
        state
            .begin_stage(PreparationStageId::Planning, 1_100, "Planning")
            .unwrap();
        assert!(state.stages[..3]
            .iter()
            .all(|stage| stage.status == PreparationStageStatus::Skipped));

        clock.advance_ms(100);
        state
            .update_progress(PreparationStageId::Planning, 42, "4/10 inputs", 1_200)
            .unwrap();
        assert_eq!(state.stages[3].duration_ms, Some(100));
        let revision = state.revision;
        state
            .update_progress(PreparationStageId::Planning, 42, "4/10 inputs", 1_200)
            .unwrap();
        assert_eq!(state.revision, revision);
    }

    #[test]
    fn preparation_failure_is_owned_by_the_active_stage() {
        let mut state = SimulationPreparationState::new("prep-1", 1_000);
        state
            .begin_stage(PreparationStageId::Meshing, 1_100, "Building mesh")
            .unwrap();
        state
            .fail_stage(
                PreparationStageId::Meshing,
                1_200,
                "MESH_BUILD_FAILED",
                "Mesh generation failed",
            )
            .unwrap();

        assert_eq!(state.status, PreparationStatus::Failed);
        assert_eq!(state.active_stage_id, None);
        assert_eq!(state.stages[5].status, PreparationStageStatus::Failed);
        assert_eq!(
            state.failure.as_ref().unwrap().stage_id,
            PreparationStageId::Meshing
        );
    }

    #[test]
    fn backward_wall_clock_adjustment_preserves_raw_time_and_monotonic_ordering() {
        let clock = ManualMonotonicClock::new(0);
        let mut state = SimulationPreparationState::new_with_monotonic_clock(
            "prep-clock-adjustment",
            40_000,
            clock.clone(),
        );
        state
            .begin_stage(
                PreparationStageId::ScriptMaterialization,
                40_000,
                "Materializing script",
            )
            .unwrap();
        let revision_before_completion = state.revision;
        clock.advance_ms(1_250);

        state
            .complete_stage(
                PreparationStageId::ScriptMaterialization,
                8_000,
                "Script materialized",
            )
            .expect("a 32 second wall-clock rollback must not abort preparation");

        let stage = state.stage(PreparationStageId::ScriptMaterialization);
        assert_eq!(stage.status, PreparationStageStatus::Completed);
        assert_eq!(stage.completed_at_unix_ms, Some(8_000));
        assert_eq!(stage.duration_ms, Some(1_250));
        assert_eq!(
            stage.clock_adjustment,
            Some(PreparationClockAdjustment {
                observed_at_unix_ms: 8_000,
                stage_started_at_unix_ms: 40_000,
                backward_delta_ms: 32_000,
            })
        );
        assert_eq!(state.active_stage_id, None);
        assert!(state.revision > revision_before_completion);
    }

    #[test]
    fn projected_completion_preserves_order_with_unknown_timing() {
        let clock = ManualMonotonicClock::new(0);
        let mut state =
            SimulationPreparationState::new_with_monotonic_clock("prep-projected", 1_000, clock);
        state
            .begin_stage(
                PreparationStageId::DomainPreparation,
                1_100,
                "Preparing domain",
            )
            .unwrap();

        state
            .project_completed_stage(
                PreparationStageId::DomainPreparation,
                "Domain completed during deferred materialization; timing unavailable",
            )
            .unwrap();
        state
            .project_completed_stage(
                PreparationStageId::Meshing,
                "Mesh completed during deferred materialization; timing unavailable",
            )
            .unwrap();
        state
            .project_completed_stage(
                PreparationStageId::MeshPostprocessing,
                "Mesh postprocessing completed during deferred materialization; timing unavailable",
            )
            .unwrap();

        for stage_id in [
            PreparationStageId::DomainPreparation,
            PreparationStageId::Meshing,
            PreparationStageId::MeshPostprocessing,
        ] {
            let stage = state
                .stages
                .iter()
                .find(|stage| stage.id == stage_id)
                .unwrap();
            assert_eq!(stage.status, PreparationStageStatus::Completed);
            assert_eq!(stage.completed_at_unix_ms, None);
            assert_eq!(stage.duration_ms, None);
            assert!(stage.detail.contains("timing unavailable"));
        }
        assert_eq!(state.active_stage_id, None);
        state
            .begin_stage(
                PreparationStageId::SolverInitialization,
                1_200,
                "Initializing solver",
            )
            .expect("projected completion must preserve monotonic forward progress");
    }

    #[test]
    fn projected_failure_keeps_unknown_timing_and_exact_owner() {
        let clock = ManualMonotonicClock::new(0);
        let mut state = SimulationPreparationState::new_with_monotonic_clock(
            "prep-projected-failure",
            1_000,
            clock.clone(),
        );
        state
            .begin_stage(PreparationStageId::Meshing, 1_100, "Meshing")
            .unwrap();
        clock.advance_ms(250);

        state
            .project_failed_stage(
                PreparationStageId::Meshing,
                "mesh_build_failed",
                "Shared-domain mesh build failed",
            )
            .unwrap();

        let meshing = state
            .stages
            .iter()
            .find(|stage| stage.id == PreparationStageId::Meshing)
            .unwrap();
        assert_eq!(meshing.status, PreparationStageStatus::Failed);
        assert_eq!(meshing.completed_at_unix_ms, None);
        assert_eq!(meshing.duration_ms, None);
        assert_eq!(state.status, PreparationStatus::Failed);
        assert_eq!(state.completed_at_unix_ms, None);
        assert_eq!(
            state.failure.as_ref().map(|failure| failure.stage_id),
            Some(PreparationStageId::Meshing)
        );
    }
}
