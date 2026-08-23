#![recursion_limit = "512"]

mod adapters;
mod builder;
mod geometry;
mod material_requirements;
mod physics_graph;
mod region_revisions;
mod scene;
mod spin_transport;
mod validation;

pub use adapters::{
    normalize_scene_document_magnetization_assets, normalize_scene_document_study_pipeline_labels,
    scene_document_from_script_builder, scene_document_problem_projection,
    scene_document_to_script_builder, scene_document_to_script_builder_overrides,
    SceneProblemProjection,
};
pub use builder::*;
pub use geometry::*;
pub use material_requirements::*;
pub use physics_graph::*;
pub use region_revisions::*;
pub use scene::*;
pub use spin_transport::*;
pub use validation::{validate_scene_document, SceneDocumentValidationError};
