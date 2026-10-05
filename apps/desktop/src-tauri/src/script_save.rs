//! "Create script from template" and "Save translated script" (docs/design/
//! start-screen/docs/08-script-open.md, template and .mx3 flows).
//!
//! The renderer supplies the script text and where it came from; the host owns
//! the path. The native Save dialog is the only source of the target, the file
//! is never replaced unless that dialog was the one that confirmed the
//! replacement, and creating a file never executes it: running stays behind the
//! separate native consent of `script_run`. All behaviour lives in plain
//! functions so it is testable without an `AppHandle`.

use crate::workspace_commands::{self, WorkspaceHost, WorkspaceItem};
use fullmag_workspace::{
    now_rfc3339, Actor, EventKind, ItemKind, RecordEvent, Workspace, MAX_SCRIPT_BYTES,
};
use serde::Deserialize;
use serde_json::json;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

const MAX_NAME_CHARS: usize = 96;
const MAX_ORIGIN_ID_CHARS: usize = 160;
const DEFAULT_FILE_NAME: &str = "script.py";

#[derive(Debug, Clone, Deserialize)]
pub struct ScriptSaveRequest {
    /// File name proposed in the dialog; reduced to a safe leaf name here.
    pub suggested_name: String,
    pub text: String,
    /// `template` or `mx3`.
    pub origin: String,
    /// The template id, or the name of the translated `.mx3` file.
    pub origin_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScriptOrigin {
    Template,
    Mx3,
}

impl ScriptOrigin {
    fn parse(text: &str) -> Result<Self, String> {
        match text {
            "template" => Ok(Self::Template),
            "mx3" => Ok(Self::Mx3),
            other => Err(format!("unknown script origin: {other:?}")),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Template => "template",
            Self::Mx3 => "mx3",
        }
    }

    fn event(self) -> EventKind {
        match self {
            Self::Template => EventKind::Create,
            Self::Mx3 => EventKind::Import,
        }
    }
}

/// A request that passed validation: the dialog may now be shown.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedSave {
    pub origin: ScriptOrigin,
    pub origin_id: String,
    pub file_name: String,
    pub text: String,
}

fn is_reserved_windows_stem(stem: &str) -> bool {
    let upper = stem.to_ascii_uppercase();
    matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((upper.starts_with("COM") || upper.starts_with("LPT"))
            && upper.len() == 4
            && upper.as_bytes()[3].is_ascii_digit()
            && upper.as_bytes()[3] != b'0')
}

/// A leaf file name ending in `.py`: no directories, no characters Windows or
/// POSIX reject, no reserved device names, bounded length.
pub fn sanitize_file_name(suggested: &str) -> String {
    let leaf = suggested.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = leaf
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').trim();
    let stem = match cleaned.rsplit_once('.') {
        Some((stem, ext)) if ext.eq_ignore_ascii_case("py") => stem,
        _ => cleaned,
    };
    let stem: String = stem.trim().trim_end_matches('.').chars().take(MAX_NAME_CHARS).collect();
    if stem.is_empty() {
        return DEFAULT_FILE_NAME.to_string();
    }
    let stem = if is_reserved_windows_stem(&stem) {
        format!("_{stem}")
    } else {
        stem
    };
    format!("{stem}.py")
}

/// The first line the host writes, so a script says where it came from. The id
/// is reduced to one printable line first: it must never end the comment.
pub fn provenance_line(origin: ScriptOrigin, origin_id: &str, created: &str) -> String {
    let id: String = origin_id
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    match origin {
        ScriptOrigin::Template => format!(
            "# Created by Fullmag from the template \"{id}\" on {created}. Edit it freely; nothing runs until you run it."
        ),
        ScriptOrigin::Mx3 => format!(
            "# Created by Fullmag as a translation of the mumax3 file \"{id}\" on {created}. Statements that could not be translated are listed in the header below."
        ),
    }
}

/// `provenance line + text`, as UTF-8 text without a byte order mark.
pub fn compose_script(origin: ScriptOrigin, origin_id: &str, created: &str, text: &str) -> String {
    let body = text.strip_prefix('\u{feff}').unwrap_or(text);
    format!("{}\n{body}", provenance_line(origin, origin_id, created))
}

