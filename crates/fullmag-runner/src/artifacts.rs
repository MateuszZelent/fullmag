//! Artifact writing: metadata, scalars CSV, field snapshots.

use fullmag_ir::BackendPlanIR;

use crate::types::{ExecutedRun, StepStats};

use std::fs;
use std::io::Write;
use std::path::Path;

pub(crate) fn write_artifacts(
    output_dir: &Path,
    problem: &fullmag_ir::ProblemIR,
    plan: &fullmag_ir::ExecutionPlanIR,
    executed: &ExecutedRun,
) -> std::io::Result<()> {
    fs::create_dir_all(output_dir)?;

    let metadata = serde_json::json!({
        "problem_name": problem.problem_meta.name,
        "ir_version": problem.ir_version,
        "source_hash": problem.problem_meta.source_hash,
        "problem_meta": problem.problem_meta,
        "execution_plan": plan,
        "execution_provenance": executed.provenance,
        "engine_version": env!("CARGO_PKG_VERSION"),
        "status": executed.result.status,
        "scalar_rows": executed.result.steps.len(),
        "field_snapshots": executed.field_snapshots.len(),
    });
    let metadata_path = output_dir.join("metadata.json");
    let mut metadata_file = fs::File::create(&metadata_path)?;
    metadata_file.write_all(serde_json::to_string_pretty(&metadata).unwrap().as_bytes())?;

    let csv_path = output_dir.join("scalars.csv");
    let mut csv_file = fs::File::create(&csv_path)?;
    writeln!(
        csv_file,
        "step,time,solver_dt,E_ex,E_demag,E_ext,E_total,max_dm_dt,max_h_eff"
    )?;
    for step in &executed.result.steps {
        writeln!(
            csv_file,
            "{},{:.15e},{:.15e},{:.15e},{:.15e},{:.15e},{:.15e},{:.15e},{:.15e}",
            step.step,
            step.time,
            step.dt,
            step.e_ex,
            step.e_demag,
            step.e_ext,
            step.e_total,
            step.max_dm_dt,
            step.max_h_eff
        )?;
    }

    write_field_file(
        &output_dir.join("m_initial.json"),
        problem,
        plan,
        &executed.provenance,
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
        e_total: 0.0,
        max_dm_dt: 0.0,
        max_h_eff: 0.0,
        max_h_demag: 0.0,
        wall_time_ns: 0,
    });
    write_field_file(
        &output_dir.join("m_final.json"),
        problem,
        plan,
        &executed.provenance,
        "m",
        final_stats.step,
        final_stats.time,
        final_stats.dt,
        &executed.result.final_magnetization,
    )?;

    let fields_dir = output_dir.join("fields");
    for snapshot in &executed.field_snapshots {
        let observable_dir = fields_dir.join(&snapshot.name);
        fs::create_dir_all(&observable_dir)?;
        let snapshot_path = observable_dir.join(format!("step_{:06}.json", snapshot.step));
        write_field_file(
            &snapshot_path,
            problem,
            plan,
            &executed.provenance,
            &snapshot.name,
            snapshot.step,
            snapshot.time,
            snapshot.solver_dt,
            &snapshot.values,
        )?;
    }

    Ok(())
}

fn write_field_file(
    path: &Path,
    problem: &fullmag_ir::ProblemIR,
    plan: &fullmag_ir::ExecutionPlanIR,
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
        "layout": field_layout(plan),
        "provenance": {
            "problem_name": problem.problem_meta.name,
            "ir_version": problem.ir_version,
            "source_hash": problem.problem_meta.source_hash,
            "execution_mode": plan.common.execution_mode,
            "execution_engine": provenance.execution_engine,
            "precision": provenance.precision,
        },
        "values": values,
    });
    fs::write(path, serde_json::to_string_pretty(&field_json).unwrap())
}

fn field_layout(plan: &fullmag_ir::ExecutionPlanIR) -> serde_json::Value {
    match &plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => serde_json::json!({
            "backend": "fdm",
            "grid_cells": fdm.grid.cells,
            "cell_size": fdm.cell_size,
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
    }
}

pub(crate) fn field_unit(observable: &str) -> &'static str {
    match observable {
        "m" => "dimensionless",
        "H_ex" | "H_demag" | "H_ext" | "H_eff" => "A/m",
        other => panic!("unsupported observable '{}'", other),
    }
}
