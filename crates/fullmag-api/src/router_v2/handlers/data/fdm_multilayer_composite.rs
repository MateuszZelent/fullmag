//! Composite structured carrier of an FDM multilayer field for planar sampling.
//!
//! A multilayer plan publishes the native cell values of each layer one after
//! another; its common transform layout is FFT scratch, not a mesh. When all
//! native grids share one spacing and lie on one lattice, they embed exactly
//! into a bounding grid (docs/physics/0970, eq-planar-multilayer-embedding):
//! every covered cell carries one native value and uncovered cells carry none.

use std::collections::BTreeMap;

use sha2::{Digest, Sha256};

use super::multilayer_identity::correlate_multilayer_layers;
use super::resolved_spatial_field::{
    planned_fdm_multilayer_native_layer_membership, FdmCellMembership, ResolvedSpatialField,
    SpatialFieldCarrier,
};
use crate::error::ApiError;
use crate::schemas::domain::{Bounds3, DomainMeta, StructuredGridDescriptor};
use crate::schemas::mesh::FdmRegionLegendEntryResource;
use crate::types::SessionStateResponse;

const SPACING_RELATIVE_TOLERANCE: f64 = 1.0e-9;
const SHIFT_CELL_TOLERANCE: f64 = 1.0e-6;

#[derive(Debug, Clone)]
struct CompositeLayer {
    value_offset: usize,
    native_cells: [u32; 3],
    shift: [u32; 3],
}

#[derive(Debug, Clone)]
pub(crate) struct FdmMultilayerComposite {
    pub cells: [u32; 3],
    pub origin_m: [f64; 3],
    pub cell_size_m: [f64; 3],
    pub fingerprint: String,
    pub coverage: Vec<bool>,
    pub membership: FdmCellMembership,
    native_value_count: usize,
    layers: Vec<CompositeLayer>,
}

struct NativeLayer {
    layer_id: String,
    value_offset: usize,
    cells: [u32; 3],
    origin_m: [f64; 3],
    cell_size_m: [f64; 3],
    grid_fingerprint: String,
    membership_fingerprint: String,
    membership: FdmCellMembership,
}

fn unsupported(reason: &str) -> ApiError {
    ApiError::unprocessable(format!("planar_scope_unsupported: {reason}; use layer scope"))
}

fn cell_count(cells: [u32; 3]) -> Option<usize> {
    cells
        .into_iter()
        .try_fold(1usize, |count, axis| count.checked_mul(axis as usize))
}

/// Resolve the composite carrier of the current multilayer plan, or `None`
/// when the session is not an FDM multilayer.
pub(crate) fn resolve_fdm_multilayer_composite(
    snapshot: &SessionStateResponse,
) -> Result<Option<FdmMultilayerComposite>, ApiError> {
    let Some(metadata) = snapshot.metadata.as_ref() else {
        return Ok(None);
    };
    let Some(layout) = metadata.get("artifact_layout").filter(|layout| {
        layout.get("backend").and_then(serde_json::Value::as_str) == Some("fdm_multilayer")
    }) else {
        return Ok(None);
    };
    let artifact_layers = layout
        .get("layers")
        .and_then(serde_json::Value::as_array)
        .filter(|layers| !layers.is_empty())
        .ok_or_else(|| ApiError::conflict("multilayer FDM artifact layout has no native layers"))?;
    let plan_layers = metadata
        .get("execution_plan")
        .and_then(|plan| plan.get("backend_plan"))
        .and_then(|plan| plan.get("layers"))
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| ApiError::conflict("multilayer FDM execution plan has no native layers"))?;
    let mut layers = Vec::with_capacity(artifact_layers.len());
    for (artifact_layer, plan_layer) in correlate_multilayer_layers(artifact_layers, plan_layers)? {
        let layer_id = plan_layer
            .get("layer_id")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| ApiError::conflict("multilayer FDM layer has no canonical layer_id"))?;
        let value_offset = artifact_layer
            .get("value_offset")
            .and_then(serde_json::Value::as_u64)
            .and_then(|value| usize::try_from(value).ok())
            .ok_or_else(|| ApiError::conflict("multilayer FDM layer has no valid value_offset"))?;
        let value_count = artifact_layer
            .get("value_count")
            .and_then(serde_json::Value::as_u64)
            .and_then(|value| usize::try_from(value).ok())
            .ok_or_else(|| ApiError::conflict("multilayer FDM layer has no valid value_count"))?;
        let carrier = planned_fdm_multilayer_native_layer_membership(snapshot, layer_id)?
            .ok_or_else(|| {
                ApiError::conflict(format!(
                    "multilayer FDM layer '{layer_id}' has no native membership carrier"
                ))
            })?;
        if cell_count(carrier.cells) != Some(value_count) {
            return Err(ApiError::conflict(format!(
                "multilayer FDM layer '{layer_id}' native grid disagrees with its payload range"
            )));
        }
        layers.push(NativeLayer {
            layer_id: carrier.layer_id,
            value_offset,
            cells: carrier.cells,
            origin_m: carrier.origin_m,
            cell_size_m: carrier.cell_size_m,
            grid_fingerprint: carrier.grid_fingerprint,
            membership_fingerprint: carrier.membership_fingerprint,
            membership: carrier.membership,
        });
    }
    compose(layers).map(Some)
}

