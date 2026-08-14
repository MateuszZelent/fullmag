//! Backend-neutral descriptors for FDM multilayer convolution.
//!
//! The types in this module describe the data layout and the orientation of a
//! source/destination kernel pair.  They deliberately do not own field arrays
//! or a physical "common mesh": [`CommonTransformLayout`] is a computational
//! transform layout only.  Runtime lanes are expected to validate and consume
//! these descriptors rather than infer padding, crop, or transfer semantics
//! from array sizes.

use std::fmt;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub use crate::types::TransferKind;

/// Version tag for descriptors persisted in execution/provenance artifacts.
pub const DESCRIPTOR_SCHEMA_VERSION: &str = "fdm_multilayer_descriptor.v1";

/// A transform convention with x-fastest, z-major linear indexing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum TransformConvention {
    #[default]
    XFastestZMajor,
}

/// Physical convolution mode represented by a descriptor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvolutionMode {
    TwoDStack,
    ThreeD,
}

/// Tensor storage representation requested by a kernel catalog entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TensorRepresentation {
    FullComplex,
    ReducedReal,
}

/// Precision of the stored/generated kernel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KernelPrecision {
    F32,
    F64,
}

/// Boundary policy encoded in a kernel reuse key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum BoundaryPolicy {
    #[default]
    Open,
    Periodic {
        axes: [bool; 3],
    },
}

/// A pair of lower/upper padding counts per axis.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ZeroPadding {
    pub before: [usize; 3],
    pub after: [usize; 3],
}

impl ZeroPadding {
    pub const fn new(before: [usize; 3], after: [usize; 3]) -> Self {
        Self { before, after }
    }

    pub const fn total(self) -> [usize; 3] {
        [
            self.before[0] + self.after[0],
            self.before[1] + self.after[1],
            self.before[2] + self.after[2],
        ]
    }
}

/// A destination sub-window cropped from the padded inverse-transform array.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct CropWindow {
    pub offset: [usize; 3],
    pub shape: [usize; 3],
}

impl CropWindow {
    pub const fn new(offset: [usize; 3], shape: [usize; 3]) -> Self {
        Self { offset, shape }
    }

    fn fits_inside(self, outer: [usize; 3]) -> bool {
        (0..3).all(|axis| {
            self.offset[axis] <= outer[axis]
                && self.shape[axis] <= outer[axis].saturating_sub(self.offset[axis])
        })
    }
}

/// Explicit mapping from signed lag coordinates to padded transform indices.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct NegativeLagMapping {
    /// Number of transform samples available on each axis.
    pub axis_lengths: [usize; 3],
    /// Index containing lag zero on each axis.
    pub lag_zero: [usize; 3],
    /// Maximum absolute signed lag extent accepted by this mapping.
    pub linear_extent: [usize; 3],
}

impl NegativeLagMapping {
    /// Construct the standard tail-wrapping mapping used by linear FFT
    /// convolution: `index = (lag_zero + signed_lag) mod axis_length`.
    pub const fn wrap(axis_lengths: [usize; 3], lag_zero: [usize; 3]) -> Self {
        Self {
            axis_lengths,
            lag_zero,
            linear_extent: axis_lengths,
        }
    }

    /// Construct a mapping with a padded transform and an explicit logical
    /// linear-convolution extent. Lags outside that logical extent are
    /// rejected even when modular indexing would fit in the padded buffer.
    pub const fn wrap_with_linear_extent(
        axis_lengths: [usize; 3],
        lag_zero: [usize; 3],
        linear_extent: [usize; 3],
    ) -> Self {
        Self {
            axis_lengths,
            lag_zero,
            linear_extent,
        }
    }

    /// Convert a signed lag to a transform index, rejecting out-of-range
    /// coordinates rather than silently folding a malformed descriptor.
    pub fn index_for_lag(&self, lag: [isize; 3]) -> Option<[usize; 3]> {
        let mut index = [0; 3];
        for axis in 0..3 {
            let length = self.axis_lengths[axis];
            if length == 0
                || self.linear_extent[axis] == 0
                || self.lag_zero[axis] >= length
                || lag[axis].unsigned_abs() >= self.linear_extent[axis]
            {
                return None;
            }
            let raw = self.lag_zero[axis] as isize + lag[axis];
            index[axis] = raw.rem_euclid(length as isize) as usize;
        }
        Some(index)
    }
}

/// A cell-centered FDM grid geometry.  This is a physical grid descriptor,
/// unlike [`CommonTransformLayout`].
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct GridGeometry {
    pub origin: [f64; 3],
    pub shape: [usize; 3],
    pub spacing: [f64; 3],
}

impl GridGeometry {
    pub fn new(
        origin: [f64; 3],
        shape: [usize; 3],
        spacing: [f64; 3],
    ) -> Result<Self, DescriptorError> {
        let grid = Self {
            origin,
            shape,
            spacing,
        };
        grid.validate()?;
        Ok(grid)
    }

    pub fn validate(&self) -> Result<(), DescriptorError> {
        if self.shape.contains(&0) {
            return Err(DescriptorError::Invalid(
                "grid shape must contain only positive dimensions".to_string(),
            ));
        }
        if self
            .origin
            .iter()
            .chain(self.spacing.iter())
            .any(|value| !value.is_finite())
        {
            return Err(DescriptorError::Invalid(
                "grid origin and spacing must be finite".to_string(),
            ));
        }
        if self.spacing.iter().any(|&value| value <= 0.0) {
            return Err(DescriptorError::Invalid(
                "grid spacing must be strictly positive".to_string(),
            ));
        }
        Ok(())
    }

    pub const fn cell_count(&self) -> usize {
        self.shape[0] * self.shape[1] * self.shape[2]
    }

    pub fn volume(&self) -> f64 {
        self.spacing[0] * self.spacing[1] * self.spacing[2]
    }

    pub fn total_volume(&self) -> f64 {
        self.cell_count() as f64 * self.volume()
    }

    pub fn thickness(&self) -> f64 {
        self.shape[2] as f64 * self.spacing[2]
    }

    pub fn bounds(&self) -> ([f64; 3], [f64; 3]) {
        let upper = [
            self.origin[0] + self.shape[0] as f64 * self.spacing[0],
            self.origin[1] + self.shape[1] as f64 * self.spacing[1],
            self.origin[2] + self.shape[2] as f64 * self.spacing[2],
        ];
        (self.origin, upper)
    }

    /// Compatibility spelling for code that calls the physical spacing a
    /// cell-size tuple.
    pub const fn cell_size(&self) -> [f64; 3] {
        self.spacing
    }

    pub fn fingerprint(&self) -> String {
        sha256_fingerprint(self)
    }
}

/// Identity of an active-cell mask.  The descriptor stores identity only; it
/// never synthesizes a mask from a shape or from an all-true assumption.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActiveMaskIdentity {
    pub present: bool,
    pub fingerprint: Option<String>,
    pub active_cells: Option<usize>,
}

impl ActiveMaskIdentity {
    pub const fn all_active() -> Self {
        Self {
            present: false,
            fingerprint: None,
            active_cells: None,
        }
    }

    pub fn from_fingerprint(
        fingerprint: impl Into<String>,
        active_cells: usize,
    ) -> Result<Self, DescriptorError> {
        let value = Self {
            present: true,
            fingerprint: Some(fingerprint.into()),
            active_cells: Some(active_cells),
        };
        value.validate(None)?;
        Ok(value)
    }

