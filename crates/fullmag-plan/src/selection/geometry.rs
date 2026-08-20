use std::fmt;

#[cfg(test)]
use std::cell::Cell;

use fullmag_ir::{GeometryEntryIR, ObjectRegionIR, RegionFrameIR, RegionShapeIR};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AffineTransform3 {
    pub translation_m: [f64; 3],
    pub rotation_xyzw: [f64; 4],
    pub scale: [f64; 3],
    pub pivot_m: [f64; 3],
}

impl AffineTransform3 {
    pub const fn identity() -> Self {
        Self {
            translation_m: [0.0; 3],
            rotation_xyzw: [0.0, 0.0, 0.0, 1.0],
            scale: [1.0; 3],
            pivot_m: [0.0; 3],
        }
    }
}

impl Default for AffineTransform3 {
    fn default() -> Self {
        Self::identity()
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BoundaryMembership {
    Inclusive {
        absolute_tolerance_m: f64,
        relative_tolerance: f64,
    },
    Exclusive {
        absolute_tolerance_m: f64,
        relative_tolerance: f64,
    },
}

impl BoundaryMembership {
    pub const fn inclusive() -> Self {
        Self::Inclusive {
            absolute_tolerance_m: 0.0,
            relative_tolerance: 1.0e-12,
        }
    }

    fn tolerance(self, characteristic_length_m: f64) -> Result<f64, SelectionError> {
        let (absolute, relative) = match self {
            Self::Inclusive {
                absolute_tolerance_m,
                relative_tolerance,
            }
            | Self::Exclusive {
                absolute_tolerance_m,
                relative_tolerance,
            } => (absolute_tolerance_m, relative_tolerance),
        };
        if !absolute.is_finite() || absolute < 0.0 || !relative.is_finite() || relative < 0.0 {
            return Err(SelectionError::invalid_geometry(
                "boundary tolerances must be finite and non-negative",
            ));
        }
        Ok(absolute + relative * characteristic_length_m.abs())
    }

    fn upper_contains(self, value: f64, limit: f64) -> Result<bool, SelectionError> {
        let tolerance = self.tolerance(limit)?;
        Ok(match self {
            Self::Inclusive { .. } => value <= limit + tolerance,
            Self::Exclusive { .. } => value < (limit - tolerance).max(0.0),
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SelectionError {
    code: &'static str,
    message: String,
}

impl SelectionError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn invalid_geometry(message: impl Into<String>) -> Self {
        Self::new("selection_invalid_geometry", message)
    }

    pub fn code(&self) -> &'static str {
        self.code
    }
}

impl fmt::Display for SelectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for SelectionError {}

#[derive(Debug, Clone, PartialEq)]
pub struct GeometryPredicate {
    geometry: GeometryNode,
    transform: AffineTransform3,
    boundary: BoundaryMembership,
}

#[derive(Debug, Clone, PartialEq)]
enum GeometryNode {
    Box {
        size_m: [f64; 3],
        center_m: [f64; 3],
    },
    Cylinder {
        radius_m: f64,
        height_m: f64,
        center_m: [f64; 3],
        axis: [f64; 3],
    },
    Sphere {
        radius_m: f64,
        center_m: [f64; 3],
    },
    Union(Box<GeometryNode>, Box<GeometryNode>),
    Intersection(Box<GeometryNode>, Box<GeometryNode>),
    Difference(Box<GeometryNode>, Box<GeometryNode>),
    Affine {
        geometry: Box<GeometryNode>,
        transform: AffineTransform3,
    },
}

impl GeometryPredicate {
    pub(crate) fn from_geometry_entry(
        entry: &GeometryEntryIR,
        transform: AffineTransform3,
        boundary: BoundaryMembership,
    ) -> Result<Self, SelectionError> {
        #[cfg(test)]
        GEOMETRY_ENTRY_COMPILATIONS.with(|count| count.set(count.get() + 1));
        Ok(Self {
            geometry: node_from_geometry_entry(entry)?,
            transform,
            boundary,
        })
    }

    pub fn from_object_region(
        region: &ObjectRegionIR,
        object_transform: AffineTransform3,
        boundary: BoundaryMembership,
    ) -> Result<Self, SelectionError> {
        let geometry = match &region.shape {
            RegionShapeIR::Box { size, center } => GeometryNode::Box {
                size_m: *size,
                center_m: *center,
            },
            RegionShapeIR::Cylinder {
                radius,
                height,
                center,
                axis,
            } => GeometryNode::Cylinder {
                radius_m: *radius,
                height_m: *height,
                center_m: *center,
                axis: normalize_axis(*axis)?,
            },
            RegionShapeIR::Sphere { radius, center } => GeometryNode::Sphere {
                radius_m: *radius,
                center_m: *center,
            },
            RegionShapeIR::Csg { expression } => node_from_geometry_entry(expression)?,
        };
        validate_node(&geometry)?;
        Ok(Self {
            geometry,
            transform: match region.frame {
                RegionFrameIR::Object => object_transform,
                RegionFrameIR::World => AffineTransform3::identity(),
            },
            boundary,
        })
    }
}

#[cfg(test)]
thread_local! {
    static GEOMETRY_ENTRY_COMPILATIONS: Cell<usize> = const { Cell::new(0) };
}

#[cfg(test)]
pub(crate) fn reset_geometry_entry_compilation_count() {
    GEOMETRY_ENTRY_COMPILATIONS.with(|count| count.set(0));
}

#[cfg(test)]
pub(crate) fn geometry_entry_compilation_count() -> usize {
    GEOMETRY_ENTRY_COMPILATIONS.with(Cell::get)
}

pub(crate) fn contains_point(
    predicate: &GeometryPredicate,
    world_point_m: [f64; 3],
) -> Result<bool, SelectionError> {
    if world_point_m.iter().any(|component| !component.is_finite()) {
        return Err(SelectionError::invalid_geometry(
            "geometry membership point must contain finite coordinates",
        ));
    }
    let local_point = inverse_transform(world_point_m, predicate.transform)?;
    contains_local(&predicate.geometry, local_point, predicate.boundary)
}

pub fn evaluate_geometry_predicate(
    predicate: &GeometryPredicate,
    world_point_m: [f64; 3],
) -> Result<bool, SelectionError> {
    contains_point(predicate, world_point_m)
}

pub(crate) fn geometry_entry_bounds(
    entry: &GeometryEntryIR,
) -> Result<([f64; 3], [f64; 3]), SelectionError> {
    node_bounds(&node_from_geometry_entry(entry)?)
}

fn node_from_geometry_entry(entry: &GeometryEntryIR) -> Result<GeometryNode, SelectionError> {
    let node = match entry {
        GeometryEntryIR::Box { size, .. } => GeometryNode::Box {
            size_m: *size,
            center_m: [0.0; 3],
        },
        GeometryEntryIR::Cylinder {
            radius,
            height,
            axis,
            ..
        } => GeometryNode::Cylinder {
            radius_m: *radius,
            height_m: *height,
            center_m: [0.0; 3],
            axis: normalize_axis(*axis)?,
        },
        GeometryEntryIR::Sphere { radius, .. } => GeometryNode::Sphere {
            radius_m: *radius,
            center_m: [0.0; 3],
        },
        GeometryEntryIR::Union { a, b, .. } => GeometryNode::Union(
            Box::new(node_from_geometry_entry(a)?),
            Box::new(node_from_geometry_entry(b)?),
        ),
        GeometryEntryIR::Intersection { a, b, .. } => GeometryNode::Intersection(
            Box::new(node_from_geometry_entry(a)?),
            Box::new(node_from_geometry_entry(b)?),
        ),
        GeometryEntryIR::Difference { base, tool, .. } => GeometryNode::Difference(
            Box::new(node_from_geometry_entry(base)?),
            Box::new(node_from_geometry_entry(tool)?),
        ),
        GeometryEntryIR::Translate { base, by, .. } => GeometryNode::Affine {
            geometry: Box::new(node_from_geometry_entry(base)?),
            transform: AffineTransform3 {
                translation_m: *by,
                ..AffineTransform3::identity()
            },
        },
        GeometryEntryIR::ImportedGeometry { name, .. } => {
            return Err(SelectionError::new(
                "selection_imported_solid_unqualified",
                format!(
                "geometry '{name}' is imported and has no qualified analytic occupancy evaluator"
            ),
            ))
        }
        other => {
            return Err(SelectionError::new(
                "selection_variant_unsupported",
                format!(
                    "geometry '{}' uses an unsupported analytic predicate variant",
                    other.name()
                ),
            ))
        }
    };
    validate_node(&node)?;
    Ok(node)
}

fn validate_node(node: &GeometryNode) -> Result<(), SelectionError> {
    match node {
        GeometryNode::Box { size_m, center_m } => {
            require_finite(center_m, "box center")?;
            if size_m
                .iter()
                .any(|value| !value.is_finite() || *value <= 0.0)
            {
                return Err(SelectionError::invalid_geometry(
                    "box size must contain finite positive values",
                ));
            }
        }
        GeometryNode::Cylinder {
            radius_m,
            height_m,
            center_m,
            axis,
        } => {
            require_finite(center_m, "cylinder center")?;
            require_finite(axis, "cylinder axis")?;
            if !radius_m.is_finite()
                || *radius_m <= 0.0
                || !height_m.is_finite()
                || *height_m <= 0.0
            {
                return Err(SelectionError::invalid_geometry(
                    "cylinder radius and height must be finite and positive",
                ));
            }
        }
        GeometryNode::Sphere { radius_m, center_m } => {
            require_finite(center_m, "sphere center")?;
            if !radius_m.is_finite() || *radius_m <= 0.0 {
                return Err(SelectionError::invalid_geometry(
                    "sphere radius must be finite and positive",
                ));
            }
        }
        GeometryNode::Union(a, b)
        | GeometryNode::Intersection(a, b)
        | GeometryNode::Difference(a, b) => {
            validate_node(a)?;
            validate_node(b)?;
        }
        GeometryNode::Affine {
            geometry,
            transform,
        } => {
            validate_transform_components(*transform)?;
            validate_node(geometry)?;
        }
    }
    Ok(())
}

fn contains_local(
    node: &GeometryNode,
    point: [f64; 3],
    boundary: BoundaryMembership,
) -> Result<bool, SelectionError> {
    match node {
        GeometryNode::Box { size_m, center_m } => {
            contains_box_point(*size_m, *center_m, point, boundary)
        }
        GeometryNode::Cylinder {
            radius_m,
            height_m,
            center_m,
            axis,
        } => contains_cylinder_point(*radius_m, *height_m, *center_m, *axis, point, boundary),
        GeometryNode::Sphere { radius_m, center_m } => {
            contains_sphere_point(*radius_m, *center_m, point, boundary)
        }
        GeometryNode::Union(a, b) => {
            Ok(contains_local(a, point, boundary)? || contains_local(b, point, boundary)?)
        }
        GeometryNode::Intersection(a, b) => {
            Ok(contains_local(a, point, boundary)? && contains_local(b, point, boundary)?)
        }
        GeometryNode::Difference(base, tool) => {
            Ok(contains_local(base, point, boundary)? && !contains_local(tool, point, boundary)?)
        }
        GeometryNode::Affine {
            geometry,
            transform,
        } => contains_local(geometry, inverse_transform(point, *transform)?, boundary),
    }
}

fn node_bounds(node: &GeometryNode) -> Result<([f64; 3], [f64; 3]), SelectionError> {
    match node {
        GeometryNode::Box { size_m, center_m } => Ok((
            std::array::from_fn(|axis| center_m[axis] - 0.5 * size_m[axis]),
            std::array::from_fn(|axis| center_m[axis] + 0.5 * size_m[axis]),
        )),
        GeometryNode::Cylinder {
            radius_m,
            height_m,
            center_m,
            axis,
        } => {
            let half_height = 0.5 * height_m;
            let extents: [f64; 3] = std::array::from_fn(|index| {
                half_height * axis[index].abs()
                    + radius_m * (1.0 - axis[index] * axis[index]).max(0.0).sqrt()
            });
            Ok((
                std::array::from_fn(|index| center_m[index] - extents[index]),
                std::array::from_fn(|index| center_m[index] + extents[index]),
            ))
        }
        GeometryNode::Sphere { radius_m, center_m } => Ok((
            std::array::from_fn(|axis| center_m[axis] - radius_m),
            std::array::from_fn(|axis| center_m[axis] + radius_m),
        )),
        GeometryNode::Union(a, b) => {
            let (a_min, a_max) = node_bounds(a)?;
            let (b_min, b_max) = node_bounds(b)?;
            Ok((
                std::array::from_fn(|axis| a_min[axis].min(b_min[axis])),
                std::array::from_fn(|axis| a_max[axis].max(b_max[axis])),
            ))
        }
        GeometryNode::Intersection(a, b) => {
            let (a_min, a_max) = node_bounds(a)?;
            let (b_min, b_max) = node_bounds(b)?;
            let bounds_min = std::array::from_fn(|axis| a_min[axis].max(b_min[axis]));
            let bounds_max = std::array::from_fn(|axis| a_max[axis].min(b_max[axis]));
            if (0..3).any(|axis| bounds_max[axis] < bounds_min[axis]) {
                return Err(SelectionError::invalid_geometry(
                    "CSG intersection has disjoint analytic operand bounds",
                ));
            }
            Ok((bounds_min, bounds_max))
        }
        GeometryNode::Difference(base, _) => node_bounds(base),
        GeometryNode::Affine {
            geometry,
            transform,
        } => {
            let (bounds_min, bounds_max) = node_bounds(geometry)?;
            transformed_bounds(bounds_min, bounds_max, *transform)
        }
    }
}

fn transformed_bounds(
    bounds_min: [f64; 3],
    bounds_max: [f64; 3],
    transform: AffineTransform3,
) -> Result<([f64; 3], [f64; 3]), SelectionError> {
    validate_transform_components(transform)?;
    if transform.scale.contains(&0.0) {
        return Err(SelectionError::new(
            "selection_singular_transform",
            "affine transform scale must be invertible",
        ));
    }
    let Some(rotation) = stable_unit(transform.rotation_xyzw) else {
        return Err(SelectionError::new(
            "selection_singular_transform",
            "affine transform quaternion must be invertible",
        ));
    };
    let mut transformed_min = [f64::INFINITY; 3];
    let mut transformed_max = [f64::NEG_INFINITY; 3];
    for x in [bounds_min[0], bounds_max[0]] {
        for y in [bounds_min[1], bounds_max[1]] {
            for z in [bounds_min[2], bounds_max[2]] {
                let local = [x, y, z];
                let scaled = std::array::from_fn(|axis| {
                    (local[axis] - transform.pivot_m[axis]) * transform.scale[axis]
                });
                let rotated = rotate_by_unit_quaternion(scaled, rotation);
                let world: [f64; 3] = std::array::from_fn(|axis| {
                    transform.pivot_m[axis] + rotated[axis] + transform.translation_m[axis]
                });
                for axis in 0..3 {
                    transformed_min[axis] = transformed_min[axis].min(world[axis]);
                    transformed_max[axis] = transformed_max[axis].max(world[axis]);
                }
            }
        }
    }
    Ok((transformed_min, transformed_max))
}

pub(crate) fn contains_box_point(
    size_m: [f64; 3],
    center_m: [f64; 3],
    point: [f64; 3],
    boundary: BoundaryMembership,
) -> Result<bool, SelectionError> {
    (0..3)
        .map(|axis| {
            boundary.upper_contains((point[axis] - center_m[axis]).abs(), 0.5 * size_m[axis])
        })
        .try_fold(true, |inside, current| Ok(inside && current?))
}

pub(crate) fn contains_cylinder_point(
    radius_m: f64,
    height_m: f64,
    center_m: [f64; 3],
    normalized_axis: [f64; 3],
    point: [f64; 3],
    boundary: BoundaryMembership,
) -> Result<bool, SelectionError> {
    let relative = sub(point, center_m);
    let axial = dot(relative, normalized_axis);
    if !boundary.upper_contains(axial.abs(), 0.5 * height_m)? {
        return Ok(false);
    }
    let radial = sub(relative, scale(normalized_axis, axial));
    boundary.upper_contains(dot(radial, radial).sqrt(), radius_m)
}

pub(crate) fn contains_sphere_point(
    radius_m: f64,
    center_m: [f64; 3],
    point: [f64; 3],
    boundary: BoundaryMembership,
) -> Result<bool, SelectionError> {
    let relative = sub(point, center_m);
    boundary.upper_contains(dot(relative, relative).sqrt(), radius_m)
}

fn inverse_transform(
    world_point_m: [f64; 3],
    transform: AffineTransform3,
) -> Result<[f64; 3], SelectionError> {
    validate_transform_components(transform)?;
    if transform.scale.iter().any(|component| *component == 0.0) {
        return Err(SelectionError::new(
            "selection_singular_transform",
            "affine transform scale must be invertible",
        ));
    }
    let Some(unit_rotation) = stable_unit(transform.rotation_xyzw) else {
        return Err(SelectionError::new(
            "selection_singular_transform",
            "affine transform quaternion must be invertible",
        ));
    };
    let inverse_rotation = [
        -unit_rotation[0],
        -unit_rotation[1],
        -unit_rotation[2],
        unit_rotation[3],
    ];
    let shifted = sub(
        sub(world_point_m, transform.translation_m),
        transform.pivot_m,
    );
    let rotated = rotate_by_unit_quaternion(shifted, inverse_rotation);
    Ok([
        rotated[0] / transform.scale[0] + transform.pivot_m[0],
        rotated[1] / transform.scale[1] + transform.pivot_m[1],
        rotated[2] / transform.scale[2] + transform.pivot_m[2],
    ])
}

fn validate_transform_components(transform: AffineTransform3) -> Result<(), SelectionError> {
    require_finite(&transform.translation_m, "affine translation")?;
    require_finite(&transform.rotation_xyzw, "affine quaternion")?;
    require_finite(&transform.scale, "affine scale")?;
    require_finite(&transform.pivot_m, "affine pivot")?;
    Ok(())
}

pub(crate) fn normalize_axis(axis: [f64; 3]) -> Result<[f64; 3], SelectionError> {
    require_finite(&axis, "cylinder axis")?;
    let Some(unit) = stable_unit(axis) else {
        return Err(SelectionError::invalid_geometry(
            "cylinder axis must be non-zero",
        ));
    };
    Ok(unit)
}

fn stable_unit<const N: usize>(value: [f64; N]) -> Option<[f64; N]> {
    let largest = value
        .iter()
        .map(|component| component.abs())
        .fold(0.0_f64, f64::max);
    if largest == 0.0 {
        return None;
    }
    let scaled_norm = value
        .iter()
        .map(|component| (component / largest).powi(2))
        .sum::<f64>()
        .sqrt();
    Some(value.map(|component| component / largest / scaled_norm))
}

fn require_finite(values: &[f64], description: &str) -> Result<(), SelectionError> {
    if values.iter().any(|value| !value.is_finite()) {
        return Err(SelectionError::invalid_geometry(format!(
            "{description} must contain finite values"
        )));
    }
    Ok(())
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn scale(value: [f64; 3], factor: f64) -> [f64; 3] {
    [value[0] * factor, value[1] * factor, value[2] * factor]
}

fn rotate_by_unit_quaternion(point: [f64; 3], quaternion_xyzw: [f64; 4]) -> [f64; 3] {
    let vector = [
        quaternion_xyzw[1] * point[2] - quaternion_xyzw[2] * point[1],
        quaternion_xyzw[2] * point[0] - quaternion_xyzw[0] * point[2],
        quaternion_xyzw[0] * point[1] - quaternion_xyzw[1] * point[0],
    ];
    let doubled = scale(vector, 2.0);
    let cross_again = [
        quaternion_xyzw[1] * doubled[2] - quaternion_xyzw[2] * doubled[1],
        quaternion_xyzw[2] * doubled[0] - quaternion_xyzw[0] * doubled[2],
        quaternion_xyzw[0] * doubled[1] - quaternion_xyzw[1] * doubled[0],
    ];
    [
        point[0] + quaternion_xyzw[3] * doubled[0] + cross_again[0],
        point[1] + quaternion_xyzw[3] * doubled[1] + cross_again[1],
        point[2] + quaternion_xyzw[3] * doubled[2] + cross_again[2],
    ]
}
