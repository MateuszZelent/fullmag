use fullmag_fdm_demag::{
    ActiveMaskIdentity, CommonTransformLayout, ConvolutionMode, FdmLayerDescriptor, GridGeometry,
    KernelAdmissionModel, KernelCatalogSpec, KernelMemoryAccounting, KernelPrecision,
    TensorRepresentation, TransferKind,
};
use fullmag_ir::{
    AxisBoundary, BackendPlanIR, BackendTarget, CommonPlanMeta, DiscretizationHintsIR,
    EnergyTermIR, ExchangeBoundaryCondition, ExchangeCouplingModeIR, ExecutionPlanIR,
    ExecutionPrecision, FdmGridCertificateIR, FdmLayerPlanIR, FdmMaterialIR, FdmMultilayerPlanIR,
    FdmMultilayerSummaryIR, FdmPlanIR, GeometryEntryIR, GridDimensions, InitialMagnetizationIR,
    IntegratorChoice, OutputPlanIR, ProblemIR, ProvenancePlanIR, RegionFrameIR, RegionShapeIR,
    RelaxationAlgorithmIR, SeedPolicy, ThermalSeedConfig, TimeDependenceIR, IR_VERSION,
};
use std::collections::{BTreeMap, BTreeSet};

use crate::antenna_zeeman::{has_prescribed_zeeman_mask_source, resolve_prescribed_zeeman_masks};
use crate::current_transport::{
    resolve_current_transports, resolve_fdm_gpu_charge_transports_with_active_graph,
    CurrentTransportExecutableLane,
};
use crate::error::PlanError;
use crate::geometry::{
    cell_for_magnet, checked_fdm_grid_cost, extract_multilayer_geometry, fdm_default_cell,
    ir_to_shape, shape_local_bounds, validate_realized_grid, voxelize_shape, GeometryShape,
    LoweredBody, FDM_GRID_ESTIMATED_BYTES_PER_CELL,
};
use crate::magnetization_textures::TextureSamplePoint;
use crate::magnetization_textures_v2::sample_preset_texture_versioned;
use crate::oersted::{resolve_fdm_oersted_term, ResolvedOerstedTerm};
use crate::region_conflict::{resolve_region_conflict, RegionConflictCandidate};
use crate::spin_torque::{
    resolve_legacy_spin_torque, resolve_sot_fields, SpinTorqueExecutableLane,
};
use crate::util::{generate_random_unit_vectors, runtime_requests_cuda, GRID_TOLERANCE, MU0};
use crate::validate::{
    planned_study_controls, validate_executable_outputs, validate_grid_asset_cell_size,
};

/// Calculate the full host tensor payload required by the multilayer ABI v2.
///
/// ABI v2 materializes one six-component `complex<f64>` tensor for every
/// ordered layer pair. `estimated_unique_kernels` remains reuse telemetry and
/// must not be used as an allocation estimate.
pub fn checked_multilayer_pair_kernel_footprint(
    common_cells: [u32; 3],
    layer_count: usize,
) -> Result<u64, PlanError> {
    let requested_counts = format!(
        "[{},{},{}]",
        common_cells[0], common_cells[1], common_cells[2]
    );
    let padded_cells = common_cells.into_iter().try_fold(1_u64, |acc, cells| {
        let cells = u64::try_from(cells).map_err(|_| PlanError {
            reasons: vec![format!(
                "multilayer_convolution padded cell conversion failed: requested_counts={requested_counts}"
            )],
        })?;
        let padded_axis = cells.checked_mul(2).ok_or_else(|| PlanError {
            reasons: vec![format!(
                "multilayer_convolution padded cell count overflow: requested_counts={requested_counts}"
            )],
        })?;
        acc.checked_mul(padded_axis).ok_or_else(|| PlanError {
            reasons: vec![format!(
                "multilayer_convolution padded cell count overflow: requested_counts={requested_counts}"
            )],
        })
    })?;
    let layer_count_u64 = u64::try_from(layer_count).map_err(|_| PlanError {
        reasons: vec![format!(
            "multilayer_convolution layer count conversion failed: layer_count={layer_count}"
        )],
    })?;
    let pair_kernel_count = layer_count_u64
        .checked_mul(layer_count_u64)
        .ok_or_else(|| PlanError {
            reasons: vec![format!(
                "multilayer_convolution pair kernel count overflow: layer_count={layer_count}"
            )],
        })?;
    let abi_v2_pair_limit = u64::try_from(u32::MAX).map_err(|_| PlanError {
        reasons: vec!["multilayer_convolution ABI v2 pair limit conversion failed".to_string()],
    })?;
    if pair_kernel_count > abi_v2_pair_limit {
        return Err(PlanError {
            reasons: vec![format!(
                "multilayer_convolution pair kernel count exceeds ABI v2 u32 limit: layer_count={layer_count} pair_kernel_count={pair_kernel_count} max_pair_kernel_count={abi_v2_pair_limit}"
            )],
        });
    }
    padded_cells
        .checked_mul(6)
        .and_then(|bytes| bytes.checked_mul(16))
        .and_then(|bytes| bytes.checked_mul(pair_kernel_count))
        .ok_or_else(|| PlanError {
            reasons: vec![format!(
                "multilayer_convolution kernel payload byte overflow: requested_counts={requested_counts} layer_count={layer_count}"
            )],
        })
}

/// Shared planner/runtime resolution of the canonical multilayer kernel catalog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedMultilayerKernelMemory {
    pub catalog: KernelCatalogSpec,
    pub accounting: KernelMemoryAccounting,
    pub common_grid_bytes: u64,
    pub native_grid_bytes: u64,
    pub aggregate_bytes: u64,
}

pub fn checked_multilayer_aggregate_memory_bytes(
    common_grid_bytes: u64,
    native_grid_bytes: u64,
    kernel_bytes: u64,
) -> Result<u64, PlanError> {
    let aggregate_bytes = common_grid_bytes
        .checked_add(native_grid_bytes)
        .and_then(|bytes| bytes.checked_add(kernel_bytes))
        .ok_or_else(|| PlanError {
            reasons: vec![
                "multilayer_convolution aggregate memory overflow before allocation".to_string(),
            ],
        })?;
    if aggregate_bytes > crate::FDM_GRID_MAX_BYTES {
        return Err(PlanError {
            reasons: vec![format!(
                "multilayer_convolution aggregate memory budget exceeded: common_grid_bytes={common_grid_bytes} native_grid_bytes={native_grid_bytes} kernel_bytes={kernel_bytes} estimated_bytes={aggregate_bytes} max_bytes={}",
                crate::FDM_GRID_MAX_BYTES
            )],
        });
    }
    Ok(aggregate_bytes)
}

