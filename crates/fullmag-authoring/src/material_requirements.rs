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
