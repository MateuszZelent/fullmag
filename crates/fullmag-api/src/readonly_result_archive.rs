//! Private read-only result routing. Never used by submission or execution admission.
use std::{collections::BTreeSet, fs, io::Read, path::{Path, PathBuf}};
use anyhow::{bail, Context, Result};
use base64::Engine;
use fullmag_application::{ProjectId, RunId, RunSpecification};
use fullmag_session::{FmsRunIntent, SessionStore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use crate::{error::ApiError, types::AppState};

const GUEST_ROOT: &str = "/opt/fullmag/retained-results/antenna/session-store";
const MANIFEST_PATH: &str = "/opt/fullmag/result-archive/manifest.json";
const LOCK_BYTES: &[u8] = b"fullmag.writer.lock.v1\n";
const MAX_MANIFEST: u64 = 64 * 1024;
const MAX_METADATA: u64 = 64 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Pin { sha256: String, byte_count: u64 }
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RunPin {
    project_id: String, run_id: String, payload_fingerprint: String,
    run_intent: Pin, run_catalog: Pin, artifact_catalog: Pin,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    schema: String, compose_project: String, host_source_root: String,
    guest_source_root: String, writer_lock: Pin, runs: Vec<RunPin>,
}
#[derive(Clone, Debug)]
pub(crate) struct ReadonlyResultArchive { path: PathBuf, sha256: String, manifest: Manifest }

fn sha(raw: &[u8]) -> String { format!("{:x}", Sha256::digest(raw)) }
fn valid_sha(value: &str) -> bool { value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) }
fn api(error: anyhow::Error) -> ApiError { ApiError::internal(format!("read-only result archive: {error:#}")) }
fn no_links(path: &Path) -> Result<()> {
    if !path.is_absolute() { bail!("archive path is not absolute"); }
    let mut current = PathBuf::new();
    for component in path.components() {
        if matches!(component, std::path::Component::ParentDir | std::path::Component::CurDir) { bail!("archive path is not canonical"); }
        current.push(component);
        if fs::symlink_metadata(&current)?.file_type().is_symlink() { bail!("archive path contains a symlink"); }
    }
    if fs::canonicalize(path)? != path { bail!("archive path differs from its canonical identity"); }
    Ok(())
}
fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>> {
    no_links(path)?;
    let mut options = fs::OpenOptions::new(); options.read(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK); }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() || file.metadata()?.len() > limit { bail!("archive file is not regular or exceeds its bound"); }
    let mut raw = Vec::new(); file.take(limit + 1).read_to_end(&mut raw)?;
    if raw.len() as u64 > limit { bail!("archive file exceeds its bound"); }
    Ok(raw)
}
fn check_pin(path: &Path, pin: &Pin) -> Result<()> {
    if !valid_sha(&pin.sha256) || pin.byte_count > MAX_METADATA { bail!("invalid archive metadata pin"); }
    let raw = read_bounded(path, pin.byte_count)?;
    if raw.len() as u64 != pin.byte_count || sha(&raw) != pin.sha256 { bail!("archive metadata pin changed: {}", path.display()); }
    Ok(())
}
fn mount_path(value: &str) -> Result<PathBuf> {
    let mut bytes = Vec::new(); let value = value.as_bytes(); let mut i = 0;
    while i < value.len() {
        if value[i] == b'\\' {
            let code = value.get(i+1..i+4).context("truncated mount escape")?;
            let decoded = match code { b"040" => b' ', b"011" => b'\t', b"012" => b'\n', b"134" => b'\\', _ => bail!("unknown mount escape") };
            bytes.push(decoded); i += 4;
        } else { bytes.push(value[i]); i += 1; }
    }
    Ok(PathBuf::from(String::from_utf8(bytes)?))
}
fn readonly_mount(mountinfo: &str, path: &Path, exact: bool) -> Result<()> {
    let mut covering = Vec::new();
    for line in mountinfo.lines() {
        let columns: Vec<_> = line.split_whitespace().collect();
        let separator = columns.iter().position(|v| *v == "-").context("invalid mountinfo")?;
        if separator < 6 || columns.len() < separator + 4 { bail!("invalid mountinfo fields"); }
        let target = mount_path(columns[4])?;
        if target != path && target.starts_with(path) { bail!("unexpected nested archive mount"); }
        if path.starts_with(&target) { covering.push((target, columns[5].split(',').any(|v| v == "ro"))); }
    }
    covering.sort_by_key(|(p,_)| p.components().count());
    let (target, ro) = covering.last().context("archive mount is missing")?;
    if !ro || (exact && target != path) || (!exact && target != path && target != Path::new("/opt/fullmag/result-archive")) {
        bail!("archive requires its own read-only mount");
    }
    if covering.iter().filter(|(p,_)| p == target).count() != 1 { bail!("ambiguous stacked archive mount"); }
    Ok(())
}
fn parse_manifest(raw: &[u8], hash: &str, project: &str) -> Result<Manifest> {
    if raw.len() as u64 > MAX_MANIFEST || sha(raw) != hash { bail!("archive manifest hash or size differs"); }
    let manifest: Manifest = serde_json::from_slice(raw)?;
    if manifest.schema != "fullmag.readonly_result_archive.v1" || manifest.compose_project != project
        || manifest.guest_source_root != GUEST_ROOT || manifest.runs.is_empty() || manifest.runs.len() > 5
        || !Path::new(&manifest.host_source_root).is_absolute()
        || Path::new(&manifest.host_source_root).components().any(|c| matches!(c, std::path::Component::ParentDir | std::path::Component::CurDir))
        || manifest.writer_lock.byte_count != LOCK_BYTES.len() as u64 || manifest.writer_lock.sha256 != sha(LOCK_BYTES) {
        bail!("unsupported or inconsistent archive manifest");
    }
    let mut ids = BTreeSet::new();
    for pin in &manifest.runs {
        ProjectId::parse(pin.project_id.clone()).map_err(|e| anyhow::anyhow!(e.to_string()))?;
        RunId::parse(pin.run_id.clone()).map_err(|e| anyhow::anyhow!(e.to_string()))?;
        if !ids.insert(&pin.run_id) || !valid_sha(&pin.payload_fingerprint) { bail!("duplicate or invalid archive run"); }
    }
    Ok(manifest)
}

