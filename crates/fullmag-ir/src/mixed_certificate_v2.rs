//! Canonical validation for the disconnected-body mixed-P1 certificate.
//!
//! V2 cannot be validated by the historical v1 engine: v1 deliberately admits
//! one magnetic prism marker only.  This module keeps the v1 wire contract
//! frozen and recomputes the complete common proof for the v2 body ownership
//! model from the received `MeshIR`.  Nothing in this module trusts a claimed
//! count, volume, gap, node order, or digest before recomputing it.

use crate::{
    cell_jacobian_determinants, cell_scaled_jacobians, validate_mesh_for_execution,
    FemCellMeshPartIR, FemCellTypeIR, FemFacetRoleIR, FemFacetTypeIR, MeshIR,
    MixedLayerTopologyCertificateV2IR,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

const QUALITY_METRIC: &str = "mixed_topology_scaled_jacobian.v1";
const STRATEGY: &str = "shared_geo_extrusion_partitioned_pyramid_tet.v2";
const GMSH_VERSION: &str = "4.15.2";
const P05_MIN: f64 = 0.1;

#[derive(Debug, Clone, Copy)]
struct FaceOwner {
    cell: usize,
    marker: u32,
    part: FemCellMeshPartIR,
}

#[derive(Debug)]
struct CellRecord {
    marker: u32,
    part: FemCellMeshPartIR,
    nodes: Vec<u32>,
}

fn family_name(value: FemCellTypeIR) -> &'static str {
    match value {
        FemCellTypeIR::Tet4 => "tet4",
        FemCellTypeIR::Prism6 => "prism6",
        FemCellTypeIR::Pyramid5 => "pyramid5",
        FemCellTypeIR::Hex8 => "hex8",
    }
}

fn part_name(value: FemCellMeshPartIR) -> &'static str {
    match value {
        FemCellMeshPartIR::Magnetic => "magnetic",
        FemCellMeshPartIR::TransitionAir => "transition_air",
        FemCellMeshPartIR::FarAir => "far_air",
    }
}

fn local_faces(value: FemCellTypeIR) -> &'static [&'static [usize]] {
    match value {
        FemCellTypeIR::Tet4 => &[&[0, 1, 2], &[0, 1, 3], &[0, 2, 3], &[1, 2, 3]],
        FemCellTypeIR::Prism6 => &[
            &[0, 1, 2],
            &[3, 5, 4],
            &[0, 3, 4, 1],
            &[1, 4, 5, 2],
            &[2, 5, 3, 0],
        ],
        FemCellTypeIR::Pyramid5 => &[
            &[0, 3, 2, 1],
            &[0, 1, 4],
            &[1, 2, 4],
            &[2, 3, 4],
            &[3, 0, 4],
        ],
        FemCellTypeIR::Hex8 => &[
            &[0, 3, 2, 1],
            &[4, 5, 6, 7],
            &[0, 1, 5, 4],
            &[1, 2, 6, 5],
            &[2, 3, 7, 6],
            &[3, 0, 4, 7],
        ],
    }
}

fn det3(columns: [[f64; 3]; 3]) -> f64 {
    columns[0][0] * (columns[1][1] * columns[2][2] - columns[1][2] * columns[2][1])
        - columns[0][1] * (columns[1][0] * columns[2][2] - columns[1][2] * columns[2][0])
        + columns[0][2] * (columns[1][0] * columns[2][1] - columns[1][1] * columns[2][0])
}

fn sub3(left: [f64; 3], right: [f64; 3]) -> [f64; 3] {
    [
        left[0] - right[0],
        left[1] - right[1],
        left[2] - right[2],
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
    left[0] * right[0] + left[1] * right[1] + left[2] * right[2]
}

/// Neumaier compensation keeps the volume proof stable when a large cell is
/// followed by many much smaller cells.  The Python producer reduces the
/// same values with a pairwise/vectorized reduction; plain sequential Rust
/// summation can otherwise move a near-zero relative error by tens of ulps.
#[derive(Debug, Default, Clone, Copy)]
struct CompensatedSum {
    sum: f64,
    correction: f64,
}

impl CompensatedSum {
    fn add(&mut self, value: f64) {
        let next = self.sum + value;
        if self.sum.abs() >= value.abs() {
            self.correction += (self.sum - next) + value;
        } else {
            self.correction += (value - next) + self.sum;
        }
        self.sum = next;
    }

    fn total(self) -> f64 {
        self.sum + self.correction
    }
}

fn compensated_sum(values: impl IntoIterator<Item = f64>) -> f64 {
    let mut total = CompensatedSum::default();
    for value in values {
        total.add(value);
    }
    total.total()
}

fn cell_volume(cell_type: FemCellTypeIR, points: &[[f64; 3]]) -> Result<f64, String> {
    match cell_type {
        FemCellTypeIR::Tet4 => {
            let determinant = det3([
                sub3(points[1], points[0]),
                sub3(points[2], points[0]),
                sub3(points[3], points[0]),
            ]);
            Ok(determinant.abs() / 6.0)
        }
        FemCellTypeIR::Prism6 => {
            let samples = cell_jacobian_determinants(cell_type, points);
            Ok(compensated_sum(samples.iter().copied()).abs() / samples.len() as f64)
        }
        FemCellTypeIR::Pyramid5 => {
            let apex = points[4];
            let triangles = [(0usize, 1usize, 2usize), (0, 2, 3)];
            Ok(compensated_sum(triangles.into_iter().map(|(i, j, k)| {
                    det3([
                        sub3(points[j], points[i]),
                        sub3(points[k], points[i]),
                        sub3(apex, points[i]),
                    ])
                    .abs()
                        / 6.0
                })))
        }
        FemCellTypeIR::Hex8 => Err("mixed v2 certificate does not qualify hex8 cells".to_string()),
    }
}

fn finite_positive(values: &[f64]) -> bool {
    !values.is_empty() && values.iter().all(|value| value.is_finite() && *value > 0.0)
}

fn percentile05(values: &mut [f64]) -> Option<f64> {
    if values.is_empty() || values.iter().any(|value| !value.is_finite()) {
        return None;
    }
    values.sort_by(f64::total_cmp);
    let position = (values.len() - 1) as f64 * 0.05;
    let lower = position.floor() as usize;
    let upper = position.ceil() as usize;
    let weight = position - lower as f64;
    Some(values[lower] * (1.0 - weight) + values[upper] * weight)
}

fn float_close(left: f64, right: f64, relative: f64, absolute: f64) -> bool {
    left.is_finite()
        && right.is_finite()
        && (left - right).abs() <= absolute.max(relative * left.abs().max(right.abs()))
}

fn bounds_for_nodes(mesh: &MeshIR, nodes: &BTreeSet<u32>) -> Result<([f64; 3], [f64; 3]), String> {
    let first = nodes
        .iter()
        .next()
        .and_then(|node| mesh.nodes.get(*node as usize))
        .copied()
        .ok_or_else(|| "mixed v2 certificate requires non-empty body nodes".to_string())?;
    let mut minimum = first;
    let mut maximum = first;
    for node in nodes {
        let point = mesh
            .nodes
            .get(*node as usize)
            .copied()
            .ok_or_else(|| format!("mixed v2 certificate references missing node {node}"))?;
        for axis in 0..3 {
            if !point[axis].is_finite() {
                return Err(format!("mixed v2 certificate node {node} is non-finite"));
            }
            minimum[axis] = minimum[axis].min(point[axis]);
            maximum[axis] = maximum[axis].max(point[axis]);
        }
    }
    Ok((minimum, maximum))
}

fn bounds_relative_error(realized: ([f64; 3], [f64; 3]), claimed: ([f64; 3], [f64; 3])) -> f64 {
    let scale = (0..3)
        .map(|axis| claimed.1[axis] - claimed.0[axis])
        .fold(0.0, f64::max);
    if !scale.is_finite() || scale <= 0.0 {
        return f64::INFINITY;
    }
    let residual = (0..3)
        .flat_map(|axis| {
            [
                (realized.0[axis] - claimed.0[axis]).abs(),
                (realized.1[axis] - claimed.1[axis]).abs(),
            ]
        })
        .fold(0.0, f64::max);
    residual / scale
}

fn transition_shell_offsets(
    swept_bounds: ([f64; 3], [f64; 3]),
    transition_bounds: ([f64; 3], [f64; 3]),
) -> [f64; 6] {
    [
        swept_bounds.0[0] - transition_bounds.0[0],
        swept_bounds.0[1] - transition_bounds.0[1],
        swept_bounds.0[2] - transition_bounds.0[2],
        transition_bounds.1[0] - swept_bounds.1[0],
        transition_bounds.1[1] - swept_bounds.1[1],
        transition_bounds.1[2] - swept_bounds.1[2],
    ]
}

fn select_exact_swept_body_marker(
    markers: impl IntoIterator<Item = Option<u32>>,
) -> Result<u32, &'static str> {
    let mut selected = None;
    for marker in markers.into_iter().flatten() {
        if selected.replace(marker).is_some() {
            return Err("mixed v2 certificate requires exactly one exact swept region");
        }
    }
    selected.ok_or("mixed v2 certificate requires exactly one exact swept region")
}

