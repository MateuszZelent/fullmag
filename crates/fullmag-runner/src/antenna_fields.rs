use std::f64::consts::PI;

use fullmag_ir::{
    AntennaFieldSourceModelIR, AntennaIR, CurrentModuleIR, FemPlanIR, FieldTimeOriginIR,
    ResolvedAntennaZeemanMaskIR, TimeDependenceIR,
};

use crate::types::RunError;
use fullmag_engine::RegionalFieldDriveTerm;

const FIELD_EPSILON2: f64 = 1e-30;

/// Returns `true` if any antenna drive uses a time-varying waveform.
#[cfg_attr(not(feature = "fem-gpu"), allow(dead_code))]
pub(crate) fn has_time_varying_antenna(plan: &FemPlanIR) -> bool {
    plan.current_modules.iter().any(|m| {
        matches!(
            m,
            CurrentModuleIR::AntennaFieldSource {
                model: AntennaFieldSourceModelIR::Mqs2p5dAz,
                drive,
                ..
            } if drive.as_ref().is_some_and(|drive| drive.waveform.is_some())
        )
    }) || has_time_varying_antenna_zeeman_masks(&plan.antenna_zeeman_masks)
        || plan.solved_antenna_drive_bases.iter().any(|basis| {
            drive_is_active(&basis.drive.activation, plan)
                && !matches!(basis.drive.waveform, TimeDependenceIR::Constant)
        })
}

fn drive_is_active(activation: &fullmag_ir::DriveActivationIR, plan: &FemPlanIR) -> bool {
    activation.is_active_for(
        plan.time_stage.study_kind,
        plan.time_stage.active_stage_id.as_deref(),
    )
}

pub(crate) fn has_time_varying_antenna_zeeman_masks(masks: &[ResolvedAntennaZeemanMaskIR]) -> bool {
    masks.iter().any(|mask| mask.waveform.is_some())
}

pub(crate) fn combined_antenna_zeeman_mask_field_at_time(
    masks: &[ResolvedAntennaZeemanMaskIR],
    n: usize,
    t: f64,
) -> Vec<[f64; 3]> {
    let mut total = vec![[0.0, 0.0, 0.0]; n];
    for mask in masks {
        let amp = time_dependence_multiplier(mask.waveform.as_ref(), t);
        if amp == 0.0 {
            continue;
        }
        for (index, value) in mask.field_xyz.iter().enumerate().take(n) {
            total[index][0] += value[0] * amp;
            total[index][1] += value[1] * amp;
            total[index][2] += value[2] * amp;
        }
    }
    total
}

fn time_dependence_multiplier(waveform: Option<&TimeDependenceIR>, t: f64) -> f64 {
    crate::time_dependence::evaluate_optional_time_dependence(waveform, t)
}

/// Precompute per-unit-current Biot-Savart fields for each antenna module.
/// Returns one `Vec<[f64;3]>` per module (using `current_a = 1 A`).
pub(crate) fn compute_per_unit_antenna_fields(
    plan: &FemPlanIR,
) -> Result<Vec<Vec<[f64; 3]>>, RunError> {
    if plan.current_modules.is_empty() {
        return Ok(vec![]);
    }
    let Some(bounds) = magnetic_bounds(plan) else {
        return Ok(vec![
            vec![[0.0, 0.0, 0.0]; plan.mesh.nodes.len()];
            plan.current_modules.len()
        ]);
    };
    let mut result = Vec::with_capacity(plan.current_modules.len());
    for module in &plan.current_modules {
        match module {
            CurrentModuleIR::AntennaFieldSource {
                model: AntennaFieldSourceModelIR::Mqs2p5dAz,
                antenna: Some(antenna),
                ..
            } => {
                let mut field = vec![[0.0, 0.0, 0.0]; plan.mesh.nodes.len()];
                add_antenna_field(&mut field, &plan.mesh.nodes, bounds, antenna, 1.0);
                result.push(field);
            }
            CurrentModuleIR::AntennaFieldSource { .. }
            | CurrentModuleIR::CurrentTransport { .. } => {
                result.push(vec![[0.0, 0.0, 0.0]; plan.mesh.nodes.len()]);
            }
        }
    }
    Ok(result)
}

