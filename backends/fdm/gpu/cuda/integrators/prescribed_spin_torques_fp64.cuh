#pragma once

#include "context.hpp"

namespace fullmag::fdm {

__device__ __forceinline__ void add_prescribed_spin_torques_fp64(
    int idx, double m0, double m1, double m2, double alpha,
    const SttParams &stt, const SotParams &sot,
    double &rhs_x, double &rhs_y, double &rhs_z)
{
    // Slonczewski STT (CPP).
    if (stt.has_slonczewski_stt &&
        (!stt.active_mask || stt.active_mask[idx] != 0) &&
        (!stt.has_slonczewski_active_mask || stt.slonczewski_active_mask[idx] != 0)) {
        double px = stt.stt_p_x;
        double py = stt.stt_p_y;
        double pz = stt.stt_p_z;
        double m_dot_p = m0 * px + m1 * py + m2 * pz;

        double L2 = stt.stt_lambda * stt.stt_lambda;
        double P_val = stt.stt_degree > 0 ? stt.stt_degree : 1.0;

        double g = (P_val * L2) / ((L2 + 1.0) + (L2 - 1.0) * m_dot_p);
        double beta_STT = stt.stt_cpp_pf * g;
        double inv_gilbert_stt = 1.0 / (1.0 + alpha * alpha);
        double damping_like_scale;
        double field_like_scale;
        if (stt.slonczewski_formula == FULLMAG_FDM_SLONCZEWSKI_FULLMAG_V2) {
            damping_like_scale =
                stt.stt_cpp_pf * (g + alpha * stt.stt_epsilon_prime) * inv_gilbert_stt;
            field_like_scale =
                stt.stt_cpp_pf * (stt.stt_epsilon_prime - alpha * g) * inv_gilbert_stt;
        } else {
            damping_like_scale =
                beta_STT * (1.0 + alpha * stt.stt_epsilon_prime) * inv_gilbert_stt;
            field_like_scale =
                beta_STT * (stt.stt_epsilon_prime - alpha) * inv_gilbert_stt;
        }

        // m x p
        double m_cross_px = m1 * pz - m2 * py;
        double m_cross_py = m2 * px - m0 * pz;
        double m_cross_pz = m0 * py - m1 * px;

        // m x (m x p)
        double double_m_cross_px = m1 * m_cross_pz - m2 * m_cross_py;
        double double_m_cross_py = m2 * m_cross_px - m0 * m_cross_pz;
        double double_m_cross_pz = m0 * m_cross_py - m1 * m_cross_px;

        rhs_x += damping_like_scale * double_m_cross_px + field_like_scale * m_cross_px;
        rhs_y += damping_like_scale * double_m_cross_py + field_like_scale * m_cross_py;
        rhs_z += damping_like_scale * double_m_cross_pz + field_like_scale * m_cross_pz;
    }

    // Prescribed SOT v1 converts the Gilbert source exactly once.
    if (sot.has_sot && sot.formula == FULLMAG_FDM_PRESCRIBED_SOT_V1 &&
        (!sot.has_active_mask || sot.active_mask[idx] != 0) &&
        sot.has_target_mask && sot.target_mask[idx] != 0)
    {
        const auto sot_rhs = prescribed_sot_explicit_rhs(
            PrescribedSotVector<double>{m0, m1, m2},
            PrescribedSotVector<double>{sot.sx, sot.sy, sot.sz},
            sot.amp, sot.xi_dl, sot.xi_fl, alpha);
        rhs_x += sot_rhs.x;
        rhs_y += sot_rhs.y;
        rhs_z += sot_rhs.z;
    } else if (sot.has_sot &&
               sot.formula == FULLMAG_FDM_PRESCRIBED_SOT_LEGACY_V0 &&
               (!sot.has_active_mask || sot.active_mask[idx] != 0)) {
        const double m_dot_s = m0 * sot.sx + m1 * sot.sy + m2 * sot.sz;
        const double fl_x = m1 * sot.sz - m2 * sot.sy;
        const double fl_y = m2 * sot.sx - m0 * sot.sz;
        const double fl_z = m0 * sot.sy - m1 * sot.sx;
        const double dl_x = m_dot_s * m0 - sot.sx;
        const double dl_y = m_dot_s * m1 - sot.sy;
        const double dl_z = m_dot_s * m2 - sot.sz;
        rhs_x += sot.amp * (-sot.xi_dl * dl_x + sot.xi_fl * fl_x);
        rhs_y += sot.amp * (-sot.xi_dl * dl_y + sot.xi_fl * fl_y);
        rhs_z += sot.amp * (-sot.xi_dl * dl_z + sot.xi_fl * fl_z);
    }
}

} // namespace fullmag::fdm
