//! Application-owned Python selection for native Windows packages.
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Validate an explicit writable-state override before any caller creates files.
pub fn validated_state_override(value: Option<PathBuf>) -> io::Result<Option<PathBuf>> {
    let value = value.filter(|path| !path.as_os_str().is_empty());
    if value.as_ref().is_some_and(|path| !path.is_absolute()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "FULLMAG_STATE_ROOT must be an absolute path",
        ));
    }
    Ok(value)
}

pub fn packaged_windows_python(root: &Path) -> Option<PathBuf> {
    packaged_python_for_platform(root, cfg!(windows))
}

pub fn packaged_windows_root(executable: &Path) -> Option<PathBuf> {
    let bin = executable.parent()?;
    if !bin
        .file_name()?
        .to_string_lossy()
        .eq_ignore_ascii_case("bin")
    {
        return None;
    }
    let root = bin.parent()?;
    packaged_windows_python(root).map(|_| root.to_path_buf())
}

fn packaged_python_for_platform(root: &Path, windows: bool) -> Option<PathBuf> {
    if !windows {
        return None;
    }
    // A package marker remains authoritative when its executable is missing.
    // An unreadable marker also cannot authorize an external fallback.
    let markers = [
        root.join("python/python.exe"),
        root.join("python/python312._pth"),
        root.join("share/version.json"),
    ];
    markers
        .iter()
        .any(|path| path.try_exists().unwrap_or(true))
        .then_some(())
        .or_else(|| {
            let legacy = !root.join("packages/fullmag-py/src/fullmag").is_dir()
                && root.join("bin/fullmag.exe").try_exists().unwrap_or(true)
                && (root.join("web").try_exists().unwrap_or(true)
                    || root.join(".fullmag").try_exists().unwrap_or(true));
            legacy.then_some(())
        })
        .map(|_| root.join("python/python.exe"))
}

pub fn packaged_windows_state_root(root: &Path) -> io::Result<Option<PathBuf>> {
    if packaged_windows_python(root).is_none() {
        return Ok(None);
    }
    windows_state_directory(
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from),
        std::env::var_os("USERPROFILE").map(PathBuf::from),
    )
    .map(Some)
}

fn windows_state_directory(
    local: Option<PathBuf>,
    profile: Option<PathBuf>,
) -> io::Result<PathBuf> {
    let state = local.filter(|path| path.is_absolute())
        .or_else(|| profile.filter(|path| path.is_absolute()).map(|path| path.join("AppData/Local")))
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound,
            "packaged Windows runtime requires LOCALAPPDATA, USERPROFILE or explicit FULLMAG_STATE_ROOT"))?;
    Ok(state.join("Fullmag"))
}

