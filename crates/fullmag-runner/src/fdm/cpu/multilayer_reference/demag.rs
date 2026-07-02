//! CPU reference multilayer demag field assembly.

use fullmag_engine::{
    multilayer::{FdmLayerRuntime, KernelPair, MultilayerDemagRuntime},
    ExchangeLlgState,
};
use fullmag_fdm_demag::{compute_exact_self_kernel, compute_shifted_kernel};
use fullmag_ir::FdmMultilayerPlanIR;

use crate::types::RunError;

use super::{zero_vectors, LayerContext};

pub(super) fn build_multilayer_demag_runtime(
    plan: &FdmMultilayerPlanIR,
) -> Result<MultilayerDemagRuntime, RunError> {
    let conv_grid = [
        plan.common_cells[0] as usize,
        plan.common_cells[1] as usize,
        plan.common_cells[2] as usize,
    ];
    let conv_cell_size = plan
        .layers
        .first()
        .map(|layer| layer.convolution_cell_size)
        .unwrap_or([1.0, 1.0, 1.0]);
    let mut kernel_pairs = Vec::with_capacity(plan.layers.len() * plan.layers.len());
    for (src_index, src_layer) in plan.layers.iter().enumerate() {
        for (dst_index, dst_layer) in plan.layers.iter().enumerate() {
            let z_shift = dst_layer.native_origin[2] - src_layer.native_origin[2];
            let kernel = if src_index == dst_index {
                compute_exact_self_kernel(
                    conv_grid[0],
                    conv_grid[1],
                    conv_grid[2],
                    conv_cell_size[0],
                    conv_cell_size[1],
                    conv_cell_size[2],
                )
            } else {
                compute_shifted_kernel(conv_grid, conv_cell_size, z_shift)
            };
            kernel_pairs.push(KernelPair {
                src_layer: src_index,
                dst_layer: dst_index,
                kernel,
            });
        }
    }
    Ok(MultilayerDemagRuntime::new(
        kernel_pairs,
        conv_grid,
        conv_cell_size,
    ))
}

pub(super) fn compute_demag_fields(
    contexts: &[LayerContext],
    states: &[ExchangeLlgState],
    demag_runtime: Option<&MultilayerDemagRuntime>,
) -> Vec<Vec<[f64; 3]>> {
    let mut zero = contexts
        .iter()
        .map(|context| zero_vectors(context.problem.grid.cell_count()))
        .collect::<Vec<_>>();
    let Some(runtime) = demag_runtime else {
        return zero;
    };

    let mut layers = contexts
        .iter()
        .zip(states.iter())
        .map(|(context, state)| FdmLayerRuntime {
            magnet_name: context.magnet_name.clone(),
            grid: [
                context.problem.grid.nx,
                context.problem.grid.ny,
                context.problem.grid.nz,
            ],
            cell_size: [
                context.problem.cell_size.dx,
                context.problem.cell_size.dy,
                context.problem.cell_size.dz,
            ],
            origin: context.origin,
            ms: context.problem.material.saturation_magnetisation,
            exchange_stiffness: context.problem.material.exchange_stiffness,
            damping: context.problem.material.damping,
            active_mask: context.problem.active_mask.clone(),
            m: state.magnetization().to_vec(),
            h_ex: zero_vectors(context.problem.grid.cell_count()),
            h_demag: zero_vectors(context.problem.grid.cell_count()),
            h_eff: zero_vectors(context.problem.grid.cell_count()),
            conv_grid: context.convolution_grid,
            conv_cell_size: context.convolution_cell_size,
            needs_transfer: context.needs_transfer,
        })
        .collect::<Vec<_>>();
    runtime.compute_demag_fields(&mut layers);
    for (index, layer) in layers.into_iter().enumerate() {
        zero[index] = layer.h_demag;
    }
    zero
}
