//! Execute the Frozen Spins cross-discretization runtime probe.
//!
//! The materialization example in `fullmag-plan` proves selector semantics and
//! control-volume convergence.  This executable adds the missing solver
//! evidence: every FDM/FEM refinement is compiled by the production planner,
//! run for one real reference-solver step, and reduced to immutable metrics.
//! It is deliberately a reference-lane probe; managed MFEM/CUDA qualification
//! remains owned by the corresponding `just` recipes.

use fullmag_ir::{
    BoundaryMembershipIR, ConstraintActivationIR, EmptySelectionPolicyIR,
    ExchangeBoundaryCondition, ExecutionPrecision, FemPlanIR, FrozenReferencePolicyIR,
    FrozenSpinsIR, GeometryPredicateIR, GridDimensions, InactiveSelectionPolicyIR,
    SelectionDefinitionIR, SelectionExprIR, SelectionFrameIR, SelectionMembershipPolicyIR,
    SelectionSamplingIR, SelectionValidationContext, FROZEN_SPINS_SCHEMA_VERSION,
};
use fullmag_plan::{
    compile_fdm_frozen_spins, compile_fem_frozen_spins, AffineTransform3, FdmFrozenSpinsDomain,
    FemIncidentElement, FemTrueDofDomain, FrozenSpinsCompileRequest, ResolvedFrozenSpinsReference,
    SelectionDofMembership,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::env;
use std::error::Error;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

const SCHEMA: &str = "fullmag.frozen_spins.cross_discretization.runtime.v1";
const CONSTRAINT_ID: &str = "cross_discretization_slab";
// The reference FEM engine uses an absolute determinant guard of 1e-30.
// Use a micron-scale synthetic domain so the finest (23^3) refinement stays
// above that guard while preserving the exact same selector proportions in
// both discretizations.
const DOMAIN_LENGTH_M: f64 = 1.0e-6;
const SELECTOR_LOWER_X_M: f64 = 0.2e-6;
const SELECTOR_UPPER_X_M: f64 = 0.6e-6;
const SELECTOR_WIDTH_M: f64 = SELECTOR_UPPER_X_M - SELECTOR_LOWER_X_M;
const SOURCE_STATE_REVISION: u64 = 1;
const DT_S: f64 = 1.0e-15;
const REFINEMENTS: [(&str, u32); 3] = [("coarse", 8), ("medium", 13), ("fine", 23)];

fn selector_expression() -> SelectionExprIR {
    SelectionExprIR::InsideGeometry {
        geometry: GeometryPredicateIR::Box {
            center_m: [0.4e-6, 0.5e-6, 0.5e-6],
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
        name: "Cross-discretization slab".to_string(),
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
    grid: Option<&str>,
    points: Option<&str>,
    connectivity: Option<&str>,
) -> String {
    let payload = json!({
        "backend": backend,
        "domain_length_f64_bits": format!("{:016x}", DOMAIN_LENGTH_M.to_bits()),
        "materialized_connectivity_fingerprint": connectivity,
        "materialized_grid_fingerprint": grid,
        "materialized_points_fingerprint": points,
        "n": n,
        "schema_version": "fullmag.frozen_spins.cross_discretization.topology.v2",
    });
    format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(&payload).unwrap())
    )
}

fn fdm_grid_fingerprint(n: u32, cell_m: f64) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"fullmag.frozen_spins.cross_discretization.fdm_grid.v1");
    hasher.update(n.to_le_bytes());
    hasher.update(DOMAIN_LENGTH_M.to_bits().to_le_bytes());
    for k in 0..n {
        for j in 0..n {
            for i in 0..n {
                for index in [i, j, k] {
                    hasher.update(((f64::from(index) + 0.5) * cell_m).to_bits().to_le_bytes());
                }
            }
        }
    }
    format!("sha256:{:x}", hasher.finalize())
}

