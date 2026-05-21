use nalgebra::{DMatrix, DVector};
use num_complex::Complex64;
use serde::Serialize;
use std::collections::BTreeMap;

const BLOCK_REAL_MATRIX_LAYOUT: &str = "block_real";

#[derive(Clone, Debug)]
pub struct BlockRealHarmonicSystem {
    pub stiffness: DMatrix<f64>,
    pub mass: DMatrix<f64>,
    pub damping: Option<DMatrix<f64>>,
    pub omega_rad_per_s: f64,
}

#[derive(Clone, Debug)]
pub struct BlockRealHarmonicTemplate {
    pub stiffness: DMatrix<f64>,
    pub mass: DMatrix<f64>,
    pub damping: Option<DMatrix<f64>>,
}

#[derive(Clone, Debug)]
pub struct BlockRealHarmonicSolution {
    pub frequency_rad_per_s: f64,
    pub response: DVector<Complex64>,
    pub residual_l2_norm: f64,
    pub relative_residual_l2_norm: f64,
    pub block_dimension: usize,
    pub matrix_layout: &'static str,
}

#[derive(Clone, Debug, Serialize)]
pub struct BlockRealWarmStartProvenance {
    pub kind: &'static str,
    pub source_frequency_rad_per_s: f64,
    pub residual_l2_norm: f64,
    pub relative_residual_l2_norm: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct BlockRealSweepReuseProvenance {
    pub operator_template_reused: bool,
    pub warm_start: Option<BlockRealWarmStartProvenance>,
}

#[derive(Clone, Debug, Serialize)]
pub struct FieldDrivenResponseSweepArtifact {
    pub schema_version: &'static str,
    pub backend_engine_id: String,
    pub solver_model: String,
    pub damping_policy: String,
    pub lane_classification: String,
    pub matrix_layout: &'static str,
    pub excitation_kind: &'static str,
    pub si_units: BTreeMap<&'static str, &'static str>,
    pub point_count: usize,
    pub points: Vec<FieldDrivenResponseSweepPointArtifact>,
}

#[derive(Clone, Debug, Serialize)]
pub struct FieldDrivenResponseSweepPointArtifact {
    pub frequency_hz: f64,
    pub angular_frequency_rad_per_s: f64,
    pub m_complex: Vec<[f64; 2]>,
    pub response_amplitude: Vec<f64>,
    pub response_phase: Vec<f64>,
    pub susceptibility_tensor: Vec<Vec<[f64; 2]>>,
    pub absorbed_power_density: f64,
    pub residual_l2_norm: f64,
    pub relative_residual_l2_norm: f64,
    pub tangent_leakage: TangentLeakageDiagnosticArtifact,
    pub excitation_provenance: ResponseExcitationProvenanceArtifact,
    pub sweep_reuse: BlockRealSweepReuseProvenance,
}

#[derive(Clone, Debug, Serialize)]
pub struct TangentLeakageDiagnosticArtifact {
    pub kind: &'static str,
    pub l2_norm: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ResponseExcitationProvenanceArtifact {
    pub kind: &'static str,
}

#[derive(Clone, Debug)]
pub struct FieldDrivenBlockRealResponsePoint {
    pub frequency_rad_per_s: f64,
    pub response: DVector<Complex64>,
    pub amplitude: DVector<f64>,
    pub phase_radians: DVector<f64>,
    pub absorbed_power_density: f64,
    pub susceptibility: Complex64,
    pub residual_l2_norm: f64,
    pub relative_residual_l2_norm: f64,
    pub block_dimension: usize,
    pub matrix_layout: &'static str,
    pub excitation_kind: &'static str,
    pub sweep_reuse: BlockRealSweepReuseProvenance,
}

pub fn solve_field_driven_block_real_sweep(
    template: &BlockRealHarmonicTemplate,
    frequencies_rad_per_s: &[f64],
    field_excitation: &DVector<Complex64>,
) -> Result<Vec<FieldDrivenBlockRealResponsePoint>, String> {
    if frequencies_rad_per_s.is_empty() {
        return Err("frequency sweep must include at least one point".to_string());
    }
    if frequencies_rad_per_s
        .iter()
        .any(|frequency| !frequency.is_finite() || *frequency <= 0.0)
    {
        return Err("frequency sweep values must be finite and positive".to_string());
    }

    let mut previous_solution: Option<BlockRealHarmonicSolution> = None;
    let mut response_points = Vec::with_capacity(frequencies_rad_per_s.len());

    for frequency_rad_per_s in frequencies_rad_per_s {
        let system = BlockRealHarmonicSystem {
            stiffness: template.stiffness.clone(),
            mass: template.mass.clone(),
            damping: template.damping.clone(),
            omega_rad_per_s: *frequency_rad_per_s,
        };
        let warm_start = previous_solution
            .as_ref()
            .map(|previous| warm_start_provenance(&system, field_excitation, previous))
            .transpose()?;
        let solution = solve_block_real_harmonic_response(&system, field_excitation)?;
        let sweep_reuse = BlockRealSweepReuseProvenance {
            operator_template_reused: true,
            warm_start,
        };
        previous_solution = Some(solution.clone());
        response_points.push(field_driven_response_point(
            field_excitation,
            solution,
            sweep_reuse,
        ));
    }

    Ok(response_points)
}

pub fn build_field_driven_response_sweep_artifact(
    points: &[FieldDrivenBlockRealResponsePoint],
    backend_engine_id: &str,
    solver_model: &str,
    damping_policy: &str,
    lane_classification: &str,
) -> FieldDrivenResponseSweepArtifact {
    FieldDrivenResponseSweepArtifact {
        schema_version: "magnetic_response_sweep.v1",
        backend_engine_id: backend_engine_id.to_string(),
        solver_model: solver_model.to_string(),
        damping_policy: damping_policy.to_string(),
        lane_classification: lane_classification.to_string(),
        matrix_layout: BLOCK_REAL_MATRIX_LAYOUT,
        excitation_kind: "field",
        si_units: response_sweep_si_units(),
        point_count: points.len(),
        points: points
            .iter()
            .map(field_driven_response_sweep_point_artifact)
            .collect(),
    }
}

pub fn solve_block_real_harmonic_response(
    system: &BlockRealHarmonicSystem,
    excitation: &DVector<Complex64>,
) -> Result<BlockRealHarmonicSolution, String> {
    let (real, imag) = assemble_complex_harmonic_operator(system)?;
    let dimension = real.nrows();
    if excitation.len() != dimension {
        return Err(format!(
            "harmonic excitation dimension {} does not match operator dimension {}",
            excitation.len(),
            dimension,
        ));
    }
    validate_complex_vector("harmonic excitation", excitation)?;

    let mut block = DMatrix::<f64>::zeros(dimension * 2, dimension * 2);
    for row in 0..dimension {
        for col in 0..dimension {
            block[(row, col)] = real[(row, col)];
            block[(row, col + dimension)] = -imag[(row, col)];
            block[(row + dimension, col)] = imag[(row, col)];
            block[(row + dimension, col + dimension)] = real[(row, col)];
        }
    }

    let mut rhs = DVector::<f64>::zeros(dimension * 2);
    for index in 0..dimension {
        rhs[index] = excitation[index].re;
        rhs[index + dimension] = excitation[index].im;
    }

    let solution = block
        .lu()
        .solve(&rhs)
        .ok_or_else(|| "block-real harmonic operator is singular".to_string())?;
    let response = DVector::from_iterator(
        dimension,
        (0..dimension).map(|index| Complex64::new(solution[index], solution[index + dimension])),
    );
    let (residual_l2_norm, relative_residual_l2_norm) =
        response_residual_norms(&real, &imag, excitation, &response);

    Ok(BlockRealHarmonicSolution {
        frequency_rad_per_s: system.omega_rad_per_s,
        response,
        residual_l2_norm,
        relative_residual_l2_norm,
        block_dimension: dimension * 2,
        matrix_layout: BLOCK_REAL_MATRIX_LAYOUT,
    })
}

fn field_driven_response_sweep_point_artifact(
    point: &FieldDrivenBlockRealResponsePoint,
) -> FieldDrivenResponseSweepPointArtifact {
    FieldDrivenResponseSweepPointArtifact {
        frequency_hz: point.frequency_rad_per_s / (2.0 * std::f64::consts::PI),
        angular_frequency_rad_per_s: point.frequency_rad_per_s,
        m_complex: complex_vector_pairs(&point.response),
        response_amplitude: point.amplitude.iter().copied().collect(),
        response_phase: point.phase_radians.iter().copied().collect(),
        susceptibility_tensor: vec![vec![complex_pair(point.susceptibility)]],
        absorbed_power_density: point.absorbed_power_density,
        residual_l2_norm: point.residual_l2_norm,
        relative_residual_l2_norm: point.relative_residual_l2_norm,
        tangent_leakage: TangentLeakageDiagnosticArtifact {
            kind: "not_evaluated_dense_validation",
            l2_norm: None,
        },
        excitation_provenance: ResponseExcitationProvenanceArtifact {
            kind: point.excitation_kind,
        },
        sweep_reuse: point.sweep_reuse.clone(),
    }
}

fn response_sweep_si_units() -> BTreeMap<&'static str, &'static str> {
    BTreeMap::from([
        ("frequency_hz", "Hz"),
        ("angular_frequency_rad_per_s", "rad/s"),
        ("m_complex", "normalized_magnetization"),
        ("response_amplitude", "normalized_magnetization"),
        ("response_phase", "rad"),
        ("susceptibility_tensor", "dimensionless"),
        ("absorbed_power_density", "W/m^3"),
        ("residual_l2_norm", "operator_l2"),
        ("relative_residual_l2_norm", "dimensionless"),
        ("tangent_leakage_l2_norm", "dimensionless"),
    ])
}

fn complex_vector_pairs(vector: &DVector<Complex64>) -> Vec<[f64; 2]> {
    vector.iter().map(|value| complex_pair(*value)).collect()
}

fn complex_pair(value: Complex64) -> [f64; 2] {
    [value.re, value.im]
}

fn field_driven_response_point(
    field_excitation: &DVector<Complex64>,
    solution: BlockRealHarmonicSolution,
    sweep_reuse: BlockRealSweepReuseProvenance,
) -> FieldDrivenBlockRealResponsePoint {
    let amplitude = DVector::from_iterator(
        solution.response.len(),
        solution.response.iter().map(|value| value.norm()),
    );
    let phase_radians = DVector::from_iterator(
        solution.response.len(),
        solution.response.iter().map(|value| value.arg()),
    );
    let field_work = field_excitation
        .iter()
        .zip(solution.response.iter())
        .fold(Complex64::new(0.0, 0.0), |sum, (field, response)| {
            sum + field.conj() * response
        });
    let field_norm_squared = field_excitation
        .iter()
        .map(|field| field.norm_sqr())
        .sum::<f64>();
    let susceptibility = if field_norm_squared > 0.0 {
        field_work / field_norm_squared
    } else {
        Complex64::new(0.0, 0.0)
    };
    let absorbed_power_density = -0.5 * solution.frequency_rad_per_s * field_work.im;

    FieldDrivenBlockRealResponsePoint {
        frequency_rad_per_s: solution.frequency_rad_per_s,
        response: solution.response,
        amplitude,
        phase_radians,
        absorbed_power_density,
        susceptibility,
        residual_l2_norm: solution.residual_l2_norm,
        relative_residual_l2_norm: solution.relative_residual_l2_norm,
        block_dimension: solution.block_dimension,
        matrix_layout: solution.matrix_layout,
        excitation_kind: "field",
        sweep_reuse,
    }
}

fn warm_start_provenance(
    system: &BlockRealHarmonicSystem,
    excitation: &DVector<Complex64>,
    previous_solution: &BlockRealHarmonicSolution,
) -> Result<BlockRealWarmStartProvenance, String> {
    let (real, imag) = assemble_complex_harmonic_operator(system)?;
    if previous_solution.response.len() != excitation.len() {
        return Err(format!(
            "warm-start response dimension {} does not match excitation dimension {}",
            previous_solution.response.len(),
            excitation.len(),
        ));
    }
    let (residual_l2_norm, relative_residual_l2_norm) =
        response_residual_norms(&real, &imag, excitation, &previous_solution.response);

    Ok(BlockRealWarmStartProvenance {
        kind: "previous_frequency_response",
        source_frequency_rad_per_s: previous_solution.frequency_rad_per_s,
        residual_l2_norm,
        relative_residual_l2_norm,
    })
}

fn assemble_complex_harmonic_operator(
    system: &BlockRealHarmonicSystem,
) -> Result<(DMatrix<f64>, DMatrix<f64>), String> {
    let dimension = validate_square_matrix("stiffness", &system.stiffness)?;
    validate_matching_square_matrix("mass", &system.mass, dimension)?;
    if let Some(damping) = &system.damping {
        validate_matching_square_matrix("damping", damping, dimension)?;
    }
    if !system.omega_rad_per_s.is_finite() || system.omega_rad_per_s <= 0.0 {
        return Err(format!(
            "omega_rad_per_s must be finite and positive, got {}",
            system.omega_rad_per_s,
        ));
    }

    let real = &system.stiffness - system.mass.scale(system.omega_rad_per_s.powi(2));
    let imag = system
        .damping
        .as_ref()
        .map(|damping| damping.scale(system.omega_rad_per_s))
        .unwrap_or_else(|| DMatrix::zeros(dimension, dimension));

    Ok((real, imag))
}

fn validate_complex_vector(name: &str, vector: &DVector<Complex64>) -> Result<(), String> {
    if vector
        .iter()
        .any(|value| !value.re.is_finite() || !value.im.is_finite())
    {
        return Err(format!("{name} contains a non-finite value"));
    }
    Ok(())
}

fn validate_square_matrix(name: &str, matrix: &DMatrix<f64>) -> Result<usize, String> {
    if matrix.nrows() == 0 || matrix.ncols() == 0 {
        return Err(format!("{name} matrix must be non-empty"));
    }
    if matrix.nrows() != matrix.ncols() {
        return Err(format!(
            "{name} matrix must be square, got {}x{}",
            matrix.nrows(),
            matrix.ncols(),
        ));
    }
    if matrix.iter().any(|value| !value.is_finite()) {
        return Err(format!("{name} matrix contains a non-finite value"));
    }
    Ok(matrix.nrows())
}

fn validate_matching_square_matrix(
    name: &str,
    matrix: &DMatrix<f64>,
    expected_dimension: usize,
) -> Result<(), String> {
    let dimension = validate_square_matrix(name, matrix)?;
    if dimension != expected_dimension {
        return Err(format!(
            "{name} matrix dimension {dimension} does not match stiffness dimension {expected_dimension}",
        ));
    }
    Ok(())
}

fn response_residual_norms(
    real: &DMatrix<f64>,
    imag: &DMatrix<f64>,
    excitation: &DVector<Complex64>,
    response: &DVector<Complex64>,
) -> (f64, f64) {
    let mut residual_l2_squared = 0.0;
    let mut excitation_l2_squared = 0.0;

    for row in 0..response.len() {
        let mut applied = Complex64::new(0.0, 0.0);
        for col in 0..response.len() {
            applied += Complex64::new(real[(row, col)], imag[(row, col)]) * response[col];
        }
        let residual = applied - excitation[row];
        residual_l2_squared += residual.norm_sqr();
        excitation_l2_squared += excitation[row].norm_sqr();
    }

    let residual_l2_norm = residual_l2_squared.sqrt();
    let excitation_l2_norm = excitation_l2_squared.sqrt();
    let relative_residual_l2_norm = if excitation_l2_norm > 0.0 {
        residual_l2_norm / excitation_l2_norm
    } else {
        residual_l2_norm
    };

    (residual_l2_norm, relative_residual_l2_norm)
}

#[cfg(test)]
mod tests {
    use super::{
        build_field_driven_response_sweep_artifact, solve_block_real_harmonic_response,
        solve_field_driven_block_real_sweep, BlockRealHarmonicSystem, BlockRealHarmonicTemplate,
    };
    use nalgebra::{DMatrix, DVector};
    use num_complex::Complex64;

