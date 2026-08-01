use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    println!("cargo:rerun-if-env-changed=SOURCE_DATE_EPOCH");
    println!("cargo:rerun-if-env-changed=FULLMAG_SOURCE_GIT_COMMIT");
    println!("cargo:rerun-if-env-changed=FULLMAG_SOURCE_WORKTREE_STATE");
    println!("cargo:rerun-if-env-changed=FULLMAG_SOURCE_SNAPSHOT_SHA256");
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("fullmag-build-info must live below the workspace crates directory");

    let timestamp = build_timestamp_utc();
    let (commit, worktree_state, source_snapshot_sha256) = injected_source_identity()
        .unwrap_or_else(|| {
            emit_git_rerun_paths(repo_root);
            let commit = git_output(repo_root, &["rev-parse", "--verify", "HEAD"])
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "unknown".to_string());
            let worktree_state = git_output(
                repo_root,
                &["status", "--porcelain", "--untracked-files=normal"],
            )
            .map(|value| if value.is_empty() { "clean" } else { "dirty" })
            .unwrap_or("unknown");
            (commit, worktree_state.to_string(), "unknown".to_string())
        });

    println!("cargo:rustc-env=FULLMAG_BUILD_TIMESTAMP_UTC={timestamp}");
    println!("cargo:rustc-env=FULLMAG_BUILD_GIT_COMMIT={commit}");
    println!("cargo:rustc-env=FULLMAG_BUILD_WORKTREE_STATE={worktree_state}");
    println!("cargo:rustc-env=FULLMAG_BUILD_SOURCE_SNAPSHOT_SHA256={source_snapshot_sha256}");
}

fn injected_source_identity() -> Option<(String, String, String)> {
    let commit = std::env::var("FULLMAG_SOURCE_GIT_COMMIT").ok();
    let worktree_state = std::env::var("FULLMAG_SOURCE_WORKTREE_STATE").ok();
    let source_snapshot_sha256 = std::env::var("FULLMAG_SOURCE_SNAPSHOT_SHA256").ok();
    match (commit, worktree_state, source_snapshot_sha256) {
        (None, None, None) => None,
        (Some(commit), Some(worktree_state), Some(source_snapshot_sha256)) => {
            if commit.len() != 40
                || !commit
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                panic!("FULLMAG_SOURCE_GIT_COMMIT must be exactly 40 lowercase hex digits");
            }
            if !matches!(worktree_state.as_str(), "clean" | "dirty") {
                panic!("FULLMAG_SOURCE_WORKTREE_STATE must be clean or dirty");
            }
            if source_snapshot_sha256.len() != 64
                || !source_snapshot_sha256.bytes().all(|byte| {
                    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
                })
            {
                panic!("FULLMAG_SOURCE_SNAPSHOT_SHA256 must be exactly 64 lowercase hex digits");
            }
            Some((commit, worktree_state, source_snapshot_sha256))
        }
        _ => panic!(
            "FULLMAG_SOURCE_GIT_COMMIT, FULLMAG_SOURCE_WORKTREE_STATE, and FULLMAG_SOURCE_SNAPSHOT_SHA256 must be set together"
        ),
    }
}

fn build_timestamp_utc() -> String {
    let seconds = std::env::var("SOURCE_DATE_EPOCH")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or_else(current_unix_seconds);
    format_unix_seconds_utc(seconds)
}

fn current_unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

fn format_unix_seconds_utc(seconds: i64) -> String {
    let days = seconds.div_euclid(86_400);
    let seconds_in_day = seconds.rem_euclid(86_400);
    let hour = seconds_in_day / 3_600;
    let minute = (seconds_in_day % 3_600) / 60;
    let second = seconds_in_day % 60;
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 }.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096).div_euclid(365);
    let year_of_era = yoe + era * 400;
    let day_of_year = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let month_prime = (5 * day_of_year + 2).div_euclid(153);
    let day = day_of_year - (153 * month_prime + 2).div_euclid(5) + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    let year = year_of_era + if month <= 2 { 1 } else { 0 };
    (year, month, day)
}

fn git_output(repo_root: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(repo_root)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn emit_git_rerun_paths(repo_root: &Path) {
    for name in ["HEAD", "index"] {
        if let Some(path) = git_output(repo_root, &["rev-parse", "--git-path", name]) {
            let path = PathBuf::from(path);
            let resolved = if path.is_absolute() {
                path
            } else {
                repo_root.join(path)
            };
            println!("cargo:rerun-if-changed={}", resolved.display());
        }
    }
}
