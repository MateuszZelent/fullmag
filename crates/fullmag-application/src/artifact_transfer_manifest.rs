//! Immutable Fullmag-owned artifact manifests for bounded transfer staging.
//!
//! This contract describes bytes and scientific codec identity. Broker
//! allocation, authorization grants and network routes belong to MicroLab's
//! separately versioned transfer intent and are deliberately absent here.

use crate::{AttemptId, ProjectId, RunId, TaskId};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const ARTIFACT_TRANSFER_MANIFEST_V1: &str = "fullmag.artifact_transfer_manifest.v1";
const MAX_MANIFEST_ARTIFACTS: usize = 16_384;
const MAX_MANIFEST_WIRE_BYTES: usize = 16 * 1024 * 1024;
const MAX_CANONICAL_MANIFEST_BYTES: usize = MAX_MANIFEST_WIRE_BYTES - 1024 * 1024;
const MAX_IDENTIFIER_BYTES: usize = 256;
const MAX_LOGICAL_NAME_BYTES: usize = 1024;
const MAX_MEDIA_TYPE_BYTES: usize = 256;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactTransferDirectionV1 {
    Input,
    Output,
}

/// Provenance of one object in the project/run data model. Broker
/// allocation identity is intentionally not part of the Fullmag artifact manifest.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactTransferProvenanceV1 {
    pub project_id: String,
    pub definition_revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt_id: Option<String>,
}

/// One immutable CAS object and the Fullmag codec required to interpret it.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactTransferEntryV1 {
    pub artifact_id: String,
    /// A logical relative name, never a trusted host filesystem path.
    pub logical_name: String,
    pub role: String,
    /// Lowercase SHA-256 hex digest of the complete object bytes.
    pub sha256: String,
    pub byte_length: u64,
    pub media_type: String,
    pub codec_id: String,
    pub codec_version: String,
    pub provenance: ArtifactTransferProvenanceV1,
    /// Input artifacts are immutable/read-only to the receiving worker.
    pub read_only: bool,
}

/// Fullmag-owned artifact manifest for one exact project revision and task
/// attempt. Broker allocation and caller authority are carried separately by
/// MicroLab's TransferIntent.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactTransferManifestV1 {
    schema_version: String,
    project_id: String,
    definition_revision: u64,
    run_id: String,
    task_id: String,
    attempt_id: String,
    direction: ArtifactTransferDirectionV1,
    /// Canonically ordered by artifact_id before digesting.
    artifacts: Vec<ArtifactTransferEntryV1>,
    /// SHA-256 over the canonical manifest payload excluding this field.
    manifest_sha256: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ArtifactTransferManifestWireV1 {
    schema_version: String,
    project_id: String,
    definition_revision: u64,
    run_id: String,
    task_id: String,
    attempt_id: String,
    direction: ArtifactTransferDirectionV1,
    artifacts: Vec<ArtifactTransferEntryV1>,
    manifest_sha256: String,
}

#[derive(Serialize)]
struct ArtifactTransferManifestDigest<'a> {
    schema_version: &'a str,
    project_id: &'a str,
    definition_revision: u64,
    run_id: &'a str,
    task_id: &'a str,
    attempt_id: &'a str,
    direction: ArtifactTransferDirectionV1,
    artifacts: &'a [ArtifactTransferEntryV1],
}

impl ArtifactTransferManifestV1 {
    /// Decode only a bounded JSON payload, validate its complete content, then
    /// return an immutable manifest. Callers must not parse untrusted manifests
    /// through an unbounded generic serde entry point.
    pub fn from_json_slice(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() > MAX_MANIFEST_WIRE_BYTES {
            return Err("artifact manifest exceeds the wire byte limit".into());
        }
        let wire: ArtifactTransferManifestWireV1 = serde_json::from_slice(bytes)
            .map_err(|error| format!("deserialize artifact transfer manifest: {error}"))?;
        let manifest = Self {
            schema_version: wire.schema_version,
            project_id: wire.project_id,
            definition_revision: wire.definition_revision,
            run_id: wire.run_id,
            task_id: wire.task_id,
            attempt_id: wire.attempt_id,
            direction: wire.direction,
            artifacts: wire.artifacts,
            manifest_sha256: wire.manifest_sha256,
        };
        manifest.validate()?;
        let serialized = serde_json::to_vec(&manifest)
            .map_err(|error| format!("serialize artifact transfer manifest: {error}"))?;
        if serialized.len() > MAX_MANIFEST_WIRE_BYTES {
            return Err("serialized artifact manifest exceeds the wire byte limit".into());
        }
        Ok(manifest)
    }

