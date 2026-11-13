//! Producer-side cadence for heavy live payloads.
//!
//! A heavy payload is the live magnetization copy (device-to-host on GPU) and,
//! when `every_n == 1`, the complete observation-field catalog. Two gates
//! decide whether an accepted step carries one:
//!
//! - the step gate, the historical `field_every_n` contract;
//! - an optional wall-clock gate for consumers that read the latest payload
//!   at a fixed rate. Without it a solver taking thousands of steps per second
//!   copies and evaluates every field on every step, although the consumer
//!   only ever reads the newest one.
//!
//! The gates only select steps. A published payload is still captured from,
//! and labelled with, exactly one accepted step (`source_step`,
//! `source_clock`). When the wall-clock gate skips a step that the step gate
//! admitted, the cadence remembers it, so a producer can publish the last
//! accepted state when its loop ends (pause, stop or completion) and the
//! displayed magnetization never lags behind the final step.

use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub struct LiveFieldCadence {
    every_n: u64,
    min_interval: Duration,
    last_admitted_at: Option<Instant>,
    deferred_step: Option<u64>,
}

impl LiveFieldCadence {
    /// Step gate and wall-clock gate. `Duration::ZERO` disables the clock gate.
    pub fn new(every_n: u64, min_interval: Duration) -> Self {
        Self {
            every_n,
            min_interval,
            last_admitted_at: None,
            deferred_step: None,
        }
    }

    /// Historical step-only cadence.
    pub fn every_n_steps(every_n: u64) -> Self {
        Self::new(every_n, Duration::ZERO)
    }

    /// Step stride of the step gate; `u64::MAX` disables heavy payloads.
    pub fn every_n(&self) -> u64 {
        self.every_n
    }

    pub fn min_interval(&self) -> Duration {
        self.min_interval
    }

    /// Whether an admitted heavy payload carries the full observation catalog.
    pub(crate) fn publishes_full_catalog(&self) -> bool {
        self.every_n == 1
    }

    /// Step gate only. Used for decisions that must not depend on wall time,
    /// such as scalar-row sampling.
    pub(crate) fn step_due(&self, step: u64) -> bool {
        step % self.every_n.max(1) == 0
    }

    /// Admit or skip the heavy payload of one accepted single-grid step.
    /// Call at most once per accepted step: an admission starts a new interval.
    pub(crate) fn heavy_payload_due(&mut self, step: u64) -> bool {
        let step_due = self.step_due(step);
        self.admit(step, step_due)
    }

    /// Multilayer variant: the multilayer step gate also skips step 0 and a
    /// disabled cadence.
    pub(crate) fn multilayer_field_due(&mut self, step: u64) -> bool {
        let step_due = crate::types::fdm_multilayer_live_field_due(step, self.every_n);
        self.admit(step, step_due)
    }

    /// The accepted step whose payload the wall-clock gate skipped, when no
    /// later step was published. Returns it once.
    pub(crate) fn take_deferred_step(&mut self) -> Option<u64> {
        self.deferred_step.take()
    }

    fn admit(&mut self, step: u64, step_due: bool) -> bool {
        if !step_due {
            return false;
        }
        let now = Instant::now();
        if self
            .last_admitted_at
            .is_some_and(|last| now.duration_since(last) < self.min_interval)
        {
            self.deferred_step = Some(step);
            return false;
        }
        self.last_admitted_at = Some(now);
        self.deferred_step = None;
        true
    }
}

/// Magnetization-only update that republishes the last accepted step when
/// the loop ends on pause or stop after the wall-clock gate skipped it.
/// Completion publishes through each producer's terminal snapshot instead.
pub(crate) fn deferred_magnetization_update(
    stats: &crate::StepStats,
    grid: [u32; 3],
    fem_mesh_generation_id: Option<String>,
    magnetization: Vec<f64>,
    magnetization_carrier: Option<crate::LiveMagnetizationCarrier>,
) -> crate::StepUpdate {
    let mut stats = stats.clone();
    stats.magnetization_source_step = Some(stats.step);
    crate::StepUpdate {
        coupled_checkpoint: None,
        stats,
        grid,
        fem_mesh_generation_id,
        magnetization: Some(magnetization),
        magnetization_carrier,
        preview_field: None,
        cached_preview_fields: None,
        hysteresis_field_m_t: None,
        hysteresis_point_index: None,
        hysteresis_settle_step_index: None,
        hysteresis_settle_step_kind: None,
        hysteresis_settle_step_method: None,
        scalar_row_due: false,
        terminal_field_snapshot: false,
        finished: false,
    }
}

#[cfg(test)]
mod tests {
    use super::LiveFieldCadence;
    use std::time::Duration;

    #[test]
    fn step_only_cadence_keeps_the_historical_stride() {
        let mut cadence = LiveFieldCadence::every_n_steps(3);
        let admitted = (1..=9)
            .filter(|step| cadence.heavy_payload_due(*step))
            .collect::<Vec<_>>();
        assert_eq!(admitted, vec![3, 6, 9]);
        assert_eq!(cadence.take_deferred_step(), None);
    }

    #[test]
    fn wall_clock_gate_skips_steps_and_remembers_the_last_one() {
        let mut cadence = LiveFieldCadence::new(1, Duration::from_secs(3600));
        assert!(cadence.heavy_payload_due(1));
        assert!(!cadence.heavy_payload_due(2));
        assert!(!cadence.heavy_payload_due(3));
        assert_eq!(cadence.take_deferred_step(), Some(3));
        assert_eq!(cadence.take_deferred_step(), None);
    }

    #[test]
    fn disabled_cadence_never_admits_or_defers() {
        let mut cadence = LiveFieldCadence::new(u64::MAX, Duration::from_secs(3600));
        assert!(!cadence.multilayer_field_due(1));
        assert!(!cadence.multilayer_field_due(2));
        assert_eq!(cadence.take_deferred_step(), None);
    }
}
