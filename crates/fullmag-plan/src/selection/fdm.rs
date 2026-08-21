use fullmag_ir::ResolvedFrozenSpinsPlanIR;

#[cfg(test)]
use std::cell::Cell;

use super::certificate::{
    compile_domain_frozen_spins, FrozenSpinsCompileRequest, SelectionDofMembership,
    SelectionDomainView, FDM_SELECTION_EVALUATOR_ID,
};
use super::geometry::SelectionError;

#[cfg(test)]
thread_local! {
    static FDM_POINT_MATERIALIZATIONS: Cell<usize> = const { Cell::new(0) };
}

#[cfg(test)]
pub(crate) fn reset_fdm_point_materialization_count() {
    FDM_POINT_MATERIALIZATIONS.with(|count| count.set(0));
}

#[cfg(test)]
pub(crate) fn fdm_point_materialization_count() -> usize {
    FDM_POINT_MATERIALIZATIONS.with(Cell::get)
}

#[derive(Debug)]
pub struct FdmFrozenSpinsDomain<'a> {
    pub origin_m: [f64; 3],
    pub counts: [u32; 3],
    pub cell_m: [f64; 3],
    pub active_mask: &'a [bool],
    pub memberships: &'a [SelectionDofMembership],
    pub grid_fingerprint: &'a str,
}

pub fn compile_fdm_frozen_spins(
    domain: &FdmFrozenSpinsDomain<'_>,
    request: &FrozenSpinsCompileRequest<'_>,
) -> Result<ResolvedFrozenSpinsPlanIR, SelectionError> {
    validate_grid(domain, request)?;
    #[cfg(test)]
    FDM_POINT_MATERIALIZATIONS.with(|count| count.set(count.get() + 1));
    let points_m =
        crate::fdm::resolved_fdm_cell_centers(domain.counts, domain.cell_m, domain.origin_m);
    compile_domain_frozen_spins(
        SelectionDomainView {
            points_m: &points_m,
            active_mask: domain.active_mask,
            memberships: domain.memberships,
            topology_fingerprint: domain.grid_fingerprint,
            evaluator_id: FDM_SELECTION_EVALUATOR_ID,
        },
        request,
    )
}

fn validate_grid(
    domain: &FdmFrozenSpinsDomain<'_>,
    request: &FrozenSpinsCompileRequest<'_>,
) -> Result<(), SelectionError> {
    if domain.counts.contains(&0) {
        return Err(SelectionError::new(
            "selection_invalid_geometry",
            format!("FDM grid counts must be positive, got {:?}", domain.counts),
        ));
    }
    if domain
        .origin_m
        .iter()
        .chain(domain.cell_m.iter())
        .any(|value| !value.is_finite())
        || domain.cell_m.iter().any(|value| *value <= 0.0)
    {
        return Err(SelectionError::new(
            "selection_invalid_geometry",
            "FDM grid origin must be finite and cell sizes must be finite and positive",
        ));
    }
    let expected = domain
        .counts
        .into_iter()
        .try_fold(1_usize, |product, count| {
            product.checked_mul(count as usize)
        });
    if expected != Some(domain.active_mask.len()) {
        return Err(SelectionError::new(
            "selection_domain_size_mismatch",
            format!(
                "FDM grid {:?} contains {:?} cells but active mask length is {}",
                domain.counts,
                expected,
                domain.active_mask.len()
            ),
        ));
    }
    if domain.memberships.len() != domain.active_mask.len() {
        return Err(SelectionError::new(
            "selection_domain_size_mismatch",
            format!(
                "FDM membership length {} differs from active mask length {}",
                domain.memberships.len(),
                domain.active_mask.len()
            ),
        ));
    }
    if domain.grid_fingerprint.is_empty()
        || domain.grid_fingerprint != request.expected_grid_or_mesh_fingerprint
    {
        return Err(SelectionError::new(
            "selection_topology_mismatch",
            format!(
                "resolved topology '{}' does not match expected topology '{}'",
                domain.grid_fingerprint, request.expected_grid_or_mesh_fingerprint
            ),
        ));
    }
    Ok(())
}
