//! Tensor-vector multiplication in FFT domain.
//!
//! One generic function covers all cases: self-interaction and cross-layer.
//! V1 does NOT implement fast-path variants for real-only self-kernels.

use rustfft::num_complex::Complex;

use crate::types::{TensorDemagKernel, VectorFieldFft};

/// Accumulate the tensor convolution `H_dst += K * M_src` in FFT domain.
///
/// For the full symmetric 3×3 demagnetization tensor:
/// ```text
///   Hx += Kxx·Mx + Kxy·My + Kxz·Mz
///   Hy += Kxy·Mx + Kyy·My + Kyz·Mz
///   Hz += Kxz·Mx + Kyz·My + Kzz·Mz
/// ```
///
/// **Note**: This _accumulates_ — caller must zero `dst_h_fft` before the first call
/// if a fresh computation is intended.
///
/// # Sign convention
/// The caller is responsible for the overall `-1` sign in H_demag = -N*M.
/// This function computes the raw `K * M` product without negation.
pub fn accumulate_tensor_convolution(
    dst_h_fft: &mut VectorFieldFft,
    src_m_fft: &VectorFieldFft,
    kernel_fft: &TensorDemagKernel,
) {
    let n = kernel_fft.len();
    debug_assert_eq!(src_m_fft.x.len(), n);
    debug_assert_eq!(dst_h_fft.x.len(), n);

    #[cfg(feature = "parallel")]
    {
        use rayon::prelude::*;
        // Process Hx, Hy, Hz in parallel chunks
        let chunk_size = (n / rayon::current_num_threads()).max(256);

        dst_h_fft
            .x
            .par_chunks_mut(chunk_size)
            .enumerate()
            .for_each(|(chunk_idx, hx_chunk)| {
                let start = chunk_idx * chunk_size;
                for (local_i, hx) in hx_chunk.iter_mut().enumerate() {
                    let i = start + local_i;
                    *hx += kernel_fft.k_xx[i] * src_m_fft.x[i]
                        + kernel_fft.k_xy[i] * src_m_fft.y[i]
                        + kernel_fft.k_xz[i] * src_m_fft.z[i];
                }
            });

        dst_h_fft
            .y
            .par_chunks_mut(chunk_size)
            .enumerate()
            .for_each(|(chunk_idx, hy_chunk)| {
                let start = chunk_idx * chunk_size;
                for (local_i, hy) in hy_chunk.iter_mut().enumerate() {
                    let i = start + local_i;
                    *hy += kernel_fft.k_xy[i] * src_m_fft.x[i]
                        + kernel_fft.k_yy[i] * src_m_fft.y[i]
                        + kernel_fft.k_yz[i] * src_m_fft.z[i];
                }
            });

        dst_h_fft
            .z
            .par_chunks_mut(chunk_size)
            .enumerate()
            .for_each(|(chunk_idx, hz_chunk)| {
                let start = chunk_idx * chunk_size;
                for (local_i, hz) in hz_chunk.iter_mut().enumerate() {
                    let i = start + local_i;
                    *hz += kernel_fft.k_xz[i] * src_m_fft.x[i]
                        + kernel_fft.k_yz[i] * src_m_fft.y[i]
                        + kernel_fft.k_zz[i] * src_m_fft.z[i];
                }
            });
    }

    #[cfg(not(feature = "parallel"))]
    {
        for i in 0..n {
            let mx = src_m_fft.x[i];
            let my = src_m_fft.y[i];
            let mz = src_m_fft.z[i];
            dst_h_fft.x[i] += kernel_fft.k_xx[i] * mx + kernel_fft.k_xy[i] * my + kernel_fft.k_xz[i] * mz;
            dst_h_fft.y[i] += kernel_fft.k_xy[i] * mx + kernel_fft.k_yy[i] * my + kernel_fft.k_yz[i] * mz;
            dst_h_fft.z[i] += kernel_fft.k_xz[i] * mx + kernel_fft.k_yz[i] * my + kernel_fft.k_zz[i] * mz;
        }
    }
}

/// Apply the negation sign convention: H_demag = -K*M.
///
/// Call after all `accumulate_tensor_convolution` calls for a destination
/// layer have been made and the result is ready to be inverse-FFT'd.
pub fn negate_field(field: &mut VectorFieldFft) {
    let neg = |v: &mut Complex<f64>| *v = -*v;
    field.x.iter_mut().for_each(neg);
    field.y.iter_mut().for_each(neg);
    field.z.iter_mut().for_each(neg);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_m_gives_zero_h() {
        let n = 8;
        let zero = Complex::new(0.0, 0.0);
        let one = Complex::new(1.0, 0.0);

        let kernel = TensorDemagKernel {
            fft_shape: [2, 2, 2],
            k_xx: vec![one; n],
            k_yy: vec![one; n],
            k_zz: vec![one; n],
            k_xy: vec![zero; n],
            k_xz: vec![zero; n],
            k_yz: vec![zero; n],
        };

        let m = VectorFieldFft::zeros(n);
        let mut h = VectorFieldFft::zeros(n);
        accumulate_tensor_convolution(&mut h, &m, &kernel);

        for i in 0..n {
            assert_eq!(h.x[i], zero);
            assert_eq!(h.y[i], zero);
            assert_eq!(h.z[i], zero);
        }
    }

    #[test]
    fn diagonal_kernel_scales_components_independently() {
        let n = 4;
        let zero = Complex::new(0.0, 0.0);
        let two = Complex::new(2.0, 0.0);
        let three = Complex::new(3.0, 0.0);

        let kernel = TensorDemagKernel {
            fft_shape: [2, 2, 1],
            k_xx: vec![two; n],
            k_yy: vec![three; n],
            k_zz: vec![Complex::new(5.0, 0.0); n],
            k_xy: vec![zero; n],
            k_xz: vec![zero; n],
            k_yz: vec![zero; n],
        };

        let one = Complex::new(1.0, 0.0);
        let m = VectorFieldFft {
            x: vec![one; n],
            y: vec![one; n],
            z: vec![one; n],
        };

        let mut h = VectorFieldFft::zeros(n);
        accumulate_tensor_convolution(&mut h, &m, &kernel);

        for i in 0..n {
            assert!((h.x[i].re - 2.0).abs() < 1e-15);
            assert!((h.y[i].re - 3.0).abs() < 1e-15);
            assert!((h.z[i].re - 5.0).abs() < 1e-15);
        }
    }
}