    /// Compute a stable identity from the concrete mask values supplied by a
    /// runtime. The descriptor stores only the digest and active-cell count;
    /// it never synthesizes or embeds the mask itself.
    pub fn from_mask(mask: &[bool]) -> Self {
        let active_cells = mask.iter().filter(|active| **active).count();
        let mut digest = Sha256::new();
        digest.update(b"[");
        for (index, active) in mask.iter().enumerate() {
            if index != 0 {
                digest.update(b",");
            }
            digest.update(if *active { &b"true"[..] } else { &b"false"[..] });
        }
        digest.update(b"]");
        let fingerprint = format!("sha256:{:x}", digest.finalize());
        Self {
            present: true,
            fingerprint: Some(fingerprint),
            active_cells: Some(active_cells),
        }
    }

    pub fn validate(&self, cell_count: Option<usize>) -> Result<(), DescriptorError> {
        if self.present {
            let Some(fingerprint) = self.fingerprint.as_deref() else {
                return Err(DescriptorError::Invalid(
                    "active mask is present but has no fingerprint".to_string(),
                ));
            };
            if fingerprint.trim().is_empty() {
                return Err(DescriptorError::Invalid(
                    "active mask fingerprint must not be empty".to_string(),
                ));
            }
            let Some(active_cells) = self.active_cells else {
                return Err(DescriptorError::Invalid(
                    "active mask is present but has no active-cell count".to_string(),
                ));
            };
            if let Some(cell_count) = cell_count {
                if active_cells > cell_count {
                    return Err(DescriptorError::Invalid(format!(
                        "active mask count {active_cells} exceeds grid cell count {cell_count}"
                    )));
                }
            }
        } else if self.fingerprint.is_some() || self.active_cells.is_some() {
            return Err(DescriptorError::Invalid(
                "an absent active mask cannot carry fingerprint or active-cell count".to_string(),
            ));
        }
        Ok(())
    }
}

/// Contract metadata for native↔scratch transfer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TransferContractMetadata {
    pub adjoint_required: bool,
    pub inner_product: String,
    pub preserves_volume_weighted_moment: bool,
    pub moment_policy: String,
    pub active_cell_policy: String,
}

impl TransferContractMetadata {
    pub fn identity() -> Self {
        Self {
            adjoint_required: false,
            inner_product: "volume_weighted".to_string(),
            preserves_volume_weighted_moment: true,
            moment_policy: "identity".to_string(),
            active_cell_policy: "preserve_active_mask".to_string(),
        }
    }

    pub fn volume_weighted_moment_preserving() -> Self {
        Self {
            adjoint_required: true,
            inner_product: "volume_weighted".to_string(),
            preserves_volume_weighted_moment: true,
            moment_policy: "full_scratch_volume_moment_density".to_string(),
            active_cell_policy: "preserve_active_mask".to_string(),
        }
    }
}

/// A transfer reference retained in a pair descriptor.  It identifies the
/// source layer and the exact transfer contract without embedding mask data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TransferReference {
    pub layer_id: String,
    pub kind: TransferKind,
    /// Native-grid identity used by the source/destination transfer.
    pub native_grid_fingerprint: String,
    /// Scratch/convolution-grid identity used by the transfer.
    pub scratch_grid_fingerprint: String,
    /// Compatibility alias for the scratch-grid identity.
    pub grid_fingerprint: String,
    pub active_mask_fingerprint: Option<String>,
    pub boundary: BoundaryPolicy,
    pub contract: TransferContractMetadata,
}

impl TransferReference {
    pub fn new(
        layer_id: impl Into<String>,
        kind: TransferKind,
        grid_fingerprint: impl Into<String>,
        contract: TransferContractMetadata,
    ) -> Result<Self, DescriptorError> {
        let value = Self {
            layer_id: layer_id.into(),
            kind,
            native_grid_fingerprint: grid_fingerprint.into(),
            scratch_grid_fingerprint: String::new(),
            grid_fingerprint: String::new(),
            active_mask_fingerprint: None,
            boundary: BoundaryPolicy::Open,
            contract,
        };
        let mut value = value;
        value.scratch_grid_fingerprint = value.native_grid_fingerprint.clone();
        value.grid_fingerprint = value.scratch_grid_fingerprint.clone();
        value.validate()?;
        Ok(value)
    }

    pub fn validate(&self) -> Result<(), DescriptorError> {
        if self.layer_id.trim().is_empty() {
            return Err(DescriptorError::Invalid(
                "transfer reference layer_id must not be empty".to_string(),
            ));
        }
        if self.native_grid_fingerprint.trim().is_empty()
            || self.scratch_grid_fingerprint.trim().is_empty()
            || self.grid_fingerprint.trim().is_empty()
        {
            return Err(DescriptorError::Invalid(
                "transfer reference grid fingerprints must not be empty".to_string(),
            ));
        }
        if self.grid_fingerprint != self.scratch_grid_fingerprint {
            return Err(DescriptorError::Invalid(
                "transfer reference grid fingerprint alias disagrees with scratch grid".to_string(),
            ));
        }
        if self.boundary != BoundaryPolicy::Open {
            return Err(DescriptorError::Invalid(
                "periodic transfer boundaries are not supported by descriptor schema v1"
                    .to_string(),
            ));
        }
        if self.contract.inner_product != "volume_weighted" {
            return Err(DescriptorError::Invalid(
                "transfer contract inner product must be volume_weighted".to_string(),
            ));
        }
        let expected_contract = if self.kind == TransferKind::Identity {
            TransferContractMetadata::identity()
        } else {
            TransferContractMetadata::volume_weighted_moment_preserving()
        };
        if self.contract != expected_contract {
            return Err(DescriptorError::Invalid(format!(
                "transfer contract does not match {:?} transfer kind",
                self.kind
            )));
        }
        if self.kind == TransferKind::Identity
            && self.native_grid_fingerprint != self.scratch_grid_fingerprint
        {
            return Err(DescriptorError::Invalid(
                "identity transfer requires identical native and scratch grids".to_string(),
            ));
        }
        Ok(())
    }
}

/// Transfer metadata stored on a layer descriptor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LayerTransferDescriptor {
    pub kind: TransferKind,
    pub boundary: BoundaryPolicy,
    pub contract: TransferContractMetadata,
}

impl LayerTransferDescriptor {
    pub fn validate(
        &self,
        native: &GridGeometry,
        scratch: &GridGeometry,
    ) -> Result<(), DescriptorError> {
        if self.boundary != BoundaryPolicy::Open {
            return Err(DescriptorError::Invalid(
                "periodic transfer boundaries are not supported by descriptor schema v1"
                    .to_string(),
            ));
        }
        let expected_contract = if self.kind == TransferKind::Identity {
            TransferContractMetadata::identity()
        } else {
            TransferContractMetadata::volume_weighted_moment_preserving()
        };
        if self.contract != expected_contract {
            return Err(DescriptorError::Invalid(format!(
                "transfer contract does not match {:?} transfer kind",
                self.kind
            )));
        }
        if self.kind == TransferKind::Identity && native != scratch {
            return Err(DescriptorError::Invalid(
                "identity transfer requires native and scratch geometry equality".to_string(),
            ));
        }
        Ok(())
    }
}

/// Inputs that must participate in the stable layer fingerprint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LayerFingerprintInputs {
    pub native_grid_fingerprint: String,
    pub scratch_grid_fingerprint: String,
    pub active_mask_fingerprint: Option<String>,
    pub transfer_kind: TransferKind,
    pub mode: ConvolutionMode,
}

/// Native and scratch grid descriptor for one magnetic object/layer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FdmLayerDescriptor {
    pub schema_version: String,
    pub layer_id: String,
    pub object_id: String,
    pub native: GridGeometry,
    pub scratch: GridGeometry,
    pub mode: ConvolutionMode,
    pub active_mask: ActiveMaskIdentity,
    pub transfer: LayerTransferDescriptor,
    pub fingerprint_inputs: LayerFingerprintInputs,
}

