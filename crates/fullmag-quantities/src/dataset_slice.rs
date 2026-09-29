//! Bounded partial-read contract for materialized dataset fields.
//!
//! Storage remains owned by the session CAS and its tensor descriptors. This
//! module describes a storage-neutral request and the exact byte ranges
//! returned from those objects. It deliberately does not define another field
//! or viewport codec.

use crate::{is_canonical_sha256, ComplexEncoding, HarmonicConvention, MaterializedDatasetRef};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fmt;

pub const DATASET_SLICE_SCHEMA_VERSION: &str = "1.0.0";
pub const MAX_DATASET_SLICE_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_DATASET_SLICE_ELEMENTS: u64 = 8 * 1024 * 1024;
pub const MAX_DATASET_SLICE_PARTS: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatasetNumericPrecision {
    F32,
    F64,
}

impl DatasetNumericPrecision {
    pub const fn byte_size(self) -> u64 {
        match self {
            Self::F32 => 4,
            Self::F64 => 8,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatasetByteOrder {
    LittleEndian,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatasetFieldSliceRequest {
    pub schema_version: String,
    pub dataset: MaterializedDatasetRef,
    pub sample_id: String,
    pub item_id: String,
    pub field_id: String,
    pub element_offset: u64,
    pub element_count: u64,
    pub max_response_bytes: u64,
}

impl DatasetFieldSliceRequest {
    pub fn validate(&self) -> Result<(), DatasetSliceError> {
        require_schema(&self.schema_version)?;
        require_id("dataset_id", &self.dataset.dataset_id)?;
        require_id("sample_id", &self.sample_id)?;
        require_id("item_id", &self.item_id)?;
        require_id("field_id", &self.field_id)?;
        if self.element_count == 0 || self.element_count > MAX_DATASET_SLICE_ELEMENTS {
            return Err(DatasetSliceError::ElementCountOutOfRange);
        }
        if self.max_response_bytes == 0 || self.max_response_bytes > MAX_DATASET_SLICE_BYTES {
            return Err(DatasetSliceError::ByteBudgetOutOfRange);
        }
        self.element_offset
            .checked_add(self.element_count)
            .ok_or(DatasetSliceError::ElementRangeOverflow)?;
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatasetSlicePlane {
    Values,
    Real,
    Imaginary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatasetSlicePart {
    pub plane: DatasetSlicePlane,
    /// CAS object containing the returned range.
    pub object_ref: String,
    /// Offset of the returned range within the CAS object.
    pub object_offset_bytes: u64,
    /// Offset of this part within its decoded values/real/imag plane.
    pub plane_offset_bytes: u64,
    pub byte_length: u64,
    /// Checksum of exactly the returned range, not implicitly the full object.
    pub range_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatasetFieldSlice {
    pub schema_version: String,
    pub dataset: MaterializedDatasetRef,
    pub sample_id: String,
    pub item_id: String,
    pub field_id: String,
    pub field_layout_digest: String,
    pub element_offset: u64,
    pub element_count: u64,
    pub total_elements: u64,
    pub component_count: u32,
    pub precision: DatasetNumericPrecision,
    pub byte_order: DatasetByteOrder,
    pub complex_encoding: ComplexEncoding,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harmonic_convention: Option<HarmonicConvention>,
    pub payload_bytes: u64,
    pub parts: Vec<DatasetSlicePart>,
}

impl DatasetFieldSlice {
    pub fn validate_for_request(
        &self,
        request: &DatasetFieldSliceRequest,
    ) -> Result<(), DatasetSliceError> {
        request.validate()?;
        self.validate()?;
        if self.dataset != request.dataset
            || self.sample_id != request.sample_id
            || self.item_id != request.item_id
            || self.field_id != request.field_id
            || self.element_offset != request.element_offset
            || self.element_count != request.element_count
        {
            return Err(DatasetSliceError::RequestIdentityMismatch);
        }
        if self.payload_bytes > request.max_response_bytes {
            return Err(DatasetSliceError::ResponseExceedsRequestBudget);
        }
        Ok(())
    }

    pub fn validate(&self) -> Result<(), DatasetSliceError> {
        require_schema(&self.schema_version)?;
        require_id("dataset_id", &self.dataset.dataset_id)?;
        require_id("sample_id", &self.sample_id)?;
        require_id("item_id", &self.item_id)?;
        require_id("field_id", &self.field_id)?;
        if !is_canonical_sha256(&self.field_layout_digest) {
            return Err(DatasetSliceError::InvalidDigest("field_layout_digest"));
        }
        if self.element_count == 0 || self.element_count > MAX_DATASET_SLICE_ELEMENTS {
            return Err(DatasetSliceError::ElementCountOutOfRange);
        }
        let element_end = self
            .element_offset
            .checked_add(self.element_count)
            .ok_or(DatasetSliceError::ElementRangeOverflow)?;
        if element_end > self.total_elements {
            return Err(DatasetSliceError::ElementRangeOutsideField);
        }
        if self.component_count == 0 {
            return Err(DatasetSliceError::ZeroComponentCount);
        }

        let plane_count = match self.complex_encoding {
            ComplexEncoding::Real => {
                if self.harmonic_convention.is_some() {
                    return Err(DatasetSliceError::UnexpectedHarmonicConvention);
                }
                1_u64
            }
            ComplexEncoding::RealImagPair => {
                if self.harmonic_convention.is_none() {
                    return Err(DatasetSliceError::MissingHarmonicConvention);
                }
                2_u64
            }
        };
        let plane_bytes = self
            .element_count
            .checked_mul(u64::from(self.component_count))
            .and_then(|count| count.checked_mul(self.precision.byte_size()))
            .ok_or(DatasetSliceError::PayloadSizeOverflow)?;
        let expected_payload_bytes = plane_bytes
            .checked_mul(plane_count)
            .ok_or(DatasetSliceError::PayloadSizeOverflow)?;
        if self.payload_bytes != expected_payload_bytes
            || self.payload_bytes == 0
            || self.payload_bytes > MAX_DATASET_SLICE_BYTES
        {
            return Err(DatasetSliceError::PayloadSizeMismatch);
        }

        let expected_planes: &[DatasetSlicePlane] = match self.complex_encoding {
            ComplexEncoding::Real => &[DatasetSlicePlane::Values],
            ComplexEncoding::RealImagPair => {
                &[DatasetSlicePlane::Real, DatasetSlicePlane::Imaginary]
            }
        };
        validate_parts(&self.parts, expected_planes, plane_bytes)?;
        Ok(())
    }

    /// Verifies exact returned bytes against the range checksums in the
    /// manifest. The order must match `parts`.
    pub fn validate_part_bytes(&self, part_bytes: &[&[u8]]) -> Result<(), DatasetSliceError> {
        self.validate()?;
        if part_bytes.len() != self.parts.len() {
            return Err(DatasetSliceError::PartCountMismatch);
        }
        for (part, bytes) in self.parts.iter().zip(part_bytes) {
            if bytes.len() as u64 != part.byte_length {
                return Err(DatasetSliceError::PartLengthMismatch);
            }
            if sha256_prefixed(bytes) != part.range_sha256 {
                return Err(DatasetSliceError::PartChecksumMismatch);
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DatasetSliceError {
    UnsupportedSchema(String),
    EmptyId(&'static str),
    ElementCountOutOfRange,
    ByteBudgetOutOfRange,
    ElementRangeOverflow,
    ElementRangeOutsideField,
    ZeroComponentCount,
    MissingHarmonicConvention,
    UnexpectedHarmonicConvention,
    PayloadSizeOverflow,
    PayloadSizeMismatch,
    MissingPlane(DatasetSlicePlane),
    UnexpectedPlane(DatasetSlicePlane),
    EmptyPart,
    PartCountOutOfRange,
    InvalidDigest(&'static str),
    PlaneCoverageGapOrOverlap(DatasetSlicePlane),
    PlaneCoverageIncomplete(DatasetSlicePlane),
    RequestIdentityMismatch,
    ResponseExceedsRequestBudget,
    PartCountMismatch,
    PartLengthMismatch,
    PartChecksumMismatch,
}

impl fmt::Display for DatasetSliceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedSchema(schema) => {
                write!(formatter, "unsupported dataset slice schema '{schema}'")
            }
            Self::EmptyId(field) => write!(formatter, "dataset slice {field} must not be empty"),
            Self::ElementCountOutOfRange => formatter.write_str(
                "dataset slice element_count must be positive and within the bounded limit",
            ),
            Self::ByteBudgetOutOfRange => formatter.write_str(
                "dataset slice max_response_bytes must be positive and within the bounded limit",
            ),
            Self::ElementRangeOverflow => {
                formatter.write_str("dataset slice element range overflows")
            }
            Self::ElementRangeOutsideField => {
                formatter.write_str("dataset slice element range exceeds the field")
            }
            Self::ZeroComponentCount => {
                formatter.write_str("dataset slice component_count must be positive")
            }
            Self::MissingHarmonicConvention => formatter
                .write_str("real/imag dataset slices require an explicit harmonic convention"),
            Self::UnexpectedHarmonicConvention => formatter
                .write_str("real dataset slices cannot carry a harmonic convention"),
            Self::PayloadSizeOverflow => {
                formatter.write_str("dataset slice payload size overflows")
            }
            Self::PayloadSizeMismatch => formatter.write_str(
                "dataset slice payload size does not match elements, components, precision, and encoding",
            ),
            Self::MissingPlane(plane) => {
                write!(formatter, "dataset slice is missing the {plane:?} plane")
            }
            Self::UnexpectedPlane(plane) => {
                write!(formatter, "dataset slice has unexpected {plane:?} plane")
            }
            Self::EmptyPart => formatter.write_str("dataset slice parts must not be empty"),
            Self::PartCountOutOfRange => formatter.write_str(
                "dataset slice part count must be positive and within the bounded limit",
            ),
            Self::InvalidDigest(field) => {
                write!(formatter, "dataset slice {field} must be canonical sha256")
            }
            Self::PlaneCoverageGapOrOverlap(plane) => write!(
                formatter,
                "dataset slice {plane:?} plane has a gap or overlapping parts"
            ),
            Self::PlaneCoverageIncomplete(plane) => {
                write!(formatter, "dataset slice {plane:?} plane coverage is incomplete")
            }
            Self::RequestIdentityMismatch => {
                formatter.write_str("dataset slice response does not match request identity")
            }
            Self::ResponseExceedsRequestBudget => {
                formatter.write_str("dataset slice response exceeds the request byte budget")
            }
            Self::PartCountMismatch => {
                formatter.write_str("dataset slice part byte count does not match the manifest")
            }
            Self::PartLengthMismatch => {
                formatter.write_str("dataset slice part length does not match the manifest")
            }
            Self::PartChecksumMismatch => {
                formatter.write_str("dataset slice part checksum does not match returned bytes")
            }
        }
    }
}

impl std::error::Error for DatasetSliceError {}

fn validate_parts(
    parts: &[DatasetSlicePart],
    expected_planes: &[DatasetSlicePlane],
    plane_bytes: u64,
) -> Result<(), DatasetSliceError> {
    if parts.is_empty() || parts.len() > MAX_DATASET_SLICE_PARTS {
        return Err(DatasetSliceError::PartCountOutOfRange);
    }
    let mut by_plane: BTreeMap<DatasetSlicePlane, Vec<&DatasetSlicePart>> = BTreeMap::new();
    for part in parts {
        if !expected_planes.contains(&part.plane) {
            return Err(DatasetSliceError::UnexpectedPlane(part.plane));
        }
        if part.byte_length == 0 {
            return Err(DatasetSliceError::EmptyPart);
        }
        if !is_cas_object_ref(&part.object_ref) {
            return Err(DatasetSliceError::InvalidDigest("object_ref"));
        }
        if !is_canonical_sha256(&part.range_sha256) {
            return Err(DatasetSliceError::InvalidDigest("range_sha256"));
        }
        part.object_offset_bytes
            .checked_add(part.byte_length)
            .ok_or(DatasetSliceError::PayloadSizeOverflow)?;
        by_plane.entry(part.plane).or_default().push(part);
    }

    for plane in expected_planes {
        let plane_parts = by_plane
            .get_mut(plane)
            .ok_or(DatasetSliceError::MissingPlane(*plane))?;
        plane_parts.sort_unstable_by_key(|part| part.plane_offset_bytes);
        let mut expected_offset = 0_u64;
        for part in plane_parts {
            if part.plane_offset_bytes != expected_offset {
                return Err(DatasetSliceError::PlaneCoverageGapOrOverlap(*plane));
            }
            expected_offset = expected_offset
                .checked_add(part.byte_length)
                .ok_or(DatasetSliceError::PayloadSizeOverflow)?;
        }
        if expected_offset != plane_bytes {
            return Err(DatasetSliceError::PlaneCoverageIncomplete(*plane));
        }
    }
    Ok(())
}

fn require_schema(schema: &str) -> Result<(), DatasetSliceError> {
    if schema == DATASET_SLICE_SCHEMA_VERSION {
        Ok(())
    } else {
        Err(DatasetSliceError::UnsupportedSchema(schema.to_string()))
    }
}

fn require_id(field: &'static str, value: &str) -> Result<(), DatasetSliceError> {
    if value.trim().is_empty() {
        Err(DatasetSliceError::EmptyId(field))
    } else {
        Ok(())
    }
}

fn is_cas_object_ref(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn sha256_prefixed(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut encoded = String::with_capacity(71);
    encoded.push_str("sha256:");
    for byte in digest {
        use fmt::Write as _;
        write!(&mut encoded, "{byte:02x}").expect("writing to String cannot fail");
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    fn digest(bytes: &[u8]) -> String {
        sha256_prefixed(bytes)
    }

    fn object_ref(bytes: &[u8]) -> String {
        digest(bytes)
            .strip_prefix("sha256:")
            .expect("canonical digest prefix")
            .to_string()
    }

    fn request() -> DatasetFieldSliceRequest {
        DatasetFieldSliceRequest {
            schema_version: DATASET_SLICE_SCHEMA_VERSION.to_string(),
            dataset: MaterializedDatasetRef {
                dataset_id: "dataset:modal".to_string(),
                revision: 4,
            },
            sample_id: "sample:h-50mt".to_string(),
            item_id: "mode:2".to_string(),
            field_id: "field:mode-m".to_string(),
            element_offset: 2,
            element_count: 2,
            max_response_bytes: 96,
        }
    }

    #[test]
    fn request_rejects_unbounded_or_empty_ranges() {
        let mut value = request();
        value.element_count = 0;
        assert_eq!(
            value.validate(),
            Err(DatasetSliceError::ElementCountOutOfRange)
        );

        let mut value = request();
        value.max_response_bytes = MAX_DATASET_SLICE_BYTES + 1;
        assert_eq!(
            value.validate(),
            Err(DatasetSliceError::ByteBudgetOutOfRange)
        );
    }

    #[test]
    fn real_imag_slice_roundtrips_and_verifies_exact_ranges() {
        let real = [1_u8; 48];
        let imaginary = [2_u8; 48];
        let response = DatasetFieldSlice {
            schema_version: DATASET_SLICE_SCHEMA_VERSION.to_string(),
            dataset: request().dataset,
            sample_id: "sample:h-50mt".to_string(),
            item_id: "mode:2".to_string(),
            field_id: "field:mode-m".to_string(),
            field_layout_digest: digest(b"layout"),
            element_offset: 2,
            element_count: 2,
            total_elements: 10,
            component_count: 3,
            precision: DatasetNumericPrecision::F64,
            byte_order: DatasetByteOrder::LittleEndian,
            complex_encoding: ComplexEncoding::RealImagPair,
            harmonic_convention: Some(HarmonicConvention::ExpPositiveIOmegaT),
            payload_bytes: 96,
            parts: vec![
                DatasetSlicePart {
                    plane: DatasetSlicePlane::Real,
                    object_ref: object_ref(b"real-object"),
                    object_offset_bytes: 16,
                    plane_offset_bytes: 0,
                    byte_length: 48,
                    range_sha256: digest(&real),
                },
                DatasetSlicePart {
                    plane: DatasetSlicePlane::Imaginary,
                    object_ref: object_ref(b"imag-object"),
                    object_offset_bytes: 16,
                    plane_offset_bytes: 0,
                    byte_length: 48,
                    range_sha256: digest(&imaginary),
                },
            ],
        };

        let json = serde_json::to_vec(&response).expect("serialize dataset slice");
        let decoded: DatasetFieldSlice =
            serde_json::from_slice(&json).expect("deserialize dataset slice");
        decoded
            .validate_for_request(&request())
            .expect("validate request identity and budget");
        decoded
            .validate_part_bytes(&[real.as_slice(), imaginary.as_slice()])
            .expect("verify exact range checksums");
    }

    #[test]
    fn slice_rejects_gap_between_chunk_ranges() {
        let bytes = [3_u8; 24];
        let response = DatasetFieldSlice {
            schema_version: DATASET_SLICE_SCHEMA_VERSION.to_string(),
            dataset: request().dataset,
            sample_id: "sample:h-50mt".to_string(),
            item_id: "mode:2".to_string(),
            field_id: "field:mode-m".to_string(),
            field_layout_digest: digest(b"layout"),
            element_offset: 2,
            element_count: 2,
            total_elements: 10,
            component_count: 3,
            precision: DatasetNumericPrecision::F64,
            byte_order: DatasetByteOrder::LittleEndian,
            complex_encoding: ComplexEncoding::Real,
            harmonic_convention: None,
            payload_bytes: 48,
            parts: vec![
                DatasetSlicePart {
                    plane: DatasetSlicePlane::Values,
                    object_ref: object_ref(b"first-object"),
                    object_offset_bytes: 0,
                    plane_offset_bytes: 0,
                    byte_length: 24,
                    range_sha256: digest(&bytes),
                },
                DatasetSlicePart {
                    plane: DatasetSlicePlane::Values,
                    object_ref: object_ref(b"second-object"),
                    object_offset_bytes: 0,
                    plane_offset_bytes: 32,
                    byte_length: 24,
                    range_sha256: digest(&bytes),
                },
            ],
        };

        assert_eq!(
            response.validate(),
            Err(DatasetSliceError::PlaneCoverageGapOrOverlap(
                DatasetSlicePlane::Values
            ))
        );
    }
}
