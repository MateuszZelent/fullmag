//! Typed reachability schemas for documents that used to be opaque to the
//! session/archive walkers.
//!
//! Two persisted-document families have distinct reachability contracts:
//!
//! * known backend restart payloads whose `integrator_state` is a self-contained
//!   versioned checkpoint schema, and
//! * `project/current_live_snapshot.json`, whose CAS references are scanned
//!   independently from its typed run-scoped `artifacts[].path` entries.
//!
//! The scanner does not guess hash-like strings. Unknown or hidden references
//! keep the graph incomplete, while the independent artifact projection makes
//! sure opaque inline fields cannot hide missing run files from reachability.
use crate::types::BackendStatePayload;
use serde_json::Value;

/// Integrator checkpoint schemas that are known to be self-contained.
const COUPLED_M3_SCHEMA: &str = "fullmag.fdm.coupled_m3_checkpoint.v1";
const FROZEN_SPINS_SCHEMA: &str = "fullmag.frozen_spins.checkpoint.v1";

/// Top-level keys of `PersistedCurrentLiveSnapshot`.
const SNAPSHOT_KEYS: &[&str] = &[
    "session_protocol_version",
    "capability_profile_version",
    "session",
    "run",
    "live_state",
    "runtime_status",
    "capabilities",
    "metadata",
    "mesh_workspace",
    "stage_execution",
    "scene_document",
    "scalar_rows",
    "engine_log",
    "quantities",
    "fem_mesh",
    "latest_fields",
    "field_publication_bundles",
    "accepted_terminal_field_generation",
    "terminal_field_generations",
    "artifacts",
    "display_selection",
    "display_presentation_schema_version",
    "display_presentation",
    "workspace_selection",
    "workspace_ribbon",
    "workspace_layout",
    "preview_config",
    "preview",
    "builder_adapter",
    "mesh_revision",
    "mesh_build_revision",
    "region_realization_revisions",
];

/// Keys without which the document is not a live-session snapshot.
const SNAPSHOT_REQUIRED_KEYS: &[&str] = &[
    "session_protocol_version",
    "capability_profile_version",
    "session",
    "runtime_status",
    "artifacts",
    "display_selection",
    "preview_config",
    "mesh_revision",
    "mesh_build_revision",
];

/// Live-workspace-local reference labels persisted in the snapshot
/// (`StageExecutionState` segment records). They name live runtime artifacts
/// and checkpoints (for example `artifacts/stage-000` or `cp-000042`) in the
/// producing workspace; they are not archive members or CAS objects, so the
/// walker neither follows nor retains them. A value that is a valid CAS object
/// ref is still retained, and an `objects/...` path is still rejected.
const LIVE_LOCAL_REFERENCE_KEYS: &[&str] = &[
    "artifact_refs",
    "checkpoint_ref",
    "loaded_state_ref",
    "resume_from_checkpoint_ref",
];

/// Outcome of typed inspection.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum TypedInspection {
    /// Typed and complete; the listed CAS objects must be retained.
    Typed { object_refs: Vec<String> },
    /// Not covered by a typed schema, or hiding references. The message is a
    /// warning fragment; the caller marks the graph incomplete.
    Untyped(String),
}
/// The reachability-relevant projection of the persisted `ArtifactEntry` wire
/// shape. The original snapshot bytes remain untouched in the session/archive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LiveSnapshotArtifactReference {
    pub path: String,
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LiveSnapshotArtifactReferences {
    pub run_id: String,
    pub artifacts: Vec<LiveSnapshotArtifactReference>,
}

/// CAS scanning and artifact projection are independent so an opaque inline
/// field cannot suppress validation of declared run artifact paths.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct LiveSnapshotInspection {
    pub object_refs: Result<Vec<String>, String>,
    pub artifact_refs: Result<LiveSnapshotArtifactReferences, String>,
}

fn is_reference_key(key: &str) -> bool {
    key == "ref" || key == "refs" || key.ends_with("_ref") || key.ends_with("_refs")
}

