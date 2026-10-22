//! Preserve the verified inspection sample order without magnetic field semantics.
use anyhow::{bail, Context, Result};
use fullmag_ir::{FemConnectivityIR, MeshIR};
use fullmag_quantities::QuantityId;
use fullmag_runner::LoadedAntennaClosedLoopInspection;
use std::collections::BTreeMap;

pub(crate) struct InspectionSampleGeometry {
    pub mesh: MeshIR,
    // Stable source vertex; or (source element, local vertex, stable source vertex);
    // or explicit ordinal in the independently owned sampling mesh.
    pub identities: Vec<(u64, Option<u8>, Option<u64>)>,
}

fn payload<'a>(loaded: &'a LoadedAntennaClosedLoopInspection, key: &str) -> Result<&'a [u8]> {
    loaded.payloads.get(key).map(Vec::as_slice).context("inspection geometry payload absent")
}
fn points(bytes: &[u8]) -> Result<Vec<[f64; 3]>> {
    if bytes.is_empty() || bytes.len() % 24 != 0 { bail!("inspection geometry xyz alignment"); }
    bytes.chunks_exact(24).map(|row| {
        let point = std::array::from_fn(|i| f64::from_le_bytes(row[i*8..i*8+8].try_into().expect("eight bytes")));
        if point.iter().any(|v| !v.is_finite()) { bail!("inspection geometry nonfinite coordinate"); }
        Ok(point)
    }).collect()
}
fn u64_at(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(bytes[offset..offset+8].try_into().expect("eight verified bytes"))
}

pub(crate) fn extract(loaded: &LoadedAntennaClosedLoopInspection, quantity: QuantityId)
    -> Result<InspectionSampleGeometry> {
    let mut mesh = MeshIR::default();
    mesh.mesh_name = format!("inspection:{}", quantity.as_str());
    let mut identities = Vec::new();
    let mut cells = Vec::new();
    let mut ordinals = Vec::new();
    if quantity == QuantityId::HAnt {
        mesh.nodes = points(payload(loaded, "sample_xyz")?)?;
        identities.extend((0..mesh.nodes.len()).map(|i| (i as u64, None, None)));
        let bytes = payload(loaded, "sample_cells")?;
        if bytes.is_empty() || bytes.len()%16 != 0 { bail!("inspection sampling Tet4 alignment"); }
        for row in bytes.chunks_exact(16) {
            let cell = std::array::from_fn(|i| u32::from_le_bytes(row[i*4..i*4+4].try_into().expect("four bytes")));
            if cell.iter().any(|id| *id as usize >= mesh.nodes.len()) { bail!("inspection sampling index out of range"); }
            cells.push(cell);
        }
    } else {
        if !matches!(quantity, QuantityId::VElectric | QuantityId::JCharge) { bail!("inspection geometry quantity unsupported"); }
        let source_points = points(payload(loaded, "vertex_xyz")?)?;
        let ids = payload(loaded, "stable_vertex_ids")?;
        if source_points.len().checked_mul(8) != Some(ids.len()) { bail!("inspection source stable IDs differ"); }
        let source_ids = ids.chunks_exact(8).map(|row| u64_at(row,0)).collect::<Vec<_>>();
        let by_id = source_ids.iter().enumerate().map(|(i,id)|(*id,i)).collect::<BTreeMap<_,_>>();
        if by_id.len()!=source_ids.len() { bail!("inspection source stable IDs duplicated"); }
        let bytes = payload(loaded,"cells")?;
        if bytes.is_empty() || bytes.len()%280 != 0 { bail!("inspection source cell alignment"); }
        for row in bytes.chunks_exact(280) {
            let source_element = u64_at(row,0);
            let stable: [u64;4] = std::array::from_fn(|i| u64_at(row,8+i*8));
            let local_points = points(&row[40..136])?;
            let mut connectivity = [0u32;4];
            for local in 0..4 {
                let source = *by_id.get(&stable[local]).context("inspection source cell vertex absent")?;
                if local_points[local].map(f64::to_bits) != source_points[source].map(f64::to_bits) {
                    bail!("inspection cell-local coordinate differs from source");
                }
                connectivity[local] = if quantity==QuantityId::VElectric { u32::try_from(source)? } else {
                    let id = u32::try_from(mesh.nodes.len())?;
                    mesh.nodes.push(local_points[local]);
                    identities.push((source_element,Some(local as u8),Some(stable[local])));
                    id
                };
            }
            cells.push(connectivity); ordinals.push(source_element);
        }
        if quantity==QuantityId::VElectric {
            mesh.nodes=source_points;
            identities.extend(source_ids.into_iter().map(|id|(id,None,None)));
        }
    }
    mesh.cells=FemConnectivityIR::from_tet4(cells);
    if !ordinals.is_empty() { mesh.cells.global_ordinals=ordinals; }
    mesh.element_markers=vec![0;mesh.cells.len()];
    if identities.len()!=mesh.nodes.len() { bail!("inspection geometry sample identity count differs"); }
    Ok(InspectionSampleGeometry {mesh,identities})
}

