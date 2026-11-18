//! Optional catalog provenance. It never supplies effective solver parameters.
use crate::SceneMaterialReference;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SceneMaterialSourceKind {
    Builtin,
    Custom,
    Modified,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct SceneMaterialSourceProperties {
    #[serde(rename = "Ms")]
    pub ms: Option<f64>,
    #[serde(rename = "Aex")]
    pub aex: Option<f64>,
    pub alpha: f64,
    #[serde(rename = "Dind")]
    pub dind: Option<f64>,
    #[serde(rename = "Dbulk")]
    pub dbulk: Option<f64>,
}

/// A stable published material key and the provenance recorded at publication.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SceneMaterialVersionSource {
    pub family: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub copied_from_family: Option<String>,
}

pub const PUBLISHED_MATERIAL_ID_PREFIX: &str = "custom:published:";

impl SceneMaterialVersionSource {
    pub fn catalog_id(&self) -> String {
        format!(
            "{PUBLISHED_MATERIAL_ID_PREFIX}{}:{}",
            self.family, self.version
        )
    }

    pub fn validate(&self) -> Result<(), String> {
        validate_material_version_key("family", &self.family)?;
        validate_material_version_key("version", &self.version)?;
        if let Some(family) = &self.copied_from_family {
            validate_material_version_key("copied_from_family", family)?;
            if family == &self.family {
                return Err("copied_from_family must differ from the published family".into());
            }
        }
        if self
            .source_project
            .as_ref()
            .is_some_and(|project| project.trim().is_empty() || project.len() > 4096)
        {
            return Err("material source project must contain 1 to 4096 bytes".into());
        }
        Ok(())
    }
}

