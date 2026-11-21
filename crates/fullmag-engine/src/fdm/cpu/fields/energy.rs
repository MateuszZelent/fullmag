//! FDM reference energy calculations for `ExchangeLlgProblem`.

use super::anisotropy_energy_density_for_magnetization;
use crate::fdm::cpu::fft::{combine_fields_4, zero_vectors};
use crate::fdm::cpu::fft_backend::FdmFftBackend;
use crate::fdm::shared::types::{neighbor_index, AxisBoundary};
use crate::fdm::shared::VectorFieldSoA;
use crate::vector::{add, cross, dot, norm, scale, squared_norm, sub};
use crate::{ExchangeLlgProblem, FftWorkspace, Vector3, MU0};

#[cfg(feature = "parallel")]
use rayon::prelude::*;

impl ExchangeLlgProblem {
    // Total-energy ownership stays together while the field and RHS modules are split.
    pub fn total_energy_from_soa_ws(
        &self,
        magnetization: &VectorFieldSoA,
        ws: &mut FftWorkspace,
        scratch: &mut VectorFieldSoA,
    ) -> f64 {
        let mut total = 0.0;

        if self.terms.exchange {
            scratch.fill_zero();
            self.exchange_field_add_into_soa(magnetization, scratch);
            total += self.half_field_energy_from_soa(magnetization, scratch);
        }
        if self.terms.demag {
            scratch.fill_zero();
            self.demag_field_add_into_soa_fft_backend(magnetization, ws, scratch);
            total += self.half_field_energy_from_soa(magnetization, scratch);
        }
        if self.has_external_zeeman_source() {
            scratch.fill_zero();
            self.external_field_add_into_soa(scratch);
            self.oersted_field_add_into_soa(scratch);
            total += self.full_field_energy_from_soa(magnetization, scratch);
        }
        if self.regional_field_drives.iter().any(|drive| drive.enabled) {
            scratch.fill_zero();
            for drive in self
                .regional_field_drives
                .iter()
                .filter(|drive| drive.enabled)
            {
                let multiplier = drive.multiplier_at(0.0);
                for (index, basis) in drive.basis_field.iter().enumerate().take(scratch.len()) {
                    if self.is_active(index) {
                        scratch.x[index] += multiplier * basis[0];
                        scratch.y[index] += multiplier * basis[1];
                        scratch.z[index] += multiplier * basis[2];
                    }
                }
            }
            total += self.full_field_energy_from_soa(magnetization, scratch);
        }
        total += self.magnetoelastic_energy_soa(magnetization);
        if self.terms.uniaxial_anisotropy.is_some() || self.terms.cubic_anisotropy.is_some() {
            total += self.anisotropy_energy_from_soa(magnetization);
        }
        total += self.dmi_energy_from_soa(magnetization);

        total
    }

    pub fn total_energy_from_vectors_ws(
        &self,
        magnetization: &[Vector3],
        ws: &mut FftWorkspace,
    ) -> f64 {
        let mut total = 0.0;

        if self.terms.exchange {
            let h_ex = self.exchange_field_from_vectors(magnetization);
            total += self.exchange_energy_from_field(magnetization, &h_ex);
        }
        if self.terms.demag {
            let h_demag = self.demag_field_from_vectors_ws(magnetization, ws);
            total += self.demag_energy_from_fields(magnetization, &h_demag);
        }
        if self.has_external_zeeman_source() {
            let h_ext = self.external_zeeman_field_vectors();
            total += self.external_energy_from_fields(magnetization, &h_ext);
        }
        if self.regional_field_drives.iter().any(|drive| drive.enabled) {
            let h_drive = self.regional_drive_field_at_time(0.0);
            total += self.external_energy_from_fields(magnetization, &h_drive);
        }
        total += self.magnetoelastic_energy(magnetization);
        if self.terms.uniaxial_anisotropy.is_some() || self.terms.cubic_anisotropy.is_some() {
            total += self.anisotropy_energy(magnetization);
        }
        total += self.dmi_energy_from_vectors(magnetization);

        total
    }

