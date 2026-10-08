//! Owned per-run output reservation and temporary-directory lifecycle.
//! Results are never removed by this owner. Only a marked private scratch
//! directory can be cleaned, after the caller has joined its run workers.

use fullmag_ir::{ExistingOutputIR, OutputDataFormatIR, OutputStorageIR, ProblemIR, TempCleanupIR};
use serde::Serialize;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

const OWNER_FILE: &str = ".fullmag-tmp-owner.json";
const ACTIVE_FILE: &str = ".fullmag-active.lock";

#[derive(Debug, Clone, Serialize)]
pub struct ResolvedOutputStorage {
    pub output_dir: PathBuf,
    /// Private run directory, never the operator-selected temporary parent.
    pub temp_dir: PathBuf,
    pub run_id: String,
    pub data_format: OutputDataFormatIR,
    pub cleanup: TempCleanupIR,
}

pub struct ProjectStorageLease {
    resolved: ResolvedOutputStorage,
    temp_parent: PathBuf,
    token: String,
    active_file: Option<File>,
    finished: bool,
}

pub fn supported_data_formats() -> Vec<OutputDataFormatIR> {
    let formats = vec![OutputDataFormatIR::Zarr];
    #[cfg(feature = "stage-autosave-hdf5")]
    let formats = {
        let mut formats = formats;
        formats.push(OutputDataFormatIR::Hdf5);
        formats
    };
    formats
}

