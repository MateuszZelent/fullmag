//! Bounded, identity-pinned subtraction of verified dataset field slices.
//! This evaluator never projects, normalizes, solves or publishes a dataset.

use crate::{
    is_canonical_sha256, validate_field_compatibility, DatasetAvailability, DatasetContractError,
    DatasetFieldDescriptor, DatasetFieldSlice, DatasetFieldSliceRequest, DatasetNumericPrecision,
    DatasetNumericValues, DatasetSliceError, DatasetSlicePlane, DatasetStatus, FieldResolution,
    MAX_DATASET_SLICE_BYTES,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fmt, io::Write};

pub const DATASET_DIFFERENCE_SCHEMA_VERSION: &str = "1.0.0";
pub const MAX_DATASET_DIFFERENCE_WORKING_BYTES: u64 = 5 * MAX_DATASET_SLICE_BYTES;
pub const DATASET_DIFFERENCE_PRODUCER: &str = "fullmag.dataset_difference.cpu.v1";
pub const MAX_DATASET_DIFFERENCE_METADATA_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PinnedDatasetFieldSlice {
    pub request: DatasetFieldSliceRequest,
    pub manifest_sha256: String,
    pub descriptor_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatasetDifferenceRequest {
    pub schema_version: String,
    pub left: PinnedDatasetFieldSlice,
    pub right: PinnedDatasetFieldSlice,
    pub max_output_bytes: u64,
    /// Payload accounting only; metadata and allocator overhead are excluded.
    pub max_working_bytes: u64,
}

impl DatasetDifferenceRequest {
    pub fn validate(&self) -> Result<(), DatasetDifferenceError> {
        if self.schema_version != DATASET_DIFFERENCE_SCHEMA_VERSION {
            return Err(DatasetDifferenceError::UnsupportedSchema);
        }
        for source in [&self.left, &self.right] {
            source
                .request
                .validate()
                .map_err(DatasetDifferenceError::Slice)?;
            if !is_canonical_sha256(&source.manifest_sha256)
                || !is_canonical_sha256(&source.descriptor_sha256)
            {
                return Err(DatasetDifferenceError::InvalidSourceDigest);
            }
        }
        if self.max_output_bytes == 0
            || self.max_output_bytes > MAX_DATASET_SLICE_BYTES
            || self.max_working_bytes == 0
            || self.max_working_bytes > MAX_DATASET_DIFFERENCE_WORKING_BYTES
        {
            return Err(DatasetDifferenceError::InvalidBudget);
        }
        if self.left.request.element_offset != self.right.request.element_offset
            || self.left.request.element_count != self.right.request.element_count
        {
            return Err(DatasetDifferenceError::RangeMismatch);
        }
        Ok(())
    }

    /// Conservative reservation before storage reads. No caller-owned extra
    /// copies or metadata are covered by this payload-only reservation.
    pub fn validate_read_budget(&self) -> Result<(), DatasetDifferenceError> {
        self.validate()?;
        let reserved = self
            .left
            .request
            .max_response_bytes
            .checked_add(self.right.request.max_response_bytes)
            .and_then(|value| value.checked_mul(2))
            .and_then(|value| value.checked_add(self.max_output_bytes))
            .ok_or(DatasetDifferenceError::BudgetExceeded)?;
        if reserved > self.max_working_bytes {
            return Err(DatasetDifferenceError::BudgetExceeded);
        }
        Ok(())
    }
}

pub struct DatasetDifferenceInput<'a> {
    pub manifest: &'a DatasetFieldSlice,
    pub descriptor: &'a DatasetFieldDescriptor,
    pub status: &'a DatasetStatus,
    pub part_bytes: &'a [&'a [u8]],
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatasetDifferencePlane {
    pub plane: DatasetSlicePlane,
    pub byte_length: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatasetDifferenceReceipt {
    pub schema_version: String,
    pub producer_version: String,
    /// Defines operand order, not an unsigned error norm.
    pub operation: DatasetDifferenceOperation,
    pub output_semantics: DatasetDifferenceOutputSemantics,
    pub left: PinnedDatasetFieldSlice,
    pub right: PinnedDatasetFieldSlice,
    pub input_descriptor: DatasetFieldDescriptor,
    pub precision: DatasetNumericPrecision,
    pub component_count: u32,
    pub total_elements: u64,
    pub payload_bytes: u64,
    pub accounted_working_bytes: u64,
    pub planes: Vec<DatasetDifferencePlane>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatasetDifferenceOperation {
    LeftMinusRight,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatasetDifferenceOutputSemantics {
    /// Input units/basis are preserved, but the output is not normalized and
    /// has not been reconstructed into another field representation.
    UnnormalizedSignedDifference,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DatasetDifference {
    pub receipt: DatasetDifferenceReceipt,
    /// Little-endian binary data, in the same order as receipt.planes.
    /// No numerical arrays belong in a JSON control-plane response.
    pub plane_bytes: Vec<Vec<u8>>,
}

pub fn dataset_comparison_digest<T: Serialize>(
    value: &T,
) -> Result<String, DatasetDifferenceError> {
    let mut writer = MetadataDigest {
        hash: Sha256::new(),
        written: 0,
        exceeded: false,
    };
    if serde_json::to_writer(&mut writer, value).is_err() {
        return Err(if writer.exceeded {
            DatasetDifferenceError::MetadataBudgetExceeded
        } else {
            DatasetDifferenceError::Serialization
        });
    }
    Ok(format!("sha256:{:x}", writer.hash.finalize()))
}

struct MetadataDigest {
    hash: Sha256,
    written: usize,
    exceeded: bool,
}
impl Write for MetadataDigest {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > MAX_DATASET_DIFFERENCE_METADATA_BYTES - self.written {
            self.exceeded = true;
            return Err(std::io::Error::other(
                "dataset comparison metadata byte limit",
            ));
        }
        self.hash.update(bytes);
        self.written += bytes.len();
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

pub fn compare_dataset_field_slices(
    request: &DatasetDifferenceRequest,
    left: &DatasetDifferenceInput<'_>,
    right: &DatasetDifferenceInput<'_>,
) -> Result<DatasetDifference, DatasetDifferenceError> {
    validate_dataset_difference_sources(
        request,
        left.descriptor,
        left.status,
        right.descriptor,
        right.status,
    )?;
    validate_input(&request.left, left)?;
    validate_input(&request.right, right)?;
    validate_field_compatibility(left.descriptor, right.descriptor, None)
        .map_err(DatasetDifferenceError::Contract)?;
    let a = left.manifest;
    let b = right.manifest;
    if a.total_elements != b.total_elements
        || a.component_count != b.component_count
        || a.precision != b.precision
        || a.payload_bytes != b.payload_bytes
    {
        return Err(DatasetDifferenceError::ShapeOrPrecisionMismatch);
    }
    let working_bytes = a
        .payload_bytes
        .checked_mul(5)
        .ok_or(DatasetDifferenceError::BudgetExceeded)?;
    if a.payload_bytes > request.max_output_bytes || working_bytes > request.max_working_bytes {
        return Err(DatasetDifferenceError::BudgetExceeded);
    }
    // Verify both byte sets before allocating decoded planes for either input.
    a.validate_part_bytes(left.part_bytes)
        .map_err(DatasetDifferenceError::Slice)?;
    b.validate_part_bytes(right.part_bytes)
        .map_err(DatasetDifferenceError::Slice)?;
    let left_decoded = a
        .decode_part_bytes(left.part_bytes)
        .map_err(DatasetDifferenceError::Slice)?;
    let right_decoded = b
        .decode_part_bytes(right.part_bytes)
        .map_err(DatasetDifferenceError::Slice)?;
    let mut plane_bytes = Vec::with_capacity(left_decoded.planes.len());
    let mut planes = Vec::with_capacity(left_decoded.planes.len());
    for (left_plane, right_plane) in left_decoded.planes.iter().zip(&right_decoded.planes) {
        if left_plane.plane != right_plane.plane {
            return Err(DatasetDifferenceError::ShapeOrPrecisionMismatch);
        }
        let bytes = subtract_values(&left_plane.values, &right_plane.values, left_plane.plane)?;
        planes.push(DatasetDifferencePlane {
            plane: left_plane.plane,
            byte_length: bytes.len() as u64,
            sha256: bytes_digest(&bytes),
        });
        plane_bytes.push(bytes);
    }
    Ok(DatasetDifference {
        receipt: DatasetDifferenceReceipt {
            schema_version: DATASET_DIFFERENCE_SCHEMA_VERSION.to_string(),
            producer_version: DATASET_DIFFERENCE_PRODUCER.to_string(),
            operation: DatasetDifferenceOperation::LeftMinusRight,
            output_semantics: DatasetDifferenceOutputSemantics::UnnormalizedSignedDifference,
            left: request.left.clone(),
            right: request.right.clone(),
            input_descriptor: left.descriptor.clone(),
            precision: a.precision,
            component_count: a.component_count,
            total_elements: a.total_elements,
            payload_bytes: a.payload_bytes,
            accounted_working_bytes: working_bytes,
            planes,
        },
        plane_bytes,
    })
}

/// Semantic preflight usable before any storage reads or payload allocation.
pub fn validate_dataset_difference_sources(
    request: &DatasetDifferenceRequest,
    left: &DatasetFieldDescriptor,
    left_status: &DatasetStatus,
    right: &DatasetFieldDescriptor,
    right_status: &DatasetStatus,
) -> Result<(), DatasetDifferenceError> {
    request.validate()?;
    for (pin, descriptor, status) in [
        (&request.left, left, left_status),
        (&request.right, right, right_status),
    ] {
        status
            .validate()
            .map_err(DatasetDifferenceError::Contract)?;
        if status.availability != DatasetAvailability::Ready {
            return Err(DatasetDifferenceError::UnavailableInput);
        }
        if descriptor.resolution != FieldResolution::Quantitative {
            return Err(DatasetDifferenceError::PreviewInput);
        }
        if dataset_comparison_digest(descriptor)? != pin.descriptor_sha256 {
            return Err(DatasetDifferenceError::SourceIdentityMismatch);
        }
    }
    validate_field_compatibility(left, right, None).map_err(DatasetDifferenceError::Contract)
}

fn validate_input(
    pin: &PinnedDatasetFieldSlice,
    input: &DatasetDifferenceInput<'_>,
) -> Result<(), DatasetDifferenceError> {
    input
        .status
        .validate()
        .map_err(DatasetDifferenceError::Contract)?;
    if input.status.availability != DatasetAvailability::Ready {
        return Err(DatasetDifferenceError::UnavailableInput);
    }
    if input.descriptor.resolution != FieldResolution::Quantitative {
        return Err(DatasetDifferenceError::PreviewInput);
    }
    input
        .manifest
        .validate_for_request(&pin.request)
        .map_err(DatasetDifferenceError::Slice)?;
    if dataset_comparison_digest(input.manifest)? != pin.manifest_sha256
        || dataset_comparison_digest(input.descriptor)? != pin.descriptor_sha256
    {
        return Err(DatasetDifferenceError::SourceIdentityMismatch);
    }
    let components = match &input.descriptor.component_axis {
        None => 1,
        Some(id) => input
            .descriptor
            .axes
            .iter()
            .find(|axis| &axis.axis_id == id)
            .map(|axis| axis.length)
            .ok_or(DatasetDifferenceError::DescriptorMismatch)?,
    };
    if input.manifest.field_layout_digest != input.descriptor.layout_digest
        || u64::from(input.manifest.component_count) != components
        || input.manifest.complex_encoding != input.descriptor.complex_encoding
        || input.manifest.harmonic_convention != input.descriptor.harmonic_convention
    {
        return Err(DatasetDifferenceError::DescriptorMismatch);
    }
    Ok(())
}

fn subtract_values(
    left: &DatasetNumericValues,
    right: &DatasetNumericValues,
    plane: DatasetSlicePlane,
) -> Result<Vec<u8>, DatasetDifferenceError> {
    macro_rules! subtract {
        ($left:expr, $right:expr, $width:expr) => {{
            if $left.len() != $right.len() {
                return Err(DatasetDifferenceError::ShapeOrPrecisionMismatch);
            }
            let capacity = $left
                .len()
                .checked_mul($width)
                .ok_or(DatasetDifferenceError::BudgetExceeded)?;
            let mut bytes = Vec::with_capacity(capacity);
            for (index, (a, b)) in $left.iter().zip($right).enumerate() {
                let value = *a - *b;
                if !value.is_finite() {
                    return Err(DatasetDifferenceError::NonFiniteDifference { plane, index });
                }
                bytes.extend_from_slice(&value.to_le_bytes());
            }
            bytes
        }};
    }
    Ok(match (left, right) {
        (DatasetNumericValues::F32(a), DatasetNumericValues::F32(b)) => subtract!(a, b, 4),
        (DatasetNumericValues::F64(a), DatasetNumericValues::F64(b)) => subtract!(a, b, 8),
        _ => return Err(DatasetDifferenceError::ShapeOrPrecisionMismatch),
    })
}

fn bytes_digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DatasetDifferenceError {
    UnsupportedSchema,
    InvalidSourceDigest,
    InvalidBudget,
    BudgetExceeded,
    RangeMismatch,
    UnavailableInput,
    PreviewInput,
    SourceIdentityMismatch,
    DescriptorMismatch,
    ShapeOrPrecisionMismatch,
    Serialization,
    MetadataBudgetExceeded,
    NonFiniteDifference {
        plane: DatasetSlicePlane,
        index: usize,
    },
    Slice(DatasetSliceError),
    Contract(DatasetContractError),
}

impl fmt::Display for DatasetDifferenceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "dataset difference: {self:?}")
    }
}
impl std::error::Error for DatasetDifferenceError {}

#[cfg(test)]
#[path = "dataset_difference_tests.rs"]
mod tests;
