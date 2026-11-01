//! Lowering of an FDM plan into the shared per-connection exchange operator
//! consumed by both the CPU reference and the native CUDA lane.

use fullmag_engine::{
    build_exchange_operator, ExchangeOperator, ExchangeOperatorInputs, ExchangePairMode,
    ExchangePairRule, GridShape,
};
use fullmag_ir::{FdmExchangePairModeIR, FdmPlanIR};

use crate::types::RunError;

/// Resolve the plan's regions, owners, exchange stiffness and pair rules into
/// `Uniform` or per-connection face coefficients.
pub(crate) fn build_plan_exchange_operator(plan: &FdmPlanIR) -> Result<ExchangeOperator, RunError> {
    let error = |message: String| RunError {
        message: format!("FDM exchange operator: {message}"),
    };
    fullmag_ir::validate_fdm_exchange_pair_rules(&plan.inter_region_exchange).map_err(error)?;
    let grid = GridShape::new(
        plan.grid.cells[0] as usize,
        plan.grid.cells[1] as usize,
        plan.grid.cells[2] as usize,
    )
    .map_err(|engine_error| error(engine_error.to_string()))?;
    let periodic = plan.periodicity.as_ref().map_or([false; 3], |periodicity| {
        periodicity
            .axes
            .map(|axis| matches!(axis, fullmag_ir::AxisBoundary::Periodic))
    });
    let rules: Vec<ExchangePairRule> = plan
        .inter_region_exchange
        .iter()
        .map(|rule| ExchangePairRule {
            region_i: rule.region_i,
            region_j: rule.region_j,
            mode: match rule.mode {
                FdmExchangePairModeIR::HarmonicScale { scale } => {
                    ExchangePairMode::HarmonicScale(scale)
                }
                FdmExchangePairModeIR::Explicit { exchange_stiffness } => {
                    ExchangePairMode::Explicit(exchange_stiffness)
                }
                FdmExchangePairModeIR::Disabled => ExchangePairMode::Disabled,
            },
        })
        .collect();
    let region_mask = (!plan.region_mask.is_empty()).then_some(plan.region_mask.as_slice());
    if region_mask.is_none() && !rules.is_empty() {
        return Err(error(
            "inter_region_exchange rules require a region_mask; refusing to drop exchange pair intent"
                .to_string(),
        ));
    }
    let region_owner = (!plan.region_owner.is_empty()).then_some(plan.region_owner.as_slice());
    if plan.enable_exchange {
        build_exchange_operator(&ExchangeOperatorInputs {
            grid,
            periodic,
            active: plan.active_mask.as_deref(),
            region_mask,
            region_owner,
            exchange_stiffness: plan.material.exchange_stiffness,
            a_field: plan.material.a_field.as_deref(),
            rules: &rules,
        })
        .map_err(error)
    } else {
        Ok(ExchangeOperator::Uniform)
    }
}
