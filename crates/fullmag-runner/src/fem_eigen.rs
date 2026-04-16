use fullmag_engine::fem::{FemLlgProblem, MeshTopology};
use fullmag_engine::fem_sparse::{lobpcg_generalized, CsrMatrix};
use fullmag_engine::{
    sub, EffectiveFieldObservables, EffectiveFieldTerms, LlgConfig, MaterialParameters,
    TimeIntegrator, Vector3, MU0,
};
use fullmag_ir::{
    EigenDampingPolicyIR, EigenNormalizationIR, EquilibriumSourceIR, FemEigenPlanIR, KSamplingIR,
    OutputIR, RelaxationAlgorithmIR, RelaxationControlIR, SpinWaveBoundaryConditionIR,
    SpinWaveBoundaryKindIR,
};
use nalgebra::{DMatrix, DVector, SymmetricEigen};
use num_complex::Complex64;

use crate::native_fem;
use crate::relaxation::relaxation_converged;
use crate::types::{AuxiliaryArtifact, ExecutedRun, RunError, RunResult, RunStatus, StepStats};
use crate::ExecutionProvenance;

/// Internal relaxation timestep for equilibrium preparation in eigen analysis.
/// This is NOT the user's simulation dt — it is a fixed internal parameter
/// used only for pre-eigen relaxation (small enough for safe LLG convergence).
const RELAX_DT: f64 = 1e-13;
const RELAX_MAX_STEPS: u64 = 4_000;

/// DOF threshold above which LOBPCG sparse eigensolver is used instead of
/// the dense O(n³) path. Below this, Cholesky + SymmetricEigen is used.
const SPARSE_EIGEN_THRESHOLD: usize = 5_000;

/// Convert a dense nalgebra DMatrix to a sparse CsrMatrix, dropping entries
/// below `drop_tol` in absolute value.
fn dmatrix_to_csr(mat: &DMatrix<f64>, drop_tol: f64) -> CsrMatrix {
    let nrows = mat.nrows();
    let ncols = mat.ncols();
    let mut row_ptr = vec![0usize; nrows + 1];
    let mut col_idx: Vec<u32> = Vec::new();
    let mut values: Vec<f64> = Vec::new();

    for i in 0..nrows {
        for j in 0..ncols {
            let v = mat[(i, j)];
            if v.abs() > drop_tol {
                col_idx.push(j as u32);
                values.push(v);
            }
        }
        row_ptr[i + 1] = col_idx.len();
    }

    CsrMatrix {
        nrows,
        ncols,
        row_ptr,
        col_idx,
        values,
    }
}

#[derive(Debug, Clone)]
struct ReductionMap {
    active_nodes: Vec<usize>,
    node_map: Vec<Option<usize>>,
    node_phases: Vec<Complex64>,
    complex_reduction: bool,
}

#[derive(Debug, Clone)]
struct RealEigenpair {
    eigenvalue_real: f64,
    eigenvalue_imag: f64,
    vector: DVector<f64>,
}

#[derive(Debug, Clone)]
struct ComplexEigenpair {
    eigenvalue_real: f64,
    eigenvalue_imag: f64,
    vector: Vec<Complex64>,
}

// ---------------------------------------------------------------------------
// ── GPU dense eigensolver helper (Etap A4) — TRANSITIONAL ─────────────────
// This is a dense O(n³) path suitable for small problems.  A future
// sparse/Krylov/shift-invert solver will replace it for large meshes.
// ---------------------------------------------------------------------------

/// Try to solve K·x = λ·M·x using the GPU (cuSolverDN Dsygvd).
///
/// Returns `Ok(Vec<RealEigenpair>)` on success.
/// Returns `Err(String)` that begins with "UNAVAILABLE:" when the GPU stack is
/// not compiled in, or a descriptive message on any other failure.
/// Callers should fall back to the CPU LAPACK path on error.
fn gpu_solve_real_symmetric_eigenpairs(
    plan: &FemEigenPlanIR,
    stiffness: &DMatrix<f64>,
    mass: &DMatrix<f64>,
) -> Result<Vec<RealEigenpair>, String> {
    let n = stiffness.nrows();
    if n == 0 {
        return Err("UNAVAILABLE: empty matrix".to_string());
    }
    // nalgebra DMatrix<f64> is column-major; .as_slice() yields a column-major &[f64].
    let gpu_result =
        native_fem::gpu_eigen_dense_solve(stiffness.as_slice(), mass.as_slice(), n, n)?;

    let mut eigenpairs: Vec<RealEigenpair> = (0..gpu_result.eigenvalues.len())
        .filter_map(|i| {
            let val = gpu_result.eigenvalues[i];
            if !val.is_finite() {
                return None;
            }
            // Column i starts at offset i*n in the column-major eigenvector array.
            let col_slice = &gpu_result.eigenvectors_col_major[i * n..(i + 1) * n];
            let vector = DVector::from_column_slice(col_slice);
            // cuSolverDn Dsygvd returns M-orthonormal vectors; apply plan normalization.
            let normalized = normalize_real_mode(vector, mass, &plan.normalization);
            Some(RealEigenpair {
                eigenvalue_real: val,
                eigenvalue_imag: 0.0,
                vector: normalized,
            })
        })
        .collect();

    sort_and_truncate_real_modes(plan, &mut eigenpairs);
    Ok(eigenpairs)
}

pub(crate) fn execute_reference_fem_eigen(
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
) -> Result<ExecutedRun, RunError> {
    execute_fem_eigen_inner(plan, outputs, false)
}

/// GPU-accelerated FEM eigensolver (Etap A4) — TRANSITIONAL dense path.
///
/// This implementation uses dense generalized eigenvalue decomposition
/// (cuSolverDN Dsygvd on GPU, LAPACK on CPU).  It is practical for small-
/// to medium-sized problems (≲ a few thousand DOF) but scales as O(n³).
/// A future sparse/Krylov/shift-invert eigensolver will replace this path
/// for large meshes.
///
/// When `try_gpu` is true and the GPU is unavailable or fails, returns an
/// error — no silent fallback to CPU.
pub(crate) fn execute_gpu_fem_eigen(
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
) -> Result<ExecutedRun, RunError> {
    execute_fem_eigen_inner(plan, outputs, true)
}