impl FdmLayerDescriptor {
    pub fn new(
        layer_id: impl Into<String>,
        object_id: impl Into<String>,
        native: GridGeometry,
        scratch: GridGeometry,
        mode: ConvolutionMode,
        active_mask: ActiveMaskIdentity,
        transfer_kind: TransferKind,
    ) -> Result<Self, DescriptorError> {
        let layer_id = layer_id.into();
        let object_id = object_id.into();
        let fingerprint_inputs = LayerFingerprintInputs {
            native_grid_fingerprint: native.fingerprint(),
            scratch_grid_fingerprint: scratch.fingerprint(),
            active_mask_fingerprint: active_mask.fingerprint.clone(),
            transfer_kind,
            mode,
        };
        let descriptor = Self {
            schema_version: DESCRIPTOR_SCHEMA_VERSION.to_string(),
            layer_id,
            object_id,
            native,
            scratch,
            mode,
            active_mask,
            transfer: LayerTransferDescriptor {
                kind: transfer_kind,
                boundary: BoundaryPolicy::Open,
                contract: if transfer_kind == TransferKind::Identity {
                    TransferContractMetadata::identity()
                } else {
                    TransferContractMetadata::volume_weighted_moment_preserving()
                },
            },
            fingerprint_inputs,
        };
        descriptor.validate()?;
        Ok(descriptor)
    }

    pub fn validate(&self) -> Result<(), DescriptorError> {
        if self.schema_version != DESCRIPTOR_SCHEMA_VERSION {
            return Err(DescriptorError::Invalid(format!(
                "unsupported layer descriptor schema version '{}'",
                self.schema_version
            )));
        }
        if self.layer_id.trim().is_empty() || self.object_id.trim().is_empty() {
            return Err(DescriptorError::Invalid(
                "layer_id and object_id must not be empty".to_string(),
            ));
        }
        self.native.validate()?;
        self.scratch.validate()?;
        self.active_mask.validate(Some(self.native.cell_count()))?;
        self.transfer.validate(&self.native, &self.scratch)?;
        if self.mode == ConvolutionMode::TwoDStack && self.scratch.shape[2] != 1 {
            return Err(DescriptorError::Invalid(
                "two_d_stack scratch grid must have exactly one z cell".to_string(),
            ));
        }
        if self.fingerprint_inputs.transfer_kind != self.transfer.kind {
            return Err(DescriptorError::Invalid(
                "fingerprint transfer kind disagrees with layer transfer".to_string(),
            ));
        }
        if self.fingerprint_inputs.mode != self.mode {
            return Err(DescriptorError::Invalid(
                "fingerprint mode disagrees with layer mode".to_string(),
            ));
        }
        if self.fingerprint_inputs.native_grid_fingerprint != self.native.fingerprint() {
            return Err(DescriptorError::Invalid(
                "fingerprint native grid input disagrees with native grid".to_string(),
            ));
        }
        if self.fingerprint_inputs.scratch_grid_fingerprint != self.scratch.fingerprint() {
            return Err(DescriptorError::Invalid(
                "fingerprint scratch grid input disagrees with scratch grid".to_string(),
            ));
        }
        if self.fingerprint_inputs.active_mask_fingerprint != self.active_mask.fingerprint {
            return Err(DescriptorError::Invalid(
                "fingerprint active-mask input disagrees with active-mask identity".to_string(),
            ));
        }
        Ok(())
    }

    pub fn fingerprint(&self) -> String {
        sha256_fingerprint(self)
    }

    pub fn transfer_reference(&self) -> TransferReference {
        TransferReference {
            layer_id: self.layer_id.clone(),
            kind: self.transfer.kind,
            native_grid_fingerprint: self.native.fingerprint(),
            scratch_grid_fingerprint: self.scratch.fingerprint(),
            grid_fingerprint: self.scratch.fingerprint(),
            active_mask_fingerprint: self.active_mask.fingerprint.clone(),
            boundary: self.transfer.boundary,
            contract: self.transfer.contract.clone(),
        }
    }
}

/// Common transform layout.  `physical_mesh` is intentionally hard-coded to
/// false in constructors and validation; a common FFT layout has no physical
/// origin or spacing and must not be shown as a mesh in the UI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommonTransformLayout {
    pub schema_version: String,
    pub shape: [usize; 3],
    pub strides: [usize; 3],
    pub fft_shape: [usize; 3],
    pub zero_padding: ZeroPadding,
    pub convention: TransformConvention,
    pub source_insert_offset: [usize; 3],
    pub lag_zero: [usize; 3],
    pub negative_lag_mapping: NegativeLagMapping,
    pub destination_crop: CropWindow,
    pub inverse_normalization: f64,
    pub linear_extent: [usize; 3],
    pub mode: ConvolutionMode,
    /// Always false.  Kept as an explicit wire field so consumers cannot
    /// mistake this layout for a physical native/scratch grid.
    pub physical_mesh: bool,
}

