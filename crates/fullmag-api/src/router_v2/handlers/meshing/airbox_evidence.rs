//! Read-only Airbox evidence. Missing quality never implies acceptance.

use fullmag_runner::FemMeshPayload;
use serde_json::{json, Value};

/// Count shared air/material vertices from canonical connectivity, not diagnostic
/// segment ranges (which exclude shared vertices on some imported meshes).
pub(super) fn shared_interface_node_count(mesh: &FemMeshPayload) -> Option<usize> {
    if mesh.element_markers.len() != mesh.cell_count() {
        return None;
    }
    let mut ownership = vec![0u8; mesh.nodes.len()];
    for (ordinal, marker) in mesh.element_markers.iter().enumerate() {
        let nodes = mesh.cells.item_nodes(ordinal)?;
        if nodes.len() != mesh.cells.types.get(ordinal)?.arity() {
            return None;
        }
        let owner = if *marker == 0 { 1 } else { 2 };
        for node in nodes {
            *ownership.get_mut(*node as usize)? |= owner;
        }
    }
    Some(ownership.iter().filter(|owner| **owner == 3).count())
}

fn finite(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
}

pub(super) fn airbox_gamma_supported(mesh: &FemMeshPayload) -> bool {
    mesh.element_markers.len() == mesh.cells.types.len()
        && mesh
            .element_markers
            .iter()
            .zip(&mesh.cells.types)
            .all(|(marker, kind)| {
                *marker != 0
                    || matches!(
                        kind,
                        fullmag_ir::FemCellTypeIR::Tet4 | fullmag_ir::FemCellTypeIR::Prism6
                    )
            })
}

