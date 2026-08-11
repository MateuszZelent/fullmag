use std::collections::HashSet;

use serde_json::Value;

use crate::error::ApiError;

const IDENTITY_KEYS: [&str; 3] = ["layer_id", "object_id", "magnet_name"];
const SHARED_CONTRACT_KEYS: [&str; 7] = [
    "native_grid",
    "native_cell_size",
    "native_origin",
    "native_grid_fingerprint",
    "total_cell_count",
    "active_cell_count",
    "inactive_cell_count",
];

pub(crate) fn correlate_multilayer_layers<'a>(
    artifact_layers: &'a [Value],
    plan_layers: &'a [Value],
) -> Result<Vec<(&'a Value, &'a Value)>, ApiError> {
    if artifact_layers.len() != plan_layers.len() {
        return Err(ApiError::conflict(
            "multilayer FDM artifact and execution plan layer counts disagree",
        ));
    }
    let mut used_plan_indices = HashSet::new();
    let mut pairs = Vec::with_capacity(artifact_layers.len());
    for artifact_layer in artifact_layers {
        let candidates = plan_layers
            .iter()
            .enumerate()
            .filter(|(_, plan_layer)| {
                let shared = IDENTITY_KEYS.into_iter().filter_map(|key| {
                    Some((
                        artifact_layer.get(key)?.as_str()?,
                        plan_layer.get(key)?.as_str()?,
                    ))
                });
                let mut shared_count = 0usize;
                let all_equal = shared.fold(true, |all_equal, (artifact, plan)| {
                    shared_count += 1;
                    all_equal && artifact == plan
                });
                shared_count > 0 && all_equal
            })
            .collect::<Vec<_>>();
        let [(plan_index, plan_layer)] = candidates.as_slice() else {
            return Err(ApiError::conflict(
                "multilayer FDM artifact layer cannot be paired unambiguously with the execution plan",
            ));
        };
        if !used_plan_indices.insert(*plan_index) {
            return Err(ApiError::conflict(
                "multilayer FDM artifact layers do not map one-to-one to execution plan layers",
            ));
        }
        for key in SHARED_CONTRACT_KEYS {
            if let (Some(artifact_value), Some(plan_value)) =
                (artifact_layer.get(key), plan_layer.get(key))
            {
                if artifact_value != plan_value {
                    return Err(ApiError::conflict(format!(
                        "multilayer FDM artifact and execution plan layer field '{key}' disagree"
                    )));
                }
            }
        }
        pairs.push((artifact_layer, *plan_layer));
    }
    Ok(pairs)
}
