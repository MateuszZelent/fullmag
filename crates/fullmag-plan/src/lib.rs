//! Execution planning: lowers `ProblemIR` into backend-specific `ExecutionPlanIR`.
//!
//! Phase 1 scope: `Box/Cylinder/(ImportedGeometry + precomputed grid asset) +
//! (Exchange | Demag | Zeeman combinations) + fdm/strict`
//! is the legal executable path.
//! Additionally, `backend='fem'` can now produce a planner-ready `FemPlanIR`
//! when a precomputed `MeshIR` asset is attached, but runner execution remains deferred.

use fullmag_ir::{
    BackendPlanIR, BackendTarget, CommonPlanMeta, DiscretizationHintsIR, ExchangeBoundaryCondition,
    ExecutionMode, ExecutionPlanIR, ExecutionPrecision, FdmGridAssetIR, FdmMaterialIR, FdmPlanIR,
    FemPlanIR, GeometryEntryIR, GridDimensions, InitialMagnetizationIR, IntegratorChoice, MeshIR,
    OutputIR, OutputPlanIR, ProblemIR, ProvenancePlanIR, RelaxationAlgorithmIR,
    RelaxationControlIR, IR_VERSION,
};
use std::collections::BTreeSet;
use std::fmt;
use std::fs;
use std::path::Path;

const MU0: f64 = 4.0 * std::f64::consts::PI * 1e-7;

#[derive(Debug)]
pub struct PlanError {
    pub reasons: Vec<String>,
}

impl fmt::Display for PlanError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for reason in &self.reasons {
            writeln!(f, "  - {}", reason)?;
        }
        Ok(())
    }
}

impl std::error::Error for PlanError {}

fn planned_study_controls(
    problem: &ProblemIR,
    errors: &mut Vec<String>,
) -> (
    IntegratorChoice,
    Option<f64>,
    f64,
    Option<RelaxationControlIR>,
) {
    let integrator = match problem.study.dynamics() {
        fullmag_ir::DynamicsIR::Llg { integrator, .. } => {
            if integrator == "heun" {
                IntegratorChoice::Heun
            } else {
                errors.push(format!(
                    "integrator '{}' is not supported; only 'heun' is available",
                    integrator
                ));
                IntegratorChoice::Heun
            }
        }
    };

    let fixed_timestep = match problem.study.dynamics() {
        fullmag_ir::DynamicsIR::Llg { fixed_timestep, .. } => *fixed_timestep,
    };

    let gyromagnetic_ratio = match problem.study.dynamics() {
        fullmag_ir::DynamicsIR::Llg {
            gyromagnetic_ratio, ..
        } => *gyromagnetic_ratio,
    };

    let relaxation = problem.study.relaxation().map(|control| {
        if control.algorithm != RelaxationAlgorithmIR::LlgOverdamped {
            errors.push(format!(
                "relaxation algorithm '{}' is defined but not yet executable in the current public runner; only 'llg_overdamped' is currently supported",
                control.algorithm.as_str()
            ));
        }
        control
    });

    (integrator, fixed_timestep, gyromagnetic_ratio, relaxation)
}

