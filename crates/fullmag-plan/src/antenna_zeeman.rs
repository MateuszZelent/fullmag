use fullmag_ir::{
    AntennaFieldSourceModelIR, AntennaSpatialProfileIR, CurrentModuleIR, GeometryEntryIR,
    ProblemIR, ResolvedAntennaZeemanMaskIR,
};

use crate::error::PlanError;
use crate::util::MU0;

pub(crate) fn has_prescribed_zeeman_mask_source(problem: &ProblemIR) -> bool {
    problem.current_modules.iter().any(|module| {
        matches!(
            module,
            CurrentModuleIR::AntennaFieldSource {
                model: AntennaFieldSourceModelIR::PrescribedZeemanMask,
                ..
            }
        )
    })
}

pub(crate) fn resolve_prescribed_zeeman_masks(
    problem: &ProblemIR,
    sample_points: &[[f64; 3]],
    active_mask: Option<&[bool]>,
) -> Result<Vec<ResolvedAntennaZeemanMaskIR>, PlanError> {
    let mut resolved = Vec::new();
    let mut errors = Vec::new();

    for (index, module) in problem.current_modules.iter().enumerate() {
        let CurrentModuleIR::AntennaFieldSource {
            name,
            model: AntennaFieldSourceModelIR::PrescribedZeemanMask,
            object: Some(object),
            field: Some(field),
            spatial_profile,
            waveform,
            ..
        } = module
        else {
            continue;
        };

        let Some(geometry) = find_geometry(problem, object) else {
            errors.push(format!(
                "current_modules[{index}] prescribed_zeeman_mask source '{}' references missing antenna object '{}'",
                name, object
            ));
            continue;
        };

        let direction_norm = norm(field.direction);
        if direction_norm <= 0.0 {
            errors.push(format!(
                "current_modules[{index}] prescribed_zeeman_mask source '{}' direction must be non-zero",
                name
            ));
            continue;
        }
        let unit_direction = [
            field.direction[0] / direction_norm,
            field.direction[1] / direction_norm,
            field.direction[2] / direction_norm,
        ];
        let amplitude_h_apm = field.amplitude_b_t / MU0;
        let profile = spatial_profile
            .as_ref()
            .unwrap_or(&AntennaSpatialProfileIR::Uniform);
        let mut field_xyz = vec![[0.0, 0.0, 0.0]; sample_points.len()];
        let mut assigned = 0usize;
        for (sample_index, point) in sample_points.iter().enumerate() {
            if active_mask.is_some_and(|mask| !mask[sample_index]) {
                continue;
            }
            let inside = match geometry_contains_point(geometry, *point) {
                Ok(inside) => inside,
                Err(message) => {
                    errors.push(format!(
                        "current_modules[{index}] prescribed_zeeman_mask source '{}' object '{}': {message}",
                        name, object
                    ));
                    break;
                }
            };
            if !inside {
                continue;
            }
            let weight = spatial_profile_weight(profile, *point);
            if weight == 0.0 {
                continue;
            }
            field_xyz[sample_index] = [
                amplitude_h_apm * unit_direction[0] * weight,
                amplitude_h_apm * unit_direction[1] * weight,
                amplitude_h_apm * unit_direction[2] * weight,
            ];
            assigned += 1;
        }
        if assigned == 0 {
            errors.push(format!(
                "current_modules[{index}] prescribed_zeeman_mask source '{}' object '{}' does not overlap any active magnetic sample points",
                name, object
            ));
        }

        resolved.push(ResolvedAntennaZeemanMaskIR {
            source: name.clone(),
            object: object.clone(),
            amplitude_b_t: field.amplitude_b_t,
            direction: unit_direction,
            spatial_profile: spatial_profile.clone(),
            waveform: waveform.clone(),
            field_xyz,
        });
    }

    if errors.is_empty() {
        Ok(resolved)
    } else {
        Err(PlanError { reasons: errors })
    }
}

