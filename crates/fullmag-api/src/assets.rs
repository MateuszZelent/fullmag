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
    let surface = fullmag_authoring::parse_stl_surface(bytes)
        .map_err(ApiError::bad_request)?;
    Ok(ImportedAssetSummary {
        file_name: file_name.to_string(),
        file_bytes: bytes.len(),
        kind: "stl_surface".to_string(),
        bounds: bounds_from_points(&surface.positions),
        triangle_count: Some(surface.triangle_indices.len()),
        node_count: Some(surface.positions.len()),
        element_count: None,
        boundary_face_count: None,
        note: Some("Source triangle surface; volume meshing validates closed shells separately.".to_string()),
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

#[cfg(test)]
mod stl_import_tests {
    use super::*;

    #[test]
    fn stl_summary_uses_the_same_validated_surface_as_preview() {
        let source = b"solid face\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 2 0 0\nvertex 0 3 0\nendloop\nendfacet\nendsolid face\n";
        let summary = summarize_uploaded_asset("face.STL", source).unwrap();
        assert_eq!(summary.kind, "stl_surface");
        assert_eq!(summary.triangle_count, Some(1));
        assert_eq!(summary.node_count, Some(3));
        assert!(summary.element_count.is_none());
        assert_eq!(summary.bounds.unwrap().max, [2.0, 3.0, 0.0]);
    }

    #[test]
    fn malformed_stl_never_becomes_a_successful_empty_summary() {
        for source in [b"arbitrary text".as_slice(), b"solid empty\nendsolid empty\n".as_slice()] {
            assert!(summarize_uploaded_asset("bad.stl", source).is_err());
        }
    }
}