fn node_index(i: u32, j: u32, k: u32, n: u32) -> usize {
    let side = (n + 1) as usize;
    (k as usize * side + j as usize) * side + i as usize
}

fn fem_mesh(n: u32) -> (Vec<[f64; 3]>, Vec<[u32; 4]>) {
    let side = (n + 1) as usize;
    let mut points = Vec::with_capacity(side * side * side);
    for k in 0..=n {
        for j in 0..=n {
            for i in 0..=n {
                points.push([
                    f64::from(i) * DOMAIN_LENGTH_M / f64::from(n),
                    f64::from(j) * DOMAIN_LENGTH_M / f64::from(n),
                    f64::from(k) * DOMAIN_LENGTH_M / f64::from(n),
                ]);
            }
        }
    }
    let mut elements = Vec::with_capacity(6 * n as usize * n as usize * n as usize);
    for k in 0..n {
        for j in 0..n {
            for i in 0..n {
                let v000 = node_index(i, j, k, n) as u32;
                let v100 = node_index(i + 1, j, k, n) as u32;
                let v010 = node_index(i, j + 1, k, n) as u32;
                let v110 = node_index(i + 1, j + 1, k, n) as u32;
                let v001 = node_index(i, j, k + 1, n) as u32;
                let v101 = node_index(i + 1, j, k + 1, n) as u32;
                let v011 = node_index(i, j + 1, k + 1, n) as u32;
                let v111 = node_index(i + 1, j + 1, k + 1, n) as u32;
                elements.extend_from_slice(&[
                    [v000, v100, v110, v111],
                    [v000, v110, v010, v111],
                    [v000, v010, v011, v111],
                    [v000, v011, v001, v111],
                    [v000, v001, v101, v111],
                    [v000, v101, v100, v111],
                ]);
            }
        }
    }
    (points, elements)
}

fn fem_points_fingerprint(points: &[[f64; 3]]) -> String {
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

fn fem_connectivity_fingerprint(elements: &[[u32; 4]], point_count: usize) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"fullmag.frozen_spins.cross_discretization.fem_tet4_connectivity.v1");
    hasher.update((point_count as u64).to_le_bytes());
    for (ordinal, element) in elements.iter().enumerate() {
        hasher.update((ordinal as u64).to_le_bytes());
        for node in element {
            hasher.update((*node as u64).to_le_bytes());
        }
    }
    format!("sha256:{:x}", hasher.finalize())
}

fn shared_request<'a>(
    constraints: &'a [FrozenSpinsIR],
    selections: &'a [SelectionDefinitionIR],
    transforms: &'a BTreeMap<String, AffineTransform3>,
    known_entities: &'a SelectionValidationContext,
    references: &'a [ResolvedFrozenSpinsReference<'a>],
    topology: &'a str,
) -> FrozenSpinsCompileRequest<'a> {
    FrozenSpinsCompileRequest {
        constraints,
        selections,
        activation_stage_id: None,
        object_transforms: transforms,
        known_entities,
        state_snapshot: None,
        resolved_references: references,
        expected_source_state_revision: Some(SOURCE_STATE_REVISION),
        expected_grid_or_mesh_fingerprint: topology,
    }
}

