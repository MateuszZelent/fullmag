use std::collections::HashMap;
use std::fs;
use std::io::Cursor;

use fullmag_quantities::{
    ScientificAssessment, ScientificAssessmentStatus, SolutionArtifactKind, SolutionArtifactRef,
    SolutionExecutionStatus, SolutionMember, SolutionSet, SolutionSetManifestState,
    SolutionSetProvenance, SOLUTION_SET_SCHEMA_VERSION,
};
use serde_json::json;

use super::{pack_fms, preflight_fms, unpack_fms, PackOptions};
use crate::solution_tensor_source::{
    resolve_solution_tensor, PinnedSolutionTensorSource, SOLUTION_TENSOR_SCHEMA,
};
use crate::{
    FmsExportProfile, FmsRunIntent, FmsSessionManifest, FmsWorkspaceManifest, SaveProfile,
    SessionStore, TensorChunk, TensorDescriptor, TensorDtype,
};

fn digest(character: char) -> String {
    format!("sha256:{}", character.to_string().repeat(64))
}

fn assessment() -> ScientificAssessment {
    ScientificAssessment {
        status: ScientificAssessmentStatus::Unassessed,
        reason: Some("typed tensor owner closure fixture".to_string()),
        evidence_artifact_ids: Vec::new(),
    }
}

fn workspace(script: &[u8]) -> FmsWorkspaceManifest {
    FmsWorkspaceManifest {
        workspace_id: "workspace-tensor".to_string(),
        problem_name: "tensor-owner-closure".to_string(),
        project_ref: "project/".to_string(),
        script_ref: "project/main.py".to_string(),
        script_sha256: crate::hex_sha256(script),
        ui_state_ref: "project/ui_state.json".to_string(),
        scene_document_ref: "project/scene_document.json".to_string(),
        script_builder_ref: None,
        model_builder_graph_ref: None,
        asset_index_ref: None,
    }
}

struct TensorExportFixture {
    _directory: tempfile::TempDir,
    store: SessionStore,
    solution: SolutionSet,
    artifact: SolutionArtifactRef,
    chunk_ref: String,
    owner_asset_ref: String,
    owner_asset_len: u64,
    run_spec_digest: String,
}

fn tensor_export_fixture(with_owner_intent: bool) -> TensorExportFixture {
    let directory = tempfile::tempdir().expect("temporary FMS owner fixture");
    let store = SessionStore::open(directory.path().join("store")).expect("open fixture store");
    let run_id = "run-tensor-owner";
    let owner_asset_bytes = b"immutable owner asset payload";
    let owner_asset_ref = store
        .cas()
        .put(owner_asset_bytes)
        .expect("publish tensor owner asset");
    let mut intent = FmsRunIntent::new(
        run_id,
        "intent-tensor-owner",
        json!({
            "run_id": run_id,
            "solver": "fixture",
            "immutable_assets": [{
                "asset_id": "owner-asset",
                "content_sha256": owner_asset_ref.clone(),
            }]
        }),
    );
    intent
        .asset_object_refs
        .insert("owner-asset".to_string(), owner_asset_ref.clone());
    store
        .commit_run_intent(&intent)
        .expect("publish tensor owner intent");
    let run_spec_digest = format!("sha256:{}", intent.payload_sha256);

    let chunk_bytes = vec![0_u8; 16];
    let chunk_ref = store
        .cas()
        .put(&chunk_bytes)
        .expect("publish tensor payload");
    let descriptor = TensorDescriptor {
        format: SOLUTION_TENSOR_SCHEMA.to_string(),
        name: "magnetization".to_string(),
        dtype: TensorDtype::F64,
        shape: vec![2],
        logical_axes: vec!["sample".to_string()],
        endian: "little".to_string(),
        field_binding: None,
        chunks: vec![TensorChunk {
            object_ref: chunk_ref.clone(),
            offset: 0,
            length: chunk_bytes.len(),
            sha256: Some(chunk_ref.clone()),
        }],
    };
    let descriptor_bytes = serde_json::to_vec(&descriptor).expect("serialize tensor root");
    let descriptor_ref = store
        .cas()
        .put(&descriptor_bytes)
        .expect("publish tensor root");
    let artifact = SolutionArtifactRef {
        artifact_id: "tensor-artifact".to_string(),
        kind: SolutionArtifactKind::State,
        schema_id: SOLUTION_TENSOR_SCHEMA.to_string(),
        object_ref: descriptor_ref,
        byte_length: descriptor_bytes.len() as u64,
        accepted_state: None,
    };
    let solution = SolutionSet {
        schema_version: SOLUTION_SET_SCHEMA_VERSION.to_string(),
        solution_set_id: "solution-tensor-owner".to_string(),
        revision: 1,
        run_id: run_id.to_string(),
        manifest_state: SolutionSetManifestState::Closed,
        execution_status: SolutionExecutionStatus::Succeeded,
        scientific_assessment: assessment(),
        provenance: SolutionSetProvenance {
            run_spec_digest: run_spec_digest.clone(),
            model_digest: digest('b'),
            physics_digest: digest('c'),
            discretization_digest: digest('d'),
            resolved_plan_digest: digest('e'),
            acquisition_digest: digest('f'),
            seed_digest: None,
        },
        members: vec![SolutionMember {
            member_id: "tensor-member".to_string(),
            task_id: "tensor-task".to_string(),
            attempt_id: "tensor-attempt".to_string(),
            ownership_epoch: 1,
            case_id: None,
            stage_id: "tensor-stage".to_string(),
            execution_status: SolutionExecutionStatus::Succeeded,
            scientific_assessment: assessment(),
            artifacts: vec![artifact.clone()],
        }],
        coverage: Vec::new(),
    };
    store
        .publish_solution_set(&solution)
        .expect("publish tensor solution set");
    if !with_owner_intent {
        fs::remove_file(
            store
                .root()
                .join("runs")
                .join(run_id)
                .join("run_intent.json"),
        )
        .expect("remove owner intent after valid solution publication");
    }

    TensorExportFixture {
        _directory: directory,
        store,
        solution,
        artifact,
        chunk_ref,
        owner_asset_ref,
        owner_asset_len: owner_asset_bytes.len() as u64,
        run_spec_digest,
    }
}