pub fn validate_material_version_key(field: &str, key: &str) -> Result<(), String> {
    const PYTHON_KEYWORDS: &[&str] = &[
        "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del",
        "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is",
        "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with",
        "yield",
    ];
    if key.len() > 48
        || !key.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
        || PYTHON_KEYWORDS.contains(&key)
    {
        return Err(format!(
            "material {field} must be a non-keyword ASCII Python identifier, starting with a lowercase letter and using at most 48 lowercase letters, digits or underscores"
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct SceneMaterialSource {
    pub catalog_id: String,
    pub catalog_revision: u64,
    pub name: String,
    pub kind: SceneMaterialSourceKind,
    pub properties: SceneMaterialSourceProperties,
    #[serde(default)]
    pub references: Vec<SceneMaterialReference>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<SceneMaterialVersionSource>,
}

pub fn validate_material_references(references: &[SceneMaterialReference]) -> Result<(), String> {
    if references.len() > 64 {
        return Err("at most 64 material references are supported".into());
    }
    for reference in references {
        for (value, maximum) in [
            (&reference.label, 512),
            (&reference.url, 4096),
            (&reference.citation, 16384),
        ] {
            if value.as_ref().is_some_and(|value| value.len() > maximum) {
                return Err("material reference exceeds its size limit".into());
            }
        }
        if let Some(url) = &reference.url {
            let rest = url
                .strip_prefix("https://")
                .or_else(|| url.strip_prefix("http://"))
                .ok_or_else(|| "material reference URL must use http:// or https://".to_string())?;
            let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
            if authority.is_empty()
                || authority.starts_with(':')
                || url
                    .chars()
                    .any(|c| c.is_whitespace() || c.is_control() || c == '\\')
            {
                return Err(
                    "material reference URL must have a valid host and no whitespace".into(),
                );
            }
        }
    }
    Ok(())
}

pub fn validate_material_source(source: &SceneMaterialSource) -> Result<(), String> {
    if source.catalog_id.is_empty()
        || source.catalog_id.len() > 160
        || source.catalog_revision == 0
        || source.name.trim().is_empty()
        || source.name.chars().count() > 240
    {
        return Err(
            "material source requires a bounded identity, name and positive revision".into(),
        );
    }
    if !source
        .catalog_id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || b":_-".contains(&byte))
    {
        return Err("material source identity contains invalid characters".into());
    }
    let prefix = match source.kind {
        SceneMaterialSourceKind::Builtin => "builtin:",
        _ => "custom:",
    };
    if !source.catalog_id.starts_with(prefix) {
        return Err("material source kind and identity disagree".into());
    }
    if let Some(version) = &source.version {
        version.validate()?;
        if source.catalog_id != version.catalog_id() {
            return Err("material source identity and published key disagree".into());
        }
        if source.properties.ms.is_none() || source.properties.aex.is_none() {
            return Err("published material source requires Ms and Aex".into());
        }
    }
    let properties = &source.properties;
    for (name, value) in [
        ("Ms", properties.ms),
        ("Aex", properties.aex),
        ("alpha", Some(properties.alpha)),
        ("Dind", properties.dind),
        ("Dbulk", properties.dbulk),
    ] {
        if let Some(value) = value {
            if !value.is_finite()
                || (name == "Ms" && value <= 0.0)
                || ((name == "Aex" || name == "alpha") && value < 0.0)
            {
                return Err(format!("material source has invalid {name}"));
            }
        }
    }
    validate_material_references(&source.references)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SceneMaterialAssetsVersion {
    #[serde(rename = "fullmag.material-assets.v1")]
    V1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MaterialDmiCoefficient {
    #[serde(rename = "Dind")]
    Interfacial,
    #[serde(rename = "Dbulk")]
    Bulk,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "MaterialAssetsMetadataWire")]
pub struct SceneMaterialAssetsMetadata {
    pub version: SceneMaterialAssetsVersion,
    pub materials: Vec<crate::SceneMaterialAsset>,
    pub assignments: std::collections::BTreeMap<String, String>,
    pub object_ids: std::collections::BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub inactive_dmi: std::collections::BTreeMap<String, Vec<MaterialDmiCoefficient>>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub active_dmi_without_coefficient: std::collections::BTreeMap<String, Vec<MaterialDmiCoefficient>>,
}
#[derive(Deserialize)]
struct MaterialAssetsMetadataWire {
    version: SceneMaterialAssetsVersion,
    materials: Vec<crate::SceneMaterialAsset>,
    assignments: std::collections::BTreeMap<String, String>,
    object_ids: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    inactive_dmi: std::collections::BTreeMap<String, Vec<MaterialDmiCoefficient>>,
    #[serde(default)]
    active_dmi_without_coefficient: std::collections::BTreeMap<String, Vec<MaterialDmiCoefficient>>,
}
impl TryFrom<MaterialAssetsMetadataWire> for SceneMaterialAssetsMetadata {
    type Error = String;
    fn try_from(value: MaterialAssetsMetadataWire) -> Result<Self, Self::Error> {
        if value.materials.len() > 10000
            || value.assignments.len() > 10000
            || value.object_ids.len() > 10000
        {
            return Err("material metadata exceeds its item limit".into());
        }
        let mut ids = std::collections::BTreeSet::new();
        for material in &value.materials {
            if material.id.trim().is_empty() || !ids.insert(material.id.as_str()) {
                return Err("material metadata contains empty or duplicate identities".into());
            }
            // Effective references are authored scene data, including older archives.
            if let Some(source) = &material.source {
                validate_material_source(source)?;
            }
        }
        if value
            .assignments
            .iter()
            .any(|(object, material)| object.trim().is_empty() || !ids.contains(material.as_str()))
        {
            return Err("material metadata assignment refers to an unknown material".into());
        }
        let mut object_ids = std::collections::BTreeSet::new();
        if value.object_ids.iter().any(|(name, id)| {
            name.trim().is_empty() || id.trim().is_empty() || !object_ids.insert(id)
        }) {
            return Err("material metadata contains empty or duplicate object identities".into());
        }
        if value.inactive_dmi.iter().chain(&value.active_dmi_without_coefficient).any(|(object, flags)| {
            !value.assignments.contains_key(object)
                || flags.len() > 2
                || (flags.len() == 2 && flags[0] == flags[1])
        }) {
            return Err("material metadata has invalid DMI editor state".into());
        }
        Ok(Self {
            version: value.version,
            materials: value.materials,
            assignments: value.assignments,
            object_ids: value.object_ids,
            inactive_dmi: value.inactive_dmi,
            active_dmi_without_coefficient: value.active_dmi_without_coefficient,
        })
    }
}
