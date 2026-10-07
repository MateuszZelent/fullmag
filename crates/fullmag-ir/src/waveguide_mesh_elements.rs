use crate::floating_point_guard::require_ieee_gradual_underflow;
use crate::waveguide_mesh::{WaveguideCrossSectionMeshIR, WaveguideCrossSectionTriangleIR};
use serde::Serialize;
use std::collections::HashMap;
use std::fmt;

/// Relative roundoff floor for a normalized linear triangle quality value.
pub const WAVEGUIDE_TRIANGLE_QUALITY_ROUNDOFF_THRESHOLD: f64 = 64.0 * f64::EPSILON;

/// Summary of representable local P1 triangle element quantities.
///
/// This report describes local floating-point representability only. It does not
/// certify geometric accuracy, conditioning, or global mesh embedding.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WaveguideMeshElementsReport {
    node_count: usize,
    triangle_count: usize,
    minimum_triangle_quality: f64,
    quality_roundoff_threshold: f64,
    minimum_triangle_area_m2: f64,
    minimum_positive_mass_entry_m2: f64,
    maximum_absolute_physical_gradient_per_m: f64,
    maximum_absolute_scalar_stiffness: f64,
}

impl WaveguideMeshElementsReport {
    pub const fn node_count(&self) -> usize {
        self.node_count
    }

    pub const fn triangle_count(&self) -> usize {
        self.triangle_count
    }

    pub const fn minimum_triangle_quality(&self) -> f64 {
        self.minimum_triangle_quality
    }

    pub const fn quality_roundoff_threshold(&self) -> f64 {
        self.quality_roundoff_threshold
    }

    pub const fn minimum_triangle_area_m2(&self) -> f64 {
        self.minimum_triangle_area_m2
    }

    pub const fn minimum_positive_mass_entry_m2(&self) -> f64 {
        self.minimum_positive_mass_entry_m2
    }

    pub const fn maximum_absolute_physical_gradient_per_m(&self) -> f64 {
        self.maximum_absolute_physical_gradient_per_m
    }

    pub const fn maximum_absolute_scalar_stiffness(&self) -> f64 {
        self.maximum_absolute_scalar_stiffness
    }
}