fn execute_fem_eigen_inner(
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    try_gpu: bool,
) -> Result<ExecutedRun, RunError> {
    if plan.precision != fullmag_ir::ExecutionPrecision::Double {
        return Err(RunError {
            message: "execution_precision='single' is not executable in the FEM eigen CPU reference runner; use 'double'".to_string(),
        });
    }

    let initial_magnetization = plan.equilibrium_magnetization.clone();
    let (problem, equilibrium, relaxation_steps, observables) =
        materialize_equilibrium(plan, &initial_magnetization)?;
    let topology = &problem.topology;
    let mut solver_kind = solver_kind_label(plan);
    let reduction = build_reduction_map(topology, &plan.spin_wave_bc, plan.k_sampling.as_ref())?;
    if reduction.active_nodes.is_empty() {
        return Err(RunError {
            message: "FEM eigen solver found no magnetically active nodes".to_string(),
        });
    }
    let complex_reduction = reduction.complex_reduction;

    // Warn about dense O(n³) scaling for large problems (transitional path).
    let active_n = reduction.active_nodes.len();
    let is_full_2x2 = matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2);
    let effective_dof = if is_full_2x2 { 2 * active_n } else { active_n };
    let use_sparse = effective_dof > SPARSE_EIGEN_THRESHOLD && !try_gpu && !complex_reduction;
    if effective_dof > 3000 && !use_sparse {
        eprintln!(
            "warning: FEM eigen dense solver has {} effective DOF ({} active nodes, {}) — O(n³) scaling; \
             consider reducing mesh size or awaiting future sparse/Krylov eigensolver",
            effective_dof,
            active_n,
            if is_full_2x2 { "full 2×2" } else { "scalar" }
        );
    }
    if use_sparse {
        eprintln!(
            "info: FEM eigen using sparse LOBPCG solver for {} effective DOF ({} active nodes, {})",
            effective_dof,
            active_n,
            if is_full_2x2 { "full 2×2" } else { "scalar" }
        );
    }

    let bases = tangent_bases(&equilibrium);
    let num_modes = plan.count as usize;

    let real_eigenpairs = if complex_reduction {
        Vec::new()
    } else if is_full_2x2 {
        let (stiffness, mass) = assemble_full_2x2_operator_real(
            plan,
            topology,
            &reduction,
            &observables,
            &equilibrium,
            &bases,
        );
        if use_sparse {
            solve_real_symmetric_eigenpairs_sparse(plan, stiffness, mass, num_modes)?
        } else {
            solve_real_symmetric_eigenpairs(plan, stiffness, mass)?
        }
    } else {
        let (stiffness, mass) = assemble_projected_scalar_operator_real(
            plan,
            topology,
            &reduction,
            &observables,
            &equilibrium,
        );
        if try_gpu {
            // Attempt GPU dense generalized solve; return error if GPU was
            // explicitly requested but is unavailable or fails.
            match gpu_solve_real_symmetric_eigenpairs(plan, &stiffness, &mass) {
                Ok(pairs) => {
                    eprintln!(
                        "info: FEM eigen GPU solve succeeded ({} modes)",
                        pairs.len()
                    );
                    pairs
                }
                Err(reason) => {
                    if reason.contains("UNAVAILABLE") {
                        return Err(RunError {
                            message: format!(
                                "FEM eigen GPU was explicitly requested but is unavailable: {reason}"
                            ),
                        });
                    } else {
                        return Err(RunError {
                            message: format!("FEM eigen GPU solve failed: {reason}"),
                        });
                    }
                }
            }
        } else if use_sparse {
            solve_real_symmetric_eigenpairs_sparse(plan, stiffness, mass, num_modes)?
        } else {
            solve_real_symmetric_eigenpairs(plan, stiffness, mass)?
        }
    };
    if use_sparse {
        solver_kind = "cpu_sparse_lobpcg";
    }
    let complex_eigenpairs = if complex_reduction {
        let (stiffness, mass) = assemble_projected_scalar_operator_complex(
            plan,
            topology,
            &reduction,
            &observables,
            &equilibrium,
        );
        solve_complex_hermitian_eigenpairs(plan, stiffness, mass)?
    } else {
        Vec::new()
    };

    let requested_modes = requested_mode_indices(outputs);
    let wants_spectrum = outputs
        .iter()
        .any(|output| matches!(output, OutputIR::EigenSpectrum { .. }));
    let wants_dispersion = outputs
        .iter()
        .any(|output| matches!(output, OutputIR::DispersionCurve { .. }));

    let mut auxiliary_artifacts = Vec::new();
    let total_modes = if complex_reduction {
        complex_eigenpairs.len()
    } else {
        real_eigenpairs.len()
    };
    let mut modes_summary = Vec::with_capacity(total_modes);
    let damping_factor = damping_imaginary_factor(plan.material.damping, plan.damping_policy);

    for mode_index in 0..total_modes {
        let (eigenvalue_real, eigenvalue_imag, real, imag, amplitude, phase, max_amplitude, norm) =
            if complex_reduction {
                let pair = &complex_eigenpairs[mode_index];
                let (real, imag, amplitude, phase, max_amplitude) =
                    project_complex_mode_to_tangent_basis(
                        topology.n_nodes,
                        &reduction.active_nodes,
                        &pair.vector,
                        &bases,
                    );
                let norm = pair
                    .vector
                    .iter()
                    .map(|value| value.norm_sqr())
                    .sum::<f64>()
                    .sqrt();
                (
                    pair.eigenvalue_real,
                    pair.eigenvalue_imag,
                    real,
                    imag,
                    amplitude,
                    phase,
                    max_amplitude,
                    norm,
                )
            } else if is_full_2x2 {
                let pair = &real_eigenpairs[mode_index];
                let (real, imag, amplitude, phase, max_amplitude) =
                    project_2x2_mode_to_tangent_basis(
                        topology.n_nodes,
                        &reduction.active_nodes,
                        &pair.vector,
                        &bases,
                    );
                let norm = pair.vector.norm();
                (
                    pair.eigenvalue_real,
                    pair.eigenvalue_imag,
                    real,
                    imag,
                    amplitude,
                    phase,
                    max_amplitude,
                    norm,
                )
            } else {
                let pair = &real_eigenpairs[mode_index];
                let (real, imag, amplitude, phase, max_amplitude) =
                    project_real_mode_to_tangent_basis(
                        topology.n_nodes,
                        &reduction.active_nodes,
                        &pair.vector,
                        &bases,
                    );
                let norm = pair.vector.norm();
                (
                    pair.eigenvalue_real,
                    pair.eigenvalue_imag,
                    real,
                    imag,
                    amplitude,
                    phase,
                    max_amplitude,
                    norm,
                )
            };
        let angular_frequency_real =
            angular_frequency_from_eigenvalue(plan.gyromagnetic_ratio, eigenvalue_real);
        let angular_frequency_imag = if eigenvalue_imag.abs() > 0.0 {
            angular_frequency_from_raw_eigenvalue(plan.gyromagnetic_ratio, eigenvalue_imag)
        } else {
            angular_frequency_real * damping_factor
        };
        let frequency_hz = angular_frequency_real / (2.0 * std::f64::consts::PI);
        let frequency_imag_hz = angular_frequency_imag / (2.0 * std::f64::consts::PI);
        let dominant_polarization = classify_polarization(
            &amplitude,
            &reduction.active_nodes,
            &equilibrium,
            max_amplitude,
        );
        let mode_summary = serde_json::json!({
            "index": mode_index,
            "frequency_hz": frequency_hz,
            "frequency_real_hz": frequency_hz,
            "frequency_imag_hz": frequency_imag_hz,
            "angular_frequency_rad_per_s": angular_frequency_real,
            "angular_frequency_imag_rad_per_s": angular_frequency_imag,
            "eigenvalue_field_au_per_m": eigenvalue_real.max(0.0),
            "eigenvalue_real": eigenvalue_real,
            "eigenvalue_imag": eigenvalue_imag,
            "norm": norm,
            "max_amplitude": max_amplitude,
            "dominant_polarization": dominant_polarization,
            "k_vector": k_vector_json(plan.k_sampling.as_ref()),
        });
        modes_summary.push(mode_summary.clone());

        if requested_modes.contains(&(mode_index as u32)) {
            let payload = serde_json::json!({
                "index": mode_index,
                "frequency_hz": frequency_hz,
                "frequency_real_hz": frequency_hz,
                "frequency_imag_hz": frequency_imag_hz,
                "angular_frequency_rad_per_s": angular_frequency_real,
                "angular_frequency_imag_rad_per_s": angular_frequency_imag,
                "eigenvalue_real": eigenvalue_real,
                "eigenvalue_imag": eigenvalue_imag,
                "max_amplitude": max_amplitude,
                "normalization": normalization_label(plan.normalization),
                "damping_policy": damping_policy_label(plan.damping_policy),
                "solver_backend": "cpu_reference_fem_eigen",
                "solver_kind": solver_kind,
                "solver_notes": solver_notes(plan, complex_reduction, use_sparse),
                "solver_capabilities": solver_capabilities(plan, complex_reduction, use_sparse),
                "solver_limitations": solver_limitations(plan, complex_reduction, use_sparse),
                "dominant_polarization": dominant_polarization,
                "k_vector": k_vector_json(plan.k_sampling.as_ref()),
                "real": real,
                "imag": imag,
                "amplitude": amplitude,
                "phase": phase,
            });
            auxiliary_artifacts.push(json_artifact(
                format!("eigen/modes/mode_{mode_index:04}.json"),
                &payload,
            )?);
        }
    }

    let summary_payload = serde_json::json!({
        "study_kind": "eigenmodes",
        "solver_backend": "cpu_reference_fem_eigen",
        "solver_kind": solver_kind,
        "solver_notes": solver_notes(plan, complex_reduction, use_sparse),
        "solver_capabilities": solver_capabilities(plan, complex_reduction, use_sparse),
        "solver_limitations": solver_limitations(plan, complex_reduction, use_sparse),
        "mesh_name": plan.mesh_name,
        "mode_count": modes_summary.len(),
        "normalization": normalization_label(plan.normalization),
        "damping_policy": damping_policy_label(plan.damping_policy),
        "spin_wave_bc": spin_wave_bc_label(plan.spin_wave_bc.clone()),
        "boundary_config": spin_wave_bc_json(&plan.spin_wave_bc),
        "equilibrium_source": equilibrium_source_json(&plan.equilibrium),
        "included_terms": {
            "exchange": plan.enable_exchange,
            "demag": plan.enable_demag,
            "zeeman": plan.external_field.is_some(),
            "interfacial_dmi": plan.interfacial_dmi.is_some(),
            "bulk_dmi": plan.bulk_dmi.is_some(),
            "surface_anisotropy": plan.spin_wave_bc.surface_anisotropy_ks().is_some(),
        },
        "operator": {
            "kind": format!("{:?}", plan.operator.kind).to_lowercase(),
            "include_demag": plan.operator.include_demag,
        },
        "k_sampling": k_vector_json(plan.k_sampling.as_ref()),
        "relaxation_steps": relaxation_steps,
        "modes": modes_summary,
    });

    if wants_spectrum {
        auxiliary_artifacts.push(json_artifact("eigen/spectrum.json", &summary_payload)?);
    }
    auxiliary_artifacts.push(json_artifact(
        "eigen/metadata/eigen_summary.json",
        &summary_payload,
    )?);
    auxiliary_artifacts.push(json_artifact(
        "eigen/metadata/normalization.json",
        &serde_json::json!({
            "normalization": normalization_label(plan.normalization),
            "mode_count": summary_payload["mode_count"],
        }),
    )?);
    auxiliary_artifacts.push(json_artifact(
        "eigen/metadata/equilibrium_source.json",
        &equilibrium_source_json(&plan.equilibrium),
    )?);

    if wants_dispersion {
        let k_vector = k_vector_json(plan.k_sampling.as_ref());
        auxiliary_artifacts.push(json_artifact(
            "eigen/dispersion/path.json",
            &serde_json::json!({
                "sampling": plan.k_sampling,
                "k_vector": k_vector,
            }),
        )?);
        auxiliary_artifacts.push(AuxiliaryArtifact {
            relative_path: "eigen/dispersion/branch_table.csv".to_string(),
            bytes: dispersion_csv(plan.k_sampling.as_ref(), &summary_payload["modes"]).into_bytes(),
        });
    }

    let stats = StepStats {
        step: relaxation_steps,
        time: 0.0,
        dt: 0.0,
        e_ex: observables.exchange_energy_joules,
        e_demag: observables.demag_energy_joules,
        e_ext: observables.external_energy_joules,
        e_total: observables.total_energy_joules,
        max_dm_dt: observables.max_rhs_amplitude,
        max_h_eff: observables.max_effective_field_amplitude,
        max_h_demag: observables.max_demag_field_amplitude,
        ..StepStats::default()
    };

    Ok(ExecutedRun {
        result: RunResult {
            status: RunStatus::Completed,
            steps: vec![stats],
            final_magnetization: equilibrium.clone(),
            completion: Some(crate::relaxation::infer_stage_completion(
                RunStatus::Completed,
                None,
                &[],
                0.0,
                0.0,
                false,
            )),
        },
        initial_magnetization,
        field_snapshots: Vec::new(),
        field_snapshot_count: 0,
        auxiliary_artifacts,
        provenance: execution_provenance(plan, try_gpu),
    })
}

fn execution_provenance(plan: &FemEigenPlanIR, used_gpu: bool) -> ExecutionProvenance {
    let engine = if used_gpu {
        format!("gpu_cusolver_fem_eigen/{}", solver_kind_label(plan))
    } else {
        format!("cpu_reference_fem_eigen/{}", solver_kind_label(plan))
    };
    let resolved_demag = resolved_demag_realization(plan);
    ExecutionProvenance {
        execution_engine: engine,
        // FEM eigen baseline currently executes in double precision.
        precision: "double".to_string(),
        demag_operator_kind: resolved_demag.map(|r| r.provenance_name().to_string()),
        requested_demag_realization: if plan.enable_demag {
            plan.demag_realization
                .map(|requested| demag_realization_label(requested).to_string())
        } else {
            None
        },
        resolved_demag_realization: resolved_demag
            .map(|resolved| demag_realization_label(resolved).to_string()),
        fft_backend: None,
        device_name: None,
        compute_capability: None,
        cuda_driver_version: None,
        cuda_runtime_version: None,
        ..Default::default()
    }
}

