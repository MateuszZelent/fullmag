//! FDM CPU reference demagnetizing-field realization.

use crate::fdm::cpu::fft_backend::FdmFftBackend;
use crate::vector::scale;
use crate::{ExchangeLlgProblem, FftWorkspace, Vector3, VectorFieldSoA};

impl ExchangeLlgProblem {
    pub(crate) fn demag_field_from_vectors(&self, magnetization: &[Vector3]) -> Vec<Vector3> {
        let mut ws = self.create_workspace();
        self.demag_field_from_vectors_ws(magnetization, &mut ws)
    }

    pub(crate) fn observable_demag_field_from_vectors(
        &self,
        magnetization: &[Vector3],
    ) -> Vec<Vector3> {
        let mut ws = self.create_workspace();
        self.observable_demag_field_from_vectors_ws(magnetization, &mut ws)
    }

    pub(crate) fn demag_field_from_vectors_ws(
        &self,
        magnetization: &[Vector3],
        ws: &mut FftWorkspace,
    ) -> Vec<Vector3> {
        self.demag_field_from_vectors_ws_with_output_mask(magnetization, ws, true)
    }

    pub(crate) fn observable_demag_field_from_vectors_ws(
        &self,
        magnetization: &[Vector3],
        ws: &mut FftWorkspace,
    ) -> Vec<Vector3> {
        self.demag_field_from_vectors_ws_with_output_mask(magnetization, ws, false)
    }

    fn demag_field_from_vectors_ws_with_output_mask(
        &self,
        magnetization: &[Vector3],
        ws: &mut FftWorkspace,
        mask_inactive_output: bool,
    ) -> Vec<Vector3> {
        ws.convolve_moments(|source| {
            if self.is_active(source) {
                scale(magnetization[source], self.ms_at(source))
            } else {
                [0.0; 3]
            }
        });

        let mut field = vec![[0.0, 0.0, 0.0]; self.grid.cell_count()];
        for z in 0..self.grid.nz {
            for y in 0..self.grid.ny {
                for x in 0..self.grid.nx {
                    let dst_index = self.grid.index(x, y, z);
                    field[dst_index] = if !mask_inactive_output || self.is_active(dst_index) {
                        ws.convolved_field_at(x, y, z)
                    } else {
                        [0.0, 0.0, 0.0]
                    };
                }
            }
        }

        field
    }

    pub(crate) fn demag_field_add_into(
        &self,
        magnetization: &[Vector3],
        ws: &mut FftWorkspace,
        h_eff: &mut [Vector3],
    ) {
        ws.convolve_moments(|source| {
            if self.is_active(source) {
                scale(magnetization[source], self.ms_at(source))
            } else {
                [0.0; 3]
            }
        });

        for z in 0..self.grid.nz {
            for y in 0..self.grid.ny {
                for x in 0..self.grid.nx {
                    let dst_index = self.grid.index(x, y, z);
                    if self.is_active(dst_index) {
                        let field = ws.convolved_field_at(x, y, z);
                        h_eff[dst_index][0] += field[0];
                        h_eff[dst_index][1] += field[1];
                        h_eff[dst_index][2] += field[2];
                    }
                }
            }
        }
    }

    pub(crate) fn demag_field_add_into_soa_fft_backend(
        &self,
        magnetization: &VectorFieldSoA,
        fft_backend: &mut dyn FdmFftBackend,
        h_eff: &mut VectorFieldSoA,
    ) {
        fft_backend.convolve_demag(
            magnetization,
            self.material.saturation_magnetisation,
            self.active_mask.as_deref(),
            h_eff,
        );
    }
}
