//! Private representability checks for the waveguide's rounded world coordinates.
//!
//! This descriptor binds only the exact validated Dirichlet and frame borrows.
//! It is not a 3D mesh, geometric-equivalence, invariance, provider, or solver
//! admission certificate.

use crate::floating_point_guard::require_ieee_gradual_underflow;
use crate::waveguide_frame::ValidatedWaveguideFrameIR;
use crate::waveguide_mesh_dirichlet::ValidatedFiniteAirDirichletBindings;
use crate::waveguide_mesh_elements::WAVEGUIDE_TRIANGLE_QUALITY_ROUNDOFF_THRESHOLD;
use crate::waveguide_mesh_embedding::exact_binary64_integer;
use num_bigint::{BigInt, Sign};
use std::collections::BTreeMap;
use std::{error::Error, fmt};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CanonicalFrameValueField {
    Origin,
    Eu,
    Ev,
    Axis,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WorldCoordinateOperation {
    UProduct,
    VProduct,
    OriginPlusU,
    AddV,
}

/// Failures while proving the rounded world representation is numerically usable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum WaveguideWorldMappingError {
    UnsupportedFloatingPointEnvironment {
        doubled_min_subnormal_bits: u64,
        halved_min_positive_bits: u64,
    },
    EmptyWorldNodeSet,
    EmptyTriangleSet,
    NonFiniteCanonicalFrameComponent {
        field: CanonicalFrameValueField,
        component: usize,
    },
    NonFiniteInputNodeCoordinate {
        node_index: usize,
        coordinate_index: usize,
    },
    NonFiniteWorldArithmetic {
        node_index: usize,
        coordinate_index: usize,
        operation: WorldCoordinateOperation,
    },
    DuplicateWorldNodeCoordinates {
        first_node_index: usize,
        duplicate_node_index: usize,
    },
    NonFiniteWorldNodeCoordinate {
        node_index: usize,
        coordinate_index: usize,
    },
    NonFiniteProjectionDiagnostic {
        node_index: usize,
    },
    NonFinitePlaneDeviation {
        node_index: usize,
    },
    TriangleNodeIndexNotRepresentable {
        triangle_index: usize,
        node_slot: usize,
        node_index: u64,
    },
    TriangleNodeIndexOutOfBounds {
        triangle_index: usize,
        node_slot: usize,
        node_index: usize,
    },
    NonFiniteEdgeDifference {
        triangle_index: usize,
        edge_index: usize,
        coordinate_index: usize,
    },
    NonFiniteEdgeLength {
        triangle_index: usize,
        edge_index: usize,
    },
    NonFiniteNormalizedEdge {
        triangle_index: usize,
        edge_index: usize,
        coordinate_index: usize,
    },
    NormalizedEdgeComponentUnderflow {
        triangle_index: usize,
        edge_index: usize,
        coordinate_index: usize,
    },
    NonFiniteScaledNormal {
        triangle_index: usize,
    },
    NonPositiveScaledNormal {
        triangle_index: usize,
    },
    NonFiniteQualityDenominator {
        triangle_index: usize,
    },
    NonFiniteTriangleQuality {
        triangle_index: usize,
    },
    TriangleQualityAtOrBelowRoundoffThreshold {
        triangle_index: usize,
    },
    NonPositiveRoundedWorldOrientation {
        triangle_index: usize,
    },
    NonRepresentableNormalizedArea {
        triangle_index: usize,
    },
    NonRepresentablePhysicalArea {
        triangle_index: usize,
    },
    NonRepresentableMassEntry {
        triangle_index: usize,
        row: usize,
        column: usize,
    },
    NonFiniteScaledGradient {
        triangle_index: usize,
        local_node_index: usize,
        coordinate_index: usize,
    },
    NonFinitePhysicalGradient {
        triangle_index: usize,
        local_node_index: usize,
        coordinate_index: usize,
    },
    PhysicalGradientComponentUnderflow {
        triangle_index: usize,
        local_node_index: usize,
        coordinate_index: usize,
    },
    NonFiniteDimensionlessStiffness {
        triangle_index: usize,
        row: usize,
        column: usize,
    },
}

impl fmt::Display for WaveguideWorldMappingError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "waveguide world mapping error: {self:?}")
    }
}

impl Error for WaveguideWorldMappingError {}

/// Borrowed S09 world-coordinate representability evidence.
///
/// The fields stay private and the type has no deserializer or constructor. This
/// local prerequisite does not certify geometric equivalence or FEM admission.
#[derive(Debug)]
pub(crate) struct ValidatedWaveguideWorldMapping<'d, 'b, 'i, 'f> {
    dirichlet: &'d ValidatedFiniteAirDirichletBindings<'b, 'i>,
    frame: &'f ValidatedWaveguideFrameIR,
    world_nodes_m: Vec<[f64; 3]>,
    minimum_triangle_quality: f64,
    minimum_triangle_area_m2: f64,
    minimum_positive_mass_entry_m2: f64,
    maximum_gradient_norm_per_m: f64,
    maximum_projection_error_m: f64,
    maximum_plane_deviation_m: f64,
}