fn compose(mut layers: Vec<NativeLayer>) -> Result<FdmMultilayerComposite, ApiError> {
    layers.sort_by_key(|layer| layer.value_offset);
    let first = layers
        .first()
        .ok_or_else(|| ApiError::conflict("multilayer FDM artifact layout has no native layers"))?;
    let cell_size_m = first.cell_size_m;
    let mut native_value_count = 0usize;
    for layer in &layers {
        let same_spacing = (0..3).all(|axis| {
            (layer.cell_size_m[axis] - cell_size_m[axis]).abs()
                <= SPACING_RELATIVE_TOLERANCE * cell_size_m[axis].abs()
        });
        if !same_spacing {
            return Err(unsupported("multilayer native grids have different cell sizes"));
        }
        if layer.value_offset != native_value_count {
            return Err(ApiError::conflict(
                "multilayer FDM layer payload ranges are not contiguous",
            ));
        }
        native_value_count = cell_count(layer.cells)
            .and_then(|count| native_value_count.checked_add(count))
            .ok_or_else(|| ApiError::conflict("multilayer FDM cell count overflowed"))?;
    }
    let origin_m: [f64; 3] = std::array::from_fn(|axis| {
        layers
            .iter()
            .map(|layer| layer.origin_m[axis])
            .fold(f64::INFINITY, f64::min)
    });
    let mut composite_layers = Vec::with_capacity(layers.len());
    let mut cells = [0u32; 3];
    for layer in &layers {
        let mut shift = [0u32; 3];
        for axis in 0..3 {
            let exact = (layer.origin_m[axis] - origin_m[axis]) / cell_size_m[axis];
            let rounded = exact.round();
            if !exact.is_finite() || (exact - rounded).abs() > SHIFT_CELL_TOLERANCE {
                return Err(unsupported(
                    "multilayer native grids are not aligned on one lattice",
                ));
            }
            shift[axis] = u32::try_from(rounded as i64)
                .map_err(|_| ApiError::conflict("multilayer FDM layer shift is out of range"))?;
            let end = shift[axis]
                .checked_add(layer.cells[axis])
                .ok_or_else(|| ApiError::conflict("multilayer FDM composite grid overflowed"))?;
            cells[axis] = cells[axis].max(end);
        }
        composite_layers.push(CompositeLayer {
            value_offset: layer.value_offset,
            native_cells: layer.cells,
            shift,
        });
    }
    let total = cell_count(cells)
        .ok_or_else(|| ApiError::conflict("multilayer FDM composite grid overflowed"))?;
    let mut coverage = vec![false; total];
    let mut cell_membership = vec![u32::MAX; total];
    for (layer, placement) in layers.iter().zip(&composite_layers) {
        let mut overlap = false;
        for_each_embedded_cell(cells, placement, |native, composite| {
            overlap |= coverage[composite];
            coverage[composite] = true;
            cell_membership[composite] = layer.membership.cell_membership[native];
        });
        if overlap {
            return Err(unsupported("multilayer native grids overlap"));
        }
    }
    let mut object_ids = Vec::new();
    let mut legend = BTreeMap::<u32, FdmRegionLegendEntryResource>::new();
    for layer in &layers {
        for object_id in &layer.membership.object_ids {
            if !object_ids.contains(object_id) {
                object_ids.push(object_id.clone());
            }
        }
        for entry in &layer.membership.region_legend {
            match legend.get(&entry.numeric_id) {
                Some(existing) if existing != entry => {
                    return Err(unsupported("multilayer native region legends disagree"));
                }
                Some(_) => {}
                None => {
                    legend.insert(entry.numeric_id, entry.clone());
                }
            }
        }
    }
    let mut digest = Sha256::new();
    digest.update(format!("fdm_multilayer_composite.v1:{cells:?}:{origin_m:?}:{cell_size_m:?}"));
    for (layer, placement) in layers.iter().zip(&composite_layers) {
        digest.update(format!(
            ":{}:{}:{}:{:?}",
            layer.layer_id, layer.grid_fingerprint, layer.membership_fingerprint, placement.shift
        ));
    }
    Ok(FdmMultilayerComposite {
        cells,
        origin_m,
        cell_size_m,
        fingerprint: format!("sha256:{:x}", digest.finalize()),
        coverage,
        membership: FdmCellMembership {
            object_ids,
            region_legend: legend.into_values().collect(),
            cell_membership,
        },
        native_value_count,
        layers: composite_layers,
    })
}

