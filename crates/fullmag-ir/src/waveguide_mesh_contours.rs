//! Exact signed-area and regional-containment checks for raw waveguide contours.
//!
//! This stage composes global embedding validation with contour orientation and
//! nesting checks. Its report is descriptive telemetry, not a certificate or
//! solver admission decision.

use std::cmp::Reverse;
use std::collections::{BTreeMap, BinaryHeap};
use std::error::Error;
use std::fmt;

use num_bigint::{BigInt, Sign};
use serde::Serialize;

use crate::waveguide_mesh::{WaveguideCrossSectionLoopKindIR, WaveguideCrossSectionMeshIR};
use crate::waveguide_mesh_embedding::{
    binary64_order_key, exact_points, orient2d_exact, validate_waveguide_mesh_embedding, Aabb,
    ActiveIntervalIndex, ExactPoint, WaveguideMeshEmbeddingError,
};

/// A checked counter reported by regional contour validation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaveguideMeshContoursCounter {
    OuterContours,
    HoleContours,
    SignedAreaEdgeTerms,
    ContainmentCandidates,
    ContainmentDepth,
    PointLocationOrientationTests,
}

/// Structured failure from exact contour orientation or nesting checks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WaveguideMeshContoursError {
    Embedding(WaveguideMeshEmbeddingError),
    BoundaryComponentIndexOutOfBounds {
        component_index: usize,
    },
    ContourTooShort {
        component_index: usize,
    },
    TriangleIndexNotRepresentable {
        component_index: usize,
        half_edge_index: usize,
        triangle_index: u64,
    },
    TriangleIndexOutOfBounds {
        component_index: usize,
        half_edge_index: usize,
        triangle_index: u64,
    },
    LocalEdgeIndexOutOfRange {
        component_index: usize,
        half_edge_index: usize,
        local_edge_index: u8,
    },
    NodeIndexNotRepresentable {
        component_index: usize,
        half_edge_index: usize,
        node_index: u64,
    },
    NodeIndexOutOfBounds {
        component_index: usize,
        half_edge_index: usize,
        node_index: u64,
    },
    ExactCoordinateIndexOutOfBounds {
        component_index: usize,
        node_index: usize,
    },
    ZeroSignedArea {
        component_index: usize,
    },
    SignedAreaOrientationMismatch {
        component_index: usize,
        loop_kind: WaveguideCrossSectionLoopKindIR,
    },
    SameRegionContourBoundaryContact {
        query_component_index: usize,
        candidate_component_index: usize,
        representative_node_index: usize,
    },
    NestingRoleMismatch {
        component_index: usize,
        nesting_depth: usize,
        actual_loop_kind: WaveguideCrossSectionLoopKindIR,
        expected_loop_kind: WaveguideCrossSectionLoopKindIR,
    },
    NestingDepthIndexOutOfBounds {
        component_index: usize,
    },
    CounterOverflow {
        counter: WaveguideMeshContoursCounter,
    },
    BroadphaseIndexCapacityOverflow,
}

impl WaveguideMeshContoursError {
    /// Return the embedding prerequisite error without changing its type.
    pub fn embedding_error(&self) -> Option<&WaveguideMeshEmbeddingError> {
        match self {
            Self::Embedding(error) => Some(error),
            _ => None,
        }
    }
}

impl fmt::Display for WaveguideMeshContoursError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "waveguide mesh contour error: {self:?}")
    }
}

impl Error for WaveguideMeshContoursError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Embedding(error) => Some(error),
            _ => None,
        }
    }
}

/// Descriptive work counts from exact regional contour validation.
///
/// These values report checks actually performed. They do not certify a mesh,
/// activate a solver, or establish boundary anchoring.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WaveguideMeshContoursReport {
    boundary_component_count: usize,
    outer_count: usize,
    hole_count: usize,
    maximum_nesting_depth: usize,
    containment_candidate_count: usize,
    signed_area_edge_terms: usize,
    point_location_orientation_tests: usize,
}

impl WaveguideMeshContoursReport {
    pub const fn boundary_component_count(&self) -> usize {
        self.boundary_component_count
    }

    pub const fn outer_count(&self) -> usize {
        self.outer_count
    }

    pub const fn hole_count(&self) -> usize {
        self.hole_count
    }

    pub const fn maximum_nesting_depth(&self) -> usize {
        self.maximum_nesting_depth
    }

    pub const fn containment_candidate_count(&self) -> usize {
        self.containment_candidate_count
    }

    pub const fn signed_area_edge_terms(&self) -> usize {
        self.signed_area_edge_terms
    }

