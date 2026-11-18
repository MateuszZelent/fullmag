//! Freeze pinned STL bytes before either mesh-only or study preparation.
use crate::error::ApiError;
use fullmag_application::OpaqueAsset;
use fullmag_authoring::SceneDocument;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

const MAX_SOURCE_BYTES: u64 = 128 * 1024 * 1024;
const IMPORTED_STL_ASSET_PREFIX: &str = "project/assets/imported-geometry/";

pub(crate) fn script_asset_root(script_path: &str, workspace_root: &Path) -> PathBuf {
    Path::new(script_path)
        .parent()
        .filter(|parent| parent.is_absolute())
        .unwrap_or(workspace_root)
        .to_path_buf()
}

pub(crate) fn capture_stl_source(
    source: &Path,
    allowed_roots: &[PathBuf],
    expected_digest: Option<&str>,
) -> Result<Vec<u8>, ApiError> {
    let resolved = source
        .canonicalize()
        .map_err(|_| ApiError::not_found("STL source file is unavailable"))?;
    if !allowed_roots
        .iter()
        .filter_map(|root| root.canonicalize().ok())
        .any(|root| resolved.starts_with(root))
    {
        return Err(ApiError::bad_request(
            "STL source must be inside the selected project, workspace or user-data tree",
        ));
    }
    let mut file = File::open(resolved)?;
    let before = file.metadata()?;
    if !before.is_file() || before.len() > MAX_SOURCE_BYTES {
        return Err(ApiError::bad_request(
            "STL source must be a regular file no larger than 128 MiB",
        ));
    }
    let modified = before.modified()?;
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_SOURCE_BYTES + 1)
        .read_to_end(&mut bytes)?;
    let after = file.metadata()?;
    if bytes.len() as u64 != before.len()
        || before.len() != after.len()
        || modified != after.modified()?
    {
        return Err(ApiError::conflict("STL source changed during capture"));
    }
    if expected_digest.is_some_and(|digest| digest != format!("{:x}", Sha256::digest(&bytes))) {
        return Err(ApiError::conflict(
            "STL source digest differs from the pinned project asset",
        ));
    }
    Ok(bytes)
}

