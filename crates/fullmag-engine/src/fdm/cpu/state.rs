//! Simulation state, integrator buffers, and solver session types.

use crate::fdm::shared::observables::{EffectiveFieldObservables, StepReport};
use crate::vector::normalized;
use crate::{
    EngineError, EvaluationRequest, ExchangeLlgProblem, FftWorkspace, GridShape, Result, Vector3,
    VectorFieldSoA,
};
use sha2::{Digest, Sha256};

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

    /// Write SoA state back into an existing AoS state.
    pub fn write_back_to(&self, state: &mut ExchangeLlgState) {
        self.magnetization.gather_into_aos(&mut state.magnetization);
        state.time_seconds = self.time_seconds;
        state.k_fsal = self.k_fsal.as_ref().map(|k| k.gather_to_aos());
        state.adaptive_previous_error = self.adaptive_previous_error;
        state.abm_history = self.abm_history.to_aos();
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
        }
    }

    pub(crate) fn from_aos(h: &AbmHistory) -> Self {
        Self {
            f_n: h.f_n.as_ref().map(|v| VectorFieldSoA::from_aos(v)),
            f_n_minus_1: h.f_n_minus_1.as_ref().map(|v| VectorFieldSoA::from_aos(v)),
            f_n_minus_2: h.f_n_minus_2.as_ref().map(|v| VectorFieldSoA::from_aos(v)),
            startup_steps: h.startup_steps,
            last_dt: h.last_dt,
        }
    }

    pub(crate) fn to_aos(&self) -> AbmHistory {
        AbmHistory {
            f_n: self.f_n.as_ref().map(|v| v.gather_to_aos()),
            f_n_minus_1: self.f_n_minus_1.as_ref().map(|v| v.gather_to_aos()),
            f_n_minus_2: self.f_n_minus_2.as_ref().map(|v| v.gather_to_aos()),
            startup_steps: self.startup_steps,
            last_dt: self.last_dt,
        }
    }

    #[allow(dead_code)]
    pub(crate) fn restart(&mut self) {
        *self = Self::new();
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

    /// Convert to SoA layout (allocating).
    pub fn to_soa(&self) -> ExchangeLlgStateSoA {
        ExchangeLlgStateSoA::from_aos(self)
    }

    /// Return a bit-preserving digest of the authoritative state, including
    /// FSAL, adaptive-controller memory, and ABM history. This is deliberately
    /// independent of serde field ordering and is suitable for rollback tests.
    pub fn transactional_state_digest(&self) -> String {
        let mut hasher = Sha256::new();
        hasher.update(b"fullmag.fdm.solver-state.v1\0");
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
}

impl AbmHistory {
    pub(crate) fn new() -> Self {
        Self {
            f_n: None,
            f_n_minus_1: None,
            f_n_minus_2: None,
            startup_steps: 0,
            last_dt: 0.0,
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

    /// Push a new RHS evaluation, rotating the history buffer.
    pub(crate) fn push(&mut self, f: Vec<Vector3>, dt: f64) {
        self.restart_if_dt_changed(dt);
        self.f_n_minus_2 = self.f_n_minus_1.take();
        self.f_n_minus_1 = self.f_n.take();
        self.f_n = Some(f);
        self.startup_steps = (self.startup_steps + 1).min(3);
        self.last_dt = dt;
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

    pub(crate) fn restart(&mut self) {
        *self = Self::new();
    }
}

// ── IntegratorBuffers ──────────────────────────────────────────────────

/// Maximum number of records for one adaptive outer-step transaction: up to
/// 50 rejected attempts followed by one accepted or terminal attempt.
pub const MAX_ADAPTIVE_ATTEMPT_RECORDS: usize = 51;

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

    pub(crate) fn begin_adaptive_step(&mut self) {
        self.adaptive_attempt_count = 0;
        self.adaptive_accepted_attempts = 0;
        self.adaptive_rejected_attempts = 0;
        #[cfg(test)]
        if let Some(seam) = &mut self.adaptive_test_seam {
            seam.attempt_dts.clear();
        }
    }

    pub(crate) fn adaptive_retry_budget_exhausted(&self) -> bool {
        self.adaptive_rejected_attempts >= 50
    }

    pub(crate) fn record_adaptive_attempt(&mut self, mut record: AdaptiveAttemptRecord) {
        if self.adaptive_attempt_count >= MAX_ADAPTIVE_ATTEMPT_RECORDS {
            return;
        }
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
