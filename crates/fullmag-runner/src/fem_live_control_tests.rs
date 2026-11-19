use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

fn accepted_update(step: u64) -> StepUpdate {
    StepUpdate {
        stats: StepStats { step, ..StepStats::default() },
        coupled_checkpoint: None,
        grid: [0, 0, 0],
        fem_mesh_generation_id: Some("mesh-generation".into()),
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

#[test]
fn pending_stop_reaches_fem_executor_after_publishing_accepted_update() {
    for observer_action in [StepAction::Continue, StepAction::Pause] {
        let stop = AtomicBool::new(true);
        let field_interval = Duration::from_millis(250);
        let mut published = Vec::new();
        let display = DisplaySelectionState::default;
        let mut observer = |update: StepUpdate| {
            published.push((update.stats.step, update.fem_mesh_generation_id));
            observer_action
        };
        let action = with_interruptible_fem_live_consumer(types::LiveStepConsumer {
            grid: [0, 0, 0],
            field_cadence: LiveFieldCadence::new(7, field_interval),
            initial_snapshot: false,
            display_selection: Some(&display), interrupt_requested: Some(&stop),
            on_step: &mut observer,
        }, |consumer| {
            assert_eq!(consumer.field_cadence.every_n(), 7);
            assert_eq!(consumer.field_cadence.min_interval(), field_interval);
            assert!(!consumer.initial_snapshot);
            assert!(consumer.display_selection.is_some());
            assert!(std::ptr::eq(consumer.interrupt_requested.unwrap(), &stop));
            (consumer.on_step)(accepted_update(23))
        });
        assert_eq!(action, StepAction::Stop);
        assert_eq!(published, vec![(23, Some("mesh-generation".into()))]);
    }
}

#[test]
fn stop_requested_by_fem_observer_is_effective_at_same_accepted_boundary() {
    let stop = AtomicBool::new(false);
    let mut published = 0;
    let mut observer = |_: StepUpdate| {
        published += 1;
        stop.store(true, Ordering::Release);
        StepAction::Continue
    };
    let action = with_interruptible_fem_live_consumer(types::LiveStepConsumer {
        grid: [0, 0, 0],
        field_cadence: LiveFieldCadence::every_n_steps(1),
        initial_snapshot: true,
        display_selection: None, interrupt_requested: Some(&stop), on_step: &mut observer,
    }, |consumer| (consumer.on_step)(accepted_update(1)));
    assert_eq!(action, StepAction::Stop);
    assert_eq!(published, 1);
}

#[test]
fn no_pending_fem_stop_preserves_observer_actions() {
    let stop = AtomicBool::new(false);
    for signal in [None, Some(&stop)] {
        for expected in [StepAction::Continue, StepAction::Pause, StepAction::Stop] {
            let mut published = 0;
            let mut observer = |_: StepUpdate| { published += 1; expected };
            let action = with_interruptible_fem_live_consumer(types::LiveStepConsumer {
                grid: [0, 0, 0],
                field_cadence: LiveFieldCadence::every_n_steps(1),
                initial_snapshot: false,
                display_selection: None, interrupt_requested: signal, on_step: &mut observer,
            }, |consumer| (consumer.on_step)(accepted_update(4)));
            assert_eq!(action, expected);
            assert_eq!(published, 1);
        }
    }
}
