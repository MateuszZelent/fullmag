//! Simulation state, integrator buffers, and solver session types.

use crate::fdm::shared::observables::{EffectiveFieldObservables, StepReport};
use crate::vector::normalized;
use crate::{
    EngineError, EvaluationRequest, ExchangeLlgProblem, FftWorkspace, GridShape, Result, Vector3,
    VectorFieldSoA, FDM_ADAPTIVE_CONTROLLER_MAX_REJECTED_ATTEMPTS,
    FDM_ADAPTIVE_CONTROLLER_POLICY_VERSION,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const FDM_CPU_SOLVER_CHECKPOINT_SCHEMA_VERSION: &str = "fullmag.fdm.cpu.solver-checkpoint.v1";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Abm3CheckpointHistoryV1 {
    /// Newest accepted sample first: `f_n`, `f_n_minus_1`, `f_n_minus_2`.
    pub rhs_history: Vec<Vec<Vector3>>,
    /// Times corresponding one-to-one with `rhs_history`, newest first.
    pub rhs_times_seconds: Vec<f64>,
    pub startup_steps: u32,
    pub last_dt: f64,
    pub history_resets: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FdmCpuSolverCheckpointV1 {
    pub schema_version: String,
    pub grid_cells: [usize; 3],
    pub magnetization: Vec<Vector3>,
    pub time_seconds: f64,
    pub k_fsal: Option<Vec<Vector3>>,
    pub adaptive_previous_error: Option<f64>,
    pub abm3: Abm3CheckpointHistoryV1,
}

/// Relative step-size tolerance for the fixed-step ABM3 history.
///
/// ABM3 uses fixed-step coefficients. A step-size change outside this small
/// round-off window must restart the multistep history before evaluating the
/// predictor; otherwise the first step after the change mixes incompatible
/// coefficients and stale RHS samples.
pub(crate) const ABM_DT_RELATIVE_TOLERANCE: f64 = 1.0e-12;

fn abm_dt_changed(last_dt: f64, dt: f64) -> bool {
    if last_dt <= 0.0 {
        return false;
    }
    let scale = last_dt.abs().max(dt.abs()).max(f64::MIN_POSITIVE);
    (dt - last_dt).abs() > ABM_DT_RELATIVE_TOLERANCE * scale
}

// ── ExchangeLlgStateSoA ───────────────────────────────────────────────

/// Structure-of-Arrays state for FDM LLG solver.
///
/// Stores magnetization components as separate contiguous arrays
/// (mx, my, mz) for optimal SIMD auto-vectorization, FFT pack/unpack,
/// thermal noise generation, and cache locality.
///
/// B2: This is the internal SoA layout — `ExchangeLlgState` (AoS) remains
/// as the public API type with cheap conversion adapters.
#[derive(Debug, Clone, PartialEq)]
pub struct ExchangeLlgStateSoA {
    pub(crate) grid: GridShape,
    pub(crate) magnetization: VectorFieldSoA,
    pub time_seconds: f64,
    /// FSAL (First Same As Last) buffer for Dormand–Prince 5(4).
    pub(crate) k_fsal: Option<VectorFieldSoA>,
    pub(crate) adaptive_previous_error: Option<f64>,
    /// ABM(3) history: stores the last 3 RHS evaluations (SoA layout).
    pub(crate) abm_history: AbmHistorySoA,
}

/// Exact host-copy accounting for publishing a persistent SoA accepted state.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FdmCpuStateCopyTelemetry {
    pub copied_bytes: u64,
    pub full_field_copy_count: u64,
}

impl ExchangeLlgStateSoA {
    /// Create from an existing AoS state (cheap copy).
    pub fn from_aos(state: &ExchangeLlgState) -> Self {
        Self {
            grid: state.grid,
            magnetization: VectorFieldSoA::from_aos(&state.magnetization),
            time_seconds: state.time_seconds,
            k_fsal: state.k_fsal.as_ref().map(|k| VectorFieldSoA::from_aos(k)),
            adaptive_previous_error: state.adaptive_previous_error,
            abm_history: AbmHistorySoA::from_aos(&state.abm_history),
        }
    }

    /// Convert back to AoS state.
    pub fn to_aos(&self) -> ExchangeLlgState {
        ExchangeLlgState {
            grid: self.grid,
            magnetization: self.magnetization.gather_to_aos(),
            time_seconds: self.time_seconds,
            k_fsal: self.k_fsal.as_ref().map(|k| k.gather_to_aos()),
            adaptive_previous_error: self.adaptive_previous_error,
            abm_history: self.abm_history.to_aos(),
        }
    }

    /// Publish only the accepted magnetization and time required by ordinary
    /// runner output. Integrator caches remain authoritative in this SoA state.
    pub fn publish_accepted_to(&self, state: &mut ExchangeLlgState) -> FdmCpuStateCopyTelemetry {
        self.magnetization.gather_into_aos(&mut state.magnetization);
        state.time_seconds = self.time_seconds;
        FdmCpuStateCopyTelemetry {
            copied_bytes: vector_field_bytes(self.magnetization.len()),
            full_field_copy_count: 1,
        }
    }

    /// Synchronize the complete transactional state into an AoS mirror.
    pub fn write_back_to(&self, state: &mut ExchangeLlgState) -> FdmCpuStateCopyTelemetry {
        let mut telemetry = self.publish_accepted_to(state);
        match (&self.k_fsal, &mut state.k_fsal) {
            (Some(source), Some(target)) => {
                source.gather_into_aos(target);
                telemetry.copied_bytes = telemetry
                    .copied_bytes
                    .saturating_add(vector_field_bytes(source.len()));
                telemetry.full_field_copy_count += 1;
            }
            (Some(source), target @ None) => {
                *target = Some(source.gather_to_aos());
                telemetry.copied_bytes = telemetry
                    .copied_bytes
                    .saturating_add(vector_field_bytes(source.len()));
                telemetry.full_field_copy_count += 1;
            }
            (None, target) => *target = None,
        }
        state.adaptive_previous_error = self.adaptive_previous_error;
        let history = state.abm_history.copy_from_soa(&self.abm_history);
        telemetry.copied_bytes = telemetry.copied_bytes.saturating_add(history.copied_bytes);
        telemetry.full_field_copy_count += history.full_field_copy_count;
        telemetry
    }

    /// Number of cells.
    pub fn cell_count(&self) -> usize {
        self.magnetization.len()
    }

    /// Read-only access to the SoA magnetization.
    pub fn magnetization(&self) -> &VectorFieldSoA {
        &self.magnetization
    }

    /// Return the canonical digest of this persistent SoA state. The digest
    /// uses the AoS semantic ordering so an AoS/SoA conversion does not alter
    /// checkpoint identity.
    pub fn transactional_state_digest(&self) -> String {
        self.to_aos().transactional_state_digest()
    }
}

/// SoA version of ABM history buffer.
#[derive(Debug, Clone, PartialEq)]
pub struct AbmHistorySoA {
    pub(crate) f_n: Option<VectorFieldSoA>,
    pub(crate) f_n_minus_1: Option<VectorFieldSoA>,
    pub(crate) f_n_minus_2: Option<VectorFieldSoA>,
    pub(crate) startup_steps: u32,
    pub(crate) last_dt: f64,
    pub(crate) history_resets: u64,
}

impl AbmHistorySoA {
    #[allow(dead_code)]
    pub(crate) fn new() -> Self {
        Self {
            f_n: None,
            f_n_minus_1: None,
            f_n_minus_2: None,
            startup_steps: 0,
            last_dt: 0.0,
            history_resets: 0,
        }
    }

    pub(crate) fn from_aos(h: &AbmHistory) -> Self {
        Self {
            f_n: h.f_n.as_ref().map(|v| VectorFieldSoA::from_aos(v)),
            f_n_minus_1: h.f_n_minus_1.as_ref().map(|v| VectorFieldSoA::from_aos(v)),
            f_n_minus_2: h.f_n_minus_2.as_ref().map(|v| VectorFieldSoA::from_aos(v)),
            startup_steps: h.startup_steps,
            last_dt: h.last_dt,
            history_resets: h.history_resets,
        }
    }

    pub(crate) fn to_aos(&self) -> AbmHistory {
        AbmHistory {
            f_n: self.f_n.as_ref().map(|v| v.gather_to_aos()),
            f_n_minus_1: self.f_n_minus_1.as_ref().map(|v| v.gather_to_aos()),
            f_n_minus_2: self.f_n_minus_2.as_ref().map(|v| v.gather_to_aos()),
            startup_steps: self.startup_steps,
            last_dt: self.last_dt,
            history_resets: self.history_resets,
        }
    }

    #[allow(dead_code)]
    pub(crate) fn restart(&mut self) {
        let had_history = self.startup_steps != 0
            || self.last_dt != 0.0
            || self.f_n.is_some()
            || self.f_n_minus_1.is_some()
            || self.f_n_minus_2.is_some();
        let history_resets = self.history_resets.saturating_add(u64::from(had_history));
        *self = Self::new();
        self.history_resets = history_resets;
    }

    pub(crate) fn is_ready(&self) -> bool {
        self.startup_steps >= 3
            && self.f_n.is_some()
            && self.f_n_minus_1.is_some()
            && self.f_n_minus_2.is_some()
    }

    pub(crate) fn requires_restart_for_dt(&self, dt: f64) -> bool {
        abm_dt_changed(self.last_dt, dt)
    }

    pub(crate) fn restart_if_dt_changed(&mut self, dt: f64) -> bool {
        if self.requires_restart_for_dt(dt) {
            self.restart();
            true
        } else {
            false
        }
    }

    pub(crate) fn f_n(&self) -> Option<&VectorFieldSoA> {
        self.f_n.as_ref()
    }

    pub(crate) fn f_n_minus_1(&self) -> Option<&VectorFieldSoA> {
        self.f_n_minus_1.as_ref()
    }

    pub(crate) fn f_n_minus_2(&self) -> Option<&VectorFieldSoA> {
        self.f_n_minus_2.as_ref()
    }

    pub(crate) fn push_copy_from_soa(&mut self, f: &VectorFieldSoA, dt: f64) {
        self.restart_if_dt_changed(dt);

        let mut newest = self
            .f_n_minus_2
            .take()
            .unwrap_or_else(|| VectorFieldSoA::zeros(f.len()));
        newest.copy_from(f);

        self.f_n_minus_2 = self.f_n_minus_1.take();
        self.f_n_minus_1 = self.f_n.take();
        self.f_n = Some(newest);
        self.startup_steps = (self.startup_steps + 1).min(3);
        self.last_dt = dt;
    }
}

// ── ExchangeLlgState ───────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct ExchangeLlgState {
    pub(crate) grid: GridShape,
    pub(crate) magnetization: Vec<Vector3>,
    pub time_seconds: f64,
    /// FSAL (First Same As Last) buffer for Dormand–Prince 5(4).
    pub(crate) k_fsal: Option<Vec<Vector3>>,
    pub(crate) adaptive_previous_error: Option<f64>,
    /// ABM(3) history: stores the last 3 RHS evaluations for multi-step prediction.
    pub(crate) abm_history: AbmHistory,
}

