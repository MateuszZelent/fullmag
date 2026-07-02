//! Compatibility facade for FEM preview routing.

pub(crate) use crate::solvers::fem::preview::{
    fem_plan_for_cpu_native, fem_plan_for_native_gpu, snapshot_fem_preview,
    snapshot_fem_vector_fields,
};