impl ReadonlyResultArchive {
    pub(crate) fn from_environment() -> Result<Option<Self>> {
        let values = ["FULLMAG_READONLY_RESULT_ARCHIVE_PATH", "FULLMAG_READONLY_RESULT_ARCHIVE_SHA256", "FULLMAG_READONLY_RESULT_ARCHIVE_PROJECT"]
            .map(std::env::var_os);
        if values.iter().all(Option::is_none) { return Ok(None); }
        let [path, hash, project] = values.map(|v| v.and_then(|s| s.into_string().ok()));
        let (Some(path), Some(hash), Some(project)) = (path,hash,project) else { bail!("archive environment must contain all three UTF-8 pins"); };
        if path != MANIFEST_PATH || !valid_sha(&hash) || project.is_empty() { bail!("invalid archive environment pins"); }
        let raw = read_bounded(Path::new(&path), MAX_MANIFEST)?;
        if sha(&raw) != hash { bail!("archive manifest hash differs"); }
        let manifest = parse_manifest(&raw, &hash, &project)?;
        let value = Self { path: path.into(), sha256: hash, manifest };
        value.with_store(|_| Ok(()))?;
        Ok(Some(value))
    }
    fn with_store<T>(&self, build: impl FnOnce(&SessionStore) -> Result<T>) -> Result<T> {
        #[cfg(not(target_os = "linux"))] { let _ = build; bail!("result archive requires Linux read-only mount evidence"); }
        #[cfg(target_os = "linux")]
        {
            let root = Path::new(&self.manifest.guest_source_root);
            no_links(root)?;
            let mounts = String::from_utf8(read_bounded(&PathBuf::from(format!("/proc/{}/mountinfo", std::process::id())), 4 * 1024 * 1024)?)?;
            readonly_mount(&mounts, &self.path, false)?; readonly_mount(&mounts, root, true)?;
            if sha(&read_bounded(&self.path, MAX_MANIFEST)?) != self.sha256 { bail!("archive manifest changed after startup"); }
            let store = SessionStore::open_existing(root)?;
            let _read = store.read_transaction()?;
            check_pin(&root.join("WRITER.lock"), &self.manifest.writer_lock)?;
            for pin in &self.manifest.runs {
                let run = root.join("runs").join(&pin.run_id);
                for (name, metadata) in [("run_intent.json", &pin.run_intent), ("run_catalog.json", &pin.run_catalog), ("artifact_catalog.json", &pin.artifact_catalog)] {
                    check_pin(&run.join(name), metadata)?;
                }
                let intent = store.read_run_intent(&pin.run_id)?.context("pinned archived intent missing")?;
                let spec = validate_intent(&intent).map_err(|e| anyhow::anyhow!(format!("{e:?}")))?;
                if spec.snapshot.project_id.as_str() != pin.project_id || intent.payload_sha256 != pin.payload_fingerprint { bail!("archived run identity differs"); }
            }
            build(&store)
        }
    }
}

