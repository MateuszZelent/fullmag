//! Magnetoelastic effective field and energy for prescribed-strain mode.
//!
//! Implements the cubic magnetoelastic coupling as documented in
//! `docs/physics/0700-shared-magnetoelastic-semantics.md`.
//!
//! In the prescribed-strain mode, the strain tensor ε is given externally
//! (not solved for).  The magnetoelastic effective field is:
//!
//!   H_mel,i = −(1/μ₀Mₛ) ∂e_mel/∂mᵢ
//!
//! For cubic magnetostriction with coupling constants B₁, B₂
//! (where B₂ = −3λ₁₁₁C₄₄ in the standard convention):
//!
//!   e_mel = B₁ (m₁² ε₁₁ + m₂² ε₂₂ + m₃² ε₃₃)
//!         + 2 B₂ (m₁ m₂ ε₁₂ + m₁ m₃ ε₁₃ + m₂ m₃ ε₂₃)
//!
//! where εᵢⱼ are tensor strain components.  Input uses engineering shear
//! (Voigt) convention: [ε₁₁, ε₂₂, ε₃₃, 2ε₂₃, 2ε₁₃, 2ε₁₂]  (indices 0..5)
//!
//! The effective field (in A/m) is:
//!
//!   H_mel,x = −(2 B₁ mₓ ε₁₁ + 2 B₂ (mᵧ ε₁₂ + m_z ε₁₃)) / (μ₀ Mₛ)
//!   H_mel,y = −(2 B₁ mᵧ ε₂₂ + 2 B₂ (mₓ ε₁₂ + m_z ε₂₃)) / (μ₀ Mₛ)
//!   H_mel,z = −(2 B₁ m_z ε₃₃ + 2 B₂ (mₓ ε₁₃ + mᵧ ε₂₃)) / (μ₀ Mₛ)

use crate::Vector3;

/// Permeability of free space [T·m/A].
const MU0: f64 = 1.2566370614359173e-6;

/// Voigt-indexed strain tensor: [ε₁₁, ε₂₂, ε₃₃, 2ε₂₃, 2ε₁₃, 2ε₁₂].
pub type StrainVoigt = [f64; 6];

/// Cubic magnetostriction coupling constants.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MagnetoelasticParams {
    /// First magnetoelastic coupling constant B₁ [Pa].
    pub b1: f64,
    /// Second magnetoelastic coupling constant B₂ [Pa].
    pub b2: f64,
    /// Saturation magnetisation Mₛ [A/m].
    pub ms: f64,
}

/// Prescribed strain configuration for a single cell or uniform field.
#[derive(Debug, Clone, PartialEq)]
pub enum PrescribedStrainField {
    /// Uniform strain across the entire body.
    Uniform(StrainVoigt),
    /// Per-cell strain field (length must match grid cell count).
    PerCell(Vec<StrainVoigt>),
}

/// Compute H_mel for a single cell given magnetization direction and strain.
///
/// Returns H_mel in [A/m].
#[inline]
pub fn h_mel_single(m: Vector3, strain: &StrainVoigt, params: &MagnetoelasticParams) -> Vector3 {
    let [mx, my, mz] = m;
    let [e11, e22, e33, e23_2, e13_2, e12_2] = *strain;

    // Engineering strain → tensor strain: ε₁₂ = e12_2/2, etc.
    let e12 = e12_2 * 0.5;
    let e13 = e13_2 * 0.5;
    let e23 = e23_2 * 0.5;

    let inv_mu0_ms = -1.0 / (MU0 * params.ms);

    [
        inv_mu0_ms * (2.0 * params.b1 * mx * e11 + 2.0 * params.b2 * (my * e12 + mz * e13)),
        inv_mu0_ms * (2.0 * params.b1 * my * e22 + 2.0 * params.b2 * (mx * e12 + mz * e23)),
        inv_mu0_ms * (2.0 * params.b1 * mz * e33 + 2.0 * params.b2 * (mx * e13 + my * e23)),
    ]
}

/// Compute the magnetoelastic effective field for the entire grid.
///
/// Returns H_mel [A/m] per cell.
pub fn h_mel_field(
    magnetization: &[Vector3],
    strain: &PrescribedStrainField,
    params: &MagnetoelasticParams,
    active_mask: Option<&[bool]>,
) -> Vec<Vector3> {
    let n = magnetization.len();

    match strain {
        PrescribedStrainField::Uniform(eps) => (0..n)
            .map(|i| {
                let active = active_mask.map_or(true, |mask| mask[i]);
                if active {
                    h_mel_single(magnetization[i], eps, params)
                } else {
                    [0.0, 0.0, 0.0]
                }
            })
            .collect(),
        PrescribedStrainField::PerCell(eps_field) => {
            assert_eq!(
                eps_field.len(),
                n,
                "strain field length must match magnetization"
            );
            (0..n)
                .map(|i| {
                    let active = active_mask.map_or(true, |mask| mask[i]);
                    if active {
                        h_mel_single(magnetization[i], &eps_field[i], params)
                    } else {
                        [0.0, 0.0, 0.0]
                    }
                })
                .collect()
        }
    }
}

