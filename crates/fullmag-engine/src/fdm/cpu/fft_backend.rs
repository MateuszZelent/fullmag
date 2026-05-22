//! FFT backend abstraction for FDM spectral demag.
//!
//! The `FdmFftBackend` trait decouples the demag convolution from the
//! concrete FFT implementation.  The default `RustFftBackend` wraps the
//! existing `rustfft` 6.x plans.  Future backends (FFTW, MKL, cuFFT,
//! distributed heFFTe/MPI) implement the same trait.

use crate::VectorFieldSoA;

/// Pre-computed Newell kernel spectra for demag convolution.
///
/// Backends receive this so they can apply the spectral tensor multiply.
/// The data format is interleaved complex: [re0, im0, re1, im1, …].
pub use super::fft::DemagKernelSpectra;

// ──────────────────────────────────────────────────────────────────────
// Backend trait
// ──────────────────────────────────────────────────────────────────────

/// Abstraction over FFT-based demag convolution.
///
/// A backend owns its plans, scratch buffers, and padded-domain storage.
/// The caller provides **physical-domain** normalised SoA magnetisation;
/// the backend performs:
///
///   1. pack (physical → padded),
///   2. forward FFT,
///   3. spectral tensor multiply,
///   4. inverse FFT,
///   5. unpack + accumulate into `out_h`.
///
pub trait FdmFftBackend: Send + Sync {
    /// Execute the full demag convolution: M → H_demag, accumulated into
    /// `out_h`. `m` contains **normalised** magnetisation, while
    /// `saturation_magnetisation` and `active_mask` carry the physical
    /// scaling and active-domain contract into the backend pack step.
    fn convolve_demag(
        &mut self,
        m: &VectorFieldSoA,
        saturation_magnetisation: f64,
        active_mask: Option<&[bool]>,
        out_h: &mut VectorFieldSoA,
    );

    /// Human-readable name, e.g. "rustfft", "fftw", "cufft".
    fn name(&self) -> &'static str;
}

// ──────────────────────────────────────────────────────────────────────
// RustFftBackend — wraps the existing FftWorkspace
// ──────────────────────────────────────────────────────────────────────

use super::fft::FftWorkspace;

/// Default CPU backend using `rustfft` 6.x with Rayon parallelism on
/// the `parallel` feature flag.
pub struct RustFftBackend {
    pub(crate) ws: FftWorkspace,
}

impl RustFftBackend {
    /// Build a new backend for the given physical grid.
    ///
    /// `ws` must already be initialised with matching padded dimensions.
    pub fn new(ws: FftWorkspace, _nx: usize, _ny: usize, _nz: usize) -> Self {
        Self { ws }
    }

    /// Borrow the inner `FftWorkspace` (for legacy code that still needs it).
    pub fn workspace_mut(&mut self) -> &mut FftWorkspace {
        &mut self.ws
    }
}

use rustfft::num_complex::Complex;

/// Helper: padded linear index from (x,y,z) with padded row stride `px` and `py`.
#[inline]
fn padded_index(px: usize, py: usize, x: usize, y: usize, z: usize) -> usize {
    x + px * (y + py * z)
}

impl FdmFftBackend for FftWorkspace {
    fn convolve_demag(
        &mut self,
        m: &VectorFieldSoA,
        saturation_magnetisation: f64,
        active_mask: Option<&[bool]>,
        out_h: &mut VectorFieldSoA,
    ) {
        debug_assert_eq!(m.len(), self.nx * self.ny * self.nz);
        if let Some(mask) = active_mask {
            debug_assert_eq!(mask.len(), m.len());
        }

        let px = self.px;
        let py = self.py;
        let padded_len = px * py * self.pz;

        // 1. Clear M buffers (H buffers overwritten by tensor multiply)
        self.clear_m_bufs();

        // 2. Pack physical → padded
        for z in 0..self.nz {
            for y in 0..self.ny {
                for x in 0..self.nx {
                    let src = x + self.nx * (y + self.ny * z);
                    let dst = padded_index(px, py, x, y, z);
                    if active_mask.map(|mask| mask[src]).unwrap_or(true) {
                        self.buf_mx[dst] = Complex::new(m.x[src] * saturation_magnetisation, 0.0);
                        self.buf_my[dst] = Complex::new(m.y[src] * saturation_magnetisation, 0.0);
                        self.buf_mz[dst] = Complex::new(m.z[src] * saturation_magnetisation, 0.0);
                    }
                }
            }
        }

        // 3. Forward FFT
        self.fft3_m_forward();

        // 4. Spectral tensor multiply (uses ws.kern_* which were precomputed)
        #[cfg(feature = "parallel")]
        {
            use rayon::prelude::*;
            let (mx_sl, my_sl, mz_sl) = (&self.buf_mx[..], &self.buf_my[..], &self.buf_mz[..]);
            let (kxx, kyy, kzz) = (&self.kern_xx[..], &self.kern_yy[..], &self.kern_zz[..]);
            let (kxy, kxz, kyz) = (&self.kern_xy[..], &self.kern_xz[..], &self.kern_yz[..]);
            let hx = &mut self.buf_hx[..];
            let hy = &mut self.buf_hy[..];
            let hz = &mut self.buf_hz[..];
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
                let mx = self.buf_mx[i];
                let my = self.buf_my[i];
                let mz = self.buf_mz[i];
                self.buf_hx[i] =
                    -(self.kern_xx[i] * mx + self.kern_xy[i] * my + self.kern_xz[i] * mz);
                self.buf_hy[i] =
                    -(self.kern_xy[i] * mx + self.kern_yy[i] * my + self.kern_yz[i] * mz);
                self.buf_hz[i] =
                    -(self.kern_xz[i] * mx + self.kern_yz[i] * my + self.kern_zz[i] * mz);
            }
        }

