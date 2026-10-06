use crate::waveguide_mesh::WaveguideCrossSectionMeshIR;
use crate::{
    AdaptiveRefinementIR, BiasFieldSweepIR, DynamicsIR, EigenDampingPolicyIR, EigenNormalizationIR,
    EigenOperatorConfigIR, EigenTargetIR, EquilibriumSourceIR, FieldOrientationIR, FieldScheduleIR,
    FieldUnitProvenanceIR, FieldWindowIR, FrequencyExcitationIR, FrequencyResponseNormalizationIR,
    FrequencyResponseSolverPolicyIR, FrequencySweepIR, HysteresisAngularFamilyIR,
    HysteresisStorageIR, KSamplingIR, MagnetostaticBoundaryConditionIR, MeasurementAxisIR,
    MinorLoopIR, ModeTrackingIR, RegionRefIR, RelaxStopIR, RelaxationAlgorithmIR, SamplingIR,
    SaturationProbeIR, SettlePipelineIR, SpinWaveBoundaryConditionIR, WaveguideFrameIR,
};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::error::Error;
use std::fmt;

/// Requested V04 spatial representation. Typed parsing preserves intent but
/// does not establish runtime availability, invariance, equilibrium, or admission.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SpatialRepresentationIR {
    #[serde(rename = "full_3d")]
    Full3d,
    #[serde(rename = "waveguide_2p5d")]
    Waveguide2p5d {
        frame: WaveguideFrameIR,
        cross_section_mesh: WaveguideCrossSectionMeshIR,
        region_targets: BTreeMap<String, RegionRefIR>,
        magnetostatic_bc: WaveguideMagnetostaticBoundaryConditionIR,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum WaveguideMagnetostaticBoundaryConditionIR {
    FiniteAirCrossSectionDirichlet { boundary_component_ids: Vec<String> },
}

impl WaveguideMagnetostaticBoundaryConditionIR {
    pub fn boundary_component_ids(&self) -> &[String] {
        match self {
            Self::FiniteAirCrossSectionDirichlet {
                boundary_component_ids,
            } => boundary_component_ids,
        }
    }
}

fn deserialize_non_null_magnetostatic_bc<'de, D>(
    deserializer: D,
) -> Result<Option<MagnetostaticBoundaryConditionIR>, D::Error>
where
    D: Deserializer<'de>,
{
    MagnetostaticBoundaryConditionIR::deserialize(deserializer).map(Some)
}

