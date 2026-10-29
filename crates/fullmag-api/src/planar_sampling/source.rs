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

use super::FemSectionExtent;

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
    /// Requested and resolved position along the normal; only for `Default`.
    pub section: Option<ResolvedPlanarSection>,
}

/// Fraction of the normal extent moved by one navigation step on sections
/// without discrete data layers.
pub(crate) const CONTINUOUS_SECTION_STEP_FRACTION: f64 = 0.01;

/// Node planes of a swept FEM mesh along one world axis, taken from the
/// accepted mixed-layer topology certificate. On these planes the nodal P1
/// field is exact, which makes them the FEM analogue of FDM cell layers.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct FemNodePlaneStops {
    pub axis: usize,
    pub coordinates_m: Vec<f64>,
    pub tolerance_m: f64,
}

impl FemNodePlaneStops {
    /// Collect certificate node planes (v1 global sweep or v2 per-region
    /// sweeps sharing one direction), sorted and de-duplicated.
    pub(crate) fn from_build_report(report: &fullmag_ir::FemSharedDomainBuildReportIR) -> Option<Self> {
        let mut sweeps: Vec<(&str, &[f64], f64)> = Vec::new();
        if let Some(certificate) = report.mixed_layer_topology_certificate.as_ref() {
            sweeps.push((
                certificate.resolved_sweep_direction.as_str(),
                &certificate.magnetic_plane_coordinates_m,
                certificate.plane_tolerance_m,
            ));
        }
        if let Some(certificate) = report.mixed_layer_topology_certificate_v2.as_ref() {
            for region in &certificate.magnetic_regions {
                if let Some(sweep) = region.exact_sweep.as_ref() {
                    sweeps.push((
                        sweep.sweep_direction_resolved.as_str(),
                        &sweep.magnetic_plane_coordinates_m,
                        sweep.plane_tolerance_m,
                    ));
                }
            }
        }
        let axis_of = |direction: &str| match direction.trim_start_matches(['+', '-']) {
            "x" => Some(0),
            "y" => Some(1),
            "z" => Some(2),
            _ => None,
        };
        let axis = axis_of(sweeps.first()?.0)?;
        if sweeps.iter().any(|(direction, _, _)| axis_of(direction) != Some(axis)) {
            return None;
        }
        let tolerance_m = sweeps
            .iter()
            .map(|(_, _, tolerance)| *tolerance)
            .fold(0.0_f64, f64::max);
        let mut coordinates_m = sweeps
            .iter()
            .flat_map(|(_, planes, _)| planes.iter().copied())
            .filter(|value| value.is_finite())
            .collect::<Vec<_>>();
        coordinates_m.sort_by(f64::total_cmp);
        coordinates_m.dedup_by(|a, b| (*a - *b).abs() <= tolerance_m);
        (coordinates_m.len() >= 2).then_some(Self {
            axis,
            coordinates_m,
            tolerance_m,
        })
    }
}

/// Requested vs. resolved section of the session `Default` slice. Decision 8
/// of the 2D refactor: a snap to an FDM cell centre is never hidden.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ResolvedPlanarSection {
    pub plane: &'static str,
    pub normal_axis: &'static str,
    pub requested_fraction: f64,
    pub requested_coordinate_m: f64,
    pub resolved_coordinate_m: f64,
    /// `fdm_cell_layers`, `fem_node_planes`, `fem_node_planes_between` or `continuous`.
    pub stops_kind: &'static str,
    pub layer_index: Option<u32>,
    pub layer_count: Option<u32>,
    pub layer_spacing_m: Option<f64>,
    pub normal_min_m: f64,
    pub normal_max_m: f64,
    /// Distance moved by one layer step (FDM cell) or navigation step (continuous).
    pub navigation_step_m: f64,
    /// `fdm_cell`, `fem_node_plane_spacing`, `median_element_height`
    /// (`eq-planar-navigation-step`) or `extent_fraction`.
    pub navigation_step_kind: &'static str,
    /// Target elements cut by the sampled FEM plane, when known.
    pub cut_element_count: Option<u32>,
    /// Discrete stops along the normal (FEM certificate node planes).
    pub layer_stops_m: Vec<f64>,
}

impl ResolvedPlanarSection {
    /// A continuous FEM section navigates by the median normal extent of the
    /// elements its plane cuts; discrete FDM layers and node planes keep their
    /// own spacing.
    pub(crate) fn with_fem_section_extent(mut self, extent: Option<FemSectionExtent>) -> Self {
        let Some(extent) = extent else {
            return self;
        };
        self.cut_element_count = Some(extent.cut_element_count);
        if self.stops_kind == "continuous"
            && extent.normal_extent_median_m.is_finite()
            && extent.normal_extent_median_m > 0.0
        {
            self.navigation_step_m = extent.normal_extent_median_m;
            self.navigation_step_kind = "median_element_height";
        }
        self
    }
}

