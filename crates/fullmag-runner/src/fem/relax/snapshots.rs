//! Field snapshot helpers for native FEM relaxation outputs.

use crate::native_fem::NativeFemBackend;
use crate::quantities::normalized_quantity_name;
use crate::types::RunError;

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