impl ExchangeLlgState {
    pub fn new(grid: GridShape, magnetization: Vec<Vector3>) -> Result<Self> {
        if magnetization.len() != grid.cell_count() {
            return Err(EngineError::new(format!(
                "magnetization length {} does not match grid cell count {}",
                magnetization.len(),
                grid.cell_count()
            )));
        }

        let magnetization = magnetization
            .into_iter()
            .map(normalized)
            .collect::<Result<Vec<_>>>()?;

        Ok(Self {
            grid,
            magnetization,
            time_seconds: 0.0,
            k_fsal: None,
            adaptive_previous_error: None,
            abm_history: AbmHistory::new(),
        })
    }

    pub fn uniform(grid: GridShape, value: Vector3) -> Result<Self> {
        Self::new(grid, vec![value; grid.cell_count()])
    }

    pub fn magnetization(&self) -> &[Vector3] {
        &self.magnetization
    }

    pub fn magnetization_mut(&mut self) -> &mut [Vector3] {
        &mut self.magnetization
    }

    /// Invalidate the FSAL buffer (e.g. after external state modification).
    pub fn invalidate_fsal(&mut self) {
        self.k_fsal = None;
        self.adaptive_previous_error = None;
    }

    /// Check whether a valid FSAL RHS is available.
    pub fn has_fsal(&self) -> bool {
        self.k_fsal.is_some()
    }

