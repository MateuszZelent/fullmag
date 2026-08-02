use super::NativeFemSteadyTransportResult;
use crate::types::{FieldSnapshot, RunError};
use fullmag_ir::ResolvedSpinTransportPlanIR;

pub(super) fn transport_field_snapshots(
    resolved: &ResolvedSpinTransportPlanIR,
    result: &NativeFemSteadyTransportResult,
    first_revision: u64,
) -> Result<Vec<FieldSnapshot>, RunError> {
    let node_count = result.electric_potential_v.len();
    if first_revision == 0
        || result.charge_current_density_xyz_apm2.len() != node_count
        || result.spin_potential_xyz_v.len() != node_count
        || result.spin_current_tensor_row_major_qia_apm2.len() != node_count
        || result.torque_xyz_per_s.len() != node_count
    {
        return Err(RunError {
            message:
                "native FEM transport outputs have an invalid revision or disagree on node count"
                    .into(),
        });
    }
    let scope = format!("transport_module:{}:full_solve_domain", resolved.module_id);
    let fields = [
        (
            "V_electric",
            1,
            "scalar",
            result.electric_potential_v.clone(),
        ),
        (
            "J_charge",
            3,
            "xyz",
            result
                .charge_current_density_xyz_apm2
                .iter()
                .flatten()
                .copied()
                .collect(),
        ),
        (
            "spin_potential",
            3,
            "xyz",
            result
                .spin_potential_xyz_v
                .iter()
                .flatten()
                .copied()
                .collect(),
        ),
        (
            "spin_current_tensor",
            9,
            "row_major_Q_ia",
            result
                .spin_current_tensor_row_major_qia_apm2
                .iter()
                .flatten()
                .copied()
                .collect(),
        ),
        (
            "torque_stt",
            3,
            "xyz",
            result.torque_xyz_per_s.iter().flatten().copied().collect(),
        ),
    ];
    fields
        .into_iter()
        .enumerate()
        .map(
            |(index, (quantity_id, component_count, component_order, values))| {
                let spec =
                    fullmag_quantities::quantity_spec(quantity_id).ok_or_else(|| RunError {
                        message: format!("uncatalogued FEM transport quantity '{quantity_id}'"),
                    })?;
                if spec.n_comp != component_count {
                    return Err(RunError {
                        message: format!(
                        "FEM transport quantity '{quantity_id}' catalog component count changed"
                    ),
                    });
                }
                FieldSnapshot::new(
                    quantity_id,
                    0,
                    0.0,
                    0.0,
                    component_count,
                    component_order,
                    spec.location.as_str(),
                    scope.clone(),
                    first_revision + index as u64,
                    values,
                )
                .map_err(|message| RunError { message })
            },
        )
        .collect()
}
