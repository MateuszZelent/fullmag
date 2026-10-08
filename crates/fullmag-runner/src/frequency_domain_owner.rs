//! Bind newly produced frequency-domain manifests to the execution owner.
use crate::types::AuxiliaryArtifact;
use serde_json::Value;
use std::io::{Error, ErrorKind, Result};

pub(super) fn bind_manifest_owner(
    artifacts: &mut [AuxiliaryArtifact],
    metadata: &std::collections::BTreeMap<String, Value>,
) -> Result<()> {
    let selected: Vec<usize> = artifacts
        .iter()
        .enumerate()
        .filter(|(_, artifact)| artifact.relative_path == "frequency_domain/manifest.v1.json")
        .map(|(index, _)| index)
        .collect();
    if selected.is_empty() {
        return Ok(());
    }
    if selected.len() != 1 {
        return Err(invalid("duplicate frequency-domain manifest"));
    }
    let run = metadata.get("producer_run_id");
    let stage = metadata.get("producer_stage_id");
    if run.is_none() && stage.is_none() {
        return Ok(());
    }
    let run = exact_identity(run, "producer_run_id")?;
    let stage = exact_identity(stage, "producer_stage_id")?;
    let artifact = &mut artifacts[selected[0]];
    let mut value: Value =
        serde_json::from_slice(&artifact.bytes).map_err(|error| invalid(error.to_string()))?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| invalid("frequency-domain manifest is not an object"))?;
    if object.get("schema_version").and_then(Value::as_str) != Some("frequency_domain_manifest.v1")
    {
        return Err(invalid("unsupported frequency-domain manifest schema"));
    }
    // Older in-memory FEM path producers used an explicit mutable run alias.
    // It is replaced before first publication, never in an archived artifact.
    let legacy_alias = object
        .get("run_id")
        .and_then(Value::as_str)
        .is_some_and(|value| value == "current" || value == "run:current");
    for (key, expected) in [("run_id", run), ("stage_id", stage)] {
        if !legacy_alias {
            if let Some(existing) = object.get(key).filter(|value| !value.is_null()) {
                if existing.as_str() != Some(expected) {
                    return Err(invalid(format!(
                        "frequency-domain manifest {key} conflicts with execution owner"
                    )));
                }
            }
        }
        object.insert(key.into(), Value::String(expected.into()));
    }
    artifact.bytes =
        serde_json::to_vec_pretty(&value).map_err(|error| invalid(error.to_string()))?;
    Ok(())
}

fn exact_identity<'a>(value: Option<&'a Value>, label: &str) -> Result<&'a str> {
    let value = value
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(format!("missing exact {label}")))?;
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.is_empty()
        || normalized == "current"
        || normalized.ends_with(":current")
        || value.chars().any(char::is_control)
    {
        return Err(invalid(format!("invalid exact {label}")));
    }
    Ok(value)
}
fn invalid(message: impl Into<String>) -> Error {
    Error::new(ErrorKind::InvalidData, message.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn artifact(owner: Value) -> AuxiliaryArtifact {
        let mut manifest = serde_json::json!({"schema_version":"frequency_domain_manifest.v1","physics":{"frequency_units":"Hz"}});
        manifest
            .as_object_mut()
            .unwrap()
            .extend(owner.as_object().unwrap().clone());
        AuxiliaryArtifact {
            relative_path: "frequency_domain/manifest.v1.json".into(),
            bytes: serde_json::to_vec(&manifest).unwrap(),
        }
    }
    fn metadata() -> std::collections::BTreeMap<String, Value> {
        serde_json::json!({"producer_run_id":"run-exact","producer_stage_id":"stage-001","active_stage_id":"modes"}).as_object().unwrap().iter().map(|(k,v)| (k.clone(),v.clone())).collect()
    }
    #[test]
    fn native_manifest_binds_execution_owner_without_inferred_authored_stage() {
        for owner in [
            serde_json::json!({}),
            serde_json::json!({"run_id":"current","stage_id":"eigenmodes"}),
        ] {
            let mut artifacts = [artifact(owner)];
            bind_manifest_owner(&mut artifacts, &metadata()).unwrap();
            let manifest: Value = serde_json::from_slice(&artifacts[0].bytes).unwrap();
            assert_eq!(manifest["run_id"], "run-exact");
            assert_eq!(manifest["stage_id"], "stage-001");
            assert_eq!(manifest["physics"]["frequency_units"], "Hz");
        }
    }
    #[test]
    fn partial_alias_and_conflicting_owner_fail_closed_without_changing_bytes() {
        for meta in [
            serde_json::json!({"producer_run_id":"run-exact"}),
            serde_json::json!({"producer_run_id":"current","producer_stage_id":"stage-001"}),
        ] {
            let mut artifacts = [artifact(serde_json::json!({}))];
            let before = artifacts[0].bytes.clone();
            assert!(bind_manifest_owner(
                &mut artifacts,
                &meta
                    .as_object()
                    .unwrap()
                    .iter()
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect()
            )
            .is_err());
            assert_eq!(before, artifacts[0].bytes);
        }
        let mut artifacts = [artifact(
            serde_json::json!({"run_id":"foreign","stage_id":"stage-001"}),
        )];
        assert!(bind_manifest_owner(&mut artifacts, &metadata()).is_err());
    }
}