    /// Reset ABM multi-step history (e.g. after external state modification).
    pub fn reset_abm_history(&mut self) {
        self.abm_history.restart();
    }

    /// Replace the magnetization vector, normalizing each cell.
    ///
    /// Zero vectors (inactive cells) are preserved as-is.
    pub fn set_magnetization(&mut self, magnetization: Vec<Vector3>) -> Result<()> {
        if magnetization.len() != self.grid.cell_count() {
            return Err(EngineError::new(format!(
                "magnetization length {} does not match grid cell count {}",
                magnetization.len(),
                self.grid.cell_count()
            )));
        }
        self.magnetization = magnetization
            .into_iter()
            .map(normalized)
            .collect::<Result<Vec<_>>>()?;
        Ok(())
    }

    /// Restore an already validated checkpoint state without renormalizing its
    /// serialized floating-point values. This preserves bitwise continuation.
    pub fn restore_exact_checkpoint(
        &mut self,
        magnetization: Vec<Vector3>,
        time_seconds: f64,
    ) -> Result<()> {
        if magnetization.len() != self.grid.cell_count()
            || magnetization
                .iter()
                .flatten()
                .any(|value| !value.is_finite())
            || !time_seconds.is_finite()
            || time_seconds < 0.0
        {
            return Err(EngineError::new(
                "exact checkpoint magnetization/time is invalid",
            ));
        }
        self.magnetization = magnetization;
        self.time_seconds = time_seconds;
        self.invalidate_fsal();
        self.reset_abm_history();
        Ok(())
    }

    /// Capture the complete accepted CPU solver state in a versioned envelope.
    pub fn solver_checkpoint(&self) -> FdmCpuSolverCheckpointV1 {
        let rhs_history: Vec<Vec<Vector3>> = [
            self.abm_history.f_n.as_ref(),
            self.abm_history.f_n_minus_1.as_ref(),
            self.abm_history.f_n_minus_2.as_ref(),
        ]
        .into_iter()
        .flatten()
        .cloned()
        .collect();
        let rhs_times_seconds = if rhs_history.is_empty() {
            Vec::new()
        } else {
            (0..rhs_history.len())
                .map(|index| self.time_seconds - index as f64 * self.abm_history.last_dt)
                .collect()
        };
        FdmCpuSolverCheckpointV1 {
            schema_version: FDM_CPU_SOLVER_CHECKPOINT_SCHEMA_VERSION.to_string(),
            grid_cells: [self.grid.nx, self.grid.ny, self.grid.nz],
            magnetization: self.magnetization.clone(),
            time_seconds: self.time_seconds,
            k_fsal: self.k_fsal.clone(),
            adaptive_previous_error: self.adaptive_previous_error,
            abm3: Abm3CheckpointHistoryV1 {
                rhs_history,
                rhs_times_seconds,
                startup_steps: self.abm_history.startup_steps,
                last_dt: self.abm_history.last_dt,
                history_resets: self.abm_history.history_resets,
            },
        }
    }