    /// Computes the energy and, when `accept` returns true, the field from the
    /// same demag convolution. A rejected evaluation leaves the output field untouched.
    #[doc(hidden)]
    pub fn total_energy_and_field_if_accepted_soa_ws<F>(
        &self,
        magnetization: &VectorFieldSoA,
        ws: &mut FftWorkspace,
        scratch: &mut VectorFieldSoA,
        effective_field_out: &mut VectorFieldSoA,
        time_seconds: f64,
        accept: F,
    ) -> (f64, bool)
    where
        F: FnOnce(f64) -> bool,
    {
        let energy = self.total_energy_from_soa_ws(magnetization, ws, scratch);
        if accept(energy) {
            debug_assert_eq!(effective_field_out.len(), magnetization.len());
            let mut backend = CachedDemagFftBackend {
                workspace: ws,
                nx: self.grid.nx,
                ny: self.grid.ny,
                nz: self.grid.nz,
            };
            self.effective_field_into_soa_fft_backend_at_time(
                magnetization,
                &mut backend,
                effective_field_out,
                time_seconds,
            );
            (energy, true)
        } else {
            (energy, false)
        }
    }

    /// Computes the energy and, when `accept` returns true, the field from the
    /// same demag convolution. A rejected evaluation leaves the output field untouched.
    #[doc(hidden)]
    pub fn total_energy_and_field_if_accepted_vectors_ws<F>(
        &self,
        magnetization: &[Vector3],
        ws: &mut FftWorkspace,
        effective_field_out: &mut [Vector3],
        time_seconds: f64,
        accept: F,
    ) -> (f64, bool)
    where
        F: FnOnce(f64) -> bool,
    {
        let energy = self.total_energy_from_vectors_ws(magnetization, ws);
        debug_assert_eq!(effective_field_out.len(), magnetization.len());
        if accept(energy) {
            effective_field_out.clone_from_slice(
                &self.effective_field_from_vectors_with_cached_demag(
                    magnetization,
                    ws,
                    time_seconds,
                ),
            );
            (energy, true)
        } else {
            (energy, false)
        }
    }

    fn effective_field_from_vectors_with_cached_demag(
        &self,
        magnetization: &[Vector3],
        ws: &FftWorkspace,
        time_seconds: f64,
    ) -> Vec<Vector3> {
        let n = self.grid.cell_count();
        let exchange_field = if self.terms.exchange {
            self.exchange_field_from_vectors(magnetization)
        } else {
            zero_vectors(n)
        };
        let demag_field = if self.terms.demag {
            let mut field = zero_vectors(n);
            for z in 0..self.grid.nz {
                for y in 0..self.grid.ny {
                    for x in 0..self.grid.nx {
                        let index = self.grid.index(x, y, z);
                        if self.is_active(index) {
                            field[index] = ws.convolved_field_at(x, y, z);
                        }
                    }
                }
            }
            field
        } else {
            zero_vectors(n)
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
        self.thermal_field_add_into(&mut h_eff);
        self.oersted_field_add_into_at_time(&mut h_eff, time_seconds);
        self.regional_field_drives_add_into_at_time(&mut h_eff, time_seconds);
        h_eff
    }

    pub(crate) fn half_field_energy_from_soa(
        &self,
        magnetization: &VectorFieldSoA,
        field: &VectorFieldSoA,
    ) -> f64 {
        self.field_energy_from_soa(magnetization, field, -0.5 * MU0)
    }

    pub(crate) fn full_field_energy_from_soa(
        &self,
        magnetization: &VectorFieldSoA,
        field: &VectorFieldSoA,
    ) -> f64 {
        self.field_energy_from_soa(magnetization, field, -MU0)
    }

    pub(crate) fn field_energy_from_soa(
        &self,
        magnetization: &VectorFieldSoA,
        field: &VectorFieldSoA,
        mu0_scale: f64,
    ) -> f64 {
        let n = magnetization.len();
        debug_assert!(field.len() >= n);
        let volume_scale = mu0_scale * self.cell_size.volume();
        let compute = |i: usize| {
            if !self.is_active(i) {
                return 0.0;
            }
            volume_scale
                * self.ms_at(i)
                * (magnetization.x[i] * field.x[i]
                    + magnetization.y[i] * field.y[i]
                    + magnetization.z[i] * field.z[i])
        };
        #[cfg(feature = "parallel")]
        {
            (0..n).into_par_iter().map(compute).sum()
        }
        #[cfg(not(feature = "parallel"))]
        {
            (0..n).map(compute).sum()
        }
    }
}

struct CachedDemagFftBackend<'a> {
    workspace: &'a FftWorkspace,
    nx: usize,
    ny: usize,
    nz: usize,
}

