//! Immutable dataset-field bindings for persisted solution tensors.
//!
//! A binding is metadata carried by a tensor descriptor.  It identifies the
//! dataset row and the exact field semantics without copying a dataset
//! manifest or introducing another CAS root.  The tensor descriptor's own
//! content hash therefore remains the integrity boundary for this metadata.

use anyhow::{bail, Context, Result};
use fullmag_quantities::{
    ComplexEncoding, DatasetFieldDescriptor, DatasetFieldSliceRequest, DatasetSlicePlane,
    FunctionSpaceOrdering, MaterializedDatasetRef,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

use crate::dataset_slice_adapter::{
    read_tensor_dataset_slice, TensorDatasetField, TensorDatasetPlane, TensorDatasetSliceRead,
};
use crate::solution_tensor_source::{
    resolve_solution_tensor, PinnedSolutionTensorSource, ResolvedSolutionTensor,
    SOLUTION_TENSOR_SCHEMA,
};
use crate::{SessionStore, TensorDescriptor, TensorDtype};

pub const TENSOR_FIELD_BINDING_SCHEMA: &str = "fullmag.tensor_field_binding.v1";
const MAX_BINDING_ID_LENGTH: usize = 1024;

/// Immutable metadata connecting one tensor root to one materialized dataset
/// field and one returned slice plane.
///
/// The binding intentionally contains no CAS references.  Dataset manifests,
/// units, quantity identity, frame, and producer qualification remain owned by
/// the typed descriptor and the producer's immutable root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TensorFieldBinding {
    pub format: String,
    pub dataset: MaterializedDatasetRef,
    pub sample_id: String,
    pub item_id: String,
    pub field_id: String,
    pub group_id: String,
    pub producer_id: String,
    pub producer_version: String,
    pub plane: DatasetSlicePlane,
    pub descriptor: DatasetFieldDescriptor,
}

