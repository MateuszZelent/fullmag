#![recursion_limit = "512"]

mod adapters;
mod builder;
mod geometry;
mod region_revisions;
mod scene;
mod validation;

pub use adapters::{
    normalize_scene_document_magnetization_assets, normalize_scene_document_study_pipeline_labels,
    scene_document_from_script_builder, scene_document_problem_projection,
    scene_document_to_script_builder, scene_document_to_script_builder_overrides,
    SceneProblemProjection,
};
pub use builder::*;
pub use geometry::*;
pub use region_revisions::*;
pub use scene::*;
pub use validation::{validate_scene_document, SceneDocumentValidationError};
