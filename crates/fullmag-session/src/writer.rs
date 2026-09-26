//! A native single-writer lease shared by document and CAS transactions.
//!
//! The lock inode is never renamed or unlinked. Kernel ownership, not PID or
//! an expired timestamp, authorizes writes. Nested operations on the owning
//! thread reuse the handle; another thread or store handle fails explicitly.
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::ThreadId;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::repository_path::{checked_path, reject_link};

const LOCK_DESCRIPTOR: &[u8] = b"fullmag.writer.lock.v1\n";
const LOCK_DESCRIPTOR_PATH: &str = "WRITER.lock";
const OWNER_RECORD_PATH: &str = "WRITER.owner.json";

/// A transient conflict with an active native writer, safe to retry later.
#[derive(Debug)]
pub struct StoreWriterBusy;

impl std::fmt::Display for StoreWriterBusy {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("session store writer is busy")
    }
}

impl std::error::Error for StoreWriterBusy {}

#[derive(Clone, Serialize, Deserialize)]
struct OwnerRecord {
    schema: String,
    token: String,
    process_start_token: String,
    host: String,
    pid: u32,
    acquired_at: chrono::DateTime<chrono::Utc>,
    heartbeat_at: chrono::DateTime<chrono::Utc>,
    released: bool,
}

struct Held {
    file: File,
    thread: ThreadId,
    depth: usize,
    record: OwnerRecord,
}

pub(crate) struct Writer {
    root: PathBuf,
    held: Mutex<Option<Held>>,
}

/// Keeps the native writer lease alive across a complete publication.
pub struct WriteTransaction {
    writer: Arc<Writer>,
    token: String,
}

impl Writer {
    pub(crate) fn new(root: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            root,
            held: Mutex::new(None),
        })
    }

    pub(crate) fn acquire(self: &Arc<Self>) -> Result<WriteTransaction> {
        let mut held = self
            .held
            .lock()
            .map_err(|_| anyhow::anyhow!("writer mutex poisoned"))?;
        if let Some(active) = held.as_mut() {
            if active.thread != std::thread::current().id() {
                return Err(StoreWriterBusy.into());
            }
            let mut record = active.record.clone();
            record.heartbeat_at = chrono::Utc::now();
            write_owner_record(&self.root, &record)?;
            active.record = record;
            active.depth += 1;
            return Ok(WriteTransaction {
                writer: self.clone(),
                token: active.record.token.clone(),
            });
        }
        require_local_filesystem(&self.root)?;
        if checked_path(&self.root, "LOCK")?.exists() {
            bail!("legacy session LOCK requires controlled owner recovery before writing");
        }
        let file = open_lock_descriptor(&self.root)?;
        let host = hostname()?;
        if let Some(previous) = read_owner_record(&self.root)? {
            if previous.schema != "fullmag.writer.v1" {
                bail!("unsupported writer owner schema; controlled recovery required");
            }
            if !previous.released && previous.host != host {
                bail!(
                    "foreign-host writer record requires controlled recovery; refusing PID/age based takeover"
                );
            }
        }
        static PROCESS_TOKEN: OnceLock<String> = OnceLock::new();
        let now = chrono::Utc::now();
        let record = OwnerRecord {
            schema: "fullmag.writer.v1".into(),
            token: uuid::Uuid::new_v4().to_string(),
            process_start_token: PROCESS_TOKEN
                .get_or_init(|| uuid::Uuid::new_v4().to_string())
                .clone(),
            host,
            pid: std::process::id(),
            acquired_at: now,
            heartbeat_at: now,
            released: false,
        };
        write_owner_record(&self.root, &record)?;
        crate::durability::sync_directory(&self.root)?;
        let token = record.token.clone();
        *held = Some(Held {
            file,
            thread: std::thread::current().id(),
            depth: 1,
            record,
        });
        Ok(WriteTransaction {
            writer: self.clone(),
            token,
        })
    }
}

impl Drop for WriteTransaction {
    fn drop(&mut self) {
        let Ok(mut held) = self.writer.held.lock() else {
            return;
        };
        let Some(active) = held.as_mut() else { return };
        if active.record.token != self.token {
            tracing::error!("refusing release of a different writer owner token");
            return;
        }
        active.depth -= 1;
        if active.depth == 0 {
            active.record.released = true;
            active.record.heartbeat_at = chrono::Utc::now();
            if let Err(error) = write_owner_record(&self.writer.root, &active.record) {
                tracing::error!(%error, "could not persist writer release; native handle still closes");
            }
            // Closing our own descriptor releases only our own native lock.
            *held = None;
        }
    }
}

fn open_lock_descriptor(root: &Path) -> Result<File> {
    let path = checked_path(root, LOCK_DESCRIPTOR_PATH)?;
    let mut file = match OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            OpenOptions::new().read(true).write(true).open(&path)?
        }
        Err(error) => return Err(error).with_context(|| format!("opening {}", path.display())),
    };

    match file.try_lock() {
        Ok(()) => {}
        Err(TryLockError::WouldBlock) => return Err(StoreWriterBusy.into()),
        Err(TryLockError::Error(error)) => {
            return Err(error).context("acquiring native session writer lock");
        }
    }

    let mut descriptor = Vec::new();
    file.read_to_end(&mut descriptor)?;
    if descriptor.is_empty() {
        file.write_all(LOCK_DESCRIPTOR)?;
        file.sync_all()?;
        crate::durability::sync_directory(root)?;
    } else if descriptor != LOCK_DESCRIPTOR {
        bail!(
            "legacy or corrupt {} descriptor requires controlled recovery",
            LOCK_DESCRIPTOR_PATH
        );
    }

    Ok(file)
}