/// Calls `visit(native_index, composite_index)` for every native cell of a layer.
fn for_each_embedded_cell(
    cells: [u32; 3],
    layer: &CompositeLayer,
    mut visit: impl FnMut(usize, usize),
) {
    let [nx, ny, nz] = layer.native_cells;
    let [sx, sy, sz] = layer.shift;
    for z in 0..nz {
        for y in 0..ny {
            for x in 0..nx {
                let native = ((z * ny + y) * nx + x) as usize;
                let composite = (((z + sz) * cells[1] + y + sy) * cells[0] + x + sx) as usize;
                visit(native, composite);
            }
        }
    }
}

impl FdmMultilayerComposite {
    /// Re-index concatenated native values onto the composite grid; uncovered
    /// cells hold zero but are outside every target through `coverage`.
    fn compose_values(&self, native: &[f64], n_comp: usize) -> Result<Vec<f64>, ApiError> {
        if n_comp == 0 || native.len() != self.native_value_count.saturating_mul(n_comp) {
            return Err(ApiError::conflict(
                "multilayer FDM field length does not match native layer payload layout",
            ));
        }
        let mut values = vec![0.0; self.coverage.len() * n_comp];
        for layer in &self.layers {
            for_each_embedded_cell(self.cells, layer, |local, composite| {
                let source = (layer.value_offset + local) * n_comp;
                values[composite * n_comp..(composite + 1) * n_comp]
                    .copy_from_slice(&native[source..source + n_comp]);
            });
        }
        Ok(values)
    }