/// Typed opt-in V04 staging study wire. The public ProblemIR remains V03.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum StudyIRV04 {
    TimeEvolution {
        dynamics: DynamicsIR,
        sampling: SamplingIR,
        spatial_representation: SpatialRepresentationIR,
    },
    Relaxation {
        algorithm: RelaxationAlgorithmIR,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        dynamics: Option<DynamicsIR>,
        stop: RelaxStopIR,
        sampling: SamplingIR,
        spatial_representation: SpatialRepresentationIR,
    },
    Eigenmodes {
        dynamics: DynamicsIR,
        operator: EigenOperatorConfigIR,
        count: u32,
        target: EigenTargetIR,
        equilibrium: EquilibriumSourceIR,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        k_sampling: Option<KSamplingIR>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bias_field_sweep: Option<BiasFieldSweepIR>,
        normalization: EigenNormalizationIR,
        damping_policy: EigenDampingPolicyIR,
        #[serde(default)]
        spin_wave_bc: SpinWaveBoundaryConditionIR,
        #[serde(
            default,
            deserialize_with = "deserialize_non_null_magnetostatic_bc",
            skip_serializing_if = "Option::is_none"
        )]
        magnetostatic_bc: Option<MagnetostaticBoundaryConditionIR>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mode_tracking: Option<ModeTrackingIR>,
        sampling: SamplingIR,
        spatial_representation: SpatialRepresentationIR,
    },
    FrequencyResponse {
        dynamics: DynamicsIR,
        operator: EigenOperatorConfigIR,
        equilibrium: EquilibriumSourceIR,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        k_sampling: Option<KSamplingIR>,
        normalization: FrequencyResponseNormalizationIR,
        damping_policy: EigenDampingPolicyIR,
        #[serde(default)]
        spin_wave_bc: SpinWaveBoundaryConditionIR,
        #[serde(
            default,
            deserialize_with = "deserialize_non_null_magnetostatic_bc",
            skip_serializing_if = "Option::is_none"
        )]
        magnetostatic_bc: Option<MagnetostaticBoundaryConditionIR>,
        excitation: FrequencyExcitationIR,
        frequencies_hz: FrequencySweepIR,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        solver_policy: Option<FrequencyResponseSolverPolicyIR>,
        sampling: SamplingIR,
        spatial_representation: SpatialRepresentationIR,
    },
    Hysteresis {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        field_min_mT: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        field_max_mT: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        field_step_mT: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        field_values_mT: Option<Vec<f64>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        field_unit_provenance: Option<FieldUnitProvenanceIR>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        direction: Option<[f64; 3]>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        orientation: Option<FieldOrientationIR>,
        #[serde(default = "crate::study::default_measurement_axis")]
        measurement_axis: MeasurementAxisIR,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        angular_family: Option<HysteresisAngularFamilyIR>,
        #[serde(default = "crate::study::default_initial_protocol")]
        initial_protocol: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        initial_state_ref: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        saturation: Option<SaturationProbeIR>,
        #[serde(default = "crate::study::default_branch_mode")]
        branch_mode: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        settle_pipeline: Option<SettlePipelineIR>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        storage: Option<HysteresisStorageIR>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        field_schedule: Option<FieldScheduleIR>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        schedule_refinements: Option<Vec<FieldWindowIR>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        adaptive_refinement: Option<AdaptiveRefinementIR>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        minor_loops: Option<Vec<MinorLoopIR>>,
        sampling: SamplingIR,
        spatial_representation: SpatialRepresentationIR,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StudyIRV04ExecutionRepresentation {
    /// Full 3D can be handed to the existing legacy staging route only.
    Full3dLegacyStaging,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StudyIRV04ExecutionAvailabilityError {
    Waveguide2p5dUnavailable,
}

impl fmt::Display for StudyIRV04ExecutionAvailabilityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Waveguide2p5dUnavailable => formatter.write_str("waveguide_2p5d_unavailable"),
        }
    }
}

impl Error for StudyIRV04ExecutionAvailabilityError {}

impl StudyIRV04 {
    pub fn spatial_representation(&self) -> &SpatialRepresentationIR {
        match self {
            Self::TimeEvolution {
                spatial_representation,
                ..
            }
            | Self::Relaxation {
                spatial_representation,
                ..
            }
            | Self::Eigenmodes {
                spatial_representation,
                ..
            }
            | Self::FrequencyResponse {
                spatial_representation,
                ..
            }
            | Self::Hysteresis {
                spatial_representation,
                ..
            } => spatial_representation,
        }
    }

    /// Reports the staging route for full 3D and refuses unavailable waveguide execution.
    /// This is an availability guard, not production admission or a provider certificate.
    pub fn checked_execution_representation_availability(
        &self,
    ) -> Result<StudyIRV04ExecutionRepresentation, StudyIRV04ExecutionAvailabilityError> {
        match self.spatial_representation() {
            SpatialRepresentationIR::Full3d => {
                Ok(StudyIRV04ExecutionRepresentation::Full3dLegacyStaging)
            }
            SpatialRepresentationIR::Waveguide2p5d { .. } => {
                Err(StudyIRV04ExecutionAvailabilityError::Waveguide2p5dUnavailable)
            }
        }
    }

    pub fn validate(&self) -> Result<(), Vec<String>> {
        let errors = self.validation_errors();
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }

    pub(crate) fn validation_errors(&self) -> Vec<String> {
        let mut errors = Vec::new();
        let is_waveguide = matches!(
            self.spatial_representation(),
            SpatialRepresentationIR::Waveguide2p5d { .. }
        );

        if is_waveguide && !matches!(self, Self::Eigenmodes { .. }) {
            errors.push(
                "study.spatial_representation.waveguide_2p5d is supported only for eigenmodes"
                    .to_string(),
            );
        }

        let spectral_boundary = match self {
            Self::Eigenmodes {
                magnetostatic_bc, ..
            }
            | Self::FrequencyResponse {
                magnetostatic_bc, ..
            } => Some(magnetostatic_bc),
            _ => None,
        };
        if let Some(boundary) = spectral_boundary {
            if is_waveguide {
                if boundary.is_some() {
                    errors.push(
                        "study.magnetostatic_bc must be absent for waveguide_2p5d".to_string(),
                    );
                }
            } else if boundary.is_none() {
                errors.push(
                    "study.magnetostatic_bc is required for full_3d spectral studies".to_string(),
                );
            }
        }

        let spectral_k_sampling = match self {
            Self::Eigenmodes { k_sampling, .. } => {
                k_sampling.as_ref().map(|sampling| ("eigenmodes", sampling))
            }
            Self::FrequencyResponse { k_sampling, .. } => k_sampling
                .as_ref()
                .map(|sampling| ("frequency_response", sampling)),
            _ => None,
        };
        if let Some((prefix, sampling)) = spectral_k_sampling {
            errors.extend(sampling.validation_errors(&format!("{prefix}.k_sampling")));
        }
        errors
    }
}

pub(crate) fn validate_waveguide_k_sampling(
    study: &StudyIRV04,
    frame: &crate::ValidatedWaveguideFrameIR,
) -> Vec<String> {
    let (prefix, sampling) = match study {
        StudyIRV04::Eigenmodes {
            k_sampling: Some(sampling),
            ..
        } => ("eigenmodes.k_sampling", sampling),
        StudyIRV04::FrequencyResponse {
            k_sampling: Some(sampling),
            ..
        } => ("frequency_response.k_sampling", sampling),
        _ => return Vec::new(),
    };
    let mut errors = Vec::new();
    let mut validate_vector = |label: String, vector: [f64; 3]| {
        if let Err(error) = frame.project_global_k(vector) {
            errors.push(format!("{label}: {error}"));
        }
    };
    match sampling {
        KSamplingIR::Single { k_vector } => {
            validate_vector(format!("{prefix}.k_vector"), *k_vector);
        }
        KSamplingIR::Path { points, .. } => {
            for (index, point) in points.iter().enumerate() {
                validate_vector(
                    format!("{prefix}.path.points[{index}].k_vector"),
                    point.k_vector,
                );
            }
        }
    }
    errors
}

pub(crate) fn validate_v04_study_wire(value: &Value) -> Result<(), String> {
    let study_value = value
        .get("study")
        .ok_or_else(|| "/study: missing required study".to_string())?;
    let study = object_at(study_value, "/study")?;
    let kind = study
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| "/study/kind: expected a study kind string".to_string())?;
    let allowed_study_fields: &[&str] = match kind {
        "time_evolution" => &["kind", "dynamics", "sampling", "spatial_representation"],
        "relaxation" => &[
            "kind",
            "algorithm",
            "dynamics",
            "stop",
            "sampling",
            "spatial_representation",
        ],
        "eigenmodes" => &[
            "kind",
            "dynamics",
            "operator",
            "count",
            "target",
            "equilibrium",
            "k_sampling",
            "bias_field_sweep",
            "normalization",
            "damping_policy",
            "spin_wave_bc",
            "magnetostatic_bc",
            "mode_tracking",
            "sampling",
            "spatial_representation",
        ],
        "frequency_response" => &[
            "kind",
            "dynamics",
            "operator",
            "equilibrium",
            "k_sampling",
            "normalization",
            "damping_policy",
            "spin_wave_bc",
            "magnetostatic_bc",
            "excitation",
            "frequencies_hz",
            "solver_policy",
            "sampling",
            "spatial_representation",
        ],
        "hysteresis" => &[
            "kind",
            "field_min_mT",
            "field_max_mT",
            "field_step_mT",
            "field_values_mT",
            "field_unit_provenance",
            "direction",
            "orientation",
            "measurement_axis",
            "angular_family",
            "initial_protocol",
            "initial_state_ref",
            "saturation",
            "branch_mode",
            "settle_pipeline",
            "storage",
            "field_schedule",
            "schedule_refinements",
            "adaptive_refinement",
            "minor_loops",
            "sampling",
            "spatial_representation",
        ],
        _ => return Err(format!("/study/kind: unsupported study kind '{kind}'")),
    };
    reject_unknown_fields(study, "/study", allowed_study_fields)?;

    let spatial = required_non_null(study, "spatial_representation", "/study")?;
    let spatial_kind = validate_spatial_representation_wire(spatial)?;
    if spatial_kind == "waveguide_2p5d" && kind != "eigenmodes" {
        return Err(
            "/study/spatial_representation/kind: waveguide_2p5d is supported only for eigenmodes"
                .to_string(),
        );
    }

    if matches!(kind, "eigenmodes" | "frequency_response") {
        if spatial_kind == "waveguide_2p5d" {
            if study.contains_key("magnetostatic_bc") {
                return Err(
                    "/study/magnetostatic_bc: legacy top-level magnetostatic_bc must be absent for waveguide_2p5d"
                        .to_string(),
                );
            }
        } else {
            let value = required_non_null(study, "magnetostatic_bc", "/study")?;
            let boundary = value.as_str().ok_or_else(|| {
                "/study/magnetostatic_bc: expected a non-null boundary condition string".to_string()
            })?;
            if !matches!(boundary, "open" | "periodic_airbox_k0" | "floquet_airbox") {
                return Err(format!(
                    "/study/magnetostatic_bc: unsupported boundary condition '{boundary}'"
                ));
            }
        }
    }

    Ok(())
}

