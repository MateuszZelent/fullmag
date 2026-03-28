pub mod fem;
pub mod fem_afem_loop;
pub mod fem_edge_topology;
pub mod fem_error_estimator;
pub mod fem_face_topology;
pub mod fem_goal_estimator;
pub mod fem_hcurl_estimator;
pub mod fem_size_field;
pub mod fem_solution_transfer;
pub mod multilayer;
pub mod newell;
pub mod studies;
pub mod vector;

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

/// Structure-of-Arrays layout for 3D vector fields.
///
/// Stores `x`, `y`, `z` components in separate contiguous arrays —
/// optimal for SIMD, FFT gather/scatter, and GPU upload.
#[derive(Debug, Clone, PartialEq)]
pub struct VectorFieldSoA {
    pub x: Vec<f64>,
    pub y: Vec<f64>,
    pub z: Vec<f64>,
}

impl VectorFieldSoA {
    /// Allocate zeroed buffers for `n` vectors.
    pub fn zeros(n: usize) -> Self {
        Self {
            x: vec![0.0; n],
            y: vec![0.0; n],
            z: vec![0.0; n],
        }
    }

    pub fn len(&self) -> usize {
        self.x.len()
    }

    pub fn is_empty(&self) -> bool {
        self.x.is_empty()
    }

    /// Convert from AoS `&[Vector3]` without allocation (writes into self).
    pub fn scatter_from_aos(&mut self, aos: &[Vector3]) {
        let n = aos.len();
        debug_assert!(self.x.len() >= n);
        for i in 0..n {
            self.x[i] = aos[i][0];
            self.y[i] = aos[i][1];
            self.z[i] = aos[i][2];
        }
    }

    /// Convert to AoS `Vec<Vector3>`.
    pub fn gather_to_aos(&self) -> Vec<Vector3> {
        let n = self.x.len();
        let mut aos = Vec::with_capacity(n);
        for i in 0..n {
            aos.push([self.x[i], self.y[i], self.z[i]]);
        }
        aos
    }

    /// Convert to AoS into existing buffer (no allocation).
    pub fn gather_into_aos(&self, aos: &mut [Vector3]) {
        let n = self.x.len().min(aos.len());
        for i in 0..n {
            aos[i] = [self.x[i], self.y[i], self.z[i]];
        }
    }

    /// Create from AoS `&[Vector3]` (allocating).
    pub fn from_aos(aos: &[Vector3]) -> Self {
        let n = aos.len();
        let mut soa = Self::zeros(n);
        soa.scatter_from_aos(aos);
        soa
    }
}

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
    RK4,
    RK23,
    RK45,
    /// Adams–Bashforth–Moulton 3rd-order predictor-corrector.
    /// After 3-step Heun warmup, uses only 1 RHS evaluation per step.
    ABM3,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AdaptiveStepConfig {
    pub max_error: f64,
    pub dt_min: f64,
    pub dt_max: f64,
    pub headroom: f64,
}

