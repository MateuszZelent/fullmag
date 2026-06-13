//! Artifact writing: metadata, scalars CSV, field snapshots.

use crate::artifact_pipeline::ArtifactPipelineSummary;
use fullmag_ir::BackendPlanIR;
use sha2::{Digest, Sha256};

use crate::types::{
    ExecutedRun, FemCpuRelaxationAlgorithmPolicyMetadata, FemCpuRelaxationDemagPolicyMetadata,
    FemCpuRelaxationDemagTimingsNs, FemCpuRelaxationEnergyTerms,
    FemCpuRelaxationQualificationMetadata, FemGpuRelaxationAlgorithmPolicyMetadata,
    FemGpuRelaxationDevicePolicyMetadata, FemGpuRelaxationQualificationMetadata, StepStats,
};

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::io::{Error, ErrorKind, Write};
use std::path::Path;

fn runtime_threading_summary(problem: &fullmag_ir::ProblemIR) -> serde_json::Value {
    let resolved_cpu_threads = u32::try_from(crate::configured_cpu_threads(problem)).ok();
    serde_json::json!({
        "requested_cpu_threads": crate::requested_cpu_threads(problem),
        "resolved_cpu_threads": resolved_cpu_threads,
        "requested_fem_omp_threads": serde_json::Value::Null,
        "effective_fem_omp_threads": serde_json::Value::Null,
    })
}

fn provenance_with_runtime_threading(
    problem: &fullmag_ir::ProblemIR,
    provenance: &crate::types::ExecutionProvenance,
    steps: &[StepStats],
) -> crate::types::ExecutionProvenance {
    let mut enriched = provenance.clone();
    enriched.requested_cpu_threads = crate::requested_cpu_threads(problem);
    enriched.resolved_cpu_threads = u32::try_from(crate::configured_cpu_threads(problem)).ok();
    // Populate FEM OMP thread provenance from the first step that has non-zero
    // thread info (reported by the native C++ backend via FFI).
    if enriched.requested_fem_omp_threads.is_none() {
        if let Some(first) = steps.first() {
            if first.requested_fem_omp_threads > 0 {
                enriched.requested_fem_omp_threads = Some(first.requested_fem_omp_threads as u32);
            }
            if first.effective_fem_omp_threads > 0 {
                enriched.effective_fem_omp_threads = Some(first.effective_fem_omp_threads as u32);
            }
        }
    }
    enriched
}

fn demag_runtime_metadata(
    plan: &fullmag_ir::ExecutionPlanIR,
    provenance: &crate::types::ExecutionProvenance,
    steps: &[StepStats],
) -> serde_json::Value {
    match &plan.backend_plan {
        BackendPlanIR::Fem(fem) => {
            if !fem.enable_demag {
                return serde_json::Value::Null;
            }

            let policy = fem.demag_solver_policy.clone().unwrap_or_default();
            let resolved_policy = provenance.fem_poisson_demag.as_ref();
            let resolved_demag = fem
                .demag_realization
                .unwrap_or(fullmag_ir::ResolvedFemDemagIR::PoissonRobin);
            let last = steps.last();
            let boundary_variant = match resolved_demag {
                fullmag_ir::ResolvedFemDemagIR::PoissonDirichlet => Some("dirichlet"),
                fullmag_ir::ResolvedFemDemagIR::PoissonRobin => Some("robin"),
                _ => None,
            };
            let timings_ns = last.map(|entry| {
                serde_json::json!({
                    "assemble": entry.demag_assemble_wall_time_ns,
                    "solve": entry.demag_solve_wall_time_ns,
                    "solver_setup": entry.demag_solver_setup_wall_time_ns,
                    "solver_apply": entry.demag_solver_apply_wall_time_ns,
                    "recover": entry.demag_recover_wall_time_ns,
                    "energy": entry.demag_energy_wall_time_ns,
                    "total": entry.demag_wall_time_ns,
                })
            });
            let linear_solver =
                resolved_policy.map_or(policy.solver, |entry| entry.linear_solver.clone());
            let preconditioner =
                resolved_policy.map_or(policy.preconditioner, |entry| entry.preconditioner.clone());
            let relative_tolerance = resolved_policy.map_or(policy.rtol, |entry| entry.rtol);
            let max_iterations =
                resolved_policy.map_or(policy.max_iterations, |entry| entry.max_iterations);

            serde_json::json!({
                "model": resolved_demag.model_name(),
                "boundary_variant": boundary_variant,
                "linear_solver": linear_solver,
                "preconditioner": preconditioner,
                "relative_tolerance": relative_tolerance,
                "absolute_tolerance": policy.atol,
                "max_iterations": max_iterations,
                "print_level": policy.print_level,
                "actual_iterations": last.map(|entry| entry.poisson_iterations),
                "final_residual_norm": last.map(|entry| entry.poisson_final_residual),
                "solver_setup_reused": last.map(|entry| entry.demag_solver_setup_reused),
                "timings_ns": timings_ns,
                "mfem_device": provenance.mfem_device,
                "fem_assembly_mode": provenance.fem_assembly_mode,
                "requested_fem_omp_threads": provenance.requested_fem_omp_threads,
                "effective_fem_omp_threads": provenance.effective_fem_omp_threads,
                "airbox_factor": fem.air_box_config.as_ref().map(|cfg| cfg.factor),
                "robin_beta_mode": fem
                    .air_box_config
                    .as_ref()
                    .and_then(|cfg| cfg.robin_beta_mode.clone()),
                "robin_beta_factor": fem
                    .air_box_config
                    .as_ref()
                    .and_then(|cfg| cfg.robin_beta_factor),
            })
        }
        _ => serde_json::Value::Null,
    }
}

fn fem_cpu_relaxation_qualification_metadata(
    plan: &fullmag_ir::ExecutionPlanIR,
    provenance: &crate::types::ExecutionProvenance,
    demag_runtime: &serde_json::Value,
    executed: &ExecutedRun,
) -> serde_json::Value {
    let BackendPlanIR::Fem(fem) = &plan.backend_plan else {
        return serde_json::Value::Null;
    };
    if provenance.execution_engine != "fem_cpu_native" {
        return serde_json::Value::Null;
    }

    let Some(last) = executed.result.steps.last() else {
        return serde_json::Value::Null;
    };
    let completion = executed.result.completion.as_ref();

    let metadata = FemCpuRelaxationQualificationMetadata {
        schema_version: "fem_cpu_relaxation_qualification.v1".to_string(),
        benchmark_gate_version: "fem_cpu_no_pbc_adaptive.v1".to_string(),
        physics_terms: fem_physics_terms(fem),
        solver_mesh_signature: solver_mesh_signature(&fem.mesh),
        demag_policy: FemCpuRelaxationDemagPolicyMetadata {
            model: json_string(demag_runtime, "model"),
            boundary_variant: json_string(demag_runtime, "boundary_variant"),
            linear_solver: json_string(demag_runtime, "linear_solver"),
            preconditioner: json_string(demag_runtime, "preconditioner"),
            relative_tolerance: json_f64(demag_runtime, "relative_tolerance"),
            absolute_tolerance: json_f64(demag_runtime, "absolute_tolerance"),
            max_iterations: json_u32(demag_runtime, "max_iterations"),
            print_level: json_i32(demag_runtime, "print_level"),
            actual_iterations: json_u32(demag_runtime, "actual_iterations"),
            final_residual_norm: json_f64(demag_runtime, "final_residual_norm"),
            solver_setup_reused: json_bool(demag_runtime, "solver_setup_reused"),
            timings_ns: demag_timings_ns(demag_runtime),
        },
        algorithm_policy: fem_cpu_relaxation_algorithm_policy_metadata(fem, provenance),
        assembly_mode: provenance.fem_assembly_mode.clone(),
        relaxation_algorithm: fem
            .relaxation
            .as_ref()
            .map(|control| control.algorithm.as_str().to_string()),
        stop_reason: completion
            .and_then(|entry| entry.reason.as_ref())
            .map(stage_stop_reason_as_str)
            .map(str::to_string),
        stop_metric_name: completion.and_then(|entry| entry.metric_name.clone()),
        stop_metric_value: completion.and_then(|entry| entry.metric_value),
        stop_threshold: completion.and_then(|entry| entry.threshold),
        final_energy_terms_j: FemCpuRelaxationEnergyTerms {
            e_ex: last.e_ex,
            e_demag: last.e_demag,
            e_ext: last.e_ext,
            e_ani: last.e_ani,
            e_dmi: last.e_dmi,
            e_total: last.e_total,
        },
        final_torque_apm: last.max_torque_Apm,
        final_torque_t: last.max_torque_T,
        norm_defect: magnetization_norm_defect_for_fem_plan(
            fem,
            &executed.result.final_magnetization,
        ),
        executed_steps: last.step,
    };
    serde_json::to_value(metadata).unwrap_or(serde_json::Value::Null)
}

fn fem_cpu_relaxation_algorithm_policy_metadata(
    fem: &fullmag_ir::FemPlanIR,
    provenance: &crate::types::ExecutionProvenance,
) -> Option<FemCpuRelaxationAlgorithmPolicyMetadata> {
    let control = fem.relaxation.as_ref()?;
    let gpu_status = provenance
        .fem_gpu_qualification_status
        .clone()
        .or_else(|| Some(default_fem_relaxation_gpu_status(control.algorithm).to_string()));
    match control.algorithm {
        fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb => {
            Some(FemCpuRelaxationAlgorithmPolicyMetadata {
                realization: provenance.energy_minimizer_realization.clone(),
                time_integrator: None,
                precession_policy: None,
                rhs_policy: None,
                metric: Some("fem_lumped_mass_inner_product".to_string()),
                line_search: Some("native_armijo_backtracking_bb1_bb2".to_string()),
                preconditioner: Some("exchange_plus_mass_tangent_gradient".to_string()),
                linear_solver_policy: Some(
                    "serial MFEM CG production default; HyprePCG/BoomerAMG explicit opt-in"
                        .to_string(),
                ),
                tangent_operator: None,
                direction_update: None,
                step_update: Some("alternating_bb1_bb2".to_string()),
                gpu_status,
            })
        }
        fullmag_ir::RelaxationAlgorithmIR::NonlinearCg => {
            Some(FemCpuRelaxationAlgorithmPolicyMetadata {
                realization: provenance.energy_minimizer_realization.clone(),
                time_integrator: None,
                precession_policy: None,
                rhs_policy: None,
                metric: Some("fem_lumped_mass_inner_product".to_string()),
                line_search: Some("native_armijo_backtracking_pr_plus_restart".to_string()),
                preconditioner: Some("exchange_plus_mass_tangent_gradient".to_string()),
                linear_solver_policy: Some(
                    "serial MFEM CG production default; HyprePCG/BoomerAMG explicit opt-in"
                        .to_string(),
                ),
                tangent_operator: None,
                direction_update: Some("polak_ribiere_plus_projected_restart".to_string()),
                step_update: None,
                gpu_status,
            })
        }
        fullmag_ir::RelaxationAlgorithmIR::TangentPlaneImplicit => {
            Some(FemCpuRelaxationAlgorithmPolicyMetadata {
                realization: provenance.energy_minimizer_realization.clone(),
                time_integrator: None,
                precession_policy: None,
                rhs_policy: None,
                metric: Some("fem_lumped_mass_inner_product".to_string()),
                line_search: Some("native_armijo_backtracking".to_string()),
                preconditioner: Some(
                    "native_tangent_plane_linear_solve_preconditioner".to_string(),
                ),
                linear_solver_policy: Some(
                    "MFEM/Hypre Krylov solver with non-SPD fallback for indefinite terms"
                        .to_string(),
                ),
                tangent_operator: Some(
                    "mass_exchange_local_anisotropy_zeeman_dmi_demag_linear_response".to_string(),
                ),
                direction_update: None,
                step_update: None,
                gpu_status,
            })
        }
        fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped => {
            Some(FemCpuRelaxationAlgorithmPolicyMetadata {
                realization: provenance.energy_minimizer_realization.clone().or_else(|| {
                    Some(crate::relaxation::NATIVE_LLG_TIME_INTEGRATOR_REALIZATION.to_string())
                }),
                time_integrator: provenance.resolved_integrator.clone(),
                precession_policy: Some("disabled_pure_damping".to_string()),
                rhs_policy: Some("llg_overdamped_rhs".to_string()),
                metric: None,
                line_search: None,
                preconditioner: None,
                linear_solver_policy: None,
                tangent_operator: None,
                direction_update: None,
                step_update: None,
                gpu_status,
            })
        }
    }
}

fn default_fem_relaxation_gpu_status(algorithm: fullmag_ir::RelaxationAlgorithmIR) -> &'static str {
    match algorithm {
        fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped
        | fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb
        | fullmag_ir::RelaxationAlgorithmIR::NonlinearCg => "production_executable",
        fullmag_ir::RelaxationAlgorithmIR::TangentPlaneImplicit => "unsupported",
    }
}

fn fem_gpu_relaxation_qualification_metadata(
    plan: &fullmag_ir::ExecutionPlanIR,
    provenance: &crate::types::ExecutionProvenance,
    executed: &ExecutedRun,
) -> serde_json::Value {
    let BackendPlanIR::Fem(fem) = &plan.backend_plan else {
        return serde_json::Value::Null;
    };
    if provenance.execution_engine != "fem_native_gpu" {
        return serde_json::Value::Null;
    }
    let Some(control) = fem.relaxation.as_ref() else {
        return serde_json::Value::Null;
    };
    let (
        realization,
        time_integrator,
        precession_policy,
        rhs_policy,
        metric,
        gradient_policy,
        line_search,
        direction_update,
        step_update,
    ) = match control.algorithm {
        fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped => (
            provenance.energy_minimizer_realization.clone().or_else(|| {
                Some(crate::relaxation::NATIVE_LLG_TIME_INTEGRATOR_REALIZATION.to_string())
            }),
            provenance.resolved_integrator.clone(),
            Some("disabled_pure_damping".to_string()),
            Some("llg_overdamped_rhs".to_string()),
            None,
            None,
            None,
            None,
            None,
        ),
        fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb => (
            provenance.energy_minimizer_realization.clone(),
            None,
            None,
            None,
            Some("fem_lumped_mass_inner_product".to_string()),
            Some("device_tangent_gradient".to_string()),
            Some("native_armijo_backtracking_bb1_bb2".to_string()),
            None,
            Some("alternating_bb1_bb2".to_string()),
        ),
        fullmag_ir::RelaxationAlgorithmIR::NonlinearCg => (
            provenance.energy_minimizer_realization.clone(),
            None,
            None,
            None,
            Some("fem_lumped_mass_inner_product".to_string()),
            Some("device_tangent_gradient".to_string()),
            Some("native_armijo_backtracking_pr_plus_restart".to_string()),
            Some("polak_ribiere_plus_projected_restart".to_string()),
            None,
        ),
        _ => return serde_json::Value::Null,
    };
    let Some(last) = executed.result.steps.last() else {
        return serde_json::Value::Null;
    };

    let metadata = FemGpuRelaxationQualificationMetadata {
        schema_version: "fem_gpu_relaxation_qualification.v1".to_string(),
        relaxation_algorithm: Some(control.algorithm.as_str().to_string()),
        algorithm_policy: FemGpuRelaxationAlgorithmPolicyMetadata {
            realization,
            time_integrator,
            precession_policy,
            rhs_policy,
            metric,
            gradient_policy,
            line_search,
            direction_update,
            step_update,
        },
        device_policy: FemGpuRelaxationDevicePolicyMetadata {
            execution_mode: provenance.fem_execution_mode.clone(),
            qualification_status: provenance.fem_gpu_qualification_status.clone(),
            data_residency: provenance.fem_data_residency.clone(),
            exchange_operator_mode: provenance.fem_exchange_operator_mode.clone(),
            demag_operator_mode: provenance.fem_demag_operator_mode.clone(),
            uses_cuda_kernels: provenance.uses_cuda_kernels,
            uses_gpu_poisson: provenance.uses_gpu_poisson,
            hot_loop_exchange_host_sync_count: provenance.hot_loop_exchange_host_sync_count,
            hot_loop_compute_host_sync_count: provenance.hot_loop_compute_host_sync_count,
            hot_loop_control_scalar_host_sync_count: provenance
                .hot_loop_control_scalar_host_sync_count,
        },
        norm_defect: magnetization_norm_defect_for_fem_plan(
            fem,
            &executed.result.final_magnetization,
        ),
        executed_steps: last.step,
    };
    serde_json::to_value(metadata).unwrap_or(serde_json::Value::Null)
}

