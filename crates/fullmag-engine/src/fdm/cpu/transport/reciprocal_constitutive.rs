use crate::fdm::shared::types::{EngineError, Result};

/// Pointwise M2 charge-spin constitutive material in the `Q_ia` convention.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ReciprocalConstitutiveMaterial {
    /// Scalar reciprocal reference conductivity, in S/m.
    pub sigma_s_per_m: f64,
    /// Spin conductivity, in S/m.
    pub sigma_spin_s_per_m: f64,
    /// Magnetoresistive conductivity parallel to `m`, in S/m.
    pub sigma_parallel_s_per_m: f64,
    /// Magnetoresistive conductivity perpendicular to `m`, in S/m.
    pub sigma_perpendicular_s_per_m: f64,
    /// Anomalous-Hall conductivity, in S/m.
    pub sigma_ahe_s_per_m: f64,
    pub polarization: f64,
    pub spin_hall_angle: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ReciprocalConstitutiveResponse {
    /// Conventional charge-current density `J_c,i`, in A/m^2.
    pub charge_current_density_a_per_m2: [f64; 3],
    /// Spin-current tensor `Q_ia`, flow axis first, in A/m^2.
    pub spin_current_density_a_per_m2: [[f64; 3]; 3],
}

impl ReciprocalConstitutiveMaterial {
    pub fn validate(self) -> Result<()> {
        let conductivities = [
            self.sigma_s_per_m,
            self.sigma_spin_s_per_m,
            self.sigma_parallel_s_per_m,
            self.sigma_perpendicular_s_per_m,
            self.sigma_ahe_s_per_m,
        ];
        if conductivities.iter().any(|value| !value.is_finite())
            || !self.polarization.is_finite()
            || !self.spin_hall_angle.is_finite()
        {
            return Err(EngineError::new(
                "M2 reciprocal constitutive coefficients must be finite",
            ));
        }
        if self.sigma_s_per_m <= 0.0
            || self.sigma_spin_s_per_m <= 0.0
            || self.sigma_parallel_s_per_m <= 0.0
            || self.sigma_perpendicular_s_per_m <= 0.0
        {
            return Err(EngineError::new(
                "M2 reciprocal dissipative conductivities must be positive",
            ));
        }
        if !(-1.0..=1.0).contains(&self.polarization) {
            return Err(EngineError::new(
                "M2 reciprocal polarization must be in [-1, 1]",
            ));
        }
        let reduced =
            self.sigma_spin_s_per_m - self.polarization * self.polarization * self.sigma_s_per_m;
        if reduced <= 0.0 {
            return Err(EngineError::new(
                "M2 reciprocal block requires sigma_spin-P^2*sigma > 0",
            ));
        }
        Ok(())
    }

    pub fn evaluate(
        self,
        electric_field_v_per_m: [f64; 3],
        spin_potential_gradient_v_per_m: [[f64; 3]; 3],
        magnetization: [f64; 3],
    ) -> Result<ReciprocalConstitutiveResponse> {
        self.validate()?;
        if electric_field_v_per_m
            .iter()
            .chain(spin_potential_gradient_v_per_m.iter().flatten())
            .chain(magnetization.iter())
            .any(|value| !value.is_finite())
        {
            return Err(EngineError::new(
                "M2 reciprocal constitutive state must be finite",
            ));
        }
        let m_norm = dot(magnetization, magnetization).sqrt();
        if (m_norm - 1.0).abs() > 1.0e-12 {
            return Err(EngineError::new(
                "M2 reciprocal magnetization must be unit length",
            ));
        }

        let mut charge = [0.0; 3];
        let projection = dot(magnetization, electric_field_v_per_m);
        let hall = cross(magnetization, electric_field_v_per_m);
        for i in 0..3 {
            charge[i] = self.sigma_perpendicular_s_per_m * electric_field_v_per_m[i]
                + (self.sigma_parallel_s_per_m - self.sigma_perpendicular_s_per_m)
                    * projection
                    * magnetization[i]
                + self.sigma_ahe_s_per_m * hall[i];
            for a in 0..3 {
                charge[i] += self.polarization
                    * self.sigma_s_per_m
                    * magnetization[a]
                    * spin_potential_gradient_v_per_m[i][a];
                for j in 0..3 {
                    charge[i] += self.spin_hall_angle
                        * self.sigma_s_per_m
                        * levi_civita(i, j, a)
                        * spin_potential_gradient_v_per_m[j][a];
                }
            }
        }

        let mut spin = [[0.0; 3]; 3];
        for i in 0..3 {
            for a in 0..3 {
                spin[i][a] = self.sigma_spin_s_per_m * spin_potential_gradient_v_per_m[i][a]
                    + self.polarization
                        * self.sigma_s_per_m
                        * electric_field_v_per_m[i]
                        * magnetization[a];
                for k in 0..3 {
                    spin[i][a] += self.spin_hall_angle
                        * self.sigma_s_per_m
                        * levi_civita(i, k, a)
                        * electric_field_v_per_m[k];
                }
            }
        }

        Ok(ReciprocalConstitutiveResponse {
            charge_current_density_a_per_m2: charge,
            spin_current_density_a_per_m2: spin,
        })
    }
}

