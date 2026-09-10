use fullmag_ir::{
    AntennaSpectrumNormalizationIR, AntennaSpectrumRequestIR, AntennaSpectrumTransformIR,
    AntennaSpectrumWindowIR,
};
use num_complex::Complex64;
use rustfft::FftPlanner;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

use crate::antenna_field_solution::AntennaFieldSolutionSamples;
use crate::types::AuxiliaryArtifact;
use crate::types::RunError;

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

fn sha256_u64(values: &[u64]) -> String {
    let mut bytes = Vec::with_capacity(values.len() * std::mem::size_of::<u64>());
    for value in values {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    sha256_bytes(&bytes)
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

fn coordinate_scale(
    request: &AntennaSpectrumRequestIR,
    samples: &AntennaFieldSolutionSamples,
) -> f64 {
    request
        .sampling_plane
        .origin_m
        .into_iter()
        .chain(request.sampling_plane.axis_u)
        .chain(request.sampling_plane.axis_v)
        .chain([
            request.sampling_plane.extent_u_m,
            request.sampling_plane.extent_v_m,
        ])
        .chain(samples.sample_positions_xyz_m.iter().flatten().copied())
        .map(f64::abs)
        .fold(0.0_f64, f64::max)
        .max(f64::MIN_POSITIVE)
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

/// Sample the immutable source-field carrier on the declared centred plane.
///
/// The current asset revision stores nodal coordinates but no element/grid
/// topology.  Consequently this function performs only a bounded
/// identity-coordinate lookup (with a relative floating-point tolerance).  It
/// never substitutes a nearest node for a missing point and never broadcasts a
/// single field value over a target lattice.
pub fn sample_antenna_field_on_plane(
    request: &AntennaSpectrumRequestIR,
    samples: &AntennaFieldSolutionSamples,
) -> Result<AntennaSpectrumSampleGrid, RunError> {
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
    if count_u < 2 || count_v < 2 || sample_count > 10_000_000 {
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
    let tolerance_m = coordinate_scale(request, samples) * 1.0e-12;
    let (source_minimum, source_maximum) = source_bounds(&samples.sample_positions_xyz_m);
    let mut buckets: HashMap<[i64; 3], Vec<usize>> = HashMap::new();
    for (index, position) in samples.sample_positions_xyz_m.iter().copied().enumerate() {
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
    let sampled = sample_antenna_field_on_plane(request, samples)?;
    let spectrum = match request.transform {
        AntennaSpectrumTransformIR::SpatialFft => compute_structured_antenna_source_spectrum(
            request,
            &sampled.field_xyz_apm_per_a,
            equilibrium_samples,
        )?,
        AntennaSpectrumTransformIR::NonuniformSpatialFft => {
            compute_nonuniform_k_antenna_source_spectrum(
                request,
                &sampled.field_xyz_apm_per_a,
                equilibrium_samples,
            )?
        }
    };
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
        schema_version: "antenna_source_spectrum_artifact.v1".into(),
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
    let mut canonical = serde_json::to_value(&artifact).map_err(|serialization_error| {
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

/// Convert a source-spectrum result into the session artifact namespace.
pub fn antenna_source_spectrum_auxiliary_artifact(
    artifact: &AntennaSourceSpectrumArtifact,
) -> Result<AuxiliaryArtifact, RunError> {
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
    let bytes = serde_json::to_vec_pretty(artifact).map_err(|serialization_error| {
        error(format!(
            "serialize antenna source-spectrum artifact: {serialization_error}"
        ))
    })?;
    Ok(AuxiliaryArtifact {
        relative_path: format!(
            "antenna/source_spectra/{}/spectrum.v1.json",
            artifact.output_id
        ),
        bytes,
    })
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

fn fft2_in_place(values: &mut [Complex64], count_u: usize, count_v: usize) {
    let mut planner = FftPlanner::<f64>::new();
    let fft_u = planner.plan_fft_forward(count_u);
    for row in values.chunks_exact_mut(count_u) {
        fft_u.process(row);
    }
    let fft_v = planner.plan_fft_forward(count_v);
    let mut column = vec![Complex64::new(0.0, 0.0); count_v];
    for u in 0..count_u {
        for v in 0..count_v {
            column[v] = values[v * count_u + u];
        }
        fft_v.process(&mut column);
        for v in 0..count_v {
            values[v * count_u + u] = column[v];
        }
    }
}

fn centered_origin_phase(k_u: f64, k_v: f64, extent_u_m: f64, extent_v_m: f64) -> Complex64 {
    Complex64::from_polar(1.0, 0.5 * (k_u * extent_u_m + k_v * extent_v_m))
}

/// Compute the source-field spectrum after a separate carrier interpolation
/// step has produced the exact authored uniform plane lattice.
pub fn compute_structured_antenna_source_spectrum(
    request: &AntennaSpectrumRequestIR,
    field_samples_apm_per_a: &[[f64; 3]],
    equilibrium_samples: Option<&[[f64; 3]]>,
) -> Result<AntennaSourceSpectrum2D, RunError> {
    if request.transform != AntennaSpectrumTransformIR::SpatialFft {
        return Err(error(
            "structured antenna FFT kernel requires transform='spatial_fft'",
        ));
    }
    let count_u = request.sampling_plane.sample_count_u as usize;
    let count_v = request.sampling_plane.sample_count_v as usize;
    let sample_count = count_u
        .checked_mul(count_v)
        .ok_or_else(|| error("antenna spectrum sample count overflows"))?;
    if field_samples_apm_per_a.len() != sample_count
        || field_samples_apm_per_a
            .iter()
            .flatten()
            .any(|value| !value.is_finite())
    {
        return Err(error(
            "antenna spectrum field samples are non-finite or have the wrong count",
        ));
    }
    let spacing_u = request.sampling_plane.extent_u_m / (count_u - 1) as f64;
    let spacing_v = request.sampling_plane.extent_v_m / (count_v - 1) as f64;
    if !spacing_u.is_finite() || !spacing_v.is_finite() || spacing_u <= 0.0 || spacing_v <= 0.0 {
        return Err(error(
            "antenna spectrum plane spacing must be finite and positive",
        ));
    }
    let window_u = window_values(&request.window, count_u);
    let window_v = window_values(&request.window, count_v);
    let window_sum = window_u.iter().sum::<f64>() * window_v.iter().sum::<f64>();
    let window_square_sum = window_u.iter().map(|value| value * value).sum::<f64>()
        * window_v.iter().map(|value| value * value).sum::<f64>();
    if !window_sum.is_finite() || window_sum.abs() <= f64::EPSILON {
        return Err(error("antenna spectrum window has zero coherent gain"));
    }
    let coherent_gain = window_sum / sample_count as f64;
    let equivalent_noise_bandwidth_bins =
        sample_count as f64 * window_square_sum / (window_sum * window_sum);
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
        let mut transformed = component
            .into_iter()
            .enumerate()
            .map(|(index, value)| {
                let v = index / count_u;
                let u = index % count_u;
                Complex64::new(value * window_u[u] * window_v[v], 0.0)
            })
            .collect::<Vec<_>>();
        fft2_in_place(&mut transformed, count_u, count_v);
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
            power[index] += value.norm_sqr();
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
    if request.transform != AntennaSpectrumTransformIR::NonuniformSpatialFft {
        return Err(error(
            "nonuniform-k antenna spectrum kernel requires transform='nonuniform_spatial_fft'",
        ));
    }
    let grid = request
        .nonuniform_k_grid
        .as_ref()
        .ok_or_else(|| error("nonuniform antenna spectrum requires an explicit k grid"))?;
    let count_u = request.sampling_plane.sample_count_u as usize;
    let count_v = request.sampling_plane.sample_count_v as usize;
    let sample_count = count_u
        .checked_mul(count_v)
        .ok_or_else(|| error("antenna spectrum sample count overflows"))?;
    if field_samples_apm_per_a.len() != sample_count
        || field_samples_apm_per_a
            .iter()
            .flatten()
            .any(|value| !value.is_finite())
    {
        return Err(error(
            "antenna spectrum field samples are non-finite or have the wrong count",
        ));
    }
    let output_count = grid
        .k_u_rad_per_m
        .len()
        .checked_mul(grid.k_v_rad_per_m.len())
        .ok_or_else(|| error("antenna nonuniform k-grid size overflows"))?;
    let operation_count = sample_count
        .checked_mul(output_count)
        .ok_or_else(|| error("antenna nonuniform transform operation count overflows"))?;
    if operation_count > 100_000_000 {
        return Err(error(format!(
            "antenna direct nonuniform transform requires {operation_count} sample-k pairs; limit is 100000000"
        )));
    }
    let spacing_u = request.sampling_plane.extent_u_m / (count_u - 1) as f64;
    let spacing_v = request.sampling_plane.extent_v_m / (count_v - 1) as f64;
    let window_u = window_values(&request.window, count_u);
    let window_v = window_values(&request.window, count_v);
    let window_sum = window_u.iter().sum::<f64>() * window_v.iter().sum::<f64>();
    let window_square_sum = window_u.iter().map(|value| value * value).sum::<f64>()
        * window_v.iter().map(|value| value * value).sum::<f64>();
    if !window_sum.is_finite() || window_sum.abs() <= f64::EPSILON {
        return Err(error("antenna spectrum window has zero coherent gain"));
    }
    let coherent_gain = window_sum / sample_count as f64;
    let equivalent_noise_bandwidth_bins =
        sample_count as f64 * window_square_sum / (window_sum * window_sum);
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
                    let coordinate_v =
                        -0.5 * request.sampling_plane.extent_v_m + v as f64 * spacing_v;
                    for u in 0..count_u {
                        let coordinate_u =
                            -0.5 * request.sampling_plane.extent_u_m + u as f64 * spacing_u;
                        let phase = -(k_u * coordinate_u + k_v * coordinate_v);
                        amplitude += Complex64::from_polar(
                            component[v * count_u + u] * window_u[u] * window_v[v],
                            phase,
                        );
                    }
                }
                let amplitude = amplitude * scale;
                let output_index = amplitudes.len() % output_count;
                power[output_index] += amplitude.norm_sqr();
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
        let mut structured_request = request("x");
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
        let structured =
            compute_structured_antenna_source_spectrum(&structured_request, &field, None).unwrap();

        structured_request.transform = AntennaSpectrumTransformIR::NonuniformSpatialFft;
        structured_request.nonuniform_k_grid = Some(fullmag_ir::AntennaSpectrumKGridIR {
            k_u_rad_per_m: structured.k_u_rad_per_m.clone(),
            k_v_rad_per_m: structured.k_v_rad_per_m.clone(),
        });
        let direct =
            compute_nonuniform_k_antenna_source_spectrum(&structured_request, &field, None)
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
        let payload = antenna_source_spectrum_auxiliary_artifact(&artifact).unwrap();
        assert_eq!(
            payload.relative_path,
            "antenna/source_spectra/spectrum/spectrum.v1.json"
        );
        let json: serde_json::Value = serde_json::from_slice(&payload.bytes).unwrap();
        assert_eq!(
            json["schema_version"],
            "antenna_source_spectrum_artifact.v1"
        );
        assert_eq!(json["sampling"]["outside_count"], 0);
    }
}
