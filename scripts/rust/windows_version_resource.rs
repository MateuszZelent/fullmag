//! Compile a small Windows VERSIONINFO resource for a native Fullmag binary.
//!
//! This file is included by a package `build.rs` with `#[path = ...]`.  It is
//! deliberately self-contained: the build script must not grow a dependency
//! or a second version of the Windows metadata policy.  The helper is a no-op
//! for non-MSVC targets, so the same package remains portable on Linux.

use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

const RC_OVERRIDE_ENV: &str = "FULLMAG_RC_EXE";
const BUILD_VERSION_ENV: &str = "FULLMAG_BUILD_VERSION";
const WINDOWS_FILE_VERSION_ENV: &str = "FULLMAG_WINDOWS_FILE_VERSION";

/// Compile and link a Windows MSVC VERSIONINFO resource for the current
/// package.
///
/// `product_name` is used as the file description in the resource string
/// table.  The function intentionally has no return value: a malformed build
/// identity, unavailable SDK, or failed `rc.exe` invocation is a build error.
/// Non-Windows and non-MSVC targets return without creating any files.
pub fn compile_version_resource(product_name: &str) {
    for variable in [
        "CARGO_CFG_TARGET_OS",
        "CARGO_CFG_TARGET_ENV",
        "CARGO_PKG_VERSION",
        BUILD_VERSION_ENV,
        WINDOWS_FILE_VERSION_ENV,
        RC_OVERRIDE_ENV,
        "WindowsSdkDir",
        "WindowsSDKVersion",
        "ProgramFiles(x86)",
        "ProgramFiles",
    ] {
        println!("cargo:rerun-if-env-changed={variable}");
    }

    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows")
        || env::var("CARGO_CFG_TARGET_ENV").as_deref() != Ok("msvc")
    {
        return;
    }

    validate_rc_text(product_name, "product name");

    let package_version = required_env("CARGO_PKG_VERSION");
    validate_semver(&package_version, "CARGO_PKG_VERSION");

    let product_version = match optional_env(BUILD_VERSION_ENV) {
        Some(version) => {
            validate_semver(&version, BUILD_VERSION_ENV);
            version
        }
        None => package_version.clone(),
    };

    let file_version = match optional_env(WINDOWS_FILE_VERSION_ENV) {
        Some(version) => parse_windows_file_version(&version, WINDOWS_FILE_VERSION_ENV),
        None => package_file_version(&package_version),
    };

    let out_dir = PathBuf::from(required_env("OUT_DIR"));
    if !out_dir.is_absolute() {
        panic!("OUT_DIR must be an absolute path: {}", out_dir.display());
    }
    if !out_dir.is_dir() {
        panic!("OUT_DIR is not an existing directory: {}", out_dir.display());
    }

    let resource_source = out_dir.join("fullmag-version.rc");
    let resource_object = out_dir.join("fullmag-version.res");
    let resource = render_resource(product_name, &product_version, file_version);
    fs::write(&resource_source, resource.as_bytes()).unwrap_or_else(|error| {
        panic!(
            "cannot write Windows VERSIONINFO source {}: {error}",
            resource_source.display()
        )
    });

    let rc_exe = resolve_rc_exe();
    let status = Command::new(&rc_exe)
        .arg("/nologo")
        .arg("/fo")
        .arg(&resource_object)
        .arg(&resource_source)
        .status()
        .unwrap_or_else(|error| {
            panic!(
                "cannot execute rc.exe at {}: {error}",
                rc_exe.display()
            )
        });
    if !status.success() {
        panic!(
            "rc.exe failed with status {status} while compiling {}",
            resource_source.display()
        );
    }
    let object_size = fs::metadata(&resource_object)
        .unwrap_or_else(|error| {
            panic!(
                "rc.exe did not produce {}: {error}",
                resource_object.display()
            )
        })
        .len();
    if object_size == 0 {
        panic!("rc.exe produced an empty resource: {}", resource_object.display());
    }

    // MSVC's linker accepts a compiled .res as a link argument.  Keeping the
    // absolute OUT_DIR path here also prevents Cargo from looking up a stale
    // resource from another build directory.
    println!("cargo:rustc-link-arg={}", resource_object.display());
}

