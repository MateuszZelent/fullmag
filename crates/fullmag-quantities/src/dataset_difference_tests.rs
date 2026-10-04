use crate::dataset_difference::{
    compare_dataset_field_slices, dataset_comparison_digest, DatasetDifference,
    DatasetDifferenceError, DatasetDifferenceInput, DatasetDifferenceOperation,
    DatasetDifferenceOutputSemantics, DatasetDifferenceRequest, PinnedDatasetFieldSlice,
    DATASET_DIFFERENCE_SCHEMA_VERSION,
};
use crate::{
    ActiveSupportDescriptor, ComplexEncoding, DatasetAvailability, DatasetByteOrder,
    DatasetContractError, DatasetFieldDescriptor, DatasetFieldSlice, DatasetFieldSliceRequest,
    DatasetNumericPrecision, DatasetSliceError, DatasetSlicePart, DatasetSlicePlane, DatasetStatus,
    FieldFrameDescriptor, FieldFrameKind, FieldNormalization, FieldResolution, FieldSampleLocation,
    FieldValueRepresentation, HarmonicConvention, MaterializedDatasetRef, QuantityId,
    UnavailableAction, DATASET_SLICE_SCHEMA_VERSION,
};
use sha2::{Digest, Sha256};

struct Fixture {
    left_descriptor: DatasetFieldDescriptor,
    right_descriptor: DatasetFieldDescriptor,
    left_manifest: DatasetFieldSlice,
    right_manifest: DatasetFieldSlice,
    left_status: DatasetStatus,
    right_status: DatasetStatus,
    left_parts: Vec<Vec<u8>>,
    right_parts: Vec<Vec<u8>>,
    request: DatasetDifferenceRequest,
}

impl Fixture {
    fn compare(&self) -> Result<DatasetDifference, DatasetDifferenceError> {
        let left_parts = self
            .left_parts
            .iter()
            .map(Vec::as_slice)
            .collect::<Vec<_>>();
        let right_parts = self
            .right_parts
            .iter()
            .map(Vec::as_slice)
            .collect::<Vec<_>>();
        let left = DatasetDifferenceInput {
            manifest: &self.left_manifest,
            descriptor: &self.left_descriptor,
            status: &self.left_status,
            part_bytes: &left_parts,
        };
        let right = DatasetDifferenceInput {
            manifest: &self.right_manifest,
            descriptor: &self.right_descriptor,
            status: &self.right_status,
            part_bytes: &right_parts,
        };
        compare_dataset_field_slices(&self.request, &left, &right)
    }
}

