//! Adapter from persisted tensor descriptors and CAS objects to bounded
//! dataset field slices.

use crate::{CasStore, TensorDescriptor, TensorDtype};
use fullmag_quantities::{
    is_canonical_sha256, ComplexEncoding, DatasetByteOrder, DatasetFieldSlice,
    DatasetFieldSliceRequest, DatasetNumericPrecision, DatasetSliceError, DatasetSlicePart,
    DatasetSlicePlane, HarmonicConvention, MAX_DATASET_SLICE_PARTS,
};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fmt;

pub struct TensorDatasetPlane<'a> {
    pub plane: DatasetSlicePlane,
    pub descriptor: &'a TensorDescriptor,
}

pub struct TensorDatasetField<'a> {
    pub field_layout_digest: &'a str,
    pub total_elements: u64,
    pub component_count: u32,
    pub complex_encoding: ComplexEncoding,
    pub harmonic_convention: Option<HarmonicConvention>,
    pub planes: Vec<TensorDatasetPlane<'a>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TensorDatasetSliceRead {
    pub manifest: DatasetFieldSlice,
    /// Exact ranges in the same order as `manifest.parts`.
    pub part_bytes: Vec<Vec<u8>>,
}

impl TensorDatasetSliceRead {
    pub fn decode(
        &self,
    ) -> Result<fullmag_quantities::DecodedDatasetFieldSlice, DatasetSliceError> {
        let parts = self
            .part_bytes
            .iter()
            .map(Vec::as_slice)
            .collect::<Vec<_>>();
        self.manifest.decode_part_bytes(&parts)
    }
}

