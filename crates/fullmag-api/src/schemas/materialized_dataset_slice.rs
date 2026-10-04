//! HTTP envelope metadata over the existing storage-neutral dataset slice.
use super::materialized_dataset::{
    descriptor_resource, pinned_source, MaterializedDatasetFieldDescriptorResource,
    MaterializedDatasetPinnedSourceResource, MaterializedDatasetPlaneResource,
};
use fullmag_quantities::{DatasetFieldSlice, DatasetNumericPrecision, DatasetSlicePlane};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

pub const MATERIALIZED_DATASET_SLICE_BINARY_SCHEMA: &str =
    "fullmag.binary.materialized_dataset_slice.v1";
pub const MAX_SLICE_ENVELOPE_METADATA_BYTES: usize = 1024 * 1024;

/// OpenAPI representation only; the handler returns raw FMDS bytes.
#[derive(ToSchema)]
#[schema(value_type = String, format = Binary)]
#[allow(dead_code)]
pub struct MaterializedDatasetSliceBinaryBody(Vec<u8>);

/// All counters use canonical decimal strings, including values above 2^53.
#[derive(Debug, Deserialize, IntoParams)]
#[serde(deny_unknown_fields)]
#[into_params(parameter_in = Query)]
pub struct MaterializedDatasetSliceQuery {
    pub schema_version: String,
    pub dataset_id: String,
    pub dataset_revision: String,
    pub sample_id: String,
    pub item_id: String,
    pub field_id: String,
    /// Bare lowercase SHA-256 CAS hash of the selected manifest.
    pub expected_manifest_object_ref: String,
    pub element_offset: String,
    pub element_count: String,
    /// Payload budget only; FMDS header and metadata add at most 1 MiB + 12 B.
    pub max_response_bytes: String,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum MaterializedDatasetSliceIntegrityResource {
    /// Manifest/root metadata and touched chunks, never the whole field.
    VerifiedReturnedRanges,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum MaterializedDatasetSlicePrecisionResource {
    F32,
    F64,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum MaterializedDatasetSliceByteOrderResource {
    LittleEndian,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct MaterializedDatasetSlicePartResource {
    pub plane: MaterializedDatasetPlaneResource,
    pub object_ref: String,
    pub object_offset_bytes: String,
    pub plane_offset_bytes: String,
    pub byte_length: String,
    pub range_sha256: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct MaterializedDatasetSliceManifestResource {
    pub schema_version: String,
    pub dataset_id: String,
    pub dataset_revision: String,
    pub sample_id: String,
    pub item_id: String,
    pub field_id: String,
    pub field_layout_digest: String,
    pub element_offset: String,
    pub element_count: String,
    pub total_elements: String,
    pub component_count: String,
    pub precision: MaterializedDatasetSlicePrecisionResource,
    pub byte_order: MaterializedDatasetSliceByteOrderResource,
    pub payload_bytes: String,
    /// Body ranges follow this order. Plane offsets are relative to this slice.
    pub parts: Vec<MaterializedDatasetSlicePartResource>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct MaterializedDatasetSliceEnvelopeResource {
    pub schema_version: String,
    pub project_id: String,
    pub run_id: String,
    pub solution_set_id: String,
    pub containing_solution_revision: String,
    pub member_id: String,
    pub artifact_id: String,
    pub manifest_object_ref: String,
    pub manifest_byte_length: String,
    pub integrity: MaterializedDatasetSliceIntegrityResource,
    pub source: MaterializedDatasetPinnedSourceResource,
    /// Complete quantity, units, layout, support and complex semantics.
    pub descriptor: MaterializedDatasetFieldDescriptorResource,
    pub slice: MaterializedDatasetSliceManifestResource,
}

impl MaterializedDatasetSliceEnvelopeResource {
    pub fn from_resolved(
        project_id: String,
        resolved: &fullmag_session::materialized_dataset::ResolvedMaterializedDatasetSlice,
    ) -> Self {
        let dataset = &resolved.dataset;
        let manifest = &dataset.manifest;
        Self {
            schema_version: MATERIALIZED_DATASET_SLICE_BINARY_SCHEMA.to_string(),
            project_id,
            run_id: manifest.field.source.run_id.clone(),
            solution_set_id: manifest.field.source.solution_set_id.clone(),
            containing_solution_revision: dataset.containing_solution_revision.to_string(),
            member_id: manifest.field.source.member_id.clone(),
            artifact_id: dataset.manifest_artifact.artifact_id.clone(),
            manifest_object_ref: dataset.manifest_artifact.object_ref.clone(),
            manifest_byte_length: dataset.manifest_artifact.byte_length.to_string(),
            integrity: MaterializedDatasetSliceIntegrityResource::VerifiedReturnedRanges,
            source: pinned_source(&manifest.field.source),
            descriptor: descriptor_resource(
                &manifest.dataset.samples[0].items[0].fields[0].descriptor,
            ),
            slice: slice_resource(&resolved.field.slice.manifest),
        }
    }
}

fn slice_resource(slice: &DatasetFieldSlice) -> MaterializedDatasetSliceManifestResource {
    MaterializedDatasetSliceManifestResource {
        schema_version: slice.schema_version.clone(),
        dataset_id: slice.dataset.dataset_id.clone(),
        dataset_revision: slice.dataset.revision.to_string(),
        sample_id: slice.sample_id.clone(),
        item_id: slice.item_id.clone(),
        field_id: slice.field_id.clone(),
        field_layout_digest: slice.field_layout_digest.clone(),
        element_offset: slice.element_offset.to_string(),
        element_count: slice.element_count.to_string(),
        total_elements: slice.total_elements.to_string(),
        component_count: slice.component_count.to_string(),
        precision: match slice.precision {
            DatasetNumericPrecision::F32 => MaterializedDatasetSlicePrecisionResource::F32,
            DatasetNumericPrecision::F64 => MaterializedDatasetSlicePrecisionResource::F64,
        },
        byte_order: MaterializedDatasetSliceByteOrderResource::LittleEndian,
        payload_bytes: slice.payload_bytes.to_string(),
        parts: slice
            .parts
            .iter()
            .map(|part| MaterializedDatasetSlicePartResource {
                plane: match part.plane {
                    DatasetSlicePlane::Values => MaterializedDatasetPlaneResource::Values,
                    DatasetSlicePlane::Real => MaterializedDatasetPlaneResource::Real,
                    DatasetSlicePlane::Imaginary => MaterializedDatasetPlaneResource::Imaginary,
                },
                object_ref: part.object_ref.clone(),
                object_offset_bytes: part.object_offset_bytes.to_string(),
                plane_offset_bytes: part.plane_offset_bytes.to_string(),
                byte_length: part.byte_length.to_string(),
                range_sha256: part.range_sha256.clone(),
            })
            .collect(),
    }
}
