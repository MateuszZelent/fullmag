//! Quantity reductions.

use serde::{Deserialize, Serialize};

/// How a spatial quantity should be reduced to a scalar.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuantityReduction {
    /// No reduction — deliver the full spatial field.
    None,
    /// Volume-weighted average over the domain.
    Average,
    /// Sum over all cells/nodes.
    Sum,
    /// Minimum cell/node value.
    Min,
    /// Maximum cell/node value.
    Max,
    /// Magnitude (L2-norm for vectors).
    Magnitude,
}

impl QuantityReduction {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Average => "average",
            Self::Sum => "sum",
            Self::Min => "min",
            Self::Max => "max",
            Self::Magnitude => "magnitude",
        }
    }
}