    #[test]
    fn field_driven_sweep_reports_artifact_ready_diagnostics_per_frequency() {
        let template = BlockRealHarmonicTemplate {
            stiffness: DMatrix::from_element(1, 1, 4.0),
            mass: DMatrix::from_element(1, 1, 1.0),
            damping: Some(DMatrix::from_element(1, 1, 0.5)),
        };
        let field_excitation = DVector::from_element(1, Complex64::new(1.0, 0.0));

        let sweep = solve_field_driven_block_real_sweep(&template, &[1.0, 2.0], &field_excitation)
            .expect("field-driven sweep should solve");

        assert_eq!(sweep.len(), 2);
        assert_eq!(sweep[0].excitation_kind, "field");
        assert_eq!(sweep[0].matrix_layout, "block_real");
        assert_eq!(sweep[1].frequency_rad_per_s, 2.0);
        assert!((sweep[1].response[0].re - 0.0).abs() < 1e-12);
        assert!((sweep[1].response[0].im + 1.0).abs() < 1e-12);
        assert!((sweep[1].amplitude[0] - 1.0).abs() < 1e-12);
        assert!((sweep[1].phase_radians[0] + std::f64::consts::FRAC_PI_2).abs() < 1e-12);
        assert!((sweep[1].susceptibility.re - 0.0).abs() < 1e-12);
        assert!((sweep[1].susceptibility.im + 1.0).abs() < 1e-12);
        assert!((sweep[1].absorbed_power_density - 1.0).abs() < 1e-12);
        assert!(sweep[1].residual_l2_norm < 1e-12);
        assert!(sweep[1].relative_residual_l2_norm < 1e-12);
    }

