//! Artifact writing: metadata, scalars CSV, field snapshots.

use crate::artifact_pipeline::ArtifactPipelineSummary;
use crate::dispatch::{
    effective_fem_device_request, requested_registry_device_for_fdm, runtime_device,
    runtime_precision,
};
use fullmag_ir::BackendPlanIR;
use sha2::{Digest, Sha256};

use crate::types::{
    ExecutedRun, FemCpuRelaxationAlgorithmPolicyMetadata, FemCpuRelaxationDemagPolicyMetadata,
    FemCpuRelaxationDemagTimingsNs, FemCpuRelaxationEnergyTerms,
    FemCpuRelaxationQualificationMetadata, FemGpuRelaxationAlgorithmPolicyMetadata,
    FemGpuRelaxationDevicePolicyMetadata, FemGpuRelaxationQualificationMetadata, StepStats,
};

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::io::{Error, ErrorKind, Write};
use std::path::Path;

const MU0_H_PER_M: f64 = 1.256_637_062_12e-6;

fn runtime_threading_summary(problem: &fullmag_ir::ProblemIR) -> serde_json::Value {
    let resolved_cpu_threads = u32::try_from(crate::configured_cpu_threads(problem)).ok();
    serde_json::json!({
        "requested_cpu_threads": crate::requested_cpu_threads(problem),
        "resolved_cpu_threads": resolved_cpu_threads,
        "requested_fem_omp_threads": serde_json::Value::Null,
        "effective_fem_omp_threads": serde_json::Value::Null,
    })
}

fn region_realization_revisions_metadata(problem: &fullmag_ir::ProblemIR) -> serde_json::Value {
    problem
        .problem_meta
        .runtime_metadata
        .get("region_realization_revisions")
        .cloned()
        .unwrap_or(serde_json::Value::Null)
}

fn requested_execution_metadata(problem: &fullmag_ir::ProblemIR) -> serde_json::Value {
    let backend = match problem.backend_policy.requested_backend {
        fullmag_ir::BackendTarget::Auto => "auto",
        fullmag_ir::BackendTarget::Fdm => "fdm",
        fullmag_ir::BackendTarget::Fem => "fem",
        fullmag_ir::BackendTarget::Hybrid => "hybrid",
    };
    let device = match backend {
        "fem" => effective_fem_device_request(problem),
        "fdm" => requested_registry_device_for_fdm(problem),
        _ => runtime_device(problem)
            .unwrap_or("auto")
            .replace("cuda", "gpu"),
    };
    let mode = match problem.validation_profile.execution_mode {
        fullmag_ir::ExecutionMode::Strict => "strict",
        fullmag_ir::ExecutionMode::Extended => "extended",
        fullmag_ir::ExecutionMode::Hybrid => "hybrid",
    };
    serde_json::json!({
        "backend": backend,
        "device": device,
        "precision": runtime_precision(problem),
        "mode": mode,
        "fallback_policy": if mode == "strict" { "forbidden" } else { "allowed" },
    })
}

fn count_periodic_pairs_by_id<T>(
    pairs: &[T],
    pair_id: impl Fn(&T) -> &str,
) -> BTreeMap<String, usize> {
    let mut counts = BTreeMap::new();
    for pair in pairs {
        *counts.entry(pair_id(pair).to_string()).or_insert(0) += 1;
    }
    counts
}

fn mesh_runtime_metadata(plan: &fullmag_ir::ExecutionPlanIR) -> serde_json::Value {
    match &plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => serde_json::json!({
            "backend": "fdm",
            "requested_periodicity": fdm.periodicity,
            "resolved_demag_boundary": fdm
                .periodicity
                .as_ref()
                .and_then(|pbc| pbc.resolve_demag_boundary(fdm.enable_demag).ok()),
            "resolved_periodic_images": fdm
                .resolved_periodic_images,
            "region_legend": fdm.grid_certificate.as_ref().map(|certificate| &certificate.region_legend),
            "region_legend_fingerprint": fdm
                .grid_certificate
                .as_ref()
                .and_then(|certificate| certificate.region_legend_fingerprint.as_deref()),
            "grid_cells": fdm.grid.cells,
        }),
        BackendPlanIR::FdmMultilayer(fdm) => serde_json::json!({
            "backend": "fdm_multilayer",
            "requested_periodicity": fdm.periodicity,
            "resolved_demag_boundary": fdm
                .periodicity
                .as_ref()
                .and_then(|pbc| pbc.resolve_demag_boundary(fdm.enable_demag).ok()),
            "resolved_periodic_images": fdm
                .resolved_periodic_images,
            "region_legend": fdm.grid_certificate.as_ref().map(|certificate| &certificate.region_legend),
            "region_legend_fingerprint": fdm
                .grid_certificate
                .as_ref()
                .and_then(|certificate| certificate.region_legend_fingerprint.as_deref()),
            "transfer_boundary_policy": fdm
                .periodicity
                .as_ref()
                .map(|pbc| {
                    pbc.axes.map(|axis| match axis {
                        fullmag_ir::AxisBoundary::Periodic => "periodic",
                        fullmag_ir::AxisBoundary::Open => "open",
                    })
                })
                .unwrap_or(["open"; 3]),
            "periodic_axes": fdm
                .periodicity
                .as_ref()
                .map(|pbc| {
                    pbc.axes.map(|axis| matches!(axis, fullmag_ir::AxisBoundary::Periodic))
                })
                .unwrap_or([false; 3]),
            "target_grid_fingerprint": fdm.grid_certificate.as_ref().map(|certificate| &certificate.grid_fingerprint),
            "transfer_provenance": fdm.layers.iter().filter_map(|layer| {
                let active_cells = layer
                    .native_active_mask
                    .as_ref()
                    .map(|mask| mask.iter().filter(|is_active| **is_active).count() as u64)
                    .unwrap_or_else(|| {
                        u64::from(layer.native_grid[0])
                            * u64::from(layer.native_grid[1])
                            * u64::from(layer.native_grid[2])
                    });
                let certificate = fullmag_ir::FdmGridCertificateIR::new(
                    layer.native_origin,
                    layer.native_grid,
                    layer.native_cell_size,
                    active_cells,
                    1,
                )
                .ok()?;
                Some(serde_json::json!({
                    "magnet_name": layer.magnet_name,
                    "transfer_kind": layer.transfer_kind,
                    "source_grid_fingerprint": certificate.grid_fingerprint,
                    "target_grid_fingerprint": fdm.grid_certificate.as_ref().map(|value| value.grid_fingerprint.clone()),
                    "periodic_axes": fdm.periodicity.as_ref().map(|pbc| pbc.axes.map(|axis| matches!(axis, fullmag_ir::AxisBoundary::Periodic))).unwrap_or([false; 3]),
                }))
            }).collect::<Vec<_>>(),
            "grid_cells": fdm.common_cells,
        }),
        BackendPlanIR::Fem(fem) => serde_json::json!({
            "mesh_name": fem.mesh.mesh_name,
            "mesh_generation_id": solver_mesh_signature(&fem.mesh),
            "topology_fingerprint": fem.mesh.topology_fingerprint_v6(),
            "node_count": fem.mesh.nodes.len(),
            "element_count": fem.mesh.cell_count(),
            "boundary_face_count": fem.mesh.facet_count(),
            "periodic_boundary_pair_count": fem.mesh.periodic_boundary_pairs.len(),
            "periodic_node_pair_count": fem.mesh.periodic_node_pairs.len(),
            "periodic_boundary_pair_counts_by_id": count_periodic_pairs_by_id(
                &fem.mesh.periodic_boundary_pairs,
                |pair| pair.pair_id.as_str(),
            ),
            "periodic_node_pair_counts_by_id": count_periodic_pairs_by_id(
                &fem.mesh.periodic_node_pairs,
                |pair| pair.pair_id.as_str(),
            ),
            "mesh_build_report": fem.mesh_build_report,
        }),
        BackendPlanIR::FemEigen(fem) => serde_json::json!({
            "mesh_name": fem.mesh.mesh_name,
            "mesh_generation_id": solver_mesh_signature(&fem.mesh),
            "topology_fingerprint": fem.mesh.topology_fingerprint_v6(),
            "node_count": fem.mesh.nodes.len(),
            "element_count": fem.mesh.cell_count(),
            "boundary_face_count": fem.mesh.facet_count(),
            "periodic_boundary_pair_count": fem.mesh.periodic_boundary_pairs.len(),
            "periodic_node_pair_count": fem.mesh.periodic_node_pairs.len(),
            "periodic_boundary_pair_counts_by_id": count_periodic_pairs_by_id(
                &fem.mesh.periodic_boundary_pairs,
                |pair| pair.pair_id.as_str(),
            ),
            "periodic_node_pair_counts_by_id": count_periodic_pairs_by_id(
                &fem.mesh.periodic_node_pairs,
                |pair| pair.pair_id.as_str(),
            ),
            "mesh_build_report": fem.mesh_build_report,
        }),
        BackendPlanIR::FemFrequencyResponse(fem) => serde_json::json!({
            "mesh_name": fem.mesh.mesh_name,
            "mesh_generation_id": solver_mesh_signature(&fem.mesh),
            "topology_fingerprint": fem.mesh.topology_fingerprint_v6(),
            "node_count": fem.mesh.nodes.len(),
            "element_count": fem.mesh.cell_count(),
            "boundary_face_count": fem.mesh.facet_count(),
            "periodic_boundary_pair_count": fem.mesh.periodic_boundary_pairs.len(),
            "periodic_node_pair_count": fem.mesh.periodic_node_pairs.len(),
            "periodic_boundary_pair_counts_by_id": count_periodic_pairs_by_id(
                &fem.mesh.periodic_boundary_pairs,
                |pair| pair.pair_id.as_str(),
            ),
            "periodic_node_pair_counts_by_id": count_periodic_pairs_by_id(
                &fem.mesh.periodic_node_pairs,
                |pair| pair.pair_id.as_str(),
            ),
            "mesh_build_report": fem.mesh_build_report,
        }),
    }
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

fn thermal_execution_provenance(
    plan: &fullmag_ir::ExecutionPlanIR,
    steps: &[StepStats],
    provenance: &crate::types::ExecutionProvenance,
) -> Option<serde_json::Value> {
    let (seed, is_fdm) = match &plan.backend_plan {
        BackendPlanIR::Fem(fem) => (fem.thermal_seed_config.as_ref()?, false),
        BackendPlanIR::Fdm(fdm) => (fdm.thermal_seed_config.as_ref()?, true),
        _ => return None,
    };
    let resolved_seed = if is_fdm {
        provenance.random_seed.or(seed.seed)
    } else {
        seed.seed
    };
    let resolved_policy = if is_fdm && resolved_seed.is_some() {
        fullmag_ir::SeedPolicy::Fixed
    } else {
        seed.policy
    };
    Some(serde_json::json!({
        "requested_seed_policy": seed.policy,
        "resolved_seed_policy": resolved_policy,
        "resolved_seed": resolved_seed,
        "accepted_interval_index": steps.len(),
    }))
}