impl TensorFieldBinding {
    /// Validate the binding against the immutable tensor root that carries it.
    pub fn validate_for_tensor(&self, tensor: &TensorDescriptor) -> Result<()> {
        if self.format != TENSOR_FIELD_BINDING_SCHEMA {
            bail!("unsupported tensor field binding format `{}`", self.format);
        }
        validate_id("dataset_id", &self.dataset.dataset_id)?;
        if self.dataset.revision == 0 {
            bail!("tensor field binding dataset revision must be positive");
        }
        validate_id("sample_id", &self.sample_id)?;
        validate_id("item_id", &self.item_id)?;
        validate_id("field_id", &self.field_id)?;
        validate_id("group_id", &self.group_id)?;
        validate_id("producer_id", &self.producer_id)?;
        validate_id("producer_version", &self.producer_version)?;

        // This validates all descriptor-owned semantics while deliberately
        // refusing to infer or rewrite units, quantities, frames, or status.
        self.descriptor
            .validate()
            .context("invalid tensor field binding descriptor")?;
        if !fullmag_quantities::is_canonical_sha256(&self.descriptor.layout_digest) {
            bail!("tensor field binding layout digest is not canonical SHA-256");
        }
        if self
            .descriptor
            .function_space
            .as_ref()
            .is_some_and(|space| {
                matches!(
                    space.ordering,
                    FunctionSpaceOrdering::ByComponent | FunctionSpaceOrdering::NativeWithMapping
                )
            })
        {
            bail!("tensor field binding cannot reorder component or native-mapped tensors");
        }

        if tensor.format != SOLUTION_TENSOR_SCHEMA {
            bail!("tensor field binding requires `{SOLUTION_TENSOR_SCHEMA}`");
        }
        if tensor.endian != "little" {
            bail!("tensor field binding requires little-endian tensor bytes");
        }
        if !matches!(tensor.dtype, TensorDtype::F32 | TensorDtype::F64) {
            bail!("tensor field binding supports only F32 and F64 tensors");
        }
        validate_tensor_axes(tensor)?;

        let elements = tensor
            .shape
            .first()
            .copied()
            .filter(|elements| *elements > 0)
            .context("tensor field binding requires positive element count")?;
        let components = if self.descriptor.tensor_rank == 0 {
            if self.descriptor.component_axis.is_some()
                || self.descriptor.axes.len() != 1
                || tensor.shape.len() != 1
                || tensor.logical_axes.len() != 1
            {
                bail!("scalar tensor field binding has incompatible axes or shape");
            }
            let element_axis = &self.descriptor.axes[0];
            if element_axis.axis_id != tensor.logical_axes[0]
                || element_axis.length
                    != u64::try_from(elements).context("tensor element count exceeds u64")?
            {
                bail!("scalar tensor field binding axes do not match tensor shape");
            }
            1_u64
        } else if self.descriptor.tensor_rank == 1 {
            let component_axis = self
                .descriptor
                .component_axis
                .as_deref()
                .context("tensor field binding has no component axis")?;
            let component_descriptor = self
                .descriptor
                .axes
                .iter()
                .find(|axis| axis.axis_id == component_axis)
                .context("tensor field binding component axis is missing")?;
            if self.descriptor.axes.len() != tensor.logical_axes.len()
                || tensor.shape.len() != 2
                || tensor.logical_axes.len() != 2
                || tensor.logical_axes.last().map(String::as_str) != Some(component_axis)
            {
                bail!("tensor field binding component axis must be the final tensor axis");
            }
            for (axis, (logical_axis, length)) in self
                .descriptor
                .axes
                .iter()
                .zip(tensor.logical_axes.iter().zip(tensor.shape.iter()))
            {
                if axis.axis_id != *logical_axis
                    || axis.length
                        != u64::try_from(*length).context("tensor axis length exceeds u64")?
                {
                    bail!("tensor field binding axes do not match tensor shape");
                }
            }
            let components = component_descriptor.length;
            if components == 0
                || u64::try_from(tensor.shape[1]).context("tensor component count exceeds u64")?
                    != components
            {
                bail!("tensor field binding component length does not match tensor shape");
            }
            components
        } else {
            bail!("tensor field binding supports only scalar or rank-one component fields");
        };
        if tensor.shape[0] != elements || components == 0 {
            bail!("tensor field binding tensor shape is empty or inconsistent");
        }
        u32::try_from(components).context("tensor field binding component count exceeds u32")?;

        match (
            self.descriptor.complex_encoding,
            self.descriptor.harmonic_convention,
        ) {
            (ComplexEncoding::Real, None) => {}
            (ComplexEncoding::Real, Some(_)) => {
                bail!("real tensor field binding cannot carry a harmonic convention")
            }
            (ComplexEncoding::RealImagPair, Some(_)) => {}
            (ComplexEncoding::RealImagPair, None) => {
                bail!("real/imaginary tensor field binding requires a harmonic convention")
            }
        }

        match (self.descriptor.complex_encoding, self.plane) {
            (ComplexEncoding::Real, DatasetSlicePlane::Values) => {}
            (ComplexEncoding::Real, _) => {
                bail!("real tensor field bindings must use the values plane")
            }
            (ComplexEncoding::RealImagPair, DatasetSlicePlane::Real)
            | (ComplexEncoding::RealImagPair, DatasetSlicePlane::Imaginary) => {}
            (ComplexEncoding::RealImagPair, DatasetSlicePlane::Values) => {
                bail!("real/imaginary tensor field bindings cannot use the values plane")
            }
        }
        Ok(())
    }
}

/// The bounded tensor data plus the immutable owner records that supplied it.
/// Owner metadata is preserved so callers cannot replace execution status or
/// scientific assessment with a locally inferred value.
pub struct ResolvedSolutionFieldSlice {
    pub slice: TensorDatasetSliceRead,
    pub owners: Vec<ResolvedSolutionTensor>,
}

