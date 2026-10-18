//! Common read-only field views of one fully verified immutable inspection result.
use std::{collections::BTreeMap, sync::Arc};
use fullmag_runner::{FemMeshPayload, LoadedAntennaClosedLoopInspection, LoadedAntennaExternalLeadSolution};
use sha2::{Digest, Sha256};
use crate::{error::ApiError, schemas::fields::{ArtifactFieldOwnerBinding, ArtifactSampleIndexing, ArtifactFieldLocatorResource}};
use super::{artifact_field_carrier::{ArtifactSampleCarrier, ArtifactSampleIdentity}, resolved_spatial_field::ResolvedSpatialField};

pub(crate) struct VerifiedInspectionFields {
    pub fields: BTreeMap<String, Arc<ResolvedSpatialField<'static>>>,
    pub retained_bytes: usize,
}

fn invalid(message: &str) -> ApiError { ApiError::conflict_with_code("invalid_artifact_sample_carrier", message) }
fn bytes<'a>(loaded: &'a LoadedAntennaClosedLoopInspection, key: &str) -> Result<&'a [u8], ApiError> {
    loaded.payloads.get(key).map(Vec::as_slice).ok_or_else(|| invalid("verified payload absent"))
}
fn f64s(bytes: &[u8]) -> Result<Vec<f64>, ApiError> {
    if bytes.len() % 8 != 0 { return Err(invalid("unaligned f64 payload")); }
    let values = bytes.chunks_exact(8).map(|b| f64::from_le_bytes(b.try_into().expect("eight bytes"))).collect::<Vec<_>>();
    if values.iter().any(|v| !v.is_finite()) { return Err(invalid("nonfinite artifact field")); }
    Ok(values)
}
fn xyz(bytes: &[u8]) -> Result<Vec<[f64;3]>, ApiError> {
    let values = f64s(bytes)?;
    if values.len() % 3 != 0 { return Err(invalid("unaligned xyz payload")); }
    Ok(values.chunks_exact(3).map(|p| [p[0],p[1],p[2]]).collect())
}
fn u64_at(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(bytes[offset..offset+8].try_into().expect("verified eight-byte record"))
}
fn tet4(bytes: &[u8], count: usize) -> Result<Vec<[u32;4]>, ApiError> {
    if bytes.is_empty() || bytes.len() % 16 != 0 { return Err(invalid("owned sampling Tet4 absent")); }
    bytes.chunks_exact(16).map(|b| {
        let cell = std::array::from_fn(|i| u32::from_le_bytes(b[4*i..4*i+4].try_into().expect("four bytes")));
        if cell.iter().any(|id| *id as usize >= count) { return Err(invalid("sampling Tet4 index out of range")); }
        Ok(cell)
    }).collect()
}
fn mesh(nodes: Vec<[f64;3]>, cells: Vec<[u32;4]>, id: &str) -> FemMeshPayload {
    FemMeshPayload {mesh_name: id.into(), mesh_id: id.into(), nodes,
        cells: fullmag_ir::FemConnectivityIR::from_tet4(cells), element_markers: Vec::new(),
        facets: fullmag_ir::FemFacetConnectivityIR::empty(), boundary_markers:Vec::new(),
        periodic_boundary_pairs:Vec::new(), periodic_node_pairs:Vec::new(), object_segments:Vec::new(),
        mesh_parts:Vec::new(), domain_mesh_mode:None, domain_frame:None, generation_id:Some(id.into()),
        per_domain_quality:Default::default(), build_report:None}
}

