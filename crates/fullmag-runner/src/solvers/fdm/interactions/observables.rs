//! FDM observable activation rules.

use crate::quantities::{filter_active_quantities, QuantityId};
use crate::solver_runtime::engine::FdmEngine;
use fullmag_ir::{FdmMaterialIR, FdmPlanIR};

pub(crate) fn active_fdm_preview_quantities(
    engine: FdmEngine,
    plan: &FdmPlanIR,
    quantities: &[&str],
) -> Vec<&'static str> {
    filter_active_quantities(quantities, |id| fdm_quantity_is_active(engine, plan, id))
}

fn fdm_quantity_is_active(engine: FdmEngine, plan: &FdmPlanIR, id: QuantityId) -> bool {
    let engine_exposes = match engine {
        FdmEngine::CpuReference => matches!(
            id,
            QuantityId::M
                | QuantityId::HEx
                | QuantityId::HDemag
                | QuantityId::HExt
                | QuantityId::Torque
                | QuantityId::HAni
                | QuantityId::HDmi
                | QuantityId::HEff
                | QuantityId::EdenEx
                | QuantityId::EdenDemag
                | QuantityId::EdenExt
                | QuantityId::EdenAni
                | QuantityId::EdenDmi
                | QuantityId::EdenTotal
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
        QuantityId::EdenAni => {
            fdm_has_uniaxial_anisotropy(&plan.material) || fdm_has_cubic_anisotropy(&plan.material)
        }
        QuantityId::EdenDmi => plan.interfacial_dmi.is_some() || plan.bulk_dmi.is_some(),
        QuantityId::EdenTotal => true,
        QuantityId::HAnt
        | QuantityId::U
        | QuantityId::Eps
        | QuantityId::Sigma
        | QuantityId::EEx
        | QuantityId::EDemag
        | QuantityId::EExt
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
        | QuantityId::DmDt
        | QuantityId::TorqueStt
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

#[cfg(test)]
mod tests {
    use super::*;

    fn fdm_plan() -> FdmPlanIR {
        FdmPlanIR {
            enable_exchange: true,
            enable_demag: false,
            ..FdmPlanIR::default()
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
}