/// Plans a `ProblemIR` into an `ExecutionPlanIR`.
///
/// Current planner coverage:
/// - executable FDM: `Box | Cylinder | ImportedGeometry + precomputed active_mask`
///   with the narrow interaction subset and `Heun`,
/// - planner-ready FEM: explicit `backend='fem'` with precomputed `MeshIR`.
///
/// Returns a detailed error for anything outside this subset.
pub fn plan(problem: &ProblemIR) -> Result<ExecutionPlanIR, PlanError> {
    // 1. Validate IR first
    if let Err(validation_errors) = problem.validate() {
        return Err(PlanError {
            reasons: validation_errors,
        });
    }

    let mut errors = Vec::new();

    // 2. Check backend target
    let resolved_backend = match problem.backend_policy.requested_backend {
        BackendTarget::Fdm => BackendTarget::Fdm,
        BackendTarget::Auto => resolve_auto_backend(problem),
        BackendTarget::Fem => BackendTarget::Fem,
        other => {
            errors.push(format!(
                "backend '{}' is not yet supported by the current planner entry point",
                other.as_str()
            ));
            BackendTarget::Fdm
        }
    };

    // 3. Check execution mode
    if problem.validation_profile.execution_mode != ExecutionMode::Strict {
        errors.push("only execution_mode='strict' is executable in Phase 1".to_string());
    }

    if !errors.is_empty() {
        return Err(PlanError { reasons: errors });
    }

    if resolved_backend == BackendTarget::Fem {
        return plan_fem(problem, resolved_backend);
    }

    // 4. Check energy terms — executable subset is Exchange / Demag / Zeeman
    let mut enable_exchange = false;
    let mut enable_demag = false;
    let mut external_field = None;
    for term in &problem.energy_terms {
        match term {
            fullmag_ir::EnergyTermIR::Exchange => {
                if enable_exchange {
                    errors.push("Exchange is declared more than once".to_string());
                }
                enable_exchange = true;
            }
            fullmag_ir::EnergyTermIR::Demag => {
                if enable_demag {
                    errors.push("Demag is declared more than once".to_string());
                }
                enable_demag = true;
            }
            fullmag_ir::EnergyTermIR::Zeeman { b } => {
                if external_field.is_some() {
                    errors.push("Zeeman is declared more than once".to_string());
                }
                external_field = Some([b[0] / MU0, b[1] / MU0, b[2] / MU0]);
            }
            other => {
                errors.push(format!(
                    "energy term '{:?}' is semantic-only in the current FDM executable path",
                    other
                ));
            }
        }
    }
    if !(enable_exchange || enable_demag || external_field.is_some()) {
        errors.push(
            "the current executable FDM path requires at least one of Exchange, Demag, or Zeeman"
                .to_string(),
        );
    }

    // 5. Check geometry — Box and Cylinder are executable
    if problem.geometry.entries.len() != 1 {
        errors.push(format!(
            "Phase 1 supports exactly one geometry entry, found {}",
            problem.geometry.entries.len()
        ));
    }
    let geometry = &problem.geometry.entries[0];
    enum GeometryShape {
        Box {
            size: [f64; 3],
        },
        Cylinder {
            radius: f64,
            height: f64,
        },
        Imported {
            source: String,
            format: String,
        },
        Difference {
            base: std::boxed::Box<GeometryShape>,
            tool: std::boxed::Box<GeometryShape>,
        },
    }

    fn ir_to_shape(entry: &GeometryEntryIR) -> GeometryShape {
        match entry {
            GeometryEntryIR::Box { size, .. } => GeometryShape::Box { size: *size },
            GeometryEntryIR::Cylinder { radius, height, .. } => GeometryShape::Cylinder {
                radius: *radius,
                height: *height,
            },
            GeometryEntryIR::ImportedGeometry { source, format, .. } => GeometryShape::Imported {
                source: source.clone(),
                format: format.clone(),
            },
            GeometryEntryIR::Difference { base, tool, .. } => GeometryShape::Difference {
                base: std::boxed::Box::new(ir_to_shape(base)),
                tool: std::boxed::Box::new(ir_to_shape(tool)),
            },
            // CSG/transform variants: extract the underlying shape from
            // the base/a operand for planning purposes. Full CSG
            // planning is future work; for now the planner treats them
            // as their first operand.
            GeometryEntryIR::Union { a, .. } => ir_to_shape(a),
            GeometryEntryIR::Intersection { a, .. } => ir_to_shape(a),
            GeometryEntryIR::Translate { base, .. } => ir_to_shape(base),
            GeometryEntryIR::Ellipsoid { radii, .. } => GeometryShape::Box {
                size: [radii[0] * 2.0, radii[1] * 2.0, radii[2] * 2.0],
            },
            GeometryEntryIR::Sphere { radius, .. } => GeometryShape::Box {
                size: [*radius * 2.0, *radius * 2.0, *radius * 2.0],
            },
            GeometryEntryIR::Ellipse { radii, height, .. } => GeometryShape::Cylinder {
                radius: radii[0].max(radii[1]),
                height: *height,
            },
        }
    }
    let shape = ir_to_shape(geometry);

    // 6. Check FDM hints exist
    let cell_size = match &problem.backend_policy.discretization_hints {
        Some(DiscretizationHintsIR { fdm: Some(fdm), .. }) => fdm.cell,
        _ => {
            errors.push(
                "FDM discretization hints (cell size) are required for Phase 1 execution"
                    .to_string(),
            );
            [1e-9, 1e-9, 1e-9] // placeholder
        }
    };

    // 7. Check only one magnet
    if problem.magnets.len() != 1 {
        errors.push(format!(
            "Phase 1 supports exactly one magnet, found {}",
            problem.magnets.len()
        ));
    }

    validate_executable_outputs(
        &problem.study.sampling().outputs,
        enable_exchange,
        enable_demag,
        external_field.is_some(),
        &mut errors,
    );
    if problem.backend_policy.execution_precision != ExecutionPrecision::Double {
        errors.push(
            "execution_precision='single' is reserved for the Phase 2 CUDA path; the current CPU reference runner supports only 'double'"
                .to_string(),
        );
    }

    // ---- lowering: geometry → grid + active_mask ----
    let provided_grid_asset = problem.geometry_assets.as_ref().and_then(|assets| {
        assets
            .fdm_grid_assets
            .iter()
            .find(|asset| asset.geometry_name == geometry.name())
    });

    let (bounding_size, active_mask, grid_cells, used_precomputed_asset) = if let Some(asset) =
        provided_grid_asset
    {
        validate_grid_asset_cell_size(asset, cell_size, &mut errors);
        (
            [
                asset.cells[0] as f64 * asset.cell_size[0],
                asset.cells[1] as f64 * asset.cell_size[1],
                asset.cells[2] as f64 * asset.cell_size[2],
            ],
            Some(asset.active_mask.clone()),
            asset.cells,
            true,
        )
    } else {
        match &shape {
            GeometryShape::Box { size } => {
                let grid_cells = [
                    (size[0] / cell_size[0]).round().max(1.0) as u32,
                    (size[1] / cell_size[1]).round().max(1.0) as u32,
                    (size[2] / cell_size[2]).round().max(1.0) as u32,
                ];
                (*size, None, grid_cells, false)
            }
            GeometryShape::Cylinder { radius, height } => {
                let diameter = 2.0 * radius;
                let bbox = [diameter, diameter, *height];
                let nx = (bbox[0] / cell_size[0]).round().max(1.0) as u32;
                let ny = (bbox[1] / cell_size[1]).round().max(1.0) as u32;
                let nz = (bbox[2] / cell_size[2]).round().max(1.0) as u32;
                let n = (nx * ny * nz) as usize;
                let cx = nx as f64 * cell_size[0] * 0.5;
                let cy = ny as f64 * cell_size[1] * 0.5;
                let r2 = radius * radius;
                let mut mask = vec![false; n];
                for z in 0..nz {
                    for y in 0..ny {
                        for x in 0..nx {
                            let px = (x as f64 + 0.5) * cell_size[0] - cx;
                            let py = (y as f64 + 0.5) * cell_size[1] - cy;
                            let idx = (x + nx * (y + ny * z)) as usize;
                            mask[idx] = (px * px + py * py) <= r2;
                        }
                    }
                }
                (bbox, Some(mask), [nx, ny, nz], false)
            }
            GeometryShape::Imported { source, format } => {
                errors.push(format!(
                        "geometry '{}' ({format}:{source}) requires a precomputed FDM grid asset; no voxelized active_mask was provided",
                        geometry.name()
                    ));
                ([1.0, 1.0, 1.0], None, [1, 1, 1], false)
            }
            GeometryShape::Difference { ref base, ref tool } => {
                // Compute bounding box from the base geometry
                let bbox = match base.as_ref() {
                    GeometryShape::Box { size } => *size,
                    GeometryShape::Cylinder { radius, height } => {
                        [2.0 * radius, 2.0 * radius, *height]
                    }
                    _ => {
                        errors.push("CSG Difference: base must be a Box or Cylinder".to_string());
                        [1.0, 1.0, 1.0]
                    }
                };
                let nx = (bbox[0] / cell_size[0]).round().max(1.0) as u32;
                let ny = (bbox[1] / cell_size[1]).round().max(1.0) as u32;
                let nz = (bbox[2] / cell_size[2]).round().max(1.0) as u32;
                let n = (nx * ny * nz) as usize;
                let mut mask = vec![true; n];

                // Base geometry mask: for Box, all cells are active (mask stays true).
                // For Cylinder base, apply the cylinder mask.
                if let GeometryShape::Cylinder { radius, .. } = base.as_ref() {
                    let cx = nx as f64 * cell_size[0] * 0.5;
                    let cy = ny as f64 * cell_size[1] * 0.5;
                    let r2 = radius * radius;
                    for z in 0..nz {
                        for y in 0..ny {
                            for x in 0..nx {
                                let px = (x as f64 + 0.5) * cell_size[0] - cx;
                                let py = (y as f64 + 0.5) * cell_size[1] - cy;
                                let idx = (x + nx * (y + ny * z)) as usize;
                                mask[idx] = (px * px + py * py) <= r2;
                            }
                        }
                    }
                }

                // Subtract tool geometry
                match tool.as_ref() {
                    GeometryShape::Cylinder { radius, .. } => {
                        let cx = nx as f64 * cell_size[0] * 0.5;
                        let cy = ny as f64 * cell_size[1] * 0.5;
                        let r2 = radius * radius;
                        for z in 0..nz {
                            for y in 0..ny {
                                for x in 0..nx {
                                    let px = (x as f64 + 0.5) * cell_size[0] - cx;
                                    let py = (y as f64 + 0.5) * cell_size[1] - cy;
                                    let idx = (x + nx * (y + ny * z)) as usize;
                                    if (px * px + py * py) <= r2 {
                                        mask[idx] = false;
                                    }
                                }
                            }
                        }
                    }
                    GeometryShape::Box { size: tool_size } => {
                        let hx = tool_size[0] * 0.5;
                        let hy = tool_size[1] * 0.5;
                        let cx = nx as f64 * cell_size[0] * 0.5;
                        let cy = ny as f64 * cell_size[1] * 0.5;
                        for z in 0..nz {
                            for y in 0..ny {
                                for x in 0..nx {
                                    let px = (x as f64 + 0.5) * cell_size[0] - cx;
                                    let py = (y as f64 + 0.5) * cell_size[1] - cy;
                                    let idx = (x + nx * (y + ny * z)) as usize;
                                    if px.abs() <= hx && py.abs() <= hy {
                                        mask[idx] = false;
                                    }
                                }
                            }
                        }
                    }
                    _ => {
                        errors.push("CSG Difference: tool must be a Box or Cylinder".to_string());
                    }
                }

                (bbox, Some(mask), [nx, ny, nz], false)
            }
        }
    };

    // Validate that the requested geometry is close to an integer multiple of cell size.
    // If the fractional part exceeds tolerance, the realized geometry deviates from the
    // requested one which could silently change the physics.
    let realized_size = [
        grid_cells[0] as f64 * cell_size[0],
        grid_cells[1] as f64 * cell_size[1],
        grid_cells[2] as f64 * cell_size[2],
    ];
    const GRID_TOLERANCE: f64 = 1e-6;
    for (axis, (requested, realized)) in ["x", "y", "z"]
        .iter()
        .zip(bounding_size.iter().zip(realized_size.iter()))
    {
        let rel_err = (realized - requested).abs() / requested;
        if rel_err > GRID_TOLERANCE {
            errors.push(format!(
                "geometry size along {} ({:.6e} m) is not an integer multiple of cell size ({:.6e} m); \
                 realized grid would be {:.6e} m (relative error {:.2e}). \
                 Adjust size or cell to be a clean multiple.",
                axis, requested, cell_size[["x", "y", "z"].iter().position(|&a| a == *axis).unwrap()],
                realized, rel_err
            ));
        }
    }

    if !errors.is_empty() {
        return Err(PlanError { reasons: errors });
    }

    let magnet = &problem.magnets[0];
    let material = problem
        .materials
        .iter()
        .find(|m| m.name == magnet.material)
        .expect("validation should have caught missing material");

    let n_cells = (grid_cells[0] * grid_cells[1] * grid_cells[2]) as usize;
    let initial_magnetization = match &magnet.initial_magnetization {
        Some(InitialMagnetizationIR::Uniform { value }) => {
            if let Some(ref mask) = active_mask {
                mask.iter()
                    .map(|&active| if active { *value } else { [0.0, 0.0, 0.0] })
                    .collect()
            } else {
                vec![*value; n_cells]
            }
        }
        Some(InitialMagnetizationIR::RandomSeeded { seed }) => {
            let mut vectors = generate_random_unit_vectors(*seed, n_cells);
            if let Some(ref mask) = active_mask {
                for (i, active) in mask.iter().enumerate() {
                    if !active {
                        vectors[i] = [0.0, 0.0, 0.0];
                    }
                }
            }
            vectors
        }
        Some(InitialMagnetizationIR::SampledField { values }) => values.clone(),
        None => {
            if let Some(ref mask) = active_mask {
                mask.iter()
                    .map(|&active| {
                        if active {
                            [1.0, 0.0, 0.0]
                        } else {
                            [0.0, 0.0, 0.0]
                        }
                    })
                    .collect()
            } else {
                vec![[1.0, 0.0, 0.0]; n_cells]
            }
        }
    };

    let (integrator, fixed_timestep, gyromagnetic_ratio, relaxation) =
        planned_study_controls(problem, &mut errors);
    if !errors.is_empty() {
        return Err(PlanError { reasons: errors });
    }

    let active_count = active_mask
        .as_ref()
        .map(|m| m.iter().filter(|&&v| v).count())
        .unwrap_or(n_cells);

    let geometry_label = match &shape {
        GeometryShape::Box { .. } if used_precomputed_asset => format!(
            "Box geometry used precomputed FDM grid asset: {}x{}x{} cells",
            grid_cells[0], grid_cells[1], grid_cells[2]
        ),
        GeometryShape::Box { .. } => format!(
            "Box geometry lowered to {}x{}x{} grid",
            grid_cells[0], grid_cells[1], grid_cells[2]
        ),
        GeometryShape::Cylinder { radius, .. } if used_precomputed_asset => format!(
            "Cylinder (r={:.3e}) used precomputed FDM grid asset: {}x{}x{} cells, {}/{} active cells",
            radius, grid_cells[0], grid_cells[1], grid_cells[2], active_count, n_cells
        ),
        GeometryShape::Cylinder { radius, .. } => format!(
            "Cylinder (r={:.3e}) voxelized to {}x{}x{} grid, {}/{} active cells",
            radius, grid_cells[0], grid_cells[1], grid_cells[2], active_count, n_cells
        ),
        GeometryShape::Imported { format, .. } => format!(
            "Imported geometry ({format}) used precomputed FDM grid asset: {}x{}x{} cells, {}/{} active cells",
            grid_cells[0], grid_cells[1], grid_cells[2], active_count, n_cells
        ),
        GeometryShape::Difference { .. } => format!(
            "CSG Difference voxelized to {}x{}x{} grid, {}/{} active cells",
            grid_cells[0], grid_cells[1], grid_cells[2], active_count, n_cells
        ),
    };

    let fdm_plan = FdmPlanIR {
        grid: GridDimensions { cells: grid_cells },
        cell_size,
        region_mask: vec![0; n_cells],
        active_mask,
        initial_magnetization,
        material: FdmMaterialIR {
            name: material.name.clone(),
            saturation_magnetisation: material.saturation_magnetisation,
            exchange_stiffness: material.exchange_stiffness,
            damping: material.damping,
        },
        enable_exchange,
        enable_demag,
        external_field,
        gyromagnetic_ratio,
        precision: problem.backend_policy.execution_precision,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        integrator,
        fixed_timestep,
        relaxation,
    };
    let study_note = if let Some(control) = fdm_plan.relaxation.as_ref() {
        format!(
            "study: relaxation algorithm={} torque_tolerance={:.6e} energy_tolerance={} max_steps={}",
            control.algorithm.as_str(),
            control.torque_tolerance,
            control
                .energy_tolerance
                .map(|value| format!("{value:.6e}"))
                .unwrap_or_else(|| "none".to_string()),
            control.max_steps
        )
    } else {
        "study: time_evolution".to_string()
    };

    Ok(ExecutionPlanIR {
        common: CommonPlanMeta {
            ir_version: IR_VERSION.to_string(),
            requested_backend: problem.backend_policy.requested_backend,
            resolved_backend,
            execution_mode: problem.validation_profile.execution_mode,
        },
        backend_plan: BackendPlanIR::Fdm(fdm_plan),
        output_plan: OutputPlanIR {
            outputs: problem.study.sampling().outputs.clone(),
        },
        provenance: ProvenancePlanIR {
            notes: vec![
                "Phase 1 reference FDM planner".to_string(),
                geometry_label,
                format!(
                    "realized grid size: [{:.6e}, {:.6e}, {:.6e}] m",
                    realized_size[0], realized_size[1], realized_size[2]
                ),
                format!(
                    "active terms: exchange={}, demag={}, zeeman={}",
                    enable_exchange,
                    enable_demag,
                    external_field.is_some()
                ),
                study_note,
            ],
        },
    })
}

