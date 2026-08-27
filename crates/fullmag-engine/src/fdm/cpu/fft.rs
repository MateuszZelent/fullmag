//! FFT workspace, Newell kernel spectra, and 3D FFT transforms for spectral demag.

use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};
use sha2::{Digest, Sha256};
use std::{mem::size_of, time::Instant};

use super::r2c::R2c3dPlan;
use crate::fdm::shared::types::{AxisBoundary, FdmBoundaryPolicy, ResolvedFdmPeriodicWorkspace};

use crate::newell;
use crate::Vector3;

// ── FftWorkspace ───────────────────────────────────────────────────────

pub const FDM_FFT_WORKSPACE_TELEMETRY_SCHEMA_VERSION: &str = "fullmag.fdm.fft_workspace.v2";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FftWorkspaceTelemetry {
    pub lifecycle_revision: u64,
    pub lifecycle_key_sha256: String,
    pub execution_thread_count: u32,
    pub plan_creation_time_ns: u64,
    /// Allocator-reserved bytes for real and complex buffers owned by the workspace.
    /// RustFFT and RealFFT do not expose the heap footprint of their opaque plan objects.
    pub workspace_bytes: u64,
    pub forward_fft_count: u64,
    pub inverse_fft_count: u64,
    pub fft_elapsed_time_ns: u64,
}

fn elapsed_ns(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_nanos()).unwrap_or(u64::MAX)
}

fn execution_thread_count() -> u32 {
    #[cfg(feature = "parallel")]
    {
        u32::try_from(rayon::current_num_threads()).unwrap_or(u32::MAX)
    }
    #[cfg(not(feature = "parallel"))]
    {
        1
    }
}

fn fft_workspace_key_sha256(
    cells: [usize; 3],
    cell_size: [f64; 3],
    periodic: [bool; 3],
    image_counts: [u32; 3],
    thread_count: u32,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(FDM_FFT_WORKSPACE_TELEMETRY_SCHEMA_VERSION.as_bytes());
    hasher.update(b"rustfft\0double\0half_spectrum_r2c");
    for value in cells {
        hasher.update(u64::try_from(value).unwrap_or(u64::MAX).to_le_bytes());
    }
    for value in cell_size {
        hasher.update(value.to_bits().to_le_bytes());
    }
    for value in periodic {
        hasher.update([u8::from(value)]);
    }
    for value in image_counts {
        hasher.update(value.to_le_bytes());
    }
    hasher.update(thread_count.to_le_bytes());
    format!("sha256:{:x}", hasher.finalize())
}

