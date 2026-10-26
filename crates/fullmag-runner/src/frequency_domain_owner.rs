//! Bind a newly produced manifest to the same owner as its generation commit.
use crate::artifact_generation::PublicationOwner;
use crate::types::AuxiliaryArtifact;
use serde_json::Value;
use std::io::{Error, ErrorKind, Result};

pub(super) fn bind_manifest_owner(
    artifacts: &mut [AuxiliaryArtifact],
    owner: Option<&PublicationOwner>,
) -> Result<()> {
    let Some(owner) = owner else { return Ok(()) };
    let selected = artifacts.iter().enumerate()
        .filter(|(_, artifact)| artifact.relative_path == "frequency_domain/manifest.v1.json")
        .map(|(index, _)| index).collect::<Vec<_>>();
    let index = match selected.as_slice() {
        [] => return Ok(()),
        [index] => *index,
        _ => return Err(invalid("duplicate frequency-domain manifest")),
    };
    let artifact = &mut artifacts[index];
    let mut value: Value = serde_json::from_slice(&artifact.bytes).map_err(|e| invalid(e.to_string()))?;
    let object = value.as_object_mut().ok_or_else(|| invalid("frequency-domain manifest is not an object"))?;
    if object.get("schema_version").and_then(Value::as_str) != Some("frequency_domain_manifest.v1") {
        return Err(invalid("unsupported frequency-domain manifest schema"));
    }
    let product = object.get("study_product").and_then(Value::as_str);
    let modal = matches!(owner.stage_kind.as_str(), "flat_eigenmodes" | "eigenmodes");
    let response = matches!(owner.stage_kind.as_str(), "flat_frequency_response" | "frequency_response");
    if product.is_some_and(|product| !matches!((product, modal, response),
        ("modal_eigen", true, _) | ("driven_response", _, true))) {
        return Err(invalid("frequency-domain manifest conflicts with producer stage kind"));
    }
    let legacy_placeholder = matches!(object.get("run_id").and_then(Value::as_str), Some("current" | "run:current"))
        && match object.get("stage_id").and_then(Value::as_str) {
            Some("eigenmodes") => modal,
            Some("frequency_response") => response,
            _ => false,
        };
    for (key, expected) in [("run_id", &owner.run_id), ("stage_id", &owner.stage_id)] {
        if !legacy_placeholder {
            if let Some(existing) = object.get(key).filter(|value| !value.is_null()) {
                if existing.as_str() != Some(expected.as_str()) {
                    return Err(invalid(format!("frequency-domain manifest {key} conflicts with execution owner")));
                }
            }
        }
        object.insert(key.into(), Value::String(expected.clone()));
    }
    // Serialization and all checks finish before touching the pending bytes.
    artifact.bytes = serde_json::to_vec_pretty(&value).map_err(|e| invalid(e.to_string()))?;
    Ok(())
}

fn invalid(message: impl Into<String>) -> Error { Error::new(ErrorKind::InvalidData, message.into()) }

#[cfg(test)]
mod tests {
    use super::*;

    fn owner() -> PublicationOwner {
        PublicationOwner { run_id: "run-exact".into(), stage_id: "stage-exact".into(), stage_kind: "eigenmodes".into() }
    }
    fn artifact(identity: Value) -> AuxiliaryArtifact {
        let mut value = serde_json::json!({"schema_version":"frequency_domain_manifest.v1", "study_product":"modal_eigen", "physics":{"normalization":"unit_l2"}});
        value.as_object_mut().unwrap().extend(identity.as_object().unwrap().clone());
        AuxiliaryArtifact { relative_path: "frequency_domain/manifest.v1.json".into(), bytes: serde_json::to_vec(&value).unwrap() }
    }
    #[test]
    fn manifest_owner_reuses_generation_producer_and_known_placeholders() {
        for identity in [serde_json::json!({}), serde_json::json!({"run_id":"current","stage_id":"eigenmodes"}),
            serde_json::json!({"run_id":"run-exact","stage_id":"stage-exact"})] {
            let mut artifacts = [artifact(identity)];
            bind_manifest_owner(&mut artifacts, Some(&owner())).unwrap();
            let value: Value = serde_json::from_slice(&artifacts[0].bytes).unwrap();
            assert_eq!(value["run_id"], "run-exact");
            assert_eq!(value["stage_id"], "stage-exact");
            assert_eq!(value["physics"]["normalization"], "unit_l2");
        }
    }
    #[test]
    fn manifest_owner_rejects_exact_conflicts_and_partial_alias_without_mutation() {
        for identity in [serde_json::json!({"run_id":"foreign","stage_id":"stage-exact"}),
            serde_json::json!({"run_id":"current","stage_id":"foreign-stage"}),
            serde_json::json!({"run_id":"current"}),
            serde_json::json!({"study_product":"driven_response"})] {
            let mut artifacts = [artifact(identity)];
            let before = artifacts[0].bytes.clone();
            assert!(bind_manifest_owner(&mut artifacts, Some(&owner())).is_err());
            assert_eq!(artifacts[0].bytes, before);
        }
    }
}
