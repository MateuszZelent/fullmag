//! Generate a deterministic, synthetic FEM playback folder.
//!
//! The fixture exercises the persisted saved-FEM geometry contract and the
//! component-major native Zarr frame layout without running a solver. It is
//! intentionally marked as synthetic data and refuses to write into an
//! existing directory.

use fullmag_ir::{
    FemCellMeshPartIR, FemCellTypeIR, FemConnectivityIR, FemFacetConnectivityIR,
    FemFacetRoleIR, FemFacetTypeIR, MeshIR,
};
use fullmag_quantities::fem_state_field::FemP1MagnetizationFieldSemantics;
use fullmag_session::solution_field_geometry::{
    parse_saved_fem_p1_geometry, SavedFemP1FieldGeometry, SavedFieldGeometryRef,
    SavedFieldRepresentationEvidence, FEM_P1_GEOMETRY_SCHEMA,
};
use serde_json::{json, Value};
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

const PLAYBACK_SCHEMA: &str = "fullmag.saved_playback.v1";
const NODE_COUNT: usize = 5;
const FRAME_TIMES_S: [f64; 5] = [0.0, 1.0e-9, 2.0e-9, 3.0e-9, 4.0e-9];
const ACTIVE_NODE_MASK: [bool; NODE_COUNT] = [true, true, true, true, false];