/// Cached FFT plans and scratch buffers for spectral demag.
///
/// Build once per grid via [`ExchangeLlgProblem::create_workspace`] and pass
/// into [`ExchangeLlgProblem::step`].  This avoids rebuilding `FftPlanner`
/// and re-planning every call to `demag_field_from_vectors`.
pub struct FftWorkspace {
    /// Physical grid dimensions before demag padding.
    pub(crate) nx: usize,
    pub(crate) ny: usize,
    pub(crate) nz: usize,
    transform: R2c3dPlan,
    /// Padded grid dimensions (2×N per axis).
    pub px: usize,
    pub py: usize,
    pub pz: usize,
    /// Stored X frequencies in the Hermitian half-spectrum.
    pub sx: usize,
    /// Re-usable padded real-domain buffers, shared by M input and H output.
    buf_rx: Vec<f64>,
    buf_ry: Vec<f64>,
    buf_rz: Vec<f64>,
    /// Re-usable half-spectrum buffers (avoids allocation per demag call).
    pub(crate) buf_mx: Vec<Complex<f64>>,
    pub(crate) buf_my: Vec<Complex<f64>>,
    pub(crate) buf_mz: Vec<Complex<f64>>,
    pub(crate) buf_hx: Vec<Complex<f64>>,
    pub(crate) buf_hy: Vec<Complex<f64>>,
    pub(crate) buf_hz: Vec<Complex<f64>>,
    /// Precomputed Newell kernel spectra (FFT of real-space demagnetization tensors).
    pub(crate) kern_xx: Vec<Complex<f64>>,
    pub(crate) kern_yy: Vec<Complex<f64>>,
    pub(crate) kern_zz: Vec<Complex<f64>>,
    pub(crate) kern_xy: Vec<Complex<f64>>,
    pub(crate) kern_xz: Vec<Complex<f64>>,
    pub(crate) kern_yz: Vec<Complex<f64>>,
    telemetry: FftWorkspaceTelemetry,
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

fn checked_workspace_budget(
    cells: [usize; 3],
    periodic: [bool; 3],
    image_counts: [u32; 3],
) -> Result<(), String> {
    checked_workspace_resolution(cells, periodic, image_counts).map(|_| ())
}

fn checked_workspace_resolution(
    cells: [usize; 3],
    periodic: [bool; 3],
    image_counts: [u32; 3],
) -> Result<ResolvedFdmPeriodicWorkspace, String> {
    let mut image_terms = 1_u64;
    let mut padded = [0_u64; 3];
    for axis in 0..3 {
        if cells[axis] == 0 {
            return Err(format!("grid count on axis {axis} must be positive"));
        }
        let cells_u64 = u64::try_from(cells[axis])
            .map_err(|_| format!("grid count on axis {axis} is not representable as u64"))?;
        padded[axis] = if periodic[axis] {
            cells_u64
        } else {
            cells_u64
                .checked_mul(2)
                .ok_or_else(|| format!("padded grid count overflow on axis {axis}"))?
        };
        if periodic[axis] {
            let span = u64::from(image_counts[axis])
                .checked_mul(2)
                .and_then(|value| value.checked_add(1))
                .ok_or_else(|| format!("periodic image count overflow on axis {axis}"))?;
            image_terms = image_terms
                .checked_mul(span)
                .ok_or_else(|| "periodic image term count overflow".to_string())?;
        }
    }
    const MAX_PERIODIC_IMAGE_TERMS: u64 = 1_000_000;
    if image_terms > MAX_PERIODIC_IMAGE_TERMS {
        return Err(format!(
            "periodic image budget exceeded: {image_terms} image terms > {MAX_PERIODIC_IMAGE_TERMS}"
        ));
    }
    let padded_cells = padded.iter().try_fold(1_u64, |acc, count| {
        acc.checked_mul(*count)
            .ok_or_else(|| "padded grid cell count overflow".to_string())
    })?;
    const MAX_WORKSPACE_BYTES: u64 = 8 * 1024 * 1024 * 1024;
    let spectral_x = padded[0] / 2 + 1;
    let spectral_cells = spectral_x
        .checked_mul(padded[1])
        .and_then(|value| value.checked_mul(padded[2]))
        .ok_or_else(|| "periodic half-spectrum cell count overflow".to_string())?;
    let real_buffer_bytes = padded_cells
        .checked_mul(3)
        .and_then(|value| value.checked_mul(8))
        .ok_or_else(|| "periodic real workspace byte estimate overflow".to_string())?;
    let spectral_buffer_bytes = spectral_cells
        .checked_mul(12)
        .and_then(|value| value.checked_mul(2))
        .and_then(|value| value.checked_mul(8))
        .ok_or_else(|| "periodic spectral workspace byte estimate overflow".to_string())?;
    let estimated_bytes = real_buffer_bytes
        .checked_add(spectral_buffer_bytes)
        .ok_or_else(|| "periodic FFT workspace byte estimate overflow".to_string())?;
    if estimated_bytes > MAX_WORKSPACE_BYTES {
        return Err(format!(
            "periodic FFT workspace budget exceeded: {estimated_bytes} bytes > {MAX_WORKSPACE_BYTES}"
        ));
    }
    Ok(ResolvedFdmPeriodicWorkspace {
        image_counts,
        padded_counts: padded,
        image_terms,
        estimated_bytes,
    })
}

impl FftWorkspace {
    pub fn try_new(
        nx: usize,
        ny: usize,
        nz: usize,
        dx: f64,
        dy: f64,
        dz: f64,
    ) -> Result<Self, String> {
        checked_workspace_budget([nx, ny, nz], [false; 3], [0, 0, 0])?;
        Ok(Self::new_unchecked(nx, ny, nz, dx, dy, dz))
    }

    pub fn new(nx: usize, ny: usize, nz: usize, dx: f64, dy: f64, dz: f64) -> Self {
        Self::try_new(nx, ny, nz, dx, dy, dz)
            .unwrap_or_else(|reason| panic!("FDM FFT workspace rejected: {reason}"))
    }

    fn new_unchecked(nx: usize, ny: usize, nz: usize, dx: f64, dy: f64, dz: f64) -> Self {
        let kernels = newell::compute_newell_kernels(nx, ny, nz, dx, dy, dz);
        Self::from_real_kernels(nx, ny, nz, dx, dy, dz, kernels, [false; 3], [0; 3])
    }