fn insert(
    fields: &mut VerifiedInspectionFields, key: &str, quantity: &str, values: Vec<f64>,
    owner: &ArtifactFieldOwnerBinding, positions: Vec<[f64;3]>, identities: Vec<ArtifactSampleIdentity>,
    cells: Option<Vec<[u32;4]>>, indexing: ArtifactSampleIndexing, observation_revision: u64,
    native_mesh_identity: &str, native_topology_identity: &str,
    sampling_domain: Option<&fullmag_ir::FieldTargetIR>,
) -> Result<(), ApiError> {
    let (carrier_scope_kind,carrier_scope_id)=match sampling_domain {
        None=>("object",Some(owner.object_id.as_str())),
        Some(fullmag_ir::FieldTargetIR::Object{object_id})=>("object",Some(object_id.as_str())),
        Some(fullmag_ir::FieldTargetIR::Global{})=>("full",None),
        Some(fullmag_ir::FieldTargetIR::Region{..})=>return Err(invalid("region inspection sampling is not implemented")),
    };
    // Content binds the actual source owner and independently owned sampling role.
    let mut hash = Sha256::new();
    hash.update(b"fullmag.artifact_sample_carrier.v1\0");
    let mut immutable_binding = serde_json::json!({"run_id":owner.run_id,"runtime_stage_id":owner.runtime_stage_id,
        "authored_stage_id":owner.authored_stage_id,"module_id":owner.module_id,"object_id":owner.object_id,
        "output_id":owner.output_id,"source_digest":owner.source_digest,"content_digest":owner.content_digest,
        "native_mesh_identity":native_mesh_identity,"native_topology_identity":native_topology_identity,"indexing":indexing,
        "carrier_scope_kind":carrier_scope_kind,"carrier_scope_id":carrier_scope_id});
    if let Some(accepted) = &owner.accepted_artifact {
        immutable_binding["accepted_artifact"] = serde_json::to_value(accepted)
            .map_err(|e| ApiError::internal(e.to_string()))?;
    }
    let binding = serde_json::to_vec(&immutable_binding)
        .map_err(|e| ApiError::internal(e.to_string()))?;
    hash.update((binding.len() as u64).to_le_bytes()); hash.update(binding);
    hash.update((positions.len() as u64).to_le_bytes());
    for value in positions.iter().flatten() { hash.update(value.to_bits().to_le_bytes()); }
    for identity in &identities {
        match identity {
            ArtifactSampleIdentity::SourceNode(id) | ArtifactSampleIdentity::SampleOrdinal(id) | ArtifactSampleIdentity::CellCenter(id) => hash.update(id.to_le_bytes()),
            ArtifactSampleIdentity::CellLocal{source_element_ordinal,local_vertex_index,stable_vertex_id} => {
                hash.update(source_element_ordinal.to_le_bytes()); hash.update([*local_vertex_index]); hash.update(stable_vertex_id.to_le_bytes());
            }
        }
    }
    hash.update((cells.as_ref().map_or(0,Vec::len) as u64).to_le_bytes());
    if let Some(cells) = &cells { for id in cells.iter().flatten() { hash.update(id.to_le_bytes()); } }
    let hash=hash.finalize();
    let carrier_revision=u64::from_le_bytes(hash[..8].try_into().expect("eight digest bytes"));
    if carrier_revision==0 {return Err(invalid("immutable content-derived carrier revision is zero"));}
    let digest=format!("{hash:x}");
    for existing in fields.fields.values() {
        let old=locator(existing)?;
        if old.carrier_revision==carrier_revision.to_string() && old.carrier_digest!=digest {
            return Err(invalid("immutable carrier u64 selector collision"));
        }
    }
    let topology = cells.map(|cells| mesh(positions.clone(),cells,&digest));
    let owner_bytes=[&owner.session_id,&owner.session_epoch,&owner.request_scope_epoch,&owner.run_id,&owner.runtime_stage_id,
        &owner.authored_stage_id,&owner.module_id,&owner.object_id,&owner.output_id,&owner.source_digest,&owner.content_digest,
        &owner.native_mesh_identity,&owner.native_topology_identity].iter().try_fold(0usize,|sum,value|sum.checked_add(value.capacity()))
        .ok_or_else(||invalid("artifact owner allocation overflow"))?;
    let owner_bytes = if let Some(accepted) = &owner.accepted_artifact {
        [&accepted.project_id, &accepted.task_id, &accepted.attempt_id, &accepted.ownership_epoch,
            &accepted.artifact_id, &accepted.object_ref].iter().try_fold(owner_bytes,
                |sum, value| sum.checked_add(value.capacity()))
            .ok_or_else(|| invalid("accepted artifact owner allocation overflow"))?
    } else { owner_bytes };
    let retained = values.capacity().checked_mul(8).and_then(|n| positions.capacity().checked_mul(24).and_then(|p| n.checked_add(p)))
        .and_then(|n| identities.capacity().checked_mul(std::mem::size_of::<ArtifactSampleIdentity>()).and_then(|p| n.checked_add(p)))
        .and_then(|n| topology.as_ref().map_or(Some(n), |m| m.nodes.capacity().checked_mul(24)
            .and_then(|a| m.cells.nodes.capacity().checked_mul(4).and_then(|b| a.checked_add(b)))
            .and_then(|a| m.cells.offsets.capacity().checked_mul(4).and_then(|b| a.checked_add(b)))
            .and_then(|a| m.cells.types.capacity().checked_mul(std::mem::size_of::<fullmag_ir::FemCellTypeIR>()).and_then(|b| a.checked_add(b)))
            .and_then(|a| m.cells.global_ordinals.capacity().checked_mul(8).and_then(|b| a.checked_add(b)))
            .and_then(|a| n.checked_add(a))))
        // Conservatively bound owner strings, map/Arc/field records, mesh and empty CSR overhead.
        .and_then(|n|n.checked_add(owner_bytes)).and_then(|n|n.checked_add(256*1024))
        .ok_or_else(|| invalid("artifact view memory bound overflow"))?;
    fields.retained_bytes = fields.retained_bytes.checked_add(retained).ok_or_else(|| invalid("artifact cache memory overflow"))?;
    let carrier = Arc::new(ArtifactSampleCarrier {owner:owner.clone(),carrier_scope_kind:carrier_scope_kind.into(),
        carrier_scope_id:carrier_scope_id.map(str::to_owned),indexing,positions_xyz_m:positions,
        sample_identity:identities,topology,carrier_digest:digest,carrier_revision});
    fields.fields.insert(key.into(),Arc::new(ResolvedSpatialField::from_artifact_samples(quantity,values,carrier,observation_revision)?));
    Ok(())
}