fn exact_swept_body_bounds(
    certificate: &MixedLayerTopologyCertificateV2IR,
    body_bounds: &BTreeMap<u32, ([f64; 3], [f64; 3])>,
) -> Result<([f64; 3], [f64; 3]), &'static str> {
    let marker = select_exact_swept_body_marker(
        certificate
            .magnetic_regions
            .iter()
            .map(|region| region.exact_sweep.as_ref().map(|_| region.body_marker)),
    )?;
    exact_swept_body_bounds_for_marker(marker, body_bounds)
}

fn exact_swept_body_bounds_for_marker(
    marker: u32,
    body_bounds: &BTreeMap<u32, ([f64; 3], [f64; 3])>,
) -> Result<([f64; 3], [f64; 3]), &'static str> {
    body_bounds
        .get(&marker)
        .copied()
        .ok_or("mixed v2 exact swept region body bounds are unavailable")
}

pub fn mixed_v2_node_order_digest(nodes: &BTreeSet<u32>) -> String {
    let mut payload = b"fullmag:fem-body-node-order:v1".to_vec();
    payload.extend_from_slice(&(nodes.len() as u32).to_le_bytes());
    for node in nodes {
        payload.extend_from_slice(&(*node as u64).to_le_bytes());
    }
    format!("sha256:{:x}", Sha256::digest(payload))
}

fn encode_typed_value(value: &Value, output: &mut Vec<u8>) -> Result<(), String> {
    match value {
        Value::Null => output.extend_from_slice(b"n"),
        Value::Bool(value) => output.extend_from_slice(if *value { b"b1" } else { b"b0" }),
        Value::Number(value) => {
            if let Some(integer) = value.as_i64() {
                output.extend_from_slice(b"i");
                output.extend_from_slice(&integer.to_le_bytes());
            } else {
                let float = value
                    .as_f64()
                    .filter(|value| value.is_finite())
                    .ok_or_else(|| "mixed v2 material field number is not finite".to_string())?;
                output.extend_from_slice(b"f");
                output.extend_from_slice(&float.to_le_bytes());
            }
        }
        Value::String(value) => {
            output.extend_from_slice(b"s");
            let bytes = value.as_bytes();
            let length = u32::try_from(bytes.len())
                .map_err(|_| "mixed v2 material field string is too long".to_string())?;
            output.extend_from_slice(&length.to_le_bytes());
            output.extend_from_slice(bytes);
        }
        Value::Array(values) => {
            output.extend_from_slice(b"a");
            let length = u32::try_from(values.len())
                .map_err(|_| "mixed v2 material field array is too long".to_string())?;
            output.extend_from_slice(&length.to_le_bytes());
            for value in values {
                encode_typed_value(value, output)?;
            }
        }
        Value::Object(values) => {
            output.extend_from_slice(b"m");
            let length = u32::try_from(values.len())
                .map_err(|_| "mixed v2 material field map is too large".to_string())?;
            output.extend_from_slice(&length.to_le_bytes());
            let mut entries = values.iter().collect::<Vec<_>>();
            entries.sort_by(|left, right| left.0.cmp(right.0));
            for (key, value) in entries {
                let key_bytes = key.as_bytes();
                let key_length = u32::try_from(key_bytes.len())
                    .map_err(|_| "mixed v2 material field key is too long".to_string())?;
                output.extend_from_slice(&key_length.to_le_bytes());
                output.extend_from_slice(key_bytes);
                encode_typed_value(value, output)?;
            }
        }
    }
    Ok(())
}