pub fn resolve_multilayer_kernel_memory(
    mode: &str,
    common_cells: [u32; 3],
    layers: &[FdmLayerPlanIR],
    precision: ExecutionPrecision,
    demag_enabled: bool,
    admission_model: KernelAdmissionModel,
) -> Result<ResolvedMultilayerKernelMemory, PlanError> {
    let mode = match mode {
        "two_d_stack" => ConvolutionMode::TwoDStack,
        "three_d" => ConvolutionMode::ThreeD,
        other => {
            return Err(PlanError {
                reasons: vec![format!(
                    "unsupported multilayer kernel catalog mode '{other}'"
                )],
            })
        }
    };
    let common_cells = common_cells.map(|value| value as usize);
    if common_cells.contains(&0) || (mode == ConvolutionMode::TwoDStack && common_cells[2] != 1) {
        return Err(PlanError {
            reasons: vec![format!(
                "invalid multilayer kernel catalog common grid {common_cells:?} for mode {mode:?}"
            )],
        });
    }
    let mut fft_shape = [0_usize; 3];
    for axis in 0..3 {
        fft_shape[axis] = common_cells[axis].checked_mul(2).ok_or_else(|| PlanError {
            reasons: vec!["multilayer kernel FFT shape overflow".to_string()],
        })?;
    }
    if mode == ConvolutionMode::TwoDStack {
        fft_shape[2] = 1;
    }
    let fft_samples = fft_shape.into_iter().try_fold(1_usize, |product, value| {
        product.checked_mul(value).ok_or_else(|| PlanError {
            reasons: vec!["multilayer kernel FFT normalization overflow".to_string()],
        })
    })?;
    let layout = CommonTransformLayout::for_pair(
        common_cells,
        common_cells,
        mode,
        [0; 3],
        [0; 3],
        [0; 3],
        common_cells,
        fft_shape,
        1.0 / fft_samples as f64,
    )
    .map_err(|error| PlanError {
        reasons: vec![format!(
            "invalid multilayer kernel transform layout: {error}"
        )],
    })?;
    let descriptors = layers
        .iter()
        .map(|layer| {
            let native = GridGeometry::new(
                layer.native_origin,
                layer.native_grid.map(|value| value as usize),
                layer.native_cell_size,
            )?;
            let scratch = GridGeometry::new(
                layer.convolution_origin,
                layer.convolution_grid.map(|value| value as usize),
                layer.convolution_cell_size,
            )?;
            let active_mask = layer
                .native_active_mask
                .as_deref()
                .map(ActiveMaskIdentity::from_mask)
                .unwrap_or_else(ActiveMaskIdentity::all_active);
            let transfer = match layer.transfer_kind.as_str() {
                "identity" => TransferKind::Identity,
                "push_pull" => TransferKind::PushPull,
                other => {
                    return Err(fullmag_fdm_demag::DescriptorError::Invalid(format!(
                        "layer '{}' has unsupported transfer_kind '{other}'",
                        layer.layer_id
                    )))
                }
            };
            FdmLayerDescriptor::new(
                layer.layer_id.clone(),
                layer.object_id.clone(),
                native,
                scratch,
                mode,
                active_mask,
                transfer,
            )
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| PlanError {
            reasons: vec![format!(
                "invalid multilayer kernel layer descriptor: {error}"
            )],
        })?;
    let kernel_precision = match precision {
        ExecutionPrecision::Single => KernelPrecision::F32,
        ExecutionPrecision::Double => KernelPrecision::F64,
    };
    let catalog = KernelCatalogSpec::build_for_layers_with_layout(
        &descriptors,
        &layout,
        TensorRepresentation::FullComplex,
        kernel_precision,
    )
    .map_err(|error| PlanError {
        reasons: vec![format!("invalid multilayer kernel catalog: {error}")],
    })?;
    let accounting = KernelMemoryAccounting::for_catalog(
        &catalog,
        &layout,
        common_cells,
        demag_enabled,
        admission_model,
    )
    .map_err(|error| PlanError {
        reasons: vec![format!(
            "invalid multilayer kernel memory accounting: {error}"
        )],
    })?;
    let common_grid_bytes = checked_fdm_grid_cost(
        common_cells.map(|value| value as u32),
        FDM_GRID_ESTIMATED_BYTES_PER_CELL,
    )?
    .estimated_bytes;
    let native_grid_bytes = layers.iter().try_fold(0_u64, |bytes, layer| {
        let layer_bytes =
            checked_fdm_grid_cost(layer.native_grid, FDM_GRID_ESTIMATED_BYTES_PER_CELL)?
                .estimated_bytes;
        bytes.checked_add(layer_bytes).ok_or_else(|| PlanError {
            reasons: vec![
                "multilayer_convolution native-grid aggregate memory overflow".to_string(),
            ],
        })
    })?;
    let aggregate_bytes = checked_multilayer_aggregate_memory_bytes(
        common_grid_bytes,
        native_grid_bytes,
        accounting.admission_bytes,
    )
    .map_err(|error| PlanError {
        reasons: error
            .reasons
            .into_iter()
            .map(|reason| {
                format!(
                    "admission_model={} {reason}",
                    accounting.admission_model.as_str()
                )
            })
            .collect(),
    })?;
    let catalog = if admission_model == KernelAdmissionModel::CudaNativeSingleGrid {
        KernelCatalogSpec {
            keys: Vec::new(),
            pair_bindings: Vec::new(),
        }
    } else {
        catalog
    };
    Ok(ResolvedMultilayerKernelMemory {
        catalog,
        accounting,
        common_grid_bytes,
        native_grid_bytes,
        aggregate_bytes,
    })
}

fn grid_sample_points(
    grid_cells: [u32; 3],
    cell_size: [f64; 3],
    origin: [f64; 3],
    owner_translation: [f64; 3],
    active_mask: Option<&Vec<bool>>,
) -> Vec<TextureSamplePoint> {
    let nx = grid_cells[0] as usize;
    let ny = grid_cells[1] as usize;
    let nz = grid_cells[2] as usize;
    let capacity = checked_fdm_grid_cost(grid_cells, FDM_GRID_ESTIMATED_BYTES_PER_CELL)
        .ok()
        .and_then(|cost| usize::try_from(cost.cells).ok())
        .unwrap_or(0);
    let mut points = Vec::with_capacity(capacity);
    for z in 0..nz {
        for y in 0..ny {
            for x in 0..nx {
                let idx = x + nx * (y + ny * z);
                let world = [
                    origin[0] + (x as f64 + 0.5) * cell_size[0],
                    origin[1] + (y as f64 + 0.5) * cell_size[1],
                    origin[2] + (z as f64 + 0.5) * cell_size[2],
                ];
                let object = [
                    world[0] - owner_translation[0],
                    world[1] - owner_translation[1],
                    world[2] - owner_translation[2],
                ];
                points.push(TextureSamplePoint {
                    position_world: world,
                    position_object: object,
                    active: active_mask.map(|mask| mask[idx]).unwrap_or(true),
                });
            }
        }
    }
    points
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BodyOverlap {
    Disjoint,
    Overlapping,
    Indeterminate,
}

fn positive_interval_overlap(left: (f64, f64), right: (f64, f64)) -> bool {
    left.0 < right.1 && right.0 < left.1
}

fn native_bounds_overlap(left: &LoweredBody, right: &LoweredBody) -> bool {
    (0..3).all(|axis| {
        positive_interval_overlap(
            (
                left.native_origin[axis],
                left.native_origin[axis] + left.bounding_size[axis],
            ),
            (
                right.native_origin[axis],
                right.native_origin[axis] + right.bounding_size[axis],
            ),
        )
    })
}

fn is_z_axis(axis: [f64; 3]) -> bool {
    axis[0].abs() <= 64.0 * f64::EPSILON
        && axis[1].abs() <= 64.0 * f64::EPSILON
        && (axis[2].abs() - 1.0).abs() <= 64.0 * f64::EPSILON
}

fn squared_distance_to_interval(value: f64, interval: (f64, f64)) -> f64 {
    if value < interval.0 {
        (interval.0 - value).powi(2)
    } else if value > interval.1 {
        (value - interval.1).powi(2)
    } else {
        0.0
    }
}

fn rectangle_circle_overlap(
    rectangle_center: [f64; 3],
    rectangle_size: [f64; 3],
    circle_center: [f64; 3],
    radius: f64,
) -> bool {
    let dx = squared_distance_to_interval(
        circle_center[0],
        (
            rectangle_center[0] - rectangle_size[0] * 0.5,
            rectangle_center[0] + rectangle_size[0] * 0.5,
        ),
    );
    let dy = squared_distance_to_interval(
        circle_center[1],
        (
            rectangle_center[1] - rectangle_size[1] * 0.5,
            rectangle_center[1] + rectangle_size[1] * 0.5,
        ),
    );
    dx + dy < radius * radius
}

fn multilayer_body_overlap(left: &LoweredBody, right: &LoweredBody) -> BodyOverlap {
    if !native_bounds_overlap(left, right) {
        return BodyOverlap::Disjoint;
    }
    let left_shape = &left.overlap_geometry.shape;
    let right_shape = &right.overlap_geometry.shape;
    let left_center = left.overlap_geometry.translation;
    let right_center = right.overlap_geometry.translation;
    match (left_shape, right_shape) {
        (GeometryShape::Box { size: left_size }, GeometryShape::Box { size: right_size }) => {
            let overlaps = (0..3).all(|axis| {
                positive_interval_overlap(
                    (
                        left_center[axis] - left_size[axis] * 0.5,
                        left_center[axis] + left_size[axis] * 0.5,
                    ),
                    (
                        right_center[axis] - right_size[axis] * 0.5,
                        right_center[axis] + right_size[axis] * 0.5,
                    ),
                )
            });
            if overlaps {
                BodyOverlap::Overlapping
            } else {
                BodyOverlap::Disjoint
            }
        }
        (
            GeometryShape::Sphere {
                radius: left_radius,
            },
            GeometryShape::Sphere {
                radius: right_radius,
            },
        ) => {
            let squared_distance = (0..3)
                .map(|axis| (left_center[axis] - right_center[axis]).powi(2))
                .sum::<f64>();
            if squared_distance < (left_radius + right_radius).powi(2) {
                BodyOverlap::Overlapping
            } else {
                BodyOverlap::Disjoint
            }
        }
        (GeometryShape::Box { size }, GeometryShape::Sphere { radius })
        | (GeometryShape::Sphere { radius }, GeometryShape::Box { size }) => {
            let (box_center, sphere_center) = if matches!(left_shape, GeometryShape::Box { .. }) {
                (left_center, right_center)
            } else {
                (right_center, left_center)
            };
            let squared_distance = (0..3)
                .map(|axis| {
                    squared_distance_to_interval(
                        sphere_center[axis],
                        (
                            box_center[axis] - size[axis] * 0.5,
                            box_center[axis] + size[axis] * 0.5,
                        ),
                    )
                })
                .sum::<f64>();
            if squared_distance < radius.powi(2) {
                BodyOverlap::Overlapping
            } else {
                BodyOverlap::Disjoint
            }
        }
        (
            GeometryShape::Cylinder {
                radius: left_radius,
                height: left_height,
                axis: left_axis,
            },
            GeometryShape::Cylinder {
                radius: right_radius,
                height: right_height,
                axis: right_axis,
            },
        ) if is_z_axis(*left_axis) && is_z_axis(*right_axis) => {
            if !positive_interval_overlap(
                (
                    left_center[2] - left_height * 0.5,
                    left_center[2] + left_height * 0.5,
                ),
                (
                    right_center[2] - right_height * 0.5,
                    right_center[2] + right_height * 0.5,
                ),
            ) {
                return BodyOverlap::Disjoint;
            }
            let squared_xy_distance = (left_center[0] - right_center[0]).powi(2)
                + (left_center[1] - right_center[1]).powi(2);
            if squared_xy_distance < (left_radius + right_radius).powi(2) {
                BodyOverlap::Overlapping
            } else {
                BodyOverlap::Disjoint
            }
        }
        (
            GeometryShape::Box { size },
            GeometryShape::Cylinder {
                radius,
                height,
                axis,
            },
        )
        | (
            GeometryShape::Cylinder {
                radius,
                height,
                axis,
            },
            GeometryShape::Box { size },
        ) if is_z_axis(*axis) => {
            let (box_center, cylinder_center) = if matches!(left_shape, GeometryShape::Box { .. }) {
                (left_center, right_center)
            } else {
                (right_center, left_center)
            };
            let z_overlaps = positive_interval_overlap(
                (box_center[2] - size[2] * 0.5, box_center[2] + size[2] * 0.5),
                (
                    cylinder_center[2] - height * 0.5,
                    cylinder_center[2] + height * 0.5,
                ),
            );
            if z_overlaps && rectangle_circle_overlap(box_center, *size, cylinder_center, *radius) {
                BodyOverlap::Overlapping
            } else {
                BodyOverlap::Disjoint
            }
        }
        (
            GeometryShape::Sphere {
                radius: sphere_radius,
            },
            GeometryShape::Cylinder {
                radius,
                height,
                axis,
            },
        )
        | (
            GeometryShape::Cylinder {
                radius,
                height,
                axis,
            },
            GeometryShape::Sphere {
                radius: sphere_radius,
            },
        ) if is_z_axis(*axis) => {
            let (sphere_center, cylinder_center) =
                if matches!(left_shape, GeometryShape::Sphere { .. }) {
                    (left_center, right_center)
                } else {
                    (right_center, left_center)
                };
            let radial_distance = ((sphere_center[0] - cylinder_center[0]).powi(2)
                + (sphere_center[1] - cylinder_center[1]).powi(2))
            .sqrt()
                - radius;
            let axial_distance = (sphere_center[2] - cylinder_center[2]).abs() - height * 0.5;
            let squared_distance =
                radial_distance.max(0.0).powi(2) + axial_distance.max(0.0).powi(2);
            if squared_distance < sphere_radius.powi(2) {
                BodyOverlap::Overlapping
            } else {
                BodyOverlap::Disjoint
            }
        }
        _ => BodyOverlap::Indeterminate,
    }
}

fn resolve_static_external_field_map(
    problem: &ProblemIR,
    n_cells: usize,
) -> Result<Option<Vec<[f64; 3]>>, PlanError> {
    let Some((id, field_b_t)) = problem.energy_terms.iter().find_map(|term| match term {
        EnergyTermIR::StaticFieldMap { id, field_b_t } => Some((id.as_str(), field_b_t)),
        _ => None,
    }) else {
        return Ok(None);
    };
    if problem
        .energy_terms
        .iter()
        .filter(|term| matches!(term, EnergyTermIR::StaticFieldMap { .. }))
        .count()
        != 1
    {
        return Err(PlanError {
            reasons: vec![
                "FDM supports exactly one static_field_map term per resolved single-grid plan"
                    .to_string(),
            ],
        });
    }
    if field_b_t.len() != n_cells {
        return Err(PlanError {
            reasons: vec![format!(
                "static_field_map '{id}' length mismatch on resolved FDM grid: expected {n_cells} cells, actual {}",
                field_b_t.len()
            )],
        });
    }
    let field_h_apm = field_b_t
        .iter()
        .map(|value| [value[0] / MU0, value[1] / MU0, value[2] / MU0])
        .collect::<Vec<_>>();
    if field_h_apm
        .iter()
        .any(|value| value.iter().any(|component| !component.is_finite()))
    {
        return Err(PlanError {
            reasons: vec![format!(
                "static_field_map '{id}' produces a non-finite H_ext map after B/μ0 conversion"
            )],
        });
    }
    Ok(Some(field_h_apm))
}

/// Restrict a precomputed geometry asset to the smallest Cartesian grid that
/// contains its active support.  A study-universe asset may intentionally be
/// expanded to the full target-only Airbox; that grid is not the native
/// magnetization grid used by the multilayer convolution planner.
fn crop_fdm_asset_to_active_support(
    asset: &fullmag_ir::FdmGridAssetIR,
    errors: &mut Vec<String>,
) -> Option<([f64; 3], Vec<bool>, [u32; 3], [f64; 3])> {
    let [nx, ny, nz] = asset.cells;
    let expected = (nx as usize)
        .checked_mul(ny as usize)
        .and_then(|value| value.checked_mul(nz as usize));
    if expected != Some(asset.active_mask.len()) {
        errors.push(format!(
            "fdm multilayer asset '{}' active_mask length {} does not match cells {:?}",
            asset.geometry_name,
            asset.active_mask.len(),
            asset.cells
        ));
        return None;
    }

    let mut min_xyz = [nx, ny, nz];
    let mut max_xyz = [0_u32; 3];
    let mut found_active = false;
    for z in 0..nz {
        for y in 0..ny {
            for x in 0..nx {
                let index = x as usize + nx as usize * (y as usize + ny as usize * z as usize);
                if !asset.active_mask[index] {
                    continue;
                }
                found_active = true;
                min_xyz[0] = min_xyz[0].min(x);
                min_xyz[1] = min_xyz[1].min(y);
                min_xyz[2] = min_xyz[2].min(z);
                max_xyz[0] = max_xyz[0].max(x);
                max_xyz[1] = max_xyz[1].max(y);
                max_xyz[2] = max_xyz[2].max(z);
            }
        }
    }
    if !found_active {
        errors.push(format!(
            "fdm multilayer asset '{}' has no active cells",
            asset.geometry_name
        ));
        return None;
    }

    let cells = [
        max_xyz[0] - min_xyz[0] + 1,
        max_xyz[1] - min_xyz[1] + 1,
        max_xyz[2] - min_xyz[2] + 1,
    ];
    let mut active_mask = vec![false; cells[0] as usize * cells[1] as usize * cells[2] as usize];
    for z in min_xyz[2]..=max_xyz[2] {
        for y in min_xyz[1]..=max_xyz[1] {
            for x in min_xyz[0]..=max_xyz[0] {
                let source_index =
                    x as usize + nx as usize * (y as usize + ny as usize * z as usize);
                let target_x = x - min_xyz[0];
                let target_y = y - min_xyz[1];
                let target_z = z - min_xyz[2];
                let target_index = target_x as usize
                    + cells[0] as usize
                        * (target_y as usize + cells[1] as usize * target_z as usize);
                active_mask[target_index] = asset.active_mask[source_index];
            }
        }
    }

    let origin = std::array::from_fn(|axis| {
        asset.origin[axis] + min_xyz[axis] as f64 * asset.cell_size[axis]
    });
    let bounding_size = std::array::from_fn(|axis| cells[axis] as f64 * asset.cell_size[axis]);
    Some((bounding_size, active_mask, cells, origin))
}

fn point_in_region_shape(point: [f64; 3], shape: &RegionShapeIR) -> Result<bool, String> {
    match shape {
        RegionShapeIR::Box { size, center } => Ok((0..3).all(|axis| {
            let half = size[axis] * 0.5;
            point[axis] >= center[axis] - half && point[axis] <= center[axis] + half
        })),
        RegionShapeIR::Sphere { radius, center } => {
            let dx = point[0] - center[0];
            let dy = point[1] - center[1];
            let dz = point[2] - center[2];
            Ok(dx * dx + dy * dy + dz * dz <= radius * radius)
        }
        RegionShapeIR::Cylinder {
            radius,
            height,
            center,
            axis,
        } => {
            let axis_norm = (axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]).sqrt();
            if axis_norm <= 0.0 {
                return Err("cylinder region axis must be non-zero".to_string());
            }
            let unit = [
                axis[0] / axis_norm,
                axis[1] / axis_norm,
                axis[2] / axis_norm,
            ];
            let rel = [
                point[0] - center[0],
                point[1] - center[1],
                point[2] - center[2],
            ];
            let axial = rel[0] * unit[0] + rel[1] * unit[1] + rel[2] * unit[2];
            if axial.abs() > height * 0.5 {
                return Ok(false);
            }
            let radial = [
                rel[0] - axial * unit[0],
                rel[1] - axial * unit[1],
                rel[2] - axial * unit[2],
            ];
            Ok(
                radial[0] * radial[0] + radial[1] * radial[1] + radial[2] * radial[2]
                    <= radius * radius,
            )
        }
        RegionShapeIR::Csg { .. } => Err(
            "FDM object region materialization does not yet support CSG region shapes".to_string(),
        ),
    }
}

fn materialize_object_region_mask(
    problem: &ProblemIR,
    owner_names: &[&str],
    grid_cells: [u32; 3],
    cell_size: [f64; 3],
    origin: [f64; 3],
    owner_translation: [f64; 3],
    active_mask: Option<&Vec<bool>>,
    errors: &mut Vec<String>,
) -> (Vec<u32>, BTreeMap<String, u32>) {
    let n_cells = match checked_fdm_grid_cost(grid_cells, FDM_GRID_ESTIMATED_BYTES_PER_CELL) {
        Ok(cost) => match usize::try_from(cost.cells) {
            Ok(cells) => cells,
            Err(_) => {
                errors.push(format!(
                    "fdm_grid_cell_count_not_addressable: cells={} requested_counts={:?}",
                    cost.cells, grid_cells
                ));
                return (Vec::new(), BTreeMap::new());
            }
        },
        Err(error) => {
            errors.extend(error.reasons);
            return (Vec::new(), BTreeMap::new());
        }
    };
    let mut mask = vec![0u32; n_cells];
    let mut regions = problem
        .object_regions
        .iter()
        .filter(|region| region.enabled && owner_names.contains(&region.owner_object.as_str()))
        .collect::<Vec<_>>();
    regions.sort_by_key(|region| (region.priority, region.region_id.as_str()));

    let mut region_ids = BTreeMap::new();
    if regions.len() > fullmag_ir::MAX_FDM_REGION_IDS as usize {
        errors.push(format!(
            "fdm_region_lut_capacity_exceeded: requested_region_count={} supported_region_ids={}",
            regions.len(),
            fullmag_ir::MAX_FDM_REGION_IDS
        ));
        return (mask, region_ids);
    }
    let points = grid_sample_points(
        grid_cells,
        cell_size,
        origin,
        owner_translation,
        active_mask,
    );
    let mut assigned_counts = vec![0usize; regions.len()];
    for region in &regions {
        if region.frame != RegionFrameIR::Object {
            errors.push(format!(
                "object_region '{}' uses frame={:?}; FDM region mask materialization currently supports object frame only",
                region.region_id, region.frame
            ));
        }
    }
    for (index, region) in regions.iter().enumerate() {
        let region_index = (index + 1) as u32;
        debug_assert!(region_index <= fullmag_ir::MAX_FDM_REGION_IDS);
        region_ids.insert(region.region_id.clone(), region_index);
    }
    for (flat_index, point) in points.iter().enumerate() {
        if !point.active {
            continue;
        }
        let mut matches = Vec::new();
        for (index, region) in regions.iter().enumerate() {
            match point_in_region_shape(point.position_object, &region.shape) {
                Ok(true) => matches.push(index),
                Ok(false) => {}
                Err(message) => {
                    errors.push(format!("object_region '{}': {message}", region.region_id))
                }
            }
        }
        if matches.is_empty() {
            continue;
        }
        let candidates = matches
            .iter()
            .map(|index| RegionConflictCandidate {
                region_id: regions[*index].region_id.clone(),
                priority: regions[*index].priority,
                policy: fullmag_ir::RegionConflictPolicyIR::Error,
            })
            .collect::<Vec<_>>();
        let resolution = match resolve_region_conflict(&candidates) {
            Ok(resolution) => resolution,
            Err(message) => {
                errors.push(message);
                continue;
            }
        };
        let winner = matches
            .iter()
            .copied()
            .find(|index| regions[*index].region_id == resolution.winner_region_id)
            .expect("resolver winner must be one of the candidates");
        mask[flat_index] = (winner + 1) as u32;
        for index in matches {
            assigned_counts[index] += 1;
        }
    }
    for (index, region) in regions.iter().enumerate() {
        if assigned_counts[index] == 0 {
            errors.push(format!(
                "object_region '{}' did not cover any active FDM cells",
                region.region_id
            ));
        }
    }

    (mask, region_ids)
}

fn materialize_prescribed_sot_target_mask(
    problem: &ProblemIR,
    target: &fullmag_ir::RegionRefIR,
    owner_names: &[&str],
    region_mask: &[u32],
    region_index_by_id: &BTreeMap<String, u32>,
    active_mask: Option<&[bool]>,
) -> Result<Vec<bool>, PlanError> {
    if !owner_names.contains(&target.object_id.as_str()) {
        return Err(PlanError {
            reasons: vec![format!(
                "prescribed_sot target object_id '{}' is not the resolved single-grid FDM magnetic object",
                target.object_id
            )],
        });
    }

    let selected_region = if let Some(region_id) = target.region_id.as_deref() {
        let region = problem
            .object_regions
            .iter()
            .find(|region| region.enabled && region.region_id == region_id)
            .ok_or_else(|| PlanError {
                reasons: vec![format!(
                    "prescribed_sot target region_id '{region_id}' is not an enabled object region"
                )],
            })?;
        if region.owner_object != target.object_id {
            return Err(PlanError {
                reasons: vec![format!(
                    "prescribed_sot target region_id '{region_id}' belongs to object '{}' rather than '{}'",
                    region.owner_object, target.object_id
                )],
            });
        }
        Some(*region_index_by_id.get(region_id).ok_or_else(|| PlanError {
            reasons: vec![format!(
                "prescribed_sot target region_id '{region_id}' was not materialized in the FDM region mask"
            )],
        })?)
    } else {
        None
    };

    let mask = region_mask
        .iter()
        .enumerate()
        .map(|(index, region)| {
            active_mask.is_none_or(|active| active[index])
                && selected_region.is_none_or(|selected| *region == selected)
        })
        .collect::<Vec<_>>();
    if !mask.iter().any(|selected| *selected) {
        return Err(PlanError {
            reasons: vec!["prescribed_sot target does not select any active FDM cells".to_string()],
        });
    }
    Ok(mask)
}

fn build_fdm_region_legend(
    problem: &ProblemIR,
    owner_names: &[&str],
    region_index_by_id: &BTreeMap<String, u32>,
) -> Vec<fullmag_ir::FdmRegionLegendEntryIR> {
    let mut regions = problem
        .object_regions
        .iter()
        .filter(|region| region.enabled && owner_names.contains(&region.owner_object.as_str()))
        .collect::<Vec<_>>();
    regions.sort_by_key(|region| (region.priority, region.region_id.as_str()));
    regions
        .into_iter()
        .filter_map(|region| {
            region_index_by_id
                .get(&region.region_id)
                .copied()
                .map(|numeric_id| fullmag_ir::FdmRegionLegendEntryIR {
                    numeric_id,
                    object_id: region.owner_object.clone(),
                    region_id: region.region_id.clone(),
                    priority: region.priority,
                })
        })
        .collect()
}

fn materialize_region_exchange_couplings(
    problem: &ProblemIR,
    material_exchange: f64,
    region_index_by_id: &BTreeMap<String, u32>,
    errors: &mut Vec<String>,
) -> Vec<(u32, u32, f64)> {
    let mut overrides = Vec::new();
    for coupling in problem.couplings.iter().filter(|coupling| coupling.enabled) {
        let (
            fullmag_ir::CouplingEndpointIR::Region {
                region_id: source_id,
                ..
            },
            fullmag_ir::CouplingEndpointIR::Region {
                region_id: target_id,
                ..
            },
            fullmag_ir::CouplingParametersIR::Exchange {
                mode,
                scale,
                inter_exchange,
            },
        ) = (&coupling.source, &coupling.target, &coupling.parameters)
        else {
            continue;
        };
        let Some(&source_index) = region_index_by_id.get(source_id) else {
            errors.push(format!(
                "coupling '{}' references object_region '{}' that was not materialized in the FDM region mask",
                coupling.coupling_id, source_id
            ));
            continue;
        };
        let Some(&target_index) = region_index_by_id.get(target_id) else {
            errors.push(format!(
                "coupling '{}' references object_region '{}' that was not materialized in the FDM region mask",
                coupling.coupling_id, target_id
            ));
            continue;
        };
        let exchange = match mode {
            ExchangeCouplingModeIR::Explicit => {
                let Some(value) = inter_exchange else {
                    errors.push(format!(
                        "coupling '{}' uses explicit exchange mode but does not provide inter_exchange",
                        coupling.coupling_id
                    ));
                    continue;
                };
                *value
            }
            ExchangeCouplingModeIR::Disabled => 0.0,
            ExchangeCouplingModeIR::HarmonicMean => {
                let scale = scale.unwrap_or(1.0);
                if (scale - 1.0).abs() <= f64::EPSILON {
                    continue;
                }
                material_exchange * scale
            }
        };
        overrides.push((source_index, target_index, exchange));
    }
    overrides
}

fn apply_region_texture_overrides(
    problem: &ProblemIR,
    region_index_by_id: &BTreeMap<String, u32>,
    region_mask: &[u32],
    grid_cells: [u32; 3],
    cell_size: [f64; 3],
    origin: [f64; 3],
    owner_translation: [f64; 3],
    active_mask: Option<&Vec<bool>>,
    initial_magnetization: &mut [[f64; 3]],
    errors: &mut Vec<String>,
) {
    let mut regions = problem
        .object_regions
        .iter()
        .filter(|region| region.enabled && region.texture_override.is_some())
        .collect::<Vec<_>>();
    regions.sort_by_key(|region| (region.priority, region.region_id.as_str()));

    let points = grid_sample_points(
        grid_cells,
        cell_size,
        origin,
        owner_translation,
        active_mask,
    );
    for region in regions {
        let Some(&region_index) = region_index_by_id.get(&region.region_id) else {
            errors.push(format!(
                "object_region '{}' has texture_override but was not materialized in the FDM region mask",
                region.region_id
            ));
            continue;
        };
        let Some(texture_override) = region.texture_override.as_ref() else {
            continue;
        };
        let values = match &texture_override.initial_magnetization {
            InitialMagnetizationIR::Uniform { value } => vec![*value; initial_magnetization.len()],
            InitialMagnetizationIR::RandomSeeded { seed } => {
                generate_random_unit_vectors(*seed, initial_magnetization.len())
            }
            InitialMagnetizationIR::SampledField { values } => {
                if values.len() != initial_magnetization.len() {
                    errors.push(format!(
                        "object_region '{}' texture_override sampled field length {} does not match FDM cell count {}",
                        region.region_id,
                        values.len(),
                        initial_magnetization.len()
                    ));
                    continue;
                }
                values.clone()
            }
            InitialMagnetizationIR::PresetTexture {
                preset_kind,
                preset_params,
                mapping,
                texture_transform,
                preset_version,
            } => match sample_preset_texture_versioned(
                preset_kind,
                *preset_version,
                preset_params,
                mapping,
                texture_transform,
                &points,
            ) {
                Ok(values) => values,
                Err(message) => {
                    errors.push(format!(
                        "object_region '{}' texture_override: {message}",
                        region.region_id
                    ));
                    continue;
                }
            },
        };
        for (index, value) in values.into_iter().enumerate() {
            if region_mask[index] == region_index {
                initial_magnetization[index] = value;
            }
        }
    }
}

fn finite_cylinder_sdf_for_shape(
    shape: &GeometryShape,
    center: [f64; 3],
) -> Option<Box<dyn Fn(f64, f64, f64) -> f64>> {
    match shape {
        GeometryShape::Cylinder {
            radius,
            height,
            axis,
        } => Some(Box::new(crate::boundary_geometry::finite_cylinder_sdf(
            *radius, *height, center, *axis,
        ))),
        GeometryShape::Translate { child, by } => finite_cylinder_sdf_for_shape(
            child,
            [center[0] + by[0], center[1] + by[1], center[2] + by[2]],
        ),
        _ => None,
    }
}

fn sample_shape_mask(
    shape: &GeometryShape,
    grid_cells: [u32; 3],
    cell_size: [f64; 3],
    origin: [f64; 3],
) -> Vec<bool> {
    let [nx, ny, nz] = grid_cells.map(|value| value as usize);
    let mut mask = vec![false; nx * ny * nz];
    for z in 0..nz {
        for y in 0..ny {
            for x in 0..nx {
                let point = [
                    origin[0] + (x as f64 + 0.5) * cell_size[0],
                    origin[1] + (y as f64 + 0.5) * cell_size[1],
                    origin[2] + (z as f64 + 0.5) * cell_size[2],
                ];
                mask[x + nx * (y + ny * z)] = shape.contains(point);
            }
        }
    }
    mask
}

#[derive(Default)]
struct TransportGridRefs {
    charge_domains: Vec<fullmag_ir::RegionRefIR>,
    regions: BTreeMap<(String, String), fullmag_ir::RegionRefIR>,
    object_ids: BTreeSet<String>,
}

impl TransportGridRefs {
    fn add_region(&mut self, region: &fullmag_ir::RegionRefIR) {
        self.object_ids.insert(region.object_id.clone());
        if let Some(region_id) = &region.region_id {
            self.regions.insert(
                (region.object_id.clone(), region_id.clone()),
                region.clone(),
            );
        }
    }

    fn add_surface(&mut self, surface: &fullmag_ir::SurfaceRefIR) {
        self.object_ids.insert(surface.object_id.clone());
    }
}

fn active_transport_grid_refs(
    problem: &ProblemIR,
    active_graph: &crate::spin_transport::ActiveFdmTransportGraph,
) -> Result<TransportGridRefs, PlanError> {
    let mut refs = TransportGridRefs::default();

    for spin in &problem.spin_transport_modules {
        if !active_graph.spin_module_ids.contains(&spin.id) {
            continue;
        }
        for region in &spin.domain {
            refs.add_region(region);
        }
        for assignment in &spin.materials {
            refs.add_region(&assignment.region);
        }
        for interface in &spin.interfaces {
            match interface {
                fullmag_ir::SpinInterfaceIR::Transparent { side_a, side_b, .. } => {
                    refs.add_region(side_a);
                    refs.add_region(side_b);
                }
                fullmag_ir::SpinInterfaceIR::MixingConductance {
                    normal_side,
                    ferromagnet_side,
                    ..
                } => {
                    refs.add_region(normal_side);
                    refs.add_region(ferromagnet_side);
                }
            }
        }
        for boundary in &spin.boundaries {
            match boundary {
                fullmag_ir::SpinBoundaryIR::SpinInsulating { surfaces, .. }
                | fullmag_ir::SpinBoundaryIR::SpinSink { surfaces, .. }
                | fullmag_ir::SpinBoundaryIR::SpecifiedSpinPotential { surfaces, .. }
                | fullmag_ir::SpinBoundaryIR::SpecifiedSpinFlux { surfaces, .. } => {
                    for surface in surfaces {
                        refs.add_surface(surface);
                    }
                }
                fullmag_ir::SpinBoundaryIR::PeriodicSpin {
                    minus_surface,
                    plus_surface,
                    ..
                } => {
                    refs.add_surface(minus_surface);
                    refs.add_surface(plus_surface);
                }
            }
        }
    }

    for current in &problem.current_modules {
        let fullmag_ir::CurrentModuleIR::CurrentTransport {
            name,
            definition: Some(definition),
            ..
        } = current
        else {
            continue;
        };
        if !active_graph.coupled_current_source_ids.contains(name) {
            continue;
        }
        for region in &definition.domain {
            refs.charge_domains.push(region.clone());
            refs.add_region(region);
        }
        for assignment in &definition.materials {
            refs.add_region(&assignment.region);
        }
        for boundary in &definition.boundaries {
            for surface in boundary.surfaces() {
                refs.add_surface(surface);
            }
        }
        if let Some(fullmag_ir::StructuredCurrentClosureIR::ClosedGeometry {
            source_cuts, ..
        }) = &definition.structured_current_closure
        {
            for cut in source_cuts {
                refs.add_region(&cut.region);
            }
        }
    }

    for torque in &problem.spin_torque_modules {
        let fullmag_ir::SpinTorqueModuleIR::DriftDiffusionSpinTorque {
            id,
            solve_id,
            target,
            ..
        } = torque
        else {
            continue;
        };
        if !active_graph.spin_module_ids.contains(solve_id)
            || !active_graph.torque_module_ids.contains(id)
        {
            continue;
        }
        refs.add_region(target);
    }

    Ok(refs)
}

fn region_shape_bounds(shape: &RegionShapeIR) -> Result<([f64; 3], [f64; 3]), String> {
    match shape {
        RegionShapeIR::Box { size, center } => Ok((
            std::array::from_fn(|axis| center[axis] - size[axis] * 0.5),
            std::array::from_fn(|axis| center[axis] + size[axis] * 0.5),
        )),
        RegionShapeIR::Sphere { radius, center } => Ok((
            std::array::from_fn(|axis| center[axis] - radius),
            std::array::from_fn(|axis| center[axis] + radius),
        )),
        RegionShapeIR::Cylinder {
            radius,
            height,
            center,
            axis,
        } => {
            let norm = (axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]).sqrt();
            if !norm.is_finite() || norm <= 0.0 {
                return Err("cylinder region axis must be finite and non-zero".to_string());
            }
            let unit = axis.map(|component| component / norm);
            let half_height = height * 0.5;
            let extents: [f64; 3] = std::array::from_fn(|index| {
                half_height * unit[index].abs()
                    + radius * (1.0 - unit[index] * unit[index]).max(0.0).sqrt()
            });
            Ok((
                std::array::from_fn(|index| center[index] - extents[index]),
                std::array::from_fn(|index| center[index] + extents[index]),
            ))
        }
        RegionShapeIR::Csg { .. } => {
            Err("FDM transport object regions do not yet support CSG shapes".to_string())
        }
    }
}

