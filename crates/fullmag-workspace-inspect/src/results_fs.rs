//! Handle-based, read-only filesystem access for the results inspector.
//!
//! Result roots are user-controlled filesystem paths.  Keep path resolution
//! inside an opened directory descriptor on Unix so a symlink or ancestor
//! replacement cannot redirect a read after validation.  The public scanner
//! still owns logical result paths; this module only owns the descriptor
//! boundary.

use std::fs::{self, File, Metadata};
use std::io;
use std::path::{Path, PathBuf};

/// A directory whose descriptor remains open for the lifetime of the object.
///
/// On Linux, [`read_dir`](Self::read_dir) resolves through `/proc/self/fd`
/// rather than reopening the logical path.  On Windows the retained ancestor
/// and directory handles deny delete sharing, so the logical path remains
/// attached to the same directory while the iterator is created.
#[derive(Debug)]
pub(super) struct PinnedDirectory {
    handle: File,
    logical_path: PathBuf,
    #[cfg(windows)]
    _ancestors: Vec<File>,
}

impl PinnedDirectory {
    pub(super) fn metadata(&self) -> io::Result<Metadata> {
        self.handle.metadata()
    }

    pub(super) fn read_dir(&self) -> io::Result<fs::ReadDir> {
        #[cfg(target_os = "linux")]
        {
            use std::os::fd::AsRawFd;

            return fs::read_dir(format!("/proc/self/fd/{}", self.handle.as_raw_fd()));
        }

        #[cfg(all(unix, not(target_os = "linux")))]
        {
            use std::os::fd::AsRawFd;

            return fs::read_dir(format!("/dev/fd/{}", self.handle.as_raw_fd()));
        }

        #[cfg(windows)]
        {
            return fs::read_dir(&self.logical_path);
        }

        #[cfg(not(any(unix, windows)))]
        {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "pinned directory enumeration is unsupported on this platform",
            ))
        }
    }

    pub(super) fn open_child_directory(&self, name: &std::ffi::OsStr) -> io::Result<Self> {
        let mut components = Path::new(name).components();
        if !matches!(components.next(), Some(std::path::Component::Normal(_)))
            || components.next().is_some()
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid child directory name",
            ));
        }
        #[cfg(unix)]
        {
            platform::open_directory_at(self, name)
        }
        #[cfg(not(unix))]
        {
            platform::open_directory(&self.logical_path.join(name))
        }
    }

    pub(super) fn open_child_regular(&self, name: &std::ffi::OsStr) -> io::Result<File> {
        let mut components = Path::new(name).components();
        if !matches!(components.next(), Some(std::path::Component::Normal(_)))
            || components.next().is_some()
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid child file name",
            ));
        }
        #[cfg(unix)]
        {
            platform::open_regular_at(self, name)
        }
        #[cfg(not(unix))]
        {
            platform::open_regular_at(self, name)
        }
    }

    /// Open only a child's attributes on Windows, without requiring data-read
    /// permission for files that the scanner inventories but never reads.
    #[cfg(windows)]
    pub(super) fn open_child_metadata_file(
        &self,
        name: &std::ffi::OsStr,
    ) -> io::Result<File> {
        let mut components = Path::new(name).components();
        if !matches!(components.next(), Some(std::path::Component::Normal(_)))
            || components.next().is_some()
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid child file name",
            ));
        }
        platform::open_metadata_file_at(self, name)
    }

    pub(super) fn logical_path(&self) -> &Path {
        &self.logical_path
    }
}

/// Open one regular file without following links or blocking on a FIFO.
pub(super) fn open_regular(path: &Path) -> io::Result<File> {
    platform::open_regular(path)
}

/// Open and pin one directory without following links.
pub(super) fn open_directory(path: &Path) -> io::Result<PinnedDirectory> {
    platform::open_directory(path)
}

#[cfg(unix)]
mod platform {
    use super::*;
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    struct Identity {
        device: u64,
        inode: u64,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    struct StatInfo {
        identity: Identity,
        mode: libc::mode_t,
    }

    fn invalid_path(path: &Path, detail: &str) -> io::Error {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{}: {detail}", path.display()),
        )
    }

    fn components(path: &Path) -> io::Result<Vec<&std::ffi::OsStr>> {
        if !path.is_absolute() {
            return Err(invalid_path(path, "an absolute path is required"));
        }

        let mut result = Vec::new();
        for component in path.components() {
            match component {
                std::path::Component::RootDir | std::path::Component::CurDir => {}
                std::path::Component::Normal(name) => result.push(name),
                std::path::Component::ParentDir => {
                    return Err(invalid_path(
                        path,
                        "parent-directory components are rejected",
                    ));
                }
                std::path::Component::Prefix(_) => {
                    return Err(invalid_path(path, "path prefixes are unsupported on Unix"));
                }
            }
        }
        Ok(result)
    }