fn digest_bytes(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn digest_text(value: &str) -> String {
    digest_bytes(value.as_bytes())
}

fn f32_bytes(values: &[f32]) -> Vec<u8> {
    values
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect()
}

fn f64_bytes(values: &[f64]) -> Vec<u8> {
    values
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect()
}

fn scalar_descriptor(
    encoding: ComplexEncoding,
    harmonic_convention: Option<HarmonicConvention>,
    layout_digest: String,
) -> DatasetFieldDescriptor {
    DatasetFieldDescriptor {
        quantity_id: QuantityId::M,
        unit: "1".to_string(),
        tensor_rank: 0,
        frame: FieldFrameDescriptor {
            kind: FieldFrameKind::Laboratory,
            frame_id: "frame:lab".to_string(),
        },
        sample_location: FieldSampleLocation::Global,
        active_support: ActiveSupportDescriptor {
            support_fingerprint: "support:global".to_string(),
            selection: None,
        },
        function_space: None,
        topology_id: "topology:global".to_string(),
        carrier_id: "carrier:global".to_string(),
        layout_digest,
        axes: Vec::new(),
        component_axis: None,
        complex_encoding: encoding,
        harmonic_convention,
        normalization: FieldNormalization::None,
        value_representation: FieldValueRepresentation::PhysicalField,
        modal_semantics: None,
        resolution: FieldResolution::Quantitative,
    }
}

fn ready_status() -> DatasetStatus {
    DatasetStatus {
        availability: DatasetAvailability::Ready,
        reason: None,
        actions: Vec::new(),
    }
}

fn unavailable_status() -> DatasetStatus {
    DatasetStatus {
        availability: DatasetAvailability::Missing,
        reason: Some("source payload is unavailable".to_string()),
        actions: vec![UnavailableAction::RepairOrRestoreArtifact],
    }
}

fn part_planes(encoding: ComplexEncoding) -> Vec<DatasetSlicePlane> {
    match encoding {
        ComplexEncoding::Real => vec![DatasetSlicePlane::Values],
        ComplexEncoding::RealImagPair => {
            vec![DatasetSlicePlane::Real, DatasetSlicePlane::Imaginary]
        }
    }
}

fn slice_manifest(
    dataset: &MaterializedDatasetRef,
    field_layout_digest: &str,
    precision: DatasetNumericPrecision,
    encoding: ComplexEncoding,
    harmonic_convention: Option<HarmonicConvention>,
    parts_bytes: &[Vec<u8>],
) -> DatasetFieldSlice {
    let planes = part_planes(encoding);
    let parts = parts_bytes
        .iter()
        .enumerate()
        .map(|(index, bytes)| DatasetSlicePart {
            plane: planes[index],
            object_ref: format!("{:064x}", index + 1),
            object_offset_bytes: 0,
            plane_offset_bytes: 0,
            byte_length: bytes.len() as u64,
            range_sha256: digest_bytes(bytes),
        })
        .collect::<Vec<_>>();
    DatasetFieldSlice {
        schema_version: DATASET_SLICE_SCHEMA_VERSION.to_string(),
        dataset: dataset.clone(),
        sample_id: "sample:global".to_string(),
        item_id: "item:global".to_string(),
        field_id: "field:m".to_string(),
        field_layout_digest: field_layout_digest.to_string(),
        element_offset: 0,
        element_count: 2,
        total_elements: 2,
        component_count: 1,
        precision,
        byte_order: DatasetByteOrder::LittleEndian,
        complex_encoding: encoding,
        harmonic_convention,
        payload_bytes: parts_bytes.iter().map(|bytes| bytes.len() as u64).sum(),
        parts,
    }
}

fn make_fixture(
    precision: DatasetNumericPrecision,
    encoding: ComplexEncoding,
    harmonic_convention: Option<HarmonicConvention>,
    left_parts: Vec<Vec<u8>>,
    right_parts: Vec<Vec<u8>>,
) -> Fixture {
    assert_eq!(left_parts.len(), right_parts.len());
    assert_eq!(left_parts.len(), part_planes(encoding).len());
    let payload_bytes: u64 = left_parts.iter().map(|bytes| bytes.len() as u64).sum();
    assert_eq!(
        payload_bytes,
        right_parts.iter().map(|bytes| bytes.len() as u64).sum::<u64>()
    );
    let dataset = MaterializedDatasetRef {
        dataset_id: "dataset:global-m".to_string(),
        revision: 7,
    };
    let layout_digest = digest_text("global-m-layout");
    let left_descriptor = scalar_descriptor(encoding, harmonic_convention, layout_digest.clone());
    let right_descriptor = left_descriptor.clone();
    let left_manifest = slice_manifest(
        &dataset,
        &layout_digest,
        precision,
        encoding,
        harmonic_convention,
        &left_parts,
    );
    let right_manifest = slice_manifest(
        &dataset,
        &layout_digest,
        precision,
        encoding,
        harmonic_convention,
        &right_parts,
    );
    let left_request = DatasetFieldSliceRequest {
        schema_version: DATASET_SLICE_SCHEMA_VERSION.to_string(),
        dataset: dataset.clone(),
        sample_id: "sample:global".to_string(),
        item_id: "item:global".to_string(),
        field_id: "field:m".to_string(),
        element_offset: 0,
        element_count: 2,
        max_response_bytes: payload_bytes,
    };
    let right_request = left_request.clone();
    let request = DatasetDifferenceRequest {
        schema_version: DATASET_DIFFERENCE_SCHEMA_VERSION.to_string(),
        left: PinnedDatasetFieldSlice {
            request: left_request,
            manifest_sha256: dataset_comparison_digest(&left_manifest).unwrap(),
            descriptor_sha256: dataset_comparison_digest(&left_descriptor).unwrap(),
        },
        right: PinnedDatasetFieldSlice {
            request: right_request,
            manifest_sha256: dataset_comparison_digest(&right_manifest).unwrap(),
            descriptor_sha256: dataset_comparison_digest(&right_descriptor).unwrap(),
        },
        max_output_bytes: payload_bytes,
        max_working_bytes: payload_bytes * 5,
    };
    Fixture {
        left_descriptor,
        right_descriptor,
        left_manifest,
        right_manifest,
        left_status: ready_status(),
        right_status: ready_status(),
        left_parts,
        right_parts,
        request,
    }
}

fn real_f64_fixture(left: &[f64], right: &[f64]) -> Fixture {
    make_fixture(
        DatasetNumericPrecision::F64,
        ComplexEncoding::Real,
        None,
        vec![f64_bytes(left)],
        vec![f64_bytes(right)],
    )
}

fn complex_f32_fixture(
    left_real: &[f32],
    left_imaginary: &[f32],
    right_real: &[f32],
    right_imaginary: &[f32],
) -> Fixture {
    make_fixture(
        DatasetNumericPrecision::F32,
        ComplexEncoding::RealImagPair,
        Some(HarmonicConvention::ExpPositiveIOmegaT),
        vec![f32_bytes(left_real), f32_bytes(left_imaginary)],
        vec![f32_bytes(right_real), f32_bytes(right_imaginary)],
    )
}

#[test]
fn signed_f64_difference_is_left_minus_right_and_pins_sources() {
    let fixture = real_f64_fixture(&[3.0, -2.5], &[1.0, -4.0]);
    let result = fixture.compare().expect("valid signed difference");
    let expected = f64_bytes(&[2.0, 1.5]);

    assert_eq!(
        result.receipt.operation,
        DatasetDifferenceOperation::LeftMinusRight
    );
    assert_eq!(result.plane_bytes, vec![expected.clone()]);
    assert_eq!(
        result.receipt.output_semantics,
        DatasetDifferenceOutputSemantics::UnnormalizedSignedDifference
    );
    assert_eq!(result.receipt.planes[0].plane, DatasetSlicePlane::Values);
    assert_eq!(result.receipt.planes[0].byte_length, expected.len() as u64);
    assert_eq!(result.receipt.planes[0].sha256, digest_bytes(&expected));
    assert_eq!(result.receipt.payload_bytes, 16);
    assert_eq!(result.receipt.accounted_working_bytes, 80);
    assert_eq!(
        result.receipt.left.manifest_sha256,
        dataset_comparison_digest(&fixture.left_manifest).unwrap()
    );
    assert_eq!(
        result.receipt.left.descriptor_sha256,
        dataset_comparison_digest(&fixture.left_descriptor).unwrap()
    );
    assert_eq!(
        result.receipt.right.manifest_sha256,
        dataset_comparison_digest(&fixture.right_manifest).unwrap()
    );
    assert_eq!(
        result.receipt.right.descriptor_sha256,
        dataset_comparison_digest(&fixture.right_descriptor).unwrap()
    );
}

#[test]
fn f32_complex_difference_keeps_real_imag_planes_and_harmonic_convention() {
    let fixture = complex_f32_fixture(&[3.0, -2.0], &[5.0, -8.0], &[1.0, 4.0], &[1.0, -3.0]);
    let result = fixture.compare().expect("valid complex difference");

    assert_eq!(
        result.plane_bytes,
        vec![f32_bytes(&[2.0, -6.0]), f32_bytes(&[4.0, -5.0])]
    );
    assert_eq!(
        result
            .receipt
            .planes
            .iter()
            .map(|plane| plane.plane)
            .collect::<Vec<_>>(),
        vec![DatasetSlicePlane::Real, DatasetSlicePlane::Imaginary]
    );
    assert_eq!(
        result.receipt.input_descriptor.harmonic_convention,
        Some(HarmonicConvention::ExpPositiveIOmegaT)
    );
    assert_eq!(result.receipt.precision, DatasetNumericPrecision::F32);
    assert_eq!(result.receipt.total_elements, 2);
}

#[test]
fn stale_revision_checksum_hash_and_descriptor_are_rejected() {
    let mut stale_revision = real_f64_fixture(&[3.0, 4.0], &[1.0, 2.0]);
    stale_revision.left_manifest.dataset.revision = 8;
    stale_revision.request.left.request.dataset.revision = 8;
    assert_eq!(
        stale_revision.compare(),
        Err(DatasetDifferenceError::SourceIdentityMismatch)
    );

    let mut stale_checksum = real_f64_fixture(&[3.0, 4.0], &[1.0, 2.0]);
    stale_checksum.left_parts[0][0] ^= 1;
    assert_eq!(
        stale_checksum.compare(),
        Err(DatasetDifferenceError::Slice(
            DatasetSliceError::PartChecksumMismatch
        ))
    );

    let mut stale_hash = real_f64_fixture(&[3.0, 4.0], &[1.0, 2.0]);
    stale_hash.request.left.manifest_sha256 = digest_text("stale-manifest");
    assert_eq!(
        stale_hash.compare(),
        Err(DatasetDifferenceError::SourceIdentityMismatch)
    );

    let mut stale_descriptor = real_f64_fixture(&[3.0, 4.0], &[1.0, 2.0]);
    stale_descriptor.left_descriptor.frame.frame_id = "frame:stale".to_string();
    assert_eq!(
        stale_descriptor.compare(),
        Err(DatasetDifferenceError::SourceIdentityMismatch)
    );
}

#[test]
fn wrong_unit_layout_preview_and_unavailable_inputs_are_rejected() {
    let mut wrong_unit = real_f64_fixture(&[3.0, 4.0], &[1.0, 2.0]);
    wrong_unit.right_descriptor.unit = "A".to_string();
    wrong_unit.request.right.descriptor_sha256 =
        dataset_comparison_digest(&wrong_unit.right_descriptor).unwrap();
    assert_eq!(
        wrong_unit.compare(),
        Err(DatasetDifferenceError::Contract(
            DatasetContractError::IncompatibleFieldSemantics
        ))
    );

    let mut wrong_layout = real_f64_fixture(&[3.0, 4.0], &[1.0, 2.0]);
    wrong_layout.right_descriptor.layout_digest = digest_text("other-layout");
    wrong_layout.right_manifest.field_layout_digest =
        wrong_layout.right_descriptor.layout_digest.clone();
    wrong_layout.request.right.manifest_sha256 =
        dataset_comparison_digest(&wrong_layout.right_manifest).unwrap();
    wrong_layout.request.right.descriptor_sha256 =
        dataset_comparison_digest(&wrong_layout.right_descriptor).unwrap();
    assert_eq!(
        wrong_layout.compare(),
        Err(DatasetDifferenceError::Contract(
            DatasetContractError::ProjectionRequired
        ))
    );

    let mut preview = real_f64_fixture(&[3.0, 4.0], &[1.0, 2.0]);
    preview.right_descriptor.resolution = FieldResolution::PreviewOnly;
    preview.request.right.descriptor_sha256 =
        dataset_comparison_digest(&preview.right_descriptor).unwrap();
    preview.right_parts[0] = vec![0];
    assert_eq!(preview.compare(), Err(DatasetDifferenceError::PreviewInput));

    let mut unavailable = real_f64_fixture(&[3.0, 4.0], &[1.0, 2.0]);
    unavailable.left_status = unavailable_status();
    unavailable.left_parts[0] = vec![0];
    assert_eq!(
        unavailable.compare(),
        Err(DatasetDifferenceError::UnavailableInput)
    );
}

#[test]
fn output_and_aggregate_working_budgets_fail_before_payload_decode() {
    let mut output_budget = real_f64_fixture(&[3.0, 4.0], &[1.0, 2.0]);
    output_budget.request.max_output_bytes = 8;
    output_budget.left_parts[0] = vec![0];
    assert_eq!(
        output_budget.compare(),
        Err(DatasetDifferenceError::BudgetExceeded)
    );

    let mut aggregate_budget = real_f64_fixture(&[3.0, 4.0], &[1.0, 2.0]);
    aggregate_budget.request.max_working_bytes = 79;
    aggregate_budget.left_parts[0] = vec![0];
    assert_eq!(
        aggregate_budget.request.validate_read_budget(),
        Err(DatasetDifferenceError::BudgetExceeded)
    );
    assert_eq!(
        aggregate_budget.compare(),
        Err(DatasetDifferenceError::BudgetExceeded)
    );
}

#[test]
fn nonfinite_difference_and_input_range_overflow_fail_closed() {
    let overflow_difference = real_f64_fixture(&[f64::MAX, 0.0], &[-f64::MAX, 0.0]);
    assert_eq!(
        overflow_difference.compare(),
        Err(DatasetDifferenceError::NonFiniteDifference {
            plane: DatasetSlicePlane::Values,
            index: 0,
        })
    );

    let nonfinite_payload = real_f64_fixture(&[f64::NAN, 0.0], &[1.0, 2.0]);
    assert_eq!(
        nonfinite_payload.compare(),
        Err(DatasetDifferenceError::Slice(
            DatasetSliceError::NonFinitePayloadValue {
                plane: DatasetSlicePlane::Values,
                value_index: 0,
            }
        ))
    );

    let mut range_overflow = real_f64_fixture(&[3.0, 4.0], &[1.0, 2.0]);
    range_overflow.request.left.request.element_offset = u64::MAX;
    range_overflow.request.right.request.element_offset = u64::MAX;
    range_overflow.left_parts[0] = vec![0];
    assert_eq!(
        range_overflow.compare(),
        Err(DatasetDifferenceError::Slice(
            DatasetSliceError::ElementRangeOverflow
        ))
    );
}

#[test]
fn normalized_inputs_produce_an_explicitly_unnormalized_difference() {
    let mut fixture = real_f64_fixture(&[1.0, 0.5], &[-1.0, -0.5]);
    fixture.left_descriptor.normalization = FieldNormalization::MaxAbs;
    fixture.right_descriptor.normalization = FieldNormalization::MaxAbs;
    fixture.request.left.descriptor_sha256 =
        dataset_comparison_digest(&fixture.left_descriptor).unwrap();
    fixture.request.right.descriptor_sha256 =
        dataset_comparison_digest(&fixture.right_descriptor).unwrap();
    let result = fixture.compare().expect("normalized source difference");
    assert_eq!(result.plane_bytes, vec![f64_bytes(&[2.0, 1.0])]);
    assert_eq!(
        result.receipt.input_descriptor.normalization,
        FieldNormalization::MaxAbs
    );
    assert_eq!(
        result.receipt.output_semantics,
        DatasetDifferenceOutputSemantics::UnnormalizedSignedDifference
    );
}

#[test]
fn metadata_digest_refuses_oversized_serialization() {
    let oversized =
        "x".repeat(crate::dataset_difference::MAX_DATASET_DIFFERENCE_METADATA_BYTES + 1);
    assert_eq!(
        dataset_comparison_digest(&oversized),
        Err(DatasetDifferenceError::MetadataBudgetExceeded)
    );
}