fn top_level_geometry_translation(entry: &GeometryEntryIR) -> [f64; 3] {
    match entry {
        GeometryEntryIR::Translate { base, by, .. } => {
            let nested = top_level_geometry_translation(base);
            std::array::from_fn(|axis| nested[axis] + by[axis])
        }
        _ => [0.0; 3],
    }
}

fn transport_common_grid(
    problem: &ProblemIR,
    magnet: &fullmag_ir::MagnetIR,
    magnetic_geometry: &GeometryEntryIR,
    magnetic_shape: &GeometryShape,
    cell_size: [f64; 3],
    active_graph: &crate::spin_transport::ActiveFdmTransportGraph,
) -> Result<
    (
        [f64; 3],
        Vec<bool>,
        [u32; 3],
        [f64; 3],
        BTreeMap<String, Vec<bool>>,
        BTreeMap<(String, String), Vec<bool>>,
    ),
    PlanError,
> {
    let mut transport_refs = active_transport_grid_refs(problem, active_graph)?;
    transport_refs.object_ids.insert(magnet.name.clone());
    let geometry_by_name = problem
        .geometry
        .entries
        .iter()
        .map(|entry| (entry.name(), entry))
        .collect::<BTreeMap<_, _>>();
    let region_to_geometry = problem
        .regions
        .iter()
        .map(|region| (region.name.as_str(), region.geometry.as_str()))
        .collect::<BTreeMap<_, _>>();
    let mut object_to_geometry = BTreeMap::<String, String>::new();
    for object_id in &transport_refs.object_ids {
        let mut candidates = BTreeSet::new();
        if geometry_by_name.contains_key(object_id.as_str()) {
            candidates.insert(object_id.as_str());
        }
        if let Some(geometry_id) = region_to_geometry.get(object_id.as_str()) {
            candidates.insert(*geometry_id);
        }
        for candidate in problem
            .magnets
            .iter()
            .filter(|candidate| candidate.name == *object_id)
        {
            let geometry_id = region_to_geometry
                .get(candidate.region.as_str())
                .ok_or_else(|| PlanError {
                    reasons: vec![format!(
                        "magnet '{}' region '{}' has no FDM geometry binding",
                        candidate.name, candidate.region
                    )],
                })?;
            candidates.insert(*geometry_id);
        }
        if candidates.len() > 1 {
            return Err(PlanError {
                reasons: vec![format!(
                    "ambiguous FDM object-to-geometry mapping for '{}': {}",
                    object_id,
                    candidates.into_iter().collect::<Vec<_>>().join(", ")
                )],
            });
        }
        if let Some(geometry_id) = candidates.into_iter().next() {
            object_to_geometry.insert(object_id.clone(), geometry_id.to_string());
        }
    }
    let resolve_geometry = |object_id: &str| {
        object_to_geometry
            .get(object_id)
            .and_then(|name| geometry_by_name.get(name.as_str()).copied())
    };

    let resolve_object_region = |region: &fullmag_ir::RegionRefIR| {
        let region_id = region.region_id.as_deref()?;
        problem.object_regions.iter().find(|candidate| {
            candidate.enabled
                && candidate.owner_object == region.object_id
                && candidate.region_id == region_id
        })
    };

    let mut bounds_min = [f64::INFINITY; 3];
    let mut bounds_max = [f64::NEG_INFINITY; 3];
    for region in &transport_refs.charge_domains {
        let geometry = resolve_geometry(&region.object_id).ok_or_else(|| PlanError {
            reasons: vec![format!(
                "charge transport domain object '{}' has no FDM geometry binding",
                region.object_id
            )],
        })?;
        let object_shape = ir_to_shape(geometry).map_err(|reason| PlanError {
            reasons: vec![reason],
        })?;
        let (object_lower, object_upper) =
            shape_local_bounds(&object_shape).ok_or_else(|| PlanError {
                reasons: vec![format!(
                    "charge transport geometry '{}' has no analytic FDM bounds",
                    geometry.name()
                )],
            })?;
        let (lower, upper) = if region.region_id.is_some() {
            let object_region = resolve_object_region(region).ok_or_else(|| PlanError {
                reasons: vec![format!(
                    "charge transport domain region '{}:{}' is not an enabled object region",
                    region.object_id,
                    region.region_id.as_deref().unwrap_or_default()
                )],
            })?;
            let (mut lower, mut upper) =
                region_shape_bounds(&object_region.shape).map_err(|reason| PlanError {
                    reasons: vec![format!(
                        "object_region '{}': {reason}",
                        object_region.region_id
                    )],
                })?;
            if object_region.frame == RegionFrameIR::Object {
                let translation = top_level_geometry_translation(geometry);
                for axis in 0..3 {
                    lower[axis] += translation[axis];
                    upper[axis] += translation[axis];
                }
            }
            for axis in 0..3 {
                lower[axis] = lower[axis].max(object_lower[axis]);
                upper[axis] = upper[axis].min(object_upper[axis]);
            }
            if (0..3).any(|axis| upper[axis] <= lower[axis]) {
                return Err(PlanError {
                    reasons: vec![format!(
                        "charge transport domain region '{}:{}' does not intersect its owner geometry",
                        region.object_id, object_region.region_id
                    )],
                });
            }
            (lower, upper)
        } else {
            (object_lower, object_upper)
        };
        for axis in 0..3 {
            bounds_min[axis] = bounds_min[axis].min(lower[axis]);
            bounds_max[axis] = bounds_max[axis].max(upper[axis]);
        }
    }
    if transport_refs.charge_domains.is_empty() {
        return Err(PlanError {
            reasons: vec!["charge transport domain must not be empty".to_string()],
        });
    }

    let (magnetic_min, magnetic_max) =
        shape_local_bounds(magnetic_shape).ok_or_else(|| PlanError {
            reasons: vec![format!(
                "magnetic geometry '{}' has no analytic FDM bounds",
                magnetic_geometry.name()
            )],
        })?;
    if (0..3).any(|axis| {
        magnetic_min[axis] < bounds_min[axis] - GRID_TOLERANCE * cell_size[axis]
            || magnetic_max[axis] > bounds_max[axis] + GRID_TOLERANCE * cell_size[axis]
    }) {
        return Err(PlanError {
            reasons: vec![
                "magnetic domain must be a subset of the authored transport charge domain"
                    .to_string(),
            ],
        });
    }

    let bounding_size = std::array::from_fn(|axis| bounds_max[axis] - bounds_min[axis]);
    let mut grid_cells = [0_u32; 3];
    for axis in 0..3 {
        let cells = bounding_size[axis] / cell_size[axis];
        let rounded = cells.round();
        if !cells.is_finite()
            || rounded < 1.0
            || (cells - rounded).abs() > GRID_TOLERANCE
            || rounded > u32::MAX as f64
        {
            return Err(PlanError {
                reasons: vec![format!(
                    "transport domain extent on axis {axis} is not aligned to the requested FDM cell size"
                )],
            });
        }
        grid_cells[axis] = rounded as u32;
    }
    checked_fdm_grid_cost(grid_cells, FDM_GRID_ESTIMATED_BYTES_PER_CELL)?;

    let magnetic_mask = sample_shape_mask(magnetic_shape, grid_cells, cell_size, bounds_min);
    if !magnetic_mask.iter().any(|active| *active) {
        return Err(PlanError {
            reasons: vec!["magnetic domain selects no cells on the transport grid".to_string()],
        });
    }
    let mut object_masks = BTreeMap::new();
    for object_id in &transport_refs.object_ids {
        let entry = resolve_geometry(object_id).ok_or_else(|| PlanError {
            reasons: vec![format!(
                "transport object '{}' has no FDM geometry binding",
                object_id
            )],
        })?;
        let shape = ir_to_shape(entry).map_err(|reason| PlanError {
            reasons: vec![reason],
        })?;
        object_masks.insert(
            object_id.clone(),
            sample_shape_mask(&shape, grid_cells, cell_size, bounds_min),
        );
    }
    object_masks.insert(magnet.name.clone(), magnetic_mask.clone());

    let mut region_masks = BTreeMap::new();
    for ((object_id, region_id), region_ref) in &transport_refs.regions {
        let object_region = resolve_object_region(region_ref).ok_or_else(|| PlanError {
            reasons: vec![format!(
                "transport region '{}:{}' is not an enabled object region",
                object_id, region_id
            )],
        })?;
        let geometry = resolve_geometry(object_id).ok_or_else(|| PlanError {
            reasons: vec![format!(
                "transport region owner '{}' has no FDM geometry binding",
                object_id
            )],
        })?;
        let translation = top_level_geometry_translation(geometry);
        let object_mask = object_masks.get(object_id).expect("reachable object mask");
        let [nx, ny, nz] = grid_cells.map(|value| value as usize);
        let mut mask = vec![false; nx * ny * nz];
        for z in 0..nz {
            for y in 0..ny {
                for x in 0..nx {
                    let cell = x + nx * (y + ny * z);
                    if !object_mask[cell] {
                        continue;
                    }
                    let world = [
                        bounds_min[0] + (x as f64 + 0.5) * cell_size[0],
                        bounds_min[1] + (y as f64 + 0.5) * cell_size[1],
                        bounds_min[2] + (z as f64 + 0.5) * cell_size[2],
                    ];
                    let point = if object_region.frame == RegionFrameIR::Object {
                        std::array::from_fn(|axis| world[axis] - translation[axis])
                    } else {
                        world
                    };
                    mask[cell] =
                        point_in_region_shape(point, &object_region.shape).map_err(|reason| {
                            PlanError {
                                reasons: vec![format!(
                                    "object_region '{}': {reason}",
                                    object_region.region_id
                                )],
                            }
                        })?;
                }
            }
        }
        if !mask.iter().any(|selected| *selected) {
            return Err(PlanError {
                reasons: vec![format!(
                    "transport region '{}:{}' selects no cells on the common grid",
                    object_id, region_id
                )],
            });
        }
        region_masks.insert((object_id.clone(), region_id.clone()), mask);
    }

    Ok((
        bounding_size,
        magnetic_mask,
        grid_cells,
        bounds_min,
        object_masks,
        region_masks,
    ))
}

