//! Durable, immutable execution-profile publications for a `SessionStore`.

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use chrono::{DateTime, SecondsFormat, Utc};
use fullmag_ir::ExecutionProfileIR;
use serde::{Deserialize, Serialize};

use crate::store::SessionStore;

pub const EXECUTION_PROFILE_CATALOG_SCHEMA: &str = "execution_profile_catalog.v1";

const EXECUTION_PROFILE_CATALOG_PATH: &str = "compute/EXECUTION_PROFILES.json";
const MAX_PROFILE_CATALOG_ENTRIES: usize = 1024;
const MAX_PROFILE_CATALOG_BYTES: usize = 4 * 1024 * 1024;
const MAX_EXECUTION_PROFILE_BYTES: usize = 32 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionProfileCatalog {
    pub schema_version: String,
    pub revision: u64,
    pub entries: Vec<ExecutionProfileCatalogEntry>,
}

impl Default for ExecutionProfileCatalog {
    fn default() -> Self {
        Self {
            schema_version: EXECUTION_PROFILE_CATALOG_SCHEMA.into(),
            revision: 0,
            entries: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionProfileCatalogEntry {
    pub profile: ExecutionProfileIR,
    pub profile_sha256: String,
    pub client_intent_id: String,
    pub published_at: String,
    pub revision: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProfilePublicationDisposition {
    Published,
    Existing,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProfilePublication {
    pub disposition: ProfilePublicationDisposition,
    pub catalog: ExecutionProfileCatalog,
    pub entry: ExecutionProfileCatalogEntry,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProfileCatalogError {
    Invalid(String),
    RevisionConflict { expected: u64, actual: u64 },
    IntentConflict,
    VersionConflict,
    CapacityExceeded,
    Storage(String),
}

impl std::fmt::Display for ProfileCatalogError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(reason) => {
                write!(formatter, "invalid execution profile catalog: {reason}")
            }
            Self::RevisionConflict { expected, actual } => write!(
                formatter,
                "execution profile catalog revision conflict: expected {expected}, found {actual}"
            ),
            Self::IntentConflict => write!(
                formatter,
                "client intent id was already published with different profile content"
            ),
            Self::VersionConflict => write!(
                formatter,
                "execution profile id and version are already published"
            ),
            Self::CapacityExceeded => {
                write!(formatter, "execution profile catalog capacity exceeded")
            }
            Self::Storage(reason) => write!(
                formatter,
                "execution profile catalog storage error: {reason}"
            ),
        }
    }
}

impl std::error::Error for ProfileCatalogError {}

impl SessionStore {
    /// Read the immutable execution-profile catalog. A missing catalog is an
    /// empty catalog; malformed, unsupported, oversized, or unreadable files
    /// remain errors and are never silently replaced with an empty value.
    pub fn read_execution_profile_catalog(
        &self,
    ) -> Result<ExecutionProfileCatalog, ProfileCatalogError> {
        read_catalog(self.root())
    }

    /// Publish a new immutable profile, using the store's writer lease to
    /// serialize revision checks and the atomic catalog replacement.
    pub fn publish_execution_profile(
        &self,
        expected_revision: u64,
        client_intent_id: &str,
        profile: ExecutionProfileIR,
    ) -> Result<ProfilePublication, ProfileCatalogError> {
        let _writer = self
            .write_transaction()
            .map_err(|error| ProfileCatalogError::Storage(error.to_string()))?;

        profile
            .validate()
            .map_err(|error| ProfileCatalogError::Invalid(error.to_string()))?;
        crate::repository_path::validate_store_id(client_intent_id)
            .map_err(|error| ProfileCatalogError::Invalid(error.to_string()))?;
        enforce_profile_size(&profile)?;
        let profile_sha256 = profile
            .canonical_sha256()
            .map_err(ProfileCatalogError::Invalid)?;

        let mut catalog = read_catalog(self.root()).map_err(|error| {
            ProfileCatalogError::Storage(format!("read existing catalog: {error}"))
        })?;
        if let Some(existing) = catalog
            .entries
            .iter()
            .find(|entry| entry.client_intent_id == client_intent_id)
        {
            // Sparse empty blocks disappear from canonical JSON on disk.
            // Replay compares canonical content, not the pre-serialization
            // distinction between Absent and Value(empty).
            if existing.profile_sha256 == profile_sha256 {
                let entry = existing.clone();
                return Ok(ProfilePublication {
                    disposition: ProfilePublicationDisposition::Existing,
                    catalog,
                    entry,
                });
            }
            return Err(ProfileCatalogError::IntentConflict);
        }

        if catalog.entries.iter().any(|entry| {
            entry.profile.profile_id == profile.profile_id
                && entry.profile.version == profile.version
        }) {
            return Err(ProfileCatalogError::VersionConflict);
        }
        if catalog.revision != expected_revision {
            return Err(ProfileCatalogError::RevisionConflict {
                expected: expected_revision,
                actual: catalog.revision,
            });
        }
        if catalog.entries.len() >= MAX_PROFILE_CATALOG_ENTRIES {
            return Err(ProfileCatalogError::CapacityExceeded);
        }

        let revision = catalog
            .revision
            .checked_add(1)
            .ok_or(ProfileCatalogError::CapacityExceeded)?;
        let entry = ExecutionProfileCatalogEntry {
            profile,
            profile_sha256,
            client_intent_id: client_intent_id.into(),
            published_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            revision,
        };
        catalog.revision = revision;
        catalog.entries.push(entry.clone());
        validate_catalog(&catalog)?;
        let bytes = serde_json::to_vec_pretty(&catalog)
            .map_err(|error| ProfileCatalogError::Invalid(error.to_string()))?;
        if bytes.len() > MAX_PROFILE_CATALOG_BYTES {
            return Err(ProfileCatalogError::CapacityExceeded);
        }

        let destination =
            crate::repository_path::create_parent(self.root(), EXECUTION_PROFILE_CATALOG_PATH)
                .map_err(|error| ProfileCatalogError::Storage(error.to_string()))?;
        crate::durability::atomic_write_owner(&destination, &bytes)
            .map_err(|error| ProfileCatalogError::Storage(error.to_string()))?;

        Ok(ProfilePublication {
            disposition: ProfilePublicationDisposition::Published,
            catalog,
            entry,
        })
    }
}

fn read_catalog(root: &Path) -> Result<ExecutionProfileCatalog, ProfileCatalogError> {
    let path = crate::repository_path::checked_path(root, EXECUTION_PROFILE_CATALOG_PATH)
        .map_err(|error| ProfileCatalogError::Storage(error.to_string()))?;
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ExecutionProfileCatalog::default());
        }
        Err(error) => return Err(ProfileCatalogError::Storage(error.to_string())),
        Ok(metadata) => {
            if metadata.is_file() && metadata.len() > MAX_PROFILE_CATALOG_BYTES as u64 {
                return Err(ProfileCatalogError::CapacityExceeded);
            }
        }
    }