fn materialize_equilibrium(
    plan: &FemEigenPlanIR,
    initial_magnetization: &[Vector3],
) -> Result<(FemLlgProblem, Vec<Vector3>, u64, EffectiveFieldObservables), RunError> {
    let mut equilibrium_guess = initial_magnetization.to_vec();
    if let EquilibriumSourceIR::Artifact { path } = &plan.equilibrium {
        equilibrium_guess = load_equilibrium_artifact(path, plan.mesh.nodes.len())?;
    }

    let topology = MeshTopology::from_ir(&plan.mesh).map_err(|error| RunError {
        message: format!("MeshTopology: {}", error),
    })?;
    let material = MaterialParameters::new(
        plan.material.saturation_magnetisation,
        plan.material.exchange_stiffness,
        plan.material.damping,
    )
    .map_err(|error| RunError {
        message: format!("Material: {}", error),
    })?;
    let dynamics = LlgConfig::new(plan.gyromagnetic_ratio, TimeIntegrator::RK23)
        .map_err(|error| RunError {
            message: format!("LLG: {}", error),
        })?
        .with_precession_enabled(false);
    // Compute volume anisotropy field at equilibrium guess so that the
    // relaxation includes the anisotropy contribution.  Because the FEM
    // engine treats per_node_field as static, we recompute it once after
    // an initial relaxation pass (self-consistent field iteration).
    let aniso_per_node: Option<Vec<Vector3>> = {
        let has_uni = plan
            .material
            .uniaxial_anisotropy
            .map_or(false, |k| k.abs() > 0.0);
        let has_cub = plan
            .material
            .cubic_anisotropy_kc1
            .map_or(false, |k| k.abs() > 0.0);
        if has_uni || has_cub {
            Some(
                equilibrium_guess
                    .iter()
                    .map(|m| volume_anisotropy_field(*m, plan))
                    .collect(),
            )
        } else {
            None
        }
    };
    let terms = EffectiveFieldTerms {
        exchange: plan.enable_exchange,
        demag: plan.enable_demag,
        external_field: plan.external_field,
        per_node_field: aniso_per_node,
        magnetoelastic: None,
        uniaxial_anisotropy: None,
        cubic_anisotropy: None,
        interfacial_dmi: None,
        bulk_dmi: None,
        zhang_li_stt: None,
        slonczewski_stt: None,
        sot: None,
        oersted_cylinder: None,
    };
    let resolved_demag = resolved_demag_realization(plan);
    let mut problem = match resolved_demag {
        Some(fullmag_ir::ResolvedFemDemagIR::PoissonRobin) => {
            FemLlgProblem::with_terms_and_demag_airbox(
                topology, material, dynamics, terms, false, None,
            )
        }
        Some(fullmag_ir::ResolvedFemDemagIR::PoissonDirichlet) => {
            FemLlgProblem::with_terms_and_demag_airbox(
                topology, material, dynamics, terms, true, None,
            )
        }
        None => FemLlgProblem::with_terms(topology, material, dynamics, terms),
    };
    if let Some(normal) = plan.dmi_interface_normal {
        problem.set_dmi_interface_normal(normal);
    }
    let mut state = problem
        .new_state(equilibrium_guess)
        .map_err(|error| RunError {
            message: format!("State: {}", error),
        })?;

    let mut steps_taken = 0;
    if matches!(plan.equilibrium, EquilibriumSourceIR::RelaxedInitialState) {
        let control = RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::LlgOverdamped,
            stop: fullmag_ir::RelaxStopIR {
                torque_tolerance_apm: Some(1e-5),
                energy_tolerance_j: Some(1e-12),
                max_steps: Some(RELAX_MAX_STEPS),
                max_pseudotime_s: None,
                max_physical_time_s: None,
            },
        };
        let mut previous_total_energy = None;
        while steps_taken < RELAX_MAX_STEPS {
            let report = problem
                .step(&mut state, RELAX_DT)
                .map_err(|error| RunError {
                    message: format!("FEM eigen relaxation step {}: {}", steps_taken, error),
                })?;
            steps_taken += 1;
            let stats = StepStats {
                step: steps_taken,
                time: report.time_seconds,
                dt: report.dt_used,
                e_ex: report.exchange_energy_joules,
                e_demag: report.demag_energy_joules,
                e_ext: report.external_energy_joules,
                e_total: report.total_energy_joules,
                max_dm_dt: report.max_rhs_amplitude,
                max_h_eff: report.max_effective_field_amplitude,
                max_h_demag: report.max_demag_field_amplitude,
                ..StepStats::default()
            };
            if relaxation_converged(
                &control,
                &stats,
                previous_total_energy,
                plan.gyromagnetic_ratio,
                plan.material.damping,
                true,
            ) {
                break;
            }
            previous_total_energy = Some(report.total_energy_joules);
        }
    }

    let observables = problem.observe(&state).map_err(|error| RunError {
        message: format!("FEM eigen observables: {}", error),
    })?;
    Ok((
        problem,
        state.magnetization().to_vec(),
        steps_taken,
        observables,
    ))
}

fn load_equilibrium_artifact(path: &str, expected_len: usize) -> Result<Vec<Vector3>, RunError> {
    let raw = std::fs::read_to_string(path).map_err(|error| RunError {
        message: format!("failed to read equilibrium artifact '{}': {}", path, error),
    })?;
    let value: serde_json::Value = serde_json::from_str(&raw).map_err(|error| RunError {
        message: format!("failed to parse equilibrium artifact '{}': {}", path, error),
    })?;
    let values = value
        .get("values")
        .cloned()
        .unwrap_or(value)
        .as_array()
        .cloned()
        .ok_or_else(|| RunError {
            message: format!(
                "equilibrium artifact '{}' must be a JSON array or a field artifact with 'values'",
                path
            ),
        })?;
    if values.len() != expected_len {
        return Err(RunError {
            message: format!(
                "equilibrium artifact '{}' contains {} vectors, expected {}",
                path,
                values.len(),
                expected_len
            ),
        });
    }
    values
        .into_iter()
        .map(|entry| {
            let array = entry.as_array().ok_or_else(|| RunError {
                message: format!(
                    "equilibrium artifact '{}' contains a non-vector entry",
                    path
                ),
            })?;
            if array.len() != 3 {
                return Err(RunError {
                    message: format!("equilibrium artifact '{}' contains a non-3D vector", path),
                });
            }
            Ok([
                array[0].as_f64().unwrap_or(0.0),
                array[1].as_f64().unwrap_or(0.0),
                array[2].as_f64().unwrap_or(0.0),
            ])
        })
        .collect()
}

fn build_reduction_map(
    topology: &MeshTopology,
    spin_wave_bc: &SpinWaveBoundaryConditionIR,
    k_sampling: Option<&KSamplingIR>,
) -> Result<ReductionMap, RunError> {
    let pinned: std::collections::HashSet<usize> =
        if matches!(spin_wave_bc.kind(), SpinWaveBoundaryKindIR::Pinned) {
            magnetic_boundary_nodes(topology)
        } else {
            std::collections::HashSet::new()
        };

    let phase_groups = phase_reduction(topology, spin_wave_bc, k_sampling)?;

    let mut active_nodes = Vec::new();
    let mut mapping = vec![None; topology.n_nodes];
    let mut node_phases = vec![Complex64::new(1.0, 0.0); topology.n_nodes];

    if let Some(groups) = phase_groups {
        let mut root_to_reduced = std::collections::BTreeMap::new();
        for (node_index, volume) in topology.magnetic_node_volumes.iter().enumerate() {
            if *volume <= 0.0 || pinned.contains(&node_index) {
                continue;
            }
            let root = groups.roots[node_index];
            let reduced_index = if let Some(existing) = root_to_reduced.get(&root) {
                *existing
            } else {
                let next = active_nodes.len();
                root_to_reduced.insert(root, next);
                active_nodes.push(root);
                next
            };
            mapping[node_index] = Some(reduced_index);
            node_phases[node_index] = groups.phases[node_index];
        }
        Ok(ReductionMap {
            active_nodes,
            node_map: mapping,
            node_phases,
            complex_reduction: matches!(spin_wave_bc.kind(), SpinWaveBoundaryKindIR::Floquet),
        })
    } else {
        for (node_index, volume) in topology.magnetic_node_volumes.iter().enumerate() {
            if *volume <= 0.0 || pinned.contains(&node_index) {
                continue;
            }
            let reduced_index = active_nodes.len();
            active_nodes.push(node_index);
            mapping[node_index] = Some(reduced_index);
        }
        Ok(ReductionMap {
            active_nodes,
            node_map: mapping,
            node_phases,
            complex_reduction: false,
        })
    }
}

#[derive(Debug, Clone)]
struct PhaseGroups {
    roots: Vec<usize>,
    phases: Vec<Complex64>,
}

fn phase_reduction(
    topology: &MeshTopology,
    spin_wave_bc: &SpinWaveBoundaryConditionIR,
    k_sampling: Option<&KSamplingIR>,
) -> Result<Option<PhaseGroups>, RunError> {
    let kind = spin_wave_bc.kind();
    if !matches!(
        kind,
        SpinWaveBoundaryKindIR::Periodic | SpinWaveBoundaryKindIR::Floquet
    ) {
        return Ok(None);
    }
    if topology.periodic_node_pairs.is_empty() {
        return Err(RunError {
            message: format!(
                "spin_wave_bc.kind='{kind}' requires mesh.periodic_node_pairs metadata — \
                 the mesh contains no periodic node pairs; add periodic_node_pairs to the mesh IR \
                 or use spin_wave_bc.kind='free'",
                kind = match kind {
                    SpinWaveBoundaryKindIR::Periodic => "periodic",
                    _ => "floquet",
                }
            ),
        });
    }

    let requested_pair = spin_wave_bc.boundary_pair_id();
    let k_vector = match (kind, k_sampling) {
        (SpinWaveBoundaryKindIR::Floquet, Some(KSamplingIR::Single { k_vector })) => {
            Some(*k_vector)
        }
        (SpinWaveBoundaryKindIR::Floquet, Some(KSamplingIR::Path { .. })) => {
            return Err(RunError {
                message: "floquet spin-wave BC with KSampling::Path is not yet supported in single-k runner; use the multi-k orchestrator".to_string(),
            });
        }
        (SpinWaveBoundaryKindIR::Floquet, None) => {
            return Err(RunError {
                message: "floquet spin-wave BC requires k_sampling=Single{...}".to_string(),
            });
        }
        _ => None,
    };

    let mut adjacency = vec![Vec::<(usize, Complex64)>::new(); topology.n_nodes];
    for (pair_id, node_a, node_b) in &topology.periodic_node_pairs {
        if !requested_pair.is_none_or(|requested| requested == pair_id) {
            continue;
        }
        let a = *node_a as usize;
        let b = *node_b as usize;
        let phase = if let Some(k) = k_vector {
            let delta = [
                topology.coords[b][0] - topology.coords[a][0],
                topology.coords[b][1] - topology.coords[a][1],
                topology.coords[b][2] - topology.coords[a][2],
            ];
            let angle = k[0] * delta[0] + k[1] * delta[1] + k[2] * delta[2];
            Complex64::from_polar(1.0, angle)
        } else {
            Complex64::new(1.0, 0.0)
        };
        adjacency[a].push((b, phase));
        adjacency[b].push((a, phase.conj()));
    }

    let mut visited = vec![false; topology.n_nodes];
    let mut roots: Vec<usize> = (0..topology.n_nodes).collect();
    let mut phases = vec![Complex64::new(1.0, 0.0); topology.n_nodes];

    for start in 0..topology.n_nodes {
        if visited[start] || topology.magnetic_node_volumes[start] <= 0.0 {
            continue;
        }
        let mut queue = std::collections::VecDeque::new();
        visited[start] = true;
        roots[start] = start;
        phases[start] = Complex64::new(1.0, 0.0);
        queue.push_back(start);
        while let Some(node) = queue.pop_front() {
            for (next, phase) in &adjacency[node] {
                let next_phase = phases[node] * *phase;
                if !visited[*next] {
                    visited[*next] = true;
                    roots[*next] = start;
                    phases[*next] = next_phase;
                    queue.push_back(*next);
                }
            }
        }
    }

    Ok(Some(PhaseGroups { roots, phases }))
}