pub(crate) fn plan_fdm(
    problem: &ProblemIR,
    resolved_backend: BackendTarget,
) -> Result<ExecutionPlanIR, PlanError> {
    let mut errors = Vec::new();
    let active_transport_graph =
        crate::spin_transport::resolve_active_fdm_transport_graph(problem)?;

    let mut enable_exchange = false;
    let mut enable_demag = false;
    let mut has_bulk_dmi = false;
    let mut external_field = None;
    let mut has_thermal_noise = false;
    let mut thermal_temperature = problem.temperature;
    let mut thermal_seed_config = problem
        .temperature
        .filter(|temperature| *temperature > 0.0)
        .map(|_| ThermalSeedConfig {
            policy: SeedPolicy::SystemEntropy,
            seed: None,
        });
    let enable_oersted = problem.energy_terms.iter().any(|term| {
        matches!(
            term,
            EnergyTermIR::OerstedCylinder { .. } | EnergyTermIR::OerstedField { .. }
        )
    });
    let has_static_field_map = problem
        .energy_terms
        .iter()
        .any(|term| matches!(term, EnergyTermIR::StaticFieldMap { .. }));
    for term in &problem.energy_terms {
        match term {
            EnergyTermIR::Exchange => {
                if enable_exchange {
                    errors.push("Exchange is declared more than once".to_string());
                }
                enable_exchange = true;
            }
            EnergyTermIR::Demag { .. } => {
                if enable_demag {
                    errors.push("Demag is declared more than once".to_string());
                }
                enable_demag = true;
            }
            EnergyTermIR::Zeeman { b } => {
                if external_field.is_some() {
                    errors.push("Zeeman is declared more than once".to_string());
                }
                external_field = Some([b[0] / MU0, b[1] / MU0, b[2] / MU0]);
            }
            EnergyTermIR::StaticFieldMap { .. } => {}
            // Terms handled in the post-plan mapping loop below:
            EnergyTermIR::OerstedCylinder { .. } | EnergyTermIR::OerstedField { .. } => {}
            EnergyTermIR::InterfacialDmi {
                interface_normal, ..
            } => {
                if interface_normal
                    .is_some_and(|normal| !fdm_supports_interfacial_dmi_normal(normal))
                {
                    errors.push(
                        "InterfacialDmi.interface_normal is not executable in the current FDM lane: only the canonical +z interface normal is implemented; use +z or select FEM."
                            .to_string(),
                    );
                }
            }
            EnergyTermIR::BulkDmi { .. } => {
                has_bulk_dmi = true;
            }
            EnergyTermIR::ThermalNoise { temperature, seed } => {
                if has_thermal_noise {
                    errors.push("ThermalNoise is declared more than once".to_string());
                }
                has_thermal_noise = true;
                if let Some(problem_temperature) = thermal_temperature {
                    if (problem_temperature - *temperature).abs() > 1.0e-6 {
                        errors.push(
                            "ThermalNoise temperature disagrees with Problem temperature"
                                .to_string(),
                        );
                    }
                }
                thermal_temperature = Some(*temperature);
                if *seed == Some(0) {
                    errors.push(
                        "ThermalNoise seed must be positive; use system entropy for an unspecified seed"
                            .to_string(),
                    );
                }
                thermal_seed_config = Some(ThermalSeedConfig {
                    policy: if seed.is_some() {
                        SeedPolicy::Fixed
                    } else {
                        SeedPolicy::SystemEntropy
                    },
                    seed: *seed,
                });
            }
            other => {
                errors.push(format!(
                    "energy term '{:?}' is semantic-only in the current FDM executable path",
                    other
                ));
            }
        }
    }
    if runtime_requests_cuda(problem) {
        for term in &problem.energy_terms {
            let EnergyTermIR::OerstedCylinder {
                axis,
                time_dependence,
                ..
            } = term
            else {
                continue;
            };
            if *axis != [0.0, 0.0, 1.0] {
                errors.push(
                    "FDM CUDA OerstedCylinder supports only the canonical +z axis until the native arbitrary-axis geometry kernel is qualified"
                        .to_string(),
                );
            }
            if !matches!(time_dependence, None | Some(TimeDependenceIR::Constant)) {
                errors.push(
                    "FDM CUDA time-dependent OerstedCylinder is not executable until every RK stage receives its own source time; use Constant or device='cpu'"
                        .to_string(),
                );
            }
        }
    }
    reject_fdm_spatial_material_fields(problem, "FDM", &mut errors);
    let boundary_correction = problem
        .backend_policy
        .discretization_hints
        .as_ref()
        .and_then(|hints| hints.fdm.as_ref())
        .and_then(|fdm| fdm.boundary_correction.as_deref());
    if problem.backend_policy.execution_precision == ExecutionPrecision::Single
        && runtime_requests_cuda(problem)
        && boundary_correction.is_some_and(|value| value != "none")
    {
        errors.push(format!(
            "FDM execution_precision='single' with CUDA and boundary_correction='{correction}' is capability-gated until FP32 sub-cell field/energy parity is qualified; use execution_precision='double' or boundary_correction='none'",
            correction = boundary_correction.unwrap_or("?"),
        ));
    }
    if !(enable_exchange || enable_demag || external_field.is_some() || has_static_field_map) {
        errors.push(
        "the current executable FDM path requires at least one of Exchange, Demag, Zeeman, or StaticFieldMap"
                .to_string(),
        );
    }
    let bulk_dmi_is_fully_periodic = problem.pbc.as_ref().is_some_and(|pbc| {
        pbc.axes
            .iter()
            .all(|axis| matches!(axis, AxisBoundary::Periodic))
    });
    if has_bulk_dmi && !bulk_dmi_is_fully_periodic {
        errors.push(
            "BulkDmi requires a natural exchange+DMI free-surface boundary condition; the current executable FDM lanes do not implement it. Use periodic axes on all three dimensions or remove BulkDmi."
                .to_string(),
        );
    }
    if let Some(pbc) = problem.pbc.as_ref() {
        if let Err(reason) = pbc.resolve_demag_boundary(enable_demag) {
            errors.push(reason);
        }
        if problem.backend_policy.execution_precision == ExecutionPrecision::Single
            && runtime_requests_cuda(problem)
            && pbc.has_any_periodic()
        {
            errors.push(
                "FDM execution_precision='single' with CUDA and periodic axes is capability-gated until FP32 seam exchange parity is qualified; use execution_precision='double'"
                    .to_string(),
            );
        }
        let boundary_correction = problem
            .backend_policy
            .discretization_hints
            .as_ref()
            .and_then(|hints| hints.fdm.as_ref())
            .and_then(|fdm| fdm.boundary_correction.as_deref());
        if pbc.has_any_periodic() && boundary_correction.is_some_and(|value| value != "none") {
            errors.push(format!(
                "FDM boundary_correction='{correction}' with periodic axes is capability-gated until seam-aware T0/T1 exchange parity is qualified; use boundary_correction='none'",
                correction = boundary_correction.unwrap_or("?"),
            ));
        }
    }

    if problem.magnets.len() != 1 {
        errors.push(format!(
            "Phase 1 supports exactly one magnet, found {}",
            problem.magnets.len()
        ));
    }
    let region_to_geometry: BTreeMap<&str, &str> = problem
        .regions
        .iter()
        .map(|region| (region.name.as_str(), region.geometry.as_str()))
        .collect();
    let geometry_by_name: BTreeMap<&str, &GeometryEntryIR> = problem
        .geometry
        .entries
        .iter()
        .map(|entry| (entry.name(), entry))
        .collect();
    let Some(magnet) = problem.magnets.first() else {
        return Err(PlanError { reasons: errors });
    };
    let Some(geometry_name) = region_to_geometry.get(magnet.region.as_str()).copied() else {
        errors.push(format!(
            "magnet '{}' references region '{}' with no geometry binding",
            magnet.name, magnet.region
        ));
        return Err(PlanError { reasons: errors });
    };
    let Some(geometry) = geometry_by_name.get(geometry_name).copied() else {
        errors.push(format!(
            "magnet '{}' references geometry '{}' which is missing from geometry.entries",
            magnet.name, geometry_name
        ));
        return Err(PlanError { reasons: errors });
    };
    let shape = match ir_to_shape(geometry) {
        Ok(shape) => shape,
        Err(e) => {
            errors.push(e);
            return Err(PlanError { reasons: errors });
        }
    };
    // Geometry assets carry a Cartesian/world-space origin.  A top-level
    // Translate is already materialized by the Python asset pipeline; it is
    // only used below when sampling the object's local texture coordinates.
    let top_level_translation = match extract_multilayer_geometry(geometry) {
        Ok(placed) => placed.translation,
        Err(e) => {
            errors.push(e);
            return Err(PlanError { reasons: errors });
        }
    };

    let cell_size = match &problem.backend_policy.discretization_hints {
        Some(DiscretizationHintsIR { fdm: Some(fdm), .. }) => {
            match cell_for_magnet(fdm, magnet.name.as_str()) {
                Ok(cell) => cell,
                Err(reason) => {
                    errors.push(reason);
                    [1e-9, 1e-9, 1e-9]
                }
            }
        }
        _ => {
            errors.push(
                "FDM discretization hints (cell size) are required for Phase 1 execution"
                    .to_string(),
            );
            [1e-9, 1e-9, 1e-9]
        }
    };

    validate_executable_outputs(
        &problem.study.sampling().outputs,
        enable_exchange,
        enable_demag,
        external_field.is_some() || has_static_field_map,
        enable_oersted,
        problem.energy_terms.iter().any(|term| {
            matches!(
                term,
                EnergyTermIR::InterfacialDmi { .. } | EnergyTermIR::BulkDmi { .. }
            )
        }),
        false,
        false,
        false,
        problem
            .energy_terms
            .iter()
            .any(|term| matches!(term, EnergyTermIR::ThermalNoise { .. })),
        has_prescribed_zeeman_mask_source(problem),
        !problem.field_drives.is_empty(),
        // Transport field outputs are study-level declarations.  A stage may
        // deliberately disable the complete charge->spin->torque pipeline
        // (for example during zero-current relaxation), so validation must
        // still accept the declarations for later active stages.
        !problem.spin_transport_modules.is_empty(),
        &mut errors,
    );
    if problem.study.sampling().outputs.iter().any(|output| {
        matches!(
            output,
            fullmag_ir::OutputIR::Field { name, .. }
                | fullmag_ir::OutputIR::FieldAuto { name, .. }
                | fullmag_ir::OutputIR::FieldResolvedAuto { name, .. }
                if name == "H_therm"
        ) || matches!(output, fullmag_ir::OutputIR::Snapshot { field, .. } if field == "H_therm")
    }) {
        errors.push(
            "FDM field output 'H_therm' is not materialized by the current CPU or CUDA observables; request H_eff or remove H_therm"
                .to_string(),
        );
    }
    if runtime_requests_cuda(problem)
        && problem.study.sampling().outputs.iter().any(|output| {
            matches!(
                output,
                fullmag_ir::OutputIR::Field { name, .. }
                    | fullmag_ir::OutputIR::FieldAuto { name, .. }
                    | fullmag_ir::OutputIR::FieldResolvedAuto { name, .. }
                    if name == "H_dmi"
            ) || matches!(output, fullmag_ir::OutputIR::Snapshot { field, .. } if field == "H_dmi")
        })
    {
        errors.push(
            "FDM CUDA field output 'H_dmi' is not materialized by the native observables; request device='cpu' or remove H_dmi"
                .to_string(),
        );
    }
    if problem.backend_policy.execution_precision != ExecutionPrecision::Double
        && !runtime_requests_cuda(problem)
    {
        errors.push(
            "execution_precision='single' requires a CUDA device; the CPU reference runner supports only 'double'"
                .to_string(),
        );
    }

    let provided_grid_asset = problem.geometry_assets.as_ref().and_then(|assets| {
        assets
            .fdm_grid_assets
            .iter()
            .find(|asset| asset.geometry_name == geometry.name())
    });

    let (
        mut bounding_size,
        mut active_mask,
        mut grid_cells,
        mut native_origin,
        mut used_precomputed_asset,
    ) = if let Some(asset) = provided_grid_asset {
        validate_grid_asset_cell_size(asset, cell_size, &mut errors);
        let origin = asset.origin;
        (
            [
                asset.cells[0] as f64 * asset.cell_size[0],
                asset.cells[1] as f64 * asset.cell_size[1],
                asset.cells[2] as f64 * asset.cell_size[2],
            ],
            Some(asset.active_mask.clone()),
            asset.cells,
            origin,
            true,
        )
    } else {
        let (bounding_size, active_mask, grid_cells, origin) =
            voxelize_shape(&shape, cell_size, &mut errors);
        (bounding_size, active_mask, grid_cells, origin, false)
    };

    let mut transport_object_masks = BTreeMap::new();
    let mut transport_region_masks = BTreeMap::new();
    if !active_transport_graph.spin_module_ids.is_empty() {
        if provided_grid_asset.is_some() {
            return Err(PlanError {
                reasons: vec![
                    "FDM transport common-grid planning does not accept a magnet-only precomputed grid asset; provide analytic charge-domain geometries"
                        .to_string(),
                ],
            });
        }
        let resolved = transport_common_grid(
            problem,
            magnet,
            geometry,
            &shape,
            cell_size,
            &active_transport_graph,
        )?;
        bounding_size = resolved.0;
        active_mask = Some(resolved.1);
        grid_cells = resolved.2;
        native_origin = resolved.3;
        transport_object_masks = resolved.4;
        transport_region_masks = resolved.5;
        used_precomputed_asset = false;
    }

    if !used_precomputed_asset {
        validate_realized_grid(
            "geometry",
            bounding_size,
            grid_cells,
            cell_size,
            &mut errors,
        );
    }

    let resolved_periodic_images = match problem.pbc.as_ref() {
        Some(pbc) => match pbc
            .resolve_periodic_images(grid_cells, problem.backend_policy.execution_precision)
        {
            Ok(resolved) => resolved,
            Err(reason) => {
                errors.push(reason);
                None
            }
        },
        None => None,
    };

    if !errors.is_empty() {
        return Err(PlanError { reasons: errors });
    }

    let current_transports =
        resolve_current_transports(problem, CurrentTransportExecutableLane::Fdm)?;
    let spin_torque =
        resolve_legacy_spin_torque(problem, SpinTorqueExecutableLane::Fdm, &current_transports)?;
    let sot = resolve_sot_fields(problem, &current_transports, false)?;

    let magnet = &problem.magnets[0];
    let material = problem
        .materials
        .iter()
        .find(|m| m.name == magnet.material)
        .expect("validation should have caught missing material");

    let grid_cost = checked_fdm_grid_cost(grid_cells, FDM_GRID_ESTIMATED_BYTES_PER_CELL)?;
    let n_cells = usize::try_from(grid_cost.cells).map_err(|_| PlanError {
        reasons: vec![format!(
            "fdm_grid_cell_count_not_addressable: cells={} requested_counts={:?}",
            grid_cost.cells, grid_cells
        )],
    })?;
    let static_external_field_xyz = resolve_static_external_field_map(problem, n_cells)?;
    if static_external_field_xyz.is_some() && enable_oersted {
        return Err(PlanError {
            reasons: vec![
                "StaticFieldMap cannot be combined with an Oersted energy term in the current native FDM lane; use one resolved per-cell field source at a time"
                    .to_string(),
            ],
        });
    }
    let mut initial_magnetization = match &magnet.initial_magnetization {
        Some(InitialMagnetizationIR::Uniform { value }) => {
            if let Some(ref mask) = active_mask {
                mask.iter()
                    .map(|&active| if active { *value } else { [0.0, 0.0, 0.0] })
                    .collect()
            } else {
                vec![*value; n_cells]
            }
        }
        Some(InitialMagnetizationIR::RandomSeeded { seed }) => {
            let mut vectors = generate_random_unit_vectors(*seed, n_cells);
            if let Some(ref mask) = active_mask {
                for (index, active) in mask.iter().enumerate() {
                    if !active {
                        vectors[index] = [0.0, 0.0, 0.0];
                    }
                }
            }
            vectors
        }
        Some(InitialMagnetizationIR::SampledField { values }) => {
            if values.len() != n_cells {
                return Err(PlanError {
                    reasons: vec![format!(
                        "magnet '{}' sampled field length mismatch on resolved FDM grid: expected {}, actual {}",
                        magnet.name,
                        n_cells,
                        values.len()
                    )],
                });
            }
            values.clone()
        }
        Some(InitialMagnetizationIR::PresetTexture {
            preset_kind,
            preset_params,
            mapping,
            texture_transform,
            preset_version,
        }) => {
            eprintln!(
                "[fullmag-plan][mag-texture] sampling preset '{}' for FDM magnet '{}' (cells={} active={}) mapping=({}/{}/{}) T=[{:+.3e},{:+.3e},{:+.3e}]m S=[{:+.3e},{:+.3e},{:+.3e}]",
                preset_kind,
                magnet.name,
                n_cells,
                active_mask
                    .as_ref()
                    .map(|mask| mask.iter().filter(|active| **active).count())
                    .unwrap_or(n_cells),
                mapping.space,
                mapping.projection,
                mapping.clamp_mode,
                texture_transform.translation[0],
                texture_transform.translation[1],
                texture_transform.translation[2],
                texture_transform.scale[0],
                texture_transform.scale[1],
                texture_transform.scale[2],
            );
            let points = grid_sample_points(
                grid_cells,
                cell_size,
                native_origin,
                top_level_translation,
                active_mask.as_ref(),
            );
            match sample_preset_texture_versioned(
                preset_kind,
                *preset_version,
                &preset_params,
                mapping,
                texture_transform,
                &points,
            ) {
                Ok(values) => values,
                Err(message) => {
                    return Err(PlanError {
                        reasons: vec![format!("magnet '{}': {}", magnet.name, message)],
                    });
                }
            }
        }
        None => {
            if let Some(ref mask) = active_mask {
                mask.iter()
                    .map(|&active| {
                        if active {
                            [1.0, 0.0, 0.0]
                        } else {
                            [0.0, 0.0, 0.0]
                        }
                    })
                    .collect()
            } else {
                vec![[1.0, 0.0, 0.0]; n_cells]
            }
        }
    };

    let controls = planned_study_controls(problem, resolved_backend, &mut errors);
    let requested_integrator = controls.requested_integrator;
    let integrator = controls.integrator;
    if !problem.field_drives.is_empty() && integrator == Some(IntegratorChoice::Abm3) {
        errors.push(
            "RegionalFieldDrive is not executable with ABM3 because the multistep history has no qualified discontinuity/event restart contract; use heun, rk4, rk23, or rk45"
                .to_string(),
        );
    }
    if runtime_requests_cuda(problem)
        && problem
            .field_drives
            .iter()
            .any(|drive| crate::util::field_drive_is_active(drive, problem))
    {
        errors.push(
            "fdm_cuda_regional_field_drive_unsupported: regional time-domain field drives are implemented only by the FDM CPU reference lane; request device='cpu' or use FEM CUDA double"
                .to_string(),
        );
    }
    let fixed_timestep = controls.fixed_timestep;
    let gyromagnetic_ratio = controls.gyromagnetic_ratio;
    let relaxation = controls.relaxation;
    let adaptive_timestep = controls.adaptive_timestep;
    let field_refresh = controls.field_refresh;
    if adaptive_timestep.is_some()
        && (has_thermal_noise || thermal_temperature.unwrap_or(0.0) > 0.0)
    {
        errors.push(
            "adaptive_timestep with Brown thermal noise is not executable until the accepted-step SDE replay contract is qualified; use fixed-step Heun"
                .to_string(),
        );
    }
    if !errors.is_empty() {
        return Err(PlanError { reasons: errors });
    }

    let active_count = active_mask
        .as_ref()
        .map(|mask| mask.iter().filter(|&&active| active).count())
        .unwrap_or(n_cells);
    let owner_names = [magnet.name.as_str(), geometry.name()];
    let (region_mask, region_index_by_id) = materialize_object_region_mask(
        problem,
        &owner_names,
        grid_cells,
        cell_size,
        native_origin,
        top_level_translation,
        active_mask.as_ref(),
        &mut errors,
    );
    if !errors.is_empty() {
        return Err(PlanError { reasons: errors });
    }
    let sot_active_mask = sot
        .target
        .as_ref()
        .map(|target| {
            materialize_prescribed_sot_target_mask(
                problem,
                target,
                &owner_names,
                &region_mask,
                &region_index_by_id,
                active_mask.as_deref(),
            )
        })
        .transpose()?;
    let slonczewski_active_mask = spin_torque
        .slonczewski_target
        .as_ref()
        .map(|target| {
            materialize_prescribed_sot_target_mask(
                problem,
                target,
                &owner_names,
                &region_mask,
                &region_index_by_id,
                active_mask.as_deref(),
            )
        })
        .transpose()?;
    apply_region_texture_overrides(
        problem,
        &region_index_by_id,
        &region_mask,
        grid_cells,
        cell_size,
        native_origin,
        top_level_translation,
        active_mask.as_ref(),
        &mut initial_magnetization,
        &mut errors,
    );
    if !errors.is_empty() {
        return Err(PlanError { reasons: errors });
    }
    let inter_region_exchange = materialize_region_exchange_couplings(
        problem,
        material.exchange_stiffness,
        &region_index_by_id,
        &mut errors,
    );
    if !errors.is_empty() {
        return Err(PlanError { reasons: errors });
    }

    let sample_points = grid_sample_points(
        grid_cells,
        cell_size,
        native_origin,
        [0.0; 3],
        active_mask.as_ref(),
    );
    let point_coords: Vec<[f64; 3]> = sample_points.iter().map(|p| p.position_world).collect();
    let antenna_zeeman_masks =
        resolve_prescribed_zeeman_masks(problem, &point_coords, active_mask.as_deref())?;

    // Resolve Ms field
    let ms_field_resolved = crate::material::resolve_spatial_parameter(
        problem,
        magnet.name.as_str(),
        fullmag_ir::MaterialParameterNameIR::Ms,
        material.saturation_magnetisation,
        &point_coords,
        [0.0, 0.0, 0.0],
    );
    let ms_field_opt = match ms_field_resolved {
        Ok(v) => {
            let is_uniform = v
                .iter()
                .all(|&val| (val - material.saturation_magnetisation).abs() <= 1e-12);
            if is_uniform {
                None
            } else {
                Some(v)
            }
        }
        Err(e) => {
            errors.push(e);
            return Err(PlanError { reasons: errors });
        }
    };

    // Resolve Aex field
    let aex_field_resolved = crate::material::resolve_spatial_parameter(
        problem,
        magnet.name.as_str(),
        fullmag_ir::MaterialParameterNameIR::Aex,
        material.exchange_stiffness,
        &point_coords,
        [0.0, 0.0, 0.0],
    );
    let aex_field_opt = match aex_field_resolved {
        Ok(v) => {
            let is_uniform = v
                .iter()
                .all(|&val| (val - material.exchange_stiffness).abs() <= 1e-12);
            if is_uniform {
                None
            } else {
                Some(v)
            }
        }
        Err(e) => {
            errors.push(e);
            return Err(PlanError { reasons: errors });
        }
    };

    // Resolve alpha field
    let alpha_field_resolved = crate::material::resolve_spatial_parameter(
        problem,
        magnet.name.as_str(),
        fullmag_ir::MaterialParameterNameIR::Alpha,
        material.damping,
        &point_coords,
        [0.0, 0.0, 0.0],
    );
    let alpha_field_opt = match alpha_field_resolved {
        Ok(v) => {
            let is_uniform = v.iter().all(|&val| (val - material.damping).abs() <= 1e-12);
            if is_uniform {
                None
            } else {
                Some(v)
            }
        }
        Err(e) => {
            errors.push(e);
            return Err(PlanError { reasons: errors });
        }
    };

    let material_field_plans = crate::material::build_material_field_plans(
        problem,
        magnet.name.as_str(),
        fullmag_ir::MaterialFieldLocationIR::Cell,
    );

    let geometry_label = match &shape {
        GeometryShape::Box { .. } if used_precomputed_asset => format!(
            "Box geometry used precomputed FDM grid asset: {}x{}x{} cells",
            grid_cells[0], grid_cells[1], grid_cells[2]
        ),
        GeometryShape::Box { .. } => format!(
            "Box geometry lowered to {}x{}x{} grid",
            grid_cells[0], grid_cells[1], grid_cells[2]
        ),
        GeometryShape::Cylinder { radius, .. } if used_precomputed_asset => format!(
            "Cylinder (r={:.3e}) used precomputed FDM grid asset: {}x{}x{} cells, {}/{} active cells",
            radius, grid_cells[0], grid_cells[1], grid_cells[2], active_count, n_cells
        ),
        GeometryShape::Cylinder { radius, .. } => format!(
            "Cylinder (r={:.3e}) voxelized to {}x{}x{} grid, {}/{} active cells",
            radius, grid_cells[0], grid_cells[1], grid_cells[2], active_count, n_cells
        ),
        GeometryShape::Sphere { radius } => format!(
            "Sphere (r={:.3e}) voxelized to {}x{}x{} grid, {}/{} active cells",
            radius, grid_cells[0], grid_cells[1], grid_cells[2], active_count, n_cells
        ),
        GeometryShape::SinWaveguide {
            period,
            amplitude,
            ..
        } => format!(
            "SinWaveguide (period={:.3e}, amplitude={:.3e}) voxelized to {}x{}x{} grid, {}/{} active cells",
            period, amplitude, grid_cells[0], grid_cells[1], grid_cells[2], active_count, n_cells
        ),
        GeometryShape::ArchWaveguide { arch_height, .. } => format!(
            "ArchWaveguide (arch_height={:.3e}) voxelized to {}x{}x{} grid, {}/{} active cells",
            arch_height, grid_cells[0], grid_cells[1], grid_cells[2], active_count, n_cells
        ),
        GeometryShape::Imported { format, .. } => format!(
            "Imported geometry ({format}) used precomputed FDM grid asset: {}x{}x{} cells, {}/{} active cells",
            grid_cells[0], grid_cells[1], grid_cells[2], active_count, n_cells
        ),
        GeometryShape::Difference { .. } => format!(
            "CSG Difference voxelized to {}x{}x{} grid, {}/{} active cells",
            grid_cells[0], grid_cells[1], grid_cells[2], active_count, n_cells
        ),
        GeometryShape::Translate { .. } => format!(
            "Translated geometry voxelized to {}x{}x{} grid, {}/{} active cells",
            grid_cells[0], grid_cells[1], grid_cells[2], active_count, n_cells
        ),
    };

    let realized_size = [
        grid_cells[0] as f64 * cell_size[0],
        grid_cells[1] as f64 * cell_size[1],
        grid_cells[2] as f64 * cell_size[2],
    ];
    let grid_legend = build_fdm_region_legend(problem, &owner_names, &region_index_by_id);
    let grid_object_ids = if transport_object_masks.is_empty() {
        owner_names.iter().map(|name| (*name).to_string()).collect()
    } else {
        transport_object_masks.keys().cloned().collect()
    };
    let grid_certificate = FdmGridCertificateIR::new_with_masks(
        native_origin,
        grid_cells,
        cell_size,
        active_count as u64,
        grid_cost.estimated_bytes,
        active_mask.as_deref(),
        &region_mask,
    )
    .map_err(|message| PlanError {
        reasons: vec![format!("invalid resolved FDM grid certificate: {message}")],
    })?
    .with_object_ids(grid_object_ids)
    .with_region_legend(grid_legend);
    let active_field_drives: Vec<_> = problem
        .field_drives
        .iter()
        .filter(|drive| crate::util::field_drive_is_active(drive, problem))
        .cloned()
        .collect();
    let regional_field_drive_bases =
        crate::regional_field_drive::resolve_fdm_regional_field_drives(
            &active_field_drives,
            &point_coords,
            active_mask.as_deref(),
            &region_mask,
            Some(&grid_certificate),
            cell_size,
            &problem.geometry.entries,
        )?;

    let mut resolved_ms_for_transport = ms_field_opt
        .clone()
        .unwrap_or_else(|| vec![material.saturation_magnetisation; n_cells]);
    if let Some(magnetic_mask) = active_mask.as_deref() {
        for (ms, magnetic) in resolved_ms_for_transport.iter_mut().zip(magnetic_mask) {
            if !magnetic {
                *ms = 0.0;
            }
        }
    }
    let spin_transport_context = crate::spin_transport::FdmSpinTransportResolutionContext {
        owner_names: &owner_names,
        object_masks_by_id: (!transport_object_masks.is_empty()).then_some(&transport_object_masks),
        region_masks_by_ref: (!transport_region_masks.is_empty())
            .then_some(&transport_region_masks),
        grid_cells,
        origin_m: native_origin,
        cell_size_m: cell_size,
        active_mask: active_mask.as_deref(),
        region_mask: &region_mask,
        region_index_by_id: &region_index_by_id,
        initial_magnetization: &initial_magnetization,
        saturation_magnetization_apm: &resolved_ms_for_transport,
        gamma0_m_per_a_s: gyromagnetic_ratio,
    };
    let spin_transport_plans = crate::spin_transport::resolve_spin_transport_with_active_graph(
        problem,
        resolved_backend,
        &spin_transport_context,
        &active_transport_graph,
    )?;
    let fdm_gpu_charge_transports = resolve_fdm_gpu_charge_transports_with_active_graph(
        problem,
        resolved_backend,
        &spin_transport_context,
        &active_transport_graph,
    )?;

    let mut fdm_plan = FdmPlanIR {
        origin_m: native_origin,
        grid: GridDimensions { cells: grid_cells },
        cell_size,
        grid_certificate: Some(grid_certificate),
        region_mask,
        active_mask: active_mask.clone(),
        spin_transport_plans,
        fdm_gpu_charge_transports,
        initial_magnetization,
        material: FdmMaterialIR {
            name: material.name.clone(),
            saturation_magnetisation: material.saturation_magnetisation,
            exchange_stiffness: material.exchange_stiffness,
            damping: material.damping,
            ms_field: ms_field_opt,
            a_field: aex_field_opt,
            alpha_field: alpha_field_opt,
            uniaxial_anisotropy_ku1: material.uniaxial_anisotropy,
            uniaxial_anisotropy_ku2: material.uniaxial_anisotropy_k2,
            anisotropy_axis: material.anisotropy_axis,
            cubic_anisotropy_kc1: material.cubic_anisotropy_kc1,
            cubic_anisotropy_kc2: material.cubic_anisotropy_kc2,
            cubic_anisotropy_kc3: material.cubic_anisotropy_kc3,
            cubic_anisotropy_axis1: material.cubic_anisotropy_axis1,
            cubic_anisotropy_axis2: material.cubic_anisotropy_axis2,
        },
        enable_exchange,
        enable_demag,
        external_field,
        static_external_field_xyz,
        antenna_zeeman_masks,
        field_drives: active_field_drives,
        regional_field_drive_bases,
        time_stage: crate::util::time_stage_context(problem),
        inter_region_exchange,
        gyromagnetic_ratio,
        precision: problem.backend_policy.execution_precision,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        periodicity: problem.pbc.clone(),
        resolved_periodic_images,
        integrator,
        fixed_timestep,
        adaptive_timestep,
        field_refresh,
        relaxation,
        boundary_correction: problem
            .backend_policy
            .discretization_hints
            .as_ref()
            .and_then(|h| h.fdm.as_ref())
            .and_then(|fdm| fdm.boundary_correction.clone()),
        boundary_phi_floor: problem
            .backend_policy
            .discretization_hints
            .as_ref()
            .and_then(|h| h.fdm.as_ref())
            .and_then(|fdm| fdm.boundary_phi_floor),
        boundary_delta_min: problem
            .backend_policy
            .discretization_hints
            .as_ref()
            .and_then(|h| h.fdm.as_ref())
            .and_then(|fdm| fdm.boundary_delta_min),
        boundary_geometry: None,
        current_density: spin_torque.current_density,
        stt_degree: spin_torque.stt_degree,
        stt_beta: spin_torque.stt_beta,
        zhang_li_formula_version: spin_torque.zhang_li_formula_version.clone(),
        zhang_li_operator_version: spin_torque.zhang_li_operator_version.clone(),
        zhang_li_target: spin_torque.zhang_li_target.clone(),
        zhang_li_lande_g: spin_torque.zhang_li_lande_g,
        stt_spin_polarization: spin_torque.stt_spin_polarization,
        stt_lambda: spin_torque.stt_lambda,
        stt_epsilon_prime: spin_torque.stt_epsilon_prime,
        stt_thickness: spin_torque.stt_thickness,
        stt_fixed_layer_position: spin_torque.stt_fixed_layer_position.clone(),
        slonczewski_formula_version: spin_torque.slonczewski_formula_version.clone(),
        slonczewski_stack_normal: spin_torque.slonczewski_stack_normal,
        slonczewski_target: spin_torque.slonczewski_target.clone(),
        slonczewski_active_mask,
        has_oersted_cylinder: false,
        oersted_current: None,
        oersted_radius: None,
        oersted_center: None,
        oersted_axis: None,
        oersted_field_xyz: None,
        oersted_time_dep_kind: 0,
        oersted_time_dep_freq: 0.0,
        oersted_time_dep_phase: 0.0,
        oersted_time_dep_offset: 0.0,
        oersted_time_dep_t_on: 0.0,
        oersted_time_dep_t_off: 0.0,
        oersted_realization: None,
        temperature: thermal_temperature,
        thermal_seed_config,
        interfacial_dmi: None,
        bulk_dmi: None,
        dind_field: None,
        dbulk_field: None,
        mel_b1: None,
        mel_b2: None,
        mel_uniform_strain: None,
        sot_current_density: sot.current_density,
        sot_xi_dl: sot.xi_dl,
        sot_xi_fl: sot.xi_fl,
        sot_sigma: sot.sigma,
        sot_thickness: sot.thickness,
        sot_formula_version: sot.formula_version.map(str::to_string),
        sot_target: sot.target,
        sot_active_mask,
        sot_envelope: sot.envelope,
        sot_drive: sot.drive,
    };

    for (term_index, term) in problem.energy_terms.iter().enumerate() {
        if let Some(oersted) = resolve_fdm_oersted_term(
            problem,
            term_index,
            term,
            &current_transports,
            grid_cells,
            cell_size,
            active_mask.as_deref(),
        )? {
            match oersted {
                ResolvedOerstedTerm::Cylinder(oersted) => {
                    fdm_plan.has_oersted_cylinder = true;
                    fdm_plan.oersted_current = Some(oersted.current);
                    fdm_plan.oersted_radius = Some(oersted.radius);
                    fdm_plan.oersted_center = Some(oersted.center);
                    fdm_plan.oersted_axis = Some(oersted.axis);
                    fdm_plan.oersted_realization =
                        Some(fullmag_ir::OerstedRealization::InfiniteCylinder);
                    if let Some(td) = &oersted.time_dependence {
                        fdm_plan.has_oersted_cylinder = true;
                        match td {
                            TimeDependenceIR::Constant => {
                                fdm_plan.oersted_time_dep_kind = 0;
                            }
                            TimeDependenceIR::Sinusoidal {
                                frequency_hz,
                                phase_rad,
                                offset,
                            } => {
                                fdm_plan.oersted_time_dep_kind = 1;
                                fdm_plan.oersted_time_dep_freq = *frequency_hz;
                                fdm_plan.oersted_time_dep_phase = *phase_rad;
                                fdm_plan.oersted_time_dep_offset = *offset;
                            }
                            TimeDependenceIR::Pulse { t_on, t_off } => {
                                fdm_plan.oersted_time_dep_kind = 2;
                                fdm_plan.oersted_time_dep_t_on = *t_on;
                                fdm_plan.oersted_time_dep_t_off = *t_off;
                            }
                            TimeDependenceIR::PiecewiseLinear { .. }
                            | TimeDependenceIR::SincPulse { .. } => {
                                return Err(PlanError {
                                    reasons: vec![
                                        "Oersted time dependence supports only 'Constant', 'Sinusoidal', or 'Pulse' on the FDM backend; use prescribed_zeeman_mask antenna sources for sinc-pulse spin-wave drives"
                                            .to_string(),
                                    ],
                                });
                            }
                        }
                    }
                }
                ResolvedOerstedTerm::Field(field) => {
                    fdm_plan.oersted_field_xyz = Some(
                        field
                            .field_xyz
                            .chunks_exact(3)
                            .map(|chunk| [chunk[0], chunk[1], chunk[2]])
                            .collect(),
                    );
                    fdm_plan.oersted_realization =
                        Some(fullmag_ir::OerstedRealization::BiotSavartMidpoint);
                }
                ResolvedOerstedTerm::SolvedCurrent { .. } => {
                    // FDM transport owns the stage-consistent current solve;
                    // its workflow derives H_oe from the same charge field.
                    fdm_plan.oersted_realization =
                        Some(fullmag_ir::OerstedRealization::BiotSavartMidpoint);
                }
            }
            continue;
        }

        match term {
            EnergyTermIR::InterfacialDmi { d, .. } => {
                fdm_plan.interfacial_dmi = Some(*d);
            }
            EnergyTermIR::BulkDmi { d } => {
                fdm_plan.bulk_dmi = Some(*d);
            }
            _ => {}
        }
    }

    if fdm_plan.boundary_correction.is_some()
        && fdm_plan.boundary_correction.as_deref() != Some("none")
    {
        let compute_delta = fdm_plan.boundary_correction.as_deref() == Some("full");
        // Boundary-correction SDF is currently implemented only for:
        //   • Cylinder (single disk/pillar)
        //   • Difference(Cylinder, Cylinder) (ring / annulus)
        // A requested T0/T1 correction without this data is physically
        // meaningless, so the planner must fail rather than downgrade it.
        let local_sdf: Option<Box<dyn Fn(f64, f64, f64) -> f64>> = match &shape {
            GeometryShape::Cylinder { .. } | GeometryShape::Translate { .. } => {
                finite_cylinder_sdf_for_shape(&shape, [0.0, 0.0, 0.0])
            }
            GeometryShape::Difference { base, tool } => {
                let base_sdf = finite_cylinder_sdf_for_shape(base, [0.0, 0.0, 0.0]);
                let tool_sdf = finite_cylinder_sdf_for_shape(tool, [0.0, 0.0, 0.0]);
                match (base_sdf, tool_sdf) {
                    (Some(base_sdf), Some(tool_sdf)) => Some(Box::new(move |x, y, z| {
                        base_sdf(x, y, z).max(-tool_sdf(x, y, z))
                    })),
                    _ => None,
                }
            }
            _ => None,
        };

        if let Some(local_sdf) = local_sdf {
            let origin = native_origin;
            let sdf = move |x: f64, y: f64, z: f64| {
                local_sdf(x + origin[0], y + origin[1], z + origin[2])
            };
            fdm_plan.boundary_geometry = Some(crate::boundary_geometry::compute_boundary_geometry(
                &sdf,
                grid_cells[0],
                grid_cells[1],
                grid_cells[2],
                cell_size[0],
                cell_size[1],
                cell_size[2],
                compute_delta,
            ));
        } else {
            return Err(PlanError {
                reasons: vec![format!(
                    "boundary_correction='{}' requires a supported SDF, but geometry shape {:?} \
                     does not have a supported SDF; supported shapes are Cylinder and \
                     Difference(Cylinder, Cylinder)",
                    fdm_plan.boundary_correction.as_deref().unwrap_or("?"),
                    shape,
                )],
            });
        }
    }

    let study_note = if let Some(control) = fdm_plan.relaxation.as_ref() {
        format!(
            "study: relaxation algorithm={} torque_tolerance={} energy_tolerance={} max_steps={}",
            control.algorithm.as_str(),
            control
                .stop
                .torque_tolerance_apm
                .map(|value| format!("{value:.6e}"))
                .unwrap_or_else(|| "none".to_string()),
            control
                .stop
                .energy_tolerance_j
                .map(|value| format!("{value:.6e}"))
                .unwrap_or_else(|| "none".to_string()),
            control
                .stop
                .max_steps
                .map(|value| value.to_string())
                .unwrap_or_else(|| "none".to_string())
        )
    } else {
        "study: time_evolution".to_string()
    };

    Ok(ExecutionPlanIR {
        common: CommonPlanMeta {
            ir_version: IR_VERSION.to_string(),
            requested_backend: problem.backend_policy.requested_backend,
            resolved_backend,
            execution_mode: problem.validation_profile.execution_mode,
            material_field_plans,
        },
        backend_plan: BackendPlanIR::Fdm(fdm_plan),
        output_plan: OutputPlanIR {
            outputs: crate::sampling::runtime_outputs(problem),
        },
        provenance: ProvenancePlanIR {
            notes: vec![
                "Phase 1 reference FDM planner".to_string(),
                geometry_label,
                format!(
                    "realized grid size: [{:.6e}, {:.6e}, {:.6e}] m",
                    realized_size[0], realized_size[1], realized_size[2]
                ),
                format!(
                    "active terms: exchange={}, demag={}, zeeman={}",
                    enable_exchange,
                    enable_demag,
                    external_field.is_some()
                ),
                study_note,
            ],
            integrator_resolution: requested_integrator.map(|requested_integrator| {
                fullmag_ir::IntegratorResolutionProvenanceIR {
                    requested_integrator: Some(requested_integrator),
                    resolved_integrator: integrator,
                }
            }),
            fem_eigen_execution_resolution: None,
            physics_graph: None,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn region(index: usize) -> fullmag_ir::ObjectRegionIR {
        fullmag_ir::ObjectRegionIR {
            region_id: format!("strip:r{index}"),
            owner_object: "strip".to_string(),
            name: format!("r{index}"),
            shape: fullmag_ir::RegionShapeIR::Box {
                size: [1.0e-6; 3],
                center: [0.0; 3],
            },
            frame: fullmag_ir::RegionFrameIR::Object,
            enabled: true,
            priority: index as i32,
            mesh_policy: None,
            material_overrides: Vec::new(),
            texture_override: None,
            realization_policy: fullmag_ir::RegionRealizationPolicyIR::Inherit,
            material_transition: None,
        }
    }

    #[test]
    fn fdm_region_mask_accepts_255_active_regions() {
        let mut problem = fullmag_ir::ProblemIR::bootstrap_example();
        problem.object_regions = (0..fullmag_ir::MAX_FDM_REGION_IDS as usize)
            .map(region)
            .collect();
        let mut errors = Vec::new();
        let active_mask = vec![true];
        let (mask, ids) = materialize_object_region_mask(
            &problem,
            &["strip"],
            [1, 1, 1],
            [1.0e-9; 3],
            [0.0; 3],
            [0.0; 3],
            Some(&active_mask),
            &mut errors,
        );
        assert!(errors.is_empty(), "unexpected errors: {errors:?}");
        assert_eq!(ids.len(), fullmag_ir::MAX_FDM_REGION_IDS as usize);
        assert_eq!(mask, vec![fullmag_ir::MAX_FDM_REGION_IDS]);
    }

    #[test]
    fn fdm_region_mask_rejects_256_active_regions_before_sampling() {
        let mut problem = fullmag_ir::ProblemIR::bootstrap_example();
        problem.object_regions = (0..=fullmag_ir::MAX_FDM_REGION_IDS as usize)
            .map(region)
            .collect();
        let mut errors = Vec::new();
        let active_mask = vec![true];
        let (mask, ids) = materialize_object_region_mask(
            &problem,
            &["strip"],
            [1, 1, 1],
            [1.0e-9; 3],
            [0.0; 3],
            [0.0; 3],
            Some(&active_mask),
            &mut errors,
        );
        assert!(ids.is_empty());
        assert_eq!(mask, vec![0]);
        assert!(errors.iter().any(|error| {
            error.contains("fdm_region_lut_capacity_exceeded")
                && error.contains("requested_region_count=256")
        }));
    }

    #[test]
    fn fdm_object_region_uses_inverse_owner_translation_for_membership() {
        let mut problem = fullmag_ir::ProblemIR::bootstrap_example();
        let mut translated_region = region(0);
        translated_region.shape = fullmag_ir::RegionShapeIR::Box {
            size: [2.0e-6; 3],
            center: [0.0; 3],
        };
        problem.object_regions = vec![translated_region];
        let mut errors = Vec::new();
        let active_mask = vec![true];
        let (mask, _) = materialize_object_region_mask(
            &problem,
            &["strip"],
            [1, 1, 1],
            [1.0e-6; 3],
            [1.0e-6; 3],
            [1.0e-6; 3],
            Some(&active_mask),
            &mut errors,
        );
        assert!(errors.is_empty(), "unexpected errors: {errors:?}");
        assert_eq!(
            mask,
            vec![1],
            "translated owner must be sampled in object coordinates"
        );
    }

    #[test]
    fn prescribed_sot_region_target_materializes_cell_mask() {
        let mut problem = fullmag_ir::ProblemIR::bootstrap_example();
        problem.object_regions = vec![region(0)];
        let target = fullmag_ir::RegionRefIR {
            object_id: "strip".to_string(),
            region_id: Some("strip:r0".to_string()),
        };
        let active_mask = vec![true, true, false];
        let region_mask = vec![1, 0, 0];
        let region_ids = BTreeMap::from([("strip:r0".to_string(), 1)]);

        let mask = materialize_prescribed_sot_target_mask(
            &problem,
            &target,
            &["strip"],
            &region_mask,
            &region_ids,
            Some(&active_mask),
        )
        .expect("valid region target must materialize");

        assert_eq!(mask, vec![true, false, false]);
    }
}

fn reject_fdm_spatial_material_fields(problem: &ProblemIR, lane: &str, errors: &mut Vec<String>) {
    let mut seen_materials = BTreeSet::new();
    for magnet in &problem.magnets {
        let Some(material) = problem
            .materials
            .iter()
            .find(|material| material.name == magnet.material)
        else {
            continue;
        };
        if !seen_materials.insert(material.name.as_str()) {
            continue;
        }
        let fields = fdm_spatial_material_field_names(material);
        if fields.is_empty() {
            continue;
        }
        errors.push(format!(
            "per-cell material fields ({}) on material '{}' are not executable in the current {lane} path; FDM planning currently carries uniform material constants only",
            fields.join(", "),
            material.name
        ));
    }
}

fn fdm_spatial_material_field_names(material: &fullmag_ir::MaterialIR) -> Vec<&'static str> {
    let mut fields = Vec::new();
    if material.ku_field.is_some() {
        fields.push("ku_field");
    }
    if material.ku2_field.is_some() {
        fields.push("ku2_field");
    }
    if material.kc1_field.is_some() {
        fields.push("kc1_field");
    }
    if material.kc2_field.is_some() {
        fields.push("kc2_field");
    }
    if material.kc3_field.is_some() {
        fields.push("kc3_field");
    }
    if material.dind_field.is_some() {
        fields.push("dind_field");
    }
    if material.dbulk_field.is_some() {
        fields.push("dbulk_field");
    }
    fields
}

fn fdm_supports_interfacial_dmi_normal(normal: [f64; 3]) -> bool {
    let norm_sq = normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2];
    if !norm_sq.is_finite() || norm_sq <= 1e-30 {
        return false;
    }
    let inv_norm = norm_sq.sqrt().recip();
    normal[0].abs() * inv_norm <= 1e-12
        && normal[1].abs() * inv_norm <= 1e-12
        && (normal[2] * inv_norm - 1.0).abs() <= 1e-12
}

pub const FDM_CUDA_MULTILAYER_TWO_D_STACK_UNQUALIFIED: &str =
    "fdm_cuda_multilayer_two_d_stack_unqualified";
pub const FDM_CUDA_MULTILAYER_PUSH_PULL_UNQUALIFIED: &str =
    "fdm_cuda_multilayer_push_pull_unqualified";
pub const FDM_CUDA_MULTILAYER_HETEROGENEOUS_NATIVE_HZ_UNQUALIFIED: &str =
    "fdm_cuda_multilayer_heterogeneous_native_hz_unqualified";
pub const FDM_CUDA_MULTILAYER_XY_OFFSET_UNQUALIFIED: &str =
    "fdm_cuda_multilayer_xy_offset_unqualified";
pub const FDM_CUDA_MULTILAYER_MATERIAL_FIELD_UNQUALIFIED: &str =
    "fdm_cuda_multilayer_material_field_unqualified";

/// Return fail-closed diagnostics for cellwise material payloads that the
/// current CUDA multilayer realizations would otherwise reduce to scalars.
pub fn fdm_multilayer_cuda_material_field_errors(layers: &[FdmLayerPlanIR]) -> Vec<String> {
    layers
        .iter()
        .filter_map(|layer| {
            let fields = [
                ("ms_field", layer.material.ms_field.is_some()),
                ("a_field", layer.material.a_field.is_some()),
                ("alpha_field", layer.material.alpha_field.is_some()),
            ]
            .into_iter()
            .filter_map(|(field, present)| present.then_some(field))
            .collect::<Vec<_>>();
            (!fields.is_empty()).then(|| {
                format!(
                    "{FDM_CUDA_MULTILAYER_MATERIAL_FIELD_UNQUALIFIED}: forced CUDA multilayer execution cannot consume cellwise material field(s) [{}] for layer '{}' object '{}'; use device='cpu'",
                    fields.join(", "),
                    layer.layer_id,
                    layer.object_id
                )
            })
        })
        .collect()
}

/// Return stable reason codes for multilayer operator classes which the
/// current CUDA runner cannot execute with the canonical CPU semantics.
pub fn fdm_multilayer_cuda_containment_reason_codes(
    enable_demag: bool,
    mode: &str,
    layers: &[FdmLayerPlanIR],
) -> Vec<&'static str> {
    if !enable_demag {
        return Vec::new();
    }
    let mut reasons = Vec::new();
    if mode == "two_d_stack" {
        reasons.push(FDM_CUDA_MULTILAYER_TWO_D_STACK_UNQUALIFIED);
    }
    if layers
        .iter()
        .any(|layer| layer.transfer_kind == "push_pull")
    {
        reasons.push(FDM_CUDA_MULTILAYER_PUSH_PULL_UNQUALIFIED);
    }
    if let Some(reference_hz) = layers.first().map(|layer| layer.native_cell_size[2]) {
        if layers
            .iter()
            .any(|layer| layer.native_cell_size[2] != reference_hz)
        {
            reasons.push(FDM_CUDA_MULTILAYER_HETEROGENEOUS_NATIVE_HZ_UNQUALIFIED);
        }
    }
    if let Some(reference_center) = layers.first().map(fdm_layer_xy_center) {
        if layers
            .iter()
            .map(fdm_layer_xy_center)
            .any(|center| center != reference_center)
        {
            reasons.push(FDM_CUDA_MULTILAYER_XY_OFFSET_UNQUALIFIED);
        }
    }
    reasons
}

