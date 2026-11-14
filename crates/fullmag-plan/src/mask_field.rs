//! Hand-written masks on the single FDM grid (physics note 0922, section 8.1).
//!
//! A mask field drive acts on the magnetic cells of its target (global, the
//! magnet, or one region of it by the grid's exclusive region marker) whose
//! centres lie inside its support shape. Each function mask is evaluated once at
//! the centre of each supported cell (as mumax3 fills a `VectorMask`); each time
//! function is compiled to `fullmag_time_expr.v1` for the solver.

use fullmag_expr::{CompiledFunction, FunctionKind};
use fullmag_ir::{
    FdmRegionLegendEntryIR, FieldTargetIR, FieldTimeOriginIR, MaskFieldDriveIR, MaskFrameIR,
    MaskSourceIR, ProblemIR, ResolvedMaskFieldTermBasisIR,
};
use sha2::{Digest, Sha256};

use crate::selection::geometry::{AffineTransform3, BoundaryMembership, GeometryPredicate};
use crate::util::MU0;
use crate::PlanError;

/// Program of the constant time function `1`.
const STATIC_TIME_PROGRAM: [f64; 3] = [1.0, 1.0, 0.0];

/// The single-grid FDM domain a mask drive is resolved on.
pub(crate) struct FdmMaskFieldDomain<'a> {
    /// World-space cell centres, x fastest.
    pub cell_centres_m: &'a [[f64; 3]],
    /// Magnetic cells; `None` means every cell.
    pub active_mask: Option<&'a [bool]>,
    /// Exclusive region marker per cell (0: no region).
    pub region_mask: &'a [u32],
    /// Markers of the grid's regions.
    pub region_legend: &'a [FdmRegionLegendEntryIR],
    /// Names under which the grid's magnet can be targeted.
    pub target_aliases: &'a [&'a str],
    /// Object frame of the magnet (translation only). A global target has no
    /// object; its frame is the world frame.
    pub object_translation_m: [f64; 3],
    /// Absolute time at the start of the stage being planned.
    pub stage_start_time_s: f64,
}

fn plan_error(message: String) -> PlanError {
    PlanError {
        reasons: vec![message],
    }
}

/// Mask drives that are enabled and active in the stage being planned.
pub(crate) fn active_mask_field_drives(problem: &ProblemIR) -> Vec<&MaskFieldDriveIR> {
    problem
        .mask_field_drives
        .iter()
        .filter(|drive| {
            drive.enabled && crate::util::drive_activation_is_active(&drive.activation, problem)
        })
        .collect()
}

/// World position of the support's origin: `position_m` in the drive's frame.
fn frame_origin(drive: &MaskFieldDriveIR, domain: &FdmMaskFieldDomain<'_>) -> [f64; 3] {
    let object = match (drive.frame, &drive.target) {
        (MaskFrameIR::World, _) | (_, FieldTargetIR::Global {}) => [0.0; 3],
        (MaskFrameIR::Local, _) => domain.object_translation_m,
    };
    std::array::from_fn(|axis| object[axis] + drive.position_m[axis])
}

fn compile(
    drive: &MaskFieldDriveIR,
    term_index: usize,
    part: &str,
    function: &fullmag_ir::FunctionIR,
    kind: FunctionKind,
) -> Result<CompiledFunction, PlanError> {
    function.compile(kind).map_err(|error| {
        plan_error(format!(
            "{}: mask drive '{}' terms[{term_index}].{part}.{} @{}: {}",
            error.code, drive.id, error.path, error.position, error.message
        ))
    })
}

fn signature(
    drive: &MaskFieldDriveIR,
    term_index: usize,
    time_program: &[f64],
    field_xyz: &[[f64; 3]],
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"mask_field_term.v1\0");
    hasher.update(drive.id.as_bytes());
    hasher.update([0]);
    hasher.update((term_index as u64).to_le_bytes());
    hasher.update((time_program.len() as u64).to_le_bytes());
    for word in time_program {
        hasher.update(word.to_le_bytes());
    }
    hasher.update((field_xyz.len() as u64).to_le_bytes());
    for value in field_xyz {
        for component in value {
            hasher.update(component.to_le_bytes());
        }
    }
    format!("sha256:{:x}", hasher.finalize())
}

fn target_label(target: &FieldTargetIR) -> String {
    match target {
        FieldTargetIR::Global {} => "global".to_string(),
        FieldTargetIR::Object { object_id } => format!("'{object_id}'"),
        FieldTargetIR::Region {
            object_id,
            region_id,
        } => format!("region '{object_id}/{region_id}'"),
    }
}

/// Region marker a drive is restricted to; `None` for the whole magnet.
fn target_region_marker(
    drive: &MaskFieldDriveIR,
    domain: &FdmMaskFieldDomain<'_>,
) -> Result<Option<u32>, PlanError> {
    let not_on_grid = |object_id: &str| {
        plan_error(format!(
            "mask_target_unknown: mask drive '{}' targets {}, but '{object_id}' is not the magnet of this FDM grid",
            drive.id,
            target_label(&drive.target)
        ))
    };
    match &drive.target {
        FieldTargetIR::Global {} => Ok(None),
        FieldTargetIR::Object { object_id } => {
            if domain.target_aliases.contains(&object_id.as_str()) {
                Ok(None)
            } else {
                Err(not_on_grid(object_id))
            }
        }
        FieldTargetIR::Region {
            object_id,
            region_id,
        } => {
            if !domain.target_aliases.contains(&object_id.as_str()) {
                return Err(not_on_grid(object_id));
            }
            domain
                .region_legend
                .iter()
                .find(|entry| entry.object_id == *object_id && entry.region_id == *region_id)
                .map(|entry| Some(entry.numeric_id))
                .ok_or_else(|| {
                    plan_error(format!(
                        "mask_target_unknown: mask drive '{}' targets region '{object_id}/{region_id}', which has no marker on this FDM grid (disabled or not materialized)",
                        drive.id
                    ))
                })
        }
    }
}