fn plan_fem(
    problem: &ProblemIR,
    resolved_backend: BackendTarget,
) -> Result<ExecutionPlanIR, PlanError> {
    let mut errors = Vec::new();

    if problem.geometry.entries.len() != 1 {
        errors.push(format!(
            "current FEM planning baseline supports exactly one geometry entry, found {}",
            problem.geometry.entries.len()
        ));
    }
    if problem.magnets.len() != 1 {
        errors.push(format!(
            "current FEM planning baseline supports exactly one magnet, found {}",
            problem.magnets.len()
        ));
    }

    let fem_hints = match &problem.backend_policy.discretization_hints {
        Some(DiscretizationHintsIR { fem: Some(fem), .. }) => fem,
        _ => {
            errors.push(
                "FEM discretization hints (order + hmax) are required for backend='fem'"
                    .to_string(),
            );
            if !errors.is_empty() {
                return Err(PlanError { reasons: errors });
            }
            unreachable!();
        }
    };

    let geometry = &problem.geometry.entries[0];
    let magnet = &problem.magnets[0];
    let material = problem
        .materials
        .iter()
        .find(|candidate| candidate.name == magnet.material)
        .cloned()
        .expect("validation should have caught missing FEM material");

    let mesh_asset = problem
        .geometry_assets
        .as_ref()
        .and_then(|assets| {
            assets
                .fem_mesh_assets
                .iter()
                .find(|asset| asset.geometry_name == geometry.name())
        })
        .cloned();

    let mesh_asset = match mesh_asset {
        Some(asset) => asset,
        None => {
            errors.push(format!(
                "geometry '{}' requires a precomputed FEM mesh asset; no MeshIR was provided",
                geometry.name()
            ));
            if !errors.is_empty() {
                return Err(PlanError { reasons: errors });
            }
            unreachable!();
        }
    };

    let mut enable_exchange = false;
    let mut enable_demag = false;
    let mut external_field = None;
    for term in &problem.energy_terms {
        match term {
            fullmag_ir::EnergyTermIR::Exchange => {
                if enable_exchange {
                    errors.push("Exchange is declared more than once".to_string());
                }
                enable_exchange = true;
            }
            fullmag_ir::EnergyTermIR::Demag => {
                if enable_demag {
                    errors.push("Demag is declared more than once".to_string());
                }
                enable_demag = true;
            }
            fullmag_ir::EnergyTermIR::Zeeman { b } => {
                if external_field.is_some() {
                    errors.push("Zeeman is declared more than once".to_string());
                }
                external_field = Some([b[0] / MU0, b[1] / MU0, b[2] / MU0]);
            }
            other => {
                errors.push(format!(
                    "energy term '{:?}' is semantic-only in the current FEM planning baseline",
                    other
                ));
            }
        }
    }
    if !(enable_exchange || enable_demag || external_field.is_some()) {
        errors.push(
            "the current FEM planning baseline requires at least one of Exchange, Demag, or Zeeman"
                .to_string(),
        );
    }

    validate_executable_outputs(
        &problem.study.sampling().outputs,
        enable_exchange,
        enable_demag,
        external_field.is_some(),
        &mut errors,
    );
    if problem.backend_policy.execution_precision != ExecutionPrecision::Double {
        errors.push(
            "execution_precision='single' is not yet supported by the FEM planning baseline"
                .to_string(),
        );
    }

    let mesh = match (&mesh_asset.mesh, &mesh_asset.mesh_source) {
        (Some(mesh), _) => mesh.clone(),
        (None, Some(source)) => load_mesh_from_source(source).map_err(|message| PlanError {
            reasons: vec![message],
        })?,
        (None, None) => {
            return Err(PlanError {
                reasons: vec![format!(
                    "geometry '{}' requires a FEM mesh asset with inline mesh or mesh_source",
                    geometry.name()
                )],
            })
        }
    };

    let n_nodes = mesh.nodes.len();
    let initial_magnetization = match &magnet.initial_magnetization {
        Some(InitialMagnetizationIR::Uniform { value }) => vec![*value; n_nodes],
        Some(InitialMagnetizationIR::RandomSeeded { seed }) => {
            generate_random_unit_vectors(*seed, n_nodes)
        }
        Some(InitialMagnetizationIR::SampledField { values }) => {
            if values.len() != n_nodes {
                errors.push(format!(
                    "sampled_field initial magnetization has {} vectors, but FEM mesh '{}' has {} nodes",
                    values.len(),
                    mesh.mesh_name,
                    n_nodes
                ));
            }
            values.clone()
        }
        None => vec![[1.0, 0.0, 0.0]; n_nodes],
    };

    let (integrator, fixed_timestep, gyromagnetic_ratio, relaxation) =
        planned_study_controls(problem, &mut errors);

    if !errors.is_empty() {
        return Err(PlanError { reasons: errors });
    }

    let n_elements = mesh.elements.len();
    let mesh_name = mesh.mesh_name.clone();
    let fem_plan = FemPlanIR {
        mesh_name: mesh_name.clone(),
        mesh_source: mesh_asset.mesh_source,
        mesh,
        fe_order: fem_hints.order,
        hmax: fem_hints.hmax,
        initial_magnetization,
        material,
        enable_exchange,
        enable_demag,
        external_field,
        gyromagnetic_ratio,
        precision: problem.backend_policy.execution_precision,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        integrator,
        fixed_timestep,
        relaxation,
    };
    let study_note = if let Some(control) = fem_plan.relaxation.as_ref() {
        format!(
            "study: relaxation algorithm={} torque_tolerance={:.6e} energy_tolerance={} max_steps={}",
            control.algorithm.as_str(),
            control.torque_tolerance,
            control
                .energy_tolerance
                .map(|value| format!("{value:.6e}"))
                .unwrap_or_else(|| "none".to_string()),
            control.max_steps
        )
    } else {
        "study: time_evolution".to_string()
    };

    Ok(ExecutionPlanIR {
        common: CommonPlanMeta {
            ir_version: IR_VERSION.to_string(),
            requested_backend: problem.backend_policy.requested_backend,
            resolved_backend,
            execution_mode: problem.validation_profile.execution_mode,
        },
        backend_plan: BackendPlanIR::Fem(fem_plan),
        output_plan: OutputPlanIR {
            outputs: problem.study.sampling().outputs.clone(),
        },
        provenance: ProvenancePlanIR {
            notes: vec![
                "Bootstrap FEM planner with precomputed MeshIR asset".to_string(),
                format!("mesh asset: {mesh_name} ({n_nodes} nodes, {n_elements} elements)"),
                format!(
                    "active terms: exchange={}, demag={}, zeeman={}",
                    enable_exchange,
                    enable_demag,
                    external_field.is_some()
                ),
                study_note,
                "FEM CPU reference execution is available; native MFEM/libCEED/hypre GPU execution remains in progress"
                    .to_string(),
            ],
        },
    })
}

