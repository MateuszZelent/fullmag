//! Produce the materialized input for the Frozen Spins cross-discretization
//! qualification gate.
//!
//! This is intentionally an executable example rather than a Python-only
//! fixture.  Every row below goes through the same public planner selection
//! compiler used by FDM/FEM lowering (`compile_fdm_frozen_spins` or
//! `compile_fem_frozen_spins`).  The only adapter-owned value is the physical
//! control-volume measure attached to the materialized domain; a resolved mask
//! identity is kept row-local and is never compared between discretizations.

use fullmag_ir::{
    BoundaryMembershipIR, ConstraintActivationIR, EmptySelectionPolicyIR, FrozenReferencePolicyIR,
    FrozenSpinsIR, GeometryPredicateIR, InactiveSelectionPolicyIR, SelectionDefinitionIR,
    SelectionExprIR, SelectionFrameIR, SelectionMembershipPolicyIR, SelectionSamplingIR,
    SelectionValidationContext, FROZEN_SPINS_SCHEMA_VERSION,
};
use fullmag_plan::{
    compile_fdm_frozen_spins, compile_fem_frozen_spins, AffineTransform3, FdmFrozenSpinsDomain,
    FemIncidentElement, FemTrueDofDomain, FrozenSpinsCompileRequest, ResolvedFrozenSpinsReference,
    SelectionDofMembership,
};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::env;
use std::error::Error;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

const MATERIALIZATION_SCHEMA: &str = "fullmag.frozen_spins.cross_discretization.materialization.v1";
const CONSTRAINT_ID: &str = "cross_discretization_slab";
const CONSTRAINT_NAME: &str = "Cross-discretization slab";
const SEMANTICS_VERSION: &str = "frozen_spins.cross_discretization.selector_semantics.v1";
const SEMANTICS_HASH_ENCODING: &str = "fullmag.frozen_spins.semantics.f64_bits.v1";
const TOPOLOGY_FINGERPRINT_SCHEMA: &str = "fullmag.frozen_spins.cross_discretization.topology.v2";
const SOURCE_STATE_REVISION: u64 = 1;
const DOMAIN_LENGTH_M: f64 = 1.0e-9;
const SELECTOR_LOWER_X_M: f64 = 0.2e-9;
const SELECTOR_UPPER_X_M: f64 = 0.6e-9;
const SELECTOR_WIDTH_M: f64 = SELECTOR_UPPER_X_M - SELECTOR_LOWER_X_M;
const REFINEMENTS: [(&str, u32); 3] = [("coarse", 8), ("medium", 13), ("fine", 23)];

#[derive(Debug, Clone, Serialize)]
struct SelectorMetadata {
    authored_fingerprint: String,
    semantics_fingerprint: String,
    semantics_version: &'static str,
    root_constraint_id: &'static str,
    canonical_expression: Value,
    semantics_payload: Value,
}

#[derive(Debug, Clone, Serialize)]
struct Row {
    backend: &'static str,
    refinement: &'static str,
    refinement_level: u32,
    evaluator_id: String,
    authored_selector_fingerprint: String,
    semantics_selector_fingerprint: String,
    topology_fingerprint: String,
    resolution: [u32; 3],
    materialized_dof_count: u64,
    active_dof_count: u64,
    frozen_dof_count: u64,
    free_dof_count: u64,
    selected_measure_m3: f64,
    selected_measure_error_abs_m3: f64,
    selected_measure_relative_error: f64,
    domain_measure_m3: f64,
    dof_measure_definition: &'static str,
    selected_measure_weight_count: u64,
    mesh_element_count: Option<u64>,
    resolved_plan: Value,
    materialization: Value,
}

struct FemMeshMaterialization {
    points: Vec<[f64; 3]>,
    incident_elements: Vec<Vec<FemIncidentElement>>,
    nodal_control_volume_weights_m3: Vec<f64>,
    total_measure_m3: f64,
    element_count: u64,
    points_fingerprint: String,
    connectivity_fingerprint: String,
}

