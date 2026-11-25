//! Raw H-only tensor and its independently owned sample geometry in the canonical SolutionSet graph.
use anyhow::{bail, Context, Result};
use fullmag_application::TaskClaim;
use fullmag_antenna_artifacts::retained_current::{decode_retained_current_field_bundle_any, RetainedCurrentFieldBundleAny,
    RETAINED_CURRENT_FIELD_CODEC_ID, RETAINED_CURRENT_FIELD_CODEC_VERSION, MAX_PACKAGE_BYTES,
    RetainedCurrentFieldManifestRef, ParentInspectionOwner, MAX_METADATA_BYTES,
    parse_retained_current_manifest_any, retained_current_field_manifest_length_any};
use fullmag_quantities::{ActiveSupportDescriptor, ComplexEncoding, DatasetFieldDescriptor, DatasetSlicePlane,
    FieldAxisDescriptor, FieldFrameDescriptor, FieldFrameKind, FieldNormalization, FieldResolution,
    FieldSampleLocation, FieldValueRepresentation, FunctionSpaceDescriptor, FunctionSpaceOrdering,
    MaterializedDatasetRef, QuantityId, SolutionArtifactKind, SolutionArtifactRef};
use fullmag_session::{SessionStore, TensorChunk, TensorDescriptor, FmsStudyOutputManifestEntry};
use fullmag_session::solution_tensor_field::{TensorFieldBinding, TENSOR_FIELD_BINDING_SCHEMA};
use fullmag_session::solution_tensor_source::{MAX_SOLUTION_TENSOR_CHUNKS, MAX_SOLUTION_TENSOR_METADATA_BYTES, SOLUTION_TENSOR_SCHEMA};
use serde_json::json;

pub(crate) const PRODUCER_ID: &str = "fullmag.retained-current-field";
pub(crate) const PRODUCER_VERSION: &str = "1";
const CHUNK_BYTES: usize = 8192 * 24;

fn digest(value: &serde_json::Value) -> String {
    format!("sha256:{}", fullmag_session::canonical_json_sha256(value))
}
fn source_contract(source: &SolutionArtifactRef, output: &FmsStudyOutputManifestEntry) -> Result<()> {
    if output.codec_id != RETAINED_CURRENT_FIELD_CODEC_ID || !matches!(output.codec_version.as_str(), "v1" | "v2")
        || output.data_kind != "artifact" || output.port_id != "inspection" || output.case_id != "default"
        || source.kind != SolutionArtifactKind::Other || source.accepted_state.is_some()
        || source.artifact_id != output.artifact_id || source.object_ref != output.object_ref
        || output.object_ref != output.content_sha256
        || source.schema_id != format!("{RETAINED_CURRENT_FIELD_CODEC_ID}@{}", output.codec_version) {
        bail!("retained-current tensor source codec, owner or output differs");
    }
    Ok(())
}
fn owner(run: &str, task: &str, attempt: &str, epoch: u64, run_spec_digest: &str,
    source: &SolutionArtifactRef, output: &FmsStudyOutputManifestEntry) -> Result<String> {
    if !fullmag_quantities::is_canonical_sha256(run_spec_digest) { bail!("retained-current tensor RunSpec digest invalid"); }
    Ok(digest(&json!({"schema":"fullmag.retained_current_tensor_owner.v1", "run_id":run,
        "task_id":task, "attempt_id":attempt, "epoch":epoch, "run_spec_digest":run_spec_digest,
        "source":source, "output":output})))
}

