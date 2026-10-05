//! Streamed zip of one result folder (`GET /v2/workspace/items/{id}/archive`).
//!
//! The archive is built from the folder as it is on disk, entry by entry,
//! stored without recompression, with data descriptors so nothing is seeked (zarr chunks and HDF5 are already compressed)
//! and sent as it is produced, so memory stays bounded by one copy buffer and
//! one chunk. Before the first byte is sent the folder is walked once: a
//! symbolic link or junction anywhere inside, a non-UTF-8 name, more than
//! [`MAX_ARCHIVE_BYTES`] of data or more than [`MAX_ARCHIVE_FILES`] files
//! refuses the whole download, so a client never receives a partial archive
//! that looks complete. A write that fails mid-stream aborts the connection
//! instead of closing the body normally.

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::task::{Context, Poll};

use axum::body::{Body, Bytes};
use axum::http::StatusCode;
use futures_core::Stream;
use tokio::sync::mpsc;

use crate::error::ApiError;

/// Largest folder (sum of file sizes) that is archived.
pub(crate) const MAX_ARCHIVE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Most files that are archived.
/// Stays below the 65 535 entries a classic (non-zip64) archive can hold.
pub(crate) const MAX_ARCHIVE_FILES: usize = 60_000;
const CHUNK_BYTES: usize = 64 * 1024;
/// Held by a running writer and meaningless to a reader.
const SKIPPED_NAMES: [&str; 1] = [".fullmag-active.lock"];

#[derive(Debug)]
pub(crate) struct ArchiveEntry {
    pub absolute: PathBuf,
    /// Name inside the zip: relative, `/`-separated.
    pub name: String,
    pub size: u64,
}

#[derive(Debug)]
pub(crate) struct ArchivePlan {
    pub root: PathBuf,
    pub entries: Vec<ArchiveEntry>,
    pub total_bytes: u64,
}

/// A link of any kind: a symbolic link, or on Windows a junction or other
/// reparse point. Never followed, never archived.
fn is_link(meta: &fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const REPARSE_POINT: u32 = 0x400;
        if meta.file_attributes() & REPARSE_POINT != 0 {
            return true;
        }
    }
    false
}

fn too_large(message: String) -> ApiError {
    ApiError {
        status: StatusCode::PAYLOAD_TOO_LARGE,
        code: Some("workspace_archive_too_large".into()),
        message,
        diagnostics: Vec::new(),
    }
}

