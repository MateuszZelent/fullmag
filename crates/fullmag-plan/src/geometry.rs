use fullmag_ir::{
    ArrayAxisIR, ArrayDirectionIR, ArraySpacingModeIR, FdmHintsIR, FdmMaterialIR, GeometryEntryIR,
    MAX_ARRAY_AXIS_COUNT, MAX_ARRAY_FDM_CANDIDATES_PER_QUERY, MAX_ARRAY_INSTANCES_FDM,
    MAX_ARRAY_INSTANCES_FEM_OCC,
};

const TAU: f64 = std::f64::consts::PI * 2.0;

use crate::selection::geometry::{
    contains_point, normalize_axis as normalize_selection_axis, AffineTransform3,
    BoundaryMembership, GeometryPredicate, SelectionError,
};
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
    Sphere {
        radius: f64,
    },
    Ellipsoid {
        radii: [f64; 3],
    },
    Ellipse {
        radii: [f64; 2],
        height: f64,
    },
    Cone {
        radius_bottom: f64,
        radius_top: f64,
        height: f64,
        axis: [f64; 3],
    },
    Torus {
        major_radius: f64,
        minor_radius: f64,
        axis: [f64; 3],
    },
    PolygonPrism {
        vertices_xy: Vec<[f64; 2]>,
        thickness: f64,
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
    Transform {
        child: std::boxed::Box<GeometryShape>,
        translation: [f64; 3],
        rotation_quat: [f64; 4],
        scale: [f64; 3],
        pivot: [f64; 3],
    },
    SlicePlane {
        child: std::boxed::Box<GeometryShape>,
        plane_origin: [f64; 3],
        plane_normal: [f64; 3],
        keep_side: String,
    },
    Difference {
        base: std::boxed::Box<GeometryShape>,
        tool: std::boxed::Box<GeometryShape>,
    },
    Union {
        a: std::boxed::Box<GeometryShape>,
        b: std::boxed::Box<GeometryShape>,
    },
    Intersection {
        a: std::boxed::Box<GeometryShape>,
        b: std::boxed::Box<GeometryShape>,
    },
    Xor {
        left: std::boxed::Box<GeometryShape>,
        right: std::boxed::Box<GeometryShape>,
    },
    Array3D {
        child: std::boxed::Box<GeometryShape>,
        axes: [ArrayAxisIR; 3],
        merge_overlapping: bool,
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
    pub overlap_geometry: PlacedGeometry,
    pub bounding_size: [f64; 3],
    pub native_grid: [u32; 3],
    pub native_cell_size: [f64; 3],
    pub native_origin: [f64; 3],
    pub native_active_mask: Option<Vec<bool>>,
    pub native_region_mask: Option<Vec<u32>>,
    pub native_region_legend: Option<Vec<fullmag_ir::FdmRegionLegendEntryIR>>,
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
            axis: normalize_selection_axis(*axis).map_err(|error| error.to_string())?,
        }),
        GeometryEntryIR::Sphere { radius, .. } => Ok(GeometryShape::Sphere { radius: *radius }),
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
        GeometryEntryIR::Union { a, b, .. } => Ok(GeometryShape::Union {
            a: std::boxed::Box::new(ir_to_shape(a)?),
            b: std::boxed::Box::new(ir_to_shape(b)?),
        }),
        GeometryEntryIR::Intersection { a, b, .. } => Ok(GeometryShape::Intersection {
            a: std::boxed::Box::new(ir_to_shape(a)?),
            b: std::boxed::Box::new(ir_to_shape(b)?),
        }),
        GeometryEntryIR::Xor { left, right, .. } => Ok(GeometryShape::Xor {
            left: std::boxed::Box::new(ir_to_shape(left)?),
            right: std::boxed::Box::new(ir_to_shape(right)?),
        }),
        GeometryEntryIR::Array3D {
            child,
            axes,
            merge_overlapping,
            ..
        } => Ok(GeometryShape::Array3D {
            child: std::boxed::Box::new(ir_to_shape(child)?),
            axes: normalize_array_axes(axes)?,
            merge_overlapping: *merge_overlapping,
        }),
        GeometryEntryIR::Translate { base, by, .. } => Ok(GeometryShape::Translate {
            child: std::boxed::Box::new(ir_to_shape(base)?),
            by: *by,
        }),
        GeometryEntryIR::Transform {
            child,
            translation,
            rotation_quat,
            scale,
            pivot,
            ..
        } => {
            let norm = (rotation_quat[0] * rotation_quat[0]
                + rotation_quat[1] * rotation_quat[1]
                + rotation_quat[2] * rotation_quat[2]
                + rotation_quat[3] * rotation_quat[3])
                .sqrt();
            if !norm.is_finite() || norm <= 1e-12 {
                return Err("Transform geometry rotation_quat must be finite and non-zero".to_string());
            }
            if scale.iter().any(|component| !component.is_finite() || *component <= 0.0) {
                return Err("Transform geometry scale components must be finite and positive".to_string());
            }
            Ok(GeometryShape::Transform {
                child: std::boxed::Box::new(ir_to_shape(child)?),
                translation: *translation,
                rotation_quat: [
                    rotation_quat[0] / norm,
                    rotation_quat[1] / norm,
                    rotation_quat[2] / norm,
                    rotation_quat[3] / norm,
                ],
                scale: *scale,
                pivot: *pivot,
            })
        }
        GeometryEntryIR::SlicePlane {
            child,
            plane_origin,
            plane_normal,
            keep_side,
            ..
        } => Ok(GeometryShape::SlicePlane {
            child: std::boxed::Box::new(ir_to_shape(child)?),
            plane_origin: *plane_origin,
            plane_normal: normalize_selection_axis(*plane_normal)
                .map_err(|error| error.to_string())?,
            keep_side: keep_side.clone(),
        }),
        GeometryEntryIR::Ellipsoid { radii, .. } => {
            if (radii[0] - radii[1]).abs() <= 1e-15 * radii[0].abs()
                && (radii[1] - radii[2]).abs() <= 1e-15 * radii[0].abs()
            {
                Ok(GeometryShape::Sphere { radius: radii[0] })
            } else {
                Ok(GeometryShape::Ellipsoid { radii: *radii })
            }
        }
        GeometryEntryIR::Ellipse { radii, height, .. } => Ok(GeometryShape::Ellipse {
            radii: *radii,
            height: *height,
        }),
        GeometryEntryIR::Cone {
            radius_bottom,
            radius_top,
            height,
            axis,
            ..
        } => Ok(GeometryShape::Cone {
            radius_bottom: *radius_bottom,
            radius_top: *radius_top,
            height: *height,
            axis: normalize_selection_axis(*axis).map_err(|error| error.to_string())?,
        }),
        GeometryEntryIR::Torus {
            major_radius,
            minor_radius,
            axis,
            ..
        } => Ok(GeometryShape::Torus {
            major_radius: *major_radius,
            minor_radius: *minor_radius,
            axis: normalize_selection_axis(*axis).map_err(|error| error.to_string())?,
        }),
        GeometryEntryIR::PolygonPrism {
            vertices_xy,
            thickness,
            ..
        } => Ok(GeometryShape::PolygonPrism {
            vertices_xy: vertices_xy.clone(),
            thickness: *thickness,
        }),
        GeometryEntryIR::MicrostripAntenna { name, .. }
        | GeometryEntryIR::CpwAntenna { name, .. } => Err(format!(
            "geometry '{}' (antenna layout) requires the conductor mesh planner; it is not an FDM magnetic body",
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
        | GeometryEntryIR::Sphere { .. }
        | GeometryEntryIR::Ellipsoid { .. }
        | GeometryEntryIR::Ellipse { .. }
        | GeometryEntryIR::Cone { .. }
        | GeometryEntryIR::Torus { .. }
        | GeometryEntryIR::PolygonPrism { .. }
        | GeometryEntryIR::SinWaveguide { .. }
        | GeometryEntryIR::ArchWaveguide { .. }
        | GeometryEntryIR::ImportedGeometry { .. }
        | GeometryEntryIR::Difference { .. }
        | GeometryEntryIR::Union { .. }
        | GeometryEntryIR::Intersection { .. }
        | GeometryEntryIR::Xor { .. }
        | GeometryEntryIR::Transform { .. }
        | GeometryEntryIR::SlicePlane { .. }
        | GeometryEntryIR::Array3D { .. } => Ok(PlacedGeometry {
            name: entry.name().to_string(),
            shape: ir_to_shape(entry)?,
            translation: [0.0, 0.0, 0.0],
        }),
        GeometryEntryIR::MicrostripAntenna { .. } | GeometryEntryIR::CpwAntenna { .. } => Err(
            format!(
                "geometry '{}' is not yet supported by the public multilayer planner; use Box/Cylinder/Difference with optional Translate",
                entry.name()
            ),
        ),
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
        GeometryShape::Sphere { radius } => Some(([-*radius; 3], [*radius; 3])),
        GeometryShape::Ellipsoid { radii } => Some(([-radii[0], -radii[1], -radii[2]], *radii)),
        GeometryShape::Ellipse { radii, height } => Some((
            [-radii[0], -radii[1], -height * 0.5],
            [radii[0], radii[1], height * 0.5],
        )),
        GeometryShape::Cone {
            radius_bottom,
            radius_top,
            height,
            axis,
        } => {
            let half_h = *height * 0.5;
            let mut bounds_min = [0.0; 3];
            let mut bounds_max = [0.0; 3];
            for index in 0..3 {
                let radial_proj = (1.0 - axis[index] * axis[index]).max(0.0).sqrt();
                let top_center = half_h * axis[index];
                let bot_center = -half_h * axis[index];
                bounds_min[index] = (top_center - *radius_top * radial_proj)
                    .min(bot_center - *radius_bottom * radial_proj);
                bounds_max[index] = (top_center + *radius_top * radial_proj)
                    .max(bot_center + *radius_bottom * radial_proj);
            }
            Some((bounds_min, bounds_max))
        }
        GeometryShape::Torus {
            major_radius,
            minor_radius,
            axis,
        } => {
            let extents = [0, 1, 2].map(|index| {
                let radial_proj = (1.0 - axis[index] * axis[index]).max(0.0).sqrt();
                *major_radius * radial_proj + *minor_radius
            });
            Some(([-extents[0], -extents[1], -extents[2]], extents))
        }
        GeometryShape::PolygonPrism {
            vertices_xy,
            thickness,
        } => {
            let first = *vertices_xy.first()?;
            let mut min_x = first[0];
            let mut max_x = first[0];
            let mut min_y = first[1];
            let mut max_y = first[1];
            for vertex in vertices_xy.iter().skip(1) {
                min_x = min_x.min(vertex[0]);
                max_x = max_x.max(vertex[0]);
                min_y = min_y.min(vertex[1]);
                max_y = max_y.max(vertex[1]);
            }
            let half_t = *thickness * 0.5;
            Some(([min_x, min_y, -half_t], [max_x, max_y, half_t]))
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
        GeometryShape::Union { a, b } | GeometryShape::Xor { left: a, right: b } => {
            let (a_min, a_max) = shape_local_bounds(a)?;
            let (b_min, b_max) = shape_local_bounds(b)?;
            Some((
                [
                    a_min[0].min(b_min[0]),
                    a_min[1].min(b_min[1]),
                    a_min[2].min(b_min[2]),
                ],
                [
                    a_max[0].max(b_max[0]),
                    a_max[1].max(b_max[1]),
                    a_max[2].max(b_max[2]),
                ],
            ))
        }
        GeometryShape::Intersection { a, b } => {
            let (a_min, a_max) = shape_local_bounds(a)?;
            let (b_min, b_max) = shape_local_bounds(b)?;
            let bounds_min = [
                a_min[0].max(b_min[0]),
                a_min[1].max(b_min[1]),
                a_min[2].max(b_min[2]),
            ];
            let bounds_max = [
                a_max[0].min(b_max[0]),
                a_max[1].min(b_max[1]),
                a_max[2].min(b_max[2]),
            ];
            if (0..3).any(|axis| bounds_max[axis] < bounds_min[axis]) {
                None
            } else {
                Some((bounds_min, bounds_max))
            }
        }
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
        GeometryShape::Transform {
            child,
            translation,
            rotation_quat,
            scale,
            pivot,
        } => {
            let (c_min, c_max) = shape_local_bounds(child)?;
            let mut out_min = [f64::INFINITY; 3];
            let mut out_max = [f64::NEG_INFINITY; 3];
            for ix in 0..2 {
                for iy in 0..2 {
                    for iz in 0..2 {
                        let corner = [
                            if ix == 0 { c_min[0] } else { c_max[0] },
                            if iy == 0 { c_min[1] } else { c_max[1] },
                            if iz == 0 { c_min[2] } else { c_max[2] },
                        ];
                        let world = apply_trs_forward(
                            corner,
                            *translation,
                            *rotation_quat,
                            *scale,
                            *pivot,
                        );
                        for axis in 0..3 {
                            out_min[axis] = out_min[axis].min(world[axis]);
                            out_max[axis] = out_max[axis].max(world[axis]);
                        }
                    }
                }
            }
            Some((out_min, out_max))
        }
        GeometryShape::SlicePlane {
            child,
            plane_origin,
            plane_normal,
            keep_side,
        } => {
            let (c_min, c_max) = shape_local_bounds(child)?;
            clip_aabb_by_plane(c_min, c_max, *plane_origin, *plane_normal, keep_side)
        }
        GeometryShape::Array3D { child, axes, .. } => {
            let (c_min, c_max) = shape_local_bounds(child)?;
            array_3d_local_bounds(c_min, c_max, axes)
        }
        GeometryShape::Imported { .. } => None,
    }
}

impl GeometryShape {
    pub(crate) fn compile(&self) -> Result<CompiledGeometryShape, SelectionError> {
        CompiledGeometryShape::from_shape(self)
    }

    fn to_geometry_entry(&self) -> GeometryEntryIR {
        match self {
            Self::Box { size } => GeometryEntryIR::Box {
                name: "fdm-canonical-box".to_string(),
                size: *size,
            },
            Self::Cylinder {
                radius,
                height,
                axis,
            } => GeometryEntryIR::Cylinder {
                name: "fdm-canonical-cylinder".to_string(),
                radius: *radius,
                height: *height,
                axis: *axis,
            },
            Self::Sphere { radius } => GeometryEntryIR::Sphere {
                name: "fdm-canonical-sphere".to_string(),
                radius: *radius,
            },
            Self::Ellipsoid { radii } => GeometryEntryIR::Ellipsoid {
                name: "fdm-canonical-ellipsoid".to_string(),
                radii: *radii,
            },
            Self::Ellipse { radii, height } => GeometryEntryIR::Ellipse {
                name: "fdm-ellipse".to_string(),
                radii: *radii,
                height: *height,
            },
            Self::Cone {
                radius_bottom,
                radius_top,
                height,
                axis,
            } => GeometryEntryIR::Cone {
                name: "fdm-cone".to_string(),
                radius_bottom: *radius_bottom,
                radius_top: *radius_top,
                height: *height,
                axis: *axis,
            },
            Self::Torus {
                major_radius,
                minor_radius,
                axis,
            } => GeometryEntryIR::Torus {
                name: "fdm-torus".to_string(),
                major_radius: *major_radius,
                minor_radius: *minor_radius,
                axis: *axis,
            },
            Self::PolygonPrism {
                vertices_xy,
                thickness,
            } => GeometryEntryIR::PolygonPrism {
                name: "fdm-polygon-prism".to_string(),
                vertices_xy: vertices_xy.clone(),
                thickness: *thickness,
            },
            Self::SinWaveguide {
                length,
                width,
                height,
                period,
                amplitude,
                phase,
                z0,
            } => GeometryEntryIR::SinWaveguide {
                name: "fdm-sin-waveguide".to_string(),
                length: *length,
                width: *width,
                height: *height,
                period: *period,
                amplitude: *amplitude,
                phase: *phase,
                z0: *z0,
            },
            Self::ArchWaveguide {
                length,
                width,
                height,
                arch_height,
                z0,
            } => GeometryEntryIR::ArchWaveguide {
                name: "fdm-arch-waveguide".to_string(),
                length: *length,
                width: *width,
                height: *height,
                arch_height: *arch_height,
                z0: *z0,
            },
            Self::Imported { source, format } => GeometryEntryIR::ImportedGeometry {
                name: "fdm-imported-geometry".to_string(),
                source: source.clone(),
                format: format.clone(),
                scale: Default::default(),
            },
            Self::Translate { child, by } => GeometryEntryIR::Translate {
                name: "fdm-canonical-translate".to_string(),
                base: Box::new(child.to_geometry_entry()),
                by: *by,
            },
            Self::Transform {
                child,
                translation,
                rotation_quat,
                scale,
                pivot,
            } => GeometryEntryIR::Transform {
                name: "fdm-canonical-transform".to_string(),
                child: Box::new(child.to_geometry_entry()),
                translation: *translation,
                rotation_quat: *rotation_quat,
                scale: *scale,
                pivot: *pivot,
            },
            Self::SlicePlane {
                child,
                plane_origin,
                plane_normal,
                keep_side,
            } => GeometryEntryIR::SlicePlane {
                name: "fdm-slice-plane".to_string(),
                child: Box::new(child.to_geometry_entry()),
                plane_origin: *plane_origin,
                plane_normal: *plane_normal,
                keep_side: keep_side.clone(),
            },
            Self::Difference { base, tool } => GeometryEntryIR::Difference {
                name: "fdm-canonical-difference".to_string(),
                base: Box::new(base.to_geometry_entry()),
                tool: Box::new(tool.to_geometry_entry()),
            },
            Self::Union { a, b } => GeometryEntryIR::Union {
                name: "fdm-canonical-union".to_string(),
                a: Box::new(a.to_geometry_entry()),
                b: Box::new(b.to_geometry_entry()),
            },
            Self::Intersection { a, b } => GeometryEntryIR::Intersection {
                name: "fdm-canonical-intersection".to_string(),
                a: Box::new(a.to_geometry_entry()),
                b: Box::new(b.to_geometry_entry()),
            },
            Self::Xor { left, right } => GeometryEntryIR::Xor {
                name: "fdm-canonical-xor".to_string(),
                left: Box::new(left.to_geometry_entry()),
                right: Box::new(right.to_geometry_entry()),
            },
            Self::Array3D {
                child,
                axes,
                merge_overlapping,
            } => GeometryEntryIR::Array3D {
                name: "fdm-array-3d".to_string(),
                child: Box::new(child.to_geometry_entry()),
                axes: axes.clone(),
                merge_overlapping: *merge_overlapping,
            },
        }
    }

    fn uses_custom_evaluator(&self) -> bool {
        match self {
            Self::SinWaveguide { .. }
            | Self::ArchWaveguide { .. }
            | Self::Ellipse { .. }
            | Self::Cone { .. }
            | Self::Torus { .. }
            | Self::PolygonPrism { .. }
            | Self::SlicePlane { .. }
            | Self::Array3D { .. } => true,
            Self::Translate { child, .. } | Self::Transform { child, .. } => {
                child.uses_custom_evaluator()
            }
            Self::Difference { base, tool }
            | Self::Union { a: base, b: tool }
            | Self::Intersection { a: base, b: tool }
            | Self::Xor {
                left: base,
                right: tool,
            } => base.uses_custom_evaluator() || tool.uses_custom_evaluator(),
            _ => false,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum CompiledGeometryShape {
    Canonical(GeometryPredicate),
    Ellipse {
        radii: [f64; 2],
        height: f64,
    },
    Cone {
        radius_bottom: f64,
        radius_top: f64,
        height: f64,
        axis: [f64; 3],
    },
    Torus {
        major_radius: f64,
        minor_radius: f64,
        axis: [f64; 3],
    },
    PolygonPrism {
        vertices_xy: Vec<[f64; 2]>,
        thickness: f64,
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
    Translate {
        child: Box<CompiledGeometryShape>,
        by: [f64; 3],
    },
    Transform {
        child: Box<CompiledGeometryShape>,
        translation: [f64; 3],
        rotation_quat: [f64; 4],
        scale: [f64; 3],
        pivot: [f64; 3],
    },
    SlicePlane {
        child: Box<CompiledGeometryShape>,
        plane_origin: [f64; 3],
        plane_normal: [f64; 3],
        keep_positive: bool,
    },
    Difference {
        base: Box<CompiledGeometryShape>,
        tool: Box<CompiledGeometryShape>,
    },
    Union {
        a: Box<CompiledGeometryShape>,
        b: Box<CompiledGeometryShape>,
    },
    Intersection {
        a: Box<CompiledGeometryShape>,
        b: Box<CompiledGeometryShape>,
    },
    Xor {
        left: Box<CompiledGeometryShape>,
        right: Box<CompiledGeometryShape>,
    },
    Array3D(Box<CompiledArray3D>),
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CompiledArray3D {
    child: CompiledGeometryShape,
    global_min: [f64; 3],
    global_max: [f64; 3],
    mode: CompiledArray3DMode,
}

#[derive(Debug, Clone, PartialEq)]
enum CompiledArray3DMode {
    InverseLattice {
        counts: [usize; 3],
        o_base: [f64; 3],
        child_center: [f64; 3],
        step_vectors: [[f64; 3]; 3],
        b_inv: [[f64; 3]; 3],
        lattice_half_extents: [f64; 3],
    },
    BoundedInstances {
        instances: Vec<CompiledArrayInstance>,
    },
}

#[derive(Debug, Clone, PartialEq)]
struct CompiledArrayInstance {
    aabb_min: [f64; 3],
    aabb_max: [f64; 3],
    translation: [f64; 3],
    rotation_quat: [f64; 4],
    scale: [f64; 3],
}

impl CompiledGeometryShape {
    fn from_shape(shape: &GeometryShape) -> Result<Self, SelectionError> {
        if !shape.uses_custom_evaluator() {
            return Ok(Self::Canonical(GeometryPredicate::from_geometry_entry(
                &shape.to_geometry_entry(),
                AffineTransform3::identity(),
                BoundaryMembership::inclusive(),
            )?));
        }
        match shape {
            GeometryShape::Ellipse { radii, height } => Ok(Self::Ellipse {
                radii: *radii,
                height: *height,
            }),
            GeometryShape::Cone {
                radius_bottom,
                radius_top,
                height,
                axis,
            } => Ok(Self::Cone {
                radius_bottom: *radius_bottom,
                radius_top: *radius_top,
                height: *height,
                axis: *axis,
            }),
            GeometryShape::Torus {
                major_radius,
                minor_radius,
                axis,
            } => Ok(Self::Torus {
                major_radius: *major_radius,
                minor_radius: *minor_radius,
                axis: *axis,
            }),
            GeometryShape::PolygonPrism {
                vertices_xy,
                thickness,
            } => Ok(Self::PolygonPrism {
                vertices_xy: vertices_xy.clone(),
                thickness: *thickness,
            }),
            GeometryShape::SinWaveguide {
                length,
                width,
                height,
                period,
                amplitude,
                phase,
                z0,
            } => Ok(Self::SinWaveguide {
                length: *length,
                width: *width,
                height: *height,
                period: *period,
                amplitude: *amplitude,
                phase: *phase,
                z0: *z0,
            }),
            GeometryShape::ArchWaveguide {
                length,
                width,
                height,
                arch_height,
                z0,
            } => Ok(Self::ArchWaveguide {
                length: *length,
                width: *width,
                height: *height,
                arch_height: *arch_height,
                z0: *z0,
            }),
            GeometryShape::Translate { child, by } => Ok(Self::Translate {
                child: Box::new(Self::from_shape(child)?),
                by: *by,
            }),
            GeometryShape::Transform {
                child,
                translation,
                rotation_quat,
                scale,
                pivot,
            } => Ok(Self::Transform {
                child: Box::new(Self::from_shape(child)?),
                translation: *translation,
                rotation_quat: *rotation_quat,
                scale: *scale,
                pivot: *pivot,
            }),
            GeometryShape::SlicePlane {
                child,
                plane_origin,
                plane_normal,
                keep_side,
            } => Ok(Self::SlicePlane {
                child: Box::new(Self::from_shape(child)?),
                plane_origin: *plane_origin,
                plane_normal: *plane_normal,
                keep_positive: keep_side != "negative",
            }),
            GeometryShape::Difference { base, tool } => Ok(Self::Difference {
                base: Box::new(Self::from_shape(base)?),
                tool: Box::new(Self::from_shape(tool)?),
            }),
            GeometryShape::Union { a, b } => Ok(Self::Union {
                a: Box::new(Self::from_shape(a)?),
                b: Box::new(Self::from_shape(b)?),
            }),
            GeometryShape::Intersection { a, b } => Ok(Self::Intersection {
                a: Box::new(Self::from_shape(a)?),
                b: Box::new(Self::from_shape(b)?),
            }),
            GeometryShape::Xor { left, right } => Ok(Self::Xor {
                left: Box::new(Self::from_shape(left)?),
                right: Box::new(Self::from_shape(right)?),
            }),
            GeometryShape::Array3D { child, axes, .. } => {
                Ok(Self::Array3D(Box::new(compile_array_3d(child, axes)?)))
            }
            _ => Ok(Self::Canonical(GeometryPredicate::from_geometry_entry(
                &shape.to_geometry_entry(),
                AffineTransform3::identity(),
                BoundaryMembership::inclusive(),
            )?)),
        }
    }

    pub(crate) fn contains(&self, point: [f64; 3]) -> Result<bool, SelectionError> {
        match self {
            Self::Canonical(predicate) => contains_point(predicate, point),
            Self::Ellipse { radii, height } => Ok(contains_ellipse(point, *radii, *height)),
            Self::Cone {
                radius_bottom,
                radius_top,
                height,
                axis,
            } => Ok(contains_cone(
                point,
                *radius_bottom,
                *radius_top,
                *height,
                *axis,
            )),
            Self::Torus {
                major_radius,
                minor_radius,
                axis,
            } => Ok(contains_torus(point, *major_radius, *minor_radius, *axis)),
            Self::PolygonPrism {
                vertices_xy,
                thickness,
            } => Ok(contains_polygon_prism(point, vertices_xy, *thickness)),
            Self::SinWaveguide {
                length,
                width,
                height,
                period,
                amplitude,
                phase,
                z0,
            } => Ok(contains_sin_waveguide(
                point[0], point[1], point[2], *length, *width, *height, *period, *amplitude,
                *phase, *z0,
            )),
            Self::ArchWaveguide {
                length,
                width,
                height,
                arch_height,
                z0,
            } => Ok(contains_arch_waveguide(
                point[0],
                point[1],
                point[2],
                *length,
                *width,
                *height,
                *arch_height,
                *z0,
            )),
            Self::Translate { child, by } => {
                child.contains([point[0] - by[0], point[1] - by[1], point[2] - by[2]])
            }
            Self::Transform {
                child,
                translation,
                rotation_quat,
                scale,
                pivot,
            } => {
                let local = apply_trs_inverse(
                    point,
                    *translation,
                    *rotation_quat,
                    *scale,
                    *pivot,
                );
                child.contains(local)
            }
            Self::SlicePlane {
                child,
                plane_origin,
                plane_normal,
                keep_positive,
            } => {
                let signed_dist = (point[0] - plane_origin[0]) * plane_normal[0]
                    + (point[1] - plane_origin[1]) * plane_normal[1]
                    + (point[2] - plane_origin[2]) * plane_normal[2];
                let side_ok = if *keep_positive {
                    signed_dist >= -1e-12
                } else {
                    signed_dist <= 1e-12
                };
                if !side_ok {
                    return Ok(false);
                }
                child.contains(point)
            }
            Self::Difference { base, tool } => Ok(base.contains(point)? && !tool.contains(point)?),
            Self::Union { a, b } => Ok(a.contains(point)? || b.contains(point)?),
            Self::Intersection { a, b } => Ok(a.contains(point)? && b.contains(point)?),
            Self::Xor { left, right } => Ok(left.contains(point)? ^ right.contains(point)?),
            Self::Array3D(compiled) => contains_array_3d(compiled, point),
        }
    }
}

fn normalize_array_axes(axes: &[ArrayAxisIR; 3]) -> Result<[ArrayAxisIR; 3], String> {
    let mut ordered: [Option<ArrayAxisIR>; 3] = [None, None, None];
    let mut total_instances: usize = 1;
    for (idx, ax) in axes.iter().enumerate() {
        let axis_idx = match ax.axis.trim().to_ascii_lowercase().as_str() {
            "x" => 0,
            "y" => 1,
            "z" => 2,
            other => {
                return Err(format!(
                    "Array3D axes[{idx}] has invalid axis '{other}' (expected x, y, or z)"
                ));
            }
        };
        if ordered[axis_idx].is_some() {
            return Err(format!("Array3D has duplicate axis '{}'", ax.axis));
        }
        if ax.count == 0 || ax.count > MAX_ARRAY_AXIS_COUNT {
            return Err(format!(
                "Array3D axis '{}' count ({}) must be in 1..={MAX_ARRAY_AXIS_COUNT}",
                ax.axis, ax.count
            ));
        }
        if !ax.pitch_m.is_finite()
            || !ax.relative_factor.is_finite()
            || !ax.gap_m.is_finite()
            || ax.step_translation_extra_m.iter().any(|v| !v.is_finite())
            || ax.step_rotation_euler_deg.iter().any(|v| !v.is_finite())
            || ax
                .step_scale_factor
                .iter()
                .any(|v| !v.is_finite() || *v <= 0.0)
        {
            return Err(format!(
                "Array3D axis '{}' contains non-finite or non-positive scale parameters",
                ax.axis
            ));
        }
        let eff = if ax.enabled { ax.count as usize } else { 1 };
        total_instances = total_instances
            .checked_mul(eff)
            .ok_or_else(|| "Array3D total instance count overflowed".to_string())?;
        if total_instances > MAX_ARRAY_INSTANCES_FDM {
            return Err(format!(
                "Array3D total instances ({total_instances}) exceeds MAX_ARRAY_INSTANCES_FDM ({MAX_ARRAY_INSTANCES_FDM})"
            ));
        }
        let mut normalized = ax.clone();
        normalized.axis = ["x", "y", "z"][axis_idx].to_string();
        ordered[axis_idx] = Some(normalized);
    }
    Ok([
        ordered[0]
            .take()
            .ok_or_else(|| "Array3D is missing 'x' axis".to_string())?,
        ordered[1]
            .take()
            .ok_or_else(|| "Array3D is missing 'y' axis".to_string())?,
        ordered[2]
            .take()
            .ok_or_else(|| "Array3D is missing 'z' axis".to_string())?,
    ])
}

fn array_axis_effective_count_and_kmin(ax: &ArrayAxisIR) -> (usize, f64, f64) {
    let n = if ax.enabled { ax.count.max(1) as usize } else { 1 };
    if n <= 1 {
        return (1, 0.0, 0.0);
    }
    let span = (n - 1) as f64;
    match ax.direction {
        ArrayDirectionIR::Positive => (n, 0.0, span),
        ArrayDirectionIR::Negative => (n, -span, 0.0),
        ArrayDirectionIR::Symmetric => (n, -0.5 * span, 0.5 * span),
    }
}

fn array_axis_step_vector(ax: &ArrayAxisIR, axis_idx: usize, child_extent: [f64; 3]) -> [f64; 3] {
    let delta = match ax.spacing_mode {
        ArraySpacingModeIR::LatticeStep => ax.pitch_m,
        ArraySpacingModeIR::BoundingBoxGap => ax.relative_factor * child_extent[axis_idx] + ax.gap_m,
    };
    let mut v = ax.step_translation_extra_m;
    v[axis_idx] += delta;
    v
}

fn array_has_step_rot_or_scale(axes: &[ArrayAxisIR; 3]) -> bool {
    axes.iter().any(|ax| {
        ax.enabled
            && ax.count > 1
            && (ax.step_rotation_euler_deg.iter().any(|v| v.abs() > 1e-12)
                || ax
                    .step_scale_factor
                    .iter()
                    .any(|v| (*v - 1.0).abs() > 1e-12))
    })
}

fn euler_xyz_deg_to_quat_plan(euler_xyz_deg: [f64; 3]) -> [f64; 4] {
    let (sx, cx) = (euler_xyz_deg[0].to_radians() * 0.5).sin_cos();
    let (sy, cy) = (euler_xyz_deg[1].to_radians() * 0.5).sin_cos();
    let (sz, cz) = (euler_xyz_deg[2].to_radians() * 0.5).sin_cos();
    let qx = sx * cy * cz - cx * sy * sz;
    let qy = cx * sy * cz + sx * cy * sz;
    let qz = cx * cy * sz - sx * sy * cz;
    let qw = cx * cy * cz + sx * sy * sz;
    let norm = (qx * qx + qy * qy + qz * qz + qw * qw).sqrt();
    if norm > 1e-12 {
        [qx / norm, qy / norm, qz / norm, qw / norm]
    } else {
        [0.0, 0.0, 0.0, 1.0]
    }
}

fn array_3d_local_bounds(
    child_min: [f64; 3],
    child_max: [f64; 3],
    axes: &[ArrayAxisIR; 3],
) -> Option<([f64; 3], [f64; 3])> {
    let child_extent = [
        child_max[0] - child_min[0],
        child_max[1] - child_min[1],
        child_max[2] - child_min[2],
    ];
    let step_vectors = [
        array_axis_step_vector(&axes[0], 0, child_extent),
        array_axis_step_vector(&axes[1], 1, child_extent),
        array_axis_step_vector(&axes[2], 2, child_extent),
    ];
    let (n0, k0_min, k0_max) = array_axis_effective_count_and_kmin(&axes[0]);
    let (n1, k1_min, k1_max) = array_axis_effective_count_and_kmin(&axes[1]);
    let (n2, k2_min, k2_max) = array_axis_effective_count_and_kmin(&axes[2]);
    let total = n0.checked_mul(n1)?.checked_mul(n2)?;
    if total > MAX_ARRAY_INSTANCES_FDM {
        return None;
    }

    if !array_has_step_rot_or_scale(axes) {
        let mut t_min = [0.0; 3];
        let mut t_max = [0.0; 3];
        let k_ranges = [(k0_min, k0_max), (k1_min, k1_max), (k2_min, k2_max)];
        for a in 0..3 {
            let (k_lo, k_hi) = k_ranges[a];
            for j in 0..3 {
                let p_lo = k_lo * step_vectors[a][j];
                let p_hi = k_hi * step_vectors[a][j];
                t_min[j] += p_lo.min(p_hi);
                t_max[j] += p_lo.max(p_hi);
            }
        }
        return Some((
            [
                child_min[0] + t_min[0],
                child_min[1] + t_min[1],
                child_min[2] + t_min[2],
            ],
            [
                child_max[0] + t_max[0],
                child_max[1] + t_max[1],
                child_max[2] + t_max[2],
            ],
        ));
    }

    let mut out_min = [f64::INFINITY; 3];
    let mut out_max = [f64::NEG_INFINITY; 3];
    for m0 in 0..n0 {
        let k0 = k0_min + m0 as f64;
        for m1 in 0..n1 {
            let k1 = k1_min + m1 as f64;
            for m2 in 0..n2 {
                let k2 = k2_min + m2 as f64;
                let ks = [k0, k1, k2];
                let (t, q, s) = array_instance_trs(axes, &step_vectors, ks);
                for ix in 0..2 {
                    for iy in 0..2 {
                        for iz in 0..2 {
                            let corner = [
                                if ix == 0 { child_min[0] } else { child_max[0] },
                                if iy == 0 { child_min[1] } else { child_max[1] },
                                if iz == 0 { child_min[2] } else { child_max[2] },
                            ];
                            let w = apply_trs_forward(corner, t, q, s, [0.0, 0.0, 0.0]);
                            for j in 0..3 {
                                out_min[j] = out_min[j].min(w[j]);
                                out_max[j] = out_max[j].max(w[j]);
                            }
                        }
                    }
                }
            }
        }
    }
    if out_min.iter().all(|v| v.is_finite()) && out_max.iter().all(|v| v.is_finite()) {
        Some((out_min, out_max))
    } else {
        None
    }
}

fn array_instance_trs(
    axes: &[ArrayAxisIR; 3],
    step_vectors: &[[f64; 3]; 3],
    ks: [f64; 3],
) -> ([f64; 3], [f64; 4], [f64; 3]) {
    let mut t = [0.0; 3];
    let mut rot_deg = [0.0; 3];
    let mut scale = [1.0; 3];
    for a in 0..3 {
        let k = ks[a];
        if k == 0.0 {
            continue;
        }
        for j in 0..3 {
            t[j] += k * step_vectors[a][j];
            rot_deg[j] += k * axes[a].step_rotation_euler_deg[j];
            let sf = axes[a].step_scale_factor[j];
            if (sf - 1.0).abs() > 1e-15 {
                scale[j] *= sf.powf(k);
            }
        }
    }
    let quat = euler_xyz_deg_to_quat_plan(rot_deg);
    (t, quat, scale)
}

fn vec3_dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn vec3_cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn vec3_norm(v: [f64; 3]) -> f64 {
    vec3_dot(v, v).sqrt()
}

fn try_build_inverse_lattice_basis(
    counts: [usize; 3],
    step_vectors: [[f64; 3]; 3],
) -> Option<[[f64; 3]; 3]> {
    let mut columns = [[0.0; 3]; 3];
    let mut active_orthonormal: Vec<[f64; 3]> = Vec::with_capacity(3);
    for a in 0..3 {
        if counts[a] > 1 {
            let v = step_vectors[a];
            let norm = vec3_norm(v);
            if !norm.is_finite() || norm <= 1e-15 {
                return None;
            }
            columns[a] = v;
            // Gram-Schmidt check that active vectors are linearly independent
            let mut orth = [v[0] / norm, v[1] / norm, v[2] / norm];
            for prev in &active_orthonormal {
                let proj = vec3_dot(orth, *prev);
                orth = [
                    orth[0] - proj * prev[0],
                    orth[1] - proj * prev[1],
                    orth[2] - proj * prev[2],
                ];
            }
            let orth_norm = vec3_norm(orth);
            if !orth_norm.is_finite() || orth_norm <= 1e-9 {
                return None;
            }
            active_orthonormal.push([
                orth[0] / orth_norm,
                orth[1] / orth_norm,
                orth[2] / orth_norm,
            ]);
        }
    }
    // Complete inactive axes (N_a == 1) with orthonormal Gram-Schmidt vectors
    let canonical = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    for a in 0..3 {
        if counts[a] <= 1 {
            let mut chosen = None;
            for shift in 0..3 {
                let mut cand = canonical[(a + shift) % 3];
                for prev in &active_orthonormal {
                    let proj = vec3_dot(cand, *prev);
                    cand = [
                        cand[0] - proj * prev[0],
                        cand[1] - proj * prev[1],
                        cand[2] - proj * prev[2],
                    ];
                }
                let n = vec3_norm(cand);
                if n.is_finite() && n > 1e-6 {
                    let unit = [cand[0] / n, cand[1] / n, cand[2] / n];
                    active_orthonormal.push(unit);
                    chosen = Some(unit);
                    break;
                }
            }
            columns[a] = chosen?;
        }
    }
    let c0 = columns[0];
    let c1 = columns[1];
    let c2 = columns[2];
    let r0 = vec3_cross(c1, c2);
    let r1 = vec3_cross(c2, c0);
    let r2 = vec3_cross(c0, c1);
    let det = vec3_dot(c0, r0);
    let norm_prod = vec3_norm(c0) * vec3_norm(c1) * vec3_norm(c2);
    if !det.is_finite() || !norm_prod.is_finite() || norm_prod <= 1e-45 || det.abs() <= 1e-12 * norm_prod {
        return None;
    }
    Some([
        [r0[0] / det, r0[1] / det, r0[2] / det],
        [r1[0] / det, r1[1] / det, r1[2] / det],
        [r2[0] / det, r2[1] / det, r2[2] / det],
    ])
}

fn compile_array_3d(
    child: &GeometryShape,
    axes: &[ArrayAxisIR; 3],
) -> Result<CompiledArray3D, SelectionError> {
    let (child_min, child_max) = shape_local_bounds(child).ok_or_else(|| {
        SelectionError::new(
            "array_3d_unbounded_child",
            "Array3D child geometry must have finite local bounds",
        )
    })?;
    let (global_min, global_max) = array_3d_local_bounds(child_min, child_max, axes).ok_or_else(|| {
        SelectionError::new(
            "array_3d_bounds_invalid",
            "Array3D failed to compute finite bounds or exceeded instance budget",
        )
    })?;
    let child_extent = [
        child_max[0] - child_min[0],
        child_max[1] - child_min[1],
        child_max[2] - child_min[2],
    ];
    let child_center = [
        0.5 * (child_min[0] + child_max[0]),
        0.5 * (child_min[1] + child_max[1]),
        0.5 * (child_min[2] + child_max[2]),
    ];
    let child_half = [
        0.5 * child_extent[0],
        0.5 * child_extent[1],
        0.5 * child_extent[2],
    ];
    let step_vectors = [
        array_axis_step_vector(&axes[0], 0, child_extent),
        array_axis_step_vector(&axes[1], 1, child_extent),
        array_axis_step_vector(&axes[2], 2, child_extent),
    ];
    let (n0, k0_min, _) = array_axis_effective_count_and_kmin(&axes[0]);
    let (n1, k1_min, _) = array_axis_effective_count_and_kmin(&axes[1]);
    let (n2, k2_min, _) = array_axis_effective_count_and_kmin(&axes[2]);
    let counts = [n0, n1, n2];
    let total = n0
        .checked_mul(n1)
        .and_then(|v| v.checked_mul(n2))
        .ok_or_else(|| {
            SelectionError::new(
                "array_3d_count_overflow",
                "Array3D instance count overflowed",
            )
        })?;
    let compiled_child = CompiledGeometryShape::from_shape(child)?;

    if !array_has_step_rot_or_scale(axes) {
        if let Some(b_inv) = try_build_inverse_lattice_basis(counts, step_vectors) {
            let o_base = [
                k0_min * step_vectors[0][0]
                    + k1_min * step_vectors[1][0]
                    + k2_min * step_vectors[2][0],
                k0_min * step_vectors[0][1]
                    + k1_min * step_vectors[1][1]
                    + k2_min * step_vectors[2][1],
                k0_min * step_vectors[0][2]
                    + k1_min * step_vectors[1][2]
                    + k2_min * step_vectors[2][2],
            ];
            let lattice_half_extents = [0, 1, 2].map(|a| {
                b_inv[a][0].abs() * child_half[0]
                    + b_inv[a][1].abs() * child_half[1]
                    + b_inv[a][2].abs() * child_half[2]
                    + 1e-9
            });
            return Ok(CompiledArray3D {
                child: compiled_child,
                global_min,
                global_max,
                mode: CompiledArray3DMode::InverseLattice {
                    counts,
                    o_base,
                    child_center,
                    step_vectors,
                    b_inv,
                    lattice_half_extents,
                },
            });
        }
        if total > MAX_ARRAY_FDM_CANDIDATES_PER_QUERY {
            return Err(SelectionError::new(
                "array_3d_degenerate_basis",
                format!(
                    "Array3D lattice has degenerate/collinear step vectors with {total} instances (> {MAX_ARRAY_FDM_CANDIDATES_PER_QUERY} candidate budget)"
                ),
            ));
        }
    } else if total > MAX_ARRAY_INSTANCES_FEM_OCC {
        return Err(SelectionError::new(
            "array_3d_step_transform_budget_exceeded",
            format!(
                "Array3D with step rotation/scale has {total} instances (exceeds {MAX_ARRAY_INSTANCES_FEM_OCC} bounded instance limit)"
            ),
        ));
    }

    let mut instances = Vec::with_capacity(total);
    for m0 in 0..n0 {
        let k0 = k0_min + m0 as f64;
        for m1 in 0..n1 {
            let k1 = k1_min + m1 as f64;
            for m2 in 0..n2 {
                let k2 = k2_min + m2 as f64;
                let (t, q, s) = array_instance_trs(axes, &step_vectors, [k0, k1, k2]);
                let mut aabb_min = [f64::INFINITY; 3];
                let mut aabb_max = [f64::NEG_INFINITY; 3];
                for ix in 0..2 {
                    for iy in 0..2 {
                        for iz in 0..2 {
                            let corner = [
                                if ix == 0 { child_min[0] } else { child_max[0] },
                                if iy == 0 { child_min[1] } else { child_max[1] },
                                if iz == 0 { child_min[2] } else { child_max[2] },
                            ];
                            let w = apply_trs_forward(corner, t, q, s, [0.0, 0.0, 0.0]);
                            for j in 0..3 {
                                aabb_min[j] = aabb_min[j].min(w[j]);
                                aabb_max[j] = aabb_max[j].max(w[j]);
                            }
                        }
                    }
                }
                instances.push(CompiledArrayInstance {
                    aabb_min,
                    aabb_max,
                    translation: t,
                    rotation_quat: q,
                    scale: s,
                });
            }
        }
    }

    Ok(CompiledArray3D {
        child: compiled_child,
        global_min,
        global_max,
        mode: CompiledArray3DMode::BoundedInstances { instances },
    })
}

fn contains_array_3d(compiled: &CompiledArray3D, point: [f64; 3]) -> Result<bool, SelectionError> {
    let eps = 1e-12;
    if (0..3).any(|j| point[j] < compiled.global_min[j] - eps || point[j] > compiled.global_max[j] + eps) {
        return Ok(false);
    }
    match &compiled.mode {
        CompiledArray3DMode::InverseLattice {
            counts,
            o_base,
            child_center,
            step_vectors,
            b_inv,
            lattice_half_extents,
        } => {
            let u = [
                point[0] - o_base[0] - child_center[0],
                point[1] - o_base[1] - child_center[1],
                point[2] - o_base[2] - child_center[2],
            ];
            let mut lo = [0usize; 3];
            let mut hi = [0usize; 3];
            for a in 0..3 {
                let xi = b_inv[a][0] * u[0] + b_inv[a][1] * u[1] + b_inv[a][2] * u[2];
                let r = lattice_half_extents[a];
                if counts[a] <= 1 {
                    if xi.abs() > r {
                        return Ok(false);
                    }
                    lo[a] = 0;
                    hi[a] = 0;
                } else {
                    let max_idx = (counts[a] - 1) as f64;
                    let f_lo = (xi - r).ceil();
                    let f_hi = (xi + r).floor();
                    if f_hi < 0.0 || f_lo > max_idx {
                        return Ok(false);
                    }
                    lo[a] = f_lo.max(0.0) as usize;
                    hi[a] = f_hi.min(max_idx) as usize;
                    if lo[a] > hi[a] {
                        return Ok(false);
                    }
                }
            }
            let candidates = (hi[0] - lo[0] + 1)
                .checked_mul(hi[1] - lo[1] + 1)
                .and_then(|v| v.checked_mul(hi[2] - lo[2] + 1));
            if candidates.is_none() || candidates.unwrap() > MAX_ARRAY_FDM_CANDIDATES_PER_QUERY {
                return Err(SelectionError::new(
                    "array_3d_candidate_budget_exceeded",
                    format!(
                        "Array3D query exceeded per-query candidate budget ({MAX_ARRAY_FDM_CANDIDATES_PER_QUERY}); lattice spacing is too dense relative to child bounds"
                    ),
                ));
            }
            for m0 in lo[0]..=hi[0] {
                let m0f = m0 as f64;
                for m1 in lo[1]..=hi[1] {
                    let m1f = m1 as f64;
                    for m2 in lo[2]..=hi[2] {
                        let m2f = m2 as f64;
                        let local = [
                            point[0]
                                - (o_base[0]
                                    + m0f * step_vectors[0][0]
                                    + m1f * step_vectors[1][0]
                                    + m2f * step_vectors[2][0]),
                            point[1]
                                - (o_base[1]
                                    + m0f * step_vectors[0][1]
                                    + m1f * step_vectors[1][1]
                                    + m2f * step_vectors[2][1]),
                            point[2]
                                - (o_base[2]
                                    + m0f * step_vectors[0][2]
                                    + m1f * step_vectors[1][2]
                                    + m2f * step_vectors[2][2]),
                        ];
                        if compiled.child.contains(local)? {
                            return Ok(true);
                        }
                    }
                }
            }
            Ok(false)
        }
        CompiledArray3DMode::BoundedInstances { instances } => {
            let mut tested = 0usize;
            for inst in instances {
                if (0..3).any(|j| point[j] < inst.aabb_min[j] - eps || point[j] > inst.aabb_max[j] + eps) {
                    continue;
                }
                tested += 1;
                if tested > MAX_ARRAY_FDM_CANDIDATES_PER_QUERY {
                    return Err(SelectionError::new(
                        "array_3d_candidate_budget_exceeded",
                        format!(
                            "Array3D query exceeded per-query candidate budget ({MAX_ARRAY_FDM_CANDIDATES_PER_QUERY})"
                        ),
                    ));
                }
                let local = apply_trs_inverse(
                    point,
                    inst.translation,
                    inst.rotation_quat,
                    inst.scale,
                    [0.0, 0.0, 0.0],
                );
                if compiled.child.contains(local)? {
                    return Ok(true);
                }
            }
            Ok(false)
        }
    }
}

fn rotate_vec3_by_quat(v: [f64; 3], q: [f64; 4]) -> [f64; 3] {
    let [qx, qy, qz, qw] = q;
    let tx = 2.0 * (qy * v[2] - qz * v[1]);
    let ty = 2.0 * (qz * v[0] - qx * v[2]);
    let tz = 2.0 * (qx * v[1] - qy * v[0]);
    [
        v[0] + qw * tx + (qy * tz - qz * ty),
        v[1] + qw * ty + (qz * tx - qx * tz),
        v[2] + qw * tz + (qx * ty - qy * tx),
    ]
}

fn apply_trs_forward(
    p: [f64; 3],
    translation: [f64; 3],
    rotation_quat: [f64; 4],
    scale: [f64; 3],
    pivot: [f64; 3],
) -> [f64; 3] {
    let scaled = [
        (p[0] - pivot[0]) * scale[0],
        (p[1] - pivot[1]) * scale[1],
        (p[2] - pivot[2]) * scale[2],
    ];
    let rotated = rotate_vec3_by_quat(scaled, rotation_quat);
    [
        rotated[0] + pivot[0] + translation[0],
        rotated[1] + pivot[1] + translation[1],
        rotated[2] + pivot[2] + translation[2],
    ]
}

fn apply_trs_inverse(
    p: [f64; 3],
    translation: [f64; 3],
    rotation_quat: [f64; 4],
    scale: [f64; 3],
    pivot: [f64; 3],
) -> [f64; 3] {
    let shifted = [
        p[0] - translation[0] - pivot[0],
        p[1] - translation[1] - pivot[1],
        p[2] - translation[2] - pivot[2],
    ];
    let inv_quat = [
        -rotation_quat[0],
        -rotation_quat[1],
        -rotation_quat[2],
        rotation_quat[3],
    ];
    let unrotated = rotate_vec3_by_quat(shifted, inv_quat);
    [
        unrotated[0] / scale[0] + pivot[0],
        unrotated[1] / scale[1] + pivot[1],
        unrotated[2] / scale[2] + pivot[2],
    ]
}

fn clip_aabb_by_plane(
    min: [f64; 3],
    max: [f64; 3],
    plane_origin: [f64; 3],
    plane_normal: [f64; 3],
    keep_side: &str,
) -> Option<([f64; 3], [f64; 3])> {
    let sign = if keep_side == "negative" { -1.0 } else { 1.0 };
    let corners = [
        [min[0], min[1], min[2]],
        [max[0], min[1], min[2]],
        [min[0], max[1], min[2]],
        [max[0], max[1], min[2]],
        [min[0], min[1], max[2]],
        [max[0], min[1], max[2]],
        [min[0], max[1], max[2]],
        [max[0], max[1], max[2]],
    ];
    let dists = corners.map(|c| {
        sign * ((c[0] - plane_origin[0]) * plane_normal[0]
            + (c[1] - plane_origin[1]) * plane_normal[1]
            + (c[2] - plane_origin[2]) * plane_normal[2])
    });
    let edges: [(usize, usize); 12] = [
        (0, 1), (2, 3), (4, 5), (6, 7),
        (0, 2), (1, 3), (4, 6), (5, 7),
        (0, 4), (1, 5), (2, 6), (3, 7),
    ];
    let mut kept_points = Vec::with_capacity(16);
    for (index, corner) in corners.iter().enumerate() {
        if dists[index] >= -1e-12 {
            kept_points.push(*corner);
        }
    }
    for (u, v) in edges {
        let du = dists[u];
        let dv = dists[v];
        if (du < 0.0 && dv > 0.0) || (du > 0.0 && dv < 0.0) {
            let t = du / (du - dv);
            let a = corners[u];
            let b = corners[v];
            kept_points.push([
                a[0] + t * (b[0] - a[0]),
                a[1] + t * (b[1] - a[1]),
                a[2] + t * (b[2] - a[2]),
            ]);
        }
    }
    if kept_points.is_empty() {
        return None;
    }
    let mut out_min = [f64::INFINITY; 3];
    let mut out_max = [f64::NEG_INFINITY; 3];
    for p in kept_points {
        for axis in 0..3 {
            out_min[axis] = out_min[axis].min(p[axis]);
            out_max[axis] = out_max[axis].max(p[axis]);
        }
    }
    if (0..3).any(|axis| out_max[axis] <= out_min[axis] + 1e-18) {
        return None;
    }
    Some((out_min, out_max))
}

fn contains_ellipse(point: [f64; 3], radii: [f64; 2], height: f64) -> bool {
    let half_h = height * 0.5;
    if point[2].abs() > half_h * (1.0 + 1e-12) {
        return false;
    }
    let nx = point[0] / radii[0];
    let ny = point[1] / radii[1];
    nx * nx + ny * ny <= 1.0 + 1e-12
}

fn contains_cone(
    point: [f64; 3],
    radius_bottom: f64,
    radius_top: f64,
    height: f64,
    axis: [f64; 3],
) -> bool {
    let half_h = height * 0.5;
    let tol = 1e-12 * height.max(radius_bottom.max(radius_top)).max(1.0e-12);
    let h_proj = point[0] * axis[0] + point[1] * axis[1] + point[2] * axis[2];
    if h_proj < -half_h - tol || h_proj > half_h + tol {
        return false;
    }
    let t = ((h_proj + half_h) / height).clamp(0.0, 1.0);
    let local_r = radius_bottom + t * (radius_top - radius_bottom);
    let p_sq = point[0] * point[0] + point[1] * point[1] + point[2] * point[2];
    let radial_sq = (p_sq - h_proj * h_proj).max(0.0);
    let limit = local_r + tol;
    radial_sq <= limit * limit
}

fn contains_torus(
    point: [f64; 3],
    major_radius: f64,
    minor_radius: f64,
    axis: [f64; 3],
) -> bool {
    let tol = 1e-12 * major_radius.max(1.0e-12);
    let z_proj = point[0] * axis[0] + point[1] * axis[1] + point[2] * axis[2];
    let p_sq = point[0] * point[0] + point[1] * point[1] + point[2] * point[2];
    let rho = (p_sq - z_proj * z_proj).max(0.0).sqrt();
    let dr = rho - major_radius;
    let limit = minor_radius + tol;
    dr * dr + z_proj * z_proj <= limit * limit
}

fn contains_polygon_prism(point: [f64; 3], vertices_xy: &[[f64; 2]], thickness: f64) -> bool {
    if vertices_xy.len() < 3 {
        return false;
    }
    let half_t = thickness * 0.5;
    if point[2].abs() > half_t * (1.0 + 1e-12) {
        return false;
    }
    let px = point[0];
    let py = point[1];
    let n = vertices_xy.len();
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let [xi, yi] = vertices_xy[i];
        let [xj, yj] = vertices_xy[j];
        let dx = xj - xi;
        let dy = yj - yi;
        let edge_len_sq = dx * dx + dy * dy;
        if edge_len_sq > 0.0 {
            let t = (((px - xi) * dx + (py - yi) * dy) / edge_len_sq).clamp(0.0, 1.0);
            let cx = xi + t * dx;
            let cy = yi + t * dy;
            let dist_sq = (px - cx) * (px - cx) + (py - cy) * (py - cy);
            if dist_sq <= 1e-24 * edge_len_sq.max(1.0e-18) {
                return true;
            }
        }
        let intersects = ((yi > py) != (yj > py))
            && (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
        if intersects {
            inside = !inside;
        }
        j = i;
    }
    inside
}

fn compile_shape_for_mask(
    shape: &GeometryShape,
    errors: &mut Vec<String>,
) -> Option<CompiledGeometryShape> {
    match shape.compile() {
        Ok(predicate) => Some(predicate),
        Err(error) => {
            errors.push(error.to_string());
            None
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
                return (
                    bbox,
                    None,
                    [nx, ny, nz],
                    [-bbox[0] * 0.5, -bbox[1] * 0.5, -bbox[2] * 0.5],
                );
            };
            let bounds_min = [-bbox[0] * 0.5, -bbox[1] * 0.5, -bbox[2] * 0.5];
            let mut mask = vec![false; n];
            let Some(predicate) = compile_shape_for_mask(shape, errors) else {
                return (bbox, None, [nx, ny, nz], bounds_min);
            };
            for z in 0..nz {
                for y in 0..ny {
                    for x in 0..nx {
                        let point = [
                            bounds_min[0] + (x as f64 + 0.5) * cell_size[0],
                            bounds_min[1] + (y as f64 + 0.5) * cell_size[1],
                            bounds_min[2] + (z as f64 + 0.5) * cell_size[2],
                        ];
                        let idx = (x + nx * (y + ny * z)) as usize;
                        mask[idx] = match predicate.contains(point) {
                            Ok(inside) => inside,
                            Err(error) => {
                                errors.push(error.to_string());
                                return (bbox, None, [nx, ny, nz], bounds_min);
                            }
                        };
                    }
                }
            }
            (bbox, Some(mask), [nx, ny, nz], bounds_min)
        }
        GeometryShape::Sphere { radius } => {
            let bbox = [2.0 * *radius; 3];
            let grid_cells = [
                (bbox[0] / cell_size[0]).round().max(1.0) as u32,
                (bbox[1] / cell_size[1]).round().max(1.0) as u32,
                (bbox[2] / cell_size[2]).round().max(1.0) as u32,
            ];
            let Some(n) = checked_voxel_count(grid_cells, errors) else {
                return (bbox, None, grid_cells, [-*radius; 3]);
            };
            let mut mask = vec![false; n];
            let Some(predicate) = compile_shape_for_mask(shape, errors) else {
                return (bbox, None, grid_cells, [-*radius; 3]);
            };
            for z in 0..grid_cells[2] {
                for y in 0..grid_cells[1] {
                    for x in 0..grid_cells[0] {
                        let point = [
                            -*radius + (x as f64 + 0.5) * cell_size[0],
                            -*radius + (y as f64 + 0.5) * cell_size[1],
                            -*radius + (z as f64 + 0.5) * cell_size[2],
                        ];
                        let index = (x + grid_cells[0] * (y + grid_cells[1] * z)) as usize;
                        mask[index] = match predicate.contains(point) {
                            Ok(inside) => inside,
                            Err(error) => {
                                errors.push(error.to_string());
                                return (bbox, None, grid_cells, [-*radius; 3]);
                            }
                        };
                    }
                }
            }
            (bbox, Some(mask), grid_cells, [-*radius; 3])
        }
        GeometryShape::Ellipsoid { radii } => {
            let bbox = [2.0 * radii[0], 2.0 * radii[1], 2.0 * radii[2]];
            let bounds_min = [-radii[0], -radii[1], -radii[2]];
            let grid_cells = [
                (bbox[0] / cell_size[0]).round().max(1.0) as u32,
                (bbox[1] / cell_size[1]).round().max(1.0) as u32,
                (bbox[2] / cell_size[2]).round().max(1.0) as u32,
            ];
            let Some(n) = checked_voxel_count(grid_cells, errors) else {
                return (bbox, None, grid_cells, bounds_min);
            };
            let mut mask = vec![false; n];
            let Some(predicate) = compile_shape_for_mask(shape, errors) else {
                return (bbox, None, grid_cells, bounds_min);
            };
            for z in 0..grid_cells[2] {
                for y in 0..grid_cells[1] {
                    for x in 0..grid_cells[0] {
                        let point = [
                            bounds_min[0] + (x as f64 + 0.5) * cell_size[0],
                            bounds_min[1] + (y as f64 + 0.5) * cell_size[1],
                            bounds_min[2] + (z as f64 + 0.5) * cell_size[2],
                        ];
                        let index = (x + grid_cells[0] * (y + grid_cells[1] * z)) as usize;
                        mask[index] = match predicate.contains(point) {
                            Ok(inside) => inside,
                            Err(error) => {
                                errors.push(error.to_string());
                                return (bbox, None, grid_cells, bounds_min);
                            }
                        };
                    }
                }
            }
            (bbox, Some(mask), grid_cells, bounds_min)
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
            let Some(predicate) = compile_shape_for_mask(shape, errors) else {
                return (bbox, None, [nx, ny, nz], bounds_min);
            };
            for z in 0..nz {
                for y in 0..ny {
                    for x in 0..nx {
                        let point = [
                            bounds_min[0] + (x as f64 + 0.5) * cell_size[0],
                            bounds_min[1] + (y as f64 + 0.5) * cell_size[1],
                            bounds_min[2] + (z as f64 + 0.5) * cell_size[2],
                        ];
                        let idx = (x + nx * (y + ny * z)) as usize;
                        mask[idx] = match predicate.contains(point) {
                            Ok(inside) => inside,
                            Err(error) => {
                                errors.push(error.to_string());
                                return (bbox, None, [nx, ny, nz], bounds_min);
                            }
                        };
                    }
                }
            }

            (bbox, Some(mask), [nx, ny, nz], bounds_min)
        }
        GeometryShape::Translate { .. }
        | GeometryShape::Transform { .. }
        | GeometryShape::SlicePlane { .. }
        | GeometryShape::Ellipse { .. }
        | GeometryShape::Cone { .. }
        | GeometryShape::Torus { .. }
        | GeometryShape::PolygonPrism { .. }
        | GeometryShape::Union { .. }
        | GeometryShape::Intersection { .. }
        | GeometryShape::Xor { .. }
        | GeometryShape::Array3D { .. } => {
            let Some((bounds_min, bounds_max)) = shape_local_bounds(shape) else {
                errors.push(
                    "fdm_empty_geometry_bounds: CSG/sliced/transformed geometry has empty or unbounded support"
                        .to_string(),
                );
                return ([1.0, 1.0, 1.0], Some(vec![false]), [1, 1, 1], [-0.5, -0.5, -0.5]);
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
            let Some(predicate) = compile_shape_for_mask(shape, errors) else {
                return (bbox, None, [nx, ny, nz], bounds_min);
            };
            for z in 0..nz {
                for y in 0..ny {
                    for x in 0..nx {
                        let point = [
                            bounds_min[0] + (x as f64 + 0.5) * cell_size[0],
                            bounds_min[1] + (y as f64 + 0.5) * cell_size[1],
                            bounds_min[2] + (z as f64 + 0.5) * cell_size[2],
                        ];
                        let idx = (x + nx * (y + ny * z)) as usize;
                        mask[idx] = match predicate.contains(point) {
                            Ok(inside) => inside,
                            Err(error) => {
                                errors.push(error.to_string());
                                return (bbox, None, [nx, ny, nz], bounds_min);
                            }
                        };
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
    if hints
        .cell
        .iter()
        .all(|component| *component > 0.0 && component.is_finite())
    {
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

pub(crate) fn cell_for_magnet(hints: &FdmHintsIR, magnet_name: &str) -> Result<[f64; 3], String> {
    if let Some(cell) = hints
        .per_magnet
        .as_ref()
        .and_then(|per_magnet| per_magnet.get(magnet_name))
        .map(|grid| grid.cell)
    {
        return Ok(cell);
    }
    if hints.default_cell.is_none()
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

#[cfg(test)]
mod canonical_membership_tests {
    use super::*;
    use crate::selection::geometry::{
        geometry_entry_compilation_count, reset_geometry_entry_compilation_count,
    };

    #[test]
    fn geometry_shape_membership_uses_canonical_result_semantics() {
        let shape = ir_to_shape(&GeometryEntryIR::Difference {
            name: "difference".to_string(),
            base: Box::new(GeometryEntryIR::Box {
                name: "base".to_string(),
                size: [4.0; 3],
            }),
            tool: Box::new(GeometryEntryIR::Translate {
                name: "tool".to_string(),
                base: Box::new(GeometryEntryIR::Sphere {
                    name: "sphere".to_string(),
                    radius: 1.0,
                }),
                by: [1.0, 0.0, 0.0],
            }),
        })
        .unwrap();
        let predicate = shape.compile().unwrap();
        assert!(predicate.contains([-1.5, 0.0, 0.0]).unwrap());
        assert!(!predicate.contains([1.0, 0.0, 0.0]).unwrap());

        let imported = ir_to_shape(&GeometryEntryIR::ImportedGeometry {
            name: "imported".to_string(),
            source: "body.stl".to_string(),
            format: "stl".to_string(),
            scale: Default::default(),
        })
        .unwrap();
        assert_eq!(
            imported.compile().unwrap_err().code(),
            "selection_imported_solid_unqualified"
        );
    }

    #[test]
    fn voxelization_compiles_one_predicate_for_multiple_samples() {
        let shape = ir_to_shape(&GeometryEntryIR::Difference {
            name: "difference".to_string(),
            base: Box::new(GeometryEntryIR::Box {
                name: "base".to_string(),
                size: [4.0; 3],
            }),
            tool: Box::new(GeometryEntryIR::Sphere {
                name: "tool".to_string(),
                radius: 1.0,
            }),
        })
        .unwrap();
        reset_geometry_entry_compilation_count();

        let (_, mask, cells, _) = voxelize_shape(&shape, [1.0; 3], &mut Vec::new());

        assert_eq!(cells, [4; 3]);
        assert_eq!(mask.unwrap().len(), 64);
        assert_eq!(geometry_entry_compilation_count(), 1);
    }

    #[test]
    fn nested_translate_difference_preserves_sin_and_arch_waveguides() {
        let shape = ir_to_shape(&GeometryEntryIR::Translate {
            name: "translated".to_string(),
            base: Box::new(GeometryEntryIR::Difference {
                name: "difference".to_string(),
                base: Box::new(GeometryEntryIR::SinWaveguide {
                    name: "sin".to_string(),
                    length: 4.0,
                    width: 2.0,
                    height: 2.0,
                    period: 4.0,
                    amplitude: 0.0,
                    phase: 0.0,
                    z0: 0.0,
                }),
                tool: Box::new(GeometryEntryIR::ArchWaveguide {
                    name: "arch".to_string(),
                    length: 2.0,
                    width: 1.0,
                    height: 1.0,
                    arch_height: 0.0,
                    z0: 0.0,
                }),
            }),
            by: [10.0, 0.0, 0.0],
        })
        .unwrap();
        let predicate = shape.compile().unwrap();

        assert!(predicate.contains([11.5, 0.0, 0.0]).unwrap());
        assert!(!predicate.contains([10.0, 0.0, 0.0]).unwrap());
    }
}