fn levi_civita(i: usize, j: usize, k: usize) -> f64 {
    match (i, j, k) {
        (0, 1, 2) | (1, 2, 0) | (2, 0, 1) => 1.0,
        (0, 2, 1) | (2, 1, 0) | (1, 0, 2) => -1.0,
        _ => 0.0,
    }
}

fn dot(left: [f64; 3], right: [f64; 3]) -> f64 {
    left[0] * right[0] + left[1] * right[1] + left[2] * right[2]
}

fn cross(left: [f64; 3], right: [f64; 3]) -> [f64; 3] {
    [
        left[1] * right[2] - left[2] * right[1],
        left[2] * right[0] - left[0] * right[2],
        left[0] * right[1] - left[1] * right[0],
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn material() -> ReciprocalConstitutiveMaterial {
        ReciprocalConstitutiveMaterial {
            sigma_s_per_m: 4.0,
            sigma_spin_s_per_m: 3.0,
            sigma_parallel_s_per_m: 5.0,
            sigma_perpendicular_s_per_m: 2.0,
            sigma_ahe_s_per_m: 0.7,
            polarization: 0.5,
            spin_hall_angle: 0.2,
        }
    }

    #[test]
    fn m2_onsager_oracle_freezes_reciprocal_and_she_signs() {
        let model = material();
        let e = [0.8, -0.3, 0.5];
        let g = [[0.2, -0.7, 0.1], [0.4, 0.3, -0.2], [-0.6, 0.9, 0.5]];
        let m = [0.0, 0.0, 1.0];
        let coupled = model.evaluate(e, g, m).unwrap();
        let charge_only = model.evaluate(e, [[0.0; 3]; 3], m).unwrap();
        let spin_only = model.evaluate([0.0; 3], g, m).unwrap();

        let charge_cross_power = dot_difference(
            coupled.charge_current_density_a_per_m2,
            charge_only.charge_current_density_a_per_m2,
            e,
        );
        let spin_cross_power = tensor_dot_difference(
            coupled.spin_current_density_a_per_m2,
            spin_only.spin_current_density_a_per_m2,
            g,
        );
        let expected_p_cross = 2.0
            * model.polarization
            * model.sigma_s_per_m
            * (0..3)
                .map(|i| e[i] * (0..3).map(|a| m[a] * g[i][a]).sum::<f64>())
                .sum::<f64>();
        assert!((charge_cross_power + spin_cross_power - expected_p_cross).abs() < 1.0e-12);
    }

    #[test]
    fn m2_ahe_and_she_blocks_are_nondissipative() {
        let mut model = material();
        model.polarization = 0.0;
        let e = [0.8, -0.3, 0.5];
        let g = [[0.2, -0.7, 0.1], [0.4, 0.3, -0.2], [-0.6, 0.9, 0.5]];
        let m = [0.0, 0.0, 1.0];
        let response = model.evaluate(e, g, m).unwrap();
        let dissipative = model.sigma_perpendicular_s_per_m * (e[0] * e[0] + e[1] * e[1])
            + model.sigma_parallel_s_per_m * e[2] * e[2]
            + model.sigma_spin_s_per_m * g.iter().flatten().map(|v| v * v).sum::<f64>();
        let power = dot(response.charge_current_density_a_per_m2, e)
            + tensor_dot(response.spin_current_density_a_per_m2, g);
        assert!((power - dissipative).abs() < 1.0e-12);
    }

    #[test]
    fn m2_rejects_nonpositive_reduced_spin_conductivity() {
        let mut model = material();
        model.sigma_spin_s_per_m = 1.0;
        model.polarization = 0.5;
        assert!(model.validate().is_err());
    }

    fn dot_difference(total: [f64; 3], base: [f64; 3], rhs: [f64; 3]) -> f64 {
        (0..3).map(|i| (total[i] - base[i]) * rhs[i]).sum()
    }

    fn tensor_dot(left: [[f64; 3]; 3], right: [[f64; 3]; 3]) -> f64 {
        (0..3)
            .flat_map(|i| (0..3).map(move |a| left[i][a] * right[i][a]))
            .sum()
    }

    fn tensor_dot_difference(total: [[f64; 3]; 3], base: [[f64; 3]; 3], rhs: [[f64; 3]; 3]) -> f64 {
        (0..3)
            .flat_map(|i| (0..3).map(move |a| (total[i][a] - base[i][a]) * rhs[i][a]))
            .sum()
    }
}