impl CommonTransformLayout {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        shape: [usize; 3],
        fft_shape: [usize; 3],
        strides: [usize; 3],
        zero_padding: ZeroPadding,
        convention: TransformConvention,
        source_insert_offset: [usize; 3],
        lag_zero: [usize; 3],
        negative_lag_mapping: NegativeLagMapping,
        destination_crop: CropWindow,
        inverse_normalization: f64,
        linear_extent: [usize; 3],
        mode: ConvolutionMode,
    ) -> Result<Self, DescriptorError> {
        let value = Self {
            schema_version: DESCRIPTOR_SCHEMA_VERSION.to_string(),
            shape,
            strides,
            fft_shape,
            zero_padding,
            convention,
            source_insert_offset,
            lag_zero,
            negative_lag_mapping,
            destination_crop,
            inverse_normalization,
            linear_extent,
            mode,
            physical_mesh: false,
        };
        value.validate()?;
        Ok(value)
    }

    /// Build a standard x-fastest layout for one oriented source/destination
    /// pair.  `fft_shape` is explicit: callers choose a supported FFT length,
    /// but the descriptor still verifies the exact linear extent.
    #[allow(clippy::too_many_arguments)]
    pub fn for_pair(
        source_shape: [usize; 3],
        destination_shape: [usize; 3],
        mode: ConvolutionMode,
        source_insert_offset: [usize; 3],
        lag_zero: [usize; 3],
        destination_crop_offset: [usize; 3],
        destination_crop_shape: [usize; 3],
        fft_shape: [usize; 3],
        inverse_normalization: f64,
    ) -> Result<Self, DescriptorError> {
        let linear_extent = [
            source_shape[0]
                .checked_add(destination_shape[0])
                .and_then(|value| value.checked_sub(1))
                .ok_or_else(|| DescriptorError::Invalid("x linear extent overflow".to_string()))?,
            source_shape[1]
                .checked_add(destination_shape[1])
                .and_then(|value| value.checked_sub(1))
                .ok_or_else(|| DescriptorError::Invalid("y linear extent overflow".to_string()))?,
            if mode == ConvolutionMode::TwoDStack {
                1
            } else {
                source_shape[2]
                    .checked_add(destination_shape[2])
                    .and_then(|value| value.checked_sub(1))
                    .ok_or_else(|| {
                        DescriptorError::Invalid("z linear extent overflow".to_string())
                    })?
            },
        ];
        let strides = [1, fft_shape[0], fft_shape[0] * fft_shape[1]];
        Self::new(
            linear_extent,
            fft_shape,
            strides,
            ZeroPadding::new(
                [0; 3],
                [
                    fft_shape[0].saturating_sub(linear_extent[0]),
                    fft_shape[1].saturating_sub(linear_extent[1]),
                    fft_shape[2].saturating_sub(linear_extent[2]),
                ],
            ),
            TransformConvention::XFastestZMajor,
            source_insert_offset,
            lag_zero,
            NegativeLagMapping::wrap_with_linear_extent(fft_shape, lag_zero, linear_extent),
            CropWindow::new(destination_crop_offset, destination_crop_shape),
            inverse_normalization,
            linear_extent,
            mode,
        )
    }

    pub fn validate(&self) -> Result<(), DescriptorError> {
        if self.schema_version != DESCRIPTOR_SCHEMA_VERSION {
            return Err(DescriptorError::Invalid(format!(
                "unsupported transform layout schema version '{}'",
                self.schema_version
            )));
        }
        if self.physical_mesh {
            return Err(DescriptorError::Invalid(
                "common transform layout must not be marked as a physical mesh".to_string(),
            ));
        }
        if self.shape.contains(&0) || self.fft_shape.contains(&0) || self.linear_extent.contains(&0)
        {
            return Err(DescriptorError::Invalid(
                "transform shape, fft shape, and linear extent must be positive".to_string(),
            ));
        }
        if self
            .linear_extent
            .iter()
            .zip(self.fft_shape.iter())
            .any(|(extent, fft)| extent > fft)
        {
            return Err(DescriptorError::Invalid(
                "fft shape must contain the complete linear convolution extent".to_string(),
            ));
        }
        if (0..3).any(|axis| {
            self.shape[axis]
                .checked_add(self.zero_padding.before[axis])
                .and_then(|value| value.checked_add(self.zero_padding.after[axis]))
                != Some(self.fft_shape[axis])
        }) {
            return Err(DescriptorError::Invalid(
                "zero-padding before/after must account for the complete fft shape".to_string(),
            ));
        }
        let expected_strides = [1, self.fft_shape[0], self.fft_shape[0] * self.fft_shape[1]];
        if self.strides != expected_strides {
            return Err(DescriptorError::Invalid(
                "transform strides must use x-fastest z-major indexing".to_string(),
            ));
        }
        if self
            .source_insert_offset
            .iter()
            .enumerate()
            .any(|(axis, offset)| *offset >= self.fft_shape[axis])
        {
            return Err(DescriptorError::Invalid(
                "source insertion offset is outside the transform".to_string(),
            ));
        }
        if self
            .lag_zero
            .iter()
            .enumerate()
            .any(|(axis, offset)| *offset >= self.fft_shape[axis])
        {
            return Err(DescriptorError::Invalid(
                "lag-zero index is outside the transform".to_string(),
            ));
        }
        if self.negative_lag_mapping.axis_lengths != self.fft_shape
            || self.negative_lag_mapping.lag_zero != self.lag_zero
            || self.negative_lag_mapping.linear_extent != self.linear_extent
        {
            return Err(DescriptorError::Invalid(
                "negative-lag mapping must describe this transform's fft shape and lag zero"
                    .to_string(),
            ));
        }
        if !self.destination_crop.fits_inside(self.shape) {
            return Err(DescriptorError::Invalid(
                "destination crop must fit inside the transform shape".to_string(),
            ));
        }
        if self.inverse_normalization <= 0.0 || !self.inverse_normalization.is_finite() {
            return Err(DescriptorError::Invalid(
                "inverse normalization must be finite and strictly positive".to_string(),
            ));
        }
        if self.mode == ConvolutionMode::TwoDStack
            && (self.shape[2] != 1 || self.fft_shape[2] != 1 || self.linear_extent[2] != 1)
        {
            return Err(DescriptorError::Invalid(
                "two_d_stack transform layout must have exactly one z sample".to_string(),
            ));
        }
        Ok(())
    }

    pub const fn is_physical_mesh(&self) -> bool {
        self.physical_mesh
    }

    pub fn fingerprint(&self) -> String {
        sha256_fingerprint(self)
    }
}

/// Pair descriptor orientation is always destination <- source.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OrientedKernelPairDescriptor {
    pub schema_version: String,
    pub destination_layer_id: String,
    pub source_layer_id: String,
    pub relative_shift: [f64; 3],
    /// Physical native geometries retained for energy/mask/provenance and
    /// parity legality checks.
    pub source_native: GridGeometry,
    pub destination_native: GridGeometry,
    /// Scratch/convolution geometries used to build this oriented kernel.
    pub source_scratch: GridGeometry,
    pub destination_scratch: GridGeometry,
    /// source_shape/destination_shape are scratch shapes for the kernel
    /// extent; native shapes remain available above.
    pub source_shape: [usize; 3],
    pub destination_shape: [usize; 3],
    pub source_native_shape: [usize; 3],
    pub destination_native_shape: [usize; 3],
    pub linear_extent: [usize; 3],
    /// Per-cell scratch volumes used by the convolution operator.
    pub source_volume: f64,
    pub destination_volume: f64,
    pub source_native_volume: f64,
    pub destination_native_volume: f64,
    pub source_cell_size: [f64; 3],
    pub destination_cell_size: [f64; 3],
    pub source_native_grid_fingerprint: String,
    pub destination_native_grid_fingerprint: String,
    pub source_active_mask_fingerprint: Option<String>,
    pub destination_active_mask_fingerprint: Option<String>,
    pub source_layer_fingerprint: String,
    pub destination_layer_fingerprint: String,
    pub source_thickness: f64,
    pub destination_thickness: f64,
    pub source_layer_volume: f64,
    pub destination_layer_volume: f64,
    pub source_transfer: TransferReference,
    pub destination_transfer: TransferReference,
    pub mode: ConvolutionMode,
    pub representation: TensorRepresentation,
}

impl OrientedKernelPairDescriptor {
    pub fn new(
        destination: &FdmLayerDescriptor,
        source: &FdmLayerDescriptor,
        relative_shift: [f64; 3],
        representation: TensorRepresentation,
    ) -> Result<Self, DescriptorError> {
        if destination.mode != source.mode {
            return Err(DescriptorError::Invalid(
                "mixed two_d_stack/three_d layer modes are not supported by one pair".to_string(),
            ));
        }
        let linear_extent = [
            source.scratch.shape[0]
                .checked_add(destination.scratch.shape[0])
                .and_then(|value| value.checked_sub(1))
                .ok_or_else(|| DescriptorError::Invalid("x linear extent overflow".to_string()))?,
            source.scratch.shape[1]
                .checked_add(destination.scratch.shape[1])
                .and_then(|value| value.checked_sub(1))
                .ok_or_else(|| DescriptorError::Invalid("y linear extent overflow".to_string()))?,
            if destination.mode == ConvolutionMode::TwoDStack
                && source.mode == ConvolutionMode::TwoDStack
            {
                1
            } else {
                source.scratch.shape[2]
                    .checked_add(destination.scratch.shape[2])
                    .and_then(|value| value.checked_sub(1))
                    .ok_or_else(|| {
                        DescriptorError::Invalid("z linear extent overflow".to_string())
                    })?
            },
        ];
        let value = Self {
            schema_version: DESCRIPTOR_SCHEMA_VERSION.to_string(),
            destination_layer_id: destination.layer_id.clone(),
            source_layer_id: source.layer_id.clone(),
            relative_shift,
            source_native: source.native,
            destination_native: destination.native,
            source_scratch: source.scratch,
            destination_scratch: destination.scratch,
            source_shape: source.scratch.shape,
            destination_shape: destination.scratch.shape,
            source_native_shape: source.native.shape,
            destination_native_shape: destination.native.shape,
            linear_extent,
            source_volume: source.scratch.volume(),
            destination_volume: destination.scratch.volume(),
            source_native_volume: source.native.volume(),
            destination_native_volume: destination.native.volume(),
            source_cell_size: source.scratch.spacing,
            destination_cell_size: destination.scratch.spacing,
            source_native_grid_fingerprint: source.native.fingerprint(),
            destination_native_grid_fingerprint: destination.native.fingerprint(),
            source_active_mask_fingerprint: source.active_mask.fingerprint.clone(),
            destination_active_mask_fingerprint: destination.active_mask.fingerprint.clone(),
            source_layer_fingerprint: source.fingerprint(),
            destination_layer_fingerprint: destination.fingerprint(),
            source_thickness: source.native.thickness(),
            destination_thickness: destination.native.thickness(),
            source_layer_volume: source.native.total_volume(),
            destination_layer_volume: destination.native.total_volume(),
            source_transfer: source.transfer_reference(),
            destination_transfer: destination.transfer_reference(),
            mode: if destination.mode == ConvolutionMode::TwoDStack
                && source.mode == ConvolutionMode::TwoDStack
            {
                ConvolutionMode::TwoDStack
            } else {
                ConvolutionMode::ThreeD
            },
            representation,
        };
        value.validate()?;
        Ok(value)
    }