pub fn mixed_v2_body_material_field_digest(
    field: &crate::BodyMaterialFieldV2IR,
    topology_fingerprint_version: &str,
    topology_fingerprint: &str,
    body_marker: u32,
    material_marker: u32,
) -> Result<String, String> {
    let mut values = serde_json::Map::new();
    values.insert("Aex".to_string(), field.values.get("Aex").cloned().unwrap_or(Value::Null));
    values.insert("Ms".to_string(), field.values.get("Ms").cloned().unwrap_or(Value::Null));
    values.insert("Ku1".to_string(), field.values.get("Ku1").cloned().unwrap_or(Value::Null));
    values.insert("alpha".to_string(), field.values.get("alpha").cloned().unwrap_or(Value::Null));
    values.insert(
        "anisotropy_axis".to_string(),
        field
            .values
            .get("anisotropy_axis")
            .cloned()
            .unwrap_or(Value::Null),
    );
    let mut fields = BTreeMap::<String, Value>::new();
    fields.insert("object_id".to_string(), Value::String(field.object_id.clone()));
    fields.insert("field_basis".to_string(), Value::String(field.field_basis.clone()));
    fields.insert(
        "coefficient_domains".to_string(),
        Value::Array(
            field
                .coefficient_domains
                .iter()
                .cloned()
                .map(Value::String)
                .collect(),
        ),
    );
    fields.insert(
        "air_interpolation_policy".to_string(),
        Value::String(field.air_interpolation_policy.clone()),
    );
    fields.insert(
        "cross_body_interpolation_policy".to_string(),
        Value::String(field.cross_body_interpolation_policy.clone()),
    );
    fields.insert(
        "node_order_digest".to_string(),
        Value::String(field.node_order_digest.clone()),
    );
    fields.insert(
        "topology_fingerprint_version".to_string(),
        Value::String(topology_fingerprint_version.to_string()),
    );
    fields.insert(
        "topology_fingerprint".to_string(),
        Value::String(topology_fingerprint.to_string()),
    );
    fields.insert("body_marker".to_string(), json!(body_marker));
    fields.insert("material_marker".to_string(), json!(material_marker));
    fields.insert("component_units".to_string(), Value::Object(serde_json::Map::new()));
    fields.insert("values".to_string(), Value::Object(values));
    let mut payload = b"fullmag:fem-body-material-field:v1".to_vec();
    for (key, value) in fields {
        let key_bytes = key.as_bytes();
        let length = u32::try_from(key_bytes.len())
            .map_err(|_| "mixed v2 material field key is too long".to_string())?;
        payload.extend_from_slice(&length.to_le_bytes());
        payload.extend_from_slice(key_bytes);
        encode_typed_value(&value, &mut payload)?;
    }
    Ok(format!("sha256:{:x}", Sha256::digest(payload)))
}

pub(crate) fn mixed_v2_body_material_values_are_valid(
    values: &BTreeMap<String, Value>,
) -> bool {
    let scalar_is_finite = |name: &str| {
        values
            .get(name)
            .and_then(Value::as_f64)
            .is_some_and(f64::is_finite)
    };
    let axis_is_finite = values
        .get("anisotropy_axis")
        .and_then(Value::as_array)
        .is_some_and(|axis| {
            axis.len() == 3
                && axis
                    .iter()
                    .all(|value| value.as_f64().is_some_and(f64::is_finite))
        });
    scalar_is_finite("Ms")
        && scalar_is_finite("Aex")
        && scalar_is_finite("alpha")
        && scalar_is_finite("Ku1")
        && axis_is_finite
}

fn same_fields<T: PartialEq>(claimed: &T, actual: &T, name: &str, errors: &mut Vec<String>) {
    if claimed != actual {
        errors.push(format!("mixed v2 certificate {name} disagrees with mesh"));
    }
}

fn compare_float(claimed: f64, actual: f64, name: &str, errors: &mut Vec<String>) {
    if !float_close(claimed, actual, 1.0e-12, 1.0e-30) {
        errors.push(format!("mixed v2 certificate {name} disagrees with mesh"));
    }
}

/// Compare dimensionless evidence with a small binary64 floor.
///
/// The producer and native validator intentionally use different reduction
/// implementations for the large cell-volume sums (NumPy versus Rust).  A
/// relative error close to zero therefore cannot use the dimensional
/// `1.0e-30` floor from `compare_float`: the relative tolerance is multiplied
/// by the magnitude of the value and becomes effectively zero.  Keep this
/// tolerance local to dimensionless evidence; dimensional geometry and
/// volume claims retain their strict SI comparison.
fn compare_dimensionless_float(
    claimed: f64,
    actual: f64,
    name: &str,
    errors: &mut Vec<String>,
) {
    if !float_close(claimed, actual, 1.0e-12, f64::EPSILON * 16.0) {
        errors.push(format!("mixed v2 certificate {name} disagrees with mesh"));
    }
}

fn compare_float_map(
    claimed: &BTreeMap<String, f64>,
    actual: &BTreeMap<String, f64>,
    name: &str,
    errors: &mut Vec<String>,
) {
    if claimed.len() != actual.len()
        || claimed.iter().any(|(key, value)| {
            actual
                .get(key)
                .is_none_or(|actual| !float_close(*value, *actual, 1.0e-12, 1.0e-30))
        })
    {
        errors.push(format!("mixed v2 certificate {name} disagrees with mesh"));
    }
}

fn compare_dimensionless_map(
    claimed: &BTreeMap<String, f64>,
    actual: &BTreeMap<String, f64>,
    name: &str,
    errors: &mut Vec<String>,
) {
    if claimed.len() != actual.len()
        || claimed.iter().any(|(key, value)| {
            actual
                .get(key)
                .is_none_or(|actual| !float_close(*value, *actual, 1.0e-12, f64::EPSILON * 16.0))
        })
    {
        errors.push(format!("mixed v2 certificate {name} disagrees with mesh"));
    }
}

pub(crate) fn mixed_v2_deterministic_inputs(
    requested_algorithm_3d: u32,
    transition_algorithm_3d: u32,
    tetrahedral_algorithm_3d: u32,
    optimizer: Option<&str>,
    optimizer_iterations: u32,
) -> BTreeMap<String, Value> {
    serde_json::from_value(json!({
        "algorithm_2d": 6,
        "algorithm_3d": requested_algorithm_3d,
        "requested_algorithm_3d": requested_algorithm_3d,
        "transition_algorithm_3d": transition_algorithm_3d,
        "tetrahedral_algorithm_3d": tetrahedral_algorithm_3d,
        "optimizer": optimizer,
        "optimizer_iterations": optimizer_iterations,
        "element_order": 1,
        "gmsh_version": GMSH_VERSION,
        "random_factor": 0.0,
        "thread_count": 1,
        "transition_partition": "cartesian_3x3x3_minus_magnetic_center",
        "transition_volume_count": 26,
        "pyramid_apex_optimizer": "bounded_per_apex_outward_scale_line_search",
        "pyramid_apex_scale_step": 0.001,
        "pyramid_apex_scale_max": 1.25,
        "scaled_jacobian_p05_min": P05_MIN
    }))
    .expect("mixed v2 deterministic inputs are valid JSON")
}