fn json_string(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
}

fn json_f64(value: &serde_json::Value, key: &str) -> Option<f64> {
    value.get(key).and_then(serde_json::Value::as_f64)
}

fn json_u32(value: &serde_json::Value, key: &str) -> Option<u32> {
    value
        .get(key)
        .and_then(serde_json::Value::as_u64)
        .and_then(|raw| u32::try_from(raw).ok())
}

fn json_i32(value: &serde_json::Value, key: &str) -> Option<i32> {
    value
        .get(key)
        .and_then(serde_json::Value::as_i64)
        .and_then(|raw| i32::try_from(raw).ok())
}

fn json_bool(value: &serde_json::Value, key: &str) -> Option<bool> {
    value.get(key).and_then(serde_json::Value::as_bool)
}

fn demag_timings_ns(value: &serde_json::Value) -> Option<FemCpuRelaxationDemagTimingsNs> {
    let timings = value.get("timings_ns")?;
    Some(FemCpuRelaxationDemagTimingsNs {
        assemble: timings.get("assemble")?.as_u64()?,
        solve: timings.get("solve")?.as_u64()?,
        solver_setup: timings.get("solver_setup")?.as_u64()?,
        solver_apply: timings.get("solver_apply")?.as_u64()?,
        recover: timings.get("recover")?.as_u64()?,
        energy: timings.get("energy")?.as_u64()?,
        total: timings.get("total")?.as_u64()?,
    })
}

fn stage_stop_reason_as_str(reason: &fullmag_ir::StageStopReason) -> &'static str {
    match reason {
        fullmag_ir::StageStopReason::Torque => "torque",
        fullmag_ir::StageStopReason::Energy => "energy",
        fullmag_ir::StageStopReason::MaxSteps => "max_steps",
        fullmag_ir::StageStopReason::MaxPseudotime => "max_pseudotime",
        fullmag_ir::StageStopReason::MaxPhysicalTime => "max_physical_time",
        fullmag_ir::StageStopReason::UserCancelled => "user_cancelled",
        fullmag_ir::StageStopReason::BackendError => "backend_error",
        fullmag_ir::StageStopReason::Gradient => "gradient",
    }
}

fn fem_physics_terms(fem: &fullmag_ir::FemPlanIR) -> Vec<String> {
    let mut terms = Vec::new();
    if fem.enable_exchange {
        terms.push("exchange".to_string());
    }
    if fem.enable_demag {
        terms.push("demag".to_string());
    }
    if fem.material.uniaxial_anisotropy.is_some() {
        terms.push("anisotropy_uniaxial".to_string());
    }
    if fem.material.cubic_anisotropy_kc1.is_some()
        || fem.material.cubic_anisotropy_kc2.is_some()
        || fem.material.cubic_anisotropy_kc3.is_some()
    {
        terms.push("anisotropy_cubic".to_string());
    }
    terms
}

fn solver_mesh_signature(mesh: &fullmag_ir::MeshIR) -> String {
    let payload = serde_json::json!({
        "nodes": mesh.nodes,
        "elements": mesh.elements,
        "element_markers": mesh.element_markers,
        "boundary_faces": mesh.boundary_faces,
        "boundary_markers": mesh.boundary_markers,
        "periodic_boundary_pairs": mesh.periodic_boundary_pairs,
        "periodic_node_pairs": mesh.periodic_node_pairs,
    });
    let encoded = serde_json::to_vec(&payload).unwrap_or_default();
    let digest = Sha256::digest(encoded);
    digest.iter().map(|byte| format!("{:02x}", byte)).collect()
}

fn magnetization_norm_defect_for_fem_plan(fem: &fullmag_ir::FemPlanIR, values: &[[f64; 3]]) -> f64 {
    let magnetic_nodes = fem
        .mesh_parts
        .iter()
        .filter(|part| part.role == fullmag_ir::FemMeshPartRole::MagneticObject)
        .flat_map(|part| fem_part_magnetic_node_indices_for_norm_defect(fem, part))
        .collect::<BTreeSet<_>>();
    if magnetic_nodes.is_empty() {
        return magnetization_norm_defect(values.iter());
    }
    magnetization_norm_defect(
        magnetic_nodes
            .into_iter()
            .filter_map(|index| values.get(index)),
    )
}

fn fem_part_magnetic_node_indices_for_norm_defect(
    fem: &fullmag_ir::FemPlanIR,
    part: &fullmag_ir::FemMeshPartIR,
) -> Vec<usize> {
    let mut nodes = BTreeSet::new();
    nodes.extend(part.node_indices.iter().map(|index| *index as usize));

    if nodes.is_empty() {
        if let fullmag_ir::FemMeshPartSelector::NodeRange { start, count } = &part.node_selector {
            let start = *start as usize;
            let end = start
                .saturating_add(*count as usize)
                .min(fem.mesh.nodes.len());
            nodes.extend(start..end);
        }
    }

    nodes
        .into_iter()
        .filter(|index| *index < fem.mesh.nodes.len())
        .collect()
}

fn magnetization_norm_defect<'a>(values: impl Iterator<Item = &'a [f64; 3]>) -> f64 {
    values
        .map(|m| {
            let norm = (m[0] * m[0] + m[1] * m[1] + m[2] * m[2]).sqrt();
            (norm - 1.0).abs()
        })
        .fold(0.0, f64::max)
}

#[derive(Debug, Clone)]
pub(crate) struct FieldArtifactContext {
    pub problem_name: String,
    pub ir_version: String,
    pub source_hash: Option<String>,
    pub execution_mode: fullmag_ir::ExecutionMode,
    pub layout: serde_json::Value,
}

pub(crate) fn build_field_context(
    problem: &fullmag_ir::ProblemIR,
    plan: &fullmag_ir::ExecutionPlanIR,
) -> FieldArtifactContext {
    FieldArtifactContext {
        problem_name: problem.problem_meta.name.clone(),
        ir_version: problem.ir_version.clone(),
        source_hash: problem.problem_meta.source_hash.clone(),
        execution_mode: plan.common.execution_mode,
        layout: field_layout(plan),
    }
}

pub(crate) fn write_artifacts(
    output_dir: &Path,
    problem: &fullmag_ir::ProblemIR,
    plan: &fullmag_ir::ExecutionPlanIR,
    executed: &ExecutedRun,
    streamed: Option<&ArtifactPipelineSummary>,
) -> std::io::Result<()> {
    fs::create_dir_all(output_dir)?;
    let field_context = build_field_context(problem, plan);
    let runtime_threading = runtime_threading_summary(problem);
    let execution_provenance =
        provenance_with_runtime_threading(problem, &executed.provenance, &executed.result.steps);
    let demag_runtime = demag_runtime_metadata(plan, &execution_provenance, &executed.result.steps);
    let fem_cpu_relaxation_qualification = fem_cpu_relaxation_qualification_metadata(
        plan,
        &execution_provenance,
        &demag_runtime,
        executed,
    );
    let fem_gpu_relaxation_qualification =
        fem_gpu_relaxation_qualification_metadata(plan, &execution_provenance, executed);
    let material_field_assets = write_material_field_artifacts(output_dir, plan)?;

    let metadata = serde_json::json!({
        "problem_name": problem.problem_meta.name,
        "ir_version": problem.ir_version,
        "source_hash": problem.problem_meta.source_hash,
        "problem_meta": problem.problem_meta,
        "execution_plan": plan,
        "artifact_layout": field_context.layout.clone(),
        "execution_provenance": execution_provenance,
        "runtime_threading": runtime_threading,
        "demag_runtime": demag_runtime,
        "fem_cpu_relaxation_qualification": fem_cpu_relaxation_qualification,
        "fem_gpu_relaxation_qualification": fem_gpu_relaxation_qualification,
        "engine_version": env!("CARGO_PKG_VERSION"),
        "status": executed.result.status,
        "scalar_rows": executed.result.steps.len(),
        "field_snapshots": executed.field_snapshot_count,
        "material_field_assets": material_field_assets,
    });
    let metadata_path = output_dir.join("metadata.json");
    let mut metadata_file = fs::File::create(&metadata_path)?;
    metadata_file.write_all(serde_json::to_string_pretty(&metadata).unwrap().as_bytes())?;

    if streamed.is_none_or(|summary| summary.scalar_rows_written == 0) {
        write_scalars_csv(&output_dir.join("scalars.csv"), &executed.result.steps)?;
    }
    write_table_autosave_artifacts(output_dir, problem, &executed.result.steps)?;

    write_field_file(
        &output_dir.join("m_initial.json"),
        &field_context,
        &execution_provenance,
        "m",
        0,
        0.0,
        0.0,
        &executed.initial_magnetization,
    )?;

    let final_stats = executed.result.steps.last().cloned().unwrap_or(StepStats {
        step: 0,
        time: 0.0,
        dt: 0.0,
        e_ex: 0.0,
        e_demag: 0.0,
        e_ext: 0.0,
        e_ani: 0.0,
        e_total: 0.0,
        max_dm_dt: 0.0,
        max_h_eff: 0.0,
        max_h_demag: 0.0,
        wall_time_ns: 0,
        ..StepStats::default()
    });
    write_field_file(
        &output_dir.join("m_final.json"),
        &field_context,
        &execution_provenance,
        "m",
        final_stats.step,
        final_stats.time,
        final_stats.dt,
        &executed.result.final_magnetization,
    )?;

    if streamed.is_none() {
        let fields_dir = output_dir.join("fields");
        for snapshot in &executed.field_snapshots {
            write_field_snapshot_artifact(
                &fields_dir,
                &field_context,
                &execution_provenance,
                snapshot,
            )?;
        }
    }

    for artifact in &executed.auxiliary_artifacts {
        let artifact_path = output_dir.join(&artifact.relative_path);
        if let Some(parent) = artifact_path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(artifact_path, &artifact.bytes)?;
    }

    write_periodic_pairs_artifact(output_dir, plan)?;

    write_prescribed_current_transport_artifacts(
        output_dir,
        problem,
        plan,
        &field_context,
        &execution_provenance,
    )?;

    Ok(())
}

fn write_material_field_artifacts(
    output_dir: &Path,
    plan: &fullmag_ir::ExecutionPlanIR,
) -> std::io::Result<Vec<fullmag_ir::MaterialFieldAssetIR>> {
    let BackendPlanIR::Fem(fem) = &plan.backend_plan else {
        return Ok(Vec::new());
    };

    let mut metadata_assets = Vec::new();
    for field_plan in &plan.common.material_field_plans {
        let Some((values, location)) = fem_material_field_values(fem, field_plan) else {
            continue;
        };
        if values.is_empty() {
            continue;
        }

        let stats = material_field_statistics(values);
        let asset_id = material_field_asset_id(
            &field_plan.object_id,
            field_plan.parameter,
            field_plan.realization_location,
        );
        let artifact_path = format!("material-fields/{asset_id}.json");
        let asset = fullmag_ir::MaterialFieldAssetIR {
            asset_id: asset_id.clone(),
            artifact_path: Some(artifact_path.clone()),
            parameter: field_plan.parameter,
            owner_object_id: field_plan.object_id.clone(),
            source_region_id: None,
            mesh_id: fem.mesh_name.clone(),
            mesh_generation_id: solver_mesh_signature(&fem.mesh),
            location,
            component_count: 1,
            unit: material_field_unit(field_plan.parameter).to_string(),
            values: values.to_vec(),
            min: stats.min,
            max: stats.max,
            mean: stats.mean,
            provenance: fullmag_ir::MaterialFieldProvenanceIR {
                source_kind: field_plan.source_kind,
                algorithm: field_plan
                    .realization_method
                    .clone()
                    .unwrap_or_else(|| "runtime_material_field_artifact".to_string()),
                timing_ms: 0.0,
            },
        };

        let full_path = output_dir.join(&artifact_path);
        if let Some(parent) = full_path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&full_path, serde_json::to_string_pretty(&asset).unwrap())?;

        let mut metadata_asset = asset;
        metadata_asset.values.clear();
        metadata_assets.push(metadata_asset);
    }

    Ok(metadata_assets)
}

fn fem_material_field_values<'a>(
    fem: &'a fullmag_ir::FemPlanIR,
    field_plan: &fullmag_ir::MaterialFieldPlan,
) -> Option<(&'a [f64], fullmag_ir::MaterialFieldLocationIR)> {
    use fullmag_ir::MaterialFieldLocationIR::{Element, Node};
    use fullmag_ir::MaterialParameterNameIR::{Aex, Alpha, Ms};

    match (field_plan.parameter, field_plan.realization_location) {
        (Ms, Node) => fem
            .material
            .ms_field
            .as_deref()
            .map(|values| (values, Node)),
        (Aex, Node) => fem.material.a_field.as_deref().map(|values| (values, Node)),
        (Alpha, Node) => fem
            .material
            .alpha_field
            .as_deref()
            .map(|values| (values, Node)),
        (Ms, Element) => fem
            .ms_element_field
            .as_deref()
            .map(|values| (values, Element)),
        (Aex, Element) => fem
            .a_element_field
            .as_deref()
            .map(|values| (values, Element)),
        _ => None,
    }
}

fn material_field_statistics(values: &[f64]) -> fullmag_ir::MaterialFieldStatisticsIR {
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    let mut sum = 0.0;
    for value in values {
        min = min.min(*value);
        max = max.max(*value);
        sum += *value;
    }
    fullmag_ir::MaterialFieldStatisticsIR {
        sample_count: values.len(),
        min,
        max,
        mean: sum / values.len() as f64,
    }
}

fn material_field_asset_id(
    object_id: &str,
    parameter: fullmag_ir::MaterialParameterNameIR,
    location: fullmag_ir::MaterialFieldLocationIR,
) -> String {
    format!(
        "{}_{}_{}",
        sanitize_material_field_asset_component(object_id),
        material_field_parameter_id(parameter),
        material_field_location_id(location),
    )
}

fn sanitize_material_field_asset_component(value: &str) -> String {
    let mut sanitized = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect::<String>();
    while sanitized.contains("__") {
        sanitized = sanitized.replace("__", "_");
    }
    sanitized.trim_matches('_').to_string()
}

fn material_field_parameter_id(parameter: fullmag_ir::MaterialParameterNameIR) -> &'static str {
    match parameter {
        fullmag_ir::MaterialParameterNameIR::Ms => "ms",
        fullmag_ir::MaterialParameterNameIR::Aex => "aex",
        fullmag_ir::MaterialParameterNameIR::Alpha => "alpha",
        fullmag_ir::MaterialParameterNameIR::Ku1 => "ku1",
        fullmag_ir::MaterialParameterNameIR::Ku2 => "ku2",
        fullmag_ir::MaterialParameterNameIR::AnisotropyAxis => "anisotropy_axis",
        fullmag_ir::MaterialParameterNameIR::Kc1 => "kc1",
        fullmag_ir::MaterialParameterNameIR::Kc2 => "kc2",
        fullmag_ir::MaterialParameterNameIR::Kc3 => "kc3",
        fullmag_ir::MaterialParameterNameIR::Dind => "dind",
        fullmag_ir::MaterialParameterNameIR::Dbulk => "dbulk",
    }
}

fn material_field_location_id(location: fullmag_ir::MaterialFieldLocationIR) -> &'static str {
    match location {
        fullmag_ir::MaterialFieldLocationIR::Cell => "cell",
        fullmag_ir::MaterialFieldLocationIR::Node => "node",
        fullmag_ir::MaterialFieldLocationIR::Element => "element",
        fullmag_ir::MaterialFieldLocationIR::Quadrature => "quadrature",
    }
}

fn material_field_unit(parameter: fullmag_ir::MaterialParameterNameIR) -> &'static str {
    match parameter {
        fullmag_ir::MaterialParameterNameIR::Ms => "A/m",
        fullmag_ir::MaterialParameterNameIR::Aex => "J/m",
        fullmag_ir::MaterialParameterNameIR::Alpha => "1",
        fullmag_ir::MaterialParameterNameIR::Ku1
        | fullmag_ir::MaterialParameterNameIR::Ku2
        | fullmag_ir::MaterialParameterNameIR::Kc1
        | fullmag_ir::MaterialParameterNameIR::Kc2
        | fullmag_ir::MaterialParameterNameIR::Kc3 => "J/m^3",
        fullmag_ir::MaterialParameterNameIR::AnisotropyAxis => "1",
        fullmag_ir::MaterialParameterNameIR::Dind | fullmag_ir::MaterialParameterNameIR::Dbulk => {
            "J/m^2"
        }
    }
}

