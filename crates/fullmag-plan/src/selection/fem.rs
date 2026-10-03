use fullmag_ir::ResolvedFrozenSpinsPlanIR;

#[cfg(test)]
use std::cell::Cell;

use super::certificate::{
    compile_domain_frozen_spins, FrozenSpinsCompileRequest, SelectionDomainView,
    FEM_SELECTION_EVALUATOR_ID,
};
use super::geometry::SelectionError;

#[cfg(test)]
thread_local! {
    static FEM_MEMBERSHIP_MATERIALIZATIONS: Cell<usize> = const { Cell::new(0) };
}

#[cfg(test)]
pub(crate) fn reset_fem_membership_materialization_count() {
    FEM_MEMBERSHIP_MATERIALIZATIONS.with(|count| count.set(0));
}

#[cfg(test)]
pub(crate) fn fem_membership_materialization_count() -> usize {
    FEM_MEMBERSHIP_MATERIALIZATIONS.with(Cell::get)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FemIncidentElement {
    pub magnetic: bool,
    pub object_id: Option<String>,
    pub region_ids: Vec<String>,
}

impl FemIncidentElement {
    pub fn magnetic(object_id: impl Into<String>, region_ids: &[&str]) -> Self {
        Self {
            magnetic: true,
            object_id: Some(object_id.into()),
            region_ids: region_ids
                .iter()
                .map(|value| (*value).to_string())
                .collect(),
        }
    }

    pub fn air() -> Self {
        Self {
            magnetic: false,
            object_id: None,
            region_ids: Vec::new(),
        }
    }
}

#[derive(Debug)]
pub struct FemTrueDofDomain<'a> {
    pub fe_order: u32,
    pub true_dof_points_m: &'a [[f64; 3]],
    pub incident_elements: &'a [Vec<FemIncidentElement>],
    pub mesh_fingerprint: &'a str,
}

pub fn compile_fem_frozen_spins(
    domain: &FemTrueDofDomain<'_>,
    request: &FrozenSpinsCompileRequest<'_>,
) -> Result<ResolvedFrozenSpinsPlanIR, SelectionError> {
    if domain.fe_order == 0 {
        return Err(SelectionError::new(
            "selection_variant_unsupported",
            "FEM frozen-spins selection requires fe_order >= 1",
        ));
    }
    if domain.incident_elements.len() != domain.true_dof_points_m.len() {
        return Err(SelectionError::new(
            "selection_domain_size_mismatch",
            format!(
                "FEM true-DOF point count {} differs from incident-element list count {}",
                domain.true_dof_points_m.len(),
                domain.incident_elements.len()
            ),
        ));
    }
    if domain.mesh_fingerprint.is_empty()
        || domain.mesh_fingerprint != request.expected_grid_or_mesh_fingerprint
    {
        return Err(SelectionError::new(
            "selection_topology_mismatch",
            format!(
                "resolved topology '{}' does not match expected topology '{}'",
                domain.mesh_fingerprint, request.expected_grid_or_mesh_fingerprint
            ),
        ));
    }

    let mut active_mask = Vec::with_capacity(domain.incident_elements.len());
    let mut memberships = Vec::with_capacity(domain.incident_elements.len());
    for incident_elements in domain.incident_elements {
        #[cfg(test)]
        FEM_MEMBERSHIP_MATERIALIZATIONS.with(|count| count.set(count.get() + 1));
        let (active, membership) =
            crate::fem::resolve_true_dof_incident_magnetic_membership(incident_elements)?;
        active_mask.push(active);
        memberships.push(membership);
    }

    compile_domain_frozen_spins(
        SelectionDomainView {
            points_m: domain.true_dof_points_m,
            active_mask: &active_mask,
            memberships: &memberships,
            topology_fingerprint: domain.mesh_fingerprint,
            evaluator_id: FEM_SELECTION_EVALUATOR_ID,
        },
        request,
    )
}