fn resolve_auto_backend(problem: &ProblemIR) -> BackendTarget {
    let hints = problem.backend_policy.discretization_hints.as_ref();
    let has_fdm = hints.and_then(|value| value.fdm.as_ref()).is_some()
        || problem
            .geometry_assets
            .as_ref()
            .is_some_and(|assets| !assets.fdm_grid_assets.is_empty());
    let has_fem = hints.and_then(|value| value.fem.as_ref()).is_some()
        || problem
            .geometry_assets
            .as_ref()
            .is_some_and(|assets| !assets.fem_mesh_assets.is_empty());

    match (has_fdm, has_fem) {
        (false, true) => BackendTarget::Fem,
        _ => BackendTarget::Fdm,
    }
}

fn validate_executable_outputs(
    outputs: &[OutputIR],
    enable_exchange: bool,
    enable_demag: bool,
    enable_zeeman: bool,
    errors: &mut Vec<String>,
) {
    let allowed_fields = ["m", "H_ex", "H_demag", "H_ext", "H_eff"];
    let allowed_scalars = [
        "E_ex",
        "E_demag",
        "E_ext",
        "E_total",
        "time",
        "step",
        "solver_dt",
        "max_dm_dt",
        "max_h_eff",
    ];
    let mut seen = BTreeSet::new();

    for output in outputs {
        match output {
            OutputIR::Field { name, .. } => {
                if !allowed_fields.contains(&name.as_str()) {
                    errors.push(format!(
                        "field output '{}' is not executable in the current FDM path; allowed fields are m, H_ex, H_demag, H_ext, and H_eff",
                        name
                    ));
                } else if name == "H_ex" && !enable_exchange {
                    errors.push("field output 'H_ex' requires Exchange()".to_string());
                } else if name == "H_demag" && !enable_demag {
                    errors.push("field output 'H_demag' requires Demag()".to_string());
                } else if name == "H_ext" && !enable_zeeman {
                    errors.push("field output 'H_ext' requires Zeeman(...)".to_string());
                }
                if !seen.insert(format!("field:{name}")) {
                    errors.push(format!(
                        "field output '{}' is declared more than once in Phase 1",
                        name
                    ));
                }
            }
            OutputIR::Scalar { name, .. } => {
                if !allowed_scalars.contains(&name.as_str()) {
                    errors.push(format!(
                        "scalar output '{}' is not executable in the current FDM path; allowed scalars are E_ex, E_demag, E_ext, E_total, time, step, solver_dt, max_dm_dt, and max_h_eff",
                        name
                    ));
                } else if name == "E_ex" && !enable_exchange {
                    errors.push("scalar output 'E_ex' requires Exchange()".to_string());
                } else if name == "E_demag" && !enable_demag {
                    errors.push("scalar output 'E_demag' requires Demag()".to_string());
                } else if name == "E_ext" && !enable_zeeman {
                    errors.push("scalar output 'E_ext' requires Zeeman(...)".to_string());
                }
                if !seen.insert(format!("scalar:{name}")) {
                    errors.push(format!(
                        "scalar output '{}' is declared more than once in Phase 1",
                        name
                    ));
                }
            }
        }
    }
}

