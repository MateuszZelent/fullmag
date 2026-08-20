use fullmag_ir::{
    FdmGridCertificateIR, FieldEnvelopeIR, FieldSpatialProfileIR, FieldTargetIR, GeometryEntryIR,
    RegionalFieldDriveIR, ResolvedRegionalFieldDriveBasisIR,
};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

use crate::selection::geometry::{
    contains_point, AffineTransform3, BoundaryMembership, GeometryPredicate,
};
use crate::{util::MU0, PlanError};

pub(crate) fn resolve_fdm_regional_field_drives(
    drives: &[RegionalFieldDriveIR],
    sample_points: &[[f64; 3]],
    active_mask: Option<&[bool]>,
    region_mask: &[u32],
    certificate: Option<&FdmGridCertificateIR>,
    cell_size: [f64; 3],
    geometry: &[GeometryEntryIR],
) -> Result<Vec<ResolvedRegionalFieldDriveBasisIR>, PlanError> {
    let mut resolved = Vec::with_capacity(drives.len());
    for drive in drives.iter().filter(|drive| drive.enabled) {
        let compiled_profile = CompiledSpatialProfile::new(&drive.spatial_profile, geometry)?;
        let target_regions: BTreeSet<u32> = match &drive.target {
            FieldTargetIR::Region { object_id, region_id } => certificate
                .and_then(|certificate| certificate.region_legend.iter().find(|entry| {
                    entry.object_id == *object_id && entry.region_id == *region_id
                }))
                .map(|entry| BTreeSet::from([entry.numeric_id]))
                .ok_or_else(|| PlanError { reasons: vec![format!(
                    "RegionalFieldDrive '{}' target region '{}/{}' has no resolved FDM region marker",
                    drive.id, object_id, region_id
                )] })?,
            FieldTargetIR::Object { object_id } => {
                let regions: BTreeSet<u32> = certificate.into_iter()
                    .flat_map(|certificate| &certificate.region_legend)
                    .filter(|entry| entry.object_id == *object_id)
                    .map(|entry| entry.numeric_id).collect();
                if regions.is_empty() { return Err(PlanError { reasons: vec![format!(
                    "RegionalFieldDrive '{}' target object '{}' has no resolved FDM region markers",
                    drive.id, object_id)] }); }
                regions
            }
            FieldTargetIR::Global {} => BTreeSet::new(),
        };
        let amplitude_h = drive.amplitude_b_t / MU0;
        let mut field_xyz = vec![[0.0; 3]; sample_points.len()];
        for (index, point) in sample_points.iter().enumerate() {
            if active_mask.is_some_and(|mask| !mask[index]) {
                continue;
            }
            if !target_regions.is_empty()
                && !target_regions.contains(&region_mask.get(index).copied().unwrap_or(0))
            {
                continue;
            }
            let weight = spatial_cell_average(&compiled_profile, *point, cell_size)?;
            field_xyz[index] = [
                amplitude_h * drive.direction[0] * weight,
                amplitude_h * drive.direction[1] * weight,
                amplitude_h * drive.direction[2] * weight,
            ];
        }
        let payload = serde_json::to_vec(&(drive, &field_xyz)).expect("serializable drive basis");
        resolved.push(ResolvedRegionalFieldDriveBasisIR {
            drive: drive.clone(),
            field_xyz,
            projection_signature: format!("sha256:{:x}", Sha256::digest(payload)),
        });
    }
    Ok(resolved)
}

fn sinc_value(
    axis: [f64; 3],
    period_m: f64,
    center_m: f64,
    width_m: Option<f64>,
    window: &str,
    point: [f64; 3],
) -> f64 {
    let coordinate = point[0] * axis[0] + point[1] * axis[1] + point[2] * axis[2] - center_m;
    if width_m.is_some_and(|width| coordinate.abs() > 0.5 * width) {
        return 0.0;
    }
    let x = std::f64::consts::PI * coordinate / period_m;
    let sinc = if x.abs() <= 1e-4 {
        let x2 = x * x;
        1.0 - x2 / 6.0 + x2 * x2 / 120.0
    } else {
        x.sin() / x
    };
    let envelope = if window == "hann" {
        let width = width_m.expect("validated Hann profile has width");
        0.5 * (1.0 + (2.0 * std::f64::consts::PI * coordinate / width).cos())
    } else {
        1.0
    };
    sinc * envelope
}