fn fdm_layer_xy_center(layer: &FdmLayerPlanIR) -> [f64; 2] {
    // Exact equality is intentional for fail-closed runtime validation of
    // planner-resolved or deserialized grid descriptors. Introducing a
    // tolerance here could silently admit a real physical XY displacement.
    [
        layer.native_origin[0] + 0.5 * layer.native_grid[0] as f64 * layer.native_cell_size[0],
        layer.native_origin[1] + 0.5 * layer.native_grid[1] as f64 * layer.native_cell_size[1],
    ]
}

pub fn fdm_multilayer_cuda_native_single_grid_eligible(layers: &[FdmLayerPlanIR]) -> bool {
    let Some(first_layer) = layers.first() else {
        return false;
    };
    // Native CUDA v2 currently carries identity-grid descriptors only.  A
    // planner-resolved push/pull transfer (including a lateral offset or a
    // different native extent) must stay on the staged/assisted path rather
    // than being mistaken for the single-grid lane.
    if layers
        .iter()
        .any(|layer| layer.transfer_kind.as_str() != "identity")
    {
        return false;
    }
    let reference_material = &first_layer.material;
    let reference_cell_size = first_layer.native_cell_size;
    if layers.iter().any(|layer| {
        layer.material != *reference_material || layer.native_cell_size != reference_cell_size
    }) {
        return false;
    }

    let mut min_origin = first_layer.native_origin;
    let mut max_extent = [
        first_layer.native_origin[0] + first_layer.native_grid[0] as f64 * reference_cell_size[0],
        first_layer.native_origin[1] + first_layer.native_grid[1] as f64 * reference_cell_size[1],
        first_layer.native_origin[2] + first_layer.native_grid[2] as f64 * reference_cell_size[2],
    ];
    for layer in layers.iter().skip(1) {
        for axis in 0..3 {
            min_origin[axis] = min_origin[axis].min(layer.native_origin[axis]);
            max_extent[axis] = max_extent[axis].max(
                layer.native_origin[axis]
                    + layer.native_grid[axis] as f64 * reference_cell_size[axis],
            );
        }
    }

    let mut global_grid = [0usize; 3];
    for axis in 0..3 {
        let cells = (max_extent[axis] - min_origin[axis]) / reference_cell_size[axis];
        let rounded = cells.round();
        if (cells - rounded).abs() > 1e-6 || rounded < 1.0 {
            return false;
        }
        global_grid[axis] = rounded as usize;
    }
    let global_grid_u32 = match global_grid
        .iter()
        .copied()
        .map(u32::try_from)
        .collect::<Result<Vec<_>, _>>()
    {
        Ok(values) if values.len() == 3 => [values[0], values[1], values[2]],
        _ => return false,
    };
    if checked_fdm_grid_cost(global_grid_u32, FDM_GRID_ESTIMATED_BYTES_PER_CELL).is_err() {
        return false;
    }
    // Eligibility is resolved before aggregate admission. Keep this check
    // allocation-free so a large candidate cannot materialize a global mask
    // before the common/native/kernel memory budget has been accepted.
    let mut occupied_boxes: Vec<([usize; 3], [usize; 3])> = Vec::with_capacity(layers.len());

    for layer in layers {
        let native_grid = [
            layer.native_grid[0] as usize,
            layer.native_grid[1] as usize,
            layer.native_grid[2] as usize,
        ];
        let mut offset = [0usize; 3];
        for axis in 0..3 {
            let offset_cells =
                (layer.native_origin[axis] - min_origin[axis]) / reference_cell_size[axis];
            let rounded = offset_cells.round();
            if (offset_cells - rounded).abs() > 1e-6 || rounded < 0.0 {
                return false;
            }
            offset[axis] = rounded as usize;
        }
        let mut end = [0usize; 3];
        for axis in 0..3 {
            let Some(value) = offset[axis].checked_add(native_grid[axis]) else {
                return false;
            };
            if value > global_grid[axis] {
                return false;
            }
            end[axis] = value;
        }
        if occupied_boxes.iter().any(|(other_offset, other_end)| {
            (0..3).all(|axis| offset[axis] < other_end[axis] && other_offset[axis] < end[axis])
        }) {
            return false;
        }
        occupied_boxes.push((offset, end));
    }

    true
}