/// Attach owned samples to the same immutable tensor/dataset SolutionSet graph.
pub(crate) fn build(
    store: &fullmag_session::SessionStore, solution: &fullmag_quantities::SolutionSet,
    member: &fullmag_quantities::SolutionMember, tensor_artifact: &fullmag_quantities::SolutionArtifactRef,
    tensor: &fullmag_session::TensorDescriptor,
) -> Result<Option<fullmag_quantities::SolutionArtifactRef>> {
    use fullmag_session::solution_field_geometry::{build_solution_owned_sample_geometry_artifact,
        OwnedSampleGeometryRole, OwnedSampleIdentity, SavedOwnedSampleFieldGeometry,
        SavedFieldRepresentationEvidence, OWNED_SAMPLE_GEOMETRY_SCHEMA};
    let Some(binding) = &tensor.field_binding else { return Ok(None); };
    if binding.producer_id != "fullmag.closed-loop-inspection" { return Ok(None); }
    if binding.producer_version != "2" || tensor_artifact.accepted_state.is_some() {
        bail!("inspection saved geometry producer differs");
    }
    let sources = member.artifacts.iter().filter(|a| a.artifact_id==binding.item_id).collect::<Vec<_>>();
    if sources.len()!=1 { bail!("inspection geometry source absent or ambiguous"); }
    let source = sources[0];
    if source.kind != fullmag_quantities::SolutionArtifactKind::Other || source.accepted_state.is_some()
        || source.schema_id != format!("{}@{}", fullmag_application::ANTENNA_INSPECTION_BUNDLE_CODEC_ID,
            fullmag_application::ANTENNA_INSPECTION_BUNDLE_CODEC_VERSION) {
        bail!("inspection saved geometry source schema differs");
    }
    let maximum = 512usize*1024*1024;
    if source.byte_length==0 || source.byte_length>maximum as u64 { bail!("inspection geometry source budget"); }
    let raw = store.cas().get_bounded(&source.object_ref, maximum as u64)?.context("inspection geometry source CAS absent")?;
    if raw.len() as u64 != source.byte_length { bail!("inspection geometry source length differs"); }
    let bundle = fullmag_application::decode_antenna_inspection_bundle(&raw, maximum)?;
    drop(raw);
    let manifest: serde_json::Value = serde_json::from_slice(&bundle.manifest_bytes)?;
    let text = |key: &str| manifest[key].as_str().context("inspection geometry manifest identity absent");
    let artifacts = bundle.payloads.into_iter().map(|(relative_path,bytes)|
        fullmag_runner::AuxiliaryArtifact {relative_path,bytes}).collect();
    let loaded = fullmag_runner::load_antenna_closed_loop_inspection_bytes(&bundle.manifest_bytes, artifacts,
        text("stage_id")?, text("solution_id")?, text("port_mode_id")?, text("content_digest")?, maximum)
        .map_err(|e|anyhow::anyhow!(e.to_string()))?;
    let extracted = extract(&loaded,binding.descriptor.quantity_id)?;
    let role = match binding.descriptor.quantity_id {
        QuantityId::VElectric => OwnedSampleGeometryRole::SourceNodes,
        QuantityId::JCharge => OwnedSampleGeometryRole::Tet4CellLocalNodes,
        QuantityId::HAnt => OwnedSampleGeometryRole::SampleNodes,
        _ => bail!("inspection saved geometry quantity differs"),
    };
    let geometry = SavedOwnedSampleFieldGeometry {schema_version:OWNED_SAMPLE_GEOMETRY_SCHEMA.into(),
        coordinate_unit:"m".into(), representation_evidence:SavedFieldRepresentationEvidence::NotVerified,
        role, mesh:extracted.mesh, sample_identities:extracted.identities.into_iter().map(|(stable_id,local_node,vertex)|
            OwnedSampleIdentity {stable_id:stable_id.to_string(),local_node,stable_vertex_id:vertex.map(|id|id.to_string())}).collect(),
        descriptor:binding.descriptor.clone(), producer_id:binding.producer_id.clone(),producer_version:binding.producer_version.clone()};
    Ok(Some(build_solution_owned_sample_geometry_artifact(store.cas(),solution,&member.member_id,tensor_artifact,&geometry)?))
}