    pub fn validate(&self) -> Result<(), DescriptorError> {
        if self.schema_version != DESCRIPTOR_SCHEMA_VERSION {
            return Err(DescriptorError::Invalid(format!(
                "unsupported oriented pair schema version '{}'",
                self.schema_version
            )));
        }
        if self.destination_layer_id.trim().is_empty() || self.source_layer_id.trim().is_empty() {
            return Err(DescriptorError::Invalid(
                "oriented pair layer ids must not be empty".to_string(),
            ));
        }
        if self.destination_layer_id == self.source_layer_id {
            return Err(DescriptorError::Invalid(
                "oriented pair requires distinct source and destination layer ids".to_string(),
            ));
        }
        if self.relative_shift.iter().any(|value| !value.is_finite()) {
            return Err(DescriptorError::Invalid(
                "relative shift must be finite".to_string(),
            ));
        }
        let expected = [
            self.source_shape[0]
                .checked_add(self.destination_shape[0])
                .and_then(|value| value.checked_sub(1)),
            self.source_shape[1]
                .checked_add(self.destination_shape[1])
                .and_then(|value| value.checked_sub(1)),
            if self.mode == ConvolutionMode::TwoDStack {
                Some(1)
            } else {
                self.source_shape[2]
                    .checked_add(self.destination_shape[2])
                    .and_then(|value| value.checked_sub(1))
            },
        ];
        if expected
            != [
                Some(self.linear_extent[0]),
                Some(self.linear_extent[1]),
                Some(self.linear_extent[2]),
            ]
        {
            return Err(DescriptorError::Invalid(
                "linear extent must equal n_source + n_destination - 1".to_string(),
            ));
        }
        if self.source_volume <= 0.0
            || self.destination_volume <= 0.0
            || !self.source_volume.is_finite()
            || !self.destination_volume.is_finite()
        {
            return Err(DescriptorError::Invalid(
                "source and destination volumes must be finite and positive".to_string(),
            ));
        }
        if self.source_transfer.layer_id != self.source_layer_id
            || self.destination_transfer.layer_id != self.destination_layer_id
        {
            return Err(DescriptorError::Invalid(
                "transfer references must preserve pair orientation".to_string(),
            ));
        }
        self.source_native.validate()?;
        self.destination_native.validate()?;
        self.source_scratch.validate()?;
        self.destination_scratch.validate()?;
        self.source_transfer.validate()?;
        self.destination_transfer.validate()?;
        if self.source_shape != self.source_scratch.shape
            || self.destination_shape != self.destination_scratch.shape
            || self.source_native_shape != self.source_native.shape
            || self.destination_native_shape != self.destination_native.shape
        {
            return Err(DescriptorError::Invalid(
                "pair geometry fields disagree with native/scratch descriptors".to_string(),
            ));
        }
        if self.source_cell_size != self.source_scratch.spacing
            || self.destination_cell_size != self.destination_scratch.spacing
            || self.source_volume != self.source_scratch.volume()
            || self.destination_volume != self.destination_scratch.volume()
        {
            return Err(DescriptorError::Invalid(
                "pair scratch cell geometry fields disagree with scratch descriptors".to_string(),
            ));
        }
        if self.source_native_volume != self.source_native.volume()
            || self.destination_native_volume != self.destination_native.volume()
            || self.source_thickness != self.source_native.thickness()
            || self.destination_thickness != self.destination_native.thickness()
            || self.source_layer_volume != self.source_native.total_volume()
            || self.destination_layer_volume != self.destination_native.total_volume()
        {
            return Err(DescriptorError::Invalid(
                "pair native geometry fields disagree with native descriptors".to_string(),
            ));
        }
        if self.source_native_grid_fingerprint != self.source_native.fingerprint()
            || self.destination_native_grid_fingerprint != self.destination_native.fingerprint()
            || self.source_active_mask_fingerprint != self.source_transfer.active_mask_fingerprint
            || self.destination_active_mask_fingerprint
                != self.destination_transfer.active_mask_fingerprint
        {
            return Err(DescriptorError::Invalid(
                "pair native/mask fingerprint inputs are inconsistent".to_string(),
            ));
        }
        if self.source_layer_fingerprint.trim().is_empty()
            || self.destination_layer_fingerprint.trim().is_empty()
        {
            return Err(DescriptorError::Invalid(
                "pair layer fingerprints must not be empty".to_string(),
            ));
        }
        Ok(())
    }

    pub fn fingerprint(&self) -> String {
        sha256_fingerprint(self)
    }
}

/// A canonical, deterministic key for kernel reuse.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct KernelReuseKey {
    pub schema_version: String,
    pub mode: ConvolutionMode,
    /// Signed relative shift in picometres.  Keeping all three axes makes an
    /// XY offset impossible to accidentally collapse into a Z-parity key.
    pub oriented_shift: [i64; 3],
    /// Source/destination oriented cell sizes in picometres.
    pub h_source: [i64; 3],
    pub h_destination: [i64; 3],
    /// Physical native layer thickness and total volume in picometres and
    /// cubic-picometres. These prevent parity reuse across different Nz.
    pub source_thickness_pm: i64,
    pub destination_thickness_pm: i64,
    pub source_layer_volume_pm3: i64,
    pub destination_layer_volume_pm3: i64,
    pub transform: TransformKey,
    pub representation: TensorRepresentation,
    pub precision: KernelPrecision,
    pub boundary: BoundaryPolicy,
}

/// Hashable subset of [`CommonTransformLayout`] needed for a kernel key.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TransformKey {
    pub shape: [usize; 3],
    pub linear_extent: [usize; 3],
    pub fft_shape: [usize; 3],
    pub zero_padding: ZeroPadding,
    pub convention: TransformConvention,
    pub source_insert_offset: [usize; 3],
    pub lag_zero: [usize; 3],
    pub destination_crop: CropWindow,
    pub inverse_normalization_quantized: i64,
}

impl TransformKey {
    pub fn from_layout(layout: &CommonTransformLayout) -> Self {
        Self {
            shape: layout.shape,
            linear_extent: layout.linear_extent,
            fft_shape: layout.fft_shape,
            zero_padding: layout.zero_padding,
            convention: layout.convention,
            source_insert_offset: layout.source_insert_offset,
            lag_zero: layout.lag_zero,
            destination_crop: layout.destination_crop,
            inverse_normalization_quantized: quantize(layout.inverse_normalization),
        }
    }