    #[test]
    fn field_driven_sweep_builds_artifact_ready_response_payload() {
        let template = BlockRealHarmonicTemplate {
            stiffness: DMatrix::from_element(1, 1, 4.0),
            mass: DMatrix::from_element(1, 1, 1.0),
            damping: Some(DMatrix::from_element(1, 1, 0.5)),
        };
        let field_excitation = DVector::from_element(1, Complex64::new(1.0, 0.0));
        let sweep = solve_field_driven_block_real_sweep(&template, &[2.0], &field_excitation)
            .expect("field-driven sweep should solve");

        let artifact = build_field_driven_response_sweep_artifact(
            &sweep,
            "runner.dense_block_real",
            "dense_block_real_lu",
            "gilbert_linear",
            "local_validation",
        );
        let value = serde_json::to_value(&artifact).expect("artifact should serialize");

        assert_eq!(value["schema_version"], "magnetic_response_sweep.v1");
        assert_eq!(value["backend_engine_id"], "runner.dense_block_real");
        assert_eq!(value["solver_model"], "dense_block_real_lu");
        assert_eq!(value["damping_policy"], "gilbert_linear");
        assert_eq!(value["lane_classification"], "local_validation");
        assert_eq!(value["si_units"]["frequency_hz"], "Hz");
        assert_eq!(value["si_units"]["angular_frequency_rad_per_s"], "rad/s");
        let frequency_hz = value["points"][0]["frequency_hz"]
            .as_f64()
            .expect("frequency_hz should be numeric");
        assert!((frequency_hz - 1.0 / std::f64::consts::PI).abs() < 1e-12);
        assert_eq!(value["points"][0]["angular_frequency_rad_per_s"], 2.0);
        assert_eq!(
            value["points"][0]["m_complex"][0],
            serde_json::json!([0.0, -1.0])
        );
        assert_eq!(value["points"][0]["response_amplitude"][0], 1.0);
        assert_eq!(
            value["points"][0]["response_phase"][0],
            -std::f64::consts::FRAC_PI_2
        );
        assert_eq!(
            value["points"][0]["susceptibility_tensor"][0][0],
            serde_json::json!([0.0, -1.0])
        );
        assert_eq!(value["points"][0]["absorbed_power_density"], 1.0);
        assert_eq!(
            value["points"][0]["tangent_leakage"]["kind"],
            "not_evaluated_dense_validation",
        );
        assert!(value["points"][0]["tangent_leakage"]["l2_norm"].is_null());
        assert_eq!(value["points"][0]["excitation_provenance"]["kind"], "field");
        assert_eq!(value["points"][0]["residual_l2_norm"], 0.0);
    }

