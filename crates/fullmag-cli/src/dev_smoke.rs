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
const FMMT_V2_HEADER_LEN: usize = 64;
const FMMT_KIND_F64_U32: u8 = 1;

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
    #[serde(default)]
    node_count: u32,
    #[serde(default)]
    element_count: u32,
    #[serde(default)]
    boundary_face_count: u32,
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
    version: u8,
    node_count: u32,
    element_count: u32,
    boundary_face_count: u32,
    element_marker_count: u32,
    boundary_marker_count: u32,
    cell_type_counts: [u32; 4],
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
        "/v2/sessions/current/model/scene",
        "authoring scene",
        |scene| !scene.objects.is_empty(),
    )?;
    let summary = wait_for_json_resource::<MeshSummaryResource, _>(
        "/v2/sessions/current/meshing/summary",
        "mesh summary",
        |summary| {
            summary.mesh_summary.as_ref().is_some_and(|mesh_summary| {
                mesh_summary.node_count > 0 && mesh_summary.element_count > 0
            })
        },
    )?;
    let active_build = wait_for_json_resource::<MeshActiveBuildResource, _>(
        "/v2/sessions/current/meshing/builds/current",
        "mesh active build",
        |active_build| {
            active_build
                .mesh_pipeline_status
                .as_ref()
                .is_some_and(|stages| !stages.is_empty())
        },
    )?;
    let manifest = wait_for_json_resource::<MeshSharedDomainManifestResource, _>(
        "/v2/sessions/current/meshing/meshes/shared-domain/manifest",
        "mesh shared-domain manifest",
        |manifest| !manifest.object_segments.is_empty(),
    )?;
    let shared_topology = wait_for_binary_resource(
        "/v2/sessions/current/meshing/meshes/shared-domain/topology",
        "mesh shared-domain topology",
    )?;

    let scene_object_ids = scene
        .objects
        .iter()
        .map(|entry| entry.id.clone())
        .collect::<BTreeSet<_>>();
    let object_id = resolve_smoke_object_id(&scene_object_ids, &manifest)?;

    let object_topology = wait_for_binary_resource(
        &format!("/v2/sessions/current/meshing/meshes/objects/{object_id}/topology"),
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
    if object_header.version != shared_header.version {
        bail!(
            "object topology {} uses FMMT v{} but shared-domain topology uses FMMT v{}",
            object_id,
            object_header.version,
            shared_header.version
        );
    }
    for (label, (object_count, shared_count)) in
        ["tet4", "prism6", "pyramid5", "hex8"].into_iter().zip(
            object_header
                .cell_type_counts
                .into_iter()
                .zip(shared_header.cell_type_counts),
        )
    {
        if object_count > shared_count {
            bail!(
                "object topology {} has more {} cells than shared-domain topology (object={}, shared={})",
                object_id,
                label,
                object_count,
                shared_count
            );
        }
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
    Ok(format_mesh_api_smoke_summary(
        &manifest,
        summary_mesh,
        &object_id,
        shared_header,
        object_header,
        pipeline_stage_count,
    ))
}

fn format_mesh_api_smoke_summary(
    manifest: &MeshSharedDomainManifestResource,
    summary_mesh: &MeshSummaryPayload,
    object_id: &str,
    shared_header: FmmtHeader,
    object_header: FmmtHeader,
    pipeline_stage_count: usize,
) -> String {
    let generation_id = manifest
        .generation_id
        .as_deref()
        .or(summary_mesh.generation_id.as_deref())
        .or(summary_mesh.mesh_id.as_deref())
        .unwrap_or("unknown");
    let airbox = manifest
        .mesh_parts
        .iter()
        .find(|part| part.role == "air")
        .map(format_mesh_part_counts)
        .unwrap_or_else(|| "absent".to_string());

    format!(
        "mesh_name={} mesh_id={} generation_id={} object_id={} airbox={} ferromagnet={}:{}n/{}e/{}bf shared={}n/{}e/{}bf pipeline_stages={}",
        manifest.mesh_name,
        manifest.mesh_id,
        generation_id,
        object_id,
        airbox,
        object_id,
        object_header.node_count,
        object_header.element_count,
        object_header.boundary_face_count,
        shared_header.node_count,
        shared_header.element_count,
        shared_header.boundary_face_count,
        pipeline_stage_count,
    )
}

fn format_mesh_part_counts(part: &MeshPartResource) -> String {
    format!(
        "{}:{}n/{}e/{}bf",
        part.id, part.node_count, part.element_count, part.boundary_face_count
    )
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
                                last_error = Some(anyhow!(
                                    "{label} responded but readiness invariant failed"
                                ));
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
    if bytes[5] != FMMT_KIND_F64_U32 {
        bail!("unsupported FMMT topology kind {}", bytes[5]);
    }

    match bytes[4] {
        1 => parse_fmmt_v1_header(bytes),
        2 => parse_fmmt_v2_header(bytes),
        version => bail!("unsupported FMMT version {version}"),
    }
}

fn parse_fmmt_v1_header(bytes: &[u8]) -> Result<FmmtHeader> {
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
        version: 1,
        node_count,
        element_count,
        boundary_face_count,
        element_marker_count,
        boundary_marker_count,
        cell_type_counts: [element_count, 0, 0, 0],
    })
}

