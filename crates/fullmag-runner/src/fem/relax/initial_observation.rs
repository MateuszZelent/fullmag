//! Initial callback policy, independent of native linking and physical steps.

use crate::types::{LiveStepConsumer, RunError, StepAction, StepStats, StepUpdate};

fn initial_update(live: &LiveStepConsumer<'_>, stats: &StepStats, mesh: &Option<String>) -> StepUpdate {
    StepUpdate {
        coupled_checkpoint: None,
        stats: stats.clone(),
        grid: live.grid,
        fem_mesh_generation_id: mesh.clone(),
        magnetization: None,
        magnetization_carrier: None,
        preview_field: None,
        cached_preview_fields: None,
        hysteresis_field_m_t: None,
        hysteresis_point_index: None,
        hysteresis_settle_step_index: None,
        hysteresis_settle_step_kind: None,
        hysteresis_settle_step_method: None,
        scalar_row_due: true,
        terminal_field_snapshot: false,
        finished: false,
    }
}

pub(crate) fn publish_initial_scalar_without_field_snapshot(
    live: Option<&mut LiveStepConsumer<'_>>,
    stats: &StepStats,
    mesh: &Option<String>,
) -> Option<StepAction> {
    let live = live.filter(|consumer| !consumer.initial_snapshot)?;
    let update = initial_update(live, stats, mesh);
    Some((live.on_step)(update))
}

pub(crate) fn publish_initial_fem_observation_with_capture(
    live: Option<&mut LiveStepConsumer<'_>>,
    stats: &StepStats,
    mesh: &Option<String>,
    capture: impl FnOnce(&mut StepUpdate) -> Result<(), RunError>,
) -> Result<Option<StepAction>, RunError> {
    let Some(live) = live else { return Ok(None); };
    if !live.initial_native_gpu_fields {
        return Ok(publish_initial_scalar_without_field_snapshot(Some(live), stats, mesh));
    }
    if live.initial_snapshot || live.field_every_n == 0 || live.field_every_n == u64::MAX {
        return Err(RunError { message: "initial GPU observation requires its own bounded live mode".into() });
    }
    let mut update = initial_update(live, stats, mesh);
    capture(&mut update)?;
    Ok(Some((live.on_step)(update)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn initial_capture_keeps_the_real_clock_and_returns_stop_or_pause_before_stepping() {
        for action in [StepAction::Continue, StepAction::Stop, StepAction::Pause] {
            let mut updates = Vec::new();
            let captures = Cell::new(0);
            let stats = StepStats { step: 37, time: 2.5e-9, dt: 3.0e-14, ..StepStats::default() };
            let mesh = Some("actual-mesh-generation".into());
            {
                let mut callback = |update| { updates.push(update); action };
                let mut live = LiveStepConsumer {
                    grid: [1, 1, 1], field_every_n: 1, initial_snapshot: false,
                    initial_native_gpu_fields: true, display_selection: None,
                    interrupt_requested: None, on_step: &mut callback,
                };
                let returned = publish_initial_fem_observation_with_capture(
                    Some(&mut live), &stats, &mesh, |update| {
                        captures.set(captures.get() + 1);
                        assert_eq!(update.stats.step, 37);
                        assert_eq!(update.stats.time, 2.5e-9);
                        assert_eq!(update.stats.dt, 3.0e-14);
                        update.magnetization = Some(vec![1.0, 0.0, 0.0]);
                        Ok(())
                    },
                ).unwrap();
                assert_eq!(returned, Some(action));
                assert!(!live.initial_snapshot, "one-shot capture enabled legacy per-step snapshots");
            }
            assert_eq!(captures.get(), 1);
            assert_eq!(updates.len(), 1, "initial scalar callback was duplicated");
            let update = &updates[0];
            assert_eq!(update.fem_mesh_generation_id, mesh);
            assert_eq!(update.magnetization.as_deref(), Some([1.0, 0.0, 0.0].as_slice()));
            assert!(!update.finished);
            assert!(!update.terminal_field_snapshot);
            assert!(update.scalar_row_due);
        }
    }

    #[test]
    fn invalid_initial_capture_never_publishes_an_incomplete_frame_or_falls_back() {
        let callbacks = Cell::new(0);
        let mut callback = |_| { callbacks.set(callbacks.get() + 1); StepAction::Continue };
        let mut live = LiveStepConsumer {
            grid: [1, 1, 1], field_every_n: 1, initial_snapshot: false,
            initial_native_gpu_fields: true, display_selection: None,
            interrupt_requested: None, on_step: &mut callback,
        };
        let error = publish_initial_fem_observation_with_capture(
            Some(&mut live), &StepStats::default(), &Some("mesh".into()),
            |_| Err(RunError { message: "invalid native clock or local-node map".into() }),
        ).unwrap_err();
        assert!(error.message.contains("local-node map"));
        assert_eq!(callbacks.get(), 0);
    }

    #[test]
    fn unavailable_live_budget_and_conflicting_legacy_mode_do_not_capture() {
        for (legacy, cadence) in [(true, 1), (false, 0), (false, u64::MAX)] {
            let mut callback = |_| panic!("invalid initial mode published a frame");
            let mut live = LiveStepConsumer {
                grid: [1, 1, 1], field_every_n: cadence, initial_snapshot: legacy,
                initial_native_gpu_fields: true, display_selection: None,
                interrupt_requested: None, on_step: &mut callback,
            };
            assert!(publish_initial_fem_observation_with_capture(
                Some(&mut live), &StepStats::default(), &None,
                |_| panic!("invalid initial mode captured fields"),
            ).is_err());
        }
    }

    #[test]
    fn legacy_and_scalar_only_callers_do_not_request_initial_gpu_fields() {
        for legacy in [false, true] {
            let callbacks = Cell::new(0);
            let mut callback = |update: StepUpdate| {
                callbacks.set(callbacks.get() + 1);
                assert!(update.magnetization.is_none());
                assert!(update.cached_preview_fields.is_none());
                StepAction::Continue
            };
            let mut live = LiveStepConsumer {
                grid: [1, 1, 1], field_every_n: 1, initial_snapshot: legacy,
                initial_native_gpu_fields: false, display_selection: None,
                interrupt_requested: None, on_step: &mut callback,
            };
            let action = publish_initial_fem_observation_with_capture(
                Some(&mut live), &StepStats::default(), &None,
                |_| panic!("legacy caller invoked initial GPU capture"),
            ).unwrap();
            assert_eq!(callbacks.get(), usize::from(!legacy));
            assert_eq!(action, (!legacy).then_some(StepAction::Continue));
        }
        assert!(publish_initial_fem_observation_with_capture(None, &StepStats::default(), &None,
            |_| panic!("no observer requested fields")).unwrap().is_none());
    }
}