fn write_periodic_pairs_artifact(
    output_dir: &Path,
    plan: &fullmag_ir::ExecutionPlanIR,
) -> std::io::Result<()> {
    let Some(mesh) = periodic_mesh(plan) else {
        return Ok(());
    };
    if mesh.periodic_boundary_pairs.is_empty() {
        return Ok(());
    }

    let boundary_nodes_by_marker = mesh_boundary_nodes_by_marker(mesh);
    let node_pairs_by_id = mesh.periodic_node_pairs.iter().fold(
        HashMap::<String, Vec<&fullmag_ir::MeshPeriodicNodePairIR>>::new(),
        |mut acc, pair| {
            acc.entry(pair.pair_id.clone()).or_default().push(pair);
            acc
        },
    );
    let pairs = mesh
        .periodic_boundary_pairs
        .iter()
        .map(|boundary_pair| {
            let node_pairs = node_pairs_by_id
                .get(&boundary_pair.pair_id)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let source_nodes = boundary_nodes_by_marker
                .get(&boundary_pair.marker_a)
                .cloned()
                .unwrap_or_default();
            let destination_nodes = boundary_nodes_by_marker
                .get(&boundary_pair.marker_b)
                .cloned()
                .unwrap_or_default();
            let paired_source_nodes = node_pairs
                .iter()
                .map(|pair| pair.node_a)
                .collect::<BTreeSet<_>>();
            let paired_destination_nodes = node_pairs
                .iter()
                .map(|pair| pair.node_b)
                .collect::<BTreeSet<_>>();
            let diagnostics = mesh_periodic_pair_residuals(mesh, boundary_pair, node_pairs);

            serde_json::json!({
                "pair_id": boundary_pair.pair_id.clone(),
                "source_marker": boundary_pair.source_marker.clone(),
                "destination_marker": boundary_pair.destination_marker.clone(),
                "marker_a": boundary_pair.marker_a,
                "marker_b": boundary_pair.marker_b,
                "expected_translation_m": boundary_pair.translation,
                "paired_node_count": node_pairs.len(),
                "unpaired_source_node_count": source_nodes.difference(&paired_source_nodes).count(),
                "unpaired_destination_node_count": destination_nodes.difference(&paired_destination_nodes).count(),
                "max_residual_m": diagnostics.max_residual_m,
                "rms_residual_m": diagnostics.rms_residual_m,
                "status": diagnostics.status,
            })
        })
        .collect::<Vec<_>>();

    let payload = serde_json::json!({
        "schema_version": "periodic_pairs.v1",
        "pairs": pairs,
    });
    let artifact_path = output_dir.join("mesh").join("periodic_pairs.v1.json");
    if let Some(parent) = artifact_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(
        artifact_path,
        serde_json::to_string_pretty(&payload).unwrap(),
    )?;

    Ok(())
}

fn periodic_mesh(plan: &fullmag_ir::ExecutionPlanIR) -> Option<&fullmag_ir::MeshIR> {
    match &plan.backend_plan {
        BackendPlanIR::Fem(fem) => Some(&fem.mesh),
        BackendPlanIR::FemEigen(fem) => Some(&fem.mesh),
        BackendPlanIR::FemFrequencyResponse(fem) => Some(&fem.mesh),
        BackendPlanIR::Fdm(_) | BackendPlanIR::FdmMultilayer(_) => None,
    }
}

#[derive(Debug, Clone)]
struct MeshPeriodicResidualDiagnostics {
    max_residual_m: Option<f64>,
    rms_residual_m: Option<f64>,
    status: String,
}

fn mesh_periodic_pair_residuals(
    mesh: &fullmag_ir::MeshIR,
    boundary_pair: &fullmag_ir::MeshPeriodicBoundaryPairIR,
    node_pairs: &[&fullmag_ir::MeshPeriodicNodePairIR],
) -> MeshPeriodicResidualDiagnostics {
    if node_pairs.is_empty() {
        return MeshPeriodicResidualDiagnostics {
            max_residual_m: None,
            rms_residual_m: None,
            status: "empty".to_string(),
        };
    }
    let Some(translation) = boundary_pair.translation else {
        return MeshPeriodicResidualDiagnostics {
            max_residual_m: None,
            rms_residual_m: None,
            status: "missing_translation".to_string(),
        };
    };

    let mut max_residual = 0.0f64;
    let mut sum_sq = 0.0f64;
    let mut valid_count = 0usize;
    for pair in node_pairs {
        let Some(src) = mesh.nodes.get(pair.node_a as usize) else {
            return MeshPeriodicResidualDiagnostics {
                max_residual_m: None,
                rms_residual_m: None,
                status: "invalid_node_reference".to_string(),
            };
        };
        let Some(dst) = mesh.nodes.get(pair.node_b as usize) else {
            return MeshPeriodicResidualDiagnostics {
                max_residual_m: None,
                rms_residual_m: None,
                status: "invalid_node_reference".to_string(),
            };
        };
        let residual = [
            dst[0] - src[0] - translation[0],
            dst[1] - src[1] - translation[1],
            dst[2] - src[2] - translation[2],
        ];
        let norm =
            (residual[0] * residual[0] + residual[1] * residual[1] + residual[2] * residual[2])
                .sqrt();
        max_residual = max_residual.max(norm);
        sum_sq += norm * norm;
        valid_count += 1;
    }
    let rms = (sum_sq / valid_count as f64).sqrt();
    let tolerance = boundary_pair.tolerance.unwrap_or(1e-9).max(0.0);
    let status = if max_residual > tolerance {
        "residual_exceeds_tolerance"
    } else {
        "valid"
    };

    MeshPeriodicResidualDiagnostics {
        max_residual_m: Some(max_residual),
        rms_residual_m: Some(rms),
        status: status.to_string(),
    }
}

fn mesh_boundary_nodes_by_marker(mesh: &fullmag_ir::MeshIR) -> HashMap<u32, BTreeSet<u32>> {
    let mut nodes_by_marker = HashMap::<u32, BTreeSet<u32>>::new();
    for (face_index, face) in mesh.boundary_faces.iter().enumerate() {
        let Some(marker) = mesh.boundary_markers.get(face_index).copied() else {
            continue;
        };
        let nodes = nodes_by_marker.entry(marker).or_default();
        nodes.extend(face.iter().copied());
    }
    nodes_by_marker
}

fn artifacts_object_ids_match(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let clean_a = a.strip_suffix("_geom").unwrap_or(a);
    let clean_b = b.strip_suffix("_geom").unwrap_or(b);
    clean_a == clean_b
}

fn fem_mesh_part_matches_segment(
    part: &fullmag_ir::FemMeshPartIR,
    segment: &fullmag_ir::FemObjectSegmentIR,
) -> bool {
    part.role == fullmag_ir::FemMeshPartRole::MagneticObject
        && (part
            .object_id
            .as_deref()
            .is_some_and(|id| artifacts_object_ids_match(id, &segment.object_id))
            || part
                .geometry_id
                .as_deref()
                .zip(segment.geometry_id.as_deref())
                .is_some_and(|(part_geometry, segment_geometry)| {
                    artifacts_object_ids_match(part_geometry, segment_geometry)
                })
            || artifacts_object_ids_match(&part.id, &segment.object_id))
}

fn fem_part_node_indices_for_artifact(
    fem: &fullmag_ir::FemPlanIR,
    part: &fullmag_ir::FemMeshPartIR,
) -> Vec<usize> {
    let mut nodes = BTreeSet::new();
    nodes.extend(part.node_indices.iter().map(|index| *index as usize));

    match &part.node_selector {
        fullmag_ir::FemMeshPartSelector::NodeRange { start, count }
            if part.node_indices.is_empty() =>
        {
            let start = *start as usize;
            let end = start
                .saturating_add(*count as usize)
                .min(fem.mesh.nodes.len());
            nodes.extend(start..end);
        }
        _ => {}
    }

    match &part.element_selector {
        fullmag_ir::FemMeshPartSelector::ElementRange { start, count } => {
            let start = *start as usize;
            let end = start
                .saturating_add(*count as usize)
                .min(fem.mesh.elements.len());
            for element in &fem.mesh.elements[start..end] {
                nodes.extend(element.iter().map(|index| *index as usize));
            }
        }
        fullmag_ir::FemMeshPartSelector::ElementMarkerSet { markers } => {
            let markers = markers.iter().copied().collect::<BTreeSet<_>>();
            for (index, element) in fem.mesh.elements.iter().enumerate() {
                if fem
                    .mesh
                    .element_markers
                    .get(index)
                    .is_some_and(|marker| markers.contains(marker))
                {
                    nodes.extend(element.iter().map(|index| *index as usize));
                }
            }
        }
        _ => {}
    }

    for face_index in &part.boundary_face_indices {
        if let Some(face) = fem.mesh.boundary_faces.get(*face_index as usize) {
            nodes.extend(face.iter().map(|index| *index as usize));
        }
    }
    match &part.boundary_face_selector {
        fullmag_ir::FemMeshPartSelector::BoundaryFaceRange { start, count }
            if part.boundary_face_indices.is_empty() =>
        {
            let start = *start as usize;
            let end = start
                .saturating_add(*count as usize)
                .min(fem.mesh.boundary_faces.len());
            for face in &fem.mesh.boundary_faces[start..end] {
                nodes.extend(face.iter().map(|index| *index as usize));
            }
        }
        _ => {}
    }
    for face in &part.surface_faces {
        nodes.extend(face.iter().map(|index| *index as usize));
    }

    nodes
        .into_iter()
        .filter(|index| *index < fem.mesh.nodes.len())
        .collect()
}

fn fem_segment_node_indices_for_artifact(
    fem: &fullmag_ir::FemPlanIR,
    segment: &fullmag_ir::FemObjectSegmentIR,
) -> Vec<usize> {
    if let Some(part) = fem
        .mesh_parts
        .iter()
        .find(|part| fem_mesh_part_matches_segment(part, segment))
    {
        let node_indices = fem_part_node_indices_for_artifact(fem, part);
        if !node_indices.is_empty() {
            return node_indices;
        }
    }

    let start = segment.node_start as usize;
    let end = start
        .saturating_add(segment.node_count as usize)
        .min(fem.mesh.nodes.len());
    (start..end).collect()
}

fn write_prescribed_current_transport_artifacts(
    output_dir: &Path,
    problem: &fullmag_ir::ProblemIR,
    plan: &fullmag_ir::ExecutionPlanIR,
    context: &FieldArtifactContext,
    provenance: &crate::types::ExecutionProvenance,
) -> std::io::Result<()> {
    for module in &problem.current_modules {
        let fullmag_ir::CurrentModuleIR::CurrentTransport {
            name,
            model: fullmag_ir::CurrentTransportModelIR::PrescribedDensity,
            current_density: Some(current_density),
            solve_region,
            ..
        } = module
        else {
            continue;
        };

        let (values, coverage): (Vec<[f64; 3]>, &'static str) = match &plan.backend_plan {
            BackendPlanIR::Fdm(fdm) => {
                let total_cells = fdm.grid.cells[0] as usize
                    * fdm.grid.cells[1] as usize
                    * fdm.grid.cells[2] as usize;
                let values = match &fdm.active_mask {
                    Some(mask) => mask
                        .iter()
                        .map(|is_active| {
                            if *is_active {
                                *current_density
                            } else {
                                [0.0, 0.0, 0.0]
                            }
                        })
                        .collect(),
                    None => vec![*current_density; total_cells],
                };
                (values, "active_fdm_cells")
            }
            BackendPlanIR::Fem(fem) => {
                let mut values = vec![[0.0, 0.0, 0.0]; fem.mesh.nodes.len()];
                let mut matched_any_segment = false;
                let target_geometry = solve_region.as_deref().and_then(|region_name| {
                    resolve_current_transport_geometry(problem, region_name)
                });
                for segment in &fem.object_segments {
                    let matches_region = solve_region.as_deref().is_some_and(|region| {
                        artifacts_object_ids_match(&segment.object_id, region)
                    });
                    let matches_geometry = target_geometry.is_some_and(|geometry_name| {
                        segment
                            .geometry_id
                            .as_deref()
                            .map(|g_id| artifacts_object_ids_match(g_id, geometry_name))
                            .unwrap_or(false)
                    });
                    let matches = solve_region.is_none() || matches_region || matches_geometry;
                    if !matches {
                        continue;
                    }
                    matched_any_segment = true;
                    for index in fem_segment_node_indices_for_artifact(fem, segment) {
                        values[index] = *current_density;
                    }
                }
                if solve_region.is_none() || !matched_any_segment {
                    values.fill(*current_density);
                    (values, "full_fem_layout_uniform")
                } else {
                    (values, "solve_region_nodes")
                }
            }
            _ => continue,
        };
        let artifact_json = serde_json::json!({
            "kind": "current_transport",
            "module_name": name,
            "model": "prescribed_density",
            "unit": "A/m^2",
            "distribution": "uniform_prescribed",
            "coverage": coverage,
            "solve_region": solve_region,
            "layout": context.layout.clone(),
            "provenance": {
                "problem_name": context.problem_name,
                "ir_version": context.ir_version,
                "source_hash": context.source_hash,
                "execution_mode": context.execution_mode,
                "execution_engine": provenance.execution_engine,
                "precision": provenance.precision,
            },
            "values": values,
        });
        let artifact_path = output_dir
            .join("current_transport")
            .join(format!("{name}.json"));
        if let Some(parent) = artifact_path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(
            artifact_path,
            serde_json::to_string_pretty(&artifact_json).unwrap(),
        )?;
    }

    Ok(())
}

fn resolve_current_transport_geometry<'a>(
    problem: &'a fullmag_ir::ProblemIR,
    solve_region: &str,
) -> Option<&'a str> {
    problem
        .regions
        .iter()
        .find(|region| region.name == solve_region)
        .map(|region| region.geometry.as_str())
        .or_else(|| {
            problem
                .geometry
                .entries
                .iter()
                .find(|entry| entry.name() == solve_region)
                .map(|entry| entry.name())
        })
}

pub(crate) fn write_scalars_csv(path: &Path, steps: &[StepStats]) -> std::io::Result<()> {
    let mut csv_file = fs::File::create(path)?;
    write_scalars_csv_header(&mut csv_file)?;
    for step in steps {
        write_scalar_row(&mut csv_file, step)?;
    }
    Ok(())
}

pub(crate) fn write_scalars_csv_header(writer: &mut impl Write) -> std::io::Result<()> {
    writeln!(
        writer,
        "step,time,solver_dt,mx,my,mz,E_ex,E_demag,E_ext,E_ani,E_dmi,E_total,max_dm_dt,max_h_eff,max_h_demag,max_torque_Apm,max_torque_T"
    )
}

pub(crate) fn write_scalar_row(writer: &mut impl Write, step: &StepStats) -> std::io::Result<()> {
    writeln!(
        writer,
        "{},{:.15e},{:.15e},{:.15e},{:.15e},{:.15e},{:.15e},{:.15e},{:.15e},{:.15e},{:.15e},{:.15e},{:.15e},{:.15e},{:.15e},{:.15e},{:.15e}",
        step.step,
        step.time,
        step.dt,
        step.mx,
        step.my,
        step.mz,
        step.e_ex,
        step.e_demag,
        step.e_ext,
        step.e_ani,
        step.e_dmi,
        step.e_total,
        step.max_dm_dt,
        step.max_h_eff,
        step.max_h_demag,
        step.max_torque_Apm,
        step.max_torque_T
    )
}

fn write_table_autosave_artifacts(
    output_dir: &Path,
    problem: &fullmag_ir::ProblemIR,
    steps: &[StepStats],
) -> std::io::Result<()> {
    let Some(config_ir) = problem.study.sampling().table_autosave.as_ref() else {
        return Ok(());
    };
    let config =
        crate::table_autosave::TableAutosaveConfig::from_ir(config_ir).map_err(|error| {
            Error::new(
                ErrorKind::InvalidInput,
                format!("invalid table_autosave config: {error}"),
            )
        })?;
    let mut store = crate::table_autosave::TableStore::new(config);
    for step in steps {
        store
            .append_if_due(step)
            .map_err(|error| Error::new(ErrorKind::InvalidInput, error))?;
    }
    store.write_artifacts(output_dir)
}

