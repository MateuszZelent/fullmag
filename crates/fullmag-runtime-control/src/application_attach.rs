//! Authoring-time attachment to the optional native application service.
//!
//! Preparation is read-only and pins the API instance and accepted store
//! before any configuration publication is allowed.  The background task
//! owns only the attach attempt; the native service has its own persistent
//! owner and is never killed or drained by this module.

use anyhow::{bail, Context, Result};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread::{self, JoinHandle},
};

/// A reason why automatic native attachment is intentionally disabled.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ApplicationAttachBlockReason {
    /// The managed accepted-run store is not available in this launch.
    AcceptedStoreUnavailable,
    /// The API was discovered but is owned by another launcher.
    ApiNotOwned,
}

impl ApplicationAttachBlockReason {
    fn message(self) -> &'static str {
        match self {
            Self::AcceptedStoreUnavailable => {
                "accepted run storage is unavailable; native application attach is disabled"
            }
            Self::ApiNotOwned => {
                "API is owned by another launcher; native application attach is disabled"
            }
        }
    }
}

/// Read-only startup input for authoring clients.
pub struct PreparedApplicationAttach {
    api_instance_id: String,
    api_port: u16,
    config_path: Option<OsString>,
    expected_store: Option<PathBuf>,
    blocked_reason: Option<ApplicationAttachBlockReason>,
}

impl PreparedApplicationAttach {
    /// The UUID of the API instance observed during preparation.
    pub fn api_instance_id(&self) -> &str {
        &self.api_instance_id
    }

    /// Start the optional attach task without waiting for service readiness.
    ///
    /// When no explicit service configuration was requested, this returns
    /// `None` and does not create a store, configuration, or thread.
    pub fn start(self) -> Result<Option<BackgroundApplicationAttach>> {
        if let Some(reason) = self.blocked_reason {
            eprintln!("[fullmag-runtime-control] {}", reason.message());
            return Ok(None);
        }
        let Some(expected_store) = self.expected_store else {
            return Ok(None);
        };
        let config_path = self
            .config_path
            .context("configured application attach has no captured config path")?;
        let api_instance_id = self.api_instance_id;
        let api_port = self.api_port;
        spawn_owned_thread("fullmag-application-attach", move |cancel| {
            run_application_attach(
                api_port,
                &api_instance_id,
                &expected_store,
                config_path,
                cancel,
            )
        })
        .map(Some)
    }

    /// Disable automatic attachment while preserving the prepared API pin.
    /// This does not stop or drain an already running native service.
    pub fn disable_automatic_attach(&mut self, reason: ApplicationAttachBlockReason) {
        if self.config_path.is_some() {
            self.blocked_reason = Some(reason);
        }
    }
}

/// Prepare authoring startup without creating a SessionStore or writing a
/// runtime configuration.  An explicit configuration path is captured as an
/// `OsString`; the background task never rereads the environment.
pub fn prepare_for_authoring(
    repo_root: &Path,
    state_root: &Path,
    api_port: u16,
) -> Result<PreparedApplicationAttach> {
    let config_path = std::env::var_os("FULLMAG_RUNTIME_SERVICE_CONFIG");
    let expected_store = config_path
        .as_ref()
        .and_then(|_| crate::accepted_store::configured_submit_store_root(repo_root, state_root));
    let verify_api = |port: u16, expected_store: Option<&Path>| match expected_store {
        Some(store) => crate::runtime_service_client::verify_api_store(port, store),
        None => crate::runtime_service_client::verify_api_identity(port),
    };
    prepare_for_authoring_with(api_port, config_path, expected_store, &verify_api)
}

fn prepare_for_authoring_with(
    api_port: u16,
    config_path: Option<OsString>,
    expected_store: Option<PathBuf>,
    verify_api: &dyn Fn(u16, Option<&Path>) -> Result<String>,
) -> Result<PreparedApplicationAttach> {
    let blocked_reason = match (&config_path, &expected_store) {
        (None, None) => None,
        (Some(_), None) => Some(ApplicationAttachBlockReason::AcceptedStoreUnavailable),
        (Some(_), Some(_)) => None,
        (None, Some(_)) => bail!("application store was prepared without explicit config"),
    };
    let api_instance_id = verify_api(api_port, expected_store.as_deref())?;
    Ok(PreparedApplicationAttach {
        api_instance_id,
        api_port,
        config_path,
        expected_store,
        blocked_reason,
    })
}