    pub const fn point_location_orientation_tests(&self) -> usize {
        self.point_location_orientation_tests
    }
}

#[derive(Debug)]
struct ContourGeometry<'a> {
    component_index: usize,
    region_id: &'a str,
    loop_kind: WaveguideCrossSectionLoopKindIR,
    start_node_indices: Vec<usize>,
    bounds: Aabb,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PointLocation {
    Inside,
    Outside,
    Boundary,
}

fn increment_counter(
    counter: &mut usize,
    kind: WaveguideMeshContoursCounter,
) -> Result<(), WaveguideMeshContoursError> {
    *counter = counter
        .checked_add(1)
        .ok_or(WaveguideMeshContoursError::CounterOverflow { counter: kind })?;
    Ok(())
}

fn checked_contour_start_nodes(
    mesh: &WaveguideCrossSectionMeshIR,
    component_index: usize,
) -> Result<Vec<usize>, WaveguideMeshContoursError> {
    let component = mesh
        .boundary_components
        .get(component_index)
        .ok_or(WaveguideMeshContoursError::BoundaryComponentIndexOutOfBounds { component_index })?;
    if component.half_edges.len() < 3 {
        return Err(WaveguideMeshContoursError::ContourTooShort { component_index });
    }

    let mut start_node_indices = Vec::with_capacity(component.half_edges.len());
    for (half_edge_index, half_edge) in component.half_edges.iter().enumerate() {
        let triangle_index = usize::try_from(half_edge.triangle_index).map_err(|_| {
            WaveguideMeshContoursError::TriangleIndexNotRepresentable {
                component_index,
                half_edge_index,
                triangle_index: half_edge.triangle_index,
            }
        })?;
        let triangle = mesh.triangles.get(triangle_index).ok_or(
            WaveguideMeshContoursError::TriangleIndexOutOfBounds {
                component_index,
                half_edge_index,
                triangle_index: half_edge.triangle_index,
            },
        )?;
        let local_edge_index = half_edge.local_edge_index.as_u8();
        let start_node = match local_edge_index {
            0 => triangle.nodes[0],
            1 => triangle.nodes[1],
            2 => triangle.nodes[2],
            _ => {
                return Err(WaveguideMeshContoursError::LocalEdgeIndexOutOfRange {
                    component_index,
                    half_edge_index,
                    local_edge_index,
                });
            }
        };
        let node_index = usize::try_from(start_node).map_err(|_| {
            WaveguideMeshContoursError::NodeIndexNotRepresentable {
                component_index,
                half_edge_index,
                node_index: start_node,
            }
        })?;
        if node_index >= mesh.nodes_uv_m.len() {
            return Err(WaveguideMeshContoursError::NodeIndexOutOfBounds {
                component_index,
                half_edge_index,
                node_index: start_node,
            });
        }
        start_node_indices.push(node_index);
    }
    Ok(start_node_indices)
}

fn exact_coordinate_at(
    coordinates: &[ExactPoint],
    component_index: usize,
    node_index: usize,
) -> Result<&ExactPoint, WaveguideMeshContoursError> {
    coordinates.get(node_index).ok_or(
        WaveguideMeshContoursError::ExactCoordinateIndexOutOfBounds {
            component_index,
            node_index,
        },
    )
}

fn signed_contour_area_exact(
    start_node_indices: &[usize],
    exact_coordinates: &[ExactPoint],
    component_index: usize,
    signed_area_edge_terms: &mut usize,
) -> Result<BigInt, WaveguideMeshContoursError> {
    if start_node_indices.len() < 3 {
        return Err(WaveguideMeshContoursError::ContourTooShort { component_index });
    }

    let mut doubled_signed_area = BigInt::from(0_u8);
    for edge_index in 0..start_node_indices.len() {
        let next_edge_index = if edge_index + 1 == start_node_indices.len() {
            0
        } else {
            edge_index + 1
        };
        let first_node = start_node_indices[edge_index];
        let second_node = start_node_indices[next_edge_index];
        let first = exact_coordinate_at(exact_coordinates, component_index, first_node)?;
        let second = exact_coordinate_at(exact_coordinates, component_index, second_node)?;
        increment_counter(
            signed_area_edge_terms,
            WaveguideMeshContoursCounter::SignedAreaEdgeTerms,
        )?;

        doubled_signed_area += &first.coordinates[0] * &second.coordinates[1]
            - &first.coordinates[1] * &second.coordinates[0];
    }
    Ok(doubled_signed_area)
}