fn demag_amg_profile_metadata(
    preconditioner: &str,
    stats: Option<&StepStats>,
) -> serde_json::Value {
    if preconditioner != "AMG" {
        return serde_json::Value::Null;
    }
    let Some(stats) = stats else {
        return serde_json::Value::Null;
    };
    serde_json::json!({
        "provider": "mfem_hypre_boomeramg",
        "relax_type": stats.demag_amg_relax_type,
        "coarsening": stats.demag_amg_coarsening,
        "interpolation": stats.demag_amg_interpolation,
        "aggressive_coarsening": stats.demag_amg_aggressive_coarsening,
        "strength_threshold": stats.demag_amg_strength_threshold_is_set
            .then_some(stats.demag_amg_strength_threshold),
        "max_levels": stats.demag_amg_max_levels_is_set
            .then_some(stats.demag_amg_max_levels),
    })
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

            let requested_policy = fem.demag_solver_policy.as_ref();
            let policy = requested_policy.cloned().unwrap_or_default();
            let resolved_policy = provenance.fem_poisson_demag.as_ref();
            let policy_source = if requested_policy.is_some() {
                "explicit"
            } else {
                "resolved_default"
            };
            let resolved_demag = fem
                .demag_realization
                .unwrap_or(fullmag_ir::ResolvedFemDemagIR::PoissonRobin);
            let periodic_poisson_reduction_enabled =
                resolved_demag.is_poisson() && !fem.mesh.periodic_node_pairs.is_empty();
            let periodic_boundary_markers_excluded_from_robin =
                periodic_poisson_reduction_enabled && !fem.mesh.periodic_boundary_pairs.is_empty();
            let magnetostatic_boundary_model = if periodic_poisson_reduction_enabled {
                "periodic_airbox_k0"
            } else {
                match resolved_demag {
                    fullmag_ir::ResolvedFemDemagIR::PoissonDirichlet => "open_airbox_dirichlet",
                    fullmag_ir::ResolvedFemDemagIR::PoissonRobin => "open_airbox_robin",
                    fullmag_ir::ResolvedFemDemagIR::FredkinKoehler => "fredkin_koehler",
                    fullmag_ir::ResolvedFemDemagIR::Bem => "bem",
                    fullmag_ir::ResolvedFemDemagIR::Fmm => "fmm",
                }
            };
            let poisson_operator = if periodic_poisson_reduction_enabled {
                Some("pbc_reduced_poisson")
            } else if resolved_demag.is_poisson() {
                Some("full_poisson")
            } else {
                None
            };
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
            let amg_profile = demag_amg_profile_metadata(&preconditioner, last);

            serde_json::json!({
                "model": resolved_demag.model_name(),
                "magnetostatic_boundary_model": magnetostatic_boundary_model,
                "boundary_variant": boundary_variant,
                "poisson_operator": poisson_operator,
                "periodic_reduction": {
                    "enabled": periodic_poisson_reduction_enabled,
                    "method": if periodic_poisson_reduction_enabled { Some("P^T A P") } else { None },
                    "node_pair_count": fem.mesh.periodic_node_pairs.len(),
                    "boundary_pair_count": fem.mesh.periodic_boundary_pairs.len(),
                    "node_pair_counts_by_id": count_periodic_pairs_by_id(
                        &fem.mesh.periodic_node_pairs,
                        |pair| pair.pair_id.as_str(),
                    ),
                    "boundary_pair_counts_by_id": count_periodic_pairs_by_id(
                        &fem.mesh.periodic_boundary_pairs,
                        |pair| pair.pair_id.as_str(),
                    ),
                    "periodic_boundary_markers_excluded_from_robin": periodic_boundary_markers_excluded_from_robin,
                },
                "linear_solver": linear_solver,
                "preconditioner": preconditioner,
                "amg_profile": amg_profile,
                "relative_tolerance": relative_tolerance,
                "absolute_tolerance": policy.atol,
                "max_iterations": max_iterations,
                "print_level": policy.print_level,
                "policy_source": policy_source,
                "requested_linear_solver": requested_policy.map(|entry| entry.solver.clone()),
                "requested_preconditioner": requested_policy.map(|entry| entry.preconditioner.clone()),
                "requested_relative_tolerance": requested_policy.map(|entry| entry.rtol),
                "requested_absolute_tolerance": requested_policy.and_then(|entry| entry.atol),
                "requested_max_iterations": requested_policy.map(|entry| entry.max_iterations),
                "requested_print_level": requested_policy.map(|entry| entry.print_level),
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
        converged: completion.is_some_and(|entry| entry.converged),
        stop_reason: completion
            .and_then(|entry| entry.reason.as_ref())
            .map(stage_stop_reason_as_str)
            .map(str::to_string),
        stop_metric_kind: completion.and_then(|entry| entry.metric),
        stop_metric_unit: completion
            .and_then(|entry| entry.metric_unit())
            .map(str::to_string),
        stop_metric_name: completion.and_then(|entry| entry.metric_name.clone()),
        stop_metric_value: completion.and_then(|entry| entry.metric_value),
        stop_threshold: completion.and_then(|entry| entry.threshold),
        final_energy_terms_j: FemCpuRelaxationEnergyTerms {
            e_ex: last.e_ex,
            e_demag: last.e_demag,
            e_ext: last.e_ext,
            e_drive: last.e_drive,
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
    let derivative_contract = fem_energy_weighted_armijo_contract(control, provenance);
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
                metric: derivative_contract.map(|contract| contract.metric.to_string()),
                gradient_metric: derivative_contract
                    .map(|contract| contract.gradient_metric.to_string()),
                gradient_units: derivative_contract
                    .map(|contract| contract.gradient_units.to_string()),
                search_direction_units: derivative_contract
                    .map(|contract| contract.search_direction_units.to_string()),
                line_search_step_units: derivative_contract
                    .map(|contract| contract.line_search_step_units.to_string()),
                armijo_slope_units: derivative_contract
                    .map(|contract| contract.armijo_slope_units.to_string()),
                armijo_decrement_units: derivative_contract
                    .map(|contract| contract.armijo_decrement_units.to_string()),
                armijo_derivative_units: derivative_contract
                    .map(|contract| contract.armijo_derivative_units.to_string()),
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
                metric: derivative_contract.map(|contract| contract.metric.to_string()),
                gradient_metric: derivative_contract
                    .map(|contract| contract.gradient_metric.to_string()),
                gradient_units: derivative_contract
                    .map(|contract| contract.gradient_units.to_string()),
                search_direction_units: derivative_contract
                    .map(|contract| contract.search_direction_units.to_string()),
                line_search_step_units: derivative_contract
                    .map(|contract| contract.line_search_step_units.to_string()),
                armijo_slope_units: derivative_contract
                    .map(|contract| contract.armijo_slope_units.to_string()),
                armijo_decrement_units: derivative_contract
                    .map(|contract| contract.armijo_decrement_units.to_string()),
                armijo_derivative_units: derivative_contract
                    .map(|contract| contract.armijo_derivative_units.to_string()),
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
                metric: derivative_contract.map(|contract| contract.metric.to_string()),
                gradient_metric: derivative_contract
                    .map(|contract| contract.gradient_metric.to_string()),
                gradient_units: derivative_contract
                    .map(|contract| contract.gradient_units.to_string()),
                search_direction_units: derivative_contract
                    .map(|contract| contract.search_direction_units.to_string()),
                line_search_step_units: derivative_contract
                    .map(|contract| contract.line_search_step_units.to_string()),
                armijo_slope_units: derivative_contract
                    .map(|contract| contract.armijo_slope_units.to_string()),
                armijo_decrement_units: derivative_contract
                    .map(|contract| contract.armijo_decrement_units.to_string()),
                armijo_derivative_units: derivative_contract
                    .map(|contract| contract.armijo_derivative_units.to_string()),
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
                gradient_metric: None,
                gradient_units: None,
                search_direction_units: None,
                line_search_step_units: None,
                armijo_slope_units: None,
                armijo_decrement_units: None,
                armijo_derivative_units: None,
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

#[derive(Clone, Copy)]
struct FemEnergyWeightedArmijoContract {
    metric: &'static str,
    gradient_metric: &'static str,
    gradient_units: &'static str,
    search_direction_units: &'static str,
    line_search_step_units: &'static str,
    armijo_slope_units: &'static str,
    armijo_decrement_units: &'static str,
    armijo_derivative_units: &'static str,
}

fn fem_energy_weighted_armijo_contract(
    control: &fullmag_ir::RelaxationControlIR,
    provenance: &crate::types::ExecutionProvenance,
) -> Option<FemEnergyWeightedArmijoContract> {
    if !matches!(
        control.algorithm,
        fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb
            | fullmag_ir::RelaxationAlgorithmIR::NonlinearCg
            | fullmag_ir::RelaxationAlgorithmIR::TangentPlaneImplicit
    ) || provenance.resolved_energy_minimizer.as_deref() != Some(control.algorithm.as_str())
        || provenance.energy_minimizer_realization.as_deref()
            != crate::relaxation::native_direct_minimizer_realization(
                control.algorithm,
                provenance.execution_engine == "fem_native_gpu",
            )
    {
        return None;
    }
    Some(FemEnergyWeightedArmijoContract {
        metric: "mu0_ms_fem_lumped_volume",
        gradient_metric: "mu0_ms_fem_lumped_volume",
        gradient_units: "A/m",
        search_direction_units: "A/m",
        line_search_step_units: "m/A",
        armijo_slope_units: "J A/m",
        armijo_decrement_units: "J",
        armijo_derivative_units: "J",
    })
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
    let derivative_contract = fem_energy_weighted_armijo_contract(control, provenance);
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
            derivative_contract.map(|contract| contract.metric.to_string()),
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
            derivative_contract.map(|contract| contract.metric.to_string()),
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
    let completion = executed.result.completion.as_ref();

    let metadata = FemGpuRelaxationQualificationMetadata {
        schema_version: "fem_gpu_relaxation_qualification.v1".to_string(),
        relaxation_algorithm: Some(control.algorithm.as_str().to_string()),
        algorithm_policy: FemGpuRelaxationAlgorithmPolicyMetadata {
            realization,
            time_integrator,
            precession_policy,
            rhs_policy,
            metric,
            gradient_metric: derivative_contract
                .map(|contract| contract.gradient_metric.to_string()),
            gradient_units: derivative_contract.map(|contract| contract.gradient_units.to_string()),
            search_direction_units: derivative_contract
                .map(|contract| contract.search_direction_units.to_string()),
            line_search_step_units: derivative_contract
                .map(|contract| contract.line_search_step_units.to_string()),
            armijo_slope_units: derivative_contract
                .map(|contract| contract.armijo_slope_units.to_string()),
            armijo_decrement_units: derivative_contract
                .map(|contract| contract.armijo_decrement_units.to_string()),
            armijo_derivative_units: derivative_contract
                .map(|contract| contract.armijo_derivative_units.to_string()),
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
        converged: completion.is_some_and(|entry| entry.converged),
        stop_reason: completion
            .and_then(|entry| entry.reason.as_ref())
            .map(stage_stop_reason_as_str)
            .map(str::to_string),
        stop_metric_kind: completion.and_then(|entry| entry.metric),
        stop_metric_unit: completion
            .and_then(|entry| entry.metric_unit())
            .map(str::to_string),
        stop_metric_name: completion.and_then(|entry| entry.metric_name.clone()),
        stop_metric_value: completion.and_then(|entry| entry.metric_value),
        stop_threshold: completion.and_then(|entry| entry.threshold),
        final_energy_terms_j: FemCpuRelaxationEnergyTerms {
            e_ex: last.e_ex,
            e_demag: last.e_demag,
            e_ext: last.e_ext,
            e_drive: last.e_drive,
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
        "cells": mesh.cells,
        "element_markers": mesh.element_markers,
        "facets": mesh.facets,
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
    let sampling_resolution = problem
        .problem_meta
        .runtime_metadata
        .get("sampling_resolution");
    write_sampling_resolution_artifact(output_dir, sampling_resolution)?;
    let field_context = build_field_context(problem, plan);
    let requested_execution = requested_execution_metadata(problem);
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
    let periodic_antidot_relaxation = problem
        .problem_meta
        .runtime_metadata
        .get("periodic_antidot_relaxation")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let mesh_metadata = mesh_runtime_metadata(plan);
    let region_realization_revisions = region_realization_revisions_metadata(problem);
    let material_field_assets = write_material_field_artifacts(output_dir, plan)?;
    let mut execution_provenance_json =
        serde_json::to_value(&execution_provenance).expect("ExecutionProvenance must serialize");
    if let Some(thermal) =
        thermal_execution_provenance(plan, &executed.result.steps, &execution_provenance)
    {
        execution_provenance_json
            .as_object_mut()
            .expect("ExecutionProvenance must serialize to an object")
            .insert("thermal".to_string(), thermal);
    }

    let mut metadata = serde_json::json!({
        "problem_name": problem.problem_meta.name,
        "ir_version": problem.ir_version,
        "source_hash": problem.problem_meta.source_hash,
        "problem_meta": problem.problem_meta,
        "pbc": problem.pbc,
        "execution_plan": plan,
        "requested_execution": requested_execution,
        "artifact_layout": field_context.layout.clone(),
        "mesh": mesh_metadata,
        "region_realization_revisions": region_realization_revisions,
        "periodic_antidot_relaxation": periodic_antidot_relaxation,
        "execution_provenance": execution_provenance_json,
        "runtime_threading": runtime_threading,
        "demag_runtime": demag_runtime,
        "fem_cpu_relaxation_qualification": fem_cpu_relaxation_qualification,
        "fem_gpu_relaxation_qualification": fem_gpu_relaxation_qualification,
        "engine_version": env!("CARGO_PKG_VERSION"),
        "status": executed.result.status,
        "scalar_rows": executed.result.steps.len(),
        "field_snapshots": executed.field_snapshot_count,
        "artifact_pipeline": streamed.map(|summary| serde_json::json!({
            "scalar_rows_written": summary.scalar_rows_written,
            "field_snapshots_written": summary.field_snapshots_written,
            "writer_jobs_completed": summary.writer_jobs_completed,
            "artifact_writer_job_wall_time_ns": summary.artifact_writer_job_wall_time_ns,
            "scalar_row_writer_wall_time_ns": summary.scalar_row_writer_wall_time_ns,
            "field_snapshot_writer_wall_time_ns": summary.field_snapshot_writer_wall_time_ns,
            "native_field_snapshot_writer_wall_time_ns": summary.native_field_snapshot_writer_wall_time_ns,
        })),
        "material_field_assets": material_field_assets,
    });
    if let Some(sampling_resolution) = sampling_resolution {
        metadata
            .as_object_mut()
            .expect("run metadata must be an object")
            .insert("sampling_resolution".into(), sampling_resolution.clone());
    }
    let metadata_path = output_dir.join("metadata.json");
    let mut metadata_file = fs::File::create(&metadata_path)?;
    metadata_file.write_all(serde_json::to_string_pretty(&metadata).unwrap().as_bytes())?;

    if streamed.is_none_or(|summary| summary.scalar_rows_written == 0) {
        write_scalars_csv(&output_dir.join("scalars.csv"), &executed.result.steps)?;
    }
    write_table_autosave_artifacts(output_dir, problem, &executed.result.steps)?;
    if should_write_solver_diagnostics(plan, execution_provenance.timestep_policy.as_ref()) {
        write_solver_diagnostics_artifacts(
            output_dir,
            plan,
            execution_provenance.timestep_policy.as_ref(),
            &executed.result.steps,
        )?;
    }

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

    let mut auxiliary_artifacts = executed.auxiliary_artifacts.clone();
    auxiliary_artifacts.extend(crate::fdm::artifacts::grid_certificate_artifacts(plan));
    auxiliary_artifacts.extend(crate::fdm::artifacts::pbc_provenance_artifacts(
        plan,
        &execution_provenance,
    ));
    auxiliary_artifacts.extend(crate::fdm::artifacts::transfer_provenance_artifacts(plan));
    let fdm_region_membership_artifacts = crate::fdm::artifacts::region_membership_artifacts(plan)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    auxiliary_artifacts.extend(fdm_region_membership_artifacts);
    for artifact in &auxiliary_artifacts {
        let artifact_path = output_dir.join(&artifact.relative_path);
        if let Some(parent) = artifact_path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(artifact_path, &artifact.bytes)?;
    }

    if should_write_plan_periodic_pairs_artifact(plan, executed) {
        write_periodic_pairs_artifact(output_dir, plan, problem_source_scene_revision(problem))?;
    }
    write_fem_supercell_node_geometry_artifact(output_dir, problem, plan)?;
    write_static_pbc_demag_seam_diagnostics_artifact(
        output_dir,
        problem,
        plan,
        executed,
        &final_stats,
    )?;

    write_prescribed_current_transport_artifacts(
        output_dir,
        problem,
        plan,
        &field_context,
        &execution_provenance,
    )?;

    Ok(())
}

fn should_write_solver_diagnostics(
    plan: &fullmag_ir::ExecutionPlanIR,
    timestep_policy: Option<&crate::types::TimestepPolicyProvenance>,
) -> bool {
    timestep_policy.is_some()
        || matches!(
            &plan.backend_plan,
            BackendPlanIR::Fem(fem)
                if fem.relaxation.as_ref().is_some_and(|control| matches!(
                    control.algorithm,
                    fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb
                        | fullmag_ir::RelaxationAlgorithmIR::NonlinearCg
                        | fullmag_ir::RelaxationAlgorithmIR::TangentPlaneImplicit
                ))
        )
}

fn write_solver_diagnostics_artifacts(
    output_dir: &Path,
    plan: &fullmag_ir::ExecutionPlanIR,
    timestep_policy: Option<&crate::types::TimestepPolicyProvenance>,
    steps: &[StepStats],
) -> std::io::Result<()> {
    let policy = match &plan.backend_plan {
        BackendPlanIR::Fem(fem) => serde_json::json!({
            "backend": "fem",
            "integrator": fem.integrator,
            "fixed_timestep": fem.fixed_timestep,
            "adaptive_timestep": fem.adaptive_timestep,
            "gyromagnetic_ratio": fem.gyromagnetic_ratio,
        }),
        BackendPlanIR::Fdm(fdm) => serde_json::json!({
            "backend": "fdm",
            "integrator": fdm.integrator,
            "fixed_timestep": fdm.fixed_timestep,
            "adaptive_timestep": fdm.adaptive_timestep,
            "gyromagnetic_ratio": fdm.gyromagnetic_ratio,
        }),
        _ => serde_json::json!({"backend": "not_time_domain"}),
    };
    let (requested_policy, resolved_policy, execution_identity) = timestep_policy.map_or_else(
        || (policy.clone(), policy, serde_json::Value::Null),
        |provenance| {
            (
                serde_json::to_value(&provenance.requested).unwrap(),
                serde_json::to_value(&provenance.resolved).unwrap(),
                serde_json::to_value(&provenance.execution_identity).unwrap(),
            )
        },
    );
    fs::write(
        output_dir.join("solver_config.json"),
        serde_json::to_string_pretty(&serde_json::json!({
            "schema_version": "LLG-TD-SOLVER-CONFIG-V1",
            "requested_policy": requested_policy,
            "resolved_policy": resolved_policy,
            "execution_identity": execution_identity,
        }))
        .unwrap(),
    )?;

    let mut attempts = fs::File::create(output_dir.join("solver_attempts.csv"))?;
    writeln!(attempts, "attempt,target_step,t_s,dt_attempt_s,eta,max_norm_defect,max_spin_rotation_rad,decision,reason,dt_next_s,demag_solves,demag_iterations,demag_residual,rhs_evals,estimator_order")?;
    for step in steps {
        for record in &step.solver_attempts {
            writeln!(
                attempts,
                "{},{},{:.17e},{:.17e},{:.17e},{},{},{},{},{:.17e},{},{},{:.17e},{},{}",
                record.attempt,
                record.target_step,
                record.time,
                record.dt_attempt,
                record.eta,
                record
                    .max_norm_defect
                    .map(|value| format!("{value:.17e}"))
                    .unwrap_or_default(),
                record
                    .max_spin_rotation
                    .map(|value| format!("{value:.17e}"))
                    .unwrap_or_default(),
                record.decision,
                record.reason,
                record.dt_next,
                record.demag_solves,
                record.demag_iterations,
                record.demag_residual,
                record.rhs_evals,
                record.estimator_order,
            )?;
        }
    }

    let mut accepted = fs::File::create(output_dir.join("solver_steps.csv"))?;
    writeln!(accepted, "step,t_s,dt_s,error_estimate,max_error,dt_suggested_s,rejected_attempts,rhs_evals,demag_solves,demag_iterations,demag_residual,e_exchange_j,e_demag_j,e_zeeman_j,e_drive_j,e_anisotropy_j,e_dmi_j,e_total_j,max_rhs_per_s,max_torque_apm,accepted_energy_proof_available,accepted_energy_delta_j,accepted_energy_roundoff_bound_j,accepted_energy_delta_upper_j,armijo_increment_rhs_j")?;
    for step in steps {
        writeln!(
            accepted,
            "{},{:.17e},{:.17e},{},{},{},{},{},{},{},{:.17e},{:.17e},{:.17e},{:.17e},{:.17e},{:.17e},{:.17e},{:.17e},{:.17e},{:.17e},{},{},{},{},{}",
            step.step,
            step.time,
            step.dt,
            step.error_estimate.map(|value| format!("{value:.17e}")).unwrap_or_default(),
            step.max_error.map(|value| format!("{value:.17e}")).unwrap_or_default(),
            step.dt_suggested.map(|value| format!("{value:.17e}")).unwrap_or_default(),
            step.rejected_attempts,
            step.rhs_evals,
            step.demag_solves,
            step.poisson_iterations,
            step.poisson_final_residual,
            step.e_ex,
            step.e_demag,
            step.e_ext,
            step.e_drive,
            step.e_ani,
            step.e_dmi,
            step.e_total,
            step.max_rhs_norm_per_s.max(step.max_dm_dt),
            step.max_torque_Apm,
            step.accepted_energy_proof_available,
            step.accepted_energy_delta_j.map(|value| format!("{value:.17e}")).unwrap_or_default(),
            step.accepted_energy_roundoff_bound_j.map(|value| format!("{value:.17e}")).unwrap_or_default(),
            step.accepted_energy_delta_upper_j.map(|value| format!("{value:.17e}")).unwrap_or_default(),
            step.armijo_increment_rhs_j.map(|value| format!("{value:.17e}")).unwrap_or_default(),
        )?;
    }

    fs::write(
        output_dir.join("qualification.json"),
        serde_json::to_string_pretty(&serde_json::json!({
            "schema_version": "LLG-TD-QUALIFICATION-V1",
            "status": "not_evaluated",
            "reason": "Scientific qualification is produced by the dedicated qualification gate; artifact creation alone is not evidence of validation.",
            "accepted_steps": steps.len(),
            "attempt_records": steps.iter().map(|step| step.solver_attempts.len()).sum::<usize>(),
            "checks": [],
        })).unwrap(),
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

fn write_fem_supercell_node_geometry_artifact(
    output_dir: &Path,
    problem: &fullmag_ir::ProblemIR,
    plan: &fullmag_ir::ExecutionPlanIR,
) -> std::io::Result<()> {
    let BackendPlanIR::Fem(fem) = &plan.backend_plan else {
        return Ok(());
    };
    let Some(runtime_metadata) = problem
        .problem_meta
        .runtime_metadata
        .get("periodic_antidot_relaxation")
        .and_then(|value| value.as_object())
    else {
        return Ok(());
    };
    if !runtime_metadata.contains_key("supercell_repeat") {
        return Ok(());
    }

    let magnetic_node_mask = crate::preview::mesh_quantity_active_mask("m", &fem.mesh)
        .unwrap_or_else(|| vec![true; fem.mesh.nodes.len()]);
    let magnetic_node_count = magnetic_node_mask.iter().filter(|value| **value).count();
    let artifact = serde_json::json!({
        "schema_version": "fem_mesh_node_geometry.v1",
        "artifact_path": "mesh/node_geometry.v1.json",
        "mesh_name": fem.mesh.mesh_name,
        "node_count": fem.mesh.nodes.len(),
        "element_count": fem.mesh.cell_count(),
        "nodes_m": fem.mesh.nodes,
        "magnetic_node_mask": magnetic_node_mask,
        "magnetic_node_count": magnetic_node_count,
        "field_cell_alignment": {
            "m": "node_index",
            "H_demag": "node_index",
            "H_eff": "node_index",
            "demag_phi": "node_index"
        },
        "source": "ExecutionPlanIR.FemPlanIR.mesh.nodes",
    });
    let mesh_dir = output_dir.join("mesh");
    fs::create_dir_all(&mesh_dir)?;
    fs::write(
        mesh_dir.join("node_geometry.v1.json"),
        serde_json::to_vec_pretty(&artifact).unwrap(),
    )?;
    Ok(())
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

fn should_write_plan_periodic_pairs_artifact(
    plan: &fullmag_ir::ExecutionPlanIR,
    executed: &ExecutedRun,
) -> bool {
    if matches!(plan.backend_plan, BackendPlanIR::FemEigen(_)) {
        return false;
    }
    if matches!(plan.backend_plan, BackendPlanIR::FemFrequencyResponse(_))
        && executed
            .provenance
            .execution_engine
            .starts_with("native_fem.frequency_domain.production_")
    {
        return false;
    }
    true
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

fn problem_source_scene_revision(problem: &fullmag_ir::ProblemIR) -> Option<u64> {
    problem
        .problem_meta
        .runtime_metadata
        .get("mesh_source_scene_revision")
        .and_then(serde_json::Value::as_u64)
        .or_else(|| {
            problem
                .problem_meta
                .runtime_metadata
                .get("source_scene_revision")
                .and_then(serde_json::Value::as_u64)
        })
}

fn write_periodic_pairs_artifact(
    output_dir: &Path,
    plan: &fullmag_ir::ExecutionPlanIR,
    source_scene_revision: Option<u64>,
) -> std::io::Result<()> {
    let Some(mesh) = periodic_mesh(plan) else {
        return Ok(());
    };
    if mesh.periodic_boundary_pairs.is_empty() {
        return Ok(());
    }

    let mesh_topology_fingerprint = mesh.topology_fingerprint_v6();
    let (ms_element_field, a_element_field, ms_nodal_field, a_nodal_field) =
        periodic_material_fields(plan);
    let certificate = mesh
        .periodic_mesh_certificate_v6_with_material_and_nodal_fields(
            ms_element_field,
            a_element_field,
            ms_nodal_field,
            a_nodal_field,
        )
        .and_then(|certificate| validate_periodic_certificate_identity(mesh, certificate));
    let certificate_status = certificate
        .as_ref()
        .map(|certificate| certificate.certificate_status.as_str())
        .unwrap_or("rejected");
    let certificate_errors = certificate.as_ref().err().cloned().unwrap_or_default();

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
            let (magnetic_node_pair_count, airbox_node_pair_count) =
                mesh_periodic_domain_node_pair_counts(mesh, node_pairs);
            let boundary_face_pairs = certificate
                .as_ref()
                .map(|certificate| {
                    certified_mesh_periodic_boundary_face_pairs(
                        certificate,
                        &boundary_pair.pair_id,
                        boundary_pair.translation,
                    )
                })
                .unwrap_or_default();
            let node_pair_payload = node_pairs
                .iter()
                .map(|pair| {
                    serde_json::json!({
                        "node_a": pair.node_a,
                        "node_b": pair.node_b,
                    })
                })
                .collect::<Vec<_>>();

            serde_json::json!({
                "pair_id": boundary_pair.pair_id.clone(),
                "source_marker": boundary_pair.source_marker.clone(),
                "destination_marker": boundary_pair.destination_marker.clone(),
                "marker_a": boundary_pair.marker_a,
                "marker_b": boundary_pair.marker_b,
                "expected_translation_m": boundary_pair.translation,
                "paired_node_count": node_pairs.len(),
                "domain_node_pair_counts": {
                    "magnetic": magnetic_node_pair_count,
                    "airbox": airbox_node_pair_count,
                },
                "unpaired_source_node_count": source_nodes.difference(&paired_source_nodes).count(),
                "unpaired_destination_node_count": destination_nodes.difference(&paired_destination_nodes).count(),
                "boundary_face_pairs": boundary_face_pairs,
                "node_pairs": node_pair_payload,
                "max_residual_m": diagnostics.max_residual_m,
                "rms_residual_m": diagnostics.rms_residual_m,
                "status": if certificate.is_err() {
                    "certificate_rejected"
                } else if boundary_face_pairs.is_empty() {
                    "face_pairs_missing"
                } else {
                    diagnostics.status.as_str()
                },
            })
        })
        .collect::<Vec<_>>();
    let pair_count = pairs.len();
    let paired_node_count = pairs
        .iter()
        .filter_map(|pair| {
            pair.get("paired_node_count")
                .and_then(serde_json::Value::as_u64)
        })
        .sum::<u64>();
    let max_translation_residual_m = pairs
        .iter()
        .filter_map(|pair| {
            pair.get("max_residual_m")
                .and_then(serde_json::Value::as_f64)
        })
        .fold(None, |acc: Option<f64>, value| {
            Some(acc.map_or(value, |current| current.max(value)))
        });
    let validation_status = if certificate.is_ok()
        && pairs
            .iter()
            .all(|pair| pair.get("status").and_then(serde_json::Value::as_str) == Some("valid"))
    {
        "ok"
    } else {
        "failed"
    };

    let payload = serde_json::json!({
        "schema_version": "periodic_pairs.v1",
        "artifact_path": "mesh/periodic_pairs.v1.json",
        "topology_fingerprint": mesh_topology_fingerprint,
        "mesh_generation_id": solver_mesh_signature(mesh),
        "source_scene_revision": source_scene_revision,
        "certificate_status": certificate_status,
        "certificate_fingerprint": certificate.as_ref().ok().and_then(|certificate| {
            serde_json::to_vec(certificate).ok().map(|payload| {
                let digest = sha2::Sha256::digest(payload);
                format!("sha256:{digest:x}")
            })
        }),
        "certificate": certificate
            .as_ref()
            .ok()
            .and_then(|certificate| serde_json::to_value(certificate).ok()),
        "certificate_errors": certificate_errors,
        "validation_status": validation_status,
        "pair_count": pair_count,
        "paired_node_count": paired_node_count,
        "max_translation_residual_m": max_translation_residual_m,
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

fn validate_periodic_certificate_identity(
    mesh: &fullmag_ir::MeshIR,
    certificate: fullmag_ir::PeriodicMeshCertificateV6IR,
) -> Result<fullmag_ir::PeriodicMeshCertificateV6IR, Vec<String>> {
    let mesh_topology_fingerprint = mesh.topology_fingerprint_v6();
    if certificate.topology_fingerprint == mesh_topology_fingerprint {
        Ok(certificate)
    } else {
        Err(vec![format!(
            "periodic v6 certificate topology fingerprint {} does not match mesh {}",
            certificate.topology_fingerprint, mesh_topology_fingerprint
        )])
    }
}

fn static_pbc_demag_fem_plan<'a>(
    problem: &fullmag_ir::ProblemIR,
    plan: &'a fullmag_ir::ExecutionPlanIR,
) -> Option<&'a fullmag_ir::FemPlanIR> {
    let BackendPlanIR::Fem(fem) = &plan.backend_plan else {
        return None;
    };
    if !fem.enable_demag || fem.mesh.periodic_boundary_pairs.is_empty() {
        return None;
    }
    let pbc = problem.pbc.as_ref()?;
    if !pbc.has_any_periodic()
        || !matches!(
            pbc.demag,
            fullmag_ir::FdmDemagPeriodicityIR::PeriodicAirboxK0
        )
    {
        return None;
    }
    Some(fem)
}

fn write_static_pbc_demag_seam_diagnostics_artifact(
    output_dir: &Path,
    problem: &fullmag_ir::ProblemIR,
    plan: &fullmag_ir::ExecutionPlanIR,
    executed: &ExecutedRun,
    final_stats: &StepStats,
) -> std::io::Result<()> {
    let Some(fem) = static_pbc_demag_fem_plan(problem, plan) else {
        return Ok(());
    };

    let mut issues = Vec::<String>::new();
    let h_demag_snapshot = field_snapshot_at_step(executed, "H_demag", final_stats.step);
    let demag_phi_snapshot = field_snapshot_at_step(executed, "demag_phi", final_stats.step);
    let h_demag = h_demag_snapshot.map(|snapshot| snapshot.values.as_slice());
    let demag_phi = demag_phi_snapshot.map(|snapshot| snapshot.values.as_slice());
    if h_demag.is_none() {
        issues.push(format!(
            "missing H_demag field snapshot at final step {}",
            final_stats.step
        ));
    }
    if demag_phi.is_none() {
        issues.push(format!(
            "missing demag_phi field snapshot at final step {}",
            final_stats.step
        ));
    }
    if let Some(values) = h_demag {
        if values.len() != fem.mesh.nodes.len() {
            issues.push(format!(
                "H_demag field snapshot length {} does not match FEM mesh node count {}",
                values.len(),
                fem.mesh.nodes.len()
            ));
        }
    }
    if let Some(values) = demag_phi {
        if values.len() != fem.mesh.nodes.len() {
            issues.push(format!(
                "demag_phi field snapshot length {} does not match FEM mesh node count {}",
                values.len(),
                fem.mesh.nodes.len()
            ));
        }
    }

    let mut pair_diagnostics = Vec::new();
    if let (Some(h_demag), Some(demag_phi)) = (h_demag, demag_phi) {
        if h_demag.len() == fem.mesh.nodes.len() && demag_phi.len() == fem.mesh.nodes.len() {
            let node_pairs_by_id = fem.mesh.periodic_node_pairs.iter().fold(
                HashMap::<String, Vec<&fullmag_ir::MeshPeriodicNodePairIR>>::new(),
                |mut acc, pair| {
                    acc.entry(pair.pair_id.clone()).or_default().push(pair);
                    acc
                },
            );
            let (magnetic_nodes, _) = mesh_node_domain_sets(&fem.mesh);
            for boundary_pair in &fem.mesh.periodic_boundary_pairs {
                let node_pairs = node_pairs_by_id
                    .get(&boundary_pair.pair_id)
                    .map(Vec::as_slice)
                    .unwrap_or(&[]);
                let (diagnostics, pair_issues) = static_pbc_demag_pair_diagnostics(
                    fem,
                    &magnetic_nodes,
                    boundary_pair,
                    node_pairs,
                    &executed.result.final_magnetization,
                    h_demag,
                    demag_phi,
                );
                issues.extend(pair_issues);
                pair_diagnostics.push(diagnostics);
            }
        }
    }
    if pair_diagnostics.is_empty() {
        issues.push("no static PBC demag pair diagnostics could be evaluated".to_string());
    }

    let status = if issues.is_empty() { "ok" } else { "failed" };
    let payload = serde_json::json!({
        "schema_version": "fem_static_pbc_demag_seams.v1",
        "artifact_path": "diagnostics/fem_static_pbc_demag_seams.v1.json",
        "status": status,
        "step": final_stats.step,
        "time": final_stats.time,
        "solver_dt": final_stats.dt,
        "basis": "node_pairs_plus_boundary_face_integrals",
        "pair_diagnostics": pair_diagnostics,
        "issues": issues,
    });
    let artifact_path = output_dir
        .join("diagnostics")
        .join("fem_static_pbc_demag_seams.v1.json");
    if let Some(parent) = artifact_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(
        artifact_path,
        serde_json::to_string_pretty(&payload).unwrap(),
    )?;

    Ok(())
}

fn field_snapshot_at_step<'a>(
    executed: &'a ExecutedRun,
    name: &str,
    step: u64,
) -> Option<&'a crate::types::FieldSnapshot> {
    executed
        .field_snapshots
        .iter()
        .rev()
        .find(|snapshot| snapshot.name == name && snapshot.step == step)
}

fn static_pbc_demag_pair_diagnostics(
    fem: &fullmag_ir::FemPlanIR,
    magnetic_nodes: &BTreeSet<u32>,
    boundary_pair: &fullmag_ir::MeshPeriodicBoundaryPairIR,
    node_pairs: &[&fullmag_ir::MeshPeriodicNodePairIR],
    magnetization: &[[f64; 3]],
    h_demag: &[[f64; 3]],
    demag_phi: &[[f64; 3]],
) -> (serde_json::Value, Vec<String>) {
    let mut issues = Vec::<String>::new();
    if node_pairs.is_empty() {
        issues.push(format!(
            "periodic boundary pair '{}' has no node pairs",
            boundary_pair.pair_id
        ));
    }
    let normal = periodic_pair_unit_normal(boundary_pair);
    if normal.is_none() {
        issues.push(format!(
            "periodic boundary pair '{}' has no usable translation or axis hint",
            boundary_pair.pair_id
        ));
    }

    let mut max_m_seam = 0.0f64;
    let mut max_h_seam = 0.0f64;
    let mut max_b_normal_flux = 0.0f64;
    let mut phi_deltas = Vec::<f64>::new();

    for pair in node_pairs {
        let node_a = pair.node_a as usize;
        let node_b = pair.node_b as usize;
        if node_a >= h_demag.len() || node_b >= h_demag.len() {
            issues.push(format!(
                "periodic boundary pair '{}' references H_demag node outside field length",
                boundary_pair.pair_id
            ));
            continue;
        }
        if node_a >= demag_phi.len() || node_b >= demag_phi.len() {
            issues.push(format!(
                "periodic boundary pair '{}' references demag_phi node outside field length",
                boundary_pair.pair_id
            ));
            continue;
        }

        let node_a_magnetic = magnetic_nodes.contains(&pair.node_a);
        let node_b_magnetic = magnetic_nodes.contains(&pair.node_b);
        if node_a_magnetic != node_b_magnetic {
            issues.push(format!(
                "periodic boundary pair '{}' maps magnetic and airbox nodes together",
                boundary_pair.pair_id
            ));
            continue;
        }
        if node_a_magnetic && (node_a >= magnetization.len() || node_b >= magnetization.len()) {
            issues.push(format!(
                "periodic boundary pair '{}' references magnetic node outside magnetization length",
                boundary_pair.pair_id
            ));
            continue;
        }

        if node_a_magnetic {
            max_m_seam = max_m_seam.max(vector_difference_norm(
                magnetization[node_a],
                magnetization[node_b],
            ));
        }
        max_h_seam = max_h_seam.max(vector_difference_norm(h_demag[node_a], h_demag[node_b]));
        phi_deltas.push(demag_phi[node_a][0] - demag_phi[node_b][0]);
        if let Some(normal) = normal {
            let b_a = demag_b_vector(fem, magnetic_nodes, node_a, magnetization, h_demag[node_a]);
            let b_b = demag_b_vector(fem, magnetic_nodes, node_b, magnetization, h_demag[node_b]);
            max_b_normal_flux =
                max_b_normal_flux.max(vector_dot(vector_subtract(b_a, b_b), normal).abs());
        }
    }

    let demag_phi_seam_max_after_offset = if phi_deltas.is_empty() {
        issues.push(format!(
            "periodic boundary pair '{}' has no phi deltas to gauge-fit",
            boundary_pair.pair_id
        ));
        0.0
    } else {
        let offset = phi_deltas.iter().sum::<f64>() / phi_deltas.len() as f64;
        phi_deltas
            .iter()
            .map(|delta| (delta - offset).abs())
            .fold(0.0f64, f64::max)
    };

    let face_pairs = mesh_periodic_boundary_face_index_pairs(&fem.mesh, boundary_pair);
    if face_pairs.is_empty() {
        issues.push(format!(
            "periodic boundary pair '{}' has no paired boundary faces for side-charge integral",
            boundary_pair.pair_id
        ));
    }
    let mut side_charge_sum = 0.0f64;
    for (source_face_index, destination_face_index) in &face_pairs {
        let Some(normal) = normal else {
            continue;
        };
        let source_normal = [-normal[0], -normal[1], -normal[2]];
        let Some(source_charge) = face_magnetic_charge_integral(
            fem,
            magnetic_nodes,
            *source_face_index,
            source_normal,
            magnetization,
        ) else {
            issues.push(format!(
                "periodic boundary pair '{}' has invalid source face {} for side-charge integral",
                boundary_pair.pair_id, source_face_index
            ));
            continue;
        };
        let Some(destination_charge) = face_magnetic_charge_integral(
            fem,
            magnetic_nodes,
            *destination_face_index,
            normal,
            magnetization,
        ) else {
            issues.push(format!(
                "periodic boundary pair '{}' has invalid destination face {} for side-charge integral",
                boundary_pair.pair_id, destination_face_index
            ));
            continue;
        };
        side_charge_sum += source_charge + destination_charge;
    }
    let side_charge_sum_abs = side_charge_sum.abs();
    let pair_status = if issues.is_empty() { "ok" } else { "failed" };

    (
        serde_json::json!({
            "pair_id": boundary_pair.pair_id,
            "status": pair_status,
            "paired_node_count": node_pairs.len(),
            "boundary_face_pair_count": face_pairs.len(),
            "m_seam_max": max_m_seam,
            "h_demag_seam_max_Apm": max_h_seam,
            "demag_phi_seam_max_after_offset_A": demag_phi_seam_max_after_offset,
            "b_normal_flux_seam_max_T": max_b_normal_flux,
            "side_magnetic_charge_sum_abs_Am": side_charge_sum_abs,
        }),
        issues,
    )
}

fn periodic_mesh(plan: &fullmag_ir::ExecutionPlanIR) -> Option<&fullmag_ir::MeshIR> {
    match &plan.backend_plan {
        BackendPlanIR::Fem(fem) => Some(&fem.mesh),
        BackendPlanIR::FemEigen(fem) => Some(&fem.mesh),
        BackendPlanIR::FemFrequencyResponse(fem) => Some(&fem.mesh),
        BackendPlanIR::Fdm(_) | BackendPlanIR::FdmMultilayer(_) => None,
    }
}

fn periodic_material_fields(
    plan: &fullmag_ir::ExecutionPlanIR,
) -> (
    Option<&[f64]>,
    Option<&[f64]>,
    Option<&[f64]>,
    Option<&[f64]>,
) {
    match &plan.backend_plan {
        BackendPlanIR::Fem(fem) => (
            fem.ms_element_field.as_deref(),
            fem.a_element_field.as_deref(),
            fem.material.ms_field.as_deref(),
            fem.material.a_field.as_deref(),
        ),
        BackendPlanIR::Fdm(_)
        | BackendPlanIR::FdmMultilayer(_)
        | BackendPlanIR::FemEigen(_)
        | BackendPlanIR::FemFrequencyResponse(_) => (None, None, None, None),
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
    for facet in mesh.facets.iter() {
        let Some(marker) = mesh.boundary_markers.get(facet.ordinal).copied() else {
            continue;
        };
        let nodes = nodes_by_marker.entry(marker).or_default();
        nodes.extend(facet.nodes.iter().copied());
    }
    nodes_by_marker
}

fn mesh_node_domain_sets(mesh: &fullmag_ir::MeshIR) -> (BTreeSet<u32>, BTreeSet<u32>) {
    let mut magnetic_nodes = BTreeSet::new();
    let mut airbox_nodes = BTreeSet::new();
    for cell in mesh.cells.iter() {
        let marker = mesh.element_markers.get(cell.ordinal).copied().unwrap_or(1);
        let target = if marker == 0 {
            &mut airbox_nodes
        } else {
            &mut magnetic_nodes
        };
        target.extend(cell.nodes.iter().copied());
    }
    (magnetic_nodes, airbox_nodes)
}

fn mesh_periodic_domain_node_pair_counts(
    mesh: &fullmag_ir::MeshIR,
    node_pairs: &[&fullmag_ir::MeshPeriodicNodePairIR],
) -> (usize, usize) {
    let (magnetic_nodes, airbox_nodes) = mesh_node_domain_sets(mesh);
    let mut magnetic_count = 0usize;
    let mut airbox_count = 0usize;
    for pair in node_pairs {
        let node_a_is_magnetic = magnetic_nodes.contains(&pair.node_a);
        let node_b_is_magnetic = magnetic_nodes.contains(&pair.node_b);
        let node_a_is_airbox = airbox_nodes.contains(&pair.node_a);
        let node_b_is_airbox = airbox_nodes.contains(&pair.node_b);
        if node_a_is_magnetic && node_b_is_magnetic {
            magnetic_count += 1;
        } else if !node_a_is_magnetic
            && !node_b_is_magnetic
            && (node_a_is_airbox || node_b_is_airbox)
        {
            airbox_count += 1;
        }
    }
    (magnetic_count, airbox_count)
}

fn certified_mesh_periodic_boundary_face_pairs(
    certificate: &fullmag_ir::PeriodicMeshCertificateV6IR,
    pair_id: &str,
    translation: Option<[f64; 3]>,
) -> Vec<serde_json::Value> {
    certificate
        .axis_pairs
        .iter()
        .find(|axis| axis.pair_id == pair_id)
        .map(|axis| {
            axis.face_pairs
                .iter()
                .map(|face| {
                    serde_json::json!({
                        "face_a": face.face_a,
                        "face_b": face.face_b,
                        "vertex_pairs": face.vertex_pairs,
                        "translation_m": translation,
                        "translation_residual_m": face.translation_residual_max_m,
                        "area_residual_m2": face.area_residual_m2,
                        "normal_dot": face.normal_dot,
                        "source_marker": face.source_marker,
                        "destination_marker": face.destination_marker,
                        "source_element_markers": face.source_element_markers,
                        "destination_element_markers": face.destination_element_markers,
                        "orientation": if face.normal_dot <= -0.999 {
                            "opposed_normals"
                        } else {
                            "invalid"
                        },
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
fn mesh_periodic_boundary_face_pairs(
    mesh: &fullmag_ir::MeshIR,
    boundary_pair: &fullmag_ir::MeshPeriodicBoundaryPairIR,
) -> Vec<serde_json::Value> {
    let mut pairs = Vec::new();
    for (source_face_index, destination_face_index) in
        mesh_periodic_boundary_face_index_pairs(mesh, boundary_pair)
    {
        let normal_dot = mesh_boundary_face_unit_normal(mesh, source_face_index)
            .zip(mesh_boundary_face_unit_normal(mesh, destination_face_index))
            .map(|(source, destination)| vector_dot(source, destination));
        pairs.push(serde_json::json!({
            "face_a": source_face_index,
            "face_b": destination_face_index,
            "translation_m": boundary_pair.translation,
            "normal_dot": normal_dot,
            "orientation": if normal_dot.is_some_and(|dot| dot <= -0.999) {
                "opposed_normals"
            } else {
                "not_opposed"
            },
        }));
    }
    pairs
}

fn mesh_periodic_boundary_face_index_pairs(
    mesh: &fullmag_ir::MeshIR,
    boundary_pair: &fullmag_ir::MeshPeriodicBoundaryPairIR,
) -> Vec<(usize, usize)> {
    if boundary_pair.translation.is_none() {
        return Vec::new();
    }
    let source_faces = mesh_boundary_face_indices_by_marker(mesh, boundary_pair.marker_a);
    let destination_faces = mesh_boundary_face_indices_by_marker(mesh, boundary_pair.marker_b);
    let node_map = mesh
        .periodic_node_pairs
        .iter()
        .filter(|pair| pair.pair_id == boundary_pair.pair_id)
        .map(|pair| (pair.node_a, pair.node_b))
        .collect::<HashMap<_, _>>();
    let mut pairs = Vec::new();
    let mut used_destinations = BTreeSet::new();
    for source_face_index in source_faces {
        let Some(source_face) = mesh.facets.item_nodes(source_face_index) else {
            continue;
        };
        let Some(mapped_face) = source_face
            .iter()
            .map(|node| node_map.get(node).copied())
            .collect::<Option<Vec<_>>>()
        else {
            continue;
        };
        let mut expected = mapped_face;
        expected.sort_unstable();
        let Some(destination_face_index) = destination_faces.iter().copied().find(|index| {
            !used_destinations.contains(index)
                && mesh
                    .facets
                    .item_nodes(*index)
                    .map(|face| {
                        let mut actual = face.to_vec();
                        actual.sort_unstable();
                        actual == expected
                    })
                    .unwrap_or(false)
        }) else {
            continue;
        };
        used_destinations.insert(destination_face_index);
        pairs.push((source_face_index, destination_face_index));
    }
    pairs
}

fn mesh_boundary_face_indices_by_marker(mesh: &fullmag_ir::MeshIR, marker: u32) -> Vec<usize> {
    mesh.boundary_markers
        .iter()
        .enumerate()
        .filter_map(|(index, face_marker)| (*face_marker == marker).then_some(index))
        .collect()
}

fn mesh_boundary_face_area(mesh: &fullmag_ir::MeshIR, face_index: usize) -> Option<f64> {
    let face = mesh.facets.item_nodes(face_index)?;
    let &origin_index = face.first()?;
    let origin = mesh.nodes.get(origin_index as usize)?;
    face[1..].windows(2).try_fold(0.0, |area, edge| {
        let b = mesh.nodes.get(edge[0] as usize)?;
        let c = mesh.nodes.get(edge[1] as usize)?;
        let ab = [b[0] - origin[0], b[1] - origin[1], b[2] - origin[2]];
        let ac = [c[0] - origin[0], c[1] - origin[1], c[2] - origin[2]];
        let cross = [
            ab[1] * ac[2] - ab[2] * ac[1],
            ab[2] * ac[0] - ab[0] * ac[2],
            ab[0] * ac[1] - ab[1] * ac[0],
        ];
        Some(area + 0.5 * (cross[0] * cross[0] + cross[1] * cross[1] + cross[2] * cross[2]).sqrt())
    })
}

#[cfg(test)]
fn mesh_boundary_face_unit_normal(
    mesh: &fullmag_ir::MeshIR,
    face_index: usize,
) -> Option<[f64; 3]> {
    let face = mesh.facets.item_nodes(face_index)?;
    if face.len() != 3 {
        return None;
    }
    let a = mesh.nodes.get(face[0] as usize)?;
    let b = mesh.nodes.get(face[1] as usize)?;
    let c = mesh.nodes.get(face[2] as usize)?;
    let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let cross = [
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
    ];
    let norm = vector_norm(cross);
    (norm > f64::EPSILON).then_some([cross[0] / norm, cross[1] / norm, cross[2] / norm])
}

fn periodic_pair_unit_normal(
    boundary_pair: &fullmag_ir::MeshPeriodicBoundaryPairIR,
) -> Option<[f64; 3]> {
    if let Some(translation) = boundary_pair.translation {
        let norm = vector_norm(translation);
        if norm > f64::EPSILON {
            return Some([
                translation[0] / norm,
                translation[1] / norm,
                translation[2] / norm,
            ]);
        }
    }
    match boundary_pair.axis_hint.as_deref() {
        Some("x") => Some([1.0, 0.0, 0.0]),
        Some("y") => Some([0.0, 1.0, 0.0]),
        Some("z") => Some([0.0, 0.0, 1.0]),
        _ => None,
    }
}

fn vector_norm(value: [f64; 3]) -> f64 {
    (value[0] * value[0] + value[1] * value[1] + value[2] * value[2]).sqrt()
}

fn vector_difference_norm(a: [f64; 3], b: [f64; 3]) -> f64 {
    vector_norm(vector_subtract(a, b))
}

fn vector_subtract(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn vector_dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn material_ms_at(material: &fullmag_ir::MaterialIR, node_index: usize) -> f64 {
    material
        .ms_field
        .as_ref()
        .and_then(|values| values.get(node_index))
        .copied()
        .unwrap_or(material.saturation_magnetisation)
}

fn magnetization_vector_at(
    fem: &fullmag_ir::FemPlanIR,
    magnetic_nodes: &BTreeSet<u32>,
    node_index: usize,
    magnetization: &[[f64; 3]],
) -> Option<[f64; 3]> {
    if !magnetic_nodes.contains(&(node_index as u32)) {
        return Some([0.0, 0.0, 0.0]);
    }
    let m = magnetization.get(node_index)?;
    let ms = material_ms_at(&fem.material, node_index);
    Some([ms * m[0], ms * m[1], ms * m[2]])
}

fn demag_b_vector(
    fem: &fullmag_ir::FemPlanIR,
    magnetic_nodes: &BTreeSet<u32>,
    node_index: usize,
    magnetization: &[[f64; 3]],
    h_demag: [f64; 3],
) -> [f64; 3] {
    let magnetization = magnetization_vector_at(fem, magnetic_nodes, node_index, magnetization)
        .unwrap_or([0.0, 0.0, 0.0]);
    [
        MU0_H_PER_M * (h_demag[0] + magnetization[0]),
        MU0_H_PER_M * (h_demag[1] + magnetization[1]),
        MU0_H_PER_M * (h_demag[2] + magnetization[2]),
    ]
}

fn face_magnetic_charge_integral(
    fem: &fullmag_ir::FemPlanIR,
    magnetic_nodes: &BTreeSet<u32>,
    face_index: usize,
    normal: [f64; 3],
    magnetization: &[[f64; 3]],
) -> Option<f64> {
    let face = fem.mesh.facets.item_nodes(face_index)?;
    let area = mesh_boundary_face_area(&fem.mesh, face_index)?;
    let mut average_m_dot_n = 0.0f64;
    for node in face {
        let vector = magnetization_vector_at(fem, magnetic_nodes, *node as usize, magnetization)?;
        average_m_dot_n += vector_dot(vector, normal);
    }
    Some(area * average_m_dot_n / face.len() as f64)
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
                .min(fem.mesh.cell_count());
            for index in start..end {
                if let Some(cell_nodes) = fem.mesh.cells.item_nodes(index) {
                    nodes.extend(cell_nodes.iter().map(|index| *index as usize));
                }
            }
        }
        fullmag_ir::FemMeshPartSelector::ElementMarkerSet { markers } => {
            let markers = markers.iter().copied().collect::<BTreeSet<_>>();
            for cell in fem.mesh.cells.iter() {
                if fem
                    .mesh
                    .element_markers
                    .get(cell.ordinal)
                    .is_some_and(|marker| markers.contains(marker))
                {
                    nodes.extend(cell.nodes.iter().map(|index| *index as usize));
                }
            }
        }
        _ => {}
    }

    for face_index in &part.boundary_face_indices {
        if let Some(face) = fem.mesh.facets.item_nodes(*face_index as usize) {
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
                .min(fem.mesh.facet_count());
            for index in start..end {
                if let Some(face) = fem.mesh.facets.item_nodes(index) {
                    nodes.extend(face.iter().map(|index| *index as usize));
                }
            }
        }
        _ => {}
    }
    for global_ordinal in &part.facet_global_ordinals {
        if let Some(face_index) = fem
            .mesh
            .facets
            .global_ordinals
            .iter()
            .position(|candidate| candidate == global_ordinal)
        {
            if let Some(face) = fem.mesh.facets.item_nodes(face_index) {
                nodes.extend(face.iter().map(|index| *index as usize));
            }
        }
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
    let config = crate::table_autosave::TableAutosaveConfig::from_ir(config_ir)
        .map_err(|error| {
            Error::new(
                ErrorKind::InvalidInput,
                format!("invalid table_autosave config: {error}"),
            )
        })?
        .with_sampling_resolution(
            problem
                .problem_meta
                .runtime_metadata
                .get("sampling_resolution")
                .cloned(),
        );
    let mut store = crate::table_autosave::TableStore::new(config);
    for step in steps {
        store
            .append_if_due(step)
            .map_err(|error| Error::new(ErrorKind::InvalidInput, error))?;
    }
    if matches!(problem.study, fullmag_ir::StudyIR::Relaxation { .. }) {
        if let Some(final_step) = steps.last() {
            store
                .append_final_if_needed(final_step)
                .map_err(|error| Error::new(ErrorKind::InvalidInput, error))?;
        }
    }
    store.write_artifacts(output_dir)
}

fn write_sampling_resolution_artifact(
    output_dir: &Path,
    sampling_resolution: Option<&serde_json::Value>,
) -> std::io::Result<()> {
    let Some(sampling_resolution) = sampling_resolution else {
        return Ok(());
    };
    let sampling_dir = output_dir.join("sampling");
    fs::create_dir_all(&sampling_dir)?;
    fs::write(
        sampling_dir.join("sampling_resolution.v1.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "schema_version": "sampling_resolution.v1",
            "sampling_resolution": sampling_resolution,
        }))?,
    )
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
                "origin_m": fdm.origin_m,
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
            "n_elements": fem.mesh.cell_count(),
        }),
        BackendPlanIR::FemEigen(fem) => serde_json::json!({
            "backend": "fem_eigen",
            "mesh_name": fem.mesh.mesh_name,
            "mesh_source": fem.mesh_source,
            "fe_order": fem.fe_order,
            "hmax": fem.hmax,
            "n_nodes": fem.mesh.nodes.len(),
            "n_elements": fem.mesh.cell_count(),
            "mode_count": fem.count,
            "operator": fem.operator,
            "material": {
                "saturation_magnetisation": fem.material.saturation_magnetisation,
                "effective_magnetisation": fem.k0_kittel_validation.as_ref()
                    .and_then(|validation| validation.material.effective_magnetisation),
            },
            "k0_kittel_validation": fem.k0_kittel_validation,
        }),
        BackendPlanIR::FemFrequencyResponse(fem) => serde_json::json!({
            "backend": "fem_frequency_response",
            "mesh_name": fem.mesh.mesh_name,
            "mesh_source": fem.mesh_source,
            "fe_order": fem.fe_order,
            "hmax": fem.hmax,
            "n_nodes": fem.mesh.nodes.len(),
            "n_elements": fem.mesh.cell_count(),
            "frequency_count": fem.frequencies_hz.values_hz.len(),
            "operator": fem.operator,
        }),
    }
}

pub(crate) fn field_unit(observable: &str) -> &'static str {
    let base_observable = observable
        .split_once('.')
        .map_or(observable, |(base, _)| base);
    fullmag_quantities::quantity_spec(base_observable)
        .map(|spec| spec.unit)
        .unwrap_or_else(|| panic!("unsupported observable '{}'", base_observable))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artifact_node_selection_resolves_quad_interface_by_global_ordinal() {
        let mut plan = test_fem_execution_plan();
        let BackendPlanIR::Fem(fem) = &mut plan.backend_plan else {
            panic!("test plan must be FEM");
        };
        fem.mesh.nodes = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 1.0, 0.0],
            [0.0, 1.0, 0.0],
        ];
        fem.mesh.facets = fullmag_ir::FemFacetConnectivityIR {
            types: vec![fullmag_ir::FemFacetTypeIR::Quad4],
            roles: vec![fullmag_ir::FemFacetRoleIR::MaterialInterface],
            offsets: vec![0, 4],
            nodes: vec![0, 1, 2, 3],
            global_ordinals: vec![700],
        };
        fem.mesh.boundary_markers = vec![27];
        let part = FemMeshPartIR {
            id: "part:interface:0:1".into(),
            label: "Air ↔ film".into(),
            role: FemMeshPartRole::Interface,
            object_id: Some("film".into()),
            geometry_id: Some("film".into()),
            material_id: None,
            element_selector: FemMeshPartSelector::ElementRange { start: 0, count: 0 },
            boundary_face_selector: FemMeshPartSelector::BoundaryFaceRange { start: 0, count: 0 },
            node_selector: FemMeshPartSelector::NodeRange { start: 0, count: 0 },
            boundary_face_indices: Vec::new(),
            node_indices: Vec::new(),
            facet_global_ordinals: vec![700],
            bounds_min: None,
            bounds_max: None,
            parent_id: None,
        };
        assert_eq!(
            fem_part_node_indices_for_artifact(fem, &part),
            vec![0, 1, 2, 3]
        );
    }
    use crate::types::{
        ExecutedRun, ExecutionProvenance, FieldSnapshot, ResolvedFallback, RunResult, RunStatus,
        SolverAttemptRecord,
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

    #[test]
    fn regional_drive_field_artifact_uses_magnetic_field_units() {
        assert_eq!(field_unit("H_drive"), "A/m");
        assert_eq!(field_unit("H_drive.y"), "A/m");
    }

    fn test_execution_plan(active_mask: Option<Vec<bool>>) -> ExecutionPlanIR {
        let active_cells = active_mask.as_deref().map_or(8, |mask| {
            mask.iter().filter(|active| **active).count() as u64
        });
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
                grid_certificate: Some(
                    fullmag_ir::FdmGridCertificateIR::new_with_masks(
                        [0.0, 0.0, 0.0],
                        [4, 2, 1],
                        [2e-9, 2e-9, 5e-9],
                        active_cells,
                        8 * fullmag_plan::FDM_GRID_ESTIMATED_BYTES_PER_CELL,
                        active_mask.as_deref(),
                        &[0; 8],
                    )
                    .expect("artifact fixture grid certificate should be valid"),
                ),
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
                integrator: Some(IntegratorChoice::Heun),
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
            provenance: ProvenancePlanIR {
                notes: Vec::new(),
                integrator_resolution: None,
            },
        }
    }

    #[test]
    fn fdm_mesh_metadata_preserves_requested_and_resolved_pbc_demag() {
        let mut plan = test_execution_plan(None);
        let BackendPlanIR::Fdm(fdm) = &mut plan.backend_plan else {
            panic!("expected FDM plan");
        };
        fdm.periodicity = Some(fullmag_ir::FdmPeriodicityIR {
            axes: [
                fullmag_ir::AxisBoundary::Periodic,
                fullmag_ir::AxisBoundary::Open,
                fullmag_ir::AxisBoundary::Open,
            ],
            demag: fullmag_ir::FdmDemagPeriodicityIR::TruncatedImages,
            image_counts: Some([4, 0, 0]),
        });
        fdm.resolved_periodic_images = fdm.periodicity.as_ref().and_then(|pbc| {
            pbc.resolve_periodic_images(fdm.grid.cells, fdm.precision)
                .expect("test PBC workspace should resolve")
        });
        let metadata = mesh_runtime_metadata(&plan);
        assert_eq!(
            metadata["requested_periodicity"]["demag"],
            "truncated_images"
        );
        assert_eq!(
            metadata["resolved_demag_boundary"]["periodic_truncated_images"]["image_counts"],
            serde_json::json!([4, 0, 0])
        );
        assert_eq!(
            metadata["resolved_periodic_images"]["resolved_image_counts"],
            serde_json::json!([4, 0, 0])
        );
        assert_eq!(
            metadata["resolved_periodic_images"]["padded_counts"],
            serde_json::json!([4, 4, 2])
        );
    }

    #[test]
    fn auto_sampling_writes_versioned_resolution_artifact_without_recomputing_values() {
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-auto-sampling-artifact-{}",
            std::process::id()
        ));
        let resolution = serde_json::json!({
            "schema_version": "sampling_resolution.v1",
            "requested_policy": {"kind": "auto_sinc_cutoff", "nyquist_guard_factor": 1.3},
            "sample_period_s": 7.692307692307691e-11,
            "maximum_cutoff_hz": 5.0e9,
            "nyquist_guard_factor": 1.3,
            "target_nyquist_hz": 6.5e9,
            "sampling_frequency_hz": 13.0e9,
            "source_drive_ids": ["drive-5"],
            "target_stage_id": "excite"
        });

        write_sampling_resolution_artifact(&output_dir, Some(&resolution))
            .expect("sampling artifact should write");

        let artifact: serde_json::Value = serde_json::from_slice(
            &fs::read(output_dir.join("sampling/sampling_resolution.v1.json"))
                .expect("sampling artifact should be readable"),
        )
        .expect("sampling artifact should be JSON");
        assert_eq!(artifact["schema_version"], "sampling_resolution.v1");
        assert_eq!(artifact["sampling_resolution"], resolution);
        let _ = fs::remove_dir_all(output_dir);
    }

    #[test]
    fn fdm_pbc_provenance_artifact_round_trips_requested_and_resolved_contract() {
        let mut plan = test_execution_plan(None);
        let BackendPlanIR::Fdm(fdm) = &mut plan.backend_plan else {
            panic!("expected FDM plan");
        };
        fdm.periodicity = Some(fullmag_ir::FdmPeriodicityIR {
            axes: [
                fullmag_ir::AxisBoundary::Periodic,
                fullmag_ir::AxisBoundary::Open,
                fullmag_ir::AxisBoundary::Open,
            ],
            demag: fullmag_ir::FdmDemagPeriodicityIR::TruncatedImages,
            image_counts: Some([4, 0, 0]),
        });
        fdm.grid_certificate = Some(
            fullmag_ir::FdmGridCertificateIR::new(
                fdm.origin_m,
                fdm.grid.cells,
                fdm.cell_size,
                8,
                1024,
            )
            .expect("FDM grid certificate should be valid"),
        );
        fdm.resolved_periodic_images = fdm.periodicity.as_ref().and_then(|pbc| {
            pbc.resolve_periodic_images(fdm.grid.cells, fdm.precision)
                .expect("test PBC workspace should resolve")
        });
        let provenance = ExecutionProvenance {
            demag_operator_kind: Some("tensor_fft_newell".to_string()),
            fft_backend: Some("rustfft".to_string()),
            ..ExecutionProvenance::default()
        };
        let artifacts = crate::fdm::artifacts::pbc_provenance_artifacts(&plan, &provenance);
        assert_eq!(artifacts.len(), 1);
        assert_eq!(
            artifacts[0].relative_path,
            "mesh/fdm_pbc_provenance.v1.json"
        );
        let value: serde_json::Value = serde_json::from_slice(&artifacts[0].bytes)
            .expect("PBC provenance artifact should be JSON");
        assert_eq!(value["schema_version"], "fdm_pbc_provenance.v1");
        assert_eq!(
            value["requested_periodicity"]["axes"],
            serde_json::json!(["periodic", "open", "open"])
        );
        assert_eq!(
            value["resolved"]["origin_m"],
            serde_json::json!([0.0, 0.0, 0.0])
        );
        assert_eq!(value["resolved"]["counts"], serde_json::json!([4, 2, 1]));
        assert!(value["resolved"]["grid_fingerprint"].as_str().is_some());
        assert_eq!(
            value["resolved"]["period_m"],
            serde_json::json!([8e-9, 4e-9, 5e-9])
        );
        assert_eq!(
            value["resolved"]["padded_counts"],
            serde_json::json!([4, 4, 2])
        );
        assert_eq!(value["resolved"]["fft_backend"], "rustfft");
        assert_eq!(
            value["resolved"]["periodic_images"]["kernel"],
            "newell_truncated_images_fft"
        );
    }

    #[test]
    fn fdm_region_membership_artifact_persists_binary_mask_and_legend_identity() {
        let mut plan = test_execution_plan(None);
        let BackendPlanIR::Fdm(fdm) = &mut plan.backend_plan else {
            panic!("expected FDM plan");
        };
        fdm.region_mask = vec![1, 1, 2, 2, 0, 0, 1, 2];
        fdm.active_mask = Some(vec![true, true, true, true, true, false, true, true]);
        fdm.grid_certificate = Some(
            fullmag_ir::FdmGridCertificateIR::new_with_masks(
                fdm.origin_m,
                fdm.grid.cells,
                fdm.cell_size,
                7,
                1024,
                fdm.active_mask.as_deref(),
                &fdm.region_mask,
            )
            .expect("FDM region certificate should be valid")
            .with_object_ids(vec!["body".to_string()])
            .with_region_legend(vec![
                fullmag_ir::FdmRegionLegendEntryIR {
                    numeric_id: 1,
                    object_id: "body".to_string(),
                    region_id: "body:core".to_string(),
                    priority: 0,
                },
                fullmag_ir::FdmRegionLegendEntryIR {
                    numeric_id: 2,
                    object_id: "body".to_string(),
                    region_id: "body:shell".to_string(),
                    priority: -1,
                },
            ]),
        );

        let artifacts = crate::fdm::artifacts::region_membership_artifacts(&plan)
            .expect("membership artifacts should be produced");
        assert_eq!(artifacts.len(), 2);
        assert_eq!(
            artifacts[0].relative_path,
            "mesh/fdm_region_membership.v2.json"
        );
        assert_eq!(
            artifacts[1].relative_path,
            "mesh/fdm_region_membership.v2.bin"
        );
        let descriptor: serde_json::Value = serde_json::from_slice(&artifacts[0].bytes)
            .expect("membership descriptor should be JSON");
        assert_eq!(descriptor["schema_version"], "fdm_region_membership.v2");
        assert_eq!(descriptor["object_ids"], serde_json::json!(["body"]));
        assert_eq!(descriptor["cell_count"], 8);
        assert_eq!(descriptor["region_legend"].as_array().unwrap().len(), 2);
        assert_eq!(&artifacts[1].bytes[..4], b"FMRM");
        assert_eq!(artifacts[1].bytes[4], 2);
        assert_eq!(
            u32::from_le_bytes(artifacts[1].bytes[84..88].try_into().unwrap()),
            u32::MAX,
            "inactive cells must remain distinguishable from active cells without an authored region"
        );
        assert_eq!(
            artifacts[1].bytes.len(),
            64 + 8 * std::mem::size_of::<u32>()
        );
    }

    #[test]
    fn fem_mesh_metadata_preserves_shared_domain_build_report() {
        let mut plan = test_fem_execution_plan();
        let report: fullmag_ir::FemSharedDomainBuildReportIR =
            serde_json::from_value(serde_json::json!({
                "build_mode": "generated_shared_domain_mesh",
                "degraded": false,
                "authored_regions_count": 2,
                "realized_regions_count": 2
            }))
            .expect("minimal FEM build report should deserialize");
        let BackendPlanIR::Fem(fem) = &mut plan.backend_plan else {
            panic!("expected FEM plan");
        };
        fem.mesh_build_report = Some(report.clone());
        let expected_topology_fingerprint = fem.mesh.topology_fingerprint_v6();

        let metadata = mesh_runtime_metadata(&plan);
        assert_eq!(metadata["mesh_generation_id"].as_str().unwrap().len(), 64);
        assert_eq!(
            metadata["topology_fingerprint"],
            serde_json::Value::String(expected_topology_fingerprint)
        );
        assert!(metadata["topology_fingerprint"]
            .as_str()
            .is_some_and(|value| value.starts_with("sha256:")));
        assert_ne!(
            metadata["topology_fingerprint"],
            metadata["mesh_generation_id"],
            "canonical topology identity and solver-mesh generation identity are distinct contracts"
        );
        assert_eq!(
            metadata["mesh_build_report"],
            serde_json::to_value(report).unwrap()
        );
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
                grid_certificate: None,
                resolved_periodic_images: None,
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
            provenance: ProvenancePlanIR {
                notes: Vec::new(),
                integrator_resolution: None,
            },
        }
    }

    #[test]
    fn fdm_multilayer_metadata_preserves_transfer_policy_and_grid_identity() {
        let mut plan = test_multilayer_execution_plan();
        let BackendPlanIR::FdmMultilayer(multilayer) = &mut plan.backend_plan else {
            panic!("expected multilayer FDM plan");
        };
        multilayer.periodicity = Some(fullmag_ir::FdmPeriodicityIR {
            axes: [
                fullmag_ir::AxisBoundary::Periodic,
                fullmag_ir::AxisBoundary::Open,
                fullmag_ir::AxisBoundary::Periodic,
            ],
            demag: fullmag_ir::FdmDemagPeriodicityIR::TruncatedImages,
            image_counts: Some([2, 0, 2]),
        });
        multilayer.grid_certificate = Some(
            fullmag_ir::FdmGridCertificateIR::new(
                [0.0, 0.0, 0.0],
                multilayer.common_cells,
                [2e-9, 2e-9, 1e-9],
                4,
                1024,
            )
            .expect("multilayer target grid certificate should be valid"),
        );

        let metadata = mesh_runtime_metadata(&plan);
        assert_eq!(
            metadata["transfer_boundary_policy"],
            serde_json::json!(["periodic", "open", "periodic"])
        );
        assert_eq!(
            metadata["periodic_axes"],
            serde_json::json!([true, false, true])
        );
        assert!(metadata["target_grid_fingerprint"].as_str().is_some());
        assert_eq!(metadata["transfer_provenance"].as_array().unwrap().len(), 2);
        assert!(
            metadata["transfer_provenance"][0]["source_grid_fingerprint"]
                .as_str()
                .is_some()
        );
    }

    #[test]
    fn fdm_multilayer_persists_transfer_provenance_artifact() {
        let mut plan = test_multilayer_execution_plan();
        let BackendPlanIR::FdmMultilayer(multilayer) = &mut plan.backend_plan else {
            panic!("expected multilayer FDM plan");
        };
        multilayer.periodicity = Some(fullmag_ir::FdmPeriodicityIR {
            axes: [
                fullmag_ir::AxisBoundary::Periodic,
                fullmag_ir::AxisBoundary::Open,
                fullmag_ir::AxisBoundary::Periodic,
            ],
            demag: fullmag_ir::FdmDemagPeriodicityIR::TruncatedImages,
            image_counts: Some([2, 0, 2]),
        });
        multilayer.grid_certificate = Some(
            fullmag_ir::FdmGridCertificateIR::new(
                [0.0, 0.0, 0.0],
                multilayer.common_cells,
                [2e-9, 2e-9, 1e-9],
                4,
                1024,
            )
            .expect("multilayer target grid certificate should be valid"),
        );

        let artifacts = crate::fdm::artifacts::transfer_provenance_artifacts(&plan);
        assert_eq!(artifacts.len(), 1);
        assert_eq!(
            artifacts[0].relative_path,
            "mesh/fdm_transfer_provenance.v1.json"
        );
        let value: serde_json::Value = serde_json::from_slice(&artifacts[0].bytes)
            .expect("transfer provenance artifact should be JSON");
        assert_eq!(value["schema_version"], "fdm_transfer_provenance.v1");
        assert_eq!(
            value["boundary_policy"],
            serde_json::json!(["periodic", "open", "periodic"])
        );
        assert_eq!(value["transfers"].as_array().unwrap().len(), 2);
        assert!(value["transfers"][0]["source_grid_fingerprint"]
            .as_str()
            .is_some());
        assert_eq!(
            value["transfers"][0]["target_grid_fingerprint"],
            value["target_grid_fingerprint"]
        );
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
                    cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
                    element_markers: vec![1],
                    facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
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
                mesh_build_report: None,
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
                field_drives: Vec::new(),
                field_drive_geometry_masks: Vec::new(),
                time_stage: Default::default(),
                current_modules: Vec::new(),
                gyromagnetic_ratio: 2.211e5,
                precision: ExecutionPrecision::Double,
                exchange_bc: ExchangeBoundaryCondition::Neumann,
                integrator: Some(IntegratorChoice::Heun),
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
            provenance: ProvenancePlanIR {
                notes: Vec::new(),
                integrator_resolution: None,
            },
        }
    }

    fn test_periodic_fem_execution_plan() -> ExecutionPlanIR {
        let mut plan = test_fem_execution_plan();
        if let BackendPlanIR::Fem(fem) = &mut plan.backend_plan {
            fem.mesh.periodic_boundary_pairs = vec![
                fullmag_ir::MeshPeriodicBoundaryPairIR {
                    pair_id: "x_faces".to_string(),
                    source_marker: None,
                    destination_marker: None,
                    marker_a: 1,
                    marker_b: 2,
                    translation: Some([1.0, 0.0, 0.0]),
                    tolerance: Some(1.0e-12),
                    axis_hint: Some("x".to_string()),
                    orientation: None,
                    pairing_policy: None,
                },
                fullmag_ir::MeshPeriodicBoundaryPairIR {
                    pair_id: "y_faces".to_string(),
                    source_marker: None,
                    destination_marker: None,
                    marker_a: 3,
                    marker_b: 4,
                    translation: Some([0.0, 1.0, 0.0]),
                    tolerance: Some(1.0e-12),
                    axis_hint: Some("y".to_string()),
                    orientation: None,
                    pairing_policy: None,
                },
            ];
            fem.mesh.periodic_node_pairs = vec![
                fullmag_ir::MeshPeriodicNodePairIR {
                    pair_id: "x_faces".to_string(),
                    node_a: 0,
                    node_b: 1,
                },
                fullmag_ir::MeshPeriodicNodePairIR {
                    pair_id: "y_faces".to_string(),
                    node_a: 0,
                    node_b: 2,
                },
            ];
        }
        plan
    }

    #[test]
    fn direct_fem_minimizers_require_solver_diagnostics_without_a_timestep_policy() {
        for algorithm in [
            fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb,
            fullmag_ir::RelaxationAlgorithmIR::NonlinearCg,
            fullmag_ir::RelaxationAlgorithmIR::TangentPlaneImplicit,
        ] {
            let mut plan = test_fem_execution_plan();
            let BackendPlanIR::Fem(fem) = &mut plan.backend_plan else {
                panic!("test plan must use FEM");
            };
            fem.relaxation = Some(fullmag_ir::RelaxationControlIR {
                algorithm,
                stop: fullmag_ir::RelaxStopIR {
                    torque_tolerance_apm: None,
                    energy_tolerance_j: None,
                    max_steps: Some(1),
                    max_relaxation_time_s: None,
                },
            });
            assert!(should_write_solver_diagnostics(&plan, None));
        }
    }

    #[test]
    fn solver_diagnostics_keep_attempts_separate_from_accepted_steps() {
        let root = std::env::temp_dir().join(format!(
            "fullmag-solver-diagnostics-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let replay_root = root.with_extension("replay");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&replay_root).unwrap();
        let mut step = StepStats {
            step: 1,
            time: 2.0e-15,
            dt: 1.0e-15,
            accepted_energy_proof_available: true,
            accepted_energy_delta_j: Some(-2.0e-20),
            accepted_energy_roundoff_bound_j: Some(1.0e-21),
            accepted_energy_delta_upper_j: Some(-1.9e-20),
            armijo_increment_rhs_j: Some(-1.0e-20),
            error_estimate: Some(0.25),
            max_error: Some(1.0e-6),
            dt_suggested: Some(2.0e-15),
            rejected_attempts: 1,
            ..StepStats::default()
        };
        let rejected_attempt = SolverAttemptRecord {
            attempt: 0,
            target_step: 1,
            time: 0.0,
            dt_attempt: 4.0e-15,
            eta: 4.0,
            max_norm_defect: Some(2.0e-8),
            max_spin_rotation: Some(0.02),
            decision: "retry".to_string(),
            reason: "error_above_tolerance".to_string(),
            dt_next: 1.0e-15,
            demag_solves: 7,
            demag_iterations: 11,
            demag_residual: 1.0e-9,
            rhs_evals: 7,
            estimator_order: 4,
        };
        step.solver_attempts = vec![
            rejected_attempt.clone(),
            SolverAttemptRecord {
                attempt: 1,
                dt_attempt: 1.0e-15,
                eta: 0.25,
                decision: "accepted".to_string(),
                reason: "within_tolerance".to_string(),
                dt_next: 2.0e-15,
                ..rejected_attempt
            },
        ];
        let steps = vec![
            step,
            StepStats {
                step: 2,
                ..StepStats::default()
            },
        ];
        write_solver_diagnostics_artifacts(&root, &test_fem_execution_plan(), None, &steps)
            .unwrap();
        write_solver_diagnostics_artifacts(&replay_root, &test_fem_execution_plan(), None, &steps)
            .unwrap();
        let attempts = fs::read_to_string(root.join("solver_attempts.csv")).unwrap();
        let accepted = fs::read_to_string(root.join("solver_steps.csv")).unwrap();
        assert_eq!(
            attempts.lines().count(),
            3,
            "header plus one row per attempted step"
        );
        assert_eq!(
            accepted.lines().count(),
            3,
            "header plus one row per accepted step"
        );
        assert!(attempts.contains("error_above_tolerance"));
        let accepted_rows = accepted.lines().collect::<Vec<_>>();
        let proof = accepted_rows[1].split(',').collect::<Vec<_>>();
        assert_eq!(proof[20], "true");
        let delta: f64 = proof[21].parse().unwrap();
        let bound: f64 = proof[22].parse().unwrap();
        let upper: f64 = proof[23].parse().unwrap();
        let rhs: f64 = proof[24].parse().unwrap();
        assert_eq!(upper, delta + bound);
        assert!(upper <= rhs && rhs <= 0.0);
        let unavailable = accepted_rows[2].split(',').collect::<Vec<_>>();
        assert_eq!(unavailable[20], "false");
        assert!(unavailable[21..=24].iter().all(|value| value.is_empty()));
        let max_error: f64 = accepted
            .lines()
            .nth(1)
            .unwrap()
            .split(',')
            .nth(4)
            .unwrap()
            .parse()
            .unwrap();
        assert!((max_error - 1.0e-6).abs() < 1.0e-20);
        let qualification: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join("qualification.json")).unwrap()).unwrap();
        assert_eq!(qualification["status"], "not_evaluated");
        for artifact in [
            "solver_config.json",
            "solver_attempts.csv",
            "solver_steps.csv",
            "qualification.json",
        ] {
            assert_eq!(
                fs::read(root.join(artifact)).unwrap(),
                fs::read(replay_root.join(artifact)).unwrap(),
                "solver diagnostics must replay byte-for-byte deterministically: {artifact}",
            );
        }
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(replay_root).unwrap();
    }

    #[test]
    fn metadata_execution_provenance_persists_resolved_fallback() {
        let mut problem = fullmag_ir::ProblemIR::bootstrap_example();
        problem.problem_meta.runtime_metadata.insert(
            "region_realization_revisions".to_string(),
            serde_json::json!({
                "complete": true,
                "topology": 11,
                "membership": 12,
                "coefficients": 13,
                "initial_state": 14,
            }),
        );
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
        assert!(
            metadata.get("sampling_resolution").is_none(),
            "explicit legacy runs must omit automatic sampling provenance"
        );
        assert_eq!(
            metadata["region_realization_revisions"],
            serde_json::json!({
                "complete": true,
                "topology": 11,
                "membership": 12,
                "coefficients": 13,
                "initial_state": 14,
            })
        );

        fs::remove_dir_all(output_dir).expect("temporary artifact directory should be removable");
    }

    #[test]
    fn metadata_persists_artifact_pipeline_writer_timing() {
        let problem = fullmag_ir::ProblemIR::bootstrap_example();
        let plan = test_fem_execution_plan();
        let unique_suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-artifacts-pipeline-summary-{}-{}",
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
            field_snapshot_count: 2,
            auxiliary_artifacts: Vec::new(),
            provenance: ExecutionProvenance {
                execution_engine: "fem_cpu_native".to_string(),
                precision: "double".to_string(),
                ..ExecutionProvenance::default()
            },
        };
        let streamed = ArtifactPipelineSummary {
            scalar_rows_written: 3,
            field_snapshots_written: 2,
            writer_jobs_completed: 5,
            artifact_writer_job_wall_time_ns: 110,
            scalar_row_writer_wall_time_ns: 30,
            field_snapshot_writer_wall_time_ns: 80,
            native_field_snapshot_writer_wall_time_ns: 0,
        };

        write_artifacts(&output_dir, &problem, &plan, &executed, Some(&streamed))
            .expect("artifact write should preserve pipeline timing");

        let metadata: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(output_dir.join("metadata.json")).expect("metadata should exist"),
        )
        .expect("metadata should parse");
        let pipeline = &metadata["artifact_pipeline"];
        assert_eq!(pipeline["scalar_rows_written"], 3);
        assert_eq!(pipeline["field_snapshots_written"], 2);
        assert_eq!(pipeline["writer_jobs_completed"], 5);
        assert_eq!(pipeline["artifact_writer_job_wall_time_ns"], 110);
        assert_eq!(pipeline["scalar_row_writer_wall_time_ns"], 30);
        assert_eq!(pipeline["field_snapshot_writer_wall_time_ns"], 80);
        assert_eq!(pipeline["native_field_snapshot_writer_wall_time_ns"], 0);

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
                demag_amg_relax_type: 6,
                demag_amg_coarsening: 10,
                demag_amg_interpolation: 7,
                demag_amg_aggressive_coarsening: 2,
                demag_amg_strength_threshold: 0.25,
                demag_amg_strength_threshold_is_set: true,
                demag_amg_max_levels: 42,
                demag_amg_max_levels_is_set: true,
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
        assert_eq!(metadata["policy_source"], "resolved_default");
        assert_eq!(metadata["amg_profile"]["provider"], "mfem_hypre_boomeramg");
        assert_eq!(metadata["amg_profile"]["relax_type"], 6);
        assert_eq!(metadata["amg_profile"]["coarsening"], 10);
        assert_eq!(metadata["amg_profile"]["interpolation"], 7);
        assert_eq!(metadata["amg_profile"]["aggressive_coarsening"], 2);
        assert_eq!(metadata["amg_profile"]["strength_threshold"], 0.25);
        assert_eq!(metadata["amg_profile"]["max_levels"], 42);

        let explicit_zero = demag_amg_profile_metadata(
            "AMG",
            Some(&StepStats {
                demag_amg_strength_threshold: 0.0,
                demag_amg_strength_threshold_is_set: true,
                demag_amg_max_levels: 0,
                demag_amg_max_levels_is_set: true,
                ..StepStats::default()
            }),
        );
        assert_eq!(explicit_zero["strength_threshold"], 0.0);
        assert_eq!(explicit_zero["max_levels"], 0);

        let unset = demag_amg_profile_metadata("AMG", Some(&StepStats::default()));
        assert_eq!(unset["strength_threshold"], serde_json::Value::Null);
        assert_eq!(unset["max_levels"], serde_json::Value::Null);
        assert_eq!(metadata["requested_linear_solver"], serde_json::Value::Null);
        assert_eq!(
            metadata["requested_preconditioner"],
            serde_json::Value::Null
        );
        assert_eq!(
            metadata["requested_relative_tolerance"],
            serde_json::Value::Null
        );
        assert_eq!(
            metadata["requested_absolute_tolerance"],
            serde_json::Value::Null
        );
        assert_eq!(
            metadata["requested_max_iterations"],
            serde_json::Value::Null
        );
        assert_eq!(metadata["requested_print_level"], serde_json::Value::Null);
    }

    #[test]
    fn demag_profile_metadata_exposes_periodic_reduced_poisson_contract() {
        let mut plan = test_periodic_fem_execution_plan();
        if let BackendPlanIR::Fem(fem) = &mut plan.backend_plan {
            fem.enable_demag = true;
            fem.demag_realization = Some(fullmag_ir::ResolvedFemDemagIR::PoissonRobin);
        }

        let metadata = demag_runtime_metadata(&plan, &ExecutionProvenance::default(), &[]);

        assert_eq!(metadata["model"], "airbox");
        assert_eq!(
            metadata["magnetostatic_boundary_model"],
            "periodic_airbox_k0"
        );
        assert_eq!(metadata["boundary_variant"], "robin");
        assert_eq!(metadata["poisson_operator"], "pbc_reduced_poisson");
        assert_eq!(metadata["periodic_reduction"]["enabled"], true);
        assert_eq!(metadata["periodic_reduction"]["method"], "P^T A P");
        assert_eq!(metadata["periodic_reduction"]["node_pair_count"], 2);
        assert_eq!(metadata["periodic_reduction"]["boundary_pair_count"], 2);
        assert_eq!(
            metadata["periodic_reduction"]["node_pair_counts_by_id"]["x_faces"],
            1
        );
        assert_eq!(
            metadata["periodic_reduction"]["boundary_pair_counts_by_id"]["y_faces"],
            1
        );
        assert_eq!(
            metadata["periodic_reduction"]["periodic_boundary_markers_excluded_from_robin"],
            true
        );
    }

    #[test]
    fn demag_profile_metadata_distinguishes_explicit_policy_from_resolved_policy() {
        let mut plan = test_fem_execution_plan();
        if let BackendPlanIR::Fem(fem) = &mut plan.backend_plan {
            fem.enable_demag = true;
            fem.demag_solver_policy = Some(fullmag_ir::FemLinearSolverPolicy {
                solver: "GMRES".to_string(),
                preconditioner: "JACOBI".to_string(),
                rtol: 1.0e-6,
                atol: Some(1.0e-20),
                max_iterations: 77,
                print_level: 2,
            });
        }
        let mut provenance = ExecutionProvenance::default();
        provenance.fem_poisson_demag = Some(crate::types::FemPoissonDemagProvenance {
            linear_solver: "CG".to_string(),
            preconditioner: "AMG".to_string(),
            rtol: 1.0e-8,
            max_iterations: 500,
            ..Default::default()
        });

        let metadata = demag_runtime_metadata(&plan, &provenance, &[]);

        assert_eq!(metadata["policy_source"], "explicit");
        assert_eq!(metadata["requested_linear_solver"], "GMRES");
        assert_eq!(metadata["requested_preconditioner"], "JACOBI");
        assert_eq!(metadata["requested_relative_tolerance"], 1.0e-6);
        assert_eq!(metadata["requested_absolute_tolerance"], 1.0e-20);
        assert_eq!(metadata["requested_max_iterations"], 77);
        assert_eq!(metadata["requested_print_level"], 2);
        assert_eq!(metadata["linear_solver"], "CG");
        assert_eq!(metadata["preconditioner"], "AMG");
        assert_eq!(metadata["relative_tolerance"], 1.0e-8);
        assert_eq!(metadata["max_iterations"], 500);
    }

    #[test]
    fn demag_profile_metadata_omits_amg_profile_for_non_amg_policy() {
        let mut plan = test_fem_execution_plan();
        if let BackendPlanIR::Fem(fem) = &mut plan.backend_plan {
            fem.enable_demag = true;
            fem.demag_solver_policy = Some(fullmag_ir::FemLinearSolverPolicy {
                preconditioner: "JACOBI".to_string(),
                ..Default::default()
            });
        }

        let metadata = demag_runtime_metadata(&plan, &ExecutionProvenance::default(), &[]);

        assert_eq!(metadata["preconditioner"], "JACOBI");
        assert_eq!(metadata["amg_profile"], serde_json::Value::Null);
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
                    max_relaxation_time_s: None,
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
                    converged: true,
                    reason: Some(fullmag_ir::StageStopReason::Torque),
                    metric: Some(fullmag_ir::StageMetricKind::MaxTorqueApm),
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
                    max_relaxation_time_s: None,
                },
            });
        }
        let provenance = ExecutionProvenance {
            execution_engine: "fem_cpu_native".to_string(),
            precision: "double".to_string(),
            resolved_energy_minimizer: Some("projected_gradient_bb".to_string()),
            energy_minimizer_realization: Some("native_mfem_pgbb".to_string()),
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
                completion: Some(fullmag_ir::StageCompletionIR {
                    status: "completed".to_string(),
                    converged: false,
                    reason: Some(fullmag_ir::StageStopReason::MaxSteps),
                    metric: Some(fullmag_ir::StageMetricKind::Steps),
                    metric_name: Some("step".to_string()),
                    metric_value: Some(4.0),
                    threshold: Some(4.0),
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

        assert_eq!(metadata["relaxation_algorithm"], "projected_gradient_bb");
        assert_eq!(
            metadata["algorithm_policy"]["realization"],
            "native_mfem_pgbb"
        );
        assert_eq!(
            metadata["algorithm_policy"]["metric"],
            "mu0_ms_fem_lumped_volume"
        );
        assert_eq!(metadata["algorithm_policy"]["gradient_units"], "A/m");
        assert_eq!(
            metadata["algorithm_policy"]["gradient_metric"],
            "mu0_ms_fem_lumped_volume"
        );
        assert_eq!(metadata["algorithm_policy"]["armijo_derivative_units"], "J");
        assert_eq!(
            metadata["algorithm_policy"]["search_direction_units"],
            "A/m"
        );
        assert_eq!(
            metadata["algorithm_policy"]["line_search_step_units"],
            "m/A"
        );
        assert_eq!(metadata["algorithm_policy"]["armijo_slope_units"], "J A/m");
        assert_eq!(metadata["algorithm_policy"]["armijo_decrement_units"], "J");
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

        let requested_only = ExecutionProvenance {
            requested_energy_minimizer: Some("projected_gradient_bb".to_string()),
            resolved_energy_minimizer: None,
            ..provenance.clone()
        };
        let unresolved_metadata = fem_cpu_relaxation_qualification_metadata(
            &plan,
            &requested_only,
            &demag_runtime,
            &executed,
        );
        assert!(unresolved_metadata["algorithm_policy"]["metric"].is_null());
        assert!(unresolved_metadata["algorithm_policy"]["gradient_metric"].is_null());
        assert!(unresolved_metadata["algorithm_policy"]["armijo_derivative_units"].is_null());
        assert!(unresolved_metadata["algorithm_policy"]["gradient_units"].is_null());
        assert!(unresolved_metadata["algorithm_policy"]["armijo_slope_units"].is_null());

        let bogus_realization = ExecutionProvenance {
            energy_minimizer_realization: Some("bogus_native_realization".to_string()),
            ..provenance.clone()
        };
        let bogus_metadata = fem_cpu_relaxation_qualification_metadata(
            &plan,
            &bogus_realization,
            &demag_runtime,
            &executed,
        );
        assert!(bogus_metadata["algorithm_policy"]["metric"].is_null());
        assert!(bogus_metadata["algorithm_policy"]["gradient_metric"].is_null());
        assert!(bogus_metadata["algorithm_policy"]["armijo_derivative_units"].is_null());
    }

    #[test]
    fn fem_cpu_relaxation_qualification_metadata_reports_tpi_energy_weighted_armijo_contract() {
        let mut plan = test_fem_execution_plan();
        if let BackendPlanIR::Fem(fem) = &mut plan.backend_plan {
            fem.relaxation = Some(fullmag_ir::RelaxationControlIR {
                algorithm: fullmag_ir::RelaxationAlgorithmIR::TangentPlaneImplicit,
                stop: fullmag_ir::RelaxStopIR {
                    torque_tolerance_apm: Some(1.0e-3),
                    energy_tolerance_j: None,
                    max_steps: Some(4),
                    max_relaxation_time_s: None,
                },
            });
        }
        let provenance = ExecutionProvenance {
            execution_engine: "fem_cpu_native".to_string(),
            precision: "double".to_string(),
            requested_energy_minimizer: Some("tangent_plane_implicit".to_string()),
            resolved_energy_minimizer: Some("tangent_plane_implicit".to_string()),
            energy_minimizer_realization: Some("native_mfem_tpi".to_string()),
            fem_assembly_mode: Some("legacy_sparse".to_string()),
            ..ExecutionProvenance::default()
        };
        let executed = ExecutedRun {
            result: RunResult {
                status: RunStatus::Completed,
                steps: vec![StepStats {
                    step: 4,
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
        let policy = &metadata["algorithm_policy"];
        assert_eq!(policy["metric"], "mu0_ms_fem_lumped_volume");
        assert_eq!(policy["gradient_metric"], "mu0_ms_fem_lumped_volume");
        assert_eq!(policy["gradient_units"], "A/m");
        assert_eq!(policy["search_direction_units"], "A/m");
        assert_eq!(policy["line_search_step_units"], "m/A");
        assert_eq!(policy["armijo_slope_units"], "J A/m");
        assert_eq!(policy["armijo_decrement_units"], "J");
        assert_eq!(policy["armijo_derivative_units"], "J");

        let requested_only = ExecutionProvenance {
            resolved_energy_minimizer: None,
            ..provenance.clone()
        };
        let unresolved = fem_cpu_relaxation_qualification_metadata(
            &plan,
            &requested_only,
            &demag_runtime,
            &executed,
        );
        assert!(unresolved["algorithm_policy"]["metric"].is_null());
        assert!(unresolved["algorithm_policy"]["armijo_derivative_units"].is_null());

        let bogus_realization = ExecutionProvenance {
            energy_minimizer_realization: Some("bogus_native_realization".to_string()),
            ..provenance
        };
        let bogus = fem_cpu_relaxation_qualification_metadata(
            &plan,
            &bogus_realization,
            &demag_runtime,
            &executed,
        );
        assert!(bogus["algorithm_policy"]["metric"].is_null());
        assert!(bogus["algorithm_policy"]["gradient_metric"].is_null());
        assert!(bogus["algorithm_policy"]["armijo_derivative_units"].is_null());
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
                    max_relaxation_time_s: None,
                },
            });
        }
        let provenance = ExecutionProvenance {
            execution_engine: "fem_cpu_native".to_string(),
            precision: "double".to_string(),
            resolved_energy_minimizer: Some("nonlinear_cg".to_string()),
            energy_minimizer_realization: Some("native_mfem_nonlinear_cg".to_string()),
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
                completion: Some(fullmag_ir::StageCompletionIR {
                    status: "completed".to_string(),
                    converged: false,
                    reason: Some(fullmag_ir::StageStopReason::MaxSteps),
                    metric: Some(fullmag_ir::StageMetricKind::Steps),
                    metric_name: Some("step".to_string()),
                    metric_value: Some(4.0),
                    threshold: Some(4.0),
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
                    max_relaxation_time_s: None,
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
                    facet_global_ordinals: Vec::new(),
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
                    facet_global_ordinals: Vec::new(),
                    bounds_min: None,
                    bounds_max: None,
                    parent_id: None,
                },
            ];
        }
        let provenance = ExecutionProvenance {
            execution_engine: "fem_cpu_native".to_string(),
            precision: "double".to_string(),
            energy_minimizer_realization: None,
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
                    max_relaxation_time_s: None,
                },
            });
        }
        let provenance = ExecutionProvenance {
            execution_engine: "fem_native_gpu".to_string(),
            precision: "double".to_string(),
            requested_energy_minimizer: Some("nonlinear_cg".to_string()),
            resolved_energy_minimizer: Some("nonlinear_cg".to_string()),
            energy_minimizer_realization: Some("native_cuda_nonlinear_cg".to_string()),
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
                completion: Some(fullmag_ir::StageCompletionIR {
                    status: "completed".to_string(),
                    converged: false,
                    reason: Some(fullmag_ir::StageStopReason::MaxSteps),
                    metric: Some(fullmag_ir::StageMetricKind::Steps),
                    metric_name: Some("step".to_string()),
                    metric_value: Some(4.0),
                    threshold: Some(4.0),
                }),
            },
            initial_magnetization: vec![[1.0, 0.0, 0.0]; 4],
            field_snapshots: Vec::new(),
            field_snapshot_count: 0,
            auxiliary_artifacts: Vec::new(),
            provenance: provenance.clone(),
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
            "mu0_ms_fem_lumped_volume"
        );
        assert_eq!(qualification["algorithm_policy"]["gradient_units"], "A/m");
        assert_eq!(
            qualification["algorithm_policy"]["search_direction_units"],
            "A/m"
        );
        assert_eq!(
            qualification["algorithm_policy"]["line_search_step_units"],
            "m/A"
        );
        assert_eq!(
            qualification["algorithm_policy"]["armijo_slope_units"],
            "J A/m"
        );
        assert_eq!(
            qualification["algorithm_policy"]["armijo_decrement_units"],
            "J"
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
        assert_eq!(qualification["stop_reason"], "max_steps");
        assert_eq!(qualification["stop_metric_name"], "step");
        assert_eq!(qualification["stop_metric_value"], 4.0);
        assert_eq!(qualification["stop_threshold"], 4.0);
        assert_eq!(qualification["final_energy_terms_j"]["E_ex"], 1.0);
        assert_eq!(qualification["final_energy_terms_j"]["E_demag"], 2.0);
        assert_eq!(qualification["final_energy_terms_j"]["E_total"], 3.0);
        assert_eq!(qualification["final_torque_apm"], 2.0e-4);
        let bogus_realization = ExecutionProvenance {
            energy_minimizer_realization: Some("bogus_native_realization".to_string()),
            ..provenance
        };
        let bogus = fem_gpu_relaxation_qualification_metadata(&plan, &bogus_realization, &executed);
        assert!(bogus["algorithm_policy"]["metric"].is_null());
        assert!(bogus["algorithm_policy"]["gradient_metric"].is_null());
        assert!(bogus["algorithm_policy"]["armijo_derivative_units"].is_null());
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
                    max_relaxation_time_s: None,
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
        assert_eq!(layout["origin_m"], serde_json::json!([0.0, 0.0, 0.0]));
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
            fem_crossover_decision: None,
            requested_integrator: None,
            resolved_integrator: None,
            requested_energy_minimizer: None,
            resolved_energy_minimizer: None,
            energy_minimizer_realization: None,
            requested_demag_realization: None,
            resolved_demag_realization: None,
            timestep_policy: None,
            fdm_multilayer_transfer_telemetry: None,
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
        fem.mesh.set_tet4_cells(vec![[1, 3, 5, 4]]);
        fem.mesh.set_tri3_facets(vec![[1, 3, 5]]);
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
            facet_global_ordinals: vec![0],
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
            [1.0e-6, 1.0e-6, 0.0],
        ];
        fem.mesh
            .set_tet4_cells(vec![[0, 1, 2, 3], [0, 1, 4, 5], [1, 4, 5, 6]]);
        fem.mesh.element_markers = vec![1, 0, 0];
        fem.mesh.set_tri3_facets(vec![[0, 2, 4], [1, 5, 3]]);
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
            pairing_policy: Some("explicit_node_pairs".to_string()),
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

        write_periodic_pairs_artifact(&output_dir, &plan, Some(46))
            .expect("periodic pairs artifact should be written");

        let artifact: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(output_dir.join("mesh/periodic_pairs.v1.json"))
                .expect("periodic pairs artifact should exist"),
        )
        .expect("periodic pairs artifact should parse");
        assert_eq!(artifact["schema_version"], "periodic_pairs.v1");
        assert_eq!(artifact["artifact_path"], "mesh/periodic_pairs.v1.json");
        assert_eq!(artifact["validation_status"], "ok");
        assert!(artifact["mesh_generation_id"].as_str().is_some());
        assert_eq!(artifact["source_scene_revision"], 46);
        assert!(artifact["certificate_fingerprint"].as_str().is_some());
        assert_eq!(artifact["certificate_status"], "accepted");
        assert!(artifact["certificate"]["marker_map_fingerprint"]
            .as_str()
            .is_some());
        assert!(artifact["certificate"]["material_realization_fingerprint"]
            .as_str()
            .is_some());
        assert_eq!(artifact["pair_count"], 1);
        assert_eq!(artifact["paired_node_count"], 3);
        assert_eq!(artifact["pairs"][0]["pair_id"], "x_periodic");
        assert_eq!(artifact["pairs"][0]["paired_node_count"], 3);
        assert_eq!(artifact["pairs"][0]["unpaired_source_node_count"], 0);
        assert_eq!(artifact["pairs"][0]["unpaired_destination_node_count"], 0);
        assert_eq!(
            artifact["pairs"][0]["domain_node_pair_counts"],
            serde_json::json!({"magnetic": 2, "airbox": 1})
        );
        let face_pair = &artifact["pairs"][0]["boundary_face_pairs"][0];
        assert_eq!(face_pair["face_a"], 0);
        assert_eq!(face_pair["face_b"], 1);
        assert_eq!(
            face_pair["translation_m"],
            serde_json::json!([1.0e-6, 0.0, 0.0])
        );
        assert_eq!(face_pair["normal_dot"], -1.0);
        assert_eq!(face_pair["orientation"], "opposed_normals");
        assert_eq!(
            face_pair["vertex_pairs"],
            serde_json::json!([[0, 1], [2, 3], [4, 5]])
        );
        assert_eq!(face_pair["translation_residual_m"], 0.0);
        assert_eq!(face_pair["area_residual_m2"], 0.0);
        assert_eq!(
            artifact["pairs"][0]["node_pairs"],
            serde_json::json!([
                {"node_a": 0, "node_b": 1},
                {"node_a": 2, "node_b": 3},
                {"node_a": 4, "node_b": 5},
            ])
        );
        assert_eq!(artifact["pairs"][0]["max_residual_m"], 0.0);
        assert_eq!(artifact["pairs"][0]["status"], "valid");

        fs::remove_dir_all(output_dir).expect("temporary artifact directory should be removable");
    }

    #[test]
    fn periodic_certificate_identity_rejects_stale_topology_fingerprint() {
        let mesh = fullmag_ir::MeshIR {
            mesh_name: "identity-test".to_string(),
            nodes: Vec::new(),
            cells: fullmag_ir::FemConnectivityIR::from_tet4(Vec::new()),
            element_markers: Vec::new(),
            facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(Vec::new()),
            boundary_markers: Vec::new(),
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            per_domain_quality: std::collections::HashMap::new(),
        };
        let certificate = fullmag_ir::PeriodicMeshCertificateV6IR {
            schema_version: "periodic_mesh_certificate.v6".to_string(),
            certificate_status: "accepted".to_string(),
            topology_fingerprint: "sha256:stale".to_string(),
            axis_pairs: Vec::new(),
            magnetic_class_count: 0,
            magnetic_pair_count: 0,
            scalar_class_count: 0,
            scalar_pair_count: 0,
            magnetic_equivalence_classes_sha256: "sha256:empty".to_string(),
            scalar_equivalence_classes_sha256: "sha256:empty".to_string(),
            translation_residual_max_m: 0.0,
            orientation_residual_max: 0.0,
            normal_mismatch_max: 0.0,
            boundary_topology_match: true,
            fe_order_match: true,
            material_region_match: true,
            corner_edge_cycle_unique: true,
            edge_class_count: 0,
            corner_class_count: 0,
            max_commutation_residual_m: 0.0,
            m0_seam_mismatch_max: 0.0,
            h_demag0_seam_mismatch_max: 0.0,
            marker_map_fingerprint: "sha256:empty".to_string(),
            material_realization_fingerprint: "sha256:empty".to_string(),
            region_class_count: 0,
            max_material_residual: 0.0,
        };
        let errors = validate_periodic_certificate_identity(&mesh, certificate)
            .expect_err("stale certificate identity must fail closed");
        assert!(errors
            .iter()
            .any(|error| error.contains("topology fingerprint")));
    }

    #[test]
    fn periodic_pairs_artifact_rejects_uncertified_face_orientation() {
        let mut plan = test_fem_execution_plan();
        let BackendPlanIR::Fem(fem) = &mut plan.backend_plan else {
            panic!("test plan must be FEM");
        };
        fem.mesh.nodes = vec![
            [0.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [1.0, 0.0, 1.0],
            [2.0, 0.0, 0.0],
            [2.0, 1.0, 0.0],
            [3.0, 0.0, 1.0],
        ];
        fem.mesh.set_tet4_cells(Vec::new());
        fem.mesh.set_tri3_facets(vec![[0, 1, 2], [3, 4, 5]]);
        fem.mesh.boundary_markers = vec![10, 11];
        fem.mesh.periodic_boundary_pairs = vec![fullmag_ir::MeshPeriodicBoundaryPairIR {
            pair_id: "diagonal_faces".to_string(),
            source_marker: Some("source".to_string()),
            destination_marker: Some("destination".to_string()),
            marker_a: 10,
            marker_b: 11,
            translation: Some([2.0, 0.0, 0.0]),
            tolerance: Some(1.0e-12),
            axis_hint: Some("x".to_string()),
            orientation: Some("mirrored".to_string()),
            pairing_policy: Some("explicit_node_pairs".to_string()),
        }];
        fem.mesh.periodic_node_pairs = vec![
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "diagonal_faces".to_string(),
                node_a: 0,
                node_b: 3,
            },
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "diagonal_faces".to_string(),
                node_a: 1,
                node_b: 4,
            },
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "diagonal_faces".to_string(),
                node_a: 2,
                node_b: 5,
            },
        ];

        let boundary_pair = &fem.mesh.periodic_boundary_pairs[0];
        let face_pairs = mesh_periodic_boundary_face_pairs(&fem.mesh, boundary_pair);
        assert_eq!(face_pairs.len(), 1);
        assert_eq!(face_pairs[0]["face_a"], 0);
        assert_eq!(face_pairs[0]["face_b"], 1);
        let normal_dot = face_pairs[0]["normal_dot"]
            .as_f64()
            .expect("face normal dot should be numeric");
        assert!((normal_dot - 1.0).abs() < 1.0e-12);

        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-artifacts-periodic-uncertified-{}",
            std::process::id()
        ));
        write_periodic_pairs_artifact(&output_dir, &plan, None)
            .expect("periodic pairs artifact should record failed certificate evidence");
        let artifact: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(output_dir.join("mesh/periodic_pairs.v1.json"))
                .expect("periodic pairs artifact should exist"),
        )
        .expect("periodic pairs artifact should parse");
        assert_eq!(artifact["validation_status"], "failed");
        assert_eq!(artifact["certificate_status"], "rejected");
        assert_ne!(artifact["pairs"][0]["status"], "valid");
        assert!(artifact["pairs"][0]["boundary_face_pairs"]
            .as_array()
            .unwrap()
            .is_empty());

        fs::remove_dir_all(output_dir).expect("temporary artifact directory should be removable");
    }

    #[test]
    fn periodic_face_pairs_use_explicit_node_bijection_not_centroid() {
        let mut plan = test_fem_execution_plan();
        let BackendPlanIR::Fem(fem) = &mut plan.backend_plan else {
            panic!("test plan must be FEM");
        };
        fem.mesh.nodes = vec![
            [0.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [1.0, 0.0, 1.0],
            [2.0, 0.0, 0.0],
            [2.0, 1.0, 0.0],
            [3.0, 0.0, 1.0],
            [2.2, 0.0, 0.0],
            [2.3, 0.5, 0.5],
            [2.5, 0.5, 0.5],
        ];
        fem.mesh
            .set_tri3_facets(vec![[0, 1, 2], [6, 7, 8], [3, 5, 4]]);
        fem.mesh.boundary_markers = vec![10, 11, 11];
        let boundary_pair = fullmag_ir::MeshPeriodicBoundaryPairIR {
            pair_id: "diagonal_faces".to_string(),
            source_marker: None,
            destination_marker: None,
            marker_a: 10,
            marker_b: 11,
            translation: Some([2.0, 0.0, 0.0]),
            tolerance: Some(1.0e-12),
            axis_hint: Some("x".to_string()),
            orientation: None,
            pairing_policy: Some("explicit_node_pairs".to_string()),
        };
        fem.mesh.periodic_node_pairs = vec![
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "diagonal_faces".to_string(),
                node_a: 0,
                node_b: 3,
            },
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "diagonal_faces".to_string(),
                node_a: 1,
                node_b: 4,
            },
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "diagonal_faces".to_string(),
                node_a: 2,
                node_b: 5,
            },
        ];

        assert_eq!(
            mesh_periodic_boundary_face_index_pairs(&fem.mesh, &boundary_pair),
            vec![(0, 2)]
        );
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
        fem.mesh.set_tri3_facets(vec![[0, 3, 7], [1, 6, 2]]);
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
                    mesh_build_report: None,
                    mesh_name: fem.mesh_name,
                    mesh_source: fem.mesh_source,
                    mesh: fem.mesh,
                    object_segments: fem.object_segments,
                    mesh_parts: fem.mesh_parts,
                    domain_mesh_mode: fem.domain_mesh_mode,
                    domain_mesh_workflow_mode: None,
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
                    magnetostatic_bc: fullmag_ir::MagnetostaticBoundaryConditionIR::default(),
                    excitation: fullmag_ir::FrequencyExcitationIR {
                        field_au_per_m: [0.0, 0.0, 1.0],
                        phase_rad: 0.0,
                    },
                    frequencies_hz: fullmag_ir::FrequencySweepIR {
                        values_hz: vec![1.0e9, 2.0e9],
                    },
                    solver_policy: None,
                    enable_exchange: fem.enable_exchange,
                    enable_demag: fem.enable_demag,
                    interfacial_dmi: fem.interfacial_dmi,
                    dmi_interface_normal: fem.dmi_interface_normal,
                    bulk_dmi: fem.bulk_dmi,
                    external_field: fem.external_field,
                    gyromagnetic_ratio: fem.gyromagnetic_ratio,
                    precision: fem.precision,
                    requested_device: fullmag_ir::ExecutionDevice::Cpu,
                    exchange_bc: fem.exchange_bc,
                    demag_realization: fem.demag_realization,
                    air_box_config: fem.air_box_config,
                    demag_solver_policy: None,
                    periodic_constraint_sets: Vec::new(),
                    equilibrium_provenance: None,
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

        write_periodic_pairs_artifact(&output_dir, &plan, None)
            .expect("frequency-response periodic pairs artifact should be written");

        let artifact: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(output_dir.join("mesh/periodic_pairs.v1.json"))
                .expect("periodic pairs artifact should exist"),
        )
        .expect("periodic pairs artifact should parse");
        assert_eq!(artifact["schema_version"], "periodic_pairs.v1");
        assert_eq!(artifact["artifact_path"], "mesh/periodic_pairs.v1.json");
        assert_eq!(artifact["validation_status"], "ok");
        assert_eq!(artifact["pair_count"], 1);
        assert_eq!(artifact["paired_node_count"], 3);
        assert_eq!(artifact["pairs"][0]["pair_id"], "x_faces");
        assert_eq!(artifact["pairs"][0]["paired_node_count"], 3);
        assert_eq!(artifact["pairs"][0]["status"], "valid");

        fs::remove_dir_all(output_dir).expect("temporary artifact directory should be removable");
    }

    #[test]
    fn write_artifacts_persists_frequency_response_periodic_pairs() {
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
        fem.mesh.set_tri3_facets(vec![[0, 3, 7], [1, 6, 2]]);
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
                    mesh_build_report: None,
                    mesh_name: fem.mesh_name,
                    mesh_source: fem.mesh_source,
                    mesh: fem.mesh,
                    object_segments: fem.object_segments,
                    mesh_parts: fem.mesh_parts,
                    domain_mesh_mode: fem.domain_mesh_mode,
                    domain_mesh_workflow_mode: None,
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
                    magnetostatic_bc: fullmag_ir::MagnetostaticBoundaryConditionIR::default(),
                    excitation: fullmag_ir::FrequencyExcitationIR {
                        field_au_per_m: [0.0, 0.0, 1.0],
                        phase_rad: 0.0,
                    },
                    frequencies_hz: fullmag_ir::FrequencySweepIR {
                        values_hz: vec![1.0e9],
                    },
                    solver_policy: None,
                    enable_exchange: fem.enable_exchange,
                    enable_demag: false,
                    interfacial_dmi: fem.interfacial_dmi,
                    dmi_interface_normal: fem.dmi_interface_normal,
                    bulk_dmi: fem.bulk_dmi,
                    external_field: fem.external_field,
                    gyromagnetic_ratio: fem.gyromagnetic_ratio,
                    precision: fem.precision,
                    requested_device: fullmag_ir::ExecutionDevice::Cpu,
                    exchange_bc: fem.exchange_bc,
                    demag_realization: None,
                    air_box_config: None,
                    demag_solver_policy: None,
                    periodic_constraint_sets: Vec::new(),
                    equilibrium_provenance: None,
                },
            ),
            output_plan,
            provenance,
        };
        let problem = fullmag_ir::ProblemIR::bootstrap_example();
        let executed = ExecutedRun {
            result: RunResult {
                status: RunStatus::Completed,
                steps: Vec::new(),
                final_magnetization: vec![[1.0, 0.0, 0.0]; 8],
                completion: None,
            },
            initial_magnetization: vec![[1.0, 0.0, 0.0]; 8],
            field_snapshots: Vec::new(),
            field_snapshot_count: 0,
            auxiliary_artifacts: Vec::new(),
            provenance: ExecutionProvenance {
                execution_engine: "runner.frequency_response_test".to_string(),
                precision: "double".to_string(),
                ..ExecutionProvenance::default()
            },
        };
        let unique_suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-artifacts-frequency-response-write-periodic-pairs-{}-{}",
            std::process::id(),
            unique_suffix
        ));

        write_artifacts(&output_dir, &problem, &plan, &executed, None)
            .expect("frequency-response artifact write should succeed");

        let artifact: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(output_dir.join("mesh/periodic_pairs.v1.json"))
                .expect("periodic pairs artifact should exist"),
        )
        .expect("periodic pairs artifact should parse");
        assert_eq!(artifact["schema_version"], "periodic_pairs.v1");
        assert_eq!(artifact["pairs"][0]["pair_id"], "x_faces");
        assert_eq!(artifact["pairs"][0]["paired_node_count"], 3);
        assert_eq!(artifact["pairs"][0]["status"], "valid");

        let native_output_dir = std::env::temp_dir().join(format!(
            "fullmag-artifacts-frequency-response-native-periodic-pairs-{}-{}",
            std::process::id(),
            unique_suffix
        ));
        let native_mesh_dir = native_output_dir.join("mesh");
        fs::create_dir_all(&native_mesh_dir).expect("native mesh artifact dir should exist");
        fs::write(
            native_mesh_dir.join("periodic_pairs.v1.json"),
            serde_json::to_string_pretty(&serde_json::json!({
                "schema_version": "periodic_pairs.v1",
                "source": "native_fem_frequency_domain_static_periodic",
                "validation_status": "ok",
                "pair_count": 4,
                "paired_node_count": 8,
                "unpaired_source_count": 0,
                "unpaired_destination_count": 0,
                "max_translation_residual_m": 0.0,
                "residual_diagnostics": {
                    "static_periodic_frame_max_mismatch": 0.0,
                    "static_periodic_drive_max_mismatch": 0.0
                },
                "pairs": [
                    {
                        "pair_id": "static-periodic-0000",
                        "source_marker": "node:0",
                        "destination_marker": "node:1",
                        "translation_residual_m": 0.0,
                        "validation_status": "ok"
                    }
                ]
            }))
            .expect("native periodic pairs fixture should serialize"),
        )
        .expect("native periodic pairs fixture should be written");
        let native_executed = ExecutedRun {
            provenance: ExecutionProvenance {
                execution_engine: "native_fem.frequency_domain.production_cpu".to_string(),
                precision: "double".to_string(),
                ..ExecutionProvenance::default()
            },
            ..executed.clone()
        };

        write_artifacts(&native_output_dir, &problem, &plan, &native_executed, None)
            .expect("native frequency-response artifact write should preserve backend artifact");

        let native_artifact: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(native_output_dir.join("mesh/periodic_pairs.v1.json"))
                .expect("native periodic pairs artifact should still exist"),
        )
        .expect("native periodic pairs artifact should parse");
        assert_eq!(
            native_artifact["source"],
            "native_fem_frequency_domain_static_periodic"
        );
        assert_eq!(native_artifact["pair_count"], 4);
        assert_eq!(
            native_artifact["pairs"][0]["pair_id"],
            "static-periodic-0000"
        );

        fs::remove_dir_all(native_output_dir)
            .expect("native temporary artifact directory should be removable");
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
            fem_crossover_decision: None,
            requested_integrator: None,
            resolved_integrator: None,
            requested_energy_minimizer: None,
            resolved_energy_minimizer: None,
            energy_minimizer_realization: None,
            requested_demag_realization: None,
            resolved_demag_realization: None,
            timestep_policy: None,
            fdm_multilayer_transfer_telemetry: None,
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
                name: "H_oe".to_string(),
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
            .expect("H_oe artifact write should succeed");

        let field_json: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(output_dir.join("fields/H_oe/step_000001.json"))
                .expect("H_oe artifact should exist"),
        )
        .expect("H_OE artifact should parse");
        assert_eq!(field_json["observable"], "H_oe");
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
    fn metadata_copies_periodic_antidot_relaxation_runtime_provenance() {
        let mut problem = fullmag_ir::ProblemIR::bootstrap_example();
        problem.problem_meta.name = "fem_periodic_antidot_relax_air_gap".to_string();
        problem.pbc = Some(fullmag_ir::FdmPeriodicityIR {
            axes: [
                fullmag_ir::AxisBoundary::Periodic,
                fullmag_ir::AxisBoundary::Periodic,
                fullmag_ir::AxisBoundary::Open,
            ],
            demag: fullmag_ir::FdmDemagPeriodicityIR::PeriodicAirboxK0,
            image_counts: None,
        });
        problem.problem_meta.runtime_metadata.insert(
            "periodic_antidot_relaxation".to_string(),
            serde_json::json!({
                "scenario": "air_gap",
                "exchange_coupled_across_periods": false,
                "magnetostatic_pbc": "periodic_airbox_k0",
                "periodic_pair_ids": ["x_faces", "y_faces"],
                "film_size_m": [2.0e-7, 2.0e-7, 1.0e-8],
                "universe_size_m": [3.2e-7, 3.2e-7, 9.0e-8],
                "lateral_air_gap_m": [1.2e-7, 1.2e-7],
            }),
        );
        let plan = test_periodic_fem_execution_plan();
        let unique_suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-periodic-antidot-relaxation-metadata-{}-{}",
            std::process::id(),
            unique_suffix
        ));

        let executed = ExecutedRun {
            result: RunResult {
                status: RunStatus::Completed,
                steps: vec![StepStats {
                    step: 4,
                    max_torque_T: 1.0e-3,
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
                execution_engine: "fem_cpu_native".to_string(),
                precision: "double".to_string(),
                ..ExecutionProvenance::default()
            },
        };

        write_artifacts(&output_dir, &problem, &plan, &executed, None)
            .expect("artifact write should preserve periodic antidot metadata");

        let metadata: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(output_dir.join("metadata.json")).expect("metadata should exist"),
        )
        .expect("metadata should parse");
        assert_eq!(
            metadata["periodic_antidot_relaxation"]["scenario"],
            "air_gap"
        );
        assert_eq!(
            metadata["periodic_antidot_relaxation"]["magnetostatic_pbc"],
            "periodic_airbox_k0"
        );
        assert_eq!(
            metadata["periodic_antidot_relaxation"]["periodic_pair_ids"],
            serde_json::json!(["x_faces", "y_faces"])
        );
        assert_eq!(
            metadata["pbc"],
            serde_json::json!({
                "axes": ["periodic", "periodic", "open"],
                "demag": "periodic_airbox_k0",
            })
        );
        assert_eq!(metadata["mesh"]["periodic_boundary_pair_count"], 2);
        assert_eq!(metadata["mesh"]["periodic_node_pair_count"], 2);
        assert_eq!(
            metadata["mesh"]["periodic_boundary_pair_counts_by_id"]["x_faces"],
            1
        );
        assert_eq!(
            metadata["mesh"]["periodic_node_pair_counts_by_id"]["y_faces"],
            1
        );

        fs::remove_dir_all(output_dir).expect("temporary artifact directory should be removable");
    }

    #[test]
    fn supercell_runtime_metadata_writes_fem_node_geometry_artifact() {
        let mut problem = fullmag_ir::ProblemIR::bootstrap_example();
        problem.problem_meta.name =
            "fem_periodic_antidot_relax_exchange_coupled_supercell_3x3".to_string();
        problem.problem_meta.runtime_metadata.insert(
            "periodic_antidot_relaxation".to_string(),
            serde_json::json!({
                "scenario": "exchange_coupled",
                "exchange_coupled_across_periods": true,
                "magnetostatic_pbc": "periodic_airbox_k0",
                "periodic_pair_ids": ["x_faces", "y_faces"],
                "film_size_m": [2.0e-7, 2.0e-7, 1.0e-8],
                "universe_size_m": [6.0e-7, 6.0e-7, 9.0e-8],
                "lateral_air_gap_m": [0.0, 0.0],
                "supercell_repeat": [3, 3],
            }),
        );
        let plan = test_fem_execution_plan();
        let unique_suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-artifacts-supercell-node-geometry-{}-{}",
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
                ..ExecutionProvenance::default()
            },
        };

        write_artifacts(&output_dir, &problem, &plan, &executed, None)
            .expect("supercell node geometry artifact should write");

        let artifact: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(output_dir.join("mesh/node_geometry.v1.json"))
                .expect("node geometry artifact should exist"),
        )
        .expect("node geometry artifact should parse");
        assert_eq!(artifact["schema_version"], "fem_mesh_node_geometry.v1");
        assert_eq!(artifact["artifact_path"], "mesh/node_geometry.v1.json");
        assert_eq!(artifact["node_count"], 4);
        assert_eq!(artifact["nodes_m"][1], serde_json::json!([1.0, 0.0, 0.0]));
        assert_eq!(
            artifact["magnetic_node_mask"],
            serde_json::json!([true, true, true, true])
        );
        assert_eq!(artifact["magnetic_node_count"], 4);
        assert_eq!(artifact["field_cell_alignment"]["H_demag"], "node_index");
        assert_eq!(artifact["field_cell_alignment"]["H_eff"], "node_index");
        assert_eq!(artifact["field_cell_alignment"]["demag_phi"], "node_index");

        fs::remove_dir_all(output_dir).expect("temporary artifact directory should be removable");
    }

    #[test]
    fn primitive_periodic_antidot_does_not_write_supercell_node_geometry_artifact() {
        let mut problem = fullmag_ir::ProblemIR::bootstrap_example();
        problem.problem_meta.name = "fem_periodic_antidot_relax_exchange_coupled".to_string();
        problem.problem_meta.runtime_metadata.insert(
            "periodic_antidot_relaxation".to_string(),
            serde_json::json!({
                "scenario": "exchange_coupled",
                "exchange_coupled_across_periods": true,
                "magnetostatic_pbc": "periodic_airbox_k0",
                "periodic_pair_ids": ["x_faces", "y_faces"],
                "film_size_m": [2.0e-7, 2.0e-7, 1.0e-8],
                "universe_size_m": [2.0e-7, 2.0e-7, 9.0e-8],
                "lateral_air_gap_m": [0.0, 0.0],
            }),
        );
        let plan = test_fem_execution_plan();
        let unique_suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-artifacts-primitive-node-geometry-{}-{}",
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
                ..ExecutionProvenance::default()
            },
        };

        write_artifacts(&output_dir, &problem, &plan, &executed, None)
            .expect("primitive artifacts should write");

        assert!(!output_dir.join("mesh/node_geometry.v1.json").exists());

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

    #[test]
    fn write_artifacts_persists_static_pbc_demag_seam_diagnostics() {
        let mut problem = fullmag_ir::ProblemIR::bootstrap_example();
        problem.problem_meta.name = "fem_periodic_antidot_relax_air_gap".to_string();
        problem.pbc = Some(fullmag_ir::FdmPeriodicityIR {
            axes: [
                fullmag_ir::AxisBoundary::Periodic,
                fullmag_ir::AxisBoundary::Periodic,
                fullmag_ir::AxisBoundary::Open,
            ],
            demag: fullmag_ir::FdmDemagPeriodicityIR::PeriodicAirboxK0,
            image_counts: None,
        });
        let mut plan = test_periodic_fem_execution_plan();
        let BackendPlanIR::Fem(fem) = &mut plan.backend_plan else {
            panic!("test plan should be FEM");
        };
        fem.enable_demag = true;
        fem.material.saturation_magnetisation = 800e3;
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
        fem.mesh.set_tet4_cells(vec![[0, 1, 2, 4], [3, 5, 6, 7]]);
        fem.mesh.element_markers = vec![1, 1];
        fem.mesh.set_tri3_facets(vec![
            [0, 3, 7],
            [0, 7, 4],
            [1, 5, 6],
            [1, 6, 2],
            [0, 4, 5],
            [0, 5, 1],
            [3, 2, 6],
            [3, 6, 7],
        ]);
        fem.mesh.boundary_markers = vec![1, 1, 2, 2, 3, 3, 4, 4];
        fem.mesh.periodic_boundary_pairs = vec![
            fullmag_ir::MeshPeriodicBoundaryPairIR {
                pair_id: "x_faces".to_string(),
                source_marker: Some("x_min".to_string()),
                destination_marker: Some("x_max".to_string()),
                marker_a: 1,
                marker_b: 2,
                translation: Some([40.0e-9, 0.0, 0.0]),
                tolerance: Some(1.0e-12),
                axis_hint: Some("x".to_string()),
                orientation: Some("opposed_normals".to_string()),
                pairing_policy: Some("explicit_node_pairs".to_string()),
            },
            fullmag_ir::MeshPeriodicBoundaryPairIR {
                pair_id: "y_faces".to_string(),
                source_marker: Some("y_min".to_string()),
                destination_marker: Some("y_max".to_string()),
                marker_a: 3,
                marker_b: 4,
                translation: Some([0.0, 20.0e-9, 0.0]),
                tolerance: Some(1.0e-12),
                axis_hint: Some("y".to_string()),
                orientation: Some("opposed_normals".to_string()),
                pairing_policy: Some("explicit_node_pairs".to_string()),
            },
        ];
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
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "y_faces".to_string(),
                node_a: 0,
                node_b: 3,
            },
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "y_faces".to_string(),
                node_a: 1,
                node_b: 2,
            },
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "y_faces".to_string(),
                node_a: 4,
                node_b: 7,
            },
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "y_faces".to_string(),
                node_a: 5,
                node_b: 6,
            },
        ];

        let unique_suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-static-pbc-demag-seams-{}-{}",
            std::process::id(),
            unique_suffix
        ));

        let executed = ExecutedRun {
            result: RunResult {
                status: RunStatus::Completed,
                steps: vec![StepStats {
                    step: 4,
                    time: 2.0e-12,
                    dt: 5.0e-13,
                    e_demag: 1.0e-21,
                    ..StepStats::default()
                }],
                final_magnetization: vec![[1.0, 0.0, 0.0]; 8],
                completion: None,
            },
            initial_magnetization: vec![[1.0, 0.0, 0.0]; 8],
            field_snapshots: vec![
                FieldSnapshot {
                    name: "H_demag".to_string(),
                    step: 4,
                    time: 2.0e-12,
                    solver_dt: 5.0e-13,
                    values: vec![[10.0, 2.0, 0.0]; 8],
                },
                FieldSnapshot {
                    name: "demag_phi".to_string(),
                    step: 4,
                    time: 2.0e-12,
                    solver_dt: 5.0e-13,
                    values: vec![
                        [1.0e-6, 0.0, 0.0],
                        [3.0e-6, 0.0, 0.0],
                        [3.0e-6, 0.0, 0.0],
                        [1.0e-6, 0.0, 0.0],
                        [1.0e-6, 0.0, 0.0],
                        [3.0e-6, 0.0, 0.0],
                        [3.0e-6, 0.0, 0.0],
                        [1.0e-6, 0.0, 0.0],
                    ],
                },
            ],
            field_snapshot_count: 2,
            auxiliary_artifacts: Vec::new(),
            provenance: ExecutionProvenance {
                execution_engine: "fem_cpu_native".to_string(),
                precision: "double".to_string(),
                ..ExecutionProvenance::default()
            },
        };

        write_artifacts(&output_dir, &problem, &plan, &executed, None)
            .expect("artifact write should persist static PBC demag seam diagnostics");

        let artifact: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(output_dir.join("diagnostics/fem_static_pbc_demag_seams.v1.json"))
                .expect("static PBC demag seam diagnostics artifact should exist"),
        )
        .expect("static PBC demag seam diagnostics artifact should parse");
        assert_eq!(artifact["schema_version"], "fem_static_pbc_demag_seams.v1");
        assert_eq!(
            artifact["artifact_path"],
            "diagnostics/fem_static_pbc_demag_seams.v1.json"
        );
        assert_eq!(artifact["status"], "ok");
        assert_eq!(artifact["step"], 4);
        assert_eq!(
            artifact["pair_diagnostics"].as_array().map(Vec::len),
            Some(2)
        );
        assert_eq!(artifact["pair_diagnostics"][0]["pair_id"], "x_faces");
        assert_eq!(artifact["pair_diagnostics"][0]["m_seam_max"], 0.0);
        assert_eq!(artifact["pair_diagnostics"][0]["h_demag_seam_max_Apm"], 0.0);
        assert_eq!(
            artifact["pair_diagnostics"][0]["demag_phi_seam_max_after_offset_A"],
            0.0
        );
        assert_eq!(
            artifact["pair_diagnostics"][0]["b_normal_flux_seam_max_T"],
            0.0
        );
        assert_eq!(
            artifact["pair_diagnostics"][0]["side_magnetic_charge_sum_abs_Am"],
            0.0
        );

        fs::remove_dir_all(output_dir).expect("temporary artifact directory should be removable");
    }
}