    pub fn validate(&self) -> Result<(), DescriptorError> {
        if self.shape.contains(&0)
            || self.linear_extent.contains(&0)
            || self.fft_shape.contains(&0)
            || self
                .linear_extent
                .iter()
                .zip(self.fft_shape.iter())
                .any(|(extent, fft)| extent > fft)
        {
            return Err(DescriptorError::Invalid(
                "kernel transform key has an invalid linear/FFT extent".to_string(),
            ));
        }
        Ok(())
    }
}

impl KernelReuseKey {
    /// Build a canonical runtime key directly from two layer descriptors.
    /// Unlike [`OrientedKernelPairDescriptor`], this constructor also accepts
    /// self-pairs, which are required by an ordered `L x L` runtime catalog.
    pub fn from_layers_with_layout(
        destination: &FdmLayerDescriptor,
        source: &FdmLayerDescriptor,
        relative_shift: [f64; 3],
        representation: TensorRepresentation,
        layout: &CommonTransformLayout,
        precision: KernelPrecision,
        boundary: BoundaryPolicy,
    ) -> Result<Self, DescriptorError> {
        destination.validate()?;
        source.validate()?;
        layout.validate()?;
        if destination.mode != source.mode || layout.mode != destination.mode {
            return Err(DescriptorError::Invalid(
                "kernel key layer and transform modes must agree".to_string(),
            ));
        }
        if relative_shift.iter().any(|value| !value.is_finite()) {
            return Err(DescriptorError::Invalid(
                "kernel key relative shift must be finite".to_string(),
            ));
        }
        let source_cell_size = if source.mode == ConvolutionMode::TwoDStack {
            [
                source.scratch.spacing[0],
                source.scratch.spacing[1],
                source.native.thickness(),
            ]
        } else {
            source.scratch.spacing
        };
        let destination_cell_size = if destination.mode == ConvolutionMode::TwoDStack {
            [
                destination.scratch.spacing[0],
                destination.scratch.spacing[1],
                destination.native.thickness(),
            ]
        } else {
            destination.scratch.spacing
        };
        let value = Self {
            schema_version: DESCRIPTOR_SCHEMA_VERSION.to_string(),
            mode: destination.mode,
            oriented_shift: quantize3(relative_shift),
            h_source: quantize3(source_cell_size),
            h_destination: quantize3(destination_cell_size),
            source_thickness_pm: quantize(source.native.thickness()),
            destination_thickness_pm: quantize(destination.native.thickness()),
            source_layer_volume_pm3: quantize_volume(source.native.total_volume()),
            destination_layer_volume_pm3: quantize_volume(destination.native.total_volume()),
            transform: TransformKey::from_layout(layout),
            representation,
            precision,
            boundary,
        };
        value.validate()?;
        Ok(value)
    }

    pub fn from_pair(
        pair: &OrientedKernelPairDescriptor,
        precision: KernelPrecision,
        boundary: BoundaryPolicy,
    ) -> Self {
        let transform = TransformKey {
            shape: pair.linear_extent,
            linear_extent: pair.linear_extent,
            fft_shape: pair.linear_extent,
            zero_padding: ZeroPadding::new([0; 3], [0; 3]),
            convention: TransformConvention::XFastestZMajor,
            source_insert_offset: [0; 3],
            lag_zero: [0; 3],
            destination_crop: CropWindow::new([0; 3], pair.destination_shape),
            inverse_normalization_quantized: quantize(1.0),
        };
        Self::from_pair_with_transform(pair, transform, precision, boundary)
    }

    /// Build a key using the exact transform/crop descriptor selected by the
    /// planner. This is the preferred constructor for runtime catalogues.
    pub fn from_pair_with_layout(
        pair: &OrientedKernelPairDescriptor,
        layout: &CommonTransformLayout,
        precision: KernelPrecision,
        boundary: BoundaryPolicy,
    ) -> Result<Self, DescriptorError> {
        layout.validate()?;
        if layout.mode != pair.mode || layout.linear_extent != pair.linear_extent {
            return Err(DescriptorError::Invalid(
                "transform layout mode/linear extent disagrees with oriented pair".to_string(),
            ));
        }
        if layout.destination_crop.shape != pair.destination_shape {
            return Err(DescriptorError::Invalid(
                "transform destination crop disagrees with oriented pair destination shape"
                    .to_string(),
            ));
        }
        Ok(Self::from_pair_with_transform(
            pair,
            TransformKey::from_layout(layout),
            precision,
            boundary,
        ))
    }

    fn from_pair_with_transform(
        pair: &OrientedKernelPairDescriptor,
        transform: TransformKey,
        precision: KernelPrecision,
        boundary: BoundaryPolicy,
    ) -> Self {
        Self {
            schema_version: DESCRIPTOR_SCHEMA_VERSION.to_string(),
            mode: pair.mode,
            oriented_shift: quantize3(pair.relative_shift),
            h_source: quantize3(pair.source_cell_size),
            h_destination: quantize3(pair.destination_cell_size),
            source_thickness_pm: quantize(pair.source_thickness),
            destination_thickness_pm: quantize(pair.destination_thickness),
            source_layer_volume_pm3: quantize_volume(pair.source_layer_volume),
            destination_layer_volume_pm3: quantize_volume(pair.destination_layer_volume),
            transform,
            representation: pair.representation,
            precision,
            boundary,
        }
    }

    /// Compatibility constructor for the former z-only key API.  New code
    /// should use [`Self::from_pair`] so transform and representation are
    /// explicit.
    pub fn new(
        z_shift: f64,
        src_cell: [f64; 3],
        dst_cell: [f64; 3],
        conv_cell_z: f64,
        common_cells: [usize; 3],
    ) -> Self {
        let shift = if conv_cell_z.is_finite() && conv_cell_z != 0.0 {
            z_shift
        } else {
            0.0
        };
        let transform = TransformKey {
            shape: common_cells,
            linear_extent: common_cells,
            fft_shape: [
                common_cells[0] * 2,
                common_cells[1] * 2,
                common_cells[2] * 2,
            ],
            zero_padding: ZeroPadding::new([0; 3], common_cells),
            convention: TransformConvention::XFastestZMajor,
            source_insert_offset: [0; 3],
            lag_zero: [0; 3],
            destination_crop: CropWindow::new([0; 3], common_cells),
            inverse_normalization_quantized: quantize(1.0),
        };
        Self {
            schema_version: DESCRIPTOR_SCHEMA_VERSION.to_string(),
            mode: ConvolutionMode::ThreeD,
            oriented_shift: [0, 0, quantize(shift)],
            h_source: quantize3(src_cell),
            h_destination: quantize3(dst_cell),
            source_thickness_pm: quantize(src_cell[2]),
            destination_thickness_pm: quantize(dst_cell[2]),
            source_layer_volume_pm3: quantize_volume(src_cell[0] * src_cell[1] * src_cell[2]),
            destination_layer_volume_pm3: quantize_volume(dst_cell[0] * dst_cell[1] * dst_cell[2]),
            transform,
            representation: TensorRepresentation::FullComplex,
            precision: KernelPrecision::F64,
            boundary: BoundaryPolicy::Open,
        }
    }

    pub fn validate(&self) -> Result<(), DescriptorError> {
        if self.schema_version != DESCRIPTOR_SCHEMA_VERSION {
            return Err(DescriptorError::Invalid(format!(
                "unsupported kernel key schema version '{}'",
                self.schema_version
            )));
        }
        self.transform.validate()?;
        if self.mode == ConvolutionMode::TwoDStack
            && (self.transform.linear_extent[2] != 1 || self.transform.fft_shape[2] != 1)
        {
            return Err(DescriptorError::Invalid(
                "two_d_stack kernel key must have one z transform sample".to_string(),
            ));
        }
        if self.boundary != BoundaryPolicy::Open {
            return Err(DescriptorError::Invalid(
                "periodic kernel reuse is not supported by descriptor schema v1".to_string(),
            ));
        }
        Ok(())
    }