fn point_in_contour_exact(
    point: &ExactPoint,
    contour_start_node_indices: &[usize],
    exact_coordinates: &[ExactPoint],
    component_index: usize,
    point_location_orientation_tests: &mut usize,
) -> Result<PointLocation, WaveguideMeshContoursError> {
    if contour_start_node_indices.len() < 3 {
        return Err(WaveguideMeshContoursError::ContourTooShort { component_index });
    }

    let mut inside = false;
    for edge_index in 0..contour_start_node_indices.len() {
        let next_edge_index = if edge_index + 1 == contour_start_node_indices.len() {
            0
        } else {
            edge_index + 1
        };
        let first_node = contour_start_node_indices[edge_index];
        let second_node = contour_start_node_indices[next_edge_index];
        let first = exact_coordinate_at(exact_coordinates, component_index, first_node)?;
        let second = exact_coordinate_at(exact_coordinates, component_index, second_node)?;

        increment_counter(
            point_location_orientation_tests,
            WaveguideMeshContoursCounter::PointLocationOrientationTests,
        )?;
        let orientation = orient2d_exact(first, second, point);
        if orientation == Sign::NoSign && point_is_within_segment_bounds(point, first, second) {
            return Ok(PointLocation::Boundary);
        }

        let first_is_above = first.coordinates[1] > point.coordinates[1];
        let second_is_above = second.coordinates[1] > point.coordinates[1];
        if first_is_above != second_is_above {
            let is_upward = second.coordinates[1] > first.coordinates[1];
            if (is_upward && orientation == Sign::Plus)
                || (!is_upward && orientation == Sign::Minus)
            {
                inside = !inside;
            }
        }
    }

    Ok(if inside {
        PointLocation::Inside
    } else {
        PointLocation::Outside
    })
}

fn point_is_within_segment_bounds(
    point: &ExactPoint,
    first: &ExactPoint,
    second: &ExactPoint,
) -> bool {
    let minimum_u = if first.coordinates[0] <= second.coordinates[0] {
        &first.coordinates[0]
    } else {
        &second.coordinates[0]
    };
    let maximum_u = if first.coordinates[0] >= second.coordinates[0] {
        &first.coordinates[0]
    } else {
        &second.coordinates[0]
    };
    let minimum_v = if first.coordinates[1] <= second.coordinates[1] {
        &first.coordinates[1]
    } else {
        &second.coordinates[1]
    };
    let maximum_v = if first.coordinates[1] >= second.coordinates[1] {
        &first.coordinates[1]
    } else {
        &second.coordinates[1]
    };
    let point_u = &point.coordinates[0];
    let point_v = &point.coordinates[1];

    point_u >= minimum_u && point_u <= maximum_u && point_v >= minimum_v && point_v <= maximum_v
}