    let bytes = crate::repository_path::read_bounded_regular_file(
        root,
        EXECUTION_PROFILE_CATALOG_PATH,
        MAX_PROFILE_CATALOG_BYTES,
    )
    .map_err(|error| ProfileCatalogError::Storage(error.to_string()))?;
    let catalog: ExecutionProfileCatalog = serde_json::from_slice(&bytes)
        .map_err(|error| ProfileCatalogError::Invalid(error.to_string()))?;
    validate_catalog(&catalog)?;
    Ok(catalog)
}

fn validate_catalog(catalog: &ExecutionProfileCatalog) -> Result<(), ProfileCatalogError> {
    if catalog.schema_version != EXECUTION_PROFILE_CATALOG_SCHEMA {
        return Err(ProfileCatalogError::Invalid(format!(
            "unsupported schema version `{}`",
            catalog.schema_version
        )));
    }
    if catalog.entries.len() > MAX_PROFILE_CATALOG_ENTRIES {
        return Err(ProfileCatalogError::CapacityExceeded);
    }
    if catalog.revision != catalog.entries.len() as u64 {
        return Err(ProfileCatalogError::Invalid(
            "revision does not equal the sequential entry count".into(),
        ));
    }

    let mut client_intents = HashSet::with_capacity(catalog.entries.len());
    let mut profile_versions = HashSet::with_capacity(catalog.entries.len());
    for (index, entry) in catalog.entries.iter().enumerate() {
        let expected_revision = index as u64 + 1;
        if entry.revision != expected_revision {
            return Err(ProfileCatalogError::Invalid(format!(
                "entry revision {} is not sequential; expected {expected_revision}",
                entry.revision
            )));
        }
        entry
            .profile
            .validate()
            .map_err(ProfileCatalogError::Invalid)?;
        enforce_profile_size(&entry.profile)?;
        let expected_hash = entry
            .profile
            .canonical_sha256()
            .map_err(ProfileCatalogError::Invalid)?;
        if entry.profile_sha256 != expected_hash {
            return Err(ProfileCatalogError::Invalid(format!(
                "profile hash does not match `{}` version `{}`",
                entry.profile.profile_id, entry.profile.version
            )));
        }
        crate::repository_path::validate_store_id(&entry.client_intent_id).map_err(|error| {
            ProfileCatalogError::Invalid(format!("invalid client_intent_id: {error}"))
        })?;
        if !client_intents.insert(entry.client_intent_id.as_str()) {
            return Err(ProfileCatalogError::Invalid(
                "client_intent_id values must be unique".into(),
            ));
        }
        if !profile_versions.insert((
            entry.profile.profile_id.as_str(),
            entry.profile.version.as_str(),
        )) {
            return Err(ProfileCatalogError::Invalid(
                "profile id and version pairs must be unique".into(),
            ));
        }
        let published_at = DateTime::parse_from_rfc3339(&entry.published_at).map_err(|error| {
            ProfileCatalogError::Invalid(format!("published_at is not RFC3339: {error}"))
        })?;
        if published_at.offset().local_minus_utc() != 0 {
            return Err(ProfileCatalogError::Invalid(
                "published_at must use a UTC offset".into(),
            ));
        }
    }
    let bytes = serde_json::to_vec(catalog)
        .map_err(|error| ProfileCatalogError::Invalid(error.to_string()))?;
    if bytes.len() > MAX_PROFILE_CATALOG_BYTES {
        return Err(ProfileCatalogError::CapacityExceeded);
    }
    Ok(())
}

fn enforce_profile_size(profile: &ExecutionProfileIR) -> Result<(), ProfileCatalogError> {
    let bytes = serde_json::to_vec(profile)
        .map_err(|error| ProfileCatalogError::Invalid(error.to_string()))?;
    if bytes.len() > MAX_EXECUTION_PROFILE_BYTES {
        return Err(ProfileCatalogError::Invalid(
            "execution profile exceeds 32 KiB".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
#[path = "execution_profiles_tests.rs"]
mod tests;