    /// Whether an opposite signed-Z key may reuse this key by parity.  This
    /// is deliberately stricter than equality: only pure-Z 2-D pairs with
    /// equal oriented cell sizes and equal source/destination thickness pass.
    pub fn can_reuse_opposite_z(&self, other: &Self) -> bool {
        self.validate().is_ok()
            && other.validate().is_ok()
            && self.mode == ConvolutionMode::TwoDStack
            && other.mode == ConvolutionMode::TwoDStack
            && self.oriented_shift[0] == 0
            && self.oriented_shift[1] == 0
            && other.oriented_shift[0] == 0
            && other.oriented_shift[1] == 0
            && self.oriented_shift[2] == -other.oriented_shift[2]
            && self.h_source == self.h_destination
            && other.h_source == other.h_destination
            && self.h_source == other.h_source
            && self.source_thickness_pm == self.destination_thickness_pm
            && other.source_thickness_pm == other.destination_thickness_pm
            && self.source_thickness_pm == other.source_thickness_pm
            && self.source_layer_volume_pm3 == self.destination_layer_volume_pm3
            && other.source_layer_volume_pm3 == other.destination_layer_volume_pm3
            && self.source_layer_volume_pm3 == other.source_layer_volume_pm3
            && self.transform == other.transform
            && self.representation == other.representation
            && self.precision == other.precision
            && self.boundary == other.boundary
    }

    pub fn fingerprint(&self) -> String {
        sha256_fingerprint(self)
    }
}

/// Short aliases retained for callers that refer to layer-grid or pair
/// descriptors without the FDM-specific prefix.
pub type LayerGridDescriptor = FdmLayerDescriptor;
pub type OrientedPairDescriptor = OrientedKernelPairDescriptor;

/// Admission model used to turn a canonical catalog into a memory budget.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KernelAdmissionModel {
    /// CPU FP64 stores one six-component complex spectrum per unique key.
    CpuFp64Catalog,
    /// Native stacked CUDA uses the ordinary single-grid operator and stores
    /// no multilayer pair-kernel payload.
    CudaNativeSingleGrid,
    /// CUDA ABI v2 still stores one six-component FP64 payload per ordered pair.
    CudaAbiV2PairPayload,
}

impl KernelAdmissionModel {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::CpuFp64Catalog => "cpu_fp64_catalog",
            Self::CudaNativeSingleGrid => "cuda_native_multilayer_single_grid",
            Self::CudaAbiV2PairPayload => "cuda_abi_v2_pair_payload",
        }
    }
}

/// Fixed-width source-major binding from an ordered layer pair to a unique key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct KernelCatalogPairBinding {
    pub src_layer: u32,
    pub dst_layer: u32,
    pub kernel_index: u32,
}

impl KernelCatalogPairBinding {
    pub const BYTE_WIDTH: u64 = 3 * std::mem::size_of::<u32>() as u64;
}

/// Backend-neutral deterministic catalog specification used by planning and runtime.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KernelCatalogSpec {
    pub keys: Vec<KernelReuseKey>,
    pub pair_bindings: Vec<KernelCatalogPairBinding>,
}

impl KernelCatalogSpec {
    pub fn build_for_layers_with_layout(
        layers: &[FdmLayerDescriptor],
        layout: &CommonTransformLayout,
        representation: TensorRepresentation,
        precision: KernelPrecision,
    ) -> Result<Self, DescriptorError> {
        layout.validate()?;
        let pair_count = layers
            .len()
            .checked_mul(layers.len())
            .ok_or_else(|| DescriptorError::Invalid("kernel pair count overflow".to_string()))?;
        let mut keys = Vec::<KernelReuseKey>::new();
        let mut bindings = Vec::with_capacity(pair_count);
        for (src_layer, source) in layers.iter().enumerate() {
            source.validate()?;
            for (dst_layer, destination) in layers.iter().enumerate() {
                destination.validate()?;
                let source_cell = represented_kernel_cell_size(source, layout.mode);
                let destination_cell = represented_kernel_cell_size(destination, layout.mode);
                let relative_shift = [
                    destination.scratch.origin[0] - source.scratch.origin[0]
                        + 0.5 * (destination_cell[0] - source_cell[0]),
                    destination.scratch.origin[1] - source.scratch.origin[1]
                        + 0.5 * (destination_cell[1] - source_cell[1]),
                    destination.scratch.origin[2] - source.scratch.origin[2]
                        + 0.5 * (destination_cell[2] - source_cell[2]),
                ];
                let key = KernelReuseKey::from_layers_with_layout(
                    destination,
                    source,
                    relative_shift,
                    representation,
                    layout,
                    precision,
                    source.transfer.boundary,
                )?;
                let kernel_index = match keys.iter().position(|candidate| candidate == &key) {
                    Some(index) => index,
                    None => {
                        keys.push(key);
                        keys.len() - 1
                    }
                };
                bindings.push(KernelCatalogPairBinding {
                    src_layer: u32::try_from(src_layer).map_err(|_| {
                        DescriptorError::Invalid("source layer index exceeds u32".to_string())
                    })?,
                    dst_layer: u32::try_from(dst_layer).map_err(|_| {
                        DescriptorError::Invalid("destination layer index exceeds u32".to_string())
                    })?,
                    kernel_index: u32::try_from(kernel_index).map_err(|_| {
                        DescriptorError::Invalid("kernel catalog index exceeds u32".to_string())
                    })?,
                });
            }
        }

        let mut order = (0..keys.len()).collect::<Vec<_>>();
        order.sort_by_key(|index| keys[*index].fingerprint());
        let mut remap = vec![0_u32; keys.len()];
        for (new_index, old_index) in order.iter().copied().enumerate() {
            remap[old_index] = u32::try_from(new_index).map_err(|_| {
                DescriptorError::Invalid("kernel catalog index exceeds u32".to_string())
            })?;
        }
        let sorted_keys = order.into_iter().map(|index| keys[index].clone()).collect();
        for binding in &mut bindings {
            binding.kernel_index = remap[binding.kernel_index as usize];
        }
        Ok(Self {
            keys: sorted_keys,
            pair_bindings: bindings,
        })
    }
}

/// Checked logical memory accounting for the catalog and CUDA ABI-v2 payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct KernelMemoryAccounting {
    pub kernel_catalog_spectrum_bytes: u64,
    pub kernel_pair_binding_bytes: u64,
    pub cuda_abi_v2_pair_payload_bytes: u64,
    pub admission_bytes: u64,
    pub admission_model: KernelAdmissionModel,
}