impl ProjectStorageLease {
    pub fn prepare(
        settings: &OutputStorageIR,
        default_output_dir: &Path,
        source_dir: &Path,
        run_id: &str,
    ) -> Result<Self, String> {
        settings.validate().map_err(|errors| errors.join("; "))?;
        if run_id.is_empty()
            || run_id.len() > 160
            || !run_id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
            || matches!(run_id, "." | "..")
        {
            return Err("run_id must be a nonempty safe directory identifier".into());
        }
        let (desired, scratch_parent) =
            preflight_project_storage(settings, default_output_dir, source_dir)?;
        let parent = desired.parent().ok_or("output directory has no parent")?;
        ensure_real_directory(parent)?;
        let parent = fs::canonicalize(parent).map_err(message)?;
        let desired_name = desired.file_name().ok_or("output directory has no name")?;
        let desired = parent.join(desired_name);
        // All path/capability checks preceded any directory creation.
        ensure_real_directory(&scratch_parent)?;
        let temp_parent = fs::canonicalize(&scratch_parent).map_err(message)?;
        if desired.starts_with(&temp_parent) || temp_parent.starts_with(&desired) {
            return Err("result directory and temporary parent must be separate locations".into());
        }
        let mut output_dir = desired.clone();
        let mut reserved = false;
        for attempt in 0..100 {
            match fs::create_dir(&output_dir) {
                Ok(()) => {
                    reserved = true;
                    break;
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    if settings.existing_output == ExistingOutputIR::Error {
                        return Err(format!(
                            "result location already exists: {}",
                            output_dir.display()
                        ));
                    }
                    let name = desired_name.to_string_lossy();
                    let (stem, suffix) = name
                        .strip_suffix(".zarr")
                        .map(|stem| (stem, ".zarr"))
                        .unwrap_or((&name, ""));
                    output_dir = parent.join(format!("{stem}-{run_id}-{attempt}{suffix}"));
                }
                Err(error) => return Err(message(error)),
            }
        }
        if !reserved {
            return Err("unable to reserve a fresh result directory after 100 attempts".into());
        }
        ensure_no_reparse_ancestors(&output_dir)?;
        let output_dir = fs::canonicalize(&output_dir).map_err(message)?;
        let token = uuid::Uuid::new_v4().to_string();
        let temp_dir = temp_parent.join(format!("fullmag-{run_id}-{token}"));
        create_private_temp_directory(&temp_dir)?;
        // From here every fallible operation is guarded by Drop. In particular,
        // a failed scratch marker/receipt cannot leave a live result reservation.
        let mut lease = Self {
            resolved: ResolvedOutputStorage {
                output_dir,
                temp_dir,
                run_id: run_id.to_owned(),
                data_format: settings.data_format,
                cleanup: settings.cleanup,
            },
            temp_parent,
            token,
            active_file: None,
            finished: false,
        };
        let active_path = lease.resolved.output_dir.join(ACTIVE_FILE);
        lease.active_file = Some(
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&active_path)
                .map_err(message)?,
        );
        let active_file = lease
            .active_file
            .as_mut()
            .expect("created reservation handle");
        active_file
            .write_all(lease.token.as_bytes())
            .map_err(message)?;
        active_file.sync_all().map_err(message)?;
        let owner = serde_json::json!({
            "schema": "fullmag.private_tmp.v1", "token": lease.token,
            "run_id": run_id, "output_dir": lease.resolved.output_dir, "pid": std::process::id(),
        });
        let mut marker = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(lease.resolved.temp_dir.join(OWNER_FILE))
            .map_err(message)?;
        marker
            .write_all(&serde_json::to_vec(&owner).map_err(message)?)
            .map_err(message)?;
        marker.sync_all().map_err(message)?;
        if settings.data_format == OutputDataFormatIR::Zarr {
            fs::write(
                lease.resolved.output_dir.join(".zgroup"),
                b"{\"zarr_format\":2}",
            )
            .map_err(message)?;
            fs::write(
                lease.resolved.output_dir.join(".zattrs"),
                b"{\"schema_version\":\"fullmag.project_results.v1\"}",
            )
            .map_err(message)?;
        }
        lease.write_receipt("running", false)?;
        Ok(lease)
    }

    pub fn resolved(&self) -> &ResolvedOutputStorage {
        &self.resolved
    }

    /// Call only when all children/worker handles that use scratch have terminated.
    pub fn finish(&mut self, success: bool) -> Result<(), String> {
        if self.finished {
            return Err("storage lease is already finalized".into());
        }
        self.verify_active_identity()?;
        let remove = self.resolved.cleanup == TempCleanupIR::Always
            || (success && self.resolved.cleanup == TempCleanupIR::OnSuccess);
        if remove {
            self.clean_private_temp()?;
        }
        self.write_receipt(if success { "succeeded" } else { "failed" }, remove)?;
        self.finished = true;
        self.release_active_file();
        Ok(())
    }

    fn clean_private_temp(&self) -> Result<(), String> {
        let path = &self.resolved.temp_dir;
        ensure_no_reparse_ancestors(path)?;
        let canonical = fs::canonicalize(path).map_err(message)?;
        if canonical != *path || canonical.parent() != Some(self.temp_parent.as_path()) {
            return Err("private temporary directory identity changed; retained".into());
        }
        let marker_path = canonical.join(OWNER_FILE);
        reject_reparse(&marker_path)?;
        let marker: serde_json::Value =
            serde_json::from_slice(&fs::read(&marker_path).map_err(message)?).map_err(message)?;
        if marker.get("schema").and_then(|v| v.as_str()) != Some("fullmag.private_tmp.v1")
            || marker.get("token").and_then(|v| v.as_str()) != Some(&self.token)
            || marker.get("run_id").and_then(|v| v.as_str()) != Some(&self.resolved.run_id)
        {
            return Err("temporary-directory ownership changed; retained".into());
        }
        reject_reparse_tree(&canonical)?;
        // remove_dir_all does not follow symbolic links; the preflight additionally
        // refuses Windows junctions/reparse points and leaves uncertain data intact.
        fs::remove_dir_all(&canonical).map_err(message)
    }

    /// Publish finalized numerical data staged in this run's private scratch.
    /// Existing result files are never truncated or merged with unknown data.
    pub fn publish_directory(&self, staged: &Path) -> Result<(), String> {
        self.verify_active_identity()?;
        ensure_no_reparse_ancestors(staged)?;
        let staged = fs::canonicalize(staged).map_err(message)?;
        if staged == self.resolved.temp_dir || !staged.starts_with(&self.resolved.temp_dir) {
            return Err(
                "publication source must be inside this run's private temporary directory".into(),
            );
        }
        reject_reparse_tree(&staged)?;
        copy_fresh_tree(&staged, &self.resolved.output_dir)
    }

    fn verify_active_identity(&self) -> Result<(), String> {
        ensure_no_reparse_ancestors(&self.resolved.output_dir)?;
        if fs::canonicalize(&self.resolved.output_dir).map_err(message)? != self.resolved.output_dir
        {
            return Err("result directory identity changed; retained".into());
        }
        let active_path = self.resolved.output_dir.join(ACTIVE_FILE);
        reject_reparse(&active_path)?;
        if fs::read_to_string(active_path).map_err(message)? != self.token {
            return Err("result reservation ownership changed; retained".into());
        }
        Ok(())
    }

    fn write_receipt(&self, state: &str, cleaned: bool) -> Result<(), String> {
        self.verify_active_identity()?;
        let receipt = serde_json::json!({
            "schema": "fullmag.output_storage.resolved.v1", "state": state,
            "resolved": self.resolved, "temp_cleaned": cleaned,
        });
        let receipt_path = self.resolved.output_dir.join("output-storage.json");
        if receipt_path.exists() {
            reject_reparse(&receipt_path)?;
        }
        let mut file = File::create(receipt_path).map_err(message)?;
        file.write_all(&serde_json::to_vec_pretty(&receipt).map_err(message)?)
            .map_err(message)?;
        file.sync_all().map_err(message)
    }

    fn release_active_file(&mut self) {
        self.active_file.take();
        let path = self.resolved.output_dir.join(ACTIVE_FILE);
        if ensure_no_reparse_ancestors(&self.resolved.output_dir).is_ok()
            && reject_reparse(&path).is_ok()
            && fs::read_to_string(&path).ok().as_deref() == Some(&self.token)
        {
            let _ = fs::remove_file(path);
        }
    }
}

