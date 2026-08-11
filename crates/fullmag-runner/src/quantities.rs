//! Quantity metadata — delegates to `fullmag_quantities` (the canonical crate)
//! and adds runner-specific helpers that depend on `StepStats`.

use crate::dispatch::{FdmEngine, FemEngine};
use crate::types::{RunError, StepStats};
use fullmag_ir::{FdmMaterialIR, FdmPlanIR, FemPlanIR, MaterialIR};

// ── Re-exports from the shared crate ─────────────────────────────────

pub use fullmag_quantities::{
    all_quantity_ids,
    cached_preview_quantity_ids,
    field_materialization_quantity_ids,
    interactive_preview_quantity_ids,
    quantity_catalog,
    quantity_spec,
    // catalog functions
    quantity_specs,
    quantity_unit,
    NormalizationHint,
    QuantityComponent,
    QuantityDomain,
    QuantityId,
    QuantityLocation,
    QuantityReduction,
    QuantityShape,
};

pub use fullmag_quantities::QuantitySpec;

/// Legacy alias — old code used `QuantityKind`; new canonical name is `QuantityShape`.
pub type QuantityKind = QuantityShape;

// ── Runner-specific helpers ──────────────────────────────────────────

pub fn quantity_spatial_domain(id: &str) -> &'static str {
    quantity_spec(id)
        .map(|spec| spec.domain.as_str())
        .unwrap_or(QuantityDomain::FullDomain.as_str())
}

pub fn normalize_quantity_id(requested: &str) -> Result<QuantityId, RunError> {
    fullmag_quantities::normalize_quantity_id(requested).map_err(|err| RunError {
        message: err.to_string(),
    })
}

pub fn parse_quantity_component(component: &str) -> Result<QuantityComponent, RunError> {
    QuantityComponent::parse(component).map_err(|msg| RunError { message: msg })
}

pub fn normalized_quantity_name(requested: &str) -> Result<&'static str, RunError> {
    Ok(normalize_quantity_id(requested)?.as_str())
}

pub fn global_scalar_value(id: &str, stats: &StepStats) -> Option<f64> {
    let row = stats.to_quantity_row();
    fullmag_quantities::eval_global_scalar(id, &row)
}

pub(crate) fn active_fdm_preview_quantities(
    engine: FdmEngine,
    plan: &FdmPlanIR,
    quantities: &[&str],
) -> Vec<&'static str> {
    filter_active_quantities(quantities, |id| fdm_quantity_is_active(engine, plan, id))
}

pub(crate) fn active_fem_preview_quantities(
    engine: FemEngine,
    plan: &FemPlanIR,
    quantities: &[&str],
) -> Vec<&'static str> {
    filter_active_quantities(quantities, |id| fem_quantity_is_active(engine, plan, id))
}

fn filter_active_quantities(
    quantities: &[&str],
    mut is_active: impl FnMut(QuantityId) -> bool,
) -> Vec<&'static str> {
    let mut filtered = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for quantity in quantities
        .iter()
        .filter_map(|quantity| normalize_quantity_id(quantity).ok())
    {
        if !is_active(quantity) {
            continue;
        }
        let name = quantity.as_str();
        if seen.insert(name) {
            filtered.push(name);
        }
    }
    filtered
}

fn has_values(values: &Option<Vec<f64>>) -> bool {
    values.as_ref().is_some_and(|values| !values.is_empty())
}