    #[test]
    fn field_driven_sweep_exposes_previous_frequency_warm_start_provenance() {
        let template = BlockRealHarmonicTemplate {
            stiffness: DMatrix::from_element(1, 1, 4.0),
            mass: DMatrix::from_element(1, 1, 1.0),
            damping: Some(DMatrix::from_element(1, 1, 0.5)),
        };
        let field_excitation = DVector::from_element(1, Complex64::new(1.0, 0.0));

        let sweep =
            solve_field_driven_block_real_sweep(&template, &[1.0, 1.5, 2.0], &field_excitation)
                .expect("field-driven sweep should solve");

        assert!(sweep[0].sweep_reuse.operator_template_reused);
        assert!(sweep[0].sweep_reuse.warm_start.is_none());

        let second_warm_start = sweep[1]
            .sweep_reuse
            .warm_start
            .as_ref()
            .expect("second point should expose previous-frequency warm start");
        assert_eq!(second_warm_start.kind, "previous_frequency_response");
        assert_eq!(second_warm_start.source_frequency_rad_per_s, 1.0);
        assert!(second_warm_start.relative_residual_l2_norm.is_finite());

        let third_warm_start = sweep[2]
            .sweep_reuse
            .warm_start
            .as_ref()
            .expect("third point should expose previous-frequency warm start");
        assert_eq!(third_warm_start.source_frequency_rad_per_s, 1.5);
    }