fn region_nodes(mesh: &MeshIR, marker: u32) -> Result<BTreeSet<u32>, String> {
    let mut nodes = BTreeSet::new();
    for (ordinal, actual_marker) in mesh.element_markers.iter().enumerate() {
        if *actual_marker != marker {
            continue;
        }
        let cell_nodes = mesh
            .cells
            .item_nodes(ordinal)
            .ok_or_else(|| format!("mixed v2 cell {ordinal} has invalid CSR"))?;
        nodes.extend(cell_nodes.iter().copied());
    }
    if nodes.is_empty() {
        return Err(format!("mixed v2 body marker {marker} has no cells"));
    }
    Ok(nodes)
}

fn body_aabb_gap(
    left: ([f64; 3], [f64; 3]),
    right: ([f64; 3], [f64; 3]),
) -> f64 {
    let mut squared = 0.0;
    for axis in 0..3 {
        let separation = (left.0[axis] - right.1[axis])
            .max(right.0[axis] - left.1[axis])
            .max(0.0);
        squared += separation * separation;
    }
    squared.sqrt()
}

fn body_surface_volume(
    mesh: &MeshIR,
    facet_nodes: &[u32],
    owner_cell: usize,
) -> Result<f64, String> {
    let points = facet_nodes
        .iter()
        .map(|node| {
            mesh.nodes
                .get(*node as usize)
                .copied()
                .ok_or_else(|| format!("mixed v2 facet references missing node {node}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let owner_nodes = mesh
        .cells
        .item_nodes(owner_cell)
        .ok_or_else(|| format!("mixed v2 owner cell {owner_cell} has invalid CSR"))?;
    let mut owner_centroid = [0.0; 3];
    for node in owner_nodes {
        let point = mesh
            .nodes
            .get(*node as usize)
            .copied()
            .ok_or_else(|| format!("mixed v2 owner cell references missing node {node}"))?;
        for axis in 0..3 {
            owner_centroid[axis] += point[axis];
        }
    }
    for value in &mut owner_centroid {
        *value /= owner_nodes.len() as f64;
    }
    let mut face_centroid = [0.0; 3];
    for point in &points {
        for axis in 0..3 {
            face_centroid[axis] += point[axis];
        }
    }
    for value in &mut face_centroid {
        *value /= points.len() as f64;
    }
    let triangles: &[(usize, usize, usize)] = match points.len() {
        3 => &[(0, 1, 2)],
        4 => &[(0, 1, 2), (0, 2, 3)],
        _ => return Err("mixed v2 material-interface facet must be tri3 or quad4".to_string()),
    };
    let mut volume = CompensatedSum::default();
    for &(i, mut j, mut k) in triangles {
        let normal = cross3(sub3(points[j], points[i]), sub3(points[k], points[i]));
        if dot3(normal, sub3(face_centroid, owner_centroid)) < 0.0 {
            std::mem::swap(&mut j, &mut k);
        }
        volume.add(det3([points[i], points[j], points[k]]) / 6.0);
    }
    Ok(volume.total())
}

/// Validate the complete v2 certificate against the exact, received mesh.
pub fn validate_mixed_layer_topology_certificate_v2_against_mesh(
    mesh: &MeshIR,
    certificate: &MixedLayerTopologyCertificateV2IR,
) -> Result<(), Vec<String>> {
    let mut errors = certificate.validate().err().unwrap_or_default();
    if let Err(mesh_errors) = validate_mesh_for_execution(mesh) {
        errors.extend(mesh_errors.into_iter().map(|error| format!("mixed v2 mesh: {error}")));
        return Err(errors);
    }
    if mesh.cells.mesh_parts.len() != mesh.cells.types.len()
        || mesh.element_markers.len() != mesh.cells.types.len()
        || mesh.facets.roles.len() != mesh.facets.types.len()
        || mesh.boundary_markers.len() != mesh.facets.types.len()
    {
        errors.push("mixed v2 mesh typed arrays are incomplete".to_string());
        return Err(errors);
    }

    let region_by_marker = certificate
        .magnetic_regions
        .iter()
        .map(|region| (region.body_marker, region))
        .collect::<BTreeMap<_, _>>();
    let region_by_object = certificate
        .magnetic_regions
        .iter()
        .map(|region| (region.object_id.as_str(), region))
        .collect::<BTreeMap<_, _>>();
    let mut body_nodes = BTreeMap::<u32, BTreeSet<u32>>::new();
    let mut body_bounds = BTreeMap::<u32, ([f64; 3], [f64; 3])>::new();
    for region in &certificate.magnetic_regions {
        match region_nodes(mesh, region.body_marker) {
            Ok(nodes) => {
                match bounds_for_nodes(mesh, &nodes) {
                    Ok(bounds) => {
                        body_bounds.insert(region.body_marker, bounds);
                    }
                    Err(error) => errors.push(error),
                }
                body_nodes.insert(region.body_marker, nodes);
            }
            Err(error) => errors.push(error),
        }
    }

    let mut records = Vec::with_capacity(mesh.cells.types.len());
    let mut marker_counts = BTreeMap::<String, BTreeMap<String, u64>>::new();
    let mut part_counts = BTreeMap::<String, BTreeMap<String, u64>>::new();
    let mut jacobians = BTreeMap::<String, Vec<f64>>::new();
    let mut scaled_jacobians = BTreeMap::<String, Vec<f64>>::new();
    let mut adjacency = BTreeMap::<Vec<u32>, Vec<FaceOwner>>::new();
    let mut magnetic_volume_by_marker = BTreeMap::<u32, CompensatedSum>::new();
    let mut shared_volume = CompensatedSum::default();
    let mut transition_nodes = BTreeSet::new();

    for (ordinal, cell_type) in mesh.cells.types.iter().copied().enumerate() {
        let marker = mesh.element_markers[ordinal];
        let part = mesh.cells.mesh_parts[ordinal];
        let legal = match part {
            FemCellMeshPartIR::Magnetic => {
                region_by_marker.contains_key(&marker)
                    && matches!(cell_type, FemCellTypeIR::Prism6 | FemCellTypeIR::Tet4)
            }
            FemCellMeshPartIR::TransitionAir => {
                marker == 0 && matches!(cell_type, FemCellTypeIR::Pyramid5 | FemCellTypeIR::Tet4)
            }
            FemCellMeshPartIR::FarAir => marker == 0 && cell_type == FemCellTypeIR::Tet4,
        };
        if !legal {
            errors.push(format!(
                "mixed v2 cell {ordinal} has invalid mesh part/family/marker"
            ));
        }
        let nodes = match mesh.cells.item_nodes(ordinal) {
            Some(nodes) => nodes.to_vec(),
            None => {
                errors.push(format!("mixed v2 cell {ordinal} has invalid CSR"));
                continue;
            }
        };
        let points = nodes
            .iter()
            .filter_map(|node| mesh.nodes.get(*node as usize).copied())
            .collect::<Vec<_>>();
        if points.len() != nodes.len() {
            errors.push(format!("mixed v2 cell {ordinal} references a missing node"));
            continue;
        }
        let jacobian_values = cell_jacobian_determinants(cell_type, &points);
        let scaled_values = cell_scaled_jacobians(cell_type, &points);
        if legal && (!finite_positive(&jacobian_values) || !finite_positive(&scaled_values)) {
            errors.push(format!("mixed v2 cell {ordinal} has non-positive Jacobian evidence"));
        }
        let volume = match cell_volume(cell_type, &points) {
            Ok(volume) if legal && volume.is_finite() && volume > 0.0 => volume,
            Ok(volume) if !legal => 0.0,
            Ok(_) => {
                errors.push(format!("mixed v2 cell {ordinal} has invalid volume"));
                0.0
            }
            Err(error) => {
                errors.push(error);
                0.0
            }
        };
        if legal {
            let family = family_name(cell_type);
            *marker_counts
                .entry(marker.to_string())
                .or_default()
                .entry(family.to_string())
                .or_default() += 1;
            *part_counts
                .entry(part_name(part).to_string())
                .or_default()
                .entry(family.to_string())
                .or_default() += 1;
            jacobians
                .entry(family.to_string())
                .or_default()
                .extend(jacobian_values.iter().copied());
            scaled_jacobians
                .entry(family.to_string())
                .or_default()
                .extend(scaled_values.iter().copied());
            shared_volume.add(volume);
            if part == FemCellMeshPartIR::Magnetic {
                magnetic_volume_by_marker
                    .entry(marker)
                    .or_default()
                    .add(volume);
            }
            if part == FemCellMeshPartIR::TransitionAir {
                transition_nodes.extend(nodes.iter().copied());
            }
            for local_face in local_faces(cell_type) {
                let mut key = local_face
                    .iter()
                    .map(|index| nodes[*index])
                    .collect::<Vec<_>>();
                key.sort_unstable();
                adjacency.entry(key).or_default().push(FaceOwner {
                    cell: ordinal,
                    marker,
                    part,
                });
            }
        }
        records.push(CellRecord {
            marker,
            part,
            nodes,
        });
    }

    if part_counts
        .get("magnetic")
        .is_none_or(|counts| counts.is_empty())
        || part_counts
            .get("transition_air")
            .is_none_or(|counts| counts.is_empty())
        || part_counts.get("far_air").is_none_or(|counts| counts.is_empty())
    {
        errors.push("mixed v2 mesh must contain magnetic, transition_air and far_air cells".to_string());
    }
    same_fields(
        &certificate.cell_family_counts_by_marker,
        &marker_counts,
        "cell_family_counts_by_marker",
        &mut errors,
    );
    same_fields(
        &certificate.cell_family_counts_by_part,
        &part_counts,
        "cell_family_counts_by_part",
        &mut errors,
    );
    for region in &certificate.magnetic_regions {
        if marker_counts.get(&region.body_marker.to_string()) != Some(&region.cell_family_counts) {
            errors.push(format!(
                "mixed v2 region '{}' cell families disagree with mesh",
                region.object_id
            ));
        }
    }

    let mut facet_counts = BTreeMap::<String, BTreeMap<String, u64>>::new();
    let mut explicit = BTreeMap::<Vec<u32>, Vec<(usize, FemFacetRoleIR, u32, FemFacetTypeIR)>>::new();
    for ordinal in 0..mesh.facets.types.len() {
        let nodes = match mesh.facets.item_nodes(ordinal) {
            Some(nodes) => nodes.to_vec(),
            None => {
                errors.push(format!("mixed v2 facet {ordinal} has invalid CSR"));
                continue;
            }
        };
        let mut key = nodes.clone();
        key.sort_unstable();
        let family = match mesh.facets.types[ordinal] {
            FemFacetTypeIR::Tri3 => "tri3",
            FemFacetTypeIR::Quad4 => "quad4",
        };
        let role = mesh.facets.roles[ordinal];
        let role_name = match role {
            FemFacetRoleIR::Exterior => "exterior",
            FemFacetRoleIR::MaterialInterface => "material_interface",
            FemFacetRoleIR::PeriodicSeam => "periodic_seam",
        };
        *facet_counts
            .entry(format!("{}:{}", role_name, mesh.boundary_markers[ordinal]))
            .or_default()
            .entry(family.to_string())
            .or_default() += 1;
        explicit.entry(key).or_default().push((
            ordinal,
            role,
            mesh.boundary_markers[ordinal],
            mesh.facets.types[ordinal],
        ));
    }
    same_fields(
        &certificate.facet_family_counts_by_role_marker,
        &facet_counts,
        "facet_family_counts_by_role_marker",
        &mut errors,
    );

    let mut nonconforming = 0u64;
    let mut orphan = 0u64;
    let mut nonmanifold = 0u64;
    let mut coincident = 0u64;
    let mut shell_faces = 0u64;
    let mut interface_volume_by_marker = BTreeMap::<u32, CompensatedSum>::new();
    let mut interface_seen_by_marker = BTreeMap::<u32, u64>::new();
    for (key, owners) in &adjacency {
        if owners.len() > 2 {
            nonmanifold += 1;
        }
        let role_entries = explicit.get(key).map(Vec::as_slice).unwrap_or_default();
        let exterior_count = role_entries
            .iter()
            .filter(|(_, role, _, _)| *role == FemFacetRoleIR::Exterior)
            .count();
        let interface_count = role_entries
            .iter()
            .filter(|(_, role, _, _)| *role == FemFacetRoleIR::MaterialInterface)
            .count();
        if owners.len() == 1 && exterior_count != 1 {
            nonconforming += 1;
        }
        if owners.len() == 2 {
            let markers = owners.iter().map(|owner| owner.marker).collect::<BTreeSet<_>>();
            let parts = owners.iter().map(|owner| owner.part).collect::<BTreeSet<_>>();
            if parts
                == BTreeSet::from([FemCellMeshPartIR::TransitionAir, FemCellMeshPartIR::FarAir])
            {
                if key.len() == 3 {
                    shell_faces += 1;
                } else {
                    nonconforming += 1;
                }
            } else if markers.len() > 1 || parts.len() > 1 {
                let magnetic_air = owners.iter().any(|owner| {
                    owner.part == FemCellMeshPartIR::Magnetic
                        && region_by_marker.contains_key(&owner.marker)
                }) && owners.iter().any(|owner| owner.marker == 0);
                if magnetic_air {
                    if interface_count != 1 {
                        nonconforming += 1;
                    }
                } else {
                    nonconforming += 1;
                }
            }
        }
        if role_entries.len() > 1 {
            let interface_duplicates = role_entries
                .iter()
                .filter(|(_, role, _, _)| *role == FemFacetRoleIR::MaterialInterface)
                .count();
            coincident += interface_duplicates.saturating_sub(1) as u64;
        }
    }
    for (key, role_entries) in &explicit {
        let owners = adjacency.get(key).map(Vec::as_slice).unwrap_or_default();
        if owners.is_empty() {
            orphan += role_entries.len() as u64;
        }
        for (ordinal, role, marker, family) in role_entries {
            match role {
                FemFacetRoleIR::Exterior => {
                    if owners.len() != 1 || *marker != certificate.outer_boundary_marker {
                        nonconforming += 1;
                    }
                }
                FemFacetRoleIR::MaterialInterface => {
                    let magnetic_owners = owners
                        .iter()
                        .filter(|owner| {
                            owner.part == FemCellMeshPartIR::Magnetic
                                && region_by_marker.contains_key(&owner.marker)
                        })
                        .collect::<Vec<_>>();
                    if owners.len() != 2
                        || magnetic_owners.len() != 1
                        || !owners.iter().any(|owner| owner.marker == 0)
                        || *marker != certificate.interface_marker
                        || !matches!(family, FemFacetTypeIR::Tri3 | FemFacetTypeIR::Quad4)
                    {
                        nonconforming += 1;
                    } else {
                        let owner = magnetic_owners[0];
                        let Some(facet_nodes) = mesh.facets.item_nodes(*ordinal) else {
                            nonconforming += 1;
                            continue;
                        };
                        match body_surface_volume(mesh, facet_nodes, owner.cell) {
                            Ok(volume) if volume.is_finite() => {
                                interface_volume_by_marker
                                    .entry(owner.marker)
                                    .or_default()
                                    .add(volume);
                                *interface_seen_by_marker.entry(owner.marker).or_default() += 1;
                            }
                            Ok(_) | Err(_) => nonconforming += 1,
                        }
                    }
                }
                FemFacetRoleIR::PeriodicSeam => {}
            }
        }
    }
    if !certificate.marker_coverage_complete
        || nonconforming != certificate.nonconforming_face_count
        || orphan != certificate.orphan_face_count
        || nonmanifold != certificate.nonmanifold_face_count
        || coincident != certificate.coincident_interface_face_count
    {
        errors.push("mixed v2 conformity evidence disagrees with mesh".to_string());
    }
    if shell_faces != certificate.transition_shell_interface_tri3_count {
        errors.push("mixed v2 transition shell facet evidence disagrees with mesh".to_string());
    }

    let magnetic_nodes = body_nodes
        .values()
        .flat_map(|nodes| nodes.iter().copied())
        .collect::<BTreeSet<_>>();
    let transition_bounds = bounds_for_nodes(mesh, &transition_nodes);
    let magnetic_bounds = bounds_for_nodes(mesh, &magnetic_nodes);
    let swept_magnetic_bounds = match exact_swept_body_bounds(certificate, &body_bounds) {
        Ok(bounds) => Some(bounds),
        Err(error) => {
            errors.push(error.to_string());
            None
        }
    };
    let all_nodes = (0..mesh.nodes.len() as u32).collect::<BTreeSet<_>>();
    let airbox_bounds = bounds_for_nodes(mesh, &all_nodes);
    if let (Ok(magnetic_bounds), Ok(airbox_bounds), Ok(transition_bounds)) =
        (magnetic_bounds, airbox_bounds, transition_bounds)
    {
        compare_float(
            certificate.magnetic_bounds_relative_error,
            bounds_relative_error(
                magnetic_bounds,
                (certificate.magnetic_bounds_min_m, certificate.magnetic_bounds_max_m),
            ),
            "magnetic_bounds_relative_error",
            &mut errors,
        );
        compare_float(
            certificate.airbox_bounds_relative_error,
            bounds_relative_error(
                airbox_bounds,
                (certificate.airbox_bounds_min_m, certificate.airbox_bounds_max_m),
            ),
            "airbox_bounds_relative_error",
            &mut errors,
        );
        for axis in 0..3 {
            if !float_close(
                magnetic_bounds.0[axis],
                certificate.magnetic_bounds_min_m[axis],
                1.0e-12,
                1.0e-30,
            ) || !float_close(
                magnetic_bounds.1[axis],
                certificate.magnetic_bounds_max_m[axis],
                1.0e-12,
                1.0e-30,
            ) {
                errors.push("mixed v2 magnetic bounds disagree with mesh".to_string());
                break;
            }
        }
        // The transition shell is constructed around the exact swept region
        // (currently the box), while the top-level magnetic bounds correctly
        // cover every disconnected body.  Using the union here makes a
        // second body outside the swept box look like a negative shell.
        if let Some((swept_min, swept_max)) = swept_magnetic_bounds {
            let offsets = transition_shell_offsets(
                (swept_min, swept_max),
                transition_bounds,
            );
            let shell = offsets.iter().sum::<f64>() / offsets.len() as f64;
            if offsets.iter().any(|offset| {
                !offset.is_finite()
                    || *offset <= 0.0
                    || !float_close(*offset, shell, 1.0e-10, 1.0e-15)
            }) {
                errors.push("mixed v2 transition shell bounds are not uniform".to_string());
            }
            compare_float(
                certificate.transition_shell_thickness_m,
                shell,
                "transition_shell_thickness_m",
                &mut errors,
            );
        }
    }

    let shared_volume = shared_volume.total();
    let magnetic_volume = compensated_sum(
        magnetic_volume_by_marker
            .values()
            .copied()
            .map(CompensatedSum::total),
    );
    let faceted_magnetic_volume = compensated_sum(
        interface_volume_by_marker
            .values()
            .copied()
            .map(CompensatedSum::total)
            .map(f64::abs),
    );
    let expected_shared_volume = (0..3)
        .map(|axis| certificate.airbox_bounds_max_m[axis] - certificate.airbox_bounds_min_m[axis])
        .product::<f64>();
    let air_volume = shared_volume - magnetic_volume;
    compare_float(certificate.magnetic_volume_m3, magnetic_volume, "magnetic_volume_m3", &mut errors);
    compare_float(
        certificate.expected_magnetic_volume_m3,
        faceted_magnetic_volume,
        "expected_magnetic_volume_m3",
        &mut errors,
    );
    compare_dimensionless_float(
        certificate.magnetic_relative_volume_error,
        (magnetic_volume - faceted_magnetic_volume).abs() / faceted_magnetic_volume.max(1.0e-300),
        "magnetic_relative_volume_error",
        &mut errors,
    );
    compare_float(certificate.air_volume_m3, air_volume, "air_volume_m3", &mut errors);
    compare_float(certificate.shared_domain_volume_m3, shared_volume, "shared_domain_volume_m3", &mut errors);
    compare_float(
        certificate.expected_shared_domain_volume_m3,
        expected_shared_volume,
        "expected_shared_domain_volume_m3",
        &mut errors,
    );
    compare_dimensionless_float(
        certificate.shared_domain_relative_volume_error,
        (shared_volume - expected_shared_volume).abs() / expected_shared_volume.max(1.0e-300),
        "shared_domain_relative_volume_error",
        &mut errors,
    );
    for region in &certificate.magnetic_regions {
        if interface_seen_by_marker.get(&region.body_marker).copied().unwrap_or(0) == 0
            || interface_volume_by_marker
                .get(&region.body_marker)
                .is_none_or(|value| {
                    let value = value.total();
                    !value.is_finite() || value.abs() <= 0.0
                })
        {
            errors.push(format!(
                "mixed v2 body '{}' has no closed material-interface surface",
                region.object_id
            ));
        }
    }

    compare_float_map(
        &certificate.jacobian_minima_m3_by_family,
        &jacobians
            .iter()
            .filter_map(|(family, values)| values.iter().copied().min_by(f64::total_cmp).map(|value| (family.clone(), value)))
            .collect(),
        "jacobian_minima_m3_by_family",
        &mut errors,
    );
    compare_dimensionless_map(
        &certificate.scaled_jacobian_minima_by_family,
        &scaled_jacobians
            .iter()
            .filter_map(|(family, values)| values.iter().copied().min_by(f64::total_cmp).map(|value| (family.clone(), value)))
            .collect(),
        "scaled_jacobian_minima_by_family",
        &mut errors,
    );
    let scaled_p05 = scaled_jacobians
        .iter_mut()
        .filter_map(|(family, values)| percentile05(values).map(|value| (family.clone(), value)))
        .collect::<BTreeMap<_, _>>();
    compare_dimensionless_map(
        &certificate.scaled_jacobian_p05_by_family,
        &scaled_p05,
        "scaled_jacobian_p05_by_family",
        &mut errors,
    );
    if scaled_p05.values().any(|value| *value < P05_MIN) {
        errors.push("mixed v2 scaled Jacobian p05 is below the qualified minimum".to_string());
    }
    if certificate.deterministic_inputs
        != mixed_v2_deterministic_inputs(
            certificate.requested_algorithm_3d,
            certificate.transition_algorithm_3d,
            certificate.tetrahedral_algorithm_3d,
            certificate.optimizer.as_deref(),
            certificate.optimizer_iterations,
        )
        || certificate.quality_metric != QUALITY_METRIC
        || certificate.strategy != STRATEGY
        || certificate.gmsh_version != GMSH_VERSION
        || certificate.effective_gmsh_thread_count != 1
    {
        errors.push("mixed v2 deterministic realization proof is stale".to_string());
    }

    let topology = match certificate.topology_fingerprint_version.as_str() {
        "v2" => mesh.topology_fingerprint_v6(),
        "v3" => match mesh.mixed_topology_fingerprint_v3() {
            Ok(value) => value,
            Err(error) => {
                errors.push(error);
                String::new()
            }
        },
        _ => String::new(),
    };
    if topology.is_empty() || certificate.topology_fingerprint != topology {
        errors.push("mixed v2 topology fingerprint is stale".to_string());
    }

    let mut exact_sweep_regions = Vec::new();
    for region in &certificate.magnetic_regions {
        let Some(sweep) = region.exact_sweep.as_ref() else { continue };
        exact_sweep_regions.push(region.object_id.as_str());
        let axis = match sweep.sweep_direction_resolved.as_str() {
            "x" => 0,
            "y" => 1,
            "z" => 2,
            _ => continue,
        };
        let nodes = body_nodes.get(&region.body_marker).cloned().unwrap_or_default();
        let mut coordinates = nodes
            .iter()
            .filter_map(|node| mesh.nodes.get(*node as usize).map(|point| point[axis]))
            .collect::<Vec<_>>();
        coordinates.sort_by(f64::total_cmp);
        let mut planes = Vec::new();
        for coordinate in coordinates {
            if planes
                .last()
                .is_none_or(|previous: &f64| (coordinate - *previous).abs() > sweep.plane_tolerance_m)
            {
                planes.push(coordinate);
            }
        }
        if planes != sweep.magnetic_plane_coordinates_m
            || sweep.requested_layer_count != sweep.realized_layer_count
            || sweep.realized_layer_count as usize + 1 != planes.len()
            || sweep.topology_fingerprint_version != certificate.topology_fingerprint_version
            || sweep.topology_fingerprint != topology
            || sweep.node_order_digest != mixed_v2_node_order_digest(&nodes)
        {
            errors.push(format!("mixed v2 exact sweep evidence for '{}' is stale", region.object_id));
        }
        if sweep.sweep_direction_requested != certificate.requested_sweep_direction
            || sweep.sweep_direction_resolved != certificate.resolved_sweep_direction
            || sweep.realized_layer_count != certificate.realized_layer_count
            || sweep.magnetic_plane_coordinates_m != certificate.magnetic_plane_coordinates_m
            || !float_close(sweep.plane_tolerance_m, certificate.plane_tolerance_m, 1.0e-12, 1.0e-30)
        {
            errors.push(format!("mixed v2 regional sweep '{}' disagrees with shared evidence", region.object_id));
        }
    }
    if exact_sweep_regions.len() != 1
        || certificate.requested_layer_count != certificate.realized_layer_count
        || certificate.magnetic_plane_coordinates_m.len() != certificate.realized_layer_count as usize + 1
    {
        errors.push("mixed v2 certificate requires one exact swept region".to_string());
    }

    for region in &certificate.magnetic_regions {
        let Some(nodes) = body_nodes.get(&region.body_marker) else { continue };
        let Some(field) = region_by_object
            .get(region.object_id.as_str())
            .and_then(|_| certificate.body_material_fields.iter().find(|field| field.object_id == region.object_id))
        else {
            continue;
        };
        let expected_node_digest = mixed_v2_node_order_digest(nodes);
        if field.node_order_digest != expected_node_digest {
            errors.push(format!("mixed v2 body material node order for '{}' is stale", region.object_id));
        }
        let required = BTreeSet::from([
            "Ms".to_string(),
            "Aex".to_string(),
            "alpha".to_string(),
            "Ku1".to_string(),
            "anisotropy_axis".to_string(),
        ]);
        let required_order = vec![
            "Ms".to_string(),
            "Aex".to_string(),
            "alpha".to_string(),
            "Ku1".to_string(),
            "anisotropy_axis".to_string(),
        ];
        if field.coefficient_domains != required_order
            || field.coefficient_domains.iter().cloned().collect::<BTreeSet<_>>() != required
            || field.values.len() != required.len()
            || field.values.keys().cloned().collect::<BTreeSet<_>>() != required
            || !mixed_v2_body_material_values_are_valid(&field.values)
        {
            errors.push(format!("mixed v2 body material values for '{}' are invalid", region.object_id));
        }
        if field.object_id != region.object_id
            || field.field_basis != "body_owned_p1"
            || field.air_interpolation_policy != "forbidden"
            || field.cross_body_interpolation_policy != "forbidden"
        {
            errors.push(format!("mixed v2 body material policy for '{}' is invalid", region.object_id));
        }
        match mixed_v2_body_material_field_digest(
            field,
            &certificate.topology_fingerprint_version,
            &topology,
            region.body_marker,
            region.material_marker,
        ) {
            Ok(expected) if field.field_digest == expected => {}
            Ok(_) => errors.push(format!("mixed v2 body material digest for '{}' is stale", region.object_id)),
            Err(error) => errors.push(error),
        }
    }

    let mut body_aabbs_by_object = BTreeMap::new();
    for region in &certificate.magnetic_regions {
        if let Some(bounds) = body_bounds.get(&region.body_marker) {
            body_aabbs_by_object.insert(region.object_id.as_str(), *bounds);
        }
        if let Some(nodes) = body_nodes.get(&region.body_marker) {
            let duplicate_coordinates = nodes
                .iter()
                .filter_map(|node| mesh.nodes.get(*node as usize))
                .map(|point| point.map(f64::to_bits))
                .collect::<BTreeSet<_>>();
            if duplicate_coordinates.len() != nodes.len() {
                errors.push(format!("mixed v2 body '{}' has duplicate coordinates", region.object_id));
            }
        }
    }
    let expected_pair_count = certificate.magnetic_regions.len()
        .saturating_mul(certificate.magnetic_regions.len().saturating_sub(1))
        / 2;
    if certificate.body_separation_pairs.len() != expected_pair_count {
        errors.push("mixed v2 body separation coverage is incomplete".to_string());
    }
    let mut seen_pairs = BTreeSet::new();
    for pair in &certificate.body_separation_pairs {
        if !seen_pairs.insert((pair.body_a.as_str(), pair.body_b.as_str()))
            || pair.body_a >= pair.body_b
            || pair.contact_state != "separated"
        {
            errors.push("mixed v2 body separation pair ordering is invalid".to_string());
            continue;
        }
        let Some(left) = body_aabbs_by_object.get(pair.body_a.as_str()) else { continue };
        let Some(right) = body_aabbs_by_object.get(pair.body_b.as_str()) else { continue };
        let gap = body_aabb_gap(*left, *right);
        if !gap.is_finite() || gap <= 0.0 || !float_close(pair.min_gap_m, gap, 1.0e-12, 1.0e-30) {
            errors.push(format!("mixed v2 body separation pair '{}'/'{}' disagrees with mesh", pair.body_a, pair.body_b));
        }
    }

    let mut node_owners = BTreeMap::<u32, BTreeSet<u32>>::new();
    for record in &records {
        if record.part == FemCellMeshPartIR::Magnetic {
            for node in &record.nodes {
                node_owners.entry(*node).or_default().insert(record.marker);
            }
        }
    }
    if node_owners.values().any(|markers| markers.len() > 1) {
        errors.push("mixed v2 magnetic bodies share a mesh node without an interface operator".to_string());
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        compensated_sum, exact_swept_body_bounds_for_marker, select_exact_swept_body_marker,
        transition_shell_offsets,
    };

    #[test]
    fn compensated_volume_sum_preserves_many_small_cells_after_large_cell() {
        let values = std::iter::once(1.0).chain((0..1_000).map(|_| 1.0e-16));
        let actual = compensated_sum(values);
        let expected = 1.0000000000001;
        assert!((actual - expected).abs() <= 16.0 * f64::EPSILON);
    }

    #[test]
    fn transition_shell_uses_swept_body_bounds_for_disconnected_body() {
        let scale = 1.0e-9;
        let swept = (
            [-1000.0 * scale, -300.0 * scale, -0.8 * scale],
            [1000.0 * scale, 300.0 * scale, 0.8 * scale],
        );
        let transition = (
            [-1004.5 * scale, -304.5 * scale, -5.3 * scale],
            [1004.5 * scale, 304.5 * scale, 5.3 * scale],
        );
        let offsets = transition_shell_offsets(swept, transition);
        let coordinate_scale = transition
            .0
            .into_iter()
            .chain(transition.1)
            .map(f64::abs)
            .fold(0.0, f64::max);
        let rounding_bound = 16.0 * f64::EPSILON * coordinate_scale;
        assert!(offsets
            .iter()
            .all(|offset| (*offset - 4.5 * scale).abs() <= rounding_bound));

        let disconnected_union = (
            swept.0,
            [swept.1[0], swept.1[1], 310.8 * scale],
        );
        let union_offsets = transition_shell_offsets(disconnected_union, transition);
        assert!(union_offsets[5] < 0.0);
    }

    #[test]
    fn exact_swept_marker_selection_rejects_missing_and_ambiguous_evidence() {
        assert!(select_exact_swept_body_marker([None, None]).is_err());
        assert!(select_exact_swept_body_marker([Some(1), Some(2)]).is_err());
        assert_eq!(select_exact_swept_body_marker([None, Some(2)]), Ok(2));
    }

    #[test]
    fn exact_swept_bounds_rejects_missing_body_bounds() {
        let bounds = std::collections::BTreeMap::new();
        assert!(exact_swept_body_bounds_for_marker(1, &bounds).is_err());
    }
}
