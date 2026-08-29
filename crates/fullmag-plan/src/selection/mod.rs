mod certificate;
mod fdm;
mod fem;
pub mod geometry;

pub use certificate::{
    FrozenSpinsCompileRequest, FrozenSpinsStateSnapshot, ResolvedFrozenSpinsReference,
    SelectionDofMembership,
};
pub use fdm::{compile_fdm_frozen_spins, compile_fdm_points_frozen_spins, FdmFrozenSpinsDomain};
#[cfg(test)]
pub(crate) use fdm::{fdm_point_materialization_count, reset_fdm_point_materialization_count};
pub use fem::{compile_fem_frozen_spins, FemIncidentElement, FemTrueDofDomain};
#[cfg(test)]
pub(crate) use fem::{
    fem_membership_materialization_count, reset_fem_membership_materialization_count,
};

#[cfg(test)]
mod tests;
