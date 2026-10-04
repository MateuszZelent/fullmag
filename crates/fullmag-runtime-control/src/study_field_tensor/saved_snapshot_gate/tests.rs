use super::select_output;
use chrono::Utc;
use fullmag_session::{
    task_id_for_study_step, FmsArtifactCatalog, FmsArtifactCatalogEntry, FmsArtifactStatus,
    FmsStudyArtifactOutput, FmsStudyOutputManifest, FmsStudyOutputManifestEntry,
    FMS_ARTIFACT_CATALOG_SCHEMA,
};

const RUN_ID: &str = "run-1";
const STEP_ID: &str = "relax";
const ATTEMPT_ID: &str = "attempt-1";
const OWNERSHIP_EPOCH: u64 = 7;
const SOURCE_ARTIFACT_ID: &str = "artifact-state";
const SOURCE_OBJECT_REF: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn source_entry() -> FmsArtifactCatalogEntry {
    FmsArtifactCatalogEntry {
        artifact_id: SOURCE_ARTIFACT_ID.into(),
        task_id: task_id_for_study_step(RUN_ID, STEP_ID).unwrap(),
        attempt_id: ATTEMPT_ID.into(),
        ownership_epoch: OWNERSHIP_EPOCH,
        logical_path: "outputs/relax/state.json".into(),
        artifact_type: "state".into(),
        content_sha256: SOURCE_OBJECT_REF.into(),
        object_ref: Some(SOURCE_OBJECT_REF.into()),
        status: FmsArtifactStatus::Published,
        required: true,
        study_output: Some(FmsStudyArtifactOutput {
            step_id: STEP_ID.into(),
            port_id: "m-final".into(),
            case_id: "case-a".into(),
        }),
    }
}

fn catalog(entry: FmsArtifactCatalogEntry) -> FmsArtifactCatalog {
    FmsArtifactCatalog {
        schema_version: FMS_ARTIFACT_CATALOG_SCHEMA.into(),
        run_id: RUN_ID.into(),
        revision: 1,
        updated_at: Utc::now(),
        entries: vec![entry],
    }
}

fn manifest(output: FmsStudyOutputManifestEntry) -> FmsStudyOutputManifest {
    FmsStudyOutputManifest {
        schema_version: fullmag_session::FMS_STUDY_OUTPUT_MANIFEST_SCHEMA.into(),
        run_id: RUN_ID.into(),
        task_id: task_id_for_study_step(RUN_ID, STEP_ID).unwrap(),
        step_id: STEP_ID.into(),
        attempt_id: ATTEMPT_ID.into(),
        ownership_epoch: OWNERSHIP_EPOCH,
        accepted_state_ref: None,
        observation_source: None,
        outputs: vec![output],
    }
}

fn output() -> FmsStudyOutputManifestEntry {
    FmsStudyOutputManifestEntry {
        port_id: "m-final".into(),
        case_id: "case-a".into(),
        data_kind: "state".into(),
        codec_id: "fullmag.runner.field_json".into(),
        codec_version: "v1".into(),
        artifact_id: SOURCE_ARTIFACT_ID.into(),
        object_ref: SOURCE_OBJECT_REF.into(),
        content_sha256: SOURCE_OBJECT_REF.into(),
    }
}

#[test]
fn select_output_accepts_exact_historical_lineage() {
    let catalog = catalog(source_entry());
    let manifest = manifest(output());

    let selected = select_output(&catalog, &manifest, SOURCE_ARTIFACT_ID).unwrap();

    assert_eq!(selected.artifact_id, SOURCE_ARTIFACT_ID);
    assert_eq!(selected.case_id, "case-a");
}

#[test]
fn select_output_rejects_manifest_from_another_attempt() {
    let catalog = catalog(source_entry());
    let mut manifest = manifest(output());
    manifest.attempt_id = "attempt-2".into();

    let error = select_output(&catalog, &manifest, SOURCE_ARTIFACT_ID).unwrap_err();

    assert!(error
        .to_string()
        .contains("historical source attempt"));
}

#[test]
fn select_output_rejects_catalog_lineage_mismatch() {
    let mut source = source_entry();
    source.study_output.as_mut().unwrap().case_id = "case-b".into();
    let catalog = catalog(source);
    let manifest = manifest(output());

    let error = select_output(&catalog, &manifest, SOURCE_ARTIFACT_ID).unwrap_err();

    assert!(error
        .to_string()
        .contains("manifest output differs from its catalog source"));
}

#[test]
fn select_output_rejects_duplicate_source_outputs() {
    let catalog = catalog(source_entry());
    let mut manifest = manifest(output());
    manifest.outputs.push(output());

    let error = select_output(&catalog, &manifest, SOURCE_ARTIFACT_ID).unwrap_err();

    assert!(error.to_string().contains("manifest output differs"));
}