fn optional_env(name: &str) -> Option<String> {
    match env::var(name) {
        Ok(value) => Some(value),
        Err(env::VarError::NotPresent) => None,
        Err(env::VarError::NotUnicode(_)) => panic!("{name} is not valid UTF-8"),
    }
}

fn required_env(name: &str) -> String {
    optional_env(name).unwrap_or_else(|| panic!("required build environment variable is missing: {name}"))
}

fn validate_rc_text(value: &str, label: &str) {
    if value.is_empty() || value.len() > 128 || !value.is_ascii() {
        panic!("{label} must be non-empty printable ASCII");
    }
    if value.bytes().any(|byte| {
        !(0x20..=0x7e).contains(&byte) || byte == b'"' || byte == b'\\'
    }) {
        panic!("{label} contains characters unsafe for an RC string literal");
    }
}

fn validate_semver(value: &str, label: &str) {
    if value.is_empty() || value.len() > 256 || !value.is_ascii() {
        panic!("{label} must be an ASCII SemVer value");
    }

    let (without_build, build) = match value.split_once('+') {
        Some((prefix, suffix)) => (prefix, Some(suffix)),
        None => (value, None),
    };
    if without_build.contains('+') || build.is_some_and(|value| value.is_empty()) {
        panic!("{label} has an invalid build-metadata section");
    }

    let (core, prerelease) = match without_build.split_once('-') {
        Some((prefix, suffix)) => (prefix, Some(suffix)),
        None => (without_build, None),
    };
    if core.split('.').count() != 3 {
        panic!("{label} must contain major.minor.patch");
    }
    for component in core.split('.') {
        validate_semver_number(component, label);
    }
    if let Some(identifiers) = prerelease {
        validate_semver_identifiers(identifiers, label, true);
    }
    if let Some(identifiers) = build {
        validate_semver_identifiers(identifiers, label, false);
    }
}

fn validate_semver_number(value: &str, label: &str) {
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        panic!("{label} has an invalid numeric SemVer component");
    }
}

fn validate_semver_identifiers(value: &str, label: &str, prerelease: bool) {
    if value.is_empty() {
        panic!("{label} has an empty SemVer identifier");
    }
    for identifier in value.split('.') {
        if identifier.is_empty()
            || !identifier
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            panic!("{label} has an invalid SemVer identifier");
        }
        if prerelease
            && identifier.len() > 1
            && identifier.starts_with('0')
            && identifier.bytes().all(|byte| byte.is_ascii_digit())
        {
            panic!("{label} has a leading-zero numeric prerelease identifier");
        }
    }
}

fn parse_windows_file_version(value: &str, label: &str) -> [u16; 4] {
    let parts: Vec<&str> = value.split('.').collect();
    if parts.len() != 4 {
        panic!("{label} must be major.minor.patch.daysSince2000");
    }
    let mut parsed = [0u16; 4];
    for (index, part) in parts.iter().enumerate() {
        if part.is_empty()
            || (part.len() > 1 && part.starts_with('0'))
            || !part.bytes().all(|byte| byte.is_ascii_digit())
        {
            panic!("{label} has an invalid numeric component");
        }
        parsed[index] = part
            .parse::<u16>()
            .unwrap_or_else(|_| panic!("{label} component {index} does not fit in u16"));
    }
    parsed
}

fn package_file_version(package_version: &str) -> [u16; 4] {
    let core_end = package_version
        .find(|character: char| character == '-' || character == '+')
        .unwrap_or(package_version.len());
    let core = &package_version[..core_end];
    let parts: Vec<&str> = core.split('.').collect();
    if parts.len() != 3 {
        panic!("CARGO_PKG_VERSION must contain major.minor.patch");
    }
    let mut parsed = [0u16; 4];
    for (index, part) in parts.iter().enumerate() {
        parsed[index] = part
            .parse::<u16>()
            .unwrap_or_else(|_| panic!("CARGO_PKG_VERSION component {index} does not fit in u16"));
    }
    parsed
}

