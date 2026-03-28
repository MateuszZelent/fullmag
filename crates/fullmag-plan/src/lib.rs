//! Execution planning: lowers `ProblemIR` into backend-specific `ExecutionPlanIR`.
//!
//! Phase 1 scope: `Box/Cylinder/(ImportedGeometry + precomputed grid asset) +
//! (Exchange | Demag | Zeeman combinations) + fdm/strict`
//! is the legal executable path.
//! Additionally, `backend='fem'` produces an executable `FemPlanIR`
//! when a precomputed `MeshIR` asset is attached; runner execution is fully supported.

use fullmag_ir::{
    BackendPlanIR, BackendTarget, CommonPlanMeta, DiscretizationHintsIR, ExchangeBoundaryCondition,
    ExecutionMode, ExecutionPlanIR, ExecutionPrecision, FdmGridAssetIR, FdmHintsIR, FdmLayerPlanIR,
    FdmMaterialIR, FdmMultilayerPlanIR, FdmMultilayerSummaryIR, FdmPlanIR, FemPlanIR,
    GeometryEntryIR, GridDimensions, InitialMagnetizationIR, IntegratorChoice, MeshIR, OutputIR,
    OutputPlanIR, ProblemIR, ProvenancePlanIR, RelaxationAlgorithmIR, RelaxationControlIR,
    IR_VERSION,
};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs;
use std::path::Path;

const MU0: f64 = 4.0 * std::f64::consts::PI * 1e-7;
const PLACEMENT_TOLERANCE: f64 = 1e-12;
const GRID_TOLERANCE: f64 = 1e-6;

#[derive(Debug, Clone)]
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

#[derive(Debug, Clone)]
struct PlacedGeometry {
    name: String,
    shape: GeometryShape,
    translation: [f64; 3],
}

#[derive(Debug, Clone)]
struct LoweredBody {
    magnet_name: String,
    bounding_size: [f64; 3],
    native_grid: [u32; 3],
    native_cell_size: [f64; 3],
    native_origin: [f64; 3],
    native_active_mask: Option<Vec<bool>>,
    initial_magnetization: Vec<[f64; 3]>,
    material: FdmMaterialIR,
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

fn extract_multilayer_geometry(entry: &GeometryEntryIR) -> Result<PlacedGeometry, String> {
    match entry {
        GeometryEntryIR::Translate { name, base, by } => {
            let mut placed = extract_multilayer_geometry(base)?;
            placed.name = name.clone();
            for axis in 0..3 {
                placed.translation[axis] += by[axis];
            }
            Ok(placed)
        }
        GeometryEntryIR::Box { .. }
        | GeometryEntryIR::Cylinder { .. }
        | GeometryEntryIR::ImportedGeometry { .. }
        | GeometryEntryIR::Difference { .. } => Ok(PlacedGeometry {
            name: entry.name().to_string(),
            shape: ir_to_shape(entry),
            translation: [0.0, 0.0, 0.0],
        }),
        GeometryEntryIR::Union { .. } | GeometryEntryIR::Intersection { .. } => Err(format!(
            "geometry '{}' uses CSG union/intersection which is not yet supported by the public multilayer planner; use Box/Cylinder/Difference with optional Translate",
            entry.name()
        )),
        GeometryEntryIR::Ellipsoid { .. }
        | GeometryEntryIR::Sphere { .. }
        | GeometryEntryIR::Ellipse { .. } => Err(format!(
            "geometry '{}' is not yet supported by the public multilayer planner; use Box/Cylinder/Difference with optional Translate",
            entry.name()
        )),
    }
}

fn voxelize_shape(
    shape: &GeometryShape,
    cell_size: [f64; 3],
    errors: &mut Vec<String>,
) -> ([f64; 3], Option<Vec<bool>>, [u32; 3]) {
    match shape {
        GeometryShape::Box { size } => {
            let grid_cells = [
                (size[0] / cell_size[0]).round().max(1.0) as u32,
                (size[1] / cell_size[1]).round().max(1.0) as u32,
                (size[2] / cell_size[2]).round().max(1.0) as u32,
            ];
            (*size, None, grid_cells)
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
            (bbox, Some(mask), [nx, ny, nz])
        }
        GeometryShape::Imported { source, format } => {
            errors.push(format!(
                "geometry '{}:{}' requires a precomputed FDM grid asset in the public multilayer planner",
                format, source
            ));
            ([1.0, 1.0, 1.0], None, [1, 1, 1])
        }
        GeometryShape::Difference { base, tool } => {
            let bbox = match base.as_ref() {
                GeometryShape::Box { size } => *size,
                GeometryShape::Cylinder { radius, height } => [2.0 * radius, 2.0 * radius, *height],
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

            (bbox, Some(mask), [nx, ny, nz])
        }
    }
}

fn validate_realized_grid(
    label: &str,
    requested_size: [f64; 3],
    realized_cells: [u32; 3],
    cell_size: [f64; 3],
    errors: &mut Vec<String>,
) {
    let realized_size = [
        realized_cells[0] as f64 * cell_size[0],
        realized_cells[1] as f64 * cell_size[1],
        realized_cells[2] as f64 * cell_size[2],
    ];
    for axis in 0..3 {
        if requested_size[axis] <= 0.0 {
            continue;
        }
        let rel_err = (realized_size[axis] - requested_size[axis]).abs() / requested_size[axis];
        if rel_err > GRID_TOLERANCE {
            let axis_name = ["x", "y", "z"][axis];
            errors.push(format!(
                "{} size along {} ({:.6e} m) is not an integer multiple of cell size ({:.6e} m); realized grid would be {:.6e} m (relative error {:.2e})",
                label,
                axis_name,
                requested_size[axis],
                cell_size[axis],
                realized_size[axis],
                rel_err
            ));
        }
    }
}

fn fdm_default_cell(hints: &FdmHintsIR) -> [f64; 3] {
    hints.default_cell.unwrap_or(hints.cell)
}

fn cell_for_magnet(hints: &FdmHintsIR, magnet_name: &str) -> [f64; 3] {
    hints
        .per_magnet
        .as_ref()
        .and_then(|per_magnet| per_magnet.get(magnet_name))
        .map(|grid| grid.cell)
        .unwrap_or_else(|| fdm_default_cell(hints))
}

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
    Option<fullmag_ir::AdaptiveTimeStepIR>,
) {
    // Parse user-specified integrator string → Option<IntegratorChoice>.
    // "auto" resolves to None, which triggers per-study-kind default selection.
    let user_integrator = match problem.study.dynamics() {
        fullmag_ir::DynamicsIR::Llg { integrator, .. } => match integrator.as_str() {
            "heun" => Some(IntegratorChoice::Heun),
            "rk4" => Some(IntegratorChoice::Rk4),
            "rk23" => Some(IntegratorChoice::Rk23),
            "rk45" => Some(IntegratorChoice::Rk45),
            "abm3" => Some(IntegratorChoice::Abm3),
            "auto" => None,
            other => {
                errors.push(format!(
                    "integrator '{}' is not supported; use heun/rk4/rk23/rk45/abm3/auto",
                    other
                ));
                None
            }
        },
    };

    // Resolve "auto" to the physics-optimal default per study kind.
    // TimeEvolution → RK45 (mumax3's default: Dormand-Prince, 5th-order adaptive).
    // Relaxation    → algorithm.default_integrator() (e.g. LlgOverdamped→RK23).
    let integrator = match user_integrator {
        Some(choice) => choice,
        None => match &problem.study {
            fullmag_ir::StudyIR::TimeEvolution { .. } => IntegratorChoice::Rk45,
            fullmag_ir::StudyIR::Relaxation { algorithm, .. } => algorithm.default_integrator(),
        },
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
        if control.algorithm != RelaxationAlgorithmIR::LlgOverdamped
            && control.algorithm != RelaxationAlgorithmIR::ProjectedGradientBb
            && control.algorithm != RelaxationAlgorithmIR::NonlinearCg
        {
            errors.push(format!(
                "relaxation algorithm '{}' is defined but not yet executable in the current public runner; only 'llg_overdamped', 'projected_gradient_bb', and 'nonlinear_cg' are currently supported",
                control.algorithm.as_str()
            ));
        }
        control
    });

