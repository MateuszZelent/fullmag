use super::*;
use crate::script_stage_contract::ResolvedScriptStageAction;
use crate::script_stage_contract::ScriptAntennaAuthoringInventory;
use fullmag_ir::ProblemIR;
use serde_json::json;

#[test]
fn standalone_antenna_pipeline_replans_without_conflating_authored_and_physical_ids() {
    let input: ScriptExecutionConfig = serde_json::from_str(include_str!(
        "../../../tests/fixtures/runtime/antenna-standalone-pipeline.json"
    ))
    .unwrap();
    let expected_plan = serde_json::to_value(fullmag_plan::plan(&input.ir).unwrap()).unwrap();
    let compiled = materialize_script_pipeline_with_output_policy_bounded(
        input,
        fullmag_ir::configure_project_autosave_policy,
        2,
    )
    .unwrap();
    assert_eq!(compiled.executions.len(), 2);
    assert_ne!(
        compiled.executions[0].execution_id,
        compiled.executions[1].execution_id
    );
    assert!(compiled.nodes[0].execution_ids.is_empty());
    for (index, owner) in ["first-inspection", "repeat-inspection"].iter().enumerate() {
        let execution = &compiled.executions[index];
        let stage = &execution.stage;
        let provenance = stage.provenance.as_ref().unwrap();
        assert_eq!(provenance.authored_step_id, *owner);
        assert_eq!(provenance.ancestor_group_ids, vec!["antenna-group"]);
        assert_eq!(provenance.expansion_index, 0);
        assert_eq!(
            stage.ir.problem_meta.runtime_metadata["active_stage_id"],
            *owner
        );
        assert_eq!(stage.until_seconds, 0.0);
        assert!(stage.ir.magnets.is_empty());
        assert!(stage.ir.energy_terms.is_empty());
        assert_eq!(stage.ir.antenna_field_solve_stages.len(), 1);
        let Some(ResolvedScriptStageAction::AntennaExternalLeadInspection {
            input, output_id, ..
        }) = &stage.action
        else {
            panic!("raw external-lead inspection must not become a field basis or LLG stage");
        };
        assert_eq!(input.stage.id, "inspect_antenna");
        assert_eq!(input.port.id, "port");
        assert_eq!(output_id, "inspection");
        let plan = fullmag_plan::plan(&stage.ir).unwrap();
        assert_eq!(serde_json::to_value(plan).unwrap(), expected_plan);
        assert_eq!(
            compiled.nodes[index + 1].execution_ids,
            vec![execution.execution_id.clone()]
        );
    }
}

fn config() -> ScriptExecutionConfig {
    ScriptExecutionConfig {
        ir: ProblemIR::bootstrap_example(),
        antenna_inventory: ScriptAntennaAuthoringInventory::default(),
        shared_geometry_assets: None,
        default_until_seconds: None,
        study_pipeline: Some(serde_json::from_value(json!({
            "version": "study_pipeline.v1",
            "nodes": [
                {"node_kind": "group", "id": "outer", "label": "Outer", "children": [
                    {"node_kind": "primitive", "id": "current", "label": "Current", "stage_kind": "set_current",
                     "payload": {"current_density": 123.0, "direction": [0, 1, 0]}},
                    {"node_kind": "macro", "id": "macro", "label": "Relax and run", "macro_kind": "relax_run",
                     "config": {"run_until_seconds": 1e-12}}
                ]},
                {"node_kind": "group", "id": "off", "label": "Off", "enabled": false, "children": [
                    {"node_kind": "primitive", "id": "off-child", "label": "Not executed", "stage_kind": "unsupported"}
                ]},
                {"node_kind": "primitive", "id": "trailing-current", "label": "Trailing edit", "stage_kind": "set_current",
                 "payload": {"current_density": 456.0}}
            ]
        })).unwrap()),
        stages: Vec::new(),
    }
}