impl KernelMemoryAccounting {
    pub fn for_catalog(
        catalog: &KernelCatalogSpec,
        layout: &CommonTransformLayout,
        common_cells: [usize; 3],
        demag_enabled: bool,
        admission_model: KernelAdmissionModel,
    ) -> Result<Self, DescriptorError> {
        layout.validate()?;
        if !demag_enabled {
            return Ok(Self {
                kernel_catalog_spectrum_bytes: 0,
                kernel_pair_binding_bytes: 0,
                cuda_abi_v2_pair_payload_bytes: 0,
                admission_bytes: 0,
                admission_model,
            });
        }
        if common_cells.contains(&0) {
            return Err(DescriptorError::Invalid(
                "common kernel grid dimensions must be positive".to_string(),
            ));
        }
        if catalog
            .keys
            .iter()
            .any(|key| key.representation != TensorRepresentation::FullComplex)
        {
            return Err(DescriptorError::Invalid(
                "kernel memory accounting supports only full-complex six-component spectra"
                    .to_string(),
            ));
        }
        if admission_model == KernelAdmissionModel::CpuFp64Catalog
            && catalog
                .keys
                .iter()
                .any(|key| key.precision != KernelPrecision::F64)
        {
            return Err(DescriptorError::Invalid(
                "CPU FP64 catalog admission requires FP64 kernel keys".to_string(),
            ));
        }
        let checked_product = |values: [usize; 3], label: &str| -> Result<u64, DescriptorError> {
            values.into_iter().try_fold(1_u64, |product, value| {
                product
                    .checked_mul(value as u64)
                    .ok_or_else(|| DescriptorError::Invalid(format!("{label} cell count overflow")))
            })
        };
        let spectrum_samples = checked_product(layout.fft_shape, "kernel spectrum")?;
        let unique_count = u64::try_from(catalog.keys.len()).map_err(|_| {
            DescriptorError::Invalid("kernel catalog count exceeds u64".to_string())
        })?;
        let pair_count = u64::try_from(catalog.pair_bindings.len())
            .map_err(|_| DescriptorError::Invalid("kernel pair count exceeds u64".to_string()))?;
        let spectrum_bytes = unique_count
            .checked_mul(spectrum_samples)
            .and_then(|value| value.checked_mul(6))
            .and_then(|value| value.checked_mul(16))
            .ok_or_else(|| {
                DescriptorError::Invalid("kernel catalog spectrum byte overflow".to_string())
            })?;
        let binding_bytes = pair_count
            .checked_mul(KernelCatalogPairBinding::BYTE_WIDTH)
            .ok_or_else(|| {
                DescriptorError::Invalid("kernel pair binding byte overflow".to_string())
            })?;
        let mut cuda_shape = [0_usize; 3];
        for axis in 0..3 {
            cuda_shape[axis] = common_cells[axis].checked_mul(2).ok_or_else(|| {
                DescriptorError::Invalid("CUDA ABI-v2 doubled grid overflow".to_string())
            })?;
        }
        let cuda_samples = checked_product(cuda_shape, "CUDA ABI-v2 kernel")?;
        let cuda_bytes = pair_count
            .checked_mul(cuda_samples)
            .and_then(|value| value.checked_mul(6))
            .and_then(|value| value.checked_mul(16))
            .ok_or_else(|| {
                DescriptorError::Invalid("CUDA ABI-v2 pair payload byte overflow".to_string())
            })?;
        let selected_payload = match admission_model {
            KernelAdmissionModel::CpuFp64Catalog => spectrum_bytes,
            KernelAdmissionModel::CudaNativeSingleGrid => 0,
            KernelAdmissionModel::CudaAbiV2PairPayload => cuda_bytes,
        };
        let selected_binding_bytes =
            if admission_model == KernelAdmissionModel::CudaNativeSingleGrid {
                0
            } else {
                binding_bytes
            };
        let admission_bytes = selected_payload
            .checked_add(selected_binding_bytes)
            .ok_or_else(|| {
                DescriptorError::Invalid("kernel admission byte overflow".to_string())
            })?;
        Ok(Self {
            kernel_catalog_spectrum_bytes: spectrum_bytes,
            kernel_pair_binding_bytes: binding_bytes,
            cuda_abi_v2_pair_payload_bytes: cuda_bytes,
            admission_bytes,
            admission_model,
        })
    }
}

fn represented_kernel_cell_size(layer: &FdmLayerDescriptor, mode: ConvolutionMode) -> [f64; 3] {
    if mode == ConvolutionMode::TwoDStack {
        [
            layer.scratch.spacing[0],
            layer.scratch.spacing[1],
            layer.native.thickness(),
        ]
    } else {
        layer.scratch.spacing
    }
}

/// Deterministic set of unique kernel keys.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KernelReuseCatalog {
    pub keys: Vec<KernelReuseKey>,
    pub pair_bindings: Vec<KernelPairBinding>,
}

/// Explicit mapping from one oriented pair fingerprint to the unique kernel
/// key used for its execution. A catalogue entry is not enough on its own:
/// runtime provenance must be able to answer which pair consumed a reused
/// kernel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KernelPairBinding {
    pub pair_fingerprint: String,
    pub key_fingerprint: String,
}

impl KernelReuseCatalog {
    pub fn new() -> Self {
        Self {
            keys: Vec::new(),
            pair_bindings: Vec::new(),
        }
    }

    pub fn from_keys<I>(keys: I) -> Self
    where
        I: IntoIterator<Item = KernelReuseKey>,
    {
        let mut catalog = Self::new();
        for key in keys {
            catalog.insert(key);
        }
        catalog
    }

    pub fn insert(&mut self, key: KernelReuseKey) -> bool {
        if self.keys.iter().any(|existing| existing == &key) {
            return false;
        }
        self.keys.push(key);
        self.keys.sort_by_key(KernelReuseKey::fingerprint);
        true
    }

    pub fn bind_pair(
        &mut self,
        pair: &OrientedKernelPairDescriptor,
        key: KernelReuseKey,
    ) -> Result<(), DescriptorError> {
        if !self.keys.iter().any(|existing| existing == &key) {
            self.insert(key.clone());
        }
        let binding = KernelPairBinding {
            pair_fingerprint: pair.fingerprint(),
            key_fingerprint: key.fingerprint(),
        };
        if let Some(existing) = self
            .pair_bindings
            .iter_mut()
            .find(|existing| existing.pair_fingerprint == binding.pair_fingerprint)
        {
            if existing.key_fingerprint != binding.key_fingerprint {
                return Err(DescriptorError::Invalid(
                    "pair fingerprint is already bound to a different kernel key".to_string(),
                ));
            }
            return Ok(());
        }
        self.pair_bindings.push(binding);
        self.pair_bindings
            .sort_by(|left, right| left.pair_fingerprint.cmp(&right.pair_fingerprint));
        Ok(())
    }

    pub fn kernel_key_for_pair(
        &self,
        pair: &OrientedKernelPairDescriptor,
    ) -> Option<&KernelReuseKey> {
        let pair_fingerprint = pair.fingerprint();
        let binding = self
            .pair_bindings
            .iter()
            .find(|binding| binding.pair_fingerprint == pair_fingerprint)?;
        self.keys
            .iter()
            .find(|key| key.fingerprint() == binding.key_fingerprint)
    }

    pub fn len(&self) -> usize {
        self.keys.len()
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    pub fn fingerprint(&self) -> String {
        sha256_fingerprint(self)
    }
}

impl Default for KernelReuseCatalog {
    fn default() -> Self {
        Self::new()
    }
}

/// Error returned when a descriptor would encode an ambiguous or unsafe
/// runtime contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DescriptorError {
    Invalid(String),
}

impl fmt::Display for DescriptorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for DescriptorError {}

fn quantize(value: f64) -> i64 {
    if !value.is_finite() {
        return i64::MIN;
    }
    (value * 1e12).round() as i64
}

fn quantize3(value: [f64; 3]) -> [i64; 3] {
    [quantize(value[0]), quantize(value[1]), quantize(value[2])]
}

fn quantize_volume(value: f64) -> i64 {
    if !value.is_finite() {
        return i64::MIN;
    }
    (value * 1e36).round() as i64
}

fn sha256_fingerprint<T: Serialize>(value: &T) -> String {
    let payload = serde_json::to_vec(value).expect("descriptor serialization is infallible");
    format!("sha256:{:x}", Sha256::digest(payload))
}
