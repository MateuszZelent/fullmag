//! Geometry-only FEM mesh build for the Docker live workspace (ADR 0074).
//!
//! The solver mesh is realized from the scene geometry, universe and mesh
//! policies. Materials, initial state, interactions and study stages are not
//! read, and no RunIntent is created. The published mesh records the inputs
//! needed to revalidate its topology after later edits.

use std::path::Path;
use std::sync::Arc;

use fullmag_authoring::{SceneDocument, ScriptBuilderMeshState};
use fullmag_ir::{
    FemDomainMeshAssetIR, FemDomainRegionMarkerIR, FemSharedDomainBuildReportIR, MeshIR,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::error::ApiError;
use crate::router_v2::handlers::simulation::commands::{
    scene_object_geometry_entry, scene_per_geometry_mesh_options, study_universe_for_problem_patch,
};
use crate::types::{
    AppState, CommandLifecycleState, CurrentLiveRequestContext, CurrentLiveSnapshotRequest,
    SessionStateResponse,
};

const GEOMETRY_MESH_BUILD_SCHEMA: &str = "fullmag.geometry_mesh_build.v1";
const MESH_NAME: &str = "study_domain";
const GEOMETRY_INPUT_BINDING_SCHEMA: &str = "fullmag.geometry_mesh_input.v1";
const GEOMETRY_REUSE_SCHEMA: &str = "fullmag.live_geometry_reuse_asset.v1";
pub(crate) const GEOMETRY_REUSE_KEY: &str = "geometry_reuse_asset";
const MAX_GEOMETRY_REUSE_BYTES: u64 = 256 * 1024 * 1024;
/// Exit code of `fullmag.meshing.geometry_mesh_build` for an authored input
/// that cannot be meshed; its message is shown to the user unchanged.
const USER_FACING_EXIT_CODE: i32 = 2;
/// ScriptBuilderMeshState stores these sizes as authored text.
const TEXT_NUMERIC_POLICY_KEYS: [&str; 12] = [
    "hmax",
    "hmin",
    "maximum_element_size",
    "minimum_element_size",
    "curvature_factor",
    "growth_rate",
    "maximum_element_growth_rate",
    "narrow_region_resolution",
    "resolved_growth_rate",
    "interface_hmax",
    "interface_thickness",
    "transition_growth",
];

#[derive(Debug, Deserialize)]
struct GeometryMeshBuildOutput {
    schema: String,
    mesh: MeshIR,
    #[serde(default)]
    region_markers: Vec<FemDomainRegionMarkerIR>,
    #[serde(default)]
    object_region_markers: Vec<FemDomainRegionMarkerIR>,
    #[serde(default)]
    quality: Option<Value>,
    #[serde(default)]
    mesh_statistics: Option<Value>,
    #[serde(default)]
    mesh_provenance: Option<Value>,
    #[serde(default)]
    quality_data_artifact: Option<Value>,
}

/// Mesher options from the shared-domain policy: authored text sizes become
/// numbers and empty text means "not authored".
fn shared_domain_mesh_options(
    policy: &ScriptBuilderMeshState,
) -> Result<Map<String, Value>, ApiError> {
    let Value::Object(mut options) = serde_json::to_value(policy).map_err(|error| {
        ApiError::internal(format!(
            "failed to encode the shared-domain mesh policy: {error}"
        ))
    })?
    else {
        return Err(ApiError::internal(
            "shared-domain mesh policy is not an object",
        ));
    };
    options.retain(|_, value| !matches!(value, Value::String(text) if text.trim().is_empty()));
    for key in TEXT_NUMERIC_POLICY_KEYS {
        let Some(Value::String(text)) = options.get(key).cloned() else {
            continue;
        };
        // Non-numeric text such as "auto" is interpreted by the mesher.
        if let Ok(number) = text.trim().parse::<f64>() {
            if !number.is_finite() || number <= 0.0 {
                return Err(ApiError::bad_request(format!(
                    "Shared-domain mesh policy '{key}' must be a positive number."
                )));
            }
            options.insert(key.to_string(), json!(number));
        }
    }
    options.remove("order");
    Ok(options)
}

fn positive_number(value: Option<&Value>) -> Option<f64> {
    let number = match value? {
        Value::Number(number) => number.as_f64()?,
        Value::String(text) => text.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    (number.is_finite() && number > 0.0).then_some(number)
}

/// Body target: the shared-domain h_max, otherwise the coarsest object target
/// when every meshed object authors its own. `None` is reported by the mesher
/// as a user-facing "set h_max" error rather than replaced by a default.
fn body_hmax(
    options: &Map<String, Value>,
    per_geometry: &[Value],
    object_count: usize,
) -> Option<f64> {
    if let Some(hmax) = positive_number(options.get("hmax"))
        .or_else(|| positive_number(options.get("maximum_element_size")))
    {
        return Some(hmax);
    }
    let object_targets = per_geometry
        .iter()
        .filter_map(|entry| {
            positive_number(entry.get("hmax"))
                .or_else(|| positive_number(entry.get("maximum_element_size")))
        })
        .collect::<Vec<_>>();
    (object_count > 0 && object_targets.len() == object_count)
        .then(|| object_targets.into_iter().fold(0.0_f64, f64::max))
}

/// Scene lowering for the mesher; geometry names are the immutable object ids.
pub(crate) fn geometry_only_mesh_payload(scene: &SceneDocument) -> Result<Value, ApiError> {
    let mut geometries = Vec::new();
    let mut geometry_object_ids = Map::new();
    for object in fullmag_authoring::scene_solve_objects(scene) {
        geometries.push(scene_object_geometry_entry(object, &object.id)?);
        geometry_object_ids.insert(object.id.clone(), Value::String(object.id.clone()));
    }
    let mut options = shared_domain_mesh_options(&scene.study.shared_domain_mesh)?;
    let per_geometry = match scene_per_geometry_mesh_options(scene)? {
        Some(Value::Array(entries)) => entries,
        _ => Vec::new(),
    };
    let hmax = body_hmax(&options, &per_geometry, geometries.len());
    options.insert("per_geometry".to_string(), Value::Array(per_geometry));
    Ok(json!({
        "geometries": geometries,
        "geometry_object_ids": geometry_object_ids,
        "declared_universe": study_universe_for_problem_patch(scene)?,
        "hmax": hmax,
        "order": scene.study.shared_domain_mesh.order.unwrap_or(1),
        "mesh_name": MESH_NAME,
        "mesh_options": options,
    }))
}

fn mesh_input_sha256(scene: &SceneDocument, payload: &Value) -> String {
    fullmag_session::canonical_json_sha256(&json!({
        "schema_version": GEOMETRY_INPUT_BINDING_SCHEMA,
        "payload": payload,
        "authored_topology": crate::scene_mesh_signature(scene),
    }))
}

fn geometry_input_binding(mesh: &fullmag_runner::FemMeshPayload, input_sha256: &str) -> Value {
    json!({
        "schema_version": GEOMETRY_INPUT_BINDING_SCHEMA,
        "input_sha256": input_sha256,
        "mesh_id": mesh.mesh_id,
        "generation_id": mesh.generation_id,
        "topology_fingerprint": fullmag_runner::fem_mesh_topology_fingerprint(mesh),
    })
}

/// Legacy publications have no payload signature and retain their existing
/// scene-revision checks. A present but invalid binding never uses that fallback.
pub(crate) fn bound_geometry_mesh_is_current(
    snapshot: &SessionStateResponse,
    scene: &SceneDocument,
) -> Option<bool> {
    let workspace = snapshot.mesh_workspace.as_ref()?;
    let binding = workspace.get("geometry_input_binding")?;
    Some(snapshot.fem_mesh.as_ref().is_some_and(|mesh| {
        let source = workspace.get("mesh_summary");
        let generation = mesh.generation_id.as_deref();
        binding["schema_version"].as_str() == Some(GEOMETRY_INPUT_BINDING_SCHEMA)
            && source
                .and_then(|summary| summary.get("source_kind"))
                .and_then(Value::as_str)
                == Some("geometry_only_shared_domain")
            && generation.is_some_and(|generation| !generation.is_empty())
            && binding["generation_id"].as_str() == generation
            && binding["mesh_id"].as_str() == Some(mesh.mesh_id.as_str())
            && binding["topology_fingerprint"].as_str() == Some(mesh.topology_fingerprint())
            && geometry_only_mesh_payload(scene).is_ok_and(|payload| {
                binding["input_sha256"].as_str()
                    == Some(mesh_input_sha256(scene, &payload).as_str())
            })
    }))
}

/// The raw mesher output is a solver asset, separate from the packed display
/// projection. Its private reference survives adoption of a solver read model.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct GeometryReuseReference {
    schema_version: String,
    session_id: String,
    session_epoch: u64,
    source_scene_revision: u64,
    input_sha256: String,
    asset_sha256: String,
    byte_count: u64,
}

pub(crate) fn geometry_reuse_reference(
    snapshot: &SessionStateResponse,
    context: &CurrentLiveRequestContext,
) -> Option<GeometryReuseReference> {
    let value = snapshot.mesh_workspace.as_ref()?.get(GEOMETRY_REUSE_KEY)?;
    let reference: GeometryReuseReference = serde_json::from_value(value.clone()).ok()?;
    (reference.schema_version == GEOMETRY_REUSE_SCHEMA
        && reference.session_id == context.session_id
        && reference.session_epoch == context.session_epoch
        && (1..=MAX_GEOMETRY_REUSE_BYTES).contains(&reference.byte_count))
    .then_some(reference)
}

pub(crate) fn load_geometry_reuse_asset(
    store: &fullmag_session::SessionStore,
    scene: &SceneDocument,
    reference: &GeometryReuseReference,
) -> Result<Option<FemDomainMeshAssetIR>, ApiError> {
    let payload = geometry_only_mesh_payload(scene)?;
    if mesh_input_sha256(scene, &payload) != reference.input_sha256 {
        return Ok(None);
    }
    let corrupt = |message| ApiError::conflict_with_code("geometry_reuse_asset_invalid", message);
    let bytes = store
        .cas()
        .get_bounded(
            &reference.asset_sha256,
            reference.byte_count.min(MAX_GEOMETRY_REUSE_BYTES),
        )
        .map_err(|error| corrupt(format!("failed to verify the mesh asset: {error}")))?
        .ok_or_else(|| corrupt("the bound mesh asset is missing from CAS".into()))?;
    if bytes.len() as u64 != reference.byte_count {
        return Err(corrupt("the bound mesh asset size changed".into()));
    }
    let asset: FemDomainMeshAssetIR = serde_json::from_slice(&bytes)
        .map_err(|error| corrupt(format!("the bound mesh asset is invalid: {error}")))?;
    if asset.mesh.is_none() || asset.mesh_source.is_some() {
        return Err(corrupt(
            "the bound mesh asset is not an inline geometry mesh".into(),
        ));
    }
    asset
        .validate()
        .map_err(|errors| corrupt(errors.join("; ")))?;
    Ok(Some(asset))
}

fn persist_geometry_reuse_asset(
    store_root: &Path,
    context: &CurrentLiveRequestContext,
    source_scene_revision: u64,
    input_sha256: String,
    asset: &FemDomainMeshAssetIR,
) -> anyhow::Result<GeometryReuseReference> {
    let bytes = serde_json::to_vec(asset)?;
    let byte_count = bytes.len() as u64;
    anyhow::ensure!(
        byte_count <= MAX_GEOMETRY_REUSE_BYTES,
        "mesh asset exceeds the Live reuse bound"
    );
    let store = fullmag_session::SessionStore::open_existing(store_root.to_path_buf())?;
    let asset_sha256 = store.cas().put(&bytes)?;
    Ok(GeometryReuseReference {
        schema_version: GEOMETRY_REUSE_SCHEMA.into(),
        session_id: context.session_id.clone(),
        session_epoch: context.session_epoch,
        source_scene_revision,
        input_sha256,
        asset_sha256,
        byte_count,
    })
}

impl GeometryReuseReference {
    pub(crate) fn provenance(&self) -> Value {
        json!({
            "source": "geometry_only_mesh",
            "source_scene_revision": self.source_scene_revision,
            "input_sha256": self.input_sha256,
            "asset_sha256": self.asset_sha256,
        })
    }
}

pub(crate) fn can_qualify_live_geometry_reuse(
    scene: &SceneDocument,
    asset: &FemDomainMeshAssetIR,
) -> bool {
    scene.study.requested_backend.eq_ignore_ascii_case("fem")
        && scene
            .study
            .execution_profile
            .as_ref()
            .is_none_or(|profile| {
                matches!(
                    &profile.defaults.backend,
                    fullmag_ir::FieldPatch::Absent
                        | fullmag_ir::FieldPatch::Value(fullmag_ir::BackendTarget::Fem),
                )
            })
        && scene.study.fem_domain_mesh.is_none()
        && scene.study.mesh_interfaces.is_empty()
        && scene.current_transports.is_empty()
        && scene.spin_transports.is_empty()
        && scene.oersted_fields.is_empty()
        && scene.antenna_field_solve_stages.is_empty()
        && scene.antenna_target_projections.is_empty()
        && scene.solved_antenna_drives.is_empty()
        && scene.objects.iter().all(|object| object.regions.is_empty())
        && asset.object_region_markers.is_empty()
        && asset.mesh.as_ref().is_some_and(|mesh| {
            !mesh.cells.types.is_empty()
                && mesh
                    .cells
                    .types
                    .iter()
                    .all(|cell| *cell == fullmag_ir::FemCellTypeIR::Tet4)
        })
}

pub(crate) fn bind_reused_geometry_to_inputs(
    repo_root: &Path,
    scene: &SceneDocument,
    asset: &FemDomainMeshAssetIR,
    provenance: &Value,
    inputs: &mut [fullmag_application::StudyStepExecutionInput],
) -> Result<bool, ApiError> {
    let mut recipes = Vec::with_capacity(inputs.len());
    let mut geometry_names = Vec::with_capacity(inputs.len());
    for input in inputs.iter() {
        let problem = &input.problem;
        if problem.backend_policy.requested_backend != fullmag_ir::BackendTarget::Fem
            || problem.geometry_assets.is_some()
            || !problem.object_regions.is_empty()
            || input.layers.iter().any(|layer| {
                !matches!(
                    &layer.request.backend,
                    fullmag_ir::FieldPatch::Absent
                        | fullmag_ir::FieldPatch::Value(fullmag_ir::BackendTarget::Fem),
                )
            })
            || !matches!(
                &problem.study,
                fullmag_ir::StudyIR::TimeEvolution { .. } | fullmag_ir::StudyIR::Relaxation { .. }
            )
        {
            return Ok(false);
        }
        let Some(hints) = problem
            .backend_policy
            .discretization_hints
            .as_ref()
            .and_then(|hints| hints.fem.as_ref())
        else {
            return Ok(false);
        };
        let mut owner_to_geometry = std::collections::BTreeMap::new();
        let mut geometry_to_owner = std::collections::BTreeMap::new();
        for magnet in &problem.magnets {
            let Some(owner) = magnet.object_id.as_ref() else {
                return Ok(false);
            };
            let Some(region) = problem
                .regions
                .iter()
                .find(|region| region.name == magnet.region)
            else {
                return Ok(false);
            };
            if owner_to_geometry
                .insert(owner.clone(), region.geometry.clone())
                .is_some()
                || geometry_to_owner
                    .insert(region.geometry.clone(), owner.clone())
                    .is_some()
            {
                return Ok(false);
            }
        }
        if owner_to_geometry.len() != asset.region_markers.len()
            || owner_to_geometry.len() != problem.geometry.entries.len()
            || asset
                .region_markers
                .iter()
                .any(|marker| !owner_to_geometry.contains_key(&marker.geometry_name))
        {
            return Ok(false);
        }
        let metadata = &problem.problem_meta.runtime_metadata;
        recipes.push(json!({
            "order": hints.order,
            "hmax": hints.hmax,
            "mesh": hints.mesh,
            "geometries": problem.geometry.entries,
            "geometry_object_ids": geometry_to_owner,
            "study_universe": metadata.get("study_universe"),
            "mesh_workflow": metadata.get("mesh_workflow"),
        }));
        geometry_names.push(owner_to_geometry);
    }
    let request = json!({"payload": geometry_only_mesh_payload(scene)?, "recipes": recipes});
    let encoded =
        serde_json::to_string(&request).map_err(|error| ApiError::internal(error.to_string()))?;
    let literal =
        serde_json::to_string(&encoded).map_err(|error| ApiError::internal(error.to_string()))?;
    if literal.len() > 96 * 1024 {
        return Ok(false);
    }
    let script = format!(
        "import json; from fullmag.meshing.geometry_mesh_build import matches_solver_geometry_reuse; \
         print(json.dumps(matches_solver_geometry_reuse(**json.loads({literal}))))"
    );
    let output = crate::script::run_python_helper(repo_root, &["-c".to_string(), script])?;
    if !output.status.success() {
        return Err(ApiError::internal(format!(
            "mesh reuse qualification failed: {}",
            helper_error_message(&output.stderr)
        )));
    }
    let matched = serde_json::from_slice::<bool>(&output.stdout).map_err(|error| {
        ApiError::internal(format!("invalid mesh reuse qualification: {error}"))
    })?;
    if !matched {
        return Ok(false);
    }

    for (input, names) in inputs.iter_mut().zip(geometry_names) {
        let mut mesh = asset.clone();
        for marker in &mut mesh.region_markers {
            marker.geometry_name = names[&marker.geometry_name].clone();
        }
        input.problem.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
            fem_domain_mesh_asset: Some(mesh),
            ..Default::default()
        });
        input
            .problem
            .problem_meta
            .runtime_metadata
            .insert("live_geometry_mesh_reuse".into(), provenance.clone());
    }
    Ok(true)
}