/// Returns the set of indices of nodes that lie on the surface of the magnetic
/// region (i.e. surface relevant for spin-wave pinning BC).
///
/// * Standalone magnetic mesh (no airbox):  
///   `topology.boundary_nodes` are all on the outer surface of the magnet.
///
/// * Shared-domain mesh with airbox:  
///   `topology.boundary_nodes` are on the outer airbox surface, NOT the magnet
///   surface.  We instead find nodes that are magnetic AND appear in at least
///   one non-magnetic (airbox) element — these are exactly on the interface.
fn magnetic_boundary_nodes(topology: &MeshTopology) -> std::collections::HashSet<usize> {
    let has_airbox = topology
        .magnetic_element_mask
        .iter()
        .any(|&is_magnetic| !is_magnetic);

    if !has_airbox {
        // Standalone magnetic mesh: outer boundary = magnet surface.
        return topology
            .boundary_nodes
            .iter()
            .map(|&n| n as usize)
            .collect();
    }

    // Shared-domain mesh: collect nodes that appear in non-magnetic elements.
    let mut in_airbox_element: std::collections::HashSet<usize> = std::collections::HashSet::new();
    for (element_idx, element) in topology.elements.iter().enumerate() {
        if !topology.magnetic_element_mask[element_idx] {
            for &node in element.iter() {
                in_airbox_element.insert(node as usize);
            }
        }
    }
    // Magnetic boundary = magnetic nodes that are also in an airbox element.
    (0..topology.n_nodes)
        .filter(|&i| topology.magnetic_node_volumes[i] > 0.0 && in_airbox_element.contains(&i))
        .collect()
}

fn assemble_projected_scalar_operator_real(
    plan: &FemEigenPlanIR,
    topology: &MeshTopology,
    reduction: &ReductionMap,
    observables: &EffectiveFieldObservables,
    equilibrium: &[Vector3],
) -> (DMatrix<f64>, DMatrix<f64>) {
    let active_count = reduction.active_nodes.len();
    let mut stiffness = DMatrix::<f64>::zeros(active_count, active_count);
    let mut mass = DMatrix::<f64>::zeros(active_count, active_count);
    let parallel_field = observables
        .magnetization
        .iter()
        .enumerate()
        .map(|(index, m)| {
            let mut selected_field = [0.0, 0.0, 0.0];
            if plan.enable_exchange {
                selected_field = add_vector(selected_field, observables.exchange_field[index]);
            }
            if plan.enable_demag {
                selected_field = add_vector(selected_field, observables.demag_field[index]);
            }
            if plan.external_field.is_some() {
                selected_field = add_vector(selected_field, observables.external_field[index]);
            }
            // Volume anisotropy (uniaxial + cubic) contribution to parallel field
            selected_field = add_vector(selected_field, volume_anisotropy_field(*m, plan));
            dot(*m, selected_field).max(0.0)
        })
        .collect::<Vec<_>>();

    for (element_index, element) in topology.elements.iter().enumerate() {
        if !topology.magnetic_element_mask[element_index] {
            continue;
        }
        let volume = topology.element_volumes[element_index];
        let local_mass = [
            [
                2.0 * volume / 20.0,
                volume / 20.0,
                volume / 20.0,
                volume / 20.0,
            ],
            [
                volume / 20.0,
                2.0 * volume / 20.0,
                volume / 20.0,
                volume / 20.0,
            ],
            [
                volume / 20.0,
                volume / 20.0,
                2.0 * volume / 20.0,
                volume / 20.0,
            ],
            [
                volume / 20.0,
                volume / 20.0,
                volume / 20.0,
                2.0 * volume / 20.0,
            ],
        ];
        let local_shift = [
            parallel_field[element[0] as usize],
            parallel_field[element[1] as usize],
            parallel_field[element[2] as usize],
            parallel_field[element[3] as usize],
        ];
        for i in 0..4 {
            let Some(row) = reduction.node_map[element[i] as usize] else {
                continue;
            };
            for j in 0..4 {
                let Some(col) = reduction.node_map[element[j] as usize] else {
                    continue;
                };
                mass[(row, col)] += local_mass[i][j];
                if plan.enable_exchange {
                    stiffness[(row, col)] += topology.element_stiffness[element_index][i][j];
                }
                let shift = 0.5 * (local_shift[i] + local_shift[j]);
                stiffness[(row, col)] += local_mass[i][j] * shift;
            }
        }
    }

    add_surface_anisotropy_real(plan, topology, reduction, equilibrium, &mut stiffness);
    add_dmi_real(plan, topology, reduction, &mut stiffness);

    (stiffness, mass)
}

/// Assemble the full 2×2 Herring–Kittel block operator.
///
/// The operator is 2N × 2N with blocks:
/// ```text
///   K = [ K_11  K_12 ]    M_block = [ M  0 ]
///       [ K_21  K_22 ]              [ 0  M ]
/// ```
///
/// Block layout: rows/cols [0..N) correspond to the e1 tangent component,
/// rows/cols [N..2N) correspond to the e2 tangent component.
///
/// For exchange: the exchange stiffness is isotropic in the tangent plane,
/// so it contributes equally to K_11 and K_22 diagonals and does NOT couple
/// K_12/K_21.
///
/// For the effective-field Hessian: the full field linearisation at each node
/// projects the per-node effective field into the tangent basis, producing
/// diagonal parallel-field shifts on K_11/K_22 AND off-diagonal couplings on
/// K_12/K_21 from the perpendicular field components.
fn assemble_full_2x2_operator_real(
    plan: &FemEigenPlanIR,
    topology: &MeshTopology,
    reduction: &ReductionMap,
    observables: &EffectiveFieldObservables,
    equilibrium: &[Vector3],
    bases: &[(Vector3, Vector3)],
) -> (DMatrix<f64>, DMatrix<f64>) {
    let n = reduction.active_nodes.len();
    let dim = 2 * n;
    let mut stiffness = DMatrix::<f64>::zeros(dim, dim);
    let mut mass = DMatrix::<f64>::zeros(dim, dim);

    // Compute local effective-field tangent-plane projection at each node.
    // For the full 2×2 operator we need all four components:
    //   h_11 = e1 · H_eff'[e1]   (parallel field along e1 direction)
    //   h_22 = e2 · H_eff'[e2]   (parallel field along e2 direction)
    //   h_12 = e1 · H_eff'[e2]   (cross-coupling e2 → e1)
    //   h_21 = e2 · H_eff'[e1]   (cross-coupling e1 → e2)
    //
    // For uniform equilibrium h_11 = h_22 = h_parallel and h_12 = h_21 = 0,
    // recovering the scalar operator.
    let field_blocks: Vec<[f64; 4]> = observables
        .magnetization
        .iter()
        .enumerate()
        .map(|(idx, m)| {
            let mut h_eff = [0.0, 0.0, 0.0];
            if plan.enable_exchange {
                h_eff = add_vector(h_eff, observables.exchange_field[idx]);
            }
            if plan.enable_demag {
                h_eff = add_vector(h_eff, observables.demag_field[idx]);
            }
            if plan.external_field.is_some() {
                h_eff = add_vector(h_eff, observables.external_field[idx]);
            }
            h_eff = add_vector(h_eff, volume_anisotropy_field(*m, plan));

            let (e1, e2) = bases[idx];
            // Project effective field into tangent basis.
            // The diagonal components are the parallel field projections,
            // and the off-diagonal components capture the Hessian coupling.
            let h_parallel = dot(*m, h_eff).max(0.0);
            // For the cross terms, we project H_eff components perpendicular to m₀.
            // The effective-field Hessian ∂H/∂m in the tangent plane gives the 2×2 block.
            // For the MVP, we use the h_parallel on the diagonal and compute cross terms
            // from the tangent projections of H_eff itself.
            let h_e1 = dot(e1, h_eff);
            let h_e2 = dot(e2, h_eff);
            // The 2×2 effective field tensor in the tangent basis is:
            //   T_αβ = δ_αβ * h_parallel + correction from non-uniform field
            // For the first-order Herring–Kittel form with dipole coupling,
            // the cross terms arise from the component of H_eff perpendicular to m₀.
            // In the uniform case h_e1 = h_e2 = 0, so the off-diagonal vanishes.
            [
                h_parallel,                            // h_11
                h_e1 * h_e2 / (h_parallel.max(1e-30)), // h_12 (cross coupling)
                h_e1 * h_e2 / (h_parallel.max(1e-30)), // h_21 = h_12 (symmetric)
                h_parallel,                            // h_22
            ]
        })
        .collect();

    for (element_index, element) in topology.elements.iter().enumerate() {
        if !topology.magnetic_element_mask[element_index] {
            continue;
        }
        let volume = topology.element_volumes[element_index];
        let local_mass = [
            [
                2.0 * volume / 20.0,
                volume / 20.0,
                volume / 20.0,
                volume / 20.0,
            ],
            [
                volume / 20.0,
                2.0 * volume / 20.0,
                volume / 20.0,
                volume / 20.0,
            ],
            [
                volume / 20.0,
                volume / 20.0,
                2.0 * volume / 20.0,
                volume / 20.0,
            ],
            [
                volume / 20.0,
                volume / 20.0,
                volume / 20.0,
                2.0 * volume / 20.0,
            ],
        ];
        for i in 0..4 {
            let node_i = element[i] as usize;
            let Some(row) = reduction.node_map[node_i] else {
                continue;
            };
            for j in 0..4 {
                let node_j = element[j] as usize;
                let Some(col) = reduction.node_map[node_j] else {
                    continue;
                };
                let m_ij = local_mass[i][j];
                let fb_i = &field_blocks[node_i];
                let fb_j = &field_blocks[node_j];

                // Block mass matrix: M_block = diag(M, M)
                mass[(row, col)] += m_ij;
                mass[(row + n, col + n)] += m_ij;

                // Exchange stiffness: isotropic → K_11 and K_22 only
                if plan.enable_exchange {
                    let ex = topology.element_stiffness[element_index][i][j];
                    stiffness[(row, col)] += ex;
                    stiffness[(row + n, col + n)] += ex;
                }

                // Field shift contribution (averaged between nodes i and j):
                // K_11: h_11 shift
                let h11 = 0.5 * (fb_i[0] + fb_j[0]);
                stiffness[(row, col)] += m_ij * h11;

                // K_22: h_22 shift
                let h22 = 0.5 * (fb_i[3] + fb_j[3]);
                stiffness[(row + n, col + n)] += m_ij * h22;

                // K_12: cross-coupling e2 → e1
                let h12 = 0.5 * (fb_i[1] + fb_j[1]);
                stiffness[(row, col + n)] += m_ij * h12;

                // K_21: cross-coupling e1 → e2
                let h21 = 0.5 * (fb_i[2] + fb_j[2]);
                stiffness[(row + n, col)] += m_ij * h21;
            }
        }
    }

    // Apply surface anisotropy to both diagonal blocks
    add_surface_anisotropy_2x2(plan, topology, reduction, equilibrium, &mut stiffness, n);
    // Apply DMI to both diagonal blocks
    add_dmi_2x2(plan, topology, reduction, &mut stiffness, n);

    (stiffness, mass)
}