fn fdm_quantity_is_active(engine: FdmEngine, plan: &FdmPlanIR, id: QuantityId) -> bool {
    let engine_exposes = match engine {
        FdmEngine::CpuReference => matches!(
            id,
            QuantityId::M
                | QuantityId::HEx
                | QuantityId::HDemag
                | QuantityId::HExt
                | QuantityId::HDrive
                | QuantityId::HAnt
                | QuantityId::Torque
                | QuantityId::HAni
                | QuantityId::HDmi
                | QuantityId::HEff
                | QuantityId::EdenEx
                | QuantityId::EdenDemag
                | QuantityId::EdenExt
                | QuantityId::EdenDrive
                | QuantityId::EdenAni
                | QuantityId::EdenDmi
                | QuantityId::EdenTotal
                | QuantityId::MatMs
                | QuantityId::MatAex
                | QuantityId::MatAlpha
        ),
        FdmEngine::CudaFdm => matches!(
            id,
            QuantityId::M
                | QuantityId::HEx
                | QuantityId::HDemag
                | QuantityId::HExt
                | QuantityId::Torque
                | QuantityId::HAni
                | QuantityId::HEff
                | QuantityId::HOe
                | QuantityId::VElectric
                | QuantityId::JCharge
        ),
    };
    engine_exposes && fdm_plan_enables_quantity(plan, id)
}

fn fdm_plan_enables_quantity(plan: &FdmPlanIR, id: QuantityId) -> bool {
    match id {
        QuantityId::M | QuantityId::HEff | QuantityId::Torque => true,
        QuantityId::HEx => plan.enable_exchange,
        QuantityId::HDemag => plan.enable_demag,
        QuantityId::HExt => plan.external_field.is_some(),
        QuantityId::HDrive => !plan.field_drives.is_empty(),
        QuantityId::HOe => plan.has_oersted_cylinder || plan.oersted_field_xyz.is_some(),
        QuantityId::HAni => fdm_has_uniaxial_anisotropy(&plan.material),
        QuantityId::HAniCubic => fdm_has_cubic_anisotropy(&plan.material),
        QuantityId::HDmi => plan.interfacial_dmi.is_some(),
        QuantityId::HDmiBulk => plan.bulk_dmi.is_some(),
        QuantityId::HMel => plan.mel_b1.is_some() || plan.mel_b2.is_some(),
        QuantityId::HTherm => plan
            .temperature
            .is_some_and(|temperature| temperature > 0.0),
        QuantityId::EdenEx => plan.enable_exchange,
        QuantityId::EdenDemag => plan.enable_demag,
        QuantityId::EdenExt => plan.external_field.is_some(),
        QuantityId::EdenDrive => !plan.field_drives.is_empty(),
        QuantityId::EdenAni => {
            fdm_has_uniaxial_anisotropy(&plan.material) || fdm_has_cubic_anisotropy(&plan.material)
        }
        QuantityId::EdenDmi => plan.interfacial_dmi.is_some() || plan.bulk_dmi.is_some(),
        QuantityId::EdenTotal => true,
        QuantityId::MatMs | QuantityId::MatAex | QuantityId::MatAlpha => true,
        QuantityId::HAnt => !plan.antenna_zeeman_masks.is_empty(),
        QuantityId::VElectric | QuantityId::JCharge => !plan.fdm_gpu_charge_transports.is_empty(),
        QuantityId::U
        | QuantityId::DemagPhi
        | QuantityId::Eps
        | QuantityId::Sigma
        | QuantityId::EEx
        | QuantityId::EDemag
        | QuantityId::EExt
        | QuantityId::EDrive
        | QuantityId::EAni
        | QuantityId::EDmi
        | QuantityId::EEl
        | QuantityId::EKinEl
        | QuantityId::ETotal
        | QuantityId::ElasticResidualNorm
        | QuantityId::ModeAmplitude
        | QuantityId::ModeReal
        | QuantityId::ModeImag
        | QuantityId::ModePhase
        | QuantityId::MatDind
        | QuantityId::MatDbulk
        | QuantityId::DmDt
        | QuantityId::SpinPotential
        | QuantityId::SpinCurrentTensor
        | QuantityId::TorqueStt
        | QuantityId::TorqueSot => false,
    }
}