impl Drop for ProjectStorageLease {
    fn drop(&mut self) {
        // An interrupted owner preserves scratch for diagnosis/reconciliation.
        // Completion of a process alone does not prove completion of its workers.
        self.release_active_file();
    }
}

fn resolve_path(path: &Path, source_dir: &Path) -> Result<PathBuf, String> {
    if path.as_os_str().is_empty() || path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("storage paths must be nonempty and must not contain '..'".into());
    }
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        source_dir.join(path)
    };
    // Components normalize internal '.' without touching the filesystem.
    Ok(absolute
        .components()
        .filter(|part| !matches!(part, Component::CurDir))
        .collect())
}

fn ensure_real_directory(path: &Path) -> Result<(), String> {
    ensure_no_reparse_ancestors(path)?;
    fs::create_dir_all(path).map_err(message)?;
    ensure_no_reparse_ancestors(path)
}

fn ensure_no_reparse_ancestors(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(_) => reject_reparse(ancestor)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(message(error)),
        }
    }
    Ok(())
}

fn reject_reparse(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(message)?;
    #[cfg(windows)]
    let reparse = {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    };
    #[cfg(not(windows))]
    let reparse = false;
    if metadata.file_type().is_symlink() || reparse {
        return Err(format!(
            "storage path contains a link/reparse point: {}",
            path.display()
        ));
    }
    Ok(())
}

fn reject_reparse_tree(path: &Path) -> Result<(), String> {
    reject_reparse(path)?;
    for entry in fs::read_dir(path).map_err(message)? {
        let entry = entry.map_err(message)?;
        let entry_path = entry.path();
        reject_reparse(&entry_path)?;
        if entry.file_type().map_err(message)?.is_dir() {
            reject_reparse_tree(&entry_path)?;
        }
    }
    Ok(())
}

fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

/// Add the primary field/table writer before planning. Runtime writer
/// availability is checked here; the shared IR owner materializes the policy.
pub fn configure_project_autosave(
    problem: &mut ProblemIR,
    data_format: OutputDataFormatIR,
    until_seconds: f64,
) -> Result<(), String> {
    if !supported_data_formats().contains(&data_format) {
        return Err("HDF5 output is unavailable in this runtime".into());
    }
    fullmag_ir::configure_project_autosave_policy(problem, data_format, until_seconds)
}

fn copy_fresh_tree(source: &Path, destination: &Path) -> Result<(), String> {
    ensure_no_reparse_ancestors(destination)?;
    for entry in fs::read_dir(source).map_err(message)? {
        let entry = entry.map_err(message)?;
        let from = entry.path();
        reject_reparse(&from)?;
        let to = destination.join(entry.file_name());
        if entry.file_type().map_err(message)?.is_dir() {
            fs::create_dir(&to).map_err(message)?;
            copy_fresh_tree(&from, &to)?;
        } else {
            let mut input = File::open(&from).map_err(message)?;
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&to)
                .map_err(message)?;
            std::io::copy(&mut input, &mut output).map_err(message)?;
            output.sync_all().map_err(message)?;
        }
    }
    Ok(())
}

