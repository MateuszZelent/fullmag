//! Typed reachability schemas for documents that used to be opaque to the
//! session/archive walkers.
//!
//! Two persisted-document families have distinct reachability contracts:
//!
//! * known backend restart payloads whose `integrator_state` is a self-contained
//!   versioned checkpoint schema, and
//! * `project/current_live_snapshot.json`, whose CAS references are scanned
//!   independently from its typed run-scoped `artifacts[].path` entries and
//!   declared scene.v1/v2 material and magnetization asset ids.
//!
//! The scanner does not guess hash-like strings. Unknown or hidden references
//! keep the graph incomplete, while the independent artifact projection makes
//! sure opaque inline fields cannot hide missing run files from reachability.
use crate::types::BackendStatePayload;
use serde_json::Value;
use std::collections::BTreeSet;

/// Known checkpoint schemas; v2 declares an explicit committed-output CAS edge.
const COUPLED_M3_SCHEMA: &str = "fullmag.fdm.coupled_m3_checkpoint.v1";
const COMPOSITE_M3_SCHEMA: &str = "fullmag.fdm.coupled_m3_checkpoint.v2";
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
/// Declared scene asset foreign keys are validated and removed from a private
/// clone before this generic scanner runs, so identically named unknown fields
/// continue to use ordinary CAS rules.
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
        COUPLED_M3_SCHEMA | COMPOSITE_M3_SCHEMA => Some(&["coupled_imex_ark2"]),
        FROZEN_SPINS_SCHEMA => Some(&["frozen_spins"]),
        _ => None,
    }
}

/// Classify a backend restart payload. A payload is typed only when its
/// `integrator_state` declares a known checkpoint schema, the envelope metadata
/// agrees with it, `extra` carries only the schema marker and all storage edges
/// are declared. This classifies CAS closure, never solver/ExactResume admission.
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
    if schema == COMPOSITE_M3_SCHEMA {
        return match composite_checkpoint_storage_projection(payload) {
            Ok(Some(projection)) => TypedInspection::Typed {
                object_refs: projection.manifest.into_iter().map(|binding| binding.object_ref).collect(),
            },
            Ok(None) => untyped_backend("missing composite storage projection"),
            Err(reason) => untyped_backend(&reason),
        };
    }
    match scan_inline(state, false) {
        Ok(_) => TypedInspection::Typed {
            object_refs: Vec::new(),
        },
        Err(reason) => untyped_backend(&reason),
    }
}

/// Storage-only projection; numerical/codec admission remains with the runner.
#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CompositeManifestBinding {
    pub catalog_revision: u64,
    pub artifact_id: String,
    pub object_ref: String,
    pub content_sha256: String,
}

pub(crate) struct CompositeCheckpointStorageProjection {
    pub run_id: String,
    pub stage_id: String,
    pub accepted_state: fullmag_quantities::AcceptedStateRef,
    pub manifest: Option<CompositeManifestBinding>,
}

/// Identify only declared storage edges, never arbitrary hash-like state strings.
pub(crate) fn composite_checkpoint_storage_projection(
    payload: &BackendStatePayload,
) -> Result<Option<CompositeCheckpointStorageProjection>, String> {
    let Some(state) = payload.integrator_state.as_ref()
        .filter(|state| state.get("schema").and_then(Value::as_str) == Some(COMPOSITE_M3_SCHEMA))
    else { return Ok(None); };
    let keys = ["schema", "payload_sha256", "coupled", "frozen_spins",
        "frozen_activation_set", "stage_frame", "accepted_frame", "output_frame"];
    let object = state.as_object().ok_or("composite state must be an object")?;
    if object.len() != keys.len() || keys.iter().any(|key| !object.contains_key(*key))
        || !state.get("payload_sha256").and_then(Value::as_str).is_some_and(is_object_ref)
        || state.pointer("/coupled/schema").and_then(Value::as_str) != Some(COUPLED_M3_SCHEMA)
        || !state["frozen_activation_set"].is_object()
        || (!state["frozen_spins"].is_null()
            && state.pointer("/frozen_spins/schema").and_then(Value::as_str) != Some(FROZEN_SPINS_SCHEMA)) {
        return Err("incomplete or unknown composite checkpoint storage shape".into());
    }
    let run_id = state.pointer("/stage_frame/run_id").and_then(Value::as_str)
        .ok_or("composite stage run identity is missing")?.to_string();
    let stage_id = state.pointer("/stage_frame/stage_id").and_then(Value::as_str)
        .ok_or("composite stage identity is missing")?.to_string();
    crate::repository_path::validate_store_id(&run_id).map_err(|error| error.to_string())?;
    crate::types::validate_study_step_id(&stage_id).map_err(|error| error.to_string())?;
    let accepted_state: fullmag_quantities::AcceptedStateRef = serde_json::from_value(
        state.pointer("/accepted_frame/state_ref").ok_or("composite accepted state is missing")?.clone()
    ).map_err(|error| error.to_string())?;
    accepted_state.validate().map_err(|error| error.to_string())?;
    if accepted_state.id.run_id != run_id || accepted_state.id.stage_id.as_deref() != Some(stage_id.as_str()) {
        return Err("composite accepted state and stage identity differ".into());
    }
    let output = state.get("output_frame").and_then(Value::as_object)
        .ok_or("composite output frame must be an object")?;
    let initial = output.get("initial_sample_committed").and_then(Value::as_bool)
        .ok_or("composite initial sample marker must be a boolean")?;
    let final_sample = output.get("final_sample_committed").and_then(Value::as_bool)
        .ok_or("composite final sample marker must be a boolean")?;
    let sampled = |value: Option<&Value>| -> Result<bool, String> {
        let value = value.ok_or("composite sampled-time marker must be present, including explicit null")?;
        if !value.is_null() && !value.as_f64().is_some_and(f64::is_finite) {
            return Err("composite sampled-time marker must be null or a finite number".into());
        }
        Ok(!value.is_null())
    };
    let default_sample = sampled(output.get("default_scalar_last_sampled_time_s"))?;
    let mut scheduled_sample = false;
    for collection in ["scalar_schedules", "field_schedules"] {
        let cursors = output.get(collection).and_then(Value::as_array)
            .ok_or("composite output schedules must be arrays")?;
        for cursor in cursors {
            // Evaluate every marker even after one schedule has committed a sample.
            let present = sampled(cursor.get("last_sampled_time"))?;
            scheduled_sample |= present;
        }
    }
    // Same declared-edge presence rule as the runner codec; no time/phase validation here.
    let has_samples = initial || final_sample || default_sample || scheduled_sample;
    let binding = output.get("committed_manifest")
        .ok_or("composite committed_manifest must be present, including explicit null")?;
    if binding.is_null() == has_samples {
        return Err("composite committed samples and manifest edge presence differ".into());
    }
    let manifest = if binding.is_null() { None } else {
        let binding: CompositeManifestBinding = serde_json::from_value(binding.clone())
            .map_err(|error| error.to_string())?;
        crate::repository_path::validate_store_id(&binding.artifact_id).map_err(|error| error.to_string())?;
        if binding.catalog_revision == 0 || !is_object_ref(&binding.object_ref)
            || binding.object_ref != binding.content_sha256 {
            return Err("invalid composite output manifest CAS binding".into());
        }
        Some(binding)
    };
    // These are the only two typed exceptions: a semantic identity and one CAS edge.
    // Every other reference-bearing key still makes the graph opaque.
    let mut inline = state.clone();
    *inline.pointer_mut("/accepted_frame/state_ref").ok_or("missing accepted state projection")? = Value::Null;
    *inline.pointer_mut("/output_frame/committed_manifest").ok_or("missing manifest projection")? = Value::Null;
    scan_inline(&inline, false)?;
    Ok(Some(CompositeCheckpointStorageProjection { run_id, stage_id, accepted_state, manifest }))
}

/// Reuse session manifest/catalog validators and their existing attempt lineage.
/// This proves storage ownership/closure only, not prefix coverage or ExactResume.
pub(crate) fn composite_manifest_object_refs(
    projection: &CompositeCheckpointStorageProjection,
    checkpoint: &crate::types::FmsCheckpoint,
    catalog: &crate::types::FmsArtifactCatalog,
    manifest: &crate::types::FmsStudyOutputManifest,
) -> anyhow::Result<Vec<String>> {
    use anyhow::{bail, Context};
    use crate::types::{FmsArtifactStatus, FmsStudyArtifactOutput};
    let binding = projection.manifest.as_ref().context("missing composite manifest binding")?;
    catalog.validate()?;
    manifest.validate()?;
    if checkpoint.run_id != projection.run_id || catalog.run_id != projection.run_id
        || manifest.run_id != projection.run_id || manifest.step_id != projection.stage_id
        || catalog.revision < binding.catalog_revision
        || manifest.accepted_state_ref.as_ref() != Some(&projection.accepted_state)
        || projection.accepted_state.id.accepted_step != checkpoint.step {
        bail!("composite checkpoint output manifest/catalog identity differs");
    }
    let owned_entry = |artifact_id: &str, object_ref: &str, artifact_type: &str,
                       output: Option<&FmsStudyArtifactOutput>| -> anyhow::Result<()> {
        let entry = catalog.entries.iter().find(|entry| entry.artifact_id == artifact_id)
            .context("composite manifest artifact is absent from its catalog")?;
        if entry.task_id != manifest.task_id || entry.attempt_id != manifest.attempt_id
            || entry.ownership_epoch != manifest.ownership_epoch
            || entry.status != FmsArtifactStatus::Published || entry.artifact_type != artifact_type
            || entry.object_ref.as_deref() != Some(object_ref) || entry.content_sha256 != object_ref
            || entry.study_output.as_ref() != output {
            bail!("composite output differs from its published attempt/catalog entry");
        }
        Ok(())
    };
    owned_entry(&binding.artifact_id, &binding.object_ref, "study_output_manifest", None)?;
    let mut refs = vec![binding.object_ref.clone()];
    for output in &manifest.outputs {
        let identity = FmsStudyArtifactOutput { step_id: manifest.step_id.clone(),
            port_id: output.port_id.clone(), case_id: output.case_id.clone() };
        owned_entry(&output.artifact_id, &output.object_ref, &output.data_kind, Some(&identity))?;
        refs.push(output.object_ref.clone());
    }
    if let Some(source) = &manifest.observation_source {
        owned_entry(&source.snapshot_artifact_id, &source.snapshot_object_ref,
            crate::types::FMS_OBSERVATION_SNAPSHOT_ARTIFACT_TYPE, None)?;
        owned_entry(&source.state_artifact_id, &source.state_object_ref,
            crate::types::FMS_OBSERVATION_STATE_ARTIFACT_TYPE, None)?;
        refs.extend([source.snapshot_object_ref.clone(), source.state_object_ref.clone()]);
    }
    refs.sort(); refs.dedup();
    Ok(refs)
}

