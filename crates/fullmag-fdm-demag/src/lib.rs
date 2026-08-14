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
//! - [`descriptors`] — Serializable multilayer layout and kernel-pair ABI

pub mod descriptors;
pub mod multiply;
pub mod newell;
pub mod self_kernel;
pub mod shifted_kernel;
pub mod transfer;
pub mod types;

pub use descriptors::{
    ActiveMaskIdentity, BoundaryPolicy, CommonTransformLayout, ConvolutionMode, CropWindow,
    DescriptorError, FdmLayerDescriptor, GridGeometry, KernelAdmissionModel,
    KernelCatalogPairBinding, KernelCatalogSpec, KernelMemoryAccounting, KernelPrecision,
    KernelReuseCatalog, LayerFingerprintInputs, LayerGridDescriptor, NegativeLagMapping,
    OrientedKernelPairDescriptor, OrientedPairDescriptor, TensorRepresentation,
    TransferContractMetadata, TransferReference, TransformConvention, TransformKey, ZeroPadding,
};

// Re-export the main public types for convenience
pub use multiply::{
    accumulate_tensor_convolution, accumulate_tensor_convolution_f32, negate_field_f32,
};
pub use self_kernel::{
    compute_exact_self_kernel, compute_exact_self_kernel_2d, compute_exact_self_kernel_2d_f32,
    compute_exact_self_kernel_f32,
};
pub use shifted_kernel::{
    compute_shifted_kernel, compute_shifted_kernel_f32, compute_shifted_kernel_irregular,
    compute_shifted_kernel_pair, compute_shifted_kernel_pair_f32, try_compute_shifted_kernel_pair,
};
pub use transfer::{
    pull_h, pull_h_f32, pull_h_f32_with_boundary_policy, pull_h_with_boundary_policy, push_m,
    push_m_f32, push_m_f32_with_boundary_policy, push_m_with_boundary_policy,
    TransferBoundaryPolicy, VolumeWeightedTransfer,
};
pub use types::{
    CellPairTensor, KernelBuildError, KernelReuseKey, TensorDemagKernel, TensorDemagKernelF32,
    TransferKind, VectorFieldFft, VectorFieldFftF32,
};

pub use newell::{
    cell_pair_tensor, compute_cell_pair_tensor, compute_newell_kernels_shifted_irregular,
    compute_newell_kernels_shifted_pair, try_compute_newell_kernels_shifted_pair, NewellKernels,
};