fn find_geometry<'a>(problem: &'a ProblemIR, object: &str) -> Option<&'a GeometryEntryIR> {
    problem
        .geometry
        .entries
        .iter()
        .find(|entry| entry.name() == object)
        .or_else(|| {
            problem
                .regions
                .iter()
                .find(|region| region.name == object)
                .and_then(|region| {
                    problem
                        .geometry
                        .entries
                        .iter()
                        .find(|entry| entry.name() == region.geometry)
                })
        })
}

fn geometry_contains_point(entry: &GeometryEntryIR, point: [f64; 3]) -> Result<bool, String> {
    match entry {
        GeometryEntryIR::Box { size, .. } => Ok((0..3).all(|axis| {
            point[axis] >= -0.5 * size[axis] && point[axis] <= 0.5 * size[axis]
        })),
        GeometryEntryIR::Cylinder { radius, height, .. } => {
            let r2 = point[0] * point[0] + point[1] * point[1];
            Ok(r2 <= radius * radius && point[2].abs() <= 0.5 * height)
        }
        GeometryEntryIR::Translate { base, by, .. } => geometry_contains_point(
            base,
            [point[0] - by[0], point[1] - by[1], point[2] - by[2]],
        ),
        GeometryEntryIR::Difference { base, tool, .. } => {
            Ok(geometry_contains_point(base, point)? && !geometry_contains_point(tool, point)?)
        }
        GeometryEntryIR::SinWaveguide { .. }
        | GeometryEntryIR::ArchWaveguide { .. }
        | GeometryEntryIR::ImportedGeometry { .. }
        | GeometryEntryIR::Ellipsoid { .. }
        | GeometryEntryIR::Sphere { .. }
        | GeometryEntryIR::Ellipse { .. }
        | GeometryEntryIR::Union { .. }
        | GeometryEntryIR::Intersection { .. } => Err(format!(
            "antenna mask geometry kind '{}' is not executable yet; use Box/Cylinder/Difference/Translate",
            entry_kind(entry)
        )),
    }
}

fn spatial_profile_weight(profile: &AntennaSpatialProfileIR, point: [f64; 3]) -> f64 {
    match profile {
        AntennaSpatialProfileIR::Uniform => 1.0,
        AntennaSpatialProfileIR::Sinc {
            axis,
            period_m,
            width_m,
            center_m,
            window,
        } => {
            let axis_norm = norm(*axis);
            if axis_norm <= 0.0 || *period_m == 0.0 {
                return 0.0;
            }
            let coord = (point[0] * axis[0] + point[1] * axis[1] + point[2] * axis[2]) / axis_norm
                - center_m.unwrap_or(0.0);
            if let Some(width) = width_m {
                if coord.abs() > width * 0.5 {
                    return 0.0;
                }
            }
            let value = sinc(coord / period_m);
            if window == "hann" {
                if let Some(width) = width_m {
                    let phase = (coord / width + 0.5).clamp(0.0, 1.0);
                    return value * (std::f64::consts::PI * phase).sin().powi(2);
                }
            }
            value
        }
    }
}

fn sinc(value: f64) -> f64 {
    if value.abs() < 1.0e-12 {
        1.0
    } else {
        let x = std::f64::consts::PI * value;
        x.sin() / x
    }
}

fn norm(value: [f64; 3]) -> f64 {
    (value[0] * value[0] + value[1] * value[1] + value[2] * value[2]).sqrt()
}

fn entry_kind(entry: &GeometryEntryIR) -> &'static str {
    match entry {
        GeometryEntryIR::ImportedGeometry { .. } => "imported_geometry",
        GeometryEntryIR::Box { .. } => "box",
        GeometryEntryIR::Cylinder { .. } => "cylinder",
        GeometryEntryIR::SinWaveguide { .. } => "sin_waveguide",
        GeometryEntryIR::ArchWaveguide { .. } => "arch_waveguide",
        GeometryEntryIR::Ellipsoid { .. } => "ellipsoid",
        GeometryEntryIR::Sphere { .. } => "sphere",
        GeometryEntryIR::Ellipse { .. } => "ellipse",
        GeometryEntryIR::Difference { .. } => "difference",
        GeometryEntryIR::Union { .. } => "union",
        GeometryEntryIR::Intersection { .. } => "intersection",
        GeometryEntryIR::Translate { .. } => "translate",
    }
}
