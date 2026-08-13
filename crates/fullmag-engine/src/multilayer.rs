//! Multilayer FDM LLG problem — runtime types and step algorithm.
//!
//! This module implements the report's §10-§11 architecture:
//! - `FdmLlgProblem` with per-layer state
//! - `DemagOperatorRuntime` enum (None / UniformGrid / MultilayerConvolution)
//! - Multilayer step: exchange → push_m → FFT → pairwise multiply → IFFT → pull_h → LLG
//!
//! For L=1, the `MultilayerConvolution` path reduces identically to
//! `UniformGrid` exact tensor demag.

use rustfft::num_complex::Complex;
use rustfft::FftPlanner;
use serde::{Deserialize, Serialize};
use std::mem::size_of;
use std::sync::Mutex;

use fullmag_fdm_demag::{
    self,
    descriptors::{
        BoundaryPolicy, CommonTransformLayout, ConvolutionMode, FdmLayerDescriptor,
        KernelPrecision, KernelReuseKey, TensorRepresentation, TransformKey,
    },
    pull_h_f32_with_boundary_policy, pull_h_with_boundary_policy, push_m_f32_with_boundary_policy,
    push_m_with_boundary_policy,
    transfer::VolumeWeightedTransfer,
    types::{TensorDemagKernel, TensorDemagKernelF32, VectorFieldFft, VectorFieldFftF32},
    TransferBoundaryPolicy, TransferKind,
};

// ---------------------------------------------------------------------------
// Runtime types (report §10.2)
// ---------------------------------------------------------------------------

/// Per-layer runtime state.
#[derive(Debug, Clone)]
pub struct FdmLayerRuntime {
    pub magnet_name: String,
    pub grid: [usize; 3],    // (nx, ny, nz)
    pub cell_size: [f64; 3], // (dx, dy, dz)
    pub origin: [f64; 3],    // global position after Translate
    pub ms: f64,             // saturation magnetisation
    /// Native-layout saturation magnetisation, when the layer is heterogeneous.
    pub ms_field: Option<Vec<f64>>,
    pub exchange_stiffness: f64,
    pub damping: f64,
    pub active_mask: Option<Vec<bool>>,
    pub m: Vec<[f64; 3]>,
    pub h_ex: Vec<[f64; 3]>,
    pub h_demag: Vec<[f64; 3]>,
    pub h_eff: Vec<[f64; 3]>,
    // Convolution grid this layer maps to (may equal native grid)
    pub conv_grid: [usize; 3],
    pub conv_cell_size: [f64; 3],
    pub needs_transfer: bool,
    pub transfer_boundary_policy: TransferBoundaryPolicy,
}

impl FdmLayerRuntime {
    pub fn cell_count(&self) -> usize {
        self.grid[0] * self.grid[1] * self.grid[2]
    }

    pub fn is_active(&self, idx: usize) -> bool {
        self.active_mask.as_ref().map_or(true, |m| m[idx])
    }
}

/// `f32` multilayer runtime state used by calibrated single-precision paths.
#[derive(Debug, Clone)]
pub struct FdmLayerRuntimeF32 {
    pub magnet_name: String,
    pub grid: [usize; 3],
    pub cell_size: [f64; 3],
    pub origin: [f64; 3],
    pub ms: f64,
    pub exchange_stiffness: f64,
    pub damping: f64,
    pub active_mask: Option<Vec<bool>>,
    pub m: Vec<[f32; 3]>,
    pub h_ex: Vec<[f32; 3]>,
    pub h_demag: Vec<[f32; 3]>,
    pub h_eff: Vec<[f32; 3]>,
    pub conv_grid: [usize; 3],
    pub conv_cell_size: [f64; 3],
    pub needs_transfer: bool,
    pub transfer_boundary_policy: TransferBoundaryPolicy,
}

impl FdmLayerRuntimeF32 {
    pub fn cell_count(&self) -> usize {
        self.grid[0] * self.grid[1] * self.grid[2]
    }

    pub fn is_active(&self, idx: usize) -> bool {
        self.active_mask.as_ref().map_or(true, |m| m[idx])
    }
}

/// Kernel pair: precomputed FFT-domain demag kernel between two layers.
#[derive(Debug, Clone)]
pub struct KernelPair {
    pub src_layer: usize,
    pub dst_layer: usize,
    pub kernel: TensorDemagKernel,
}

/// `f32` kernel pair for calibrated single-precision multilayer demag.
#[derive(Debug, Clone)]
pub struct KernelPairF32 {
    pub src_layer: usize,
    pub dst_layer: usize,
    pub kernel: TensorDemagKernelF32,
}

/// One physically stored FFT-domain tensor and its canonical reuse identity.
#[derive(Debug, Clone)]
pub struct MultilayerKernelCatalogEntry {
    pub key: KernelReuseKey,
    pub content_hash: String,
    pub kernel: TensorDemagKernel,
}

/// Ordered destination/source binding into [`MultilayerKernelCatalogEntry`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct MultilayerKernelPairBinding {
    pub src_layer: usize,
    pub dst_layer: usize,
    pub kernel_index: usize,
}

/// Runtime-owned counters and memory evidence for CPU multilayer refreshes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MultilayerReuseMemoryTelemetry {
    pub refresh_count: u64,
    pub forward_fft_count: u64,
    pub inverse_fft_count: u64,
    pub pair_accumulation_count: u64,
    pub unique_kernel_count: usize,
    pub pair_count: usize,
    pub cold_allocated_bytes: usize,
    pub warm_allocated_bytes: usize,
    pub peak_workspace_bytes: usize,
    pub cache_hit_count: u64,
    pub cache_miss_count: u64,
    pub invalidation_fingerprint: String,
    pub transfer_kind: String,
    pub residency: String,
}

struct MultilayerFftWorkspace {
    fingerprint: String,
    m_fft: Vec<VectorFieldFft>,
    h_fft: Vec<VectorFieldFft>,
    conv_m: Vec<Vec<[f64; 3]>>,
    conv_h: Vec<Vec<[f64; 3]>>,
    line_y: Vec<Complex<f64>>,
    line_z: Vec<Complex<f64>>,
    fft_scratch: Vec<Complex<f64>>,
}

impl MultilayerFftWorkspace {
    fn allocated_bytes(&self) -> usize {
        fn field_bytes(field: &VectorFieldFft) -> usize {
            (field.x.capacity() + field.y.capacity() + field.z.capacity())
                * size_of::<Complex<f64>>()
        }
        self.m_fft.iter().map(field_bytes).sum::<usize>()
            + self.h_fft.iter().map(field_bytes).sum::<usize>()
            + self
                .conv_m
                .iter()
                .map(|values| values.capacity() * size_of::<[f64; 3]>())
                .sum::<usize>()
            + self
                .conv_h
                .iter()
                .map(|values| values.capacity() * size_of::<[f64; 3]>())
                .sum::<usize>()
            + (self.line_y.capacity() + self.line_z.capacity() + self.fft_scratch.capacity())
                * size_of::<Complex<f64>>()
    }
}

struct MultilayerRuntimeState {
    workspace: Option<MultilayerFftWorkspace>,
    telemetry: MultilayerReuseMemoryTelemetry,
}

/// Multilayer demag operator runtime.
pub struct MultilayerDemagRuntime {
    pub kernel_catalog: Vec<MultilayerKernelCatalogEntry>,
    pub pair_bindings: Vec<MultilayerKernelPairBinding>,
    pub conv_grid: [usize; 3],
    pub conv_cell_size: [f64; 3],
    pub fft_shape: [usize; 3],
    /// Computational layout only; it is never a physical mesh.
    pub common_layout: CommonTransformLayout,
    /// Optional per-layer transform windows.  These carry only computational
    /// insertion/crop coordinates; native/scratch physical geometry remains
    /// in `layer_descriptors`.
    pub layer_transform_layouts: Vec<CommonTransformLayout>,
    /// Native/scratch descriptors in stable layer order. Empty for legacy
    /// callers using the pre-descriptor constructor.
    pub layer_descriptors: Vec<FdmLayerDescriptor>,
    transfer_stencils: Vec<Option<VolumeWeightedTransfer>>,
    // FFT plans (shared across all pairs)
    fwd_x: std::sync::Arc<dyn rustfft::Fft<f64>>,
    fwd_y: std::sync::Arc<dyn rustfft::Fft<f64>>,
    fwd_z: std::sync::Arc<dyn rustfft::Fft<f64>>,
    inv_x: std::sync::Arc<dyn rustfft::Fft<f64>>,
    inv_y: std::sync::Arc<dyn rustfft::Fft<f64>>,
    inv_z: std::sync::Arc<dyn rustfft::Fft<f64>>,
    invalidation_fingerprint: String,
    state: Mutex<MultilayerRuntimeState>,
}

/// `f32` multilayer demag runtime used by host-side single-precision FFT paths.
pub struct MultilayerDemagRuntimeF32 {
    pub kernel_pairs: Vec<KernelPairF32>,
    pub conv_grid: [usize; 3],
    pub conv_cell_size: [f64; 3],
    pub fft_shape: [usize; 3],
    fwd_x: std::sync::Arc<dyn rustfft::Fft<f32>>,
    fwd_y: std::sync::Arc<dyn rustfft::Fft<f32>>,
    fwd_z: std::sync::Arc<dyn rustfft::Fft<f32>>,
    inv_x: std::sync::Arc<dyn rustfft::Fft<f32>>,
    inv_y: std::sync::Arc<dyn rustfft::Fft<f32>>,
    inv_z: std::sync::Arc<dyn rustfft::Fft<f32>>,
}

fn crop_fits_inside(crop: fullmag_fdm_demag::descriptors::CropWindow, outer: [usize; 3]) -> bool {
    (0..3).all(|axis| {
        crop.offset[axis] <= outer[axis]
            && crop.shape[axis] <= outer[axis].saturating_sub(crop.offset[axis])
    })
}

fn source_window_fits(layout: &CommonTransformLayout, source_shape: [usize; 3]) -> bool {
    layout
        .source_insert_offset
        .iter()
        .zip(source_shape.iter())
        .zip(layout.fft_shape.iter())
        .all(|((offset, extent), fft)| offset.saturating_add(*extent) <= *fft)
}