/// A project/run container may gain fresh child groups. Never rewrite existing
/// Zarr metadata or result content while establishing the parent hierarchy.
pub fn initialize_result_container(
    path: &Path,
    data_format: OutputDataFormatIR,
) -> Result<(), String> {
    ensure_real_directory(path)?;
    if data_format != OutputDataFormatIR::Zarr {
        return Ok(());
    }
    let group_path = path.join(".zgroup");
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&group_path)
    {
        Ok(mut file) => {
            file.write_all(b"{\"zarr_format\":2}").map_err(message)?;
            file.sync_all().map_err(message)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            reject_reparse(&group_path)?;
            let group: serde_json::Value =
                serde_json::from_slice(&fs::read(&group_path).map_err(message)?)
                    .map_err(message)?;
            if group.get("zarr_format").and_then(serde_json::Value::as_u64) != Some(2) {
                return Err("existing output container is not a supported Zarr v2 group".into());
            }
        }
        Err(error) => return Err(message(error)),
    }
    let attributes = path.join(".zattrs");
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&attributes)
    {
        Ok(mut file) => {
            file.write_all(b"{}").map_err(message)?;
            file.sync_all().map_err(message)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            reject_reparse(&attributes)?;
        }
        Err(error) => return Err(message(error)),
    }
    Ok(())
}

/// Check policy and path ownership without creating result/tmp directories.
pub fn preflight_project_storage(
    settings: &OutputStorageIR,
    default_output_dir: &Path,
    source_dir: &Path,
) -> Result<(PathBuf, PathBuf), String> {
    settings.validate().map_err(|errors| errors.join("; "))?;
    if !supported_data_formats().contains(&settings.data_format) {
        return Err(
            "HDF5 output is unavailable in this runtime (stage-autosave-hdf5 is not enabled)"
                .into(),
        );
    }
    let source_dir = fs::canonicalize(source_dir).map_err(message)?;
    let output = resolve_path(
        settings
            .output_dir
            .as_deref()
            .map(Path::new)
            .unwrap_or(default_output_dir),
        &source_dir,
    )?;
    let parent = output.parent().ok_or("output directory has no parent")?;
    let scratch = settings
        .temp_dir
        .as_deref()
        .map(|path| resolve_path(Path::new(path), &source_dir))
        .transpose()?
        .unwrap_or_else(|| parent.join(".fullmag-tmp"));
    ensure_no_reparse_ancestors(&output)?;
    ensure_no_reparse_ancestors(&scratch)?;
    // Resolve aliases of existing prefixes (including Windows drive/UNC
    // spelling) before comparing leaves that have not been created yet.
    let output = canonicalize_existing_prefix(&output)?;
    let scratch = canonicalize_existing_prefix(&scratch)?;
    let key = |path: &Path| {
        let value = path
            .to_string_lossy()
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_string();
        let value = value.strip_prefix("//?/").unwrap_or(&value).to_string();
        if cfg!(windows) {
            value.to_lowercase()
        } else {
            value
        }
    };
    let out_key = key(&output);
    let temp_key = key(&scratch);
    if out_key == temp_key
        || out_key.starts_with(&format!("{temp_key}/"))
        || temp_key.starts_with(&format!("{out_key}/"))
    {
        return Err("result directory and temporary parent must be separate locations".into());
    }
    Ok((output, scratch))
}

fn canonicalize_existing_prefix(path: &Path) -> Result<PathBuf, String> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(_) => {
                let prefix = fs::canonicalize(ancestor).map_err(message)?;
                let suffix = path.strip_prefix(ancestor).map_err(message)?;
                return Ok(prefix.join(suffix));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(message(error)),
        }
    }
    Err("storage path has no existing absolute prefix".into())
}

#[cfg(unix)]
fn create_private_temp_directory(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    fs::DirBuilder::new()
        .mode(0o700)
        .create(path)
        .map_err(message)?;
    if fs::metadata(path).map_err(message)?.permissions().mode() & 0o077 != 0 {
        return Err("private scratch directory has unsafe access permissions".into());
    }
    Ok(())
}

