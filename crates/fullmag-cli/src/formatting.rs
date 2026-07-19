use anyhow::{anyhow, Result};
use fullmag_ir::{
    BackendPlanIR, DeclaredUniverseIR, DomainFrameIR, ExecutionPlanIR, ExecutionPlanSummary,
    ProblemIR,
};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::types::{EngineLogEntry, ResolvedScriptStage};

#[cfg(test)]
mod origin_tests {
    use super::current_artifact_layout;
    use fullmag_ir::{
        BackendPlanIR, BackendTarget, CommonPlanMeta, ExecutionMode, ExecutionPlanIR, FdmPlanIR,
        OutputPlanIR, ProblemIR, ProvenancePlanIR,
    };

    #[test]
    fn fdm_artifact_layout_uses_resolved_plan_origin() {
        let mut fdm = FdmPlanIR::default();
        fdm.origin_m = [17.0e-9, -11.0e-9, 3.0e-9];
        fdm.grid.cells = [4, 2, 1];
        fdm.cell_size = [2.0e-9, 3.0e-9, 4.0e-9];
        fdm.initial_magnetization = vec![[1.0, 0.0, 0.0]; 8];
        let plan = ExecutionPlanIR {
            common: CommonPlanMeta {
                ir_version: "v0".to_string(),
                requested_backend: BackendTarget::Fdm,
                resolved_backend: BackendTarget::Fdm,
                execution_mode: ExecutionMode::Strict,
                material_field_plans: Vec::new(),
            },
            backend_plan: BackendPlanIR::Fdm(fdm),
            output_plan: OutputPlanIR {
                outputs: Vec::new(),
            },
            provenance: ProvenancePlanIR {
                notes: Vec::new(),
                integrator_resolution: None,
            },
        };

        let layout = current_artifact_layout(&ProblemIR::bootstrap_example(), &plan);
        assert_eq!(
            layout["origin_m"],
            serde_json::json!([17.0e-9, -11.0e-9, 3.0e-9])
        );
    }
}

pub(crate) fn unix_time_millis() -> Result<u128> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| anyhow!("system clock error: {}", error))?
        .as_millis())
}

pub(crate) fn format_length_m(value: f64) -> String {
    let abs = value.abs();
    if abs >= 1e-3 {
        format!("{:.3} mm", value * 1e3)
    } else if abs >= 1e-6 {
        format!("{:.3} um", value * 1e6)
    } else if abs >= 1e-9 {
        format!("{:.3} nm", value * 1e9)
    } else {
        format!("{:.4e} m", value)
    }
}

pub(crate) fn format_extent(extent: [f64; 3]) -> String {
    format!(
        "x={}  y={}  z={}",
        format_length_m(extent[0]),
        format_length_m(extent[1]),
        format_length_m(extent[2]),
    )
}

pub(crate) fn fem_mesh_bbox(mesh: &fullmag_ir::MeshIR) -> Option<([f64; 3], [f64; 3])> {
    let mut iter = mesh.nodes.iter();
    let first = iter.next()?;
    let mut min = *first;
    let mut max = *first;
    for node in iter {
        for axis in 0..3 {
            min[axis] = min[axis].min(node[axis]);
            max[axis] = max[axis].max(node[axis]);
        }
    }
    Some((min, max))
}

pub(crate) fn fem_domain_frame(
    problem: &ProblemIR,
    mesh_bounds: Option<([f64; 3], [f64; 3])>,
) -> Option<DomainFrameIR> {
    let base_frame = problem
        .problem_meta
        .runtime_metadata
        .get("domain_frame")
        .and_then(|value| serde_json::from_value::<DomainFrameIR>(value.clone()).ok())
        .or_else(|| {
            problem
                .problem_meta
                .runtime_metadata
                .get("study_universe")
                .and_then(DeclaredUniverseIR::from_study_universe_value)
                .map(|declared_universe| DomainFrameIR {
                    declared_universe: Some(declared_universe),
                    ..DomainFrameIR::default()
                })
        })?;
    base_frame.with_mesh_bounds(mesh_bounds).finalized()
}