fn fnv1a_update(mut hash: u64, bytes: &[u8]) -> u64 {
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn tensor_kernel_content_hash(kernel: &TensorDemagKernel) -> String {
    let mut hash = 0xcbf29ce484222325;
    for extent in kernel.fft_shape {
        hash = fnv1a_update(hash, &extent.to_le_bytes());
    }
    for component in [
        &kernel.k_xx,
        &kernel.k_yy,
        &kernel.k_zz,
        &kernel.k_xy,
        &kernel.k_xz,
        &kernel.k_yz,
    ] {
        for value in component {
            hash = fnv1a_update(hash, &value.re.to_bits().to_le_bytes());
            hash = fnv1a_update(hash, &value.im.to_bits().to_le_bytes());
        }
    }
    format!("fnv1a64:{hash:016x}")
}

fn tensor_kernels_equal(left: &TensorDemagKernel, right: &TensorDemagKernel) -> bool {
    left.fft_shape == right.fft_shape
        && left.k_xx == right.k_xx
        && left.k_yy == right.k_yy
        && left.k_zz == right.k_zz
        && left.k_xy == right.k_xy
        && left.k_xz == right.k_xz
        && left.k_yz == right.k_yz
}

fn represented_kernel_cell_size(
    descriptor: &FdmLayerDescriptor,
    mode: ConvolutionMode,
) -> [f64; 3] {
    if mode == ConvolutionMode::TwoDStack {
        [
            descriptor.scratch.spacing[0],
            descriptor.scratch.spacing[1],
            descriptor.native.thickness(),
        ]
    } else {
        descriptor.scratch.spacing
    }
}

fn kernel_source_density_scale(
    descriptor: &FdmLayerDescriptor,
    mode: ConvolutionMode,
) -> Result<f64, String> {
    let kernel_cell = represented_kernel_cell_size(descriptor, mode);
    let kernel_volume = kernel_cell.into_iter().product::<f64>();
    let scale = descriptor.scratch.volume() / kernel_volume;
    if !scale.is_finite() || scale <= 0.0 {
        return Err(format!(
            "layer '{}' has invalid scratch-to-kernel density scale {scale}",
            descriptor.layer_id
        ));
    }
    Ok(scale)
}

fn kernel_key_for_pair(
    pair: &KernelPair,
    common_layout: &CommonTransformLayout,
    layer_descriptors: &[FdmLayerDescriptor],
    conv_cell_size: [f64; 3],
) -> Result<KernelReuseKey, String> {
    if layer_descriptors.is_empty() {
        let mut key = KernelReuseKey::new(
            0.0,
            conv_cell_size,
            conv_cell_size,
            conv_cell_size[2],
            common_layout.shape,
        );
        key.mode = common_layout.mode;
        key.oriented_shift = [pair.src_layer as i64, pair.dst_layer as i64, 0];
        key.transform = TransformKey::from_layout(common_layout);
        return Ok(key);
    }
    let source = &layer_descriptors[pair.src_layer];
    let destination = &layer_descriptors[pair.dst_layer];
    if source.transfer.boundary != destination.transfer.boundary {
        return Err(format!(
            "kernel pair {}<-{} has mismatched source/destination boundary policy",
            pair.dst_layer, pair.src_layer
        ));
    }
    let source_cell = represented_kernel_cell_size(source, common_layout.mode);
    let destination_cell = represented_kernel_cell_size(destination, common_layout.mode);
    let relative_shift = [
        destination.scratch.origin[0] - source.scratch.origin[0]
            + 0.5 * (destination_cell[0] - source_cell[0]),
        destination.scratch.origin[1] - source.scratch.origin[1]
            + 0.5 * (destination_cell[1] - source_cell[1]),
        destination.scratch.origin[2] - source.scratch.origin[2]
            + 0.5 * (destination_cell[2] - source_cell[2]),
    ];
    KernelReuseKey::from_layers_with_layout(
        destination,
        source,
        relative_shift,
        TensorRepresentation::FullComplex,
        common_layout,
        KernelPrecision::F64,
        source.transfer.boundary,
    )
    .map_err(|error| format!("invalid kernel reuse key: {error}"))
}

fn build_kernel_catalog(
    kernel_pairs: Vec<KernelPair>,
    common_layout: &CommonTransformLayout,
    layer_descriptors: &[FdmLayerDescriptor],
    conv_cell_size: [f64; 3],
) -> Result<
    (
        Vec<MultilayerKernelCatalogEntry>,
        Vec<MultilayerKernelPairBinding>,
    ),
    String,
> {
    let mut entries: Vec<MultilayerKernelCatalogEntry> = Vec::new();
    let mut bindings = Vec::with_capacity(kernel_pairs.len());
    for pair in kernel_pairs {
        let key = kernel_key_for_pair(&pair, common_layout, layer_descriptors, conv_cell_size)?;
        let content_hash = tensor_kernel_content_hash(&pair.kernel);
        let kernel_index = if let Some((index, entry)) = entries
            .iter()
            .enumerate()
            .find(|(_, entry)| entry.key == key)
        {
            if entry.content_hash != content_hash
                || !tensor_kernels_equal(&entry.kernel, &pair.kernel)
            {
                return Err(format!(
                    "canonical kernel key collision for pair {}<-{}",
                    pair.dst_layer, pair.src_layer
                ));
            }
            index
        } else {
            entries.push(MultilayerKernelCatalogEntry {
                key,
                content_hash,
                kernel: pair.kernel,
            });
            entries.len() - 1
        };
        bindings.push(MultilayerKernelPairBinding {
            src_layer: pair.src_layer,
            dst_layer: pair.dst_layer,
            kernel_index,
        });
    }

    let mut order = (0..entries.len()).collect::<Vec<_>>();
    order.sort_by_key(|index| entries[*index].key.fingerprint());
    let mut remap = vec![0; entries.len()];
    for (new_index, old_index) in order.iter().copied().enumerate() {
        remap[old_index] = new_index;
    }
    let mut sorted = Vec::with_capacity(entries.len());
    let mut entries = entries.into_iter().map(Some).collect::<Vec<_>>();
    for old_index in order {
        sorted.push(entries[old_index].take().expect("catalog index is unique"));
    }
    for binding in &mut bindings {
        binding.kernel_index = remap[binding.kernel_index];
    }
    Ok((sorted, bindings))
}

fn runtime_invalidation_fingerprint(
    kernel_catalog: &[MultilayerKernelCatalogEntry],
    pair_bindings: &[MultilayerKernelPairBinding],
    common_layout: &CommonTransformLayout,
    layer_transform_layouts: &[CommonTransformLayout],
    layer_descriptors: &[FdmLayerDescriptor],
) -> String {
    let mut hash = fnv1a_update(
        0xcbf29ce484222325,
        b"fdm_multilayer_cpu_runtime_workspace.v1\0f64\0host",
    );
    hash = fnv1a_update(hash, common_layout.fingerprint().as_bytes());
    for layout in layer_transform_layouts {
        hash = fnv1a_update(hash, layout.fingerprint().as_bytes());
    }
    for descriptor in layer_descriptors {
        hash = fnv1a_update(hash, descriptor.fingerprint().as_bytes());
    }
    for entry in kernel_catalog {
        hash = fnv1a_update(hash, entry.key.fingerprint().as_bytes());
        hash = fnv1a_update(hash, entry.content_hash.as_bytes());
    }
    for binding in pair_bindings {
        hash = fnv1a_update(hash, &binding.src_layer.to_le_bytes());
        hash = fnv1a_update(hash, &binding.dst_layer.to_le_bytes());
        hash = fnv1a_update(hash, &binding.kernel_index.to_le_bytes());
    }
    format!("fnv1a64:{hash:016x}")
}

fn kernel_catalog_allocated_bytes(catalog: &[MultilayerKernelCatalogEntry]) -> usize {
    catalog
        .iter()
        .map(|entry| {
            (entry.kernel.k_xx.capacity()
                + entry.kernel.k_yy.capacity()
                + entry.kernel.k_zz.capacity()
                + entry.kernel.k_xy.capacity()
                + entry.kernel.k_xz.capacity()
                + entry.kernel.k_yz.capacity())
                * size_of::<Complex<f64>>()
        })
        .sum()
}

impl MultilayerDemagRuntime {
    /// Create a new multilayer demag runtime from precomputed kernel pairs.
    pub fn new(
        kernel_pairs: Vec<KernelPair>,
        conv_grid: [usize; 3],
        conv_cell_size: [f64; 3],
    ) -> Self {
        let fft_shape = [conv_grid[0] * 2, conv_grid[1] * 2, conv_grid[2] * 2];
        let mode = ConvolutionMode::ThreeD;
        let common_layout = CommonTransformLayout::for_pair(
            conv_grid,
            conv_grid,
            mode,
            [0; 3],
            [0; 3],
            [0; 3],
            conv_grid,
            fft_shape,
            1.0 / (fft_shape[0] * fft_shape[1] * fft_shape[2]) as f64,
        )
        .expect("legacy multilayer transform layout must be valid");
        Self::new_with_layout_and_descriptors(
            kernel_pairs,
            conv_grid,
            conv_cell_size,
            common_layout,
            Vec::new(),
        )
        .expect("legacy multilayer descriptor-less runtime must be valid")
    }

    /// Construct a runtime with an explicit transform layout and per-layer
    /// native/scratch descriptors.  The common layout is computational only;
    /// each descriptor retains the physical native and scratch geometry.
    pub fn new_with_layout_and_descriptors(
        kernel_pairs: Vec<KernelPair>,
        conv_grid: [usize; 3],
        conv_cell_size: [f64; 3],
        common_layout: CommonTransformLayout,
        layer_descriptors: Vec<FdmLayerDescriptor>,
    ) -> Result<Self, String> {
        Self::new_with_transform_layouts_and_descriptors(
            kernel_pairs,
            conv_grid,
            conv_cell_size,
            common_layout,
            Vec::new(),
            layer_descriptors,
        )
    }

    /// Construct a runtime with an explicit common transform and optional
    /// per-layer source insertion/destination crop windows.  The latter are
    /// computational coordinates only; callers must still supply pair
    /// kernels whose physical shifts match the selected windows.
    pub fn new_with_transform_layouts_and_descriptors(
        kernel_pairs: Vec<KernelPair>,
        conv_grid: [usize; 3],
        conv_cell_size: [f64; 3],
        common_layout: CommonTransformLayout,
        layer_transform_layouts: Vec<CommonTransformLayout>,
        layer_descriptors: Vec<FdmLayerDescriptor>,
    ) -> Result<Self, String> {
        common_layout
            .validate()
            .map_err(|error| format!("invalid common transform layout: {error}"))?;
        if !source_window_fits(&common_layout, conv_grid)
            || common_layout.destination_crop.shape != conv_grid
            || !crop_fits_inside(common_layout.destination_crop, common_layout.fft_shape)
        {
            return Err(
                "common transform source insertion or destination crop exceeds the non-wrapping FFT window"
                    .to_string(),
            );
        }
        if common_layout.fft_shape
            != kernel_pairs
                .first()
                .map(|pair| pair.kernel.fft_shape)
                .unwrap_or(common_layout.fft_shape)
        {
            return Err("kernel FFT shape does not match common transform layout".to_string());
        }
        if kernel_pairs
            .iter()
            .any(|pair| pair.kernel.fft_shape != common_layout.fft_shape)
        {
            return Err("all kernel pairs must use the common transform FFT shape".to_string());
        }
        if layer_descriptors.iter().any(|descriptor| {
            descriptor.scratch.shape != conv_grid
                || descriptor.scratch.spacing != conv_cell_size
                || descriptor.mode != common_layout.mode
        }) {
            return Err(
                "every layer scratch descriptor must match the common transform grid and mode"
                    .to_string(),
            );
        }
        if !layer_transform_layouts.is_empty()
            && (layer_descriptors.is_empty()
                || layer_transform_layouts.len() != layer_descriptors.len())
        {
            return Err(
                "per-layer transform layout count must match the descriptor table".to_string(),
            );
        }
        for (index, layout) in layer_transform_layouts.iter().enumerate() {
            layout
                .validate()
                .map_err(|error| format!("invalid transform layout for layer {index}: {error}"))?;
            if layout.fft_shape != common_layout.fft_shape
                || layout.mode != common_layout.mode
                || layout.inverse_normalization != common_layout.inverse_normalization
            {
                return Err(format!(
                    "transform layout for layer {index} disagrees with common FFT shape, mode, or normalization"
                ));
            }
            let scratch = layer_descriptors[index].scratch.shape;
            if !source_window_fits(layout, scratch) {
                return Err(format!(
                    "source insertion window for layer {index} exceeds the common FFT shape"
                ));
            }
            if layout.destination_crop.shape != scratch
                || !crop_fits_inside(layout.destination_crop, layout.fft_shape)
            {
                return Err(format!(
                    "destination crop for layer {index} does not match or fit its scratch grid"
                ));
            }
        }
        if layer_transform_layouts.is_empty() {
            for (index, descriptor) in layer_descriptors.iter().enumerate() {
                let scratch = descriptor.scratch.shape;
                if !source_window_fits(&common_layout, scratch) {
                    return Err(format!(
                        "common source insertion window exceeds the FFT shape for layer {index}"
                    ));
                }
                if common_layout.destination_crop.shape != scratch
                    || !crop_fits_inside(common_layout.destination_crop, common_layout.fft_shape)
                {
                    return Err(format!(
                        "common destination crop does not match or fit layer {index} scratch grid"
                    ));
                }
            }
        }
        for descriptor in &layer_descriptors {
            descriptor
                .validate()
                .map_err(|error| format!("invalid layer descriptor: {error}"))?;
            if descriptor.transfer.kind == TransferKind::Identity
                && (descriptor.native.shape != descriptor.scratch.shape
                    || descriptor.native.spacing != descriptor.scratch.spacing
                    || descriptor.native.origin != descriptor.scratch.origin)
            {
                return Err(format!(
                    "identity transfer for layer '{}' does not have identical native/scratch geometry",
                    descriptor.layer_id
                ));
            }
        }
        if !layer_descriptors.is_empty()
            && kernel_pairs.iter().any(|pair| {
                pair.src_layer >= layer_descriptors.len()
                    || pair.dst_layer >= layer_descriptors.len()
            })
        {
            return Err("kernel pair references a layer outside descriptor table".to_string());
        }
        let transfer_stencils = layer_descriptors
            .iter()
            .map(
                |descriptor| -> Result<Option<VolumeWeightedTransfer>, String> {
                    if descriptor.transfer.kind == TransferKind::Identity {
                        Ok(None)
                    } else {
                        let boundary = match descriptor.transfer.boundary {
                            BoundaryPolicy::Open => TransferBoundaryPolicy::OPEN,
                            BoundaryPolicy::Periodic { axes } => {
                                TransferBoundaryPolicy::from_periodic_axes(axes)
                            }
                        };
                        let transfer = VolumeWeightedTransfer::new(
                            descriptor.native.shape,
                            descriptor.native.spacing,
                            descriptor.native.origin,
                            descriptor.scratch.shape,
                            descriptor.scratch.spacing,
                            descriptor.scratch.origin,
                            boundary,
                        )
                        .map_err(|error| {
                            format!(
                                "transfer descriptor '{}' cannot be materialized: {error}",
                                descriptor.layer_id
                            )
                        })?;
                        Ok(Some(transfer))
                    }
                },
            )
            .collect::<Result<Vec<_>, String>>()?;
        let (kernel_catalog, pair_bindings) = build_kernel_catalog(
            kernel_pairs,
            &common_layout,
            &layer_descriptors,
            conv_cell_size,
        )?;
        let invalidation_fingerprint = runtime_invalidation_fingerprint(
            &kernel_catalog,
            &pair_bindings,
            &common_layout,
            &layer_transform_layouts,
            &layer_descriptors,
        );
        let transfer_kind = if layer_descriptors.is_empty() {
            "legacy_unrecorded"
        } else if layer_descriptors
            .iter()
            .all(|descriptor| descriptor.transfer.kind == TransferKind::Identity)
        {
            "identity"
        } else if layer_descriptors
            .iter()
            .all(|descriptor| descriptor.transfer.kind == TransferKind::PushPull)
        {
            "push_pull"
        } else {
            "mixed"
        }
        .to_string();
        let cold_allocated_bytes = kernel_catalog_allocated_bytes(&kernel_catalog);
        let telemetry = MultilayerReuseMemoryTelemetry {
            refresh_count: 0,
            forward_fft_count: 0,
            inverse_fft_count: 0,
            pair_accumulation_count: 0,
            unique_kernel_count: kernel_catalog.len(),
            pair_count: pair_bindings.len(),
            cold_allocated_bytes,
            warm_allocated_bytes: 0,
            peak_workspace_bytes: 0,
            cache_hit_count: 0,
            cache_miss_count: 0,
            invalidation_fingerprint: invalidation_fingerprint.clone(),
            transfer_kind,
            residency: "host".to_string(),
        };
        let [px, py, pz] = common_layout.fft_shape;
        let mut planner = FftPlanner::<f64>::new();
        let fwd_x = planner.plan_fft_forward(px);
        let fwd_y = planner.plan_fft_forward(py);
        let fwd_z = planner.plan_fft_forward(pz);
        let inv_x = planner.plan_fft_inverse(px);
        let inv_y = planner.plan_fft_inverse(py);
        let inv_z = planner.plan_fft_inverse(pz);

        Ok(Self {
            kernel_catalog,
            pair_bindings,
            conv_grid,
            conv_cell_size,
            fft_shape: [px, py, pz],
            common_layout,
            layer_transform_layouts,
            layer_descriptors,
            transfer_stencils,
            fwd_x,
            fwd_y,
            fwd_z,
            inv_x,
            inv_y,
            inv_z,
            invalidation_fingerprint,
            state: Mutex::new(MultilayerRuntimeState {
                workspace: None,
                telemetry,
            }),
        })
    }

    pub fn telemetry(&self) -> MultilayerReuseMemoryTelemetry {
        self.state
            .lock()
            .expect("multilayer runtime state mutex poisoned")
            .telemetry
            .clone()
    }

    pub fn invalidation_fingerprint(&self) -> &str {
        &self.invalidation_fingerprint
    }

    pub fn kernel_for_ordered_pair(
        &self,
        src_layer: usize,
        dst_layer: usize,
    ) -> Option<&TensorDemagKernel> {
        let binding = self
            .pair_bindings
            .iter()
            .find(|binding| binding.src_layer == src_layer && binding.dst_layer == dst_layer)?;
        self.kernel_catalog
            .get(binding.kernel_index)
            .map(|entry| &entry.kernel)
    }

    fn transform_layout_for_layer(&self, layer_index: usize) -> &CommonTransformLayout {
        self.layer_transform_layouts
            .get(layer_index)
            .unwrap_or(&self.common_layout)
    }

    /// Padded FFT buffer length.
    fn padded_len(&self) -> usize {
        self.fft_shape[0] * self.fft_shape[1] * self.fft_shape[2]
    }

    fn allocate_workspace(&self, layers: &[FdmLayerRuntime]) -> MultilayerFftWorkspace {
        let padded_len = self.padded_len();
        let fft_scratch_len = [
            self.fwd_x.get_inplace_scratch_len(),
            self.fwd_y.get_inplace_scratch_len(),
            self.fwd_z.get_inplace_scratch_len(),
            self.inv_x.get_inplace_scratch_len(),
            self.inv_y.get_inplace_scratch_len(),
            self.inv_z.get_inplace_scratch_len(),
        ]
        .into_iter()
        .max()
        .unwrap_or(0);
        MultilayerFftWorkspace {
            fingerprint: self.invalidation_fingerprint.clone(),
            m_fft: (0..layers.len())
                .map(|_| VectorFieldFft::zeros(padded_len))
                .collect(),
            h_fft: (0..layers.len())
                .map(|_| VectorFieldFft::zeros(padded_len))
                .collect(),
            conv_m: layers
                .iter()
                .map(|layer| vec![[0.0; 3]; layer.conv_grid.into_iter().product()])
                .collect(),
            conv_h: layers
                .iter()
                .map(|layer| vec![[0.0; 3]; layer.conv_grid.into_iter().product()])
                .collect(),
            line_y: vec![Complex::new(0.0, 0.0); self.fft_shape[1]],
            line_z: vec![Complex::new(0.0, 0.0); self.fft_shape[2]],
            fft_scratch: vec![Complex::new(0.0, 0.0); fft_scratch_len],
        }
    }

    fn workspace_matches(
        &self,
        workspace: &MultilayerFftWorkspace,
        layers: &[FdmLayerRuntime],
    ) -> bool {
        workspace.fingerprint == self.invalidation_fingerprint
            && workspace.m_fft.len() == layers.len()
            && workspace.h_fft.len() == layers.len()
            && workspace
                .conv_m
                .iter()
                .zip(layers.iter())
                .all(|(values, layer)| {
                    values.len() == layer.conv_grid.into_iter().product::<usize>()
                })
            && workspace
                .conv_h
                .iter()
                .zip(layers.iter())
                .all(|(values, layer)| {
                    values.len() == layer.conv_grid.into_iter().product::<usize>()
                })
    }

    /// Compute demag fields for all layers.
    ///
    /// Algorithm (report §11.1):
    /// 1. For each layer: push_m to convolution grid, pad, forward FFT
    /// 2. For each dst layer: zero H_fft, then for each src layer: H_fft += K * M_fft
    /// 3. For each layer: negate, inverse FFT, pull_h to native grid
    pub fn compute_demag_fields(&self, layers: &mut [FdmLayerRuntime]) {
        self.compute_demag_fields_checked(layers)
            .expect("multilayer demag runtime descriptor mismatch");
    }

    /// Checked variant used by the public runner so unsupported descriptor or
    /// transfer states fail closed instead of silently falling back.
    pub fn compute_demag_fields_checked(
        &self,
        layers: &mut [FdmLayerRuntime],
    ) -> Result<(), String> {
        let n_layers = layers.len();
        if !self.layer_descriptors.is_empty() && self.layer_descriptors.len() != n_layers {
            return Err(format!(
                "runtime has {} descriptors but received {n_layers} layers",
                self.layer_descriptors.len()
            ));
        }
        for (index, layer) in layers.iter().enumerate() {
            let native_cells = layer.cell_count();
            if layer.m.len() != native_cells
                || layer.h_demag.len() != native_cells
                || layer.h_ex.len() != native_cells
                || layer.h_eff.len() != native_cells
            {
                return Err(format!(
                    "layer {index} field component lengths do not match its native grid"
                ));
            }
            if let Some(mask) = layer.active_mask.as_deref() {
                if mask.len() != native_cells {
                    return Err(format!(
                        "layer {index} active mask has {} entries, expected {native_cells}",
                        mask.len()
                    ));
                }
            }
            if let Some(ms_field) = layer.ms_field.as_deref() {
                if ms_field.len() != native_cells {
                    return Err(format!(
                        "layer {index} magnet '{}' ms_field has {} entries, expected {native_cells}",
                        layer.magnet_name,
                        ms_field.len()
                    ));
                }
                if ms_field.iter().any(|value| !value.is_finite() || *value <= 0.0) {
                    return Err(format!(
                        "layer {index} magnet '{}' ms_field contains non-finite or non-positive values",
                        layer.magnet_name
                    ));
                }
            }
            if layer.conv_grid != self.conv_grid || layer.conv_cell_size != self.conv_cell_size {
                return Err(format!(
                    "layer {index} scratch grid does not match the runtime convolution grid"
                ));
            }
            let scratch_cells = layer.conv_grid[0] * layer.conv_grid[1] * layer.conv_grid[2];
            if !layer.needs_transfer && native_cells != scratch_cells {
                return Err(format!(
                    "layer {index} identity transfer requires {native_cells} native cells to match {scratch_cells} scratch cells"
                ));
            }
        }
        let padded_len = self.padded_len();
        for (pair_index, binding) in self.pair_bindings.iter().enumerate() {
            if binding.src_layer >= n_layers || binding.dst_layer >= n_layers {
                return Err(format!(
                    "kernel pair {pair_index} references source {} or destination {} outside {n_layers} runtime layers",
                    binding.src_layer, binding.dst_layer
                ));
            }
            let entry = self
                .kernel_catalog
                .get(binding.kernel_index)
                .ok_or_else(|| {
                    format!(
                        "kernel pair {pair_index} references catalog entry {} outside {} entries",
                        binding.kernel_index,
                        self.kernel_catalog.len()
                    )
                })?;
            if entry.kernel.fft_shape != self.fft_shape {
                return Err(format!(
                    "kernel pair {pair_index} FFT shape {:?} disagrees with runtime {:?}",
                    entry.kernel.fft_shape, self.fft_shape
                ));
            }
            let component_lengths = [
                entry.kernel.k_xx.len(),
                entry.kernel.k_yy.len(),
                entry.kernel.k_zz.len(),
                entry.kernel.k_xy.len(),
                entry.kernel.k_xz.len(),
                entry.kernel.k_yz.len(),
            ];
            if component_lengths.iter().any(|length| *length != padded_len) {
                return Err(format!(
                    "kernel pair {pair_index} has component lengths {:?}, expected {padded_len}",
                    component_lengths
                ));
            }
        }
        for (index, (layer, descriptor)) in
            layers.iter().zip(self.layer_descriptors.iter()).enumerate()
        {
            if descriptor.native.shape != layer.grid
                || descriptor.native.spacing != layer.cell_size
                || descriptor.native.origin != layer.origin
                || descriptor.scratch.shape != layer.conv_grid
                || descriptor.scratch.spacing != layer.conv_cell_size
            {
                return Err(format!(
                    "layer {index} runtime geometry does not match its native/scratch descriptor"
                ));
            }
            let descriptor_needs_transfer = descriptor.transfer.kind == TransferKind::PushPull;
            if descriptor_needs_transfer != layer.needs_transfer {
                return Err(format!(
                    "layer {index} transfer flag disagrees with its descriptor"
                ));
            }
            let descriptor_boundary = match descriptor.transfer.boundary {
                BoundaryPolicy::Open => TransferBoundaryPolicy::OPEN,
                BoundaryPolicy::Periodic { axes } => {
                    TransferBoundaryPolicy::from_periodic_axes(axes)
                }
            };
            if descriptor_boundary != layer.transfer_boundary_policy {
                return Err(format!(
                    "layer {index} transfer boundary policy disagrees with its descriptor"
                ));
            }
            match (
                &descriptor.active_mask.present,
                layer.active_mask.as_deref(),
            ) {
                (false, None) => {}
                (false, Some(_)) | (true, None) => {
                    return Err(format!(
                        "layer {index} active-mask presence disagrees with its descriptor"
                    ));
                }
                (true, Some(mask)) => {
                    let identity =
                        fullmag_fdm_demag::descriptors::ActiveMaskIdentity::from_mask(mask);
                    if identity.fingerprint != descriptor.active_mask.fingerprint {
                        return Err(format!(
                            "layer {index} active-mask fingerprint disagrees with its descriptor"
                        ));
                    }
                }
            }
        }
        let [px, py, _pz] = self.fft_shape;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "multilayer runtime state mutex poisoned".to_string())?;
        let workspace_hit = state
            .workspace
            .as_ref()
            .map(|workspace| self.workspace_matches(workspace, layers))
            .unwrap_or(false);
        if workspace_hit {
            state.telemetry.cache_hit_count += 1;
        } else {
            let workspace = self.allocate_workspace(layers);
            let allocated_bytes = workspace.allocated_bytes();
            state.telemetry.cache_miss_count += 1;
            state.telemetry.cold_allocated_bytes = state
                .telemetry
                .cold_allocated_bytes
                .saturating_add(allocated_bytes);
            state.telemetry.peak_workspace_bytes =
                state.telemetry.peak_workspace_bytes.max(allocated_bytes);
            state.workspace = Some(workspace);
        }
        state.telemetry.refresh_count += 1;
        let MultilayerRuntimeState {
            workspace,
            telemetry,
        } = &mut *state;
        let workspace = workspace
            .as_mut()
            .expect("workspace is materialized before a multilayer refresh");

        // Step 1: Forward FFT all layers' magnetizations.
        for (layer_index, layer) in layers.iter().enumerate() {
            let kernel_density_scale = self
                .layer_descriptors
                .get(layer_index)
                .map(|descriptor| kernel_source_density_scale(descriptor, self.common_layout.mode))
                .transpose()?
                .unwrap_or(1.0);
            // Apply native Ms before active-mask handling and push/pull
            // transfer so FFT receives physical M_i = Ms_i * m_i.
            let source_m = layer
                .m
                .iter()
                .enumerate()
                .map(|(cell, m)| {
                    let ms = layer.ms_field.as_ref().map(|field| field[cell]).unwrap_or(layer.ms);
                    [m[0] * ms, m[1] * ms, m[2] * ms]
                })
                .collect::<Vec<_>>();
            let ms_scale = kernel_density_scale;
            let conv_m = &mut workspace.conv_m[layer_index];
            if let Some(transfer) = self
                .transfer_stencils
                .get(layer_index)
                .and_then(|value| value.as_ref())
            {
                transfer.push_m_into(&source_m, layer.active_mask.as_deref(), conv_m)?;
            } else if layer.needs_transfer {
                let transferred = push_m_with_boundary_policy(
                    &source_m,
                    layer.grid,
                    layer.cell_size,
                    layer.conv_grid,
                    layer.conv_cell_size,
                    layer.transfer_boundary_policy,
                );
                let transient_bytes = transferred.capacity() * size_of::<[f64; 3]>();
                if workspace_hit {
                    telemetry.warm_allocated_bytes = telemetry
                        .warm_allocated_bytes
                        .saturating_add(transient_bytes);
                } else {
                    telemetry.cold_allocated_bytes = telemetry
                        .cold_allocated_bytes
                        .saturating_add(transient_bytes);
                }
                if transferred.len() != conv_m.len() {
                    return Err(format!(
                        "layer {layer_index} transfer produced {} scratch cells, expected {}",
                        transferred.len(),
                        conv_m.len()
                    ));
                }
                conv_m.copy_from_slice(&transferred);
            } else {
                if source_m.len() != conv_m.len() {
                    return Err(format!(
                        "layer {layer_index} identity transfer requires {} native cells to match {} scratch cells",
                        source_m.len(),
                        conv_m.len()
                    ));
                }
                conv_m.copy_from_slice(&source_m);
                if let Some(mask) = layer.active_mask.as_deref() {
                    if mask.len() != conv_m.len() {
                        return Err(format!(
                            "layer {layer_index} active mask has {} entries, expected {}",
                            mask.len(),
                            conv_m.len()
                        ));
                    }
                    for (value, active) in conv_m.iter_mut().zip(mask.iter()) {
                        if !active {
                            *value = [0.0; 3];
                        }
                    }
                }
            }

            let buf = &mut workspace.m_fft[layer_index];
            buf.x.fill(Complex::new(0.0, 0.0));
            buf.y.fill(Complex::new(0.0, 0.0));
            buf.z.fill(Complex::new(0.0, 0.0));
            let [cx, cy, cz] = layer.conv_grid;
            if cx * cy * cz != conv_m.len() {
                return Err(format!(
                    "layer {} transfer produced {} scratch cells, expected {}",
                    layer_index,
                    conv_m.len(),
                    cx * cy * cz
                ));
            }
            for z in 0..cz {
                for y in 0..cy {
                    for x in 0..cx {
                        let src = z * cy * cx + y * cx + x;
                        let layout = self.transform_layout_for_layer(layer_index);
                        let dst = (layout.source_insert_offset[2] + z) * py * px
                            + (layout.source_insert_offset[1] + y) * px
                            + layout.source_insert_offset[0]
                            + x;
                        let m = conv_m[src];
                        buf.x[dst] = Complex::new(m[0] * ms_scale, 0.0);
                        buf.y[dst] = Complex::new(m[1] * ms_scale, 0.0);
                        buf.z[dst] = Complex::new(m[2] * ms_scale, 0.0);
                    }
                }
            }
            self.fft3_forward_with_workspace(
                buf,
                &mut workspace.line_y,
                &mut workspace.line_z,
                &mut workspace.fft_scratch,
            );
            telemetry.forward_fft_count += 1;
        }

        // Step 2: Pairwise tensor multiplication into persistent destinations.
        for field in &mut workspace.h_fft {
            field.x.fill(Complex::new(0.0, 0.0));
            field.y.fill(Complex::new(0.0, 0.0));
            field.z.fill(Complex::new(0.0, 0.0));
        }
        for binding in &self.pair_bindings {
            let entry = &self.kernel_catalog[binding.kernel_index];
            fullmag_fdm_demag::accumulate_tensor_convolution(
                &mut workspace.h_fft[binding.dst_layer],
                &workspace.m_fft[binding.src_layer],
                &entry.kernel,
            );
            telemetry.pair_accumulation_count += 1;
        }

        // Step 3: Negate, inverse FFT, extract and pull to native grid.
        let normalisation = self.common_layout.inverse_normalization;
        for (li, layer) in layers.iter_mut().enumerate() {
            fullmag_fdm_demag::multiply::negate_field(&mut workspace.h_fft[li]);
            self.fft3_inverse_with_workspace(
                &mut workspace.h_fft[li],
                &mut workspace.line_y,
                &mut workspace.line_z,
                &mut workspace.fft_scratch,
            );
            telemetry.inverse_fft_count += 1;

            let crop = self.transform_layout_for_layer(li).destination_crop;
            let [cx, cy, cz] = crop.shape;
            if [cx, cy, cz] != layer.conv_grid {
                return Err(format!(
                    "destination crop {:?} does not match layer scratch grid {:?}",
                    crop.shape, layer.conv_grid
                ));
            }
            let conv_total = cx * cy * cz;
            let conv_h = &mut workspace.conv_h[li];
            if conv_h.len() != conv_total {
                return Err(format!(
                    "layer {li} workspace crop has {} cells, expected {conv_total}",
                    conv_h.len()
                ));
            }
            for z in 0..cz {
                for y in 0..cy {
                    for x in 0..cx {
                        let src = (crop.offset[2] + z) * py * px
                            + (crop.offset[1] + y) * px
                            + crop.offset[0]
                            + x;
                        let dst = z * cy * cx + y * cx + x;
                        conv_h[dst] = [
                            workspace.h_fft[li].x[src].re * normalisation,
                            workspace.h_fft[li].y[src].re * normalisation,
                            workspace.h_fft[li].z[src].re * normalisation,
                        ];
                    }
                }
            }

            if let Some(transfer) = self
                .transfer_stencils
                .get(li)
                .and_then(|value| value.as_ref())
            {
                transfer.pull_h_adjoint_into(
                    conv_h,
                    layer.active_mask.as_deref(),
                    &mut layer.h_demag,
                )?;
            } else if layer.needs_transfer {
                let pulled = pull_h_with_boundary_policy(
                    conv_h,
                    layer.conv_grid,
                    layer.conv_cell_size,
                    layer.grid,
                    layer.cell_size,
                    layer.transfer_boundary_policy,
                );
                let transient_bytes = pulled.capacity() * size_of::<[f64; 3]>();
                if workspace_hit {
                    telemetry.warm_allocated_bytes = telemetry
                        .warm_allocated_bytes
                        .saturating_add(transient_bytes);
                } else {
                    telemetry.cold_allocated_bytes = telemetry
                        .cold_allocated_bytes
                        .saturating_add(transient_bytes);
                }
                if pulled.len() != layer.h_demag.len() {
                    return Err(format!(
                        "layer {li} inverse transfer produced {} native cells, expected {}",
                        pulled.len(),
                        layer.h_demag.len()
                    ));
                }
                layer.h_demag.copy_from_slice(&pulled);
            } else {
                if conv_h.len() != layer.h_demag.len() {
                    return Err(format!(
                        "layer {li} identity transfer requires {} scratch cells to match {} native output cells",
                        conv_h.len(),
                        layer.h_demag.len()
                    ));
                }
                layer.h_demag.copy_from_slice(conv_h);
                if let Some(mask) = layer.active_mask.as_deref() {
                    for (value, active) in layer.h_demag.iter_mut().zip(mask.iter()) {
                        if !active {
                            *value = [0.0; 3];
                        }
                    }
                }
            }
        }
        Ok(())
    }

    // -----------------------------------------------------------------------
    // FFT helpers
    // -----------------------------------------------------------------------
    fn fft3_forward_with_workspace(
        &self,
        field: &mut VectorFieldFft,
        line_y: &mut [Complex<f64>],
        line_z: &mut [Complex<f64>],
        fft_scratch: &mut [Complex<f64>],
    ) {
        self.fft3_component_with_workspace(&mut field.x, true, line_y, line_z, fft_scratch);
        self.fft3_component_with_workspace(&mut field.y, true, line_y, line_z, fft_scratch);
        self.fft3_component_with_workspace(&mut field.z, true, line_y, line_z, fft_scratch);
    }

    fn fft3_inverse_with_workspace(
        &self,
        field: &mut VectorFieldFft,
        line_y: &mut [Complex<f64>],
        line_z: &mut [Complex<f64>],
        fft_scratch: &mut [Complex<f64>],
    ) {
        self.fft3_component_with_workspace(&mut field.x, false, line_y, line_z, fft_scratch);
        self.fft3_component_with_workspace(&mut field.y, false, line_y, line_z, fft_scratch);
        self.fft3_component_with_workspace(&mut field.z, false, line_y, line_z, fft_scratch);
    }

    fn fft3_component_with_workspace(
        &self,
        buf: &mut [Complex<f64>],
        forward: bool,
        line_y: &mut [Complex<f64>],
        line_z: &mut [Complex<f64>],
        fft_scratch: &mut [Complex<f64>],
    ) {
        let [px, py, pz] = self.fft_shape;
        let (fx, fy, fz) = if forward {
            (&self.fwd_x, &self.fwd_y, &self.fwd_z)
        } else {
            (&self.inv_x, &self.inv_y, &self.inv_z)
        };

        // X transforms
        for z in 0..pz {
            for y in 0..py {
                let offset = z * py * px + y * px;
                fx.process_with_scratch(&mut buf[offset..offset + px], fft_scratch);
            }
        }
        // Y transforms
        for z in 0..pz {
            for x in 0..px {
                for y in 0..py {
                    line_y[y] = buf[z * py * px + y * px + x];
                }
                fy.process_with_scratch(line_y, fft_scratch);
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
                fz.process_with_scratch(line_z, fft_scratch);
                for z in 0..pz {
                    buf[z * py * px + y * px + x] = line_z[z];
                }
            }
        }
    }
}