fn main() {
    if let Err(error) = run() {
        eprintln!("fem_playback_fixture: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let mut arguments = std::env::args_os();
    let _program = arguments.next();
    let output = arguments
        .next()
        .map(PathBuf::from)
        .ok_or("usage: fem_playback_fixture <new-output-directory>")?;
    if arguments.next().is_some() {
        return Err("usage: fem_playback_fixture <new-output-directory>".into());
    }

    let geometry = build_geometry()?;
    let geometry_bytes = serde_json::to_vec_pretty(&geometry)?;
    let geometry_sha256 = fullmag_session::hex_sha256(&geometry_bytes);
    let geometry_reference = SavedFieldGeometryRef {
        schema_id: FEM_P1_GEOMETRY_SCHEMA.to_string(),
        object_ref: geometry_sha256.clone(),
        byte_length: geometry_bytes.len() as u64,
    };
    // Validate the exact bytes that will be written, including canonical
    // MeshIR serialization and the producer-owned field semantics envelope.
    parse_saved_fem_p1_geometry(&geometry_bytes, &geometry_reference)?;

    let frames = (0..FRAME_TIMES_S.len())
        .map(frame_bytes)
        .collect::<Vec<_>>();
    let expected_frame_bytes = NODE_COUNT * 3 * std::mem::size_of::<f64>();
    if frames.iter().any(|frame| frame.len() != expected_frame_bytes) {
        return Err("synthetic FEM frame length does not equal 3*N f64 values".into());
    }

    let playback = json!({
        "schema": PLAYBACK_SCHEMA,
        "complete": true,
        "name": "FEM playback fixture (synthetic)",
        "source_note": "Deterministic synthetic FEM playback data; not a solver result.",
        "fem_mesh": {
            "geometry_path": "geometry.json",
            "geometry_sha256": geometry_sha256,
        },
        "stages": [{
            "stage_id": "propagate",
            "array_path": "fixture.zarr/stages/stage_0000_propagate/fields/m",
            "times_s": FRAME_TIMES_S,
            "quantity_ids": ["m"],
            "field_layout": "soa_component_major",
        }],
    });
    let zarray = json!({
        "zarr_format": 2,
        "shape": [FRAME_TIMES_S.len(), 3, NODE_COUNT],
        "chunks": [1, 3, NODE_COUNT],
        "dtype": "<f8",
        "compressor": null,
        "fill_value": 0.0,
        "order": "C",
        "filters": null,
        "dimension_separator": ".",
    });
    let zattrs = json!({
        "observable": "m",
        "axes": ["sample", "component", "node"],
        "component_count": 3,
        "component_order": ["x", "y", "z"],
        "storage_layout": "soa_component_major",
        "location": "node",
        "scope": "full",
        "source_note": "Deterministic synthetic FEM playback data; not a solver result.",
    });

    ensure_new_output_directory(&output)?;
    fs::write(output.join("geometry.json"), geometry_bytes)?;
    write_json(&output.join("playback.json"), &playback)?;

    let array = output.join("fixture.zarr/stages/stage_0000_propagate/fields/m");
    fs::create_dir_all(&array)?;
    write_json(&array.join(".zarray"), &zarray)?;
    write_json(&array.join(".zattrs"), &zattrs)?;
    for (frame_index, bytes) in frames.iter().enumerate() {
        fs::write(array.join(format!("{frame_index}.0.0")), bytes)?;
    }

    println!("{}", output.display());
    Ok(())
}

fn ensure_new_output_directory(output: &Path) -> Result<(), Box<dyn Error>> {
    if output.exists() {
        return Err(format!("refusing to overwrite existing path '{}'", output.display()).into());
    }
    if let Some(parent) = output.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        fs::create_dir_all(parent)?;
    }
    fs::create_dir(output)?;
    Ok(())
}

fn write_json(path: &Path, value: &Value) -> Result<(), Box<dyn Error>> {
    fs::write(path, serde_json::to_vec_pretty(value)?)?;
    Ok(())
}

fn build_geometry() -> Result<SavedFemP1FieldGeometry, Box<dyn Error>> {
    let mesh = MeshIR {
        mesh_name: "synthetic-two-tet-fem-playback".into(),
        nodes: vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, -1.0],
        ],
        cells: FemConnectivityIR {
            types: vec![FemCellTypeIR::Tet4, FemCellTypeIR::Tet4],
            offsets: vec![0, 4, 8],
            nodes: vec![0, 1, 2, 3, 0, 2, 1, 4],
            global_ordinals: vec![0, 1],
            mesh_parts: vec![FemCellMeshPartIR::Magnetic, FemCellMeshPartIR::FarAir],
        },
        element_markers: vec![1, 0],
        facets: FemFacetConnectivityIR {
            types: vec![FemFacetTypeIR::Tri3; 7],
            roles: vec![
                FemFacetRoleIR::MaterialInterface,
                FemFacetRoleIR::Exterior,
                FemFacetRoleIR::Exterior,
                FemFacetRoleIR::Exterior,
                FemFacetRoleIR::Exterior,
                FemFacetRoleIR::Exterior,
                FemFacetRoleIR::Exterior,
            ],
            offsets: vec![0, 3, 6, 9, 12, 15, 18, 21],
            nodes: vec![
                0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3, 0, 2, 4, 0, 1, 4, 1, 2, 4,
            ],
            global_ordinals: vec![0, 1, 2, 3, 4, 5, 6],
        },
        boundary_markers: vec![2, 1, 1, 1, 1, 1, 1],
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: std::collections::HashMap::new(),
    };
    let topology_fingerprint = mesh.topology_fingerprint_v6();
    let field_semantics = FemP1MagnetizationFieldSemantics::new(
        &topology_fingerprint,
        mesh.nodes.len(),
        ACTIVE_NODE_MASK.to_vec(),
    )?;
    let geometry = SavedFemP1FieldGeometry {
        schema_version: FEM_P1_GEOMETRY_SCHEMA.into(),
        coordinate_unit: "m".into(),
        representation_evidence: SavedFieldRepresentationEvidence::NotVerified,
        mesh,
        field_semantics,
    };
    geometry.validate()?;
    Ok(geometry)
}

fn frame_bytes(frame: usize) -> Vec<u8> {
    let mut values = Vec::with_capacity(NODE_COUNT * 3);
    for component in 0..3 {
        for node in 0..NODE_COUNT {
            let value = if !ACTIVE_NODE_MASK[node] {
                match component {
                    0 => 1.0e6 + frame as f64,
                    1 => -2.0e6 - frame as f64,
                    _ => 3.0e6 + (frame * 10) as f64,
                }
            } else {
                let node_scale = node as f64 + 1.0;
                let time_scale = frame as f64 + 1.0;
                match component {
                    0 => 0.1 * node_scale * time_scale,
                    1 => {
                        if (frame + node) % 2 == 0 {
                            0.2 * node_scale
                        } else {
                            -0.2 * node_scale
                        }
                    }
                    _ => {
                        let sign = if (frame / 2 + node) % 2 == 0 { 1.0 } else { -1.0 };
                        sign * (0.35 + 0.1 * frame as f64) * node_scale
                    }
                }
            };
            values.push(value);
        }
    }

    let mut bytes = Vec::with_capacity(values.len() * std::mem::size_of::<f64>());
    for value in values {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes
}
