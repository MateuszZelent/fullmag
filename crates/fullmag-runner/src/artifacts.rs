//! Artifact writing: metadata, scalars CSV, field snapshots.

use crate::artifact_pipeline::ArtifactPipelineSummary;
use fullmag_ir::BackendPlanIR;

use crate::types::{ExecutedRun, StepStats};

use std::collections::{BTreeSet, HashMap};
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
                    let matches_region = solve_region
                        .as_deref()
                        .is_some_and(|region| segment.object_id == region);
                    let matches_geometry = target_geometry.is_some_and(|geometry_name| {
                        segment.geometry_id.as_deref() == Some(geometry_name)
                    });
                    let matches = solve_region.is_none() || matches_region || matches_geometry;
                    if !matches {
                        continue;
                    }
                    matched_any_segment = true;
                    let start = segment.node_start as usize;
                    let end = start
                        .saturating_add(segment.node_count as usize)
                        .min(values.len());
                    for value in &mut values[start..end] {
                        *value = *current_density;
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
        "H_ex" | "H_demag" | "H_ext" | "H_OE" | "H_eff" | "H_ani" | "H_dmi" => "A/m",
        other => panic!("unsupported observable '{}'", other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ExecutedRun, ExecutionProvenance, FieldSnapshot, RunResult, RunStatus};
    use fullmag_ir::{
        BackendPlanIR, CommonPlanMeta, ExchangeBoundaryCondition, ExecutionMode, ExecutionPlanIR,
        ExecutionPrecision, FdmMaterialIR, FdmPlanIR, FemDomainMeshModeIR, FemObjectSegmentIR,
        FemPlanIR, GridDimensions, IntegratorChoice, MaterialIR, MeshIR, OutputPlanIR,
        ProvenancePlanIR,
    };
    use std::collections::HashMap;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

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

    fn test_fem_execution_plan() -> ExecutionPlanIR {
        ExecutionPlanIR {
            common: CommonPlanMeta {
                ir_version: "v0".to_string(),
                requested_backend: fullmag_ir::BackendTarget::Fem,
                resolved_backend: fullmag_ir::BackendTarget::Fem,
                execution_mode: ExecutionMode::Strict,
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
                },
                region_materials: Vec::new(),
                enable_exchange: true,
                enable_demag: false,
                external_field: None,
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
            requested_demag_realization: None,
            resolved_demag_realization: None,
            dt_policy: None,
            mfem_device: None,
            demag_refresh_interval_s: None,
            requested_cpu_threads: None,
            resolved_cpu_threads: None,
            requested_fem_omp_threads: None,
            effective_fem_omp_threads: None,
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
            requested_demag_realization: None,
            resolved_demag_realization: None,
            dt_policy: None,
            mfem_device: None,
            demag_refresh_interval_s: None,
            requested_cpu_threads: None,
            resolved_cpu_threads: None,
            requested_fem_omp_threads: None,
            effective_fem_omp_threads: None,
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
}