fn helper_error_message(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    text.lines()
        .rev()
        .find_map(|line| {
            serde_json::from_str::<Value>(line.trim())
                .ok()
                .and_then(|value| {
                    value
                        .get("error")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
        })
        .unwrap_or_else(|| {
            let tail = text.trim();
            let skip = tail.chars().count().saturating_sub(2000);
            tail.chars().skip(skip).collect()
        })
}

fn run_geometry_mesh_build(
    repo_root: &Path,
    payload: &Value,
) -> Result<GeometryMeshBuildOutput, ApiError> {
    let payload_text = serde_json::to_string(payload).map_err(|error| {
        ApiError::internal(format!("failed to encode mesh build input: {error}"))
    })?;
    // A JSON string literal is a valid Python string literal.
    let payload_literal = serde_json::to_string(&payload_text).map_err(|error| {
        ApiError::internal(format!("failed to quote mesh build input: {error}"))
    })?;
    let script = format!(
        "import io, sys; sys.stdin = io.StringIO({payload_literal}); \
         from fullmag.meshing.geometry_mesh_build import main; main()"
    );
    let output = crate::script::run_python_helper(repo_root, &["-c".to_string(), script])?;
    if !output.status.success() {
        let message = helper_error_message(&output.stderr);
        return Err(if output.status.code() == Some(USER_FACING_EXIT_CODE) {
            ApiError::bad_request(message)
        } else {
            ApiError::unprocessable_with_code("geometry_mesh_build_failed", message)
        });
    }
    let parsed: GeometryMeshBuildOutput =
        serde_json::from_slice(&output.stdout).map_err(|error| {
            ApiError::internal(format!(
                "geometry mesh build returned an invalid result: {error}"
            ))
        })?;
    if parsed.schema != GEOMETRY_MESH_BUILD_SCHEMA {
        return Err(ApiError::internal(format!(
            "geometry mesh build returned schema '{}', expected '{GEOMETRY_MESH_BUILD_SCHEMA}'",
            parsed.schema
        )));
    }
    Ok(parsed)
}

fn quality_summary(quality: Option<&Value>) -> Value {
    let Some(quality) = quality else {
        return Value::Null;
    };
    json!({
        "n_elements": quality.get("nElements"),
        "sicn_min": quality.get("sicnMin"),
        "sicn_max": quality.get("sicnMax"),
        "sicn_mean": quality.get("sicnMean"),
        "sicn_p5": quality.get("sicnP5"),
        "gamma_min": quality.get("gammaMin"),
        "gamma_mean": quality.get("gammaMean"),
        "avg_quality": quality.get("avgQuality"),
    })
}

fn mesh_bounds(mesh: &MeshIR) -> (Value, Value) {
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for node in &mesh.nodes {
        for axis in 0..3 {
            min[axis] = min[axis].min(node[axis]);
            max[axis] = max[axis].max(node[axis]);
        }
    }
    if mesh.nodes.is_empty() {
        return (Value::Null, Value::Null);
    }
    (json!(min), json!(max))
}

struct GeometryMeshPublication {
    fem_mesh: fullmag_runner::FemMeshPayload,
    mesh_workspace: Value,
    mesh_asset: FemDomainMeshAssetIR,
}

fn geometry_mesh_publication(
    output: GeometryMeshBuildOutput,
    command_id: &str,
    source_scene_revision: u64,
    input_sha256: &str,
    previous_history: Vec<Value>,
    canonical_policy_snapshot: Value,
) -> Result<GeometryMeshPublication, ApiError> {
    let (mesh, object_segments, mesh_parts) =
        fullmag_plan::pack_geometry_only_shared_domain_mesh(&output.mesh, &output.region_markers)
            .map_err(|reason| {
            ApiError::unprocessable_with_code("geometry_mesh_packing_failed", reason)
        })?;
    let provenance = output.mesh_provenance.unwrap_or(Value::Null);
    let build_report = provenance
        .get("shared_domain_build_report")
        .cloned()
        .and_then(|report| serde_json::from_value::<FemSharedDomainBuildReportIR>(report).ok());
    let fem_mesh = fullmag_runner::FemMeshPayload::from_geometry_only_domain_mesh(
        &mesh,
        &object_segments,
        &mesh_parts,
        build_report.clone(),
    );
    let quality_summary = quality_summary(output.quality.as_ref());
    let (bounds_min, bounds_max) = mesh_bounds(&mesh);
    let build_id = format!("mesh:{command_id}");
    let hmax = provenance.get("hmax").cloned().unwrap_or(Value::Null);
    let effective_airbox_target = provenance
        .get("effective_airbox_target")
        .cloned()
        .unwrap_or(Value::Null);
    let effective_per_object_targets = provenance
        .get("effective_per_object_targets")
        .cloned()
        .unwrap_or(Value::Null);
    let summary = json!({
        "kind": "mesh_build_summary",
        "command_id": command_id,
        "build_id": build_id,
        "status": "completed",
        "mesh_generation_id": fem_mesh.generation_id,
        "mesh_target": "study_domain",
        "mesh_reason": "geometry_only_build",
        "source_scene_revision": source_scene_revision,
        "canonical_policy_snapshot": canonical_policy_snapshot,
        "shared_domain_build_mode": provenance.get("shared_domain_build_mode"),
        "effective_airbox_target": effective_airbox_target,
        "effective_per_object_targets": effective_per_object_targets,
        "node_count": mesh.nodes.len(),
        "element_count": mesh.cell_count(),
        "boundary_face_count": mesh.facet_count(),
    });
    let mut history = previous_history;
    history.push(json!({
        "command_id": command_id,
        "build_id": build_id,
        "status": "completed",
        "mesh_generation_id": fem_mesh.generation_id,
        "mesh_name": mesh.mesh_name,
        "generation_mode": "geometry_only_shared_domain",
        "node_count": mesh.nodes.len(),
        "element_count": mesh.cell_count(),
        "boundary_face_count": mesh.facet_count(),
        "quality": quality_summary,
        "mesh_target": "study_domain",
        "mesh_reason": "geometry_only_build",
        "source_scene_revision": source_scene_revision,
        "canonical_policy_snapshot": summary["canonical_policy_snapshot"],
        "mesh_provenance": provenance,
        "mesh_statistics": output.mesh_statistics,
        "quality_data_artifact": output.quality_data_artifact,
    }));
    let mesh_workspace = json!({
        "status": "completed",
        "source_scene_revision": source_scene_revision,
        "geometry_input_binding": geometry_input_binding(&fem_mesh, input_sha256),
        "active_build": null,
        "last_build_error": null,
        "mesh_summary": {
            "mesh_id": fem_mesh.mesh_id,
            "mesh_name": mesh.mesh_name,
            "backend": "fem",
            "source_kind": "geometry_only_shared_domain",
            "order": provenance.get("order"),
            "hmax": hmax,
            "node_count": mesh.nodes.len(),
            "element_count": mesh.cell_count(),
            "boundary_face_count": mesh.facet_count(),
            "bounds_min": bounds_min,
            "bounds_max": bounds_max,
            "domain_mesh_mode": fem_mesh.domain_mesh_mode,
            "generation_id": fem_mesh.generation_id,
        },
        "mesh_quality_summary": quality_summary,
        "quality_data_artifact": output.quality_data_artifact,
        "mesh_statistics": output.mesh_statistics,
        "mesh_cost_report": {
            "node_count": mesh.nodes.len(),
            "element_count": mesh.cell_count(),
            "boundary_face_count": mesh.facet_count(),
            "status": "completed",
        },
        "effective_airbox_target": summary["effective_airbox_target"],
        "effective_per_object_targets": summary["effective_per_object_targets"],
        "mesh_pipeline_status": [{
            "id": "remesh",
            "status": "completed",
            "detail": "geometry-only shared-domain mesh published",
        }],
        "mesh_history": history,
        "last_build_summary": summary,
    });
    Ok(GeometryMeshPublication {
        fem_mesh,
        mesh_workspace,
        mesh_asset: FemDomainMeshAssetIR {
            mesh_source: None,
            mesh: Some(output.mesh),
            region_markers: output.region_markers,
            object_region_markers: output.object_region_markers,
            build_report,
        },
    })
}

/// Mesh the current scene and publish the result into the live read model.
/// The caller owns the command journal record; this function only produces
/// the mesh and fails without mutating the workspace when meshing fails.
pub(crate) async fn build_and_publish_geometry_mesh(
    state: &Arc<AppState>,
    context: &CurrentLiveRequestContext,
    command_id: &str,
    scene: SceneDocument,
) -> Result<(), ApiError> {
    let previous_history = {
        let current = state.current_live_state.read().await;
        let snapshot = current
            .as_ref()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
        crate::ensure_current_live_request_context(
            snapshot,
            context,
            state
                .current_live_session_epoch
                .load(std::sync::atomic::Ordering::Acquire),
        )?;
        snapshot
            .mesh_workspace
            .as_deref()
            .and_then(|workspace| workspace.get("mesh_history"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    let payload = geometry_only_mesh_payload(&scene)?;
    let input_sha256 = mesh_input_sha256(&scene, &payload);
    let canonical_policy_snapshot = json!({
        "universe": scene.study.universe_mesh.as_ref().or(scene.universe.as_ref()),
        "shared_domain": scene.study.shared_domain_mesh,
        "objects": payload["mesh_options"]["per_geometry"],
    });
    let repo_root = state.repo_root.clone();
    let store_root = state.submit_store_root.clone();
    let owner = context.clone();
    let build_command_id = command_id.to_owned();
    let source_scene_revision = scene.revision;
    let captured_input = input_sha256.clone();
    let publication = tokio::task::spawn_blocking(move || {
        let output = run_geometry_mesh_build(&repo_root, &payload)?;
        let mut publication = geometry_mesh_publication(
            output,
            &build_command_id,
            source_scene_revision,
            &captured_input,
            previous_history,
            canonical_policy_snapshot,
        )?;
        if let Some(root) = store_root {
            match persist_geometry_reuse_asset(
                &root, &owner, source_scene_revision, captured_input, &publication.mesh_asset,
            ) {
                Ok(reference) => publication.mesh_workspace[GEOMETRY_REUSE_KEY] = json!(reference),
                Err(error) => tracing::warn!(error = %error, "geometry mesh published without a reusable asset"),
            }
        }
        Ok::<_, ApiError>((publication.fem_mesh, publication.mesh_workspace))
    })
    .await
    .map_err(|error| ApiError::internal(format!("geometry mesh build task failed: {error}")))??;

    {
        let _transition = state.current_live_session_transition.lock().await;
        if !state
            .current_command_ledger
            .lock()
            .await
            .iter()
            .any(|record| {
                record.command.command_id == command_id
                    && record.status == CommandLifecycleState::Accepted
            })
        {
            return Err(ApiError::conflict_with_code(
                "geometry_mesh_command_inactive",
                "the mesh build command is no longer active",
            ));
        }
        let mut current = state.current_live_state.write().await;
        let snapshot = current
            .as_mut()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
        crate::ensure_current_live_request_context(
            snapshot,
            context,
            state
                .current_live_session_epoch
                .load(std::sync::atomic::Ordering::Acquire),
        )?;
        let current_scene = snapshot
            .scene_document
            .as_ref()
            .ok_or_else(|| ApiError::conflict("the authored scene was removed while meshing"))?;
        let same_inputs = geometry_only_mesh_payload(current_scene)
            .is_ok_and(|payload| mesh_input_sha256(current_scene, &payload) == input_sha256);
        if !same_inputs {
            return Err(ApiError::conflict_with_code(
                "geometry_mesh_inputs_changed",
                "the authored geometry or mesh policy changed while meshing",
            ));
        }
        let validated_scene_revision = current_scene.revision;
        // This is the selected geometry domain, even if the preceding run
        // used an FDM execution plan. Retain unrelated metadata and history.
        let mut metadata = snapshot.metadata.as_deref()
            .and_then(Value::as_object).cloned().unwrap_or_default();
        for key in ["execution_plan", "artifact_layout", "live_preview", "magnetic_state_present"] {
            metadata.remove(key);
        }
        metadata.insert("capabilities".into(), Value::Null);
        let mut published = snapshot.clone();
        crate::session::apply_current_live_snapshot(
            &mut published,
            CurrentLiveSnapshotRequest {
                session_id: context.session_id.clone(),
                session: None,
                session_status: None,
                metadata: Some(Value::Object(metadata)),
                mesh_workspace: Some(publication.1),
                stage_execution: None,
                simulation_preparation: None,
                run: None,
                live_state: None,
                frozen_spins_runtime_status: None,
                coupled_checkpoint: None,
                latest_scalar_row: None,
                latest_fields: None,
                replace_latest_fields: false,
                field_generation: None,
                preview_fields: None,
                clear_preview_cache: false,
                engine_log: None,
                solver_profile: None,
                fem_mesh: Some(publication.0),
            },
        )?;
        crate::session::clear_mesh_dirty_tags_for_built_scene(
            &mut published,
            validated_scene_revision,
        );
        *snapshot = published;
    }
    if let Some(snapshot) = state.current_live_state.read().await.as_ref().cloned() {
        let display_revision = state.current_display_selection.read().await.revision;
        let realtime_state =
            crate::current_live_realtime_state_from_snapshot(state, &snapshot, display_revision)
                .await;
        crate::publish_current_live_realtime_batch_changed(state, &realtime_state, false, 0)
            .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_domain_options_parse_authored_text_and_drop_unset_values() {
        let policy = ScriptBuilderMeshState {
            hmax: "1e-8".to_string(),
            hmin: String::new(),
            optimize: "Netgen".to_string(),
            order: Some(2),
            ..ScriptBuilderMeshState::default()
        };

        let options = shared_domain_mesh_options(&policy).unwrap();

        assert_eq!(options.get("hmax"), Some(&json!(1e-8)));
        assert!(!options.contains_key("hmin"));
        assert!(!options.contains_key("order"));
        assert_eq!(options.get("optimize"), Some(&json!("Netgen")));
    }

    #[test]
    fn geometry_binding_survives_coefficients_and_rejects_changed_mesh_at_equal_node_count() {
        let mut scene: SceneDocument = serde_json::from_value(json!({
            "version":"scene.v2",
            "revision":7,
            "objects":[{
                "id":"film", "name":"Film", "role":"magnet",
                "geometry":{"geometry_kind":"Box", "geometry_params":{"size":[3e-9,3e-9,3e-9]}},
                "material_ref":"first"
            }],
            "materials":[
                {"id":"first","name":"First","properties":{"Ms":800000.0,"Aex":1e-11}},
                {"id":"second","name":"Second","properties":{"Ms":600000.0,"Aex":1e-11,"alpha":0.3}}
            ]
        }))
        .unwrap();
        scene.study.requested_backend = "fem".into();
        let input_sha = mesh_input_sha256(&scene, &geometry_only_mesh_payload(&scene).unwrap());
        let request = serde_json::from_value(json!({"session_id":"geometry-binding"})).unwrap();
        let mut snapshot = crate::session::default_current_live_state(&request);
        let mut mesh = MeshIR::default();
        mesh.mesh_name = MESH_NAME.into();
        mesh.nodes = vec![
            [0.0, 0.0, 0.0],
            [1e-9, 0.0, 0.0],
            [0.0, 1e-9, 0.0],
            [0.0, 0.0, 1e-9],
        ];
        mesh.cells = fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]);
        mesh.element_markers = vec![1];
        let payload =
            fullmag_runner::FemMeshPayload::from_geometry_only_domain_mesh(&mesh, &[], &[], None);
        snapshot.mesh_workspace = Some(
            json!({
                "geometry_input_binding": geometry_input_binding(&payload, &input_sha),
                "mesh_summary": {"source_kind":"geometry_only_shared_domain"},
                "last_build_summary": {"source_scene_revision":7}
            })
            .into(),
        );
        snapshot.fem_mesh = Some(payload.into());
        snapshot.scene_document = Some(scene.clone());

        let mut edited = scene.clone();
        edited.revision = 8;
        edited.materials[0].properties.ms = Some(700000.0);
        edited.objects[0].material_ref = "second".into();
        edited.objects[0].magnetization_ref = Some("new-texture".into());
        snapshot.scene_document = Some(edited.clone());
        assert_eq!(
            bound_geometry_mesh_is_current(&snapshot, &edited),
            Some(true)
        );
        assert!(
            crate::router_v2::handlers::meshing::mesh::shared_domain_mesh_is_current(
                &snapshot, &edited
            )
        );
        assert_eq!(
            crate::router_v2::handlers::meshing::mesh::mesh_source_scene_revision(&snapshot),
            Some(7)
        );

        let mut moved = edited.clone();
        moved.objects[0].transform.translation[0] = 1e-9;
        assert_eq!(
            bound_geometry_mesh_is_current(&snapshot, &moved),
            Some(false)
        );
        assert_eq!(snapshot.fem_mesh.as_ref().unwrap().nodes.len(), 4);
        snapshot.fem_mesh.as_mut().unwrap().nodes[1][0] = 2e-9;
        assert_eq!(
            bound_geometry_mesh_is_current(&snapshot, &edited),
            Some(false)
        );
    }

    #[test]
    fn reuse_reference_fences_scene_inputs_and_cas_digest() {
        let mut scene: SceneDocument = serde_json::from_value(json!({
            "objects":[{
                "id":"film", "name":"Film",
                "geometry":{"geometry_kind":"Box", "geometry_params":{"size":[1.0,1.0,1.0]}},
                "material_ref":""
            }]
        }))
        .unwrap();
        scene.study.requested_backend = "fem".into();
        let input_sha = mesh_input_sha256(&scene, &geometry_only_mesh_payload(&scene).unwrap());
        let context = CurrentLiveRequestContext {
            session_id: "geometry-reuse".into(),
            run_id: None,
            session_epoch: 2,
            request_scope_epoch: "api:2".into(),
        };
        let dir = tempfile::tempdir().unwrap();
        let store = fullmag_session::SessionStore::open(dir.path().join("store")).unwrap();
        let mut mesh = MeshIR::default();
        mesh.mesh_name = "study_domain".into();
        mesh.nodes = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ];
        mesh.cells = fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]);
        mesh.element_markers = vec![1];
        let asset = FemDomainMeshAssetIR {
            mesh_source: None,
            mesh: Some(mesh),
            build_report: None,
            region_markers: vec![FemDomainRegionMarkerIR {
                geometry_name: "film".into(),
                marker: 1,
            }],
            object_region_markers: Vec::new(),
        };
        let reference =
            persist_geometry_reuse_asset(store.root(), &context, scene.revision, input_sha, &asset)
                .unwrap();

        let mut moved = scene.clone();
        moved.objects[0].transform.translation[0] = 1.0;
        assert!(load_geometry_reuse_asset(&store, &moved, &reference)
            .unwrap()
            .is_none());
        let request = serde_json::from_value(json!({"session_id":"geometry-reuse"})).unwrap();
        let mut snapshot = crate::session::default_current_live_state(&request);
        snapshot.mesh_workspace = Some(json!({(GEOMETRY_REUSE_KEY): reference}).into());
        assert!(geometry_reuse_reference(&snapshot, &context).is_some());
        let mut wrong_epoch = context;
        wrong_epoch.session_epoch += 1;
        assert!(geometry_reuse_reference(&snapshot, &wrong_epoch).is_none());

        let missing = GeometryReuseReference {
            asset_sha256: "0".repeat(64),
            ..reference
        };
        assert!(load_geometry_reuse_asset(&store, &scene, &missing).is_err());
    }

    #[test]
    fn body_hmax_requires_a_shared_or_complete_object_target() {
        let unset = Map::new();
        let objects = vec![
            json!({"hmax": "2e-8"}),
            json!({"maximum_element_size": 3e-8}),
        ];

        assert_eq!(body_hmax(&unset, &objects, 2), Some(3e-8));
        assert_eq!(body_hmax(&unset, &objects[..1], 2), None);
        let mut shared = Map::new();
        shared.insert("hmax".to_string(), json!(1e-8));
        assert_eq!(body_hmax(&shared, &[], 2), Some(1e-8));
    }
}