    /// Restore a fully validated solver checkpoint without normalizing or
    /// reconstructing multistep history. Validation is transactional.
    pub fn restore_solver_checkpoint(
        &mut self,
        checkpoint: FdmCpuSolverCheckpointV1,
    ) -> Result<()> {
        checkpoint.validate_for_grid(self.grid)?;

        let mut slots = checkpoint.abm3.rhs_history.into_iter();
        let restored_history = AbmHistory {
            f_n: slots.next(),
            f_n_minus_1: slots.next(),
            f_n_minus_2: slots.next(),
            startup_steps: checkpoint.abm3.startup_steps,
            last_dt: checkpoint.abm3.last_dt,
            history_resets: checkpoint.abm3.history_resets,
        };
        self.magnetization = checkpoint.magnetization;
        self.time_seconds = checkpoint.time_seconds;
        self.k_fsal = checkpoint.k_fsal;
        self.adaptive_previous_error = checkpoint.adaptive_previous_error;
        self.abm_history = restored_history;
        Ok(())
    }

    /// Convert to SoA layout (allocating).
    pub fn to_soa(&self) -> ExchangeLlgStateSoA {
        ExchangeLlgStateSoA::from_aos(self)
    }

    /// Return a bit-preserving digest of the authoritative state, including
    /// FSAL, adaptive-controller memory, and ABM history. This is deliberately
    /// independent of serde field ordering and is suitable for rollback tests.
    pub fn transactional_state_digest(&self) -> String {
        let mut hasher = Sha256::new();
        hasher.update(b"fullmag.fdm.solver-state.v2\0");
        update_u64(&mut hasher, self.grid.nx as u64);
        update_u64(&mut hasher, self.grid.ny as u64);
        update_u64(&mut hasher, self.grid.nz as u64);
        update_f64(&mut hasher, self.time_seconds);
        update_vectors(&mut hasher, &self.magnetization);
        update_optional_vectors(&mut hasher, self.k_fsal.as_deref());
        update_optional_f64(&mut hasher, self.adaptive_previous_error);
        update_abm_history(&mut hasher, &self.abm_history);
        format!("sha256:{:x}", hasher.finalize())
    }
}

impl FdmCpuSolverCheckpointV1 {
    pub fn validate_for_grid(&self, grid: GridShape) -> Result<()> {
        let expected_grid = [grid.nx, grid.ny, grid.nz];
        if self.schema_version != FDM_CPU_SOLVER_CHECKPOINT_SCHEMA_VERSION {
            return Err(EngineError::new(format!(
                "unsupported FDM CPU solver checkpoint schema '{}'; expected '{}'",
                self.schema_version, FDM_CPU_SOLVER_CHECKPOINT_SCHEMA_VERSION
            )));
        }
        if self.grid_cells != expected_grid {
            return Err(EngineError::new(format!(
                "FDM CPU solver checkpoint grid mismatch: checkpoint={:?}, expected={expected_grid:?}",
                self.grid_cells
            )));
        }
        let vector_count = grid.cell_count();
        validate_checkpoint_vectors("magnetization", &self.magnetization, vector_count)?;
        if !self.time_seconds.is_finite() || self.time_seconds < 0.0 {
            return Err(EngineError::new(
                "FDM CPU solver checkpoint time_seconds must be finite and nonnegative",
            ));
        }
        if let Some(k_fsal) = &self.k_fsal {
            validate_checkpoint_vectors("k_fsal", k_fsal, vector_count)?;
        }
        if self
            .adaptive_previous_error
            .is_some_and(|value| !value.is_finite() || value < 0.0)
        {
            return Err(EngineError::new(
                "FDM CPU solver checkpoint adaptive_previous_error must be finite and nonnegative",
            ));
        }

        let history = &self.abm3;
        if history.startup_steps > 3 {
            return Err(EngineError::new(
                "FDM CPU solver checkpoint ABM3 startup_steps exceeds 3",
            ));
        }
        let expected_history_len = history.startup_steps as usize;
        if history.rhs_history.len() != expected_history_len
            || history.rhs_times_seconds.len() != expected_history_len
        {
            return Err(EngineError::new(format!(
                "FDM CPU solver checkpoint ABM3 history length mismatch: startup_steps={}, rhs={}, times={}",
                history.startup_steps,
                history.rhs_history.len(),
                history.rhs_times_seconds.len()
            )));
        }
        if expected_history_len == 0 {
            if history.last_dt != 0.0 {
                return Err(EngineError::new(
                    "empty FDM CPU solver checkpoint ABM3 history requires last_dt=0",
                ));
            }
            return Ok(());
        }
        if !history.last_dt.is_finite() || history.last_dt <= 0.0 {
            return Err(EngineError::new(
                "FDM CPU solver checkpoint ABM3 last_dt must be finite and positive",
            ));
        }
        for (index, rhs) in history.rhs_history.iter().enumerate() {
            validate_checkpoint_vectors(&format!("abm3.rhs_history[{index}]"), rhs, vector_count)?;
            let actual_time = history.rhs_times_seconds[index];
            let expected_time = self.time_seconds - index as f64 * history.last_dt;
            let tolerance = 16.0
                * f64::EPSILON
                * actual_time
                    .abs()
                    .max(expected_time.abs())
                    .max(f64::MIN_POSITIVE);
            if !actual_time.is_finite()
                || actual_time < 0.0
                || (actual_time - expected_time).abs() > tolerance
            {
                return Err(EngineError::new(format!(
                    "FDM CPU solver checkpoint ABM3 history time mismatch at index {index}: actual={actual_time}, expected={expected_time}"
                )));
            }
        }
        Ok(())
    }
}