fn validate_grid_asset_cell_size(
    asset: &FdmGridAssetIR,
    requested_cell_size: [f64; 3],
    errors: &mut Vec<String>,
) {
    const CELL_TOLERANCE: f64 = 1e-12;
    for axis in 0..3 {
        let requested = requested_cell_size[axis];
        let provided = asset.cell_size[axis];
        if (requested - provided).abs() > CELL_TOLERANCE * requested.max(1.0) {
            let label = ["x", "y", "z"][axis];
            errors.push(format!(
                "fdm_grid_asset for geometry '{}' has cell_size[{label}]={provided:.6e} m, but planner requested {requested:.6e} m",
                asset.geometry_name
            ));
        }
    }
}

/// Generate deterministic random unit vectors from a seed.
pub fn generate_random_unit_vectors(seed: u64, count: usize) -> Vec<[f64; 3]> {
    // Simple xorshift64-based PRNG for deterministic random unit vectors.
    let mut state = seed;
    let mut vectors = Vec::with_capacity(count);

    for _ in 0..count {
        // Generate 3 random f64 in [-1, 1]
        let mut components = [0.0f64; 3];
        loop {
            for c in &mut components {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                *c = (state as f64 / u64::MAX as f64) * 2.0 - 1.0;
            }
            let norm = (components[0] * components[0]
                + components[1] * components[1]
                + components[2] * components[2])
                .sqrt();
            if norm > 1e-10 {
                components[0] /= norm;
                components[1] /= norm;
                components[2] /= norm;
                break;
            }
        }
        vectors.push(components);
    }
    vectors
}