/// Walk `folder` once and list what would be archived, or say why not.
pub(crate) fn plan_archive(
    folder: &Path,
    max_bytes: u64,
    max_files: usize,
) -> Result<ArchivePlan, ApiError> {
    let top = fs::symlink_metadata(folder).map_err(|error| {
        ApiError::not_found(format!("the result folder cannot be read: {error}"))
    })?;
    if is_link(&top) {
        return Err(ApiError::conflict_with_code(
            "workspace_archive_link",
            "the result folder is a link; links are never followed",
        ));
    }
    if !top.is_dir() {
        return Err(ApiError::bad_request("the result path is not a folder"));
    }
    let root = fs::canonicalize(folder)
        .map_err(|error| ApiError::internal(format!("cannot resolve the result folder: {error}")))?;
    let mut entries = Vec::new();
    let mut total_bytes = 0_u64;
    let mut pending = vec![root.clone()];
    while let Some(directory) = pending.pop() {
        let read = fs::read_dir(&directory).map_err(|error| {
            ApiError::internal(format!("cannot read {}: {error}", directory.display()))
        })?;
        for entry in read {
            let entry = entry
                .map_err(|error| ApiError::internal(format!("cannot list the folder: {error}")))?;
            let path = entry.path();
            let file_name = entry.file_name();
            let Some(file_name) = file_name.to_str() else {
                return Err(ApiError::conflict_with_code(
                    "workspace_archive_name",
                    format!("{} has a name that is not valid UTF-8", path.display()),
                ));
            };
            if SKIPPED_NAMES.contains(&file_name) {
                continue;
            }
            let meta = fs::symlink_metadata(&path).map_err(|error| {
                ApiError::internal(format!("cannot inspect {}: {error}", path.display()))
            })?;
            if is_link(&meta) {
                return Err(ApiError::conflict_with_code(
                    "workspace_archive_link",
                    format!(
                        "{} is a link; a folder that contains links is not archived",
                        path.display()
                    ),
                ));
            }
            if meta.is_dir() {
                pending.push(path);
                continue;
            }
            if !meta.is_file() {
                return Err(ApiError::conflict_with_code(
                    "workspace_archive_special_file",
                    format!("{} is not a regular file", path.display()),
                ));
            }
            // Belt and braces: the entry must still sit under the folder.
            let relative = path
                .strip_prefix(&root)
                .map_err(|_| ApiError::internal("an entry resolved outside the result folder"))?;
            let mut name = String::new();
            for part in relative.components() {
                let part = part.as_os_str().to_str().ok_or_else(|| {
                    ApiError::conflict_with_code(
                        "workspace_archive_name",
                        format!("{} has a name that is not valid UTF-8", path.display()),
                    )
                })?;
                if !name.is_empty() {
                    name.push('/');
                }
                name.push_str(part);
            }
            total_bytes = total_bytes.saturating_add(meta.len());
            if entries.len() + 1 > max_files {
                return Err(too_large(format!(
                    "the folder has more than {max_files} files; archive it with a file manager"
                )));
            }
            if total_bytes > max_bytes {
                return Err(too_large(format!(
                    "the folder holds more than {max_bytes} bytes; archive it with a file manager"
                )));
            }
            entries.push(ArchiveEntry {
                absolute: path,
                name,
                size: meta.len(),
            });
        }
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(ArchivePlan {
        root,
        entries,
        total_bytes,
    })
}

const LOCAL_HEADER: u32 = 0x0403_4b50;
const DATA_DESCRIPTOR: u32 = 0x0807_4b50;
const CENTRAL_HEADER: u32 = 0x0201_4b50;
const END_OF_CENTRAL_DIRECTORY: u32 = 0x0605_4b50;
/// Bit 3: sizes and CRC follow the data; bit 11: names are UTF-8.
const FLAGS: u16 = 0x0808;
/// 1980-01-01 00:00, the DOS epoch: the archive carries no timestamps.
const DOS_TIME: u16 = 0;
const DOS_DATE: u16 = 0x0021;

struct Counting<W: Write> {
    inner: W,
    written: u64,
}

impl<W: Write> Write for Counting<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.inner.write_all(buf)?;
        self.written += buf.len() as u64;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

struct Finished {
    name: String,
    crc: u32,
    size: u32,
    offset: u32,
}

/// Write the zip of `plan` to `writer` (no seeking needed): stored entries
/// with data descriptors, a central directory and an end record. Files that
/// grew beyond the cap, were replaced by a link or vanished fail the archive;
/// the caller must treat an error as an aborted download.
pub(crate) fn write_archive<W: Write>(
    plan: &ArchivePlan,
    writer: W,
    max_bytes: u64,
) -> io::Result<()> {
    let mut out = Counting {
        inner: writer,
        written: 0,
    };
    let mut buffer = vec![0_u8; CHUNK_BYTES];
    let mut written = 0_u64;
    let mut finished: Vec<Finished> = Vec::with_capacity(plan.entries.len());
    for entry in &plan.entries {
        let meta = fs::symlink_metadata(&entry.absolute)?;
        if is_link(&meta) || !meta.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("{} changed while it was archived", entry.absolute.display()),
            ));
        }
        let offset = u32::try_from(out.written)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "archive offset exceeds 4 GiB"))?;
        let name = entry.name.as_bytes();
        out.write_all(&LOCAL_HEADER.to_le_bytes())?;
        out.write_all(&20_u16.to_le_bytes())?; // version needed
        out.write_all(&FLAGS.to_le_bytes())?;
        out.write_all(&0_u16.to_le_bytes())?; // stored
        out.write_all(&DOS_TIME.to_le_bytes())?;
        out.write_all(&DOS_DATE.to_le_bytes())?;
        out.write_all(&0_u32.to_le_bytes())?; // crc: in the descriptor
        out.write_all(&0_u32.to_le_bytes())?; // compressed size
        out.write_all(&0_u32.to_le_bytes())?; // uncompressed size
        out.write_all(&(name.len() as u16).to_le_bytes())?;
        out.write_all(&0_u16.to_le_bytes())?; // extra length
        out.write_all(name)?;
        let mut hasher = crc32fast::Hasher::new();
        let mut size = 0_u64;
        let mut file = File::open(&entry.absolute)?;
        loop {
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            written += read as u64;
            size += read as u64;
            if written > max_bytes {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "the folder grew beyond the archive limit while it was archived",
                ));
            }
            hasher.update(&buffer[..read]);
            out.write_all(&buffer[..read])?;
        }
        let size = u32::try_from(size)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "a file exceeds 4 GiB"))?;
        let crc = hasher.finalize();
        out.write_all(&DATA_DESCRIPTOR.to_le_bytes())?;
        out.write_all(&crc.to_le_bytes())?;
        out.write_all(&size.to_le_bytes())?;
        out.write_all(&size.to_le_bytes())?;
        finished.push(Finished {
            name: entry.name.clone(),
            crc,
            size,
            offset,
        });
    }
    let directory_offset = u32::try_from(out.written)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "archive offset exceeds 4 GiB"))?;
    for file in &finished {
        let name = file.name.as_bytes();
        out.write_all(&CENTRAL_HEADER.to_le_bytes())?;
        out.write_all(&20_u16.to_le_bytes())?; // version made by
        out.write_all(&20_u16.to_le_bytes())?; // version needed
        out.write_all(&FLAGS.to_le_bytes())?;
        out.write_all(&0_u16.to_le_bytes())?;
        out.write_all(&DOS_TIME.to_le_bytes())?;
        out.write_all(&DOS_DATE.to_le_bytes())?;
        out.write_all(&file.crc.to_le_bytes())?;
        out.write_all(&file.size.to_le_bytes())?;
        out.write_all(&file.size.to_le_bytes())?;
        out.write_all(&(name.len() as u16).to_le_bytes())?;
        out.write_all(&0_u16.to_le_bytes())?; // extra
        out.write_all(&0_u16.to_le_bytes())?; // comment
        out.write_all(&0_u16.to_le_bytes())?; // disk number
        out.write_all(&0_u16.to_le_bytes())?; // internal attributes
        out.write_all(&0_u32.to_le_bytes())?; // external attributes
        out.write_all(&file.offset.to_le_bytes())?;
        out.write_all(name)?;
    }
    let directory_size = u32::try_from(out.written)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "archive exceeds 4 GiB"))?
        - directory_offset;
    let count = u16::try_from(finished.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "too many files"))?;
    out.write_all(&END_OF_CENTRAL_DIRECTORY.to_le_bytes())?;
    out.write_all(&0_u16.to_le_bytes())?;
    out.write_all(&0_u16.to_le_bytes())?;
    out.write_all(&count.to_le_bytes())?;
    out.write_all(&count.to_le_bytes())?;
    out.write_all(&directory_size.to_le_bytes())?;
    out.write_all(&directory_offset.to_le_bytes())?;
    out.write_all(&0_u16.to_le_bytes())?; // comment length
    out.flush()
}

