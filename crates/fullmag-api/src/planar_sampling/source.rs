use fullmag_ir::{
    MonitorTargetIR, PlanarExtentIR, PlanarFrameIR, PlanarFramePresetIR, PlanarMonitorIR,
    PlanarOperatorIR, PLANAR_FRAME_NORMALIZATION_VERSION,
};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::error::ApiError;
use crate::schemas::domain::DomainMeta;
use crate::schemas::visualization_state::{
    DefaultPlanarOperatorState, DefaultPlanarSliceState, PlanarAxisPlane,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct ResolvedPlanarSourceIdentity {
    pub source_kind: String,
    pub source_id: Option<String>,
    pub source_hash: String,
    pub source_revision: u64,
    pub domain_generation_id: String,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ResolvedPlanarSamplingSource {
    pub identity: ResolvedPlanarSourceIdentity,
    pub target: MonitorTargetIR,
    pub frame: PlanarFrameIR,
    pub operator: PlanarOperatorIR,
}

fn default_slice_coordinate(
    domain: &DomainMeta,
    axis: usize,
    position_fraction: f64,
) -> Result<f64, ApiError> {
    let continuous = domain.bounds.min[axis]
        + position_fraction * (domain.bounds.max[axis] - domain.bounds.min[axis]);
    if domain.discretization != "fdm" {
        return Ok(continuous);
    }
    let Some(grid) = domain.grid.as_ref() else {
        return Ok(continuous);
    };

    for grid_axis in 0..3 {
        let count = grid.shape[grid_axis];
        let origin = grid.origin[grid_axis];
        let spacing = grid.spacing[grid_axis];
        if count == 0 || !origin.is_finite() || !spacing.is_finite() || spacing <= 0.0 {
            return Err(ApiError::unprocessable(
                "planar_default_grid_invalid: structured FDM grid shape, origin, and spacing must be valid",
            ));
        }
        let grid_max = origin + f64::from(count) * spacing;
        let scale = origin
            .abs()
            .max(grid_max.abs())
            .max(domain.bounds.min[grid_axis].abs())
            .max(domain.bounds.max[grid_axis].abs())
            .max(1.0);
        let tolerance = 32.0 * f64::EPSILON * scale;
        if (origin - domain.bounds.min[grid_axis]).abs() > tolerance
            || (grid_max - domain.bounds.max[grid_axis]).abs() > tolerance
        {
            return Err(ApiError::unprocessable(
                "planar_default_grid_invalid: structured FDM grid does not match domain bounds",
            ));
        }
    }

    let count = grid.shape[axis];
    let scaled = position_fraction * f64::from(count);
    let index = if scaled <= 0.0 {
        0
    } else {
        scaled.ceil() as u32 - 1
    }
    .min(count - 1);
    Ok(grid.origin[axis] + (f64::from(index) + 0.5) * grid.spacing[axis])
}
pub(crate) fn resolve_default_planar_source(
    domain: &DomainMeta,
    default_slice: &DefaultPlanarSliceState,
) -> Result<ResolvedPlanarSamplingSource, ApiError> {
    validate_default_slice(default_slice)?;
    let bounds = &domain.bounds;
    if bounds
        .min
        .iter()
        .chain(bounds.max.iter())
        .any(|value| !value.is_finite())
        || bounds
            .min
            .iter()
            .zip(bounds.max.iter())
            .any(|(min, max)| max <= min)
    {
        return Err(ApiError::unprocessable(
            "planar_default_domain_unavailable: domain bounds are missing or degenerate",
        ));
    }

    let lengths = [
        bounds.max[0] - bounds.min[0],
        bounds.max[1] - bounds.min[1],
        bounds.max[2] - bounds.min[2],
    ];
    let centers = [
        (bounds.min[0] + bounds.max[0]) * 0.5,
        (bounds.min[1] + bounds.max[1]) * 0.5,
        (bounds.min[2] + bounds.max[2]) * 0.5,
    ];
    let q = default_slice.position_fraction;
    let (origin_m, u_axis, v_axis, normal, preset, u_length, v_length) = match default_slice.plane {
        PlanarAxisPlane::Xy => (
            [
                centers[0],
                centers[1],
                default_slice_coordinate(domain, 2, q)?,
            ],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            PlanarFramePresetIR::Xy,
            lengths[0],
            lengths[1],
        ),
        PlanarAxisPlane::Xz => (
            [
                centers[0],
                default_slice_coordinate(domain, 1, q)?,
                centers[2],
            ],
            [1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.0, -1.0, 0.0],
            PlanarFramePresetIR::Xz,
            lengths[0],
            lengths[2],
        ),
        PlanarAxisPlane::Yz => (
            [
                default_slice_coordinate(domain, 0, q)?,
                centers[1],
                centers[2],
            ],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 0.0],
            PlanarFramePresetIR::Yz,
            lengths[1],
            lengths[2],
        ),
    };
    let frame = PlanarFrameIR {
        origin_m,
        u_axis,
        v_axis,
        normal,
        preset: Some(preset),
        normalization_version: PLANAR_FRAME_NORMALIZATION_VERSION.to_string(),
        extent: PlanarExtentIR::Explicit {
            u_min_m: -u_length * 0.5,
            u_max_m: u_length * 0.5,
            v_min_m: -v_length * 0.5,
            v_max_m: v_length * 0.5,
        },
    };
    let operator = default_operator_to_ir(&default_slice.operator);
    let source_hash = default_source_hash(domain, default_slice);
    let source_revision = source_revision(&source_hash);
    Ok(ResolvedPlanarSamplingSource {
        identity: ResolvedPlanarSourceIdentity {
            source_kind: "default".to_string(),
            source_id: None,
            source_hash,
            source_revision,
            domain_generation_id: domain.generation_id.clone(),
        },
        target: MonitorTargetIR::Domain,
        frame,
        operator,
    })
}

pub(crate) fn resolve_authored_planar_source(
    monitors: &[PlanarMonitorIR],
    monitor_id: &str,
) -> Result<ResolvedPlanarSamplingSource, ApiError> {
    if monitor_id.trim().is_empty() {
        return Err(ApiError::bad_request(
            "planar_source_monitor_not_found: monitor ID must not be empty",
        ));
    }
    let monitor = monitors
        .iter()
        .find(|monitor| monitor.id == monitor_id)
        .ok_or_else(|| {
            ApiError::not_found(format!(
                "planar_source_monitor_not_found: monitor '{monitor_id}' does not exist"
            ))
        })?;
    let source_hash = digest_json(monitor);
    Ok(ResolvedPlanarSamplingSource {
        identity: ResolvedPlanarSourceIdentity {
            source_kind: "monitor".to_string(),
            source_id: Some(monitor.id.clone()),
            source_revision: source_revision(&source_hash),
            source_hash,
            domain_generation_id: String::new(),
        },
        target: monitor.target.clone(),
        frame: monitor.frame.clone(),
        operator: monitor.operator.clone(),
    })
}

fn validate_default_slice(default_slice: &DefaultPlanarSliceState) -> Result<(), ApiError> {
    if !default_slice.position_fraction.is_finite()
        || !(0.0..=1.0).contains(&default_slice.position_fraction)
    {
        return Err(ApiError::bad_request(
            "invalid_planar_default_slice: position_fraction must be finite and between 0 and 1",
        ));
    }
    if let DefaultPlanarOperatorState::SlabAverage { thickness_m } = &default_slice.operator {
        if !thickness_m.is_finite() || *thickness_m <= 0.0 {
            return Err(ApiError::bad_request(
                "invalid_planar_default_slice: slab thickness must be finite and positive",
            ));
        }
    }
    Ok(())
}

fn default_operator_to_ir(operator: &DefaultPlanarOperatorState) -> PlanarOperatorIR {
    match operator {
        DefaultPlanarOperatorState::PlaneSample => PlanarOperatorIR::PlaneSample,
        DefaultPlanarOperatorState::SlabAverage { thickness_m } => PlanarOperatorIR::SlabAverage {
            thickness_m: *thickness_m,
        },
    }
}

fn default_source_hash(domain: &DomainMeta, default_slice: &DefaultPlanarSliceState) -> String {
    digest_json(&(
        domain.generation_id.as_str(),
        &domain.bounds,
        &domain.grid,
        default_slice,
    ))
}

fn digest_json<T: Serialize>(value: &T) -> String {
    let bytes = serde_json::to_vec(value).expect("planar source identity is serializable");
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn source_revision(source_hash: &str) -> u64 {
    let digest = Sha256::digest(source_hash.as_bytes());
    u64::from_be_bytes(
        digest[..8]
            .try_into()
            .expect("sha256 has eight-byte prefix"),
    )
    .max(1)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use fullmag_ir::{MonitorTargetIR, PlanarExtentIR, PlanarFrameIR, PlanarOperatorIR};

    use crate::schemas::domain::{Bounds3, DomainCounts, DomainMeta, StructuredGridDescriptor};
    use crate::schemas::visualization_state::{
        DefaultPlanarOperatorState, DefaultPlanarSliceState, PlanarAxisPlane,
    };

    use super::{resolve_authored_planar_source, resolve_default_planar_source};

    fn domain(min: [f64; 3], max: [f64; 3], generation_id: &str) -> DomainMeta {
        DomainMeta {
            domain_id: "current".into(),
            discretization: "fdm".into(),
            generation_id: generation_id.into(),
            dimension: 3,
            coordinate_system: "cartesian".into(),
            units: HashMap::from([(String::from("length"), String::from("m"))]),
            bounds: Bounds3 { min, max },
            counts: DomainCounts {
                cells: Some(1),
                nodes: None,
                elements: None,
                boundary_faces: None,
            },
            grid: None,
            element_type: None,
        }
    }

    fn slice(
        plane: PlanarAxisPlane,
        position_fraction: f64,
        operator: DefaultPlanarOperatorState,
    ) -> DefaultPlanarSliceState {
        DefaultPlanarSliceState {
            plane,
            position_fraction,
            operator,
        }
    }

    fn cross(u: [f64; 3], v: [f64; 3]) -> [f64; 3] {
        [
            u[1] * v[2] - u[2] * v[1],
            u[2] * v[0] - u[0] * v[2],
            u[0] * v[1] - u[1] * v[0],
        ]
    }

    #[test]
    fn default_fdm_even_midplane_snaps_to_lower_cell_center() {
        let mut d = domain([-1.0; 3], [1.0; 3], "generation-a");
        d.grid = Some(StructuredGridDescriptor {
            shape: [2, 2, 2],
            origin: [-1.0; 3],
            spacing: [1.0; 3],
        });

        let resolved = resolve_default_planar_source(
            &d,
            &slice(
                PlanarAxisPlane::Xy,
                0.5,
                DefaultPlanarOperatorState::PlaneSample,
            ),
        )
        .expect("valid structured FDM domain should resolve");

        assert_eq!(resolved.frame.origin_m[2], -0.5);
    }

    #[test]
    fn default_xy_midpoint_resolves_from_offset_domain_bounds() {
        let resolved = resolve_default_planar_source(
            &domain([10.0, 20.0, 30.0], [12.0, 22.0, 40.0], "generation-a"),
            &slice(
                PlanarAxisPlane::Xy,
                0.5,
                DefaultPlanarOperatorState::PlaneSample,
            ),
        )
        .expect("offset domain should resolve");

        assert_eq!(resolved.target, MonitorTargetIR::Domain);
        assert_eq!(resolved.frame.origin_m, [11.0, 21.0, 35.0]);
        assert_eq!(resolved.frame.u_axis, [1.0, 0.0, 0.0]);
        assert_eq!(resolved.frame.v_axis, [0.0, 1.0, 0.0]);
        assert_eq!(resolved.frame.normal, [0.0, 0.0, 1.0]);
    }

    #[test]
    fn default_xz_and_yz_frames_are_right_handed() {
        let d = domain([-2.0, 3.0, 5.0], [4.0, 9.0, 11.0], "generation-a");
        let xz = resolve_default_planar_source(
            &d,
            &slice(
                PlanarAxisPlane::Xz,
                0.5,
                DefaultPlanarOperatorState::PlaneSample,
            ),
        )
        .unwrap();
        let yz = resolve_default_planar_source(
            &d,
            &slice(
                PlanarAxisPlane::Yz,
                0.5,
                DefaultPlanarOperatorState::PlaneSample,
            ),
        )
        .unwrap();
        assert_eq!(cross(xz.frame.u_axis, xz.frame.v_axis), xz.frame.normal);
        assert_eq!(cross(yz.frame.u_axis, yz.frame.v_axis), yz.frame.normal);
    }

    #[test]
    fn default_position_fraction_resolves_to_physical_coordinate() {
        let d = domain([10.0, 20.0, 30.0], [12.0, 24.0, 50.0], "generation-a");
        for (q, expected) in [(0.0, 30.0), (0.5, 40.0), (1.0, 50.0)] {
            let resolved = resolve_default_planar_source(
                &d,
                &slice(
                    PlanarAxisPlane::Xy,
                    q,
                    DefaultPlanarOperatorState::PlaneSample,
                ),
            )
            .unwrap();
            assert_eq!(resolved.frame.origin_m[2], expected);
        }
    }

    #[test]
    fn default_extent_covers_complete_domain_aabb() {
        let d = domain([10.0, 20.0, 30.0], [14.0, 26.0, 42.0], "generation-a");
        let xy = resolve_default_planar_source(
            &d,
            &slice(
                PlanarAxisPlane::Xy,
                0.5,
                DefaultPlanarOperatorState::PlaneSample,
            ),
        )
        .unwrap();
        let xz = resolve_default_planar_source(
            &d,
            &slice(
                PlanarAxisPlane::Xz,
                0.5,
                DefaultPlanarOperatorState::PlaneSample,
            ),
        )
        .unwrap();
        let yz = resolve_default_planar_source(
            &d,
            &slice(
                PlanarAxisPlane::Yz,
                0.5,
                DefaultPlanarOperatorState::PlaneSample,
            ),
        )
        .unwrap();
        assert_eq!(
            xy.frame.extent,
            PlanarExtentIR::Explicit {
                u_min_m: -2.0,
                u_max_m: 2.0,
                v_min_m: -3.0,
                v_max_m: 3.0,
            }
        );
        assert_eq!(
            xz.frame.extent,
            PlanarExtentIR::Explicit {
                u_min_m: -2.0,
                u_max_m: 2.0,
                v_min_m: -6.0,
                v_max_m: 6.0,
            }
        );
        assert_eq!(
            yz.frame.extent,
            PlanarExtentIR::Explicit {
                u_min_m: -3.0,
                u_max_m: 3.0,
                v_min_m: -6.0,
                v_max_m: 6.0,
            }
        );
    }

    #[test]
    fn default_slab_uses_existing_measure_weighted_operator() {
        let resolved = resolve_default_planar_source(
            &domain([0.0; 3], [1.0; 3], "generation-a"),
            &slice(
                PlanarAxisPlane::Xy,
                0.5,
                DefaultPlanarOperatorState::SlabAverage { thickness_m: 0.25 },
            ),
        )
        .unwrap();
        assert_eq!(
            resolved.operator,
            PlanarOperatorIR::SlabAverage { thickness_m: 0.25 }
        );
    }

    #[test]
    fn default_source_does_not_require_scene_planar_monitor() {
        let resolved = resolve_default_planar_source(
            &domain([0.0; 3], [1.0; 3], "generation-a"),
            &slice(
                PlanarAxisPlane::Xy,
                0.5,
                DefaultPlanarOperatorState::PlaneSample,
            ),
        )
        .unwrap();
        assert_eq!(resolved.target, MonitorTargetIR::Domain);
        assert_eq!(resolved.identity.source_kind, "default");
    }

    #[test]
    fn authored_monitor_resolution_is_unchanged() {
        let monitor = fullmag_ir::PlanarMonitorIR {
            id: "monitor-1".into(),
            name: "Authored".into(),
            target: MonitorTargetIR::Domain,
            frame: PlanarFrameIR::axis_preset(
                fullmag_ir::PlanarFramePresetIR::Xy,
                0.5,
                PlanarExtentIR::Explicit {
                    u_min_m: -1.0,
                    u_max_m: 1.0,
                    v_min_m: -2.0,
                    v_max_m: 2.0,
                },
            ),
            operator: PlanarOperatorIR::PlaneSample,
        };
        let resolved = resolve_authored_planar_source(&[monitor.clone()], "monitor-1").unwrap();
        assert_eq!(resolved.target, monitor.target);
        assert_eq!(resolved.frame, monitor.frame);
        assert_eq!(resolved.operator, monitor.operator);
        assert_eq!(resolved.identity.source_kind, "monitor");
        assert_eq!(resolved.identity.source_id.as_deref(), Some("monitor-1"));
    }

    #[test]
    fn missing_authored_monitor_fails_with_stable_reason_code() {
        let error = resolve_authored_planar_source(&[], "missing").unwrap_err();
        assert_eq!(error.status, axum::http::StatusCode::NOT_FOUND);
        assert!(error
            .message
            .starts_with("planar_source_monitor_not_found:"));
    }

    #[test]
    fn default_source_hash_changes_for_plane_position_and_operator() {
        let d = domain([0.0; 3], [2.0, 4.0, 6.0], "generation-a");
        let base = resolve_default_planar_source(
            &d,
            &slice(
                PlanarAxisPlane::Xy,
                0.5,
                DefaultPlanarOperatorState::PlaneSample,
            ),
        )
        .unwrap();
        let plane = resolve_default_planar_source(
            &d,
            &slice(
                PlanarAxisPlane::Xz,
                0.5,
                DefaultPlanarOperatorState::PlaneSample,
            ),
        )
        .unwrap();
        let position = resolve_default_planar_source(
            &d,
            &slice(
                PlanarAxisPlane::Xy,
                0.25,
                DefaultPlanarOperatorState::PlaneSample,
            ),
        )
        .unwrap();
        let operator = resolve_default_planar_source(
            &d,
            &slice(
                PlanarAxisPlane::Xy,
                0.5,
                DefaultPlanarOperatorState::SlabAverage { thickness_m: 0.2 },
            ),
        )
        .unwrap();
        assert_ne!(base.identity.source_hash, plane.identity.source_hash);
        assert_ne!(base.identity.source_hash, position.identity.source_hash);
        assert_ne!(base.identity.source_hash, operator.identity.source_hash);
    }

    #[test]
    fn default_source_identity_changes_when_domain_generation_changes() {
        let slice = slice(
            PlanarAxisPlane::Xy,
            0.5,
            DefaultPlanarOperatorState::PlaneSample,
        );
        let a = resolve_default_planar_source(&domain([0.0; 3], [1.0; 3], "generation-a"), &slice)
            .unwrap();
        let b = resolve_default_planar_source(&domain([0.0; 3], [1.0; 3], "generation-b"), &slice)
            .unwrap();
        assert_ne!(a.identity.source_hash, b.identity.source_hash);
        assert_ne!(a.identity.source_revision, b.identity.source_revision);
    }

    #[test]
    fn default_fdm_slice_snaps_all_planes_and_boundary_fractions() {
        let mut d = domain([10.0, 20.0, 30.0], [14.0, 32.0, 54.0], "generation-a");
        d.grid = Some(StructuredGridDescriptor {
            shape: [2, 3, 4],
            origin: [10.0, 20.0, 30.0],
            spacing: [2.0, 4.0, 6.0],
        });
        let cases = [
            (PlanarAxisPlane::Xy, 0.0, 2, 33.0),
            (PlanarAxisPlane::Xy, 0.5, 2, 39.0),
            (PlanarAxisPlane::Xy, 1.0, 2, 51.0),
            (PlanarAxisPlane::Xz, 0.0, 1, 22.0),
            (PlanarAxisPlane::Xz, 0.5, 1, 26.0),
            (PlanarAxisPlane::Xz, 1.0, 1, 30.0),
            (PlanarAxisPlane::Yz, 0.0, 0, 11.0),
            (PlanarAxisPlane::Yz, 0.5, 0, 11.0),
            (PlanarAxisPlane::Yz, 1.0, 0, 13.0),
        ];

        for (plane, position, axis, expected) in cases {
            let resolved = resolve_default_planar_source(
                &d,
                &slice(plane, position, DefaultPlanarOperatorState::PlaneSample),
            )
            .unwrap();
            assert_eq!(
                resolved.frame.origin_m[axis], expected,
                "{plane:?} q={position}"
            );
        }
    }

    #[test]
    fn default_fdm_slice_rejects_invalid_or_mismatched_grid() {
        let mut invalid = domain([0.0; 3], [2.0; 3], "generation-a");
        invalid.grid = Some(StructuredGridDescriptor {
            shape: [2, 2, 2],
            origin: [0.0; 3],
            spacing: [1.0, 0.0, 1.0],
        });
        let error = resolve_default_planar_source(
            &invalid,
            &slice(
                PlanarAxisPlane::Xy,
                0.5,
                DefaultPlanarOperatorState::PlaneSample,
            ),
        )
        .unwrap_err();
        assert_eq!(error.status, axum::http::StatusCode::UNPROCESSABLE_ENTITY);
        assert!(error.message.starts_with("planar_default_grid_invalid:"));

        invalid.grid.as_mut().unwrap().spacing = [1.0; 3];
        invalid.grid.as_mut().unwrap().origin[0] = 0.25;
        let error = resolve_default_planar_source(
            &invalid,
            &slice(
                PlanarAxisPlane::Xy,
                0.5,
                DefaultPlanarOperatorState::PlaneSample,
            ),
        )
        .unwrap_err();
        assert!(error.message.starts_with("planar_default_grid_invalid:"));
    }

    #[test]
    fn default_source_identity_changes_when_structured_grid_changes() {
        let mut coarse = domain([0.0; 3], [2.0; 3], "generation-a");
        coarse.grid = Some(StructuredGridDescriptor {
            shape: [2, 2, 2],
            origin: [0.0; 3],
            spacing: [1.0; 3],
        });
        let mut fine = domain([0.0; 3], [2.0; 3], "generation-a");
        fine.grid = Some(StructuredGridDescriptor {
            shape: [4, 4, 4],
            origin: [0.0; 3],
            spacing: [0.5; 3],
        });
        let request = slice(
            PlanarAxisPlane::Xy,
            0.5,
            DefaultPlanarOperatorState::PlaneSample,
        );
        let coarse = resolve_default_planar_source(&coarse, &request).unwrap();
        let fine = resolve_default_planar_source(&fine, &request).unwrap();
        assert_ne!(coarse.identity.source_hash, fine.identity.source_hash);
        assert_ne!(
            coarse.identity.source_revision,
            fine.identity.source_revision
        );
    }
}
