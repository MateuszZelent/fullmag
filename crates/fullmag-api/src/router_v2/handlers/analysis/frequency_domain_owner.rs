//! Legacy publication evidence. Committed generations never consult these files.
use crate::artifacts::try_resolve_artifact_path;
use crate::error::ApiError;
use fullmag_runner::artifact_generation::PublicationOwner;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LegacyOwnerSnapshot {
    pub(crate) owner: Option<PublicationOwner>,
    manifest_digest: Option<String>,
    metadata_digest: Option<String>,
}

pub(crate) fn read_legacy_owner(
    root: &Path,
    artifact_path: &str,
) -> Result<Option<LegacyOwnerSnapshot>, ApiError> {
    let family = if artifact_path.starts_with("eigen/") {
        Some("modal_eigen")
    } else if artifact_path.starts_with("response/") {
        Some("driven_response")
    } else if artifact_path == "frequency_domain/manifest.v1.json" {
        None
    } else {
        return Ok(None);
    };
    let manifest = read_record(root, "frequency_domain/manifest.v1.json")?;
    if let Some((value, _)) = &manifest {
        if value.get("schema_version").and_then(Value::as_str)
            != Some("frequency_domain_manifest.v1")
        {
            return Err(invalid("unsupported frequency-domain owner manifest"));
        }
    }
    let product = manifest.as_ref().and_then(|(v, _)| v.get("study_product")?.as_str());
    let mut snapshot = LegacyOwnerSnapshot {
        owner: None,
        manifest_digest: manifest.as_ref().map(|(_, digest)| digest.clone()),
        metadata_digest: None,
    };
    // A later driven-response family manifest cannot own an earlier modal field.
    if family.zip(product).is_some_and(|(expected, actual)| expected != actual) {
        return Ok(Some(snapshot));
    }
    let family = family.or(product);
    let metadata = read_record(root, "metadata.json")?;
    snapshot.metadata_digest = metadata.as_ref().map(|(_, digest)| digest.clone());
    let runtime = metadata.as_ref().and_then(|(v, _)| v.get("problem_meta")?.get("runtime_metadata"));
    let metadata_pair = owner_pair(runtime, "producer_run_id", "producer_stage_id", false, family)?;
    let manifest_pair = owner_pair(manifest.as_ref().map(|(v, _)| v), "run_id", "stage_id", true, family)?;
    let stage_kind = runtime.and_then(|v| v.get("producer_stage_kind")).and_then(Value::as_str);
    let matching_kind = match family {
        Some("modal_eigen") => matches!(stage_kind, Some("flat_eigenmodes" | "eigenmodes")),
        Some("driven_response") => matches!(stage_kind, Some("flat_frequency_response" | "frequency_response")),
        _ => false,
    };
    if metadata_pair.is_some() && !matching_kind {
        return Err(invalid("frequency-domain owner conflicts with producer stage kind"));
    }
    if manifest_pair.is_some() && metadata_pair.is_some() && manifest_pair != metadata_pair {
        return Err(invalid("frequency-domain manifest conflicts with producer metadata owner"));
    }
    if let Some((run_id, stage_id)) = manifest_pair.or(metadata_pair) {
        let stage_kind = stage_kind.filter(|_| matching_kind).unwrap_or(match family {
            Some("modal_eigen") => "eigenmodes",
            Some("driven_response") => "frequency_response",
            _ => return Err(invalid("frequency-domain owner lacks a known study product")),
        });
        snapshot.owner = Some(PublicationOwner { run_id, stage_id, stage_kind: stage_kind.into() });
    }
    Ok(Some(snapshot))
}

fn owner_pair(
    document: Option<&Value>, run_key: &str, stage_key: &str,
    allow_manifest_placeholder: bool, family: Option<&str>,
) -> Result<Option<(String, String)>, ApiError> {
    let Some(document) = document else { return Ok(None) };
    let run = document.get(run_key).filter(|v| !v.is_null());
    let stage = document.get(stage_key).filter(|v| !v.is_null());
    if allow_manifest_placeholder {
        let placeholder_stage = match family {
            Some("modal_eigen") => Some("eigenmodes"),
            Some("driven_response") => Some("frequency_response"),
            _ => None,
        };
        let known_stage_placeholder = stage.and_then(Value::as_str) == placeholder_stage
            || (family == Some("driven_response")
                && stage.and_then(Value::as_str) == Some("frequency-response"));
        if matches!(run.and_then(Value::as_str), Some("current" | "run:current"))
            && known_stage_placeholder
            && placeholder_stage.is_some()
        {
            return Ok(None);
        }
    }
    match (run, stage) {
        (None, None) => Ok(None),
        (Some(run), Some(stage)) => Ok(Some((exact(run, run_key)?, exact(stage, stage_key)?))),
        _ => Err(invalid("frequency-domain publication owner is incomplete")),
    }
}

fn exact(value: &Value, label: &str) -> Result<String, ApiError> {
    let value = value.as_str().ok_or_else(|| invalid(format!("invalid published {label}")))?;
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.is_empty() || normalized == "current" || normalized.ends_with(":current")
        || value.chars().any(char::is_control)
    {
        return Err(invalid(format!("invalid exact published {label}")));
    }
    Ok(value.into())
}