/// A structured reason why local waveguide mesh elements are not representable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum WaveguideMeshElementsError {
    UnsupportedFloatEnvironment {
        doubled_min_subnormal_bits: u64,
        halved_min_positive_bits: u64,
    },
    EmptyNodes,
    EmptyTriangles,
    NodeCountNotRepresentable,
    NonFiniteNodeCoordinate {
        node_index: usize,
        coordinate_index: usize,
    },
    DuplicateNodeCoordinates {
        first_node_index: usize,
        duplicate_node_index: usize,
    },
    TriangleNodeIndexOutOfBounds {
        triangle_index: usize,
        node_slot: usize,
        node_index: u64,
        node_count: u64,
    },
    TriangleNodeIndexNotRepresentable {
        triangle_index: usize,
        node_slot: usize,
        node_index: u64,
    },
    RepeatedTriangleNodeIndex {
        triangle_index: usize,
        node_index: u64,
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
    ZeroEdgeLength {
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
    NonFiniteDeterminant {
        triangle_index: usize,
    },
    NonPositiveDeterminant {
        triangle_index: usize,
    },
    NonRepresentableNormalizedArea {
        triangle_index: usize,
    },
    NonFiniteQuality {
        triangle_index: usize,
    },
    QualityAtOrBelowRoundoffThreshold {
        triangle_index: usize,
    },
    NonRepresentablePhysicalArea {
        triangle_index: usize,
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
    NonRepresentableMassEntry {
        triangle_index: usize,
        row: usize,
        column: usize,
    },
    NonFiniteScalarStiffness {
        triangle_index: usize,
        row: usize,
        column: usize,
    },
}

impl fmt::Display for WaveguideMeshElementsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for WaveguideMeshElementsError {}

/// Validate local linear-triangle geometry and floating-point element quantities.
///
/// This check intentionally does not validate edge incidence, boundary topology,
/// global intersections, or a mesher certificate.
pub fn validate_waveguide_mesh_elements(
    mesh: &WaveguideCrossSectionMeshIR,
) -> Result<WaveguideMeshElementsReport, WaveguideMeshElementsError> {
    require_ieee_gradual_underflow().map_err(|error| {
        WaveguideMeshElementsError::UnsupportedFloatEnvironment {
            doubled_min_subnormal_bits: error.doubled_min_subnormal_bits,
            halved_min_positive_bits: error.halved_min_positive_bits,
        }
    })?;

    if mesh.nodes_uv_m.is_empty() {
        return Err(WaveguideMeshElementsError::EmptyNodes);
    }
    if mesh.triangles.is_empty() {
        return Err(WaveguideMeshElementsError::EmptyTriangles);
    }
    let node_count = u64::try_from(mesh.nodes_uv_m.len())
        .map_err(|_| WaveguideMeshElementsError::NodeCountNotRepresentable)?;

    let mut unique_nodes = HashMap::<(u64, u64), usize>::with_capacity(mesh.nodes_uv_m.len());
    for (node_index, point) in mesh.nodes_uv_m.iter().enumerate() {
        for (coordinate_index, coordinate) in point.iter().copied().enumerate() {
            if !coordinate.is_finite() {
                return Err(WaveguideMeshElementsError::NonFiniteNodeCoordinate {
                    node_index,
                    coordinate_index,
                });
            }
        }
        let key = (
            normalized_coordinate_bits(point[0]),
            normalized_coordinate_bits(point[1]),
        );
        if let Some(first_node_index) = unique_nodes.insert(key, node_index) {
            return Err(WaveguideMeshElementsError::DuplicateNodeCoordinates {
                first_node_index,
                duplicate_node_index: node_index,
            });
        }
    }

    let mut minimum_triangle_quality = f64::INFINITY;
    let mut minimum_triangle_area_m2 = f64::INFINITY;
    let mut minimum_positive_mass_entry_m2 = f64::INFINITY;
    let mut maximum_absolute_physical_gradient_per_m: f64 = 0.0;
    let mut maximum_absolute_scalar_stiffness: f64 = 0.0;

    for (triangle_index, triangle) in mesh.triangles.iter().enumerate() {
        let indices = checked_triangle_indices(triangle, triangle_index, node_count)?;
        let points = [
            mesh.nodes_uv_m[indices[0]],
            mesh.nodes_uv_m[indices[1]],
            mesh.nodes_uv_m[indices[2]],
        ];
        let edge01 = checked_edge(points[0], points[1], triangle_index, 0)?;
        let edge12 = checked_edge(points[1], points[2], triangle_index, 1)?;
        let edge20 = checked_edge(points[2], points[0], triangle_index, 2)?;
        let lengths = [
            checked_edge_length(edge01, triangle_index, 0)?,
            checked_edge_length(edge12, triangle_index, 1)?,
            checked_edge_length(edge20, triangle_index, 2)?,
        ];
        let scale = lengths[0].max(lengths[1]).max(lengths[2]);
        if !scale.is_finite() || scale <= 0.0 {
            return Err(WaveguideMeshElementsError::NonFiniteEdgeLength {
                triangle_index,
                edge_index: 0,
            });
        }

        let r1 = checked_scaled_edge(edge01, scale, triangle_index, 0)?;
        let origin_to_two = [-edge20[0], -edge20[1]];
        let r2 = checked_scaled_edge(origin_to_two, scale, triangle_index, 2)?;
        let r21 = [r2[0] - r1[0], r2[1] - r1[1]];
        for coordinate_index in 0..2 {
            let direct_scaled = edge12[coordinate_index] / scale;
            if !direct_scaled.is_finite() || !r21[coordinate_index].is_finite() {
                return Err(WaveguideMeshElementsError::NonFiniteNormalizedEdge {
                    triangle_index,
                    edge_index: 1,
                    coordinate_index,
                });
            }
            if edge12[coordinate_index] != 0.0
                && (direct_scaled == 0.0 || r21[coordinate_index] == 0.0)
            {
                return Err(
                    WaveguideMeshElementsError::NormalizedEdgeComponentUnderflow {
                        triangle_index,
                        edge_index: 1,
                        coordinate_index,
                    },
                );
            }
        }

        let determinant = r1[0] * r2[1] - r1[1] * r2[0];
        if !determinant.is_finite() {
            return Err(WaveguideMeshElementsError::NonFiniteDeterminant { triangle_index });
        }
        if determinant <= 0.0 {
            return Err(WaveguideMeshElementsError::NonPositiveDeterminant { triangle_index });
        }
        let normalized_area = determinant / 2.0;
        if !normalized_area.is_finite() || normalized_area <= 0.0 {
            return Err(WaveguideMeshElementsError::NonRepresentableNormalizedArea {
                triangle_index,
            });
        }
        let quality_denominator = norm_squared(r1) + norm_squared(r21) + norm_squared(r2);
        let quality = 4.0 * 3.0_f64.sqrt() * normalized_area / quality_denominator;
        if !quality_denominator.is_finite() || quality_denominator <= 0.0 || !quality.is_finite() {
            return Err(WaveguideMeshElementsError::NonFiniteQuality { triangle_index });
        }
        if quality <= WAVEGUIDE_TRIANGLE_QUALITY_ROUNDOFF_THRESHOLD {
            return Err(
                WaveguideMeshElementsError::QualityAtOrBelowRoundoffThreshold { triangle_index },
            );
        }

        let scaled_area = scale * normalized_area;
        let area = scaled_area * scale;
        if !scaled_area.is_finite() || scaled_area <= 0.0 || !area.is_finite() || area <= 0.0 {
            return Err(WaveguideMeshElementsError::NonRepresentablePhysicalArea {
                triangle_index,
            });
        }
        let scaled_gradients = [
            [(r1[1] - r2[1]) / determinant, (r2[0] - r1[0]) / determinant],
            [r2[1] / determinant, -r2[0] / determinant],
            [-r1[1] / determinant, r1[0] / determinant],
        ];
        for local_node_index in 0..3 {
            for coordinate_index in 0..2 {
                let scaled = scaled_gradients[local_node_index][coordinate_index];
                if !scaled.is_finite() {
                    return Err(WaveguideMeshElementsError::NonFiniteScaledGradient {
                        triangle_index,
                        local_node_index,
                        coordinate_index,
                    });
                }
                let physical = scaled / scale;
                if !physical.is_finite() {
                    return Err(WaveguideMeshElementsError::NonFinitePhysicalGradient {
                        triangle_index,
                        local_node_index,
                        coordinate_index,
                    });
                }
                if scaled != 0.0 && physical == 0.0 {
                    return Err(
                        WaveguideMeshElementsError::PhysicalGradientComponentUnderflow {
                            triangle_index,
                            local_node_index,
                            coordinate_index,
                        },
                    );
                }
                maximum_absolute_physical_gradient_per_m =
                    maximum_absolute_physical_gradient_per_m.max(physical.abs());
            }
        }

        for row in 0..3 {
            for column in 0..3 {
                let mass_entry = if row == column {
                    area / 6.0
                } else {
                    area / 12.0
                };
                if !mass_entry.is_finite() || mass_entry <= 0.0 {
                    return Err(WaveguideMeshElementsError::NonRepresentableMassEntry {
                        triangle_index,
                        row,
                        column,
                    });
                }
                minimum_positive_mass_entry_m2 = minimum_positive_mass_entry_m2.min(mass_entry);

                let dot = scaled_gradients[row][0] * scaled_gradients[column][0]
                    + scaled_gradients[row][1] * scaled_gradients[column][1];
                let stiffness = normalized_area * dot;
                if !stiffness.is_finite() {
                    return Err(WaveguideMeshElementsError::NonFiniteScalarStiffness {
                        triangle_index,
                        row,
                        column,
                    });
                }
                maximum_absolute_scalar_stiffness =
                    maximum_absolute_scalar_stiffness.max(stiffness.abs());
            }
        }

        minimum_triangle_quality = minimum_triangle_quality.min(quality);
        minimum_triangle_area_m2 = minimum_triangle_area_m2.min(area);
    }

    Ok(WaveguideMeshElementsReport {
        node_count: mesh.nodes_uv_m.len(),
        triangle_count: mesh.triangles.len(),
        minimum_triangle_quality,
        quality_roundoff_threshold: WAVEGUIDE_TRIANGLE_QUALITY_ROUNDOFF_THRESHOLD,
        minimum_triangle_area_m2,
        minimum_positive_mass_entry_m2,
        maximum_absolute_physical_gradient_per_m,
        maximum_absolute_scalar_stiffness,
    })
}

fn normalized_coordinate_bits(value: f64) -> u64 {
    if value == 0.0 {
        0.0_f64.to_bits()
    } else {
        value.to_bits()
    }
}

fn checked_triangle_indices(
    triangle: &WaveguideCrossSectionTriangleIR,
    triangle_index: usize,
    node_count: u64,
) -> Result<[usize; 3], WaveguideMeshElementsError> {
    let mut indices = [0usize; 3];
    for (node_slot, node_index) in triangle.nodes.iter().copied().enumerate() {
        if node_index >= node_count {
            return Err(WaveguideMeshElementsError::TriangleNodeIndexOutOfBounds {
                triangle_index,
                node_slot,
                node_index,
                node_count,
            });
        }
        indices[node_slot] = usize::try_from(node_index).map_err(|_| {
            WaveguideMeshElementsError::TriangleNodeIndexNotRepresentable {
                triangle_index,
                node_slot,
                node_index,
            }
        })?;
    }
    if triangle.nodes[0] == triangle.nodes[1]
        || triangle.nodes[1] == triangle.nodes[2]
        || triangle.nodes[0] == triangle.nodes[2]
    {
        let node_index = if triangle.nodes[0] == triangle.nodes[1] {
            triangle.nodes[0]
        } else if triangle.nodes[1] == triangle.nodes[2] {
            triangle.nodes[1]
        } else {
            triangle.nodes[0]
        };
        return Err(WaveguideMeshElementsError::RepeatedTriangleNodeIndex {
            triangle_index,
            node_index,
        });
    }
    Ok(indices)
}

fn checked_edge(
    from: [f64; 2],
    to: [f64; 2],
    triangle_index: usize,
    edge_index: usize,
) -> Result<[f64; 2], WaveguideMeshElementsError> {
    let mut edge = [0.0; 2];
    for coordinate_index in 0..2 {
        edge[coordinate_index] = to[coordinate_index] - from[coordinate_index];
        if !edge[coordinate_index].is_finite() {
            return Err(WaveguideMeshElementsError::NonFiniteEdgeDifference {
                triangle_index,
                edge_index,
                coordinate_index,
            });
        }
    }
    Ok(edge)
}

fn checked_edge_length(
    edge: [f64; 2],
    triangle_index: usize,
    edge_index: usize,
) -> Result<f64, WaveguideMeshElementsError> {
    let length = edge[0].hypot(edge[1]);
    if !length.is_finite() {
        return Err(WaveguideMeshElementsError::NonFiniteEdgeLength {
            triangle_index,
            edge_index,
        });
    }
    if length <= 0.0 {
        return Err(WaveguideMeshElementsError::ZeroEdgeLength {
            triangle_index,
            edge_index,
        });
    }
    Ok(length)
}

fn checked_scaled_edge(
    edge: [f64; 2],
    scale: f64,
    triangle_index: usize,
    edge_index: usize,
) -> Result<[f64; 2], WaveguideMeshElementsError> {
    let mut scaled = [0.0; 2];
    for coordinate_index in 0..2 {
        scaled[coordinate_index] = edge[coordinate_index] / scale;
        if !scaled[coordinate_index].is_finite() {
            return Err(WaveguideMeshElementsError::NonFiniteNormalizedEdge {
                triangle_index,
                edge_index,
                coordinate_index,
            });
        }
        if edge[coordinate_index] != 0.0 && scaled[coordinate_index] == 0.0 {
            return Err(
                WaveguideMeshElementsError::NormalizedEdgeComponentUnderflow {
                    triangle_index,
                    edge_index,
                    coordinate_index,
                },
            );
        }
    }
    Ok(scaled)
}

fn norm_squared(vector: [f64; 2]) -> f64 {
    vector[0] * vector[0] + vector[1] * vector[1]
}

#[cfg(test)]
mod tests {
    use super::{
        validate_waveguide_mesh_elements, WaveguideMeshElementsError,
        WAVEGUIDE_TRIANGLE_QUALITY_ROUNDOFF_THRESHOLD,
    };
    use crate::waveguide_mesh::{WaveguideCrossSectionMeshIR, WaveguideCrossSectionTriangleIR};

    const SHARED_MESH_FIXTURE: &str =
        include_str!("../tests/fixtures/waveguide_cross_section_mesh.v1.json");

    fn fixture() -> WaveguideCrossSectionMeshIR {
        serde_json::from_str(SHARED_MESH_FIXTURE).expect("shared mesh fixture should parse")
    }

    fn one_triangle(points: [[f64; 2]; 3]) -> WaveguideCrossSectionMeshIR {
        let mut mesh = fixture();
        mesh.nodes_uv_m = points.to_vec();
        mesh.triangles = vec![WaveguideCrossSectionTriangleIR {
            nodes: [0, 1, 2],
            region_id: "region".to_owned(),
        }];
        mesh
    }

    fn right_triangle(scale: f64) -> WaveguideCrossSectionMeshIR {
        one_triangle([[0.0, 0.0], [scale, 0.0], [0.0, scale]])
    }

    #[test]
    fn shared_fixture_has_representable_local_elements() {
        let report = validate_waveguide_mesh_elements(&fixture()).expect("fixture elements");
        assert_eq!(report.node_count(), 16);
        assert_eq!(report.triangle_count(), 18);
        assert!(report.minimum_triangle_quality() > report.quality_roundoff_threshold());
        assert!(report.minimum_triangle_area_m2().is_finite());
        assert!(report.minimum_positive_mass_entry_m2() > 0.0);
    }

    #[test]
    fn scaled_and_large_slender_elements_use_normalized_geometry() {
        for scale in [1.0, 1.0e-9, 1.0e-160, 1.0e154] {
            let report = validate_waveguide_mesh_elements(&right_triangle(scale))
                .expect("representable right triangle");
            assert!(report.minimum_triangle_area_m2().is_finite());
            assert!(report.minimum_triangle_area_m2() > 0.0);
            assert!(report.minimum_positive_mass_entry_m2() > 0.0);
            assert!(report
                .maximum_absolute_physical_gradient_per_m()
                .is_finite());
            assert!((report.maximum_absolute_scalar_stiffness() - 1.0).abs() < 1.0e-12);
        }

        let slender = one_triangle([[0.0, 0.0], [1.0e155, 0.0], [0.0, 1.0e142]]);
        let report = validate_waveguide_mesh_elements(&slender)
            .expect("large slender triangle above the relative quality floor");
        assert!(report.minimum_triangle_area_m2() > 4.9e296);
        assert!(report.minimum_triangle_area_m2() < 5.1e296);
        assert!(report.minimum_triangle_quality() > WAVEGUIDE_TRIANGLE_QUALITY_ROUNDOFF_THRESHOLD);
        assert!(report.minimum_triangle_quality() < 2.0e-13);
    }

    #[test]
    fn unrepresentable_area_mass_and_gradient_are_rejected() {
        assert!(matches!(
            validate_waveguide_mesh_elements(&right_triangle(2.0e154)),
            Err(WaveguideMeshElementsError::NonRepresentablePhysicalArea { .. })
        ));
        assert!(matches!(
            validate_waveguide_mesh_elements(&right_triangle(3.0e-162)),
            Err(WaveguideMeshElementsError::NonRepresentableMassEntry { .. })
        ));
        assert!(validate_waveguide_mesh_elements(&right_triangle(1.0e-310)).is_err());
    }

    #[test]
    fn invalid_orientation_degeneracy_coordinates_and_indices_are_rejected() {
        let overflowing_edge = one_triangle([[-1.0e308, 0.0], [1.0e308, 0.0], [0.0, 1.0]]);
        assert!(matches!(
            validate_waveguide_mesh_elements(&overflowing_edge),
            Err(WaveguideMeshElementsError::NonFiniteEdgeDifference { .. })
        ));

        assert!(matches!(
            validate_waveguide_mesh_elements(&one_triangle([[0.0, 0.0], [0.0, 1.0], [1.0, 0.0]])),
            Err(WaveguideMeshElementsError::NonPositiveDeterminant { .. })
        ));
        assert!(matches!(
            validate_waveguide_mesh_elements(&one_triangle([[0.0, 0.0], [1.0, 0.0], [2.0, 0.0]])),
            Err(WaveguideMeshElementsError::NonPositiveDeterminant { .. })
        ));

        let mut non_finite = right_triangle(1.0);
        non_finite.nodes_uv_m[2][1] = f64::INFINITY;
        assert!(matches!(
            validate_waveguide_mesh_elements(&non_finite),
            Err(WaveguideMeshElementsError::NonFiniteNodeCoordinate { .. })
        ));

        let mut nan_coordinate = right_triangle(1.0);
        nan_coordinate.nodes_uv_m[2][1] = f64::NAN;
        assert!(matches!(
            validate_waveguide_mesh_elements(&nan_coordinate),
            Err(WaveguideMeshElementsError::NonFiniteNodeCoordinate { .. })
        ));

        let mut duplicate = right_triangle(1.0);
        duplicate.nodes_uv_m[1] = [-0.0, 0.0];
        assert!(matches!(
            validate_waveguide_mesh_elements(&duplicate),
            Err(WaveguideMeshElementsError::DuplicateNodeCoordinates { .. })
        ));

        let mut out_of_bounds = right_triangle(1.0);
        out_of_bounds.triangles[0].nodes = [0, 1, u64::MAX];
        assert!(matches!(
            validate_waveguide_mesh_elements(&out_of_bounds),
            Err(WaveguideMeshElementsError::TriangleNodeIndexOutOfBounds { .. })
        ));

        let mut repeated = right_triangle(1.0);
        repeated.triangles[0].nodes = [0, 0, 1];
        assert!(matches!(
            validate_waveguide_mesh_elements(&repeated),
            Err(WaveguideMeshElementsError::RepeatedTriangleNodeIndex { .. })
        ));
    }
}
