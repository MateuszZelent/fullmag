//! QuantityRegistry — runtime registry of quantity providers.
//!
//! The registry is the central dispatch point for quantity evaluation.
//! Instead of scattered `match` arms, the runner registers providers
//! at startup and the registry routes evaluation requests uniformly.

use std::collections::HashMap;

use crate::provider::{QuantityEvalContext, QuantityProvider};
use crate::{QuantityId, QuantityValue};

/// Runtime registry of quantity providers.
///
/// Created once at solver startup, populated with all providers the
/// current backend supports, then shared (read-only) for the duration
/// of the simulation.
pub struct QuantityRegistry {
    providers: HashMap<QuantityId, Box<dyn QuantityProvider>>,
}

impl QuantityRegistry {
    /// Create an empty registry.
    pub fn new() -> Self {
        Self {
            providers: HashMap::new(),
        }
    }

    /// Register a provider. Replaces any previous provider for the same id.
    pub fn register(&mut self, provider: Box<dyn QuantityProvider>) {
        let id = provider.quantity_id();
        self.providers.insert(id, provider);
    }

    /// Evaluate a quantity by id.
    pub fn evaluate(
        &self,
        id: QuantityId,
        ctx: &QuantityEvalContext<'_>,
    ) -> Option<QuantityValue> {
        self.providers.get(&id)?.evaluate(ctx)
    }

    /// Evaluate a quantity by string id.
    pub fn evaluate_by_name(
        &self,
        id: &str,
        ctx: &QuantityEvalContext<'_>,
    ) -> Option<QuantityValue> {
        let quantity_id = crate::normalize_quantity_id(id).ok()?;
        self.evaluate(quantity_id, ctx)
    }

    /// Check whether a quantity is available in the current context.
    pub fn is_available(&self, id: QuantityId, ctx: &QuantityEvalContext<'_>) -> bool {
        self.providers
            .get(&id)
            .is_some_and(|p| p.is_available(ctx))
    }

    /// List all registered quantity ids.
    pub fn registered_ids(&self) -> Vec<QuantityId> {
        self.providers.keys().copied().collect()
    }

    /// Number of registered providers.
    pub fn len(&self) -> usize {
        self.providers.len()
    }

    /// Whether the registry is empty.
    pub fn is_empty(&self) -> bool {
        self.providers.is_empty()
    }
}

impl Default for QuantityRegistry {
    fn default() -> Self {
        Self::new()
    }
}

// ── Built-in providers for common patterns ───────────────────────────

/// A provider that reads a named vector field from the eval context.
///
/// Covers `m`, `H_ex`, `H_demag`, `H_ext`, `H_ant`, `H_eff`, `H_ani`,
/// `H_dmi`, `H_mel`, `H_ani_cubic`, `H_dmi_bulk`, `H_oe`, `H_therm`.
pub struct VectorFieldProvider {
    id: QuantityId,
}

impl VectorFieldProvider {
    pub fn new(id: QuantityId) -> Self {
        Self { id }
    }
}

impl QuantityProvider for VectorFieldProvider {
    fn quantity_id(&self) -> QuantityId {
        self.id
    }

    fn evaluate(&self, ctx: &QuantityEvalContext<'_>) -> Option<QuantityValue> {
        // Special-case magnetization: it may live in a dedicated field
        if self.id == QuantityId::M {
            if let Some(mag) = ctx.magnetization {
                return Some(QuantityValue::VectorField(mag.to_vec()));
            }
        }
        let data = ctx.named_fields.get_field(self.id.as_str())?;
        Some(QuantityValue::VectorField(data.to_vec()))
    }

    fn is_available(&self, ctx: &QuantityEvalContext<'_>) -> bool {
        if self.id == QuantityId::M {
            return ctx.magnetization.is_some()
                || ctx.named_fields.get_field("m").is_some();
        }
        ctx.named_fields.get_field(self.id.as_str()).is_some()
    }
}

/// A provider that reads a global scalar from the `GlobalQuantityRow`.
///
/// Covers `E_ex`, `E_demag`, `E_ext`, `E_ani`, `E_dmi`, `E_total`.
pub struct GlobalScalarProvider {
    id: QuantityId,
    metric_key: &'static str,
}

impl GlobalScalarProvider {
    pub fn new(id: QuantityId, metric_key: &'static str) -> Self {
        Self { id, metric_key }
    }
}

impl QuantityProvider for GlobalScalarProvider {
    fn quantity_id(&self) -> QuantityId {
        self.id
    }

    fn evaluate(&self, ctx: &QuantityEvalContext<'_>) -> Option<QuantityValue> {
        let row = ctx.global_scalars?;
        let value = row.scalar_value(self.metric_key)?;
        Some(QuantityValue::GlobalScalar(value))
    }

    fn is_available(&self, ctx: &QuantityEvalContext<'_>) -> bool {
        ctx.global_scalars.is_some()
    }
}

/// A provider that reads a named spatial-scalar field from the eval context.
///
/// Covers `mode_amplitude` and `mode_phase`.
pub struct SpatialScalarFieldProvider {
    id: QuantityId,
}