pub(crate) fn write_field_file(
    path: &Path,
    context: &FieldArtifactContext,
    provenance: &crate::types::ExecutionProvenance,
    observable: &str,
    step: u64,
    time: f64,
    solver_dt: f64,
    values: &[[f64; 3]],
) -> std::io::Result<()> {
    let field_json = serde_json::json!({
        "observable": observable,
        "unit": field_unit(observable),
        "step": step,
        "time": time,
        "solver_dt": solver_dt,
        "layout": context.layout,
        "provenance": {
            "problem_name": context.problem_name,
            "ir_version": context.ir_version,
            "source_hash": context.source_hash,
            "execution_mode": context.execution_mode,
            "execution_engine": provenance.execution_engine,
            "precision": provenance.precision,
        },
        "values": values,
    });
    fs::write(path, serde_json::to_string_pretty(&field_json).unwrap())
}

#[derive(Debug, Clone)]
struct MultilayerFieldLayer {
    value_offset: usize,
    value_count: usize,
    manifest_entry: serde_json::Value,
    directory: String,
}

pub(crate) fn write_field_snapshot_artifact(
    fields_dir: &Path,
    context: &FieldArtifactContext,
    provenance: &crate::types::ExecutionProvenance,
    snapshot: &crate::types::FieldSnapshot,
) -> std::io::Result<()> {
    let observable_dir = fields_dir.join(&snapshot.name);
    fs::create_dir_all(&observable_dir)?;

    let Some(layers) = multilayer_field_layers(&context.layout)? else {
        let snapshot_path = observable_dir.join(format!("step_{:06}.json", snapshot.step));
        return write_field_file(
            &snapshot_path,
            context,
            provenance,
            &snapshot.name,
            snapshot.step,
            snapshot.time,
            snapshot.solver_dt,
            &snapshot.values,
        );
    };

    let expected_len = layers
        .iter()
        .map(|layer| layer.value_offset.saturating_add(layer.value_count))
        .max()
        .unwrap_or(0);
    if expected_len != snapshot.values.len() {
        return Err(Error::new(
            ErrorKind::InvalidData,
            format!(
                "multilayer field snapshot '{}' has {} values, expected {} from artifact layout",
                snapshot.name,
                snapshot.values.len(),
                expected_len
            ),
        ));
    }

    write_multilayer_field_manifest(&observable_dir, context, &snapshot.name, &layers)?;

    for layer in &layers {
        let layer_dir = observable_dir.join(&layer.directory);
        fs::create_dir_all(&layer_dir)?;
        let start = layer.value_offset;
        let end = start + layer.value_count;
        let snapshot_path = layer_dir.join(format!("step_{:06}.json", snapshot.step));
        write_layer_field_file(
            &snapshot_path,
            context,
            provenance,
            &snapshot.name,
            snapshot.step,
            snapshot.time,
            snapshot.solver_dt,
            layer,
            &snapshot.values[start..end],
        )?;
    }

    Ok(())
}

fn multilayer_field_layers(
    layout: &serde_json::Value,
) -> std::io::Result<Option<Vec<MultilayerFieldLayer>>> {
    if layout.get("backend").and_then(serde_json::Value::as_str) != Some("fdm_multilayer") {
        return Ok(None);
    }
    let Some(raw_layers) = layout.get("layers").and_then(serde_json::Value::as_array) else {
        return Err(Error::new(
            ErrorKind::InvalidData,
            "fdm_multilayer artifact layout is missing layers",
        ));
    };
    if raw_layers.is_empty() {
        return Ok(None);
    }

    let mut seen_ids = HashMap::<String, usize>::new();
    let layers = raw_layers
        .iter()
        .enumerate()
        .map(|(index, raw)| {
            let base_id = raw
                .get("magnet_name")
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| format!("layer-{index}"));
            let count = seen_ids.entry(base_id.clone()).or_insert(0);
            *count += 1;
            let id = if *count == 1 {
                base_id
            } else {
                format!("{base_id}-{}", *count)
            };
            let directory = format!("layer-{}", sanitize_layer_id(&id));
            let value_offset = json_usize_field(raw, "value_offset")?;
            let value_count = json_usize_field(raw, "value_count")?;
            let manifest_entry = serde_json::json!({
                "id": id,
                "directory": directory,
                "file_pattern": format!("{directory}/step_{{step:06}}.json"),
                "native_grid": raw.get("native_grid").cloned().unwrap_or(serde_json::Value::Null),
                "native_cell_size": raw.get("native_cell_size").cloned().unwrap_or(serde_json::Value::Null),
                "native_origin": raw.get("native_origin").cloned().unwrap_or(serde_json::Value::Null),
                "convolution_grid": raw.get("convolution_grid").cloned().unwrap_or(serde_json::Value::Null),
                "convolution_cell_size": raw.get("convolution_cell_size").cloned().unwrap_or(serde_json::Value::Null),
                "transfer_kind": raw.get("transfer_kind").cloned().unwrap_or(serde_json::Value::Null),
                "active_mask_present": raw.get("active_mask_present").cloned().unwrap_or(serde_json::Value::Null),
                "active_cell_count": raw.get("active_cell_count").cloned().unwrap_or(serde_json::Value::Null),
                "inactive_cell_count": raw.get("inactive_cell_count").cloned().unwrap_or(serde_json::Value::Null),
                "value_offset": value_offset,
                "value_count": value_count,
                "vector_shape": [value_count, 3],
            });
            Ok(MultilayerFieldLayer {
                value_offset,
                value_count,
                manifest_entry,
                directory,
            })
        })
        .collect::<std::io::Result<Vec<_>>>()?;

    Ok(Some(layers))
}

fn write_multilayer_field_manifest(
    observable_dir: &Path,
    context: &FieldArtifactContext,
    observable: &str,
    layers: &[MultilayerFieldLayer],
) -> std::io::Result<()> {
    let manifest = serde_json::json!({
        "schema_version": "fdm_multilayer_field_manifest.v1",
        "observable": observable,
        "unit": field_unit(observable),
        "storage_layout": "per_layer_json",
        "component_order": ["x", "y", "z"],
        "layer_count": layers.len(),
        "layers": layers.iter().map(|layer| layer.manifest_entry.clone()).collect::<Vec<_>>(),
        "layout": context.layout.clone(),
    });
    fs::write(
        observable_dir.join("manifest.json"),
        serde_json::to_string_pretty(&manifest).unwrap(),
    )
}

fn write_layer_field_file(
    path: &Path,
    context: &FieldArtifactContext,
    provenance: &crate::types::ExecutionProvenance,
    observable: &str,
    step: u64,
    time: f64,
    solver_dt: f64,
    layer: &MultilayerFieldLayer,
    values: &[[f64; 3]],
) -> std::io::Result<()> {
    let field_json = serde_json::json!({
        "observable": observable,
        "unit": field_unit(observable),
        "step": step,
        "time": time,
        "solver_dt": solver_dt,
        "layer": layer.manifest_entry.clone(),
        "layout": context.layout.clone(),
        "provenance": {
            "problem_name": context.problem_name,
            "ir_version": context.ir_version,
            "source_hash": context.source_hash,
            "execution_mode": context.execution_mode,
            "execution_engine": provenance.execution_engine,
            "precision": provenance.precision,
        },
        "values": values,
    });
    fs::write(path, serde_json::to_string_pretty(&field_json).unwrap())
}

fn json_usize_field(value: &serde_json::Value, field: &str) -> std::io::Result<usize> {
    value
        .get(field)
        .and_then(serde_json::Value::as_u64)
        .and_then(|raw| usize::try_from(raw).ok())
        .ok_or_else(|| {
            Error::new(
                ErrorKind::InvalidData,
                format!("fdm_multilayer artifact layer is missing numeric {field}"),
            )
        })
}

fn sanitize_layer_id(id: &str) -> String {
    let sanitized = id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    if sanitized.is_empty() {
        "unnamed".to_string()
    } else {
        sanitized
    }
}

pub(crate) fn field_layout(plan: &fullmag_ir::ExecutionPlanIR) -> serde_json::Value {
    match &plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => {
            let total_cells = fdm.grid.cells[0] as usize
                * fdm.grid.cells[1] as usize
                * fdm.grid.cells[2] as usize;
            let active_cell_count = fdm
                .active_mask
                .as_ref()
                .map(|mask| mask.iter().filter(|is_active| **is_active).count())
                .unwrap_or(total_cells);
            let inactive_cell_count = total_cells.saturating_sub(active_cell_count);
            serde_json::json!({
                "backend": "fdm",
                "grid_cells": fdm.grid.cells,
                "cell_size": fdm.cell_size,
                "total_cell_count": total_cells,
                "active_mask_present": fdm.active_mask.is_some(),
                "active_mask": fdm.active_mask.as_ref().map(|mask| mask.as_slice()),
                "active_cell_count": active_cell_count,
                "inactive_cell_count": inactive_cell_count,
                "active_fraction": if total_cells > 0 {
                    active_cell_count as f64 / total_cells as f64
                } else {
                    0.0
                },
            })
        }
        BackendPlanIR::FdmMultilayer(ml) => serde_json::json!({
            "backend": "fdm_multilayer",
            "mode": ml.mode,
            "common_cells": ml.common_cells,
            "layer_count": ml.layers.len(),
            "layers": ml.layers.iter().scan(0usize, |offset, layer| {
                let total_cells = layer.native_grid[0] as usize
                    * layer.native_grid[1] as usize
                    * layer.native_grid[2] as usize;
                let active_cell_count = layer
                    .native_active_mask
                    .as_ref()
                    .map(|mask| mask.iter().filter(|is_active| **is_active).count())
                    .unwrap_or(total_cells);
                let current_offset = *offset;
                *offset += total_cells;
                Some(serde_json::json!({
                    "magnet_name": layer.magnet_name,
                    "native_grid": layer.native_grid,
                    "native_cell_size": layer.native_cell_size,
                    "native_origin": layer.native_origin,
                    "convolution_grid": layer.convolution_grid,
                    "convolution_cell_size": layer.convolution_cell_size,
                    "transfer_kind": layer.transfer_kind,
                    "total_cell_count": total_cells,
                    "active_mask_present": layer.native_active_mask.is_some(),
                    "active_cell_count": active_cell_count,
                    "inactive_cell_count": total_cells.saturating_sub(active_cell_count),
                    "value_offset": current_offset,
                    "value_count": total_cells,
                }))
            }).collect::<Vec<_>>(),
            "planner_summary": ml.planner_summary,
        }),
        BackendPlanIR::Fem(fem) => serde_json::json!({
            "backend": "fem",
            "mesh_name": fem.mesh.mesh_name,
            "mesh_source": fem.mesh_source,
            "fe_order": fem.fe_order,
            "hmax": fem.hmax,
            "n_nodes": fem.mesh.nodes.len(),
            "n_elements": fem.mesh.elements.len(),
        }),
        BackendPlanIR::FemEigen(fem) => serde_json::json!({
            "backend": "fem_eigen",
            "mesh_name": fem.mesh.mesh_name,
            "mesh_source": fem.mesh_source,
            "fe_order": fem.fe_order,
            "hmax": fem.hmax,
            "n_nodes": fem.mesh.nodes.len(),
            "n_elements": fem.mesh.elements.len(),
            "mode_count": fem.count,
            "operator": fem.operator,
        }),
        BackendPlanIR::FemFrequencyResponse(fem) => serde_json::json!({
            "backend": "fem_frequency_response",
            "mesh_name": fem.mesh.mesh_name,
            "mesh_source": fem.mesh_source,
            "fe_order": fem.fe_order,
            "hmax": fem.hmax,
            "n_nodes": fem.mesh.nodes.len(),
            "n_elements": fem.mesh.elements.len(),
            "frequency_count": fem.frequencies_hz.values_hz.len(),
            "operator": fem.operator,
        }),
    }
}

