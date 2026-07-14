use fullmag_ir::{FdmHintsIR, FdmMaterialIR, GeometryEntryIR};

const TAU: f64 = std::f64::consts::PI * 2.0;

use crate::util::GRID_TOLERANCE;
use crate::PlanError;

/// Conservative per-cell planning estimate used before any FDM backing vector
/// or geometry mask is allocated.  The estimate covers the state, material,
/// region and scratch vectors shared by the CPU and CUDA lanes.
pub const FDM_GRID_ESTIMATED_BYTES_PER_CELL: u64 = 256;
/// Hard cell-count guard shared by all FDM execution lanes.
pub const FDM_GRID_MAX_CELLS: u64 = 1_000_000_000;
/// Hard resident-memory guard shared by all FDM execution lanes.
pub const FDM_GRID_MAX_BYTES: u64 = 8 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FdmGridCost {
    pub cells: u64,
    pub estimated_bytes: u64,
}

/// Calculate the resolved FDM grid cost without allowing intermediate
/// arithmetic to wrap or permitting an allocation above the lane budget.
pub fn checked_fdm_grid_cost(
    counts: [u32; 3],
    bytes_per_cell: u64,
) -> Result<FdmGridCost, PlanError> {
    let requested_counts = format!("[{},{},{}]", counts[0], counts[1], counts[2]);
    let cells = (counts[0] as u64)
        .checked_mul(counts[1] as u64)
        .and_then(|value| value.checked_mul(counts[2] as u64))
        .ok_or_else(|| PlanError {
            reasons: vec![format!(
                "fdm_grid_count_overflow: requested_counts={requested_counts}"
            )],
        })?;
    if cells > FDM_GRID_MAX_CELLS {
        return Err(PlanError {
            reasons: vec![format!(
                "fdm_grid_cell_budget_exceeded: requested_counts={requested_counts} cells={cells} max_cells={FDM_GRID_MAX_CELLS}"
            )],
        });
    }
    let estimated_bytes = cells.checked_mul(bytes_per_cell).ok_or_else(|| PlanError {
        reasons: vec![format!(
            "fdm_grid_memory_overflow: requested_counts={requested_counts} cells={cells} bytes_per_cell={bytes_per_cell}"
        )],
    })?;
    if estimated_bytes > FDM_GRID_MAX_BYTES {
        return Err(PlanError {
            reasons: vec![format!(
                "fdm_grid_memory_budget_exceeded: requested_counts={requested_counts} estimated_bytes={estimated_bytes} max_bytes={FDM_GRID_MAX_BYTES}"
            )],
        });
    }
    Ok(FdmGridCost {
        cells,
        estimated_bytes,
    })
}