pub fn read_tensor_dataset_slice(
    cas: &CasStore,
    request: &DatasetFieldSliceRequest,
    source: &TensorDatasetField<'_>,
) -> Result<TensorDatasetSliceRead, TensorDatasetSliceError> {
    request
        .validate()
        .map_err(TensorDatasetSliceError::SliceContract)?;
    if source.total_elements == 0 || source.component_count == 0 {
        return Err(TensorDatasetSliceError::InvalidFieldShape);
    }
    if !is_canonical_sha256(source.field_layout_digest) {
        return Err(TensorDatasetSliceError::SliceContract(
            DatasetSliceError::InvalidDigest("field_layout_digest"),
        ));
    }
    match (source.complex_encoding, source.harmonic_convention) {
        (ComplexEncoding::Real, Some(_)) => {
            return Err(TensorDatasetSliceError::SliceContract(
                DatasetSliceError::UnexpectedHarmonicConvention,
            ));
        }
        (ComplexEncoding::RealImagPair, None) => {
            return Err(TensorDatasetSliceError::SliceContract(
                DatasetSliceError::MissingHarmonicConvention,
            ));
        }
        _ => {}
    }

    let expected_planes: &[DatasetSlicePlane] = match source.complex_encoding {
        ComplexEncoding::Real => &[DatasetSlicePlane::Values],
        ComplexEncoding::RealImagPair => &[DatasetSlicePlane::Real, DatasetSlicePlane::Imaginary],
    };
    if source.planes.len() != expected_planes.len() {
        return Err(TensorDatasetSliceError::InvalidPlaneSet);
    }
    let mut unique_planes = BTreeSet::new();
    for plane in &source.planes {
        if !expected_planes.contains(&plane.plane) || !unique_planes.insert(plane.plane) {
            return Err(TensorDatasetSliceError::InvalidPlaneSet);
        }
    }

    let precision = source
        .planes
        .first()
        .ok_or(TensorDatasetSliceError::InvalidPlaneSet)
        .and_then(|plane| tensor_precision(plane.descriptor.dtype))?;
    let scalar_bytes = precision.byte_size();
    let scalar_count = source
        .total_elements
        .checked_mul(u64::from(source.component_count))
        .ok_or(TensorDatasetSliceError::SizeOverflow)?;
    let total_plane_bytes = scalar_count
        .checked_mul(scalar_bytes)
        .ok_or(TensorDatasetSliceError::SizeOverflow)?;
    let request_plane_start = request
        .element_offset
        .checked_mul(u64::from(source.component_count))
        .and_then(|value| value.checked_mul(scalar_bytes))
        .ok_or(TensorDatasetSliceError::SizeOverflow)?;
    let request_plane_bytes = request
        .element_count
        .checked_mul(u64::from(source.component_count))
        .and_then(|value| value.checked_mul(scalar_bytes))
        .ok_or(TensorDatasetSliceError::SizeOverflow)?;
    let request_plane_end = request_plane_start
        .checked_add(request_plane_bytes)
        .ok_or(TensorDatasetSliceError::SizeOverflow)?;
    if request_plane_end > total_plane_bytes {
        return Err(TensorDatasetSliceError::SliceContract(
            DatasetSliceError::ElementRangeOutsideField,
        ));
    }
    let payload_bytes = request_plane_bytes
        .checked_mul(expected_planes.len() as u64)
        .ok_or(TensorDatasetSliceError::SizeOverflow)?;
    if payload_bytes > request.max_response_bytes {
        return Err(TensorDatasetSliceError::SliceContract(
            DatasetSliceError::ResponseExceedsRequestBudget,
        ));
    }

    let mut parts = Vec::new();
    let mut part_bytes = Vec::new();
    for expected_plane in expected_planes {
        let plane = source
            .planes
            .iter()
            .find(|plane| plane.plane == *expected_plane)
            .ok_or(TensorDatasetSliceError::InvalidPlaneSet)?;
        validate_tensor_descriptor(plane.descriptor, precision, scalar_count, total_plane_bytes)?;
        append_plane_ranges(
            cas,
            *expected_plane,
            plane.descriptor,
            request_plane_start,
            request_plane_end,
            &mut parts,
            &mut part_bytes,
        )?;
    }

    let manifest = DatasetFieldSlice {
        schema_version: fullmag_quantities::DATASET_SLICE_SCHEMA_VERSION.to_string(),
        dataset: request.dataset.clone(),
        sample_id: request.sample_id.clone(),
        item_id: request.item_id.clone(),
        field_id: request.field_id.clone(),
        field_layout_digest: source.field_layout_digest.to_string(),
        element_offset: request.element_offset,
        element_count: request.element_count,
        total_elements: source.total_elements,
        component_count: source.component_count,
        precision,
        byte_order: DatasetByteOrder::LittleEndian,
        complex_encoding: source.complex_encoding,
        harmonic_convention: source.harmonic_convention,
        payload_bytes,
        parts,
    };
    manifest
        .validate_for_request(request)
        .map_err(TensorDatasetSliceError::SliceContract)?;
    let refs = part_bytes.iter().map(Vec::as_slice).collect::<Vec<_>>();
    manifest
        .validate_part_bytes(&refs)
        .map_err(TensorDatasetSliceError::SliceContract)?;
    Ok(TensorDatasetSliceRead {
        manifest,
        part_bytes,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TensorDatasetSliceError {
    SliceContract(DatasetSliceError),
    InvalidFieldShape,
    InvalidPlaneSet,
    UnsupportedTensorFormat,
    UnsupportedTensorDtype,
    UnsupportedTensorEndian,
    TensorShapeMismatch,
    TensorAxisMismatch,
    TensorPrecisionMismatch,
    TensorChunkCoverage,
    TensorChunkDigestMismatch,
    MissingCasObject(String),
    CasRead(String),
    SizeOverflow,
}

impl fmt::Display for TensorDatasetSliceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SliceContract(error) => write!(formatter, "dataset slice contract: {error}"),
            Self::InvalidFieldShape => {
                formatter.write_str("dataset tensor field shape must be non-empty")
            }
            Self::InvalidPlaneSet => formatter.write_str(
                "dataset tensor planes do not match the declared real or real/imag encoding",
            ),
            Self::UnsupportedTensorFormat => {
                formatter.write_str("dataset slicing requires fullmag.tensor.v1")
            }
            Self::UnsupportedTensorDtype => {
                formatter.write_str("dataset slicing supports only F32 and F64 tensors")
            }
            Self::UnsupportedTensorEndian => {
                formatter.write_str("dataset slicing supports only little-endian tensors")
            }
            Self::TensorShapeMismatch => formatter
                .write_str("tensor shape does not match field elements and component count"),
            Self::TensorAxisMismatch => formatter.write_str(
                "tensor name and logical axes must be non-empty, unique, and match the tensor rank",
            ),
            Self::TensorPrecisionMismatch => {
                formatter.write_str("all dataset tensor planes must use the same numeric precision")
            }
            Self::TensorChunkCoverage => formatter.write_str(
                "tensor chunks must be aligned, ordered, non-overlapping, and cover the tensor",
            ),
            Self::TensorChunkDigestMismatch => formatter.write_str(
                "tensor chunk checksum does not match its immutable CAS object identity",
            ),
            Self::MissingCasObject(object_ref) => {
                write!(formatter, "tensor CAS object '{object_ref}' is missing")
            }
            Self::CasRead(error) => write!(formatter, "tensor CAS read failed: {error}"),
            Self::SizeOverflow => formatter.write_str("dataset tensor slice size overflows"),
        }
    }
}