fn load_mesh_from_source(source: &str) -> Result<MeshIR, String> {
    let path = Path::new(source);
    let suffix = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    match suffix.as_str() {
        "json" => {
            let payload = fs::read_to_string(path)
                .map_err(|err| format!("failed to read FEM mesh_source '{}': {}", source, err))?;
            let mesh: MeshIR = serde_json::from_str(&payload)
                .map_err(|err| format!("failed to parse FEM mesh_source '{}': {}", source, err))?;
            mesh.validate().map_err(|errors| {
                format!(
                    "mesh_source '{}' is invalid: {}",
                    source,
                    errors.join("; ")
                )
            })?;
            Ok(mesh)
        }
        other => Err(format!(
            "unsupported FEM mesh_source format '{}'; current lazy FEM planner supports only .json mesh assets",
            if other.is_empty() { "<none>" } else { other }
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bootstrap_example_plans_successfully() {
        let ir = ProblemIR::bootstrap_example();
        let plan = plan(&ir).expect("bootstrap example should plan successfully");

        match &plan.backend_plan {
            BackendPlanIR::Fdm(fdm) => {
                // Box(200e-9, 20e-9, 6e-9) with cell(2e-9, 2e-9, 2e-9)
                assert_eq!(fdm.grid.cells, [100, 10, 3]);
                assert_eq!(fdm.cell_size, [2e-9, 2e-9, 2e-9]);
                assert_eq!(fdm.material.name, "Py");
                assert_eq!(fdm.material.exchange_stiffness, 13e-12);
                assert_eq!(fdm.gyromagnetic_ratio, 2.211e5);
                assert_eq!(fdm.precision, ExecutionPrecision::Double);
                assert_eq!(fdm.initial_magnetization.len(), (100 * 10 * 3) as usize);
            }
            _ => panic!("expected FDM plan"),
        }
    }

    #[test]
    fn unsupported_term_is_rejected() {
        let mut ir = ProblemIR::bootstrap_example();
        ir.energy_terms = vec![fullmag_ir::EnergyTermIR::InterfacialDmi { d: 3e-3 }];

        let err = plan(&ir).expect_err("DMI should be rejected");
        assert!(err.reasons.iter().any(|r| r.contains("semantic-only")));
    }

    #[test]
    fn imported_geometry_without_grid_asset_is_rejected() {
        let mut ir = ProblemIR::bootstrap_example();
        ir.geometry.entries = vec![GeometryEntryIR::ImportedGeometry {
            name: "mesh".to_string(),
            source: "sample.step".to_string(),
            format: "step".to_string(),
        }];
        ir.regions[0].geometry = "mesh".to_string();

        let err = plan(&ir).expect_err("imported geometry should be rejected");
        assert!(err
            .reasons
            .iter()
            .any(|r| r.contains("requires a precomputed FDM grid asset")));
    }

    #[test]
    fn imported_geometry_with_grid_asset_plans_successfully() {
        let mut ir = ProblemIR::bootstrap_example();
        ir.geometry.entries = vec![GeometryEntryIR::ImportedGeometry {
            name: "mesh".to_string(),
            source: "sample.stl".to_string(),
            format: "stl".to_string(),
        }];
        ir.regions[0].geometry = "mesh".to_string();
        ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
            fdm_grid_assets: vec![fullmag_ir::FdmGridAssetIR {
                geometry_name: "mesh".to_string(),
                cells: [4, 2, 1],
                cell_size: [2e-9, 2e-9, 2e-9],
                origin: [-4e-9, -2e-9, -1e-9],
                active_mask: vec![true, true, true, true, false, false, false, false],
            }],
            fem_mesh_assets: vec![],
        });

        let plan = plan(&ir).expect("imported geometry with grid asset should plan");
        match plan.backend_plan {
            BackendPlanIR::Fdm(fdm) => {
                assert_eq!(fdm.grid.cells, [4, 2, 1]);
                assert_eq!(fdm.active_mask.unwrap().len(), 8);
            }
            _ => panic!("expected FDM plan"),
        }
    }

    #[test]
    fn fem_backend_with_mesh_asset_plans_successfully() {
        let mut ir = ProblemIR::bootstrap_example();
        ir.backend_policy.requested_backend = BackendTarget::Fem;
        ir.backend_policy.discretization_hints = Some(fullmag_ir::DiscretizationHintsIR {
            fdm: Some(fullmag_ir::FdmHintsIR {
                cell: [2e-9, 2e-9, 5e-9],
                default_cell: None,
                per_magnet: None,
                demag: None,
            }),
            fem: Some(fullmag_ir::FemHintsIR {
                order: 1,
                hmax: 2e-9,
                mesh: Some("meshes/unit_tet.msh".to_string()),
            }),
            hybrid: None,
        });
        ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
            fdm_grid_assets: vec![],
            fem_mesh_assets: vec![fullmag_ir::FemMeshAssetIR {
                geometry_name: "strip".to_string(),
                mesh_source: Some("meshes/unit_tet.msh".to_string()),
                mesh: Some(fullmag_ir::MeshIR {
                    mesh_name: "strip".to_string(),
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
                }),
            }],
        });

        let plan = plan(&ir).expect("FEM mesh asset should produce a FemPlanIR");
        match plan.backend_plan {
            BackendPlanIR::Fem(fem) => {
                assert_eq!(fem.mesh.mesh_name, "strip");
                assert_eq!(fem.material.name, "Py");
                assert_eq!(fem.initial_magnetization.len(), 4);
                assert!(fem.enable_exchange);
                assert!(!fem.enable_demag);
            }
            _ => panic!("expected FEM plan"),
        }
    }

    #[test]
    fn fem_backend_with_mesh_source_json_plans_successfully() {
        let mesh_path = std::env::temp_dir().join(format!(
            "fullmag-plan-test-mesh-{}.json",
            std::process::id()
        ));
        let mesh_json = serde_json::json!({
            "mesh_name": "strip",
            "nodes": [
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0]
            ],
            "elements": [[0, 1, 2, 3]],
            "element_markers": [1],
            "boundary_faces": [[0, 1, 2]],
            "boundary_markers": [1]
        });
        std::fs::write(&mesh_path, serde_json::to_string(&mesh_json).unwrap()).unwrap();

        let mut ir = ProblemIR::bootstrap_example();
        ir.backend_policy.requested_backend = BackendTarget::Fem;
        ir.backend_policy.discretization_hints = Some(fullmag_ir::DiscretizationHintsIR {
            fdm: Some(fullmag_ir::FdmHintsIR {
                cell: [2e-9, 2e-9, 5e-9],
                default_cell: None,
                per_magnet: None,
                demag: None,
            }),
            fem: Some(fullmag_ir::FemHintsIR {
                order: 1,
                hmax: 2e-9,
                mesh: Some(mesh_path.display().to_string()),
            }),
            hybrid: None,
        });
        ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
            fdm_grid_assets: vec![],
            fem_mesh_assets: vec![fullmag_ir::FemMeshAssetIR {
                geometry_name: "strip".to_string(),
                mesh_source: Some(mesh_path.display().to_string()),
                mesh: None,
            }],
        });

        let plan = plan(&ir).expect("FEM mesh_source JSON should produce a FemPlanIR");
        match plan.backend_plan {
            BackendPlanIR::Fem(fem) => {
                assert_eq!(fem.mesh.mesh_name, "strip");
                assert_eq!(fem.mesh.nodes.len(), 4);
                assert_eq!(fem.mesh.elements.len(), 1);
            }
            _ => panic!("expected FEM plan"),
        }

        let _ = std::fs::remove_file(mesh_path);
    }

    #[test]
    fn random_seeded_generates_correct_count() {
        let vectors = generate_random_unit_vectors(42, 100);
        assert_eq!(vectors.len(), 100);
        for v in &vectors {
            let norm = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
            assert!((norm - 1.0).abs() < 1e-10, "vector not unit: norm={}", norm);
        }
    }

    #[test]
    fn inactive_term_output_is_rejected_for_execution() {
        let mut ir = ProblemIR::bootstrap_example();
        let mut outputs = ir.study.sampling().outputs.clone();
        outputs.push(OutputIR::Field {
            name: "H_demag".to_string(),
            every_seconds: 1e-12,
        });
        ir.study = fullmag_ir::StudyIR::TimeEvolution {
            dynamics: ir.study.dynamics().clone(),
            sampling: fullmag_ir::SamplingIR { outputs },
        };

        let err = plan(&ir).expect_err("output requiring inactive term should be rejected");
        assert!(err
            .reasons
            .iter()
            .any(|reason| reason.contains("requires Demag()")));
    }

    #[test]
    fn llg_overdamped_relaxation_lowers_to_relaxation_control() {
        let mut ir = ProblemIR::bootstrap_example();
        ir.study = fullmag_ir::StudyIR::Relaxation {
            algorithm: fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped,
            dynamics: ir.study.dynamics().clone(),
            torque_tolerance: 1e-3,
            energy_tolerance: Some(1e-12),
            max_steps: 250,
            sampling: ir.study.sampling().clone(),
        };

        let plan = plan(&ir).expect("llg_overdamped relaxation should be plannable");
        match plan.backend_plan {
            BackendPlanIR::Fdm(fdm) => {
                let control = fdm.relaxation.expect("relaxation control");
                assert_eq!(
                    control.algorithm,
                    fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped
                );
                assert_eq!(control.max_steps, 250);
                assert_eq!(control.energy_tolerance, Some(1e-12));
            }
            _ => panic!("expected FDM plan"),
        }
    }

    #[test]
    fn projected_gradient_relaxation_is_defined_but_not_yet_executable() {
        let mut ir = ProblemIR::bootstrap_example();
        ir.study = fullmag_ir::StudyIR::Relaxation {
            algorithm: fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb,
            dynamics: ir.study.dynamics().clone(),
            torque_tolerance: 1e-3,
            energy_tolerance: None,
            max_steps: 250,
            sampling: ir.study.sampling().clone(),
        };

        let err = plan(&ir).expect_err("projected_gradient_bb should not be executable yet");
        assert!(err.reasons.iter().any(|reason| {
            reason.contains("projected_gradient_bb") && reason.contains("not yet executable")
        }));
    }

    #[test]
    fn single_precision_is_rejected_for_phase_one_cpu_execution() {
        let mut ir = ProblemIR::bootstrap_example();
        ir.backend_policy.execution_precision = ExecutionPrecision::Single;

        let err =
            plan(&ir).expect_err("single precision should not be executable on CPU reference");
        assert!(err
            .reasons
            .iter()
            .any(|reason| reason.contains("execution_precision='single'")));
    }
}
