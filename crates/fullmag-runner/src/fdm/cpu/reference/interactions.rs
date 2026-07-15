//! CPU reference interaction term assembly from FDM plan fields.

use fullmag_engine::{
    magnetoelastic::{MagnetoelasticParams, PrescribedStrainField},
    MagnetoelasticTermConfig, OerstedCylinderConfig, SlonczewskiSttConfig, SotConfig,
    ZhangLiSttConfig,
};
use fullmag_ir::FdmPlanIR;

pub(super) fn build_mel(plan: &FdmPlanIR) -> Option<MagnetoelasticTermConfig> {
    let b1 = plan.mel_b1?;
    let strain = plan.mel_uniform_strain?;
    Some(MagnetoelasticTermConfig {
        params: MagnetoelasticParams {
            b1,
            b2: plan.mel_b2.unwrap_or(0.0),
            ms: plan.material.saturation_magnetisation,
        },
        strain: PrescribedStrainField::Uniform(strain),
    })
}

pub(super) fn build_sot(plan: &FdmPlanIR) -> Option<SotConfig> {
    let je = plan.sot_current_density?;
    let sigma = plan.sot_sigma?;
    let thickness = plan.sot_thickness?;
    if je == 0.0 || thickness <= 0.0 {
        return None;
    }
    Some(SotConfig {
        current_density: je,
        xi_dl: plan.sot_xi_dl.unwrap_or(0.0),
        xi_fl: plan.sot_xi_fl.unwrap_or(0.0),
        sigma,
        thickness,
        active_mask: plan.sot_active_mask.clone(),
    })
}

fn has_slonczewski_stt(plan: &FdmPlanIR) -> bool {
    plan.current_density.is_some()
        && plan.stt_degree.is_some()
        && plan.stt_spin_polarization.is_some()
        && plan.stt_lambda.is_some()
}

fn has_zhang_li_stt(plan: &FdmPlanIR) -> bool {
    plan.current_density.is_some() && plan.stt_degree.is_some() && !has_slonczewski_stt(plan)
}

pub(super) fn build_zl_stt(plan: &FdmPlanIR) -> Option<ZhangLiSttConfig> {
    if !has_zhang_li_stt(plan) {
        return None;
    }
    let j = plan.current_density?;
    let p = plan.stt_degree?;
    if j[0] == 0.0 && j[1] == 0.0 && j[2] == 0.0 || p <= 0.0 {
        return None;
    }
    Some(ZhangLiSttConfig {
        current_density: j,
        spin_polarization: p,
        non_adiabaticity: plan.stt_beta.unwrap_or(0.0),
    })
}

/// Build a `SlonczewskiSttConfig` from plan fields if Slonczewski STT is requested.
/// `cell_dz` is the cell thickness in z used as the layer thickness when none is
/// provided elsewhere.
pub(super) fn build_slon_stt(plan: &FdmPlanIR, cell_dz: f64) -> Option<SlonczewskiSttConfig> {
    if !has_slonczewski_stt(plan) {
        return None;
    }
    let p_axis = plan.stt_spin_polarization?;
    let lam = plan.stt_lambda?;
    if lam <= 0.0 {
        return None;
    }
    let j = plan.current_density?;
    let j_mag = (j[0] * j[0] + j[1] * j[1] + j[2] * j[2]).sqrt();
    if j_mag == 0.0 {
        return None;
    }
    let thickness = plan.stt_thickness.unwrap_or(cell_dz);
    let current_sign = match plan.stt_fixed_layer_position.as_deref().unwrap_or("top") {
        "bottom" => -1.0,
        _ => 1.0,
    };
    Some(SlonczewskiSttConfig {
        current_density_magnitude: j_mag,
        spin_polarization_axis: p_axis,
        lambda: lam,
        epsilon_prime: plan.stt_epsilon_prime.unwrap_or(0.0),
        degree: plan.stt_degree.unwrap_or(1.0),
        thickness,
        current_sign,
    })
}

pub(super) fn build_oersted(plan: &FdmPlanIR) -> Option<OerstedCylinderConfig> {
    if !plan.has_oersted_cylinder {
        return None;
    }
    let current = plan.oersted_current?;
    let radius = plan.oersted_radius?;
    if radius <= 0.0 {
        return None;
    }
    Some(OerstedCylinderConfig {
        current,
        radius,
        center: plan.oersted_center.unwrap_or([0.0, 0.0, 0.0]),
        axis: plan.oersted_axis.unwrap_or([0.0, 0.0, 1.0]),
        time_dep_kind: plan.oersted_time_dep_kind,
        time_dep_freq: plan.oersted_time_dep_freq,
        time_dep_phase: plan.oersted_time_dep_phase,
        time_dep_offset: plan.oersted_time_dep_offset,
        time_dep_t_on: plan.oersted_time_dep_t_on,
        time_dep_t_off: plan.oersted_time_dep_t_off,
    })
}