impl<'d, 'b, 'i, 'f> ValidatedWaveguideWorldMapping<'d, 'b, 'i, 'f> {
    pub(crate) fn dirichlet(&self) -> &'d ValidatedFiniteAirDirichletBindings<'b, 'i> {
        self.dirichlet
    }

    pub(crate) fn frame(&self) -> &'f ValidatedWaveguideFrameIR {
        self.frame
    }

    pub(crate) fn world_nodes_m(&self) -> &[[f64; 3]] {
        &self.world_nodes_m
    }

    pub(crate) fn minimum_triangle_quality(&self) -> f64 {
        self.minimum_triangle_quality
    }

    pub(crate) fn minimum_triangle_area_m2(&self) -> f64 {
        self.minimum_triangle_area_m2
    }

    pub(crate) fn minimum_positive_mass_entry_m2(&self) -> f64 {
        self.minimum_positive_mass_entry_m2
    }

    pub(crate) fn maximum_gradient_norm_per_m(&self) -> f64 {
        self.maximum_gradient_norm_per_m
    }

    pub(crate) fn maximum_projection_error_m(&self) -> f64 {
        self.maximum_projection_error_m
    }

    pub(crate) fn maximum_plane_deviation_m(&self) -> f64 {
        self.maximum_plane_deviation_m
    }
}

/// Check representability using only the mesh tied to the validated Dirichlet
/// token and the canonical values in the validated frame.
pub(crate) fn validate_waveguide_world_mapping<'d, 'b, 'i, 'f>(
    dirichlet: &'d ValidatedFiniteAirDirichletBindings<'b, 'i>,
    frame: &'f ValidatedWaveguideFrameIR,
) -> Result<ValidatedWaveguideWorldMapping<'d, 'b, 'i, 'f>, WaveguideWorldMappingError> {
    require_ieee_gradual_underflow().map_err(|error| {
        WaveguideWorldMappingError::UnsupportedFloatingPointEnvironment {
            doubled_min_subnormal_bits: error.doubled_min_subnormal_bits,
            halved_min_positive_bits: error.halved_min_positive_bits,
        }
    })?;

    let canonical = frame.canonical();
    let origin = canonical.origin_m();
    let e_u = canonical.e_u();
    let e_v = canonical.e_v();
    let axis = canonical.axis_unit();
    let mesh = dirichlet.registry().mesh();
    let geometry = validate_world_geometry(
        &mesh.nodes_uv_m,
        mesh.triangles.iter().map(|triangle| &triangle.nodes),
        origin,
        e_u,
        e_v,
        axis,
    )?;

    Ok(ValidatedWaveguideWorldMapping {
        dirichlet,
        frame,
        world_nodes_m: geometry.world_nodes_m,
        minimum_triangle_quality: geometry.minimum_triangle_quality,
        minimum_triangle_area_m2: geometry.minimum_triangle_area_m2,
        minimum_positive_mass_entry_m2: geometry.minimum_positive_mass_entry_m2,
        maximum_gradient_norm_per_m: geometry.maximum_gradient_norm_per_m,
        maximum_projection_error_m: geometry.maximum_projection_error_m,
        maximum_plane_deviation_m: geometry.maximum_plane_deviation_m,
    })
}

#[derive(Debug)]
struct WorldGeometry {
    world_nodes_m: Vec<[f64; 3]>,
    minimum_triangle_quality: f64,
    minimum_triangle_area_m2: f64,
    minimum_positive_mass_entry_m2: f64,
    maximum_gradient_norm_per_m: f64,
    maximum_projection_error_m: f64,
    maximum_plane_deviation_m: f64,
}