fn selector_expression() -> SelectionExprIR {
    SelectionExprIR::InsideGeometry {
        geometry: GeometryPredicateIR::Box {
            center_m: [0.4e-9, 0.5e-9, 0.5e-9],
            size_m: [SELECTOR_WIDTH_M, DOMAIN_LENGTH_M, DOMAIN_LENGTH_M],
        },
        frame: SelectionFrameIR::World {},
        sampling: SelectionSamplingIR::DofPoint {},
        boundary: BoundaryMembershipIR::Inclusive {
            absolute_tolerance_m: 0.0,
            relative_tolerance: 1.0e-12,
        },
    }
}

fn constraint() -> FrozenSpinsIR {
    FrozenSpinsIR {
        schema_version: FROZEN_SPINS_SCHEMA_VERSION.to_string(),
        id: CONSTRAINT_ID.to_string(),
        name: CONSTRAINT_NAME.to_string(),
        enabled: true,
        selector: selector_expression(),
        reference: FrozenReferencePolicyIR::CaptureCurrentAtActivation {},
        membership: SelectionMembershipPolicyIR::Static {},
        activation: ConstraintActivationIR::AllStages {},
        empty_selection: EmptySelectionPolicyIR::Error,
        inactive_selection: InactiveSelectionPolicyIR::Error,
    }
}

fn topology_fingerprint(
    backend: &str,
    n: u32,
    materialized_grid_fingerprint: Option<&str>,
    materialized_points_fingerprint: Option<&str>,
    materialized_connectivity_fingerprint: Option<&str>,
) -> String {
    // Keep the planner-visible topology identity coupled to what this
    // executable actually materialized.  In particular, n/backend alone is
    // insufficient: a different FEM connectivity at the same resolution
    // must produce a different source identity.
    let canonical_grid = materialized_grid_fingerprint
        .map(|fingerprint| fingerprint.strip_prefix("sha256:").unwrap_or(fingerprint));
    let canonical_points = materialized_points_fingerprint
        .map(|fingerprint| fingerprint.strip_prefix("sha256:").unwrap_or(fingerprint));
    let canonical_connectivity = materialized_connectivity_fingerprint
        .map(|fingerprint| fingerprint.strip_prefix("sha256:").unwrap_or(fingerprint));
    let payload = json!({
        "backend": backend,
        "domain_length_f64_bits": format!("{:016x}", DOMAIN_LENGTH_M.to_bits()),
        "materialized_connectivity_fingerprint": canonical_connectivity,
        "materialized_grid_fingerprint": canonical_grid,
        "materialized_points_fingerprint": canonical_points,
        "n": n,
        "schema_version": TOPOLOGY_FINGERPRINT_SCHEMA,
    });
    let bytes = serde_json::to_vec(&payload).expect("topology fingerprint payload is serializable");
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn canonicalize_semantics_numbers(value: &mut Value) {
    match value {
        Value::Number(number) => {
            let float = number
                .as_f64()
                .expect("serde_json numbers in the semantics payload fit f64");
            *value = json!({
                "$fullmag_f64_bits": format!("{:016x}", float.to_bits()),
            });
        }
        Value::Array(values) => {
            for value in values {
                canonicalize_semantics_numbers(value);
            }
        }
        Value::Object(values) => {
            for value in values.values_mut() {
                canonicalize_semantics_numbers(value);
            }
        }
        Value::Null | Value::Bool(_) | Value::String(_) => {}
    }
}

fn semantics_payload(constraint: &FrozenSpinsIR) -> Result<Value, Box<dyn Error>> {
    let mut payload = json!({
        "constraint": serde_json::to_value(constraint)?,
        "hash_encoding": SEMANTICS_HASH_ENCODING,
        "analytic_measure": {
            "domain_length_m": DOMAIN_LENGTH_M,
            "geometry": "box",
            "bounds_m": [[SELECTOR_LOWER_X_M, 0.0, 0.0], [SELECTOR_UPPER_X_M, DOMAIN_LENGTH_M, DOMAIN_LENGTH_M]],
            "formula": "(x_upper-x_lower)*(y_upper-y_lower)*(z_upper-z_lower)",
            "value_m3": SELECTOR_WIDTH_M * DOMAIN_LENGTH_M * DOMAIN_LENGTH_M,
        },
        "physical_measure_contract": {
            "unit": "m^3",
            "method": "sum_selected_dof_control_volumes",
            "cross_lane_resolved_mask_sha256_comparison": "NOT_PERFORMED",
        },
        "semantics_version": SEMANTICS_VERSION,
    });
    // Rust serde_json and Python do not promise identical textual rendering
    // for decimal/exponent f64 values.  Hashing their exact IEEE-754 bits in
    // a canonical JSON object makes this payload independently reproducible.
    canonicalize_semantics_numbers(&mut payload);
    Ok(payload)
}

fn semantics_fingerprint(payload: &Value) -> Result<String, Box<dyn Error>> {
    let bytes = serde_json::to_vec(payload)?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}

fn shared_request<'a>(
    constraints: &'a [FrozenSpinsIR],
    selections: &'a [SelectionDefinitionIR],
    transforms: &'a BTreeMap<String, AffineTransform3>,
    known_entities: &'a SelectionValidationContext,
    resolved_references: &'a [ResolvedFrozenSpinsReference<'a>],
    expected_topology: &'a str,
) -> FrozenSpinsCompileRequest<'a> {
    FrozenSpinsCompileRequest {
        constraints,
        selections,
        activation_stage_id: None,
        object_transforms: transforms,
        known_entities,
        state_snapshot: None,
        resolved_references,
        expected_source_state_revision: Some(SOURCE_STATE_REVISION),
        expected_grid_or_mesh_fingerprint: expected_topology,
    }
}