/// Resolve one real tensor or a real/imaginary pair through pinned solution
/// roots and read an exact bounded dataset slice from their CAS objects.
pub fn read_pinned_solution_field_slice(
    store: &SessionStore,
    request: &DatasetFieldSliceRequest,
    sources: &[PinnedSolutionTensorSource],
) -> Result<ResolvedSolutionFieldSlice> {
    request
        .validate()
        .context("invalid pinned solution field slice request")?;
    if !(sources.len() == 1 || sources.len() == 2) {
        bail!("a pinned solution field slice requires one or two tensor roots");
    }

    let mut owners = Vec::with_capacity(sources.len());
    for source in sources {
        let owner = resolve_solution_tensor(store, source).with_context(|| {
            format!(
                "resolving pinned tensor root `{}`",
                source.tensor_object_ref
            )
        })?;
        let binding = owner
            .tensor
            .field_binding
            .as_ref()
            .context("pinned tensor root has no immutable field binding")?;
        binding.validate_for_tensor(&owner.tensor)?;
        validate_request_identity(request, binding)?;
        owners.push(owner);
    }

    validate_binding_group(&owners)?;
    validate_owner_group(&owners)?;

    let first_binding = owners[0]
        .tensor
        .field_binding
        .as_ref()
        .context("pinned tensor root lost its field binding")?;
    let planes = owners
        .iter()
        .map(|owner| {
            let binding = owner
                .tensor
                .field_binding
                .as_ref()
                .expect("validated tensor field binding remains present");
            TensorDatasetPlane {
                plane: binding.plane,
                descriptor: &owner.tensor,
            }
        })
        .collect::<Vec<_>>();
    let field = TensorDatasetField {
        field_layout_digest: &first_binding.descriptor.layout_digest,
        total_elements: u64::try_from(owners[0].tensor.shape[0])
            .context("tensor element count exceeds u64")?,
        component_count: tensor_component_count(first_binding)?,
        complex_encoding: first_binding.descriptor.complex_encoding,
        harmonic_convention: first_binding.descriptor.harmonic_convention,
        planes,
    };
    let slice = read_tensor_dataset_slice(store.cas(), request, &field)
        .map_err(|error| anyhow::anyhow!("reading pinned solution field slice: {error}"))?;
    Ok(ResolvedSolutionFieldSlice { slice, owners })
}

fn validate_request_identity(
    request: &DatasetFieldSliceRequest,
    binding: &TensorFieldBinding,
) -> Result<()> {
    if request.dataset != binding.dataset
        || request.sample_id != binding.sample_id
        || request.item_id != binding.item_id
        || request.field_id != binding.field_id
    {
        bail!("pinned field slice request does not match immutable tensor binding");
    }
    Ok(())
}

fn validate_owner_group(owners: &[ResolvedSolutionTensor]) -> Result<()> {
    let first = &owners[0].source;
    for owner in owners.iter().skip(1) {
        let source = &owner.source;
        if source.run_id != first.run_id
            || source.solution_set_id != first.solution_set_id
            || source.solution_revision != first.solution_revision
            || source.member_id != first.member_id
            || source.run_spec_digest != first.run_spec_digest
        {
            bail!("paired tensor roots do not share one pinned solution owner");
        }
        if source.tensor_object_ref == first.tensor_object_ref
            || source.artifact_id == first.artifact_id
        {
            bail!("paired tensor roots must have distinct artifacts and descriptor roots");
        }
        if owner.artifact.accepted_state != owners[0].artifact.accepted_state {
            bail!("paired tensor roots must share the same accepted state carrier");
        }
        if owner.tensor.shape != owners[0].tensor.shape
            || owner.tensor.logical_axes != owners[0].tensor.logical_axes
            || owner.tensor.dtype != owners[0].tensor.dtype
            || owner.tensor.format != owners[0].tensor.format
            || owner.tensor.endian != owners[0].tensor.endian
        {
            bail!("paired tensor roots must share exact tensor shape, axes and precision");
        }
    }
    Ok(())
}