/// A streaming duplicate-key gate; numerical arrays are consumed without an
/// additional whole-field Value allocation. Used only by the new wire family.
fn require_unique_storage_json(bytes: &[u8]) -> Result<(), String> {
    struct Unique;
    impl<'de> serde::Deserialize<'de> for Unique {
        fn deserialize<D: serde::Deserializer<'de>>(decoder: D) -> Result<Self, D::Error> {
            struct Visitor;
            impl<'de> serde::de::Visitor<'de> for Visitor {
                type Value = Unique;
                fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str("unambiguous JSON") }
                fn visit_bool<E: serde::de::Error>(self, _: bool) -> Result<Unique, E> { Ok(Unique) }
                fn visit_i64<E: serde::de::Error>(self, _: i64) -> Result<Unique, E> { Ok(Unique) }
                fn visit_u64<E: serde::de::Error>(self, _: u64) -> Result<Unique, E> { Ok(Unique) }
                fn visit_f64<E: serde::de::Error>(self, _: f64) -> Result<Unique, E> { Ok(Unique) }
                fn visit_str<E: serde::de::Error>(self, _: &str) -> Result<Unique, E> { Ok(Unique) }
                fn visit_none<E: serde::de::Error>(self) -> Result<Unique, E> { Ok(Unique) }
                fn visit_unit<E: serde::de::Error>(self) -> Result<Unique, E> { Ok(Unique) }
                fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<Unique, A::Error> {
                    while seq.next_element::<Unique>()?.is_some() {} Ok(Unique)
                }
                fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<Unique, A::Error> {
                    let mut keys = BTreeSet::new();
                    while let Some(key) = map.next_key::<String>()? {
                        if !keys.insert(key) { return Err(serde::de::Error::custom("duplicate storage JSON key")); }
                        map.next_value::<Unique>()?;
                    }
                    Ok(Unique)
                }
            }
            decoder.deserialize_any(Visitor)
        }
    }
    let mut decoder = serde_json::Deserializer::from_slice(bytes);
    <Unique as serde::Deserialize>::deserialize(&mut decoder).map_err(|error| error.to_string())?;
    decoder.end().map_err(|error| error.to_string())
}

/// Inspect large inline preimages without allocating a second dense numerical
/// Value tree. Typed constraint identities remain labels, not inferred CAS refs.
fn require_inline_storage_json(bytes: &[u8]) -> Result<(), String> {
    require_unique_storage_json(bytes)?;
    struct Inline;
    impl<'de> serde::Deserialize<'de> for Inline {
        fn deserialize<D: serde::Deserializer<'de>>(decoder: D) -> Result<Self, D::Error> {
            struct Visitor;
            impl<'de> serde::de::Visitor<'de> for Visitor {
                type Value = Inline;
                fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str("inline JSON without undeclared storage references") }
                fn visit_bool<E: serde::de::Error>(self, _: bool) -> Result<Inline,E> { Ok(Inline) }
                fn visit_i64<E: serde::de::Error>(self, _: i64) -> Result<Inline,E> { Ok(Inline) }
                fn visit_u64<E: serde::de::Error>(self, _: u64) -> Result<Inline,E> { Ok(Inline) }
                fn visit_f64<E: serde::de::Error>(self, _: f64) -> Result<Inline,E> { Ok(Inline) }
                fn visit_unit<E: serde::de::Error>(self) -> Result<Inline,E> { Ok(Inline) }
                fn visit_none<E: serde::de::Error>(self) -> Result<Inline,E> { Ok(Inline) }
                fn visit_str<E: serde::de::Error>(self, text: &str) -> Result<Inline,E> {
                    if text.starts_with("objects/") { return Err(E::custom("undeclared CAS path in inline preimage")); } Ok(Inline)
                }
                fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<Inline,A::Error> {
                    while seq.next_element::<Inline>()?.is_some() {} Ok(Inline)
                }
                fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<Inline,A::Error> {
                    let mut keys = BTreeSet::new();
                    while let Some(key) = map.next_key::<String>()? {
                        if !keys.insert(key.clone()) { return Err(serde::de::Error::custom("duplicate inline JSON key")); }
                        match key.as_str() {
                            "constraint_activation_epochs" => { map.next_value::<std::collections::BTreeMap<String,u64>>()?; }
                            "constraint_ids" | "active_constraint_ids" => { map.next_value::<Vec<String>>()?; }
                            "authored_fingerprints" => { map.next_value::<Vec<fullmag_ir::SelectionAuthoredFingerprintIR>>()?; }
                            _ if is_reference_key(&key) => { map.next_value::<()>()?; }
                            _ => { map.next_value::<Inline>()?; }
                        }
                    }
                    Ok(Inline)
                }
            }
            decoder.deserialize_any(Visitor)
        }
    }
    let mut decoder = serde_json::Deserializer::from_slice(bytes);
    <Inline as serde::Deserialize>::deserialize(&mut decoder).map_err(|error| error.to_string())?;
    decoder.end().map_err(|error| error.to_string())
}

fn require_numeric_storage_json(bytes: &[u8]) -> Result<(), String> {
    struct Numeric;
    impl<'de> serde::Deserialize<'de> for Numeric {
        fn deserialize<D: serde::Deserializer<'de>>(decoder: D) -> Result<Self, D::Error> {
            struct Visitor;
            impl<'de> serde::de::Visitor<'de> for Visitor {
                type Value = Numeric;
                fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str("finite numbers or numeric arrays") }
                fn visit_i64<E: serde::de::Error>(self, _: i64) -> Result<Numeric, E> { Ok(Numeric) }
                fn visit_u64<E: serde::de::Error>(self, _: u64) -> Result<Numeric, E> { Ok(Numeric) }
                fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<Numeric, E> {
                    if !value.is_finite() { return Err(E::custom("nonfinite numerical leaf")); } Ok(Numeric)
                }
                fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<Numeric, A::Error> {
                    while seq.next_element::<Numeric>()?.is_some() {} Ok(Numeric)
                }
            }
            decoder.deserialize_any(Visitor)
        }
    }
    let mut decoder = serde_json::Deserializer::from_slice(bytes);
    <Numeric as serde::Deserialize>::deserialize(&mut decoder).map_err(|error| error.to_string())?;
    decoder.end().map_err(|error| error.to_string())
}

/// Storage closure only; canonical quantity/shape/clock decoding stays above session.
pub(crate) fn inspect_output_history_leaf(codec: &str, bytes: &[u8], budget: u64) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() as u64 > budget { return Err("history leaf exceeds its bounded decode budget".into()); }
    match codec {
        "fullmag.runner.scalar_csv_row" => {
            if bytes.len() > 4096 || !bytes.ends_with(b"\n") || bytes[..bytes.len()-1].contains(&b'\n') || bytes.contains(&b'\r') {
                return Err("history CSV leaf is not one bounded scalar row".into());
            }
            let row = std::str::from_utf8(&bytes[..bytes.len()-1]).map_err(|error| error.to_string())?;
            let values: Vec<&str> = row.split(',').collect();
            if values.len() != 19 || values[0].parse::<u64>().is_err()
                || values.iter().skip(1).any(|value| value.parse::<f64>().map_or(true, |value| !value.is_finite())) {
                return Err("history CSV leaf carries undeclared nonnumeric data".into());
            }
            Ok(())
        }
        "fullmag.runner.field_snapshot_json" => {
            require_unique_storage_json(bytes)?;
            #[derive(serde::Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Frame<'a> {
                observable: String, unit: String, step: u64, time: f64, solver_dt: f64,
                component_count: u8, component_order: String, location: String, scope: String,
                revision: u64, layout: Value, provenance: Value,
                #[serde(borrow)] values: &'a serde_json::value::RawValue,
            }
            let frame: Frame<'_> = serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
            let metadata = serde_json::json!({"observable":frame.observable,"unit":frame.unit,"step":frame.step,
                "time":frame.time,"solver_dt":frame.solver_dt,"component_count":frame.component_count,
                "component_order":frame.component_order,"location":frame.location,"scope":frame.scope,
                "revision":frame.revision,"layout":frame.layout,"provenance":frame.provenance});
            scan_inline(&metadata, false)?;
            require_numeric_storage_json(frame.values.get().as_bytes())
        }
        _ => Err("unknown output history leaf codec".into()),
    }
}

fn closed_storage_keys(value: &Value, required: &[&str], optional: &[&str]) -> Result<(), String> {
    let object = value.as_object().ok_or("storage child must be an object")?;
    if required.iter().any(|key| !object.contains_key(*key))
        || object.keys().any(|key| !required.contains(&key.as_str()) && !optional.contains(&key.as_str()))
    { return Err("storage child keys differ from the declared codec".into()); }
    Ok(())
}