fn project_documents() -> HashMap<String, Vec<u8>> {
    let script = b"print('tensor owner closure')".to_vec();
    HashMap::from([
        ("main.py".to_string(), script),
        ("ui_state.json".to_string(), b"{}".to_vec()),
        ("scene_document.json".to_string(), b"{}".to_vec()),
    ])
}

#[test]
fn typed_tensor_export_includes_owner_intent_and_resolves_after_unpack() {
    let fixture = tensor_export_fixture(true);
    let session = FmsSessionManifest::new("session-tensor", "Tensor", SaveProfile::Archive);
    let documents = project_documents();
    let script = documents.get("main.py").expect("script fixture");
    let export_profile = FmsExportProfile::for_profile(SaveProfile::Archive);
    let mut archive = Cursor::new(Vec::new());
    pack_fms(
        &mut archive,
        &fixture.store,
        &session,
        &workspace(script),
        &export_profile,
        &documents,
        &PackOptions::default(),
    )
    .expect("pack typed tensor owner archive");
    let archive_bytes = archive.into_inner();

    let preflight = preflight_fms(Cursor::new(&archive_bytes), &[]).expect("preflight archive");
    let owner_path = "runs/run-tensor-owner/run_intent.json";
    assert!(preflight.documents.contains_key(owner_path));
    assert!(preflight
        .reachability
        .object_refs
        .contains(&fixture.artifact.object_ref));
    assert!(preflight
        .reachability
        .object_refs
        .contains(&fixture.chunk_ref));
    assert!(preflight
        .reachability
        .object_refs
        .contains(&fixture.owner_asset_ref));

    let restored_directory = tempfile::tempdir().expect("temporary restore store");
    let restored =
        SessionStore::open(restored_directory.path().join("store")).expect("open restore store");
    unpack_fms(Cursor::new(archive_bytes), &restored).expect("unpack typed owner archive");
    assert_eq!(
        restored
            .cas()
            .verified_length(&fixture.owner_asset_ref)
            .expect("verify restored owner asset"),
        Some(fixture.owner_asset_len)
    );
    let source = PinnedSolutionTensorSource {
        run_id: fixture.solution.run_id.clone(),
        solution_set_id: fixture.solution.solution_set_id.clone(),
        solution_revision: fixture.solution.revision,
        member_id: "tensor-member".to_string(),
        artifact_id: fixture.artifact.artifact_id.clone(),
        tensor_object_ref: fixture.artifact.object_ref.clone(),
        run_spec_digest: fixture.run_spec_digest,
    };
    let resolved = resolve_solution_tensor(&restored, &source).expect("resolve restored tensor");
    assert_eq!(resolved.tensor.chunks[0].object_ref, fixture.chunk_ref);
}

#[test]
fn typed_tensor_export_rejects_missing_owner_before_zip_output() {
    let fixture = tensor_export_fixture(false);
    let session = FmsSessionManifest::new("session-tensor", "Tensor", SaveProfile::Archive);
    let documents = project_documents();
    let script = documents.get("main.py").expect("script fixture");
    let mut archive = Cursor::new(Vec::new());
    let error = pack_fms(
        &mut archive,
        &fixture.store,
        &session,
        &workspace(script),
        &FmsExportProfile::for_profile(SaveProfile::Archive),
        &documents,
        &PackOptions::default(),
    )
    .expect_err("typed tensor without owner intent was exported");
    assert!(error.to_string().contains("requires owner run intent"));
    assert!(archive.into_inner().is_empty());
}