fn validate_binding_group(owners: &[ResolvedSolutionTensor]) -> Result<()> {
    let bindings = owners
        .iter()
        .map(|owner| {
            owner
                .tensor
                .field_binding
                .as_ref()
                .context("pinned tensor root has no field binding")
        })
        .collect::<Result<Vec<_>>>()?;
    let first = bindings[0];
    if owners.len() == 1 {
        if first.descriptor.complex_encoding != ComplexEncoding::Real
            || first.plane != DatasetSlicePlane::Values
        {
            bail!("a real/imaginary tensor field requires both planes");
        }
        return Ok(());
    }
    if first.descriptor.complex_encoding != ComplexEncoding::RealImagPair {
        bail!("two tensor roots are allowed only for a real/imaginary field");
    }
    let mut planes = BTreeSet::new();
    for binding in &bindings {
        if !same_binding_identity(first, binding) || !planes.insert(binding.plane) {
            bail!("paired tensor field bindings have conflicting identity or planes");
        }
    }
    if planes != BTreeSet::from([DatasetSlicePlane::Real, DatasetSlicePlane::Imaginary]) {
        bail!("paired tensor field bindings must contain exactly real and imaginary planes");
    }
    Ok(())
}

fn same_binding_identity(left: &TensorFieldBinding, right: &TensorFieldBinding) -> bool {
    left.format == right.format
        && left.dataset == right.dataset
        && left.sample_id == right.sample_id
        && left.item_id == right.item_id
        && left.field_id == right.field_id
        && left.group_id == right.group_id
        && left.producer_id == right.producer_id
        && left.producer_version == right.producer_version
        && left.descriptor == right.descriptor
}

fn tensor_component_count(binding: &TensorFieldBinding) -> Result<u32> {
    if binding.descriptor.tensor_rank == 0 {
        return Ok(1);
    }
    let axis = binding
        .descriptor
        .component_axis
        .as_deref()
        .context("tensor field binding has no component axis")?;
    let length = binding
        .descriptor
        .axes
        .iter()
        .find(|axis_descriptor| axis_descriptor.axis_id == axis)
        .context("tensor field binding component axis is missing")?
        .length;
    u32::try_from(length).context("tensor field binding component count exceeds u32")
}

fn validate_tensor_axes(tensor: &TensorDescriptor) -> Result<()> {
    if tensor.logical_axes.len() != tensor.shape.len() || tensor.logical_axes.is_empty() {
        bail!("tensor field binding tensor axes do not match tensor rank");
    }
    let mut axes = BTreeSet::new();
    for axis in &tensor.logical_axes {
        validate_id("tensor axis", axis)?;
        if !axes.insert(axis) {
            bail!("tensor field binding tensor axes must be unique");
        }
    }
    Ok(())
}

