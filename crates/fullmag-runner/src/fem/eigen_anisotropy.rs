use super::eigen_math::{add_vector, cross, dot, normalize_vector, scale_vector};
use fullmag_engine::Vector3;
use fullmag_engine::MU0;
use fullmag_ir::FemEigenPlanIR;

/// Compute the uniaxial anisotropy effective field at a single node.
///
/// H_uni = (2 Ku1 / (mu0 Ms)) (m · u) u + (4 Ku2 / (mu0 Ms)) (m · u)^3 u
fn uniaxial_anisotropy_field(m: Vector3, plan: &FemEigenPlanIR) -> Vector3 {
    let ku1 = match plan.material.uniaxial_anisotropy {
        Some(k) if k.abs() > 0.0 => k,
        _ => return [0.0, 0.0, 0.0],
    };
    let axis = normalize_vector(plan.material.anisotropy_axis.unwrap_or([0.0, 0.0, 1.0]));
    let ms = plan.material.saturation_magnetisation.max(1e-30);
    let ku2 = plan.material.uniaxial_anisotropy_k2.unwrap_or(0.0);
    let m_dot_u = dot(m, axis);
    let coeff =
        2.0 * ku1 / (MU0 * ms) * m_dot_u + 4.0 * ku2 / (MU0 * ms) * m_dot_u * m_dot_u * m_dot_u;
    scale_vector(axis, coeff)
}

/// Compute the cubic anisotropy effective field at a single node.
///
/// First-order cubic: H_c1 = -(2 Kc1 / (mu0 Ms)) ∂E/∂m  with the standard
/// cubic energy density  E = Kc1 (m1² m2² + m2² m3² + m1² m3²) + ...
fn cubic_anisotropy_field(m: Vector3, plan: &FemEigenPlanIR) -> Vector3 {
    let kc1 = match plan.material.cubic_anisotropy_kc1 {
        Some(k) if k.abs() > 0.0 => k,
        _ => return [0.0, 0.0, 0.0],
    };
    let c1 = normalize_vector(
        plan.material
            .cubic_anisotropy_axis1
            .unwrap_or([1.0, 0.0, 0.0]),
    );
    let c2 = normalize_vector(
        plan.material
            .cubic_anisotropy_axis2
            .unwrap_or([0.0, 1.0, 0.0]),
    );
    let c3 = cross(c1, c2);
    let kc2 = plan.material.cubic_anisotropy_kc2.unwrap_or(0.0);
    let ms = plan.material.saturation_magnetisation.max(1e-30);

    let m1 = dot(m, c1);
    let m2 = dot(m, c2);
    let m3 = dot(m, c3);

    let pf = 2.0 / (MU0 * ms);

    // dE/dm_i for cubic energy E = Kc1 (m1² m2² + m2² m3² + m1² m3²)
    //                             + Kc2 (m1² m2² m3²)
    let g1 = -pf * (kc1 * m1 * (m2 * m2 + m3 * m3) + kc2 * m1 * m2 * m2 * m3 * m3);
    let g2 = -pf * (kc1 * m2 * (m1 * m1 + m3 * m3) + kc2 * m2 * m1 * m1 * m3 * m3);
    let g3 = -pf * (kc1 * m3 * (m1 * m1 + m2 * m2) + kc2 * m3 * m1 * m1 * m2 * m2);

    [
        g1 * c1[0] + g2 * c2[0] + g3 * c3[0],
        g1 * c1[1] + g2 * c2[1] + g3 * c3[1],
        g1 * c1[2] + g2 * c2[2] + g3 * c3[2],
    ]
}

/// Compute the total volume anisotropy field (uniaxial + cubic) at a node.
pub(super) fn volume_anisotropy_field(m: Vector3, plan: &FemEigenPlanIR) -> Vector3 {
    add_vector(
        uniaxial_anisotropy_field(m, plan),
        cubic_anisotropy_field(m, plan),
    )
}