fn parse_fmmt_v2_header(bytes: &[u8]) -> Result<FmmtHeader> {
    if bytes.len() < FMMT_V2_HEADER_LEN {
        bail!(
            "FMMT v2 buffer too short: got {} bytes, need at least {}",
            bytes.len(),
            FMMT_V2_HEADER_LEN
        );
    }

    let node_count = read_u32(bytes, 8);
    let element_count = read_u32(bytes, 12);
    let boundary_face_count = read_u32(bytes, 16);
    let cell_connectivity_count = read_u32(bytes, 20);
    let facet_connectivity_count = read_u32(bytes, 24);
    let element_marker_count = read_u32(bytes, 28);
    let boundary_marker_count = read_u32(bytes, 32);
    let header_len = read_u32(bytes, 36) as usize;
    if header_len != FMMT_V2_HEADER_LEN || !header_len.is_multiple_of(8) {
        bail!(
            "FMMT v2 header length must be {} and 8-byte aligned, got {}",
            FMMT_V2_HEADER_LEN,
            header_len
        );
    }
    if element_marker_count != 0 && element_marker_count != element_count {
        bail!(
            "FMMT v2 cell marker count must be zero or {}, got {}",
            element_count,
            element_marker_count
        );
    }
    if boundary_marker_count != 0 && boundary_marker_count != boundary_face_count {
        bail!(
            "FMMT v2 facet marker count must be zero or {}, got {}",
            boundary_face_count,
            boundary_marker_count
        );
    }

    let position_count = (node_count as usize)
        .checked_mul(3)
        .ok_or_else(|| anyhow!("FMMT v2 position count overflow"))?;
    let cell_offset_count = (element_count as usize)
        .checked_add(1)
        .ok_or_else(|| anyhow!("FMMT v2 cell offset count overflow"))?;
    let facet_offset_count = (boundary_face_count as usize)
        .checked_add(1)
        .ok_or_else(|| anyhow!("FMMT v2 facet offset count overflow"))?;
    let sections = [
        (position_count, 8, "positions"),
        (element_count as usize, 4, "cell types"),
        (cell_offset_count, 4, "cell offsets"),
        (cell_connectivity_count as usize, 4, "cell connectivity"),
        (boundary_face_count as usize, 4, "facet types"),
        (boundary_face_count as usize, 4, "facet roles"),
        (facet_offset_count, 4, "facet offsets"),
        (facet_connectivity_count as usize, 4, "facet connectivity"),
        (element_marker_count as usize, 4, "cell markers"),
        (boundary_marker_count as usize, 4, "facet markers"),
    ];
    let mut offset = header_len;
    let mut cell_types = 0..0;
    for (index, (count, bytes_per_element, label)) in sections.into_iter().enumerate() {
        let range = fmmt_v2_section(&mut offset, count, bytes_per_element, label)?;
        if index == 1 {
            cell_types = range;
        }
    }
    if bytes.len() != offset {
        bail!(
            "FMMT byte-length mismatch: expected {}, got {}",
            offset,
            bytes.len()
        );
    }

    let mut counts = [0u32; 4];
    for code in bytes[cell_types]
        .chunks_exact(4)
        .map(|raw| u32::from_le_bytes(raw.try_into().expect("cell type code length")))
    {
        let index = match code {
            1..=4 => code as usize - 1,
            _ => bail!("FMMT v2 contains unknown cell type code {code}"),
        };
        let count = &mut counts[index];
        *count += 1;
    }

    Ok(FmmtHeader {
        version: 2,
        node_count,
        element_count,
        boundary_face_count,
        element_marker_count,
        boundary_marker_count,
        cell_type_counts: counts,
    })
}