/// Checks everything the host can check before the dialog is shown.
pub fn prepare_save(request: &ScriptSaveRequest, created: &str) -> Result<PreparedSave, String> {
    let origin = ScriptOrigin::parse(request.origin.trim())?;
    let origin_id = request.origin_id.trim();
    if origin_id.is_empty() {
        return Err("the script origin id is empty".to_string());
    }
    if origin_id.chars().count() > MAX_ORIGIN_ID_CHARS {
        return Err("the script origin id is too long".to_string());
    }
    if request.text.trim().is_empty() {
        return Err("the script is empty".to_string());
    }
    if request.text.contains('\0') {
        return Err("the script contains a NUL character".to_string());
    }
    let text = compose_script(origin, origin_id, created, &request.text);
    if text.len() as u64 > MAX_SCRIPT_BYTES {
        return Err("the script is larger than 1 MiB".to_string());
    }
    Ok(PreparedSave {
        origin,
        origin_id: origin_id.to_string(),
        file_name: sanitize_file_name(&request.suggested_name),
        text,
    })
}

/// The path to write for the one the dialog returned, and whether the dialog
/// itself confirmed replacing it. A file name without the `.py` extension gets
/// it appended; that path was never shown to the person, so an existing file
/// there is not covered by the dialog's replacement prompt.
pub fn resolve_target(chosen: &Path) -> Result<(PathBuf, bool), String> {
    let name = chosen
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "the chosen path has no file name".to_string())?;
    let has_py = chosen
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("py"));
    if has_py {
        return Ok((chosen.to_path_buf(), true));
    }
    Ok((chosen.with_file_name(format!("{name}.py")), false))
}

fn temp_path_for(target: &Path) -> PathBuf {
    let name = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("script");
    target.with_file_name(format!(".{name}.{}.tmp", uuid::Uuid::new_v4().simple()))
}

/// Writes `text` next to `target` and moves it into place, so a reader never
/// sees half a script. An existing file is replaced only with
/// `replace_confirmed`; without it the move fails when the name is taken.
pub fn write_script_atomic(
    target: &Path,
    text: &str,
    replace_confirmed: bool,
) -> Result<(), String> {
    let shown = workspace_commands::display_path(&target.display().to_string());
    match std::fs::symlink_metadata(target) {
        Ok(meta) if !meta.is_file() => {
            return Err(format!("{shown} exists and is not a regular file"));
        }
        Ok(_) if !replace_confirmed => {
            return Err(format!(
                "{shown} already exists and the Save dialog did not confirm replacing it; nothing was written"
            ));
        }
        _ => {}
    }
    let parent_ok = target
        .parent()
        .is_some_and(|parent| parent.as_os_str().is_empty() || parent.is_dir());
    if !parent_ok {
        return Err(format!("the folder of {shown} does not exist"));
    }
    let temp = temp_path_for(target);
    let written = (|| -> std::io::Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()
    })();
    if let Err(error) = written {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("cannot write {shown}: {error}"));
    }
    let moved = if replace_confirmed {
        std::fs::rename(&temp, target)
    } else {
        // A hard link fails when the name exists, which makes the check atomic.
        match std::fs::hard_link(&temp, target) {
            Ok(()) => std::fs::remove_file(&temp),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Err(error),
            // No hard links on this file system: fall back to the checked rename.
            Err(_) if !target.exists() => std::fs::rename(&temp, target),
            Err(error) => Err(error),
        }
    };
    if let Err(error) = moved {
        let _ = std::fs::remove_file(&temp);
        return Err(if error.kind() == std::io::ErrorKind::AlreadyExists {
            format!("{shown} already exists; nothing was written")
        } else {
            format!("cannot write {shown}: {error}")
        });
    }
    Ok(())
}

/// Records `create` (template) or `import` (.mx3) and then `open` for the new
/// file, and returns the item as the list shows it.
pub fn record_created_script(
    workspace: &Workspace,
    path: &Path,
    origin: ScriptOrigin,
    origin_id: &str,
) -> Result<WorkspaceItem, String> {
    let meta = json!({ "origin": origin.as_str(), "origin_id": origin_id });
    workspace
        .record(
            &RecordEvent::new(ItemKind::Script, path, origin.event(), Actor::Desktop)
                .with_detail(meta.clone())
                .with_meta_patch(meta),
        )
        .map_err(|error| format!("the workspace database refused the new script: {error}"))?;
    workspace_commands::record_script_open(workspace, path)
}

/// Writes the prepared script to the dialog's choice and records it. A script
/// that was written but could not be recorded is reported as such: the file is
/// there, the list is not.
pub fn save_and_record(
    workspace: &Workspace,
    chosen: &Path,
    prepared: &PreparedSave,
) -> Result<WorkspaceItem, String> {
    let (target, replace_confirmed) = resolve_target(chosen)?;
    write_script_atomic(&target, &prepared.text, replace_confirmed)?;
    record_created_script(workspace, &target, prepared.origin, &prepared.origin_id).map_err(
        |error| {
            format!(
                "the script was saved to {} but is not in the recent list: {error}",
                workspace_commands::display_path(&target.display().to_string())
            )
        },
    )
}