fn read_record(root: &Path, relative: &str) -> Result<Option<(Value, String)>, ApiError> {
    let Some(path) = try_resolve_artifact_path(root, relative)? else { return Ok(None) };
    let file = std::fs::File::open(path).map_err(|e| invalid(e.to_string()))?;
    if !file.metadata()?.is_file() { return Err(invalid("publication owner record is not a regular file")) }
    use std::io::Read;
    let mut bytes = Vec::new();
    file.take(64 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > 64 * 1024 * 1024 { return Err(invalid("publication owner record exceeds size limit")) }
    let value = serde_json::from_slice(&bytes).map_err(|e| invalid(format!("invalid publication owner record: {e}")))?;
    Ok(Some((value, format!("sha256:{:x}", Sha256::digest(&bytes)))))
}

fn invalid(message: impl Into<String>) -> ApiError { ApiError::internal(message) }

#[cfg(test)]
mod tests {
    use super::*;
    struct Root(std::path::PathBuf);
    impl Root {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("frequency-owner-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(root.join("frequency_domain")).unwrap();
            Self(root)
        }
        fn records(&self, manifest: Value, metadata: Value) {
            std::fs::write(self.0.join("frequency_domain/manifest.v1.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
            std::fs::write(self.0.join("metadata.json"), serde_json::to_vec(&metadata).unwrap()).unwrap();
        }
    }
    impl Drop for Root { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
    fn manifest(owner: Value) -> Value {
        let mut value = serde_json::json!({"schema_version":"frequency_domain_manifest.v1","study_product":"modal_eigen"});
        value.as_object_mut().unwrap().extend(owner.as_object().unwrap().clone());
        value
    }
    fn metadata(run: &str, stage: &str) -> Value {
        serde_json::json!({"problem_meta":{"runtime_metadata":{
            "producer_run_id":run,"producer_stage_id":stage,"producer_stage_kind":"flat_eigenmodes",
            "active_stage_id":"unrelated-authored-stage"}}})
    }
    #[test]
    fn legacy_owner_uses_exact_metadata_and_known_manifest_placeholder() {
        let root = Root::new();
        root.records(manifest(serde_json::json!({"run_id":"current","stage_id":"eigenmodes"})), metadata("archived-run", "archived-stage"));
        let snapshot = read_legacy_owner(&root.0, "eigen/spectrum.v2.json").unwrap().unwrap();
        let owner = snapshot.owner.unwrap();
        assert_eq!(owner.run_id, "archived-run");
        assert_eq!(owner.stage_id, "archived-stage");
    }
    #[test]
    fn legacy_response_writer_placeholder_remains_unbound() {
        let root = Root::new();
        root.records(serde_json::json!({
            "schema_version":"frequency_domain_manifest.v1", "study_product":"driven_response",
            "run_id":"current", "stage_id":"frequency-response"
        }), serde_json::json!({}));
        let snapshot = read_legacy_owner(&root.0, "response/frequency_points/frequency_0000.json")
            .unwrap().unwrap();
        assert!(snapshot.owner.is_none());
    }

    #[test]
    fn legacy_owner_rejects_conflict_partial_alias_and_wrong_stage_kind() {
        let root = Root::new();
        for owner in [serde_json::json!({"run_id":"foreign","stage_id":"archived-stage"}),
            serde_json::json!({"run_id":"archived-run"}),
            serde_json::json!({"run_id":"current","stage_id":"foreign-stage"})] {
            root.records(manifest(owner), metadata("archived-run", "archived-stage"));
            assert!(read_legacy_owner(&root.0, "eigen/spectrum.v2.json").is_err());
        }
        let mut invalid = metadata("archived-run", "archived-stage");
        invalid["problem_meta"]["runtime_metadata"]["producer_stage_kind"] = serde_json::json!("frequency_response");
        root.records(manifest(serde_json::json!({})), invalid);
        assert!(read_legacy_owner(&root.0, "eigen/spectrum.v2.json").is_err());
    }
    #[test]
    fn legacy_owner_witness_tracks_same_owner_record_changes() {
        let root = Root::new();
        root.records(manifest(serde_json::json!({})), metadata("archived-run", "archived-stage"));
        let first = read_legacy_owner(&root.0, "eigen/spectrum.v2.json").unwrap();
        let mut changed = metadata("archived-run", "archived-stage");
        changed["unrelated_diagnostic"] = serde_json::json!(1);
        root.records(manifest(serde_json::json!({})), changed);
        let second = read_legacy_owner(&root.0, "eigen/spectrum.v2.json").unwrap();
        assert_eq!(first.as_ref().unwrap().owner, second.as_ref().unwrap().owner);
        assert_ne!(first, second);
    }
    #[test]
    fn legacy_owner_does_not_borrow_a_different_family_or_authored_stage() {
        let root = Root::new();
        root.records(serde_json::json!({"schema_version":"frequency_domain_manifest.v1","study_product":"driven_response","run_id":"foreign","stage_id":"driven"}), metadata("foreign", "driven"));
        assert!(read_legacy_owner(&root.0, "eigen/spectrum.v2.json").unwrap().unwrap().owner.is_none());
        root.records(manifest(serde_json::json!({})), serde_json::json!({"problem_meta":{"runtime_metadata":{"active_stage_id":"modes"}}}));
        assert!(read_legacy_owner(&root.0, "eigen/spectrum.v2.json").unwrap().unwrap().owner.is_none());
    }
}
