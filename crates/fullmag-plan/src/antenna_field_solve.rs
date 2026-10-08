use fullmag_ir::{
    AntennaConductorFemPlanIR, AntennaFieldSamplingPlanIR, AntennaFieldSolvePlanIR,
    AntennaOerstedRealizationIR, BackendTarget, CommonPlanMeta, CurrentModuleIR,
    DiscretizationHintsIR, FemCellTypeIR, FieldTargetIR, MeshIR, ProblemIR, ProvenancePlanIR,
    ANTENNA_FIELD_SOLVE_PLAN_SCHEMA_VERSION, IR_VERSION,
};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

use crate::antenna_composition::bind_antenna_field_solve_v03;
use crate::mesh::{
    build_conductor_mesh_parts_from_segments, load_mesh_from_source, merge_fem_meshes,
};
use crate::spin_transport::resolve_fem_charge_only_transport;
use crate::PlanError;

fn fail(reason: impl Into<String>) -> PlanError {
    PlanError {
        reasons: vec![reason.into()],
    }
}

fn preflight_direct_oersted_pair_budget(
    source_cell_count: usize,
    target_point_count: usize,
) -> Result<u64, PlanError> {
    if source_cell_count == 0 || target_point_count == 0 {
        return Err(fail(format!(
            "antenna direct Oersted preflight requires nonempty source tetrahedra and target points ({source_cell_count} source tetrahedra x {target_point_count} target points)"
        )));
    }
    let source_count = u64::try_from(source_cell_count).map_err(|_| {
        fail("antenna direct Oersted preflight source cell count is not representable")
    })?;
    let target_count = u64::try_from(target_point_count).map_err(|_| {
        fail("antenna direct Oersted preflight target point count is not representable")
    })?;
    let pairs = source_count.checked_mul(target_count).ok_or_else(|| {
        fail(format!(
            "antenna direct Oersted preflight source-target pair count overflows: {source_count} source tetrahedra x {target_count} target points"
        ))
    })?;
    if pairs > fullmag_ir::ANTENNA_DIRECT_OERSTED_MAX_SOURCE_TARGET_PAIRS {
        return Err(fail(format!(
            "antenna direct Oersted preflight policy='{}' requires {pairs} source-target pairs ({source_count} source tetrahedra x {target_count} target points), exceeding the limit {}; reduce the authored field-sampling target or select the qualified vector-potential realization",
            fullmag_ir::ANTENNA_DIRECT_OERSTED_BUDGET_POLICY_V1,
            fullmag_ir::ANTENNA_DIRECT_OERSTED_MAX_SOURCE_TARGET_PAIRS,
        )));
    }
    Ok(pairs)
}

fn direct_oersted_known_target_buffer_bytes(target_point_count: usize) -> Result<u64, PlanError> {
    let targets = u64::try_from(target_point_count)
        .map_err(|_| fail("antenna direct Oersted target count is not representable"))?;
    targets
        .checked_mul(4 * 3 * std::mem::size_of::<f64>() as u64)
        .ok_or_else(|| fail("antenna direct Oersted target-buffer byte count overflows"))
}

fn sha256_json(value: &impl serde::Serialize, label: &str) -> Result<String, PlanError> {
    let bytes =
        serde_json::to_vec(value).map_err(|error| fail(format!("serialize {label}: {error}")))?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}

pub(crate) fn geometry_name_for_object<'a>(
    problem: &'a ProblemIR,
    object_id: &str,
) -> Result<&'a str, PlanError> {
    let explicit_object = problem
        .magnets
        .iter()
        .find(|magnet| magnet.object_id.as_deref() == Some(object_id));
    if explicit_object.is_none() {
        if let Some(entry) = problem
            .geometry
            .entries
            .iter()
            .find(|entry| entry.name() == object_id)
        {
            return Ok(entry.name());
        }
    }
    let magnet = explicit_object
        .or_else(|| {
            problem
                .magnets
                .iter()
                .find(|magnet| magnet.name == object_id)
        })
        .ok_or_else(|| {
            fail(format!(
                "antenna object '{object_id}' has no geometry binding in ProblemIR 0.3"
            ))
        })?;
    let region = problem
        .regions
        .iter()
        .find(|region| region.name == magnet.region)
        .ok_or_else(|| {
            fail(format!(
                "antenna object '{object_id}' references missing region '{}'",
                magnet.region
            ))
        })?;
    Ok(region.geometry.as_str())
}