pub(crate) fn from_closed(
    owner: ArtifactFieldOwnerBinding, loaded: LoadedAntennaClosedLoopInspection, observation_revision: u64,
) -> Result<VerifiedInspectionFields, ApiError> {
    let mut fields = VerifiedInspectionFields {fields:BTreeMap::new(),retained_bytes:0};
    // Bound geometry duplication before allocating source/local/sample views.
    // Payload bytes cover every sample/cell; 16x also covers Vec growth, identities,
    // CSR topology, the temporary stable-ID map and all four field records.
    let payload_bytes = loaded.payloads.values().try_fold(0usize, |sum, payload|
        sum.checked_add(payload.len())).ok_or_else(|| invalid("inspection payload size overflow"))?;
    let view_bound = payload_bytes.checked_mul(16).and_then(|n| n.checked_add(2 * 1024 * 1024))
        .ok_or_else(|| invalid("inspection view admission overflow"))?;
    if view_bound > 128 * 1024 * 1024 {
        return Err(invalid("inspection views exceed the 128 MiB materialization budget"));
    }
    let source_positions = xyz(bytes(&loaded,"vertex_xyz")?)?;
    let id_bytes = bytes(&loaded,"stable_vertex_ids")?;
    if id_bytes.len() != source_positions.len().checked_mul(8).ok_or_else(|| invalid("node count overflow"))? {
        return Err(invalid("source stable IDs do not match nodes"));
    }
    let ids = id_bytes.chunks_exact(8).map(|b| u64::from_le_bytes(b.try_into().expect("eight bytes"))).collect::<Vec<_>>();
    let by_id = ids.iter().enumerate().map(|(ordinal,id)| (*id,ordinal as u32)).collect::<BTreeMap<_,_>>();
    if by_id.len() != ids.len() { return Err(invalid("duplicate source node IDs")); }
    let cell_bytes = bytes(&loaded,"cells")?;
    if cell_bytes.is_empty() || cell_bytes.len() % 280 != 0 { return Err(invalid("missing ordered source cells")); }
    let mut source_cells = Vec::new(); let mut local_positions = Vec::new(); let mut local_ids=Vec::new();
    let mut local_cells=Vec::new(); let mut center_positions=Vec::new(); let mut center_ids=Vec::new();
    for cell in cell_bytes.chunks_exact(280) {
        let element=u64_at(cell,0);
        let stable:[u64;4]=std::array::from_fn(|i| u64_at(cell,8+i*8));
        let connectivity = stable.map(|id| by_id.get(&id).copied()).into_iter().collect::<Option<Vec<_>>>()
            .ok_or_else(|| invalid("cell references absent stable vertex"))?;
        source_cells.push(connectivity.try_into().expect("four nodes"));
        let points=xyz(&cell[40..136])?;
        let start=u32::try_from(local_positions.len()).map_err(|_| invalid("local geometry overflow"))?;
        local_cells.push([start,start+1,start+2,start+3]);
        for (local,position) in points.into_iter().enumerate() {
            if position.map(f64::to_bits) != source_positions[*by_id.get(&stable[local]).expect("verified stable vertex") as usize].map(f64::to_bits) {
                return Err(invalid("cell-local coordinates differ from owned source mesh"));
            }
            local_positions.push(position);
            local_ids.push(ArtifactSampleIdentity::CellLocal {source_element_ordinal:element,local_vertex_index:local as u8,stable_vertex_id:stable[local]});
        }
        center_positions.push(xyz(&cell[232..256])?[0]); center_ids.push(ArtifactSampleIdentity::CellCenter(element));
    }
    let native_mesh=loaded.metadata["resolved_execution"]["mesh_revision"].as_str().ok_or_else(|| invalid("native mesh identity absent"))?;
    let native_topology=loaded.metadata["resolved_execution"]["topology_revision"].as_str().ok_or_else(|| invalid("native topology identity absent"))?;
    insert(&mut fields,"V_electric","V_electric",f64s(bytes(&loaded,"v_raw")?)?,&owner,source_positions,
        ids.into_iter().map(ArtifactSampleIdentity::SourceNode).collect(),Some(source_cells),ArtifactSampleIndexing::SourceNodes,observation_revision,native_mesh,native_topology,None)?;
    insert(&mut fields,"J_charge","J_charge",f64s(bytes(&loaded,"j_local_raw")?)?,&owner,local_positions,local_ids,
        Some(local_cells),ArtifactSampleIndexing::Tet4CellLocalNodes,observation_revision,native_mesh,native_topology,None)?;
    insert(&mut fields,"J_charge:cell_centers","J_charge",f64s(bytes(&loaded,"j_center_raw")?)?,&owner,center_positions,center_ids,
        None,ArtifactSampleIndexing::CellCenters,observation_revision,native_mesh,native_topology,None)?;
    let samples=xyz(bytes(&loaded,"sample_xyz")?)?;
    let sample_cells=tet4(bytes(&loaded,"sample_cells")?,samples.len())?;
    let sample_domain:fullmag_ir::FieldTargetIR=serde_json::from_value(loaded.metadata["sample_carrier"]["domain"].clone())
        .map_err(|_|invalid("verified H sampling domain absent"))?;
    let sample_topology=loaded.metadata["sample_carrier"]["topology_digest"].as_str().ok_or_else(|| invalid("sampling identity absent"))?;
    insert(&mut fields,"H_ant","H_ant",f64s(bytes(&loaded,"h_raw")?)?,&owner,samples.clone(),
        (0..samples.len()).map(|i| ArtifactSampleIdentity::SampleOrdinal(i as u64)).collect(),Some(sample_cells),
        ArtifactSampleIndexing::SampleNodes,observation_revision,sample_topology,sample_topology,Some(&sample_domain))?;
    Ok(fields)
}

