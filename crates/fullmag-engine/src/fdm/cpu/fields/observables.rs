//! FDM reference field and solver observables for `ExchangeLlgProblem`.

use crate::fdm::cpu::fft::{combine_fields_4, zero_vectors};
use crate::vector::{add, max_cross_norm, max_norm};
use crate::{EffectiveFieldObservables, ExchangeLlgProblem, FftWorkspace, Vector3};

#[cfg(feature = "parallel")]
use rayon::prelude::*;

impl ExchangeLlgProblem {
    // ===================================================================
    // Observables
    // ===================================================================

    pub(crate) fn observe_vectors_ws_at_time(
        &self,
        magnetization: &[Vector3],
        ws: &mut FftWorkspace,
        time_seconds: f64,
    ) -> EffectiveFieldObservables {
        let exchange_field = if self.terms.exchange {
            self.exchange_field_from_vectors(magnetization)
        } else {
            zero_vectors(self.grid.cell_count())
        };
        let demag_field = if self.terms.demag {
            self.demag_field_from_vectors_ws(magnetization, ws)
        } else {
            zero_vectors(self.grid.cell_count())
        };
        let external_field = self.external_field_vectors();
        let mel_field = self.magnetoelastic_field(magnetization);
        let ani_field = self.anisotropy_field(magnetization);
        let idmi_field = self.interfacial_dmi_field(magnetization);
        let rdmi_field = self.rotated_interfacial_dmi_field(magnetization);
        let bdmi_field = self.bulk_dmi_field(magnetization);
        let dmi_field = idmi_field
            .iter()
            .zip(bdmi_field.iter())
            .map(|(interfacial, bulk)| add(*interfacial, *bulk))
            .collect::<Vec<_>>();
        let mut effective_field =
            combine_fields_4(&exchange_field, &demag_field, &external_field, &mel_field);
        for (i, h) in effective_field.iter_mut().enumerate() {
            *h = add(add(add(*h, ani_field[i]), dmi_field[i]), rdmi_field[i]);
        }
        let mut cylinder_oersted_field = zero_vectors(self.grid.cell_count());
        self.oersted_field_add_into_at_time(&mut cylinder_oersted_field, time_seconds);
        for (effective, oersted) in effective_field
            .iter_mut()
            .zip(cylinder_oersted_field.iter())
        {
            *effective = add(*effective, *oersted);
        }
        self.regional_field_drives_add_into_at_time(&mut effective_field, time_seconds);
        self.thermal_field_add_into(&mut effective_field);
        let mut rhs = {
            let compute =
                |i: usize| self.llg_rhs_from_field_at(i, magnetization[i], effective_field[i]);
            #[cfg(feature = "parallel")]
            {
                (0..magnetization.len())
                    .into_par_iter()
                    .map(compute)
                    .collect::<Vec<_>>()
            }
            #[cfg(not(feature = "parallel"))]
            {
                (0..magnetization.len()).map(compute).collect::<Vec<_>>()
            }
        };
        // Observability owns a raw all-DOF RHS. Do not reuse the mutating
        // final-RHS mask owner here: telemetry must retain pinned STT/SOT and
        // thermal contributions while separately publishing the free subset.
        self.direct_torques_add_into(magnetization, &mut rhs);

        let exchange_energy_joules = if self.terms.exchange {
            self.exchange_energy_from_field(magnetization, &exchange_field)
        } else {
            0.0
        };
        let demag_energy_joules = if self.terms.demag {
            self.demag_energy_from_fields(magnetization, &demag_field)
        } else {
            0.0
        };
        let external_energy_joules = if self.terms.external_field.is_some()
            || self.terms.per_node_field.is_some()
            || self.static_external_field.is_some()
            || self.terms.oersted_cylinder.is_some()
            || self.regional_field_drives.iter().any(|drive| drive.enabled)
        {
            let mut combined_external = external_field
                .iter()
                .zip(cylinder_oersted_field.iter())
                .map(|(external, oersted)| add(*external, *oersted))
                .collect::<Vec<_>>();
            self.regional_field_drives_add_into_at_time(&mut combined_external, time_seconds);
            self.external_energy_from_fields(magnetization, &combined_external)
        } else {
            0.0
        };
        let mel_energy_joules = self.magnetoelastic_energy(magnetization);
        let ani_energy_joules = self.anisotropy_energy(magnetization);
        let dmi_energy_joules = self.dmi_energy_from_vectors(magnetization);
        let total_energy_joules = exchange_energy_joules
            + demag_energy_joules
            + external_energy_joules
            + mel_energy_joules
            + ani_energy_joules
            + dmi_energy_joules;

        let max_effective_field_amplitude = max_norm(&effective_field);
        let max_demag_field_amplitude = max_norm(&demag_field);
        let max_rhs_all_amplitude = max_norm(&rhs);
        let max_torque_all_apm = max_cross_norm(magnetization, &effective_field);
        let max_rhs_amplitude = self
            .frozen_spins()
            .map_or(max_rhs_all_amplitude, |frozen| frozen.max_norm_free(&rhs));
        let max_torque_apm = self.frozen_spins().map_or(max_torque_all_apm, |frozen| {
            frozen.max_cross_norm_free(magnetization, &effective_field)
        });

        EffectiveFieldObservables {
            magnetization: magnetization.to_vec(),
            exchange_field,
            demag_field,
            external_field,
            effective_field: effective_field.clone(),
            dmi_field,
            exchange_energy_joules,
            demag_energy_joules,
            external_energy_joules,
            anisotropy_energy_joules: ani_energy_joules,
            dmi_energy_joules,
            total_energy_joules,
            max_effective_field_amplitude,
            max_demag_field_amplitude,
            max_rhs_amplitude,
            max_rhs_all_amplitude,
            max_torque_Apm: max_torque_apm,
            max_torque_all_Apm: max_torque_all_apm,
        }
    }
}

impl ExchangeLlgProblem {
    pub(crate) fn observable_effective_field_from_vectors_ws_at_time(
        &self,
        magnetization: &[Vector3],
        ws: &mut FftWorkspace,
        time_seconds: f64,
    ) -> Vec<Vector3> {
        let exchange_field = if self.terms.exchange {
            self.exchange_field_from_vectors(magnetization)
        } else {
            zero_vectors(self.grid.cell_count())
        };
        let demag_field = if self.terms.demag {
            self.demag_field_from_vectors_ws(magnetization, ws)
        } else {
            zero_vectors(self.grid.cell_count())
        };
        let external_field = self.external_field_vectors();
        let mel_field = self.magnetoelastic_field(magnetization);
        let ani_field = self.anisotropy_field(magnetization);
        let idmi_field = self.interfacial_dmi_field(magnetization);
        let rdmi_field = self.rotated_interfacial_dmi_field(magnetization);
        let bdmi_field = self.bulk_dmi_field(magnetization);
        let mut h_eff =
            combine_fields_4(&exchange_field, &demag_field, &external_field, &mel_field);
        for (i, h) in h_eff.iter_mut().enumerate() {
            *h = add(
                add(add(add(*h, ani_field[i]), idmi_field[i]), rdmi_field[i]),
                bdmi_field[i],
            );
        }
        self.oersted_field_add_into_at_time(&mut h_eff, time_seconds);
        self.regional_field_drives_add_into_at_time(&mut h_eff, time_seconds);
        h_eff
    }
}
