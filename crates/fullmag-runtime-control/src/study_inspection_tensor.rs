//! Derived raw V/J/H tensors share the accepted inspection bundle's SolutionSet owner.
//! Values remain byte-identical; this is publication, not a field-basis qualification.
use anyhow::{bail, Context, Result};
use fullmag_application::TaskClaim;
use fullmag_quantities::{ActiveSupportDescriptor, ComplexEncoding, DatasetFieldDescriptor, DatasetSlicePlane,
    FieldAxisDescriptor, FieldFrameDescriptor, FieldFrameKind, FieldNormalization, FieldResolution,
    FieldSampleLocation, FieldValueRepresentation, FunctionSpaceDescriptor, FunctionSpaceOrdering,
    MaterializedDatasetRef, QuantityId, SolutionArtifactKind, SolutionArtifactRef};
use fullmag_session::{SessionStore, TensorChunk, TensorDescriptor, FmsStudyOutputManifestEntry};
use fullmag_session::solution_tensor_field::{TensorFieldBinding, TENSOR_FIELD_BINDING_SCHEMA};
use fullmag_session::solution_tensor_source::{MAX_SOLUTION_TENSOR_CHUNKS, MAX_SOLUTION_TENSOR_METADATA_BYTES, SOLUTION_TENSOR_SCHEMA};
use serde_json::json;

fn digest(value: &serde_json::Value) -> String {
    format!("sha256:{}", fullmag_session::canonical_json_sha256(value))
}