fn validate_world_geometry<'t, I>(
    nodes_uv_m: &[[f64; 2]],
    triangles: I,
    origin: [f64; 3],
    e_u: [f64; 3],
    e_v: [f64; 3],
    axis: [f64; 3],
) -> Result<WorldGeometry, WaveguideWorldMappingError>
where
    I: IntoIterator<Item = &'t [u64; 3]>,
{
    use WaveguideWorldMappingError as E;

    if nodes_uv_m.is_empty() {
        return Err(E::EmptyWorldNodeSet);
    }

    let world_nodes_m = map_world_nodes(nodes_uv_m, origin, e_u, e_v)?;
    reject_duplicate_world_nodes(&world_nodes_m)?;
    let (maximum_projection_error_m, maximum_plane_deviation_m) =
        measure_frame_diagnostics(nodes_uv_m, &world_nodes_m, origin, e_u, e_v, axis)?;
    let element_metrics = validate_world_triangles(&world_nodes_m, triangles, axis)?;

    Ok(WorldGeometry {
        world_nodes_m,
        minimum_triangle_quality: element_metrics.minimum_triangle_quality,
        minimum_triangle_area_m2: element_metrics.minimum_triangle_area_m2,
        minimum_positive_mass_entry_m2: element_metrics.minimum_positive_mass_entry_m2,
        maximum_gradient_norm_per_m: element_metrics.maximum_gradient_norm_per_m,
        maximum_projection_error_m,
        maximum_plane_deviation_m,
    })
}

fn validate_finite_frame_vector(
    values: [f64; 3],
    field: CanonicalFrameValueField,
) -> Result<(), WaveguideWorldMappingError> {
    for (component, value) in values.iter().copied().enumerate() {
        if !value.is_finite() {
            return Err(
                WaveguideWorldMappingError::NonFiniteCanonicalFrameComponent { field, component },
            );
        }
    }
    Ok(())
}

fn map_world_nodes(
    nodes_uv_m: &[[f64; 2]],
    origin: [f64; 3],
    e_u: [f64; 3],
    e_v: [f64; 3],
) -> Result<Vec<[f64; 3]>, WaveguideWorldMappingError> {
    use CanonicalFrameValueField as F;
    use WaveguideWorldMappingError as E;
    use WorldCoordinateOperation as O;

    validate_finite_frame_vector(origin, F::Origin)?;
    validate_finite_frame_vector(e_u, F::Eu)?;
    validate_finite_frame_vector(e_v, F::Ev)?;

    let mut world_nodes_m = Vec::with_capacity(nodes_uv_m.len());
    for (node_index, uv) in nodes_uv_m.iter().copied().enumerate() {
        for (coordinate_index, value) in uv.iter().copied().enumerate() {
            if !value.is_finite() {
                return Err(E::NonFiniteInputNodeCoordinate {
                    node_index,
                    coordinate_index,
                });
            }
        }

        let mut world = [0.0; 3];
        for coordinate_index in 0..3 {
            // Keep the specified operation order with separate products/adds.
            let u_product = uv[0] * e_u[coordinate_index];
            if !u_product.is_finite() {
                return Err(E::NonFiniteWorldArithmetic {
                    node_index,
                    coordinate_index,
                    operation: O::UProduct,
                });
            }
            let v_product = uv[1] * e_v[coordinate_index];
            if !v_product.is_finite() {
                return Err(E::NonFiniteWorldArithmetic {
                    node_index,
                    coordinate_index,
                    operation: O::VProduct,
                });
            }
            let origin_plus_u = origin[coordinate_index] + u_product;
            if !origin_plus_u.is_finite() {
                return Err(E::NonFiniteWorldArithmetic {
                    node_index,
                    coordinate_index,
                    operation: O::OriginPlusU,
                });
            }
            let result = origin_plus_u + v_product;
            if !result.is_finite() {
                return Err(E::NonFiniteWorldArithmetic {
                    node_index,
                    coordinate_index,
                    operation: O::AddV,
                });
            }
            world[coordinate_index] = result;
        }
        world_nodes_m.push(world);
    }
    Ok(world_nodes_m)
}

fn normalized_world_coordinate_bits(value: f64) -> u64 {
    const ABS_MASK: u64 = 0x7fff_ffff_ffff_ffff;
    if value.to_bits() & ABS_MASK == 0 {
        0
    } else {
        value.to_bits()
    }
}

fn reject_duplicate_world_nodes(
    world_nodes_m: &[[f64; 3]],
) -> Result<(), WaveguideWorldMappingError> {
    let mut first_node_by_key = BTreeMap::<[u64; 3], usize>::new();
    for (node_index, node) in world_nodes_m.iter().copied().enumerate() {
        let key = node.map(normalized_world_coordinate_bits);
        if let Some(first_node_index) = first_node_by_key.insert(key, node_index) {
            return Err(WaveguideWorldMappingError::DuplicateWorldNodeCoordinates {
                first_node_index,
                duplicate_node_index: node_index,
            });
        }
    }
    Ok(())
}

