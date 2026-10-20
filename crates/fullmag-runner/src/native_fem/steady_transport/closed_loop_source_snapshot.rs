//! Same-owner closed-loop source output. This decoder never reconstructs J.
use crate::types::RunError;
use fullmag_fem_sys as ffi;
use fullmag_ir::{ConservativeCurrentClosureIR, MeshIR};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::c_char;

#[derive(Debug, Clone, Serialize)]
pub(crate) struct ClosedLoopCurrentCell {
    pub source_element_index: u64,
    pub vertex_ids: [u64; 4],
    pub vertex_xyz_m: [f64; 12],
    pub center_xyz_m: [f64; 3],
    pub vertex_current_xyz_apm2: [f64; 12],
    pub center_current_xyz_apm2: [f64; 3],
}
#[derive(Debug, Clone, Serialize)]
pub(crate) struct PairedChargeWeakReaction {
    pub minus_vertex_id: u64, pub plus_vertex_id: u64,
    pub minus_reaction_a: f64, pub plus_reaction_a: f64,
}
#[derive(Debug, Clone, Serialize)]
pub(crate) struct ClosedLoopSourceSnapshot {
    pub schema_version: &'static str,
    pub sampling_policy: &'static str,
    pub current_unit: &'static str,
    pub source_current_orientation: &'static str,
    pub source_current_a: f64,
    pub source_absolute_flux_a: f64,
    pub charge_relative_residual: f64,
    pub potential_jump_v: f64,
    pub gauge_mean_v: f64,
    pub max_paired_weak_flux_mismatch_a: f64,
    pub source_view_identity_digest: String,
    pub periodic_operator_version: String,
    pub closure_operator_version: String,
    pub weak_reaction_ledger_version: String,
    pub paired_weak_reactions: Vec<PairedChargeWeakReaction>,
    pub cells: Vec<ClosedLoopCurrentCell>,
}
pub(super) struct SourceSnapshotBuffer {
    records: Vec<ffi::fullmag_fem_closed_loop_current_cell_v2>,
    reactions: Vec<ffi::fullmag_fem_paired_charge_weak_reaction_v2>,
    pub(super) header: ffi::fullmag_fem_closed_loop_source_snapshot_result_v2,
}
fn invalid(reason: &str) -> RunError {
    RunError { message: format!("native closed-loop source snapshot refused: {reason}") }
}
fn text<const N: usize>(bytes: &[c_char; N]) -> Result<String, RunError> {
    let end = bytes.iter().position(|b| *b == 0).ok_or_else(|| invalid("unterminated metadata"))?;
    if bytes[end..].iter().any(|b| *b != 0) { return Err(invalid("noncanonical metadata padding")); }
    String::from_utf8(bytes[..end].iter().map(|b| *b as u8).collect()).map_err(|_| invalid("invalid metadata UTF-8"))
}
fn compensated_add(sum: &mut f64, correction: &mut f64, value: f64) {
    let next = *sum + value;
    *correction += if sum.abs() >= value.abs() { (*sum-next)+value } else { (value-next)+*sum };
    *sum = next;
}
fn signed_minus_flux(mesh: &MeshIR, stable_ids: &[u64], keys: &[[u64; 3]], records: &[([u64; 3], f64)]) -> Result<(f64, f64), RunError> {
    let by_id = stable_ids.iter().enumerate().map(|(i, id)| (*id, i)).collect::<BTreeMap<_, _>>();
    let fluxes = records.iter().copied().collect::<BTreeMap<_, _>>();
    if fluxes.len() != records.len() { return Err(invalid("duplicate canonical face records")); }
    let cells = mesh.cells.require_tet4().map_err(|_| invalid("source mesh is not Tet4"))?;
    let wanted = keys.iter().copied().collect::<BTreeSet<_>>();
    if wanted.len() != keys.len() { return Err(invalid("duplicate source face keys")); }
    let mut owners = BTreeMap::<[u64; 3], (usize, u32)>::new();
    for (cell_index, cell) in cells.iter().enumerate() {
        for opposite in 0..4 {
            let mut key = [0_u64; 3];
            let mut cursor = 0;
            for local in 0..4 { if local != opposite { key[cursor] = stable_ids[cell[local] as usize]; cursor += 1; } }
            key.sort_unstable();
            if wanted.contains(&key) && owners.insert(key, (cell_index, cell[opposite])).is_some() {
                return Err(invalid("source face is not an actual one-sided Tet4 face"));
            }
        }
    }
    let mut total = 0.0_f64;
    let mut correction = 0.0_f64;
    let mut absolute = 0.0_f64;
    for key in keys {
        let indices = key.iter().map(|id| by_id.get(id).copied().ok_or_else(|| invalid("source vertex ID absent"))).collect::<Result<Vec<_>, _>>()?;
        let (_, opposite) = owners.get(key).ok_or_else(|| invalid("source face is not an actual one-sided Tet4 face"))?;
        let points = indices.iter().map(|v| mesh.nodes[*v]).collect::<Vec<_>>();
        let mut edge = [[0.0; 3]; 3];
        let mut scale = 0.0_f64;
        for axis in 0..3 {
            edge[0][axis] = points[1][axis] - points[0][axis];
            edge[1][axis] = points[2][axis] - points[0][axis];
            edge[2][axis] = mesh.nodes[*opposite as usize][axis] - points[0][axis];
            for vector in &edge { scale = scale.max(vector[axis].abs()); }
        }
        if !scale.is_finite() || scale == 0.0 { return Err(invalid("source face geometry is invalid")); }
        for vector in &mut edge { for component in vector { *component /= scale; } }
        let cross = [edge[0][1]*edge[1][2]-edge[0][2]*edge[1][1], edge[0][2]*edge[1][0]-edge[0][0]*edge[1][2], edge[0][0]*edge[1][1]-edge[0][1]*edge[1][0]];
        let orientation: f64 = (0..3).map(|i| cross[i]*edge[2][i]).sum();
        if !orientation.is_finite() || orientation == 0.0 { return Err(invalid("source orientation is degenerate")); }
        let flux = *fluxes.get(key).ok_or_else(|| invalid("source canonical flux absent"))? * if orientation > 0.0 { -1.0 } else { 1.0 };
        if !flux.is_finite() { return Err(invalid("source canonical flux nonfinite")); }
        let next = total + flux;
        correction += if total.abs() >= flux.abs() { (total-next)+flux } else { (flux-next)+total };
        total = next; absolute += flux.abs();
    }
    Ok((total+correction, absolute))
}
impl SourceSnapshotBuffer {
    pub(super) fn new(count: usize, vertices: usize) -> Result<Self, RunError> {
        if count == 0 || count > ffi::FULLMAG_FEM_CLOSED_LOOP_SOURCE_SNAPSHOT_MAX_CELLS { return Err(invalid("cell count outside snapshot bound")); }
        if vertices == 0 || vertices > 4 * ffi::FULLMAG_FEM_CLOSED_LOOP_SOURCE_SNAPSHOT_MAX_CELLS { return Err(invalid("weak reaction capacity outside bound")); }
        let mut reactions = Vec::new();
        reactions.try_reserve_exact(vertices).map_err(|_| invalid("weak reaction allocation failed"))?;
        reactions.resize(vertices, ffi::fullmag_fem_paired_charge_weak_reaction_v2 { minus_vertex_id: 0, plus_vertex_id: 0, minus_reaction_a: f64::NAN, plus_reaction_a: f64::NAN });
        let mut records = Vec::new();
        records.try_reserve_exact(count).map_err(|_| invalid("snapshot allocation failed"))?;
        records.resize(count, ffi::fullmag_fem_closed_loop_current_cell_v2 {
            source_element_index: u64::MAX, vertex_ids: [0; 4], vertex_xyz_m: [f64::NAN; 12], center_xyz_m: [f64::NAN; 3],
            vertex_current_xyz_apm2: [f64::NAN; 12], center_current_xyz_apm2: [f64::NAN; 3],
        });
        let header = ffi::fullmag_fem_closed_loop_source_snapshot_result_v2 {
            abi_version: ffi::FULLMAG_FEM_CLOSED_LOOP_SOURCE_SNAPSHOT_ABI_VERSION, reserved_flags: 0,
            struct_size: std::mem::size_of::<ffi::fullmag_fem_closed_loop_source_snapshot_result_v2>() as u64,
            cells: records.as_mut_ptr(), cells_capacity: count as u64, cells_len: 0,
            source_current_a: f64::NAN, source_absolute_flux_a: f64::NAN, charge_relative_residual: f64::NAN,
            potential_jump_v: f64::NAN, gauge_mean_v: f64::NAN, max_paired_weak_flux_mismatch_a: f64::NAN,
            paired_weak_reactions: reactions.as_mut_ptr(), paired_weak_reactions_capacity: vertices as u64, paired_weak_reactions_len: 0, weak_reaction_ledger_version: [0; 96],
            source_view_identity_digest: [0; 65], periodic_operator_version: [0; 96], closure_operator_version: [0; 96], error_message: [0; 256],
        };
        Ok(Self { records, reactions, header })
    }
    pub(super) fn finish(self, mesh: &MeshIR, closure: &ConservativeCurrentClosureIR, stable_vertex_ids: &[u64],
        digest: &str, potential: &[f64], faces: &[([u64; 3], f64)]) -> Result<ClosedLoopSourceSnapshot, RunError> {
        self.finish_expected(mesh,closure,stable_vertex_ids,digest,potential,faces,std::mem::size_of::<ffi::fullmag_fem_closed_loop_source_snapshot_result_v2>() as u64)
    }
    pub(super) fn finish_expected(mut self, mesh:&MeshIR,closure:&ConservativeCurrentClosureIR,stable_vertex_ids:&[u64],digest:&str,potential:&[f64],faces:&[([u64;3],f64)],expected_size:u64)->Result<ClosedLoopSourceSnapshot,RunError>{
        let h = &self.header;
        if h.abi_version != ffi::FULLMAG_FEM_CLOSED_LOOP_SOURCE_SNAPSHOT_ABI_VERSION || h.reserved_flags != 0 ||
            h.struct_size != expected_size ||
            h.cells != self.records.as_mut_ptr() || h.cells_capacity != self.records.len() as u64 ||
            h.cells_len != self.records.len() as u64 || text(&h.source_view_identity_digest)? != digest ||
            text(&h.periodic_operator_version)? != "fem_charge_h1_periodic_jump.v2" || text(&h.closure_operator_version)? != "fem_closed_current_geometry.v2" ||
            [h.source_current_a,h.source_absolute_flux_a,h.charge_relative_residual,h.potential_jump_v,h.gauge_mean_v,h.max_paired_weak_flux_mismatch_a].iter().any(|v| !v.is_finite()) {
            return Err(invalid("invalid header, metadata, scalar or source binding"));
        }
        let ConservativeCurrentClosureIR::ClosedGeometry { operator_version, source_cuts, .. } = closure else { return Err(invalid("closed source output has external closure")); };
        if operator_version != "fem_closed_current_geometry.v2" || source_cuts.len() != 1 { return Err(invalid("invalid closure version or cut count")); }
        let cut = &source_cuts[0];
        if potential.len() != mesh.nodes.len() || potential.iter().any(|v| !v.is_finite()) || stable_vertex_ids.len() != mesh.nodes.len() { return Err(invalid("owned potential shape or finiteness")); }
        let by_id = stable_vertex_ids.iter().enumerate().map(|(i,id)| (*id,i)).collect::<BTreeMap<_,_>>();
        if by_id.len() != mesh.nodes.len() { return Err(invalid("nonunique stable vertex IDs")); }
        let mut pairs = BTreeMap::new();
        let mut reverse = BTreeMap::new();
        for face in &cut.face_pairs {
            for minus in face.minus_face_vertex_ids {
                let a = *by_id.get(&minus).ok_or_else(|| invalid("minus trace ID absent"))?;
                let matches = face.plus_face_vertex_ids.iter().filter(|plus| by_id.get(plus).is_some_and(|b| (0..3).all(|axis| mesh.nodes[a][axis].to_bits() == mesh.nodes[*b][axis].to_bits()))).copied().collect::<Vec<_>>();
                if matches.len()!=1 || matches[0]==minus { return Err(invalid("nonbijective or noncoincident paired trace")); }
                let plus=matches[0];
                if pairs.insert(minus,plus).is_some_and(|old| old!=plus) || reverse.insert(plus,minus).is_some_and(|old| old!=minus) { return Err(invalid("inconsistent trace pairing")); }
                let jump=potential[by_id[&plus]]-potential[a];
                if !jump.is_finite() || (jump-cut.potential_drop_v).abs()>1.0e-12+128.0*f64::EPSILON*cut.potential_drop_v.abs() { return Err(invalid("owned potential violates paired jump")); }
            }
        }
        if pairs.is_empty() || pairs.keys().any(|id| reverse.contains_key(id)) { return Err(invalid("shorted source sides")); }
        if h.paired_weak_reactions != self.reactions.as_mut_ptr() || h.paired_weak_reactions_capacity != self.reactions.len() as u64 || h.paired_weak_reactions_len != pairs.len() as u64 || text(&h.weak_reaction_ledger_version)? != "original_k_paired_vertex_reactions.v2" { return Err(invalid("weak reaction ledger header/version")); }
        self.reactions.truncate(pairs.len());
        let mut seen=BTreeSet::new(); let mut maximum=0.0_f64;
        for row in &self.reactions {
            if pairs.get(&row.minus_vertex_id)!=Some(&row.plus_vertex_id) || !seen.insert(row.minus_vertex_id) || !row.minus_reaction_a.is_finite() || !row.plus_reaction_a.is_finite() { return Err(invalid("weak reaction trace binding")); }
            let scale=row.minus_reaction_a.abs()+row.plus_reaction_a.abs();
            let mismatch=(row.minus_reaction_a+row.plus_reaction_a).abs();
            if !scale.is_finite() || !mismatch.is_finite() || mismatch>1.0e-18+1.0e-10*scale { return Err(invalid("paired original-K weak reaction gate")); }
            maximum=maximum.max(mismatch);
        }
        if maximum.to_bits()!=h.max_paired_weak_flux_mismatch_a.to_bits() { return Err(invalid("weak reaction summary mismatch")); }
        let cells=mesh.cells.require_tet4().map_err(|_| invalid("source mesh is not Tet4"))?;
        let mut edge_scale=0.0_f64;
        for cell in &cells { for node in &cell[1..] { for axis in 0..3 { edge_scale=edge_scale.max((mesh.nodes[*node as usize][axis]-mesh.nodes[cell[0] as usize][axis]).abs()); } } }
        if !edge_scale.is_finite() || edge_scale==0.0 { return Err(invalid("volume gauge cell scale")); }
        let mut volume=0.0_f64; let mut weighted=0.0_f64;
        let mut volume_correction=0.0_f64; let mut weighted_correction=0.0_f64;
        for cell in cells {
            let a=mesh.nodes[cell[0] as usize]; let mut e=[[0.0;3];3];
            for local in 0..3 { for axis in 0..3 { e[local][axis]=(mesh.nodes[cell[local+1] as usize][axis]-a[axis])/edge_scale; } }
            let determinant=e[0][0]*(e[1][1]*e[2][2]-e[1][2]*e[2][1])-e[0][1]*(e[1][0]*e[2][2]-e[1][2]*e[2][0])+e[0][2]*(e[1][0]*e[2][1]-e[1][1]*e[2][0]);
            if !determinant.is_finite() || determinant<=0.0 { return Err(invalid("volume gauge nonpositive Tet4")); }
            let mean=cell.iter().map(|node|potential[*node as usize]*0.25).sum::<f64>();
            compensated_add(&mut volume,&mut volume_correction,determinant);
            compensated_add(&mut weighted,&mut weighted_correction,determinant*mean);
        }
        let owned_mean=(weighted+weighted_correction)/(volume+volume_correction);
        let gauge_gate=1.0e-12+128.0*f64::EPSILON*potential.iter().fold(0.0_f64,|scale,v|scale.max(v.abs()));
        if !owned_mean.is_finite() || owned_mean.abs()>gauge_gate || (owned_mean-h.gauge_mean_v).abs()>gauge_gate { return Err(invalid("owned potential volume zero-mean gate")); }
        let keys = cut.face_pairs.iter().map(|p| p.minus_face_vertex_ids).collect::<Vec<_>>();
        let (current, scale) = signed_minus_flux(mesh, &stable_vertex_ids, &keys, faces)?;
        let current_gate = 128.0*f64::EPSILON*scale;
        let potential_scale = potential.iter().fold(0.0_f64, |scale,v| scale.max(v.abs()));
        if h.source_absolute_flux_a < 0.0 || h.charge_relative_residual < 0.0 || h.charge_relative_residual > 1.0e-12 ||
            h.max_paired_weak_flux_mismatch_a < 0.0 || (h.source_current_a-current).abs() > current_gate ||
            (h.source_absolute_flux_a-scale).abs() > current_gate ||
            (h.potential_jump_v-cut.potential_drop_v).abs() > 1.0e-12+128.0*f64::EPSILON*cut.potential_drop_v.abs() ||
            h.gauge_mean_v.abs() > 1.0e-12+128.0*f64::EPSILON*potential_scale {
            return Err(invalid("source current, jump, gauge or residual certificate mismatch"));
        }
        let cells = mesh.cells.require_tet4().map_err(|_| invalid("source cells are not Tet4"))?;
        for (index, record) in self.records.iter().enumerate() {
            if record.source_element_index != index as u64 || record.vertex_current_xyz_apm2.iter().chain(&record.center_current_xyz_apm2).chain(&record.center_xyz_m).any(|v| !v.is_finite()) { return Err(invalid("invalid cell ordering or local J values")); }
            for (local, node) in cells[index].iter().enumerate() {
                let node = *node as usize;
                if record.vertex_ids[local] != stable_vertex_ids[node] { return Err(invalid("cell stable-ID order differs from source mesh")); }
                for axis in 0..3 { if record.vertex_xyz_m[3*local+axis].to_bits() != mesh.nodes[node][axis].to_bits() { return Err(invalid("cell xyz differs from source mesh")); } }
            }
            for axis in 0..3 {
                let expected = cells[index].iter().map(|node| mesh.nodes[*node as usize][axis] * 0.25).sum::<f64>();
                let scale = cells[index].iter().fold(0.0_f64, |scale, node| scale.max(mesh.nodes[*node as usize][axis].abs()));
                if (record.center_xyz_m[axis] - expected).abs() > 8.0 * f64::EPSILON * scale {
                    return Err(invalid("cell center differs from source mesh barycenter"));
                }
            }
        }
        Ok(ClosedLoopSourceSnapshot {
            schema_version: "fullmag.closed_loop_source_snapshot.v2", sampling_policy: "cell_center_and_cell_local_vertices.v1",
            current_unit: "A/m^2", source_current_orientation: "authored_minus_outward.v1",
            source_current_a: h.source_current_a, source_absolute_flux_a: h.source_absolute_flux_a, charge_relative_residual: h.charge_relative_residual,
            potential_jump_v: h.potential_jump_v, gauge_mean_v: h.gauge_mean_v, max_paired_weak_flux_mismatch_a: h.max_paired_weak_flux_mismatch_a,
            source_view_identity_digest: text(&h.source_view_identity_digest)?, periodic_operator_version: text(&h.periodic_operator_version)?, closure_operator_version: text(&h.closure_operator_version)?,
            weak_reaction_ledger_version: text(&h.weak_reaction_ledger_version)?,
            paired_weak_reactions: self.reactions.into_iter().map(|r| PairedChargeWeakReaction { minus_vertex_id:r.minus_vertex_id, plus_vertex_id:r.plus_vertex_id, minus_reaction_a:r.minus_reaction_a, plus_reaction_a:r.plus_reaction_a }).collect(),
            cells: self.records.into_iter().map(|r| ClosedLoopCurrentCell { source_element_index:r.source_element_index, vertex_ids:r.vertex_ids, vertex_xyz_m:r.vertex_xyz_m,
                center_xyz_m:r.center_xyz_m, vertex_current_xyz_apm2:r.vertex_current_xyz_apm2, center_current_xyz_apm2:r.center_current_xyz_apm2 }).collect(),
        })
    }
}
