//! Versioned, read-only projection of a [`SceneDocument`] for authoring clients.
//!
//! This module is intentionally a projection boundary.  It does not own a
//! second mutable scene, resolve a backend, mesh a geometry, or select a
//! solver.  The scene document remains the authoring source of truth and the
//! planner remains the execution boundary.

use crate::{
    normalize_physics_graph, PhysicsModuleIR, PhysicsScopeRef, SceneDocument,
    SceneDocumentValidationError, SceneObject, ScriptBuilderMagneticInteractionEntry,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

pub const AUTHORING_MODEL_SCHEMA_VERSION: &str = "authoring_model.v1";
pub const COMPONENT_DEFINITION_SCHEMA_VERSION: &str = "component_definition.v1";
pub const PHYSICS_CONFIGURATION_SCHEMA_VERSION: &str = "physics_configuration.v1";

/// Immutable component payload shared by the Python and browser authoring
/// projections.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ComponentDefinition {
    pub schema_version: String,
    pub component_id: String,
    pub name: String,
    pub geometry: Value,
    pub material_ref: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub region_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub material_parameter_assignment_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub physics_assignment_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_state: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh_recipe: Option<Value>,
}

/// Immutable physical assignment shared by model components.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PhysicsConfiguration {
    pub schema_version: String,
    pub configuration_id: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub active_interaction_kinds: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub energy_terms: Vec<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub source_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub constraint_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub module_ids: Vec<String>,
}

/// Versioned model projection consumed by authoring surfaces.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModelDefinition {
    pub schema_version: String,
    pub model_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub components: Vec<ComponentDefinition>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub physics_configurations: Vec<PhysicsConfiguration>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub couplings: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub discretization: Option<Value>,
    /// Rust does not invent a second parameter AST.  This stays absent until
    /// the canonical cross-language parameter contract is available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parameters: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parameter_numerical_sha256: Option<String>,
}

impl ModelDefinition {
    /// Parse the versioned authoring wire payload without creating a mutable
    /// scene or selecting a runtime backend.
    pub fn from_value(value: Value) -> Result<Self, SceneDocumentValidationError> {
        let model: Self = serde_json::from_value(value).map_err(|error| {
            SceneDocumentValidationError::new(format!(
                "invalid {AUTHORING_MODEL_SCHEMA_VERSION} payload: {error}"
            ))
        })?;
        if model.schema_version != AUTHORING_MODEL_SCHEMA_VERSION {
            return Err(SceneDocumentValidationError::new(format!(
                "model schema_version must be {AUTHORING_MODEL_SCHEMA_VERSION}, got {}",
                model.schema_version
            )));
        }

        let mut component_ids = BTreeSet::new();
        for component in &model.components {
            if component.schema_version != COMPONENT_DEFINITION_SCHEMA_VERSION {
                return Err(SceneDocumentValidationError::new(format!(
                    "component '{}' schema_version must be {COMPONENT_DEFINITION_SCHEMA_VERSION}, got {}",
                    component.component_id, component.schema_version
                )));
            }
            if component.component_id.trim().is_empty()
                || !component_ids.insert(component.component_id.as_str())
            {
                return Err(SceneDocumentValidationError::new(format!(
                    "components must contain unique non-empty component_id values; invalid '{}'",
                    component.component_id
                )));
            }
        }

        let mut configuration_ids = BTreeSet::new();
        for configuration in &model.physics_configurations {
            if configuration.schema_version != PHYSICS_CONFIGURATION_SCHEMA_VERSION {
                return Err(SceneDocumentValidationError::new(format!(
                    "physics configuration '{}' schema_version must be {PHYSICS_CONFIGURATION_SCHEMA_VERSION}, got {}",
                    configuration.configuration_id, configuration.schema_version
                )));
            }
            if configuration.configuration_id.trim().is_empty()
                || !configuration_ids.insert(configuration.configuration_id.as_str())
            {
                return Err(SceneDocumentValidationError::new(format!(
                    "physics_configurations must contain unique non-empty configuration_id values; invalid '{}'",
                    configuration.configuration_id
                )));
            }
        }

        Ok(model)
    }

    /// Encode the wire payload with recursively sorted object keys and compact
    /// separators.  The authoring model uses this boundary for identity only;
    /// it does not mutate the source scene or select an execution backend.
    pub fn canonical_json_bytes(&self) -> Result<Vec<u8>, serde_json::Error> {
        let value = serde_json::to_value(self)?;
        canonical_json_bytes(&value)
    }

    /// Return the SHA-256 identity of the canonical authoring wire payload.
    pub fn canonical_sha256(&self) -> Result<String, serde_json::Error> {
        let bytes = self.canonical_json_bytes()?;
        Ok(format!("{:x}", Sha256::digest(bytes)))
    }
}

