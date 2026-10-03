//! Magnetoelastic field and energy realizations for the FDM CPU reference lane.

use super::{zero_vectors, ExchangeLlgProblem, Vector3, VectorFieldSoA};
use crate::magnetoelastic;

impl ExchangeLlgProblem {
    pub(crate) fn magnetoelastic_field(&self, magnetization: &[Vector3]) -> Vec<Vector3> {
        match &self.terms.magnetoelastic {
            Some(config) => magnetoelastic::h_mel_field(
                magnetization,
                &config.strain,
                &config.params,
                self.active_mask.as_deref(),
            ),
            None => zero_vectors(self.grid.cell_count()),
        }
    }

    pub(crate) fn magnetoelastic_energy(&self, magnetization: &[Vector3]) -> f64 {
        match &self.terms.magnetoelastic {
            Some(config) => {
                let cell_volume = self.cell_size.dx * self.cell_size.dy * self.cell_size.dz;
                magnetoelastic::e_mel_total(
                    magnetization,
                    &config.strain,
                    &config.params,
                    cell_volume,
                    self.active_mask.as_deref(),
                )
            }
            None => 0.0,
        }
    }

    pub(crate) fn magnetoelastic_energy_soa(&self, magnetization: &VectorFieldSoA) -> f64 {
        let config = match &self.terms.magnetoelastic {
            Some(config) => config,
            None => return 0.0,
        };
        let n = magnetization.len();
        let cell_volume = self.cell_size.volume();

        let compute_cell = |i: usize, strain: &magnetoelastic::StrainVoigt| {
            if self.is_active(i) {
                magnetoelastic::e_mel_density_single(
                    [magnetization.x[i], magnetization.y[i], magnetization.z[i]],
                    strain,
                    &config.params,
                )
            } else {
                0.0
            }
        };

        let sum: f64 = match &config.strain {
            magnetoelastic::PrescribedStrainField::Uniform(strain) => {
                (0..n).map(|i| compute_cell(i, strain)).sum()
            }
            magnetoelastic::PrescribedStrainField::PerCell(strain) => {
                assert_eq!(
                    strain.len(),
                    n,
                    "strain field length must match magnetization"
                );
                (0..n).map(|i| compute_cell(i, &strain[i])).sum()
            }
        };
        sum * cell_volume
    }

    pub(crate) fn magnetoelastic_field_add_into_soa(
        &self,
        magnetization: &VectorFieldSoA,
        h_eff: &mut VectorFieldSoA,
    ) {
        let config = match &self.terms.magnetoelastic {
            Some(config) => config,
            None => return,
        };
        let n = magnetization.len();

        let add_cell =
            |i: usize, strain: &magnetoelastic::StrainVoigt, h_eff: &mut VectorFieldSoA| {
                if !self.is_active(i) {
                    return;
                }
                let h = magnetoelastic::h_mel_single(
                    [magnetization.x[i], magnetization.y[i], magnetization.z[i]],
                    strain,
                    &config.params,
                );
                h_eff.x[i] += h[0];
                h_eff.y[i] += h[1];
                h_eff.z[i] += h[2];
            };

        match &config.strain {
            magnetoelastic::PrescribedStrainField::Uniform(strain) => {
                for i in 0..n {
                    add_cell(i, strain, h_eff);
                }
            }
            magnetoelastic::PrescribedStrainField::PerCell(strain) => {
                assert_eq!(
                    strain.len(),
                    n,
                    "strain field length must match magnetization"
                );
                for (i, cell_strain) in strain.iter().enumerate() {
                    add_cell(i, cell_strain, h_eff);
                }
            }
        }
    }

    pub(crate) fn magnetoelastic_field_add_into(
        &self,
        magnetization: &[Vector3],
        h_eff: &mut [Vector3],
    ) {
        if let Some(ref config) = self.terms.magnetoelastic {
            magnetoelastic::h_mel_field_add_into(
                magnetization,
                &config.strain,
                &config.params,
                self.active_mask.as_deref(),
                h_eff,
            );
        }
    }
}
