//! Filesystem-backed project repository for the application lifecycle.
//!
//! The application crate owns the lifecycle contract; this module owns the
//! portable `.fms` project archive and its publication boundary.  The writer
//! is intentionally independent from the runtime session store: opening a
//! project only parses bytes and never starts a solver, mesher, Python
//! process, or runner job.

use crate::project::{
    MigrationReport, OpaqueAsset, OpaqueDocument, ProjectDefinition, ProjectEnvelope, ProjectId,
    ProjectSource, ProjectTarget, RawJsonEnvelope, CURRENT_PROJECT_SCHEMA, CURRENT_SCENE_SCHEMA,
};
use crate::repository::{
    DurabilityGuarantee, ProjectRepository, RepositoryCommitRequest, RepositoryCommitResult,
    RepositoryOpenResult,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

const ARCHIVE_FORMAT: &str = "fullmag.project.archive.v1";
const MANIFEST_PATH: &str = "manifest/project.json";
const DEFINITION_PATH: &str = "project/definition.json";
const SCENE_PATH: &str = "project/scene_document.json";
const MAX_ZIP_ENTRIES: usize = 100_000;
const MAX_UNCOMPRESSED_ZIP_BYTES: u64 = 64 * 1024 * 1024 * 1024;

/// A conservative archive reader/writer.  Limits are deliberately fixed for
/// the first production adapter; changing them is a format/security decision.
#[derive(Clone, Debug)]
pub struct FileProjectRepository {
    compression: CompressionMethod,
}

impl Default for FileProjectRepository {
    fn default() -> Self {
        Self {
            compression: CompressionMethod::Deflated,
        }
    }
}

impl FileProjectRepository {
    pub fn new() -> Self {
        Self::default()
    }

    /// Encode a validated project envelope as a portable `.fms` archive.
    ///
    /// This is a serialization operation only: it does not publish a target,
    /// acquire a writer lock, or claim filesystem durability.  File-backed
    /// saves continue to use [`ProjectRepository::commit`], while HTTP,
    /// desktop, and download adapters can use the same archive codec without
    /// introducing a second writer implementation.
    pub fn encode_archive(
        &self,
        envelope: &ProjectEnvelope,
    ) -> Result<Vec<u8>, FileRepositoryError> {
        envelope
            .validate_for_save()
            .map_err(|error| FileRepositoryError(error.to_string()))?;
        write_archive(envelope, self.compression)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileRepositoryError(pub String);

impl fmt::Display for FileRepositoryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for FileRepositoryError {}

impl ProjectRepository for FileProjectRepository {
    type Error = FileRepositoryError;

    fn open(&self, source: ProjectSource) -> Result<RepositoryOpenResult, Self::Error> {
        let (bytes, source_for_result) = read_source(&source)?;
        let source_hash = Some(sha256_hex(&bytes));
        let entries = read_archive(&bytes)?;
        let mut result = if entries.contains_key(MANIFEST_PATH) {
            parse_current_archive(&entries, source_for_result.clone())?
        } else if entries.contains_key("manifest/session.json")
            && entries.contains_key("manifest/workspace.json")
        {
            parse_legacy_archive(&entries, source_for_result.clone(), &bytes)?
        } else {
            return Err(FileRepositoryError(
                "archive has no supported Fullmag project or legacy session manifest".into(),
            ));
        };
        result.source_hash = source_hash;
        Ok(result)
    }

    fn commit(
        &self,
        request: RepositoryCommitRequest,
    ) -> Result<RepositoryCommitResult, Self::Error> {
        request
            .envelope
            .validate_for_save()
            .map_err(|error| FileRepositoryError(error.to_string()))?;
        let target = request.target.path().clone();
        let parent = validate_target(&target)?;
        let _lock = WriterLock::acquire(&parent, &target)?;
        validate_target(&target)?;

        let existing = match fs::symlink_metadata(&target) {
            Ok(metadata) => {
                if metadata_is_link(&metadata) || !metadata.file_type().is_file() {
                    return Err(FileRepositoryError(format!(
                        "project target is not a regular file: {}",
                        target.display()
                    )));
                }
                Some(self.open(ProjectSource::Path(target.clone()))?)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => {
                return Err(FileRepositoryError(format!(
                    "reading project target {}: {error}",
                    target.display()
                )))
            }
        };

        match (
            request.expected_project_id.as_ref(),
            request.expected_revision,
            existing.as_ref(),
        ) {
            (None, None, Some(_)) => {
                return Err(FileRepositoryError(format!(
                    "project target already exists: {}",
                    target.display()
                )))
            }
            (Some(expected_id), Some(expected_revision), Some(opened)) => {
                if opened.envelope.definition.project_id != *expected_id {
                    return Err(FileRepositoryError(format!(
                        "project identity conflict at {}: expected {}, found {}",
                        target.display(),
                        expected_id.as_str(),
                        opened.envelope.definition.project_id.as_str()
                    )));
                }
                if opened.envelope.definition.revision != expected_revision {
                    return Err(FileRepositoryError(format!(
                        "revision conflict at {}: expected {}, found {}",
                        target.display(),
                        expected_revision,
                        opened.envelope.definition.revision
                    )));
                }
                if !opened.migration.can_write || opened.read_only_reason.is_some() {
                    return Err(FileRepositoryError(
                        "existing project is read-only and cannot be updated".into(),
                    ));
                }
            }
            (Some(_), Some(_), None) => {
                return Err(FileRepositoryError(format!(
                    "expected existing project target is missing: {}",
                    target.display()
                )))
            }
            (Some(_), None, _) | (None, Some(_), _) => {
                return Err(FileRepositoryError(
                    "expected project identity and revision must be supplied together".into(),
                ))
            }
            (None, None, None) => {}
        }

        let archive = self.encode_archive(&request.envelope)?;
        let temporary = parent.join(format!(
            ".{}.{}.part",
            target
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("project"),
            Uuid::new_v4().simple()
        ));
        let mut parent_directory_synced = false;
        let result = (|| -> Result<(), FileRepositoryError> {
            let mut file = File::create_new(&temporary).map_err(|error| {
                FileRepositoryError(format!(
                    "creating staged project {}: {error}",
                    temporary.display()
                ))
            })?;
            file.write_all(&archive).map_err(|error| {
                FileRepositoryError(format!(
                    "writing staged project {}: {error}",
                    temporary.display()
                ))
            })?;
            file.sync_all().map_err(|error| {
                FileRepositoryError(format!(
                    "syncing staged project {}: {error}",
                    temporary.display()
                ))
            })?;
            drop(file);
            fs::rename(&temporary, &target).map_err(|error| {
                FileRepositoryError(format!("publishing project {}: {error}", target.display()))
            })?;
            // The Windows filesystem API does not provide the same directory
            // barrier as POSIX.  The receipt reports that fact instead of
            // upgrading it to a power-loss guarantee.
            parent_directory_synced = sync_parent(&parent)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result?;

        Ok(RepositoryCommitResult {
            project_id: request.envelope.definition.project_id,
            revision: request.envelope.definition.revision,
            target: request.target,
            source_hash: Some(sha256_hex(&archive)),
            durability: DurabilityGuarantee::FilesystemSynced {
                data_file_synced: true,
                parent_directory_synced,
                power_loss_qualified: false,
            },
        })
    }
}

#[derive(Debug, Deserialize, Serialize)]
struct ArchiveManifest {
    format: String,
    project_schema: String,
    scene_schema: String,
    definition: String,
    scene: String,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    assets: Vec<ArchiveAsset>,
    #[serde(default)]
    opaque_documents: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct ArchiveAsset {
    path: String,
    #[serde(default)]
    media_type: Option<String>,
}

fn read_source(source: &ProjectSource) -> Result<(Vec<u8>, ProjectSource), FileRepositoryError> {
    match source {
        ProjectSource::Bytes {
            display_name,
            bytes,
        } => Ok((
            bytes.clone(),
            ProjectSource::Bytes {
                display_name: display_name.clone(),
                bytes: bytes.clone(),
            },
        )),
        ProjectSource::Path(path) => {
            reject_link_chain(path)?;
            let bytes = fs::read(path).map_err(|error| {
                FileRepositoryError(format!("reading project {}: {error}", path.display()))
            })?;
            Ok((bytes, ProjectSource::Path(path.clone())))
        }
    }
}

fn read_archive(bytes: &[u8]) -> Result<BTreeMap<String, Vec<u8>>, FileRepositoryError> {
    let mut archive = ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| FileRepositoryError(format!("opening project ZIP archive: {error}")))?;
    if archive.len() > MAX_ZIP_ENTRIES {
        return Err(FileRepositoryError(format!(
            "too many ZIP entries: {} exceeds {MAX_ZIP_ENTRIES}",
            archive.len()
        )));
    }
    let mut entries = BTreeMap::new();
    let mut folded = BTreeSet::new();
    let mut total = 0_u64;
    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|error| FileRepositoryError(format!("reading ZIP entry {index}: {error}")))?;
        let name = file.name().to_string();
        validate_archive_entry(&name, file.is_dir(), file.unix_mode())?;
        let key = name.to_ascii_lowercase();
        if !folded.insert(key) {
            return Err(FileRepositoryError(format!(
                "case-folded duplicate ZIP entry `{name}`"
            )));
        }
        total = total
            .checked_add(file.size())
            .ok_or_else(|| FileRepositoryError("ZIP size overflow".into()))?;
        if total > MAX_UNCOMPRESSED_ZIP_BYTES {
            return Err(FileRepositoryError(format!(
                "uncompressed ZIP size exceeds {MAX_UNCOMPRESSED_ZIP_BYTES} bytes"
            )));
        }
        let mut data = Vec::with_capacity(file.size().min(16 * 1024 * 1024) as usize);
        file.read_to_end(&mut data)
            .map_err(|error| FileRepositoryError(format!("reading ZIP entry `{name}`: {error}")))?;
        if data.len() as u64 != file.size() {
            return Err(FileRepositoryError(format!(
                "ZIP entry `{name}` size changed while reading"
            )));
        }
        entries.insert(name, data);
    }
    Ok(entries)
}

fn validate_archive_entry(
    name: &str,
    is_dir: bool,
    unix_mode: Option<u32>,
) -> Result<(), FileRepositoryError> {
    if is_dir || name.is_empty() || name.ends_with('/') || name.starts_with('/') {
        return Err(FileRepositoryError(format!(
            "unsafe project archive path `{name}`"
        )));
    }
    if name.contains('\\') || name.contains(':') {
        return Err(FileRepositoryError(format!(
            "unsafe project archive path `{name}`"
        )));
    }
    if unix_mode.is_some_and(|mode| mode & 0o170000 == 0o120000) {
        return Err(FileRepositoryError(format!(
            "symlink ZIP entries are not allowed: `{name}`"
        )));
    }
    for component in name.split('/') {
        if component.is_empty()
            || component == "."
            || component == ".."
            || component.len() > 255
            || component.ends_with([' ', '.'])
            || component
                .chars()
                .any(|character| character.is_control() || "<>\"|?*".contains(character))
        {
            return Err(FileRepositoryError(format!(
                "unsafe project archive path `{name}`"
            )));
        }
    }
    Ok(())
}

fn parse_current_archive(
    entries: &BTreeMap<String, Vec<u8>>,
    source: ProjectSource,
) -> Result<RepositoryOpenResult, FileRepositoryError> {
    let manifest = parse_json::<ArchiveManifest>(
        entries
            .get(MANIFEST_PATH)
            .ok_or_else(|| FileRepositoryError("missing project archive manifest".into()))?,
        MANIFEST_PATH,
    )?;
    if manifest.format != ARCHIVE_FORMAT {
        return Err(FileRepositoryError(format!(
            "unsupported project archive format `{}`",
            manifest.format
        )));
    }
    let definition_bytes = required_entry(entries, &manifest.definition)?;
    let scene_bytes = required_entry(entries, &manifest.scene)?;
    let raw_definition = RawJsonEnvelope::from_bytes(definition_bytes.to_vec())
        .map_err(|error| FileRepositoryError(error.to_string()))?;
    let raw_scene = RawJsonEnvelope::from_bytes(scene_bytes.to_vec())
        .map_err(|error| FileRepositoryError(error.to_string()))?;
    let definition_value = raw_definition
        .value()
        .as_object()
        .ok_or_else(|| FileRepositoryError("project definition must be a JSON object".into()))?;
    let project_id = ProjectId::parse(
        definition_value
            .get("project_id")
            .and_then(Value::as_str)
            .ok_or_else(|| FileRepositoryError("project definition has no project_id".into()))?,
    )
    .map_err(|error| FileRepositoryError(error.to_string()))?;
    let schema_version = definition_value
        .get("schema")
        .and_then(Value::as_str)
        .unwrap_or(&manifest.project_schema)
        .to_string();
    let name = definition_value
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| FileRepositoryError("project definition has no name".into()))?
        .to_string();
    let revision = definition_value
        .get("revision")
        .and_then(Value::as_u64)
        .ok_or_else(|| FileRepositoryError("project definition has no numeric revision".into()))?;
    let definition_scene = definition_value
        .get("scene")
        .ok_or_else(|| FileRepositoryError("project definition has no scene".into()))?;
    if definition_scene != raw_scene.value() {
        return Err(FileRepositoryError(
            "project definition scene does not match scene document".into(),
        ));
    }
    let definition = ProjectDefinition {
        project_id,
        schema_version: schema_version.clone(),
        name,
        revision,
        scene: raw_scene,
    };
    let source_document = manifest
        .source
        .as_deref()
        .map(|path| document_from_entry(entries, path))
        .transpose()?;
    let mut assets = Vec::new();
    for descriptor in &manifest.assets {
        let bytes = required_entry(entries, &descriptor.path)?;
        assets.push(
            OpaqueAsset::new(
                &descriptor.path,
                bytes.to_vec(),
                descriptor.media_type.clone(),
            )
            .map_err(|error| FileRepositoryError(error.to_string()))?,
        );
    }
    let listed: BTreeSet<String> = manifest.opaque_documents.iter().cloned().collect();
    let mut opaque_documents = Vec::new();
    for path in &manifest.opaque_documents {
        opaque_documents.push(document_from_entry(entries, path)?);
    }
    // A current archive may have been written by an older P1 writer that did
    // not list opaque entries.  Preserve those project entries instead of
    // silently dropping them.
    for (path, bytes) in entries {
        if !path.starts_with("project/")
            || path == manifest.definition.as_str()
            || path == manifest.scene.as_str()
            || manifest.source.as_deref() == Some(path.as_str())
            || manifest.assets.iter().any(|asset| asset.path == *path)
            || listed.contains(path)
        {
            continue;
        }
        opaque_documents.push(
            OpaqueDocument::new(path, bytes.clone())
                .map_err(|error| FileRepositoryError(error.to_string()))?,
        );
    }
    let envelope = ProjectEnvelope {
        definition,
        raw_definition,
        source: source_document,
        assets,
        opaque_documents,
    };
    let scene_schema = envelope
        .definition
        .scene
        .value()
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let writable = schema_version == CURRENT_PROJECT_SCHEMA && scene_schema == CURRENT_SCENE_SCHEMA;
    let migration = if writable {
        MigrationReport::current()
    } else {
        MigrationReport::unsupported(
            schema_version.clone(),
            format!(
                "project schema `{schema_version}` or scene schema `{scene_schema}` is not writable"
            ),
        )
    };
    Ok(RepositoryOpenResult {
        envelope,
        source: source.clone(),
        source_hash: None,
        target: match source {
            ProjectSource::Path(path) => Some(ProjectTarget::Path(path)),
            ProjectSource::Bytes { .. } => None,
        },
        migration: migration.clone(),
        read_only_reason: (!writable).then(|| migration.warnings[0].clone()),
    })
}

fn parse_legacy_archive(
    entries: &BTreeMap<String, Vec<u8>>,
    source: ProjectSource,
    archive_bytes: &[u8],
) -> Result<RepositoryOpenResult, FileRepositoryError> {
    let session = parse_json_value(
        required_entry(entries, "manifest/session.json")?,
        "manifest/session.json",
    )?;
    let workspace = parse_json_value(
        required_entry(entries, "manifest/workspace.json")?,
        "manifest/workspace.json",
    )?;
    let archive_hash = sha256_hex(archive_bytes);
    let project_id = ProjectId::parse(format!("project-legacy-{}", &archive_hash[..24]))
        .map_err(|error| FileRepositoryError(error.to_string()))?;
    let name = workspace
        .get("problem_name")
        .and_then(Value::as_str)
        .or_else(|| session.get("title").and_then(Value::as_str))
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("Migrated Fullmag session")
        .to_string();
    let source_path = workspace
        .get("script_ref")
        .and_then(Value::as_str)
        .unwrap_or("project/main.py");
    let scene_path = workspace
        .get("scene_document_ref")
        .and_then(Value::as_str)
        .unwrap_or(SCENE_PATH);
    let mut warnings = vec![
        "legacy session archive was opened through a read-only runtime-free migration adapter; the original archive is unchanged".into(),
    ];
    let source_document = if entries.contains_key(source_path) && valid_project_path(source_path) {
        Some(
            OpaqueDocument::new(source_path, entries[source_path].clone())
                .map_err(|error| FileRepositoryError(error.to_string()))?,
        )
    } else {
        warnings.push(format!(
            "legacy script `{source_path}` was not available as a project source"
        ));
        None
    };
    let legacy_scene_bytes = entries
        .get(scene_path)
        .cloned()
        .unwrap_or_else(|| b"{}".to_vec());
    let raw_scene = RawJsonEnvelope::from_bytes(legacy_scene_bytes.clone())
        .map_err(|error| FileRepositoryError(format!("legacy scene JSON: {error}")))?;
    let scene = if raw_scene.value().get("version").and_then(Value::as_str)
        == Some(CURRENT_SCENE_SCHEMA)
    {
        raw_scene
    } else {
        warnings.push("legacy scene document was wrapped in scene.v2; the original bytes were preserved under project/legacy/".into());
        RawJsonEnvelope::from_value(serde_json::json!({
            "version": CURRENT_SCENE_SCHEMA,
            "legacy_document": raw_scene.value(),
            "migration": "fullmag.session.v1"
        }))
        .map_err(|error| FileRepositoryError(error.to_string()))?
    };
    let mut envelope = ProjectEnvelope::blank(project_id, name)
        .map_err(|error| FileRepositoryError(error.to_string()))?;
    envelope
        .replace_scene(scene)
        .map_err(|error| FileRepositoryError(error.to_string()))?;
    envelope.source = source_document;
    let mut preserved_paths = Vec::new();
    let selected = [source_path, scene_path];
    for (path, bytes) in entries {
        if selected.contains(&path.as_str()) {
            if path == scene_path && !entries[path].is_empty() {
                // Keep the exact legacy scene even when the current projection
                // had to wrap it.
                let legacy_path = format!("project/legacy/{path}");
                envelope.opaque_documents.push(
                    OpaqueDocument::new(legacy_path.clone(), bytes.clone())
                        .map_err(|error| FileRepositoryError(error.to_string()))?,
                );
                preserved_paths.push(path.clone());
            }
            continue;
        }
        if path.starts_with("project/assets/") && path != "project/assets/index.json" {
            envelope.assets.push(
                OpaqueAsset::new(path, bytes.clone(), None)
                    .map_err(|error| FileRepositoryError(error.to_string()))?,
            );
            preserved_paths.push(path.clone());
            continue;
        }
        let legacy_path = format!("project/legacy/{path}");
        envelope.opaque_documents.push(
            OpaqueDocument::new(legacy_path, bytes.clone())
                .map_err(|error| FileRepositoryError(error.to_string()))?,
        );
        preserved_paths.push(path.clone());
    }
    warnings.push(format!(
        "preserved {} legacy archive entries",
        preserved_paths.len()
    ));
    let source_schema = session
        .get("schema")
        .and_then(Value::as_str)
        .unwrap_or("fullmag.session.v1")
        .to_string();
    let mut migration = MigrationReport::current();
    migration.source_schema = source_schema;
    migration.migrated = true;
    migration.warnings = warnings;
    migration.preserved_paths = preserved_paths;
    Ok(RepositoryOpenResult {
        envelope,
        source: source.clone(),
        source_hash: None,
        target: match source {
            ProjectSource::Path(path) => Some(ProjectTarget::Path(path)),
            ProjectSource::Bytes { .. } => None,
        },
        migration,
        read_only_reason: None,
    })
}

fn write_archive(
    envelope: &ProjectEnvelope,
    compression: CompressionMethod,
) -> Result<Vec<u8>, FileRepositoryError> {
    let manifest = ArchiveManifest {
        format: ARCHIVE_FORMAT.into(),
        project_schema: envelope.definition.schema_version.clone(),
        scene_schema: envelope
            .definition
            .scene
            .value()
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .into(),
        definition: DEFINITION_PATH.into(),
        scene: SCENE_PATH.into(),
        source: envelope.source.as_ref().map(|source| source.path().into()),
        assets: envelope
            .assets
            .iter()
            .map(|asset| ArchiveAsset {
                path: asset.path().into(),
                media_type: asset.media_type().map(str::to_owned),
            })
            .collect(),
        opaque_documents: envelope
            .opaque_documents
            .iter()
            .map(|document| document.path().into())
            .collect(),
    };
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default()
        .compression_method(compression)
        .large_file(true);
    write_zip_entry(
        &mut writer,
        MANIFEST_PATH,
        &serde_json::to_vec(&manifest).map_err(|error| {
            FileRepositoryError(format!("serializing project manifest: {error}"))
        })?,
        options,
    )?;
    write_zip_entry(
        &mut writer,
        DEFINITION_PATH,
        envelope.raw_definition.raw_bytes(),
        options,
    )?;
    write_zip_entry(
        &mut writer,
        SCENE_PATH,
        envelope.definition.scene.raw_bytes(),
        options,
    )?;
    if let Some(source) = &envelope.source {
        write_zip_entry(&mut writer, source.path(), source.bytes(), options)?;
    }
    let mut assets = envelope.assets.iter().collect::<Vec<_>>();
    assets.sort_by(|left, right| left.path().cmp(right.path()));
    for asset in assets {
        write_zip_entry(&mut writer, asset.path(), asset.bytes(), options)?;
    }
    let mut documents = envelope.opaque_documents.iter().collect::<Vec<_>>();
    documents.sort_by(|left, right| left.path().cmp(right.path()));
    for document in documents {
        write_zip_entry(&mut writer, document.path(), document.bytes(), options)?;
    }
    writer
        .finish()
        .map(|cursor| cursor.into_inner())
        .map_err(|error| FileRepositoryError(format!("finalizing project archive: {error}")))
}

fn write_zip_entry<W: Write + std::io::Seek>(
    writer: &mut ZipWriter<W>,
    path: &str,
    bytes: &[u8],
    options: SimpleFileOptions,
) -> Result<(), FileRepositoryError> {
    validate_archive_entry(path, false, None)?;
    writer.start_file(path, options).map_err(|error| {
        FileRepositoryError(format!("starting project entry `{path}`: {error}"))
    })?;
    writer
        .write_all(bytes)
        .map_err(|error| FileRepositoryError(format!("writing project entry `{path}`: {error}")))
}

fn required_entry<'a>(
    entries: &'a BTreeMap<String, Vec<u8>>,
    path: &str,
) -> Result<&'a Vec<u8>, FileRepositoryError> {
    if !valid_archive_pointer(path) {
        return Err(FileRepositoryError(format!(
            "manifest points outside the portable archive namespace: `{path}`"
        )));
    }
    entries
        .get(path)
        .ok_or_else(|| FileRepositoryError(format!("manifest entry is missing: `{path}`")))
}

fn document_from_entry(
    entries: &BTreeMap<String, Vec<u8>>,
    path: &str,
) -> Result<OpaqueDocument, FileRepositoryError> {
    let bytes = required_entry(entries, path)?;
    OpaqueDocument::new(path, bytes.clone()).map_err(|error| FileRepositoryError(error.to_string()))
}

fn parse_json<T: for<'de> Deserialize<'de>>(
    bytes: &[u8],
    path: &str,
) -> Result<T, FileRepositoryError> {
    serde_json::from_slice(bytes)
        .map_err(|error| FileRepositoryError(format!("invalid JSON in `{path}`: {error}")))
}

fn parse_json_value(bytes: &[u8], path: &str) -> Result<Value, FileRepositoryError> {
    parse_json(bytes, path)
}

fn valid_archive_pointer(path: &str) -> bool {
    path.starts_with("project/") || path.starts_with("manifest/")
}

fn valid_project_path(path: &str) -> bool {
    path.starts_with("project/")
        && !path.ends_with('/')
        && !path.contains('\\')
        && !path.contains(':')
        && path.split('/').all(|component| {
            !component.is_empty()
                && component != "."
                && component != ".."
                && !component.ends_with([' ', '.'])
        })
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn validate_target(path: &Path) -> Result<PathBuf, FileRepositoryError> {
    if path.as_os_str().is_empty() || path.file_name().is_none() {
        return Err(FileRepositoryError(
            "project target must name a file".into(),
        ));
    }
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf();
    reject_link_chain(&parent)?;
    let metadata = fs::metadata(&parent).map_err(|error| {
        FileRepositoryError(format!(
            "reading project target parent {}: {error}",
            parent.display()
        ))
    })?;
    if !metadata.is_dir() {
        return Err(FileRepositoryError(format!(
            "project target parent is not a directory: {}",
            parent.display()
        )));
    }
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata_is_link(&metadata) {
            return Err(FileRepositoryError(format!(
                "project target may not be a symlink: {}",
                path.display()
            )));
        }
    }
    Ok(parent)
}

fn reject_link_chain(path: &Path) -> Result<(), FileRepositoryError> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| FileRepositoryError(format!("reading current directory: {error}")))?
            .join(path)
    };
    let mut current = PathBuf::new();
    for component in absolute.components() {
        current.push(component.as_os_str());
        if let Ok(metadata) = fs::symlink_metadata(&current) {
            if metadata_is_link(&metadata) {
                return Err(FileRepositoryError(format!(
                    "project path crosses a symlink: {}",
                    current.display()
                )));
            }
        }
    }
    Ok(())
}

fn metadata_is_link(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn sync_parent(parent: &Path) -> Result<bool, FileRepositoryError> {
    #[cfg(unix)]
    {
        let directory = File::open(parent).map_err(|error| {
            FileRepositoryError(format!("opening project parent for sync: {error}"))
        })?;
        directory
            .sync_all()
            .map_err(|error| FileRepositoryError(format!("syncing project parent: {error}")))?;
        Ok(true)
    }
    #[cfg(windows)]
    {
        let _ = parent;
        Ok(false)
    }
}

struct WriterLock {
    path: PathBuf,
}

impl WriterLock {
    fn acquire(parent: &Path, target: &Path) -> Result<Self, FileRepositoryError> {
        let file_name = target
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("project");
        let path = parent.join(format!(".{file_name}.fullmag-writer.lock"));
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|error| {
                FileRepositoryError(format!(
                    "project writer lock is busy or unavailable ({}): {error}",
                    path.display()
                ))
            })?;
        Ok(Self { path })
    }
}

impl Drop for WriterLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}