struct StagingFile(PathBuf);
impl Drop for StagingFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn publish_snapshot(root: &Path, digest: &str, bytes: &[u8]) -> Result<PathBuf, ApiError> {
    fs::create_dir_all(root)?;
    let destination = root.join(format!("{digest}.stl"));
    let stage = StagingFile(root.join(format!(".staging-{}", crate::uuid_v4_hex())));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&stage.0)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    match fs::hard_link(&stage.0, &destination) {
        Ok(()) => {
            // Only the newly published private copy is made read-only.
            drop(stage);
            let mut permissions = fs::metadata(&destination)?.permissions();
            permissions.set_readonly(true);
            fs::set_permissions(&destination, permissions)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    capture_stl_source(&destination, &[root.to_path_buf()], Some(digest))?;
    Ok(destination)
}

fn stl_digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn referenced_stl_paths(scene: &SceneDocument) -> Result<BTreeSet<String>, ApiError> {
    let mut paths = BTreeSet::new();
    let mut identities = BTreeMap::<String, (String, String)>::new();
    for object in &scene.objects {
        let Some(reference) = &object.geometry.source_asset else {
            continue;
        };
        reference.validate().map_err(ApiError::bad_request)?;
        if object.geometry.geometry_kind != "ImportedGeometry" {
            return Err(ApiError::bad_request(
                "source_asset requires ImportedGeometry",
            ));
        }
        let identity = (
            reference.content_sha256.clone(),
            reference.archive_path.clone(),
        );
        if identities
            .insert(reference.asset_id.clone(), identity.clone())
            .is_some_and(|prior| prior != identity)
        {
            return Err(ApiError::conflict(format!(
                "STL asset_id {} has conflicting archive references",
                reference.asset_id
            )));
        }
        paths.insert(reference.archive_path.clone());
    }
    Ok(paths)
}

/// Capture each explicitly declared ImportedGeometry source into a portable
/// project asset. Existing references are treated as pins and are never
/// rewritten to match different bytes.
pub(crate) fn capture_and_bundle_stl_sources(
    scene: &mut SceneDocument,
    source_root: &Path,
    allowed_roots: &[PathBuf],
) -> Result<Vec<OpaqueAsset>, ApiError> {
    let mut assets = BTreeMap::<String, Vec<u8>>::new();
    let mut identities = BTreeMap::<String, (String, String)>::new();
    for object in &mut scene.objects {
        if object.geometry.geometry_kind != "ImportedGeometry" {
            if object.geometry.source_asset.is_some() {
                return Err(ApiError::bad_request(
                    "source_asset requires ImportedGeometry",
                ));
            }
            continue;
        }
        // Other legacy ImportedGeometry formats remain evidence in script
        // projects. This STL bundler must not narrow that persistence contract.
        let params = &object.geometry.geometry_params;
        let declares_stl = params
            .get("source")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|source| source.to_ascii_lowercase().ends_with(".stl"))
            || params
                .get("format")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|format| format.eq_ignore_ascii_case("stl"));
        if object.geometry.source_asset.is_none() && !declares_stl {
            continue;
        }
        if let Some(reference) = &object.geometry.source_asset {
            reference.validate().map_err(ApiError::bad_request)?;
        }
        let parameters =
            fullmag_authoring::imported_stl_parameters(&object.geometry.geometry_params)
                .map_err(ApiError::bad_request)?;
        let source = PathBuf::from(&parameters.source);
        let source = if source.is_absolute() {
            source
        } else {
            source_root.join(source)
        };
        let expected = object
            .geometry
            .source_asset
            .as_ref()
            .map(|reference| reference.content_sha256.as_str());
        let bytes = capture_stl_source(&source, allowed_roots, expected)?;
        fullmag_authoring::parse_stl_surface(&bytes).map_err(ApiError::bad_request)?;
        let digest = stl_digest(&bytes);
        let reference = match object.geometry.source_asset.take() {
            Some(reference) => {
                reference.validate().map_err(ApiError::bad_request)?;
                reference
            }
            None => fullmag_authoring::SceneImportedGeometryAssetRef {
                asset_id: format!("stl-sha256-{digest}"),
                content_sha256: digest.clone(),
                archive_path: format!("{IMPORTED_STL_ASSET_PREFIX}{digest}.stl"),
            },
        };
        if object.geometry.geometry_kind != "ImportedGeometry" {
            return Err(ApiError::bad_request(
                "source_asset requires ImportedGeometry",
            ));
        }
        let identity = (
            reference.content_sha256.clone(),
            reference.archive_path.clone(),
        );
        if identities
            .insert(reference.asset_id.clone(), identity.clone())
            .is_some_and(|prior| prior != identity)
        {
            return Err(ApiError::conflict(format!(
                "STL asset_id {} has conflicting archive references",
                reference.asset_id
            )));
        }
        if reference.content_sha256 != digest {
            return Err(ApiError::conflict(
                "STL source digest differs from the pinned project asset",
            ));
        }
        if assets
            .insert(reference.archive_path.clone(), bytes.clone())
            .is_some_and(|prior| prior != bytes)
        {
            return Err(ApiError::conflict(format!(
                "STL archive path {} refers to different bytes",
                reference.archive_path
            )));
        }
        object.geometry.geometry_params["source"] =
            serde_json::Value::String(reference.archive_path.clone());
        object.geometry.source_asset = Some(reference);
    }
    assets
        .into_iter()
        .map(|(path, bytes)| {
            OpaqueAsset::new(path, bytes, None)
                .map_err(|error| ApiError::bad_request(format!("invalid STL asset path: {error}")))
        })
        .collect()
}