fn fmmt_v2_section(
    offset: &mut usize,
    element_count: usize,
    bytes_per_element: usize,
    label: &str,
) -> Result<std::ops::Range<usize>> {
    let start = offset
        .checked_add(7)
        .map(|value| value & !7)
        .ok_or_else(|| anyhow!("FMMT v2 {label} alignment overflow"))?;
    let end = element_count
        .checked_mul(bytes_per_element)
        .and_then(|byte_len| start.checked_add(byte_len))
        .ok_or_else(|| anyhow!("FMMT v2 {label} byte-length overflow"))?;
    *offset = end;
    Ok(start..end)
}

fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(
        bytes[offset..offset + 4]
            .try_into()
            .expect("u32 slice length"),
    )
}

#[cfg(test)]
mod tests {
    use super::{parse_fmmt_header, resolve_smoke_object_id, FMMT_HEADER_LEN};

    #[test]
    fn parse_fmmt_header_accepts_valid_payload() {
        let mut bytes = vec![0u8; FMMT_HEADER_LEN + 3 * 4 * 8 + 4 * 4 + 3 * 3 * 4 + 4 + 12];
        bytes[0..4].copy_from_slice(b"FMMT");
        bytes[4] = 1;
        bytes[5] = 1;
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
    fn parse_fmmt_header_accepts_canonical_v2_mixed_payload() {
        let bytes = mixed_fmmt_v2_payload();

        let header = parse_fmmt_header(&bytes).expect("valid mixed FMMT v2 payload");

        assert_eq!(header.version, 2);
        assert_eq!(header.node_count, 8);
        assert_eq!(header.element_count, 3);
        assert_eq!(header.boundary_face_count, 2);
        assert_eq!(header.element_marker_count, 3);
        assert_eq!(header.boundary_marker_count, 2);
        assert_eq!(header.cell_type_counts, [1, 1, 1, 0]);
    }

    #[test]
    fn parse_fmmt_header_rejects_malformed_v2_payload_lengths() {
        let valid = mixed_fmmt_v2_payload();
        for malformed in [
            &valid[..valid.len() - 1],
            &[valid.as_slice(), &[0]].concat(),
        ] {
            let error = parse_fmmt_header(malformed)
                .expect_err("truncated or trailing FMMT v2 bytes must reject");
            assert!(
                error.to_string().contains("byte-length mismatch"),
                "{error:#}"
            );
        }
    }

    fn mixed_fmmt_v2_payload() -> Vec<u8> {
        let node_count = 8u32;
        let cell_types = [2u32, 3, 1];
        let cell_offsets = [0u32, 6, 11, 15];
        let cell_nodes = [0u32, 1, 2, 4, 5, 6, 0, 1, 2, 3, 4, 0, 1, 2, 4];
        let facet_types = [1u32, 2];
        let facet_roles = [1u32, 2];
        let facet_offsets = [0u32, 3, 7];
        let facet_nodes = [0u32, 1, 2, 0, 1, 5, 4];
        let cell_markers = [1u32, 1, 2];
        let facet_markers = [3u32, 4];
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"FMMT");
        bytes.push(2);
        bytes.push(1);
        bytes.extend_from_slice(&0u16.to_le_bytes());
        for count in [
            node_count,
            cell_types.len() as u32,
            facet_types.len() as u32,
            cell_nodes.len() as u32,
            facet_nodes.len() as u32,
            cell_markers.len() as u32,
            facet_markers.len() as u32,
        ] {
            bytes.extend_from_slice(&count.to_le_bytes());
        }
        bytes.extend_from_slice(&64u32.to_le_bytes());
        bytes.resize(64, 0);
        append_f64_section(&mut bytes, &vec![0.0; node_count as usize * 3]);
        append_u32_section(&mut bytes, &cell_types);
        append_u32_section(&mut bytes, &cell_offsets);
        append_u32_section(&mut bytes, &cell_nodes);
        append_u32_section(&mut bytes, &facet_types);
        append_u32_section(&mut bytes, &facet_roles);
        append_u32_section(&mut bytes, &facet_offsets);
        append_u32_section(&mut bytes, &facet_nodes);
        append_u32_section(&mut bytes, &cell_markers);
        append_u32_section(&mut bytes, &facet_markers);
        bytes
    }