pub(crate) fn static_antenna_field(
    plan: &FemPlanIR,
    per_unit_fields: &[Vec<[f64; 3]>],
) -> Option<Vec<[f64; 3]>> {
    let n = plan.mesh.nodes.len();
    let mut total = vec![[0.0, 0.0, 0.0]; n];
    let mut authored = false;
    for mask in &plan.antenna_zeeman_masks {
        if mask.waveform.is_none() {
            authored = true;
            for (target, basis) in total.iter_mut().zip(&mask.field_xyz) {
                *target = [
                    target[0] + basis[0],
                    target[1] + basis[1],
                    target[2] + basis[2],
                ];
            }
        }
    }
    for basis in &plan.solved_antenna_drive_bases {
        if drive_is_active(&basis.drive.activation, plan)
            && matches!(basis.drive.waveform, TimeDependenceIR::Constant)
        {
            authored = true;
            for (target, value) in total.iter_mut().zip(&basis.field_xyz_apm_per_a) {
                target[0] += value[0] * basis.drive.peak_current_a;
                target[1] += value[1] * basis.drive.peak_current_a;
                target[2] += value[2] * basis.drive.peak_current_a;
            }
        }
    }
    for (module, basis) in plan.current_modules.iter().zip(per_unit_fields) {
        if let CurrentModuleIR::AntennaFieldSource {
            model: AntennaFieldSourceModelIR::Mqs2p5dAz,
            drive: Some(drive),
            ..
        } = module
        {
            if drive.waveform.is_none() {
                authored = true;
                for (target, value) in total.iter_mut().zip(basis) {
                    target[0] += value[0] * drive.current_a;
                    target[1] += value[1] * drive.current_a;
                    target[2] += value[2] * drive.current_a;
                }
            }
        }
    }
    authored.then_some(total)
}

pub(crate) fn dynamic_antenna_drive_terms(
    plan: &FemPlanIR,
    per_unit_fields: &[Vec<[f64; 3]>],
) -> Vec<RegionalFieldDriveTerm> {
    let mut terms = Vec::new();
    for mask in &plan.antenna_zeeman_masks {
        if let Some(waveform) = &mask.waveform {
            terms.push(RegionalFieldDriveTerm {
                basis_field: mask.field_xyz.clone(),
                waveform: waveform.clone(),
                time_offset_s: 0.0,
                enabled: true,
            });
        }
    }
    for basis in &plan.solved_antenna_drive_bases {
        if drive_is_active(&basis.drive.activation, plan)
            && !matches!(basis.drive.waveform, TimeDependenceIR::Constant)
        {
            terms.push(RegionalFieldDriveTerm {
                basis_field: basis
                    .field_xyz_apm_per_a
                    .iter()
                    .map(|value| {
                        [
                            value[0] * basis.drive.peak_current_a,
                            value[1] * basis.drive.peak_current_a,
                            value[2] * basis.drive.peak_current_a,
                        ]
                    })
                    .collect(),
                waveform: basis.drive.waveform.clone(),
                time_offset_s: match basis.drive.time_origin {
                    FieldTimeOriginIR::StageLocal => plan.time_stage.start_time_s,
                    FieldTimeOriginIR::Absolute => 0.0,
                },
                enabled: true,
            });
        }
    }
    for (module, basis) in plan.current_modules.iter().zip(per_unit_fields) {
        if let CurrentModuleIR::AntennaFieldSource {
            model: AntennaFieldSourceModelIR::Mqs2p5dAz,
            drive: Some(drive),
            ..
        } = module
        {
            if let Some(waveform) = &drive.waveform {
                terms.push(RegionalFieldDriveTerm {
                    basis_field: basis
                        .iter()
                        .map(|value| {
                            [
                                value[0] * drive.current_a,
                                value[1] * drive.current_a,
                                value[2] * drive.current_a,
                            ]
                        })
                        .collect(),
                    waveform: waveform.clone(),
                    time_offset_s: 0.0,
                    enabled: true,
                });
            }
        }
    }
    terms
}