pub(crate) fn fem_declared_universe(problem: &ProblemIR) -> Option<DeclaredUniverseIR> {
    fem_domain_frame(problem, None).and_then(|frame| frame.declared_universe)
}

pub(crate) fn log_execution_plan(
    stage_index: usize,
    stage_count: usize,
    stage: &ResolvedScriptStage,
    plan: &ExecutionPlanIR,
) {
    for (line_index, line) in execution_plan_log_lines(stage_index, stage_count, stage, plan)
        .into_iter()
        .enumerate()
    {
        if line_index == 0 {
            eprintln!("- {}", line);
        } else {
            eprintln!("  {}", line);
        }
    }
}

pub(crate) fn plan_summary_json(plan_summary: &ExecutionPlanSummary) -> serde_json::Value {
    serde_json::to_value(plan_summary).unwrap_or_else(|_| serde_json::json!({}))
}

pub(crate) const MAX_ENGINE_LOG_ENTRIES: usize = 256;

pub(crate) fn push_engine_log(
    entries: &mut Vec<EngineLogEntry>,
    level: &str,
    message: impl Into<String>,
) {
    let timestamp_unix_ms = unix_time_millis().unwrap_or(0);
    entries.push(EngineLogEntry {
        timestamp_unix_ms,
        level: level.to_string(),
        message: message.into(),
    });
    if entries.len() > MAX_ENGINE_LOG_ENTRIES {
        let overflow = entries.len() - MAX_ENGINE_LOG_ENTRIES;
        entries.drain(0..overflow);
    }
}

pub(crate) fn upsert_engine_log_tail(
    entries: &mut Vec<EngineLogEntry>,
    level: &str,
    message_prefix: &str,
    message: impl Into<String>,
) {
    let timestamp_unix_ms = unix_time_millis().unwrap_or(0);
    let message = message.into();
    if let Some(last) = entries.last_mut() {
        if last.level == level && last.message.starts_with(message_prefix) {
            last.timestamp_unix_ms = timestamp_unix_ms;
            last.message = message;
            return;
        }
    }
    push_engine_log(entries, level, message);
}

