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
    match quantity {
        "m" => backend.copy_m(node_count),
        "H_ex" => backend.copy_h_ex(node_count),
        "H_demag" => backend.copy_h_demag(node_count),
        "H_ext" => backend.copy_h_ext(node_count),
        "H_ani" => backend.copy_h_ani(node_count),
        "H_dmi" => backend.copy_h_dmi(node_count),
        "H_dmi_bulk" => backend.copy_h_dmi_bulk(node_count),
        "H_eff" => backend.copy_h_eff(node_count),
        other => Err(RunError {
            message: format!("unsupported native FEM field snapshot '{}'", other),
        }),
    }
}
