//! FEM periodic-boundary capability decisions before runtime execution.

use fullmag_ir::{
    BackendPlanIR, BackendTarget, ExecutionMode, ExecutionPlanIR, ExecutionPrecision, FemPlanIR,
};

pub const ACCEPTED_FEM_STATIC_PBC_NATIVE_ATTESTATION_SCHEMA: &str =
    "fullmag.accepted_fem_static_pbc_native_attestation.v1";

/// Native static-PBC lane admitted by the accepted FEM worker.
///
/// This is intentionally narrower than [`FemStaticPbcLane`]: the reference
/// reduction and unsupported lanes must never cross the accepted-worker
/// boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcceptedFemStaticPbcNativeLane {
    NativeExchangeOnly,
    NativeAnisotropy,
    NativeDemagPoisson,
}

/// Immutable evidence that one exact execution plan passed the accepted FEM
/// native static-PBC admission contract.
#[derive(Debug, Clone, PartialEq)]
pub struct AcceptedFemStaticPbcNativeAttestation {
    pub schema_version: &'static str,
    pub lane: AcceptedFemStaticPbcNativeLane,
    pub resolved_device: String,
    pub mesh_topology_fingerprint: String,
    pub periodic_node_pair_count: usize,
    pub periodic_mesh_certificate: fullmag_ir::PeriodicMeshCertificateV6IR,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FemStaticPbcLane {
    /// No periodic node pairs; native path unconditionally.
    None,
    /// Exchange + uniform Zeeman only. Native FEM PBC is fully supported.
    NativeExchangeOnly,
    /// Exchange + local uniaxial/cubic anisotropy or DMI without demag.
    NativeAnisotropy,
    /// Exchange + demag via algebraic P^T A P reduction in MFEM/hypre Poisson.
    NativeDemagPoisson,
    /// DMI fallback through the Rust CPU reference solver.
    #[allow(dead_code)]
    ReferenceReduction,
    /// Terms that cannot be handled by any available periodic path.
    Unsupported,
}

/// Result of the FEM static PBC capability decision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FemStaticPbcDecision {
    pub lane: FemStaticPbcLane,
    /// Human-readable explanation for the chosen lane.
    pub reason: Option<String>,
    /// Interactions that could not be accommodated by the native path.
    pub unsupported_interactions: Vec<String>,
}

impl FemStaticPbcDecision {
    fn native(lane: FemStaticPbcLane) -> Self {
        Self {
            lane,
            reason: None,
            unsupported_interactions: Vec::new(),
        }
    }

    #[allow(dead_code)]
    fn reference_reduction(reason: impl Into<String>) -> Self {
        Self {
            lane: FemStaticPbcLane::ReferenceReduction,
            reason: Some(reason.into()),
            unsupported_interactions: Vec::new(),
        }
    }

    fn unsupported(reason: impl Into<String>, interactions: Vec<String>) -> Self {
        Self {
            lane: FemStaticPbcLane::Unsupported,
            reason: Some(reason.into()),
            unsupported_interactions: interactions,
        }
    }

    /// Returns `true` if the native FEM backend can execute this plan.
    pub(crate) fn is_native(&self) -> bool {
        matches!(
            self.lane,
            FemStaticPbcLane::None
                | FemStaticPbcLane::NativeExchangeOnly
                | FemStaticPbcLane::NativeAnisotropy
                | FemStaticPbcLane::NativeDemagPoisson
        )
    }
}

