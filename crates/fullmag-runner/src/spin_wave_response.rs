//! Bounded, unit-aware time-domain spin-wave response analysis.

use fullmag_ir::{
    BackendPlanIR, DriveActivationIR, ExecutionPlanIR, FieldSpatialProfileIR, FieldTargetIR,
    FieldTimeOriginIR, ProblemIR, RegionalFieldDriveIR,
};
use num_complex::Complex64;
use rustfft::FftPlanner;
use serde::{Deserialize, Serialize};

use crate::types::{AuxiliaryArtifact, ExecutedRun, RunError};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SpectrumPeak {
    pub index: usize,
    pub frequency_hz: f64,
    pub power: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SpinWaveResponseArtifact {
    pub schema_version: String,
    pub time_unit: String,
    pub frequency_unit: String,
    pub trace_unit: String,
    pub source_unit: String,
    pub susceptibility_unit: String,
    pub weighting: String,
    pub detrend: String,
    pub window: String,
    pub normalization: String,
    pub reference_m0: f64,
    pub reference_m0_secondary: f64,
    pub response_component: String,
    pub transverse_components: [String; 2],
    pub time_s: Vec<f64>,
    pub response_trace: Vec<f64>,
    pub secondary_response_trace: Vec<f64>,
    pub source_trace: Vec<f64>,
    pub frequency_hz: Vec<f64>,
    pub response_psd: Vec<f64>,
    pub primary_response_psd: Vec<f64>,
    pub secondary_response_psd: Vec<f64>,
    pub source_psd: Vec<f64>,
    pub response_spectrum_real: Vec<f64>,
    pub response_spectrum_imag: Vec<f64>,
    pub secondary_response_spectrum_real: Vec<f64>,
    pub secondary_response_spectrum_imag: Vec<f64>,
    pub source_spectrum_real: Vec<f64>,
    pub source_spectrum_imag: Vec<f64>,
    pub window_values: Vec<f64>,
    pub window_power_sum: f64,
    pub nyquist_hz: f64,
    pub susceptibility_abs: Vec<Option<f64>>,
    pub peaks: Vec<SpectrumPeak>,
}

pub fn moment_weighted_component(
    vectors: &[[f64; 3]],
    moment_weights: &[f64],
    component: usize,
) -> Result<f64, String> {
    if vectors.len() != moment_weights.len() || component >= 3 || vectors.is_empty() {
        return Err(
            "weighted component requires equal non-empty vectors/weights and component < 3".into(),
        );
    }
    let denominator: f64 = moment_weights.iter().sum();
    if !denominator.is_finite() || denominator <= 0.0 {
        return Err("moment weights must have a finite positive sum".into());
    }
    Ok(vectors
        .iter()
        .zip(moment_weights)
        .map(|(vector, weight)| vector[component] * weight)
        .sum::<f64>()
        / denominator)
}

pub fn build_gamma_response(
    time_s: &[f64],
    response_trace: &[f64],
    source_trace: &[f64],
    susceptibility_floor_fraction: f64,
) -> Result<SpinWaveResponseArtifact, String> {
    build_gamma_response_with_detrend(
        time_s,
        response_trace,
        source_trace,
        susceptibility_floor_fraction,
        "linear",
    )
}

pub fn build_gamma_response_with_detrend(
    time_s: &[f64],
    response_trace: &[f64],
    source_trace: &[f64],
    susceptibility_floor_fraction: f64,
    detrend: &str,
) -> Result<SpinWaveResponseArtifact, String> {
    validate_uniform_trace(time_s, response_trace, source_trace)?;
    let window_values = hann_window(time_s.len());
    let response_conditioned = apply_window(
        &condition_trace(time_s, response_trace, detrend)?,
        &window_values,
    );
    let source_conditioned = apply_window(
        &condition_trace(time_s, source_trace, detrend)?,
        &window_values,
    );
    let dt = time_s[1] - time_s[0];
    let response_fft = one_sided_fft(&response_conditioned);
    let source_fft = one_sided_fft(&source_conditioned);
    let frequency_hz = (0..response_fft.len())
        .map(|index| index as f64 / (time_s.len() as f64 * dt))
        .collect::<Vec<_>>();
    let window_power_sum = window_values.iter().map(|value| value * value).sum::<f64>();
    let normalization = time_s.len() as f64 * window_power_sum;
    let response_psd = response_fft
        .iter()
        .enumerate()
        .map(|(index, value)| {
            one_sided_factor(index, time_s.len()) * value.norm_sqr() / normalization
        })
        .collect::<Vec<_>>();
    let source_psd = source_fft
        .iter()
        .enumerate()
        .map(|(index, value)| {
            one_sided_factor(index, time_s.len()) * value.norm_sqr() / normalization
        })
        .collect::<Vec<_>>();
    let source_max = source_fft
        .iter()
        .map(|value| value.norm())
        .fold(0.0, f64::max);
    let floor = source_max * susceptibility_floor_fraction.max(0.0);
    let susceptibility_abs = response_fft
        .iter()
        .zip(&source_fft)
        .map(|(response, source)| {
            (source.norm() > floor && source.norm() > 0.0).then_some((*response / *source).norm())
        })
        .collect();
    let peaks = spectrum_peaks(&frequency_hz, &response_psd);

    Ok(SpinWaveResponseArtifact {
        schema_version: "spin_wave_response.gamma.v1".into(),
        time_unit: "s".into(),
        frequency_unit: "Hz".into(),
        trace_unit: "1".into(),
        source_unit: "A/m".into(),
        susceptibility_unit: "m/A".into(),
        weighting: "Ms_times_lumped_volume".into(),
        detrend: detrend.into(),
        window: "hann".into(),
        normalization: "one_sided_abs_fft_squared_over_N_sum_window_squared".into(),
        reference_m0: 0.0,
        reference_m0_secondary: 0.0,
        response_component: "configured".into(),
        transverse_components: ["configured".into(), "none".into()],
        time_s: time_s.to_vec(),
        response_trace: response_trace.to_vec(),
        secondary_response_trace: vec![0.0; time_s.len()],
        source_trace: source_trace.to_vec(),
        frequency_hz,
        primary_response_psd: response_psd.clone(),
        secondary_response_psd: vec![0.0; response_psd.len()],
        response_psd,
        source_psd,
        response_spectrum_real: response_fft.iter().map(|value| value.re).collect(),
        response_spectrum_imag: response_fft.iter().map(|value| -value.im).collect(),
        secondary_response_spectrum_real: vec![0.0; response_fft.len()],
        secondary_response_spectrum_imag: vec![0.0; response_fft.len()],
        source_spectrum_real: source_fft.iter().map(|value| value.re).collect(),
        source_spectrum_imag: source_fft.iter().map(|value| -value.im).collect(),
        window_values,
        window_power_sum,
        nyquist_hz: 0.5 / dt,
        susceptibility_abs,
        peaks,
    })
}

pub fn build_gamma_transverse_response_with_detrend(
    time_s: &[f64],
    primary_trace: &[f64],
    secondary_trace: &[f64],
    source_trace: &[f64],
    susceptibility_floor_fraction: f64,
    detrend: &str,
) -> Result<SpinWaveResponseArtifact, String> {
    validate_uniform_trace(time_s, secondary_trace, source_trace)?;
    let mut artifact = build_gamma_response_with_detrend(
        time_s,
        primary_trace,
        source_trace,
        susceptibility_floor_fraction,
        detrend,
    )?;
    let secondary_conditioned = apply_window(
        &condition_trace(time_s, secondary_trace, detrend)?,
        &artifact.window_values,
    );
    let secondary_fft = one_sided_fft(&secondary_conditioned);
    let normalization = time_s.len() as f64 * artifact.window_power_sum;
    let secondary_psd = secondary_fft
        .iter()
        .enumerate()
        .map(|(index, value)| {
            one_sided_factor(index, time_s.len()) * value.norm_sqr() / normalization
        })
        .collect::<Vec<_>>();
    artifact.secondary_response_trace = secondary_trace.to_vec();
    artifact.secondary_response_spectrum_real =
        secondary_fft.iter().map(|value| value.re).collect();
    artifact.secondary_response_spectrum_imag =
        secondary_fft.iter().map(|value| -value.im).collect();
    artifact.secondary_response_psd = secondary_psd.clone();
    artifact
        .response_psd
        .iter_mut()
        .zip(secondary_psd)
        .for_each(|(sum, secondary)| *sum += secondary);
    artifact.peaks = spectrum_peaks(&artifact.frequency_hz, &artifact.response_psd);
    Ok(artifact)
}

fn spectrum_peaks(frequency_hz: &[f64], response_psd: &[f64]) -> Vec<SpectrumPeak> {
    let mut peaks = response_psd
        .iter()
        .enumerate()
        .skip(1)
        .filter(|(index, power)| {
            *index + 1 < response_psd.len()
                && **power > response_psd[*index - 1]
                && **power >= response_psd[*index + 1]
        })
        .map(|(index, power)| SpectrumPeak {
            index,
            frequency_hz: frequency_hz[index],
            power: *power,
        })
        .collect::<Vec<_>>();
    peaks.sort_by(|left, right| right.power.total_cmp(&left.power));
    peaks.truncate(32);
    peaks
}

pub(crate) fn append_requested_spin_wave_artifacts(
    problem: &ProblemIR,
    plan: &ExecutionPlanIR,
    executed: &mut ExecutedRun,
) -> Result<(), RunError> {
    let Some(request) = problem
        .problem_meta
        .runtime_metadata
        .get("spin_wave_response")
    else {
        return Ok(());
    };
    if request.get("analysis").and_then(serde_json::Value::as_str) != Some("gamma") {
        return Ok(());
    }
    let component = match request
        .get("response_component")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("my")
    {
        "my" => 1,
        "mz" => 2,
        value => return Err(run_error(format!("unsupported Γ response_component '{value}'; expected my or mz so S_Gamma uses both transverse components"))),
    };
    let secondary_component = if component == 1 { 2 } else { 1 };
    let (drives, stage_start_time_s, active_stage_id, reference_m0, reference_m0_secondary) =
        match &plan.backend_plan {
            BackendPlanIR::Fem(fem) => (
                fem.field_drives.as_slice(),
                fem.time_stage.start_time_s,
                fem.time_stage.active_stage_id.as_deref(),
                fem_initial_component(fem, component)?,
                fem_initial_component(fem, secondary_component)?,
            ),
            BackendPlanIR::Fdm(fdm) => (
                fdm.field_drives.as_slice(),
                fdm.time_stage.start_time_s,
                fdm.time_stage.active_stage_id.as_deref(),
                fdm_initial_component(fdm, component)?,
                fdm_initial_component(fdm, secondary_component)?,
            ),
            _ => {
                return Err(run_error(
                    "Γ time-domain analysis requires an FDM or FEM time-evolution plan",
                ))
            }
        };
    let active_drives = drives
        .iter()
        .filter(|drive| drive.enabled && drive_is_active(drive, active_stage_id))
        .collect::<Vec<_>>();
    if active_drives.is_empty() {
        return Ok(());
    }
    if active_drives.iter().any(|drive| {
        !matches!(drive.target, FieldTargetIR::Global {})
            || !matches!(drive.spatial_profile, FieldSpatialProfileIR::Uniform {})
    }) {
        return Err(run_error(
            "Γ analysis currently requires global targets with uniform spatial profiles; use finite-k analysis for localized sources",
        ));
    }
    let time_s = executed
        .result
        .steps
        .iter()
        .map(|step| step.time)
        .collect::<Vec<_>>();
    let raw_response = executed
        .result
        .steps
        .iter()
        .map(|step| [step.mx, step.my, step.mz][component])
        .collect::<Vec<_>>();
    if raw_response.len() < 4 {
        return Err(run_error(
            "Γ analysis requires at least four accepted time samples",
        ));
    }
    let response = raw_response
        .iter()
        .map(|value| value - reference_m0)
        .collect::<Vec<_>>();
    let secondary_response = executed
        .result
        .steps
        .iter()
        .map(|step| [step.mx, step.my, step.mz][secondary_component] - reference_m0_secondary)
        .collect::<Vec<_>>();
    let source = time_s
        .iter()
        .map(|time| {
            active_drives
                .iter()
                .map(|drive| {
                    let evaluation_time = match drive.time_origin {
                        FieldTimeOriginIR::StageLocal => *time - stage_start_time_s,
                        FieldTimeOriginIR::Absolute => *time,
                    };
                    drive.amplitude_b_t / crate::MU0
                        * crate::time_dependence::evaluate_time_dependence(
                            &drive.waveform,
                            evaluation_time,
                        )
                })
                .sum::<f64>()
        })
        .collect::<Vec<_>>();
    let floor = request
        .get("susceptibility_floor_fraction")
        .and_then(serde_json::Value::as_f64)
        .unwrap_or(1e-6);
    let detrend = request
        .get("detrend")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("none");
    let mut artifact = build_gamma_transverse_response_with_detrend(
        &time_s,
        &response,
        &secondary_response,
        &source,
        floor,
        detrend,
    )
    .map_err(|message| run_error(format!("Γ response analysis failed: {message}")))?;
    artifact.reference_m0 = reference_m0;
    artifact.reference_m0_secondary = reference_m0_secondary;
    artifact.response_component = if component == 1 { "my" } else { "mz" }.into();
    artifact.transverse_components = if component == 1 {
        ["my".into(), "mz".into()]
    } else {
        ["mz".into(), "my".into()]
    };
    let mut bytes = serde_json::to_vec_pretty(&artifact)
        .map_err(|error| run_error(format!("failed to serialize Γ response artifact: {error}")))?;
    bytes.push(b'\n');
    executed.auxiliary_artifacts.push(AuxiliaryArtifact {
        relative_path: "analysis/spin_wave_response.gamma.v1.json".into(),
        bytes,
    });
    Ok(())
}

fn drive_is_active(drive: &RegionalFieldDriveIR, active_stage_id: Option<&str>) -> bool {
    match &drive.activation {
        DriveActivationIR::AllTimeEvolution {} => true,
        DriveActivationIR::StageIds { stage_ids } => active_stage_id
            .is_some_and(|active| stage_ids.iter().any(|stage_id| stage_id == active)),
    }
}

fn fem_initial_component(plan: &fullmag_ir::FemPlanIR, component: usize) -> Result<f64, RunError> {
    let nodal_volumes = fem_lumped_node_volumes(&plan.mesh);
    let weights = nodal_volumes
        .iter()
        .enumerate()
        .map(|(node, volume)| {
            volume
                * plan
                    .material
                    .ms_field
                    .as_ref()
                    .map_or(plan.material.saturation_magnetisation, |field| field[node])
        })
        .collect::<Vec<_>>();
    moment_weighted_component(&plan.initial_magnetization, &weights, component).map_err(run_error)
}

fn fem_lumped_node_volumes(mesh: &fullmag_ir::MeshIR) -> Vec<f64> {
    let mut nodal_volumes = vec![0.0; mesh.nodes.len()];
    let elements = mesh.require_tet4_elements().expect(
        "finite-k FEM response requires tet4 cells; mixed-cell runtime support is unavailable",
    );
    for (element_index, element) in elements.iter().enumerate() {
        if !mesh.element_markers.is_empty()
            && mesh
                .element_markers
                .get(element_index)
                .copied()
                .unwrap_or(0)
                == 0
        {
            continue;
        }
        let [a, b, c, d] = element.map(|node| mesh.nodes[node as usize]);
        let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let ad = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
        let volume = (ab[0] * (ac[1] * ad[2] - ac[2] * ad[1])
            - ab[1] * (ac[0] * ad[2] - ac[2] * ad[0])
            + ab[2] * (ac[0] * ad[1] - ac[1] * ad[0]))
            .abs()
            / 6.0;
        for node in element {
            nodal_volumes[*node as usize] += volume / 4.0;
        }
    }
    nodal_volumes
}

fn fdm_initial_component(plan: &fullmag_ir::FdmPlanIR, component: usize) -> Result<f64, RunError> {
    let weights = plan
        .initial_magnetization
        .iter()
        .enumerate()
        .map(|(index, _)| {
            if plan.active_mask.as_ref().is_some_and(|mask| !mask[index]) {
                0.0
            } else {
                plan.material
                    .ms_field
                    .as_ref()
                    .map_or(plan.material.saturation_magnetisation, |field| field[index])
            }
        })
        .collect::<Vec<_>>();
    moment_weighted_component(&plan.initial_magnetization, &weights, component).map_err(run_error)
}

fn run_error(message: impl Into<String>) -> RunError {
    RunError {
        message: message.into(),
    }
}

fn validate_uniform_trace(time_s: &[f64], response: &[f64], source: &[f64]) -> Result<(), String> {
    if time_s.len() < 4 || time_s.len() != response.len() || response.len() != source.len() {
        return Err("time, response, and source traces must have the same length >= 4".into());
    }
    if response
        .iter()
        .chain(source)
        .any(|value| !value.is_finite())
    {
        return Err("response and source samples must be finite".into());
    }
    let dt = time_s[1] - time_s[0];
    if !dt.is_finite() || dt <= 0.0 {
        return Err("time samples must be finite and strictly increasing".into());
    }
    let tolerance = dt.abs() * 1e-9 + f64::EPSILON;
    if time_s.windows(2).any(|pair| {
        !pair[0].is_finite() || !pair[1].is_finite() || ((pair[1] - pair[0]) - dt).abs() > tolerance
    }) {
        return Err("FFT input requires a uniformly sampled time axis".into());
    }
    Ok(())
}

fn detrend_linear(time_s: &[f64], values: &[f64]) -> Vec<f64> {
    let n = values.len() as f64;
    let mean_t = time_s.iter().sum::<f64>() / n;
    let mean_y = values.iter().sum::<f64>() / n;
    let variance_t = time_s
        .iter()
        .map(|time| (time - mean_t).powi(2))
        .sum::<f64>();
    let slope = if variance_t > 0.0 {
        time_s
            .iter()
            .zip(values)
            .map(|(time, value)| (time - mean_t) * (value - mean_y))
            .sum::<f64>()
            / variance_t
    } else {
        0.0
    };
    time_s
        .iter()
        .zip(values)
        .map(|(time, value)| value - (mean_y + slope * (time - mean_t)))
        .collect()
}

fn condition_trace(time_s: &[f64], values: &[f64], detrend: &str) -> Result<Vec<f64>, String> {
    match detrend {
        "none" => Ok(values.to_vec()),
        "mean" => {
            let mean = values.iter().sum::<f64>() / values.len() as f64;
            Ok(values.iter().map(|value| value - mean).collect())
        }
        "linear" => Ok(detrend_linear(time_s, values)),
        value => Err(format!(
            "unsupported detrend policy '{value}'; expected none, mean, or linear"
        )),
    }
}

fn hann_window(length: usize) -> Vec<f64> {
    let denominator = (length - 1) as f64;
    (0..length)
        .map(|index| 0.5 * (1.0 - (2.0 * std::f64::consts::PI * index as f64 / denominator).cos()))
        .collect()
}

fn apply_window(values: &[f64], window: &[f64]) -> Vec<f64> {
    values
        .iter()
        .zip(window)
        .map(|(value, window)| value * window)
        .collect()
}

fn one_sided_factor(index: usize, length: usize) -> f64 {
    if index == 0 || (length % 2 == 0 && index == length / 2) {
        1.0
    } else {
        2.0
    }
}

fn one_sided_fft(values: &[f64]) -> Vec<Complex64> {
    let mut buffer = values
        .iter()
        .map(|value| Complex64::new(*value, 0.0))
        .collect::<Vec<_>>();
    FftPlanner::<f64>::new()
        .plan_fft_forward(buffer.len())
        .process(&mut buffer);
    buffer.truncate(values.len() / 2 + 1);
    buffer
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weighted_average_uses_magnetic_moment_weights() {
        let value =
            moment_weighted_component(&[[1.0, 0.0, 0.0], [3.0, 0.0, 0.0]], &[1.0, 3.0], 0).unwrap();
        assert_eq!(value, 2.5);
    }

    #[test]
    fn p1_lumped_volume_excludes_air_elements() {
        let mesh = fullmag_ir::MeshIR {
            mesh_name: "two-tetra".into(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [0.0, 0.0, 2.0],
            ],
            cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [0, 1, 2, 4]]),
            element_markers: vec![1, 0],
            facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![]),
            boundary_markers: vec![],
            periodic_boundary_pairs: vec![],
            periodic_node_pairs: vec![],
            per_domain_quality: std::collections::HashMap::new(),
        };
        let weights = fem_lumped_node_volumes(&mesh);
        for weight in &weights[..4] {
            assert!((*weight - 1.0 / 24.0).abs() < 1e-15);
        }
        assert_eq!(weights[4], 0.0);
    }

    #[test]
    fn gamma_fft_finds_known_frequency_and_masks_zero_source_bins() {
        let n = 256;
        let dt = 1e-12;
        let bin = 13;
        let frequency = bin as f64 / (n as f64 * dt);
        let time = (0..n).map(|index| index as f64 * dt).collect::<Vec<_>>();
        let source = time
            .iter()
            .map(|time| (2.0 * std::f64::consts::PI * frequency * time).sin())
            .collect::<Vec<_>>();
        let response = source
            .iter()
            .map(|value| 2.0 * value + 0.01)
            .collect::<Vec<_>>();
        let artifact = build_gamma_response(&time, &response, &source, 1e-6).unwrap();
        assert!((artifact.peaks[0].frequency_hz - frequency).abs() < 1e-6 * frequency);
        assert!((artifact.susceptibility_abs[bin].unwrap() - 2.0).abs() < 1e-10);
        assert!(artifact.susceptibility_abs.iter().any(Option::is_none));
        let detrended = detrend_linear(&time, &response);
        let windowed = apply_window(&detrended, &artifact.window_values);
        let expected_power =
            windowed.iter().map(|value| value * value).sum::<f64>() / artifact.window_power_sum;
        assert!((artifact.response_psd.iter().sum::<f64>() - expected_power).abs() < 1e-12);
        assert_eq!(
            artifact.normalization,
            "one_sided_abs_fft_squared_over_N_sum_window_squared"
        );
    }

    #[test]
    fn gamma_structure_factor_sums_both_transverse_psds() {
        let n = 128;
        let time = (0..n).map(|index| index as f64 * 1e-12).collect::<Vec<_>>();
        let source = time
            .iter()
            .map(|time| (2.0 * std::f64::consts::PI * 8.0e9 * time).sin())
            .collect::<Vec<_>>();
        let primary = source.clone();
        let secondary = source.iter().map(|value| 2.0 * value).collect::<Vec<_>>();
        let artifact = build_gamma_transverse_response_with_detrend(
            &time, &primary, &secondary, &source, 1e-6, "none",
        )
        .unwrap();
        for index in 0..artifact.response_psd.len() {
            let expected =
                artifact.primary_response_psd[index] + artifact.secondary_response_psd[index];
            assert!(
                (artifact.response_psd[index] - expected).abs() <= expected.abs() * 1e-14 + 1e-30
            );
        }
    }

    #[test]
    fn detrend_policy_is_explicit_and_fail_closed() {
        let time = [0.0, 1.0, 2.0, 3.0];
        let values = [3.0, 4.0, 5.0, 6.0];
        assert_eq!(condition_trace(&time, &values, "none").unwrap(), values);
        assert!(
            condition_trace(&time, &values, "mean")
                .unwrap()
                .iter()
                .sum::<f64>()
                .abs()
                < 1e-15
        );
        assert!(condition_trace(&time, &values, "linear")
            .unwrap()
            .iter()
            .all(|value| value.abs() < 1e-15));
        assert!(condition_trace(&time, &values, "mystery").is_err());
    }
}
