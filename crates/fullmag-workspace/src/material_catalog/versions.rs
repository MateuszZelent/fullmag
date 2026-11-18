use std::{path::Path, time::Duration};

use fullmag_authoring::{
    validate_material_source, validate_material_version_key, SceneMaterialSource,
    SceneMaterialSourceKind, SceneMaterialVersionSource,
};
use rusqlite::{
    params, Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::{
    advance_revision, builtin_entry, database_identity, decode_entry,
    default_material_library_path, require_custom_id, unsupported_database,
    MaterialLibraryEntryResource, MaterialLibraryError, MaterialLibraryStore, Result,
    APPLICATION_ID,
};

pub const MAX_PUBLISHED_MATERIAL_CATALOG_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct PublishedMaterialVersion {
    pub source: SceneMaterialSource,
    pub original: Option<SceneMaterialSource>,
    pub display_name: String,
    pub archived: bool,
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct MaterialVersionPublishRequest {
    pub material_id: String,
    /// Revision of the source entry.
    pub base_revision: u64,
    pub family: String,
    pub version: String,
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_project: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct MaterialVersionUpdateRequest {
    /// Revision of the published version's metadata.
    pub base_revision: u64,
    pub display_name: String,
    pub archived: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct MaterialVersionMutationResource {
    pub catalog_revision: u64,
    pub published: PublishedMaterialVersion,
}

/// Read the current user's published versions, including archives, without migrating the database.
pub fn read_published_material_versions() -> Result<Vec<PublishedMaterialVersion>> {
    let path = default_material_library_path()
        .map_err(|error| MaterialLibraryError::Storage(error.into()))?;
    read_published_material_versions_at(&path)
}

pub(super) fn read_published_material_versions_at(
    path: &Path,
) -> Result<Vec<PublishedMaterialVersion>> {
    if !path
        .try_exists()
        .map_err(|error| MaterialLibraryError::Storage(error.into()))?
    {
        return Ok(Vec::new());
    }
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    connection.busy_timeout(Duration::from_secs(5))?;
    let transaction = connection.unchecked_transaction()?;
    let versions = match database_identity(&transaction)? {
        (APPLICATION_ID, 1) => Vec::new(),
        (APPLICATION_ID, 2) => read_versions(&transaction, MAX_PUBLISHED_MATERIAL_CATALOG_BYTES)?,
        _ => return Err(unsupported_database()),
    };
    transaction.commit()?;
    Ok(versions)
}

impl MaterialLibraryStore {
    pub fn publish(
        &mut self,
        request: MaterialVersionPublishRequest,
    ) -> Result<MaterialVersionMutationResource> {
        let mut key = SceneMaterialVersionSource {
            family: request.family,
            version: request.version,
            source_project: request.source_project.map(|value| value.trim().to_owned()),
            copied_from_family: None,
        };
        key.validate().map_err(MaterialLibraryError::Invalid)?;
        let display_name = normalize_display_name(&request.display_name)?;
        validate_base_revision(request.base_revision)?;
        let catalog_id = key.catalog_id();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let entry =
            load_entry_to_publish(&transaction, &request.material_id, request.base_revision)?;
        if transaction
            .query_row(
                "SELECT 1 FROM published_material_versions WHERE family=?1 AND version=?2",
                params![key.family, key.version],
                |_| Ok(()),
            )
            .optional()?
            .is_some()
            || transaction
                .query_row(
                    "SELECT 1 FROM material_entries WHERE id=?1",
                    [&catalog_id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some()
        {
            return Err(MaterialLibraryError::Conflict(format!(
                "material version already exists: {}.{}",
                key.family, key.version
            )));
        }

        let mut source = entry.source_snapshot();
        let upstream = entry.source.as_ref().unwrap_or(&source);
        key.copied_from_family = upstream_family(upstream)
            .filter(|family| *family != key.family.as_str())
            .map(str::to_owned);
        let original = builtin_entry(&key.family).map(|entry| entry.source_snapshot());
        source.catalog_id = catalog_id;
        source.name = display_name.clone();
        if source.kind == SceneMaterialSourceKind::Builtin {
            source.kind = SceneMaterialSourceKind::Modified;
        }
        source.version = Some(key.clone());
        validate_material_source(&source).map_err(MaterialLibraryError::Invalid)?;

        let catalog_revision = advance_revision(&transaction)?;
        source.catalog_revision = catalog_revision;
        let published = PublishedMaterialVersion {
            source,
            original,
            display_name,
            archived: false,
            revision: catalog_revision,
        };
        let document = serde_json::to_string(&published)?;
        ensure_catalog_capacity(&transaction, None, document.len())?;
        transaction.execute(
            "INSERT INTO published_material_versions(family,version,revision,document) VALUES(?1,?2,?3,?4)",
            params![key.family, key.version, published.revision, document],
        )?;
        transaction.commit()?;
        Ok(MaterialVersionMutationResource {
            catalog_revision,
            published,
        })
    }

    pub fn update_version(
        &mut self,
        family: &str,
        version: &str,
        request: MaterialVersionUpdateRequest,
    ) -> Result<MaterialVersionMutationResource> {
        validate_material_version_key("family", family).map_err(MaterialLibraryError::Invalid)?;
        validate_material_version_key("version", version).map_err(MaterialLibraryError::Invalid)?;
        let display_name = normalize_display_name(&request.display_name)?;
        validate_base_revision(request.base_revision)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (revision, document): (u64, String) = transaction
            .query_row(
                "SELECT revision,document FROM published_material_versions WHERE family=?1 AND version=?2",
                [family, version],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| MaterialLibraryError::NotFound(format!("material version not found: {family}.{version}")))?;
        if revision != request.base_revision {
            return Err(MaterialLibraryError::Conflict(format!(
                "material version revision conflict: {family}.{version}; reload before saving"
            )));
        }
        let mut published = decode_version(family, version, revision, &document)?;
        let catalog_revision = advance_revision(&transaction)?;
        published.display_name = display_name;
        published.archived = request.archived;
        published.revision = catalog_revision;
        let updated_document = serde_json::to_string(&published)?;
        ensure_catalog_capacity(&transaction, Some(document.len()), updated_document.len())?;
        transaction.execute(
            "UPDATE published_material_versions SET revision=?1,document=?2 WHERE family=?3 AND version=?4",
            params![published.revision, updated_document, family, version],
        )?;
        transaction.commit()?;
        Ok(MaterialVersionMutationResource {
            catalog_revision,
            published,
        })
    }
}

fn ensure_catalog_capacity(
    transaction: &Transaction<'_>,
    previous_bytes: Option<usize>,
    document_bytes: usize,
) -> Result<()> {
    if previous_bytes.is_some_and(|previous| document_bytes <= previous) {
        // Allow repairs that shrink an oversized database.
        return Ok(());
    }
    let stored_bytes: u64 = transaction.query_row(
        "SELECT coalesce(sum(length(CAST(document AS BLOB)) + 1), 0)
         FROM published_material_versions",
        [],
        |row| row.get(0),
    )?;
    let replaced_bytes = previous_bytes.map_or(0, |length| length as u64 + 1);
    let bytes = stored_bytes
        .saturating_sub(replaced_bytes)
        .saturating_add(document_bytes as u64 + 1);
    check_catalog_capacity(bytes, MAX_PUBLISHED_MATERIAL_CATALOG_BYTES)
}

/// The total charges one byte per document for its comma. Add the array
/// brackets and subtract the absent trailing comma for a nonempty array.
fn check_catalog_capacity(document_bytes: u64, byte_limit: usize) -> Result<()> {
    if document_bytes.saturating_add(1).max(2) > byte_limit as u64 {
        return Err(MaterialLibraryError::Invalid(format!(
            "published material catalog exceeds the {byte_limit}-byte limit"
        )));
    }
    Ok(())
}

pub(super) fn read_versions(
    transaction: &Transaction<'_>,
    byte_limit: usize,
) -> Result<Vec<PublishedMaterialVersion>> {
    let mut statement = transaction.prepare(
        "SELECT family,version,revision,length(CAST(document AS BLOB)),document
         FROM published_material_versions ORDER BY family,version",
    )?;
    let mut rows = statement.query([])?;
    let mut versions = Vec::new();
    let mut bytes = 0u64;
    check_catalog_capacity(bytes, byte_limit)?;
    while let Some(row) = rows.next()? {
        let length: u64 = row.get(3)?;
        bytes = bytes.saturating_add(length).saturating_add(1);
        check_catalog_capacity(bytes, byte_limit)?;
        let family: String = row.get(0)?;
        let version: String = row.get(1)?;
        let revision = row.get(2)?;
        let document: String = row.get(4)?;
        versions.push(decode_version(&family, &version, revision, &document)?);
    }
    Ok(versions)
}

fn load_entry_to_publish(
    transaction: &Transaction<'_>,
    id: &str,
    expected_revision: u64,
) -> Result<MaterialLibraryEntryResource> {
    let entry = if let Some(family) = id.strip_prefix("builtin:") {
        builtin_entry(family)
    } else {
        require_custom_id(id)?;
        let document: Option<(u64, String)> = transaction
            .query_row(
                "SELECT revision,document FROM material_entries WHERE id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        document
            .map(|(revision, document)| decode_entry(id, revision, &document))
            .transpose()?
    }
    .ok_or_else(|| MaterialLibraryError::NotFound(format!("material not found: {id}")))?;
    if entry.revision != expected_revision {
        return Err(MaterialLibraryError::Conflict(
            "material revision conflict; reload before publishing".into(),
        ));
    }
    Ok(entry)
}

fn decode_version(
    family: &str,
    version: &str,
    revision: u64,
    document: &str,
) -> Result<PublishedMaterialVersion> {
    let published: PublishedMaterialVersion = serde_json::from_str(document)?;
    let valid_key = published
        .source
        .version
        .as_ref()
        .is_some_and(|key| key.family == family && key.version == version);
    let valid_original = published.original.as_ref().is_none_or(|original| {
        original.catalog_id == format!("builtin:{family}")
            && original.version.is_none()
            && validate_material_source(original).is_ok()
    });
    if !valid_key
        || !valid_original
        || published.revision != revision
        || published.source.catalog_revision > revision
        || normalize_display_name(&published.display_name).is_err()
    {
        return Err(MaterialLibraryError::Storage(anyhow::anyhow!(
            "invalid stored material version {family}.{version}"
        )));
    }
    validate_material_source(&published.source).map_err(|error| {
        MaterialLibraryError::Storage(anyhow::anyhow!(
            "invalid stored material version {family}.{version}: {error}"
        ))
    })?;
    Ok(published)
}

fn upstream_family(source: &SceneMaterialSource) -> Option<&str> {
    source
        .version
        .as_ref()
        .map(|key| key.family.as_str())
        .or_else(|| {
            let family = source.catalog_id.strip_prefix("builtin:")?;
            validate_material_version_key("family", family).ok()?;
            Some(family)
        })
}

fn normalize_display_name(value: &str) -> Result<String> {
    let name = value.trim();
    if name.is_empty() || name.chars().count() > 240 {
        return Err(MaterialLibraryError::Invalid(
            "material version display name must contain 1 to 240 characters".into(),
        ));
    }
    Ok(name.to_owned())
}

fn validate_base_revision(value: u64) -> Result<()> {
    if value == 0 {
        return Err(MaterialLibraryError::Invalid(
            "base_revision must be positive".into(),
        ));
    }
    Ok(())
}
