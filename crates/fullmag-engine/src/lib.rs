pub mod fem;
pub mod newell;
pub mod studies;

use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};
use std::error::Error;
use std::f64::consts::PI;
use std::fmt;
use std::sync::Arc;

#[cfg(feature = "parallel")]
use rayon::prelude::*;

pub const MU0: f64 = 4.0 * PI * 1e-7;
pub const DEFAULT_GYROMAGNETIC_RATIO: f64 = 2.211e5;

pub type Vector3 = [f64; 3];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineError {
    message: String,
}

impl EngineError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl Error for EngineError {}

type Result<T> = std::result::Result<T, EngineError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GridShape {
    pub nx: usize,
    pub ny: usize,
    pub nz: usize,
}

impl GridShape {
    pub fn new(nx: usize, ny: usize, nz: usize) -> Result<Self> {
        if nx == 0 || ny == 0 || nz == 0 {
            return Err(EngineError::new("grid shape components must be >= 1"));
        }
        Ok(Self { nx, ny, nz })
    }

    pub fn cell_count(self) -> usize {
        self.nx * self.ny * self.nz
    }

    fn index(self, x: usize, y: usize, z: usize) -> usize {
        x + self.nx * (y + self.ny * z)
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CellSize {
    pub dx: f64,
    pub dy: f64,
    pub dz: f64,
}

impl CellSize {
    pub fn new(dx: f64, dy: f64, dz: f64) -> Result<Self> {
        for (name, value) in [("dx", dx), ("dy", dy), ("dz", dz)] {
            if value <= 0.0 {
                return Err(EngineError::new(format!("{name} must be positive")));
            }
        }
        Ok(Self { dx, dy, dz })
    }

    pub fn volume(self) -> f64 {
        self.dx * self.dy * self.dz
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MaterialParameters {
    pub saturation_magnetisation: f64,
    pub exchange_stiffness: f64,
    pub damping: f64,
}

impl MaterialParameters {
    pub fn new(
        saturation_magnetisation: f64,
        exchange_stiffness: f64,
        damping: f64,
    ) -> Result<Self> {
        if saturation_magnetisation <= 0.0 {
            return Err(EngineError::new(
                "saturation_magnetisation must be positive",
            ));
        }
        if exchange_stiffness <= 0.0 {
            return Err(EngineError::new("exchange_stiffness must be positive"));
        }
        if damping < 0.0 {
            return Err(EngineError::new("damping must be >= 0"));
        }
        Ok(Self {
            saturation_magnetisation,
            exchange_stiffness,
            damping,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimeIntegrator {
    Heun,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LlgConfig {
    pub gyromagnetic_ratio: f64,
    pub integrator: TimeIntegrator,
}

impl Default for LlgConfig {
    fn default() -> Self {
        Self {
            gyromagnetic_ratio: DEFAULT_GYROMAGNETIC_RATIO,
            integrator: TimeIntegrator::Heun,
        }
    }
}

impl LlgConfig {
    pub fn new(gyromagnetic_ratio: f64, integrator: TimeIntegrator) -> Result<Self> {
        if gyromagnetic_ratio <= 0.0 {
            return Err(EngineError::new("gyromagnetic_ratio must be positive"));
        }
        Ok(Self {
            gyromagnetic_ratio,
            integrator,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EffectiveFieldTerms {
    pub exchange: bool,
    pub demag: bool,
    pub external_field: Option<Vector3>,
}

impl Default for EffectiveFieldTerms {
    fn default() -> Self {
        Self {
            exchange: true,
            demag: false,
            external_field: None,
        }
    }
}

/// Cached FFT plans and scratch buffers for spectral demag.
///
/// Build once per grid via [`ExchangeLlgProblem::create_workspace`] and pass
/// into [`ExchangeLlgProblem::step`].  This avoids rebuilding `FftPlanner`
/// and re-planning every call to `demag_field_from_vectors`.
pub struct FftWorkspace {
    fwd_x: Arc<dyn Fft<f64>>,
    fwd_y: Arc<dyn Fft<f64>>,
    fwd_z: Arc<dyn Fft<f64>>,
    inv_x: Arc<dyn Fft<f64>>,
    inv_y: Arc<dyn Fft<f64>>,
    inv_z: Arc<dyn Fft<f64>>,
    /// Padded grid dimensions (2×N per axis).
    pub px: usize,
    pub py: usize,
    pub pz: usize,
    /// Re-usable scratch line buffers.
    line_y: Vec<Complex<f64>>,
    line_z: Vec<Complex<f64>>,
    /// Re-usable padded frequency-domain buffers (avoids allocation per demag call).
    buf_mx: Vec<Complex<f64>>,
    buf_my: Vec<Complex<f64>>,
    buf_mz: Vec<Complex<f64>>,
    buf_hx: Vec<Complex<f64>>,
    buf_hy: Vec<Complex<f64>>,
    buf_hz: Vec<Complex<f64>>,
    /// Precomputed Newell kernel spectra (FFT of real-space demagnetization tensors).
    kern_xx: Vec<Complex<f64>>,
    kern_yy: Vec<Complex<f64>>,
    kern_zz: Vec<Complex<f64>>,
    kern_xy: Vec<Complex<f64>>,
    kern_xz: Vec<Complex<f64>>,
    kern_yz: Vec<Complex<f64>>,
}

#[derive(Debug, Clone)]
pub struct DemagKernelSpectra {
    pub px: usize,
    pub py: usize,
    pub pz: usize,
    /// Interleaved complex spectra: [re0, im0, re1, im1, ...]
    pub n_xx: Vec<f64>,
    pub n_yy: Vec<f64>,
    pub n_zz: Vec<f64>,
    pub n_xy: Vec<f64>,
    pub n_xz: Vec<f64>,
    pub n_yz: Vec<f64>,
}

impl FftWorkspace {
    pub fn new(nx: usize, ny: usize, nz: usize, dx: f64, dy: f64, dz: f64) -> Self {
        let px = nx * 2;
        let py = ny * 2;
        let pz = nz * 2;
        let padded_len = px * py * pz;
        let mut planner = FftPlanner::<f64>::new();
        let zero = Complex::new(0.0, 0.0);

        let fwd_x = planner.plan_fft_forward(px);
        let fwd_y = planner.plan_fft_forward(py);
        let fwd_z = planner.plan_fft_forward(pz);

        // Precompute Newell kernels in real space, then FFT each component.
        let nk = newell::compute_newell_kernels(nx, ny, nz, dx, dy, dz);

        let fft_kernel = |real: Vec<f64>| -> Vec<Complex<f64>> {
            let mut buf: Vec<Complex<f64>> =
                real.into_iter().map(|v| Complex::new(v, 0.0)).collect();
            // 3D FFT: x then y then z, same as fft3_m_forward
            let mut line_y_tmp = vec![zero; py];
            let mut line_z_tmp = vec![zero; pz];
            fft3_core(
                &mut buf,
                px,
                py,
                pz,
                &*fwd_x,
                &*fwd_y,
                &*fwd_z,
                &mut line_y_tmp,
                &mut line_z_tmp,
            );
            buf
        };

        let kern_xx = fft_kernel(nk.n_xx);
        let kern_yy = fft_kernel(nk.n_yy);
        let kern_zz = fft_kernel(nk.n_zz);
        let kern_xy = fft_kernel(nk.n_xy);
        let kern_xz = fft_kernel(nk.n_xz);
        let kern_yz = fft_kernel(nk.n_yz);

        Self {
            fwd_x,
            fwd_y: planner.plan_fft_forward(py),
            fwd_z: planner.plan_fft_forward(pz),
            inv_x: planner.plan_fft_inverse(px),
            inv_y: planner.plan_fft_inverse(py),
            inv_z: planner.plan_fft_inverse(pz),
            px,
            py,
            pz,
            line_y: vec![zero; py],
            line_z: vec![zero; pz],
            buf_mx: vec![zero; padded_len],
            buf_my: vec![zero; padded_len],
            buf_mz: vec![zero; padded_len],
            buf_hx: vec![zero; padded_len],
            buf_hy: vec![zero; padded_len],
            buf_hz: vec![zero; padded_len],
            kern_xx,
            kern_yy,
            kern_zz,
            kern_xy,
            kern_xz,
            kern_yz,
        }
    }

    /// Zero out all six M/H frequency-domain buffers.
    fn clear_bufs(&mut self) {
        let zero = Complex::new(0.0, 0.0);
        for v in self
            .buf_mx
            .iter_mut()
            .chain(self.buf_my.iter_mut())
            .chain(self.buf_mz.iter_mut())
            .chain(self.buf_hx.iter_mut())
            .chain(self.buf_hy.iter_mut())
            .chain(self.buf_hz.iter_mut())
        {
            *v = zero;
        }
    }

    /// Forward FFT on the three M-component buffers (buf_mx, buf_my, buf_mz).
    fn fft3_m_forward(&mut self) {
        fft3_core(
            &mut self.buf_mx,
            self.px,
            self.py,
            self.pz,
            &*self.fwd_x,
            &*self.fwd_y,
            &*self.fwd_z,
            &mut self.line_y,
            &mut self.line_z,
        );
        fft3_core(
            &mut self.buf_my,
            self.px,
            self.py,
            self.pz,
            &*self.fwd_x,
            &*self.fwd_y,
            &*self.fwd_z,
            &mut self.line_y,
            &mut self.line_z,
        );
        fft3_core(
            &mut self.buf_mz,
            self.px,
            self.py,
            self.pz,
            &*self.fwd_x,
            &*self.fwd_y,
            &*self.fwd_z,
            &mut self.line_y,
            &mut self.line_z,
        );
    }

    /// Inverse FFT on the three H-component buffers (buf_hx, buf_hy, buf_hz).
    fn fft3_h_inverse(&mut self) {
        fft3_core(
            &mut self.buf_hx,
            self.px,
            self.py,
            self.pz,
            &*self.inv_x,
            &*self.inv_y,
            &*self.inv_z,
            &mut self.line_y,
            &mut self.line_z,
        );
        fft3_core(
            &mut self.buf_hy,
            self.px,
            self.py,
            self.pz,
            &*self.inv_x,
            &*self.inv_y,
            &*self.inv_z,
            &mut self.line_y,
            &mut self.line_z,
        );
        fft3_core(
            &mut self.buf_hz,
            self.px,
            self.py,
            self.pz,
            &*self.inv_x,
            &*self.inv_y,
            &*self.inv_z,
            &mut self.line_y,
            &mut self.line_z,
        );
    }
}

pub fn compute_newell_kernel_spectra(
    nx: usize,
    ny: usize,
    nz: usize,
    dx: f64,
    dy: f64,
    dz: f64,
) -> DemagKernelSpectra {
    let workspace = FftWorkspace::new(nx, ny, nz, dx, dy, dz);
    let flatten = |values: &[Complex<f64>]| -> Vec<f64> {
        let mut flat = Vec::with_capacity(values.len() * 2);
        for value in values {
            flat.push(value.re);
            flat.push(value.im);
        }
        flat
    };

    DemagKernelSpectra {
        px: workspace.px,
        py: workspace.py,
        pz: workspace.pz,
        n_xx: flatten(&workspace.kern_xx),
        n_yy: flatten(&workspace.kern_yy),
        n_zz: flatten(&workspace.kern_zz),
        n_xy: flatten(&workspace.kern_xy),
        n_xz: flatten(&workspace.kern_xz),
        n_yz: flatten(&workspace.kern_yz),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExchangeLlgState {
    grid: GridShape,
    magnetization: Vec<Vector3>,
    pub time_seconds: f64,
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
        })
    }

    pub fn uniform(grid: GridShape, value: Vector3) -> Result<Self> {
        Self::new(grid, vec![value; grid.cell_count()])
    }

    pub fn magnetization(&self) -> &[Vector3] {
        &self.magnetization
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StepReport {
    pub time_seconds: f64,
    pub exchange_energy_joules: f64,
    pub demag_energy_joules: f64,
    pub external_energy_joules: f64,
    pub total_energy_joules: f64,
    pub max_effective_field_amplitude: f64,
    pub max_demag_field_amplitude: f64,
    pub max_rhs_amplitude: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EffectiveFieldObservables {
    pub magnetization: Vec<Vector3>,
    pub exchange_field: Vec<Vector3>,
    pub demag_field: Vec<Vector3>,
    pub external_field: Vec<Vector3>,
    pub effective_field: Vec<Vector3>,
    pub exchange_energy_joules: f64,
    pub demag_energy_joules: f64,
    pub external_energy_joules: f64,
    pub total_energy_joules: f64,
    pub max_effective_field_amplitude: f64,
    pub max_demag_field_amplitude: f64,
    pub max_rhs_amplitude: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExchangeLlgProblem {
    pub grid: GridShape,
    pub cell_size: CellSize,
    pub material: MaterialParameters,
    pub dynamics: LlgConfig,
    pub terms: EffectiveFieldTerms,
    pub active_mask: Option<Vec<bool>>,
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
        FftWorkspace::new(
            self.grid.nx,
            self.grid.ny,
            self.grid.nz,
            self.cell_size.dx,
            self.cell_size.dy,
            self.cell_size.dz,
        )
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
        Ok(self.effective_field_from_vectors(state.magnetization()))
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
        }
    }

    fn heun_step(
        &self,
        state: &mut ExchangeLlgState,
        dt: f64,
        ws: &mut FftWorkspace,
    ) -> Result<StepReport> {
        let initial = state.magnetization.clone();
        let k1 = self.llg_rhs_from_vectors_ws(&initial, ws);

        let predicted = {
            let compute = |i: usize| normalized(add(initial[i], scale(k1[i], dt)));
            #[cfg(feature = "parallel")]
            {
                (0..initial.len())
                    .into_par_iter()
                    .map(compute)
                    .collect::<Result<Vec<_>>>()?
            }
            #[cfg(not(feature = "parallel"))]
            {
                (0..initial.len())
                    .map(compute)
                    .collect::<Result<Vec<_>>>()?
            }
        };

        let k2 = self.llg_rhs_from_vectors_ws(&predicted, ws);
        let corrected = {
            let compute =
                |i: usize| normalized(add(initial[i], scale(add(k1[i], k2[i]), 0.5 * dt)));
            #[cfg(feature = "parallel")]
            {
                (0..initial.len())
                    .into_par_iter()
                    .map(compute)
                    .collect::<Result<Vec<_>>>()?
            }
            #[cfg(not(feature = "parallel"))]
            {
                (0..initial.len())
                    .map(compute)
                    .collect::<Result<Vec<_>>>()?
            }
        };

        state.magnetization = corrected;
        state.time_seconds += dt;

        let observables = self.observe_vectors_ws(state.magnetization(), ws);

        Ok(StepReport {
            time_seconds: state.time_seconds,
            exchange_energy_joules: observables.exchange_energy_joules,
            demag_energy_joules: observables.demag_energy_joules,
            external_energy_joules: observables.external_energy_joules,
            total_energy_joules: observables.total_energy_joules,
            max_effective_field_amplitude: observables.max_effective_field_amplitude,
            max_demag_field_amplitude: observables.max_demag_field_amplitude,
            max_rhs_amplitude: observables.max_rhs_amplitude,
        })
    }

    fn ensure_state_matches_grid(&self, state: &ExchangeLlgState) -> Result<()> {
        if state.grid != self.grid {
            return Err(EngineError::new(
                "state grid does not match the problem grid shape",
            ));
        }
        Ok(())
    }

    fn observe_vectors(&self, magnetization: &[Vector3]) -> EffectiveFieldObservables {
        let mut ws = self.create_workspace();
        self.observe_vectors_ws(magnetization, &mut ws)
    }

    fn observe_vectors_ws(
        &self,
        magnetization: &[Vector3],
        ws: &mut FftWorkspace,
    ) -> EffectiveFieldObservables {
        let exchange_field = if self.terms.exchange {
            self.exchange_field_from_vectors(magnetization)
        } else {
            zero_vectors(self.grid.cell_count())
        };
        let demag_field = if self.terms.demag {
            self.demag_field_from_vectors_ws(magnetization, ws)
        } else {
            zero_vectors(self.grid.cell_count())
        };
        let external_field = self.external_field_vectors();
        let effective_field = combine_fields(&exchange_field, &demag_field, &external_field);
        let rhs = {
            let compute = |i: usize| self.llg_rhs_from_field(magnetization[i], effective_field[i]);
            #[cfg(feature = "parallel")]
            {
                (0..magnetization.len())
                    .into_par_iter()
                    .map(compute)
                    .collect::<Vec<_>>()
            }
            #[cfg(not(feature = "parallel"))]
            {
                (0..magnetization.len()).map(compute).collect::<Vec<_>>()
            }
        };

        let exchange_energy_joules = if self.terms.exchange {
            self.exchange_energy_from_field(magnetization, &exchange_field)
        } else {
            0.0
        };
        let demag_energy_joules = if self.terms.demag {
            self.demag_energy_from_fields(magnetization, &demag_field)
        } else {
            0.0
        };
        let external_energy_joules = if self.terms.external_field.is_some() {
            self.external_energy_from_fields(magnetization, &external_field)
        } else {
            0.0
        };
        let total_energy_joules =
            exchange_energy_joules + demag_energy_joules + external_energy_joules;

        let max_effective_field_amplitude = max_norm(&effective_field);
        let max_demag_field_amplitude = max_norm(&demag_field);
        let max_rhs_amplitude = max_norm(&rhs);

        EffectiveFieldObservables {
            magnetization: magnetization.to_vec(),
            exchange_field,
            demag_field,
            external_field,
            effective_field: effective_field.clone(),
            exchange_energy_joules,
            demag_energy_joules,
            external_energy_joules,
            total_energy_joules,
            max_effective_field_amplitude,
            max_demag_field_amplitude,
            max_rhs_amplitude,
        }
    }

    fn is_active(&self, flat_index: usize) -> bool {
        self.active_mask
            .as_ref()
            .map(|mask| mask[flat_index])
            .unwrap_or(true)
    }

    fn exchange_field_from_vectors(&self, magnetization: &[Vector3]) -> Vec<Vector3> {
        let prefactor =
            2.0 * self.material.exchange_stiffness / (MU0 * self.material.saturation_magnetisation);
        let dx2 = self.cell_size.dx * self.cell_size.dx;
        let dy2 = self.cell_size.dy * self.cell_size.dy;
        let dz2 = self.cell_size.dz * self.cell_size.dz;
        let grid = self.grid;

        let compute_cell = |flat_index: usize| -> Vector3 {
            if !self.is_active(flat_index) {
                return [0.0, 0.0, 0.0];
            }
            let x = flat_index % grid.nx;
            let y = (flat_index / grid.nx) % grid.ny;
            let z = flat_index / (grid.nx * grid.ny);
            let center = magnetization[flat_index];
            let sample_neighbor = |nx: usize, ny: usize, nz: usize| -> Vector3 {
                let neighbor_index = grid.index(nx, ny, nz);
                if self.is_active(neighbor_index) {
                    magnetization[neighbor_index]
                } else {
                    center
                }
            };
            let x_minus = sample_neighbor(x.saturating_sub(1), y, z);
            let x_plus = sample_neighbor((x + 1).min(grid.nx - 1), y, z);
            let y_minus = sample_neighbor(x, y.saturating_sub(1), z);
            let y_plus = sample_neighbor(x, (y + 1).min(grid.ny - 1), z);
            let z_minus = sample_neighbor(x, y, z.saturating_sub(1));
            let z_plus = sample_neighbor(x, y, (z + 1).min(grid.nz - 1));

            let mut laplacian = [0.0, 0.0, 0.0];
            for component in 0..3 {
                laplacian[component] =
                    (x_plus[component] - 2.0 * center[component] + x_minus[component]) / dx2
                        + (y_plus[component] - 2.0 * center[component] + y_minus[component]) / dy2
                        + (z_plus[component] - 2.0 * center[component] + z_minus[component]) / dz2;
            }
            scale(laplacian, prefactor)
        };

        #[cfg(feature = "parallel")]
        {
            (0..grid.cell_count())
                .into_par_iter()
                .map(compute_cell)
                .collect()
        }
        #[cfg(not(feature = "parallel"))]
        {
            (0..grid.cell_count()).map(compute_cell).collect()
        }
    }

    fn demag_field_from_vectors(&self, magnetization: &[Vector3]) -> Vec<Vector3> {
        let mut ws = self.create_workspace();
        self.demag_field_from_vectors_ws(magnetization, &mut ws)
    }

    fn demag_field_from_vectors_ws(
        &self,
        magnetization: &[Vector3],
        ws: &mut FftWorkspace,
    ) -> Vec<Vector3> {
        let px = ws.px;
        let py = ws.py;
        let pz = ws.pz;
        let padded_len = px * py * pz;

        // Zero out and pack magnetization into workspace M buffers.
        ws.clear_bufs();

        for z in 0..self.grid.nz {
            for y in 0..self.grid.ny {
                for x in 0..self.grid.nx {
                    let src_index = self.grid.index(x, y, z);
                    let dst_index = padded_index(px, py, x, y, z);
                    let moment = if self.is_active(src_index) {
                        scale(
                            magnetization[src_index],
                            self.material.saturation_magnetisation,
                        )
                    } else {
                        [0.0, 0.0, 0.0]
                    };
                    ws.buf_mx[dst_index] = Complex::new(moment[0], 0.0);
                    ws.buf_my[dst_index] = Complex::new(moment[1], 0.0);
                    ws.buf_mz[dst_index] = Complex::new(moment[2], 0.0);
                }
            }
        }

        ws.fft3_m_forward();

        // Newell tensor convolution in Fourier space:
        // H_i(k) = -Σ_j N_ij(k) · M_j(k)
        for i in 0..padded_len {
            let mx = ws.buf_mx[i];
            let my = ws.buf_my[i];
            let mz = ws.buf_mz[i];
            ws.buf_hx[i] = -(ws.kern_xx[i] * mx + ws.kern_xy[i] * my + ws.kern_xz[i] * mz);
            ws.buf_hy[i] = -(ws.kern_xy[i] * mx + ws.kern_yy[i] * my + ws.kern_yz[i] * mz);
            ws.buf_hz[i] = -(ws.kern_xz[i] * mx + ws.kern_yz[i] * my + ws.kern_zz[i] * mz);
        }

        ws.fft3_h_inverse();

        let normalisation = 1.0 / padded_len as f64;
        let mut field = vec![[0.0, 0.0, 0.0]; self.grid.cell_count()];
        for z in 0..self.grid.nz {
            for y in 0..self.grid.ny {
                for x in 0..self.grid.nx {
                    let src_index = padded_index(px, py, x, y, z);
                    let dst_index = self.grid.index(x, y, z);
                    field[dst_index] = if self.is_active(dst_index) {
                        [
                            ws.buf_hx[src_index].re * normalisation,
                            ws.buf_hy[src_index].re * normalisation,
                            ws.buf_hz[src_index].re * normalisation,
                        ]
                    } else {
                        [0.0, 0.0, 0.0]
                    };
                }
            }
        }

        field
    }

    fn external_field_vectors(&self) -> Vec<Vector3> {
        let external = self.terms.external_field.unwrap_or([0.0, 0.0, 0.0]);
        (0..self.grid.cell_count())
            .map(|i| {
                if self.is_active(i) {
                    external
                } else {
                    [0.0, 0.0, 0.0]
                }
            })
            .collect()
    }

    fn effective_field_from_vectors(&self, magnetization: &[Vector3]) -> Vec<Vector3> {
        let mut ws = self.create_workspace();
        self.effective_field_from_vectors_ws(magnetization, &mut ws)
    }

    fn effective_field_from_vectors_ws(
        &self,
        magnetization: &[Vector3],
        ws: &mut FftWorkspace,
    ) -> Vec<Vector3> {
        let exchange_field = if self.terms.exchange {
            self.exchange_field_from_vectors(magnetization)
        } else {
            zero_vectors(self.grid.cell_count())
        };
        let demag_field = if self.terms.demag {
            self.demag_field_from_vectors_ws(magnetization, ws)
        } else {
            zero_vectors(self.grid.cell_count())
        };
        let external_field = self.external_field_vectors();
        combine_fields(&exchange_field, &demag_field, &external_field)
    }

    fn llg_rhs_from_vectors(&self, magnetization: &[Vector3]) -> Vec<Vector3> {
        let mut ws = self.create_workspace();
        self.llg_rhs_from_vectors_ws(magnetization, &mut ws)
    }

    fn llg_rhs_from_vectors_ws(
        &self,
        magnetization: &[Vector3],
        ws: &mut FftWorkspace,
    ) -> Vec<Vector3> {
        let field = self.effective_field_from_vectors_ws(magnetization, ws);
        magnetization
            .iter()
            .zip(field.iter())
            .map(|(m, h)| self.llg_rhs_from_field(*m, *h))
            .collect()
    }

    fn llg_rhs_from_field(&self, magnetization: Vector3, field: Vector3) -> Vector3 {
        let alpha = self.material.damping;
        let gamma_bar = self.dynamics.gyromagnetic_ratio / (1.0 + alpha * alpha);
        let precession = cross(magnetization, field);
        let damping = cross(magnetization, precession);
        scale(add(precession, scale(damping, alpha)), -gamma_bar)
    }

    pub fn exchange_energy_from_vectors(&self, magnetization: &[Vector3]) -> f64 {
        let cell_volume = self.cell_size.volume();
        let grid = self.grid;
        let a = self.material.exchange_stiffness;
        let dx2 = self.cell_size.dx * self.cell_size.dx;
        let dy2 = self.cell_size.dy * self.cell_size.dy;
        let dz2 = self.cell_size.dz * self.cell_size.dz;

        let compute_cell_energy = |flat_index: usize| -> f64 {
            if !self.is_active(flat_index) {
                return 0.0;
            }
            let x = flat_index % grid.nx;
            let y = (flat_index / grid.nx) % grid.ny;
            let z = flat_index / (grid.nx * grid.ny);
            let center = magnetization[flat_index];
            let mut e = 0.0;
            if x + 1 < grid.nx {
                let neighbor_index = grid.index(x + 1, y, z);
                if self.is_active(neighbor_index) {
                    let neighbor = magnetization[neighbor_index];
                    e += a * cell_volume * squared_norm(sub(neighbor, center)) / dx2;
                }
            }
            if y + 1 < grid.ny {
                let neighbor_index = grid.index(x, y + 1, z);
                if self.is_active(neighbor_index) {
                    let neighbor = magnetization[neighbor_index];
                    e += a * cell_volume * squared_norm(sub(neighbor, center)) / dy2;
                }
            }
            if z + 1 < grid.nz {
                let neighbor_index = grid.index(x, y, z + 1);
                if self.is_active(neighbor_index) {
                    let neighbor = magnetization[neighbor_index];
                    e += a * cell_volume * squared_norm(sub(neighbor, center)) / dz2;
                }
            }
            e
        };

        #[cfg(feature = "parallel")]
        {
            (0..grid.cell_count())
                .into_par_iter()
                .map(compute_cell_energy)
                .sum()
        }
        #[cfg(not(feature = "parallel"))]
        {
            (0..grid.cell_count()).map(compute_cell_energy).sum()
        }
    }

    /// Compute exchange energy from already-available exchange field, avoiding second stencil pass.
    /// E_ex = -(mu0 * Ms / 2) * sum(m · H_ex) * V_cell
    fn exchange_energy_from_field(
        &self,
        magnetization: &[Vector3],
        exchange_field: &[Vector3],
    ) -> f64 {
        let cell_volume = self.cell_size.volume();
        let ms = self.material.saturation_magnetisation;
        let compute =
            |i: usize| -0.5 * MU0 * ms * dot(magnetization[i], exchange_field[i]) * cell_volume;
        #[cfg(feature = "parallel")]
        {
            (0..magnetization.len()).into_par_iter().map(compute).sum()
        }
        #[cfg(not(feature = "parallel"))]
        {
            (0..magnetization.len()).map(compute).sum()
        }
    }

    fn demag_energy_from_fields(&self, magnetization: &[Vector3], demag_field: &[Vector3]) -> f64 {
        let cell_volume = self.cell_size.volume();
        let ms = self.material.saturation_magnetisation;
        let compute =
            |i: usize| -0.5 * MU0 * ms * dot(magnetization[i], demag_field[i]) * cell_volume;
        #[cfg(feature = "parallel")]
        {
            (0..magnetization.len()).into_par_iter().map(compute).sum()
        }
        #[cfg(not(feature = "parallel"))]
        {
            (0..magnetization.len()).map(compute).sum()
        }
    }

    fn external_energy_from_fields(
        &self,
        magnetization: &[Vector3],
        external_field: &[Vector3],
    ) -> f64 {
        let cell_volume = self.cell_size.volume();
        let ms = self.material.saturation_magnetisation;
        let compute = |i: usize| -MU0 * ms * dot(magnetization[i], external_field[i]) * cell_volume;
        #[cfg(feature = "parallel")]
        {
            (0..magnetization.len()).into_par_iter().map(compute).sum()
        }
        #[cfg(not(feature = "parallel"))]
        {
            (0..magnetization.len()).map(compute).sum()
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ReferenceDemoReport {
    pub steps: usize,
    pub dt: f64,
    pub initial_exchange_energy_joules: f64,
    pub final_exchange_energy_joules: f64,
    pub final_time_seconds: f64,
    pub final_center_magnetization: Vector3,
    pub max_effective_field_amplitude: f64,
    pub max_rhs_amplitude: f64,
}

pub fn run_reference_exchange_demo(steps: usize, dt: f64) -> Result<ReferenceDemoReport> {
    if dt <= 0.0 {
        return Err(EngineError::new("dt must be positive"));
    }
    let grid = GridShape::new(3, 1, 1)?;
    let problem = ExchangeLlgProblem::new(
        grid,
        CellSize::new(2e-9, 2e-9, 2e-9)?,
        MaterialParameters::new(800e3, 13e-12, 0.2)?,
        LlgConfig::default(),
    );
    let mut state = problem.new_state(vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0]])?;
    let initial_exchange_energy_joules = problem.exchange_energy(&state)?;
    let mut last_report = StepReport {
        time_seconds: 0.0,
        exchange_energy_joules: initial_exchange_energy_joules,
        demag_energy_joules: 0.0,
        external_energy_joules: 0.0,
        total_energy_joules: initial_exchange_energy_joules,
        max_effective_field_amplitude: 0.0,
        max_demag_field_amplitude: 0.0,
        max_rhs_amplitude: 0.0,
    };

    for _ in 0..steps {
        last_report = problem.step(&mut state, dt)?;
    }

    Ok(ReferenceDemoReport {
        steps,
        dt,
        initial_exchange_energy_joules,
        final_exchange_energy_joules: last_report.exchange_energy_joules,
        final_time_seconds: last_report.time_seconds,
        final_center_magnetization: state.magnetization()[grid.index(1, 0, 0)],
        max_effective_field_amplitude: last_report.max_effective_field_amplitude,
        max_rhs_amplitude: last_report.max_rhs_amplitude,
    })
}

/// Core 3D FFT: operates on an external data slice using explicit plan/scratch refs.
fn fft3_core(
    data: &mut [Complex<f64>],
    nx: usize,
    ny: usize,
    nz: usize,
    fft_x: &dyn Fft<f64>,
    fft_y: &dyn Fft<f64>,
    fft_z: &dyn Fft<f64>,
    line_y: &mut [Complex<f64>],
    line_z: &mut [Complex<f64>],
) {
    // X-axis transforms (contiguous in memory)
    for z in 0..nz {
        for y in 0..ny {
            let start = padded_index(nx, ny, 0, y, z);
            fft_x.process(&mut data[start..start + nx]);
        }
    }

    // Y-axis transforms (strided, use scratch line)
    for z in 0..nz {
        for x in 0..nx {
            for y in 0..ny {
                line_y[y] = data[padded_index(nx, ny, x, y, z)];
            }
            fft_y.process(line_y);
            for y in 0..ny {
                data[padded_index(nx, ny, x, y, z)] = line_y[y];
            }
        }
    }

    // Z-axis transforms (strided, use scratch line)
    for y in 0..ny {
        for x in 0..nx {
            for z in 0..nz {
                line_z[z] = data[padded_index(nx, ny, x, y, z)];
            }
            fft_z.process(line_z);
            for z in 0..nz {
                data[padded_index(nx, ny, x, y, z)] = line_z[z];
            }
        }
    }
}

/// 3D FFT using cached workspace plans (avoids per-call FftPlanner).
fn fft3_with_workspace(data: &mut [Complex<f64>], ws: &mut FftWorkspace, inverse: bool) {
    let (fft_x, fft_y, fft_z) = if inverse {
        (&*ws.inv_x, &*ws.inv_y, &*ws.inv_z)
    } else {
        (&*ws.fwd_x, &*ws.fwd_y, &*ws.fwd_z)
    };
    fft3_core(
        data,
        ws.px,
        ws.py,
        ws.pz,
        fft_x,
        fft_y,
        fft_z,
        &mut ws.line_y,
        &mut ws.line_z,
    );
}

/// Legacy wrapper — creates workspace on the fly (used only in tests).
#[allow(dead_code)]
fn fft3_in_place(data: &mut [Complex<f64>], nx: usize, ny: usize, nz: usize, inverse: bool) {
    let mut ws = FftWorkspace::new(nx / 2, ny / 2, nz / 2, 1.0, 1.0, 1.0);
    fft3_with_workspace(data, &mut ws, inverse);
}

fn padded_index(nx: usize, ny: usize, x: usize, y: usize, z: usize) -> usize {
    x + nx * (y + ny * z)
}

fn zero_vectors(len: usize) -> Vec<Vector3> {
    vec![[0.0, 0.0, 0.0]; len]
}

fn combine_fields(
    exchange_field: &[Vector3],
    demag_field: &[Vector3],
    external_field: &[Vector3],
) -> Vec<Vector3> {
    #[cfg(feature = "parallel")]
    {
        (0..exchange_field.len())
            .into_par_iter()
            .map(|i| add(add(exchange_field[i], demag_field[i]), external_field[i]))
            .collect()
    }
    #[cfg(not(feature = "parallel"))]
    {
        exchange_field
            .iter()
            .zip(demag_field.iter().zip(external_field.iter()))
            .map(|(h_ex, (h_demag, h_ext))| add(add(*h_ex, *h_demag), *h_ext))
            .collect()
    }
}

fn normalized(vector: Vector3) -> Result<Vector3> {
    let norm = norm(vector);
    if norm <= 0.0 {
        // Inactive cell (masked out by active_mask) — preserve zero vector
        return Ok([0.0, 0.0, 0.0]);
    }
    Ok(scale(vector, 1.0 / norm))
}

fn max_norm(vectors: &[Vector3]) -> f64 {
    #[cfg(feature = "parallel")]
    {
        vectors
            .par_iter()
            .map(|vector| norm(*vector))
            .reduce(|| 0.0, f64::max)
    }
    #[cfg(not(feature = "parallel"))]
    {
        vectors
            .iter()
            .map(|vector| norm(*vector))
            .fold(0.0, f64::max)
    }
}

fn add(left: Vector3, right: Vector3) -> Vector3 {
    [left[0] + right[0], left[1] + right[1], left[2] + right[2]]
}

fn sub(left: Vector3, right: Vector3) -> Vector3 {
    [left[0] - right[0], left[1] - right[1], left[2] - right[2]]
}

fn scale(vector: Vector3, factor: f64) -> Vector3 {
    [vector[0] * factor, vector[1] * factor, vector[2] * factor]
}

fn dot(left: Vector3, right: Vector3) -> f64 {
    left[0] * right[0] + left[1] * right[1] + left[2] * right[2]
}

fn cross(left: Vector3, right: Vector3) -> Vector3 {
    [
        left[1] * right[2] - left[2] * right[1],
        left[2] * right[0] - left[0] * right[2],
        left[0] * right[1] - left[1] * right[0],
    ]
}

fn squared_norm(vector: Vector3) -> f64 {
    dot(vector, vector)
}

fn norm(vector: Vector3) -> f64 {
    squared_norm(vector).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn simple_problem(alpha: f64, gamma: f64) -> ExchangeLlgProblem {
        let grid = GridShape::new(3, 1, 1).expect("valid grid");
        ExchangeLlgProblem::new(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * MU0, alpha).expect("valid material"),
            LlgConfig::new(gamma, TimeIntegrator::Heun).expect("valid llg config"),
        )
    }

    fn zeeman_problem(field: Vector3) -> ExchangeLlgProblem {
        let grid = GridShape::new(2, 1, 1).expect("valid grid");
        ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * MU0, 0.5).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: false,
                demag: false,
                external_field: Some(field),
            },
        )
    }

    fn demag_problem(nx: usize, ny: usize, nz: usize) -> ExchangeLlgProblem {
        let grid = GridShape::new(nx, ny, nz).expect("valid grid");
        ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(1.0, 1.0, 0.2).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * MU0, 0.1).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: false,
                demag: true,
                external_field: None,
            },
        )
    }

    fn masked_exchange_problem(mask: Vec<bool>) -> ExchangeLlgProblem {
        let grid = GridShape::new(3, 1, 1).expect("valid grid");
        ExchangeLlgProblem::with_terms_and_mask(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * MU0, 0.1).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: true,
                demag: false,
                external_field: None,
            },
            Some(mask),
        )
        .expect("masked problem should build")
    }

    fn masked_demag_problem(mask: Vec<bool>) -> ExchangeLlgProblem {
        let grid = GridShape::new(3, 1, 1).expect("valid grid");
        ExchangeLlgProblem::with_terms_and_mask(
            grid,
            CellSize::new(1.0, 1.0, 1.0).expect("valid cell size"),
            MaterialParameters::new(1.0, 0.5 * MU0, 0.1).expect("valid material"),
            LlgConfig::new(1.0, TimeIntegrator::Heun).expect("valid llg config"),
            EffectiveFieldTerms {
                exchange: false,
                demag: true,
                external_field: Some([0.0, 0.0, 1.0]),
            },
            Some(mask),
        )
        .expect("masked problem should build")
    }

    fn assert_vector_close(actual: Vector3, expected: Vector3, tolerance: f64) {
        for component in 0..3 {
            assert!(
                (actual[component] - expected[component]).abs() <= tolerance,
                "component {component} differs: actual={:?}, expected={:?}",
                actual,
                expected
            );
        }
    }

    #[test]
    fn uniform_state_has_zero_exchange_field_and_rhs() {
        let problem = simple_problem(0.1, 1.0);
        let state = problem
            .uniform_state([1.0, 0.0, 0.0])
            .expect("uniform state should build");

        let field = problem
            .exchange_field(&state)
            .expect("exchange field should evaluate");
        let rhs = problem.llg_rhs(&state).expect("rhs should evaluate");

        for value in field.iter().chain(rhs.iter()) {
            assert_vector_close(*value, [0.0, 0.0, 0.0], 1e-12);
        }
        assert!(
            problem
                .exchange_energy(&state)
                .expect("energy should evaluate")
                <= 1e-12,
            "uniform state should have zero exchange energy"
        );
    }

    #[test]
    fn center_exchange_field_matches_second_difference_stencil() {
        let problem = simple_problem(0.0, 1.0);
        let state = problem
            .new_state(vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0]])
            .expect("state should build");

        let field = problem
            .exchange_field(&state)
            .expect("exchange field should evaluate");

        assert_vector_close(field[1], [2.0, -2.0, 0.0], 1e-12);
    }

    #[test]
    fn masked_exchange_treats_inactive_neighbor_as_free_surface() {
        let problem = masked_exchange_problem(vec![true, true, false]);
        let state = problem
            .new_state(vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.7, 0.3, 0.0]])
            .expect("state should build");

        let field = problem
            .exchange_field(&state)
            .expect("exchange field should evaluate");

        assert_vector_close(field[1], [1.0, -1.0, 0.0], 1e-12);
        assert_vector_close(field[2], [0.0, 0.0, 0.0], 1e-12);
        assert_vector_close(state.magnetization()[2], [0.0, 0.0, 0.0], 1e-12);
    }

    #[test]
    fn masked_demag_and_external_fields_are_zero_outside_active_domain() {
        let problem = masked_demag_problem(vec![true, true, false]);
        let state = problem
            .new_state(vec![[1.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
            .expect("state should build");

        let obs = problem.observe(&state).expect("observables");

        assert_vector_close(obs.external_field[2], [0.0, 0.0, 0.0], 1e-12);
        assert_vector_close(obs.demag_field[2], [0.0, 0.0, 0.0], 1e-12);
        assert_vector_close(obs.effective_field[2], [0.0, 0.0, 0.0], 1e-12);
        assert_vector_close(obs.magnetization[2], [0.0, 0.0, 0.0], 1e-12);
    }

    #[test]
    fn heun_step_preserves_unit_norm() {
        let problem = simple_problem(0.1, 1.0);
        let mut state = problem
            .new_state(vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0]])
            .expect("state should build");

        let _report = problem.step(&mut state, 1e-3).expect("step should succeed");

        for magnetization in state.magnetization() {
            assert!(
                (norm(*magnetization) - 1.0).abs() <= 1e-12,
                "magnetization lost unit norm: {:?}",
                magnetization
            );
        }
    }

    #[test]
    fn damped_relaxation_reduces_exchange_energy_for_small_dt() {
        let problem = simple_problem(0.5, 1.0);
        let mut state = problem
            .new_state(vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0]])
            .expect("state should build");

        let initial_energy = problem
            .exchange_energy(&state)
            .expect("energy should evaluate");
        for _ in 0..10 {
            problem.step(&mut state, 1e-3).expect("step should succeed");
        }
        let final_energy = problem
            .observe(&state)
            .expect("observables")
            .total_energy_joules;

        assert!(
            final_energy < initial_energy,
            "expected damped exchange relaxation to reduce energy, initial={initial_energy}, final={final_energy}"
        );
    }

    #[test]
    fn zeeman_only_relaxation_reduces_external_energy() {
        let problem = zeeman_problem([0.0, 0.0, 1.0]);
        let mut state = problem
            .new_state(vec![[1.0, 0.0, 0.0], [1.0, 0.0, 0.0]])
            .expect("state should build");

        let initial_energy = problem
            .observe(&state)
            .expect("observables")
            .external_energy_joules;
        for _ in 0..100 {
            problem.step(&mut state, 5e-3).expect("step should succeed");
        }
        let final_observables = problem.observe(&state).expect("observables");

        assert!(
            final_observables.external_energy_joules < initial_energy,
            "expected external energy to decrease under damping"
        );
        assert!(
            state.magnetization()[0][2] > 0.1,
            "magnetization should tilt toward the external field"
        );
    }

    #[test]
    fn thin_film_out_of_plane_demag_energy_exceeds_in_plane_energy() {
        let problem = demag_problem(4, 4, 1);
        let out_of_plane = problem
            .uniform_state([0.0, 0.0, 1.0])
            .expect("state should build");
        let in_plane = problem
            .uniform_state([1.0, 0.0, 0.0])
            .expect("state should build");

        let e_out = problem
            .observe(&out_of_plane)
            .expect("observables")
            .demag_energy_joules;
        let e_in = problem
            .observe(&in_plane)
            .expect("observables")
            .demag_energy_joules;

        assert!(
            e_out > e_in,
            "thin-film demag should penalise out-of-plane magnetization more strongly, out={e_out}, in={e_in}"
        );
    }

    #[test]
    fn demag_energy_is_non_negative_for_random_states() {
        let problem = demag_problem(4, 4, 2);
        // Seeded pseudo-random initial magnetization
        let n = 4 * 4 * 2;
        let mut m0 = Vec::with_capacity(n);
        let mut seed: u64 = 42;
        for _ in 0..n {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            let x = ((seed >> 33) as f64) / (u32::MAX as f64) * 2.0 - 1.0;
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            let y = ((seed >> 33) as f64) / (u32::MAX as f64) * 2.0 - 1.0;
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            let z = ((seed >> 33) as f64) / (u32::MAX as f64) * 2.0 - 1.0;
            let len = (x * x + y * y + z * z).sqrt().max(1e-12);
            m0.push([x / len, y / len, z / len]);
        }
        let state = problem.new_state(m0).expect("state should build");
        let obs = problem.observe(&state).expect("observables");

        assert!(
            obs.demag_energy_joules >= 0.0,
            "demag energy must be non-negative, got {}",
            obs.demag_energy_joules
        );
        assert!(
            obs.demag_energy_joules.is_finite(),
            "demag energy must be finite"
        );
    }

    #[test]
    fn total_energy_decreases_during_demag_relaxation() {
        let grid = GridShape::new(8, 8, 1).expect("valid grid");
        let problem = ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(2e-9, 2e-9, 2e-9).expect("valid cell size"),
            MaterialParameters::new(800e3, 13e-12, 0.5).expect("valid material"),
            LlgConfig::default(),
            EffectiveFieldTerms {
                exchange: true,
                demag: true,
                external_field: None,
            },
        );

        // Start with slightly tilted m (pure z gives m×H=0, no dynamics)
        let n = grid.cell_count();
        let tilted: Vec<Vector3> = (0..n)
            .map(|_| {
                let len = (0.01f64 * 0.01 + 0.01 * 0.01 + 1.0).sqrt();
                [0.01 / len, 0.01 / len, 1.0 / len]
            })
            .collect();
        let mut state = problem.new_state(tilted).expect("state should build");
        let mut ws = problem.create_workspace();

        let initial_energy = problem
            .observe(&state)
            .expect("observables")
            .total_energy_joules;
        let dt = 1e-14;
        for _ in 0..200 {
            problem
                .step_with_workspace(&mut state, dt, &mut ws)
                .expect("step should succeed");
        }
        let final_energy = problem
            .observe(&state)
            .expect("observables")
            .total_energy_joules;

        assert!(
            final_energy < initial_energy,
            "total energy should decrease during damped relaxation with demag, initial={initial_energy}, final={final_energy}"
        );
    }

