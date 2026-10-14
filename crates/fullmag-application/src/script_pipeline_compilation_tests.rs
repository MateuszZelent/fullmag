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
