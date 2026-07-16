//! FEM P1 probe-grid sampling and finite-k dynamic structure factors.

use num_complex::Complex64;
use rustfft::FftPlanner;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

use fullmag_ir::{BackendPlanIR, DriveActivationIR, ExecutionPlanIR, ProblemIR};
use crate::types::{AuxiliaryArtifact, RunError};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct P1CrossSectionProbeRow {
    pub x_m: f64,
    pub node_indices: Vec<usize>,
    pub normalized_weights: Vec<f64>,
    pub magnetic_mass_per_m: f64,
    pub valid: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct P1CrossSectionProbeOperator {
    pub schema_version: String,
    pub propagation_axis: String,
    pub mesh_probe_signature: String,
    pub rows: Vec<P1CrossSectionProbeRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct P1Probe {
    pub element_index: usize,
    pub barycentric: [f64; 4],
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DynamicStructureFactorArtifact {
    pub schema_version: String,
    pub artifact_ref: String,
    pub bounded: bool,
    pub original_frequency_count: usize,
    pub original_wavevector_count: usize,
    pub wavevector_unit: String,
    pub frequency_unit: String,
    pub x_m: Vec<f64>,
    pub time_s: Vec<f64>,
    pub k_rad_per_m: Vec<f64>,
    pub frequency_hz: Vec<f64>,
    /// Frequency-major, then wavevector-major power values.
    pub power: Vec<f64>,
    pub spectrum_real: Vec<f64>,
    pub spectrum_imag: Vec<f64>,
    pub source_power: Vec<f64>,
    pub source_spectrum_real: Vec<f64>,
    pub source_spectrum_imag: Vec<f64>,
    pub source_observable: String,
    pub source_unit: String,
    pub component: String,
    pub propagation_axis: String,
    pub phase_convention: String,
    pub normalization: String,
    pub spatial_window: Vec<f64>,
    pub temporal_window: Vec<f64>,
    pub spatial_window_power_sum: f64,
    pub temporal_window_power_sum: f64,
    pub mesh_probe_signature: String,
    pub invalid_probe_mask: Vec<bool>,
    pub excluded_absorber_ranges_m: Vec<[f64; 2]>,
    pub frequency_count: usize,
    pub wavevector_count: usize,
}

pub fn sample_p1_vector_field(
    elements: &[[usize; 4]],
    nodal_values: &[[f64; 3]],
    probes: &[P1Probe],
) -> Result<Vec<[f64; 3]>, String> {
    probes
        .iter()
        .map(|probe| {
            let element = elements
                .get(probe.element_index)
                .ok_or_else(|| format!("probe references missing element {}", probe.element_index))?;
            let sum: f64 = probe.barycentric.iter().sum();
            if probe.barycentric.iter().any(|weight| !weight.is_finite() || *weight < -1e-12)
                || (sum - 1.0).abs() > 1e-10
            {
                return Err("probe barycentric coordinates must be finite, non-negative, and sum to one".into());
            }
            let mut value = [0.0; 3];
            for (node, weight) in element.iter().zip(probe.barycentric) {
                let nodal = nodal_values
                    .get(*node)
                    .ok_or_else(|| format!("element references missing node {node}"))?;
                for component in 0..3 {
                    value[component] += weight * nodal[component];
                }
            }
            Ok(value)
        })
        .collect()
}

/// Build an exact P1 cross-section average operator for planes x=constant.
///
/// Each tetrahedron-plane polygon is triangulated deterministically. A
/// degree-two triangle rule integrates `Ms * phi_i` exactly for nodal P1 Ms;
/// the resulting sparse row is normalized by its magnetic cross-section mass.
pub fn build_p1_x_cross_section_operator(
    nodes: &[[f64; 3]],
    elements: &[[u32; 4]],
    element_markers: &[u32],
    nodal_ms: &[f64],
    x_positions_m: &[f64],
) -> Result<P1CrossSectionProbeOperator, String> {
    if nodes.is_empty() || elements.is_empty() || nodal_ms.len() != nodes.len() {
        return Err("P1 cross-section operator requires non-empty mesh and one Ms value per node".into());
    }
    if !element_markers.is_empty() && element_markers.len() != elements.len() {
        return Err("element marker count must be zero or equal the tetrahedron count".into());
    }
    if nodal_ms.iter().any(|value| !value.is_finite() || *value <= 0.0)
        || x_positions_m.windows(2).any(|pair| !pair[0].is_finite() || pair[1] <= pair[0])
    {
        return Err("Ms must be finite and positive and probe x positions strictly increasing".into());
    }
    let domain_scale = nodes.iter().flat_map(|node| node.iter()).map(|value| value.abs()).fold(0.0, f64::max).max(1e-30);
    let epsilon = 64.0 * f64::EPSILON * domain_scale;
    let face_owners = tetra_face_owners(elements, element_markers);
    let mut rows = Vec::with_capacity(x_positions_m.len());
    for &x_m in x_positions_m {
        let mut accumulated = std::collections::BTreeMap::<usize, f64>::new();
        for (element_index, element) in elements.iter().enumerate() {
            if !element_markers.is_empty() && element_markers[element_index] == 0 { continue; }
            let tetra = element.map(|node| nodes[node as usize]);
            if let Some(face) = coincident_x_face(element, &tetra, x_m, epsilon) {
                if face_owners.get(&face).copied() != Some(element_index) { continue; }
            }
            let polygon = tetra_plane_x_polygon(&tetra, x_m, epsilon);
            if polygon.len() < 3 { continue; }
            let triangles = triangulate_cross_section_polygon(&polygon);
            for triangle in triangles {
                let area = triangle_area_yz(&triangle);
                if area <= epsilon * epsilon { continue; }
                // Symmetric degree-two rule: barycentric permutations of (2/3,1/6,1/6).
                for q in [[2.0/3.0, 1.0/6.0, 1.0/6.0], [1.0/6.0, 2.0/3.0, 1.0/6.0], [1.0/6.0, 1.0/6.0, 2.0/3.0]] {
                    let mut phi = [0.0; 4];
                    for vertex in 0..3 { for local in 0..4 { phi[local] += q[vertex] * triangle[vertex].barycentric[local]; } }
                    let ms = (0..4).map(|local| phi[local] * nodal_ms[element[local] as usize]).sum::<f64>();
                    for local in 0..4 {
                        *accumulated.entry(element[local] as usize).or_default() += area / 3.0 * ms * phi[local];
                    }
                }
            }
        }
        let magnetic_mass_per_m = accumulated.values().sum::<f64>();
        let valid = magnetic_mass_per_m.is_finite() && magnetic_mass_per_m > 0.0;
        let (node_indices, normalized_weights) = if valid {
            accumulated.into_iter().map(|(node, weight)| (node, weight / magnetic_mass_per_m)).unzip()
        } else { (vec![], vec![]) };
        rows.push(P1CrossSectionProbeRow { x_m, node_indices, normalized_weights, magnetic_mass_per_m, valid });
    }
    let signature_payload = serde_json::to_vec(&(nodes, elements, element_markers, nodal_ms, x_positions_m))
        .map_err(|error| format!("failed to serialize probe signature input: {error}"))?;
    Ok(P1CrossSectionProbeOperator {
        schema_version: "fem_p1_x_cross_section_probe.v1".into(),
        propagation_axis: "x".into(),
        mesh_probe_signature: format!("{:x}", Sha256::digest(signature_payload)),
        rows,
    })
}

fn tetra_face_owners(
    elements: &[[u32; 4]],
    element_markers: &[u32],
) -> std::collections::BTreeMap<[u32; 3], usize> {
    let mut owners = std::collections::BTreeMap::new();
    for (element_index, element) in elements.iter().enumerate() {
        if !element_markers.is_empty() && element_markers[element_index] == 0 { continue; }
        for omitted in 0..4 {
            let mut face = Vec::with_capacity(3);
            for (local, node) in element.iter().enumerate() { if local != omitted { face.push(*node); } }
            face.sort_unstable();
            owners.entry([face[0], face[1], face[2]]).or_insert(element_index);
        }
    }
    owners
}

/// Half-open ownership for a plane coincident with a tetrahedral face: the
/// lowest-index magnetic tetrahedron incident to that face owns its area.
fn coincident_x_face(
    element: &[u32; 4],
    tetra: &[[f64; 3]; 4],
    x_m: f64,
    epsilon: f64,
) -> Option<[u32; 3]> {
    let on_plane = (0..4).filter(|local| (tetra[*local][0] - x_m).abs() <= epsilon).collect::<Vec<_>>();
    if on_plane.len() != 3 { return None; }
    let mut face = on_plane.into_iter().map(|local| element[local]).collect::<Vec<_>>();
    face.sort_unstable();
    Some([face[0], face[1], face[2]])
}

pub fn apply_p1_cross_section_operator(
    operator: &P1CrossSectionProbeOperator,
    nodal_values: &[[f64; 3]],
    component: usize,
) -> Result<Vec<Option<f64>>, String> {
    if component >= 3 { return Err("probe component must be 0, 1, or 2".into()); }
    operator.rows.iter().map(|row| {
        if !row.valid { return Ok(None); }
        row.node_indices.iter().zip(&row.normalized_weights).try_fold(0.0, |sum, (node, weight)| {
            nodal_values.get(*node).map(|value| sum + weight * value[component])
                .ok_or_else(|| format!("probe operator references missing node {node}"))
        }).map(Some)
    }).collect()
}

pub fn apply_p1_cross_section_operator_scalar(
    operator: &P1CrossSectionProbeOperator,
    nodal_values: &[f64],
) -> Result<Vec<Option<f64>>, String> {
    operator.rows.iter().map(|row| {
        if !row.valid { return Ok(None); }
        row.node_indices.iter().zip(&row.normalized_weights).try_fold(0.0, |sum, (node, weight)| {
            nodal_values.get(*node).map(|value| sum + weight * value)
                .ok_or_else(|| format!("probe operator references missing node {node}"))
        }).map(Some)
    }).collect()
}

#[derive(Debug, Clone, Copy)]
struct CrossSectionVertex { point: [f64; 3], barycentric: [f64; 4] }

fn tetra_plane_x_polygon(tetra: &[[f64; 3]; 4], x_m: f64, epsilon: f64) -> Vec<CrossSectionVertex> {
    const EDGES: [[usize; 2]; 6] = [[0,1],[0,2],[0,3],[1,2],[1,3],[2,3]];
    let mut vertices = Vec::new();
    for [a, b] in EDGES {
        let da = tetra[a][0] - x_m;
        let db = tetra[b][0] - x_m;
        if da.abs() <= epsilon {
            let mut barycentric = [0.0; 4]; barycentric[a] = 1.0;
            push_unique_cross_section_vertex(&mut vertices, CrossSectionVertex { point: tetra[a], barycentric }, epsilon);
        }
        if db.abs() <= epsilon {
            let mut barycentric = [0.0; 4]; barycentric[b] = 1.0;
            push_unique_cross_section_vertex(&mut vertices, CrossSectionVertex { point: tetra[b], barycentric }, epsilon);
        }
        if (da < -epsilon && db > epsilon) || (da > epsilon && db < -epsilon) {
            let fraction = da / (da - db);
            let mut point = [0.0; 3];
            for axis in 0..3 { point[axis] = tetra[a][axis] + fraction * (tetra[b][axis] - tetra[a][axis]); }
            let mut barycentric = [0.0; 4]; barycentric[a] = 1.0 - fraction; barycentric[b] = fraction;
            push_unique_cross_section_vertex(&mut vertices, CrossSectionVertex { point, barycentric }, epsilon);
        }
    }
    let centroid_y = vertices.iter().map(|vertex| vertex.point[1]).sum::<f64>() / vertices.len().max(1) as f64;
    let centroid_z = vertices.iter().map(|vertex| vertex.point[2]).sum::<f64>() / vertices.len().max(1) as f64;
    vertices.sort_by(|left, right| {
        let la = (left.point[2] - centroid_z).atan2(left.point[1] - centroid_y);
        let ra = (right.point[2] - centroid_z).atan2(right.point[1] - centroid_y);
        la.total_cmp(&ra).then_with(|| left.point[1].total_cmp(&right.point[1])).then_with(|| left.point[2].total_cmp(&right.point[2]))
    });
    vertices
}

fn push_unique_cross_section_vertex(vertices: &mut Vec<CrossSectionVertex>, candidate: CrossSectionVertex, epsilon: f64) {
    if !vertices.iter().any(|vertex| (1..3).all(|axis| (vertex.point[axis] - candidate.point[axis]).abs() <= epsilon)) {
        vertices.push(candidate);
    }
}

fn triangulate_cross_section_polygon(polygon: &[CrossSectionVertex]) -> Vec<[CrossSectionVertex; 3]> {
    if polygon.len() == 3 { return vec![[polygon[0], polygon[1], polygon[2]]]; }
    if polygon.len() == 4 {
        let diagonal_02 = ordered_point_pair(polygon[0].point, polygon[2].point);
        let diagonal_13 = ordered_point_pair(polygon[1].point, polygon[3].point);
        if diagonal_02 <= diagonal_13 {
            return vec![[polygon[0], polygon[1], polygon[2]], [polygon[0], polygon[2], polygon[3]]];
        }
        return vec![[polygon[0], polygon[1], polygon[3]], [polygon[1], polygon[2], polygon[3]]];
    }
    vec![]
}

fn ordered_point_pair(a: [f64; 3], b: [f64; 3]) -> [[u64; 3]; 2] {
    let a_bits = a.map(f64::to_bits); let b_bits = b.map(f64::to_bits);
    if a_bits <= b_bits { [a_bits, b_bits] } else { [b_bits, a_bits] }
}

fn triangle_area_yz(triangle: &[CrossSectionVertex; 3]) -> f64 {
    let [a,b,c] = triangle.map(|vertex| vertex.point);
    0.5 * ((b[1]-a[1])*(c[2]-a[2]) - (b[2]-a[2])*(c[1]-a[1])).abs()
}

pub fn dynamic_structure_factor_1d(
    samples_time_major: &[Vec<f64>],
    dt_s: f64,
    dx_m: f64,
) -> Result<DynamicStructureFactorArtifact, String> {
    let time_s = (0..samples_time_major.len()).map(|index| index as f64 * dt_s).collect::<Vec<_>>();
    let space_count = samples_time_major.first().map_or(0, Vec::len);
    let x_m = (0..space_count).map(|index| index as f64 * dx_m).collect::<Vec<_>>();
    dynamic_structure_factor_1d_with_axes(samples_time_major, &time_s, &x_m, "unversioned", "m")
}

pub fn dynamic_structure_factor_1d_with_axes(
    samples_time_major: &[Vec<f64>],
    time_s: &[f64],
    x_m: &[f64],
    mesh_probe_signature: &str,
    component: &str,
) -> Result<DynamicStructureFactorArtifact, String> {
    let time_count = samples_time_major.len();
    let space_count = samples_time_major.first().map_or(0, Vec::len);
    if time_s.len() != time_count || x_m.len() != space_count {
        return Err("finite-k sample axes must match the rectangular trace dimensions".into());
    }
    let dt_s = time_s.get(1).zip(time_s.first()).map_or(0.0, |(next, first)| next - first);
    let dx_m = x_m.get(1).zip(x_m.first()).map_or(0.0, |(next, first)| next - first);
    if time_count < 4
        || space_count < 4
        || !dt_s.is_finite()
        || dt_s <= 0.0
        || !dx_m.is_finite()
        || dx_m <= 0.0
        || samples_time_major.iter().any(|row| row.len() != space_count || row.iter().any(|value| !value.is_finite()))
        || time_s.windows(2).any(|pair| ((pair[1] - pair[0]) - dt_s).abs() > dt_s.abs() * 1e-9 + f64::EPSILON)
        || x_m.windows(2).any(|pair| ((pair[1] - pair[0]) - dx_m).abs() > dx_m.abs() * 1e-9 + f64::EPSILON)
    {
        return Err("finite-k FFT requires a rectangular >=4x4 grid and positive finite dt/dx".into());
    }

    let spatial_window = hann_window(space_count);
    let temporal_window = hann_window(time_count);
    let spatial_window_power_sum = spatial_window.iter().map(|value| value * value).sum::<f64>();
    let temporal_window_power_sum = temporal_window.iter().map(|value| value * value).sum::<f64>();
    let mut planner = FftPlanner::<f64>::new();
    let fft_space = planner.plan_fft_forward(space_count);
    let fft_time = planner.plan_fft_forward(time_count);
    let mut space_transformed = vec![vec![Complex64::new(0.0, 0.0); space_count]; time_count];
    for (time_index, row) in samples_time_major.iter().enumerate() {
        let mut buffer = row
            .iter()
            .enumerate()
            .map(|(index, value)| {
                Complex64::new((value - samples_time_major[0][index]) * spatial_window[index], 0.0)
            })
            .collect::<Vec<_>>();
        fft_space.process(&mut buffer);
        space_transformed[time_index] = buffer;
    }

    let frequency_count = time_count / 2 + 1;
    let mut unshifted_spectrum = vec![Complex64::new(0.0, 0.0); frequency_count * space_count];
    for wavevector_index in 0..space_count {
        let mut trace = (0..time_count)
            .map(|time_index| {
                space_transformed[time_index][wavevector_index].conj() * temporal_window[time_index]
            })
            .collect::<Vec<_>>();
        fft_time.process(&mut trace);
        for frequency_index in 0..frequency_count {
            unshifted_spectrum[frequency_index * space_count + wavevector_index] = trace[frequency_index].conj();
        }
    }

    let k_rad_per_m = (0..space_count)
        .map(|index| {
            let signed = index as isize - (space_count / 2) as isize;
            2.0 * std::f64::consts::PI * signed as f64 / (space_count as f64 * dx_m)
        })
        .collect();
    let frequency_hz = (0..frequency_count)
        .map(|index| index as f64 / (time_count as f64 * dt_s))
        .collect();
    let normalization = space_count as f64 * time_count as f64 * spatial_window_power_sum * temporal_window_power_sum;
    let mut spectrum = vec![Complex64::new(0.0, 0.0); frequency_count * space_count];
    let mut power = vec![0.0; frequency_count * space_count];
    for frequency in 0..frequency_count {
        for shifted_k in 0..space_count {
            let unshifted_k = (shifted_k + space_count / 2) % space_count;
            let value = unshifted_spectrum[frequency * space_count + unshifted_k];
            let index = frequency * space_count + shifted_k;
            spectrum[index] = value;
            power[index] = one_sided_factor(frequency, time_count) * value.norm_sqr() / normalization;
        }
    }
    Ok(DynamicStructureFactorArtifact {
        schema_version: "dynamic_structure_factor.1d.v1".into(),
        artifact_ref: "analysis/dynamic_structure_factor.1d.v1.json".into(),
        bounded: false,
        original_frequency_count: frequency_count,
        original_wavevector_count: space_count,
        wavevector_unit: "rad/m".into(),
        frequency_unit: "Hz".into(),
        x_m: x_m.to_vec(),
        time_s: time_s.to_vec(),
        k_rad_per_m,
        frequency_hz,
        power,
        spectrum_real: spectrum.iter().map(|value| value.re).collect(),
        spectrum_imag: spectrum.iter().map(|value| value.im).collect(),
        source_power: vec![],
        source_spectrum_real: vec![],
        source_spectrum_imag: vec![],
        source_observable: "".into(),
        source_unit: "".into(),
        component: component.into(),
        propagation_axis: "x".into(),
        phase_convention: "exp[-i(k*x-2*pi*f*t)]".into(),
        normalization: "one_sided_abs_fft2_squared_over_Nx_Nt_Ux_Ut".into(),
        spatial_window,
        temporal_window,
        spatial_window_power_sum,
        temporal_window_power_sum,
        mesh_probe_signature: mesh_probe_signature.into(),
        invalid_probe_mask: vec![false; space_count],
        excluded_absorber_ranges_m: vec![],
        frequency_count,
        wavevector_count: space_count,
    })
}

fn hann_window(length: usize) -> Vec<f64> {
    (0..length).map(|index| 0.5 * (1.0 - (2.0 * std::f64::consts::PI * index as f64 / (length - 1) as f64).cos())).collect()
}

fn one_sided_factor(index: usize, length: usize) -> f64 {
    if index == 0 || (length % 2 == 0 && index == length / 2) { 1.0 } else { 2.0 }
}

pub(crate) fn requested_finite_k_artifacts(
    problem: &ProblemIR,
    plan: &ExecutionPlanIR,
    output_dir: &Path,
) -> Result<Vec<AuxiliaryArtifact>, RunError> {
    let Some(request) = problem.problem_meta.runtime_metadata.get("spin_wave_response") else { return Ok(vec![]) };
    if request.get("analysis").and_then(serde_json::Value::as_str) != Some("finite_k") { return Ok(vec![]) }
    let BackendPlanIR::Fem(fem) = &plan.backend_plan else {
        return Err(run_error("finite-k time-domain analysis currently requires a FEM plan"));
    };
    let active_stage_id = fem.time_stage.active_stage_id.as_deref();
    let has_active_drive = fem.field_drives.iter().any(|drive| drive.enabled && match &drive.activation {
        DriveActivationIR::AllTimeEvolution {} => true,
        DriveActivationIR::StageIds { stage_ids } => active_stage_id.is_some_and(|active| stage_ids.iter().any(|stage| stage == active)),
    });
    if !has_active_drive { return Ok(vec![]); }
    let component = match request.get("response_component").and_then(serde_json::Value::as_str).unwrap_or("my") {
        "mx" => (0, "mx"), "my" => (1, "my"), "mz" => (2, "mz"),
        value => return Err(run_error(format!("unsupported finite-k response_component '{value}'"))),
    };
    let sample_count = request.get("probe_count").and_then(serde_json::Value::as_u64).unwrap_or(128) as usize;
    if !(4..=2048).contains(&sample_count) { return Err(run_error("finite-k probe_count must be in 4..=2048")); }
    let magnetic_nodes = fem.mesh.elements.iter().enumerate()
        .filter(|(index, _)| fem.mesh.element_markers.is_empty() || fem.mesh.element_markers[*index] != 0)
        .flat_map(|(_, element)| element.iter().map(|node| *node as usize))
        .collect::<std::collections::BTreeSet<_>>();
    let inferred_min = magnetic_nodes.iter().map(|node| fem.mesh.nodes[*node][0]).fold(f64::INFINITY, f64::min);
    let inferred_max = magnetic_nodes.iter().map(|node| fem.mesh.nodes[*node][0]).fold(f64::NEG_INFINITY, f64::max);
    let x_min = request.get("analysis_x_min_m").and_then(serde_json::Value::as_f64).unwrap_or(inferred_min);
    let x_max = request.get("analysis_x_max_m").and_then(serde_json::Value::as_f64).unwrap_or(inferred_max);
    if !x_min.is_finite() || !x_max.is_finite() || x_max <= x_min { return Err(run_error("finite-k analysis x range must be finite and non-empty")); }
    // Cell-centred probes avoid exact coincidence with mesh vertices while preserving uniform spacing.
    let dx = (x_max - x_min) / sample_count as f64;
    let x_m = (0..sample_count).map(|index| x_min + (index as f64 + 0.5) * dx).collect::<Vec<_>>();
    let nodal_ms = fem.material.ms_field.clone().unwrap_or_else(|| vec![fem.material.saturation_magnetisation; fem.mesh.nodes.len()]);
    let operator = build_p1_x_cross_section_operator(&fem.mesh.nodes, &fem.mesh.elements, &fem.mesh.element_markers, &nodal_ms, &x_m).map_err(run_error)?;
    if operator.rows.iter().any(|row| !row.valid) { return Err(run_error("finite-k probe range contains a cross-section without positive magnetic mass")); }
    let (time_s, snapshots) = read_native_fem_zarr_component(output_dir, "m", fem.mesh.nodes.len(), component.0)?;
    if snapshots.len() < 4 { return Err(run_error("finite-k analysis requires at least four saved m snapshots")); }
    let samples = snapshots.iter().map(|snapshot| {
        apply_p1_cross_section_operator_scalar(&operator, snapshot).map_err(run_error)?.into_iter()
            .map(|value| value.ok_or_else(|| run_error("finite-k probe row became invalid"))).collect::<Result<Vec<_>, _>>()
    }).collect::<Result<Vec<_>, _>>()?;
    let mut artifact = dynamic_structure_factor_1d_with_axes(&samples, &time_s, &x_m, &operator.mesh_probe_signature, component.1).map_err(run_error)?;
    let (source_time_s, source_snapshots) = read_native_fem_zarr_component(output_dir, "H_drive", fem.mesh.nodes.len(), component.0)?;
    if source_time_s.len() != time_s.len() || source_time_s.iter().zip(&time_s).any(|(left, right)| (left-right).abs() > 1e-18) {
        return Err(run_error("finite-k H_drive snapshots must use the same time axis as m snapshots"));
    }
    let source_samples = source_snapshots.iter().map(|snapshot| {
        apply_p1_cross_section_operator_scalar(&operator, snapshot).map_err(run_error)?.into_iter()
            .map(|value| value.ok_or_else(|| run_error("finite-k source probe row became invalid"))).collect::<Result<Vec<_>, _>>()
    }).collect::<Result<Vec<_>, _>>()?;
    let source_artifact = dynamic_structure_factor_1d_with_axes(&source_samples, &time_s, &x_m, &operator.mesh_probe_signature, "H_drive").map_err(run_error)?;
    artifact.source_power = source_artifact.power;
    artifact.source_spectrum_real = source_artifact.spectrum_real;
    artifact.source_spectrum_imag = source_artifact.spectrum_imag;
    artifact.source_observable = "H_drive".into();
    artifact.source_unit = "A/m".into();
    artifact.invalid_probe_mask = operator.rows.iter().map(|row| !row.valid).collect();
    artifact.excluded_absorber_ranges_m = request.get("excluded_absorber_ranges_m")
        .and_then(serde_json::Value::as_array).map(|ranges| ranges.iter().filter_map(|range| {
            let values = range.as_array()?; Some([values.first()?.as_f64()?, values.get(1)?.as_f64()?])
        }).collect()).unwrap_or_default();
    Ok(vec![
        json_artifact("analysis/fem_p1_cross_section_probe.v1.json", &operator)?,
        json_artifact("analysis/dynamic_structure_factor.1d.v1.json", &artifact)?,
    ])
}

fn read_native_fem_zarr_component(
    output_dir: &Path,
    observable: &str,
    node_count: usize,
    component: usize,
) -> Result<(Vec<f64>, Vec<Vec<f64>>), RunError> {
    let root = output_dir.join("fields").join(format!("{observable}.zarr"));
    let samples_csv = std::fs::read_to_string(root.join("samples.csv"))
        .map_err(|error| run_error(format!("finite-k analysis requires saved {observable} snapshots: {error}")))?;
    let mut times = Vec::new(); let mut snapshots = Vec::new();
    for line in samples_csv.lines().skip(1).filter(|line| !line.trim().is_empty()) {
        let columns = line.split(',').collect::<Vec<_>>();
        if columns.len() != 8 { return Err(run_error("invalid native FEM Zarr samples.csv row")); }
        let time = columns[2].parse::<f64>().map_err(|error| run_error(format!("invalid snapshot time: {error}")))?;
        let scalar_bytes = columns[6].parse::<usize>().map_err(|error| run_error(format!("invalid snapshot scalar size: {error}")))?;
        let cells = columns[7].parse::<usize>().map_err(|error| run_error(format!("invalid snapshot node count: {error}")))?;
        if scalar_bytes != 8 || cells != node_count { return Err(run_error("finite-k analysis requires float64 FEM snapshots matching the planned node count")); }
        let bytes = std::fs::read(root.join(columns[4])).map_err(|error| run_error(format!("failed to read FEM snapshot chunk: {error}")))?;
        if bytes.len() != node_count * 3 * 8 { return Err(run_error("invalid SoA FEM snapshot chunk length")); }
        let offset = component * node_count * 8;
        let values = (0..node_count).map(|node| {
            let start = offset + node * 8;
            f64::from_le_bytes(bytes[start..start+8].try_into().expect("eight-byte snapshot scalar"))
        }).collect();
        times.push(time); snapshots.push(values);
    }
    Ok((times, snapshots))
}

fn json_artifact(path: &str, value: &impl Serialize) -> Result<AuxiliaryArtifact, RunError> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|error| run_error(format!("failed to serialize {path}: {error}")))?;
    bytes.push(b'\n');
    Ok(AuxiliaryArtifact { relative_path: path.into(), bytes })
}

fn run_error(message: impl Into<String>) -> RunError { RunError { message: message.into() } }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn p1_probe_reproduces_a_linear_vector_field() {
        let nodes = [[0.0, 0.0, 0.0], [1.0, 2.0, 3.0], [2.0, 4.0, 6.0], [3.0, 6.0, 9.0]];
        let sampled = sample_p1_vector_field(
            &[[0, 1, 2, 3]],
            &nodes,
            &[P1Probe { element_index: 0, barycentric: [0.1, 0.2, 0.3, 0.4] }],
        ).unwrap();
        assert_eq!(sampled[0], [2.0, 4.0, 6.0]);
    }

    #[test]
    fn cross_section_operator_exactly_averages_a_linear_p1_field() {
        let nodes = [[0.0,0.0,0.0], [1.0,0.0,0.0], [0.0,1.0,0.0], [0.0,0.0,1.0]];
        let elements = [[0,1,2,3]];
        let operator = build_p1_x_cross_section_operator(&nodes, &elements, &[1], &[2.0; 4], &[0.25]).unwrap();
        let field = nodes.map(|point| [0.0, point[1] + 2.0 * point[2], 0.0]);
        let sampled = apply_p1_cross_section_operator(&operator, &field, 1).unwrap();
        assert!((sampled[0].unwrap() - 0.75).abs() < 1e-14);
        assert!((operator.rows[0].normalized_weights.iter().sum::<f64>() - 1.0).abs() < 1e-14);
        assert!(operator.rows[0].magnetic_mass_per_m > 0.0);
    }

    #[test]
    fn cross_section_operator_marks_empty_planes_invalid() {
        let nodes = [[0.0,0.0,0.0], [1.0,0.0,0.0], [0.0,1.0,0.0], [0.0,0.0,1.0]];
        let operator = build_p1_x_cross_section_operator(&nodes, &[[0,1,2,3]], &[1], &[1.0; 4], &[2.0]).unwrap();
        assert!(!operator.rows[0].valid);
        assert_eq!(apply_p1_cross_section_operator(&operator, &nodes, 0).unwrap(), vec![None]);
        assert_eq!(apply_p1_cross_section_operator_scalar(&operator, &[0.0; 4]).unwrap(), vec![None]);
    }

    #[test]
    fn coincident_internal_face_has_one_half_open_owner() {
        let nodes = vec![
            [0.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0],
            [-1.0, 0.0, 0.0], [1.0, 0.0, 0.0],
        ];
        let elements = [[0, 1, 2, 3], [0, 2, 1, 4]];
        let operator = build_p1_x_cross_section_operator(
            &nodes, &elements, &[1, 1], &[2.0; 5], &[0.0],
        ).unwrap();
        assert!(operator.rows[0].valid);
        assert!((operator.rows[0].magnetic_mass_per_m - 1.0).abs() < 1e-14,
            "shared triangular face area 1/2 times Ms=2 must be integrated once");
        assert_eq!(apply_p1_cross_section_operator_scalar(&operator, &[3.0; 5]).unwrap(), vec![Some(3.0)]);
    }

    #[test]
    fn finite_k_fft_finds_known_positive_frequency_and_wavevector() {
        let nt = 64;
        let nx = 32;
        let dt = 1e-12;
        let dx = 2e-9;
        let frequency_bin = 7;
        let wavevector_bin = 3;
        let samples = (0..nt).map(|time| {
            (0..nx).map(|space| {
                (2.0 * std::f64::consts::PI * (
                    wavevector_bin as f64 * space as f64 / nx as f64
                    - frequency_bin as f64 * time as f64 / nt as f64
                )).cos()
            }).collect::<Vec<_>>()
        }).collect::<Vec<_>>();
        let artifact = dynamic_structure_factor_1d(&samples, dt, dx).unwrap();
        let mut maximum = (0, 0, 0.0);
        for frequency in 1..artifact.frequency_count {
            for wavevector in 0..artifact.wavevector_count {
                let value = artifact.power[frequency * artifact.wavevector_count + wavevector];
                if value > maximum.2 { maximum = (frequency, wavevector, value); }
            }
        }
        assert_eq!(maximum.0, frequency_bin);
        let expected_k = 2.0 * std::f64::consts::PI * wavevector_bin as f64 / (nx as f64 * dx);
        assert!((artifact.k_rad_per_m[maximum.1] - expected_k).abs() < expected_k * 1e-12);
        assert_eq!(artifact.phase_convention, "exp[-i(k*x-2*pi*f*t)]");
        assert!(artifact.power.iter().all(|value| value.is_finite() && *value >= 0.0));
    }
}