pub(crate) fn field_unit(observable: &str) -> &'static str {
    let base_observable = observable
        .split_once('.')
        .map_or(observable, |(base, _)| base);
    match base_observable {
        "m" => "dimensionless",
        "H_ex" | "H_demag" | "H_ext" | "H_OE" | "H_eff" | "H_ani" | "H_dmi" | "H_dmi_bulk" => "A/m",
        "torque" => "T",
        other => panic!("unsupported observable '{}'", other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{
        ExecutedRun, ExecutionProvenance, FieldSnapshot, ResolvedFallback, RunResult, RunStatus,
    };
    use fullmag_ir::{
        BackendPlanIR, CommonPlanMeta, ExchangeBoundaryCondition, ExecutionMode, ExecutionPlanIR,
        ExecutionPrecision, FdmLayerPlanIR, FdmMaterialIR, FdmMultilayerPlanIR,
        FdmMultilayerSummaryIR, FdmPlanIR, FemDomainMeshModeIR, FemMeshPartIR, FemMeshPartRole,
        FemMeshPartSelector, FemObjectSegmentIR, FemPlanIR, GridDimensions, IntegratorChoice,
        MaterialFieldLocationIR, MaterialFieldPlan, MaterialFieldSourceKind,
        MaterialFieldStatisticsIR, MaterialIR, MaterialParameterNameIR, MeshIR, OutputPlanIR,
        ProvenancePlanIR,
    };
    use std::collections::HashMap;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn dmi_field_artifact_units_include_bulk_quantity() {
        assert_eq!(field_unit("H_dmi"), "A/m");
        assert_eq!(field_unit("H_dmi.x"), "A/m");
        assert_eq!(field_unit("H_dmi_bulk"), "A/m");
        assert_eq!(field_unit("H_dmi_bulk.z"), "A/m");
    }

    fn test_execution_plan(active_mask: Option<Vec<bool>>) -> ExecutionPlanIR {
        ExecutionPlanIR {
            common: CommonPlanMeta {
                ir_version: "v0".to_string(),
                requested_backend: fullmag_ir::BackendTarget::Fdm,
                resolved_backend: fullmag_ir::BackendTarget::Fdm,
                execution_mode: ExecutionMode::Strict,
                material_field_plans: Vec::new(),
            },
            backend_plan: BackendPlanIR::Fdm(FdmPlanIR {
                grid: GridDimensions { cells: [4, 2, 1] },
                cell_size: [2e-9, 2e-9, 5e-9],
                region_mask: vec![0; 8],
                active_mask,
                initial_magnetization: vec![[1.0, 0.0, 0.0]; 8],
                material: FdmMaterialIR {
                    name: "Py".to_string(),
                    saturation_magnetisation: 800e3,
                    exchange_stiffness: 13e-12,
                    damping: 0.02,
                    ..Default::default()
                },
                enable_exchange: true,
                enable_demag: true,
                external_field: None,
                gyromagnetic_ratio: 2.211e5,
                precision: ExecutionPrecision::Double,
                exchange_bc: ExchangeBoundaryCondition::Neumann,
                integrator: IntegratorChoice::Heun,
                fixed_timestep: Some(1e-13),
                adaptive_timestep: None,
                field_refresh: None,
                relaxation: None,
                boundary_correction: None,
                boundary_geometry: None,
                inter_region_exchange: vec![],
                current_density: None,
                stt_degree: None,
                stt_beta: None,
                stt_spin_polarization: None,
                stt_lambda: None,
                stt_epsilon_prime: None,
                stt_thickness: None,
                stt_fixed_layer_position: None,
                has_oersted_cylinder: false,
                oersted_current: None,
                oersted_radius: None,
                oersted_center: None,
                oersted_axis: None,
                oersted_field_xyz: None,
                oersted_time_dep_kind: 0,
                oersted_time_dep_freq: 0.0,
                oersted_time_dep_phase: 0.0,
                oersted_time_dep_offset: 0.0,
                oersted_time_dep_t_on: 0.0,
                oersted_time_dep_t_off: 0.0,
                oersted_realization: None,
                temperature: None,
                interfacial_dmi: None,
                bulk_dmi: None,
                ..Default::default()
            }),
            output_plan: OutputPlanIR {
                outputs: Vec::new(),
            },
            provenance: ProvenancePlanIR { notes: Vec::new() },
        }
    }

    fn test_multilayer_execution_plan() -> ExecutionPlanIR {
        let layer_material = FdmMaterialIR {
            name: "Py".to_string(),
            saturation_magnetisation: 800e3,
            exchange_stiffness: 13e-12,
            damping: 0.02,
            ..Default::default()
        };
        ExecutionPlanIR {
            common: CommonPlanMeta {
                ir_version: "v0".to_string(),
                requested_backend: fullmag_ir::BackendTarget::Fdm,
                resolved_backend: fullmag_ir::BackendTarget::Fdm,
                execution_mode: ExecutionMode::Strict,
                material_field_plans: Vec::new(),
            },
            backend_plan: BackendPlanIR::FdmMultilayer(FdmMultilayerPlanIR {
                mode: "multilayer_convolution".to_string(),
                common_cells: [2, 1, 2],
                layers: vec![
                    FdmLayerPlanIR {
                        magnet_name: "bottom".to_string(),
                        native_grid: [2, 1, 1],
                        native_cell_size: [2e-9, 2e-9, 1e-9],
                        native_origin: [0.0, 0.0, 0.0],
                        native_active_mask: None,
                        initial_magnetization: vec![[1.0, 0.0, 0.0]; 2],
                        material: layer_material.clone(),
                        convolution_grid: [2, 1, 1],
                        convolution_cell_size: [2e-9, 2e-9, 1e-9],
                        convolution_origin: [0.0, 0.0, 0.0],
                        transfer_kind: "identity".to_string(),
                    },
                    FdmLayerPlanIR {
                        magnet_name: "top".to_string(),
                        native_grid: [2, 1, 1],
                        native_cell_size: [2e-9, 2e-9, 1e-9],
                        native_origin: [0.0, 0.0, 4e-9],
                        native_active_mask: Some(vec![true, false]),
                        initial_magnetization: vec![[0.0, 1.0, 0.0]; 2],
                        material: layer_material,
                        convolution_grid: [2, 1, 1],
                        convolution_cell_size: [2e-9, 2e-9, 1e-9],
                        convolution_origin: [0.0, 0.0, 4e-9],
                        transfer_kind: "identity".to_string(),
                    },
                ],
                enable_exchange: true,
                enable_demag: true,
                external_field: None,
                interfacial_dmi: None,
                bulk_dmi: None,
                gyromagnetic_ratio: 2.211e5,
                precision: ExecutionPrecision::Double,
                exchange_bc: ExchangeBoundaryCondition::Neumann,
                periodicity: None,
                integrator: IntegratorChoice::Heun,
                fixed_timestep: Some(1e-13),
                field_refresh: None,
                relaxation: None,
                planner_summary: FdmMultilayerSummaryIR {
                    requested_strategy: "multilayer_convolution".to_string(),
                    selected_strategy: "multilayer_convolution".to_string(),
                    eligibility: "eligible".to_string(),
                    estimated_pair_kernels: 4,
                    estimated_unique_kernels: 3,
                    estimated_kernel_bytes: 4096,
                    warnings: Vec::new(),
                },
            }),
            output_plan: OutputPlanIR {
                outputs: Vec::new(),
            },
            provenance: ProvenancePlanIR { notes: Vec::new() },
        }
    }

    fn test_fem_execution_plan() -> ExecutionPlanIR {
        ExecutionPlanIR {
            common: CommonPlanMeta {
                ir_version: "v0".to_string(),
                requested_backend: fullmag_ir::BackendTarget::Fem,
                resolved_backend: fullmag_ir::BackendTarget::Fem,
                execution_mode: ExecutionMode::Strict,
                material_field_plans: Vec::new(),
            },
            backend_plan: BackendPlanIR::Fem(FemPlanIR {
                mesh_name: "unit_tet".to_string(),
                mesh_source: Some("meshes/unit_tet.msh".to_string()),
                mesh: MeshIR {
                    mesh_name: "unit_tet".to_string(),
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
                    per_domain_quality: HashMap::new(),
                },
                object_segments: vec![FemObjectSegmentIR {
                    object_id: "free".to_string(),
                    geometry_id: Some("pillar".to_string()),
                    node_start: 0,
                    node_count: 4,
                    element_start: 0,
                    element_count: 1,
                    boundary_face_start: 0,
                    boundary_face_count: 1,
                }],
                mesh_parts: Vec::new(),
                domain_mesh_mode: FemDomainMeshModeIR::MergedMagneticMesh,
                domain_frame: None,
                fe_order: 1,
                hmax: 0.4,
                initial_magnetization: vec![[1.0, 0.0, 0.0]; 4],
                material: MaterialIR {
                    name: "Py".to_string(),
                    saturation_magnetisation: 800e3,
                    exchange_stiffness: 13e-12,
                    damping: 0.02,
                    uniaxial_anisotropy: None,
                    anisotropy_axis: None,
                    uniaxial_anisotropy_k2: None,
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
                anisotropy_axis_field: None,
                ms_element_field: None,
                a_element_field: None,
                region_materials: Vec::new(),
                enable_exchange: true,
                enable_demag: false,
                external_field: None,
                antenna_zeeman_masks: Vec::new(),
                current_modules: Vec::new(),
                gyromagnetic_ratio: 2.211e5,
                precision: ExecutionPrecision::Double,
                exchange_bc: ExchangeBoundaryCondition::Neumann,
                integrator: IntegratorChoice::Heun,
                fixed_timestep: Some(1e-13),
                adaptive_timestep: None,
                field_refresh: None,
                relaxation: None,
                demag_realization: None,
                air_box_config: None,
                interfacial_dmi: None,
                dmi_interface_normal: None,
                bulk_dmi: None,
                dind_field: None,
                dbulk_field: None,
                temperature: None,
                current_density: None,
                stt_degree: None,
                stt_beta: None,
                stt_spin_polarization: None,
                stt_lambda: None,
                stt_epsilon_prime: None,
                stt_thickness: None,
                stt_fixed_layer_position: None,
                has_oersted_cylinder: false,
                oersted_current: None,
                oersted_radius: None,
                oersted_center: None,
                oersted_axis: None,
                oersted_field_xyz: None,
                oersted_time_dep_kind: 0,
                oersted_time_dep_freq: 0.0,
                oersted_time_dep_phase: 0.0,
                oersted_time_dep_offset: 0.0,
                oersted_time_dep_t_on: 0.0,
                oersted_time_dep_t_off: 0.0,
                magnetoelastic: None,
                mechanics: None,
                demag_solver_policy: None,
                thermal_seed_config: None,
                oersted_realization: None,
                gpu_device_index: None,
                mfem_device_string: None,
                use_consistent_mass: None,
            }),
            output_plan: OutputPlanIR {
                outputs: Vec::new(),
            },
            provenance: ProvenancePlanIR { notes: Vec::new() },
        }
    }

    #[test]
    fn metadata_execution_provenance_persists_resolved_fallback() {
        let problem = fullmag_ir::ProblemIR::bootstrap_example();
        let plan = test_fem_execution_plan();
        let unique_suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-artifacts-resolved-fallback-{}-{}",
            std::process::id(),
            unique_suffix
        ));

        let executed = ExecutedRun {
            result: RunResult {
                status: RunStatus::Completed,
                steps: Vec::new(),
                final_magnetization: vec![[1.0, 0.0, 0.0]; 4],
                completion: None,
            },
            initial_magnetization: vec![[1.0, 0.0, 0.0]; 4],
            field_snapshots: Vec::new(),
            field_snapshot_count: 0,
            auxiliary_artifacts: Vec::new(),
            provenance: ExecutionProvenance {
                execution_engine: "fem_cpu_native".to_string(),
                precision: "double".to_string(),
                resolved_fallback: Some(ResolvedFallback {
                    occurred: true,
                    original_engine: "fem_native_gpu".to_string(),
                    fallback_engine: "fem_cpu_native".to_string(),
                    reason: "native_fem_gpu_unavailable".to_string(),
                    message: "native FEM GPU unavailable in test".to_string(),
                }),
                ..ExecutionProvenance::default()
            },
        };

        write_artifacts(&output_dir, &problem, &plan, &executed, None)
            .expect("artifact write should preserve resolved fallback");

        let metadata: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(output_dir.join("metadata.json")).expect("metadata should exist"),
        )
        .expect("metadata should parse");
        let fallback = &metadata["execution_provenance"]["resolved_fallback"];
        assert_eq!(fallback["occurred"], true);
        assert_eq!(fallback["original_engine"], "fem_native_gpu");
        assert_eq!(fallback["fallback_engine"], "fem_cpu_native");
        assert_eq!(fallback["reason"], "native_fem_gpu_unavailable");

        fs::remove_dir_all(output_dir).expect("temporary artifact directory should be removable");
    }

    #[test]
    fn write_artifacts_persists_fem_material_field_asset_files() {
        let problem = fullmag_ir::ProblemIR::bootstrap_example();
        let mut plan = test_fem_execution_plan();
        plan.common.material_field_plans = vec![MaterialFieldPlan {
            object_id: "free".to_string(),
            parameter: MaterialParameterNameIR::Ms,
            source_kind: MaterialFieldSourceKind::Override,
            realization_location: MaterialFieldLocationIR::Node,
            requires_sampling: false,
            requires_mesh_revision: true,
            warnings: Vec::new(),
            realization_method: Some("fem_nodal_material_field".to_string()),
            statistics: Some(MaterialFieldStatisticsIR {
                sample_count: 4,
                min: 700e3,
                max: 730e3,
                mean: 715e3,
            }),
        }];
        let BackendPlanIR::Fem(fem) = &mut plan.backend_plan else {
            panic!("test plan should be FEM");
        };
        fem.material.ms_field = Some(vec![700e3, 710e3, 720e3, 730e3]);

        let unique_suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-artifacts-material-fields-{}-{}",
            std::process::id(),
            unique_suffix
        ));
        let executed = ExecutedRun {
            result: RunResult {
                status: RunStatus::Completed,
                steps: Vec::new(),
                final_magnetization: vec![[1.0, 0.0, 0.0]; 4],
                completion: None,
            },
            initial_magnetization: vec![[1.0, 0.0, 0.0]; 4],
            field_snapshots: Vec::new(),
            field_snapshot_count: 0,
            auxiliary_artifacts: Vec::new(),
            provenance: ExecutionProvenance {
                execution_engine: "fem_cpu_native".to_string(),
                precision: "double".to_string(),
                ..Default::default()
            },
        };

        write_artifacts(&output_dir, &problem, &plan, &executed, None)
            .expect("material-field artifacts should be written");

        let metadata: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(output_dir.join("metadata.json")).expect("metadata should exist"),
        )
        .expect("metadata should parse");
        let assets = metadata["material_field_assets"]
            .as_array()
            .expect("metadata should carry material_field_assets");
        assert_eq!(assets.len(), 1);
        assert_eq!(assets[0]["asset_id"], "free_ms_node");
        assert_eq!(
            assets[0]["artifact_path"],
            "material-fields/free_ms_node.json"
        );
        assert_eq!(assets[0]["values"].as_array().map(Vec::len), Some(0));

        let artifact: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(output_dir.join("material-fields/free_ms_node.json"))
                .expect("material-field asset artifact should exist"),
        )
        .expect("material-field artifact should parse");
        assert_eq!(artifact["asset_id"], "free_ms_node");
        assert_eq!(artifact["values"].as_array().map(Vec::len), Some(4));
        assert_eq!(artifact["min"], 700e3);
        assert_eq!(artifact["max"], 730e3);
        assert_eq!(artifact["mean"], 715e3);

        fs::remove_dir_all(output_dir).expect("temporary artifact directory should be removable");
    }

    #[test]
    fn demag_profile_metadata_includes_timing_breakdown() {
        let mut plan = test_fem_execution_plan();
        if let BackendPlanIR::Fem(fem) = &mut plan.backend_plan {
            fem.enable_demag = true;
            fem.demag_realization = Some(fullmag_ir::ResolvedFemDemagIR::PoissonRobin);
        }

        let metadata = demag_runtime_metadata(
            &plan,
            &ExecutionProvenance::default(),
            &[StepStats {
                demag_wall_time_ns: 29,
                demag_assemble_wall_time_ns: 3,
                demag_solve_wall_time_ns: 5,
                demag_solver_setup_wall_time_ns: 17,
                demag_solver_apply_wall_time_ns: 19,
                demag_solver_setup_reused: true,
                demag_recover_wall_time_ns: 7,
                demag_energy_wall_time_ns: 11,
                poisson_iterations: 13,
                poisson_final_residual: 1.0e-8,
                ..StepStats::default()
            }],
        );

        assert_eq!(metadata["timings_ns"]["assemble"], 3);
        assert_eq!(metadata["timings_ns"]["solve"], 5);
        assert_eq!(metadata["timings_ns"]["solver_setup"], 17);
        assert_eq!(metadata["timings_ns"]["solver_apply"], 19);
        assert_eq!(metadata["timings_ns"]["recover"], 7);
        assert_eq!(metadata["timings_ns"]["energy"], 11);
        assert_eq!(metadata["timings_ns"]["total"], 29);
        assert_eq!(metadata["solver_setup_reused"], true);
        assert_eq!(metadata["actual_iterations"], 13);
        assert_eq!(metadata["final_residual_norm"], 1.0e-8);
        assert_eq!(metadata["relative_tolerance"], 1.0e-8);
        assert_eq!(metadata["absolute_tolerance"], serde_json::Value::Null);
        assert_eq!(metadata["max_iterations"], 500);
        assert_eq!(metadata["print_level"], 0);
    }

    #[test]
    fn fem_cpu_relaxation_qualification_metadata_carries_reproducibility_contract() {
        let mut plan = test_fem_execution_plan();
        if let BackendPlanIR::Fem(fem) = &mut plan.backend_plan {
            fem.enable_demag = true;
            fem.demag_realization = Some(fullmag_ir::ResolvedFemDemagIR::PoissonRobin);
            fem.material.uniaxial_anisotropy = Some(0.5e6);
            fem.material.anisotropy_axis = Some([0.0, 0.0, 1.0]);
            fem.relaxation = Some(fullmag_ir::RelaxationControlIR {
                algorithm: fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped,
                stop: fullmag_ir::RelaxStopIR {
                    torque_tolerance_apm: Some(1.0e-3),
                    energy_tolerance_j: None,
                    max_steps: Some(100),
                    max_pseudotime_s: None,
                    max_physical_time_s: None,
                },
            });
        }
        let provenance = ExecutionProvenance {
            execution_engine: "fem_cpu_native".to_string(),
            precision: "double".to_string(),
            mfem_device: Some("cpu".to_string()),
            fem_assembly_mode: Some("legacy_sparse".to_string()),
            fem_execution_mode: Some("cpu_native".to_string()),
            fem_data_residency: Some("host_source_of_truth".to_string()),
            uses_cuda_kernels: Some(false),
            uses_gpu_poisson: Some(false),
            ..ExecutionProvenance::default()
        };
        let executed = ExecutedRun {
            result: RunResult {
                status: RunStatus::Completed,
                steps: vec![StepStats {
                    step: 100,
                    e_ex: 1.0,
                    e_demag: 2.0,
                    e_ani: 3.0,
                    e_total: 6.0,
                    max_torque_Apm: 4.0e-4,
                    demag_solver_setup_reused: true,
                    poisson_iterations: 13,
                    poisson_final_residual: 1.0e-8,
                    ..StepStats::default()
                }],
                final_magnetization: vec![[1.0, 0.0, 0.0]; 4],
                completion: Some(fullmag_ir::StageCompletionIR {
                    status: "completed".to_string(),
                    reason: Some(fullmag_ir::StageStopReason::Torque),
                    metric_name: Some("max_torque_apm".to_string()),
                    metric_value: Some(4.0e-4),
                    threshold: Some(1.0e-3),
                }),
            },
            initial_magnetization: vec![[1.0, 0.0, 0.0]; 4],
            field_snapshots: Vec::new(),
            field_snapshot_count: 0,
            auxiliary_artifacts: Vec::new(),
            provenance: provenance.clone(),
        };
        let demag_runtime = demag_runtime_metadata(&plan, &provenance, &executed.result.steps);

        let metadata = fem_cpu_relaxation_qualification_metadata(
            &plan,
            &provenance,
            &demag_runtime,
            &executed,
        );

        assert_eq!(
            metadata["schema_version"],
            "fem_cpu_relaxation_qualification.v1"
        );
        assert_eq!(
            metadata["benchmark_gate_version"],
            "fem_cpu_no_pbc_adaptive.v1"
        );
        assert_eq!(
            metadata["physics_terms"],
            serde_json::json!(["exchange", "demag", "anisotropy_uniaxial"])
        );
        assert_eq!(
            metadata["solver_mesh_signature"].as_str().unwrap().len(),
            64
        );
        assert_eq!(metadata["demag_policy"]["linear_solver"], "CG");
        assert_eq!(metadata["assembly_mode"], "legacy_sparse");
        assert_eq!(metadata["relaxation_algorithm"], "llg_overdamped");
        assert_eq!(metadata["stop_reason"], "torque");
        assert_eq!(metadata["final_energy_terms_j"]["E_ex"], 1.0);
        assert_eq!(metadata["final_energy_terms_j"]["E_demag"], 2.0);
        assert_eq!(metadata["final_energy_terms_j"]["E_ani"], 3.0);
        assert_eq!(metadata["final_torque_apm"], 4.0e-4);
        assert_eq!(metadata["norm_defect"], 0.0);

        let typed: crate::types::FemCpuRelaxationQualificationMetadata =
            serde_json::from_value(metadata).expect("qualification metadata should be typed");
        assert_eq!(typed.schema_version, "fem_cpu_relaxation_qualification.v1");
        assert_eq!(typed.demag_policy.linear_solver.as_deref(), Some("CG"));
        assert_eq!(typed.final_energy_terms_j.e_total, 6.0);
    }

    #[test]
    fn fem_cpu_relaxation_qualification_metadata_reports_direct_minimizer_policy() {
        let mut plan = test_fem_execution_plan();
        if let BackendPlanIR::Fem(fem) = &mut plan.backend_plan {
            fem.relaxation = Some(fullmag_ir::RelaxationControlIR {
                algorithm: fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb,
                stop: fullmag_ir::RelaxStopIR {
                    torque_tolerance_apm: Some(1.0e-3),
                    energy_tolerance_j: None,
                    max_steps: Some(10),
                    max_pseudotime_s: None,
                    max_physical_time_s: None,
                },
            });
        }
        let provenance = ExecutionProvenance {
            execution_engine: "fem_cpu_native".to_string(),
            precision: "double".to_string(),
            energy_minimizer_realization: Some(
                crate::relaxation::NATIVE_MFEM_DIRECT_MINIMIZER_REALIZATION.to_string(),
            ),
            fem_assembly_mode: Some("legacy_sparse".to_string()),
            fem_gpu_qualification_status: None,
            ..ExecutionProvenance::default()
        };
        let executed = ExecutedRun {
            result: RunResult {
                status: RunStatus::Completed,
                steps: vec![StepStats {
                    step: 3,
                    e_ex: 1.0,
                    e_total: 1.0,
                    max_torque_Apm: 2.0e-4,
                    ..StepStats::default()
                }],
                final_magnetization: vec![[1.0, 0.0, 0.0]; 4],
                completion: None,
            },
            initial_magnetization: vec![[1.0, 0.0, 0.0]; 4],
            field_snapshots: Vec::new(),
            field_snapshot_count: 0,
            auxiliary_artifacts: Vec::new(),
            provenance: provenance.clone(),
        };
        let demag_runtime = demag_runtime_metadata(&plan, &provenance, &executed.result.steps);

        let metadata = fem_cpu_relaxation_qualification_metadata(
            &plan,
            &provenance,
            &demag_runtime,
            &executed,
        );

        assert_eq!(metadata["relaxation_algorithm"], "projected_gradient_bb");
        assert_eq!(
            metadata["algorithm_policy"]["realization"],
            crate::relaxation::NATIVE_MFEM_DIRECT_MINIMIZER_REALIZATION
        );
        assert_eq!(
            metadata["algorithm_policy"]["metric"],
            "fem_lumped_mass_inner_product"
        );
        assert_eq!(
            metadata["algorithm_policy"]["preconditioner"],
            "exchange_plus_mass_tangent_gradient"
        );
        assert_eq!(
            metadata["algorithm_policy"]["step_update"],
            "alternating_bb1_bb2"
        );
        assert_eq!(
            metadata["algorithm_policy"]["gpu_status"],
            "production_executable"
        );

        let typed: crate::types::FemCpuRelaxationQualificationMetadata =
            serde_json::from_value(metadata).expect("qualification metadata should be typed");
        let policy = typed
            .algorithm_policy
            .expect("direct minimizer metadata must carry an algorithm policy");
        assert_eq!(
            policy.linear_solver_policy.as_deref(),
            Some("serial MFEM CG production default; HyprePCG/BoomerAMG explicit opt-in")
        );
    }

    #[test]
    fn fem_cpu_relaxation_qualification_metadata_reports_nonlinear_cg_update_policy() {
        let mut plan = test_fem_execution_plan();
        if let BackendPlanIR::Fem(fem) = &mut plan.backend_plan {
            fem.relaxation = Some(fullmag_ir::RelaxationControlIR {
                algorithm: fullmag_ir::RelaxationAlgorithmIR::NonlinearCg,
                stop: fullmag_ir::RelaxStopIR {
                    torque_tolerance_apm: Some(1.0e-3),
                    energy_tolerance_j: None,
                    max_steps: Some(10),
                    max_pseudotime_s: None,
                    max_physical_time_s: None,
                },
            });
        }
        let provenance = ExecutionProvenance {
            execution_engine: "fem_cpu_native".to_string(),
            precision: "double".to_string(),
            energy_minimizer_realization: Some(
                crate::relaxation::NATIVE_MFEM_DIRECT_MINIMIZER_REALIZATION.to_string(),
            ),
            fem_assembly_mode: Some("legacy_sparse".to_string()),
            fem_gpu_qualification_status: None,
            ..ExecutionProvenance::default()
        };
        let executed = ExecutedRun {
            result: RunResult {
                status: RunStatus::Completed,
                steps: vec![StepStats {
                    step: 3,
                    e_ex: 1.0,
                    e_total: 1.0,
                    max_torque_Apm: 2.0e-4,
                    ..StepStats::default()
                }],
                final_magnetization: vec![[1.0, 0.0, 0.0]; 4],
                completion: None,
            },
            initial_magnetization: vec![[1.0, 0.0, 0.0]; 4],
            field_snapshots: Vec::new(),
            field_snapshot_count: 0,
            auxiliary_artifacts: Vec::new(),
            provenance: provenance.clone(),
        };
        let demag_runtime = demag_runtime_metadata(&plan, &provenance, &executed.result.steps);

        let metadata = fem_cpu_relaxation_qualification_metadata(
            &plan,
            &provenance,
            &demag_runtime,
            &executed,
        );

        assert_eq!(metadata["relaxation_algorithm"], "nonlinear_cg");
        assert_eq!(
            metadata["algorithm_policy"]["direction_update"],
            "polak_ribiere_plus_projected_restart"
        );
        assert_eq!(
            metadata["algorithm_policy"]["line_search"],
            "native_armijo_backtracking_pr_plus_restart"
        );
    }

    #[test]
    fn fem_relaxation_norm_defect_ignores_shared_domain_airbox_nodes() {
        let mut plan = test_fem_execution_plan();
        if let BackendPlanIR::Fem(fem) = &mut plan.backend_plan {
            fem.relaxation = Some(fullmag_ir::RelaxationControlIR {
                algorithm: fullmag_ir::RelaxationAlgorithmIR::NonlinearCg,
                stop: fullmag_ir::RelaxStopIR {
                    torque_tolerance_apm: Some(1.0e-3),
                    energy_tolerance_j: None,
                    max_steps: Some(10),
                    max_pseudotime_s: None,
                    max_physical_time_s: None,
                },
            });
            fem.domain_mesh_mode = FemDomainMeshModeIR::SharedDomainMeshWithAir;
            fem.mesh_parts = vec![
                FemMeshPartIR {
                    id: "part:body".to_string(),
                    label: "body".to_string(),
                    role: FemMeshPartRole::MagneticObject,
                    object_id: Some("body".to_string()),
                    geometry_id: Some("body_geom".to_string()),
                    material_id: None,
                    element_selector: FemMeshPartSelector::ElementRange { start: 0, count: 0 },
                    boundary_face_selector: FemMeshPartSelector::BoundaryFaceRange {
                        start: 0,
                        count: 0,
                    },
                    node_selector: FemMeshPartSelector::NodeRange { start: 0, count: 1 },
                    boundary_face_indices: Vec::new(),
                    node_indices: vec![0],
                    surface_faces: Vec::new(),
                    bounds_min: None,
                    bounds_max: None,
                    parent_id: None,
                },
                FemMeshPartIR {
                    id: "part:__air__".to_string(),
                    label: "Airbox".to_string(),
                    role: FemMeshPartRole::Air,
                    object_id: None,
                    geometry_id: None,
                    material_id: None,
                    element_selector: FemMeshPartSelector::ElementRange { start: 0, count: 0 },
                    boundary_face_selector: FemMeshPartSelector::BoundaryFaceRange {
                        start: 0,
                        count: 0,
                    },
                    node_selector: FemMeshPartSelector::NodeRange { start: 1, count: 3 },
                    boundary_face_indices: Vec::new(),
                    node_indices: vec![1, 2, 3],
                    surface_faces: Vec::new(),
                    bounds_min: None,
                    bounds_max: None,
                    parent_id: None,
                },
            ];
        }
        let provenance = ExecutionProvenance {
            execution_engine: "fem_cpu_native".to_string(),
            precision: "double".to_string(),
            energy_minimizer_realization: Some(
                crate::relaxation::NATIVE_MFEM_DIRECT_MINIMIZER_REALIZATION.to_string(),
            ),
            fem_assembly_mode: Some("legacy_sparse".to_string()),
            ..ExecutionProvenance::default()
        };
        let executed = ExecutedRun {
            result: RunResult {
                status: RunStatus::Completed,
                steps: vec![StepStats {
                    step: 3,
                    e_ex: 1.0,
                    e_total: 1.0,
                    max_torque_Apm: 2.0e-4,
                    ..StepStats::default()
                }],
                final_magnetization: vec![
                    [1.0, 0.0, 0.0],
                    [0.0, 0.0, 0.0],
                    [0.0, 0.0, 0.0],
                    [0.0, 0.0, 0.0],
                ],
                completion: None,
            },
            initial_magnetization: vec![[1.0, 0.0, 0.0]; 4],
            field_snapshots: Vec::new(),
            field_snapshot_count: 0,
            auxiliary_artifacts: Vec::new(),
            provenance: provenance.clone(),
        };
        let demag_runtime = demag_runtime_metadata(&plan, &provenance, &executed.result.steps);

        let metadata = fem_cpu_relaxation_qualification_metadata(
            &plan,
            &provenance,
            &demag_runtime,
            &executed,
        );

        assert_eq!(metadata["norm_defect"], 0.0);
    }

    #[test]
    fn metadata_reports_fem_gpu_direct_minimizer_qualification_policy() {
        let mut problem = fullmag_ir::ProblemIR::bootstrap_example();
        problem.problem_meta.name = "gpu_ncg_relax_metadata".to_string();
        let mut plan = test_fem_execution_plan();
        if let BackendPlanIR::Fem(fem) = &mut plan.backend_plan {
            fem.relaxation = Some(fullmag_ir::RelaxationControlIR {
                algorithm: fullmag_ir::RelaxationAlgorithmIR::NonlinearCg,
                stop: fullmag_ir::RelaxStopIR {
                    torque_tolerance_apm: Some(1.0e-3),
                    energy_tolerance_j: None,
                    max_steps: Some(4),
                    max_pseudotime_s: None,
                    max_physical_time_s: None,
                },
            });
        }
        let provenance = ExecutionProvenance {
            execution_engine: "fem_native_gpu".to_string(),
            precision: "double".to_string(),
            requested_energy_minimizer: Some("nonlinear_cg".to_string()),
            resolved_energy_minimizer: Some("nonlinear_cg".to_string()),
            energy_minimizer_realization: Some(
                crate::relaxation::NATIVE_MFEM_DIRECT_MINIMIZER_REALIZATION.to_string(),
            ),
            fem_execution_mode: Some("all_in_gpu_legacy_sparse".to_string()),
            fem_gpu_qualification_status: Some("production_executable".to_string()),
            fem_exchange_operator_mode: Some("legacy_sparse_gpu".to_string()),
            fem_data_residency: Some("device_source_of_truth".to_string()),
            uses_cuda_kernels: Some(true),
            uses_gpu_poisson: Some(true),
            fem_demag_operator_mode: Some("device_hypre_poisson".to_string()),
            hot_loop_exchange_host_sync_count: Some(0),
            hot_loop_compute_host_sync_count: Some(3),
            hot_loop_control_scalar_d2h_bytes: Some(0),
            hot_loop_control_scalar_host_sync_count: Some(0),
            ..ExecutionProvenance::default()
        };
        let executed = ExecutedRun {
            result: RunResult {
                status: RunStatus::Completed,
                steps: vec![StepStats {
                    step: 4,
                    e_ex: 1.0,
                    e_demag: 2.0,
                    e_total: 3.0,
                    max_torque_Apm: 2.0e-4,
                    ..StepStats::default()
                }],
                final_magnetization: vec![[1.0, 0.0, 0.0]; 4],
                completion: None,
            },
            initial_magnetization: vec![[1.0, 0.0, 0.0]; 4],
            field_snapshots: Vec::new(),
            field_snapshot_count: 0,
            auxiliary_artifacts: Vec::new(),
            provenance,
        };
        let unique_suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-artifacts-fem-gpu-relax-{}-{}",
            std::process::id(),
            unique_suffix
        ));

        write_artifacts(&output_dir, &problem, &plan, &executed, None)
            .expect("GPU relaxation metadata artifacts should be written");
        let metadata: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(output_dir.join("metadata.json")).expect("metadata should exist"),
        )
        .expect("metadata should parse");
        let qualification = &metadata["fem_gpu_relaxation_qualification"];
        assert_eq!(
            qualification["schema_version"],
            "fem_gpu_relaxation_qualification.v1"
        );
        assert_eq!(qualification["relaxation_algorithm"], "nonlinear_cg");
        assert_eq!(
            qualification["algorithm_policy"]["line_search"],
            "native_armijo_backtracking_pr_plus_restart"
        );
        assert_eq!(
            qualification["algorithm_policy"]["metric"],
            "fem_lumped_mass_inner_product"
        );
        assert_eq!(
            qualification["algorithm_policy"]["gradient_policy"],
            "device_tangent_gradient"
        );
        assert_eq!(
            qualification["device_policy"]["exchange_operator_mode"],
            "legacy_sparse_gpu"
        );
        assert_eq!(
            qualification["device_policy"]["hot_loop_exchange_host_sync_count"],
            0
        );
        assert_eq!(qualification["norm_defect"], 0.0);

        fs::remove_dir_all(output_dir).expect("temporary artifact directory should be removable");
    }

    #[test]
    fn metadata_reports_fem_llg_overdamped_relaxation_policy() {
        let mut problem = fullmag_ir::ProblemIR::bootstrap_example();
        problem.problem_meta.name = "gpu_llg_relax_metadata".to_string();
        let mut gpu_plan = test_fem_execution_plan();
        if let BackendPlanIR::Fem(fem) = &mut gpu_plan.backend_plan {
            fem.relaxation = Some(fullmag_ir::RelaxationControlIR {
                algorithm: fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped,
                stop: fullmag_ir::RelaxStopIR {
                    torque_tolerance_apm: Some(1.0e-3),
                    energy_tolerance_j: None,
                    max_steps: Some(4),
                    max_pseudotime_s: None,
                    max_physical_time_s: None,
                },
            });
        }
        let executed = ExecutedRun {
            result: RunResult {
                status: RunStatus::Completed,
                steps: vec![StepStats {
                    step: 4,
                    e_ex: 1.0,
                    e_demag: 2.0,
                    e_total: 3.0,
                    max_torque_Apm: 2.0e-4,
                    ..StepStats::default()
                }],
                final_magnetization: vec![[1.0, 0.0, 0.0]; 4],
                completion: None,
            },
            initial_magnetization: vec![[1.0, 0.0, 0.0]; 4],
            field_snapshots: Vec::new(),
            field_snapshot_count: 0,
            auxiliary_artifacts: Vec::new(),
            provenance: ExecutionProvenance {
                execution_engine: "fem_native_gpu".to_string(),
                precision: "double".to_string(),
                requested_integrator: Some("heun".to_string()),
                resolved_integrator: Some("heun".to_string()),
                requested_energy_minimizer: Some("llg_overdamped".to_string()),
                resolved_energy_minimizer: Some("llg_overdamped".to_string()),
                energy_minimizer_realization: Some("native_llg_time_integrator".to_string()),
                llg_mode: Some("pure_damping".to_string()),
                fem_execution_mode: Some("all_in_gpu_legacy_sparse".to_string()),
                fem_gpu_qualification_status: Some("production_executable".to_string()),
                fem_exchange_operator_mode: Some("legacy_sparse_gpu".to_string()),
                fem_data_residency: Some("device_source_of_truth".to_string()),
                uses_cuda_kernels: Some(true),
                uses_gpu_poisson: Some(true),
                fem_demag_operator_mode: Some("device_hypre_poisson".to_string()),
                hot_loop_exchange_host_sync_count: Some(0),
                hot_loop_compute_host_sync_count: Some(3),
                hot_loop_control_scalar_d2h_bytes: Some(0),
                hot_loop_control_scalar_host_sync_count: Some(0),
                ..ExecutionProvenance::default()
            },
        };
        let unique_suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-artifacts-fem-gpu-llg-relax-{}-{}",
            std::process::id(),
            unique_suffix
        ));

        write_artifacts(&output_dir, &problem, &gpu_plan, &executed, None)
            .expect("GPU LLG relaxation metadata artifacts should be written");
        let metadata: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(output_dir.join("metadata.json")).expect("metadata should exist"),
        )
        .expect("metadata should parse");
        let qualification = &metadata["fem_gpu_relaxation_qualification"];
        assert_eq!(
            qualification["schema_version"],
            "fem_gpu_relaxation_qualification.v1"
        );
        assert_eq!(qualification["relaxation_algorithm"], "llg_overdamped");
        assert_eq!(
            qualification["algorithm_policy"]["realization"],
            "native_llg_time_integrator"
        );
        assert_eq!(qualification["algorithm_policy"]["time_integrator"], "heun");
        assert_eq!(
            qualification["algorithm_policy"]["precession_policy"],
            "disabled_pure_damping"
        );
        assert_eq!(
            qualification["algorithm_policy"]["rhs_policy"],
            "llg_overdamped_rhs"
        );

        let cpu_plan = gpu_plan.clone();
        let cpu_provenance = ExecutionProvenance {
            execution_engine: "fem_cpu_native".to_string(),
            precision: "double".to_string(),
            requested_integrator: Some("heun".to_string()),
            resolved_integrator: Some("heun".to_string()),
            requested_energy_minimizer: Some("llg_overdamped".to_string()),
            resolved_energy_minimizer: Some("llg_overdamped".to_string()),
            energy_minimizer_realization: Some("native_llg_time_integrator".to_string()),
            llg_mode: Some("pure_damping".to_string()),
            fem_assembly_mode: Some("legacy_sparse".to_string()),
            fem_gpu_qualification_status: Some("production_executable".to_string()),
            ..ExecutionProvenance::default()
        };
        let demag_runtime =
            demag_runtime_metadata(&cpu_plan, &cpu_provenance, &executed.result.steps);
        let cpu_executed = ExecutedRun {
            provenance: cpu_provenance.clone(),
            ..executed.clone()
        };
        let cpu_qualification = fem_cpu_relaxation_qualification_metadata(
            &cpu_plan,
            &cpu_provenance,
            &demag_runtime,
            &cpu_executed,
        );
        assert_eq!(cpu_qualification["relaxation_algorithm"], "llg_overdamped");
        assert_eq!(
            cpu_qualification["algorithm_policy"]["realization"],
            "native_llg_time_integrator"
        );
        assert_eq!(
            cpu_qualification["algorithm_policy"]["precession_policy"],
            "disabled_pure_damping"
        );

        fs::remove_dir_all(output_dir).expect("temporary artifact directory should be removable");
    }

    #[test]
    fn fem_cpu_relaxation_qualification_metadata_reports_cubic_anisotropy_term() {
        let mut plan = test_fem_execution_plan();
        if let BackendPlanIR::Fem(fem) = &mut plan.backend_plan {
            fem.enable_demag = true;
            fem.demag_realization = Some(fullmag_ir::ResolvedFemDemagIR::PoissonRobin);
            fem.material.cubic_anisotropy_kc1 = Some(4.8e4);
            fem.material.cubic_anisotropy_axis1 = Some([1.0, 0.0, 0.0]);
            fem.material.cubic_anisotropy_axis2 = Some([0.0, 1.0, 0.0]);
        }
        let provenance = ExecutionProvenance {
            execution_engine: "fem_cpu_native".to_string(),
            precision: "double".to_string(),
            mfem_device: Some("cpu".to_string()),
            fem_assembly_mode: Some("legacy_sparse".to_string()),
            fem_execution_mode: Some("cpu_native".to_string()),
            fem_data_residency: Some("host_source_of_truth".to_string()),
            uses_cuda_kernels: Some(false),
            uses_gpu_poisson: Some(false),
            ..ExecutionProvenance::default()
        };
        let executed = ExecutedRun {
            result: RunResult {
                status: RunStatus::Completed,
                steps: vec![StepStats {
                    step: 2,
                    e_ex: 1.0,
                    e_demag: 2.0,
                    e_ani: 3.0,
                    e_total: 6.0,
                    demag_solver_setup_reused: true,
                    poisson_iterations: 8,
                    poisson_final_residual: 5.0e-9,
                    ..StepStats::default()
                }],
                final_magnetization: vec![[1.0, 0.0, 0.0]; 4],
                completion: None,
            },
            initial_magnetization: vec![[1.0, 0.0, 0.0]; 4],
            field_snapshots: Vec::new(),
            field_snapshot_count: 0,
            auxiliary_artifacts: Vec::new(),
            provenance: provenance.clone(),
        };
        let demag_runtime = demag_runtime_metadata(&plan, &provenance, &executed.result.steps);

        let metadata = fem_cpu_relaxation_qualification_metadata(
            &plan,
            &provenance,
            &demag_runtime,
            &executed,
        );

        assert_eq!(
            metadata["physics_terms"],
            serde_json::json!(["exchange", "demag", "anisotropy_cubic"])
        );
    }

    #[test]
    fn fdm_field_layout_reports_active_mask_counts() {
        let layout = field_layout(&test_execution_plan(Some(vec![
            true, true, false, false, true, false, true, false,
        ])));
        assert_eq!(layout["backend"], "fdm");
        assert_eq!(layout["total_cell_count"], 8);
        assert_eq!(layout["active_mask_present"], true);
        assert_eq!(layout["active_cell_count"], 4);
        assert_eq!(layout["inactive_cell_count"], 4);
        assert_eq!(layout["active_fraction"], serde_json::json!(0.5));
    }

    #[test]
    fn fdm_field_layout_defaults_to_full_domain_without_mask() {
        let layout = field_layout(&test_execution_plan(None));
        assert_eq!(layout["active_mask_present"], false);
        assert_eq!(layout["active_cell_count"], 8);
        assert_eq!(layout["inactive_cell_count"], 0);
        assert_eq!(layout["active_fraction"], serde_json::json!(1.0));
    }

    #[test]
    fn fem_prescribed_current_transport_artifact_uses_solve_region_nodes() {
        let mut problem = fullmag_ir::ProblemIR::bootstrap_example();
        problem
            .current_modules
            .push(fullmag_ir::CurrentModuleIR::CurrentTransport {
                name: "drive".to_string(),
                model: fullmag_ir::CurrentTransportModelIR::PrescribedDensity,
                current_density: Some([0.0, 0.0, 5e10]),
                solve_region: Some("pillar_region".to_string()),
                conductivity_s_per_m: None,
            });
        problem.regions = vec![fullmag_ir::RegionIR {
            name: "pillar_region".to_string(),
            geometry: "pillar".to_string(),
        }];
        let plan = test_fem_execution_plan();
        let context = build_field_context(&problem, &plan);
        let provenance = crate::types::ExecutionProvenance {
            execution_engine: "fem_cpu_native".to_string(),
            precision: "double".to_string(),
            demag_operator_kind: None,
            fft_backend: None,
            device_name: None,
            compute_capability: None,
            cuda_driver_version: None,
            cuda_runtime_version: None,
            lossy_fallback_used: false,
            ignored_terms: Vec::new(),
            random_seed: None,
            resolved_fallback: None,
            requested_integrator: None,
            resolved_integrator: None,
            requested_energy_minimizer: None,
            resolved_energy_minimizer: None,
            energy_minimizer_realization: None,
            requested_demag_realization: None,
            resolved_demag_realization: None,
            dt_policy: None,
            llg_mode: None,
            mfem_device: None,
            demag_refresh_interval_s: None,
            fem_assembly_mode: None,
            fem_execution_mode: None,
            fem_gpu_qualification_status: None,
            fem_exchange_operator_mode: None,
            fem_data_residency: None,
            uses_cuda_kernels: None,
            uses_gpu_poisson: None,
            fem_demag_operator_mode: None,
            hypre_execution_policy: None,
            demag_residency: None,
            hot_loop_host_sync_count: None,
            hot_loop_exchange_h2d_bytes: None,
            hot_loop_exchange_d2h_bytes: None,
            hot_loop_exchange_host_sync_count: None,
            hot_loop_compute_h2d_bytes: None,
            hot_loop_compute_d2h_bytes: None,
            hot_loop_compute_host_sync_count: None,
            hot_loop_control_scalar_d2h_bytes: None,
            hot_loop_control_scalar_host_sync_count: None,
            fem_gpu_state_allocated: None,
            fem_gpu_state_node_count: None,
            fem_gpu_state_dof_len: None,
            fem_gpu_state_stage_count: None,
            fem_gpu_state_device_bytes: None,
            fem_gpu_state_reduction_workspace_bytes: None,
            fem_gpu_rk_exchange_only_enabled: None,
            fem_gpu_rk_stage_count: None,
            fem_gpu_rk_uses_cuda_kernels: None,
            fem_gpu_rk_allows_exchange_host_sync: None,
            fem_gpu_rk_stage_exchange_device_resident: None,
            fem_gpu_rk_block_reason: None,
            requested_cpu_threads: None,
            resolved_cpu_threads: None,
            requested_fem_omp_threads: None,
            effective_fem_omp_threads: None,
            fem_poisson_demag: None,
        };
        let unique_suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-artifacts-fem-current-transport-{}-{}",
            std::process::id(),
            unique_suffix
        ));

        write_prescribed_current_transport_artifacts(
            &output_dir,
            &problem,
            &plan,
            &context,
            &provenance,
        )
        .expect("fem current transport artifact should be written");

        let artifact: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(output_dir.join("current_transport/drive.json"))
                .expect("artifact should exist"),
        )
        .expect("artifact should parse");
        assert_eq!(artifact["coverage"], "solve_region_nodes");
        assert_eq!(artifact["layout"]["backend"], "fem");
        let values = artifact["values"].as_array().expect("values should exist");
        assert_eq!(values.len(), 4);
        assert_eq!(values[0], serde_json::json!([0.0, 0.0, 5e10]));

        fs::remove_dir_all(output_dir).expect("temporary artifact directory should be removable");
    }

    #[test]
    fn fem_prescribed_current_transport_artifact_uses_mesh_part_node_indices() {
        let mut problem = fullmag_ir::ProblemIR::bootstrap_example();
        problem
            .current_modules
            .push(fullmag_ir::CurrentModuleIR::CurrentTransport {
                name: "drive".to_string(),
                model: fullmag_ir::CurrentTransportModelIR::PrescribedDensity,
                current_density: Some([0.0, 0.0, 5e10]),
                solve_region: Some("pillar_region".to_string()),
                conductivity_s_per_m: None,
            });
        problem.regions = vec![fullmag_ir::RegionIR {
            name: "pillar_region".to_string(),
            geometry: "pillar".to_string(),
        }];
        let mut plan = test_fem_execution_plan();
        let BackendPlanIR::Fem(fem) = &mut plan.backend_plan else {
            panic!("test plan must be FEM");
        };
        fem.mesh.nodes = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [1.0, 1.0, 0.0],
            [1.0, 0.0, 1.0],
        ];
        fem.mesh.elements = vec![[1, 3, 5, 4]];
        fem.mesh.boundary_faces = vec![[1, 3, 5]];
        fem.initial_magnetization = vec![[1.0, 0.0, 0.0]; 6];
        fem.object_segments[0].node_start = 0;
        fem.object_segments[0].node_count = 3;
        fem.mesh_parts = vec![FemMeshPartIR {
            id: "free".to_string(),
            label: "free".to_string(),
            role: FemMeshPartRole::MagneticObject,
            object_id: Some("free".to_string()),
            geometry_id: Some("pillar".to_string()),
            material_id: None,
            element_selector: FemMeshPartSelector::ElementRange { start: 0, count: 1 },
            boundary_face_selector: FemMeshPartSelector::BoundaryFaceRange { start: 0, count: 1 },
            node_selector: FemMeshPartSelector::NodeRange { start: 0, count: 3 },
            boundary_face_indices: vec![0],
            node_indices: vec![1, 3, 4, 5],
            surface_faces: vec![[1, 3, 5]],
            bounds_min: Some([0.0, 0.0, 0.0]),
            bounds_max: Some([1.0, 1.0, 1.0]),
            parent_id: None,
        }];
        let context = build_field_context(&problem, &plan);
        let provenance = crate::types::ExecutionProvenance {
            execution_engine: "fem_cpu_native".to_string(),
            precision: "double".to_string(),
            ..Default::default()
        };
        let unique_suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-artifacts-fem-current-transport-indices-{}-{}",
            std::process::id(),
            unique_suffix
        ));

        write_prescribed_current_transport_artifacts(
            &output_dir,
            &problem,
            &plan,
            &context,
            &provenance,
        )
        .expect("fem current transport artifact should be written");

        let artifact: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(output_dir.join("current_transport/drive.json"))
                .expect("artifact should exist"),
        )
        .expect("artifact should parse");
        let values = artifact["values"].as_array().expect("values should exist");
        assert_eq!(values.len(), 6);
        assert_eq!(values[0], serde_json::json!([0.0, 0.0, 0.0]));
        assert_eq!(values[1], serde_json::json!([0.0, 0.0, 5e10]));
        assert_eq!(values[2], serde_json::json!([0.0, 0.0, 0.0]));
        assert_eq!(values[3], serde_json::json!([0.0, 0.0, 5e10]));
        assert_eq!(values[4], serde_json::json!([0.0, 0.0, 5e10]));
        assert_eq!(values[5], serde_json::json!([0.0, 0.0, 5e10]));

        fs::remove_dir_all(output_dir).expect("temporary artifact directory should be removable");
    }

    #[test]
    fn periodic_pairs_artifact_reports_pair_diagnostics() {
        let mut plan = test_fem_execution_plan();
        let BackendPlanIR::Fem(fem) = &mut plan.backend_plan else {
            panic!("test plan must be FEM");
        };
        fem.mesh.nodes = vec![
            [0.0, 0.0, 0.0],
            [1.0e-6, 0.0, 0.0],
            [0.0, 1.0e-6, 0.0],
            [1.0e-6, 1.0e-6, 0.0],
            [0.0, 0.0, 1.0e-6],
            [1.0e-6, 0.0, 1.0e-6],
        ];
        fem.mesh.boundary_faces = vec![[0, 2, 4], [1, 3, 5]];
        fem.mesh.boundary_markers = vec![10, 11];
        fem.mesh.periodic_boundary_pairs = vec![fullmag_ir::MeshPeriodicBoundaryPairIR {
            pair_id: "x_periodic".to_string(),
            source_marker: Some("x_min".to_string()),
            destination_marker: Some("x_max".to_string()),
            marker_a: 10,
            marker_b: 11,
            translation: Some([1.0e-6, 0.0, 0.0]),
            tolerance: Some(1.0e-12),
            axis_hint: Some("x".to_string()),
            orientation: Some("same".to_string()),
            pairing_policy: Some("nearest".to_string()),
        }];
        fem.mesh.periodic_node_pairs = vec![
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "x_periodic".to_string(),
                node_a: 0,
                node_b: 1,
            },
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "x_periodic".to_string(),
                node_a: 2,
                node_b: 3,
            },
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "x_periodic".to_string(),
                node_a: 4,
                node_b: 5,
            },
        ];

        let unique_suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-artifacts-periodic-pairs-{}-{}",
            std::process::id(),
            unique_suffix
        ));

        write_periodic_pairs_artifact(&output_dir, &plan)
            .expect("periodic pairs artifact should be written");

        let artifact: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(output_dir.join("mesh/periodic_pairs.v1.json"))
                .expect("periodic pairs artifact should exist"),
        )
        .expect("periodic pairs artifact should parse");
        assert_eq!(artifact["schema_version"], "periodic_pairs.v1");
        assert_eq!(artifact["pairs"][0]["pair_id"], "x_periodic");
        assert_eq!(artifact["pairs"][0]["paired_node_count"], 3);
        assert_eq!(artifact["pairs"][0]["unpaired_source_node_count"], 0);
        assert_eq!(artifact["pairs"][0]["unpaired_destination_node_count"], 0);
        assert_eq!(artifact["pairs"][0]["max_residual_m"], 0.0);
        assert_eq!(artifact["pairs"][0]["status"], "valid");

        fs::remove_dir_all(output_dir).expect("temporary artifact directory should be removable");
    }

    #[test]
    fn periodic_pairs_artifact_supports_fem_frequency_response_plan() {
        let mut base_plan = test_fem_execution_plan();
        let BackendPlanIR::Fem(fem) = &mut base_plan.backend_plan else {
            panic!("test plan must be FEM");
        };
        fem.mesh.nodes = vec![
            [0.0, 0.0, 0.0],
            [40.0e-9, 0.0, 0.0],
            [40.0e-9, 20.0e-9, 0.0],
            [0.0, 20.0e-9, 0.0],
            [0.0, 0.0, 10.0e-9],
            [40.0e-9, 0.0, 10.0e-9],
            [40.0e-9, 20.0e-9, 10.0e-9],
            [0.0, 20.0e-9, 10.0e-9],
        ];
        fem.mesh.boundary_faces = vec![[0, 3, 7], [1, 5, 6]];
        fem.mesh.boundary_markers = vec![10, 11];
        fem.mesh.periodic_boundary_pairs = vec![fullmag_ir::MeshPeriodicBoundaryPairIR {
            pair_id: "x_faces".to_string(),
            source_marker: Some("x_min".to_string()),
            destination_marker: Some("x_max".to_string()),
            marker_a: 10,
            marker_b: 11,
            translation: Some([40.0e-9, 0.0, 0.0]),
            tolerance: Some(1.0e-12),
            axis_hint: Some("x".to_string()),
            orientation: Some("same".to_string()),
            pairing_policy: Some("explicit_node_pairs".to_string()),
        }];
        fem.mesh.periodic_node_pairs = vec![
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "x_faces".to_string(),
                node_a: 0,
                node_b: 1,
            },
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "x_faces".to_string(),
                node_a: 3,
                node_b: 2,
            },
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "x_faces".to_string(),
                node_a: 4,
                node_b: 5,
            },
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "x_faces".to_string(),
                node_a: 7,
                node_b: 6,
            },
        ];

        let common = base_plan.common;
        let output_plan = base_plan.output_plan;
        let provenance = base_plan.provenance;
        let BackendPlanIR::Fem(fem) = base_plan.backend_plan else {
            panic!("test plan must be FEM");
        };
        let plan = ExecutionPlanIR {
            common,
            backend_plan: BackendPlanIR::FemFrequencyResponse(
                fullmag_ir::FemFrequencyResponsePlanIR {
                    mesh_name: fem.mesh_name,
                    mesh_source: fem.mesh_source,
                    mesh: fem.mesh,
                    object_segments: fem.object_segments,
                    mesh_parts: fem.mesh_parts,
                    domain_mesh_mode: fem.domain_mesh_mode,
                    domain_frame: fem.domain_frame,
                    fe_order: fem.fe_order,
                    hmax: fem.hmax,
                    equilibrium_magnetization: fem.initial_magnetization,
                    material: fem.material,
                    operator: fullmag_ir::EigenOperatorConfigIR {
                        kind: fullmag_ir::EigenOperatorIR::LinearizedLlg,
                        include_demag: false,
                    },
                    equilibrium: fullmag_ir::EquilibriumSourceIR::Provided,
                    k_sampling: None,
                    normalization: fullmag_ir::FrequencyResponseNormalizationIR::UnitMaxAmplitude,
                    damping_policy: fullmag_ir::EigenDampingPolicyIR::Include,
                    spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::Config(
                        fullmag_ir::SpinWaveBoundaryConfigIR {
                            kind: fullmag_ir::SpinWaveBoundaryKindIR::Periodic,
                            boundary_pair_id: Some("x_faces".to_string()),
                            pair_ids: Vec::new(),
                            phase_convention: fullmag_ir::PhaseConventionIR::default(),
                            surface_anisotropy_ks: None,
                            surface_anisotropy_axis: None,
                        },
                    ),
                    excitation: fullmag_ir::FrequencyExcitationIR {
                        field_au_per_m: [0.0, 0.0, 1.0],
                        phase_rad: 0.0,
                    },
                    frequencies_hz: fullmag_ir::FrequencySweepIR {
                        values_hz: vec![1.0e9, 2.0e9],
                    },
                    enable_exchange: fem.enable_exchange,
                    enable_demag: fem.enable_demag,
                    interfacial_dmi: fem.interfacial_dmi,
                    dmi_interface_normal: fem.dmi_interface_normal,
                    bulk_dmi: fem.bulk_dmi,
                    external_field: fem.external_field,
                    gyromagnetic_ratio: fem.gyromagnetic_ratio,
                    precision: fem.precision,
                    exchange_bc: fem.exchange_bc,
                    demag_realization: fem.demag_realization,
                },
            ),
            output_plan,
            provenance,
        };

        let unique_suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-artifacts-frequency-response-periodic-pairs-{}-{}",
            std::process::id(),
            unique_suffix
        ));

        write_periodic_pairs_artifact(&output_dir, &plan)
            .expect("frequency-response periodic pairs artifact should be written");

        let artifact: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(output_dir.join("mesh/periodic_pairs.v1.json"))
                .expect("periodic pairs artifact should exist"),
        )
        .expect("periodic pairs artifact should parse");
        assert_eq!(artifact["schema_version"], "periodic_pairs.v1");
        assert_eq!(artifact["pairs"][0]["pair_id"], "x_faces");
        assert_eq!(artifact["pairs"][0]["paired_node_count"], 4);
        assert_eq!(artifact["pairs"][0]["status"], "valid");

        fs::remove_dir_all(output_dir).expect("temporary artifact directory should be removable");
    }

    #[test]
    fn write_artifacts_persists_h_oe_field_snapshot() {
        let problem = fullmag_ir::ProblemIR::bootstrap_example();
        let plan = test_execution_plan(Some(vec![
            true, true, false, false, true, false, true, false,
        ]));
        let provenance = ExecutionProvenance {
            execution_engine: "fdm_gpu_native".to_string(),
            precision: "double".to_string(),
            demag_operator_kind: None,
            fft_backend: None,
            device_name: Some("test-gpu".to_string()),
            compute_capability: Some("9.0".to_string()),
            cuda_driver_version: Some(12040),
            cuda_runtime_version: Some(12040),
            lossy_fallback_used: false,
            ignored_terms: Vec::new(),
            random_seed: None,
            resolved_fallback: None,
            requested_integrator: None,
            resolved_integrator: None,
            requested_energy_minimizer: None,
            resolved_energy_minimizer: None,
            energy_minimizer_realization: None,
            requested_demag_realization: None,
            resolved_demag_realization: None,
            dt_policy: None,
            llg_mode: None,
            mfem_device: None,
            demag_refresh_interval_s: None,
            fem_assembly_mode: None,
            fem_execution_mode: None,
            fem_gpu_qualification_status: None,
            fem_exchange_operator_mode: None,
            fem_data_residency: None,
            uses_cuda_kernels: None,
            uses_gpu_poisson: None,
            fem_demag_operator_mode: None,
            hypre_execution_policy: None,
            demag_residency: None,
            hot_loop_host_sync_count: None,
            hot_loop_exchange_h2d_bytes: None,
            hot_loop_exchange_d2h_bytes: None,
            hot_loop_exchange_host_sync_count: None,
            hot_loop_compute_h2d_bytes: None,
            hot_loop_compute_d2h_bytes: None,
            hot_loop_compute_host_sync_count: None,
            hot_loop_control_scalar_d2h_bytes: None,
            hot_loop_control_scalar_host_sync_count: None,
            fem_gpu_state_allocated: None,
            fem_gpu_state_node_count: None,
            fem_gpu_state_dof_len: None,
            fem_gpu_state_stage_count: None,
            fem_gpu_state_device_bytes: None,
            fem_gpu_state_reduction_workspace_bytes: None,
            fem_gpu_rk_exchange_only_enabled: None,
            fem_gpu_rk_stage_count: None,
            fem_gpu_rk_uses_cuda_kernels: None,
            fem_gpu_rk_allows_exchange_host_sync: None,
            fem_gpu_rk_stage_exchange_device_resident: None,
            fem_gpu_rk_block_reason: None,
            requested_cpu_threads: None,
            resolved_cpu_threads: None,
            requested_fem_omp_threads: None,
            effective_fem_omp_threads: None,
            fem_poisson_demag: None,
        };
        let unique_suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-artifacts-h-oe-{}-{}",
            std::process::id(),
            unique_suffix
        ));

        let executed = ExecutedRun {
            result: RunResult {
                status: RunStatus::Completed,
                steps: vec![StepStats {
                    step: 1,
                    time: 1.0e-13,
                    dt: 1.0e-13,
                    ..StepStats::default()
                }],
                final_magnetization: vec![[1.0, 0.0, 0.0]; 8],
                completion: None,
            },
            initial_magnetization: vec![[1.0, 0.0, 0.0]; 8],
            field_snapshots: vec![FieldSnapshot {
                name: "H_OE".to_string(),
                step: 1,
                time: 1.0e-13,
                solver_dt: 1.0e-13,
                values: vec![
                    [0.0, 0.0, 1.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 0.0],
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 0.0, 0.0],
                    [-1.0, 0.0, 0.0],
                    [0.0, 0.0, 0.0],
                ],
            }],
            field_snapshot_count: 1,
            auxiliary_artifacts: Vec::new(),
            provenance,
        };

        write_artifacts(&output_dir, &problem, &plan, &executed, None)
            .expect("H_OE artifact write should succeed");

        let field_json: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(output_dir.join("fields/H_OE/step_000001.json"))
                .expect("H_OE artifact should exist"),
        )
        .expect("H_OE artifact should parse");
        assert_eq!(field_json["observable"], "H_OE");
        assert_eq!(field_json["unit"], "A/m");
        assert_eq!(field_json["step"], 1);
        assert_eq!(field_json["layout"]["backend"], "fdm");
        assert_eq!(field_json["values"][0], serde_json::json!([0.0, 0.0, 1.0]));
        assert_eq!(field_json["values"][6], serde_json::json!([-1.0, 0.0, 0.0]));

        let metadata: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(output_dir.join("metadata.json")).expect("metadata should exist"),
        )
        .expect("metadata should parse");
        assert_eq!(metadata["field_snapshots"], 1);

        fs::remove_dir_all(output_dir).expect("temporary artifact directory should be removable");
    }

    #[test]
    fn fdm_field_component_snapshots_use_base_observable_units() {
        let problem = fullmag_ir::ProblemIR::bootstrap_example();
        let plan = test_execution_plan(None);
        let unique_suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-artifacts-fdm-components-{}-{}",
            std::process::id(),
            unique_suffix
        ));

        let executed = ExecutedRun {
            result: RunResult {
                status: RunStatus::Completed,
                steps: vec![StepStats {
                    step: 1,
                    time: 1.0e-13,
                    dt: 1.0e-13,
                    ..StepStats::default()
                }],
                final_magnetization: vec![[1.0, 0.0, 0.0]; 8],
                completion: None,
            },
            initial_magnetization: vec![[1.0, 0.0, 0.0]; 8],
            field_snapshots: vec![
                FieldSnapshot {
                    name: "m.x".to_string(),
                    step: 1,
                    time: 1.0e-13,
                    solver_dt: 1.0e-13,
                    values: vec![[1.0, 0.0, 0.0]; 8],
                },
                FieldSnapshot {
                    name: "H_eff.z".to_string(),
                    step: 1,
                    time: 1.0e-13,
                    solver_dt: 1.0e-13,
                    values: vec![[5.0, 0.0, 0.0]; 8],
                },
                FieldSnapshot {
                    name: "torque".to_string(),
                    step: 1,
                    time: 1.0e-13,
                    solver_dt: 1.0e-13,
                    values: vec![[0.0, 0.0, 2.0e-3]; 8],
                },
            ],
            field_snapshot_count: 3,
            auxiliary_artifacts: Vec::new(),
            provenance: ExecutionProvenance {
                execution_engine: "cpu_reference".to_string(),
                precision: "double".to_string(),
                ..ExecutionProvenance::default()
            },
        };

        write_artifacts(&output_dir, &problem, &plan, &executed, None)
            .expect("component artifacts should be written");

        let m_x: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(output_dir.join("fields/m.x/step_000001.json"))
                .expect("m.x artifact should exist"),
        )
        .expect("m.x artifact should parse");
        assert_eq!(m_x["unit"], "dimensionless");

        let h_eff_z: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(output_dir.join("fields/H_eff.z/step_000001.json"))
                .expect("H_eff.z artifact should exist"),
        )
        .expect("H_eff.z artifact should parse");
        assert_eq!(h_eff_z["unit"], "A/m");

        let torque: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(output_dir.join("fields/torque/step_000001.json"))
                .expect("torque artifact should exist"),
        )
        .expect("torque artifact should parse");
        assert_eq!(torque["unit"], "T");

        fs::remove_dir_all(output_dir).expect("temporary artifact directory should be removable");
    }

    #[test]
    fn fdm_multilayer_field_snapshots_are_written_per_layer() {
        let problem = fullmag_ir::ProblemIR::bootstrap_example();
        let plan = test_multilayer_execution_plan();
        let unique_suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-artifacts-fdm-multilayer-fields-{}-{}",
            std::process::id(),
            unique_suffix
        ));

        let executed = ExecutedRun {
            result: RunResult {
                status: RunStatus::Completed,
                steps: vec![StepStats {
                    step: 1,
                    time: 1.0e-13,
                    dt: 1.0e-13,
                    ..StepStats::default()
                }],
                final_magnetization: vec![
                    [1.0, 0.0, 0.0],
                    [0.9, 0.1, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.9, 0.1],
                ],
                completion: None,
            },
            initial_magnetization: vec![
                [1.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 1.0, 0.0],
            ],
            field_snapshots: vec![FieldSnapshot {
                name: "m".to_string(),
                step: 1,
                time: 1.0e-13,
                solver_dt: 1.0e-13,
                values: vec![
                    [1.0, 0.0, 0.0],
                    [0.9, 0.1, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.9, 0.1],
                ],
            }],
            field_snapshot_count: 1,
            auxiliary_artifacts: Vec::new(),
            provenance: ExecutionProvenance {
                execution_engine: "cuda_assisted_multilayer".to_string(),
                precision: "double".to_string(),
                ..ExecutionProvenance::default()
            },
        };

        write_artifacts(&output_dir, &problem, &plan, &executed, None)
            .expect("multilayer artifact write should succeed");

        let manifest: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(output_dir.join("fields/m/manifest.json"))
                .expect("multilayer field manifest should exist"),
        )
        .expect("multilayer field manifest should parse");
        assert_eq!(
            manifest["schema_version"],
            "fdm_multilayer_field_manifest.v1"
        );
        assert_eq!(manifest["observable"], "m");
        assert_eq!(manifest["storage_layout"], "per_layer_json");
        assert_eq!(manifest["layers"][0]["id"], "bottom");
        assert_eq!(manifest["layers"][0]["directory"], "layer-bottom");
        assert_eq!(manifest["layers"][0]["value_offset"], 0);
        assert_eq!(manifest["layers"][0]["value_count"], 2);
        assert_eq!(
            manifest["layers"][0]["native_origin"],
            serde_json::json!([0.0, 0.0, 0.0])
        );
        assert_eq!(manifest["layers"][1]["id"], "top");
        assert_eq!(manifest["layers"][1]["directory"], "layer-top");
        assert_eq!(manifest["layers"][1]["value_offset"], 2);
        assert_eq!(manifest["layers"][1]["value_count"], 2);
        assert_eq!(
            manifest["layers"][1]["native_origin"],
            serde_json::json!([0.0, 0.0, 4e-9])
        );

        let bottom: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(output_dir.join("fields/m/layer-bottom/step_000001.json"))
                .expect("bottom layer field snapshot should exist"),
        )
        .expect("bottom layer snapshot should parse");
        assert_eq!(bottom["layer"]["id"], "bottom");
        assert_eq!(bottom["values"].as_array().expect("values").len(), 2);
        assert_eq!(bottom["values"][0], serde_json::json!([1.0, 0.0, 0.0]));
        assert_eq!(bottom["values"][1], serde_json::json!([0.9, 0.1, 0.0]));

        let top: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(output_dir.join("fields/m/layer-top/step_000001.json"))
                .expect("top layer field snapshot should exist"),
        )
        .expect("top layer snapshot should parse");
        assert_eq!(top["layer"]["id"], "top");
        assert_eq!(top["values"].as_array().expect("values").len(), 2);
        assert_eq!(top["values"][0], serde_json::json!([0.0, 1.0, 0.0]));
        assert_eq!(top["values"][1], serde_json::json!([0.0, 0.9, 0.1]));

        fs::remove_dir_all(output_dir).expect("temporary artifact directory should be removable");
    }
}