    pub fn new(
        project_id: impl Into<String>,
        definition_revision: u64,
        run_id: impl Into<String>,
        task_id: impl Into<String>,
        attempt_id: impl Into<String>,
        direction: ArtifactTransferDirectionV1,
        mut artifacts: Vec<ArtifactTransferEntryV1>,
    ) -> Result<Self, String> {
        artifacts.sort_by(|left, right| left.artifact_id.cmp(&right.artifact_id));
        let mut manifest = Self {
            schema_version: ARTIFACT_TRANSFER_MANIFEST_V1.into(),
            project_id: project_id.into(),
            definition_revision,
            run_id: run_id.into(),
            task_id: task_id.into(),
            attempt_id: attempt_id.into(),
            direction,
            artifacts,
            manifest_sha256: String::new(),
        };
        manifest.validate_payload()?;
        manifest.manifest_sha256 = manifest.calculated_sha256()?;
        let serialized = serde_json::to_vec(&manifest)
            .map_err(|error| format!("serialize artifact transfer manifest: {error}"))?;
        if serialized.len() > MAX_MANIFEST_WIRE_BYTES {
            return Err("serialized artifact manifest exceeds the wire byte limit".into());
        }
        Ok(manifest)
    }

    pub fn schema_version(&self) -> &str {
        &self.schema_version
    }

    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    pub fn definition_revision(&self) -> u64 {
        self.definition_revision
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn task_id(&self) -> &str {
        &self.task_id
    }

    pub fn attempt_id(&self) -> &str {
        &self.attempt_id
    }

    pub fn direction(&self) -> ArtifactTransferDirectionV1 {
        self.direction
    }

    pub fn artifacts(&self) -> &[ArtifactTransferEntryV1] {
        &self.artifacts
    }

    pub fn manifest_sha256(&self) -> &str {
        &self.manifest_sha256
    }

    pub fn total_byte_length(&self) -> Result<u64, String> {
        self.artifacts.iter().try_fold(0_u64, |total, artifact| {
            total
                .checked_add(artifact.byte_length)
                .ok_or_else(|| "artifact manifest total byte length overflowed".to_string())
        })
    }

    pub fn validate(&self) -> Result<(), String> {
        self.validate_payload()?;
        let actual = self.calculated_sha256()?;
        if self.manifest_sha256 != actual {
            return Err("artifact manifest digest does not match its content".into());
        }
        Ok(())
    }

    fn validate_payload(&self) -> Result<(), String> {
        if self.schema_version != ARTIFACT_TRANSFER_MANIFEST_V1 {
            return Err(format!(
                "unsupported artifact transfer manifest schema {}",
                self.schema_version
            ));
        }
        ProjectId::parse(self.project_id.clone()).map_err(|error| error.to_string())?;
        if self.definition_revision == 0 {
            return Err("artifact manifest definition_revision must be positive".into());
        }
        RunId::parse(self.run_id.clone()).map_err(|error| error.to_string())?;
        TaskId::parse(self.task_id.clone()).map_err(|error| error.to_string())?;
        AttemptId::parse(self.attempt_id.clone()).map_err(|error| error.to_string())?;
        if self.artifacts.is_empty() || self.artifacts.len() > MAX_MANIFEST_ARTIFACTS {
            return Err(format!(
                "artifact manifest must contain between 1 and {MAX_MANIFEST_ARTIFACTS} artifacts"
            ));
        }

        let mut previous_id: Option<&str> = None;
        let mut logical_names = std::collections::BTreeSet::new();
        for artifact in &self.artifacts {
            validate_manifest_identifier(&artifact.artifact_id, "artifact_id")?;
            if previous_id.is_some_and(|previous| previous >= artifact.artifact_id.as_str()) {
                return Err(
                    "artifact manifest entries must be unique and ordered by artifact_id".into(),
                );
            }
            previous_id = Some(&artifact.artifact_id);
            validate_manifest_identifier(&artifact.role, "artifact role")?;
            validate_logical_name(&artifact.logical_name)?;
            let logical_name_key = artifact.logical_name.to_ascii_lowercase();
            if !logical_names.insert(logical_name_key) {
                return Err(
                    "artifact manifest logical_name values must be unique case-insensitively"
                        .into(),
                );
            }
            validate_sha256(&artifact.sha256)?;
            validate_media_type(&artifact.media_type)?;
            validate_manifest_identifier(&artifact.codec_id, "codec_id")?;
            validate_manifest_identifier(&artifact.codec_version, "codec_version")?;
            artifact.provenance.validate()?;
            match self.direction {
                ArtifactTransferDirectionV1::Input if !artifact.read_only => {
                    return Err("input artifact transfer entries must be read-only".into());
                }
                ArtifactTransferDirectionV1::Output
                    if artifact.provenance.project_id != self.project_id
                        || artifact.provenance.definition_revision != self.definition_revision
                        || artifact.provenance.run_id.as_deref() != Some(self.run_id.as_str())
                        || artifact.provenance.task_id.as_deref()
                            != Some(self.task_id.as_str())
                        || artifact.provenance.attempt_id.as_deref()
                            != Some(self.attempt_id.as_str()) =>
                {
                    return Err(
                        "output artifact provenance must match the manifest project revision and run/task/attempt"
                            .into(),
                    );
                }
                _ => {}
            }
        }
        self.total_byte_length()?;
        Ok(())
    }

    fn calculated_sha256(&self) -> Result<String, String> {
        let payload = ArtifactTransferManifestDigest {
            schema_version: &self.schema_version,
            project_id: &self.project_id,
            definition_revision: self.definition_revision,
            run_id: &self.run_id,
            task_id: &self.task_id,
            attempt_id: &self.attempt_id,
            direction: self.direction,
            artifacts: &self.artifacts,
        };
        let value = serde_json::to_value(payload)
            .map_err(|error| format!("serialize artifact manifest digest payload: {error}"))?;
        let bytes = crate::run_spec::canonical_json_bytes(&value);
        if bytes.len() > MAX_CANONICAL_MANIFEST_BYTES {
            return Err("artifact manifest exceeds the canonical byte limit".into());
        }
        Ok(format!("{:x}", Sha256::digest(bytes)))
    }
}

impl ArtifactTransferProvenanceV1 {
    fn validate(&self) -> Result<(), String> {
        ProjectId::parse(self.project_id.clone()).map_err(|error| error.to_string())?;
        if self.definition_revision == 0 {
            return Err("artifact provenance definition_revision must be positive".into());
        }
        match (&self.run_id, &self.task_id, &self.attempt_id) {
            (None, None, None) => Ok(()),
            (Some(run_id), Some(task_id), Some(attempt_id)) => {
                RunId::parse(run_id.clone()).map_err(|error| error.to_string())?;
                TaskId::parse(task_id.clone()).map_err(|error| error.to_string())?;
                AttemptId::parse(attempt_id.clone()).map_err(|error| error.to_string())?;
                Ok(())
            }
            _ => Err(
                "artifact provenance run_id, task_id and attempt_id must be supplied together"
                    .into(),
            ),
        }
    }
}

fn validate_manifest_identifier(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > MAX_IDENTIFIER_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
        || !value.as_bytes()[0].is_ascii_alphanumeric()
        || matches!(value, "." | "..")
    {
        return Err(format!("{label} is not a valid bounded identifier"));
    }
    Ok(())
}

fn validate_logical_name(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > MAX_LOGICAL_NAME_BYTES
        || !value.is_ascii()
        || value.starts_with('/')
        || value.contains('\\')
        || value
            .bytes()
            .any(|byte| !(byte.is_ascii_alphanumeric() || b"./_+-".contains(&byte)))
    {
        return Err("artifact logical_name must be a bounded portable logical path".into());
    }
    for segment in value.split('/') {
        let stem = segment
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        let windows_device_name = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (stem.len() == 4
                && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && matches!(stem.as_bytes()[3], b'1'..=b'9'));
        if segment.is_empty()
            || segment.len() > 255
            || segment == "."
            || segment == ".."
            || segment.ends_with('.')
            || windows_device_name
        {
            return Err("artifact logical_name contains a non-portable path segment".into());
        }
    }
    Ok(())
}

fn validate_sha256(value: &str) -> Result<(), String> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("artifact sha256 must be 64 lowercase hexadecimal characters".into());
    }
    Ok(())
}

