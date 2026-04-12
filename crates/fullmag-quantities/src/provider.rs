//! QuantityProvider trait — the MuMax-like abstraction for quantity evaluation.
//!
//! Every quantity in the system has a provider that knows how to evaluate it.
//! This is the core contract from QB-05: providers for `m`, `H_ex`, `H_demag`,
//! `H_eff`, global energy scalars, etc. all implement the same interface.
//!
//! The provider trait lives in the canonical crate so that both the runner
//! (which implements providers) and the API/transport layer (which invokes them)
//! share the same vocabulary.

use crate::{QuantityId, QuantitySpec, QuantityValue};

/// Context available to a provider when evaluating a quantity.
///
/// This is intentionally opaque — the canonical crate defines the shape,
/// and the runner fills in the runtime state.
pub struct QuantityEvalContext<'a> {
    /// Active grid dimensions [nx, ny, nz].
    pub grid: [u32; 3],
    /// Current simulation time.
    pub time: f64,
    /// Current step index.
    pub step: u64,
    /// Number of spatial cells (nodes for FEM).
    pub n_cells: usize,
    /// Per-cell boolean mask: `true` = magnetically active.
    /// `None` means all cells are active.
    pub active_mask: Option<&'a [bool]>,
    /// Read-only access to the raw magnetization vector [mx,my,mz, mx,my,mz, ...].
    pub magnetization: Option<&'a [f64]>,
    /// Read-only access to named vector fields produced by the solver kernel.
    /// Key is the canonical `QuantityId::as_str()` name (e.g. "H_ex").
    pub named_fields: &'a dyn NamedFieldAccess,
    /// Global scalar observations for this step (energies, averages, maxima).
    pub global_scalars: Option<&'a crate::GlobalQuantityRow>,
}

/// Trait for accessing named vector fields by quantity id string.
///
/// Implemented by the runner's runtime state to provide zero-copy
/// access to solver kernel outputs.
pub trait NamedFieldAccess: Send + Sync {
    /// Return a reference to the flat f64 data for the given quantity,
    /// or `None` if the quantity is not currently available.
    fn get_field(&self, quantity_id: &str) -> Option<&[f64]>;

    /// List all currently available field quantity ids.
    fn available_fields(&self) -> Vec<&str>;
}

/// A provider that knows how to evaluate a specific quantity.
///
/// This is the Fullmag equivalent of MuMax3's `Quantity` interface.
/// Each quantity in the catalog has exactly one registered provider.
pub trait QuantityProvider: Send + Sync {
    /// The quantity this provider handles.
    fn quantity_id(&self) -> QuantityId;

    /// Evaluate the quantity given current simulation state.
    ///
    /// Returns `None` if the quantity cannot be evaluated (e.g. the
    /// required solver kernel data is not available).
    fn evaluate(&self, ctx: &QuantityEvalContext<'_>) -> Option<QuantityValue>;

    /// Whether this provider can produce a value given the current context.
    ///
    /// Used by the capability matrix and the UI picker to grey out
    /// unavailable quantities without attempting a full evaluation.
    fn is_available(&self, ctx: &QuantityEvalContext<'_>) -> bool;

    /// The static spec for this quantity (from the catalog).
    fn spec(&self) -> &'static QuantitySpec {
        crate::quantity_spec(self.quantity_id().as_str())
            .expect("provider registered for unknown quantity id")
    }
}

/// Blanket implementation for looking up named fields by String key.
impl NamedFieldAccess for std::collections::HashMap<String, Vec<f64>> {
    fn get_field(&self, quantity_id: &str) -> Option<&[f64]> {
        self.get(quantity_id).map(Vec::as_slice)
    }

    fn available_fields(&self) -> Vec<&str> {
        self.keys().map(String::as_str).collect()
    }
}

/// A no-op field accessor for contexts where no fields are available.
pub struct EmptyFieldAccess;

impl NamedFieldAccess for EmptyFieldAccess {
    fn get_field(&self, _quantity_id: &str) -> Option<&[f64]> {
        None
    }

    fn available_fields(&self) -> Vec<&str> {
        Vec::new()
    }
}