fn is_object_ref(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Iteratively scan an inline document. When `allow_object_refs` is set, a
/// reference-bearing key may hold a CAS object ref (or null/array thereof),
/// which is returned for retention. The live snapshot variant separately
/// exempts only its typed `artifacts[].path` strings from the `objects/...`
/// CAS-path check; that path is validated and followed by the reachability walker.
fn scan_inline(root: &Value, allow_object_refs: bool) -> Result<Vec<String>, String> {
    scan_inline_with_artifact_paths(root, allow_object_refs, false)
}

fn scan_inline_with_artifact_paths(
    root: &Value,
    allow_object_refs: bool,
    allow_typed_artifact_paths: bool,
) -> Result<Vec<String>, String> {
    let mut objects = Vec::new();
    let mut stack = vec![(root, false, false)];
    while let Some((value, is_artifact_entry, is_typed_artifact_path)) = stack.pop() {
        match value {
            Value::Object(map) => {
                for (key, child) in map {
                    if allow_object_refs && LIVE_LOCAL_REFERENCE_KEYS.contains(&key.as_str()) {
                        if collect_local_labels(child, &mut objects).is_err() {
                            return Err(format!(
                                "live-local reference `{key}` is not a plain label"
                            ));
                        }
                        continue;
                    }
                    if is_reference_key(key) {
                        if collect_reference(child, allow_object_refs, &mut objects).is_err() {
                            return Err(format!(
                                "reference key `{key}` is not a CAS object reference"
                            ));
                        }
                        continue;
                    }
                    if allow_typed_artifact_paths && is_artifact_entry && key == "path" {
                        stack.push((child, false, true));
                        continue;
                    }
                    if allow_typed_artifact_paths
                        && std::ptr::eq(value, root)
                        && key == "artifacts"
                    {
                        if let Value::Array(entries) = child {
                            for entry in entries {
                                stack.push((entry, entry.is_object(), false));
                            }
                        } else {
                            stack.push((child, false, false));
                        }
                        continue;
                    }
                    stack.push((child, false, false));
                }
            }
            Value::Array(items) => stack.extend(items.iter().map(|item| (item, false, false))),
            Value::String(text) => {
                if !is_typed_artifact_path && text.starts_with("objects/") {
                    return Err(format!("CAS path string `{text}`"));
                }
            }
            _ => {}
        }
    }
    objects.sort();
    objects.dedup();
    Ok(objects)
}

fn collect_local_labels(value: &Value, objects: &mut Vec<String>) -> Result<(), ()> {
    match value {
        Value::Null => Ok(()),
        Value::String(text) if text.starts_with("objects/") => Err(()),
        Value::String(text) => {
            if is_object_ref(text) {
                objects.push(text.clone());
            }
            Ok(())
        }
        Value::Array(items) => items
            .iter()
            .try_for_each(|item| collect_local_labels(item, objects)),
        _ => Err(()),
    }
}

fn collect_reference(
    value: &Value,
    allow_object_refs: bool,
    objects: &mut Vec<String>,
) -> Result<(), ()> {
    match value {
        Value::Null => Ok(()),
        Value::String(text) if allow_object_refs && is_object_ref(text) => {
            objects.push(text.clone());
            Ok(())
        }
        Value::Array(items) if allow_object_refs => {
            for item in items {
                collect_reference(item, allow_object_refs, objects)?;
            }
            Ok(())
        }
        _ => Err(()),
    }
}

fn expected_integrator_kinds(schema: &str) -> Option<&'static [&'static str]> {
    match schema {
        COUPLED_M3_SCHEMA => Some(&["coupled_imex_ark2"]),
        FROZEN_SPINS_SCHEMA => Some(&["frozen_spins"]),
        _ => None,
    }
}

