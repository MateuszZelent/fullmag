use crate::{
    CurrentTransportModel, KnownSceneCurrentTransport, KnownSceneOerstedField,
    KnownSceneSpinTorque, PrescribedSotFormulaVersion, SceneChargeBoundary,
    SceneChargePotentialGauge, SceneDocument, SceneOerstedField, SceneOerstedTimeDependence,
    ScenePrescribedSotDrive, SceneReactionLength, SceneRegionRef, SceneSpinBoundary,
    SceneSpinInterface, SceneSpinTorque, SceneSpinTransport, SceneSpinTransportMode,
    SceneSurfaceRef, SceneTimeEnvelope, SceneTransportCoupling, SlonczewskiFormulaVersion,
    StudyPipelineDocument,
    StudyPipelineNode,
};
use fullmag_ir::{
    CouplingEndpointIR, CouplingIR, CouplingKindIR, CouplingParametersIR, DriveActivationIR,
    ExchangeCouplingModeIR, FieldSpatialProfileIR, FieldTargetIR, MaterialParameterAssignmentIR,
    MaterialParameterFieldIR, MaterialParameterNameIR, MaterialTransitionSpecIR, MonitorTargetIR,
    ObjectRegionIR, RegionFrameIR, RegionMeshPolicyIR, RegionShapeIR,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt::{Display, Formatter};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SceneDocumentValidationError {
    pub message: String,
}

impl SceneDocumentValidationError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl Display for SceneDocumentValidationError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for SceneDocumentValidationError {}

pub fn validate_scene_document(scene: &SceneDocument) -> Result<(), SceneDocumentValidationError> {
    if scene.version != "scene.v1" && scene.version != "scene.v2" {
        return Err(SceneDocumentValidationError::new(format!(
            "unsupported SceneDocument version '{}'",
            scene.version
        )));
    }
    if scene.version == "scene.v1" {
        validate_scene_v1_has_no_region_owned_payloads(scene)?;
    }
    if !matches!(
        scene.study.requested_mode.as_str(),
        "" | "strict" | "extended" | "hybrid"
    ) {
        return Err(SceneDocumentValidationError::new(format!(
            "study.requested_mode must be 'strict', 'extended', or 'hybrid'; got '{}'",
            scene.study.requested_mode
        )));
    }
    validate_solver_state(&scene.study.solver, false, "study.solver")?;
    for (index, stage) in scene.study.stages.iter().enumerate() {
        validate_stage_solver_state(stage, index)?;
    }

    let mut object_ids = BTreeSet::new();
    let mut material_ids = BTreeSet::new();
    let mut magnetization_ids = BTreeSet::new();

    for material in &scene.materials {
        if material.id.trim().is_empty() {
            return Err(SceneDocumentValidationError::new(
                "scene material ids must not be empty",
            ));
        }
        if !material_ids.insert(material.id.clone()) {
            return Err(SceneDocumentValidationError::new(format!(
                "duplicate scene material id '{}'",
                material.id
            )));
        }
    }

    for asset in &scene.magnetization_assets {
        if asset.id.trim().is_empty() {
            return Err(SceneDocumentValidationError::new(
                "magnetization asset ids must not be empty",
            ));
        }
        if !matches!(
            asset.kind.as_str(),
            "uniform" | "random" | "random_seeded" | "file" | "sampled" | "preset_texture"
        ) {
            return Err(SceneDocumentValidationError::new(format!(
                "unsupported magnetization asset kind '{}'",
                asset.kind
            )));
        }
        if !magnetization_ids.insert(asset.id.clone()) {
            return Err(SceneDocumentValidationError::new(format!(
                "duplicate magnetization asset id '{}'",
                asset.id
            )));
        }
    }

    for object in &scene.objects {
        if object.id.trim().is_empty() {
            return Err(SceneDocumentValidationError::new(
                "scene object ids must not be empty",
            ));
        }
        if !object_ids.insert(object.id.clone()) {
            return Err(SceneDocumentValidationError::new(format!(
                "duplicate scene object id '{}'",
                object.id
            )));
        }
        if let Some(mesh) = object.object_mesh.as_ref() {
            validate_requested_layered_mesh(
                &format!("object '{}'.object_mesh", object.id),
                mesh,
                scene.study.requested_mode != "extended",
            )?;
        }
        if let Some(mesh) = object.mesh_override.as_ref() {
            validate_requested_layered_mesh(
                &format!("object '{}'.mesh_override", object.id),
                mesh,
                scene.study.requested_mode != "extended",
            )?;
        }
        if object.role != "magnet" {
            continue;
        }
        if !material_ids.contains(&object.material_ref) {
            return Err(SceneDocumentValidationError::new(format!(
                "object '{}' references missing material '{}'",
                object.id, object.material_ref
            )));
        }
        let magnetization_ref = object
            .magnetization_ref
            .as_ref()
            .filter(|reference| !reference.trim().is_empty())
            .ok_or_else(|| {
                SceneDocumentValidationError::new(format!(
                    "object '{}' must reference a magnetization asset",
                    object.id
                ))
            })?;
        if !magnetization_ids.contains(magnetization_ref) {
            return Err(SceneDocumentValidationError::new(format!(
                "object '{}' references missing magnetization asset '{}'",
                object.id, magnetization_ref
            )));
        }
    }
    validate_region_owned_scene_payloads(scene, &object_ids)?;
    validate_spin_authoring(scene, &object_ids)?;

    if let Some(document) = &scene.study.study_pipeline {
        validate_study_pipeline_document(document)?;
    }
    validate_scene_field_drives(scene, &object_ids)?;
    validate_scene_planar_monitors(scene, &object_ids)?;

    Ok(())
}

fn validate_requested_layered_mesh(
    path: &str,
    mesh: &crate::ScriptBuilderPerGeometryMeshState,
    strict_mode: bool,
) -> Result<(), SceneDocumentValidationError> {
    if mesh
        .through_thickness_elements
        .is_some_and(|layers| layers < 1)
    {
        return Err(SceneDocumentValidationError::new(format!(
            "{path}.through_thickness_elements must be >= 1"
        )));
    }
    if let Some(topology) = mesh.topology.as_deref() {
        if !matches!(topology, "tetrahedral" | "prismatic") {
            return Err(SceneDocumentValidationError::new(format!(
                "{path}.topology must be 'tetrahedral' or 'prismatic'"
            )));
        }
    }
    if let Some(direction) = mesh.sweep_direction.as_deref() {
        if !matches!(direction, "auto" | "x" | "y" | "z") {
            return Err(SceneDocumentValidationError::new(format!(
                "{path}.sweep_direction must be 'auto', 'x', 'y', or 'z'"
            )));
        }
    }
    if let Some(family) = mesh.element_family.as_deref() {
        if !matches!(family, "prism" | "hex") {
            return Err(SceneDocumentValidationError::new(format!(
                "{path}.element_family must be 'prism' or 'hex'"
            )));
        }
    }
    if let Some(transition) = mesh.transition_policy.as_deref() {
        if !matches!(transition, "pyramid_to_tetrahedra" | "reject") {
            return Err(SceneDocumentValidationError::new(format!(
                "{path}.transition_policy must be 'pyramid_to_tetrahedra' or 'reject'"
            )));
        }
    }

    if let Some(strategy) = mesh.mesh_strategy.as_deref() {
        if !matches!(
            strategy,
            "auto" | "free_tetrahedral" | "thin_film_tetrahedral" | "swept_prism" | "swept_hex"
        ) {
            return Err(SceneDocumentValidationError::new(format!(
                "{path}.mesh_strategy is unsupported"
            )));
        }
    }
    if let Some(distribution) = mesh.through_thickness_distribution.as_deref() {
        if !matches!(distribution, "fixed" | "linear" | "exponential") {
            return Err(SceneDocumentValidationError::new(format!(
                "{path}.through_thickness_distribution is invalid"
            )));
        }
    }
    if let Some(face) = mesh.sweep_face_meshing.as_deref() {
        if !matches!(face, "triangular" | "quadrilateral") {
            return Err(SceneDocumentValidationError::new(format!(
                "{path}.sweep_face_meshing must be 'triangular' or 'quadrilateral'"
            )));
        }
    }

    if mesh.topology.as_deref() == Some("tetrahedral")
        && (mesh.sweep_direction.is_some()
            || mesh.element_family.is_some()
            || mesh.transition_policy.is_some()
            || mesh.exact_layer_count.is_some())
    {
        return Err(SceneDocumentValidationError::new(format!(
            "{path} tetrahedral topology contradicts swept element intent"
        )));
    }

    let prism_requested = mesh.topology.as_deref() == Some("prismatic")
        || mesh.element_family.as_deref() == Some("prism")
        || mesh.mesh_strategy.as_deref() == Some("swept_prism");
    if prism_requested {
        if mesh.order.is_some_and(|order| order != 1) {
            return Err(SceneDocumentValidationError::new(format!(
                "{path} prismatic mesh supports order=1 only"
            )));
        }
        if strict_mode && mesh.exact_layer_count == Some(false) {
            return Err(SceneDocumentValidationError::new(format!(
                "{path} strict prismatic mesh requires exact_layer_count=true"
            )));
        }
        if mesh
            .through_thickness_distribution
            .as_deref()
            .is_some_and(|distribution| distribution != "fixed")
        {
            return Err(SceneDocumentValidationError::new(format!(
                "{path} strict prismatic mesh requires fixed layer distribution"
            )));
        }
        if mesh
            .sweep_face_meshing
            .as_deref()
            .is_some_and(|face| face != "triangular")
        {
            return Err(SceneDocumentValidationError::new(format!(
                "{path} prismatic mesh requires triangular source faces"
            )));
        }
        if mesh
            .element_family
            .as_deref()
            .is_some_and(|family| family != "prism")
        {
            return Err(SceneDocumentValidationError::new(format!(
                "{path} prismatic topology contradicts non-prism element family"
            )));
        }
        if mesh.mesh_strategy.as_deref() != Some("swept_prism") {
            return Err(SceneDocumentValidationError::new(format!(
                "{path} prism element family requires mesh_strategy='swept_prism'"
            )));
        }
    }

    if mesh.topology.as_deref() == Some("prismatic")
        && mesh.transition_policy.as_deref() != Some("pyramid_to_tetrahedra")
    {
        return Err(SceneDocumentValidationError::new(format!(
            "{path} explicit prismatic topology requires pyramid_to_tetrahedra transition"
        )));
    }

    if mesh.element_family.as_deref() == Some("hex") {
        if mesh.mesh_strategy.as_deref() != Some("swept_hex") {
            return Err(SceneDocumentValidationError::new(format!(
                "{path} hex element family requires mesh_strategy='swept_hex'"
            )));
        }
        if mesh.sweep_face_meshing.as_deref() != Some("quadrilateral") {
            return Err(SceneDocumentValidationError::new(format!(
                "{path} hex element family requires quadrilateral source faces"
            )));
        }
        if mesh.transition_policy.as_deref() == Some("pyramid_to_tetrahedra") {
            return Err(SceneDocumentValidationError::new(format!(
                "{path} hex element family contradicts pyramid_to_tetrahedra transition"
            )));
        }
    }

    let layered_requested = matches!(
        mesh.mesh_strategy.as_deref(),
        Some("swept_prism" | "swept_hex")
    ) || mesh.topology.is_some()
        || mesh.sweep_direction.is_some()
        || mesh.element_family.is_some()
        || mesh.transition_policy.is_some()
        || mesh.exact_layer_count.is_some();
    if layered_requested {
        let missing = [
            (
                "through_thickness_elements",
                mesh.through_thickness_elements.is_none(),
            ),
            (
                "through_thickness_distribution",
                mesh.through_thickness_distribution.is_none(),
            ),
            ("sweep_face_meshing", mesh.sweep_face_meshing.is_none()),
            ("sweep_direction", mesh.sweep_direction.is_none()),
            ("element_family", mesh.element_family.is_none()),
            ("transition_policy", mesh.transition_policy.is_none()),
            ("exact_layer_count", mesh.exact_layer_count.is_none()),
        ]
        .into_iter()
        .filter_map(|(name, absent)| absent.then_some(name))
        .collect::<Vec<_>>();
        if !missing.is_empty() {
            return Err(SceneDocumentValidationError::new(format!(
                "{path} layered mesh intent is incomplete: {}",
                missing.join(", ")
            )));
        }
    }
    Ok(())
}

fn validate_scene_planar_monitors(
    scene: &SceneDocument,
    object_ids: &BTreeSet<String>,
) -> Result<(), SceneDocumentValidationError> {
    let region_ids = scene
        .objects
        .iter()
        .flat_map(|object| {
            object
                .regions
                .iter()
                .map(move |region| (object.id.as_str(), region.region_id.as_str()))
        })
        .collect::<BTreeSet<_>>();
    let mut ids = BTreeSet::new();
    let mut names = BTreeSet::new();

    for (index, monitor) in scene.monitors.planar.iter().enumerate() {
        if monitor.id.trim().is_empty() || !ids.insert(monitor.id.as_str()) {
            return Err(SceneDocumentValidationError::new(format!(
                "monitors.planar[{index}] id must be non-empty and unique"
            )));
        }
        if monitor.name.trim().is_empty() || !names.insert(monitor.name.as_str()) {
            return Err(SceneDocumentValidationError::new(format!(
                "monitors.planar[{index}] name must be non-empty and unique"
            )));
        }
        match &monitor.target {
            MonitorTargetIR::MagneticDomain | MonitorTargetIR::Domain => {}
            MonitorTargetIR::Object { object_id } => {
                if !object_ids.contains(object_id) {
                    return Err(SceneDocumentValidationError::new(format!(
                        "monitors.planar[{index}] target object '{object_id}' does not exist"
                    )));
                }
            }
            MonitorTargetIR::Region {
                object_id,
                region_id,
            } => {
                if !region_ids.contains(&(object_id.as_str(), region_id.as_str())) {
                    return Err(SceneDocumentValidationError::new(format!(
                        "monitors.planar[{index}] target region '{object_id}/{region_id}' does not exist"
                    )));
                }
            }
        }
    }
    Ok(())
}

fn validate_stage_solver_state(
    stage: &crate::ScriptBuilderStageState,
    index: usize,
) -> Result<(), SceneDocumentValidationError> {
    let context = format!("study.stages[{index}]");
    if !stage.fixed_timestep.trim().is_empty() && stage.adaptive_timestep.is_some() {
        return Err(SceneDocumentValidationError::new(format!(
            "{context} fixed and adaptive timestep policies are mutually exclusive"
        )));
    }
    let relax_algorithm = stage.relax_algorithm.trim();
    if stage.kind == "relax"
        && (relax_algorithm.is_empty() || relax_algorithm == "llg_overdamped")
        && stage.fixed_timestep.trim().is_empty()
        && stage.adaptive_timestep.is_none()
    {
        return Err(SceneDocumentValidationError::new(format!(
            "{context} LLG relaxation requires an explicit fixed or adaptive timestep policy"
        )));
    }
    validate_present_positive(&stage.fixed_timestep, &format!("{context}.fixed_timestep"))?;
    if let Some(adaptive) = stage.adaptive_timestep.as_ref() {
        validate_adaptive_state(adaptive, true, &context, &stage.integrator)?;
    }
    Ok(())
}

fn validate_solver_state(
    solver: &crate::ScriptBuilderSolverState,
    executable: bool,
    context: &str,
) -> Result<(), SceneDocumentValidationError> {
    let convenience = [
        &solver.dt_initial,
        &solver.dt_min,
        &solver.dt_max,
        &solver.max_err,
    ]
    .iter()
    .any(|value| !value.trim().is_empty());
    let active = usize::from(!solver.fixed_timestep.trim().is_empty())
        + usize::from(convenience)
        + usize::from(solver.adaptive_timestep.is_some());
    if active > 1 {
        return Err(SceneDocumentValidationError::new(format!(
            "{context} fixed, convenience-adaptive, and advanced-adaptive policies are mutually exclusive"
        )));
    }
    validate_present_positive(&solver.fixed_timestep, &format!("{context}.fixed_timestep"))?;
    validate_present_positive(
        &solver.demag_interval_s,
        &format!("{context}.demag_interval_s"),
    )?;
    if convenience {
        validate_adaptive_values(
            &solver.dt_initial,
            &solver.dt_min,
            &solver.dt_max,
            executable,
            context,
            &solver.integrator,
        )?;
        validate_required_positive(&solver.max_err, &format!("{context}.max_err"))?;
    }
    if let Some(adaptive) = solver.adaptive_timestep.as_ref() {
        validate_adaptive_state(adaptive, executable, context, &solver.integrator)?;
    }
    Ok(())
}

fn validate_adaptive_state(
    adaptive: &crate::ScriptBuilderAdaptiveTimestepState,
    executable: bool,
    context: &str,
    integrator: &str,
) -> Result<(), SceneDocumentValidationError> {
    validate_adaptive_values(
        &adaptive.dt_initial,
        &adaptive.dt_min,
        &adaptive.dt_max,
        executable,
        context,
        integrator,
    )?;
    let atol = parse_required_nonnegative(&adaptive.atol, &format!("{context}.atol"))?;
    let rtol = parse_required_nonnegative(&adaptive.rtol, &format!("{context}.rtol"))?;
    if atol == 0.0 && rtol == 0.0 {
        return Err(SceneDocumentValidationError::new(format!(
            "{context} requires at least one positive adaptive tolerance"
        )));
    }
    match adaptive.tolerance_mode.as_str() {
        "max_error" if rtol == 0.0 && atol > 0.0 => {}
        "advanced" => {
            let safety = parse_required_positive(&adaptive.safety, &format!("{context}.safety"))?;
            let growth = parse_required_positive(
                &adaptive.growth_limit,
                &format!("{context}.growth_limit"),
            )?;
            let shrink = parse_required_positive(
                &adaptive.shrink_limit,
                &format!("{context}.shrink_limit"),
            )?;
            if safety > 1.0 || growth <= 1.0 || shrink >= 1.0 {
                return Err(SceneDocumentValidationError::new(format!(
                    "{context} controller requires safety<=1, growth_limit>1, and shrink_limit<1"
                )));
            }
        }
        "max_error" => {
            return Err(SceneDocumentValidationError::new(format!(
                "{context} max_error mode requires atol>0 and rtol=0"
            )))
        }
        other => {
            return Err(SceneDocumentValidationError::new(format!(
                "{context} has unsupported tolerance_mode '{other}'"
            )))
        }
    }
    validate_present_positive(
        &adaptive.max_spin_rotation,
        &format!("{context}.max_spin_rotation"),
    )?;
    validate_present_positive(
        &adaptive.norm_tolerance,
        &format!("{context}.norm_tolerance"),
    )?;
    Ok(())
}

fn validate_adaptive_values(
    initial: &str,
    minimum: &str,
    maximum: &str,
    require_maximum: bool,
    context: &str,
    integrator: &str,
) -> Result<(), SceneDocumentValidationError> {
    if !matches!(integrator.trim(), "rk23" | "rk45") {
        return Err(SceneDocumentValidationError::new(format!(
            "{context} adaptive policy requires RK23 or RK45"
        )));
    }
    let minimum = parse_required_positive(minimum, &format!("{context}.dt_min"))?;
    let maximum = if maximum.trim().is_empty() && !require_maximum {
        None
    } else {
        Some(parse_required_positive(
            maximum,
            &format!("{context}.dt_max"),
        )?)
    };
    if maximum.is_some_and(|value| value < minimum) {
        return Err(SceneDocumentValidationError::new(format!(
            "{context}.dt_max must be greater than or equal to dt_min"
        )));
    }
    if !initial.trim().is_empty() {
        let initial = parse_required_positive(initial, &format!("{context}.dt_initial"))?;
        if initial < minimum || maximum.is_some_and(|value| initial > value) {
            return Err(SceneDocumentValidationError::new(format!(
                "{context}.dt_initial must lie within adaptive bounds"
            )));
        }
    }
    Ok(())
}

fn parse_required_positive(value: &str, name: &str) -> Result<f64, SceneDocumentValidationError> {
    let parsed = value.parse::<f64>().map_err(|_| {
        SceneDocumentValidationError::new(format!("{name} must be a finite positive number"))
    })?;
    if !parsed.is_finite() || parsed <= 0.0 {
        return Err(SceneDocumentValidationError::new(format!(
            "{name} must be a finite positive number"
        )));
    }
    Ok(parsed)
}

fn parse_required_nonnegative(
    value: &str,
    name: &str,
) -> Result<f64, SceneDocumentValidationError> {
    let parsed = value.parse::<f64>().map_err(|_| {
        SceneDocumentValidationError::new(format!("{name} must be finite and nonnegative"))
    })?;
    if !parsed.is_finite() || parsed < 0.0 {
        return Err(SceneDocumentValidationError::new(format!(
            "{name} must be finite and nonnegative"
        )));
    }
    Ok(parsed)
}

fn validate_required_positive(value: &str, name: &str) -> Result<(), SceneDocumentValidationError> {
    parse_required_positive(value, name).map(|_| ())
}

fn validate_present_positive(value: &str, name: &str) -> Result<(), SceneDocumentValidationError> {
    if value.trim().is_empty() {
        return Ok(());
    }
    validate_required_positive(value, name)
}

fn collect_stage_ids(nodes: &[StudyPipelineNode], ids: &mut BTreeSet<String>) {
    for node in nodes {
        match node {
            StudyPipelineNode::Primitive(node) => {
                ids.insert(node.id.clone());
            }
            StudyPipelineNode::Macro(node) => {
                ids.insert(node.id.clone());
            }
            StudyPipelineNode::Group(node) => {
                ids.insert(node.id.clone());
                collect_stage_ids(&node.children, ids);
            }
        }
    }
}


fn validate_scene_field_drives(
    scene: &SceneDocument,
    object_ids: &BTreeSet<String>,
) -> Result<(), SceneDocumentValidationError> {
    let mut drive_ids = BTreeSet::new();
    let mut stage_ids = BTreeSet::new();
    if let Some(pipeline) = &scene.study.study_pipeline {
        collect_stage_ids(&pipeline.nodes, &mut stage_ids);
    }

    for drive in &scene.field_drives.drives {
        if drive.id.trim().is_empty() || !drive_ids.insert(drive.id.clone()) {
            return Err(SceneDocumentValidationError::new(format!(
                "regional field drive id '{}' must be non-empty and unique",
                drive.id
            )));
        }
        if !drive.amplitude_b_t.is_finite() || drive.amplitude_b_t < 0.0 {
            return Err(SceneDocumentValidationError::new(format!(
                "regional field drive '{}' amplitude_B_T must be finite and >= 0",
                drive.id
            )));
        }
        let norm_sq: f64 = drive.direction.iter().map(|value| value * value).sum();
        if drive.direction.iter().any(|value| !value.is_finite())
            || (norm_sq.sqrt() - 1.0).abs() > 1e-12
        {
            return Err(SceneDocumentValidationError::new(format!(
                "regional field drive '{}' direction must be a normalized finite vector",
                drive.id
            )));
        }

        let require_object = |object_id: &str| {
            if object_ids.contains(object_id) {
                Ok(())
            } else {
                Err(SceneDocumentValidationError::new(format!(
                    "regional field drive '{}' references missing object '{}'",
                    drive.id, object_id
                )))
            }
        };
        match &drive.target {
            FieldTargetIR::Global {} => {}
            FieldTargetIR::Object { object_id } => require_object(object_id)?,
            FieldTargetIR::Region {
                object_id,
                region_id,
            } => {
                require_object(object_id)?;
                let object = scene
                    .objects
                    .iter()
                    .find(|object| object.id == *object_id)
                    .unwrap();
                let exists = object.allocated_region_ids.iter().any(|id| id == region_id)
                    || object
                        .regions
                        .iter()
                        .any(|region| region.region_id == *region_id);
                if !exists {
                    return Err(SceneDocumentValidationError::new(format!(
                        "regional field drive '{}' references missing region '{}' on object '{}'",
                        drive.id, region_id, object_id
                    )));
                }
            }
        }
        if let FieldSpatialProfileIR::GeometryMask { object_id, .. } = &drive.spatial_profile {
            require_object(object_id)?;
        }
        if let DriveActivationIR::StageIds {
            stage_ids: requested,
        } = &drive.activation
        {
            for stage_id in requested {
                if !stage_ids.contains(stage_id) {
                    return Err(SceneDocumentValidationError::new(format!(
                        "regional field drive '{}' references missing stage '{}'",
                        drive.id, stage_id
                    )));
                }
            }
        }
    }
    Ok(())
}


fn validate_spin_authoring(
    scene: &SceneDocument,
    object_ids: &BTreeSet<String>,
) -> Result<(), SceneDocumentValidationError> {
    let mut transport_ids = BTreeSet::new();
    let mut transport_contracts = BTreeMap::new();
    for (index, transport) in scene.current_transports.iter().enumerate() {
        let transport = transport.known().ok_or_else(|| {
            SceneDocumentValidationError::new(format!(
                "current_transports[{index}] uses an unsupported read-only variant"
            ))
        })?;
        validate_current_transport(index, transport, object_ids)?;
        if !transport_ids.insert(transport.name.clone()) {
            return Err(SceneDocumentValidationError::new(format!(
                "duplicate current transport id '{}'",
                transport.name
            )));
        }
        transport_contracts.insert(
            transport.name.clone(),
            (transport.model, transport.coupling),
        );
    }

    let mut spin_transport_ids = BTreeSet::new();
    for (index, module) in scene.spin_transports.iter().enumerate() {
        let module = match module {
            SceneSpinTransport::Known(module) => module,
            SceneSpinTransport::Unsupported(_) => {
                return Err(SceneDocumentValidationError::new(format!(
                    "spin_transports[{index}] uses an unsupported read-only variant"
                )))
            }
        };
        if module.id.trim().is_empty() || !spin_transport_ids.insert(module.id.clone()) {
            return Err(SceneDocumentValidationError::new(format!(
                "spin_transports[{index}] id must be non-empty and unique"
            )));
        }
        require_reference(
            &module.current_source_id,
            &transport_ids,
            &format!("spin_transports[{index}].current_source_id"),
        )?;
        let (source_model, source_coupling) = transport_contracts
            .get(&module.current_source_id)
            .copied()
            .expect("current source reference validated above");
        let reciprocal = source_model == CurrentTransportModel::MagnetoresistivePoisson
            || source_coupling == SceneTransportCoupling::Bidirectional;
        if reciprocal {
            if module.mode != SceneSpinTransportMode::Steady
                || module.constitutive_version != "transport_constitutive.reciprocal.fullmag.v1"
                || module.solver.operator_version != "fdm_coupled_charge_spin_fv_block_gmres.v1"
            {
                return Err(SceneDocumentValidationError::new(format!(
                    "spin_transports[{index}] reciprocal M2 requires steady mode, reciprocal constitutive_version, and fdm_coupled_charge_spin_fv_block_gmres.v1"
                )));
            }
            let nonlinear = module.solver.reciprocal_nonlinear.as_ref().ok_or_else(|| {
                SceneDocumentValidationError::new(format!(
                    "spin_transports[{index}] reciprocal M2 requires reciprocal_nonlinear solver policy"
                ))
            })?;
            if nonlinear.gmres_restart == 0
                || nonlinear.max_picard_iterations == 0
                || !nonlinear.relative_update_tolerance.is_finite()
                || nonlinear.relative_update_tolerance <= 0.0
                || !nonlinear.eta_transport.is_finite()
                || nonlinear.eta_transport <= 0.0
                || nonlinear.eta_transport > 1.0
            {
                return Err(SceneDocumentValidationError::new(format!(
                    "spin_transports[{index}].solver.reciprocal_nonlinear has invalid GMRES/Picard/tolerance parameters"
                )));
            }
        } else if module.solver.reciprocal_nonlinear.is_some()
            || module.constitutive_version == "transport_constitutive.reciprocal.fullmag.v1"
        {
            return Err(SceneDocumentValidationError::new(format!(
                "spin_transports[{index}] reciprocal_nonlinear/reciprocal constitutive_version requires bidirectional current transport"
            )));
        }
        if module.domain.is_empty() || module.materials.len() != module.domain.len() {
            return Err(SceneDocumentValidationError::new(format!(
                "spin_transports[{index}] requires exactly one material assignment per domain region"
            )));
        }
        let mut domain = BTreeSet::new();
        for (region_index, region) in module.domain.iter().enumerate() {
            validate_spin_region_ref(
                region,
                object_ids,
                &format!("spin_transports[{index}].domain[{region_index}]"),
            )?;
            if !domain.insert((region.object_id.clone(), region.region_id.clone())) {
                return Err(SceneDocumentValidationError::new(format!(
                    "spin_transports[{index}] contains a duplicate domain region"
                )));
            }
        }
        let mut assigned = BTreeSet::new();
        for (material_index, assignment) in module.materials.iter().enumerate() {
            validate_spin_region_ref(
                &assignment.region,
                object_ids,
                &format!("spin_transports[{index}].materials[{material_index}].region"),
            )?;
            let key = (
                assignment.region.object_id.clone(),
                assignment.region.region_id.clone(),
            );
            if !domain.contains(&key) || !assigned.insert(key) {
                return Err(SceneDocumentValidationError::new(format!(
                    "spin_transports[{index}].materials must map each domain region exactly once"
                )));
            }
            let material = &assignment.material;
            positive(
                material.sigma_s_spm,
                &format!("spin_transports[{index}].materials[{material_index}].sigma_s_Spm"),
            )?;
            if !material.polarization_p.is_finite()
                || !(-1.0..=1.0).contains(&material.polarization_p)
            {
                return Err(SceneDocumentValidationError::new(format!(
                    "spin_transports[{index}].materials[{material_index}].polarization_p must be in [-1,1]"
                )));
            }
            finite(
                material.theta_sh,
                &format!("spin_transports[{index}].materials[{material_index}].theta_sh"),
            )?;
            positive(
                material.lambda_sf_m,
                &format!("spin_transports[{index}].materials[{material_index}].lambda_sf_m"),
            )?;
            validate_scene_reaction_length(
                &material.lambda_j_m,
                &format!("spin_transports[{index}].materials[{material_index}].lambda_j_m"),
            )?;
            validate_scene_reaction_length(
                &material.lambda_phi_m,
                &format!("spin_transports[{index}].materials[{material_index}].lambda_phi_m"),
            )?;
            let density_of_states = material.density_of_states_per_spin_j_inv_m3;
            let has_physical_capacitance_source =
                material.spin_capacitance_as_per_v_m3.is_some() || density_of_states.is_some();
            match (
                has_physical_capacitance_source,
                material.capacitance_formula_version.as_deref(),
            ) {
                (true, Some(version)) => {
                    if let Some(capacitance) = material.spin_capacitance_as_per_v_m3 {
                        positive(
                            capacitance,
                            &format!(
                                "spin_transports[{index}].materials[{material_index}].spin_capacitance_As_per_V_m3"
                            ),
                        )?;
                    }
                    if let Some(density) = density_of_states {
                        positive(
                            density,
                            &format!(
                                "spin_transports[{index}].materials[{material_index}].density_of_states_per_spin_Jinv_m3"
                            ),
                        )?;
                        if let Some(capacitance) = material.spin_capacitance_as_per_v_m3 {
                            let expected =
                                fullmag_ir::spin_capacitance_from_density_of_states(density);
                            let tolerance =
                                1.0e-12 * capacitance.abs().max(expected.abs()).max(1.0e-300);
                            if (capacitance - expected).abs() > tolerance {
                                return Err(SceneDocumentValidationError::new(format!(
                                    "spin_transports[{index}].materials[{material_index}] spin capacitance must equal e^2 times density_of_states_per_spin_Jinv_m3"
                                )));
                            }
                        }
                    }
                    if version.trim().is_empty() {
                        return Err(SceneDocumentValidationError::new(format!(
                            "spin_transports[{index}].materials[{material_index}].capacitance_formula_version must be non-empty"
                        )));
                    }
                    if version != fullmag_ir::DOS_ISOTROPIC_NONMAGNETIC_CAPACITANCE_FORMULA {
                        return Err(SceneDocumentValidationError::new(format!(
                            "spin_transports[{index}].materials[{material_index}] unsupported capacitance_formula_version '{}' (expected '{}')",
                            version,
                            fullmag_ir::DOS_ISOTROPIC_NONMAGNETIC_CAPACITANCE_FORMULA
                        )));
                    }
                }
                (false, None) if module.mode == SceneSpinTransportMode::Steady => {}
                (false, None) => {
                    return Err(SceneDocumentValidationError::new(format!(
                        "spin_transports[{index}].materials[{material_index}] transient mode requires physical spin capacitance and formula version"
                    )));
                }
                (false, Some(_)) => {
                    return Err(SceneDocumentValidationError::new(format!(
                        "spin_transports[{index}].materials[{material_index}] capacitance_formula_version requires spin capacitance or density of states"
                    )));
                }
                (true, None) => {
                    return Err(SceneDocumentValidationError::new(format!(
                        "spin_transports[{index}].materials[{material_index}] spin capacitance or density of states requires capacitance_formula_version"
                    )));
                }
            }
        }
        for (interface_index, interface) in module.interfaces.iter().enumerate() {
            validate_scene_spin_interface(
                interface,
                object_ids,
                &format!("spin_transports[{index}].interfaces[{interface_index}]"),
            )?;
        }
        for (boundary_index, boundary) in module.boundaries.iter().enumerate() {
            validate_scene_spin_boundary(
                boundary,
                object_ids,
                &format!("spin_transports[{index}].boundaries[{boundary_index}]"),
            )?;
        }
        positive(
            module.solver.linear.relative_tolerance,
            &format!("spin_transports[{index}].solver.linear.relative_tolerance"),
        )?;
        nonnegative(
            module.solver.linear.absolute_tolerance,
            &format!("spin_transports[{index}].solver.linear.absolute_tolerance"),
        )?;
        if module.solver.linear.max_iterations == 0
            || module.schema_version.trim().is_empty()
            || module.constitutive_version.trim().is_empty()
            || module.solver.engine.trim().is_empty()
            || module.solver.operator_version.trim().is_empty()
            || module.solver.physical_residual_version.trim().is_empty()
        {
            return Err(SceneDocumentValidationError::new(format!(
                "spin_transports[{index}] has an incomplete versioned solver contract"
            )));
        }
    }

    let mut torque_ids = BTreeSet::new();
    for (index, torque) in scene.spin_torques.iter().enumerate() {
        if torque.id().trim().is_empty() || !torque_ids.insert(torque.id().to_string()) {
            return Err(SceneDocumentValidationError::new(format!(
                "spin_torques[{index}] id must be non-empty and unique"
            )));
        }
        validate_spin_torque(index, torque, object_ids, &transport_ids)?;
    }

    let mut oersted_ids = BTreeSet::new();
    for (index, field) in scene.oersted_fields.iter().enumerate() {
        if field.id().trim().is_empty() || !oersted_ids.insert(field.id().to_string()) {
            return Err(SceneDocumentValidationError::new(format!(
                "oersted_fields[{index}] id must be non-empty and unique"
            )));
        }
        let field = match field {
            SceneOerstedField::Known(field) => field,
            SceneOerstedField::Unsupported(_) => {
                return Err(SceneDocumentValidationError::new(format!(
                    "oersted_fields[{index}] uses an unsupported read-only variant"
                )))
            }
        };
        match field {
            KnownSceneOerstedField::OerstedCylinder {
                current,
                radius,
                center,
                axis,
                time_dependence,
                ..
            } => {
                finite(*current, &format!("oersted_fields[{index}].current"))?;
                positive(*radius, &format!("oersted_fields[{index}].radius"))?;
                finite_vec3(*center, &format!("oersted_fields[{index}].center"), false)?;
                finite_vec3(*axis, &format!("oersted_fields[{index}].axis"), true)?;
                if let Some(envelope) = time_dependence {
                    validate_oersted_envelope(index, envelope)?;
                }
            }
            KnownSceneOerstedField::OerstedField { source, .. } => {
                require_reference(
                    source,
                    &transport_ids,
                    &format!("oersted_fields[{index}].source"),
                )?;
            }
        }
    }
    Ok(())
}

fn validate_spin_region_ref(
    region: &SceneRegionRef,
    object_ids: &BTreeSet<String>,
    path: &str,
) -> Result<(), SceneDocumentValidationError> {
    require_reference(&region.object_id, object_ids, &format!("{path}.object_id"))?;
    if region
        .region_id
        .as_ref()
        .is_some_and(|id| id.trim().is_empty())
    {
        return Err(SceneDocumentValidationError::new(format!(
            "{path}.region_id must not be empty"
        )));
    }
    Ok(())
}

fn validate_scene_reaction_length(
    length: &SceneReactionLength,
    path: &str,
) -> Result<(), SceneDocumentValidationError> {
    if let SceneReactionLength::Enabled(value) = length {
        positive(*value, path)?;
    }
    Ok(())
}

fn validate_scene_surface_ref(
    surface: &SceneSurfaceRef,
    object_ids: &BTreeSet<String>,
    path: &str,
) -> Result<(), SceneDocumentValidationError> {
    require_reference(&surface.object_id, object_ids, &format!("{path}.object_id"))?;
    if surface.surface_id.trim().is_empty() {
        return Err(SceneDocumentValidationError::new(format!(
            "{path}.surface_id must not be empty"
        )));
    }
    finite_vec3(surface.orientation, &format!("{path}.orientation"), true)
}

fn validate_scene_spin_interface(
    interface: &SceneSpinInterface,
    object_ids: &BTreeSet<String>,
    path: &str,
) -> Result<(), SceneDocumentValidationError> {
    match interface {
        SceneSpinInterface::Transparent {
            id,
            side_a,
            side_b,
            normal_a_to_b,
        } => {
            if id.trim().is_empty() || side_a == side_b {
                return Err(SceneDocumentValidationError::new(format!(
                    "{path} requires a non-empty id and two distinct sides"
                )));
            }
            validate_spin_region_ref(side_a, object_ids, &format!("{path}.side_a"))?;
            validate_spin_region_ref(side_b, object_ids, &format!("{path}.side_b"))?;
            finite_vec3(*normal_a_to_b, &format!("{path}.normal_a_to_b"), true)
        }
        SceneSpinInterface::MixingConductance {
            id,
            normal_to_ferromagnet,
            normal_side,
            ferromagnet_side,
            g_up_spm2,
            g_down_spm2,
            g_r_spm2,
            g_i_spm2,
            g_sml_spm2,
            spin_memory_loss,
            absorption,
            formula_version,
        } => {
            if id.trim().is_empty()
                || absorption.trim().is_empty()
                || formula_version.trim().is_empty()
                || normal_side == ferromagnet_side
            {
                return Err(SceneDocumentValidationError::new(format!(
                    "{path} has an incomplete oriented mixing contract"
                )));
            }
            validate_spin_region_ref(normal_side, object_ids, &format!("{path}.normal_side"))?;
            validate_spin_region_ref(
                ferromagnet_side,
                object_ids,
                &format!("{path}.ferromagnet_side"),
            )?;
            finite_vec3(
                *normal_to_ferromagnet,
                &format!("{path}.normal_to_ferromagnet"),
                true,
            )?;
            for (name, value) in [
                ("g_up_Spm2", *g_up_spm2),
                ("g_down_Spm2", *g_down_spm2),
                ("g_r_Spm2", *g_r_spm2),
                ("g_sml_Spm2", *g_sml_spm2),
            ] {
                nonnegative(value, &format!("{path}.{name}"))?;
            }
            finite(*g_i_spm2, &format!("{path}.g_i_Spm2"))?;
            if formula_version != "magnetoelectronic.fullmag.v2" {
                return Err(SceneDocumentValidationError::new(format!(
                    "{path}.formula_version must be magnetoelectronic.fullmag.v2; v1 is read-only"
                )));
            }
            if *g_sml_spm2 > 0.0 {
                return Err(SceneDocumentValidationError::new(format!(
                    "{path}.g_sml_Spm2 uses rejected sml_surface_conductance.fullmag.v1; author spin_memory_loss with sml_reservoir.fullmag.v2"
                )));
            }
            if let Some(reservoir) = spin_memory_loss {
                if reservoir.formula_version != "sml_reservoir.fullmag.v2" {
                    return Err(SceneDocumentValidationError::new(format!(
                        "{path}.spin_memory_loss.formula_version must be sml_reservoir.fullmag.v2"
                    )));
                }
                nonnegative(
                    reservoir.g_n_spm2,
                    &format!("{path}.spin_memory_loss.g_n_Spm2"),
                )?;
                nonnegative(
                    reservoir.g_f_spm2,
                    &format!("{path}.spin_memory_loss.g_f_Spm2"),
                )?;
                positive(
                    reservoir.g_lattice_spm2,
                    &format!("{path}.spin_memory_loss.g_lattice_Spm2"),
                )?;
            }
            Ok(())
        }
    }
}

fn validate_scene_spin_boundary(
    boundary: &SceneSpinBoundary,
    object_ids: &BTreeSet<String>,
    path: &str,
) -> Result<(), SceneDocumentValidationError> {
    let (id, surfaces): (&str, Vec<&SceneSurfaceRef>) = match boundary {
        SceneSpinBoundary::SpinInsulating { id, surfaces }
        | SceneSpinBoundary::SpinSink { id, surfaces } => (id, surfaces.iter().collect()),
        SceneSpinBoundary::SpecifiedSpinPotential {
            id,
            surfaces,
            spin_potential_v,
        } => {
            finite_vec3(
                *spin_potential_v,
                &format!("{path}.spin_potential_V"),
                false,
            )?;
            (id, surfaces.iter().collect())
        }
        SceneSpinBoundary::SpecifiedSpinFlux {
            id,
            surfaces,
            normal_spin_flux_apm2,
        } => {
            finite_vec3(
                *normal_spin_flux_apm2,
                &format!("{path}.normal_spin_flux_Apm2"),
                false,
            )?;
            (id, surfaces.iter().collect())
        }
        SceneSpinBoundary::PeriodicSpin {
            id,
            minus_surface,
            plus_surface,
            translation_m,
        } => {
            finite_vec3(*translation_m, &format!("{path}.translation_m"), true)?;
            (id, vec![minus_surface, plus_surface])
        }
    };
    if id.trim().is_empty() || surfaces.is_empty() {
        return Err(SceneDocumentValidationError::new(format!(
            "{path} requires a non-empty id and surface selection"
        )));
    }
    for (index, surface) in surfaces.into_iter().enumerate() {
        validate_scene_surface_ref(surface, object_ids, &format!("{path}.surfaces[{index}]"))?;
    }
    Ok(())
}

fn validate_current_transport(
    index: usize,
    transport: &KnownSceneCurrentTransport,
    object_ids: &BTreeSet<String>,
) -> Result<(), SceneDocumentValidationError> {
    if transport.name.trim().is_empty() {
        return Err(SceneDocumentValidationError::new(format!(
            "current_transports[{index}].name must not be empty"
        )));
    }
    if let Some(region) = &transport.solve_region {
        require_reference(
            region,
            object_ids,
            &format!("current_transports[{index}].solve_region"),
        )?;
    }
    if let Some(conductivity) = transport.conductivity_s_per_m {
        positive(
            conductivity,
            &format!("current_transports[{index}].conductivity_s_per_m"),
        )?;
    }
    match transport.model {
        CurrentTransportModel::PrescribedDensity => {
            if !transport.domain.is_empty()
                || !transport.materials.is_empty()
                || !transport.boundaries.is_empty()
                || transport.gauge.is_some()
                || transport.solver.is_some()
            {
                return Err(SceneDocumentValidationError::new(format!(
                    "current_transports[{index}] prescribed_density must not define an ohmic charge solve"
                )));
            }
            let density = transport.current_density.ok_or_else(|| {
                SceneDocumentValidationError::new(format!(
                    "current_transports[{index}] prescribed_density requires current_density"
                ))
            })?;
            finite_vec3(
                density,
                &format!("current_transports[{index}].current_density"),
                false,
            )?;
        }
        CurrentTransportModel::OhmicPoisson if transport.current_density.is_some() => {
            return Err(SceneDocumentValidationError::new(format!(
                "current_transports[{index}] ohmic_poisson must not define current_density"
            )));
        }
        CurrentTransportModel::OhmicPoisson => {
            if transport.solve_region.is_some() || transport.conductivity_s_per_m.is_some() {
                return Err(SceneDocumentValidationError::new(format!(
                    "current_transports[{index}] legacy ohmic_poisson solve_region/conductivity_s_per_m is ambiguous"
                )));
            }
            validate_scene_charge_contract(index, transport, object_ids)?;
        }
        CurrentTransportModel::MagnetoresistivePoisson => {
            if transport.coupling != SceneTransportCoupling::Bidirectional {
                return Err(SceneDocumentValidationError::new(format!(
                    "current_transports[{index}] magnetoresistive_poisson requires coupling=bidirectional"
                )));
            }
            if transport.current_density.is_some()
                || transport.solve_region.is_some()
                || transport.conductivity_s_per_m.is_some()
            {
                return Err(SceneDocumentValidationError::new(format!(
                    "current_transports[{index}] magnetoresistive_poisson does not accept legacy current or solve fields"
                )));
            }
            validate_scene_charge_contract(index, transport, object_ids)?;
        }
    }
    Ok(())
}

fn validate_scene_charge_contract(
    index: usize,
    transport: &KnownSceneCurrentTransport,
    object_ids: &BTreeSet<String>,
) -> Result<(), SceneDocumentValidationError> {
    let prefix = format!("current_transports[{index}]");
    if transport.domain.is_empty()
        || transport.materials.is_empty()
        || transport.boundaries.is_empty()
        || transport.gauge.is_none()
        || transport.solver.is_none()
    {
        return Err(SceneDocumentValidationError::new(format!(
            "{prefix} ohmic_poisson requires non-empty domain, materials, boundaries, gauge, and solver"
        )));
    }
    let mut domain = BTreeSet::new();
    for (region_index, region) in transport.domain.iter().enumerate() {
        validate_spin_region_ref(
            region,
            object_ids,
            &format!("{prefix}.domain[{region_index}]"),
        )?;
        if !domain.insert((region.object_id.clone(), region.region_id.clone())) {
            return Err(SceneDocumentValidationError::new(format!(
                "{prefix}.domain contains duplicate regions"
            )));
        }
    }
    let mut assigned = BTreeSet::new();
    for (material_index, assignment) in transport.materials.iter().enumerate() {
        validate_spin_region_ref(
            &assignment.region,
            object_ids,
            &format!("{prefix}.materials[{material_index}].region"),
        )?;
        let key = (
            assignment.region.object_id.clone(),
            assignment.region.region_id.clone(),
        );
        if !domain.contains(&key) || !assigned.insert(key) {
            return Err(SceneDocumentValidationError::new(format!(
                "{prefix}.materials must map every domain region exactly once"
            )));
        }
        positive(
            assignment.material.sigma_spm,
            &format!("{prefix}.materials[{material_index}].material.sigma_Spm"),
        )?;
        let anisotropic = [
            assignment.material.sigma_parallel_spm,
            assignment.material.sigma_perpendicular_spm,
            assignment.material.sigma_ahe_spm,
        ];
        let reciprocal = transport.coupling == SceneTransportCoupling::Bidirectional
            || transport.model == CurrentTransportModel::MagnetoresistivePoisson;
        if reciprocal {
            match anisotropic {
                [Some(parallel), Some(perpendicular), Some(ahe)] => {
                    positive(
                        parallel,
                        &format!(
                            "{prefix}.materials[{material_index}].material.sigma_parallel_Spm"
                        ),
                    )?;
                    positive(
                        perpendicular,
                        &format!(
                            "{prefix}.materials[{material_index}].material.sigma_perpendicular_Spm"
                        ),
                    )?;
                    finite(
                        ahe,
                        &format!("{prefix}.materials[{material_index}].material.sigma_AHE_Spm"),
                    )?;
                }
                _ => {
                    return Err(SceneDocumentValidationError::new(format!(
                        "{prefix}.materials[{material_index}] magnetoresistive_poisson requires sigma_parallel_Spm, sigma_perpendicular_Spm, and sigma_AHE_Spm"
                    )));
                }
            }
        } else if anisotropic.iter().any(Option::is_some) {
            return Err(SceneDocumentValidationError::new(format!(
                "{prefix}.materials[{material_index}] anisotropic conductivity is valid only for magnetoresistive_poisson"
            )));
        }
    }
    if assigned != domain {
        return Err(SceneDocumentValidationError::new(format!(
            "{prefix}.materials must map every domain region exactly once"
        )));
    }

    let mut boundary_ids = BTreeSet::new();
    let mut surfaces = BTreeSet::new();
    let mut voltage_count = 0usize;
    for (boundary_index, boundary) in transport.boundaries.iter().enumerate() {
        let (id, selected_surfaces) = match boundary {
            SceneChargeBoundary::VoltageElectrode {
                id,
                surfaces,
                potential_v,
            } => {
                voltage_count += 1;
                finite(
                    *potential_v,
                    &format!("{prefix}.boundaries[{boundary_index}].potential_V"),
                )?;
                (id, surfaces)
            }
            SceneChargeBoundary::NormalCurrentElectrode {
                id,
                surfaces,
                outward_current_density_apm2,
            } => {
                finite(
                    *outward_current_density_apm2,
                    &format!("{prefix}.boundaries[{boundary_index}].outward_current_density_Apm2"),
                )?;
                (id, surfaces)
            }
            SceneChargeBoundary::Insulating { id, surfaces } => (id, surfaces),
        };
        if id.trim().is_empty() || !boundary_ids.insert(id.as_str()) || selected_surfaces.is_empty()
        {
            return Err(SceneDocumentValidationError::new(format!(
                "{prefix}.boundaries[{boundary_index}] requires a unique non-empty id and surfaces"
            )));
        }
        for (surface_index, surface) in selected_surfaces.iter().enumerate() {
            validate_scene_surface_ref(
                surface,
                object_ids,
                &format!("{prefix}.boundaries[{boundary_index}].surfaces[{surface_index}]"),
            )?;
            if !surfaces.insert((surface.object_id.as_str(), surface.surface_id.as_str())) {
                return Err(SceneDocumentValidationError::new(format!(
                    "{prefix} has conflicting charge boundary assignments for '{}:{}'",
                    surface.object_id, surface.surface_id
                )));
            }
        }
    }
    match transport.gauge {
        Some(SceneChargePotentialGauge::DirichletReference) if voltage_count == 0 => {
            return Err(SceneDocumentValidationError::new(format!(
                "{prefix}.gauge=dirichlet_reference requires a voltage electrode"
            )));
        }
        Some(SceneChargePotentialGauge::ZeroMean) if voltage_count != 0 => {
            return Err(SceneDocumentValidationError::new(format!(
                "{prefix}.gauge=zero_mean conflicts with voltage electrodes"
            )));
        }
        _ => {}
    }
    let solver = transport.solver.as_ref().expect("checked above");
    let reciprocal = transport.coupling == SceneTransportCoupling::Bidirectional
        || transport.model == CurrentTransportModel::MagnetoresistivePoisson;
    let expected_engine = if reciprocal { "block_gmres" } else { "cg" };
    let expected_operator = if reciprocal {
        "fdm_coupled_charge_spin_fv_block_gmres.v1"
    } else {
        "fv_charge_harmonic_v1"
    };
    let expected_residual = if reciprocal {
        "transport_balance_integrated_l2.v1"
    } else {
        "charge_balance_integrated_l2.v1"
    };
    if solver.engine != expected_engine
        || solver.operator_version != expected_operator
        || solver.physical_residual_version != expected_residual
    {
        return Err(SceneDocumentValidationError::new(format!(
            "{prefix}.solver carries an unsupported charge engine/version"
        )));
    }
    positive(
        solver.linear.relative_tolerance,
        &format!("{prefix}.solver.linear.relative_tolerance"),
    )?;
    nonnegative(
        solver.linear.absolute_tolerance,
        &format!("{prefix}.solver.linear.absolute_tolerance"),
    )?;
    if solver.linear.max_iterations == 0 {
        return Err(SceneDocumentValidationError::new(format!(
            "{prefix}.solver.linear.max_iterations must be positive"
        )));
    }
    Ok(())
}

fn validate_spin_torque(
    index: usize,
    torque: &SceneSpinTorque,
    object_ids: &BTreeSet<String>,
    transport_ids: &BTreeSet<String>,
) -> Result<(), SceneDocumentValidationError> {
    let torque = match torque {
        SceneSpinTorque::Known(torque) => torque,
        SceneSpinTorque::Unsupported(_) => {
            return Err(SceneDocumentValidationError::new(format!(
                "spin_torques[{index}] uses an unsupported read-only variant"
            )))
        }
    };
    match torque {
        KnownSceneSpinTorque::ZhangLi {
            current_density,
            current_source,
            degree,
            beta,
            ..
        } => {
            validate_current_binding(
                index,
                *current_density,
                current_source.as_deref(),
                transport_ids,
            )?;
            unit_interval_open(*degree, &format!("spin_torques[{index}].degree"))?;
            nonnegative(*beta, &format!("spin_torques[{index}].beta"))?;
        }
        KnownSceneSpinTorque::Slonczewski {
            formula_version,
            schema_version,
            current_density,
            current_source,
            spin_polarization,
            degree,
            lambda_asymmetry,
            epsilon_prime,
            free_layer_thickness_m,
            fixed_layer_position,
            target,
            stack_normal,
            realization,
            ..
        } => {
            validate_current_binding(
                index,
                *current_density,
                current_source.as_deref(),
                transport_ids,
            )?;
            finite_vec3(
                *spin_polarization,
                &format!("spin_torques[{index}].spin_polarization"),
                matches!(
                    formula_version,
                    SlonczewskiFormulaVersion::FullmagV2 | SlonczewskiFormulaVersion::FullmagV1
                ),
            )?;
            unit_interval_open(*degree, &format!("spin_torques[{index}].degree"))?;
            if !lambda_asymmetry.is_finite() || *lambda_asymmetry < 1.0 {
                return Err(SceneDocumentValidationError::new(format!(
                    "spin_torques[{index}].lambda_asymmetry must be finite and >= 1"
                )));
            }
            finite(
                *epsilon_prime,
                &format!("spin_torques[{index}].epsilon_prime"),
            )?;
            if let Some(thickness) = free_layer_thickness_m {
                positive(
                    *thickness,
                    &format!("spin_torques[{index}].free_layer_thickness_m"),
                )?;
            }
            match formula_version {
                SlonczewskiFormulaVersion::FullmagV2 => {
                    if schema_version.as_deref() != Some("slonczewski_torque.v1")
                        || free_layer_thickness_m.is_none()
                        || fixed_layer_position.is_some()
                        || realization.is_none()
                    {
                        return Err(SceneDocumentValidationError::new(format!(
                            "spin_torques[{index}] canonical Slonczewski contract is incomplete"
                        )));
                    }
                    validate_region_ref(index, target.as_ref(), object_ids)?;
                    finite_vec3(
                        stack_normal.ok_or_else(|| {
                            SceneDocumentValidationError::new(format!(
                                "spin_torques[{index}].stack_normal is required"
                            ))
                        })?,
                        &format!("spin_torques[{index}].stack_normal"),
                        true,
                    )?;
                }
                SlonczewskiFormulaVersion::FullmagV1 => {
                    return Err(SceneDocumentValidationError::new(format!(
                        "spin_torques[{index}] slonczewski.fullmag.v1 is read-only provenance; use slonczewski.fullmag.v2"
                    )));
                }
                SlonczewskiFormulaVersion::LegacyFullmagV0 => {
                    if target.is_some() || stack_normal.is_some() || realization.is_some() {
                        return Err(SceneDocumentValidationError::new(format!("spin_torques[{index}] legacy Slonczewski must not define canonical geometry")));
                    }
                    if !matches!(fixed_layer_position.as_deref(), Some("top" | "bottom")) {
                        return Err(SceneDocumentValidationError::new(format!(
                            "spin_torques[{index}].fixed_layer_position must be top or bottom"
                        )));
                    }
                }
            }
        }
        KnownSceneSpinTorque::PrescribedSot {
            formula_version,
            target,
            drive,
            raw_spin_polarization,
            xi_dl,
            xi_fl,
            free_layer_thickness_m,
            compatibility_origin,
            ..
        } => {
            finite(*xi_dl, &format!("spin_torques[{index}].xi_dl"))?;
            finite(*xi_fl, &format!("spin_torques[{index}].xi_fl"))?;
            positive(
                *free_layer_thickness_m,
                &format!("spin_torques[{index}].free_layer_thickness_m"),
            )?;
            match formula_version {
                PrescribedSotFormulaVersion::FullmagV1 => {
                    validate_region_ref(index, target.as_ref(), object_ids)?;
                    if raw_spin_polarization.is_some() || compatibility_origin.is_some() {
                        return Err(SceneDocumentValidationError::new(format!(
                            "spin_torques[{index}] canonical prescribed SOT contains legacy fields"
                        )));
                    }
                    validate_prescribed_drive(index, drive, transport_ids, false)?;
                }
                PrescribedSotFormulaVersion::LegacyFullmagV0 => {
                    if target.is_some() || raw_spin_polarization.is_none() {
                        return Err(SceneDocumentValidationError::new(format!(
                            "spin_torques[{index}] legacy prescribed SOT contract is incomplete"
                        )));
                    }
                    finite_vec3(
                        raw_spin_polarization.unwrap(),
                        &format!("spin_torques[{index}].raw_spin_polarization"),
                        false,
                    )?;
                    let origin = compatibility_origin.as_ref().ok_or_else(|| {
                        SceneDocumentValidationError::new(format!(
                            "spin_torques[{index}].compatibility_origin is required"
                        ))
                    })?;
                    if origin.source_ir_version != "0.2.0"
                        || origin.authored_kind != "spin_orbit_torque"
                        || !origin.additional.is_empty()
                    {
                        return Err(SceneDocumentValidationError::new(format!(
                            "spin_torques[{index}].compatibility_origin is unsupported"
                        )));
                    }
                    validate_prescribed_drive(index, drive, transport_ids, true)?;
                }
            }
        }
    }
    Ok(())
}

fn validate_current_binding(
    index: usize,
    density: Option<[f64; 3]>,
    source: Option<&str>,
    transports: &BTreeSet<String>,
) -> Result<(), SceneDocumentValidationError> {
    if density.is_some() == source.is_some() {
        return Err(SceneDocumentValidationError::new(format!(
            "spin_torques[{index}] requires exactly one current binding"
        )));
    }
    if let Some(value) = density {
        finite_vec3(
            value,
            &format!("spin_torques[{index}].current_density"),
            false,
        )?;
    }
    if let Some(value) = source {
        require_reference(
            value,
            transports,
            &format!("spin_torques[{index}].current_source"),
        )?;
    }
    Ok(())
}

fn validate_region_ref(
    index: usize,
    target: Option<&crate::SceneRegionRef>,
    object_ids: &BTreeSet<String>,
) -> Result<(), SceneDocumentValidationError> {
    let target = target.ok_or_else(|| {
        SceneDocumentValidationError::new(format!("spin_torques[{index}].target is required"))
    })?;
    require_reference(
        &target.object_id,
        object_ids,
        &format!("spin_torques[{index}].target.object_id"),
    )
}

fn validate_prescribed_drive(
    index: usize,
    drive: &ScenePrescribedSotDrive,
    transports: &BTreeSet<String>,
    legacy: bool,
) -> Result<(), SceneDocumentValidationError> {
    match (legacy, drive) {
        (
            false,
            ScenePrescribedSotDrive::SignedScalar {
                current_density_apm2,
                sigma_hat,
                envelope,
            },
        ) => {
            finite(
                *current_density_apm2,
                &format!("spin_torques[{index}].drive.current_density_Apm2"),
            )?;
            finite_vec3(
                *sigma_hat,
                &format!("spin_torques[{index}].drive.sigma_hat"),
                true,
            )?;
            if let Some(value) = envelope {
                validate_time_envelope(index, value)?;
            }
        }
        (
            false,
            ScenePrescribedSotDrive::VectorCurrentSource {
                current_source_id,
                drive_direction,
                interface_normal,
            },
        ) => {
            require_reference(
                current_source_id,
                transports,
                &format!("spin_torques[{index}].drive.current_source_id"),
            )?;
            finite_vec3(
                *drive_direction,
                &format!("spin_torques[{index}].drive.drive_direction"),
                true,
            )?;
            finite_vec3(
                *interface_normal,
                &format!("spin_torques[{index}].drive.interface_normal"),
                true,
            )?;
            let cross = [
                interface_normal[1] * drive_direction[2] - interface_normal[2] * drive_direction[1],
                interface_normal[2] * drive_direction[0] - interface_normal[0] * drive_direction[2],
                interface_normal[0] * drive_direction[1] - interface_normal[1] * drive_direction[0],
            ];
            finite_vec3(cross, &format!("spin_torques[{index}].drive.axes"), true)?;
        }
        (
            true,
            ScenePrescribedSotDrive::LegacyScalarMagnitude {
                raw_charge_current_density_apm2,
            },
        ) => finite(
            *raw_charge_current_density_apm2,
            &format!("spin_torques[{index}].drive.raw_charge_current_density_Apm2"),
        )?,
        (true, ScenePrescribedSotDrive::LegacyCurrentSourceNorm { current_source_id }) => {
            require_reference(
                current_source_id,
                transports,
                &format!("spin_torques[{index}].drive.current_source_id"),
            )?
        }
        _ => {
            return Err(SceneDocumentValidationError::new(format!(
                "spin_torques[{index}].drive is incompatible with formula_version"
            )))
        }
    }
    Ok(())
}

fn validate_time_envelope(
    index: usize,
    envelope: &SceneTimeEnvelope,
) -> Result<(), SceneDocumentValidationError> {
    let path = format!("spin_torques[{index}].drive.envelope");
    match envelope {
        SceneTimeEnvelope::Constant { value } => finite(*value, &format!("{path}.value"))?,
        SceneTimeEnvelope::Sinusoidal {
            amplitude,
            frequency_hz,
            phase_rad,
            offset,
        } => {
            finite(*amplitude, &format!("{path}.amplitude"))?;
            nonnegative(*frequency_hz, &format!("{path}.frequency_hz"))?;
            finite(*phase_rad, &format!("{path}.phase_rad"))?;
            finite(*offset, &format!("{path}.offset"))?;
        }
        SceneTimeEnvelope::Pulse {
            amplitude,
            t_on_s,
            t_off_s,
        } => {
            finite(*amplitude, &format!("{path}.amplitude"))?;
            finite(*t_on_s, &format!("{path}.t_on_s"))?;
            finite(*t_off_s, &format!("{path}.t_off_s"))?;
            if t_off_s <= t_on_s {
                return Err(SceneDocumentValidationError::new(format!(
                    "{path}.t_off_s must be greater than t_on_s"
                )));
            }
        }
        SceneTimeEnvelope::PiecewiseLinear { points } => {
            let mut previous = None;
            for (point_index, point) in points.iter().enumerate() {
                finite(
                    point.time_s,
                    &format!("{path}.points[{point_index}].time_s"),
                )?;
                finite(point.value, &format!("{path}.points[{point_index}].value"))?;
                if previous.is_some_and(|value| point.time_s <= value) {
                    return Err(SceneDocumentValidationError::new(format!(
                        "{path}.points times must be strictly increasing"
                    )));
                }
                previous = Some(point.time_s);
            }
        }
        SceneTimeEnvelope::Sinc {
            amplitude,
            center_s,
            bandwidth_hz,
            offset,
        } => {
            finite(*amplitude, &format!("{path}.amplitude"))?;
            finite(*center_s, &format!("{path}.center_s"))?;
            positive(*bandwidth_hz, &format!("{path}.bandwidth_hz"))?;
            finite(*offset, &format!("{path}.offset"))?;
        }
        SceneTimeEnvelope::Tabulated {
            artifact_ref,
            bandwidth_hz,
            ..
        } => {
            if artifact_ref.trim().is_empty() {
                return Err(SceneDocumentValidationError::new(format!(
                    "{path}.artifact_ref must not be empty"
                )));
            }
            if let Some(value) = bandwidth_hz {
                positive(*value, &format!("{path}.bandwidth_hz"))?;
            }
        }
    }
    Ok(())
}

fn validate_oersted_envelope(
    index: usize,
    envelope: &SceneOerstedTimeDependence,
) -> Result<(), SceneDocumentValidationError> {
    let path = format!("oersted_fields[{index}].time_dependence");
    match envelope {
        SceneOerstedTimeDependence::Constant => {}
        SceneOerstedTimeDependence::Sinusoidal {
            frequency_hz,
            phase_rad,
            offset,
        } => {
            positive(*frequency_hz, &format!("{path}.frequency_hz"))?;
            finite(*phase_rad, &format!("{path}.phase_rad"))?;
            finite(*offset, &format!("{path}.offset"))?;
        }
        SceneOerstedTimeDependence::Pulse { t_on, t_off } => {
            finite(*t_on, &format!("{path}.t_on"))?;
            finite(*t_off, &format!("{path}.t_off"))?;
            if t_off <= t_on {
                return Err(SceneDocumentValidationError::new(format!(
                    "{path}.t_off must be greater than t_on"
                )));
            }
        }
        SceneOerstedTimeDependence::PiecewiseLinear { points } => {
            if points.len() < 2 {
                return Err(SceneDocumentValidationError::new(format!(
                    "{path}.points requires at least two values"
                )));
            }
            let mut previous = None;
            for point in points {
                finite(point[0], &format!("{path}.points.time"))?;
                finite(point[1], &format!("{path}.points.value"))?;
                if previous.is_some_and(|value| point[0] <= value) {
                    return Err(SceneDocumentValidationError::new(format!(
                        "{path}.points times must be strictly increasing"
                    )));
                }
                previous = Some(point[0]);
            }
        }
        SceneOerstedTimeDependence::SincPulse {
            cutoff_hz,
            t0,
            amplitude,
        } => {
            positive(*cutoff_hz, &format!("{path}.cutoff_hz"))?;
            finite(*t0, &format!("{path}.t0"))?;
            finite(*amplitude, &format!("{path}.amplitude"))?;
        }
    }
    Ok(())
}

fn require_reference(
    value: &str,
    available: &BTreeSet<String>,
    path: &str,
) -> Result<(), SceneDocumentValidationError> {
    if value.trim().is_empty() || !available.contains(value) {
        return Err(SceneDocumentValidationError::new(format!(
            "{path} references missing id '{value}'"
        )));
    }
    Ok(())
}
fn finite(value: f64, path: &str) -> Result<(), SceneDocumentValidationError> {
    if !value.is_finite() {
        return Err(SceneDocumentValidationError::new(format!(
            "{path} must be finite"
        )));
    }
    Ok(())
}
fn positive(value: f64, path: &str) -> Result<(), SceneDocumentValidationError> {
    if !value.is_finite() || value <= 0.0 {
        return Err(SceneDocumentValidationError::new(format!(
            "{path} must be finite and > 0"
        )));
    }
    Ok(())
}
fn nonnegative(value: f64, path: &str) -> Result<(), SceneDocumentValidationError> {
    if !value.is_finite() || value < 0.0 {
        return Err(SceneDocumentValidationError::new(format!(
            "{path} must be finite and >= 0"
        )));
    }
    Ok(())
}
fn unit_interval_open(value: f64, path: &str) -> Result<(), SceneDocumentValidationError> {
    if !value.is_finite() || value <= 0.0 || value > 1.0 {
        return Err(SceneDocumentValidationError::new(format!(
            "{path} must be in (0, 1]"
        )));
    }
    Ok(())
}
fn finite_vec3(
    value: [f64; 3],
    path: &str,
    nonzero: bool,
) -> Result<(), SceneDocumentValidationError> {
    if value.iter().any(|component| !component.is_finite()) {
        return Err(SceneDocumentValidationError::new(format!(
            "{path} must contain finite components"
        )));
    }
    if nonzero
        && value
            .iter()
            .map(|component| component * component)
            .sum::<f64>()
            .sqrt()
            <= 1e-12
    {
        return Err(SceneDocumentValidationError::new(format!(
            "{path} must be nonzero"
        )));
    }
    Ok(())
}

fn validate_scene_v1_has_no_region_owned_payloads(
    scene: &SceneDocument,
) -> Result<(), SceneDocumentValidationError> {
    if !scene.couplings.is_empty() {
        return Err(SceneDocumentValidationError::new(
            "scene.v1 cannot contain region-owned couplings; save as scene.v2",
        ));
    }
    for object in &scene.objects {
        if !object.regions.is_empty() {
            return Err(SceneDocumentValidationError::new(format!(
                "scene.v1 object '{}' cannot contain authored object regions; save as scene.v2",
                object.id
            )));
        }
        if !object.allocated_region_ids.is_empty() {
            return Err(SceneDocumentValidationError::new(format!(
                "scene.v1 object '{}' cannot contain allocated_region_ids; save as scene.v2",
                object.id
            )));
        }
        if !object.material_parameter_fields.is_empty() {
            return Err(SceneDocumentValidationError::new(format!(
                "scene.v1 object '{}' cannot contain material_parameter_fields; save as scene.v2",
                object.id
            )));
        }
    }
    Ok(())
}

fn validate_study_pipeline_document(
    document: &StudyPipelineDocument,
) -> Result<(), SceneDocumentValidationError> {
    if document.version != "study_pipeline.v1" {
        return Err(SceneDocumentValidationError::new(format!(
            "unsupported study pipeline version '{}'",
            document.version
        )));
    }
    validate_study_pipeline_nodes(&document.nodes)?;
    Ok(())
}

fn validate_study_pipeline_nodes(
    nodes: &[StudyPipelineNode],
) -> Result<(), SceneDocumentValidationError> {
    let mut node_ids = BTreeSet::new();
    for node in nodes {
        match node {
            StudyPipelineNode::Primitive(node) => {
                if node.id.trim().is_empty() {
                    return Err(SceneDocumentValidationError::new(
                        "study pipeline primitive node ids must not be empty",
                    ));
                }
                if node.label.trim().is_empty() {
                    return Err(SceneDocumentValidationError::new(format!(
                        "study pipeline primitive node '{}' must have a label",
                        node.id
                    )));
                }
                if !node_ids.insert(node.id.clone()) {
                    return Err(SceneDocumentValidationError::new(format!(
                        "duplicate study pipeline node id '{}'",
                        node.id
                    )));
                }
            }
            StudyPipelineNode::Macro(node) => {
                if node.id.trim().is_empty() {
                    return Err(SceneDocumentValidationError::new(
                        "study pipeline macro node ids must not be empty",
                    ));
                }
                if node.label.trim().is_empty() {
                    return Err(SceneDocumentValidationError::new(format!(
                        "study pipeline macro node '{}' must have a label",
                        node.id
                    )));
                }
                if !node_ids.insert(node.id.clone()) {
                    return Err(SceneDocumentValidationError::new(format!(
                        "duplicate study pipeline node id '{}'",
                        node.id
                    )));
                }
            }
            StudyPipelineNode::Group(node) => {
                if node.id.trim().is_empty() {
                    return Err(SceneDocumentValidationError::new(
                        "study pipeline group node ids must not be empty",
                    ));
                }
                if node.label.trim().is_empty() {
                    return Err(SceneDocumentValidationError::new(format!(
                        "study pipeline group node '{}' must have a label",
                        node.id
                    )));
                }
                if !node_ids.insert(node.id.clone()) {
                    return Err(SceneDocumentValidationError::new(format!(
                        "duplicate study pipeline node id '{}'",
                        node.id
                    )));
                }
                validate_study_pipeline_nodes(&node.children)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_generic_swept_prism() -> crate::ScriptBuilderPerGeometryMeshState {
        crate::ScriptBuilderPerGeometryMeshState {
            mesh_strategy: Some("swept_prism".to_string()),
            order: Some(1),
            through_thickness_elements: Some(1),
            through_thickness_distribution: Some("fixed".to_string()),
            sweep_face_meshing: Some("triangular".to_string()),
            sweep_direction: Some("auto".to_string()),
            element_family: Some("prism".to_string()),
            transition_policy: Some("reject".to_string()),
            exact_layer_count: Some(true),
            ..crate::ScriptBuilderPerGeometryMeshState::default()
        }
    }

    #[test]
    fn layered_mesh_validation_rejects_contradictory_or_incomplete_intent() {
        let mut tetrahedral_prism = valid_generic_swept_prism();
        tetrahedral_prism.topology = Some("tetrahedral".to_string());
        tetrahedral_prism.transition_policy = Some("pyramid_to_tetrahedra".to_string());
        let error = validate_requested_layered_mesh("mesh", &tetrahedral_prism, true)
            .expect_err("tetrahedral topology with prism family must fail closed");
        assert!(error.message.contains("tetrahedral"), "{}", error.message);

        let mut inexact = valid_generic_swept_prism();
        inexact.exact_layer_count = Some(false);
        let error = validate_requested_layered_mesh("mesh", &inexact, true)
            .expect_err("strict swept prism with exact=false must fail closed");
        assert!(
            error.message.contains("exact_layer_count"),
            "{}",
            error.message
        );

        let incomplete = crate::ScriptBuilderPerGeometryMeshState {
            mesh_strategy: Some("swept_prism".to_string()),
            ..crate::ScriptBuilderPerGeometryMeshState::default()
        };
        validate_requested_layered_mesh("mesh", &incomplete, true)
            .expect_err("incomplete swept intent must fail before lowering");
    }

    #[test]
    fn generic_swept_prism_allows_reject_transition_policy() {
        validate_requested_layered_mesh("mesh", &valid_generic_swept_prism(), true)
            .expect("generic swept prism must preserve transition='reject'");
    }

    #[test]
    fn llg_stage_requires_explicit_timestep_policy() {
        let mut stage: crate::ScriptBuilderStageState = serde_json::from_value(serde_json::json!({
            "kind": "relax",
            "entrypoint_kind": "flat_relax",
            "relax_algorithm": "llg_overdamped"
        }))
        .expect("stage fixture should deserialize");

        let error = validate_stage_solver_state(&stage, 0)
            .expect_err("LLG stage without a timestep policy must fail closed");
        assert!(
            error
                .message
                .contains("explicit fixed or adaptive timestep policy"),
            "{}",
            error.message
        );

        stage.relax_algorithm = "projected_gradient_bb".to_string();
        validate_stage_solver_state(&stage, 0)
            .expect("direct minimization does not require an LLG timestep policy");

        let mut global_solver = crate::ScriptBuilderSolverState::default();
        global_solver.fixed_timestep.clear();
        validate_solver_state(&global_solver, false, "study.solver")
            .expect("non-executable global solver state may omit a timestep policy");
    }

    #[test]
    fn public_scene_stage_algorithm_vocabulary_enforces_llg_timestep_policy() {
        let explicit_llg: SceneDocument = serde_json::from_value(serde_json::json!({
            "version": "scene.v2",
            "study": { "stages": [{
                "kind": "relax",
                "entrypoint_kind": "flat_relax",
                "algorithm": "llg_overdamped",
                "fixed_timestep": "",
                "adaptive_timestep": null
            }]}
        }))
        .expect("public scene algorithm fixture should deserialize");
        assert_eq!(
            explicit_llg.study.stages[0].relax_algorithm,
            "llg_overdamped"
        );
        assert!(!explicit_llg.study.stages[0].extra.contains_key("algorithm"));
        let serialized = serde_json::to_value(&explicit_llg)
            .expect("the public scene should serialize with the canonical algorithm spelling");
        assert_eq!(
            serialized["study"]["stages"][0]["algorithm"],
            "llg_overdamped"
        );
        assert!(
            serialized["study"]["stages"][0]
                .get("relax_algorithm")
                .is_none(),
            "legacy relax_algorithm must not be emitted"
        );
        let error = validate_scene_document(&explicit_llg)
            .expect_err("public LLG stage without a timestep policy must fail closed");
        assert!(
            error
                .message
                .contains("explicit fixed or adaptive timestep policy"),
            "{}",
            error.message
        );
        crate::scene_document_to_script_builder_overrides(&explicit_llg)
            .expect_err("public adaptation must enforce the same LLG policy requirement");

        let omitted_algorithm: SceneDocument = serde_json::from_value(serde_json::json!({
            "version": "scene.v2",
            "study": { "stages": [{
                "kind": "relax",
                "entrypoint_kind": "flat_relax",
                "fixed_timestep": "",
                "adaptive_timestep": null
            }]}
        }))
        .expect("omitted algorithm fixture should deserialize");
        let error = validate_scene_document(&omitted_algorithm)
            .expect_err("the public default LLG stage must also require a timestep policy");
        assert!(
            error
                .message
                .contains("explicit fixed or adaptive timestep policy"),
            "{}",
            error.message
        );
        crate::scene_document_to_script_builder_overrides(&omitted_algorithm)
            .expect_err("public adaptation must resolve an omitted algorithm as LLG");

        let direct_minimizer: SceneDocument = serde_json::from_value(serde_json::json!({
            "version": "scene.v2",
            "study": { "stages": [{
                "kind": "relax",
                "entrypoint_kind": "flat_relax",
                "algorithm": "projected_gradient_bb",
                "fixed_timestep": "",
                "adaptive_timestep": null
            }]}
        }))
        .expect("direct-minimizer fixture should deserialize");
        validate_scene_document(&direct_minimizer)
            .expect("a direct minimizer does not require an LLG timestep policy");
        let overrides = crate::scene_document_to_script_builder_overrides(&direct_minimizer)
            .expect("a valid direct minimizer should adapt");
        assert_eq!(
            overrides["stages"][0]["relax_algorithm"],
            "projected_gradient_bb"
        );

        let conflicting_spellings = serde_json::from_value::<SceneDocument>(serde_json::json!({
            "version": "scene.v2",
            "study": { "stages": [{
                "kind": "relax",
                "entrypoint_kind": "flat_relax",
                "algorithm": "projected_gradient_bb",
                "relax_algorithm": "llg_overdamped"
            }]}
        }));
        assert!(
            conflicting_spellings.is_err(),
            "conflicting public and legacy algorithm spellings must fail closed"
        );
    }

    #[test]
    fn regional_field_drive_rejects_missing_scene_target() {
        let scene: SceneDocument = serde_json::from_value(serde_json::json!({
            "version": "scene.v2",
            "field_drives": { "drives": [{
                "id": "pulse", "name": "Pulse", "kind": "regional",
                "target": { "kind": "object", "object_id": "missing" },
                "amplitude_B_T": 0.001, "direction": [0.0, 1.0, 0.0],
                "spatial_profile": { "kind": "uniform" },
                "waveform": { "kind": "constant", "value": 1.0 },
                "time_origin": "stage_local",
                "activation": { "kind": "all_time_evolution" }
            }]}
        }))
        .expect("scene fixture should deserialize");

        let error = validate_scene_document(&scene).expect_err("missing target must fail closed");
        assert!(
            error.message.contains("missing object 'missing'"),
            "{}",
            error.message
        );
    }

    #[test]
    fn regional_field_drive_rejects_missing_activation_stage() {
        let scene: SceneDocument = serde_json::from_value(serde_json::json!({
            "version": "scene.v2",
            "field_drives": { "drives": [{
                "id": "pulse", "name": "Pulse", "kind": "regional",
                "target": { "kind": "global" },
                "amplitude_B_T": 0.001, "direction": [0.0, 1.0, 0.0],
                "spatial_profile": { "kind": "uniform" },
                "waveform": { "kind": "constant", "value": 1.0 },
                "time_origin": "stage_local",
                "activation": { "kind": "stage_ids", "stage_ids": ["missing-stage"] }
            }]}
        }))
        .expect("scene fixture should deserialize");

        let error = validate_scene_document(&scene).expect_err("missing stage must fail closed");
        assert!(
            error.message.contains("missing stage 'missing-stage'"),
            "{}",
            error.message
        );
    }

    fn region_owned_scene() -> SceneDocument {
        serde_json::from_value(serde_json::json!({
            "version": "scene.v2",
            "materials": [{
                "id": "mat:body",
                "name": "body material",
                "properties": { "Ms": 800000.0, "Aex": 1.0e-11, "alpha": 0.02 }
            }],
            "magnetization_assets": [{
                "id": "mag:body",
                "name": "body texture",
                "kind": "uniform",
                "value": [0.0, 0.0, 1.0]
            }],
            "objects": [{
                "id": "body",
                "name": "body",
                "geometry": { "geometry_kind": "box", "geometry_params": { "size": [1.0e-6, 1.0e-6, 1.0e-8] } },
                "material_ref": "mat:body",
                "magnetization_ref": "mag:body",
                "allocated_region_ids": ["body:r1"],
                "regions": [{
                    "region_id": "body:r1",
                    "owner_object": "body",
                    "name": "core",
                    "shape": {
                        "kind": "cylinder",
                        "radius": 8.0e-8,
                        "height": 1.0e-8,
                        "center": [0.0, 0.0, 0.0],
                        "axis": [0.0, 0.0, 1.0]
                    },
                    "frame": "object",
                    "enabled": true,
                    "priority": 10,
                    "mesh_policy": { "maximum_element_size": 1.0e-9, "minimum_element_size": 5.0e-10 },
                    "material_overrides": [{
                        "parameter": "Ms",
                        "value": { "kind": "constant", "value": 760000.0, "unit": "A/m" },
                        "priority": 10,
                        "conflict_policy": "error"
                    }],
                    "realization_policy": "conformal"
                }],
                "material_parameter_fields": [{
                    "assignment_id": "body_r1_aex",
                    "owner_object": "body",
                    "region_id": "body:r1",
                    "parameter": "Aex",
                    "value": { "kind": "constant", "value": 8.0e-12, "unit": "J/m" },
                    "priority": 11,
                    "conflict_policy": "error"
                }]
            }]
        }))
        .expect("test scene should deserialize")
    }

    #[test]
    fn scene_document_validation_accepts_region_owned_payloads() {
        validate_scene_document(&region_owned_scene()).expect("region-owned scene should validate");
    }

    #[test]
    fn scene_solver_rejects_malformed_present_demag_interval() {
        for value in ["not-a-number", "NaN", "inf", "0", "-1e-12"] {
            let mut scene = region_owned_scene();
            scene.study.solver.demag_interval_s = value.to_string();
            let error = validate_scene_document(&scene)
                .expect_err("present malformed demag_interval_s must fail closed");
            assert!(
                error.message.contains("demag_interval_s"),
                "unexpected validation error for {value}: {}",
                error.message
            );
        }
    }

    #[test]
    fn scene_document_validation_requires_scene_v2_for_region_owned_payloads() {
        let mut scene = region_owned_scene();
        scene.version = "scene.v1".to_string();

        let error =
            validate_scene_document(&scene).expect_err("scene.v1 must reject object regions");
        assert!(
            error.message.contains("authored object regions") && error.message.contains("scene.v2"),
            "{}",
            error.message
        );

        let mut scene = region_owned_scene();
        scene.version = "scene.v1".to_string();
        scene.objects[0].regions.clear();
        let error =
            validate_scene_document(&scene).expect_err("scene.v1 must reject allocated region ids");
        assert!(
            error.message.contains("allocated_region_ids") && error.message.contains("scene.v2"),
            "{}",
            error.message
        );

        let mut scene = region_owned_scene();
        scene.version = "scene.v1".to_string();
        scene.objects[0].regions.clear();
        scene.objects[0].allocated_region_ids.clear();
        let error = validate_scene_document(&scene)
            .expect_err("scene.v1 must reject material parameter fields");
        assert!(
            error.message.contains("material_parameter_fields")
                && error.message.contains("scene.v2"),
            "{}",
            error.message
        );

        let mut scene = region_owned_scene();
        scene.version = "scene.v1".to_string();
        scene.objects[0].regions.clear();
        scene.objects[0].allocated_region_ids.clear();
        scene.objects[0].material_parameter_fields.clear();
        scene.couplings.push(
            serde_json::from_value(serde_json::json!({
                "coupling_id": "draft_exchange",
                "kind": "exchange",
                "source": { "kind": "object", "object": "body" },
                "target": { "kind": "object", "object": "body" },
                "parameters": { "kind": "exchange", "mode": "disabled" }
            }))
            .unwrap(),
        );
        let error = validate_scene_document(&scene)
            .expect_err("scene.v1 must reject region-owned couplings");
        assert!(
            error.message.contains("couplings") && error.message.contains("scene.v2"),
            "{}",
            error.message
        );
    }

    #[test]
    fn scene_document_validation_rejects_region_ms_zero() {
        let mut scene = region_owned_scene();
        scene.objects[0].regions[0].material_overrides[0].value =
            crate::SceneMaterialParameterField::Constant {
                value: crate::SceneMaterialParameterValue::Scalar(0.0),
                unit: Some("A/m".to_string()),
            };

        let error = validate_scene_document(&scene).expect_err("Ms=0 must be rejected");
        assert!(
            error.message.contains("Ms must be > 0"),
            "{}",
            error.message
        );
    }

    #[test]
    fn scene_document_validation_rejects_unsupported_surface_selector() {
        let mut scene = region_owned_scene();
        scene.couplings.push(
            serde_json::from_value(serde_json::json!({
                "coupling_id": "body_surface_exchange",
                "kind": "exchange",
                "source": { "kind": "surface", "object": "body", "selector": "named_face" },
                "target": { "kind": "surface", "object": "body", "selector": "bottom" },
                "parameters": { "kind": "exchange", "mode": "disabled" }
            }))
            .expect("surface coupling should deserialize"),
        );

        let error = validate_scene_document(&scene)
            .expect_err("v1 must reject unsupported named surface selectors");
        assert!(error.message.contains("named_face"), "{}", error.message);
        assert!(
            error.message.contains("top/bottom/left/right/front/back"),
            "{}",
            error.message
        );
    }

    #[test]
    fn scene_document_validation_rejects_region_owner_mismatch() {
        let mut scene = region_owned_scene();
        scene.objects[0].regions[0].owner_object = "other".to_string();

        let error =
            validate_scene_document(&scene).expect_err("region owner mismatch must be rejected");
        assert!(
            error.message.contains("must match parent object id"),
            "{}",
            error.message
        );
    }

    #[test]
    fn scene_document_validation_rejects_object_frame_region_outside_owner_bounds() {
        let mut scene = region_owned_scene();
        if let crate::SceneRegionShape::Cylinder { radius, .. } =
            &mut scene.objects[0].regions[0].shape
        {
            *radius = 2.0e-6;
        }

        let error = validate_scene_document(&scene).expect_err("oversized region must be rejected");
        assert!(
            error.message.contains("REGION_OUTSIDE_OWNER_BOUNDS"),
            "{}",
            error.message
        );

        if let crate::SceneRegionShape::Cylinder { radius, center, .. } =
            &mut scene.objects[0].regions[0].shape
        {
            *radius = 8.0e-8;
            *center = [1.0e-6, 0.0, 0.0];
        }
        let error = validate_scene_document(&scene)
            .expect_err("region center outside owner bounds must be rejected");
        assert!(
            error.message.contains("REGION_OUTSIDE_OWNER_BOUNDS"),
            "{}",
            error.message
        );
    }

    #[test]
    fn scene_document_validation_uses_full_oblique_cylinder_extent() {
        let mut scene = region_owned_scene();
        scene.objects[0].geometry.bounds_min = Some([-1.0, -1.0, -1.0]);
        scene.objects[0].geometry.bounds_max = Some([1.0, 1.0, 1.0]);
        scene.objects[0].regions[0].shape = crate::SceneRegionShape::Cylinder {
            radius: 1.0,
            height: 2.0,
            center: [0.0, 0.0, 0.0],
            axis: [1.0, 1.0, 0.0],
        };

        let error = validate_scene_document(&scene)
            .expect_err("oblique cylinder AABB exceeds parent bounds");
        assert!(
            error.message.contains("REGION_OUTSIDE_OWNER_BOUNDS"),
            "{}",
            error.message
        );
    }

    #[test]
    fn scene_document_validation_rejects_invalid_region_coupling_endpoint() {
        let mut scene = region_owned_scene();
        scene.couplings.push(
            serde_json::from_value(serde_json::json!({
                "coupling_id": "bad_rkky",
                "kind": "rkky",
                "source": { "kind": "object", "object": "body" },
                "target": { "kind": "region", "object": "body", "region_id": "body:r1" },
                "parameters": { "kind": "rkky", "j1": -3.0e-4 },
                "capability_policy": "require_runtime"
            }))
            .unwrap(),
        );

        let error = validate_scene_document(&scene).expect_err("RKKY requires surface endpoints");
        assert!(
            error
                .message
                .contains("rkky/interlayer_exchange endpoints must be surfaces"),
            "{}",
            error.message
        );
    }

    #[test]
    fn scene_document_validation_rejects_duplicate_allocated_region_ids() {
        let mut scene = region_owned_scene();
        scene.objects[0]
            .allocated_region_ids
            .push("body:r1".to_string());

        let error =
            validate_scene_document(&scene).expect_err("duplicate allocated ids must be rejected");
        assert!(
            error
                .message
                .contains("allocated_region_ids contains duplicate id"),
            "{}",
            error.message
        );
    }

    #[test]
    fn scene_document_validation_rejects_equal_priority_material_conflicts() {
        let mut scene = region_owned_scene();
        scene.objects[0].material_parameter_fields[0].parameter =
            crate::SceneMaterialParameterName::Ms;
        scene.objects[0].material_parameter_fields[0].priority = 10;
        scene.objects[0].material_parameter_fields[0].value =
            crate::SceneMaterialParameterField::Constant {
                value: crate::SceneMaterialParameterValue::Scalar(700000.0),
                unit: Some("A/m".to_string()),
            };

        let error =
            validate_scene_document(&scene).expect_err("equal-priority conflict must be rejected");
        assert!(
            error
                .message
                .contains("region-owned material parameter conflict"),
            "{}",
            error.message
        );
    }

    #[test]
    fn scene_document_validation_accepts_complete_spin_authoring_graph() {
        let mut scene = region_owned_scene();
        scene.current_transports = serde_json::from_value(serde_json::json!([{
            "kind": "current_transport",
            "name": "transport",
            "model": "prescribed_density",
            "current_density": [1.0e11, 0.0, 0.0],
            "solve_region": "body"
        }]))
        .unwrap();
        scene.spin_torques = serde_json::from_value(serde_json::json!([{
            "id": "zl",
            "kind": "zhang_li",
            "current_source": "transport",
            "degree": 0.4,
            "beta": 0.02
        }]))
        .unwrap();
        scene.oersted_fields = serde_json::from_value(serde_json::json!([{
            "id": "oe",
            "kind": "oersted_field",
            "source": "transport",
            "model": "from_current_solution"
        }]))
        .unwrap();

        validate_scene_document(&scene).expect("complete graph must validate");
    }

    #[test]
    fn scene_document_validation_accepts_reciprocal_m2_transport_graph() {
        let mut scene = region_owned_scene();
        scene.current_transports = serde_json::from_value(serde_json::json!([{
            "kind": "current_transport",
            "name": "charge",
            "model": "magnetoresistive_poisson",
            "coupling": "bidirectional",
            "domain": [{"object_id": "body"}],
            "materials": [{
                "region": {"object_id": "body"},
                "material": {
                    "sigma_Spm": 5.0e6,
                    "sigma_parallel_Spm": 5.1e6,
                    "sigma_perpendicular_Spm": 4.9e6,
                    "sigma_AHE_Spm": 1.0e5
                }
            }],
            "boundaries": [{
                "kind": "voltage_electrode",
                "id": "left",
                "surfaces": [{"object_id": "body", "surface_id": "left", "orientation": [-1.0, 0.0, 0.0]}],
                "potential_V": 0.1
            }],
            "gauge": "dirichlet_reference",
            "solver": {
                "engine": "block_gmres",
                "linear": {"relative_tolerance": 1.0e-10, "absolute_tolerance": 0.0, "max_iterations": 10000},
                "physical_residual_version": "transport_balance_integrated_l2.v1",
                "operator_version": "fdm_coupled_charge_spin_fv_block_gmres.v1"
            }
        }]))
        .unwrap();
        scene.spin_transports = serde_json::from_value(serde_json::json!([{
            "schema_version": "spin_transport.v1",
            "id": "spin",
            "current_source_id": "charge",
            "mode": "steady",
            "domain": [{"object_id": "body"}],
            "materials": [{
                "region": {"object_id": "body"},
                "material": {
                    "sigma_s_Spm": 5.0e6,
                    "polarization_p": 0.4,
                    "theta_sh": 0.1,
                    "lambda_sf_m": 5.0e-9,
                    "lambda_j_m": "disabled",
                    "lambda_phi_m": "disabled"
                }
            }],
            "solver": {
                "engine": "gmres",
                "linear": {"relative_tolerance": 1.0e-8, "absolute_tolerance": 0.0, "max_iterations": 500},
                "physical_residual_version": "transport_balance_integrated_l2.v1",
                "operator_version": "fdm_coupled_charge_spin_fv_block_gmres.v1",
                "default_external_boundary": "spin_insulating",
                "reciprocal_nonlinear": {
                    "gmres_restart": 40,
                    "max_picard_iterations": 4,
                    "relative_update_tolerance": 1.0e-9,
                    "eta_transport": 0.25
                }
            },
            "requested_execution": {"discretization": "fdm", "device": "cpu", "precision": "double", "execution_mode": "strict"},
            "constitutive_version": "transport_constitutive.reciprocal.fullmag.v1"
        }])).unwrap();

        validate_scene_document(&scene).expect("complete M2 graph must validate");
        if let SceneSpinTransport::Known(module) = &mut scene.spin_transports[0] {
            module.solver.reciprocal_nonlinear = None;
        }
        let error =
            validate_scene_document(&scene).expect_err("M2 without nonlinear policy must fail");
        assert!(error.message.contains("reciprocal_nonlinear"), "{error}");
    }

    #[test]
    fn scene_document_validation_requires_physical_capacitance_for_transient_spin() {
        let mut scene = region_owned_scene();
        scene.current_transports = serde_json::from_value(serde_json::json!([{
            "kind": "current_transport",
            "name": "transport",
            "model": "prescribed_density",
            "coupling": "one_way",
            "current_density": [1.0e11, 0.0, 0.0]
        }]))
        .unwrap();
        let transient = serde_json::json!({
            "schema_version": "spin_transport.v1",
            "id": "spin",
            "current_source_id": "transport",
            "mode": "transient",
            "domain": [{"object_id": "body"}],
            "materials": [{
                "region": {"object_id": "body"},
                "material": {
                    "sigma_s_Spm": 5.0e6,
                    "polarization_p": 0.4,
                    "theta_sh": 0.1,
                    "lambda_sf_m": 5.0e-9,
                    "lambda_j_m": "disabled",
                    "lambda_phi_m": "disabled",
                    "spin_capacitance_As_per_V_m3": 2.0,
                    "capacitance_formula_version": "dos_isotropic_nonmagnetic.fullmag.v1"
                }
            }],
            "solver": {
                "engine": "gmres",
                "linear": {"relative_tolerance": 1.0e-8, "absolute_tolerance": 0.0, "max_iterations": 500},
                "physical_residual_version": "transport_balance_integrated_l2.v1",
                "operator_version": "fv_spin_upwind_v1",
                "default_external_boundary": "spin_insulating"
            },
            "requested_execution": {"discretization": "fdm", "device": "cpu", "precision": "double", "execution_mode": "strict"},
            "constitutive_version": "transport_constitutive.one_way.fullmag.v1"
        });
        scene.spin_transports =
            serde_json::from_value(serde_json::json!([transient.clone()])).unwrap();
        validate_scene_document(&scene).expect("physical transient contract must validate");

        let mut dos_only = transient.clone();
        dos_only["materials"][0]["material"]
            .as_object_mut()
            .unwrap()
            .remove("spin_capacitance_As_per_V_m3");
        dos_only["materials"][0]["material"]["density_of_states_per_spin_Jinv_m3"] =
            serde_json::json!(2.0);
        scene.spin_transports = serde_json::from_value(serde_json::json!([dos_only])).unwrap();
        validate_scene_document(&scene).expect("DOS adapter must qualify transient material");

        let mut inconsistent = transient.clone();
        inconsistent["materials"][0]["material"]["density_of_states_per_spin_Jinv_m3"] =
            serde_json::json!(2.0);
        scene.spin_transports = serde_json::from_value(serde_json::json!([inconsistent])).unwrap();
        let error = validate_scene_document(&scene)
            .expect_err("inconsistent explicit capacitance and DOS must fail");
        assert!(error.message.contains("must equal e^2 times density_of_states"), "{error}");

        let mut unsupported = transient.clone();
        unsupported["materials"][0]["material"]["capacitance_formula_version"] =
            serde_json::json!("dos_constant.fullmag.v1");
        scene.spin_transports = serde_json::from_value(serde_json::json!([unsupported])).unwrap();
        let error = validate_scene_document(&scene)
            .expect_err("unversioned DOS convention must fail closed");
        assert!(
            error
                .message
                .contains("unsupported capacitance_formula_version"),
            "{error}"
        );

        let mut missing = transient;
        missing["materials"][0]["material"]
            .as_object_mut()
            .unwrap()
            .remove("spin_capacitance_As_per_V_m3");
        missing["materials"][0]["material"]["capacitance_formula_version"] =
            serde_json::json!("dos_isotropic_nonmagnetic.fullmag.v1");
        scene.spin_transports = serde_json::from_value(serde_json::json!([missing])).unwrap();
        let error = validate_scene_document(&scene).expect_err("partial capacitance must fail");
        assert!(
            error
                .message
                .contains("requires spin capacitance or density of states"),
            "{error}"
        );
    }

    #[test]
    fn scene_document_validation_accepts_complete_ohmic_charge_contract() {
        let mut scene = region_owned_scene();
        scene.current_transports = serde_json::from_value(serde_json::json!([{
            "kind": "current_transport",
            "name": "charge",
            "model": "ohmic_poisson",
            "coupling": "one_way",
            "domain": [{"object_id": "body"}],
            "materials": [{
                "region": {"object_id": "body"},
                "material": {"sigma_Spm": 5.0e6}
            }],
            "boundaries": [{
                "kind": "voltage_electrode",
                "id": "left",
                "surfaces": [{"object_id": "body", "surface_id": "left", "orientation": [-1.0, 0.0, 0.0]}],
                "potential_V": 0.1
            }],
            "gauge": "dirichlet_reference",
            "solver": {
                "engine": "cg",
                "linear": {"relative_tolerance": 1.0e-10, "absolute_tolerance": 0.0, "max_iterations": 10000},
                "physical_residual_version": "charge_balance_integrated_l2.v1",
                "operator_version": "fv_charge_harmonic_v1"
            }
        }]))
        .unwrap();

        validate_scene_document(&scene).expect("complete ohmic charge contract must validate");
    }

    #[test]
    fn scene_document_validation_rejects_conflicting_charge_gauge() {
        let mut scene = region_owned_scene();
        scene.current_transports = serde_json::from_value(serde_json::json!([{
            "kind": "current_transport",
            "name": "charge",
            "model": "ohmic_poisson",
            "domain": [{"object_id": "body"}],
            "materials": [{
                "region": {"object_id": "body"},
                "material": {"sigma_Spm": 5.0e6}
            }],
            "boundaries": [{
                "kind": "voltage_electrode",
                "id": "left",
                "surfaces": [{"object_id": "body", "surface_id": "left", "orientation": [-1.0, 0.0, 0.0]}],
                "potential_V": 0.1
            }],
            "gauge": "zero_mean",
            "solver": {
                "engine": "cg",
                "linear": {"relative_tolerance": 1.0e-10, "absolute_tolerance": 0.0, "max_iterations": 10000},
                "physical_residual_version": "charge_balance_integrated_l2.v1",
                "operator_version": "fv_charge_harmonic_v1"
            }
        }]))
        .unwrap();

        let error = validate_scene_document(&scene).expect_err("gauge conflict must fail");
        assert!(error.message.contains("zero_mean conflicts"), "{error}");
    }

    #[test]
    fn scene_document_validation_rejects_spin_authoring_without_partial_commit() {
        let mut scene = region_owned_scene();
        scene.current_transports = serde_json::from_value(serde_json::json!([{
            "kind": "current_transport",
            "name": "transport",
            "model": "prescribed_density",
            "current_density": [1.0e11, 0.0, 0.0],
            "solve_region": "body"
        }]))
        .unwrap();
        scene.oersted_fields = serde_json::from_value(serde_json::json!([{
            "id": "oe",
            "kind": "oersted_cylinder",
            "current": 0.001,
            "radius": 1.0e-8,
            "center": [0.0, 0.0, 0.0],
            "axis": [0.0, 0.0, 0.0]
        }]))
        .unwrap();

        let error = validate_scene_document(&scene).expect_err("zero axis must be rejected");
        assert!(error.message.contains("axis") && error.message.contains("nonzero"));
    }
}

fn validate_region_owned_scene_payloads(
    scene: &SceneDocument,
    object_ids: &BTreeSet<String>,
) -> Result<(), SceneDocumentValidationError> {
    let mut region_ids = BTreeSet::new();
    let mut region_names = BTreeSet::new();
    let mut region_owner_by_id = BTreeMap::new();
    let mut material_supports = Vec::new();

    for object in &scene.objects {
        let owner_bounds = object_region_owner_bounds(&object.geometry);
        let mut allocated_region_ids = BTreeSet::new();
        for allocated_id in &object.allocated_region_ids {
            if allocated_id.trim().is_empty() {
                return Err(SceneDocumentValidationError::new(format!(
                    "object '{}' allocated_region_ids must not contain empty ids",
                    object.id
                )));
            }
            if !allocated_region_ids.insert(allocated_id.as_str()) {
                return Err(SceneDocumentValidationError::new(format!(
                    "object '{}' allocated_region_ids contains duplicate id '{}'",
                    object.id, allocated_id
                )));
            }
        }

        for (index, value) in object.regions.iter().enumerate() {
            let region: ObjectRegionIR = value.clone().into();
            if region.region_id.trim().is_empty() {
                return Err(SceneDocumentValidationError::new(format!(
                    "objects['{}'].regions[{index}] region_id must not be empty",
                    object.id
                )));
            }
            if !region_ids.insert(region.region_id.clone()) {
                return Err(SceneDocumentValidationError::new(format!(
                    "duplicate object region id '{}'",
                    region.region_id
                )));
            }
            if region.owner_object != object.id {
                return Err(SceneDocumentValidationError::new(format!(
                    "objects['{}'].regions[{index}] owner_object '{}' must match parent object id",
                    object.id, region.owner_object
                )));
            }
            if region.name.trim().is_empty() {
                return Err(SceneDocumentValidationError::new(format!(
                    "objects['{}'].regions[{index}] name must not be empty",
                    object.id
                )));
            }
            if !region_names.insert((region.owner_object.clone(), region.name.clone())) {
                return Err(SceneDocumentValidationError::new(format!(
                    "duplicate object region name '{}' for owner '{}'",
                    region.name, region.owner_object
                )));
            }
            validate_object_region_shape(
                &format!("objects['{}'].regions[{index}]", object.id),
                &region.shape,
            )?;
            validate_object_region_inside_owner_bounds(
                &format!("objects['{}'].regions[{index}]", object.id),
                &region,
                owner_bounds,
            )?;
            if let Some(mesh_policy) = &region.mesh_policy {
                validate_region_mesh_policy(
                    &format!("objects['{}'].regions[{index}]", object.id),
                    mesh_policy,
                )?;
            }
            if let Some(material_transition) = &region.material_transition {
                validate_material_transition(
                    &format!("objects['{}'].regions[{index}]", object.id),
                    material_transition,
                )?;
            }
            for (override_index, material_override) in region.material_overrides.iter().enumerate()
            {
                material_supports.push(SceneMaterialSupport {
                    source: format!(
                        "objects['{}'].regions[{index}].material_overrides[{override_index}]",
                        object.id
                    ),
                    owner_object: region.owner_object.clone(),
                    region_id: Some(region.region_id.clone()),
                    parameter: material_override.parameter,
                    priority: material_override.priority,
                });
                validate_material_parameter_field(
                    &format!(
                        "objects['{}'].regions[{index}].material_overrides[{override_index}]",
                        object.id
                    ),
                    material_override.parameter,
                    &material_override.value,
                )?;
            }
            region_owner_by_id.insert(region.region_id, region.owner_object);
        }
    }

    let mut assignment_ids = BTreeSet::new();
    for object in &scene.objects {
        for (index, value) in object.material_parameter_fields.iter().enumerate() {
            let assignment: MaterialParameterAssignmentIR = value.clone().into();
            if assignment.assignment_id.trim().is_empty() {
                return Err(SceneDocumentValidationError::new(format!(
                    "objects['{}'].material_parameter_fields[{index}] assignment_id must not be empty",
                    object.id
                )));
            }
            if !assignment_ids.insert(assignment.assignment_id.clone()) {
                return Err(SceneDocumentValidationError::new(format!(
                    "duplicate material parameter assignment id '{}'",
                    assignment.assignment_id
                )));
            }
            validate_scene_object_ref(
                &format!(
                    "objects['{}'].material_parameter_fields[{index}].owner_object",
                    object.id
                ),
                &assignment.owner_object,
                object_ids,
            )?;
            if assignment.owner_object != object.id {
                return Err(SceneDocumentValidationError::new(format!(
                    "objects['{}'].material_parameter_fields[{index}] owner_object '{}' must match parent object id",
                    object.id, assignment.owner_object
                )));
            }
            if let Some(region_id) = assignment.region_id.as_deref() {
                match region_owner_by_id.get(region_id) {
                    Some(owner) if owner == &assignment.owner_object => {}
                    Some(owner) => {
                        return Err(SceneDocumentValidationError::new(format!(
                            "objects['{}'].material_parameter_fields[{index}] region_id '{}' belongs to owner '{}', not '{}'",
                            object.id, region_id, owner, assignment.owner_object
                        )));
                    }
                    None => {
                        return Err(SceneDocumentValidationError::new(format!(
                            "objects['{}'].material_parameter_fields[{index}] region_id '{}' does not reference an authored object region",
                            object.id, region_id
                        )));
                    }
                }
            }
            validate_material_parameter_field(
                &format!(
                    "objects['{}'].material_parameter_fields[{index}]",
                    object.id
                ),
                assignment.parameter,
                &assignment.value,
            )?;
            material_supports.push(SceneMaterialSupport {
                source: format!(
                    "objects['{}'].material_parameter_fields[{index}]",
                    object.id
                ),
                owner_object: assignment.owner_object,
                region_id: assignment.region_id,
                parameter: assignment.parameter,
                priority: assignment.priority,
            });
        }
    }
    validate_scene_material_conflicts(&material_supports)?;

    let mut coupling_ids = BTreeSet::new();
    for (index, value) in scene.couplings.iter().enumerate() {
        let coupling: CouplingIR = value.clone().into();
        if coupling.coupling_id.trim().is_empty() {
            return Err(SceneDocumentValidationError::new(format!(
                "couplings[{index}] coupling_id must not be empty"
            )));
        }
        if !coupling_ids.insert(coupling.coupling_id.clone()) {
            return Err(SceneDocumentValidationError::new(format!(
                "duplicate coupling id '{}'",
                coupling.coupling_id
            )));
        }
        validate_coupling_endpoint(
            &format!("couplings[{index}].source"),
            &coupling.source,
            object_ids,
            &region_owner_by_id,
        )?;
        validate_coupling_endpoint(
            &format!("couplings[{index}].target"),
            &coupling.target,
            object_ids,
            &region_owner_by_id,
        )?;
        validate_coupling_parameters(index, &coupling)?;
    }

    Ok(())
}

struct SceneMaterialSupport {
    source: String,
    owner_object: String,
    region_id: Option<String>,
    parameter: MaterialParameterNameIR,
    priority: i32,
}

fn validate_scene_material_conflicts(
    supports: &[SceneMaterialSupport],
) -> Result<(), SceneDocumentValidationError> {
    for left_index in 0..supports.len() {
        for right_index in (left_index + 1)..supports.len() {
            let left = &supports[left_index];
            let right = &supports[right_index];
            if scene_material_supports_overlap(left, right) {
                return Err(SceneDocumentValidationError::new(format!(
                    "region-owned material parameter conflict: {} and {} both assign {:?} on overlapping support at priority {}; use distinct priorities",
                    left.source, right.source, left.parameter, left.priority
                )));
            }
        }
    }
    Ok(())
}

fn scene_material_supports_overlap(
    left: &SceneMaterialSupport,
    right: &SceneMaterialSupport,
) -> bool {
    left.owner_object == right.owner_object
        && left.parameter == right.parameter
        && left.priority == right.priority
        && (left.region_id.is_none()
            || right.region_id.is_none()
            || left.region_id == right.region_id)
}

fn validate_scene_object_ref(
    path: &str,
    object: &str,
    object_ids: &BTreeSet<String>,
) -> Result<(), SceneDocumentValidationError> {
    if object.trim().is_empty() {
        return Err(SceneDocumentValidationError::new(format!(
            "{path} must not be empty"
        )));
    }
    if object == "airbox" || object == "__air__" {
        return Err(SceneDocumentValidationError::new(format!(
            "{path} must reference a magnetic object, not airbox"
        )));
    }
    if !object_ids.contains(object) {
        return Err(SceneDocumentValidationError::new(format!(
            "{path} references missing object '{object}'"
        )));
    }
    Ok(())
}

fn validate_object_region_shape(
    path: &str,
    shape: &RegionShapeIR,
) -> Result<(), SceneDocumentValidationError> {
    match shape {
        RegionShapeIR::Box { size, center } => {
            if size.iter().any(|value| !value.is_finite() || *value <= 0.0) {
                return Err(SceneDocumentValidationError::new(format!(
                    "{path}.shape box size components must be finite and > 0"
                )));
            }
            validate_finite_vec3(&format!("{path}.shape.center"), center)?;
        }
        RegionShapeIR::Cylinder {
            radius,
            height,
            center,
            axis,
        } => {
            if !radius.is_finite() || *radius <= 0.0 {
                return Err(SceneDocumentValidationError::new(format!(
                    "{path}.shape cylinder radius must be finite and > 0"
                )));
            }
            if !height.is_finite() || *height <= 0.0 {
                return Err(SceneDocumentValidationError::new(format!(
                    "{path}.shape cylinder height must be finite and > 0"
                )));
            }
            validate_finite_vec3(&format!("{path}.shape.center"), center)?;
            validate_finite_vec3(&format!("{path}.shape.axis"), axis)?;
            let norm_sq = axis.iter().map(|value| value * value).sum::<f64>();
            if norm_sq <= 1e-30 {
                return Err(SceneDocumentValidationError::new(format!(
                    "{path}.shape cylinder axis must be non-zero"
                )));
            }
        }
        RegionShapeIR::Sphere { radius, center } => {
            if !radius.is_finite() || *radius <= 0.0 {
                return Err(SceneDocumentValidationError::new(format!(
                    "{path}.shape sphere radius must be finite and > 0"
                )));
            }
            validate_finite_vec3(&format!("{path}.shape.center"), center)?;
        }
        RegionShapeIR::Csg { expression } => {
            if expression.name().trim().is_empty() {
                return Err(SceneDocumentValidationError::new(format!(
                    "{path}.shape csg expression name must not be empty"
                )));
            }
        }
    }
    Ok(())
}

#[derive(Clone, Copy)]
struct ObjectRegionOwnerBounds {
    center: [f64; 3],
    size: [f64; 3],
}

fn validate_object_region_inside_owner_bounds(
    path: &str,
    region: &ObjectRegionIR,
    owner_bounds: Option<ObjectRegionOwnerBounds>,
) -> Result<(), SceneDocumentValidationError> {
    if region.frame != RegionFrameIR::Object {
        return Ok(());
    }
    let Some(owner_bounds) = owner_bounds else {
        return Ok(());
    };
    let Some((center, half_extents)) = region_shape_local_aabb(&region.shape) else {
        return Ok(());
    };
    const TOLERANCE: f64 = 1e-18;
    for axis in 0..3 {
        let region_min = center[axis] - half_extents[axis];
        let region_max = center[axis] + half_extents[axis];
        let owner_min = owner_bounds.center[axis] - owner_bounds.size[axis] * 0.5;
        let owner_max = owner_bounds.center[axis] + owner_bounds.size[axis] * 0.5;
        if region_min < owner_min - TOLERANCE || region_max > owner_max + TOLERANCE {
            return Err(SceneDocumentValidationError::new(format!(
                "{path} REGION_OUTSIDE_OWNER_BOUNDS: object-frame region '{}' exceeds parent object bounds on axis {axis}; resize or move the region inside its owner",
                region.region_id
            )));
        }
    }
    Ok(())
}

fn object_region_owner_bounds(geometry: &crate::SceneGeometry) -> Option<ObjectRegionOwnerBounds> {
    if let (Some(min), Some(max)) = (geometry.bounds_min, geometry.bounds_max) {
        return owner_bounds_from_min_max(min, max);
    }

    let params = geometry.geometry_params.as_object()?;
    let kind = geometry.geometry_kind.trim().to_ascii_lowercase();
    let center = vec3_param(params, "center").unwrap_or([0.0, 0.0, 0.0]);
    let size = match kind.as_str() {
        "box" => vec3_param(params, "size").or_else(|| vec3_param(params, "dimensions")),
        "cylinder" => {
            let radius = number_param(params, "radius")?;
            let height = number_param(params, "height")?;
            Some([radius * 2.0, radius * 2.0, height])
        }
        "archwaveguide" | "arch_waveguide" => {
            let length = number_param(params, "length")?;
            let width = number_param(params, "width")?;
            let height = number_param(params, "height")?;
            Some([length, width, height])
        }
        "ellipsoid" => {
            let rx = number_param(params, "rx")?;
            let ry = number_param(params, "ry")?;
            let rz = number_param(params, "rz")?;
            Some([rx * 2.0, ry * 2.0, rz * 2.0])
        }
        _ => None,
    }?;
    owner_bounds_from_center_size(center, size)
}

fn owner_bounds_from_min_max(min: [f64; 3], max: [f64; 3]) -> Option<ObjectRegionOwnerBounds> {
    owner_bounds_from_center_size(
        [
            0.5 * (min[0] + max[0]),
            0.5 * (min[1] + max[1]),
            0.5 * (min[2] + max[2]),
        ],
        [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    )
}

fn owner_bounds_from_center_size(
    center: [f64; 3],
    size: [f64; 3],
) -> Option<ObjectRegionOwnerBounds> {
    if center.iter().any(|value| !value.is_finite())
        || size.iter().any(|value| !value.is_finite() || *value <= 0.0)
    {
        return None;
    }
    Some(ObjectRegionOwnerBounds { center, size })
}

fn region_shape_local_aabb(shape: &RegionShapeIR) -> Option<([f64; 3], [f64; 3])> {
    match shape {
        RegionShapeIR::Box { center, size } => {
            Some((*center, [size[0] * 0.5, size[1] * 0.5, size[2] * 0.5]))
        }
        RegionShapeIR::Sphere { center, radius } => Some((*center, [*radius; 3])),
        RegionShapeIR::Cylinder {
            center,
            radius,
            height,
            axis,
        } => {
            let norm = axis.iter().map(|value| value * value).sum::<f64>().sqrt();
            if norm <= 1e-15 {
                return None;
            }
            let unit = axis.map(|value| value / norm);
            let half_height = *height * 0.5;
            let half_extents = [0, 1, 2].map(|index| {
                unit[index].abs() * half_height
                    + *radius * (1.0 - unit[index] * unit[index]).max(0.0).sqrt()
            });
            Some((*center, half_extents))
        }
        RegionShapeIR::Csg { .. } => None,
    }
}

fn vec3_param(params: &serde_json::Map<String, Value>, key: &str) -> Option<[f64; 3]> {
    let values = params.get(key)?.as_array()?;
    if values.len() != 3 {
        return None;
    }
    Some([
        values[0].as_f64()?,
        values[1].as_f64()?,
        values[2].as_f64()?,
    ])
}

fn number_param(params: &serde_json::Map<String, Value>, key: &str) -> Option<f64> {
    params.get(key)?.as_f64()
}

fn validate_region_mesh_policy(
    path: &str,
    policy: &RegionMeshPolicyIR,
) -> Result<(), SceneDocumentValidationError> {
    if policy
        .maximum_element_size
        .is_some_and(|value| !value.is_finite() || value <= 0.0)
    {
        return Err(SceneDocumentValidationError::new(format!(
            "{path}.mesh_policy.maximum_element_size must be finite and > 0"
        )));
    }
    if policy
        .minimum_element_size
        .is_some_and(|value| !value.is_finite() || value <= 0.0)
    {
        return Err(SceneDocumentValidationError::new(format!(
            "{path}.mesh_policy.minimum_element_size must be finite and > 0"
        )));
    }
    if policy
        .transition_distance
        .is_some_and(|value| !value.is_finite() || value < 0.0)
    {
        return Err(SceneDocumentValidationError::new(format!(
            "{path}.mesh_policy.transition_distance must be finite and >= 0"
        )));
    }
    if policy.order.is_some_and(|order| order == 0) {
        return Err(SceneDocumentValidationError::new(format!(
            "{path}.mesh_policy.order must be >= 1"
        )));
    }
    Ok(())
}

fn validate_material_transition(
    path: &str,
    transition: &MaterialTransitionSpecIR,
) -> Result<(), SceneDocumentValidationError> {
    match transition {
        MaterialTransitionSpecIR::MeshRelative { cells, .. } if *cells == 0 => {
            Err(SceneDocumentValidationError::new(format!(
                "{path}.material_transition.cells must be >= 1"
            )))
        }
        MaterialTransitionSpecIR::Metric { width, .. } if !width.is_finite() || *width <= 0.0 => {
            Err(SceneDocumentValidationError::new(format!(
                "{path}.material_transition.width must be finite and > 0"
            )))
        }
        _ => Ok(()),
    }
}

fn validate_material_parameter_field(
    path: &str,
    parameter: MaterialParameterNameIR,
    field: &MaterialParameterFieldIR,
) -> Result<(), SceneDocumentValidationError> {
    match field {
        MaterialParameterFieldIR::Constant { value, .. } => {
            if let Some(number) = value.as_f64() {
                validate_material_parameter_number(path, parameter, number)?;
            } else if parameter != MaterialParameterNameIR::AnisotropyAxis {
                return Err(SceneDocumentValidationError::new(format!(
                    "{path} constant value must be numeric"
                )));
            }
        }
        MaterialParameterFieldIR::Linear { base, gradient, .. } => {
            validate_material_parameter_number(path, parameter, *base)?;
            validate_finite_vec3(&format!("{path}.gradient"), gradient)?;
        }
        MaterialParameterFieldIR::Radial {
            center,
            radius,
            inside,
            outside,
            ..
        } => {
            validate_finite_vec3(&format!("{path}.center"), center)?;
            if !radius.is_finite() || *radius <= 0.0 {
                return Err(SceneDocumentValidationError::new(format!(
                    "{path}.radius must be finite and > 0"
                )));
            }
            validate_material_parameter_number(path, parameter, *inside)?;
            validate_material_parameter_number(path, parameter, *outside)?;
        }
        MaterialParameterFieldIR::Sampled {
            asset_id,
            component_count,
            unit,
            ..
        } => {
            if asset_id.trim().is_empty() {
                return Err(SceneDocumentValidationError::new(format!(
                    "{path}.asset_id must not be empty"
                )));
            }
            if *component_count == 0 {
                return Err(SceneDocumentValidationError::new(format!(
                    "{path}.component_count must be > 0"
                )));
            }
            if unit.trim().is_empty() {
                return Err(SceneDocumentValidationError::new(format!(
                    "{path}.unit must not be empty"
                )));
            }
        }
    }
    Ok(())
}

fn validate_material_parameter_number(
    path: &str,
    parameter: MaterialParameterNameIR,
    value: f64,
) -> Result<(), SceneDocumentValidationError> {
    if !value.is_finite() {
        return Err(SceneDocumentValidationError::new(format!(
            "{path} value must be finite"
        )));
    }
    match parameter {
        MaterialParameterNameIR::Ms if value <= 0.0 => Err(SceneDocumentValidationError::new(
            format!("{path} Ms must be > 0"),
        )),
        MaterialParameterNameIR::Aex | MaterialParameterNameIR::Alpha if value < 0.0 => Err(
            SceneDocumentValidationError::new(format!("{path} {:?} must be >= 0", parameter)),
        ),
        _ => Ok(()),
    }
}

fn validate_finite_vec3(path: &str, vector: &[f64; 3]) -> Result<(), SceneDocumentValidationError> {
    if vector.iter().any(|value| !value.is_finite()) {
        return Err(SceneDocumentValidationError::new(format!(
            "{path} must contain finite values"
        )));
    }
    Ok(())
}

fn validate_coupling_endpoint(
    path: &str,
    endpoint: &CouplingEndpointIR,
    object_ids: &BTreeSet<String>,
    region_owner_by_id: &BTreeMap<String, String>,
) -> Result<(), SceneDocumentValidationError> {
    match endpoint {
        CouplingEndpointIR::Object { object } | CouplingEndpointIR::Surface { object, .. } => {
            validate_scene_object_ref(path, object, object_ids)?;
        }
        CouplingEndpointIR::Region { object, region_id } => {
            validate_scene_object_ref(path, object, object_ids)?;
            match region_owner_by_id.get(region_id) {
                Some(owner) if owner == object => {}
                Some(owner) => {
                    return Err(SceneDocumentValidationError::new(format!(
                        "{path} region_id '{}' belongs to owner '{}', not '{}'",
                        region_id, owner, object
                    )));
                }
                None => {
                    return Err(SceneDocumentValidationError::new(format!(
                        "{path} region_id '{}' does not reference an authored object region",
                        region_id
                    )));
                }
            }
        }
    }
    if let CouplingEndpointIR::Surface { selector, .. } = endpoint {
        let normalized = selector.trim().to_ascii_lowercase();
        if normalized.is_empty() {
            return Err(SceneDocumentValidationError::new(format!(
                "{path}.selector must not be empty"
            )));
        }
        if !matches!(
            normalized.as_str(),
            "top" | "bottom" | "left" | "right" | "front" | "back"
        ) {
            return Err(SceneDocumentValidationError::new(format!(
                "{path}.selector '{}' is unsupported in v1; use top/bottom/left/right/front/back",
                selector
            )));
        }
    }
    Ok(())
}

fn validate_coupling_parameters(
    index: usize,
    coupling: &CouplingIR,
) -> Result<(), SceneDocumentValidationError> {
    match (&coupling.kind, &coupling.parameters) {
        (
            CouplingKindIR::Exchange,
            CouplingParametersIR::Exchange {
                mode,
                scale,
                inter_exchange,
            },
        ) => {
            if scale.is_some_and(|value| !value.is_finite() || value < 0.0) {
                return Err(SceneDocumentValidationError::new(format!(
                    "couplings[{index}] exchange scale must be finite and >= 0"
                )));
            }
            match mode {
                ExchangeCouplingModeIR::HarmonicMean if inter_exchange.is_some() => {
                    return Err(SceneDocumentValidationError::new(format!(
                        "couplings[{index}] harmonic_mean exchange must not define inter_exchange"
                    )));
                }
                ExchangeCouplingModeIR::Explicit if !inter_exchange.is_some_and(f64::is_finite) => {
                    return Err(SceneDocumentValidationError::new(format!(
                        "couplings[{index}] explicit exchange requires finite inter_exchange"
                    )));
                }
                _ => {}
            }
        }
        (CouplingKindIR::Rkky, CouplingParametersIR::Rkky { j1 })
        | (
            CouplingKindIR::InterlayerExchange,
            CouplingParametersIR::InterlayerExchange { j1, .. },
        ) => {
            if !j1.is_finite() {
                return Err(SceneDocumentValidationError::new(format!(
                    "couplings[{index}] J1 must be finite"
                )));
            }
            if !matches!(coupling.source, CouplingEndpointIR::Surface { .. })
                || !matches!(coupling.target, CouplingEndpointIR::Surface { .. })
            {
                return Err(SceneDocumentValidationError::new(format!(
                    "couplings[{index}] rkky/interlayer_exchange endpoints must be surfaces"
                )));
            }
        }
        _ => {
            return Err(SceneDocumentValidationError::new(format!(
                "couplings[{index}] kind and parameters kind must match"
            )));
        }
    }
    Ok(())
}