fn resolved_plan_summary(plan: &fullmag_ir::ResolvedFrozenSpinsPlanIR) -> Value {
    json!({
        "schema_version": plan.schema_version,
        "constraint_ids": plan.constraint_ids,
        "active_dof_count": plan.active_dof_count,
        "frozen_dof_count": plan.frozen_dof_count,
        "free_dof_count": plan.free_dof_count,
        "all_active_dofs_frozen": plan.all_active_dofs_frozen,
        "grid_or_mesh_fingerprint": plan.grid_or_mesh_fingerprint,
        "source_state_revision": plan.source_state_revision,
        // This identity is intentionally row-local.  The evidence builder
        // must never compare it between FDM and FEM.
        "resolved_mask_sha256": plan.mask_sha256,
        "certificate": plan.certificate,
    })
}

fn selector_metadata(
    plan: &fullmag_ir::ResolvedFrozenSpinsPlanIR,
    constraint: &FrozenSpinsIR,
) -> Result<SelectorMetadata, Box<dyn Error>> {
    let authored = plan
        .certificate
        .authored_fingerprints
        .first()
        .ok_or("production compiler returned no authored selector fingerprint")?
        .selector_sha256
        .clone();
    let semantics_payload = semantics_payload(constraint)?;
    Ok(SelectorMetadata {
        authored_fingerprint: format!("sha256:{authored}"),
        semantics_fingerprint: semantics_fingerprint(&semantics_payload)?,
        semantics_version: SEMANTICS_VERSION,
        root_constraint_id: CONSTRAINT_ID,
        canonical_expression: serde_json::to_value(selector_expression())?,
        semantics_payload,
    })
}