fn assemble_projected_scalar_operator_complex(
    plan: &FemEigenPlanIR,
    topology: &MeshTopology,
    reduction: &ReductionMap,
    observables: &EffectiveFieldObservables,
    equilibrium: &[Vector3],
) -> (Vec<Vec<Complex64>>, Vec<Vec<Complex64>>) {
    let active_count = reduction.active_nodes.len();
    let mut stiffness = vec![vec![Complex64::new(0.0, 0.0); active_count]; active_count];
    let mut mass = vec![vec![Complex64::new(0.0, 0.0); active_count]; active_count];
    let parallel_field = observables
        .magnetization
        .iter()
        .enumerate()
        .map(|(index, m)| {
            let mut selected_field = [0.0, 0.0, 0.0];
            if plan.enable_exchange {
                selected_field = add_vector(selected_field, observables.exchange_field[index]);
            }
            if plan.enable_demag {
                selected_field = add_vector(selected_field, observables.demag_field[index]);
            }
            if plan.external_field.is_some() {
                selected_field = add_vector(selected_field, observables.external_field[index]);
            }
            // Volume anisotropy (uniaxial + cubic) contribution to parallel field
            selected_field = add_vector(selected_field, volume_anisotropy_field(*m, plan));
            dot(*m, selected_field).max(0.0)
        })
        .collect::<Vec<_>>();

    for (element_index, element) in topology.elements.iter().enumerate() {
        if !topology.magnetic_element_mask[element_index] {
            continue;
        }
        let volume = topology.element_volumes[element_index];
        let local_mass = [
            [
                2.0 * volume / 20.0,
                volume / 20.0,
                volume / 20.0,
                volume / 20.0,
            ],
            [
                volume / 20.0,
                2.0 * volume / 20.0,
                volume / 20.0,
                volume / 20.0,
            ],
            [
                volume / 20.0,
                volume / 20.0,
                2.0 * volume / 20.0,
                volume / 20.0,
            ],
            [
                volume / 20.0,
                volume / 20.0,
                volume / 20.0,
                2.0 * volume / 20.0,
            ],
        ];
        let local_shift = [
            parallel_field[element[0] as usize],
            parallel_field[element[1] as usize],
            parallel_field[element[2] as usize],
            parallel_field[element[3] as usize],
        ];
        for i in 0..4 {
            let node_i = element[i] as usize;
            let Some(row) = reduction.node_map[node_i] else {
                continue;
            };
            let phase_i = reduction.node_phases[node_i];
            for j in 0..4 {
                let node_j = element[j] as usize;
                let Some(col) = reduction.node_map[node_j] else {
                    continue;
                };
                let phase_j = reduction.node_phases[node_j];
                let coeff = phase_i.conj() * phase_j;
                mass[row][col] += coeff * local_mass[i][j];
                if plan.enable_exchange {
                    stiffness[row][col] += coeff * topology.element_stiffness[element_index][i][j];
                }
                let shift = 0.5 * (local_shift[i] + local_shift[j]);
                stiffness[row][col] += coeff * (local_mass[i][j] * shift);
            }
        }
    }

    add_surface_anisotropy_complex(plan, topology, reduction, equilibrium, &mut stiffness);
    add_dmi_complex(plan, reduction, &mut stiffness, plan.k_sampling.as_ref());
    (stiffness, mass)
}

fn regularize_periodic_mass_if_needed(
    mut mass: DMatrix<f64>,
    spin_wave_bc: &SpinWaveBoundaryConditionIR,
) -> DMatrix<f64> {
    if !matches!(spin_wave_bc.kind(), SpinWaveBoundaryKindIR::Periodic) {
        return mass;
    }
    if mass.nrows() == 0 {
        return mass;
    }
    for row in 0..mass.nrows() {
        for col in (row + 1)..mass.ncols() {
            let sym = 0.5 * (mass[(row, col)] + mass[(col, row)]);
            mass[(row, col)] = sym;
            mass[(col, row)] = sym;
        }
    }
    if mass.clone().cholesky().is_some() {
        return mass;
    }
    let mut scale = 0.0_f64;
    for row in 0..mass.nrows() {
        for col in 0..mass.ncols() {
            scale = scale.max(mass[(row, col)].abs());
        }
    }
    let scale = scale.max(1.0);
    for factor in [1e-12_f64, 1e-10, 1e-8, 1e-6] {
        let epsilon = scale * factor;
        let mut trial = mass.clone();
        for index in 0..trial.nrows() {
            trial[(index, index)] += epsilon;
        }
        if trial.clone().cholesky().is_some() {
            return trial;
        }
    }
    mass
}

fn solve_real_symmetric_eigenpairs(
    plan: &FemEigenPlanIR,
    stiffness: DMatrix<f64>,
    mass: DMatrix<f64>,
) -> Result<Vec<RealEigenpair>, RunError> {
    let mass = regularize_periodic_mass_if_needed(mass, &plan.spin_wave_bc);
    let cholesky = mass.clone().cholesky().ok_or_else(|| RunError {
        message: "FEM eigen mass matrix is singular; ensure the magnetic mesh has active volume"
            .to_string(),
    })?;
    let l = cholesky.l();
    let l_inv = l.clone().try_inverse().ok_or_else(|| RunError {
        message: "failed to invert FEM eigen mass Cholesky factor".to_string(),
    })?;
    let transformed = &l_inv * stiffness * l_inv.transpose();
    let spectrum = SymmetricEigen::new(transformed);
    let mut eigenpairs = spectrum
        .eigenvalues
        .iter()
        .enumerate()
        .filter_map(|(index, value)| {
            if !value.is_finite() {
                return None;
            }
            let lifted = l_inv.transpose() * spectrum.eigenvectors.column(index).into_owned();
            Some(RealEigenpair {
                eigenvalue_real: *value,
                eigenvalue_imag: 0.0,
                vector: normalize_real_mode(lifted, &mass, &plan.normalization),
            })
        })
        .collect::<Vec<_>>();
    sort_and_truncate_real_modes(plan, &mut eigenpairs);
    Ok(eigenpairs)
}

/// Sparse LOBPCG eigensolver for large problems.
///
/// Converts dense-assembled stiffness and mass matrices to CSR format
/// and uses LOBPCG to find the k smallest eigenpairs in O(k·n·iter) time
/// instead of the O(n³) dense path.
fn solve_real_symmetric_eigenpairs_sparse(
    plan: &FemEigenPlanIR,
    stiffness: DMatrix<f64>,
    mass: DMatrix<f64>,
    num_modes: usize,
) -> Result<Vec<RealEigenpair>, RunError> {
    let mass = regularize_periodic_mass_if_needed(mass, &plan.spin_wave_bc);
    let n = stiffness.nrows();

    // Convert to CSR (drop entries < 1e-15 to preserve sparsity)
    let k_csr = dmatrix_to_csr(&stiffness, 1e-15);
    let m_csr = dmatrix_to_csr(&mass, 1e-15);

    // LOBPCG: find num_modes smallest eigenpairs
    let tol = 1e-8;
    let max_iter = (n * 2).max(500).min(5000) as u32;
    let (sparse_pairs, report) = lobpcg_generalized(&k_csr, &m_csr, num_modes, tol, max_iter)
        .map_err(|e| RunError {
            message: format!("sparse LOBPCG eigensolver failed: {}", e.message),
        })?;

    eprintln!(
        "info: sparse LOBPCG converged={} in {} iterations (max_residual={:.2e}, {} modes)",
        report.converged,
        report.iterations,
        report.max_residual,
        sparse_pairs.len()
    );

    // Convert SparseEigenpair to RealEigenpair
    let mut eigenpairs: Vec<RealEigenpair> = sparse_pairs
        .into_iter()
        .filter(|ep| ep.eigenvalue.is_finite())
        .map(|ep| {
            let vec = DVector::from_vec(ep.vector);
            RealEigenpair {
                eigenvalue_real: ep.eigenvalue,
                eigenvalue_imag: 0.0,
                vector: normalize_real_mode(vec, &mass, &plan.normalization),
            }
        })
        .collect();

    sort_and_truncate_real_modes(plan, &mut eigenpairs);
    Ok(eigenpairs)
}

fn solve_complex_hermitian_eigenpairs(
    plan: &FemEigenPlanIR,
    stiffness: Vec<Vec<Complex64>>,
    mass: Vec<Vec<Complex64>>,
) -> Result<Vec<ComplexEigenpair>, RunError> {
    let (stiffness_block, mass_block) = complex_pair_to_real_blocks(&stiffness, &mass);
    let mass_block = regularize_periodic_mass_if_needed(mass_block, &plan.spin_wave_bc);
    let cholesky = mass_block.clone().cholesky().ok_or_else(|| RunError {
        message: "Floquet FEM eigen mass block is singular; check periodic node-pair metadata"
            .to_string(),
    })?;
    let l = cholesky.l();
    let l_inv = l.clone().try_inverse().ok_or_else(|| RunError {
        message: "failed to invert Floquet FEM eigen mass block Cholesky factor".to_string(),
    })?;
    let transformed = &l_inv * stiffness_block * l_inv.transpose();
    let spectrum = SymmetricEigen::new(transformed);
    let active_count = stiffness.len();
    let mut eigenpairs = Vec::new();
    for (index, value) in spectrum.eigenvalues.iter().enumerate() {
        if !value.is_finite() {
            continue;
        }
        let lifted = l_inv.transpose() * spectrum.eigenvectors.column(index).into_owned();
        let complex = real_block_vector_to_complex(&lifted, active_count);
        let normalized = normalize_complex_mode(&complex, &mass, &plan.normalization);
        eigenpairs.push(ComplexEigenpair {
            eigenvalue_real: *value,
            eigenvalue_imag: 0.0,
            vector: normalized,
        });
    }
    sort_and_truncate_complex_modes(plan, &mut eigenpairs);
    Ok(eigenpairs)
}

fn complex_pair_to_real_blocks(
    stiffness: &[Vec<Complex64>],
    mass: &[Vec<Complex64>],
) -> (DMatrix<f64>, DMatrix<f64>) {
    let n = stiffness.len();
    let mut a = DMatrix::<f64>::zeros(2 * n, 2 * n);
    let mut b = DMatrix::<f64>::zeros(2 * n, 2 * n);
    for row in 0..n {
        for col in 0..n {
            let k = stiffness[row][col];
            let m = mass[row][col];
            a[(row, col)] = k.re;
            a[(row, col + n)] = -k.im;
            a[(row + n, col)] = k.im;
            a[(row + n, col + n)] = k.re;

            b[(row, col)] = m.re;
            b[(row, col + n)] = -m.im;
            b[(row + n, col)] = m.im;
            b[(row + n, col + n)] = m.re;
        }
    }
    (a, b)
}

fn real_block_vector_to_complex(vector: &DVector<f64>, active_count: usize) -> Vec<Complex64> {
    (0..active_count)
        .map(|index| Complex64::new(vector[index], vector[index + active_count]))
        .collect()
}

