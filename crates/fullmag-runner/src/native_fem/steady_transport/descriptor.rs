use super::{
    NativeFemSteadyTransportConstitutiveModel, NativeFemSteadyTransportExecution,
    NativeFemSteadyTransportGauge, NativeFemSteadyTransportInterface,
    NativeFemSteadyTransportRequest, CONSTITUTIVE_VERSION, M2_CONSTITUTIVE_VERSION,
    M2_OPERATOR_VERSION, OPERATOR_VERSION, PHYSICAL_RESIDUAL_VERSION,
};
use crate::types::{RunError, TransportExecutionProvenance};
use fullmag_ir::{
    ConservativeCurrentBoundaryRoleIR, ConservativeCurrentClosureIR, CurrentModuleIR, FemPlanIR,
    ResolvedFemConservativeCurrentViewIR, ResolvedSpinTransportPlanIR,
};
use std::collections::BTreeSet;

pub(super) struct PreparedTransportPlan<'a> {
    pub resolved: &'a ResolvedSpinTransportPlanIR,
    pub request: NativeFemSteadyTransportRequest,
    pub provenance: TransportExecutionProvenance,
}

pub(super) fn preflight_transport_plans(
    plan: &FemPlanIR,
) -> Result<Vec<PreparedTransportPlan<'_>>, RunError> {
    if plan.spin_transport_plans.len() > 1 {
        return Err(RunError {
            message: "FEM M1 steady transport supports exactly one module because v2 field resource identity is quantity-scoped; refusing artifact overwrite".into(),
        });
    }
    if plan
        .mfem_device_string
        .as_deref()
        .is_some_and(|device| device != "cpu")
    {
        return Err(RunError {
            message: "FEM M1 steady transport resolved CPU but the enclosing plan requests a non-CPU MFEM device; refusing hidden fallback before provenance".into(),
        });
    }
    let mut module_ids = BTreeSet::new();
    let mut source_ids = BTreeSet::new();
    let mut prepared = Vec::with_capacity(plan.spin_transport_plans.len());
    for resolved in &plan.spin_transport_plans {
        if !module_ids.insert(resolved.module_id.as_str()) {
            return Err(RunError {
                message: format!(
                    "duplicate FEM spin transport module id '{}' fails whole-plan preflight",
                    resolved.module_id
                ),
            });
        }
        if !source_ids.insert(resolved.current_source_id.as_str()) {
            return Err(RunError {
                message: format!(
                    "FEM spin transport current source '{}' is bound more than once",
                    resolved.current_source_id
                ),
            });
        }
        validate_bound_current_source_modules(&plan.current_modules, resolved)?;
        if let Some(view) = resolved
            .fem_cpu_double
            .as_ref()
            .and_then(|descriptor| descriptor.conservative_current_view.as_ref())
        {
            validate_conservative_current_view_descriptor(&plan.mesh, view, &resolved.module_id)?;
        }
        let request = materialize_native_fem_steady_transport_request(
            &plan.mesh,
            &plan.initial_magnetization,
            resolved,
        )?;
        let mut native_preflight_request = request.clone();
        if resolved
            .fem_cpu_double
            .as_ref()
            .and_then(|descriptor| descriptor.conservative_current_view.as_ref())
            .is_some_and(|view| {
                matches!(
                    &view.closure,
                    fullmag_ir::ConservativeCurrentClosureIR::ClosedGeometry { .. }
                )
            })
        {
            native_preflight_request.mesh.periodic_boundary_pairs.clear();
            native_preflight_request.mesh.periodic_node_pairs.clear();
        }
        super::preflight(&native_preflight_request)?;
        let provenance = super::provenance::transport_provenance(resolved)?;
        prepared.push(PreparedTransportPlan {
            resolved,
            request,
            provenance,
        });
    }
    Ok(prepared)
}