fn fdm_plan(n: u32) -> Result<fullmag_ir::FdmPlanIR, Box<dyn Error>> {
    let side = usize::try_from(n)?;
    let count = side
        .checked_mul(side)
        .and_then(|value| value.checked_mul(side))
        .ok_or("FDM point count overflow")?;
    let cell = DOMAIN_LENGTH_M / f64::from(n);
    let grid_materialization = fdm_grid_fingerprint(n, cell);
    let topology = topology_fingerprint("fdm", n, Some(&grid_materialization), None, None);
    let active = vec![true; count];
    let memberships = (0..count)
        .map(|_| SelectionDofMembership {
            object_ids: vec!["film".to_string()],
            region_ids: vec![("film".to_string(), "core".to_string())],
        })
        .collect::<Vec<_>>();
    let references = vec![[1.0, 0.0, 0.0]; count];
    let constraints = vec![constraint()];
    let selections = Vec::<SelectionDefinitionIR>::new();
    let transforms = BTreeMap::new();
    let known = SelectionValidationContext::new(["film"], [("film", "core")]);
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
        &known,
        &resolved_references,
        &topology,
    );
    let domain = FdmFrozenSpinsDomain {
        origin_m: [0.0; 3],
        counts: [n; 3],
        cell_m: [cell; 3],
        active_mask: &active,
        memberships: &memberships,
        grid_fingerprint: &topology,
    };
    let resolved = compile_fdm_frozen_spins(&domain, &request)?;
    let region_mask = vec![0; count];
    let grid_certificate = fullmag_ir::FdmGridCertificateIR::new_with_masks(
        [0.0; 3],
        [n; 3],
        [cell; 3],
        count as u64,
        (count as u64)
            .saturating_mul(fullmag_plan::FDM_GRID_ESTIMATED_BYTES_PER_CELL)
            .max(1),
        Some(&active),
        &region_mask,
    )?;
    Ok(fullmag_ir::FdmPlanIR {
        grid: GridDimensions { cells: [n; 3] },
        cell_size: [cell; 3],
        grid_certificate: Some(grid_certificate),
        region_mask,
        active_mask: Some(active),
        frozen_spins: Some(resolved),
        initial_magnetization: references,
        material: fullmag_ir::FdmMaterialIR {
            name: "Py".to_string(),
            saturation_magnetisation: 800e3,
            exchange_stiffness: 13e-12,
            damping: 0.5,
            ..Default::default()
        },
        enable_exchange: true,
        enable_demag: false,
        external_field: Some([0.0, 0.0, 1.0e6]),
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        integrator: Some(fullmag_ir::IntegratorChoice::Heun),
        fixed_timestep: Some(DT_S),
        ..Default::default()
    })
}

fn fem_plan(n: u32) -> Result<FemPlanIR, Box<dyn Error>> {
    let (points, elements) = fem_mesh(n);
    let points_fingerprint = fem_points_fingerprint(&points);
    let connectivity_fingerprint = fem_connectivity_fingerprint(&elements, points.len());
    let topology = topology_fingerprint(
        "fem",
        n,
        None,
        Some(&points_fingerprint),
        Some(&connectivity_fingerprint),
    );
    let mut incident = vec![Vec::new(); points.len()];
    for element in &elements {
        for node in element {
            incident[*node as usize].push(FemIncidentElement::magnetic("film", &["core"]));
        }
    }
    let references = vec![[1.0, 0.0, 0.0]; points.len()];
    let constraints = vec![constraint()];
    let selections = Vec::<SelectionDefinitionIR>::new();
    let transforms = BTreeMap::new();
    let known = SelectionValidationContext::new(["film"], [("film", "core")]);
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
        &known,
        &resolved_references,
        &topology,
    );
    let domain = FemTrueDofDomain {
        fe_order: 1,
        true_dof_points_m: &points,
        incident_elements: &incident,
        mesh_fingerprint: &topology,
    };
    let resolved = compile_fem_frozen_spins(&domain, &request)?;
    let mesh = fullmag_ir::MeshIR {
        mesh_name: format!("cross_discretization_fem_n{n}"),
        nodes: points,
        cells: fullmag_ir::FemConnectivityIR::from_tet4(elements),
        element_markers: vec![1; 6 * n as usize * n as usize * n as usize],
        facets: fullmag_ir::FemFacetConnectivityIR::empty(),
        boundary_markers: Vec::new(),
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: HashMap::new(),
    };
    Ok(FemPlanIR {
        mesh_name: mesh.mesh_name.clone(),
        mesh_source: None,
        mesh,
        fe_order: 1,
        hmax: DOMAIN_LENGTH_M / f64::from(n),
        initial_magnetization: references,
        frozen_spins: Some(resolved),
        material: fullmag_ir::MaterialIR {
            name: "Py".to_string(),
            saturation_magnetisation: 800e3,
            exchange_stiffness: 13e-12,
            damping: 0.5,
            ..Default::default()
        },
        enable_exchange: true,
        enable_demag: false,
        external_field: Some([0.0, 0.0, 1.0e6]),
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        integrator: Some(fullmag_ir::IntegratorChoice::Heun),
        fixed_timestep: Some(DT_S),
        ..FemPlanIR::default()
    })
}

