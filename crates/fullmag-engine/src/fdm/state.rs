//! Simulation state, integrator buffers, and solver session types.

use crate::vector::normalized;
use crate::{
    EngineError, EvaluationRequest, ExchangeLlgProblem, FftWorkspace, GridShape, Result, Vector3,
    VectorFieldSoA,
};

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
            abm_history: self.abm_history.to_aos(),
        }
    }

    /// Write SoA state back into an existing AoS state.
    pub fn write_back_to(&self, state: &mut ExchangeLlgState) {
        self.magnetization.gather_into_aos(&mut state.magnetization);
        state.time_seconds = self.time_seconds;
        state.k_fsal = self.k_fsal.as_ref().map(|k| k.gather_to_aos());
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
        // Check if dt has changed significantly — if so, restart.
        if self.last_dt > 0.0 && (dt - self.last_dt).abs() / self.last_dt > 0.1 {
            self.restart();
        }

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
            abm_history: AbmHistory::new(),
        })
    }

    pub fn uniform(grid: GridShape, value: Vector3) -> Result<Self> {
        Self::new(grid, vec![value; grid.cell_count()])
    }

    pub fn magnetization(&self) -> &[Vector3] {
        &self.magnetization
    }

    /// Invalidate the FSAL buffer (e.g. after external state modification).
    pub fn invalidate_fsal(&mut self) {
        self.k_fsal = None;
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

    /// Convert to SoA layout (allocating).
    pub fn to_soa(&self) -> ExchangeLlgStateSoA {
        ExchangeLlgStateSoA::from_aos(self)
    }
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
        // Check if dt has changed significantly — if so, restart.
        if self.last_dt > 0.0 && (dt - self.last_dt).abs() / self.last_dt > 0.1 {
            self.restart();
        }
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
        // Check if dt has changed significantly — if so, restart.
        if self.last_dt > 0.0 && (dt - self.last_dt).abs() / self.last_dt > 0.1 {
            self.restart();
        }

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

// ── StepReport ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq)]
#[allow(non_snake_case)]
pub struct StepReport {
    pub time_seconds: f64,
    pub dt_used: f64,
    pub step_rejected: bool,
    pub suggested_next_dt: Option<f64>,
    pub exchange_energy_joules: f64,
    pub demag_energy_joules: f64,
    pub external_energy_joules: f64,
    pub anisotropy_energy_joules: f64,
    pub dmi_energy_joules: f64,
    pub total_energy_joules: f64,
    pub max_effective_field_amplitude: f64,
    pub max_demag_field_amplitude: f64,
    pub max_rhs_amplitude: f64,
    pub max_torque_Apm: f64,
}

// ── EffectiveFieldObservables ──────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
#[allow(non_snake_case)]
pub struct EffectiveFieldObservables {
    pub magnetization: Vec<Vector3>,
    pub exchange_field: Vec<Vector3>,
    pub demag_field: Vec<Vector3>,
    pub external_field: Vec<Vector3>,
    pub effective_field: Vec<Vector3>,
    pub exchange_energy_joules: f64,
    pub demag_energy_joules: f64,
    pub external_energy_joules: f64,
    pub anisotropy_energy_joules: f64,
    pub dmi_energy_joules: f64,
    pub total_energy_joules: f64,
    pub max_effective_field_amplitude: f64,
    pub max_demag_field_amplitude: f64,
    pub max_rhs_amplitude: f64,
    pub max_torque_Apm: f64,
}

// ── RhsEvaluation ─────────────────────────────────────────────────────

/// Lightweight observables from a single RHS evaluation.
#[derive(Debug, Clone, PartialEq)]
#[allow(non_snake_case)]
pub struct RhsEvaluation {
    pub exchange_energy_joules: f64,
    pub demag_energy_joules: f64,
    pub external_energy_joules: f64,
    pub anisotropy_energy_joules: f64,
    pub dmi_energy_joules: f64,
    pub total_energy_joules: f64,
    pub max_effective_field_amplitude: f64,
    pub max_demag_field_amplitude: f64,
    pub max_rhs_amplitude: f64,
    pub max_torque_Apm: f64,
}

impl RhsEvaluation {
    /// Convert to a `StepReport`.
    pub fn into_step_report(
        self,
        time_seconds: f64,
        dt_used: f64,
        step_rejected: bool,
    ) -> StepReport {
        StepReport {
            time_seconds,
            dt_used,
            step_rejected,
            suggested_next_dt: None,
            exchange_energy_joules: self.exchange_energy_joules,
            demag_energy_joules: self.demag_energy_joules,
            external_energy_joules: self.external_energy_joules,
            anisotropy_energy_joules: self.anisotropy_energy_joules,
            dmi_energy_joules: self.dmi_energy_joules,
            total_energy_joules: self.total_energy_joules,
            max_effective_field_amplitude: self.max_effective_field_amplitude,
            max_demag_field_amplitude: self.max_demag_field_amplitude,
            max_rhs_amplitude: self.max_rhs_amplitude,
            max_torque_Apm: self.max_torque_Apm,
        }
    }
}

// ── IntegratorBuffers ──────────────────────────────────────────────────

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
        self.problem
            .observe_vectors_ws(self.state.magnetization(), &mut self.fft_ws)
    }
}