fn require_rt0_text(value: &str, label: &str) -> Result<(), RunError> {
    if value.trim().is_empty() {
        return Err(RunError {
            message: format!("FEM RT0 {label} must not be empty"),
        });
    }
    Ok(())
}

pub(super) fn validate_conservative_current_view_descriptor(
    mesh: &fullmag_ir::MeshIR,
    view: &ResolvedFemConservativeCurrentViewIR,
    module_id: &str,
) -> Result<(), RunError> {
    if view.stable_vertex_ids.len() != mesh.nodes.len()
        || view.stable_vertex_ids.iter().any(|id| *id == 0)
        || view
            .stable_vertex_ids
            .iter()
            .collect::<BTreeSet<_>>()
            .len()
            != view.stable_vertex_ids.len()
    {
        return Err(RunError {
            message: format!(
                "FEM RT0 module '{}' has invalid stable vertex identities",
                module_id
            ),
        });
    }
    let expected_boundary_faces = mesh
        .facets
        .roles
        .iter()
        .filter(|role| {
            matches!(
                role,
                fullmag_ir::FemFacetRoleIR::Exterior
                    | fullmag_ir::FemFacetRoleIR::PeriodicSeam
            )
        })
        .count();
    if view.boundary_faces.len() != expected_boundary_faces {
        return Err(RunError {
            message: format!(
                "FEM RT0 module '{}' boundary classification has {} records, expected {}",
                module_id,
                view.boundary_faces.len(),
                expected_boundary_faces
            ),
        });
    }
    let mut boundary_keys = BTreeSet::new();
    for face in &view.boundary_faces {
        if face.face_vertex_ids[0] == 0
            || face.face_vertex_ids[0] >= face.face_vertex_ids[1]
            || face.face_vertex_ids[1] >= face.face_vertex_ids[2]
            || !boundary_keys.insert(face.face_vertex_ids)
        {
            return Err(RunError {
                message: format!(
                    "FEM RT0 module '{}' has duplicate or non-canonical boundary face IDs",
                    module_id
                ),
            });
        }
        match face.role {
            ConservativeCurrentBoundaryRoleIR::InsulatingOuter => {
                if face.circuit_id.is_some() {
                    return Err(RunError {
                        message: format!(
                            "FEM RT0 module '{}' insulating face carries circuit_id",
                            module_id
                        ),
                    });
                }
            }
            ConservativeCurrentBoundaryRoleIR::SourceCut
            | ConservativeCurrentBoundaryRoleIR::ClosureInterface => {
                require_rt0_text(
                    face.circuit_id.as_deref().unwrap_or_default(),
                    "boundary circuit_id",
                )?;
            }
        }
    }
    for (label, value) in [
        ("source_module_id", &view.identity.source_module_id),
        ("source_state_revision", &view.identity.source_state_revision),
        ("source_field_digest", &view.identity.source_field_digest),
        ("conductivity_digest", &view.identity.conductivity_digest),
        ("mesh_revision", &view.identity.mesh_revision),
        ("topology_revision", &view.identity.topology_revision),
        ("geometry_digest", &view.identity.geometry_digest),
        ("envelope_revision", &view.identity.envelope_revision),
        ("envelope_digest", &view.identity.envelope_digest),
        (
            "required_source_state_revision",
            &view.pins.required_source_state_revision,
        ),
        (
            "required_source_field_digest",
            &view.pins.required_source_field_digest,
        ),
        ("required_mesh_revision", &view.pins.required_mesh_revision),
        (
            "required_topology_revision",
            &view.pins.required_topology_revision,
        ),
    ] {
        require_rt0_text(value, label)?;
    }
    if !view.identity.evaluated_envelope_multiplier.is_finite()
        || !view.identity.evaluation_time_s.is_finite()
        || !view.algebraic_relative_tolerance.is_finite()
        || view.algebraic_relative_tolerance <= 0.0
        || !view.physical_relative_gate.is_finite()
        || view.physical_relative_gate <= 0.0
        || !view.physical_absolute_gate_a.is_finite()
        || view.physical_absolute_gate_a <= 0.0
    {
        return Err(RunError {
            message: format!(
                "FEM RT0 module '{}' has invalid identity or physical gates",
                module_id
            ),
        });
    }
    match &view.closure {
        ConservativeCurrentClosureIR::ClosedGeometry {
            operator_version,
            revision,
            digest,
            source_cuts,
        } => {
            require_rt0_text(operator_version, "closed-geometry operator_version")?;
            require_rt0_text(revision, "closed-geometry revision")?;
            require_rt0_text(digest, "closed-geometry digest")?;
            if source_cuts.is_empty()
                || source_cuts.iter().any(|cut| {
                    cut.id.trim().is_empty()
                        || cut.face_pairs.is_empty()
                        || !cut.potential_drop_v.is_finite()
                        || cut.translation_m.iter().all(|value| *value == 0.0)
                })
            {
                return Err(RunError {
                    message: format!(
                        "FEM RT0 module '{}' has incomplete closed-geometry source-cut closure",
                        module_id
                    ),
                });
            }
        }
        ConservativeCurrentClosureIR::ExternalLead {
            operator_version,
            revision,
            digest,
            drive_id,
            outer_electrode_potential_drop_v,
            lead_mesh,
            lead_conductivity_spm_per_element,
            lead_stable_vertex_ids,
            interface_pairs,
            minus_outer_electrode_face_vertex_ids,
            plus_outer_electrode_face_vertex_ids,
            lead_conductivity_digest,
        } => {
            for (label, value) in [
                ("external-lead operator_version", operator_version),
                ("external-lead revision", revision),
                ("external-lead digest", digest),
                ("external-lead drive_id", drive_id),
                ("external-lead conductivity_digest", lead_conductivity_digest),
            ] {
                require_rt0_text(value, label)?;
            }
            if !outer_electrode_potential_drop_v.is_finite()
                || *outer_electrode_potential_drop_v == 0.0
                || lead_stable_vertex_ids.len() != lead_mesh.nodes.len()
                || lead_conductivity_spm_per_element.len() != lead_mesh.cell_count()
                || lead_conductivity_spm_per_element
                    .iter()
                    .any(|value| !value.is_finite() || *value <= 0.0)
                || interface_pairs.is_empty()
                || minus_outer_electrode_face_vertex_ids.is_empty()
                || plus_outer_electrode_face_vertex_ids.is_empty()
            {
                return Err(RunError {
                    message: format!(
                        "FEM RT0 module '{}' has incomplete external-lead closure",
                        module_id
                    ),
                });
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod rt0_descriptor_tests {
    use super::*;
    use fullmag_ir::{
        ConservativeCurrentBoundaryFaceIR, ConservativeCurrentIdentityIR,
        ConservativeCurrentPinsIR,
        ConservativeCurrentSourceCutFacePairIR, ConservativeCurrentSourceCutIR,
        FemFacetRoleIR, MeshIR,
    };

    fn mesh() -> MeshIR {
        MeshIR::from_legacy_tet4(
            "rt0".into(),
            vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ],
            vec![[0, 1, 2, 3]],
            vec![1],
            vec![[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]],
            vec![1, 1, 1, 1],
            vec![],
            vec![],
            std::collections::HashMap::new(),
        )
    }

    fn valid_view() -> ResolvedFemConservativeCurrentViewIR {
        ResolvedFemConservativeCurrentViewIR {
            stable_vertex_ids: vec![10, 20, 30, 40],
            boundary_faces: vec![
                [10, 20, 30],
                [10, 20, 40],
                [10, 30, 40],
                [20, 30, 40],
            ]
            .into_iter()
            .map(|face_vertex_ids| ConservativeCurrentBoundaryFaceIR {
                face_vertex_ids,
                role: ConservativeCurrentBoundaryRoleIR::InsulatingOuter,
                circuit_id: None,
            })
            .collect(),
            identity: ConservativeCurrentIdentityIR {
                source_module_id: "charge".into(),
                source_state_revision: "state-1".into(),
                source_field_digest: "sha256:field".into(),
                conductivity_digest: "sha256:sigma".into(),
                mesh_revision: "mesh-1".into(),
                topology_revision: "topology-1".into(),
                geometry_digest: "sha256:geometry".into(),
                envelope_revision: "env-1".into(),
                envelope_digest: "sha256:env".into(),
                evaluated_envelope_multiplier: 1.0,
                evaluation_time_s: 0.0,
                stage_identity: 1,
            },
            pins: ConservativeCurrentPinsIR {
                required_source_state_revision: "state-1".into(),
                required_source_field_digest: "sha256:field".into(),
                required_mesh_revision: "mesh-1".into(),
                required_topology_revision: "topology-1".into(),
            },
            closure: ConservativeCurrentClosureIR::ClosedGeometry {
                operator_version: "fem_closed_current_geometry.v1".into(),
                revision: "closure-1".into(),
                digest: "sha256:closure".into(),
                source_cuts: vec![ConservativeCurrentSourceCutIR {
                    id: "cut".into(),
                    translation_m: [1.0, 0.0, 0.0],
                    potential_drop_v: 1.0,
                    face_pairs: vec![ConservativeCurrentSourceCutFacePairIR {
                        minus_face_vertex_ids: [10, 20, 30],
                        plus_face_vertex_ids: [10, 20, 40],
                    }],
                }],
            },
            algebraic_relative_tolerance: 1.0e-10,
            physical_relative_gate: 1.0e-8,
            physical_absolute_gate_a: 1.0e-12,
            reference_mpi_gather_broadcast: false,
        }
    }

    #[test]
    fn complete_rt0_descriptor_is_accepted_before_native_call() {
        let mesh = mesh();
        validate_conservative_current_view_descriptor(&mesh, &valid_view(), "module")
            .expect("complete RT0 descriptor should pass planner preflight");
    }

    #[test]
    fn missing_stable_vertex_identity_is_rejected_before_native_call() {
        let mesh = mesh();
        let mut view = valid_view();
        view.stable_vertex_ids[0] = 20;
        let error = validate_conservative_current_view_descriptor(&mesh, &view, "module")
            .expect_err("duplicate stable identity must fail closed");
        assert!(error.message.contains("stable vertex identities"));
    }

    #[test]
    fn non_boundary_facet_roles_are_not_accepted_as_rt0_boundary_records() {
        let mut mesh = mesh();
        mesh.facets.roles[0] = FemFacetRoleIR::MaterialInterface;
        let error = validate_conservative_current_view_descriptor(&mesh, &valid_view(), "module")
            .expect_err("boundary record cardinality must match exterior/seam topology");
        assert!(error.message.contains("boundary classification"));
    }
}

pub(super) fn validate_bound_current_source_modules(
    current_modules: &[CurrentModuleIR],
    resolved: &ResolvedSpinTransportPlanIR,
) -> Result<(), RunError> {
    let matches = current_modules
        .iter()
        .filter_map(|source| match source {
            CurrentModuleIR::CurrentTransport {
                name,
                model,
                current_density,
                solve_region,
                conductivity_s_per_m,
                coupling,
                definition,
            } if name == &resolved.current_source_id => Some((
                model,
                current_density,
                solve_region,
                conductivity_s_per_m,
                coupling,
                definition,
            )),
            _ => None,
        })
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return Err(RunError {
            message: format!(
                "FEM spin transport '{}' requires exactly one canonical current source '{}', found {}",
                resolved.module_id,
                resolved.current_source_id,
                matches.len()
            ),
        });
    }
    let (model, current_density, solve_region, conductivity, coupling, definition) = matches[0];
    let descriptor = resolved.fem_cpu_double.as_ref().ok_or_else(|| RunError {
        message: format!(
            "FEM spin transport '{}' lacks fem_cpu_double descriptor",
            resolved.module_id
        ),
    })?;
    let reciprocal = resolved.resolved_coupling == fullmag_ir::TransportCouplingIR::Bidirectional;
    let expected_model = if reciprocal {
        fullmag_ir::CurrentTransportModelIR::MagnetoresistivePoisson
    } else {
        fullmag_ir::CurrentTransportModelIR::OhmicPoisson
    };
    if *model != expected_model
        || *coupling != resolved.resolved_coupling
        || current_density.is_some()
        || solve_region.is_some()
        || conductivity.is_some()
        || definition.as_ref() != Some(&descriptor.charge_definition)
    {
        return Err(RunError {
            message: format!(
                "FEM spin transport '{}' canonical current source '{}' contradicts its resolved descriptor",
                resolved.module_id, resolved.current_source_id
            ),
        });
    }
    Ok(())
}

pub(super) fn materialize_native_fem_steady_transport_request(
    mesh: &fullmag_ir::MeshIR,
    initial_magnetization: &[[f64; 3]],
    resolved: &ResolvedSpinTransportPlanIR,
) -> Result<NativeFemSteadyTransportRequest, RunError> {
    let descriptor = resolved.fem_cpu_double.as_ref().ok_or_else(|| RunError {
        message: format!(
            "FEM spin transport '{}' lacks fem_cpu_double descriptor",
            resolved.module_id
        ),
    })?;
    if resolved_fem_descriptor_contradiction(mesh, resolved, descriptor) {
        return Err(RunError {
            message: format!(
                "FEM spin transport '{}' has an unsupported or contradictory resolved descriptor",
                resolved.module_id
            ),
        });
    }
    let reciprocal = resolved.resolved_coupling == fullmag_ir::TransportCouplingIR::Bidirectional;
    let (constitutive_model, constitutive_version, operator_version) = if reciprocal {
        (
            NativeFemSteadyTransportConstitutiveModel::ReciprocalM2,
            M2_CONSTITUTIVE_VERSION,
            M2_OPERATOR_VERSION,
        )
    } else {
        (
            NativeFemSteadyTransportConstitutiveModel::OneWay,
            CONSTITUTIVE_VERSION,
            OPERATOR_VERSION,
        )
    };
    let reciprocal_material = descriptor.reciprocal_material.as_ref();
    Ok(NativeFemSteadyTransportRequest {
        mesh: mesh.clone(),
        execution: NativeFemSteadyTransportExecution::CpuDouble,
        interface: NativeFemSteadyTransportInterface::TransparentConformingH1,
        gauge: match descriptor.charge_gauge {
            fullmag_ir::ChargePotentialGaugeIR::DirichletReference => {
                NativeFemSteadyTransportGauge::BoundaryReference
            }
            fullmag_ir::ChargePotentialGaugeIR::ZeroMean => {
                NativeFemSteadyTransportGauge::ZeroMeanPotential
            }
        },
        constitutive_model,
        constitutive_version: constitutive_version.to_string(),
        operator_version: operator_version.to_string(),
        physical_residual_version: resolved.physical_residual_version.clone(),
        charge_conductivity_spm_per_element: descriptor.charge_conductivity_spm_per_element.clone(),
        magnetization: initial_magnetization.to_vec(),
        sigma_s_spm: descriptor.sigma_s_spm,
        sigma_parallel_spm: reciprocal_material.map(|material| material.sigma_parallel_spm),
        sigma_perpendicular_spm:
            reciprocal_material.map(|material| material.sigma_perpendicular_spm),
        sigma_ahe_spm: reciprocal_material.map(|material| material.sigma_ahe_spm),
        polarization_p: descriptor.polarization_p,
        theta_sh: descriptor.theta_sh,
        lambda_sf_m: descriptor.lambda_sf_m,
        lambda_j_m: descriptor.lambda_j_m,
        lambda_phi_m: descriptor.lambda_phi_m,
        gamma_e_per_ts: descriptor.gamma_e_rad_per_s_t,
        saturation_magnetization_apm: descriptor.saturation_magnetization_apm,
        relative_tolerance: descriptor.charge_solver.linear.relative_tolerance,
        absolute_tolerance: descriptor.charge_solver.linear.absolute_tolerance,
        maximum_iterations: descriptor.charge_solver.linear.max_iterations,
        charge_dirichlet: descriptor.charge_dirichlet.clone(),
        spin_dirichlet: descriptor.spin_dirichlet.clone(),
    })
}

fn resolved_fem_descriptor_contradiction(
    mesh: &fullmag_ir::MeshIR,
    resolved: &ResolvedSpinTransportPlanIR,
    descriptor: &fullmag_ir::ResolvedFemSpinTransportIR,
) -> bool {
    let reciprocal = resolved.resolved_coupling == fullmag_ir::TransportCouplingIR::Bidirectional;
    let expected_capabilities = if reciprocal {
        BTreeSet::from([
            "transport.charge.magnetoresistive",
            "transport.spin.steady_drift_diffusion",
            "transport.spin.direct_she",
            "transport.spin.inverse_she",
            "transport.coupling.bidirectional",
        ])
    } else {
        BTreeSet::from([
            "transport.charge.ohmic",
            "transport.spin.steady_drift_diffusion",
            "transport.spin.direct_she",
            "transport.coupling.one_way",
        ])
    };
    let expected_constitutive = if reciprocal {
        M2_CONSTITUTIVE_VERSION
    } else {
        CONSTITUTIVE_VERSION
    };
    let expected_operator = if reciprocal {
        M2_OPERATOR_VERSION
    } else {
        OPERATOR_VERSION
    };
    let expected_charge_operator = if reciprocal {
        M2_OPERATOR_VERSION
    } else {
        "fem_charge_conforming_h1_p1.transparent.v1"
    };
    let expected_schema = if reciprocal {
        "fullmag.fem.spin_transport_descriptor.m2.v1"
    } else {
        "fullmag.fem.spin_transport_descriptor.v1"
    };
    let expected_charge_engine = if reciprocal { "gmres" } else { "cg" };
    let expected_charge_solver_engine = if reciprocal {
        matches!(descriptor.charge_solver.engine.as_str(), "auto" | "block_gmres")
    } else {
        matches!(descriptor.charge_solver.engine.as_str(), "auto" | "cg")
    };
    let reciprocal_material_valid = match (reciprocal, descriptor.reciprocal_material.as_ref()) {
        (false, None) => true,
        (true, Some(material)) => {
            material.sigma_spm.is_finite()
                && material.sigma_spm > 0.0
                && material.sigma_spin_spm == descriptor.sigma_s_spm
                && material.polarization_p == descriptor.polarization_p
                && material.theta_sh == descriptor.theta_sh
                && material.sigma_parallel_spm.is_finite()
                && material.sigma_parallel_spm > 0.0
                && material.sigma_perpendicular_spm.is_finite()
                && material.sigma_perpendicular_spm > 0.0
                && material.sigma_ahe_spm.is_finite()
                && material.sigma_parallel_spm.min(material.sigma_perpendicular_spm)
                    * material.sigma_spin_spm
                    - material.polarization_p.powi(2) * material.sigma_spm.powi(2)
                    > 0.0
        }
        _ => false,
    };
    let capabilities = resolved
        .capabilities
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    resolved.fdm_cpu_double.is_some()
        || resolved.fdm_cpu_double_reciprocal.is_some()
        || resolved.requested_execution.execution_mode != fullmag_ir::ExecutionMode::Strict
        || !matches!(
            resolved.requested_execution.discretization,
            fullmag_ir::BackendTarget::Fem | fullmag_ir::BackendTarget::Auto
        )
        || !matches!(
            resolved.requested_execution.device,
            fullmag_ir::ExecutionDevice::Cpu | fullmag_ir::ExecutionDevice::Auto
        )
        || resolved.requested_execution.precision != fullmag_ir::ExecutionPrecision::Double
        || resolved.resolved_discretization != fullmag_ir::BackendTarget::Fem
        || resolved.resolved_device != fullmag_ir::ExecutionDevice::Cpu
        || resolved.resolved_precision != fullmag_ir::ExecutionPrecision::Double
        || resolved.constitutive_version != expected_constitutive
        || resolved.operator_version != expected_operator
        || resolved.physical_residual_version != PHYSICAL_RESIDUAL_VERSION
        || descriptor.descriptor_schema != expected_schema
        || descriptor.charge_definition.gauge != descriptor.charge_gauge
        || descriptor.charge_definition.solver != descriptor.charge_solver
        || descriptor.charge_definition.domain != descriptor.charge_domain.regions
        || descriptor.charge_conductivity_spm_per_element.len() != mesh.cell_count()
        || descriptor.charge_domain.element_mask.len() != mesh.cell_count()
        || descriptor.spin_domain.element_mask.len() != mesh.cell_count()
        || descriptor
            .charge_domain
            .element_mask
            .iter()
            .any(|selected| !selected)
        || descriptor
            .spin_domain
            .element_mask
            .iter()
            .any(|selected| !selected)
        || descriptor.torque_target.as_ref().is_some_and(|target| {
            target.element_mask.len() != mesh.cell_count()
                || !target.element_mask.iter().any(|selected| *selected)
        })
        || transport_boundary_attributes(descriptor)
            .any(|attribute| attribute == 0 || !mesh.boundary_markers.contains(&attribute))
        || descriptor.charge_solver.operator_version != expected_charge_operator
        || descriptor.charge_solver.physical_residual_version
            != if reciprocal {
                PHYSICAL_RESIDUAL_VERSION
            } else {
                "charge_balance_integrated_l2.v1"
            }
        || descriptor.spin_solver.operator_version != resolved.operator_version
        || descriptor.spin_solver.physical_residual_version != resolved.physical_residual_version
        || descriptor.charge_solver.linear != descriptor.spin_solver.linear
        || descriptor.charge_solver.linear.absolute_tolerance != 0.0
        || !expected_charge_solver_engine
        || !matches!(descriptor.spin_solver.engine.as_str(), "auto" | "gmres")
        || descriptor.resolved_charge_engine != expected_charge_engine
        || descriptor.resolved_spin_engine != "gmres"
        || descriptor.interface_law != "transparent"
        || descriptor
            .interfaces
            .iter()
            .any(|interface| interface.law != "transparent" || reciprocal)
        || descriptor.interface_realization != "transparent_conforming_h1"
        || descriptor.stage_coupling != "none"
        || descriptor.capability_status != "reference_executable"
        || descriptor.implementation_state != "executable"
        || descriptor.validation_state != "algebra_validated"
        || descriptor.validation_scope
            != if reciprocal {
                "fem_cpu_double_conforming_h1_p1_reciprocal_m2"
            } else {
                "fem_cpu_double_conforming_h1_p1_transparent_m1"
            }
        || (reciprocal && descriptor.spin_solver.reciprocal_nonlinear.is_some())
        || !reciprocal_material_valid
        || capabilities != expected_capabilities
}

fn transport_boundary_attributes(
    descriptor: &fullmag_ir::ResolvedFemSpinTransportIR,
) -> impl Iterator<Item = u32> + '_ {
    descriptor
        .charge_insulating_boundaries
        .iter()
        .chain(&descriptor.spin_insulating_boundaries)
        .flat_map(|set| set.boundary_attributes.iter().copied())
        .chain(
            descriptor
                .charge_dirichlet
                .iter()
                .map(|(attribute, _)| *attribute),
        )
        .chain(
            descriptor
                .spin_dirichlet
                .iter()
                .map(|(attribute, _)| *attribute),
        )
}
