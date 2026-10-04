use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
    path::PathBuf,
};
use uuid::Uuid;

pub const CURRENT_PROJECT_SCHEMA: &str = "fullmag.project.v1";
pub const CURRENT_SCENE_SCHEMA: &str = "scene.v2";

pub type DefinitionRevision = u64;

/// A portable project identity.  It is intentionally distinct from a runtime
/// session, a scene id, and a build/worktree identity.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct ProjectId(String);

impl<'de> Deserialize<'de> for ProjectId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(value).map_err(serde::de::Error::custom)
    }
}

impl ProjectId {
    pub fn new() -> Self {
        Self(format!("project-{}", Uuid::new_v4().simple()))
    }

    pub fn parse(value: impl Into<String>) -> Result<Self, ProjectIdError> {
        let value = value.into();
        validate_project_id(&value)?;
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Default for ProjectId {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectIdError(String);

impl fmt::Display for ProjectIdError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ProjectIdError {}

fn validate_project_id(value: &str) -> Result<(), ProjectIdError> {
    if value.is_empty()
        || value.len() > 200
        || !value.is_ascii()
        || value == "."
        || value == ".."
        || value.ends_with('.')
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(ProjectIdError(format!("invalid project id `{value}`")));
    }

    let stem = value
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    if matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || (stem.len() == 4
        && (stem.starts_with("COM") || stem.starts_with("LPT"))
        && matches!(stem.as_bytes()[3], b'1'..=b'9'))
    {
        return Err(ProjectIdError(format!("reserved project id `{value}`")));
    }

    Ok(())
}

/// JSON that keeps both the exact input bytes and the parsed value.  The raw
/// value is retained so unknown fields survive a project roundtrip even when
/// the current typed projection does not understand them.
#[derive(Clone, Debug, PartialEq)]
pub struct RawJsonEnvelope {
    raw_bytes: Vec<u8>,
    value: Value,
}

impl RawJsonEnvelope {
    pub fn from_bytes(bytes: impl Into<Vec<u8>>) -> Result<Self, JsonEnvelopeError> {
        let raw_bytes = bytes.into();
        let value = serde_json::from_slice(&raw_bytes)
            .map_err(|error| JsonEnvelopeError(format!("invalid JSON envelope: {error}")))?;
        Ok(Self { raw_bytes, value })
    }

    pub fn from_value(value: Value) -> Result<Self, JsonEnvelopeError> {
        let raw_bytes = serde_json::to_vec(&value)
            .map_err(|error| JsonEnvelopeError(format!("serializing JSON envelope: {error}")))?;
        Ok(Self { raw_bytes, value })
    }

    pub fn raw_bytes(&self) -> &[u8] {
        &self.raw_bytes
    }

    pub fn value(&self) -> &Value {
        &self.value
    }

    pub fn into_value(self) -> Value {
        self.value
    }

    pub fn unknown_object_fields<'a, I>(&self, known_fields: I) -> BTreeMap<String, Value>
    where
        I: IntoIterator<Item = &'a str>,
    {
        let known_fields = known_fields.into_iter().collect::<BTreeSet<_>>();
        self.value
            .as_object()
            .map(|object| {
                object
                    .iter()
                    .filter(|(key, _)| !known_fields.contains(key.as_str()))
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect()
            })
            .unwrap_or_default()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JsonEnvelopeError(pub String);

impl fmt::Display for JsonEnvelopeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for JsonEnvelopeError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectPathError(pub String);

impl fmt::Display for ProjectPathError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ProjectPathError {}

/// Opaque bytes that are part of a project but are not interpreted by the
/// application layer.  Source files and unknown documents use this type.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OpaqueDocument {
    path: String,
    bytes: Vec<u8>,
}

impl OpaqueDocument {
    pub fn new(
        path: impl Into<String>,
        bytes: impl Into<Vec<u8>>,
    ) -> Result<Self, ProjectPathError> {
        let path = path.into();
        validate_project_entry_path(&path)?;
        Ok(Self {
            path,
            bytes: bytes.into(),
        })
    }

    pub fn path(&self) -> &str {
        &self.path
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
}

/// An asset is kept as exact bytes and a stable project-relative path.  The
/// repository adapter may move the bytes to CAS, but this application type
/// never reconstructs an asset from a name or a runtime cache.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OpaqueAsset {
    path: String,
    bytes: Vec<u8>,
    media_type: Option<String>,
}

impl OpaqueAsset {
    pub fn new(
        path: impl Into<String>,
        bytes: impl Into<Vec<u8>>,
        media_type: Option<String>,
    ) -> Result<Self, ProjectPathError> {
        let path = path.into();
        validate_project_entry_path(&path)?;
        if !path.starts_with("project/assets/") {
            return Err(ProjectPathError(format!(
                "asset path must stay within project/assets/: `{path}`"
            )));
        }
        Ok(Self {
            path,
            bytes: bytes.into(),
            media_type,
        })
    }

    pub fn path(&self) -> &str {
        &self.path
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn media_type(&self) -> Option<&str> {
        self.media_type.as_deref()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProjectSource {
    Path(PathBuf),
    Bytes {
        display_name: String,
        bytes: Vec<u8>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProjectTarget {
    Path(PathBuf),
}

impl ProjectTarget {
    pub fn path(&self) -> &PathBuf {
        match self {
            Self::Path(path) => path,
        }
    }

    pub fn validate(&self) -> Result<(), ProjectPathError> {
        if self.path().as_os_str().is_empty() {
            return Err(ProjectPathError("project target path is empty".into()));
        }
        Ok(())
    }
}

/// Typed known fields for the transitional authoring payload.  The complete
/// raw project and scene envelopes live in [`ProjectEnvelope`].
#[derive(Clone, Debug, PartialEq)]
pub struct ProjectDefinition {
    pub project_id: ProjectId,
    pub schema_version: String,
    pub name: String,
    pub revision: DefinitionRevision,
    pub scene: RawJsonEnvelope,
}

impl ProjectDefinition {
    pub fn validate_for_save(&self) -> Result<(), ProjectDefinitionError> {
        if self.schema_version != CURRENT_PROJECT_SCHEMA {
            return Err(ProjectDefinitionError(format!(
                "project schema `{}` is not writable; expected `{CURRENT_PROJECT_SCHEMA}`",
                self.schema_version
            )));
        }
        if self.name.trim().is_empty() {
            return Err(ProjectDefinitionError(
                "project name must not be empty".into(),
            ));
        }
        let scene_version = self
            .scene
            .value()
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if scene_version != CURRENT_SCENE_SCHEMA {
            return Err(ProjectDefinitionError(format!(
                "scene schema `{scene_version}` is not writable; expected `{CURRENT_SCENE_SCHEMA}`"
            )));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectDefinitionError(pub String);

impl fmt::Display for ProjectDefinitionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ProjectDefinitionError {}

/// The application envelope is the single writable aggregate for P1.  The
/// raw definition, scene, unknown documents, source bytes, and assets travel
/// together; no writer is allowed to serialize only the typed projection.
#[derive(Clone, Debug, PartialEq)]
pub struct ProjectEnvelope {
    pub definition: ProjectDefinition,
    pub raw_definition: RawJsonEnvelope,
    pub source: Option<OpaqueDocument>,
    pub assets: Vec<OpaqueAsset>,
    pub opaque_documents: Vec<OpaqueDocument>,
}

impl ProjectEnvelope {
    pub fn blank(
        project_id: ProjectId,
        name: impl Into<String>,
    ) -> Result<Self, ProjectDefinitionError> {
        let name = name.into();
        if name.trim().is_empty() {
            return Err(ProjectDefinitionError(
                "project name must not be empty".into(),
            ));
        }
        let scene = RawJsonEnvelope::from_value(json!({
            "version": CURRENT_SCENE_SCHEMA,
            "revision": 0,
            "scene": {
                "id": "scene",
                "name": name,
                "source_of_truth": "ui",
                "authoring_schema": "mesh-first-fem.v1"
            },
            "objects": []
        }))
        .map_err(|error| ProjectDefinitionError(error.to_string()))?;
        let definition = ProjectDefinition {
            project_id,
            schema_version: CURRENT_PROJECT_SCHEMA.into(),
            name,
            revision: 0,
            scene,
        };
        let raw_definition = RawJsonEnvelope::from_value(json!({
            "schema": CURRENT_PROJECT_SCHEMA,
            "project_id": definition.project_id.as_str(),
            "name": definition.name,
            "revision": definition.revision,
            "scene": definition.scene.value()
        }))
        .map_err(|error| ProjectDefinitionError(error.to_string()))?;
        Ok(Self {
            definition,
            raw_definition,
            source: None,
            assets: Vec::new(),
            opaque_documents: Vec::new(),
        })
    }

    pub fn replace_scene(&mut self, scene: RawJsonEnvelope) -> Result<(), ProjectDefinitionError> {
        self.definition.scene = scene;
        self.rewrite_known_fields()
    }

    pub fn rewrite_known_fields(&mut self) -> Result<(), ProjectDefinitionError> {
        let mut object = self
            .raw_definition
            .value()
            .as_object()
            .cloned()
            .ok_or_else(|| {
                ProjectDefinitionError("project definition envelope must be an object".into())
            })?;
        object.insert(
            "schema".into(),
            Value::String(self.definition.schema_version.clone()),
        );
        object.insert(
            "project_id".into(),
            Value::String(self.definition.project_id.as_str().into()),
        );
        object.insert("name".into(), Value::String(self.definition.name.clone()));
        object.insert("revision".into(), json!(self.definition.revision));
        object.insert("scene".into(), self.definition.scene.value().clone());
        self.raw_definition = RawJsonEnvelope::from_value(Value::Object(object))
            .map_err(|error| ProjectDefinitionError(error.to_string()))?;
        Ok(())
    }

    pub fn for_save_as(&self, project_id: ProjectId) -> Result<Self, ProjectDefinitionError> {
        let mut clone = self.clone();
        clone.definition.project_id = project_id;
        clone.definition.revision = 0;
        clone.rewrite_known_fields()?;
        Ok(clone)
    }

    pub fn validate_for_save(&self) -> Result<(), ProjectDefinitionError> {
        self.definition.validate_for_save()?;
        let object = self.raw_definition.value().as_object().ok_or_else(|| {
            ProjectDefinitionError("project definition envelope must be an object".into())
        })?;
        if object.get("schema").and_then(Value::as_str)
            != Some(self.definition.schema_version.as_str())
            || object.get("project_id").and_then(Value::as_str)
                != Some(self.definition.project_id.as_str())
            || object.get("name").and_then(Value::as_str) != Some(self.definition.name.as_str())
            || object.get("revision").and_then(Value::as_u64) != Some(self.definition.revision)
            || object.get("scene") != Some(self.definition.scene.value())
        {
            return Err(ProjectDefinitionError(
                "typed project definition is out of sync with its raw envelope".into(),
            ));
        }

        let mut paths = BTreeSet::new();
        if let Some(source) = &self.source {
            let key = portable_entry_key(source.path());
            if is_reserved_project_entry(&key) || !paths.insert(key) {
                return Err(ProjectDefinitionError(format!(
                    "duplicate or reserved project entry `{}`",
                    source.path()
                )));
            }
        }
        for asset in &self.assets {
            let key = portable_entry_key(asset.path());
            if is_reserved_project_entry(&key) || !paths.insert(key) {
                return Err(ProjectDefinitionError(format!(
                    "duplicate or reserved project entry `{}`",
                    asset.path()
                )));
            }
        }
        for document in &self.opaque_documents {
            let key = portable_entry_key(document.path());
            if is_reserved_project_entry(&key) || !paths.insert(key) {
                return Err(ProjectDefinitionError(format!(
                    "duplicate or reserved project entry `{}`",
                    document.path()
                )));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigrationReport {
    pub source_schema: String,
    pub target_schema: String,
    pub migrated: bool,
    pub can_write: bool,
    pub warnings: Vec<String>,
    pub preserved_paths: Vec<String>,
}

impl MigrationReport {
    pub fn current() -> Self {
        Self {
            source_schema: CURRENT_PROJECT_SCHEMA.into(),
            target_schema: CURRENT_PROJECT_SCHEMA.into(),
            migrated: false,
            can_write: true,
            warnings: Vec::new(),
            preserved_paths: Vec::new(),
        }
    }

    pub fn unsupported(source_schema: impl Into<String>, warning: impl Into<String>) -> Self {
        Self {
            source_schema: source_schema.into(),
            target_schema: CURRENT_PROJECT_SCHEMA.into(),
            migrated: false,
            can_write: false,
            warnings: vec![warning.into()],
            preserved_paths: Vec::new(),
        }
    }
}

fn validate_project_entry_path(path: &str) -> Result<(), ProjectPathError> {
    if path.is_empty() || path.starts_with('/') || path.contains('\\') || path.ends_with('/') {
        return Err(ProjectPathError(format!(
            "unsafe project entry path `{path}`"
        )));
    }
    for component in path.split('/') {
        if component.is_empty()
            || component == "."
            || component == ".."
            || component.len() > 255
            || component.ends_with([' ', '.'])
            || component
                .chars()
                .any(|character| character.is_control() || "<>:\"|?*".contains(character))
        {
            return Err(ProjectPathError(format!(
                "unsafe project entry path `{path}`"
            )));
        }
        let stem = component
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        if is_reserved_windows_stem(&stem) {
            return Err(ProjectPathError(format!(
                "reserved project entry path `{path}`"
            )));
        }
    }
    if !path.starts_with("project/") {
        return Err(ProjectPathError(format!(
            "project entry must stay within project/: `{path}`"
        )));
    }
    Ok(())
}

fn is_reserved_windows_stem(stem: &str) -> bool {
    matches!(stem, "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix)
                .is_some_and(|suffix| matches!(suffix, "¹" | "²" | "³"))
        })
}

fn portable_entry_key(path: &str) -> String {
    path.to_ascii_lowercase()
}

fn is_reserved_project_entry(key: &str) -> bool {
    matches!(
        key,
        "project/definition.json"
            | "project/scene_document.json"
            | "project/ui_state.json"
            | "project/assets/index.json"
    )
}