fn validate_spatial_representation_wire(value: &Value) -> Result<&'static str, String> {
    let pointer = "/study/spatial_representation";
    let representation = object_at(value, pointer)?;
    let kind = representation
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{pointer}/kind: expected a spatial representation kind string"))?;
    match kind {
        "full_3d" => {
            reject_unknown_fields(representation, pointer, &["kind"])?;
            Ok("full_3d")
        }
        "waveguide_2p5d" => {
            reject_unknown_fields(
                representation,
                pointer,
                &[
                    "kind",
                    "frame",
                    "cross_section_mesh",
                    "region_targets",
                    "magnetostatic_bc",
                ],
            )?;
            let frame = required_non_null(representation, "frame", pointer)?;
            let frame = object_at(frame, &format!("{pointer}/frame"))?;
            reject_unknown_fields(
                frame,
                &format!("{pointer}/frame"),
                &["origin_m", "e_u", "e_v", "axis_unit"],
            )?;
            for field in ["origin_m", "e_u", "e_v", "axis_unit"] {
                required_non_null(frame, field, &format!("{pointer}/frame"))?;
            }

            let mesh = required_non_null(representation, "cross_section_mesh", pointer)?;
            let mesh = object_at(mesh, &format!("{pointer}/cross_section_mesh"))?;
            let mesh_pointer = format!("{pointer}/cross_section_mesh");
            reject_unknown_fields(
                mesh,
                &mesh_pointer,
                &[
                    "schema",
                    "nodes_uv_m",
                    "triangles",
                    "edges",
                    "regions",
                    "boundary_components",
                ],
            )?;
            for field in [
                "schema",
                "nodes_uv_m",
                "triangles",
                "edges",
                "regions",
                "boundary_components",
            ] {
                required_non_null(mesh, field, &mesh_pointer)?;
            }
            validate_waveguide_mesh_unknown_fields(mesh, &mesh_pointer)?;

            let targets = required_non_null(representation, "region_targets", pointer)?;
            let targets = object_at(targets, &format!("{pointer}/region_targets"))?;
            let targets_pointer = format!("{pointer}/region_targets");
            for (mesh_region_id, target_value) in targets {
                let target_pointer =
                    format!("{targets_pointer}/{}", escape_pointer_token(mesh_region_id));
                let target = object_at(target_value, &target_pointer)?;
                reject_unknown_fields(target, &target_pointer, &["object_id", "region_id"])?;
                required_non_null(target, "object_id", &target_pointer)?;
            }

            let bc = required_non_null(representation, "magnetostatic_bc", pointer)?;
            let bc_pointer = format!("{pointer}/magnetostatic_bc");
            let bc = object_at(bc, &bc_pointer)?;
            reject_unknown_fields(bc, &bc_pointer, &["kind", "boundary_component_ids"])?;
            let bc_kind = bc
                .get("kind")
                .and_then(Value::as_str)
                .ok_or_else(|| format!("{bc_pointer}/kind: expected a boundary condition kind"))?;
            if bc_kind != "finite_air_cross_section_dirichlet" {
                return Err(format!(
                    "{bc_pointer}/kind: unsupported boundary condition kind '{bc_kind}'"
                ));
            }
            let ids = required_non_null(bc, "boundary_component_ids", &bc_pointer)?;
            let ids = ids
                .as_array()
                .ok_or_else(|| format!("{bc_pointer}/boundary_component_ids: expected an array"))?;
            for (index, id) in ids.iter().enumerate() {
                if !id.is_string() {
                    return Err(format!(
                        "{bc_pointer}/boundary_component_ids/{index}: expected a string"
                    ));
                }
            }
            Ok("waveguide_2p5d")
        }
        _ => Err(format!(
            "{pointer}/kind: unsupported spatial representation '{kind}'"
        )),
    }
}