fn measure_frame_diagnostics(
    nodes_uv_m: &[[f64; 2]],
    world_nodes_m: &[[f64; 3]],
    origin: [f64; 3],
    e_u: [f64; 3],
    e_v: [f64; 3],
    axis: [f64; 3],
) -> Result<(f64, f64), WaveguideWorldMappingError> {
    use WaveguideWorldMappingError as E;

    validate_finite_frame_vector(axis, CanonicalFrameValueField::Axis)?;
    let mut maximum_projection_error_m = 0.0_f64;
    let mut maximum_plane_deviation_m = 0.0_f64;

    for (node_index, (uv, world)) in nodes_uv_m
        .iter()
        .copied()
        .zip(world_nodes_m.iter().copied())
        .enumerate()
    {
        let displacement = [
            world[0] - origin[0],
            world[1] - origin[1],
            world[2] - origin[2],
        ];
        let projected_u = dot3(displacement, e_u);
        let projected_v = dot3(displacement, e_v);
        let projection_error = (projected_u - uv[0]).hypot(projected_v - uv[1]);
        if displacement.iter().any(|value| !value.is_finite())
            || !projected_u.is_finite()
            || !projected_v.is_finite()
            || !projection_error.is_finite()
        {
            return Err(E::NonFiniteProjectionDiagnostic { node_index });
        }

        let plane_deviation = dot3(displacement, axis).abs();
        if !plane_deviation.is_finite() {
            return Err(E::NonFinitePlaneDeviation { node_index });
        }
        maximum_projection_error_m = maximum_projection_error_m.max(projection_error);
        maximum_plane_deviation_m = maximum_plane_deviation_m.max(plane_deviation);
    }

    Ok((maximum_projection_error_m, maximum_plane_deviation_m))
}

#[derive(Debug)]
struct ElementMetrics {
    minimum_triangle_quality: f64,
    minimum_triangle_area_m2: f64,
    minimum_positive_mass_entry_m2: f64,
    maximum_gradient_norm_per_m: f64,
}