pub(crate) fn execution_plan_log_lines(
    stage_index: usize,
    stage_count: usize,
    stage: &ResolvedScriptStage,
    plan: &ExecutionPlanIR,
) -> Vec<String> {
    let mut lines = vec![format!(
        "Stage {}/{} ({}) planned",
        stage_index + 1,
        stage_count,
        stage.entrypoint_kind
    )];
    match &plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => {
            let extent = [
                fdm.grid.cells[0] as f64 * fdm.cell_size[0],
                fdm.grid.cells[1] as f64 * fdm.cell_size[1],
                fdm.grid.cells[2] as f64 * fdm.cell_size[2],
            ];
            let total_cells = fdm.grid.cells[0] as usize
                * fdm.grid.cells[1] as usize
                * fdm.grid.cells[2] as usize;
            let active_cells = fdm
                .active_mask
                .as_ref()
                .map(|mask| mask.iter().filter(|value| **value).count())
                .unwrap_or(total_cells);
            lines.push("Backend plan: fdm".to_string());
            lines.push(format!("World extent: {}", format_extent(extent)));
            lines.push(format!(
                "Grid: {} x {} x {} cells",
                fdm.grid.cells[0], fdm.grid.cells[1], fdm.grid.cells[2]
            ));
            lines.push(format!("Cell: {}", format_extent(fdm.cell_size)));
            lines.push(format!("Active cells: {} / {}", active_cells, total_cells));
        }
        BackendPlanIR::FdmMultilayer(multilayer) => {
            let conv_cell = multilayer
                .layers
                .first()
                .map(|layer| layer.convolution_cell_size)
                .unwrap_or([0.0, 0.0, 0.0]);
            let extent = [
                multilayer.common_cells[0] as f64 * conv_cell[0],
                multilayer.common_cells[1] as f64 * conv_cell[1],
                multilayer.common_cells[2] as f64 * conv_cell[2],
            ];
            let active_cells: usize = multilayer
                .layers
                .iter()
                .map(|layer| {
                    layer
                        .native_active_mask
                        .as_ref()
                        .map(|mask| mask.iter().filter(|value| **value).count())
                        .unwrap_or_else(|| {
                            layer.native_grid[0] as usize
                                * layer.native_grid[1] as usize
                                * layer.native_grid[2] as usize
                        })
                })
                .sum();
            lines.push(format!(
                "Backend plan: fdm_multilayer ({})",
                multilayer.mode
            ));
            lines.push(format!("World extent: {}", format_extent(extent)));
            lines.push(format!(
                "Convolution grid: {} x {} x {} cells",
                multilayer.common_cells[0], multilayer.common_cells[1], multilayer.common_cells[2]
            ));
            lines.push(format!("Convolution cell: {}", format_extent(conv_cell)));
            lines.push(format!("Layers: {}", multilayer.layers.len()));
            lines.push(format!("Active native cells total: {}", active_cells));
        }
        BackendPlanIR::Fem(fem) => {
            lines.push("Backend plan: fem".to_string());
            lines.push(format!("Mesh: {}", fem.mesh_name));
            lines.push(format!(
                "Mesh size: {} nodes, {} elements, {} boundary faces",
                fem.mesh.nodes.len(),
                fem.mesh.elements.len(),
                fem.mesh.boundary_faces.len()
            ));
            if let Some((min, max)) = fem_mesh_bbox(&fem.mesh) {
                let extent = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
                lines.push(format!("Mesh extent: {}", format_extent(extent)));
            }
            lines.push(format!("FE order: {}", fem.fe_order));
            lines.push(format!("hmax: {}", format_length_m(fem.hmax)));
        }
        BackendPlanIR::FemEigen(fem) => {
            lines.push("Backend plan: fem_eigen".to_string());
            lines.push(format!("Mesh: {}", fem.mesh_name));
            lines.push(format!(
                "Mesh size: {} nodes, {} elements, {} boundary faces",
                fem.mesh.nodes.len(),
                fem.mesh.elements.len(),
                fem.mesh.boundary_faces.len()
            ));
            if let Some((min, max)) = fem_mesh_bbox(&fem.mesh) {
                let extent = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
                lines.push(format!("Mesh extent: {}", format_extent(extent)));
            }
            lines.push(format!("FE order: {}", fem.fe_order));
            lines.push(format!("hmax: {}", format_length_m(fem.hmax)));
            lines.push(format!("Requested modes: {}", fem.count));
        }
        BackendPlanIR::FemFrequencyResponse(fem) => {
            lines.push("Backend plan: fem_frequency_response".to_string());
            lines.push(format!("Mesh: {}", fem.mesh_name));
            lines.push(format!(
                "Mesh size: {} nodes, {} elements, {} boundary faces",
                fem.mesh.nodes.len(),
                fem.mesh.elements.len(),
                fem.mesh.boundary_faces.len()
            ));
            if let Some((min, max)) = fem_mesh_bbox(&fem.mesh) {
                let extent = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
                lines.push(format!("Mesh extent: {}", format_extent(extent)));
            }
            lines.push(format!("FE order: {}", fem.fe_order));
            lines.push(format!("hmax: {}", format_length_m(fem.hmax)));
            lines.push(format!(
                "Frequency points: {}",
                fem.frequencies_hz.values_hz.len()
            ));
        }
    }
    lines
}

