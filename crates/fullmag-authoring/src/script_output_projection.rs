//! Compare authoring through the same effective project output policy as the SDK.
//! The source document stays immutable; only its script projection is normalized.

use crate::{SceneDocument, SceneDocumentValidationError};
use fullmag_ir::{
    resolve_project_stage_autosave_policy, OutputDataFormatIR, SamplingIR, StageAutosaveIR,
    StudyKindIR, TableAutosaveIR, DEFAULT_TABLE_AUTOSAVE_QUANTITIES,
};
use serde_json::Value;

fn invalid(error: impl std::fmt::Display) -> SceneDocumentValidationError {
    SceneDocumentValidationError::new(format!("project output policy projection: {error}"))
}

pub(crate) fn normalize_project_output_projection(
    scene: &SceneDocument,
    projection: &mut Value,
) -> Result<(), SceneDocumentValidationError> {
    let Some(storage) = scene.study.output_storage.as_ref() else {
        return Ok(());
    };
    let stages = projection
        .get_mut("stages")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| invalid("missing projected stages"))?;
    if stages.len() != scene.study.stages.len() {
        return Err(invalid("projected stage count differs from authoring"));
    }
    for (authored, projected) in scene.study.stages.iter().zip(stages) {
        let raw = serde_json::to_value(authored).map_err(invalid)?;
        if let Some(policy) = effective_policy(
            &raw,
            None,
            storage.data_format,
            scene.study.table_autosave.as_ref(),
        )? {
            projected["autosave"] = serde_json::to_value(policy).map_err(invalid)?;
        }
    }
    if let Some(nodes) = projection
        .get_mut("study_pipeline")
        .and_then(|pipeline| pipeline.get_mut("nodes"))
        .and_then(Value::as_array_mut)
    {
        normalize_nodes(
            nodes,
            storage.data_format,
            scene.study.table_autosave.as_ref(),
        )?;
    }
    Ok(())
}

fn normalize_nodes(
    nodes: &mut [Value],
    format: OutputDataFormatIR,
    table: Option<&TableAutosaveIR>,
) -> Result<(), SceneDocumentValidationError> {
    for node in nodes {
        if node.get("node_kind").and_then(Value::as_str) == Some("group") {
            if let Some(children) = node.get_mut("children").and_then(Value::as_array_mut) {
                normalize_nodes(children, format, table)?;
            }
            continue;
        }
        let kind = node
            .get("stage_kind")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if let Some(payload) = node.get_mut("payload").filter(|value| value.is_object()) {
            if let Some(policy) = effective_policy(payload, kind.as_deref(), format, table)? {
                payload["autosave"] = serde_json::to_value(policy).map_err(invalid)?;
            }
        }
    }
    Ok(())
}

fn positive(stage: &Value, key: &str) -> Option<f64> {
    stage
        .get(key)
        .and_then(|value| {
            value
                .as_f64()
                .or_else(|| value.as_str().and_then(|text| text.trim().parse().ok()))
        })
        .filter(|value: &f64| value.is_finite() && *value > 0.0)
}

fn normalize_table_quantities(value: &mut Value) {
    // Match TableAutosave's public DSL default without changing the stricter
    // IR wire schema. Real SDK capture tests guard this compatibility boundary.
    if let Some(table) = value.as_object_mut() {
        if table.get("quantities").is_none_or(Value::is_null) {
            table.insert(
                "quantities".into(),
                serde_json::json!(DEFAULT_TABLE_AUTOSAVE_QUANTITIES),
            );
        }
    }
}