    #[test]
    fn field_driven_sweep_rejects_non_positive_and_non_finite_frequencies() {
        let template = BlockRealHarmonicTemplate {
            stiffness: DMatrix::from_element(1, 1, 4.0),
            mass: DMatrix::from_element(1, 1, 1.0),
            damping: Some(DMatrix::from_element(1, 1, 0.5)),
        };
        let field_excitation = DVector::from_element(1, Complex64::new(1.0, 0.0));

        for frequency_rad_per_s in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            let error = solve_field_driven_block_real_sweep(
                &template,
                &[frequency_rad_per_s],
                &field_excitation,
            )
            .expect_err("invalid sweep frequency should be rejected");

            assert!(error.contains("frequency sweep values must be finite and positive"));
        }
    }

    #[test]
    fn block_real_harmonic_solve_rejects_non_finite_excitation() {
        let system = BlockRealHarmonicSystem {
            stiffness: DMatrix::identity(1, 1),
            mass: DMatrix::identity(1, 1),
            damping: None,
            omega_rad_per_s: 1.0,
        };
        let excitation = DVector::from_element(1, Complex64::new(f64::NAN, 0.0));

        let error = solve_block_real_harmonic_response(&system, &excitation)
            .expect_err("non-finite excitation should be rejected");

        assert!(error.contains("harmonic excitation contains a non-finite value"));
    }