fn fdm_grid_materialization_fingerprint(n: u32, cell_m: f64) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"fullmag.frozen_spins.cross_discretization.fdm_grid.v1");
    hasher.update(n.to_le_bytes());
    hasher.update(DOMAIN_LENGTH_M.to_bits().to_le_bytes());
    for k in 0..n {
        for j in 0..n {
            for i in 0..n {
                // These are the actual cell-center coordinates used by the
                // FDM selector evaluator's materialized grid convention.
                for index in [i, j, k] {
                    let coordinate = (f64::from(index) + 0.5) * cell_m;
                    hasher.update(coordinate.to_bits().to_le_bytes());
                }
            }
        }
    }
    format!("sha256:{:x}", hasher.finalize())
}

fn fdm_memberships(count: usize) -> Vec<SelectionDofMembership> {
    (0..count)
        .map(|_| SelectionDofMembership {
            object_ids: vec!["film".to_string()],
            region_ids: vec![("film".to_string(), "core".to_string())],
        })
        .collect()
}

fn fdm_row(
    refinement: &'static str,
    level: u32,
    n: u32,
) -> Result<(Row, SelectorMetadata), Box<dyn Error>> {
    let side = usize::try_from(n)?;
    let dof_count = side
        .checked_mul(side)
        .and_then(|value| value.checked_mul(side))
        .ok_or("FDM refinement DOF count overflow")?;
    let cell = DOMAIN_LENGTH_M / f64::from(n);
    let grid_materialization_fingerprint = fdm_grid_materialization_fingerprint(n, cell);
    let topology = topology_fingerprint(
        "fdm",
        n,
        Some(&grid_materialization_fingerprint),
        None,
        None,
    );
    let active_mask = vec![true; dof_count];
    let memberships = fdm_memberships(dof_count);
    let references = vec![[1.0_f64, 0.0, 0.0]; dof_count];
    let constraints = vec![constraint()];
    let selections: Vec<SelectionDefinitionIR> = Vec::new();
    let transforms = BTreeMap::new();
    let known_entities = SelectionValidationContext::new(["film"], [("film", "core")]);
    let resolved_references = vec![ResolvedFrozenSpinsReference {
        constraint_id: CONSTRAINT_ID,
        values: &references,
        source_state_revision: Some(SOURCE_STATE_REVISION),
        topology_fingerprint: &topology,
    }];
    let request = shared_request(
        &constraints,
        &selections,
        &transforms,
        &known_entities,
        &resolved_references,
        &topology,
    );
    let domain = FdmFrozenSpinsDomain {
        origin_m: [0.0; 3],
        counts: [n; 3],
        cell_m: [cell; 3],
        active_mask: &active_mask,
        memberships: &memberships,
        grid_fingerprint: &topology,
    };
    let plan = compile_fdm_frozen_spins(&domain, &request)?;
    let selector = selector_metadata(&plan, &constraints[0])?;
    if plan.frozen_mask.len() != dof_count {
        return Err("FDM production plan mask length differs from materialized grid".into());
    }
    let selected_weight_count = plan
        .frozen_mask
        .iter()
        .filter(|selected| **selected)
        .count();
    if selected_weight_count as u64 != plan.frozen_dof_count {
        return Err("FDM selected cell weights are not tied to the production plan mask".into());
    }
    let selected_measure = plan
        .frozen_mask
        .iter()
        .map(|selected| if *selected { cell.powi(3) } else { 0.0 })
        .sum::<f64>();
    let analytic = SELECTOR_WIDTH_M * DOMAIN_LENGTH_M * DOMAIN_LENGTH_M;
    Ok((
        Row {
            backend: "fdm",
            refinement,
            refinement_level: level,
            evaluator_id: plan.certificate.evaluator_id.clone(),
            authored_selector_fingerprint: selector.authored_fingerprint.clone(),
            semantics_selector_fingerprint: selector.semantics_fingerprint.clone(),
            topology_fingerprint: topology,
            resolution: [n; 3],
            materialized_dof_count: dof_count as u64,
            active_dof_count: plan.active_dof_count,
            frozen_dof_count: plan.frozen_dof_count,
            free_dof_count: plan.free_dof_count,
            selected_measure_m3: selected_measure,
            selected_measure_error_abs_m3: (selected_measure - analytic).abs(),
            selected_measure_relative_error: ((selected_measure - analytic) / analytic).abs(),
            domain_measure_m3: DOMAIN_LENGTH_M.powi(3),
            dof_measure_definition: "fdm_cell_volume_sum",
            selected_measure_weight_count: selected_weight_count as u64,
            mesh_element_count: None,
            resolved_plan: resolved_plan_summary(&plan),
            materialization: json!({
                "source_kind": "rust_production_planner_evaluator",
                "crate": "fullmag-plan",
                "function": "compile_fdm_frozen_spins",
                "evaluator_id": plan.certificate.evaluator_id,
                "domain_materialized": true,
                "measure_weights_materialized": true,
                "domain_length_m": DOMAIN_LENGTH_M,
                "counts": [n, n, n],
                "cell_m": [cell, cell, cell],
                "grid_point_count": dof_count,
                "grid_materialization_fingerprint": grid_materialization_fingerprint,
                "weight_unit_m3": cell.powi(3),
            }),
        },
        selector,
    ))
}