/// Strict storage-only inspection of the explicit frozen state-output codec.
/// Numerical admission stays with the runner; this proves no hidden CAS edges.
pub(crate) fn inspect_frozen_state_output(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() as u64 > MAX_FROZEN_OUTPUT_BYTES {
        return Err("frozen state output exceeds the bounded decode budget".into());
    }
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Envelope {
        schema_version: String,
        state: Value,
        #[serde(deserialize_with = "required_storage_nullable")]
        frozen_spins: Option<Value>,
        frozen_activation_set: ActivationSet,
    }
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct ActivationSet {
        resolved_constraint_set_revision: u64,
        constraint_activation_epochs: std::collections::BTreeMap<String, u64>,
        active_constraint_ids: BTreeSet<String>,
    }
    require_unique_storage_json(bytes)?;
    let envelope: Envelope = serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
    closed_storage_keys(&envelope.state,
        &["observable", "unit", "step", "time", "solver_dt", "layout", "provenance", "state_identity", "values"],
        &["native_state_snapshot", "native_node_map"])?;

    let set = &envelope.frozen_activation_set;
    if envelope.schema_version != "fullmag.frozen_state_output.v1"
        || !envelope.state.is_object()
        || set.constraint_activation_epochs.iter().any(|(id, epoch)| id.trim().is_empty() || *epoch == 0)
        || set.active_constraint_ids.iter().any(|id| !set.constraint_activation_epochs.contains_key(id))
        || (set.resolved_constraint_set_revision == 0 && !set.constraint_activation_epochs.is_empty())
    { return Err("invalid frozen state-output storage shape".into()); }
    if let Some(child) = &envelope.frozen_spins {
        closed_storage_keys(child, &["schema", "constraint_ids", "authored_fingerprints", "activation",
            "constraint_activation_epochs", "active_constraint_ids", "resolved_constraint_set_revision",
            "mask_len", "mask_bits", "mask_sha256", "reference", "reference_sha256", "active_dof_count",
            "frozen_dof_count", "free_dof_count", "backend", "device", "precision", "step", "time_s", "dt", "magnetization"],
            &["problem_sha256"])?;
        if child.get("schema").and_then(Value::as_str) != Some(FROZEN_SPINS_SCHEMA)
            || child.get("constraint_activation_epochs") != Some(&serde_json::to_value(&set.constraint_activation_epochs).map_err(|e| e.to_string())?)
            || child.get("active_constraint_ids") != Some(&serde_json::to_value(&set.active_constraint_ids).map_err(|e| e.to_string())?)
            || child.get("resolved_constraint_set_revision").and_then(Value::as_u64) != Some(set.resolved_constraint_set_revision)
        { return Err("frozen state-output child lost its declared activation history".into()); }
        for (key, value) in child.as_object().ok_or("frozen child is not an object")? {
            match key.as_str() {
                "constraint_activation_epochs" => {
                    if value.as_object().is_none_or(|map| map.values().any(|epoch| epoch.as_u64().is_none())) {
                        return Err("frozen child epoch labels do not have typed integer values".into());
                    }
                }
                "constraint_ids" | "active_constraint_ids" => {
                    if value.as_array().is_none_or(|ids| ids.iter().any(|id| !id.is_string())) {
                        return Err("frozen child constraint ids are not typed labels".into());
                    }
                }
                "authored_fingerprints" => { check_type::<Vec<fullmag_ir::SelectionAuthoredFingerprintIR>>(value)?; }
                _ => { scan_inline(value, false)?; }
            }
        }
    } else if !set.active_constraint_ids.is_empty() {
        return Err("active frozen output has no reference child".into());
    }
    scan_inline(&envelope.state, false)?;
    Ok(())
}

fn required_storage_nullable<'de, D: serde::Deserializer<'de>>(deserializer: D)
    -> Result<Option<Value>, D::Error>
{
    <Option<Value> as serde::Deserialize>::deserialize(deserializer)
}

pub(crate) const MAX_FROZEN_OUTPUT_BYTES: u64 = 64 * 1024 * 1024;

/// Read common output bindings under the original manifest version. New V4
/// observation/history closure must be traversed separately, never erased.
pub(crate) fn read_study_manifest_projection(bytes: &[u8])
    -> anyhow::Result<crate::types::FmsStudyOutputManifest>
{
    anyhow::ensure!(bytes.len() as u64 <= crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES as u64,
        "study output manifest exceeds metadata budget");
    let header: Value = serde_json::from_slice(bytes)?;
    if header.get("schema_version").and_then(Value::as_str)
        == Some(crate::types::FMS_STUDY_OUTPUT_MANIFEST_SCHEMA_V4)
    {
        anyhow::ensure!(bytes.len() as u64 <= crate::types::MAX_OUTPUT_HISTORY_METADATA_BYTES, "terminal manifest exceeds metadata budget");
        let manifest: crate::types::FmsStudyOutputManifestV4 = serde_json::from_slice(bytes)?;
        manifest.validate()?;
        return Ok(manifest.output_projection());
    }
    let manifest: crate::types::FmsStudyOutputManifest = serde_json::from_slice(bytes)?;
    manifest.validate()?;
    Ok(manifest)
}

/// Consume explicit codec bindings only; an arbitrary state blob is not inline.
pub(crate) fn inspect_published_frozen_outputs(
    manifest_bytes: &[u8],
    manifest_entry: &crate::types::FmsArtifactCatalogEntry,
    catalog: &crate::types::FmsArtifactCatalog,
    mut read: impl FnMut(&str, u64) -> anyhow::Result<Vec<u8>>,
) -> anyhow::Result<BTreeSet<String>> {
    use crate::types::{FmsArtifactStatus, FmsStudyArtifactOutput};
    use anyhow::{bail, Context};
    let manifest = read_study_manifest_projection(manifest_bytes)?;
    if manifest.run_id != catalog.run_id || manifest_entry.task_id != manifest.task_id
        || manifest_entry.attempt_id != manifest.attempt_id
        || manifest_entry.ownership_epoch != manifest.ownership_epoch
        || manifest_entry.status != FmsArtifactStatus::Published
    { bail!("study output manifest differs from its published catalog owner"); }
    let mut verified=BTreeSet::new();
    for output in &manifest.outputs {
        if output.codec_id != "fullmag.runner.frozen_state_json" { continue; }
        if output.codec_version != "v1" || !matches!(output.data_kind.as_str(), "state" | "initial_state") {
            bail!("unregistered frozen state-output tuple");
        }
        let identity = FmsStudyArtifactOutput { step_id: manifest.step_id.clone(),
            port_id: output.port_id.clone(), case_id: output.case_id.clone() };
        let entry = catalog.entries.iter().find(|entry| entry.artifact_id == output.artifact_id)
            .context("frozen state output is absent from its catalog")?;
        if entry.task_id != manifest.task_id || entry.attempt_id != manifest.attempt_id
            || entry.ownership_epoch != manifest.ownership_epoch
            || entry.status != FmsArtifactStatus::Published || entry.artifact_type != output.data_kind
            || entry.object_ref.as_deref() != Some(output.object_ref.as_str())
            || entry.content_sha256 != output.content_sha256 || output.content_sha256 != output.object_ref
            || entry.study_output.as_ref() != Some(&identity)
        { bail!("frozen state-output binding differs from its published owner"); }
        let bytes = read(&output.object_ref, MAX_FROZEN_OUTPUT_BYTES)?;
        anyhow::ensure!(crate::cas::hex_sha256(&bytes) == output.object_ref, "frozen output CAS hash differs");
        inspect_frozen_state_output(&bytes).map_err(anyhow::Error::msg)?;
        verified.insert(output.artifact_id.clone());
    }
    Ok(verified)
}



/// Admission retains the exact prepared lifecycle, not a reconstructed epoch
/// map. This storage gate checks its complete inline CAS shape only.
pub(crate) fn inspect_admitted_frozen_context(binding: &Value, bytes: &[u8]) -> anyhow::Result<()> {
    use anyhow::{ensure, Context};
    crate::types::validate_frozen_stage_context_ref(binding)?;
    let count = binding.get("context_byte_count").and_then(Value::as_u64).context("missing context byte count")?;
    ensure!(count <= MAX_FROZEN_OUTPUT_BYTES && bytes.len() as u64 == count
        && binding.get("context_sha256").and_then(Value::as_str) == Some(crate::cas::hex_sha256(bytes).as_str()),
        "admitted frozen context raw identity differs or exceeds budget");
    require_inline_storage_json(bytes).map_err(anyhow::Error::msg)?;
    let context: Value = serde_json::from_slice(bytes)?;
    closed_storage_keys(&context, &["schema_version", "entry_kind", "previous_activation_set",
        "prepared_activation_set", "previous_frozen_child", "source_stage_id", "target_stage_id"], &[])
        .map_err(anyhow::Error::msg)?;
    ensure!(context.get("schema_version").and_then(Value::as_str) == Some("frozen_stage_context.v1")
        && context.get("entry_kind") == binding.get("entry_kind")
        && context.get("target_stage_id") == binding.get("stage_id"), "admitted lifecycle identity differs");
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Activation {
        resolved_constraint_set_revision: u64,
        constraint_activation_epochs: std::collections::BTreeMap<String,u64>,
        active_constraint_ids: BTreeSet<String>,
    }
    let read_set = |key: &str| -> anyhow::Result<Activation> {
        let set: Activation = serde_json::from_value(context.get(key).context("missing full activation set")?.clone())?;
        ensure!(set.constraint_activation_epochs.iter().all(|(id,epoch)| !id.trim().is_empty() && *epoch > 0)
            && set.active_constraint_ids.iter().all(|id| set.constraint_activation_epochs.contains_key(id))
            && (set.resolved_constraint_set_revision > 0 || (set.constraint_activation_epochs.is_empty() && set.active_constraint_ids.is_empty())),
            "invalid full activation history in admitted lifecycle");
        Ok(set)
    };
    let previous = read_set("previous_activation_set")?; let prepared = read_set("prepared_activation_set")?;
    ensure!(prepared.resolved_constraint_set_revision >= previous.resolved_constraint_set_revision
        && previous.constraint_activation_epochs.iter().all(|(id,epoch)| prepared.constraint_activation_epochs.get(id).is_some_and(|next| next >= epoch)),
        "admitted lifecycle lost historical activations");
    let source = context.get("source_stage_id").context("missing nullable source stage")?;
    let child = context.get("previous_frozen_child").context("missing nullable frozen reference child")?;
    if binding.get("entry_kind").and_then(Value::as_str) == Some("fresh_authored_root") {
        ensure!(source.is_null() && child.is_null() && previous.resolved_constraint_set_revision == 0
            && previous.constraint_activation_epochs.is_empty() && previous.active_constraint_ids.is_empty(),
            "fresh lifecycle fabricated historical state");
    } else {
        let source = source.as_str().context("continued lifecycle has no source stage")?;
        crate::types::validate_study_step_id(source)?;
    }
    if child.is_null() { ensure!(previous.active_constraint_ids.is_empty(), "active source lost its frozen child"); }
    else {
        ensure!(child.get("schema").and_then(Value::as_str) == Some(FROZEN_SPINS_SCHEMA)
            && child.get("constraint_activation_epochs") == context.get("previous_activation_set").and_then(|set|set.get("constraint_activation_epochs"))
            && child.get("active_constraint_ids") == context.get("previous_activation_set").and_then(|set|set.get("active_constraint_ids"))
            && child.get("resolved_constraint_set_revision").and_then(Value::as_u64) == Some(previous.resolved_constraint_set_revision),
            "source frozen child differs from its full historical activation set");
    }
    Ok(())
}

