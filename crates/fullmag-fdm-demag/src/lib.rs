//! Shared FDM demagnetization tensor kernel library.
//!
//! This crate is the **single source of truth** for all demag tensor
//! mathematics in Fullmag. Both the CPU reference engine and the CUDA
//! backend use it for host-side kernel generation.
//!
//! # Modules
//!
//! - [`newell`] — Newell–Williams–Dunlop base functions and 27-point stencil
//! - [`types`] — Core types: `TensorDemagKernel`, `VectorFieldFft`, `KernelReuseKey`
//! - [`self_kernel`] — Self-interaction kernel builder (exact single-layer)
//! - [`shifted_kernel`] — Cross-layer shifted kernel builder
//! - [`multiply`] — FFT-domain tensor-vector multiplication
//! - [`transfer`] — Native ↔ convolution grid transfer operators

pub mod multiply;
pub mod newell;
pub mod self_kernel;
pub mod shifted_kernel;
pub mod transfer;
pub mod types;

// Re-export the main public types for convenience
pub use multiply::accumulate_tensor_convolution;
pub use self_kernel::{compute_exact_self_kernel, compute_exact_self_kernel_2d};
pub use shifted_kernel::compute_shifted_kernel;
pub use transfer::{pull_h, push_m};
pub use types::{KernelReuseKey, TensorDemagKernel, TransferKind, VectorFieldFft};
