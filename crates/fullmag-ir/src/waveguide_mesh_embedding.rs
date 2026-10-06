//! Exact geometric embedding checks for the raw waveguide cross-section mesh.
//!
//! This stage composes the existing element and incidence validators, then
//! checks the whole scalar mesh for segment conflicts and strict containment.
//! Its report is descriptive telemetry, not a certificate or admission decision.

use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet, BinaryHeap};
use std::error::Error;
use std::fmt;

use num_bigint::{BigInt, Sign};
use serde::Serialize;

use crate::waveguide_mesh::WaveguideCrossSectionMeshIR;
use crate::waveguide_mesh_elements::{
    validate_waveguide_mesh_elements, WaveguideMeshElementsError,
};
use crate::waveguide_mesh_incidence::{
    validate_waveguide_mesh_incidence, WaveguideMeshIncidenceError,
};

/// A counter whose checked increment can fail during embedding validation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaveguideMeshEmbeddingCounter {
    EdgeAabbCandidatePairs,
    TriangleAabbCandidatePairs,
    ExactOrientationTests,
}

/// Structured failure from geometric embedding validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WaveguideMeshEmbeddingError {
    Elements(WaveguideMeshElementsError),
    Incidence(WaveguideMeshIncidenceError),
    NonFiniteNodeCoordinate {
        node_index: usize,
        coordinate_index: usize,
    },
    EdgeNodeIndexNotRepresentable {
        edge_index: usize,
        node_slot: usize,
        node_index: u64,
    },
    EdgeNodeIndexOutOfBounds {
        edge_index: usize,
        node_slot: usize,
        node_index: u64,
    },
    TriangleNodeIndexNotRepresentable {
        triangle_index: usize,
        node_slot: usize,
        node_index: u64,
    },
    TriangleNodeIndexOutOfBounds {
        triangle_index: usize,
        node_slot: usize,
        node_index: u64,
    },
    ProperEdgeCrossing {
        first_edge_index: usize,
        second_edge_index: usize,
    },
    CollinearEdgeOverlap {
        first_edge_index: usize,
        second_edge_index: usize,
    },
    EdgeContactWithoutSharedNode {
        first_edge_index: usize,
        second_edge_index: usize,
    },
    StrictTriangleContainment {
        container_triangle_index: usize,
        contained_triangle_index: usize,
    },
    CounterOverflow {
        counter: WaveguideMeshEmbeddingCounter,
    },
    IndexCapacityOverflow,
}

impl WaveguideMeshEmbeddingError {
    /// Return the prerequisite element error without converting its type.
    pub fn elements_error(&self) -> Option<&WaveguideMeshElementsError> {
        match self {
            Self::Elements(error) => Some(error),
            _ => None,
        }
    }

    /// Return the prerequisite incidence error without converting its type.
    pub fn incidence_error(&self) -> Option<&WaveguideMeshIncidenceError> {
        match self {
            Self::Incidence(error) => Some(error),
            _ => None,
        }
    }
}

impl fmt::Display for WaveguideMeshEmbeddingError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "waveguide mesh embedding error: {self:?}")
    }
}

impl Error for WaveguideMeshEmbeddingError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Elements(error) => Some(error),
            Self::Incidence(error) => Some(error),
            _ => None,
        }
    }
}

/// Candidate and exact-predicate counts produced by embedding checks.
///
/// These values describe work actually evaluated. They do not certify mesh
/// validity, solver admission, or provider/runtime support.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WaveguideMeshEmbeddingReport {
    node_count: usize,
    edge_count: usize,
    triangle_count: usize,
    edge_aabb_candidate_pair_count: usize,
    triangle_aabb_candidate_pair_count: usize,
    exact_orientation_test_count: usize,
}

impl WaveguideMeshEmbeddingReport {
    pub const fn node_count(&self) -> usize {
        self.node_count
    }

    pub const fn edge_count(&self) -> usize {
        self.edge_count
    }

    pub const fn triangle_count(&self) -> usize {
        self.triangle_count
    }

    pub const fn edge_aabb_candidate_pair_count(&self) -> usize {
        self.edge_aabb_candidate_pair_count
    }

    pub const fn triangle_aabb_candidate_pair_count(&self) -> usize {
        self.triangle_aabb_candidate_pair_count
    }