fn validate_media_type(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > MAX_MEDIA_TYPE_BYTES {
        return Err("artifact media_type must be a bounded type/subtype value".into());
    }
    let mut parts = value.split('/');
    let (Some(kind), Some(subtype), None) = (parts.next(), parts.next(), parts.next()) else {
        return Err("artifact media_type must contain exactly one slash".into());
    };
    let valid_token = |part: &str| {
        !part.is_empty()
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(&byte))
    };
    if !valid_token(kind) || !valid_token(subtype) {
        return Err("artifact media_type contains invalid token characters".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn artifact(artifact_id: &str) -> ArtifactTransferEntryV1 {
        ArtifactTransferEntryV1 {
            artifact_id: artifact_id.into(),
            logical_name: format!("{artifact_id}.json"),
            role: "study_state".into(),
            sha256: "ab".repeat(32),
            byte_length: 128,
            media_type: "application/json".into(),
            codec_id: "fullmag.runner.field_json".into(),
            codec_version: "v1".into(),
            provenance: ArtifactTransferProvenanceV1 {
                project_id: "project-1".into(),
                definition_revision: 3,
                run_id: None,
                task_id: None,
                attempt_id: None,
            },
            read_only: true,
        }
    }

    fn manifest(
        direction: ArtifactTransferDirectionV1,
        artifacts: Vec<ArtifactTransferEntryV1>,
    ) -> Result<ArtifactTransferManifestV1, String> {
        ArtifactTransferManifestV1::new(
            "project-1",
            3,
            "run-1",
            "task-1",
            "attempt-1",
            direction,
            artifacts,
        )
    }

    #[test]
    fn manifest_digest_is_independent_of_input_artifact_order() {
        let first = artifact("artifact-a");
        let second = artifact("artifact-b");
        let left = manifest(
            ArtifactTransferDirectionV1::Input,
            vec![first.clone(), second.clone()],
        )
        .unwrap();
        let right = manifest(ArtifactTransferDirectionV1::Input, vec![second, first]).unwrap();

        assert_eq!(left.manifest_sha256(), right.manifest_sha256());
        assert!(left.validate().is_ok());
    }

    #[test]
    fn manifest_round_trips_through_bounded_json_decoder() {
        let original = manifest(
            ArtifactTransferDirectionV1::Input,
            vec![artifact("artifact-a")],
        )
        .unwrap();
        let encoded = serde_json::to_vec(&original).unwrap();
        let decoded = ArtifactTransferManifestV1::from_json_slice(&encoded).unwrap();

        assert_eq!(decoded, original);
        assert!(encoded.len() <= MAX_MANIFEST_WIRE_BYTES);
    }

    #[test]
    fn deserialization_rejects_content_metadata_changed_after_sealing() {
        let manifest = manifest(
            ArtifactTransferDirectionV1::Input,
            vec![artifact("artifact-a")],
        )
        .unwrap();
        let mut value = serde_json::to_value(manifest).unwrap();
        value["artifacts"][0]["byte_length"] = serde_json::json!(129);
        let tampered = serde_json::to_vec(&value).unwrap();

        assert!(ArtifactTransferManifestV1::from_json_slice(&tampered).is_err());
    }

    #[test]
    fn input_manifest_requires_read_only_artifacts() {
        let mut input = artifact("artifact-a");
        input.read_only = false;

        assert!(manifest(ArtifactTransferDirectionV1::Input, vec![input]).is_err());
    }

    #[test]
    fn duplicate_logical_names_are_rejected_case_insensitively() {
        let first = artifact("artifact-a");
        let mut second = artifact("artifact-b");
        second.logical_name = first.logical_name.to_ascii_uppercase();

        assert!(manifest(ArtifactTransferDirectionV1::Input, vec![first, second]).is_err());
    }

    #[test]
    fn output_manifest_binds_provenance_to_the_exact_project_revision_and_attempt() {
        let mut output = artifact("artifact-a");
        output.read_only = false;
        output.provenance.run_id = Some("run-other".into());
        output.provenance.task_id = Some("task-1".into());
        output.provenance.attempt_id = Some("attempt-1".into());

        assert!(manifest(ArtifactTransferDirectionV1::Output, vec![output.clone()]).is_err());

        output.provenance.run_id = Some("run-1".into());
        output.provenance.project_id = "project-other".into();
        assert!(manifest(ArtifactTransferDirectionV1::Output, vec![output.clone()]).is_err());

        output.provenance.project_id = "project-1".into();
        output.provenance.definition_revision = 4;
        assert!(manifest(ArtifactTransferDirectionV1::Output, vec![output]).is_err());
    }

    #[test]
    fn portable_names_reject_windows_streams_and_device_names() {
        for name in ["result.bin:metadata", "CON", "result."] {
            let mut item = artifact("artifact-a");
            item.logical_name = name.into();
            assert!(manifest(ArtifactTransferDirectionV1::Input, vec![item]).is_err());
        }
    }

    #[test]
    fn bounded_json_decoder_rejects_oversize_before_parsing() {
        let valid = manifest(
            ArtifactTransferDirectionV1::Input,
            vec![artifact("artifact-a")],
        )
        .unwrap();
        let mut bytes = serde_json::to_vec(&valid).unwrap();
        bytes.resize(MAX_MANIFEST_WIRE_BYTES + 1, b' ');

        assert!(ArtifactTransferManifestV1::from_json_slice(&bytes).is_err());
    }
}