    let adaptive_timestep = match problem.study.dynamics() {
        fullmag_ir::DynamicsIR::Llg {
            adaptive_timestep, ..
        } => adaptive_timestep.clone(),
    };

    // Validate adaptive/fixed exclusivity and integrator compatibility.
    if adaptive_timestep.is_some() && fixed_timestep.is_some() {
        errors.push("adaptive_timestep and fixed_timestep are mutually exclusive".to_string());
    }
    if adaptive_timestep.is_some()
        && !matches!(integrator, IntegratorChoice::Rk23 | IntegratorChoice::Rk45)
    {
        errors.push(format!(
            "adaptive_timestep requires an embedded-error integrator (rk23, rk45), got {:?}",
            integrator,
        ));
    }

    (
        integrator,
        fixed_timestep,
        gyromagnetic_ratio,
        relaxation,
        adaptive_timestep,
    )
}

/// Plans a `ProblemIR` into an `ExecutionPlanIR`.
///
/// Current planner coverage:
/// - executable FDM: `Box | Cylinder | ImportedGeometry + precomputed active_mask`
///   with the narrow interaction subset and `Heun`,
/// - executable FEM: explicit `backend='fem'` with precomputed `MeshIR`.
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

    if problem.magnets.len() > 1 {
        return plan_fdm_multilayer(problem, resolved_backend);
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
            fullmag_ir::EnergyTermIR::Demag { .. } => {
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

    let (integrator, fixed_timestep, gyromagnetic_ratio, relaxation, adaptive_timestep) =
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
        adaptive_timestep,
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

fn plan_fdm_multilayer(
    problem: &ProblemIR,
    resolved_backend: BackendTarget,
) -> Result<ExecutionPlanIR, PlanError> {
    let mut errors = Vec::new();

    let fdm_hints = match &problem.backend_policy.discretization_hints {
        Some(DiscretizationHintsIR { fdm: Some(fdm), .. }) => fdm,
        _ => {
            return Err(PlanError {
                reasons: vec![
                    "FDM discretization hints are required for the public multilayer FDM path"
                        .to_string(),
                ],
            })
        }
    };
    let demag_hints = fdm_hints.demag.as_ref();
    let requested_strategy = demag_hints
        .map(|policy| policy.strategy.as_str())
        .unwrap_or("auto");
    if requested_strategy == "single_grid" {
        errors.push(
            "multi-body FDM currently supports only the multilayer_convolution strategy; 'single_grid' for multiple magnets is not yet executable"
                .to_string(),
        );
    }

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
            fullmag_ir::EnergyTermIR::Demag { .. } => {
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
                    "energy term '{:?}' is semantic-only in the current public multilayer FDM path",
                    other
                ));
            }
        }
    }
    if !(enable_exchange || enable_demag || external_field.is_some()) {
        errors.push(
            "the current executable multilayer FDM path requires at least one of Exchange, Demag, or Zeeman"
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
            "execution_precision='single' is reserved for the Phase 2 CUDA path; the current public multilayer FDM runner supports only 'double'"
                .to_string(),
        );
    }

    let geometry_by_name: BTreeMap<&str, &GeometryEntryIR> = problem
        .geometry
        .entries
        .iter()
        .map(|entry| (entry.name(), entry))
        .collect();
    let region_to_geometry: BTreeMap<&str, &str> = problem
        .regions
        .iter()
        .map(|region| (region.name.as_str(), region.geometry.as_str()))
        .collect();

    let mut lowered_bodies = Vec::with_capacity(problem.magnets.len());
    for magnet in &problem.magnets {
        let Some(geometry_name) = region_to_geometry.get(magnet.region.as_str()).copied() else {
            errors.push(format!(
                "magnet '{}' references region '{}' with no geometry binding",
                magnet.name, magnet.region
            ));
            continue;
        };
        let Some(geometry_entry) = geometry_by_name.get(geometry_name).copied() else {
            errors.push(format!(
                "magnet '{}' references geometry '{}' which is missing from geometry.entries",
                magnet.name, geometry_name
            ));
            continue;
        };

        let placed = match extract_multilayer_geometry(geometry_entry) {
            Ok(placed) => placed,
            Err(message) => {
                errors.push(message);
                continue;
            }
        };

        let cell_size = cell_for_magnet(fdm_hints, magnet.name.as_str());
        let provided_grid_asset = problem.geometry_assets.as_ref().and_then(|assets| {
            assets
                .fdm_grid_assets
                .iter()
                .find(|asset| asset.geometry_name == geometry_name)
        });

        let (bounding_size, active_mask, grid_cells, native_origin) =
            if let Some(asset) = provided_grid_asset {
                validate_grid_asset_cell_size(asset, cell_size, &mut errors);
                let bbox = [
                    asset.cells[0] as f64 * asset.cell_size[0],
                    asset.cells[1] as f64 * asset.cell_size[1],
                    asset.cells[2] as f64 * asset.cell_size[2],
                ];
                let mut origin = asset.origin;
                for axis in 0..3 {
                    origin[axis] += placed.translation[axis];
                }
                (bbox, Some(asset.active_mask.clone()), asset.cells, origin)
            } else {
                let (bbox, mask, cells) = voxelize_shape(&placed.shape, cell_size, &mut errors);
                validate_realized_grid(
                    &format!("geometry '{}'", geometry_name),
                    bbox,
                    cells,
                    cell_size,
                    &mut errors,
                );
                let origin = [
                    placed.translation[0] - bbox[0] * 0.5,
                    placed.translation[1] - bbox[1] * 0.5,
                    placed.translation[2] - bbox[2] * 0.5,
                ];
                (bbox, mask, cells, origin)
            };

        let Some(material) = problem
            .materials
            .iter()
            .find(|candidate| candidate.name == magnet.material)
        else {
            errors.push(format!(
                "magnet '{}' references missing material '{}'",
                magnet.name, magnet.material
            ));
            continue;
        };

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
                    for (index, active) in mask.iter().enumerate() {
                        if !active {
                            vectors[index] = [0.0, 0.0, 0.0];
                        }
                    }
                }
                vectors
            }
            Some(InitialMagnetizationIR::SampledField { values }) => {
                if values.len() != n_cells {
                    errors.push(format!(
                        "magnet '{}' sampled_field has {} vectors, but its realized native grid requires {} cells",
                        magnet.name,
                        values.len(),
                        n_cells
                    ));
                }
                values.clone()
            }
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

        lowered_bodies.push(LoweredBody {
            magnet_name: magnet.name.clone(),
            bounding_size,
            native_grid: grid_cells,
            native_cell_size: cell_size,
            native_origin,
            native_active_mask: active_mask,
            initial_magnetization,
            material: FdmMaterialIR {
                name: material.name.clone(),
                saturation_magnetisation: material.saturation_magnetisation,
                exchange_stiffness: material.exchange_stiffness,
                damping: material.damping,
            },
        });
    }

    if lowered_bodies.len() != problem.magnets.len() {
        if errors.is_empty() {
            errors.push(
                "failed to realize all magnets into multilayer bodies; see previous planner errors"
                    .to_string(),
            );
        }
        return Err(PlanError { reasons: errors });
    }

    let reference_xy = [
        lowered_bodies[0].bounding_size[0],
        lowered_bodies[0].bounding_size[1],
    ];
    let reference_center_xy = [
        lowered_bodies[0].native_origin[0] + lowered_bodies[0].bounding_size[0] * 0.5,
        lowered_bodies[0].native_origin[1] + lowered_bodies[0].bounding_size[1] * 0.5,
    ];
    for body in lowered_bodies.iter().skip(1) {
        let center_xy = [
            body.native_origin[0] + body.bounding_size[0] * 0.5,
            body.native_origin[1] + body.bounding_size[1] * 0.5,
        ];
        for axis in 0..2 {
            if (body.bounding_size[axis] - reference_xy[axis]).abs()
                > PLACEMENT_TOLERANCE * reference_xy[axis].max(1.0)
            {
                errors.push(format!(
                    "multilayer_convolution currently requires identical XY extents; magnet '{}' realizes to [{:.6e}, {:.6e}] m while the reference layer uses [{:.6e}, {:.6e}] m",
                    body.magnet_name,
                    body.bounding_size[0],
                    body.bounding_size[1],
                    reference_xy[0],
                    reference_xy[1]
                ));
                break;
            }
            if (center_xy[axis] - reference_center_xy[axis]).abs()
                > PLACEMENT_TOLERANCE * reference_xy[axis].max(1.0)
            {
                errors.push(format!(
                    "multilayer_convolution currently requires all bodies to share the same XY center; magnet '{}' is offset in {}",
                    body.magnet_name,
                    ["x", "y"][axis]
                ));
                break;
            }
        }
    }

    let mut z_intervals = lowered_bodies
        .iter()
        .map(|body| {
            (
                body.magnet_name.as_str(),
                body.native_origin[2],
                body.native_origin[2] + body.bounding_size[2],
            )
        })
        .collect::<Vec<_>>();
    z_intervals.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
    for pair in z_intervals.windows(2) {
        let previous = pair[0];
        let current = pair[1];
        if current.1 < previous.2 - PLACEMENT_TOLERANCE {
            errors.push(format!(
                "multilayer_convolution does not allow overlapping bodies in z; '{}' overlaps '{}'",
                current.0, previous.0
            ));
        }
    }

    let mut selected_mode = demag_hints
        .map(|policy| policy.mode.clone())
        .unwrap_or_else(|| "auto".to_string());
    if selected_mode == "auto" {
        selected_mode = if lowered_bodies.iter().all(|body| body.native_grid[2] == 1) {
            "two_d_stack".to_string()
        } else {
            "three_d".to_string()
        };
    }

    let max_native_z_cells = lowered_bodies
        .iter()
        .map(|body| body.native_grid[2])
        .max()
        .unwrap_or(1);
    let max_native_z_size = lowered_bodies
        .iter()
        .map(|body| body.bounding_size[2])
        .fold(0.0_f64, f64::max);
    let base_cell = fdm_default_cell(fdm_hints);
    let common_cells = if let Some(policy) = demag_hints {
        if let Some(cells) = policy.common_cells {
            cells
        } else if let Some(cells_xy) = policy.common_cells_xy {
            [cells_xy[0], cells_xy[1], max_native_z_cells.max(1)]
        } else {
            [
                (reference_xy[0] / base_cell[0]).round().max(1.0) as u32,
                (reference_xy[1] / base_cell[1]).round().max(1.0) as u32,
                (max_native_z_size / base_cell[2]).round().max(1.0) as u32,
            ]
        }
    } else {
        [
            (reference_xy[0] / base_cell[0]).round().max(1.0) as u32,
            (reference_xy[1] / base_cell[1]).round().max(1.0) as u32,
            (max_native_z_size / base_cell[2]).round().max(1.0) as u32,
        ]
    };
    let convolution_cell_size = [
        reference_xy[0] / common_cells[0] as f64,
        reference_xy[1] / common_cells[1] as f64,
        max_native_z_size / common_cells[2] as f64,
    ];

    let mut unique_shifts = BTreeSet::new();
    for dst in &lowered_bodies {
        for src in &lowered_bodies {
            unique_shifts.insert(
                ((dst.native_origin[2] - src.native_origin[2]) / convolution_cell_size[2]).round()
                    as i64,
            );
        }
    }

    let estimated_unique_kernels = unique_shifts.len() as u32;
    let estimated_pair_kernels = (lowered_bodies.len() * lowered_bodies.len()) as u32;
    let padded_len =
        (common_cells[0] * 2) as u64 * (common_cells[1] * 2) as u64 * (common_cells[2] * 2) as u64;
    let estimated_kernel_bytes = padded_len * 6 * 16 * estimated_unique_kernels as u64;

    let (integrator, fixed_timestep, gyromagnetic_ratio, relaxation, adaptive_timestep) =
        planned_study_controls(problem, &mut errors);
    if integrator != IntegratorChoice::Heun {
        errors.push(
            "the public multilayer FDM runner currently supports only the 'heun' integrator"
                .to_string(),
        );
    }
    if adaptive_timestep.is_some() {
        errors.push(
            "the public multilayer FDM runner does not yet support adaptive_timestep".to_string(),
        );
    }
    if relaxation
        .as_ref()
        .is_some_and(|control| control.algorithm != RelaxationAlgorithmIR::LlgOverdamped)
    {
        errors.push(
            "the public multilayer FDM runner currently supports only 'llg_overdamped' relaxation"
                .to_string(),
        );
    }

    if !errors.is_empty() {
        return Err(PlanError { reasons: errors });
    }

    let layers = lowered_bodies
        .into_iter()
        .map(|body| FdmLayerPlanIR {
            magnet_name: body.magnet_name,
            native_grid: body.native_grid,
            native_cell_size: body.native_cell_size,
            native_origin: body.native_origin,
            native_active_mask: body.native_active_mask,
            initial_magnetization: body.initial_magnetization,
            material: body.material,
            convolution_grid: common_cells,
            convolution_cell_size,
            convolution_origin: body.native_origin,
            transfer_kind: if body.native_grid == common_cells
                && body.native_cell_size == convolution_cell_size
            {
                "identity".to_string()
            } else {
                "push_pull".to_string()
            },
        })
        .collect::<Vec<_>>();

    let plan = FdmMultilayerPlanIR {
        mode: selected_mode.clone(),
        common_cells,
        layers,
        enable_exchange,
        enable_demag,
        external_field,
        gyromagnetic_ratio,
        precision: problem.backend_policy.execution_precision,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        integrator,
        fixed_timestep,
        relaxation,
        planner_summary: FdmMultilayerSummaryIR {
            requested_strategy: requested_strategy.to_string(),
            selected_strategy: "multilayer_convolution".to_string(),
            eligibility: "eligible".to_string(),
            estimated_pair_kernels,
            estimated_unique_kernels,
            estimated_kernel_bytes,
            warnings: Vec::new(),
        },
    };

    let study_note = if let Some(control) = plan.relaxation.as_ref() {
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
        backend_plan: BackendPlanIR::FdmMultilayer(plan),
        output_plan: OutputPlanIR {
            outputs: problem.study.sampling().outputs.clone(),
        },
        provenance: ProvenancePlanIR {
            notes: vec![
                "Phase 2 public multilayer FDM planner".to_string(),
                format!(
                    "multibody demag strategy: requested={}, selected=multilayer_convolution",
                    requested_strategy
                ),
                format!(
                    "multilayer common grid: {}x{}x{}",
                    common_cells[0], common_cells[1], common_cells[2]
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

    let geometry_by_name: BTreeMap<&str, &GeometryEntryIR> = problem
        .geometry
        .entries
        .iter()
        .map(|entry| (entry.name(), entry))
        .collect();
    let region_to_geometry: BTreeMap<&str, &str> = problem
        .regions
        .iter()
        .map(|region| (region.name.as_str(), region.geometry.as_str()))
        .collect();

    let mut merged_initial_magnetization = Vec::new();
    let mut mesh_parts = Vec::with_capacity(problem.magnets.len());
    let mut mesh_sources = Vec::with_capacity(problem.magnets.len());
    let mut selected_material: Option<fullmag_ir::MaterialIR> = None;

    for magnet in &problem.magnets {
        let Some(geometry_name) = region_to_geometry.get(magnet.region.as_str()).copied() else {
            errors.push(format!(
                "magnet '{}' references region '{}' with no geometry binding",
                magnet.name, magnet.region
            ));
            continue;
        };
        let Some(_geometry_entry) = geometry_by_name.get(geometry_name).copied() else {
            errors.push(format!(
                "magnet '{}' references geometry '{}' which is missing from geometry.entries",
                magnet.name, geometry_name
            ));
            continue;
        };
        let Some(material) = problem
            .materials
            .iter()
            .find(|candidate| candidate.name == magnet.material)
            .cloned()
        else {
            errors.push(format!(
                "magnet '{}' references missing material '{}'",
                magnet.name, magnet.material
            ));
            continue;
        };
        if let Some(reference_material) = selected_material.as_ref() {
            if !compatible_fem_material(reference_material, &material) {
                errors.push(format!(
                    "current multi-body FEM baseline requires identical material law across magnets; '{}' is incompatible with '{}'",
                    magnet.name,
                    problem.magnets[0].name
                ));
            }
        } else {
            selected_material = Some(material.clone());
        }

        let mesh_asset = problem
            .geometry_assets
            .as_ref()
            .and_then(|assets| {
                assets
                    .fem_mesh_assets
                    .iter()
                    .find(|asset| asset.geometry_name == geometry_name)
            })
            .cloned();

        let mesh_asset = match mesh_asset {
            Some(asset) => asset,
            None => {
                errors.push(format!(
                    "geometry '{}' requires a precomputed FEM mesh asset; no MeshIR was provided",
                    geometry_name
                ));
                continue;
            }
        };

        let mesh = match (&mesh_asset.mesh, &mesh_asset.mesh_source) {
            (Some(mesh), _) => mesh.clone(),
            (None, Some(source)) => match load_mesh_from_source(source) {
                Ok(mesh) => mesh,
                Err(message) => {
                    errors.push(message);
                    continue;
                }
            },
            (None, None) => {
                errors.push(format!(
                    "geometry '{}' requires a FEM mesh asset with inline mesh or mesh_source",
                    geometry_name
                ));
                continue;
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
                        "magnet '{}' sampled_field has {} vectors, but FEM mesh '{}' has {} nodes",
                        magnet.name,
                        values.len(),
                        mesh.mesh_name,
                        n_nodes
                    ));
                }
                values.clone()
            }
            None => vec![[1.0, 0.0, 0.0]; n_nodes],
        };

        merged_initial_magnetization.extend(initial_magnetization);
        mesh_parts.push((magnet.name.clone(), mesh));
        mesh_sources.push(mesh_asset.mesh_source);
    }

    let mut enable_exchange = false;
    let mut enable_demag = false;
    let mut external_field = None;
    let mut demag_realization: Option<String> = None;
    for term in &problem.energy_terms {
        match term {
            fullmag_ir::EnergyTermIR::Exchange => {
                if enable_exchange {
                    errors.push("Exchange is declared more than once".to_string());
                }
                enable_exchange = true;
            }
            fullmag_ir::EnergyTermIR::Demag { realization } => {
                if enable_demag {
                    errors.push("Demag is declared more than once".to_string());
                }
                enable_demag = true;
                demag_realization = realization.clone();
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

    let (integrator, fixed_timestep, gyromagnetic_ratio, relaxation, adaptive_timestep) =
        planned_study_controls(problem, &mut errors);

    if !errors.is_empty() {
        return Err(PlanError { reasons: errors });
    }

    let material = selected_material.expect("validation should have caught missing FEM material");
    let mesh = merge_fem_meshes(&mesh_parts).map_err(|message| PlanError {
        reasons: vec![message],
    })?;
    let initial_magnetization = merged_initial_magnetization;
    let n_nodes = mesh.nodes.len();
    let n_elements = mesh.elements.len();
    let mesh_name = mesh.mesh_name.clone();

    // S07: Auto-resolve demag realization.
    // "auto" or None → "poisson_airbox" when the mesh contains air elements (marker 0),
    // otherwise "transfer_grid" (traditional FFT-on-Cartesian-grid approach).
    let resolved_demag_realization = if enable_demag {
        match demag_realization.as_deref() {
            Some("transfer_grid") => Some("transfer_grid".to_string()),
            Some("poisson_airbox") => Some("poisson_airbox".to_string()),
            // auto or unset: detect air-box elements
            _ => {
                let has_air_elements = mesh.element_markers.iter().any(|&m| m == 0);
                if has_air_elements {
                    Some("poisson_airbox".to_string())
                } else {
                    Some("transfer_grid".to_string())
                }
            }
        }
    } else {
        None
    };

    let fem_plan = FemPlanIR {
        mesh_name: mesh_name.clone(),
        mesh_source: if mesh_parts.len() == 1 {
            mesh_sources.first().cloned().flatten()
        } else {
            None
        },
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
        adaptive_timestep,
        relaxation,
        demag_realization: resolved_demag_realization,
        air_box_config: None,
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
                if mesh_parts.len() == 1 {
                    "Bootstrap FEM planner with precomputed MeshIR asset".to_string()
                } else {
                    format!(
                        "Bootstrap multi-body FEM planner merged {} disjoint mesh assets into one FEM plan",
                        mesh_parts.len()
                    )
                },
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
        "mx",
        "my",
        "mz",
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
                        "scalar output '{}' is not executable in the current FDM path; allowed scalars are E_ex, E_demag, E_ext, E_total, time, step, solver_dt, mx, my, mz, max_dm_dt, and max_h_eff",
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

fn compatible_fem_material(a: &fullmag_ir::MaterialIR, b: &fullmag_ir::MaterialIR) -> bool {
    a.saturation_magnetisation == b.saturation_magnetisation
        && a.exchange_stiffness == b.exchange_stiffness
        && a.damping == b.damping
        && a.uniaxial_anisotropy == b.uniaxial_anisotropy
        && a.anisotropy_axis == b.anisotropy_axis
}

fn merged_fem_element_markers(mesh: &MeshIR) -> Result<Vec<u32>, String> {
    let has_marker_one = mesh.element_markers.iter().any(|&marker| marker == 1);
    if has_marker_one {
        return Ok(mesh.element_markers.clone());
    }

    let distinct = mesh
        .element_markers
        .iter()
        .copied()
        .collect::<BTreeSet<_>>();
    if distinct.len() <= 1 {
        return Ok(vec![1; mesh.element_markers.len()]);
    }

    Err(format!(
        "mesh '{}' does not mark magnetic elements with marker=1 and uses multiple element markers {:?}; current multi-body FEM merge baseline cannot infer magnetic ownership safely",
        mesh.mesh_name,
        distinct
    ))
}

fn merge_fem_meshes(meshes: &[(String, MeshIR)]) -> Result<MeshIR, String> {
    if meshes.is_empty() {
        return Err("cannot merge zero FEM meshes".to_string());
    }
    if meshes.len() == 1 {
        return Ok(meshes[0].1.clone());
    }

    let merged_name = meshes
        .iter()
        .map(|(magnet_name, _)| magnet_name.as_str())
        .collect::<Vec<_>>()
        .join("__");

    let mut nodes = Vec::new();
    let mut elements = Vec::new();
    let mut element_markers = Vec::new();
    let mut boundary_faces = Vec::new();
    let mut boundary_markers = Vec::new();

    let mut node_offset = 0u32;
    for (_, mesh) in meshes {
        let remapped_markers = merged_fem_element_markers(mesh)?;
        nodes.extend(mesh.nodes.iter().copied());
        elements.extend(mesh.elements.iter().map(|element| {
            [
                element[0] + node_offset,
                element[1] + node_offset,
                element[2] + node_offset,
                element[3] + node_offset,
            ]
        }));
        element_markers.extend(remapped_markers);
        boundary_faces.extend(mesh.boundary_faces.iter().map(|face| {
            [
                face[0] + node_offset,
                face[1] + node_offset,
                face[2] + node_offset,
            ]
        }));
        boundary_markers.extend(mesh.boundary_markers.iter().copied());
        node_offset += mesh.nodes.len() as u32;
    }

    let merged = MeshIR {
        mesh_name: format!("multibody_{merged_name}"),
        nodes,
        elements,
        element_markers,
        boundary_faces,
        boundary_markers,
    };
    merged.validate().map_err(|errors| {
        format!(
            "merged multi-body FEM mesh is invalid: {}",
            errors.join("; ")
        )
    })?;
    Ok(merged)
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
            scale: fullmag_ir::ImportedGeometryScaleIR::Uniform(1.0),
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
            scale: fullmag_ir::ImportedGeometryScaleIR::Uniform(1.0),
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
    fn fem_backend_multibody_merges_disjoint_mesh_assets() {
        let mut ir = ProblemIR::bootstrap_example();
        ir.backend_policy.requested_backend = BackendTarget::Fem;
        ir.backend_policy.discretization_hints = Some(fullmag_ir::DiscretizationHintsIR {
            fdm: Some(fullmag_ir::FdmHintsIR {
                cell: [2e-9, 2e-9, 2e-9],
                default_cell: None,
                per_magnet: None,
                demag: None,
            }),
            fem: Some(fullmag_ir::FemHintsIR {
                order: 1,
                hmax: 2e-9,
                mesh: None,
            }),
            hybrid: None,
        });
        ir.geometry.entries = vec![
            GeometryEntryIR::Box {
                name: "free_geom".to_string(),
                size: [2.0, 1.0, 1.0],
            },
            GeometryEntryIR::Box {
                name: "ref_geom".to_string(),
                size: [2.0, 1.0, 1.0],
            },
        ];
        ir.regions = vec![
            fullmag_ir::RegionIR {
                name: "free".to_string(),
                geometry: "free_geom".to_string(),
            },
            fullmag_ir::RegionIR {
                name: "ref".to_string(),
                geometry: "ref_geom".to_string(),
            },
        ];
        ir.magnets = vec![
            fullmag_ir::MagnetIR {
                name: "free".to_string(),
                region: "free".to_string(),
                material: "Py".to_string(),
                initial_magnetization: Some(InitialMagnetizationIR::Uniform {
                    value: [1.0, 0.0, 0.0],
                }),
            },
            fullmag_ir::MagnetIR {
                name: "ref".to_string(),
                region: "ref".to_string(),
                material: "Py".to_string(),
                initial_magnetization: Some(InitialMagnetizationIR::Uniform {
                    value: [0.0, 1.0, 0.0],
                }),
            },
        ];
        ir.energy_terms = vec![
            fullmag_ir::EnergyTermIR::Exchange,
            fullmag_ir::EnergyTermIR::Demag { realization: None },
        ];
        ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
            fdm_grid_assets: vec![],
            fem_mesh_assets: vec![
                fullmag_ir::FemMeshAssetIR {
                    geometry_name: "free_geom".to_string(),
                    mesh_source: None,
                    mesh: Some(fullmag_ir::MeshIR {
                        mesh_name: "free".to_string(),
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
                },
                fullmag_ir::FemMeshAssetIR {
                    geometry_name: "ref_geom".to_string(),
                    mesh_source: None,
                    mesh: Some(fullmag_ir::MeshIR {
                        mesh_name: "ref".to_string(),
                        nodes: vec![
                            [0.0, 0.0, 2.0],
                            [1.0, 0.0, 2.0],
                            [0.0, 1.0, 2.0],
                            [0.0, 0.0, 3.0],
                        ],
                        elements: vec![[0, 1, 2, 3]],
                        element_markers: vec![1],
                        boundary_faces: vec![[0, 1, 2]],
                        boundary_markers: vec![1],
                    }),
                },
            ],
        });

        let plan = plan(&ir).expect("multi-body FEM should plan successfully");
        match plan.backend_plan {
            BackendPlanIR::Fem(fem) => {
                assert_eq!(fem.mesh.nodes.len(), 8);
                assert_eq!(fem.mesh.elements.len(), 2);
                assert_eq!(fem.initial_magnetization.len(), 8);
                assert!(fem.enable_exchange);
                assert!(fem.enable_demag);
            }
            _ => panic!("expected FEM plan"),
        }
    }

    #[test]
    fn fem_backend_multibody_rejects_incompatible_material_law() {
        let mut ir = ProblemIR::bootstrap_example();
        ir.backend_policy.requested_backend = BackendTarget::Fem;
        ir.materials.push(fullmag_ir::MaterialIR {
            name: "Co".to_string(),
            saturation_magnetisation: 1.1e6,
            exchange_stiffness: 20e-12,
            damping: 0.02,
            uniaxial_anisotropy: None,
            anisotropy_axis: None,
        });
        ir.geometry.entries.push(GeometryEntryIR::Box {
            name: "second".to_string(),
            size: [1.0, 1.0, 1.0],
        });
        ir.regions.push(fullmag_ir::RegionIR {
            name: "second".to_string(),
            geometry: "second".to_string(),
        });
        ir.magnets.push(fullmag_ir::MagnetIR {
            name: "second".to_string(),
            region: "second".to_string(),
            material: "Co".to_string(),
            initial_magnetization: Some(InitialMagnetizationIR::Uniform {
                value: [0.0, 1.0, 0.0],
            }),
        });
        ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
            fdm_grid_assets: vec![],
            fem_mesh_assets: vec![
                fullmag_ir::FemMeshAssetIR {
                    geometry_name: "strip".to_string(),
                    mesh_source: None,
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
                },
                fullmag_ir::FemMeshAssetIR {
                    geometry_name: "second".to_string(),
                    mesh_source: None,
                    mesh: Some(fullmag_ir::MeshIR {
                        mesh_name: "second".to_string(),
                        nodes: vec![
                            [0.0, 0.0, 2.0],
                            [1.0, 0.0, 2.0],
                            [0.0, 1.0, 2.0],
                            [0.0, 0.0, 3.0],
                        ],
                        elements: vec![[0, 1, 2, 3]],
                        element_markers: vec![1],
                        boundary_faces: vec![[0, 1, 2]],
                        boundary_markers: vec![1],
                    }),
                },
            ],
        });

        let error = plan(&ir).expect_err("incompatible multi-body FEM materials should fail");
        assert!(error
            .reasons
            .iter()
            .any(|reason| reason.contains("requires identical material law")));
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
    fn projected_gradient_bb_is_now_plannable() {
        let mut ir = ProblemIR::bootstrap_example();
        ir.study = fullmag_ir::StudyIR::Relaxation {
            algorithm: fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb,
            dynamics: ir.study.dynamics().clone(),
            torque_tolerance: 1e-3,
            energy_tolerance: None,
            max_steps: 250,
            sampling: ir.study.sampling().clone(),
        };

        let plan = plan(&ir).expect("projected_gradient_bb should now plan successfully");
        match plan.backend_plan {
            BackendPlanIR::Fdm(fdm) => {
                let control = fdm.relaxation.expect("relaxation control");
                assert_eq!(
                    control.algorithm,
                    fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb
                );
            }
            _ => panic!("expected FDM plan"),
        }
    }

    #[test]
    fn nonlinear_cg_is_now_plannable() {
        let mut ir = ProblemIR::bootstrap_example();
        ir.study = fullmag_ir::StudyIR::Relaxation {
            algorithm: fullmag_ir::RelaxationAlgorithmIR::NonlinearCg,
            dynamics: ir.study.dynamics().clone(),
            torque_tolerance: 1e-3,
            energy_tolerance: None,
            max_steps: 250,
            sampling: ir.study.sampling().clone(),
        };

        let plan = plan(&ir).expect("nonlinear_cg should now plan successfully");
        match plan.backend_plan {
            BackendPlanIR::Fdm(fdm) => {
                let control = fdm.relaxation.expect("relaxation control");
                assert_eq!(
                    control.algorithm,
                    fullmag_ir::RelaxationAlgorithmIR::NonlinearCg
                );
            }
            _ => panic!("expected FDM plan"),
        }
    }

    #[test]
    fn tangent_plane_implicit_is_still_gated() {
        let mut ir = ProblemIR::bootstrap_example();
        ir.study = fullmag_ir::StudyIR::Relaxation {
            algorithm: fullmag_ir::RelaxationAlgorithmIR::TangentPlaneImplicit,
            dynamics: ir.study.dynamics().clone(),
            torque_tolerance: 1e-3,
            energy_tolerance: None,
            max_steps: 250,
            sampling: ir.study.sampling().clone(),
        };

        let err = plan(&ir).expect_err("tangent_plane_implicit should not be executable yet");
        assert!(err.reasons.iter().any(|reason| {
            reason.contains("tangent_plane_implicit") && reason.contains("not yet executable")
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

    #[test]
    fn stacked_two_body_problem_lowers_to_multilayer_plan() {
        let mut ir = ProblemIR::bootstrap_example();
        ir.geometry.entries = vec![
            GeometryEntryIR::Translate {
                name: "free_geom".to_string(),
                base: std::boxed::Box::new(GeometryEntryIR::Box {
                    name: "free_base".to_string(),
                    size: [40e-9, 20e-9, 2e-9],
                }),
                by: [0.0, 0.0, 0.0],
            },
            GeometryEntryIR::Translate {
                name: "ref_geom".to_string(),
                base: std::boxed::Box::new(GeometryEntryIR::Box {
                    name: "ref_base".to_string(),
                    size: [40e-9, 20e-9, 2e-9],
                }),
                by: [0.0, 0.0, 4e-9],
            },
        ];
        ir.regions = vec![
            fullmag_ir::RegionIR {
                name: "free_region".to_string(),
                geometry: "free_geom".to_string(),
            },
            fullmag_ir::RegionIR {
                name: "ref_region".to_string(),
                geometry: "ref_geom".to_string(),
            },
        ];
        ir.magnets = vec![
            fullmag_ir::MagnetIR {
                name: "free".to_string(),
                region: "free_region".to_string(),
                material: "Py".to_string(),
                initial_magnetization: Some(InitialMagnetizationIR::Uniform {
                    value: [1.0, 0.0, 0.0],
                }),
            },
            fullmag_ir::MagnetIR {
                name: "ref".to_string(),
                region: "ref_region".to_string(),
                material: "Py".to_string(),
                initial_magnetization: Some(InitialMagnetizationIR::Uniform {
                    value: [0.0, 1.0, 0.0],
                }),
            },
        ];
        ir.energy_terms = vec![
            fullmag_ir::EnergyTermIR::Exchange,
            fullmag_ir::EnergyTermIR::Demag { realization: None },
        ];
        ir.backend_policy.discretization_hints = Some(fullmag_ir::DiscretizationHintsIR {
            fdm: Some(fullmag_ir::FdmHintsIR {
                cell: [2e-9, 2e-9, 2e-9],
                default_cell: Some([2e-9, 2e-9, 2e-9]),
                per_magnet: None,
                demag: Some(fullmag_ir::FdmDemagHintsIR {
                    strategy: "multilayer_convolution".to_string(),
                    mode: "two_d_stack".to_string(),
                    allow_single_grid_fallback: false,
                    common_cells: None,
                    common_cells_xy: None,
                }),
            }),
            fem: None,
            hybrid: None,
        });

        let plan = plan(&ir).expect("stacked two-body problem should lower");
        match plan.backend_plan {
            BackendPlanIR::FdmMultilayer(multilayer) => {
                assert_eq!(multilayer.layers.len(), 2);
                assert_eq!(multilayer.common_cells, [20, 10, 1]);
                for (actual, expected) in multilayer.layers[0]
                    .native_origin
                    .iter()
                    .zip([-20e-9, -10e-9, -1e-9].iter())
                {
                    assert!((actual - expected).abs() < 1e-18);
                }
                for (actual, expected) in multilayer.layers[1]
                    .native_origin
                    .iter()
                    .zip([-20e-9, -10e-9, 3e-9].iter())
                {
                    assert!((actual - expected).abs() < 1e-18);
                }
                assert_eq!(
                    multilayer.planner_summary.selected_strategy,
                    "multilayer_convolution"
                );
            }
            other => panic!("expected FDM multilayer plan, got {other:?}"),
        }
    }

    #[test]
    fn multilayer_planner_rejects_xy_offset() {
        let mut ir = ProblemIR::bootstrap_example();
        ir.geometry.entries = vec![
            GeometryEntryIR::Translate {
                name: "free_geom".to_string(),
                base: std::boxed::Box::new(GeometryEntryIR::Box {
                    name: "free_base".to_string(),
                    size: [40e-9, 20e-9, 2e-9],
                }),
                by: [0.0, 0.0, 0.0],
            },
            GeometryEntryIR::Translate {
                name: "ref_geom".to_string(),
                base: std::boxed::Box::new(GeometryEntryIR::Box {
                    name: "ref_base".to_string(),
                    size: [40e-9, 20e-9, 2e-9],
                }),
                by: [10e-9, 0.0, 4e-9],
            },
        ];
        ir.regions = vec![
            fullmag_ir::RegionIR {
                name: "free_region".to_string(),
                geometry: "free_geom".to_string(),
            },
            fullmag_ir::RegionIR {
                name: "ref_region".to_string(),
                geometry: "ref_geom".to_string(),
            },
        ];
        ir.magnets = vec![
            fullmag_ir::MagnetIR {
                name: "free".to_string(),
                region: "free_region".to_string(),
                material: "Py".to_string(),
                initial_magnetization: None,
            },
            fullmag_ir::MagnetIR {
                name: "ref".to_string(),
                region: "ref_region".to_string(),
                material: "Py".to_string(),
                initial_magnetization: None,
            },
        ];
        ir.energy_terms = vec![fullmag_ir::EnergyTermIR::Demag { realization: None }];

        let err = plan(&ir).expect_err("XY-offset multilayer problem should be rejected");
        assert!(err
            .reasons
            .iter()
            .any(|reason| reason.contains("share the same XY center")));
    }
}