fn effective_policy(
    stage: &Value,
    fallback_kind: Option<&str>,
    format: OutputDataFormatIR,
    table: Option<&TableAutosaveIR>,
) -> Result<Option<StageAutosaveIR>, SceneDocumentValidationError> {
    let name = stage
        .get("kind")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .or(fallback_kind)
        .or_else(|| stage.get("stage_kind").and_then(Value::as_str))
        .unwrap_or("")
        .to_ascii_lowercase();
    let kind = match name.as_str() {
        "relax" | "relaxation" => StudyKindIR::Relaxation,
        "run" | "time_evolution" | "time-evolution" => StudyKindIR::TimeEvolution,
        _ => StudyKindIR::Unknown,
    };
    let sampling = stage.get("sampling").filter(|value| value.is_object());
    let explicit = stage
        .get("autosave")
        .filter(|value| !value.is_null())
        .or_else(|| {
            sampling
                .and_then(|value| value.get("stage_autosave"))
                .filter(|value| !value.is_null())
        });
    if explicit.is_none() && !matches!(kind, StudyKindIR::Relaxation | StudyKindIR::TimeEvolution) {
        return Ok(None);
    }
    let stage_autosave = explicit
        .map(|value| {
            let mut value = value.clone();
            let object = value
                .as_object_mut()
                .ok_or_else(|| invalid("autosave must be an object"))?;
            if object.get("format").is_none_or(Value::is_null) {
                object.insert(
                    "format".into(),
                    serde_json::to_value(format).map_err(invalid)?,
                );
            }
            if let Some(table) = value.get_mut("table") {
                normalize_table_quantities(table);
            }
            serde_json::from_value(value).map_err(invalid)
        })
        .transpose()?;
    let local_table = sampling.and_then(|value| value.get("table_autosave"));
    let table_autosave = match local_table {
        Some(Value::Null) => None,
        Some(value) => {
            let mut value = value.clone();
            normalize_table_quantities(&mut value);
            Some(serde_json::from_value(value).map_err(invalid)?)
        }
        None => table.cloned(),
    };
    // Other study families keep their own sampling vocabulary and clock.
    let outputs = if kind == StudyKindIR::TimeEvolution && stage_autosave.is_none() {
        // This is authoring policy resolution: mirror the SDK's accepted
        // field/field_auto entries. Resolved execution outputs remain in the
        // source projection, but do not create a new authored writer cadence.
        sampling
            .and_then(|value| value.get("outputs"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|value| {
                matches!(
                    value.get("kind").and_then(Value::as_str),
                    Some("field" | "field_auto")
                )
            })
            .map(|value| serde_json::from_value(value.clone()).map_err(invalid))
            .collect::<Result<Vec<_>, _>>()?
    } else {
        Vec::new()
    };
    let sampling = SamplingIR {
        outputs,
        table_autosave,
        stage_autosave,
    };
    // The SDK prefers an authored output cadence, then the run duration. This
    // value only supplies a missing writer cadence; it never changes stop time.
    let period = positive(stage, "output_every_seconds")
        .or_else(|| positive(stage, "until_seconds"))
        .unwrap_or(0.0);
    resolve_project_stage_autosave_policy(kind, &sampling, format, period).map_err(invalid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture(kind: &str, autosave: Option<Value>, storage: bool) -> (SceneDocument, Value) {
        let mut stage = json!({"kind":kind, "entrypoint_kind":"flat_relax", "until_seconds":2.0});
        if let Some(policy) = autosave {
            stage["autosave"] = policy;
        }
        let mut source = json!({"study": {
            "stages":[stage.clone()],
            "study_pipeline":{"version":"study_pipeline.v1","nodes":[{
                "id":"group", "node_kind":"group", "label":"Group", "enabled":true,
                "children":[{"id":"a", "node_kind":"primitive", "stage_kind":kind,
                    "label":"A", "source":"ui_authored", "enabled":false,
                    "payload":stage.clone()}]
            }]}
        }});
        if storage {
            source["study"]["output_storage"] = json!({
                "output_dir":"/results/test.zarr","temp_dir":"/scratch","data_format":"zarr",
                "cleanup":"on_success","existing_output":"timestamp"
            });
        }
        let scene: SceneDocument = serde_json::from_value(source).unwrap();
        let projection = json!({"stages":[{"kind":kind,"autosave":stage.get("autosave").cloned().unwrap_or(Value::Null)}],
            "study_pipeline":scene.study.study_pipeline});
        (scene, projection)
    }

    #[test]
    fn default_relax_policy_matches_flat_and_nested_disabled_pipeline_without_mutating_source() {
        let (scene, mut projected) = fixture("relax", None, true);
        let before = serde_json::to_value(&scene).unwrap();
        normalize_project_output_projection(&scene, &mut projected).unwrap();
        let policy = &projected["stages"][0]["autosave"];
        assert_eq!(policy["fields"][0]["quantity"], "m");
        assert_eq!(policy["fields"][0]["every_steps"], 100);
        assert_eq!(policy["format"], "zarr");
        assert_eq!(policy["target"], "results");
        assert_eq!(
            *policy,
            projected["study_pipeline"]["nodes"][0]["children"][0]["payload"]["autosave"]
        );
        assert_eq!(
            projected["study_pipeline"]["nodes"][0]["children"][0]["enabled"],
            false
        );
        assert_eq!(serde_json::to_value(&scene).unwrap(), before);
    }

    #[test]
    fn clearing_a_custom_override_still_inherits_the_configured_project_writer() {
        let (scene, mut projected) = fixture("relax", Some(Value::Null), true);
        normalize_project_output_projection(&scene, &mut projected).unwrap();
        assert_eq!(
            projected["stages"][0]["autosave"]["fields"][0]["every_steps"],
            100
        );
        assert_eq!(scene.study.stages[0].extra["autosave"], Value::Null);
    }

    #[test]
    fn absence_without_project_storage_does_not_invent_a_policy() {
        let (scene, mut projected) = fixture("relax", None, false);
        let before = projected.clone();
        normalize_project_output_projection(&scene, &mut projected).unwrap();
        assert_eq!(projected, before);
    }

    fn policy(cadence: u64, format: &str) -> Value {
        json!({"kind":"stage_autosave","target":"custom","layout":"separate","format":format,
            "fields":[{"kind":"field_autosave","quantity":"m","every_steps":cadence}]})
    }

    #[test]
    fn custom_cadence_is_retained_and_stays_distinguishable() {
        let (scene, mut projected) = fixture("relax", Some(policy(7, "zarr")), true);
        normalize_project_output_projection(&scene, &mut projected).unwrap();
        assert_eq!(
            projected["stages"][0]["autosave"]["fields"][0]["every_steps"],
            7
        );
        assert_eq!(projected["stages"][0]["autosave"]["target"], "custom");
        let (changed, mut other) = fixture("relax", Some(policy(9, "zarr")), true);
        normalize_project_output_projection(&changed, &mut other).unwrap();
        assert_ne!(projected, other);
    }

    #[test]
    fn conflicting_format_is_still_rejected() {
        let (scene, mut projected) = fixture("relax", Some(policy(7, "hdf5")), true);
        assert!(normalize_project_output_projection(&scene, &mut projected)
            .unwrap_err()
            .message
            .contains("format"));
    }

    #[test]
    fn explicit_time_cadence_and_existing_outputs_keep_their_clocks() {
        let (mut scene, mut projected) = fixture("run", None, true);
        scene.study.stages[0]
            .extra
            .insert("output_every_seconds".into(), json!(0.25));
        projected["study_pipeline"] = Value::Null;
        normalize_project_output_projection(&scene, &mut projected).unwrap();
        assert_eq!(
            projected["stages"][0]["autosave"]["fields"][0]["every_seconds"],
            0.25
        );
        scene.study.stages[0].extra.insert(
            "sampling".into(),
            json!({"outputs":[{
                "kind":"field","name":"m","every_seconds":0.125
            }]}),
        );
        normalize_project_output_projection(&scene, &mut projected).unwrap();
        assert_eq!(
            projected["stages"][0]["autosave"]["fields"][0]["every_seconds"],
            0.125
        );
    }

    #[test]
    fn local_table_defaults_and_explicit_table_override_keep_their_meaning() {
        let (mut scene, mut projected) = fixture("relax", None, true);
        projected["study_pipeline"] = Value::Null;
        scene.study.stages[0].extra.insert(
            "sampling".into(),
            json!({
                "table_autosave":{"every_steps":7}
            }),
        );
        normalize_project_output_projection(&scene, &mut projected).unwrap();
        let table = &projected["stages"][0]["autosave"]["table"];
        assert_eq!(table["every_steps"], 7);
        assert_eq!(
            table["quantities"],
            json!(["step", "t", "mx", "my", "mz", "e_total", "max_torque"])
        );
        let mut custom = policy(9, "zarr");
        custom["table"] = json!({"every_steps":3,"quantities":["mx"]});
        scene.study.stages[0]
            .extra
            .insert("autosave".into(), custom);
        normalize_project_output_projection(&scene, &mut projected).unwrap();
        let table = &projected["stages"][0]["autosave"]["table"];
        assert_eq!(table["every_steps"], 3);
        assert_eq!(table["quantities"], json!(["mx"]));
    }

    #[test]
    fn execution_resolved_output_does_not_replace_the_authored_default_clock() {
        let (mut scene, mut projected) = fixture("run", None, true);
        projected["study_pipeline"] = Value::Null;
        let sampling = json!({"outputs":[{
            "kind":"field_resolved_auto", "name":"m", "every_seconds":0.125,
            "requested_policy":{"kind":"auto_sinc_cutoff", "nyquist_guard_factor":1.3}
        }]});
        scene.study.stages[0]
            .extra
            .insert("sampling".into(), sampling.clone());
        normalize_project_output_projection(&scene, &mut projected).unwrap();
        assert_eq!(
            projected["stages"][0]["autosave"]["fields"][0]["every_seconds"],
            2.0
        );
        assert_eq!(scene.study.stages[0].extra["sampling"], sampling);
    }

    #[test]
    fn pipeline_kind_supplies_missing_or_empty_payload_kind() {
        for kind in [Value::Null, json!("")] {
            let (scene, mut projected) = fixture("relax", None, true);
            let payload = &mut projected["study_pipeline"]["nodes"][0]["children"][0]["payload"];
            if kind.is_null() {
                payload.as_object_mut().unwrap().remove("kind");
            } else {
                payload["kind"] = kind;
            }
            normalize_project_output_projection(&scene, &mut projected).unwrap();
            assert_eq!(
                projected["study_pipeline"]["nodes"][0]["children"][0]["payload"]["autosave"]
                    ["fields"][0]["every_steps"],
                100
            );
        }
    }

    #[test]
    fn other_study_kinds_do_not_acquire_a_magnetic_time_clock() {
        let (scene, mut projected) = fixture("eigenmodes", None, true);
        let before = projected.clone();
        normalize_project_output_projection(&scene, &mut projected).unwrap();
        assert_eq!(projected, before);
    }
}