impl FdmFftBackend for CachedDemagFftBackend<'_> {
    fn convolve_demag(
        &mut self,
        magnetization: &VectorFieldSoA,
        _saturation_magnetisation: f64,
        active_mask: Option<&[bool]>,
        out_h: &mut VectorFieldSoA,
    ) {
        debug_assert_eq!(magnetization.len(), self.nx * self.ny * self.nz);
        if let Some(mask) = active_mask {
            debug_assert_eq!(mask.len(), magnetization.len());
        }
        for z in 0..self.nz {
            for y in 0..self.ny {
                for x in 0..self.nx {
                    let index = x + self.nx * (y + self.ny * z);
                    if active_mask.map(|mask| mask[index]).unwrap_or(true) {
                        let field = self.workspace.convolved_field_at(x, y, z);
                        out_h.x[index] += field[0];
                        out_h.y[index] += field[1];
                        out_h.z[index] += field[2];
                    }
                }
            }
        }
    }

    fn name(&self) -> &'static str {
        "cached-rustfft-demag"
    }
}

impl ExchangeLlgProblem {
    // ===================================================================
    // Energy calculations
    // ===================================================================

    pub fn exchange_energy_from_vectors(&self, magnetization: &[Vector3]) -> f64 {
        if let Some(faces) = self.exchange_faces.as_deref() {
            return self.exchange_energy_from_faces(faces, magnetization);
        }
        let cell_volume = self.cell_size.volume();
        let grid = self.grid;
        let dx2 = self.cell_size.dx * self.cell_size.dx;
        let dy2 = self.cell_size.dy * self.cell_size.dy;
        let dz2 = self.cell_size.dz * self.cell_size.dz;
        let pbc_x = matches!(self.boundary_policy.x, AxisBoundary::Periodic);
        let pbc_y = matches!(self.boundary_policy.y, AxisBoundary::Periodic);
        let pbc_z = matches!(self.boundary_policy.z, AxisBoundary::Periodic);

        let compute_cell_energy = |flat_index: usize| -> f64 {
            if !self.is_active(flat_index) {
                return 0.0;
            }
            let x = flat_index % grid.nx;
            let y = (flat_index / grid.nx) % grid.ny;
            let z = flat_index / (grid.nx * grid.ny);
            let center = magnetization[flat_index];
            let ai = self.a_at(flat_index);
            let mut e = 0.0;
            if x + 1 < grid.nx || (pbc_x && grid.nx > 1) {
                let nx = if x + 1 < grid.nx { x + 1 } else { 0 };
                let neighbor_index = grid.index(nx, y, z);
                if self.is_active(neighbor_index) {
                    let aj = self.a_at(neighbor_index);
                    let aij = if ai == 0.0 || aj == 0.0 {
                        0.0
                    } else {
                        2.0 * ai * aj / (ai + aj)
                    };
                    let neighbor = magnetization[neighbor_index];
                    e += aij * cell_volume * squared_norm(sub(neighbor, center)) / dx2;
                }
            }
            if y + 1 < grid.ny || (pbc_y && grid.ny > 1) {
                let ny = if y + 1 < grid.ny { y + 1 } else { 0 };
                let neighbor_index = grid.index(x, ny, z);
                if self.is_active(neighbor_index) {
                    let aj = self.a_at(neighbor_index);
                    let aij = if ai == 0.0 || aj == 0.0 {
                        0.0
                    } else {
                        2.0 * ai * aj / (ai + aj)
                    };
                    let neighbor = magnetization[neighbor_index];
                    e += aij * cell_volume * squared_norm(sub(neighbor, center)) / dy2;
                }
            }
            if z + 1 < grid.nz || (pbc_z && grid.nz > 1) {
                let nz = if z + 1 < grid.nz { z + 1 } else { 0 };
                let neighbor_index = grid.index(x, y, nz);
                if self.is_active(neighbor_index) {
                    let aj = self.a_at(neighbor_index);
                    let aij = if ai == 0.0 || aj == 0.0 {
                        0.0
                    } else {
                        2.0 * ai * aj / (ai + aj)
                    };
                    let neighbor = magnetization[neighbor_index];
                    e += aij * cell_volume * squared_norm(sub(neighbor, center)) / dz2;
                }
            }
            e
        };

        #[cfg(feature = "parallel")]
        {
            (0..grid.cell_count())
                .into_par_iter()
                .map(compute_cell_energy)
                .sum()
        }
        #[cfg(not(feature = "parallel"))]
        {
            (0..grid.cell_count()).map(compute_cell_energy).sum()
        }
    }