pub(crate) fn from_external(
    owner: ArtifactFieldOwnerBinding, loaded: LoadedAntennaExternalLeadSolution, observation_revision: u64,
) -> Result<VerifiedInspectionFields, ApiError> {
    let mut fields=VerifiedInspectionFields {fields:BTreeMap::new(),retained_bytes:0};
    let display=loaded.device_display().map_err(|e| invalid(&e.message))?;
    let native_mesh=&loaded.manifest.input_pins.device_mesh_ownership_sha256;
    let native_topology=&loaded.manifest.input_pins.combined_mesh_material_sha256;
    insert(&mut fields,"V_electric","V_electric",loaded.device_potential_v.clone(),&owner,display.positions_xyz_m,
        loaded.device_vertex_ids.iter().copied().map(ArtifactSampleIdentity::SourceNode).collect(),Some(display.tet4_cells),
        ArtifactSampleIndexing::SourceNodes,observation_revision,native_mesh,native_topology,None)?;
    if let Some(current)=&loaded.device_current {
        let mut points=Vec::new();let mut ids=Vec::new();let mut cells=Vec::new();let mut values=Vec::new();
        let mut centers=Vec::new();let mut center_ids=Vec::new();let mut center_values=Vec::new();
        for cell in &current.cells {
            let start=u32::try_from(points.len()).map_err(|_| invalid("local geometry count overflow"))?;
            cells.push([start,start+1,start+2,start+3]);
            for local in 0..4 {points.push(cell.vertex_xyz_m[local]);values.extend_from_slice(&cell.vertex_j_apm2[local]);
                ids.push(ArtifactSampleIdentity::CellLocal{source_element_ordinal:cell.source_element_index,local_vertex_index:local as u8,stable_vertex_id:cell.vertex_ids[local]});}
            centers.push(cell.center_xyz_m);center_ids.push(ArtifactSampleIdentity::CellCenter(cell.source_element_index));center_values.extend_from_slice(&cell.center_j_apm2);
        }
        insert(&mut fields,"J_charge","J_charge",values,&owner,points,ids,Some(cells),ArtifactSampleIndexing::Tet4CellLocalNodes,observation_revision,native_mesh,native_topology,None)?;
        insert(&mut fields,"J_charge:cell_centers","J_charge",center_values,&owner,centers,center_ids,None,ArtifactSampleIndexing::CellCenters,observation_revision,native_mesh,native_topology,None)?;
    }
    let positions=loaded.sample_positions_xyz_m;
    let sampling_identity=&loaded.manifest.sampling_carrier.topology_digest;
    let sample_ids=(0..positions.len()).map(|i| ArtifactSampleIdentity::SampleOrdinal(i as u64)).collect();
    insert(&mut fields,"H_ant","H_ant",loaded.magnetic_field_xyz_apm.into_iter().flatten().collect(),&owner,positions,sample_ids,
        None,ArtifactSampleIndexing::PointSamples,observation_revision,sampling_identity,sampling_identity,Some(&loaded.manifest.sampling_carrier.domain))?;
    Ok(fields)
}

