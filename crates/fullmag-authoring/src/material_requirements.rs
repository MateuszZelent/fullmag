use std::fmt;

use crate::{SceneDocument, SceneMaterialAsset, SceneObject};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SceneSolveMaterialError {
    MissingMaterial {
        material_id: String,
        object_id: String,
    },
    MissingMs {
        object_id: String,
    },
    MissingAex {
        object_id: String,
    },
}

impl fmt::Display for SceneSolveMaterialError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingMaterial {
                material_id,
                object_id,
            } => write!(
                formatter,
                "missing material '{material_id}' for object '{object_id}'"
            ),
            Self::MissingMs { object_id } => {
                write!(
                    formatter,
                    "missing Ms material property for object '{object_id}'"
                )
            }
            Self::MissingAex { object_id } => write!(
                formatter,
                "missing Aex material property for object '{object_id}'"
            ),
        }
    }
}

impl std::error::Error for SceneSolveMaterialError {}

#[derive(Debug, Clone, Copy)]
pub struct ResolvedSceneSolveMaterial<'a> {
    pub asset: &'a SceneMaterialAsset,
    pub exchange_stiffness: f64,
    pub saturation_magnetisation: f64,
}

pub fn scene_solve_objects(scene: &SceneDocument) -> impl Iterator<Item = &SceneObject> {
    scene
        .objects
        .iter()
        .filter(|object| object.role == "magnet")
}

/// Returns whether the scene still lacks a material or initial magnetization
/// required to build an executable solver model.
pub fn scene_document_has_unresolved_solve_prerequisites(scene: &SceneDocument) -> bool {
    let magnetization_ids = scene
        .magnetization_assets
        .iter()
        .map(|asset| asset.id.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    scene_solve_objects(scene).any(|object| {
        resolve_scene_object_solve_material(scene, object).is_err()
            || !object
                .magnetization_ref
                .as_deref()
                .is_some_and(|reference| magnetization_ids.contains(reference))
    })
}

pub fn resolve_scene_object_solve_material<'a>(
    scene: &'a SceneDocument,
    object: &SceneObject,
) -> Result<ResolvedSceneSolveMaterial<'a>, SceneSolveMaterialError> {
    let material = scene
        .materials
        .iter()
        .find(|candidate| candidate.id == object.material_ref)
        .ok_or_else(|| SceneSolveMaterialError::MissingMaterial {
            material_id: object.material_ref.clone(),
            object_id: object.id.clone(),
        })?;
    let exchange_stiffness =
        material
            .properties
            .aex
            .ok_or_else(|| SceneSolveMaterialError::MissingAex {
                object_id: object.id.clone(),
            })?;
    let saturation_magnetisation =
        material
            .properties
            .ms
            .ok_or_else(|| SceneSolveMaterialError::MissingMs {
                object_id: object.id.clone(),
            })?;
    Ok(ResolvedSceneSolveMaterial {
        asset: material,
        exchange_stiffness,
        saturation_magnetisation,
    })
}