fn run_application_attach(
    api_port: u16,
    expected_api_instance_id: &str,
    expected_store: &Path,
    config_path: OsString,
    cancel: Arc<AtomicBool>,
) -> Result<()> {
    if cancel.load(Ordering::Acquire) {
        return Ok(());
    }

    // This check is before prepare_application_config, which may publish the
    // persisted APPLICATION.json configuration.
    let before_config_write =
        crate::runtime_service_client::verify_api_store(api_port, expected_store)?;
    require_same_api_instance(
        expected_api_instance_id,
        &before_config_write,
        "before application config write",
    )?;
    if cancel.load(Ordering::Acquire) {
        return Ok(());
    }

    let config = crate::runtime_service_client::prepare_application_config(
        expected_store,
        Some(config_path),
    )?;
    let prelaunch_check = || -> Result<()> {
        if cancel.load(Ordering::Acquire) {
            bail!("application attach cancelled before native service launch");
        }
        let observed = crate::runtime_service_client::verify_api_store(api_port, expected_store)?;
        require_same_api_instance(
            expected_api_instance_id,
            &observed,
            "before native service launch",
        )
    };

    let owner = crate::runtime_service_client::ensure_config_cancellable(
        config,
        cancel.as_ref(),
        &prelaunch_check,
    )?;
    if cancel.load(Ordering::Acquire) {
        bail!("application attach observation cancelled after ensure; service retained");
    }

    let after_attach = crate::runtime_service_client::verify_api_store(api_port, expected_store)?;
    require_same_api_instance(
        expected_api_instance_id,
        &after_attach,
        "after native service attach",
    )?;
    drop(owner);
    Ok(())
}

fn require_same_api_instance(expected: &str, observed: &str, phase: &str) -> Result<()> {
    if expected != observed {
        bail!("API instance changed {phase}; application attach refused");
    }
    Ok(())
}

/// Owns the cancellable attach task.  Dropping the guard never touches the
/// native service itself; it only cancels and joins this observer-side task.
pub struct BackgroundApplicationAttach {
    cancel: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl Drop for BackgroundApplicationAttach {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Release);
        if let Some(join) = self.join.take() {
            if join.join().is_err() {
                eprintln!(
                    "[fullmag-runtime-control] application attach task panicked; native service state remains observer truth"
                );
            }
        }
    }
}