/// Decide which execution lane to use for a FEM plan that may carry
/// static/time-domain periodic node pairs.
pub(crate) fn fem_static_periodic_decision(plan: &FemPlanIR) -> FemStaticPbcDecision {
    if plan.mesh.periodic_node_pairs.is_empty() {
        return FemStaticPbcDecision::native(FemStaticPbcLane::None);
    }

    let mut unsupported = Vec::new();
    if plan.temperature.unwrap_or(0.0) > 0.0 {
        unsupported.push("thermal_noise".to_string());
    }
    if plan.current_density.is_some() || plan.stt_spin_polarization.is_some() {
        unsupported.push("stt".to_string());
    }
    if plan.has_oersted_cylinder
        || plan
            .oersted_field_xyz
            .as_ref()
            .is_some_and(|v| !v.is_empty())
    {
        unsupported.push("oersted".to_string());
    }
    if plan.magnetoelastic.is_some() {
        unsupported.push("magnetoelastic".to_string());
    }
    if !unsupported.is_empty() {
        return FemStaticPbcDecision::unsupported(
            format!(
                "FEM static/time-domain PBC does not support: {}. \
                 These terms require non-periodic boundary conditions or \
                 non-local operators that have no algebraic periodic reduction.",
                unsupported.join(", ")
            ),
            unsupported,
        );
    }

    let has_demag = plan.enable_demag;
    let has_dmi = plan.interfacial_dmi.is_some()
        || plan.bulk_dmi.is_some()
        || plan.dind_field.as_ref().is_some_and(|v| !v.is_empty())
        || plan.dbulk_field.as_ref().is_some_and(|v| !v.is_empty());

    if has_dmi && has_demag {
        return FemStaticPbcDecision::native(FemStaticPbcLane::NativeDemagPoisson);
    }
    if has_dmi {
        return FemStaticPbcDecision::native(FemStaticPbcLane::NativeAnisotropy);
    }
    if has_demag {
        return FemStaticPbcDecision::native(FemStaticPbcLane::NativeDemagPoisson);
    }

    let has_anisotropy = plan.material.uniaxial_anisotropy.is_some()
        || plan.material.uniaxial_anisotropy_k2.is_some()
        || plan.material.cubic_anisotropy_kc1.is_some()
        || plan.material.cubic_anisotropy_kc2.is_some()
        || plan.material.cubic_anisotropy_kc3.is_some()
        || plan
            .material
            .ku_field
            .as_ref()
            .is_some_and(|v| !v.is_empty())
        || plan
            .material
            .ku2_field
            .as_ref()
            .is_some_and(|v| !v.is_empty())
        || plan
            .material
            .kc1_field
            .as_ref()
            .is_some_and(|v| !v.is_empty())
        || plan
            .material
            .kc2_field
            .as_ref()
            .is_some_and(|v| !v.is_empty())
        || plan
            .material
            .kc3_field
            .as_ref()
            .is_some_and(|v| !v.is_empty());

    if has_anisotropy {
        return FemStaticPbcDecision::native(FemStaticPbcLane::NativeAnisotropy);
    }

    FemStaticPbcDecision::native(FemStaticPbcLane::NativeExchangeOnly)
}

fn accepted_fem_static_pbc_error(message: impl Into<String>) -> crate::RunError {
    crate::RunError {
        message: message.into(),
    }
}

fn accepted_native_lane(
    decision: &FemStaticPbcDecision,
) -> Result<AcceptedFemStaticPbcNativeLane, crate::RunError> {
    match &decision.lane {
        FemStaticPbcLane::NativeExchangeOnly => {
            Ok(AcceptedFemStaticPbcNativeLane::NativeExchangeOnly)
        }
        FemStaticPbcLane::NativeAnisotropy => Ok(AcceptedFemStaticPbcNativeLane::NativeAnisotropy),
        FemStaticPbcLane::NativeDemagPoisson => {
            Ok(AcceptedFemStaticPbcNativeLane::NativeDemagPoisson)
        }
        FemStaticPbcLane::None => Err(accepted_fem_static_pbc_error(
            "accepted FEM static PBC attestation requires periodic node pairs",
        )),
        FemStaticPbcLane::ReferenceReduction | FemStaticPbcLane::Unsupported => {
            let unsupported_interactions = if decision.unsupported_interactions.is_empty() {
                "none".to_string()
            } else {
                decision.unsupported_interactions.join(", ")
            };
            Err(accepted_fem_static_pbc_error(format!(
                "accepted FEM static PBC attestation rejects non-native lane {:?}: {}; unsupported interactions: {}",
                decision.lane,
                decision.reason.as_deref().unwrap_or("no native implementation"),
                unsupported_interactions,
            )))
        }
    }
}