pub(crate) fn current_artifact_layout(
    problem: &ProblemIR,
    plan: &ExecutionPlanIR,
) -> serde_json::Value {
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
            serde_json::json!({
                "backend": "fdm",
                "grid_cells": fdm.grid.cells,
                "cell_size": fdm.cell_size,
                "origin_m": fdm.origin_m,
                "total_cell_count": total_cells,
                "active_mask_present": fdm.active_mask.is_some(),
                "active_cell_count": active_cell_count,
                "inactive_cell_count": total_cells.saturating_sub(active_cell_count),
                "active_fraction": if total_cells > 0 {
                    active_cell_count as f64 / total_cells as f64
                } else {
                    0.0
                },
            })
        }
        BackendPlanIR::FdmMultilayer(multilayer) => serde_json::json!({
            "backend": "fdm_multilayer",
            "mode": multilayer.mode,
            "common_cells": multilayer.common_cells,
            "layer_count": multilayer.layers.len(),
            "layers": multilayer.layers.iter().scan(0usize, |offset, layer| {
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
            "planner_summary": multilayer.planner_summary,
        }),
        BackendPlanIR::Fem(fem) => {
            let mesh_bounds = fem_mesh_bbox(&fem.mesh);
            let (bounds_min, bounds_max, mesh_extent) = mesh_bounds
                .map(|(min, max)| {
                    (
                        Some(min),
                        Some(max),
                        Some([max[0] - min[0], max[1] - min[1], max[2] - min[2]]),
                    )
                })
                .unwrap_or((None, None, None));
            let domain_frame = fem
                .domain_frame
                .clone()
                .or_else(|| fem_domain_frame(problem, mesh_bounds))
                .and_then(DomainFrameIR::finalized);
            let world_extent = domain_frame
                .as_ref()
                .and_then(|frame| frame.effective_extent);
            let world_center = domain_frame
                .as_ref()
                .and_then(|frame| frame.effective_center);
            let world_extent_source = domain_frame
                .as_ref()
                .and_then(|frame| frame.effective_source.clone());
            serde_json::json!({
                "backend": "fem",
                "mesh_name": fem.mesh.mesh_name,
                "mesh_source": fem.mesh_source,
                "fe_order": fem.fe_order,
                "hmax": fem.hmax,
                "n_nodes": fem.mesh.nodes.len(),
                "n_elements": fem.mesh.elements.len(),
                "boundary_face_count": fem.mesh.boundary_faces.len(),
                "bounds_min": bounds_min,
                "bounds_max": bounds_max,
                "mesh_extent": mesh_extent,
                "world_extent": world_extent,
                "world_center": world_center,
                "world_extent_source": world_extent_source,
                "domain_frame": domain_frame,
                "domain_mesh_mode": fem.domain_mesh_mode,
            })
        }
        BackendPlanIR::FemEigen(fem) => {
            let mesh_bounds = fem_mesh_bbox(&fem.mesh);
            let (bounds_min, bounds_max, mesh_extent) = mesh_bounds
                .map(|(min, max)| {
                    (
                        Some(min),
                        Some(max),
                        Some([max[0] - min[0], max[1] - min[1], max[2] - min[2]]),
                    )
                })
                .unwrap_or((None, None, None));
            let domain_frame = fem
                .domain_frame
                .clone()
                .or_else(|| fem_domain_frame(problem, mesh_bounds))
                .and_then(DomainFrameIR::finalized);
            let world_extent = domain_frame
                .as_ref()
                .and_then(|frame| frame.effective_extent);
            let world_center = domain_frame
                .as_ref()
                .and_then(|frame| frame.effective_center);
            let world_extent_source = domain_frame
                .as_ref()
                .and_then(|frame| frame.effective_source.clone());
            serde_json::json!({
                "backend": "fem_eigen",
                "mesh_name": fem.mesh.mesh_name,
                "mesh_source": fem.mesh_source,
                "fe_order": fem.fe_order,
                "hmax": fem.hmax,
                "n_nodes": fem.mesh.nodes.len(),
                "n_elements": fem.mesh.elements.len(),
                "boundary_face_count": fem.mesh.boundary_faces.len(),
                "bounds_min": bounds_min,
                "bounds_max": bounds_max,
                "mesh_extent": mesh_extent,
                "world_extent": world_extent,
                "world_center": world_center,
                "world_extent_source": world_extent_source,
                "domain_frame": domain_frame,
                "domain_mesh_mode": fem.domain_mesh_mode,
                "mode_count": fem.count,
            })
        }
        BackendPlanIR::FemFrequencyResponse(fem) => {
            let mesh_bounds = fem_mesh_bbox(&fem.mesh);
            let (bounds_min, bounds_max, mesh_extent) = mesh_bounds
                .map(|(min, max)| {
                    (
                        Some(min),
                        Some(max),
                        Some([max[0] - min[0], max[1] - min[1], max[2] - min[2]]),
                    )
                })
                .unwrap_or((None, None, None));
            let domain_frame = fem
                .domain_frame
                .clone()
                .or_else(|| fem_domain_frame(problem, mesh_bounds))
                .and_then(DomainFrameIR::finalized);
            let world_extent = domain_frame
                .as_ref()
                .and_then(|frame| frame.effective_extent);
            let world_center = domain_frame
                .as_ref()
                .and_then(|frame| frame.effective_center);
            let world_extent_source = domain_frame
                .as_ref()
                .and_then(|frame| frame.effective_source.clone());
            serde_json::json!({
                "backend": "fem_frequency_response",
                "mesh_name": fem.mesh.mesh_name,
                "mesh_source": fem.mesh_source,
                "fe_order": fem.fe_order,
                "hmax": fem.hmax,
                "n_nodes": fem.mesh.nodes.len(),
                "n_elements": fem.mesh.elements.len(),
                "boundary_face_count": fem.mesh.boundary_faces.len(),
                "bounds_min": bounds_min,
                "bounds_max": bounds_max,
                "mesh_extent": mesh_extent,
                "world_extent": world_extent,
                "world_center": world_center,
                "world_extent_source": world_extent_source,
                "domain_frame": domain_frame,
                "domain_mesh_mode": fem.domain_mesh_mode,
                "frequency_count": fem.frequencies_hz.values_hz.len(),
            })
        }
    }
}