/// Complete declared V4 CAS closure. Numerical/physics admission belongs to the
/// runner adapter; storage validates every raw binding before retaining edges.
pub(crate) fn inspect_terminal_publication(
    bytes: &[u8], owner: &crate::types::FmsArtifactCatalogEntry,
    catalog: &crate::types::FmsArtifactCatalog,
    mut read: impl FnMut(&str, u64) -> anyhow::Result<Vec<u8>>,
) -> anyhow::Result<BTreeSet<String>> {
    use crate::types::*;
    use anyhow::{bail, ensure, Context};
    require_unique_storage_json(bytes).map_err(anyhow::Error::msg)?;
    let header: Value = serde_json::from_slice(bytes)?;
    if header.get("schema_version").and_then(Value::as_str) != Some(FMS_STUDY_OUTPUT_MANIFEST_SCHEMA_V4) {
        return Ok(BTreeSet::new());
    }
    ensure!(bytes.len() as u64 <= MAX_OUTPUT_HISTORY_METADATA_BYTES, "terminal manifest exceeds metadata budget");
    let manifest: FmsStudyOutputManifestV4 = serde_json::from_slice(bytes)?;
    manifest.validate()?;
    ensure!(manifest.run_id == catalog.run_id && owner.task_id == manifest.task_id
        && owner.attempt_id == manifest.attempt_id && owner.ownership_epoch == manifest.ownership_epoch
        && owner.artifact_type == "study_output_manifest" && owner.status == FmsArtifactStatus::Published,
        "terminal manifest differs from its catalog owner");
    let expected_id=|kind:&str,role:Value,reference:&str| terminal_publication_artifact_id(
        &manifest.run_id,&manifest.task_id,&manifest.attempt_id,manifest.ownership_epoch,kind,&role,reference);
    let mut refs = BTreeSet::new();
    let mut owned = |id: &str, reference: &str, kind: &str, output: Option<&FmsStudyArtifactOutput>| -> anyhow::Result<()> {
        let entry = catalog.entries.iter().find(|entry| entry.artifact_id == id)
            .context("terminal CAS edge is absent from its published catalog")?;
        ensure!(entry.task_id == manifest.task_id && entry.attempt_id == manifest.attempt_id
            && entry.ownership_epoch == manifest.ownership_epoch && entry.status == FmsArtifactStatus::Published
            && entry.artifact_type == kind && entry.object_ref.as_deref() == Some(reference)
            && entry.content_sha256 == reference && entry.study_output.as_ref() == output,
            "terminal CAS edge differs from its published owner");
        refs.insert(id.to_owned()); Ok(())
    };
    let manifest_ref = owner.object_ref.as_deref().context("terminal manifest has no object_ref")?;
    ensure!(crate::cas::hex_sha256(bytes) == manifest_ref && owner.content_sha256 == manifest_ref,
        "terminal manifest raw identity differs");
    ensure!(owner.artifact_id==expected_id("study_output_manifest",serde_json::json!({"manifest_schema":FMS_STUDY_OUTPUT_MANIFEST_SCHEMA_V4}),manifest_ref)?,
        "terminal manifest role identity differs");
    owned(&owner.artifact_id, manifest_ref, "study_output_manifest", None)?;
    for output in &manifest.outputs {
        let logical = FmsStudyArtifactOutput { step_id: manifest.step_id.clone(), port_id: output.port_id.clone(), case_id: output.case_id.clone() };
        let expected=format!("artifact-{}",crate::canonical_json_sha256(&serde_json::json!({
            "run_id":manifest.run_id,"task_id":manifest.task_id,"attempt_id":manifest.attempt_id,
            "ownership_epoch":manifest.ownership_epoch,"logical_output":logical,"data_kind":output.data_kind,
            "codec_id":output.codec_id,"codec_version":output.codec_version,"object_ref":output.object_ref})));
        ensure!(output.artifact_id==expected,"terminal logical output identity differs");
        owned(&output.artifact_id, &output.object_ref, &output.data_kind, Some(&logical))?;
        // Frozen envelopes are inspected by the explicit common codec reader.
    }
    let source = &manifest.observation_source;
    for (id, reference, kind) in [
        (&source.snapshot_artifact_id, &source.snapshot_object_ref, FMS_OBSERVATION_SNAPSHOT_ARTIFACT_TYPE),
        (&source.state_artifact_id, &source.state_object_ref, FMS_OBSERVATION_STATE_ARTIFACT_TYPE),
    ] {
        let role=if kind==FMS_OBSERVATION_SNAPSHOT_ARTIFACT_TYPE {
            serde_json::json!({"snapshot_schema":source.snapshot_schema_version})
        } else {serde_json::json!({"codec_id":source.state_codec_id})};
        ensure!(*id==expected_id(kind,role,reference)?,"terminal observation role identity differs");
        owned(id, reference, kind, None)?;
        let raw = read(reference, MAX_FROZEN_OUTPUT_BYTES)?;
        ensure!(crate::cas::hex_sha256(&raw) == *reference, "terminal observation raw hash differs");
        require_inline_storage_json(&raw).map_err(anyhow::Error::msg)?;
    }
    for carrier in &source.primary_carriers {
        ensure!(carrier.artifact_id==expected_id(FMS_ACCEPTED_PRIMARY_ARTIFACT_TYPE,serde_json::json!({"carrier_id":carrier.carrier_id}),&carrier.object_ref)?,"terminal primary role identity differs");
        owned(&carrier.artifact_id, &carrier.object_ref, FMS_ACCEPTED_PRIMARY_ARTIFACT_TYPE, None)?;
        ensure!(carrier.byte_count <= MAX_FROZEN_OUTPUT_BYTES, "terminal primary exceeds bounded decode budget");
        let raw = read(&carrier.object_ref, carrier.byte_count)?;
        ensure!(raw.len() as u64 == carrier.byte_count && crate::cas::hex_sha256(&raw) == carrier.object_ref,
            "terminal primary raw hash/count differs");
        require_inline_storage_json(&raw).map_err(anyhow::Error::msg)?;
    }
    for binding in &manifest.histories {
        ensure!(binding.artifact_id==expected_id(FMS_OUTPUT_HISTORY_INDEX_ARTIFACT_TYPE,serde_json::json!({"stream_id":binding.stream_id}),&binding.object_ref)?,"terminal history index role identity differs");
        owned(&binding.artifact_id, &binding.object_ref, FMS_OUTPUT_HISTORY_INDEX_ARTIFACT_TYPE, None)?;
        let raw = read(&binding.object_ref, binding.byte_count)?;
        ensure!(raw.len() as u64 == binding.byte_count && crate::cas::hex_sha256(&raw) == binding.object_ref,
            "terminal history index raw hash/count differs");
        require_unique_storage_json(&raw).map_err(anyhow::Error::msg)?;
        let index: FmsOutputHistoryIndex = serde_json::from_slice(&raw)?; index.validate()?;
        ensure!(index.stream_id == binding.stream_id, "terminal history stream differs from its index binding");
        let projections: Vec<_> = manifest.coverage.streams.iter().filter(|coverage| coverage.history_stream_id == index.stream_id).collect();
        ensure!(!projections.is_empty() && projections.iter().all(|coverage| coverage.sample_count <= index.sample_count),
            "terminal coverage has no matching history prefix");
        let mut clock: Option<(u64, f64)> = None;
        for page_binding in &index.pages {
            ensure!(page_binding.artifact_id==expected_id(FMS_OUTPUT_HISTORY_PAGE_ARTIFACT_TYPE,serde_json::json!({"stream_id":index.stream_id,"first_ordinal":page_binding.first_ordinal}),&page_binding.object_ref)?,"terminal history page role identity differs");
            owned(&page_binding.artifact_id, &page_binding.object_ref, FMS_OUTPUT_HISTORY_PAGE_ARTIFACT_TYPE, None)?;
            let raw = read(&page_binding.object_ref, page_binding.byte_count)?;
            ensure!(raw.len() as u64 == page_binding.byte_count && crate::cas::hex_sha256(&raw) == page_binding.object_ref,
                "terminal history page raw hash/count differs");
            require_unique_storage_json(&raw).map_err(anyhow::Error::msg)?;
            let page: FmsOutputHistoryPage = serde_json::from_slice(&raw)?; page.validate()?;
            ensure!(page.stream_id == index.stream_id && page.first_ordinal == page_binding.first_ordinal
                && page.samples.len() as u64 == page_binding.sample_count, "terminal history page differs from its index");
            for sample in &page.samples {
                if clock.is_some_and(|(step,time)| sample.step < step || sample.time_s < time) {
                    bail!("terminal history clock moves backwards");
                }
                clock = Some((sample.step,sample.time_s));
                let physical_stream=if sample.payload_codec_id=="fullmag.runner.scalar_csv_row" {"scalar-row"} else {index.stream_id.as_str()};
                ensure!(sample.artifact_id==expected_id(FMS_OUTPUT_HISTORY_SAMPLE_ARTIFACT_TYPE,serde_json::json!({"stream_id":physical_stream,"ordinal":sample.ordinal}),&sample.object_ref)?,"terminal physical sample role identity differs");
                owned(&sample.artifact_id, &sample.object_ref, FMS_OUTPUT_HISTORY_SAMPLE_ARTIFACT_TYPE, None)?;
                let max = if sample.payload_codec_id == "fullmag.runner.scalar_csv_row" { 4096 } else { MAX_FROZEN_OUTPUT_BYTES };
                ensure!(sample.byte_count <= max, "terminal history sample exceeds bounded decode budget");
                let raw = read(&sample.object_ref, sample.byte_count)?;
                ensure!(raw.len() as u64 == sample.byte_count && crate::cas::hex_sha256(&raw) == sample.object_ref,
                    "terminal history sample raw hash/count differs");
                inspect_output_history_leaf(&sample.payload_codec_id, &raw, max).map_err(anyhow::Error::msg)?;
            }
        }
    }
    Ok(refs)
}

fn untyped_backend(reason: &str) -> TypedInspection {
    TypedInspection::Untyped(format!("untyped backend restart state ({reason})"))
}

// Authored object/port/target identities are not storage references. Only the
// canonical authoring subtrees below receive this interpretation; opaque extras
// and every remaining snapshot value still pass through the strict CAS scanner.
fn mask_local_identity(value: &mut Value, key: &str) -> Result<(), String> {
    let Some(reference) = value.get_mut(key) else { return Ok(()); };
    if !reference.is_null() && !reference.as_str().is_some_and(|text| {
        text.len() <= 4096 && !text.contains('\0') && !text.starts_with("objects/")
    }) {
        return Err(format!("authored identity `{key}` is not an inline label"));
    }
    *reference = Value::Null;
    Ok(())
}

fn check_type<T: serde::de::DeserializeOwned>(value: &Value) -> Result<(), String> {
    serde_json::from_value::<T>(value.clone()).map(|_| ()).map_err(|error| error.to_string())
}

fn mask_antenna_definition(value: &mut Value) -> Result<(), String> {
    check_type::<fullmag_ir::AntennaFieldSolveStageIR>(value)?;
    mask_local_identity(value, "conservative_current_view_ref")?;
    // FieldTargetIR is a closed typed semantic selector, not an archive pointer.
    if let Some(targets) = value.get_mut("target_refs") {
        check_type::<Vec<fullmag_ir::FieldTargetIR>>(targets)?;
        scan_inline(targets, false)?;
        *targets = Value::Null;
    }
    Ok(())
}

