//! Typed reachability schemas for documents that used to be opaque to the
//! session/archive walkers.
//!
//! Two document families are covered:
//!
//! * backend restart payloads (`BackendStatePayload`) whose
//!   `integrator_state` carries a *known*, versioned checkpoint schema, and
//! * `project/current_live_snapshot.json`, the workspace snapshot written by
//!   the API (`PersistedCurrentLiveSnapshot`).
//!
//! Both are "inline" documents: their producers embed numeric state and
//! identity strings directly and never reference CAS objects or archive
//! members. The walkers therefore do not guess the meaning of hash-like
//! strings. Instead they (a) require a recognised schema or top-level shape
//! and (b) prove that no reference-bearing key (`ref`, `*_ref`, `*_refs`) or
//! CAS path string (`objects/...`) is hiding inside. Anything else stays
//! untyped and keeps the graph incomplete (fail closed).

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
/// which is returned for retention; any other reference is untyped.
fn scan_inline(root: &Value, allow_object_refs: bool) -> Result<Vec<String>, String> {
    let mut objects = Vec::new();
    let mut stack = vec![root];
    while let Some(value) = stack.pop() {
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
                    stack.push(child);
                }
            }
            Value::Array(items) => stack.extend(items.iter()),
            Value::String(text) => {
                if text.starts_with("objects/") {
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

/// Classify `project/current_live_snapshot.json`.
pub(crate) fn inspect_live_snapshot(data: &[u8]) -> TypedInspection {
    let value: Value = match serde_json::from_slice(data) {
        Ok(value) => value,
        Err(error) => return untyped_snapshot(&format!("not valid JSON: {error}")),
    };
    let Some(map) = value.as_object() else {
        return untyped_snapshot("root is not an object");
    };
    if let Some(key) = map
        .keys()
        .find(|key| !SNAPSHOT_KEYS.contains(&key.as_str()))
    {
        return untyped_snapshot(&format!("unknown top-level key `{key}`"));
    }
    if let Some(key) = SNAPSHOT_REQUIRED_KEYS
        .iter()
        .find(|key| !map.contains_key(**key))
    {
        return untyped_snapshot(&format!("missing top-level key `{key}`"));
    }
    match scan_inline(&value, true) {
        Ok(object_refs) => TypedInspection::Typed { object_refs },
        Err(reason) => untyped_snapshot(&reason),
    }
}

fn untyped_snapshot(reason: &str) -> TypedInspection {
    TypedInspection::Untyped(format!("untyped live snapshot ({reason})"))
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
            "session": {}, "runtime_status": {}, "artifacts": [{"path": "a.zarr", "kind": "x"}],
            "display_selection": {}, "preview_config": {},
            "mesh_revision": 1, "mesh_build_revision": 1,
            "latest_fields": {"m": {"topology_hash": "a".repeat(64)}}
        })
    }

    #[test]
    fn live_snapshot_without_references_is_typed() {
        let bytes = serde_json::to_vec(&snapshot()).unwrap();
        assert_eq!(
            inspect_live_snapshot(&bytes),
            TypedInspection::Typed { object_refs: vec![] }
        );
    }

    #[test]
    fn live_snapshot_object_refs_are_retained_and_bad_refs_rejected() {
        let hash = "b".repeat(64);
        let mut value = snapshot();
        value["latest_fields"] = json!({"m": {"payload_ref": hash, "chunks_refs": [hash, null]}});
        let bytes = serde_json::to_vec(&value).unwrap();
        assert_eq!(
            inspect_live_snapshot(&bytes),
            TypedInspection::Typed {
                object_refs: vec![hash]
            }
        );
        value["latest_fields"] = json!({"m": {"payload_ref": "runs/x/file"}});
        assert!(matches!(
            inspect_live_snapshot(&serde_json::to_vec(&value).unwrap()),
            TypedInspection::Untyped(_)
        ));
        let mut local = snapshot();
        local["stage_execution"] = json!({"segments": [{
            "artifact_refs": ["artifacts/stage-000", "cp-common-state"],
            "checkpoint_ref": "cp-000042", "loaded_state_ref": null,
        }]});
        assert_eq!(
            inspect_live_snapshot(&serde_json::to_vec(&local).unwrap()),
            TypedInspection::Typed { object_refs: vec![] }
        );
        local["stage_execution"] = json!({"checkpoint_ref": {"nested": 1}});
        assert!(matches!(
            inspect_live_snapshot(&serde_json::to_vec(&local).unwrap()),
            TypedInspection::Untyped(_)
        ));
        let mut unknown = snapshot();
        unknown["future_section"] = json!({});
        assert!(matches!(
            inspect_live_snapshot(&serde_json::to_vec(&unknown).unwrap()),
            TypedInspection::Untyped(_)
        ));
        assert!(matches!(
            inspect_live_snapshot(b"[]"),
            TypedInspection::Untyped(_)
        ));
    }
}
