//! Bounded terminal command/ACK, consumed only by the normal publisher worker.
use super::CurrentLiveSnapshotPayload;
use anyhow::{anyhow, bail, Context, Result};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct PublicationIdentity {
    sequence: u64,
    pub session_id: String,
    pub run_id: String,
}

struct TerminalRequest {
    identity: PublicationIdentity,
    snapshot: CurrentLiveSnapshotPayload,
    deadline: Instant,
    reply: mpsc::SyncSender<Result<PublicationIdentity>>,
}

pub(super) struct TerminalPublication {
    enabled: bool,
    next_sequence: AtomicU64,
    // One waiting command. Coalescing the notification never discards it.
    pending: Mutex<Option<TerminalRequest>>,
}

impl TerminalPublication {
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled,
            next_sequence: AtomicU64::new(0),
            pending: Mutex::new(None),
        }
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    pub fn publish_and_wait(
        &self,
        snapshot: CurrentLiveSnapshotPayload,
        timeout: Duration,
        wake: &mpsc::SyncSender<()>,
    ) -> Result<()> {
        if !self.enabled {
            return Ok(());
        }
        let deadline = Instant::now()
            .checked_add(timeout)
            .ok_or_else(|| anyhow!("terminal publication deadline overflow"))?;
        let session = snapshot
            .session
            .as_ref()
            .context("terminal snapshot has no session")?;
        let run = snapshot
            .run
            .as_ref()
            .context("terminal snapshot has no run")?;
        if session.session_id.is_empty()
            || run.run_id.is_empty()
            || session.session_id != run.session_id
            || session.run_id != run.run_id
        {
            bail!("terminal snapshot session/run identity is inconsistent");
        }
        let (reply, response) = mpsc::sync_channel(1);
        let identity = {
            let mut pending = self
                .pending
                .try_lock()
                .map_err(|_| anyhow!("terminal command queue is busy or poisoned"))?;
            if pending.is_some() {
                bail!("terminal command queue is full");
            }
            if Instant::now() >= deadline {
                bail!("terminal publication deadline expired before enqueue");
            }
            let sequence = self
                .next_sequence
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                    value.checked_add(1)
                })
                .map_err(|_| anyhow!("terminal publication sequence exhausted"))?
                + 1;
            let identity = PublicationIdentity {
                sequence,
                session_id: session.session_id.clone(),
                run_id: run.run_id.clone(),
            };
            *pending = Some(TerminalRequest {
                identity: identity.clone(),
                snapshot,
                deadline,
                reply,
            });
            identity
        };
        match wake.try_send(()) {
            Ok(()) | Err(mpsc::TrySendError::Full(())) => {}
            Err(mpsc::TrySendError::Disconnected(())) => {
                self.cancel_queued(&identity);
                bail!("terminal publisher worker disconnected");
            }
        }
        let result = match response.recv_timeout(deadline.saturating_duration_since(Instant::now()))
        {
            Ok(result) => result,
            Err(error) => {
                self.cancel_queued(&identity);
                return Err(anyhow!("terminal publication ACK unavailable: {error}"));
            }
        }?;
        if result != identity {
            bail!("terminal publication ACK identity mismatch");
        }
        if Instant::now() >= deadline {
            bail!("terminal publication ACK arrived after deadline");
        }
        Ok(())
    }

    fn cancel_queued(&self, identity: &PublicationIdentity) {
        if let Ok(mut pending) = self.pending.try_lock() {
            if pending
                .as_ref()
                .is_some_and(|request| &request.identity == identity)
            {
                pending.take();
            }
        }
    }

    pub fn process<Owner, Publish>(
        &self,
        worker_session: &str,
        mut owner: Owner,
        mut publish: Publish,
    ) where
        Owner: FnMut(&PublicationIdentity) -> Result<()>,
        Publish: FnMut(&PublicationIdentity, &mut CurrentLiveSnapshotPayload) -> Result<()>,
    {
        let request = self
            .pending
            .lock()
            .ok()
            .and_then(|mut pending| pending.take());
        let Some(mut request) = request else {
            return;
        };
        let result = (|| {
            if request.identity.session_id != worker_session {
                bail!("terminal command belongs to another worker session");
            }
            if Instant::now() >= request.deadline {
                bail!("terminal command expired before publication");
            }
            owner(&request.identity)?;
            if Instant::now() >= request.deadline {
                bail!("terminal command expired during owner validation");
            }
            publish(&request.identity, &mut request.snapshot)?;
            owner(&request.identity)?;
            if Instant::now() >= request.deadline {
                bail!("terminal command expired before ACK");
            }
            Ok(request.identity.clone())
        })();
        // Never block, and never acknowledge partial/failed publication.
        let _ = request.reply.try_send(result);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_snapshot() -> CurrentLiveSnapshotPayload {
        CurrentLiveSnapshotPayload {
            session: Some(super::super::SessionManifest {
                session_id: "session".into(),
                run_id: "run".into(),
                status: "completed".into(),
                interactive_session_requested: false,
                script_path: "test.py".into(),
                problem_name: "test".into(),
                requested_backend: "fem".into(),
                explicit_selection: true,
                authored_requested_device: "cpu".into(),
                requested_device: "cpu".into(),
                requested_precision: "double".into(),
                requested_mode: "strict".into(),
                requested_cpu_threads: None,
                execution_mode: "strict".into(),
                precision: "double".into(),
                resolved_backend: None,
                resolved_device: None,
                resolved_precision: None,
                resolved_mode: None,
                resolved_runtime_family: None,
                resolved_engine_id: None,
                resolved_worker: None,
                resolved_cpu_threads: None,
                resolved_fallback: None,
                fem_crossover_decision: None,
                artifact_dir: "artifacts".into(),
                started_at_unix_ms: 0,
                finished_at_unix_ms: 1,
                plan_summary: serde_json::json!({}),
            }),
            run: Some(super::super::RunManifest {
                run_id: "run".into(), session_id: "session".into(), status: "completed".into(),
                total_steps: 0, final_time: None, final_e_ex: None, final_e_demag: None,
                final_e_ext: None, final_e_ani: None, final_e_dmi: None,
                final_e_rotated_dmi: None, final_e_total: None, artifact_dir: "artifacts".into(),
            }),
            ..CurrentLiveSnapshotPayload::default()
        }
    }

    fn queued(
        timeout: Duration,
    ) -> (
        TerminalPublication,
        mpsc::Receiver<Result<PublicationIdentity>>,
    ) {
        let queue = TerminalPublication::new(true);
        let (reply, response) = mpsc::sync_channel(1);
        *queue.pending.lock().unwrap() = Some(TerminalRequest {
            identity: PublicationIdentity {
                sequence: 7,
                session_id: "session".into(),
                run_id: "run".into(),
            },
            snapshot: CurrentLiveSnapshotPayload::default(),
            deadline: Instant::now() + timeout,
            reply,
        });
        (queue, response)
    }

    #[test]
    fn exact_ack_only_after_full_publication_and_both_owner_checks() {
        let (queue, response) = queued(Duration::from_secs(1));
        let checks = std::cell::Cell::new(0);
        queue.process(
            "session",
            |_| {
                checks.set(checks.get() + 1);
                Ok(())
            },
            |_, _| {
                assert_eq!(checks.get(), 1);
                assert!(matches!(
                    response.try_recv(),
                    Err(mpsc::TryRecvError::Empty)
                ));
                Ok(())
            },
        );
        let ack = response.recv().unwrap().unwrap();
        assert_eq!(ack.sequence, 7);
        assert_eq!(ack.session_id, "session");
        assert_eq!(ack.run_id, "run");
        assert_eq!(checks.get(), 2);
    }

    #[test]
    fn failed_full_publish_is_not_acknowledged() {
        let (queue, response) = queued(Duration::from_secs(1));
        queue.process(
            "session",
            |_| Ok(()),
            |_, _| Err(anyhow!("full snapshot failed")),
        );
        assert!(response.recv().unwrap().is_err());
    }

    #[test]
    fn owner_switch_after_publication_is_not_acknowledged() {
        let (queue, response) = queued(Duration::from_secs(1));
        let checks = std::cell::Cell::new(0);
        queue.process(
            "session",
            |_| {
                checks.set(checks.get() + 1);
                if checks.get() == 2 {
                    bail!("owner switched");
                }
                Ok(())
            },
            |_, _| Ok(()),
        );
        assert!(response.recv().unwrap().is_err());
    }

    #[test]
    fn stale_worker_and_expired_commands_do_not_publish() {
        for (worker, timeout) in [
            ("other", Duration::from_secs(1)),
            ("session", Duration::ZERO),
        ] {
            let (queue, response) = queued(timeout);
            queue.process(
                worker,
                |_| panic!("owner must not be queried"),
                |_, _| panic!("must not publish"),
            );
            assert!(response.recv().unwrap().is_err());
        }
    }

    #[test]
    fn disabled_api_is_explicit_noop_even_without_worker_or_payload() {
        let queue = TerminalPublication::new(false);
        let (wake, receiver) = mpsc::sync_channel(1);
        drop(receiver);
        queue
            .publish_and_wait(CurrentLiveSnapshotPayload::default(), Duration::ZERO, &wake)
            .unwrap();
        assert_eq!(queue.next_sequence.load(Ordering::Acquire), 0);
    }

    #[test]
    fn queue_full_disconnect_timeout_and_identity_drift_fail_closed() {
        let (wake, receiver) = mpsc::sync_channel(1);
        let (full, _) = queued(Duration::from_secs(1));
        assert!(full
            .publish_and_wait(valid_snapshot(), Duration::from_secs(1), &wake)
            .unwrap_err()
            .to_string()
            .contains("queue is full"));
        let mut drift = valid_snapshot();
        drift.run.as_mut().unwrap().session_id = "other".into();
        assert!(TerminalPublication::new(true)
            .publish_and_wait(drift, Duration::from_secs(1), &wake)
            .unwrap_err()
            .to_string()
            .contains("inconsistent"));
        drop(receiver);
        assert!(TerminalPublication::new(true)
            .publish_and_wait(valid_snapshot(), Duration::from_secs(1), &wake)
            .unwrap_err()
            .to_string()
            .contains("disconnected"));
        let (wake, _receiver) = mpsc::sync_channel(1);
        let queue = TerminalPublication::new(true);
        assert!(queue
            .publish_and_wait(valid_snapshot(), Duration::from_millis(5), &wake)
            .is_err());
        assert!(queue.pending.lock().unwrap().is_none());
    }

    #[test]
    fn actual_wait_uses_exact_monotonic_ack_without_idle_flag_polling() {
        let queue = std::sync::Arc::new(TerminalPublication::new(true));
        let (wake, receiver) = mpsc::sync_channel(1);
        for expected in 1..=2 {
            let sender_queue = std::sync::Arc::clone(&queue);
            let sender_wake = wake.clone();
            let thread = std::thread::spawn(move || {
                sender_queue.publish_and_wait(
                    valid_snapshot(),
                    Duration::from_secs(2),
                    &sender_wake,
                )
            });
            receiver.recv_timeout(Duration::from_secs(1)).unwrap();
            queue.process(
                "session",
                |_| Ok(()),
                |identity, snapshot| {
                    assert_eq!(identity.sequence, expected);
                    assert_eq!(snapshot.session.as_ref().unwrap().status, "completed");
                    Ok(())
                },
            );
            thread.join().unwrap().unwrap();
        }
    }
}