fn checked_voxel_count(grid_cells: [u32; 3], errors: &mut Vec<String>) -> Option<usize> {
    match checked_fdm_grid_cost(grid_cells, FDM_GRID_ESTIMATED_BYTES_PER_CELL) {
        Ok(cost) => usize::try_from(cost.cells).ok(),
        Err(error) => {
            errors.extend(error.reasons);
            None
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) enum GeometryShape {
    Box {
        size: [f64; 3],
    },
    Cylinder {
        radius: f64,
        height: f64,
        axis: [f64; 3],
    },
    SinWaveguide {
        length: f64,
        width: f64,
        height: f64,
        period: f64,
        amplitude: f64,
        phase: f64,
        z0: f64,
    },
    ArchWaveguide {
        length: f64,
        width: f64,
        height: f64,
        arch_height: f64,
        z0: f64,
    },
    Imported {
        source: String,
        format: String,
    },
    Translate {
        child: std::boxed::Box<GeometryShape>,
        by: [f64; 3],
    },
    Difference {
        base: std::boxed::Box<GeometryShape>,
        tool: std::boxed::Box<GeometryShape>,
    },
}

#[derive(Debug, Clone)]
pub(crate) struct PlacedGeometry {
    pub name: String,
    pub shape: GeometryShape,
    pub translation: [f64; 3],
}

#[derive(Debug, Clone)]
pub(crate) struct LoweredBody {
    pub magnet_name: String,
    pub bounding_size: [f64; 3],
    pub native_grid: [u32; 3],
    pub native_cell_size: [f64; 3],
    pub native_origin: [f64; 3],
    pub native_active_mask: Option<Vec<bool>>,
    pub initial_magnetization: Vec<[f64; 3]>,
    pub material: FdmMaterialIR,
}

pub(crate) fn ir_to_shape(entry: &GeometryEntryIR) -> Result<GeometryShape, String> {
    match entry {
        GeometryEntryIR::Box { size, .. } => Ok(GeometryShape::Box { size: *size }),
        GeometryEntryIR::Cylinder {
            radius,
            height,
            axis,
            ..
        } => Ok(GeometryShape::Cylinder {
            radius: *radius,
            height: *height,
            axis: normalize_axis(*axis)?,
        }),
        GeometryEntryIR::SinWaveguide {
            length,
            width,
            height,
            period,
            amplitude,
            phase,
            z0,
            ..
        } => Ok(GeometryShape::SinWaveguide {
            length: *length,
            width: *width,
            height: *height,
            period: *period,
            amplitude: *amplitude,
            phase: *phase,
            z0: *z0,
        }),
        GeometryEntryIR::ArchWaveguide {
            length,
            width,
            height,
            arch_height,
            z0,
            ..
        } => Ok(GeometryShape::ArchWaveguide {
            length: *length,
            width: *width,
            height: *height,
            arch_height: *arch_height,
            z0: *z0,
        }),
        GeometryEntryIR::ImportedGeometry { source, format, .. } => Ok(GeometryShape::Imported {
            source: source.clone(),
            format: format.clone(),
        }),
        GeometryEntryIR::Difference { base, tool, .. } => Ok(GeometryShape::Difference {
            base: std::boxed::Box::new(ir_to_shape(base)?),
            tool: std::boxed::Box::new(ir_to_shape(tool)?),
        }),
        GeometryEntryIR::Union { name, .. } => Err(format!(
            "geometry '{}' (Union) is not yet supported by the FDM planner; use Box, Cylinder, or Difference",
            name
        )),
        GeometryEntryIR::Intersection { name, .. } => Err(format!(
            "geometry '{}' (Intersection) is not yet supported by the FDM planner; use Box, Cylinder, or Difference",
            name
        )),
        GeometryEntryIR::Translate { base, by, .. } => Ok(GeometryShape::Translate {
            child: std::boxed::Box::new(ir_to_shape(base)?),
            by: *by,
        }),
        GeometryEntryIR::Ellipsoid { name, .. } => Err(format!(
            "geometry '{}' (Ellipsoid) is not yet supported by the FDM planner; use Box or Cylinder",
            name
        )),
        GeometryEntryIR::Sphere { name, .. } => Err(format!(
            "geometry '{}' (Sphere) is not yet supported by the FDM planner; use Box or Cylinder",
            name
        )),
        GeometryEntryIR::Ellipse { name, .. } => Err(format!(
            "geometry '{}' (Ellipse) is not yet supported by the FDM planner; use Box or Cylinder",
            name
        )),
    }
}

pub(crate) fn extract_multilayer_geometry(
    entry: &GeometryEntryIR,
) -> Result<PlacedGeometry, String> {
    match entry {
        GeometryEntryIR::Translate { name, base, by } => {
            let mut placed = extract_multilayer_geometry(base)?;
            placed.name = name.clone();
            for axis in 0..3 {
                placed.translation[axis] += by[axis];
            }
            Ok(placed)
        }
        GeometryEntryIR::Box { .. }
        | GeometryEntryIR::Cylinder { .. }
        | GeometryEntryIR::SinWaveguide { .. }
        | GeometryEntryIR::ArchWaveguide { .. }
        | GeometryEntryIR::ImportedGeometry { .. }
        | GeometryEntryIR::Difference { .. } => Ok(PlacedGeometry {
            name: entry.name().to_string(),
            shape: ir_to_shape(entry).map_err(|e| e)?,
            translation: [0.0, 0.0, 0.0],
        }),
        GeometryEntryIR::Union { .. } | GeometryEntryIR::Intersection { .. } => Err(format!(
            "geometry '{}' uses CSG union/intersection which is not yet supported by the public multilayer planner; use Box/Cylinder/Difference with optional Translate",
            entry.name()
        )),
        GeometryEntryIR::Ellipsoid { .. }
        | GeometryEntryIR::Sphere { .. }
        | GeometryEntryIR::Ellipse { .. } => Err(format!(
            "geometry '{}' is not yet supported by the public multilayer planner; use Box/Cylinder/Difference with optional Translate",
            entry.name()
        )),
    }
}

pub(crate) fn shape_local_bounds(shape: &GeometryShape) -> Option<([f64; 3], [f64; 3])> {
    match shape {
        GeometryShape::Box { size } => Some((
            [-size[0] * 0.5, -size[1] * 0.5, -size[2] * 0.5],
            [size[0] * 0.5, size[1] * 0.5, size[2] * 0.5],
        )),
        GeometryShape::Cylinder {
            radius,
            height,
            axis,
        } => {
            let half_height = *height * 0.5;
            let extents = [0, 1, 2].map(|index| {
                let axial = axis[index];
                ((*radius * *radius * (1.0 - axial * axial))
                    + (half_height * half_height * axial * axial))
                    .sqrt()
            });
            Some(([-extents[0], -extents[1], -extents[2]], extents))
        }
        GeometryShape::SinWaveguide {
            length,
            width,
            height,
            amplitude,
            z0,
            ..
        } => {
            let half_height = *height * 0.5;
            let z_margin = amplitude.abs() + half_height;
            Some((
                [-length * 0.5, -width * 0.5, z0 - z_margin],
                [length * 0.5, width * 0.5, z0 + z_margin],
            ))
        }
        GeometryShape::ArchWaveguide {
            length,
            width,
            height,
            arch_height,
            z0,
        } => {
            let half_height = *height * 0.5;
            let z_min = z0.min(z0 + arch_height) - half_height;
            let z_max = z0.max(z0 + arch_height) + half_height;
            Some((
                [-length * 0.5, -width * 0.5, z_min],
                [length * 0.5, width * 0.5, z_max],
            ))
        }
        GeometryShape::Difference { base, .. } => shape_local_bounds(base),
        GeometryShape::Translate { child, by } => {
            let (bounds_min, bounds_max) = shape_local_bounds(child)?;
            Some((
                [
                    bounds_min[0] + by[0],
                    bounds_min[1] + by[1],
                    bounds_min[2] + by[2],
                ],
                [
                    bounds_max[0] + by[0],
                    bounds_max[1] + by[1],
                    bounds_max[2] + by[2],
                ],
            ))
        }
        GeometryShape::Imported { .. } => None,
    }
}

fn normalize_axis(axis: [f64; 3]) -> Result<[f64; 3], String> {
    if axis.iter().any(|component| !component.is_finite()) {
        return Err("cylinder axis must contain finite values".to_string());
    }
    let norm = (axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]).sqrt();
    if norm <= 1e-15 {
        return Err("cylinder axis must be non-zero".to_string());
    }
    Ok([axis[0] / norm, axis[1] / norm, axis[2] / norm])
}

fn contains_cylinder_point(
    radius: f64,
    height: f64,
    axis: [f64; 3],
    point: [f64; 3],
) -> bool {
    let axial = point[0] * axis[0] + point[1] * axis[1] + point[2] * axis[2];
    if axial.abs() > height * 0.5 {
        return false;
    }
    let radial_sq = point[0] * point[0]
        + point[1] * point[1]
        + point[2] * point[2]
        - axial * axial;
    radial_sq <= radius * radius
}

pub(crate) fn contains_cylinder(shape: &GeometryShape, point: [f64; 3]) -> bool {
    match shape {
        GeometryShape::Cylinder {
            radius,
            height,
            axis,
        } => contains_cylinder_point(*radius, *height, *axis, point),
        _ => false,
    }
}

impl GeometryShape {
    /// Evaluate authored geometry membership in world coordinates.
    ///
    /// CSG operands and transforms are evaluated recursively so a translated
    /// operand retains both its lateral offset and finite extent along z.
    pub(crate) fn contains(&self, point: [f64; 3]) -> bool {
        match self {
            Self::Box { size } => (0..3).all(|axis| point[axis].abs() <= size[axis] * 0.5),
            Self::Cylinder { .. } => contains_cylinder(self, point),
            Self::SinWaveguide {
                length,
                width,
                height,
                period,
                amplitude,
                phase,
                z0,
            } => contains_sin_waveguide(
                point[0], point[1], point[2], *length, *width, *height, *period, *amplitude,
                *phase, *z0,
            ),
            Self::ArchWaveguide {
                length,
                width,
                height,
                arch_height,
                z0,
            } => contains_arch_waveguide(
                point[0], point[1], point[2], *length, *width, *height, *arch_height, *z0,
            ),
            Self::Translate { child, by } => child.contains([
                point[0] - by[0],
                point[1] - by[1],
                point[2] - by[2],
            ]),
            Self::Difference { base, tool } => base.contains(point) && !tool.contains(point),
            Self::Imported { .. } => false,
        }
    }
}

fn contains_sin_waveguide(
    x: f64,
    y: f64,
    z: f64,
    length: f64,
    width: f64,
    height: f64,
    period: f64,
    amplitude: f64,
    phase: f64,
    z0: f64,
) -> bool {
    let half_length = length * 0.5;
    let half_width = width * 0.5;
    let half_height = height * 0.5;
    if x < -half_length || x > half_length || y < -half_width || y > half_width {
        return false;
    }
    let z_center = z0 + amplitude * ((TAU / period) * x + phase).sin();
    z >= z_center - half_height && z < z_center + half_height
}

fn contains_arch_waveguide(
    x: f64,
    y: f64,
    z: f64,
    length: f64,
    width: f64,
    height: f64,
    arch_height: f64,
    z0: f64,
) -> bool {
    let half_length = length * 0.5;
    let half_width = width * 0.5;
    let half_height = height * 0.5;
    if x < -half_length || x > half_length || y < -half_width || y > half_width {
        return false;
    }
    let t = (x + half_length) / length;
    let z_center = z0 + arch_height * (std::f64::consts::PI * t).sin();
    z >= z_center - half_height && z < z_center + half_height
}

pub(crate) fn voxelize_shape(
    shape: &GeometryShape,
    cell_size: [f64; 3],
    errors: &mut Vec<String>,
) -> ([f64; 3], Option<Vec<bool>>, [u32; 3], [f64; 3]) {
    match shape {
        GeometryShape::Box { size } => {
            let grid_cells = [
                (size[0] / cell_size[0]).round().max(1.0) as u32,
                (size[1] / cell_size[1]).round().max(1.0) as u32,
                (size[2] / cell_size[2]).round().max(1.0) as u32,
            ];
            (
                *size,
                None,
                grid_cells,
                [-size[0] * 0.5, -size[1] * 0.5, -size[2] * 0.5],
            )
        }
        GeometryShape::Cylinder {
            radius,
            height,
            axis,
        } => {
            let half_height = *height * 0.5;
            let extents = [0, 1, 2].map(|index| {
                let axial = axis[index];
                ((*radius * *radius * (1.0 - axial * axial))
                    + (half_height * half_height * axial * axial))
                    .sqrt()
            });
            let bbox = [2.0 * extents[0], 2.0 * extents[1], 2.0 * extents[2]];
            let nx = (bbox[0] / cell_size[0]).round().max(1.0) as u32;
            let ny = (bbox[1] / cell_size[1]).round().max(1.0) as u32;
            let nz = (bbox[2] / cell_size[2]).round().max(1.0) as u32;
            let Some(n) = checked_voxel_count([nx, ny, nz], errors) else {
                return (bbox, None, [nx, ny, nz], [-bbox[0] * 0.5, -bbox[1] * 0.5, -bbox[2] * 0.5]);
            };
            let bounds_min = [-bbox[0] * 0.5, -bbox[1] * 0.5, -bbox[2] * 0.5];
            let mut mask = vec![false; n];
            for z in 0..nz {
                for y in 0..ny {
                    for x in 0..nx {
                        let point = [
                            bounds_min[0] + (x as f64 + 0.5) * cell_size[0],
                            bounds_min[1] + (y as f64 + 0.5) * cell_size[1],
                            bounds_min[2] + (z as f64 + 0.5) * cell_size[2],
                        ];
                        let idx = (x + nx * (y + ny * z)) as usize;
                        mask[idx] = contains_cylinder_point(*radius, *height, *axis, point);
                    }
                }
            }
            (
                bbox,
                Some(mask),
                [nx, ny, nz],
                bounds_min,
            )
        }
        GeometryShape::SinWaveguide {
            length,
            width,
            height,
            period,
            amplitude,
            phase,
            z0,
        } => {
            let (bounds_min, bounds_max) = shape_local_bounds(shape).expect("analytic bounds");
            let bbox = [
                bounds_max[0] - bounds_min[0],
                bounds_max[1] - bounds_min[1],
                bounds_max[2] - bounds_min[2],
            ];
            let nx = (bbox[0] / cell_size[0]).round().max(1.0) as u32;
            let ny = (bbox[1] / cell_size[1]).round().max(1.0) as u32;
            let nz = (bbox[2] / cell_size[2]).round().max(1.0) as u32;
            let Some(n) = checked_voxel_count([nx, ny, nz], errors) else {
                return (bbox, None, [nx, ny, nz], bounds_min);
            };
            let mut mask = vec![false; n];
            for iz in 0..nz {
                for iy in 0..ny {
                    for ix in 0..nx {
                        let px = bounds_min[0] + (ix as f64 + 0.5) * cell_size[0];
                        let py = bounds_min[1] + (iy as f64 + 0.5) * cell_size[1];
                        let pz = bounds_min[2] + (iz as f64 + 0.5) * cell_size[2];
                        let idx = (ix + nx * (iy + ny * iz)) as usize;
                        mask[idx] = contains_sin_waveguide(
                            px, py, pz, *length, *width, *height, *period, *amplitude, *phase, *z0,
                        );
                    }
                }
            }
            (bbox, Some(mask), [nx, ny, nz], bounds_min)
        }
        GeometryShape::ArchWaveguide {
            length,
            width,
            height,
            arch_height,
            z0,
        } => {
            let (bounds_min, bounds_max) = shape_local_bounds(shape).expect("analytic bounds");
            let bbox = [
                bounds_max[0] - bounds_min[0],
                bounds_max[1] - bounds_min[1],
                bounds_max[2] - bounds_min[2],
            ];
            let nx = (bbox[0] / cell_size[0]).round().max(1.0) as u32;
            let ny = (bbox[1] / cell_size[1]).round().max(1.0) as u32;
            let nz = (bbox[2] / cell_size[2]).round().max(1.0) as u32;
            let Some(n) = checked_voxel_count([nx, ny, nz], errors) else {
                return (bbox, None, [nx, ny, nz], bounds_min);
            };
            let mut mask = vec![false; n];
            for iz in 0..nz {
                for iy in 0..ny {
                    for ix in 0..nx {
                        let px = bounds_min[0] + (ix as f64 + 0.5) * cell_size[0];
                        let py = bounds_min[1] + (iy as f64 + 0.5) * cell_size[1];
                        let pz = bounds_min[2] + (iz as f64 + 0.5) * cell_size[2];
                        let idx = (ix + nx * (iy + ny * iz)) as usize;
                        mask[idx] = contains_arch_waveguide(
                            px,
                            py,
                            pz,
                            *length,
                            *width,
                            *height,
                            *arch_height,
                            *z0,
                        );
                    }
                }
            }
            (bbox, Some(mask), [nx, ny, nz], bounds_min)
        }
        GeometryShape::Imported { source, format } => {
            errors.push(format!(
                "geometry '{}:{}' requires a precomputed FDM grid asset in the public multilayer planner",
                format, source
            ));
            ([1.0, 1.0, 1.0], None, [1, 1, 1], [-0.5, -0.5, -0.5])
        }
        GeometryShape::Difference { base, tool } => {
            let Some((bounds_min, bounds_max)) = shape_local_bounds(base) else {
                errors.push("CSG Difference: base must be a bounded analytic shape".to_string());
                return ([1.0, 1.0, 1.0], None, [1, 1, 1], [-0.5, -0.5, -0.5]);
            };
            if shape_local_bounds(tool).is_none() {
                errors.push("CSG Difference: tool must be a bounded analytic shape".to_string());
            }
            let bbox = [
                bounds_max[0] - bounds_min[0],
                bounds_max[1] - bounds_min[1],
                bounds_max[2] - bounds_min[2],
            ];
            let nx = (bbox[0] / cell_size[0]).round().max(1.0) as u32;
            let ny = (bbox[1] / cell_size[1]).round().max(1.0) as u32;
            let nz = (bbox[2] / cell_size[2]).round().max(1.0) as u32;
            let Some(n) = checked_voxel_count([nx, ny, nz], errors) else {
                return (bbox, None, [nx, ny, nz], bounds_min);
            };
            let mut mask = vec![false; n];
            for z in 0..nz {
                for y in 0..ny {
                    for x in 0..nx {
                        let point = [
                            bounds_min[0] + (x as f64 + 0.5) * cell_size[0],
                            bounds_min[1] + (y as f64 + 0.5) * cell_size[1],
                            bounds_min[2] + (z as f64 + 0.5) * cell_size[2],
                        ];
                        let idx = (x + nx * (y + ny * z)) as usize;
                        mask[idx] = base.contains(point) && !tool.contains(point);
                    }
                }
            }

            (bbox, Some(mask), [nx, ny, nz], bounds_min)
        }
        GeometryShape::Translate { .. } => {
            let Some((bounds_min, bounds_max)) = shape_local_bounds(shape) else {
                errors.push("translated geometry requires a bounded child shape".to_string());
                return ([1.0, 1.0, 1.0], None, [1, 1, 1], [-0.5, -0.5, -0.5]);
            };
            let bbox = [
                bounds_max[0] - bounds_min[0],
                bounds_max[1] - bounds_min[1],
                bounds_max[2] - bounds_min[2],
            ];
            let nx = (bbox[0] / cell_size[0]).round().max(1.0) as u32;
            let ny = (bbox[1] / cell_size[1]).round().max(1.0) as u32;
            let nz = (bbox[2] / cell_size[2]).round().max(1.0) as u32;
            let Some(n) = checked_voxel_count([nx, ny, nz], errors) else {
                return (bbox, None, [nx, ny, nz], bounds_min);
            };
            let mut mask = vec![false; n];
            for z in 0..nz {
                for y in 0..ny {
                    for x in 0..nx {
                        let point = [
                            bounds_min[0] + (x as f64 + 0.5) * cell_size[0],
                            bounds_min[1] + (y as f64 + 0.5) * cell_size[1],
                            bounds_min[2] + (z as f64 + 0.5) * cell_size[2],
                        ];
                        let idx = (x + nx * (y + ny * z)) as usize;
                        mask[idx] = shape.contains(point);
                    }
                }
            }
            (bbox, Some(mask), [nx, ny, nz], bounds_min)
        }
    }
}

pub(crate) fn validate_realized_grid(
    label: &str,
    requested_size: [f64; 3],
    realized_cells: [u32; 3],
    cell_size: [f64; 3],
    errors: &mut Vec<String>,
) {
    let realized_size = [
        realized_cells[0] as f64 * cell_size[0],
        realized_cells[1] as f64 * cell_size[1],
        realized_cells[2] as f64 * cell_size[2],
    ];
    for axis in 0..3 {
        if requested_size[axis] <= 0.0 {
            continue;
        }
        let rel_err = (realized_size[axis] - requested_size[axis]).abs() / requested_size[axis];
        if rel_err > GRID_TOLERANCE {
            let axis_name = ["x", "y", "z"][axis];
            errors.push(format!(
                "{} size along {} ({:.6e} m) is not an integer multiple of cell size ({:.6e} m); realized grid would be {:.6e} m (relative error {:.2e})",
                label,
                axis_name,
                requested_size[axis],
                cell_size[axis],
                realized_size[axis],
                rel_err
            ));
        }
    }
}

pub(crate) fn fdm_default_cell(hints: &FdmHintsIR) -> Result<[f64; 3], String> {
    if let Some(cell) = hints.default_cell {
        return Ok(cell);
    }
    if hints.cell.iter().all(|component| *component > 0.0 && component.is_finite()) {
        return Ok(hints.cell);
    }

    let Some(per_magnet) = hints.per_magnet.as_ref() else {
        return Err(
            "FDM discretization requires default_cell (or legacy cell) when per_magnet is absent"
                .to_string(),
        );
    };
    let mut cells = per_magnet.values().map(|grid| grid.cell);
    let Some(first) = cells.next() else {
        return Err("FDM discretization per_magnet must not be empty".to_string());
    };
    if cells.all(|cell| cell == first) {
        Ok(first)
    } else {
        Err(
            "FDM discretization requires default_cell when per_magnet cell overrides differ"
                .to_string(),
        )
    }
}

pub(crate) fn cell_for_magnet(
    hints: &FdmHintsIR,
    magnet_name: &str,
) -> Result<[f64; 3], String> {
    if let Some(cell) = hints
        .per_magnet
        .as_ref()
        .and_then(|per_magnet| per_magnet.get(magnet_name))
        .map(|grid| grid.cell)
    {
        return Ok(cell);
    }
    if hints
        .default_cell
        .is_none()
        && hints.cell.iter().all(|component| *component == 0.0)
        && hints.per_magnet.is_some()
    {
        return Err(format!(
            "FDM magnet '{}' has no per_magnet cell override and no default_cell is set",
            magnet_name
        ));
    }
    fdm_default_cell(hints).map_err(|reason| {
        format!(
            "FDM magnet '{}' has no resolved cell: {}",
            magnet_name, reason
        )
    })
}