fn mask_authored_document(value: &mut Value, scene: bool) -> Result<(), String> {
    // Scene asset foreign keys were validated before this projection. Inspect
    // only the declared antenna subtrees so legacy/partial scene documents and
    // typed visualization extensions retain their independent scanner contract.
    let document = value.as_object().ok_or("authoring document is not an object")?;
    for key in ["antenna_port_modes", "current_transports", "antenna_field_solve_stages",
        "solved_antenna_drives", "antenna_spectrum_requests"] {
        if document.get(key).is_some_and(|values| !values.is_array()) {
            return Err(format!("authoring collection `{key}` is not an array"));
        }
    }
    if let Some(ports) = value.get_mut("antenna_port_modes").and_then(Value::as_array_mut) {
        for port in ports {
            check_type::<fullmag_ir::AntennaPortModeIR>(port)?;
            if let Some(normalization) = port.get_mut("normalization").filter(|value| !value.is_null()) {
                mask_local_identity(normalization, "source_cut_ref")?;
            }
            if let Some(branches) = port.get_mut("branches").and_then(Value::as_array_mut) {
                for branch in branches {
                    mask_local_identity(branch, "inlet_terminal_ref")?;
                    mask_local_identity(branch, "outlet_terminal_ref")?;
                }
            }
        }
    }
    if let Some(transports) = value.get_mut("current_transports").and_then(Value::as_array_mut) {
        for transport in transports {
            for key in ["conservative_current_source", "external_lead_preparation"] {
                if let Some(source) = transport.get_mut(key).filter(|source| !source.is_null()) {
                    if key == "conservative_current_source" {
                        check_type::<fullmag_ir::ConservativeCurrentSourceIR>(source)?;
                    } else {
                        check_type::<fullmag_ir::ExternalLeadPreparationIR>(source)?;
                    }
                    if let Some(drives) = source.get_mut("drives").and_then(Value::as_array_mut) {
                        for drive in drives { mask_local_identity(drive, "port_mode_ref")?; }
                    }
                }
            }
        }
    }
    if let Some(stages) = value.get_mut("antenna_field_solve_stages").and_then(Value::as_array_mut) {
        for stage in stages { mask_antenna_definition(stage)?; }
    }
    let stages = if scene { value.pointer_mut("/study/stages") } else { value.get_mut("stages") };
    if let Some(stages) = stages.and_then(Value::as_array_mut) {
        for stage in stages {
            if stage.get("kind").and_then(Value::as_str) == Some("antenna_field_solve") {
                if let Some(definition) = stage.get_mut("definition") {
                    mask_antenna_definition(definition)?;
                }
            }
        }
    }
    // These collections have closed IR shapes. Reference-bearing fields are
    // interpreted only at their declared semantic positions.
    if let Some(drives) = value.get_mut("solved_antenna_drives").and_then(Value::as_array_mut) {
        for drive in drives {
            check_type::<fullmag_ir::SolvedAntennaDriveIR>(drive)?;
            mask_local_identity(drive, "projection_ref")?;
        }
    }
    if let Some(requests) = value.get_mut("antenna_spectrum_requests").and_then(Value::as_array_mut) {
        for request in requests {
            check_type::<fullmag_ir::AntennaSpectrumRequestIR>(request)?;
            if let Some(reference) = request.get_mut("solution_ref") {
                scan_inline(reference, false)?;
                let typed: fullmag_ir::AntennaSolutionRefIR = serde_json::from_value(reference.clone()).map_err(|cause| cause.to_string())?;
                let labels = [typed.stage_id(), typed.output_id()];
                if labels.iter().any(|label| label.trim().is_empty() || label.starts_with("objects/") || is_object_ref(label)) {
                    return Err("antenna solution stage/output are not inline identities".into());
                }
                if let Some(published) = typed.published() {
                    crate::repository_path::validate_store_id(&published.asset_id).map_err(|cause| cause.to_string())?;
                    if !is_object_ref(published.content_digest.strip_prefix("sha256:").unwrap_or("")) {
                        return Err("antenna source pin digest is invalid".into());
                    }
                }
                *reference = Value::Null;
            }

            let Some(reference) = request.get_mut("equilibrium_ref").filter(|value| !value.is_null()) else { continue; };
            scan_inline(reference, false)?;
            let typed: fullmag_ir::EquilibriumRefIR = serde_json::from_value(reference.clone()).map_err(|cause| cause.to_string())?;
            if !typed.is_valid() { return Err("invalid typed equilibrium identity".into()); }
            match typed {
                fullmag_ir::EquilibriumRefIR::Reference(fullmag_ir::EquilibriumReferenceIR::StageOutput { stage_id, output_id }) => {
                    if stage_id.starts_with("objects/") || output_id.starts_with("objects/") || is_object_ref(&stage_id) || is_object_ref(&output_id) {
                        return Err("equilibrium stage-output labels are not inline identities".into());
                    }
                    *reference = Value::Null;
                },
                fullmag_ir::EquilibriumRefIR::Reference(fullmag_ir::EquilibriumReferenceIR::Artifact { asset_id, .. }) => {
                    if !is_object_ref(&asset_id) { return Err("equilibrium artifact semantic identity is malformed".into()); }
                    *reference = Value::Null;
                },
                fullmag_ir::EquilibriumRefIR::LegacyId(_) => { *reference = Value::Null; },
            }
        }
    }
    Ok(())
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
    let mut scan_value = value.clone();
    exempt_declared_scene_asset_references(&mut scan_value)?;
    for (key, scene) in [("scene_document", true), ("builder_adapter", false)] {
        if let Some(document) = scan_value.get_mut(key).filter(|value| !value.is_null()) {
            mask_authored_document(document, scene)
                .map_err(|reason| format!("invalid typed {key}: {reason}"))?;
        }
    }
    scan_inline_with_artifact_paths(&scan_value, true, true)
}

fn declared_scene_asset_ids(
    scene: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<BTreeSet<String>, String> {
    let Some(assets) = scene.get(key) else {
        return Ok(BTreeSet::new());
    };
    let assets = assets
        .as_array()
        .ok_or_else(|| format!("scene_document.{key} is not an array"))?;
    let mut ids = BTreeSet::new();
    for (index, asset) in assets.iter().enumerate() {
        let id = asset
            .as_object()
            .and_then(|asset| asset.get("id"))
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| format!("scene_document.{key}[{index}].id is not a non-empty string"))?;
        if !ids.insert(id.to_string()) {
            return Err(format!("scene_document.{key} has duplicate id `{id}`"));
        }
    }
    Ok(ids)
}

fn exempt_declared_scene_asset_references(snapshot: &mut Value) -> Result<(), String> {
    let Some(scene_value) = snapshot
        .as_object_mut()
        .and_then(|snapshot| snapshot.get_mut("scene_document"))
    else {
        return Ok(());
    };
    if scene_value.is_null() {
        return Ok(());
    }
    let scene = scene_value
        .as_object_mut()
        .ok_or_else(|| "scene_document is not an object".to_string())?;
    let version = scene
        .get("version")
        .and_then(Value::as_str)
        .ok_or_else(|| "scene_document.version is not a string".to_string())?
        .to_string();
    if !matches!(version.as_str(), "scene.v1" | "scene.v2") {
        return Err(format!(
            "scene_document.version `{version}` is not a supported typed scene version"
        ));
    }
    let material_ids = declared_scene_asset_ids(scene, "materials")?;
    let magnetization_ids = declared_scene_asset_ids(scene, "magnetization_assets")?;
    if let Some(objects) = scene.get_mut("objects") {
        let objects = objects
            .as_array_mut()
            .ok_or_else(|| "scene_document.objects is not an array".to_string())?;
        for (index, object) in objects.iter_mut().enumerate() {
            let object = object
                .as_object_mut()
                .ok_or_else(|| format!("scene_document.objects[{index}] is not an object"))?;
            let has_declared_material = object
                .get("material_ref")
                .and_then(Value::as_str)
                .is_some_and(|reference| material_ids.contains(reference));
            // Match authoring: material belongs to magnetic physics. Auxiliary
            // geometry may intentionally have no material; legacy omission of
            // role still means magnet and must retain fail-closed references.
            let is_magnet = object
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or("magnet") == "magnet";
            if is_magnet && !has_declared_material {
                return Err(format!(
                    "scene_document.objects[{index}].material_ref is not a declared material id"
                ));
            }
            object.remove("material_ref");

            if let Some(reference) = object.get("magnetization_ref") {
                match reference {
                    Value::Null => {}
                    Value::String(reference) if magnetization_ids.contains(reference) => {}
                    Value::String(_) => {
                        return Err(format!(
                            "scene_document.objects[{index}].magnetization_ref is not a declared magnetization asset id"
                        ));
                    }
                    _ => {
                        return Err(format!(
                            "scene_document.objects[{index}].magnetization_ref is not a string or null"
                        ));
                    }
                }
                object.remove("magnetization_ref");
            }

            if let Some(overrides) = object.get_mut("region_overrides") {
                let overrides = overrides.as_object_mut().ok_or_else(|| {
                    format!("scene_document.objects[{index}].region_overrides is not an object")
                })?;
                if version == "scene.v1" && !overrides.is_empty() {
                    return Err(format!(
                        "scene_document.objects[{index}].region_overrides is not supported by scene.v1"
                    ));
                }
                for (region_id, override_value) in overrides {
                    let override_value = override_value.as_object_mut().ok_or_else(|| {
                        format!(
                            "scene_document.objects[{index}].region_overrides.{region_id} is not an object"
                        )
                    })?;
                    if let Some(reference) = override_value.get("magnetization_ref") {
                        match reference {
                            Value::Null => {}
                            Value::String(reference) if magnetization_ids.contains(reference) => {}
                            Value::String(_) => {
                                return Err(format!(
                                    "scene_document.objects[{index}].region_overrides.{region_id}.magnetization_ref is not a declared magnetization asset id"
                                ));
                            }
                            _ => {
                                return Err(format!(
                                    "scene_document.objects[{index}].region_overrides.{region_id}.magnetization_ref is not a string or null"
                                ));
                            }
                        }
                        override_value.remove("magnetization_ref");
                    }
                }
            }
        }
    }
    let mut preserved_scene_extensions = Vec::new();
    if version == "scene.v2" {
        exempt_scene_postprocessing_data_refs(scene)?;
        exempt_active_visualization_preset_ref(scene, &mut preserved_scene_extensions)?;
    }
    if !preserved_scene_extensions.is_empty() {
        let snapshot = snapshot
            .as_object_mut()
            .ok_or_else(|| "root is not an object".to_string())?;
        let mut key = "__typed_scene_reference_extensions".to_string();
        while snapshot.contains_key(&key) {
            key.push('_');
        }
        snapshot.insert(key, Value::Array(preserved_scene_extensions));
    }
    Ok(())
}

