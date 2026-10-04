//! External and regional field realizations for the FDM CPU reference lane.

use super::{ExchangeLlgProblem, Vector3, VectorFieldSoA};

#[cfg(feature = "parallel")]
use rayon::prelude::*;

impl ExchangeLlgProblem {
    // ===================================================================
    // External and regional field terms
    // ===================================================================

    pub(crate) fn external_field_vectors(&self) -> Vec<Vector3> {
        let external = self.terms.external_field.unwrap_or([0.0, 0.0, 0.0]);
        (0..self.grid.cell_count())
            .map(|i| {
                if !self.is_active(i) {
                    return [0.0, 0.0, 0.0];
                }
                let mut value = external;
                if let Some(per_node_field) = self.terms.per_node_field.as_ref() {
                    if let Some(node_value) = per_node_field.get(i) {
                        value[0] += node_value[0];
                        value[1] += node_value[1];
                        value[2] += node_value[2];
                    }
                }
                if let Some(static_field) = self.static_external_field.as_ref() {
                    if let Some(node_value) = static_field.get(i) {
                        value[0] += node_value[0];
                        value[1] += node_value[1];
                        value[2] += node_value[2];
                    }
                }
                value
            })
            .collect()
    }

    pub(crate) fn has_external_zeeman_source(&self) -> bool {
        self.terms.external_field.is_some()
            || self.terms.per_node_field.is_some()
            || self.static_external_field.is_some()
            || self.terms.oersted_cylinder.is_some()
    }

    pub(crate) fn external_zeeman_field_vectors(&self) -> Vec<Vector3> {
        self.external_zeeman_field_vectors_at_time(0.0)
    }

    pub(crate) fn external_zeeman_field_vectors_at_time(&self, time_seconds: f64) -> Vec<Vector3> {
        let mut field = self.external_field_vectors();
        self.oersted_field_add_into_at_time(&mut field, time_seconds);
        field
    }

    pub(crate) fn external_field_add_into(&self, h_eff: &mut [Vector3]) {
        let ext = self.terms.external_field.unwrap_or([0.0, 0.0, 0.0]);
        let per_node_field = self.terms.per_node_field.as_ref();
        let static_field = self.static_external_field.as_ref();
        if self.terms.external_field.is_some() || per_node_field.is_some() || static_field.is_some()
        {
            #[cfg(feature = "parallel")]
            {
                h_eff.par_iter_mut().enumerate().for_each(|(i, h)| {
                    if self.is_active(i) {
                        h[0] += ext[0];
                        h[1] += ext[1];
                        h[2] += ext[2];
                        if let Some(value) = per_node_field.and_then(|field| field.get(i)) {
                            h[0] += value[0];
                            h[1] += value[1];
                            h[2] += value[2];
                        }
                        if let Some(value) = static_field.and_then(|field| field.get(i)) {
                            h[0] += value[0];
                            h[1] += value[1];
                            h[2] += value[2];
                        }
                    }
                });
            }
            #[cfg(not(feature = "parallel"))]
            {
                for i in 0..h_eff.len() {
                    if self.is_active(i) {
                        h_eff[i][0] += ext[0];
                        h_eff[i][1] += ext[1];
                        h_eff[i][2] += ext[2];
                        if let Some(value) = per_node_field.and_then(|field| field.get(i)) {
                            h_eff[i][0] += value[0];
                            h_eff[i][1] += value[1];
                            h_eff[i][2] += value[2];
                        }
                        if let Some(value) = static_field.and_then(|field| field.get(i)) {
                            h_eff[i][0] += value[0];
                            h_eff[i][1] += value[1];
                            h_eff[i][2] += value[2];
                        }
                    }
                }
            }
        }
    }

    pub(crate) fn regional_field_drives_add_into_at_time(
        &self,
        h_eff: &mut [Vector3],
        time_seconds: f64,
    ) {
        for drive in self
            .regional_field_drives
            .iter()
            .filter(|drive| drive.enabled)
        {
            let multiplier = drive.multiplier_at(time_seconds);
            for (index, basis) in drive.basis_field.iter().enumerate().take(h_eff.len()) {
                if self.is_active(index) {
                    h_eff[index][0] += multiplier * basis[0];
                    h_eff[index][1] += multiplier * basis[1];
                    h_eff[index][2] += multiplier * basis[2];
                }
            }
        }
    }

    pub(crate) fn external_field_add_into_soa(&self, h_eff: &mut VectorFieldSoA) {
        let ext = self.terms.external_field.unwrap_or([0.0, 0.0, 0.0]);
        let per_node_field = self.terms.per_node_field.as_ref();
        let static_field = self.static_external_field.as_ref();
        if self.terms.external_field.is_none() && per_node_field.is_none() && static_field.is_none()
        {
            return;
        }

        for i in 0..self.grid.cell_count() {
            if self.is_active(i) {
                h_eff.x[i] += ext[0];
                h_eff.y[i] += ext[1];
                h_eff.z[i] += ext[2];
                if let Some(value) = per_node_field.and_then(|field| field.get(i)) {
                    h_eff.x[i] += value[0];
                    h_eff.y[i] += value[1];
                    h_eff.z[i] += value[2];
                }
                if let Some(value) = static_field.and_then(|field| field.get(i)) {
                    h_eff.x[i] += value[0];
                    h_eff.y[i] += value[1];
                    h_eff.z[i] += value[2];
                }
            }
        }
    }

    pub(crate) fn regional_field_drives_add_into_soa_at_time(
        &self,
        h_eff: &mut VectorFieldSoA,
        time_seconds: f64,
    ) {
        for drive in self
            .regional_field_drives
            .iter()
            .filter(|drive| drive.enabled)
        {
            let multiplier = drive.multiplier_at(time_seconds);
            for (index, basis) in drive.basis_field.iter().enumerate().take(h_eff.len()) {
                if self.is_active(index) {
                    h_eff.x[index] += multiplier * basis[0];
                    h_eff.y[index] += multiplier * basis[1];
                    h_eff.z[index] += multiplier * basis[2];
                }
            }
        }
    }
}
