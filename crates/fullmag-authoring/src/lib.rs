#![recursion_limit = "512"]

mod adapters;
mod authoring_model;
mod builder;
mod geometry;
mod geometry_features;
mod material_requirements;
mod physics_graph;
mod region_revisions;
mod scene;
mod spin_transport;
mod study_contract;
mod validation;

pub use adapters::{
    normalize_scene_document_magnetization_assets, normalize_scene_document_study_pipeline_labels,
    scene_document_from_script_builder, scene_document_problem_projection,
    scene_document_to_script_builder, scene_document_to_script_builder_overrides,
    SceneProblemProjection,
};
pub use authoring_model::{
    model_definition_from_scene_document, model_definition_from_value,
    scene_document_model_definition, ComponentDefinition, ModelDefinition, PhysicsConfiguration,
    AUTHORING_MODEL_SCHEMA_VERSION, COMPONENT_DEFINITION_SCHEMA_VERSION,
    PHYSICS_CONFIGURATION_SCHEMA_VERSION,
};
pub use builder::*;
pub use geometry::*;
pub use geometry_features::*;
pub use material_requirements::*;
pub use physics_graph::*;
pub use region_revisions::*;
pub use scene::*;
pub use spin_transport::*;
pub use study_contract::*;
pub use validation::{
    validate_scene_document, validate_scene_document_for_authoring, SceneDocumentValidationError,
};
