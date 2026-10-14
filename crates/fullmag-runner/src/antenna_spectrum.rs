use fullmag_ir::{
    AntennaSpectrumNormalizationIR, AntennaSpectrumRequestIR, AntennaSpectrumTransformIR,
    AntennaSpectrumWindowIR,
};
use num_complex::Complex64;
use rustfft::FftPlanner;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::antenna_field_solution::AntennaFieldSolutionSamples;
use crate::types::AuxiliaryArtifact;
use crate::types::RunError;

const MAX_ANTENNA_SPECTRUM_SAMPLE_COUNT: usize = 10_000_000;
const MAX_ANTENNA_NONUNIFORM_OPERATION_COUNT: usize = 100_000_000;

fn check_spectrum_interrupt(interrupt_requested: Option<&AtomicBool>) -> Result<(), RunError> {
    if interrupt_requested.is_some_and(|signal| signal.load(Ordering::Acquire)) {
        return Err(error("antenna source-spectrum cancelled: interrupt_requested"));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AntennaSourceSpectrum2D {
    pub schema_version: String,
    pub request_id: String,
    pub output_id: String,
    pub component: String,
    pub k_u_rad_per_m: Vec<f64>,
    pub k_v_rad_per_m: Vec<f64>,
    pub component_labels: Vec<String>,
    /// Component-major, then k_v-major, then k_u-major complex amplitudes.
    pub amplitudes_re_im: Vec<[f64; 2]>,
    /// k_v-major, then k_u-major sum of component squared magnitudes.
    pub power: Vec<f64>,
    pub coherent_gain: f64,
    pub equivalent_noise_bandwidth_bins: f64,
    pub normalization: String,
    pub amplitude_unit: String,
    pub wave_vector_unit: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AntennaSpectrumSampleGrid {
    pub positions_xyz_m: Vec<[f64; 3]>,
    pub field_xyz_apm_per_a: Vec<[f64; 3]>,
    pub outside_count: usize,
    pub mapping_digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AntennaSpectrumSamplingMetadata {
    pub schema_version: String,
    pub solution_id: String,
    pub source_object_id: String,
    pub port_mode_id: String,
    pub target: fullmag_ir::FieldTargetIR,
    pub origin_m: [f64; 3],
    pub axis_u: [f64; 3],
    pub axis_v: [f64; 3],
    pub extent_u_m: f64,
    pub extent_v_m: f64,
    pub sample_count_u: u32,
    pub sample_count_v: u32,
    pub interpolation: String,
    /// Authored transform realization, retained in the thin manifest so a
    /// consumer cannot infer it from array shape alone.
    #[serde(default)]
    pub transform: String,
    #[serde(default)]
    pub window: String,
    /// Versioned executable Fourier implementation identity.
    #[serde(default)]
    pub fourier_realization: String,
    /// Executed carrier realization, kept distinct from the authored request
    /// label for backwards-compatible identity assets.
    pub realization: String,
    pub outside_policy: String,
    pub outside_count: usize,
    pub source_sample_count: usize,
    pub mapping_digest: String,
    /// Local `(u, v)` coordinate of the first lattice sample used by both
    /// Fourier kernels.  The phase correction in the regular FFT makes it
    /// equivalent to the direct kernel's centered coordinates.
    pub fourier_origin_uv_m: [f64; 2],
    pub fourier_phase_convention: String,
}

/// Immutable reference to one binary spectrum array in the artifact store.
/// `value_count` counts scalar values, not bytes; complex amplitudes therefore
/// contain two `float64` values per complex sample.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AntennaSpectrumPayloadRef {
    pub path: String,
    pub sha256: String,
    pub scalar_type: String,
    pub layout: String,
    pub unit: String,
    pub value_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AntennaSpectrumPayloads {
    pub k_u_rad_per_m: AntennaSpectrumPayloadRef,
    pub k_v_rad_per_m: AntennaSpectrumPayloadRef,
    pub amplitudes_re_im: AntennaSpectrumPayloadRef,
    pub power: AntennaSpectrumPayloadRef,
}

/// JSON-only spectrum summary.  Numerical arrays are intentionally absent;
/// consumers load them through the binary payload references.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AntennaSourceSpectrumSummary {
    pub schema_version: String,
    pub request_id: String,
    pub output_id: String,
    pub component: String,
    pub component_labels: Vec<String>,
    pub k_u_count: usize,
    pub k_v_count: usize,
    pub amplitude_count: usize,
    pub power_count: usize,
    pub coherent_gain: f64,
    pub equivalent_noise_bandwidth_bins: f64,
    pub normalization: String,
    pub amplitude_unit: String,
    pub wave_vector_unit: String,
}

/// Published v2 source-spectrum manifest.  It is deliberately separate from
/// the in-memory result so serializing the manifest cannot accidentally put a
/// large FFT array on the control plane.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AntennaSourceSpectrumManifest {
    pub schema_version: String,
    pub request_id: String,
    pub output_id: String,
    pub solution_id: String,
    pub source_object_id: String,
    pub port_mode_id: String,
    pub solution_content_digest: String,
    pub content_digest: String,
    pub sampling: AntennaSpectrumSamplingMetadata,
    pub spectrum: AntennaSourceSpectrumSummary,
    pub payloads: AntennaSpectrumPayloads,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AntennaSourceSpectrumArtifact {
    pub schema_version: String,
    pub request_id: String,
    pub output_id: String,
    pub solution_id: String,
    pub source_object_id: String,
    pub port_mode_id: String,
    pub solution_content_digest: String,
    pub content_digest: String,
    pub sampling: AntennaSpectrumSamplingMetadata,
    pub spectrum: AntennaSourceSpectrum2D,
}

fn error(message: impl Into<String>) -> RunError {
    RunError {
        message: message.into(),
    }
}

fn sha256_bytes(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn encode_f64_le(values: impl IntoIterator<Item = f64>) -> Vec<u8> {
    let mut bytes = Vec::new();
    for value in values {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes
}

fn encode_complex_f64_le(values: &[[f64; 2]]) -> Vec<u8> {
    encode_f64_le(values.iter().flat_map(|value| value.iter().copied()))
}

fn sha256_u64(values: &[u64]) -> String {
    let mut bytes = Vec::with_capacity(values.len() * std::mem::size_of::<u64>());
    for value in values {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    sha256_bytes(&bytes)
}

fn spectrum_window_name(window: &AntennaSpectrumWindowIR) -> &'static str {
    match window {
        AntennaSpectrumWindowIR::Rectangular => "rectangular",
        AntennaSpectrumWindowIR::Hann => "hann",
        AntennaSpectrumWindowIR::Hamming => "hamming",
        AntennaSpectrumWindowIR::Blackman => "blackman",
    }
}

fn spectrum_transform_metadata(
    transform: &AntennaSpectrumTransformIR,
) -> (&'static str, &'static str) {
    match transform {
        AntennaSpectrumTransformIR::SpatialFft => {
            ("spatial_fft", "structured_fft_rustfft_centered_v1")
        }
        AntennaSpectrumTransformIR::NonuniformSpatialFft => (
            "nonuniform_spatial_fft",
            "direct_nonuniform_dft_centered_v1",
        ),
    }
}

fn coordinate_key(position: [f64; 3], tolerance_m: f64) -> Option<[i64; 3]> {
    let mut key = [0_i64; 3];
    for (index, value) in position.into_iter().enumerate() {
        let quantized = (value / tolerance_m).round();
        if !quantized.is_finite() || quantized < i64::MIN as f64 || quantized > i64::MAX as f64 {
            return None;
        }
        key[index] = quantized as i64;
    }
    Some(key)
}

fn coordinate_tolerance(
    request: &AntennaSpectrumRequestIR,
    spacing_u: f64,
    spacing_v: f64,
) -> Result<f64, RunError> {
    let plane = &request.sampling_plane;
    let coordinate_scale = (0..3)
        .map(|axis| {
            plane.origin_m[axis].abs()
                + 0.5
                    * (plane.extent_u_m * plane.axis_u[axis].abs()
                        + plane.extent_v_m * plane.axis_v[axis].abs())
        })
        .fold(spacing_u.max(spacing_v), f64::max);
    let minimum_spacing = spacing_u.min(spacing_v);
    let tolerance_m = (minimum_spacing * 1.0e-9)
        .max(2.0 * f64::EPSILON * coordinate_scale);
    if 2.0 * tolerance_m >= minimum_spacing {
        return Err(error(
            "antenna source-spectrum plane spacing is not resolvable at its absolute coordinates",
        ));
    }
    Ok(tolerance_m)
}

fn coordinate_distance_squared(a: [f64; 3], b: [f64; 3]) -> f64 {
    a.into_iter()
        .zip(b)
        .map(|(a, b)| {
            let delta = a - b;
            delta * delta
        })
        .sum()
}

fn source_bounds(samples: &[[f64; 3]]) -> ([f64; 3], [f64; 3]) {
    let mut minimum = [f64::INFINITY; 3];
    let mut maximum = [f64::NEG_INFINITY; 3];
    for position in samples {
        for axis in 0..3 {
            minimum[axis] = minimum[axis].min(position[axis]);
            maximum[axis] = maximum[axis].max(position[axis]);
        }
    }
    (minimum, maximum)
}

fn point_inside_source_bounds(
    position: [f64; 3],
    minimum: [f64; 3],
    maximum: [f64; 3],
    tolerance_m: f64,
) -> bool {
    position
        .into_iter()
        .zip(minimum.into_iter().zip(maximum))
        .all(|(value, (minimum, maximum))| {
            value >= minimum - tolerance_m && value <= maximum + tolerance_m
        })
}

#[derive(Debug, Clone, Copy)]
struct FieldAabb {
    minimum: [f64; 3],
    maximum: [f64; 3],
}

impl FieldAabb {
    fn from_tetra(positions: &[[f64; 3]], tetra: [u32; 4], margin: f64) -> Option<Self> {
        let first = positions.get(tetra[0] as usize).copied()?;
        let mut minimum = first;
        let mut maximum = first;
        for node in tetra.into_iter().skip(1) {
            let position = positions.get(node as usize).copied()?;
            for axis in 0..3 {
                minimum[axis] = minimum[axis].min(position[axis]);
                maximum[axis] = maximum[axis].max(position[axis]);
            }
        }
        Some(Self {
            minimum: [
                minimum[0] - margin,
                minimum[1] - margin,
                minimum[2] - margin,
            ],
            maximum: [
                maximum[0] + margin,
                maximum[1] + margin,
                maximum[2] + margin,
            ],
        })
    }

    fn contains(&self, position: [f64; 3]) -> bool {
        (0..3).all(|axis| {
            position[axis] >= self.minimum[axis] && position[axis] <= self.maximum[axis]
        })
    }

    fn merge(self, other: Self) -> Self {
        Self {
            minimum: [
                self.minimum[0].min(other.minimum[0]),
                self.minimum[1].min(other.minimum[1]),
                self.minimum[2].min(other.minimum[2]),
            ],
            maximum: [
                self.maximum[0].max(other.maximum[0]),
                self.maximum[1].max(other.maximum[1]),
                self.maximum[2].max(other.maximum[2]),
            ],
        }
    }

    fn longest_axis(self) -> usize {
        let extents = [
            self.maximum[0] - self.minimum[0],
            self.maximum[1] - self.minimum[1],
            self.maximum[2] - self.minimum[2],
        ];
        if extents[0] >= extents[1] && extents[0] >= extents[2] {
            0
        } else if extents[1] >= extents[2] {
            1
        } else {
            2
        }
    }
}

enum FieldBvhNode {
    Leaf {
        bounds: FieldAabb,
        cell_index: usize,
    },
    Internal {
        bounds: FieldAabb,
        left: Box<FieldBvhNode>,
        right: Box<FieldBvhNode>,
    },
}

pub(crate) struct FieldTetraBvh {
    root: Option<FieldBvhNode>,
}

impl FieldTetraBvh {
    pub(crate) fn build(
        positions: &[[f64; 3]],
        cells: &[[u32; 4]],
        margin: f64,
    ) -> Result<Self, RunError> {
        Self::build_interruptible(positions, cells, margin, None)
    }

    fn build_interruptible(
        positions: &[[f64; 3]],
        cells: &[[u32; 4]],
        margin: f64,
        interrupt_requested: Option<&AtomicBool>,
    ) -> Result<Self, RunError> {
        check_spectrum_interrupt(interrupt_requested)?;
        if cells.is_empty() {
            return Ok(Self { root: None });
        }
        let mut entries = Vec::with_capacity(cells.len());
        for (cell_index, cell) in cells.iter().copied().enumerate() {
            if cell_index % 4096 == 0 {
                check_spectrum_interrupt(interrupt_requested)?;
            }
            let bounds = FieldAabb::from_tetra(positions, cell, margin).ok_or_else(|| {
                error(format!(
                    "antenna source-spectrum topology cell {cell_index} references a missing sample node"
                ))
            })?;
            let vertices = cell.map(|node| positions[node as usize]);
            if barycentric_tet(vertices[0], vertices).is_none() {
                return Err(error(format!(
                    "antenna source-spectrum topology cell {cell_index} is a degenerate tet4 element"
                )));
            }
            let center = [
                0.5 * (bounds.minimum[0] + bounds.maximum[0]),
                0.5 * (bounds.minimum[1] + bounds.maximum[1]),
                0.5 * (bounds.minimum[2] + bounds.maximum[2]),
            ];
            entries.push((bounds, center, cell_index));
        }
        Ok(Self {
            root: Some(Self::build_recursive(&mut entries, interrupt_requested)?),
        })
    }

    fn build_recursive(
        entries: &mut [(FieldAabb, [f64; 3], usize)],
        interrupt_requested: Option<&AtomicBool>,
    ) -> Result<FieldBvhNode, RunError> {
        if entries.len() >= 4096 {
            check_spectrum_interrupt(interrupt_requested)?;
        }
        if entries.len() == 1 {
            return Ok(FieldBvhNode::Leaf {
                bounds: entries[0].0,
                cell_index: entries[0].2,
            });
        }
        let mut bounds = entries[0].0;
        for entry in entries.iter().skip(1) {
            bounds = bounds.merge(entry.0);
        }
        let axis = bounds.longest_axis();
        entries.sort_by(|left, right| {
            left.1[axis]
                .partial_cmp(&right.1[axis])
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| left.2.cmp(&right.2))
        });
        if entries.len() >= 4096 {
            check_spectrum_interrupt(interrupt_requested)?;
        }
        let middle = entries.len() / 2;
        let (left, right) = entries.split_at_mut(middle);
        Ok(FieldBvhNode::Internal {
            bounds,
            left: Box::new(Self::build_recursive(left, interrupt_requested)?),
            right: Box::new(Self::build_recursive(right, interrupt_requested)?),
        })
    }

    pub(crate) fn locate(
        &self,
        position: [f64; 3],
        sample_positions: &[[f64; 3]],
        cells: &[[u32; 4]],
    ) -> Option<(usize, [f64; 4])> {
        self.root
            .as_ref()
            .and_then(|root| Self::locate_recursive(root, position, sample_positions, cells))
    }

    fn locate_recursive(
        node: &FieldBvhNode,
        position: [f64; 3],
        sample_positions: &[[f64; 3]],
        cells: &[[u32; 4]],
    ) -> Option<(usize, [f64; 4])> {
        match node {
            FieldBvhNode::Leaf { bounds, cell_index } => {
                if !bounds.contains(position) {
                    return None;
                }
                let cell = cells.get(*cell_index).copied()?;
                let vertices = [
                    sample_positions.get(cell[0] as usize).copied()?,
                    sample_positions.get(cell[1] as usize).copied()?,
                    sample_positions.get(cell[2] as usize).copied()?,
                    sample_positions.get(cell[3] as usize).copied()?,
                ];
                barycentric_tet(position, vertices).map(|weights| (*cell_index, weights))
            }
            FieldBvhNode::Internal {
                bounds,
                left,
                right,
            } => {
                if !bounds.contains(position) {
                    return None;
                }
                let left_match = Self::locate_recursive(left, position, sample_positions, cells);
                let right_match = Self::locate_recursive(right, position, sample_positions, cells);
                match (left_match, right_match) {
                    (Some(left), Some(right)) => Some(if left.0 <= right.0 { left } else { right }),
                    (Some(found), None) | (None, Some(found)) => Some(found),
                    (None, None) => None,
                }
            }
        }
    }
}

fn dot3(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn sub3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn barycentric_tet(position: [f64; 3], vertices: [[f64; 3]; 4]) -> Option<[f64; 4]> {
    let edge_1 = sub3(vertices[1], vertices[0]);
    let edge_2 = sub3(vertices[2], vertices[0]);
    let edge_3 = sub3(vertices[3], vertices[0]);
    let rhs = sub3(position, vertices[0]);
    let scale = edge_1
        .into_iter()
        .chain(edge_2)
        .chain(edge_3)
        .map(f64::abs)
        .fold(0.0_f64, f64::max);
    if !scale.is_finite() || scale <= 0.0 {
        return None;
    }
    // A dimensionless determinant keeps the degeneracy decision invariant
    // under the metre, micrometre and nanometre scales used by the same mesh.
    let edge_1 = edge_1.map(|value| value / scale);
    let edge_2 = edge_2.map(|value| value / scale);
    let edge_3 = edge_3.map(|value| value / scale);
    let rhs = rhs.map(|value| value / scale);
    let determinant = dot3(edge_1, cross3(edge_2, edge_3));
    if !determinant.is_finite() || determinant.abs() <= 1.0e-14 {
        return None;
    }
    let lambda_1 = dot3(rhs, cross3(edge_2, edge_3)) / determinant;
    let lambda_2 = dot3(edge_1, cross3(rhs, edge_3)) / determinant;
    let lambda_3 = dot3(edge_1, cross3(edge_2, rhs)) / determinant;
    let weights = [
        1.0 - lambda_1 - lambda_2 - lambda_3,
        lambda_1,
        lambda_2,
        lambda_3,
    ];
    weights
        .iter()
        .all(|weight| weight.is_finite() && *weight >= -1.0e-9 && *weight <= 1.0 + 1.0e-9)
        .then_some(weights)
}

fn sample_antenna_field_with_tetrahedra(
    request: &AntennaSpectrumRequestIR,
    samples: &AntennaFieldSolutionSamples,
    cells: &[[u32; 4]],
    count_u: usize,
    count_v: usize,
    spacing_u: f64,
    spacing_v: f64,
    tolerance_m: f64,
    interrupt_requested: Option<&AtomicBool>,
) -> Result<AntennaSpectrumSampleGrid, RunError> {
    check_spectrum_interrupt(interrupt_requested)?;
    let bvh = FieldTetraBvh::build_interruptible(
        &samples.sample_positions_xyz_m,
        cells,
        tolerance_m,
        interrupt_requested,
    )?;
    let sample_count = count_u
        .checked_mul(count_v)
        .ok_or_else(|| error("antenna source-spectrum sample count overflows"))?;
    let mut positions = Vec::with_capacity(sample_count);
    let mut field = Vec::with_capacity(sample_count);
    let mut mapping = Vec::with_capacity(sample_count * 5);
    let mut outside_count = 0;
    for v in 0..count_v {
        check_spectrum_interrupt(interrupt_requested)?;
        let coordinate_v = -0.5 * request.sampling_plane.extent_v_m + v as f64 * spacing_v;
        for u in 0..count_u {
            let coordinate_u = -0.5 * request.sampling_plane.extent_u_m + u as f64 * spacing_u;
            let position = [
                request.sampling_plane.origin_m[0]
                    + coordinate_u * request.sampling_plane.axis_u[0]
                    + coordinate_v * request.sampling_plane.axis_v[0],
                request.sampling_plane.origin_m[1]
                    + coordinate_u * request.sampling_plane.axis_u[1]
                    + coordinate_v * request.sampling_plane.axis_v[1],
                request.sampling_plane.origin_m[2]
                    + coordinate_u * request.sampling_plane.axis_u[2]
                    + coordinate_v * request.sampling_plane.axis_v[2],
            ];
            let selected = bvh.locate(position, &samples.sample_positions_xyz_m, cells);
            let value = match selected {
                Some((cell_index, weights)) => {
                    let cell = cells[cell_index];
                    mapping.push(cell_index as u64);
                    mapping.extend(weights.iter().copied().map(f64::to_bits));
                    std::array::from_fn(|component| {
                        weights
                            .iter()
                            .copied()
                            .zip(cell)
                            .map(|(weight, node)| {
                                weight
                                    * samples.magnetic_field_xyz_apm_per_a[node as usize][component]
                            })
                            .sum()
                    })
                }
                None
                    if matches!(
                        request.sampling_plane.outside_policy,
                        fullmag_ir::AntennaSpectrumOutsidePolicyIR::Zero
                    ) =>
                {
                    outside_count += 1;
                    mapping.extend([u64::MAX, 0, 0, 0, 0]);
                    [0.0; 3]
                }
                None => {
                    return Err(error(format!(
                        "antenna source-spectrum plane point ({u},{v}) lies outside the FEM tetrahedral carrier"
                    )))
                }
            };
            if value.iter().any(|component| !component.is_finite()) {
                return Err(error(format!(
                    "antenna source-spectrum P1 interpolation produced a non-finite field at plane point ({u},{v})"
                )));
            }
            positions.push(position);
            field.push(value);
        }
    }
    Ok(AntennaSpectrumSampleGrid {
        positions_xyz_m: positions,
        field_xyz_apm_per_a: field,
        outside_count,
        mapping_digest: sha256_u64(&mapping),
    })
}

/// Sample the immutable source-field carrier on the declared centred plane.
///
/// A carrier with tet4 topology uses deterministic barycentric P1
/// interpolation. A legacy point-only carrier uses bounded identity-coordinate
/// lookup. Neither realization substitutes a nearest node or broadcasts one
/// field value over a target lattice.
pub fn sample_antenna_field_on_plane(
    request: &AntennaSpectrumRequestIR,
    samples: &AntennaFieldSolutionSamples,
) -> Result<AntennaSpectrumSampleGrid, RunError> {
    sample_antenna_field_on_plane_interruptible(request, samples, None)
}

fn sample_antenna_field_on_plane_interruptible(
    request: &AntennaSpectrumRequestIR,
    samples: &AntennaFieldSolutionSamples,
    interrupt_requested: Option<&AtomicBool>,
) -> Result<AntennaSpectrumSampleGrid, RunError> {
    check_spectrum_interrupt(interrupt_requested)?;
    if request.sampling_plane.interpolation != "fem_element" {
        return Err(error(format!(
            "antenna source-spectrum interpolation '{}' is not executable for the current immutable carrier; fdm_trilinear requires explicit FDM grid metadata",
            request.sampling_plane.interpolation
        )));
    }
    if samples.sample_positions_xyz_m.is_empty()
        || samples.sample_positions_xyz_m.len() != samples.magnetic_field_xyz_apm_per_a.len()
        || samples
            .sample_positions_xyz_m
            .iter()
            .chain(&samples.magnetic_field_xyz_apm_per_a)
            .flatten()
            .any(|value| !value.is_finite())
    {
        return Err(error(
            "antenna source-spectrum carrier must contain finite, shape-matched samples",
        ));
    }
    let count_u = request.sampling_plane.sample_count_u as usize;
    let count_v = request.sampling_plane.sample_count_v as usize;
    let sample_count = count_u
        .checked_mul(count_v)
        .ok_or_else(|| error("antenna source-spectrum sample count overflows"))?;
    if count_u < 2 || count_v < 2 || sample_count > MAX_ANTENNA_SPECTRUM_SAMPLE_COUNT {
        return Err(error(
            "antenna source-spectrum lattice must have at least two samples per axis and at most 10000000 samples",
        ));
    }
    let spacing_u = request.sampling_plane.extent_u_m / (count_u - 1) as f64;
    let spacing_v = request.sampling_plane.extent_v_m / (count_v - 1) as f64;
    if !spacing_u.is_finite() || !spacing_v.is_finite() || spacing_u <= 0.0 || spacing_v <= 0.0 {
        return Err(error(
            "antenna source-spectrum plane spacing must be finite and positive",
        ));
    }
    let tolerance_m = coordinate_tolerance(request, spacing_u, spacing_v)?;
    let (source_minimum, source_maximum) = source_bounds(&samples.sample_positions_xyz_m);
    if let Some(cells) = samples.sample_tet4_cells.as_deref() {
        if cells.is_empty() {
            return Err(error(
                "antenna source-spectrum FEM interpolation carrier has no tetrahedral cells",
            ));
        }
        return sample_antenna_field_with_tetrahedra(
            request,
            samples,
            cells,
            count_u,
            count_v,
            spacing_u,
            spacing_v,
            tolerance_m,
            interrupt_requested,
        );
    }
    let mut buckets: HashMap<[i64; 3], Vec<usize>> = HashMap::new();
    let plane_minimum = std::array::from_fn(|axis| {
        request.sampling_plane.origin_m[axis]
            - 0.5
                * (request.sampling_plane.extent_u_m * request.sampling_plane.axis_u[axis].abs()
                    + request.sampling_plane.extent_v_m * request.sampling_plane.axis_v[axis].abs())
    });
    let plane_maximum = std::array::from_fn(|axis| {
        request.sampling_plane.origin_m[axis]
            + 0.5
                * (request.sampling_plane.extent_u_m * request.sampling_plane.axis_u[axis].abs()
                    + request.sampling_plane.extent_v_m * request.sampling_plane.axis_v[axis].abs())
    });
    for (index, position) in samples.sample_positions_xyz_m.iter().copied().enumerate() {
        if index % 4096 == 0 {
            check_spectrum_interrupt(interrupt_requested)?;
        }
        if !point_inside_source_bounds(position, plane_minimum, plane_maximum, tolerance_m) {
            continue;
        }
        let key = coordinate_key(position, tolerance_m).ok_or_else(|| {
            error("antenna source-spectrum source coordinates exceed the bounded matching range")
        })?;
        buckets.entry(key).or_default().push(index);
    }

    let mut positions = Vec::with_capacity(sample_count);
    let mut field = Vec::with_capacity(sample_count);
    let mut mapping = Vec::with_capacity(sample_count);
    let mut outside_count = 0;
    for v in 0..count_v {
        check_spectrum_interrupt(interrupt_requested)?;
        let coordinate_v = -0.5 * request.sampling_plane.extent_v_m + v as f64 * spacing_v;
        for u in 0..count_u {
            let coordinate_u = -0.5 * request.sampling_plane.extent_u_m + u as f64 * spacing_u;
            let position = [
                request.sampling_plane.origin_m[0]
                    + coordinate_u * request.sampling_plane.axis_u[0]
                    + coordinate_v * request.sampling_plane.axis_v[0],
                request.sampling_plane.origin_m[1]
                    + coordinate_u * request.sampling_plane.axis_u[1]
                    + coordinate_v * request.sampling_plane.axis_v[1],
                request.sampling_plane.origin_m[2]
                    + coordinate_u * request.sampling_plane.axis_u[2]
                    + coordinate_v * request.sampling_plane.axis_v[2],
            ];
            let key = coordinate_key(position, tolerance_m).ok_or_else(|| {
                error(
                    "antenna source-spectrum target coordinates exceed the bounded matching range",
                )
            })?;
            let mut matches = Vec::new();
            for du in -1_i64..=1 {
                for dv in -1_i64..=1 {
                    for dw in -1_i64..=1 {
                        let neighbour = [
                            key[0].checked_add(du),
                            key[1].checked_add(dv),
                            key[2].checked_add(dw),
                        ];
                        let Some(neighbour) = neighbour.into_iter().collect::<Option<Vec<_>>>()
                        else {
                            continue;
                        };
                        let neighbour = [neighbour[0], neighbour[1], neighbour[2]];
                        for &source_index in buckets.get(&neighbour).into_iter().flatten() {
                            if coordinate_distance_squared(
                                samples.sample_positions_xyz_m[source_index],
                                position,
                            ) <= tolerance_m * tolerance_m
                            {
                                matches.push(source_index);
                            }
                        }
                    }
                }
            }
            matches.sort_unstable();
            matches.dedup();
            let selected = match matches.as_slice() {
                [source_index] => {
                    mapping.push(*source_index as u64);
                    samples.magnetic_field_xyz_apm_per_a[*source_index]
                }
                []
                    if matches.is_empty()
                        && matches!(
                            request.sampling_plane.outside_policy,
                            fullmag_ir::AntennaSpectrumOutsidePolicyIR::Zero
                        )
                        && !point_inside_source_bounds(
                            position,
                            source_minimum,
                            source_maximum,
                            tolerance_m,
                        ) =>
                {
                    outside_count += 1;
                    mapping.push(u64::MAX);
                    [0.0; 3]
                }
                [] => {
                    return Err(error(format!(
                        "antenna source-spectrum plane point ({u},{v}) has no matching immutable field sample inside the source carrier bounds; explicit FEM interpolation is required"
                    )))
                }
                _ => {
                    return Err(error(format!(
                        "antenna source-spectrum plane point ({u},{v}) matches multiple source samples"
                    )))
                }
            };
            positions.push(position);
            field.push(selected);
        }
    }
    Ok(AntennaSpectrumSampleGrid {
        positions_xyz_m: positions,
        field_xyz_apm_per_a: field,
        outside_count,
        mapping_digest: sha256_u64(&mapping),
    })
}

/// Execute the declared source-spectrum request against one already verified
/// immutable field basis.  No field solve or LLG state is created here.
pub fn compute_antenna_source_spectrum_artifact(
    request: &AntennaSpectrumRequestIR,
    samples: &AntennaFieldSolutionSamples,
    equilibrium_samples: Option<&[[f64; 3]]>,
) -> Result<AntennaSourceSpectrumArtifact, RunError> {
    compute_antenna_source_spectrum_artifact_interruptible(
        request,
        samples,
        equilibrium_samples,
        None,
    )
}

pub fn compute_antenna_source_spectrum_artifact_interruptible(
    request: &AntennaSpectrumRequestIR,
    samples: &AntennaFieldSolutionSamples,
    equilibrium_samples: Option<&[[f64; 3]]>,
    interrupt_requested: Option<&AtomicBool>,
) -> Result<AntennaSourceSpectrumArtifact, RunError> {
    if request.component == "transverse" {
        return Err(error(
            "transverse antenna spectrum requires a verified equilibrium resource loader and projection",
        ));
    }
    if request.equilibrium_ref.is_some() || request.mode_basis_ref.is_some() {
        return Err(error(
            "antenna source-spectrum cannot publish ignored equilibrium or mode-basis references",
        ));
    }
    let sampled = sample_antenna_field_on_plane_interruptible(request, samples, interrupt_requested)?;
    let spectrum = match request.transform {
        AntennaSpectrumTransformIR::SpatialFft => compute_structured_antenna_source_spectrum_interruptible(
            request,
            &sampled.field_xyz_apm_per_a,
            equilibrium_samples,
            interrupt_requested,
        )?,
        AntennaSpectrumTransformIR::NonuniformSpatialFft => {
            compute_nonuniform_k_antenna_source_spectrum_interruptible(
                request,
                &sampled.field_xyz_apm_per_a,
                equilibrium_samples,
                interrupt_requested,
            )?
        }
    };
    check_spectrum_interrupt(interrupt_requested)?;
    let (transform, fourier_realization) = spectrum_transform_metadata(&request.transform);
    let sampling = AntennaSpectrumSamplingMetadata {
        schema_version: "antenna_spectrum_sampling.v1".into(),
        solution_id: samples.solution_id.clone(),
        source_object_id: samples.source_object_id.clone(),
        port_mode_id: samples.port_mode_id.clone(),
        target: request.target.clone(),
        origin_m: request.sampling_plane.origin_m,
        axis_u: request.sampling_plane.axis_u,
        axis_v: request.sampling_plane.axis_v,
        extent_u_m: request.sampling_plane.extent_u_m,
        extent_v_m: request.sampling_plane.extent_v_m,
        sample_count_u: request.sampling_plane.sample_count_u,
        sample_count_v: request.sampling_plane.sample_count_v,
        interpolation: request.sampling_plane.interpolation.clone(),
        transform: transform.into(),
        window: spectrum_window_name(&request.window).into(),
        fourier_realization: fourier_realization.into(),
        realization: if samples.sample_tet4_cells.is_some() {
            "fem_p1_interpolation_v1"
        } else {
            "identity_coordinates_v1"
        }
        .into(),
        outside_policy: match request.sampling_plane.outside_policy {
            fullmag_ir::AntennaSpectrumOutsidePolicyIR::Error => "error",
            fullmag_ir::AntennaSpectrumOutsidePolicyIR::Zero => "zero",
        }
        .into(),
        outside_count: sampled.outside_count,
        source_sample_count: samples.sample_positions_xyz_m.len(),
        mapping_digest: sampled.mapping_digest,
        fourier_origin_uv_m: [
            -0.5 * request.sampling_plane.extent_u_m,
            -0.5 * request.sampling_plane.extent_v_m,
        ],
        fourier_phase_convention: "centered_plane_origin_phase_corrected.v1".into(),
    };
    let mut artifact = AntennaSourceSpectrumArtifact {
        schema_version: "antenna_source_spectrum_artifact.v2".into(),
        request_id: request.id.clone(),
        output_id: request.output_id.clone(),
        solution_id: samples.solution_id.clone(),
        source_object_id: samples.source_object_id.clone(),
        port_mode_id: samples.port_mode_id.clone(),
        solution_content_digest: samples.content_digest.clone(),
        content_digest: String::new(),
        sampling,
        spectrum,
    };
    let (manifest, _) = build_source_spectrum_manifest(&artifact, String::new())?;
    let mut canonical = serde_json::to_value(&manifest).map_err(|serialization_error| {
        error(format!(
            "serialize antenna source-spectrum artifact: {serialization_error}"
        ))
    })?;
    canonical
        .as_object_mut()
        .expect("antenna source-spectrum artifact is an object")
        .remove("content_digest");
    artifact.content_digest = sha256_bytes(&serde_json::to_vec(&canonical).map_err(
        |serialization_error| {
            error(format!(
                "canonicalize antenna source-spectrum artifact: {serialization_error}"
            ))
        },
    )?);
    Ok(artifact)
}

fn build_source_spectrum_manifest(
    artifact: &AntennaSourceSpectrumArtifact,
    content_digest: String,
) -> Result<(AntennaSourceSpectrumManifest, Vec<AuxiliaryArtifact>), RunError> {
    let valid_component = |value: &str| {
        !value.is_empty()
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
    };
    if !valid_component(&artifact.output_id) {
        return Err(error(format!(
            "antenna source-spectrum output_id '{}' is not a safe artifact component",
            artifact.output_id
        )));
    }
    let spectrum = &artifact.spectrum;
    if spectrum
        .k_u_rad_per_m
        .iter()
        .chain(&spectrum.k_v_rad_per_m)
        .chain(
            spectrum
                .amplitudes_re_im
                .iter()
                .flat_map(|value| value.iter()),
        )
        .chain(&spectrum.power)
        .any(|value| !value.is_finite())
    {
        return Err(error(
            "antenna source-spectrum payload contains a non-finite value",
        ));
    }
    let base = format!("antenna/source_spectra/{}", artifact.output_id);
    let k_u_bytes = encode_f64_le(spectrum.k_u_rad_per_m.iter().copied());
    let k_v_bytes = encode_f64_le(spectrum.k_v_rad_per_m.iter().copied());
    let amplitudes_bytes = encode_complex_f64_le(&spectrum.amplitudes_re_im);
    let power_bytes = encode_f64_le(spectrum.power.iter().copied());
    let payload_ref = |name: &str, bytes: &[u8], layout: &str, unit: &str, value_count: usize| {
        AntennaSpectrumPayloadRef {
            path: format!("{base}/{name}.f64le"),
            sha256: sha256_bytes(bytes),
            scalar_type: "float64_le".into(),
            layout: layout.into(),
            unit: unit.into(),
            value_count,
        }
    };
    let payloads = AntennaSpectrumPayloads {
        k_u_rad_per_m: payload_ref(
            "k_u_rad_per_m",
            &k_u_bytes,
            "axis_u_1d",
            &spectrum.wave_vector_unit,
            spectrum.k_u_rad_per_m.len(),
        ),
        k_v_rad_per_m: payload_ref(
            "k_v_rad_per_m",
            &k_v_bytes,
            "axis_v_1d",
            &spectrum.wave_vector_unit,
            spectrum.k_v_rad_per_m.len(),
        ),
        amplitudes_re_im: payload_ref(
            "amplitudes_re_im",
            &amplitudes_bytes,
            "component_kv_ku_complex_re_im",
            &spectrum.amplitude_unit,
            spectrum.amplitudes_re_im.len() * 2,
        ),
        power: payload_ref(
            "power",
            &power_bytes,
            "kv_ku_power",
            &format!("({})^2", spectrum.amplitude_unit),
            spectrum.power.len(),
        ),
    };
    let summary = AntennaSourceSpectrumSummary {
        schema_version: spectrum.schema_version.clone(),
        request_id: spectrum.request_id.clone(),
        output_id: spectrum.output_id.clone(),
        component: spectrum.component.clone(),
        component_labels: spectrum.component_labels.clone(),
        k_u_count: spectrum.k_u_rad_per_m.len(),
        k_v_count: spectrum.k_v_rad_per_m.len(),
        amplitude_count: spectrum.amplitudes_re_im.len(),
        power_count: spectrum.power.len(),
        coherent_gain: spectrum.coherent_gain,
        equivalent_noise_bandwidth_bins: spectrum.equivalent_noise_bandwidth_bins,
        normalization: spectrum.normalization.clone(),
        amplitude_unit: spectrum.amplitude_unit.clone(),
        wave_vector_unit: spectrum.wave_vector_unit.clone(),
    };
    let manifest = AntennaSourceSpectrumManifest {
        schema_version: "antenna_source_spectrum_artifact.v2".into(),
        request_id: artifact.request_id.clone(),
        output_id: artifact.output_id.clone(),
        solution_id: artifact.solution_id.clone(),
        source_object_id: artifact.source_object_id.clone(),
        port_mode_id: artifact.port_mode_id.clone(),
        solution_content_digest: artifact.solution_content_digest.clone(),
        content_digest,
        sampling: artifact.sampling.clone(),
        spectrum: summary,
        payloads,
    };
    let binaries = vec![
        AuxiliaryArtifact {
            relative_path: manifest.payloads.k_u_rad_per_m.path.clone(),
            bytes: k_u_bytes,
        },
        AuxiliaryArtifact {
            relative_path: manifest.payloads.k_v_rad_per_m.path.clone(),
            bytes: k_v_bytes,
        },
        AuxiliaryArtifact {
            relative_path: manifest.payloads.amplitudes_re_im.path.clone(),
            bytes: amplitudes_bytes,
        },
        AuxiliaryArtifact {
            relative_path: manifest.payloads.power.path.clone(),
            bytes: power_bytes,
        },
    ];
    Ok((manifest, binaries))
}

/// Convert a source-spectrum result into all session artifacts. Binary
/// payloads are emitted before the JSON manifest, so a visible manifest always
/// has complete referenced data behind it.
pub fn antenna_source_spectrum_auxiliary_artifacts(
    artifact: &AntennaSourceSpectrumArtifact,
) -> Result<Vec<AuxiliaryArtifact>, RunError> {
    let (manifest, mut artifacts) =
        build_source_spectrum_manifest(artifact, artifact.content_digest.clone())?;
    let bytes = serde_json::to_vec_pretty(&manifest).map_err(|serialization_error| {
        error(format!(
            "serialize antenna source-spectrum manifest: {serialization_error}"
        ))
    })?;
    artifacts.push(AuxiliaryArtifact {
        relative_path: format!(
            "antenna/source_spectra/{}/spectrum.v2.json",
            artifact.output_id
        ),
        bytes,
    });
    Ok(artifacts)
}

/// Parse spectrum JSON without last-key-wins ambiguity, including legacy v1.
/// Digest and scientific semantics must still be verified by the caller.
pub fn parse_antenna_source_spectrum_manifest_json(bytes: &[u8]) -> Result<serde_json::Value, RunError> {
    serde_json::from_slice::<crate::artifact_json::UnambiguousJson>(bytes)
        .map(|value| value.0)
        .map_err(|cause| error(format!("parse antenna source-spectrum manifest: {cause}")))
}

pub fn verify_antenna_source_spectrum_auxiliary_artifacts(
    artifacts: &[AuxiliaryArtifact],
) -> Result<(), RunError> {
    let manifests = artifacts
        .iter()
        .filter(|artifact| artifact.relative_path.ends_with("/spectrum.v2.json"))
        .collect::<Vec<_>>();
    if manifests.len() != 1 || artifacts.len() != 5 {
        return Err(error("antenna source-spectrum requires one manifest and four payloads"));
    }
    let mut canonical = parse_antenna_source_spectrum_manifest_json(&manifests[0].bytes)?;
    let published_digest = canonical
        .as_object_mut()
        .and_then(|object| object.remove("content_digest"))
        .and_then(|value| value.as_str().map(str::to_owned))
        .ok_or_else(|| error("antenna source-spectrum manifest has no content_digest"))?;
    let canonical_bytes = serde_json::to_vec(&canonical)
        .map_err(|cause| error(format!("canonicalize antenna source-spectrum manifest: {cause}")))?;
    if sha256_bytes(&canonical_bytes) != published_digest {
        return Err(error("antenna source-spectrum manifest content_digest mismatch"));
    }
    canonical["content_digest"] = serde_json::Value::String(published_digest);
    let manifest: AntennaSourceSpectrumManifest = serde_json::from_value(canonical)
        .map_err(|cause| error(format!("validate antenna source-spectrum manifest: {cause}")))?;
    if manifest.schema_version != "antenna_source_spectrum_artifact.v2"
        || manifests[0].relative_path
            != format!("antenna/source_spectra/{}/spectrum.v2.json", manifest.output_id)
    {
        return Err(error("antenna source-spectrum manifest identity mismatch"));
    }
    validate_antenna_source_spectrum_manifest_semantics(&manifest)?;
    let references = [
        &manifest.payloads.k_u_rad_per_m,
        &manifest.payloads.k_v_rad_per_m,
        &manifest.payloads.amplitudes_re_im,
        &manifest.payloads.power,
    ];
    let mut paths = std::collections::BTreeSet::new();
    for reference in references {
        if !paths.insert(reference.path.as_str()) || reference.scalar_type != "float64_le" {
            return Err(error("antenna source-spectrum payload identity is invalid"));
        }
        let payloads = artifacts
            .iter()
            .filter(|artifact| artifact.relative_path == reference.path)
            .collect::<Vec<_>>();
        let expected_len = reference.value_count.checked_mul(8)
            .ok_or_else(|| error("antenna source-spectrum payload byte count overflows"))?;
        if payloads.len() != 1
            || payloads[0].bytes.len() != expected_len
            || sha256_bytes(&payloads[0].bytes) != reference.sha256
        {
            return Err(error(format!(
                "antenna source-spectrum payload '{}' length or sha256 mismatch",
                reference.path
            )));
        }
    }
    Ok(())
}

/// Validate the thin v2 manifest independently of its binary payload bytes.
/// Used at both publication and API read boundaries; payload hashes are
/// checked separately by those callers.
pub fn validate_antenna_source_spectrum_manifest_semantics(
    manifest: &AntennaSourceSpectrumManifest,
) -> Result<(), RunError> {
    let spectrum = &manifest.spectrum;
    let component_labels = match spectrum.component.as_str() {
        "vector_power" => vec!["x", "y", "z"],
        "x" | "y" | "z" | "u" | "v" | "normal" => vec![spectrum.component.as_str()],
        _ => return Err(error("antenna source-spectrum manifest component is unsupported")),
    };
    let amplitude_unit = match spectrum.normalization.as_str() {
        "integral_si" => "A*m/A",
        "unitary_discrete" => "A/m/A",
        _ => return Err(error("antenna source-spectrum manifest normalization is unsupported")),
    };
    let bin_count = spectrum.k_u_count.checked_mul(spectrum.k_v_count)
        .ok_or_else(|| error("antenna source-spectrum grid size overflows"))?;
    let amplitude_count = bin_count.checked_mul(component_labels.len())
        .ok_or_else(|| error("antenna source-spectrum amplitude count overflows"))?;
    let complex_scalar_count = amplitude_count.checked_mul(2)
        .ok_or_else(|| error("antenna source-spectrum complex scalar count overflows"))?;
    let window = match manifest.sampling.window.as_str() {
        "rectangular" => AntennaSpectrumWindowIR::Rectangular,
        "hann" => AntennaSpectrumWindowIR::Hann,
        "hamming" => AntennaSpectrumWindowIR::Hamming,
        "blackman" => AntennaSpectrumWindowIR::Blackman,
        _ => return Err(error("antenna source-spectrum manifest window is unsupported")),
    };
    let sampling = &manifest.sampling;
    let expected_realization = match sampling.transform.as_str() {
        "spatial_fft" => "structured_fft_rustfft_centered_v1",
        "nonuniform_spatial_fft" => "direct_nonuniform_dft_centered_v1",
        _ => return Err(error("antenna source-spectrum manifest transform is unsupported")),
    };
    let sampling_count = (sampling.sample_count_u as usize)
        .checked_mul(sampling.sample_count_v as usize)
        .ok_or_else(|| error("antenna source-spectrum sampling count overflows"))?;
    let finite_frame = sampling.origin_m.iter().chain(&sampling.axis_u)
        .chain(&sampling.axis_v).all(|value| value.is_finite());
    let norm_u = sampling.axis_u.iter().map(|value| value * value).sum::<f64>();
    let norm_v = sampling.axis_v.iter().map(|value| value * value).sum::<f64>();
    let dot_uv = sampling.axis_u.iter().zip(&sampling.axis_v)
        .map(|(u, v)| u * v).sum::<f64>();
    if sampling.schema_version != "antenna_spectrum_sampling.v1"
        || sampling.solution_id != manifest.solution_id
        || sampling.source_object_id != manifest.source_object_id
        || sampling.port_mode_id != manifest.port_mode_id
        || sampling.fourier_realization != expected_realization
        || sampling.fourier_phase_convention != "centered_plane_origin_phase_corrected.v1"
        || sampling.interpolation != "fem_element"
        || !sampling.extent_u_m.is_finite()
        || !sampling.extent_v_m.is_finite()
        || sampling.extent_u_m <= 0.0
        || sampling.extent_v_m <= 0.0
        || !finite_frame
        || (norm_u - 1.0).abs() > 1.0e-12
        || (norm_v - 1.0).abs() > 1.0e-12
        || dot_uv.abs() > 1.0e-12
        || sampling.source_sample_count == 0
        || sampling.mapping_digest.is_empty()
        || sampling.fourier_origin_uv_m != [-0.5 * sampling.extent_u_m, -0.5 * sampling.extent_v_m]
        || !matches!(sampling.realization.as_str(), "fem_p1_interpolation_v1" | "identity_coordinates_v1")
        || !matches!(sampling.outside_policy.as_str(), "error" | "zero")
        || sampling.outside_count > sampling_count
    {
        return Err(error("antenna source-spectrum sampling provenance is incompatible"));
    }
    let (coherent_gain, equivalent_noise_bandwidth_bins) = analytic_window_metrics(
        &window,
        manifest.sampling.sample_count_u as usize,
        manifest.sampling.sample_count_v as usize,
    )?;
    let base = format!("antenna/source_spectra/{}", manifest.output_id);
    if manifest.schema_version != "antenna_source_spectrum_artifact.v2"
        || spectrum.schema_version != "antenna_source_spectrum.v1"
        || spectrum.k_u_count == 0
        || spectrum.k_v_count == 0
        || (sampling.transform == "spatial_fft"
            && (spectrum.k_u_count != sampling.sample_count_u as usize
                || spectrum.k_v_count != sampling.sample_count_v as usize))
        || spectrum.request_id != manifest.request_id
        || spectrum.output_id != manifest.output_id
        || spectrum.component_labels != component_labels
        || spectrum.amplitude_count != amplitude_count
        || spectrum.power_count != bin_count
        || spectrum.amplitude_unit != amplitude_unit
        || spectrum.wave_vector_unit != "rad/m"
        || !window_metric_matches(spectrum.coherent_gain, coherent_gain)
        || !window_metric_matches(spectrum.equivalent_noise_bandwidth_bins, equivalent_noise_bandwidth_bins)
        || manifest.payloads.k_u_rad_per_m.value_count != spectrum.k_u_count
        || manifest.payloads.k_v_rad_per_m.value_count != spectrum.k_v_count
        || manifest.payloads.amplitudes_re_im.value_count != complex_scalar_count
        || manifest.payloads.power.value_count != bin_count
        || manifest.payloads.k_u_rad_per_m.path != format!("{base}/k_u_rad_per_m.f64le")
        || manifest.payloads.k_v_rad_per_m.path != format!("{base}/k_v_rad_per_m.f64le")
        || manifest.payloads.amplitudes_re_im.path != format!("{base}/amplitudes_re_im.f64le")
        || manifest.payloads.power.path != format!("{base}/power.f64le")
        || manifest.payloads.k_u_rad_per_m.layout != "axis_u_1d"
        || manifest.payloads.k_v_rad_per_m.layout != "axis_v_1d"
        || manifest.payloads.amplitudes_re_im.layout != "component_kv_ku_complex_re_im"
        || manifest.payloads.power.layout != "kv_ku_power"
        || manifest.payloads.k_u_rad_per_m.unit != "rad/m"
        || manifest.payloads.k_v_rad_per_m.unit != "rad/m"
        || manifest.payloads.amplitudes_re_im.unit != amplitude_unit
        || manifest.payloads.power.unit != format!("({amplitude_unit})^2")
    {
        return Err(error("antenna source-spectrum manifest shape or unit is incompatible"));
    }
    Ok(())
}

pub fn reusable_antenna_source_spectrum_output(
    output_dir: &Path,
    request: &AntennaSpectrumRequestIR,
    solution_id: &str,
    source_object_id: &str,
    port_mode_id: &str,
    solution_content_digest: &str,
    interrupt_requested: Option<&AtomicBool>,
) -> Result<bool, RunError> {
    check_spectrum_interrupt(interrupt_requested)?;
    if !output_dir.exists() {
        return Ok(false);
    }
    if !output_dir.is_dir() {
        return Err(error("antenna source-spectrum output exists as a non-directory"));
    }
    let manifest_bytes = std::fs::read(output_dir.join("spectrum.v2.json"))
        .map_err(|cause| error(format!("read cached antenna spectrum manifest: {cause}")))?;
    let mut canonical = parse_antenna_source_spectrum_manifest_json(&manifest_bytes)?;
    let published_digest = canonical
        .as_object_mut()
        .and_then(|object| object.remove("content_digest"))
        .and_then(|value| value.as_str().map(str::to_owned))
        .ok_or_else(|| error("cached antenna spectrum manifest has no content_digest"))?;
    let canonical_bytes = serde_json::to_vec(&canonical)
        .map_err(|cause| error(format!("canonicalize cached antenna spectrum manifest: {cause}")))?;
    if published_digest != sha256_bytes(&canonical_bytes) {
        return Err(error("cached antenna spectrum manifest content_digest mismatch"));
    }
    canonical["content_digest"] = serde_json::Value::String(published_digest);
    let manifest: AntennaSourceSpectrumManifest = serde_json::from_value(canonical)
        .map_err(|cause| error(format!("validate cached antenna spectrum manifest: {cause}")))?;
    let (transform, realization) = spectrum_transform_metadata(&request.transform);
    let normalization = match request.normalization {
        AntennaSpectrumNormalizationIR::IntegralSi => "integral_si",
        AntennaSpectrumNormalizationIR::UnitaryDiscrete => "unitary_discrete",
    };
    let outside_policy = match request.sampling_plane.outside_policy {
        fullmag_ir::AntennaSpectrumOutsidePolicyIR::Error => "error",
        fullmag_ir::AntennaSpectrumOutsidePolicyIR::Zero => "zero",
    };
    let sampling = &manifest.sampling;
    if request.component == "transverse"
        || request.equilibrium_ref.is_some()
        || request.mode_basis_ref.is_some()
        || manifest.schema_version != "antenna_source_spectrum_artifact.v2"
        || manifest.request_id != request.id
        || manifest.output_id != request.output_id
        || manifest.solution_id != solution_id
        || manifest.source_object_id != source_object_id
        || manifest.port_mode_id != port_mode_id
        || manifest.solution_content_digest != solution_content_digest
        || sampling.target != request.target
        || sampling.origin_m != request.sampling_plane.origin_m
        || sampling.axis_u != request.sampling_plane.axis_u
        || sampling.axis_v != request.sampling_plane.axis_v
        || sampling.extent_u_m != request.sampling_plane.extent_u_m
        || sampling.extent_v_m != request.sampling_plane.extent_v_m
        || sampling.sample_count_u != request.sampling_plane.sample_count_u
        || sampling.sample_count_v != request.sampling_plane.sample_count_v
        || sampling.interpolation != request.sampling_plane.interpolation
        || sampling.outside_policy != outside_policy
        || sampling.transform != transform
        || sampling.window != spectrum_window_name(&request.window)
        || sampling.fourier_realization != realization
        || sampling.fourier_phase_convention != "centered_plane_origin_phase_corrected.v1"
        || sampling.fourier_origin_uv_m != [
            -0.5 * request.sampling_plane.extent_u_m,
            -0.5 * request.sampling_plane.extent_v_m,
        ]
        || manifest.spectrum.component != request.component
        || manifest.spectrum.normalization != normalization
        || manifest.spectrum.schema_version != "antenna_source_spectrum.v1"
        || sampling.schema_version != "antenna_spectrum_sampling.v1"
        || !matches!(sampling.realization.as_str(), "fem_p1_interpolation_v1" | "identity_coordinates_v1")
    {
        return Err(error("cached antenna spectrum output has different analysis inputs"));
    }
    let expected_samples = (request.sampling_plane.sample_count_u as usize)
        .checked_mul(request.sampling_plane.sample_count_v as usize)
        .ok_or_else(|| error("cached antenna spectrum sample count overflows"))?;
    let lattice = validated_uniform_plane_lattice(request, expected_samples)?;
    let (coherent_gain, equivalent_noise_bandwidth_bins) =
        analytic_window_metrics(&request.window, lattice.count_u, lattice.count_v)?;
    if !window_metric_matches(manifest.spectrum.coherent_gain, coherent_gain)
        || !window_metric_matches(
            manifest.spectrum.equivalent_noise_bandwidth_bins,
            equivalent_noise_bandwidth_bins,
        )
    {
        return Err(error("cached antenna spectrum window metrics are incompatible"));
    }
    let (k_u, k_v) = match request.transform {
        AntennaSpectrumTransformIR::SpatialFft => {
            (
                fft_frequencies(lattice.count_u, lattice.spacing_u),
                fft_frequencies(lattice.count_v, lattice.spacing_v),
            )
        }
        AntennaSpectrumTransformIR::NonuniformSpatialFft => {
            let (grid, _) = validated_nonuniform_k_grid(request)?;
            (grid.k_u_rad_per_m.clone(), grid.k_v_rad_per_m.clone())
        }
    };
    if manifest.payloads.k_u_rad_per_m.sha256 != sha256_bytes(&encode_f64_le(k_u.iter().copied()))
        || manifest.payloads.k_v_rad_per_m.sha256 != sha256_bytes(&encode_f64_le(k_v.iter().copied()))
        || manifest.spectrum.k_u_count != k_u.len()
        || manifest.spectrum.k_v_count != k_v.len()
    {
        return Err(error("cached antenna spectrum output has a different wave-vector grid"));
    }
    let sample_count = k_u.len().checked_mul(k_v.len())
        .ok_or_else(|| error("cached antenna spectrum grid size overflows"))?;
    let component_labels = match request.component.as_str() {
        "vector_power" => vec!["x", "y", "z"],
        "x" | "y" | "z" | "u" | "v" | "normal" => vec![request.component.as_str()],
        _ => return Err(error("cached antenna spectrum component is unsupported")),
    };
    let amplitude_count = sample_count.checked_mul(component_labels.len())
        .ok_or_else(|| error("cached antenna spectrum amplitude count overflows"))?;
    let amplitude_scalar_count = amplitude_count.checked_mul(2)
        .ok_or_else(|| error("cached antenna spectrum complex scalar count overflows"))?;
    let amplitude_unit = match request.normalization {
        AntennaSpectrumNormalizationIR::IntegralSi => "A*m/A",
        AntennaSpectrumNormalizationIR::UnitaryDiscrete => "A/m/A",
    };
    if manifest.spectrum.power_count != sample_count
        || manifest.spectrum.amplitude_count != amplitude_count
        || manifest.spectrum.component_labels != component_labels
        || manifest.spectrum.amplitude_unit != amplitude_unit
        || manifest.spectrum.wave_vector_unit != "rad/m"
        || manifest.payloads.k_u_rad_per_m.layout != "axis_u_1d"
        || manifest.payloads.k_v_rad_per_m.layout != "axis_v_1d"
        || manifest.payloads.amplitudes_re_im.layout != "component_kv_ku_complex_re_im"
        || manifest.payloads.power.layout != "kv_ku_power"
        || manifest.payloads.k_u_rad_per_m.unit != "rad/m"
        || manifest.payloads.k_v_rad_per_m.unit != "rad/m"
        || manifest.payloads.amplitudes_re_im.unit != amplitude_unit
        || manifest.payloads.power.unit != format!("({amplitude_unit})^2")
        || manifest.payloads.k_u_rad_per_m.value_count != k_u.len()
        || manifest.payloads.k_v_rad_per_m.value_count != k_v.len()
        || manifest.payloads.amplitudes_re_im.value_count != amplitude_scalar_count
        || manifest.payloads.power.value_count != sample_count
    {
        return Err(error("cached antenna spectrum payload shape or unit is incompatible"));
    }
    let base = format!("antenna/source_spectra/{}", request.output_id);
    let references = [
        (&manifest.payloads.k_u_rad_per_m, "k_u_rad_per_m.f64le"),
        (&manifest.payloads.k_v_rad_per_m, "k_v_rad_per_m.f64le"),
        (&manifest.payloads.amplitudes_re_im, "amplitudes_re_im.f64le"),
        (&manifest.payloads.power, "power.f64le"),
    ];
    let expected_files = [
        "spectrum.v2.json",
        "k_u_rad_per_m.f64le",
        "k_v_rad_per_m.f64le",
        "amplitudes_re_im.f64le",
        "power.f64le",
    ].into_iter().map(str::to_owned).collect::<std::collections::BTreeSet<_>>();
    let actual_files = std::fs::read_dir(output_dir)
        .map_err(|cause| error(format!("list cached antenna spectrum output: {cause}")))?
        .map(|entry| {
            let entry = entry.map_err(|cause| error(format!("list cached antenna spectrum file: {cause}")))?;
            if !entry.file_type().map_err(|cause| error(format!("inspect cached antenna spectrum file: {cause}")))?.is_file() {
                return Err(error("cached antenna spectrum output contains a non-file entry"));
            }
            entry.file_name().into_string().map_err(|_| error("cached antenna spectrum file name is not UTF-8"))
        })
        .collect::<Result<std::collections::BTreeSet<_>, _>>()?;
    if actual_files != expected_files {
        return Err(error("cached antenna spectrum output has a different file set"));
    }
    let mut buffer = [0_u8; 64 * 1024];
    for (reference, filename) in references {
        check_spectrum_interrupt(interrupt_requested)?;
        if reference.path != format!("{base}/{filename}") || reference.scalar_type != "float64_le" {
            return Err(error("cached antenna spectrum payload identity mismatch"));
        }
        let mut file = std::fs::File::open(output_dir.join(filename))
            .map_err(|cause| error(format!("open cached antenna spectrum payload: {cause}")))?;
        let mut digest = Sha256::new();
        let mut byte_count = 0_usize;
        loop {
            check_spectrum_interrupt(interrupt_requested)?;
            let count = file.read(&mut buffer)
                .map_err(|cause| error(format!("read cached antenna spectrum payload: {cause}")))?;
            if count == 0 { break; }
            byte_count = byte_count.checked_add(count)
                .ok_or_else(|| error("cached antenna spectrum payload byte count overflows"))?;
            digest.update(&buffer[..count]);
        }
        if Some(byte_count) != reference.value_count.checked_mul(8)
            || format!("sha256:{:x}", digest.finalize()) != reference.sha256
        {
            return Err(error(format!("cached antenna spectrum payload '{filename}' length or sha256 mismatch")));
        }
    }
    check_spectrum_interrupt(interrupt_requested)?;
    Ok(true)
}

/// Convert a source-spectrum result into its JSON manifest only. Kept as a
/// compatibility helper for callers that publish auxiliary artifacts one at a
/// time; new workflows should use [`antenna_source_spectrum_auxiliary_artifacts`].
pub fn antenna_source_spectrum_auxiliary_artifact(
    artifact: &AntennaSourceSpectrumArtifact,
) -> Result<AuxiliaryArtifact, RunError> {
    antenna_source_spectrum_auxiliary_artifacts(artifact)?
        .into_iter()
        .find(|entry| entry.relative_path.ends_with("/spectrum.v2.json"))
        .ok_or_else(|| error("source-spectrum manifest was not generated"))
}

fn window_values(kind: &AntennaSpectrumWindowIR, count: usize) -> Vec<f64> {
    if count == 1 {
        return vec![1.0];
    }
    let denominator = (count - 1) as f64;
    (0..count)
        .map(|index| {
            let phase = 2.0 * std::f64::consts::PI * index as f64 / denominator;
            match kind {
                AntennaSpectrumWindowIR::Rectangular => 1.0,
                AntennaSpectrumWindowIR::Hann => 0.5 - 0.5 * phase.cos(),
                AntennaSpectrumWindowIR::Hamming => 0.54 - 0.46 * phase.cos(),
                AntennaSpectrumWindowIR::Blackman => {
                    0.42 - 0.5 * phase.cos() + 0.08 * (2.0 * phase).cos()
                }
            }
        })
        .collect()
}

fn analytic_window_metrics(
    window: &AntennaSpectrumWindowIR,
    count_u: usize,
    count_v: usize,
) -> Result<(f64, f64), RunError> {
    let sample_count = count_u.checked_mul(count_v)
        .ok_or_else(|| error("antenna spectrum window sample count overflows"))?;
    if count_u < 2 || count_v < 2 || sample_count > MAX_ANTENNA_SPECTRUM_SAMPLE_COUNT {
        return Err(error("antenna spectrum window grid size is unsupported"));
    }
    let (a0, a1, a2) = match window {
        AntennaSpectrumWindowIR::Rectangular => (1.0, 0.0, 0.0),
        AntennaSpectrumWindowIR::Hann => (0.5, -0.5, 0.0),
        AntennaSpectrumWindowIR::Hamming => (0.54, -0.46, 0.0),
        AntennaSpectrumWindowIR::Blackman => (0.42, -0.5, 0.08),
    };
    let axis_sums = |count: usize| {
        let harmonic_sum = |harmonic: usize| {
            if harmonic % (count - 1) == 0 { count as f64 } else { 1.0 }
        };
        let sum = a0 * count as f64 + a1 * harmonic_sum(1) + a2 * harmonic_sum(2);
        let square = (a0 * a0 + 0.5 * (a1 * a1 + a2 * a2)) * count as f64
            + (2.0 * a0 * a1 + a1 * a2) * harmonic_sum(1)
            + (2.0 * a0 * a2 + 0.5 * a1 * a1) * harmonic_sum(2)
            + a1 * a2 * harmonic_sum(3)
            + 0.5 * a2 * a2 * harmonic_sum(4);
        (sum, square)
    };
    let (sum_u, square_u) = axis_sums(count_u);
    let (sum_v, square_v) = axis_sums(count_v);
    let sum = sum_u * sum_v;
    if !sum.is_finite() || sum.abs() <= f64::EPSILON {
        return Err(error("antenna spectrum window has zero coherent gain"));
    }
    let coherent_gain = sum / sample_count as f64;
    let equivalent_noise_bandwidth_bins =
        sample_count as f64 * square_u * square_v / (sum * sum);
    if !equivalent_noise_bandwidth_bins.is_finite() {
        return Err(error("antenna spectrum window has non-finite noise bandwidth"));
    }
    Ok((coherent_gain, equivalent_noise_bandwidth_bins))
}

fn window_metric_matches(actual: f64, expected: f64) -> bool {
    actual.is_finite() && (actual - expected).abs() <= 1.0e-10 * expected.abs().max(1.0)
}

fn spectrum_window_metrics(
    window: &AntennaSpectrumWindowIR,
    count_u: usize,
    count_v: usize,
) -> Result<(Vec<f64>, Vec<f64>, f64, f64), RunError> {
    let sample_count = count_u.checked_mul(count_v)
        .ok_or_else(|| error("antenna spectrum window sample count overflows"))?;
    if count_u < 2 || count_v < 2 || sample_count > MAX_ANTENNA_SPECTRUM_SAMPLE_COUNT {
        return Err(error("antenna spectrum window grid size is unsupported"));
    }
    let window_u = window_values(window, count_u);
    let window_v = window_values(window, count_v);
    let window_sum = window_u.iter().sum::<f64>() * window_v.iter().sum::<f64>();
    let window_square_sum = window_u.iter().map(|value| value * value).sum::<f64>()
        * window_v.iter().map(|value| value * value).sum::<f64>();
    if !window_sum.is_finite() || window_sum.abs() <= f64::EPSILON {
        return Err(error("antenna spectrum window has zero coherent gain"));
    }
    let coherent_gain = window_sum / sample_count as f64;
    let equivalent_noise_bandwidth_bins =
        sample_count as f64 * window_square_sum / (window_sum * window_sum);
    if !equivalent_noise_bandwidth_bins.is_finite() {
        return Err(error("antenna spectrum window has non-finite noise bandwidth"));
    }
    Ok((window_u, window_v, coherent_gain, equivalent_noise_bandwidth_bins))
}

fn fft_frequencies(count: usize, spacing_m: f64) -> Vec<f64> {
    let scale = 2.0 * std::f64::consts::PI / (count as f64 * spacing_m);
    (0..count)
        .map(|index| {
            let signed = if index <= (count - 1) / 2 {
                index as isize
            } else {
                index as isize - count as isize
            };
            signed as f64 * scale
        })
        .collect()
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn selected_components(
    request: &AntennaSpectrumRequestIR,
    field: &[[f64; 3]],
    equilibrium: Option<&[[f64; 3]]>,
) -> Result<(Vec<String>, Vec<Vec<f64>>), RunError> {
    let axis_u = request.sampling_plane.axis_u;
    let axis_v = request.sampling_plane.axis_v;
    let axis_n = cross(axis_u, axis_v);
    let scalar = |axis: [f64; 3]| field.iter().map(|value| dot(*value, axis)).collect();
    match request.component.as_str() {
        "x" => Ok((vec!["x".into()], vec![field.iter().map(|v| v[0]).collect()])),
        "y" => Ok((vec!["y".into()], vec![field.iter().map(|v| v[1]).collect()])),
        "z" => Ok((vec!["z".into()], vec![field.iter().map(|v| v[2]).collect()])),
        "u" => Ok((vec!["u".into()], vec![scalar(axis_u)])),
        "v" => Ok((vec!["v".into()], vec![scalar(axis_v)])),
        "normal" => Ok((vec!["normal".into()], vec![scalar(axis_n)])),
        "vector_power" => Ok((
            vec!["x".into(), "y".into(), "z".into()],
            (0..3)
                .map(|component| field.iter().map(|value| value[component]).collect())
                .collect(),
        )),
        "transverse" => {
            let equilibrium = equilibrium
                .ok_or_else(|| error("transverse antenna spectrum requires equilibrium samples"))?;
            if equilibrium.len() != field.len() {
                return Err(error(
                    "transverse antenna spectrum equilibrium sample count mismatch",
                ));
            }
            let mut components = vec![Vec::with_capacity(field.len()); 3];
            for (value, m0) in field.iter().zip(equilibrium) {
                let norm2 = dot(*m0, *m0);
                if !norm2.is_finite() || (norm2 - 1.0).abs() > 1.0e-8 {
                    return Err(error(
                        "transverse antenna spectrum equilibrium vectors must be unit length",
                    ));
                }
                let parallel = dot(*value, *m0);
                for component in 0..3 {
                    components[component].push(value[component] - parallel * m0[component]);
                }
            }
            Ok((vec!["x".into(), "y".into(), "z".into()], components))
        }
        component => Err(error(format!(
            "unsupported antenna spectrum component '{component}'"
        ))),
    }
}

fn fft2_in_place(
    values: &mut [Complex64],
    count_u: usize,
    count_v: usize,
    interrupt_requested: Option<&AtomicBool>,
) -> Result<(), RunError> {
    let mut planner = FftPlanner::<f64>::new();
    let fft_u = planner.plan_fft_forward(count_u);
    for row in values.chunks_exact_mut(count_u) {
        check_spectrum_interrupt(interrupt_requested)?;
        fft_u.process(row);
    }
    let fft_v = planner.plan_fft_forward(count_v);
    let mut column = vec![Complex64::new(0.0, 0.0); count_v];
    for u in 0..count_u {
        check_spectrum_interrupt(interrupt_requested)?;
        for v in 0..count_v {
            column[v] = values[v * count_u + u];
        }
        fft_v.process(&mut column);
        for v in 0..count_v {
            values[v * count_u + u] = column[v];
        }
    }
    Ok(())
}

fn centered_origin_phase(k_u: f64, k_v: f64, extent_u_m: f64, extent_v_m: f64) -> Complex64 {
    Complex64::from_polar(1.0, 0.5 * (k_u * extent_u_m + k_v * extent_v_m))
}

#[derive(Debug, Clone, Copy)]
struct ValidatedAntennaSpectrumLattice {
    count_u: usize,
    count_v: usize,
    sample_count: usize,
    spacing_u: f64,
    spacing_v: f64,
}

fn validated_uniform_plane_lattice(
    request: &AntennaSpectrumRequestIR,
    field_sample_count: usize,
) -> Result<ValidatedAntennaSpectrumLattice, RunError> {
    let plane = &request.sampling_plane;
    let count_u = usize::try_from(plane.sample_count_u)
        .map_err(|_| error("antenna spectrum sample_count_u is not representable"))?;
    let count_v = usize::try_from(plane.sample_count_v)
        .map_err(|_| error("antenna spectrum sample_count_v is not representable"))?;
    if count_u < 2 || count_v < 2 {
        return Err(error(
            "antenna spectrum lattice must have at least two samples per axis",
        ));
    }
    let sample_count = count_u
        .checked_mul(count_v)
        .ok_or_else(|| error("antenna spectrum sample count overflows"))?;
    if sample_count > MAX_ANTENNA_SPECTRUM_SAMPLE_COUNT {
        return Err(error(format!(
            "antenna spectrum lattice has {sample_count} samples; limit is {MAX_ANTENNA_SPECTRUM_SAMPLE_COUNT}"
        )));
    }
    if field_sample_count != sample_count {
        return Err(error(format!(
            "antenna spectrum field samples have count {field_sample_count}, expected {sample_count}"
        )));
    }
    let finite_frame = plane
        .origin_m
        .iter()
        .chain(&plane.axis_u)
        .chain(&plane.axis_v)
        .chain([&plane.extent_u_m, &plane.extent_v_m])
        .all(|value| value.is_finite());
    let dot_uv = plane
        .axis_u
        .iter()
        .zip(plane.axis_v)
        .map(|(u, v)| u * v)
        .sum::<f64>();
    let norm_u = plane.axis_u.iter().map(|value| value * value).sum::<f64>();
    let norm_v = plane.axis_v.iter().map(|value| value * value).sum::<f64>();
    if !finite_frame
        || !dot_uv.is_finite()
        || !norm_u.is_finite()
        || !norm_v.is_finite()
        || (norm_u - 1.0).abs() > 1.0e-12
        || (norm_v - 1.0).abs() > 1.0e-12
        || dot_uv.abs() > 1.0e-12
        || plane.extent_u_m <= 0.0
        || plane.extent_v_m <= 0.0
    {
        return Err(error(
            "antenna spectrum sampling plane must have finite origin, orthonormal axes, and positive finite extents",
        ));
    }
    let spacing_u = plane.extent_u_m / (count_u - 1) as f64;
    let spacing_v = plane.extent_v_m / (count_v - 1) as f64;
    if !spacing_u.is_finite() || !spacing_v.is_finite() || spacing_u <= 0.0 || spacing_v <= 0.0 {
        return Err(error(
            "antenna spectrum plane spacing must be finite and positive",
        ));
    }
    Ok(ValidatedAntennaSpectrumLattice {
        count_u,
        count_v,
        sample_count,
        spacing_u,
        spacing_v,
    })
}

fn validated_nonuniform_k_grid(
    request: &AntennaSpectrumRequestIR,
) -> Result<(&fullmag_ir::AntennaSpectrumKGridIR, usize), RunError> {
    let grid = request
        .nonuniform_k_grid
        .as_ref()
        .ok_or_else(|| error("nonuniform antenna spectrum requires an explicit k grid"))?;
    if grid.k_u_rad_per_m.is_empty() || grid.k_v_rad_per_m.is_empty() {
        return Err(error(
            "nonuniform antenna spectrum k grid must contain at least one value on each axis",
        ));
    }
    if grid
        .k_u_rad_per_m
        .iter()
        .chain(&grid.k_v_rad_per_m)
        .any(|value| !value.is_finite())
    {
        return Err(error(
            "nonuniform antenna spectrum k grid must contain only finite values",
        ));
    }
    let output_count = grid
        .k_u_rad_per_m
        .len()
        .checked_mul(grid.k_v_rad_per_m.len())
        .ok_or_else(|| error("antenna nonuniform k-grid size overflows"))?;
    Ok((grid, output_count))
}

/// Compute the source-field spectrum after a separate carrier interpolation
/// step has produced the exact authored uniform plane lattice.
pub fn compute_structured_antenna_source_spectrum(
    request: &AntennaSpectrumRequestIR,
    field_samples_apm_per_a: &[[f64; 3]],
    equilibrium_samples: Option<&[[f64; 3]]>,
) -> Result<AntennaSourceSpectrum2D, RunError> {
    compute_structured_antenna_source_spectrum_interruptible(
        request,
        field_samples_apm_per_a,
        equilibrium_samples,
        None,
    )
}

fn compute_structured_antenna_source_spectrum_interruptible(
    request: &AntennaSpectrumRequestIR,
    field_samples_apm_per_a: &[[f64; 3]],
    equilibrium_samples: Option<&[[f64; 3]]>,
    interrupt_requested: Option<&AtomicBool>,
) -> Result<AntennaSourceSpectrum2D, RunError> {
    check_spectrum_interrupt(interrupt_requested)?;
    if request.transform != AntennaSpectrumTransformIR::SpatialFft {
        return Err(error(
            "structured antenna FFT kernel requires transform='spatial_fft'",
        ));
    }
    let lattice = validated_uniform_plane_lattice(request, field_samples_apm_per_a.len())?;
    if field_samples_apm_per_a
        .iter()
        .flatten()
        .any(|value| !value.is_finite())
    {
        return Err(error("antenna spectrum field samples are non-finite"));
    }
    let ValidatedAntennaSpectrumLattice {
        count_u,
        count_v,
        sample_count,
        spacing_u,
        spacing_v,
    } = lattice;
    let (window_u, window_v, coherent_gain, equivalent_noise_bandwidth_bins) =
        spectrum_window_metrics(&request.window, count_u, count_v)?;
    let scale = match request.normalization {
        AntennaSpectrumNormalizationIR::IntegralSi => spacing_u * spacing_v,
        AntennaSpectrumNormalizationIR::UnitaryDiscrete => 1.0 / (sample_count as f64).sqrt(),
    };
    let (component_labels, components) =
        selected_components(request, field_samples_apm_per_a, equilibrium_samples)?;
    let k_u_rad_per_m = fft_frequencies(count_u, spacing_u);
    let k_v_rad_per_m = fft_frequencies(count_v, spacing_v);
    let mut amplitudes = Vec::with_capacity(components.len() * sample_count);
    let mut power = vec![0.0; sample_count];
    for component in components {
        check_spectrum_interrupt(interrupt_requested)?;
        let mut transformed = component
            .into_iter()
            .enumerate()
            .map(|(index, value)| {
                let v = index / count_u;
                let u = index % count_u;
                Complex64::new(value * window_u[u] * window_v[v], 0.0)
            })
            .collect::<Vec<_>>();
        fft2_in_place(&mut transformed, count_u, count_v, interrupt_requested)?;
        check_spectrum_interrupt(interrupt_requested)?;
        for (index, value) in transformed.into_iter().enumerate() {
            let u = index % count_u;
            let v = index / count_u;
            let value = value
                * centered_origin_phase(
                    k_u_rad_per_m[u],
                    k_v_rad_per_m[v],
                    request.sampling_plane.extent_u_m,
                    request.sampling_plane.extent_v_m,
                )
                * scale;
            if !value.re.is_finite() || !value.im.is_finite() {
                return Err(error("antenna structured spectrum produced a non-finite amplitude"));
            }
            power[index] += value.norm_sqr();
            if !power[index].is_finite() {
                return Err(error("antenna structured spectrum produced non-finite power"));
            }
            amplitudes.push([value.re, value.im]);
        }
    }
    Ok(AntennaSourceSpectrum2D {
        schema_version: "antenna_source_spectrum.v1".into(),
        request_id: request.id.clone(),
        output_id: request.output_id.clone(),
        component: request.component.clone(),
        k_u_rad_per_m,
        k_v_rad_per_m,
        component_labels,
        amplitudes_re_im: amplitudes,
        power,
        coherent_gain,
        equivalent_noise_bandwidth_bins,
        normalization: match request.normalization {
            AntennaSpectrumNormalizationIR::IntegralSi => "integral_si",
            AntennaSpectrumNormalizationIR::UnitaryDiscrete => "unitary_discrete",
        }
        .into(),
        amplitude_unit: match request.normalization {
            AntennaSpectrumNormalizationIR::IntegralSi => "A*m/A",
            AntennaSpectrumNormalizationIR::UnitaryDiscrete => "A/m/A",
        }
        .into(),
        wave_vector_unit: "rad/m".into(),
    })
}

/// Direct nonuniform-k Fourier evaluation on the same certified uniform plane
/// samples. This deterministic reference path has a bounded sample-k cost.
pub fn compute_nonuniform_k_antenna_source_spectrum(
    request: &AntennaSpectrumRequestIR,
    field_samples_apm_per_a: &[[f64; 3]],
    equilibrium_samples: Option<&[[f64; 3]]>,
) -> Result<AntennaSourceSpectrum2D, RunError> {
    compute_nonuniform_k_antenna_source_spectrum_interruptible(
        request,
        field_samples_apm_per_a,
        equilibrium_samples,
        None,
    )
}

fn compute_nonuniform_k_antenna_source_spectrum_interruptible(
    request: &AntennaSpectrumRequestIR,
    field_samples_apm_per_a: &[[f64; 3]],
    equilibrium_samples: Option<&[[f64; 3]]>,
    interrupt_requested: Option<&AtomicBool>,
) -> Result<AntennaSourceSpectrum2D, RunError> {
    check_spectrum_interrupt(interrupt_requested)?;
    if request.transform != AntennaSpectrumTransformIR::NonuniformSpatialFft {
        return Err(error(
            "nonuniform-k antenna spectrum kernel requires transform='nonuniform_spatial_fft'",
        ));
    }
    let lattice = validated_uniform_plane_lattice(request, field_samples_apm_per_a.len())?;
    let (grid, output_count) = validated_nonuniform_k_grid(request)?;
    if field_samples_apm_per_a
        .iter()
        .flatten()
        .any(|value| !value.is_finite())
    {
        return Err(error("antenna spectrum field samples are non-finite"));
    }
    let ValidatedAntennaSpectrumLattice {
        count_u,
        count_v,
        sample_count,
        spacing_u,
        spacing_v,
    } = lattice;
    let operation_count = sample_count
        .checked_mul(output_count)
        .ok_or_else(|| error("antenna nonuniform transform operation count overflows"))?;
    if operation_count > MAX_ANTENNA_NONUNIFORM_OPERATION_COUNT {
        return Err(error(format!(
            "antenna direct nonuniform transform requires {operation_count} sample-k pairs; limit is {MAX_ANTENNA_NONUNIFORM_OPERATION_COUNT}"
        )));
    }
    let (window_u, window_v, coherent_gain, equivalent_noise_bandwidth_bins) =
        spectrum_window_metrics(&request.window, count_u, count_v)?;
    let scale = match request.normalization {
        AntennaSpectrumNormalizationIR::IntegralSi => spacing_u * spacing_v,
        AntennaSpectrumNormalizationIR::UnitaryDiscrete => 1.0 / (sample_count as f64).sqrt(),
    };
    let (component_labels, components) =
        selected_components(request, field_samples_apm_per_a, equilibrium_samples)?;
    let mut amplitudes = Vec::with_capacity(components.len() * output_count);
    let mut power = vec![0.0; output_count];
    for component in components {
        for &k_v in &grid.k_v_rad_per_m {
            for &k_u in &grid.k_u_rad_per_m {
                let mut amplitude = Complex64::new(0.0, 0.0);
                for v in 0..count_v {
                    check_spectrum_interrupt(interrupt_requested)?;
                    let coordinate_v =
                        -0.5 * request.sampling_plane.extent_v_m + v as f64 * spacing_v;
                    for u in 0..count_u {
                        let coordinate_u =
                            -0.5 * request.sampling_plane.extent_u_m + u as f64 * spacing_u;
                        let phase = -(k_u * coordinate_u + k_v * coordinate_v);
                        if !phase.is_finite() {
                            return Err(error("antenna nonuniform spectrum phase is non-finite"));
                        }
                        amplitude += Complex64::from_polar(
                            component[v * count_u + u] * window_u[u] * window_v[v],
                            phase,
                        );
                    }
                }
                let amplitude = amplitude * scale;
                if !amplitude.re.is_finite() || !amplitude.im.is_finite() {
                    return Err(error("antenna nonuniform spectrum produced a non-finite amplitude"));
                }
                let output_index = amplitudes.len() % output_count;
                power[output_index] += amplitude.norm_sqr();
                if !power[output_index].is_finite() {
                    return Err(error("antenna nonuniform spectrum produced non-finite power"));
                }
                amplitudes.push([amplitude.re, amplitude.im]);
            }
        }
    }
    Ok(AntennaSourceSpectrum2D {
        schema_version: "antenna_source_spectrum.v1".into(),
        request_id: request.id.clone(),
        output_id: request.output_id.clone(),
        component: request.component.clone(),
        k_u_rad_per_m: grid.k_u_rad_per_m.clone(),
        k_v_rad_per_m: grid.k_v_rad_per_m.clone(),
        component_labels,
        amplitudes_re_im: amplitudes,
        power,
        coherent_gain,
        equivalent_noise_bandwidth_bins,
        normalization: match request.normalization {
            AntennaSpectrumNormalizationIR::IntegralSi => "integral_si",
            AntennaSpectrumNormalizationIR::UnitaryDiscrete => "unitary_discrete",
        }
        .into(),
        amplitude_unit: match request.normalization {
            AntennaSpectrumNormalizationIR::IntegralSi => "A*m/A",
            AntennaSpectrumNormalizationIR::UnitaryDiscrete => "A/m/A",
        }
        .into(),
        wave_vector_unit: "rad/m".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(component: &str) -> AntennaSpectrumRequestIR {
        serde_json::from_value(serde_json::json!({
            "id": "source_k",
            "solution_ref": {"stage_id": "solve", "output_id": "basis", "asset_id": "asset", "content_digest": "digest"},
            "target": {"kind": "global"},
            "transform": "spatial_fft",
            "sampling_plane": {
                "origin_m": [0.0, 0.0, 0.0],
                "axis_u": [1.0, 0.0, 0.0],
                "axis_v": [0.0, 1.0, 0.0],
                "extent_u_m": 3.0,
                "extent_v_m": 3.0,
                "sample_count_u": 4,
                "sample_count_v": 4,
                "interpolation": "fem_element",
                "outside_policy": "error"
            },
            "window": "rectangular",
            "normalization": "unitary_discrete",
            "component": component,
            "output_id": "spectrum"
        }))
        .unwrap()
    }

    #[test]
    fn source_spectrum_kernels_stop_on_interrupt() {
        let interrupted = AtomicBool::new(true);
        let field = vec![[2.0, 0.0, 0.0]; 16];
        let error = compute_structured_antenna_source_spectrum_interruptible(
            &request("x"),
            &field,
            None,
            Some(&interrupted),
        )
        .expect_err("structured FFT must honor cancellation");
        assert!(error.message.contains("cancelled"));

        let mut nonuniform = request("x");
        nonuniform.transform = AntennaSpectrumTransformIR::NonuniformSpatialFft;
        nonuniform.nonuniform_k_grid = Some(fullmag_ir::AntennaSpectrumKGridIR {
            k_u_rad_per_m: vec![0.0],
            k_v_rad_per_m: vec![0.0],
        });
        let error = compute_nonuniform_k_antenna_source_spectrum_interruptible(
            &nonuniform,
            &field,
            None,
            Some(&interrupted),
        )
        .expect_err("direct k transform must honor cancellation");
        assert!(error.message.contains("cancelled"));
    }

    #[test]
    fn constant_field_has_only_the_zero_wave_vector_bin() {
        let field = vec![[2.0, 0.0, 0.0]; 16];
        let result =
            compute_structured_antenna_source_spectrum(&request("x"), &field, None).unwrap();
        assert!((result.amplitudes_re_im[0][0] - 8.0).abs() < 1.0e-12);
        assert!(result.amplitudes_re_im[1..]
            .iter()
            .all(|value| value[0].abs() < 1.0e-12 && value[1].abs() < 1.0e-12));
        assert_eq!(result.k_u_rad_per_m[3], -std::f64::consts::FRAC_PI_2);
        assert_eq!(result.k_u_rad_per_m[2], -std::f64::consts::PI);
    }

    #[test]
    fn transverse_projection_removes_field_parallel_to_equilibrium() {
        let field = vec![[0.0, 0.0, 3.0]; 16];
        let equilibrium = vec![[0.0, 0.0, 1.0]; 16];
        let result = compute_structured_antenna_source_spectrum(
            &request("transverse"),
            &field,
            Some(&equilibrium),
        )
        .unwrap();
        assert!(result.power.iter().all(|value| *value == 0.0));
    }

    #[test]
    fn published_spectrum_rejects_uncertified_or_ignored_analysis_references() {
        let mut transverse = request("transverse");
        transverse.equilibrium_ref = Some("equilibrium_1".into());
        let samples = solution_samples_for(&transverse);
        let equilibrium = vec![[0.0, 0.0, 1.0]; 16];
        let error = compute_antenna_source_spectrum_artifact(
            &transverse, &samples, Some(&equilibrium),
        ).unwrap_err();
        assert!(error.message.contains("verified equilibrium resource loader"));

        let mut cartesian = request("x");
        cartesian.equilibrium_ref = Some("equilibrium_1".into());
        let error = compute_antenna_source_spectrum_artifact(
            &cartesian, &samples, None,
        ).unwrap_err();
        assert!(error.message.contains("ignored equilibrium"));

        cartesian.equilibrium_ref = None;
        cartesian.mode_basis_ref = Some("modes_1".into());
        let error = compute_antenna_source_spectrum_artifact(
            &cartesian, &samples, None,
        ).unwrap_err();
        assert!(error.message.contains("mode-basis references"));
    }

    #[test]
    fn direct_nonuniform_k_grid_evaluates_authored_zero_bin() {
        let mut request = request("x");
        request.transform = AntennaSpectrumTransformIR::NonuniformSpatialFft;
        request.nonuniform_k_grid = Some(fullmag_ir::AntennaSpectrumKGridIR {
            k_u_rad_per_m: vec![0.0, 0.25],
            k_v_rad_per_m: vec![0.0],
        });
        let field = vec![[2.0, 0.0, 0.0]; 16];
        let result = compute_nonuniform_k_antenna_source_spectrum(&request, &field, None).unwrap();
        assert!((result.amplitudes_re_im[0][0] - 8.0).abs() < 1.0e-12);
        assert_eq!(result.k_u_rad_per_m, vec![0.0, 0.25]);
    }

    #[test]
    fn regular_fft_matches_direct_centered_phase_convention() {
        let field = (0..16)
            .map(|index| {
                if index == 1 {
                    [3.0, 0.0, 0.0]
                } else if index == 14 {
                    [-1.5, 0.0, 0.0]
                } else {
                    [0.0, 0.0, 0.0]
                }
            })
            .collect::<Vec<_>>();
        for window in [
            AntennaSpectrumWindowIR::Rectangular,
            AntennaSpectrumWindowIR::Hann,
            AntennaSpectrumWindowIR::Hamming,
            AntennaSpectrumWindowIR::Blackman,
        ] {
            for normalization in [
                AntennaSpectrumNormalizationIR::UnitaryDiscrete,
                AntennaSpectrumNormalizationIR::IntegralSi,
            ] {
                let mut structured_request = request("x");
                structured_request.window = window.clone();
                structured_request.normalization = normalization.clone();
                let structured = compute_structured_antenna_source_spectrum(
                    &structured_request,
                    &field,
                    None,
                )
                .unwrap();
                assert!(structured.k_u_rad_per_m.iter().any(|value| *value < 0.0));
                assert!(structured.k_v_rad_per_m.iter().any(|value| *value < 0.0));

                structured_request.transform = AntennaSpectrumTransformIR::NonuniformSpatialFft;
                structured_request.nonuniform_k_grid = Some(fullmag_ir::AntennaSpectrumKGridIR {
                    k_u_rad_per_m: structured.k_u_rad_per_m.clone(),
                    k_v_rad_per_m: structured.k_v_rad_per_m.clone(),
                });
                let direct = compute_nonuniform_k_antenna_source_spectrum(
                    &structured_request,
                    &field,
                    None,
                )
                .unwrap();

                assert_eq!(structured.k_u_rad_per_m, direct.k_u_rad_per_m);
                assert_eq!(structured.k_v_rad_per_m, direct.k_v_rad_per_m);
                for (fft, direct) in structured
                    .amplitudes_re_im
                    .iter()
                    .zip(&direct.amplitudes_re_im)
                {
                    assert!((fft[0] - direct[0]).abs() < 1.0e-12);
                    assert!((fft[1] - direct[1]).abs() < 1.0e-12);
                }
            }
        }
    }

    #[test]
    fn structured_spectrum_rejects_invalid_lattice_before_subtracting_counts() {
        let mut invalid = request("x");
        invalid.sampling_plane.sample_count_u = 0;
        let error = compute_structured_antenna_source_spectrum(&invalid, &[], None)
            .expect_err("zero lattice axis must fail closed");
        assert!(error.message.contains("at least two samples per axis"));
    }

    #[test]
    fn direct_spectrum_rejects_nonfinite_k_grid_and_wrong_sample_count() {
        let mut invalid_grid = request("x");
        invalid_grid.transform = AntennaSpectrumTransformIR::NonuniformSpatialFft;
        invalid_grid.nonuniform_k_grid = Some(fullmag_ir::AntennaSpectrumKGridIR {
            k_u_rad_per_m: vec![f64::NAN],
            k_v_rad_per_m: vec![0.0],
        });
        let field = vec![[0.0, 0.0, 0.0]; 16];
        let error = compute_nonuniform_k_antenna_source_spectrum(&invalid_grid, &field[..15], None)
            .expect_err("wrong lattice sample count must fail closed");
        assert!(error.message.contains("field samples have count 15"));

        let error = compute_nonuniform_k_antenna_source_spectrum(&invalid_grid, &field, None)
            .expect_err("non-finite k grid must fail closed");
        assert!(error
            .message
            .contains("k grid must contain only finite values"));
    }

    #[test]
    fn spectrum_rejects_overflow_from_finite_inputs() {
        let structured = request("x");
        let huge_field = vec![[1.0e308, 0.0, 0.0]; 16];
        let error = compute_structured_antenna_source_spectrum(&structured, &huge_field, None)
            .expect_err("finite samples must not publish overflowing FFT output");
        assert!(error.message.contains("non-finite"));

        let mut direct = request("x");
        direct.transform = AntennaSpectrumTransformIR::NonuniformSpatialFft;
        direct.nonuniform_k_grid = Some(fullmag_ir::AntennaSpectrumKGridIR {
            k_u_rad_per_m: vec![1.7e308],
            k_v_rad_per_m: vec![0.0],
        });
        let finite_field = vec![[1.0, 0.0, 0.0]; 16];
        let error = compute_nonuniform_k_antenna_source_spectrum(&direct, &finite_field, None)
            .expect_err("finite k must not publish an overflowing phase");
        assert!(error.message.contains("phase is non-finite"));
    }

    fn solution_samples_for(request: &AntennaSpectrumRequestIR) -> AntennaFieldSolutionSamples {
        let count_u = request.sampling_plane.sample_count_u as usize;
        let count_v = request.sampling_plane.sample_count_v as usize;
        let spacing_u = request.sampling_plane.extent_u_m / (count_u - 1) as f64;
        let spacing_v = request.sampling_plane.extent_v_m / (count_v - 1) as f64;
        let mut positions = Vec::with_capacity(count_u * count_v);
        let mut field = Vec::with_capacity(count_u * count_v);
        for v in 0..count_v {
            let coordinate_v = -0.5 * request.sampling_plane.extent_v_m + v as f64 * spacing_v;
            for u in 0..count_u {
                let coordinate_u = -0.5 * request.sampling_plane.extent_u_m + u as f64 * spacing_u;
                positions.push([
                    request.sampling_plane.origin_m[0]
                        + coordinate_u * request.sampling_plane.axis_u[0]
                        + coordinate_v * request.sampling_plane.axis_v[0],
                    request.sampling_plane.origin_m[1]
                        + coordinate_u * request.sampling_plane.axis_u[1]
                        + coordinate_v * request.sampling_plane.axis_v[1],
                    request.sampling_plane.origin_m[2]
                        + coordinate_u * request.sampling_plane.axis_u[2]
                        + coordinate_v * request.sampling_plane.axis_v[2],
                ]);
                let index = (v * count_u + u) as f64;
                field.push([index, 0.0, 0.0]);
            }
        }
        AntennaFieldSolutionSamples {
            solution_id: "solution".into(),
            source_object_id: "antenna".into(),
            port_mode_id: "port".into(),
            sample_positions_xyz_m: positions,
            magnetic_field_xyz_apm_per_a: field,
            sample_tet4_cells: None,
            content_digest: "sha256:solution".into(),
        }
    }

    #[test]
    fn identity_plane_sampling_is_coordinate_stable_and_reorders_sources() {
        let request = request("x");
        let mut samples = solution_samples_for(&request);
        samples.sample_positions_xyz_m.reverse();
        samples.magnetic_field_xyz_apm_per_a.reverse();
        let sampled = sample_antenna_field_on_plane(&request, &samples).unwrap();
        assert_eq!(sampled.outside_count, 0);
        assert_eq!(sampled.field_xyz_apm_per_a[0][0], 0.0);
        assert_eq!(sampled.field_xyz_apm_per_a[15][0], 15.0);
        assert!(sampled.mapping_digest.starts_with("sha256:"));
    }

    #[test]
    fn identity_plane_sampling_distinguishes_micrometre_samples_far_from_origin() {
        let mut request = request("x");
        request.sampling_plane.origin_m = [1.0e6, 1.0e6, 0.0];
        request.sampling_plane.extent_u_m = 3.0e-6;
        request.sampling_plane.extent_v_m = 3.0e-6;
        let mut samples = solution_samples_for(&request);
        samples.sample_positions_xyz_m.reverse();
        samples.magnetic_field_xyz_apm_per_a.reverse();

        let sampled = sample_antenna_field_on_plane(&request, &samples).unwrap();
        assert_eq!(sampled.outside_count, 0);
        for (index, field) in sampled.field_xyz_apm_per_a.iter().enumerate() {
            assert_eq!(field[0], index as f64);
        }
    }

    #[test]
    fn identity_plane_sampling_ignores_remote_source_samples() {
        let request = request("x");
        let mut samples = solution_samples_for(&request);
        samples.sample_positions_xyz_m.push([1.0e100, 0.0, 0.0]);
        samples.magnetic_field_xyz_apm_per_a.push([999.0, 0.0, 0.0]);

        let sampled = sample_antenna_field_on_plane(&request, &samples).unwrap();
        assert_eq!(sampled.outside_count, 0);
        for (index, field) in sampled.field_xyz_apm_per_a.iter().enumerate() {
            assert_eq!(field[0], index as f64);
        }
    }

    #[test]
    fn identity_plane_sampling_rejects_spacing_below_coordinate_resolution() {
        let mut request = request("x");
        request.sampling_plane.origin_m = [1.0e6, 1.0e6, 0.0];
        request.sampling_plane.extent_u_m = 3.0e-10;
        request.sampling_plane.extent_v_m = 3.0e-10;
        let samples = solution_samples_for(&request);

        let error = sample_antenna_field_on_plane(&request, &samples).unwrap_err();
        assert!(error.message.contains("spacing is not resolvable"));
    }

    #[test]
    fn fem_element_sampling_interpolates_a_p1_field_from_tetrahedral_carrier() {
        let mut request = request("x");
        request.sampling_plane.origin_m = [0.25, 0.25, 0.0];
        request.sampling_plane.extent_u_m = 0.5;
        request.sampling_plane.extent_v_m = 0.5;
        let positions = vec![
            [0.0, 0.0, -1.0],
            [2.0, 0.0, 0.0],
            [0.0, 2.0, 0.0],
            [0.0, 0.0, 1.0],
        ];
        let fields = positions
            .iter()
            .map(|position| {
                [
                    position[0] + 2.0 * position[1] + 3.0 * position[2],
                    0.0,
                    0.0,
                ]
            })
            .collect();
        let samples = AntennaFieldSolutionSamples {
            solution_id: "solution".into(),
            source_object_id: "antenna".into(),
            port_mode_id: "port".into(),
            sample_positions_xyz_m: positions,
            magnetic_field_xyz_apm_per_a: fields,
            sample_tet4_cells: Some(vec![[0, 1, 2, 3]]),
            content_digest: "sha256:solution".into(),
        };

        let sampled = sample_antenna_field_on_plane(&request, &samples).unwrap();
        let expected = [
            0.0,
            1.0 / 6.0,
            1.0 / 3.0,
            0.5,
            1.0 / 3.0,
            0.5,
            2.0 / 3.0,
            5.0 / 6.0,
            2.0 / 3.0,
            5.0 / 6.0,
            1.0,
            7.0 / 6.0,
            1.0,
            7.0 / 6.0,
            4.0 / 3.0,
            1.5,
        ];
        for (actual, expected) in sampled
            .field_xyz_apm_per_a
            .iter()
            .map(|value| value[0])
            .zip(expected)
        {
            assert!(
                (actual - expected).abs() < 1.0e-12,
                "actual={actual}, expected={expected}"
            );
        }
        assert_eq!(sampled.outside_count, 0);
        assert!(sampled.mapping_digest.starts_with("sha256:"));
        let artifact = compute_antenna_source_spectrum_artifact(&request, &samples, None).unwrap();
        assert_eq!(artifact.sampling.realization, "fem_p1_interpolation_v1");
    }

    #[test]
    fn fem_element_sampling_is_scale_and_rotation_invariant() {
        let inverse_sqrt_2 = 1.0 / 2.0_f64.sqrt();
        let inverse_sqrt_3 = 1.0 / 3.0_f64.sqrt();
        let inverse_sqrt_6 = 1.0 / 6.0_f64.sqrt();
        let axis_u = [inverse_sqrt_2, inverse_sqrt_2, 0.0];
        let axis_v = [-inverse_sqrt_6, inverse_sqrt_6, 2.0 * inverse_sqrt_6];
        let axis_w = [inverse_sqrt_3, -inverse_sqrt_3, inverse_sqrt_3];
        let local_vertices = [
            [0.0, 0.0, -1.0],
            [2.0, 0.0, 0.0],
            [0.0, 2.0, 0.0],
            [0.0, 0.0, 1.0],
        ];

        for scale_m in [1.0, 1.0e-6, 1.0e-9] {
            let translation = [3.0 * scale_m, -2.0 * scale_m, 5.0 * scale_m];
            let transform = |local: [f64; 3]| {
                std::array::from_fn(|component| {
                    translation[component]
                        + scale_m
                            * (local[0] * axis_u[component]
                                + local[1] * axis_v[component]
                                + local[2] * axis_w[component])
                })
            };
            let mut request = request("x");
            request.sampling_plane.origin_m = transform([0.25, 0.25, 0.0]);
            request.sampling_plane.axis_u = axis_u;
            request.sampling_plane.axis_v = axis_v;
            request.sampling_plane.extent_u_m = 0.5 * scale_m;
            request.sampling_plane.extent_v_m = 0.5 * scale_m;
            let samples = AntennaFieldSolutionSamples {
                solution_id: "solution".into(),
                source_object_id: "antenna".into(),
                port_mode_id: "port".into(),
                sample_positions_xyz_m: local_vertices.into_iter().map(transform).collect(),
                magnetic_field_xyz_apm_per_a: local_vertices
                    .into_iter()
                    .map(|local| {
                        [
                            1.0 + 2.0 * local[0] + 3.0 * local[1] - 4.0 * local[2],
                            0.0,
                            0.0,
                        ]
                    })
                    .collect(),
                sample_tet4_cells: Some(vec![[0, 1, 2, 3]]),
                content_digest: "sha256:solution".into(),
            };

            let sampled = sample_antenna_field_on_plane(&request, &samples)
                .unwrap_or_else(|error| panic!("scale_m={scale_m:.1e}: {}", error.message));
            for v in 0..4 {
                for u in 0..4 {
                    let local_u = u as f64 / 6.0;
                    let local_v = v as f64 / 6.0;
                    let expected = 1.0 + 2.0 * local_u + 3.0 * local_v;
                    let actual = sampled.field_xyz_apm_per_a[v * 4 + u][0];
                    assert!(
                        (actual - expected).abs() < 1.0e-10,
                        "scale_m={scale_m:.1e}, u={u}, v={v}, actual={actual:.17e}, expected={expected:.17e}"
                    );
                }
            }
            assert_eq!(sampled.outside_count, 0);
        }
    }

    #[test]
    fn barycentric_tet_rejects_degenerate_nanometre_geometry() {
        let scale_m = 1.0e-9;
        let vertices = [
            [0.0, 0.0, 0.0],
            [scale_m, 0.0, 0.0],
            [0.0, scale_m, 0.0],
            [scale_m, scale_m, 0.0],
        ];
        assert!(barycentric_tet([0.25 * scale_m, 0.25 * scale_m, 0.0], vertices).is_none());
    }

    #[test]
    fn shared_face_ownership_uses_lowest_topology_ordinal() {
        let positions = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, -1.0],
        ];
        let cells = vec![[0, 1, 2, 3], [0, 1, 2, 4]];
        let bvh = FieldTetraBvh::build(&positions, &cells, 1.0e-12).unwrap();

        let (cell_index, _) = bvh
            .locate([0.2, 0.2, 0.0], &positions, &cells)
            .expect("shared-face point must belong to one deterministic cell");

        assert_eq!(cell_index, 0);
    }

    #[test]
    fn tetrahedral_index_build_rejects_pending_interrupt() {
        let positions = [[0.0, 0.0, 0.0]; 4];
        let cells = [[0, 1, 2, 3]];
        let interrupted = AtomicBool::new(true);
        let error = FieldTetraBvh::build_interruptible(
            &positions,
            &cells,
            1.0e-12,
            Some(&interrupted),
        )
        .err()
        .expect("cancelled index construction must stop before building a tree");
        assert!(error.message.contains("cancelled"));
    }

    #[test]
    fn tetrahedral_carrier_zeroes_only_points_outside_its_cells_not_its_bounds() {
        let mut request = request("x");
        request.sampling_plane.origin_m = [0.5, 0.5, 0.1];
        request.sampling_plane.extent_u_m = 1.0;
        request.sampling_plane.extent_v_m = 1.0;
        request.sampling_plane.outside_policy = fullmag_ir::AntennaSpectrumOutsidePolicyIR::Zero;
        let positions = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ];
        let samples = AntennaFieldSolutionSamples {
            solution_id: "solution".into(),
            source_object_id: "antenna".into(),
            port_mode_id: "port".into(),
            sample_positions_xyz_m: positions,
            magnetic_field_xyz_apm_per_a: vec![[2.0, 0.0, 0.0]; 4],
            sample_tet4_cells: Some(vec![[0, 1, 2, 3]]),
            content_digest: "sha256:solution".into(),
        };

        let sampled = sample_antenna_field_on_plane(&request, &samples).unwrap();
        assert_eq!(sampled.field_xyz_apm_per_a[0], [2.0, 0.0, 0.0]);
        assert_eq!(sampled.field_xyz_apm_per_a[3], [0.0; 3]);
        assert!(sampled.outside_count > 0);

        request.sampling_plane.outside_policy = fullmag_ir::AntennaSpectrumOutsidePolicyIR::Error;
        let error = sample_antenna_field_on_plane(&request, &samples).unwrap_err();
        assert!(error.message.contains("outside the FEM tetrahedral carrier"));
    }

    #[test]
    fn degenerate_tetrahedral_carrier_is_not_classified_as_outside() {
        let positions = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [1.0, 1.0, 0.0]];
        let error = FieldTetraBvh::build(&positions, &[[0, 1, 2, 3]], 1.0e-12)
            .err()
            .expect("coplanar tet4 must fail before outside-zero classification");
        assert!(error.message.contains("degenerate tet4"));
    }

    #[test]
    fn tetrahedral_sampler_rejects_nonfinite_interpolation_from_finite_values() {
        let mut request = request("x");
        request.sampling_plane.origin_m = [-1.0e-11, 0.05 - 1.0e-11, 0.05 - 1.0e-11];
        request.sampling_plane.axis_u = [0.0, 1.0, 0.0];
        request.sampling_plane.axis_v = [0.0, 0.0, 1.0];
        request.sampling_plane.extent_u_m = 0.1;
        request.sampling_plane.extent_v_m = 0.1;
        let samples = AntennaFieldSolutionSamples {
            solution_id: "solution".into(),
            source_object_id: "antenna".into(),
            port_mode_id: "port".into(),
            sample_positions_xyz_m: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ],
            magnetic_field_xyz_apm_per_a: vec![
                [f64::MAX, 0.0, 0.0],
                [0.0; 3],
                [0.0; 3],
                [0.0; 3],
            ],
            sample_tet4_cells: Some(vec![[0, 1, 2, 3]]),
            content_digest: "sha256:solution".into(),
        };
        let error = sample_antenna_field_on_plane(&request, &samples)
            .expect_err("finite source values must not yield a non-finite P1 sample");
        assert!(error.message.contains("P1 interpolation produced a non-finite field"));
    }

    #[test]
    fn missing_internal_lattice_points_fail_closed_instead_of_becoming_zero() {
        let mut request = request("x");
        request.sampling_plane.outside_policy = fullmag_ir::AntennaSpectrumOutsidePolicyIR::Zero;
        let mut samples = solution_samples_for(&request);
        samples.sample_positions_xyz_m.pop();
        samples.magnetic_field_xyz_apm_per_a.pop();
        let error = sample_antenna_field_on_plane(&request, &samples).unwrap_err();
        assert!(error.message.contains("inside the source carrier bounds"));
    }

    #[test]
    fn outside_zero_policy_only_zeros_points_outside_source_bounds() {
        let mut request = request("x");
        request.sampling_plane.outside_policy = fullmag_ir::AntennaSpectrumOutsidePolicyIR::Zero;
        let mut samples = solution_samples_for(&request);
        let retained = (0..samples.sample_positions_xyz_m.len())
            .filter(|index| index % request.sampling_plane.sample_count_u as usize != 3)
            .collect::<Vec<_>>();
        samples.sample_positions_xyz_m = retained
            .iter()
            .map(|index| samples.sample_positions_xyz_m[*index])
            .collect();
        samples.magnetic_field_xyz_apm_per_a = retained
            .iter()
            .map(|index| samples.magnetic_field_xyz_apm_per_a[*index])
            .collect();

        let sampled = sample_antenna_field_on_plane(&request, &samples).unwrap();
        assert_eq!(sampled.outside_count, 4);
        assert_eq!(sampled.field_xyz_apm_per_a[3], [0.0; 3]);
    }

    #[test]
    fn unsupported_grid_interpolation_fails_closed() {
        let mut request = request("x");
        request.sampling_plane.interpolation = "fdm_trilinear".into();
        let samples = solution_samples_for(&request);
        let error = sample_antenna_field_on_plane(&request, &samples).unwrap_err();
        assert!(error.message.contains("not executable"));
    }

    #[test]
    fn source_spectrum_artifact_is_content_addressed_and_serializable() {
        let request = request("x");
        let samples = solution_samples_for(&request);
        let artifact = compute_antenna_source_spectrum_artifact(&request, &samples, None).unwrap();
        assert!(artifact.content_digest.starts_with("sha256:"));
        let artifacts = antenna_source_spectrum_auxiliary_artifacts(&artifact).unwrap();
        verify_antenna_source_spectrum_auxiliary_artifacts(&artifacts).unwrap();
        assert_eq!(artifacts.len(), 5);
        assert!(artifacts
            .iter()
            .any(|entry| entry.relative_path.ends_with("/k_u_rad_per_m.f64le")));
        assert!(artifacts
            .iter()
            .any(|entry| entry.relative_path.ends_with("/amplitudes_re_im.f64le")));
        let payload = artifacts
            .iter()
            .find(|entry| entry.relative_path.ends_with("/spectrum.v2.json"))
            .unwrap();
        assert_eq!(
            payload.relative_path,
            "antenna/source_spectra/spectrum/spectrum.v2.json"
        );
        let json: serde_json::Value = serde_json::from_slice(&payload.bytes).unwrap();
        assert_eq!(
            json["schema_version"],
            "antenna_source_spectrum_artifact.v2"
        );
        assert_eq!(json["sampling"]["outside_count"], 0);
        assert_eq!(json["sampling"]["realization"], "identity_coordinates_v1");
        assert_eq!(json["sampling"]["transform"], "spatial_fft");
        assert_eq!(json["sampling"]["window"], "rectangular");
        assert_eq!(
            json["sampling"]["fourier_realization"],
            "structured_fft_rustfft_centered_v1"
        );
        assert!(json["spectrum"].get("amplitudes_re_im").is_none());
        assert!(json["payloads"]["amplitudes_re_im"]["sha256"]
            .as_str()
            .is_some_and(|digest| digest.starts_with("sha256:")));
    }

    #[test]
    fn source_spectrum_verifier_rejects_tampered_manifest_and_payload() {
        let request = request("x");
        let samples = solution_samples_for(&request);
        let artifact = compute_antenna_source_spectrum_artifact(&request, &samples, None).unwrap();
        let artifacts = antenna_source_spectrum_auxiliary_artifacts(&artifact).unwrap();

        let mut tampered_payload = artifacts.clone();
        tampered_payload[0].bytes[0] ^= 1;
        let error = verify_antenna_source_spectrum_auxiliary_artifacts(&tampered_payload)
            .unwrap_err();
        assert!(error.message.contains("sha256 mismatch"));

        let mut tampered_manifest = artifacts;
        let manifest = tampered_manifest.last_mut().unwrap();
        let mut value: serde_json::Value = serde_json::from_slice(&manifest.bytes).unwrap();
        value["sampling"]["window"] = serde_json::json!("hann");
        manifest.bytes = serde_json::to_vec(&value).unwrap();
        let error = verify_antenna_source_spectrum_auxiliary_artifacts(&tampered_manifest)
            .unwrap_err();
        assert!(error.message.contains("content_digest mismatch"));
    }

    #[test]
    fn spectrum_readers_refuse_duplicate_keys_even_with_valid_last_value_digest() {
        let request = request("x");
        let samples = solution_samples_for(&request);
        let artifact = compute_antenna_source_spectrum_artifact(&request, &samples, None).unwrap();
        let artifacts = antenna_source_spectrum_auxiliary_artifacts(&artifact).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&artifacts.last().unwrap().bytes).unwrap();
        let original = serde_json::to_string(&value).unwrap();
        verify_antenna_source_spectrum_auxiliary_artifacts(&artifacts).unwrap();
        let output_dir = std::env::temp_dir().join(format!("fullmag-spectrum-duplicate-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&output_dir).unwrap();
        for payload in &artifacts {
            std::fs::write(output_dir.join(Path::new(&payload.relative_path).file_name().unwrap()), &payload.bytes).unwrap();
        }
        for (needle, replacement) in [
            ("\"output_id\":\"spectrum\"", "\"output_id\":\"other\",\"output_id\":\"spectrum\""),
            ("\"component\":\"x\"", "\"component\":\"z\",\"component\":\"x\""),
            ("\"unit\":\"rad/m\"", "\"unit\":\"m\",\"un\\u0069t\":\"rad/m\""),
        ] {
            let ambiguous = original.replacen(needle, replacement, 1);
            assert_ne!(ambiguous, original);
            // The old Value parser collapses the duplicate back to the exact
            // valid document: digest checks alone cannot distinguish it.
            assert_eq!(serde_json::from_str::<serde_json::Value>(&ambiguous).unwrap(), value);
            let mut tampered = artifacts.clone();
            tampered.last_mut().unwrap().bytes = ambiguous.as_bytes().to_vec();
            assert!(parse_antenna_source_spectrum_manifest_json(ambiguous.as_bytes()).unwrap_err().message.contains("duplicate JSON key"));
            assert!(verify_antenna_source_spectrum_auxiliary_artifacts(&tampered).unwrap_err().message.contains("duplicate JSON key"));
            std::fs::write(output_dir.join("spectrum.v2.json"), ambiguous.as_bytes()).unwrap();
            assert!(reusable_antenna_source_spectrum_output(
                &output_dir, &request, &samples.solution_id, &samples.source_object_id,
                &samples.port_mode_id, &samples.content_digest, None,
            ).unwrap_err().message.contains("duplicate JSON key"));
        }
        std::fs::write(output_dir.join("spectrum.v2.json"), original.as_bytes()).unwrap();
        assert!(reusable_antenna_source_spectrum_output(
            &output_dir, &request, &samples.solution_id, &samples.source_object_id,
            &samples.port_mode_id, &samples.content_digest, None,
        ).unwrap());
        std::fs::remove_dir_all(output_dir).unwrap();
    }

    #[test]
    fn source_spectrum_verifier_rejects_rehashed_invalid_units_and_shape() {
        let request = request("x");
        let samples = solution_samples_for(&request);
        let artifact = compute_antenna_source_spectrum_artifact(&request, &samples, None).unwrap();
        let artifacts = antenna_source_spectrum_auxiliary_artifacts(&artifact).unwrap();
        for (path, replacement, expected_error) in [
            ("/payloads/power/unit", serde_json::json!("wrong"), "shape or unit"),
            ("/spectrum/amplitude_count", serde_json::json!(999), "shape or unit"),
            ("/spectrum/coherent_gain", serde_json::json!(0.123), "shape or unit"),
            ("/sampling/fourier_phase_convention", serde_json::json!("wrong"), "sampling provenance"),
            ("/sampling/axis_u", serde_json::json!([2.0, 0.0, 0.0]), "sampling provenance"),
            ("/sampling/source_sample_count", serde_json::json!(0), "sampling provenance"),
            ("/sampling/mapping_digest", serde_json::json!(""), "sampling provenance"),
            ("/sampling/interpolation", serde_json::json!("fdm_trilinear"), "sampling provenance"),
            ("/spectrum/k_u_count", serde_json::json!(0), "shape or unit"),
        ] {
            let mut tampered = artifacts.clone();
            let manifest = tampered.last_mut().unwrap();
            let mut value: serde_json::Value = serde_json::from_slice(&manifest.bytes).unwrap();
            *value.pointer_mut(path).unwrap() = replacement;
            let mut canonical = value.clone();
            canonical.as_object_mut().unwrap().remove("content_digest");
            value["content_digest"] =
                serde_json::json!(sha256_bytes(&serde_json::to_vec(&canonical).unwrap()));
            manifest.bytes = serde_json::to_vec(&value).unwrap();
            let error = verify_antenna_source_spectrum_auxiliary_artifacts(&tampered)
                .unwrap_err();
            assert!(error.message.contains(expected_error), "{}", error.message);
        }
    }

    #[test]
    fn cached_spectrum_reuses_only_matching_verified_analysis() {
        let request = request("x");
        let samples = solution_samples_for(&request);
        let artifact = compute_antenna_source_spectrum_artifact(&request, &samples, None).unwrap();
        let artifacts = antenna_source_spectrum_auxiliary_artifacts(&artifact).unwrap();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-antenna-spectrum-cache-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&output_dir).unwrap();
        for artifact in &artifacts {
            let filename = Path::new(&artifact.relative_path).file_name().unwrap();
            std::fs::write(output_dir.join(filename), &artifact.bytes).unwrap();
        }
        let reuse = |request: &AntennaSpectrumRequestIR| {
            reusable_antenna_source_spectrum_output(
                &output_dir,
                request,
                &samples.solution_id,
                &samples.source_object_id,
                &samples.port_mode_id,
                &samples.content_digest,
                None,
            )
        };
        assert!(reuse(&request).unwrap());

        let mut changed_window = request.clone();
        changed_window.window = AntennaSpectrumWindowIR::Hann;
        assert!(reuse(&changed_window).unwrap_err().message.contains("different analysis inputs"));

        let mut changed_source = samples.content_digest.clone();
        changed_source.push('x');
        let error = reusable_antenna_source_spectrum_output(
            &output_dir,
            &request,
            &samples.solution_id,
            &samples.source_object_id,
            &samples.port_mode_id,
            &changed_source,
            None,
        ).unwrap_err();
        assert!(error.message.contains("different analysis inputs"));

        let manifest_path = output_dir.join("spectrum.v2.json");
        let mut invalid_gain: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
        invalid_gain["spectrum"]["coherent_gain"] = serde_json::json!(0.123);
        let mut canonical = invalid_gain.clone();
        canonical.as_object_mut().unwrap().remove("content_digest");
        invalid_gain["content_digest"] =
            serde_json::json!(sha256_bytes(&serde_json::to_vec(&canonical).unwrap()));
        std::fs::write(&manifest_path, serde_json::to_vec(&invalid_gain).unwrap()).unwrap();
        assert!(reuse(&request).unwrap_err().message.contains("window metrics"));
        std::fs::write(&manifest_path, &artifacts.last().unwrap().bytes).unwrap();

        let mut invalid_unit: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
        invalid_unit["payloads"]["power"]["unit"] = serde_json::json!("wrong");
        let mut canonical = invalid_unit.clone();
        canonical.as_object_mut().unwrap().remove("content_digest");
        invalid_unit["content_digest"] =
            serde_json::json!(sha256_bytes(&serde_json::to_vec(&canonical).unwrap()));
        std::fs::write(&manifest_path, serde_json::to_vec(&invalid_unit).unwrap()).unwrap();
        assert!(reuse(&request).unwrap_err().message.contains("shape or unit"));
        std::fs::write(&manifest_path, &artifacts.last().unwrap().bytes).unwrap();

        std::fs::write(output_dir.join("power.f64le"), [0_u8; 8]).unwrap();
        assert!(reuse(&request).unwrap_err().message.contains("sha256 mismatch"));
        std::fs::remove_dir_all(output_dir).unwrap();
    }

    #[test]
    fn hann_window_reports_two_dimensional_coherent_gain_and_enbw() {
        let mut request = request("x");
        request.window = AntennaSpectrumWindowIR::Hann;
        let field = vec![[1.0, 0.0, 0.0]; 16];
        let result = compute_structured_antenna_source_spectrum(&request, &field, None).unwrap();

        assert!((result.coherent_gain - 9.0 / 64.0).abs() < 1.0e-14);
        assert!((result.equivalent_noise_bandwidth_bins - 4.0).abs() < 1.0e-14);
    }

    #[test]
    fn analytic_window_metrics_match_executed_windows_without_sample_arrays() {
        for window in [
            AntennaSpectrumWindowIR::Rectangular,
            AntennaSpectrumWindowIR::Hann,
            AntennaSpectrumWindowIR::Hamming,
            AntennaSpectrumWindowIR::Blackman,
        ] {
            for (count_u, count_v) in [(3, 3), (4, 5), (5, 4), (33, 65), (65, 33)] {
                let (_, _, executed_gain, executed_enbw) =
                    spectrum_window_metrics(&window, count_u, count_v).unwrap();
                let (analytic_gain, analytic_enbw) =
                    analytic_window_metrics(&window, count_u, count_v).unwrap();
                assert!(window_metric_matches(executed_gain, analytic_gain));
                assert!(window_metric_matches(executed_enbw, analytic_enbw));
            }
        }
        assert_eq!(
            analytic_window_metrics(&AntennaSpectrumWindowIR::Rectangular, 5_000_000, 2)
                .unwrap(),
            (1.0, 1.0),
        );
    }

    #[test]
    fn unitary_discrete_spectrum_obeys_parseval() {
        let request = request("x");
        let field = (0..16)
            .map(|index| [index as f64 - 7.5, 0.0, 0.0])
            .collect::<Vec<_>>();
        let result = compute_structured_antenna_source_spectrum(&request, &field, None).unwrap();
        let input_power = field.iter().map(|value| value[0] * value[0]).sum::<f64>();
        let output_power = result.power.iter().sum::<f64>();

        assert!((output_power - input_power).abs() < 1.0e-12);
    }

    #[test]
    fn integral_si_scaling_matches_unitary_discrete_scaling() {
        let mut unitary_request = request("x");
        let field = (0..16)
            .map(|index| [index as f64 - 7.5, 0.0, 0.0])
            .collect::<Vec<_>>();
        let unitary =
            compute_structured_antenna_source_spectrum(&unitary_request, &field, None).unwrap();

        unitary_request.normalization = AntennaSpectrumNormalizationIR::IntegralSi;
        let integral =
            compute_structured_antenna_source_spectrum(&unitary_request, &field, None).unwrap();
        let ratio = request("x").sampling_plane.extent_u_m
            / (request("x").sampling_plane.sample_count_u as f64 - 1.0)
            * request("x").sampling_plane.extent_v_m
            / (request("x").sampling_plane.sample_count_v as f64 - 1.0)
            * (16.0_f64).sqrt();

        for (unitary, integral) in unitary
            .amplitudes_re_im
            .iter()
            .zip(&integral.amplitudes_re_im)
        {
            assert!((integral[0] - ratio * unitary[0]).abs() < 1.0e-12);
            assert!((integral[1] - ratio * unitary[1]).abs() < 1.0e-12);
        }
    }
}