impl Default for AdaptiveStepConfig {
    fn default() -> Self {
        Self {
            max_error: 1e-5,
            dt_min: 1e-18,
            dt_max: 1e-10,
            headroom: 0.8,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LlgConfig {
    pub gyromagnetic_ratio: f64,
    pub integrator: TimeIntegrator,
    pub adaptive: AdaptiveStepConfig,
    pub precession_enabled: bool,
}

impl Default for LlgConfig {
    fn default() -> Self {
        Self {
            gyromagnetic_ratio: DEFAULT_GYROMAGNETIC_RATIO,
            integrator: TimeIntegrator::Heun,
            adaptive: AdaptiveStepConfig::default(),
            precession_enabled: true,
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
            adaptive: AdaptiveStepConfig::default(),
            precession_enabled: true,
        })
    }

    pub fn with_adaptive(mut self, config: AdaptiveStepConfig) -> Self {
        self.adaptive = config;
        self
    }

    pub fn with_precession_enabled(mut self, enabled: bool) -> Self {
        self.precession_enabled = enabled;
        self
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
        #[cfg(feature = "parallel")]
        {
            use rayon::prelude::*;
            self.buf_mx.par_iter_mut().for_each(|v| *v = zero);
            self.buf_my.par_iter_mut().for_each(|v| *v = zero);
            self.buf_mz.par_iter_mut().for_each(|v| *v = zero);
            self.buf_hx.par_iter_mut().for_each(|v| *v = zero);
            self.buf_hy.par_iter_mut().for_each(|v| *v = zero);
            self.buf_hz.par_iter_mut().for_each(|v| *v = zero);
        }
        #[cfg(not(feature = "parallel"))]
        {
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

pub fn compute_newell_kernel_spectra_thin_film_2d(
    nx: usize,
    ny: usize,
    dx: f64,
    dy: f64,
    dz: f64,
) -> DemagKernelSpectra {
    let nk = newell::compute_newell_kernels(nx, ny, 1, dx, dy, dz);
    let px = nk.px;
    let py = nk.py;
    let pz = 1usize;
    let plane_len = px * py;
    let zero = Complex::new(0.0, 0.0);
    let mut planner = FftPlanner::<f64>::new();
    let fwd_x = planner.plan_fft_forward(px);
    let fwd_y = planner.plan_fft_forward(py);
    let fwd_z = planner.plan_fft_forward(1);

    let fft_kernel_2d = |real_3d: Vec<f64>| -> Vec<Complex<f64>> {
        let mut plane = Vec::with_capacity(plane_len);
        for y in 0..py {
            for x in 0..px {
                plane.push(Complex::new(real_3d[padded_index(px, py, x, y, 0)], 0.0));
            }
        }
        let mut line_y_tmp = vec![zero; py];
        let mut line_z_tmp = vec![zero; 1];
        fft3_core(
            &mut plane,
            px,
            py,
            pz,
            &*fwd_x,
            &*fwd_y,
            &*fwd_z,
            &mut line_y_tmp,
            &mut line_z_tmp,
        );
        plane
    };

    let flatten = |values: &[Complex<f64>]| -> Vec<f64> {
        let mut flat = Vec::with_capacity(values.len() * 2);
        for value in values {
            flat.push(value.re);
            flat.push(value.im);
        }
        flat
    };

    let kern_xx = fft_kernel_2d(nk.n_xx);
    let kern_yy = fft_kernel_2d(nk.n_yy);
    let kern_zz = fft_kernel_2d(nk.n_zz);
    let kern_xy = fft_kernel_2d(nk.n_xy);
    let kern_xz = fft_kernel_2d(nk.n_xz);
    let kern_yz = fft_kernel_2d(nk.n_yz);

    DemagKernelSpectra {
        px,
        py,
        pz,
        n_xx: flatten(&kern_xx),
        n_yy: flatten(&kern_yy),
        n_zz: flatten(&kern_zz),
        n_xy: flatten(&kern_xy),
        n_xz: flatten(&kern_xz),
        n_yz: flatten(&kern_yz),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExchangeLlgState {
    grid: GridShape,
    magnetization: Vec<Vector3>,
    pub time_seconds: f64,
    /// FSAL (First Same As Last) buffer for Dormand–Prince 5(4).
    /// Stores the RHS evaluation at the accepted solution from the previous step,
    /// which becomes k₁ for the next step — saving one full field assembly.
    /// Automatically invalidated on rejected steps or non-RK45 integrators.
    k_fsal: Option<Vec<Vector3>>,
    /// ABM(3) history: stores the last 3 RHS evaluations for multi-step prediction.
    abm_history: AbmHistory,
}

/// History buffer for Adams–Bashforth–Moulton 3rd-order predictor-corrector.
#[derive(Debug, Clone, PartialEq)]
pub struct AbmHistory {
    /// RHS at step n (most recent)
    f_n: Option<Vec<Vector3>>,
    /// RHS at step n-1
    f_n_minus_1: Option<Vec<Vector3>>,
    /// RHS at step n-2
    f_n_minus_2: Option<Vec<Vector3>>,
    /// Number of startup steps completed (0..3)
    startup_steps: u32,
    /// Last dt used (ABM requires constant dt; restart if changed)
    last_dt: f64,
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

    fn restart(&mut self) {
        *self = Self::new();
    }
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
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StepReport {
    pub time_seconds: f64,
    pub dt_used: f64,
    pub step_rejected: bool,
    pub suggested_next_dt: Option<f64>,
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

/// Lightweight observables from a single RHS evaluation.
/// Unlike `EffectiveFieldObservables`, does not store full field vectors —
/// only the scalars needed for `StepReport`.
#[derive(Debug, Clone, PartialEq)]
pub struct RhsEvaluation {
    pub exchange_energy_joules: f64,
    pub demag_energy_joules: f64,
    pub external_energy_joules: f64,
    pub total_energy_joules: f64,
    pub max_effective_field_amplitude: f64,
    pub max_demag_field_amplitude: f64,
    pub max_rhs_amplitude: f64,
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
            total_energy_joules: self.total_energy_joules,
            max_effective_field_amplitude: self.max_effective_field_amplitude,
            max_demag_field_amplitude: self.max_demag_field_amplitude,
            max_rhs_amplitude: self.max_rhs_amplitude,
        }
    }
}

/// Preallocated workspace buffers for time integrator stages.
///
/// Reuse across steps to avoid per-step heap allocation of temporary
/// magnetization and RHS vectors.  Create once via
/// [`ExchangeLlgProblem::create_integrator_buffers`] and pass to
/// [`ExchangeLlgProblem::step_with_buffers`].
#[derive(Debug, Clone)]
pub struct IntegratorBuffers {
    /// k-stage buffers (k1..k7).  RK45 needs 7, others need fewer.
    pub k: [Vec<Vector3>; 7],
    /// Intermediate delta workspace (weighted sum of k-stages × dt).
    pub delta: Vec<Vector3>,
    /// Intermediate magnetization state for sub-stages.
    pub m_stage: Vec<Vector3>,
    /// Backup of initial magnetization at start of step.
    pub m0: Vec<Vector3>,
}

impl IntegratorBuffers {
    /// Allocate zeroed buffers for `n` cells.
    pub fn new(n: usize) -> Self {
        let zero = || vec![[0.0, 0.0, 0.0]; n];
        Self {
            k: [zero(), zero(), zero(), zero(), zero(), zero(), zero()],
            delta: zero(),
            m_stage: zero(),
            m0: zero(),
        }
    }
}

/// Persistent solver session bundling all per-simulation resources.
///
/// This is the recommended production entry point for time-stepping loops.
/// It bundles the problem definition, solution state, FFT workspace, and
/// integrator scratch buffers into a single object, providing a simple
/// `step()` method that avoids all per-step resource acquisition overhead.
///
/// # Example
/// ```ignore
/// let session = SolverSession::new(problem, initial_magnetization)?;
/// for _ in 0..1000 {
///     let report = session.step(dt)?;
///     println!("t = {:.3e}  E = {:.6e}", report.time_seconds, report.total_energy_joules);
/// }
/// ```
pub struct SolverSession {
    problem: ExchangeLlgProblem,
    state: ExchangeLlgState,
    fft_ws: FftWorkspace,
    bufs: IntegratorBuffers,
    step_count: u64,
}

impl SolverSession {
    /// Create a new solver session with the given problem and initial magnetization.
    pub fn new(problem: ExchangeLlgProblem, magnetization: Vec<Vector3>) -> Result<Self> {
        let state = ExchangeLlgState::new(problem.grid, magnetization)?;
        let fft_ws = problem.create_workspace();
        let bufs = problem.create_integrator_buffers();
        Ok(Self {
            problem,
            state,
            fft_ws,
            bufs,
            step_count: 0,
        })
    }

    /// Advance the simulation by one time step.
    ///
    /// Uses the buffer-aware path for Heun/RK4, falling back to the
    /// allocating path for adaptive integrators.
    pub fn step(&mut self, dt: f64) -> Result<StepReport> {
        let report = self.problem.step_with_buffers(
            &mut self.state,
            dt,
            &mut self.fft_ws,
            &mut self.bufs,
        )?;
        self.step_count += 1;
        Ok(report)
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

    /// Mutable access to the state (e.g. for external field changes).
    pub fn state_mut(&mut self) -> &mut ExchangeLlgState {
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
    ///
    /// **Performance warning**: this rebuilds the FFT workspace (including Newell
    /// kernel spectra) from scratch on every call.  For production loops, use
    /// [`step_with_workspace`] with a pre-built workspace instead.
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
    /// buffers.  This is the most efficient entry point for production solver
    /// loops: it avoids both FFT re-planning and per-step heap allocations.
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

        match self.dynamics.integrator {
            TimeIntegrator::Heun => self.heun_step_buf(state, dt, ws, bufs),
            TimeIntegrator::RK4 => self.rk4_step_buf(state, dt, ws, bufs),
            TimeIntegrator::RK23 => self.rk23_step_buf(state, dt, ws, bufs),
            TimeIntegrator::RK45 => self.rk45_step_buf(state, dt, ws, bufs),
            TimeIntegrator::ABM3 => self.abm3_step_buf(state, dt, ws, bufs),
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
            dt_used: dt,
            step_rejected: false,
            suggested_next_dt: None,
            exchange_energy_joules: observables.exchange_energy_joules,
            demag_energy_joules: observables.demag_energy_joules,
            external_energy_joules: observables.external_energy_joules,
            total_energy_joules: observables.total_energy_joules,
            max_effective_field_amplitude: observables.max_effective_field_amplitude,
            max_demag_field_amplitude: observables.max_demag_field_amplitude,
            max_rhs_amplitude: observables.max_rhs_amplitude,
        })
    }

    // -----------------------------------------------------------------------
    // Buffer-reusing Heun step
    // -----------------------------------------------------------------------
    fn heun_step_buf(
        &self,
        state: &mut ExchangeLlgState,
        dt: f64,
        ws: &mut FftWorkspace,
        bufs: &mut IntegratorBuffers,
    ) -> Result<StepReport> {
        let n = state.magnetization.len();
        bufs.m0[..n].copy_from_slice(&state.magnetization);

        // k1 = f(t, m0)
        self.llg_rhs_into_ws(&bufs.m0[..n], ws, &mut bufs.k[0]);

        // predicted = normalize(m0 + dt * k1)
        for i in 0..n {
            bufs.m_stage[i] = normalized(add(bufs.m0[i], scale(bufs.k[0][i], dt)))?;
        }

        // k2 = f(t+dt, predicted)
        self.llg_rhs_into_ws(&bufs.m_stage[..n], ws, &mut bufs.k[1]);

        // corrected = normalize(m0 + dt/2 * (k1 + k2))
        for i in 0..n {
            state.magnetization[i] = normalized(add(
                bufs.m0[i],
                scale(add(bufs.k[0][i], bufs.k[1][i]), 0.5 * dt),
            ))?;
        }
        state.time_seconds += dt;

        let (_, eval) = self.llg_rhs_full_ws(&state.magnetization, ws);
        Ok(eval.into_step_report(state.time_seconds, dt, false))
    }

    // -----------------------------------------------------------------------
    // Buffer-reusing RK4 step
    // -----------------------------------------------------------------------
    fn rk4_step_buf(
        &self,
        state: &mut ExchangeLlgState,
        dt: f64,
        ws: &mut FftWorkspace,
        bufs: &mut IntegratorBuffers,
    ) -> Result<StepReport> {
        let n = state.magnetization.len();
        bufs.m0[..n].copy_from_slice(&state.magnetization);

        // k1 = f(t, m0)
        self.llg_rhs_into_ws(&bufs.m0[..n], ws, &mut bufs.k[0]);

        // m1 = normalize(m0 + dt/2 * k1)
        for i in 0..n {
            bufs.m_stage[i] = normalized(add(bufs.m0[i], scale(bufs.k[0][i], 0.5 * dt)))?;
        }
        self.llg_rhs_into_ws(&bufs.m_stage[..n], ws, &mut bufs.k[1]);

        // m2 = normalize(m0 + dt/2 * k2)
        for i in 0..n {
            bufs.m_stage[i] = normalized(add(bufs.m0[i], scale(bufs.k[1][i], 0.5 * dt)))?;
        }
        self.llg_rhs_into_ws(&bufs.m_stage[..n], ws, &mut bufs.k[2]);

        // m3 = normalize(m0 + dt * k3)
        for i in 0..n {
            bufs.m_stage[i] = normalized(add(bufs.m0[i], scale(bufs.k[2][i], dt)))?;
        }
        self.llg_rhs_into_ws(&bufs.m_stage[..n], ws, &mut bufs.k[3]);

        // y = normalize(m0 + dt/6 * (k1 + 2*k2 + 2*k3 + k4))
        for i in 0..n {
            state.magnetization[i] = normalized(add(
                bufs.m0[i],
                scale(
                    add(
                        add(bufs.k[0][i], scale(bufs.k[1][i], 2.0)),
                        add(scale(bufs.k[2][i], 2.0), bufs.k[3][i]),
                    ),
                    dt / 6.0,
                ),
            ))?;
        }
        state.time_seconds += dt;

        let (_, eval) = self.llg_rhs_full_ws(&state.magnetization, ws);
        Ok(eval.into_step_report(state.time_seconds, dt, false))
    }

    // -----------------------------------------------------------------------
    // In-place RHS evaluation: writes result into `out` instead of allocating
    // -----------------------------------------------------------------------
    fn llg_rhs_into_ws(
        &self,
        magnetization: &[Vector3],
        ws: &mut FftWorkspace,
        out: &mut [Vector3],
    ) {
        let rhs = self.llg_rhs_from_vectors_ws(magnetization, ws);
        out[..rhs.len()].copy_from_slice(&rhs);
    }

    /// In-place RHS evaluation that also returns cached observables.
    fn _llg_rhs_full_into_ws(
        &self,
        magnetization: &[Vector3],
        ws: &mut FftWorkspace,
        out: &mut [Vector3],
    ) -> RhsEvaluation {
        let (rhs, eval) = self.llg_rhs_full_ws(magnetization, ws);
        out[..rhs.len()].copy_from_slice(&rhs);
        eval
    }

    // -----------------------------------------------------------------------
    // Buffer-reusing RK23 (Bogacki-Shampine 2(3), adaptive)
    // -----------------------------------------------------------------------
    fn rk23_step_buf(
        &self,
        state: &mut ExchangeLlgState,
        dt: f64,
        ws: &mut FftWorkspace,
        bufs: &mut IntegratorBuffers,
    ) -> Result<StepReport> {
        let cfg = self.dynamics.adaptive;
        let mut dt = dt.min(cfg.dt_max).max(cfg.dt_min);
        let n = state.magnetization.len();
        bufs.m0[..n].copy_from_slice(&state.magnetization);

        loop {
            // k1 = f(t, m0)
            self.llg_rhs_into_ws(&bufs.m0[..n], ws, &mut bufs.k[0]);

            // m1 = normalize(m0 + dt/2 * k1)
            for i in 0..n {
                bufs.m_stage[i] = normalized(add(bufs.m0[i], scale(bufs.k[0][i], 0.5 * dt)))?;
            }
            self.llg_rhs_into_ws(&bufs.m_stage[..n], ws, &mut bufs.k[1]);

            // m2 = normalize(m0 + 3dt/4 * k2)
            for i in 0..n {
                bufs.m_stage[i] = normalized(add(bufs.m0[i], scale(bufs.k[1][i], 0.75 * dt)))?;
            }
            self.llg_rhs_into_ws(&bufs.m_stage[..n], ws, &mut bufs.k[2]);

            // y3 = normalize(m0 + dt*(2/9*k1 + 1/3*k2 + 4/9*k3))
            for i in 0..n {
                bufs.delta[i] = scale(
                    add(
                        add(
                            scale(bufs.k[0][i], 2.0 / 9.0),
                            scale(bufs.k[1][i], 1.0 / 3.0),
                        ),
                        scale(bufs.k[2][i], 4.0 / 9.0),
                    ),
                    dt,
                );
                bufs.m_stage[i] = normalized(add(bufs.m0[i], bufs.delta[i]))?;
            }

            // k4 for error estimate
            self.llg_rhs_into_ws(&bufs.m_stage[..n], ws, &mut bufs.k[3]);

            // Error
            let error = self.max_error_norm_buf(
                &[
                    (0, -5.0 / 72.0),
                    (1, 1.0 / 12.0),
                    (2, 1.0 / 9.0),
                    (3, -1.0 / 8.0),
                ],
                bufs,
                dt,
                n,
            );

            if error <= cfg.max_error || dt <= cfg.dt_min {
                state.magnetization[..n].copy_from_slice(&bufs.m_stage[..n]);
                state.time_seconds += dt;
                let dt_next = (cfg.headroom * dt * (cfg.max_error / error.max(1e-30)).powf(1.0 / 3.0))
                    .max(cfg.dt_min)
                    .min(cfg.dt_max);
                let (_, eval) = self.llg_rhs_full_ws(&state.magnetization, ws);
                let mut report = eval.into_step_report(state.time_seconds, dt, false);
                report.suggested_next_dt = Some(dt_next);
                return Ok(report);
            }

            let dt_new = cfg.headroom * dt * (cfg.max_error / error).powf(1.0 / 3.0);
            dt = dt_new.max(cfg.dt_min).min(cfg.dt_max);
        }
    }

    // -----------------------------------------------------------------------
    // Buffer-reusing RK45 (Dormand-Prince 4(5), adaptive) — mumax3 default
    // -----------------------------------------------------------------------
    fn rk45_step_buf(
        &self,
        state: &mut ExchangeLlgState,
        dt: f64,
        ws: &mut FftWorkspace,
        bufs: &mut IntegratorBuffers,
    ) -> Result<StepReport> {
        let cfg = self.dynamics.adaptive;
        let mut dt = dt.min(cfg.dt_max).max(cfg.dt_min);
        let n = state.magnetization.len();
        bufs.m0[..n].copy_from_slice(&state.magnetization);

        // Dormand-Prince coefficients
        const A21: f64 = 1.0 / 5.0;
        const A31: f64 = 3.0 / 40.0;
        const A32: f64 = 9.0 / 40.0;
        const A41: f64 = 44.0 / 45.0;
        const A42: f64 = -56.0 / 15.0;
        const A43: f64 = 32.0 / 9.0;
        const A51: f64 = 19372.0 / 6561.0;
        const A52: f64 = -25360.0 / 2187.0;
        const A53: f64 = 64448.0 / 6561.0;
        const A54: f64 = -212.0 / 729.0;
        const A61: f64 = 9017.0 / 3168.0;
        const A62: f64 = -355.0 / 33.0;
        const A63: f64 = 46732.0 / 5247.0;
        const A64: f64 = 49.0 / 176.0;
        const A65: f64 = -5103.0 / 18656.0;
        const B1: f64 = 35.0 / 384.0;
        const B3: f64 = 500.0 / 1113.0;
        const B4: f64 = 125.0 / 192.0;
        const B5: f64 = -2187.0 / 6784.0;
        const B6: f64 = 11.0 / 84.0;
        const E1: f64 = 71.0 / 57600.0;
        const E3: f64 = -71.0 / 16695.0;
        const E4: f64 = 71.0 / 1920.0;
        const E5: f64 = -17253.0 / 339200.0;
        const E6: f64 = 22.0 / 525.0;
        const E7: f64 = -1.0 / 40.0;

        loop {
            // Stage 1 — FSAL: reuse k7 from previous accepted step
            if let Some(fsal) = state.k_fsal.take() {
                bufs.k[0][..n].copy_from_slice(&fsal);
            } else {
                self.llg_rhs_into_ws(&bufs.m0[..n], ws, &mut bufs.k[0]);
            }

            // Stage 2
            for i in 0..n {
                bufs.m_stage[i] = normalized(add(bufs.m0[i], scale(bufs.k[0][i], A21 * dt)))?;
            }
            self.llg_rhs_into_ws(&bufs.m_stage[..n], ws, &mut bufs.k[1]);

            // Stage 3
            for i in 0..n {
                bufs.m_stage[i] = normalized(add(
                    bufs.m0[i],
                    scale(add(scale(bufs.k[0][i], A31), scale(bufs.k[1][i], A32)), dt),
                ))?;
            }
            self.llg_rhs_into_ws(&bufs.m_stage[..n], ws, &mut bufs.k[2]);

            // Stage 4
            for i in 0..n {
                bufs.m_stage[i] = normalized(add(
                    bufs.m0[i],
                    scale(
                        add(
                            add(scale(bufs.k[0][i], A41), scale(bufs.k[1][i], A42)),
                            scale(bufs.k[2][i], A43),
                        ),
                        dt,
                    ),
                ))?;
            }
            self.llg_rhs_into_ws(&bufs.m_stage[..n], ws, &mut bufs.k[3]);

            // Stage 5
            for i in 0..n {
                bufs.m_stage[i] = normalized(add(
                    bufs.m0[i],
                    scale(
                        add(
                            add(scale(bufs.k[0][i], A51), scale(bufs.k[1][i], A52)),
                            add(scale(bufs.k[2][i], A53), scale(bufs.k[3][i], A54)),
                        ),
                        dt,
                    ),
                ))?;
            }
            self.llg_rhs_into_ws(&bufs.m_stage[..n], ws, &mut bufs.k[4]);

            // Stage 6
            for i in 0..n {
                bufs.m_stage[i] = normalized(add(
                    bufs.m0[i],
                    scale(
                        add(
                            add(
                                add(scale(bufs.k[0][i], A61), scale(bufs.k[1][i], A62)),
                                scale(bufs.k[2][i], A63),
                            ),
                            add(scale(bufs.k[3][i], A64), scale(bufs.k[4][i], A65)),
                        ),
                        dt,
                    ),
                ))?;
            }
            self.llg_rhs_into_ws(&bufs.m_stage[..n], ws, &mut bufs.k[5]);

            // 5th-order solution → m_stage
            for i in 0..n {
                bufs.m_stage[i] = normalized(add(
                    bufs.m0[i],
                    scale(
                        add(
                            add(
                                add(scale(bufs.k[0][i], B1), scale(bufs.k[2][i], B3)),
                                scale(bufs.k[3][i], B4),
                            ),
                            add(scale(bufs.k[4][i], B5), scale(bufs.k[5][i], B6)),
                        ),
                        dt,
                    ),
                ))?;
            }

            // k7 for error estimate (FSAL) → k[6]
            self.llg_rhs_into_ws(&bufs.m_stage[..n], ws, &mut bufs.k[6]);

            // Error estimate
            let error = self.max_error_norm_buf(
                &[(0, E1), (2, E3), (3, E4), (4, E5), (5, E6), (6, E7)],
                bufs,
                dt,
                n,
            );

            if error <= cfg.max_error || dt <= cfg.dt_min {
                state.magnetization[..n].copy_from_slice(&bufs.m_stage[..n]);
                state.time_seconds += dt;
                // FSAL: save k7 for next step's k1
                state.k_fsal = Some(bufs.k[6][..n].to_vec());
                let dt_next = (cfg.headroom * dt * (cfg.max_error / error.max(1e-30)).powf(0.2))
                    .max(cfg.dt_min)
                    .min(cfg.dt_max);
                let (_, eval) = self.llg_rhs_full_ws(&state.magnetization, ws);
                let mut report = eval.into_step_report(state.time_seconds, dt, false);
                report.suggested_next_dt = Some(dt_next);
                return Ok(report);
            }

            let dt_new = cfg.headroom * dt * (cfg.max_error / error).powf(0.2);
            dt = dt_new.max(cfg.dt_min).min(cfg.dt_max);
        }
    }

    // -----------------------------------------------------------------------
    // Buffer-reusing ABM3 (Adams–Bashforth–Moulton 3rd order)
    // -----------------------------------------------------------------------
    fn abm3_step_buf(
        &self,
        state: &mut ExchangeLlgState,
        dt: f64,
        ws: &mut FftWorkspace,
        bufs: &mut IntegratorBuffers,
    ) -> Result<StepReport> {
        let n = state.magnetization.len();

        // During startup, fall back to Heun build history
        if !state.abm_history.is_ready() {
            bufs.m0[..n].copy_from_slice(&state.magnetization);

            // k1 = f(t, m0)
            self.llg_rhs_into_ws(&bufs.m0[..n], ws, &mut bufs.k[0]);

            // predicted = normalize(m0 + dt * k1)
            for i in 0..n {
                bufs.m_stage[i] = normalized(add(bufs.m0[i], scale(bufs.k[0][i], dt)))?;
            }

            // k2 = f(t+dt, predicted)
            self.llg_rhs_into_ws(&bufs.m_stage[..n], ws, &mut bufs.k[1]);

            // corrected = normalize(m0 + dt/2 * (k1 + k2))
            for i in 0..n {
                state.magnetization[i] = normalized(add(
                    bufs.m0[i],
                    scale(add(bufs.k[0][i], bufs.k[1][i]), 0.5 * dt),
                ))?;
            }
            state.time_seconds += dt;

            // Store RHS at accepted point for history
            let f_accepted = self.llg_rhs_from_vectors_ws(state.magnetization(), ws);
            state.abm_history.push(f_accepted, dt);

            let (_, eval) = self.llg_rhs_full_ws(&state.magnetization, ws);
            return Ok(eval.into_step_report(state.time_seconds, dt, false));
        }

        // --- Full ABM3 step ---
        bufs.m0[..n].copy_from_slice(&state.magnetization);

        let f_n = state.abm_history.f_n().unwrap();
        let f_n1 = state.abm_history.f_n_minus_1().unwrap();
        let f_n2 = state.abm_history.f_n_minus_2().unwrap();

        // Adams–Bashforth predictor → m_stage
        for i in 0..n {
            let pred = add(
                add(scale(f_n[i], 23.0 / 12.0), scale(f_n1[i], -16.0 / 12.0)),
                scale(f_n2[i], 5.0 / 12.0),
            );
            bufs.m_stage[i] = normalized(add(bufs.m0[i], scale(pred, dt)))?;
        }

        // Evaluate RHS at predicted point → k[0] (only new RHS eval)
        self.llg_rhs_into_ws(&bufs.m_stage[..n], ws, &mut bufs.k[0]);

        // Adams–Moulton corrector → state.magnetization
        for i in 0..n {
            let corr = add(
                add(scale(bufs.k[0][i], 5.0 / 12.0), scale(f_n[i], 8.0 / 12.0)),
                scale(f_n1[i], -1.0 / 12.0),
            );
            state.magnetization[i] = normalized(add(bufs.m0[i], scale(corr, dt)))?;
        }
        state.time_seconds += dt;

        // Push f_star (k[0]) into history
        state.abm_history.push(bufs.k[0][..n].to_vec(), dt);

        let (_, eval) = self.llg_rhs_full_ws(&state.magnetization, ws);
        Ok(eval.into_step_report(state.time_seconds, dt, false))
    }

    // -----------------------------------------------------------------------
    // Error norm from buffer-indexed k-stages
    // -----------------------------------------------------------------------
    fn max_error_norm_buf(
        &self,
        weighted_stages: &[(usize, f64)],
        bufs: &IntegratorBuffers,
        dt: f64,
        n: usize,
    ) -> f64 {
        let mut max_err = 0.0f64;
        for i in 0..n {
            let mut err = [0.0, 0.0, 0.0];
            for &(k_idx, w) in weighted_stages {
                err[0] += w * bufs.k[k_idx][i][0];
                err[1] += w * bufs.k[k_idx][i][1];
                err[2] += w * bufs.k[k_idx][i][2];
            }
            err[0] *= dt;
            err[1] *= dt;
            err[2] *= dt;
            max_err = max_err.max(norm(err));
        }
        max_err
    }

    // -----------------------------------------------------------------------
    // Helper: build StepReport from observables
    // -----------------------------------------------------------------------
    fn make_step_report(
        &self,
        state: &ExchangeLlgState,
        dt_used: f64,
        step_rejected: bool,
        ws: &mut FftWorkspace,
    ) -> StepReport {
        let observables = self.observe_vectors_ws(state.magnetization(), ws);
        StepReport {
            time_seconds: state.time_seconds,
            dt_used,
            step_rejected,
            suggested_next_dt: None,
            exchange_energy_joules: observables.exchange_energy_joules,
            demag_energy_joules: observables.demag_energy_joules,
            external_energy_joules: observables.external_energy_joules,
            total_energy_joules: observables.total_energy_joules,
            max_effective_field_amplitude: observables.max_effective_field_amplitude,
            max_demag_field_amplitude: observables.max_demag_field_amplitude,
            max_rhs_amplitude: observables.max_rhs_amplitude,
        }
    }

    // -----------------------------------------------------------------------
    // Helper: parallel/sequential m_new[i] = normalize(m0[i] + delta[i])
    // -----------------------------------------------------------------------
    fn par_apply_normalized(&self, m0: &[Vector3], delta: &[Vector3]) -> Result<Vec<Vector3>> {
        let compute = |i: usize| normalized(add(m0[i], delta[i]));
        #[cfg(feature = "parallel")]
        {
            (0..m0.len())
                .into_par_iter()
                .map(compute)
                .collect::<Result<Vec<_>>>()
        }
        #[cfg(not(feature = "parallel"))]
        {
            (0..m0.len()).map(compute).collect::<Result<Vec<_>>>()
        }
    }

    // -----------------------------------------------------------------------
    // RK4 (Classical Runge-Kutta, 4th order, fixed step)
    // -----------------------------------------------------------------------
    fn rk4_step(
        &self,
        state: &mut ExchangeLlgState,
        dt: f64,
        ws: &mut FftWorkspace,
    ) -> Result<StepReport> {
        let n = state.magnetization.len();
        let m0 = state.magnetization.clone();

        // k1 = f(t, m0)
        let k1 = self.llg_rhs_from_vectors_ws(&m0, ws);

        // m1 = normalize(m0 + dt/2 * k1)
        let delta: Vec<Vector3> = (0..n).map(|i| scale(k1[i], 0.5 * dt)).collect();
        let m1 = self.par_apply_normalized(&m0, &delta)?;

        // k2 = f(t + dt/2, m1)
        let k2 = self.llg_rhs_from_vectors_ws(&m1, ws);

        // m2 = normalize(m0 + dt/2 * k2)
        let delta: Vec<Vector3> = (0..n).map(|i| scale(k2[i], 0.5 * dt)).collect();
        let m2 = self.par_apply_normalized(&m0, &delta)?;

        // k3 = f(t + dt/2, m2)
        let k3 = self.llg_rhs_from_vectors_ws(&m2, ws);

        // m3 = normalize(m0 + dt * k3)
        let delta: Vec<Vector3> = (0..n).map(|i| scale(k3[i], dt)).collect();
        let m3 = self.par_apply_normalized(&m0, &delta)?;

        // k4 = f(t + dt, m3)
        let k4 = self.llg_rhs_from_vectors_ws(&m3, ws);

        // y = normalize(m0 + dt/6 * (k1 + 2*k2 + 2*k3 + k4))
        let delta: Vec<Vector3> = (0..n)
            .map(|i| {
                scale(
                    add(add(k1[i], scale(k2[i], 2.0)), add(scale(k3[i], 2.0), k4[i])),
                    dt / 6.0,
                )
            })
            .collect();
        state.magnetization = self.par_apply_normalized(&m0, &delta)?;
        state.time_seconds += dt;

        Ok(self.make_step_report(state, dt, false, ws))
    }

    // -----------------------------------------------------------------------
    // RK23 (Bogacki-Shampine 2(3), adaptive)
    // -----------------------------------------------------------------------
    fn rk23_step(
        &self,
        state: &mut ExchangeLlgState,
        dt: f64,
        ws: &mut FftWorkspace,
    ) -> Result<StepReport> {
        let cfg = self.dynamics.adaptive;
        let mut dt = dt.min(cfg.dt_max).max(cfg.dt_min);
        let n = state.magnetization.len();
        let m0 = state.magnetization.clone();

        loop {
            // k1 = f(t, m0)
            let k1 = self.llg_rhs_from_vectors_ws(&m0, ws);

            // k2 = f(t + dt/2, normalize(m0 + dt/2 * k1))
            let delta: Vec<Vector3> = (0..n).map(|i| scale(k1[i], 0.5 * dt)).collect();
            let m1 = self.par_apply_normalized(&m0, &delta)?;
            let k2 = self.llg_rhs_from_vectors_ws(&m1, ws);

            // k3 = f(t + 3dt/4, normalize(m0 + 3dt/4 * k2))
            let delta: Vec<Vector3> = (0..n).map(|i| scale(k2[i], 0.75 * dt)).collect();
            let m2 = self.par_apply_normalized(&m0, &delta)?;
            let k3 = self.llg_rhs_from_vectors_ws(&m2, ws);

            // 3rd-order solution: y3 = m0 + dt*(2/9*k1 + 1/3*k2 + 4/9*k3)
            let delta3: Vec<Vector3> = (0..n)
                .map(|i| {
                    scale(
                        add(
                            add(scale(k1[i], 2.0 / 9.0), scale(k2[i], 1.0 / 3.0)),
                            scale(k3[i], 4.0 / 9.0),
                        ),
                        dt,
                    )
                })
                .collect();
            let y3 = self.par_apply_normalized(&m0, &delta3)?;

            // k4 for embedded error estimate
            let k4 = self.llg_rhs_from_vectors_ws(&y3, ws);

            // Error = dt * |(-5/72)k1 + (1/12)k2 + (1/9)k3 + (-1/8)k4|
            let error = self.max_error_norm(
                &[
                    (&k1, -5.0 / 72.0),
                    (&k2, 1.0 / 12.0),
                    (&k3, 1.0 / 9.0),
                    (&k4, -1.0 / 8.0),
                ],
                dt,
                n,
            );

            if error <= cfg.max_error || dt <= cfg.dt_min {
                state.magnetization = y3;
                state.time_seconds += dt;
                return Ok(self.make_step_report(state, dt, false, ws));
            }

            // Reject: reduce dt with 3rd-order scaling
            let dt_new = cfg.headroom * dt * (cfg.max_error / error).powf(1.0 / 3.0);
            dt = dt_new.max(cfg.dt_min).min(cfg.dt_max);
        }
    }

    // -----------------------------------------------------------------------
    // RK45 (Dormand-Prince 4(5), adaptive) — mumax3 default
    // -----------------------------------------------------------------------
    fn rk45_step(
        &self,
        state: &mut ExchangeLlgState,
        dt: f64,
        ws: &mut FftWorkspace,
    ) -> Result<StepReport> {
        let cfg = self.dynamics.adaptive;
        let mut dt = dt.min(cfg.dt_max).max(cfg.dt_min);
        let n = state.magnetization.len();
        let m0 = state.magnetization.clone();

        // Dormand-Prince coefficients
        const A21: f64 = 1.0 / 5.0;
        const A31: f64 = 3.0 / 40.0;
        const A32: f64 = 9.0 / 40.0;
        const A41: f64 = 44.0 / 45.0;
        const A42: f64 = -56.0 / 15.0;
        const A43: f64 = 32.0 / 9.0;
        const A51: f64 = 19372.0 / 6561.0;
        const A52: f64 = -25360.0 / 2187.0;
        const A53: f64 = 64448.0 / 6561.0;
        const A54: f64 = -212.0 / 729.0;
        const A61: f64 = 9017.0 / 3168.0;
        const A62: f64 = -355.0 / 33.0;
        const A63: f64 = 46732.0 / 5247.0;
        const A64: f64 = 49.0 / 176.0;
        const A65: f64 = -5103.0 / 18656.0;

        // 5th-order weights
        const B1: f64 = 35.0 / 384.0;
        const B3: f64 = 500.0 / 1113.0;
        const B4: f64 = 125.0 / 192.0;
        const B5: f64 = -2187.0 / 6784.0;
        const B6: f64 = 11.0 / 84.0;

        // Error coefficients: e_i = b_i - b*_i
        const E1: f64 = 71.0 / 57600.0;
        const E3: f64 = -71.0 / 16695.0;
        const E4: f64 = 71.0 / 1920.0;
        const E5: f64 = -17253.0 / 339200.0;
        const E6: f64 = 22.0 / 525.0;
        const E7: f64 = -1.0 / 40.0;

        loop {
            // Stage 1 — FSAL: reuse k7 from previous accepted step if available
            let k1 = if let Some(fsal) = state.k_fsal.take() {
                fsal
            } else {
                self.llg_rhs_from_vectors_ws(&m0, ws)
            };

            // Stage 2
            let delta: Vec<Vector3> = (0..n).map(|i| scale(k1[i], A21 * dt)).collect();
            let ms = self.par_apply_normalized(&m0, &delta)?;
            let k2 = self.llg_rhs_from_vectors_ws(&ms, ws);

            // Stage 3
            let delta: Vec<Vector3> = (0..n)
                .map(|i| scale(add(scale(k1[i], A31), scale(k2[i], A32)), dt))
                .collect();
            let ms = self.par_apply_normalized(&m0, &delta)?;
            let k3 = self.llg_rhs_from_vectors_ws(&ms, ws);

            // Stage 4
            let delta: Vec<Vector3> = (0..n)
                .map(|i| {
                    scale(
                        add(add(scale(k1[i], A41), scale(k2[i], A42)), scale(k3[i], A43)),
                        dt,
                    )
                })
                .collect();
            let ms = self.par_apply_normalized(&m0, &delta)?;
            let k4 = self.llg_rhs_from_vectors_ws(&ms, ws);

            // Stage 5
            let delta: Vec<Vector3> = (0..n)
                .map(|i| {
                    scale(
                        add(
                            add(scale(k1[i], A51), scale(k2[i], A52)),
                            add(scale(k3[i], A53), scale(k4[i], A54)),
                        ),
                        dt,
                    )
                })
                .collect();
            let ms = self.par_apply_normalized(&m0, &delta)?;
            let k5 = self.llg_rhs_from_vectors_ws(&ms, ws);

            // Stage 6
            let delta: Vec<Vector3> = (0..n)
                .map(|i| {
                    scale(
                        add(
                            add(add(scale(k1[i], A61), scale(k2[i], A62)), scale(k3[i], A63)),
                            add(scale(k4[i], A64), scale(k5[i], A65)),
                        ),
                        dt,
                    )
                })
                .collect();
            let ms = self.par_apply_normalized(&m0, &delta)?;
            let k6 = self.llg_rhs_from_vectors_ws(&ms, ws);

            // 5th-order solution
            let delta5: Vec<Vector3> = (0..n)
                .map(|i| {
                    scale(
                        add(
                            add(add(scale(k1[i], B1), scale(k3[i], B3)), scale(k4[i], B4)),
                            add(scale(k5[i], B5), scale(k6[i], B6)),
                        ),
                        dt,
                    )
                })
                .collect();
            let y5 = self.par_apply_normalized(&m0, &delta5)?;

            // k7 for error estimate (FSAL)
            let k7 = self.llg_rhs_from_vectors_ws(&y5, ws);

            // Error estimate
            let error = self.max_error_norm(
                &[
                    (&k1, E1),
                    (&k3, E3),
                    (&k4, E4),
                    (&k5, E5),
                    (&k6, E6),
                    (&k7, E7),
                ],
                dt,
                n,
            );

            if error <= cfg.max_error || dt <= cfg.dt_min {
                state.magnetization = y5;
                state.time_seconds += dt;
                // FSAL: save k7 for next step's k1
                state.k_fsal = Some(k7);
                return Ok(self.make_step_report(state, dt, false, ws));
            }

            // Reject: reduce dt with 5th-order scaling.
            // FSAL is implicitly invalidated — k_fsal was already consumed by
            // take() above, and we don't save a new one on rejection.
            let dt_new = cfg.headroom * dt * (cfg.max_error / error).powf(0.2);
            dt = dt_new.max(cfg.dt_min).min(cfg.dt_max);
        }
    }

    // -----------------------------------------------------------------------
    // ABM3 (Adams–Bashforth–Moulton 3rd order, multi-step)
    //
    // After 3 startup steps (Heun), uses only 1 RHS evaluation per step:
    //   Predictor (AB3): m* = m + dt·(23/12·f_n - 16/12·f_{n-1} + 5/12·f_{n-2})
    //   Corrector (AM3): m  = m + dt·(5/12·f* + 8/12·f_n - 1/12·f_{n-1})
    // -----------------------------------------------------------------------
    fn abm3_step(
        &self,
        state: &mut ExchangeLlgState,
        dt: f64,
        ws: &mut FftWorkspace,
    ) -> Result<StepReport> {
        let n = state.magnetization.len();

        // During startup, fall back to Heun to build history
        if !state.abm_history.is_ready() {
            // Heun step
            let m0 = state.magnetization.clone();
            let k1 = self.llg_rhs_from_vectors_ws(&m0, ws);

            let predicted = {
                let compute = |i: usize| normalized(add(m0[i], scale(k1[i], dt)));
                #[cfg(feature = "parallel")]
                {
                    (0..n)
                        .into_par_iter()
                        .map(compute)
                        .collect::<Result<Vec<_>>>()?
                }
                #[cfg(not(feature = "parallel"))]
                {
                    (0..n).map(compute).collect::<Result<Vec<_>>>()?
                }
            };

            let k2 = self.llg_rhs_from_vectors_ws(&predicted, ws);
            let corrected = {
                let compute = |i: usize| normalized(add(m0[i], scale(add(k1[i], k2[i]), 0.5 * dt)));
                #[cfg(feature = "parallel")]
                {
                    (0..n)
                        .into_par_iter()
                        .map(compute)
                        .collect::<Result<Vec<_>>>()?
                }
                #[cfg(not(feature = "parallel"))]
                {
                    (0..n).map(compute).collect::<Result<Vec<_>>>()?
                }
            };

            state.magnetization = corrected;
            state.time_seconds += dt;

            // Store the RHS at the accepted point for ABM history
            let f_accepted = self.llg_rhs_from_vectors_ws(state.magnetization(), ws);
            state.abm_history.push(f_accepted, dt);

            return Ok(self.make_step_report(state, dt, false, ws));
        }

        // --- Full ABM3 step ---

        let m0 = state.magnetization.clone();

        // Extract history references (safe: is_ready() was true)
        let f_n = state.abm_history.f_n.as_ref().unwrap();
        let f_n1 = state.abm_history.f_n_minus_1.as_ref().unwrap();
        let f_n2 = state.abm_history.f_n_minus_2.as_ref().unwrap();

        // Adams–Bashforth predictor (3rd order, explicit):
        // m* = m + dt·(23/12·f_n - 16/12·f_{n-1} + 5/12·f_{n-2})
        let m_predicted = {
            let compute = |i: usize| {
                let pred = add(
                    add(scale(f_n[i], 23.0 / 12.0), scale(f_n1[i], -16.0 / 12.0)),
                    scale(f_n2[i], 5.0 / 12.0),
                );
                normalized(add(m0[i], scale(pred, dt)))
            };
            #[cfg(feature = "parallel")]
            {
                (0..n)
                    .into_par_iter()
                    .map(compute)
                    .collect::<Result<Vec<_>>>()?
            }
            #[cfg(not(feature = "parallel"))]
            {
                (0..n).map(compute).collect::<Result<Vec<_>>>()?
            }
        };

        // Evaluate RHS at predicted point — this is the ONLY new RHS eval
        let f_star = self.llg_rhs_from_vectors_ws(&m_predicted, ws);

        // Adams–Moulton corrector (3rd order, implicit one-step):
        // m = m + dt·(5/12·f* + 8/12·f_n - 1/12·f_{n-1})
        let m_corrected = {
            let compute = |i: usize| {
                let corr = add(
                    add(scale(f_star[i], 5.0 / 12.0), scale(f_n[i], 8.0 / 12.0)),
                    scale(f_n1[i], -1.0 / 12.0),
                );
                normalized(add(m0[i], scale(corr, dt)))
            };
            #[cfg(feature = "parallel")]
            {
                (0..n)
                    .into_par_iter()
                    .map(compute)
                    .collect::<Result<Vec<_>>>()?
            }
            #[cfg(not(feature = "parallel"))]
            {
                (0..n).map(compute).collect::<Result<Vec<_>>>()?
            }
        };

        // Accept corrected solution
        state.magnetization = m_corrected;
        state.time_seconds += dt;

        // Push corrector RHS into history for next step
        // We use f_star as the history entry (evaluated at the predicted point,
        // which is close to the corrected point for small errors)
        state.abm_history.push(f_star, dt);

        Ok(self.make_step_report(state, dt, false, ws))
    }

    // -----------------------------------------------------------------------
    // Error norm helper for adaptive solvers
    // -----------------------------------------------------------------------
    fn max_error_norm(&self, weighted_stages: &[(&Vec<Vector3>, f64)], dt: f64, n: usize) -> f64 {
        let compute = |i: usize| {
            let mut err = [0.0, 0.0, 0.0];
            for &(k, w) in weighted_stages {
                err[0] += w * k[i][0];
                err[1] += w * k[i][1];
                err[2] += w * k[i][2];
            }
            err[0] *= dt;
            err[1] *= dt;
            err[2] *= dt;
            norm(err)
        };
        #[cfg(feature = "parallel")]
        {
            (0..n)
                .into_par_iter()
                .map(compute)
                .reduce(|| 0.0_f64, f64::max)
        }
        #[cfg(not(feature = "parallel"))]
        {
            (0..n).map(compute).fold(0.0_f64, f64::max)
        }
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
        #[cfg(feature = "parallel")]
        {
            use rayon::prelude::*;
            // Split into non-overlapping slices for parallel processing.
            // buf_mx/my/mz are read-only at this point; buf_hx/hy/hz are write-only.
            let (mx_sl, my_sl, mz_sl) = (&ws.buf_mx[..], &ws.buf_my[..], &ws.buf_mz[..]);
            let (kxx, kyy, kzz) = (&ws.kern_xx[..], &ws.kern_yy[..], &ws.kern_zz[..]);
            let (kxy, kxz, kyz) = (&ws.kern_xy[..], &ws.kern_xz[..], &ws.kern_yz[..]);
            let hx = &mut ws.buf_hx[..];
            let hy = &mut ws.buf_hy[..];
            let hz = &mut ws.buf_hz[..];
            // Process hx, hy, hz sequentially but each one in parallel
            hx.par_iter_mut().enumerate().for_each(|(i, h)| {
                *h = -(kxx[i] * mx_sl[i] + kxy[i] * my_sl[i] + kxz[i] * mz_sl[i]);
            });
            hy.par_iter_mut().enumerate().for_each(|(i, h)| {
                *h = -(kxy[i] * mx_sl[i] + kyy[i] * my_sl[i] + kyz[i] * mz_sl[i]);
            });
            hz.par_iter_mut().enumerate().for_each(|(i, h)| {
                *h = -(kxz[i] * mx_sl[i] + kyz[i] * my_sl[i] + kzz[i] * mz_sl[i]);
            });
        }
        #[cfg(not(feature = "parallel"))]
        {
            for i in 0..padded_len {
                let mx = ws.buf_mx[i];
                let my = ws.buf_my[i];
                let mz = ws.buf_mz[i];
                ws.buf_hx[i] = -(ws.kern_xx[i] * mx + ws.kern_xy[i] * my + ws.kern_xz[i] * mz);
                ws.buf_hy[i] = -(ws.kern_xy[i] * mx + ws.kern_yy[i] * my + ws.kern_yz[i] * mz);
                ws.buf_hz[i] = -(ws.kern_xz[i] * mx + ws.kern_yz[i] * my + ws.kern_zz[i] * mz);
            }
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

    /// Compute effective field using a disposable FFT workspace.
    ///
    /// **Performance warning**: rebuilds the FFT workspace on every call.
    /// Prefer [`effective_field_from_vectors_ws`] with a pre-built workspace.
    #[deprecated(
        since = "0.1.0",
        note = "creates a new FFT workspace per call; use effective_field_from_vectors_ws() instead"
    )]
    pub fn effective_field_from_vectors(&self, magnetization: &[Vector3]) -> Vec<Vector3> {
        let mut ws = self.create_workspace();
        self.effective_field_from_vectors_ws(magnetization, &mut ws)
    }

    pub fn effective_field_from_vectors_ws(
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

    /// Compute tangent-space gradient: g_i = -P_{m_i} H_eff,i
    /// where P_{m_i} = I - m_i m_i^T is the orthogonal projector.
    ///
    /// For inactive cells (zero magnetization), returns zero.
    pub fn tangent_gradient_from_vectors_ws(
        &self,
        magnetization: &[Vector3],
        ws: &mut FftWorkspace,
    ) -> Vec<Vector3> {
        let h_eff = self.effective_field_from_vectors_ws(magnetization, ws);
        magnetization
            .iter()
            .zip(h_eff.iter())
            .map(|(m, h)| {
                // g_i = -(H_eff - (m · H_eff) m) = -P_m H_eff
                let m_dot_h = dot(*m, *h);
                let projected = sub(*h, scale(*m, m_dot_h));
                scale(projected, -1.0)
            })
            .collect()
    }

    /// Compute tangent-space gradient from pre-computed effective field.
    pub fn tangent_gradient_from_field(
        magnetization: &[Vector3],
        h_eff: &[Vector3],
    ) -> Vec<Vector3> {
        magnetization
            .iter()
            .zip(h_eff.iter())
            .map(|(m, h)| {
                let m_dot_h = dot(*m, *h);
                let projected = sub(*h, scale(*m, m_dot_h));
                scale(projected, -1.0)
            })
            .collect()
    }

    /// Compute total energy without building full observables (cheaper).
    pub fn total_energy_from_vectors_ws(
        &self,
        magnetization: &[Vector3],
        ws: &mut FftWorkspace,
    ) -> f64 {
        let mut total = 0.0;

        if self.terms.exchange {
            let h_ex = self.exchange_field_from_vectors(magnetization);
            total += self.exchange_energy_from_field(magnetization, &h_ex);
        }
        if self.terms.demag {
            let h_demag = self.demag_field_from_vectors_ws(magnetization, ws);
            total += self.demag_energy_from_fields(magnetization, &h_demag);
        }
        if self.terms.external_field.is_some() {
            let h_ext = self.external_field_vectors();
            total += self.external_energy_from_fields(magnetization, &h_ext);
        }

        total
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

    /// Cached observables from a single RHS evaluation.
    /// Avoids recomputing fields for the StepReport.
    fn llg_rhs_full_ws(
        &self,
        magnetization: &[Vector3],
        ws: &mut FftWorkspace,
    ) -> (Vec<Vector3>, RhsEvaluation) {
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

        let rhs: Vec<Vector3> = magnetization
            .iter()
            .zip(effective_field.iter())
            .map(|(m, h)| self.llg_rhs_from_field(*m, *h))
            .collect();

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

        let eval = RhsEvaluation {
            exchange_energy_joules,
            demag_energy_joules,
            external_energy_joules,
            total_energy_joules: exchange_energy_joules
                + demag_energy_joules
                + external_energy_joules,
            max_effective_field_amplitude: max_norm(&effective_field),
            max_demag_field_amplitude: max_norm(&demag_field),
            max_rhs_amplitude: max_norm(&rhs),
        };

        (rhs, eval)
    }

    fn llg_rhs_from_field(&self, magnetization: Vector3, field: Vector3) -> Vector3 {
        let alpha = self.material.damping;
        let gamma_bar = self.dynamics.gyromagnetic_ratio / (1.0 + alpha * alpha);
        let precession = cross(magnetization, field);
        let damping = cross(magnetization, precession);
        let precession_term = if self.dynamics.precession_enabled {
            precession
        } else {
            [0.0, 0.0, 0.0]
        };
        scale(add(precession_term, scale(damping, alpha)), -gamma_bar)
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

#[allow(deprecated)] // Intentionally uses step() for simplicity in this demo helper
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
        dt_used: dt,
        step_rejected: false,
        suggested_next_dt: None,
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

// Vector math utilities — re-exported from vector module
pub use vector::{add, cross, dot, max_norm, norm, normalized, scale, squared_norm, sub};

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
    fn damping_only_relaxation_disables_transverse_precession() {
        let mut problem = zeeman_problem([0.0, 0.0, 1.0]);
        problem.dynamics = problem.dynamics.with_precession_enabled(false);
        let mut state = problem
            .new_state(vec![[1.0, 0.0, 0.0], [1.0, 0.0, 0.0]])
            .expect("state should build");

        problem.step(&mut state, 1e-3).expect("step should succeed");

        assert!(
            state.magnetization()[0][1].abs() <= 1e-12,
            "pure-damping relax should not precess into y, got {:?}",
            state.magnetization()[0]
        );
        assert!(
            state.magnetization()[0][2] > 0.0,
            "pure-damping relax should move toward the field, got {:?}",
            state.magnetization()[0]
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