    #[allow(clippy::too_many_arguments)]
    fn from_real_kernels(
        nx: usize,
        ny: usize,
        nz: usize,
        dx: f64,
        dy: f64,
        dz: f64,
        kernels: newell::NewellKernels,
        periodic: [bool; 3],
        image_counts: [u32; 3],
    ) -> Self {
        let plan_started = Instant::now();
        let thread_count = execution_thread_count();
        let px = kernels.px;
        let py = kernels.py;
        let pz = kernels.pz;
        let padded_len = px * py * pz;
        let mut transform = R2c3dPlan::new(px, py, pz);
        let sx = transform.spectral_x_len();
        let spectral_len = transform.spectral_len();
        let zero = Complex::new(0.0, 0.0);

        let mut fft_kernel = |mut real: Vec<f64>| -> Vec<Complex<f64>> {
            let mut spectrum = vec![zero; spectral_len];
            transform.forward(&mut real, &mut spectrum);
            spectrum
        };
        let kern_xx = fft_kernel(kernels.n_xx);
        let kern_yy = fft_kernel(kernels.n_yy);
        let kern_zz = fft_kernel(kernels.n_zz);
        let kern_xy = fft_kernel(kernels.n_xy);
        let kern_xz = fft_kernel(kernels.n_xz);
        let kern_yz = fft_kernel(kernels.n_yz);
        drop(fft_kernel);

        let mut workspace = Self {
            nx,
            ny,
            nz,
            transform,
            px,
            py,
            pz,
            sx,
            buf_rx: vec![0.0; padded_len],
            buf_ry: vec![0.0; padded_len],
            buf_rz: vec![0.0; padded_len],
            buf_mx: vec![zero; spectral_len],
            buf_my: vec![zero; spectral_len],
            buf_mz: vec![zero; spectral_len],
            buf_hx: vec![zero; spectral_len],
            buf_hy: vec![zero; spectral_len],
            buf_hz: vec![zero; spectral_len],
            kern_xx,
            kern_yy,
            kern_zz,
            kern_xy,
            kern_xz,
            kern_yz,
            telemetry: FftWorkspaceTelemetry {
                lifecycle_revision: 1,
                lifecycle_key_sha256: fft_workspace_key_sha256(
                    [nx, ny, nz],
                    [dx, dy, dz],
                    periodic,
                    image_counts,
                    thread_count,
                ),
                execution_thread_count: thread_count,
                plan_creation_time_ns: 0,
                workspace_bytes: 0,
                forward_fft_count: 0,
                inverse_fft_count: 0,
                fft_elapsed_time_ns: 0,
            },
        };
        workspace.telemetry.plan_creation_time_ns = elapsed_ns(plan_started);
        workspace.telemetry.workspace_bytes = workspace.allocated_buffer_bytes();
        workspace
    }

    /// Create an FFT workspace with per-axis periodic boundary support.
    ///
    /// For periodic axes: padded size = N (no zero-padding).
    /// For open axes: padded size = 2*N (standard zero-padding).
    ///
    /// `image_counts` specifies how many image repetitions to include in
    /// each periodic axis for the truncated-images demag kernel.
    pub fn new_with_boundary(
        nx: usize,
        ny: usize,
        nz: usize,
        dx: f64,
        dy: f64,
        dz: f64,
        boundary: &FdmBoundaryPolicy,
        image_counts: [u32; 3],
    ) -> Self {
        Self::try_new_with_boundary(nx, ny, nz, dx, dy, dz, boundary, image_counts)
            .unwrap_or_else(|reason| panic!("FDM periodic FFT workspace rejected: {reason}"))
    }

    pub fn try_new_with_boundary(
        nx: usize,
        ny: usize,
        nz: usize,
        dx: f64,
        dy: f64,
        dz: f64,
        boundary: &FdmBoundaryPolicy,
        image_counts: [u32; 3],
    ) -> Result<Self, String> {
        let pbc_x = matches!(boundary.x, AxisBoundary::Periodic);
        let pbc_y = matches!(boundary.y, AxisBoundary::Periodic);
        let pbc_z = matches!(boundary.z, AxisBoundary::Periodic);

        checked_workspace_budget([nx, ny, nz], [pbc_x, pbc_y, pbc_z], image_counts)?;

        Ok(Self::new_with_boundary_unchecked(
            nx,
            ny,
            nz,
            dx,
            dy,
            dz,
            boundary,
            image_counts,
        ))
    }

    /// Construct a workspace only when the planner-resolved workspace
    /// contract exactly matches the dimensions and image policy supplied by
    /// the runner.  This keeps allocation fail-closed at the runtime boundary.
    pub fn try_new_with_boundary_and_resolution(
        nx: usize,
        ny: usize,
        nz: usize,
        dx: f64,
        dy: f64,
        dz: f64,
        boundary: &FdmBoundaryPolicy,
        image_counts: [u32; 3],
        resolved: &ResolvedFdmPeriodicWorkspace,
    ) -> Result<Self, String> {
        let expected = checked_workspace_resolution(
            [nx, ny, nz],
            [
                matches!(boundary.x, AxisBoundary::Periodic),
                matches!(boundary.y, AxisBoundary::Periodic),
                matches!(boundary.z, AxisBoundary::Periodic),
            ],
            image_counts,
        )?;
        if expected.image_counts != resolved.image_counts {
            return Err(format!(
                "resolved periodic workspace image_counts mismatch: expected {:?}, got {:?}",
                expected.image_counts, resolved.image_counts
            ));
        }
        if expected.padded_counts != resolved.padded_counts {
            return Err(format!(
                "resolved periodic workspace padded_counts mismatch: expected {:?}, got {:?}",
                expected.padded_counts, resolved.padded_counts
            ));
        }
        if expected.image_terms != resolved.image_terms {
            return Err(format!(
                "resolved periodic workspace image_terms mismatch: expected {}, got {}",
                expected.image_terms, resolved.image_terms
            ));
        }
        if expected.estimated_bytes != resolved.estimated_bytes {
            return Err(format!(
                "resolved periodic workspace estimated_bytes mismatch: expected {}, got {}",
                expected.estimated_bytes, resolved.estimated_bytes
            ));
        }
        Ok(Self::new_with_boundary_unchecked(
            nx,
            ny,
            nz,
            dx,
            dy,
            dz,
            boundary,
            image_counts,
        ))
    }