    pub const fn exact_orientation_test_count(&self) -> usize {
        self.exact_orientation_test_count
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ExactPoint {
    pub(crate) coordinates: [BigInt; 2],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Aabb {
    pub(crate) min_u: u64,
    pub(crate) max_u: u64,
    pub(crate) min_v: u64,
    pub(crate) max_v: u64,
}

impl Aabb {
    pub(crate) fn from_node_indices(node_indices: &[usize], nodes: &[[f64; 2]]) -> Self {
        let first = nodes[node_indices[0]];
        let (mut min_u, mut max_u) = (first[0], first[0]);
        let (mut min_v, mut max_v) = (first[1], first[1]);

        for node_index in node_indices.iter().copied().skip(1) {
            let point = nodes[node_index];
            if point[0] < min_u {
                min_u = point[0];
            }
            if point[0] > max_u {
                max_u = point[0];
            }
            if point[1] < min_v {
                min_v = point[1];
            }
            if point[1] > max_v {
                max_v = point[1];
            }
        }

        Self {
            min_u: binary64_order_key(min_u),
            max_u: binary64_order_key(max_u),
            min_v: binary64_order_key(min_v),
            max_v: binary64_order_key(max_v),
        }
    }

    fn overlaps(self, other: Self) -> bool {
        self.min_u <= other.max_u
            && other.min_u <= self.max_u
            && self.min_v <= other.max_v
            && other.min_v <= self.max_v
    }
}

pub(crate) fn binary64_order_key(value: f64) -> u64 {
    let bits = if value == 0.0 { 0 } else { value.to_bits() };
    if bits >> 63 == 0 {
        bits ^ (1_u64 << 63)
    } else {
        !bits
    }
}

/// Encode one finite binary64 value exactly in units of 2^-1074.
fn exact_binary64_integer(value: f64) -> Option<BigInt> {
    let bits = value.to_bits();
    let negative = bits >> 63 != 0;
    let exponent = ((bits >> 52) & 0x7ff) as u16;
    let fraction = bits & 0x000f_ffff_ffff_ffff;

    if exponent == 0x7ff {
        return None;
    }

    let significand = if exponent == 0 {
        fraction
    } else {
        (1_u64 << 52) | fraction
    };
    let shift = if exponent == 0 {
        0
    } else {
        usize::from(exponent - 1)
    };
    let magnitude = BigInt::from(significand) << shift;

    Some(if negative { -magnitude } else { magnitude })
}

/// Return the exact orientation sign of three cached binary64 coordinates.
pub(crate) fn orient2d_exact(a: &ExactPoint, b: &ExactPoint, c: &ExactPoint) -> Sign {
    let determinant = (&b.coordinates[0] - &a.coordinates[0])
        * (&c.coordinates[1] - &a.coordinates[1])
        - (&b.coordinates[1] - &a.coordinates[1]) * (&c.coordinates[0] - &a.coordinates[0]);
    determinant.sign()
}

fn increment_counter(
    counter: &mut usize,
    kind: WaveguideMeshEmbeddingCounter,
) -> Result<(), WaveguideMeshEmbeddingError> {
    *counter = counter
        .checked_add(1)
        .ok_or(WaveguideMeshEmbeddingError::CounterOverflow { counter: kind })?;
    Ok(())
}

fn checked_edge_node_indices(
    mesh: &WaveguideCrossSectionMeshIR,
) -> Result<Vec<[usize; 2]>, WaveguideMeshEmbeddingError> {
    mesh.edges
        .iter()
        .enumerate()
        .map(|(edge_index, edge)| {
            let mut checked = [0_usize; 2];
            for node_slot in 0..2 {
                let raw_index = edge.nodes[node_slot];
                let node_index = usize::try_from(raw_index).map_err(|_| {
                    WaveguideMeshEmbeddingError::EdgeNodeIndexNotRepresentable {
                        edge_index,
                        node_slot,
                        node_index: raw_index,
                    }
                })?;
                if node_index >= mesh.nodes_uv_m.len() {
                    return Err(WaveguideMeshEmbeddingError::EdgeNodeIndexOutOfBounds {
                        edge_index,
                        node_slot,
                        node_index: raw_index,
                    });
                }
                checked[node_slot] = node_index;
            }
            Ok(checked)
        })
        .collect()
}

fn checked_triangle_node_indices(
    mesh: &WaveguideCrossSectionMeshIR,
) -> Result<Vec<[usize; 3]>, WaveguideMeshEmbeddingError> {
    mesh.triangles
        .iter()
        .enumerate()
        .map(|(triangle_index, triangle)| {
            let mut checked = [0_usize; 3];
            for node_slot in 0..3 {
                let raw_index = triangle.nodes[node_slot];
                let node_index = usize::try_from(raw_index).map_err(|_| {
                    WaveguideMeshEmbeddingError::TriangleNodeIndexNotRepresentable {
                        triangle_index,
                        node_slot,
                        node_index: raw_index,
                    }
                })?;
                if node_index >= mesh.nodes_uv_m.len() {
                    return Err(WaveguideMeshEmbeddingError::TriangleNodeIndexOutOfBounds {
                        triangle_index,
                        node_slot,
                        node_index: raw_index,
                    });
                }
                checked[node_slot] = node_index;
            }
            Ok(checked)
        })
        .collect()
}

pub(crate) fn exact_points(
    nodes: &[[f64; 2]],
) -> Result<Vec<ExactPoint>, WaveguideMeshEmbeddingError> {
    nodes
        .iter()
        .enumerate()
        .map(|(node_index, point)| {
            let mut coordinates = [BigInt::from(0_u8), BigInt::from(0_u8)];
            for coordinate_index in 0..2 {
                coordinates[coordinate_index] = exact_binary64_integer(point[coordinate_index])
                    .ok_or(WaveguideMeshEmbeddingError::NonFiniteNodeCoordinate {
                        node_index,
                        coordinate_index,
                    })?;
            }
            Ok(ExactPoint { coordinates })
        })
        .collect()
}

#[derive(Debug)]
pub(crate) struct ActiveIntervalIndex {
    minimum_v_keys: Vec<u64>,
    active_by_leaf: Vec<BTreeMap<u64, BTreeSet<usize>>>,
    subtree_maximum_v: Vec<Option<u64>>,
    leaf_by_item: Vec<usize>,
    maximum_v_by_item: Vec<u64>,
}

impl ActiveIntervalIndex {
    pub(crate) fn new(bounds: &[Aabb]) -> Result<Self, WaveguideMeshEmbeddingError> {
        let mut minimum_v_keys = bounds.iter().map(|item| item.min_v).collect::<Vec<_>>();
        minimum_v_keys.sort_unstable();
        minimum_v_keys.dedup();

        let tree_len = minimum_v_keys
            .len()
            .checked_mul(4)
            .ok_or(WaveguideMeshEmbeddingError::IndexCapacityOverflow)?;
        let mut index = Self {
            active_by_leaf: (0..minimum_v_keys.len()).map(|_| BTreeMap::new()).collect(),
            subtree_maximum_v: vec![None; tree_len.max(4)],
            leaf_by_item: Vec::with_capacity(bounds.len()),
            maximum_v_by_item: Vec::with_capacity(bounds.len()),
            minimum_v_keys,
        };

        for bound in bounds {
            let leaf = index
                .minimum_v_keys
                .binary_search(&bound.min_v)
                .map_err(|_| WaveguideMeshEmbeddingError::IndexCapacityOverflow)?;
            index.leaf_by_item.push(leaf);
            index.maximum_v_by_item.push(bound.max_v);
        }

        Ok(index)
    }

    pub(crate) fn insert(&mut self, item_index: usize) {
        let leaf = self.leaf_by_item[item_index];
        let max_v = self.maximum_v_by_item[item_index];
        self.active_by_leaf[leaf]
            .entry(max_v)
            .or_default()
            .insert(item_index);
        self.update_leaf(leaf);
    }

    pub(crate) fn remove(&mut self, item_index: usize) {
        let leaf = self.leaf_by_item[item_index];
        let max_v = self.maximum_v_by_item[item_index];
        let should_remove_key = match self.active_by_leaf[leaf].get_mut(&max_v) {
            Some(items) => {
                items.remove(&item_index);
                items.is_empty()
            }
            None => false,
        };
        if should_remove_key {
            self.active_by_leaf[leaf].remove(&max_v);
        }
        self.update_leaf(leaf);
    }

    fn update_leaf(&mut self, leaf: usize) {
        let maximum = self.active_by_leaf[leaf].keys().next_back().copied();
        self.update_node(1, 0, self.minimum_v_keys.len() - 1, leaf, maximum);
    }

    fn update_node(
        &mut self,
        node: usize,
        left: usize,
        right: usize,
        target_leaf: usize,
        value: Option<u64>,
    ) {
        if left == right {
            self.subtree_maximum_v[node] = value;
            return;
        }

        let middle = left + (right - left) / 2;
        if target_leaf <= middle {
            self.update_node(node * 2, left, middle, target_leaf, value);
        } else {
            self.update_node(node * 2 + 1, middle + 1, right, target_leaf, value);
        }

        self.subtree_maximum_v[node] = match (
            self.subtree_maximum_v[node * 2],
            self.subtree_maximum_v[node * 2 + 1],
        ) {
            (Some(first), Some(second)) => Some(first.max(second)),
            (Some(value), None) | (None, Some(value)) => Some(value),
            (None, None) => None,
        };
    }

    pub(crate) fn query(&self, min_v: u64, max_v: u64, output: &mut Vec<usize>) {
        if self.minimum_v_keys.is_empty() {
            return;
        }
        self.query_node(1, 0, self.minimum_v_keys.len() - 1, min_v, max_v, output);
    }

    fn query_node(
        &self,
        node: usize,
        left: usize,
        right: usize,
        min_v: u64,
        max_v: u64,
        output: &mut Vec<usize>,
    ) {
        let Some(subtree_max_v) = self.subtree_maximum_v[node] else {
            return;
        };
        if subtree_max_v < min_v || self.minimum_v_keys[left] > max_v {
            return;
        }

        if left == right {
            for (_, items) in self.active_by_leaf[left].range(min_v..) {
                output.extend(items.iter().copied());
            }
            return;
        }

        let middle = left + (right - left) / 2;
        self.query_node(node * 2, left, middle, min_v, max_v, output);
        self.query_node(node * 2 + 1, middle + 1, right, min_v, max_v, output);
    }
}

fn sweep_aabb_candidates(
    bounds: &[Aabb],
    counter_kind: WaveguideMeshEmbeddingCounter,
    candidate_pair_count: &mut usize,
    mut on_pair: impl FnMut(usize, usize) -> Result<(), WaveguideMeshEmbeddingError>,
) -> Result<(), WaveguideMeshEmbeddingError> {
    if bounds.is_empty() {
        return Ok(());
    }

    let mut order = (0..bounds.len()).collect::<Vec<_>>();
    order.sort_unstable_by_key(|item_index| {
        (
            bounds[*item_index].min_u,
            bounds[*item_index].max_u,
            *item_index,
        )
    });

    let mut interval_index = ActiveIntervalIndex::new(bounds)?;
    let mut expiration = BinaryHeap::<Reverse<(u64, usize)>>::new();

    for current_index in order {
        let current = bounds[current_index];

        while let Some(Reverse((active_max_u, active_index))) = expiration.peek().copied() {
            if active_max_u >= current.min_u {
                break;
            }
            expiration.pop();
            interval_index.remove(active_index);
        }

        let mut candidates = Vec::new();
        interval_index.query(current.min_v, current.max_v, &mut candidates);
        candidates.sort_unstable();

        for active_index in candidates {
            increment_counter(candidate_pair_count, counter_kind)?;
            let (first_index, second_index) = if active_index < current_index {
                (active_index, current_index)
            } else {
                (current_index, active_index)
            };
            on_pair(first_index, second_index)?;
        }

        interval_index.insert(current_index);
        expiration.push(Reverse((current.max_u, current_index)));
    }

    Ok(())
}

fn exact_orientation_test(
    first: usize,
    second: usize,
    third: usize,
    points: &[ExactPoint],
    count: &mut usize,
) -> Result<Sign, WaveguideMeshEmbeddingError> {
    increment_counter(count, WaveguideMeshEmbeddingCounter::ExactOrientationTests)?;
    Ok(orient2d_exact(
        &points[first],
        &points[second],
        &points[third],
    ))
}

fn opposite_signs(first: Sign, second: Sign) -> bool {
    matches!(
        (first, second),
        (Sign::Minus, Sign::Plus) | (Sign::Plus, Sign::Minus)
    )
}

fn point_on_segment(point: &ExactPoint, first: &ExactPoint, second: &ExactPoint) -> bool {
    let u_min = if first.coordinates[0] <= second.coordinates[0] {
        &first.coordinates[0]
    } else {
        &second.coordinates[0]
    };
    let u_max = if first.coordinates[0] >= second.coordinates[0] {
        &first.coordinates[0]
    } else {
        &second.coordinates[0]
    };
    let v_min = if first.coordinates[1] <= second.coordinates[1] {
        &first.coordinates[1]
    } else {
        &second.coordinates[1]
    };
    let v_max = if first.coordinates[1] >= second.coordinates[1] {
        &first.coordinates[1]
    } else {
        &second.coordinates[1]
    };

    u_min <= &point.coordinates[0]
        && &point.coordinates[0] <= u_max
        && v_min <= &point.coordinates[1]
        && &point.coordinates[1] <= v_max
}

fn positive_collinear_overlap(
    first_start: usize,
    first_end: usize,
    second_start: usize,
    second_end: usize,
    points: &[ExactPoint],
) -> bool {
    let use_u_axis = points[first_start].coordinates[0] != points[first_end].coordinates[0]
        || points[second_start].coordinates[0] != points[second_end].coordinates[0];
    let axis = if use_u_axis { 0 } else { 1 };

    let first_a = &points[first_start].coordinates[axis];
    let first_b = &points[first_end].coordinates[axis];
    let second_a = &points[second_start].coordinates[axis];
    let second_b = &points[second_end].coordinates[axis];

    let first_min = if first_a <= first_b { first_a } else { first_b };
    let first_max = if first_a >= first_b { first_a } else { first_b };
    let second_min = if second_a <= second_b {
        second_a
    } else {
        second_b
    };
    let second_max = if second_a >= second_b {
        second_a
    } else {
        second_b
    };

    let overlap_min = if first_min >= second_min {
        first_min
    } else {
        second_min
    };
    let overlap_max = if first_max <= second_max {
        first_max
    } else {
        second_max
    };

    overlap_min < overlap_max
}

fn is_shared_endpoint(node_index: usize, other_edge: [usize; 2]) -> bool {
    node_index == other_edge[0] || node_index == other_edge[1]
}

fn check_edge_pair(
    first_edge_index: usize,
    second_edge_index: usize,
    edge_nodes: &[[usize; 2]],
    points: &[ExactPoint],
    orientation_test_count: &mut usize,
) -> Result<(), WaveguideMeshEmbeddingError> {
    let first = edge_nodes[first_edge_index];
    let second = edge_nodes[second_edge_index];

    let shared_endpoint_count = (if is_shared_endpoint(first[0], second) {
        1
    } else {
        0
    }) + (if is_shared_endpoint(first[1], second) {
        1
    } else {
        0
    });
    if shared_endpoint_count == 2 {
        return Ok(());
    }

    let first_start_vs_second_start = exact_orientation_test(
        first[0],
        first[1],
        second[0],
        points,
        orientation_test_count,
    )?;
    let first_start_vs_second_end = exact_orientation_test(
        first[0],
        first[1],
        second[1],
        points,
        orientation_test_count,
    )?;
    let second_start_vs_first_start = exact_orientation_test(
        second[0],
        second[1],
        first[0],
        points,
        orientation_test_count,
    )?;
    let second_start_vs_first_end = exact_orientation_test(
        second[0],
        second[1],
        first[1],
        points,
        orientation_test_count,
    )?;

    if opposite_signs(first_start_vs_second_start, first_start_vs_second_end)
        && opposite_signs(second_start_vs_first_start, second_start_vs_first_end)
    {
        return Err(WaveguideMeshEmbeddingError::ProperEdgeCrossing {
            first_edge_index,
            second_edge_index,
        });
    }

    if first_start_vs_second_start == Sign::NoSign
        && first_start_vs_second_end == Sign::NoSign
        && second_start_vs_first_start == Sign::NoSign
        && second_start_vs_first_end == Sign::NoSign
        && positive_collinear_overlap(first[0], first[1], second[0], second[1], points)
    {
        return Err(WaveguideMeshEmbeddingError::CollinearEdgeOverlap {
            first_edge_index,
            second_edge_index,
        });
    }

    let endpoint_contacts = [
        (
            second[0],
            first,
            first_start_vs_second_start,
            is_shared_endpoint(second[0], first),
        ),
        (
            second[1],
            first,
            first_start_vs_second_end,
            is_shared_endpoint(second[1], first),
        ),
        (
            first[0],
            second,
            second_start_vs_first_start,
            is_shared_endpoint(first[0], second),
        ),
        (
            first[1],
            second,
            second_start_vs_first_end,
            is_shared_endpoint(first[1], second),
        ),
    ];

    for (contact_node, segment, orientation, shared_node) in endpoint_contacts {
        if orientation == Sign::NoSign
            && point_on_segment(
                &points[contact_node],
                &points[segment[0]],
                &points[segment[1]],
            )
            && !shared_node
        {
            return Err(WaveguideMeshEmbeddingError::EdgeContactWithoutSharedNode {
                first_edge_index,
                second_edge_index,
            });
        }
    }

    Ok(())
}

fn triangle_strictly_contains(
    container_triangle_index: usize,
    candidate_triangle_index: usize,
    triangle_nodes: &[[usize; 3]],
    points: &[ExactPoint],
    orientation_test_count: &mut usize,
) -> Result<bool, WaveguideMeshEmbeddingError> {
    let container = triangle_nodes[container_triangle_index];
    let candidate = triangle_nodes[candidate_triangle_index];
    let mut strictly_inside = true;

    for candidate_vertex in candidate {
        for local_edge in 0..3 {
            let start = container[local_edge];
            let end = container[(local_edge + 1) % 3];
            let orientation = exact_orientation_test(
                start,
                end,
                candidate_vertex,
                points,
                orientation_test_count,
            )?;
            strictly_inside &= orientation == Sign::Plus;
        }
    }

    Ok(strictly_inside)
}

fn check_triangle_pair(
    first_triangle_index: usize,
    second_triangle_index: usize,
    triangle_nodes: &[[usize; 3]],
    points: &[ExactPoint],
    orientation_test_count: &mut usize,
) -> Result<(), WaveguideMeshEmbeddingError> {
    if triangle_strictly_contains(
        first_triangle_index,
        second_triangle_index,
        triangle_nodes,
        points,
        orientation_test_count,
    )? {
        return Err(WaveguideMeshEmbeddingError::StrictTriangleContainment {
            container_triangle_index: first_triangle_index,
            contained_triangle_index: second_triangle_index,
        });
    }

    if triangle_strictly_contains(
        second_triangle_index,
        first_triangle_index,
        triangle_nodes,
        points,
        orientation_test_count,
    )? {
        return Err(WaveguideMeshEmbeddingError::StrictTriangleContainment {
            container_triangle_index: second_triangle_index,
            contained_triangle_index: first_triangle_index,
        });
    }

    Ok(())
}

/// Validate exact global geometric embedding after local element and
/// combinatorial incidence prerequisites pass.
///
/// This checks the whole scalar mesh, including air. It does not validate
/// outer/hole orientation or nesting, registries, frame invariance, boundary
/// conditions, provider availability, or solver admission.
pub fn validate_waveguide_mesh_embedding(
    mesh: &WaveguideCrossSectionMeshIR,
) -> Result<WaveguideMeshEmbeddingReport, WaveguideMeshEmbeddingError> {
    validate_waveguide_mesh_elements(mesh).map_err(WaveguideMeshEmbeddingError::Elements)?;
    validate_waveguide_mesh_incidence(mesh).map_err(WaveguideMeshEmbeddingError::Incidence)?;

    let edge_nodes = checked_edge_node_indices(mesh)?;
    let triangle_nodes = checked_triangle_node_indices(mesh)?;
    let exact_coordinates = exact_points(&mesh.nodes_uv_m)?;

    let edge_bounds = edge_nodes
        .iter()
        .map(|nodes| Aabb::from_node_indices(nodes, &mesh.nodes_uv_m))
        .collect::<Vec<_>>();
    let triangle_bounds = triangle_nodes
        .iter()
        .map(|nodes| Aabb::from_node_indices(nodes, &mesh.nodes_uv_m))
        .collect::<Vec<_>>();

    let mut edge_aabb_candidate_pair_count = 0;
    let mut triangle_aabb_candidate_pair_count = 0;
    let mut exact_orientation_test_count = 0;

    sweep_aabb_candidates(
        &edge_bounds,
        WaveguideMeshEmbeddingCounter::EdgeAabbCandidatePairs,
        &mut edge_aabb_candidate_pair_count,
        |first_edge_index, second_edge_index| {
            check_edge_pair(
                first_edge_index,
                second_edge_index,
                &edge_nodes,
                &exact_coordinates,
                &mut exact_orientation_test_count,
            )
        },
    )?;

    sweep_aabb_candidates(
        &triangle_bounds,
        WaveguideMeshEmbeddingCounter::TriangleAabbCandidatePairs,
        &mut triangle_aabb_candidate_pair_count,
        |first_triangle_index, second_triangle_index| {
            check_triangle_pair(
                first_triangle_index,
                second_triangle_index,
                &triangle_nodes,
                &exact_coordinates,
                &mut exact_orientation_test_count,
            )
        },
    )?;

    Ok(WaveguideMeshEmbeddingReport {
        node_count: mesh.nodes_uv_m.len(),
        edge_count: mesh.edges.len(),
        triangle_count: mesh.triangles.len(),
        edge_aabb_candidate_pair_count,
        triangle_aabb_candidate_pair_count,
        exact_orientation_test_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::waveguide_mesh::{
        WaveguideCrossSectionBoundaryComponentIR, WaveguideCrossSectionEdgeIR,
        WaveguideCrossSectionHalfEdgeIR, WaveguideCrossSectionLoopKindIR,
        WaveguideCrossSectionMeshSchemaIR, WaveguideCrossSectionRegionIR,
        WaveguideCrossSectionTriangleIR, WaveguideLocalEdgeIndex,
    };

    const SHARED_FIXTURE: &str =
        include_str!("../tests/fixtures/waveguide_cross_section_mesh.v1.json");

    fn fixture_mesh() -> WaveguideCrossSectionMeshIR {
        serde_json::from_str(SHARED_FIXTURE).expect("shared waveguide fixture must parse")
    }

    fn two_triangle_mesh(points: [[f64; 2]; 6]) -> WaveguideCrossSectionMeshIR {
        let triangles = vec![
            WaveguideCrossSectionTriangleIR {
                nodes: [0, 1, 2],
                region_id: "region-a".to_string(),
            },
            WaveguideCrossSectionTriangleIR {
                nodes: [3, 4, 5],
                region_id: "region-b".to_string(),
            },
        ];

        let mut edges = Vec::with_capacity(6);
        let mut boundary_components = Vec::with_capacity(2);
        for (triangle_index, triangle) in triangles.iter().enumerate() {
            let mut half_edges = Vec::with_capacity(3);
            for local_edge_index in 0..3 {
                let start = triangle.nodes[local_edge_index];
                let end = triangle.nodes[(local_edge_index + 1) % 3];
                let incidence = WaveguideCrossSectionHalfEdgeIR {
                    triangle_index: triangle_index as u64,
                    local_edge_index: WaveguideLocalEdgeIndex::try_from(local_edge_index as u8)
                        .expect("triangle local edge is in range"),
                };
                half_edges.push(incidence);
                edges.push(WaveguideCrossSectionEdgeIR {
                    nodes: [start.min(end), start.max(end)],
                    incidences: vec![incidence],
                });
            }
            boundary_components.push(WaveguideCrossSectionBoundaryComponentIR {
                boundary_component_id: format!("boundary-{triangle_index}"),
                region_id: triangle.region_id.clone(),
                loop_kind: WaveguideCrossSectionLoopKindIR::Outer,
                half_edges,
            });
        }

        WaveguideCrossSectionMeshIR {
            schema: WaveguideCrossSectionMeshSchemaIR::V1,
            nodes_uv_m: points.to_vec(),
            triangles,
            edges,
            regions: vec![
                WaveguideCrossSectionRegionIR::Magnetic {
                    region_id: "region-a".to_string(),
                    object_id: "object-a".to_string(),
                    material_id: "material-a".to_string(),
                },
                WaveguideCrossSectionRegionIR::Magnetic {
                    region_id: "region-b".to_string(),
                    object_id: "object-b".to_string(),
                    material_id: "material-b".to_string(),
                },
            ],
            boundary_components,
        }
    }

    fn pair_error(points: [[f64; 2]; 6]) -> WaveguideMeshEmbeddingError {
        validate_waveguide_mesh_embedding(&two_triangle_mesh(points))
            .expect_err("the geometric conflict must be rejected")
    }

    fn exact_point(u: f64, v: f64) -> ExactPoint {
        ExactPoint {
            coordinates: [
                exact_binary64_integer(u).expect("finite u coordinate"),
                exact_binary64_integer(v).expect("finite v coordinate"),
            ],
        }
    }

    fn test_aabb(min_u: f64, max_u: f64, min_v: f64, max_v: f64) -> Aabb {
        Aabb {
            min_u: binary64_order_key(min_u),
            max_u: binary64_order_key(max_u),
            min_v: binary64_order_key(min_v),
            max_v: binary64_order_key(max_v),
        }
    }

    #[test]
    fn shared_fixture_passes_with_measured_broad_phase_counts() {
        let report = validate_waveguide_mesh_embedding(&fixture_mesh())
            .expect("the shared conforming fixture must pass");

        assert_eq!(report.node_count(), 16);
        assert_eq!(report.edge_count(), 33);
        assert_eq!(report.triangle_count(), 18);
        assert_eq!(report.edge_aabb_candidate_pair_count(), 156);
        assert_eq!(report.triangle_aabb_candidate_pair_count(), 89);
        assert_eq!(report.exact_orientation_test_count(), 2_226);
    }

    #[test]
    fn disjoint_scalar_components_pass_without_cross_component_candidates() {
        let mesh = two_triangle_mesh([
            [0.0, 0.0],
            [1.0, 0.0],
            [0.0, 1.0],
            [10.0, 0.0],
            [11.0, 0.0],
            [10.0, 1.0],
        ]);
        let report =
            validate_waveguide_mesh_embedding(&mesh).expect("disjoint components are legal");

        assert_eq!(report.edge_aabb_candidate_pair_count(), 6);
        assert_eq!(report.triangle_aabb_candidate_pair_count(), 0);
    }

    #[test]
    fn outer_and_hole_tags_are_not_certified_by_embedding_validation() {
        let mut mesh = fixture_mesh();
        for component in &mut mesh.boundary_components {
            component.loop_kind = WaveguideCrossSectionLoopKindIR::Hole;
        }

        assert!(
            validate_waveguide_mesh_embedding(&mesh).is_ok(),
            "loop-kind orientation and nesting belong to another gate"
        );
    }

    #[test]
    fn proper_crossing_is_rejected() {
        let error = pair_error([
            [0.0, 0.0],
            [4.0, 0.0],
            [2.0, 4.0],
            [-1.0, 2.0],
            [2.0, -2.0],
            [5.0, 2.0],
        ]);
        assert!(matches!(
            error,
            WaveguideMeshEmbeddingError::ProperEdgeCrossing { .. }
        ));
    }

    #[test]
    fn positive_length_collinear_overlap_is_rejected() {
        // Keep local element/incidence prerequisites valid, and place the
        // second apex beyond the first edge so the overlapping base pair is
        // visited before endpoint contacts from the slanted edges.
        let mesh = two_triangle_mesh([
            [0.0, 0.0],
            [4.0, 0.0],
            [2.0, 3.0],
            [3.0, 0.0],
            [1.0, 0.0],
            [5.0, -1.0],
        ]);
        validate_waveguide_mesh_elements(&mesh)
            .expect("overlap fixture must pass local triangle validation");
        validate_waveguide_mesh_incidence(&mesh)
            .expect("overlap fixture must pass combinatorial incidence validation");
        let error = validate_waveguide_mesh_embedding(&mesh)
            .expect_err("positive-length collinear edge overlap must be rejected");
        assert!(matches!(
            error,
            WaveguideMeshEmbeddingError::CollinearEdgeOverlap {
                first_edge_index: 0,
                second_edge_index: 3,
            }
        ));
    }

    #[test]
    fn endpoint_on_another_edge_is_rejected_without_shared_node_identity() {
        let error = pair_error([
            [0.0, 0.0],
            [4.0, 0.0],
            [2.0, 3.0],
            [1.0, 0.0],
            [0.5, -1.0],
            [1.5, -1.0],
        ]);
        assert!(matches!(
            error,
            WaveguideMeshEmbeddingError::EdgeContactWithoutSharedNode { .. }
        ));
    }

    #[test]
    fn strict_triangle_containment_is_rejected_after_edge_checks() {
        let error = pair_error([
            [0.0, 0.0],
            [4.0, 0.0],
            [2.0, 4.0],
            [0.75, 0.5],
            [3.25, 0.5],
            [2.0, 2.0],
        ]);
        assert!(matches!(
            error,
            WaveguideMeshEmbeddingError::StrictTriangleContainment { .. }
        ));
    }

    #[test]
    fn exact_binary64_integer_handles_signed_zero_subnormals_and_extremes() {
        let zero = exact_binary64_integer(0.0).expect("zero is finite");
        assert_eq!(exact_binary64_integer(-0.0), Some(zero.clone()));
        assert_eq!(
            exact_binary64_integer(f64::from_bits(1)),
            Some(BigInt::from(1_u8))
        );
        assert_eq!(
            exact_binary64_integer(f64::from_bits((1_u64 << 63) | 1)),
            Some(BigInt::from(-1_i8))
        );

        let maximum = f64::from_bits(0x7fef_ffff_ffff_ffff);
        let maximum_integer = BigInt::from((1_u64 << 53) - 1) << 2_045_usize;
        assert_eq!(
            exact_binary64_integer(maximum),
            Some(maximum_integer.clone())
        );
        assert_eq!(exact_binary64_integer(-maximum), Some(-maximum_integer));
        assert!(exact_binary64_integer(f64::INFINITY).is_none());
        assert!(exact_binary64_integer(f64::NAN).is_none());
    }

    #[test]
    fn exact_orientation_handles_subnormal_and_extreme_finite_coordinates() {
        let smallest = f64::from_bits(1);
        assert_eq!(
            orient2d_exact(
                &exact_point(0.0, 0.0),
                &exact_point(smallest, 0.0),
                &exact_point(0.0, smallest)
            ),
            Sign::Plus
        );

        let maximum = f64::MAX;
        let next_below_maximum = f64::from_bits(maximum.to_bits() - 1);
        assert_eq!(
            orient2d_exact(
                &exact_point(maximum, maximum),
                &exact_point(-maximum, maximum),
                &exact_point(maximum, next_below_maximum)
            ),
            Sign::Plus
        );
    }

    #[test]
    fn active_interval_sweep_matches_inclusive_bruteforce_under_permutation() {
        let boxes = [
            test_aabb(0.0, 0.0, 0.0, 0.0),
            test_aabb(0.0, 1.0, 0.0, 1.0),
            test_aabb(1.0, 2.0, 0.0, 1.0),
            test_aabb(2.0, 2.0, 2.0, 2.0),
            test_aabb(-1.0, 0.0, 0.0, 0.0),
            test_aabb(0.5, 0.5, -2.0, -1.0),
        ];
        let expected = (0..boxes.len())
            .flat_map(|first| (first + 1..boxes.len()).map(move |second| (first, second)))
            .filter(|(first, second)| boxes[*first].overlaps(boxes[*second]))
            .collect::<BTreeSet<_>>();

        for permutation in [[0, 1, 2, 3, 4, 5], [4, 2, 0, 5, 1, 3], [3, 5, 1, 4, 0, 2]] {
            let permuted = permutation.map(|index| boxes[index]);
            let mut actual = BTreeSet::new();
            let mut candidate_count = 0;
            sweep_aabb_candidates(
                &permuted,
                WaveguideMeshEmbeddingCounter::EdgeAabbCandidatePairs,
                &mut candidate_count,
                |first, second| {
                    let mapped = (permutation[first], permutation[second]);
                    actual.insert((mapped.0.min(mapped.1), mapped.0.max(mapped.1)));
                    Ok(())
                },
            )
            .expect("the small sweep cannot overflow");

            assert_eq!(actual, expected);
            assert_eq!(candidate_count, expected.len());
        }
    }
}