fn normalize_real_mode(
    vector: DVector<f64>,
    mass: &DMatrix<f64>,
    normalization: &EigenNormalizationIR,
) -> DVector<f64> {
    match normalization {
        EigenNormalizationIR::UnitL2 => {
            let projected = mass * &vector;
            let norm = vector.dot(&projected).sqrt().max(1e-30);
            vector / norm
        }
        EigenNormalizationIR::UnitMaxAmplitude => {
            let max_value = vector
                .iter()
                .fold(0.0_f64, |acc, value| acc.max(value.abs()))
                .max(1e-30);
            vector / max_value
        }
    }
}

fn normalize_complex_mode(
    vector: &[Complex64],
    mass: &[Vec<Complex64>],
    normalization: &EigenNormalizationIR,
) -> Vec<Complex64> {
    match normalization {
        EigenNormalizationIR::UnitL2 => {
            let mut quadratic = Complex64::new(0.0, 0.0);
            for row in 0..vector.len() {
                for col in 0..vector.len() {
                    quadratic += vector[row].conj() * mass[row][col] * vector[col];
                }
            }
            let scale = quadratic.re.max(1e-30).sqrt();
            vector.iter().map(|value| *value / scale).collect()
        }
        EigenNormalizationIR::UnitMaxAmplitude => {
            let scale = vector
                .iter()
                .fold(0.0_f64, |acc, value| acc.max(value.norm()))
                .max(1e-30);
            vector.iter().map(|value| *value / scale).collect()
        }
    }
}

fn sort_and_truncate_real_modes(plan: &FemEigenPlanIR, eigenpairs: &mut Vec<RealEigenpair>) {
    match &plan.target {
        fullmag_ir::EigenTargetIR::Lowest => eigenpairs.sort_by(|lhs, rhs| {
            lhs.eigenvalue_real
                .partial_cmp(&rhs.eigenvalue_real)
                .unwrap_or(std::cmp::Ordering::Equal)
        }),
        fullmag_ir::EigenTargetIR::Nearest { frequency_hz } => eigenpairs.sort_by(|lhs, rhs| {
            let lhs_freq = frequency_from_eigenvalue(plan.gyromagnetic_ratio, lhs.eigenvalue_real);
            let rhs_freq = frequency_from_eigenvalue(plan.gyromagnetic_ratio, rhs.eigenvalue_real);
            (lhs_freq - *frequency_hz)
                .abs()
                .partial_cmp(&(rhs_freq - *frequency_hz).abs())
                .unwrap_or(std::cmp::Ordering::Equal)
        }),
    }
    let requested_count = usize::try_from(plan.count).unwrap_or(usize::MAX);
    eigenpairs.truncate(requested_count.min(eigenpairs.len()));
}

fn sort_and_truncate_complex_modes(plan: &FemEigenPlanIR, eigenpairs: &mut Vec<ComplexEigenpair>) {
    match &plan.target {
        fullmag_ir::EigenTargetIR::Lowest => eigenpairs.sort_by(|lhs, rhs| {
            lhs.eigenvalue_real
                .partial_cmp(&rhs.eigenvalue_real)
                .unwrap_or(std::cmp::Ordering::Equal)
        }),
        fullmag_ir::EigenTargetIR::Nearest { frequency_hz } => eigenpairs.sort_by(|lhs, rhs| {
            let lhs_freq = frequency_from_eigenvalue(plan.gyromagnetic_ratio, lhs.eigenvalue_real);
            let rhs_freq = frequency_from_eigenvalue(plan.gyromagnetic_ratio, rhs.eigenvalue_real);
            (lhs_freq - *frequency_hz)
                .abs()
                .partial_cmp(&(rhs_freq - *frequency_hz).abs())
                .unwrap_or(std::cmp::Ordering::Equal)
        }),
    }
    let requested_count = usize::try_from(plan.count).unwrap_or(usize::MAX);
    eigenpairs.truncate(requested_count.min(eigenpairs.len()));
}

fn add_surface_anisotropy_real(
    plan: &FemEigenPlanIR,
    _topology: &MeshTopology,
    reduction: &ReductionMap,
    equilibrium: &[Vector3],
    stiffness: &mut DMatrix<f64>,
) {
    let Some((axis, coefficient)) = surface_anisotropy_config(plan) else {
        return;
    };
    for face in &plan.mesh.boundary_faces {
        let local = triangle_surface_matrix(face, &plan.mesh.nodes, axis, equilibrium, coefficient);
        for i in 0..3 {
            let Some(row) = reduction.node_map[face[i] as usize] else {
                continue;
            };
            for j in 0..3 {
                let Some(col) = reduction.node_map[face[j] as usize] else {
                    continue;
                };
                stiffness[(row, col)] += local[i][j];
            }
        }
    }
}

fn add_surface_anisotropy_complex(
    plan: &FemEigenPlanIR,
    _topology: &MeshTopology,
    reduction: &ReductionMap,
    equilibrium: &[Vector3],
    stiffness: &mut [Vec<Complex64>],
) {
    let Some((axis, coefficient)) = surface_anisotropy_config(plan) else {
        return;
    };
    for face in &plan.mesh.boundary_faces {
        let local = triangle_surface_matrix(face, &plan.mesh.nodes, axis, equilibrium, coefficient);
        for i in 0..3 {
            let node_i = face[i] as usize;
            let Some(row) = reduction.node_map[node_i] else {
                continue;
            };
            let phase_i = reduction.node_phases[node_i];
            for j in 0..3 {
                let node_j = face[j] as usize;
                let Some(col) = reduction.node_map[node_j] else {
                    continue;
                };
                let phase_j = reduction.node_phases[node_j];
                stiffness[row][col] += phase_i.conj() * phase_j * local[i][j];
            }
        }
    }
}

fn add_dmi_real(
    plan: &FemEigenPlanIR,
    topology: &MeshTopology,
    reduction: &ReductionMap,
    stiffness: &mut DMatrix<f64>,
) {
    let scale = plan.interfacial_dmi.map(f64::abs).unwrap_or(0.0)
        + plan.bulk_dmi.map(f64::abs).unwrap_or(0.0);
    if scale <= 0.0 {
        return;
    }
    let coeff =
        scale / (MU0 * plan.material.saturation_magnetisation.max(1e-30) * plan.hmax.max(1e-30));
    for (element_index, element) in topology.elements.iter().enumerate() {
        if !topology.magnetic_element_mask[element_index] {
            continue;
        }
        let gradients = &topology.grad_phi[element_index];
        for i in 0..4 {
            let Some(row) = reduction.node_map[element[i] as usize] else {
                continue;
            };
            for j in 0..4 {
                let Some(col) = reduction.node_map[element[j] as usize] else {
                    continue;
                };
                let skew = coeff
                    * (gradients[i][0] * gradients[j][1] - gradients[i][1] * gradients[j][0])
                    * topology.element_volumes[element_index];
                stiffness[(row, col)] += skew;
            }
        }
    }
}

fn add_dmi_complex(
    plan: &FemEigenPlanIR,
    reduction: &ReductionMap,
    stiffness: &mut [Vec<Complex64>],
    k_sampling: Option<&KSamplingIR>,
) {
    let interfacial = plan.interfacial_dmi.unwrap_or(0.0);
    let bulk = plan.bulk_dmi.unwrap_or(0.0);
    if interfacial == 0.0 && bulk == 0.0 {
        return;
    }
    let k = match k_sampling {
        Some(KSamplingIR::Single { k_vector }) => *k_vector,
        Some(KSamplingIR::Path { .. }) => [0.0, 0.0, 0.0],
        None => [0.0, 0.0, 0.0],
    };
    let ms = plan.material.saturation_magnetisation.max(1e-30);
    let interfacial_coeff = interfacial / (MU0 * ms);
    let bulk_coeff = bulk / (MU0 * ms);
    let nonreciprocal_shift = interfacial_coeff * (k[0] + k[1]) + bulk_coeff * (k[0] + k[1] + k[2]);
    if nonreciprocal_shift.abs() <= 0.0 {
        return;
    }
    for index in 0..reduction.active_nodes.len() {
        stiffness[index][index] += Complex64::new(nonreciprocal_shift, 0.0);
    }
}

/// Apply surface anisotropy to the 2×2 block operator.
/// Both diagonal blocks (K_11, K_22) get the same surface anisotropy term.
fn add_surface_anisotropy_2x2(
    plan: &FemEigenPlanIR,
    _topology: &MeshTopology,
    reduction: &ReductionMap,
    equilibrium: &[Vector3],
    stiffness: &mut DMatrix<f64>,
    n: usize,
) {
    let Some((axis, coefficient)) = surface_anisotropy_config(plan) else {
        return;
    };
    for face in &plan.mesh.boundary_faces {
        let local = triangle_surface_matrix(face, &plan.mesh.nodes, axis, equilibrium, coefficient);
        for i in 0..3 {
            let Some(row) = reduction.node_map[face[i] as usize] else {
                continue;
            };
            for j in 0..3 {
                let Some(col) = reduction.node_map[face[j] as usize] else {
                    continue;
                };
                // Both diagonal blocks
                stiffness[(row, col)] += local[i][j];
                stiffness[(row + n, col + n)] += local[i][j];
            }
        }
    }
}

/// Apply DMI to the 2×2 block operator.
/// Both diagonal blocks get the same DMI skew contribution.
fn add_dmi_2x2(
    plan: &FemEigenPlanIR,
    topology: &MeshTopology,
    reduction: &ReductionMap,
    stiffness: &mut DMatrix<f64>,
    n: usize,
) {
    let scale = plan.interfacial_dmi.map(f64::abs).unwrap_or(0.0)
        + plan.bulk_dmi.map(f64::abs).unwrap_or(0.0);
    if scale <= 0.0 {
        return;
    }
    let coeff =
        scale / (MU0 * plan.material.saturation_magnetisation.max(1e-30) * plan.hmax.max(1e-30));
    for (element_index, element) in topology.elements.iter().enumerate() {
        if !topology.magnetic_element_mask[element_index] {
            continue;
        }
        let gradients = &topology.grad_phi[element_index];
        for i in 0..4 {
            let Some(row) = reduction.node_map[element[i] as usize] else {
                continue;
            };
            for j in 0..4 {
                let Some(col) = reduction.node_map[element[j] as usize] else {
                    continue;
                };
                let skew = coeff
                    * (gradients[i][0] * gradients[j][1] - gradients[i][1] * gradients[j][0])
                    * topology.element_volumes[element_index];
                // Both diagonal blocks
                stiffness[(row, col)] += skew;
                stiffness[(row + n, col + n)] += skew;
            }
        }
    }
}

