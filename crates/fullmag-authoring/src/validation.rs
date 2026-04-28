use crate::{SceneDocument, StudyPipelineDocument, StudyPipelineNode};
use std::collections::BTreeSet;
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
    if scene.version != "scene.v1" {
        return Err(SceneDocumentValidationError::new(format!(
            "unsupported SceneDocument version '{}'",
            scene.version
        )));
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

    if let Some(document) = &scene.study.study_pipeline {
        validate_study_pipeline_document(document)?;
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
