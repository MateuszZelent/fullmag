//! Exact publication owner from files in one captured artifact directory.
use super::FrequencyDomainLiveArtifactIdentity;
use crate::artifacts::try_resolve_artifact_path;
use crate::error::ApiError;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct PublishedOwner {
    run_id: String,
    stage_id: String,
    manifest_digest: Option<String>,
    metadata_digest: Option<String>,
}
impl PublishedOwner {
    pub(super) fn apply(&self, identity: &mut FrequencyDomainLiveArtifactIdentity) {
        identity.run_id = Some(self.run_id.clone());
        identity.stage_id = Some(self.stage_id.clone());
    }
}

pub(super) fn read_owner(
    root: &Path,
    artifact_path: &str,
) -> Result<Option<PublishedOwner>, ApiError> {
    let manifest = read_record(root, "frequency_domain/manifest.v1.json")?;
    // A family manifest never assigns a driven-response owner to earlier modal artifacts.
    if let Some((manifest, _)) = &manifest {
        let product = manifest.get("study_product").and_then(Value::as_str);
        if (artifact_path.starts_with("eigen/") && product == Some("driven_response"))
            || (artifact_path.starts_with("response/") && product == Some("modal_eigen"))
        {
            return Ok(None);
        }
    }
    let metadata = read_record(root, "metadata.json")?;
    resolve_owner(manifest.as_ref(), metadata.as_ref())
}
fn read_record(root: &Path, relative: &str) -> Result<Option<(Value, String)>, ApiError> {
    let Some(path) = try_resolve_artifact_path(root, relative)? else {
        return Ok(None);
    };
    if std::fs::metadata(&path)
        .map_err(|e| ApiError::internal(e.to_string()))?
        .len()
        > 64 * 1024 * 1024
    {
        return Err(ApiError::internal(
            "frequency-domain owner record exceeds size limit",
        ));
    }
    let bytes = std::fs::read(path).map_err(|e| ApiError::internal(e.to_string()))?;
    let value = serde_json::from_slice(&bytes)
        .map_err(|e| ApiError::internal(format!("invalid publication owner record: {e}")))?;
    Ok(Some((
        value,
        format!("sha256:{:x}", Sha256::digest(&bytes)),
    )))
}
fn exact(value: Option<&Value>, label: &str) -> Result<Option<String>, ApiError> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    let value = value
        .as_str()
        .ok_or_else(|| ApiError::internal(format!("invalid published {label}")))?;
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.is_empty()
        || normalized == "current"
        || normalized.ends_with(":current")
        || value.chars().any(char::is_control)
    {
        return Err(ApiError::internal(format!(
            "invalid exact published {label}"
        )));
    }
    Ok(Some(value.to_string()))
}
fn pair(
    document: Option<&Value>,
    run_key: &str,
    stage_key: &str,
) -> Result<Option<(String, String)>, ApiError> {
    let Some(document) = document else {
        return Ok(None);
    };
    let run = exact(document.get(run_key), run_key)?;
    let stage = exact(document.get(stage_key), stage_key)?;
    match (run, stage) {
        (None, None) => Ok(None),
        (Some(run), Some(stage)) => Ok(Some((run, stage))),
        _ => Err(ApiError::internal(
            "frequency-domain publication owner is incomplete",
        )),
    }
}
fn resolve_owner(
    manifest: Option<&(Value, String)>,
    metadata: Option<&(Value, String)>,
) -> Result<Option<PublishedOwner>, ApiError> {
    if let Some((manifest, _)) = manifest {
        if manifest.get("schema_version").and_then(Value::as_str)
            != Some("frequency_domain_manifest.v1")
        {
            return Err(ApiError::internal(
                "unsupported frequency-domain owner manifest",
            ));
        }
    }
    let manifest_owner = pair(manifest.map(|(value, _)| value), "run_id", "stage_id")?;
    // These fields are supplied by orchestration before dispatch, not inferred
    // from paths, authored active_stage_id, import state, or the current session.
    let metadata_owner = pair(
        metadata.and_then(|(value, _)| value.get("problem_meta")?.get("runtime_metadata")),
        "producer_run_id",
        "producer_stage_id",
    )?;
    if metadata_owner.is_some() {
        let kind = metadata.and_then(|(value, _)| {
            value
                .get("problem_meta")?
                .get("runtime_metadata")?
                .get("producer_stage_kind")?
                .as_str()
        });
        let product = manifest.and_then(|(value, _)| value.get("study_product")?.as_str());
        if (product == Some("modal_eigen")
            && !matches!(kind, Some("flat_eigenmodes" | "eigenmodes")))
            || (product == Some("driven_response")
                && !matches!(kind, Some("flat_frequency_response" | "frequency_response")))
        {
            return Err(ApiError::internal(
                "frequency-domain manifest conflicts with producer stage kind",
            ));
        }
    }
    if manifest_owner.is_some() && metadata_owner.is_some() && manifest_owner != metadata_owner {
        return Err(ApiError::internal(
            "frequency-domain manifest conflicts with producer metadata owner",
        ));
    }
    let Some((run_id, stage_id)) = manifest_owner.or(metadata_owner) else {
        return Ok(None);
    };
    Ok(Some(PublishedOwner {
        run_id,
        stage_id,
        manifest_digest: manifest.map(|(_, digest)| digest.clone()),
        metadata_digest: metadata.map(|(_, digest)| digest.clone()),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn manifest(owner: Value) -> (Value, String) {
        let mut value = serde_json::json!({"schema_version":"frequency_domain_manifest.v1"});
        value
            .as_object_mut()
            .unwrap()
            .extend(owner.as_object().unwrap().clone());
        (value, "manifest-digest".into())
    }
    fn metadata(run: &str, stage: &str) -> (Value, String) {
        (
            serde_json::json!({"problem_meta":{"runtime_metadata":{"producer_run_id":run,"producer_stage_id":stage,"producer_stage_kind":"flat_eigenmodes","active_stage_id":"modes"}}}),
            "metadata-digest".into(),
        )
    }
    #[test]
    fn legacy_import_uses_exact_same_directory_producer_owner() {
        let owner = resolve_owner(
            Some(&manifest(serde_json::json!({}))),
            Some(&metadata("run-archived", "stage-001")),
        )
        .unwrap()
        .unwrap();
        assert_eq!(owner.run_id, "run-archived");
        assert_eq!(owner.stage_id, "stage-001");
        assert_eq!(owner.metadata_digest.as_deref(), Some("metadata-digest"));
    }
    #[test]
    fn conflicting_partial_and_mutable_owner_records_fail_closed() {
        assert!(resolve_owner(
            Some(&manifest(
                serde_json::json!({"run_id":"foreign","stage_id":"stage-001"})
            )),
            Some(&metadata("run-archived", "stage-001"))
        )
        .is_err());
        assert!(resolve_owner(
            Some(&manifest(serde_json::json!({"run_id":"run-archived"}))),
            None
        )
        .is_err());
        assert!(resolve_owner(None, Some(&metadata("current", "stage-001"))).is_err());
    }
    #[test]
    fn missing_owner_is_never_reconstructed_from_authored_stage() {
        let record = (
            serde_json::json!({"problem_meta":{"runtime_metadata":{"active_stage_id":"modes"}}}),
            "digest".into(),
        );
        assert!(
            resolve_owner(Some(&manifest(serde_json::json!({}))), Some(&record))
                .unwrap()
                .is_none()
        );
    }
}