/// Existing production acceptance thresholds from physics note 0105. This is
/// an Airbox Gmsh-quality gate, not full solver/scientific qualification.
pub(super) fn airbox_quality_gates(quality: &Value, mesh: Option<&FemMeshPayload>) -> Value {
    let global = quality.get("global");
    let source = quality.get("quality_source").and_then(Value::as_str);
    let element_count = global
        .and_then(|scope| scope.get("element_count"))
        .and_then(Value::as_u64);
    let scope_matches = global
        .and_then(|scope| scope.get("marker"))
        .and_then(Value::as_u64)
        == Some(0);
    let mesh_count = mesh
        .filter(|mesh| mesh.element_markers.len() == mesh.cell_count())
        .map(|mesh| {
            mesh.element_markers
                .iter()
                .filter(|marker| **marker == 0)
                .count() as u64
        });
    let metric = |name: &str, field: &str| {
        finite(
            global
                .and_then(|scope| scope.get(name))
                .and_then(|metric| metric.get(field)),
        )
    };
    let sicn_min = metric("sicn", "min");
    let sicn_p05 = metric("sicn", "p05");
    // Gmsh gamma is undefined for pyramids and hexahedra. Older publications
    // can contain numeric placeholders for those families; never qualify them.
    let gamma_supported = mesh.is_some_and(airbox_gamma_supported);
    let gamma_min = gamma_supported.then(|| metric("gamma", "min")).flatten();
    let provenance_matches = matches!(source, Some("gmsh" | "per_domain_quality"));
    let coverage_matches = scope_matches
        && element_count.is_some_and(|count| count > 0)
        && mesh_count.is_some()
        && mesh_count == element_count;
    let checks = [
        ("gmsh.min_sicn.positive", sicn_min, 0.0, true),
        ("gmsh.min_sicn.p05", sicn_p05, 0.1, false),
        ("gmsh.gamma.minimum", gamma_min, 0.08, false),
    ]
    .map(|(id, value, threshold, strict)| {
        let status = if !provenance_matches || !coverage_matches {
            "unknown"
        } else {
            match value {
                Some(value)
                    if if strict {
                        value > threshold
                    } else {
                        value >= threshold
                    } =>
                {
                    "pass"
                }
                Some(_) => "fail",
                None => "unknown",
            }
        };
        json!({"id": id, "status": status, "value": value, "threshold": threshold,
            "comparison": if strict { ">" } else { ">=" }, "unit": "1"})
    });
    let status = if checks.iter().any(|check| check["status"] == "fail") {
        "fail"
    } else if checks.iter().all(|check| check["status"] == "pass") {
        "pass"
    } else {
        "unknown"
    };
    let reason = if !coverage_matches {
        "Airbox quality coverage is unavailable or does not match the published mesh."
    } else if !provenance_matches {
        "Gmsh Airbox quality metrics are not published; topology statistics are not a quality pass."
    } else if status == "unknown" && !gamma_supported {
        "Gmsh gamma is undefined for Airbox pyramid/hexahedron cells; the combined gate remains unqualified."
    } else if status == "unknown" {
        "Airbox quality metrics are incomplete; missing metrics remain unqualified."
    } else if status == "fail" {
        "Airbox quality fails at least one published Gmsh acceptance threshold."
    } else {
        "Airbox satisfies the published Gmsh thresholds; this is not full scientific qualification."
    };
    json!({"status": status, "reason": reason, "scope": "airbox", "marker": 0,
        "source": source, "element_count": element_count, "checks": checks})
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mesh() -> FemMeshPayload {
        FemMeshPayload {
            mesh_name: "airbox-evidence".into(),
            mesh_id: "airbox-evidence:1".into(),
            nodes: vec![[0.0; 3]; 5],
            cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [1, 2, 3, 4]]),
            element_markers: vec![0, 1],
            facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![]),
            boundary_markers: vec![],
            periodic_boundary_pairs: vec![],
            periodic_node_pairs: vec![],
            object_segments: vec![],
            mesh_parts: vec![],
            domain_mesh_mode: None,
            domain_frame: None,
            generation_id: None,
            per_domain_quality: Default::default(),
            build_report: None,
        }
    }

    #[test]
    fn interface_nodes_use_connectivity_and_reject_missing_coverage() {
        let mut mesh = mesh();
        assert_eq!(shared_interface_node_count(&mesh), Some(3));
        mesh.element_markers.pop();
        assert_eq!(shared_interface_node_count(&mesh), None);
    }

    #[test]
    fn scoped_quality_requires_provenance_complete_metrics_and_matching_count() {
        let mesh = mesh();
        let mut quality = json!({"quality_source": "gmsh", "global": {"marker": 0,
            "element_count": 1, "sicn": {"min": 0.8, "p05": 0.8}, "gamma": {"min": 0.8}}});
        assert_eq!(
            airbox_quality_gates(&quality, Some(&mesh))["status"],
            "pass"
        );
        quality["global"]["gamma"] = Value::Null;
        assert_eq!(
            airbox_quality_gates(&quality, Some(&mesh))["status"],
            "unknown"
        );
        quality["global"]["sicn"]["min"] = json!(-0.1);
        assert_eq!(
            airbox_quality_gates(&quality, Some(&mesh))["status"],
            "fail"
        );
        quality["global"]["element_count"] = json!(2);
        assert_eq!(
            airbox_quality_gates(&quality, Some(&mesh))["status"],
            "unknown"
        );
        quality["global"]["element_count"] = json!(1);
        quality["quality_source"] = json!("topology-proxy");
        assert_eq!(
            airbox_quality_gates(&quality, Some(&mesh))["status"],
            "unknown"
        );
    }

    #[test]
    fn missing_or_unmatched_quality_never_passes() {
        assert_eq!(airbox_quality_gates(&json!({}), None)["status"], "unknown");
        let quality = json!({"quality_source": "gmsh", "global": {"marker": 0,
            "element_count": 1, "sicn": {"min": 0.8, "p05": 0.8}, "gamma": {"min": 0.8}}});
        assert_eq!(airbox_quality_gates(&quality, None)["status"], "unknown");
    }

    #[test]
    fn legacy_gamma_cannot_qualify_pyramids() {
        let mut mesh = mesh();
        mesh.cells.types[0] = fullmag_ir::FemCellTypeIR::Pyramid5;
        mesh.cells.nodes.insert(4, 4);
        mesh.cells.offsets = vec![0, 5, 9];
        let quality = json!({"quality_source": "per_domain_quality", "global": {
            "marker": 0, "element_count": 1,
            "sicn": {"min": 0.8, "p05": 0.8}, "gamma": {"min": 1.0}}});
        let gates = airbox_quality_gates(&quality, Some(&mesh));
        assert_eq!(gates["checks"][0]["status"], "pass");
        assert_eq!(gates["checks"][2]["status"], "unknown");
        assert_eq!(gates["checks"][2]["value"], Value::Null);
        assert_eq!(gates["status"], "unknown");
    }
}