pub(crate) fn locator(field: &ResolvedSpatialField<'_>) -> Result<ArtifactFieldLocatorResource, ApiError> {
    let super::resolved_spatial_field::SpatialFieldCarrier::ArtifactSamples(carrier)=&field.carrier else {
        return Err(invalid("field is not an artifact sample carrier"));
    };
    Ok(ArtifactFieldLocatorResource {owner:carrier.owner.clone(),carrier_scope_kind:carrier.carrier_scope_kind.clone(),
        carrier_scope_id:carrier.carrier_scope_id.clone(),carrier_id:format!("artifact:{}:{}",carrier.carrier_digest,carrier.indexing.as_str()),
        carrier_digest:carrier.carrier_digest.clone(),carrier_revision:carrier.carrier_revision.to_string(),indexing:carrier.indexing,
        sample_count:carrier.positions_xyz_m.len() as u64,coordinate_frame:"world".into(),coordinate_unit:"m".into(),topology_binary_schema:"FMMT.v2".into()})
}

pub(crate) async fn resolve(
    state: &Arc<crate::types::AppState>, quantity: &str, stage: Option<&str>, carrier_id: Option<&str>, view: Option<&str>,
) -> Result<Option<Arc<ResolvedSpatialField<'static>>>, ApiError> {
    // Ordinary live requests must never discover a historical inspection implicitly.
    let Some(stage) = stage else {
        if carrier_id.is_some_and(|id| id.starts_with("artifact:")) {
            return Err(ApiError::bad_request("artifact field requires an exact stage_id"));
        }
        return Ok(None);
    };
    if stage.is_empty() || stage.len() > 4096 || stage.contains('\0') {
        return Err(ApiError::bad_request("invalid inspection stage_id"));
    }
    let explicit_artifact = carrier_id.is_some_and(|id| id.starts_with("artifact:"));
    if !matches!(quantity,"V_electric"|"J_charge"|"H_ant") {
        if explicit_artifact {
            return Err(ApiError::not_found("inspection has no requested quantity"));
        }
        // A stage also scopes ordinary historical fields, including hysteresis m.
        return Ok(None);
    }
    let Some(bundle)=super::antenna_inspection::verified_inspection_fields(state,Some(stage)).await? else {
        if explicit_artifact {
            return Err(ApiError::not_found("inspection stage has no verified fields"));
        }
        return Ok(None);
    };
    let key=match view.unwrap_or("full") {
        "full"=>quantity.to_owned(),
        "cell_centers" if quantity=="J_charge"=>"J_charge:cell_centers".into(),
        _=>return Err(ApiError::bad_request("inspection field view must be full or explicit J cell_centers")),
    };
    let field=bundle.fields.get(&key).ok_or_else(|| ApiError::not_found("verified inspection has no requested field view"))?;
    let locator=locator(field)?;
    if carrier_id.is_some_and(|id| id!=locator.carrier_id) {return Err(ApiError::conflict("inspection carrier ID mismatch"));}
    Ok(Some(Arc::clone(field)))
}