/// Verify scene references using archive bytes only. No path from a project is
/// opened here; missing, changed, or malformed embedded STL is rejected.
pub(crate) fn validate_embedded_stl_assets(
    scene: &SceneDocument,
    project_assets: &[OpaqueAsset],
) -> Result<(), ApiError> {
    let _ = referenced_stl_paths(scene)?;
    for object in &scene.objects {
        let Some(reference) = &object.geometry.source_asset else {
            continue;
        };
        fullmag_authoring::imported_stl_parameters(&object.geometry.geometry_params)
            .map_err(ApiError::bad_request)?;
        let mut matches = project_assets
            .iter()
            .filter(|asset| asset.path() == reference.archive_path.as_str());
        let asset = matches.next().ok_or_else(|| {
            ApiError::bad_request(format!(
                "project is missing embedded STL asset {}",
                reference.archive_path
            ))
        })?;
        if matches.next().is_some() {
            return Err(ApiError::bad_request(format!(
                "project contains duplicate STL asset path {}",
                reference.archive_path
            )));
        }
        if stl_digest(asset.bytes()) != reference.content_sha256 {
            return Err(ApiError::conflict(format!(
                "embedded STL asset {} does not match its pinned SHA-256",
                reference.archive_path
            )));
        }
        fullmag_authoring::parse_stl_surface(asset.bytes()).map_err(ApiError::bad_request)?;
    }
    Ok(())
}

/// Return whether every opaque project asset is one of the imported STL
/// sources represented by the scene. Unknown assets remain evidence-only.
pub(crate) fn contains_only_referenced_stl_assets(
    scene: &SceneDocument,
    project_assets: &[OpaqueAsset],
) -> bool {
    let Ok(paths) = referenced_stl_paths(scene) else {
        return false;
    };
    validate_embedded_stl_assets(scene, project_assets).is_ok()
        && project_assets
            .iter()
            .all(|asset| paths.contains(asset.path()))
}

/// Resolve authoring references against the incoming archive first. Only
/// references whose bytes are missing are captured from their explicit local
/// source path; existing pins are verified and never recalculated.
pub(crate) fn resolve_authoring_stl_sources(
    scene: &mut SceneDocument,
    project_assets: &[OpaqueAsset],
    source_root: &Path,
    allowed_roots: &[PathBuf],
) -> Result<Vec<OpaqueAsset>, ApiError> {
    let _ = referenced_stl_paths(scene)?;
    let mut additions = BTreeMap::<String, Vec<u8>>::new();
    let mut path_digests = BTreeMap::<String, String>::new();
    for object in &mut scene.objects {
        let Some(reference) = &object.geometry.source_asset else {
            continue;
        };
        reference.validate().map_err(ApiError::bad_request)?;
        if object.geometry.geometry_kind != "ImportedGeometry" {
            return Err(ApiError::bad_request(
                "source_asset requires ImportedGeometry",
            ));
        }
        if path_digests
            .insert(
                reference.archive_path.clone(),
                reference.content_sha256.clone(),
            )
            .is_some_and(|prior| prior != reference.content_sha256)
        {
            return Err(ApiError::conflict(format!(
                "STL archive path {} has conflicting pinned digests",
                reference.archive_path
            )));
        }
        let parameters =
            fullmag_authoring::imported_stl_parameters(&object.geometry.geometry_params)
                .map_err(ApiError::bad_request)?;
        let source = PathBuf::from(&parameters.source);
        let source_path = if source.is_absolute() {
            source.clone()
        } else {
            source_root.join(&source)
        };
        let source_is_archive_path = parameters.source == reference.archive_path;
        let expected_cache_path = source_root
            .join("imported-stl-snapshots")
            .join(format!("{}.stl", reference.content_sha256));
        let source_is_known_cache =
            source_path == expected_cache_path || source == expected_cache_path;
        if !source_is_archive_path && parameters.source.starts_with("project/assets/") {
            return Err(ApiError::conflict(
                "ImportedGeometry source path differs from its pinned project asset path",
            ));
        }

        let mut matching_assets = project_assets
            .iter()
            .filter(|asset| asset.path() == reference.archive_path.as_str());
        let existing = matching_assets.next();
        if matching_assets.next().is_some() {
            return Err(ApiError::bad_request(format!(
                "project contains duplicate STL asset path {}",
                reference.archive_path
            )));
        }
        let bytes = if let Some(asset) = existing {
            if stl_digest(asset.bytes()) != reference.content_sha256 {
                return Err(ApiError::conflict(format!(
                    "embedded STL asset {} does not match its pinned SHA-256",
                    reference.archive_path
                )));
            }
            fullmag_authoring::parse_stl_surface(asset.bytes()).map_err(ApiError::bad_request)?;
            if !source_is_archive_path && !source_is_known_cache {
                let local = capture_stl_source(
                    &source_path,
                    allowed_roots,
                    Some(&reference.content_sha256),
                )?;
                fullmag_authoring::parse_stl_surface(&local).map_err(ApiError::bad_request)?;
            }
            asset.bytes().to_vec()
        } else {
            if source_is_archive_path || parameters.source.starts_with("project/assets/") {
                return Err(ApiError::bad_request(format!(
                    "project is missing embedded STL asset {}",
                    reference.archive_path
                )));
            }
            let bytes =
                capture_stl_source(&source_path, allowed_roots, Some(&reference.content_sha256))?;
            fullmag_authoring::parse_stl_surface(&bytes).map_err(ApiError::bad_request)?;
            if additions
                .insert(reference.archive_path.clone(), bytes.clone())
                .is_some_and(|prior| prior != bytes)
            {
                return Err(ApiError::conflict(format!(
                    "STL archive path {} refers to different bytes",
                    reference.archive_path
                )));
            }
            bytes
        };
        if let Some(prior) = additions.get(&reference.archive_path) {
            if prior != &bytes {
                return Err(ApiError::conflict(format!(
                    "STL archive path {} refers to different bytes",
                    reference.archive_path
                )));
            }
        }
        object.geometry.geometry_params["source"] =
            serde_json::Value::String(reference.archive_path.clone());
    }
    additions
        .into_iter()
        .map(|(path, bytes)| {
            OpaqueAsset::new(path, bytes, None)
                .map_err(|error| ApiError::bad_request(format!("invalid STL asset path: {error}")))
        })
        .collect()
}

