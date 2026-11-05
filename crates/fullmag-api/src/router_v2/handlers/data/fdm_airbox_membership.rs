//! Exact Airbox-grid ownership derived from canonical FDM multilayer masks.
//!
//! Airbox field samples remain the unmodified solver universe. This adapter
//! projects the accepted native active-cell masks onto that grid by testing
//! each Airbox cell centre against native half-open cells.

use std::collections::HashSet;

use serde_json::Value;

use super::domain::{
    parse_planned_native_active_mask, validate_declared_layer_counts,
    validate_declared_mask_presence,
};
use super::multilayer_identity::correlate_multilayer_layers;
use super::resolved_spatial_field::load_fdm_multilayer_native_layer_membership;
use crate::error::ApiError;
use crate::types::SessionStateResponse;

const INACTIVE_MEMBERSHIP: u32 = u32::MAX;

#[derive(Debug, Clone, Copy, PartialEq)]
struct GridGeometry {
    cells: [u32; 3],
    origin_m: [f64; 3],
    cell_size_m: [f64; 3],
}

impl GridGeometry {
    fn cell_count(self, label: &str) -> Result<usize, ApiError> {
        self.cells
            .into_iter()
            .try_fold(1usize, |count, axis| {
                (axis > 0).then_some(())?;
                count.checked_mul(axis as usize)
            })
            .ok_or_else(|| {
                ApiError::conflict(format!("{label} has invalid or overflowing grid cells"))
            })
    }

    fn validate(self, label: &str) -> Result<(), ApiError> {
        self.cell_count(label)?;
        if self.origin_m.iter().any(|value| !value.is_finite())
            || self
                .cell_size_m
                .iter()
                .any(|value| !value.is_finite() || *value <= 0.0)
        {
            return Err(ApiError::conflict(format!(
                "{label} grid geometry is non-finite or non-positive"
            )));
        }
        for axis in 0..3 {
            let upper = self.origin_m[axis] + f64::from(self.cells[axis]) * self.cell_size_m[axis];
            if !upper.is_finite() {
                return Err(ApiError::conflict(format!(
                    "{label} grid extent overflows on axis {axis}"
                )));
            }
        }
        Ok(())
    }
}

struct LayerDescriptor<'a> {
    artifact: Option<&'a Value>,
    plan: Option<&'a Value>,
}

/// Return one bit per Airbox carrier cell: `true` means no native magnetic
/// layer owns that cell centre. Field values are never modified here.
pub(super) fn resolve_fdm_airbox_membership(
    snapshot: &SessionStateResponse,
    cells: [u32; 3],
    origin_m: [f64; 3],
    cell_size_m: [f64; 3],
) -> Result<Vec<bool>, ApiError> {
    let target = GridGeometry {
        cells,
        origin_m,
        cell_size_m,
    };
    target.validate("FDM Airbox carrier")?;
    let mut air = vec![true; target.cell_count("FDM Airbox carrier")?];
    let descriptors = layer_descriptors(snapshot)?;

    for descriptor in descriptors {
        let source_value = descriptor.plan.or(descriptor.artifact).ok_or_else(|| {
            ApiError::conflict("multilayer FDM layer has no validated descriptor")
        })?;
        let layer_id = required_string(source_value, "layer_id", "multilayer FDM layer")?;
        let geometry = parse_geometry(source_value, "multilayer FDM layer")?;
        if let Some(artifact) = descriptor.artifact {
            validate_matching_descriptors(artifact, source_value)?;
        }

        // Geometry-disjoint legacy descriptors cannot own a target centre, so
        // their old membership payload is not needed. Overlapping layers still
        // require the canonical, validated plan-first/persisted mask below.
        let maps = target_to_native_axis_maps(target, geometry)?;
        if maps.iter().any(Vec::is_empty) {
            continue;
        }

        let active_mask = resolve_layer_active_mask(snapshot, &descriptor, layer_id, geometry)?;
        exclude_active_layer(
            &mut air,
            target.cells,
            geometry.cells,
            active_mask.as_deref(),
            &maps,
        );
    }

    Ok(air)
}