pub(crate) fn materialize(
    store: &SessionStore, problem: &fullmag_ir::ProblemIR, step: &fullmag_authoring::StudyStep,
    source: &SolutionArtifactRef, output: &FmsStudyOutputManifestEntry,
    claim: &TaskClaim, run_spec_digest: &str, solution_set_id: &str,
) -> Result<Vec<SolutionArtifactRef>> {
    if output.codec_id != fullmag_application::ANTENNA_INSPECTION_BUNDLE_CODEC_ID
        || output.codec_version != fullmag_application::ANTENNA_INSPECTION_BUNDLE_CODEC_VERSION
        || output.data_kind != "artifact" || source.kind != SolutionArtifactKind::Other
        || source.accepted_state.is_some() || source.artifact_id != output.artifact_id
        || source.object_ref != output.object_ref || output.object_ref != output.content_sha256
        || source.schema_id != format!("{}@{}", output.codec_id, output.codec_version)
        || !fullmag_quantities::is_canonical_sha256(run_spec_digest) {
        bail!("inspection tensor producer or immutable source differs");
    }
    let owner = digest(&json!({"schema":"fullmag.inspection_tensor_owner.v1", "run_id":claim.run_id.as_str(),
        "task_id":claim.task_id.as_str(), "attempt_id":claim.attempt_id.as_str(), "epoch":claim.ownership_epoch.value(),
        "run_spec_digest":run_spec_digest, "source":source, "output":output}));
    if let Some(recorded) = store.solution_sets().read(solution_set_id)? {
        if recorded.run_id != claim.run_id.as_str() || recorded.provenance.run_spec_digest != run_spec_digest {
            bail!("recorded inspection tensor owner changed");
        }
        let members = recorded.members.iter().filter(|member|member.artifacts.iter().any(|artifact|artifact==source)).collect::<Vec<_>>();
        if members.len()!=1 { bail!("recorded inspection source member absent or ambiguous"); }
        let member = members[0];
        if member.task_id != claim.task_id.as_str() || member.attempt_id != claim.attempt_id.as_str()
            || member.ownership_epoch != claim.ownership_epoch.value() || member.stage_id != step.step_id
            || member.case_id.as_deref() != Some(output.case_id.as_str()) {
            bail!("recorded inspection member task, attempt, epoch, stage or case differs");
        }
        let mut results = Vec::new(); let mut quantities = std::collections::BTreeSet::new();
        for artifact in &members[0].artifacts {
            if artifact.schema_id != SOLUTION_TENSOR_SCHEMA { continue; }
            let tensor = fullmag_session::solution_tensor_source::read_solution_tensor_artifact(store.cas(), artifact)?;
            let Some(binding) = &tensor.field_binding else { continue; };
            if binding.producer_id != "fullmag.closed-loop-inspection" || binding.item_id != source.artifact_id { continue; }
            if binding.producer_version != "2" || binding.group_id != format!("group:{owner}")
                || binding.sample_id != output.case_id || artifact.accepted_state.is_some()
                || !matches!(binding.descriptor.quantity_id, QuantityId::VElectric | QuantityId::JCharge | QuantityId::HAnt)
                || !quantities.insert(binding.descriptor.quantity_id.as_str()) {
                bail!("recorded inspection tensor binding differs");
            }
            let (unit, components, role) = match binding.descriptor.quantity_id {
                QuantityId::VElectric => ("V", 1u32, "source_nodes"),
                QuantityId::JCharge => ("A/m^2", 3u32, "tet4_cell_local_nodes"),
                QuantityId::HAnt => ("A/m", 3u32, "sample_nodes"),
                _ => bail!("recorded inspection quantity differs"),
            };
            let field = &binding.descriptor;
            let space = field.function_space.as_ref().context("recorded inspection sample space absent")?;
            if field.unit != unit || field.normalization != FieldNormalization::None
                || field.value_representation != FieldValueRepresentation::PhysicalField
                || field.complex_encoding != ComplexEncoding::Real || field.harmonic_convention.is_some()
                || field.modal_semantics.is_some() || field.sample_location != FieldSampleLocation::Node
                || space.family != "owned_sample_values" || space.order != 0 || space.vector_dimension != components
                || space.ordering != FunctionSpaceOrdering::ByNode
                || space.basis_id != format!("basis:{role}:{}", field.layout_digest)
                || field.carrier_id != format!("carrier:{role}:{}", field.layout_digest)
                || binding.field_id != format!("field:{}", field.quantity_id.as_str())
                || binding.plane != DatasetSlicePlane::Values {
                bail!("recorded inspection tensor units, normalization or sample carrier differs");
            }
            results.push(artifact.clone());
        }
        if !results.is_empty() && results.len()!=3 { bail!("recorded inspection tensor publication is incomplete"); }
        // Older bundle-only results stay unchanged; replay never creates a new graph.
        return Ok(results);
    }
    let maximum = crate::study_inspection::inspection_bundle_budget(claim)?;
    if source.byte_length == 0 || source.byte_length > maximum as u64 { bail!("inspection tensor source byte bound"); }
    let bytes = store.cas().get_bounded(&source.object_ref, maximum as u64)?.context("inspection tensor source CAS absent")?;
    if bytes.len() as u64 != source.byte_length { bail!("inspection tensor source length differs"); }
    crate::study_inspection::validate_accepted_inspection_bytes(problem, step, &bytes, maximum)?;
    let fullmag_authoring::StudyStepKind::ClosedLoopInspection { stage_id, port_mode_id, output_id } = &step.kind
        else { bail!("inspection tensor requires typed closed-loop operation"); };
    let bundle = fullmag_application::decode_antenna_inspection_bundle(&bytes, maximum)?;
    drop(bytes);
    let manifest: serde_json::Value = serde_json::from_slice(&bundle.manifest_bytes)?;
    let content_digest = manifest["content_digest"].as_str().context("inspection content digest absent")?;
    let artifacts = bundle.payloads.into_iter().map(|(relative_path, bytes)|
        fullmag_runner::AuxiliaryArtifact { relative_path, bytes }).collect();
    let mut loaded = fullmag_runner::load_antenna_closed_loop_inspection_bytes(&bundle.manifest_bytes,
        artifacts, stage_id, output_id, port_mode_id, content_digest, maximum)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let mut results = Vec::new();
    for (key, quantity, unit, components, count_key, multiplier, carrier_role) in [
        ("v_raw", QuantityId::VElectric, "V", 1usize, "vertex_count", 1u64, "source_nodes"),
        ("j_local_raw", QuantityId::JCharge, "A/m^2", 3usize, "cell_count", 4u64, "tet4_cell_local_nodes"),
        ("h_raw", QuantityId::HAnt, "A/m", 3usize, "target_count", 1u64, "sample_nodes"),
    ] {
        let rows = loaded.metadata[count_key].as_u64().context("inspection tensor count absent")?
            .checked_mul(multiplier).context("inspection tensor row overflow")?;
        let rows = usize::try_from(rows)?;
        let values = loaded.payloads.remove(key).context("inspection tensor payload absent")?;
        let stride = components.checked_mul(8).context("inspection tensor stride overflow")?;
        if rows == 0 || rows.checked_mul(stride) != Some(values.len()) { bail!("inspection tensor shape differs"); }
        let layout = digest(&json!({"schema":"fullmag.inspection_sample_layout.v1", "owner":owner,
            "quantity":quantity.as_str(), "carrier_role":carrier_role, "rows":rows, "components":components,
            "source_content_digest":content_digest}));
        let mut axes = vec![FieldAxisDescriptor { axis_id:"sample".into(), unit:"1".into(), length:rows as u64 }];
        if components > 1 { axes.push(FieldAxisDescriptor { axis_id:"component".into(), unit:"1".into(), length:components as u64 }); }
        let field = DatasetFieldDescriptor { quantity_id:quantity, unit:unit.into(), tensor_rank:if components==1 {0} else {1},
            frame:FieldFrameDescriptor {kind:FieldFrameKind::Laboratory, frame_id:"frame:lab".into()},
            sample_location:FieldSampleLocation::Node,
            active_support:ActiveSupportDescriptor {support_fingerprint:layout.clone(), selection:None},
            function_space:Some(FunctionSpaceDescriptor {space_id:format!("space:inspection-samples:{layout}"),
                family:"owned_sample_values".into(), order:0, vector_dimension:components as u32,
                ordering:FunctionSpaceOrdering::ByNode, basis_id:format!("basis:{carrier_role}:{layout}"),
                constraints_fingerprint:None, partition_fingerprint:None, orientation_mapping_ref:None}),
            topology_id:layout.clone(), carrier_id:format!("carrier:{carrier_role}:{layout}"), layout_digest:layout.clone(),
            axes, component_axis:(components>1).then(||"component".into()), complex_encoding:ComplexEncoding::Real,
            harmonic_convention:None, normalization:FieldNormalization::None,
            value_representation:FieldValueRepresentation::PhysicalField, modal_semantics:None, resolution:FieldResolution::Quantitative };
        field.validate().map_err(|error| anyhow::anyhow!(error.to_string()))?;
        let axes = field.axes.iter().map(|axis|axis.axis_id.clone()).collect();
        let shape = if components==1 {vec![rows]} else {vec![rows, components]};
        let mut tensor = TensorDescriptor::new_f64(quantity.as_str(), shape, axes);
        tensor.field_binding = Some(TensorFieldBinding {format:TENSOR_FIELD_BINDING_SCHEMA.into(),
            dataset:MaterializedDatasetRef {dataset_id:format!("dataset:inspection:{layout}"),revision:1},
            sample_id:output.case_id.clone(), item_id:source.artifact_id.clone(), field_id:format!("field:{}",quantity.as_str()),
            group_id:format!("group:{owner}"), producer_id:"fullmag.closed-loop-inspection".into(),
            producer_version:"2".into(), plane:DatasetSlicePlane::Values, descriptor:field});
        tensor.field_binding.as_ref().context("inspection tensor binding absent")?.validate_for_tensor(&tensor)?;
        let chunk_bytes = 8192usize.checked_mul(stride).context("inspection chunk bound overflow")?;
        let mut offset = 0usize;
        for chunk in values.chunks(chunk_bytes) {
            if tensor.chunks.len() >= MAX_SOLUTION_TENSOR_CHUNKS { bail!("inspection tensor chunk budget"); }
            let object_ref = store.cas().put(chunk)?;
            tensor.chunks.push(TensorChunk {object_ref:object_ref.clone(), offset, length:chunk.len(), sha256:Some(object_ref)});
            offset = offset.checked_add(chunk.len()).context("inspection tensor offset overflow")?;
        }
        if offset != values.len() { bail!("inspection tensor byte coverage differs"); }
        let raw = serde_json::to_vec(&tensor)?;
        if raw.len() > MAX_SOLUTION_TENSOR_METADATA_BYTES as usize { bail!("inspection tensor metadata bound"); }
        let object_ref = store.cas().put(&raw)?;
        results.push(SolutionArtifactRef {artifact_id:format!("solution-tensor-{object_ref}"), kind:SolutionArtifactKind::State,
            schema_id:SOLUTION_TENSOR_SCHEMA.into(), object_ref, byte_length:raw.len() as u64, accepted_state:None});
    }
    Ok(results)
}