fn count_regional_containment(
    mesh: &WaveguideCrossSectionMeshIR,
    contours: &[ContourGeometry<'_>],
    exact_coordinates: &[ExactPoint],
    nesting_depth_by_component: &mut [usize],
    containment_candidate_count: &mut usize,
    point_location_orientation_tests: &mut usize,
) -> Result<(), WaveguideMeshContoursError> {
    let mut component_indices_by_region = BTreeMap::<&str, Vec<usize>>::new();
    for (geometry_index, contour) in contours.iter().enumerate() {
        component_indices_by_region
            .entry(contour.region_id)
            .or_default()
            .push(geometry_index);
    }

    for component_indices in component_indices_by_region.values() {
        let region_bounds = component_indices
            .iter()
            .map(|geometry_index| contours[*geometry_index].bounds)
            .collect::<Vec<_>>();
        let mut interval_index =
            ActiveIntervalIndex::new(&region_bounds).map_err(|error| match error {
                WaveguideMeshEmbeddingError::IndexCapacityOverflow => {
                    WaveguideMeshContoursError::BroadphaseIndexCapacityOverflow
                }
                other => WaveguideMeshContoursError::Embedding(other),
            })?;

        let mut insertion_order = (0..component_indices.len()).collect::<Vec<_>>();
        insertion_order.sort_unstable_by_key(|local_index| {
            let bounds = contours[component_indices[*local_index]].bounds;
            (bounds.min_u, bounds.max_u, *local_index)
        });
        let mut query_order = component_indices.clone();
        query_order.sort_unstable_by_key(|geometry_index| {
            let contour = &contours[*geometry_index];
            let node_index = contour.start_node_indices[0];
            (
                binary64_order_key(mesh.nodes_uv_m[node_index][0]),
                contour.component_index,
            )
        });

        let mut next_to_insert = 0_usize;
        let mut expiration = BinaryHeap::<Reverse<(u64, usize)>>::new();
        let mut candidate_local_indices = Vec::<usize>::new();

        for query_geometry_index in query_order {
            let query_contour = &contours[query_geometry_index];
            let query_node_index = query_contour.start_node_indices[0];
            let query_point = exact_coordinate_at(
                exact_coordinates,
                query_contour.component_index,
                query_node_index,
            )?;
            let query_u = binary64_order_key(mesh.nodes_uv_m[query_node_index][0]);
            let query_v = binary64_order_key(mesh.nodes_uv_m[query_node_index][1]);

            while next_to_insert < insertion_order.len() {
                let local_index = insertion_order[next_to_insert];
                let geometry_index = component_indices[local_index];
                let bounds = contours[geometry_index].bounds;
                if bounds.min_u > query_u {
                    break;
                }
                interval_index.insert(local_index);
                expiration.push(Reverse((bounds.max_u, local_index)));
                next_to_insert += 1;
            }

            while let Some(Reverse((active_max_u, local_index))) = expiration.peek().copied() {
                if active_max_u >= query_u {
                    break;
                }
                expiration.pop();
                interval_index.remove(local_index);
            }

            candidate_local_indices.clear();
            interval_index.query(query_v, query_v, &mut candidate_local_indices);
            for candidate_local_index in candidate_local_indices.iter().copied() {
                let candidate_geometry_index = component_indices[candidate_local_index];
                let candidate_contour = &contours[candidate_geometry_index];
                if candidate_contour.component_index == query_contour.component_index {
                    continue;
                }

                increment_counter(
                    containment_candidate_count,
                    WaveguideMeshContoursCounter::ContainmentCandidates,
                )?;
                match point_in_contour_exact(
                    query_point,
                    &candidate_contour.start_node_indices,
                    exact_coordinates,
                    candidate_contour.component_index,
                    point_location_orientation_tests,
                )? {
                    PointLocation::Inside => {
                        let depth = nesting_depth_by_component
                            .get_mut(query_contour.component_index)
                            .ok_or(WaveguideMeshContoursError::NestingDepthIndexOutOfBounds {
                                component_index: query_contour.component_index,
                            })?;
                        *depth = depth.checked_add(1).ok_or(
                            WaveguideMeshContoursError::CounterOverflow {
                                counter: WaveguideMeshContoursCounter::ContainmentDepth,
                            },
                        )?;
                    }
                    PointLocation::Outside => {}
                    PointLocation::Boundary => {
                        return Err(
                            WaveguideMeshContoursError::SameRegionContourBoundaryContact {
                                query_component_index: query_contour.component_index,
                                candidate_component_index: candidate_contour.component_index,
                                representative_node_index: query_node_index,
                            },
                        );
                    }
                }
            }
        }
    }

    Ok(())
}

/// Validate exact contour orientation and nesting after global embedding passes.
///
/// Containment is evaluated only among contours with the same region identifier.
/// The report describes measured work and does not create a mesh certificate or
/// change planner, provider, boundary-condition, or solver-admission behavior.
pub fn validate_waveguide_mesh_contours(
    mesh: &WaveguideCrossSectionMeshIR,
) -> Result<WaveguideMeshContoursReport, WaveguideMeshContoursError> {
    validate_waveguide_mesh_embedding(mesh).map_err(WaveguideMeshContoursError::Embedding)?;
    let exact_coordinates =
        exact_points(&mesh.nodes_uv_m).map_err(WaveguideMeshContoursError::Embedding)?;

    let mut outer_count = 0_usize;
    let mut hole_count = 0_usize;
    let mut signed_area_edge_terms = 0_usize;
    let mut contours = Vec::<ContourGeometry<'_>>::with_capacity(mesh.boundary_components.len());

    for (component_index, component) in mesh.boundary_components.iter().enumerate() {
        let start_node_indices = checked_contour_start_nodes(mesh, component_index)?;
        let bounds = Aabb::from_node_indices(&start_node_indices, &mesh.nodes_uv_m);
        let doubled_signed_area = signed_contour_area_exact(
            &start_node_indices,
            &exact_coordinates,
            component_index,
            &mut signed_area_edge_terms,
        )?;
        let area_sign = doubled_signed_area.sign();
        if area_sign == Sign::NoSign {
            return Err(WaveguideMeshContoursError::ZeroSignedArea { component_index });
        }

        match component.loop_kind {
            WaveguideCrossSectionLoopKindIR::Outer => {
                if area_sign != Sign::Plus {
                    return Err(WaveguideMeshContoursError::SignedAreaOrientationMismatch {
                        component_index,
                        loop_kind: component.loop_kind,
                    });
                }
                increment_counter(
                    &mut outer_count,
                    WaveguideMeshContoursCounter::OuterContours,
                )?;
            }
            WaveguideCrossSectionLoopKindIR::Hole => {
                if area_sign != Sign::Minus {
                    return Err(WaveguideMeshContoursError::SignedAreaOrientationMismatch {
                        component_index,
                        loop_kind: component.loop_kind,
                    });
                }
                increment_counter(&mut hole_count, WaveguideMeshContoursCounter::HoleContours)?;
            }
        }

        contours.push(ContourGeometry {
            component_index,
            region_id: component.region_id.as_str(),
            loop_kind: component.loop_kind,
            start_node_indices,
            bounds,
        });
    }

    let mut nesting_depth_by_component = vec![0_usize; contours.len()];
    let mut containment_candidate_count = 0_usize;
    let mut point_location_orientation_tests = 0_usize;
    count_regional_containment(
        mesh,
        &contours,
        &exact_coordinates,
        &mut nesting_depth_by_component,
        &mut containment_candidate_count,
        &mut point_location_orientation_tests,
    )?;

    let mut maximum_nesting_depth = 0_usize;
    for contour in &contours {
        let nesting_depth = *nesting_depth_by_component
            .get(contour.component_index)
            .ok_or(WaveguideMeshContoursError::NestingDepthIndexOutOfBounds {
                component_index: contour.component_index,
            })?;
        maximum_nesting_depth = maximum_nesting_depth.max(nesting_depth);
        let expected_loop_kind = if nesting_depth % 2 == 0 {
            WaveguideCrossSectionLoopKindIR::Outer
        } else {
            WaveguideCrossSectionLoopKindIR::Hole
        };
        if contour.loop_kind != expected_loop_kind {
            return Err(WaveguideMeshContoursError::NestingRoleMismatch {
                component_index: contour.component_index,
                nesting_depth,
                actual_loop_kind: contour.loop_kind,
                expected_loop_kind,
            });
        }
    }

    Ok(WaveguideMeshContoursReport {
        boundary_component_count: mesh.boundary_components.len(),
        outer_count,
        hole_count,
        maximum_nesting_depth,
        containment_candidate_count,
        signed_area_edge_terms,
        point_location_orientation_tests,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::waveguide_mesh::{
        WaveguideCrossSectionBoundaryComponentIR, WaveguideCrossSectionEdgeIR,
        WaveguideCrossSectionHalfEdgeIR, WaveguideCrossSectionMeshSchemaIR,
        WaveguideCrossSectionRegionIR, WaveguideCrossSectionTriangleIR, WaveguideLocalEdgeIndex,
    };
    use serde_json::from_str;
    use std::cmp::Reverse;
    use std::collections::{BTreeMap, BTreeSet, BinaryHeap};

    const SHARED_FIXTURE: &str =
        include_str!("../tests/fixtures/waveguide_cross_section_mesh.v1.json");
    const NESTED_FIXTURE: &str =
        include_str!("../tests/fixtures/waveguide_nested_contours_mesh.v1.json");

    fn shared_fixture() -> WaveguideCrossSectionMeshIR {
        from_str(SHARED_FIXTURE).expect("shared contour fixture must be valid")
    }

    fn nested_fixture() -> WaveguideCrossSectionMeshIR {
        from_str(NESTED_FIXTURE).expect("nested contour fixture must be valid")
    }

    fn integer_point(u: i64, v: i64) -> ExactPoint {
        ExactPoint {
            coordinates: [BigInt::from(u), BigInt::from(v)],
        }
    }

    fn locate_integer_polygon(
        vertices: &[(i64, i64)],
        query: (i64, i64),
    ) -> (PointLocation, usize) {
        let mut exact_coordinates = vertices
            .iter()
            .map(|(u, v)| integer_point(*u, *v))
            .collect::<Vec<_>>();
        let query_index = exact_coordinates.len();
        exact_coordinates.push(integer_point(query.0, query.1));
        let contour_nodes = (0..query_index).collect::<Vec<_>>();
        let mut orientation_tests = 0_usize;
        let location = point_in_contour_exact(
            &exact_coordinates[query_index],
            &contour_nodes,
            &exact_coordinates,
            0,
            &mut orientation_tests,
        )
        .expect("the test contour has valid exact coordinates");
        (location, orientation_tests)
    }

    fn disjoint_outer_mesh() -> WaveguideCrossSectionMeshIR {
        let nodes_uv_m = vec![
            [0.0, 0.0],
            [1.0e-9, 0.0],
            [0.0, 1.0e-9],
            [10.0e-9, 0.0],
            [11.0e-9, 0.0],
            [10.0e-9, 1.0e-9],
        ];
        let triangles = vec![
            WaveguideCrossSectionTriangleIR {
                nodes: [0, 1, 2],
                region_id: "same-region".to_string(),
            },
            WaveguideCrossSectionTriangleIR {
                nodes: [3, 4, 5],
                region_id: "same-region".to_string(),
            },
        ];

        let mut incidences_by_edge =
            BTreeMap::<[u64; 2], Vec<WaveguideCrossSectionHalfEdgeIR>>::new();
        for (triangle_index, triangle) in triangles.iter().enumerate() {
            for local_edge_index in 0..3 {
                let start_node = triangle.nodes[local_edge_index];
                let end_node = triangle.nodes[(local_edge_index + 1) % 3];
                let edge_nodes = [start_node.min(end_node), start_node.max(end_node)];
                let local_edge_index =
                    u8::try_from(local_edge_index).expect("three sides fit in u8");
                incidences_by_edge.entry(edge_nodes).or_default().push(
                    WaveguideCrossSectionHalfEdgeIR {
                        triangle_index: u64::try_from(triangle_index)
                            .expect("test triangle index fits u64"),
                        local_edge_index: WaveguideLocalEdgeIndex::try_from(local_edge_index)
                            .expect("local side is in the wire range"),
                    },
                );
            }
        }
        let edges = incidences_by_edge
            .into_iter()
            .map(|(nodes, incidences)| WaveguideCrossSectionEdgeIR { nodes, incidences })
            .collect();

        let contour = |boundary_component_id: &str, triangle_index: u64| {
            WaveguideCrossSectionBoundaryComponentIR {
                boundary_component_id: boundary_component_id.to_string(),
                region_id: "same-region".to_string(),
                loop_kind: WaveguideCrossSectionLoopKindIR::Outer,
                half_edges: (0_u8..3_u8)
                    .map(|local_edge_index| WaveguideCrossSectionHalfEdgeIR {
                        triangle_index,
                        local_edge_index: WaveguideLocalEdgeIndex::try_from(local_edge_index)
                            .expect("local side is in the wire range"),
                    })
                    .collect(),
            }
        };

        WaveguideCrossSectionMeshIR {
            schema: WaveguideCrossSectionMeshSchemaIR::V1,
            nodes_uv_m,
            triangles,
            edges,
            regions: vec![WaveguideCrossSectionRegionIR::Magnetic {
                region_id: "same-region".to_string(),
                object_id: "object-same".to_string(),
                material_id: "material-same".to_string(),
            }],
            boundary_components: vec![contour("outer-a", 0), contour("outer-b", 1)],
        }
    }

    fn test_bounds(min_u: f64, max_u: f64, min_v: f64, max_v: f64) -> Aabb {
        Aabb {
            min_u: binary64_order_key(min_u),
            max_u: binary64_order_key(max_u),
            min_v: binary64_order_key(min_v),
            max_v: binary64_order_key(max_v),
        }
    }

    fn sweep_test_candidates(
        bounds: &[Aabb],
        query_points: &[(f64, f64)],
    ) -> BTreeSet<(usize, usize)> {
        let mut interval_index =
            ActiveIntervalIndex::new(bounds).expect("small test interval index fits");
        let mut insertion_order = (0..bounds.len()).collect::<Vec<_>>();
        insertion_order.sort_unstable_by_key(|item_index| {
            (
                bounds[*item_index].min_u,
                bounds[*item_index].max_u,
                *item_index,
            )
        });
        let mut query_order = (0..query_points.len()).collect::<Vec<_>>();
        query_order.sort_unstable_by_key(|query_index| {
            (
                binary64_order_key(query_points[*query_index].0),
                *query_index,
            )
        });
        let mut expiration = BinaryHeap::<Reverse<(u64, usize)>>::new();
        let mut next_to_insert = 0_usize;
        let mut candidates = Vec::<usize>::new();
        let mut pairs = BTreeSet::new();

        for query_index in query_order {
            let query_u = binary64_order_key(query_points[query_index].0);
            let query_v = binary64_order_key(query_points[query_index].1);
            while next_to_insert < insertion_order.len() {
                let item_index = insertion_order[next_to_insert];
                if bounds[item_index].min_u > query_u {
                    break;
                }
                interval_index.insert(item_index);
                expiration.push(Reverse((bounds[item_index].max_u, item_index)));
                next_to_insert += 1;
            }
            while let Some(Reverse((active_max_u, item_index))) = expiration.peek().copied() {
                if active_max_u >= query_u {
                    break;
                }
                expiration.pop();
                interval_index.remove(item_index);
            }
            candidates.clear();
            interval_index.query(query_v, query_v, &mut candidates);
            for candidate_index in candidates.iter().copied() {
                if candidate_index != query_index {
                    pairs.insert((query_index, candidate_index));
                }
            }
        }
        pairs
    }

    #[test]
    fn shared_fixture_reports_exact_contour_work() {
        let report = validate_waveguide_mesh_contours(&shared_fixture())
            .expect("shared magnetic-in-air fixture has oriented nested contours");
        assert_eq!(report.boundary_component_count(), 3);
        assert_eq!(report.outer_count(), 2);
        assert_eq!(report.hole_count(), 1);
        assert_eq!(report.maximum_nesting_depth(), 1);
        assert_eq!(report.containment_candidate_count(), 1);
        assert_eq!(report.signed_area_edge_terms(), 20);
        assert_eq!(report.point_location_orientation_tests(), 12);
    }

    #[test]
    fn flipped_loop_tags_fail_after_embedding_prerequisite() {
        let mut mesh = shared_fixture();
        for component in &mut mesh.boundary_components {
            component.loop_kind = match component.loop_kind {
                WaveguideCrossSectionLoopKindIR::Outer => WaveguideCrossSectionLoopKindIR::Hole,
                WaveguideCrossSectionLoopKindIR::Hole => WaveguideCrossSectionLoopKindIR::Outer,
            };
        }
        assert!(matches!(
            validate_waveguide_mesh_contours(&mesh),
            Err(WaveguideMeshContoursError::SignedAreaOrientationMismatch { .. })
        ));
    }

    #[test]
    fn disjoint_same_region_outer_contours_have_depth_zero() {
        let report = validate_waveguide_mesh_contours(&disjoint_outer_mesh())
            .expect("disjoint outer contours in one region are legal");
        assert_eq!(report.boundary_component_count(), 2);
        assert_eq!(report.outer_count(), 2);
        assert_eq!(report.hole_count(), 0);
        assert_eq!(report.maximum_nesting_depth(), 0);
        assert_eq!(report.containment_candidate_count(), 0);
    }

    #[test]
    fn nested_region_fixture_allows_outer_island_at_depth_two() {
        let report = validate_waveguide_mesh_contours(&nested_fixture())
            .expect("alternating same-region nesting is legal");
        assert_eq!(report.boundary_component_count(), 5);
        assert_eq!(report.outer_count(), 3);
        assert_eq!(report.hole_count(), 2);
        assert_eq!(report.maximum_nesting_depth(), 2);
        assert_eq!(report.containment_candidate_count(), 4);
        assert_eq!(report.signed_area_edge_terms(), 20);
        assert_eq!(report.point_location_orientation_tests(), 16);
    }

    #[test]
    fn embedding_prerequisite_error_type_is_preserved() {
        let mut mesh = shared_fixture();
        mesh.nodes_uv_m[0][0] = f64::NAN;
        let error = validate_waveguide_mesh_contours(&mesh)
            .expect_err("non-finite coordinates fail the embedding prerequisite");
        assert!(matches!(
            error.embedding_error(),
            Some(WaveguideMeshEmbeddingError::Elements(_))
        ));
    }

    #[test]
    fn exact_area_sign_distinguishes_counterclockwise_clockwise_and_zero() {
        let coordinates = vec![
            integer_point(0, 0),
            integer_point(2, 0),
            integer_point(0, 2),
            integer_point(1, 0),
        ];
        let mut terms = 0_usize;
        let positive = signed_contour_area_exact(&[0, 1, 2], &coordinates, 0, &mut terms)
            .expect("counterclockwise contour has an exact area");
        let negative = signed_contour_area_exact(&[0, 2, 1], &coordinates, 1, &mut terms)
            .expect("clockwise contour has an exact area");
        let zero = signed_contour_area_exact(&[0, 1, 3], &coordinates, 2, &mut terms)
            .expect("collinear contour has an exact area");
        assert_eq!(positive.sign(), Sign::Plus);
        assert_eq!(negative.sign(), Sign::Minus);
        assert_eq!(zero.sign(), Sign::NoSign);
        assert_eq!(terms, 9);
    }

    #[test]
    fn exact_area_uses_big_integers_for_tiny_and_huge_binary64_values() {
        let smallest = f64::from_bits(1);
        let tiny_coordinates = exact_points(&[[0.0, 0.0], [smallest, 0.0], [0.0, smallest]])
            .expect("finite subnormal coordinates have exact integer encodings");
        let mut terms = 0_usize;
        let tiny_area = signed_contour_area_exact(&[0, 1, 2], &tiny_coordinates, 0, &mut terms)
            .expect("subnormal area remains an exact nonzero integer");
        assert_eq!(tiny_area.sign(), Sign::Plus);

        let maximum = f64::MAX;
        let huge_coordinates =
            exact_points(&[[-maximum, -maximum], [maximum, -maximum], [0.0, maximum]])
                .expect("finite extreme coordinates have exact integer encodings");
        let huge_area = signed_contour_area_exact(&[0, 1, 2], &huge_coordinates, 1, &mut terms)
            .expect("large area remains an exact BigInt");
        assert_eq!(huge_area.sign(), Sign::Plus);
    }

    #[test]
    fn point_location_handles_inside_outside_boundary_for_both_windings() {
        let counterclockwise = [(0, 0), (4, 0), (4, 4), (0, 4)];
        let clockwise = [(0, 4), (4, 4), (4, 0), (0, 0)];
        for vertices in [counterclockwise.to_vec(), clockwise.to_vec()] {
            assert_eq!(
                locate_integer_polygon(&vertices, (2, 2)).0,
                PointLocation::Inside
            );
            assert_eq!(
                locate_integer_polygon(&vertices, (5, 2)).0,
                PointLocation::Outside
            );
            assert_eq!(
                locate_integer_polygon(&vertices, (0, 2)).0,
                PointLocation::Boundary
            );
        }
    }

    #[test]
    fn concave_location_uses_half_open_vertex_and_horizontal_edge_rules() {
        let concave = [
            (-1, 0),
            (4, 0),
            (4, 4),
            (3, 4),
            (3, 1),
            (1, 1),
            (1, 4),
            (-1, 4),
        ];
        let (inside, vertex_ray_tests) = locate_integer_polygon(&concave, (0, 1));
        assert_eq!(inside, PointLocation::Inside);
        assert_eq!(vertex_ray_tests, concave.len());
        assert_eq!(
            locate_integer_polygon(&concave, (2, 2)).0,
            PointLocation::Outside
        );
        assert_eq!(
            locate_integer_polygon(&concave, (2, 1)).0,
            PointLocation::Boundary
        );
        assert_eq!(
            locate_integer_polygon(&concave, (5, 2)).0,
            PointLocation::Outside
        );
    }

    #[test]
    fn point_aabb_sweep_matches_inclusive_brute_force_under_permutations() {
        let base_bounds = [
            test_bounds(0.0, 4.0, 0.0, 4.0),
            test_bounds(2.0, 6.0, 4.0, 8.0),
            test_bounds(4.0, 7.0, 1.0, 3.0),
            test_bounds(7.0, 8.0, 8.0, 9.0),
        ];
        let base_queries = [(3.0, 4.0), (4.0, 4.0), (6.0, 2.0), (8.0, 8.0)];
        let mut expected = BTreeSet::new();
        for (query_index, (query_u, query_v)) in base_queries.iter().copied().enumerate() {
            let query_u = binary64_order_key(query_u);
            let query_v = binary64_order_key(query_v);
            for (candidate_index, bounds) in base_bounds.iter().copied().enumerate() {
                if candidate_index != query_index
                    && bounds.min_u <= query_u
                    && query_u <= bounds.max_u
                    && bounds.min_v <= query_v
                    && query_v <= bounds.max_v
                {
                    expected.insert((query_index, candidate_index));
                }
            }
        }

        let permutations = [[0, 1, 2, 3], [3, 2, 1, 0], [1, 3, 0, 2], [2, 0, 3, 1]];
        for permutation in permutations {
            let bounds = permutation.map(|index| base_bounds[index]);
            let queries = permutation.map(|index| base_queries[index]);
            let permuted_pairs = sweep_test_candidates(&bounds, &queries);
            let mapped_pairs = permuted_pairs
                .into_iter()
                .map(|(query_index, candidate_index)| {
                    (permutation[query_index], permutation[candidate_index])
                })
                .collect::<BTreeSet<_>>();
            assert_eq!(mapped_pairs, expected);
        }
    }
}