#[cfg_attr(not(feature = "fem-gpu"), allow(dead_code))]
pub(crate) fn compute_antenna_field(plan: &FemPlanIR) -> Result<Vec<[f64; 3]>, RunError> {
    compute_antenna_field_at_time(plan, plan.time_stage.start_time_s)
}

pub(crate) fn compute_antenna_field_at_time(
    plan: &FemPlanIR,
    absolute_time_s: f64,
) -> Result<Vec<[f64; 3]>, RunError> {
    if plan.current_modules.is_empty()
        && plan.antenna_zeeman_masks.is_empty()
        && plan.solved_antenna_drive_bases.is_empty()
    {
        return Ok(vec![[0.0, 0.0, 0.0]; plan.mesh.nodes.len()]);
    }

    let Some(bounds) = magnetic_bounds(plan) else {
        let mut total = combined_antenna_zeeman_mask_field_at_time(
            &plan.antenna_zeeman_masks,
            plan.mesh.nodes.len(),
            absolute_time_s,
        );
        add_solved_antenna_fields(plan, absolute_time_s, &mut total);
        return Ok(total);
    };

    let mut total = combined_antenna_zeeman_mask_field_at_time(
        &plan.antenna_zeeman_masks,
        plan.mesh.nodes.len(),
        absolute_time_s,
    );
    add_solved_antenna_fields(plan, absolute_time_s, &mut total);
    for module in &plan.current_modules {
        match module {
            CurrentModuleIR::AntennaFieldSource {
                model: AntennaFieldSourceModelIR::Mqs2p5dAz,
                antenna: Some(antenna),
                drive: Some(drive),
                ..
            } => {
                add_antenna_field(
                    &mut total,
                    &plan.mesh.nodes,
                    bounds,
                    antenna,
                    drive.current_a,
                );
            }
            CurrentModuleIR::AntennaFieldSource { .. }
            | CurrentModuleIR::CurrentTransport { .. } => {}
        }
    }
    Ok(total)
}

fn add_solved_antenna_fields(plan: &FemPlanIR, absolute_time_s: f64, total: &mut [[f64; 3]]) {
    for basis in &plan.solved_antenna_drive_bases {
        if !drive_is_active(&basis.drive.activation, plan) {
            continue;
        }
        let local_time = match basis.drive.time_origin {
            FieldTimeOriginIR::StageLocal => absolute_time_s - plan.time_stage.start_time_s,
            FieldTimeOriginIR::Absolute => absolute_time_s,
        };
        let multiplier =
            crate::time_dependence::evaluate_time_dependence(&basis.drive.waveform, local_time)
                * basis.drive.peak_current_a;
        for (target, value) in total.iter_mut().zip(&basis.field_xyz_apm_per_a) {
            target[0] += value[0] * multiplier;
            target[1] += value[1] * multiplier;
            target[2] += value[2] * multiplier;
        }
    }
}