/// Attest the native CPU static-PBC lane for one exact, receipt-bound plan.
///
/// This function is an admission gate only. It does not normalize, clone, or
/// replan the execution input, and it never selects the reference solver.
pub fn attest_accepted_fem_static_pbc(
    execution_plan: &ExecutionPlanIR,
    resolved_device: &str,
) -> Result<AcceptedFemStaticPbcNativeAttestation, crate::RunError> {
    if resolved_device != "cpu" {
        return Err(accepted_fem_static_pbc_error(format!(
            "accepted FEM static PBC native attestation requires strict CPU execution, got device '{resolved_device}'"
        )));
    }
    if execution_plan.common.requested_backend != BackendTarget::Fem
        || execution_plan.common.resolved_backend != BackendTarget::Fem
        || execution_plan.common.execution_mode != ExecutionMode::Strict
    {
        return Err(accepted_fem_static_pbc_error(format!(
            "accepted FEM static PBC native attestation requires strict FEM execution, got requested backend {:?}, resolved backend {:?}, mode {:?}",
            execution_plan.common.requested_backend,
            execution_plan.common.resolved_backend,
            execution_plan.common.execution_mode,
        )));
    }

    let BackendPlanIR::Fem(fem_plan) = &execution_plan.backend_plan else {
        return Err(accepted_fem_static_pbc_error(
            "accepted FEM static PBC native attestation requires a time-domain FEM plan",
        ));
    };
    if fem_plan.fe_order != 1 {
        return Err(accepted_fem_static_pbc_error(format!(
            "accepted FEM static PBC native attestation requires FEM H1/P1, got FE order {}",
            fem_plan.fe_order
        )));
    }
    if fem_plan.precision != ExecutionPrecision::Double {
        return Err(accepted_fem_static_pbc_error(
            "accepted FEM static PBC native attestation requires double precision",
        ));
    }
    if fem_plan.mesh.periodic_node_pairs.is_empty() {
        return Err(accepted_fem_static_pbc_error(
            "accepted FEM static PBC native attestation requires periodic node pairs",
        ));
    }

    let mesh_topology_fingerprint = fem_plan.mesh.topology_fingerprint_v6();
    let periodic_mesh_certificate = validate_periodic_region_material_certificate(fem_plan)
        .map_err(|reason| {
            accepted_fem_static_pbc_error(format!(
                "accepted FEM static PBC native attestation rejected the periodic material certificate: {reason}"
            ))
        })?
        .ok_or_else(|| {
            accepted_fem_static_pbc_error(
                "accepted FEM static PBC native attestation requires a periodic material certificate",
            )
        })?;
    if periodic_mesh_certificate.schema_version != "periodic_mesh_certificate.v6"
        || periodic_mesh_certificate.certificate_status != "accepted"
    {
        return Err(accepted_fem_static_pbc_error(format!(
            "accepted FEM static PBC native attestation requires an accepted periodic_mesh_certificate.v6, got schema '{}' with status '{}'",
            periodic_mesh_certificate.schema_version,
            periodic_mesh_certificate.certificate_status,
        )));
    }
    if periodic_mesh_certificate.topology_fingerprint != mesh_topology_fingerprint {
        return Err(accepted_fem_static_pbc_error(format!(
            "accepted FEM static PBC native attestation mesh fingerprint mismatch: certificate '{}', canonical '{}'",
            periodic_mesh_certificate.topology_fingerprint,
            mesh_topology_fingerprint,
        )));
    }

    let decision = fem_static_periodic_decision(fem_plan);
    let lane = accepted_native_lane(&decision)?;
    Ok(AcceptedFemStaticPbcNativeAttestation {
        schema_version: ACCEPTED_FEM_STATIC_PBC_NATIVE_ATTESTATION_SCHEMA,
        lane,
        resolved_device: resolved_device.to_owned(),
        mesh_topology_fingerprint,
        periodic_node_pair_count: fem_plan.mesh.periodic_node_pairs.len(),
        periodic_mesh_certificate,
    })
}

/// Revalidate mirrored region/material evidence immediately before native FEM
/// allocation.  Planning and artifact publication are not sufficient because
/// a caller may deserialize or transform a plan after planning; the native
/// lane must fail closed on the exact payload it is about to assemble.
pub(crate) fn validate_periodic_region_material_certificate(
    plan: &FemPlanIR,
) -> Result<Option<fullmag_ir::PeriodicMeshCertificateV6IR>, String> {
    if plan.mesh.periodic_node_pairs.is_empty() {
        return Ok(None);
    }
    plan.mesh
        .periodic_mesh_certificate_v6_with_material_and_nodal_fields(
            plan.ms_element_field.as_deref(),
            plan.a_element_field.as_deref(),
            plan.material.ms_field.as_deref(),
            plan.material.a_field.as_deref(),
        )
        .map(Some)
        .map_err(|errors| errors.join("; "))
}