/// Serialize JSON using the same structural contract as the Python authoring
/// projection: sorted object keys, compact separators and ASCII-only strings.
/// Number formatting is delegated to `serde_json::Number`; a later shared
/// numeric canonicalizer can tighten that part without changing the payload
/// shape or the digest API.
fn canonical_json_bytes(value: &Value) -> Result<Vec<u8>, serde_json::Error> {
    let mut output = Vec::new();
    write_canonical_json(value, &mut output)?;
    Ok(output)
}

fn write_canonical_json(value: &Value, output: &mut Vec<u8>) -> Result<(), serde_json::Error> {
    match value {
        Value::Null => output.extend_from_slice(b"null"),
        Value::Bool(value) => output.extend_from_slice(if *value { b"true" } else { b"false" }),
        Value::Number(value) if value.is_f64() => {
            output.extend_from_slice(canonical_float_number(&value.to_string()).as_bytes())
        }
        Value::Number(value) => output.extend_from_slice(value.to_string().as_bytes()),
        Value::String(value) => write_ascii_json_string(value, output),
        Value::Array(values) => {
            output.push(b'[');
            for (index, item) in values.iter().enumerate() {
                if index != 0 {
                    output.push(b',');
                }
                write_canonical_json(item, output)?;
            }
            output.push(b']');
        }
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort_unstable();
            output.push(b'{');
            for (index, key) in keys.into_iter().enumerate() {
                if index != 0 {
                    output.push(b',');
                }
                write_ascii_json_string(key, output);
                output.push(b':');
                write_canonical_json(&values[key], output)?;
            }
            output.push(b'}');
        }
    }
    Ok(())
}

fn canonical_float_number(rendered: &str) -> String {
    let (sign, unsigned) = rendered
        .strip_prefix('-')
        .map_or(("", rendered), |value| ("-", value));
    let (mantissa, exponent) = unsigned
        .find('e')
        .or_else(|| unsigned.find('E'))
        .map(|index| {
            let (mantissa, exponent) = unsigned.split_at(index);
            (
                mantissa,
                exponent[1..]
                    .parse::<i32>()
                    .expect("serde_json float exponent is valid"),
            )
        })
        .unwrap_or((unsigned, 0));
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let mut digits = format!("{whole}{fraction}");
    let mut decimal_position = whole.len() as i32 + exponent;
    let leading_zeros = digits.bytes().take_while(|digit| *digit == b'0').count();
    if leading_zeros == digits.len() {
        return format!("{sign}0e0");
    }
    digits.drain(..leading_zeros);
    decimal_position -= leading_zeros as i32;
    while digits.ends_with('0') {
        digits.pop();
    }

    let mut canonical = String::with_capacity(digits.len() + 12);
    canonical.push_str(sign);
    canonical.push(digits.as_bytes()[0] as char);
    if digits.len() > 1 {
        canonical.push('.');
        canonical.push_str(&digits[1..]);
    }
    canonical.push('e');
    canonical.push_str(&(decimal_position - 1).to_string());
    canonical
}

fn write_ascii_json_string(value: &str, output: &mut Vec<u8>) {
    output.push(b'"');
    for character in value.chars() {
        match character {
            '"' => output.extend_from_slice(b"\\\""),
            '\\' => output.extend_from_slice(b"\\\\"),
            '\u{08}' => output.extend_from_slice(b"\\b"),
            '\u{09}' => output.extend_from_slice(b"\\t"),
            '\u{0a}' => output.extend_from_slice(b"\\n"),
            '\u{0c}' => output.extend_from_slice(b"\\f"),
            '\u{0d}' => output.extend_from_slice(b"\\r"),
            character if character <= '\u{1f}' => write_unicode_escape(character as u32, output),
            character if character.is_ascii() => output.push(character as u8),
            character => {
                let codepoint = character as u32;
                if codepoint <= 0xffff {
                    write_unicode_escape(codepoint, output);
                } else {
                    let shifted = codepoint - 0x1_0000;
                    write_unicode_escape(0xd800 + (shifted >> 10), output);
                    write_unicode_escape(0xdc00 + (shifted & 0x3ff), output);
                }
            }
        }
    }
    output.push(b'"');
}

fn write_unicode_escape(codepoint: u32, output: &mut Vec<u8>) {
    output.extend_from_slice(format!("\\u{codepoint:04x}").as_bytes());
}

