//! Owned artifact sampling geometry; scientific acceptance remains with the producer.
use std::collections::BTreeSet;
use fullmag_runner::FemMeshPayload;
use crate::error::ApiError;
use crate::schemas::fields::{ArtifactFieldOwnerBinding, ArtifactSampleIndexing};

#[derive(Debug, Clone, Copy)]
pub(crate) enum ArtifactSampleIdentity {
    SourceNode(u64),
    SampleOrdinal(u64),
    CellLocal { source_element_ordinal: u64, local_vertex_index: u8, stable_vertex_id: u64 },
    CellCenter(u64),
}

#[derive(Debug, Clone)]
pub(crate) struct ArtifactSampleCarrier {
    pub owner: ArtifactFieldOwnerBinding,
    pub carrier_scope_kind: String,
    pub carrier_scope_id: Option<String>,
    pub indexing: ArtifactSampleIndexing,
    pub positions_xyz_m: Vec<[f64; 3]>,
    pub sample_identity: Vec<ArtifactSampleIdentity>,
    pub topology: Option<FemMeshPayload>,
    pub carrier_digest: String,
    pub carrier_revision: u64,
}

impl ArtifactSampleCarrier {
    pub(crate) fn validate(&self, value_count: usize, components: usize) -> Result<(), ApiError> {
        match (self.carrier_scope_kind.as_str(),self.carrier_scope_id.as_deref()) {
            ("object",Some(id)) if !id.trim().is_empty() && id.len()<=4096 && !id.contains('\0')=>{},
            ("full",None)=>{},
            _=>return Err(ApiError::conflict("artifact sampling role/scope mismatch")),
        }
        let owner=&self.owner;
        if !owner.historical_inspection || [&owner.session_id,&owner.run_id,&owner.runtime_stage_id,&owner.authored_stage_id,
            &owner.module_id,&owner.object_id,&owner.output_id,&owner.source_digest,&owner.content_digest,
            &owner.native_mesh_identity,&owner.native_topology_identity].iter().any(|value|value.trim().is_empty())
            || self.carrier_digest.len()!=64 || !self.carrier_digest.bytes().all(|b|b.is_ascii_hexdigit()) {
            return Err(ApiError::conflict("artifact immutable owner binding absent"));
        }
        if let Some(accepted) = &owner.accepted_artifact {
            if [&accepted.project_id, &accepted.task_id, &accepted.attempt_id, &accepted.artifact_id]
                .iter().any(|value| value.trim().is_empty() || value.len() > 4096 || value.contains('\0'))
                || !fullmag_session::task_id_for_study_step(&owner.run_id, &owner.runtime_stage_id)
                    .is_ok_and(|task| task == accepted.task_id)
                || !accepted.ownership_epoch.parse::<u64>().is_ok_and(|epoch|
                    epoch > 0 && epoch.to_string() == accepted.ownership_epoch)
                || accepted.object_ref.len() != 64
                || !accepted.object_ref.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
                return Err(ApiError::conflict("accepted artifact task/attempt/epoch/CAS binding invalid"));
            }
        }
        if let Some(mesh)=&self.topology {
            if mesh.nodes.len()!=self.positions_xyz_m.len() || mesh.nodes.iter().zip(&self.positions_xyz_m)
                .any(|(a,b)|a.map(f64::to_bits)!=b.map(f64::to_bits)) {
                return Err(ApiError::conflict("artifact topology coordinates differ from owned samples"));
            }
        }
        let count = self.positions_xyz_m.len();
        if count == 0 || count > 4 * 1_048_576 || components == 0
            || count.checked_mul(components) != Some(value_count)
            || self.sample_identity.len() != count || self.carrier_revision == 0
            || self.positions_xyz_m.iter().flatten().any(|x| !x.is_finite()) {
            return Err(ApiError::conflict("artifact sample count/coordinates mismatch"));
        }
        let mut unique = BTreeSet::new();
        for identity in &self.sample_identity {
            let key = match (self.indexing, identity) {
                (ArtifactSampleIndexing::SourceNodes, ArtifactSampleIdentity::SourceNode(id)) => (*id, 0, *id),
                (ArtifactSampleIndexing::SampleNodes | ArtifactSampleIndexing::PointSamples, ArtifactSampleIdentity::SampleOrdinal(id))
                    if *id < count as u64 => (*id, 0, 0),
                (ArtifactSampleIndexing::CellCenters, ArtifactSampleIdentity::CellCenter(id)) => (*id, 0, 0),
                (ArtifactSampleIndexing::Tet4CellLocalNodes, ArtifactSampleIdentity::CellLocal {source_element_ordinal, local_vertex_index, stable_vertex_id: _})
                    if *local_vertex_index < 4 => (*source_element_ordinal, *local_vertex_index, 0),
                _ => return Err(ApiError::conflict("artifact sample indexing/identity mismatch")),
            };
            if !unique.insert(key) { return Err(ApiError::conflict("duplicate artifact sample identity")); }
        }
        if self.indexing == ArtifactSampleIndexing::Tet4CellLocalNodes {
            for group in self.sample_identity.chunks(4) {
                if group.len() != 4 { return Err(ApiError::conflict("incomplete cell-local Tet4 samples")); }
                let mut element = None;
                for (local, identity) in group.iter().enumerate() {
                    let ArtifactSampleIdentity::CellLocal {source_element_ordinal, local_vertex_index, ..} = identity else { unreachable!() };
                    if *local_vertex_index as usize != local || element.is_some_and(|id| id != *source_element_ordinal) {
                        return Err(ApiError::conflict("cell-local Tet4 order/owner mismatch"));
                    }
                    element = Some(*source_element_ordinal);
                }
            }
        }
        Ok(())
    }
}