fn resolve_layer_active_mask(
    snapshot: &SessionStateResponse,
    descriptor: &LayerDescriptor<'_>,
    layer_id: &str,
    geometry: GridGeometry,
) -> Result<Option<Vec<bool>>, ApiError> {
    let total = geometry.cell_count("multilayer FDM layer")?;
    let artifact_mask =
        parse_planned_native_active_mask(descriptor.artifact, layer_id, total as u64)?;
    let artifact_declares_mask = descriptor
        .artifact
        .and_then(|layer| layer.get("active_mask_present"))
        .and_then(Value::as_bool);
    let (mask, mask_present) = if descriptor.plan.is_some() {
        // A plan's native mask is the solver's occupancy. A missing mask
        // means the complete native grid, independently of its regions.
        let mask = parse_planned_native_active_mask(descriptor.plan, layer_id, total as u64)?;
        let present = mask.is_some();
        (mask, present)
    } else if descriptor
        .artifact
        .is_some_and(|layer| has_explicit_dense_occupancy(layer, total as u64))
    {
        (None, false)
    } else {
        let membership = load_fdm_multilayer_native_layer_membership(snapshot, layer_id)?
            .ok_or_else(|| {
                ApiError::conflict(format!(
                    "multilayer FDM layer '{layer_id}' has no authoritative native occupancy"
                ))
            })?;
        if membership.cells != geometry.cells
            || membership.origin_m != geometry.origin_m
            || membership.cell_size_m != geometry.cell_size_m
            || membership.membership.cell_membership.len() != total
        {
            return Err(ApiError::conflict(format!(
                "multilayer FDM layer '{layer_id}' occupancy grid disagrees with its descriptor"
            )));
        }
        let mask = membership
            .membership
            .cell_membership
            .into_iter()
            .map(|cell| cell != INACTIVE_MEMBERSHIP)
            .collect::<Vec<_>>();
        (Some(mask), artifact_declares_mask.unwrap_or(true))
    };
    if artifact_mask
        .as_deref()
        .is_some_and(|declared| !mask_present || Some(declared) != mask.as_deref())
    {
        return Err(ApiError::conflict(format!(
            "multilayer FDM layer '{layer_id}' artifact native_active_mask disagrees with its occupancy"
        )));
    }
    validate_declared_mask_presence(descriptor.artifact, descriptor.plan, layer_id, mask_present)?;
    let active = mask
        .as_deref()
        .map_or(total, |mask| mask.iter().filter(|&&cell| cell).count());
    validate_declared_layer_counts(
        descriptor.artifact,
        descriptor.plan,
        layer_id,
        total as u64,
        active as u64,
        (total - active) as u64,
        mask_present,
    )?;
    Ok(mask)
}

fn has_explicit_dense_occupancy(layer: &Value, total: u64) -> bool {
    layer.get("active_mask_present").and_then(Value::as_bool) == Some(false)
        && layer.get("active_cell_count").and_then(Value::as_u64) == Some(total)
        && layer.get("inactive_cell_count").and_then(Value::as_u64) == Some(0)
        && ["native_region_mask", "native_region_legend"]
            .iter()
            .all(|&key| {
                layer
                    .get(key)
                    .and_then(|descriptor| descriptor.get("available"))
                    .and_then(Value::as_bool)
                    != Some(true)
            })
}

fn layer_descriptors(
    snapshot: &SessionStateResponse,
) -> Result<Vec<LayerDescriptor<'_>>, ApiError> {
    let metadata = snapshot
        .metadata
        .as_ref()
        .ok_or_else(|| ApiError::conflict("multilayer FDM occupancy has no metadata"))?;

    let artifact_layers = match metadata.get("artifact_layout") {
        Some(layout) => {
            if layout.get("backend").and_then(Value::as_str) != Some("fdm_multilayer") {
                return Err(ApiError::conflict(
                    "Airbox occupancy artifact layout is not FDM multilayer",
                ));
            }
            Some(
                layout
                    .get("layers")
                    .and_then(Value::as_array)
                    .filter(|layers| !layers.is_empty())
                    .ok_or_else(|| {
                        ApiError::conflict("multilayer FDM artifact layout has no native layers")
                    })?,
            )
        }
        None => None,
    };

    let plan_backend = metadata
        .get("execution_plan")
        .and_then(|plan| plan.get("backend_plan"));
    let plan_layers = match plan_backend {
        Some(backend) if backend.get("kind").and_then(Value::as_str) == Some("fdm_multilayer") => {
            Some(
                backend
                    .get("layers")
                    .and_then(Value::as_array)
                    .filter(|layers| !layers.is_empty())
                    .ok_or_else(|| {
                        ApiError::conflict("multilayer FDM execution plan has no native layers")
                    })?,
            )
        }
        Some(_) if artifact_layers.is_some() => {
            return Err(ApiError::conflict(
                "multilayer FDM artifact layout disagrees with its execution plan",
            ));
        }
        _ => None,
    };

    let mut descriptors = Vec::new();
    match (artifact_layers, plan_layers) {
        (Some(artifacts), Some(plans)) => {
            for (artifact, plan) in correlate_multilayer_layers(artifacts, plans)? {
                descriptors.push(LayerDescriptor {
                    artifact: Some(artifact),
                    plan: Some(plan),
                });
            }
        }
        (Some(artifacts), None) => {
            descriptors.extend(artifacts.iter().map(|artifact| LayerDescriptor {
                artifact: Some(artifact),
                plan: None,
            }));
        }
        (None, Some(plans)) => {
            descriptors.extend(plans.iter().map(|plan| LayerDescriptor {
                artifact: None,
                plan: Some(plan),
            }));
        }
        (None, None) => {
            return Err(ApiError::conflict(
                "multilayer FDM occupancy has no native layer descriptors",
            ));
        }
    }

    let mut layer_ids = HashSet::with_capacity(descriptors.len());
    for descriptor in &descriptors {
        let source = descriptor
            .plan
            .or(descriptor.artifact)
            .ok_or_else(|| ApiError::conflict("multilayer FDM layer has no descriptor"))?;
        let layer_id = required_string(source, "layer_id", "multilayer FDM layer")?;
        if !layer_ids.insert(layer_id.to_string()) {
            return Err(ApiError::conflict(format!(
                "multilayer FDM layer identity is ambiguous: '{layer_id}'"
            )));
        }
    }
    Ok(descriptors)
}