fn metadata_descriptor(manifest: RetainedCurrentFieldManifestRef<'_>, owner: &str, source_id: &str, case: &str)
    -> Result<TensorDescriptor> {
    let rows = usize::try_from(manifest.target_count())?;
    if rows == 0 || rows.checked_mul(24).map(|size| size as u64) != Some(manifest.payloads().h_raw.byte_count) {
        bail!("retained-current H tensor shape differs");
    }
    let layout = digest(&json!({"schema":"fullmag.retained_current_sample_layout.v1", "owner":owner,
        "quantity":QuantityId::HAnt.as_str(), "carrier_role":"sample_nodes", "rows":rows,
        "components":3, "source_content_digest":manifest.content_digest(),
        "sample_carrier":manifest.sample_carrier(),
        "sample_xyz":manifest.payloads().sample_xyz, "sample_cells":manifest.payloads().sample_cells}));
    let field = DatasetFieldDescriptor { quantity_id:QuantityId::HAnt, unit:"A/m".into(), tensor_rank:1,
        frame:FieldFrameDescriptor {kind:FieldFrameKind::Laboratory, frame_id:"frame:lab".into()},
        sample_location:FieldSampleLocation::Node,
        active_support:ActiveSupportDescriptor {support_fingerprint:layout.clone(), selection:None},
        function_space:Some(FunctionSpaceDescriptor {space_id:format!("space:inspection-samples:{layout}"),
            family:"owned_sample_values".into(), order:0, vector_dimension:3,
            ordering:FunctionSpaceOrdering::ByNode, basis_id:format!("basis:sample_nodes:{layout}"),
            constraints_fingerprint:None, partition_fingerprint:None, orientation_mapping_ref:None}),
        topology_id:layout.clone(), carrier_id:format!("carrier:sample_nodes:{layout}"), layout_digest:layout.clone(),
        axes:vec![FieldAxisDescriptor {axis_id:"sample".into(),unit:"1".into(),length:rows as u64},
            FieldAxisDescriptor {axis_id:"component".into(),unit:"1".into(),length:3}],
        component_axis:Some("component".into()),complex_encoding:ComplexEncoding::Real,
        harmonic_convention:None, normalization:FieldNormalization::None,
        value_representation:FieldValueRepresentation::PhysicalField,modal_semantics:None,resolution:FieldResolution::Quantitative };
    field.validate().map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let mut tensor=TensorDescriptor::new_f64(QuantityId::HAnt.as_str(),vec![rows,3],vec!["sample".into(),"component".into()]);
    tensor.field_binding=Some(TensorFieldBinding {format:TENSOR_FIELD_BINDING_SCHEMA.into(),
        dataset:MaterializedDatasetRef {dataset_id:format!("dataset:retained-current:{layout}"),revision:1},
        sample_id:case.into(),item_id:source_id.into(),field_id:format!("field:{}",QuantityId::HAnt.as_str()),
        group_id:format!("group:{owner}"),producer_id:PRODUCER_ID.into(),producer_version:PRODUCER_VERSION.into(),
        plane:DatasetSlicePlane::Values,descriptor:field});
    Ok(tensor)
}

fn descriptor(bundle: &RetainedCurrentFieldBundleAny, owner: &str, source_id: &str, case: &str) -> Result<TensorDescriptor> {
    let values = &bundle.payloads()["h_raw"];
    if values.len() as u64 != bundle.manifest().payloads().h_raw.byte_count { bail!("retained-current H tensor shape differs"); }
    let mut tensor = metadata_descriptor(bundle.manifest(), owner, source_id, case)?;
    let mut offset=0;
    for chunk in values.chunks(CHUNK_BYTES) {
        if tensor.chunks.len()>=MAX_SOLUTION_TENSOR_CHUNKS { bail!("retained-current tensor chunk budget"); }
        let hash=fullmag_session::hex_sha256(chunk);
        tensor.chunks.push(TensorChunk {object_ref:hash.clone(),offset,length:chunk.len(),sha256:Some(hash)});
        offset=offset.checked_add(chunk.len()).context("retained-current tensor byte overflow")?;
    }
    tensor.field_binding.as_ref().context("retained-current tensor field binding absent")?.validate_for_tensor(&tensor)?;
    Ok(tensor)
}
fn tensor_bytes(tensor: &TensorDescriptor) -> Result<Vec<u8>> {
    let raw=serde_json::to_vec(tensor)?;
    if raw.len()>MAX_SOLUTION_TENSOR_METADATA_BYTES as usize { bail!("retained-current tensor metadata budget"); }
    Ok(raw)
}
fn verify_tensor_bytes(store: &SessionStore, artifact: &SolutionArtifactRef, tensor: &TensorDescriptor,
    values: &[u8]) -> Result<()> {
    let raw=tensor_bytes(tensor)?;
    if artifact.schema_id!=SOLUTION_TENSOR_SCHEMA || artifact.kind!=SolutionArtifactKind::State
        || artifact.accepted_state.is_some() || artifact.byte_length!=raw.len() as u64
        || artifact.object_ref!=fullmag_session::hex_sha256(&raw)
        || artifact.artifact_id!=format!("solution-tensor-{}",artifact.object_ref) {
        bail!("retained-current recorded tensor differs from exact owner, carrier, units or source bytes");
    }
    fullmag_session::solution_tensor_source::read_solution_tensor_artifact(store.cas(),artifact)?;
    for (chunk, expected) in tensor.chunks.iter().zip(values.chunks(CHUNK_BYTES)) {
        let bytes=store.cas().get_bounded(&chunk.object_ref,CHUNK_BYTES as u64)?
            .context("retained-current tensor chunk absent")?;
        if bytes!=expected { bail!("retained-current tensor chunk differs from original raw H"); }
    }
    Ok(())
}

pub(crate) fn materialize(store: &SessionStore, accepted: &crate::study::AcceptedStudySnapshot,
    step: &fullmag_authoring::StudyStep, source: &SolutionArtifactRef, output: &FmsStudyOutputManifestEntry,
    claim: &TaskClaim, run_spec_digest: &str, solution_set_id: &str) -> Result<Vec<SolutionArtifactRef>> {
    source_contract(source,output)?;
    let maximum=crate::study_inspection::inspection_bundle_budget(claim)?;
    if source.byte_length==0 || source.byte_length>maximum as u64 { bail!("retained-current tensor source budget"); }
    let bytes=store.cas().get_bounded(&source.object_ref,maximum as u64)?.context("retained-current tensor source absent")?;
    if bytes.len() as u64!=source.byte_length { bail!("retained-current tensor source length differs"); }
    let bundle=crate::study::validate_retained_current_publication_output(store,accepted,claim,step,&bytes,maximum)?;
    drop(bytes);
    let owner=owner(claim.run_id.as_str(),claim.task_id.as_str(),claim.attempt_id.as_str(),
        claim.ownership_epoch.value(),run_spec_digest,source,output)?;
    let tensor=descriptor(&bundle,&owner,&source.artifact_id,&output.case_id)?;
    if let Some(recorded)=store.solution_sets().read(solution_set_id)? {
        if recorded.run_id!=claim.run_id.as_str() || recorded.provenance.run_spec_digest!=run_spec_digest {
            bail!("retained-current recorded solution owner differs");
        }
        let members=recorded.members.iter().filter(|member|member.artifacts.iter().any(|artifact|artifact==source)).collect::<Vec<_>>();
        if members.len()!=1 { bail!("retained-current recorded source absent or ambiguous"); }
        let member=members[0];
        if member.task_id!=claim.task_id.as_str() || member.attempt_id!=claim.attempt_id.as_str()
            || member.ownership_epoch!=claim.ownership_epoch.value() || member.stage_id!=step.step_id
            || member.case_id.as_deref()!=Some(output.case_id.as_str()) {
            bail!("retained-current recorded member task, attempt, epoch, stage or case differs");
        }
        let tensors=member.artifacts.iter().filter(|artifact|artifact.schema_id==SOLUTION_TENSOR_SCHEMA).collect::<Vec<_>>();
        if tensors.len()!=1 { bail!("retained-current recorded result must contain exactly one H tensor"); }
        verify_tensor_bytes(store,tensors[0],&tensor,&bundle.payloads()["h_raw"])?;
        return Ok(vec![tensors[0].clone()]);
    }
    for chunk in bundle.payloads()["h_raw"].chunks(CHUNK_BYTES) { store.cas().put(chunk)?; }
    let raw=tensor_bytes(&tensor)?;
    let object_ref=store.cas().put(&raw)?;
    Ok(vec![SolutionArtifactRef {artifact_id:format!("solution-tensor-{object_ref}"),kind:SolutionArtifactKind::State,
        schema_id:SOLUTION_TENSOR_SCHEMA.into(),object_ref,byte_length:raw.len() as u64,accepted_state:None}])
}

/// Historical geometry provenance only, never current-source or execution authority.
pub struct SavedRetainedCurrentGeometryParent {
    pub source_package: SolutionArtifactRef,
    pub parent_owner: ParentInspectionOwner,
}

/// Resolve immutable source metadata for an exact saved H-only tensor, including Failed results.
/// No task is promoted and no numerical payload is decoded or returned.
pub fn read_saved_retained_current_geometry_parent(
    store: &SessionStore, project_id: &str,
    pinned: &fullmag_session::solution_tensor_source::PinnedSolutionTensorSource,
) -> Result<Option<SavedRetainedCurrentGeometryParent>> {
    let project = fullmag_application::ProjectId::parse(project_id.to_owned())?;
    let _transaction = store.read_transaction()?;
    let resolved = fullmag_session::solution_tensor_source::resolve_solution_tensor(store, pinned)?;
    let intent = store.read_run_intent(&pinned.run_id)?.context("saved retained geometry RunIntent absent")?;
    let specification: fullmag_application::RunSpecification = serde_json::from_value(intent.specification)?;
    if specification.snapshot.project_id != project || specification.run_id.as_str() != pinned.run_id
        || specification.fingerprint()? != intent.payload_sha256 {
        bail!("saved retained geometry child project, run or immutable fingerprint differs");
    }
    let Some(binding) = &resolved.tensor.field_binding else { return Ok(None); };
    if binding.producer_id != PRODUCER_ID { return Ok(None); }
    if binding.producer_version != PRODUCER_VERSION || binding.descriptor.quantity_id != QuantityId::HAnt
        || resolved.artifact.accepted_state.is_some() {
        bail!("saved retained geometry context requires the exact nonmagnetic H-only producer");
    }
    let solution = store.solution_sets().read_revision(&pinned.solution_set_id, pinned.solution_revision)?
        .context("saved retained geometry owner revision absent")?;
    let member = solution.members.iter().find(|member| member.member_id == pinned.member_id)
        .context("saved retained geometry owner member absent")?;
    if solution.run_id != pinned.run_id || solution.provenance.run_spec_digest != pinned.run_spec_digest
        || member.case_id.as_deref() != Some("default")
        || fullmag_session::task_id_for_study_step(&solution.run_id, &member.stage_id)? != member.task_id {
        bail!("saved retained geometry run, provenance, task or case differs");
    }
    let sources = member.artifacts.iter().filter(|artifact| artifact.artifact_id == binding.item_id).collect::<Vec<_>>();
    let [source] = sources.as_slice() else { bail!("saved retained geometry source absent or ambiguous"); };
    let source = *source;
    let output = FmsStudyOutputManifestEntry {port_id:"inspection".into(),case_id:"default".into(),data_kind:"artifact".into(),
        codec_id:RETAINED_CURRENT_FIELD_CODEC_ID.into(),codec_version:source.schema_id.strip_prefix(&format!("{RETAINED_CURRENT_FIELD_CODEC_ID}@"))
            .context("retained tensor source codec absent")?.into(),
        artifact_id:source.artifact_id.clone(),object_ref:source.object_ref.clone(),content_sha256:source.object_ref.clone()};
    source_contract(source, &output)?;
    if source.byte_length == 0 || source.byte_length > MAX_PACKAGE_BYTES { bail!("saved retained geometry source byte bound"); }
    let header = store.cas().get_verified_range(&source.object_ref, 0, 16, MAX_METADATA_BYTES)?
        .context("saved retained geometry source header absent")?;
    if header.object_length != source.byte_length { bail!("saved retained geometry package length differs"); }
    let length = retained_current_field_manifest_length_any(&header.bytes, header.object_length)
        .map_err(|error| anyhow::anyhow!(error.message))?;
    let bytes = store.cas().get_verified_range(&source.object_ref, 16, length as u64, MAX_METADATA_BYTES)?
        .context("saved retained geometry source manifest absent")?;
    if bytes.object_length != source.byte_length { bail!("saved retained geometry manifest package length differs"); }
    let manifest_any = parse_retained_current_manifest_any(&bytes.bytes).map_err(|error| anyhow::anyhow!(error.message))?;
    let manifest = manifest_any.as_ref();
    if manifest.codec_version() != output.codec_version
        || (&header.bytes[..8] == b"FMARCF1\0") != (manifest.codec_version() == "v1") {
        bail!("saved retained geometry codec, header and manifest versions differ");
    }
    if manifest.parent().owner.project_id != project.as_str() {
        bail!("saved retained geometry parent belongs to another project");
    }
    let owner = owner(&solution.run_id, &member.task_id, &member.attempt_id, member.ownership_epoch,
        &solution.provenance.run_spec_digest, source, &output)?;
    let expected = metadata_descriptor(manifest, &owner, &source.artifact_id, "default")?;
    let mut actual = resolved.tensor.clone();
    actual.chunks.clear();
    if tensor_bytes(&actual)? != tensor_bytes(&expected)? {
        bail!("saved retained geometry source differs from the exact tensor owner, field or sample carrier");
    }
    // Historical detached evidence, not live parent admission or physical source qualification.
    fullmag_session::accepted_provenance::validate_retained_current_parent_evidence_any(
        &source.object_ref, manifest,
        |object| store.cas().get_bounded(object, MAX_METADATA_BYTES),
        |object, offset, count| store.cas().get_verified_range(object, offset, count, MAX_METADATA_BYTES),
    )?;
    Ok(Some(SavedRetainedCurrentGeometryParent {
        source_package: source.clone(), parent_owner: manifest.parent().owner.clone(),
    }))
}

/// Add exact sample coordinates/topology through the existing owned-sample geometry API.
pub(crate) fn build_geometry(store: &SessionStore, solution: &fullmag_quantities::SolutionSet,
    member: &fullmag_quantities::SolutionMember, tensor_artifact: &SolutionArtifactRef,
    tensor: &TensorDescriptor) -> Result<Option<SolutionArtifactRef>> {
    use fullmag_session::solution_field_geometry::{build_solution_owned_sample_geometry_artifact,
        OwnedSampleGeometryRole,OwnedSampleIdentity,SavedOwnedSampleFieldGeometry,
        SavedFieldRepresentationEvidence,OWNED_SAMPLE_GEOMETRY_SCHEMA};
    let Some(binding)=&tensor.field_binding else { return Ok(None); };
    if binding.producer_id!=PRODUCER_ID { return Ok(None); }
    if binding.producer_version!=PRODUCER_VERSION || binding.descriptor.quantity_id!=QuantityId::HAnt
        || tensor_artifact.accepted_state.is_some() || member.case_id.as_deref()!=Some("default") {
        bail!("retained-current saved sample geometry producer, quantity or case differs");
    }
    let sources=member.artifacts.iter().filter(|artifact|artifact.artifact_id==binding.item_id).collect::<Vec<_>>();
    if sources.len()!=1 { bail!("retained-current saved sample source absent or ambiguous"); }
    let source=sources[0];
    let output=FmsStudyOutputManifestEntry {port_id:"inspection".into(),case_id:"default".into(),data_kind:"artifact".into(),
        codec_id:RETAINED_CURRENT_FIELD_CODEC_ID.into(),codec_version:source.schema_id.strip_prefix(&format!("{RETAINED_CURRENT_FIELD_CODEC_ID}@"))
            .context("retained tensor source codec absent")?.into(),
        artifact_id:source.artifact_id.clone(),object_ref:source.object_ref.clone(),content_sha256:source.object_ref.clone()};
    source_contract(source,&output)?;
    if source.byte_length==0 || source.byte_length>MAX_PACKAGE_BYTES { bail!("retained-current geometry source byte bound"); }
    let raw=store.cas().get_bounded(&source.object_ref,MAX_PACKAGE_BYTES)?.context("retained-current geometry source absent")?;
    if raw.len() as u64!=source.byte_length { bail!("retained-current geometry source length differs"); }
    let bundle=decode_retained_current_field_bundle_any(&raw,MAX_PACKAGE_BYTES as usize)
        .map_err(|error|anyhow::anyhow!(error.to_string()))?;
    drop(raw);
    if bundle.manifest().codec_version() != output.codec_version {
        bail!("retained-current geometry source codec differs from its package");
    }
    let owner=owner(&solution.run_id,&member.task_id,&member.attempt_id,member.ownership_epoch,
        &solution.provenance.run_spec_digest,source,&output)?;
    let expected=descriptor(&bundle,&owner,&source.artifact_id,"default")?;
    if tensor_bytes(tensor)? != tensor_bytes(&expected)? {
        bail!("retained-current supplied tensor differs from exact source/carrier descriptor");
    }
    verify_tensor_bytes(store,tensor_artifact,&expected,&bundle.payloads()["h_raw"])?;
    let mut mesh=fullmag_ir::MeshIR::default();
    mesh.mesh_name="retained-current:H_ant".into();
    mesh.nodes=bundle.payloads()["sample_xyz"].chunks_exact(24).map(|row|
        std::array::from_fn(|i|f64::from_le_bytes(row[i*8..i*8+8].try_into().expect("verified f64")))).collect();
    let cells=bundle.payloads()["sample_cells"].chunks_exact(16).map(|row|
        std::array::from_fn(|i|u32::from_le_bytes(row[i*4..i*4+4].try_into().expect("verified u32")))).collect();
    mesh.cells=fullmag_ir::FemConnectivityIR::from_tet4(cells);
    mesh.element_markers=vec![0;mesh.cells.len()];
    let sample_identities=(0..mesh.nodes.len()).map(|i|OwnedSampleIdentity {
        stable_id:i.to_string(),local_node:None,stable_vertex_id:None}).collect();
    let geometry=SavedOwnedSampleFieldGeometry {schema_version:OWNED_SAMPLE_GEOMETRY_SCHEMA.into(),coordinate_unit:"m".into(),
        representation_evidence:SavedFieldRepresentationEvidence::NotVerified,role:OwnedSampleGeometryRole::SampleNodes,
        mesh,sample_identities,descriptor:binding.descriptor.clone(),producer_id:PRODUCER_ID.into(),producer_version:PRODUCER_VERSION.into()};
    Ok(Some(build_solution_owned_sample_geometry_artifact(store.cas(),solution,&member.member_id,tensor_artifact,&geometry)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Framing/identity fixtures only; these never constitute physical parent evidence.
    fn source_pair() -> (SolutionArtifactRef,FmsStudyOutputManifestEntry) {
        let source=SolutionArtifactRef {artifact_id:"field-output".into(),kind:SolutionArtifactKind::Other,
            schema_id:format!("{RETAINED_CURRENT_FIELD_CODEC_ID}@{RETAINED_CURRENT_FIELD_CODEC_VERSION}"),
            object_ref:"a".repeat(64),byte_length:128,accepted_state:None};
        let output=FmsStudyOutputManifestEntry {port_id:"inspection".into(),case_id:"default".into(),data_kind:"artifact".into(),
            codec_id:RETAINED_CURRENT_FIELD_CODEC_ID.into(),codec_version:RETAINED_CURRENT_FIELD_CODEC_VERSION.into(),
            artifact_id:source.artifact_id.clone(),object_ref:source.object_ref.clone(),content_sha256:source.object_ref.clone()};
        (source,output)
    }
    // Codec/tensor fixture only. This is deliberately not an authenticated current source.
    fn direct_bundle() -> RetainedCurrentFieldBundleAny {
        use fullmag_antenna_artifacts::retained_current::*;
        let xyz = [[0.,0.,0.],[1e-6,0.,0.],[0.,1e-6,0.],[0.,0.,1e-6]];
        let mut payloads = std::collections::BTreeMap::new();
        payloads.insert("sample_xyz".into(), xyz.into_iter().flatten().flat_map(f64::to_le_bytes).collect::<Vec<_>>());
        payloads.insert("sample_cells".into(), [0u32,1,2,3].into_iter().flat_map(u32::to_le_bytes).collect());
        payloads.insert("h_raw".into(), (0..12).flat_map(|i| (i as f64 - 4.).to_le_bytes()).collect());
        // The descriptor test does not decode evidence or cross a physical publication gate.
        payloads.insert("evidence".into(), b"NOT physical evidence".to_vec());
        let reference = |key: &str, layout: &str, unit: &str| RetainedCurrentPayloadRef {
            sha256: fullmag_session::hex_sha256(&payloads[key]), byte_count: payloads[key].len() as u64,
            layout: layout.into(), unit: unit.into(),
        };
        let dig = format!("sha256:{}", "e".repeat(64));
        let object = |hash: &str| json!({"object_ref":hash.repeat(64),"byte_count":256});
        let source = json!({"kind":"published_inspection","project_id":"project","run_id":"parent-run",
            "task_id":"parent-task","attempt_id":"parent-attempt","ownership_epoch":"1",
            "artifact_id":"parent-artifact","object_ref":"a".repeat(64)});
        let stage: fullmag_ir::AntennaFieldSolveStageIR = serde_json::from_value(json!({
            "id":"child", "source_object_id":"antenna", "current_transport_id":"transport", "port_mode_ids":["port"],
            "retained_current_source":source, "retained_source_preparation":{"asset_id":format!("script-file-{}","1".repeat(64)),"content_sha256":"2".repeat(64)},
            "model":"quasistatic_conduction_biot_savart3d", "oersted_realization":"direct_tetra_quadrature", "conductor_mesh_policy":"retained",
            "field_sampling_domain":{"kind":"global"},"target_refs":[],"solver_policy":"volume_inspection_v1",
            "outputs":[{"id":"field","quantity":"H_ant_basis"}]})).unwrap();
        let execution: fullmag_ir::RequestedTransportExecutionIR = serde_json::from_value(json!({"discretization":"fem","device":"cpu","precision":"double","execution_mode":"strict"})).unwrap();
        let parent = serde_json::from_value(json!({"owner":{"project_id":"project","run_id":"parent-run","study_step_id":"parent-step",
            "native_stage_id":"parent-native","task_id":"parent-task","attempt_id":"parent-attempt","ownership_epoch":"1",
            "artifact_id":"parent-artifact","package":object("a"),"package_codec_id":PARENT_CODEC_ID,"package_codec_version":PARENT_CODEC_VERSION,
            "manifest_schema":PARENT_MANIFEST_SCHEMA,"output_manifest_artifact_id":"parent-manifest","output_manifest":object("b")},
            "source":{"prepared_execution_digest":dig,"accepted_charge_field_digest":dig,"accepted_source_state_digest":dig,
                "view_identity_digest":dig,"current_balance_certificate_digest":dig},"evidence_capsule":object("f")})).unwrap();
        let mut manifest = RetainedCurrentFieldManifestV2 {
            schema_version: RETAINED_CURRENT_FIELD_SCHEMA_V2.into(),status:"inspection_only".into(),qualification:"not_verified".into(),content_digest:String::new(),
            stage_id:"child".into(),output_id:"field".into(),port_mode_id:"port".into(),source_object_id:"antenna".into(),current_transport_id:"transport".into(),parent,
            sample_carrier:fullmag_antenna_artifacts::AntennaSampleCarrier {domain:fullmag_ir::FieldTargetIR::Global {},carrier_kind:"fem_domain_mesh_asset".into(),location:"node".into(),topology_digest:dig},
            source_vertex_count:4,source_cell_count:1,target_count:4,sample_cell_count:1,requested_intent:stage,
            resolved_execution:RetainedCurrentResolvedExecution {requested_execution:execution.clone(),execution,operator_version:RETAINED_CURRENT_OPERATOR_V2.into(),
                basis_version:RETAINED_CURRENT_BASIS.into(),evidence_schema:RETAINED_CURRENT_EVIDENCE_SCHEMA_V2.into()},
            direct_field_policy:RetainedCurrentDirectFieldPolicyV2::for_solver_policy("volume_inspection_v1").unwrap(),
            payloads:RetainedCurrentPayloads {sample_xyz:reference("sample_xyz","sample_xyz_f64_le","m"),sample_cells:reference("sample_cells","tet4_u32_le","1"),
                h_raw:reference("h_raw","sample_xyz_f64_le","A/m"),evidence:reference("evidence",RETAINED_CURRENT_EVIDENCE_SCHEMA_V2,"1")},
        };
        manifest.content_digest = manifest.expected_content_digest().unwrap();
        RetainedCurrentFieldBundleAny::DirectV2(RetainedCurrentFieldBundleV2 {manifest_bytes:serde_json::to_vec(&manifest).unwrap(),manifest,payloads})
    }

    #[test]
    fn dtq_v2_tensor_is_raw_h_on_child_carrier() {
        let bundle = direct_bundle();
        let tensor = descriptor(&bundle, "owner", "child-artifact", "default").unwrap();
        let binding = tensor.field_binding.as_ref().unwrap();
        assert_eq!(binding.descriptor.quantity_id, QuantityId::HAnt);
        assert_eq!(binding.descriptor.unit, "A/m");
        assert_eq!(binding.descriptor.normalization, FieldNormalization::None);
        assert_eq!(binding.descriptor.sample_location, FieldSampleLocation::Node);
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        let cold_directory = tempfile::tempdir().unwrap();
        let cold = SessionStore::open(cold_directory.path()).unwrap();
        for chunk in bundle.payloads()["h_raw"].chunks(CHUNK_BYTES) {
            assert_eq!(store.cas().put(chunk).unwrap(), cold.cas().put(chunk).unwrap());
        }
        let raw = tensor_bytes(&tensor).unwrap();
        let object_ref = cold.cas().put(&raw).unwrap();
        let artifact = SolutionArtifactRef {artifact_id:format!("solution-tensor-{object_ref}"),kind:SolutionArtifactKind::State,
            schema_id:SOLUTION_TENSOR_SCHEMA.into(),object_ref,byte_length:raw.len() as u64,accepted_state:None};
        drop(store); drop(directory);
        verify_tensor_bytes(&cold,&artifact,&tensor,&bundle.payloads()["h_raw"]).unwrap();
        let mut changed = bundle.clone();
        if let RetainedCurrentFieldBundleAny::DirectV2(bundle) = &mut changed {
            bundle.manifest.sample_carrier.topology_digest = format!("sha256:{}","b".repeat(64));
        }
        assert_ne!(tensor_bytes(&tensor).unwrap(), tensor_bytes(&descriptor(&changed,"owner","child-artifact","default").unwrap()).unwrap());
        let mut corrupt = bundle.payloads()["h_raw"].clone(); corrupt[0] ^= 1;
        assert!(verify_tensor_bytes(&cold,&artifact,&tensor,&corrupt).is_err());
    }

    #[test]
    fn dtq_v2_tensor_source_is_versioned_and_never_magnetic_state() {
        let (mut source, mut output) = source_pair();
        source.schema_id = format!("{RETAINED_CURRENT_FIELD_CODEC_ID}@v2");
        output.codec_version = "v2".into();
        source_contract(&source, &output).unwrap();
        let mut changed = output.clone(); changed.codec_version = "v1".into();
        assert!(source_contract(&source, &changed).is_err());
        source.kind = SolutionArtifactKind::State;
        assert!(source_contract(&source, &output).is_err());
    }
    #[test]
    fn tensor_source_rejects_foreign_codec_case_identity_and_magnetic_kind() {
        let (source,output)=source_pair();source_contract(&source,&output).unwrap();
        let mut changed=output.clone();changed.codec_id=fullmag_application::ANTENNA_INSPECTION_BUNDLE_CODEC_ID.into();
        assert!(source_contract(&source,&changed).is_err());
        let mut changed=output.clone();changed.case_id="foreign".into();assert!(source_contract(&source,&changed).is_err());
        let mut changed=output.clone();changed.artifact_id="foreign".into();assert!(source_contract(&source,&changed).is_err());
        let mut changed=source.clone();changed.kind=SolutionArtifactKind::State;assert!(source_contract(&changed,&output).is_err());
        let first=owner("run","task","attempt",1,&format!("sha256:{}","b".repeat(64)),&source,&output).unwrap();
        assert_ne!(first,owner("run","task","attempt",2,&format!("sha256:{}","b".repeat(64)),&source,&output).unwrap());
        assert_ne!(first,owner("run","task","other",1,&format!("sha256:{}","b".repeat(64)),&source,&output).unwrap());
    }

    #[test]
    fn replay_requires_chunk_bytes_equal_original_raw_h_even_with_valid_tensor_cas() {
        let directory=tempfile::tempdir().unwrap();
        let store=SessionStore::open(directory.path()).unwrap();
        let raw=(0..12).flat_map(|i|(i as f64).to_le_bytes()).collect::<Vec<_>>();
        let chunk=store.cas().put(&raw).unwrap();
        let mut tensor=TensorDescriptor::new_f64(QuantityId::HAnt.as_str(),vec![4,3],vec!["sample".into(),"component".into()]);
        tensor.chunks.push(TensorChunk {object_ref:chunk.clone(),offset:0,length:raw.len(),sha256:Some(chunk)});
        let metadata=tensor_bytes(&tensor).unwrap();let reference=store.cas().put(&metadata).unwrap();
        let artifact=SolutionArtifactRef {artifact_id:format!("solution-tensor-{reference}"),kind:SolutionArtifactKind::State,
            schema_id:SOLUTION_TENSOR_SCHEMA.into(),object_ref:reference,byte_length:metadata.len() as u64,accepted_state:None};
        verify_tensor_bytes(&store,&artifact,&tensor,&raw).unwrap();
        let mut changed=raw.clone();changed[..8].copy_from_slice(&(-1.0f64).to_le_bytes());
        assert!(verify_tensor_bytes(&store,&artifact,&tensor,&changed).is_err());
        let mut foreign=artifact.clone();foreign.byte_length+=1;
        assert!(verify_tensor_bytes(&store,&foreign,&tensor,&raw).is_err());
    }
}
