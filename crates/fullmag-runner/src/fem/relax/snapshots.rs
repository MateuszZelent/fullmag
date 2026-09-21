//! Field snapshot helpers for native FEM relaxation outputs.

use fullmag_ir::FemPlanIR;

use crate::antenna_fields::compute_antenna_field_at_time;
use crate::native_fem::NativeFemBackend;
use crate::quantities::normalized_quantity_name;
use crate::types::{FieldSnapshot, RunError};

fn antenna_snapshot_component(name: &str) -> Option<Option<usize>> {
    let (base, component) = name.split_once('.').unwrap_or((name, "3D"));
    if normalized_quantity_name(base).ok() != Some("H_ant") {
        return None;
    }
    Some(match component {
        "3D" => None,
        "x" => Some(0),
        "y" => Some(1),
        "z" => Some(2),
        _ => return None,
    })
}

pub(crate) fn is_antenna_field_snapshot(name: &str) -> bool {
    antenna_snapshot_component(name).is_some()
}

pub(crate) fn build_antenna_field_snapshot(
    plan: &FemPlanIR,
    name: &str,
    step: u64,
    time: f64,
    solver_dt: f64,
) -> Result<FieldSnapshot, RunError> {
    let component = antenna_snapshot_component(name).ok_or_else(|| RunError {
        message: format!("unsupported direct FEM antenna field snapshot '{name}'"),
    })?;
    let values = compute_antenna_field_at_time(plan, time)?;
    if values.len() != plan.mesh.nodes.len() {
        return Err(RunError {
            message: format!(
                "direct FEM antenna field snapshot '{}' returned {} nodes, expected {}",
                name,
                values.len(),
                plan.mesh.nodes.len()
            ),
        });
    }
    let values = match component {
        Some(index) => values
            .into_iter()
            .map(|value| [value[index], 0.0, 0.0])
            .collect(),
        None => values,
    };
    Ok(FieldSnapshot {
        name: name.to_string(),
        step,
        time,
        solver_dt,
        component_count: 3,
        component_order: "xyz".into(),
        location: "sample".into(),
        scope: "full".into(),
        revision: step.saturating_add(1),
        values: FieldSnapshot::flatten_vec3(values),
    })
}

pub(crate) fn copy_native_fem_field_snapshot(
    backend: &NativeFemBackend,
    name: &str,
    node_count: usize,
) -> Result<Vec<[f64; 3]>, RunError> {
    let quantity = normalized_quantity_name(name).map_err(|_| RunError {
        message: format!("unsupported native FEM field snapshot '{}'", name),
    })?;
    let values = backend
        .begin_field_snapshot(quantity, 0, 0.0, 0.0)?
        .into_vector_field()?;
    if values.len() != node_count {
        return Err(RunError {
            message: format!(
                "native FEM field snapshot '{}' returned {} nodes, expected {}",
                quantity,
                values.len(),
                node_count
            ),
        });
    }
    Ok(values)
}