#[test]
fn compilation_preserves_the_tree_without_fictitious_group_or_mutator_execution() {
    let input = config();
    let authored = serde_json::to_value(input.study_pipeline.as_ref().unwrap()).unwrap();
    let compiled = materialize_script_pipeline_with_output_policy_bounded(
        input,
        fullmag_ir::configure_project_autosave_policy,
        2,
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(&compiled.authored_pipeline).unwrap(),
        authored
    );
    assert_eq!(
        compiled.authored_pipeline_sha256,
        fullmag_ir::canonical_ir_json_sha256(&authored).unwrap()
    );
    assert_eq!(
        compiled
            .nodes
            .iter()
            .map(|node| node.authored_step_id.as_str())
            .collect::<Vec<_>>(),
        vec![
            "outer",
            "current",
            "macro",
            "off",
            "off-child",
            "trailing-current"
        ]
    );
    assert_eq!(compiled.executions.len(), 2);
    for node in &compiled.nodes {
        if node.authored_step_id != "macro" {
            assert!(node.execution_ids.is_empty());
        }
        if node.authored_step_id == "off" || node.authored_step_id == "off-child" {
            assert!(!node.effectively_enabled);
        }
    }
    let owner = &compiled.nodes[2];
    assert_eq!(owner.ancestor_group_ids, vec!["outer"]);
    assert_eq!(owner.execution_ids.len(), 2);
    assert_ne!(owner.execution_ids[0], owner.execution_ids[1]);
    for (index, execution) in compiled.executions.iter().enumerate() {
        assert_eq!(execution.execution_id, owner.execution_ids[index]);
        assert_eq!(execution.stage.ir.current_density, Some([0.0, 123.0, 0.0]));
        assert_eq!(
            execution.stage.ir.problem_meta.runtime_metadata["active_stage_id"],
            "macro"
        );
        assert_eq!(
            execution.stage.provenance.as_ref().unwrap().expansion_index,
            index
        );
    }
}

#[test]
fn execution_ids_are_deterministic_and_not_changed_by_presentation_edits() {
    let first = materialize_script_pipeline_with_output_policy_bounded(
        config(),
        fullmag_ir::configure_project_autosave_policy,
        2,
    )
    .unwrap();
    let mut edited = config();
    if let StudyPipelineNode::Group { label, .. } =
        &mut edited.study_pipeline.as_mut().unwrap().nodes[0]
    {
        *label = "Renamed group".into();
    }
    let second = materialize_script_pipeline_with_output_policy_bounded(
        edited,
        fullmag_ir::configure_project_autosave_policy,
        2,
    )
    .unwrap();
    assert_ne!(
        first.authored_pipeline_sha256,
        second.authored_pipeline_sha256
    );
    assert_eq!(
        first
            .executions
            .iter()
            .map(|item| &item.execution_id)
            .collect::<Vec<_>>(),
        second
            .executions
            .iter()
            .map(|item| &item.execution_id)
            .collect::<Vec<_>>()
    );
}