fn add_antenna_field(
    total: &mut [[f64; 3]],
    nodes: &[[f64; 3]],
    magnetic_bounds: ([f64; 3], [f64; 3]),
    antenna: &AntennaIR,
    current_a: f64,
) {
    let ([min_x, min_y, _min_z], [max_x, max_y, max_z]) = magnetic_bounds;
    let center_x0 = 0.5 * (min_x + max_x);
    let center_y0 = 0.5 * (min_y + max_y);

    match antenna {
        AntennaIR::Microstrip {
            width,
            thickness,
            height_above_magnet,
            center_x,
            center_y,
            ..
        } => {
            let z_center = max_z + height_above_magnet + 0.5 * thickness;
            add_rectangular_conductor(
                total,
                nodes,
                center_x0 + center_x,
                center_y0 + center_y,
                z_center,
                *width,
                *thickness,
                current_a,
            );
        }
        AntennaIR::Cpw {
            signal_width,
            gap,
            ground_width,
            thickness,
            height_above_magnet,
            center_x,
            center_y,
            ..
        } => {
            let z_center = max_z + height_above_magnet + 0.5 * thickness;
            let x_center = center_x0 + center_x;
            let y_center = center_y0 + center_y;
            let ground_offset = 0.5 * signal_width + gap + 0.5 * ground_width;
            add_rectangular_conductor(
                total,
                nodes,
                x_center,
                y_center,
                z_center,
                *signal_width,
                *thickness,
                current_a,
            );
            add_rectangular_conductor(
                total,
                nodes,
                x_center - ground_offset,
                y_center,
                z_center,
                *ground_width,
                *thickness,
                -0.5 * current_a,
            );
            add_rectangular_conductor(
                total,
                nodes,
                x_center + ground_offset,
                y_center,
                z_center,
                *ground_width,
                *thickness,
                -0.5 * current_a,
            );
        }
    }
}

fn add_rectangular_conductor(
    total: &mut [[f64; 3]],
    nodes: &[[f64; 3]],
    x_center: f64,
    _y_center: f64,
    z_center: f64,
    width: f64,
    thickness: f64,
    current_a: f64,
) {
    if width <= 0.0 || thickness <= 0.0 || current_a == 0.0 {
        return;
    }

    let samples_x = quadrature_samples(width, thickness);
    let samples_z = quadrature_samples(thickness, width).min(8);
    let sample_count = (samples_x * samples_z) as f64;
    let sample_current = current_a / sample_count;
    let x0 = x_center - 0.5 * width;
    let z0 = z_center - 0.5 * thickness;

    for ix in 0..samples_x {
        let sx = x0 + (ix as f64 + 0.5) * width / samples_x as f64;
        for iz in 0..samples_z {
            let sz = z0 + (iz as f64 + 0.5) * thickness / samples_z as f64;
            for (node, field) in nodes.iter().zip(total.iter_mut()) {
                let rx = node[0] - sx;
                let rz = node[2] - sz;
                let r2 = (rx * rx + rz * rz).max(FIELD_EPSILON2);
                let coeff = sample_current / (2.0 * PI * r2);
                field[0] += -rz * coeff;
                field[2] += rx * coeff;
            }
        }
    }
}

fn quadrature_samples(primary: f64, secondary: f64) -> usize {
    let aspect = if secondary > 0.0 {
        (primary / secondary).abs()
    } else {
        1.0
    };
    aspect.round().clamp(4.0, 16.0) as usize
}

fn magnetic_bounds(plan: &FemPlanIR) -> Option<([f64; 3], [f64; 3])> {
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    let mut found = false;

    for cell in plan.mesh.cells.iter() {
        let marker = plan.mesh.element_markers.get(cell.ordinal)?;
        if *marker == 0 {
            continue;
        }
        for &node_idx in cell.nodes {
            let node = plan.mesh.nodes.get(node_idx as usize)?;
            for axis in 0..3 {
                min[axis] = min[axis].min(node[axis]);
                max[axis] = max[axis].max(node[axis]);
            }
            found = true;
        }
    }

    if found {
        Some((min, max))
    } else if let Some(first) = plan.mesh.nodes.first() {
        let mut min = *first;
        let mut max = *first;
        for node in &plan.mesh.nodes[1..] {
            for axis in 0..3 {
                min[axis] = min[axis].min(node[axis]);
                max[axis] = max[axis].max(node[axis]);
            }
        }
        Some((min, max))
    } else {
        None
    }
}