pub(crate) fn current_meshing_capabilities(plan: &ExecutionPlanIR) -> Option<serde_json::Value> {
    let BackendPlanIR::Fem(fem) = &plan.backend_plan else {
        return None;
    };

    let source_kind = match fem.mesh_source.as_deref() {
        Some(source) if source.ends_with(".stl") => "stl_surface",
        Some(source)
            if source.ends_with(".step")
                || source.ends_with(".stp")
                || source.ends_with(".iges")
                || source.ends_with(".igs") =>
        {
            "cad_file"
        }
        Some(source)
            if source.ends_with(".msh")
                || source.ends_with(".vtk")
                || source.ends_with(".vtu")
                || source.ends_with(".xdmf")
                || source.ends_with(".json")
                || source.ends_with(".npz") =>
        {
            "prebuilt_mesh"
        }
        Some(_) => "external_source",
        None => "generated_inline_mesh",
    };

    Some(serde_json::json!({
        "backend": "gmsh",
        "source_kind": source_kind,
        "current_settings": {
            "order": fem.fe_order,
            "hmax": fem.hmax,
            "mesh_source": fem.mesh_source,
            "surface_classification_angle_deg": 40.0,
            "surface_curve_angle_deg": 180.0,
            "for_reparametrization": true,
        },
        "groups": [
            {
                "id": "generation",
                "title": "Generation",
                "description": "Mesh construction and source ingestion currently available in the mesher runtime.",
                "controls": [
                    {
                        "id": "hmax",
                        "label": "Global max element size",
                        "status": "active",
                        "ui": "numeric input",
                        "backend": "gmsh.option.setNumber(\"Mesh.CharacteristicLengthMax\", hmax)",
                        "description": "Uniform upper bound for tetrahedral element size.",
                    },
                    {
                        "id": "order",
                        "label": "Element order",
                        "status": "active",
                        "ui": "segmented buttons",
                        "backend": "FemPlanIR.fe_order / mfem::H1_FECollection(order, dim)",
                        "description": "Polynomial order of the FEM basis; mesh topology stays first-order.",
                    },
                    {
                        "id": "mesh_source",
                        "label": "Mesh or geometry source",
                        "status": "active",
                        "ui": "source picker",
                        "backend": "generate_mesh_from_file(...)",
                        "description": "STL, CAD, JSON/NPZ MeshData, or external mesh files are accepted.",
                    },
                    {
                        "id": "stl_surface_recovery",
                        "label": "STL surface classification",
                        "status": "internal",
                        "ui": "advanced panel",
                        "backend": "gmsh.model.mesh.classifySurfaces(...) + createGeometry()",
                        "description": "Current STL path already classifies surfaces before building the volume.",
                    }
                ]
            },
            {
                "id": "sizing",
                "title": "Sizing",
                "description": "Gmsh size-control APIs available for future localized mesh refinement UI.",
                "controls": [
                    {
                        "id": "point_size_constraints",
                        "label": "Point size constraints",
                        "status": "planned",
                        "ui": "point selection + scalar value",
                        "backend": "gmsh.model.mesh.setSize(dimTags, size)",
                        "description": "Local mesh size constraints at CAD points.",
                    },
                    {
                        "id": "curve_parametric_size",
                        "label": "Curve parametric sizes",
                        "status": "planned",
                        "ui": "curve table",
                        "backend": "gmsh.model.mesh.setSizeAtParametricPoints(...)",
                        "description": "Non-uniform sizing along curves.",
                    },
                    {
                        "id": "background_size_field",
                        "label": "Background size field",
                        "status": "planned",
                        "ui": "field graph editor",
                        "backend": "gmsh.model.mesh.field.* + setAsBackgroundMesh()",
                        "description": "Distance/threshold style adaptive sizing should be built on top of mesh fields.",
                    },
                    {
                        "id": "size_callback",
                        "label": "Programmatic size callback",
                        "status": "planned",
                        "ui": "advanced scripting hook",
                        "backend": "gmsh.model.mesh.setSizeCallback(...)",
                        "description": "Dynamic sizing callback for advanced workflows.",
                    }
                ]
            },
            {
                "id": "quality",
                "title": "Quality Improvement",
                "description": "Post-generation cleanup and optimization supported by Gmsh.",
                "controls": [
                    {
                        "id": "refine_uniform",
                        "label": "Uniform refinement",
                        "status": "planned",
                        "ui": "stepper / button",
                        "backend": "gmsh.model.mesh.refine()",
                        "description": "Uniformly splits the current mesh and resets high-order elements to order 1.",
                    },
                    {
                        "id": "optimize",
                        "label": "Mesh optimization",
                        "status": "planned",
                        "ui": "optimizer method + iterations",
                        "backend": "gmsh.model.mesh.optimize(method, force, niter)",
                        "description": "Default tetra optimizer, Netgen, HighOrder, HighOrderElastic, HighOrderFastCurving, Laplace2D.",
                    },
                    {
                        "id": "laplace_smoothing",
                        "label": "Laplace smoothing",
                        "status": "planned",
                        "ui": "iterations slider",
                        "backend": "gmsh.model.mesh.setSmoothing(dim, tag, val)",
                        "description": "Applies Laplace smoothing iterations on selected entities.",
                    },
                    {
                        "id": "remove_duplicates",
                        "label": "Duplicate cleanup",
                        "status": "planned",
                        "ui": "maintenance action",
                        "backend": "gmsh.model.mesh.removeDuplicateNodes / removeDuplicateElements",
                        "description": "Deduplicates nodes and elements after geometry repair workflows.",
                    },
                    {
                        "id": "renumbering",
                        "label": "Node and element renumbering",
                        "status": "planned",
                        "ui": "maintenance action",
                        "backend": "gmsh.model.mesh.renumberNodes / renumberElements",
                        "description": "Renumbers topology for cleaner exports and downstream processing.",
                    }
                ]
            },
            {
                "id": "structured",
                "title": "Structured and Advanced Topology",
                "description": "Useful for later CAD-driven meshing flows but not wired in the current launcher path.",
                "controls": [
                    {
                        "id": "transfinite_curves",
                        "label": "Transfinite curves and surfaces",
                        "status": "planned",
                        "ui": "curve/surface constraint editor",
                        "backend": "gmsh.model.mesh.setTransfiniteCurve / setTransfiniteSurface",
                        "description": "Structured meshing constraints for CAD-driven blocks and sweeps.",
                    },
                    {
                        "id": "recombine",
                        "label": "Recombine surface mesh",
                        "status": "planned",
                        "ui": "toggle",
                        "backend": "gmsh.model.mesh.setRecombine / recombine()",
                        "description": "Quadrilateral/hexahedral-oriented workflows where applicable.",
                    },
                    {
                        "id": "embedding_partitioning",
                        "label": "Embedding and partitioning",
                        "status": "planned",
                        "ui": "advanced topology tools",
                        "backend": "gmsh.model.mesh.embed / partition / unpartition",
                        "description": "Advanced mesh topology operations for more complex CAD workflows.",
                    }
                ]
            }
        ]
    }))
}
