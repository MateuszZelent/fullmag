//! ExchangeLlgProblem struct definition, constructors, and public API dispatch.

use crate::fdm_fft::zero_vectors;
use crate::{
    CellSize, EffectiveFieldObservables, EffectiveFieldTerms, EngineError, ExchangeLlgState,
    FdmBoundaryPolicy, FftWorkspace, GridShape, IntegratorBuffers, LlgConfig, MaterialParameters,
    Result, StepReport, TimeIntegrator, Vector3,
};
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug)]
pub struct ExchangeLlgProblem {
    pub grid: GridShape,
    pub cell_size: CellSize,
    pub material: MaterialParameters,
    pub dynamics: LlgConfig,
    pub terms: EffectiveFieldTerms,
    pub active_mask: Option<Vec<bool>>,
    /// Per-axis periodic / open boundary policy for exchange and DMI stencils.
    pub boundary_policy: FdmBoundaryPolicy,
    /// Per-axis image counts for truncated-images periodic demag.
    /// Only used when `boundary_policy` has periodic axes.
    pub demag_image_counts: [u32; 3],
    /// Temperature in Kelvin for Brown thermal field (sLLG). 0 = no thermal noise.
    pub temperature: f64,
    /// Current timestep used for thermal σ computation (set by runner before stepping).
    pub thermal_dt: f64,
    /// Global seed for counter-based thermal RNG (B7 reproducibility).
    /// Set once at problem construction; the combination
    /// `(thermal_seed, step_index, cell_index)` uniquely determines the
    /// thermal noise, regardless of thread count or decomposition.
    pub thermal_seed: u64,
    /// Monotonically increasing step counter for the thermal RNG.
    /// Incremented by each accepted step.
    thermal_step_counter: AtomicU64,
}

impl ExchangeLlgProblem {
    pub fn new(
        grid: GridShape,
        cell_size: CellSize,
        material: MaterialParameters,
        dynamics: LlgConfig,
    ) -> Self {
        Self::with_terms(
            grid,
            cell_size,
            material,
            dynamics,
            EffectiveFieldTerms::default(),
        )
    }

    pub fn with_terms(
        grid: GridShape,
        cell_size: CellSize,
        material: MaterialParameters,
        dynamics: LlgConfig,
        terms: EffectiveFieldTerms,
    ) -> Self {
        Self::with_terms_and_mask(grid, cell_size, material, dynamics, terms, None)
            .expect("unmasked problem construction should be infallible")
    }

    pub fn with_terms_and_mask(
        grid: GridShape,
        cell_size: CellSize,
        material: MaterialParameters,
        dynamics: LlgConfig,
        terms: EffectiveFieldTerms,
        active_mask: Option<Vec<bool>>,
    ) -> Result<Self> {
        if let Some(mask) = active_mask.as_ref() {
            if mask.len() != grid.cell_count() {
                return Err(EngineError::new(format!(
                    "active_mask length {} does not match grid cell count {}",
                    mask.len(),
                    grid.cell_count()
                )));
            }
        }
        Ok(Self {
            grid,
            cell_size,
            material,
            dynamics,
            terms,
            active_mask,
            boundary_policy: FdmBoundaryPolicy::default(),
            demag_image_counts: [10, 10, 10],
            temperature: 0.0,
            thermal_dt: 1e-13,
            thermal_seed: 42,
            thermal_step_counter: AtomicU64::new(0),
        })
    }

    pub fn new_state(&self, magnetization: Vec<Vector3>) -> Result<ExchangeLlgState> {
        let mut state = ExchangeLlgState::new(self.grid, magnetization)?;
        if let Some(mask) = self.active_mask.as_ref() {
            for (index, is_active) in mask.iter().enumerate() {
                if !is_active {
                    state.magnetization[index] = [0.0, 0.0, 0.0];
                }
            }
        }
        Ok(state)
    }

    pub fn uniform_state(&self, value: Vector3) -> Result<ExchangeLlgState> {
        ExchangeLlgState::uniform(self.grid, value)
    }

    /// Build a reusable FFT workspace matching this problem's grid.
    pub fn create_workspace(&self) -> FftWorkspace {
        if self.boundary_policy.has_any_periodic() {
            FftWorkspace::new_with_boundary(
                self.grid.nx,
                self.grid.ny,
                self.grid.nz,
                self.cell_size.dx,
                self.cell_size.dy,
                self.cell_size.dz,
                &self.boundary_policy,
                self.demag_image_counts,
            )
        } else {
            FftWorkspace::new(
                self.grid.nx,
                self.grid.ny,
                self.grid.nz,
                self.cell_size.dx,
                self.cell_size.dy,
                self.cell_size.dz,
            )
        }
    }

    pub fn exchange_field(&self, state: &ExchangeLlgState) -> Result<Vec<Vector3>> {
        self.ensure_state_matches_grid(state)?;
        Ok(if self.terms.exchange {
            self.exchange_field_from_vectors(state.magnetization())
        } else {
            zero_vectors(self.grid.cell_count())
        })
    }

    pub fn demag_field(&self, state: &ExchangeLlgState) -> Result<Vec<Vector3>> {
        self.ensure_state_matches_grid(state)?;
        Ok(if self.terms.demag {
            self.demag_field_from_vectors(state.magnetization())
        } else {
            zero_vectors(self.grid.cell_count())
        })
    }

    pub fn external_field(&self, state: &ExchangeLlgState) -> Result<Vec<Vector3>> {
        self.ensure_state_matches_grid(state)?;
        Ok(self.external_field_vectors())
    }