    /// `E = V sum_{f in F+} A_f |m_j - m_i|^2 / h_f^2` (note 0104,
    /// `material-fdm-exchange-energy-discrete`), including periodic
    /// connections; a zero coefficient marks a missing connection.
    fn exchange_energy_from_faces(
        &self,
        faces: &crate::ExchangeFaces,
        magnetization: &[Vector3],
    ) -> f64 {
        let grid = self.grid;
        let dims = [grid.nx, grid.ny, grid.nz];
        let periodic = [
            matches!(self.boundary_policy.x, AxisBoundary::Periodic),
            matches!(self.boundary_policy.y, AxisBoundary::Periodic),
            matches!(self.boundary_policy.z, AxisBoundary::Periodic),
        ];
        let dist2 = [
            self.cell_size.dx * self.cell_size.dx,
            self.cell_size.dy * self.cell_size.dy,
            self.cell_size.dz * self.cell_size.dz,
        ];
        let cell_volume = self.cell_size.volume();
        let compute_cell_energy = |flat_index: usize| -> f64 {
            let coords = [
                flat_index % grid.nx,
                (flat_index / grid.nx) % grid.ny,
                flat_index / (grid.nx * grid.ny),
            ];
            let center = magnetization[flat_index];
            let mut e = 0.0;
            for (axis, plus_faces) in [&faces.x_plus, &faces.y_plus, &faces.z_plus]
                .into_iter()
                .enumerate()
            {
                let a_f = plus_faces[flat_index];
                if a_f == 0.0 {
                    continue;
                }
                let mut neighbor = coords;
                neighbor[axis] = neighbor_index(coords[axis], dims[axis], 1, periodic[axis]);
                let neighbor_flat = grid.index(neighbor[0], neighbor[1], neighbor[2]);
                e += a_f * cell_volume * squared_norm(sub(magnetization[neighbor_flat], center))
                    / dist2[axis];
            }
            e
        };

        #[cfg(feature = "parallel")]
        {
            (0..grid.cell_count())
                .into_par_iter()
                .map(compute_cell_energy)
                .sum()
        }
        #[cfg(not(feature = "parallel"))]
        {
            (0..grid.cell_count()).map(compute_cell_energy).sum()
        }
    }

    pub(crate) fn exchange_energy_from_field(
        &self,
        magnetization: &[Vector3],
        exchange_field: &[Vector3],
    ) -> f64 {
        let cell_volume = self.cell_size.volume();
        self.exchange_energy_density_from_field(magnetization, exchange_field)
            .into_iter()
            .map(|density| density * cell_volume)
            .sum()
    }

    pub fn exchange_energy_density_from_field(
        &self,
        magnetization: &[Vector3],
        exchange_field: &[Vector3],
    ) -> Vec<f64> {
        self.field_dot_energy_density(magnetization, exchange_field, -0.5)
    }

    pub(crate) fn demag_energy_from_fields(
        &self,
        magnetization: &[Vector3],
        demag_field: &[Vector3],
    ) -> f64 {
        let cell_volume = self.cell_size.volume();
        self.demag_energy_density_from_fields(magnetization, demag_field)
            .into_iter()
            .map(|density| density * cell_volume)
            .sum()
    }

    pub fn demag_energy_density_from_fields(
        &self,
        magnetization: &[Vector3],
        demag_field: &[Vector3],
    ) -> Vec<f64> {
        self.field_dot_energy_density(magnetization, demag_field, -0.5)
    }

    pub(crate) fn external_energy_from_fields(
        &self,
        magnetization: &[Vector3],
        external_field: &[Vector3],
    ) -> f64 {
        let cell_volume = self.cell_size.volume();
        self.external_energy_density_from_fields(magnetization, external_field)
            .into_iter()
            .map(|density| density * cell_volume)
            .sum()
    }

    pub fn external_energy_density_from_fields(
        &self,
        magnetization: &[Vector3],
        external_field: &[Vector3],
    ) -> Vec<f64> {
        self.field_dot_energy_density(magnetization, external_field, -1.0)
    }