async fn all_fields(state: &Arc<crate::types::AppState>, include_centers:bool)
    -> Result<Vec<Arc<ResolvedSpatialField<'static>>>,ApiError> {
    let mut stages={let current=state.current_live_state.read().await;
        current.as_ref().and_then(|s|s.stage_execution.as_ref()).map(|execution| execution.stages.iter()
            .filter(|stage|stage.artifact_refs.iter().any(|path| std::path::Path::new(path).file_name()
                .is_some_and(|name| name=="antenna_closed_loop_stage_output.v2.json" || name=="antenna_external_lead_stage_output.v1.json")))
            .filter_map(|stage| stage.stage_id.clone()).collect::<Vec<_>>()).unwrap_or_default()};
    for stage in super::accepted_inspection_fields::stage_ids(state).await? {
        if stages.contains(&stage) { return Err(invalid("legacy and accepted inspections share a runtime owner")); }
        stages.push(stage);
    }
    let mut retained_bytes=0usize;
    let mut fields=Vec::new();
    for stage in stages {match super::antenna_inspection::verified_inspection_fields(state,Some(&stage)).await {
        Ok(Some(bundle))=>{
            retained_bytes=retained_bytes.checked_add(bundle.retained_bytes)
                .ok_or_else(||invalid("inspection discovery allocation overflow"))?;
            if retained_bytes>128*1024*1024 {
                return Err(ApiError::unprocessable("inspection field discovery exceeds 128 MiB; select one exact stage"));
            }
            fields.extend(bundle.fields.iter().filter(|(key,_)|include_centers || !key.contains(':')).map(|(_,field)|Arc::clone(field)));
        },
        Ok(None)=>{},
        Err(error) if error.code.as_deref()==Some("inspection_has_no_payload")=>{},
        Err(error)=>return Err(error),
    }}
    Ok(fields)
}

/// Binary artifacts require an exact owner and immutable carrier revision, even for 304/range requests.
pub(crate) fn require_binary_pins(
    stage: Option<&str>, carrier_id: Option<&str>, revision: Option<&str>,
) -> Result<(), ApiError> {
    let stage=stage.ok_or_else(|| ApiError::bad_request("artifact binary requires stage_id"))?;
    if stage.trim().is_empty() || stage.len()>4096 || stage.contains('\0') {
        return Err(ApiError::bad_request("invalid inspection stage_id"));
    }
    if !carrier_id.is_some_and(|id| id.starts_with("artifact:") && id.len()>9) {
        return Err(ApiError::bad_request("artifact binary requires carrier_id"));
    }
    let revision=revision.ok_or_else(|| ApiError::bad_request("artifact binary requires expected_carrier_revision"))?;
    let parsed=revision.parse::<u64>().map_err(|_| ApiError::bad_request("invalid artifact carrier revision"))?;
    if parsed==0 || parsed.to_string()!=revision {
        return Err(ApiError::bad_request("artifact carrier revision must be canonical nonzero decimal u64"));
    }
    Ok(())
}

pub(crate) fn validate_scope(
    field: &ResolvedSpatialField<'_>, scope: Option<&str>, scope_id: Option<&str>, expected_revision: Option<&str>, owner_object_id: Option<&str>,
) -> Result<ArtifactFieldLocatorResource,ApiError> {
    let locator=locator(field)?;
    if owner_object_id.is_some_and(|id| id != locator.owner.object_id) {
        return Err(ApiError::conflict("inspection field owner object mismatch"));
    }
    match scope.unwrap_or("full") {
        "full" if scope_id.is_none_or(str::is_empty)=>{},
        "object" if locator.carrier_scope_kind=="object" && scope_id==locator.carrier_scope_id.as_deref()=>{},
        _=>return Err(ApiError::bad_request("inspection samples provide only their exact owned object or full carrier")),
    }
    if let Some(revision)=expected_revision {
        let parsed=revision.parse::<u64>().map_err(|_| ApiError::bad_request("invalid artifact carrier revision"))?;
        if parsed==0 || parsed.to_string()!=revision {return Err(ApiError::bad_request("artifact carrier revision must be canonical nonzero decimal u64"));}
        if revision!=locator.carrier_revision {
            return Err(ApiError::conflict("stale artifact carrier revision"));
        }
    }
    Ok(locator)
}