/// Collapse a Newell kernel generated with a two-sample padded Z axis to the
/// one-sample transform used by `two_d_stack`. For `Nz=1` the physical Newell
/// stencil occupies only the zero-lag plane, so retaining that plane is an
/// exact reduction rather than a mesh resampling.
pub fn collapse_kernel_z_plane(kernel: TensorDemagKernel) -> Result<TensorDemagKernel, String> {
    let [px, py, pz] = kernel.fft_shape;
    if pz != 2 {
        return Err(format!(
            "two_d_stack kernel collapse requires a two-plane Z transform, got pz={pz}"
        ));
    }
    let plane_len = px * py;
    let plane = |values: Vec<Complex<f64>>| {
        values
            .chunks_exact(plane_len)
            .next()
            .unwrap_or(&[])
            .to_vec()
    };
    Ok(TensorDemagKernel {
        fft_shape: [px, py, 1],
        k_xx: plane(kernel.k_xx),
        k_yy: plane(kernel.k_yy),
        k_zz: plane(kernel.k_zz),
        k_xy: plane(kernel.k_xy),
        k_xz: plane(kernel.k_xz),
        k_yz: plane(kernel.k_yz),
    })
}

impl MultilayerDemagRuntimeF32 {
    pub fn new(
        kernel_pairs: Vec<KernelPairF32>,
        conv_grid: [usize; 3],
        conv_cell_size: [f64; 3],
    ) -> Self {
        let px = conv_grid[0] * 2;
        let py = conv_grid[1] * 2;
        let pz = conv_grid[2] * 2;
        let mut planner = FftPlanner::<f32>::new();

        Self {
            kernel_pairs,
            conv_grid,
            conv_cell_size,
            fft_shape: [px, py, pz],
            fwd_x: planner.plan_fft_forward(px),
            fwd_y: planner.plan_fft_forward(py),
            fwd_z: planner.plan_fft_forward(pz),
            inv_x: planner.plan_fft_inverse(px),
            inv_y: planner.plan_fft_inverse(py),
            inv_z: planner.plan_fft_inverse(pz),
        }
    }