fn validate_matching_descriptors(artifact: &Value, plan: &Value) -> Result<(), ApiError> {
    for key in ["layer_id", "object_id", "magnet_name"] {
        let artifact_value = required_string(artifact, key, "multilayer FDM artifact layer")?;
        let plan_value = required_string(plan, key, "multilayer FDM plan layer")?;
        if artifact_value != plan_value {
            return Err(ApiError::conflict(format!(
                "multilayer FDM artifact and plan disagree on '{key}'"
            )));
        }
    }
    let artifact_geometry = parse_geometry(artifact, "multilayer FDM artifact layer")?;
    let plan_geometry = parse_geometry(plan, "multilayer FDM plan layer")?;
    if artifact_geometry != plan_geometry {
        return Err(ApiError::conflict(
            "multilayer FDM artifact and plan layer grids disagree",
        ));
    }
    Ok(())
}

fn parse_geometry(value: &Value, label: &str) -> Result<GridGeometry, ApiError> {
    let cells = required_array3(value, "native_grid", label)?;
    let origin_m = required_array3(value, "native_origin", label)?;
    let cell_size_m = required_array3(value, "native_cell_size", label)?;
    let geometry = GridGeometry {
        cells,
        origin_m,
        cell_size_m,
    };
    geometry.validate(label)?;
    Ok(geometry)
}

fn required_string<'a>(value: &'a Value, key: &str, label: &str) -> Result<&'a str, ApiError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| ApiError::conflict(format!("{label} is missing valid '{key}'")))
}

fn required_array3<T: for<'de> serde::Deserialize<'de>>(
    value: &Value,
    key: &str,
    label: &str,
) -> Result<[T; 3], ApiError> {
    serde_json::from_value(value.get(key).cloned().unwrap_or(Value::Null))
        .map_err(|error| ApiError::conflict(format!("{label} has invalid '{key}': {error}")))
}

fn target_to_native_axis_maps(
    target: GridGeometry,
    source: GridGeometry,
) -> Result<[Vec<(usize, usize)>; 3], ApiError> {
    target.validate("FDM Airbox carrier")?;
    source.validate("multilayer FDM layer")?;
    let mut maps: [Vec<(usize, usize)>; 3] = std::array::from_fn(|_| Vec::new());
    for axis in 0..3 {
        let target_count = target.cells[axis] as usize;
        let source_upper =
            source.origin_m[axis] + f64::from(source.cells[axis]) * source.cell_size_m[axis];
        for target_index in 0..target_count {
            let center =
                target.origin_m[axis] + (target_index as f64 + 0.5) * target.cell_size_m[axis];
            if !center.is_finite() || center < source.origin_m[axis] || center >= source_upper {
                continue;
            }
            let source_index =
                ((center - source.origin_m[axis]) / source.cell_size_m[axis]).floor();
            if source_index < 0.0 || source_index >= f64::from(source.cells[axis]) {
                continue;
            }
            maps[axis].push((target_index, source_index as usize));
        }
    }
    Ok(maps)
}

