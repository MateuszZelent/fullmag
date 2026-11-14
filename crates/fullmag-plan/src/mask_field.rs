//! Hand-written masks on the single FDM grid and on the FEM mesh (physics note
//! 0922, sections 8.1 and 8.3).
//!
//! FDM: a mask field drive acts on the magnetic cells of its target (global, the
//! magnet, or one region of it by the grid's exclusive region marker) whose
//! centres lie inside its support shape. Each function mask is evaluated once at
//! the centre of each supported cell (as mumax3 fills a `VectorMask`).
//!
//! FEM: the drive acts on the nodes of the target's magnetic elements that lie
//! inside the support shape; each mask is evaluated at those nodes and the
//! solver interpolates it with the P1 basis.
//!
//! Each time function is compiled to `fullmag_time_expr.v1` for the solver.

use std::io::Read;

use base64::Engine;
use fullmag_expr::{CompiledFunction, FunctionKind};
use fullmag_ir::{
    FdmRegionLegendEntryIR, FemPlanIR, FieldTargetIR, FieldTimeOriginIR, MaskFieldDriveIR,
    MaskFrameIR, MaskSourceIR, ProblemIR, ResolvedMaskFieldTermBasisIR, SAMPLED_MASK_ENCODING,
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
/// `object_translation_m` is the object frame of the target (translation only);
/// a global target has no object, so its frame is the world frame.
fn frame_origin(drive: &MaskFieldDriveIR, object_translation_m: [f64; 3]) -> [f64; 3] {
    let object = match (drive.frame, &drive.target) {
        (MaskFrameIR::World, _) | (_, FieldTargetIR::Global {}) => [0.0; 3],
        (MaskFrameIR::Local, _) => object_translation_m,
    };
    std::array::from_fn(|axis| object[axis] + drive.position_m[axis])
}

/// The points a drive is resolved on: FDM cell centres or FEM mesh nodes.
struct DriveSamples<'a> {
    points_m: &'a [[f64; 3]],
    /// Points of the target that lie inside the placed shape.
    support: Vec<bool>,
    /// World position of the support's origin.
    origin_m: [f64; 3],
    /// `cell` or `node`, for messages.
    sample: &'static str,
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

/// Support of one drive: the candidate points (magnetic cells or nodes of the
/// target) that lie inside the shape placed at `origin_m`.
fn shape_support(
    drive: &MaskFieldDriveIR,
    points_m: &[[f64; 3]],
    origin_m: [f64; 3],
    candidate: impl Fn(usize) -> bool,
    sample: &str,
) -> Result<Vec<bool>, PlanError> {
    let transform = AffineTransform3 {
        translation_m: origin_m,
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
    let mut support = Vec::with_capacity(points_m.len());
    for (index, point) in points_m.iter().enumerate() {
        let inside = candidate(index)
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
            "mask_support_empty: mask drive '{}' selects no magnetic {sample} of {} inside its shape",
            drive.id,
            target_label(&drive.target)
        )));
    }
    Ok(support)
}

/// FDM support of one drive: active cells of the target inside the placed shape.
fn fdm_samples<'a>(
    drive: &MaskFieldDriveIR,
    domain: &FdmMaskFieldDomain<'a>,
) -> Result<DriveSamples<'a>, PlanError> {
    let region_marker = target_region_marker(drive, domain)?;
    let origin_m = frame_origin(drive, domain.object_translation_m);
    let support = shape_support(
        drive,
        domain.cell_centres_m,
        origin_m,
        |index| {
            domain.active_mask.map_or(true, |mask| mask[index])
                && region_marker.map_or(true, |marker| {
                    domain.region_mask.get(index) == Some(&marker)
                })
        },
        "cell",
    )?;
    Ok(DriveSamples {
        points_m: domain.cell_centres_m,
        support,
        origin_m,
        sample: "cell",
    })
}

/// A decoded sampled mask: values in tesla, (z, y, x, component) order.
struct SampledMask {
    values: Vec<f32>,
    size: [usize; 3],
    cell_m: [f64; 3],
    origin_m: [f64; 3],
}