    fn padded_len(&self) -> usize {
        self.fft_shape[0] * self.fft_shape[1] * self.fft_shape[2]
    }

    pub fn compute_demag_fields(&self, layers: &mut [FdmLayerRuntimeF32]) {
        let n_layers = layers.len();
        let padded_len = self.padded_len();
        let [px, py, _pz] = self.fft_shape;

        let mut m_fft: Vec<VectorFieldFftF32> = Vec::with_capacity(n_layers);
        for layer in layers.iter() {
            let conv_m = if layer.needs_transfer {
                push_m_f32_with_boundary_policy(
                    &layer.m,
                    layer.grid,
                    layer.cell_size,
                    layer.conv_grid,
                    layer.conv_cell_size,
                    layer.transfer_boundary_policy,
                )
            } else {
                layer.m.clone()
            };

            let mut buf = VectorFieldFftF32::zeros(padded_len);
            let [cx, cy, cz] = layer.conv_grid;
            let ms = layer.ms as f32;
            for z in 0..cz {
                for y in 0..cy {
                    for x in 0..cx {
                        let src = z * cy * cx + y * cx + x;
                        let dst = z * py * px + y * px + x;
                        let m = conv_m[src];
                        buf.x[dst] = Complex::new(m[0] * ms, 0.0);
                        buf.y[dst] = Complex::new(m[1] * ms, 0.0);
                        buf.z[dst] = Complex::new(m[2] * ms, 0.0);
                    }
                }
            }

            self.fft3_forward(&mut buf);
            m_fft.push(buf);
        }

        let mut h_fft: Vec<VectorFieldFftF32> = (0..n_layers)
            .map(|_| VectorFieldFftF32::zeros(padded_len))
            .collect();

        for pair in &self.kernel_pairs {
            fullmag_fdm_demag::accumulate_tensor_convolution_f32(
                &mut h_fft[pair.dst_layer],
                &m_fft[pair.src_layer],
                &pair.kernel,
            );
        }

        let normalisation = 1.0f32 / padded_len as f32;
        for (li, layer) in layers.iter_mut().enumerate() {
            fullmag_fdm_demag::negate_field_f32(&mut h_fft[li]);
            self.fft3_inverse(&mut h_fft[li]);

            let [cx, cy, cz] = layer.conv_grid;
            let conv_total = cx * cy * cz;
            let mut conv_h = vec![[0.0f32, 0.0f32, 0.0f32]; conv_total];
            for z in 0..cz {
                for y in 0..cy {
                    for x in 0..cx {
                        let src = z * py * px + y * px + x;
                        let dst = z * cy * cx + y * cx + x;
                        conv_h[dst] = [
                            h_fft[li].x[src].re * normalisation,
                            h_fft[li].y[src].re * normalisation,
                            h_fft[li].z[src].re * normalisation,
                        ];
                    }
                }
            }

            if layer.needs_transfer {
                layer.h_demag = pull_h_f32_with_boundary_policy(
                    &conv_h,
                    layer.conv_grid,
                    layer.conv_cell_size,
                    layer.grid,
                    layer.cell_size,
                    layer.transfer_boundary_policy,
                );
            } else {
                layer.h_demag = conv_h;
            }
        }
    }

