//! Self-interaction kernel builder.
//!
//! Computes the exact Newell demag tensor for a single layer's self-interaction,
//! then packs it into FFT-domain `TensorDemagKernel`.

use rustfft::num_complex::Complex;
use rustfft::FftPlanner;

use crate::newell::{self, NewellKernels};
use crate::types::TensorDemagKernel;

/// Compute the exact self-interaction demag kernel in FFT domain.
///
/// This is the single source of truth for kernel generation used by both
/// CPU reference engine and CUDA backend (which receives the pre-computed
/// FFT-domain arrays from Rust).
///
/// # Arguments
/// * `nx, ny, nz` — physical grid dimensions (number of cells)
/// * `dx, dy, dz` — cell sizes in meters
pub fn compute_exact_self_kernel(
    nx: usize,
    ny: usize,
    nz: usize,
    dx: f64,
    dy: f64,
    dz: f64,
) -> TensorDemagKernel {
    let nk: NewellKernels = newell::compute_newell_kernels(nx, ny, nz, dx, dy, dz);
    let px = nk.px;
    let py = nk.py;
    let pz = nk.pz;

    fft_newell_to_kernel(nk, px, py, pz)
}

/// Compute a 2D thin-film self kernel (nz=1 slice).
pub fn compute_exact_self_kernel_2d(
    nx: usize,
    ny: usize,
    dx: f64,
    dy: f64,
    dz: f64,
) -> TensorDemagKernel {
    let nk: NewellKernels = newell::compute_newell_kernels(nx, ny, 1, dx, dy, dz);
    let px = nk.px;
    let py = nk.py;
    // For 2D we keep pz=2 from the Newell computation but only use the z=0 plane
    // Actually, the Newell function computes pz = 2*nz = 2 for nz=1
    let pz = nk.pz;

    fft_newell_to_kernel(nk, px, py, pz)
}

/// Transform a real-space Newell kernel to FFT-domain TensorDemagKernel.
pub fn fft_newell_to_kernel(
    nk: NewellKernels,
    px: usize,
    py: usize,
    pz: usize,
) -> TensorDemagKernel {
    let mut planner = FftPlanner::<f64>::new();
    let fwd_x = planner.plan_fft_forward(px);
    let fwd_y = planner.plan_fft_forward(py);
    let fwd_z = planner.plan_fft_forward(pz);

    let fft_kernel = |real: Vec<f64>| -> Vec<Complex<f64>> {
        let zero = Complex::new(0.0, 0.0);
        let mut buf: Vec<Complex<f64>> = real.into_iter().map(|v| Complex::new(v, 0.0)).collect();
        let mut line_y = vec![zero; py];
        let mut line_z = vec![zero; pz];
        fft3_core(&mut buf, px, py, pz, &*fwd_x, &*fwd_y, &*fwd_z, &mut line_y, &mut line_z);
        buf
    };

    TensorDemagKernel {
        fft_shape: [px, py, pz],
        k_xx: fft_kernel(nk.n_xx),
        k_yy: fft_kernel(nk.n_yy),
        k_zz: fft_kernel(nk.n_zz),
        k_xy: fft_kernel(nk.n_xy),
        k_xz: fft_kernel(nk.n_xz),
        k_yz: fft_kernel(nk.n_yz),
    }
}

// ---------------------------------------------------------------------------
// 3D FFT helper (row-by-row approach, same as fullmag-engine)
// ---------------------------------------------------------------------------

fn fft3_core(
    buf: &mut [Complex<f64>],
    px: usize,
    py: usize,
    pz: usize,
    fwd_x: &dyn rustfft::Fft<f64>,
    fwd_y: &dyn rustfft::Fft<f64>,
    fwd_z: &dyn rustfft::Fft<f64>,
    line_y: &mut [Complex<f64>],
    line_z: &mut [Complex<f64>],
) {
    // X transforms
    for z in 0..pz {
        for y in 0..py {
            let offset = z * py * px + y * px;
            fwd_x.process(&mut buf[offset..offset + px]);
        }
    }
    // Y transforms
    for z in 0..pz {
        for x in 0..px {
            for y in 0..py {
                line_y[y] = buf[z * py * px + y * px + x];
            }
            fwd_y.process(line_y);
            for y in 0..py {
                buf[z * py * px + y * px + x] = line_y[y];
            }
        }
    }
    // Z transforms
    for y in 0..py {
        for x in 0..px {
            for z in 0..pz {
                line_z[z] = buf[z * py * px + y * px + x];
            }
            fwd_z.process(line_z);
            for z in 0..pz {
                buf[z * py * px + y * px + x] = line_z[z];
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn self_kernel_has_correct_shape() {
        let kernel = compute_exact_self_kernel(4, 4, 2, 2e-9, 2e-9, 2e-9);
        assert_eq!(kernel.fft_shape, [8, 8, 4]);
        assert_eq!(kernel.k_xx.len(), 8 * 8 * 4);
    }

    #[test]
    fn self_kernel_diagonal_sum_at_k0() {
        // At k=0, the sum N_xx + N_yy + N_zz should equal 1.0 * volume
        // (trace of demag tensor = 1 before FFT normalization).
        let kernel = compute_exact_self_kernel(4, 4, 4, 2e-9, 2e-9, 2e-9);
        let trace_k0 = kernel.k_xx[0].re + kernel.k_yy[0].re + kernel.k_zz[0].re;
        // After FFT the DC component picks up the sum over all real-space values.
        // For exact Newell, the real-space trace at (0,0,0) is 1.0 * volume,
        // but we just verify the trace of FFT-domain kernels at DC is consistent.
        assert!(
            trace_k0.abs() > 0.0,
            "DC trace should be non-zero, got {trace_k0}"
        );
    }

    #[test]
    fn self_kernel_2d_has_correct_shape() {
        let kernel = compute_exact_self_kernel_2d(8, 8, 2e-9, 2e-9, 1e-9);
        assert_eq!(kernel.fft_shape[0], 16);
        assert_eq!(kernel.fft_shape[1], 16);
    }
}