fn validate_world_triangles<'t, I>(
    world_nodes_m: &[[f64; 3]],
    triangles: I,
    axis: [f64; 3],
) -> Result<ElementMetrics, WaveguideWorldMappingError>
where
    I: IntoIterator<Item = &'t [u64; 3]>,
{
    use WaveguideWorldMappingError as E;

    validate_finite_frame_vector(axis, CanonicalFrameValueField::Axis)?;
    let exact_axis = exact_vector3(axis).ok_or(E::NonFiniteCanonicalFrameComponent {
        field: CanonicalFrameValueField::Axis,
        component: 0,
    })?;

    let mut triangle_count = 0_usize;
    let mut minimum_triangle_quality = f64::INFINITY;
    let mut minimum_triangle_area_m2 = f64::INFINITY;
    let mut minimum_positive_mass_entry_m2 = f64::INFINITY;
    let mut maximum_gradient_norm_per_m = 0.0_f64;

    for (triangle_index, connectivity) in triangles.into_iter().enumerate() {
        triangle_count += 1;
        let mut indices = [0_usize; 3];
        for node_slot in 0..3 {
            let node_index = usize::try_from(connectivity[node_slot]).map_err(|_| {
                E::TriangleNodeIndexNotRepresentable {
                    triangle_index,
                    node_slot,
                    node_index: connectivity[node_slot],
                }
            })?;
            if node_index >= world_nodes_m.len() {
                return Err(E::TriangleNodeIndexOutOfBounds {
                    triangle_index,
                    node_slot,
                    node_index,
                });
            }
            indices[node_slot] = node_index;
        }

        let triangle_world_nodes = [
            world_nodes_m[indices[0]],
            world_nodes_m[indices[1]],
            world_nodes_m[indices[2]],
        ];
        if exact_world_orientation(&triangle_world_nodes, &exact_axis)? != Sign::Plus {
            return Err(E::NonPositiveRoundedWorldOrientation { triangle_index });
        }

        let edge01 = checked_edge_difference(
            triangle_world_nodes[0],
            triangle_world_nodes[1],
            triangle_index,
            0,
        )?;
        let edge02 = checked_edge_difference(
            triangle_world_nodes[0],
            triangle_world_nodes[2],
            triangle_index,
            2,
        )?;
        let edge12 = checked_edge_difference(
            triangle_world_nodes[1],
            triangle_world_nodes[2],
            triangle_index,
            1,
        )?;
        let lengths = [
            checked_edge_length(edge01, triangle_index, 0)?,
            checked_edge_length(edge12, triangle_index, 1)?,
            checked_edge_length(edge02, triangle_index, 2)?,
        ];
        let scale = lengths[0].max(lengths[1]).max(lengths[2]);
        if !scale.is_finite() || scale <= 0.0 {
            return Err(E::NonFiniteEdgeLength {
                triangle_index,
                edge_index: 0,
            });
        }

        let scaled01 = checked_scaled_edge(edge01, scale, triangle_index, 0)?;
        let scaled02 = checked_scaled_edge(edge02, scale, triangle_index, 2)?;
        let scaled12 = checked_scaled_edge(edge12, scale, triangle_index, 1)?;
        let normal = cross3(scaled01, scaled02);
        if normal.iter().any(|value| !value.is_finite()) {
            return Err(E::NonFiniteScaledNormal { triangle_index });
        }
        let normal_norm = norm3(normal);
        if !normal_norm.is_finite() {
            return Err(E::NonFiniteScaledNormal { triangle_index });
        }
        if normal_norm <= 0.0 {
            return Err(E::NonPositiveScaledNormal { triangle_index });
        }

        let quality_denominator =
            dot3(scaled01, scaled01) + dot3(scaled02, scaled02) + dot3(scaled12, scaled12);
        if !quality_denominator.is_finite() || quality_denominator <= 0.0 {
            return Err(E::NonFiniteQualityDenominator { triangle_index });
        }
        let quality = (2.0 * 3.0_f64.sqrt() * normal_norm) / quality_denominator;
        if !quality.is_finite() {
            return Err(E::NonFiniteTriangleQuality { triangle_index });
        }
        if quality <= WAVEGUIDE_TRIANGLE_QUALITY_ROUNDOFF_THRESHOLD {
            return Err(E::TriangleQualityAtOrBelowRoundoffThreshold { triangle_index });
        }

        let normalized_area = 0.5 * normal_norm;
        if !normalized_area.is_finite() || normalized_area <= 0.0 {
            return Err(E::NonRepresentableNormalizedArea { triangle_index });
        }
        let scaled_area = scale * normalized_area;
        let area = scaled_area * scale;
        if !scaled_area.is_finite() || scaled_area <= 0.0 || !area.is_finite() || area <= 0.0 {
            return Err(E::NonRepresentablePhysicalArea { triangle_index });
        }

        let normal_squared = dot3(normal, normal);
        if !normal_squared.is_finite() || normal_squared <= 0.0 {
            return Err(E::NonPositiveScaledNormal { triangle_index });
        }
        let gradient1 = cross3(scaled02, normal).map(|value| value / normal_squared);
        let gradient2 = cross3(normal, scaled01).map(|value| value / normal_squared);
        let gradient0 = [
            -(gradient1[0] + gradient2[0]),
            -(gradient1[1] + gradient2[1]),
            -(gradient1[2] + gradient2[2]),
        ];
        let scaled_gradients = [gradient0, gradient1, gradient2];
        let mut physical_gradients = [[0.0; 3]; 3];
        for local_node_index in 0..3 {
            for coordinate_index in 0..3 {
                let scaled = scaled_gradients[local_node_index][coordinate_index];
                if !scaled.is_finite() {
                    return Err(E::NonFiniteScaledGradient {
                        triangle_index,
                        local_node_index,
                        coordinate_index,
                    });
                }
                let physical = scaled / scale;
                if !physical.is_finite() {
                    return Err(E::NonFinitePhysicalGradient {
                        triangle_index,
                        local_node_index,
                        coordinate_index,
                    });
                }
                if scaled.to_bits() & 0x7fff_ffff_ffff_ffff != 0
                    && physical.to_bits() & 0x7fff_ffff_ffff_ffff == 0
                {
                    return Err(E::PhysicalGradientComponentUnderflow {
                        triangle_index,
                        local_node_index,
                        coordinate_index,
                    });
                }
                physical_gradients[local_node_index][coordinate_index] = physical;
            }
            let gradient_norm = norm3(physical_gradients[local_node_index]);
            if !gradient_norm.is_finite() {
                return Err(E::NonFinitePhysicalGradient {
                    triangle_index,
                    local_node_index,
                    coordinate_index: 0,
                });
            }
            maximum_gradient_norm_per_m = maximum_gradient_norm_per_m.max(gradient_norm);
        }

        for row in 0..3 {
            for column in 0..3 {
                let mass_entry = if row == column {
                    area / 6.0
                } else {
                    area / 12.0
                };
                if !mass_entry.is_finite() || mass_entry <= 0.0 {
                    return Err(E::NonRepresentableMassEntry {
                        triangle_index,
                        row,
                        column,
                    });
                }
                minimum_positive_mass_entry_m2 = minimum_positive_mass_entry_m2.min(mass_entry);

                let stiffness =
                    normalized_area * dot3(scaled_gradients[row], scaled_gradients[column]);
                if !stiffness.is_finite() {
                    return Err(E::NonFiniteDimensionlessStiffness {
                        triangle_index,
                        row,
                        column,
                    });
                }
            }
        }

        minimum_triangle_quality = minimum_triangle_quality.min(quality);
        minimum_triangle_area_m2 = minimum_triangle_area_m2.min(area);
    }

    if triangle_count == 0 {
        return Err(E::EmptyTriangleSet);
    }

    Ok(ElementMetrics {
        minimum_triangle_quality,
        minimum_triangle_area_m2,
        minimum_positive_mass_entry_m2,
        maximum_gradient_norm_per_m,
    })
}

