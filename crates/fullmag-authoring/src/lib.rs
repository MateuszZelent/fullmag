#![recursion_limit = "512"]

mod adapters;
mod builder;
mod scene;
mod validation;

pub use adapters::{
    scene_document_from_script_builder, scene_document_problem_projection,
    scene_document_to_script_builder, scene_document_to_script_builder_overrides,
    SceneProblemProjection,
};
pub use builder::*;
pub use scene::*;
pub use validation::{validate_scene_document, SceneDocumentValidationError};