/// `Write` that hands finished chunks to the response body.
struct ChannelWriter {
    sender: mpsc::Sender<io::Result<Bytes>>,
    pending: Vec<u8>,
}

impl ChannelWriter {
    fn send_pending(&mut self) -> io::Result<()> {
        if self.pending.is_empty() {
            return Ok(());
        }
        let chunk = Bytes::from(std::mem::take(&mut self.pending));
        self.sender
            .blocking_send(Ok(chunk))
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "the client went away"))
    }
}

impl Write for ChannelWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.pending.extend_from_slice(buf);
        if self.pending.len() >= CHUNK_BYTES {
            self.send_pending()?;
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.send_pending()
    }
}

struct Chunks(mpsc::Receiver<io::Result<Bytes>>);

impl Stream for Chunks {
    type Item = io::Result<Bytes>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.0.poll_recv(cx)
    }
}

/// A response body that streams the zip of `plan` from a blocking task.
pub(crate) fn archive_body(plan: ArchivePlan, max_bytes: u64) -> Body {
    let (sender, receiver) = mpsc::channel(4);
    tokio::task::spawn_blocking(move || {
        let mut writer = ChannelWriter {
            sender: sender.clone(),
            pending: Vec::new(),
        };
        let outcome = write_archive(&plan, &mut writer, max_bytes).and_then(|()| writer.flush());
        if let Err(error) = outcome {
            tracing::warn!("result archive aborted: {error}");
            // An error item makes the body fail, so the client sees a broken
            // download rather than a short archive that ended normally.
            let _ = sender.blocking_send(Err(error));
        }
    });
    Body::from_stream(Chunks(receiver))
}

