//! Quantity evaluation and registry — provides a uniform interface
//! for computing quantity values from simulation state.

use crate::step_data::GlobalQuantityRow;
use crate::{QuantityReduction, QuantityShape};

/// A value produced by evaluating a quantity.
#[derive(Debug, Clone)]
pub enum QuantityValue {
    /// A 3-component vector field, flat [vx,vy,vz, vx,vy,vz, ...].
    VectorField(Vec<f64>),
    /// A scalar per spatial location.
    SpatialScalar(Vec<f64>),
    /// A single global value.
    GlobalScalar(f64),
}

/// Evaluate a global scalar quantity from a `GlobalQuantityRow`.
///
/// This is the registry-driven replacement for the old `global_scalar_value`
/// match-arm function in the runner.
pub fn eval_global_scalar(quantity_id: &str, row: &GlobalQuantityRow) -> Option<f64> {
    let spec = crate::quantity_spec(quantity_id)?;
    if spec.shape != QuantityShape::GlobalScalar {
        return None;
    }
    let key = spec.scalar_metric_key?;
    row.scalar_value(key)
}

/// Apply a reduction to a scalar dataset.
pub fn reduce_scalars(data: &[f64], reduction: QuantityReduction) -> Option<f64> {
    if data.is_empty() {
        return None;
    }
    match reduction {
        QuantityReduction::None => None,
        QuantityReduction::Average => {
            let sum: f64 = data.iter().sum();
            Some(sum / data.len() as f64)
        }
        QuantityReduction::Sum => Some(data.iter().sum()),
        QuantityReduction::Min => data.iter().copied().reduce(f64::min),
        QuantityReduction::Max => data.iter().copied().reduce(f64::max),
        QuantityReduction::Magnitude => {
            let sum_sq: f64 = data.iter().map(|v| v * v).sum();
            Some(sum_sq.sqrt())
        }
    }
}

/// Apply a reduction to a vector field dataset (flat [vx,vy,vz,...]).
pub fn reduce_vector_field(data: &[f64], reduction: QuantityReduction) -> Option<f64> {
    if data.is_empty() || data.len() % 3 != 0 {
        return None;
    }
    let n = data.len() / 3;
    match reduction {
        QuantityReduction::None => None,
        QuantityReduction::Average => {
            let mut sx = 0.0;
            let mut sy = 0.0;
            let mut sz = 0.0;
            for i in 0..n {
                sx += data[3 * i];
                sy += data[3 * i + 1];
                sz += data[3 * i + 2];
            }
            let inv_n = 1.0 / n as f64;
            Some(
                (sx * inv_n * sx * inv_n + sy * inv_n * sy * inv_n + sz * inv_n * sz * inv_n)
                    .sqrt(),
            )
        }
        QuantityReduction::Magnitude => {
            let sum_sq: f64 = data.iter().map(|v| v * v).sum();
            Some(sum_sq.sqrt())
        }
        QuantityReduction::Max => {
            let mut max_mag_sq = 0.0_f64;
            for i in 0..n {
                let mag_sq = data[3 * i] * data[3 * i]
                    + data[3 * i + 1] * data[3 * i + 1]
                    + data[3 * i + 2] * data[3 * i + 2];
                max_mag_sq = max_mag_sq.max(mag_sq);
            }
            Some(max_mag_sq.sqrt())
        }
        QuantityReduction::Min => {
            let mut min_mag_sq = f64::INFINITY;
            for i in 0..n {
                let mag_sq = data[3 * i] * data[3 * i]
                    + data[3 * i + 1] * data[3 * i + 1]
                    + data[3 * i + 2] * data[3 * i + 2];
                min_mag_sq = min_mag_sq.min(mag_sq);
            }
            Some(min_mag_sq.sqrt())
        }
        QuantityReduction::Sum => {
            let mut sx = 0.0;
            let mut sy = 0.0;
            let mut sz = 0.0;
            for i in 0..n {
                sx += data[3 * i];
                sy += data[3 * i + 1];
                sz += data[3 * i + 2];
            }
            Some((sx * sx + sy * sy + sz * sz).sqrt())
        }
    }
}
