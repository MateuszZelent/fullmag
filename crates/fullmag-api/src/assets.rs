//! Asset import/export: STL, MSH, mesh JSON, bounds computation.

use crate::error::ApiError;
use crate::types::*;
use serde_json::Value;
use std::path::Path;

pub(crate) fn make_repo_relative(repo_root: &Path, path: &Path) -> String {
    path.strip_prefix(repo_root)
        .unwrap_or(path)
        .display()
        .to_string()
}

pub(crate) fn summarize_uploaded_asset(
    file_name: &str,
    bytes: &[u8],
) -> Result<ImportedAssetSummary, ApiError> {
    let lower = file_name.to_lowercase();
    if lower.ends_with(".stl") {
        return summarize_stl_asset(file_name, bytes);
    }
    if lower.ends_with(".mesh.json") || lower.ends_with(".json") {
        return summarize_mesh_json_asset(file_name, bytes);
    }
    if lower.ends_with(".msh") {
        return summarize_msh_asset(file_name, bytes);
    }
    if lower.ends_with(".h5")
        || lower.ends_with(".hdf5")
        || lower.ends_with(".zarr")
        || lower.ends_with(".zarr.zip")
        || lower.ends_with(".field-state.json")
    {
        return Ok(ImportedAssetSummary {
            file_name: file_name.to_string(),
            file_bytes: bytes.len(),
            kind: "field_state".to_string(),
            bounds: None,
            triangle_count: None,
            node_count: None,
            element_count: None,
            boundary_face_count: None,
            note: Some(
                "Field-state payload stored for target-scoped save/load inspection.".to_string(),
            ),
        });
    }
    if lower.ends_with(".vtk") || lower.ends_with(".vtu") || lower.ends_with(".xdmf") {
        return Ok(ImportedAssetSummary {
            file_name: file_name.to_string(),
            file_bytes: bytes.len(),
            kind: "mesh_exchange".to_string(),
            bounds: None,
            triangle_count: None,
            node_count: None,
            element_count: None,
            boundary_face_count: None,
            note: Some(
                "Mesh exchange preview is stored on the backend, but topology summarization is deferred to the Python meshing pipeline.".to_string(),
            ),
        });
    }
    Ok(ImportedAssetSummary {
        file_name: file_name.to_string(),
        file_bytes: bytes.len(),
        kind: "unknown".to_string(),
        bounds: None,
        triangle_count: None,
        node_count: None,
        element_count: None,
        boundary_face_count: None,
        note: Some(
            "Backend stored the asset, but no preview parser is implemented for this format yet."
                .to_string(),
        ),
    })
}

pub(crate) fn summarize_mesh_json_asset(
    file_name: &str,
    bytes: &[u8],
) -> Result<ImportedAssetSummary, ApiError> {
    let payload: Value = serde_json::from_slice(bytes)
        .map_err(|error| ApiError::bad_request(format!("invalid mesh JSON: {}", error)))?;
    let nodes = payload
        .get("nodes")
        .and_then(Value::as_array)
        .ok_or_else(|| ApiError::bad_request("mesh JSON must contain nodes"))?;
    let elements = payload
        .get("elements")
        .and_then(Value::as_array)
        .ok_or_else(|| ApiError::bad_request("mesh JSON must contain elements"))?;
    let boundary_faces = payload
        .get("boundary_faces")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut points = Vec::new();
    for node in nodes {
        if let Some(point) = parse_point3_value(node) {
            points.push(point);
        }
    }

    Ok(ImportedAssetSummary {
        file_name: file_name.to_string(),
        file_bytes: bytes.len(),
        kind: "tet_mesh".to_string(),
        bounds: bounds_from_points(&points),
        triangle_count: None,
        node_count: Some(nodes.len()),
        element_count: Some(elements.len()),
        boundary_face_count: Some(boundary_faces.len()),
        note: None,
    })
}

