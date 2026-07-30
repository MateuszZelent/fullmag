#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BuildIdentity {
    pub built_at_utc: &'static str,
    pub git_commit: &'static str,
    pub worktree_state: &'static str,
    pub source_snapshot_sha256: &'static str,
}

const BUILD_STAMP: &str = concat!(
    "[fullmag] build: ",
    env!("FULLMAG_BUILD_TIMESTAMP_UTC"),
    " | commit: ",
    env!("FULLMAG_BUILD_GIT_COMMIT"),
    " | ",
    env!("FULLMAG_BUILD_WORKTREE_STATE"),
    " | source snapshot: ",
    env!("FULLMAG_BUILD_SOURCE_SNAPSHOT_SHA256"),
);

pub fn identity() -> BuildIdentity {
    BuildIdentity {
        built_at_utc: env!("FULLMAG_BUILD_TIMESTAMP_UTC"),
        git_commit: env!("FULLMAG_BUILD_GIT_COMMIT"),
        worktree_state: env!("FULLMAG_BUILD_WORKTREE_STATE"),
        source_snapshot_sha256: env!("FULLMAG_BUILD_SOURCE_SNAPSHOT_SHA256"),
    }
}

pub fn stamp() -> String {
    BUILD_STAMP.to_string()
}

pub fn print_startup_stamp() {
    eprintln!("{}", stamp());
}

#[cfg(test)]
mod tests {
    use super::{identity, stamp};

    #[test]
    fn stamp_contains_all_build_identity_fields() {
        let identity = identity();
        assert_eq!(
            stamp(),
            format!(
                "[fullmag] build: {} | commit: {} | {} | source snapshot: {}",
                identity.built_at_utc,
                identity.git_commit,
                identity.worktree_state,
                identity.source_snapshot_sha256
            )
        );
        assert!(matches!(
            identity.worktree_state,
            "clean" | "dirty" | "unknown"
        ));
    }

    #[test]
    fn timestamp_has_rfc3339_utc_shape() {
        let timestamp = identity().built_at_utc;
        assert_eq!(timestamp.len(), 20);
        assert_eq!(&timestamp[4..5], "-");
        assert_eq!(&timestamp[7..8], "-");
        assert_eq!(&timestamp[10..11], "T");
        assert_eq!(&timestamp[13..14], ":");
        assert_eq!(&timestamp[16..17], ":");
        assert_eq!(&timestamp[19..20], "Z");
    }

    #[test]
    fn source_date_epoch_is_embedded_when_expected() {
        let Ok(expected) = std::env::var("FULLMAG_EXPECT_BUILD_TIMESTAMP") else {
            return;
        };
        assert_eq!(identity().built_at_utc, expected);
    }
}
