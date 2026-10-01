use super::*;
use crate::solution_tensor_field::{TensorFieldBinding, TENSOR_FIELD_BINDING_SCHEMA};
use crate::{FmsRunIntent, TensorChunk};
use fullmag_quantities::{
    MaterializedDatasetRef, ScientificAssessment, ScientificAssessmentStatus,
    SolutionExecutionStatus, SolutionMember, SolutionSetManifestState, SolutionSetProvenance,
};
use std::collections::HashMap;

fn geometry() -> SavedFemP1FieldGeometry {
    let mesh = MeshIR::from_legacy_tet4(
        "saved-tet".into(),
        vec![[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.]],
        vec![[0, 1, 2, 3]],
        vec![1],
        vec![[0, 2, 1], [0, 1, 3], [1, 2, 3], [2, 0, 3]],
        vec![1; 4],
        vec![],
        vec![],
        HashMap::new(),
    );
    let semantics = FemP1MagnetizationFieldSemantics::new(
        &mesh.topology_fingerprint_v6(),
        mesh.nodes.len(),
        vec![true; 4],
    )
    .unwrap();
    SavedFemP1FieldGeometry {
        schema_version: FEM_P1_GEOMETRY_SCHEMA.into(),
        coordinate_unit: "m".into(),
        representation_evidence: SavedFieldRepresentationEvidence::NotVerified,
        mesh,
        field_semantics: semantics,
    }
}

fn payload_ref(bytes: &[u8]) -> SavedFieldGeometryRef {
    SavedFieldGeometryRef {
        schema_id: FEM_P1_GEOMETRY_SCHEMA.into(),
        object_ref: crate::hex_sha256(bytes),
        byte_length: bytes.len() as u64,
    }
}

fn solution(artifact: SolutionArtifactRef, run_spec_digest: String) -> SolutionSet {
    let assessment = ScientificAssessment {
        status: ScientificAssessmentStatus::Unassessed,
        reason: Some("source fixture is not scientific qualification".into()),
        evidence_artifact_ids: vec![],
    };
    let digest = format!("sha256:{}", "d".repeat(64));
    SolutionSet {
        schema_version: "1.0.0".into(),
        solution_set_id: "saved-geometry-solution".into(),
        revision: 1,
        run_id: "saved-geometry-run".into(),
        manifest_state: SolutionSetManifestState::Open,
        execution_status: SolutionExecutionStatus::Running,
        scientific_assessment: assessment.clone(),
        provenance: SolutionSetProvenance {
            run_spec_digest,
            model_digest: digest.clone(),
            physics_digest: digest.clone(),
            discretization_digest: digest.clone(),
            resolved_plan_digest: digest.clone(),
            acquisition_digest: digest,
            seed_digest: None,
        },
        members: vec![SolutionMember {
            member_id: "member".into(),
            task_id: "task".into(),
            attempt_id: "attempt".into(),
            ownership_epoch: 1,
            case_id: Some("case".into()),
            stage_id: "step".into(),
            execution_status: SolutionExecutionStatus::Running,
            scientific_assessment: assessment,
            artifacts: vec![artifact],
        }],
        coverage: vec![],
    }
}

struct Fixture {
    _directory: tempfile::TempDir,
    store: SessionStore,
    solution: SolutionSet,
    geometry_artifact: SolutionArtifactRef,
    intent: FmsRunIntent,
}

fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let store = SessionStore::open(directory.path().join("store")).unwrap();
    let intent = FmsRunIntent::new(
        "saved-geometry-run",
        "saved-geometry-intent",
        serde_json::json!({"run_id":"saved-geometry-run"}),
    );
    store.commit_run_intent(&intent).unwrap();
    let geometry = geometry();
    let mut tensor =
        TensorDescriptor::new_f64("m", vec![4, 3], vec!["node".into(), "component".into()]);
    tensor.field_binding = Some(TensorFieldBinding {
        format: TENSOR_FIELD_BINDING_SCHEMA.into(),
        dataset: MaterializedDatasetRef {
            dataset_id: "dataset".into(),
            revision: 1,
        },
        sample_id: "sample".into(),
        item_id: "item".into(),
        field_id: "field:m".into(),
        group_id: "group".into(),
        producer_id: geometry.field_semantics.producer_id.clone(),
        producer_version: geometry.field_semantics.producer_version.clone(),
        plane: DatasetSlicePlane::Values,
        descriptor: geometry.field_semantics.descriptor.clone(),
    });
    let object_ref = store.cas().put(&vec![0; 96]).unwrap();
    tensor.chunks.push(TensorChunk {
        object_ref: object_ref.clone(),
        offset: 0,
        length: 96,
        sha256: Some(object_ref),
    });
    let bytes = serde_json::to_vec(&tensor).unwrap();
    let artifact = SolutionArtifactRef {
        artifact_id: "tensor".into(),
        schema_id: SOLUTION_TENSOR_SCHEMA.into(),
        kind: SolutionArtifactKind::State,
        object_ref: store.cas().put(&bytes).unwrap(),
        byte_length: bytes.len() as u64,
        accepted_state: None,
    };
    let mut owner = solution(
        artifact.clone(),
        format!("sha256:{}", intent.payload_sha256),
    );
    let geometry_artifact = build_solution_field_geometry_artifact(
        store.cas(),
        &owner,
        "member",
        &artifact,
        &geometry.mesh,
        &geometry.field_semantics,
    )
    .unwrap();
    owner.members[0].artifacts.push(geometry_artifact.clone());
    Fixture {
        _directory: directory,
        store,
        solution: owner,
        geometry_artifact,
        intent,
    }
}

