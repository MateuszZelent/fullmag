use super::math::max_rhs_norm_from_field;
use super::{ffi, NativeFdmBackend};
use crate::derived_fields::max_torque_residual_apm_from_field;
use crate::scalar_metrics::single_object_scalars;
use crate::types::{RunError, StepStats};

impl NativeFdmBackend {
    pub fn refresh_multilayer_demag(&mut self) -> Result<(), RunError> {
        let rc = unsafe { ffi::fullmag_fdm_backend_refresh_multilayer_demag(self.handle) };
        if rc != ffi::FULLMAG_FDM_OK {
            return Err(self.last_error_or("refresh_multilayer_demag failed"));
        }
        Ok(())
    }

    pub fn refresh_observables(&mut self) -> Result<(), RunError> {
        let rc = unsafe { ffi::fullmag_fdm_backend_refresh_observables(self.handle as *mut _) };
        if rc != ffi::FULLMAG_FDM_OK {
            return Err(self.last_error_or("refresh_observables failed"));
        }
        Ok(())
    }

    pub fn snapshot_step_stats(&mut self, grid: [u32; 3]) -> Result<StepStats, RunError> {
        let mut stats = ffi::fullmag_fdm_step_stats {
            step: 0,
            time_seconds: 0.0,
            dt_seconds: 0.0,
            exchange_energy_joules: 0.0,
            demag_energy_joules: 0.0,
            external_energy_joules: 0.0,
            anisotropy_energy_joules: 0.0,
            cubic_energy_joules: 0.0,
            dmi_energy_joules: 0.0,
            total_energy_joules: 0.0,
            max_effective_field_amplitude: 0.0,
            max_demag_field_amplitude: 0.0,
            max_rhs_amplitude: 0.0,
            max_torque_Apm: 0.0,
            suggested_next_dt: 0.0,
            wall_time_ns: 0,
        };

        let rc =
            unsafe { ffi::fullmag_fdm_backend_snapshot_stats(self.handle as *mut _, &mut stats) };
        if rc != ffi::FULLMAG_FDM_OK {
            return Err(self.last_error_or("snapshot_step_stats failed"));
        }

        let cell_count = (grid[0] as usize) * (grid[1] as usize) * (grid[2] as usize);
        let magnetization = self.copy_m(cell_count)?;
        let effective_field = self.copy_h_eff(cell_count)?;
        let torque_apm = if stats.max_torque_Apm > 0.0 {
            stats.max_torque_Apm
        } else {
            max_torque_residual_apm_from_field(&magnetization, &effective_field)
        };
        let mut step_stats = StepStats {
            step: stats.step,
            time: stats.time_seconds,
            dt: stats.dt_seconds,
            e_ex: stats.exchange_energy_joules,
            e_demag: stats.demag_energy_joules,
            e_ext: stats.external_energy_joules,
            e_ani: stats.anisotropy_energy_joules + stats.cubic_energy_joules,
            e_dmi: stats.dmi_energy_joules,
            e_total: stats.total_energy_joules,
            max_dm_dt: max_rhs_norm_from_field(
                &magnetization,
                &effective_field,
                self.damping,
                self.gyromagnetic_ratio,
                self.precession_enabled,
            ),
            max_h_eff: stats.max_effective_field_amplitude,
            max_h_demag: stats.max_demag_field_amplitude,
            max_torque_Apm: torque_apm,
            max_torque_T: torque_apm * crate::MU0,
            wall_time_ns: stats.wall_time_ns,
            ..StepStats::default()
        };
        crate::scalar_metrics::apply_average_m_to_step_stats_with_active_mask(
            &mut step_stats,
            &magnetization,
            self.active_mask.as_deref(),
        );
        step_stats.per_object_scalars = single_object_scalars("free", &step_stats);
        Ok(step_stats)
    }
}