    fn new_with_boundary_unchecked(
        nx: usize,
        ny: usize,
        nz: usize,
        dx: f64,
        dy: f64,
        dz: f64,
        boundary: &FdmBoundaryPolicy,
        image_counts: [u32; 3],
    ) -> Self {
        let pbc_x = matches!(boundary.x, AxisBoundary::Periodic);
        let pbc_y = matches!(boundary.y, AxisBoundary::Periodic);
        let pbc_z = matches!(boundary.z, AxisBoundary::Periodic);
        let kernels = compute_periodic_newell_kernels(
            nx,
            ny,
            nz,
            dx,
            dy,
            dz,
            [pbc_x, pbc_y, pbc_z],
            image_counts,
        );
        Self::from_real_kernels(
            nx,
            ny,
            nz,
            dx,
            dy,
            dz,
            kernels,
            [pbc_x, pbc_y, pbc_z],
            image_counts,
        )
    }

    fn allocated_buffer_bytes(&self) -> u64 {
        let real_values = self
            .buf_rx
            .capacity()
            .saturating_add(self.buf_ry.capacity())
            .saturating_add(self.buf_rz.capacity());
        let complex_values = self
            .buf_mx
            .capacity()
            .saturating_add(self.buf_my.capacity())
            .saturating_add(self.buf_mz.capacity())
            .saturating_add(self.buf_hx.capacity())
            .saturating_add(self.buf_hy.capacity())
            .saturating_add(self.buf_hz.capacity())
            .saturating_add(self.kern_xx.capacity())
            .saturating_add(self.kern_yy.capacity())
            .saturating_add(self.kern_zz.capacity())
            .saturating_add(self.kern_xy.capacity())
            .saturating_add(self.kern_xz.capacity())
            .saturating_add(self.kern_yz.capacity());
        let owned = real_values
            .saturating_mul(size_of::<f64>())
            .saturating_add(complex_values.saturating_mul(size_of::<Complex<f64>>()));
        u64::try_from(owned)
            .unwrap_or(u64::MAX)
            .saturating_add(self.transform.owned_buffer_bytes())
    }

    pub fn telemetry(&self) -> FftWorkspaceTelemetry {
        self.telemetry.clone()
    }

    /// Zero out the three padded real-domain buffers before packing M.
    ///
    /// Spectrum and H buffers are fully overwritten by the transforms and
    /// tensor multiply and therefore do not need pre-zeroing.
    pub(crate) fn clear_m_bufs(&mut self) {
        #[cfg(feature = "parallel")]
        {
            use rayon::prelude::*;
            self.buf_rx.par_iter_mut().for_each(|value| *value = 0.0);
            self.buf_ry.par_iter_mut().for_each(|value| *value = 0.0);
            self.buf_rz.par_iter_mut().for_each(|value| *value = 0.0);
        }
        #[cfg(not(feature = "parallel"))]
        {
            for v in self
                .buf_rx
                .iter_mut()
                .chain(self.buf_ry.iter_mut())
                .chain(self.buf_rz.iter_mut())
            {
                *v = 0.0;
            }
        }
    }

    pub(crate) fn convolve_moments(&mut self, mut moment_at: impl FnMut(usize) -> Vector3) {
        self.clear_m_bufs();
        for z in 0..self.nz {
            for y in 0..self.ny {
                for x in 0..self.nx {
                    let source = x + self.nx * (y + self.ny * z);
                    let destination = padded_index(self.px, self.py, x, y, z);
                    let moment = moment_at(source);
                    self.buf_rx[destination] = moment[0];
                    self.buf_ry[destination] = moment[1];
                    self.buf_rz[destination] = moment[2];
                }
            }
        }

        self.fft3_m_forward();
        self.multiply_kernel_spectra();
        self.fft3_h_inverse();
    }

    pub(crate) fn convolved_field_at(&self, x: usize, y: usize, z: usize) -> Vector3 {
        let source = padded_index(self.px, self.py, x, y, z);
        let normalization = 1.0 / (self.px * self.py * self.pz) as f64;
        [
            self.buf_rx[source] * normalization,
            self.buf_ry[source] * normalization,
            self.buf_rz[source] * normalization,
        ]
    }

