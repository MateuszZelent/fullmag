//! Artifact writing: metadata, scalars CSV, field snapshots.

use crate::artifact_pipeline::ArtifactPipelineSummary;
use fullmag_ir::BackendPlanIR;

use crate::types::{ExecutedRun, StepStats};

use std::fs;
use std::io::Write;
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
            let resolved_demag = fem
                .demag_realization
                .unwrap_or(fullmag_ir::ResolvedFemDemagIR::PoissonRobin);
            let last = steps.last();
            let boundary_variant = match resolved_demag {
                fullmag_ir::ResolvedFemDemagIR::PoissonDirichlet => Some("dirichlet"),
                fullmag_ir::ResolvedFemDemagIR::PoissonRobin => Some("robin"),
                _ => None,
            };

            serde_json::json!({
                "model": resolved_demag.model_name(),
                "boundary_variant": boundary_variant,
                "linear_solver": policy.solver,
                "preconditioner": policy.preconditioner,
                "relative_tolerance": policy.rtol,
                "max_iterations": policy.max_iterations,
                "actual_iterations": last.map(|entry| entry.poisson_iterations),
                "final_residual_norm": last.map(|entry| entry.poisson_final_residual),
                "mfem_device": provenance.mfem_device,
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
        "engine_version": env!("CARGO_PKG_VERSION"),
        "status": executed.result.status,
        "scalar_rows": executed.result.steps.len(),
        "field_snapshots": executed.field_snapshot_count,
    });
    let metadata_path = output_dir.join("metadata.json");
    let mut metadata_file = fs::File::create(&metadata_path)?;
    metadata_file.write_all(serde_json::to_string_pretty(&metadata).unwrap().as_bytes())?;

    if streamed.is_none_or(|summary| summary.scalar_rows_written == 0) {
        write_scalars_csv(&output_dir.join("scalars.csv"), &executed.result.steps)?;
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
            let observable_dir = fields_dir.join(&snapshot.name);
            fs::create_dir_all(&observable_dir)?;
            let snapshot_path = observable_dir.join(format!("step_{:06}.json", snapshot.step));
            write_field_file(
                &snapshot_path,
                &field_context,
                &execution_provenance,
                &snapshot.name,
                snapshot.step,
                snapshot.time,
                snapshot.solver_dt,
                &snapshot.values,
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

    Ok(())
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
    }
}

pub(crate) fn field_unit(observable: &str) -> &'static str {
    match observable {
        "m" => "dimensionless",
        "H_ex" | "H_demag" | "H_ext" | "H_eff" | "H_ani" | "H_dmi" => "A/m",
        other => panic!("unsupported observable '{}'", other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::{
        BackendPlanIR, CommonPlanMeta, ExchangeBoundaryCondition, ExecutionMode, ExecutionPlanIR,
        ExecutionPrecision, FdmMaterialIR, FdmPlanIR, GridDimensions, IntegratorChoice,
        OutputPlanIR, ProvenancePlanIR,
    };

    fn test_execution_plan(active_mask: Option<Vec<bool>>) -> ExecutionPlanIR {
        ExecutionPlanIR {
            common: CommonPlanMeta {
                ir_version: "v0".to_string(),
                requested_backend: fullmag_ir::BackendTarget::Fdm,
                resolved_backend: fullmag_ir::BackendTarget::Fdm,
                execution_mode: ExecutionMode::Strict,
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
                has_oersted_cylinder: false,
                oersted_current: None,
                oersted_radius: None,
                oersted_center: None,
                oersted_axis: None,
                oersted_time_dep_kind: 0,
                oersted_time_dep_freq: 0.0,
                oersted_time_dep_phase: 0.0,
                oersted_time_dep_offset: 0.0,
                oersted_time_dep_t_on: 0.0,
                oersted_time_dep_t_off: 0.0,
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
}