fn render_resource(product_name: &str, product_version: &str, file_version: [u16; 4]) -> String {
    let file_version_numeric = format!(
        "{},{},{},{}",
        file_version[0], file_version[1], file_version[2], file_version[3]
    );
    let original_filename = match product_name {
        "Fullmag CLI" => "fullmag.exe",
        "Fullmag API" => "fullmag-api.exe",
        _ => "fullmag.exe",
    };

    format!(
        "1 VERSIONINFO\n\
FILEVERSION {file_version_numeric}\n\
PRODUCTVERSION {file_version_numeric}\n\
FILEFLAGSMASK 0x3fL\n\
FILEFLAGS 0x0L\n\
FILEOS 0x40004L\n\
FILETYPE 0x1L\n\
FILESUBTYPE 0x0L\n\
BEGIN\n\
  BLOCK \"StringFileInfo\"\n\
  BEGIN\n\
    BLOCK \"040904B0\"\n\
    BEGIN\n\
      VALUE \"CompanyName\", \"Fullmag\"\n\
      VALUE \"FileDescription\", \"{product_name}\"\n\
      VALUE \"FileVersion\", \"{product_version}\"\n\
      VALUE \"InternalName\", \"{original_filename}\"\n\
      VALUE \"OriginalFilename\", \"{original_filename}\"\n\
      VALUE \"ProductName\", \"Fullmag\"\n\
      VALUE \"ProductVersion\", \"{product_version}\"\n\
    END\n\
  END\n\
  BLOCK \"VarFileInfo\"\n\
  BEGIN\n\
    VALUE \"Translation\", 0x0409, 1200\n\
  END\n\
END\n"
    )
}

fn resolve_rc_exe() -> PathBuf {
    if let Some(explicit) = optional_env(RC_OVERRIDE_ENV) {
        let path = PathBuf::from(explicit);
        if !path.is_absolute() || !path.is_file() {
            panic!(
                "{RC_OVERRIDE_ENV} must name an existing absolute rc.exe: {}",
                path.display()
            );
        }
        return path;
    }

    let mut sdk_roots = Vec::new();
    for variable in ["WindowsSdkDir", "WINDOWSSDKDIR"] {
        if let Some(value) = optional_env(variable) {
            let path = PathBuf::from(value.trim_end_matches(|character| {
                character == '\\' || character == '/'
            }));
            if !sdk_roots.iter().any(|root: &PathBuf| root == &path) {
                sdk_roots.push(path);
            }
        }
    }
    for variable in ["ProgramFiles(x86)", "ProgramFiles"] {
        if let Some(value) = optional_env(variable) {
            sdk_roots.push(PathBuf::from(value).join("Windows Kits").join("10"));
        }
    }

    let sdk_version = optional_env("WindowsSDKVersion")
        .map(|value| {
            value
                .trim_matches(|character| character == '\\' || character == '/')
                .to_owned()
        });
    let architectures = ["x64", "x86", "arm64"];
    let mut candidates = Vec::new();
    for root in sdk_roots {
        let bin = root.join("bin");
        if let Some(version) = &sdk_version {
            for architecture in architectures {
                candidates.push(bin.join(version).join(architecture).join("rc.exe"));
            }
        }
        for architecture in architectures {
            candidates.push(bin.join(architecture).join("rc.exe"));
        }
        if let Ok(entries) = fs::read_dir(&bin) {
            let mut version_directories = entries
                .filter_map(Result::ok)
                .filter(|entry| entry.path().is_dir())
                .map(|entry| entry.path())
                .collect::<Vec<_>>();
            version_directories.sort_by(|left, right| right.cmp(left));
            for version_directory in version_directories {
                for architecture in architectures {
                    candidates.push(version_directory.join(architecture).join("rc.exe"));
                }
            }
        }
    }

    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .unwrap_or_else(|| {
            panic!(
                "cannot locate rc.exe in the known MSVC SDK roots; set {RC_OVERRIDE_ENV} to an absolute SDK rc.exe path"
            )
        })
}