fn checked_edge_difference(
    origin: [f64; 3],
    endpoint: [f64; 3],
    triangle_index: usize,
    edge_index: usize,
) -> Result<[f64; 3], WaveguideWorldMappingError> {
    let mut edge = [0.0; 3];
    for coordinate_index in 0..3 {
        edge[coordinate_index] = endpoint[coordinate_index] - origin[coordinate_index];
        if !edge[coordinate_index].is_finite() {
            return Err(WaveguideWorldMappingError::NonFiniteEdgeDifference {
                triangle_index,
                edge_index,
                coordinate_index,
            });
        }
    }
    Ok(edge)
}

fn checked_edge_length(
    edge: [f64; 3],
    triangle_index: usize,
    edge_index: usize,
) -> Result<f64, WaveguideWorldMappingError> {
    let length = norm3(edge);
    if !length.is_finite() || length <= 0.0 {
        return Err(WaveguideWorldMappingError::NonFiniteEdgeLength {
            triangle_index,
            edge_index,
        });
    }
    Ok(length)
}

fn checked_scaled_edge(
    edge: [f64; 3],
    scale: f64,
    triangle_index: usize,
    edge_index: usize,
) -> Result<[f64; 3], WaveguideWorldMappingError> {
    use WaveguideWorldMappingError as E;

    let mut scaled = [0.0; 3];
    for coordinate_index in 0..3 {
        scaled[coordinate_index] = edge[coordinate_index] / scale;
        if !scaled[coordinate_index].is_finite() {
            return Err(E::NonFiniteNormalizedEdge {
                triangle_index,
                edge_index,
                coordinate_index,
            });
        }
        if edge[coordinate_index].to_bits() & 0x7fff_ffff_ffff_ffff != 0
            && scaled[coordinate_index].to_bits() & 0x7fff_ffff_ffff_ffff == 0
        {
            return Err(E::NormalizedEdgeComponentUnderflow {
                triangle_index,
                edge_index,
                coordinate_index,
            });
        }
    }
    Ok(scaled)
}

fn exact_vector3(values: [f64; 3]) -> Option<[BigInt; 3]> {
    Some([
        exact_binary64_integer(values[0])?,
        exact_binary64_integer(values[1])?,
        exact_binary64_integer(values[2])?,
    ])
}

fn exact_world_orientation(
    points: &[[f64; 3]; 3],
    axis: &[BigInt; 3],
) -> Result<Sign, WaveguideWorldMappingError> {
    let exact_points = [
        exact_world_point(points[0], 0)?,
        exact_world_point(points[1], 1)?,
        exact_world_point(points[2], 2)?,
    ];
    let edge01 = subtract_exact_vectors(&exact_points[1], &exact_points[0]);
    let edge02 = subtract_exact_vectors(&exact_points[2], &exact_points[0]);
    let cross = [
        &edge01[1] * &edge02[2] - &edge01[2] * &edge02[1],
        &edge01[2] * &edge02[0] - &edge01[0] * &edge02[2],
        &edge01[0] * &edge02[1] - &edge01[1] * &edge02[0],
    ];

    // The finite axis components use the same exact positive factor 2^-1074.
    let determinant = &cross[0] * &axis[0] + &cross[1] * &axis[1] + &cross[2] * &axis[2];
    Ok(determinant.sign())
}

fn exact_world_point(
    point: [f64; 3],
    node_index: usize,
) -> Result<[BigInt; 3], WaveguideWorldMappingError> {
    use WaveguideWorldMappingError as E;

    let mut exact = [BigInt::from(0_u8), BigInt::from(0_u8), BigInt::from(0_u8)];
    for coordinate_index in 0..3 {
        exact[coordinate_index] = exact_binary64_integer(point[coordinate_index]).ok_or(
            E::NonFiniteWorldNodeCoordinate {
                node_index,
                coordinate_index,
            },
        )?;
    }
    Ok(exact)
}

fn subtract_exact_vectors(left: &[BigInt; 3], right: &[BigInt; 3]) -> [BigInt; 3] {
    [
        &left[0] - &right[0],
        &left[1] - &right[1],
        &left[2] - &right[2],
    ]
}

fn cross3(left: [f64; 3], right: [f64; 3]) -> [f64; 3] {
    [
        left[1] * right[2] - left[2] * right[1],
        left[2] * right[0] - left[0] * right[2],
        left[0] * right[1] - left[1] * right[0],
    ]
}

