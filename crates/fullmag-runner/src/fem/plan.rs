//! Compatibility facade for FEM plan normalization.

pub(crate) use crate::solvers::fem::plan::normalized_fem_plan_for_runtime;
#[cfg(test)]
pub(crate) use crate::solvers::fem::plan::normalized_runtime_element_markers;
