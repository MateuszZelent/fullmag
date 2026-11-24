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
    sample_carrier: Option<super::antenna::AntennaSampleCarrierResource>,
) -> Result<(), ApiError> {
    let (carrier_scope_kind,carrier_scope_id)=match sampling_domain {
        None=>("object",Some(owner.object_id.as_str())),
        Some(fullmag_ir::FieldTargetIR::Object{object_id})=>("object",Some(object_id.as_str())),
        Some(fullmag_ir::FieldTargetIR::Global{})=>("full",None),
        Some(fullmag_ir::FieldTargetIR::Region{..})=>return Err(invalid("region inspection sampling is not implemented")),
    };
    // This checks internal descriptor/argument consistency only. The cold-bundle
    // verifier above this adapter establishes the independent accepted binding.
    if sample_carrier.as_ref().is_some_and(|carrier|
        carrier.topology_digest != native_mesh_identity || carrier.topology_digest != native_topology_identity)
    {
        return Err(invalid("verified sampling descriptor topology identity mismatch"));
    }
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
    let sampling_bytes = match &sample_carrier {
        None => 0,
        Some(carrier) => {
            let domain_bytes = match &carrier.domain {
                super::antenna::AntennaFieldTargetResource::Global => Some(0),
                super::antenna::AntennaFieldTargetResource::Object { object_id } => Some(object_id.capacity()),
                super::antenna::AntennaFieldTargetResource::Region { object_id, region_id } =>
                    object_id.capacity().checked_add(region_id.capacity()),
            }.ok_or_else(|| invalid("artifact sampling allocation overflow"))?;
            [carrier.carrier_kind.capacity(), carrier.location.capacity(), carrier.topology_digest.capacity()]
                .into_iter().try_fold(domain_bytes, |sum, capacity| sum.checked_add(capacity))
                .ok_or_else(|| invalid("artifact sampling allocation overflow"))?
        }
    };
    let retained = values.capacity().checked_mul(8).and_then(|n| positions.capacity().checked_mul(24).and_then(|p| n.checked_add(p)))
        .and_then(|n| identities.capacity().checked_mul(std::mem::size_of::<ArtifactSampleIdentity>()).and_then(|p| n.checked_add(p)))
        .and_then(|n| topology.as_ref().map_or(Some(n), |m| m.nodes.capacity().checked_mul(24)
            .and_then(|a| m.cells.nodes.capacity().checked_mul(4).and_then(|b| a.checked_add(b)))
            .and_then(|a| m.cells.offsets.capacity().checked_mul(4).and_then(|b| a.checked_add(b)))
            .and_then(|a| m.cells.types.capacity().checked_mul(std::mem::size_of::<fullmag_ir::FemCellTypeIR>()).and_then(|b| a.checked_add(b)))
            .and_then(|a| m.cells.global_ordinals.capacity().checked_mul(8).and_then(|b| a.checked_add(b)))
            .and_then(|a| n.checked_add(a))))
        // Conservatively bound owner strings, map/Arc/field records, mesh and empty CSR overhead.
        .and_then(|n|n.checked_add(owner_bytes)).and_then(|n|n.checked_add(sampling_bytes))
        .and_then(|n|n.checked_add(256*1024))
        .ok_or_else(|| invalid("artifact view memory bound overflow"))?;
    fields.retained_bytes = fields.retained_bytes.checked_add(retained).ok_or_else(|| invalid("artifact cache memory overflow"))?;
    let carrier = Arc::new(ArtifactSampleCarrier {owner:owner.clone(),carrier_scope_kind:carrier_scope_kind.into(),
        carrier_scope_id:carrier_scope_id.map(str::to_owned),indexing,positions_xyz_m:positions,
        sample_identity:identities,topology,carrier_digest:digest,carrier_revision,sample_carrier});
    fields.fields.insert(key.into(),Arc::new(ResolvedSpatialField::from_artifact_samples(quantity,values,carrier,observation_revision)?));
    Ok(())
}

const CLOSED_LOOP_VIEW_BUDGET_MIB: usize = 256;

fn closed_loop_view_admission(payload_bytes: usize, projected_bytes: usize) -> Result<(), ApiError> {
    let view_bound = projected_bytes.checked_mul(16).and_then(|n| n.checked_add(payload_bytes))
        .and_then(|n| n.checked_add(2 * 1024 * 1024))
        .ok_or_else(|| invalid("inspection view admission overflow"))?;
    if view_bound > CLOSED_LOOP_VIEW_BUDGET_MIB * 1024 * 1024 {
        return Err(invalid(&format!(
            "inspection views require {view_bound} bytes, above the {CLOSED_LOOP_VIEW_BUDGET_MIB} MiB materialization budget"
        )));
    }
    Ok(())
}

