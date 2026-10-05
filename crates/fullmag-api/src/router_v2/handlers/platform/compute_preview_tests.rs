use super::*;
use fullmag_authoring::{StudyPipelineDocument, StudyPlan, StudyPlanMigrationDefaults};
use fullmag_ir::{ExecutionProfileIR, ProblemIR};
use fullmag_session::execution_profiles::ExecutionProfileCatalogEntry;

fn fixture() -> (ComputePreviewRequest, ExecutionProfileCatalog) {
    let pipeline: StudyPipelineDocument = serde_json::from_value(json!({
        "version": "study_pipeline.v2",
        "nodes": [
            {"node_kind":"primitive", "id":"step:one", "label":"First", "enabled":true, "stage_kind":"run", "payload":{"until_seconds":"1e-9"}},
            {"node_kind":"primitive", "id":"step:two", "label":"Second", "enabled":true, "stage_kind":"run", "payload":{"until_seconds":"1e-9"}}
        ]
    })).unwrap();
    let defaults = StudyPlanMigrationDefaults {
        model: fullmag_authoring::StudyModelReference {
            model_id: "model:one".into(),
            version: "1".into(),
        },
        solver_config: fullmag_authoring::StudySolverConfigReference {
            preset_id: "solver:default".into(),
            version: "1".into(),
        },
        discretization: fullmag_authoring::StudyDiscretizationReference {
            recipe_id: "mesh:default".into(),
            version: "1".into(),
        },
        execution_profile: fullmag_authoring::StudyExecutionProfileReference {
            profile_id: "exec:preview".into(),
            version: "1".into(),
        },
    };
    let study = StudyPlan::from_pipeline("study:preview", 2, &pipeline, &defaults).unwrap();
    let profile: ExecutionProfileIR = serde_json::from_value(json!({
        "schema_version":"execution_profile.v1", "profile_id":"exec:preview", "version":"1",
        "defaults":{"backend":"fdm", "device":"cpu"}
    }))
    .unwrap();
    let request: ComputePreviewRequest = serde_json::from_value(json!({
        "expected_profile_catalog_revision":1,
        "study_plan":study,
        "inputs":[
            {"step_id":"step:one", "problem":ProblemIR::bootstrap_example()},
            {"step_id":"step:two", "problem":ProblemIR::bootstrap_example()}
        ]
    }))
    .unwrap();
    let profiles = ExecutionProfileCatalog {
        revision: 1,
        entries: vec![ExecutionProfileCatalogEntry {
            profile_sha256: profile.canonical_sha256().unwrap(),
            profile,
            client_intent_id: "preview-profile".into(),
            published_at: "2026-10-05T00:00:00Z".into(),
            revision: 1,
        }],
        ..Default::default()
    };
    (request, profiles)
}

#[test]
fn preview_pins_catalogue_but_never_claims_admission() {
    let (request, profiles) = fixture();
    let mut reversed = request.clone();
    reversed.inputs.reverse();
    let preview = build_preview(request.clone(), profiles.clone(), "instance-one").unwrap();
    let reordered = build_preview(reversed, profiles.clone(), "instance-one").unwrap();
    assert_eq!(preview.preview_id, reordered.preview_id);
    assert_eq!(preview.source_digest, reordered.source_digest);
    assert_eq!(preview.study_catalog_sha256, reordered.study_catalog_sha256);
    assert_eq!(preview.admission_state, ComputeAdmissionState::NotEvaluated);
    assert_eq!(
        preview.blocking_reasons,
        vec!["host_admission_not_evaluated"]
    );
    assert_eq!(
        preview
            .steps
            .iter()
            .map(|step| step.step_id.as_str())
            .collect::<Vec<_>>(),
        vec!["step:one", "step:two"]
    );
    assert_eq!(
        preview.study_catalog_sha256,
        fullmag_session::canonical_json_sha256(
            &serde_json::to_value(&preview.study_problem_catalog).unwrap()
        )
    );
    let other_instance = build_preview(request, profiles, "instance-two").unwrap();
    assert_ne!(preview.preview_id, other_instance.preview_id);
}

#[test]
fn stale_revision_missing_version_and_bad_input_are_distinct() {
    let (mut request, profiles) = fixture();
    request.expected_profile_catalog_revision = 0;
    let error = build_preview(request, profiles, "instance").unwrap_err();
    assert_eq!(
        error.code.as_deref(),
        Some("execution_profile_revision_conflict")
    );
    let (mut request, _) = fixture();
    request.expected_profile_catalog_revision = 0;
    let error = build_preview(request, ExecutionProfileCatalog::default(), "instance").unwrap_err();
    assert_eq!(
        error.code.as_deref(),
        Some("execution_profile_reference_conflict")
    );
    let (mut request, profiles) = fixture();
    request.inputs.pop();
    let error = build_preview(request, profiles, "instance").unwrap_err();
    assert_eq!(error.status, axum::http::StatusCode::BAD_REQUEST);
}

#[test]
fn preview_catalogue_read_does_not_create_missing_storage() {
    let directory = tempfile::tempdir().unwrap();
    let missing = directory.path().join("never-created");
    assert_eq!(
        super::super::compute_profiles::read_validated_catalog(missing.clone())
            .unwrap()
            .revision,
        0
    );
    assert!(!missing.exists());
}