#[cfg(windows)]
fn create_private_temp_directory(path: &Path) -> Result<(), String> {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    #[repr(C)]
    struct SecurityAttributes {
        length: u32,
        descriptor: *mut c_void,
        inherit_handle: i32,
    }
    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
            text: *const u16,
            revision: u32,
            descriptor: *mut *mut c_void,
            size: *mut u32,
        ) -> i32;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateDirectoryW(path: *const u16, attributes: *const SecurityAttributes) -> i32;
        fn LocalFree(pointer: *mut c_void) -> *mut c_void;
    }
    // Protected DACL: owner and SYSTEM only, inherited by this run's children.
    // This applies only at creation of our fresh directory, never to its parent.
    let descriptor_text: Vec<u16> = "D:P(A;OICI;FA;;;OW)(A;OICI;FA;;;SY)"
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let path_text: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut descriptor = std::ptr::null_mut();
    unsafe {
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            descriptor_text.as_ptr(),
            1,
            &mut descriptor,
            std::ptr::null_mut(),
        ) == 0
        {
            return Err(message(std::io::Error::last_os_error()));
        }
        let attributes = SecurityAttributes {
            length: std::mem::size_of::<SecurityAttributes>() as u32,
            descriptor,
            inherit_handle: 0,
        };
        let created = CreateDirectoryW(path_text.as_ptr(), &attributes);
        let error = (created == 0).then(std::io::Error::last_os_error);
        LocalFree(descriptor);
        error.map_or(Ok(()), |error| Err(message(error)))
    }
}

#[cfg(not(any(unix, windows)))]
fn create_private_temp_directory(_path: &Path) -> Result<(), String> {
    Err("private temporary directory creation is unsupported on this platform".into())
}

/// Copy one artifact opened without following links in its source hierarchy.
pub fn copy_owned_artifact(
    source_root: &Path,
    relative: &Path,
    destination: &Path,
) -> Result<(), String> {
    if relative
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("artifact path must contain only normal relative components".into());
    }
    ensure_no_reparse_ancestors(source_root)?;
    let root = fs::canonicalize(source_root).map_err(message)?;
    let source = root.join(relative);
    ensure_no_reparse_ancestors(&source)?;
    let mut input = open_verified_artifact(&root, relative)?;
    if !input.metadata().map_err(message)?.is_file() {
        return Err("artifact is not a regular file".into());
    }
    ensure_no_reparse_ancestors(destination)?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(message)?;
    std::io::copy(&mut input, &mut output).map_err(message)?;
    output.sync_all().map_err(message)
}

#[cfg(unix)]
pub(crate) fn open_verified_artifact(root: &Path, relative: &Path) -> Result<File, String> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    let name = CString::new(root.as_os_str().as_bytes()).map_err(message)?;
    let fd = unsafe {
        libc::open(
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(message(std::io::Error::last_os_error()));
    }
    let mut parent = unsafe { File::from_raw_fd(fd) };
    let components: Vec<_> = relative.components().collect();
    for (index, component) in components.iter().enumerate() {
        let name = CString::new(component.as_os_str().as_bytes()).map_err(message)?;
        let directory = index + 1 < components.len();
        let flags = libc::O_RDONLY
            | libc::O_NOFOLLOW
            | libc::O_CLOEXEC
            | libc::O_NONBLOCK
            | if directory { libc::O_DIRECTORY } else { 0 };
        let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(message(std::io::Error::last_os_error()));
        }
        parent = unsafe { File::from_raw_fd(fd) };
    }
    Ok(parent)
}

#[cfg(windows)]
pub(crate) fn open_verified_artifact(root: &Path, relative: &Path) -> Result<File, String> {
    use std::ffi::c_void;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFinalPathNameByHandleW(
            handle: *mut c_void,
            path: *mut u16,
            length: u32,
            flags: u32,
        ) -> u32;
    }
    let expected = root.join(relative);
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(0x00200000)
        .open(&expected)
        .map_err(message)?;
    let mut buffer = vec![0u16; 32768];
    let length = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            0,
        )
    };
    if length == 0 || length as usize >= buffer.len() {
        return Err("cannot verify artifact handle path".into());
    }
    let observed = PathBuf::from(String::from_utf16(&buffer[..length as usize]).map_err(message)?);
    if observed != expected {
        return Err("artifact source identity changed while opening; refused".into());
    }
    ensure_no_reparse_ancestors(&expected)?;
    Ok(file)
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn open_verified_artifact(_root: &Path, _relative: &Path) -> Result<File, String> {
    Err("verified artifact copy is unsupported on this platform".into())
}