fn node_index(i: u32, j: u32, k: u32, n: u32) -> usize {
    let side = (n + 1) as usize;
    (k as usize * side + j as usize) * side + i as usize
}

fn tetra_volume_m3(points: &[[f64; 3]], tetra: [usize; 4]) -> f64 {
    let origin = points[tetra[0]];
    let a: [f64; 3] = std::array::from_fn(|axis| points[tetra[1]][axis] - origin[axis]);
    let b: [f64; 3] = std::array::from_fn(|axis| points[tetra[2]][axis] - origin[axis]);
    let c: [f64; 3] = std::array::from_fn(|axis| points[tetra[3]][axis] - origin[axis]);
    let cross = [
        b[1] * c[2] - b[2] * c[1],
        b[2] * c[0] - b[0] * c[2],
        b[0] * c[1] - b[1] * c[0],
    ];
    (a[0] * cross[0] + a[1] * cross[1] + a[2] * cross[2]).abs() / 6.0
}

fn points_fingerprint(points: &[[f64; 3]]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"fullmag.frozen_spins.cross_discretization.fem_points.v1");
    hasher.update((points.len() as u64).to_le_bytes());
    for point in points {
        for coordinate in point {
            hasher.update(coordinate.to_bits().to_le_bytes());
        }
    }
    format!("sha256:{:x}", hasher.finalize())
}

