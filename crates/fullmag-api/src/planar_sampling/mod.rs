mod contract;
pub(crate) mod cut_geometry;
pub(crate) mod element_evaluator;
pub(crate) mod evaluation_plan;
pub(crate) mod execution;
mod fdm;
mod fem;
pub(crate) mod moments;
mod frame;
mod geometry;
mod provenance;
mod reduction;
mod source;
mod surface;
mod target;

pub(crate) use contract::*;
pub(crate) use execution::*;
pub(crate) use fdm::MAX_FDM_PLANAR_GRID_SEGMENTS;
pub(crate) use source::*;
pub(crate) use target::*;

#[cfg(test)]
mod target_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod counterexamples_tests;
