use anyhow::{anyhow, bail, Context, Result};
use fullmag_ir::{BackendPlanIR, ExecutionPlanIR};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use std::collections::BTreeSet;
use std::time::{Duration, Instant};

use crate::control_room::{api_base_url, current_live_api_client};
use crate::live_workspace::LocalLiveWorkspace;

const DEV_SMOKE_TIMEOUT: Duration = Duration::from_secs(20);
const DEV_SMOKE_POLL_INTERVAL: Duration = Duration::from_millis(200);
const FMMT_HEADER_LEN: usize = 32;

#[derive(Debug, Deserialize)]
struct MeshSummaryResource {
    mesh_summary: Option<MeshSummaryPayload>,
}

#[derive(Debug, Deserialize)]
struct MeshSummaryPayload {
    mesh_id: Option<String>,
    generation_id: Option<String>,
    domain_mesh_mode: Option<String>,
    node_count: usize,
    element_count: usize,
    boundary_face_count: usize,
}

#[derive(Debug, Deserialize)]
struct MeshActiveBuildResource {
    mesh_pipeline_status: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Deserialize)]
struct MeshSharedDomainManifestResource {
    mesh_name: String,
    mesh_id: String,
    generation_id: Option<String>,
    domain_mesh_mode: Option<String>,
    object_segments: Vec<MeshObjectSegmentResource>,
    mesh_parts: Vec<MeshPartResource>,
}

#[derive(Debug, Deserialize)]
struct MeshObjectSegmentResource {
    object_id: String,
    node_count: u32,
    element_count: u32,
    boundary_face_count: u32,
}