/// Classify a backend restart payload. A payload is typed only when its
/// `integrator_state` declares a known inline checkpoint schema, the
/// envelope metadata agrees with it, `extra` carries nothing beyond the
/// schema marker and no reference is hidden in the state.
pub(crate) fn inspect_backend_state(payload: &BackendStatePayload) -> TypedInspection {
    let Some(state) = payload
        .integrator_state
        .as_ref()
        .filter(|value| !value.is_null())
    else {
        return untyped_backend("no integrator state schema");
    };
    let Some(schema) = state.get("schema").and_then(Value::as_str) else {
        return untyped_backend("integrator state declares no schema");
    };
    let Some(kinds) = expected_integrator_kinds(schema) else {
        return untyped_backend(&format!("unknown integrator state schema `{schema}`"));
    };
    if !payload
        .integrator_kind
        .as_deref()
        .is_some_and(|kind| kinds.contains(&kind))
    {
        return untyped_backend("integrator kind does not match the state schema");
    }
    match &payload.extra {
        Value::Null => {}
        Value::Object(map)
            if map.is_empty()
                || (map.len() == 1
                    && map.get("checkpoint_schema").and_then(Value::as_str) == Some(schema)) => {}
        _ => return untyped_backend("extra state is not the checkpoint schema marker"),
    }
    match scan_inline(state, false) {
        Ok(_) => TypedInspection::Typed {
            object_refs: Vec::new(),
        },
        Err(reason) => untyped_backend(&reason),
    }
}

fn untyped_backend(reason: &str) -> TypedInspection {
    TypedInspection::Untyped(format!("untyped backend restart state ({reason})"))
}

/// Inspect `project/current_live_snapshot.json` without conflating its two
/// persisted reference mechanisms: inline CAS refs and run-scoped artifacts.
pub(crate) fn inspect_live_snapshot(data: &[u8]) -> LiveSnapshotInspection {
    let value: Value = match serde_json::from_slice(data) {
        Ok(value) => value,
        Err(error) => {
            let reason = format!("not valid JSON: {error}");
            return LiveSnapshotInspection {
                object_refs: Err(reason.clone()),
                artifact_refs: Err(reason),
            };
        }
    };
    LiveSnapshotInspection {
        object_refs: inspect_live_snapshot_object_refs(&value),
        artifact_refs: inspect_live_snapshot_artifact_refs(&value),
    }
}

fn inspect_live_snapshot_object_refs(value: &Value) -> Result<Vec<String>, String> {
    let Some(map) = value.as_object() else {
        return Err("root is not an object".to_string());
    };
    if let Some(key) = map
        .keys()
        .find(|key| !SNAPSHOT_KEYS.contains(&key.as_str()))
    {
        return Err(format!("unknown top-level key `{key}`"));
    }
    if let Some(key) = SNAPSHOT_REQUIRED_KEYS
        .iter()
        .find(|key| !map.contains_key(**key))
    {
        return Err(format!("missing top-level key `{key}`"));
    }
    scan_inline_with_artifact_paths(value, true, true)
}