impl SpatialScalarFieldProvider {
    pub fn new(id: QuantityId) -> Self {
        Self { id }
    }
}

impl QuantityProvider for SpatialScalarFieldProvider {
    fn quantity_id(&self) -> QuantityId {
        self.id
    }

    fn evaluate(&self, ctx: &QuantityEvalContext<'_>) -> Option<QuantityValue> {
        let data = ctx.named_fields.get_field(self.id.as_str())?;
        Some(QuantityValue::SpatialScalar(data.to_vec()))
    }

    fn is_available(&self, ctx: &QuantityEvalContext<'_>) -> bool {
        ctx.named_fields.get_field(self.id.as_str()).is_some()
    }
}

/// Populate a registry with the standard set of providers.
///
/// This registers providers for all 23 catalog quantities using the
/// built-in `VectorFieldProvider`, `SpatialScalarFieldProvider` and
/// `GlobalScalarProvider` types.
pub fn register_standard_providers(registry: &mut QuantityRegistry) {
    use QuantityId::*;

    // Vector fields
    for id in [
        M, HEx, HDemag, HExt, HAnt, HEff, HAni, HDmi, HMel,
        HAniCubic, HDmiBulk, HOe, HTherm,
        ModeReal, ModeImag,
    ] {
        registry.register(Box::new(VectorFieldProvider::new(id)));
    }

    // Spatial-scalar fields
    for id in [ModeAmplitude, ModePhase] {
        registry.register(Box::new(SpatialScalarFieldProvider::new(id)));
    }

    // Global scalars (with their metric keys from the catalog)
    let scalars: &[(QuantityId, &str)] = &[
        (EEx, "e_ex"),
        (EDemag, "e_demag"),
        (EExt, "e_ext"),
        (EAni, "e_ani"),
        (EDmi, "e_dmi"),
        (ETotal, "e_total"),
    ];
    for &(id, key) in scalars {
        registry.register(Box::new(GlobalScalarProvider::new(id, key)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::EmptyFieldAccess;
    use crate::GlobalQuantityRow;

    #[test]
    fn standard_providers_register_all_23() {
        let mut reg = QuantityRegistry::new();
        register_standard_providers(&mut reg);
        // 13 vector fields + 2 mode vectors + 2 mode spatial-scalars + 6 global scalars = 23
        assert_eq!(reg.len(), 23);
    }

    #[test]
    fn global_scalar_provider_evaluates_energy() {
        let mut reg = QuantityRegistry::new();
        register_standard_providers(&mut reg);

        let row = GlobalQuantityRow {
            e_ex: 1.5e-18,
            e_total: 4.2e-18,
            ..Default::default()
        };

        let empty = EmptyFieldAccess;
        let ctx = QuantityEvalContext {
            grid: [10, 10, 1],
            time: 0.0,
            step: 0,
            n_cells: 100,
            active_mask: None,
            magnetization: None,
            named_fields: &empty,
            global_scalars: Some(&row),
        };

        let val = reg.evaluate(QuantityId::EEx, &ctx);
        assert!(matches!(val, Some(QuantityValue::GlobalScalar(v)) if (v - 1.5e-18).abs() < 1e-30));

        let val = reg.evaluate(QuantityId::ETotal, &ctx);
        assert!(matches!(val, Some(QuantityValue::GlobalScalar(v)) if (v - 4.2e-18).abs() < 1e-30));
    }

    #[test]
    fn vector_field_provider_reads_named_field() {
        let mut reg = QuantityRegistry::new();
        register_standard_providers(&mut reg);

        let mut fields = std::collections::HashMap::new();
        fields.insert("H_ex".to_string(), vec![1.0, 0.0, 0.0, 0.0, 1.0, 0.0]);

        let ctx = QuantityEvalContext {
            grid: [2, 1, 1],
            time: 0.0,
            step: 0,
            n_cells: 2,
            active_mask: None,
            magnetization: None,
            named_fields: &fields,
            global_scalars: None,
        };

        let val = reg.evaluate(QuantityId::HEx, &ctx);
        assert!(matches!(val, Some(QuantityValue::VectorField(ref v)) if v.len() == 6));
    }

    #[test]
    fn magnetization_provider_prefers_dedicated_field() {
        let mut reg = QuantityRegistry::new();
        register_standard_providers(&mut reg);

        let mag = vec![0.0, 0.0, 1.0, 0.0, 0.0, -1.0];
        let empty = EmptyFieldAccess;
        let ctx = QuantityEvalContext {
            grid: [2, 1, 1],
            time: 0.0,
            step: 0,
            n_cells: 2,
            active_mask: None,
            magnetization: Some(&mag),
            named_fields: &empty,
            global_scalars: None,
        };

        assert!(reg.is_available(QuantityId::M, &ctx));
        let val = reg.evaluate(QuantityId::M, &ctx);
        assert!(matches!(val, Some(QuantityValue::VectorField(ref v)) if v.len() == 6));
    }
}