pub(crate) fn plan_fdm_multilayer(
    problem: &ProblemIR,
    resolved_backend: BackendTarget,
) -> Result<ExecutionPlanIR, PlanError> {
    let mut errors = Vec::new();
    let active_transport_graph =
        crate::spin_transport::resolve_active_fdm_transport_graph(problem)?;

    let fdm_hints = match &problem.backend_policy.discretization_hints {
        Some(DiscretizationHintsIR { fdm: Some(fdm), .. }) => fdm,
        _ => {
            return Err(PlanError {
                reasons: vec![
                    "FDM discretization hints are required for the public multilayer FDM path"
                        .to_string(),
                ],
            })
        }
    };
    if !matches!(
        fdm_hints.boundary_correction.as_deref(),
        None | Some("none")
    ) || fdm_hints.boundary_phi_floor.is_some()
        || fdm_hints.boundary_delta_min.is_some()
    {
        return Err(PlanError {
            reasons: vec![
                "multilayer FDM boundary intent is not representable by FdmMultilayerPlanIR; use boundary_correction='none' or omit it, and omit boundary_phi_floor and boundary_delta_min"
                    .to_string(),
            ],
        });
    }
    let demag_hints = fdm_hints.demag.as_ref();
    if let Some(policy) = demag_hints {
        if let Err(reasons) = policy.validate() {
            errors.extend(reasons);
        }
    }
    let requested_strategy = demag_hints
        .map(|policy| policy.strategy.as_str())
        .unwrap_or("auto");
    if requested_strategy == "single_grid" {
        errors.push(
            "multi-body FDM currently supports only the multilayer_convolution strategy; 'single_grid' for multiple magnets is not yet executable"
                .to_string(),
        );
    }
    if problem.temperature.unwrap_or(0.0) > 0.0 {
        errors.push(
            "thermal_noise is not executable in the current public multilayer FDM path; staged CPU/GPU multilayer RHS coverage is not implemented yet"
                .to_string(),
        );
    }
    if problem.couplings.iter().any(|coupling| coupling.enabled) {
        errors.push(
            "active coupling is not executable in the current multilayer FDM path; planner refuses to emit a partial plan without the runner coupling realization"
                .to_string(),
        );
    }
    reject_fdm_spatial_material_fields(problem, "multilayer FDM", &mut errors);
    if problem.current_density.is_some()
        || problem.stt_degree.is_some()
        || problem.stt_beta.is_some()
        || problem.stt_spin_polarization.is_some()
        || problem.stt_lambda.is_some()
        || problem.stt_epsilon_prime.is_some()
        || problem.stt_thickness.is_some()
        || problem.stt_fixed_layer_position.is_some()
        || active_transport_graph.has_active_torque_modules
    {
        errors.push(
            "spin_torque is not executable in the current public multilayer FDM path; staged CPU/GPU multilayer RHS coverage is not implemented yet"
                .to_string(),
        );
    }

    let mut enable_exchange = false;
    let mut enable_demag = false;
    let mut external_field = None;
    let mut interfacial_dmi = None;
    let mut bulk_dmi = None;
    for term in &problem.energy_terms {
        match term {
            fullmag_ir::EnergyTermIR::Exchange => {
                if enable_exchange {
                    errors.push("Exchange is declared more than once".to_string());
                }
                enable_exchange = true;
            }
            fullmag_ir::EnergyTermIR::Demag { .. } => {
                if enable_demag {
                    errors.push("Demag is declared more than once".to_string());
                }
                enable_demag = true;
            }
            fullmag_ir::EnergyTermIR::Zeeman { b } => {
                if external_field.is_some() {
                    errors.push("Zeeman is declared more than once".to_string());
                }
                external_field = Some([b[0] / MU0, b[1] / MU0, b[2] / MU0]);
            }
            fullmag_ir::EnergyTermIR::StaticFieldMap { .. } => {
                errors.push(
                    "StaticFieldMap is not executable in the current public multilayer FDM path; use a qualified single-grid FDM plan"
                        .to_string(),
                );
            }
            fullmag_ir::EnergyTermIR::InterfacialDmi {
                d,
                interface_normal,
            } => {
                if interfacial_dmi.is_some() {
                    errors.push("InterfacialDmi is declared more than once".to_string());
                }
                if interface_normal
                    .is_some_and(|normal| !fdm_supports_interfacial_dmi_normal(normal))
                {
                    errors.push(
                        "InterfacialDmi.interface_normal is not executable in the current multilayer FDM lane: only the canonical +z interface normal is implemented; use +z or select FEM."
                            .to_string(),
                    );
                }
                interfacial_dmi = Some(*d);
            }
            fullmag_ir::EnergyTermIR::BulkDmi { d } => {
                if bulk_dmi.is_some() {
                    errors.push("BulkDmi is declared more than once".to_string());
                }
                bulk_dmi = Some(*d);
            }
            fullmag_ir::EnergyTermIR::OerstedCylinder { .. }
            | fullmag_ir::EnergyTermIR::OerstedField { .. } => {
                errors.push(
                    "Oersted is not executable in the current public multilayer FDM path; staged CPU/GPU multilayer RHS coverage is not implemented yet"
                        .to_string(),
                );
            }
            other => {
                errors.push(format!(
                    "energy term '{:?}' is semantic-only in the current public multilayer FDM path",
                    other
                ));
            }
        }
    }
    if bulk_dmi.is_some() {
        errors.push(
            "BulkDmi requires a natural exchange+DMI free-surface boundary condition; the current executable multilayer FDM lane does not implement it. Use a qualified fully periodic single-grid FDM plan or remove BulkDmi."
                .to_string(),
        );
    }
    if !problem.field_drives.is_empty() {
        errors.push(
            "RegionalFieldDrive is not executable in the current public multilayer FDM path because FdmMultilayerPlanIR does not retain field drives; remove the drive or use a qualified single-grid FDM plan"
                .to_string(),
        );
    }
    if let Some(pbc) = problem.pbc.as_ref() {
        if let Err(reason) = pbc.resolve_demag_boundary(enable_demag) {
            errors.push(reason);
        }
        if pbc.has_any_periodic() {
            errors.push(
                "FDM multilayer periodic axes are capability-gated until exchange seams and self/shifted demag kernels are qualified across every layer; use open boundaries or a qualified single-grid plan"
                    .to_string(),
            );
        }
        if problem.backend_policy.execution_precision == ExecutionPrecision::Single
            && runtime_requests_cuda(problem)
            && pbc.has_any_periodic()
        {
            errors.push(
                "FDM multilayer execution_precision='single' with CUDA and periodic axes is capability-gated until FP32 seam exchange parity is qualified; use execution_precision='double'"
                    .to_string(),
            );
        }
    }
    if !(enable_exchange || enable_demag || external_field.is_some()) {
        errors.push(
            "the current executable multilayer FDM path requires at least one of Exchange, Demag, or Zeeman"
                .to_string(),
        );
    }
    validate_executable_outputs(
        &problem.study.sampling().outputs,
        enable_exchange,
        enable_demag,
        external_field.is_some(),
        problem.energy_terms.iter().any(|term| {
            matches!(
                term,
                EnergyTermIR::OerstedCylinder { .. } | EnergyTermIR::OerstedField { .. }
            )
        }),
        interfacial_dmi.is_some() || bulk_dmi.is_some(),
        false,
        false,
        false,
        false,
        false,
        !problem.field_drives.is_empty(),
        // Keep transport output declarations legal across stages whose
        // pipeline is temporarily inactive; runtime scheduling filters those
        // quantities until a resolved transport session exists.
        !problem.spin_transport_modules.is_empty(),
        &mut errors,
    );
    if problem.backend_policy.execution_precision != ExecutionPrecision::Double
        && !runtime_requests_cuda(problem)
    {
        errors.push(
            "execution_precision='single' requires a CUDA device; the CPU reference multilayer FDM runner supports only 'double'"
                .to_string(),
        );
    }

    let geometry_by_name: BTreeMap<&str, &GeometryEntryIR> = problem
        .geometry
        .entries
        .iter()
        .map(|entry| (entry.name(), entry))
        .collect();
    let region_to_geometry: BTreeMap<&str, &str> = problem
        .regions
        .iter()
        .map(|region| (region.name.as_str(), region.geometry.as_str()))
        .collect();

    let mut lowered_bodies = Vec::with_capacity(problem.magnets.len());
    for magnet in &problem.magnets {
        let Some(geometry_name) = region_to_geometry.get(magnet.region.as_str()).copied() else {
            errors.push(format!(
                "magnet '{}' references region '{}' with no geometry binding",
                magnet.name, magnet.region
            ));
            continue;
        };
        let Some(geometry_entry) = geometry_by_name.get(geometry_name).copied() else {
            errors.push(format!(
                "magnet '{}' references geometry '{}' which is missing from geometry.entries",
                magnet.name, geometry_name
            ));
            continue;
        };

        let placed = match extract_multilayer_geometry(geometry_entry) {
            Ok(placed) => placed,
            Err(message) => {
                errors.push(message);
                continue;
            }
        };

        let cell_size = match cell_for_magnet(fdm_hints, magnet.name.as_str()) {
            Ok(cell) => cell,
            Err(reason) => {
                errors.push(reason);
                continue;
            }
        };
        let provided_grid_asset = problem.geometry_assets.as_ref().and_then(|assets| {
            assets
                .fdm_grid_assets
                .iter()
                .find(|asset| asset.geometry_name == geometry_name)
        });

        let (bounding_size, active_mask, grid_cells, native_origin) =
            if let Some(asset) = provided_grid_asset {
                validate_grid_asset_cell_size(asset, cell_size, &mut errors);
                let Some((bbox, active_mask, grid_cells, origin)) =
                    crop_fdm_asset_to_active_support(asset, &mut errors)
                else {
                    continue;
                };
                (bbox, Some(active_mask), grid_cells, origin)
            } else {
                let (bbox, mask, cells, local_origin) =
                    voxelize_shape(&placed.shape, cell_size, &mut errors);
                validate_realized_grid(
                    &format!("geometry '{}'", geometry_name),
                    bbox,
                    cells,
                    cell_size,
                    &mut errors,
                );
                let origin = [
                    placed.translation[0] + local_origin[0],
                    placed.translation[1] + local_origin[1],
                    placed.translation[2] + local_origin[2],
                ];
                (bbox, mask, cells, origin)
            };

        let Some(material) = problem
            .materials
            .iter()
            .find(|candidate| candidate.name == magnet.material)
        else {
            errors.push(format!(
                "magnet '{}' references missing material '{}'",
                magnet.name, magnet.material
            ));
            continue;
        };

        let grid_cost = match checked_fdm_grid_cost(grid_cells, FDM_GRID_ESTIMATED_BYTES_PER_CELL) {
            Ok(cost) => cost,
            Err(error) => {
                errors.extend(error.reasons);
                continue;
            }
        };
        let n_cells = match usize::try_from(grid_cost.cells) {
            Ok(cells) => cells,
            Err(_) => {
                errors.push(format!(
                    "fdm_grid_cell_count_not_addressable: cells={} requested_counts={:?}",
                    grid_cost.cells, grid_cells
                ));
                continue;
            }
        };
        let owner_names = [magnet.name.as_str(), geometry_name];
        let (native_region_mask, region_index_by_id) = materialize_object_region_mask(
            problem,
            &owner_names,
            grid_cells,
            cell_size,
            native_origin,
            placed.translation,
            active_mask.as_ref(),
            &mut errors,
        );
        let native_region_legend =
            build_fdm_region_legend(problem, &owner_names, &region_index_by_id);
        let sample_points = grid_sample_points(
            grid_cells,
            cell_size,
            native_origin,
            placed.translation,
            active_mask.as_ref(),
        );
        let point_coords = sample_points
            .iter()
            .map(|point| point.position_world)
            .collect::<Vec<_>>();
        let resolve_material_field = |parameter, base_value, label: &str| {
            let values = crate::material::resolve_spatial_parameter(
                problem,
                magnet.name.as_str(),
                parameter,
                base_value,
                &point_coords,
                placed.translation,
            )?;
            if values.len() != n_cells {
                return Err(format!(
                    "multilayer FDM resolved {label} field length {} does not match native cell count {n_cells}",
                    values.len()
                ));
            }
            let valid = values.iter().all(|value| {
                value.is_finite()
                    && match parameter {
                        fullmag_ir::MaterialParameterNameIR::Ms => *value > 0.0,
                        fullmag_ir::MaterialParameterNameIR::Aex
                        | fullmag_ir::MaterialParameterNameIR::Alpha => *value >= 0.0,
                        _ => true,
                    }
            });
            if !valid {
                return Err(format!(
                    "multilayer FDM resolved {label} field contains non-finite or physically invalid values"
                ));
            }
            let is_uniform = values.iter().all(|value| {
                let scale = value.abs().max(base_value.abs()).max(f64::MIN_POSITIVE);
                (*value - base_value).abs() <= 64.0 * f64::EPSILON * scale
            });
            Ok(if is_uniform { None } else { Some(values) })
        };
        let ms_field = match resolve_material_field(
            fullmag_ir::MaterialParameterNameIR::Ms,
            material.saturation_magnetisation,
            "Ms",
        ) {
            Ok(values) => values,
            Err(reason) => {
                errors.push(reason);
                None
            }
        };
        let a_field = match resolve_material_field(
            fullmag_ir::MaterialParameterNameIR::Aex,
            material.exchange_stiffness,
            "Aex",
        ) {
            Ok(values) => values,
            Err(reason) => {
                errors.push(reason);
                None
            }
        };
        let alpha_field = match resolve_material_field(
            fullmag_ir::MaterialParameterNameIR::Alpha,
            material.damping,
            "Alpha",
        ) {
            Ok(values) => values,
            Err(reason) => {
                errors.push(reason);
                None
            }
        };
        let initial_magnetization = match &magnet.initial_magnetization {
            Some(InitialMagnetizationIR::Uniform { value }) => {
                if let Some(ref mask) = active_mask {
                    mask.iter()
                        .map(|&active| if active { *value } else { [0.0, 0.0, 0.0] })
                        .collect()
                } else {
                    vec![*value; n_cells]
                }
            }
            Some(InitialMagnetizationIR::RandomSeeded { seed }) => {
                let mut vectors = generate_random_unit_vectors(*seed, n_cells);
                if let Some(ref mask) = active_mask {
                    for (index, active) in mask.iter().enumerate() {
                        if !active {
                            vectors[index] = [0.0, 0.0, 0.0];
                        }
                    }
                }
                vectors
            }
            Some(InitialMagnetizationIR::SampledField { values }) => {
                if values.len() != n_cells {
                    errors.push(format!(
                        "magnet '{}' sampled_field has {} vectors, but its realized native grid requires {} cells",
                        magnet.name,
                        values.len(),
                        n_cells
                    ));
                }
                values.clone()
            }
            Some(InitialMagnetizationIR::PresetTexture {
                preset_kind,
                preset_params,
                mapping,
                texture_transform,
                preset_version,
            }) => {
                let points = grid_sample_points(
                    grid_cells,
                    cell_size,
                    native_origin,
                    placed.translation,
                    active_mask.as_ref(),
                );
                match sample_preset_texture_versioned(
                    preset_kind,
                    *preset_version,
                    &preset_params,
                    mapping,
                    texture_transform,
                    &points,
                ) {
                    Ok(values) => values,
                    Err(message) => {
                        errors.push(format!("magnet '{}': {}", magnet.name, message));
                        vec![[0.0, 0.0, 0.0]; n_cells]
                    }
                }
            }
            None => {
                if let Some(ref mask) = active_mask {
                    mask.iter()
                        .map(|&active| {
                            if active {
                                [1.0, 0.0, 0.0]
                            } else {
                                [0.0, 0.0, 0.0]
                            }
                        })
                        .collect()
                } else {
                    vec![[1.0, 0.0, 0.0]; n_cells]
                }
            }
        };

        lowered_bodies.push(LoweredBody {
            magnet_name: magnet.name.clone(),
            overlap_geometry: placed,
            bounding_size,
            native_grid: grid_cells,
            native_cell_size: cell_size,
            native_origin,
            native_active_mask: active_mask,
            native_region_mask: Some(native_region_mask),
            native_region_legend: Some(native_region_legend),
            initial_magnetization,
            material: FdmMaterialIR {
                name: material.name.clone(),
                saturation_magnetisation: material.saturation_magnetisation,
                exchange_stiffness: material.exchange_stiffness,
                damping: material.damping,
                ms_field,
                a_field,
                alpha_field,
                uniaxial_anisotropy_ku1: material.uniaxial_anisotropy,
                uniaxial_anisotropy_ku2: material.uniaxial_anisotropy_k2,
                anisotropy_axis: material.anisotropy_axis,
                cubic_anisotropy_kc1: material.cubic_anisotropy_kc1,
                cubic_anisotropy_kc2: material.cubic_anisotropy_kc2,
                cubic_anisotropy_kc3: material.cubic_anisotropy_kc3,
                cubic_anisotropy_axis1: material.cubic_anisotropy_axis1,
                cubic_anisotropy_axis2: material.cubic_anisotropy_axis2,
            },
        });
    }

    if lowered_bodies.len() != problem.magnets.len() {
        if errors.is_empty() {
            errors.push(
                "failed to realize all magnets into multilayer bodies; see previous planner errors"
                    .to_string(),
            );
        }
        return Err(PlanError { reasons: errors });
    }

    // Native layers may have different lateral extents and centers.  Build a
    // common *computational* scratch envelope from the union of their native
    // XY bounds; it is not a physical mesh and does not erase each layer's
    // native origin.  The descriptor/runtime lane still decides whether the
    // resulting native-to-scratch transfer is executable.
    let mut common_xy_min = [f64::INFINITY; 2];
    let mut common_xy_max = [f64::NEG_INFINITY; 2];
    for body in &lowered_bodies {
        for axis in 0..2 {
            let upper = body.native_origin[axis] + body.bounding_size[axis];
            common_xy_min[axis] = common_xy_min[axis].min(body.native_origin[axis]);
            common_xy_max[axis] = common_xy_max[axis].max(upper);
        }
    }
    let common_xy_extent = [
        common_xy_max[0] - common_xy_min[0],
        common_xy_max[1] - common_xy_min[1],
    ];
    if common_xy_extent
        .iter()
        .any(|extent| !extent.is_finite() || *extent <= 0.0)
    {
        errors.push(
            "multilayer_convolution cannot resolve a finite, positive common XY scratch extent"
                .to_string(),
        );
    }

    for (index, left) in lowered_bodies.iter().enumerate() {
        for right in lowered_bodies.iter().skip(index + 1) {
            match multilayer_body_overlap(left, right) {
                BodyOverlap::Disjoint => {}
                BodyOverlap::Overlapping => {
                    errors.push(format!(
                    "multilayer_convolution does not allow overlapping bodies with positive XY/Z volume; '{}' overlaps '{}'",
                    left.magnet_name, right.magnet_name
                ));
                }
                BodyOverlap::Indeterminate => {
                    errors.push(format!(
                        "multilayer_convolution cannot safely classify overlap between '{}' and '{}'; CSG/imported geometry requires a dedicated exact overlap realization",
                        left.magnet_name, right.magnet_name
                    ));
                }
            }
        }
    }

    let requested_mode = demag_hints
        .map(|policy| policy.mode.clone())
        .unwrap_or_else(|| "auto".to_string());
    let native_z_cells = lowered_bodies
        .iter()
        .map(|body| body.native_grid[2])
        .collect::<Vec<_>>();
    let selected_mode = match demag_hints {
        Some(policy) => match policy.resolve_mode(&native_z_cells) {
            Ok(mode) => mode,
            Err(reasons) => {
                errors.extend(reasons);
                "three_d".to_string()
            }
        },
        None => {
            if native_z_cells.iter().all(|cells| *cells == 1) {
                "two_d_stack".to_string()
            } else {
                "three_d".to_string()
            }
        }
    };
    if selected_mode == "two_d_stack" && lowered_bodies.iter().any(|body| body.native_grid[2] != 1)
    {
        errors.push(
            "multilayer_convolution mode='two_d_stack' requires one native Z cell per layer or an explicit moment_preserving average; refusing to copy a native Z slice"
                .to_string(),
        );
    }

    let max_native_z_cells = lowered_bodies
        .iter()
        .map(|body| body.native_grid[2])
        .max()
        .unwrap_or(1);
    let max_native_z_size = lowered_bodies
        .iter()
        .map(|body| body.bounding_size[2])
        .fold(0.0_f64, f64::max);
    let common_cells = if let Some(policy) = demag_hints {
        if let Some(cells) = policy.common_cells {
            cells
        } else if let Some(cells_xy) = policy.common_cells_xy {
            [cells_xy[0], cells_xy[1], 1]
        } else if let Some(cell_size) = policy.common_cell_size {
            let extents = [common_xy_extent[0], common_xy_extent[1], max_native_z_size];
            let mut cells = [1_u32; 3];
            for axis in 0..3 {
                let ratio = extents[axis] / cell_size[axis];
                let rounded = ratio.round();
                if !ratio.is_finite()
                    || rounded < 1.0
                    || rounded > u32::MAX as f64
                    || (ratio - rounded).abs() > GRID_TOLERANCE * ratio.abs().max(1.0)
                {
                    let axis_name = ["x", "y", "z"][axis];
                    errors.push(format!(
                        "fdm.demag.common_cell_size[{axis_name}]={:.6e} m does not divide the common convolution extent {:.6e} m; strict mode does not round the grid",
                        cell_size[axis], extents[axis]
                    ));
                } else {
                    cells[axis] = rounded as u32;
                }
            }
            cells
        } else {
            match fdm_default_cell(fdm_hints) {
                Ok(base_cell) => [
                    (common_xy_extent[0] / base_cell[0]).round().max(1.0) as u32,
                    (common_xy_extent[1] / base_cell[1]).round().max(1.0) as u32,
                    if selected_mode == "two_d_stack" {
                        1
                    } else {
                        (max_native_z_size / base_cell[2]).round().max(1.0) as u32
                    },
                ],
                Err(reason) => {
                    errors.push(reason);
                    [
                        1,
                        1,
                        if selected_mode == "two_d_stack" {
                            1
                        } else {
                            max_native_z_cells.max(1)
                        },
                    ]
                }
            }
        }
    } else {
        match fdm_default_cell(fdm_hints) {
            Ok(base_cell) => [
                (common_xy_extent[0] / base_cell[0]).round().max(1.0) as u32,
                (common_xy_extent[1] / base_cell[1]).round().max(1.0) as u32,
                if selected_mode == "two_d_stack" {
                    1
                } else {
                    (max_native_z_size / base_cell[2]).round().max(1.0) as u32
                },
            ],
            Err(reason) => {
                errors.push(reason);
                [
                    1,
                    1,
                    if selected_mode == "two_d_stack" {
                        1
                    } else {
                        max_native_z_cells.max(1)
                    },
                ]
            }
        }
    };
    let convolution_cell_size = demag_hints
        .and_then(|policy| policy.common_cell_size)
        .unwrap_or([
            common_xy_extent[0] / common_cells[0] as f64,
            common_xy_extent[1] / common_cells[1] as f64,
            max_native_z_size / common_cells[2] as f64,
        ]);

    // Record the native-to-scratch placement that a descriptor-aware runtime
    // must use.  The current CPU/CUDA runners accept only a common scratch
    // shape/spacing and therefore remain fail-closed for any later runtime
    // path that cannot consume these non-zero windows.
    for body in &lowered_bodies {
        for axis in 0..2 {
            let offset_cells =
                (body.native_origin[axis] - common_xy_min[axis]) / convolution_cell_size[axis];
            let native_extent_cells = body.bounding_size[axis] / convolution_cell_size[axis];
            let upper_cells = offset_cells + native_extent_cells;
            if !offset_cells.is_finite()
                || !native_extent_cells.is_finite()
                || offset_cells < -GRID_TOLERANCE
                || upper_cells > common_cells[axis] as f64 + GRID_TOLERANCE
            {
                errors.push(format!(
                    "multilayer_convolution layer '{}' native {}-window does not fit the common scratch envelope: offset_cells={offset_cells:.6e} extent_cells={native_extent_cells:.6e} common_cells={}",
                    body.magnet_name,
                    ["x", "y"][axis],
                    common_cells[axis]
                ));
            }
        }
    }

    let common_grid_cost = checked_fdm_grid_cost(common_cells, FDM_GRID_ESTIMATED_BYTES_PER_CELL)?;

    let resolved_periodic_images = match problem.pbc.as_ref() {
        Some(pbc) => match pbc
            .resolve_periodic_images(common_cells, problem.backend_policy.execution_precision)
        {
            Ok(resolved) => resolved,
            Err(reason) => {
                errors.push(reason);
                None
            }
        },
        None => None,
    };

    let controls = planned_study_controls(problem, resolved_backend, &mut errors);
    let requested_integrator = controls.requested_integrator;
    let mut integrator = controls.integrator;
    let fixed_timestep = controls.fixed_timestep;
    let gyromagnetic_ratio = controls.gyromagnetic_ratio;
    let relaxation = controls.relaxation;
    let adaptive_timestep = controls.adaptive_timestep;
    let field_refresh = controls.field_refresh;
    if relaxation
        .as_ref()
        .is_some_and(|control| control.algorithm != RelaxationAlgorithmIR::LlgOverdamped)
    {
        errors.push(
            "the public multilayer FDM runner currently supports only 'llg_overdamped' relaxation"
                .to_string(),
        );
    }

    if !errors.is_empty() {
        return Err(PlanError { reasons: errors });
    }

    let has_distinct_xy_geometry = lowered_bodies.iter().any(|body| {
        body.native_origin[0] != common_xy_min[0]
            || body.native_origin[1] != common_xy_min[1]
            || body.bounding_size[0] != common_xy_extent[0]
            || body.bounding_size[1] != common_xy_extent[1]
    });
    let common_origin = lowered_bodies
        .iter()
        .fold([f64::INFINITY; 3], |mut origin, body| {
            for axis in 0..3 {
                origin[axis] = origin[axis].min(body.native_origin[axis]);
            }
            origin
        });
    let material_field_plans = problem
        .magnets
        .iter()
        .flat_map(|magnet| {
            crate::material::build_material_field_plans(
                problem,
                magnet.name.as_str(),
                fullmag_ir::MaterialFieldLocationIR::Cell,
            )
        })
        .collect::<Vec<_>>();
    let layers = lowered_bodies
        .into_iter()
        .map(|body| {
            let layer_id = format!("layer:{}", body.magnet_name);
            let object_id = body.magnet_name.clone();
            // Keep each layer's physical Z placement (the shifted kernel
            // convention is based on native/scratch Z origins), while sharing
            // the union-derived computational XY scratch origin.  A layer is
            // identity only when its native geometry is exactly that scratch
            // geometry; distinct extents/centers become explicit push/pull
            // transfers instead of being rejected or silently reinterpreted
            // as one physical mesh.
            let convolution_origin = [common_xy_min[0], common_xy_min[1], body.native_origin[2]];
            let native_matches_scratch = body.native_grid == common_cells
                && body.native_cell_size == convolution_cell_size
                && body.native_origin == convolution_origin;
            FdmLayerPlanIR {
                magnet_name: body.magnet_name,
                layer_id,
                object_id,
                native_grid: body.native_grid,
                native_cell_size: body.native_cell_size,
                native_origin: body.native_origin,
                native_active_mask: body.native_active_mask,
                native_region_mask: body.native_region_mask,
                native_region_legend: body.native_region_legend,
                initial_magnetization: body.initial_magnetization,
                material: body.material,
                convolution_grid: common_cells,
                convolution_cell_size,
                convolution_origin,
                transfer_kind: if native_matches_scratch {
                    "identity".to_string()
                } else {
                    "push_pull".to_string()
                },
            }
        })
        .collect::<Vec<_>>();
    let native_cuda_single_grid = runtime_requests_cuda(problem)
        && requested_strategy == "auto"
        && integrator != Some(IntegratorChoice::Heun)
        && fdm_multilayer_cuda_native_single_grid_eligible(&layers);
    let kernel_admission_model = if native_cuda_single_grid {
        KernelAdmissionModel::CudaNativeSingleGrid
    } else if runtime_requests_cuda(problem) {
        KernelAdmissionModel::CudaAbiV2PairPayload
    } else {
        KernelAdmissionModel::CpuFp64Catalog
    };
    let (estimated_pair_kernels, estimated_unique_kernels, estimated_kernel_bytes) =
        match resolve_multilayer_kernel_memory(
            &selected_mode,
            common_cells,
            &layers,
            problem.backend_policy.execution_precision,
            enable_demag,
            kernel_admission_model,
        ) {
            Ok(resolved) => {
                let pair_count =
                    u32::try_from(resolved.catalog.pair_bindings.len()).map_err(|_| PlanError {
                        reasons: vec![
                            "multilayer_convolution pair kernel telemetry exceeds u32".to_string()
                        ],
                    })?;
                let unique_count =
                    u32::try_from(resolved.catalog.keys.len()).map_err(|_| PlanError {
                        reasons: vec!["multilayer_convolution unique kernel telemetry exceeds u32"
                            .to_string()],
                    })?;
                if resolved.aggregate_bytes > crate::FDM_GRID_MAX_BYTES {
                    errors.push(format!(
                        "multilayer_convolution aggregate memory budget exceeded: admission_model={} estimated_bytes={} max_bytes={}",
                        resolved.accounting.admission_model.as_str(),
                        resolved.aggregate_bytes,
                        crate::FDM_GRID_MAX_BYTES
                    ));
                }
                (
                    pair_count,
                    unique_count,
                    resolved.accounting.admission_bytes,
                )
            }
            Err(error) => {
                errors.extend(error.reasons);
                (0, 0, 0)
            }
        };
    let multilayer_topology_tokens =
        fullmag_ir::fdm_multilayer_topology_tokens(&selected_mode, &layers);
    if runtime_requests_cuda(problem) {
        errors.extend(fdm_multilayer_cuda_material_field_errors(&layers));
        errors.extend(
            fdm_multilayer_cuda_containment_reason_codes(enable_demag, &selected_mode, &layers)
                .into_iter()
                .map(|reason_code| {
                    format!(
                        "{reason_code}: forced CUDA multilayer execution is not qualified for this operator class; use device='cpu'"
                    )
                }),
        );
    }
    let native_cuda_lane = runtime_requests_cuda(problem)
        && requested_strategy == "auto"
        && integrator != Some(IntegratorChoice::Heun)
        && fdm_multilayer_cuda_native_single_grid_eligible(&layers);
    let requested_auto_integrator = problem.study.optional_dynamics().is_some_and(|dynamics| {
        let fullmag_ir::DynamicsIR::Llg { integrator, .. } = dynamics;
        integrator == "auto"
    });
    if !native_cuda_lane && requested_auto_integrator {
        integrator = Some(IntegratorChoice::Heun);
    }
    if !native_cuda_lane
        && !matches!(
            integrator,
            Some(IntegratorChoice::Heun | IntegratorChoice::Rk4 | IntegratorChoice::Rk23)
        )
    {
        let lane = if runtime_requests_cuda(problem) {
            "staged CUDA"
        } else {
            "staged CPU"
        };
        errors.push(format!(
            "the {lane} multilayer FDM runner supports only fixed-step 'heun', 'rk4', and 'rk23' integrators; rk45 and abm3 require the native single-grid-compatible CUDA lane"
        ));
    }
    if adaptive_timestep.is_some() {
        errors.push(
            "the public multilayer FDM runner does not support adaptive_timestep on any CPU/CUDA lane"
                .to_string(),
        );
    }
    if !errors.is_empty() {
        return Err(PlanError { reasons: errors });
    }

    let grid_certificate = FdmGridCertificateIR::new_with_topology_tokens(
        common_origin,
        common_cells,
        convolution_cell_size,
        common_grid_cost.cells,
        common_grid_cost.estimated_bytes,
        None,
        &multilayer_topology_tokens,
    )
    .map_err(|message| PlanError {
        reasons: vec![format!(
            "invalid resolved multilayer FDM grid certificate: {message}"
        )],
    })?;

    let plan = FdmMultilayerPlanIR {
        mode: selected_mode.clone(),
        common_cells,
        requested_common_cell_size: demag_hints.and_then(|hints| hints.common_cell_size),
        grid_certificate: Some(grid_certificate),
        layers,
        enable_exchange,
        enable_demag,
        external_field,
        interfacial_dmi,
        bulk_dmi,
        gyromagnetic_ratio,
        precision: problem.backend_policy.execution_precision,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        periodicity: problem.pbc.clone(),
        resolved_periodic_images,
        integrator: integrator.expect("validated multilayer FDM studies require LLG dynamics"),
        fixed_timestep,
        field_refresh,
        relaxation,
        planner_summary: FdmMultilayerSummaryIR {
            requested_strategy: requested_strategy.to_string(),
            selected_strategy: "multilayer_convolution".to_string(),
            requested_mode,
            resolved_mode: selected_mode.clone(),
            eligibility: "eligible".to_string(),
            estimated_pair_kernels,
            estimated_unique_kernels,
            estimated_kernel_bytes,
            warnings: {
                let mut warnings = if has_distinct_xy_geometry {
                    vec![
                    "xy_geometry_uses_common_scratch_transfer; native CUDA identity lane remains fail-closed until it consumes per-layer insertion/crop descriptors".to_string(),
                    ]
                } else {
                    Vec::new()
                };
                if enable_demag
                    && kernel_admission_model == KernelAdmissionModel::CudaAbiV2PairPayload
                {
                    warnings.push(format!(
                        "cuda_abi_v2_l_squared_pair_payload: pair_kernels={} unique_catalog_kernels={} estimated_bytes={estimated_kernel_bytes}",
                        estimated_pair_kernels, estimated_unique_kernels
                    ));
                }
                warnings
            },
        },
    };

    let study_note = if let Some(control) = plan.relaxation.as_ref() {
        format!(
            "study: relaxation algorithm={} torque_tolerance={} energy_tolerance={} max_steps={}",
            control.algorithm.as_str(),
            control
                .stop
                .torque_tolerance_apm
                .map(|value| format!("{value:.6e}"))
                .unwrap_or_else(|| "none".to_string()),
            control
                .stop
                .energy_tolerance_j
                .map(|value| format!("{value:.6e}"))
                .unwrap_or_else(|| "none".to_string()),
            control
                .stop
                .max_steps
                .map(|value| value.to_string())
                .unwrap_or_else(|| "none".to_string())
        )
    } else {
        "study: time_evolution".to_string()
    };

    Ok(ExecutionPlanIR {
        common: CommonPlanMeta {
            ir_version: IR_VERSION.to_string(),
            requested_backend: problem.backend_policy.requested_backend,
            resolved_backend,
            execution_mode: problem.validation_profile.execution_mode,
            material_field_plans,
        },
        backend_plan: BackendPlanIR::FdmMultilayer(plan),
        output_plan: OutputPlanIR {
            outputs: crate::sampling::runtime_outputs(problem),
        },
        provenance: ProvenancePlanIR {
            notes: vec![
                "Phase 2 public multilayer FDM planner".to_string(),
                format!(
                    "multibody demag strategy: requested={}, selected=multilayer_convolution",
                    requested_strategy
                ),
                format!(
                    "multilayer common grid: {}x{}x{}",
                    common_cells[0], common_cells[1], common_cells[2]
                ),
                format!(
                    "active terms: exchange={}, demag={}, zeeman={}",
                    enable_exchange,
                    enable_demag,
                    external_field.is_some()
                ),
                study_note,
            ],
            integrator_resolution: requested_integrator.map(|requested_integrator| {
                fullmag_ir::IntegratorResolutionProvenanceIR {
                    requested_integrator: Some(requested_integrator),
                    resolved_integrator: integrator,
                }
            }),
            fem_eigen_execution_resolution: None,
            physics_graph: None,
        },
    })
}