fn validate_checkpoint_vectors(label: &str, values: &[Vector3], expected: usize) -> Result<()> {
    if values.len() != expected {
        return Err(EngineError::new(format!(
            "FDM CPU solver checkpoint {label} length mismatch: actual={}, expected={expected}",
            values.len()
        )));
    }
    if values.iter().flatten().any(|value| !value.is_finite()) {
        return Err(EngineError::new(format!(
            "FDM CPU solver checkpoint {label} contains a non-finite value"
        )));
    }
    Ok(())
}

fn update_u64(hasher: &mut Sha256, value: u64) {
    hasher.update(value.to_le_bytes());
}

fn update_f64(hasher: &mut Sha256, value: f64) {
    hasher.update(value.to_bits().to_le_bytes());
}

fn update_vectors(hasher: &mut Sha256, values: &[Vector3]) {
    update_u64(hasher, values.len() as u64);
    for value in values {
        update_f64(hasher, value[0]);
        update_f64(hasher, value[1]);
        update_f64(hasher, value[2]);
    }
}

fn update_optional_vectors(hasher: &mut Sha256, values: Option<&[Vector3]>) {
    match values {
        Some(values) => {
            hasher.update([1]);
            update_vectors(hasher, values);
        }
        None => hasher.update([0]),
    }
}

fn update_optional_f64(hasher: &mut Sha256, value: Option<f64>) {
    match value {
        Some(value) => {
            hasher.update([1]);
            update_f64(hasher, value);
        }
        None => hasher.update([0]),
    }
}

fn update_abm_history(hasher: &mut Sha256, history: &AbmHistory) {
    update_optional_vectors(hasher, history.f_n.as_deref());
    update_optional_vectors(hasher, history.f_n_minus_1.as_deref());
    update_optional_vectors(hasher, history.f_n_minus_2.as_deref());
    update_u64(hasher, history.startup_steps as u64);
    update_f64(hasher, history.last_dt);
    update_u64(hasher, history.history_resets);
}

// ── AbmHistory ─────────────────────────────────────────────────────────

/// History buffer for Adams–Bashforth–Moulton 3rd-order predictor-corrector.
#[derive(Debug, Clone, PartialEq)]
pub struct AbmHistory {
    /// RHS at step n (most recent)
    pub(crate) f_n: Option<Vec<Vector3>>,
    /// RHS at step n-1
    pub(crate) f_n_minus_1: Option<Vec<Vector3>>,
    /// RHS at step n-2
    pub(crate) f_n_minus_2: Option<Vec<Vector3>>,
    /// Number of startup steps completed (0..3)
    pub(crate) startup_steps: u32,
    /// Last dt used (ABM requires constant dt; restart if changed)
    pub(crate) last_dt: f64,
    /// Cumulative explicit invalidations and fixed-step `dt` resets.
    pub(crate) history_resets: u64,
}

impl AbmHistory {
    pub(crate) fn new() -> Self {
        Self {
            f_n: None,
            f_n_minus_1: None,
            f_n_minus_2: None,
            startup_steps: 0,
            last_dt: 0.0,
            history_resets: 0,
        }
    }

    pub(crate) fn is_ready(&self) -> bool {
        self.startup_steps >= 3
            && self.f_n.is_some()
            && self.f_n_minus_1.is_some()
            && self.f_n_minus_2.is_some()
    }

    pub(crate) fn requires_restart_for_dt(&self, dt: f64) -> bool {
        abm_dt_changed(self.last_dt, dt)
    }

    pub(crate) fn restart_if_dt_changed(&mut self, dt: f64) -> bool {
        if self.requires_restart_for_dt(dt) {
            self.restart();
            true
        } else {
            false
        }
    }

    pub(crate) fn f_n(&self) -> Option<&[Vector3]> {
        self.f_n.as_deref()
    }

    pub(crate) fn f_n_minus_1(&self) -> Option<&[Vector3]> {
        self.f_n_minus_1.as_deref()
    }

    pub(crate) fn f_n_minus_2(&self) -> Option<&[Vector3]> {
        self.f_n_minus_2.as_deref()
    }