    #[test]
    fn workspace_demag_matches_standalone_demag() {
        let problem = demag_problem(4, 4, 2);
        let state = problem
            .uniform_state([1.0, 0.0, 0.0])
            .expect("state should build");

        // Compute via standalone call (creates workspace internally)
        let field_direct = problem
            .demag_field(&state)
            .expect("demag field should evaluate");
        // Compute via workspace
        let obs_ws = problem.observe(&state).expect("observables");

        for (i, (direct, ws_val)) in field_direct
            .iter()
            .zip(obs_ws.demag_field.iter())
            .enumerate()
        {
            for c in 0..3 {
                assert!(
                    (direct[c] - ws_val[c]).abs() < 1e-14,
                    "component {c} of cell {i} differs between workspace and standalone demag"
                );
            }
        }
    }

    #[test]
    fn thin_film_in_plane_demag_energy_is_small() {
        let problem = demag_problem(8, 8, 1);
        let state = problem
            .uniform_state([1.0, 0.0, 0.0])
            .expect("state should build");
        let obs = problem.observe(&state).expect("observables");

        // In-plane uniform magnetization of a thin film should have near-zero demag energy
        // (relative to the out-of-plane case)
        let out_of_plane = problem
            .uniform_state([0.0, 0.0, 1.0])
            .expect("state should build");
        let e_out = problem
            .observe(&out_of_plane)
            .expect("observables")
            .demag_energy_joules;

        assert!(
            obs.demag_energy_joules < e_out * 0.5,
            "in-plane demag energy should be smaller than out-of-plane, in={}, out={e_out}",
            obs.demag_energy_joules
        );
    }
}