fn fem_mesh_materialization(n: u32) -> Result<FemMeshMaterialization, Box<dyn Error>> {
    let side = usize::try_from(n + 1).expect("refinement side fits usize");
    let mut points = Vec::with_capacity(side * side * side);
    let mut incidence = Vec::with_capacity(side * side * side);
    for k in 0..=n {
        for j in 0..=n {
            for i in 0..=n {
                points.push([
                    f64::from(i) * DOMAIN_LENGTH_M / f64::from(n),
                    f64::from(j) * DOMAIN_LENGTH_M / f64::from(n),
                    f64::from(k) * DOMAIN_LENGTH_M / f64::from(n),
                ]);
                incidence.push(Vec::new());
            }
        }
    }

    let mut nodal_weights = vec![0.0; points.len()];
    let mut connectivity_hash = Sha256::new();
    connectivity_hash.update(b"fullmag.frozen_spins.cross_discretization.fem_tet4_connectivity.v1");
    connectivity_hash.update((points.len() as u64).to_le_bytes());
    let mut element_count = 0_u64;
    for k in 0..n {
        for j in 0..n {
            for i in 0..n {
                let v000 = node_index(i, j, k, n);
                let v100 = node_index(i + 1, j, k, n);
                let v010 = node_index(i, j + 1, k, n);
                let v110 = node_index(i + 1, j + 1, k, n);
                let v001 = node_index(i, j, k + 1, n);
                let v101 = node_index(i + 1, j, k + 1, n);
                let v011 = node_index(i, j + 1, k + 1, n);
                let v111 = node_index(i + 1, j + 1, k + 1, n);
                // Body-diagonal cube -> six positively oriented tet4 cells.
                let tetrahedra = [
                    [v000, v100, v110, v111],
                    [v000, v110, v010, v111],
                    [v000, v010, v011, v111],
                    [v000, v011, v001, v111],
                    [v000, v001, v101, v111],
                    [v000, v101, v100, v111],
                ];
                for tetra in tetrahedra {
                    let volume = tetra_volume_m3(&points, tetra);
                    if !volume.is_finite() || volume <= 0.0 {
                        return Err(
                            "structured FEM materialization produced a non-positive tet4 volume"
                                .into(),
                        );
                    }
                    connectivity_hash.update((element_count).to_le_bytes());
                    for node in tetra {
                        nodal_weights[node] += volume / 4.0;
                        incidence[node].push(FemIncidentElement::magnetic("film", &["core"]));
                        connectivity_hash.update((node as u64).to_le_bytes());
                    }
                    element_count += 1;
                }
            }
        }
    }
    let total_measure = nodal_weights.iter().sum::<f64>();
    if element_count != 6 * u64::from(n).pow(3)
        || incidence.iter().map(Vec::len).sum::<usize>() != element_count as usize * 4
    {
        return Err(
            "structured FEM materialization connectivity cardinality is inconsistent".into(),
        );
    }
    let points_fingerprint = points_fingerprint(&points);
    Ok(FemMeshMaterialization {
        points,
        incident_elements: incidence,
        nodal_control_volume_weights_m3: nodal_weights,
        total_measure_m3: total_measure,
        element_count,
        points_fingerprint,
        connectivity_fingerprint: format!("sha256:{:x}", connectivity_hash.finalize()),
    })
}