pub(crate) fn validate_intent(intent: &FmsRunIntent) -> std::result::Result<RunSpecification, ApiError> {
    let spec: RunSpecification = serde_json::from_value(intent.specification.clone()).map_err(|e| ApiError::internal(format!("invalid durable RunSpec: {e}")))?;
    if spec.run_id.as_str() != intent.run_id || spec.fingerprint().map_err(|e| ApiError::internal(e.to_string()))? != intent.payload_sha256 {
        return Err(ApiError::internal("durable run identity or fingerprint is inconsistent"));
    }
    Ok(spec)
}

/// Both guards stay alive through the complete caller closure, including CAS reads.
pub(crate) fn with_sources<T>(state: &AppState,
    build: impl FnOnce(Option<&SessionStore>, Option<&SessionStore>) -> std::result::Result<T, ApiError>) -> std::result::Result<T, ApiError> {
    let root = state.submit_store_root.as_ref().ok_or_else(|| ApiError::internal("managed project run storage is not configured"))?;
    let current = match fs::symlink_metadata(root) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(ApiError::internal(e.to_string())),
        Ok(_) => Some(SessionStore::open_existing(root).map_err(api)?),
    };
    let _current_read = current.as_ref().map(SessionStore::read_transaction).transpose().map_err(api)?;
    if let Some(archive) = state.readonly_result_archive.as_ref() {
        // Preserve the handler's status code while the archive guard owns the closure.
        archive.with_store(|saved| Ok(build(current.as_ref(), Some(saved)))).map_err(api)?
    } else { build(current.as_ref(), None) }
}

fn current_run_path_exists(store: Option<&SessionStore>, run: &str) -> std::result::Result<bool, ApiError> {
    let Some(store) = store else { return Ok(false); };
    let path = store.root().join("runs").join(run);
    match fs::symlink_metadata(&path) {
        Ok(_) => { no_links(&path).map_err(api)?; Ok(true) }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(ApiError::internal(e.to_string())),
    }
}

pub(crate) fn with_run<T>(state: &AppState, project: &ProjectId, run: &RunId,
    build: impl FnOnce(&SessionStore, FmsRunIntent) -> std::result::Result<T, ApiError>) -> std::result::Result<T, ApiError> {
    with_sources(state, |current, saved| {
        let live = current.map(|s| s.read_run_intent(run.as_str())).transpose().map_err(api)?.flatten();
        let pin = state.readonly_result_archive.as_ref().and_then(|a| a.manifest.runs.iter().find(|p| p.run_id == run.as_str()));
        if pin.is_some() && current_run_path_exists(current, run.as_str())? { return Err(ApiError::conflict("run identity collides across current and archived storage")); }
        let (store, intent) = if let Some(intent) = live { (current.unwrap(), intent) }
            else if let Some(pin) = pin {
                if pin.project_id != project.as_str() { return Err(ApiError::conflict("run belongs to another project")); }
                let store = saved.ok_or_else(|| ApiError::internal("archive reader missing"))?;
                (store, store.read_run_intent(run.as_str()).map_err(api)?.ok_or_else(|| ApiError::internal("pinned archive intent missing"))?)
            } else { return Err(ApiError::not_found("accepted run intent is missing")); };
        if validate_intent(&intent)?.snapshot.project_id != *project { return Err(ApiError::conflict("run belongs to another project")); }
        build(store, intent)
    })
}

