//! Read-only native service discovery. Failed observation never starts a service.
use anyhow::{bail, Context, Result};
use fullmag_session::{
    repository_path::checked_path,
    runtime_service::{
        validate_descriptor, RuntimeServiceOwnerDescriptor, RuntimeServiceState,
        RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH,
    },
};
use serde::Deserialize;
use std::{
    fs::File,
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::Path,
    time::{Duration, Instant},
};

const MAX_RESPONSE: usize = 256 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StatusResponse {
    schema_version: String,
    nonce: String,
    owner: RuntimeServiceOwnerDescriptor,
}

fn require_ready(
    owner: &RuntimeServiceOwnerDescriptor,
    target: &str,
    commit: &str,
    snapshot: &str,
) -> Result<()> {
    validate_descriptor(owner)?;
    if owner.target_id != target
        || owner.build_commit.as_deref() != Some(commit)
        || owner.build_snapshot.as_deref() != Some(snapshot)
    {
        bail!("native service target/build mismatch; attach refused");
    }
    if owner.state != RuntimeServiceState::Ready {
        bail!("native service is not ready; recovery or lifecycle observation required");
    }
    Ok(())
}

fn validate_response(
    bytes: &[u8],
    nonce: &str,
    expected: &RuntimeServiceOwnerDescriptor,
    target: &str,
    commit: &str,
    snapshot: &str,
) -> Result<RuntimeServiceOwnerDescriptor> {
    let response: StatusResponse =
        serde_json::from_slice(bytes).context("decode native service status")?;
    if response.schema_version != "runtime_service_status.v1" || response.nonce != nonce {
        bail!("native service status version/challenge mismatch");
    }
    require_ready(&response.owner, target, commit, snapshot)?;
    let observed = &response.owner;
    if observed.owner_token != expected.owner_token
        || observed.process_start_token != expected.process_start_token
        || observed.pid != expected.pid
        || observed.host != expected.host
        || observed.control_address != expected.control_address
        || observed.compute_pool_id != expected.compute_pool_id
        || observed.preparation_pool_id != expected.preparation_pool_id
        || observed.compute_pool_generation != expected.compute_pool_generation
        || observed.preparation_pool_generation != expected.preparation_pool_generation
    {
        bail!("native service owner/pool identity changed during discovery");
    }
    Ok(response.owner)
}

fn remaining(deadline: Instant) -> Result<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|duration| !duration.is_zero())
        .context("native service discovery timed out; outcome unknown, restart refused")
}