fn spawn_owned_thread<F>(name: &str, task: F) -> Result<BackgroundApplicationAttach>
where
    F: FnOnce(Arc<AtomicBool>) -> Result<()> + Send + 'static,
{
    let cancel = Arc::new(AtomicBool::new(false));
    let task_cancel = Arc::clone(&cancel);
    let log_cancel = Arc::clone(&cancel);
    let log_name = name.to_owned();
    let join = thread::Builder::new()
        .name(name.to_owned())
        .spawn(move || {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| task(task_cancel)));
            match outcome {
                Ok(Ok(())) => {}
                Ok(Err(error)) if log_cancel.load(Ordering::Acquire) => {
                    eprintln!(
                        "[fullmag-runtime-control] {log_name} stopped: {error:#}; native service state remains observer truth"
                    );
                }
                Ok(Err(error)) => {
                    eprintln!(
                        "[fullmag-runtime-control] {log_name} unavailable: {error:#}; native service state remains observer truth"
                    );
                }
                Err(_) => {
                    eprintln!(
                        "[fullmag-runtime-control] {log_name} panicked; native service state remains observer truth"
                    );
                }
            }
        })?;
    Ok(BackgroundApplicationAttach {
        cancel,
        join: Some(join),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn owned_thread_returns_before_waiting_task_finishes_and_drop_joins_it() {
        let (started_tx, started_rx) = mpsc::channel();
        let finished = Arc::new(AtomicBool::new(false));
        let finished_task = Arc::clone(&finished);
        let guard = spawn_owned_thread("test-attach-wait", move |cancel| {
            started_tx.send(()).expect("signal task start");
            while !cancel.load(Ordering::Acquire) {
                thread::park_timeout(Duration::from_millis(5));
            }
            finished_task.store(true, Ordering::Release);
            Ok(())
        })
        .expect("spawn owned attach task");
        started_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("task should start promptly");
        assert!(!finished.load(Ordering::Acquire));
        drop(guard);
        assert!(finished.load(Ordering::Acquire));
    }

    #[test]
    fn task_errors_are_logged_without_panicking_or_leaking_the_thread() {
        let (finished_tx, finished_rx) = mpsc::channel();
        let guard = spawn_owned_thread("test-attach-error", move |_cancel| {
            finished_tx.send(()).expect("signal task completion");
            Err(anyhow::anyhow!("synthetic attach unavailable"))
        })
        .expect("spawn owned attach task");
        finished_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("error task should finish");
        drop(guard);
    }

    #[test]
    fn no_explicit_config_returns_without_thread_or_store() {
        let directory = tempfile::tempdir().expect("temporary attach fixture");
        let expected_store = directory.path().join("store-never-created");
        let prepared = prepare_for_authoring_with(1, None, None, &|port, store| {
            assert_eq!(port, 1);
            assert!(store.is_none());
            Ok("12345678-1234-4234-8234-123456789abc".to_string())
        })
        .expect("no-config preflight");
        assert_eq!(
            prepared.api_instance_id(),
            "12345678-1234-4234-8234-123456789abc"
        );
        assert_eq!(prepared.blocked_reason, None);
        assert!(prepared.start().expect("no-config start").is_none());
        assert!(!expected_store.exists());
    }

    #[test]
    fn explicit_config_path_is_captured_without_reading_it_during_preflight() {
        let directory = tempfile::tempdir().expect("temporary attach fixture");
        let expected_store = directory.path().join("accepted-store-never-created");
        let config_paths = [
            directory.path().join("missing-application.json"),
            directory.path().to_path_buf(),
        ];

        for config_path in config_paths {
            let captured_path = config_path.clone();
            let prepared = prepare_for_authoring_with(
                2,
                Some(config_path.clone().into_os_string()),
                Some(expected_store.clone()),
                &|port, store| {
                    assert_eq!(port, 2);
                    assert_eq!(store, Some(expected_store.as_path()));
                    Ok("12345678-1234-4234-8234-123456789abc".to_string())
                },
            )
            .expect("invalid config must not block authoring preflight");
            assert_eq!(
                prepared.config_path.as_deref(),
                Some(captured_path.as_os_str())
            );
            assert_eq!(
                prepared.expected_store.as_deref(),
                Some(expected_store.as_path())
            );
            assert_eq!(prepared.blocked_reason, None);
            assert!(!expected_store.exists());
        }
    }

    #[test]
    fn unavailable_store_keeps_api_pin_but_disables_automatic_attach() {
        let directory = tempfile::tempdir().expect("temporary attach fixture");
        let config_path = directory.path().join("missing-application.json");
        let prepared = prepare_for_authoring_with(
            4,
            Some(config_path.clone().into_os_string()),
            None,
            &|port, store| {
                assert_eq!(port, 4);
                assert!(store.is_none());
                Ok("12345678-1234-4234-8234-123456789abc".to_string())
            },
        )
        .expect("API identity should remain available without accepted store");
        assert_eq!(
            prepared.blocked_reason,
            Some(ApplicationAttachBlockReason::AcceptedStoreUnavailable)
        );
        assert_eq!(
            prepared.api_instance_id(),
            "12345678-1234-4234-8234-123456789abc"
        );
        assert!(prepared.start().expect("blocked start").is_none());
        assert!(!config_path.exists());
    }

    #[test]
    fn api_not_owned_disables_attach_without_starting_a_thread() {
        let directory = tempfile::tempdir().expect("temporary attach fixture");
        let config_path = directory.path().join("missing-application.json");
        let expected_store = directory.path().join("accepted-store-never-created");
        let mut prepared = prepare_for_authoring_with(
            5,
            Some(config_path.clone().into_os_string()),
            Some(expected_store.clone()),
            &|port, store| {
                assert_eq!(port, 5);
                assert_eq!(store, Some(expected_store.as_path()));
                Ok("12345678-1234-4234-8234-123456789abc".to_string())
            },
        )
        .expect("owned API/store preflight");
        prepared.disable_automatic_attach(ApplicationAttachBlockReason::ApiNotOwned);
        assert_eq!(
            prepared.blocked_reason,
            Some(ApplicationAttachBlockReason::ApiNotOwned)
        );
        assert!(prepared.start().expect("API-not-owned start").is_none());
        assert!(!config_path.exists());
        assert!(!expected_store.exists());
    }

    #[test]
    fn api_verifier_failure_remains_fatal_before_config_use() {
        let directory = tempfile::tempdir().expect("temporary attach fixture");
        let config_path = directory.path().join("missing-application.json");
        let expected_store = directory.path().join("accepted-store-never-created");
        let result = prepare_for_authoring_with(
            3,
            Some(config_path.clone().into_os_string()),
            Some(expected_store),
            &|port, store| {
                assert_eq!(port, 3);
                assert!(store.is_some());
                Err(anyhow::anyhow!("API instance unavailable"))
            },
        );
        let error = match result {
            Ok(_) => panic!("API verifier failure must abort preflight"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("API instance unavailable"));
        assert!(!config_path.exists());
    }
}