    fn multiply_kernel_spectra(&mut self) {
        #[cfg(feature = "parallel")]
        {
            use rayon::prelude::*;

            let (mx, my, mz) = (&self.buf_mx[..], &self.buf_my[..], &self.buf_mz[..]);
            let (kxx, kyy, kzz) = (&self.kern_xx[..], &self.kern_yy[..], &self.kern_zz[..]);
            let (kxy, kxz, kyz) = (&self.kern_xy[..], &self.kern_xz[..], &self.kern_yz[..]);
            self.buf_hx
                .par_iter_mut()
                .enumerate()
                .for_each(|(index, field)| {
                    *field =
                        -(kxx[index] * mx[index] + kxy[index] * my[index] + kxz[index] * mz[index]);
                });
            self.buf_hy
                .par_iter_mut()
                .enumerate()
                .for_each(|(index, field)| {
                    *field =
                        -(kxy[index] * mx[index] + kyy[index] * my[index] + kyz[index] * mz[index]);
                });
            self.buf_hz
                .par_iter_mut()
                .enumerate()
                .for_each(|(index, field)| {
                    *field =
                        -(kxz[index] * mx[index] + kyz[index] * my[index] + kzz[index] * mz[index]);
                });
        }
        #[cfg(not(feature = "parallel"))]
        {
            for index in 0..self.buf_mx.len() {
                let mx = self.buf_mx[index];
                let my = self.buf_my[index];
                let mz = self.buf_mz[index];
                self.buf_hx[index] = -(self.kern_xx[index] * mx
                    + self.kern_xy[index] * my
                    + self.kern_xz[index] * mz);
                self.buf_hy[index] = -(self.kern_xy[index] * mx
                    + self.kern_yy[index] * my
                    + self.kern_yz[index] * mz);
                self.buf_hz[index] = -(self.kern_xz[index] * mx
                    + self.kern_yz[index] * my
                    + self.kern_zz[index] * mz);
            }
        }
    }

    /// Forward FFT on the three M-component buffers (buf_mx, buf_my, buf_mz).
    pub(crate) fn fft3_m_forward(&mut self) {
        let started = Instant::now();
        self.transform.forward(&mut self.buf_rx, &mut self.buf_mx);
        self.transform.forward(&mut self.buf_ry, &mut self.buf_my);
        self.transform.forward(&mut self.buf_rz, &mut self.buf_mz);
        self.telemetry.forward_fft_count = self.telemetry.forward_fft_count.saturating_add(3);
        self.telemetry.fft_elapsed_time_ns = self
            .telemetry
            .fft_elapsed_time_ns
            .saturating_add(elapsed_ns(started));
    }

