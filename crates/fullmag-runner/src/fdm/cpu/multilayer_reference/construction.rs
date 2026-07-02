//! CPU reference multilayer context and state construction.

use fullmag_engine::{
    AxisBoundary, CellSize, CubicAnisotropyConfig, EffectiveFieldTerms, ExchangeLlgProblem,
    ExchangeLlgState, FdmBoundaryPolicy, GridShape, LlgConfig, MaterialParameters,
    UniaxialAnisotropyConfig,
};
use fullmag_ir::FdmMultilayerPlanIR;

use crate::types::RunError;

use super::LayerContext;

pub(super) fn build_contexts_and_states(
    plan: &FdmMultilayerPlanIR,
    integrator: fullmag_engine::TimeIntegrator,
    pure_damping_relax: bool,
) -> Result<(Vec<LayerContext>, Vec<ExchangeLlgState>), RunError> {
    let mut contexts = Vec::with_capacity(plan.layers.len());
    let mut states = Vec::with_capacity(plan.layers.len());

    for layer in &plan.layers {
        let grid = GridShape::new(
            layer.native_grid[0] as usize,
            layer.native_grid[1] as usize,
            layer.native_grid[2] as usize,
        )
        .map_err(|error| RunError {
            message: format!("grid for magnet '{}': {}", layer.magnet_name, error),
        })?;
        let cell_size = CellSize::new(
            layer.native_cell_size[0],
            layer.native_cell_size[1],
            layer.native_cell_size[2],
        )
        .map_err(|error| RunError {
            message: format!("cell size for magnet '{}': {}", layer.magnet_name, error),
        })?;
        let material = MaterialParameters::new(
            layer.material.saturation_magnetisation,
            layer.material.exchange_stiffness,
            layer.material.damping,
        )
        .map_err(|error| RunError {
            message: format!("material for magnet '{}': {}", layer.magnet_name, error),
        })?;
        let dynamics = LlgConfig::new(plan.gyromagnetic_ratio, integrator)
            .map_err(|error| RunError {
                message: format!("LLG for magnet '{}': {}", layer.magnet_name, error),
            })?
            .with_precession_enabled(!pure_damping_relax);
        let mut problem = ExchangeLlgProblem::with_terms_and_mask(
            grid,
            cell_size,
            material,
            dynamics,
            EffectiveFieldTerms {
                exchange: plan.enable_exchange,
                demag: false,
                external_field: plan.external_field,
                per_node_field: None,
                magnetoelastic: None,
                uniaxial_anisotropy: layer.material.uniaxial_anisotropy_ku1.map(|ku1| {
                    UniaxialAnisotropyConfig {
                        ku1,
                        ku2: layer.material.uniaxial_anisotropy_ku2.unwrap_or(0.0),
                        axis: layer.material.anisotropy_axis.unwrap_or([0.0, 0.0, 1.0]),
                    }
                }),
                cubic_anisotropy: layer.material.cubic_anisotropy_kc1.map(|kc1| {
                    CubicAnisotropyConfig {
                        kc1,
                        kc2: layer.material.cubic_anisotropy_kc2.unwrap_or(0.0),
                        axis1: layer
                            .material
                            .cubic_anisotropy_axis1
                            .unwrap_or([1.0, 0.0, 0.0]),
                        axis2: layer
                            .material
                            .cubic_anisotropy_axis2
                            .unwrap_or([0.0, 1.0, 0.0]),
                    }
                }),
                interfacial_dmi: plan.interfacial_dmi,
                bulk_dmi: plan.bulk_dmi,
                zhang_li_stt: None,
                slonczewski_stt: None,
                sot: None,
                oersted_cylinder: None,
            },
            layer.native_active_mask.clone(),
        )
        .map_err(|error| RunError {
            message: format!(
                "problem construction for magnet '{}': {}",
                layer.magnet_name, error
            ),
        })?;
        if let Some(ref pbc) = plan.periodicity {
            let map_axis = |axis: &fullmag_ir::AxisBoundary| match axis {
                fullmag_ir::AxisBoundary::Periodic => AxisBoundary::Periodic,
                fullmag_ir::AxisBoundary::Open => AxisBoundary::Open,
            };
            problem.boundary_policy = FdmBoundaryPolicy {
                x: map_axis(&pbc.axes[0]),
                y: map_axis(&pbc.axes[1]),
                z: map_axis(&pbc.axes[2]),
            };
            if let Some(image_counts) = pbc.image_counts {
                problem.demag_image_counts = image_counts;
            }
        }
        let state = problem
            .new_state(layer.initial_magnetization.clone())
            .map_err(|error| RunError {
                message: format!(
                    "state construction for magnet '{}': {}",
                    layer.magnet_name, error
                ),
            })?;
        states.push(state);
        contexts.push(LayerContext {
            magnet_name: layer.magnet_name.clone(),
            origin: layer.native_origin,
            convolution_grid: [
                layer.convolution_grid[0] as usize,
                layer.convolution_grid[1] as usize,
                layer.convolution_grid[2] as usize,
            ],
            convolution_cell_size: layer.convolution_cell_size,
            needs_transfer: layer.transfer_kind != "identity",
            problem,
        });
    }

    Ok((contexts, states))
}