fn dot3(left: [f64; 3], right: [f64; 3]) -> f64 {
    let product0 = left[0] * right[0];
    let product1 = left[1] * right[1];
    let product2 = left[2] * right[2];
    let sum01 = product0 + product1;
    sum01 + product2
}

fn norm3(vector: [f64; 3]) -> f64 {
    vector[0].hypot(vector[1]).hypot(vector[2])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::waveguide_frame::{validate_waveguide_frame, WaveguideFrameIR};
    use crate::waveguide_mesh_bindings::{
        tests::valid_fixture, validate_waveguide_registry_bindings,
    };
    use crate::waveguide_mesh_dirichlet::validate_finite_air_dirichlet_bindings;

    fn geometry(
        nodes_uv_m: &[[f64; 2]],
        triangles: &[[u64; 3]],
        origin: [f64; 3],
        e_u: [f64; 3],
        e_v: [f64; 3],
        axis: [f64; 3],
    ) -> Result<WorldGeometry, WaveguideWorldMappingError> {
        validate_world_geometry(nodes_uv_m, triangles.iter(), origin, e_u, e_v, axis)
    }

    #[test]
    fn identity_and_rotated_right_handed_frames_map_the_same_uv_triangle() {
        let nodes = [[0.0, 0.0], [1.0, 0.0], [0.0, 1.0]];
        let triangles = [[0, 1, 2]];

        let identity = geometry(
            &nodes,
            &triangles,
            [0.0; 3],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        )
        .expect("identity frame is representable");
        assert_eq!(
            identity.world_nodes_m,
            vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]
        );

        let rotated = geometry(
            &nodes,
            &triangles,
            [3.0, -2.0, 5.0],
            [0.0, 1.0, 0.0],
            [-1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0],
        )
        .expect("rotated right-handed frame is representable");
        assert_eq!(
            rotated.world_nodes_m,
            vec![[3.0, -2.0, 5.0], [3.0, -1.0, 5.0], [2.0, -2.0, 5.0]]
        );
        assert!(rotated.minimum_triangle_quality > WAVEGUIDE_TRIANGLE_QUALITY_ROUNDOFF_THRESHOLD);
        assert_eq!(rotated.minimum_triangle_area_m2, 0.5);
        assert!(rotated.minimum_positive_mass_entry_m2 > 0.0);
        assert!(rotated.maximum_gradient_norm_per_m.is_finite());
        assert_eq!(rotated.maximum_projection_error_m, 0.0);
        assert_eq!(rotated.maximum_plane_deviation_m, 0.0);
    }

    #[test]
    fn reversed_axis_and_uv_winding_preserve_world_positions() {
        let nodes = [[0.0, 0.0], [1.0, 0.0], [0.0, 1.0]];
        let triangles = [[0, 1, 2]];
        let original = geometry(
            &nodes,
            &triangles,
            [0.0; 3],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        )
        .expect("original frame");
        let reversed_nodes = [[0.0, -0.0], [1.0, -0.0], [0.0, -1.0]];
        let reversed_triangles = [[0, 2, 1]];
        let reversed = geometry(
            &reversed_nodes,
            &reversed_triangles,
            [0.0; 3],
            [1.0, 0.0, 0.0],
            [0.0, -1.0, 0.0],
            [0.0, 0.0, -1.0],
        )
        .expect("reversed frame requires matching local v and connectivity");
        assert_eq!(original.world_nodes_m, reversed.world_nodes_m);
        assert_eq!(
            original.minimum_triangle_area_m2,
            reversed.minimum_triangle_area_m2
        );
        assert_eq!(
            original.minimum_triangle_quality,
            reversed.minimum_triangle_quality
        );
        assert_eq!(reversed.maximum_projection_error_m, 0.0);
        assert_eq!(reversed.maximum_plane_deviation_m, 0.0);
    }

    #[test]
    fn a_large_origin_collision_includes_unconnected_nodes() {
        let nodes = [[0.0, 0.0], [4.0, 0.0], [0.0, 4.0], [0.5, 0.5]];
        let triangles = [[0, 1, 2]];
        let error = geometry(
            &nodes,
            &triangles,
            [1.0e16, 1.0e16, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        )
        .expect_err("the disconnected fourth node rounds onto node zero");
        assert_eq!(
            error,
            WaveguideWorldMappingError::DuplicateWorldNodeCoordinates {
                first_node_index: 0,
                duplicate_node_index: 3,
            }
        );
        assert_eq!(normalized_world_coordinate_bits(0.0), 0);
        assert_eq!(normalized_world_coordinate_bits(-0.0), 0);
        let signed_zero_nodes = [[0.0, 0.0], [-0.0, 0.0]];
        assert_eq!(
            geometry(
                &signed_zero_nodes,
                &[],
                [0.0; 3],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            )
            .expect_err("world identity treats positive and negative zero as equal"),
            WaveguideWorldMappingError::DuplicateWorldNodeCoordinates {
                first_node_index: 0,
                duplicate_node_index: 1,
            }
        );
    }

    #[test]
    fn overflowing_world_addition_is_rejected_at_the_operation_that_overflows() {
        let nodes = [[0.0, 0.0], [1.0e308, 0.0], [0.0, 1.0]];
        let triangles = [[0, 1, 2]];
        assert_eq!(
            geometry(
                &nodes,
                &triangles,
                [1.0e308, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            )
            .expect_err("origin plus a finite u product overflows"),
            WaveguideWorldMappingError::NonFiniteWorldArithmetic {
                node_index: 1,
                coordinate_index: 0,
                operation: WorldCoordinateOperation::OriginPlusU,
            }
        );
    }

    #[test]
    fn small_positive_geometry_has_no_absolute_area_floor() {
        let scale = 1.0e-100;
        let nodes = [[0.0, 0.0], [scale, 0.0], [0.0, scale]];
        let triangles = [[0, 1, 2]];
        let result = geometry(
            &nodes,
            &triangles,
            [0.0; 3],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        )
        .expect("positive representable tiny area has no absolute floor");
        assert!(result.minimum_triangle_area_m2 > 0.0);
        assert!((result.minimum_triangle_area_m2 / 5.0e-201 - 1.0).abs() < 1.0e-14);
        assert!(result.minimum_positive_mass_entry_m2 > 0.0);
        assert!(result.maximum_gradient_norm_per_m.is_finite());
    }

    #[test]
    fn rounded_world_orientation_is_exact_and_inputs_remain_unchanged() {
        let nodes = [[0.0, 0.0], [2.9, 1.1], [5.1, 4.9]];
        let triangles = [[0, 1, 2]];
        let nodes_before = nodes;
        let triangles_before = triangles;
        assert!(2.9_f64 * 4.9 - 1.1 * 5.1 > 0.0);

        let mapped = map_world_nodes(
            &nodes,
            [1.0e16, 1.0e16, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
        )
        .expect("finite frame mapping rounds each coordinate deterministically");
        assert_eq!(
            mapped,
            vec![
                [1.0e16, 1.0e16, 0.0],
                [1.0e16 + 2.0, 1.0e16 + 2.0, 0.0],
                [1.0e16 + 6.0, 1.0e16 + 4.0, 0.0],
            ]
        );
        assert_eq!(
            geometry(
                &nodes,
                &triangles,
                [1.0e16, 1.0e16, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            )
            .expect_err("connectivity must not be reordered after rounded reversal"),
            WaveguideWorldMappingError::NonPositiveRoundedWorldOrientation { triangle_index: 0 }
        );
        assert_eq!(nodes, nodes_before);
        assert_eq!(triangles, triangles_before);
    }

    #[test]
    fn entrypoint_borrows_the_exact_validated_registry_and_frame_tokens() {
        let (problem, mesh, region_targets) = valid_fixture();
        let registry = validate_waveguide_registry_bindings(&problem, &mesh, &region_targets)
            .expect("shared registry fixture");
        let dirichlet =
            validate_finite_air_dirichlet_bindings(&registry, &["boundary-air-outer".into()])
                .expect("fixture outer-air Dirichlet selection");
        let frame = validate_waveguide_frame(WaveguideFrameIR {
            origin_m: [0.0; 3],
            e_u: [1.0, 0.0, 0.0],
            e_v: [0.0, 1.0, 0.0],
            axis_unit: [0.0, 0.0, 1.0],
        })
        .expect("identity right-handed frame");

        let mapped = validate_waveguide_world_mapping(&dirichlet, &frame)
            .expect("exact validated borrows form a representable world mapping");
        assert!(std::ptr::eq(mapped.dirichlet(), &dirichlet));
        assert!(std::ptr::eq(mapped.frame(), &frame));
        assert!(std::ptr::eq(mapped.dirichlet().registry().mesh(), &mesh));
        assert_eq!(mapped.world_nodes_m().len(), mesh.nodes_uv_m.len());
        assert!(mapped.minimum_triangle_quality() > WAVEGUIDE_TRIANGLE_QUALITY_ROUNDOFF_THRESHOLD);
        assert!(mapped.minimum_triangle_area_m2() > 0.0);
        assert!(mapped.minimum_positive_mass_entry_m2() > 0.0);
        assert!(mapped.maximum_gradient_norm_per_m().is_finite());
        assert!(mapped.maximum_projection_error_m().is_finite());
        assert!(mapped.maximum_plane_deviation_m().is_finite());
    }
}