/// ASCII-only, header-safe file name for `Content-Disposition`.
pub(crate) fn download_name(item_name: &str) -> String {
    let cleaned: String = item_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let cleaned = cleaned.trim_matches('.');
    let stem = if cleaned.is_empty() { "results" } else { cleaned };
    format!("{stem}.zip")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn folder() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("wall.zarr");
        fs::create_dir_all(root.join("stages/stage_00")).unwrap();
        fs::write(root.join("fullmag-run.json"), "{}").unwrap();
        fs::write(root.join("stages/stage_00/scalars.csv"), "step,time\n1,1e-13\n").unwrap();
        fs::write(root.join(".fullmag-active.lock"), "token").unwrap();
        dir
    }

    #[test]
    fn the_zip_holds_exactly_the_folder_tree_with_relative_names() {
        let dir = folder();
        let root = dir.path().join("wall.zarr");
        let plan = plan_archive(&root, MAX_ARCHIVE_BYTES, MAX_ARCHIVE_FILES).unwrap();
        let names: Vec<&str> = plan.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["fullmag-run.json", "stages/stage_00/scalars.csv"]);
        let mut bytes = Vec::new();
        write_archive(&plan, &mut bytes, MAX_ARCHIVE_BYTES).unwrap();
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        assert_eq!(archive.len(), 2);
        let mut csv = String::new();
        archive
            .by_name("stages/stage_00/scalars.csv")
            .unwrap()
            .read_to_string(&mut csv)
            .unwrap();
        assert_eq!(csv, "step,time\n1,1e-13\n");
        for index in 0..archive.len() {
            let name = archive.by_index(index).unwrap().name().to_string();
            assert!(!name.starts_with('/') && !name.contains(".."), "{name}");
        }
    }

    #[test]
    fn the_size_and_file_caps_refuse_before_any_byte_is_written() {
        let dir = folder();
        let root = dir.path().join("wall.zarr");
        let error = plan_archive(&root, 4, MAX_ARCHIVE_FILES).unwrap_err();
        assert_eq!(error.status, StatusCode::PAYLOAD_TOO_LARGE);
        let error = plan_archive(&root, MAX_ARCHIVE_BYTES, 1).unwrap_err();
        assert_eq!(error.status, StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[test]
    fn a_file_that_outgrows_the_cap_while_streaming_aborts_the_archive() {
        let dir = folder();
        let root = dir.path().join("wall.zarr");
        let plan = plan_archive(&root, MAX_ARCHIVE_BYTES, MAX_ARCHIVE_FILES).unwrap();
        let mut sink = Vec::new();
        assert!(write_archive(&plan, &mut sink, 8).is_err());
    }

    #[test]
    fn links_are_refused_and_never_followed() {
        let dir = folder();
        let root = dir.path().join("wall.zarr");
        let outside = dir.path().join("secret.txt");
        fs::write(&outside, "do not leak").unwrap();
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&outside, root.join("link.txt")).is_ok();
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_file(&outside, root.join("link.txt")).is_ok();
        if !linked {
            eprintln!("cannot create a symbolic link here; skipped");
            return;
        }
        let error = plan_archive(&root, MAX_ARCHIVE_BYTES, MAX_ARCHIVE_FILES).unwrap_err();
        assert_eq!(error.status, StatusCode::CONFLICT);
        assert_eq!(error.code.as_deref(), Some("workspace_archive_link"));
        // The folder itself being a link is refused too.
        #[cfg(unix)]
        let top = std::os::unix::fs::symlink(&root, dir.path().join("top")).is_ok();
        #[cfg(windows)]
        let top = std::os::windows::fs::symlink_dir(&root, dir.path().join("top")).is_ok();
        if top {
            assert_eq!(
                plan_archive(&dir.path().join("top"), MAX_ARCHIVE_BYTES, MAX_ARCHIVE_FILES)
                    .unwrap_err()
                    .code
                    .as_deref(),
                Some("workspace_archive_link")
            );
        }
    }

    #[test]
    fn download_names_are_ascii_and_never_empty() {
        assert_eq!(download_name("wall run (1).zarr"), "wall_run__1_.zarr.zip");
        assert_eq!(download_name("..."), "results.zip");
        assert_eq!(download_name("m\u{e9}sure"), "m_sure.zip");
    }
}
