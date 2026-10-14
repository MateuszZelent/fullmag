//! Copy-on-write preparation for an explicitly owned legacy family manifest.
//! Publication and bundle hash rebinding belong to the importing repository.

use super::common::FrequencyDomainArtifactIdentity;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::{Error, ErrorKind, Result};

use crate::artifact_json::UnambiguousJson;

const MAX_MANIFEST_BYTES: usize = 1024 * 1024;
const RESOURCE_KEYS: &[&str] = &[
    "spectrum_resource_key",
    "branches_resource_key",
    "dispersion_resource_key",
    "diagnostics_resource_key",
    "eigen_diagnostics_resource_key",
    "response_sweep_resource_key",
    "response_map_resource_key",
    "response_progress_resource_key",
    "response_cancel_requested_resource_key",
    "response_diagnostics_resource_key",
];
const RESOURCE_LISTS: &[&str] = &["mode_field_resources", "response_field_resources"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LegacyFrequencyDomainManifestMigration {
    pub schema_version: String,
    /// Only the family envelope is migrated; child artifacts retain their bytes.
    pub status: String,
    pub scope: String,
    pub original_content_sha256: String,
    pub migrated_content_sha256: String,
    pub identity: FrequencyDomainArtifactIdentity,
    pub removed_transport_fields: Vec<String>,
}

impl LegacyFrequencyDomainManifestMigration {
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != "frequency_domain_manifest_migration.v1"
            || self.status != "partial"
            || self.scope != "family_manifest_only"
        {
            return Err(invalid("unsupported manifest migration report contract"));
        }
        self.identity.validate()?;
        for digest in [&self.original_content_sha256, &self.migrated_content_sha256] {
            if digest.len() != 64
                || !digest
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            {
                return Err(invalid(
                    "migration report digest must be canonical lowercase SHA256",
                ));
            }
        }
        if !self
            .removed_transport_fields
            .windows(2)
            .all(|pair| pair[0] < pair[1])
            || self.removed_transport_fields.iter().any(|name| {
                !RESOURCE_KEYS.contains(&name.as_str()) && !RESOURCE_LISTS.contains(&name.as_str())
            })
        {
            return Err(invalid(
                "migration report transport fields are invalid or duplicated",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct MigratedFrequencyDomainManifest {
    pub bytes: Vec<u8>,
    pub migration: LegacyFrequencyDomainManifestMigration,
}

fn invalid(message: impl Into<String>) -> Error {
    Error::new(ErrorKind::InvalidData, message.into())
}

/// Prepare a new manifest without writing or mutating the original.
///
/// The caller must resolve `identity` from immutable execution records. This
/// adapter cannot recover missing ownership from a path or a current session.
/// The expected digest binds the input to the selected archival object.
pub fn migrate_legacy_frequency_domain_manifest(
    original: &[u8],
    expected_original_sha256: &str,
    identity: &FrequencyDomainArtifactIdentity,
) -> Result<MigratedFrequencyDomainManifest> {
    identity.validate()?;
    if [
        &identity.session_id,
        &identity.run_id,
        &identity.stage_id,
        &identity.runtime_id,
    ]
    .iter()
    .any(|value| value.len() > MAX_MANIFEST_BYTES / 4)
    {
        return Err(invalid("migration owner exceeds manifest size budget"));
    }
    if original.len() > MAX_MANIFEST_BYTES {
        return Err(invalid(
            "frequency-domain manifest exceeds migration size limit",
        ));
    }
    let original_digest = format!("{:x}", Sha256::digest(original));
    if original_digest != expected_original_sha256 {
        return Err(invalid("legacy frequency-domain manifest digest mismatch"));
    }
    let UnambiguousJson(mut document) = serde_json::from_slice(original).map_err(invalid_json)?;
    let root = document
        .as_object_mut()
        .ok_or_else(|| invalid("manifest must be an object"))?;
    if root.get("schema_version").and_then(Value::as_str) != Some("frequency_domain_manifest.v1") {
        return Err(invalid(
            "unsupported frequency-domain manifest migration schema",
        ));
    }
    if root.get("analysis_family").and_then(Value::as_str) != Some("magnetic_frequency_domain") {
        return Err(invalid("unsupported frequency-domain analysis family"));
    }
    let expected_stage = match root.get("study_product").and_then(Value::as_str) {
        Some("modal_eigen") => "eigenmodes",
        Some("driven_response") => "frequency_response",
        _ => return Err(invalid("unsupported frequency-domain study product")),
    };
    if root.get("stage_kind").and_then(Value::as_str) != Some(expected_stage)
        || !root
            .get("revision")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
    {
        return Err(invalid(
            "frequency-domain manifest stage or revision is malformed",
        ));
    }
    for name in ["physics", "requested_execution", "resolved_execution"] {
        if !root.get(name).is_some_and(Value::is_object) {
            return Err(invalid(format!("legacy manifest {name} must be an object")));
        }
    }
    // A self-hashed envelope needs its own codec and dependency rebinding.
    if root.contains_key("content_sha256") || root.contains_key("artifact_sha256") {
        return Err(invalid(
            "self-hashed manifest requires a dedicated migration codec",
        ));
    }
    for (name, target) in [
        ("session_id", identity.session_id.as_str()),
        ("run_id", identity.run_id.as_str()),
        ("stage_id", identity.stage_id.as_str()),
        ("runtime_id", identity.runtime_id.as_str()),
    ] {
        match root.get(name) {
            Some(Value::String(value)) => {
                let token = value.trim().to_ascii_lowercase();
                let alias = token == "current"
                    || token == "run:current"
                    || token.ends_with(":current")
                    || token == "runtime:not_provided";
                if value != target && !alias {
                    return Err(invalid(format!(
                        "legacy manifest {name} conflicts with resolved owner"
                    )));
                }
            }
            None => {}
            _ => {
                return Err(invalid(format!(
                    "legacy manifest {name} is missing or malformed"
                )));
            }
        }
        root.insert(name.into(), Value::String(target.into()));
    }
    if !root.get("artifacts").is_some_and(Value::is_object) {
        return Err(invalid(
            "legacy manifest artifact index is missing or malformed",
        ));
    }
    if !root["artifacts"]
        .get("solver_diagnostics_path")
        .and_then(Value::as_str)
        .is_some_and(|path| !path.trim().is_empty())
    {
        return Err(invalid(
            "legacy manifest requires a diagnostic artifact reference",
        ));
    }
    let resources = root
        .get_mut("resources")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| invalid("legacy manifest resource index is missing or malformed"))?;
    let mut removed_transport_fields = Vec::new();
    for (name, value) in resources.iter_mut() {
        if RESOURCE_KEYS.contains(&name.as_str()) {
            if !value.is_null() && !value.is_string() {
                return Err(invalid(format!(
                    "legacy resource {name} must be a string or null"
                )));
            }
            if !value.is_null() {
                removed_transport_fields.push(name.clone());
                *value = Value::Null;
            }
        } else if RESOURCE_LISTS.contains(&name.as_str()) {
            let entries = value
                .as_array_mut()
                .ok_or_else(|| invalid(format!("legacy resource {name} must be an array")))?;
            if entries.iter().any(|entry| !entry.is_string()) {
                return Err(invalid(format!(
                    "legacy resource {name} contains a non-string entry"
                )));
            }
            if !entries.is_empty() {
                removed_transport_fields.push(name.clone());
                entries.clear();
            }
        } else {
            return Err(invalid(format!("unsupported legacy resource field {name}")));
        }
    }
    removed_transport_fields.sort();
    // Preserve untouched subtree bytes, including high-precision numeric
    // lexemes. Re-serializing a Value could round archived scientific numbers.
    let mut raw_document: BTreeMap<String, Box<serde_json::value::RawValue>> =
        serde_json::from_slice(original).map_err(invalid_json)?;
    for name in [
        "session_id",
        "run_id",
        "stage_id",
        "runtime_id",
        "resources",
    ] {
        raw_document.insert(
            name.into(),
            serde_json::value::RawValue::from_string(
                serde_json::to_string(&document[name]).map_err(invalid_json)?,
            )
            .map_err(invalid_json)?,
        );
    }
    let bytes = serde_json::to_vec_pretty(&raw_document).map_err(invalid_json)?;
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err(invalid(
            "migrated frequency-domain manifest exceeds size limit",
        ));
    }
    let migrated_digest = format!("{:x}", Sha256::digest(&bytes));
    let migration = LegacyFrequencyDomainManifestMigration {
        schema_version: "frequency_domain_manifest_migration.v1".into(),
        status: "partial".into(),
        scope: "family_manifest_only".into(),
        original_content_sha256: original_digest,
        migrated_content_sha256: migrated_digest,
        identity: identity.clone(),
        removed_transport_fields,
    };
    migration.validate()?;
    Ok(MigratedFrequencyDomainManifest { bytes, migration })
}

fn invalid_json(error: serde_json::Error) -> Error {
    invalid(format!("invalid frequency-domain migration JSON: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "schema_version": "frequency_domain_manifest.v1",
            "analysis_family": "magnetic_frequency_domain", "study_product": "modal_eigen",
            "stage_kind": "eigenmodes", "requested_execution": {}, "resolved_execution": {},
            "session_id": "current", "run_id": "run:current", "stage_id": "stage:current",
            "artifacts": {"spectrum_v2_path": "eigen/spectrum.v2.json", "solver_diagnostics_path": "eigen/diagnostics/solver.v1.json"},
            "resources": {"spectrum_resource_key": "/v2/sessions/current/analysis/spectrum",
                "mode_field_resources": ["/v2/sessions/current/data/fields/m"]},
            "physics": {"operator_sha256": "unchanged"}, "revision": "original-source-revision"
        }))
        .unwrap()
    }

    #[test]
    fn migration_preserves_original_and_scientific_payload() {
        let original = fixture();
        let before = original.clone();
        let digest = format!("{:x}", Sha256::digest(&original));
        let identity =
            FrequencyDomainArtifactIdentity::try_new("session:1", "run:1", "stage:1", "runtime:1")
                .unwrap();
        let migrated =
            migrate_legacy_frequency_domain_manifest(&original, &digest, &identity).unwrap();
        assert_eq!(original, before);
        let old: Value = serde_json::from_slice(&original).unwrap();
        let new: Value = serde_json::from_slice(&migrated.bytes).unwrap();
        for name in ["physics", "revision", "artifacts"] {
            assert_eq!(old[name], new[name]);
        }
        assert_eq!(new["runtime_id"], identity.runtime_id);
        assert!(new["resources"]["spectrum_resource_key"].is_null());
        assert_eq!(
            new["resources"]["mode_field_resources"],
            serde_json::json!([])
        );
        assert_eq!(migrated.migration.original_content_sha256, digest);
        assert_ne!(migrated.migration.migrated_content_sha256, digest);
        assert_eq!(migrated.migration.removed_transport_fields.len(), 2);
        assert_eq!(migrated.migration.status, "partial");
        assert_eq!(migrated.migration.scope, "family_manifest_only");
        assert!(
            migrate_legacy_frequency_domain_manifest(&original, &"0".repeat(64), &identity)
                .is_err()
        );
    }

    #[test]
    fn migration_rejects_conflicting_owner_and_unknown_resource_codec() {
        let identity =
            FrequencyDomainArtifactIdentity::try_new("session:1", "run:1", "stage:1", "runtime:1")
                .unwrap();
        for (name, value) in [
            ("run_id", serde_json::json!("run:other")),
            (
                "resources",
                serde_json::json!({"unknown_route": "/v2/sessions/current/unknown"}),
            ),
            ("content_sha256", serde_json::json!("old-self-digest")),
        ] {
            let mut document: Value = serde_json::from_slice(&fixture()).unwrap();
            document[name] = value;
            let bytes = serde_json::to_vec(&document).unwrap();
            let digest = format!("{:x}", Sha256::digest(&bytes));
            assert!(migrate_legacy_frequency_domain_manifest(&bytes, &digest, &identity).is_err());
        }
    }

    #[test]
    fn migration_rejects_duplicate_scientific_keys_and_can_fill_missing_owner() {
        let identity =
            FrequencyDomainArtifactIdentity::try_new("session:1", "run:1", "stage:1", "runtime:1")
                .unwrap();
        let ambiguous = br#"{"schema_version":"frequency_domain_manifest.v1","physics":{"gamma":1,"gamma":2},"artifacts":{},"resources":{}}"#;
        let digest = format!("{:x}", Sha256::digest(ambiguous));
        assert!(migrate_legacy_frequency_domain_manifest(ambiguous, &digest, &identity).is_err());
        let mut document: Value = serde_json::from_slice(&fixture()).unwrap();
        for name in ["session_id", "run_id", "stage_id", "runtime_id"] {
            document.as_object_mut().unwrap().remove(name);
        }
        let missing_owner = serde_json::to_string(&document).unwrap().replace(
            "\"operator_sha256\":\"unchanged\"",
            "\"gamma\":1.2345678901234567890123456789",
        );
        let digest = format!("{:x}", Sha256::digest(missing_owner.as_bytes()));
        let migrated =
            migrate_legacy_frequency_domain_manifest(missing_owner.as_bytes(), &digest, &identity)
                .unwrap();
        let new: Value = serde_json::from_slice(&migrated.bytes).unwrap();
        assert_eq!(new["run_id"], identity.run_id);
        assert!(
            std::str::from_utf8(&migrated.bytes)
                .unwrap()
                .contains("1.2345678901234567890123456789")
        );
        migrated.migration.validate().unwrap();
        let mut report = migrated.migration;
        report.status = "complete".into();
        assert!(report.validate().is_err());
        report.status = "partial".into();
        report.original_content_sha256 = "A".repeat(64);
        assert!(report.validate().is_err());
    }

    #[test]
    fn migration_rejects_wrong_product_stage_and_missing_execution_envelope() {
        let identity =
            FrequencyDomainArtifactIdentity::try_new("session:1", "run:1", "stage:1", "runtime:1")
                .unwrap();
        for (name, value) in [
            ("analysis_family", serde_json::json!("other")),
            ("study_product", serde_json::json!("other")),
            ("stage_kind", serde_json::json!("frequency_response")),
            ("requested_execution", Value::Null),
        ] {
            let mut document: Value = serde_json::from_slice(&fixture()).unwrap();
            document[name] = value;
            let bytes = serde_json::to_vec(&document).unwrap();
            let digest = format!("{:x}", Sha256::digest(&bytes));
            assert!(migrate_legacy_frequency_domain_manifest(&bytes, &digest, &identity).is_err());
        }
    }
}
