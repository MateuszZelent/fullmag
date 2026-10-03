// Keep the native stamp consistent with scripts/build_version.py. Managed
// builds inject a generated version; unmanaged builds remain visibly marked
// when their complete source identity is unavailable.
pub fn development_version(
    base: &str,
    seconds: i64,
    timestamp: &str,
    commit: &str,
    state: &str,
    snapshot: &str,
) -> String {
    let date = timestamp[..10].replace('-', "");
    let day_number = seconds.div_euclid(86_400) - 10_957;
    let known_commit = commit.len() == 40
        && commit.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase());
    let known_snapshot = snapshot.len() == 64
        && snapshot.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase());
    let known_identity = known_commit && known_snapshot
        && (state == "clean" || state == "dirty")
        && (0..=65_535).contains(&day_number);
    let mut version = if known_identity {
        format!("{base}-dev.{date}.g{}", &commit[..12])
    } else {
        format!("{base}-dev.{date}.unqualified")
    };
    if known_identity && state == "dirty" {
        version.push_str(&format!(".dirty.s{}", &snapshot[..12]));
    }
    if known_identity {
        version.push_str(&format!("+{day_number}"));
    }
    if let Ok(injected) = std::env::var("FULLMAG_BUILD_VERSION") {
        assert_eq!(injected, version, "generated build version disagrees with the bound source identity/date");
    }
    version
}