/// Zero-alloc variant: accumulates H_mel into an existing `h_eff` buffer.
pub fn h_mel_field_add_into(
    magnetization: &[Vector3],
    strain: &PrescribedStrainField,
    params: &MagnetoelasticParams,
    active_mask: Option<&[bool]>,
    h_eff: &mut [Vector3],
) {
    let n = magnetization.len();
    match strain {
        PrescribedStrainField::Uniform(eps) => {
            for i in 0..n {
                let active = active_mask.map_or(true, |mask| mask[i]);
                if active {
                    let h = h_mel_single(magnetization[i], eps, params);
                    h_eff[i][0] += h[0];
                    h_eff[i][1] += h[1];
                    h_eff[i][2] += h[2];
                }
            }
        }
        PrescribedStrainField::PerCell(eps_field) => {
            assert_eq!(
                eps_field.len(),
                n,
                "strain field length must match magnetization"
            );
            for i in 0..n {
                let active = active_mask.map_or(true, |mask| mask[i]);
                if active {
                    let h = h_mel_single(magnetization[i], &eps_field[i], params);
                    h_eff[i][0] += h[0];
                    h_eff[i][1] += h[1];
                    h_eff[i][2] += h[2];
                }
            }
        }
    }
}

/// Compute the magnetoelastic energy density for a single cell [J/m³].
///
/// e_mel = B₁ (m₁² ε₁₁ + m₂² ε₂₂ + m₃² ε₃₃)
///       + 2 B₂ (m₁ m₂ ε₁₂ + m₁ m₃ ε₁₃ + m₂ m₃ ε₂₃)
#[inline]
pub fn e_mel_density_single(
    m: Vector3,
    strain: &StrainVoigt,
    params: &MagnetoelasticParams,
) -> f64 {
    let [mx, my, mz] = m;
    let [e11, e22, e33, e23_2, e13_2, e12_2] = *strain;

    let e12 = e12_2 * 0.5;
    let e13 = e13_2 * 0.5;
    let e23 = e23_2 * 0.5;

    params.b1 * (mx * mx * e11 + my * my * e22 + mz * mz * e33)
        + 2.0 * params.b2 * (mx * my * e12 + mx * mz * e13 + my * mz * e23)
}

/// Compute the total magnetoelastic energy [J] for the grid.
pub fn e_mel_total(
    magnetization: &[Vector3],
    strain: &PrescribedStrainField,
    params: &MagnetoelasticParams,
    cell_volume: f64,
    active_mask: Option<&[bool]>,
) -> f64 {
    let n = magnetization.len();

    let sum: f64 = match strain {
        PrescribedStrainField::Uniform(eps) => (0..n)
            .map(|i| {
                let active = active_mask.map_or(true, |mask| mask[i]);
                if active {
                    e_mel_density_single(magnetization[i], eps, params)
                } else {
                    0.0
                }
            })
            .sum(),
        PrescribedStrainField::PerCell(eps_field) => {
            assert_eq!(
                eps_field.len(),
                n,
                "strain field length must match magnetization"
            );
            (0..n)
                .map(|i| {
                    let active = active_mask.map_or(true, |mask| mask[i]);
                    if active {
                        e_mel_density_single(magnetization[i], &eps_field[i], params)
                    } else {
                        0.0
                    }
                })
                .sum()
        }
    };

    sum * cell_volume
}

#[cfg(test)]
mod tests {
    use super::*;

    const PARAMS_FE: MagnetoelasticParams = MagnetoelasticParams {
        b1: -6.95e6, // Fe B₁ [Pa]
        b2: -5.62e6, // Fe B₂ [Pa]
        ms: 1.71e6,  // Fe Mₛ [A/m]
    };

    #[test]
    fn h_mel_zero_strain_gives_zero_field() {
        let m = [1.0, 0.0, 0.0];
        let strain = [0.0; 6];
        let h = h_mel_single(m, &strain, &PARAMS_FE);
        for c in h {
            assert!(c.abs() < 1e-10, "H_mel should be zero for zero strain");
        }
    }

    #[test]
    fn h_mel_zero_coupling_gives_zero_field() {
        let params = MagnetoelasticParams {
            b1: 0.0,
            b2: 0.0,
            ms: 1.71e6,
        };
        let m = [0.577, 0.577, 0.577];
        let strain = [1e-3, 2e-3, -1e-3, 0.5e-3, 0.3e-3, -0.2e-3];
        let h = h_mel_single(m, &strain, &params);
        for c in h {
            assert!(c.abs() < 1e-10, "H_mel must vanish for B1=B2=0");
        }
    }