    /// Replace a concatenated multilayer carrier by the composite grid.
    pub(crate) fn embed<'a>(
        &self,
        mut field: ResolvedSpatialField<'a>,
    ) -> Result<ResolvedSpatialField<'a>, ApiError> {
        if !matches!(
            field.carrier,
            SpatialFieldCarrier::FdmCells {
                multilayer_scope: Some(_),
                ..
            }
        ) {
            return Ok(field);
        }
        field.values = self.compose_values(&field.values, field.component_count)?;
        field.source_grid = Some(self.cells);
        field.carrier = SpatialFieldCarrier::FdmCells {
            cells: self.cells,
            origin_m: Some(self.origin_m),
            cell_size_m: Some(self.cell_size_m),
            grid_fingerprint: Some(self.fingerprint.clone()),
            membership: Some(self.membership.clone()),
            membership_error: None,
            multilayer_scope: None,
            coverage: Some(self.coverage.clone()),
        };
        field.validate_contract()?;
        Ok(field)
    }

    /// Default-section domain: the composite lattice, not the FFT scratch layout.
    pub(crate) fn apply_to_domain(&self, domain: &mut DomainMeta) {
        let max = std::array::from_fn(|axis| {
            self.origin_m[axis] + f64::from(self.cells[axis]) * self.cell_size_m[axis]
        });
        domain.bounds = Bounds3 {
            min: self.origin_m,
            max,
        };
        domain.grid = Some(StructuredGridDescriptor {
            shape: self.cells,
            origin: self.origin_m,
            spacing: self.cell_size_m,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::{compose, FdmCellMembership, NativeLayer};
    use crate::schemas::mesh::FdmRegionLegendEntryResource;

    const H: f64 = 2.5e-9;

    fn layer(name: &str, offset: usize, cells: [u32; 3], origin: [f64; 3]) -> NativeLayer {
        let count = (cells[0] * cells[1] * cells[2]) as usize;
        NativeLayer {
            layer_id: format!("layer:{name}"),
            value_offset: offset,
            cells,
            origin_m: origin,
            cell_size_m: [H; 3],
            grid_fingerprint: format!("grid-{name}"),
            membership_fingerprint: format!("membership-{name}"),
            membership: FdmCellMembership {
                object_ids: vec![name.to_string()],
                region_legend: vec![FdmRegionLegendEntryResource {
                    numeric_id: 0,
                    object_id: "shared".to_string(),
                    region_id: "default".to_string(),
                    priority: 0,
                }],
                cell_membership: vec![0; count],
            },
        }
    }

    #[test]
    fn stacked_layers_embed_with_an_uncovered_gap() {
        // Film z in [0, 2h), cylinder z in [3h, 5h): one empty layer between.
        let film = layer("film", 0, [2, 1, 2], [0.0, 0.0, 0.0]);
        let cylinder = layer("cylinder", 4, [1, 1, 2], [H, 0.0, 3.0 * H]);
        let composite = compose(vec![film, cylinder]).expect("aligned layers compose");
        assert_eq!(composite.cells, [2, 1, 5]);
        assert_eq!(
            composite.coverage,
            vec![true, true, true, true, false, false, false, true, false, true]
        );
        let native = (0..6).map(f64::from).collect::<Vec<_>>();
        let values = composite.compose_values(&native, 1).expect("values compose");
        assert_eq!(values, vec![0.0, 1.0, 2.0, 3.0, 0.0, 0.0, 0.0, 4.0, 0.0, 5.0]);
        assert_eq!(composite.membership.object_ids, vec!["film", "cylinder"]);
        assert_eq!(composite.membership.cell_membership[4], u32::MAX);
    }

    #[test]
    fn misaligned_overlapping_or_unequal_layers_fail_closed() {
        let film = || layer("film", 0, [2, 1, 2], [0.0, 0.0, 0.0]);
        let half_shift = layer("top", 4, [1, 1, 1], [0.5 * H, 0.0, 3.0 * H]);
        let overlap = layer("top", 4, [1, 1, 1], [H, 0.0, H]);
        let mut coarse = layer("top", 4, [1, 1, 1], [0.0, 0.0, 4.0 * H]);
        coarse.cell_size_m = [2.0 * H; 3];
        for layers in [vec![film(), half_shift], vec![film(), overlap], vec![film(), coarse]] {
            let error = compose(layers).expect_err("composite must fail closed");
            assert!(error.message.contains("planar_scope_unsupported"));
        }
    }
}