    fn append_f64_section(bytes: &mut Vec<u8>, values: &[f64]) {
        bytes.resize(bytes.len().next_multiple_of(8), 0);
        for value in values {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
    }

    fn append_u32_section(bytes: &mut Vec<u8>, values: &[u32]) {
        bytes.resize(bytes.len().next_multiple_of(8), 0);
        for value in values {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
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
                node_count: 4,
                element_count: 1,
                boundary_face_count: 4,
            }],
        };
        let object_id = resolve_smoke_object_id(&scene_ids, &manifest).expect("object id");
        assert_eq!(object_id, "body");
    }

    #[test]
    fn format_mesh_api_smoke_summary_labels_airbox_and_ferromagnet_counts() {
        let summary = super::MeshSummaryPayload {
            mesh_id: Some("summary-mesh:1".to_string()),
            generation_id: None,
            domain_mesh_mode: Some("shared_domain_mesh_with_air".to_string()),
            node_count: 128,
            element_count: 512,
            boundary_face_count: 96,
        };
        let manifest = super::MeshSharedDomainManifestResource {
            mesh_name: "study_domain".to_string(),
            mesh_id: "study_domain:42".to_string(),
            generation_id: Some("42".to_string()),
            domain_mesh_mode: Some("shared_domain_mesh_with_air".to_string()),
            object_segments: vec![super::MeshObjectSegmentResource {
                object_id: "arch_waveguide".to_string(),
                node_count: 17,
                element_count: 41,
                boundary_face_count: 23,
            }],
            mesh_parts: vec![
                super::MeshPartResource {
                    id: "part:__air__".to_string(),
                    role: "air".to_string(),
                    object_id: None,
                    node_count: 111,
                    element_count: 471,
                    boundary_face_count: 73,
                },
                super::MeshPartResource {
                    id: "arch_waveguide".to_string(),
                    role: "magnetic_object".to_string(),
                    object_id: Some("arch_waveguide".to_string()),
                    node_count: 17,
                    element_count: 41,
                    boundary_face_count: 23,
                },
            ],
        };

        let summary_line = super::format_mesh_api_smoke_summary(
            &manifest,
            &summary,
            "arch_waveguide",
            super::FmmtHeader {
                version: 1,
                node_count: 128,
                element_count: 512,
                boundary_face_count: 96,
                element_marker_count: 512,
                boundary_marker_count: 96,
                cell_type_counts: [512, 0, 0, 0],
            },
            super::FmmtHeader {
                version: 1,
                node_count: 17,
                element_count: 41,
                boundary_face_count: 23,
                element_marker_count: 41,
                boundary_marker_count: 23,
                cell_type_counts: [41, 0, 0, 0],
            },
            7,
        );

        assert_eq!(
            summary_line,
            "mesh_name=study_domain mesh_id=study_domain:42 generation_id=42 object_id=arch_waveguide airbox=part:__air__:111n/471e/73bf ferromagnet=arch_waveguide:17n/41e/23bf shared=128n/512e/96bf pipeline_stages=7"
        );
    }
}