/// Compute the uniaxial anisotropy effective field at a single node.
///
/// H_uni = (2 Ku1 / (mu0 Ms)) (m · u) u + (4 Ku2 / (mu0 Ms)) (m · u)^3 u
fn uniaxial_anisotropy_field(m: Vector3, plan: &FemEigenPlanIR) -> Vector3 {
    let ku1 = match plan.material.uniaxial_anisotropy {
        Some(k) if k.abs() > 0.0 => k,
        _ => return [0.0, 0.0, 0.0],
    };
    let axis = normalize_vector(plan.material.anisotropy_axis.unwrap_or([0.0, 0.0, 1.0]));
    let ms = plan.material.saturation_magnetisation.max(1e-30);
    let ku2 = plan.material.uniaxial_anisotropy_k2.unwrap_or(0.0);
    let m_dot_u = dot(m, axis);
    let coeff =
        2.0 * ku1 / (MU0 * ms) * m_dot_u + 4.0 * ku2 / (MU0 * ms) * m_dot_u * m_dot_u * m_dot_u;
    scale_vector(axis, coeff)
}

/// Compute the cubic anisotropy effective field at a single node.
///
/// First-order cubic: H_c1 = -(2 Kc1 / (mu0 Ms)) ∂E/∂m  with the standard
/// cubic energy density  E = Kc1 (m1² m2² + m2² m3² + m1² m3²) + ...
fn cubic_anisotropy_field(m: Vector3, plan: &FemEigenPlanIR) -> Vector3 {
    let kc1 = match plan.material.cubic_anisotropy_kc1 {
        Some(k) if k.abs() > 0.0 => k,
        _ => return [0.0, 0.0, 0.0],
    };
    let c1 = normalize_vector(
        plan.material
            .cubic_anisotropy_axis1
            .unwrap_or([1.0, 0.0, 0.0]),
    );
    let c2 = normalize_vector(
        plan.material
            .cubic_anisotropy_axis2
            .unwrap_or([0.0, 1.0, 0.0]),
    );
    let c3 = cross(c1, c2);
    let kc2 = plan.material.cubic_anisotropy_kc2.unwrap_or(0.0);
    let ms = plan.material.saturation_magnetisation.max(1e-30);

    let m1 = dot(m, c1);
    let m2 = dot(m, c2);
    let m3 = dot(m, c3);

    let pf = 2.0 / (MU0 * ms);

    // dE/dm_i for cubic energy E = Kc1 (m1² m2² + m2² m3² + m1² m3²)
    //                             + Kc2 (m1² m2² m3²)
    let g1 = -pf * (kc1 * m1 * (m2 * m2 + m3 * m3) + kc2 * m1 * m2 * m2 * m3 * m3);
    let g2 = -pf * (kc1 * m2 * (m1 * m1 + m3 * m3) + kc2 * m2 * m1 * m1 * m3 * m3);
    let g3 = -pf * (kc1 * m3 * (m1 * m1 + m2 * m2) + kc2 * m3 * m1 * m1 * m2 * m2);

    [
        g1 * c1[0] + g2 * c2[0] + g3 * c3[0],
        g1 * c1[1] + g2 * c2[1] + g3 * c3[1],
        g1 * c1[2] + g2 * c2[2] + g3 * c3[2],
    ]
}

/// Compute the total volume anisotropy field (uniaxial + cubic) at a node.
fn volume_anisotropy_field(m: Vector3, plan: &FemEigenPlanIR) -> Vector3 {
    add_vector(
        uniaxial_anisotropy_field(m, plan),
        cubic_anisotropy_field(m, plan),
    )
}

fn surface_anisotropy_config(plan: &FemEigenPlanIR) -> Option<(Vector3, f64)> {
    let ks = plan.spin_wave_bc.surface_anisotropy_ks()?;
    let axis = normalize_vector(plan.spin_wave_bc.surface_anisotropy_axis()?);
    let coefficient = ks / (MU0 * plan.material.saturation_magnetisation.max(1e-30));
    Some((axis, coefficient))
}

fn triangle_surface_matrix(
    face: &[u32; 3],
    nodes: &[[f64; 3]],
    axis: Vector3,
    equilibrium: &[Vector3],
    coefficient: f64,
) -> [[f64; 3]; 3] {
    let p0 = nodes[face[0] as usize];
    let p1 = nodes[face[1] as usize];
    let p2 = nodes[face[2] as usize];
    let area = 0.5 * norm(cross(sub(p1, p0), sub(p2, p0)));
    let local_mass = [
        [2.0 * area / 12.0, area / 12.0, area / 12.0],
        [area / 12.0, 2.0 * area / 12.0, area / 12.0],
        [area / 12.0, area / 12.0, 2.0 * area / 12.0],
    ];
    let alignment = face
        .iter()
        .map(|node| {
            let m = equilibrium[*node as usize];
            1.0 - dot(m, axis).powi(2)
        })
        .sum::<f64>()
        / 3.0;
    let mut local = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            local[i][j] = coefficient * alignment.max(0.0) * local_mass[i][j];
        }
    }
    local
}

fn tangent_bases(equilibrium: &[Vector3]) -> Vec<(Vector3, Vector3)> {
    equilibrium
        .iter()
        .map(|m| {
            let reference = if m[2].abs() < 0.9 {
                [0.0, 0.0, 1.0]
            } else {
                [0.0, 1.0, 0.0]
            };
            let e1 = normalize_vector(cross(reference, *m));
            let e2 = normalize_vector(cross(*m, e1));
            (e1, e2)
        })
        .collect()
}

fn project_real_mode_to_tangent_basis(
    total_nodes: usize,
    active_nodes: &[usize],
    amplitudes: &DVector<f64>,
    bases: &[(Vector3, Vector3)],
) -> (Vec<Vector3>, Vec<Vector3>, Vec<f64>, Vec<f64>, f64) {
    let mut real = vec![[0.0, 0.0, 0.0]; total_nodes];
    let mut imag = vec![[0.0, 0.0, 0.0]; total_nodes];
    let mut amplitude = vec![0.0; total_nodes];
    let mut phase = vec![0.0; total_nodes];
    let mut max_amplitude: f64 = 0.0;

    for (reduced_index, node_index) in active_nodes.iter().enumerate() {
        let a = amplitudes[reduced_index];
        let (e1, e2) = bases[*node_index];
        real[*node_index] = scale_vector(e1, a);
        imag[*node_index] = scale_vector(e2, a);
        amplitude[*node_index] = a.abs();
        phase[*node_index] = if a >= 0.0 { 0.0 } else { std::f64::consts::PI };
        max_amplitude = max_amplitude.max(a.abs());
    }

    (real, imag, amplitude, phase, max_amplitude)
}

fn project_complex_mode_to_tangent_basis(
    total_nodes: usize,
    active_nodes: &[usize],
    amplitudes: &[Complex64],
    bases: &[(Vector3, Vector3)],
) -> (Vec<Vector3>, Vec<Vector3>, Vec<f64>, Vec<f64>, f64) {
    let mut real = vec![[0.0, 0.0, 0.0]; total_nodes];
    let mut imag = vec![[0.0, 0.0, 0.0]; total_nodes];
    let mut amplitude = vec![0.0; total_nodes];
    let mut phase = vec![0.0; total_nodes];
    let mut max_amplitude: f64 = 0.0;

    for (reduced_index, node_index) in active_nodes.iter().enumerate() {
        let value = amplitudes[reduced_index];
        let (e1, e2) = bases[*node_index];
        real[*node_index] = scale_vector(e1, value.re);
        imag[*node_index] = scale_vector(e2, value.im);
        amplitude[*node_index] = value.norm();
        phase[*node_index] = value.arg();
        max_amplitude = max_amplitude.max(amplitude[*node_index]);
    }

    (real, imag, amplitude, phase, max_amplitude)
}

/// Project a 2×2 block eigenvector back to full 3D mode fields.
///
/// The eigenvector has 2N elements: [u1_0..u1_{N-1}, u2_0..u2_{N-1}]
/// where u1 are the e1-component amplitudes and u2 are the e2-component
/// amplitudes.  The 3D mode field is dm = u1*e1 + u2*e2.
fn project_2x2_mode_to_tangent_basis(
    total_nodes: usize,
    active_nodes: &[usize],
    amplitudes: &DVector<f64>,
    bases: &[(Vector3, Vector3)],
) -> (Vec<Vector3>, Vec<Vector3>, Vec<f64>, Vec<f64>, f64) {
    let n = active_nodes.len();
    let mut real = vec![[0.0, 0.0, 0.0]; total_nodes];
    let mut imag = vec![[0.0, 0.0, 0.0]; total_nodes];
    let mut amplitude = vec![0.0; total_nodes];
    let mut phase = vec![0.0; total_nodes];
    let mut max_amplitude: f64 = 0.0;

    for (reduced_index, node_index) in active_nodes.iter().enumerate() {
        let u1 = amplitudes[reduced_index]; // e1 component
        let u2 = amplitudes[reduced_index + n]; // e2 component
        let (e1, e2) = bases[*node_index];

        // Real part of the mode: dm_real = u1*e1 + u2*e2
        real[*node_index] = add_vector(scale_vector(e1, u1), scale_vector(e2, u2));
        // Imaginary part: for the undamped real-symmetric case, the mode
        // oscillates as dm ~ cos(ωt)*u, so the "imaginary" part is the
        // orthogonal tangent component (circular/elliptical precession).
        imag[*node_index] = add_vector(scale_vector(e1, -u2), scale_vector(e2, u1));
        let amp = (u1 * u1 + u2 * u2).sqrt();
        amplitude[*node_index] = amp;
        phase[*node_index] = u2.atan2(u1);
        max_amplitude = max_amplitude.max(amp);
    }

    (real, imag, amplitude, phase, max_amplitude)
}

fn frequency_from_eigenvalue(gyromagnetic_ratio: f64, eigenvalue: f64) -> f64 {
    angular_frequency_from_eigenvalue(gyromagnetic_ratio, eigenvalue) / (2.0 * std::f64::consts::PI)
}

fn angular_frequency_from_eigenvalue(gyromagnetic_ratio: f64, eigenvalue: f64) -> f64 {
    // gyromagnetic_ratio is μ₀γ (≈ 2.211e5 m/(A·s)), eigenvalue is H_eff in A/m.
    // ω = μ₀γ · H_eff — no additional μ₀ factor needed.
    gyromagnetic_ratio * eigenvalue.max(0.0)
}

fn angular_frequency_from_raw_eigenvalue(gyromagnetic_ratio: f64, eigenvalue: f64) -> f64 {
    gyromagnetic_ratio * eigenvalue
}

fn requested_mode_indices(outputs: &[OutputIR]) -> std::collections::BTreeSet<u32> {
    outputs
        .iter()
        .filter_map(|output| {
            if let OutputIR::EigenMode { indices, .. } = output {
                Some(indices.iter().copied())
            } else {
                None
            }
        })
        .flatten()
        .collect()
}

fn json_artifact(
    path: impl Into<String>,
    value: &serde_json::Value,
) -> Result<AuxiliaryArtifact, RunError> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| RunError {
        message: format!("failed to serialize eigen artifact: {}", error),
    })?;
    Ok(AuxiliaryArtifact {
        relative_path: path.into(),
        bytes,
    })
}

fn normalization_label(normalization: EigenNormalizationIR) -> &'static str {
    match normalization {
        EigenNormalizationIR::UnitL2 => "unit_l2",
        EigenNormalizationIR::UnitMaxAmplitude => "unit_max_amplitude",
    }
}