fn inspect_live_snapshot_artifact_refs(
    value: &Value,
) -> Result<LiveSnapshotArtifactReferences, String> {
    let root = value
        .as_object()
        .ok_or_else(|| "root is not an object".to_string())?;
    let session = root
        .get("session")
        .and_then(Value::as_object)
        .ok_or_else(|| "session is not an object".to_string())?;
    let run_id = session
        .get("run_id")
        .and_then(Value::as_str)
        .filter(|run_id| !run_id.is_empty())
        .ok_or_else(|| "session.run_id is not a non-empty string".to_string())?
        .to_string();
    let entries = root
        .get("artifacts")
        .and_then(Value::as_array)
        .ok_or_else(|| "artifacts is not an array".to_string())?;
    let mut artifacts = Vec::with_capacity(entries.len());
    for (index, entry) in entries.iter().enumerate() {
        let entry = entry
            .as_object()
            .ok_or_else(|| format!("artifacts[{index}] is not an object"))?;
        let path = entry
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("artifacts[{index}].path is not a string"))?;
        let kind = entry
            .get("kind")
            .and_then(Value::as_str)
            .filter(|kind| !kind.is_empty())
            .ok_or_else(|| format!("artifacts[{index}].kind is not a non-empty string"))?;
        artifacts.push(LiveSnapshotArtifactReference {
            path: path.to_string(),
            kind: kind.to_string(),
        });
    }
    Ok(LiveSnapshotArtifactReferences { run_id, artifacts })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn payload(state: Value, kind: &str, extra: Value) -> BackendStatePayload {
        BackendStatePayload {
            format: "fullmag.backend_state.v1".into(),
            backend_family: "fdm_cpu_reference".into(),
            integrator_kind: Some(kind.into()),
            integrator_state: Some(state),
            rng_state: None,
            extra,
        }
    }

    #[test]
    fn known_inline_checkpoint_schemas_are_typed() {
        let coupled = payload(
            json!({"schema": COUPLED_M3_SCHEMA, "source_identity": "source:8",
                   "refresh_count": 4, "mask_sha256": "a".repeat(64)}),
            "coupled_imex_ark2",
            json!({"checkpoint_schema": COUPLED_M3_SCHEMA}),
        );
        assert_eq!(
            inspect_backend_state(&coupled),
            TypedInspection::Typed { object_refs: vec![] }
        );
        let frozen = payload(
            json!({"schema": FROZEN_SPINS_SCHEMA, "reference": [[0.0, 0.0, 1.0]]}),
            "frozen_spins",
            json!({"checkpoint_schema": FROZEN_SPINS_SCHEMA}),
        );
        assert!(matches!(
            inspect_backend_state(&frozen),
            TypedInspection::Typed { .. }
        ));
    }

    #[test]
    fn unknown_or_inconsistent_restart_state_stays_untyped() {
        let ok = json!({"schema": COUPLED_M3_SCHEMA});
        let marker = json!({"checkpoint_schema": COUPLED_M3_SCHEMA});
        let hash = "d".repeat(64);
        let cases = [
            payload(
                json!({"schema": "vendor.state.v9"}),
                "coupled_imex_ark2",
                Value::Null,
            ),
            payload(json!({"step": 1}), "coupled_imex_ark2", Value::Null),
            payload(ok.clone(), "llg", marker.clone()),
            payload(
                ok.clone(),
                "coupled_imex_ark2",
                json!({"hidden_object_ref": hash}),
            ),
            payload(
                json!({"schema": COUPLED_M3_SCHEMA, "nested": [{"blob_ref": hash}]}),
                "coupled_imex_ark2",
                marker.clone(),
            ),
            payload(
                json!({"schema": COUPLED_M3_SCHEMA, "path": format!("objects/sha256/{hash}")}),
                "coupled_imex_ark2",
                marker,
            ),
        ];
        for case in &cases {
            assert!(
                matches!(inspect_backend_state(case), TypedInspection::Untyped(_)),
                "{case:?}"
            );
        }
    }

    fn snapshot() -> Value {
        json!({
            "session_protocol_version": "v2", "capability_profile_version": "v1",
            "session": {"session_id": "session-1", "run_id": "run-1"},
            "runtime_status": {},
            "artifacts": [{"path": "a.zarr", "kind": "zarr", "region_owned_provenance": {"scene_revision": 1}}],
            "display_selection": {}, "preview_config": {},
            "mesh_revision": 1, "mesh_build_revision": 1,
            "latest_fields": {"m": {"topology_hash": "a".repeat(64)}}
        })
    }

    #[test]
    fn live_snapshot_without_cas_references_projects_run_artifacts() {
        let inspection = inspect_live_snapshot(&serde_json::to_vec(&snapshot()).unwrap());
        assert_eq!(inspection.object_refs, Ok(vec![]));
        assert_eq!(
            inspection.artifact_refs,
            Ok(LiveSnapshotArtifactReferences {
                run_id: "run-1".to_string(),
                artifacts: vec![LiveSnapshotArtifactReference {
                    path: "a.zarr".to_string(),
                    kind: "zarr".to_string(),
                }],
            })
        );
    }

    #[test]
    fn live_snapshot_cas_refs_and_artifact_projection_are_independent() {
        let hash = "b".repeat(64);
        let mut value = snapshot();
        value["latest_fields"] = json!({"m": {"payload_ref": hash, "chunks_refs": [hash, null]}});
        let inspection = inspect_live_snapshot(&serde_json::to_vec(&value).unwrap());
        assert_eq!(inspection.object_refs, Ok(vec![hash]));
        assert!(inspection.artifact_refs.is_ok());

        value["latest_fields"] = json!({"m": {"payload_ref": "runs/x/file"}});
        let inspection = inspect_live_snapshot(&serde_json::to_vec(&value).unwrap());
        assert!(inspection.object_refs.is_err());
        assert!(inspection.artifact_refs.is_ok());

        let mut local = snapshot();
        local["stage_execution"] = json!({"segments": [{
            "artifact_refs": ["artifacts/stage-000", "cp-common-state"],
            "checkpoint_ref": "cp-000042", "loaded_state_ref": null,
        }]});
        let inspection = inspect_live_snapshot(&serde_json::to_vec(&local).unwrap());
        assert_eq!(inspection.object_refs, Ok(vec![]));
        assert!(inspection.artifact_refs.is_ok());

        local["stage_execution"] = json!({"checkpoint_ref": {"nested": 1}});
        assert!(inspect_live_snapshot(&serde_json::to_vec(&local).unwrap())
            .object_refs.is_err());
    }

    #[test]
    fn artifact_entry_and_nested_provenance_keep_reference_key_semantics() {
        let nested_hash = "a".repeat(64);
        let entry_hash = "c".repeat(64);
        let mut value = snapshot();
        value["artifacts"][0]["payload_ref"] = Value::String(entry_hash.clone());
        value["artifacts"][0]["region_owned_provenance"] = json!({
            "nested": {"payload_refs": [nested_hash.clone()]}
        });

        let inspection = inspect_live_snapshot(&serde_json::to_vec(&value).unwrap());
        assert_eq!(
            inspection.object_refs,
            Ok(vec![nested_hash.clone(), entry_hash.clone()])
        );
        assert!(inspection.artifact_refs.is_ok());

        value["artifacts"][0]["payload_ref"] = Value::String("runs/foreign".to_string());
        let inspection = inspect_live_snapshot(&serde_json::to_vec(&value).unwrap());
        assert!(inspection.object_refs.is_err());
        assert!(inspection.artifact_refs.is_ok());

        value["artifacts"][0]["payload_ref"] = Value::String(entry_hash);
        value["artifacts"][0]["region_owned_provenance"]["nested"]["payload_ref"] =
            Value::String("runs/foreign".to_string());
        let inspection = inspect_live_snapshot(&serde_json::to_vec(&value).unwrap());
        assert!(inspection.object_refs.is_err());
        assert!(inspection.artifact_refs.is_ok());
    }

    #[test]
    fn live_snapshot_opaque_fields_do_not_hide_artifacts_and_malformed_entries_are_errors() {
        let mut value = snapshot();
        value["future_section"] = json!({});
        let inspection = inspect_live_snapshot(&serde_json::to_vec(&value).unwrap());
        assert!(inspection.object_refs.is_err());
        assert_eq!(
            inspection.artifact_refs.as_ref().unwrap().artifacts[0].path,
            "a.zarr"
        );

        let mut typed_path = snapshot();
        typed_path["artifacts"][0]["path"] =
            Value::String(format!("objects/sha256/{}", "b".repeat(64)));
        let typed_path_inspection =
            inspect_live_snapshot(&serde_json::to_vec(&typed_path).unwrap());
        assert_eq!(typed_path_inspection.object_refs, Ok(vec![]));
        assert!(typed_path_inspection.artifact_refs.is_ok());

        value["future_section"] = Value::Null;
        value["artifacts"] = json!([{"kind": "json"}]);
        let inspection = inspect_live_snapshot(&serde_json::to_vec(&value).unwrap());
        assert!(inspection.artifact_refs.is_err());

        assert!(inspect_live_snapshot(b"[]").object_refs.is_err());
        assert!(inspect_live_snapshot(b"[]").artifact_refs.is_err());
    }

}
