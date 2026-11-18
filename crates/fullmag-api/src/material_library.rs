//! Persistent, per-user material catalog. Scene assets are independent copies.
use crate::schemas::authoring::{MaterialPropertiesResource, MaterialReferenceResource};
use fullmag_authoring::{
    SceneMaterialReference, SceneMaterialSource, SceneMaterialSourceKind,
    SceneMaterialSourceProperties,
};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::{fmt, path::Path, time::Duration};
use utoipa::ToSchema;

#[derive(Debug)]
pub enum MaterialLibraryError {
    Invalid(String),
    NotFound(String),
    Conflict(String),
    Storage(anyhow::Error),
}
impl fmt::Display for MaterialLibraryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(message) | Self::NotFound(message) | Self::Conflict(message) => {
                f.write_str(message)
            }
            Self::Storage(error) => write!(f, "material library storage: {error}"),
        }
    }
}
impl std::error::Error for MaterialLibraryError {}
impl From<rusqlite::Error> for MaterialLibraryError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Storage(value.into())
    }
}
impl From<serde_json::Error> for MaterialLibraryError {
    fn from(value: serde_json::Error) -> Self {
        Self::Storage(value.into())
    }
}
type Result<T> = std::result::Result<T, MaterialLibraryError>;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct MaterialLibraryWriteRequest {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub summary: Option<String>,
    pub properties: MaterialPropertiesResource,
    #[serde(default)]
    pub references: Vec<MaterialReferenceResource>,
    #[serde(default)]
    pub source: Option<SceneMaterialSource>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct MaterialLibraryEntryResource {
    pub id: String,
    pub revision: u64,
    pub name: String,
    pub summary: Option<String>,
    pub kind: SceneMaterialSourceKind,
    pub properties: MaterialPropertiesResource,
    pub references: Vec<MaterialReferenceResource>,
    pub source: Option<SceneMaterialSource>,
}
impl MaterialLibraryEntryResource {
    pub fn source_snapshot(&self) -> SceneMaterialSource {
        SceneMaterialSource {
            catalog_id: self.id.clone(),
            catalog_revision: self.revision,
            name: self.name.clone(),
            kind: self.kind.clone(),
            properties: SceneMaterialSourceProperties {
                ms: self.properties.ms,
                aex: self.properties.aex,
                alpha: self.properties.alpha,
                dind: self.properties.dind,
                dbulk: self.properties.dbulk,
            },
            references: self
                .references
                .iter()
                .map(|reference| SceneMaterialReference {
                    label: reference.label.clone(),
                    url: reference.url.clone(),
                    citation: reference.citation.clone(),
                })
                .collect(),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct MaterialLibraryResource {
    pub revision: u64,
    pub entries: Vec<MaterialLibraryEntryResource>,
}

/// The entry clock protects edits; the catalog clock invalidates shared readers.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct MaterialLibraryMutationResource {
    pub catalog_revision: u64,
    #[serde(flatten)]
    pub material: MaterialLibraryEntryResource,
}

pub struct MaterialLibraryStore {
    connection: Connection,
}
const APPLICATION_ID: i64 = 0x464d4d4c;
impl MaterialLibraryStore {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            std::fs::create_dir_all(parent)
                .map_err(|error| MaterialLibraryError::Storage(error.into()))?;
        }
        let mut connection = Connection::open(path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let version: i64 =
            transaction.pragma_query_value(None, "user_version", |row| row.get(0))?;
        let application_id: i64 =
            transaction.pragma_query_value(None, "application_id", |row| row.get(0))?;
        if version == 0 && application_id == 0 {
            let tables: i64 = transaction.query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'", [], |row| row.get(0))?;
            if tables != 0 {
                return Err(MaterialLibraryError::Storage(anyhow::anyhow!(
                    "unrecognized material database; original file preserved"
                )));
            }
            transaction.execute_batch("CREATE TABLE catalog_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL CHECK(revision>0));
                INSERT INTO catalog_state VALUES(1,1);
                CREATE TABLE material_entries (id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>0), document TEXT NOT NULL);
                PRAGMA user_version=1;")?;
            transaction.pragma_update(None, "application_id", APPLICATION_ID)?;
        } else if version != 1 || application_id != APPLICATION_ID {
            return Err(MaterialLibraryError::Storage(anyhow::anyhow!(
                "unsupported material database version or identity; original file preserved"
            )));
        }
        transaction.commit()?;
        Ok(Self { connection })
    }

    pub fn list(&self) -> Result<MaterialLibraryResource> {
        let transaction = self.connection.unchecked_transaction()?;
        let revision: u64 = transaction.query_row(
            "SELECT revision FROM catalog_state WHERE singleton=1",
            [],
            |row| row.get(0),
        )?;
        let mut entries = builtin_entries();
        {
            let mut statement =
                transaction.prepare("SELECT document FROM material_entries ORDER BY id")?;
            for row in statement.query_map([], |row| row.get::<_, String>(0))? {
                let entry: MaterialLibraryEntryResource = serde_json::from_str(&row?)?;
                validate_entry(&entry).map_err(|error| {
                    MaterialLibraryError::Storage(anyhow::anyhow!(
                        "invalid stored material {}: {error}",
                        entry.id
                    ))
                })?;
                entries.push(entry);
            }
        }
        transaction.commit()?;
        Ok(MaterialLibraryResource { revision, entries })
    }

    pub fn create(
        &mut self,
        request: MaterialLibraryWriteRequest,
    ) -> Result<MaterialLibraryEntryResource> {
        self.create_with_revision(request)
            .map(|result| result.material)
    }

    pub fn create_with_revision(
        &mut self,
        request: MaterialLibraryWriteRequest,
    ) -> Result<MaterialLibraryMutationResource> {
        let id = request
            .id
            .clone()
            .unwrap_or_else(|| format!("custom:{}", uuid::Uuid::new_v4()));
        let mut entry = entry_from_request(&id, 1, request)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if transaction
            .query_row("SELECT 1 FROM material_entries WHERE id=?1", [&id], |_| {
                Ok(())
            })
            .optional()?
            .is_some()
        {
            return Err(MaterialLibraryError::Conflict(format!(
                "material id conflict: {id}"
            )));
        }
        // A reused custom ID must never accept an old lifetime's edit token.
        // The catalog clock is greater than every entry clock at creation.
        let catalog_revision = advance_revision(&transaction)?;
        entry.revision = catalog_revision;
        transaction.execute(
            "INSERT INTO material_entries(id,revision,document) VALUES(?1,?2,?3)",
            params![entry.id, entry.revision, serde_json::to_string(&entry)?],
        )?;
        transaction.commit()?;
        Ok(MaterialLibraryMutationResource {
            catalog_revision,
            material: entry,
        })
    }

    pub fn update(
        &mut self,
        id: &str,
        request: MaterialLibraryWriteRequest,
        expected_revision: u64,
    ) -> Result<MaterialLibraryEntryResource> {
        self.update_with_revision(id, request, expected_revision)
            .map(|result| result.material)
    }

    pub fn update_with_revision(
        &mut self,
        id: &str,
        mut request: MaterialLibraryWriteRequest,
        expected_revision: u64,
    ) -> Result<MaterialLibraryMutationResource> {
        require_custom_id(id)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (revision, document): (u64, String) = transaction
            .query_row(
                "SELECT revision,document FROM material_entries WHERE id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| MaterialLibraryError::NotFound(format!("material not found: {id}")))?;
        if revision != expected_revision {
            return Err(MaterialLibraryError::Conflict(
                "material revision conflict; reload before saving".into(),
            ));
        }
        let stored: MaterialLibraryEntryResource = serde_json::from_str(&document)?;
        if request.source.is_some() && request.source != stored.source {
            return Err(MaterialLibraryError::Invalid(
                "material source cannot change; create a new variant instead".into(),
            ));
        }
        request.source = stored.source;
        let revision = revision
            .checked_add(1)
            .ok_or_else(|| MaterialLibraryError::Conflict("material revision exhausted".into()))?;
        let entry = entry_from_request(id, revision, request)?;
        transaction.execute(
            "UPDATE material_entries SET revision=?1,document=?2 WHERE id=?3",
            params![revision, serde_json::to_string(&entry)?, id],
        )?;
        let catalog_revision = advance_revision(&transaction)?;
        transaction.commit()?;
        Ok(MaterialLibraryMutationResource {
            catalog_revision,
            material: entry,
        })
    }

    pub fn delete(&mut self, id: &str, expected_revision: u64) -> Result<u64> {
        require_custom_id(id)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let revision = transaction
            .query_row(
                "SELECT revision FROM material_entries WHERE id=?1",
                [id],
                |row| row.get::<_, u64>(0),
            )
            .optional()?
            .ok_or_else(|| MaterialLibraryError::NotFound(format!("material not found: {id}")))?;
        if revision != expected_revision {
            return Err(MaterialLibraryError::Conflict(
                "material revision conflict; reload before deleting".into(),
            ));
        }
        transaction.execute("DELETE FROM material_entries WHERE id=?1", [id])?;
        let revision = advance_revision(&transaction)?;
        transaction.commit()?;
        Ok(revision)
    }
}
fn advance_revision(transaction: &rusqlite::Transaction<'_>) -> Result<u64> {
    transaction.execute(
        "UPDATE catalog_state SET revision=revision+1 WHERE singleton=1",
        [],
    )?;
    Ok(transaction.query_row(
        "SELECT revision FROM catalog_state WHERE singleton=1",
        [],
        |row| row.get(0),
    )?)
}
fn require_custom_id(id: &str) -> Result<()> {
    if id.starts_with("builtin:") {
        return Err(MaterialLibraryError::Conflict(
            "built-in materials are read-only; create a variant".into(),
        ));
    }
    if !id.starts_with("custom:")
        || id.len() <= 7
        || id.len() > 160
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b":_-".contains(&byte))
    {
        return Err(MaterialLibraryError::Invalid("custom material id must use custom: followed by letters, digits, hyphens or underscores".into()));
    }
    Ok(())
}
fn entry_from_request(
    id: &str,
    revision: u64,
    request: MaterialLibraryWriteRequest,
) -> Result<MaterialLibraryEntryResource> {
    require_custom_id(id)?;
    if request.id.as_deref().is_some_and(|value| value != id) {
        return Err(MaterialLibraryError::Invalid(
            "material id cannot change".into(),
        ));
    }
    let entry = MaterialLibraryEntryResource {
        id: id.to_owned(),
        revision,
        name: request.name.trim().to_owned(),
        summary: request
            .summary
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty()),
        kind: if request.source.is_some() {
            SceneMaterialSourceKind::Modified
        } else {
            SceneMaterialSourceKind::Custom
        },
        properties: request.properties,
        references: request.references,
        source: request.source,
    };
    validate_entry(&entry)?;
    Ok(entry)
}
fn validate_entry(entry: &MaterialLibraryEntryResource) -> Result<()> {
    if entry.name.is_empty() || entry.name.chars().count() > 240 {
        return Err(MaterialLibraryError::Invalid(
            "material name must contain 1 to 240 characters".into(),
        ));
    }
    if entry.summary.as_ref().is_some_and(|text| text.len() > 8192) {
        return Err(MaterialLibraryError::Invalid(
            "material summary is too long".into(),
        ));
    }
    validate_properties(&entry.properties)?;
    validate_references(&entry.references)?;
    if let Some(source) = &entry.source {
        validate_material_source(source).map_err(MaterialLibraryError::Invalid)?;
    }
    Ok(())
}
pub fn validate_properties(properties: &MaterialPropertiesResource) -> Result<()> {
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
                return Err(MaterialLibraryError::Invalid(format!(
                    "invalid {name}: expected a finite SI value within the authoring range"
                )));
            }
        }
    }
    Ok(())
}
fn validate_references(references: &[MaterialReferenceResource]) -> Result<()> {
    let values = references
        .iter()
        .map(|reference| SceneMaterialReference {
            label: reference.label.clone(),
            url: reference.url.clone(),
            citation: reference.citation.clone(),
        })
        .collect::<Vec<_>>();
    fullmag_authoring::validate_material_references(&values).map_err(MaterialLibraryError::Invalid)
}
pub use fullmag_authoring::validate_material_source;
fn builtin_entries() -> Vec<MaterialLibraryEntryResource> {
    [
        ("permalloy","Permalloy Ni80Fe20",1.3e-11,8e5,0.01,"10.1063/1.3072096"),
        ("cofeb","CoFeB",1.5e-11,1e6,0.008,"10.1063/1.2711781"),
        ("yig","YIG",3.7e-12,1.4e5,1e-4,"10.1109/TMAG.1988.194098"),
        ("nickel","Ni",8e-12,4.85e5,0.03,"10.1103/RevModPhys.17.15"),
        ("iron","Fe",2.1e-11,1.7e6,0.002,"10.1063/1.1724669"),
    ].into_iter().map(|(id,name,aex,ms,alpha,doi)| MaterialLibraryEntryResource {
        id:format!("builtin:{id}"),revision:1,name:name.into(),kind:SceneMaterialSourceKind::Builtin,
        summary:Some("Seed parameters; verify suitability for your sample and conditions. References do not certify every parameter.".into()),
        properties:MaterialPropertiesResource {ms:Some(ms),aex:Some(aex),alpha,dind:None,dbulk:None},
        references:vec![MaterialReferenceResource {label:Some("Reference".into()),url:Some(format!("https://doi.org/{doi}")),citation:None}],source:None,
    }).collect()
}