pub(crate) fn capability(field: &ResolvedSpatialField<'_>) -> Result<fullmag_runner::ResolvedQuantityCapability,ApiError> {
    let spec=fullmag_quantities::quantity_spec(&field.quantity_id).ok_or_else(|| invalid("unknown artifact quantity"))?;
    if spec.domain==fullmag_quantities::QuantityDomain::MagneticOnly {return Err(invalid("inspection provider cannot supply magnetic-only quantities"));}
    let locator=locator(field)?;
    Ok(fullmag_runner::ResolvedQuantityCapability {
        quantity_id:field.quantity_id.clone(),provider:fullmag_runner::QuantityProviderCapability::Available,
        request:fullmag_runner::QuantityRequestCapability::FieldVector,materialization:fullmag_runner::QuantityMaterializationCapability::Materialized,
        render:if spec.ui_exposed && spec.interactive_preview && spec.supports_preview_3d {
            fullmag_runner::QuantityRenderCapability::Renderable
        } else {fullmag_runner::QuantityRenderCapability::Unavailable},
        publication:if spec.ui_exposed && spec.interactive_preview {fullmag_runner::QuantityPublicationCapability::Interactive}
            else if spec.supports_export {fullmag_runner::QuantityPublicationCapability::ExportOnly}
            else {fullmag_runner::QuantityPublicationCapability::Hidden},
        scope:locator.carrier_scope_kind.clone(),reason_code:Some("historical_inspection_read_only".into()),lane:"artifact_inspection_read_only".into(),precision:"double".into(),
        carriers:vec![fullmag_runner::FieldCarrierDescriptor {carrier_id:locator.carrier_id,carrier_fingerprint:locator.carrier_digest,
            scope:locator.carrier_scope_kind.clone(),scope_kind:locator.carrier_scope_kind,scope_id:locator.carrier_scope_id,components:spec.n_comp,
            indexing:locator.indexing.as_str().into(),view:if locator.indexing==ArtifactSampleIndexing::CellCenters {"cell_centers"} else {"full"}.into(),
            payload_version:Some("FMVP.v6".into()),payload_state:fullmag_runner::FieldPayloadState::Historical}],
    })
}

pub(crate) async fn catalog_fields(state:&Arc<crate::types::AppState>) -> Result<Vec<Arc<ResolvedSpatialField<'static>>>,ApiError> {
    all_fields(state,false).await
}
pub(crate) async fn geometry_field(state:&Arc<crate::types::AppState>, carrier_id:&str, stage:Option<&str>)
    -> Result<Arc<ResolvedSpatialField<'static>>,ApiError> {
    let fields=if let Some(stage)=stage {
        super::antenna_inspection::verified_inspection_fields(state,Some(stage)).await?
            .map(|bundle|bundle.fields.values().cloned().collect::<Vec<_>>()).unwrap_or_default()
    } else {all_fields(state,true).await?};
    let mut matches=fields.into_iter().filter(|field|locator(field).is_ok_and(|l|l.carrier_id==carrier_id));
    let field=matches.next().ok_or_else(||ApiError::not_found("artifact geometry carrier absent"))?;
    if matches.next().is_some() {return Err(invalid("ambiguous artifact geometry owner"));}
    Ok(field)
}
pub(crate) async fn revalidate_owner(state:&Arc<crate::types::AppState>,field:&ResolvedSpatialField<'_>) -> Result<(),ApiError> {
    let expected=locator(field)?;
    let Some(bundle)=super::antenna_inspection::verified_inspection_fields(state,Some(&expected.owner.runtime_stage_id)).await? else {
        return Err(ApiError::conflict("artifact field owner disappeared"));
    };
    let key=if expected.indexing==ArtifactSampleIndexing::CellCenters {format!("{}:cell_centers",field.quantity_id)} else {field.quantity_id.clone()};
    let current=bundle.fields.get(&key).ok_or_else(||invalid("artifact owner lost requested field"))?;
    if locator(current)?!=expected || current.quantity_revision!=field.quantity_revision {return Err(ApiError::conflict("artifact field owner/carrier changed during read"));}
    Ok(())
}