fn load_object_mesh(
    problem: &ProblemIR,
    object_id: &str,
) -> Result<(String, MeshIR, Option<String>), PlanError> {
    let geometry_name = geometry_name_for_object(problem, object_id)?.to_string();
    let asset = problem
        .geometry_assets
        .as_ref()
        .and_then(|assets| {
            assets
                .fem_mesh_assets
                .iter()
                .find(|asset| asset.geometry_name == geometry_name)
        })
        .ok_or_else(|| {
            fail(format!(
                "antenna object '{object_id}' requires an independent FEM conductor/target mesh asset for geometry '{geometry_name}'"
            ))
        })?;
    let mesh = match (&asset.mesh, &asset.mesh_source) {
        (Some(mesh), _) => mesh.clone(),
        (None, Some(source)) => load_mesh_from_source(source).map_err(fail)?,
        (None, None) => {
            return Err(fail(format!(
                "FEM mesh asset for antenna geometry '{geometry_name}' has neither inline mesh nor mesh_source"
            )))
        }
    };
    Ok((geometry_name, mesh, asset.mesh_source.clone()))
}

fn require_tetrahedral_conductor_mesh(mesh: &MeshIR, object_id: &str) -> Result<(), PlanError> {
    if mesh
        .cells
        .iter()
        .any(|cell| cell.cell_type != FemCellTypeIR::Tet4)
    {
        return Err(fail(format!(
            "antenna conductor object '{object_id}' requires a full 3D tetrahedral P1 mesh; non-tetrahedral cells are not qualified"
        )));
    }
    Ok(())
}

fn require_tetrahedral_field_sampling_mesh(
    mesh: &MeshIR,
    carrier_kind: &str,
) -> Result<(), PlanError> {
    if mesh.cells.is_empty() {
        return Err(fail(format!(
            "antenna field-sampling carrier '{carrier_kind}' has no cells; a non-empty tet4 P1 topology is required for the executable FEM sampling lane"
        )));
    }
    mesh.cells.require_tet4().map_err(|error| {
        fail(format!(
            "unsupported antenna field-sampling topology in carrier '{carrier_kind}': tet4 P1 connectivity is required and mixed/non-tet topology cannot be downgraded to identity sampling ({error})"
        ))
    })?;
    Ok(())
}

fn resolve_field_sampling(
    problem: &ProblemIR,
    target: &FieldTargetIR,
) -> Result<AntennaFieldSamplingPlanIR, PlanError> {
    let (carrier_kind, mesh) = match target {
        FieldTargetIR::Global {} => {
            let asset = problem
                .geometry_assets
                .as_ref()
                .and_then(|assets| assets.fem_domain_mesh_asset.as_ref())
                .ok_or_else(|| {
                    fail("global antenna field sampling requires an authored FEM domain mesh asset covering air and magnetic regions")
                })?;
            let mesh = match (&asset.mesh, &asset.mesh_source) {
                (Some(mesh), _) => mesh.clone(),
                (None, Some(source)) => load_mesh_from_source(source).map_err(fail)?,
                (None, None) => {
                    return Err(fail(
                        "global antenna field-sampling mesh has neither inline mesh nor mesh_source",
                    ))
                }
            };
            ("fem_domain_mesh_asset".to_string(), mesh)
        }
        FieldTargetIR::Object { object_id } => {
            let (geometry_name, mesh, _) = load_object_mesh(problem, object_id)?;
            (format!("fem_mesh_asset:{geometry_name}"), mesh)
        }
        FieldTargetIR::Region {
            object_id,
            region_id,
        } => {
            return Err(fail(format!(
                "antenna field sampling for region '{object_id}:{region_id}' requires an explicit point-cloud carrier; region extraction from a volume mesh is not implemented"
            )))
        }
    };
    if mesh.nodes.is_empty()
        || mesh
            .nodes
            .iter()
            .flatten()
            .any(|component| !component.is_finite())
    {
        return Err(fail(
            "antenna field-sampling carrier must contain finite sample positions",
        ));
    }
    require_tetrahedral_field_sampling_mesh(&mesh, &carrier_kind)?;
    Ok(AntennaFieldSamplingPlanIR {
        domain: target.clone(),
        carrier_kind,
        location: "node".into(),
        topology_digest: sha256_json(&mesh, "antenna field-sampling topology")?,
        positions_xyz_m: mesh.nodes,
        cells: mesh.cells,
    })
}