    pub fn effective_field(&self, state: &ExchangeLlgState) -> Result<Vec<Vector3>> {
        self.ensure_state_matches_grid(state)?;
        let mut ws = self.create_workspace();
        Ok(self.effective_field_from_vectors_ws(state.magnetization(), &mut ws))
    }

    pub fn llg_rhs(&self, state: &ExchangeLlgState) -> Result<Vec<Vector3>> {
        self.ensure_state_matches_grid(state)?;
        Ok(self.llg_rhs_from_vectors(state.magnetization()))
    }

    pub fn exchange_energy(&self, state: &ExchangeLlgState) -> Result<f64> {
        self.ensure_state_matches_grid(state)?;
        Ok(if self.terms.exchange {
            self.exchange_energy_from_vectors(state.magnetization())
        } else {
            0.0
        })
    }

    pub fn observe(&self, state: &ExchangeLlgState) -> Result<EffectiveFieldObservables> {
        self.ensure_state_matches_grid(state)?;
        Ok(self.observe_vectors(state.magnetization()))
    }

    /// Single step using a disposable FFT workspace.
    #[deprecated(
        since = "0.1.0",
        note = "creates a new FFT workspace per call; use step_with_workspace() instead"
    )]
    pub fn step(&self, state: &mut ExchangeLlgState, dt: f64) -> Result<StepReport> {
        let mut ws = self.create_workspace();
        self.step_with_workspace(state, dt, &mut ws)
    }

    /// Step with a pre-built FFT workspace (avoids re-planning per step).
    pub fn step_with_workspace(
        &self,
        state: &mut ExchangeLlgState,
        dt: f64,
        ws: &mut FftWorkspace,
    ) -> Result<StepReport> {
        self.ensure_state_matches_grid(state)?;
        if dt <= 0.0 {
            return Err(EngineError::new("dt must be positive"));
        }

        match self.dynamics.integrator {
            TimeIntegrator::Heun => self.heun_step(state, dt, ws),
            TimeIntegrator::RK4 => self.rk4_step(state, dt, ws),
            TimeIntegrator::RK23 => self.rk23_step(state, dt, ws),
            TimeIntegrator::RK45 => self.rk45_step(state, dt, ws),
            TimeIntegrator::ABM3 => self.abm3_step(state, dt, ws),
        }
    }

    /// Create preallocated integrator buffers sized for this problem's grid.
    pub fn create_integrator_buffers(&self) -> IntegratorBuffers {
        IntegratorBuffers::new(self.grid.cell_count())
    }

    /// Step with both a pre-built FFT workspace **and** preallocated integrator
    /// buffers.  This is the most efficient entry point.
    pub fn step_with_buffers(
        &self,
        state: &mut ExchangeLlgState,
        dt: f64,
        ws: &mut FftWorkspace,
        bufs: &mut IntegratorBuffers,
    ) -> Result<StepReport> {
        self.ensure_state_matches_grid(state)?;
        if dt <= 0.0 {
            return Err(EngineError::new("dt must be positive"));
        }

        let result = match self.dynamics.integrator {
            TimeIntegrator::Heun => self.heun_step_buf(state, dt, ws, bufs),
            TimeIntegrator::RK4 => self.rk4_step_buf(state, dt, ws, bufs),
            TimeIntegrator::RK23 => self.rk23_step_buf(state, dt, ws, bufs),
            TimeIntegrator::RK45 => self.rk45_step_buf(state, dt, ws, bufs),
            TimeIntegrator::ABM3 => self.abm3_step_buf(state, dt, ws, bufs),
        };
        // Advance thermal RNG counter after each step attempt
        self.advance_thermal_step();
        result
    }

    pub(crate) fn ensure_state_matches_grid(&self, state: &ExchangeLlgState) -> Result<()> {
        if state.grid != self.grid {
            return Err(EngineError::new(
                "state grid does not match the problem grid shape",
            ));
        }
        Ok(())
    }

    pub(crate) fn is_active(&self, flat_index: usize) -> bool {
        self.active_mask
            .as_ref()
            .map(|mask| mask[flat_index])
            .unwrap_or(true)
    }

    /// Read the current thermal step counter.
    pub fn thermal_step(&self) -> u64 {
        self.thermal_step_counter.load(Ordering::Relaxed)
    }

    /// Advance the thermal step counter by one (call after each accepted step).
    pub fn advance_thermal_step(&self) {
        self.thermal_step_counter.fetch_add(1, Ordering::Relaxed);
    }
}

impl Clone for ExchangeLlgProblem {
    fn clone(&self) -> Self {
        Self {
            grid: self.grid,
            cell_size: self.cell_size,
            material: self.material,
            dynamics: self.dynamics.clone(),
            terms: self.terms.clone(),
            active_mask: self.active_mask.clone(),
            boundary_policy: self.boundary_policy,
            demag_image_counts: self.demag_image_counts,
            temperature: self.temperature,
            thermal_dt: self.thermal_dt,
            thermal_seed: self.thermal_seed,
            thermal_step_counter: AtomicU64::new(self.thermal_step_counter.load(Ordering::Relaxed)),
        }
    }
}

impl PartialEq for ExchangeLlgProblem {
    fn eq(&self, other: &Self) -> bool {
        self.grid == other.grid
            && self.cell_size == other.cell_size
            && self.material == other.material
            && self.dynamics == other.dynamics
            && self.terms == other.terms
            && self.active_mask == other.active_mask
            && self.temperature == other.temperature
            && self.thermal_dt == other.thermal_dt
            && self.thermal_seed == other.thermal_seed
    }
}