#[test]
fn execution_ids_are_portable_even_when_authored_ids_are_not_path_components() {
    let mut input = config();
    let authored_id = "antenna/źródło:CON";
    if let StudyPipelineNode::Group { children, .. } =
        &mut input.study_pipeline.as_mut().unwrap().nodes[0]
    {
        if let StudyPipelineNode::Macro { id, .. } = &mut children[1] {
            *id = authored_id.into();
        }
    }
    let compiled = materialize_script_pipeline_with_output_policy_bounded(
        input,
        fullmag_ir::configure_project_autosave_policy,
        2,
    )
    .unwrap();
    assert_eq!(compiled.executions.len(), 2);
    assert_eq!(compiled.nodes[2].authored_step_id, authored_id);
    for execution in &compiled.executions {
        let digest = execution
            .execution_id
            .strip_prefix("script-execution-")
            .unwrap();
        assert_eq!(digest.len(), 64);
        assert!(digest.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert!(execution.execution_id.len() <= 200);
        assert!(execution
            .execution_id
            .bytes()
            .all(|byte| { byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.') }));
        assert_eq!(
            execution
                .stage
                .provenance
                .as_ref()
                .unwrap()
                .authored_step_id,
            authored_id
        );
    }
}

#[test]
fn compilation_rejects_duplicate_authored_identity_and_missing_pipeline() {
    let mut input = config();
    let duplicate = input.study_pipeline.as_ref().unwrap().nodes[0].clone();
    input.study_pipeline.as_mut().unwrap().nodes.push(duplicate);
    assert!(materialize_script_pipeline_with_output_policy_bounded(
        input,
        fullmag_ir::configure_project_autosave_policy,
        2,
    )
    .unwrap_err()
    .to_string()
    .contains("duplicate study pipeline node id"));
    let mut missing = config();
    missing.study_pipeline = None;
    assert!(materialize_script_pipeline_with_output_policy_bounded(
        missing,
        fullmag_ir::configure_project_autosave_policy,
        2,
    )
    .unwrap_err()
    .to_string()
    .contains("requires an authored study_pipeline"));
}

#[test]
fn empty_and_disabled_pipelines_do_not_create_a_legacy_solver_execution() {
    for nodes in [
        json!([]),
        json!([{
            "node_kind": "group", "id": "off", "label": "Off", "enabled": false,
            "children": [{"node_kind": "primitive", "id": "child", "label": "Child", "stage_kind": "unsupported"}]
        }]),
    ] {
        let mut input = config();
        input.study_pipeline = Some(
            serde_json::from_value(json!({
                "version": "study_pipeline.v1", "nodes": nodes,
            }))
            .unwrap(),
        );
        let compiled = materialize_script_pipeline_with_output_policy_bounded(
            input,
            fullmag_ir::configure_project_autosave_policy,
            1,
        )
        .unwrap();
        assert!(compiled.executions.is_empty());
        assert!(compiled
            .nodes
            .iter()
            .all(|node| node.execution_ids.is_empty()));
    }
}

#[test]
fn compilation_preserves_the_existing_macro_expansion_budget() {
    let error = materialize_script_pipeline_with_output_policy_bounded(
        config(),
        fullmag_ir::configure_project_autosave_policy,
        1,
    )
    .unwrap_err();
    assert!(format!("{error:#}").contains("preview limit of 1 stages"));
}

#[test]
fn primitive_after_macro_owns_its_execution_and_updated_model() {
    let mut input = config();
    input.study_pipeline.as_mut().unwrap().nodes.push(
        serde_json::from_value(json!({
            "node_kind": "primitive", "id": "later", "label": "Later", "stage_kind": "relax",
        }))
        .unwrap(),
    );
    let compiled = materialize_script_pipeline_with_output_policy_bounded(
        input,
        fullmag_ir::configure_project_autosave_policy,
        3,
    )
    .unwrap();
    assert_eq!(compiled.executions.len(), 3);
    let later = &compiled.executions[2];
    assert_eq!(later.stage.ir.current_density, Some([456.0, 0.0, 0.0]));
    assert_eq!(
        later.stage.ir.problem_meta.runtime_metadata["active_stage_id"],
        "later"
    );
    assert_eq!(later.stage.provenance.as_ref().unwrap().expansion_index, 0);
    assert_eq!(
        compiled.nodes.last().unwrap().execution_ids,
        vec![later.execution_id.clone()]
    );
    assert!(compiled.nodes[2]
        .execution_ids
        .iter()
        .all(|id| id != &later.execution_id));
}

#[test]
fn compilation_rejects_ambiguous_explicit_and_pipeline_inputs() {
    let mut input = config();
    input.stages.push(
        serde_json::from_value(json!({
            "ir": ProblemIR::bootstrap_example(),
            "entrypoint_kind": "explicit",
            "default_until_seconds": 1e-12,
        }))
        .unwrap(),
    );
    assert!(materialize_script_pipeline_with_output_policy_bounded(
        input,
        fullmag_ir::configure_project_autosave_policy,
        3,
    )
    .unwrap_err()
    .to_string()
    .contains("cannot mix explicit stages with study_pipeline"));
}

// These regressions use the actual explicit materializer; they do not replay snapshots from the final base.
fn physical_snapshots() -> ScriptExecutionConfig {
    let base=ProblemIR::bootstrap_example();
    let mut first=crate::script_stage_materialization::materialize_pipeline_relax(&base,&std::collections::BTreeMap::from([
        ("max_steps".into(),json!(4)),("fixed_timestep".into(),json!(1e-14))])).unwrap().ir;
    first.current_density=Some([1.0,0.0,0.0]);first.problem_meta.runtime_metadata.insert("active_stage_id".into(),json!("relax"));
    let mut second=base;second.current_density=Some([2.0,0.0,0.0]);second.problem_meta.runtime_metadata.insert("active_stage_id".into(),json!("run"));
    ScriptExecutionConfig {ir:second.clone(),antenna_inventory:Default::default(),shared_geometry_assets:None,default_until_seconds:Some(1e-12),
        study_pipeline:Some(serde_json::from_value(json!({"version":"study_pipeline.v1","nodes":[
            {"node_kind":"primitive","id":"relax","label":"Relax","stage_kind":"relax","payload":{"max_steps":4}},
            {"node_kind":"primitive","id":"run","label":"Run","stage_kind":"run","payload":{"until_seconds":1e-12}}
        ]})).unwrap()),stages:vec![
            crate::script_stage_contract::ScriptExecutionStage{ir:first,default_until_seconds:None,entrypoint_kind:"flat_relax".into(),action:None},
            crate::script_stage_contract::ScriptExecutionStage{ir:second,default_until_seconds:Some(1e-12),entrypoint_kind:"flat_run".into(),action:None},
        ]}
}
#[test]
fn explicit_physical_snapshots_preserve_earlier_state_and_provenance() {
    let compiled=materialize_script_pipeline_with_output_policy_bounded(physical_snapshots(),fullmag_ir::configure_project_autosave_policy,2).unwrap();
    assert_eq!(compiled.executions.len(),2);
    assert!(matches!(compiled.executions[0].stage.ir.study,fullmag_ir::StudyIR::Relaxation{..}));
    assert_eq!(compiled.executions[0].stage.ir.current_density,Some([1.0,0.0,0.0]));
    assert_eq!(compiled.executions[1].stage.ir.current_density,Some([2.0,0.0,0.0]));
    assert_eq!(compiled.executions[0].stage.provenance.as_ref().unwrap().authored_step_id,"relax");
    assert_eq!(compiled.executions[1].stage.provenance.as_ref().unwrap().authored_step_id,"run");
}
#[test]
fn explicit_physical_snapshots_refuse_unknown_duplicate_disabled_and_kind_mismatch() {
    let mut unknown=physical_snapshots();unknown.stages[0].ir.problem_meta.runtime_metadata.insert("active_stage_id".into(),json!("unknown"));
    let mut duplicate=physical_snapshots();duplicate.stages[1].ir.problem_meta.runtime_metadata.insert("active_stage_id".into(),json!("relax"));
    let mut disabled=physical_snapshots();if let StudyPipelineNode::Primitive{enabled,..}=&mut disabled.study_pipeline.as_mut().unwrap().nodes[0] {*enabled=false;}
    let mut mismatch=physical_snapshots();mismatch.stages[0].ir.study=mismatch.stages[1].ir.study.clone();
    let mut missing=physical_snapshots();missing.stages.remove(0);
    for config in [unknown,duplicate,disabled,mismatch,missing] {
        assert!(materialize_script_pipeline_with_output_policy_bounded(config,fullmag_ir::configure_project_autosave_policy,2).is_err());
    }
}
#[test]
fn explicit_physical_snapshots_refuse_unknown_version_and_authored_duplicate() {
    let mut version=physical_snapshots();version.study_pipeline.as_mut().unwrap().version="future".into();
    let mut duplicate=physical_snapshots();let pipeline=duplicate.study_pipeline.as_mut().unwrap();pipeline.nodes.push(pipeline.nodes[0].clone());
    for config in [version,duplicate] {assert!(materialize_script_pipeline_with_output_policy_bounded(config,fullmag_ir::configure_project_autosave_policy,3).is_err());}
}

// These tests isolate the dual-representation coverage gate. Actual operation
// planning remains owned by the existing explicit antenna materializer.
fn antenna_action_snapshots() -> ScriptExecutionConfig {
    use crate::script_stage_contract::{ScriptExecutionStage, ScriptExecutionStageAction};
    let mut input = config();
    input.study_pipeline = Some(serde_json::from_value(json!({
        "version": "study_pipeline.v1", "nodes": [
            {"node_kind": "primitive", "id": "first-owner", "label": "First", "stage_kind": "antenna_field_solve",
                "payload": {"stage_id": "first-definition", "port_mode_id": "first-port"}},
            {"node_kind": "primitive", "id": "second-owner", "label": "Second", "stage_kind": "antenna_field_solve",
                "payload": {"stage_id": "second-definition", "port_mode_ids": ["second-port"]}}
        ]
    })).unwrap());
    input.stages = [("first-owner", "first-definition", "first-port"),
        ("second-owner", "second-definition", "second-port")].into_iter().map(|(owner, definition, port)| {
        let mut ir = input.ir.clone();
        ir.problem_meta.runtime_metadata.insert("active_stage_id".into(), json!(owner));
        // Closed-loop capture precedes the action and legitimately retains its
        // pre-action TimeEvolution StudyIR; this is not a synthetic LLG step.
        ScriptExecutionStage { ir, default_until_seconds: None,
            entrypoint_kind: "flat_antenna_field_solve".into(),
            action: Some(ScriptExecutionStageAction::AntennaFieldSolve {
                stage_id: definition.into(), port_mode_id: None, port_mode_ids: vec![port.into()],
            }) }
    }).collect();
    input
}

fn validate_snapshot_gate(input: &ScriptExecutionConfig) -> Result<()> {
    let document = input.study_pipeline.as_ref().unwrap();
    let mut nodes = Vec::new();
    collect_node_bindings(&document.nodes, &[], true, &mut nodes);
    validate_physical_snapshot_coverage(document, &nodes, input)
}

#[test]
fn antenna_action_snapshots_match_exact_selection_without_conflating_owner_id() {
    assert!(validate_snapshot_gate(&antenna_action_snapshots()).is_ok());
    assert!(validate_snapshot_gate(&physical_snapshots()).is_ok());
}

#[test]
fn antenna_action_snapshots_reject_mismatched_selection_and_action() {
    use crate::script_stage_contract::ScriptExecutionStageAction;
    let mut wrong_stage = antenna_action_snapshots();
    if let Some(ScriptExecutionStageAction::AntennaFieldSolve { stage_id, .. }) = &mut wrong_stage.stages[0].action {
        *stage_id = "second-definition".into();
    }
    let mut wrong_port = antenna_action_snapshots();
    if let Some(ScriptExecutionStageAction::AntennaFieldSolve { port_mode_ids, .. }) = &mut wrong_port.stages[0].action {
        *port_mode_ids = vec!["second-port".into()];
    }
    let mut ambiguous_port = antenna_action_snapshots();
    if let Some(ScriptExecutionStageAction::AntennaFieldSolve { port_mode_id, .. }) = &mut ambiguous_port.stages[0].action {
        *port_mode_id = Some("first-port".into());
    }
    let mut unknown_payload = antenna_action_snapshots();
    if let StudyPipelineNode::Primitive { payload, .. } = &mut unknown_payload.study_pipeline.as_mut().unwrap().nodes[0] {
        payload.insert("unknown".into(), json!(true));
    }
    let mut wrong_action = antenna_action_snapshots();
    wrong_action.stages[0].action = Some(ScriptExecutionStageAction::ChangeDevice { device: "cpu".into() });
    let mut missing_action = antenna_action_snapshots();
    missing_action.stages[0].action = None;
    for input in [wrong_stage, wrong_port, ambiguous_port, unknown_payload, wrong_action, missing_action] {
        assert!(validate_snapshot_gate(&input).is_err());
    }
}

#[test]
fn antenna_action_snapshots_preserve_complete_ordered_enabled_coverage() {
    let mut missing = antenna_action_snapshots(); missing.stages.pop();
    let mut duplicate = antenna_action_snapshots(); duplicate.stages[1] = duplicate.stages[0].clone();
    let mut disabled = antenna_action_snapshots();
    if let StudyPipelineNode::Primitive { enabled, .. } = &mut disabled.study_pipeline.as_mut().unwrap().nodes[0] { *enabled = false; }
    let mut reordered = antenna_action_snapshots(); reordered.stages.swap(0, 1);
    for input in [missing, duplicate, disabled, reordered] { assert!(validate_snapshot_gate(&input).is_err()); }
}
