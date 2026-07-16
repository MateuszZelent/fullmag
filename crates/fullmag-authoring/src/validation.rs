use crate::{SceneDocument, StudyPipelineDocument, StudyPipelineNode};
use fullmag_ir::{
    CouplingEndpointIR, CouplingIR, CouplingKindIR, CouplingParametersIR, ExchangeCouplingModeIR,
    DriveActivationIR, FieldSpatialProfileIR, FieldTargetIR,
    MaterialParameterAssignmentIR, MaterialParameterFieldIR, MaterialParameterNameIR,
    MaterialTransitionSpecIR, ObjectRegionIR, RegionFrameIR, RegionMeshPolicyIR, RegionShapeIR,
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

    if let Some(document) = &scene.study.study_pipeline {
        validate_study_pipeline_document(document)?;
    }
    validate_scene_field_drives(scene, &object_ids)?;

    Ok(())
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
                let object = scene.objects.iter().find(|object| object.id == *object_id).unwrap();
                let exists = object.allocated_region_ids.iter().any(|id| id == region_id)
                    || object.regions.iter().any(|region| region.region_id == *region_id);
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
        })).expect("scene fixture should deserialize");

        let error = validate_scene_document(&scene).expect_err("missing target must fail closed");
        assert!(error.message.contains("missing object 'missing'"), "{}", error.message);
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
        })).expect("scene fixture should deserialize");

        let error = validate_scene_document(&scene).expect_err("missing stage must fail closed");
        assert!(error.message.contains("missing stage 'missing-stage'"), "{}", error.message);
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