/// Materialize only verified archive bytes under the current workspace and
/// redirect the activation scene to the private content-addressed copy.
pub(crate) fn materialize_embedded_stl_sources(
    scene: &mut SceneDocument,
    project_assets: &[OpaqueAsset],
    workspace_root: &Path,
) -> Result<(), ApiError> {
    validate_embedded_stl_assets(scene, project_assets)?;
    for object in &mut scene.objects {
        let Some(reference) = &object.geometry.source_asset else {
            continue;
        };
        let asset = project_assets
            .iter()
            .find(|asset| asset.path() == reference.archive_path.as_str())
            .ok_or_else(|| ApiError::bad_request("project is missing an embedded STL asset"))?;
        let snapshot = publish_snapshot(
            &workspace_root.join("imported-stl-snapshots"),
            &reference.content_sha256,
            asset.bytes(),
        )?;
        object.geometry.geometry_params["source"] =
            serde_json::Value::String(snapshot.to_string_lossy().into_owned());
    }
    Ok(())
}

/// Apply only imported-geometry source fields to a raw scene, retaining all
/// unrelated wire values and extension fields verbatim.
pub(crate) fn patch_scene_asset_fields(
    raw_scene: &mut serde_json::Value,
    scene: &SceneDocument,
) -> Result<(), ApiError> {
    if !scene
        .objects
        .iter()
        .any(|object| object.geometry.source_asset.is_some())
    {
        return Ok(());
    }
    let objects = raw_scene
        .get_mut("objects")
        .and_then(serde_json::Value::as_array_mut)
        .ok_or_else(|| ApiError::bad_request("scene objects must be an array"))?;
    if objects.len() != scene.objects.len() {
        return Err(ApiError::bad_request(
            "scene object list changed while resolving imported STL assets",
        ));
    }
    for (raw_object, object) in objects.iter_mut().zip(&scene.objects) {
        let Some(reference) = &object.geometry.source_asset else {
            continue;
        };
        let geometry = raw_object
            .get_mut("geometry")
            .and_then(serde_json::Value::as_object_mut)
            .ok_or_else(|| ApiError::bad_request("scene geometry must be an object"))?;
        let parameters = geometry
            .entry("geometry_params")
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
            .ok_or_else(|| {
                ApiError::bad_request("ImportedGeometry parameters must be an object")
            })?;
        parameters.insert(
            "source".into(),
            serde_json::Value::String(
                object.geometry.geometry_params["source"]
                    .as_str()
                    .ok_or_else(|| {
                        ApiError::bad_request("ImportedGeometry source must be a string")
                    })?
                    .to_string(),
            ),
        );
        geometry.insert(
            "source_asset".into(),
            serde_json::to_value(reference).map_err(|error| {
                ApiError::internal(format!("encode STL asset reference: {error}"))
            })?,
        );
    }
    Ok(())
}