fn archive_documents(fixture: &Fixture) -> HashMap<String, Vec<u8>> {
    let directory = crate::hex_sha256(fixture.solution.solution_set_id.as_bytes());
    let bytes = serde_json::to_vec(&fixture.solution).unwrap();
    let mut documents = HashMap::from([
        (
            format!("solutions/{directory}/manifest.json"),
            bytes.clone(),
        ),
        (
            format!(
                "solutions/{directory}/revisions/{:020}.json",
                fixture.solution.revision
            ),
            bytes,
        ),
        (
            format!("runs/{}/run_intent.json", fixture.solution.run_id),
            serde_json::to_vec(&fixture.intent).unwrap(),
        ),
    ]);
    let manifest =
        read_solution_field_geometry_manifest(fixture.store.cas(), &fixture.geometry_artifact)
            .unwrap();
    for hash in fixture.solution.members[0]
        .artifacts
        .iter()
        .map(|artifact| artifact.object_ref.clone())
        .chain([manifest.geometry.object_ref.clone()])
    {
        documents.insert(
            format!("objects/sha256/{hash}"),
            fixture.store.cas().get(&hash).unwrap().unwrap(),
        );
    }
    let tensor =
        read_solution_tensor_artifact(fixture.store.cas(), &manifest.tensor_artifact).unwrap();
    for chunk in tensor.chunks {
        documents.insert(
            format!("objects/sha256/{}", chunk.object_ref),
            fixture.store.cas().get(&chunk.object_ref).unwrap().unwrap(),
        );
    }
    documents
}

#[test]
fn pinned_geometry_reader_uses_exact_revision_and_keeps_unverified_evidence() {
    let fixture = fixture();
    fixture
        .store
        .publish_solution_set(&fixture.solution)
        .unwrap();
    let manifest =
        read_solution_field_geometry_manifest(fixture.store.cas(), &fixture.geometry_artifact)
            .unwrap();
    let mut later = fixture.solution.clone();
    later.revision = 2;
    fixture.store.publish_solution_set(&later).unwrap();
    let (read_manifest, geometry) =
        read_pinned_solution_field_geometry(&fixture.store, &manifest.source)
            .unwrap()
            .unwrap();
    assert_eq!(read_manifest, manifest);
    assert_eq!(read_manifest.source.solution_revision, 1);
    assert_eq!(
        geometry.representation_evidence,
        SavedFieldRepresentationEvidence::NotVerified
    );
    let mut foreign = manifest.source;
    foreign.run_id = "foreign-run".into();
    assert!(read_pinned_solution_field_geometry(&fixture.store, &foreign).is_err());
}

#[test]
fn pinned_geometry_reader_reports_absent_binding_without_live_fallback() {
    let mut fixture = fixture();
    let manifest =
        read_solution_field_geometry_manifest(fixture.store.cas(), &fixture.geometry_artifact)
            .unwrap();
    fixture.solution.members[0]
        .artifacts
        .retain(|artifact| artifact.schema_id != SOLUTION_FIELD_GEOMETRY_SCHEMA);
    fixture
        .store
        .publish_solution_set(&fixture.solution)
        .unwrap();
    assert!(
        read_pinned_solution_field_geometry(&fixture.store, &manifest.source)
            .unwrap()
            .is_none()
    );
}

#[test]
fn parser_rejects_unknown_mesh_fields_false_native_evidence_and_foreign_support() {
    let geometry = geometry();
    let bytes = serde_json::to_vec(&geometry).unwrap();
    assert_eq!(
        parse_saved_fem_p1_geometry(&bytes, &payload_ref(&bytes)).unwrap(),
        geometry
    );
    for field in ["unknown_mesh_field", "representation_evidence", "support"] {
        let mut value = serde_json::to_value(&geometry).unwrap();
        match field {
            "unknown_mesh_field" => value["mesh"]["invented"] = serde_json::json!(true),
            "representation_evidence" => {
                value["representation_evidence"] = serde_json::json!("verified")
            }
            _ => value["field_semantics"]["active_node_mask"][0] = serde_json::json!(false),
        }
        let bytes = serde_json::to_vec(&value).unwrap();
        assert!(parse_saved_fem_p1_geometry(&bytes, &payload_ref(&bytes)).is_err());
    }
    let mut invalid = geometry.clone();
    invalid.mesh.nodes[0][0] = f64::NAN;
    assert!(invalid.validate().is_err());
}