fn fem_row(
    refinement: &'static str,
    level: u32,
    n: u32,
) -> Result<(Row, SelectorMetadata), Box<dyn Error>> {
    let mesh = fem_mesh_materialization(n)?;
    let dof_count = mesh.points.len();
    let topology = topology_fingerprint(
        "fem",
        n,
        None,
        Some(&mesh.points_fingerprint),
        Some(&mesh.connectivity_fingerprint),
    );
    let references = vec![[1.0_f64, 0.0, 0.0]; dof_count];
    let constraints = vec![constraint()];
    let selections: Vec<SelectionDefinitionIR> = Vec::new();
    let transforms = BTreeMap::new();
    let known_entities = SelectionValidationContext::new(["film"], [("film", "core")]);
    let resolved_references = vec![ResolvedFrozenSpinsReference {
        constraint_id: CONSTRAINT_ID,
        values: &references,
        source_state_revision: Some(SOURCE_STATE_REVISION),
        topology_fingerprint: &topology,
    }];
    let request = shared_request(
        &constraints,
        &selections,
        &transforms,
        &known_entities,
        &resolved_references,
        &topology,
    );
    let domain = FemTrueDofDomain {
        fe_order: 1,
        true_dof_points_m: &mesh.points,
        incident_elements: &mesh.incident_elements,
        mesh_fingerprint: &topology,
    };
    let plan = compile_fem_frozen_spins(&domain, &request)?;
    let selector = selector_metadata(&plan, &constraints[0])?;
    if plan.frozen_mask.len() != mesh.nodal_control_volume_weights_m3.len() {
        return Err(
            "FEM production plan mask length differs from materialized true-DOF weights".into(),
        );
    }
    let mut selected_measure = 0.0;
    let mut selected_weight_count = 0_u64;
    for (selected, weight) in plan
        .frozen_mask
        .iter()
        .zip(mesh.nodal_control_volume_weights_m3.iter())
    {
        if *selected {
            selected_measure += *weight;
            selected_weight_count += 1;
        }
    }
    if selected_weight_count != plan.frozen_dof_count {
        return Err(
            "FEM selected control-volume weights are not tied to the production plan mask".into(),
        );
    }
    let analytic = SELECTOR_WIDTH_M * DOMAIN_LENGTH_M * DOMAIN_LENGTH_M;
    Ok((
        Row {
            backend: "fem",
            refinement,
            refinement_level: level,
            evaluator_id: plan.certificate.evaluator_id.clone(),
            authored_selector_fingerprint: selector.authored_fingerprint.clone(),
            semantics_selector_fingerprint: selector.semantics_fingerprint.clone(),
            topology_fingerprint: topology,
            resolution: [n; 3],
            materialized_dof_count: dof_count as u64,
            active_dof_count: plan.active_dof_count,
            frozen_dof_count: plan.frozen_dof_count,
            free_dof_count: plan.free_dof_count,
            selected_measure_m3: selected_measure,
            selected_measure_error_abs_m3: (selected_measure - analytic).abs(),
            selected_measure_relative_error: ((selected_measure - analytic) / analytic).abs(),
            domain_measure_m3: mesh.total_measure_m3,
            dof_measure_definition: "fem_p1_structured_tet4_nodal_control_volume_sum",
            selected_measure_weight_count: selected_weight_count,
            mesh_element_count: Some(mesh.element_count),
            resolved_plan: resolved_plan_summary(&plan),
            materialization: json!({
                "source_kind": "rust_production_planner_evaluator",
                "crate": "fullmag-plan",
                "function": "compile_fem_frozen_spins",
                "evaluator_id": plan.certificate.evaluator_id,
                "domain_materialized": true,
                "measure_weights_materialized": true,
                "mesh_family": "structured_cube_split_into_six_tet4",
                "fe_order": 1,
                "domain_length_m": DOMAIN_LENGTH_M,
                "point_count": mesh.points.len(),
                "element_count": mesh.element_count,
                "incident_element_records": mesh.incident_elements.iter().map(Vec::len).sum::<usize>(),
                "points_fingerprint": mesh.points_fingerprint,
                "connectivity_fingerprint": mesh.connectivity_fingerprint,
                "weight_definition": "lumped_p1_nodal_control_volume_sum_tet_volume_over_4",
            }),
        },
        selector,
    ))
}

fn build_materialization() -> Result<Value, Box<dyn Error>> {
    let mut rows = Vec::with_capacity(6);
    let mut selector: Option<SelectorMetadata> = None;
    for (level, (name, n)) in REFINEMENTS.into_iter().enumerate() {
        let (fdm, fdm_selector) = fdm_row(name, level as u32, n)?;
        let (fem, fem_selector) = fem_row(name, level as u32, n)?;
        if let Some(existing) = &selector {
            if existing.authored_fingerprint != fdm_selector.authored_fingerprint
                || existing.semantics_fingerprint != fdm_selector.semantics_fingerprint
            {
                return Err("production evaluator changed the shared selector fingerprint".into());
            }
        } else {
            selector = Some(fdm_selector.clone());
        }
        if fdm_selector.authored_fingerprint != fem_selector.authored_fingerprint
            || fdm_selector.semantics_fingerprint != fem_selector.semantics_fingerprint
        {
            return Err("FDM/FEM selector authored/semantics fingerprints differ".into());
        }
        rows.push(fdm);
        rows.push(fem);
    }
    let selector = selector.ok_or("no refinement rows were materialized")?;
    Ok(json!({
        "schema_version": MATERIALIZATION_SCHEMA,
        "status": "PASS",
        "producer": {
            "kind": "rust_production_planner_evaluator",
            "crate": "fullmag-plan",
            "command": "cargo run -p fullmag-plan --example frozen_spins_cross_discretization -- --output <path>",
        },
        "selector": selector,
        "analytic_measure": {
            "domain_length_m": DOMAIN_LENGTH_M,
            "value_m3": SELECTOR_WIDTH_M * DOMAIN_LENGTH_M * DOMAIN_LENGTH_M,
            "geometry": "box",
            "bounds_m": [[SELECTOR_LOWER_X_M, 0.0, 0.0], [SELECTOR_UPPER_X_M, DOMAIN_LENGTH_M, DOMAIN_LENGTH_M]],
            "formula": "(x_upper-x_lower)*(y_upper-y_lower)*(z_upper-z_lower)",
        },
        "physical_measure_contract": {
            "unit": "m^3",
            "method": "sum_selected_dof_control_volumes",
            "cross_lane_resolved_mask_sha256_comparison": "NOT_PERFORMED",
        },
        "refinements": rows,
    }))
}

