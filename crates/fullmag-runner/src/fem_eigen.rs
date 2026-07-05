use crate::eigen::assembly_scalar::AssembledScalarOperator;
use fullmag_engine::fem::{FemLlgProblem, MeshTopology};
use fullmag_engine::fem_sparse::{lobpcg_generalized_with_progress, CsrMatrix};
use fullmag_engine::periodic::constraints::PeriodicDofMap;
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
use crate::relaxation::{relaxation_converged, RelaxationEnergyPlateauWindow};
use crate::types::{
    AuxiliaryArtifact, ExecutedRun, RunError, RunResult, RunStatus, StepAction, StepStats,
};
use crate::ExecutionProvenance;

/// Internal relaxation timestep for equilibrium preparation in eigen analysis.
/// This is NOT the user's simulation dt — it is a fixed internal parameter
/// used only for pre-eigen relaxation (small enough for safe LLG convergence).
const RELAX_DT: f64 = 1e-13;
const RELAX_MAX_STEPS: u64 = 4_000;

/// DOF threshold above which LOBPCG sparse eigensolver is used instead of
/// the dense O(n³) path. Below this, Cholesky + SymmetricEigen is used.
const SPARSE_EIGEN_THRESHOLD: usize = 3_000;
const FLOQUET_DYNAMIC_DEMAG_UNSUPPORTED: &str = "dynamic demag for Floquet periodic FEM is not implemented yet. Disable demag or use k=0/free boundary.";
const NATIVE_CPU_MODAL_WINDOW_SOLVER_KIND: &str = "slepc_multi_shift_invert_production_cpu_dense";
const TANGENT_FRAME_IDENTITY_TOLERANCE: f64 = 1.0e-8;

#[derive(Debug, Clone)]
pub(crate) struct FemEigenProgress {
    pub phase: &'static str,
    pub phase_index: u32,
    pub phase_count: u32,
    pub percent: f64,
    pub solver_kind: &'static str,
    pub active_nodes: usize,
    pub effective_dof: usize,
    pub requested_modes: usize,
    pub candidate_modes: usize,
    pub computed_modes: usize,
    pub iteration: Option<u32>,
    pub max_iterations: Option<u32>,
    pub residual: Option<f64>,
    pub warning: Option<&'static str>,
}

pub(crate) type FemEigenProgressCallback<'a> =
    dyn FnMut(FemEigenProgress) -> StepAction + Send + 'a;

fn emit_fem_eigen_progress(
    progress: &mut Option<&mut FemEigenProgressCallback<'_>>,
    event: FemEigenProgress,
) -> Result<(), RunError> {
    if let Some(callback) = progress.as_deref_mut() {
        match callback(event) {
            StepAction::Continue => {}
            StepAction::Stop | StepAction::Pause => {
                return Err(RunError {
                    message: "FEM eigen solve was interrupted by runtime control".to_string(),
                });
            }
        }
    }
    Ok(())
}

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

pub(crate) fn reject_unsupported_floquet_dynamic_demag(
    spin_wave_bc: &SpinWaveBoundaryConditionIR,
    include_demag: bool,
) -> Result<(), RunError> {
    if include_demag && matches!(spin_wave_bc.kind(), SpinWaveBoundaryKindIR::Floquet) {
        return Err(RunError {
            message: FLOQUET_DYNAMIC_DEMAG_UNSUPPORTED.to_string(),
        });
    }
    Ok(())
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
    residual_absolute_l2: f64,
    residual_relative_l2: f64,
    residual_linf: f64,
    mass_norm: f64,
    vector: DVector<f64>,
}

#[derive(Debug, Clone)]
struct ComplexEigenpair {
    eigenvalue_real: f64,
    eigenvalue_imag: f64,
    residual_absolute_l2: f64,
    residual_relative_l2: f64,
    residual_linf: f64,
    mass_norm: f64,
    vector: Vec<Complex64>,
}

#[derive(Debug, Clone)]
struct NativeModalEigenpair {
    frequency_hz: f64,
    omega_rad_s: f64,
    eigenvalue_real: f64,
    eigenvalue_imag: f64,
    residual_absolute_l2: f64,
    residual_relative_l2: f64,
    residual_linf: f64,
    mass_norm: f64,
    vector: Vec<Complex64>,
}

#[derive(Debug, Clone)]
struct NativeBlochFloquetDensePayload {
    physical_complex_dof: usize,
    stiffness: DMatrix<f64>,
    gyrotropic_row_major: Vec<f64>,
    tangent_mass: DMatrix<f64>,
    physical_mass: Vec<Vec<Complex64>>,
}

#[derive(Debug, Clone, Copy)]
struct TangentLeakageSummary {
    mean_abs: f64,
    max_abs: f64,
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
            let (residual_absolute_l2, residual_relative_l2, residual_linf) =
                generalized_residual_norms(stiffness, mass, val, &normalized);
            Some(RealEigenpair {
                eigenvalue_real: val,
                eigenvalue_imag: 0.0,
                residual_absolute_l2,
                residual_relative_l2,
                residual_linf,
                mass_norm: generalized_mass_norm(mass, &normalized),
                vector: normalized,
            })
        })
        .collect();

    sort_and_truncate_real_modes(plan, &mut eigenpairs);
    Ok(eigenpairs)
}

#[allow(dead_code)]
pub(crate) fn execute_baseline_fem_eigen(
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
) -> Result<ExecutedRun, RunError> {
    execute_fem_eigen_inner(plan, outputs, false, false, None)
}

#[allow(dead_code)]
pub(crate) fn execute_baseline_fem_eigen_with_progress(
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    progress: &mut FemEigenProgressCallback<'_>,
) -> Result<ExecutedRun, RunError> {
    execute_fem_eigen_inner(plan, outputs, false, false, Some(progress))
}

pub(crate) fn execute_cpu_fem_eigen(
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
) -> Result<ExecutedRun, RunError> {
    execute_fem_eigen_inner(
        plan,
        outputs,
        false,
        native_cpu_modal_window_enabled(plan),
        None,
    )
}

pub(crate) fn execute_cpu_fem_eigen_with_progress(
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    progress: &mut FemEigenProgressCallback<'_>,
) -> Result<ExecutedRun, RunError> {
    execute_fem_eigen_inner(
        plan,
        outputs,
        false,
        native_cpu_modal_window_enabled(plan),
        Some(progress),
    )
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
    let _ = outputs;
    let native_result = native_fem::solve_native_modal_eigen(native_fem::NativeModalEigenRequest {
        mesh_asset_id: &plan.mesh_name,
        equilibrium_source_kind: native_modal_equilibrium_source_kind(&plan.equilibrium),
        gamma_rad_s_t: plan.gyromagnetic_ratio / MU0,
        mu0_t_m_a: MU0,
        alpha: plan.material.damping,
        include_exchange: plan.enable_exchange,
        include_demag: plan.enable_demag,
        demag_realization: resolved_demag_realization(plan).map(|value| value.provenance_name()),
        damping_policy: native_modal_damping_policy(plan.damping_policy),
        spin_wave_bc_kind: native_modal_spin_wave_bc_kind(&plan.spin_wave_bc),
        k_vector_rad_m: native_modal_k_vector(plan.k_sampling.as_ref()),
        operator_diagnostics_json: None,
        requested_mode_count: plan.count as i32,
        target_kind: native_modal_target_kind(&plan.target),
        target_frequency_hz: native_modal_target_frequency_hz(&plan.target),
        frequency_min_hz: native_modal_frequency_min_hz(&plan.target),
        frequency_max_hz: native_modal_frequency_max_hz(&plan.target),
        residual_tolerance: 1.0e-8,
        max_outer_iterations: 300,
        max_linear_iterations: 1000,
        output_directory: None,
        write_partial_artifacts: false,
        completeness_policy: 0,
        eigensolver_family: 0,
        spectral_transform_kind: 0,
        cancel_requested: None,
        progress_callback: None,
        tiny_validation_problem: None,
        mfem_operator_problem: None,
        mfem_sparse_operator_problem: None,
    })
    .map_err(|message| RunError { message })?;

    Err(RunError {
        message: format!(
            "native FEM modal_eigen production path is unavailable: {} (diagnostics_json={})",
            native_result.error_message, native_result.diagnostics_json
        ),
    })
}

fn native_modal_equilibrium_source_kind(equilibrium: &EquilibriumSourceIR) -> &'static str {
    match equilibrium {
        EquilibriumSourceIR::Provided => "provided",
        EquilibriumSourceIR::RelaxedInitialState => "relax",
        EquilibriumSourceIR::Artifact { .. } => "artifact",
    }
}

fn native_modal_spin_wave_bc_kind(spin_wave_bc: &SpinWaveBoundaryConditionIR) -> &'static str {
    match spin_wave_bc.kind() {
        SpinWaveBoundaryKindIR::Free => "free",
        SpinWaveBoundaryKindIR::Pinned => "pinned",
        SpinWaveBoundaryKindIR::Periodic => "periodic",
        SpinWaveBoundaryKindIR::Floquet => "floquet",
        SpinWaveBoundaryKindIR::SurfaceAnisotropy => "surface_anisotropy",
    }
}

fn native_modal_damping_policy(damping_policy: EigenDampingPolicyIR) -> &'static str {
    match damping_policy {
        EigenDampingPolicyIR::Ignore => "ignore",
        EigenDampingPolicyIR::Include => "include",
    }
}

fn native_modal_target_kind(target: &fullmag_ir::EigenTargetIR) -> &'static str {
    match target {
        fullmag_ir::EigenTargetIR::Lowest => "lowest",
        fullmag_ir::EigenTargetIR::Nearest { .. } => "nearest_frequency",
        fullmag_ir::EigenTargetIR::FrequencyWindow { .. } => "frequency_window",
    }
}

fn native_modal_target_frequency_hz(target: &fullmag_ir::EigenTargetIR) -> f64 {
    match target {
        fullmag_ir::EigenTargetIR::Nearest { frequency_hz } => *frequency_hz,
        _ => 0.0,
    }
}

fn native_modal_frequency_min_hz(target: &fullmag_ir::EigenTargetIR) -> f64 {
    match target {
        fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz, ..
        } => *frequency_min_hz,
        _ => 0.0,
    }
}

fn native_modal_frequency_max_hz(target: &fullmag_ir::EigenTargetIR) -> f64 {
    match target {
        fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_max_hz, ..
        } => *frequency_max_hz,
        _ => 0.0,
    }
}

fn native_modal_k_vector(k_sampling: Option<&KSamplingIR>) -> Option<&[f64]> {
    match k_sampling {
        Some(KSamplingIR::Single { k_vector }) => Some(&k_vector[..]),
        _ => None,
    }
}

fn native_modal_floquet_periodic_pairs<'a>(
    plan: &'a FemEigenPlanIR,
    topology: &'a MeshTopology,
) -> Result<Vec<native_fem::NativeModalEigenFloquetPeriodicPair<'a>>, RunError> {
    if !matches!(plan.spin_wave_bc.kind(), SpinWaveBoundaryKindIR::Floquet) {
        return Ok(Vec::new());
    }
    let Some(KSamplingIR::Single { k_vector }) = plan.k_sampling.as_ref() else {
        return Ok(Vec::new());
    };
    let requested_pair_ids = plan.spin_wave_bc.boundary_pair_ids();
    let mut pairs = Vec::new();
    for (pair_id, node_a, node_b) in &topology.periodic_node_pairs {
        if !requested_pair_ids.is_empty()
            && !requested_pair_ids
                .iter()
                .any(|requested| requested == pair_id)
        {
            continue;
        }
        let translation_m = topology
            .periodic_boundary_pairs
            .iter()
            .find(|(boundary_pair_id, _)| boundary_pair_id == pair_id)
            .and_then(|(_, translation)| *translation)
            .ok_or_else(|| RunError {
                message: format!(
                    "Floquet modal periodic pair '{pair_id}' requires mesh.periodic_boundary_pairs translation metadata"
                ),
            })?;
        let phase_rad = match plan.spin_wave_bc.phase_convention() {
            fullmag_ir::PhaseConventionIR::ExpMinusIKDotDeltaR => {
                -(k_vector[0] * translation_m[0]
                    + k_vector[1] * translation_m[1]
                    + k_vector[2] * translation_m[2])
            }
        };
        pairs.push(native_fem::NativeModalEigenFloquetPeriodicPair {
            pair_id: Some(pair_id.as_str()),
            node_a: u64::from(*node_a),
            node_b: u64::from(*node_b),
            translation_m: Some(translation_m),
            phase_rad: Some(phase_rad),
        });
    }
    Ok(pairs)
}

fn native_cpu_modal_window_enabled(plan: &FemEigenPlanIR) -> bool {
    let base_window_supported =
        matches!(
            plan.target,
            fullmag_ir::EigenTargetIR::FrequencyWindow { .. }
        ) && matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2)
            && matches!(
                plan.damping_policy,
                fullmag_ir::EigenDampingPolicyIR::Ignore
            );
    base_window_supported
        && ((matches!(
            plan.spin_wave_bc.kind(),
            fullmag_ir::SpinWaveBoundaryKindIR::Free
        ) && is_gamma_k_sampling(plan.k_sampling.as_ref()))
            || native_cpu_modal_window_has_bloch_floquet_payload_path(plan))
}

fn native_cpu_modal_window_has_bloch_floquet_payload_path(plan: &FemEigenPlanIR) -> bool {
    if !matches!(
        plan.spin_wave_bc.kind(),
        fullmag_ir::SpinWaveBoundaryKindIR::Floquet
    ) || !matches!(
        plan.k_sampling.as_ref(),
        Some(fullmag_ir::KSamplingIR::Single { .. })
    ) {
        return false;
    }
    let requested_pair_ids = plan.spin_wave_bc.boundary_pair_ids();
    if requested_pair_ids.is_empty() {
        return false;
    }
    requested_pair_ids.iter().any(|pair_id| {
        let has_nodes = plan
            .mesh
            .periodic_node_pairs
            .iter()
            .any(|pair| pair.pair_id == *pair_id);
        let has_translation = plan
            .mesh
            .periodic_boundary_pairs
            .iter()
            .any(|pair| pair.pair_id == *pair_id && pair.translation.is_some());
        has_nodes && has_translation
    })
}

pub(crate) fn native_cpu_modal_window_rejection_reason(
    plan: &FemEigenPlanIR,
) -> Option<&'static str> {
    if native_cpu_modal_window_enabled(plan) {
        return None;
    }
    if matches!(
        plan.target,
        fullmag_ir::EigenTargetIR::FrequencyWindow { .. }
    ) && matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2)
        && matches!(
            plan.damping_policy,
            fullmag_ir::EigenDampingPolicyIR::Ignore
        )
        && matches!(
            plan.spin_wave_bc.kind(),
            fullmag_ir::SpinWaveBoundaryKindIR::Floquet
        )
        && k_sampling_contains_nonzero(plan.k_sampling.as_ref())
    {
        return Some("production_cpu_modal_nonzero_k_floquet_operator_missing");
    }
    None
}

pub(crate) fn insert_native_cpu_modal_window_rejection_contract(
    object: &mut serde_json::Map<String, serde_json::Value>,
) {
    object.insert(
        "required_operator_contract".to_string(),
        serde_json::json!("bloch_floquet_tangent_operator_with_periodic_pairs"),
    );
    object.insert(
        "required_operator_payload_kind".to_string(),
        serde_json::json!("bloch_floquet_tangent_operator"),
    );
    object.insert(
        "modal_periodic_pair_contract_available".to_string(),
        serde_json::json!(false),
    );
}

