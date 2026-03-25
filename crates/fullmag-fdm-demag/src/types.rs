//! Core types for FDM demagnetization tensor convolution.

use rustfft::num_complex::Complex;

/// 6-component symmetric demag tensor kernel in FFT domain.
///
/// Stores the Fourier transforms of N_xx, N_yy, N_zz, N_xy, N_xz, N_yz
/// on a padded grid. For self-kernels the imaginary parts are zero;
/// for shifted cross-layer kernels they may be non-zero.
///
/// V1 design: always store full complex, no special real-only fast path.
#[derive(Debug, Clone)]
pub struct TensorDemagKernel {
    /// Padded FFT dimensions (typically 2*nx, 2*ny, 2*nz).
    pub fft_shape: [usize; 3],
    pub k_xx: Vec<Complex<f64>>,
    pub k_yy: Vec<Complex<f64>>,
    pub k_zz: Vec<Complex<f64>>,
    pub k_xy: Vec<Complex<f64>>,
    pub k_xz: Vec<Complex<f64>>,
    pub k_yz: Vec<Complex<f64>>,
}

impl TensorDemagKernel {
    /// Total number of elements in each component array.
    pub fn len(&self) -> usize {
        self.fft_shape[0] * self.fft_shape[1] * self.fft_shape[2]
    }

    /// Whether the kernel is empty (zero-size FFT).
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// FFT-domain vector field (M or H) with 3 components.
#[derive(Debug, Clone)]
pub struct VectorFieldFft {
    pub x: Vec<Complex<f64>>,
    pub y: Vec<Complex<f64>>,
    pub z: Vec<Complex<f64>>,
}

impl VectorFieldFft {
    /// Create a zeroed vector field FFT of the given length.
    pub fn zeros(len: usize) -> Self {
        let zero = Complex::new(0.0, 0.0);
        Self {
            x: vec![zero; len],
            y: vec![zero; len],
            z: vec![zero; len],
        }
    }
}

/// Describes how a layer's native grid relates to the convolution grid.
#[derive(Debug, Clone)]
pub enum TransferKind {
    /// Native grid == convolution grid; no resampling needed.
    Identity,
    /// Needs resampling between native and convolution grids.
    Resample {
        native_cells: [usize; 3],
        native_cell_size: [f64; 3],
        conv_cells: [usize; 3],
        conv_cell_size: [f64; 3],
    },
}

/// Key for identifying mathematically identical kernel pairs.
/// Used to deduplicate: if two layer-pairs have the same shift, cell sizes,
/// and common grid, they share the same kernel.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct KernelReuseKey {
    /// Quantized z-shift in units of convolution cell size, to avoid float hashing.
    pub z_shift_quantized: i64,
    /// Source cell size quantized to integer picometers.
    pub src_cell_pm: [i64; 3],
    /// Destination cell size quantized to integer picometers.
    pub dst_cell_pm: [i64; 3],
    /// Common convolution grid cells.
    pub common_cells: [usize; 3],
}

impl KernelReuseKey {
    /// Create a reuse key from physical parameters.
    /// Quantizes to picometer precision to enable hash-based dedup.
    pub fn new(
        z_shift: f64,
        src_cell: [f64; 3],
        dst_cell: [f64; 3],
        conv_cell_z: f64,
        common_cells: [usize; 3],
    ) -> Self {
        let quantize = |v: f64| -> i64 { (v * 1e12).round() as i64 };
        Self {
            z_shift_quantized: (z_shift / conv_cell_z).round() as i64,
            src_cell_pm: [
                quantize(src_cell[0]),
                quantize(src_cell[1]),
                quantize(src_cell[2]),
            ],
            dst_cell_pm: [
                quantize(dst_cell[0]),
                quantize(dst_cell[1]),
                quantize(dst_cell[2]),
            ],
            common_cells,
        }
    }
}