#[test]
fn publication_and_walkers_keep_the_complete_geometry_graph_and_release_payload_pin() {
    let fixture = fixture();
    fixture
        .store
        .publish_solution_set(&fixture.solution)
        .unwrap();
    let manifest =
        read_solution_field_geometry_manifest(fixture.store.cas(), &fixture.geometry_artifact)
            .unwrap();
    assert!(!fixture
        .store
        .root()
        .join(format!(
            "objects/pins/{}.json",
            manifest.geometry.object_ref
        ))
        .exists());
    let live = crate::reachability::walk_store_root(
        fixture.store.root(),
        crate::reachability::ReachabilityMode::Gc,
    )
    .unwrap();
    assert!(live.complete && live.object_refs.contains(&manifest.geometry.object_ref));
    let archive = crate::reachability::walk_archive_documents(
        &archive_documents(&fixture),
        crate::reachability::ReachabilityMode::Restore,
    )
    .unwrap();
    assert!(archive.complete && archive.object_refs.contains(&manifest.geometry.object_ref));
    assert_eq!(
        read_saved_fem_p1_geometry(fixture.store.cas(), &manifest.geometry)
            .unwrap()
            .representation_evidence,
        SavedFieldRepresentationEvidence::NotVerified
    );
}

#[test]
fn missing_geometry_is_incomplete_for_restore_and_blocks_publication_gc_and_recovery() {
    let fixture = fixture();
    let manifest =
        read_solution_field_geometry_manifest(fixture.store.cas(), &fixture.geometry_artifact)
            .unwrap();
    fixture
        .store
        .publish_solution_set(&fixture.solution)
        .unwrap();
    let mut documents = archive_documents(&fixture);
    documents.remove(&format!("objects/sha256/{}", manifest.geometry.object_ref));
    assert!(
        !crate::reachability::walk_archive_documents(
            &documents,
            crate::reachability::ReachabilityMode::Restore
        )
        .unwrap()
        .complete
    );
    std::fs::remove_file(
        fixture
            .store
            .root()
            .join(format!("objects/sha256/{}", manifest.geometry.object_ref)),
    )
    .unwrap();
    assert!(crate::reachability::walk_store_root(
        fixture.store.root(),
        crate::reachability::ReachabilityMode::Gc
    )
    .is_err());
    assert!(fixture
        .store
        .publish_solution_set(&fixture.solution)
        .is_err());
    assert!(fixture.store.solution_sets().reconcile_all().is_err());
}

#[test]
fn replay_preserves_historical_owner_and_rejects_changed_tensor_or_duplicate_geometry() {
    let fixture = fixture();
    fixture
        .store
        .publish_solution_set(&fixture.solution)
        .unwrap();
    let mut later = fixture.solution.clone();
    later.revision = 2;
    fixture.store.publish_solution_set(&later).unwrap();
    let manifest =
        read_solution_field_geometry_manifest(fixture.store.cas(), &fixture.geometry_artifact)
            .unwrap();
    assert_eq!(manifest.source.solution_revision, 1);
    assert!(validate_field_geometry_owner(&manifest, &later, "member", false).is_ok());
    assert!(validate_field_geometry_owner(&manifest, &later, "member", true).is_err());
    later.members[0].artifacts[0].object_ref = "b".repeat(64);
    assert!(validate_field_geometry_owner(&manifest, &later, "member", false).is_err());
    let mut duplicate = fixture.solution.clone();
    duplicate.revision = 3;
    let mut repeated = fixture.geometry_artifact.clone();
    repeated.artifact_id = "duplicate".into();
    duplicate.members[0].artifacts.push(repeated);
    assert!(fixture.store.publish_solution_set(&duplicate).is_err());
}

#[test]
fn serialization_budget_stops_before_buffer_growth_and_reference_checks_fail_closed() {
    let mut writer = BoundedJsonWriter {
        bytes: vec![0; 4],
        limit: 4,
    };
    assert!(writer.write_all(&[1]).is_err());
    assert_eq!(writer.bytes.len(), 4);
    let geometry = geometry();
    let bytes = serde_json::to_vec(&geometry).unwrap();
    let mut reference = payload_ref(&bytes);
    reference.byte_length += 1;
    assert!(parse_saved_fem_p1_geometry(&bytes, &reference).is_err());
    reference = payload_ref(&bytes);
    reference.object_ref = "a".repeat(64);
    assert!(parse_saved_fem_p1_geometry(&bytes, &reference).is_err());
}