    fn root_directory() -> io::Result<File> {
        let name = CString::new("/").expect("literal contains no NUL");
        let fd = unsafe {
            libc::open(
                name.as_ptr(),
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(unsafe { File::from_raw_fd(fd) })
    }

    fn open_child(
        directory: &File,
        name: &std::ffi::OsStr,
        flags: libc::c_int,
    ) -> io::Result<File> {
        let name = CString::new(name.as_bytes()).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "path component contains an embedded NUL",
            )
        })?;
        let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(unsafe { File::from_raw_fd(fd) })
    }

    fn stat_info(stat: &libc::stat) -> StatInfo {
        StatInfo {
            identity: Identity {
                device: stat.st_dev as u64,
                inode: stat.st_ino as u64,
            },
            mode: stat.st_mode,
        }
    }

    fn stat_at(directory: &File, name: &std::ffi::OsStr) -> io::Result<StatInfo> {
        let name = CString::new(name.as_bytes()).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "path component contains an embedded NUL",
            )
        })?;
        let mut stat = unsafe { std::mem::zeroed::<libc::stat>() };
        let result = unsafe {
            libc::fstatat(
                directory.as_raw_fd(),
                name.as_ptr(),
                &mut stat,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if result < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(stat_info(&stat))
    }

    fn stat_file(file: &File) -> io::Result<StatInfo> {
        let mut stat = unsafe { std::mem::zeroed::<libc::stat>() };
        if unsafe { libc::fstat(file.as_raw_fd(), &mut stat) } < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(stat_info(&stat))
    }

    fn regular(stat: StatInfo) -> bool {
        (stat.mode & libc::S_IFMT) == libc::S_IFREG
    }

    fn open_parent_chain(path: &Path, names: &[&std::ffi::OsStr]) -> io::Result<File> {
        let mut directory = root_directory()?;
        for name in names {
            directory = open_child(
                &directory,
                name,
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW,
            )?;
            if !directory.metadata()?.is_dir() {
                return Err(invalid_path(path, "an ancestor is not a directory"));
            }
        }
        Ok(directory)
    }

    pub(super) fn open_regular(path: &Path) -> io::Result<File> {
        let names = components(path)?;
        let Some((file_name, parents)) = names.split_last() else {
            return Err(invalid_path(path, "a regular file component is required"));
        };
        let directory = open_parent_chain(path, parents)?;

        // Reject a special file before opening it.  O_NONBLOCK below is still
        // required for a concurrent replacement by a FIFO or device node.
        let before = stat_at(&directory, file_name)?;
        if !regular(before) {
            return Err(invalid_path(path, "the target is not a regular file"));
        }
        let file = open_child(
            &directory,
            file_name,
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
        )?;
        if !file.metadata()?.is_file() {
            return Err(invalid_path(
                path,
                "the opened target is not a regular file",
            ));
        }
        let opened = stat_file(&file)?;
        let after = stat_at(&directory, file_name)?;
        if !regular(opened)
            || opened.identity != before.identity
            || after.identity != before.identity
        {
            return Err(invalid_path(
                path,
                "the target changed or is not a regular file",
            ));
        }
        Ok(file)
    }

    pub(super) fn open_directory_at(
        parent: &PinnedDirectory,
        name: &std::ffi::OsStr,
    ) -> io::Result<PinnedDirectory> {
        let path = parent.logical_path.join(name);
        let before = stat_at(&parent.handle, name)?;
        if before.mode & libc::S_IFMT != libc::S_IFDIR {
            return Err(invalid_path(&path, "child is not a directory"));
        }
        let handle = open_child(
            &parent.handle,
            name,
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW,
        )?;
        let opened = stat_file(&handle)?;
        let after = stat_at(&parent.handle, name)?;
        if opened.identity != before.identity || after.identity != before.identity {
            return Err(invalid_path(&path, "child directory changed while opening"));
        }
        Ok(PinnedDirectory {
            handle,
            logical_path: path,
        })
    }

    pub(super) fn open_regular_at(
        parent: &PinnedDirectory,
        name: &std::ffi::OsStr,
    ) -> io::Result<File> {
        let path = parent.logical_path.join(name);
        let before = stat_at(&parent.handle, name)?;
        if !regular(before) {
            return Err(invalid_path(&path, "child is not a regular file"));
        }
        let file = open_child(
            &parent.handle,
            name,
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
        )?;
        let opened = stat_file(&file)?;
        let after = stat_at(&parent.handle, name)?;
        if !regular(opened)
            || opened.identity != before.identity
            || after.identity != before.identity
        {
            return Err(invalid_path(
                &path,
                "child file changed or is not a regular file",
            ));
        }
        Ok(file)
    }

    pub(super) fn open_directory(path: &Path) -> io::Result<PinnedDirectory> {
        let names = components(path)?;
        if names.is_empty() {
            return Ok(PinnedDirectory {
                handle: root_directory()?,
                logical_path: path.to_path_buf(),
            });
        }

        let directory = open_parent_chain(path, &names[..names.len() - 1])?;
        let target = open_child(
            &directory,
            names[names.len() - 1],
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW,
        )?;
        if !target.metadata()?.is_dir() {
            return Err(invalid_path(path, "the target is not a directory"));
        }
        Ok(PinnedDirectory {
            handle: target,
            logical_path: path.to_path_buf(),
        })
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::fs::OpenOptions;
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};

    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const FILE_READ_ATTRIBUTES: u32 = 0x0000_0080;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;

    fn invalid_path(path: &Path, detail: &str) -> io::Error {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{}: {detail}", path.display()),
        )
    }

    fn reject_relative_or_parent(path: &Path) -> io::Result<()> {
        if !path.is_absolute() {
            return Err(invalid_path(path, "an absolute path is required"));
        }
        if path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
        {
            return Err(invalid_path(
                path,
                "parent-directory components are rejected",
            ));
        }
        Ok(())
    }

    fn open_handle(path: &Path, directory: bool) -> io::Result<File> {
        let mut options = OpenOptions::new();
        options.read(true).share_mode(FILE_SHARE_READ).custom_flags(
            FILE_FLAG_OPEN_REPARSE_POINT
                | if directory {
                    FILE_FLAG_BACKUP_SEMANTICS
                } else {
                    0
                },
        );
        let handle = options.open(path)?;
        let metadata = handle.metadata()?;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(invalid_path(path, "reparse points are rejected"));
        }
        let expected = if directory {
            metadata.is_dir()
        } else {
            metadata.is_file()
        };
        if !expected {
            return Err(invalid_path(
                path,
                if directory {
                    "the target is not a directory"
                } else {
                    "the target is not a regular file"
                },
            ));
        }
        Ok(handle)
    }

    fn open_metadata_file(path: &Path) -> io::Result<File> {
        let mut options = OpenOptions::new();
        // Metadata scans may overlap a solver's append handle. Permit readers
        // and writers, but keep the path from being replaced while pinned.
        options
            .access_mode(FILE_READ_ATTRIBUTES)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
        let handle = options.open(path)?;
        let metadata = handle.metadata()?;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(invalid_path(path, "reparse points are rejected"));
        }
        if !metadata.is_file() {
            return Err(invalid_path(path, "the target is not a regular file"));
        }
        Ok(handle)
    }

    fn ancestor_paths(path: &Path) -> io::Result<Vec<PathBuf>> {
        reject_relative_or_parent(path)?;
        let mut result = Vec::new();
        let mut current = path.parent();
        while let Some(parent) = current {
            if parent.as_os_str().is_empty() {
                break;
            }
            result.push(parent.to_path_buf());
            let next = parent.parent();
            if next == Some(parent) {
                break;
            }
            current = next;
        }
        result.reverse();
        Ok(result)
    }

    pub(super) fn open_regular(path: &Path) -> io::Result<File> {
        let ancestors = ancestor_paths(path)?;
        let mut held = Vec::with_capacity(ancestors.len());
        for ancestor in ancestors {
            held.push(open_handle(&ancestor, true)?);
        }
        let file = open_handle(path, false)?;
        drop(held);
        Ok(file)
    }

    pub(super) fn open_directory(path: &Path) -> io::Result<PinnedDirectory> {
        let ancestors = ancestor_paths(path)?;
        let mut held = Vec::with_capacity(ancestors.len());
        for ancestor in ancestors {
            held.push(open_handle(&ancestor, true)?);
        }
        let handle = open_handle(path, true)?;
        Ok(PinnedDirectory {
            handle,
            logical_path: path.to_path_buf(),
            _ancestors: held,
        })
    }

    pub(super) fn open_regular_at(
        parent: &PinnedDirectory,
        name: &std::ffi::OsStr,
    ) -> io::Result<File> {
        open_handle(&parent.logical_path.join(name), false)
    }

    pub(super) fn open_metadata_file_at(
        parent: &PinnedDirectory,
        name: &std::ffi::OsStr,
    ) -> io::Result<File> {
        open_metadata_file(&parent.logical_path.join(name))
    }
}