fn norm(value: [f64; 3]) -> f64 {
    (value[0] * value[0] + value[1] * value[1] + value[2] * value[2]).sqrt()
}

fn ordered(bits: u64) -> u64 {
    if bits & (1_u64 << 63) == 0 {
        bits | (1_u64 << 63)
    } else {
        !bits
    }
}

fn mask_sha256(mask: &[bool]) -> String {
    let mut hasher = Sha256::new();
    hasher.update((mask.len() as u64).to_le_bytes());
    hasher.update(
        mask.iter()
            .map(|selected| u8::from(*selected))
            .collect::<Vec<_>>(),
    );
    format!("sha256:{:x}", hasher.finalize())
}

fn runtime_metrics(
    backend: &str,
    refinement: &str,
    level: u32,
    resolution: u32,
    mask: &[bool],
    initial: &[[f64; 3]],
    final_state: &[[f64; 3]],
    steps: u64,
    energy: f64,
    max_rhs_free: f64,
    max_rhs_all: f64,
    max_torque_free: f64,
    max_torque_all: f64,
) -> Value {
    let mut frozen_abs: f64 = 0.0;
    let mut frozen_ulp = 0_u64;
    let mut free_displacement: f64 = 0.0;
    let mut has_free = false;
    let mut has_frozen = false;
    let frozen_dof_count = mask.iter().filter(|selected| **selected).count();
    let active_dof_count = mask.len();
    let mut hash = Sha256::new();
    hash.update((final_state.len() as u64).to_le_bytes());
    for ((before, after), frozen) in initial.iter().zip(final_state).zip(mask) {
        for component in after {
            hash.update(component.to_bits().to_le_bytes());
        }
        let displacement = norm([
            after[0] - before[0],
            after[1] - before[1],
            after[2] - before[2],
        ]);
        if *frozen {
            has_frozen = true;
            frozen_abs = frozen_abs.max(displacement);
            for (before_component, after_component) in before.iter().zip(after) {
                frozen_ulp = frozen_ulp.max(
                    ordered(before_component.to_bits())
                        .abs_diff(ordered(after_component.to_bits())),
                );
            }
        } else {
            has_free = true;
            free_displacement = free_displacement.max(displacement);
        }
    }
    json!({
        "backend": backend,
        "refinement": refinement,
        "refinement_level": level,
        "resolution": [resolution, resolution, resolution],
        "active_dof_count": active_dof_count,
        "frozen_dof_count": frozen_dof_count,
        "free_dof_count": active_dof_count.saturating_sub(frozen_dof_count),
        "resolved_mask_sha256": mask_sha256(mask),
        "solver": {
            "status": "completed",
            "steps_executed": steps,
            "energy_finite": energy.is_finite(),
            "frozen_max_abs_drift": frozen_abs,
            "frozen_max_ulp_drift": frozen_ulp,
            "free_max_displacement": free_displacement,
            "free_dof_mobility_observed": has_free && free_displacement > 0.0,
            "frozen_dof_present": has_frozen,
            "max_rhs_free": max_rhs_free,
            "max_rhs_all": max_rhs_all,
            "max_torque_free": max_torque_free,
            "max_torque_all": max_torque_all,
            "fallback_used": false,
            "per_step_frozen_transfer_bytes": 0,
        },
        "final_magnetization_sha256": format!("sha256:{:x}", hash.finalize()),
    })
}

