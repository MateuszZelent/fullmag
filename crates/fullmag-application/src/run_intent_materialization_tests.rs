use super::*;
use crate::{OpaqueAsset, ProjectId, RawJsonEnvelope};
use fullmag_ir::{
    FemConnectivityIR, FemFacetConnectivityIR, FemMeshAssetIR, GeometryAssetsIR, MeshIR,
};

fn inputs() -> (
    ProjectEnvelope,
    StudyPlan,
    StudyProblemCatalog,
    RunIntentAuthoring,
) {
    let mut fixture: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/runtime/accepted-fem-preparation-run-v2.json"
    ))
    .unwrap();
    // Match the API identity fixture: planning needs an inline structural mesh,
    // but these tests neither execute nor qualify a physical FEM solution.
    fixture["study_problem_catalog"]["entries"][0]["problem"]["geometry_assets"] =
        serde_json::to_value(GeometryAssetsIR {
            fem_mesh_assets: vec![FemMeshAssetIR {
                geometry_name: "strip".into(),
                mesh_source: None,
                mesh: Some(MeshIR {
                    mesh_name: "identity-fixture".into(),
                    nodes: vec![
                        [0.0, 0.0, 0.0],
                        [1e-9, 0.0, 0.0],
                        [0.0, 1e-9, 0.0],
                        [0.0, 0.0, 1e-9],
                    ],
                    cells: FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
                    element_markers: vec![1],
                    facets: FemFacetConnectivityIR::empty(),
                    ..Default::default()
                }),
            }],
            ..Default::default()
        })
        .unwrap();
    fixture["study_problem_catalog"]["entries"][0]["problem"]["study"]["dynamics"]
        ["fixed_timestep"] = serde_json::json!(1e-15);
    let original: RunIntent = serde_json::from_value(fixture["run_intent"].clone()).unwrap();
    let authored = RunIntentAuthoring {
        run_id: original.specification.run_id,
        idempotency_key: original.idempotency_key,
        parameters: original.specification.parameters,
        seeds: original.specification.seeds,
        dependencies: original.specification.dependencies,
        scheduling_priority: original.specification.scheduling_priority,
        requested_execution: original.specification.requested_execution,
    };
    (
        ProjectEnvelope::blank(ProjectId::parse("project-submit").unwrap(), "Fixture").unwrap(),
        serde_json::from_value(fixture["study_plan"].clone()).unwrap(),
        serde_json::from_value(fixture["study_problem_catalog"].clone()).unwrap(),
        authored,
    )
}

#[test]
fn materialization_preserves_explicit_run_identity_and_stable_replay() {
    let (definition, study, catalog, mut authored) = inputs();
    authored.parameters = serde_json::json!({"drive_current_a": 0.003});
    authored.seeds.insert("initial_state".into(), 7);
    authored
        .dependencies
        .push(RunDependency::ExplicitContinuation {
            run_id: RunId::parse("previous-run").unwrap(),
        });
    authored.scheduling_priority = 7;
    let first = materialize_run_intent(
        &definition,
        &study,
        &catalog,
        authored.clone(),
        &BTreeMap::new(),
    )
    .unwrap();
    let second = materialize_run_intent(
        &definition,
        &study,
        &catalog,
        authored.clone(),
        &BTreeMap::new(),
    )
    .unwrap();
    assert_eq!(first, second);
    assert_eq!(first.specification.run_id, authored.run_id);
    assert_eq!(first.idempotency_key, authored.idempotency_key);
    assert_eq!(first.specification.parameters, authored.parameters);
    assert_eq!(first.specification.seeds, authored.seeds);
    assert_eq!(first.specification.dependencies, authored.dependencies);
    assert_eq!(
        first.specification.scheduling_priority,
        authored.scheduling_priority
    );
    assert_eq!(
        first.specification.requested_execution,
        authored.requested_execution
    );
    assert_eq!(
        first.payload_fingerprint().unwrap(),
        second.payload_fingerprint().unwrap()
    );
    assert_eq!(
        first.specification.study.plan_sha256,
        study.canonical_sha256().unwrap()
    );
    assert_eq!(
        first.specification.study_catalog_sha256,
        fullmag_ir::canonical_ir_json_sha256(&serde_json::to_value(&catalog).unwrap()).unwrap()
    );
}

#[test]
fn materialization_hashes_exact_definition_bytes_not_reencoded_json() {
    let (mut definition, study, catalog, authored) = inputs();
    let first = materialize_run_intent(
        &definition,
        &study,
        &catalog,
        authored.clone(),
        &BTreeMap::new(),
    )
    .unwrap();
    let pretty = serde_json::to_vec_pretty(definition.raw_definition.value()).unwrap();
    definition.raw_definition = RawJsonEnvelope::from_bytes(pretty.clone()).unwrap();
    let second =
        materialize_run_intent(&definition, &study, &catalog, authored, &BTreeMap::new()).unwrap();
    assert_ne!(
        first.specification.snapshot.definition_sha256,
        second.specification.snapshot.definition_sha256
    );
    assert_eq!(
        second.specification.snapshot.definition_sha256,
        format!("{:x}", Sha256::digest(pretty))
    );
}

#[test]
fn materialization_hashes_explicit_asset_bytes_and_rejects_missing_binding() {
    let (mut definition, study, catalog, authored) = inputs();
    let paths = BTreeMap::from([("conductor".into(), "project/assets/conductor.bin".into())]);
    assert!(
        materialize_run_intent(&definition, &study, &catalog, authored.clone(), &paths).is_err()
    );
    definition
        .assets
        .push(OpaqueAsset::new("project/assets/conductor.bin", b"first".to_vec(), None).unwrap());
    let first =
        materialize_run_intent(&definition, &study, &catalog, authored.clone(), &paths).unwrap();
    assert_eq!(
        first.specification.immutable_assets[0].asset_id,
        "conductor"
    );
    assert_eq!(
        first.specification.immutable_assets[0].content_sha256,
        format!("{:x}", Sha256::digest(b"first"))
    );
    definition.assets[0] =
        OpaqueAsset::new("project/assets/conductor.bin", b"other".to_vec(), None).unwrap();
    let second = materialize_run_intent(&definition, &study, &catalog, authored, &paths).unwrap();
    assert_ne!(
        first.payload_fingerprint().unwrap(),
        second.payload_fingerprint().unwrap()
    );
}

#[test]
fn materialization_rejects_execution_conflict_and_inconsistent_project_projection() {
    let (mut definition, study, catalog, mut authored) = inputs();
    authored.requested_execution.backend = "fdm".into();
    assert!(
        materialize_run_intent(&definition, &study, &catalog, authored, &BTreeMap::new()).is_err()
    );
    let (_, _, _, authored) = inputs();
    definition.definition.name = "Unsaved typed edit".into();
    assert!(
        materialize_run_intent(&definition, &study, &catalog, authored, &BTreeMap::new()).is_err()
    );
}