fn output_path() -> Result<PathBuf, Box<dyn Error>> {
    let mut args = env::args().skip(1);
    while let Some(argument) = args.next() {
        if argument == "--output" {
            return args
                .next()
                .map(PathBuf::from)
                .ok_or_else(|| "--output requires a path".into());
        }
    }
    Err("usage: frozen_spins_cross_discretization --output <path>".into())
}

fn write_json_atomic(path: &Path, value: &Value) -> Result<(), Box<dyn Error>> {
    let bytes = serde_json::to_vec_pretty(value)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension(format!("tmp.{}", std::process::id()));
    {
        let mut file = File::create(&temporary)?;
        file.write_all(&bytes)?;
        file.write_all(b"\n")?;
        file.flush()?;
        file.sync_all()?;
    }
    if path.exists() {
        fs::remove_file(path)?;
    }
    fs::rename(&temporary, path)?;
    Ok(())
}

fn main() -> Result<(), Box<dyn Error>> {
    let output = output_path()?;
    let value = build_materialization()?;
    write_json_atomic(&output, &value)?;
    println!("{}", json!({"output": output, "status": "PASS", "rows": 6}));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(value: &Value) -> Vec<&Value> {
        value
            .get("refinements")
            .and_then(Value::as_array)
            .expect("materialization rows")
            .iter()
            .collect()
    }

    #[test]
    fn production_evaluators_keep_shared_selector_fingerprints() {
        let value = build_materialization().expect("production materialization succeeds");
        assert_eq!(value["status"], "PASS");
        let rows = rows(&value);
        assert_eq!(rows.len(), 6);
        let selector = &value["selector"];
        for row in &rows {
            assert_eq!(
                row["materialization"]["source_kind"],
                "rust_production_planner_evaluator"
            );
            assert_eq!(
                row["resolved_plan"]["certificate"]["authored_fingerprints"][0]["selector_sha256"],
                selector["authored_fingerprint"]
                    .as_str()
                    .unwrap()
                    .trim_start_matches("sha256:")
            );
        }
        assert_eq!(rows.iter().filter(|row| row["backend"] == "fdm").count(), 3);
        assert_eq!(rows.iter().filter(|row| row["backend"] == "fem").count(), 3);
    }

    #[test]
    fn both_evaluators_have_monotone_physical_measure_convergence() {
        let value = build_materialization().expect("production materialization succeeds");
        let analytic = value["analytic_measure"]["value_m3"]
            .as_f64()
            .expect("analytic measure");
        for backend in ["fdm", "fem"] {
            let mut samples = rows(&value)
                .into_iter()
                .filter(|row| row["backend"] == backend)
                .collect::<Vec<_>>();
            samples.sort_by_key(|row| row["refinement_level"].as_u64().unwrap());
            let mut previous_measure = 0.0;
            let mut previous_error = f64::INFINITY;
            for row in samples {
                let measure = row["selected_measure_m3"].as_f64().unwrap();
                let error = (measure - analytic).abs();
                assert!(measure >= previous_measure);
                assert!(error < previous_error);
                assert!(measure <= analytic * (1.0 + 1.0e-12));
                previous_measure = measure;
                previous_error = error;
            }
        }
    }
}