fn validate_id(field: &str, value: &str) -> Result<()> {
    if value.trim().is_empty()
        || value.len() > MAX_BINDING_ID_LENGTH
        || value.chars().any(char::is_control)
    {
        bail!("tensor field binding {field} is empty, too long or contains controls");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{FmsRunIntent, TensorChunk};
    use fullmag_quantities::{
        ActiveSupportDescriptor, DatasetFieldDescriptor, FieldAxisDescriptor, FieldFrameDescriptor,
        FieldFrameKind, FieldNormalization, FieldResolution, FieldSampleLocation,
        FieldValueRepresentation, HarmonicConvention, MaterializedDatasetRef, QuantityId,
    };
    use serde_json::json;

    fn digest(letter: char) -> String {
        format!("sha256:{}", letter.to_string().repeat(64))
    }

    fn scalar_descriptor() -> DatasetFieldDescriptor {
        DatasetFieldDescriptor {
            quantity_id: QuantityId::ETotal,
            unit: "J".to_string(),
            tensor_rank: 0,
            frame: FieldFrameDescriptor {
                kind: FieldFrameKind::Laboratory,
                frame_id: "frame:lab".to_string(),
            },
            sample_location: FieldSampleLocation::Global,
            active_support: ActiveSupportDescriptor {
                support_fingerprint: "support:all".to_string(),
                selection: None,
            },
            function_space: None,
            topology_id: "topology:global".to_string(),
            carrier_id: "carrier:global".to_string(),
            layout_digest: digest('a'),
            axes: vec![FieldAxisDescriptor {
                axis_id: "element".to_string(),
                unit: "1".to_string(),
                length: 2,
            }],
            component_axis: None,
            complex_encoding: ComplexEncoding::Real,
            harmonic_convention: None,
            normalization: FieldNormalization::None,
            value_representation: FieldValueRepresentation::PhysicalField,
            modal_semantics: None,
            resolution: FieldResolution::Quantitative,
        }
    }

    fn vector_pair_descriptor() -> DatasetFieldDescriptor {
        DatasetFieldDescriptor {
            quantity_id: QuantityId::M,
            unit: "1".to_string(),
            tensor_rank: 1,
            frame: FieldFrameDescriptor {
                kind: FieldFrameKind::Laboratory,
                frame_id: "frame:lab".to_string(),
            },
            sample_location: FieldSampleLocation::Global,
            active_support: ActiveSupportDescriptor {
                support_fingerprint: "support:all".to_string(),
                selection: None,
            },
            function_space: None,
            topology_id: "topology:global".to_string(),
            carrier_id: "carrier:global".to_string(),
            layout_digest: digest('a'),
            axes: vec![
                FieldAxisDescriptor {
                    axis_id: "element".to_string(),
                    unit: "1".to_string(),
                    length: 2,
                },
                FieldAxisDescriptor {
                    axis_id: "component".to_string(),
                    unit: "1".to_string(),
                    length: 3,
                },
            ],
            component_axis: Some("component".to_string()),
            complex_encoding: ComplexEncoding::RealImagPair,
            harmonic_convention: Some(HarmonicConvention::ExpPositiveIOmegaT),
            normalization: FieldNormalization::None,
            value_representation: FieldValueRepresentation::PhysicalField,
            modal_semantics: None,
            resolution: FieldResolution::Quantitative,
        }
    }

    fn binding(descriptor: DatasetFieldDescriptor, plane: DatasetSlicePlane) -> TensorFieldBinding {
        TensorFieldBinding {
            format: TENSOR_FIELD_BINDING_SCHEMA.to_string(),
            dataset: MaterializedDatasetRef {
                dataset_id: "dataset:field".to_string(),
                revision: 1,
            },
            sample_id: "sample:one".to_string(),
            item_id: "item:one".to_string(),
            field_id: "field:m".to_string(),
            group_id: "group:field".to_string(),
            producer_id: "producer:test".to_string(),
            producer_version: "v1".to_string(),
            plane,
            descriptor,
        }
    }

    fn scalar_tensor(binding: Option<TensorFieldBinding>) -> TensorDescriptor {
        TensorDescriptor {
            format: SOLUTION_TENSOR_SCHEMA.to_string(),
            name: "m".to_string(),
            dtype: TensorDtype::F64,
            shape: vec![2],
            logical_axes: vec!["element".to_string()],
            endian: "little".to_string(),
            chunks: Vec::new(),
            field_binding: binding,
        }
    }

    fn vector_tensor(binding: Option<TensorFieldBinding>, name: &str) -> TensorDescriptor {
        TensorDescriptor {
            format: SOLUTION_TENSOR_SCHEMA.to_string(),
            name: name.to_string(),
            dtype: TensorDtype::F32,
            shape: vec![2, 3],
            logical_axes: vec!["element".to_string(), "component".to_string()],
            endian: "little".to_string(),
            chunks: Vec::new(),
            field_binding: binding,
        }
    }

    #[test]
    fn real_scalar_binding_requires_exact_scalar_shape_and_axes() {
        let valid = binding(scalar_descriptor(), DatasetSlicePlane::Values);
        assert!(valid
            .validate_for_tensor(&scalar_tensor(Some(valid.clone())))
            .is_ok());

        let mut wrong_shape = scalar_tensor(Some(valid.clone()));
        wrong_shape.shape = vec![2, 1];
        wrong_shape.logical_axes = vec!["element".to_string(), "component".to_string()];
        assert!(valid.validate_for_tensor(&wrong_shape).is_err());

        let mut wrong_axis = scalar_tensor(Some(valid.clone()));
        wrong_axis.logical_axes = vec!["element".to_string(), "component".to_string()];
        wrong_axis.shape = vec![2, 1];
        assert!(valid.validate_for_tensor(&wrong_axis).is_err());
    }

    #[test]
    fn pair_roles_and_identity_are_strict() {
        let descriptor = vector_pair_descriptor();
        let real = binding(descriptor.clone(), DatasetSlicePlane::Real);
        let imaginary = binding(descriptor.clone(), DatasetSlicePlane::Imaginary);
        assert!(real
            .validate_for_tensor(&vector_tensor(Some(real.clone()), "real"))
            .is_ok());
        assert!(imaginary
            .validate_for_tensor(&vector_tensor(Some(imaginary.clone()), "imaginary"))
            .is_ok());

        let real_owner = fake_owner(vector_tensor(Some(real.clone()), "real"), "real");
        let imaginary_owner = fake_owner(
            vector_tensor(Some(imaginary.clone()), "imaginary"),
            "imaginary",
        );
        let pair = [real_owner, imaginary_owner];
        assert!(validate_binding_group(&pair).is_ok());
        assert!(validate_owner_group(&pair).is_ok());

        let mut bad_plane = real.clone();
        bad_plane.plane = DatasetSlicePlane::Values;
        assert!(bad_plane
            .validate_for_tensor(&vector_tensor(Some(bad_plane.clone()), "values"))
            .is_err());

        let mut foreign_group = imaginary.clone();
        foreign_group.group_id = "group:foreign".to_string();
        let foreign_owner = fake_owner(
            vector_tensor(Some(foreign_group.clone()), "imaginary"),
            "imaginary-foreign",
        );
        let real_owner = fake_owner(vector_tensor(Some(real), "real"), "real-again");
        let mut invalid_pair = [real_owner, foreign_owner];
        assert!(validate_binding_group(&invalid_pair).is_err());

        let mut transposed_owner = fake_owner(
            vector_tensor(Some(imaginary), "imaginary-transposed"),
            "imaginary-transposed",
        );
        transposed_owner.tensor.shape = vec![3, 2];
        transposed_owner.tensor.logical_axes = vec!["component".to_string(), "element".to_string()];
        invalid_pair[1] = transposed_owner;
        assert!(validate_owner_group(&invalid_pair).is_err());
    }

    #[test]
    fn serde_rejects_unknown_binding_fields_and_unsupported_ordering() {
        let valid = binding(scalar_descriptor(), DatasetSlicePlane::Values);
        let mut value = serde_json::to_value(&valid).expect("serialize binding");
        value
            .as_object_mut()
            .expect("binding object")
            .insert("unexpected".to_string(), json!(true));
        assert!(serde_json::from_value::<TensorFieldBinding>(value).is_err());

        let mut descriptor = vector_pair_descriptor();
        descriptor.sample_location = FieldSampleLocation::Cell;
        descriptor.function_space = Some(fullmag_quantities::FunctionSpaceDescriptor {
            space_id: "space:test".to_string(),
            family: "piecewise_constant".to_string(),
            order: 0,
            vector_dimension: 3,
            ordering: FunctionSpaceOrdering::ByComponent,
            basis_id: "basis:test".to_string(),
            constraints_fingerprint: None,
            partition_fingerprint: None,
            orientation_mapping_ref: None,
        });
        assert!(binding(descriptor, DatasetSlicePlane::Real)
            .validate_for_tensor(&vector_tensor(None, "real"))
            .is_err());

        let mut descriptor = vector_pair_descriptor();
        descriptor.sample_location = FieldSampleLocation::Cell;
        descriptor.function_space = Some(fullmag_quantities::FunctionSpaceDescriptor {
            space_id: "space:test".to_string(),
            family: "piecewise_constant".to_string(),
            order: 0,
            vector_dimension: 3,
            ordering: FunctionSpaceOrdering::NativeWithMapping,
            basis_id: "basis:test".to_string(),
            constraints_fingerprint: None,
            partition_fingerprint: None,
            orientation_mapping_ref: Some("mapping:test".to_string()),
        });
        assert!(binding(descriptor, DatasetSlicePlane::Real)
            .validate_for_tensor(&vector_tensor(None, "real"))
            .is_err());
    }

    #[test]
    fn reads_real_pinned_field_slice_and_preserves_owner_assessment() {
        let directory = tempfile::tempdir().expect("temporary field store");
        let store = SessionStore::open(directory.path().join("store")).expect("open field store");
        let intent = FmsRunIntent::new(
            "run-field",
            "intent-field",
            json!({"run_id":"run-field", "solver":"field-fixture"}),
        );
        store
            .commit_run_intent(&intent)
            .expect("publish field owner intent");
        let binding = binding(scalar_descriptor(), DatasetSlicePlane::Values);
        let payload = [1.0_f64, 2.0_f64]
            .into_iter()
            .flat_map(f64::to_le_bytes)
            .collect::<Vec<_>>();
        let chunk_ref = store.cas().put(&payload).expect("publish field payload");
        let descriptor = TensorDescriptor {
            format: SOLUTION_TENSOR_SCHEMA.to_string(),
            name: "m".to_string(),
            dtype: TensorDtype::F64,
            shape: vec![2],
            logical_axes: vec!["element".to_string()],
            endian: "little".to_string(),
            chunks: vec![TensorChunk {
                object_ref: chunk_ref.clone(),
                offset: 0,
                length: payload.len(),
                sha256: Some(chunk_ref),
            }],
            field_binding: Some(binding.clone()),
        };
        let descriptor_bytes = serde_json::to_vec(&descriptor).expect("serialize field root");
        let descriptor_ref = store
            .cas()
            .put(&descriptor_bytes)
            .expect("publish field root");
        let solution = fullmag_quantities::SolutionSet {
            schema_version: fullmag_quantities::SOLUTION_SET_SCHEMA_VERSION.to_string(),
            solution_set_id: "solution-field".to_string(),
            revision: 1,
            run_id: "run-field".to_string(),
            manifest_state: fullmag_quantities::SolutionSetManifestState::Closed,
            execution_status: fullmag_quantities::SolutionExecutionStatus::Succeeded,
            scientific_assessment: fullmag_quantities::ScientificAssessment {
                status: fullmag_quantities::ScientificAssessmentStatus::Unassessed,
                reason: Some("owner evidence is intentionally unassessed".to_string()),
                evidence_artifact_ids: Vec::new(),
            },
            provenance: fullmag_quantities::SolutionSetProvenance {
                run_spec_digest: format!("sha256:{}", intent.payload_sha256),
                model_digest: digest('b'),
                physics_digest: digest('c'),
                discretization_digest: digest('d'),
                resolved_plan_digest: digest('e'),
                acquisition_digest: digest('f'),
                seed_digest: None,
            },
            members: vec![fullmag_quantities::SolutionMember {
                member_id: "member-field".to_string(),
                task_id: "task-field".to_string(),
                attempt_id: "attempt-field".to_string(),
                ownership_epoch: 1,
                case_id: None,
                stage_id: "stage-field".to_string(),
                execution_status: fullmag_quantities::SolutionExecutionStatus::Succeeded,
                scientific_assessment: fullmag_quantities::ScientificAssessment {
                    status: fullmag_quantities::ScientificAssessmentStatus::Unassessed,
                    reason: Some("member assessment".to_string()),
                    evidence_artifact_ids: Vec::new(),
                },
                artifacts: vec![fullmag_quantities::SolutionArtifactRef {
                    artifact_id: "artifact-field".to_string(),
                    kind: fullmag_quantities::SolutionArtifactKind::State,
                    schema_id: SOLUTION_TENSOR_SCHEMA.to_string(),
                    object_ref: descriptor_ref.clone(),
                    byte_length: descriptor_bytes.len() as u64,
                    accepted_state: None,
                }],
            }],
            coverage: Vec::new(),
        };
        store
            .publish_solution_set(&solution)
            .expect("publish field solution");

        let request = DatasetFieldSliceRequest {
            schema_version: fullmag_quantities::DATASET_SLICE_SCHEMA_VERSION.to_string(),
            dataset: binding.dataset.clone(),
            sample_id: binding.sample_id.clone(),
            item_id: binding.item_id.clone(),
            field_id: binding.field_id.clone(),
            element_offset: 0,
            element_count: 2,
            max_response_bytes: 16,
        };
        let source = PinnedSolutionTensorSource {
            run_id: "run-field".to_string(),
            solution_set_id: "solution-field".to_string(),
            solution_revision: 1,
            member_id: "member-field".to_string(),
            artifact_id: "artifact-field".to_string(),
            tensor_object_ref: descriptor_ref,
            run_spec_digest: format!("sha256:{}", intent.payload_sha256),
        };
        let resolved = read_pinned_solution_field_slice(&store, &request, &[source.clone()])
            .expect("read pinned real field slice");
        assert_eq!(resolved.slice.manifest.field_id, binding.field_id);
        assert_eq!(resolved.slice.manifest.payload_bytes, 16);
        assert_eq!(resolved.owners.len(), 1);
        assert_eq!(
            resolved.owners[0].scientific_assessment.status,
            fullmag_quantities::ScientificAssessmentStatus::Unassessed
        );
        assert_eq!(
            resolved.slice.decode().expect("decode field slice").planes[0].values,
            fullmag_quantities::DatasetNumericValues::F64(vec![1.0, 2.0])
        );

        let mut wrong_request = request;
        wrong_request.field_id = "field:other".to_string();
        assert!(read_pinned_solution_field_slice(&store, &wrong_request, &[source]).is_err());
    }

    fn fake_owner(tensor: TensorDescriptor, artifact_id: &str) -> ResolvedSolutionTensor {
        ResolvedSolutionTensor {
            source: PinnedSolutionTensorSource {
                run_id: "run:test".to_string(),
                solution_set_id: "solution:test".to_string(),
                solution_revision: 1,
                member_id: "member:test".to_string(),
                artifact_id: artifact_id.to_string(),
                tensor_object_ref: digest(if artifact_id.starts_with("real") {
                    'b'
                } else {
                    'c'
                }),
                run_spec_digest: digest('d'),
            },
            artifact: fullmag_quantities::SolutionArtifactRef {
                artifact_id: artifact_id.to_string(),
                kind: fullmag_quantities::SolutionArtifactKind::State,
                schema_id: SOLUTION_TENSOR_SCHEMA.to_string(),
                object_ref: digest('e'),
                byte_length: 1,
                accepted_state: None,
            },
            tensor,
            manifest_state: fullmag_quantities::SolutionSetManifestState::Closed,
            execution_status: fullmag_quantities::SolutionExecutionStatus::Succeeded,
            member_execution_status: fullmag_quantities::SolutionExecutionStatus::Succeeded,
            scientific_assessment: fullmag_quantities::ScientificAssessment {
                status: fullmag_quantities::ScientificAssessmentStatus::Unassessed,
                reason: Some("test".to_string()),
                evidence_artifact_ids: Vec::new(),
            },
            member_scientific_assessment: fullmag_quantities::ScientificAssessment {
                status: fullmag_quantities::ScientificAssessmentStatus::Unassessed,
                reason: Some("test".to_string()),
                evidence_artifact_ids: Vec::new(),
            },
            provenance: fullmag_quantities::SolutionSetProvenance {
                run_spec_digest: digest('d'),
                model_digest: digest('e'),
                physics_digest: digest('f'),
                discretization_digest: digest('a'),
                resolved_plan_digest: digest('b'),
                acquisition_digest: digest('c'),
                seed_digest: None,
            },
            accepted_state: None,
        }
    }
}