    /// Push a new RHS evaluation by copying into a reusable history slot.
    ///
    /// This preserves [`Self::push`] ordering and restart semantics, but after
    /// all three slots exist it rotates and overwrites existing allocations.
    pub(crate) fn push_copy_from_slice(&mut self, f: &[Vector3], dt: f64) {
        self.restart_if_dt_changed(dt);

        let mut newest = self
            .f_n_minus_2
            .take()
            .unwrap_or_else(|| Vec::with_capacity(f.len()));
        newest.clear();
        newest.extend_from_slice(f);

        self.f_n_minus_2 = self.f_n_minus_1.take();
        self.f_n_minus_1 = self.f_n.take();
        self.f_n = Some(newest);
        self.startup_steps = (self.startup_steps + 1).min(3);
        self.last_dt = dt;
    }

    fn copy_from_soa(&mut self, source: &AbmHistorySoA) -> FdmCpuStateCopyTelemetry {
        fn copy_slot(
            target: &mut Option<Vec<Vector3>>,
            source: Option<&VectorFieldSoA>,
        ) -> FdmCpuStateCopyTelemetry {
            match (target.as_mut(), source) {
                (Some(target), Some(source)) => source.gather_into_aos(target),
                (None, Some(source)) => *target = Some(source.gather_to_aos()),
                (_, None) => *target = None,
            }
            source.map_or_else(FdmCpuStateCopyTelemetry::default, |source| {
                FdmCpuStateCopyTelemetry {
                    copied_bytes: vector_field_bytes(source.len()),
                    full_field_copy_count: 1,
                }
            })
        }

        let mut telemetry = copy_slot(&mut self.f_n, source.f_n());
        for slot in [
            copy_slot(&mut self.f_n_minus_1, source.f_n_minus_1()),
            copy_slot(&mut self.f_n_minus_2, source.f_n_minus_2()),
        ] {
            telemetry.copied_bytes = telemetry.copied_bytes.saturating_add(slot.copied_bytes);
            telemetry.full_field_copy_count += slot.full_field_copy_count;
        }
        self.startup_steps = source.startup_steps;
        self.last_dt = source.last_dt;
        self.history_resets = source.history_resets;
        telemetry
    }

    pub(crate) fn restart(&mut self) {
        let had_history = self.startup_steps != 0
            || self.last_dt != 0.0
            || self.f_n.is_some()
            || self.f_n_minus_1.is_some()
            || self.f_n_minus_2.is_some();
        let history_resets = self.history_resets.saturating_add(u64::from(had_history));
        *self = Self::new();
        self.history_resets = history_resets;
    }
}

fn vector_field_bytes(len: usize) -> u64 {
    (len as u64).saturating_mul(std::mem::size_of::<Vector3>() as u64)
}

// ── IntegratorBuffers ──────────────────────────────────────────────────

/// Maximum number of records for one adaptive outer-step transaction: up to
/// 50 rejected attempts followed by one accepted or terminal attempt.
pub const MAX_ADAPTIVE_ATTEMPT_RECORDS: usize =
    FDM_ADAPTIVE_CONTROLLER_MAX_REJECTED_ATTEMPTS as usize + 1;