struct SliceCoordinate {
    requested: f64,
    resolved: f64,
    /// (index, count, spacing) of the FDM cell layer that contains the request.
    layer: Option<(u32, u32, f64)>,
}

fn default_slice_coordinate(
    domain: &DomainMeta,
    axis: usize,
    position_fraction: f64,
) -> Result<SliceCoordinate, ApiError> {
    let continuous = domain.bounds.min[axis]
        + position_fraction * (domain.bounds.max[axis] - domain.bounds.min[axis]);
    let continuous_result = SliceCoordinate {
        requested: continuous,
        resolved: continuous,
        layer: None,
    };
    if domain.discretization != "fdm" {
        return Ok(continuous_result);
    }
    let Some(grid) = domain.grid.as_ref() else {
        return Ok(continuous_result);
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
        let grid_extent = f64::from(count) * spacing;
        let grid_max = origin + grid_extent;
        if !grid_extent.is_finite() || !grid_max.is_finite() {
            return Err(ApiError::unprocessable(
                "planar_default_grid_invalid: structured FDM grid extent must be finite",
            ));
        }
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
    let coordinate = grid.origin[axis] + (f64::from(index) + 0.5) * grid.spacing[axis];
    if !coordinate.is_finite() {
        return Err(ApiError::unprocessable(
            "planar_default_grid_invalid: structured FDM cell center must be finite",
        ));
    }
    Ok(SliceCoordinate {
        requested: continuous,
        resolved: coordinate,
        layer: Some((index, count, grid.spacing[axis])),
    })
}

/// Snap a continuous FEM request to the nearest certificate node plane when it
/// lies within the certificate tolerance (or within half a plane spacing when
/// the request came from a layer index, which always lands on a plane).
fn snap_to_node_plane(
    coordinate: SliceCoordinate,
    stops: &FemNodePlaneStops,
) -> (SliceCoordinate, Option<(u32, u32)>) {
    let Some((index, plane)) = stops
        .coordinates_m
        .iter()
        .copied()
        .enumerate()
        .min_by(|(_, a), (_, b)| {
            (a - coordinate.requested)
                .abs()
                .total_cmp(&(b - coordinate.requested).abs())
        })
    else {
        return (coordinate, None);
    };
    let window = stops.tolerance_m.max(
        1.0e-9 * (stops.coordinates_m[stops.coordinates_m.len() - 1] - stops.coordinates_m[0]).abs(),
    );
    if (plane - coordinate.requested).abs() > window {
        return (coordinate, None);
    }
    (
        SliceCoordinate {
            requested: coordinate.requested,
            resolved: plane,
            layer: None,
        },
        Some((index as u32, stops.coordinates_m.len() as u32)),
    )
}

fn resolved_section(
    domain: &DomainMeta,
    plane: &'static str,
    axis: usize,
    position_fraction: f64,
    coordinate: &SliceCoordinate,
    node_planes: Option<(&FemNodePlaneStops, Option<(u32, u32)>)>,
) -> ResolvedPlanarSection {
    let normal_min_m = domain.bounds.min[axis];
    let normal_max_m = domain.bounds.max[axis];
    if let Some((stops, snapped)) = node_planes {
        let spacing = (stops.coordinates_m[stops.coordinates_m.len() - 1] - stops.coordinates_m[0])
            / (stops.coordinates_m.len() - 1) as f64;
        return ResolvedPlanarSection {
            plane,
            normal_axis: ["x", "y", "z"][axis],
            requested_fraction: position_fraction,
            requested_coordinate_m: coordinate.requested,
            resolved_coordinate_m: coordinate.resolved,
            stops_kind: if snapped.is_some() {
                "fem_node_planes"
            } else {
                "fem_node_planes_between"
            },
            layer_index: snapped.map(|(index, _)| index),
            layer_count: Some(stops.coordinates_m.len() as u32),
            layer_spacing_m: Some(spacing),
            normal_min_m,
            normal_max_m,
            navigation_step_m: spacing,
            navigation_step_kind: "fem_node_plane_spacing",
            cut_element_count: None,
            layer_stops_m: stops.coordinates_m.clone(),
        };
    }
    let (layer_index, layer_count, layer_spacing_m) = match coordinate.layer {
        Some((index, count, spacing)) => (Some(index), Some(count), Some(spacing)),
        None => (None, None, None),
    };
    ResolvedPlanarSection {
        plane,
        normal_axis: ["x", "y", "z"][axis],
        requested_fraction: position_fraction,
        requested_coordinate_m: coordinate.requested,
        resolved_coordinate_m: coordinate.resolved,
        stops_kind: if coordinate.layer.is_some() {
            "fdm_cell_layers"
        } else {
            "continuous"
        },
        layer_index,
        layer_count,
        layer_spacing_m,
        normal_min_m,
        normal_max_m,
        navigation_step_m: layer_spacing_m
            .unwrap_or((normal_max_m - normal_min_m) * CONTINUOUS_SECTION_STEP_FRACTION),
        navigation_step_kind: if layer_spacing_m.is_some() {
            "fdm_cell"
        } else {
            "extent_fraction"
        },
        cut_element_count: None,
        layer_stops_m: Vec::new(),
    }
}
#[cfg(test)]
pub(crate) fn resolve_default_planar_source(
    domain: &DomainMeta,
    default_slice: &DefaultPlanarSliceState,
) -> Result<ResolvedPlanarSamplingSource, ApiError> {
    resolve_default_planar_source_with_stops(domain, default_slice, None)
}

/// `Default` source resolution with optional FEM node-plane stops of a swept
/// mesh. When the slice normal is the sweep axis, the published section lists
/// the node planes and a request within tolerance samples exactly on a plane.
pub(crate) fn resolve_default_planar_source_with_stops(
    domain: &DomainMeta,
    default_slice: &DefaultPlanarSliceState,
    fem_stops: Option<&FemNodePlaneStops>,
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
    let (plane_name, normal_axis) = match default_slice.plane {
        PlanarAxisPlane::Xy => ("xy", 2),
        PlanarAxisPlane::Xz => ("xz", 1),
        PlanarAxisPlane::Yz => ("yz", 0),
    };
    let mut coordinate = default_slice_coordinate(domain, normal_axis, q)?;
    // A slab is centred where it was requested: snapping its centre to a cell
    // or node plane would shift an object-thickness slab into its neighbours.
    let slab = matches!(
        default_slice.operator,
        DefaultPlanarOperatorState::SlabAverage { .. }
    );
    if slab {
        coordinate.resolved = coordinate.requested;
        coordinate.layer = None;
    }
    let node_planes = match fem_stops {
        Some(stops) if !slab && stops.axis == normal_axis && coordinate.layer.is_none() => {
            let (snapped, layer) = snap_to_node_plane(coordinate, stops);
            coordinate = snapped;
            Some((stops, layer))
        }
        _ => None,
    };
    let section = resolved_section(domain, plane_name, normal_axis, q, &coordinate, node_planes);
    let (origin_m, u_axis, v_axis, normal, preset, u_length, v_length) = match default_slice.plane {
        PlanarAxisPlane::Xy => (
            [centers[0], centers[1], coordinate.resolved],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            PlanarFramePresetIR::Xy,
            lengths[0],
            lengths[1],
        ),
        PlanarAxisPlane::Xz => (
            [centers[0], coordinate.resolved, centers[2]],
            [1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.0, -1.0, 0.0],
            PlanarFramePresetIR::Xz,
            lengths[0],
            lengths[2],
        ),
        PlanarAxisPlane::Yz => (
            [coordinate.resolved, centers[1], centers[2]],
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
        section: Some(section),
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
        section: None,
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

    use super::{
        resolve_authored_planar_source, resolve_default_planar_source,
        resolve_default_planar_source_with_stops, FemNodePlaneStops, FemSectionExtent,
    };

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
    fn default_section_publishes_requested_and_resolved_fdm_layer() {
        let mut d = domain([0.0; 3], [8.0, 4.0, 60e-9], "generation-section");
        d.grid = Some(StructuredGridDescriptor {
            shape: [8, 4, 8],
            origin: [0.0; 3],
            spacing: [1.0, 1.0, 7.5e-9],
        });

        let resolved = resolve_default_planar_source(
            &d,
            &slice(PlanarAxisPlane::Xy, 0.4, DefaultPlanarOperatorState::PlaneSample),
        )
        .expect("default source");
        let section = resolved.section.expect("default source publishes its section");

        assert_eq!(section.normal_axis, "z");
        assert_eq!(section.stops_kind, "fdm_cell_layers");
        assert_eq!(section.layer_index, Some(3));
        assert_eq!(section.layer_count, Some(8));
        assert!((section.requested_coordinate_m - 24e-9).abs() < 1e-21);
        assert!((section.resolved_coordinate_m - 26.25e-9).abs() < 1e-21);
        assert_eq!(resolved.frame.origin_m[2], section.resolved_coordinate_m);
        assert_eq!(section.navigation_step_m, 7.5e-9);
    }

    #[test]
    fn default_section_snaps_fem_requests_to_certificate_node_planes() {
        let mut d = domain([0.0; 3], [1.0, 1.0, 20e-9], "generation-swept");
        d.discretization = "fem".into();
        let stops = FemNodePlaneStops {
            axis: 2,
            coordinates_m: vec![0.0, 5e-9, 10e-9, 15e-9, 20e-9],
            tolerance_m: 1e-12,
        };
        // Fraction of node plane 2 as the Control Room computes it.
        let on_plane = resolve_default_planar_source_with_stops(
            &d,
            &slice(PlanarAxisPlane::Xy, 0.5, DefaultPlanarOperatorState::PlaneSample),
            Some(&stops),
        )
        .expect("default source");
        let section = on_plane.section.expect("section");
        assert_eq!(section.stops_kind, "fem_node_planes");
        assert_eq!(section.layer_index, Some(2));
        assert_eq!(section.layer_count, Some(5));
        assert_eq!(section.resolved_coordinate_m, 10e-9);
        assert_eq!(on_plane.frame.origin_m[2], 10e-9);
        assert_eq!(section.layer_stops_m.len(), 5);

        let between = resolve_default_planar_source_with_stops(
            &d,
            &slice(PlanarAxisPlane::Xy, 0.6, DefaultPlanarOperatorState::PlaneSample),
            Some(&stops),
        )
        .expect("default source")
        .section
        .expect("section");
        assert_eq!(between.stops_kind, "fem_node_planes_between");
        assert_eq!(between.layer_index, None);
        assert_eq!(between.requested_coordinate_m, between.resolved_coordinate_m);

        // A plane whose normal is not the sweep axis stays continuous.
        let xz = resolve_default_planar_source_with_stops(
            &d,
            &slice(PlanarAxisPlane::Xz, 0.5, DefaultPlanarOperatorState::PlaneSample),
            Some(&stops),
        )
        .expect("default source")
        .section
        .expect("section");
        assert_eq!(xz.stops_kind, "continuous");
    }

    #[test]
    fn default_section_is_continuous_without_a_structured_grid() {
        let mut d = domain([0.0; 3], [1.0, 1.0, 20e-9], "generation-fem");
        d.discretization = "fem".into();

        let section = resolve_default_planar_source(
            &d,
            &slice(PlanarAxisPlane::Xy, 0.62, DefaultPlanarOperatorState::PlaneSample),
        )
        .expect("default source")
        .section
        .expect("section");

        assert_eq!(section.stops_kind, "continuous");
        assert_eq!(section.layer_index, None);
        assert_eq!(section.requested_coordinate_m, section.resolved_coordinate_m);
        assert!((section.navigation_step_m - 0.2e-9).abs() < 1e-24);
        assert_eq!(section.navigation_step_kind, "extent_fraction");

        // A sampled continuous FEM plane navigates by the median cut extent.
        let navigated = section.clone().with_fem_section_extent(Some(FemSectionExtent {
            cut_element_count: 12,
            normal_extent_median_m: 3.0e-9,
        }));
        assert_eq!(navigated.navigation_step_m, 3.0e-9);
        assert_eq!(navigated.navigation_step_kind, "median_element_height");
        assert_eq!(navigated.cut_element_count, Some(12));
        assert_eq!(section.clone().with_fem_section_extent(None), section);
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
    fn default_fdm_slab_is_centred_at_the_requested_coordinate() {
        let mut d = domain([0.0; 3], [1.0, 1.0, 8.0], "generation-a");
        d.grid = Some(StructuredGridDescriptor {
            shape: [1, 1, 8],
            origin: [0.0; 3],
            spacing: [1.0; 3],
        });
        // z = 2.0 is a cell boundary; a plane sample snaps to the cell centre
        // 1.5, a two-cell object slab must stay centred on 2.0.
        let resolved = resolve_default_planar_source(
            &d,
            &slice(
                PlanarAxisPlane::Xy,
                0.25,
                DefaultPlanarOperatorState::SlabAverage { thickness_m: 2.0 },
            ),
        )
        .unwrap();
        assert_eq!(resolved.frame.origin_m[2], 2.0);
        let section = resolved.section.expect("section");
        assert_eq!(section.layer_index, None);
        assert_eq!(section.resolved_coordinate_m, 2.0);
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
    fn default_fdm_slice_rejects_overflowing_grid_extent() {
        let mut invalid = domain([0.0; 3], [f64::MAX; 3], "generation-a");
        invalid.grid = Some(StructuredGridDescriptor {
            shape: [2, 2, 2],
            origin: [0.0; 3],
            spacing: [f64::MAX; 3],
        });

        let error = resolve_default_planar_source(
            &invalid,
            &slice(
                PlanarAxisPlane::Xy,
                1.0,
                DefaultPlanarOperatorState::PlaneSample,
            ),
        )
        .expect_err("overflowing structured grid extent must be rejected");

        assert_eq!(error.status, axum::http::StatusCode::UNPROCESSABLE_ENTITY);
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
