//! The only run-result namespace admitted by readonly accepted-v2 archives.
//! This proves immutable membership, not accepted execution or physics. The
//! API separately binds these bytes to the detached catalog's modal CAS.
use crate::frequency_domain_artifact_generation as generation;
use anyhow::{Context, Result, bail};
use std::collections::HashSet;
use std::path::Path;

pub(super) fn validate(
    root: &Path,
    run_id: &str,
    inventory: &HashSet<String>,
    include_artifacts: bool,
) -> Result<HashSet<String>> {
    crate::repository_path::validate_store_id(run_id)?;
    let prefix = format!("runs/{run_id}/artifacts/");
    let selected = inventory
        .iter()
        .filter(|name| name.starts_with(&prefix))
        .cloned()
        .collect::<HashSet<_>>();
    if selected.is_empty() {
        return Ok(selected);
    }
    if !include_artifacts {
        bail!("compact accepted archive cannot contain projected results");
    }
    let artifact_root =
        crate::repository_path::checked_path(root, &format!("runs/{run_id}/artifacts"))?;
    let capture = generation::capture(&artifact_root)?
        .context("accepted result projection requires an immutable generation marker")?;
    if !capture.is_immutable() {
        bail!("accepted result projection cannot use a mutable marker");
    }
    let owner = capture
        .commit
        .content
        .producer
        .as_ref()
        .context("accepted projection has no producer")?;
    if owner.run_id != run_id
        || !matches!(owner.stage_kind.as_str(), "eigenmodes" | "flat_eigenmodes")
    {
        bail!("accepted projected generation has the wrong run or stage kind");
    }
    let id = capture
        .commit
        .generation_id
        .strip_prefix("sha256:")
        .context("invalid projected generation id")?;
    let mut expected = HashSet::from([format!("{prefix}{}", generation::IMMUTABLE_COMMIT_PATH)]);
    for path in capture.commit.content.members.keys() {
        capture.verify_member(&artifact_root, path)?;
        expected.insert(format!(
            "{prefix}{}/{id}/{path}",
            generation::GENERATION_DIRECTORY
        ));
    }
    if selected != expected {
        bail!("accepted projected files differ from the exact immutable generation closure");
    }
    capture.ensure_current(&artifact_root)?;
    Ok(expected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use generation::{GenerationBody, GenerationCommit, GenerationMember, PublicationOwner};
    use std::collections::BTreeMap;
    use std::fs;

    fn projection(
        owner_run: &str,
        kind: &str,
        immutable: bool,
    ) -> (tempfile::TempDir, HashSet<String>, String) {
        let root = tempfile::tempdir().unwrap();
        let artifact = root.path().join("runs/run-projection/artifacts");
        let bytes = b"complex modal payload";
        let body = GenerationBody {
            schema_version: if immutable {
                generation::IMMUTABLE_SCHEMA
            } else {
                generation::SCHEMA
            }
            .into(),
            producer: Some(PublicationOwner {
                run_id: owner_run.into(),
                stage_id: "eigen".into(),
                stage_kind: kind.into(),
            }),
            members: BTreeMap::from([(
                "eigen/field.bin".into(),
                GenerationMember {
                    byte_length: bytes.len() as u64,
                    sha256: generation::digest(bytes),
                },
            )]),
        };
        let commit = GenerationCommit {
            generation_id: generation::generation_id(&body).unwrap(),
            content: body,
        };
        let id = commit.generation_id.strip_prefix("sha256:").unwrap();
        let member = if immutable {
            format!("{}/{id}/eigen/field.bin", generation::GENERATION_DIRECTORY)
        } else {
            "eigen/field.bin".into()
        };
        fs::create_dir_all(artifact.join(&member).parent().unwrap()).unwrap();
        fs::write(artifact.join(&member), bytes).unwrap();
        let marker = if immutable {
            generation::IMMUTABLE_COMMIT_PATH
        } else {
            generation::COMMIT_PATH
        };
        fs::create_dir_all(artifact.join(marker).parent().unwrap()).unwrap();
        fs::write(
            artifact.join(marker),
            serde_json::to_vec_pretty(&commit).unwrap(),
        )
        .unwrap();
        let prefix = "runs/run-projection/artifacts/";
        let member = format!("{prefix}{member}");
        let inventory = HashSet::from([format!("{prefix}{marker}"), member.clone()]);
        (root, inventory, member)
    }

    #[test]
    fn admits_only_the_exact_immutable_modal_generation() {
        let (root, inventory, _) = projection("run-projection", "eigenmodes", true);
        assert_eq!(
            validate(root.path(), "run-projection", &inventory, true).unwrap(),
            inventory
        );
        assert!(validate(root.path(), "run-projection", &inventory, false).is_err());
    }

    #[test]
    fn rejects_foreign_producer_nonmodal_and_mutable_results() {
        for (owner, kind, immutable) in [
            ("other-run", "eigenmodes", true),
            ("run-projection", "relax", true),
            ("run-projection", "eigenmodes", false),
        ] {
            let (root, inventory, _) = projection(owner, kind, immutable);
            assert!(validate(root.path(), "run-projection", &inventory, true).is_err());
        }
    }

    #[test]
    fn rejects_missing_extra_and_tampered_members() {
        let (root, inventory, member) = projection("run-projection", "eigenmodes", true);
        let mut missing = inventory.clone();
        missing.remove(&member);
        assert!(validate(root.path(), "run-projection", &missing, true).is_err());
        for extra in ["claim.json", "journal.json", "eigen/uncommitted.bin"] {
            let mut extra_inventory = inventory.clone();
            extra_inventory.insert(format!("runs/run-projection/artifacts/{extra}"));
            assert!(validate(root.path(), "run-projection", &extra_inventory, true).is_err());
        }
        fs::write(root.path().join(member), b"changed modal payload").unwrap();
        assert!(validate(root.path(), "run-projection", &inventory, true).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinked_result_members() {
        let (root, inventory, member) = projection("run-projection", "eigenmodes", true);
        let path = root.path().join(member);
        let external = root.path().join("external.bin");
        fs::write(&external, b"complex modal payload").unwrap();
        fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(external, path).unwrap();
        assert!(validate(root.path(), "run-projection", &inventory, true).is_err());
    }

    #[test]
    fn preserves_archives_without_result_projection() {
        let root = tempfile::tempdir().unwrap();
        let inventory = HashSet::from(["runs/run-projection/run_manifest.json".into()]);
        assert!(
            validate(root.path(), "run-projection", &inventory, false)
                .unwrap()
                .is_empty()
        );
    }
}
