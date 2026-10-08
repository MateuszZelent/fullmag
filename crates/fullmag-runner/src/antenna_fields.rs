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

pub(crate) fn validate_antenna_zeeman_mask_lengths(
    masks: &[ResolvedAntennaZeemanMaskIR],
    sample_count: usize,
) -> Result<(), RunError> {
    for mask in masks {
        if mask.field_xyz.len() != sample_count {
            return Err(RunError {
                message: format!(
                    "antenna Zeeman mask '{}' has {} field samples; expected {sample_count}",
                    mask.source,
                    mask.field_xyz.len()
                ),
            });
        }
    }
    Ok(())
}

pub(crate) fn validate_fdm_antenna_sample_counts(
    plan: &fullmag_ir::FdmPlanIR,
    sample_count: usize,
) -> Result<(), RunError> {
    validate_antenna_zeeman_mask_lengths(&plan.antenna_zeeman_masks, sample_count)?;
    let expected_projection_suffix = if plan.solved_antenna_drive_bases.is_empty() {
        String::new()
    } else {
        format!(
            ":target_topology:{}",
            crate::antenna_field_solution::fdm_target_topology_digest(plan)?
        )
    };
    for basis in &plan.solved_antenna_drive_bases {
        if basis.field_xyz_apm_per_a.len() != sample_count {
            return Err(RunError {
                message: format!(
                    "solved antenna drive '{}' has {} projected field samples; expected {sample_count} FDM cells",
                    basis.drive.id,
                    basis.field_xyz_apm_per_a.len()
                ),
            });
        }
        if !basis
            .projection_signature
            .ends_with(&expected_projection_suffix)
        {
            return Err(RunError {
                message: format!(
                    "solved antenna drive '{}' target topology differs from the resolved FDM grid",
                    basis.drive.id
                ),
            });
        }
    }
    Ok(())
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

fn legacy_antenna_current_at_time(drive: &fullmag_ir::RfDriveIR, absolute_time_s: f64) -> f64 {
    drive.current_a * time_dependence_multiplier(drive.waveform.as_ref(), absolute_time_s)
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
    // FEM reference advances a stage-relative solver clock. An absolute
    // waveform therefore adds the physical stage start via a negative offset.
    let mut terms = Vec::new();
    for mask in &plan.antenna_zeeman_masks {
        if let Some(waveform) = &mask.waveform {
            terms.push(RegionalFieldDriveTerm {
                basis_field: mask.field_xyz.clone(),
                waveform: waveform.clone(),
                time_offset_s: -plan.time_stage.start_time_s,
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
                    FieldTimeOriginIR::StageLocal => {
                        plan.time_stage.waveform_origin_time_s() - plan.time_stage.start_time_s
                    }
                    FieldTimeOriginIR::Absolute => -plan.time_stage.start_time_s,
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
                    time_offset_s: -plan.time_stage.start_time_s,
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
    validate_antenna_zeeman_mask_lengths(&plan.antenna_zeeman_masks, plan.mesh.nodes.len())?;
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
        validate_observed_antenna_field(&total, absolute_time_s)?;
        add_solved_antenna_fields(plan, absolute_time_s, &mut total)?;
        return Ok(total);
    };

    let mut total = combined_antenna_zeeman_mask_field_at_time(
        &plan.antenna_zeeman_masks,
        plan.mesh.nodes.len(),
        absolute_time_s,
    );
    validate_observed_antenna_field(&total, absolute_time_s)?;
    add_solved_antenna_fields(plan, absolute_time_s, &mut total)?;
    for module in &plan.current_modules {
        match module {
            CurrentModuleIR::AntennaFieldSource {
                model: AntennaFieldSourceModelIR::Mqs2p5dAz,
                antenna: Some(antenna),
                drive: Some(drive),
                ..
            } => {
                // The geometry-dependent basis is evaluated once per call and
                // the authored scalar waveform is applied at the requested
                // physical time.  Omitting this multiplier silently turned a
                // sinusoidal/pulsed legacy source into a DC source in previews
                // and observations.
                let current_a = legacy_antenna_current_at_time(drive, absolute_time_s);
                add_antenna_field(&mut total, &plan.mesh.nodes, bounds, antenna, current_a);
            }
            CurrentModuleIR::AntennaFieldSource { .. }
            | CurrentModuleIR::CurrentTransport { .. } => {}
        }
    }
    validate_observed_antenna_field(&total, absolute_time_s)?;
    Ok(total)
}

fn validate_observed_antenna_field(
    field: &[[f64; 3]],
    absolute_time_s: f64,
) -> Result<(), RunError> {
    if field.iter().flatten().any(|component| !component.is_finite()) {
        return Err(RunError {
            message: format!(
                "antenna observation contains a non-finite H field at time {absolute_time_s}"
            ),
        });
    }
    Ok(())
}

fn add_solved_antenna_fields(
    plan: &FemPlanIR,
    absolute_time_s: f64,
    total: &mut [[f64; 3]],
) -> Result<(), RunError> {
    for basis in &plan.solved_antenna_drive_bases {
        if !drive_is_active(&basis.drive.activation, plan) {
            continue;
        }
        if basis.field_xyz_apm_per_a.len() != total.len() {
            return Err(RunError {
                message: format!(
                    "solved antenna drive '{}' has {} projected field samples; expected {} FEM nodes",
                    basis.drive.id,
                    basis.field_xyz_apm_per_a.len(),
                    total.len()
                ),
            });
        }
        let local_time = match basis.drive.time_origin {
            FieldTimeOriginIR::StageLocal => {
                absolute_time_s - plan.time_stage.waveform_origin_time_s()
            }
            FieldTimeOriginIR::Absolute => absolute_time_s,
        };
        let multiplier =
            crate::time_dependence::evaluate_time_dependence(&basis.drive.waveform, local_time)
                * basis.drive.peak_current_a;
        if !multiplier.is_finite() {
            return Err(RunError {
                message: format!(
                    "solved antenna drive '{}' has a non-finite current multiplier at time {absolute_time_s}",
                    basis.drive.id
                ),
            });
        }
        for (target, value) in total.iter_mut().zip(&basis.field_xyz_apm_per_a) {
            target[0] += value[0] * multiplier;
            target[1] += value[1] * multiplier;
            target[2] += value[2] * multiplier;
            if target.iter().any(|component| !component.is_finite()) {
                return Err(RunError {
                    message: format!(
                        "solved antenna drive '{}' produced a non-finite observed H field at time {absolute_time_s}",
                        basis.drive.id
                    ),
                });
            }
        }
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn antenna_mask_length_must_match_target_even_when_waveform_is_zero() {
        let mask = ResolvedAntennaZeemanMaskIR {
            source: "antenna_1".into(),
            object: "magnet".into(),
            amplitude_b_t: 0.0,
            direction: [1.0, 0.0, 0.0],
            spatial_profile: None,
            waveform: None,
            field_xyz: vec![[0.0; 3]],
        };
        let error = validate_antenna_zeeman_mask_lengths(&[mask.clone()], 2).unwrap_err();
        assert!(error.message.contains("expected 2"));
        validate_antenna_zeeman_mask_lengths(&[mask], 1).unwrap();
    }

    #[test]
    fn legacy_antenna_current_applies_sinusoidal_waveform_at_physical_time() {
        let drive = fullmag_ir::RfDriveIR {
            current_a: 2.0,
            waveform: Some(TimeDependenceIR::Sinusoidal {
                frequency_hz: 1.0,
                phase_rad: 0.0,
                offset: 0.0,
            }),
        };
        assert!((legacy_antenna_current_at_time(&drive, 0.0)).abs() < 1.0e-15);
        assert!((legacy_antenna_current_at_time(&drive, 0.25) - 2.0).abs() < 1.0e-12);
        assert!((legacy_antenna_current_at_time(&drive, 0.75) + 2.0).abs() < 1.0e-12);
    }

    #[test]
    fn legacy_antenna_current_without_waveform_is_static() {
        let drive = fullmag_ir::RfDriveIR {
            current_a: -3.5,
            waveform: None,
        };
        assert_eq!(legacy_antenna_current_at_time(&drive, 0.0), -3.5);
        assert_eq!(legacy_antenna_current_at_time(&drive, 12.0), -3.5);
    }

    #[test]
    fn solved_antenna_observation_rejects_waveform_scaled_field_overflow() {
        let mut plan = FemPlanIR::default();
        plan.time_stage.study_kind = fullmag_ir::StudyKindIR::TimeEvolution;
        plan.solved_antenna_drive_bases = vec![fullmag_ir::ResolvedSolvedAntennaDriveBasisIR {
            drive: fullmag_ir::SolvedAntennaDriveIR {
                id: "drive_1".into(),
                name: "Drive 1".into(),
                projection_ref: "projection_1".into(),
                port_mode_id: "port_1".into(),
                peak_current_a: 1.0,
                waveform: TimeDependenceIR::Sinusoidal {
                    frequency_hz: 1.0,
                    phase_rad: std::f64::consts::FRAC_PI_2,
                    offset: 2.0,
                },
                bandwidth_declaration: None,
                time_origin: FieldTimeOriginIR::Absolute,
                activation: fullmag_ir::DriveActivationIR::AllTimeEvolution {},
            },
            solution_id: "solution_1".into(),
            source_object_id: "antenna_1".into(),
            field_xyz_apm_per_a: vec![[0.75 * f64::MAX, 0.0, 0.0]],
            projection_signature: "projection".into(),
        }];
        let mut total = vec![[0.0; 3]];
        let error = add_solved_antenna_fields(&plan, 0.0, &mut total)
            .expect_err("finite waveform inputs must not publish an overflowing H observation");
        assert!(error.message.contains("non-finite observed H field"));
    }

    #[test]
    fn antenna_observation_rejects_legacy_mask_field_overflow() {
        let mut plan = FemPlanIR::default();
        plan.mesh.nodes = vec![[0.0, 0.0, 0.0]];
        plan.antenna_zeeman_masks = vec![ResolvedAntennaZeemanMaskIR {
            source: "antenna_1".into(),
            object: "magnet".into(),
            amplitude_b_t: 0.0,
            direction: [1.0, 0.0, 0.0],
            spatial_profile: None,
            waveform: Some(TimeDependenceIR::Sinusoidal {
                frequency_hz: 1.0,
                phase_rad: std::f64::consts::FRAC_PI_2,
                offset: 2.0,
            }),
            field_xyz: vec![[0.75 * f64::MAX, 0.0, 0.0]],
        }];
        let error = compute_antenna_field_at_time(&plan, 0.0)
            .expect_err("a legacy mask must not publish an overflowing H observation");
        assert!(error.message.contains("non-finite H field"));
    }
}
