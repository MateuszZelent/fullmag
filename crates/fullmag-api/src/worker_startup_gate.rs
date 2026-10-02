//! Startup ordering for a supervisor-owned Windows process tree.
use std::io::{self, Read};

pub const STARTUP_GATE_FLAG: &str = "--startup-gate";
pub const STARTUP_GATE_VERSION: &str = "stdin-v1";
pub const STARTUP_GATE_RELEASE: u8 = 1;

pub fn wait_for_release(mut input: impl Read) -> io::Result<()> {
    let mut token = [0];
    input.read_exact(&mut token)?;
    if token[0] != STARTUP_GATE_RELEASE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid worker startup release",
        ));
    }
    Ok(())
}

/// Runtime service children must match the owner's pinned source identity.
pub fn verify_runtime_owner_build() -> anyhow::Result<()> {
    use anyhow::Context;
    let commit = std::env::var_os("FULLMAG_RUNTIME_SERVICE_SOURCE_COMMIT");
    let snapshot = std::env::var_os("FULLMAG_RUNTIME_SERVICE_SOURCE_SNAPSHOT");
    if commit.is_none() && snapshot.is_none() {
        return Ok(());
    }
    let commit = commit
        .context("runtime service source commit is missing")?
        .into_string()
        .map_err(|_| anyhow::anyhow!("runtime service commit is not UTF-8"))?;
    let snapshot = snapshot
        .context("runtime service source snapshot is missing")?
        .into_string()
        .map_err(|_| anyhow::anyhow!("runtime service snapshot is not UTF-8"))?;
    verify_source_identity(&commit, &snapshot, fullmag_build_info::identity())
}

fn verify_source_identity(
    commit: &str,
    snapshot: &str,
    identity: fullmag_build_info::BuildIdentity,
) -> anyhow::Result<()> {
    if commit.len() != 40
        || snapshot.len() != 64
        || !commit
            .bytes()
            .chain(snapshot.bytes())
            .all(|b| b.is_ascii_hexdigit())
        || commit != identity.git_commit
        || snapshot != identity.source_snapshot_sha256
    {
        anyhow::bail!("runtime service child source identity mismatch");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_children_reject_mixed_source_capsules() {
        let identity = fullmag_build_info::BuildIdentity {
            built_at_utc: "fixture",
            worktree_state: "clean",
            git_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            source_snapshot_sha256:
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        };
        assert!(verify_source_identity(
            identity.git_commit,
            identity.source_snapshot_sha256,
            identity
        )
        .is_ok());
        assert!(verify_source_identity(
            "cccccccccccccccccccccccccccccccccccccccc",
            identity.source_snapshot_sha256,
            identity
        )
        .is_err());
        assert!(verify_source_identity(
            identity.git_commit,
            "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            identity
        )
        .is_err());
        assert!(verify_source_identity("", identity.source_snapshot_sha256, identity).is_err());
    }
    #[test]
    fn supervisor_release_is_required_before_worker_initialization() {
        assert!(wait_for_release(&[STARTUP_GATE_RELEASE][..]).is_ok());
        assert_eq!(
            wait_for_release(&[][..]).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
        assert_eq!(
            wait_for_release(&[0][..]).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }
}