#[derive(Debug, Deserialize)]
struct MeshPartResource {
    id: String,
    role: String,
    object_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AuthoringSceneResource {
    objects: Vec<SceneObjectResource>,
}

#[derive(Debug, Deserialize)]
struct SceneObjectResource {
    id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FmmtHeader {
    node_count: u32,
    element_count: u32,
    boundary_face_count: u32,
    element_marker_count: u32,
    boundary_marker_count: u32,
}

pub(crate) fn run_post_materialization_dev_smoke_tests(
    session_id: &str,
    execution_plan: &ExecutionPlanIR,
    live_workspace: &LocalLiveWorkspace,
) -> Result<()> {
    if !matches!(
        execution_plan.backend_plan,
        BackendPlanIR::Fem(_) | BackendPlanIR::FemEigen(_)
    ) {
        return Ok(());
    }

    live_workspace.push_log("system", "Running dev mesh API smoke test");
    eprintln!(
        "[fullmag][dev] running mesh API smoke test for session {}",
        session_id
    );

    let smoke_result = run_mesh_api_smoke_test();
    match smoke_result {
        Ok(summary) => {
            let message = format!("Dev mesh API smoke test passed: {summary}");
            eprintln!("[fullmag][dev] {message}");
            live_workspace.push_log("info", message);
            Ok(())
        }
        Err(error) => {
            let message = format!("Dev mesh API smoke test failed: {error:#}");
            eprintln!("[fullmag][dev][FAIL] {message}");
            live_workspace.push_log("error", message);
            Err(error)
        }
    }
}

fn run_mesh_api_smoke_test() -> Result<String> {
    let scene = wait_for_json_resource::<AuthoringSceneResource, _>(
        "/v1/live/current/authoring/scene",
        "authoring scene",
        |scene| !scene.objects.is_empty(),
    )?;
    let summary = wait_for_json_resource::<MeshSummaryResource, _>(
        "/v1/live/current/mesh/summary",
        "mesh summary",
        |summary| {
            summary.mesh_summary.as_ref().is_some_and(|mesh_summary| {
                mesh_summary.node_count > 0 && mesh_summary.element_count > 0
            })
        },
    )?;
    let active_build = wait_for_json_resource::<MeshActiveBuildResource, _>(
        "/v1/live/current/mesh/builds/active",
        "mesh active build",
        |active_build| {
            active_build
                .mesh_pipeline_status
                .as_ref()
                .is_some_and(|stages| !stages.is_empty())
        },
    )?;
    let manifest = wait_for_json_resource::<MeshSharedDomainManifestResource, _>(
        "/v1/live/current/mesh/shared-domain/manifest",
        "mesh shared-domain manifest",
        |manifest| !manifest.object_segments.is_empty(),
    )?;
    let shared_topology = wait_for_binary_resource(
        "/v1/live/current/mesh/shared-domain/topology",
        "mesh shared-domain topology",
    )?;

    let scene_object_ids = scene
        .objects
        .iter()
        .map(|entry| entry.id.clone())
        .collect::<BTreeSet<_>>();
    let object_id = resolve_smoke_object_id(&scene_object_ids, &manifest)?;

    let object_topology = wait_for_binary_resource(
        &format!("/v1/live/current/mesh/objects/{object_id}/topology"),
        "mesh object topology",
    )?;

    let summary_mesh = summary
        .mesh_summary
        .as_ref()
        .ok_or_else(|| anyhow!("mesh summary missing after readiness wait"))?;
    let shared_header = parse_fmmt_header(&shared_topology)?;
    let object_header = parse_fmmt_header(&object_topology)?;

    if shared_header.node_count == 0 || shared_header.element_count == 0 {
        bail!(
            "shared-domain FMMT payload is empty (nodes={}, elements={})",
            shared_header.node_count,
            shared_header.element_count
        );
    }
    if summary_mesh.boundary_face_count > 0 && shared_header.boundary_face_count == 0 {
        bail!(
            "mesh summary advertises {} boundary faces but shared-domain FMMT payload has none",
            summary_mesh.boundary_face_count
        );
    }
    if object_header.node_count == 0 || object_header.element_count == 0 {
        bail!(
            "object FMMT payload is empty for {} (nodes={}, elements={})",
            object_id,
            object_header.node_count,
            object_header.element_count
        );
    }
    if object_header.node_count > shared_header.node_count
        || object_header.element_count > shared_header.element_count
    {
        bail!(
            "object topology {} is larger than shared-domain topology (object: {} nodes/{} elements, shared: {} nodes/{} elements)",
            object_id,
            object_header.node_count,
            object_header.element_count,
            shared_header.node_count,
            shared_header.element_count
        );
    }

    let expects_airbox = manifest.domain_mesh_mode.as_deref()
        == Some("shared_domain_mesh_with_air")
        || summary_mesh.domain_mesh_mode.as_deref() == Some("shared_domain_mesh_with_air");
    let has_airbox = manifest.mesh_parts.iter().any(|part| part.role == "air");
    if expects_airbox && !has_airbox {
        bail!(
            "shared-domain mesh manifest declares air-enabled meshing but exposes no air mesh part"
        );
    }

    let object_segment = manifest
        .object_segments
        .iter()
        .find(|segment| segment.object_id == object_id)
        .ok_or_else(|| anyhow!("shared-domain manifest missing object segment for {object_id}"))?;
    if object_segment.node_count == 0 || object_segment.element_count == 0 {
        bail!(
            "shared-domain manifest segment for {} is empty (nodes={}, elements={}, boundary_faces={})",
            object_id,
            object_segment.node_count,
            object_segment.element_count,
            object_segment.boundary_face_count
        );
    }

    let pipeline_stage_count = active_build
        .mesh_pipeline_status
        .as_ref()
        .map(|stages| stages.len())
        .unwrap_or(0);
    Ok(format!(
        "mesh_name={} mesh_id={} generation_id={} object_id={} airbox={} shared={}n/{}e/{}bf object={}n/{}e pipeline_stages={}",
        manifest.mesh_name,
        manifest.mesh_id,
        manifest
            .generation_id
            .as_deref()
            .or(summary_mesh.generation_id.as_deref())
            .or(summary_mesh.mesh_id.as_deref())
            .unwrap_or("unknown"),
        object_id,
        if has_airbox { manifest.mesh_parts.iter().find(|part| part.role == "air").map(|part| part.id.as_str()).unwrap_or("present") } else { "absent" },
        shared_header.node_count,
        shared_header.element_count,
        shared_header.boundary_face_count,
        object_header.node_count,
        object_header.element_count,
        pipeline_stage_count,
    ))
}

fn resolve_smoke_object_id(
    scene_object_ids: &BTreeSet<String>,
    manifest: &MeshSharedDomainManifestResource,
) -> Result<String> {
    if let Some(object_id) = manifest
        .mesh_parts
        .iter()
        .filter(|part| part.role == "magnetic_object")
        .filter_map(|part| part.object_id.as_ref())
        .find(|object_id| scene_object_ids.contains(*object_id))
    {
        return Ok(object_id.clone());
    }
    if let Some(object_id) = manifest
        .object_segments
        .iter()
        .map(|segment| &segment.object_id)
        .find(|object_id| scene_object_ids.contains(*object_id))
    {
        return Ok(object_id.clone());
    }
    bail!("mesh manifest exposes no magnetic object that matches the canonical authoring scene");
}

fn wait_for_json_resource<T, F>(path: &str, label: &str, ready: F) -> Result<T>
where
    T: DeserializeOwned,
    F: Fn(&T) -> bool,
{
    let deadline = Instant::now() + DEV_SMOKE_TIMEOUT;
    let url = format!("{}{}", api_base_url(), path);
    let mut last_error: Option<anyhow::Error> = None;

    while Instant::now() < deadline {
        match current_live_api_client().get(&url).send() {
            Ok(response) => {
                let status = response.status();
                if status == reqwest::StatusCode::NOT_FOUND
                    || status == reqwest::StatusCode::NO_CONTENT
                {
                    last_error = Some(anyhow!("{label} not ready yet ({status})"));
                } else {
                    match response.error_for_status() {
                        Ok(success) => match success.json::<T>() {
                            Ok(parsed) if ready(&parsed) => return Ok(parsed),
                            Ok(_) => {
                                last_error =
                                    Some(anyhow!("{label} responded but readiness invariant failed"));
                            }
                            Err(error) => {
                                last_error = Some(error).map(anyhow::Error::from);
                            }
                        },
                        Err(error) => {
                            last_error = Some(error).map(anyhow::Error::from);
                        }
                    }
                }
            }
            Err(error) => {
                last_error = Some(error).map(anyhow::Error::from);
            }
        }
        std::thread::sleep(DEV_SMOKE_POLL_INTERVAL);
    }

    Err(last_error.unwrap_or_else(|| anyhow!("timed out waiting for {label} ({url})")))
        .with_context(|| format!("timed out waiting for {label}"))
}

fn wait_for_binary_resource(path: &str, label: &str) -> Result<Vec<u8>> {
    let deadline = Instant::now() + DEV_SMOKE_TIMEOUT;
    let url = format!("{}{}", api_base_url(), path);
    let mut last_error: Option<anyhow::Error> = None;

    while Instant::now() < deadline {
        match current_live_api_client().get(&url).send() {
            Ok(response) => {
                let status = response.status();
                if status == reqwest::StatusCode::NOT_FOUND
                    || status == reqwest::StatusCode::NO_CONTENT
                {
                    last_error = Some(anyhow!("{label} not ready yet ({status})"));
                } else {
                    match response.error_for_status() {
                        Ok(success) => match success.bytes() {
                            Ok(bytes) if !bytes.is_empty() => return Ok(bytes.to_vec()),
                            Ok(_) => {
                                last_error =
                                    Some(anyhow!("{label} responded with an empty binary payload"));
                            }
                            Err(error) => {
                                last_error = Some(error).map(anyhow::Error::from);
                            }
                        },
                        Err(error) => {
                            last_error = Some(error).map(anyhow::Error::from);
                        }
                    }
                }
            }
            Err(error) => {
                last_error = Some(error).map(anyhow::Error::from);
            }
        }
        std::thread::sleep(DEV_SMOKE_POLL_INTERVAL);
    }

    Err(last_error.unwrap_or_else(|| anyhow!("timed out waiting for {label} ({url})")))
        .with_context(|| format!("timed out waiting for {label}"))
}

fn parse_fmmt_header(bytes: &[u8]) -> Result<FmmtHeader> {
    if bytes.len() < FMMT_HEADER_LEN {
        bail!(
            "FMMT buffer too short: got {} bytes, need at least {}",
            bytes.len(),
            FMMT_HEADER_LEN
        );
    }
    if &bytes[0..4] != b"FMMT" {
        bail!("invalid FMMT magic in mesh topology payload");
    }
    if bytes[4] != 1 {
        bail!("unsupported FMMT version {}", bytes[4]);
    }

    let node_count = u32::from_le_bytes(bytes[8..12].try_into().expect("slice length"));
    let element_count = u32::from_le_bytes(bytes[12..16].try_into().expect("slice length"));
    let boundary_face_count = u32::from_le_bytes(bytes[16..20].try_into().expect("slice length"));
    let element_marker_count = u32::from_le_bytes(bytes[20..24].try_into().expect("slice length"));
    let boundary_marker_count = u32::from_le_bytes(bytes[24..28].try_into().expect("slice length"));
    let expected_len = FMMT_HEADER_LEN
        + node_count as usize * 3 * std::mem::size_of::<f64>()
        + element_count as usize * 4 * std::mem::size_of::<u32>()
        + boundary_face_count as usize * 3 * std::mem::size_of::<u32>()
        + element_marker_count as usize * std::mem::size_of::<u32>()
        + boundary_marker_count as usize * std::mem::size_of::<u32>();
    if bytes.len() != expected_len {
        bail!(
            "FMMT byte-length mismatch: expected {}, got {}",
            expected_len,
            bytes.len()
        );
    }

    Ok(FmmtHeader {
        node_count,
        element_count,
        boundary_face_count,
        element_marker_count,
        boundary_marker_count,
    })
}

#[cfg(test)]
mod tests {
    use super::{parse_fmmt_header, resolve_smoke_object_id, FMMT_HEADER_LEN};