fn validate_scene_postprocessing_data_ref(value: &Value, context: &str) -> Result<(), String> {
    let reference = value
        .as_object()
        .ok_or_else(|| format!("{context}.data_ref is not an object"))?;
    const REQUIRED: &[&str] = &["run_id", "dataset_id", "dataset_revision"];
    const OPTIONAL: &[&str] = &["sample_id", "item_id", "branch_id", "field_id"];
    if let Some(key) = reference
        .keys()
        .find(|key| !REQUIRED.contains(&key.as_str()) && !OPTIONAL.contains(&key.as_str()))
    {
        return Err(format!("{context}.data_ref has unknown field `{key}`"));
    }
    for key in REQUIRED {
        if !reference
            .get(*key)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
        {
            return Err(format!("{context}.data_ref.{key} is not a non-empty string"));
        }
    }
    for key in OPTIONAL {
        if let Some(value) = reference.get(*key) {
            if !value.is_null() && !value.is_string() {
                return Err(format!("{context}.data_ref.{key} is not a string or null"));
            }
        }
    }
    Ok(())
}

fn exempt_scene_postprocessing_data_refs(
    scene: &mut serde_json::Map<String, Value>,
) -> Result<(), String> {
    let Some(analysis) = scene.get_mut("analysis") else {
        return Ok(());
    };
    let analysis = analysis
        .as_object_mut()
        .ok_or_else(|| "scene_document.analysis is not an object".to_string())?;
    let Some(definitions) = analysis.get_mut("postprocessing_definitions") else {
        return Ok(());
    };
    let definitions = definitions.as_array_mut().ok_or_else(|| {
        "scene_document.analysis.postprocessing_definitions is not an array".to_string()
    })?;
    for (index, definition) in definitions.iter_mut().enumerate() {
        let context = format!("scene_document.analysis.postprocessing_definitions[{index}]");
        let definition = definition
            .as_object_mut()
            .ok_or_else(|| format!("{context} is not an object"))?;
        for key in [
            "definition_id",
            "module_id",
            "module_version",
            "definition_schema",
            "node_kind",
            "label",
        ] {
            if !definition
                .get(key)
                .and_then(Value::as_str)
                .is_some_and(|value| !value.trim().is_empty())
            {
                return Err(format!("{context}.{key} is not a non-empty string"));
            }
        }
        if let Some(revision) = definition.get("revision") {
            if revision.as_u64().is_none() {
                return Err(format!("{context}.revision is not an unsigned integer"));
            }
        }
        if let Some(parent) = definition.get("parent_definition_id") {
            if !parent.is_null() && !parent.is_string() {
                return Err(format!("{context}.parent_definition_id is not a string or null"));
            }
        }
        if let Some(settings) = definition.get("settings") {
            if !settings.is_null() && !settings.is_object() {
                return Err(format!("{context}.settings is not an object or null"));
            }
        }
        let data_ref = definition
            .get("data_ref")
            .ok_or_else(|| format!("{context}.data_ref is missing"))?;
        validate_scene_postprocessing_data_ref(data_ref, &context)?;
        definition.remove("data_ref");
    }
    Ok(())
}