pub(crate) fn from_closed(
    owner: ArtifactFieldOwnerBinding, loaded: LoadedAntennaClosedLoopInspection, observation_revision: u64,
) -> Result<VerifiedInspectionFields, ApiError> {
    let mut fields = VerifiedInspectionFields {fields:BTreeMap::new(),retained_bytes:0};
    // Count the already loaded buffers once; evidence and source preimages are
    // verified inputs, but are neither expanded into fields nor retained by them.
    let payload_bytes = loaded.payloads.values().try_fold(0usize, |sum, payload|
        sum.checked_add(payload.capacity())).ok_or_else(|| invalid("inspection payload size overflow"))?;
    // Only these payloads allocate source/local/sample views. The same 16x bound
    // covers Vec growth, identities, CSR, the stable-ID map and four field records.
    let projected_bytes = ["vertex_xyz", "stable_vertex_ids", "cells", "v_raw",
        "j_local_raw", "j_center_raw", "sample_xyz", "sample_cells", "h_raw"]
        .iter().try_fold(0usize, |sum, key| {
            sum.checked_add(bytes(&loaded, key)?.len())
                .ok_or_else(|| invalid("inspection projected payload size overflow"))
        })?;
    closed_loop_view_admission(payload_bytes, projected_bytes)?;
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
        ids.into_iter().map(ArtifactSampleIdentity::SourceNode).collect(),Some(source_cells),ArtifactSampleIndexing::SourceNodes,observation_revision,native_mesh,native_topology,None,None)?;
    insert(&mut fields,"J_charge","J_charge",f64s(bytes(&loaded,"j_local_raw")?)?,&owner,local_positions,local_ids,
        Some(local_cells),ArtifactSampleIndexing::Tet4CellLocalNodes,observation_revision,native_mesh,native_topology,None,None)?;
    insert(&mut fields,"J_charge:cell_centers","J_charge",f64s(bytes(&loaded,"j_center_raw")?)?,&owner,center_positions,center_ids,
        None,ArtifactSampleIndexing::CellCenters,observation_revision,native_mesh,native_topology,None,None)?;
    let samples=xyz(bytes(&loaded,"sample_xyz")?)?;
    let sample_cells=tet4(bytes(&loaded,"sample_cells")?,samples.len())?;
    let sample_domain:fullmag_ir::FieldTargetIR=serde_json::from_value(loaded.metadata["sample_carrier"]["domain"].clone())
        .map_err(|_|invalid("verified H sampling domain absent"))?;
    // The runner's full cold-bundle verifier has bound this descriptor to the
    // accepted source, sampling payloads and signatures before this adapter.
    let sample_carrier: super::antenna::AntennaSampleCarrierResource =
        serde_json::from_value(loaded.metadata["sample_carrier"].clone())
            .map_err(|_| invalid("verified H sampling descriptor absent"))?;
    let sample_topology=sample_carrier.topology_digest.clone();
    insert(&mut fields,"H_ant","H_ant",f64s(bytes(&loaded,"h_raw")?)?,&owner,samples.clone(),
        (0..samples.len()).map(|i| ArtifactSampleIdentity::SampleOrdinal(i as u64)).collect(),Some(sample_cells),
        ArtifactSampleIndexing::SampleNodes,observation_revision,&sample_topology,&sample_topology,Some(&sample_domain),Some(sample_carrier))?;
    Ok(fields)
}

fn retained_view_admission(payload_bytes: usize, projected_bytes: usize) -> Result<(), ApiError> {
    let bound = projected_bytes.checked_mul(16).and_then(|n| n.checked_add(payload_bytes))
        .and_then(|n| n.checked_add(2 * 1024 * 1024))
        .ok_or_else(|| invalid("retained field view admission overflow"))?;
    if bound > 128 * 1024 * 1024 {
        return Err(invalid("retained field views exceed the 128 MiB materialization budget"));
    }
    Ok(())
}

/// Adapt only the child's verified H and its own target mesh, never parent V/J.
/// Durable ownership and full parent physics are verified by the runtime reader.
pub(crate) fn from_retained(
    owner: ArtifactFieldOwnerBinding,
    loaded: fullmag_antenna_artifacts::retained_current::RetainedCurrentFieldBundleAny,
    observation_revision: u64,
) -> Result<VerifiedInspectionFields, ApiError> {
    loaded.manifest().validate_payloads(loaded.payloads())
        .map_err(|_| invalid("retained field payload integrity differs"))?;
    let manifest = loaded.manifest();
    if owner.authored_stage_id != manifest.stage_id()
        || owner.module_id != manifest.current_transport_id()
        || owner.object_id != manifest.source_object_id()
        || owner.output_id != manifest.output_id()
        || owner.source_digest != manifest.parent().source.accepted_source_state_digest
        || owner.content_digest != manifest.content_digest()
        || owner.native_mesh_identity != manifest.sample_carrier().topology_digest
        || owner.native_topology_identity != manifest.sample_carrier().topology_digest
        || owner.accepted_artifact.as_ref().is_none_or(|accepted|
            accepted.project_id != manifest.parent().owner.project_id) {
        return Err(invalid("retained field view differs from verified child ownership"));
    }
    let payload_bytes = loaded.payloads().values().try_fold(0usize, |sum, payload|
        sum.checked_add(payload.capacity())).ok_or_else(|| invalid("retained payload size overflow"))?;
    let projected_bytes = ["sample_xyz", "sample_cells", "h_raw"].iter()
        .try_fold(0usize, |sum, key| sum.checked_add(loaded.payloads()[*key].len()))
        .ok_or_else(|| invalid("retained field view size overflow"))?;
    retained_view_admission(payload_bytes, projected_bytes)?;
    let samples = xyz(&loaded.payloads()["sample_xyz"])?;
    let cells = tet4(&loaded.payloads()["sample_cells"], samples.len())?;
    let sample_carrier: super::antenna::AntennaSampleCarrierResource =
        serde_json::from_value(serde_json::to_value(manifest.sample_carrier())
            .map_err(|e| ApiError::internal(e.to_string()))?)
            .map_err(|_| invalid("retained field sampling descriptor differs"))?;
    let topology = &manifest.sample_carrier().topology_digest;
    let mut fields = VerifiedInspectionFields { fields: BTreeMap::new(), retained_bytes: 0 };
    let identities = (0..samples.len()).map(|i| ArtifactSampleIdentity::SampleOrdinal(i as u64)).collect();
    insert(&mut fields, "H_ant", "H_ant", f64s(&loaded.payloads()["h_raw"])?, &owner,
        samples, identities, Some(cells), ArtifactSampleIndexing::SampleNodes,
        observation_revision, topology, topology, Some(&manifest.sample_carrier().domain), Some(sample_carrier))?;
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
        ArtifactSampleIndexing::SourceNodes,observation_revision,native_mesh,native_topology,None,None)?;
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
        insert(&mut fields,"J_charge","J_charge",values,&owner,points,ids,Some(cells),ArtifactSampleIndexing::Tet4CellLocalNodes,observation_revision,native_mesh,native_topology,None,None)?;
        insert(&mut fields,"J_charge:cell_centers","J_charge",center_values,&owner,centers,center_ids,None,ArtifactSampleIndexing::CellCenters,observation_revision,native_mesh,native_topology,None,None)?;
    }
    let positions=loaded.sample_positions_xyz_m;
    let sampling_identity=&loaded.manifest.sampling_carrier.topology_digest;
    let sample_ids=(0..positions.len()).map(|i| ArtifactSampleIdentity::SampleOrdinal(i as u64)).collect();
    insert(&mut fields,"H_ant","H_ant",loaded.magnetic_field_xyz_apm.into_iter().flatten().collect(),&owner,positions,sample_ids,
        None,ArtifactSampleIndexing::PointSamples,observation_revision,sampling_identity,sampling_identity,Some(&loaded.manifest.sampling_carrier.domain),None)?;
    Ok(fields)
}

