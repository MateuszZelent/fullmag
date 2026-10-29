//! Importer-owned evidence for historical antenna geometry, never live readiness.
use std::io::{self, Write};
use std::path::Path;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::error::ApiError;
use crate::router_v2::handlers::meshing::mesh::field_only_source_mesh_binding;
use crate::types::SessionStateResponse;
use fullmag_session::FmsAcceptedProvenanceReference;

/// Private fields and no Deserialize prevent archive/publisher proof injection.
#[derive(Debug, Clone)]
pub(crate) struct ImportedAntennaMeshProof {
    binding_sha256: [u8; 32],
    script_path: String,
    run_id: String,
    closure_sha256: String,
}

struct HashWriter(Sha256);
impl Write for HashWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn digest(value: &impl Serialize) -> Option<[u8; 32]> {
    let mut writer = HashWriter(Sha256::new());
    serde_json::to_writer(&mut writer, value).ok()?;
    Some(writer.0.finalize().into())
}

// Hash the complete typed plan (including source mesh), the actual published
// Global mesh, full scene, and workspace identity without copying their buffers.
fn binding(snapshot: &SessionStateResponse) -> Option<[u8; 32]> {
    field_only_source_mesh_binding(snapshot)?;
    let metadata = snapshot.metadata.as_ref()?;
    let workspace = snapshot.mesh_workspace.as_ref()?;
    let plan = metadata.execution_plan()?;
    let workspace_plan = workspace.execution_plan()?;
    if digest(plan.as_ref())? != digest(workspace_plan.as_ref())?
        || workspace["accepted_run_id"].as_str() != Some(snapshot.session.run_id.as_str())
    {
        return None;
    }
    digest(&(
        &snapshot.session.session_id,
        &snapshot.session.run_id,
        snapshot.scene_document.as_ref()?,
        workspace,
        snapshot.fem_mesh.as_ref()?,
        metadata.get("antenna_domain_publication"),
    ))
}

fn read_only(snapshot: &SessionStateResponse) -> bool {
    snapshot.runtime_status.code == "imported_read_only"
        && snapshot.runtime_status.kind == fullmag_runner::RuntimeStatus::Completed
        && !snapshot.runtime_status.is_busy
        && !snapshot.runtime_status.can_accept_commands
        && snapshot.session.status == "completed"
}

impl ImportedAntennaMeshProof {
    pub(crate) fn valid_for(&self, snapshot: &SessionStateResponse) -> bool {
        let marker = snapshot
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get("imported_accepted_evidence"));
        read_only(snapshot)
            && snapshot.session.script_path == self.script_path
            && snapshot.session.run_id == self.run_id
            && marker.is_some_and(|marker| {
                marker["run_id"].as_str() == Some(self.run_id.as_str())
                    && marker["closure_sha256"].as_str() == Some(self.closure_sha256.as_str())
            })
            && binding(snapshot) == Some(self.binding_sha256)
    }
}