/// Support of one drive: active cells of the target inside the placed shape.
fn support_mask(
    drive: &MaskFieldDriveIR,
    domain: &FdmMaskFieldDomain<'_>,
) -> Result<Vec<bool>, PlanError> {
    let region_marker = target_region_marker(drive, domain)?;
    let transform = AffineTransform3 {
        translation_m: frame_origin(drive, domain),
        ..AffineTransform3::identity()
    };
    let predicate = GeometryPredicate::from_region_shape(
        &drive.shape,
        transform,
        BoundaryMembership::inclusive(),
    )
    .map_err(|error| {
        plan_error(format!(
            "mask_shape_invalid: mask drive '{}' shape: {error}",
            drive.id
        ))
    })?;
    let mut support = Vec::with_capacity(domain.cell_centres_m.len());
    for (index, point) in domain.cell_centres_m.iter().enumerate() {
        let active = domain.active_mask.map_or(true, |mask| mask[index])
            && region_marker.map_or(true, |marker| {
                domain.region_mask.get(index) == Some(&marker)
            });
        let inside = active
            && predicate.contains(*point).map_err(|error| {
                plan_error(format!(
                    "mask_shape_invalid: mask drive '{}' shape: {error}",
                    drive.id
                ))
            })?;
        support.push(inside);
    }
    if !support.iter().any(|inside| *inside) {
        return Err(plan_error(format!(
            "mask_support_empty: mask drive '{}' selects no magnetic cell of {} inside its shape",
            drive.id,
            target_label(&drive.target)
        )));
    }
    Ok(support)
}

/// Resolve every term of every active mask drive on the single FDM grid.
pub(crate) fn resolve_fdm_mask_field_terms(
    problem: &ProblemIR,
    domain: &FdmMaskFieldDomain<'_>,
) -> Result<Vec<ResolvedMaskFieldTermBasisIR>, PlanError> {
    let mut resolved = Vec::new();
    for drive in active_mask_field_drives(problem) {
        let support = support_mask(drive, domain)?;
        let origin = frame_origin(drive, domain);
        for (term_index, term) in drive.terms.iter().enumerate() {
            let field_xyz = match &term.mask {
                MaskSourceIR::Function { function } => {
                    let mask = compile(drive, term_index, "mask", function, FunctionKind::Mask)?;
                    let mut field_xyz = vec![[0.0; 3]; domain.cell_centres_m.len()];
                    for (index, point) in domain.cell_centres_m.iter().enumerate() {
                        if !support[index] {
                            continue;
                        }
                        let local = match drive.frame {
                            MaskFrameIR::World => *point,
                            MaskFrameIR::Local => [
                                point[0] - origin[0],
                                point[1] - origin[1],
                                point[2] - origin[2],
                            ],
                        };
                        let value = mask.eval_mask(local);
                        if !value.iter().all(|component| component.is_finite()) {
                            return Err(plan_error(format!(
                                "mask_expression_non_finite: mask drive '{}' terms[{term_index}].mask at cell {index} ({:.6e}, {:.6e}, {:.6e}) m gives {:?}",
                                drive.id, point[0], point[1], point[2], value
                            )));
                        }
                        field_xyz[index] = [value[0] / MU0, value[1] / MU0, value[2] / MU0];
                    }
                    field_xyz
                }
                MaskSourceIR::Sampled { .. } => {
                    return Err(plan_error(format!(
                        "mask_array_invalid: mask drive '{}' terms[{term_index}]: array masks are not realized by the FDM planner yet",
                        drive.id
                    )));
                }
            };
            let (time_expression, time_program, time_dependent) = match &term.time {
                Some(function) => {
                    let time = compile(drive, term_index, "time", function, FunctionKind::Time)?;
                    let start = match drive.time_origin {
                        FieldTimeOriginIR::StageLocal => 0.0,
                        FieldTimeOriginIR::Absolute => domain.stage_start_time_s,
                    };
                    let first = fullmag_expr::eval_time_program(&time.time_program().code, start);
                    if !first.is_finite() {
                        return Err(plan_error(format!(
                            "mask_expression_non_finite: mask drive '{}' terms[{term_index}].time at t = {start:e} s gives {first}",
                            drive.id
                        )));
                    }
                    (
                        time.canonical_outputs()[0].clone(),
                        time.time_program().code.clone(),
                        time.depends_on_variables(),
                    )
                }
                None => ("1.0".to_string(), STATIC_TIME_PROGRAM.to_vec(), false),
            };
            resolved.push(ResolvedMaskFieldTermBasisIR {
                drive_id: drive.id.clone(),
                term_index: term_index as u32,
                time_origin: drive.time_origin,
                projection_signature: signature(drive, term_index, &time_program, &field_xyz),
                time_expression,
                time_program,
                time_dependent,
                field_xyz,
            });
        }
    }
    Ok(resolved)
}