pub(crate) fn plan_antenna_field_solve_v03(
    problem: &ProblemIR,
    stage_id: &str,
    port_mode_id: &str,
) -> Result<AntennaFieldSolvePlanIR, PlanError> {
    match plan_antenna_field_solve_execution(problem, stage_id, port_mode_id)? {
        AntennaFieldSolveExecutionPlan::FieldBasis(plan) => Ok(plan),
        AntennaFieldSolveExecutionPlan::ExternalLeadInspection { .. } => Err(fail(
            "source_not_qualified: external-lead inspection is not a legacy antenna field basis; use the dedicated inspection stage execution",
        )),
    }
}

/// Execution routing only; both branches originate from the same authored stage.
#[derive(Debug, Clone)]
pub enum AntennaFieldSolveExecutionPlan {
    FieldBasis(AntennaFieldSolvePlanIR),
    ExternalLeadInspection {
        input: fullmag_ir::ResolvedAntennaExternalLeadCurrentInputIR,
        requested_execution: fullmag_ir::RequestedTransportExecutionIR,
        output_id: String,
    },
}

pub fn plan_antenna_field_solve_execution(
    problem: &ProblemIR,
    stage_id: &str,
    port_mode_id: &str,
) -> Result<AntennaFieldSolveExecutionPlan, PlanError> {
    problem
        .validate()
        .map_err(|reasons| PlanError { reasons })?;
    if problem.backend_policy.requested_backend != BackendTarget::Fem {
        return Err(fail(
            "antenna field precomputation requires requested_backend='fem'; backend auto-resolution or FDM fallback is forbidden",
        ));
    }
    let stage = problem
        .antenna_field_solve_stages
        .iter()
        .find(|stage| stage.id == stage_id)
        .ok_or_else(|| {
            fail(format!(
                "antenna field-solve stage '{stage_id}' does not exist"
            ))
        })?;
    if !stage.port_mode_ids.iter().any(|id| id == port_mode_id) {
        return Err(fail(format!(
            "antenna field-solve stage '{stage_id}' does not include port mode '{port_mode_id}'"
        )));
    }
    let solution_id = stage
        .outputs
        .iter()
        .find(|output| output.quantity == "H_ant_basis")
        .map(|output| output.id.clone())
        .ok_or_else(|| {
            fail(format!(
                "antenna field-solve stage '{stage_id}' has no H_ant_basis output"
            ))
        })?;
    let fem_hints = match &problem.backend_policy.discretization_hints {
        Some(DiscretizationHintsIR { fem: Some(fem), .. }) => fem,
        _ => {
            return Err(fail(
                "antenna field precomputation requires FEM discretization hints (order + hmax)",
            ))
        }
    };
    if fem_hints.order != 1 {
        return Err(fail(format!(
            "antenna conductor solve currently qualifies only P1/H1 (requested order={})",
            fem_hints.order
        )));
    }

    let current = problem
        .current_modules
        .iter()
        .find(|module| {
            matches!(module, CurrentModuleIR::CurrentTransport { name, .. } if name == &stage.current_transport_id)
        })
        .ok_or_else(|| {
            fail(format!(
                "antenna field-solve stage '{stage_id}' references missing CurrentTransport '{}'",
                stage.current_transport_id
            ))
        })?;
    let CurrentModuleIR::CurrentTransport {
        definition: Some(definition),
        ..
    } = current
    else {
        return Err(fail(format!(
            "antenna field-solve stage '{stage_id}' requires a complete CurrentTransport definition"
        )));
    };

    let mut object_ids = Vec::new();
    let mut seen = BTreeSet::new();
    for region in &definition.domain {
        if region.region_id.is_some() {
            return Err(fail(format!(
                "antenna conductor subregion '{}:{:?}' requires an explicitly materialized submesh; the current P1 lane accepts complete object domains only",
                region.object_id, region.region_id
            )));
        }
        if seen.insert(region.object_id.as_str()) {
            object_ids.push(region.object_id.clone());
        }
    }
    if object_ids.is_empty() {
        return Err(fail("antenna CurrentTransport domain must not be empty"));
    }
    if definition.conservative_current_source.is_some() && object_ids.len() != 1 {
        return Err(fail(
            "antenna external-lead inspection requires one original device object mesh; multi-object merge remaps markers and ordinals without a stable-ID ownership contract",
        ));
    }

    let mut geometry_by_object = BTreeMap::new();
    let mut meshes = Vec::with_capacity(object_ids.len());
    let mut mesh_sources = Vec::with_capacity(object_ids.len());
    for object_id in &object_ids {
        let (geometry_name, mesh, mesh_source) = load_object_mesh(problem, object_id)?;
        require_tetrahedral_conductor_mesh(&mesh, object_id)?;
        geometry_by_object.insert(object_id.clone(), geometry_name);
        meshes.push((object_id.clone(), mesh));
        mesh_sources.push(mesh_source);
    }
    let (mesh, mut object_segments) = merge_fem_meshes(&meshes).map_err(fail)?;
    for segment in &mut object_segments {
        segment.geometry_id = geometry_by_object.get(&segment.object_id).cloned();
    }
    let mesh_parts = build_conductor_mesh_parts_from_segments(&mesh, &object_segments);

    if definition.conservative_current_source.is_some() {
        if problem
            .antenna_target_projections
            .iter()
            .any(|projection| projection.solution.stage_id() == stage_id)
            || problem
                .antenna_spectrum_requests
                .iter()
                .any(|request| request.solution_ref.stage_id() == stage_id)
        {
            return Err(fail(
                "source_not_qualified: external-lead inspection cannot be referenced by target projection, solved drive or source spectrum",
            ));
        }
        if problem.backend_policy.execution_precision != fullmag_ir::ExecutionPrecision::Double
            || problem.validation_profile.execution_mode != fullmag_ir::ExecutionMode::Strict
        {
            return Err(fail(
                "antenna conservative_current_source requires the explicit FEM strict/double input lane",
            ));
        }
        let device = match crate::util::runtime_device_request(problem) {
            None | Some("auto") => fullmag_ir::ExecutionDevice::Auto,
            Some("cpu") => fullmag_ir::ExecutionDevice::Cpu,
            Some(device) => {
                return Err(fail(format!(
                    "antenna conservative_current_source has no realization for requested device '{device}'; a forced device cannot fall back to CPU"
                )));
            }
        };
        if stage.port_mode_ids.len() != 1 {
            return Err(fail(
                "antenna conservative_current_source input requires one independently selected port mode per dedicated stage",
            ));
        }
        let port = problem
            .antenna_port_modes
            .iter()
            .find(|port| port.id == port_mode_id)
            .ok_or_else(|| fail(format!("antenna port mode '{port_mode_id}' does not exist")))?;
        let field_sampling = resolve_field_sampling(problem, &stage.field_sampling_domain)?;
        let input = crate::antenna_current_source::materialize_antenna_external_lead_current_input(
            &mesh,
            &object_segments,
            definition,
            stage,
            port,
            &field_sampling,
        )?;
        // Raw inspection is a separate result, never a per-ampere drive basis.
        return Ok(AntennaFieldSolveExecutionPlan::ExternalLeadInspection {
            input,
            requested_execution: fullmag_ir::RequestedTransportExecutionIR {
                discretization: problem.backend_policy.requested_backend,
                device,
                precision: problem.backend_policy.execution_precision,
                execution_mode: problem.validation_profile.execution_mode,
            },
            output_id: solution_id,
        });
    }

    let mut charge_problem = problem.clone();
    charge_problem.current_modules.retain(|module| {
        matches!(module, CurrentModuleIR::CurrentTransport { name, .. } if name == &stage.current_transport_id)
    });
    charge_problem.spin_transport_modules.clear();
    charge_problem.energy_terms.clear();
    let charge_transport_plans = resolve_fem_charge_only_transport(
        &charge_problem,
        &mesh,
        &object_segments,
        &mesh_parts,
        true,
    )?;
    if charge_transport_plans.len() != 1 {
        return Err(fail(format!(
            "antenna field-solve stage '{stage_id}' must resolve exactly one charge-only CurrentTransport, resolved {}",
            charge_transport_plans.len()
        )));
    }

    let oersted_realization = match stage.oersted_realization {
        AntennaOerstedRealizationIR::DirectTetraQuadrature => {
            fullmag_ir::OerstedRealization::BiotSavartMidpoint
        }
        AntennaOerstedRealizationIR::VectorPotentialSolver => {
            fullmag_ir::OerstedRealization::FemVectorPotential
        }
    };
    let mesh_source = if mesh_sources.len() == 1 {
        mesh_sources.into_iter().next().flatten()
    } else {
        None
    };
    let mut conductor = AntennaConductorFemPlanIR {
        mesh_name: mesh.mesh_name.clone(),
        mesh_source,
        mesh,
        object_segments,
        mesh_parts,
        fe_order: fem_hints.order,
        hmax: fem_hints.hmax,
        charge_transport_plans,
        oersted_realization,
    };
    bind_antenna_field_solve_v03(problem, stage_id, port_mode_id, &mut conductor)?;
    let field_sampling = resolve_field_sampling(problem, &stage.field_sampling_domain)?;
    let (direct_oersted_pairs, known_target_buffer_bytes) = if matches!(
        stage.oersted_realization,
        AntennaOerstedRealizationIR::DirectTetraQuadrature
    ) {
        let pairs = preflight_direct_oersted_pair_budget(
            conductor.mesh.cells.len(),
            field_sampling.positions_xyz_m.len(),
        )?;
        let bytes = direct_oersted_known_target_buffer_bytes(field_sampling.positions_xyz_m.len())?;
        (Some(pairs), Some(bytes))
    } else {
        (None, None)
    };

    let mut provenance_notes = vec![
        "dedicated antenna precomputation: conductor H1/P1 -> conservative RT0 current -> Oersted field basis; no magnetization or LLG state".into(),
        format!(
            "conductor mesh policy='{}', solver policy='{}'",
            stage.conductor_mesh_policy, stage.solver_policy
        ),
        format!(
            "direct Oersted budget policy='{}', source_target_pairs={}, max_source_target_pairs={}",
            fullmag_ir::ANTENNA_DIRECT_OERSTED_BUDGET_POLICY_V1,
            direct_oersted_pairs
                .map_or_else(|| "not_applicable".to_string(), |pairs| pairs.to_string()),
            fullmag_ir::ANTENNA_DIRECT_OERSTED_MAX_SOURCE_TARGET_PAIRS,
        ),
        format!(
            "direct Oersted known concurrent target buffers (input/output in Rust and native): bytes={}, excludes mesh, solver and allocator overhead",
            known_target_buffer_bytes.map_or_else(|| "not_applicable".to_string(), |bytes| bytes.to_string()),
        ),
    ];
    provenance_notes.extend(crate::antenna_validity::antenna_waveform_bandwidth_notes(
        problem,
    ));
    provenance_notes
        .push(crate::antenna_validity::antenna_waveform_bandwidth_aggregate_note(problem));
    provenance_notes.extend(crate::antenna_validity::antenna_validity_notes(problem));

    Ok(AntennaFieldSolveExecutionPlan::FieldBasis(
        AntennaFieldSolvePlanIR {
            schema_version: ANTENNA_FIELD_SOLVE_PLAN_SCHEMA_VERSION.into(),
            stage_id: stage_id.into(),
            port_mode_id: port_mode_id.into(),
            source_object_id: stage.source_object_id.clone(),
            solution_id,
            common: CommonPlanMeta {
                ir_version: IR_VERSION.into(),
                requested_backend: problem.backend_policy.requested_backend,
                resolved_backend: BackendTarget::Fem,
                execution_mode: problem.validation_profile.execution_mode,
                material_field_plans: Vec::new(),
            },
            conductor,
            field_sampling,
            target_refs: stage.target_refs.clone(),
            provenance: ProvenancePlanIR {
                notes: provenance_notes,
                integrator_resolution: None,
                physics_graph: None,
                fem_eigen_execution_resolution: None,
            },
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::{
        direct_oersted_known_target_buffer_bytes, preflight_direct_oersted_pair_budget,
        require_tetrahedral_field_sampling_mesh,
    };
    use fullmag_ir::{
        FemCellTypeIR, FemConnectivityIR, MeshIR, ANTENNA_DIRECT_OERSTED_BUDGET_POLICY_V1,
        ANTENNA_DIRECT_OERSTED_MAX_SOURCE_TARGET_PAIRS,
    };

    #[test]
    fn direct_oersted_preflight_accepts_the_versioned_boundary() {
        assert_eq!(
            preflight_direct_oersted_pair_budget(1_000, 1_000).unwrap(),
            ANTENNA_DIRECT_OERSTED_MAX_SOURCE_TARGET_PAIRS
        );
    }

    #[test]
    fn direct_oersted_preflight_reports_known_concurrent_target_buffers() {
        assert_eq!(
            direct_oersted_known_target_buffer_bytes(1_000).unwrap(),
            96_000
        );
        if usize::BITS == 64 {
            assert!(direct_oersted_known_target_buffer_bytes(usize::MAX)
                .unwrap_err()
                .reasons
                .iter()
                .any(|reason| reason.contains("byte count overflows")));
        }
    }

    #[test]
    fn direct_oersted_preflight_rejects_pair_budget_before_execution() {
        let error = preflight_direct_oersted_pair_budget(1_000, 1_001).unwrap_err();
        let message = error.reasons.join("; ");
        assert!(message.contains(ANTENNA_DIRECT_OERSTED_BUDGET_POLICY_V1));
        assert!(message.contains("1001000 source-target pairs"));
        assert!(message.contains("1000 source tetrahedra x 1001 target points"));
    }

    #[test]
    fn direct_oersted_preflight_rejects_pair_count_overflow() {
        let error = preflight_direct_oersted_pair_budget(usize::MAX, 2).unwrap_err();
        assert!(error
            .reasons
            .iter()
            .any(|reason| reason.contains("pair count overflows")));
    }

    #[test]
    fn direct_oersted_preflight_rejects_empty_source_or_target() {
        for (sources, targets) in [(0, usize::MAX), (1, 0)] {
            let error = preflight_direct_oersted_pair_budget(sources, targets).unwrap_err();
            assert!(error
                .reasons
                .join("; ")
                .contains("nonempty source tetrahedra and target points"));
        }
    }

    #[test]
    fn field_sampling_topology_rejects_empty_carrier() {
        let error = require_tetrahedral_field_sampling_mesh(&MeshIR::default(), "test-carrier")
            .expect_err("empty field-sampling topology must fail closed");
        assert!(error
            .reasons
            .iter()
            .any(|reason| reason.contains("has no cells")));
    }

    #[test]
    fn field_sampling_topology_rejects_mixed_cells() {
        let mut mesh = MeshIR {
            cells: FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
            ..MeshIR::default()
        };
        mesh.cells.types[0] = FemCellTypeIR::Hex8;
        let error = require_tetrahedral_field_sampling_mesh(&mesh, "test-carrier")
            .expect_err("mixed field-sampling topology must fail closed");
        let message = error.reasons.join("; ");
        assert!(message.contains("unsupported antenna field-sampling topology"));
        assert!(message.contains("cannot be downgraded to identity sampling"));
    }

    #[test]
    fn field_sampling_topology_accepts_non_empty_tet4_carrier() {
        let mesh = MeshIR {
            cells: FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
            ..MeshIR::default()
        };
        require_tetrahedral_field_sampling_mesh(&mesh, "test-carrier")
            .expect("tet4 field-sampling topology should be accepted");
    }
}
