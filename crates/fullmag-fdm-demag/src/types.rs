//! Core types for FDM demagnetization tensor convolution.

use rustfft::num_complex::Complex;
use serde::{Deserialize, Serialize};
use std::fmt;

/// Error returned by the checked direct/shifted kernel builders.
///
/// The legacy builders intentionally keep their historic infallible API.  New
/// source/destination pair builders use this error to reject malformed cell
/// geometry or a pair that cannot be represented by one translational kernel
/// instead of silently choosing a spacing or orientation.
#[derive(Debug, Clone, PartialEq)]
pub enum KernelBuildError {
    /// A grid dimension is zero.
    EmptyGrid,
    /// A cell edge is non-finite or not strictly positive.
    InvalidCellSize {
        role: &'static str,
        axis: usize,
        value: f64,
    },
    /// A displacement/offset contains a NaN or infinity.
    InvalidOffset { axis: usize, value: f64 },
    /// The requested pair cannot be represented by one translational kernel.
    UnsupportedGeometry { reason: String },
}

impl fmt::Display for KernelBuildError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyGrid => formatter.write_str("kernel grid dimensions must be positive"),
            Self::InvalidCellSize { role, axis, value } => write!(
                formatter,
                "{role} cell size on axis {axis} must be finite and positive (got {value})"
            ),
            Self::InvalidOffset { axis, value } => write!(
                formatter,
                "kernel offset on axis {axis} must be finite (got {value})"
            ),
            Self::UnsupportedGeometry { reason } => formatter.write_str(reason),
        }
    }
}

impl std::error::Error for KernelBuildError {}

/// Six independent components of a cell-pair demagnetization tensor.
///
/// Components are normalized as a field response per unit source
/// magnetization, with the destination-cell volume in the denominator.  The
/// displacement convention is always `destination_center - source_center`.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct CellPairTensor {
    pub xx: f64,
    pub yy: f64,
    pub zz: f64,
    pub xy: f64,
    pub xz: f64,
    pub yz: f64,
}

impl CellPairTensor {
    pub const fn new(xx: f64, yy: f64, zz: f64, xy: f64, xz: f64, yz: f64) -> Self {
        Self {
            xx,
            yy,
            zz,
            xy,
            xz,
            yz,
        }
    }

    /// Return components in the stable `xx,yy,zz,xy,xz,yz` order.
    pub const fn components(self) -> [(&'static str, f64); 6] {
        [
            ("xx", self.xx),
            ("yy", self.yy),
            ("zz", self.zz),
            ("xy", self.xy),
            ("xz", self.xz),
            ("yz", self.yz),
        ]
    }

    /// Transpose the tensor while retaining the six-component storage.
    pub const fn transpose(self) -> Self {
        self
    }
}

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

/// `f32` variant of the FFT-domain demag tensor kernel.
#[derive(Debug, Clone)]
pub struct TensorDemagKernelF32 {
    pub fft_shape: [usize; 3],
    pub k_xx: Vec<Complex<f32>>,
    pub k_yy: Vec<Complex<f32>>,
    pub k_zz: Vec<Complex<f32>>,
    pub k_xy: Vec<Complex<f32>>,
    pub k_xz: Vec<Complex<f32>>,
    pub k_yz: Vec<Complex<f32>>,
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

impl TensorDemagKernelF32 {
    pub fn len(&self) -> usize {
        self.fft_shape[0] * self.fft_shape[1] * self.fft_shape[2]
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl From<&TensorDemagKernel> for TensorDemagKernelF32 {
    fn from(value: &TensorDemagKernel) -> Self {
        let convert = |values: &[Complex<f64>]| -> Vec<Complex<f32>> {
            values
                .iter()
                .map(|v| Complex::new(v.re as f32, v.im as f32))
                .collect()
        };
        Self {
            fft_shape: value.fft_shape,
            k_xx: convert(&value.k_xx),
            k_yy: convert(&value.k_yy),
            k_zz: convert(&value.k_zz),
            k_xy: convert(&value.k_xy),
            k_xz: convert(&value.k_xz),
            k_yz: convert(&value.k_yz),
        }
    }
}

/// FFT-domain vector field (M or H) with 3 components.
#[derive(Debug, Clone)]
pub struct VectorFieldFft {
    pub x: Vec<Complex<f64>>,
    pub y: Vec<Complex<f64>>,
    pub z: Vec<Complex<f64>>,
}

/// `f32` variant of the FFT-domain vector field.
#[derive(Debug, Clone)]
pub struct VectorFieldFftF32 {
    pub x: Vec<Complex<f32>>,
    pub y: Vec<Complex<f32>>,
    pub z: Vec<Complex<f32>>,
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

impl VectorFieldFftF32 {
    pub fn zeros(len: usize) -> Self {
        let zero = Complex::new(0.0f32, 0.0f32);
        Self {
            x: vec![zero; len],
            y: vec![zero; len],
            z: vec![zero; len],
        }
    }
}

/// Describes how a layer's native grid relates to the convolution grid.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransferKind {
    /// Native grid == convolution grid; no resampling needed.
    Identity,
    /// Needs resampling between native and convolution grids.
    PushPull,
}

/// Canonical multilayer kernel key lives in the descriptor module; this
/// re-export keeps the historic `types::KernelReuseKey` path source-compatible.
pub use crate::descriptors::KernelReuseKey;