/// Layout selected for a reusable integrator buffer set.
///
/// A buffer set must not silently switch between AoS and SoA after its first
/// step.  Such a switch changes the executed operator realization and would
/// make a single session's provenance ambiguous.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FdmCpuStateLayout {
    Aos,
    Soa,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdaptiveAttemptDecision {
    Accepted,
    Retry,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdaptiveAttemptReason {
    WithinTolerance,
    ErrorAboveTolerance,
    DtMinExhausted,
    NonFiniteError,
    RetryLimitExhausted,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AdaptiveAttemptRecord {
    pub controller_policy_version: &'static str,
    pub attempt: u32,
    pub dt_attempt: f64,
    pub normalized_error: f64,
    pub decision: AdaptiveAttemptDecision,
    pub reason: AdaptiveAttemptReason,
    pub dt_next: f64,
    pub rhs_evals: u32,
}

impl Default for AdaptiveAttemptRecord {
    fn default() -> Self {
        Self {
            controller_policy_version: FDM_ADAPTIVE_CONTROLLER_POLICY_VERSION,
            attempt: 0,
            dt_attempt: 0.0,
            normalized_error: 0.0,
            decision: AdaptiveAttemptDecision::Failed,
            reason: AdaptiveAttemptReason::NonFiniteError,
            dt_next: 0.0,
            rhs_evals: 0,
        }
    }
}

/// Preallocated workspace buffers for time integrator stages.
#[derive(Debug, Clone)]
pub struct IntegratorBuffers {
    /// k-stage buffers (k1..k7).  RK45 needs 7, others need fewer.
    pub k: [Vec<Vector3>; 7],
    /// Structure-of-arrays k/stage buffers for CPU hot paths that avoid AoS
    /// RHS staging.
    pub soa: IntegratorBuffersSoA,
    /// Intermediate delta workspace (weighted sum of k-stages × dt).
    pub delta: Vec<Vector3>,
    /// Intermediate magnetization state for sub-stages.
    pub m_stage: Vec<Vector3>,
    /// Backup of initial magnetization at start of step.
    pub m0: Vec<Vector3>,
    /// Effective field workspace — reused across RHS evaluations.
    pub h_eff: Vec<Vector3>,
    /// Scratch buffer for individual field terms during zero-alloc report.
    pub h_scratch: Vec<Vector3>,
    /// RHS output buffer for zero-alloc report computation.
    pub rhs: Vec<Vector3>,
    layout: Option<FdmCpuStateLayout>,
    adaptive_attempts: [AdaptiveAttemptRecord; MAX_ADAPTIVE_ATTEMPT_RECORDS],
    adaptive_attempt_count: usize,
    adaptive_accepted_attempts: u32,
    adaptive_rejected_attempts: u32,
    /// Test-only controller input and observation seam.
    #[cfg(test)]
    adaptive_test_seam: Option<AdaptiveTestSeam>,
}

#[cfg(test)]
#[derive(Debug, Clone)]
struct AdaptiveTestSeam {
    error_script: Vec<f64>,
    attempt_dts: Vec<f64>,
}

impl IntegratorBuffers {
    /// Allocate zeroed buffers for `n` cells.
    pub fn new(n: usize) -> Self {
        let zero = || vec![[0.0, 0.0, 0.0]; n];
        Self {
            k: [zero(), zero(), zero(), zero(), zero(), zero(), zero()],
            soa: IntegratorBuffersSoA::new(n),
            delta: zero(),
            m_stage: zero(),
            m0: zero(),
            h_eff: zero(),
            h_scratch: zero(),
            rhs: zero(),
            layout: None,
            adaptive_attempts: [AdaptiveAttemptRecord::default(); MAX_ADAPTIVE_ATTEMPT_RECORDS],
            adaptive_attempt_count: 0,
            adaptive_accepted_attempts: 0,
            adaptive_rejected_attempts: 0,
            #[cfg(test)]
            adaptive_test_seam: None,
        }
    }

    pub fn adaptive_attempts(&self) -> &[AdaptiveAttemptRecord] {
        &self.adaptive_attempts[..self.adaptive_attempt_count]
    }

    pub fn adaptive_accepted_attempts(&self) -> u32 {
        self.adaptive_accepted_attempts
    }

    pub fn adaptive_rejected_attempts(&self) -> u32 {
        self.adaptive_rejected_attempts
    }

    pub(crate) fn select_layout(&mut self, layout: FdmCpuStateLayout) -> Result<()> {
        match self.layout {
            None => {
                self.layout = Some(layout);
                Ok(())
            }
            Some(selected) if selected == layout => Ok(()),
            Some(selected) => Err(EngineError::with_code(
                crate::EngineErrorCode::CapabilityUnavailable,
                format!(
                    "FDM CPU state layout changed for reusable buffers: selected={selected:?}, requested={layout:?}; create a new buffer set at the session boundary"
                ),
            )),
        }
    }

    pub(crate) fn begin_adaptive_step(&mut self) {
        self.adaptive_attempt_count = 0;
        self.adaptive_accepted_attempts = 0;
        self.adaptive_rejected_attempts = 0;
        #[cfg(test)]
        if let Some(seam) = &mut self.adaptive_test_seam {
            seam.attempt_dts.clear();
        }
    }

    pub(crate) fn record_adaptive_attempt(&mut self, mut record: AdaptiveAttemptRecord) {
        if self.adaptive_attempt_count >= MAX_ADAPTIVE_ATTEMPT_RECORDS {
            return;
        }
        record.controller_policy_version = FDM_ADAPTIVE_CONTROLLER_POLICY_VERSION;
        record.attempt = self.adaptive_attempt_count as u32 + 1;
        match record.decision {
            AdaptiveAttemptDecision::Accepted => self.adaptive_accepted_attempts += 1,
            AdaptiveAttemptDecision::Retry => self.adaptive_rejected_attempts += 1,
            AdaptiveAttemptDecision::Failed => {}
        }
        self.adaptive_attempts[self.adaptive_attempt_count] = record;
        self.adaptive_attempt_count += 1;
    }

    /// Configure a test-only sequence of adaptive error estimates. Values are
    /// consumed once per adaptive attempt at the estimator/controller boundary.
    #[cfg(test)]
    pub(crate) fn set_adaptive_error_script_for_tests(
        &mut self,
        errors: impl IntoIterator<Item = f64>,
    ) {
        let mut error_script: Vec<_> = errors.into_iter().collect();
        error_script.reverse();
        self.adaptive_test_seam = Some(AdaptiveTestSeam {
            error_script,
            attempt_dts: Vec::new(),
        });
    }

    /// Return every `dt` submitted to the adaptive controller by a configured
    /// test seam.
    #[cfg(test)]
    pub(crate) fn adaptive_attempt_dts_for_tests(&self) -> &[f64] {
        self.adaptive_test_seam
            .as_ref()
            .map_or(&[], |seam| seam.attempt_dts.as_slice())
    }

    #[cfg(test)]
    pub(crate) fn take_adaptive_error_for_tests(&mut self) -> Option<f64> {
        self.adaptive_test_seam
            .as_mut()
            .and_then(|seam| seam.error_script.pop())
    }

    #[cfg(test)]
    pub(crate) fn record_adaptive_attempt_for_tests(&mut self, dt: f64) {
        if let Some(seam) = &mut self.adaptive_test_seam {
            seam.attempt_dts.push(dt);
        }
    }
}

/// Structure-of-arrays stage buffers for integrators with SoA hot paths.
#[derive(Debug, Clone)]
pub struct IntegratorBuffersSoA {
    /// k-stage buffers (k1..k7).  RK45 needs 7, others need fewer.
    pub k: [VectorFieldSoA; 7],
    /// Intermediate magnetization state for sub-stages.
    pub m_stage: VectorFieldSoA,
    /// Backup of initial magnetization at start of step.
    pub m0: VectorFieldSoA,
    /// Effective field workspace reused across RHS evaluations.
    pub h_eff: VectorFieldSoA,
}

impl IntegratorBuffersSoA {
    pub fn new(n: usize) -> Self {
        Self {
            k: std::array::from_fn(|_| VectorFieldSoA::zeros(n)),
            m_stage: VectorFieldSoA::zeros(n),
            m0: VectorFieldSoA::zeros(n),
            h_eff: VectorFieldSoA::zeros(n),
        }
    }
}

// ── SolverSession ──────────────────────────────────────────────────────

/// Persistent solver session bundling all per-simulation resources.
pub struct SolverSession {
    problem: ExchangeLlgProblem,
    state: ExchangeLlgState,
    state_soa: Option<ExchangeLlgStateSoA>,
    fft_ws: FftWorkspace,
    bufs: IntegratorBuffers,
    step_count: u64,
}

impl SolverSession {
    /// Create a new solver session with the given problem and initial magnetization.
    pub fn new(problem: ExchangeLlgProblem, magnetization: Vec<Vector3>) -> Result<Self> {
        let state = ExchangeLlgState::new(problem.grid, magnetization)?;
        let state_soa = if problem.soa_fast_path_supported() {
            Some(state.to_soa())
        } else {
            None
        };
        let fft_ws = problem.create_workspace();
        let bufs = problem.create_integrator_buffers();
        Ok(Self {
            problem,
            state,
            state_soa,
            fft_ws,
            bufs,
            step_count: 0,
        })
    }

    /// Create a session from a complete, validated CPU solver checkpoint.
    pub fn from_checkpoint(
        problem: ExchangeLlgProblem,
        checkpoint: FdmCpuSolverCheckpointV1,
    ) -> Result<Self> {
        let mut state = ExchangeLlgState::uniform(problem.grid, [1.0, 0.0, 0.0])?;
        state.restore_solver_checkpoint(checkpoint)?;
        let state_soa = if problem.soa_fast_path_supported() {
            Some(state.to_soa())
        } else {
            None
        };
        let fft_ws = problem.create_workspace();
        let bufs = problem.create_integrator_buffers();
        Ok(Self {
            problem,
            state,
            state_soa,
            fft_ws,
            bufs,
            step_count: 0,
        })
    }

    pub fn checkpoint(&self) -> FdmCpuSolverCheckpointV1 {
        self.state_soa.as_ref().map_or_else(
            || self.state.solver_checkpoint(),
            |state| state.to_aos().solver_checkpoint(),
        )
    }

    /// Advance the simulation by one time step.
    pub fn step(&mut self, dt: f64) -> Result<StepReport> {
        if self.state_soa.is_none() && self.problem.soa_fast_path_supported() {
            self.state_soa = Some(self.state.to_soa());
        }

        let report = if let Some(state_soa) = self.state_soa.as_mut() {
            let report = self.problem.step_soa_with_buffers_evaluation(
                state_soa,
                dt,
                &mut self.fft_ws,
                &mut self.bufs,
                EvaluationRequest::Full,
            )?;
            state_soa.write_back_to(&mut self.state);
            report
        } else {
            self.problem
                .step_with_buffers(&mut self.state, dt, &mut self.fft_ws, &mut self.bufs)?
        };
        self.step_count += 1;
        Ok(report)
    }

    /// Whether the session is currently backed by the persistent SoA state.
    pub fn soa_fast_path_active(&self) -> bool {
        self.state_soa.is_some()
    }

    /// Current magnetization.
    pub fn magnetization(&self) -> &[Vector3] {
        self.state.magnetization()
    }

    /// Current simulation time (seconds).
    pub fn time(&self) -> f64 {
        self.state.time_seconds
    }

    /// Number of steps taken so far.
    pub fn step_count(&self) -> u64 {
        self.step_count
    }

    /// Mutable access to the state.
    pub fn state_mut(&mut self) -> &mut ExchangeLlgState {
        self.state_soa = None;
        &mut self.state
    }

    /// Immutable access to the state.
    pub fn state(&self) -> &ExchangeLlgState {
        &self.state
    }

    /// Immutable access to the problem.
    pub fn problem(&self) -> &ExchangeLlgProblem {
        &self.problem
    }

    /// Compute full observables at the current state.
    pub fn observe(&mut self) -> EffectiveFieldObservables {
        self.problem.observe_vectors_ws_at_time(
            self.state.magnetization(),
            &mut self.fft_ws,
            self.state.time_seconds,
        )
    }
}
