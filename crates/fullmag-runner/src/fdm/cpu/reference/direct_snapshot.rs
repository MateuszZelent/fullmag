use fullmag_engine::{ExchangeLlgProblem, ExchangeLlgState, Vector3};

use crate::derived_fields::compute_torque_field;
use crate::preview::{build_grid_preview_field, build_grid_scalar_preview_field};
use crate::quantities::normalized_quantity_name;
use crate::types::{LivePreviewRequest, RunError};

#[cfg(test)]
use super::increment_direct_h_eff_assembly_calls;

pub(super) fn build_direct_preview_field_if_available(
    problem: &ExchangeLlgProblem,
    state: &ExchangeLlgState,
    request: &LivePreviewRequest,
    grid: [u32; 3],
    active_mask: Option<&[bool]>,
) -> Result<Option<crate::LivePreviewField>, RunError> {
    let mut direct_fields = DirectFieldSnapshotCache::new(problem, state);
    let Some(values) = select_direct_preview_values(&mut direct_fields, &request.quantity)? else {
        return Ok(None);
    };
    Ok(Some(match values {
        DirectPreviewValues::Vector(values) => {
            build_grid_preview_field(request, &values, grid, active_mask)
        }
        DirectPreviewValues::Scalar(values) => {
            build_grid_scalar_preview_field(request, &values, grid, active_mask)
        }
    }))
}

pub(super) enum DirectPreviewValues {
    Vector(Vec<Vector3>),
    Scalar(Vec<f64>),
}

pub(super) fn select_direct_preview_values(
    direct_fields: &mut DirectFieldSnapshotCache<'_>,
    quantity: &str,
) -> Result<Option<DirectPreviewValues>, RunError> {
    let quantity = normalized_quantity_name(quantity)?;
    if direct_field_values_available(quantity) {
        return direct_fields
            .select(quantity)
            .map(DirectPreviewValues::Vector)
            .map(Some);
    }
    if direct_scalar_values_available(quantity) {
        return direct_fields
            .select_scalar(quantity)
            .map(DirectPreviewValues::Scalar)
            .map(Some);
    }
    Ok(None)
}

pub(super) fn direct_field_values_available(name: &str) -> bool {
    let (base, component) = match name.split_once('.') {
        Some((base, component)) => (base, Some(component)),
        None => (name, None),
    };
    matches!(
        base,
        "m" | "H_ex" | "H_demag" | "H_ext" | "H_ani" | "H_dmi" | "H_OE" | "H_eff" | "torque"
    ) && component.map_or(true, |component| matches!(component, "x" | "y" | "z"))
}

fn direct_scalar_values_available(name: &str) -> bool {
    matches!(
        name,
        "eden_ex" | "eden_demag" | "eden_ext" | "eden_ani" | "eden_dmi" | "eden_total"
    )
}

pub(super) struct DirectFieldSnapshotCache<'a> {
    problem: &'a ExchangeLlgProblem,
    state: &'a ExchangeLlgState,
    magnetization: Option<Vec<Vector3>>,
    exchange_field: Option<Vec<Vector3>>,
    demag_field: Option<Vec<Vector3>>,
    external_field: Option<Vec<Vector3>>,
    anisotropy_field: Option<Vec<Vector3>>,
    dmi_field: Option<Vec<Vector3>>,
    oersted_field: Option<Vec<Vector3>>,
    effective_field: Option<Vec<Vector3>>,
    torque_field: Option<Vec<Vector3>>,
}

impl<'a> DirectFieldSnapshotCache<'a> {
    pub(super) fn new(problem: &'a ExchangeLlgProblem, state: &'a ExchangeLlgState) -> Self {
        Self {
            problem,
            state,
            magnetization: None,
            exchange_field: None,
            demag_field: None,
            external_field: None,
            anisotropy_field: None,
            dmi_field: None,
            oersted_field: None,
            effective_field: None,
            torque_field: None,
        }
    }

    pub(super) fn select(&mut self, name: &str) -> Result<Vec<Vector3>, RunError> {
        let (base, component) = match name.split_once('.') {
            Some((base, component)) => (base, Some(component)),
            None => (name, None),
        };
        let values = self.base_values(base, name)?;
        project_component(values, component, name)
    }

    pub(super) fn select_scalar(&mut self, name: &str) -> Result<Vec<f64>, RunError> {
        match name {
            "eden_ex" => {
                let magnetization = self.base_values("m", name)?.to_vec();
                let field = self.base_values("H_ex", name)?.to_vec();
                Ok(self
                    .problem
                    .exchange_energy_density_from_field(&magnetization, &field))
            }
            "eden_demag" => {
                let magnetization = self.base_values("m", name)?.to_vec();
                let field = self.base_values("H_demag", name)?.to_vec();
                Ok(self
                    .problem
                    .demag_energy_density_from_fields(&magnetization, &field))
            }
            "eden_ext" => {
                let magnetization = self.base_values("m", name)?.to_vec();
                let field = self.base_values("H_ext", name)?.to_vec();
                Ok(self
                    .problem
                    .external_energy_density_from_fields(&magnetization, &field))
            }
            "eden_ani" => {
                let magnetization = self.base_values("m", name)?.to_vec();
                Ok(self
                    .problem
                    .anisotropy_energy_density_from_vectors(&magnetization))
            }
            "eden_dmi" => self
                .problem
                .dmi_energy_density(self.state)
                .map_err(|error| RunError {
                    message: format!("CPU FDM snapshot '{}': DMI energy density: {}", name, error),
                }),
            "eden_total" => {
                let mut total = vec![0.0; self.state.magnetization().len()];
                for quantity in ["eden_ex", "eden_demag", "eden_ext", "eden_ani", "eden_dmi"] {
                    let values = self.select_scalar(quantity)?;
                    for (accum, value) in total.iter_mut().zip(values) {
                        *accum += value;
                    }
                }
                Ok(total)
            }
            _ => Err(RunError {
                message: format!("snapshot '{}': scalar quantity not available", name),
            }),
        }
    }