pub(crate) fn probe(
    store_root: &Path,
    target: &str,
    timeout_seconds: u64,
) -> Result<RuntimeServiceOwnerDescriptor> {
    if !(1..=30).contains(&timeout_seconds) {
        bail!("native service discovery timeout must be 1..30 seconds");
    }
    if !store_root.is_absolute()
        || !store_root.is_dir()
        || store_root
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        bail!("native service discovery requires an absolute existing store directory");
    }
    let path = checked_path(store_root, RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH)?;
    let mut bytes = Vec::new();
    File::open(path)
        .context("read native service descriptor; no automatic start")?
        .take((MAX_RESPONSE + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_RESPONSE {
        bail!("native service descriptor exceeds budget");
    }
    let expected: RuntimeServiceOwnerDescriptor = serde_json::from_slice(&bytes)?;
    let identity = fullmag_build_info::identity();
    require_ready(
        &expected,
        target,
        identity.git_commit,
        identity.source_snapshot_sha256,
    )?;
    let address: SocketAddr = expected
        .control_address
        .as_deref()
        .context("native service has no control address")?
        .parse()?;
    // Do not resolve DNS or connect to a descriptor-selected remote address.
    if !address.is_ipv4() || !address.ip().is_loopback() || address.port() == 0 {
        bail!("native service discovery requires nonzero IPv4 loopback address");
    }
    let deadline = Instant::now() + Duration::from_secs(timeout_seconds);
    let mut stream = TcpStream::connect_timeout(&address, remaining(deadline)?)
        .context("native service unreachable; outcome unknown, restart refused")?;
    let nonce = uuid::Uuid::new_v4().to_string();
    let mut request = serde_json::to_vec(&serde_json::json!({
        "schema_version":"runtime_service_control.v1", "owner_token":expected.owner_token,
        "command":"status", "nonce":nonce,
    }))?;
    request.push(b'\n');
    // Recompute the common deadline after every partial write/read.
    let mut written = 0;
    while written < request.len() {
        stream.set_write_timeout(Some(remaining(deadline)?))?;
        let count = stream.write(&request[written..])?;
        if count == 0 {
            bail!("native service discovery write closed");
        }
        written += count;
    }
    let mut response = Vec::new();
    loop {
        stream.set_read_timeout(Some(remaining(deadline)?))?;
        let mut buffer = [0u8; 1024];
        let count = stream.read(&mut buffer)?;
        if count == 0 {
            bail!("native service closed before status frame; outcome unknown");
        }
        if let Some(end) = buffer[..count].iter().position(|byte| *byte == b'\n') {
            if end + 1 != count {
                bail!("native service status has trailing frame data");
            }
            response.extend_from_slice(&buffer[..end]);
            if response.len() > MAX_RESPONSE {
                bail!("native service response exceeds budget");
            }
            break;
        }
        response.extend_from_slice(&buffer[..count]);
        if response.len() > MAX_RESPONSE {
            bail!("native service response exceeds budget");
        }
    }
    validate_response(
        &response,
        &nonce,
        &expected,
        target,
        identity.git_commit,
        identity.source_snapshot_sha256,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owner() -> RuntimeServiceOwnerDescriptor {
        serde_json::from_value(serde_json::json!({
            "schema_version":"runtime_service_owner.v1",
            "owner_token":uuid::Uuid::new_v4(),
            "process_start_token":uuid::Uuid::new_v4(),
            "pid":42,"host":"test-host","target_id":"desktop",
            "protocol":"stdin-v1","state":"ready",
            "acquired_at":"2026-10-03T00:00:00Z","heartbeat_at":"2026-10-03T00:00:00Z",
            "control_address":"127.0.0.1:12345",
            "build_commit":"a".repeat(40),"build_snapshot":"b".repeat(64),
            "compute_pool_id":"compute","preparation_pool_id":"prep",
            "compute_pool_generation":1,"preparation_pool_generation":2,
            "children":[{"role":"compute","pid":43,"status":"running"},
                {"role":"preparation","pid":44,"status":"running"}],
        }))
        .unwrap()
    }

    #[test]
    fn discovery_accepts_only_matching_live_identity() {
        let expected = owner();
        let response = |observed: &RuntimeServiceOwnerDescriptor, nonce: &str| {
            serde_json::to_vec(
                &serde_json::json!({"schema_version":"runtime_service_status.v1",
                "nonce":nonce,"owner":observed}),
            )
            .unwrap()
        };
        let commit = "a".repeat(40);
        let snapshot = "b".repeat(64);
        assert!(validate_response(
            &response(&expected, "fresh"),
            "fresh",
            &expected,
            "desktop",
            &commit,
            &snapshot
        )
        .is_ok());
        assert!(validate_response(
            &response(&expected, "stale"),
            "fresh",
            &expected,
            "desktop",
            &commit,
            &snapshot
        )
        .is_err());
        for field in ["owner", "start", "pool", "build", "state"] {
            let mut changed = expected.clone();
            match field {
                "owner" => changed.owner_token = uuid::Uuid::new_v4().to_string(),
                "start" => changed.process_start_token = uuid::Uuid::new_v4().to_string(),
                "pool" => changed.compute_pool_generation = Some(3),
                "build" => changed.build_commit = Some("c".repeat(40)),
                "state" => changed.state = RuntimeServiceState::Draining,
                _ => unreachable!(),
            }
            assert!(
                validate_response(
                    &response(&changed, "fresh"),
                    "fresh",
                    &expected,
                    "desktop",
                    &commit,
                    &snapshot
                )
                .is_err(),
                "{field}"
            );
        }
    }

    #[test]
    fn expired_deadline_is_unknown_and_never_restarted() {
        assert!(remaining(Instant::now() - Duration::from_secs(1)).is_err());
    }
}