/// Legacy helper used at call sites that only need a binary native-path answer.
#[allow(dead_code)]
pub(crate) fn fem_static_periodic_native_exchange_supported(plan: &FemPlanIR) -> bool {
    fem_static_periodic_decision(plan).is_native()
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::{
        CommonPlanMeta, ExecutionPlanIR, FdmPlanIR, FemConnectivityIR, FemFacetConnectivityIR,
        MeshIR, MeshPeriodicBoundaryPairIR, MeshPeriodicNodePairIR, OutputPlanIR, ProvenancePlanIR,
    };

    fn mirrored_periodic_mesh() -> MeshIR {
        MeshIR {
            mesh_name: "mirrored-periodic".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [1.0, 0.0, 0.0],
                [1.0, 1.0, 0.0],
                [1.0, 0.0, 1.0],
            ],
            cells: FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [3, 5, 4, 0]]),
            element_markers: vec![1, 1],
            facets: FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2], [3, 5, 4]]),
            boundary_markers: vec![10, 11],
            periodic_boundary_pairs: vec![MeshPeriodicBoundaryPairIR {
                pair_id: "x_faces".to_string(),
                source_marker: None,
                destination_marker: None,
                marker_a: 10,
                marker_b: 11,
                translation: Some([1.0, 0.0, 0.0]),
                tolerance: Some(1.0e-12),
                axis_hint: Some("x".to_string()),
                orientation: None,
                pairing_policy: None,
            }],
            periodic_node_pairs: vec![
                MeshPeriodicNodePairIR {
                    pair_id: "x_faces".to_string(),
                    node_a: 0,
                    node_b: 3,
                },
                MeshPeriodicNodePairIR {
                    pair_id: "x_faces".to_string(),
                    node_a: 1,
                    node_b: 4,
                },
                MeshPeriodicNodePairIR {
                    pair_id: "x_faces".to_string(),
                    node_a: 2,
                    node_b: 5,
                },
            ],
            per_domain_quality: Default::default(),
        }
    }

    fn periodic_execution_plan() -> ExecutionPlanIR {
        let mut fem = FemPlanIR::default();
        fem.mesh = mirrored_periodic_mesh();
        fem.fe_order = 1;
        fem.precision = ExecutionPrecision::Double;
        ExecutionPlanIR {
            common: CommonPlanMeta {
                ir_version: "test".to_string(),
                requested_backend: BackendTarget::Fem,
                resolved_backend: BackendTarget::Fem,
                execution_mode: ExecutionMode::Strict,
                material_field_plans: Vec::new(),
            },
            backend_plan: BackendPlanIR::Fem(fem),
            output_plan: OutputPlanIR {
                outputs: Vec::new(),
            },
            provenance: ProvenancePlanIR::default(),
        }
    }

    #[test]
    fn accepted_attestation_binds_cpu_lane_mesh_and_material_certificate() {
        let plan = periodic_execution_plan();
        let attestation = attest_accepted_fem_static_pbc(&plan, "cpu")
            .expect("mirrored periodic FEM plan should be admitted");
        let BackendPlanIR::Fem(fem) = &plan.backend_plan else {
            unreachable!("fixture is FEM");
        };
        assert_eq!(
            attestation.schema_version,
            ACCEPTED_FEM_STATIC_PBC_NATIVE_ATTESTATION_SCHEMA
        );
        assert_eq!(
            attestation.lane,
            AcceptedFemStaticPbcNativeLane::NativeExchangeOnly
        );
        assert_eq!(attestation.resolved_device, "cpu");
        assert_eq!(
            attestation.mesh_topology_fingerprint,
            fem.mesh.topology_fingerprint_v6()
        );
        assert_eq!(attestation.periodic_node_pair_count, 3);
        assert_eq!(
            attestation.periodic_mesh_certificate.topology_fingerprint,
            attestation.mesh_topology_fingerprint
        );
        assert!(attestation
            .periodic_mesh_certificate
            .material_realization_fingerprint
            .starts_with("sha256:"));
    }

    #[test]
    fn accepted_attestation_rejects_gpu_no_pairs_and_single_precision() {
        let plan = periodic_execution_plan();
        let gpu_error = attest_accepted_fem_static_pbc(&plan, "gpu")
            .expect_err("GPU must not cross the strict CPU attestation");
        assert!(gpu_error.message.contains("strict CPU"));

        let mut no_pairs = plan.clone();
        let BackendPlanIR::Fem(fem) = &mut no_pairs.backend_plan else {
            unreachable!("fixture is FEM");
        };
        fem.mesh.periodic_node_pairs.clear();
        let no_pairs_error = attest_accepted_fem_static_pbc(&no_pairs, "cpu")
            .expect_err("static PBC attestation requires node pairs");
        assert!(no_pairs_error.message.contains("periodic node pairs"));

        let mut single = plan;
        let BackendPlanIR::Fem(fem) = &mut single.backend_plan else {
            unreachable!("fixture is FEM");
        };
        fem.precision = ExecutionPrecision::Single;
        let precision_error = attest_accepted_fem_static_pbc(&single, "cpu")
            .expect_err("single precision must not cross the accepted lane");
        assert!(precision_error.message.contains("double precision"));
    }

    #[test]
    fn accepted_attestation_maps_native_demag_and_anisotropy_lanes() {
        let mut demag = periodic_execution_plan();
        let BackendPlanIR::Fem(fem) = &mut demag.backend_plan else {
            unreachable!("fixture is FEM");
        };
        fem.enable_demag = true;
        let demag_attestation = attest_accepted_fem_static_pbc(&demag, "cpu")
            .expect("native Poisson demag lane should be attested");
        assert_eq!(
            demag_attestation.lane,
            AcceptedFemStaticPbcNativeLane::NativeDemagPoisson
        );

        let mut anisotropy = periodic_execution_plan();
        let BackendPlanIR::Fem(fem) = &mut anisotropy.backend_plan else {
            unreachable!("fixture is FEM");
        };
        fem.material.uniaxial_anisotropy = Some(1.0);
        let anisotropy_attestation = attest_accepted_fem_static_pbc(&anisotropy, "cpu")
            .expect("native anisotropy lane should be attested");
        assert_eq!(
            anisotropy_attestation.lane,
            AcceptedFemStaticPbcNativeLane::NativeAnisotropy
        );
    }

    #[test]
    fn accepted_attestation_rejects_fdm_backend_and_non_fem_variant() {
        let mut fdm = periodic_execution_plan();
        fdm.common.resolved_backend = BackendTarget::Fdm;
        fdm.backend_plan = BackendPlanIR::Fdm(FdmPlanIR::default());
        let common_error = attest_accepted_fem_static_pbc(&fdm, "cpu")
            .expect_err("FDM must fail at the common backend guard");
        assert!(common_error.message.contains("strict FEM execution"));
        assert!(common_error.message.contains("resolved backend Fdm"));

        let mut wrong_variant = periodic_execution_plan();
        wrong_variant.backend_plan = BackendPlanIR::Fdm(FdmPlanIR::default());
        let variant_error = attest_accepted_fem_static_pbc(&wrong_variant, "cpu")
            .expect_err("non-FEM backend variants must not be attested");
        assert!(variant_error.message.contains("time-domain FEM plan"));
    }

    #[test]
    fn accepted_attestation_rejects_unsupported_interactions_and_fallback_lanes() {
        let mut unsupported = periodic_execution_plan();
        let BackendPlanIR::Fem(fem) = &mut unsupported.backend_plan else {
            unreachable!("fixture is FEM");
        };
        fem.current_density = Some([1.0, 0.0, 0.0]);
        let unsupported_error = attest_accepted_fem_static_pbc(&unsupported, "cpu")
            .expect_err("unsupported static-PBC interactions must fail closed");
        assert!(unsupported_error.message.contains("non-native lane"));
        assert!(unsupported_error.message.contains("stt"));

        let mut mismatched_material = periodic_execution_plan();
        let BackendPlanIR::Fem(fem) = &mut mismatched_material.backend_plan else {
            unreachable!("fixture is FEM");
        };
        fem.material.ms_field = Some(vec![1.0, 1.0, 1.0, 2.0, 1.0, 1.0]);
        let material_error = attest_accepted_fem_static_pbc(&mismatched_material, "cpu")
            .expect_err("periodic material seam mismatch must fail closed");
        assert!(material_error
            .message
            .contains("periodic material certificate"));

        let reference_error = accepted_native_lane(&FemStaticPbcDecision::reference_reduction(
            "reference-only reduction",
        ))
        .expect_err("reference reduction must never be accepted");
        assert!(reference_error.message.contains("ReferenceReduction"));

        let unsupported_lane = FemStaticPbcDecision::unsupported(
            "unsupported interaction",
            vec!["thermal_noise".to_string()],
        );
        let unsupported_lane_error =
            accepted_native_lane(&unsupported_lane).expect_err("unsupported lane must fail closed");
        assert!(unsupported_lane_error.message.contains("Unsupported"));
    }
}