/// The folder the Save dialog opens in: the user's documents, else home.
fn default_folder(app: &AppHandle) -> Option<PathBuf> {
    let resolver = app.path();
    resolver
        .document_dir()
        .ok()
        .filter(|dir| dir.is_dir())
        .or_else(|| resolver.home_dir().ok().filter(|dir| dir.is_dir()))
}

/// Shows the native Save dialog and writes the script the person names.
/// Resolves to `None` when the dialog is cancelled. The renderer never names
/// a path, and the script is not executed.
#[tauri::command]
pub async fn script_save_new(
    app: AppHandle,
    workspace: State<'_, WorkspaceHost>,
    request: ScriptSaveRequest,
) -> Result<Option<WorkspaceItem>, String> {
    let prepared = prepare_save(&request, &now_rfc3339()[..10])?;
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Save Fullmag script")
        .add_filter("Python script", &["py"])
        .set_file_name(prepared.file_name.clone());
    if let Some(folder) = default_folder(&app) {
        dialog = dialog.set_directory(folder);
    }
    let Some(picked) = dialog.blocking_save_file() else {
        return Ok(None);
    };
    let chosen = picked
        .into_path()
        .map_err(|_| "the chosen path is not available on this platform".to_string())?;
    workspace_commands::run(
        workspace.inner().clone(),
        workspace_commands::legacy_index_path(&app),
        move |ws, _| save_and_record(ws, &chosen, &prepared).map(|item| Some(item)),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const DAY: &str = "2026-10-05";

    fn request(origin: &str, id: &str, text: &str) -> ScriptSaveRequest {
        ScriptSaveRequest {
            suggested_name: "umag-sp4.py".into(),
            text: text.into(),
            origin: origin.into(),
            origin_id: id.into(),
        }
    }

    fn workspace(dir: &Path) -> Workspace {
        Workspace::open(dir.join("workspace.db")).unwrap().0
    }

    #[test]
    fn file_names_are_reduced_to_a_safe_python_leaf() {
        assert_eq!(sanitize_file_name("umag-sp4.py"), "umag-sp4.py");
        assert_eq!(sanitize_file_name("umag-sp4"), "umag-sp4.py");
        assert_eq!(sanitize_file_name("..\\..\\evil/Edge.v2.PY"), "Edge.v2.py");
        assert_eq!(sanitize_file_name("a:b*c?.py"), "a_b_c_.py");
        assert_eq!(sanitize_file_name("   "), "script.py");
        assert_eq!(sanitize_file_name("..."), "script.py");
        assert_eq!(sanitize_file_name("CON.py"), "_CON.py");
        assert_eq!(sanitize_file_name("com1"), "_com1.py");
        assert_eq!(sanitize_file_name("com0"), "com0.py");
        assert!(sanitize_file_name(&"x".repeat(500)).chars().count() <= MAX_NAME_CHARS + 3);
    }

    #[test]
    fn the_first_line_names_the_origin_and_cannot_be_broken_by_the_id() {
        let line = provenance_line(ScriptOrigin::Template, "umag-sp4", DAY);
        assert!(line.starts_with("# Created by Fullmag from the template \"umag-sp4\" on 2026-10-05."));
        let hostile = provenance_line(ScriptOrigin::Mx3, "a.mx3\nimport os\r\nos.system('x')", DAY);
        assert_eq!(hostile.lines().count(), 1);
        assert!(hostile.contains("mumax3 file"));
        let text = compose_script(ScriptOrigin::Template, "t", DAY, "\u{feff}\"\"\"Doc.\"\"\"\nx = 1\n");
        assert!(text.starts_with("# Created by Fullmag"));
        assert!(!text.contains('\u{feff}'));
        assert!(text.ends_with("\"\"\"Doc.\"\"\"\nx = 1\n"));
    }

    #[test]
    fn requests_are_validated_before_any_dialog() {
        let ok = prepare_save(&request("template", "umag-sp4", "x = 1\n"), DAY).unwrap();
        assert_eq!(ok.origin, ScriptOrigin::Template);
        assert_eq!(ok.file_name, "umag-sp4.py");
        assert!(ok.text.ends_with("x = 1\n"));
        assert!(prepare_save(&request("mx3", "a.mx3", "x = 1\n"), DAY).is_ok());
        for (origin, id, text, needle) in [
            ("fms", "a", "x\n", "unknown script origin"),
            ("template", "  ", "x\n", "origin id is empty"),
            ("template", "a", "  \n", "empty"),
            ("template", "a", "x\0", "NUL"),
        ] {
            let error = prepare_save(&request(origin, id, text), DAY).unwrap_err();
            assert!(error.contains(needle), "{error}");
        }
        let long_id = "i".repeat(MAX_ORIGIN_ID_CHARS + 1);
        assert!(prepare_save(&request("template", &long_id, "x\n"), DAY).is_err());
        let huge = "x".repeat(MAX_SCRIPT_BYTES as usize + 1);
        assert!(prepare_save(&request("template", "a", &huge), DAY)
            .unwrap_err()
            .contains("1 MiB"));
    }

    #[test]
    fn the_target_keeps_a_py_choice_and_appends_the_extension_otherwise() {
        let (path, confirmed) = resolve_target(Path::new("C:/docs/a.py")).unwrap();
        assert_eq!(path, PathBuf::from("C:/docs/a.py"));
        assert!(confirmed);
        let (path, confirmed) = resolve_target(Path::new("C:/docs/a.v2")).unwrap();
        assert_eq!(path, PathBuf::from("C:/docs/a.v2.py"));
        assert!(!confirmed, "the appended name was never shown to the person");
        assert!(resolve_target(Path::new("")).is_err());
    }

    #[test]
    fn a_new_file_is_written_as_utf8_without_bom_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("sp4.py");
        write_script_atomic(&target, "# \u{b5}MAG \u{3b1}\nx = 1\n", false).unwrap();
        let bytes = fs::read(&target).unwrap();
        assert_ne!(&bytes[..3.min(bytes.len())], &[0xEF, 0xBB, 0xBF]);
        assert_eq!(String::from_utf8(bytes).unwrap(), "# \u{b5}MAG \u{3b1}\nx = 1\n");
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(leftovers, vec!["sp4.py".to_string()]);
    }

    #[test]
    fn an_existing_file_is_never_replaced_without_confirmation() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("mine.py");
        fs::write(&target, "precious\n").unwrap();
        let error = write_script_atomic(&target, "new\n", false).unwrap_err();
        assert!(error.contains("already exists"), "{error}");
        assert_eq!(fs::read_to_string(&target).unwrap(), "precious\n");
        // A confirmed replacement does replace, and still leaves nothing behind.
        write_script_atomic(&target, "new\n", true).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "new\n");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn a_folder_or_missing_directory_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("sub.py");
        fs::create_dir(&folder).unwrap();
        assert!(write_script_atomic(&folder, "x\n", true)
            .unwrap_err()
            .contains("not a regular file"));
        let missing = dir.path().join("nope").join("a.py");
        assert!(write_script_atomic(&missing, "x\n", false)
            .unwrap_err()
            .contains("does not exist"));
    }

    #[test]
    fn saving_records_create_then_open_and_returns_the_list_item() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        let prepared = prepare_save(
            &request("template", "umag-sp4", "\"\"\"SP4.\"\"\"\nimport fullmag as fm\n"),
            DAY,
        )
        .unwrap();
        let chosen = dir.path().join("umag-sp4.py");
        let item = save_and_record(&ws, &chosen, &prepared).unwrap();
        assert_eq!(item.kind, "script");
        assert_eq!(item.name, "umag-sp4");
        assert_eq!(item.meta["origin"], "template");
        assert_eq!(item.meta["origin_id"], "umag-sp4");
        assert_eq!(item.meta["uses_fullmag"], true);
        let history = workspace_commands::item_history(&ws, item.id, None).unwrap();
        let kinds: Vec<_> = history.events.iter().map(|event| (event.kind, event.actor)).collect();
        assert!(kinds.contains(&("create", "desktop")), "{kinds:?}");
        assert!(kinds.contains(&("open", "desktop")), "{kinds:?}");
        assert!(fs::read_to_string(&chosen).unwrap().starts_with("# Created by Fullmag"));
    }

    #[test]
    fn a_translated_mx3_is_recorded_as_an_import() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        let prepared = prepare_save(&request("mx3", "Edge.mx3", "import fullmag as fm\n"), DAY).unwrap();
        let item = save_and_record(&ws, &dir.path().join("Edge.py"), &prepared).unwrap();
        assert_eq!(item.meta["origin"], "mx3");
        let history = workspace_commands::item_history(&ws, item.id, None).unwrap();
        assert!(history.events.iter().any(|event| event.kind == "import"));
        assert!(!history.events.iter().any(|event| event.kind == "create"));
    }

    #[test]
    fn a_name_that_exists_after_appending_py_is_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let ws = workspace(dir.path());
        fs::write(dir.path().join("note.py"), "mine\n").unwrap();
        let prepared = prepare_save(&request("template", "t", "x = 1\n"), DAY).unwrap();
        let error = save_and_record(&ws, &dir.path().join("note"), &prepared).unwrap_err();
        assert!(error.contains("already exists"), "{error}");
        assert_eq!(fs::read_to_string(dir.path().join("note.py")).unwrap(), "mine\n");
    }
}