    #[test]
    fn parse_fmmt_header_accepts_valid_payload() {
        let mut bytes = vec![0u8; FMMT_HEADER_LEN + 3 * 4 * 8 + 4 * 4 + 3 * 3 * 4 + 4 + 12];
        bytes[0..4].copy_from_slice(b"FMMT");
        bytes[4] = 1;
        bytes[8..12].copy_from_slice(&(4u32).to_le_bytes());
        bytes[12..16].copy_from_slice(&(1u32).to_le_bytes());
        bytes[16..20].copy_from_slice(&(3u32).to_le_bytes());
        bytes[20..24].copy_from_slice(&(1u32).to_le_bytes());
        bytes[24..28].copy_from_slice(&(3u32).to_le_bytes());
        let header = parse_fmmt_header(&bytes).expect("valid FMMT header");
        assert_eq!(header.node_count, 4);
        assert_eq!(header.element_count, 1);
        assert_eq!(header.boundary_face_count, 3);
    }

    #[test]
    fn resolve_smoke_object_prefers_manifest_parts_and_scene_overlap() {
        let scene_ids = ["body".to_string(), "other".to_string()]
            .into_iter()
            .collect();
        let manifest = super::MeshSharedDomainManifestResource {
            mesh_name: "mesh".to_string(),
            mesh_id: "mesh:1".to_string(),
            generation_id: Some("gen:1".to_string()),
            domain_mesh_mode: Some("shared_domain_mesh_with_air".to_string()),
            object_segments: vec![super::MeshObjectSegmentResource {
                object_id: "body".to_string(),
                node_count: 4,
                element_count: 1,
                boundary_face_count: 4,
            }],
            mesh_parts: vec![super::MeshPartResource {
                id: "body".to_string(),
                role: "magnetic_object".to_string(),
                object_id: Some("body".to_string()),
            }],
        };
        let object_id = resolve_smoke_object_id(&scene_ids, &manifest).expect("object id");
        assert_eq!(object_id, "body");
    }
}