    fn base_values(&mut self, base: &str, name: &str) -> Result<&[Vector3], RunError> {
        match base {
            "m" => {
                if self.magnetization.is_none() {
                    self.magnetization = Some(self.state.magnetization().to_vec());
                }
                Ok(self.magnetization.as_deref().expect("cached magnetization"))
            }
            "H_ex" => {
                if self.exchange_field.is_none() {
                    self.exchange_field =
                        Some(self.problem.exchange_field(self.state).map_err(|error| {
                            RunError {
                                message: format!(
                                    "CPU FDM snapshot '{}': exchange field: {}",
                                    name, error
                                ),
                            }
                        })?);
                }
                Ok(self
                    .exchange_field
                    .as_deref()
                    .expect("cached exchange field"))
            }
            "H_demag" => {
                if self.demag_field.is_none() {
                    self.demag_field = Some(self.problem.demag_field(self.state).map_err(
                        |error| RunError {
                            message: format!("CPU FDM snapshot '{}': demag field: {}", name, error),
                        },
                    )?);
                }
                Ok(self.demag_field.as_deref().expect("cached demag field"))
            }
            "H_ext" => {
                if self.external_field.is_none() {
                    self.external_field =
                        Some(self.problem.external_field(self.state).map_err(|error| {
                            RunError {
                                message: format!(
                                    "CPU FDM snapshot '{}': external field: {}",
                                    name, error
                                ),
                            }
                        })?);
                }
                Ok(self
                    .external_field
                    .as_deref()
                    .expect("cached external field"))
            }
            "H_ani" => {
                if self.anisotropy_field.is_none() {
                    self.anisotropy_field =
                        Some(self.problem.anisotropy_field(self.state.magnetization()));
                }
                Ok(self
                    .anisotropy_field
                    .as_deref()
                    .expect("cached anisotropy field"))
            }
            "H_dmi" => {
                if self.dmi_field.is_none() {
                    self.dmi_field =
                        Some(
                            self.problem
                                .dmi_field(self.state)
                                .map_err(|error| RunError {
                                    message: format!(
                                        "CPU FDM snapshot '{}': DMI field: {}",
                                        name, error
                                    ),
                                })?,
                        );
                }
                Ok(self.dmi_field.as_deref().expect("cached DMI field"))
            }
            "H_OE" => {
                if self.oersted_field.is_none() {
                    self.oersted_field = Some(
                        self.problem
                            .terms
                            .per_node_field
                            .clone()
                            .unwrap_or_else(|| {
                                vec![[0.0, 0.0, 0.0]; self.state.magnetization().len()]
                            }),
                    );
                }
                Ok(self.oersted_field.as_deref().expect("cached Oersted field"))
            }
            "H_eff" => self.observable_effective_field(name),
            "torque" => self.torque_field(name),
            _ => Err(RunError {
                message: format!("snapshot '{}': not available directly from state", name),
            }),
        }
    }

    fn observable_effective_field(&mut self, name: &str) -> Result<&[Vector3], RunError> {
        if self.effective_field.is_none() {
            #[cfg(test)]
            increment_direct_h_eff_assembly_calls();
            self.effective_field = Some(
                self.problem
                    .observable_effective_field(self.state)
                    .map_err(|error| RunError {
                        message: format!("CPU FDM snapshot '{}': effective field: {}", name, error),
                    })?,
            );
        }
        Ok(self
            .effective_field
            .as_deref()
            .expect("cached effective field"))
    }

    fn torque_field(&mut self, name: &str) -> Result<&[Vector3], RunError> {
        if self.torque_field.is_none() {
            let torque = {
                let h_eff = self.observable_effective_field(name)?.to_vec();
                compute_torque_field(
                    self.state.magnetization(),
                    &h_eff,
                    self.problem.material.damping,
                    self.problem.dynamics.precession_enabled,
                )
            };
            self.torque_field = Some(torque);
        }
        Ok(self.torque_field.as_deref().expect("cached torque field"))
    }
}

fn project_component(
    values: &[Vector3],
    component: Option<&str>,
    name: &str,
) -> Result<Vec<Vector3>, RunError> {
    let Some(component) = component else {
        return Ok(values.to_vec());
    };
    let idx = match component {
        "x" => 0,
        "y" => 1,
        "z" => 2,
        _ => {
            return Err(RunError {
                message: format!(
                    "snapshot '{}': unsupported component '{}' (use x, y, or z)",
                    name, component
                ),
            });
        }
    };
    Ok(values.iter().map(|value| [value[idx], 0.0, 0.0]).collect())
}
