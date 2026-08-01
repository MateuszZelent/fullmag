//! FFT workspace, Newell kernel spectra, and 3D FFT transforms for spectral demag.

use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};
use std::sync::Arc;

use crate::fdm::shared::types::{AxisBoundary, FdmBoundaryPolicy, ResolvedFdmPeriodicWorkspace};

use crate::newell;
use crate::Vector3;

// ── FftWorkspace ───────────────────────────────────────────────────────

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
    pub(crate) fwd_x: Arc<dyn Fft<f64>>,
    pub(crate) fwd_y: Arc<dyn Fft<f64>>,
    pub(crate) fwd_z: Arc<dyn Fft<f64>>,
    pub(crate) inv_x: Arc<dyn Fft<f64>>,
    pub(crate) inv_y: Arc<dyn Fft<f64>>,
    pub(crate) inv_z: Arc<dyn Fft<f64>>,
    /// Padded grid dimensions (2×N per axis).
    pub px: usize,
    pub py: usize,
    pub pz: usize,
    /// Re-usable scratch line buffers.
    pub(crate) line_y: Vec<Complex<f64>>,
    pub(crate) line_z: Vec<Complex<f64>>,
    /// Re-usable padded frequency-domain buffers (avoids allocation per demag call).
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
    let estimated_bytes = padded_cells
        .checked_mul(12)
        .and_then(|value| value.checked_mul(2))
        .and_then(|value| value.checked_mul(8))
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
            nx,
            ny,
            nz,
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

        let px = if pbc_x { nx } else { nx * 2 };
        let py = if pbc_y { ny } else { ny * 2 };
        let pz = if pbc_z { nz } else { nz * 2 };
        let padded_len = px * py * pz;
        let mut planner = FftPlanner::<f64>::new();
        let zero = Complex::new(0.0, 0.0);

        let fwd_x = planner.plan_fft_forward(px);
        let fwd_y = planner.plan_fft_forward(py);
        let fwd_z = planner.plan_fft_forward(pz);

        // Compute periodic kernel via truncated images:
        // N^pbc(r) = Σ_{|n_i| ≤ I_i on periodic axes} N^open(r + n · L)
        let nk = compute_periodic_newell_kernels(
            nx,
            ny,
            nz,
            dx,
            dy,
            dz,
            [pbc_x, pbc_y, pbc_z],
            image_counts,
        );

        let fft_kernel = |real: Vec<f64>| -> Vec<Complex<f64>> {
            let mut buf: Vec<Complex<f64>> =
                real.into_iter().map(|v| Complex::new(v, 0.0)).collect();
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
            nx,
            ny,
            nz,
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

    /// Zero out only the three M frequency-domain buffers.
    ///
    /// H buffers (buf_hx/hy/hz) are fully overwritten by the spectral
    /// tensor multiply and therefore do not need pre-zeroing.
    pub(crate) fn clear_m_bufs(&mut self) {
        let zero = Complex::new(0.0, 0.0);
        #[cfg(feature = "parallel")]
        {
            use rayon::prelude::*;
            self.buf_mx.par_iter_mut().for_each(|v| *v = zero);
            self.buf_my.par_iter_mut().for_each(|v| *v = zero);
            self.buf_mz.par_iter_mut().for_each(|v| *v = zero);
        }
        #[cfg(not(feature = "parallel"))]
        {
            for v in self
                .buf_mx
                .iter_mut()
                .chain(self.buf_my.iter_mut())
                .chain(self.buf_mz.iter_mut())
            {
                *v = zero;
            }
        }
    }

    /// Forward FFT on the three M-component buffers (buf_mx, buf_my, buf_mz).
    pub(crate) fn fft3_m_forward(&mut self) {
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
    pub(crate) fn fft3_h_inverse(&mut self) {
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

// ── Newell kernel spectra helpers ──────────────────────────────────────

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
    _line_y: &mut [Complex<f64>],
    _line_z: &mut [Complex<f64>],
) {
    #[cfg(feature = "parallel")]
    {
        use rayon::prelude::*;
        use std::cell::RefCell;

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
        // X-axis transforms (contiguous in memory)
        for z in 0..nz {
            for y in 0..ny {
                let start = padded_index(nx, ny, 0, y, z);
                fft_x.process(&mut data[start..start + nx]);
            }
        }

        // Y-axis transforms (strided, use scratch line)
        let mut line_y_buf = vec![Complex::new(0.0, 0.0); ny];
        for z in 0..nz {
            for x in 0..nx {
                for y in 0..ny {
                    line_y_buf[y] = data[padded_index(nx, ny, x, y, z)];
                }
                fft_y.process(&mut line_y_buf);
                for y in 0..ny {
                    data[padded_index(nx, ny, x, y, z)] = line_y_buf[y];
                }
            }
        }

        // Z-axis transforms (strided, use scratch line)
        let mut line_z_buf = vec![Complex::new(0.0, 0.0); nz];
        for y in 0..ny {
            for x in 0..nx {
                for z in 0..nz {
                    line_z_buf[z] = data[padded_index(nx, ny, x, y, z)];
                }
                fft_z.process(&mut line_z_buf);
                for z in 0..nz {
                    data[padded_index(nx, ny, x, y, z)] = line_z_buf[z];
                }
            }
        }
    }
}

/// 3D FFT using cached workspace plans (avoids per-call FftPlanner).
#[allow(dead_code)]
pub(crate) fn fft3_with_workspace(data: &mut [Complex<f64>], ws: &mut FftWorkspace, inverse: bool) {
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
