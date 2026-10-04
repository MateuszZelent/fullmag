//! Startup reservation for native runtime service ownership.
//!
//! The kernel lock serializes service owner creation against cold-store gates.
//! Its fixed descriptor is durable identity only; it is never an owner record
//! and is never removed when the guard is dropped.

use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
};

use anyhow::{bail, Context, Result};
use std::fs::TryLockError;

use crate::repository_path::{checked_path, create_parent, reject_link};

pub const RUNTIME_SERVICE_STARTUP_GATE_LOCK_PATH: &str = "runtime-services/STARTUP-GATE.lock";

const STARTUP_GATE_DESCRIPTOR: &[u8] = b"fullmag.runtime-service-startup-gate.v1\n";
const MAX_STARTUP_GATE_DESCRIPTOR_BYTES: usize = STARTUP_GATE_DESCRIPTOR.len();

/// Holds the native startup reservation until dropped.
///
/// Dropping this value releases only the kernel lock. The stable lock file and
/// its descriptor remain in the store for the next process to validate.
pub struct RuntimeServiceStartupGuard {
    _lock: File,
}

impl RuntimeServiceStartupGuard {
    /// Try to reserve startup and owner publication for this session store.
    ///
    /// `None` means another process currently holds the native reservation.
    /// Corrupt or unexpected lock metadata is an error and is never repaired.
    pub fn try_acquire(root: &Path) -> Result<Option<Self>> {
        if !root.is_absolute()
            || root
                .components()
                .any(|component| matches!(component, std::path::Component::ParentDir))
        {
            bail!("runtime service startup store root must be an absolute normalized path");
        }
        reject_link(root)?;
        if !fs::symlink_metadata(root)?.is_dir() {
            bail!("runtime service startup store root must be a regular directory");
        }
        crate::writer::require_local_filesystem(root)?;

        // Serialize first creation and descriptor publication before any peer
        // can acquire the new inode. An existing corrupt file is never repaired.
        // Writer acquisition is nonblocking; it is released before returning
        // the startup guard, so later store transactions never hold this order.
        let initialization_writer = crate::writer::Writer::new(root.to_path_buf());
        let initialization = initialization_writer.acquire()?;

        let path = create_parent(root, RUNTIME_SERVICE_STARTUP_GATE_LOCK_PATH)?;
        checked_path(root, RUNTIME_SERVICE_STARTUP_GATE_LOCK_PATH)?;
        reject_link(&path)?;
        let (mut file, created) = open_lock_file(&path)?;
        validate_lock_file(&file)?;

        match file.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => return Ok(None),
            Err(TryLockError::Error(error)) => {
                return Err(error).context("acquiring runtime service startup gate")
            }
        }

        if created {
            if file.metadata()?.len() != 0 {
                bail!("new runtime service startup gate contains unexpected metadata");
            }
            file.seek(SeekFrom::Start(0))?;
            file.write_all(STARTUP_GATE_DESCRIPTOR)?;
            file.sync_all()?;
            if let Some(parent) = path.parent() {
                crate::durability::sync_directory(parent)?;
            }
        } else {
            validate_existing_descriptor(&mut file)?;
        }

        drop(initialization);
        Ok(Some(Self { _lock: file }))
    }
}

fn open_lock_file(path: &Path) -> Result<(File, bool)> {
    let mut create = lock_file_options();
    create.create_new(true);
    match create.open(path) {
        Ok(file) => Ok((file, true)),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let file = lock_file_options().open(path).with_context(|| {
                format!("opening runtime service startup gate {}", path.display())
            })?;
            Ok((file, false))
        }
        Err(error) => Err(error)
            .with_context(|| format!("creating runtime service startup gate {}", path.display())),
    }
}

fn lock_file_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    options
}

fn validate_lock_file(file: &File) -> Result<()> {
    let metadata = file.metadata()?;
    #[cfg(windows)]
    let is_reparse = {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    };
    #[cfg(not(windows))]
    let is_reparse = false;
    if !metadata.is_file()
        || is_reparse
        || metadata.len() > MAX_STARTUP_GATE_DESCRIPTOR_BYTES as u64
    {
        bail!("runtime service startup gate must be a bounded regular file");
    }
    Ok(())
}

fn validate_existing_descriptor(file: &mut File) -> Result<()> {
    file.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::new();
    (&mut *file)
        .take((MAX_STARTUP_GATE_DESCRIPTOR_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.as_slice() != STARTUP_GATE_DESCRIPTOR {
        bail!("runtime service startup gate descriptor is corrupt or unsupported");
    }
    Ok(())
}