pub fn configure_packaged_python(command: &mut Command, root: &Path) -> io::Result<()> {
    if !root.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "packaged Python root must be absolute",
        ));
    }
    for name in [
        "python.exe",
        "python312.dll",
        "python3.dll",
        "python312.zip",
        "python312._pth",
        "sitecustomize.py",
        "site-packages/fullmag/__init__.py",
    ] {
        let path = root.join("python").join(name);
        let metadata = std::fs::metadata(&path).map_err(|error| {
            io::Error::new(
                error.kind(),
                format!(
                    "packaged Python file unavailable: {}: {error}",
                    path.display()
                ),
            )
        })?;
        if !metadata.is_file() || metadata.len() == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("packaged Python file invalid: {}", path.display()),
            ));
        }
    }
    if std::fs::read(root.join("python/python312._pth"))?
        != b"python312.zip\n.\nsite-packages\nimport site\n"
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "packaged Python path configuration changed",
        ));
    }
    let path = std::env::join_paths([root.join("bin"), root.join("python")])
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
    command
        .arg("-I")
        .arg("-u")
        .env_remove("PYTHONHOME")
        .env_remove("PYTHONPATH")
        .env_remove("PYTHONUSERBASE")
        .env("PATH", path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_override_rejects_relative_paths_without_creating_files() {
        for path in ["state", "../state", "."] {
            assert_eq!(
                validated_state_override(Some(path.into()))
                    .unwrap_err()
                    .kind(),
                io::ErrorKind::InvalidInput
            );
        }
    }

    #[test]
    fn state_override_preserves_absolute_paths_and_empty_default() {
        let directory = tempfile::tempdir().unwrap();
        let state = directory.path().join("state");
        assert_eq!(
            validated_state_override(Some(state.clone())).unwrap(),
            Some(state)
        );
        assert_eq!(
            validated_state_override(Some(PathBuf::new())).unwrap(),
            None
        );
        assert_eq!(validated_state_override(None).unwrap(), None);
    }

    #[test]
    fn legacy_bundle_is_owned_but_source_checkout_keeps_development_selection() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        std::fs::create_dir(root.join("bin")).unwrap();
        std::fs::create_dir(root.join("web")).unwrap();
        std::fs::write(root.join("bin/fullmag.exe"), "fixture").unwrap();
        assert_eq!(
            packaged_python_for_platform(root, true),
            Some(root.join("python/python.exe"))
        );
        std::fs::create_dir_all(root.join("packages/fullmag-py/src/fullmag")).unwrap();
        assert_eq!(packaged_python_for_platform(root, true), None);
    }

    #[test]
    fn state_directory_requires_absolute_user_storage() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().to_path_buf();
        assert_eq!(
            windows_state_directory(Some(root.clone()), None).unwrap(),
            root.join("Fullmag")
        );
        assert_eq!(
            windows_state_directory(Some("relative".into()), Some(root.clone())).unwrap(),
            root.join("AppData/Local/Fullmag")
        );
        assert!(windows_state_directory(None, None).is_err());
        assert!(windows_state_directory(Some("relative".into()), None).is_err());
    }

    #[test]
    fn package_marker_prevents_external_fallback_even_without_executable() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        assert_eq!(packaged_python_for_platform(root, true), None);
        std::fs::create_dir(root.join("share")).unwrap();
        std::fs::write(root.join("share/version.json"), "{}").unwrap();
        assert_eq!(
            packaged_python_for_platform(root, true),
            Some(root.join("python/python.exe"))
        );
        assert_eq!(packaged_python_for_platform(root, false), None);
        let mut command = Command::new(root.join("python/python.exe"));
        assert!(configure_packaged_python(&mut command, root).is_err());
    }

    #[test]
    fn packaged_command_is_isolated_and_rejects_changed_configuration() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let python = root.join("python");
        std::fs::create_dir_all(python.join("site-packages/fullmag")).unwrap();
        for name in [
            "python.exe",
            "python312.dll",
            "python3.dll",
            "python312.zip",
            "sitecustomize.py",
            "site-packages/fullmag/__init__.py",
        ] {
            std::fs::write(python.join(name), "fixture").unwrap();
        }
        std::fs::write(
            python.join("python312._pth"),
            b"python312.zip\n.\nsite-packages\nimport site\n",
        )
        .unwrap();
        let mut command = Command::new(python.join("python.exe"));
        configure_packaged_python(&mut command, root).unwrap();
        assert_eq!(
            command
                .get_args()
                .map(|arg| arg.to_str().unwrap())
                .collect::<Vec<_>>(),
            ["-I", "-u"]
        );
        for name in ["PYTHONHOME", "PYTHONPATH", "PYTHONUSERBASE"] {
            assert!(command
                .get_envs()
                .any(|(key, value)| key == name && value.is_none()));
        }
        let path = command
            .get_envs()
            .find(|(key, _)| key == "PATH")
            .unwrap()
            .1
            .unwrap();
        assert_eq!(
            std::env::split_paths(path).collect::<Vec<_>>(),
            [root.join("bin"), python.clone()]
        );
        std::fs::write(python.join("python312._pth"), "../outside\n").unwrap();
        assert!(configure_packaged_python(&mut Command::new("unused"), root).is_err());
    }
}