        // 5. Inverse FFT
        self.fft3_h_inverse();

        // 6. Unpack + accumulate into out_h
        let norm = 1.0 / padded_len as f64;
        for z in 0..self.nz {
            for y in 0..self.ny {
                for x in 0..self.nx {
                    let src = padded_index(px, py, x, y, z);
                    let dst = x + self.nx * (y + self.ny * z);
                    if active_mask.map(|mask| mask[dst]).unwrap_or(true) {
                        out_h.x[dst] += self.buf_hx[src].re * norm;
                        out_h.y[dst] += self.buf_hy[src].re * norm;
                        out_h.z[dst] += self.buf_hz[src].re * norm;
                    }
                }
            }
        }
    }

    fn name(&self) -> &'static str {
        "rustfft"
    }
}

impl FdmFftBackend for RustFftBackend {
    fn convolve_demag(
        &mut self,
        m: &VectorFieldSoA,
        saturation_magnetisation: f64,
        active_mask: Option<&[bool]>,
        out_h: &mut VectorFieldSoA,
    ) {
        self.ws
            .convolve_demag(m, saturation_magnetisation, active_mask, out_h);
    }

    fn name(&self) -> &'static str {
        "rustfft"
    }
}

// ──────────────────────────────────────────────────────────────────────
// B10: Distributed FFT backend trait
// ──────────────────────────────────────────────────────────────────────

use crate::distributed::{GlobalReductionService, RankLocalSubdomain};

/// Distributed FFT backend for multi-rank demag convolution (B10).
///
/// Unlike [`FdmFftBackend`], this trait operates on **rank-local** data
/// and coordinates global transposes / all-to-all communication internally.
///
/// Implementors:
/// - heFFTe (C/C++ via FFI)
/// - FFTW MPI
/// - Manual pencil transpose + local FFT (fallback)
pub trait DistributedFftBackend: Send + Sync {
    /// Execute distributed demag convolution on the local slab.
    ///
    /// - `local_m`: normalised SoA magnetization for the **owned** cells on this rank
    /// - `saturation_magnetisation`: `M_s` used while packing magnetic moment
    /// - `active_mask`: optional rank-local active-cell mask
    /// - `kernel`: pre-computed Newell spectra (global, broadcast at startup)
    /// - `sub`: subdomain description (offsets, extents)
    /// - `out_h`: output field — accumulated into (not overwritten)
    /// - `reductions`: collective communication handle
    fn convolve_demag_distributed(
        &mut self,
        local_m: &VectorFieldSoA,
        saturation_magnetisation: f64,
        active_mask: Option<&[bool]>,
        kernel: &DemagKernelSpectra,
        sub: &RankLocalSubdomain,
        out_h: &mut VectorFieldSoA,
        reductions: &dyn GlobalReductionService,
    );

    /// Human-readable name, e.g. "heffte", "fftw_mpi".
    fn name(&self) -> &'static str;
}

/// Fallback distributed backend that delegates to a local [`FdmFftBackend`]
/// on rank 0 only (gather → local FFT → scatter).
///
/// This is correct but not scalable — useful only for testing and as a
/// reference implementation.
pub struct GatherScatterFallback<B: FdmFftBackend> {
    local_backend: B,
}

impl<B: FdmFftBackend> GatherScatterFallback<B> {
    pub fn new(local_backend: B) -> Self {
        Self { local_backend }
    }
}

impl<B: FdmFftBackend> DistributedFftBackend for GatherScatterFallback<B> {
    fn convolve_demag_distributed(
        &mut self,
        local_m: &VectorFieldSoA,
        saturation_magnetisation: f64,
        active_mask: Option<&[bool]>,
        kernel: &DemagKernelSpectra,
        _sub: &RankLocalSubdomain,
        out_h: &mut VectorFieldSoA,
        _reductions: &dyn GlobalReductionService,
    ) {
        // Single-rank fallback: just delegate to the local backend.
        let _ = kernel;
        self.local_backend
            .convolve_demag(local_m, saturation_magnetisation, active_mask, out_h);
    }

    fn name(&self) -> &'static str {
        "gather_scatter_fallback"
    }
}