fn validate_waveguide_mesh_unknown_fields(
    mesh: &Map<String, Value>,
    pointer: &str,
) -> Result<(), String> {
    if let Some(triangles) = mesh.get("triangles").and_then(Value::as_array) {
        for (index, triangle) in triangles.iter().enumerate() {
            let item_pointer = format!("{pointer}/triangles/{index}");
            if let Some(object) = triangle.as_object() {
                reject_unknown_fields(object, &item_pointer, &["nodes", "region_id"])?;
            }
        }
    }

    if let Some(edges) = mesh.get("edges").and_then(Value::as_array) {
        for (index, edge) in edges.iter().enumerate() {
            let item_pointer = format!("{pointer}/edges/{index}");
            let Some(edge) = edge.as_object() else {
                continue;
            };
            reject_unknown_fields(edge, &item_pointer, &["nodes", "incidences"])?;
            if let Some(incidences) = edge.get("incidences").and_then(Value::as_array) {
                for (incidence_index, incidence) in incidences.iter().enumerate() {
                    if let Some(incidence) = incidence.as_object() {
                        reject_unknown_fields(
                            incidence,
                            &format!("{item_pointer}/incidences/{incidence_index}"),
                            &["triangle_index", "local_edge_index"],
                        )?;
                    }
                }
            }
        }
    }

    if let Some(regions) = mesh.get("regions").and_then(Value::as_array) {
        for (index, region) in regions.iter().enumerate() {
            let item_pointer = format!("{pointer}/regions/{index}");
            let Some(region) = region.as_object() else {
                continue;
            };
            let allowed = match region.get("kind").and_then(Value::as_str) {
                Some("magnetic") => &["kind", "region_id", "object_id", "material_id"][..],
                Some("air") => &["kind", "region_id", "object_id"][..],
                _ => &["kind", "region_id", "object_id", "material_id"][..],
            };
            reject_unknown_fields(region, &item_pointer, allowed)?;
        }
    }

    if let Some(boundaries) = mesh.get("boundary_components").and_then(Value::as_array) {
        for (index, boundary) in boundaries.iter().enumerate() {
            let item_pointer = format!("{pointer}/boundary_components/{index}");
            let Some(boundary) = boundary.as_object() else {
                continue;
            };
            reject_unknown_fields(
                boundary,
                &item_pointer,
                &[
                    "boundary_component_id",
                    "region_id",
                    "loop_kind",
                    "half_edges",
                ],
            )?;
            if let Some(half_edges) = boundary.get("half_edges").and_then(Value::as_array) {
                for (half_edge_index, half_edge) in half_edges.iter().enumerate() {
                    if let Some(half_edge) = half_edge.as_object() {
                        reject_unknown_fields(
                            half_edge,
                            &format!("{item_pointer}/half_edges/{half_edge_index}"),
                            &["triangle_index", "local_edge_index"],
                        )?;
                    }
                }
            }
        }
    }
    Ok(())
}

fn object_at<'a>(value: &'a Value, pointer: &str) -> Result<&'a Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("{pointer}: expected an object"))
}

fn required_non_null<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    parent_pointer: &str,
) -> Result<&'a Value, String> {
    object
        .get(key)
        .filter(|value| !value.is_null())
        .ok_or_else(|| format!("{parent_pointer}/{key}: missing or null required field"))
}

fn reject_unknown_fields(
    object: &Map<String, Value>,
    pointer: &str,
    allowed: &[&str],
) -> Result<(), String> {
    for key in object.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(format!(
                "{pointer}/{}: unknown field",
                escape_pointer_token(key)
            ));
        }
    }
    Ok(())
}

fn escape_pointer_token(value: &str) -> String {
    value.replace('~', "~0").replace('/', "~1")
}