/// Project an authored scene into the versioned model contract.
pub fn model_definition_from_scene_document(
    scene: &SceneDocument,
) -> Result<ModelDefinition, SceneDocumentValidationError> {
    crate::validate_scene_document_for_authoring(scene)?;

    let model_name = non_empty(&scene.scene.name, "scene.name")?;
    let model_id = if scene.scene.id.trim().is_empty() {
        format!("model:{model_name}")
    } else {
        scene.scene.id.clone()
    };
    let graph = normalize_physics_graph(scene).map_err(|error| {
        SceneDocumentValidationError::new(format!(
            "cannot project physics graph into authoring model: {error}"
        ))
    })?;

    let mut components = Vec::new();
    let mut component_ids = BTreeSet::new();
    for object in scene
        .objects
        .iter()
        .filter(|object| object.role == "magnet")
    {
        let component_id = non_empty(&object.id, "object.id")?;
        if !component_ids.insert(component_id.to_string()) {
            return Err(SceneDocumentValidationError::new(format!(
                "duplicate component_id '{component_id}' in authoring model"
            )));
        }
        let material_ref = non_empty(&object.material_ref, "object.material_ref")?;
        let region_ids = unique_ids(
            object
                .regions
                .iter()
                .map(|region| region.region_id.as_str()),
            &format!("object '{component_id}' region_ids"),
        )?;
        let material_parameter_assignment_ids = unique_ids(
            object
                .material_parameter_fields
                .iter()
                .map(|assignment| assignment.assignment_id.as_str()),
            &format!("object '{component_id}' material_parameter_assignment_ids"),
        )?;
        let physics_assignment_ids = graph
            .modules
            .iter()
            .filter(|module| module_applies_to_object(module, component_id))
            .map(|module| module.id.clone())
            .collect();

        components.push(ComponentDefinition {
            schema_version: COMPONENT_DEFINITION_SCHEMA_VERSION.to_string(),
            component_id: component_id.to_string(),
            name: non_empty(&object.name, "object.name")?.to_string(),
            geometry: geometry_payload(object),
            material_ref: material_ref.to_string(),
            region_ids,
            material_parameter_assignment_ids,
            physics_assignment_ids,
            initial_state: object
                .magnetization_ref
                .as_deref()
                .filter(|reference| !reference.trim().is_empty())
                .map(|asset_id| json!({ "asset_id": asset_id })),
            mesh_recipe: object
                .mesh_override
                .as_ref()
                .or(object.object_mesh.as_ref())
                .map(|mesh| serde_json::to_value(mesh).expect("mesh recipe is serializable")),
        });
    }

    let energy_terms = energy_terms(scene);
    let active_interaction_kinds = energy_terms
        .iter()
        .filter_map(|term| term.get("kind").and_then(Value::as_str))
        .map(str::to_owned)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let module_ids = graph
        .modules
        .iter()
        .map(|module| module.id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let source_ids = graph
        .modules
        .iter()
        .filter(|module| is_source_module(module))
        .map(|module| module.id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let constraint_ids = scene
        .magnetization_constraints
        .iter()
        .map(|constraint| constraint.frozen_spins().id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();

    let physics_configuration = PhysicsConfiguration {
        schema_version: PHYSICS_CONFIGURATION_SCHEMA_VERSION.to_string(),
        configuration_id: "physics:default".to_string(),
        active_interaction_kinds,
        energy_terms,
        source_ids,
        constraint_ids,
        module_ids,
    };

    Ok(ModelDefinition {
        schema_version: AUTHORING_MODEL_SCHEMA_VERSION.to_string(),
        model_id,
        name: model_name.to_string(),
        components,
        physics_configurations: vec![physics_configuration],
        couplings: scene
            .couplings
            .iter()
            .map(|coupling| serde_json::to_value(coupling).expect("coupling is serializable"))
            .collect(),
        discretization: Some(discretization_payload(scene)),
        parameters: None,
        parameter_numerical_sha256: None,
    })
}

fn non_empty<'a>(value: &'a str, field: &str) -> Result<&'a str, SceneDocumentValidationError> {
    if value.trim().is_empty() {
        Err(SceneDocumentValidationError::new(format!(
            "{field} must not be empty for authoring model projection"
        )))
    } else {
        Ok(value)
    }
}

fn unique_ids<'a, I>(values: I, field: &str) -> Result<Vec<String>, SceneDocumentValidationError>
where
    I: IntoIterator<Item = &'a str>,
{
    let mut ids = Vec::new();
    let mut seen = BTreeSet::new();
    for value in values {
        let value = non_empty(value, field)?;
        if !seen.insert(value.to_string()) {
            return Err(SceneDocumentValidationError::new(format!(
                "{field} contains duplicate id '{value}'"
            )));
        }
        ids.push(value.to_string());
    }
    Ok(ids)
}

fn geometry_payload(object: &SceneObject) -> Value {
    let mut geometry = Map::new();
    geometry.insert(
        "kind".to_string(),
        Value::String(object.geometry.geometry_kind.clone()),
    );
    geometry.insert(
        "params".to_string(),
        object.geometry.geometry_params.clone(),
    );
    geometry.insert(
        "bounds_min".to_string(),
        object
            .geometry
            .bounds_min
            .map_or(Value::Null, |bounds| json!(bounds)),
    );
    geometry.insert(
        "bounds_max".to_string(),
        object
            .geometry
            .bounds_max
            .map_or(Value::Null, |bounds| json!(bounds)),
    );
    geometry.insert(
        "transform".to_string(),
        serde_json::to_value(&object.transform).expect("transform is serializable"),
    );
    Value::Object(geometry)
}

fn energy_terms(scene: &SceneDocument) -> Vec<Value> {
    let mut terms = Vec::new();
    for object in scene
        .objects
        .iter()
        .filter(|object| object.role == "magnet")
    {
        for interaction in object.physics_stack.iter().filter(|entry| entry.enabled) {
            terms.push(interaction_term(&object.id, interaction));
        }
    }
    if scene.study.exchange_enabled {
        terms.push(json!({ "kind": "exchange", "scope": "study" }));
    }
    if scene.study.demag_enabled {
        terms.push(json!({ "kind": "demag", "scope": "study" }));
    }
    if let Some(value) = scene.study.rotated_interfacial_dmi {
        if value != 0.0 {
            terms.push(json!({
                "kind": "rotated_interfacial_dmi",
                "scope": "study",
                "value": value
            }));
        }
    }
    terms
}

fn interaction_term(object_id: &str, interaction: &ScriptBuilderMagneticInteractionEntry) -> Value {
    let kind = serde_json::to_value(interaction.kind)
        .expect("interaction kind is serializable")
        .as_str()
        .unwrap_or("unknown")
        .to_string();
    let mut term = Map::new();
    term.insert("kind".to_string(), Value::String(kind));
    term.insert(
        "object_id".to_string(),
        Value::String(object_id.to_string()),
    );
    if let Some(params) = interaction.params.clone() {
        term.insert("params".to_string(), params);
    }
    Value::Object(term)
}

fn discretization_payload(scene: &SceneDocument) -> Value {
    json!({
        "requested_backend": scene.study.requested_backend,
        "requested_device": scene.study.requested_device,
        "requested_precision": scene.study.requested_precision,
        "requested_mode": scene.study.requested_mode,
        "requested_cpu_threads": scene.study.requested_cpu_threads,
        "fdm": scene.study.fdm,
        "shared_domain_mesh": scene.study.shared_domain_mesh,
        "mesh_defaults": scene.study.mesh_defaults,
        "mesh_interfaces": scene.study.mesh_interfaces,
    })
}

fn is_source_module(module: &PhysicsModuleIR) -> bool {
    matches!(
        module.kind.as_str(),
        "current_transport"
            | "spin_transport"
            | "spin_torque"
            | "oersted_field"
            | "regional_field_drive"
            | "external_field"
    )
}

fn module_applies_to_object(module: &PhysicsModuleIR, object_id: &str) -> bool {
    module.applies_to.iter().any(|scope| match scope {
        PhysicsScopeRef::Global => true,
        PhysicsScopeRef::Object { object_id: id }
        | PhysicsScopeRef::Region { object_id: id, .. } => id == object_id,
        PhysicsScopeRef::Interface { side_a, side_b } => {
            side_a.object_id == object_id || side_b.object_id == object_id
        }
        PhysicsScopeRef::CrossObject { object_ids } => object_ids.iter().any(|id| id == object_id),
        PhysicsScopeRef::Unresolved { .. } => false,
    })
}

/// Convenience alias kept close to the public contract for callers that want
/// an explicit projection name.
pub fn scene_document_model_definition(
    scene: &SceneDocument,
) -> Result<ModelDefinition, SceneDocumentValidationError> {
    model_definition_from_scene_document(scene)
}

/// Decode the versioned authoring wire contract at an integration boundary.
pub fn model_definition_from_value(
    value: Value,
) -> Result<ModelDefinition, SceneDocumentValidationError> {
    ModelDefinition::from_value(value)
}

#[cfg(test)]
mod canonical_compatibility_tests {
    use super::ModelDefinition;
    use serde_json::Value;

    const FIXTURE: &str = include_str!("../tests/fixtures/authoring_model_canonical.json");
    const EXPECTED_SHA256: &str =
        include_str!("../tests/fixtures/authoring_model_canonical.sha256");

    #[test]
    fn canonical_digest_matches_the_shared_python_authoring_fixture() {
        let payload: Value = serde_json::from_str(FIXTURE).expect("valid shared fixture");
        let model = ModelDefinition::from_value(payload).expect("valid authoring model");

        assert_eq!(
            model.canonical_sha256().expect("canonical digest"),
            EXPECTED_SHA256.trim(),
        );
    }
}
