//! Explicit native ledger relocation evidence; never initializes a ledger.
use std::io::{BufRead, Read, Write};
use std::path::Path;

use anyhow::{Context, Result, bail};
use fullmag_session::host_resource_ledger::relocation::{
    LedgerRelocationFence, LedgerRelocationInspection,
};
use sha2::{Digest, Sha256};

pub(crate) fn inspect(root: &Path, host_id: &str, hold_fence: bool) -> Result<()> {
    let fence = LedgerRelocationFence::open(root, host_id)?;
    let inspection = fence.inspect()?;
    let mut output = std::io::stdout().lock();
    serde_json::to_writer(&mut output, &inspection)?;
    output.write_all(b"\n")?;
    output.flush()?;
    if hold_fence {
        let mut command = Vec::new();
        std::io::stdin()
            .lock()
            .take(9)
            .read_until(b'\n', &mut command)?;
        if command != b"release\n" {
            bail!(
                "ledger relocation fence requires explicit release; EOF or another command is not success"
            );
        }
        fence.preview(&inspection)?;
        serde_json::to_writer(
            &mut output,
            &serde_json::json!({
                "schema_version": "fullmag.group-ledger-relocation-fence-release.v1",
                "status": "revalidated",
                "semantic_snapshot_sha256": inspection.semantic_snapshot_sha256,
                "manifest_sha256": inspection.manifest_sha256,
            }),
        )?;
        output.write_all(b"\n")?;
        output.flush()?;
    }
    Ok(())
}

pub(crate) fn preview(
    root: &Path,
    host_id: &str,
    expected_path: &Path,
    expected_sha256: &str,
) -> Result<()> {
    if expected_sha256.len() != 64
        || !expected_sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!("ledger relocation expected inspection SHA256 must be lowercase hexadecimal");
    }
    let metadata = std::fs::symlink_metadata(expected_path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        bail!("ledger relocation expected inspection must be an unlinked regular file");
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let file = options.open(expected_path)?;
    if !file.metadata()?.is_file() {
        bail!("ledger relocation expected inspection must be a regular file");
    }
    let mut bytes = Vec::new();
    file.take(8 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > 8 * 1024 * 1024 || format!("{:x}", Sha256::digest(&bytes)) != expected_sha256 {
        bail!(
            "ledger relocation expected inspection differs from its exact byte pin or exceeds its budget"
        );
    }
    let expected: LedgerRelocationInspection =
        serde_json::from_slice(&bytes).context("decode ledger relocation source inspection")?;
    let fence = LedgerRelocationFence::open(root, host_id)?;
    let actual = fence.preview(&expected)?;
    println!(
        "{}",
        serde_json::to_string(&serde_json::json!({
            "schema_version": "fullmag.group-ledger-relocation-preview.v1",
            "status": "verified",
            "expected_inspection_sha256": expected_sha256,
            "inspection": actual,
        }))?
    );
    Ok(())
}