#[cfg(not(any(unix, windows)))]
mod platform {
    use super::*;

    pub(super) fn open_regular(path: &Path) -> io::Result<File> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            format!(
                "secure regular-file opening is unsupported: {}",
                path.display()
            ),
        ))
    }

    pub(super) fn open_directory(path: &Path) -> io::Result<PinnedDirectory> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            format!(
                "secure directory opening is unsupported: {}",
                path.display()
            ),
        ))
    }

    pub(super) fn open_regular_at(
        _parent: &PinnedDirectory,
        _name: &std::ffi::OsStr,
    ) -> io::Result<File> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "secure child-file opening is unsupported",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[cfg(unix)]
    #[test]
    fn rejects_final_and_ancestor_symlinks() {
        use std::os::unix::fs::symlink;

        let temporary = tempfile::tempdir().expect("temporary directory");
        let real = temporary.path().join("real.txt");
        fs::write(&real, b"ok").expect("write regular file");
        let final_link = temporary.path().join("final-link");
        symlink(&real, &final_link).expect("create final symlink");
        assert!(open_regular(&final_link).is_err());

        let real_directory = temporary.path().join("real-directory");
        fs::create_dir(&real_directory).expect("create real directory");
        fs::write(real_directory.join("value"), b"ok").expect("write nested file");
        let ancestor_link = temporary.path().join("ancestor-link");
        symlink(&real_directory, &ancestor_link).expect("create ancestor symlink");
        assert!(open_regular(&ancestor_link.join("value")).is_err());

        let directory_link = temporary.path().join("directory-link");
        symlink(&real_directory, &directory_link).expect("create directory symlink");
        assert!(open_directory(&directory_link).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_fifo_without_blocking() {
        use std::os::unix::ffi::OsStrExt;
        use std::time::{Duration, Instant};

        let temporary = tempfile::tempdir().expect("temporary directory");
        let fifo = temporary.path().join("pipe");
        let name = std::ffi::CString::new(fifo.as_os_str().as_bytes()).expect("fifo path");
        let result = unsafe { libc::mkfifo(name.as_ptr(), 0o600) };
        assert_eq!(result, 0, "mkfifo: {}", io::Error::last_os_error());
        let started = Instant::now();
        assert!(open_regular(&fifo).is_err());
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn pinned_directory_reads_original_after_rename_and_replacement() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let root = temporary.path().join("root");
        fs::create_dir(&root).expect("create root");
        fs::write(root.join("original"), b"original").expect("write original");
        let pinned = open_directory(&root).expect("pin root");

        let renamed = temporary.path().join("renamed");
        fs::rename(&root, &renamed).expect("rename original root");
        fs::create_dir(&root).expect("replace root");
        fs::write(root.join("replacement"), b"replacement").expect("write replacement");

        let mut names = pinned
            .read_dir()
            .expect("read pinned root")
            .map(|entry| entry.expect("directory entry").file_name())
            .collect::<Vec<_>>();
        names.sort();
        assert_eq!(names, vec![std::ffi::OsString::from("original")]);
        let mut original = pinned
            .open_child_regular(std::ffi::OsStr::new("original"))
            .expect("open pinned original");
        let mut bytes = Vec::new();
        original
            .read_to_end(&mut bytes)
            .expect("read pinned original");
        assert_eq!(bytes, b"original");
        assert!(pinned
            .open_child_regular(std::ffi::OsStr::new("replacement"))
            .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn caller_can_bound_reads_when_file_grows_after_open() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let path = temporary.path().join("growing");
        fs::write(&path, b"1234").expect("write initial bytes");
        let mut file = open_regular(&path).expect("open regular file");
        fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("reopen for append")
            .write_all(b"567890")
            .expect("append bytes");
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(4)
            .read_to_end(&mut bytes)
            .expect("bounded read");
        assert_eq!(bytes.len(), 4);
    }

    #[cfg(windows)]
    #[test]
    fn opens_regular_file_and_directory_with_read_only_handles() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let file_path = temporary.path().join("value.txt");
        fs::write(&file_path, b"ok").expect("write regular file");
        assert!(open_regular(&file_path)
            .expect("open regular file")
            .metadata()
            .unwrap()
            .is_file());

        let directory_path = temporary.path().join("directory");
        fs::create_dir(&directory_path).expect("create directory");
        let pinned = open_directory(&directory_path).expect("open directory");
        assert!(pinned.read_dir().is_ok());
    }
}
