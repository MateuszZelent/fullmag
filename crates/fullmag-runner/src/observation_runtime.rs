//! Isolated evaluator for one immutable accepted observation source.

use fullmag_quantities::{
    accepted_state_digests, register_standard_providers, AcceptedPrimaryCarrier, AcceptedStateId,
    EmptyFieldAccess, GlobalQuantityRow, NamedFieldAccess, ObservationClock, QuantityEvalContext,
    QuantityId, QuantityRegistry, QuantityShape, QuantityValue,
};
use std::collections::{HashMap, HashSet};
use std::fmt;

use crate::observation::{magnetization_digest_f64be, FdmCpuAcceptedStateSnapshotV1};

/// Owned state required to evaluate quantities for one immutable source.
///
/// Construction consumes every carrier. The resulting runtime has no handle to
/// a live solver, its publisher or its command path.
#[derive(Debug, Clone)]
pub struct ObservationFrame {
    pub source: AcceptedStateId,
    pub clock: ObservationClock,
    pub primary_carriers: Vec<ObservationPrimaryCarrier>,
    pub grid: [u32; 3],
    pub n_cells: usize,
    pub active_mask: Option<Vec<bool>>,
    pub magnetization: Option<Vec<f64>>,
    pub named_fields: HashMap<String, Vec<f64>>,
    pub global_scalars: Option<GlobalQuantityRow>,
    pub available_quantity_ids: Vec<QuantityId>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObservationPrimaryCarrier {
    pub carrier_id: String,
    pub canonical_bytes: Vec<u8>,
}

/// One all-or-nothing result from the canonical quantity registry.
#[derive(Debug, Clone)]
pub struct ObservationQuantityBatch {
    pub source: AcceptedStateId,
    pub quantity_ids: Vec<QuantityId>,
    pub values: Vec<(QuantityId, QuantityValue)>,
}

/// Historical quantity evaluator isolated from `LiveRuntime`.
pub struct ObservationRuntime {
    frame: ObservationFrame,
    registry: QuantityRegistry,
    available_quantity_ids: HashSet<QuantityId>,
    cache: HashMap<QuantityId, QuantityValue>,
}

impl ObservationRuntime {
    pub fn new(frame: ObservationFrame) -> Result<Self, ObservationRuntimeError> {
        validate_frame(&frame)?;
        let available_quantity_ids = frame.available_quantity_ids.iter().copied().collect();
        let mut registry = QuantityRegistry::new();
        register_standard_providers(&mut registry);
        Ok(Self {
            frame,
            registry,
            available_quantity_ids,
            cache: HashMap::new(),
        })
    }

    pub fn source(&self) -> &AcceptedStateId {
        &self.frame.source
    }

    pub fn from_fdm_cpu_accepted_state(
        source: AcceptedStateId,
        snapshot: FdmCpuAcceptedStateSnapshotV1,
        grid: [u32; 3],
        magnetization: Vec<[f64; 3]>,
    ) -> Result<Self, ObservationRuntimeError> {
        snapshot
            .validate()
            .map_err(|error| ObservationRuntimeError::InvalidSource(error.to_string()))?;
        if source.accepted_step != snapshot.clock.accepted_step
            || source.clock_digest != snapshot.clock_digest
            || source.state_digest != snapshot.state_digest
        {
            return Err(ObservationRuntimeError::SourceMismatch);
        }
        let transactional_state_digest = snapshot
            .transactional_state_digest
            .ok_or(ObservationRuntimeError::MissingPrimaryCarrierPreimage)?;
        let expected_magnetization_digest = snapshot
            .magnetization_digest
            .ok_or(ObservationRuntimeError::MissingMagnetizationBinding)?;
        let actual_magnetization_digest = magnetization_digest_f64be(&magnetization)
            .map_err(|error| ObservationRuntimeError::InvalidSource(error.to_string()))?;
        if actual_magnetization_digest != expected_magnetization_digest {
            return Err(ObservationRuntimeError::MagnetizationIdentityMismatch);
        }
        let n_cells = grid.into_iter().try_fold(1_usize, |count, extent| {
            usize::try_from(extent)
                .ok()
                .and_then(|extent| count.checked_mul(extent))
        });
        let Some(n_cells) = n_cells else {
            return Err(ObservationRuntimeError::InvalidGrid);
        };
        Self::new(ObservationFrame {
            source,
            clock: snapshot.clock,
            primary_carriers: vec![ObservationPrimaryCarrier {
                carrier_id: "fdm.cpu.transactional-state-digest.v1".into(),
                canonical_bytes: transactional_state_digest.into_bytes(),
            }],
            grid,
            n_cells,
            active_mask: None,
            magnetization: Some(
                magnetization
                    .into_iter()
                    .flat_map(|value| value.into_iter())
                    .collect(),
            ),
            named_fields: HashMap::new(),
            global_scalars: None,
            available_quantity_ids: vec![QuantityId::M],
        })
    }

