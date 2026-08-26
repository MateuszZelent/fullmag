//! ExchangeLlgProblem struct definition, constructors, and public API dispatch.

use crate::{
    CellSize, EffectiveFieldObservables, EffectiveFieldTerms, EngineError, EngineErrorCode,
    EvaluationRequest, ExchangeLlgState, ExchangeLlgStateSoA, FdmBoundaryPolicy, FdmDemagBoundary,
    FftWorkspace, FrozenSpinsState, GridShape, IntegratorBuffers, LlgConfig, MaterialParameters,
    RegionalFieldDriveTerm, ResolvedFdmPeriodicWorkspace, Result, StepReport, TimeIntegrator,
    Vector3,
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
    /// Captured hard constraint for the active execution stage.
    pub frozen_spins: Option<FrozenSpinsState>,
    /// Per-axis periodic / open boundary policy for exchange and DMI stencils.
    pub boundary_policy: FdmBoundaryPolicy,
    /// Resolved demagnetization boundary realization.  Runtime construction
    /// must consume this value rather than infer demag semantics from local
    /// periodic stencil flags.
    pub demag_boundary: FdmDemagBoundary,
    /// Per-axis image counts for truncated-images periodic demag.
    /// Only used when `boundary_policy` has periodic axes.
    pub demag_image_counts: [u32; 3],
    /// Planner-resolved periodic workspace contract consumed by CPU FFT
    /// allocation. A mismatch is rejected before allocating buffers.
    pub resolved_periodic_workspace: Option<ResolvedFdmPeriodicWorkspace>,
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
    pub ms_field: Option<Vec<f64>>,
    pub a_field: Option<Vec<f64>>,
    pub alpha_field: Option<Vec<f64>>,
    /// Canonical regional field drives, separate from legacy per-node fields.
    pub regional_field_drives: Vec<RegionalFieldDriveTerm>,
    /// Resolved static external H_ext profile [A/m], kept separate from the
    /// legacy Oersted/antenna per-node buffer for observable provenance.
    pub static_external_field: Option<Vec<Vector3>>,
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
        if let Some(sot) = terms.sot.as_ref() {
            if let Some(mask) = sot.active_mask.as_ref() {
                if mask.len() != grid.cell_count() {
                    return Err(EngineError::new(format!(
                        "prescribed SOT active_mask length {} does not match grid cell count {}",
                        mask.len(),
                        grid.cell_count()
                    )));
                }
            }
            if sot.envelope.as_ref().is_some_and(|envelope| {
                !matches!(envelope, fullmag_ir::TimeEnvelopeIR::Constant { .. })
            }) {
                return Err(EngineError::new(
                    "prescribed SOT non-constant envelope requires_stage_time_execution",
                ));
            }
        }
        if let Some(slonczewski) = terms.slonczewski_stt.as_ref() {
            if let Some(mask) = slonczewski.active_mask.as_ref() {
                if mask.len() != grid.cell_count() {
                    return Err(EngineError::new(format!(
                        "Slonczewski active_mask length {} does not match grid cell count {}",
                        mask.len(),
                        grid.cell_count()
                    )));
                }
            }
        }
        Ok(Self {
            grid,
            cell_size,
            material,
            dynamics,
            terms,
            active_mask,
            frozen_spins: None,
            boundary_policy: FdmBoundaryPolicy::default(),
            demag_boundary: FdmDemagBoundary::Open,
            demag_image_counts: [10, 10, 10],
            resolved_periodic_workspace: None,
            temperature: 0.0,
            thermal_dt: 1e-13,
            thermal_seed: 42,
            thermal_step_counter: AtomicU64::new(0),
            ms_field: None,
            a_field: None,
            alpha_field: None,
            regional_field_drives: Vec::new(),
            static_external_field: None,
        })
    }

    pub fn regional_drive_field_at_time(&self, evaluation_time_s: f64) -> Vec<Vector3> {
        let mut field = vec![[0.0; 3]; self.grid.cell_count()];
        for drive in self
            .regional_field_drives
            .iter()
            .filter(|drive| drive.enabled)
        {
            let multiplier = drive.multiplier_at(evaluation_time_s);
            for (total, basis) in field.iter_mut().zip(&drive.basis_field) {
                total[0] += multiplier * basis[0];
                total[1] += multiplier * basis[1];
                total[2] += multiplier * basis[2];
            }
        }
        field
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

    pub fn capture_frozen_spins_at_activation(
        &mut self,
        plan: &fullmag_ir::ResolvedFrozenSpinsPlanIR,
        state: &mut ExchangeLlgState,
    ) -> Result<()> {
        self.ensure_state_matches_grid(state)?;
        let frozen_spins = FrozenSpinsState::capture_at_activation(
            plan,
            self.active_mask.as_deref(),
            state.magnetization(),
        )?;
        if self
            .frozen_spins
            .as_ref()
            .is_none_or(|current| !current.same_mask(&frozen_spins))
        {
            state.invalidate_fsal();
            state.reset_abm_history();
        }
        self.frozen_spins = Some(frozen_spins);
        Ok(())
    }

    pub fn frozen_spins(&self) -> Option<&FrozenSpinsState> {
        self.frozen_spins.as_ref()
    }

    /// Install a constraint restored from a durable checkpoint without
    /// re-evaluating the authored selector. The caller must validate the
    /// checkpoint against the resolved plan before passing the state here.
    pub fn restore_frozen_spins_checkpoint(
        &mut self,
        frozen_spins: FrozenSpinsState,
        state: &mut ExchangeLlgState,
    ) -> Result<()> {
        self.ensure_state_matches_grid(state)?;
        if frozen_spins.len() != self.grid.cell_count() {
            return Err(EngineError::new(
                "frozen_spins_checkpoint_grid_size_mismatch",
            ));
        }
        if let Some(active_mask) = self.active_mask.as_deref() {
            if let Some(index) = frozen_spins
                .mask()
                .iter()
                .zip(active_mask)
                .position(|(frozen, active)| *frozen && !*active)
            {
                return Err(EngineError::new(format!(
                    "frozen_spins_checkpoint_outside_active_domain: index {index}"
                )));
            }
        }
        frozen_spins.restore_reference(state.magnetization_mut());
        state.invalidate_fsal();
        state.reset_abm_history();
        self.frozen_spins = Some(frozen_spins);
        Ok(())
    }

    pub(crate) fn restore_frozen_reference(&self, candidate: &mut [Vector3]) {
        if let Some(frozen) = &self.frozen_spins {
            frozen.restore_reference(candidate);
        }
    }

    /// Build a reusable FFT workspace matching this problem's grid.
    pub fn create_workspace(&self) -> FftWorkspace {
        if self.boundary_policy.has_any_periodic()
            && matches!(
                self.demag_boundary,
                FdmDemagBoundary::PeriodicTruncatedImages { .. }
            )
        {
            let FdmDemagBoundary::PeriodicTruncatedImages { image_counts } = self.demag_boundary
            else {
                unreachable!()
            };
            if let Some(resolved) = self.resolved_periodic_workspace.as_ref() {
                FftWorkspace::try_new_with_boundary_and_resolution(
                    self.grid.nx,
                    self.grid.ny,
                    self.grid.nz,
                    self.cell_size.dx,
                    self.cell_size.dy,
                    self.cell_size.dz,
                    &self.boundary_policy,
                    image_counts,
                    resolved,
                )
                .unwrap_or_else(|reason| {
                    panic!("FDM periodic FFT workspace contract rejected: {reason}")
                })
            } else {
                FftWorkspace::new_with_boundary(
                    self.grid.nx,
                    self.grid.ny,
                    self.grid.nz,
                    self.cell_size.dx,
                    self.cell_size.dy,
                    self.cell_size.dz,
                    &self.boundary_policy,
                    image_counts,
                )
            }
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

    pub fn set_resolved_periodic_workspace(
        &mut self,
        resolved: Option<ResolvedFdmPeriodicWorkspace>,
    ) {
        self.resolved_periodic_workspace = resolved;
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

    /// Full-domain stray field for observability. Unlike [`Self::demag_field`],
    /// this preserves values in inactive FDM cells while leaving the solver
    /// field and its active-cell mask unchanged.
    pub fn observable_demag_field(&self, state: &ExchangeLlgState) -> Result<Vec<Vector3>> {
        self.ensure_state_matches_grid(state)?;
        Ok(if self.terms.demag {
            self.observable_demag_field_from_vectors(state.magnetization())
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
        Ok(self.effective_field_from_vectors_ws_at_time(
            state.magnetization(),
            &mut ws,
            state.time_seconds,
        ))
    }

    pub fn observable_effective_field(&self, state: &ExchangeLlgState) -> Result<Vec<Vector3>> {
        self.ensure_state_matches_grid(state)?;
        let mut ws = self.create_workspace();
        Ok(self.observable_effective_field_from_vectors_ws_at_time(
            state.magnetization(),
            &mut ws,
            state.time_seconds,
        ))
    }

    pub fn dmi_field(&self, state: &ExchangeLlgState) -> Result<Vec<Vector3>> {
        self.ensure_state_matches_grid(state)?;
        let interfacial = self.interfacial_dmi_field(state.magnetization());
        let bulk = self.bulk_dmi_field(state.magnetization());
        Ok(interfacial
            .iter()
            .zip(bulk.iter())
            .map(|(interfacial, bulk)| crate::add(*interfacial, *bulk))
            .collect())
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

    pub fn exchange_energy_density(&self, state: &ExchangeLlgState) -> Result<Vec<f64>> {
        self.ensure_state_matches_grid(state)?;
        if !self.terms.exchange {
            return Ok(vec![0.0; self.grid.cell_count()]);
        }
        let field = self.exchange_field_from_vectors(state.magnetization());
        Ok(self.exchange_energy_density_from_field(state.magnetization(), &field))
    }

    pub fn demag_energy_density(&self, state: &ExchangeLlgState) -> Result<Vec<f64>> {
        self.ensure_state_matches_grid(state)?;
        if !self.terms.demag {
            return Ok(vec![0.0; self.grid.cell_count()]);
        }
        let mut ws = self.create_workspace();
        let field = self.demag_field_from_vectors_ws(state.magnetization(), &mut ws);
        Ok(self.demag_energy_density_from_fields(state.magnetization(), &field))
    }

    pub fn external_energy_density(&self, state: &ExchangeLlgState) -> Result<Vec<f64>> {
        self.ensure_state_matches_grid(state)?;
        if !self.has_external_zeeman_source() {
            return Ok(vec![0.0; self.grid.cell_count()]);
        }
        let field = self.external_zeeman_field_vectors();
        Ok(self.external_energy_density_from_fields(state.magnetization(), &field))
    }

    pub fn anisotropy_energy_density(&self, state: &ExchangeLlgState) -> Result<Vec<f64>> {
        self.ensure_state_matches_grid(state)?;
        Ok(self.anisotropy_energy_density_from_vectors(state.magnetization()))
    }

    pub fn dmi_energy_density(&self, state: &ExchangeLlgState) -> Result<Vec<f64>> {
        self.ensure_state_matches_grid(state)?;
        Ok(self.dmi_energy_density_from_vectors(state.magnetization()))
    }

    pub fn total_energy_density(&self, state: &ExchangeLlgState) -> Result<Vec<f64>> {
        self.ensure_state_matches_grid(state)?;
        let mut total = vec![0.0; self.grid.cell_count()];
        for density in [
            self.exchange_energy_density(state)?,
            self.demag_energy_density(state)?,
            self.external_energy_density(state)?,
            self.anisotropy_energy_density(state)?,
            self.dmi_energy_density(state)?,
        ] {
            for (accum, value) in total.iter_mut().zip(density) {
                *accum += value;
            }
        }
        Ok(total)
    }

    pub fn observe(&self, state: &ExchangeLlgState) -> Result<EffectiveFieldObservables> {
        self.ensure_state_matches_grid(state)?;
        let mut ws = self.create_workspace();
        Ok(self.observe_vectors_ws_at_time(state.magnetization(), &mut ws, state.time_seconds))
    }

    /// Single step using a disposable FFT workspace.
    #[deprecated(
        since = "0.1.0",
        note = "creates workspaces per call; use step_with_buffers() or SolverSession for repeated stepping"
    )]
    pub fn step(&self, state: &mut ExchangeLlgState, dt: f64) -> Result<StepReport> {
        let mut ws = self.create_workspace();
        self.step_with_workspace(state, dt, &mut ws)
    }

    /// Step with a pre-built FFT workspace.
    ///
    /// This allocates temporary integrator buffers per call. Use
    /// [`Self::step_with_buffers`] for repeated stepping.
    pub fn step_with_workspace(
        &self,
        state: &mut ExchangeLlgState,
        dt: f64,
        ws: &mut FftWorkspace,
    ) -> Result<StepReport> {
        let mut bufs = self.create_integrator_buffers();
        self.step_with_buffers(state, dt, ws, &mut bufs)
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
        self.step_with_buffers_evaluation(state, dt, ws, bufs, EvaluationRequest::Full)
    }

    /// Step with both a pre-built FFT workspace and preallocated integrator
    /// buffers, choosing how much step-end telemetry to compute.
    pub fn step_with_buffers_evaluation(
        &self,
        state: &mut ExchangeLlgState,
        dt: f64,
        ws: &mut FftWorkspace,
        bufs: &mut IntegratorBuffers,
        evaluation: EvaluationRequest,
    ) -> Result<StepReport> {
        self.ensure_state_matches_grid(state)?;
        if !dt.is_finite() || dt <= 0.0 {
            return Err(EngineError::with_code(
                EngineErrorCode::InvalidTimestep,
                "dt must be finite and positive",
            ));
        }
        bufs.begin_adaptive_step();

        let result = match self.dynamics.integrator {
            TimeIntegrator::Heun if self.soa_fast_path_supported() => {
                self.heun_step_soa_buf(state, dt, ws, bufs, evaluation)
            }
            TimeIntegrator::Heun => self.heun_step_buf(state, dt, ws, bufs, evaluation),
            TimeIntegrator::RK4 if self.soa_fast_path_supported() => {
                self.rk4_step_soa_buf(state, dt, ws, bufs, evaluation)
            }
            TimeIntegrator::RK4 => self.rk4_step_buf(state, dt, ws, bufs, evaluation),
            TimeIntegrator::RK23 if self.soa_fast_path_supported() => {
                self.rk23_step_soa_buf(state, dt, ws, bufs, evaluation)
            }
            TimeIntegrator::RK23 => self.rk23_step_buf(state, dt, ws, bufs, evaluation),
            TimeIntegrator::RK45 if self.soa_fast_path_supported() => {
                self.rk45_step_soa_buf(state, dt, ws, bufs, evaluation)
            }
            TimeIntegrator::RK45 => self.rk45_step_buf(state, dt, ws, bufs, evaluation),
            TimeIntegrator::ABM3 if self.soa_fast_path_supported() => {
                self.abm3_step_soa_buf(state, dt, ws, bufs, evaluation)
            }
            TimeIntegrator::ABM3 => self.abm3_step_buf(state, dt, ws, bufs, evaluation),
        };
        if result.is_ok() {
            self.restore_frozen_reference(&mut state.magnetization);
            self.advance_thermal_step();
        }
        result
    }

    /// Step a persistent SoA state with a pre-built FFT workspace and
    /// preallocated integrator buffers.
    ///
    /// This entry point is intentionally limited to the supported CPU SoA
    /// fast-path terms; unsupported problems should continue through the
    /// AoS-compatible API until their SoA field/RHS implementations exist.
    pub fn step_soa_with_buffers_evaluation(
        &self,
        state: &mut ExchangeLlgStateSoA,
        dt: f64,
        ws: &mut FftWorkspace,
        bufs: &mut IntegratorBuffers,
        evaluation: EvaluationRequest,
    ) -> Result<StepReport> {
        self.ensure_soa_state_matches_grid(state)?;
        if !dt.is_finite() || dt <= 0.0 {
            return Err(EngineError::with_code(
                EngineErrorCode::InvalidTimestep,
                "dt must be finite and positive",
            ));
        }
        if !self.soa_fast_path_supported() {
            let reason = self
                .soa_fast_path_rejection_reason()
                .unwrap_or("capability_matrix_rejected");
            return Err(EngineError::with_code(
                EngineErrorCode::CapabilityUnavailable,
                format!("CPU SoA fast path unavailable: {reason}"),
            ));
        }
        bufs.begin_adaptive_step();

        let result = match self.dynamics.integrator {
            TimeIntegrator::Heun => self.heun_step_soa_state_buf(state, dt, ws, bufs, evaluation),
            TimeIntegrator::RK4 => self.rk4_step_soa_state_buf(state, dt, ws, bufs, evaluation),
            TimeIntegrator::RK23 => self.rk23_step_soa_state_buf(state, dt, ws, bufs, evaluation),
            TimeIntegrator::RK45 => self.rk45_step_soa_state_buf(state, dt, ws, bufs, evaluation),
            TimeIntegrator::ABM3 => self.abm3_step_soa_state_buf(state, dt, ws, bufs, evaluation),
        };
        if result.is_ok() {
            self.advance_thermal_step();
        }
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

    pub(crate) fn ensure_soa_state_matches_grid(&self, state: &ExchangeLlgStateSoA) -> Result<()> {
        if state.grid != self.grid || state.cell_count() != self.grid.cell_count() {
            return Err(EngineError::new(
                "SoA state grid does not match the problem grid shape",
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

    /// Restore the accepted counter-based thermal RNG position from an exact
    /// compatible checkpoint before resuming execution.
    pub fn restore_thermal_step(&self, step: u64) {
        self.thermal_step_counter.store(step, Ordering::Relaxed);
    }

    /// Advance the thermal step counter by one (call after each accepted step).
    pub fn advance_thermal_step(&self) {
        self.thermal_step_counter.fetch_add(1, Ordering::Relaxed);
    }

    pub fn with_spatial_fields(
        mut self,
        ms_field: Option<Vec<f64>>,
        a_field: Option<Vec<f64>>,
        alpha_field: Option<Vec<f64>>,
    ) -> Result<Self> {
        let n = self.grid.cell_count();
        if let Some(ref field) = ms_field {
            if field.len() != n {
                return Err(EngineError::new(format!(
                    "ms_field length {} does not match grid cell count {}",
                    field.len(),
                    n
                )));
            }
            if field.iter().any(|&v| !v.is_finite() || v <= 0.0) {
                return Err(EngineError::new(
                    "ms_field contains non-finite or non-positive values".to_string(),
                ));
            }
        }
        if let Some(ref field) = a_field {
            if field.len() != n {
                return Err(EngineError::new(format!(
                    "a_field length {} does not match grid cell count {}",
                    field.len(),
                    n
                )));
            }
            if field.iter().any(|&v| !v.is_finite() || v < 0.0) {
                return Err(EngineError::new(
                    "a_field contains non-finite or negative values".to_string(),
                ));
            }
        }
        if let Some(ref field) = alpha_field {
            if field.len() != n {
                return Err(EngineError::new(format!(
                    "alpha_field length {} does not match grid cell count {}",
                    field.len(),
                    n
                )));
            }
            if field.iter().any(|&v| !v.is_finite() || v < 0.0) {
                return Err(EngineError::new(
                    "alpha_field contains non-finite or negative values".to_string(),
                ));
            }
        }
        self.ms_field = ms_field;
        self.a_field = a_field;
        self.alpha_field = alpha_field;
        Ok(self)
    }

    pub fn with_static_external_field(
        mut self,
        static_external_field: Option<Vec<Vector3>>,
    ) -> Result<Self> {
        if let Some(field) = static_external_field.as_ref() {
            if field.len() != self.grid.cell_count() {
                return Err(EngineError::new(format!(
                    "static external field length {} does not match grid cell count {}",
                    field.len(),
                    self.grid.cell_count()
                )));
            }
            if field
                .iter()
                .any(|value| value.iter().any(|component| !component.is_finite()))
            {
                return Err(EngineError::new(
                    "static external field contains non-finite values",
                ));
            }
        }
        self.static_external_field = static_external_field;
        Ok(self)
    }

    pub fn ms_at(&self, i: usize) -> f64 {
        self.ms_field
            .as_ref()
            .map(|values| values[i])
            .unwrap_or(self.material.saturation_magnetisation)
    }

    pub fn a_at(&self, i: usize) -> f64 {
        self.a_field
            .as_ref()
            .map(|values| values[i])
            .unwrap_or(self.material.exchange_stiffness)
    }

    pub fn alpha_at(&self, i: usize) -> f64 {
        self.alpha_field
            .as_ref()
            .map(|values| values[i])
            .unwrap_or(self.material.damping)
    }

    pub fn set_demag_boundary(&mut self, boundary: FdmDemagBoundary) {
        self.demag_boundary = boundary;
    }
}

fn zero_vectors(len: usize) -> Vec<Vector3> {
    vec![[0.0; 3]; len]
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
            frozen_spins: self.frozen_spins.clone(),
            boundary_policy: self.boundary_policy,
            demag_boundary: self.demag_boundary,
            demag_image_counts: self.demag_image_counts,
            resolved_periodic_workspace: self.resolved_periodic_workspace,
            temperature: self.temperature,
            thermal_dt: self.thermal_dt,
            thermal_seed: self.thermal_seed,
            thermal_step_counter: AtomicU64::new(self.thermal_step_counter.load(Ordering::Relaxed)),
            ms_field: self.ms_field.clone(),
            a_field: self.a_field.clone(),
            alpha_field: self.alpha_field.clone(),
            regional_field_drives: self.regional_field_drives.clone(),
            static_external_field: self.static_external_field.clone(),
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
            && self.frozen_spins == other.frozen_spins
            && self.boundary_policy == other.boundary_policy
            && self.demag_boundary == other.demag_boundary
            && self.temperature == other.temperature
            && self.thermal_dt == other.thermal_dt
            && self.thermal_seed == other.thermal_seed
            && self.ms_field == other.ms_field
            && self.a_field == other.a_field
            && self.alpha_field == other.alpha_field
            && self.regional_field_drives == other.regional_field_drives
            && self.static_external_field == other.static_external_field
    }
}
