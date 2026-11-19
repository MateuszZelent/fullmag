//! Adaptive idle polling for resident schedulers.
//!
//! A resident scheduler discovers work by scanning the session store. While
//! anything is happening it polls at the configured interval, so a newly
//! accepted task starts promptly. After a grace period of uninterrupted
//! idleness the interval doubles per idle poll up to a cap, and any activity
//! restores the configured interval. An idle DEV group therefore scans the
//! store about once per second instead of ten times, which matters when the
//! store sits on a slow bind mount (9p) and many groups run side by side.
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// Default cap for the idle poll interval of a resident scheduler.
pub const DEFAULT_IDLE_POLL_MAX_MILLISECONDS: u64 = 1000;
/// Uninterrupted idleness kept at the configured interval before backing off.
const IDLE_BACKOFF_GRACE: Duration = Duration::from_secs(5);
/// Granularity at which a backed-off sleep observes a drain request.
const SHUTDOWN_OBSERVATION_SLICE: Duration = Duration::from_millis(50);

#[derive(Debug)]
pub struct IdleBackoff {
    minimum: Duration,
    maximum: Duration,
    current: Duration,
    idle_since: Option<Instant>,
}

impl IdleBackoff {
    /// `maximum` below `minimum` disables the backoff (fixed interval).
    pub fn new(minimum: Duration, maximum: Duration) -> Self {
        Self {
            minimum,
            maximum: maximum.max(minimum),
            current: minimum,
            idle_since: None,
        }
    }

    /// Any observed work, outcome or contention restores prompt polling.
    pub fn reset(&mut self) {
        self.current = self.minimum;
        self.idle_since = None;
    }

    /// Interval for one idle poll at `now`; advances the backoff.
    pub fn next_idle_interval(&mut self, now: Instant) -> Duration {
        let idle_since = *self.idle_since.get_or_insert(now);
        let interval = self.current;
        if now.saturating_duration_since(idle_since) >= IDLE_BACKOFF_GRACE {
            self.current = self.current.saturating_mul(2).min(self.maximum);
        }
        interval
    }

    /// Sleeps one idle poll, returning early once a drain is requested.
    pub fn sleep_idle(&mut self, shutdown_requested: &AtomicBool) {
        let interval = self.next_idle_interval(Instant::now());
        if interval <= self.minimum {
            std::thread::sleep(interval);
            return;
        }
        let deadline = Instant::now() + interval;
        while !shutdown_requested.load(Ordering::Acquire) {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            std::thread::sleep(SHUTDOWN_OBSERVATION_SLICE.min(deadline - now));
        }
    }
}

/// Parses `--idle-poll-max-milliseconds`; non-resident schedulers keep a fixed
/// interval so bounded `--max-idle-polls` runs stay deterministic.
pub fn idle_poll_maximum(
    value: Option<u64>,
    resident: bool,
    idle_poll_interval: Duration,
) -> anyhow::Result<Duration> {
    if !resident {
        return Ok(idle_poll_interval);
    }
    let maximum = Duration::from_millis(value.unwrap_or(DEFAULT_IDLE_POLL_MAX_MILLISECONDS));
    if maximum < idle_poll_interval {
        anyhow::bail!("--idle-poll-max-milliseconds must not be below --idle-poll-milliseconds");
    }
    Ok(maximum)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: Duration = Duration::from_millis(100);
    const MAX: Duration = Duration::from_millis(1000);

    #[test]
    fn keeps_the_configured_interval_during_the_grace_period() {
        let mut backoff = IdleBackoff::new(MIN, MAX);
        let start = Instant::now();
        for step in 0..40 {
            let now = start + Duration::from_millis(100 * step);
            assert_eq!(backoff.next_idle_interval(now), MIN);
        }
    }

    #[test]
    fn doubles_after_the_grace_period_up_to_the_cap() {
        let mut backoff = IdleBackoff::new(MIN, MAX);
        let start = Instant::now();
        backoff.next_idle_interval(start);
        let late = start + IDLE_BACKOFF_GRACE;
        let observed: Vec<_> = (0..6).map(|_| backoff.next_idle_interval(late)).collect();
        assert_eq!(
            observed,
            [100, 200, 400, 800, 1000, 1000].map(Duration::from_millis)
        );
    }

    #[test]
    fn activity_restores_prompt_polling() {
        let mut backoff = IdleBackoff::new(MIN, MAX);
        let start = Instant::now();
        backoff.next_idle_interval(start);
        let late = start + IDLE_BACKOFF_GRACE;
        for _ in 0..5 {
            backoff.next_idle_interval(late);
        }
        backoff.reset();
        assert_eq!(backoff.next_idle_interval(late), MIN);
    }

    #[test]
    fn non_resident_schedulers_keep_a_fixed_interval() {
        assert_eq!(idle_poll_maximum(Some(5000), false, MIN).unwrap(), MIN);
        assert_eq!(idle_poll_maximum(None, true, MIN).unwrap(), MAX);
        assert!(idle_poll_maximum(Some(50), true, MIN).is_err());
    }

    #[test]
    fn a_drain_request_cuts_a_backed_off_sleep_short() {
        let mut backoff = IdleBackoff::new(MIN, Duration::from_secs(30));
        backoff.current = Duration::from_secs(30);
        backoff.idle_since = Some(Instant::now());
        let shutdown = AtomicBool::new(true);
        let started = Instant::now();
        backoff.sleep_idle(&shutdown);
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