fn exempt_active_visualization_preset_ref(
    scene: &mut serde_json::Map<String, Value>,
    preserved_extensions: &mut Vec<Value>,
) -> Result<(), String> {
    let Some(editor) = scene.get_mut("editor") else {
        return Ok(());
    };
    let editor = editor
        .as_object_mut()
        .ok_or_else(|| "scene_document.editor is not an object".to_string())?;
    let Some(reference) = editor.remove("active_visualization_preset_ref") else {
        return Ok(());
    };
    if reference.is_null() {
        return Ok(());
    }
    let mut reference = reference
        .as_object()
        .cloned()
        .ok_or_else(|| "scene_document.editor.active_visualization_preset_ref is not an object".to_string())?;
    for key in ["source", "preset_id"] {
        if !reference.get(key).is_some_and(Value::is_string) {
            return Err(format!(
                "scene_document.editor.active_visualization_preset_ref.{key} is not a string"
            ));
        }
    }
    reference.remove("source");
    reference.remove("preset_id");
    if !reference.is_empty() {
        preserved_extensions.push(Value::Object(reference));
    }
    Ok(())
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
    fn declared_scene_asset_refs_are_exempt_only_at_typed_scene_paths() {
        let hash = "d".repeat(64);
        let mut value = snapshot();
        value["scene_document"] = json!({
            "version": "scene.v2",
            "materials": [{"id": hash.clone()}],
            "magnetization_assets": [{"id": "mag:body"}, {"id": "mag:region"}],
            "objects": [{
                "material_ref": hash.clone(),
                "magnetization_ref": "mag:body",
                "region_overrides": {
                    "region-1": {"magnetization_ref": "mag:region"}
                },
                "metadata": {"payload_ref": hash}
            }]
        });

        let inspection = inspect_live_snapshot(&serde_json::to_vec(&value).unwrap());
        assert_eq!(inspection.object_refs, Ok(vec![hash.clone()]));
        assert!(inspection.artifact_refs.is_ok());

        let mut only_typed_hash = value.clone();
        only_typed_hash["scene_document"]["objects"][0]["metadata"]
            .as_object_mut()
            .unwrap()
            .remove("payload_ref");
        assert_eq!(
            inspect_live_snapshot(&serde_json::to_vec(&only_typed_hash).unwrap()).object_refs,
            Ok(vec![])
        );

        value["scene_document"]["objects"][0]["metadata"]["material_ref"] =
            json!("mat:unrelated");
        let inspection = inspect_live_snapshot(&serde_json::to_vec(&value).unwrap());
        assert!(inspection.object_refs.is_err());
        assert!(inspection.artifact_refs.is_ok());

        value["scene_document"]["objects"][0]["metadata"]["material_ref"] =
            json!(format!("objects/sha256/{hash}"));
        let inspection = inspect_live_snapshot(&serde_json::to_vec(&value).unwrap());
        assert!(inspection.object_refs.is_err());
    }

    #[test]
    fn auxiliary_scene_objects_do_not_require_magnetic_material_refs() {
        for role in ["airbox", "antenna"] {
            for material in [None, Some(json!(""))] {
                let mut value = snapshot();
                let mut auxiliary = json!({"role": role});
                if let Some(material) = material {
                    auxiliary["material_ref"] = material;
                }
                value["scene_document"] = json!({
                    "version": "scene.v2",
                    "materials": [{"id": "mat:body"}],
                    "objects": [{"role": "magnet", "material_ref": "mat:body"}, auxiliary]
                });
                let inspection = inspect_live_snapshot(&serde_json::to_vec(&value).unwrap());
                assert!(inspection.object_refs.is_ok(), "{role}: {:?}", inspection.object_refs);
                assert!(inspection.artifact_refs.is_ok());
                value["scene_document"]["objects"][0]["material_ref"] = json!("mat:missing");
                assert!(inspect_live_snapshot(&serde_json::to_vec(&value).unwrap()).object_refs.is_err(),
                    "an auxiliary object must not exempt an invalid magnet reference");
            }
        }
    }

    #[test]
    fn invalid_or_undeclared_scene_asset_refs_remain_fail_closed() {
        let mut base = snapshot();
        base["scene_document"] = json!({
            "version": "scene.v2",
            "materials": [{"id": "mat:body"}],
            "magnetization_assets": [{"id": "mag:body"}, {"id": "mag:region"}],
            "objects": [{
                "material_ref": "mat:body",
                "magnetization_ref": "mag:body",
                "region_overrides": {
                    "region-1": {"magnetization_ref": "mag:region"}
                }
            }]
        });
        let cases = [
            ("undeclared material", json!({"material_ref": "mat:missing"})),
            ("undeclared magnetization", json!({"magnetization_ref": "mag:missing"})),
            (
                "wrong magnetization type",
                json!({"magnetization_ref": ["mag:body"]}),
            ),
            (
                "undeclared region magnetization",
                json!({"region_overrides": {"region-1": {"magnetization_ref": "mag:missing"}}}),
            ),
        ];
        for (label, replacement) in cases {
            let mut value = base.clone();
            for (key, replacement_value) in replacement.as_object().unwrap() {
                value["scene_document"]["objects"][0][key] = replacement_value.clone();
            }
            let inspection = inspect_live_snapshot(&serde_json::to_vec(&value).unwrap());
            assert!(inspection.object_refs.is_err(), "{label}");
        }

        let mut wrong_version = base.clone();
        wrong_version["scene_document"]["version"] = json!("scene.v9");
        assert!(inspect_live_snapshot(&serde_json::to_vec(&wrong_version).unwrap())
            .object_refs
            .is_err());

        let mut duplicate_ids = base;
        duplicate_ids["scene_document"]["materials"] =
            json!([{"id": "mat:body"}, {"id": "mat:body"}]);
        assert!(inspect_live_snapshot(&serde_json::to_vec(&duplicate_ids).unwrap())
            .object_refs
            .is_err());
    }

    #[test]
    fn scene_v2_published_data_and_visualization_refs_are_typed_but_extensions_are_scanned() {
        let hash = "e".repeat(64);
        let mut value = snapshot();
        value["scene_document"] = json!({
            "version": "scene.v2",
            "materials": [{"id": "mat:body"}],
            "magnetization_assets": [{"id": "mag:body"}],
            "objects": [{
                "material_ref": "mat:body",
                "magnetization_ref": "mag:body"
            }],
            "analysis": {
                "postprocessing_definitions": [{
                    "definition_id": "viz-1",
                    "revision": 1,
                    "module_id": "analysis.dispersion",
                    "module_version": "0.1.0",
                    "definition_schema": "analysis.dispersion.mode_visualization.v1",
                    "node_kind": "analysis.dispersion.mode_visualization",
                    "label": "Pinned mode",
                    "data_ref": {
                        "run_id": "run-1",
                        "dataset_id": "modal-k-path",
                        "dataset_revision": "r7",
                        "sample_id": "sample-0006",
                        "item_id": "mode-0001"
                    },
                    "settings": {"payload_ref": hash.clone()}
                }]
            },
            "editor": {
                "active_visualization_preset_ref": {
                    "source": "user",
                    "preset_id": "preset-1",
                    "payload_ref": hash.clone()
                }
            }
        });

        let inspection = inspect_live_snapshot(&serde_json::to_vec(&value).unwrap());
        assert_eq!(inspection.object_refs, Ok(vec![hash.clone()]));
        assert!(inspection.artifact_refs.is_ok());

        let mut scene_without_objects = value.clone();
        scene_without_objects["scene_document"]["objects"] = json!([]);
        assert_eq!(
            inspect_live_snapshot(&serde_json::to_vec(&scene_without_objects).unwrap()).object_refs,
            Ok(vec![hash.clone()])
        );

        value["scene_document"]["analysis"]["postprocessing_definitions"][0]["data_ref"]["run_id"] =
            json!("");
        assert!(inspect_live_snapshot(&serde_json::to_vec(&value).unwrap())
            .object_refs
            .is_err());

        value["scene_document"]["analysis"]["postprocessing_definitions"][0]["data_ref"]["run_id"] =
            json!("run-1");
        value["scene_document"]["analysis"]["postprocessing_definitions"][0]["data_ref"]["payload_ref"] =
            json!(hash);
        assert!(inspect_live_snapshot(&serde_json::to_vec(&value).unwrap())
            .object_refs
            .is_err());

        value["scene_document"]["analysis"]["postprocessing_definitions"][0]["data_ref"]
            .as_object_mut()
            .unwrap()
            .remove("payload_ref");
        value["scene_document"]["editor"]["active_visualization_preset_ref"]["source"] =
            json!(false);
        assert!(inspect_live_snapshot(&serde_json::to_vec(&value).unwrap())
            .object_refs
            .is_err());

        value["scene_document"].as_object_mut().unwrap().remove("analysis");
        value["scene_document"]["editor"] = json!({
            "active_visualization_preset_ref": {
                "source": "user",
                "preset_id": "preset-1"
            }
        });
        // A valid visualization ref remains exempt when it is the only scene
        // reference; the preceding malformed-source case must still fail.
        assert_eq!(
            inspect_live_snapshot(&serde_json::to_vec(&value).unwrap()).object_refs,
            Ok(vec![])
        );
    }

    #[test]
    fn scene_v1_asset_refs_are_typed_while_postprocessing_data_refs_stay_fail_closed() {
        let mut value = snapshot();
        value["scene_document"] = json!({
            "version": "scene.v1",
            "materials": [{"id": "mat:body"}],
            "magnetization_assets": [{"id": "mag:body"}],
            "objects": [{
                "material_ref": "mat:body",
                "magnetization_ref": "mag:body"
            }]
        });
        assert_eq!(
            inspect_live_snapshot(&serde_json::to_vec(&value).unwrap()).object_refs,
            Ok(vec![])
        );

        value["scene_document"]["analysis"] = json!({
            "postprocessing_definitions": [{
                "definition_id": "viz-1",
                "module_id": "analysis.dispersion",
                "module_version": "0.1.0",
                "definition_schema": "analysis.dispersion.mode_visualization.v1",
                "node_kind": "analysis.dispersion.mode_visualization",
                "label": "Pinned mode",
                "data_ref": {
                    "run_id": "run-1",
                    "dataset_id": "modal-k-path",
                    "dataset_revision": "r7"
                }
            }]
        });
        assert!(inspect_live_snapshot(&serde_json::to_vec(&value).unwrap())
            .object_refs
            .is_err());
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

#[cfg(test)]
mod authored_reference_tests {
    use super::*;
    use serde_json::json;

    fn snapshot() -> Value {
        json!({"session_protocol_version":"v2", "capability_profile_version":"v1",
            "session":{"run_id":"run-1"}, "runtime_status":{}, "artifacts":[], "display_selection":{},
            "preview_config":{}, "mesh_revision":1, "mesh_build_revision":1,
            "scene_document":{"version":"scene.v2", "antenna_port_modes":[{
                "schema_version":"antenna_port_mode.v2", "id":"port", "source_object_id":"antenna",
                "current_transport_id":"charge", "normalization_current_a":1.0,
                "branches":[{"id":"signal", "inlet_terminal_ref":"signal-in",
                    "outlet_terminal_ref":"signal-out", "signed_weight":1.0}]
            }]}})
    }

    #[test]
    fn antenna_candidate_identity_uses_every_published_reference_component() {
        let reference = fullmag_ir::AntennaFieldSolutionRefIR {
            stage_id: "stage".into(), output_id: "basis".into(), asset_id: "asset".into(),
            content_digest: format!("sha256:{}", "a".repeat(64)),
        };
        let manifest = json!({"stage_id":reference.stage_id, "solution_id":reference.output_id,
            "asset_id":reference.asset_id, "content_digest":reference.content_digest});
        assert!(antenna_source_matches_reference(&serde_json::to_vec(&manifest).unwrap(), &reference).unwrap());
        for key in ["stage_id", "solution_id", "asset_id", "content_digest"] {
            let mut unrelated = manifest.clone();
            unrelated[key] = json!("different");
            assert!(!antenna_source_matches_reference(&serde_json::to_vec(&unrelated).unwrap(), &reference).unwrap());
        }
        // Identity selection must not discard a matching but corrupt closure.
        let mut corrupt = manifest;
        corrupt["bases"] = json!("invalid");
        let bytes = serde_json::to_vec(&corrupt).unwrap();
        assert!(antenna_source_matches_reference(&bytes, &reference).unwrap());
        assert!(antenna_source_owned_inputs(&bytes, &reference, Some("port")).is_err());
    }

    #[test]
    fn typed_port_labels_are_not_cas_and_hidden_references_still_fail_closed() {
        let original = snapshot();
        let inspection = inspect_live_snapshot(&serde_json::to_vec(&original).unwrap());
        assert_eq!(inspection.object_refs, Ok(vec![]));
        assert!(inspection.artifact_refs.is_ok());
        let mut invalid = original.clone();
        invalid["scene_document"]["antenna_port_modes"][0]["branches"][0]["inlet_terminal_ref"] = json!("objects/sha256/hidden");
        assert!(inspect_live_snapshot(&serde_json::to_vec(&invalid).unwrap()).object_refs.is_err());
        let mut hidden = original;
        hidden["metadata"] = json!({"port_mode_ref":"not-a-cas-ref"});
        assert!(inspect_live_snapshot(&serde_json::to_vec(&hidden).unwrap()).object_refs.is_err());
    }

    #[test]
    fn typed_authoring_does_not_hide_unknown_nested_cas_references() {
        let mut value = snapshot();
        value["scene_document"]["antenna_port_modes"][0]["branches"][0]["hidden_ref"] = json!("runs/x/payload");
        assert!(inspect_live_snapshot(&serde_json::to_vec(&value).unwrap()).object_refs.is_err());
        value = snapshot();
        let hash = "c".repeat(64);
        value["latest_fields"] = json!({"V_electric":{"payload_ref":hash}});
        let inspection = inspect_live_snapshot(&serde_json::to_vec(&value).unwrap());
        assert_eq!(inspection.object_refs, Ok(vec![hash]));
        assert!(inspection.artifact_refs.is_ok());
    }

    #[test]
    fn authored_masks_do_not_exempt_undeclared_scene_assets() {
        let mut value = snapshot();
        value["scene_document"]["materials"] = json!([{"id":"mat:body"}]);
        value["scene_document"]["objects"] = json!([{"material_ref":"mat:missing"}]);
        let inspection = inspect_live_snapshot(&serde_json::to_vec(&value).unwrap());
        assert!(inspection.object_refs.is_err());
        assert!(inspection.artifact_refs.is_ok());
        value["scene_document"]["objects"][0]["material_ref"] = json!("mat:body");
        value["scene_document"]["objects"][0]["magnetization_ref"] = json!("mag:missing");
        assert!(inspect_live_snapshot(&serde_json::to_vec(&value).unwrap()).object_refs.is_err());
    }

    #[test]
    fn authored_masks_preserve_preset_extensions_for_cas_scanning() {
        let mut value = snapshot();
        let hash = "d".repeat(64);
        value["scene_document"]["editor"] = json!({"active_visualization_preset_ref":{
            "source":"user", "preset_id":"preset-1", "payload_ref":hash.clone()
        }});
        let inspection = inspect_live_snapshot(&serde_json::to_vec(&value).unwrap());
        assert_eq!(inspection.object_refs, Ok(vec![hash]));
        assert!(inspection.artifact_refs.is_ok());
        value["scene_document"]["editor"]["active_visualization_preset_ref"]["payload_ref"] = json!("runs/foreign");
        assert!(inspect_live_snapshot(&serde_json::to_vec(&value).unwrap()).object_refs.is_err());
    }

    #[test]
    fn closed_loop_port_source_cut_is_a_typed_identity() {
        let mut value = snapshot();
        value["scene_document"]["antenna_port_modes"][0]["schema_version"] = json!("antenna_port_mode.v3");
        value["scene_document"]["antenna_port_modes"][0]["normalization"] = json!({
            "kind":"source_cut_rt0", "source_cut_ref":"inlet_cut", "orientation":"minus_outward"
        });
        let inspection = inspect_live_snapshot(&serde_json::to_vec(&value).unwrap());
        assert_eq!(inspection.object_refs, Ok(vec![]));
        assert!(inspection.artifact_refs.is_ok());
        value["scene_document"]["antenna_port_modes"][0]["normalization"]["source_cut_ref"] = json!("objects/sha256/hidden");
        assert!(inspect_live_snapshot(&serde_json::to_vec(&value).unwrap()).object_refs.is_err());
    }
}

/// Semantic asset IDs are resolved through the existing inventory, never CAS guessing.
pub(crate) fn equilibrium_artifact_inventory_refs(data: &[u8]) -> Result<Vec<fullmag_ir::EquilibriumReferenceIR>, String> {
    let value: Value = serde_json::from_slice(data).map_err(|cause| cause.to_string())?;
    let mut refs = Vec::new();
    for key in ["scene_document", "builder_adapter"] {
        if let Some(requests) = value.get(key).and_then(|value| value.get("antenna_spectrum_requests")).and_then(Value::as_array) {
            for request in requests {
                let typed: fullmag_ir::AntennaSpectrumRequestIR = serde_json::from_value(request.clone()).map_err(|cause| cause.to_string())?;
                if let Some(fullmag_ir::EquilibriumRefIR::Reference(reference @ fullmag_ir::EquilibriumReferenceIR::Artifact { .. })) = typed.equilibrium_ref {
                    refs.push(reference);
                }
            }
        }
    }
    Ok(refs)
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct EquilibriumOwnedInput { path: String, sha256: String, byte_count: u64 }

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct EquilibriumOwnedManifest {
    schema_version: String, asset_id: String, equilibrium_id: String, content_digest: String,
    source_run_id: String, source_stage_id: String, authored_stage_id: String, output_id: String, resolved_execution_engine: String, completion_sha256: String,
    owning_plan: EquilibriumOwnedInput, relax_receipt: EquilibriumOwnedInput,
    recomputed_certificate: EquilibriumOwnedInput,
    accepted_fields: EquilibriumOwnedInput,
}

/// Closed, bounded receipt closure for archive reachability. Scientific acceptance
/// is still reconstructed by the runner's canonical reader after cold load.
pub(crate) fn equilibrium_owned_inputs(
    data: &[u8], reference: &fullmag_ir::EquilibriumReferenceIR, manifest_path: &str,
) -> Result<Vec<(String, String, u64)>, String> {
    if data.len() as u64 > crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES { return Err("equilibrium manifest exceeds metadata budget".into()); }
    let manifest: EquilibriumOwnedManifest = serde_json::from_slice(data).map_err(|cause| cause.to_string())?;
    let fullmag_ir::EquilibriumReferenceIR::Artifact { asset_id, equilibrium_id, content_digest } = reference
        else { return Err("inventory resolution requires an immutable equilibrium ArtifactRef".into()); };
    let mut value = serde_json::to_value(&manifest).map_err(|cause| cause.to_string())?;
    let map = value.as_object_mut().ok_or("equilibrium manifest shape")?;
    for key in ["asset_id", "equilibrium_id", "content_digest"] { map.remove(key); }
    let mut preimage = b"antenna_accepted_equilibrium.v1\0".to_vec();
    preimage.extend(serde_json::to_vec(&value).map_err(|cause| cause.to_string())?);
    let digest = format!("sha256:{}", crate::cas::hex_sha256(&preimage));
    if manifest.schema_version != "antenna_accepted_equilibrium.v1"
        || &manifest.asset_id != asset_id || &manifest.equilibrium_id != equilibrium_id
        || &manifest.content_digest != content_digest || content_digest != &digest
        || manifest.asset_id != digest[7..] || manifest.equilibrium_id != format!("antenna_accepted_equilibrium.v1:{}", &digest[7..])
        || manifest.output_id != "accepted_equilibrium" || manifest.source_stage_id.trim().is_empty()
        || manifest.authored_stage_id.trim().is_empty()
        || manifest.resolved_execution_engine != "fem_cpu_native"
        || manifest_path != format!("runs/{}/artifacts/antenna/accepted_equilibria/{}/manifest.v1.json", manifest.source_run_id, manifest.asset_id)
        || !is_object_ref(manifest.completion_sha256.strip_prefix("sha256:").unwrap_or("")) {
        return Err("equilibrium inventory owner identity mismatch".into());
    }
    let mut inputs = Vec::new();
    for (input, expected) in [(manifest.owning_plan, "owning_plan.json"),
        (manifest.relax_receipt, "relax_receipt.v3.json"), (manifest.recomputed_certificate, "recomputed_certificate.v1.json"),
        (manifest.accepted_fields, "accepted_fields.json" )] {
        let digest = input.sha256.strip_prefix("sha256:").filter(|digest| is_object_ref(digest)).ok_or("equilibrium input digest")?;
        if input.path != expected || input.byte_count == 0 || input.byte_count > 256 * 1024 * 1024 {
            return Err("equilibrium owned input name or budget".into());
        }
        inputs.push((input.path, digest.to_string(), input.byte_count));
    }
    Ok(inputs)
}

pub(crate) fn antenna_source_inventory_refs(data: &[u8]) -> Result<Vec<(fullmag_ir::AntennaFieldSolutionRefIR, Option<String>)>, String> {
    let value: Value = serde_json::from_slice(data).map_err(|cause| cause.to_string())?;
    let mut refs = Vec::new();
    for key in ["scene_document", "builder_adapter"] {
        if let Some(requests) = value.get(key).and_then(|value| value.get("antenna_spectrum_requests")).and_then(Value::as_array) {
            for request in requests {
                let typed: fullmag_ir::AntennaSpectrumRequestIR = serde_json::from_value(request.clone()).map_err(|cause| cause.to_string())?;
                if let Some(reference) = typed.solution_ref.published() { refs.push((reference.clone(), typed.port_mode_id)); }
            }
        }
    }
    Ok(refs)
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct AntennaOwnedBinary { path: String, sha256: String, scalar_type: String, layout: String, unit: String, value_count: u64 }

/// Select a candidate by the complete published identity before validating its
/// closure. A corrupt selected manifest must still fail `antenna_source_owned_inputs`.
pub(crate) fn antenna_source_matches_reference(
    data: &[u8], reference: &fullmag_ir::AntennaFieldSolutionRefIR,
) -> Result<bool, String> {
    if data.len() as u64 > crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES {
        return Err("antenna source manifest exceeds metadata budget".into());
    }
    let value: Value = serde_json::from_slice(data).map_err(|cause| cause.to_string())?;
    Ok(value.get("stage_id").and_then(Value::as_str) == Some(reference.stage_id.as_str())
        && value.get("solution_id").and_then(Value::as_str) == Some(reference.output_id.as_str())
        && value.get("asset_id").and_then(Value::as_str) == Some(reference.asset_id.as_str())
        && value.get("content_digest").and_then(Value::as_str) == Some(reference.content_digest.as_str()))
}

/// Inventory closure only. The existing qualified-basis reader remains the
/// sole runtime acceptance authority after restoration.
pub(crate) fn antenna_source_owned_inputs(
    data: &[u8], reference: &fullmag_ir::AntennaFieldSolutionRefIR, port_mode_id: Option<&str>,
) -> Result<Vec<(String, String, u64)>, String> {
    if data.len() as u64 > crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES { return Err("antenna source manifest exceeds metadata budget".into()); }
    let mut value: Value = serde_json::from_slice(data).map_err(|cause| cause.to_string())?;
    let published = value.as_object_mut().and_then(|map| map.remove("content_digest"))
        .and_then(|value| value.as_str().map(str::to_string)).ok_or("antenna basis digest missing")?;
    let computed = format!("sha256:{}", crate::cas::hex_sha256(&serde_json::to_vec(&value).map_err(|cause| cause.to_string())?));
    if published != computed || published != reference.content_digest
        || value.get("schema_version").and_then(Value::as_str) != Some("antenna_field_solution.v1")
        || value.get("status").and_then(Value::as_str) != Some("ready")
        || value.get("asset_id").and_then(Value::as_str) != Some(reference.asset_id.as_str())
        || value.get("solution_id").and_then(Value::as_str) != Some(reference.output_id.as_str())
        || value.get("stage_id").and_then(Value::as_str) != Some(reference.stage_id.as_str()) {
        return Err("antenna source immutable owner mismatch".into());
    }
    let allowed = ["schema_version", "asset_id", "status", "solution_id", "source_object_id", "current_transport_id", "stage_id",
        "geometry_revision", "material_revision", "mesh_digest", "requested_execution", "resolved_execution", "gauge_policy", "solver_policy",
        "signatures", "conductor_positions", "sample_positions", "sample_carrier", "sample_topology", "assumptions", "bases"];
    if value.as_object().ok_or("antenna source shape")?.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err("unknown antenna source manifest member".into());
    }
    scan_inline(&value, false)?;
    let mut inputs = Vec::new();
    let mut names = std::collections::BTreeSet::new();
    let prefix = format!("antenna/field_solutions/{}/", reference.output_id);
    let mut add = |value: &Value| -> Result<(), String> {
        let input: AntennaOwnedBinary = serde_json::from_value(value.clone()).map_err(|cause| cause.to_string())?;
        let path = input.path.strip_prefix(&prefix).ok_or("antenna basis payload namespace")?.to_string();
        crate::repository_path::validate_relative_path(&path).map_err(|cause| cause.to_string())?;
        let digest = input.sha256.strip_prefix("sha256:").unwrap_or(&input.sha256);
        if !is_object_ref(digest) || input.layout.is_empty() || input.unit.is_empty() || !names.insert(path.clone()) {
            return Err("antenna basis payload metadata or duplicate path".into());
        }
        let width = match input.scalar_type.as_str() { "float64_le" => 8, "uint32_le" => 4, _ => return Err("antenna basis payload scalar type".into()) };
        let count = input.value_count.checked_mul(width).filter(|count| *count > 0 && *count <= 512 * 1024 * 1024).ok_or("antenna basis payload budget")?;
        inputs.push((path, digest.to_string(), count));
        Ok(())
    };
    for key in ["conductor_positions", "sample_positions"] { add(value.get(key).ok_or("antenna basis coordinate ref")?)?; }
    if let Some(topology) = value.get("sample_topology").filter(|value| !value.is_null()) { add(topology)?; }
    let bases = value.get("bases").and_then(Value::as_array).ok_or("antenna basis list")?;
    if bases.is_empty() || (port_mode_id.is_none() && bases.len() != 1)
        || port_mode_id.is_some_and(|port| bases.iter().filter(|basis| basis.get("port_mode_id").and_then(Value::as_str) == Some(port)).count() != 1) {
        return Err("antenna source port is missing or ambiguous".into());
    }
    let mut ports = std::collections::BTreeSet::new();
    for basis in bases {
        let allowed = ["port_mode_id", "measured_positive_terminal_current_a", "normalization_current_a", "normalization_scale",
            "current_balance_certificate_digest", "electric_potential_per_ampere", "current_density_per_ampere", "magnetic_field_per_ampere",
            "quadrature_diagnostics", "oersted_operator_version", "quadrature_evidence"];
        if basis.as_object().ok_or("antenna source basis shape")?.keys().any(|key| !allowed.contains(&key.as_str())) {
            return Err("unknown antenna source basis member".into());
        }
        let port = basis.get("port_mode_id").and_then(Value::as_str).filter(|port| !port.trim().is_empty()).ok_or("antenna source basis port")?;
        if !ports.insert(port) { return Err("duplicate antenna source basis port".into()); }
        for key in ["electric_potential_per_ampere", "current_density_per_ampere", "magnetic_field_per_ampere"] { add(basis.get(key).ok_or("antenna basis field ref")?)?; }
        if let Some(evidence) = basis.get("quadrature_evidence").filter(|value| !value.is_null()) {
            let allowed = ["schema_version", "path", "sha256", "byte_length", "target_count"];
            if evidence.as_object().ok_or("quadrature evidence shape")?.keys().any(|key| !allowed.contains(&key.as_str())) {
                return Err("unknown quadrature evidence member".into());
            }
            let adapted = serde_json::json!({"path": evidence.get("path").ok_or("quadrature evidence path")?,
                "sha256": evidence.get("sha256").ok_or("quadrature evidence digest")?, "scalar_type":"uint32_le",
                "layout":"owned_quadrature_evidence", "unit":"1", "value_count": evidence.get("byte_length").and_then(Value::as_u64).filter(|count| count % 4 == 0).ok_or("quadrature evidence budget")? / 4});
            add(&adapted)?;
        }
    }
    Ok(inputs)
}
