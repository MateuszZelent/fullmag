use super::*;
use crate::materialize_script_pipeline_with_output_policy_bounded;
use crate::script_stage_contract::{ResolvedScriptStageAction, ScriptExecutionConfig};

fn fixture() -> ScriptExecutionConfig {
    serde_json::from_str(include_str!(
        "../../../tests/fixtures/runtime/antenna-standalone-pipeline.json"
    ))
    .unwrap()
}

#[test]
fn exact_action_plans_each_definition_without_rewriting_authored_activation() {
    let mut input = fixture();
    let mut second = input.ir.antenna_field_solve_stages[0].clone();
    second.id = "second-definition".into();
    input.ir.antenna_field_solve_stages.push(second);
    let mut pipeline = serde_json::to_value(input.study_pipeline.as_ref().unwrap()).unwrap();
    pipeline["nodes"][0]["children"][1]["payload"]["stage_id"] = "second-definition".into();
    input.study_pipeline = Some(serde_json::from_value(pipeline).unwrap());
    let compiled = materialize_script_pipeline_with_output_policy_bounded(
        input,
        fullmag_ir::configure_project_autosave_policy,
        2,
    )
    .unwrap();
    for (index, expected) in ["inspect_antenna", "second-definition"].iter().enumerate() {
        let stage = &compiled.executions[index].stage;
        assert_eq!(stage.ir.antenna_field_solve_stages.iter().map(|definition| definition.id.as_str()).collect::<Vec<_>>(), vec!["inspect_antenna", "second-definition"]);
        let before = serde_json::to_value(&stage.ir).unwrap();
        let Some(ResolvedScriptStageAction::AntennaExternalLeadInspection {
            input,
            requested_execution,
            output_id,
        }) = &stage.action
        else {
            panic!("expected raw inspection action")
        };
        let plan = plan_script_antenna_inspection(&stage.ir, input, requested_execution, output_id)
            .unwrap();
        let BackendPlanIR::AntennaExternalLeadInspection(resolved) = &plan.backend_plan else {
            panic!("expected raw inspection plan")
        };
        assert_eq!(resolved.input.stage.id, *expected);
        assert_eq!(&resolved.input, input);
        assert_eq!(&resolved.requested_execution, requested_execution);
        assert_eq!(&resolved.output_id, output_id);
        assert!(plan.common.material_field_plans.is_empty());
        assert!(plan.provenance.integrator_resolution.is_none());
        assert_eq!(serde_json::to_value(&stage.ir).unwrap(), before);
        // The canonical snapshot now carries the exact physical selection,
        // so catalog and accepted-worker replanning need no script action.
        assert_eq!(serde_json::to_value(fullmag_plan::plan(&stage.ir).unwrap()).unwrap(), serde_json::to_value(&plan).unwrap());
        let fullmag_ir::StudyIR::AntennaFieldSolve { selection: Some(selection), .. } = &stage.ir.study else {
            panic!("standalone snapshot must retain its selected definition and port")
        };
        assert_eq!(selection.stage_id, *expected);
        assert_eq!(selection.port_mode_id, "port");
        let pinned = fullmag_plan::capture_study_input_references("source", &stage.ir).unwrap();
        let mut changed = stage.ir.clone();
        let fullmag_ir::StudyIR::AntennaFieldSolve { selection: Some(changed_selection), .. } = &mut changed.study else {
            unreachable!()
        };
        changed_selection.stage_id = if index == 0 { "second-definition" } else { "inspect_antenna" }.into();
        let changed_pin = fullmag_plan::capture_study_input_references("source", &changed).unwrap();
        assert_ne!(pinned.identity.problem_sha256, changed_pin.identity.problem_sha256);
    }
}

#[test]
fn stale_input_execution_and_output_are_rejected_independently() {
    let compiled = materialize_script_pipeline_with_output_policy_bounded(
        fixture(),
        fullmag_ir::configure_project_autosave_policy,
        2,
    )
    .unwrap();
    let stage = &compiled.executions[0].stage;
    let Some(ResolvedScriptStageAction::AntennaExternalLeadInspection {
        input,
        requested_execution,
        output_id,
    }) = &stage.action
    else {
        panic!("expected raw inspection action")
    };
    plan_script_antenna_inspection(&stage.ir, input, requested_execution, output_id).unwrap();
    let mut stale_input = input.clone();
    stale_input.conductivity_spm_per_element[0] *= 2.0;
    let mut stale_execution = requested_execution.clone();
    stale_execution.precision = fullmag_ir::ExecutionPrecision::Single;
    for (input, execution, output) in [
        (&stale_input, requested_execution, output_id.as_str()),
        (input, &stale_execution, output_id.as_str()),
        (input, requested_execution, "other-output"),
    ] {
        assert!(
            plan_script_antenna_inspection(&stage.ir, input, execution, output)
                .unwrap_err()
                .to_string()
                .contains("differs from the actual selected")
        );
    }
}