fn exclude_active_layer(
    air: &mut [bool],
    target: [u32; 3],
    native: [u32; 3],
    active_mask: Option<&[bool]>,
    maps: &[Vec<(usize, usize)>; 3],
) {
    let [tx, ty, _] = target.map(|count| count as usize);
    let [nx, ny, _] = native.map(|count| count as usize);
    for &(target_z, native_z) in &maps[2] {
        for &(target_y, native_y) in &maps[1] {
            for &(target_x, native_x) in &maps[0] {
                let source = (native_z * ny + native_y) * nx + native_x;
                if active_mask.is_none_or(|mask| mask[source]) {
                    air[(target_z * ty + target_y) * tx + target_x] = false;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{exclude_active_layer, target_to_native_axis_maps, GridGeometry};

    fn mark_layer(
        air: &mut [bool],
        target: GridGeometry,
        source: GridGeometry,
        active_mask: &[bool],
    ) {
        let maps = target_to_native_axis_maps(target, source).expect("valid grid maps");
        exclude_active_layer(air, target.cells, source.cells, Some(active_mask), &maps);
    }

    #[test]
    fn airbox_mapping_uses_cell_centres_half_open_bounds_and_active_cells() {
        let target = GridGeometry {
            cells: [4, 1, 1],
            origin_m: [-0.5, 0.0, 0.0],
            cell_size_m: [1.0; 3],
        };
        let source = GridGeometry {
            cells: [2, 1, 1],
            origin_m: [0.0; 3],
            cell_size_m: [1.0; 3],
        };
        let mut air = vec![true; 4];
        mark_layer(&mut air, target, source, &[true, false]);

        // Centres 0 and 1 map to [0, 1); centre 2 is the excluded upper edge.
        assert_eq!(air, vec![false, true, true, true]);
    }

    #[test]
    fn airbox_resolves_dense_plan_without_region_membership() {
        use crate::session::default_current_live_state;
        use crate::types::CurrentLiveSnapshotRequest;

        let request: CurrentLiveSnapshotRequest =
            serde_json::from_value(serde_json::json!({"session_id": "airbox-dense-layer"}))
                .expect("minimal live snapshot request should deserialize");
        let mut snapshot = default_current_live_state(&request);
        let cells = [2, 1, 1];
        let origin = [0.0; 3];
        let cell_size = [1.0; 3];
        let fingerprint = fullmag_ir::FdmGridCertificateIR::new(origin, cells, cell_size, 2, 1)
            .expect("valid dense layer certificate")
            .grid_fingerprint;
        let plan_layer = serde_json::json!({
            "layer_id": "layer:film",
            "object_id": "film",
            "magnet_name": "Film",
            "native_grid": cells,
            "native_origin": origin,
            "native_cell_size": cell_size,
        });
        let mut artifact_layer = plan_layer.clone();
        artifact_layer["native_grid_fingerprint"] =
            serde_json::json!(format!("sha256:{fingerprint}"));
        artifact_layer["active_mask_present"] = serde_json::json!(false);
        artifact_layer["total_cell_count"] = serde_json::json!(2);
        artifact_layer["active_cell_count"] = serde_json::json!(2);
        artifact_layer["inactive_cell_count"] = serde_json::json!(0);
        artifact_layer["native_region_mask"] = serde_json::json!({"available": false});
        artifact_layer["native_region_legend"] = serde_json::json!({"available": false});
        snapshot.metadata = Some(
            serde_json::json!({
                "artifact_layout": {
                    "backend": "fdm_multilayer",
                    "layers": [artifact_layer],
                },
                "execution_plan": {
                    "backend_plan": {
                        "kind": "fdm_multilayer",
                        "layers": [plan_layer],
                    },
                },
            })
            .into(),
        );
        let resolve = |snapshot: &crate::types::SessionStateResponse| {
            super::resolve_fdm_airbox_membership(snapshot, [4, 1, 1], [-1.0, 0.0, 0.0], cell_size)
        };
        let expected = vec![true, false, false, true];
        assert_eq!(resolve(&snapshot).unwrap(), expected);

        let metadata = snapshot.metadata.as_mut().unwrap().as_object_mut().unwrap();
        metadata.remove("execution_plan");
        assert_eq!(resolve(&snapshot).unwrap(), expected);
    }

    #[test]
    fn airbox_mapping_projects_different_cell_sizes_and_unions_layers() {
        let target = GridGeometry {
            cells: [4, 1, 1],
            origin_m: [0.0; 3],
            cell_size_m: [0.5, 1.0, 1.0],
        };
        let coarse = GridGeometry {
            cells: [2, 1, 1],
            origin_m: [0.0; 3],
            cell_size_m: [1.0; 3],
        };
        let second = GridGeometry {
            cells: [1, 1, 1],
            origin_m: [1.5, 0.0, 0.0],
            cell_size_m: [1.0; 3],
        };
        let mut air = vec![true; 4];
        mark_layer(&mut air, target, coarse, &[true, false]);
        mark_layer(&mut air, target, second, &[true]);

        // The fine target centres in the first coarse cell are owned; the
        // inactive second coarse cell stays air, while the second layer owns
        // the final target centre.
        assert_eq!(air, vec![false, false, true, false]);
    }
}