fn execute_fem_eigen_inner(
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    try_gpu: bool,
    use_native_modal_production: bool,
    mut progress: Option<&mut FemEigenProgressCallback<'_>>,
) -> Result<ExecutedRun, RunError> {
    if plan.precision != fullmag_ir::ExecutionPrecision::Double {
        return Err(RunError {
            message: if try_gpu {
                "execution_precision='single' is not executable in the FEM eigen GPU path; single-precision GPU eigensolve is not yet implemented"
            } else {
                "execution_precision='single' is not executable in the FEM eigen CPU path; use 'double'"
            }
            .to_string(),
        });
    }
    reject_unsupported_floquet_dynamic_demag(&plan.spin_wave_bc, plan.operator.include_demag)?;
    let num_modes = plan.count as usize;

    emit_fem_eigen_progress(
        &mut progress,
        FemEigenProgress {
            phase: "materializing_equilibrium",
            phase_index: 1,
            phase_count: 5,
            percent: 5.0,
            solver_kind: solver_kind_label(plan),
            active_nodes: 0,
            effective_dof: 0,
            requested_modes: num_modes,
            candidate_modes: num_modes,
            computed_modes: 0,
            iteration: None,
            max_iterations: None,
            residual: None,
            warning: None,
        },
    )?;

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

    let progress_solver_kind = if use_sparse {
        "cpu_sparse_lobpcg"
    } else {
        solver_kind_label(plan)
    };
    let dense_warning = (effective_dof > 3000 && !use_sparse)
        .then_some("dense_o_n3_eigensolve_without_iteration_progress");
    emit_fem_eigen_progress(
        &mut progress,
        FemEigenProgress {
            phase: "assembling_operator",
            phase_index: 2,
            phase_count: 5,
            percent: 20.0,
            solver_kind: progress_solver_kind,
            active_nodes: active_n,
            effective_dof,
            requested_modes: num_modes,
            candidate_modes: num_modes,
            computed_modes: 0,
            iteration: None,
            max_iterations: None,
            residual: None,
            warning: dense_warning,
        },
    )?;

    let bases = tangent_bases(&equilibrium);
    let mut dense_orthogonality = None;

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
        if use_native_modal_production {
            return execute_native_cpu_modal_window_from_full_2x2(
                plan,
                outputs,
                initial_magnetization,
                equilibrium,
                observables,
                relaxation_steps,
                &reduction,
                &bases,
                &stiffness,
                &mass,
                progress,
                active_n,
                effective_dof,
            );
        }
        if use_sparse {
            emit_fem_eigen_progress(
                &mut progress,
                FemEigenProgress {
                    phase: "solving_sparse_lobpcg",
                    phase_index: 3,
                    phase_count: 5,
                    percent: 35.0,
                    solver_kind: progress_solver_kind,
                    active_nodes: active_n,
                    effective_dof,
                    requested_modes: num_modes,
                    candidate_modes: sparse_lobpcg_candidate_count(
                        &plan.target,
                        num_modes,
                        effective_dof,
                    ),
                    computed_modes: 0,
                    iteration: Some(0),
                    max_iterations: None,
                    residual: None,
                    warning: None,
                },
            )?;
            solve_real_symmetric_eigenpairs_sparse(
                plan,
                &stiffness,
                &mass,
                num_modes,
                progress.as_deref_mut(),
                active_n,
                effective_dof,
            )?
        } else {
            emit_fem_eigen_progress(
                &mut progress,
                FemEigenProgress {
                    phase: "solving_dense",
                    phase_index: 3,
                    phase_count: 5,
                    percent: 35.0,
                    solver_kind: progress_solver_kind,
                    active_nodes: active_n,
                    effective_dof,
                    requested_modes: num_modes,
                    candidate_modes: num_modes,
                    computed_modes: 0,
                    iteration: None,
                    max_iterations: None,
                    residual: None,
                    warning: dense_warning,
                },
            )?;
            let eigenpairs = solve_real_symmetric_eigenpairs(plan, &stiffness, &mass)?;
            dense_orthogonality = Some(orthogonality_rows_json(&mass, &eigenpairs));
            eigenpairs
        }
    } else {
        let operator = assemble_projected_scalar_operator_real(
            plan,
            topology,
            &reduction,
            &observables,
            &equilibrium,
        );
        operator
            .validate_petsc_slepc_binding()
            .map_err(|message| RunError {
                message: format!("FEM eigen scalar operator is not bindable: {message}"),
            })?;
        if try_gpu {
            // Attempt GPU dense generalized solve; return error if GPU was
            // explicitly requested but is unavailable or fails.
            match gpu_solve_real_symmetric_eigenpairs(plan, &operator.stiffness, &operator.mass) {
                Ok(pairs) => {
                    eprintln!(
                        "info: FEM eigen GPU solve succeeded ({} modes)",
                        pairs.len()
                    );
                    dense_orthogonality = Some(orthogonality_rows_json(&operator.mass, &pairs));
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
            emit_fem_eigen_progress(
                &mut progress,
                FemEigenProgress {
                    phase: "solving_sparse_lobpcg",
                    phase_index: 3,
                    phase_count: 5,
                    percent: 35.0,
                    solver_kind: progress_solver_kind,
                    active_nodes: active_n,
                    effective_dof,
                    requested_modes: num_modes,
                    candidate_modes: sparse_lobpcg_candidate_count(
                        &plan.target,
                        num_modes,
                        effective_dof,
                    ),
                    computed_modes: 0,
                    iteration: Some(0),
                    max_iterations: None,
                    residual: None,
                    warning: None,
                },
            )?;
            solve_real_symmetric_eigenpairs_sparse(
                plan,
                &operator.stiffness,
                &operator.mass,
                num_modes,
                progress.as_deref_mut(),
                active_n,
                effective_dof,
            )?
        } else {
            emit_fem_eigen_progress(
                &mut progress,
                FemEigenProgress {
                    phase: "solving_dense",
                    phase_index: 3,
                    phase_count: 5,
                    percent: 35.0,
                    solver_kind: progress_solver_kind,
                    active_nodes: active_n,
                    effective_dof,
                    requested_modes: num_modes,
                    candidate_modes: num_modes,
                    computed_modes: 0,
                    iteration: None,
                    max_iterations: None,
                    residual: None,
                    warning: dense_warning,
                },
            )?;
            let eigenpairs =
                solve_real_symmetric_eigenpairs(plan, &operator.stiffness, &operator.mass)?;
            dense_orthogonality = Some(orthogonality_rows_json(&operator.mass, &eigenpairs));
            eigenpairs
        }
    };
    if use_sparse {
        solver_kind = "cpu_sparse_lobpcg";
    }
    let complex_eigenpairs = if complex_reduction {
        let (stiffness, mass) = if is_full_2x2 {
            assemble_projected_full_2x2_operator_complex(
                plan,
                topology,
                &reduction,
                &observables,
                &equilibrium,
                &bases,
            )
        } else {
            assemble_projected_scalar_operator_complex(
                plan,
                topology,
                &reduction,
                &observables,
                &equilibrium,
            )
        };
        if is_full_2x2 && use_native_modal_production {
            return execute_native_cpu_modal_window_from_bloch_floquet_complex(
                plan,
                outputs,
                initial_magnetization,
                equilibrium,
                observables,
                relaxation_steps,
                &reduction,
                &bases,
                &stiffness,
                &mass,
                progress,
                active_n,
                effective_dof,
            );
        }
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
    let gamma_rad_s_t = plan.gyromagnetic_ratio / MU0;
    let gamma0_rad_s_per_a_m = plan.gyromagnetic_ratio;
    let mu0_t_m_per_a = MU0;
    emit_fem_eigen_progress(
        &mut progress,
        FemEigenProgress {
            phase: "writing_artifacts",
            phase_index: 4,
            phase_count: 5,
            percent: 85.0,
            solver_kind: progress_solver_kind,
            active_nodes: active_n,
            effective_dof,
            requested_modes: num_modes,
            candidate_modes: num_modes,
            computed_modes: total_modes,
            iteration: None,
            max_iterations: None,
            residual: None,
            warning: None,
        },
    )?;

    for mode_index in 0..total_modes {
        let (
            eigenvalue_real,
            eigenvalue_imag,
            residual_absolute_l2,
            residual_relative_l2,
            residual_linf,
            mass_norm,
            real,
            imag,
            amplitude,
            phase,
            max_amplitude,
            norm,
        ) = if complex_reduction {
            let pair = &complex_eigenpairs[mode_index];
            let (real, imag, amplitude, phase, max_amplitude) = if is_full_2x2 {
                project_complex_2x2_mode_to_tangent_basis(
                    topology.n_nodes,
                    &reduction.active_nodes,
                    &pair.vector,
                    &bases,
                )
            } else {
                project_complex_mode_to_tangent_basis(
                    topology.n_nodes,
                    &reduction.active_nodes,
                    &pair.vector,
                    &bases,
                )
            };
            let norm = pair
                .vector
                .iter()
                .map(|value| value.norm_sqr())
                .sum::<f64>()
                .sqrt();
            (
                pair.eigenvalue_real,
                pair.eigenvalue_imag,
                pair.residual_absolute_l2,
                pair.residual_relative_l2,
                pair.residual_linf,
                pair.mass_norm,
                real,
                imag,
                amplitude,
                phase,
                max_amplitude,
                norm,
            )
        } else if is_full_2x2 {
            let pair = &real_eigenpairs[mode_index];
            let (real, imag, amplitude, phase, max_amplitude) = project_2x2_mode_to_tangent_basis(
                topology.n_nodes,
                &reduction.active_nodes,
                &pair.vector,
                &bases,
            );
            let norm = pair.vector.norm();
            (
                pair.eigenvalue_real,
                pair.eigenvalue_imag,
                pair.residual_absolute_l2,
                pair.residual_relative_l2,
                pair.residual_linf,
                pair.mass_norm,
                real,
                imag,
                amplitude,
                phase,
                max_amplitude,
                norm,
            )
        } else {
            let pair = &real_eigenpairs[mode_index];
            let (real, imag, amplitude, phase, max_amplitude) = project_real_mode_to_tangent_basis(
                topology.n_nodes,
                &reduction.active_nodes,
                &pair.vector,
                &bases,
            );
            let norm = pair.vector.norm();
            (
                pair.eigenvalue_real,
                pair.eigenvalue_imag,
                pair.residual_absolute_l2,
                pair.residual_relative_l2,
                pair.residual_linf,
                pair.mass_norm,
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
        let damping_included = matches!(plan.damping_policy, EigenDampingPolicyIR::Include);
        let phasor_convention = if damping_included {
            "exp_i_omega_t"
        } else {
            "not_applicable_real_reference"
        };
        let linewidth_fwhm_hz = 2.0 * frequency_imag_hz;
        let dominant_polarization = classify_polarization(
            &amplitude,
            &reduction.active_nodes,
            &equilibrium,
            max_amplitude,
        );
        let (tangent_leakage_mean_abs, tangent_leakage_max_abs) =
            mode_tangent_leakage(&equilibrium, &real, &imag);
        let mut mode_summary = serde_json::json!({
            "index": mode_index,
            "frequency_hz": frequency_hz,
            "frequency_real_hz": frequency_hz,
            "frequency_imag_hz": frequency_imag_hz,
            "angular_frequency_rad_per_s": angular_frequency_real,
            "omega_rad_s": angular_frequency_real,
            "angular_frequency_imag_rad_per_s": angular_frequency_imag,
            "eigenvalue_field_au_per_m": eigenvalue_real.max(0.0),
            "eigenvalue_real": eigenvalue_real,
            "eigenvalue_imag": eigenvalue_imag,
            "phasor_convention": phasor_convention,
            "eigenvalue_mapping": "omega_rad_s_eq_gamma0_rad_s_per_A_m_times_effective_field_lambda_A_per_m",
            "norm": norm,
            "max_amplitude": max_amplitude,
            "residual_norm": residual_absolute_l2,
            "residual_absolute_l2": residual_absolute_l2,
            "residual_relative_l2": residual_relative_l2,
            "residual_linf": residual_linf,
            "mass_norm": mass_norm,
            "tangent_leakage_mean_abs": tangent_leakage_mean_abs,
            "tangent_leakage_max_abs": tangent_leakage_max_abs,
            "gamma_rad_s_T": gamma_rad_s_t,
            "gamma0_rad_s_per_A_m": gamma0_rad_s_per_a_m,
            "mu0_T_m_per_A": mu0_t_m_per_a,
            "dominant_polarization": dominant_polarization,
            "k_vector": k_vector_json(plan.k_sampling.as_ref()),
        });
        if damping_included {
            if let Some(object) = mode_summary.as_object_mut() {
                object.insert(
                    "complex_frequency_convention".to_string(),
                    serde_json::json!("omega_complex = omega_r + i Gamma for exp(i omega t)"),
                );
                object.insert(
                    "damping_rate_hz".to_string(),
                    serde_json::json!(frequency_imag_hz),
                );
                object.insert(
                    "linewidth_fwhm_hz".to_string(),
                    serde_json::json!(linewidth_fwhm_hz),
                );
            }
        }
        modes_summary.push(mode_summary.clone());

        if requested_modes.contains(&(mode_index as u32)) {
            let mut payload = serde_json::json!({
                "index": mode_index,
                "frequency_hz": frequency_hz,
                "frequency_real_hz": frequency_hz,
                "frequency_imag_hz": frequency_imag_hz,
                "angular_frequency_rad_per_s": angular_frequency_real,
                "omega_rad_s": angular_frequency_real,
                "angular_frequency_imag_rad_per_s": angular_frequency_imag,
                "eigenvalue_real": eigenvalue_real,
                "eigenvalue_imag": eigenvalue_imag,
                "phasor_convention": phasor_convention,
                "eigenvalue_mapping": "omega_rad_s_eq_gamma0_rad_s_per_A_m_times_effective_field_lambda_A_per_m",
                "max_amplitude": max_amplitude,
                "residual_norm": residual_absolute_l2,
                "residual_absolute_l2": residual_absolute_l2,
                "residual_relative_l2": residual_relative_l2,
                "residual_linf": residual_linf,
                "mass_norm": mass_norm,
                "tangent_leakage_mean_abs": tangent_leakage_mean_abs,
                "tangent_leakage_max_abs": tangent_leakage_max_abs,
                "gamma_rad_s_T": gamma_rad_s_t,
                "gamma0_rad_s_per_A_m": gamma0_rad_s_per_a_m,
                "mu0_T_m_per_A": mu0_t_m_per_a,
                "normalization": normalization_label(plan.normalization),
                "damping_policy": damping_policy_label(plan.damping_policy),
                "solver_backend": "cpu_baseline_fem_eigen",
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
            if damping_included {
                if let Some(object) = payload.as_object_mut() {
                    object.insert(
                        "complex_frequency_convention".to_string(),
                        serde_json::json!("omega_complex = omega_r + i Gamma for exp(i omega t)"),
                    );
                    object.insert(
                        "damping_rate_hz".to_string(),
                        serde_json::json!(frequency_imag_hz),
                    );
                    object.insert(
                        "linewidth_fwhm_hz".to_string(),
                        serde_json::json!(linewidth_fwhm_hz),
                    );
                }
            }
            auxiliary_artifacts.push(json_artifact(
                format!("eigen/modes/mode_{mode_index:04}.json"),
                &payload,
            )?);
        }
    }

    let mut summary_payload = serde_json::json!({
        "study_kind": "eigenmodes",
        "solver_backend": "cpu_baseline_fem_eigen",
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
        "solver_diagnostics": {
            "dense_reference_oracle": !use_sparse && !complex_reduction,
            "algebraic_form": "reference_effective_field_generalized",
            "matrix_equation": "K u = lambda M u",
            "phasor_convention": "not_applicable_real_reference",
            "eigenvalue_mapping": "omega_rad_s = gamma0_rad_s_per_A_m * max(lambda_A_per_m, 0)",
            "frequency_mapping": "frequency_hz = omega_rad_s / (2*pi)",
            "production_gyrotropic_mapping": false,
            "residual_definition": "relative_residual = ||K u - lambda M u||_2 / (||K u||_2 + |lambda| * ||M u||_2)",
            "tangent_leakage_definition": "abs(m0 dot delta_m) over reconstructed real and imaginary mode vectors",
            "constants": {
                "gamma_rad_s_T": gamma_rad_s_t,
                "gamma0_rad_s_per_A_m": gamma0_rad_s_per_a_m,
                "mu0_T_m_per_A": mu0_t_m_per_a,
            },
            "orthogonality": dense_orthogonality,
        },
        "k_sampling": k_vector_json(plan.k_sampling.as_ref()),
        "relaxation_steps": relaxation_steps,
        "modes": modes_summary,
    });
    merge_modal_transport_diagnostics(
        &mut summary_payload["solver_diagnostics"],
        modal_tangent_transport_diagnostics(plan),
    );

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
        auxiliary_artifacts.push(AuxiliaryArtifact {
            relative_path: "eigen/dispersion.csv".to_string(),
            bytes: dispersion_v2_csv(plan.k_sampling.as_ref(), &summary_payload["modes"])
                .into_bytes(),
        });
    }
    write_eigen_v2_bundle(
        plan,
        &summary_payload,
        &requested_modes,
        &mut auxiliary_artifacts,
    )?;

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

    emit_fem_eigen_progress(
        &mut progress,
        FemEigenProgress {
            phase: "completed",
            phase_index: 5,
            phase_count: 5,
            percent: 100.0,
            solver_kind: progress_solver_kind,
            active_nodes: active_n,
            effective_dof,
            requested_modes: num_modes,
            candidate_modes: num_modes,
            computed_modes: total_modes,
            iteration: None,
            max_iterations: None,
            residual: None,
            warning: None,
        },
    )?;

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

fn execute_native_cpu_modal_window_from_full_2x2(
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    initial_magnetization: Vec<Vector3>,
    equilibrium: Vec<Vector3>,
    observables: EffectiveFieldObservables,
    relaxation_steps: u64,
    reduction: &ReductionMap,
    bases: &[(Vector3, Vector3)],
    stiffness_field: &DMatrix<f64>,
    mass: &DMatrix<f64>,
    mut progress: Option<&mut FemEigenProgressCallback<'_>>,
    active_nodes: usize,
    effective_dof: usize,
) -> Result<ExecutedRun, RunError> {
    emit_fem_eigen_progress(
        &mut progress,
        FemEigenProgress {
            phase: "solving_native_shift_invert",
            phase_index: 3,
            phase_count: 5,
            percent: 35.0,
            solver_kind: NATIVE_CPU_MODAL_WINDOW_SOLVER_KIND,
            active_nodes,
            effective_dof,
            requested_modes: plan.count as usize,
            candidate_modes: plan.count as usize,
            computed_modes: 0,
            iteration: Some(0),
            max_iterations: Some(300),
            residual: None,
            warning: None,
        },
    )?;

    let stiffness_omega = stiffness_field * plan.gyromagnetic_ratio;
    let stiffness_row_major = dmatrix_to_row_major(&stiffness_omega);
    let gyrotropic_row_major = gyrotropic_matrix_row_major_from_tangent_mass(mass, active_nodes)?;
    let tangent_mass_row_major = dmatrix_to_row_major(mass);
    let native_modal_topology = MeshTopology::from_ir(&plan.mesh).map_err(|error| RunError {
        message: format!("failed to build native modal Floquet pair topology: {error}"),
    })?;
    let native_floquet_periodic_pairs =
        native_modal_floquet_periodic_pairs(plan, &native_modal_topology)?;
    let native_result = native_fem::solve_native_modal_eigen(native_fem::NativeModalEigenRequest {
        mesh_asset_id: &plan.mesh_name,
        equilibrium_source_kind: native_modal_equilibrium_source_kind(&plan.equilibrium),
        gamma_rad_s_t: plan.gyromagnetic_ratio / MU0,
        mu0_t_m_a: MU0,
        alpha: plan.material.damping,
        include_exchange: plan.enable_exchange,
        include_demag: plan.enable_demag,
        demag_realization: resolved_demag_realization(plan).map(|value| value.provenance_name()),
        damping_policy: native_modal_damping_policy(plan.damping_policy),
        spin_wave_bc_kind: native_modal_spin_wave_bc_kind(&plan.spin_wave_bc),
        k_vector_rad_m: native_modal_k_vector(plan.k_sampling.as_ref()),
        operator_diagnostics_json: Some(
            "{\"schema_version\":\"frequency_domain_operator_diagnostics.v1\",\
             \"payload_kind\":\"rust_full_2x2_dense_operator\",\
             \"stiffness_units\":\"rad_s_inv\",\
             \"gyrotropic_form\":\"pencil_B=-G=[[0,M],[-M,0]]\"}",
        ),
        requested_mode_count: plan.count as i32,
        target_kind: native_modal_target_kind(&plan.target),
        target_frequency_hz: native_modal_target_frequency_hz(&plan.target),
        frequency_min_hz: native_modal_frequency_min_hz(&plan.target),
        frequency_max_hz: native_modal_frequency_max_hz(&plan.target),
        residual_tolerance: 1.0e-8,
        max_outer_iterations: 300,
        max_linear_iterations: 1000,
        output_directory: None,
        write_partial_artifacts: false,
        completeness_policy: 1,
        eigensolver_family: 1,
        spectral_transform_kind: 1,
        cancel_requested: None,
        progress_callback: None,
        tiny_validation_problem: None,
        mfem_operator_problem: Some(native_fem::NativeModalEigenMfemOperatorProblem {
            tangent_dof_count: stiffness_omega.nrows() as u64,
            stiffness_matrix_row_major: Some(&stiffness_row_major),
            gyrotropic_matrix_row_major: Some(&gyrotropic_row_major),
            mass_matrix_row_major: Some(&tangent_mass_row_major),
            phase_convention: native_fem::FrequencyDomainPhaseConvention::ExpIOmegaT,
            floquet_periodic_pairs: &native_floquet_periodic_pairs,
        }),
        mfem_sparse_operator_problem: None,
    })
    .map_err(|message| RunError { message })?;

    if native_result.status != native_fem::NativeFrequencyDomainStatus::Ok {
        return Err(RunError {
            message: format!(
                "native FEM modal_eigen production CPU solve failed: {} (diagnostics_json={})",
                native_result.error_message, native_result.diagnostics_json
            ),
        });
    }
    let solver_diagnostics = native_solver_diagnostics_json(plan, &native_result.diagnostics_json)?;
    let modes = native_modal_modes_from_result_json(
        plan,
        &native_result.result_json,
        &stiffness_omega,
        &gyrotropic_row_major,
        mass,
    )?;
    if modes.is_empty() {
        return Err(RunError {
            message: "native FEM modal_eigen production CPU solve returned no modes".to_string(),
        });
    }

    emit_fem_eigen_progress(
        &mut progress,
        FemEigenProgress {
            phase: "writing_artifacts",
            phase_index: 4,
            phase_count: 5,
            percent: 85.0,
            solver_kind: NATIVE_CPU_MODAL_WINDOW_SOLVER_KIND,
            active_nodes,
            effective_dof,
            requested_modes: plan.count as usize,
            candidate_modes: modes.len(),
            computed_modes: modes.len(),
            iteration: None,
            max_iterations: None,
            residual: modes
                .iter()
                .map(|mode| mode.residual_relative_l2)
                .reduce(f64::max),
            warning: None,
        },
    )?;

    let auxiliary_artifacts = native_modal_artifacts(
        plan,
        outputs,
        &equilibrium,
        reduction,
        bases,
        &modes,
        solver_diagnostics,
        relaxation_steps,
    )?;

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

    emit_fem_eigen_progress(
        &mut progress,
        FemEigenProgress {
            phase: "completed",
            phase_index: 5,
            phase_count: 5,
            percent: 100.0,
            solver_kind: NATIVE_CPU_MODAL_WINDOW_SOLVER_KIND,
            active_nodes,
            effective_dof,
            requested_modes: plan.count as usize,
            candidate_modes: modes.len(),
            computed_modes: modes.len(),
            iteration: None,
            max_iterations: None,
            residual: None,
            warning: None,
        },
    )?;

    Ok(ExecutedRun {
        result: RunResult {
            status: RunStatus::Completed,
            steps: vec![stats],
            final_magnetization: equilibrium,
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
        provenance: native_modal_execution_provenance(plan),
    })
}

fn execute_native_cpu_modal_window_from_bloch_floquet_complex(
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    initial_magnetization: Vec<Vector3>,
    equilibrium: Vec<Vector3>,
    observables: EffectiveFieldObservables,
    relaxation_steps: u64,
    reduction: &ReductionMap,
    bases: &[(Vector3, Vector3)],
    stiffness: &[Vec<Complex64>],
    mass: &[Vec<Complex64>],
    mut progress: Option<&mut FemEigenProgressCallback<'_>>,
    active_nodes: usize,
    effective_dof: usize,
) -> Result<ExecutedRun, RunError> {
    emit_fem_eigen_progress(
        &mut progress,
        FemEigenProgress {
            phase: "solving_native_shift_invert",
            phase_index: 3,
            phase_count: 5,
            percent: 35.0,
            solver_kind: NATIVE_CPU_MODAL_WINDOW_SOLVER_KIND,
            active_nodes,
            effective_dof,
            requested_modes: plan.count as usize,
            candidate_modes: plan.count as usize,
            computed_modes: 0,
            iteration: Some(0),
            max_iterations: Some(300),
            residual: None,
            warning: None,
        },
    )?;

    let payload = native_bloch_floquet_dense_payload_from_complex_pair(stiffness, mass)?;
    let payload = NativeBlochFloquetDensePayload {
        physical_complex_dof: payload.physical_complex_dof,
        stiffness: payload.stiffness * plan.gyromagnetic_ratio,
        gyrotropic_row_major: payload.gyrotropic_row_major,
        tangent_mass: payload.tangent_mass,
        physical_mass: payload.physical_mass,
    };
    let stiffness_row_major = dmatrix_to_row_major(&payload.stiffness);
    let tangent_mass_row_major = dmatrix_to_row_major(&payload.tangent_mass);
    let native_modal_topology = MeshTopology::from_ir(&plan.mesh).map_err(|error| RunError {
        message: format!("failed to build native modal Bloch/Floquet pair topology: {error}"),
    })?;
    let native_floquet_periodic_pairs =
        native_modal_floquet_periodic_pairs(plan, &native_modal_topology)?;
    let native_result = native_fem::solve_native_modal_eigen(native_fem::NativeModalEigenRequest {
        mesh_asset_id: &plan.mesh_name,
        equilibrium_source_kind: native_modal_equilibrium_source_kind(&plan.equilibrium),
        gamma_rad_s_t: plan.gyromagnetic_ratio / MU0,
        mu0_t_m_a: MU0,
        alpha: plan.material.damping,
        include_exchange: plan.enable_exchange,
        include_demag: plan.enable_demag,
        demag_realization: resolved_demag_realization(plan).map(|value| value.provenance_name()),
        damping_policy: native_modal_damping_policy(plan.damping_policy),
        spin_wave_bc_kind: native_modal_spin_wave_bc_kind(&plan.spin_wave_bc),
        k_vector_rad_m: native_modal_k_vector(plan.k_sampling.as_ref()),
        operator_diagnostics_json: Some(
            "{\"schema_version\":\"frequency_domain_operator_diagnostics.v1\",\
             \"payload_kind\":\"bloch_floquet_tangent_operator\",\
             \"stiffness_units\":\"rad_s_inv\",\
             \"gyrotropic_form\":\"pencil_B=-G=[[0,-M],[M,0]]\",\
             \"operator_embedding\":\"complex_bloch_floquet_to_real_gyrotropic_pencil\"}",
        ),
        requested_mode_count: plan.count as i32,
        target_kind: native_modal_target_kind(&plan.target),
        target_frequency_hz: native_modal_target_frequency_hz(&plan.target),
        frequency_min_hz: native_modal_frequency_min_hz(&plan.target),
        frequency_max_hz: native_modal_frequency_max_hz(&plan.target),
        residual_tolerance: 1.0e-8,
        max_outer_iterations: 300,
        max_linear_iterations: 1000,
        output_directory: None,
        write_partial_artifacts: false,
        completeness_policy: 1,
        eigensolver_family: 1,
        spectral_transform_kind: 1,
        cancel_requested: None,
        progress_callback: None,
        tiny_validation_problem: None,
        mfem_operator_problem: Some(native_fem::NativeModalEigenMfemOperatorProblem {
            tangent_dof_count: payload.stiffness.nrows() as u64,
            stiffness_matrix_row_major: Some(&stiffness_row_major),
            gyrotropic_matrix_row_major: Some(&payload.gyrotropic_row_major),
            mass_matrix_row_major: Some(&tangent_mass_row_major),
            phase_convention: native_fem::FrequencyDomainPhaseConvention::ExpIOmegaT,
            floquet_periodic_pairs: &native_floquet_periodic_pairs,
        }),
        mfem_sparse_operator_problem: None,
    })
    .map_err(|message| RunError { message })?;

    if native_result.status != native_fem::NativeFrequencyDomainStatus::Ok {
        return Err(RunError {
            message: format!(
                "native FEM modal_eigen Bloch/Floquet production CPU solve failed: {} (diagnostics_json={})",
                native_result.error_message, native_result.diagnostics_json
            ),
        });
    }
    let solver_diagnostics = native_solver_diagnostics_json(plan, &native_result.diagnostics_json)?;
    let modes =
        native_bloch_floquet_modes_from_result_json(plan, &native_result.result_json, &payload)?;
    if modes.is_empty() {
        return Err(RunError {
            message: "native FEM modal_eigen Bloch/Floquet production CPU solve returned no modes"
                .to_string(),
        });
    }

    emit_fem_eigen_progress(
        &mut progress,
        FemEigenProgress {
            phase: "writing_artifacts",
            phase_index: 4,
            phase_count: 5,
            percent: 85.0,
            solver_kind: NATIVE_CPU_MODAL_WINDOW_SOLVER_KIND,
            active_nodes,
            effective_dof,
            requested_modes: plan.count as usize,
            candidate_modes: modes.len(),
            computed_modes: modes.len(),
            iteration: None,
            max_iterations: None,
            residual: modes
                .iter()
                .map(|mode| mode.residual_relative_l2)
                .reduce(f64::max),
            warning: None,
        },
    )?;

    let auxiliary_artifacts = native_modal_artifacts(
        plan,
        outputs,
        &equilibrium,
        reduction,
        bases,
        &modes,
        solver_diagnostics,
        relaxation_steps,
    )?;

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

    emit_fem_eigen_progress(
        &mut progress,
        FemEigenProgress {
            phase: "completed",
            phase_index: 5,
            phase_count: 5,
            percent: 100.0,
            solver_kind: NATIVE_CPU_MODAL_WINDOW_SOLVER_KIND,
            active_nodes,
            effective_dof,
            requested_modes: plan.count as usize,
            candidate_modes: modes.len(),
            computed_modes: modes.len(),
            iteration: None,
            max_iterations: None,
            residual: None,
            warning: None,
        },
    )?;

    Ok(ExecutedRun {
        result: RunResult {
            status: RunStatus::Completed,
            steps: vec![stats],
            final_magnetization: equilibrium,
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
        provenance: native_modal_execution_provenance(plan),
    })
}

fn dmatrix_to_row_major(matrix: &DMatrix<f64>) -> Vec<f64> {
    let mut values = Vec::with_capacity(matrix.nrows() * matrix.ncols());
    for row in 0..matrix.nrows() {
        for col in 0..matrix.ncols() {
            values.push(matrix[(row, col)]);
        }
    }
    values
}

fn gyrotropic_matrix_row_major_from_tangent_mass(
    mass: &DMatrix<f64>,
    active_nodes: usize,
) -> Result<Vec<f64>, RunError> {
    let dim = active_nodes.checked_mul(2).ok_or_else(|| RunError {
        message: "native modal gyrotropic matrix dimension overflow".to_string(),
    })?;
    if mass.nrows() != dim || mass.ncols() != dim {
        return Err(RunError {
            message: format!(
                "native modal full_2x2 mass matrix has shape {}x{}, expected {}x{}",
                mass.nrows(),
                mass.ncols(),
                dim,
                dim
            ),
        });
    }
    let mut gyrotropic = vec![0.0; dim * dim];
    for row in 0..active_nodes {
        for col in 0..active_nodes {
            let tangent_mass = mass[(row, col)];
            gyrotropic[row * dim + col + active_nodes] = tangent_mass;
            gyrotropic[(row + active_nodes) * dim + col] = -tangent_mass;
        }
    }
    Ok(gyrotropic)
}

fn native_solver_diagnostics_json(
    plan: &FemEigenPlanIR,
    raw: &str,
) -> Result<serde_json::Value, RunError> {
    let mut diagnostics =
        serde_json::from_str::<serde_json::Value>(raw).map_err(|error| RunError {
            message: format!("failed to parse native modal diagnostics JSON: {error}"),
        })?;
    let Some(object) = diagnostics.as_object_mut() else {
        return Err(RunError {
            message: "native modal diagnostics JSON must be an object".to_string(),
        });
    };
    object.insert(
        "schema_version".to_string(),
        serde_json::json!("frequency_domain_modal_solver_diagnostics.v1"),
    );
    object
        .entry("solver_model".to_string())
        .or_insert_with(|| serde_json::json!("contour_interval_production_cpu_dense"));
    object
        .entry("resolved_solver_family".to_string())
        .or_insert_with(|| serde_json::json!("contour_interval"));
    object
        .entry("spectral_transform".to_string())
        .or_insert_with(|| serde_json::json!("contour_integral"));
    object
        .entry("algebraic_form".to_string())
        .or_insert_with(|| serde_json::json!("linearized_llg_generalized"));
    object
        .entry("matrix_equation".to_string())
        .or_insert_with(|| serde_json::json!("L phi = lambda B phi"));
    object
        .entry("phasor_convention".to_string())
        .or_insert_with(|| serde_json::json!("exp_i_omega_t"));
    object
        .entry("eigenvalue_mapping".to_string())
        .or_insert_with(|| serde_json::json!("lambda_eq_i_omega"));
    object
        .entry("frequency_mapping".to_string())
        .or_insert_with(|| {
            serde_json::json!(
                "frequency_hz = Im(lambda)/(2*pi) for the accepted positive-frequency branch"
            )
        });
    object
        .entry("production_gyrotropic_mapping".to_string())
        .or_insert_with(|| serde_json::json!(true));
    object
        .entry("dense_reference_oracle".to_string())
        .or_insert_with(|| serde_json::json!(false));
    object
        .entry("residual_definition".to_string())
        .or_insert_with(|| {
            serde_json::json!(
                "relative_residual = ||K phi - lambda B phi||_2 / (||K phi||_2 + |lambda| * ||B phi||_2), B=-G"
            )
        });
    object
        .entry("tangent_leakage_definition".to_string())
        .or_insert_with(|| {
            serde_json::json!(
                "abs(m0 dot delta_m) over reconstructed real and imaginary mode vectors"
            )
        });
    object.entry("constants".to_string()).or_insert_with(|| {
        serde_json::json!({
            "gamma_rad_s_T": plan.gyromagnetic_ratio / MU0,
            "gamma0_rad_s_per_A_m": plan.gyromagnetic_ratio,
            "mu0_T_m_per_A": MU0,
        })
    });
    if matches!(
        plan.target,
        fullmag_ir::EigenTargetIR::FrequencyWindow { .. }
    ) {
        object
            .entry("requested_mode_count".to_string())
            .or_insert_with(|| serde_json::json!(plan.count));
        let accepted_modes = object
            .get("accepted_mode_count_after_dedup")
            .or_else(|| object.get("accepted_mode_count"))
            .and_then(|value| value.as_u64())
            .unwrap_or(0);
        object
            .entry("mode_count".to_string())
            .or_insert_with(|| serde_json::json!(accepted_modes));
        object
            .entry("window_completeness".to_string())
            .or_insert_with(|| {
                serde_json::json!({
                    "policy": "best_effort",
                    "status": "not_certified",
                    "certification_method": "none",
                    "estimated_modes_in_window": accepted_modes,
                    "certified_modes_in_window": 0,
                    "additional_modes_may_exist": true,
                })
            });
    }
    Ok(diagnostics)
}

fn native_modal_modes_from_result_json(
    plan: &FemEigenPlanIR,
    raw: &str,
    stiffness_omega: &DMatrix<f64>,
    gyrotropic_row_major: &[f64],
    tangent_mass: &DMatrix<f64>,
) -> Result<Vec<NativeModalEigenpair>, RunError> {
    let result = serde_json::from_str::<serde_json::Value>(raw).map_err(|error| RunError {
        message: format!("failed to parse native modal result JSON: {error}"),
    })?;
    let modes = result
        .get("modes")
        .and_then(|value| value.as_array())
        .ok_or_else(|| RunError {
            message: "native modal result JSON is missing modes[]".to_string(),
        })?;
    modes
        .iter()
        .map(|mode| {
            native_modal_mode_from_json(
                plan,
                mode,
                stiffness_omega,
                gyrotropic_row_major,
                tangent_mass,
            )
        })
        .collect()
}

fn native_bloch_floquet_modes_from_result_json(
    plan: &FemEigenPlanIR,
    raw: &str,
    payload: &NativeBlochFloquetDensePayload,
) -> Result<Vec<NativeModalEigenpair>, RunError> {
    let result = serde_json::from_str::<serde_json::Value>(raw).map_err(|error| RunError {
        message: format!("failed to parse native Bloch/Floquet modal result JSON: {error}"),
    })?;
    let modes = result
        .get("modes")
        .and_then(|value| value.as_array())
        .ok_or_else(|| RunError {
            message: "native Bloch/Floquet modal result JSON is missing modes[]".to_string(),
        })?;
    modes
        .iter()
        .map(|mode| native_bloch_floquet_mode_from_json(plan, mode, payload))
        .collect()
}

fn native_bloch_floquet_mode_from_json(
    plan: &FemEigenPlanIR,
    mode: &serde_json::Value,
    payload: &NativeBlochFloquetDensePayload,
) -> Result<NativeModalEigenpair, RunError> {
    let real = required_f64_array(mode, "mode_vector_real")?;
    let imag = required_f64_array(mode, "mode_vector_imag")?;
    if real.len() != imag.len() || real.len() != payload.stiffness.nrows() {
        return Err(RunError {
            message: format!(
                "native Bloch/Floquet modal mode vector length mismatch: real={}, imag={}, operator={}",
                real.len(),
                imag.len(),
                payload.stiffness.nrows()
            ),
        });
    }
    let embedded = real
        .iter()
        .zip(imag.iter())
        .map(|(re, im)| Complex64::new(*re, *im))
        .collect::<Vec<_>>();
    let mut vector =
        deembed_native_bloch_floquet_mode_vector(&embedded, payload.physical_complex_dof)?;
    vector = normalize_complex_mode(&vector, &payload.physical_mass, &plan.normalization);
    let eigenvalue_real = required_f64(mode, "eigenvalue_real")?;
    let eigenvalue_imag = required_f64(mode, "eigenvalue_imag")?;
    let frequency_hz = required_f64(mode, "frequency_hz")?;
    let omega_rad_s = required_f64(mode, "omega_rad_s")?;
    validate_native_modal_lambda_frequency_mapping(eigenvalue_imag, omega_rad_s, frequency_hz)?;
    let lambda = Complex64::new(eigenvalue_real, eigenvalue_imag);
    let (residual_absolute_l2, residual_relative_l2, residual_linf) =
        gyrotropic_pencil_residual_norms(
            &payload.stiffness,
            &payload.gyrotropic_row_major,
            lambda,
            &embedded,
        );
    let mass_norm = complex_mass_norm(&payload.physical_mass, &vector).re;
    Ok(NativeModalEigenpair {
        frequency_hz,
        omega_rad_s,
        eigenvalue_real,
        eigenvalue_imag,
        residual_absolute_l2,
        residual_relative_l2,
        residual_linf,
        mass_norm,
        vector,
    })
}

fn native_modal_mode_from_json(
    plan: &FemEigenPlanIR,
    mode: &serde_json::Value,
    stiffness_omega: &DMatrix<f64>,
    gyrotropic_row_major: &[f64],
    tangent_mass: &DMatrix<f64>,
) -> Result<NativeModalEigenpair, RunError> {
    let real = required_f64_array(mode, "mode_vector_real")?;
    let imag = required_f64_array(mode, "mode_vector_imag")?;
    if real.len() != imag.len() || real.len() != stiffness_omega.nrows() {
        return Err(RunError {
            message: format!(
                "native modal mode vector length mismatch: real={}, imag={}, operator={}",
                real.len(),
                imag.len(),
                stiffness_omega.nrows()
            ),
        });
    }
    let mut vector = real
        .iter()
        .zip(imag.iter())
        .map(|(re, im)| Complex64::new(*re, *im))
        .collect::<Vec<_>>();
    normalize_complex_block_mode(&mut vector, tangent_mass, plan.normalization);
    let eigenvalue_real = required_f64(mode, "eigenvalue_real")?;
    let eigenvalue_imag = required_f64(mode, "eigenvalue_imag")?;
    let frequency_hz = required_f64(mode, "frequency_hz")?;
    let omega_rad_s = required_f64(mode, "omega_rad_s")?;
    validate_native_modal_lambda_frequency_mapping(eigenvalue_imag, omega_rad_s, frequency_hz)?;
    let lambda = Complex64::new(eigenvalue_real, eigenvalue_imag);
    let (residual_absolute_l2, residual_relative_l2, residual_linf) =
        gyrotropic_pencil_residual_norms(stiffness_omega, gyrotropic_row_major, lambda, &vector);
    let mass_norm = complex_block_mass_norm(tangent_mass, &vector).re;
    Ok(NativeModalEigenpair {
        frequency_hz,
        omega_rad_s,
        eigenvalue_real,
        eigenvalue_imag,
        residual_absolute_l2,
        residual_relative_l2,
        residual_linf,
        mass_norm,
        vector,
    })
}

fn validate_native_modal_lambda_frequency_mapping(
    eigenvalue_imag: f64,
    omega_rad_s: f64,
    frequency_hz: f64,
) -> Result<(), RunError> {
    if eigenvalue_imag <= 0.0 {
        return Err(RunError {
            message: format!(
                "native modal lambda=i*omega contract requires a positive-frequency branch, got Im(lambda)={eigenvalue_imag}"
            ),
        });
    }
    let expected_omega = eigenvalue_imag;
    if !approximately_equal(omega_rad_s, expected_omega, 1.0e-9, 1.0e-9) {
        return Err(RunError {
            message: format!(
                "native modal lambda=i*omega contract mismatch: omega_rad_s={omega_rad_s}, Im(lambda)={eigenvalue_imag}"
            ),
        });
    }
    let expected_frequency = expected_omega / std::f64::consts::TAU;
    if !approximately_equal(frequency_hz, expected_frequency, 1.0e-9, 1.0e-9) {
        return Err(RunError {
            message: format!(
                "native modal frequency mapping mismatch: frequency_hz={frequency_hz}, expected Im(lambda)/(2*pi)={expected_frequency}"
            ),
        });
    }
    Ok(())
}

fn approximately_equal(left: f64, right: f64, relative_tol: f64, absolute_tol: f64) -> bool {
    (left - right).abs() <= absolute_tol.max(relative_tol * left.abs().max(right.abs()))
}

fn required_f64(value: &serde_json::Value, key: &str) -> Result<f64, RunError> {
    value
        .get(key)
        .and_then(|field| field.as_f64())
        .filter(|number| number.is_finite())
        .ok_or_else(|| RunError {
            message: format!("native modal result field '{key}' must be finite"),
        })
}

fn required_f64_array(value: &serde_json::Value, key: &str) -> Result<Vec<f64>, RunError> {
    let array = value
        .get(key)
        .and_then(|field| field.as_array())
        .ok_or_else(|| RunError {
            message: format!("native modal result field '{key}' must be an array"),
        })?;
    array
        .iter()
        .enumerate()
        .map(|(index, item)| {
            item.as_f64()
                .filter(|number| number.is_finite())
                .ok_or_else(|| RunError {
                    message: format!("native modal result field '{key}[{index}]' must be finite"),
                })
        })
        .collect()
}

fn normalize_complex_block_mode(
    vector: &mut [Complex64],
    mass: &DMatrix<f64>,
    normalization: EigenNormalizationIR,
) {
    let scale = match normalization {
        EigenNormalizationIR::UnitL2 => complex_block_mass_norm(mass, vector).re.max(0.0).sqrt(),
        EigenNormalizationIR::UnitMaxAmplitude => vector
            .iter()
            .fold(0.0_f64, |acc, value| acc.max(value.norm())),
    }
    .max(1.0e-30);
    for value in vector {
        *value /= scale;
    }
}

fn complex_block_mass_norm(mass: &DMatrix<f64>, vector: &[Complex64]) -> Complex64 {
    let mut norm = Complex64::new(0.0, 0.0);
    for row in 0..mass.nrows() {
        let mut projected = Complex64::new(0.0, 0.0);
        for col in 0..mass.ncols() {
            projected += vector[col] * mass[(row, col)];
        }
        norm += vector[row].conj() * projected;
    }
    norm
}

fn gyrotropic_pencil_residual_norms(
    stiffness_omega: &DMatrix<f64>,
    gyrotropic_row_major: &[f64],
    lambda: Complex64,
    vector: &[Complex64],
) -> (f64, f64, f64) {
    let dim = vector.len();
    let mut residual_l2: f64 = 0.0;
    let mut residual_linf: f64 = 0.0;
    let mut k_norm_l2: f64 = 0.0;
    let mut g_norm_l2: f64 = 0.0;
    for row in 0..dim {
        let mut k_row = Complex64::new(0.0, 0.0);
        let mut g_row = Complex64::new(0.0, 0.0);
        for col in 0..dim {
            k_row += vector[col] * stiffness_omega[(row, col)];
            g_row += vector[col] * gyrotropic_row_major[row * dim + col];
        }
        let residual = k_row - lambda * g_row;
        let residual_norm = residual.norm();
        residual_l2 += residual_norm * residual_norm;
        residual_linf = residual_linf.max(residual_norm);
        k_norm_l2 += k_row.norm_sqr();
        g_norm_l2 += g_row.norm_sqr();
    }
    let residual_absolute_l2 = residual_l2.sqrt();
    let denominator = k_norm_l2.sqrt() + lambda.norm() * g_norm_l2.sqrt();
    let residual_relative_l2 = if denominator > 0.0 {
        residual_absolute_l2 / denominator
    } else {
        residual_absolute_l2
    };
    (residual_absolute_l2, residual_relative_l2, residual_linf)
}

fn native_modal_artifacts(
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    equilibrium: &[Vector3],
    reduction: &ReductionMap,
    bases: &[(Vector3, Vector3)],
    modes: &[NativeModalEigenpair],
    solver_diagnostics: serde_json::Value,
    relaxation_steps: u64,
) -> Result<Vec<AuxiliaryArtifact>, RunError> {
    let requested_modes = requested_mode_indices(outputs);
    let wants_spectrum = outputs
        .iter()
        .any(|output| matches!(output, OutputIR::EigenSpectrum { .. }));
    let wants_dispersion = outputs
        .iter()
        .any(|output| matches!(output, OutputIR::DispersionCurve { .. }));
    let gamma_rad_s_t = plan.gyromagnetic_ratio / MU0;
    let gamma0_rad_s_per_a_m = plan.gyromagnetic_ratio;
    let mu0_t_m_per_a = MU0;
    let mut auxiliary_artifacts = Vec::new();
    let mut modes_summary = Vec::with_capacity(modes.len());
    let solver_backend = solver_diagnostics
        .get("solver_backend")
        .and_then(|value| value.as_str())
        .unwrap_or("native_fem_modal_eigen");
    let solver_kind = solver_diagnostics
        .get("solver_model")
        .or_else(|| solver_diagnostics.get("solver_kind"))
        .and_then(|value| value.as_str())
        .unwrap_or("contour_interval_production_cpu_dense");
    let spectral_transform = solver_diagnostics
        .get("spectral_transform")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown");
    let resolved_solver_family = solver_diagnostics
        .get("resolved_solver_family")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown");
    let shift_invert_backend =
        spectral_transform == "shift_invert" || resolved_solver_family == "shift_invert";
    let solver_notes = if shift_invert_backend {
        "native FEM production CPU modal eigensolver using SLEPc shift-invert"
    } else {
        "native FEM production CPU modal eigensolver using dense contour interval search"
    };
    let solver_capabilities: Vec<&'static str> = if shift_invert_backend {
        vec![
            "native_modal_eigen",
            "production_cpu",
            "shift_invert",
            "frequency_window_filter",
        ]
    } else {
        vec![
            "native_modal_eigen",
            "production_cpu",
            "contour_interval",
            "frequency_window_filter",
        ]
    };
    let solver_limitations: Vec<&'static str> = if shift_invert_backend {
        vec![
            "dense_operator_payload",
            "window_count_certification_pending",
        ]
    } else {
        vec![
            "dense_operator_payload",
            "block_diagonal_2x2_contour_payload",
        ]
    };

    for (mode_index, mode) in modes.iter().enumerate() {
        let (real, imag, amplitude, phase, max_amplitude) =
            project_complex_2x2_mode_to_tangent_basis(
                equilibrium.len(),
                &reduction.active_nodes,
                &mode.vector,
                bases,
            );
        let norm = mode
            .vector
            .iter()
            .map(|value| value.norm_sqr())
            .sum::<f64>()
            .sqrt();
        let dominant_polarization = classify_polarization(
            &amplitude,
            &reduction.active_nodes,
            equilibrium,
            max_amplitude,
        );
        let (tangent_leakage_mean_abs, tangent_leakage_max_abs) =
            mode_tangent_leakage(equilibrium, &real, &imag);
        let mode_summary = serde_json::json!({
            "index": mode_index,
            "frequency_hz": mode.frequency_hz,
            "frequency_real_hz": mode.frequency_hz,
            "frequency_imag_hz": 0.0,
            "angular_frequency_rad_per_s": mode.omega_rad_s,
            "omega_rad_s": mode.omega_rad_s,
            "angular_frequency_imag_rad_per_s": 0.0,
            "eigenvalue_field_au_per_m": mode.omega_rad_s / plan.gyromagnetic_ratio,
            "eigenvalue_real": mode.eigenvalue_real,
            "eigenvalue_imag": mode.eigenvalue_imag,
            "phasor_convention": "exp_i_omega_t",
            "eigenvalue_mapping": "lambda_eq_i_omega",
            "norm": norm,
            "max_amplitude": max_amplitude,
            "residual_norm": mode.residual_absolute_l2,
            "residual_absolute_l2": mode.residual_absolute_l2,
            "residual_relative_l2": mode.residual_relative_l2,
            "residual_linf": mode.residual_linf,
            "mass_norm": mode.mass_norm,
            "tangent_leakage_mean_abs": tangent_leakage_mean_abs,
            "tangent_leakage_max_abs": tangent_leakage_max_abs,
            "gamma_rad_s_T": gamma_rad_s_t,
            "gamma0_rad_s_per_A_m": gamma0_rad_s_per_a_m,
            "mu0_T_m_per_A": mu0_t_m_per_a,
            "dominant_polarization": dominant_polarization,
            "k_vector": k_vector_json(plan.k_sampling.as_ref()),
        });
        modes_summary.push(mode_summary.clone());

        if requested_modes.contains(&(mode_index as u32)) {
            let payload = serde_json::json!({
                "index": mode_index,
                "frequency_hz": mode.frequency_hz,
                "frequency_real_hz": mode.frequency_hz,
                "frequency_imag_hz": 0.0,
                "angular_frequency_rad_per_s": mode.omega_rad_s,
                "omega_rad_s": mode.omega_rad_s,
                "angular_frequency_imag_rad_per_s": 0.0,
                "eigenvalue_real": mode.eigenvalue_real,
                "eigenvalue_imag": mode.eigenvalue_imag,
                "phasor_convention": "exp_i_omega_t",
                "eigenvalue_mapping": "lambda_eq_i_omega",
                "max_amplitude": max_amplitude,
                "residual_norm": mode.residual_absolute_l2,
                "residual_absolute_l2": mode.residual_absolute_l2,
                "residual_relative_l2": mode.residual_relative_l2,
                "residual_linf": mode.residual_linf,
                "mass_norm": mode.mass_norm,
                "tangent_leakage_mean_abs": tangent_leakage_mean_abs,
                "tangent_leakage_max_abs": tangent_leakage_max_abs,
                "gamma_rad_s_T": gamma_rad_s_t,
                "gamma0_rad_s_per_A_m": gamma0_rad_s_per_a_m,
                "mu0_T_m_per_A": mu0_t_m_per_a,
                "normalization": normalization_label(plan.normalization),
                "damping_policy": damping_policy_label(plan.damping_policy),
                "solver_backend": solver_backend,
                "solver_kind": solver_kind,
                "solver_notes": solver_notes,
                "solver_capabilities": solver_capabilities,
                "solver_limitations": solver_limitations,
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
        "solver_backend": solver_backend,
        "solver_kind": solver_kind,
        "solver_notes": solver_notes,
        "solver_capabilities": solver_capabilities,
        "solver_limitations": solver_limitations,
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
        "solver_diagnostics": solver_diagnostics,
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
        auxiliary_artifacts.push(AuxiliaryArtifact {
            relative_path: "eigen/dispersion.csv".to_string(),
            bytes: dispersion_v2_csv(plan.k_sampling.as_ref(), &summary_payload["modes"])
                .into_bytes(),
        });
    }
    write_eigen_v2_bundle(
        plan,
        &summary_payload,
        &requested_modes,
        &mut auxiliary_artifacts,
    )?;
    auxiliary_artifacts
        .retain(|artifact| artifact.relative_path != "eigen/diagnostics/solver.v1.json");
    auxiliary_artifacts.push(json_artifact(
        "eigen/diagnostics/solver.v1.json",
        &summary_payload["solver_diagnostics"],
    )?);
    Ok(auxiliary_artifacts)
}

fn execution_provenance(plan: &FemEigenPlanIR, used_gpu: bool) -> ExecutionProvenance {
    let engine = if used_gpu {
        format!("gpu_cusolver_fem_eigen/{}", solver_kind_label(plan))
    } else {
        format!("cpu_baseline_fem_eigen/{}", solver_kind_label(plan))
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

fn native_modal_execution_provenance(plan: &FemEigenPlanIR) -> ExecutionProvenance {
    let resolved_demag = resolved_demag_realization(plan);
    ExecutionProvenance {
        execution_engine: format!("native_fem_modal_eigen/{NATIVE_CPU_MODAL_WINDOW_SOLVER_KIND}"),
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
    validate_tangent_frame_transport_support(plan, &topology, &equilibrium_guess)?;
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
        Some(r) => {
            return Err(RunError {
                message: format!(
                    "FEM eigen runner: demag model '{}' is not yet implemented",
                    r.model_name(),
                ),
            });
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
        let mut energy_plateau = RelaxationEnergyPlateauWindow::default();
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
            let energy_plateau_range = energy_plateau.record(report.total_energy_joules);
            if relaxation_converged(
                &control,
                &stats,
                energy_plateau_range,
                plan.gyromagnetic_ratio,
                plan.material.damping,
                true,
            ) {
                break;
            }
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
            complex_reduction: matches!(spin_wave_bc.kind(), SpinWaveBoundaryKindIR::Floquet)
                && !is_gamma_k_sampling(k_sampling),
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

fn is_gamma_k_sampling(k_sampling: Option<&KSamplingIR>) -> bool {
    match k_sampling {
        None => true,
        Some(KSamplingIR::Single { k_vector }) => k_vector.iter().all(|value| *value == 0.0),
        Some(KSamplingIR::Path { .. }) => false,
    }
}

fn k_sampling_contains_nonzero(k_sampling: Option<&KSamplingIR>) -> bool {
    match k_sampling {
        Some(KSamplingIR::Single { k_vector }) => k_vector.iter().any(|value| *value != 0.0),
        Some(KSamplingIR::Path { points, .. }) => points
            .iter()
            .any(|point| point.k_vector.iter().any(|value| *value != 0.0)),
        None => false,
    }
}

fn validate_tangent_frame_transport_support(
    plan: &FemEigenPlanIR,
    topology: &MeshTopology,
    equilibrium: &[Vector3],
) -> Result<(), RunError> {
    let kind = plan.spin_wave_bc.kind();
    if !matches!(
        kind,
        SpinWaveBoundaryKindIR::Periodic | SpinWaveBoundaryKindIR::Floquet
    ) || topology.periodic_node_pairs.is_empty()
    {
        return Ok(());
    }
    let requested_pair_ids = plan.spin_wave_bc.boundary_pair_ids();
    let selected_pairs = topology
        .periodic_node_pairs
        .iter()
        .filter(|(pair_id, _, _)| {
            requested_pair_ids.is_empty()
                || requested_pair_ids
                    .iter()
                    .any(|requested| *requested == pair_id)
        })
        .cloned()
        .collect::<Vec<_>>();
    if selected_pairs.is_empty() {
        return Ok(());
    }
    if matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
        return Ok(());
    }
    reject_nonidentity_tangent_frame_transport(topology, &selected_pairs, equilibrium)
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

    let requested_pair_ids = spin_wave_bc.boundary_pair_ids();
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

    let selected_pairs = topology
        .periodic_node_pairs
        .iter()
        .filter(|(pair_id, _, _)| {
            requested_pair_ids.is_empty()
                || requested_pair_ids
                    .iter()
                    .any(|requested| *requested == pair_id)
        })
        .cloned()
        .collect::<Vec<_>>();
    if selected_pairs.is_empty() {
        return Err(RunError {
            message: format!(
                "spin_wave_bc.kind='{}' did not match any mesh.periodic_node_pairs pair_id",
                spin_wave_bc_label(spin_wave_bc.clone())
            ),
        });
    }
    let dof_map = if let Some(k) = k_vector {
        PeriodicDofMap::from_periodic_pair_tuples_floquet(
            topology.n_nodes,
            &selected_pairs,
            &topology.periodic_boundary_pairs,
            &topology.coords,
            k,
            spin_wave_bc.phase_convention(),
        )
    } else {
        PeriodicDofMap::from_periodic_pair_tuples_static(topology.n_nodes, &selected_pairs)
    }
    .map_err(|error| RunError {
        message: format!("failed to build periodic DOF map: {}", error.message),
    })?;

    let roots = (0..topology.n_nodes)
        .map(|node| dof_map.representative_nodes[dof_map.reduced_node(node)])
        .collect::<Vec<_>>();
    let phases = (0..topology.n_nodes)
        .map(|node| {
            let phase = dof_map.phase(node);
            Complex64::new(phase.re, phase.im)
        })
        .collect::<Vec<_>>();

    Ok(Some(PhaseGroups { roots, phases }))
}

fn reject_nonidentity_tangent_frame_transport(
    topology: &MeshTopology,
    selected_pairs: &[(String, u32, u32)],
    equilibrium: &[Vector3],
) -> Result<(), RunError> {
    if equilibrium.len() < topology.n_nodes {
        return Err(RunError {
            message: format!(
                "periodic/Floquet modal tangent-frame transport cannot be validated: \
                 equilibrium has {} nodes but mesh has {} nodes",
                equilibrium.len(),
                topology.n_nodes
            ),
        });
    }
    let bases = tangent_bases(equilibrium);
    let mut max_mismatch: f64 = 0.0;
    let mut worst_pair: Option<(&str, usize, usize)> = None;
    for (pair_id, node_a, node_b) in selected_pairs {
        let node_a = *node_a as usize;
        let node_b = *node_b as usize;
        if topology.magnetic_node_volumes[node_a] <= 0.0
            || topology.magnetic_node_volumes[node_b] <= 0.0
        {
            continue;
        }
        let mismatch = tangent_frame_identity_mismatch(bases[node_a], bases[node_b]);
        if mismatch > max_mismatch {
            max_mismatch = mismatch;
            worst_pair = Some((pair_id.as_str(), node_a, node_b));
        }
    }
    if max_mismatch > TANGENT_FRAME_IDENTITY_TOLERANCE {
        let (pair_id, node_a, node_b) = worst_pair.unwrap_or(("unknown", 0, 0));
        return Err(RunError {
            message: format!(
                "periodic/Floquet modal tangent-frame transport requires full \
                 phase*(T_dst^T T_src) support; the current reference runner only \
                 supports identity tangent-frame transport. pair_id='{pair_id}' \
                 node_a={node_a} node_b={node_b} \
                 tangent_frame_mismatch={max_mismatch:.6e} \
                 tolerance={TANGENT_FRAME_IDENTITY_TOLERANCE:.6e}"
            ),
        });
    }
    Ok(())
}

fn tangent_frame_identity_mismatch(src: (Vector3, Vector3), dst: (Vector3, Vector3)) -> f64 {
    let transport = tangent_transport_matrix(src, dst);
    ((transport[0][0] - 1.0).powi(2)
        + transport[0][1].powi(2)
        + transport[1][0].powi(2)
        + (transport[1][1] - 1.0).powi(2))
    .sqrt()
}

fn tangent_transport_matrix(src: (Vector3, Vector3), dst: (Vector3, Vector3)) -> [[f64; 2]; 2] {
    let (src_e1, src_e2) = src;
    let (dst_e1, dst_e2) = dst;
    [
        [dot(dst_e1, src_e1), dot(dst_e1, src_e2)],
        [dot(dst_e2, src_e1), dot(dst_e2, src_e2)],
    ]
}

fn tangent_transport_nonunitarity(transport: [[f64; 2]; 2]) -> f64 {
    let c00 = transport[0][0] * transport[0][0] + transport[1][0] * transport[1][0];
    let c01 = transport[0][0] * transport[0][1] + transport[1][0] * transport[1][1];
    let c10 = transport[0][1] * transport[0][0] + transport[1][1] * transport[1][0];
    let c11 = transport[0][1] * transport[0][1] + transport[1][1] * transport[1][1];
    ((c00 - 1.0).powi(2) + c01.powi(2) + c10.powi(2) + (c11 - 1.0).powi(2)).sqrt()
}

fn tangent_transport_to_root(
    node: usize,
    root: usize,
    bases: &[(Vector3, Vector3)],
) -> [[f64; 2]; 2] {
    let (node_e1, node_e2) = bases[node];
    let (root_e1, root_e2) = bases[root];
    [
        [dot(node_e1, root_e1), dot(node_e1, root_e2)],
        [dot(node_e2, root_e1), dot(node_e2, root_e2)],
    ]
}

fn project_local_tangent_block_to_reduced(
    coeff: Complex64,
    row_transport: [[f64; 2]; 2],
    local_block: [[f64; 2]; 2],
    col_transport: [[f64; 2]; 2],
) -> [[Complex64; 2]; 2] {
    let mut reduced = [[Complex64::new(0.0, 0.0); 2]; 2];
    for row_component in 0..2 {
        for col_component in 0..2 {
            let mut value = 0.0;
            for local_row in 0..2 {
                for local_col in 0..2 {
                    value += row_transport[local_row][row_component]
                        * local_block[local_row][local_col]
                        * col_transport[local_col][col_component];
                }
            }
            reduced[row_component][col_component] = coeff * value;
        }
    }
    reduced
}

fn add_complex_tangent_block(
    matrix: &mut [Vec<Complex64>],
    n: usize,
    row: usize,
    col: usize,
    block: [[Complex64; 2]; 2],
) {
    matrix[row][col] += block[0][0];
    matrix[row][col + n] += block[0][1];
    matrix[row + n][col] += block[1][0];
    matrix[row + n][col + n] += block[1][1];
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
) -> AssembledScalarOperator {
    let active_count = reduction.active_nodes.len();
    let mut stiffness = DMatrix::<f64>::zeros(active_count, active_count);
    let mut mass = DMatrix::<f64>::zeros(active_count, active_count);
    let exchange_coeff = exchange_field_coefficient(plan);
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
                    stiffness[(row, col)] +=
                        exchange_coeff * topology.element_stiffness[element_index][i][j];
                }
                let shift = 0.5 * (local_shift[i] + local_shift[j]);
                stiffness[(row, col)] += local_mass[i][j] * shift;
            }
        }
    }

    add_surface_anisotropy_real(plan, topology, reduction, equilibrium, &mut stiffness);
    add_dmi_real(plan, topology, reduction, &mut stiffness);

    AssembledScalarOperator::new(stiffness, mass)
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
    let exchange_coeff = exchange_field_coefficient(plan);

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
                    let ex = exchange_coeff * topology.element_stiffness[element_index][i][j];
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
    let exchange_coeff = exchange_field_coefficient(plan);
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
                    stiffness[row][col] +=
                        coeff * exchange_coeff * topology.element_stiffness[element_index][i][j];
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

fn assemble_projected_full_2x2_operator_complex(
    plan: &FemEigenPlanIR,
    topology: &MeshTopology,
    reduction: &ReductionMap,
    observables: &EffectiveFieldObservables,
    equilibrium: &[Vector3],
    bases: &[(Vector3, Vector3)],
) -> (Vec<Vec<Complex64>>, Vec<Vec<Complex64>>) {
    let n = reduction.active_nodes.len();
    let dim = 2 * n;
    let mut stiffness = vec![vec![Complex64::new(0.0, 0.0); dim]; dim];
    let mut mass = vec![vec![Complex64::new(0.0, 0.0); dim]; dim];
    let exchange_coeff = exchange_field_coefficient(plan);

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
            let h_parallel = dot(*m, h_eff).max(0.0);
            let h_e1 = dot(e1, h_eff);
            let h_e2 = dot(e2, h_eff);
            [
                h_parallel,
                h_e1 * h_e2 / (h_parallel.max(1e-30)),
                h_e1 * h_e2 / (h_parallel.max(1e-30)),
                h_parallel,
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
            let phase_i = reduction.node_phases[node_i];
            let row_root = reduction.active_nodes[row];
            let row_transport = tangent_transport_to_root(node_i, row_root, bases);
            for j in 0..4 {
                let node_j = element[j] as usize;
                let Some(col) = reduction.node_map[node_j] else {
                    continue;
                };
                let coeff = phase_i.conj() * reduction.node_phases[node_j];
                let col_root = reduction.active_nodes[col];
                let col_transport = tangent_transport_to_root(node_j, col_root, bases);
                let m_ij = local_mass[i][j];
                let fb_i = &field_blocks[node_i];
                let fb_j = &field_blocks[node_j];

                add_complex_tangent_block(
                    &mut mass,
                    n,
                    row,
                    col,
                    project_local_tangent_block_to_reduced(
                        coeff,
                        row_transport,
                        [[m_ij, 0.0], [0.0, m_ij]],
                        col_transport,
                    ),
                );

                if plan.enable_exchange {
                    let ex = exchange_coeff * topology.element_stiffness[element_index][i][j];
                    add_complex_tangent_block(
                        &mut stiffness,
                        n,
                        row,
                        col,
                        project_local_tangent_block_to_reduced(
                            coeff,
                            row_transport,
                            [[ex, 0.0], [0.0, ex]],
                            col_transport,
                        ),
                    );
                }

                let h11 = 0.5 * (fb_i[0] + fb_j[0]);
                let h12 = 0.5 * (fb_i[1] + fb_j[1]);
                let h21 = 0.5 * (fb_i[2] + fb_j[2]);
                let h22 = 0.5 * (fb_i[3] + fb_j[3]);
                add_complex_tangent_block(
                    &mut stiffness,
                    n,
                    row,
                    col,
                    project_local_tangent_block_to_reduced(
                        coeff,
                        row_transport,
                        [[m_ij * h11, m_ij * h12], [m_ij * h21, m_ij * h22]],
                        col_transport,
                    ),
                );
            }
        }
    }

    add_surface_anisotropy_2x2_complex(plan, topology, reduction, equilibrium, &mut stiffness, n);
    add_dmi_2x2_complex(plan, reduction, &mut stiffness, plan.k_sampling.as_ref(), n);
    (stiffness, mass)
}

fn regularize_periodic_mass_if_needed(
    mut mass: DMatrix<f64>,
    spin_wave_bc: &SpinWaveBoundaryConditionIR,
) -> DMatrix<f64> {
    if !matches!(
        spin_wave_bc.kind(),
        SpinWaveBoundaryKindIR::Periodic | SpinWaveBoundaryKindIR::Floquet
    ) {
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
    stiffness: &DMatrix<f64>,
    mass: &DMatrix<f64>,
) -> Result<Vec<RealEigenpair>, RunError> {
    let mass = regularize_periodic_mass_if_needed(mass.clone(), &plan.spin_wave_bc);
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
            let normalized = normalize_real_mode(lifted, &mass, &plan.normalization);
            let (residual_absolute_l2, residual_relative_l2, residual_linf) =
                generalized_residual_norms(stiffness, &mass, *value, &normalized);
            Some(RealEigenpair {
                eigenvalue_real: *value,
                eigenvalue_imag: 0.0,
                residual_absolute_l2,
                residual_relative_l2,
                residual_linf,
                mass_norm: generalized_mass_norm(&mass, &normalized),
                vector: normalized,
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
    stiffness: &DMatrix<f64>,
    mass: &DMatrix<f64>,
    num_modes: usize,
    progress: Option<&mut FemEigenProgressCallback<'_>>,
    active_nodes: usize,
    effective_dof: usize,
) -> Result<Vec<RealEigenpair>, RunError> {
    let mass = regularize_periodic_mass_if_needed(mass.clone(), &plan.spin_wave_bc);
    let n = stiffness.nrows();

    // Convert to CSR (drop entries < 1e-15 to preserve sparsity)
    let k_csr = dmatrix_to_csr(&stiffness, 1e-15);
    let m_csr = dmatrix_to_csr(&mass, 1e-15);

    // LOBPCG: find num_modes smallest eigenpairs
    let tol = 1e-8;
    let max_iter = (n * 2).max(500).min(5000) as u32;
    let solver_modes = sparse_lobpcg_candidate_count(&plan.target, num_modes, n);
    if solver_modes > num_modes {
        eprintln!(
            "warning: FEM eigen frequency_window uses oversampled lowest-mode sparse LOBPCG candidates \
             (requested={}, candidates={}); production interior-window eigensolve requires shift-invert/FEAST/SLEPc",
            num_modes, solver_modes
        );
    }
    let mut interrupted: Option<RunError> = None;
    let mut progress = progress;
    let mut progress_callback = |lobpcg: fullmag_engine::fem_sparse::LobpcgProgress| {
        if interrupted.is_some() {
            return;
        }
        let iter_fraction = if lobpcg.max_iterations > 0 {
            f64::from(lobpcg.iteration) / f64::from(lobpcg.max_iterations)
        } else {
            0.0
        };
        let convergence_fraction = if lobpcg.requested_count > 0 {
            lobpcg.converged_count as f64 / lobpcg.requested_count as f64
        } else {
            0.0
        };
        let percent = 35.0 + 45.0 * iter_fraction.max(convergence_fraction).min(1.0);
        let result = emit_fem_eigen_progress(
            &mut progress,
            FemEigenProgress {
                phase: "solving_sparse_lobpcg",
                phase_index: 3,
                phase_count: 5,
                percent,
                solver_kind: "cpu_sparse_lobpcg",
                active_nodes,
                effective_dof,
                requested_modes: num_modes,
                candidate_modes: solver_modes,
                computed_modes: lobpcg.converged_count.min(num_modes),
                iteration: Some(lobpcg.iteration),
                max_iterations: Some(lobpcg.max_iterations),
                residual: Some(lobpcg.max_residual),
                warning: sparse_lobpcg_progress_warning(plan, solver_modes, num_modes),
            },
        );
        if let Err(error) = result {
            interrupted = Some(error);
        }
    };
    let (sparse_pairs, report) = lobpcg_generalized_with_progress(
        &k_csr,
        &m_csr,
        solver_modes,
        tol,
        max_iter,
        Some(&mut progress_callback),
    )
    .map_err(|e| RunError {
        message: format!("sparse LOBPCG eigensolver failed: {}", e.message),
    })?;
    if let Some(error) = interrupted {
        return Err(error);
    }

    eprintln!(
        "info: sparse LOBPCG converged={} in {} iterations (max_residual={:.2e}, {} candidates)",
        report.converged,
        report.iterations,
        report.max_residual,
        sparse_pairs.len()
    );

    // Convert SparseEigenpair to RealEigenpair
    let finite_candidate_count = sparse_pairs
        .iter()
        .filter(|ep| ep.eigenvalue.is_finite())
        .count();
    let mut eigenpairs: Vec<RealEigenpair> = sparse_pairs
        .into_iter()
        .filter(|ep| ep.eigenvalue.is_finite())
        .map(|ep| {
            let vec = DVector::from_vec(ep.vector);
            let normalized = normalize_real_mode(vec, &mass, &plan.normalization);
            let (residual_absolute_l2, residual_relative_l2, residual_linf) =
                generalized_residual_norms(stiffness, &mass, ep.eigenvalue, &normalized);
            RealEigenpair {
                eigenvalue_real: ep.eigenvalue,
                eigenvalue_imag: 0.0,
                residual_absolute_l2,
                residual_relative_l2,
                residual_linf,
                mass_norm: generalized_mass_norm(&mass, &normalized),
                vector: normalized,
            }
        })
        .collect();

    sort_and_truncate_real_modes(plan, &mut eigenpairs);
    reject_empty_frequency_window_result(
        &plan.target,
        solver_modes,
        finite_candidate_count,
        eigenpairs.len(),
    )?;
    Ok(eigenpairs)
}

fn sparse_lobpcg_candidate_count(
    target: &fullmag_ir::EigenTargetIR,
    requested_count: usize,
    matrix_size: usize,
) -> usize {
    if requested_count == 0 || matrix_size == 0 {
        return 0;
    }
    let requested_count = requested_count.min(matrix_size);
    if !matches!(target, fullmag_ir::EigenTargetIR::FrequencyWindow { .. }) {
        return requested_count;
    }
    let window_position_multiplier = match target {
        fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz,
            frequency_max_hz,
        } if *frequency_min_hz > 0.0 && *frequency_max_hz > *frequency_min_hz => {
            let relative_width =
                ((*frequency_max_hz - *frequency_min_hz) / *frequency_min_hz).clamp(0.05, 10.0);
            let lower_edge_multiplier = ((*frequency_max_hz / *frequency_min_hz).sqrt()).ceil();
            let width_multiplier = (1.0 / relative_width).sqrt().ceil();
            (lower_edge_multiplier + width_multiplier).max(2.0) as usize
        }
        _ => 2,
    };
    let min_extra = requested_count.max(8);
    requested_count
        .saturating_mul(window_position_multiplier)
        .max(requested_count + min_extra)
        .min(matrix_size)
        .max(requested_count)
}

fn reject_empty_frequency_window_result(
    target: &fullmag_ir::EigenTargetIR,
    solver_modes: usize,
    candidate_count: usize,
    retained_count: usize,
) -> Result<(), RunError> {
    if retained_count > 0 || !matches!(target, fullmag_ir::EigenTargetIR::FrequencyWindow { .. }) {
        return Ok(());
    }
    Err(RunError {
        message: format!(
            "FEM eigen frequency_window returned no modes in the requested interval after {} \
             sparse LOBPCG candidates ({} finite candidates). The current reference solver \
             oversamples lowest modes and cannot guarantee interior-window coverage; use a lower \
             window, reduce the mesh for dense validation, or wait for the production shift-invert/FEAST/SLEPc backend.",
            solver_modes, candidate_count
        ),
    })
}

fn sparse_lobpcg_progress_warning(
    plan: &FemEigenPlanIR,
    solver_modes: usize,
    requested_modes: usize,
) -> Option<&'static str> {
    if solver_modes > requested_modes
        && matches!(
            plan.target,
            fullmag_ir::EigenTargetIR::FrequencyWindow { .. }
        )
    {
        Some("frequency_window_sparse_lobpcg_uses_oversampled_lowest_candidates")
    } else {
        None
    }
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
    let transformed = &l_inv * &stiffness_block * l_inv.transpose();
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
        let normalized_block = complex_vector_to_real_block(&normalized);
        let (residual_absolute_l2, residual_relative_l2, residual_linf) =
            generalized_residual_norms(&stiffness_block, &mass_block, *value, &normalized_block);
        eigenpairs.push(ComplexEigenpair {
            eigenvalue_real: *value,
            eigenvalue_imag: 0.0,
            residual_absolute_l2,
            residual_relative_l2,
            residual_linf,
            mass_norm: generalized_mass_norm(&mass_block, &normalized_block),
            vector: normalized,
        });
    }
    sort_and_truncate_complex_modes(plan, &mut eigenpairs);
    Ok(eigenpairs)
}

fn generalized_residual_norms(
    stiffness: &DMatrix<f64>,
    mass: &DMatrix<f64>,
    eigenvalue: f64,
    vector: &DVector<f64>,
) -> (f64, f64, f64) {
    if stiffness.ncols() != vector.len() || mass.ncols() != vector.len() {
        return (f64::NAN, f64::NAN, f64::NAN);
    }
    let residual = stiffness * vector - mass * vector * eigenvalue;
    let residual_absolute_l2 = residual.norm();
    let ku_norm = (stiffness * vector).norm();
    let mu_norm = (mass * vector).norm();
    let denominator = ku_norm + eigenvalue.abs() * mu_norm;
    let residual_relative_l2 = if denominator > 0.0 {
        residual_absolute_l2 / denominator
    } else {
        0.0
    };
    let residual_linf = residual
        .iter()
        .fold(0.0_f64, |acc, value| acc.max(value.abs()));
    (residual_absolute_l2, residual_relative_l2, residual_linf)
}

fn generalized_mass_norm(mass: &DMatrix<f64>, vector: &DVector<f64>) -> f64 {
    if mass.ncols() != vector.len() {
        return f64::NAN;
    }
    vector.dot(&(mass * vector))
}

fn orthogonality_rows_json(
    mass: &DMatrix<f64>,
    eigenpairs: &[RealEigenpair],
) -> Vec<serde_json::Value> {
    eigenpairs
        .iter()
        .enumerate()
        .flat_map(|(lhs_index, lhs)| {
            eigenpairs.iter().enumerate().map(move |(rhs_index, rhs)| {
                serde_json::json!({
                    "lhs_mode_index": lhs_index,
                    "rhs_mode_index": rhs_index,
                    "mass_inner_product": lhs.vector.dot(&(mass * &rhs.vector)),
                })
            })
        })
        .collect()
}

fn complex_vector_to_real_block(vector: &[Complex64]) -> DVector<f64> {
    let mut block = DVector::<f64>::zeros(vector.len() * 2);
    for (index, value) in vector.iter().enumerate() {
        block[index] = value.re;
        block[index + vector.len()] = value.im;
    }
    block
}

fn mode_tangent_leakage(
    equilibrium: &[[f64; 3]],
    real: &[[f64; 3]],
    imag: &[[f64; 3]],
) -> (f64, f64) {
    let real_summary = tangent_leakage_summary(equilibrium, real);
    let imag_summary = tangent_leakage_summary(equilibrium, imag);
    if real.is_empty() && imag.is_empty() {
        return (0.0, 0.0);
    }
    let sample_count = real.len() + imag.len();
    (
        (real_summary.mean_abs * real.len() as f64 + imag_summary.mean_abs * imag.len() as f64)
            / sample_count as f64,
        real_summary.max_abs.max(imag_summary.max_abs),
    )
}

fn tangent_leakage_summary(
    equilibrium: &[[f64; 3]],
    mode_vectors: &[[f64; 3]],
) -> TangentLeakageSummary {
    let mut count = 0usize;
    let mut total = 0.0_f64;
    let mut max = 0.0_f64;
    for (m0, delta_m) in equilibrium.iter().zip(mode_vectors.iter()) {
        let leakage = (m0[0] * delta_m[0] + m0[1] * delta_m[1] + m0[2] * delta_m[2]).abs();
        total += leakage;
        max = max.max(leakage);
        count += 1;
    }
    if count == 0 {
        TangentLeakageSummary {
            mean_abs: 0.0,
            max_abs: 0.0,
        }
    } else {
        TangentLeakageSummary {
            mean_abs: total / count as f64,
            max_abs: max,
        }
    }
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

fn native_bloch_floquet_dense_payload_from_complex_pair(
    stiffness: &[Vec<Complex64>],
    mass: &[Vec<Complex64>],
) -> Result<NativeBlochFloquetDensePayload, RunError> {
    if stiffness.is_empty() || stiffness.len() != mass.len() {
        return Err(RunError {
            message: "native Bloch/Floquet payload requires non-empty matching stiffness and mass matrices"
                .to_string(),
        });
    }
    let physical_complex_dof = stiffness.len();
    if stiffness
        .iter()
        .any(|row| row.len() != physical_complex_dof)
        || mass.iter().any(|row| row.len() != physical_complex_dof)
    {
        return Err(RunError {
            message:
                "native Bloch/Floquet payload requires square complex stiffness and mass matrices"
                    .to_string(),
        });
    }

    let (stiffness_block, mass_block) = complex_pair_to_real_blocks(stiffness, mass);
    let block_dof = stiffness_block.nrows();
    let embedded_dof = block_dof.checked_mul(2).ok_or_else(|| RunError {
        message: "native Bloch/Floquet embedded payload dimension overflow".to_string(),
    })?;
    let mut stiffness_embedded = DMatrix::<f64>::zeros(embedded_dof, embedded_dof);
    let mut tangent_mass = DMatrix::<f64>::zeros(embedded_dof, embedded_dof);
    for row in 0..block_dof {
        for col in 0..block_dof {
            stiffness_embedded[(row, col)] = stiffness_block[(row, col)];
            stiffness_embedded[(row + block_dof, col + block_dof)] = stiffness_block[(row, col)];
            tangent_mass[(row, col)] = mass_block[(row, col)];
            tangent_mass[(row + block_dof, col + block_dof)] = mass_block[(row, col)];
        }
    }
    let mut gyrotropic_row_major = vec![0.0; embedded_dof * embedded_dof];
    for row in 0..block_dof {
        for col in 0..block_dof {
            let value = mass_block[(row, col)];
            gyrotropic_row_major[row * embedded_dof + col + block_dof] = -value;
            gyrotropic_row_major[(row + block_dof) * embedded_dof + col] = value;
        }
    }

    Ok(NativeBlochFloquetDensePayload {
        physical_complex_dof,
        stiffness: stiffness_embedded,
        gyrotropic_row_major,
        tangent_mass,
        physical_mass: mass.to_vec(),
    })
}

fn deembed_native_bloch_floquet_mode_vector(
    embedded: &[Complex64],
    physical_complex_dof: usize,
) -> Result<Vec<Complex64>, RunError> {
    let real_block_dof = physical_complex_dof
        .checked_mul(2)
        .ok_or_else(|| RunError {
            message: "native Bloch/Floquet de-embedding dimension overflow".to_string(),
        })?;
    let expected = real_block_dof.checked_mul(2).ok_or_else(|| RunError {
        message: "native Bloch/Floquet embedded mode dimension overflow".to_string(),
    })?;
    if physical_complex_dof == 0 || embedded.len() != expected {
        return Err(RunError {
            message: format!(
                "native Bloch/Floquet embedded mode has length {}, expected {} for {} physical complex DOF",
                embedded.len(),
                expected,
                physical_complex_dof
            ),
        });
    }

    let mut real_block = Vec::with_capacity(real_block_dof);
    for index in 0..real_block_dof {
        real_block
            .push((embedded[index] - Complex64::i() * embedded[index + real_block_dof]) * 0.5);
    }
    Ok((0..physical_complex_dof)
        .map(|index| real_block[index] + Complex64::i() * real_block[index + physical_complex_dof])
        .collect())
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

fn complex_mass_norm(mass: &[Vec<Complex64>], vector: &[Complex64]) -> Complex64 {
    let mut norm = Complex64::new(0.0, 0.0);
    for row in 0..vector.len() {
        let mut projected = Complex64::new(0.0, 0.0);
        for col in 0..vector.len() {
            projected += mass[row][col] * vector[col];
        }
        norm += vector[row].conj() * projected;
    }
    norm
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
        fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz,
            frequency_max_hz,
        } => {
            eigenpairs.retain(|pair| {
                let frequency =
                    frequency_from_eigenvalue(plan.gyromagnetic_ratio, pair.eigenvalue_real);
                frequency >= *frequency_min_hz && frequency <= *frequency_max_hz
            });
            eigenpairs.sort_by(|lhs, rhs| {
                let lhs_freq =
                    frequency_from_eigenvalue(plan.gyromagnetic_ratio, lhs.eigenvalue_real);
                let rhs_freq =
                    frequency_from_eigenvalue(plan.gyromagnetic_ratio, rhs.eigenvalue_real);
                lhs_freq
                    .partial_cmp(&rhs_freq)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
        }
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
        fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz,
            frequency_max_hz,
        } => {
            eigenpairs.retain(|pair| {
                let frequency =
                    frequency_from_eigenvalue(plan.gyromagnetic_ratio, pair.eigenvalue_real);
                frequency >= *frequency_min_hz && frequency <= *frequency_max_hz
            });
            eigenpairs.sort_by(|lhs, rhs| {
                let lhs_freq =
                    frequency_from_eigenvalue(plan.gyromagnetic_ratio, lhs.eigenvalue_real);
                let rhs_freq =
                    frequency_from_eigenvalue(plan.gyromagnetic_ratio, rhs.eigenvalue_real);
                lhs_freq
                    .partial_cmp(&rhs_freq)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
        }
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

fn add_surface_anisotropy_2x2_complex(
    plan: &FemEigenPlanIR,
    _topology: &MeshTopology,
    reduction: &ReductionMap,
    equilibrium: &[Vector3],
    stiffness: &mut [Vec<Complex64>],
    n: usize,
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
                let coeff = phase_i.conj() * reduction.node_phases[node_j] * local[i][j];
                stiffness[row][col] += coeff;
                stiffness[row + n][col + n] += coeff;
            }
        }
    }
}

fn add_dmi_2x2_complex(
    plan: &FemEigenPlanIR,
    reduction: &ReductionMap,
    stiffness: &mut [Vec<Complex64>],
    k_sampling: Option<&KSamplingIR>,
    n: usize,
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
        stiffness[index + n][index + n] += Complex64::new(nonreciprocal_shift, 0.0);
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

fn exchange_field_coefficient(plan: &FemEigenPlanIR) -> f64 {
    2.0 * plan.material.exchange_stiffness
        / (MU0 * plan.material.saturation_magnetisation.max(1e-30))
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

fn project_complex_2x2_mode_to_tangent_basis(
    total_nodes: usize,
    active_nodes: &[usize],
    amplitudes: &[Complex64],
    bases: &[(Vector3, Vector3)],
) -> (Vec<Vector3>, Vec<Vector3>, Vec<f64>, Vec<f64>, f64) {
    let n = active_nodes.len();
    let mut real = vec![[0.0, 0.0, 0.0]; total_nodes];
    let mut imag = vec![[0.0, 0.0, 0.0]; total_nodes];
    let mut amplitude = vec![0.0; total_nodes];
    let mut phase = vec![0.0; total_nodes];
    let mut max_amplitude: f64 = 0.0;

    if amplitudes.len() < 2 * n {
        return (real, imag, amplitude, phase, max_amplitude);
    }

    for (reduced_index, node_index) in active_nodes.iter().enumerate() {
        let u1 = amplitudes[reduced_index];
        let u2 = amplitudes[reduced_index + n];
        let (e1, e2) = bases[*node_index];
        real[*node_index] = add_vector(scale_vector(e1, u1.re), scale_vector(e2, u2.re));
        imag[*node_index] = add_vector(scale_vector(e1, u1.im), scale_vector(e2, u2.im));
        let amp = (u1.norm_sqr() + u2.norm_sqr()).sqrt();
        amplitude[*node_index] = amp;
        phase[*node_index] = (u1.im + u2.im).atan2(u1.re + u2.re);
        max_amplitude = max_amplitude.max(amp);
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

fn binary_artifact(path: impl Into<String>, bytes: Vec<u8>) -> AuxiliaryArtifact {
    AuxiliaryArtifact {
        relative_path: path.into(),
        bytes,
    }
}

fn mode_field_id(raw_mode_index: u64) -> String {
    format!("analysis:eigen:sample-0000:mode-{raw_mode_index:04}")
}

fn mode_field_resource_key(raw_mode_index: u64) -> String {
    format!(
        "/v2/sessions/current/data/fields/{}/samples/vector?view=phase_rotated_real&phase_rad=0",
        mode_field_id(raw_mode_index)
    )
}

fn mode_meta_resource_key(raw_mode_index: u64) -> String {
    format!(
        "/v2/sessions/current/analysis/frequency-domain/eigen/mode-field/0/{raw_mode_index}/meta"
    )
}

fn mode_metadata_path(raw_mode_index: u64) -> String {
    format!("eigen/modes/sample_0000/mode_{raw_mode_index:04}.json")
}

fn mode_payload_path(raw_mode_index: u64) -> String {
    format!("eigen/mode_fields/sample_0000/mode_{raw_mode_index:04}/vector.bin")
}

fn mode_zarr_store_path() -> &'static str {
    "eigen/mode_fields.zarr"
}

fn mode_zarr_sample_group_path() -> &'static str {
    "eigen/mode_fields.zarr/sample_0000"
}

fn mode_zarr_mode_group_path(raw_mode_index: u64) -> String {
    format!("eigen/mode_fields.zarr/sample_0000/mode_{raw_mode_index:04}")
}

fn mode_zarr_array_path(raw_mode_index: u64) -> String {
    format!(
        "{}/vector_xyz_complex",
        mode_zarr_mode_group_path(raw_mode_index)
    )
}

fn mode_zarr_chunk_path(raw_mode_index: u64) -> String {
    format!("{}/0.0.0", mode_zarr_array_path(raw_mode_index))
}

fn mode_vector_entries(value: &serde_json::Value, field: &str) -> Vec<[f64; 3]> {
    value
        .get(field)
        .and_then(|field_value| field_value.as_array())
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    let components = entry.as_array()?;
                    Some([
                        components
                            .first()
                            .and_then(|value| value.as_f64())
                            .unwrap_or(0.0),
                        components
                            .get(1)
                            .and_then(|value| value.as_f64())
                            .unwrap_or(0.0),
                        components
                            .get(2)
                            .and_then(|value| value.as_f64())
                            .unwrap_or(0.0),
                    ])
                })
                .collect()
        })
        .unwrap_or_default()
}

fn mode_payload_bytes(real: &[[f64; 3]], imag: &[[f64; 3]]) -> Vec<u8> {
    let sample_count = real.len().max(imag.len());
    let mut bytes = Vec::with_capacity(sample_count * 6 * std::mem::size_of::<f64>());
    for index in 0..sample_count {
        let real_sample = real.get(index).copied().unwrap_or([0.0, 0.0, 0.0]);
        let imag_sample = imag.get(index).copied().unwrap_or([0.0, 0.0, 0.0]);
        for component in 0..3 {
            bytes.extend_from_slice(&real_sample[component].to_le_bytes());
            bytes.extend_from_slice(&imag_sample[component].to_le_bytes());
        }
    }
    bytes
}

fn mode_amplitude_summary(amplitude: &serde_json::Value, sample_count: usize) -> serde_json::Value {
    let values: Vec<f64> = amplitude
        .as_array()
        .map(|items| items.iter().filter_map(|item| item.as_f64()).collect())
        .unwrap_or_default();
    let max = values.iter().copied().fold(0.0, f64::max);
    let mean = if values.is_empty() {
        0.0
    } else {
        values.iter().sum::<f64>() / values.len() as f64
    };
    serde_json::json!({
        "sample_count": sample_count,
        "max": max,
        "mean": mean,
    })
}

fn mode_component_summary(sample_count: usize) -> serde_json::Value {
    serde_json::json!({
        "real_sample_count": sample_count,
        "imag_sample_count": sample_count,
        "component_count": 3,
    })
}

fn zarr_group_artifact(path: impl Into<String>) -> Result<AuxiliaryArtifact, RunError> {
    json_artifact(
        format!("{}/.zgroup", path.into()),
        &serde_json::json!({
            "zarr_format": 2,
        }),
    )
}

fn mode_zarr_store_attrs_artifact() -> Result<AuxiliaryArtifact, RunError> {
    json_artifact(
        format!("{}/.zattrs", mode_zarr_store_path()),
        &serde_json::json!({
            "fullmag_kind": "frequency_domain_mode_field_store",
            "schema_version": 1,
            "preferred_container": "zarr",
            "quantity_ids": ["delta_m"],
            "axes": ["sample", "mode", "spatial_sample", "component", "complex"],
            "component_order": ["x", "y", "z"],
            "complex_order": ["real", "imag"],
            "storage_layout": "aos_xyz_complex_pairs",
            "compatibility_binary_exports": true,
        }),
    )
}

fn mode_zarr_array_metadata_artifact(
    raw_mode_index: u64,
    sample_count: usize,
) -> Result<AuxiliaryArtifact, RunError> {
    let chunk_sample_count = sample_count.max(1);
    json_artifact(
        format!("{}/.zarray", mode_zarr_array_path(raw_mode_index)),
        &serde_json::json!({
            "zarr_format": 2,
            "shape": [sample_count, 3, 2],
            "chunks": [chunk_sample_count, 3, 2],
            "dtype": "<f8",
            "compressor": serde_json::Value::Null,
            "fill_value": 0.0,
            "order": "C",
            "filters": serde_json::Value::Null,
            "dimension_separator": ".",
        }),
    )
}

fn mode_zarr_array_attrs_artifact(
    raw_mode_index: u64,
    sample_count: usize,
) -> Result<AuxiliaryArtifact, RunError> {
    json_artifact(
        format!("{}/.zattrs", mode_zarr_array_path(raw_mode_index)),
        &serde_json::json!({
            "quantity_id": "delta_m",
            "unit": "1",
            "value_kind": "complex_spatial_vector",
            "component_basis": "global_xyz",
            "axes": ["spatial_sample", "component", "complex"],
            "component_order": ["x", "y", "z"],
            "complex_order": ["real", "imag"],
            "sample_index": 0,
            "raw_mode_index": raw_mode_index,
            "mode_field_sample_count": sample_count,
            "storage_layout": "aos_xyz_complex_pairs",
        }),
    )
}

fn write_eigen_v2_bundle(
    plan: &FemEigenPlanIR,
    summary_payload: &serde_json::Value,
    requested_modes: &std::collections::BTreeSet<u32>,
    auxiliary_artifacts: &mut Vec<AuxiliaryArtifact>,
) -> Result<(), RunError> {
    let modes = summary_payload
        .get("modes")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let k_vector = match plan.k_sampling.as_ref() {
        Some(KSamplingIR::Single { k_vector }) => *k_vector,
        Some(KSamplingIR::Path { .. }) | None => [0.0, 0.0, 0.0],
    };
    let label = if k_vector.iter().all(|value| *value == 0.0) {
        "Γ"
    } else {
        ""
    };
    let solver_model = summary_payload
        .get("solver_kind")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown");

    let spectrum_modes: Vec<serde_json::Value> = modes
        .iter()
        .map(|mode| {
            let raw_mode_index = mode
                .get("index")
                .and_then(|value| value.as_u64())
                .unwrap_or(0);
            let mut mode = mode.clone();
            if let Some(object) = mode.as_object_mut() {
                object.insert(
                    "raw_mode_index".to_string(),
                    serde_json::json!(raw_mode_index),
                );
                object.insert("branch_id".to_string(), serde_json::json!(raw_mode_index));
                object.insert(
                    "mode_field_id".to_string(),
                    serde_json::json!(mode_field_id(raw_mode_index)),
                );
                object.insert(
                    "mode_field_resource_key".to_string(),
                    serde_json::json!(mode_field_resource_key(raw_mode_index)),
                );
            }
            mode
        })
        .collect();
    let spectrum_v2 = serde_json::json!({
        "schema_version": "eigen_spectrum.v2",
        "solver_model": summary_payload["solver_kind"],
        "sample_count": 1,
        "samples": [{
            "sample_index": 0,
            "label": label,
            "k_vector": k_vector,
            "path_s": 0.0,
            "segment_index": 0,
            "t_in_segment": 0.0,
            "modes": spectrum_modes,
        }],
    });
    auxiliary_artifacts.push(json_artifact("eigen/spectrum.v2.json", &spectrum_v2)?);

    let branches: Vec<serde_json::Value> = modes
        .iter()
        .map(|mode| {
            let raw_mode_index = mode
                .get("index")
                .and_then(|value| value.as_u64())
                .unwrap_or(0);
            serde_json::json!({
                "branch_id": raw_mode_index,
                "label": format!("mode_{raw_mode_index:04}"),
                "points": [{
                    "sample_index": 0,
                    "raw_mode_index": raw_mode_index,
                    "frequency_hz": mode["frequency_hz"],
                    "frequency_real_hz": mode["frequency_real_hz"],
                    "frequency_imag_hz": mode["frequency_imag_hz"],
                    "angular_frequency_rad_per_s": mode["angular_frequency_rad_per_s"],
                    "tracking_confidence": 1.0,
                    "tracking_score_source": "seed",
                    "modal_overlap_available": false,
                    "mode_field_id": mode_field_id(raw_mode_index),
                    "mode_field_resource_key": mode_field_resource_key(raw_mode_index),
                    "overlap_prev": null,
                }],
            })
        })
        .collect();
    auxiliary_artifacts.push(json_artifact(
        "eigen/branches.v2.json",
        &serde_json::json!({
            "schema_version": "eigen_branches.v2",
            "solver_model": summary_payload["solver_kind"],
            "tracking_score_source": "seed_only",
            "modal_overlap_available": false,
            "branches": branches,
            "diagnostics": {
                "tracking_score_source": "seed_only",
                "modal_overlap_available": false,
            },
        }),
    )?);
    if !auxiliary_artifacts
        .iter()
        .any(|artifact| artifact.relative_path == "eigen/dispersion.csv")
    {
        auxiliary_artifacts.push(AuxiliaryArtifact {
            relative_path: "eigen/dispersion.csv".to_string(),
            bytes: dispersion_v2_csv(plan.k_sampling.as_ref(), &summary_payload["modes"])
                .into_bytes(),
        });
    }

    let mut mode_metadata_paths = Vec::new();
    let mut mode_resource_keys = Vec::new();
    let mut wrote_mode_zarr_store = false;
    for raw_mode_index in requested_modes.iter().copied().map(u64::from) {
        let legacy_path = format!("eigen/modes/mode_{raw_mode_index:04}.json");
        let legacy_mode = auxiliary_artifacts
            .iter()
            .find(|artifact| artifact.relative_path == legacy_path)
            .and_then(|artifact| serde_json::from_slice::<serde_json::Value>(&artifact.bytes).ok());
        let Some(legacy_mode) = legacy_mode else {
            continue;
        };
        let real = mode_vector_entries(&legacy_mode, "real");
        let imag = mode_vector_entries(&legacy_mode, "imag");
        let sample_count = real.len().max(imag.len());
        let metadata_path = mode_metadata_path(raw_mode_index);
        let payload_path = mode_payload_path(raw_mode_index);
        let zarr_array_path = mode_zarr_array_path(raw_mode_index);
        let zarr_chunk_path = mode_zarr_chunk_path(raw_mode_index);
        let field_id = mode_field_id(raw_mode_index);
        let field_resource = mode_field_resource_key(raw_mode_index);
        let mut metadata = serde_json::json!({
            "schema_version": "eigen_mode.v2",
            "solver_model": summary_payload["solver_kind"],
            "sample_index": 0,
            "raw_mode_index": raw_mode_index,
            "branch_id": raw_mode_index,
            "frequency_hz": legacy_mode["frequency_hz"],
            "frequency_real_hz": legacy_mode["frequency_real_hz"],
            "frequency_imag_hz": legacy_mode["frequency_imag_hz"],
            "angular_frequency_rad_per_s": legacy_mode["angular_frequency_rad_per_s"],
            "eigenvalue_real": legacy_mode["eigenvalue_real"],
            "eigenvalue_imag": legacy_mode["eigenvalue_imag"],
            "normalization": legacy_mode["normalization"],
            "damping_policy": legacy_mode["damping_policy"],
        });
        if let Some(object) = metadata.as_object_mut() {
            object.insert("mode_field_id".to_string(), serde_json::json!(field_id));
            object.insert(
                "mode_field_resource_key".to_string(),
                serde_json::json!(field_resource),
            );
            object.insert(
                "residual_norm".to_string(),
                legacy_mode["residual_norm"].clone(),
            );
            object.insert(
                "residual_absolute_l2".to_string(),
                legacy_mode["residual_absolute_l2"].clone(),
            );
            object.insert(
                "residual_relative_l2".to_string(),
                legacy_mode["residual_relative_l2"].clone(),
            );
            object.insert(
                "residual_linf".to_string(),
                legacy_mode["residual_linf"].clone(),
            );
            object.insert("mass_norm".to_string(), legacy_mode["mass_norm"].clone());
            for key in [
                "angular_frequency_imag_rad_per_s",
                "complex_frequency_convention",
                "damping_rate_hz",
                "linewidth_fwhm_hz",
            ] {
                if legacy_mode.get(key).is_some() {
                    object.insert(key.to_string(), legacy_mode[key].clone());
                }
            }
            object.insert(
                "tangent_leakage_mean_abs".to_string(),
                legacy_mode["tangent_leakage_mean_abs"].clone(),
            );
            object.insert(
                "tangent_leakage_max_abs".to_string(),
                legacy_mode["tangent_leakage_max_abs"].clone(),
            );
            object.insert(
                "omega_rad_s".to_string(),
                legacy_mode["omega_rad_s"].clone(),
            );
            object.insert(
                "phasor_convention".to_string(),
                legacy_mode["phasor_convention"].clone(),
            );
            object.insert(
                "eigenvalue_mapping".to_string(),
                legacy_mode["eigenvalue_mapping"].clone(),
            );
            object.insert(
                "gamma_rad_s_T".to_string(),
                legacy_mode["gamma_rad_s_T"].clone(),
            );
            object.insert(
                "gamma0_rad_s_per_A_m".to_string(),
                legacy_mode["gamma0_rad_s_per_A_m"].clone(),
            );
            object.insert(
                "mu0_T_m_per_A".to_string(),
                legacy_mode["mu0_T_m_per_A"].clone(),
            );
            object.insert(
                "dominant_polarization".to_string(),
                legacy_mode["dominant_polarization"].clone(),
            );
            object.insert("k_vector".to_string(), legacy_mode["k_vector"].clone());
            object.insert(
                "value_kind".to_string(),
                serde_json::json!("complex_spatial_vector"),
            );
            object.insert(
                "component_basis".to_string(),
                serde_json::json!("global_xyz"),
            );
            object.insert("component_count".to_string(), serde_json::json!(3));
            object.insert("components".to_string(), serde_json::json!(["x", "y", "z"]));
            object.insert(
                "payload_encoding".to_string(),
                serde_json::json!("f64_interleaved_real_imag_xyz"),
            );
            object.insert(
                "binary_layout".to_string(),
                serde_json::json!("complex_f64_pairs_little_endian"),
            );
            object.insert(
                "complex_pair_count".to_string(),
                serde_json::json!(sample_count * 3),
            );
            object.insert(
                "payload_value_count".to_string(),
                serde_json::json!(sample_count * 6),
            );
            object.insert(
                "available_views".to_string(),
                serde_json::json!([
                    "complex",
                    "real",
                    "imag",
                    "abs",
                    "amplitude",
                    "phase",
                    "phase_rotated_real"
                ]),
            );
            object.insert(
                "default_view".to_string(),
                serde_json::json!("phase_rotated_real"),
            );
            object.insert("default_phase_rad".to_string(), serde_json::json!(0.0));
            object.insert(
                "mode_field_sample_count".to_string(),
                serde_json::json!(sample_count),
            );
            object.insert(
                "amplitude_summary".to_string(),
                mode_amplitude_summary(&legacy_mode["amplitude"], sample_count),
            );
            object.insert(
                "component_summary".to_string(),
                mode_component_summary(sample_count),
            );
            object.insert("storage_format".to_string(), serde_json::json!("zarr"));
            object.insert(
                "zarr_store_path".to_string(),
                serde_json::json!(mode_zarr_store_path()),
            );
            object.insert(
                "zarr_array_path".to_string(),
                serde_json::json!(zarr_array_path),
            );
            object.insert(
                "zarr_chunk_path".to_string(),
                serde_json::json!(zarr_chunk_path.clone()),
            );
            object.insert("zarr_dtype".to_string(), serde_json::json!("<f8"));
            object.insert(
                "zarr_shape".to_string(),
                serde_json::json!([sample_count, 3, 2]),
            );
            object.insert(
                "zarr_chunk_shape".to_string(),
                serde_json::json!([sample_count.max(1), 3, 2]),
            );
            object.insert("zarr_compressor".to_string(), serde_json::Value::Null);
            object.insert(
                "compatibility_binary_payload_path".to_string(),
                serde_json::json!(payload_path.clone()),
            );
        }
        auxiliary_artifacts.push(json_artifact(metadata_path.clone(), &metadata)?);
        let payload_bytes = mode_payload_bytes(&real, &imag);
        if !wrote_mode_zarr_store {
            auxiliary_artifacts.push(zarr_group_artifact(mode_zarr_store_path())?);
            auxiliary_artifacts.push(mode_zarr_store_attrs_artifact()?);
            auxiliary_artifacts.push(zarr_group_artifact(mode_zarr_sample_group_path())?);
            wrote_mode_zarr_store = true;
        }
        auxiliary_artifacts.push(zarr_group_artifact(mode_zarr_mode_group_path(
            raw_mode_index,
        ))?);
        auxiliary_artifacts.push(mode_zarr_array_metadata_artifact(
            raw_mode_index,
            sample_count,
        )?);
        auxiliary_artifacts.push(mode_zarr_array_attrs_artifact(
            raw_mode_index,
            sample_count,
        )?);
        auxiliary_artifacts.push(binary_artifact(zarr_chunk_path, payload_bytes.clone()));
        auxiliary_artifacts.push(binary_artifact(payload_path, payload_bytes));
        mode_metadata_paths.push(metadata_path);
        mode_resource_keys.push(mode_meta_resource_key(raw_mode_index));
    }

    auxiliary_artifacts.push(json_artifact(
        "eigen/diagnostics/solver.v1.json",
        &modal_solver_diagnostics_json(plan, solver_model, modes.len()),
    )?);

    auxiliary_artifacts.push(json_artifact(
        "frequency_domain/manifest.v1.json",
        &serde_json::json!({
            "schema_version": "frequency_domain_manifest.v1",
            "analysis_family": "magnetic_frequency_domain",
            "study_product": "modal_eigen",
            "stage_kind": "eigenmodes",
            "status": "ready",
            "complete": true,
            "physics": {
                "analysis_family": "magnetic_frequency_domain",
                "phase_convention": "exp_minus_i_omega_t",
                "frequency_units": "Hz",
                "field_units": "dimensionless_delta_m",
                "normalization": normalization_label(plan.normalization),
            },
            "artifacts": {
                "spectrum_v2_path": "eigen/spectrum.v2.json",
                "branches_v2_path": "eigen/branches.v2.json",
                "dispersion_csv_path": "eigen/dispersion.csv",
                "solver_diagnostics_path": "eigen/diagnostics/solver.v1.json",
                "mode_field_zarr_store_path": mode_zarr_store_path(),
                "mode_field_storage_format": "zarr",
                "mode_metadata_paths": mode_metadata_paths,
            },
            "resources": {
                "spectrum_resource_key": "/v2/sessions/current/analysis/frequency-domain/eigen/spectrum.v2",
                "branches_resource_key": "/v2/sessions/current/analysis/frequency-domain/eigen/branches.v2",
                "dispersion_resource_key": "/v2/sessions/current/analysis/frequency-domain/eigen/dispersion",
                "mode_field_resources": mode_resource_keys,
            },
            "diagnostics": {
                "tracking_score_source": "seed_only",
                "modal_overlap_available": false,
            },
        }),
    )?);

    Ok(())
}

fn normalization_label(normalization: EigenNormalizationIR) -> &'static str {
    match normalization {
        EigenNormalizationIR::UnitL2 => "unit_l2",
        EigenNormalizationIR::UnitMaxAmplitude => "unit_max_amplitude",
    }
}

fn modal_solver_diagnostics_json(
    plan: &FemEigenPlanIR,
    solver_model: &str,
    mode_count: usize,
) -> serde_json::Value {
    let mut diagnostics = serde_json::json!({
        "schema_version": "frequency_domain_modal_solver_diagnostics.v1",
        "study_product": "modal_eigen",
        "status": "ready",
        "complete": true,
        "solver_model": solver_model,
        "resolved_solver_family": solver_model,
        "spectral_transform": "none",
        "algebraic_form": "reference_effective_field_generalized",
        "matrix_equation": "K u = lambda M u",
        "phasor_convention": "not_applicable_real_reference",
        "eigenvalue_mapping": "omega_rad_s = gamma0_rad_s_per_A_m * max(lambda_A_per_m, 0)",
        "frequency_mapping": "frequency_hz = omega_rad_s / (2*pi)",
        "production_gyrotropic_mapping": false,
        "sample_count": 1,
        "mode_count": mode_count,
        "requested_mode_count": plan.count,
        "normalization": normalization_label(plan.normalization),
    });
    merge_modal_transport_diagnostics(&mut diagnostics, modal_tangent_transport_diagnostics(plan));
    if let fullmag_ir::EigenTargetIR::FrequencyWindow {
        frequency_min_hz,
        frequency_max_hz,
    } = plan.target
    {
        let window_width = frequency_max_hz - frequency_min_hz;
        let relative_width = if frequency_min_hz > 0.0 {
            window_width / frequency_min_hz
        } else {
            0.0
        };
        let subwindow_count = (relative_width / 0.35).ceil().max(1.0).min(16.0) as usize;
        let guard_fraction = 0.25;
        let mut subwindows = Vec::with_capacity(subwindow_count);
        let mut resolved_min_hz = frequency_min_hz;
        let mut resolved_max_hz = frequency_max_hz;
        for index in 0..subwindow_count {
            let sub_min = frequency_min_hz + index as f64 * window_width / subwindow_count as f64;
            let sub_max =
                frequency_min_hz + (index + 1) as f64 * window_width / subwindow_count as f64;
            let sub_width = sub_max - sub_min;
            let search_min = (sub_min - guard_fraction * sub_width).max(0.0);
            let search_max = sub_max + guard_fraction * sub_width;
            let shift_frequency_hz = 0.5 * (sub_min + sub_max);
            resolved_min_hz = resolved_min_hz.min(search_min);
            resolved_max_hz = resolved_max_hz.max(search_max);
            subwindows.push(serde_json::json!({
                "index": index,
                "requested_hz": [sub_min, sub_max],
                "search_hz": [search_min, search_max],
                "shift_hz": shift_frequency_hz,
                "shift_frequency_hz": shift_frequency_hz,
                "shift_omega_rad_s": 2.0 * std::f64::consts::PI * shift_frequency_hz,
                "outer_iterations": 0,
                "linear_iterations_total": 0,
                "candidate_modes": 0,
                "accepted_modes": 0,
                "residual_max": 0.0,
                "stop_reason": "window_exhausted",
            }));
        }
        if let Some(object) = diagnostics.as_object_mut() {
            object.insert(
                "requested_window_hz".to_string(),
                serde_json::json!([frequency_min_hz, frequency_max_hz]),
            );
            object.insert(
                "resolved_search_window_hz".to_string(),
                serde_json::json!([resolved_min_hz, resolved_max_hz]),
            );
            object.insert(
                "window_completeness".to_string(),
                serde_json::json!({
                    "policy": "best_effort",
                    "status": "not_certified",
                    "certification_method": "none",
                    "estimated_modes_in_window": 0,
                    "certified_modes_in_window": 0,
                    "additional_modes_may_exist": true,
                }),
            );
            object.insert("subwindows".to_string(), serde_json::json!(subwindows));
        }
    }
    if let Some(reason) = native_cpu_modal_window_rejection_reason(plan) {
        if let Some(object) = diagnostics.as_object_mut() {
            object.insert(
                "production_cpu_rejection_reason".to_string(),
                serde_json::json!(reason),
            );
            object.insert(
                "production_cpu_rejection_scope".to_string(),
                serde_json::json!("selected_spectrum_nonzero_k_floquet_modal"),
            );
            insert_native_cpu_modal_window_rejection_contract(object);
        }
    }
    diagnostics
}

pub(crate) fn modal_tangent_transport_diagnostics(plan: &FemEigenPlanIR) -> serde_json::Value {
    if !matches!(
        plan.spin_wave_bc.kind(),
        SpinWaveBoundaryKindIR::Periodic | SpinWaveBoundaryKindIR::Floquet
    ) {
        return serde_json::json!({
            "basis_transport_policy": "not_applicable",
            "floquet_tangent_frame_max_mismatch": 0.0,
            "floquet_tangent_transport_max_nonunitarity": 0.0,
        });
    }

    let topology = match MeshTopology::from_ir(&plan.mesh) {
        Ok(topology) => topology,
        Err(error) => {
            return serde_json::json!({
                "basis_transport_policy": "unavailable",
                "basis_transport_error": format!("MeshTopology: {}", error),
                "floquet_tangent_frame_max_mismatch": f64::NAN,
                "floquet_tangent_transport_max_nonunitarity": f64::NAN,
            });
        }
    };
    let requested_pair_ids = plan.spin_wave_bc.boundary_pair_ids();
    let selected_pairs = topology
        .periodic_node_pairs
        .iter()
        .filter(|(pair_id, _, _)| {
            requested_pair_ids.is_empty()
                || requested_pair_ids
                    .iter()
                    .any(|requested| *requested == pair_id)
        })
        .cloned()
        .collect::<Vec<_>>();
    let bases = tangent_bases(&plan.equilibrium_magnetization);
    let mut max_mismatch: f64 = 0.0;
    let mut max_nonunitarity: f64 = 0.0;
    for (_, node_a, node_b) in selected_pairs {
        let node_a = node_a as usize;
        let node_b = node_b as usize;
        if node_a >= bases.len()
            || node_b >= bases.len()
            || topology.magnetic_node_volumes[node_a] <= 0.0
            || topology.magnetic_node_volumes[node_b] <= 0.0
        {
            continue;
        }
        let transport = tangent_transport_matrix(bases[node_a], bases[node_b]);
        max_mismatch = max_mismatch.max(tangent_frame_identity_mismatch(
            bases[node_a],
            bases[node_b],
        ));
        max_nonunitarity = max_nonunitarity.max(tangent_transport_nonunitarity(transport));
    }
    serde_json::json!({
        "basis_transport_policy": if matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
            "tangent_frame_transport"
        } else {
            "tangent_frame_identity"
        },
        "floquet_tangent_frame_max_mismatch": max_mismatch,
        "floquet_tangent_transport_max_nonunitarity": max_nonunitarity,
    })
}

fn merge_modal_transport_diagnostics(target: &mut serde_json::Value, transport: serde_json::Value) {
    let Some(target_object) = target.as_object_mut() else {
        return;
    };
    let Some(transport_object) = transport.as_object() else {
        return;
    };
    for (key, value) in transport_object {
        target_object.insert(key.clone(), value.clone());
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
        EigenDampingPolicyIR::Include => damping.abs() / (1.0 + damping * damping),
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
        "pair_ids": bc.boundary_pair_ids(),
        "phase_convention": bc.phase_convention(),
        "surface_anisotropy_ks": bc.surface_anisotropy_ks(),
        "surface_anisotropy_axis": bc.surface_anisotropy_axis(),
    })
}

fn solver_kind_label(plan: &FemEigenPlanIR) -> &'static str {
    if matches!(plan.spin_wave_bc.kind(), SpinWaveBoundaryKindIR::Floquet) {
        if matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
            "cpu_full_2x2_phase_reduced_floquet"
        } else {
            "cpu_phase_reduced_floquet"
        }
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
    if complex_reduction && matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
        "phase-aware Floquet reduction on the full 2x2 tangent-frame block with phase*(T_node^T T_root) transport"
    } else if complex_reduction {
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
            fullmag_ir::ResolvedFemDemagIR::Bem => capabilities.push("demag_bem"),
            fullmag_ir::ResolvedFemDemagIR::FredkinKoehler => {
                capabilities.push("demag_fredkin_koehler")
            }
            fullmag_ir::ResolvedFemDemagIR::Fmm => capabilities.push("demag_fmm"),
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
    if matches!(
        plan.target,
        fullmag_ir::EigenTargetIR::FrequencyWindow { .. }
    ) {
        capabilities.push("frequency_window_filter");
    }
    if complex_reduction {
        capabilities.push("complex_mode_projection");
        if matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
            capabilities.push("floquet_tangent_frame_transport");
        }
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
    if matches!(
        plan.target,
        fullmag_ir::EigenTargetIR::FrequencyWindow { .. }
    ) {
        limitations.push("frequency_window_is_filtered_after_reference_solve");
        limitations.push("frequency_window_sparse_lobpcg_uses_oversampled_lowest_candidates");
        limitations.push("no_shift_invert_or_feast_window_solver_yet");
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
        if !matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
            limitations.push("scalar_floquet_requires_identity_tangent_frame_transport");
        }
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
    realization.provenance_name()
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

fn dispersion_v2_csv(k_sampling: Option<&KSamplingIR>, modes: &serde_json::Value) -> String {
    let k_vector = match k_sampling {
        Some(KSamplingIR::Single { k_vector }) => *k_vector,
        Some(KSamplingIR::Path { .. }) => [0.0, 0.0, 0.0],
        None => [0.0, 0.0, 0.0],
    };
    let label = if k_vector.iter().all(|value| *value == 0.0) {
        "Γ"
    } else {
        ""
    };
    let mut csv = String::from(
        "sample_index,path_s_rad_per_m,kx_rad_per_m,ky_rad_per_m,kz_rad_per_m,label,raw_mode_index,branch_id,frequency_hz,omega_rad_s,line_width_hz,residual_norm,overlap_score,tracking_score_source,mode_field_id,mode_field_resource_key\n",
    );
    if let Some(entries) = modes.as_array() {
        for entry in entries {
            let raw_mode_index = entry["index"].as_u64().unwrap_or(0);
            let residual_norm = entry["residual_norm"]
                .as_f64()
                .map(|value| format!("{value:.16e}"))
                .unwrap_or_default();
            let line_width_hz = entry["frequency_imag_hz"]
                .as_f64()
                .filter(|value| value.is_finite() && *value > 0.0)
                .map(|value| format!("{:.16e}", 2.0 * value))
                .unwrap_or_default();
            csv.push_str(&format!(
                "0,{:.16e},{:.16e},{:.16e},{:.16e},{},{},{},{:.16e},{:.16e},{},{},{},seed,{},{}\n",
                0.0,
                k_vector[0],
                k_vector[1],
                k_vector[2],
                label,
                raw_mode_index,
                "",
                entry["frequency_hz"].as_f64().unwrap_or(0.0),
                entry["angular_frequency_rad_per_s"].as_f64().unwrap_or(0.0),
                line_width_hz,
                residual_norm,
                "",
                mode_field_id(raw_mode_index),
                mode_field_resource_key(raw_mode_index),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal_native_modal_plan() -> FemEigenPlanIR {
        FemEigenPlanIR {
            mesh_name: "native_modal_mesh".to_string(),
            mesh_source: None,
            mesh: fullmag_ir::MeshIR {
                mesh_name: "native_modal_mesh".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                ],
                elements: vec![[0, 1, 2, 3]],
                element_markers: vec![1],
                boundary_faces: vec![[0, 1, 2]],
                boundary_markers: vec![1],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            },
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
            domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
            domain_frame: None,
            fe_order: 1,
            hmax: 1.0,
            equilibrium_magnetization: vec![
                [1.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
            ],
            material: fullmag_ir::MaterialIR {
                name: "Py".to_string(),
                saturation_magnetisation: 8.0e5,
                exchange_stiffness: 1.3e-11,
                damping: 0.01,
                uniaxial_anisotropy: None,
                uniaxial_anisotropy_k2: None,
                anisotropy_axis: None,
                cubic_anisotropy_kc1: None,
                cubic_anisotropy_kc2: None,
                cubic_anisotropy_kc3: None,
                cubic_anisotropy_axis1: None,
                cubic_anisotropy_axis2: None,
                ms_field: None,
                a_field: None,
                alpha_field: None,
                ku_field: None,
                ku2_field: None,
                kc1_field: None,
                kc2_field: None,
                kc3_field: None,
                interfacial_dmi: None,
                bulk_dmi: None,
                dind_field: None,
                dbulk_field: None,
            },
            operator: fullmag_ir::EigenOperatorConfigIR {
                kind: fullmag_ir::EigenOperatorIR::LinearizedLlg,
                include_demag: false,
            },
            count: 6,
            target: fullmag_ir::EigenTargetIR::FrequencyWindow {
                frequency_min_hz: 1.0e8,
                frequency_max_hz: 5.0e9,
            },
            equilibrium: EquilibriumSourceIR::RelaxedInitialState,
            k_sampling: Some(KSamplingIR::Single {
                k_vector: [0.0, 0.0, 0.0],
            }),
            normalization: EigenNormalizationIR::UnitL2,
            damping_policy: EigenDampingPolicyIR::Include,
            enable_exchange: true,
            enable_demag: false,
            interfacial_dmi: None,
            dmi_interface_normal: None,
            bulk_dmi: None,
            external_field: None,
            gyromagnetic_ratio: 2.211e5,
            precision: fullmag_ir::ExecutionPrecision::Double,
            exchange_bc: fullmag_ir::ExchangeBoundaryCondition::Neumann,
            spin_wave_bc: SpinWaveBoundaryConditionIR::default(),
            demag_realization: None,
            air_box_config: None,
            mode_tracking: None,
            dispersion_validation: None,
        }
    }

    fn add_x_floquet_pair_to_plan(plan: &mut FemEigenPlanIR) {
        plan.mesh.periodic_boundary_pairs = vec![fullmag_ir::MeshPeriodicBoundaryPairIR {
            pair_id: "x_faces".to_string(),
            source_marker: None,
            destination_marker: None,
            marker_a: 10,
            marker_b: 11,
            translation: Some([1.0, 0.0, 0.0]),
            tolerance: Some(1e-12),
            axis_hint: None,
            orientation: None,
            pairing_policy: None,
        }];
        plan.mesh.periodic_node_pairs = vec![fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "x_faces".to_string(),
            node_a: 0,
            node_b: 1,
        }];
        plan.spin_wave_bc =
            SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: SpinWaveBoundaryKindIR::Floquet,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            });
        plan.k_sampling = Some(KSamplingIR::Single {
            k_vector: [1.0e6, 0.0, 0.0],
        });
    }

    #[test]
    fn sparse_eigen_threshold_covers_mid_sized_full_2x2_smoke_meshes() {
        assert!(
            SPARSE_EIGEN_THRESHOLD <= 3_000,
            "mid-sized full 2x2 FEM eigensolve smoke meshes must use sparse LOBPCG instead of dense O(n^3) diagonalization"
        );
    }

    #[test]
    fn frequency_window_sparse_lobpcg_oversamples_candidates() {
        let target = fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz: 1.0,
            frequency_max_hz: 2.0,
        };

        assert_eq!(sparse_lobpcg_candidate_count(&target, 20, 10), 10);
        assert_eq!(sparse_lobpcg_candidate_count(&target, 20, 50), 50);
        assert!(sparse_lobpcg_candidate_count(&target, 20, 200) > 20);
        assert!(sparse_lobpcg_candidate_count(&target, 40, 10_000) > 40);
    }

    #[test]
    fn native_modal_gyrotropic_pencil_uses_exp_i_omega_t_sign() {
        let mass = DMatrix::identity(2, 2);

        let gyrotropic = gyrotropic_matrix_row_major_from_tangent_mass(&mass, 1)
            .expect("single macrospin tangent mass should build a pencil matrix");

        assert_eq!(gyrotropic, vec![0.0, 1.0, -1.0, 0.0]);
    }

    #[test]
    fn native_modal_lambda_i_omega_macrospin_mapping_has_positive_frequency_residual() {
        let stiffness_omega = DMatrix::identity(2, 2);
        let mass = DMatrix::identity(2, 2);
        let gyrotropic = gyrotropic_matrix_row_major_from_tangent_mass(&mass, 1)
            .expect("single macrospin tangent mass should build a pencil matrix");
        let lambda = Complex64::new(0.0, 1.0);
        let mode = vec![Complex64::new(1.0, 0.0), Complex64::new(0.0, -1.0)];

        let (absolute, relative, linf) =
            gyrotropic_pencil_residual_norms(&stiffness_omega, &gyrotropic, lambda, &mode);

        assert!(absolute < 1.0e-14);
        assert!(relative < 1.0e-14);
        assert!(linf < 1.0e-14);
        validate_native_modal_lambda_frequency_mapping(
            lambda.im,
            lambda.im,
            1.0 / std::f64::consts::TAU,
        )
        .expect("lambda=i*omega maps to positive frequency for the accepted branch");
    }

    #[test]
    fn native_modal_lambda_i_omega_mapping_rejects_negative_branch() {
        let error =
            validate_native_modal_lambda_frequency_mapping(-1.0, 1.0, 1.0 / std::f64::consts::TAU)
                .expect_err("negative-frequency conjugate branch must not pass as accepted mode");

        assert!(error.message.contains("positive-frequency branch"));
    }

    #[test]
    fn damping_linewidth_uses_exp_i_omega_t_decay_sign() {
        let alpha = 0.05;
        let factor = damping_imaginary_factor(alpha, EigenDampingPolicyIR::Include);

        assert!(factor > 0.0);
        assert!((factor - alpha / (1.0 + alpha * alpha)).abs() < 1.0e-15);
        assert_eq!(
            damping_imaginary_factor(alpha, EigenDampingPolicyIR::Ignore),
            0.0
        );
        assert_eq!(
            damping_imaginary_factor(-alpha, EigenDampingPolicyIR::Include),
            factor
        );
    }

    #[test]
    fn dispersion_csv_maps_positive_imaginary_frequency_to_fwhm_linewidth() {
        let modes = serde_json::json!([
            {
                "index": 0,
                "frequency_hz": 1.0e9,
                "frequency_imag_hz": 2.5e6,
                "angular_frequency_rad_per_s": 2.0 * std::f64::consts::PI * 1.0e9,
                "residual_norm": 1.0e-9
            }
        ]);

        let csv = dispersion_v2_csv(None, &modes);
        let header = csv
            .lines()
            .next()
            .expect("dispersion CSV should include a header");
        assert!(header.contains("tracking_score_source"));
        assert!(header.contains("mode_field_id"));
        assert!(header.contains("mode_field_resource_key"));
        let row = csv
            .lines()
            .nth(1)
            .expect("dispersion CSV should include one data row");
        let columns: Vec<&str> = row.split(',').collect();

        assert_eq!(columns[10], "5.0000000000000000e6");
        assert_eq!(columns[13], "seed");
        assert_eq!(columns[14], "analysis:eigen:sample-0000:mode-0000");
        assert_eq!(
            columns[15],
            "/v2/sessions/current/data/fields/analysis:eigen:sample-0000:mode-0000/samples/vector?view=phase_rotated_real&phase_rad=0"
        );
    }

    #[test]
    fn non_window_sparse_lobpcg_keeps_requested_count() {
        let target = fullmag_ir::EigenTargetIR::Lowest;

        assert_eq!(sparse_lobpcg_candidate_count(&target, 20, 200), 20);
    }

    #[test]
    fn sparse_frequency_window_without_retained_modes_fails_clearly() {
        let target = fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz: 1.0,
            frequency_max_hz: 2.0,
        };

        let error = reject_empty_frequency_window_result(&target, 60, 60, 0)
            .expect_err("empty sparse frequency-window results must not look successful");
        assert!(error
            .message
            .contains("cannot guarantee interior-window coverage"));
    }

    #[test]
    fn frequency_window_solver_diagnostics_publish_completeness() {
        let plan = minimal_native_modal_plan();

        let diagnostics = modal_solver_diagnostics_json(&plan, "cpu_sparse_lobpcg", 6);

        assert_eq!(
            diagnostics
                .get("resolved_solver_family")
                .and_then(|value| value.as_str()),
            Some("cpu_sparse_lobpcg")
        );
        assert_eq!(
            diagnostics
                .get("spectral_transform")
                .and_then(|value| value.as_str()),
            Some("none")
        );
        assert_eq!(
            diagnostics
                .get("window_completeness")
                .and_then(|value| value.get("policy"))
                .and_then(|value| value.as_str()),
            Some("best_effort")
        );
        assert_eq!(
            diagnostics
                .get("requested_mode_count")
                .and_then(|value| value.as_u64()),
            Some(u64::from(plan.count))
        );
        assert_eq!(
            diagnostics
                .get("window_completeness")
                .and_then(|value| value.get("status"))
                .and_then(|value| value.as_str()),
            Some("not_certified")
        );
        assert!(diagnostics
            .get("subwindows")
            .and_then(|value| value.as_array())
            .is_some_and(|subwindows| !subwindows.is_empty()));
        let first_subwindow = &diagnostics
            .get("subwindows")
            .and_then(|value| value.as_array())
            .expect("subwindows must be present")[0];
        let requested_hz = first_subwindow
            .get("requested_hz")
            .and_then(|value| value.as_array())
            .expect("subwindow requested_hz must be present");
        let expected_shift_frequency_hz = 0.5
            * (requested_hz[0]
                .as_f64()
                .expect("requested lower bound must be numeric")
                + requested_hz[1]
                    .as_f64()
                    .expect("requested upper bound must be numeric"));
        let shift_frequency_hz = first_subwindow
            .get("shift_frequency_hz")
            .and_then(|value| value.as_f64())
            .expect("subwindow shift_frequency_hz must be present");
        let legacy_shift_hz = first_subwindow
            .get("shift_hz")
            .and_then(|value| value.as_f64())
            .expect("subwindow shift_hz must be present");
        assert_eq!(shift_frequency_hz, legacy_shift_hz);
        assert_eq!(shift_frequency_hz, expected_shift_frequency_hz);
        assert_eq!(
            first_subwindow
                .get("shift_omega_rad_s")
                .and_then(|value| value.as_f64()),
            Some(2.0 * std::f64::consts::PI * shift_frequency_hz)
        );
    }

    #[test]
    fn native_frequency_window_solver_diagnostics_publish_mode_count() {
        let mut plan = minimal_native_modal_plan();
        plan.count = 10;
        plan.target = fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz: 1.0e8,
            frequency_max_hz: 5.0e9,
        };
        let diagnostics_json = serde_json::json!({
            "accepted_mode_count": 1,
            "accepted_mode_count_after_dedup": 1,
            "resolved_solver_family": "shift_invert",
            "solver_model": "slepc_multi_shift_invert_production_cpu_dense",
            "spectral_transform": "shift_invert",
            "requested_window_hz": [1.0e8, 5.0e9],
            "resolved_search_window_hz": [7.5e7, 5.125e9],
            "window_completeness": {
                "policy": "certified_count",
                "status": "not_certified",
                "certification_method": "none",
                "estimated_modes_in_window": 0,
                "certified_modes_in_window": 0,
                "additional_modes_may_exist": true,
            },
            "subwindows": [
                {
                    "index": 0,
                    "requested_hz": [1.0e8, 5.0e9],
                    "search_hz": [7.5e7, 5.125e9],
                    "shift_hz": 2.55e9,
                    "shift_frequency_hz": 2.55e9,
                    "shift_omega_rad_s": std::f64::consts::TAU * 2.55e9,
                    "outer_iterations": 1,
                    "linear_iterations_total": 1,
                    "candidate_modes": 12,
                    "accepted_modes": 1,
                    "residual_max": 0.0,
                    "stop_reason": "converged",
                }
            ],
        });

        let diagnostics_raw =
            serde_json::to_string(&diagnostics_json).expect("diagnostics JSON should serialize");
        let diagnostics = native_solver_diagnostics_json(&plan, &diagnostics_raw)
            .expect("native diagnostics should be normalized");

        assert_eq!(
            diagnostics
                .get("mode_count")
                .and_then(|value| value.as_u64()),
            Some(1)
        );
        assert_eq!(
            diagnostics
                .get("requested_mode_count")
                .and_then(|value| value.as_u64()),
            Some(10)
        );
    }

    #[test]
    fn native_cpu_modal_window_accepts_explicit_gamma_single_k() {
        let mut plan = minimal_native_modal_plan();
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.damping_policy = EigenDampingPolicyIR::Ignore;
        plan.k_sampling = Some(KSamplingIR::Single {
            k_vector: [0.0, 0.0, 0.0],
        });

        assert!(
            native_cpu_modal_window_enabled(&plan),
            "explicit gamma-point single-k sampling must not demote the production CPU window path"
        );
    }

    #[test]
    fn native_cpu_modal_window_rejects_nonzero_single_k_until_floquet_operator_exists() {
        let mut plan = minimal_native_modal_plan();
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.damping_policy = EigenDampingPolicyIR::Ignore;
        plan.k_sampling = Some(KSamplingIR::Single {
            k_vector: [1.0e6, 0.0, 0.0],
        });

        assert!(
            !native_cpu_modal_window_enabled(&plan),
            "nonzero-k modal production still requires a real Floquet/Bloch operator path"
        );
    }

    #[test]
    fn native_cpu_modal_window_accepts_nonzero_floquet_single_k_with_bloch_payload_path() {
        let mut plan = minimal_native_modal_plan();
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.damping_policy = EigenDampingPolicyIR::Ignore;
        add_x_floquet_pair_to_plan(&mut plan);

        assert!(
            native_cpu_modal_window_enabled(&plan),
            "nonzero-k Floquet Full2x2 frequency-window requests should use the native Bloch/Floquet payload path"
        );
        assert_eq!(native_cpu_modal_window_rejection_reason(&plan), None);
    }

    #[test]
    fn reference_modal_diagnostics_name_nonzero_k_production_cpu_rejection() {
        let mut plan = minimal_native_modal_plan();
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.damping_policy = EigenDampingPolicyIR::Ignore;
        plan.spin_wave_bc =
            SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: SpinWaveBoundaryKindIR::Floquet,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            });
        plan.k_sampling = Some(KSamplingIR::Single {
            k_vector: [1.0e6, 0.0, 0.0],
        });

        let diagnostics =
            modal_solver_diagnostics_json(&plan, "cpu_full_2x2_phase_reduced_floquet", 1);

        assert_eq!(
            diagnostics
                .get("production_cpu_rejection_reason")
                .and_then(|value| value.as_str()),
            Some("production_cpu_modal_nonzero_k_floquet_operator_missing")
        );
        assert_eq!(
            diagnostics
                .get("production_cpu_rejection_scope")
                .and_then(|value| value.as_str()),
            Some("selected_spectrum_nonzero_k_floquet_modal")
        );
        assert_eq!(
            diagnostics
                .get("required_operator_contract")
                .and_then(|value| value.as_str()),
            Some("bloch_floquet_tangent_operator_with_periodic_pairs")
        );
        assert_eq!(
            diagnostics
                .get("required_operator_payload_kind")
                .and_then(|value| value.as_str()),
            Some("bloch_floquet_tangent_operator")
        );
        assert_eq!(
            diagnostics
                .get("modal_periodic_pair_contract_available")
                .and_then(|value| value.as_bool()),
            Some(false)
        );
    }

    #[test]
    fn sparse_lowest_without_retained_modes_does_not_raise_window_error() {
        let target = fullmag_ir::EigenTargetIR::Lowest;

        reject_empty_frequency_window_result(&target, 20, 0, 0)
            .expect("lowest target does not use the frequency-window coverage diagnostic");
    }

    #[test]
    fn runner_rejects_floquet_dynamic_demag_gate() {
        let bc = SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
            kind: SpinWaveBoundaryKindIR::Floquet,
            boundary_pair_id: Some("x_faces".to_string()),
            pair_ids: Vec::new(),
            phase_convention: fullmag_ir::PhaseConventionIR::default(),
            surface_anisotropy_ks: None,
            surface_anisotropy_axis: None,
        });

        let err = reject_unsupported_floquet_dynamic_demag(&bc, true)
            .expect_err("Floquet dynamic demag must be blocked before execution");
        assert!(err
            .message
            .contains("dynamic demag for Floquet periodic FEM is not implemented yet"));
    }

    #[test]
    fn runner_allows_floquet_without_dynamic_demag_gate() {
        let bc = SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
            kind: SpinWaveBoundaryKindIR::Floquet,
            boundary_pair_id: Some("x_faces".to_string()),
            pair_ids: Vec::new(),
            phase_convention: fullmag_ir::PhaseConventionIR::default(),
            surface_anisotropy_ks: None,
            surface_anisotropy_axis: None,
        });

        reject_unsupported_floquet_dynamic_demag(&bc, false)
            .expect("Floquet phase reduction remains valid when dynamic demag is disabled");
    }

    #[test]
    fn floquet_phase_uses_minus_sign_and_boundary_translation() {
        let mesh = fullmag_ir::MeshIR {
            mesh_name: "periodic_tet".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ],
            elements: vec![[0, 1, 2, 3]],
            element_markers: vec![1],
            boundary_faces: vec![[0, 2, 3], [1, 2, 3]],
            boundary_markers: vec![10, 11],
            periodic_boundary_pairs: vec![fullmag_ir::MeshPeriodicBoundaryPairIR {
                pair_id: "x_faces".to_string(),
                source_marker: None,
                destination_marker: None,
                marker_a: 10,
                marker_b: 11,
                translation: Some([1.0, 0.0, 0.0]),
                tolerance: Some(1e-12),
                axis_hint: None,
                orientation: None,
                pairing_policy: None,
            }],
            periodic_node_pairs: vec![fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "x_faces".to_string(),
                node_a: 0,
                node_b: 1,
            }],
            per_domain_quality: std::collections::HashMap::new(),
        };
        let topology = MeshTopology::from_ir(&mesh).expect("valid FEM mesh");
        let bc = SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
            kind: SpinWaveBoundaryKindIR::Floquet,
            boundary_pair_id: Some("x_faces".to_string()),
            pair_ids: Vec::new(),
            phase_convention: fullmag_ir::PhaseConventionIR::default(),
            surface_anisotropy_ks: None,
            surface_anisotropy_axis: None,
        });

        let groups = phase_reduction(
            &topology,
            &bc,
            Some(&KSamplingIR::Single {
                k_vector: [std::f64::consts::FRAC_PI_2, 0.0, 0.0],
            }),
        )
        .expect("Floquet phase reduction should be built")
        .expect("Floquet BC should produce phase groups");

        let phase = groups.phases[1];
        assert!(
            phase.re.abs() < 1e-12,
            "phase should be imaginary: {phase:?}"
        );
        assert!(
            (phase.im + 1.0).abs() < 1e-12,
            "expected exp(-i*pi/2) from boundary translation, got {phase:?}"
        );
    }

    #[test]
    fn native_modal_floquet_pair_payload_uses_selected_boundary_translation() {
        let mut plan = minimal_native_modal_plan();
        plan.mesh = fullmag_ir::MeshIR {
            mesh_name: "periodic_tet".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ],
            elements: vec![[0, 1, 2, 3]],
            element_markers: vec![1],
            boundary_faces: vec![[0, 2, 3], [1, 2, 3]],
            boundary_markers: vec![10, 11],
            periodic_boundary_pairs: vec![fullmag_ir::MeshPeriodicBoundaryPairIR {
                pair_id: "x_faces".to_string(),
                source_marker: None,
                destination_marker: None,
                marker_a: 10,
                marker_b: 11,
                translation: Some([1.0, 0.0, 0.0]),
                tolerance: Some(1e-12),
                axis_hint: None,
                orientation: None,
                pairing_policy: None,
            }],
            periodic_node_pairs: vec![fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "x_faces".to_string(),
                node_a: 0,
                node_b: 1,
            }],
            per_domain_quality: std::collections::HashMap::new(),
        };
        plan.spin_wave_bc =
            SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: SpinWaveBoundaryKindIR::Floquet,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            });
        plan.k_sampling = Some(KSamplingIR::Single {
            k_vector: [std::f64::consts::FRAC_PI_2, 0.0, 0.0],
        });

        let topology = MeshTopology::from_ir(&plan.mesh).expect("valid FEM mesh");
        let pairs = native_modal_floquet_periodic_pairs(&plan, &topology)
            .expect("native modal Floquet pairs should be built");

        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0].pair_id, Some("x_faces"));
        assert_eq!(pairs[0].node_a, 0);
        assert_eq!(pairs[0].node_b, 1);
        assert_eq!(pairs[0].translation_m, Some([1.0, 0.0, 0.0]));
        assert_eq!(pairs[0].phase_rad, Some(-std::f64::consts::FRAC_PI_2));
    }

    #[test]
    fn bloch_floquet_dense_payload_embeds_complex_operator_as_gyrotropic_pencil() {
        let stiffness = vec![vec![Complex64::new(2.0, 0.0)]];
        let mass = vec![vec![Complex64::new(1.0, 0.0)]];

        let payload = native_bloch_floquet_dense_payload_from_complex_pair(&stiffness, &mass)
            .expect("1x1 complex operator should embed as native Bloch/Floquet payload");

        assert_eq!(payload.physical_complex_dof, 1);
        assert_eq!(payload.stiffness.nrows(), 4);
        assert_eq!(payload.stiffness.ncols(), 4);
        assert_eq!(
            payload.gyrotropic_row_major,
            vec![
                0.0, 0.0, -1.0, 0.0, //
                0.0, 0.0, 0.0, -1.0, //
                1.0, 0.0, 0.0, 0.0, //
                0.0, 1.0, 0.0, 0.0,
            ]
        );
        assert_eq!(payload.tangent_mass.nrows(), 4);
        assert_eq!(payload.tangent_mass.ncols(), 4);

        let mode = vec![
            Complex64::new(1.0, 0.0),
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 1.0),
            Complex64::new(0.0, 0.0),
        ];
        let lambda = Complex64::new(0.0, 2.0);
        let (absolute, relative, linf) = gyrotropic_pencil_residual_norms(
            &payload.stiffness,
            &payload.gyrotropic_row_major,
            lambda,
            &mode,
        );

        assert!(absolute < 1.0e-12, "absolute residual={absolute}");
        assert!(relative < 1.0e-12, "relative residual={relative}");
        assert!(linf < 1.0e-12, "linf residual={linf}");
    }

    #[test]
    fn bloch_floquet_embedded_native_mode_deembeds_to_physical_complex_mode() {
        let physical_mode = vec![Complex64::new(1.0, 2.0), Complex64::new(-0.5, 0.25)];
        let real_block = vec![
            Complex64::new(physical_mode[0].re, 0.0),
            Complex64::new(physical_mode[1].re, 0.0),
            Complex64::new(physical_mode[0].im, 0.0),
            Complex64::new(physical_mode[1].im, 0.0),
        ];
        let mut embedded = real_block.clone();
        embedded.extend(real_block.iter().map(|value| Complex64::i() * *value));

        let deembedded = deembed_native_bloch_floquet_mode_vector(&embedded, physical_mode.len())
            .expect("embedded native mode should deembed to the physical complex mode");

        assert_eq!(deembedded.len(), physical_mode.len());
        for (actual, expected) in deembedded.iter().zip(physical_mode.iter()) {
            assert!(
                (*actual - *expected).norm() < 1.0e-12,
                "actual={actual:?}, expected={expected:?}"
            );
        }
    }

    #[test]
    fn native_frequency_domain_unavailable_modal_is_not_treated_as_dense_fallback() {
        let err = execute_gpu_fem_eigen(&minimal_native_modal_plan(), &[])
            .expect_err("explicit native modal path must not fall back to dense reference solve");
        assert!(
            err.message
                .contains("native FEM modal_eigen production path is unavailable")
                || err
                    .message
                    .contains("native FEM modal eigen solve requires the fem-gpu feature"),
            "unexpected native modal error: {}",
            err.message
        );
        assert!(
            !err.message.contains("FEM eigen GPU solve succeeded"),
            "explicit native modal path must not report dense GPU success"
        );
        assert!(
            !err.message.contains("cuSolverDN"),
            "explicit native modal path must not expose dense GPU fallback details"
        );
        if err.message.contains("diagnostics_json=") {
            assert!(
                err.message.contains("modal_eigen"),
                "missing modal diagnostics"
            );
        }
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn cpu_full_2x2_frequency_window_uses_native_modal_artifact_path() {
        let mut plan = minimal_native_modal_plan();
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.damping_policy = EigenDampingPolicyIR::Ignore;
        plan.k_sampling = None;
        plan.count = 4;
        plan.target = fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz: 1.0e3,
            frequency_max_hz: 5.0e6,
        };

        let run = execute_cpu_fem_eigen(
            &plan,
            &[
                OutputIR::EigenSpectrum {
                    quantity: "frequency_hz".to_string(),
                },
                OutputIR::EigenMode {
                    field: "mode".to_string(),
                    indices: vec![0],
                },
            ],
        )
        .expect("eligible full 2x2 frequency window should use native modal production");

        let summary = run
            .auxiliary_artifacts
            .iter()
            .find(|artifact| artifact.relative_path == "eigen/metadata/eigen_summary.json")
            .expect("native modal path must publish eigen summary");
        let summary_json: serde_json::Value =
            serde_json::from_slice(&summary.bytes).expect("summary should be JSON");
        assert_eq!(
            summary_json
                .get("solver_backend")
                .and_then(|value| value.as_str()),
            Some("native_fem_modal_eigen")
        );
        assert_eq!(
            summary_json
                .get("solver_diagnostics")
                .and_then(|value| value.get("execution_lane"))
                .and_then(|value| value.as_str()),
            Some("production_cpu")
        );
        assert_eq!(
            summary_json
                .get("solver_diagnostics")
                .and_then(|value| value.get("solver_model"))
                .and_then(|value| value.as_str()),
            Some("slepc_multi_shift_invert_production_cpu_dense")
        );
        assert_eq!(
            summary_json
                .get("solver_kind")
                .and_then(|value| value.as_str()),
            Some("slepc_multi_shift_invert_production_cpu_dense")
        );
        assert!(
            summary_json
                .get("solver_capabilities")
                .and_then(|value| value.as_array())
                .is_some_and(|capabilities| capabilities
                    .iter()
                    .any(|value| value.as_str() == Some("shift_invert"))),
            "{}",
            summary_json
        );
        assert!(
            summary_json
                .get("solver_notes")
                .and_then(|value| value.as_str())
                .is_some_and(|notes| notes.contains("shift-invert")),
            "{}",
            summary_json
        );
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn cpu_full_2x2_nonzero_floquet_window_uses_native_bloch_payload_artifact_path() {
        let mut plan = minimal_native_modal_plan();
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.damping_policy = EigenDampingPolicyIR::Ignore;
        plan.count = 2;
        plan.target = fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz: 1.0e8,
            frequency_max_hz: 5.0e9,
        };
        plan.external_field = Some([39_789.0, 0.0, 0.0]);
        add_x_floquet_pair_to_plan(&mut plan);

        let run = execute_cpu_fem_eigen(
            &plan,
            &[
                OutputIR::EigenSpectrum {
                    quantity: "frequency_hz".to_string(),
                },
                OutputIR::EigenMode {
                    field: "mode".to_string(),
                    indices: vec![0],
                },
            ],
        )
        .expect(
            "eligible nonzero-k Floquet window should use native Bloch/Floquet modal production",
        );

        let summary = run
            .auxiliary_artifacts
            .iter()
            .find(|artifact| artifact.relative_path == "eigen/metadata/eigen_summary.json")
            .expect("native modal path must publish eigen summary");
        let summary_json: serde_json::Value =
            serde_json::from_slice(&summary.bytes).expect("summary should be JSON");
        assert_eq!(
            summary_json
                .get("solver_backend")
                .and_then(|value| value.as_str()),
            Some("native_fem_modal_eigen")
        );
        let diagnostics = summary_json
            .get("solver_diagnostics")
            .expect("native summary should carry solver diagnostics");
        assert_eq!(
            diagnostics
                .get("execution_lane")
                .and_then(|value| value.as_str()),
            Some("production_cpu")
        );
        assert_eq!(
            diagnostics
                .get("operator_diagnostics")
                .and_then(|value| value.get("payload_kind"))
                .and_then(|value| value.as_str()),
            Some("bloch_floquet_tangent_operator")
        );
        assert!(
            diagnostics
                .get("production_cpu_rejection_reason")
                .and_then(|value| value.as_str())
                .is_none(),
            "{}",
            diagnostics
        );
    }

    #[test]
    fn native_cpu_modal_window_accepts_floquet_gamma_with_pair_payload() {
        let mut plan = minimal_native_modal_plan();
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.damping_policy = EigenDampingPolicyIR::Ignore;
        plan.target = fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz: 1.0e8,
            frequency_max_hz: 5.0e9,
        };
        add_x_floquet_pair_to_plan(&mut plan);
        plan.k_sampling = Some(KSamplingIR::Single {
            k_vector: [0.0, 0.0, 0.0],
        });

        assert!(
            native_cpu_modal_window_enabled(&plan),
            "Floquet gamma samples with periodic pair metadata must use the same native Bloch/Floquet payload path as nonzero-k samples so production k-paths do not mix reference and production samples"
        );
        assert_eq!(native_cpu_modal_window_rejection_reason(&plan), None);
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn cpu_full_2x2_frequency_window_progress_and_provenance_report_shift_invert() {
        let mut plan = minimal_native_modal_plan();
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.damping_policy = EigenDampingPolicyIR::Ignore;
        plan.k_sampling = None;
        plan.count = 4;
        plan.target = fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz: 1.0e3,
            frequency_max_hz: 5.0e6,
        };

        let mut progress_events = Vec::<FemEigenProgress>::new();
        let mut progress = |event: FemEigenProgress| {
            progress_events.push(event);
            StepAction::Continue
        };
        let run = execute_cpu_fem_eigen_with_progress(
            &plan,
            &[OutputIR::EigenSpectrum {
                quantity: "frequency_hz".to_string(),
            }],
            &mut progress,
        )
        .expect("native full 2x2 frequency window should solve with shift-invert");

        assert!(
            progress_events
                .iter()
                .any(|event| event.phase == "solving_native_shift_invert"
                    && event.solver_kind == "slepc_multi_shift_invert_production_cpu_dense"),
            "{progress_events:?}"
        );
        assert!(
            progress_events
                .iter()
                .all(|event| event.solver_kind != "contour_interval_production_cpu_dense"),
            "{progress_events:?}"
        );
        assert_eq!(
            run.provenance.execution_engine,
            "native_fem_modal_eigen/slepc_multi_shift_invert_production_cpu_dense"
        );
    }
}
