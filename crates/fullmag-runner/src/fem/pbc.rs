//! Compatibility facade for FEM PBC preprocessing.

#[cfg(test)]
pub(crate) use crate::solvers::fem::pbc::fem_static_periodic_native_exchange_supported;
pub(crate) use crate::solvers::fem::pbc::{fem_static_periodic_decision, FemStaticPbcLane};