/// Called only after the canonical importer validates the accepted closure and
/// assigns its private destination. No preparation job or ready state is made.
pub(super) fn issue(
    snapshot: &SessionStateResponse,
    reference: Option<&FmsAcceptedProvenanceReference>,
    imports: &Path,
    published_root: &Path,
) -> Result<Option<ImportedAntennaMeshProof>, ApiError> {
    let Some(reference) = reference else {
        return Ok(None);
    };
    let Some(binding_sha256) = binding(snapshot) else {
        return Ok(None);
    };
    if !read_only(snapshot)
        || reference.accepted_run_id != snapshot.session.run_id
        || published_root.parent() != Some(imports)
        || Path::new(&snapshot.session.script_path) != published_root.join("project/main.py")
    {
        return Err(ApiError::bad_request(
            "invalid_fms_antenna_mesh: imported identity differs",
        ));
    }
    reference
        .validate()
        .map_err(|error| ApiError::bad_request(format!("invalid_fms_antenna_mesh: {error}")))?;
    let import_id = published_root
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| ApiError::bad_request("invalid_fms_antenna_mesh: import identity absent"))?;
    fullmag_session::repository_path::validate_store_id(import_id)
        .map_err(|error| ApiError::bad_request(format!("invalid_fms_antenna_mesh: {error}")))?;
    let proof = ImportedAntennaMeshProof {
        binding_sha256,
        script_path: snapshot.session.script_path.clone(),
        run_id: reference.accepted_run_id.clone(),
        closure_sha256: reference.closure_sha256.clone(),
    };
    if !proof.valid_for(snapshot) {
        return Err(ApiError::bad_request(
            "invalid_fms_antenna_mesh: accepted observation pin differs",
        ));
    }
    Ok(Some(proof))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::router_v2::handlers::meshing::mesh::{
        field_only_source_payload, prepared_field_only_source_mesh,
    };
    use serde_json::json;

    fn fixture() -> (SessionStateResponse, FmsAcceptedProvenanceReference) {
        let request = serde_json::from_value(json!({"session_id":"cold-antenna"})).unwrap();
        let mut snapshot = crate::session::default_current_live_state(&request);
        let mut source = fullmag_ir::FemPlanIR::default().mesh;
        source.mesh_name = "source-cut".into();
        source.nodes = vec![
            [0., 0., 0.],
            [1., 0., 0.],
            [0., 1., 0.],
            [0., 0., 1.],
            [0., 0., 0.],
            [1., 0., 0.],
            [0., 1., 0.],
            [0., 0., -1.],
        ];
        source.cells = fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [4, 6, 5, 7]]);
        source.element_markers = vec![1, 2];
        let mut global = source.clone();
        global.mesh_name = "universe".into();
        global.nodes = vec![
            [0., 0., 0.],
            [1., 0., 0.],
            [0., 1., 0.],
            [0., 0., 1.],
            [0., 0., -1.],
        ];
        global.cells = fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [0, 2, 1, 4]]);
        global.element_markers = vec![1, 0];
        let source_segment = fullmag_ir::FemObjectSegmentIR {
            object_id: "antenna".into(),
            geometry_id: Some("antenna".into()),
            node_start: 0,
            node_count: 8,
            element_start: 0,
            element_count: 2,
            boundary_face_start: 0,
            boundary_face_count: 0,
        };
        let plan = fullmag_ir::AntennaFieldOnlyPlanIR {
            schema_version: "antenna_field_only_plan.v1".into(),
            stage_id: "inspect".into(),
            port_mode_id: "port".into(),
            source_object_id: "antenna".into(),
            source_mesh: source,
            source_object_segments: vec![source_segment],
            source_mesh_parts: Vec::new(),
            field_sampling: fullmag_ir::AntennaFieldSamplingPlanIR {
                domain: fullmag_ir::FieldTargetIR::Global {},
                carrier_kind: "fem_domain_mesh_asset".into(),
                location: "node".into(),
                topology_digest: format!("sha256:{}", "a".repeat(64)),
                positions_xyz_m: global.nodes.clone(),
                cells: global.cells.clone(),
            },
        };
        let mut global_plan = plan.clone();
        global_plan.source_mesh = global;
        global_plan.source_object_segments.clear();
        let mesh =
            fullmag_runner::StageFemMeshAsset::build_from_antenna_field_only_plan(&global_plan)
                .payload;
        let execution = fullmag_ir::ExecutionPlanIR {
            common: fullmag_ir::CommonPlanMeta {
                ir_version: "test".into(),
                requested_backend: fullmag_ir::BackendTarget::Fem,
                resolved_backend: fullmag_ir::BackendTarget::Fem,
                execution_mode: fullmag_ir::ExecutionMode::Strict,
                material_field_plans: Vec::new(),
            },
            backend_plan: fullmag_ir::BackendPlanIR::AntennaFieldOnly(plan.clone()),
            output_plan: fullmag_ir::OutputPlanIR {
                outputs: Vec::new(),
            },
            provenance: fullmag_ir::ProvenancePlanIR {
                notes: Vec::new(),
                integrator_resolution: None,
                fem_eigen_execution_resolution: None,
                physics_graph: None,
            },
        };
        let mut scene = fullmag_authoring::SceneDocument::default();
        scene.revision = 1;
        scene.study.requested_backend = "fem".into();
        scene.objects.push(
            serde_json::from_value(json!({
                "id":"antenna","name":"Antenna","role":"antenna",
                "geometry":{"geometry_kind":"Box","geometry_params":{"size":[1.,1.,1.]}},
                "material_ref":"","magnetization_ref":null,
            }))
            .unwrap(),
        );
        let reference = FmsAcceptedProvenanceReference {
            manifest_ref: fullmag_session::FMS_ACCEPTED_PROVENANCE_MANIFEST_REF.into(),
            accepted_run_id: snapshot.session.run_id.clone(),
            closure_sha256: format!("sha256:{}", "b".repeat(64)),
        };
        snapshot.metadata = Some(
            json!({
                "execution_plan":execution,
                "antenna_domain_publication":{
                    "mesh_generation_id":mesh.generation_id,"mesh_name":mesh.mesh_name,
                    "sampling_topology_digest":plan.field_sampling.topology_digest,
                },
                "imported_accepted_evidence":{
                    "run_id":reference.accepted_run_id,"closure_sha256":reference.closure_sha256,
                },
            })
            .into(),
        );
        snapshot.mesh_workspace = Some(json!({
            "schema_version":crate::live_scene_preparation::LIVE_SCENE_PREPARATION_READ_MODEL_SCHEMA,
            "status":"completed","source_scene_revision":1,"preparation_id":"real-archived-prep",
            "accepted_run_id":snapshot.session.run_id,"execution_plan":execution,
        }).into());
        snapshot.fem_mesh = Some(mesh.into());
        snapshot.scene_document = Some(scene);
        snapshot.session.status = "completed".into();
        snapshot.session.script_path = "/private/imports/import-1/project/main.py".into();
        snapshot.runtime_status = crate::types::RuntimeStatusView {
            kind: fullmag_runner::RuntimeStatus::Completed,
            code: "imported_read_only".into(),
            is_busy: false,
            can_accept_commands: false,
        };
        (snapshot, reference)
    }

    fn authorize(snapshot: &mut SessionStateResponse, reference: &FmsAcceptedProvenanceReference) {
        snapshot.imported_antenna_mesh_proof = issue(
            snapshot,
            Some(reference),
            Path::new("/private/imports"),
            Path::new("/private/imports/import-1"),
        )
        .unwrap();
        assert!(snapshot.imported_antenna_mesh_proof.is_some());
    }

    #[test]
    fn historical_missing_preparation_reads_cut_source_without_live_readiness() {
        let (snapshot, reference) = fixture();
        let persisted = super::super::PersistedCurrentLiveSnapshot::from(&snapshot);
        let mut bytes = serde_json::to_value(&persisted).unwrap();
        assert!(bytes.get("simulation_preparation").is_none());
        bytes["imported_antenna_mesh_proof"] = json!({"forged":true});
        let persisted =
            serde_json::from_value::<super::super::PersistedCurrentLiveSnapshot>(bytes).unwrap();
        let mut restored: SessionStateResponse = persisted.into();
        assert!(restored.imported_antenna_mesh_proof.is_none());
        assert!(field_only_source_payload(&restored, "antenna").is_err());
        authorize(&mut restored, &reference);
        assert!(restored.simulation_preparation.is_none());
        assert!(prepared_field_only_source_mesh(&restored).is_none());
        assert!(!restored.runtime_status.can_accept_commands);
        let source = field_only_source_payload(&restored, "antenna")
            .unwrap()
            .unwrap();
        assert_eq!(source.nodes.len(), 8);
        assert_eq!(source.nodes[0], source.nodes[4]);
        assert_eq!(source.element_markers, vec![1, 2]);
        assert_eq!(restored.fem_mesh.as_ref().unwrap().nodes.len(), 5);
        assert!(serde_json::to_value(&restored)
            .unwrap()
            .get("imported_antenna_mesh_proof")
            .is_none());
        let again = super::super::PersistedCurrentLiveSnapshot::from(&restored);
        let again: SessionStateResponse = again.into();
        assert!(again.imported_antenna_mesh_proof.is_none());
    }

    #[test]
    fn imported_proof_rejects_changed_identity_or_payload_and_live_reuse() {
        let (mut snapshot, reference) = fixture();
        authorize(&mut snapshot, &reference);
        let changes: &[fn(&mut SessionStateResponse)] = &[
            |s| s.session.run_id.push('x'),
            |s| s.session.session_id.push('x'),
            |s| s.session.script_path = "/original/live/project/main.py".into(),
            |s| s.runtime_status.code = "idle".into(),
            |s| s.runtime_status.can_accept_commands = true,
            |s| s.runtime_status.is_busy = true,
            |s| s.scene_document.as_mut().unwrap().revision += 1,
            |s| {
                s.scene_document.as_mut().unwrap().objects[0]
                    .tags
                    .push("mesh:dirty".into())
            },
            |s| s.scene_document.as_mut().unwrap().objects[0].name.push('x'),
            |s| {
                s.metadata.as_mut().unwrap()["imported_accepted_evidence"]["closure_sha256"] =
                    json!("forged")
            },
            |s| {
                s.metadata
                    .as_mut()
                    .unwrap()
                    .as_object_mut()
                    .unwrap()
                    .remove("imported_accepted_evidence")
                    .map(|_| ())
                    .unwrap()
            },
            |s| s.mesh_workspace.as_mut().unwrap()["preparation_id"] = json!("another-prep"),
            |s| s.mesh_workspace.as_mut().unwrap()["accepted_run_id"] = json!("another-run"),
            |s| {
                s.metadata.as_mut().unwrap()["execution_plan"]["backend_plan"]["source_mesh"]
                    ["nodes"][0][0] = json!(0.25)
            },
            |s| {
                s.mesh_workspace.as_mut().unwrap()["execution_plan"]["backend_plan"]
                    ["source_mesh"]["nodes"][0][0] = json!(0.25)
            },
            |s| {
                s.metadata.as_mut().unwrap()["execution_plan"]["backend_plan"]["field_sampling"]
                    ["topology_digest"] = json!("changed")
            },
            |s| {
                s.metadata.as_mut().unwrap()["antenna_domain_publication"]["mesh_generation_id"] =
                    json!("changed")
            },
            |s| s.fem_mesh.as_mut().unwrap().nodes[0][0] = 0.25,
            |s| s.fem_mesh.as_mut().unwrap().generation_id = Some("changed".into()),
        ];
        for (index, change) in changes.iter().enumerate() {
            let mut changed = snapshot.clone();
            change(&mut changed);
            assert!(
                field_only_source_payload(&changed, "antenna").is_err(),
                "mutation {index}"
            );
        }
        let mut both_plans = snapshot.clone();
        for document in [&mut both_plans.metadata, &mut both_plans.mesh_workspace] {
            document.as_mut().unwrap()["execution_plan"]["backend_plan"]["source_mesh"]["nodes"]
                [0][0] = json!(0.25);
        }
        assert!(field_only_source_payload(&both_plans, "antenna").is_err());
    }

    #[test]
    fn untrusted_marker_and_wrong_import_destination_do_not_issue_proof() {
        let (mut snapshot, reference) = fixture();
        snapshot.metadata.as_mut().unwrap()["imported_antenna_mesh_proof"] = json!({"forged":true});
        assert!(field_only_source_payload(&snapshot, "antenna").is_err());
        assert!(issue(
            &snapshot,
            None,
            Path::new("/private/imports"),
            Path::new("/private/imports/import-1")
        )
        .unwrap()
        .is_none());
        assert!(issue(
            &snapshot,
            Some(&reference),
            Path::new("/private/imports"),
            Path::new("/original/live")
        )
        .is_err());
        snapshot.metadata.as_mut().unwrap()["imported_accepted_evidence"]["closure_sha256"] =
            json!("forged");
        assert!(issue(
            &snapshot,
            Some(&reference),
            Path::new("/private/imports"),
            Path::new("/private/imports/import-1")
        )
        .is_err());
    }
}
