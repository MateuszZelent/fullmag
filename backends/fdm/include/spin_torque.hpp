#ifndef FULLMAG_FDM_SPIN_TORQUE_HPP
#define FULLMAG_FDM_SPIN_TORQUE_HPP

namespace fullmag {
namespace fdm {

#if defined(__CUDACC__)
#define FULLMAG_FDM_HOST_DEVICE __host__ __device__
#else
#define FULLMAG_FDM_HOST_DEVICE
#endif

template <typename Scalar>
struct PrescribedSotVector {
    Scalar x;
    Scalar y;
    Scalar z;
};

template <typename Scalar>
FULLMAG_FDM_HOST_DEVICE PrescribedSotVector<Scalar> prescribed_sot_cross(
    const PrescribedSotVector<Scalar> &a,
    const PrescribedSotVector<Scalar> &b)
{
    return {
        a.y * b.z - a.z * b.y,
        a.z * b.x - a.x * b.z,
        a.x * b.y - a.y * b.x,
    };
}

/*
 * Converts the signed conventional current density to the canonical Gilbert
 * source rate prefactor
 *
 *   Omega = gamma_e hbar J_signed / (2 e M_s t_F), gamma_e = gamma0 / mu0.
 */
FULLMAG_FDM_HOST_DEVICE inline double prescribed_sot_rate_prefactor(
    double gamma0,
    double signed_current_density,
    double saturation_magnetisation,
    double free_layer_thickness)
{
    constexpr double hbar = 1.054571817e-34;
    constexpr double elementary_charge = 1.602176634e-19;
    constexpr double mu0 = 1.25663706212e-6;
    return (gamma0 / mu0) * hbar * signed_current_density /
           (2.0 * elementary_charge * saturation_magnetisation * free_layer_thickness);
}

/*
 * Canonical prescribed-SOT source and its one-and-only Gilbert conversion:
 *
 *   T_G = Omega [xi_DL m x (sigma x m) + xi_FL m x sigma]
 *   T_explicit = [T_G + alpha m x T_G] / (1 + alpha^2).
 */
template <typename Scalar>
FULLMAG_FDM_HOST_DEVICE PrescribedSotVector<Scalar> prescribed_sot_explicit_rhs(
    const PrescribedSotVector<Scalar> &m,
    const PrescribedSotVector<Scalar> &sigma,
    Scalar omega,
    Scalar xi_dl,
    Scalar xi_fl,
    Scalar alpha)
{
    const PrescribedSotVector<Scalar> sigma_cross_m = prescribed_sot_cross(sigma, m);
    const PrescribedSotVector<Scalar> damping_like = prescribed_sot_cross(m, sigma_cross_m);
    const PrescribedSotVector<Scalar> field_like = prescribed_sot_cross(m, sigma);
    const PrescribedSotVector<Scalar> gilbert_source{
        omega * (xi_dl * damping_like.x + xi_fl * field_like.x),
        omega * (xi_dl * damping_like.y + xi_fl * field_like.y),
        omega * (xi_dl * damping_like.z + xi_fl * field_like.z),
    };
    const PrescribedSotVector<Scalar> gilbert_cross = prescribed_sot_cross(m, gilbert_source);
    const Scalar inverse_gilbert = Scalar(1) / (Scalar(1) + alpha * alpha);
    return {
        (gilbert_source.x + alpha * gilbert_cross.x) * inverse_gilbert,
        (gilbert_source.y + alpha * gilbert_cross.y) * inverse_gilbert,
        (gilbert_source.z + alpha * gilbert_cross.z) * inverse_gilbert,
    };
}

#undef FULLMAG_FDM_HOST_DEVICE

}  // namespace fdm
}  // namespace fullmag

#endif