pub(crate) fn locator(field: &ResolvedSpatialField<'_>) -> Result<ArtifactFieldLocatorResource, ApiError> {
    let super::resolved_spatial_field::SpatialFieldCarrier::ArtifactSamples(carrier)=&field.carrier else {
        return Err(invalid("field is not an artifact sample carrier"));
    };
    Ok(ArtifactFieldLocatorResource {sample_carrier:carrier.sample_carrier.clone(),owner:carrier.owner.clone(),carrier_scope_kind:carrier.carrier_scope_kind.clone(),
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
        projections:Vec::new(),
        carriers:vec![fullmag_runner::FieldCarrierDescriptor {carrier_id:locator.carrier_id,carrier_fingerprint:locator.carrier_digest,
            scope:locator.carrier_scope_kind.clone(),scope_kind:locator.carrier_scope_kind,scope_id:locator.carrier_scope_id,components:spec.n_comp,
            indexing:locator.indexing.as_str().into(),view:if locator.indexing==ArtifactSampleIndexing::CellCenters {"cell_centers"} else {"full"}.into(),
            payload_version:Some("FMVP.v6".into()),payload_state:fullmag_runner::FieldPayloadState::Historical}],
    })
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

#[cfg(test)]
mod sample_carrier_tests {
    use super::*;

    #[test]
    fn closed_loop_admission_covers_the_measured_airbox_bundle() {
        const MIB: usize = 1024 * 1024;
        assert!(closed_loop_view_admission(64 * MIB, 8 * MIB).is_ok());
        assert!(closed_loop_view_admission(126 * MIB, 8 * MIB).is_ok());
        assert!(closed_loop_view_admission(126 * MIB + 1, 8 * MIB).is_err());
        assert!(closed_loop_view_admission(0, usize::MAX).is_err());
    }
    use super::super::resolved_spatial_field::SpatialFieldCarrier;
    use crate::schemas::fields::ArtifactFieldLocatorResource;

    pub(super) fn owner() -> ArtifactFieldOwnerBinding {
        ArtifactFieldOwnerBinding {
            session_id: "session".into(), session_epoch: "1".into(), request_scope_epoch: "scope".into(),
            run_id: "run".into(), runtime_stage_id: "runtime-stage".into(), authored_stage_id: "inspect".into(),
            module_id: "transport".into(), object_id: "antenna".into(), output_id: "inspection".into(),
            source_digest: format!("sha256:{}", "b".repeat(64)),
            content_digest: format!("sha256:{}", "c".repeat(64)),
            observation_mesh_revision: 1, observation_topology_revision: 1,
            historical_inspection: true, accepted_artifact: None,
            native_mesh_identity: "source-mesh".into(), native_topology_identity: "source-topology".into(),
        }
    }

    fn f64_bytes(values: impl IntoIterator<Item = f64>) -> Vec<u8> {
        values.into_iter().flat_map(f64::to_le_bytes).collect()
    }

    // Adapter fixture only: production verifies the complete immutable bundle first.
    fn loaded(kind: &str) -> LoadedAntennaClosedLoopInspection {
        let source = [[0., 0., 0.], [1e-6, 0., 0.], [0., 1e-6, 0.], [0., 0., 1e-6]];
        let mut samples = source.to_vec();
        samples.extend((0..10).map(|i| [(i + 1) as f64 * 1e-7, 1e-7, 1e-7]));
        let mut cell = vec![0; 280];
        for (local, id) in (1_u64..=4).enumerate() {
            cell[8 + local * 8..16 + local * 8].copy_from_slice(&id.to_le_bytes());
        }
        cell[40..136].copy_from_slice(&f64_bytes(source.into_iter().flatten()));
        cell[232..256].copy_from_slice(&f64_bytes([2.5e-7; 3]));
        LoadedAntennaClosedLoopInspection {
            metadata: serde_json::json!({
                "resolved_execution": {"mesh_revision": "source-mesh", "topology_revision": "source-topology"},
                "sample_carrier": {"domain": {"kind": "global"}, "carrier_kind": kind,
                    "location": "node", "topology_digest": format!("sha256:{}", "d".repeat(64))}
            }),
            payloads: BTreeMap::from([
                ("vertex_xyz".into(), f64_bytes(source.into_iter().flatten())),
                ("stable_vertex_ids".into(), (1_u64..=4).flat_map(u64::to_le_bytes).collect()),
                ("cells".into(), cell),
                ("v_raw".into(), f64_bytes([1.; 4])),
                ("j_local_raw".into(), f64_bytes([1.; 12])),
                ("j_center_raw".into(), f64_bytes([1.; 3])),
                ("sample_xyz".into(), f64_bytes(samples.into_iter().flatten())),
                ("sample_cells".into(), [0_u32, 1, 2, 3].into_iter().flat_map(u32::to_le_bytes).collect()),
                ("h_raw".into(), f64_bytes([1.; 42])),
            ]),
        }
    }

    #[test]
    fn closed_h_preserves_exact_verified_sample_descriptor_and_conductor_fields_do_not() {
        for (domain, kind, expected_scope, expected_scope_id) in [
            (serde_json::json!({"kind": "global"}), "fem_domain_mesh_asset", "full", None),
            (serde_json::json!({"kind": "object", "object_id": "stable-probe"}),
                "fem_mesh_asset:probe-geometry", "object", Some("stable-probe")),
        ] {
            let mut loaded = loaded(kind);
            loaded.metadata["sample_carrier"]["domain"] = domain;
            let expected = loaded.metadata["sample_carrier"].clone();
            let fields = from_closed(owner(), loaded, 1).unwrap();
            let h = locator(&fields.fields["H_ant"]).unwrap();
            let h_json = serde_json::to_value(&h).unwrap();
            assert_eq!(h_json["sample_carrier"], expected);
            assert_eq!(h.carrier_scope_kind, expected_scope);
            assert_eq!(h.carrier_scope_id.as_deref(), expected_scope_id);
            assert_eq!(h.sample_count, 14);
            // Full-carrier scope and count alone do not prove Universe identity.
            for key in ["V_electric", "J_charge", "J_charge:cell_centers"] {
                let source = locator(&fields.fields[key]).unwrap();
                assert!(source.sample_carrier.is_none());
                assert!(serde_json::to_value(source).unwrap().get("sample_carrier").is_none());
            }
            let mut legacy = h_json.clone();
            legacy.as_object_mut().unwrap().remove("sample_carrier");
            let legacy: ArtifactFieldLocatorResource = serde_json::from_value(legacy).unwrap();
            assert!(legacy.sample_carrier.is_none());
            assert_eq!(legacy.carrier_id, h.carrier_id);
            assert_eq!(legacy.carrier_digest, h.carrier_digest);
            assert_eq!(legacy.carrier_revision, h.carrier_revision);
        }
    }

    #[test]
    fn closed_h_rejects_malformed_sampling_descriptor_without_downgrading_to_legacy() {
        for (key, value) in [
            ("location", serde_json::json!("cell")),
            ("carrier_kind", serde_json::json!("unknown")),
            ("topology_digest", serde_json::json!("sha256:invalid")),
        ] {
            let mut loaded = loaded("fem_domain_mesh_asset");
            loaded.metadata["sample_carrier"][key] = value;
            assert!(from_closed(owner(), loaded, 1).is_err(), "{key}");
        }
        let mut loaded = loaded("fem_domain_mesh_asset");
        loaded.metadata["sample_carrier"].as_object_mut().unwrap().remove("carrier_kind");
        assert!(from_closed(owner(), loaded, 1).is_err());
    }

    #[test]
    fn closed_h_rejects_crossed_sampling_domain_and_kind_families() {
        assert!(from_closed(owner(), loaded("fem_mesh_asset:probe-geometry"), 1).is_err());
        let mut object_with_domain_mesh = loaded("fem_domain_mesh_asset");
        object_with_domain_mesh.metadata["sample_carrier"]["domain"] =
            serde_json::json!({"kind": "object", "object_id": "stable-probe"});
        assert!(from_closed(owner(), object_with_domain_mesh, 1).is_err());
    }

    #[test]
    fn h_descriptor_cannot_be_reused_as_a_conductor_field_or_foreign_scope() {
        let fields = from_closed(owner(), loaded("fem_domain_mesh_asset"), 1).unwrap();
        let SpatialFieldCarrier::ArtifactSamples(carrier) = &fields.fields["H_ant"].carrier else {
            panic!("artifact samples expected");
        };
        assert!(ResolvedSpatialField::from_artifact_samples("J_charge", vec![1.; 42], Arc::clone(carrier), 1).is_err());
        let mut foreign = (**carrier).clone();
        foreign.carrier_scope_kind = "object".into();
        foreign.carrier_scope_id = Some("antenna".into());
        assert!(ResolvedSpatialField::from_artifact_samples("H_ant", vec![1.; 42], Arc::new(foreign), 1).is_err());

        let mut object_loaded = loaded("fem_mesh_asset:probe-geometry");
        object_loaded.metadata["sample_carrier"]["domain"] =
            serde_json::json!({"kind": "object", "object_id": "stable-probe"});
        let object_fields = from_closed(owner(), object_loaded, 1).unwrap();
        let SpatialFieldCarrier::ArtifactSamples(object_carrier) = &object_fields.fields["H_ant"].carrier else {
            panic!("artifact samples expected");
        };
        let mut wrong_object = (**object_carrier).clone();
        wrong_object.sample_carrier.as_mut().unwrap().domain =
            super::super::antenna::AntennaFieldTargetResource::Object { object_id: "foreign-probe".into() };
        assert!(ResolvedSpatialField::from_artifact_samples("H_ant", vec![1.; 42], Arc::new(wrong_object), 1).is_err());
    }
}

#[cfg(test)]
mod retained_sample_tests {
    use super::*;
    use fullmag_antenna_artifacts::retained_current::*;
    use serde_json::{json, Value};

fn cas(n: char, bytes: u64) -> CasObjectRef {
    CasObjectRef {
        object_ref: n.to_string().repeat(64),
        byte_count: bytes,
    }
}
fn parent_owner() -> ParentInspectionOwner {
    ParentInspectionOwner {
        project_id: "project".into(),
        run_id: "parent-run".into(),
        study_step_id: "parent-step".into(),
        native_stage_id: "parent-native".into(),
        task_id: "parent-task".into(),
        attempt_id: "parent-attempt".into(),
        ownership_epoch: "18446744073709551615".into(),
        artifact_id: "parent-artifact".into(),
        package: cas('a', 256),
        package_codec_id: PARENT_CODEC_ID.into(),
        package_codec_version: PARENT_CODEC_VERSION.into(),
        manifest_schema: PARENT_MANIFEST_SCHEMA.into(),
        output_manifest_artifact_id: "parent-manifest".into(),
        output_manifest: cas('b', 512),
    }
}
fn policy() -> Value {
    json!({"policy_version":"caller_supplied_rt0_surface.inspection.v1",
        "limits":{"total":vec![4000000_u64;14],"per_target":vec![40000_u64;14],"maximum_raw_integer_bits":1024,
        "maximum_reduced_fraction_bits":1024,"maximum_lifetime_peak_rss_bytes":1000000,"guard_interval_events":1,
        "maximum_total_seconds":1800.0,"maximum_target_seconds":90.0},
        "tolerances":{"absolute_field_apm":1e-9,"relative_field":1e-5,"cancellation_floor_apm":1e-6,
        "scalar_relative_80":1e-45,"scalar_relative_120":1e-55,"angle_relative_80":1e-45,"angle_relative_120":1e-55,
        "binary_scalar_epsilon_factor":64.0,"binary_roundoff_epsilon_factor":64.0,
        "binary_cancellation_limit":1e8,"highprecision_cancellation_limit":1e40}})
}
fn fixture() -> (RetainedCurrentFieldManifest, BTreeMap<String, Vec<u8>>) {
    let xyz = [[0., 0., 0.], [1e-6, 0., 0.], [0., 1e-6, 0.], [0., 0., 1e-6]]
        .into_iter()
        .flatten()
        .flat_map(f64::to_le_bytes)
        .collect::<Vec<_>>();
    let h = [1_f64; 12]
        .into_iter()
        .flat_map(f64::to_le_bytes)
        .collect::<Vec<_>>();
    let cells = [0_u32, 1, 2, 3]
        .into_iter()
        .flat_map(u32::to_le_bytes)
        .collect::<Vec<_>>();
    let payloads = BTreeMap::from([
        ("sample_xyz".into(), xyz),
        ("sample_cells".into(), cells),
        ("h_raw".into(), h),
        (
            "evidence".into(),
            b"opaque encoding fixture; NOT physical evidence".to_vec(),
        ),
    ]);
    let reference = |key: &str, layout: &str, unit: &str| {
        let bytes = &payloads[key];
        RetainedCurrentPayloadRef {
            sha256: fullmag_session::hex_sha256(bytes),
            byte_count: bytes.len() as u64,
            layout: layout.into(),
            unit: unit.into(),
        }
    };
    let source = json!({"kind":"published_inspection","project_id":"project","run_id":"parent-run",
        "task_id":"parent-task","attempt_id":"parent-attempt","ownership_epoch":"18446744073709551615",
        "artifact_id":"parent-artifact","object_ref":"a".repeat(64)});
    let execution = json!({"discretization":"fem","device":"cpu","precision":"double","execution_mode":"strict"});
    let stage = json!({"id":"child","source_object_id":"antenna","current_transport_id":"transport",
        "port_mode_ids":["port"],"retained_current_source":source,"model":"quasistatic_conduction_biot_savart3d",
        "oersted_realization":"analytic_rt0_surface","surface_field_policy":policy(),"conductor_mesh_policy":"retained",
        "field_sampling_domain":{"kind":"global"},"target_refs":[],"solver_policy":"inspection",
        "outputs":[{"id":"field","quantity":"H_ant_basis"}]});
    let dig = format!("sha256:{}", "e".repeat(64));
    let mut manifest = RetainedCurrentFieldManifest {
        schema_version: RETAINED_CURRENT_FIELD_SCHEMA.into(),
        status: "inspection_only".into(),
        qualification: "not_verified".into(),
        content_digest: String::new(),
        stage_id: "child".into(),
        output_id: "field".into(),
        port_mode_id: "port".into(),
        source_object_id: "antenna".into(),
        current_transport_id: "transport".into(),
        parent: RetainedCurrentParent {
            owner: parent_owner(),
            source: ParentCurrentDigests {
                prepared_execution_digest: dig.clone(),
                accepted_charge_field_digest: dig.clone(),
                accepted_source_state_digest: dig.clone(),
                view_identity_digest: dig.clone(),
                current_balance_certificate_digest: dig.clone(),
            },
            evidence_capsule: cas('f', 512),
        },
        sample_carrier: fullmag_antenna_artifacts::AntennaSampleCarrier {
            domain: fullmag_ir::FieldTargetIR::Global {},
            carrier_kind: "fem_domain_mesh_asset".into(),
            location: "node".into(),
            topology_digest: dig,
        },
        source_vertex_count: 4,
        source_cell_count: 1,
        target_count: 4,
        sample_cell_count: 1,
        requested_intent: serde_json::from_value(stage).unwrap(),
        resolved_execution: RetainedCurrentResolvedExecution {
            requested_execution: serde_json::from_value(execution.clone()).unwrap(),
            execution: serde_json::from_value(execution).unwrap(),
            operator_version: RETAINED_CURRENT_OPERATOR.into(),
            basis_version: RETAINED_CURRENT_BASIS.into(),
            evidence_schema: RETAINED_CURRENT_EVIDENCE_SCHEMA.into(),
        },
        field_policy: serde_json::from_value(policy()).unwrap(),
        payloads: RetainedCurrentPayloads {
            sample_xyz: reference("sample_xyz", "sample_xyz_f64_le", "m"),
            sample_cells: reference("sample_cells", "tet4_u32_le", "1"),
            h_raw: reference("h_raw", "sample_xyz_f64_le", "A/m"),
            evidence: reference("evidence", RETAINED_CURRENT_EVIDENCE_SCHEMA, "1"),
        },
    };
    manifest.content_digest = manifest.expected_content_digest().unwrap();
    (manifest, payloads)
}

    // Structural display fixture only; the runtime reader must verify physical evidence first.
    fn bundle_and_owner(domain: fullmag_ir::FieldTargetIR) -> (RetainedCurrentFieldBundle, ArtifactFieldOwnerBinding) {
        let (mut manifest, payloads) = fixture();
        manifest.sample_carrier.domain = domain.clone();
        manifest.requested_intent.field_sampling_domain = domain;
        if matches!(manifest.sample_carrier.domain, fullmag_ir::FieldTargetIR::Object { .. }) {
            manifest.sample_carrier.carrier_kind = "fem_mesh_asset:probe-geometry".into();
        }
        manifest.content_digest = manifest.expected_content_digest().unwrap();
        let mut owner = super::sample_carrier_tests::owner();
        owner.run_id = "child-run".into();
        owner.authored_stage_id = manifest.stage_id.clone();
        owner.module_id = manifest.current_transport_id.clone();
        owner.object_id = manifest.source_object_id.clone();
        owner.output_id = manifest.output_id.clone();
        owner.source_digest = manifest.parent.source.accepted_source_state_digest.clone();
        owner.content_digest = manifest.content_digest.clone();
        owner.native_mesh_identity = manifest.sample_carrier.topology_digest.clone();
        owner.native_topology_identity = manifest.sample_carrier.topology_digest.clone();
        owner.accepted_artifact = Some(crate::schemas::fields::AcceptedInspectionArtifactOwner {
            project_id: manifest.parent.owner.project_id.clone(),
            task_id: fullmag_session::task_id_for_study_step(&owner.run_id, &owner.runtime_stage_id).unwrap(),
            attempt_id: "child-attempt".into(), ownership_epoch: "2".into(),
            artifact_id: "child-artifact".into(), object_ref: "1".repeat(64),
        });
        (RetainedCurrentFieldBundle { manifest_bytes: serde_json::to_vec(&manifest).unwrap(), manifest, payloads }, owner)
    }

    // Structural DTQ encoding only; no native solve or scientific qualification.
    fn direct_bundle(domain: fullmag_ir::FieldTargetIR) -> (RetainedCurrentFieldBundleAny, ArtifactFieldOwnerBinding) {
        let (surface, mut owner) = bundle_and_owner(domain);
        let mut payloads = surface.payloads;
        let h = [-3_f64, -0., 0., 6., -9., 0., 1., 2., 3., -1., -2., -3.];
        payloads.insert("h_raw".into(), h.into_iter().flat_map(f64::to_le_bytes).collect());
        let mut value = serde_json::to_value(surface.manifest).unwrap();
        value["schema_version"] = json!(RETAINED_CURRENT_FIELD_SCHEMA_V2);
        value.as_object_mut().unwrap().remove("field_policy");
        let policy = RetainedCurrentDirectFieldPolicyV2::for_solver_policy("volume_inspection_v1").unwrap();
        value["direct_field_policy"] = serde_json::to_value(&policy).unwrap();
        value["requested_intent"]["oersted_realization"] = json!("direct_tetra_quadrature");
        value["requested_intent"].as_object_mut().unwrap().remove("surface_field_policy");
        value["requested_intent"]["solver_policy"] = json!("volume_inspection_v1");
        value["requested_intent"]["retained_source_preparation"] = json!({
            "asset_id":format!("script-file-{}", "1".repeat(64)), "content_sha256":"2".repeat(64)});
        value["resolved_execution"]["operator_version"] = json!(RETAINED_CURRENT_OPERATOR_V2);
        value["resolved_execution"]["evidence_schema"] = json!(RETAINED_CURRENT_EVIDENCE_SCHEMA_V2);
        let mut evidence = b"FM-OEF1-Q3-V2\0\0\0".to_vec();
        evidence.extend_from_slice("e".repeat(64).as_bytes());
        evidence.extend_from_slice("e".repeat(64).as_bytes());
        for n in [4_u64, 4, 0, 0, 4, 4, policy.base_quadrature_order as u64,
            policy.maximum_subdivision_depth as u64, policy.maximum_source_target_pairs,
            policy.maximum_final_leaves_per_target, policy.maximum_kernel_evaluations, policy.maximum_ledger_leaf_visits] {
            evidence.extend_from_slice(&n.to_le_bytes());
        }
        for x in [0_f64, policy.absolute_tolerance_apm, policy.relative_tolerance,
            policy.relative_scale_floor_apm, -3., -1. / 3., 3.] { evidence.extend_from_slice(&x.to_le_bytes()); }
        for (xyz, field) in payloads["sample_xyz"].chunks_exact(24).zip(h.chunks_exact(3)) {
            evidence.extend_from_slice(xyz);
            for x in field { evidence.extend_from_slice(&x.to_le_bytes()); }
            let tolerance = policy.relative_tolerance.mul_add(field[0].hypot(field[1]).hypot(field[2]), policy.absolute_tolerance_apm);
            for x in [0_f64, tolerance, 0.] { evidence.extend_from_slice(&x.to_le_bytes()); }
            for n in [1_u64; 3] { evidence.extend_from_slice(&n.to_le_bytes()); }
        }
        payloads.insert("evidence".into(), evidence);
        for key in ["h_raw", "evidence"] {
            value["payloads"][key]["sha256"] = json!(fullmag_session::hex_sha256(&payloads[key]));
            value["payloads"][key]["byte_count"] = json!(payloads[key].len());
        }
        value["payloads"]["evidence"]["layout"] = json!(RETAINED_CURRENT_EVIDENCE_SCHEMA_V2);
        let mut manifest: RetainedCurrentFieldManifestV2 = serde_json::from_value(value).unwrap();
        manifest.content_digest = manifest.expected_content_digest().unwrap();
        owner.content_digest = manifest.content_digest.clone();
        (RetainedCurrentFieldBundleAny::DirectV2(RetainedCurrentFieldBundleV2 {
            manifest_bytes: serde_json::to_vec(&manifest).unwrap(), manifest, payloads }), owner)
    }

    #[test]
    fn retained_dtq_v2_quantity_catalog_only_raw_h() {
        for domain in [fullmag_ir::FieldTargetIR::Global {},
            fullmag_ir::FieldTargetIR::Object { object_id: "probe".into() }] {
            let (bundle, owner) = direct_bundle(domain);
            let raw_bits = f64s(&bundle.payloads()["h_raw"]).unwrap().into_iter().map(f64::to_bits).collect::<Vec<_>>();
            let expected_carrier = serde_json::to_value(bundle.manifest().sample_carrier()).unwrap();
            let fields = from_retained(owner.clone(), bundle, 17).unwrap();
            assert_eq!(fields.fields.keys().map(String::as_str).collect::<Vec<_>>(), ["H_ant"]);
            let h = &fields.fields["H_ant"];
            assert_eq!(h.canonical_unit, "A/m");
            assert_eq!(h.values.iter().map(|v| v.to_bits()).collect::<Vec<_>>(), raw_bits);
            assert_eq!(h.values[1].to_bits(), (-0_f64).to_bits());
            let locator = locator(h).unwrap();
            assert_eq!(locator.owner, owner);
            assert_eq!(locator.indexing, ArtifactSampleIndexing::SampleNodes);
            assert_eq!(serde_json::to_value(locator).unwrap()["sample_carrier"], expected_carrier);
        }
    }

    #[test]
    fn retained_dtq_v2_owner_and_materialization_limits() {
        let (bundle, owner) = direct_bundle(fullmag_ir::FieldTargetIR::Global {});
        for key in ["source", "content", "topology", "project", "task"] {
            let mut crossed = owner.clone();
            match key {
                "source" => crossed.source_digest = format!("sha256:{}", "7".repeat(64)),
                "content" => crossed.content_digest = format!("sha256:{}", "7".repeat(64)),
                "topology" => crossed.native_topology_identity = format!("sha256:{}", "7".repeat(64)),
                "project" => crossed.accepted_artifact.as_mut().unwrap().project_id = "foreign".into(),
                _ => crossed.accepted_artifact.as_mut().unwrap().task_id = "parent-task".into(),
            }
            assert!(from_retained(crossed, bundle.clone(), 17).is_err(), "{key}");
        }
        for key in ["v_raw", "j_local_raw", "m", "h_per_a", "H_ant_basis"] {
            let mut extra = bundle.clone();
            let RetainedCurrentFieldBundleAny::DirectV2(ref mut direct) = extra else { unreachable!() };
            direct.payloads.insert(key.into(), vec![0; 8]);
            assert!(from_retained(owner.clone(), extra, 17).is_err(), "{key}");
        }
        let limit = 128 * 1024 * 1024;
        assert!(retained_view_admission(limit - 2 * 1024 * 1024, 0).is_ok());
        assert!(retained_view_admission(limit - 2 * 1024 * 1024 + 1, 0).is_err());
        assert!(retained_view_admission(0, limit / 16).is_err());
        assert!(retained_view_admission(0, usize::MAX).is_err());
        assert!(retained_view_admission(usize::MAX, 1).is_err());
        let fields = from_retained(owner, bundle, 17).unwrap();
        assert!(fields.retained_bytes < limit);
        let h = &fields.fields["H_ant"];
        let own = locator(h).unwrap();
        assert!(require_binary_pins(Some(&own.owner.runtime_stage_id), Some(&own.carrier_id), Some(&own.carrier_revision)).is_ok());
        assert!(require_binary_pins(None, Some(&own.carrier_id), Some(&own.carrier_revision)).is_err());
        assert!(require_binary_pins(Some(&own.owner.runtime_stage_id), None, Some(&own.carrier_revision)).is_err());
        assert!(require_binary_pins(Some(&own.owner.runtime_stage_id), Some(&own.carrier_id), None).is_err());
        assert!(validate_scope(h, Some("full"), None, Some(&own.carrier_revision), Some(&own.owner.object_id)).is_ok());
        assert!(validate_scope(h, Some("object"), Some("antenna"), Some(&own.carrier_revision), None).is_err());
        assert!(validate_scope(h, Some("full"), None, Some("0"), None).is_err());
        assert!(validate_scope(h, Some("full"), None, Some(&own.carrier_revision), Some("foreign")).is_err());
    }

    #[test]
    fn retained_dtq_raw_display_does_not_bypass_invalid_signed_normalization() {
        let (bundle, owner) = direct_bundle(fullmag_ir::FieldTargetIR::Global {});
        for (current, scale) in [(0_f64, 1_f64), (-0., -1.), (f64::NAN, 1.),
            (f64::INFINITY, 1.), (-3., 1. / 3.), (-3., -1. / 9.)] {
            let RetainedCurrentFieldBundleAny::DirectV2(mut direct) = bundle.clone() else { unreachable!() };
            let evidence = direct.payloads.get_mut("evidence").unwrap();
            evidence[272..280].copy_from_slice(&current.to_le_bytes());
            evidence[280..288].copy_from_slice(&scale.to_le_bytes());
            direct.manifest.payloads.evidence.sha256 = fullmag_session::hex_sha256(evidence);
            direct.manifest.content_digest = direct.manifest.expected_content_digest().unwrap();
            let mut changed_owner = owner.clone();
            changed_owner.content_digest = direct.manifest.content_digest.clone();
            let error = from_retained(changed_owner, RetainedCurrentFieldBundleAny::DirectV2(direct), 17);
            assert!(error.is_err(), "current={current:?}, scale={scale:?}");
        }
    }

    #[test]
    fn retained_h_uses_only_child_owner_and_exact_target_carrier() {
        for domain in [fullmag_ir::FieldTargetIR::Global {},
            fullmag_ir::FieldTargetIR::Object { object_id: "probe".into() }] {
            let (bundle, owner) = bundle_and_owner(domain.clone());
            assert_ne!(owner.run_id, bundle.manifest.parent.owner.run_id);
            let expected = serde_json::to_value(&bundle.manifest.sample_carrier).unwrap();
            let fields = from_retained(owner.clone(), fullmag_antenna_artifacts::retained_current::RetainedCurrentFieldBundleAny::SurfaceV1(bundle), 17).unwrap();
            assert_eq!(fields.fields.keys().map(String::as_str).collect::<Vec<_>>(), ["H_ant"]);
            let h = &fields.fields["H_ant"];
            let locator = locator(h).unwrap();
            assert_eq!(locator.owner, owner);
            assert_eq!(locator.sample_count, 4);
            assert_eq!(h.quantity_revision, 17);
            assert_eq!(serde_json::to_value(&locator).unwrap()["sample_carrier"], expected);
            assert_eq!(locator.indexing, ArtifactSampleIndexing::SampleNodes);
            assert_eq!(locator.carrier_scope_kind, if matches!(domain, fullmag_ir::FieldTargetIR::Global {}) { "full" } else { "object" });
            assert!(fields.retained_bytes < 128 * 1024 * 1024);
            for absent in ["V_electric", "J_charge", "m", "H_ant_basis"] { assert!(!fields.fields.contains_key(absent)); }
        }
    }

    #[test]
    fn retained_h_refuses_crossed_owner_and_transport_payloads() {
        let (bundle, owner) = bundle_and_owner(fullmag_ir::FieldTargetIR::Global {});
        for key in ["source", "content", "topology", "project", "task"] {
            let mut crossed = owner.clone();
            match key {
                "source" => crossed.source_digest = format!("sha256:{}", "7".repeat(64)),
                "content" => crossed.content_digest = format!("sha256:{}", "7".repeat(64)),
                "topology" => crossed.native_mesh_identity = format!("sha256:{}", "7".repeat(64)),
                "project" => crossed.accepted_artifact.as_mut().unwrap().project_id = "foreign".into(),
                _ => crossed.accepted_artifact.as_mut().unwrap().task_id = "parent-task".into(),
            }
            assert!(from_retained(crossed, fullmag_antenna_artifacts::retained_current::RetainedCurrentFieldBundleAny::SurfaceV1(bundle.clone()), 1).is_err(), "{key}");
        }
        let mut extra = bundle.clone();
        extra.payloads.insert("v_raw".into(), vec![0; 32]);
        assert!(from_retained(owner.clone(), fullmag_antenna_artifacts::retained_current::RetainedCurrentFieldBundleAny::SurfaceV1(extra), 1).is_err());
        let mut corrupt = bundle;
        corrupt.payloads.get_mut("h_raw").unwrap()[0] ^= 1;
        assert!(from_retained(owner, fullmag_antenna_artifacts::retained_current::RetainedCurrentFieldBundleAny::SurfaceV1(corrupt), 1).is_err());
    }
}