pub(crate) fn list_intents(state: &AppState, current: Option<&SessionStore>, saved: Option<&SessionStore>)
    -> std::result::Result<Vec<(FmsRunIntent, bool)>, ApiError> {
    let mut intents: Vec<_> = current.map(SessionStore::list_run_intents).transpose().map_err(api)?.unwrap_or_default().into_iter().map(|i|(i,false)).collect();
    if let Some(archive) = state.readonly_result_archive.as_ref() {
        let store = saved.ok_or_else(|| ApiError::internal("archive reader missing"))?;
        for pin in &archive.manifest.runs {
            if current_run_path_exists(current, &pin.run_id)? { return Err(ApiError::conflict("run identity collides across current and archived storage")); }
            intents.push((store.read_run_intent(&pin.run_id).map_err(api)?.ok_or_else(|| ApiError::internal("pinned archive intent missing"))?, true));
        }
    }
    intents.sort_by(|(a,_),(b,_)| b.accepted_at.cmp(&a.accepted_at).then_with(||b.run_id.cmp(&a.run_id)));
    Ok(intents)
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor { version: u8, manifest_sha256: String, current_root: String, project_id: String, run_id: String }
impl Cursor {
    fn validate(&self, manifest: &str, current: Option<&Path>, project: &str) -> std::result::Result<(), ApiError> {
        if self.version != 1 || self.manifest_sha256 != manifest || self.project_id != project
            || Some(Path::new(&self.current_root)) != current {
            return Err(ApiError::bad_request("archive run cursor belongs to another source or project"));
        }
        Ok(())
    }
}
pub(crate) fn decode_cursor(state: &AppState, project: &ProjectId, value: Option<&str>) -> std::result::Result<Option<RunId>, ApiError> {
    let Some(value) = value else { return Ok(None); };
    let run = if let Some(archive) = &state.readonly_result_archive {
        if value.len() > 4096 { return Err(ApiError::bad_request("archive run cursor is oversized")); }
        let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(value).map_err(|_|ApiError::bad_request("invalid archive run cursor"))?;
        let c: Cursor = serde_json::from_slice(&raw).map_err(|_|ApiError::bad_request("invalid archive run cursor"))?;
        c.validate(&archive.sha256, state.submit_store_root.as_deref(), project.as_str())?;
        c.run_id
    } else { value.to_owned() };
    RunId::parse(run).map(Some).map_err(|e|ApiError::bad_request(format!("invalid run cursor: {e}")))
}
pub(crate) fn encode_cursor(state: &AppState, project: &ProjectId, run: &str) -> std::result::Result<String, ApiError> {
    if let Some(archive) = &state.readonly_result_archive {
        let c = Cursor { version: 1, manifest_sha256: archive.sha256.clone(), current_root: state.submit_store_root.as_ref().context("current root missing").map_err(api)?.to_string_lossy().into(), project_id: project.as_str().into(), run_id: run.into() };
        Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(&c).map_err(|e|ApiError::internal(e.to_string()))?))
    } else { Ok(run.into()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn manifest() -> serde_json::Value {
        let pin = json!({"sha256": "1".repeat(64), "byte_count": 10});
        json!({"schema":"fullmag.readonly_result_archive.v1", "compose_project":"test-group",
            "host_source_root":"/host/retained", "guest_source_root":GUEST_ROOT,
            "writer_lock":{"sha256":sha(LOCK_BYTES),"byte_count":LOCK_BYTES.len()},
            "runs":[{"project_id":ProjectId::new().as_str(),"run_id":RunId::new().as_str(),
                "payload_fingerprint":"2".repeat(64),"run_intent":pin,"run_catalog":pin,"artifact_catalog":pin}]})
    }
    #[test]
    fn manifest_is_raw_pinned_closed_and_bounded() {
        let value = manifest(); let raw = serde_json::to_vec_pretty(&value).unwrap();
        assert!(parse_manifest(&raw, &sha(&raw), "test-group").is_ok());
        assert!(parse_manifest(&raw, &"0".repeat(64), "test-group").is_err());
        assert!(parse_manifest(&raw, &sha(&raw), "other-group").is_err());
        for key in ["schema", "guest_source_root", "host_source_root"] {
            let mut bad = value.clone(); bad[key] = json!("unexpected"); let bytes = serde_json::to_vec(&bad).unwrap();
            assert!(parse_manifest(&bytes, &sha(&bytes), "test-group").is_err(), "{key}");
        }
        let mut bad = value.clone(); bad["extra"] = json!(true); let bytes=serde_json::to_vec(&bad).unwrap();
        assert!(parse_manifest(&bytes, &sha(&bytes), "test-group").is_err());
        let mut bad = value.clone(); bad["runs"] = json!([value["runs"][0],value["runs"][0]]); let bytes=serde_json::to_vec(&bad).unwrap();
        assert!(parse_manifest(&bytes, &sha(&bytes), "test-group").is_err());
        let mut bad = value; bad["writer_lock"]["byte_count"] = json!(0); let bytes=serde_json::to_vec(&bad).unwrap();
        assert!(parse_manifest(&bytes, &sha(&bytes), "test-group").is_err());
    }
    #[test]
    fn five_pinned_runs_include_historical_parent_but_reject_six_or_duplicates() {
        let mut value = manifest();
        let mut rows = Vec::new();
        for _ in 0..4 {
            let mut row = value["runs"][0].clone();
            row["run_id"] = json!(RunId::new().as_str());
            rows.push(row);
        }
        let mut parent = value["runs"][0].clone();
        parent["run_id"] = json!("run-live-3926fcbd084cf93d924a7f29af0726974a719301104d867ee46b01a200bf3cf6");
        rows.push(parent);
        value["runs"] = json!(rows);
        let raw = serde_json::to_vec(&value).unwrap();
        assert!(parse_manifest(&raw, &sha(&raw), "test-group").is_ok());
        let mut changed = value.clone();
        changed["runs"][4]["payload_fingerprint"] = json!("3".repeat(64));
        assert!(parse_manifest(&serde_json::to_vec(&changed).unwrap(), &sha(&raw), "test-group").is_err());
        let mut duplicate = value.clone();
        duplicate["runs"][4] = duplicate["runs"][0].clone();
        let bytes = serde_json::to_vec(&duplicate).unwrap();
        assert!(parse_manifest(&bytes, &sha(&bytes), "test-group").is_err());
        let mut sixth = value["runs"][0].clone();
        sixth["run_id"] = json!(RunId::new().as_str());
        value["runs"].as_array_mut().unwrap().push(sixth);
        let bytes = serde_json::to_vec(&value).unwrap();
        assert!(parse_manifest(&bytes, &sha(&bytes), "test-group").is_err());
    }
    #[test]
    fn mount_requires_ro_and_rejects_every_nested_or_stacked_mount() {
        let line = format!("2 1 8:1 / {GUEST_ROOT} ro,relatime - ext4 /dev/sda rw\n");
        assert!(readonly_mount(&line, Path::new(GUEST_ROOT), true).is_ok());
        assert!(readonly_mount(&line.replace("ro,relatime","rw,relatime"), Path::new(GUEST_ROOT), true).is_err());
        for option in ["ro","rw"] {
            let nested=format!("{line}3 2 8:1 / {GUEST_ROOT}/objects {option} - ext4 /dev/sda rw\n");
            assert!(readonly_mount(&nested,Path::new(GUEST_ROOT),true).is_err());
        }
        assert!(readonly_mount(&(line.clone()+&line),Path::new(GUEST_ROOT),true).is_err());
        assert!(readonly_mount("1 0 8:1 / / ro - ext4 /dev/sda ro\n",Path::new(MANIFEST_PATH),false).is_err());
    }
    #[test]
    fn cursor_change_of_manifest_invalidates_even_same_run_and_project() {
        let c=Cursor {version:1,manifest_sha256:"a".repeat(64),current_root:"/current".into(),project_id:"same-project".into(),run_id:"same-run".into()};
        assert!(c.validate(&"a".repeat(64),Some(Path::new("/current")),"same-project").is_ok());
        assert!(c.validate(&"b".repeat(64),Some(Path::new("/current")),"same-project").is_err());
        assert!(c.validate(&"a".repeat(64),Some(Path::new("/other")),"same-project").is_err());
        assert!(c.validate(&"a".repeat(64),Some(Path::new("/current")),"other-project").is_err());
        assert!(serde_json::from_str::<Cursor>("\"run-old-cursor\"").is_err());
    }
    #[test]
    fn bounded_read_rejects_changed_pin_and_symlink_without_writing() {
        let root=tempfile::tempdir().unwrap(); let path=root.path().join("metadata.json"); fs::write(&path,b"old").unwrap();
        let pin=Pin{sha256:sha(b"old"),byte_count:3}; assert!(check_pin(&path,&pin).is_ok());
        fs::write(&path,b"new").unwrap(); assert!(check_pin(&path,&pin).is_err()); assert_eq!(fs::read(&path).unwrap(),b"new");
        #[cfg(unix)] { let alias=root.path().join("alias");std::os::unix::fs::symlink(&path,&alias).unwrap();assert!(read_bounded(&alias,3).is_err()); }
    }
    #[test]
    fn current_directory_without_intent_still_blocks_archive_collision() {
        let root=tempfile::tempdir().unwrap();fs::create_dir(root.path().join("objects")).unwrap();
        fs::create_dir_all(root.path().join("runs/run-collision")).unwrap();
        let store=SessionStore::open_existing(root.path()).unwrap();
        assert!(store.read_run_intent("run-collision").unwrap().is_none());
        assert!(current_run_path_exists(Some(&store),"run-collision").unwrap());
        assert!(!current_run_path_exists(Some(&store),"run-absent").unwrap());
    }
    #[test]
    fn read_guard_never_creates_or_repairs_writer_descriptor() {
        let root=tempfile::tempdir().unwrap();fs::create_dir(root.path().join("objects")).unwrap();
        let store=SessionStore::open_existing(root.path()).unwrap();
        assert!(store.read_transaction().is_err());assert!(!root.path().join("WRITER.lock").exists());
        fs::write(root.path().join("WRITER.lock"),b"corrupt").unwrap();
        assert!(store.read_transaction().is_err());assert_eq!(fs::read(root.path().join("WRITER.lock")).unwrap(),b"corrupt");
    }
}