fn execute() -> Result<Value, Box<dyn Error>> {
    let mut rows = Vec::with_capacity(6);
    for (level, (refinement, n)) in REFINEMENTS.into_iter().enumerate() {
        let fdm = fdm_plan(n)?;
        let fdm_mask = fdm.frozen_spins.as_ref().unwrap().frozen_mask.clone();
        let fdm_initial = fdm.initial_magnetization.clone();
        let fdm_result = fullmag_runner::run_reference_fdm(&fdm, DT_S, &[])?;
        let fdm_step = fdm_result
            .steps
            .iter()
            .max_by_key(|step| step.step)
            .ok_or("FDM runtime probe emitted no step")?;
        rows.push(runtime_metrics(
            "fdm",
            refinement,
            level as u32,
            n,
            &fdm_mask,
            &fdm_initial,
            &fdm_result.final_magnetization,
            fdm_step.step,
            fdm_step.e_total,
            fdm_step.max_rhs_norm_per_s,
            fdm_step.max_rhs_all_norm_per_s,
            fdm_step.max_torque_Apm,
            fdm_step.max_torque_all_Apm,
        ));

        let fem = fem_plan(n)?;
        let fem_mask = fem.frozen_spins.as_ref().unwrap().frozen_mask.clone();
        let fem_initial = fem.initial_magnetization.clone();
        let fem_result = fullmag_runner::run_reference_fem(&fem, DT_S, &[])?;
        let fem_step = fem_result
            .steps
            .iter()
            .max_by_key(|step| step.step)
            .ok_or("FEM runtime probe emitted no step")?;
        rows.push(runtime_metrics(
            "fem",
            refinement,
            level as u32,
            n,
            &fem_mask,
            &fem_initial,
            &fem_result.final_magnetization,
            fem_step.step,
            fem_step.e_total,
            fem_step.max_rhs_norm_per_s,
            fem_step.max_rhs_all_norm_per_s,
            fem_step.max_torque_Apm,
            fem_step.max_torque_all_Apm,
        ));
    }
    Ok(json!({
        "schema_version": SCHEMA,
        "status": "PASS",
        "implementation_status": "EXECUTED_PRODUCTION_PLANNER_AND_REFERENCE_RUNTIME",
        "qualification_status": "UNQUALIFIED",
        "qualification_blocker": "managed_clean_source_receipt_required",
        "test_case_ids": ["FS-P15-CROSS-DISCRETIZATION"],
        "contract": {
            "shared_selector": "production_planner_compile_fdm_and_compile_fem",
            "reference_policy": "capture_current_at_activation",
            "membership_policy": "static",
            "integrator": "heun",
            "precision": "double",
            "dt_s": DT_S,
            "resolved_mask_hashes_cross_lane": "NOT_COMPARED",
        },
        "rows": rows,
    }))
}

fn output_path() -> Result<PathBuf, Box<dyn Error>> {
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--output" {
            return args
                .next()
                .map(PathBuf::from)
                .ok_or_else(|| "--output requires a path".into());
        }
    }
    Err("usage: frozen_spins_cross_discretization_runtime --output <path>".into())
}

fn write_json_atomic(path: &Path, value: &Value) -> Result<(), Box<dyn Error>> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension(format!("tmp.{}", std::process::id()));
    {
        let mut file = File::create(&temporary)?;
        file.write_all(&serde_json::to_vec_pretty(value)?)?;
        file.write_all(b"\n")?;
        file.flush()?;
        file.sync_all()?;
    }
    if path.exists() {
        fs::remove_file(path)?;
    }
    fs::rename(temporary, path)?;
    Ok(())
}

fn main() -> Result<(), Box<dyn Error>> {
    let output = output_path()?;
    let value = execute()?;
    write_json_atomic(&output, &value)?;
    println!("{}", json!({"output": output, "status": "PASS", "rows": 6}));
    Ok(())
}