pub(crate) fn ensure_observation(snapshot:&crate::types::SessionStateResponse,field:&ResolvedSpatialField<'_>) -> Result<(),ApiError> {
    let own=locator(field)?;
    if snapshot.session.run_id!=own.owner.run_id || snapshot.state_version!=field.quantity_revision
        || snapshot.mesh_revision!=own.owner.observation_mesh_revision
        || crate::router_v2::handlers::sessions::status::domain_generation_revision(snapshot)!=own.owner.observation_topology_revision {
        return Err(ApiError::conflict("historical inspection observation changed before response"));
    }
    Ok(())
}


/// Resolve one explicit immutable execution; never replace the live solver catalog.
pub(crate) async fn catalog_fields_for_stage(
    state: &Arc<crate::types::AppState>,
    stage: &str,
) -> Result<Vec<Arc<ResolvedSpatialField<'static>>>, ApiError> {
    if stage.trim().is_empty() || stage.len() > 4096 || stage.contains('\0') {
        return Err(ApiError::bad_request("catalog requires a nonempty exact runtime stage"));
    }
    let bundle = super::antenna_inspection::verified_inspection_fields(state, Some(stage))
        .await?.ok_or_else(|| ApiError::not_found("retained inspection stage is absent"))?;
    let fields = bundle.fields.iter().filter(|(key, _)| !key.contains(':'))
        .map(|(_, field)| Arc::clone(field)).collect::<Vec<_>>();
    if fields.is_empty() {
        return Err(ApiError::not_found("retained inspection stage has no fields"));
    }
    for field in &fields {
        if locator(field)?.owner.runtime_stage_id != stage {
            return Err(invalid("catalog owner differs from requested stage"));
        }
    }
    Ok(fields)
}

pub(crate) async fn field_catalog_for_stage(
    state: &Arc<crate::types::AppState>,
    stage: &str,
) -> Result<crate::schemas::fields::FieldCatalog, ApiError> {
    use crate::schemas::fields::{FieldCatalog, FieldDescriptor, FieldMaterializationState};
    let request_context = crate::capture_current_live_request_context(state).await?;
    let fields = catalog_fields_for_stage(state, stage).await?;
    let locators = fields.iter().map(|field| locator(field)).collect::<Result<Vec<_>, _>>()?;
    let digest = format!("{:x}", Sha256::digest(serde_json::to_vec(&locators)
        .map_err(|error| ApiError::internal(error.to_string()))?));
    // JSON catalog revisions must remain lossless in JavaScript. Carrier u64 stays a string.
    let revision = u64::from_str_radix(&digest[..13], 16)
        .map_err(|_| invalid("catalog fingerprint is invalid"))?;
    let quantities = fields.iter().zip(locators).map(|(field, locator)| {
        let spec = fullmag_quantities::quantity_spec(&field.quantity_id)
            .ok_or_else(|| invalid("unknown retained quantity"))?;
        Ok(FieldDescriptor {
            artifact_field_locator: Some(locator.clone()), quantity_id: field.quantity_id.clone(),
            label: spec.label.into(), ui_exposed: spec.ui_exposed,
            spatial: spec.supports_preview_3d && spec.interactive_preview,
            domain: spec.domain.as_str().into(), kind: spec.shape.as_api_kind().into(),
            components: spec.n_comp, location: locator.indexing.as_str().into(), unit: spec.unit.into(),
            field_revision: field.quantity_revision, domain_generation_id: locator.carrier_digest,
            available: true, source_step: 0, source_time_seconds: None,
            source_revision: field.quantity_revision, materialized_at_unix_ms: 0, stale_by_steps: 0,
            materialization_wall_time_ns: 0, state: FieldMaterializationState::StaleComplete,
            materialization_reason_code: Some("historical_inspection_read_only".into()),
            materialization_error: None, resolved_capability: Some(capability(field)?.into()),
        })
    }).collect::<Result<Vec<_>, ApiError>>()?;
    let guard = state.current_live_state.read().await;
    let snapshot = guard.as_ref().ok_or_else(|| ApiError::not_found("inspection observation absent"))?;
    crate::ensure_current_live_request_context(snapshot, &request_context,
        state.current_live_session_epoch.load(std::sync::atomic::Ordering::Acquire))?;
    for field in &fields { ensure_observation(snapshot, field)?; }
    Ok(FieldCatalog { revision, domain_generation_id: format!("artifact-catalog:{digest}"), quantities })
}