    pub fn cached_quantity_ids(&self) -> Vec<QuantityId> {
        let mut ids: Vec<_> = self.cache.keys().copied().collect();
        ids.sort_unstable_by_key(|id| id.as_str());
        ids
    }

    /// Materialize one atomic batch for the exact source bound to this runtime.
    ///
    /// No cache entry is committed until every requested quantity has passed
    /// source, availability, shape and finite-value validation.
    pub fn compute_quantities(
        &mut self,
        expected_source: &AcceptedStateId,
        quantity_ids: &[QuantityId],
    ) -> Result<ObservationQuantityBatch, ObservationRuntimeError> {
        if expected_source != &self.frame.source {
            return Err(ObservationRuntimeError::SourceMismatch);
        }
        if quantity_ids.is_empty() {
            return Err(ObservationRuntimeError::EmptyRequest);
        }

        let mut seen = HashSet::with_capacity(quantity_ids.len());
        for &quantity_id in quantity_ids {
            if !seen.insert(quantity_id) {
                return Err(ObservationRuntimeError::DuplicateQuantity(quantity_id));
            }
            if !self.available_quantity_ids.contains(&quantity_id) {
                return Err(ObservationRuntimeError::QuantityUnavailable(quantity_id));
            }
        }

        let empty_fields = EmptyFieldAccess;
        let named_fields: &dyn NamedFieldAccess = if self.frame.named_fields.is_empty() {
            &empty_fields
        } else {
            &self.frame.named_fields
        };
        let context = QuantityEvalContext {
            grid: self.frame.grid,
            time: self.frame.clock.time_seconds,
            step: self.frame.clock.accepted_step,
            n_cells: self.frame.n_cells,
            active_mask: self.frame.active_mask.as_deref(),
            magnetization: self.frame.magnetization.as_deref(),
            named_fields,
            global_scalars: self.frame.global_scalars.as_ref(),
        };

        let mut values = Vec::with_capacity(quantity_ids.len());
        for &quantity_id in quantity_ids {
            let value = match self.cache.get(&quantity_id) {
                Some(value) => value.clone(),
                None => self
                    .registry
                    .evaluate(quantity_id, &context)
                    .ok_or(ObservationRuntimeError::MissingPrimaryState(quantity_id))?,
            };
            validate_quantity_value(quantity_id, &value, self.frame.n_cells)?;
            values.push((quantity_id, value));
        }

        for (quantity_id, value) in &values {
            self.cache.insert(*quantity_id, value.clone());
        }
        Ok(ObservationQuantityBatch {
            source: self.frame.source.clone(),
            quantity_ids: quantity_ids.to_vec(),
            values,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ObservationRuntimeError {
    InvalidSource(String),
    ClockIdentityMismatch,
    StateIdentityMismatch,
    MissingPrimaryCarrierPreimage,
    MissingMagnetizationBinding,
    MagnetizationIdentityMismatch,
    InvalidGrid,
    InvalidActiveMask,
    InvalidMagnetization,
    InvalidNamedField(String),
    InvalidScalarClock,
    EmptyAvailability,
    DuplicateAvailability(QuantityId),
    SourceMismatch,
    EmptyRequest,
    DuplicateQuantity(QuantityId),
    QuantityUnavailable(QuantityId),
    MissingPrimaryState(QuantityId),
    InvalidQuantityValue(QuantityId),
}

impl fmt::Display for ObservationRuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidSource(reason) => {
                write!(formatter, "invalid observation source: {reason}")
            }
            Self::ClockIdentityMismatch => {
                formatter.write_str("observation clock does not match the accepted source identity")
            }
            Self::StateIdentityMismatch => formatter.write_str(
                "observation primary carriers do not match the accepted source identity",
            ),
            Self::MissingPrimaryCarrierPreimage => formatter
                .write_str("observation source does not retain the primary carrier preimage"),
            Self::MissingMagnetizationBinding => formatter
                .write_str("observation source does not bind its materialized magnetization"),
            Self::MagnetizationIdentityMismatch => {
                formatter.write_str("observation magnetization does not match the accepted source")
            }
            Self::InvalidGrid => {
                formatter.write_str("observation grid and n_cells are inconsistent")
            }
            Self::InvalidActiveMask => formatter.write_str("observation active mask is invalid"),
            Self::InvalidMagnetization => {
                formatter.write_str("observation magnetization is invalid")
            }
            Self::InvalidNamedField(field) => {
                write!(formatter, "observation named field `{field}` is invalid")
            }
            Self::InvalidScalarClock => formatter
                .write_str("observation scalar row does not match the accepted source clock"),
            Self::EmptyAvailability => {
                formatter.write_str("observation source has no declared quantities")
            }
            Self::DuplicateAvailability(id) => {
                write!(
                    formatter,
                    "observation quantity `{id}` is declared more than once"
                )
            }
            Self::SourceMismatch => {
                formatter.write_str("observation request targets a different accepted source")
            }
            Self::EmptyRequest => formatter.write_str("observation quantity request is empty"),
            Self::DuplicateQuantity(id) => {
                write!(formatter, "observation request repeats quantity `{id}`")
            }
            Self::QuantityUnavailable(id) => {
                write!(
                    formatter,
                    "observation quantity `{id}` is unavailable for this source"
                )
            }
            Self::MissingPrimaryState(id) => write!(
                formatter,
                "observation quantity `{id}` is missing required primary state"
            ),
            Self::InvalidQuantityValue(id) => {
                write!(
                    formatter,
                    "observation quantity `{id}` produced an invalid value"
                )
            }
        }
    }
}

impl std::error::Error for ObservationRuntimeError {}

fn validate_frame(frame: &ObservationFrame) -> Result<(), ObservationRuntimeError> {
    frame
        .source
        .validate()
        .map_err(|error| ObservationRuntimeError::InvalidSource(error.to_string()))?;
    frame
        .clock
        .validate()
        .map_err(|error| ObservationRuntimeError::InvalidSource(error.to_string()))?;
    if frame.source.accepted_step != frame.clock.accepted_step
        || frame.source.clock_digest
            != frame
                .clock
                .digest()
                .map_err(|error| ObservationRuntimeError::InvalidSource(error.to_string()))?
    {
        return Err(ObservationRuntimeError::ClockIdentityMismatch);
    }
    let primary_carriers: Vec<_> = frame
        .primary_carriers
        .iter()
        .map(|carrier| AcceptedPrimaryCarrier {
            carrier_id: &carrier.carrier_id,
            canonical_bytes: &carrier.canonical_bytes,
        })
        .collect();
    let state_digests = accepted_state_digests(frame.clock, &primary_carriers)
        .map_err(|error| ObservationRuntimeError::InvalidSource(error.to_string()))?;
    if state_digests.state_digest != frame.source.state_digest {
        return Err(ObservationRuntimeError::StateIdentityMismatch);
    }
    let grid_cells = frame.grid.into_iter().try_fold(1_usize, |count, extent| {
        usize::try_from(extent)
            .ok()
            .and_then(|extent| count.checked_mul(extent))
    });
    if frame.n_cells == 0 || grid_cells != Some(frame.n_cells) {
        return Err(ObservationRuntimeError::InvalidGrid);
    }
    if frame
        .active_mask
        .as_ref()
        .is_some_and(|mask| mask.len() != frame.n_cells)
    {
        return Err(ObservationRuntimeError::InvalidActiveMask);
    }
    if frame.magnetization.as_ref().is_some_and(|magnetization| {
        magnetization.len() != frame.n_cells * 3
            || magnetization.iter().any(|value| !value.is_finite())
    }) {
        return Err(ObservationRuntimeError::InvalidMagnetization);
    }
    for (name, values) in &frame.named_fields {
        let quantity_id = fullmag_quantities::normalize_quantity_id(name)
            .map_err(|_| ObservationRuntimeError::InvalidNamedField(name.clone()))?;
        let spec = fullmag_quantities::quantity_spec(quantity_id.as_str())
            .ok_or_else(|| ObservationRuntimeError::InvalidNamedField(name.clone()))?;
        let expected_len = match spec.shape {
            QuantityShape::GlobalScalar => 1,
            _ => frame.n_cells * usize::from(spec.n_comp),
        };
        if values.len() != expected_len || values.iter().any(|value| !value.is_finite()) {
            return Err(ObservationRuntimeError::InvalidNamedField(name.clone()));
        }
    }
    if frame.global_scalars.as_ref().is_some_and(|row| {
        row.step != frame.clock.accepted_step
            || row.time.to_bits() != frame.clock.time_seconds.to_bits()
    }) {
        return Err(ObservationRuntimeError::InvalidScalarClock);
    }
    if frame.available_quantity_ids.is_empty() {
        return Err(ObservationRuntimeError::EmptyAvailability);
    }
    let mut seen = HashSet::with_capacity(frame.available_quantity_ids.len());
    for &quantity_id in &frame.available_quantity_ids {
        if !seen.insert(quantity_id) {
            return Err(ObservationRuntimeError::DuplicateAvailability(quantity_id));
        }
    }
    Ok(())
}

fn validate_quantity_value(
    quantity_id: QuantityId,
    value: &QuantityValue,
    n_cells: usize,
) -> Result<(), ObservationRuntimeError> {
    let spec = fullmag_quantities::quantity_spec(quantity_id.as_str())
        .ok_or(ObservationRuntimeError::InvalidQuantityValue(quantity_id))?;
    let valid = match value {
        QuantityValue::VectorField(values) if spec.shape == QuantityShape::VectorField => {
            values.len() == n_cells * usize::from(spec.n_comp)
                && values.iter().all(|value| value.is_finite())
        }
        QuantityValue::TensorField(values) if spec.shape == QuantityShape::TensorField => {
            values.len() == n_cells * usize::from(spec.n_comp)
                && values.iter().all(|value| value.is_finite())
        }
        QuantityValue::SpatialScalar(values) if spec.shape == QuantityShape::SpatialScalar => {
            values.len() == n_cells && values.iter().all(|value| value.is_finite())
        }
        QuantityValue::GlobalScalar(value) if spec.shape == QuantityShape::GlobalScalar => {
            value.is_finite()
        }
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(ObservationRuntimeError::InvalidQuantityValue(quantity_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_quantities::AcceptedPrimaryCarrier;

    fn frame() -> ObservationFrame {
        let clock = ObservationClock {
            accepted_step: 4,
            time_seconds: 2.0e-12,
            dt_seconds: Some(5.0e-13),
        };
        let magnetization = vec![1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        let primary_carriers = vec![ObservationPrimaryCarrier {
            carrier_id: "magnetization.f64le.v1".into(),
            canonical_bytes: vec![1, 2, 3],
        }];
        let source = AcceptedStateId::from_canonical_state(
            "run-observation",
            Some("stage-1".into()),
            clock,
            &[AcceptedPrimaryCarrier {
                carrier_id: &primary_carriers[0].carrier_id,
                canonical_bytes: &primary_carriers[0].canonical_bytes,
            }],
            format!("sha256:{}", "c".repeat(64)),
            format!("sha256:{}", "d".repeat(64)),
        )
        .unwrap();
        ObservationFrame {
            source,
            clock,
            primary_carriers,
            grid: [2, 1, 1],
            n_cells: 2,
            active_mask: None,
            magnetization: Some(magnetization),
            named_fields: HashMap::new(),
            global_scalars: None,
            available_quantity_ids: vec![QuantityId::M, QuantityId::HEx],
        }
    }

    #[test]
    fn computes_one_source_bound_atomic_batch_and_caches_it() {
        let mut runtime = ObservationRuntime::new(frame()).unwrap();
        let source = runtime.source().clone();
        let batch = runtime
            .compute_quantities(&source, &[QuantityId::M])
            .unwrap();
        assert_eq!(batch.source, source);
        assert_eq!(batch.quantity_ids, [QuantityId::M]);
        assert!(matches!(
            batch.values.as_slice(),
            [(QuantityId::M, QuantityValue::VectorField(values))] if values.len() == 6
        ));
        assert_eq!(runtime.cached_quantity_ids(), [QuantityId::M]);
    }

    #[test]
    fn refuses_foreign_source_and_does_not_commit_partial_batch() {
        let mut runtime = ObservationRuntime::new(frame()).unwrap();
        let source = runtime.source().clone();
        let mut foreign = source.clone();
        foreign.run_id = "other-run".into();
        assert!(matches!(
            runtime.compute_quantities(&foreign, &[QuantityId::M]),
            Err(ObservationRuntimeError::SourceMismatch)
        ));
        assert!(matches!(
            runtime.compute_quantities(&source, &[QuantityId::M, QuantityId::HEx]),
            Err(ObservationRuntimeError::MissingPrimaryState(
                QuantityId::HEx
            ))
        ));
        assert!(runtime.cached_quantity_ids().is_empty());
    }

    #[test]
    fn refuses_primary_carriers_that_do_not_match_the_source_digest() {
        let mut frame = frame();
        frame.primary_carriers[0].canonical_bytes.push(4);
        assert!(matches!(
            ObservationRuntime::new(frame),
            Err(ObservationRuntimeError::StateIdentityMismatch)
        ));
    }

    #[test]
    fn fdm_cpu_adapter_binds_terminal_magnetization_and_computes_m() {
        let clock = ObservationClock {
            accepted_step: 8,
            time_seconds: 4.0e-12,
            dt_seconds: Some(5.0e-13),
        };
        let magnetization = vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
        let transactional_digest = format!("sha256:{}", "e".repeat(64));
        let snapshot = FdmCpuAcceptedStateSnapshotV1::from_transactional_state(
            clock,
            &transactional_digest,
            &magnetization,
        )
        .unwrap();
        let source = AcceptedStateId {
            run_id: "run-fdm-cpu".into(),
            stage_id: Some("stage-1".into()),
            accepted_step: clock.accepted_step,
            clock_digest: snapshot.clock_digest.clone(),
            state_digest: snapshot.state_digest.clone(),
            domain_digest: format!("sha256:{}", "c".repeat(64)),
            plan_digest: format!("sha256:{}", "d".repeat(64)),
        };
        let mut runtime = ObservationRuntime::from_fdm_cpu_accepted_state(
            source.clone(),
            snapshot.clone(),
            [2, 1, 1],
            magnetization.clone(),
        )
        .unwrap();
        runtime
            .compute_quantities(&source, &[QuantityId::M])
            .unwrap();

        let mut changed = magnetization;
        changed[1] = [0.0, 0.0, 1.0];
        assert!(matches!(
            ObservationRuntime::from_fdm_cpu_accepted_state(source, snapshot, [2, 1, 1], changed,),
            Err(ObservationRuntimeError::MagnetizationIdentityMismatch)
        ));
    }
}