fn fem_quantity_is_active(engine: FemEngine, plan: &FemPlanIR, id: QuantityId) -> bool {
    let engine_exposes = match engine {
        FemEngine::CpuNative => matches!(
            id,
            QuantityId::M
                | QuantityId::HEx
                | QuantityId::HDemag
                | QuantityId::DemagPhi
                | QuantityId::HExt
                | QuantityId::HAnt
                | QuantityId::HDrive
                | QuantityId::Torque
                | QuantityId::HEff
                | QuantityId::HDmi
                | QuantityId::HDmiBulk
                | QuantityId::HTherm
                | QuantityId::EdenEx
                | QuantityId::EdenDemag
                | QuantityId::EdenExt
                | QuantityId::EdenDrive
                | QuantityId::EdenAni
                | QuantityId::EdenDmi
                | QuantityId::EdenTotal
                | QuantityId::VElectric
                | QuantityId::JCharge
                | QuantityId::SpinPotential
                | QuantityId::SpinCurrentTensor
                | QuantityId::TorqueStt
        ),
        FemEngine::NativeGpu => matches!(
            id,
            QuantityId::M
                | QuantityId::HEx
                | QuantityId::HDemag
                | QuantityId::HExt
                | QuantityId::HAnt
                | QuantityId::Torque
                | QuantityId::HEff
                | QuantityId::HAni
                | QuantityId::HDmi
                | QuantityId::HMel
                | QuantityId::HAniCubic
                | QuantityId::HDmiBulk
                | QuantityId::HOe
                | QuantityId::HTherm
                | QuantityId::EdenEx
                | QuantityId::EdenDemag
                | QuantityId::EdenExt
                | QuantityId::EdenAni
                | QuantityId::EdenDmi
                | QuantityId::EdenTotal
        ),
    };
    engine_exposes && fem_plan_enables_quantity(plan, id)
}

fn fem_plan_enables_quantity(plan: &FemPlanIR, id: QuantityId) -> bool {
    match id {
        QuantityId::M | QuantityId::HEff | QuantityId::Torque => true,
        QuantityId::HEx => plan.enable_exchange,
        QuantityId::HDemag => plan.enable_demag,
        QuantityId::DemagPhi => plan.enable_demag,
        QuantityId::HExt => plan.external_field.is_some(),
        QuantityId::HAnt => !plan.current_modules.is_empty(),
        QuantityId::HDrive => !plan.field_drives.is_empty(),
        QuantityId::HAni => material_has_uniaxial_anisotropy(&plan.material),
        QuantityId::HAniCubic => material_has_cubic_anisotropy(&plan.material),
        QuantityId::HDmi => plan.interfacial_dmi.is_some() || has_values(&plan.dind_field),
        QuantityId::HDmiBulk => plan.bulk_dmi.is_some() || has_values(&plan.dbulk_field),
        QuantityId::HMel => plan.magnetoelastic.is_some(),
        QuantityId::HOe => {
            plan.has_oersted_cylinder
                || plan.oersted_field_xyz.is_some()
                || !plan.current_modules.is_empty()
        }
        QuantityId::HTherm => plan
            .temperature
            .is_some_and(|temperature| temperature > 0.0),
        QuantityId::EdenEx => plan.enable_exchange,
        QuantityId::EdenDemag => plan.enable_demag,
        QuantityId::EdenExt => plan.external_field.is_some(),
        QuantityId::EdenDrive => !plan.field_drives.is_empty(),
        QuantityId::EdenAni => {
            material_has_uniaxial_anisotropy(&plan.material)
                || material_has_cubic_anisotropy(&plan.material)
        }
        QuantityId::EdenDmi => {
            plan.interfacial_dmi.is_some()
                || has_values(&plan.dind_field)
                || plan.bulk_dmi.is_some()
                || has_values(&plan.dbulk_field)
        }
        QuantityId::EdenTotal => true,
        QuantityId::VElectric
        | QuantityId::JCharge
        | QuantityId::SpinPotential
        | QuantityId::SpinCurrentTensor
        | QuantityId::TorqueStt => !plan.spin_transport_plans.is_empty(),
        QuantityId::EEx
        | QuantityId::U
        | QuantityId::Eps
        | QuantityId::Sigma
        | QuantityId::EDemag
        | QuantityId::EExt
        | QuantityId::EDrive
        | QuantityId::EAni
        | QuantityId::EDmi
        | QuantityId::EEl
        | QuantityId::EKinEl
        | QuantityId::ETotal
        | QuantityId::ElasticResidualNorm
        | QuantityId::ModeAmplitude
        | QuantityId::ModeReal
        | QuantityId::ModeImag
        | QuantityId::ModePhase
        | QuantityId::MatMs
        | QuantityId::MatAex
        | QuantityId::MatAlpha
        | QuantityId::MatDind
        | QuantityId::MatDbulk
        | QuantityId::DmDt
        | QuantityId::TorqueSot => false,
    }
}