    pub fn anisotropy_energy_density_from_vectors(&self, magnetization: &[Vector3]) -> Vec<f64> {
        let uni_data = self.terms.uniaxial_anisotropy.as_ref().map(|uni| {
            let n = norm(uni.axis).max(1e-30);
            (scale(uni.axis, 1.0 / n), uni.ku1, uni.ku2)
        });
        let cub_data = self.terms.cubic_anisotropy.as_ref().map(|cub| {
            let n1 = norm(cub.axis1).max(1e-30);
            let n2 = norm(cub.axis2).max(1e-30);
            let c1 = scale(cub.axis1, 1.0 / n1);
            let c2 = scale(cub.axis2, 1.0 / n2);
            (c1, c2, cross(c1, c2), cub.kc1, cub.kc2, cub.kc3)
        });

        magnetization
            .iter()
            .enumerate()
            .map(|(i, &m)| {
                self.is_active(i)
                    .then(|| anisotropy_energy_density_for_magnetization(m, uni_data, cub_data))
                    .unwrap_or(0.0)
            })
            .collect()
    }

    fn field_dot_energy_density(
        &self,
        magnetization: &[Vector3],
        field: &[Vector3],
        prefactor: f64,
    ) -> Vec<f64> {
        let compute = |i: usize| {
            if self.is_active(i) {
                let ms = self.ms_at(i);
                prefactor * MU0 * ms * dot(magnetization[i], field[i])
            } else {
                0.0
            }
        };
        #[cfg(feature = "parallel")]
        {
            (0..magnetization.len())
                .into_par_iter()
                .map(compute)
                .collect()
        }
        #[cfg(not(feature = "parallel"))]
        {
            (0..magnetization.len()).map(compute).collect()
        }
    }
}

#[cfg(test)]
mod demag_cache_tests {
    use super::*;
    use crate::{
        CellSize, CubicAnisotropyConfig, EffectiveFieldTerms, GridShape, LlgConfig,
        MaterialParameters, TimeIntegrator, UniaxialAnisotropyConfig,
    };

    fn problem() -> ExchangeLlgProblem {
        let terms = EffectiveFieldTerms {
            exchange: true,
            demag: true,
            external_field: Some([2.0e3, -1.0e3, 3.0e3]),
            uniaxial_anisotropy: Some(UniaxialAnisotropyConfig {
                ku1: 2.0e3,
                ku2: 3.0e2,
                axis: [0.0, 0.0, 1.0],
            }),
            cubic_anisotropy: Some(CubicAnisotropyConfig {
                kc1: 4.0e2,
                kc2: -1.0e2,
                kc3: 0.0,
                axis1: [1.0, 0.0, 0.0],
                axis2: [0.0, 1.0, 0.0],
            }),
            interfacial_dmi: Some(1.0e-4),
            rotated_interfacial_dmi: Some(-2.0e-5),
            bulk_dmi: Some(3.0e-5),
            ..Default::default()
        };
        ExchangeLlgProblem::with_terms_and_mask(
            GridShape::new(4, 2, 1).expect("valid grid"),
            CellSize::new(2.0e-9, 2.0e-9, 2.0e-9).expect("valid cell size"),
            MaterialParameters::new(8.0e5, 1.3e-11, 0.2).expect("valid material"),
            LlgConfig::new(2.211e5, TimeIntegrator::Heun).expect("valid LLG config"),
            terms,
            Some(vec![true, true, true, true, true, true, true, false]),
        )
        .expect("valid masked problem")
    }

    fn states() -> (Vec<Vector3>, Vec<Vector3>) {
        let diagonal = 0.7071067811865475;
        let triagonal = 0.5773502691896258;
        (
            vec![
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [diagonal, diagonal, 0.0],
                [diagonal, 0.0, diagonal],
                [0.0, diagonal, diagonal],
                [triagonal, triagonal, triagonal],
                [0.0; 3],
            ],
            vec![
                [0.8, 0.6, 0.0],
                [0.0, 0.8, 0.6],
                [0.6, 0.0, 0.8],
                [0.0, diagonal, diagonal],
                [diagonal, 0.0, diagonal],
                [diagonal, diagonal, 0.0],
                [triagonal, -triagonal, triagonal],
                [0.0; 3],
            ],
        )
    }

    fn assert_fields_close(actual: &[Vector3], expected: &[Vector3]) {
        assert_eq!(actual.len(), expected.len());
        for (actual, expected) in actual.iter().zip(expected) {
            for component in 0..3 {
                let scale = actual[component]
                    .abs()
                    .max(expected[component].abs())
                    .max(1.0);
                assert!(
                    (actual[component] - expected[component]).abs() <= 2.0e-13 * scale,
                    "cached field differs: {actual:?} vs {expected:?}"
                );
            }
        }
    }

