//! Moment-to-coefficient binding after canonical retained-source verification.
//! This is not an alternate current solve or an ownership/authentication boundary.
use crate::antenna_field_solution::closed_loop_v2::{
    ClosedLoopAcceptedSourceInputV2, ClosedLoopCurrentCellV2,
};
use crate::types::RunError;
use fullmag_fem_sys as ffi;

pub(super) fn bad(message: &str) -> RunError {
    RunError { message: format!("retained RT0 source refused: {message}") }
}

// Verified v2 sources use positive oriented Tet4. The same winding is used by
// closed_loop_identity_v2::verify_rt0_sample_moments; stable IDs set canonical normals.
fn freeze_cell(cell: &ClosedLoopCurrentCellV2, faces: &[([u64; 3], f64)])
    -> Result<ffi::fullmag_fem_frozen_rt0_element_v1, RunError>
{
    if cell.vertex_xyz_m.iter().any(|value| !value.is_finite())
        || (0..4).any(|i| (i + 1..4).any(|j| cell.vertex_ids[i] == cell.vertex_ids[j]))
    {
        return Err(bad("invalid cell vertex identity or coordinate"));
    }
    let outward = [[1, 2, 3], [0, 3, 2], [0, 1, 3], [0, 2, 1]];
    let mut coefficients = [0.0; 4];
    for opposite in 0..4 {
        let mut ids = outward[opposite].map(|index| cell.vertex_ids[index]);
        let inversions = usize::from(ids[0] > ids[1]) + usize::from(ids[0] > ids[2])
            + usize::from(ids[1] > ids[2]);
        ids.sort_unstable();
        let position = faces.binary_search_by_key(&ids, |(key, _)| *key)
            .map_err(|_| bad("missing canonical RT0 face moment"))?;
        let moment = faces[position].1;
        let oriented = if inversions % 2 == 0 { moment } else { -moment };
        // MFEM generic RT0 DOFs are twice physical integrated outward currents.
        let coefficient = 2.0 * oriented;
        if !moment.is_finite() || !coefficient.is_finite()
            || (coefficient * 0.5).to_bits() != oriented.to_bits()
        {
            return Err(bad("face moment scaling is not exactly representable"));
        }
        coefficients[opposite] = coefficient;
    }
    Ok(ffi::fullmag_fem_frozen_rt0_element_v1 {
        vertices_m: cell.vertex_xyz_m,
        signed_coefficients_a: coefficients,
    })
}

/// Caller must first verify the complete v2 bundle and its durable accepted owner.
/// No source pins are inferred from labels, sampled centers, or display current.
pub(super) fn freeze_verified_source(source: &ClosedLoopAcceptedSourceInputV2)
    -> Result<Vec<ffi::fullmag_fem_frozen_rt0_element_v1>, RunError>
{
    if source.cells.is_empty() || source.cells.len() > 1_048_576
        || source.canonical_face_records.is_empty()
        || source.canonical_face_records.windows(2).any(|pair| pair[0].0 >= pair[1].0)
    {
        return Err(bad("empty, oversized or unordered retained source"));
    }
    let mut frozen = Vec::new();
    frozen.try_reserve_exact(source.cells.len()).map_err(|_| bad("frozen source allocation failed"))?;
    for (ordinal, cell) in source.cells.iter().enumerate() {
        if cell.source_element_index != ordinal as u64 {
            return Err(bad("retained cell order differs from its source ordinal"));
        }
        frozen.push(freeze_cell(cell, &source.canonical_face_records)?);
    }
    Ok(frozen)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cell(ids: [u64; 4]) -> ClosedLoopCurrentCellV2 {
        ClosedLoopCurrentCellV2 { source_element_index: 0, vertex_ids: ids,
            vertex_xyz_m: [0.,0.,0.,1.,0.,0.,0.,1.,0.,0.,0.,1.],
            vertex_current_xyz_apm2: [0.;12], center_xyz_m:[0.25;3], center_current_xyz_apm2:[0.;3] }
    }
    fn moments(cell: &ClosedLoopCurrentCellV2, values: [f64;4]) -> Vec<([u64;3],f64)> {
        let mut records = (0..4).map(|opposite| {
            let mut ids = (0..4).filter(|local|*local != opposite)
                .map(|local|cell.vertex_ids[local]).collect::<Vec<_>>();
            ids.sort_unstable(); ([ids[0],ids[1],ids[2]],values[opposite])
        }).collect::<Vec<_>>();
        records.sort_by_key(|(ids,_)|*ids);records
    }
    #[test]
    fn uniform_x_current_has_generic_coefficients_one_minus_one() {
        let cell = cell([0,1,2,3]);
        // Unit Tet4 J=(1,0,0): the two canonical +x-normal faces carry +1/2 A.
        let frozen = freeze_cell(&cell,&moments(&cell,[0.5,0.5,0.,0.])).unwrap();
        assert_eq!(frozen.vertices_m,cell.vertex_xyz_m);
        assert_eq!(frozen.signed_coefficients_a,[1.,-1.,0.,-0.]);
    }
    #[test]
    fn arbitrary_stable_ids_preserve_all_four_orientations() {
        let cell = cell([10,30,20,40]);
        let frozen = freeze_cell(&cell,&moments(&cell,[1.,2.,4.,8.])).unwrap();
        assert_eq!(frozen.signed_coefficients_a,[-2.,-4.,8.,16.]);
    }
    #[test]
    fn exact_scaling_keeps_subnormals_and_refuses_overflow() {
        let cell = cell([0,1,2,3]);
        let tiny = f64::from_bits(1);
        assert!(freeze_cell(&cell,&moments(&cell,[tiny;4])).is_ok());
        assert!(freeze_cell(&cell,&moments(&cell,[f64::MAX;4])).is_err());
    }
    #[test]
    fn absent_moment_nonfinite_input_and_duplicate_identity_refuse() {
        let mut cell = cell([0,1,2,3]);
        assert!(freeze_cell(&cell,&[]).is_err());
        assert!(freeze_cell(&cell,&moments(&cell,[f64::NAN;4])).is_err());
        cell.vertex_xyz_m[0] = f64::INFINITY;
        assert!(freeze_cell(&cell,&moments(&cell,[0.;4])).is_err());
        cell.vertex_xyz_m[0] = 0.;cell.vertex_ids[1] = cell.vertex_ids[0];
        assert!(freeze_cell(&cell,&moments(&cell,[0.;4])).is_err());
    }
}
