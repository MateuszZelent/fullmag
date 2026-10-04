//! Launches and verifies the exact candidate API after an owned cold commit.

use std::{
    fs::File,
    io::Write,
    path::Path,
    process::{Child, Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

use anyhow::{bail, Context, Result};
use serde_json::Value;

use crate::development_api_owner::{AuthoringAcquisition, PreparedDevelopmentRestore};
use crate::development_api_supervisor::DevelopmentApiSupervisor;

pub(crate) struct PreparedReplacementApi {
    pub(crate) supervisor: DevelopmentApiSupervisor,
    pub(crate) acquisition: AuthoringAcquisition,
    pub(crate) receipt: DevelopmentReplacementReceipt,
}

#[derive(serde::Serialize)]
pub(crate) struct DevelopmentReplacementReceipt {
    pub(crate) api_pid: u32,
    pub(crate) api_instance_id: String,
    pub(crate) session_id: Option<String>,
    pub(crate) session_epoch: u64,
    pub(crate) scene_sha256: String,
    pub(crate) completion: Value,
    pub(crate) candidate_owner_helper_pid: u32,
}

pub(crate) enum ReplacementLaunchEvent {
    CandidateOwnerHelperWaited { pid: u32 },
    ApiStarted { pid: u32, port: u16 },
}

/// The caller still owns the old, accepted supervisor and its cold proof.
/// No port, executable, or credentials are accepted from frontend input.
pub(crate) fn launch_committed_replacement(
    old: &DevelopmentApiSupervisor,
    repo_root: &Path,
    prepared: &PreparedDevelopmentRestore,
    api_port: u16,
    log: File,
    mut observe: impl FnMut(ReplacementLaunchEvent),
) -> Result<PreparedReplacementApi> {
    if old.state() != crate::development_api_supervisor::DevelopmentApiSupervisorState::Accepted
        || api_port == 0
        || prepared.old_api_instance_id() != old.owner().api_instance_id()
    {
        bail!("replacement launch requires the accepted exact old API exit");
    }
    let (launch, helper_pid) = old.owner().candidate_owner(
        repo_root,
        prepared.candidate_bundle_id(),
        prepared.candidate_manifest_sha256(),
    )?;
    observe(ReplacementLaunchEvent::CandidateOwnerHelperWaited { pid: helper_pid });
    let api = prepared.candidate_bundle_root().join("bin/fullmag-api.exe");
    // candidate_owner has validated the complete sealed bundle. There is no
    // sibling/install-root executable fallback for a replacement.
    let mut command = Command::new(&api);
    command
        .current_dir(repo_root)
        .env("FULLMAG_API_PORT", api_port.to_string())
        .env("FULLMAG_REPO_ROOT", repo_root)
        .env("FULLMAG_DISABLE_STATIC_CONTROL_ROOM", "1")
        .env_remove("FULLMAG_DEVELOPMENT_RESTORE_STDIN")
        .env_remove("FULLMAG_DEVELOPMENT_OWNER_PROBE_TOKEN")
        .stdin(Stdio::piped())
        .stdout(log.try_clone()?)
        .stderr(log);
    launch.configure_candidate_command(&mut command, prepared.accepted_store_scope())?;
    if prepared.envelope_bytes().is_some() {
        command.env("FULLMAG_DEVELOPMENT_RESTORE_STDIN", "1");
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut startup = CandidateStartup {
        child: Some(
            command
                .spawn()
                .context("unable to spawn the sealed replacement API")?,
        ),
    };
    let pid = startup.child_mut()?.id();
    if pid == 0 {
        bail!("replacement API has no process identity");
    }
    observe(ReplacementLaunchEvent::ApiStarted {
        pid,
        port: api_port,
    });
    send_prelisten_input(&mut startup, prepared.envelope_bytes())?;
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(1))
        .build()?;
    let deadline = Instant::now() + Duration::from_secs(20);
    let instance = loop {
        if startup.child_mut()?.try_wait()?.is_some() {
            bail!("replacement API exited before owner confirmation");
        }
        if let Ok(response) = client
            .get(format!(
                "http://127.0.0.1:{api_port}/v2/platform/development-backend"
            ))
            .send()
        {
            if response.status().is_success() {
                if let Some(pin) = response.headers().get("x-fullmag-api-instance") {
                    let pin = pin.to_str()?.to_owned();
                    let parsed = uuid::Uuid::parse_str(&pin)?;
                    if parsed.is_nil()
                        || parsed.to_string() != pin
                        || pin == prepared.old_api_instance_id()
                    {
                        bail!("replacement API did not expose a fresh canonical identity");
                    }
                    break pin;
                }
            }
        }
        if Instant::now() >= deadline {
            bail!("replacement API readiness outcome is unknown");
        }
        thread::sleep(Duration::from_millis(25));
    };
    let owner = launch.confirm(pid, api_port, &instance)?;
    let acquired = owner.acquire(&uuid::Uuid::new_v4().to_string())?;
    let workspace = acquired.workspace();
    let (session_id, session_epoch, scene_sha256) = match prepared.expected_scene() {
        None => {
            if workspace["state"] != "no_session" || workspace["session_epoch"] != 0 {
                bail!("replacement invented an authoring session");
            }
            (
                None,
                0,
                fullmag_session::canonical_json_sha256(&Value::Null),
            )
        }
        Some(scene) => {
            let session = workspace["identity"]["session_id"]
                .as_str()
                .context("restored replacement has no session identity")?;
            if workspace["state"] != "session"
                || workspace["scene_document"] != *scene
                || workspace["identity"]["api_instance_id"] != instance
                || workspace["identity"]["session_epoch"] != 1
                || Some(session) == prepared.old_session_id()
            {
                bail!("replacement did not restore the exact scene with a fresh identity");
            }
            let digest = fullmag_session::canonical_json_sha256(scene);
            if workspace["scene_sha256"] != digest {
                bail!("replacement scene digest differs from its restored scene");
            }
            (Some(session.to_owned()), 1, digest)
        }
    };
    // The caller adopts this exact child before sending completion, so an
    // unknown completion outcome retains both credentials and child custody.
    let child = startup
        .child
        .take()
        .context("replacement child custody was lost")?;
    let supervisor = DevelopmentApiSupervisor::new(child, owner)?;
    Ok(PreparedReplacementApi {
        supervisor,
        acquisition: acquired,
        receipt: DevelopmentReplacementReceipt {
            api_pid: pid,
            api_instance_id: instance,
            session_id,
            session_epoch,
            scene_sha256,
            completion: Value::Null,
            candidate_owner_helper_pid: helper_pid,
        },
    })
}

struct CandidateStartup {
    child: Option<Child>,
}

impl CandidateStartup {
    fn child_mut(&mut self) -> Result<&mut Child> {
        self.child
            .as_mut()
            .context("replacement child custody is unavailable")
    }
}

impl Drop for CandidateStartup {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn send_prelisten_input(startup: &mut CandidateStartup, bytes: Option<&[u8]>) -> Result<()> {
    let input = bytes.unwrap_or_default().to_vec();
    let mut stdin = startup
        .child_mut()?
        .stdin
        .take()
        .context("replacement private stdin is unavailable")?;
    let (sender, receiver) = mpsc::channel();
    let writer = thread::Builder::new()
        .name("development-replacement-stdin".into())
        .spawn(move || {
            let result = stdin.write_all(&input).and_then(|()| stdin.flush());
            drop(stdin);
            let _ = sender.send(result);
        })?;
    let outcome = receiver.recv_timeout(Duration::from_secs(10));
    if !matches!(&outcome, Ok(Ok(()))) {
        let child = startup.child_mut()?;
        let _ = child.kill();
        child
            .wait()
            .context("unable to wait for failed replacement input transport")?;
    }
    writer
        .join()
        .map_err(|_| anyhow::anyhow!("replacement private input transport panicked"))?;
    outcome
        .context("replacement private input transport timed out")?
        .context("replacement private input transport failed")
}