impl SampledMask {
    /// Value at a world point: the lattice cell that contains it, else zero
    /// (mumax3 also resamples a VectorMask to the cell centres). `closed`
    /// counts points on the lattice's outer faces as inside (FEM nodes lie on
    /// them; FDM cell centres never do).
    fn value_at(&self, point: [f64; 3], closed: bool) -> [f64; 3] {
        const FACE_TOLERANCE_CELLS: f64 = 1.0e-6;
        let mut index = [0usize; 3];
        for axis in 0..3 {
            let cells = self.size[axis] as f64;
            let mut position = (point[axis] - self.origin_m[axis]) / self.cell_m[axis];
            if closed && (-FACE_TOLERANCE_CELLS..=cells + FACE_TOLERANCE_CELLS).contains(&position)
            {
                position = position.clamp(0.0, cells - 0.5);
            }
            let coordinate = position.floor();
            if !(0.0..cells).contains(&coordinate) {
                return [0.0; 3];
            }
            index[axis] = coordinate as usize;
        }
        let [nx, ny, _] = self.size;
        let offset = 3 * ((index[2] * ny + index[1]) * nx + index[0]);
        [
            f64::from(self.values[offset]),
            f64::from(self.values[offset + 1]),
            f64::from(self.values[offset + 2]),
        ]
    }
}

fn decode_sampled_mask(
    drive: &MaskFieldDriveIR,
    term_index: usize,
    source: &MaskSourceIR,
) -> Result<SampledMask, PlanError> {
    let MaskSourceIR::Sampled {
        encoding,
        data,
        sha256,
        size,
        cell_m,
        origin_m,
    } = source
    else {
        unreachable!("only sampled masks are decoded");
    };
    let invalid = |reason: String| {
        plan_error(format!(
            "mask_array_invalid: mask drive '{}' terms[{term_index}]: {reason}",
            drive.id
        ))
    };
    if encoding != SAMPLED_MASK_ENCODING {
        return Err(invalid(format!("unknown encoding '{encoding}'")));
    }
    let compressed = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|error| invalid(format!("data is not base64: {error}")))?;
    let mut raw = Vec::new();
    flate2::read::ZlibDecoder::new(compressed.as_slice())
        .read_to_end(&mut raw)
        .map_err(|error| invalid(format!("data is not zlib: {error}")))?;
    let size = size.map(|value| value as usize);
    let expected = size[0] * size[1] * size[2] * 3 * 4;
    if raw.len() != expected {
        return Err(invalid(format!(
            "{} bytes for a {}x{}x{} lattice of 3-vectors (expected {expected})",
            raw.len(),
            size[0],
            size[1],
            size[2]
        )));
    }
    let digest = format!("{:x}", Sha256::digest(&raw));
    if !digest.eq_ignore_ascii_case(sha256) {
        return Err(invalid(format!("sha256 {digest} differs from {sha256}")));
    }
    let values: Vec<f32> = raw
        .chunks_exact(4)
        .map(|bytes| f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
        .collect();
    if let Some(position) = values.iter().position(|value| !value.is_finite()) {
        return Err(plan_error(format!(
            "mask_expression_non_finite: mask drive '{}' terms[{term_index}] array value {position} is not finite",
            drive.id
        )));
    }
    Ok(SampledMask {
        values,
        size,
        cell_m: *cell_m,
        origin_m: *origin_m,
    })
}

/// Resolve every term of every active mask drive on the single FDM grid.
pub(crate) fn resolve_fdm_mask_field_terms(
    problem: &ProblemIR,
    domain: &FdmMaskFieldDomain<'_>,
) -> Result<Vec<ResolvedMaskFieldTermBasisIR>, PlanError> {
    let mut resolved = Vec::new();
    for drive in active_mask_field_drives(problem) {
        let samples = fdm_samples(drive, domain)?;
        resolve_drive_terms(drive, &samples, domain.stage_start_time_s, &mut resolved)?;
    }
    Ok(resolved)
}