fn read_owner_record(root: &Path) -> Result<Option<OwnerRecord>> {
    let path = checked_path(root, OWNER_RECORD_PATH)?;
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(&path)
        .with_context(|| format!("reading writer owner record {}", path.display()))?;
    if bytes.is_empty() {
        bail!("empty writer owner record requires controlled recovery");
    }
    let record: OwnerRecord = serde_json::from_slice(&bytes)
        .context("corrupt writer owner record; controlled recovery required")?;
    Ok(Some(record))
}

fn write_owner_record(root: &Path, record: &OwnerRecord) -> Result<()> {
    let data = serde_json::to_vec(record)?;
    let path = checked_path(root, OWNER_RECORD_PATH)?;
    crate::durability::atomic_write_owner(&path, &data)
}

fn hostname() -> Result<String> {
    for name in ["COMPUTERNAME", "HOSTNAME", "HOST"] {
        if let Ok(value) = std::env::var(name) {
            if !value.is_empty() {
                return Ok(value);
            }
        }
    }
    #[cfg(unix)]
    {
        let mut buffer = [0u8; 256];
        if unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) } == 0 {
            let end = buffer.iter().position(|b| *b == 0).unwrap_or(buffer.len());
            return Ok(String::from_utf8(buffer[..end].to_vec())?);
        }
    }
    bail!("cannot establish writer host identity")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LocalFilesystemKind {
    LinuxExtFamily,
    LinuxXfs,
    LinuxBtrfs,
    LinuxTmpfs,
    LinuxOverlay,
    WindowsLocal,
}

fn nearest_existing_ancestor(root: &Path) -> Result<PathBuf> {
    let mut candidate = if root.is_absolute() {
        root.to_path_buf()
    } else {
        std::env::current_dir()?.join(root)
    };
    loop {
        match fs::symlink_metadata(&candidate) {
            Ok(_) => {
                reject_link(&candidate)?;
                return fs::canonicalize(&candidate)
                    .with_context(|| format!("canonicalizing {}", candidate.display()));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if !candidate.pop() {
                    bail!(
                        "filesystem preflight cannot find an existing ancestor of {}",
                        root.display()
                    );
                }
            }
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("checking filesystem ancestor {}", candidate.display())
                });
            }
        }
    }
}

fn classify_local_filesystem(root: &Path) -> Result<LocalFilesystemKind> {
    let existing = nearest_existing_ancestor(root)?;
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::ffi::OsStrExt;
        let path = std::ffi::CString::new(existing.as_os_str().as_bytes())?;
        let mut stat = std::mem::MaybeUninit::<libc::statfs>::uninit();
        if unsafe { libc::statfs(path.as_ptr(), stat.as_mut_ptr()) } != 0 {
            return Err(std::io::Error::last_os_error()).context("checking repository filesystem");
        }
        let kind = unsafe { stat.assume_init() }.f_type as u64;
        return match kind {
            // ext2/ext3/ext4 share the Linux superblock magic.
            0xef53 => Ok(LocalFilesystemKind::LinuxExtFamily),
            0x5846_5342 => Ok(LocalFilesystemKind::LinuxXfs),
            0x9123_683e => Ok(LocalFilesystemKind::LinuxBtrfs),
            0x0102_1994 => Ok(LocalFilesystemKind::LinuxTmpfs),
            0x794c_7630 => Ok(LocalFilesystemKind::LinuxOverlay),
            _ => bail!(
                "filesystem type 0x{kind:x} is not in the supported local filesystem set; power-loss durability is unverified"
            ),
        };
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetVolumePathNameW(path: *const u16, volume: *mut u16, size: u32) -> i32;
            fn GetDriveTypeW(root: *const u16) -> u32;
        }
        let path: Vec<u16> = existing.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut volume = vec![0u16; 32768];
        if unsafe { GetVolumePathNameW(path.as_ptr(), volume.as_mut_ptr(), volume.len() as u32) }
            == 0
        {
            return Err(std::io::Error::last_os_error()).context("checking repository volume");
        }
        if !matches!(unsafe { GetDriveTypeW(volume.as_ptr()) }, 2 | 3 | 6) {
            bail!("non-local or unknown volume is not qualified for session writes");
        }
        return Ok(LocalFilesystemKind::WindowsLocal);
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        let _ = existing;
        bail!("session writer filesystem capability is not established on this platform");
    }
}

/// Network filesystems and unknown Linux filesystems need their own qualified
/// lock/durability route. The check is safe before the target root exists: it
/// probes the nearest existing ancestor instead of creating the target first.
pub(crate) fn require_local_filesystem(root: &Path) -> Result<()> {
    let _ = classify_local_filesystem(root)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_descriptor_is_stable_and_owner_is_separate() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("store");
        std::fs::create_dir_all(&root).unwrap();
        let writer = Writer::new(root.clone());

        let lease = writer.acquire().unwrap();
        drop(lease);
        assert_eq!(
            std::fs::read(root.join(LOCK_DESCRIPTOR_PATH)).unwrap(),
            LOCK_DESCRIPTOR
        );
        let owner: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.join(OWNER_RECORD_PATH)).unwrap()).unwrap();
        assert_eq!(owner["schema"], "fullmag.writer.v1");

        let lease = writer.acquire().unwrap();
        drop(lease);
        assert_eq!(
            std::fs::read(root.join(LOCK_DESCRIPTOR_PATH)).unwrap(),
            LOCK_DESCRIPTOR
        );
    }

    #[test]
    fn nonexistent_root_uses_existing_ancestor_for_preflight() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("missing").join("store");
        require_local_filesystem(&root).unwrap();
    }
}