struct CompiledGeometryMask<'a> {
    entry: &'a GeometryEntryIR,
    predicate: GeometryPredicate,
}

struct CompiledSpatialProfile<'a> {
    profile: &'a FieldSpatialProfileIR,
    geometry_mask: Option<CompiledGeometryMask<'a>>,
}

impl<'a> CompiledSpatialProfile<'a> {
    fn new(
        profile: &'a FieldSpatialProfileIR,
        geometry: &'a [GeometryEntryIR],
    ) -> Result<Self, PlanError> {
        let geometry_mask = if let FieldSpatialProfileIR::GeometryMask { object_id, .. } = profile {
            let entry = geometry
                .iter()
                .find(|entry| entry.name() == object_id)
                .ok_or_else(|| PlanError {
                    reasons: vec![format!(
                        "FDM RegionalFieldDrive geometry mask '{}' is absent",
                        object_id
                    )],
                })?;
            let predicate = GeometryPredicate::from_geometry_entry(
                entry,
                AffineTransform3::identity(),
                BoundaryMembership::inclusive(),
            )
            .map_err(|error| PlanError {
                reasons: vec![format!(
                    "FDM RegionalFieldDrive geometry mask '{}': {error}",
                    entry.name()
                )],
            })?;
            Some(CompiledGeometryMask { entry, predicate })
        } else {
            None
        };
        Ok(Self {
            profile,
            geometry_mask,
        })
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CellRelation {
    Outside,
    Inside,
    Boundary,
}

fn geometry_cell_relation(
    entry: &GeometryEntryIR,
    center: [f64; 3],
    half: [f64; 3],
) -> Result<CellRelation, PlanError> {
    Ok(match entry {
        GeometryEntryIR::Box { size, .. } => {
            if (0..3).any(|axis| {
                center[axis] + half[axis] <= -0.5 * size[axis]
                    || center[axis] - half[axis] >= 0.5 * size[axis]
            }) {
                CellRelation::Outside
            } else if (0..3).all(|axis| {
                center[axis] - half[axis] >= -0.5 * size[axis]
                    && center[axis] + half[axis] <= 0.5 * size[axis]
            }) {
                CellRelation::Inside
            } else {
                CellRelation::Boundary
            }
        }
        GeometryEntryIR::Cylinder { .. } => CellRelation::Boundary,
        GeometryEntryIR::Translate { base, by, .. } => geometry_cell_relation(
            base,
            [center[0] - by[0], center[1] - by[1], center[2] - by[2]],
            half,
        )?,
        GeometryEntryIR::Union { a, b, .. } => {
            let a = geometry_cell_relation(a, center, half)?;
            let b = geometry_cell_relation(b, center, half)?;
            if a == CellRelation::Inside || b == CellRelation::Inside {
                CellRelation::Inside
            } else if a == CellRelation::Outside && b == CellRelation::Outside {
                CellRelation::Outside
            } else {
                CellRelation::Boundary
            }
        }
        GeometryEntryIR::Intersection { a, b, .. } => {
            let a = geometry_cell_relation(a, center, half)?;
            let b = geometry_cell_relation(b, center, half)?;
            if a == CellRelation::Outside || b == CellRelation::Outside {
                CellRelation::Outside
            } else if a == CellRelation::Inside && b == CellRelation::Inside {
                CellRelation::Inside
            } else {
                CellRelation::Boundary
            }
        }
        GeometryEntryIR::Difference { base, tool, .. } => {
            let a = geometry_cell_relation(base, center, half)?;
            let b = geometry_cell_relation(tool, center, half)?;
            if a == CellRelation::Outside || b == CellRelation::Inside {
                CellRelation::Outside
            } else if a == CellRelation::Inside && b == CellRelation::Outside {
                CellRelation::Inside
            } else {
                CellRelation::Boundary
            }
        }
        _ => CellRelation::Boundary,
    })
}

fn spatial_point_value(
    compiled: &CompiledSpatialProfile<'_>,
    point: [f64; 3],
) -> Result<f64, PlanError> {
    match compiled.profile {
        FieldSpatialProfileIR::Uniform {} => Ok(1.0),
        FieldSpatialProfileIR::Sinc {
            axis,
            period_m,
            center_m,
            width_m,
            window,
        } => Ok(sinc_value(
            *axis, *period_m, *center_m, *width_m, window, point,
        )),
        FieldSpatialProfileIR::GeometryMask {
            object_id,
            envelope,
        } => {
            let geometry_mask = compiled
                .geometry_mask
                .as_ref()
                .expect("geometry mask profile is compiled with its predicate");
            if !contains_point(&geometry_mask.predicate, point).map_err(|error| PlanError {
                reasons: vec![format!(
                    "FDM RegionalFieldDrive geometry mask '{}': {error}",
                    object_id
                )],
            })? {
                return Ok(0.0);
            }
            Ok(match envelope {
                FieldEnvelopeIR::Uniform {} => 1.0,
                FieldEnvelopeIR::Sinc {
                    axis,
                    period_m,
                    center_m,
                    width_m,
                    window,
                } => sinc_value(*axis, *period_m, *center_m, *width_m, window, point),
            })
        }
        FieldSpatialProfileIR::GaussianPlaneWave {
            center_x_m,
            center_y_m,
            carrier_origin_x_m,
            sigma_x_m,
            sigma_y_m,
            wavelength_m,
            carrier_phase_rad,
        } => {
            let dx = (point[0] - center_x_m) / sigma_x_m;
            let dy = (point[1] - center_y_m) / sigma_y_m;
            let envelope = (-0.5 * (dx * dx + dy * dy)).exp();
            let carrier = 2.0 * std::f64::consts::PI * (point[0] - carrier_origin_x_m)
                / wavelength_m
                + carrier_phase_rad;
            Ok(envelope * carrier.cos())
        }
    }
}

#[cfg(test)]
pub(crate) fn geometry_mask_membership_for_points(
    geometry: &GeometryEntryIR,
    points: &[[f64; 3]],
) -> Result<Vec<bool>, PlanError> {
    let profile = FieldSpatialProfileIR::GeometryMask {
        object_id: geometry.name().to_string(),
        envelope: FieldEnvelopeIR::Uniform {},
    };
    let compiled = CompiledSpatialProfile::new(&profile, std::slice::from_ref(geometry))?;
    points
        .iter()
        .map(|point| spatial_point_value(&compiled, *point).map(|value| value == 1.0))
        .collect()
}

fn tensor_average<const N: usize>(
    compiled: &CompiledSpatialProfile<'_>,
    center: [f64; 3],
    half: [f64; 3],
    points: [f64; N],
    weights: [f64; N],
) -> Result<f64, PlanError> {
    let mut sum = 0.0;
    for ix in 0..N {
        for iy in 0..N {
            for iz in 0..N {
                let point = [
                    center[0] + half[0] * points[ix],
                    center[1] + half[1] * points[iy],
                    center[2] + half[2] * points[iz],
                ];
                sum +=
                    weights[ix] * weights[iy] * weights[iz] * spatial_point_value(compiled, point)?;
            }
        }
    }
    Ok(sum / 8.0)
}

fn adaptive_cell_average(
    compiled: &CompiledSpatialProfile<'_>,
    center: [f64; 3],
    half: [f64; 3],
    depth: u32,
) -> Result<f64, PlanError> {
    const P4: [f64; 4] = [
        -0.8611363115940526,
        -0.3399810435848563,
        0.3399810435848563,
        0.8611363115940526,
    ];
    const W4: [f64; 4] = [
        0.34785484513745385,
        0.6521451548625461,
        0.6521451548625461,
        0.34785484513745385,
    ];
    match compiled.profile {
        FieldSpatialProfileIR::Sinc { .. } | FieldSpatialProfileIR::GaussianPlaneWave { .. }
            if depth == 0 =>
        {
            return tensor_average(compiled, center, half, P4, W4);
        }
        FieldSpatialProfileIR::GeometryMask {
            object_id: _,
            envelope,
        } => {
            let entry = compiled
                .geometry_mask
                .as_ref()
                .expect("geometry mask profile is compiled with its predicate")
                .entry;
            match geometry_cell_relation(entry, center, half)? {
                CellRelation::Outside => return Ok(0.0),
                CellRelation::Inside if matches!(envelope, FieldEnvelopeIR::Uniform {}) => {
                    return Ok(1.0)
                }
                CellRelation::Inside => return tensor_average(compiled, center, half, P4, W4),
                CellRelation::Boundary => {}
            }
        }
        _ => {}
    }
    let low = tensor_average(
        compiled,
        center,
        half,
        [-0.5773502691896257, 0.5773502691896257],
        [1.0, 1.0],
    )?;
    let high = tensor_average(compiled, center, half, P4, W4)?;
    if (high - low).abs() <= 1.0e-6 {
        return Ok(high);
    }
    if depth == 10 {
        return Err(PlanError { reasons: vec![
        "FDM RegionalFieldDrive adaptive cell-volume projection did not converge at maximum depth 10".to_string()] });
    }
    let child_half = [half[0] * 0.5, half[1] * 0.5, half[2] * 0.5];
    let mut sum = 0.0;
    for sx in [-1.0, 1.0] {
        for sy in [-1.0, 1.0] {
            for sz in [-1.0, 1.0] {
                let child = [
                    center[0] + sx * child_half[0],
                    center[1] + sy * child_half[1],
                    center[2] + sz * child_half[2],
                ];
                sum += adaptive_cell_average(compiled, child, child_half, depth + 1)?;
            }
        }
    }
    Ok(sum / 8.0)
}

fn spatial_cell_average(
    compiled: &CompiledSpatialProfile<'_>,
    center: [f64; 3],
    cell_size: [f64; 3],
) -> Result<f64, PlanError> {
    if matches!(compiled.profile, FieldSpatialProfileIR::Uniform {}) {
        return Ok(1.0);
    }
    adaptive_cell_average(
        compiled,
        center,
        [cell_size[0] * 0.5, cell_size[1] * 0.5, cell_size[2] * 0.5],
        0,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::selection::geometry::{
        geometry_entry_compilation_count, reset_geometry_entry_compilation_count,
    };

    #[test]
    fn geometry_mask_uses_cell_volume_average_instead_of_centroid_sampling() {
        let geometry = vec![GeometryEntryIR::Translate {
            name: "half-cell".into(),
            base: Box::new(GeometryEntryIR::Box {
                name: "box".into(),
                size: [1.0, 1.0, 1.0],
            }),
            by: [-0.5, 0.0, 0.0],
        }];
        let profile = FieldSpatialProfileIR::GeometryMask {
            object_id: "half-cell".into(),
            envelope: FieldEnvelopeIR::Uniform {},
        };
        let compiled = CompiledSpatialProfile::new(&profile, &geometry).unwrap();
        let average = spatial_cell_average(&compiled, [0.0; 3], [1.0; 3]).unwrap();
        assert!((average - 0.5).abs() < 1.0e-10, "average={average}");
    }

    #[test]
    fn spatial_sinc_is_integrated_over_the_cell() {
        let profile = FieldSpatialProfileIR::Sinc {
            axis: [1.0, 0.0, 0.0],
            period_m: 1.0,
            center_m: 0.0,
            width_m: None,
            window: "none".into(),
        };
        let compiled = CompiledSpatialProfile::new(&profile, &[]).unwrap();
        let average = spatial_cell_average(&compiled, [0.0; 3], [1.0, 0.1, 0.1]).unwrap();
        assert!(average < 1.0 && average > 0.5, "average={average}");
    }

    #[test]
    fn gaussian_plane_wave_profile_uses_independent_carrier_origin() {
        let profile = FieldSpatialProfileIR::GaussianPlaneWave {
            center_x_m: -1.0e-6,
            center_y_m: 0.0,
            carrier_origin_x_m: 0.0,
            sigma_x_m: 196.0e-9,
            sigma_y_m: 186.8507960633642e-9,
            wavelength_m: 196.0e-9,
            carrier_phase_rad: 0.0,
        };

        let compiled = CompiledSpatialProfile::new(&profile, &[]).unwrap();
        let at_carrier_origin = spatial_point_value(&compiled, [0.0, 0.0, 0.0]).unwrap();
        let at_quarter_wave = spatial_point_value(&compiled, [49.0e-9, 0.0, 0.0]).unwrap();
        let expected_envelope: f64 = (-0.5_f64 * (1.0e-6_f64 / 196.0e-9_f64).powi(2)).exp();

        assert!((at_carrier_origin - expected_envelope).abs() < 1.0e-14);
        assert!(at_quarter_wave.abs() < 1.0e-14, "value={at_quarter_wave}");
    }

    #[test]
    fn gaussian_plane_wave_profile_is_cell_averaged() {
        let profile = FieldSpatialProfileIR::GaussianPlaneWave {
            center_x_m: 0.0,
            center_y_m: 0.0,
            carrier_origin_x_m: 0.0,
            sigma_x_m: 1.0,
            sigma_y_m: 1.0,
            wavelength_m: 4.0,
            carrier_phase_rad: 0.0,
        };

        let compiled = CompiledSpatialProfile::new(&profile, &[]).unwrap();
        let average = spatial_cell_average(&compiled, [0.0; 3], [0.25, 0.1, 0.1]).unwrap();
        assert!(average < 1.0 && average > 0.9, "average={average}");
    }

    #[test]
    fn difference_mask_does_not_treat_corner_coverage_as_full_cell_coverage() {
        let geometry = vec![GeometryEntryIR::Difference {
            name: "box-with-hole".into(),
            base: Box::new(GeometryEntryIR::Box {
                name: "outer".into(),
                size: [2.0, 2.0, 2.0],
            }),
            tool: Box::new(GeometryEntryIR::Box {
                name: "hole".into(),
                size: [0.5, 0.5, 0.5],
            }),
        }];
        let profile = FieldSpatialProfileIR::GeometryMask {
            object_id: "box-with-hole".into(),
            envelope: FieldEnvelopeIR::Uniform {},
        };

        let compiled = CompiledSpatialProfile::new(&profile, &geometry).unwrap();
        let average = spatial_cell_average(&compiled, [0.0; 3], [1.0; 3]).unwrap();

        assert!((average - 0.875).abs() < 1.0e-10, "average={average}");
    }

    #[test]
    fn sphere_geometry_mask_reaches_canonical_sampling() {
        let geometry = vec![GeometryEntryIR::Sphere {
            name: "sphere".into(),
            radius: 2.0,
        }];
        let profile = FieldSpatialProfileIR::GeometryMask {
            object_id: "sphere".into(),
            envelope: FieldEnvelopeIR::Uniform {},
        };

        let compiled = CompiledSpatialProfile::new(&profile, &geometry).unwrap();
        let average = spatial_cell_average(&compiled, [0.0; 3], [0.5; 3]).unwrap();

        assert!((average - 1.0).abs() < 1.0e-12, "average={average}");
    }

    #[test]
    fn csg_with_sphere_reaches_canonical_sampling() {
        let geometry = vec![GeometryEntryIR::Union {
            name: "sphere-union".into(),
            a: Box::new(GeometryEntryIR::Sphere {
                name: "sphere".into(),
                radius: 2.0,
            }),
            b: Box::new(GeometryEntryIR::Box {
                name: "box".into(),
                size: [0.25; 3],
            }),
        }];
        let profile = FieldSpatialProfileIR::GeometryMask {
            object_id: "sphere-union".into(),
            envelope: FieldEnvelopeIR::Uniform {},
        };

        let compiled = CompiledSpatialProfile::new(&profile, &geometry).unwrap();
        let average = spatial_cell_average(&compiled, [0.0; 3], [0.5; 3]).unwrap();

        assert!((average - 1.0).abs() < 1.0e-12, "average={average}");
    }

    #[test]
    fn geometry_mask_compiles_once_for_multiple_point_samples() {
        let geometry = GeometryEntryIR::Sphere {
            name: "sphere".into(),
            radius: 2.0,
        };
        reset_geometry_entry_compilation_count();

        let memberships = geometry_mask_membership_for_points(
            &geometry,
            &[[0.0; 3], [1.0, 0.0, 0.0], [3.0, 0.0, 0.0]],
        )
        .unwrap();

        assert_eq!(memberships, vec![true, true, false]);
        assert_eq!(geometry_entry_compilation_count(), 1);
    }
}
