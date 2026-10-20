//! Authoring input identity, independent of editor and display labels.
//!
//! This is not a mesh fingerprint or a digest of a rendered Python script.
//! Accepted execution still owns the pinned dependency/plan/CAS identities.
//! Keep all computational inputs (including extensions) unless a field is
//! explicitly known to be presentation-only at its typed location.

use crate::SceneDocument;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

pub const SCENE_EXECUTION_INPUT_SCHEMA: &str = "fullmag.scene_execution_input.v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SceneExecutionInputIdentity {
    pub schema_version: String,
    pub sha256: String,
}

/// Serialize the complete authored input before lowering/export can omit any
/// fields. Array order is preserved: stage and region order can be semantic.
pub fn scene_execution_input_identity(
    scene: &SceneDocument,
) -> Result<SceneExecutionInputIdentity, serde_json::Error> {
    let view = scene_execution_input_view(scene)?;
    let bytes = serde_json::to_vec(&canonical_json(view))?;
    let digest = Sha256::digest(&bytes);
    Ok(SceneExecutionInputIdentity {
        schema_version: SCENE_EXECUTION_INPUT_SCHEMA.to_owned(),
        sha256: digest.iter().map(|byte| format!("{byte:02x}")).collect(),
    })
}

pub fn scene_execution_input_view(scene: &SceneDocument) -> Result<Value, serde_json::Error> {
    let mut value = serde_json::to_value(scene)?;
    if let Some(root) = value.as_object_mut() {
        root.remove("revision");
        root.remove("editor");
        root.remove("analysis");
        if let Some(metadata) = root.get_mut("scene").and_then(Value::as_object_mut) {
            metadata.remove("name");
        }
        for key in ["objects", "materials", "magnetization_assets"] {
            if let Some(entries) = root.get_mut(key).and_then(Value::as_array_mut) {
                for entry in entries.iter_mut().filter_map(Value::as_object_mut) {
                    // IDs and every reference remain in the input. User labels
                    // are not solver identities, including labels on assets.
                    entry.remove("name");
                    if key == "objects" {
                        for metadata in ["notes", "visible", "locked", "tags"] {
                            entry.remove(metadata);
                        }
                        if let Some(regions) = entry.get_mut("regions").and_then(Value::as_array_mut) {
                            for region in regions.iter_mut().filter_map(Value::as_object_mut) {
                                region.remove("name");
                            }
                        }
                    } else if key == "materials" {
                        entry.remove("references");
                    } else {
                        entry.remove("ui_label");
                    }
                }
            }
        }
        if let Some(study) = root.get_mut("study").and_then(Value::as_object_mut) {
            if let Some(stages) = study.get_mut("stages").and_then(Value::as_array_mut) {
                for stage in stages.iter_mut().filter_map(Value::as_object_mut) {
                    stage.remove("label");
                    stage.remove("notes");
                }
            }
            if let Some(pipeline) = study.get_mut("study_pipeline").and_then(Value::as_object_mut) {
                if let Some(nodes) = pipeline.get_mut("nodes").and_then(Value::as_array_mut) {
                    remove_pipeline_labels(nodes);
                }
            }
        }
    }
    Ok(value)
}

fn remove_pipeline_labels(nodes: &mut [Value]) {
    for node in nodes.iter_mut().filter_map(Value::as_object_mut) {
        node.remove("label");
        node.remove("notes");
        node.remove("collapsed");
        // Pipeline nodes keep their IDs, sources, connections, parameters and
        // extension payloads. Only recurse through the typed child-node list.
        if let Some(children) = node.get_mut("children").and_then(Value::as_array_mut) {
            remove_pipeline_labels(children);
        }
    }
}

fn canonical_json(value: Value) -> Value {
    match value {
        Value::Object(values) => {
            let sorted = values.into_iter().collect::<std::collections::BTreeMap<_, _>>();
            let mut object = Map::new();
            for (key, value) in sorted {
                object.insert(key, canonical_json(value));
            }
            Value::Object(object)
        }
        Value::Array(values) => Value::Array(values.into_iter().map(canonical_json).collect()),
        other => other,
    }
}