    /// Inverse FFT on the three H-component buffers (buf_hx, buf_hy, buf_hz).
    pub(crate) fn fft3_h_inverse(&mut self) {
        let started = Instant::now();
        self.transform.inverse(&mut self.buf_hx, &mut self.buf_rx);
        self.transform.inverse(&mut self.buf_hy, &mut self.buf_ry);
        self.transform.inverse(&mut self.buf_hz, &mut self.buf_rz);
        self.telemetry.inverse_fft_count = self.telemetry.inverse_fft_count.saturating_add(3);
        self.telemetry.fft_elapsed_time_ns = self
            .telemetry
            .fft_elapsed_time_ns
            .saturating_add(elapsed_ns(started));
    }
}

// ── Newell kernel spectra helpers ──────────────────────────────────────

fn flatten_full_spectrum(
    half: &[Complex<f64>],
    px: usize,
    py: usize,
    pz: usize,
    sx: usize,
) -> Vec<f64> {
    let mut flat = Vec::with_capacity(px * py * pz * 2);
    for z in 0..pz {
        for y in 0..py {
            for x in 0..px {
                let value = if x < sx {
                    half[padded_index(sx, py, x, y, z)]
                } else {
                    let mirrored_x = px - x;
                    let mirrored_y = (py - y) % py;
                    let mirrored_z = (pz - z) % pz;
                    half[padded_index(sx, py, mirrored_x, mirrored_y, mirrored_z)].conj()
                };
                flat.push(value.re);
                flat.push(value.im);
            }
        }
    }
    flat
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
    let flatten = |values| {
        flatten_full_spectrum(
            values,
            workspace.px,
            workspace.py,
            workspace.pz,
            workspace.sx,
        )
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

pub fn compute_periodic_newell_kernel_spectra(
    nx: usize,
    ny: usize,
    nz: usize,
    dx: f64,
    dy: f64,
    dz: f64,
    periodic: [bool; 3],
    image_counts: [u32; 3],
) -> DemagKernelSpectra {
    let boundary = FdmBoundaryPolicy {
        x: if periodic[0] {
            AxisBoundary::Periodic
        } else {
            AxisBoundary::Open
        },
        y: if periodic[1] {
            AxisBoundary::Periodic
        } else {
            AxisBoundary::Open
        },
        z: if periodic[2] {
            AxisBoundary::Periodic
        } else {
            AxisBoundary::Open
        },
    };
    let workspace =
        FftWorkspace::new_with_boundary(nx, ny, nz, dx, dy, dz, &boundary, image_counts);
    let flatten = |values| {
        flatten_full_spectrum(
            values,
            workspace.px,
            workspace.py,
            workspace.pz,
            workspace.sx,
        )
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

// ── Free FFT functions ─────────────────────────────────────────────────

/// Core 3D FFT: operates on an external data slice using explicit plan/scratch refs.
///
/// When the `parallel` feature is enabled, the Y-axis and Z-axis transforms
/// are parallelised across independent lines using Rayon.  Each thread
/// allocates a thread-local scratch buffer (O(max(ny, nz))) so that lines
/// within the same z-slab / y-slab can be processed concurrently.
/// The X-axis transforms are **always already contiguous** in memory and are
/// parallelised trivially (each row is independent).
pub(crate) fn fft3_core(
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
    #[cfg(feature = "parallel")]
    {
        use rayon::prelude::*;
        use std::cell::RefCell;

        let _ = (line_y, line_z);

        // Cast the mutable pointer to usize so it is Send+Sync and can be
        // shared across Rayon closures.  We convert back inside each closure.
        // SAFETY: the caller guarantees non-overlapping per-thread access.
        let data_base: usize = data.as_mut_ptr() as usize;
        let data_len = data.len();

        // ---- X-axis transforms: rows are contiguous, each (y,z) row independent ----
        let row_count = ny * nz;
        unsafe {
            (0..row_count).into_par_iter().for_each(|row_idx| {
                let start = row_idx * nx;
                debug_assert!(start + nx <= data_len);
                let ptr = data_base as *mut Complex<f64>;
                let row = std::slice::from_raw_parts_mut(ptr.add(start), nx);
                fft_x.process(row);
            });
        }

        // ---- Y-axis transforms: strided, gather/scatter with thread-local scratch ----
        thread_local! {
            static LINE_Y: RefCell<Vec<Complex<f64>>> = const { RefCell::new(Vec::new()) };
        }
        let col_count_y = nz * nx;
        unsafe {
            (0..col_count_y).into_par_iter().for_each(|col_idx| {
                let z = col_idx / nx;
                let x = col_idx % nx;
                let ptr = data_base as *mut Complex<f64>;
                LINE_Y.with(|cell| {
                    let mut line = cell.borrow_mut();
                    if line.len() < ny {
                        line.resize(ny, Complex::new(0.0, 0.0));
                    }
                    for y in 0..ny {
                        line[y] = *ptr.add(padded_index(nx, ny, x, y, z));
                    }
                    fft_y.process(&mut line[..ny]);
                    for y in 0..ny {
                        *ptr.add(padded_index(nx, ny, x, y, z)) = line[y];
                    }
                });
            });
        }

        // ---- Z-axis transforms: strided, gather/scatter with thread-local scratch ----
        thread_local! {
            static LINE_Z: RefCell<Vec<Complex<f64>>> = const { RefCell::new(Vec::new()) };
        }
        let col_count_z = ny * nx;
        unsafe {
            (0..col_count_z).into_par_iter().for_each(|col_idx| {
                let y = col_idx / nx;
                let x = col_idx % nx;
                let ptr = data_base as *mut Complex<f64>;
                LINE_Z.with(|cell| {
                    let mut line = cell.borrow_mut();
                    if line.len() < nz {
                        line.resize(nz, Complex::new(0.0, 0.0));
                    }
                    for z in 0..nz {
                        line[z] = *ptr.add(padded_index(nx, ny, x, y, z));
                    }
                    fft_z.process(&mut line[..nz]);
                    for z in 0..nz {
                        *ptr.add(padded_index(nx, ny, x, y, z)) = line[z];
                    }
                });
            });
        }
    }

    #[cfg(not(feature = "parallel"))]
    {
        debug_assert!(line_y.len() >= ny);
        debug_assert!(line_z.len() >= nz);

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
                fft_y.process(&mut line_y[..ny]);
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
                fft_z.process(&mut line_z[..nz]);
                for z in 0..nz {
                    data[padded_index(nx, ny, x, y, z)] = line_z[z];
                }
            }
        }
    }
}

/// Legacy full-complex 3D FFT retained for tests and compatibility helpers.
#[allow(dead_code)]
pub(crate) fn fft3_with_workspace(data: &mut [Complex<f64>], ws: &mut FftWorkspace, inverse: bool) {
    let mut planner = FftPlanner::<f64>::new();
    let (fft_x, fft_y, fft_z) = if inverse {
        (
            planner.plan_fft_inverse(ws.px),
            planner.plan_fft_inverse(ws.py),
            planner.plan_fft_inverse(ws.pz),
        )
    } else {
        (
            planner.plan_fft_forward(ws.px),
            planner.plan_fft_forward(ws.py),
            planner.plan_fft_forward(ws.pz),
        )
    };
    let mut line_y = vec![Complex::new(0.0, 0.0); ws.py];
    let mut line_z = vec![Complex::new(0.0, 0.0); ws.pz];
    fft3_core(
        data,
        ws.px,
        ws.py,
        ws.pz,
        &*fft_x,
        &*fft_y,
        &*fft_z,
        &mut line_y,
        &mut line_z,
    );
}

/// Legacy wrapper — creates workspace on the fly (used only in tests).
#[allow(dead_code)]
pub(crate) fn fft3_in_place(
    data: &mut [Complex<f64>],
    nx: usize,
    ny: usize,
    nz: usize,
    inverse: bool,
) {
    let mut ws = FftWorkspace::new(nx / 2, ny / 2, nz / 2, 1.0, 1.0, 1.0);
    fft3_with_workspace(data, &mut ws, inverse);
}

pub(crate) fn padded_index(nx: usize, ny: usize, x: usize, y: usize, z: usize) -> usize {
    x + nx * (y + ny * z)
}

// ── Utility ────────────────────────────────────────────────────────────

/// Allocate a vector of zero 3-vectors.
pub(crate) fn zero_vectors(len: usize) -> Vec<Vector3> {
    vec![[0.0, 0.0, 0.0]; len]
}

#[cfg(test)]
mod normalization_tests {
    use super::{compute_newell_kernel_spectra, fft3_core, padded_index};
    use crate::newell;
    use rustfft::{num_complex::Complex, FftPlanner};
    use std::f64::consts::TAU;

    fn direct_dft_3d(input: &[Complex<f64>], nx: usize, ny: usize, nz: usize) -> Vec<Complex<f64>> {
        let mut output = vec![Complex::new(0.0, 0.0); input.len()];
        for kz in 0..nz {
            for ky in 0..ny {
                for kx in 0..nx {
                    let mut sum = Complex::new(0.0, 0.0);
                    for z in 0..nz {
                        for y in 0..ny {
                            for x in 0..nx {
                                let phase = -TAU
                                    * ((kx * x) as f64 / nx as f64
                                        + (ky * y) as f64 / ny as f64
                                        + (kz * z) as f64 / nz as f64);
                                sum += input[padded_index(nx, ny, x, y, z)]
                                    * Complex::new(phase.cos(), phase.sin());
                            }
                        }
                    }
                    output[padded_index(nx, ny, kx, ky, kz)] = sum;
                }
            }
        }
        output
    }

    fn assert_complex_close(actual: Complex<f64>, expected: Complex<f64>, tolerance: f64) {
        let error = (actual - expected).norm();
        let scale = expected.norm().max(1.0);
        assert!(
            error <= tolerance * scale,
            "actual={actual:?} expected={expected:?} error={error} tolerance={tolerance}"
        );
    }

    #[test]
    fn fft3_matches_direct_dft_and_round_trip_normalization() {
        let [nx, ny, nz] = [3, 2, 2];
        let original: Vec<_> = (0..nx * ny * nz)
            .map(|index| {
                let value = index as f64;
                Complex::new((0.37 * value).sin() + 0.1 * value, (0.23 * value).cos())
            })
            .collect();
        let expected_forward = direct_dft_3d(&original, nx, ny, nz);

        let mut planner = FftPlanner::<f64>::new();
        let forward_x = planner.plan_fft_forward(nx);
        let forward_y = planner.plan_fft_forward(ny);
        let forward_z = planner.plan_fft_forward(nz);
        let inverse_x = planner.plan_fft_inverse(nx);
        let inverse_y = planner.plan_fft_inverse(ny);
        let inverse_z = planner.plan_fft_inverse(nz);
        let mut line_y = vec![Complex::new(0.0, 0.0); ny];
        let mut line_z = vec![Complex::new(0.0, 0.0); nz];
        let mut transformed = original.clone();

        fft3_core(
            &mut transformed,
            nx,
            ny,
            nz,
            &*forward_x,
            &*forward_y,
            &*forward_z,
            &mut line_y,
            &mut line_z,
        );
        for (actual, expected) in transformed.iter().zip(&expected_forward) {
            assert_complex_close(*actual, *expected, 2e-12);
        }

        fft3_core(
            &mut transformed,
            nx,
            ny,
            nz,
            &*inverse_x,
            &*inverse_y,
            &*inverse_z,
            &mut line_y,
            &mut line_z,
        );
        let normalization = (nx * ny * nz) as f64;
        for (actual, expected) in transformed.iter().zip(&original) {
            assert_complex_close(*actual / normalization, *expected, 2e-12);
        }
    }

    #[test]
    fn expanded_r2c_kernel_spectra_match_full_complex_fft_layout() {
        let [nx, ny, nz] = [3, 2, 1];
        let [px, py, pz] = [nx * 2, ny * 2, nz * 2];
        let spectra = compute_newell_kernel_spectra(nx, ny, nz, 1.0, 1.0, 1.0);
        let kernels = newell::compute_newell_kernels(nx, ny, nz, 1.0, 1.0, 1.0);
        let mut planner = FftPlanner::<f64>::new();
        let forward_x = planner.plan_fft_forward(px);
        let forward_y = planner.plan_fft_forward(py);
        let forward_z = planner.plan_fft_forward(pz);

        for (real, expanded) in [
            (kernels.n_xx, spectra.n_xx),
            (kernels.n_yy, spectra.n_yy),
            (kernels.n_zz, spectra.n_zz),
            (kernels.n_xy, spectra.n_xy),
            (kernels.n_xz, spectra.n_xz),
            (kernels.n_yz, spectra.n_yz),
        ] {
            let mut expected: Vec<_> = real
                .into_iter()
                .map(|value| Complex::new(value, 0.0))
                .collect();
            let mut line_y = vec![Complex::new(0.0, 0.0); py];
            let mut line_z = vec![Complex::new(0.0, 0.0); pz];
            fft3_core(
                &mut expected,
                px,
                py,
                pz,
                &*forward_x,
                &*forward_y,
                &*forward_z,
                &mut line_y,
                &mut line_z,
            );
            assert_eq!(expanded.len(), expected.len() * 2);
            for (index, expected) in expected.into_iter().enumerate() {
                let actual = Complex::new(expanded[index * 2], expanded[index * 2 + 1]);
                assert_complex_close(actual, expected, 3e-12);
            }
        }
    }
}

/// Compute PBC Newell kernels via truncated images.
///
/// For each cell offset `(i, j, k)` in the padded grid `(px × py × pz)`:
///   `N^pbc(i,j,k) = Σ N^open(i + n_x·Nx, j + n_y·Ny, k + n_z·Nz)`
/// where the sum runs over `n_α ∈ {-I_α, ..., I_α}` for periodic axes
/// and `n_α = 0` for open axes.
///
/// We compute the open-boundary kernel on a large grid that covers
/// all images, then fold contributions back.
fn compute_periodic_newell_kernels(
    nx: usize,
    ny: usize,
    nz: usize,
    dx: f64,
    dy: f64,
    dz: f64,
    periodic: [bool; 3],
    images: [u32; 3],
) -> newell::NewellKernels {
    let px = if periodic[0] { nx } else { 2 * nx };
    let py = if periodic[1] { ny } else { 2 * ny };
    let pz = if periodic[2] { nz } else { 2 * nz };
    let padded_len = px * py * pz;

    // Number of images per axis: 0 for open, images[i] for periodic.
    let ix = if periodic[0] { images[0] as i32 } else { 0 };
    let iy = if periodic[1] { images[1] as i32 } else { 0 };
    let iz = if periodic[2] { images[2] as i32 } else { 0 };

    // Compute the open-boundary kernel on a grid large enough to cover
    // all images: extended_N = N + 2 * images * N = N * (1 + 2*images).
    let enx = nx * (1 + 2 * ix as usize);
    let eny = ny * (1 + 2 * iy as usize);
    let enz = nz * (1 + 2 * iz as usize);
    let nk_open = newell::compute_newell_kernels(enx, eny, enz, dx, dy, dz);
    let epx = 2 * enx;
    let epy = 2 * eny;
    let _epz = 2 * enz;

    let mut n_xx = vec![0.0_f64; padded_len];
    let mut n_yy = vec![0.0_f64; padded_len];
    let mut n_zz = vec![0.0_f64; padded_len];
    let mut n_xy = vec![0.0_f64; padded_len];
    let mut n_xz = vec![0.0_f64; padded_len];
    let mut n_yz = vec![0.0_f64; padded_len];

    // For each offset in the padded grid, fold contributions from images.
    for k in 0..pz {
        for j in 0..py {
            for i in 0..px {
                let dst = i + px * (j + py * k);
                let mut sum_xx = 0.0_f64;
                let mut sum_yy = 0.0_f64;
                let mut sum_zz = 0.0_f64;
                let mut sum_xy = 0.0_f64;
                let mut sum_xz = 0.0_f64;
                let mut sum_yz = 0.0_f64;

                for niz in -iz..=iz {
                    for niy in -iy..=iy {
                        for nix in -ix..=ix {
                            // Image offset in cells.
                            let gi = i as i32 + nix * nx as i32;
                            let gj = j as i32 + niy * ny as i32;
                            let gk = k as i32 + niz * nz as i32;

                            // Map to the open-boundary extended kernel grid.
                            // The open kernel is stored in a 2N-padded grid
                            // with periodic wrap-around indexing.
                            let ei = gi.rem_euclid(epx as i32) as usize;
                            let ej = gj.rem_euclid(epy as i32) as usize;
                            let ek = gk.rem_euclid(_epz as i32) as usize;
                            let src = ei + epx * (ej + epy * ek);

                            sum_xx += nk_open.n_xx[src];
                            sum_yy += nk_open.n_yy[src];
                            sum_zz += nk_open.n_zz[src];
                            sum_xy += nk_open.n_xy[src];
                            sum_xz += nk_open.n_xz[src];
                            sum_yz += nk_open.n_yz[src];
                        }
                    }
                }

                n_xx[dst] = sum_xx;
                n_yy[dst] = sum_yy;
                n_zz[dst] = sum_zz;
                n_xy[dst] = sum_xy;
                n_xz[dst] = sum_xz;
                n_yz[dst] = sum_yz;
            }
        }
    }

    newell::NewellKernels {
        n_xx,
        n_yy,
        n_zz,
        n_xy,
        n_xz,
        n_yz,
        px,
        py,
        pz,
    }
}

/// Combine 4 field contributions into H_eff.
pub(crate) fn combine_fields_4(
    exchange_field: &[Vector3],
    demag_field: &[Vector3],
    external_field: &[Vector3],
    mel_field: &[Vector3],
) -> Vec<Vector3> {
    use crate::add;
    #[cfg(feature = "parallel")]
    {
        use rayon::prelude::*;
        (0..exchange_field.len())
            .into_par_iter()
            .map(|i| {
                add(
                    add(add(exchange_field[i], demag_field[i]), external_field[i]),
                    mel_field[i],
                )
            })
            .collect()
    }
    #[cfg(not(feature = "parallel"))]
    {
        (0..exchange_field.len())
            .map(|i| {
                add(
                    add(add(exchange_field[i], demag_field[i]), external_field[i]),
                    mel_field[i],
                )
            })
            .collect()
    }
}