fn fdm_has_uniaxial_anisotropy(material: &FdmMaterialIR) -> bool {
    material.uniaxial_anisotropy_ku1.is_some() || material.uniaxial_anisotropy_ku2.is_some()
}

fn fdm_has_cubic_anisotropy(material: &FdmMaterialIR) -> bool {
    material.cubic_anisotropy_kc1.is_some()
        || material.cubic_anisotropy_kc2.is_some()
        || material.cubic_anisotropy_kc3.is_some()
}

fn material_has_uniaxial_anisotropy(material: &MaterialIR) -> bool {
    material.uniaxial_anisotropy.is_some() || material.uniaxial_anisotropy_k2.is_some()
}

fn material_has_cubic_anisotropy(material: &MaterialIR) -> bool {
    material.cubic_anisotropy_kc1.is_some()
        || material.cubic_anisotropy_kc2.is_some()
        || material.cubic_anisotropy_kc3.is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::{
        ExchangeBoundaryCondition, ExecutionPrecision, FemDomainMeshModeIR, IntegratorChoice,
        MeshIR,
    };
    use std::collections::HashMap;

    fn fdm_plan() -> FdmPlanIR {
        FdmPlanIR {
            enable_exchange: true,
            enable_demag: false,
            ..FdmPlanIR::default()
        }
    }

    fn fem_plan() -> FemPlanIR {
        FemPlanIR {
            mesh_name: "unit_tet".to_string(),
            mesh_source: None,
            mesh: MeshIR {
                mesh_name: "unit_tet".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                ],
                cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
                element_markers: vec![1],
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
                boundary_markers: vec![1],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: HashMap::new(),
            },
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
            mesh_build_report: None,
            domain_mesh_mode: FemDomainMeshModeIR::MergedMagneticMesh,
            domain_frame: None,
            fe_order: 1,
            hmax: 0.4,
            initial_magnetization: vec![[1.0, 0.0, 0.0]; 4],
            enable_exchange: true,
            enable_demag: false,
            material: MaterialIR {
                name: "mat".to_string(),
                saturation_magnetisation: 8.0e5,
                exchange_stiffness: 1.0e-11,
                damping: 0.01,
                uniaxial_anisotropy: None,
                uniaxial_anisotropy_k2: None,
                anisotropy_axis: None,
                cubic_anisotropy_kc1: None,
                cubic_anisotropy_kc2: None,
                cubic_anisotropy_kc3: None,
                cubic_anisotropy_axis1: None,
                cubic_anisotropy_axis2: None,
                ms_field: None,
                a_field: None,
                alpha_field: None,
                ku_field: None,
                ku2_field: None,
                kc1_field: None,
                kc2_field: None,
                kc3_field: None,
                interfacial_dmi: None,
                bulk_dmi: None,
                dind_field: None,
                dbulk_field: None,
            },
            anisotropy_axis_field: None,
            ms_element_field: None,
            a_element_field: None,
            region_materials: Vec::new(),
            external_field: None,
            antenna_zeeman_masks: Vec::new(),
            field_drives: Vec::new(),
            field_drive_geometry_masks: Vec::new(),
            time_stage: Default::default(),
            current_modules: Vec::new(),
            spin_transport_plans: Vec::new(),
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            integrator: Some(IntegratorChoice::Heun),
            fixed_timestep: Some(1.0e-13),
            adaptive_timestep: None,
            field_refresh: None,
            relaxation: None,
            demag_realization: None,
            air_box_config: None,
            interfacial_dmi: None,
            dmi_interface_normal: None,
            bulk_dmi: None,
            dind_field: None,
            dbulk_field: None,
            temperature: None,
            current_density: None,
            stt_degree: None,
            stt_beta: None,
            stt_spin_polarization: None,
            stt_lambda: None,
            stt_epsilon_prime: None,
            stt_thickness: None,
            stt_fixed_layer_position: None,
            spin_torque_contract: None,
            has_oersted_cylinder: false,
            oersted_current: None,
            oersted_radius: None,
            oersted_center: None,
            oersted_axis: None,
            oersted_field_xyz: None,
            oersted_time_dep_kind: 0,
            oersted_time_dep_freq: 0.0,
            oersted_time_dep_phase: 0.0,
            oersted_time_dep_offset: 0.0,
            oersted_time_dep_t_on: 0.0,
            oersted_time_dep_t_off: 0.0,
            magnetoelastic: None,
            mechanics: None,
            demag_solver_policy: None,
            thermal_seed_config: None,
            oersted_realization: None,
            gpu_device_index: None,
            mfem_device_string: None,
            use_consistent_mass: None,
        }
    }

    #[test]
    fn fdm_cached_quantities_follow_active_terms_and_engine_observables() {
        let mut plan = fdm_plan();
        let quantities = [
            "m", "H_ex", "H_demag", "H_ext", "torque", "H_ani", "H_dmi", "H_eff", "H_oe",
        ];

        assert_eq!(
            active_fdm_preview_quantities(FdmEngine::CudaFdm, &plan, &quantities),
            vec!["m", "H_ex", "torque", "H_eff"]
        );

        plan.enable_demag = true;
        plan.external_field = Some([0.0, 0.0, 1.0]);
        plan.material.uniaxial_anisotropy_ku1 = Some(1.0e5);
        plan.interfacial_dmi = Some(1.0e-3);
        plan.has_oersted_cylinder = true;

        assert_eq!(
            active_fdm_preview_quantities(FdmEngine::CudaFdm, &plan, &quantities),
            vec!["m", "H_ex", "H_demag", "H_ext", "torque", "H_ani", "H_eff", "H_oe"]
        );
        assert_eq!(
            active_fdm_preview_quantities(FdmEngine::CpuReference, &plan, &quantities),
            vec!["m", "H_ex", "H_demag", "H_ext", "torque", "H_ani", "H_dmi", "H_eff"]
        );
    }

    #[test]
    fn fdm_cpu_energy_density_quantities_follow_active_energy_terms() {
        let mut plan = fdm_plan();
        plan.external_field = Some([0.0, 0.0, 1.0]);
        let quantities = [
            "eden_ex",
            "eden_demag",
            "eden_ext",
            "eden_ani",
            "eden_dmi",
            "eden_total",
        ];

        assert_eq!(
            active_fdm_preview_quantities(FdmEngine::CpuReference, &plan, &quantities),
            vec!["eden_ex", "eden_ext", "eden_total"]
        );
        assert_eq!(
            active_fdm_preview_quantities(FdmEngine::CudaFdm, &plan, &quantities),
            Vec::<&'static str>::new()
        );

        plan.enable_demag = true;
        plan.material.uniaxial_anisotropy_ku1 = Some(1.0e5);
        plan.interfacial_dmi = Some(1.0e-3);

        assert_eq!(
            active_fdm_preview_quantities(FdmEngine::CpuReference, &plan, &quantities),
            vec![
                "eden_ex",
                "eden_demag",
                "eden_ext",
                "eden_ani",
                "eden_dmi",
                "eden_total"
            ]
        );
    }

    #[test]
    fn fem_cached_quantities_follow_active_terms() {
        let mut plan = fem_plan();
        let quantities = [
            "m", "H_ex", "H_demag", "H_ext", "torque", "H_ani", "H_eff", "H_mel",
        ];

        assert_eq!(
            active_fem_preview_quantities(FemEngine::NativeGpu, &plan, &quantities),
            vec!["m", "H_ex", "torque", "H_eff"]
        );

        plan.enable_demag = true;
        plan.external_field = Some([1.0, 0.0, 0.0]);
        plan.material.uniaxial_anisotropy = Some(1.0e5);

        assert_eq!(
            active_fem_preview_quantities(FemEngine::NativeGpu, &plan, &quantities),
            vec!["m", "H_ex", "H_demag", "H_ext", "torque", "H_ani", "H_eff"]
        );
        assert_eq!(
            active_fem_preview_quantities(FemEngine::CpuNative, &plan, &quantities),
            vec!["m", "H_ex", "H_demag", "H_ext", "torque", "H_eff"]
        );
    }

    #[test]
    fn fem_energy_density_quantities_follow_active_energy_terms() {
        let mut plan = fem_plan();
        let quantities = [
            "eden_ex",
            "eden_demag",
            "eden_ext",
            "eden_ani",
            "eden_dmi",
            "eden_total",
        ];

        assert_eq!(
            active_fem_preview_quantities(FemEngine::NativeGpu, &plan, &quantities),
            vec!["eden_ex", "eden_total"]
        );
        assert_eq!(
            active_fem_preview_quantities(FemEngine::CpuNative, &plan, &quantities),
            vec!["eden_ex", "eden_total"]
        );

        plan.enable_demag = true;
        plan.external_field = Some([1.0, 0.0, 0.0]);
        plan.material.uniaxial_anisotropy = Some(1.0e5);
        plan.interfacial_dmi = Some(1.0e-3);

        assert_eq!(
            active_fem_preview_quantities(FemEngine::NativeGpu, &plan, &quantities),
            vec![
                "eden_ex",
                "eden_demag",
                "eden_ext",
                "eden_ani",
                "eden_dmi",
                "eden_total"
            ]
        );
        assert_eq!(
            active_fem_preview_quantities(FemEngine::CpuNative, &plan, &quantities),
            vec![
                "eden_ex",
                "eden_demag",
                "eden_ext",
                "eden_ani",
                "eden_dmi",
                "eden_total"
            ]
        );
    }

    #[test]
    fn fem_dmi_quantities_are_active_for_native_cpu_and_gpu_constants_and_fields() {
        let mut plan = fem_plan();
        let quantities = ["H_dmi", "H_dmi_bulk"];

        plan.interfacial_dmi = Some(1.0e-3);
        plan.bulk_dmi = Some(2.0e-3);
        assert_eq!(
            active_fem_preview_quantities(FemEngine::NativeGpu, &plan, &quantities),
            vec!["H_dmi", "H_dmi_bulk"]
        );
        assert_eq!(
            active_fem_preview_quantities(FemEngine::CpuNative, &plan, &quantities),
            vec!["H_dmi", "H_dmi_bulk"]
        );

        plan.interfacial_dmi = None;
        plan.bulk_dmi = None;
        plan.dind_field = Some(vec![1.0e-3, 1.1e-3]);
        plan.dbulk_field = Some(vec![2.0e-3, 2.1e-3]);
        assert_eq!(
            active_fem_preview_quantities(FemEngine::NativeGpu, &plan, &quantities),
            vec!["H_dmi", "H_dmi_bulk"]
        );
        assert_eq!(
            active_fem_preview_quantities(FemEngine::CpuNative, &plan, &quantities),
            vec!["H_dmi", "H_dmi_bulk"]
        );
    }
}