    #[test]
    fn aos_rejected_trial_skips_field_and_accepted_trial_reuses_energy_demag() {
        let problem = problem();
        let (rejected_state, accepted_state) = states();
        let mut cached_ws = problem.create_workspace();
        let sentinel = [123.0, -456.0, 789.0];
        let mut cached_field = vec![sentinel; accepted_state.len()];
        let (rejected_energy, rejected_accepted) = problem
            .total_energy_and_field_if_accepted_vectors_ws(
                &rejected_state,
                &mut cached_ws,
                &mut cached_field,
                0.0,
                |_| false,
            );
        assert!(rejected_energy.is_finite());
        assert!(!rejected_accepted);
        assert!(cached_field.iter().all(|field| *field == sentinel));

        // The accepted evaluation replaces the rejected trial's workspace output.
        let (cached_energy, accepted) = problem.total_energy_and_field_if_accepted_vectors_ws(
            &accepted_state,
            &mut cached_ws,
            &mut cached_field,
            0.0,
            |_| true,
        );
        assert!(accepted);
        let cached_telemetry = cached_ws.telemetry();

        let mut reference_ws = problem.create_workspace();
        let reference_energy =
            problem.total_energy_from_vectors_ws(&accepted_state, &mut reference_ws);
        let reference_field =
            problem.effective_field_from_vectors_ws(&accepted_state, &mut reference_ws);
        let reference_telemetry = reference_ws.telemetry();

        assert!(
            (cached_energy - reference_energy).abs() <= 1.0e-13 * reference_energy.abs().max(1e-30)
        );
        assert_fields_close(&cached_field, &reference_field);
        assert_eq!(cached_telemetry.forward_fft_count, 6);
        assert_eq!(cached_telemetry.inverse_fft_count, 6);
        assert_eq!(reference_telemetry.forward_fft_count, 6);
        assert_eq!(reference_telemetry.inverse_fft_count, 6);
    }

    #[test]
    fn soa_rejected_trial_skips_field_and_accepted_trial_reuses_energy_demag() {
        let problem = problem();
        let (rejected_state, accepted_state) = states();
        let rejected = VectorFieldSoA::from_aos(&rejected_state);
        let accepted = VectorFieldSoA::from_aos(&accepted_state);
        let mut cached_ws = problem.create_workspace();
        let mut cached_scratch = VectorFieldSoA::zeros(accepted.len());
        let sentinel = [123.0, -456.0, 789.0];
        let mut cached_field = VectorFieldSoA::from_aos(&vec![sentinel; accepted.len()]);
        let (rejected_energy, rejected_accepted) = problem
            .total_energy_and_field_if_accepted_soa_ws(
                &rejected,
                &mut cached_ws,
                &mut cached_scratch,
                &mut cached_field,
                0.0,
                |_| false,
            );
        assert!(rejected_energy.is_finite());
        assert!(!rejected_accepted);
        assert!(cached_field
            .gather_to_aos()
            .iter()
            .all(|field| *field == sentinel));

        // The accepted evaluation replaces the rejected trial's workspace output.
        let (cached_energy, accepted_trial) = problem.total_energy_and_field_if_accepted_soa_ws(
            &accepted,
            &mut cached_ws,
            &mut cached_scratch,
            &mut cached_field,
            0.0,
            |_| true,
        );
        assert!(accepted_trial);
        let cached_field = cached_field.gather_to_aos();
        let cached_telemetry = cached_ws.telemetry();

        let mut reference_ws = problem.create_workspace();
        let mut reference_scratch = VectorFieldSoA::zeros(accepted.len());
        let reference_energy =
            problem.total_energy_from_soa_ws(&accepted, &mut reference_ws, &mut reference_scratch);
        let mut reference_field_soa = VectorFieldSoA::zeros(accepted.len());
        problem.effective_field_into_soa_ws(&accepted, &mut reference_ws, &mut reference_field_soa);
        let reference_field = reference_field_soa.gather_to_aos();
        let reference_telemetry = reference_ws.telemetry();

        assert!(
            (cached_energy - reference_energy).abs() <= 1.0e-13 * reference_energy.abs().max(1e-30)
        );
        assert_fields_close(&cached_field, &reference_field);
        assert_eq!(cached_telemetry.forward_fft_count, 6);
        assert_eq!(cached_telemetry.inverse_fft_count, 6);
        assert_eq!(reference_telemetry.forward_fft_count, 6);
        assert_eq!(reference_telemetry.inverse_fft_count, 6);
    }
}