pub(crate) fn snapshot_pinned_stl_sources(
    repo_root: &Path,
    workspace_root: &Path,
    asset_root: Option<&Path>,
    scene: &SceneDocument,
) -> Result<SceneDocument, ApiError> {
    let mut frozen = scene.clone();
    let base = asset_root.unwrap_or(workspace_root);
    let roots = vec![
        repo_root.to_path_buf(),
        workspace_root.to_path_buf(),
        base.to_path_buf(),
        PathBuf::from("/user-data"),
    ];
    for object in &mut frozen.objects {
        let Some(reference) = &object.geometry.source_asset else {
            continue;
        };
        reference.validate().map_err(ApiError::bad_request)?;
        if object.geometry.geometry_kind != "ImportedGeometry" {
            return Err(ApiError::bad_request(
                "source_asset requires ImportedGeometry",
            ));
        }
        let parameters =
            fullmag_authoring::imported_stl_parameters(&object.geometry.geometry_params)
                .map_err(ApiError::bad_request)?;
        let source = PathBuf::from(parameters.source);
        let source = if source.is_absolute() {
            source
        } else {
            base.join(source)
        };
        let bytes = capture_stl_source(&source, &roots, Some(&reference.content_sha256))?;
        let path = publish_snapshot(
            &workspace_root.join("imported-stl-snapshots"),
            &reference.content_sha256,
            &bytes,
        )?;
        object.geometry.geometry_params["source"] = serde_json::json!(path.to_string_lossy());
    }
    Ok(frozen)
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_application::{
        FileProjectRepository, ProjectEnvelope, ProjectId, ProjectRepository, ProjectSource,
        RawJsonEnvelope,
    };
    use serde_json::json;

    const TRIANGLE_STL: &[u8] =
        b"solid triangle\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid triangle\n";

    fn imported_scene(sources: &[PathBuf]) -> SceneDocument {
        let objects = sources
            .iter()
            .enumerate()
            .map(|(index, source)| {
                json!({
                    "id": format!("body-{index}"),
                    "name": format!("body-{index}"),
                    "material_ref": "",
                    "geometry": {
                        "geometry_kind": "ImportedGeometry",
                        "geometry_params": {"source": source.to_string_lossy()}
                    }
                })
            })
            .collect::<Vec<_>>();
        serde_json::from_value(json!({"version":"scene.v2","revision":3,"objects":objects}))
            .unwrap()
    }

    fn project_envelope(scene: &SceneDocument, assets: Vec<OpaqueAsset>) -> ProjectEnvelope {
        let mut envelope =
            ProjectEnvelope::blank(ProjectId::parse("project-stl-portable").unwrap(), "STL")
                .unwrap();
        envelope
            .replace_scene(
                RawJsonEnvelope::from_value(serde_json::to_value(scene).unwrap()).unwrap(),
            )
            .unwrap();
        envelope.assets = assets;
        envelope
    }

    fn pin_first_source(scene: &mut SceneDocument, archive_path: &str, bytes: &[u8]) {
        scene.objects[0].geometry.source_asset =
            Some(fullmag_authoring::SceneImportedGeometryAssetRef {
                asset_id: format!("stl-sha256-{}", stl_digest(bytes)),
                content_sha256: stl_digest(bytes),
                archive_path: archive_path.to_string(),
            });
    }

    #[test]
    fn legacy_non_stl_script_imports_are_retained_without_external_reads() {
        let mut scene =
            imported_scene(&[PathBuf::from("missing.step"), PathBuf::from("missing.npz")]);
        let original = scene.clone();
        let assets =
            capture_and_bundle_stl_sources(&mut scene, Path::new("/not-a-source-root"), &[])
                .unwrap();
        assert!(assets.is_empty());
        assert_eq!(scene, original);
    }

    #[test]
    fn authoring_update_bundles_a_new_upload_and_preserves_existing_archive_assets() {
        let root =
            std::env::temp_dir().join(format!("fullmag-stl-upload-{}", crate::uuid_v4_hex()));
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let upload = workspace.join("uploaded.stl");
        fs::write(&upload, TRIANGLE_STL).unwrap();
        let archive_path = format!(
            "{IMPORTED_STL_ASSET_PREFIX}{}.stl",
            stl_digest(TRIANGLE_STL)
        );
        let mut scene = imported_scene(std::slice::from_ref(&upload));
        pin_first_source(&mut scene, &archive_path, TRIANGLE_STL);
        let unrelated =
            OpaqueAsset::new("project/assets/retained.bin", b"retain me".to_vec(), None).unwrap();

        let additions = resolve_authoring_stl_sources(
            &mut scene,
            std::slice::from_ref(&unrelated),
            &workspace,
            &[workspace.clone()],
        )
        .unwrap();

        assert_eq!(additions.len(), 1);
        assert_eq!(additions[0].path(), archive_path);
        assert_eq!(additions[0].bytes(), TRIANGLE_STL);
        assert_eq!(
            scene.objects[0].geometry.geometry_params["source"],
            archive_path
        );
        let mut assets = vec![unrelated];
        assets.extend(additions);
        let repository = FileProjectRepository::new();
        let archive = repository
            .encode_archive(&project_envelope(&scene, assets))
            .unwrap();
        let decoded = repository
            .open(ProjectSource::Bytes {
                display_name: "uploaded.fms".into(),
                bytes: archive,
            })
            .unwrap()
            .envelope;
        let decoded_scene: SceneDocument =
            serde_json::from_value(decoded.definition.scene.value().clone()).unwrap();
        validate_embedded_stl_assets(&decoded_scene, &decoded.assets).unwrap();
        assert!(decoded
            .assets
            .iter()
            .any(|asset| asset.path() == "project/assets/retained.bin"));

        fs::remove_file(upload).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn authoring_update_uses_existing_archive_bytes_without_original_file() {
        let root =
            std::env::temp_dir().join(format!("fullmag-stl-existing-{}", crate::uuid_v4_hex()));
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let original = workspace.join("original.stl");
        fs::write(&original, TRIANGLE_STL).unwrap();
        let archive_path = format!(
            "{IMPORTED_STL_ASSET_PREFIX}{}.stl",
            stl_digest(TRIANGLE_STL)
        );
        let mut scene = imported_scene(std::slice::from_ref(&original));
        pin_first_source(&mut scene, &archive_path, TRIANGLE_STL);
        let embedded = OpaqueAsset::new(archive_path.clone(), TRIANGLE_STL.to_vec(), None).unwrap();
        scene.objects[0].geometry.geometry_params["source"] = json!(archive_path);
        fs::remove_file(&original).unwrap();

        let additions = resolve_authoring_stl_sources(
            &mut scene,
            std::slice::from_ref(&embedded),
            &workspace,
            &[workspace.clone()],
        )
        .unwrap();
        assert!(additions.is_empty());
        assert_eq!(
            scene.objects[0].geometry.geometry_params["source"],
            scene.objects[0]
                .geometry
                .source_asset
                .as_ref()
                .unwrap()
                .archive_path
        );
        validate_embedded_stl_assets(&scene, &[embedded]).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn authoring_update_rejects_a_local_source_changed_behind_an_existing_pin() {
        let root =
            std::env::temp_dir().join(format!("fullmag-stl-edited-{}", crate::uuid_v4_hex()));
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let changed = workspace.join("changed.stl");
        let changed_bytes = b"solid changed\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 2 0 0\nvertex 0 2 0\nendloop\nendfacet\nendsolid changed\n";
        fs::write(&changed, changed_bytes).unwrap();
        let archive_path = format!(
            "{IMPORTED_STL_ASSET_PREFIX}{}.stl",
            stl_digest(TRIANGLE_STL)
        );
        let mut scene = imported_scene(std::slice::from_ref(&changed));
        pin_first_source(&mut scene, &archive_path, TRIANGLE_STL);
        let embedded = OpaqueAsset::new(archive_path, TRIANGLE_STL.to_vec(), None).unwrap();

        assert!(resolve_authoring_stl_sources(
            &mut scene,
            std::slice::from_ref(&embedded),
            &workspace,
            &[workspace.clone()],
        )
        .is_err());
        assert_eq!(
            scene.objects[0].geometry.geometry_params["source"],
            changed.to_string_lossy().as_ref()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn packed_stl_round_trips_through_fms_and_materializes_without_original_source() {
        let root =
            std::env::temp_dir().join(format!("fullmag-stl-project-{}", crate::uuid_v4_hex()));
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let original = workspace.join("original.stl");
        fs::write(&original, TRIANGLE_STL).unwrap();

        let mut scene = imported_scene(std::slice::from_ref(&original));
        let assets =
            capture_and_bundle_stl_sources(&mut scene, &workspace, &[workspace.clone()]).unwrap();
        assert_eq!(assets.len(), 1);
        let reference = scene.objects[0].geometry.source_asset.as_ref().unwrap();
        assert_eq!(
            scene.objects[0].geometry.geometry_params["source"],
            reference.archive_path
        );
        let repository = FileProjectRepository::new();
        let archive = repository
            .encode_archive(&project_envelope(&scene, assets))
            .unwrap();
        let decoded = repository
            .open(ProjectSource::Bytes {
                display_name: "portable.fms".into(),
                bytes: archive,
            })
            .unwrap()
            .envelope;

        fs::remove_file(&original).unwrap();
        let mut activation_scene =
            serde_json::from_value(decoded.definition.scene.value().clone()).unwrap();
        materialize_embedded_stl_sources(&mut activation_scene, &decoded.assets, &workspace)
            .unwrap();
        let materialized = PathBuf::from(
            activation_scene.objects[0].geometry.geometry_params["source"]
                .as_str()
                .unwrap(),
        );
        assert_ne!(materialized, original);
        assert_eq!(fs::read(&materialized).unwrap(), TRIANGLE_STL);
        assert!(fullmag_authoring::parse_stl_surface(&fs::read(&materialized).unwrap()).is_ok());

        let mut permissions = fs::metadata(&materialized).unwrap().permissions();
        permissions.set_readonly(false);
        fs::set_permissions(&materialized, permissions).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_or_changed_project_stl_bytes_are_rejected_without_path_reads() {
        let root =
            std::env::temp_dir().join(format!("fullmag-stl-verify-{}", crate::uuid_v4_hex()));
        fs::create_dir_all(&root).unwrap();
        let original = root.join("source.stl");
        fs::write(&original, TRIANGLE_STL).unwrap();
        let mut scene = imported_scene(std::slice::from_ref(&original));
        let assets = capture_and_bundle_stl_sources(&mut scene, &root, &[root.clone()]).unwrap();
        fs::remove_file(&original).unwrap();

        assert!(validate_embedded_stl_assets(&scene, &[]).is_err());
        let mut changed = TRIANGLE_STL.to_vec();
        changed.push(b' ');
        let replacement = OpaqueAsset::new(
            assets[0].path(),
            changed,
            assets[0].media_type().map(str::to_owned),
        )
        .unwrap();
        assert!(validate_embedded_stl_assets(&scene, &[replacement.clone()]).is_err());
        assert!(materialize_embedded_stl_sources(&mut scene, &[replacement], &root).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn equal_stl_sources_share_one_content_addressed_project_asset() {
        let root = std::env::temp_dir().join(format!("fullmag-stl-dedup-{}", crate::uuid_v4_hex()));
        fs::create_dir_all(&root).unwrap();
        let first = root.join("first.stl");
        let second = root.join("second.stl");
        fs::write(&first, TRIANGLE_STL).unwrap();
        fs::write(&second, TRIANGLE_STL).unwrap();
        let mut scene = imported_scene(&[first, second]);

        let assets = capture_and_bundle_stl_sources(&mut scene, &root, &[root.clone()]).unwrap();

        assert_eq!(assets.len(), 1);
        assert_eq!(
            scene.objects[0].geometry.source_asset,
            scene.objects[1].geometry.source_asset
        );
        assert_eq!(assets[0].bytes(), TRIANGLE_STL);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn relative_imports_use_the_logical_script_directory() {
        let root = std::env::temp_dir().join("fullmag-source-root-contract");
        let workspace = root.join("workspace/current");
        let parent = root.join("repo/examples");
        let script = parent.join("source.py");
        assert_eq!(
            script_asset_root(script.to_str().unwrap(), &workspace),
            parent
        );
        assert_eq!(script_asset_root("", &workspace), workspace);
    }

    #[test]
    fn replaced_source_is_rejected_and_meshing_reads_the_frozen_copy() {
        let root =
            std::env::temp_dir().join(format!("fullmag-stl-capture-{}", crate::uuid_v4_hex()));
        fs::create_dir(&root).unwrap();
        let source = root.join("body.stl");
        let tetrahedron = |scale: f32| {
            let vertices = [
                [0.0_f32, 0.0, 0.0],
                [scale, 0.0, 0.0],
                [0.0, scale, 0.0],
                [0.0, 0.0, scale],
            ];
            let mut bytes = vec![0_u8; 80];
            bytes.extend_from_slice(&4_u32.to_le_bytes());
            for face in [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]] {
                bytes.extend_from_slice(&[0_u8; 12]);
                for index in face {
                    for coordinate in vertices[index] {
                        bytes.extend_from_slice(&coordinate.to_le_bytes());
                    }
                }
                bytes.extend_from_slice(&[0_u8; 2]);
            }
            bytes
        };
        let original = tetrahedron(1.0);
        let replacement = tetrahedron(2.0);
        assert!(fullmag_authoring::parse_stl_surface(&original).is_ok());
        assert!(fullmag_authoring::parse_stl_surface(&replacement).is_ok());
        fs::write(&source, &original).unwrap();
        let digest = format!("{:x}", Sha256::digest(&original));
        let mut scene = SceneDocument::default();
        scene.objects.push(
            serde_json::from_value(json!({
                "id": "body", "name": "body", "material_ref": "",
                "geometry": {"geometry_kind": "ImportedGeometry",
                    "geometry_params": {"source": source},
                    "source_asset": {"asset_id": "asset-stl", "content_sha256": digest,
                        "archive_path": "project/assets/body.stl"}}
            }))
            .unwrap(),
        );
        let frozen = snapshot_pinned_stl_sources(&root, &root, None, &scene).unwrap();
        let snapshot = PathBuf::from(
            frozen.objects[0].geometry.geometry_params["source"]
                .as_str()
                .unwrap(),
        );
        assert_ne!(snapshot, source);
        fs::write(&source, replacement).unwrap();
        assert_eq!(fs::read(&snapshot).unwrap(), original);
        assert!(snapshot_pinned_stl_sources(&root, &root, None, &scene).is_err());
        assert_eq!(
            scene.objects[0].geometry.geometry_params["source"],
            json!(source)
        );
        let mut permissions = fs::metadata(&snapshot).unwrap().permissions();
        permissions.set_readonly(false);
        fs::set_permissions(&snapshot, permissions).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}