impl std::error::Error for TensorDatasetSliceError {}

fn tensor_precision(
    dtype: TensorDtype,
) -> Result<DatasetNumericPrecision, TensorDatasetSliceError> {
    match dtype {
        TensorDtype::F32 => Ok(DatasetNumericPrecision::F32),
        TensorDtype::F64 => Ok(DatasetNumericPrecision::F64),
        _ => Err(TensorDatasetSliceError::UnsupportedTensorDtype),
    }
}

fn validate_tensor_descriptor(
    descriptor: &TensorDescriptor,
    precision: DatasetNumericPrecision,
    expected_values: u64,
    expected_bytes: u64,
) -> Result<(), TensorDatasetSliceError> {
    if descriptor.format != "fullmag.tensor.v1" {
        return Err(TensorDatasetSliceError::UnsupportedTensorFormat);
    }
    if descriptor.endian != "little" {
        return Err(TensorDatasetSliceError::UnsupportedTensorEndian);
    }
    if tensor_precision(descriptor.dtype)? != precision {
        return Err(TensorDatasetSliceError::TensorPrecisionMismatch);
    }
    let unique_axes = descriptor
        .logical_axes
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    if descriptor.name.trim().is_empty()
        || descriptor.logical_axes.len() != descriptor.shape.len()
        || unique_axes.len() != descriptor.logical_axes.len()
        || unique_axes.iter().any(|axis| axis.trim().is_empty())
    {
        return Err(TensorDatasetSliceError::TensorAxisMismatch);
    }
    let values = descriptor
        .shape
        .iter()
        .try_fold(1_u64, |product, value| product.checked_mul(*value as u64));
    if values != Some(expected_values) {
        return Err(TensorDatasetSliceError::TensorShapeMismatch);
    }

    let scalar_bytes = precision.byte_size();
    let mut expected_offset = 0_u64;
    for chunk in &descriptor.chunks {
        let offset =
            u64::try_from(chunk.offset).map_err(|_| TensorDatasetSliceError::SizeOverflow)?;
        let length =
            u64::try_from(chunk.length).map_err(|_| TensorDatasetSliceError::SizeOverflow)?;
        if offset != expected_offset
            || length == 0
            || offset % scalar_bytes != 0
            || length % scalar_bytes != 0
        {
            return Err(TensorDatasetSliceError::TensorChunkCoverage);
        }
        if chunk
            .sha256
            .as_deref()
            .is_some_and(|checksum| checksum != chunk.object_ref)
        {
            return Err(TensorDatasetSliceError::TensorChunkDigestMismatch);
        }
        expected_offset = expected_offset
            .checked_add(length)
            .ok_or(TensorDatasetSliceError::SizeOverflow)?;
    }
    if expected_offset != expected_bytes {
        return Err(TensorDatasetSliceError::TensorChunkCoverage);
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn append_plane_ranges(
    cas: &CasStore,
    plane: DatasetSlicePlane,
    descriptor: &TensorDescriptor,
    request_start: u64,
    request_end: u64,
    parts: &mut Vec<DatasetSlicePart>,
    part_bytes: &mut Vec<Vec<u8>>,
) -> Result<(), TensorDatasetSliceError> {
    for chunk in &descriptor.chunks {
        let chunk_start = chunk.offset as u64;
        let chunk_end = chunk_start
            .checked_add(chunk.length as u64)
            .ok_or(TensorDatasetSliceError::SizeOverflow)?;
        let overlap_start = request_start.max(chunk_start);
        let overlap_end = request_end.min(chunk_end);
        if overlap_start >= overlap_end {
            continue;
        }
        if parts.len() >= MAX_DATASET_SLICE_PARTS {
            return Err(TensorDatasetSliceError::SliceContract(
                DatasetSliceError::PartCountOutOfRange,
            ));
        }
        let range_length = overlap_end - overlap_start;
        let object_start = overlap_start - chunk_start;
        let range = cas
            .get_verified_range(&chunk.object_ref, object_start, range_length, range_length)
            .map_err(|error| TensorDatasetSliceError::CasRead(error.to_string()))?
            .ok_or_else(|| TensorDatasetSliceError::MissingCasObject(chunk.object_ref.clone()))?;
        if range.object_length != chunk.length as u64 {
            return Err(TensorDatasetSliceError::TensorChunkCoverage);
        }
        let bytes = range.bytes;
        parts.push(DatasetSlicePart {
            plane,
            object_ref: chunk.object_ref.clone(),
            object_offset_bytes: object_start,
            plane_offset_bytes: overlap_start - request_start,
            byte_length: bytes.len() as u64,
            range_sha256: sha256_prefixed(&bytes),
        });
        part_bytes.push(bytes);
    }
    Ok(())
}

fn sha256_prefixed(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_quantities::{MaterializedDatasetRef, DATASET_SLICE_SCHEMA_VERSION};

    #[test]
    fn reads_exact_cross_chunk_range_and_decodes_it() {
        let directory = tempfile::tempdir().expect("temporary CAS");
        let cas = CasStore::open(directory.path().join("objects")).expect("open CAS");
        let first = [1.0_f64, 2.0_f64]
            .into_iter()
            .flat_map(f64::to_le_bytes)
            .collect::<Vec<_>>();
        let second = [3.0_f64, 4.0_f64]
            .into_iter()
            .flat_map(f64::to_le_bytes)
            .collect::<Vec<_>>();
        let first_ref = cas.put(&first).expect("put first chunk");
        let second_ref = cas.put(&second).expect("put second chunk");
        let descriptor = TensorDescriptor {
            format: "fullmag.tensor.v1".to_string(),
            name: "m".to_string(),
            dtype: TensorDtype::F64,
            shape: vec![4, 1],
            logical_axes: vec!["sample".to_string(), "component".to_string()],
            endian: "little".to_string(),
            chunks: vec![
                crate::TensorChunk {
                    object_ref: first_ref.clone(),
                    offset: 0,
                    length: first.len(),
                    sha256: Some(first_ref),
                },
                crate::TensorChunk {
                    object_ref: second_ref.clone(),
                    offset: first.len(),
                    length: second.len(),
                    sha256: Some(second_ref),
                },
            ],
        };
        let request = DatasetFieldSliceRequest {
            schema_version: DATASET_SLICE_SCHEMA_VERSION.to_string(),
            dataset: MaterializedDatasetRef {
                dataset_id: "dataset:1".to_string(),
                revision: 1,
            },
            sample_id: "sample:1".to_string(),
            item_id: "item:1".to_string(),
            field_id: "field:m".to_string(),
            element_offset: 1,
            element_count: 2,
            max_response_bytes: 16,
        };
        let field_layout_digest = format!("sha256:{}", "a".repeat(64));
        let field = TensorDatasetField {
            field_layout_digest: &field_layout_digest,
            total_elements: 4,
            component_count: 1,
            complex_encoding: ComplexEncoding::Real,
            harmonic_convention: None,
            planes: vec![TensorDatasetPlane {
                plane: DatasetSlicePlane::Values,
                descriptor: &descriptor,
            }],
        };

        let result = read_tensor_dataset_slice(&cas, &request, &field).expect("read slice");
        assert_eq!(result.manifest.parts.len(), 2);
        assert_eq!(result.manifest.payload_bytes, 16);
        assert_eq!(
            result.decode().expect("decode").planes[0].values,
            fullmag_quantities::DatasetNumericValues::F64(vec![2.0, 3.0])
        );
    }
}