fn damping_policy_label(policy: EigenDampingPolicyIR) -> &'static str {
    match policy {
        EigenDampingPolicyIR::Ignore => "ignore",
        EigenDampingPolicyIR::Include => "include",
    }
}

fn damping_imaginary_factor(damping: f64, policy: EigenDampingPolicyIR) -> f64 {
    match policy {
        EigenDampingPolicyIR::Ignore => 0.0,
        EigenDampingPolicyIR::Include => -(damping.abs() / (1.0 + damping * damping)),
    }
}

fn spin_wave_bc_label(bc: SpinWaveBoundaryConditionIR) -> &'static str {
    match bc.kind() {
        SpinWaveBoundaryKindIR::Free => "free",
        SpinWaveBoundaryKindIR::Pinned => "pinned",
        SpinWaveBoundaryKindIR::Periodic => "periodic",
        SpinWaveBoundaryKindIR::Floquet => "floquet",
        SpinWaveBoundaryKindIR::SurfaceAnisotropy => "surface_anisotropy",
    }
}

fn spin_wave_bc_json(bc: &SpinWaveBoundaryConditionIR) -> serde_json::Value {
    serde_json::json!({
        "kind": spin_wave_bc_label(bc.clone()),
        "boundary_pair_id": bc.boundary_pair_id(),
        "surface_anisotropy_ks": bc.surface_anisotropy_ks(),
        "surface_anisotropy_axis": bc.surface_anisotropy_axis(),
    })
}

fn solver_kind_label(plan: &FemEigenPlanIR) -> &'static str {
    if matches!(plan.spin_wave_bc.kind(), SpinWaveBoundaryKindIR::Floquet) {
        "cpu_phase_reduced_floquet"
    } else {
        match (plan.operator.kind, plan.damping_policy) {
            (fullmag_ir::EigenOperatorIR::Full2x2, EigenDampingPolicyIR::Ignore) => {
                "cpu_full_2x2_symmetric"
            }
            (fullmag_ir::EigenOperatorIR::Full2x2, EigenDampingPolicyIR::Include) => {
                "cpu_full_2x2_damped"
            }
            (_, EigenDampingPolicyIR::Ignore) => "cpu_reference_symmetric",
            (_, EigenDampingPolicyIR::Include) => "cpu_generalized_eigen",
        }
    }
}

fn solver_notes(plan: &FemEigenPlanIR, complex_reduction: bool, use_sparse: bool) -> &'static str {
    if complex_reduction {
        "phase-aware periodic reduction on a real doubled Hermitian block"
    } else if use_sparse && matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
        "sparse LOBPCG on full 2×2 Herring-Kittel block operator (2N DOF)"
    } else if use_sparse {
        "sparse LOBPCG iterative eigensolver for large DOF systems"
    } else if matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
        "full 2×2 Herring-Kittel block operator in tangent plane (2N DOF)"
    } else if matches!(plan.damping_policy, EigenDampingPolicyIR::Include) {
        "damping artifacts use first-order alpha linewidth correction over the CPU reference eigenbasis"
    } else {
        "cpu reference symmetric eigen solve"
    }
}

fn solver_capabilities(
    plan: &FemEigenPlanIR,
    complex_reduction: bool,
    use_sparse: bool,
) -> Vec<&'static str> {
    let mut capabilities = vec!["cpu_reference_eigen", "artifact_backed_analyze"];
    if use_sparse {
        capabilities.push("sparse_lobpcg");
    }
    if matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
        capabilities.push("full_2x2_herring_kittel");
    }
    match plan.spin_wave_bc.kind() {
        SpinWaveBoundaryKindIR::Free => capabilities.push("free_bc"),
        SpinWaveBoundaryKindIR::Pinned => capabilities.push("pinned_bc"),
        SpinWaveBoundaryKindIR::Periodic => capabilities.push("periodic_zero_phase"),
        SpinWaveBoundaryKindIR::Floquet => capabilities.push("floquet_phase_reduction"),
        SpinWaveBoundaryKindIR::SurfaceAnisotropy => {
            capabilities.push("surface_anisotropy_boundary_term")
        }
    }
    if plan.enable_exchange {
        capabilities.push("exchange");
    }
    if plan.enable_demag {
        match resolved_demag_realization(plan)
            .unwrap_or(fullmag_ir::ResolvedFemDemagIR::PoissonRobin)
        {
            fullmag_ir::ResolvedFemDemagIR::PoissonDirichlet => {
                capabilities.push("demag_poisson_dirichlet")
            }
            fullmag_ir::ResolvedFemDemagIR::PoissonRobin => {
                capabilities.push("demag_poisson_robin")
            }
        }
    }
    if plan.external_field.is_some() {
        capabilities.push("zeeman");
    }
    if plan.interfacial_dmi.is_some() {
        capabilities.push("interfacial_dmi");
    }
    if plan.bulk_dmi.is_some() {
        capabilities.push("bulk_dmi");
    }
    if matches!(plan.damping_policy, EigenDampingPolicyIR::Include) {
        capabilities.push("damping_linewidth_metadata");
    }
    if complex_reduction {
        capabilities.push("complex_mode_projection");
    }
    capabilities
}

fn solver_limitations(
    plan: &FemEigenPlanIR,
    complex_reduction: bool,
    use_sparse: bool,
) -> Vec<&'static str> {
    let mut limitations = Vec::new();
    if use_sparse {
        limitations.push("sparse_lobpcg_may_miss_modes_near_degeneracy");
    }
    if !matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
        limitations.push("scalar_projection_only_accurate_for_uniform_equilibrium");
    }
    if matches!(plan.damping_policy, EigenDampingPolicyIR::Include) {
        limitations.push("no_generalized_qz_backend");
        limitations.push("damping_is_first_order_linewidth_correction");
    }
    if complex_reduction {
        limitations.push("floquet_uses_phase_reduced_hermitian_block");
    }
    if plan.interfacial_dmi.is_some() || plan.bulk_dmi.is_some() {
        limitations.push("dmi_operator_is_cpu_first_reference_approximation");
    }
    if matches!(
        plan.spin_wave_bc.kind(),
        SpinWaveBoundaryKindIR::SurfaceAnisotropy
    ) {
        limitations.push("surface_anisotropy_requires_exposed_boundary_faces");
    }
    limitations
}

fn resolved_demag_realization(plan: &FemEigenPlanIR) -> Option<fullmag_ir::ResolvedFemDemagIR> {
    if !plan.enable_demag {
        return None;
    }
    Some(
        plan.demag_realization
            .unwrap_or(fullmag_ir::ResolvedFemDemagIR::PoissonRobin),
    )
}

fn demag_realization_label(realization: fullmag_ir::ResolvedFemDemagIR) -> &'static str {
    match realization {
        fullmag_ir::ResolvedFemDemagIR::PoissonDirichlet => "poisson_dirichlet",
        fullmag_ir::ResolvedFemDemagIR::PoissonRobin => "poisson_robin",
    }
}

fn equilibrium_source_json(equilibrium: &EquilibriumSourceIR) -> serde_json::Value {
    match equilibrium {
        EquilibriumSourceIR::Provided => serde_json::json!({ "kind": "provided" }),
        EquilibriumSourceIR::RelaxedInitialState => {
            serde_json::json!({ "kind": "relaxed_initial_state" })
        }
        EquilibriumSourceIR::Artifact { path } => {
            serde_json::json!({ "kind": "artifact", "path": path })
        }
    }
}

fn k_vector_json(k_sampling: Option<&KSamplingIR>) -> serde_json::Value {
    match k_sampling {
        Some(KSamplingIR::Single { k_vector }) => serde_json::json!(k_vector),
        Some(KSamplingIR::Path { .. }) => serde_json::json!([0.0, 0.0, 0.0]),
        None => serde_json::Value::Null,
    }
}

fn dispersion_csv(k_sampling: Option<&KSamplingIR>, modes: &serde_json::Value) -> String {
    let k_vector = match k_sampling {
        Some(KSamplingIR::Single { k_vector }) => *k_vector,
        Some(KSamplingIR::Path { .. }) => [0.0, 0.0, 0.0],
        None => [0.0, 0.0, 0.0],
    };
    let mut csv = String::from("mode_index,kx,ky,kz,frequency_hz,angular_frequency_rad_per_s\n");
    if let Some(entries) = modes.as_array() {
        for entry in entries {
            csv.push_str(&format!(
                "{},{:.15e},{:.15e},{:.15e},{:.15e},{:.15e}\n",
                entry["index"].as_u64().unwrap_or(0),
                k_vector[0],
                k_vector[1],
                k_vector[2],
                entry["frequency_hz"].as_f64().unwrap_or(0.0),
                entry["angular_frequency_rad_per_s"].as_f64().unwrap_or(0.0),
            ));
        }
    }
    csv
}

fn dot(a: Vector3, b: Vector3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: Vector3, b: Vector3) -> Vector3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn norm(a: Vector3) -> f64 {
    dot(a, a).sqrt()
}

fn normalize_vector(a: Vector3) -> Vector3 {
    let magnitude = norm(a);
    if magnitude <= 1e-30 {
        [1.0, 0.0, 0.0]
    } else {
        scale_vector(a, 1.0 / magnitude)
    }
}

fn scale_vector(a: Vector3, factor: f64) -> Vector3 {
    [a[0] * factor, a[1] * factor, a[2] * factor]
}

fn add_vector(a: Vector3, b: Vector3) -> Vector3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

/// Classify the dominant polarization character of a spin-wave mode.
///
/// Heuristics (all for the real scalar LLG linearization):
/// - `"uniform"`: mode amplitude is spatially homogeneous (Kittel / macrospin mode).
///   Criterion: mean amplitude over active nodes ≥ 60 % of the maximum.
/// - `"op"`: equilibrium is predominantly out-of-plane (|⟨mz⟩| > 0.7 ⇒ mz-dominated modes).
/// - `"ip"`: default for in-plane equilibrium configurations.
/// - `"mixed"`: fallback when the active node set is empty or max amplitude is degenerate.
fn classify_polarization(
    amplitude: &[f64],
    active_nodes: &[usize],
    equilibrium: &[Vector3],
    max_amplitude: f64,
) -> &'static str {
    if active_nodes.is_empty() || max_amplitude < 1e-30 {
        return "mixed";
    }

    let n = active_nodes.len() as f64;

    // Spatial uniformity: mean / max over active nodes.
    let mean_amplitude: f64 = active_nodes.iter().map(|&i| amplitude[i]).sum::<f64>() / n;
    if mean_amplitude / max_amplitude > 0.6 {
        return "uniform";
    }

    // Determine equilibrium orientation: average |mz| over active nodes.
    let mean_mz_abs: f64 = if equilibrium.len() > *active_nodes.iter().max().unwrap_or(&0) {
        active_nodes
            .iter()
            .map(|&i| equilibrium[i][2].abs())
            .sum::<f64>()
            / n
    } else {
        0.0
    };

    if mean_mz_abs > 0.7 {
        "op"
    } else {
        "ip"
    }
}