    #[test]
    fn e_mel_zero_strain_gives_zero_energy() {
        let m = [1.0, 0.0, 0.0];
        let strain = [0.0; 6];
        let e = e_mel_density_single(m, &strain, &PARAMS_FE);
        assert!(
            e.abs() < 1e-15,
            "E_mel density must be zero for zero strain"
        );
    }

    #[test]
    fn h_mel_consistent_with_energy_gradient() {
        // Finite-difference check: H_mel,i ≈ −(1/μ₀Mₛ) ∂e_mel/∂mᵢ
        let strain = [1e-3, 2e-3, -1e-3, 0.5e-3, 0.3e-3, -0.2e-3];
        let m0 = [0.6, 0.7, 0.3742]; // roughly unit magnitude
        let delta = 1e-7;

        let h = h_mel_single(m0, &strain, &PARAMS_FE);

        for axis in 0..3 {
            let mut m_plus = m0;
            let mut m_minus = m0;
            m_plus[axis] += delta;
            m_minus[axis] -= delta;

            let e_plus = e_mel_density_single(m_plus, &strain, &PARAMS_FE);
            let e_minus = e_mel_density_single(m_minus, &strain, &PARAMS_FE);

            let de_dm = (e_plus - e_minus) / (2.0 * delta);
            let expected_h = -de_dm / (MU0 * PARAMS_FE.ms);

            let rel_err = if expected_h.abs() > 1e-10 {
                ((h[axis] - expected_h) / expected_h).abs()
            } else {
                (h[axis] - expected_h).abs()
            };

            assert!(
                rel_err < 1e-5,
                "H_mel[{}] = {:.6e} vs finite-diff {:.6e} (rel_err = {:.2e})",
                axis,
                h[axis],
                expected_h,
                rel_err
            );
        }
    }

    #[test]
    fn h_mel_field_uniform_strain() {
        let n = 4;
        let m: Vec<Vector3> = vec![[1.0, 0.0, 0.0]; n];
        let strain = PrescribedStrainField::Uniform([1e-3, 0.0, 0.0, 0.0, 0.0, 0.0]);

        let h = h_mel_field(&m, &strain, &PARAMS_FE, None);
        assert_eq!(h.len(), n);

        // For m = [1,0,0] and ε₁₁ = 1e-3, H_mel,x = −2 B₁ ε₁₁ / (μ₀ Mₛ)
        let expected_hx = -2.0 * PARAMS_FE.b1 * 1e-3 / (MU0 * PARAMS_FE.ms);
        for cell in &h {
            assert!((cell[0] - expected_hx).abs() / expected_hx.abs() < 1e-10);
            assert!(cell[1].abs() < 1e-10);
            assert!(cell[2].abs() < 1e-10);
        }
    }

    #[test]
    fn e_mel_total_consistent_with_density() {
        let m: Vec<Vector3> = vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
        let strain = PrescribedStrainField::Uniform([1e-3, 2e-3, 0.0, 0.0, 0.0, 0.0]);
        let cell_volume = 8e-27; // 2nm × 2nm × 2nm

        let e_total = e_mel_total(&m, &strain, &PARAMS_FE, cell_volume, None);

        let e0 = e_mel_density_single(m[0], &[1e-3, 2e-3, 0.0, 0.0, 0.0, 0.0], &PARAMS_FE);
        let e1 = e_mel_density_single(m[1], &[1e-3, 2e-3, 0.0, 0.0, 0.0, 0.0], &PARAMS_FE);
        let expected = (e0 + e1) * cell_volume;

        assert!(
            (e_total - expected).abs() / expected.abs() < 1e-12,
            "E_mel total {:.6e} vs sum {:.6e}",
            e_total,
            expected
        );
    }

    #[test]
    fn active_mask_zeros_inactive_cells() {
        let m: Vec<Vector3> = vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
        let strain = PrescribedStrainField::Uniform([1e-3, 2e-3, 0.0, 0.0, 0.0, 0.0]);
        let mask = vec![true, false];

        let h = h_mel_field(&m, &strain, &PARAMS_FE, Some(&mask));
        assert!(h[1][0].abs() < 1e-30, "inactive cell must have zero H_mel");

        let cell_volume = 8e-27;
        let e = e_mel_total(&m, &strain, &PARAMS_FE, cell_volume, Some(&mask));
        let e_active_only =
            e_mel_density_single(m[0], &[1e-3, 2e-3, 0.0, 0.0, 0.0, 0.0], &PARAMS_FE) * cell_volume;
        assert!(
            (e - e_active_only).abs() / e_active_only.abs() < 1e-12,
            "E_mel with mask should count only active cells"
        );
    }
}