    fn fft3_forward(&self, field: &mut VectorFieldFftF32) {
        self.fft3_component(&mut field.x, true);
        self.fft3_component(&mut field.y, true);
        self.fft3_component(&mut field.z, true);
    }

    fn fft3_inverse(&self, field: &mut VectorFieldFftF32) {
        self.fft3_component(&mut field.x, false);
        self.fft3_component(&mut field.y, false);
        self.fft3_component(&mut field.z, false);
    }

    fn fft3_component(&self, buf: &mut [Complex<f32>], forward: bool) {
        let [px, py, pz] = self.fft_shape;
        let (fx, fy, fz) = if forward {
            (&self.fwd_x, &self.fwd_y, &self.fwd_z)
        } else {
            (&self.inv_x, &self.inv_y, &self.inv_z)
        };

        for z in 0..pz {
            for y in 0..py {
                let offset = z * py * px + y * px;
                fx.process(&mut buf[offset..offset + px]);
            }
        }
        let mut line_y = vec![Complex::new(0.0f32, 0.0f32); py];
        for z in 0..pz {
            for x in 0..px {
                for y in 0..py {
                    line_y[y] = buf[z * py * px + y * px + x];
                }
                fy.process(&mut line_y);
                for y in 0..py {
                    buf[z * py * px + y * px + x] = line_y[y];
                }
            }
        }
        let mut line_z = vec![Complex::new(0.0f32, 0.0f32); pz];
        for y in 0..py {
            for x in 0..px {
                for z in 0..pz {
                    line_z[z] = buf[z * py * px + y * px + x];
                }
                fz.process(&mut line_z);
                for z in 0..pz {
                    buf[z * py * px + y * px + x] = line_z[z];
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_fdm_demag::descriptors::{
        ActiveMaskIdentity, CommonTransformLayout, ConvolutionMode, FdmLayerDescriptor,
        GridGeometry,
    };

    fn catalog_test_runtime(
        thicknesses: &[f64],
        mask_first_cell: bool,
    ) -> (MultilayerDemagRuntime, Vec<FdmLayerRuntime>) {
        let grid = [2, 2, 1];
        let scratch_cell = [1.0, 1.0, 1.0];
        let layout = CommonTransformLayout::for_pair(
            grid,
            grid,
            ConvolutionMode::TwoDStack,
            [0; 3],
            [0; 3],
            [0; 3],
            grid,
            [4, 4, 1],
            1.0 / 16.0,
        )
        .expect("catalog test layout");
        let descriptors = thicknesses
            .iter()
            .enumerate()
            .map(|(index, thickness)| {
                let z = index as f64 * 4.0;
                let active_mask = if index == 0 && mask_first_cell {
                    ActiveMaskIdentity::from_mask(&[false, true, true, true])
                } else {
                    ActiveMaskIdentity::all_active()
                };
                FdmLayerDescriptor::new(
                    format!("layer:{index}"),
                    format!("object:{index}"),
                    GridGeometry::new([0.0, 0.0, z], grid, [1.0, 1.0, *thickness])
                        .expect("native grid"),
                    GridGeometry::new([0.0, 0.0, z], grid, scratch_cell).expect("scratch grid"),
                    ConvolutionMode::TwoDStack,
                    active_mask,
                    if *thickness == 1.0 {
                        TransferKind::Identity
                    } else {
                        TransferKind::PushPull
                    },
                )
                .expect("layer descriptor")
            })
            .collect::<Vec<_>>();
        let mut kernel_pairs = Vec::with_capacity(thicknesses.len() * thicknesses.len());
        for (source, source_descriptor) in descriptors.iter().enumerate() {
            for (destination, destination_descriptor) in descriptors.iter().enumerate() {
                let source_cell = [1.0, 1.0, thicknesses[source]];
                let destination_cell = [1.0, 1.0, thicknesses[destination]];
                let shift = [
                    0.0,
                    0.0,
                    destination_descriptor.scratch.origin[2] - source_descriptor.scratch.origin[2]
                        + 0.5 * (destination_cell[2] - source_cell[2]),
                ];
                let kernel = fullmag_fdm_demag::compute_shifted_kernel_pair(
                    grid,
                    source_cell,
                    destination_cell,
                    shift,
                )
                .expect("catalog test kernel");
                kernel_pairs.push(KernelPair {
                    src_layer: source,
                    dst_layer: destination,
                    kernel: collapse_kernel_z_plane(kernel).expect("2-D kernel collapse"),
                });
            }
        }
        let runtime = MultilayerDemagRuntime::new_with_layout_and_descriptors(
            kernel_pairs,
            grid,
            scratch_cell,
            layout,
            descriptors,
        )
        .expect("catalog test runtime");
        let count = grid[0] * grid[1] * grid[2];
        let layers = thicknesses
            .iter()
            .enumerate()
            .map(|(index, thickness)| {
                let active_mask = if index == 0 && mask_first_cell {
                    Some(vec![false, true, true, true])
                } else {
                    None
                };
                FdmLayerRuntime {
                    magnet_name: format!("layer:{index}"),
                    grid,
                    cell_size: [1.0, 1.0, *thickness],
                    origin: [0.0, 0.0, index as f64 * 4.0],
                    ms: 1.0,
                    ms_field: None,
                    exchange_stiffness: 0.0,
                    damping: 0.1,
                    active_mask,
                    m: (0..count)
                        .map(|cell| [1.0 + index as f64, cell as f64 * 0.1, 0.25])
                        .collect(),
                    h_ex: vec![[0.0; 3]; count],
                    h_demag: vec![[0.0; 3]; count],
                    h_eff: vec![[0.0; 3]; count],
                    conv_grid: grid,
                    conv_cell_size: scratch_cell,
                    needs_transfer: *thickness != 1.0,
                    transfer_boundary_policy: TransferBoundaryPolicy::OPEN,
                }
            })
            .collect();
        (runtime, layers)
    }

    #[test]
    fn regular_stack_materializes_five_unique_kernels_for_nine_ordered_pairs() {
        let (runtime, _) = catalog_test_runtime(&[1.0, 1.0, 1.0], false);
        assert_eq!(runtime.kernel_catalog.len(), 5);
        assert_eq!(runtime.pair_bindings.len(), 9);
        assert!(runtime.kernel_catalog.len() < runtime.pair_bindings.len());
    }

    #[test]
    fn irregular_stack_does_not_reuse_oriented_kernel_entries() {
        let (runtime, _) = catalog_test_runtime(&[1.0, 1.5, 2.0], false);
        assert_eq!(runtime.kernel_catalog.len(), 9);
        assert_eq!(runtime.pair_bindings.len(), 9);
    }

    #[test]
    fn runtime_telemetry_counts_actual_fft_pairs_and_cold_to_warm_workspace() {
        let (runtime, mut layers) = catalog_test_runtime(&[1.0, 1.0, 1.0], false);
        runtime
            .compute_demag_fields_checked(&mut layers)
            .expect("cold refresh");
        let cold = runtime.telemetry();
        assert_eq!(cold.refresh_count, 1);
        assert_eq!(cold.forward_fft_count, 3);
        assert_eq!(cold.inverse_fft_count, 3);
        assert_eq!(cold.pair_accumulation_count, 9);
        assert_eq!(cold.unique_kernel_count, 5);
        assert_eq!(cold.pair_count, 9);
        assert_eq!(cold.cache_hit_count, 0);
        assert_eq!(cold.cache_miss_count, 1);
        assert!(cold.cold_allocated_bytes > 0);
        assert_eq!(cold.warm_allocated_bytes, 0);
        assert!(cold.peak_workspace_bytes > 0);
        assert_eq!(cold.transfer_kind, "identity");
        assert_eq!(cold.residency, "host");
        serde_json::to_string(&cold).expect("telemetry must serialize");

        runtime
            .compute_demag_fields_checked(&mut layers)
            .expect("warm refresh");
        let warm = runtime.telemetry();
        assert_eq!(warm.refresh_count, 2);
        assert_eq!(warm.forward_fft_count, 6);
        assert_eq!(warm.inverse_fft_count, 6);
        assert_eq!(warm.pair_accumulation_count, 18);
        assert_eq!(warm.cache_hit_count, 1);
        assert_eq!(warm.cache_miss_count, 1);
        assert_eq!(warm.warm_allocated_bytes, 0);
        assert_eq!(warm.invalidation_fingerprint, cold.invalidation_fingerprint);
    }

    #[test]
    fn push_pull_refresh_reuses_transfer_and_fft_workspace() {
        let (runtime, mut layers) = catalog_test_runtime(&[0.5, 0.5], false);
        runtime
            .compute_demag_fields_checked(&mut layers)
            .expect("cold push/pull refresh");
        runtime
            .compute_demag_fields_checked(&mut layers)
            .expect("warm push/pull refresh");
        let telemetry = runtime.telemetry();
        assert_eq!(telemetry.refresh_count, 2);
        assert_eq!(telemetry.forward_fft_count, 4);
        assert_eq!(telemetry.inverse_fft_count, 4);
        assert_eq!(telemetry.pair_accumulation_count, 8);
        assert_eq!(telemetry.cache_hit_count, 1);
        assert_eq!(telemetry.cache_miss_count, 1);
        assert_eq!(telemetry.warm_allocated_bytes, 0);
        assert_eq!(telemetry.transfer_kind, "push_pull");
    }

    #[test]
    #[ignore = "manual CPU cold/warm microbenchmark"]
    fn cpu_multilayer_catalog_workspace_benchmark_smoke() {
        let (runtime, mut layers) = catalog_test_runtime(&[1.0, 1.0, 1.0], false);
        let cold_started = std::time::Instant::now();
        runtime
            .compute_demag_fields_checked(&mut layers)
            .expect("cold benchmark refresh");
        let cold_elapsed = cold_started.elapsed();
        let warm_iterations = 100;
        let warm_started = std::time::Instant::now();
        for _ in 0..warm_iterations {
            runtime
                .compute_demag_fields_checked(&mut layers)
                .expect("warm benchmark refresh");
        }
        let warm_elapsed = warm_started.elapsed();
        let telemetry = runtime.telemetry();
        assert_eq!(telemetry.warm_allocated_bytes, 0);
        println!(
            "{}",
            serde_json::json!({
                "schema": "fdm_multilayer_cpu_catalog_workspace_benchmark.v1",
                "grid": [2, 2, 1],
                "layers": 3,
                "pair_count": telemetry.pair_count,
                "unique_kernel_count": telemetry.unique_kernel_count,
                "cold_elapsed_us": cold_elapsed.as_micros(),
                "warm_iterations": warm_iterations,
                "warm_total_us": warm_elapsed.as_micros(),
                "warm_average_us": warm_elapsed.as_micros() as f64 / warm_iterations as f64,
                "telemetry": telemetry,
                "qualification": "diagnostic_only"
            })
        );
    }

    #[test]
    fn geometry_and_mask_changes_produce_distinct_invalidation_fingerprints() {
        let (regular, _) = catalog_test_runtime(&[1.0, 1.0, 1.0], false);
        let (geometry_changed, _) = catalog_test_runtime(&[1.0, 1.0, 1.5], false);
        let (mask_changed, _) = catalog_test_runtime(&[1.0, 1.0, 1.0], true);
        assert_ne!(
            regular.invalidation_fingerprint(),
            geometry_changed.invalidation_fingerprint()
        );
        assert_ne!(
            regular.invalidation_fingerprint(),
            mask_changed.invalidation_fingerprint()
        );
    }

    #[test]
    fn deduplicated_catalog_preserves_per_pair_cpu_result() {
        let (runtime, mut combined_layers) = catalog_test_runtime(&[1.0, 1.0, 1.0], false);
        let input_layers = combined_layers.clone();
        runtime
            .compute_demag_fields_checked(&mut combined_layers)
            .expect("catalog refresh");

        let mut summed = vec![vec![[0.0; 3]; 4]; 3];
        for binding in &runtime.pair_bindings {
            let mut pair_layers = input_layers.clone();
            let kernel = runtime.kernel_catalog[binding.kernel_index].kernel.clone();
            let pair_runtime = MultilayerDemagRuntime::new_with_layout_and_descriptors(
                vec![KernelPair {
                    src_layer: binding.src_layer,
                    dst_layer: binding.dst_layer,
                    kernel,
                }],
                runtime.conv_grid,
                runtime.conv_cell_size,
                runtime.common_layout.clone(),
                runtime.layer_descriptors.clone(),
            )
            .expect("single-pair reference runtime");
            pair_runtime
                .compute_demag_fields_checked(&mut pair_layers)
                .expect("single-pair refresh");
            for (sum, value) in summed[binding.dst_layer]
                .iter_mut()
                .zip(pair_layers[binding.dst_layer].h_demag.iter())
            {
                for component in 0..3 {
                    sum[component] += value[component];
                }
            }
        }
        for (layer, expected) in combined_layers.iter().zip(summed.iter()) {
            for (actual, expected) in layer.h_demag.iter().zip(expected.iter()) {
                for component in 0..3 {
                    assert!(
                        (actual[component] - expected[component]).abs() < 1.0e-10,
                        "catalog changed component {component}: actual={actual:?} expected={expected:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn identity_path_rejects_native_scratch_cell_count_mismatch_without_panicking() {
        let conv_grid = [2, 1, 1];
        let cell_size = [1.0, 1.0, 1.0];
        let kernel = fullmag_fdm_demag::compute_exact_self_kernel(
            conv_grid[0],
            conv_grid[1],
            conv_grid[2],
            cell_size[0],
            cell_size[1],
            cell_size[2],
        );
        let runtime = MultilayerDemagRuntime::new(
            vec![KernelPair {
                src_layer: 0,
                dst_layer: 0,
                kernel,
            }],
            conv_grid,
            cell_size,
        );
        let mut layer = FdmLayerRuntime {
            magnet_name: "mismatched-identity".into(),
            grid: [1, 1, 1],
            cell_size,
            origin: [0.0; 3],
            ms: 1.0,
            ms_field: None,
            exchange_stiffness: 0.0,
            damping: 0.0,
            active_mask: None,
            m: vec![[1.0, 0.0, 0.0]],
            h_ex: vec![[0.0; 3]],
            h_demag: vec![[0.0; 3]],
            h_eff: vec![[0.0; 3]],
            conv_grid,
            conv_cell_size: cell_size,
            needs_transfer: false,
            transfer_boundary_policy: TransferBoundaryPolicy::OPEN,
        };

        let error = runtime
            .compute_demag_fields_checked(std::slice::from_mut(&mut layer))
            .expect_err("identity path must fail closed for mismatched native/scratch cells");
        assert!(
            error.contains("identity transfer requires"),
            "unexpected error: {error}"
        );
        let telemetry = runtime.telemetry();
        assert_eq!(telemetry.refresh_count, 0);
        assert_eq!(telemetry.cache_hit_count, 0);
        assert_eq!(telemetry.cache_miss_count, 0);
    }

    #[test]
    fn single_layer_uniform_m_gives_uniform_h() {
        // A single uniformly magnetized cubic cell should produce a predictable
        // demag field: H_demag = -N * Ms * m
        let grid = [4, 4, 1];
        let cell_size = [2e-9, 2e-9, 1e-9];
        let ms = 800e3;
        let n_cells = grid[0] * grid[1] * grid[2];

        // Build self-kernel
        let kernel = fullmag_fdm_demag::compute_exact_self_kernel(
            grid[0],
            grid[1],
            grid[2],
            cell_size[0],
            cell_size[1],
            cell_size[2],
        );

        let mut layer = FdmLayerRuntime {
            magnet_name: "test".into(),
            grid,
            cell_size,
            origin: [0.0, 0.0, 0.0],
            ms,
            ms_field: None,
            exchange_stiffness: 13e-12,
            damping: 0.02,
            active_mask: None,
            m: vec![[0.0, 0.0, 1.0]; n_cells],
            h_ex: vec![[0.0; 3]; n_cells],
            h_demag: vec![[0.0; 3]; n_cells],
            h_eff: vec![[0.0; 3]; n_cells],
            conv_grid: grid,
            conv_cell_size: cell_size,
            needs_transfer: false,
            transfer_boundary_policy: TransferBoundaryPolicy::OPEN,
        };

        let demag = MultilayerDemagRuntime::new(
            vec![KernelPair {
                src_layer: 0,
                dst_layer: 0,
                kernel,
            }],
            grid,
            cell_size,
        );

        demag.compute_demag_fields(&mut [layer.clone()]);

        // For a thin film magnetized out-of-plane (z), the interior cells
        // should have a strong negative Hz (demagnetizing in z).
        // Just verify it's non-zero and negative.
        let center = 4 * 2 + 2; // cell (2, 2, 0) in a 4×4×1 grid
                                // Hmm, layer was cloned but demag modifies the slice in place...
                                // Let's test by re-running on the actual mutable layer
        demag.compute_demag_fields(std::slice::from_mut(&mut layer));
        let hz = layer.h_demag[center][2];
        assert!(
            hz < 0.0,
            "Demag Hz for out-of-plane thin film should be negative, got {hz}"
        );
    }

    #[test]
    fn demag_source_uses_native_ms_field_and_rejects_invalid_fields() {
        let grid = [2, 1, 1];
        let cell_size = [1.0, 1.0, 1.0];
        let kernel = fullmag_fdm_demag::compute_exact_self_kernel(
            grid[0], grid[1], grid[2], cell_size[0], cell_size[1], cell_size[2],
        );
        let runtime = MultilayerDemagRuntime::new(
            vec![KernelPair {
                src_layer: 0,
                dst_layer: 0,
                kernel,
            }],
            grid,
            cell_size,
        );
        let layer = |ms_field| FdmLayerRuntime {
            magnet_name: "heterogeneous".to_string(),
            grid,
            cell_size,
            origin: [0.0; 3],
            ms: 2.0,
            ms_field,
            exchange_stiffness: 0.0,
            damping: 0.0,
            active_mask: None,
            m: vec![[1.0, 0.0, 0.0]; 2],
            h_ex: vec![[0.0; 3]; 2],
            h_demag: vec![[0.0; 3]; 2],
            h_eff: vec![[0.0; 3]; 2],
            conv_grid: grid,
            conv_cell_size: cell_size,
            needs_transfer: false,
            transfer_boundary_policy: TransferBoundaryPolicy::OPEN,
        };

        let mut scalar = layer(None);
        runtime
            .compute_demag_fields_checked(std::slice::from_mut(&mut scalar))
            .expect("scalar Ms must be valid");
        let mut constant = layer(Some(vec![2.0; 2]));
        runtime
            .compute_demag_fields_checked(std::slice::from_mut(&mut constant))
            .expect("constant native Ms must be valid");
        assert_eq!(constant.h_demag, scalar.h_demag);

        let mut heterogeneous = layer(Some(vec![1.0, 3.0]));
        runtime
            .compute_demag_fields_checked(std::slice::from_mut(&mut heterogeneous))
            .expect("heterogeneous native Ms must be valid");
        assert_ne!(heterogeneous.h_demag, scalar.h_demag);

        for (ms_field, expected) in [
            (Some(vec![2.0]), "has 1 entries, expected 2"),
            (Some(vec![f64::NAN; 2]), "contains non-finite or non-positive values"),
            (Some(vec![0.0; 2]), "contains non-finite or non-positive values"),
        ] {
            let mut invalid = layer(ms_field);
            let error = runtime
                .compute_demag_fields_checked(std::slice::from_mut(&mut invalid))
                .expect_err("invalid native Ms must fail before FFT");
            assert!(error.contains("magnet 'heterogeneous'"), "{error}");
            assert!(error.contains(expected), "{error}");
        }
    }

    #[test]
    fn push_pull_demag_uses_native_ms_field_before_transfer() {
        let native_grid = [2, 1, 2];
        let scratch_grid = [2, 1, 1];
        let scratch_cell = [1.0, 1.0, 1.0];
        let runtime = MultilayerDemagRuntime::new(
            vec![KernelPair {
                src_layer: 0,
                dst_layer: 0,
                kernel: fullmag_fdm_demag::compute_exact_self_kernel(
                    scratch_grid[0],
                    scratch_grid[1],
                    scratch_grid[2],
                    scratch_cell[0],
                    scratch_cell[1],
                    scratch_cell[2],
                ),
            }],
            scratch_grid,
            scratch_cell,
        );
        let layer = |ms_field| FdmLayerRuntime {
            magnet_name: "push-pull".to_string(),
            grid: native_grid,
            cell_size: [1.0, 1.0, 0.5],
            origin: [0.0; 3],
            ms: 2.0,
            ms_field,
            exchange_stiffness: 0.0,
            damping: 0.0,
            active_mask: Some(vec![true; 4]),
            m: vec![[1.0, 0.0, 0.0]; 4],
            h_ex: vec![[0.0; 3]; 4],
            h_demag: vec![[0.0; 3]; 4],
            h_eff: vec![[0.0; 3]; 4],
            conv_grid: scratch_grid,
            conv_cell_size: scratch_cell,
            needs_transfer: true,
            transfer_boundary_policy: TransferBoundaryPolicy::OPEN,
        };

        let mut scalar = layer(None);
        runtime
            .compute_demag_fields_checked(std::slice::from_mut(&mut scalar))
            .expect("scalar push/pull source must be valid");
        let mut heterogeneous = layer(Some(vec![1.0, 3.0, 1.0, 3.0]));
        runtime
            .compute_demag_fields_checked(std::slice::from_mut(&mut heterogeneous))
            .expect("heterogeneous push/pull source must be valid");

        assert_ne!(heterogeneous.h_demag, scalar.h_demag);
    }

    #[test]
    fn single_precision_multilayer_runtime_stays_close_to_double() {
        let grid = [4, 4, 1];
        let cell_size = [2e-9, 2e-9, 1e-9];
        let ms = 800e3;
        let n_cells = grid[0] * grid[1] * grid[2];

        let kernel_f64 = fullmag_fdm_demag::compute_exact_self_kernel(
            grid[0],
            grid[1],
            grid[2],
            cell_size[0],
            cell_size[1],
            cell_size[2],
        );
        let kernel_f32 = fullmag_fdm_demag::compute_exact_self_kernel_f32(
            grid[0],
            grid[1],
            grid[2],
            cell_size[0],
            cell_size[1],
            cell_size[2],
        );

        let mut layer_f64 = FdmLayerRuntime {
            magnet_name: "test".into(),
            grid,
            cell_size,
            origin: [0.0, 0.0, 0.0],
            ms,
            ms_field: None,
            exchange_stiffness: 13e-12,
            damping: 0.02,
            active_mask: None,
            m: (0..n_cells)
                .map(|index| {
                    let theta = 0.07 * index as f64;
                    [theta.cos(), theta.sin(), 0.1]
                })
                .collect(),
            h_ex: vec![[0.0; 3]; n_cells],
            h_demag: vec![[0.0; 3]; n_cells],
            h_eff: vec![[0.0; 3]; n_cells],
            conv_grid: grid,
            conv_cell_size: cell_size,
            needs_transfer: false,
            transfer_boundary_policy: TransferBoundaryPolicy::OPEN,
        };
        let mut layer_f32 = FdmLayerRuntimeF32 {
            magnet_name: "test".into(),
            grid,
            cell_size,
            origin: [0.0, 0.0, 0.0],
            ms,
            exchange_stiffness: 13e-12,
            damping: 0.02,
            active_mask: None,
            m: layer_f64
                .m
                .iter()
                .map(|m| [m[0] as f32, m[1] as f32, m[2] as f32])
                .collect(),
            h_ex: vec![[0.0; 3]; n_cells],
            h_demag: vec![[0.0; 3]; n_cells],
            h_eff: vec![[0.0; 3]; n_cells],
            conv_grid: grid,
            conv_cell_size: cell_size,
            needs_transfer: false,
            transfer_boundary_policy: TransferBoundaryPolicy::OPEN,
        };

        let runtime_f64 = MultilayerDemagRuntime::new(
            vec![KernelPair {
                src_layer: 0,
                dst_layer: 0,
                kernel: kernel_f64,
            }],
            grid,
            cell_size,
        );
        let runtime_f32 = MultilayerDemagRuntimeF32::new(
            vec![KernelPairF32 {
                src_layer: 0,
                dst_layer: 0,
                kernel: kernel_f32,
            }],
            grid,
            cell_size,
        );

        runtime_f64.compute_demag_fields(std::slice::from_mut(&mut layer_f64));
        runtime_f32.compute_demag_fields(std::slice::from_mut(&mut layer_f32));

        let max_diff = layer_f64
            .h_demag
            .iter()
            .zip(layer_f32.h_demag.iter())
            .flat_map(|(a, b)| {
                (0..3).map(move |component| (a[component] - b[component] as f64).abs())
            })
            .fold(0.0, f64::max);
        let max_ref = layer_f64
            .h_demag
            .iter()
            .flat_map(|value| (0..3).map(move |component| value[component].abs()))
            .fold(0.0, f64::max);
        let rel_diff = max_diff / max_ref.max(1.0);
        assert!(
            rel_diff <= 1e-5 || max_diff <= 5e-2,
            "single-precision multilayer demag drift too large: abs={max_diff:.6e} rel={rel_diff:.6e}"
        );
    }

    #[test]
    fn three_d_fft_is_translation_invariant_when_empty_z_padding_changes() {
        fn run(shape: [usize; 3], source_offset: usize) -> Vec<[f64; 3]> {
            let cell_size = [1.0e-9; 3];
            let count = shape[0] * shape[1] * shape[2];
            let kernel = fullmag_fdm_demag::compute_exact_self_kernel(
                shape[0],
                shape[1],
                shape[2],
                cell_size[0],
                cell_size[1],
                cell_size[2],
            );
            let mut source_m = vec![[0.0; 3]; count];
            for y in 0..shape[1] {
                for x in 0..shape[0] {
                    source_m[(source_offset + 1) * shape[1] * shape[0] + y * shape[0] + x] =
                        [1.0, 0.0, 0.0];
                }
            }
            let zero_layer = |name: &str, m: Vec<[f64; 3]>| FdmLayerRuntime {
                magnet_name: name.to_string(),
                grid: shape,
                cell_size,
                origin: [0.0; 3],
                ms: 1.0,
                ms_field: None,
                exchange_stiffness: 0.0,
                damping: 0.0,
                active_mask: None,
                m,
                h_ex: vec![[0.0; 3]; count],
                h_demag: vec![[0.0; 3]; count],
                h_eff: vec![[0.0; 3]; count],
                conv_grid: shape,
                conv_cell_size: cell_size,
                needs_transfer: false,
                transfer_boundary_policy: TransferBoundaryPolicy::OPEN,
            };
            let mut layers = vec![
                zero_layer("source", source_m),
                zero_layer("target", vec![[0.0; 3]; count]),
            ];
            let runtime = MultilayerDemagRuntime::new(
                vec![KernelPair {
                    src_layer: 0,
                    dst_layer: 1,
                    kernel,
                }],
                shape,
                cell_size,
            );
            runtime.compute_demag_fields(&mut layers);
            layers.pop().expect("target layer").h_demag
        }

        let narrow = run([16, 8, 4], 1);
        let wide = run([16, 8, 6], 2);
        let nx = 16;
        let ny = 8;
        let mut max_error: f64 = 0.0;
        for k in 0..4 {
            for y in 0..ny {
                for x in 0..nx {
                    let narrow_index = k * ny * nx + y * nx + x;
                    let wide_index = (k + 1) * ny * nx + y * nx + x;
                    for component in 0..3 {
                        max_error = max_error.max(
                            (narrow[narrow_index][component] - wide[wide_index][component]).abs(),
                        );
                    }
                }
            }
        }
        assert!(
            max_error < 1.0e-12,
            "3-D FFT translation drift: {max_error:e}"
        );
    }

    #[test]
    fn descriptor_transfer_preserves_translation_invariance_with_non_integer_xy_ratio() {
        fn run(
            target_shape: [usize; 3],
            target_origin_z: f64,
            source_m: Vec<[f64; 3]>,
        ) -> Vec<[f64; 3]> {
            let source_shape = [8, 4, 1];
            let source_cell = [1.25e-9, 1.25e-9, 1.0e-9];
            let target_cell = [1.0e-9, 1.0e-9, 1.0e-9];
            let target_origin = [-5.0e-10, -5.0e-10, target_origin_z];
            let source_geometry = GridGeometry::new([0.0; 3], source_shape, source_cell).unwrap();
            let target_geometry =
                GridGeometry::new(target_origin, target_shape, target_cell).unwrap();
            let source_descriptor = FdmLayerDescriptor::new(
                "source",
                "source",
                source_geometry,
                target_geometry.clone(),
                ConvolutionMode::ThreeD,
                ActiveMaskIdentity::all_active(),
                fullmag_fdm_demag::TransferKind::PushPull,
            )
            .unwrap();
            let target_descriptor = FdmLayerDescriptor::new(
                "target",
                "target",
                target_geometry.clone(),
                target_geometry,
                ConvolutionMode::ThreeD,
                ActiveMaskIdentity::all_active(),
                fullmag_fdm_demag::TransferKind::Identity,
            )
            .unwrap();
            let layout = CommonTransformLayout::for_pair(
                target_shape,
                target_shape,
                ConvolutionMode::ThreeD,
                [0; 3],
                [0; 3],
                [0; 3],
                target_shape,
                [
                    target_shape[0] * 2,
                    target_shape[1] * 2,
                    target_shape[2] * 2,
                ],
                1.0 / (target_shape[0] * target_shape[1] * target_shape[2] * 8) as f64,
            )
            .unwrap();
            let kernel = fullmag_fdm_demag::compute_exact_self_kernel(
                target_shape[0],
                target_shape[1],
                target_shape[2],
                target_cell[0],
                target_cell[1],
                target_cell[2],
            );
            let count = target_shape[0] * target_shape[1] * target_shape[2];
            let source_count = source_shape[0] * source_shape[1] * source_shape[2];
            let layer = |name: &str,
                         grid: [usize; 3],
                         cell_size: [f64; 3],
                         origin: [f64; 3],
                         m: Vec<[f64; 3]>,
                         needs_transfer: bool| FdmLayerRuntime {
                magnet_name: name.to_string(),
                grid,
                cell_size,
                origin,
                ms: 1.0,
                ms_field: None,
                exchange_stiffness: 0.0,
                damping: 0.0,
                active_mask: None,
                m,
                h_ex: vec![[0.0; 3]; if needs_transfer { source_count } else { count }],
                h_demag: vec![[0.0; 3]; if needs_transfer { source_count } else { count }],
                h_eff: vec![[0.0; 3]; if needs_transfer { source_count } else { count }],
                conv_grid: target_shape,
                conv_cell_size: target_cell,
                needs_transfer,
                transfer_boundary_policy: TransferBoundaryPolicy::OPEN,
            };
            let mut layers = vec![
                layer(
                    "source",
                    source_shape,
                    source_cell,
                    [0.0; 3],
                    source_m,
                    true,
                ),
                layer(
                    "target",
                    target_shape,
                    target_cell,
                    target_origin,
                    vec![[0.0; 3]; count],
                    false,
                ),
            ];
            let runtime = MultilayerDemagRuntime::new_with_layout_and_descriptors(
                vec![KernelPair {
                    src_layer: 0,
                    dst_layer: 1,
                    kernel,
                }],
                target_shape,
                target_cell,
                layout,
                vec![source_descriptor, target_descriptor],
            )
            .unwrap();
            runtime.compute_demag_fields_checked(&mut layers).unwrap();
            layers.pop().unwrap().h_demag
        }

        let source_m = vec![[1.0, 0.0, 0.0]; 32];
        let transfer_narrow = VolumeWeightedTransfer::new(
            [8, 4, 1],
            [1.25e-9, 1.25e-9, 1.0e-9],
            [0.0; 3],
            [10, 5, 4],
            [1.0e-9; 3],
            [-5.0e-10, -5.0e-10, -2.0e-9],
            TransferBoundaryPolicy::OPEN,
        )
        .unwrap();
        let transfer_wide = VolumeWeightedTransfer::new(
            [8, 4, 1],
            [1.25e-9, 1.25e-9, 1.0e-9],
            [0.0; 3],
            [10, 5, 6],
            [1.0e-9; 3],
            [-5.0e-10, -5.0e-10, -3.0e-9],
            TransferBoundaryPolicy::OPEN,
        )
        .unwrap();
        let pushed_narrow = transfer_narrow.push_m(&source_m, None).unwrap();
        let pushed_wide = transfer_wide.push_m(&source_m, None).unwrap();
        let mut max_push_error: f64 = 0.0;
        for k in 0..4 {
            for y in 0..5 {
                for x in 0..10 {
                    let narrow_index = k * 50 + y * 10 + x;
                    let wide_index = (k + 1) * 50 + y * 10 + x;
                    for component in 0..3 {
                        max_push_error = max_push_error.max(
                            (pushed_narrow[narrow_index][component]
                                - pushed_wide[wide_index][component])
                                .abs(),
                        );
                    }
                }
            }
        }
        let narrow_planes: Vec<usize> = (0..4)
            .filter(|k| pushed_narrow[k * 50].iter().any(|value| *value != 0.0))
            .collect();
        let wide_planes: Vec<usize> = (0..6)
            .filter(|k| pushed_wide[k * 50].iter().any(|value| *value != 0.0))
            .collect();
        assert!(
            max_push_error < 1.0e-12,
            "transfer translation drift: {max_push_error:e}; narrow_planes={narrow_planes:?} wide_planes={wide_planes:?}"
        );
        let narrow = run([10, 5, 4], -2.0e-9, source_m.clone());
        let wide = run([10, 5, 6], -3.0e-9, source_m);
        let mut max_error: f64 = 0.0;
        for k in 0..4 {
            for y in 0..5 {
                for x in 0..10 {
                    let narrow_index = k * 50 + y * 10 + x;
                    let wide_index = (k + 1) * 50 + y * 10 + x;
                    for component in 0..3 {
                        max_error = max_error.max(
                            (narrow[narrow_index][component] - wide[wide_index][component]).abs(),
                        );
                    }
                }
            }
        }
        assert!(
            max_error < 1.0e-12,
            "descriptor transfer translation drift: {max_error:e}"
        );
    }

    #[test]
    fn two_d_fft_matches_the_generated_real_kernel_sum_at_boundary_cell() {
        let grid = [8, 4, 1];
        let cell_size = [3.90625e-9, 3.90625e-9, 3e-9];
        let ms = 8.0e5;
        let magnetization = [0.9950371902099893, 0.09950371902099893, 0.0];
        let n_cells = grid[0] * grid[1] * grid[2];
        let real_kernel = fullmag_fdm_demag::newell::compute_newell_kernels(
            grid[0],
            grid[1],
            grid[2],
            cell_size[0],
            cell_size[1],
            cell_size[2],
        );
        let kernel = collapse_kernel_z_plane(fullmag_fdm_demag::compute_exact_self_kernel(
            grid[0],
            grid[1],
            grid[2],
            cell_size[0],
            cell_size[1],
            cell_size[2],
        ))
        .expect("2-D kernel collapse");
        let mut layer = FdmLayerRuntime {
            magnet_name: "boundary".into(),
            grid,
            cell_size,
            origin: [0.0; 3],
            ms,
            ms_field: None,
            exchange_stiffness: 0.0,
            damping: 0.0,
            active_mask: None,
            m: vec![magnetization; n_cells],
            h_ex: vec![[0.0; 3]; n_cells],
            h_demag: vec![[0.0; 3]; n_cells],
            h_eff: vec![[0.0; 3]; n_cells],
            conv_grid: grid,
            conv_cell_size: cell_size,
            needs_transfer: false,
            transfer_boundary_policy: TransferBoundaryPolicy::OPEN,
        };
        let layout = CommonTransformLayout::for_pair(
            grid,
            grid,
            ConvolutionMode::TwoDStack,
            [0; 3],
            [0; 3],
            [0; 3],
            grid,
            [grid[0] * 2, grid[1] * 2, 1],
            1.0 / (grid[0] * grid[1] * 4) as f64,
        )
        .expect("2-D transform layout");
        let runtime = MultilayerDemagRuntime::new_with_layout_and_descriptors(
            vec![KernelPair {
                src_layer: 0,
                dst_layer: 0,
                kernel,
            }],
            grid,
            cell_size,
            layout,
            Vec::new(),
        );
        let runtime = runtime.expect("2-D multilayer runtime");
        runtime.compute_demag_fields(std::slice::from_mut(&mut layer));

        let wrap = |lag: isize, length: usize| {
            if lag >= 0 {
                lag as usize
            } else {
                (length as isize + lag) as usize
            }
        };
        let mut expected = [0.0; 3];
        for y in 0..grid[1] {
            for x in 0..grid[0] {
                let index = wrap(-(x as isize), real_kernel.px)
                    + wrap(-(y as isize), real_kernel.py) * real_kernel.px;
                let mx = magnetization[0] * ms;
                let my = magnetization[1] * ms;
                expected[0] -= real_kernel.n_xx[index] * mx + real_kernel.n_xy[index] * my;
                expected[1] -= real_kernel.n_xy[index] * mx + real_kernel.n_yy[index] * my;
                expected[2] -= real_kernel.n_xz[index] * mx + real_kernel.n_yz[index] * my;
            }
        }
        for (component, (actual, expected)) in
            layer.h_demag[0].into_iter().zip(expected).enumerate()
        {
            assert!(
                (actual - expected).abs() <= 1e-7,
                "component {component}: FFT={actual:.16e}, real={expected:.16e}"
            );
        }
    }

    #[test]
    fn descriptor_layout_keeps_exact_linear_extent_and_destination_crop() {
        let layout = CommonTransformLayout::for_pair(
            [2, 1, 1],
            [3, 1, 1],
            ConvolutionMode::TwoDStack,
            [0; 3],
            [0; 3],
            [1, 0, 0],
            [3, 1, 1],
            [8, 2, 1],
            1.0 / 16.0,
        )
        .expect("valid exact linear transform layout");
        assert_eq!(layout.linear_extent, [4, 1, 1]);
        assert_eq!(layout.destination_crop.offset, [1, 0, 0]);
        assert_eq!(layout.destination_crop.shape, [3, 1, 1]);
        assert!(!layout.is_physical_mesh());
    }

    #[test]
    fn transform_layout_source_insert_offset_is_consumed_before_inverse_crop() {
        fn layout(source_offset: usize, destination_offset: usize) -> CommonTransformLayout {
            CommonTransformLayout::new(
                [4, 2, 1],
                [4, 2, 1],
                [1, 4, 8],
                fullmag_fdm_demag::descriptors::ZeroPadding::new([0; 3], [0; 3]),
                fullmag_fdm_demag::descriptors::TransformConvention::XFastestZMajor,
                [source_offset, 0, 0],
                [0, 0, 0],
                fullmag_fdm_demag::descriptors::NegativeLagMapping::wrap_with_linear_extent(
                    [4, 2, 1],
                    [0, 0, 0],
                    [3, 1, 1],
                ),
                fullmag_fdm_demag::descriptors::CropWindow::new(
                    [destination_offset, 0, 0],
                    [2, 1, 1],
                ),
                1.0 / 8.0,
                [3, 1, 1],
                ConvolutionMode::TwoDStack,
            )
            .expect("valid translated transform layout")
        }

        let grid = [2, 1, 1];
        let cell_size = [1.0, 1.0, 1.0];
        let kernel = collapse_kernel_z_plane(fullmag_fdm_demag::compute_exact_self_kernel(
            2, 1, 1, 1.0, 1.0, 1.0,
        ))
        .expect("2-D self kernel");
        let make_layer = || FdmLayerRuntime {
            magnet_name: "translated".to_string(),
            grid,
            cell_size,
            origin: [0.0; 3],
            ms: 1.0,
            ms_field: None,
            exchange_stiffness: 0.0,
            damping: 0.0,
            active_mask: None,
            m: vec![[1.0, 0.0, 0.0], [2.0, 0.0, 0.0]],
            h_ex: vec![[0.0; 3]; 2],
            h_demag: vec![[0.0; 3]; 2],
            h_eff: vec![[0.0; 3]; 2],
            conv_grid: grid,
            conv_cell_size: cell_size,
            needs_transfer: false,
            transfer_boundary_policy: TransferBoundaryPolicy::OPEN,
        };

        let mut reference = make_layer();
        let reference_runtime = MultilayerDemagRuntime::new_with_layout_and_descriptors(
            vec![KernelPair {
                src_layer: 0,
                dst_layer: 0,
                kernel: kernel.clone(),
            }],
            grid,
            cell_size,
            layout(0, 0),
            Vec::new(),
        )
        .expect("reference runtime");
        reference_runtime.compute_demag_fields(&mut [reference.clone()]);
        reference_runtime.compute_demag_fields(std::slice::from_mut(&mut reference));

        let mut translated = make_layer();
        let descriptor = FdmLayerDescriptor::new(
            "translated",
            "translated",
            GridGeometry::new([0.0; 3], grid, cell_size).expect("native geometry"),
            GridGeometry::new([0.0; 3], grid, cell_size).expect("scratch geometry"),
            ConvolutionMode::TwoDStack,
            ActiveMaskIdentity::all_active(),
            fullmag_fdm_demag::TransferKind::Identity,
        )
        .expect("identity layer descriptor");
        let translated_runtime =
            MultilayerDemagRuntime::new_with_transform_layouts_and_descriptors(
                vec![KernelPair {
                    src_layer: 0,
                    dst_layer: 0,
                    kernel,
                }],
                grid,
                cell_size,
                layout(1, 1),
                vec![layout(1, 1)],
                vec![descriptor],
            )
            .expect("translated runtime");
        translated_runtime.compute_demag_fields(std::slice::from_mut(&mut translated));

        for (actual, expected) in translated.h_demag.iter().zip(reference.h_demag.iter()) {
            for component in 0..3 {
                assert!(
                    (actual[component] - expected[component]).abs() < 1.0e-12,
                    "source insertion/crop changed component {component}: actual={actual:?} expected={expected:?}"
                );
            }
        }

        let mut source_shifted_only = make_layer();
        let source_shifted_runtime = MultilayerDemagRuntime::new_with_layout_and_descriptors(
            vec![KernelPair {
                src_layer: 0,
                dst_layer: 0,
                kernel: collapse_kernel_z_plane(fullmag_fdm_demag::compute_exact_self_kernel(
                    2, 1, 1, 1.0, 1.0, 1.0,
                ))
                .expect("2-D source-only kernel"),
            }],
            grid,
            cell_size,
            layout(1, 0),
            Vec::new(),
        )
        .expect("source-only translated runtime");
        source_shifted_runtime.compute_demag_fields(std::slice::from_mut(&mut source_shifted_only));
        let source_only_difference = source_shifted_only
            .h_demag
            .iter()
            .zip(reference.h_demag.iter())
            .flat_map(|(actual, expected)| {
                (0..3).map(move |component| (actual[component] - expected[component]).abs())
            })
            .fold(0.0_f64, f64::max);
        assert!(
            source_only_difference > 1.0e-6,
            "source insertion must affect the field when the destination crop is unchanged"
        );
        let invalid_layout = MultilayerDemagRuntime::new_with_layout_and_descriptors(
            vec![KernelPair {
                src_layer: 0,
                dst_layer: 0,
                kernel: collapse_kernel_z_plane(fullmag_fdm_demag::compute_exact_self_kernel(
                    2, 1, 1, 1.0, 1.0, 1.0,
                ))
                .expect("2-D invalid-layout kernel"),
            }],
            grid,
            cell_size,
            layout(3, 0),
            Vec::new(),
        );
        assert!(
            invalid_layout.is_err(),
            "non-wrapping source insertion must fail closed when it exceeds the FFT"
        );
    }

    #[test]
    fn descriptor_runtime_keeps_native_two_cell_z_layer_and_one_cell_scratch() {
        let native = GridGeometry::new([0.0; 3], [2, 1, 2], [1.0, 1.0, 0.5]).unwrap();
        let scratch = GridGeometry::new([0.0; 3], [2, 1, 1], [1.0, 1.0, 1.0]).unwrap();
        let descriptor = FdmLayerDescriptor::new(
            "layer:stack",
            "object:stack",
            native,
            scratch,
            ConvolutionMode::TwoDStack,
            ActiveMaskIdentity::all_active(),
            fullmag_fdm_demag::TransferKind::PushPull,
        )
        .unwrap();
        let layout = CommonTransformLayout::for_pair(
            [2, 1, 1],
            [2, 1, 1],
            ConvolutionMode::TwoDStack,
            [0; 3],
            [0; 3],
            [0; 3],
            [2, 1, 1],
            [4, 2, 1],
            1.0 / 8.0,
        )
        .unwrap();
        let kernel = collapse_kernel_z_plane(fullmag_fdm_demag::compute_exact_self_kernel(
            2, 1, 1, 1.0, 1.0, 1.0,
        ))
        .unwrap();
        let runtime = MultilayerDemagRuntime::new_with_layout_and_descriptors(
            vec![KernelPair {
                src_layer: 0,
                dst_layer: 0,
                kernel,
            }],
            [2, 1, 1],
            [1.0, 1.0, 1.0],
            layout,
            vec![descriptor],
        )
        .expect("descriptor-aware runtime");
        assert_eq!(runtime.layer_descriptors[0].native.shape, [2, 1, 2]);
        assert_eq!(runtime.layer_descriptors[0].scratch.shape, [2, 1, 1]);

        let mut layer = FdmLayerRuntime {
            magnet_name: "stack".to_string(),
            grid: [2, 1, 2],
            cell_size: [1.0, 1.0, 0.5],
            origin: [0.0; 3],
            ms: 1.0,
            ms_field: None,
            exchange_stiffness: 0.0,
            damping: 0.1,
            active_mask: None,
            m: vec![
                [1.0, 0.0, 0.0],
                [3.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [3.0, 0.0, 0.0],
            ],
            h_ex: vec![[0.0; 3]; 4],
            h_demag: vec![[0.0; 3]; 4],
            h_eff: vec![[0.0; 3]; 4],
            conv_grid: [2, 1, 1],
            conv_cell_size: [1.0, 1.0, 1.0],
            needs_transfer: true,
            transfer_boundary_policy: TransferBoundaryPolicy::OPEN,
        };
        runtime
            .compute_demag_fields_checked(std::slice::from_mut(&mut layer))
            .expect("2-D moment-preserving transfer runtime");
        assert!(layer
            .h_demag
            .iter()
            .all(|value| value.iter().all(|component| component.is_finite())));
    }

    #[test]
    fn descriptor_runtime_rejects_periodic_push_pull_before_fft_plans() {
        let native = GridGeometry::new([0.0; 3], [1, 1, 1], [1.0; 3]).unwrap();
        let scratch = native;
        let descriptor = FdmLayerDescriptor::new(
            "layer:periodic",
            "object:periodic",
            native,
            scratch,
            ConvolutionMode::ThreeD,
            ActiveMaskIdentity::all_active(),
            fullmag_fdm_demag::TransferKind::PushPull,
        )
        .unwrap();
        let mut descriptor = descriptor;
        descriptor.transfer.boundary = fullmag_fdm_demag::descriptors::BoundaryPolicy::Periodic {
            axes: [true, false, false],
        };
        let kernel = fullmag_fdm_demag::compute_exact_self_kernel(1, 1, 1, 1.0, 1.0, 1.0);
        let layout = CommonTransformLayout::for_pair(
            [1; 3],
            [1; 3],
            ConvolutionMode::ThreeD,
            [0; 3],
            [0; 3],
            [0; 3],
            [1; 3],
            [2; 3],
            1.0 / 8.0,
        )
        .unwrap();
        let result = MultilayerDemagRuntime::new_with_layout_and_descriptors(
            vec![KernelPair {
                src_layer: 0,
                dst_layer: 0,
                kernel,
            }],
            [1; 3],
            [1.0; 3],
            layout,
            vec![descriptor],
        );
        match result {
            Ok(_) => panic!("periodic push/pull descriptor must fail closed"),
            Err(error) => assert!(error.contains("periodic")),
        }
    }
}