/// Resolve the terms of one drive at its sample points: the mask in A/m at
/// each supported point (zero elsewhere) and the compiled time program.
fn resolve_drive_terms(
    drive: &MaskFieldDriveIR,
    samples: &DriveSamples<'_>,
    stage_start_time_s: f64,
    resolved: &mut Vec<ResolvedMaskFieldTermBasisIR>,
) -> Result<(), PlanError> {
    let points = samples.points_m;
    let support = &samples.support;
    let origin = samples.origin_m;
    let sample = samples.sample;
    for (term_index, term) in drive.terms.iter().enumerate() {
        let field_xyz = match &term.mask {
            MaskSourceIR::Function { function } => {
                let mask = compile(drive, term_index, "mask", function, FunctionKind::Mask)?;
                let mut field_xyz = vec![[0.0; 3]; points.len()];
                for (index, point) in points.iter().enumerate() {
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
                                "mask_expression_non_finite: mask drive '{}' terms[{term_index}].mask at {sample} {index} ({:.6e}, {:.6e}, {:.6e}) m gives {:?}",
                                drive.id, point[0], point[1], point[2], value
                            )));
                    }
                    field_xyz[index] = [value[0] / MU0, value[1] / MU0, value[2] / MU0];
                }
                field_xyz
            }
            sampled @ MaskSourceIR::Sampled { .. } => {
                let mask = decode_sampled_mask(drive, term_index, sampled)?;
                let mut field_xyz = vec![[0.0; 3]; points.len()];
                for (index, point) in points.iter().enumerate() {
                    if support[index] {
                        let value = mask.value_at(*point, sample == "node");
                        field_xyz[index] = [value[0] / MU0, value[1] / MU0, value[2] / MU0];
                    }
                }
                field_xyz
            }
        };
        let (time_expression, time_program, time_dependent) = match &term.time {
            Some(function) => {
                let time = compile(drive, term_index, "time", function, FunctionKind::Time)?;
                let start = match drive.time_origin {
                    FieldTimeOriginIR::StageLocal => 0.0,
                    FieldTimeOriginIR::Absolute => stage_start_time_s,
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
    Ok(())
}

/// World translation of a FEM target's object frame (zero for a global target).
fn fem_object_translation(problem: &ProblemIR, target: &FieldTargetIR) -> [f64; 3] {
    let object_id = match target {
        FieldTargetIR::Global {} => return [0.0; 3],
        FieldTargetIR::Object { object_id } | FieldTargetIR::Region { object_id, .. } => object_id,
    };
    let geometry_name = problem
        .magnets
        .iter()
        .find(|magnet| {
            magnet.name == *object_id || magnet.object_id.as_deref() == Some(object_id.as_str())
        })
        .map_or(object_id.as_str(), |magnet| magnet.region.as_str());
    problem
        .geometry
        .entries
        .iter()
        .find(|entry| entry.name() == geometry_name)
        .map_or([0.0; 3], crate::fdm::top_level_geometry_translation)
}

/// Resolve every term of every active mask drive at the nodes of the FEM mesh
/// of `plan` (its mesh, object segments, mesh parts and materials are final).
pub(crate) fn resolve_fem_mask_field_terms(
    problem: &ProblemIR,
    plan: &FemPlanIR,
) -> Result<Vec<ResolvedMaskFieldTermBasisIR>, PlanError> {
    let nodes = &plan.mesh.nodes;
    let mut resolved = Vec::new();
    for drive in active_mask_field_drives(problem) {
        // Magnetic elements of the target, then every node of those elements.
        let elements =
            crate::antenna_projection::resolve_fem_antenna_transverse_cell_mask(plan, &drive.target)
                .map_err(|error| {
                    plan_error(format!(
                        "mask_target_unknown: mask drive '{}' targets {}, which has no magnetic elements on this FEM mesh ({})",
                        drive.id,
                        target_label(&drive.target),
                        error.reasons.join("; ")
                    ))
                })?;
        let mut target_nodes = vec![false; nodes.len()];
        for (element, _) in elements
            .iter()
            .enumerate()
            .filter(|(_, selected)| **selected)
        {
            for &node in plan.mesh.cells.item_nodes(element).unwrap_or_default() {
                if let Some(selected) = target_nodes.get_mut(node as usize) {
                    *selected = true;
                }
            }
        }
        let origin_m = frame_origin(drive, fem_object_translation(problem, &drive.target));
        let support = shape_support(drive, nodes, origin_m, |index| target_nodes[index], "node")?;
        let first = resolved.len();
        resolve_drive_terms(
            drive,
            &DriveSamples {
                points_m: nodes,
                support,
                origin_m,
                sample: "node",
            },
            plan.time_stage.start_time_s,
            &mut resolved,
        )?;
        // Periodic images are one degree of freedom: the mask must agree on them.
        for basis in &resolved[first..] {
            for pair in &plan.mesh.periodic_node_pairs {
                let (a, b) = (pair.node_a as usize, pair.node_b as usize);
                let (Some(left), Some(right)) = (basis.field_xyz.get(a), basis.field_xyz.get(b))
                else {
                    continue;
                };
                let differs = left.iter().zip(right).any(|(lhs, rhs)| {
                    (lhs - rhs).abs() > 1.0e-12 * lhs.abs().max(rhs.abs()).max(1.0)
                });
                if differs {
                    return Err(plan_error(format!(
                        "mask_not_periodic: mask drive '{}' terms[{}] differs on the periodic node pair '{}' (nodes {a} and {b}: {:?} and {:?} A/m); a mask on a periodic FEM mesh must be periodic",
                        drive.id, basis.term_index, pair.pair_id, left, right
                    )));
                }
            }
        }
    }
    Ok(resolved)
}