pub(crate) fn summarize_msh_asset(
    file_name: &str,
    bytes: &[u8],
) -> Result<ImportedAssetSummary, ApiError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|error| ApiError::bad_request(format!("invalid text MSH payload: {}", error)))?;
    let lines = text.lines().collect::<Vec<_>>();
    let mut node_count = None;
    let mut element_count = None;
    let mut note =
        "Browser/API summary supports Gmsh ASCII v2 best; full topology parsing stays in the external meshing pipeline."
            .to_string();

    if let Some(position) = lines.iter().position(|line| line.trim() == "$Nodes") {
        if let Some(value) = lines
            .get(position + 1)
            .and_then(|line| line.trim().parse::<usize>().ok())
        {
            node_count = Some(value);
        }
    }

    if let Some(position) = lines.iter().position(|line| line.trim() == "$Elements") {
        if let Some(value) = lines
            .get(position + 1)
            .and_then(|line| line.trim().parse::<usize>().ok())
        {
            element_count = Some(value);
        }
    }

    if text.contains("$Entities") {
        note = "Gmsh v4 detected. The backend stored the asset, but detailed preview still defers to Python + Gmsh.".to_string();
    }

    Ok(ImportedAssetSummary {
        file_name: file_name.to_string(),
        file_bytes: bytes.len(),
        kind: "gmsh_mesh".to_string(),
        bounds: None,
        triangle_count: None,
        node_count,
        element_count,
        boundary_face_count: None,
        note: Some(note),
    })
}

pub(crate) fn summarize_stl_asset(
    file_name: &str,
    bytes: &[u8],
) -> Result<ImportedAssetSummary, ApiError> {
    let summary = if let Some(binary) = summarize_binary_stl_asset(file_name, bytes)? {
        binary
    } else {
        summarize_ascii_stl_asset(file_name, bytes)?
    };
    Ok(summary)
}

pub(crate) fn summarize_binary_stl_asset(
    file_name: &str,
    bytes: &[u8],
) -> Result<Option<ImportedAssetSummary>, ApiError> {
    if bytes.len() < 84 {
        return Ok(None);
    }
    let triangle_count = u32::from_le_bytes([bytes[80], bytes[81], bytes[82], bytes[83]]) as usize;
    if 84 + triangle_count * 50 != bytes.len() {
        return Ok(None);
    }

    let mut points = Vec::with_capacity(triangle_count * 3);
    let mut offset = 84;
    for _ in 0..triangle_count {
        offset += 12;
        for _ in 0..3 {
            let x = f32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) as f64;
            let y = f32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as f64;
            let z = f32::from_le_bytes(bytes[offset + 8..offset + 12].try_into().unwrap()) as f64;
            points.push([x, y, z]);
            offset += 12;
        }
        offset += 2;
    }

    Ok(Some(ImportedAssetSummary {
        file_name: file_name.to_string(),
        file_bytes: bytes.len(),
        kind: "stl_surface".to_string(),
        bounds: bounds_from_points(&points),
        triangle_count: Some(triangle_count),
        node_count: None,
        element_count: None,
        boundary_face_count: None,
        note: None,
    }))
}

pub(crate) fn summarize_ascii_stl_asset(
    file_name: &str,
    bytes: &[u8],
) -> Result<ImportedAssetSummary, ApiError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|error| ApiError::bad_request(format!("invalid ASCII STL payload: {}", error)))?;
    let mut points = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("vertex ") {
            continue;
        }
        let values = trimmed
            .split_whitespace()
            .skip(1)
            .filter_map(|value| value.parse::<f64>().ok())
            .collect::<Vec<_>>();
        if values.len() == 3 {
            points.push([values[0], values[1], values[2]]);
        }
    }

    Ok(ImportedAssetSummary {
        file_name: file_name.to_string(),
        file_bytes: bytes.len(),
        kind: "stl_surface".to_string(),
        bounds: bounds_from_points(&points),
        triangle_count: Some(points.len() / 3),
        node_count: None,
        element_count: None,
        boundary_face_count: None,
        note: None,
    })
}

pub(crate) fn parse_point3_value(value: &Value) -> Option<[f64; 3]> {
    let array = value.as_array()?;
    if array.len() < 3 {
        return None;
    }
    Some([array[0].as_f64()?, array[1].as_f64()?, array[2].as_f64()?])
}

pub(crate) fn bounds_from_points(points: &[[f64; 3]]) -> Option<BoundsSummary> {
    let first = *points.first()?;
    let mut min = first;
    let mut max = first;
    for [x, y, z] in points.iter().copied() {
        if x < min[0] {
            min[0] = x;
        }
        if y < min[1] {
            min[1] = y;
        }
        if z < min[2] {
            min[2] = z;
        }
        if x > max[0] {
            max[0] = x;
        }
        if y > max[1] {
            max[1] = y;
        }
        if z > max[2] {
            max[2] = z;
        }
    }
    Some(BoundsSummary {
        min,
        max,
        size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    })
}
