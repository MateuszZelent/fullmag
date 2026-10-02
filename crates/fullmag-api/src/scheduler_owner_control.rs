//! Private admission/drain channel owned by the runtime service, never by UI.
use anyhow::{bail, Context, Result};
use std::ffi::OsString;
use std::io::{self, Read};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::sync::oneshot;

#[derive(Debug, PartialEq, Eq)]
pub enum DrainCause {
    Requested,
    OwnerDisconnected,
}

pub fn parse(value: Option<OsString>, resident: bool) -> Result<bool> {
    let Some(value) = value else {
        return Ok(false);
    };
    if !resident {
        bail!("--owner-control requires --resident true");
    }
    if value != "stdin-v1" {
        bail!("--owner-control supports only stdin-v1");
    }
    Ok(true)
}

fn read_request(mut reader: impl Read) -> io::Result<DrainCause> {
    let mut token = [0];
    match reader.read_exact(&mut token) {
        Ok(()) if token[0] == 1 => Ok(DrainCause::Requested),
        Ok(()) => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid scheduler owner-control token",
        )),
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => {
            Ok(DrainCause::OwnerDisconnected)
        }
        Err(error) => Err(error),
    }
}

pub fn monitor(
    reader: impl Read + Send + 'static,
    shutdown: Arc<AtomicBool>,
    owner_observed: Arc<AtomicBool>,
) -> io::Result<oneshot::Receiver<io::Result<DrainCause>>> {
    let (sender, receiver) = oneshot::channel();
    // A blocking stdin read must not keep Tokio's blocking pool alive on exit.
    std::thread::Builder::new()
        .name("scheduler-owner-control".into())
        .spawn(move || {
            let result = read_request(reader);
            owner_observed.store(true, Ordering::Release);
            shutdown.store(true, Ordering::Release);
            let _ = sender.send(result);
        })?;
    Ok(receiver)
}

pub async fn wait(receiver: &mut Option<oneshot::Receiver<io::Result<DrainCause>>>) -> Result<()> {
    let result = match receiver.as_mut() {
        Some(receiver) => receiver
            .await
            .context("scheduler owner-control monitor closed")?
            .context("read scheduler owner-control request")?,
        None => return std::future::pending().await,
    };
    require_explicit_drain(result)
}

fn require_explicit_drain(cause: DrainCause) -> Result<()> {
    if cause == DrainCause::OwnerDisconnected {
        bail!("scheduler owner disconnected without an explicit drain request");
    }
    Ok(())
}

/// Compact versioned events; enabled only for runtime-owned child processes.
pub fn announce(
    event: &str,
    role: &str,
    pool_id: Option<&str>,
    generation: Option<u64>,
) -> Result<()> {
    use std::io::Write;
    let identity = fullmag_build_info::identity();
    println!(
        "{}",
        serde_json::to_string(&serde_json::json!({
            "schema_version": "scheduler_owner_event.v1",
            "event": event,
            "role": role,
            "protocol": "stdin-v1",
            "pid": std::process::id(),
            "owner_token": std::env::var("FULLMAG_RUNTIME_SERVICE_OWNER").ok(),
            "pool_id": pool_id,
            "generation": generation,
            "git_commit": identity.git_commit,
            "source_snapshot_sha256": identity.source_snapshot_sha256,
        }))?
    );
    std::io::stdout()
        .flush()
        .context("flush scheduler owner event")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn private_channel_distinguishes_drain_and_disconnect() {
        assert_eq!(read_request(&[1][..]).unwrap(), DrainCause::Requested);
        assert_eq!(
            read_request(&[][..]).unwrap(),
            DrainCause::OwnerDisconnected
        );
        assert_eq!(
            read_request(&[0][..]).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }
    #[test]
    fn unexpected_owner_loss_is_not_clean_shutdown() {
        assert!(require_explicit_drain(DrainCause::Requested).is_ok());
        assert!(require_explicit_drain(DrainCause::OwnerDisconnected).is_err());
    }
    #[test]
    fn owner_control_is_versioned_and_resident_only() {
        assert!(!parse(None, false).unwrap());
        assert!(parse(Some("stdin-v1".into()), true).unwrap());
        assert!(parse(Some("stdin-v1".into()), false).is_err());
        assert!(parse(Some("stdin-v2".into()), true).is_err());
    }
    #[test]
    fn io_failure_closes_admission_before_notification() {
        struct Broken;
        impl Read for Broken {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                Err(io::Error::new(io::ErrorKind::PermissionDenied, "fixture"))
            }
        }
        let shutdown = Arc::new(AtomicBool::new(false));
        let receiver = monitor(
            Broken,
            Arc::clone(&shutdown),
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        let result = receiver.blocking_recv().unwrap();
        assert!(shutdown.load(Ordering::Acquire));
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::PermissionDenied);
    }
    #[test]
    fn invalid_token_closes_admission_before_notification() {
        let shutdown = Arc::new(AtomicBool::new(false));
        let receiver = monitor(
            &[255][..],
            Arc::clone(&shutdown),
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        assert_eq!(
            receiver.blocking_recv().unwrap().unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert!(shutdown.load(Ordering::Acquire));
    }
    #[test]
    fn owner_loss_closes_admission_before_notification() {
        let shutdown = Arc::new(AtomicBool::new(false));
        let observed = Arc::new(AtomicBool::new(false));
        let receiver = monitor(&[][..], Arc::clone(&shutdown), Arc::clone(&observed)).unwrap();
        assert_eq!(
            receiver.blocking_recv().unwrap().unwrap(),
            DrainCause::OwnerDisconnected
        );
        assert!(shutdown.load(Ordering::Acquire));
        assert!(observed.load(Ordering::Acquire));
    }
}
