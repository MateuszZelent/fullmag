use crate::error::ApiError;
use fullmag_ir::{PlanarFrameIR, PlanarOperatorIR};

pub(crate) const PLANAR_SAMPLER_VERSION: &str = "planar_sampling_v1";
pub(crate) const MAX_PLANAR_SAMPLE_POINTS: u32 = 1_048_576;

#[derive(Debug, Clone)]
pub(crate) struct ResolvedPlanarSampleRequest {
    pub monitor_id: String,
    pub monitor_hash: String,
    pub frame: PlanarFrameIR,
    pub operator: PlanarOperatorIR,
    pub resolution: [u32; 2],
    pub component: PlanarComponent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PlanarComponent {
    Scalar,
    Magnitude,
    MagnitudeSquared,
    WorldX,
    WorldY,
    WorldZ,
    AbsWorldX,
    AbsWorldY,
    AbsWorldZ,
    MonitorU,
    MonitorV,
    MonitorNormal,
    InPlaneMagnitude,
    Orientation,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum PlanarCompatibilityReduction {
    WeightedSum,
    SampleSum { normal_step: f64 },
    Stddev,
}

impl ResolvedPlanarSampleRequest {
    pub(crate) fn validate(&self) -> Result<(), ApiError> {
        let [width, height] = self.resolution;
        if width == 0 || height == 0 {
            return Err(ApiError::bad_request(
                "invalid_planar_resolution: width and height must be positive",
            ));
        }
        if width.saturating_mul(height) > MAX_PLANAR_SAMPLE_POINTS {
            return Err(ApiError::bad_request(
                "invalid_planar_resolution: width*height exceeds 1048576",
            ));
        }
        crate::planar_sampling::frame::ResolvedFrame::try_from_ir(&self.frame)?;
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub(crate) enum Occupancy {
    Occupied = 0,
    Empty = 1,
    Partial = 2,
    UndefinedOrientation = 3,
    OverlapAmbiguous = 4,
}

#[derive(Debug, Clone)]
pub(crate) struct PlanarSampleMeta {
    pub sampler_version: &'static str,
    pub sampling_method: &'static str,
    pub monitor_id: String,
    pub monitor_hash: String,
    pub bounds_uv_m: [f64; 4],
    pub resolution: [u32; 2],
    pub occupied_count: u32,
    pub partial_count: u32,
    pub empty_count: u32,
    pub occupied_measure: f64,
    pub overlap_count: u32,
    pub fold_count: u32,
    pub non_injective: bool,
    pub basis_order: u8,
    pub integration_order: u8,
}

#[derive(Debug, Clone)]
pub(crate) struct PlanarSampleResult {
    pub meta: PlanarSampleMeta,
    pub scalar_values: Vec<f64>,
    pub vector_values: Option<Vec<[f64; 3]>>,
    pub occupancy: Vec<Occupancy>,
    pub source_entity_ids: Vec<Option<u32>>,
    pub overlay: Option<PlanarMeshOverlay>,
}

#[derive(Debug, Clone)]
pub(crate) struct PlanarMeshOverlay {
    pub frame_origin_m: [f64; 3],
    pub frame_u_axis: [f64; 3],
    pub frame_v_axis: [f64; 3],
    pub frame_normal: [f64; 3],
    pub bounds_uv_m: [f64; 4],
    pub polygons: Vec<PlanarOverlayPolygon>,
    pub segments: Vec<PlanarOverlaySegment>,
}

#[derive(Debug, Clone)]
pub(crate) struct PlanarOverlayPolygon {
    pub vertices_uv_m: Vec<[f64; 2]>,
    pub parent_element_id: u32,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct PlanarOverlaySegment {
    pub a_uv_m: [f64; 2],
    pub b_uv_m: [f64; 2],
    pub kind: PlanarOverlaySegmentKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub(crate) enum PlanarOverlaySegmentKind {
    MeshInterior = 0,
    TargetBoundary = 1,
    UnclassifiedDegenerate = 2,
}

#[derive(Debug, Clone)]
pub(crate) struct FdmPlanarField {
    n_comp: usize,
    grid: [u32; 3],
    origin_m: [f64; 3],
    spacing_m: [f64; 3],
    values: Vec<f64>,
    membership_mask: Option<Vec<bool>>,
}

impl FdmPlanarField {
    pub(crate) fn new(
        n_comp: usize,
        grid: [u32; 3],
        origin_m: [f64; 3],
        spacing_m: [f64; 3],
        values: Vec<f64>,
    ) -> Result<Self, ApiError> {
        let point_count = grid
            .iter()
            .try_fold(1usize, |acc, value| acc.checked_mul(*value as usize))
            .ok_or_else(|| ApiError::bad_request("invalid_fdm_field: grid size overflow"))?;
        if n_comp == 0
            || grid.contains(&0)
            || origin_m.iter().any(|value| !value.is_finite())
            || spacing_m
                .iter()
                .any(|value| !value.is_finite() || *value <= 0.0)
            || values.len() != point_count.saturating_mul(n_comp)
        {
            return Err(ApiError::bad_request(
                "invalid_fdm_field: inconsistent grid, coordinates, or values",
            ));
        }
        Ok(Self {
            n_comp,
            grid,
            origin_m,
            spacing_m,
            values,
            membership_mask: None,
        })
    }

    pub(crate) fn with_membership_mask(
        mut self,
        membership_mask: Vec<bool>,
    ) -> Result<Self, ApiError> {
        let point_count = self
            .grid
            .iter()
            .try_fold(1usize, |acc, value| acc.checked_mul(*value as usize))
            .ok_or_else(|| ApiError::bad_request("invalid_fdm_field: grid size overflow"))?;
        if membership_mask.len() != point_count {
            return Err(ApiError::bad_request(
                "invalid_fdm_membership: mask length does not match grid",
            ));
        }
        self.membership_mask = Some(membership_mask);
        Ok(self)
    }

    pub(super) fn n_comp(&self) -> usize {
        self.n_comp
    }
    pub(super) fn grid(&self) -> [u32; 3] {
        self.grid
    }
    pub(super) fn origin(&self) -> [f64; 3] {
        self.origin_m
    }
    pub(super) fn spacing(&self) -> [f64; 3] {
        self.spacing_m
    }
    pub(super) fn values(&self) -> &[f64] {
        &self.values
    }
    pub(super) fn contains_cell(&self, cell: usize) -> bool {
        self.membership_mask
            .as_ref()
            .is_none_or(|membership| membership[cell])
    }
}

#[derive(Debug, Clone)]
pub(crate) struct FemPlanarField {
    n_comp: usize,
    nodes: Vec<[f64; 3]>,
    elements: Vec<[u32; 4]>,
    element_markers: Vec<u32>,
    values: Vec<f64>,
}

impl FemPlanarField {
    pub(crate) fn new(
        n_comp: usize,
        nodes: Vec<[f64; 3]>,
        elements: Vec<[u32; 4]>,
        element_markers: Vec<u32>,
        values: Vec<f64>,
    ) -> Result<Self, ApiError> {
        if n_comp == 0
            || nodes.is_empty()
            || elements.is_empty()
            || nodes.iter().flatten().any(|value| !value.is_finite())
            || values.len() != nodes.len().saturating_mul(n_comp)
            || elements
                .iter()
                .flatten()
                .any(|index| *index as usize >= nodes.len())
        {
            return Err(ApiError::bad_request(
                "invalid_fem_field: inconsistent topology, coordinates, or values",
            ));
        }
        Ok(Self {
            n_comp,
            nodes,
            elements,
            element_markers,
            values,
        })
    }

    pub(crate) fn nodes(&self) -> &[[f64; 3]] {
        &self.nodes
    }
    pub(super) fn n_comp(&self) -> usize {
        self.n_comp
    }
    pub(super) fn elements(&self) -> &[[u32; 4]] {
        &self.elements
    }
    pub(super) fn markers(&self) -> &[u32] {
        &self.element_markers
    }
    pub(super) fn values(&self) -> &[f64] {
        &self.values
    }

    #[cfg(test)]
    pub(crate) fn refine_uniform_p1(&self) -> Self {
        let mut nodes = self.nodes.clone();
        let mut values = self.values.clone();
        let mut elements = Vec::with_capacity(self.elements.len() * 4);
        let mut markers = Vec::with_capacity(self.elements.len() * 4);
        for (element_index, element) in self.elements.iter().enumerate() {
            let centroid = (0..3)
                .map(|axis| {
                    element
                        .iter()
                        .map(|node| self.nodes[*node as usize][axis])
                        .sum::<f64>()
                        / 4.0
                })
                .collect::<Vec<_>>();
            let centroid_id = nodes.len() as u32;
            nodes.push([centroid[0], centroid[1], centroid[2]]);
            for component in 0..self.n_comp {
                values.push(
                    element
                        .iter()
                        .map(|node| self.values[*node as usize * self.n_comp + component])
                        .sum::<f64>()
                        / 4.0,
                );
            }
            let [a, b, c, d] = *element;
            elements.extend([
                [centroid_id, b, c, d],
                [a, centroid_id, c, d],
                [a, b, centroid_id, d],
                [a, b, c, centroid_id],
            ]);
            markers.extend(
                [self.element_markers
                    .get(element_index)
                    .copied()
                    .unwrap_or(1); 4],
            );
        }
        Self {
            n_comp: self.n_comp,
            nodes,
            elements,
            element_markers: markers,
            values,
        }
    }
}

pub(crate) struct PlanarSamplingEngine;

impl PlanarSamplingEngine {
    pub(crate) fn sample_fdm(
        field: &FdmPlanarField,
        request: &ResolvedPlanarSampleRequest,
    ) -> Result<PlanarSampleResult, ApiError> {
        request.validate()?;
        let mut result = crate::planar_sampling::fdm::sample(field, request)?;
        apply_component(&mut result, request)?;
        Ok(result)
    }

    pub(crate) fn sample_fem(
        field: &FemPlanarField,
        request: &ResolvedPlanarSampleRequest,
    ) -> Result<PlanarSampleResult, ApiError> {
        request.validate()?;
        let mut result = crate::planar_sampling::fem::sample(field, request)?;
        result.overlay = Some(crate::planar_sampling::fem::build_overlay(
            field,
            &crate::planar_sampling::frame::ResolvedFrame::try_from_ir(&request.frame)?,
        ));
        apply_component(&mut result, request)?;
        Ok(result)
    }

    pub(crate) fn sample_fem_compatibility_depth(
        field: &FemPlanarField,
        request: &ResolvedPlanarSampleRequest,
        reduction: PlanarCompatibilityReduction,
    ) -> Result<PlanarSampleResult, ApiError> {
        request.validate()?;
        let mut result =
            crate::planar_sampling::fem::sample_compatibility_depth(field, request, reduction)?;
        apply_component(&mut result, request)?;
        Ok(result)
    }

    pub(crate) fn sample_fdm_compatibility_depth(
        field: &FdmPlanarField,
        request: &ResolvedPlanarSampleRequest,
        reduction: PlanarCompatibilityReduction,
        include_air_as_zero: bool,
    ) -> Result<PlanarSampleResult, ApiError> {
        request.validate()?;
        let mut result = crate::planar_sampling::fdm::sample_compatibility_depth(
            field,
            request,
            reduction,
            include_air_as_zero,
        )?;
        apply_component(&mut result, request)?;
        Ok(result)
    }
}

fn apply_component(
    result: &mut PlanarSampleResult,
    request: &ResolvedPlanarSampleRequest,
) -> Result<(), ApiError> {
    if request.component == PlanarComponent::Scalar {
        if result.vector_values.is_some() {
            return Err(ApiError::bad_request(
                "invalid_planar_component: scalar requires a scalar quantity",
            ));
        }
        return Ok(());
    }
    let vectors = result.vector_values.as_ref().ok_or_else(|| {
        ApiError::bad_request("invalid_planar_component: vector component requires a vector field")
    })?;
    let orientation_epsilon = vectors
        .iter()
        .map(|vector| dot(*vector, *vector).sqrt())
        .fold(0.0_f64, f64::max)
        * 1.0e-12;
    result.scalar_values = vectors
        .iter()
        .zip(&mut result.occupancy)
        .map(|(vector, occupancy)| {
            if *occupancy == Occupancy::Empty {
                return f64::NAN;
            }
            match request.component {
                PlanarComponent::Scalar => unreachable!(),
                PlanarComponent::Magnitude => dot(*vector, *vector).sqrt(),
                PlanarComponent::MagnitudeSquared => dot(*vector, *vector),
                PlanarComponent::WorldX => vector[0],
                PlanarComponent::WorldY => vector[1],
                PlanarComponent::WorldZ => vector[2],
                PlanarComponent::AbsWorldX => vector[0].abs(),
                PlanarComponent::AbsWorldY => vector[1].abs(),
                PlanarComponent::AbsWorldZ => vector[2].abs(),
                PlanarComponent::MonitorU => dot(*vector, request.frame.u_axis),
                PlanarComponent::MonitorV => dot(*vector, request.frame.v_axis),
                PlanarComponent::MonitorNormal => dot(*vector, request.frame.normal),
                PlanarComponent::InPlaneMagnitude => {
                    let u = dot(*vector, request.frame.u_axis);
                    let v = dot(*vector, request.frame.v_axis);
                    (u * u + v * v).sqrt()
                }
                PlanarComponent::Orientation => {
                    let norm = dot(*vector, *vector).sqrt();
                    if norm <= orientation_epsilon {
                        *occupancy = Occupancy::UndefinedOrientation;
                        f64::NAN
                    } else {
                        let u = dot(*vector, request.frame.u_axis);
                        let v = dot(*vector, request.frame.v_axis);
                        v.atan2(u).rem_euclid(std::f64::consts::TAU) / std::f64::consts::TAU
                    }
                }
            }
        })
        .collect();
    Ok(())
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