    #[test]
    fn block_real_harmonic_solve_rejects_dimension_mismatch() {
        let system = BlockRealHarmonicSystem {
            stiffness: DMatrix::identity(2, 2),
            mass: DMatrix::identity(2, 2),
            damping: None,
            omega_rad_per_s: 1.0,
        };
        let excitation = DVector::from_element(1, Complex64::new(1.0, 0.0));

        let error = solve_block_real_harmonic_response(&system, &excitation)
            .expect_err("dimension mismatch should be rejected");

        assert!(error.contains("excitation dimension 1"));
        assert!(error.contains("operator dimension 2"));
    }

    #[test]
    fn block_real_harmonic_solve_matches_complex_scalar_response() {
        let system = BlockRealHarmonicSystem {
            stiffness: DMatrix::from_element(1, 1, 3.0),
            mass: DMatrix::from_element(1, 1, 0.0),
            damping: Some(DMatrix::from_element(1, 1, 2.0)),
            omega_rad_per_s: 2.0,
        };
        let excitation = DVector::from_element(1, Complex64::new(1.0, -2.0));

        let solution = solve_block_real_harmonic_response(&system, &excitation)
            .expect("scalar harmonic response should solve");

        assert_eq!(solution.matrix_layout, "block_real");
        assert_eq!(solution.block_dimension, 2);
        assert_eq!(solution.response.len(), 1);
        assert!((solution.response[0].re + 0.2).abs() < 1e-12);
        assert!((solution.response[0].im + 0.4).abs() < 1e-12);
        assert!(solution.residual_l2_norm < 1e-12);
        assert!(solution.relative_residual_l2_norm < 1e-12);
    }
}
