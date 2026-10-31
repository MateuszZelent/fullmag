"""Contract tests for the explicitly gated private group build cache."""
from __future__ import annotations

from contextlib import nullcontext, redirect_stderr
import hashlib
import io
import importlib
import json
import os
from pathlib import Path
import stat
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
HELPERS = ROOT / "docker" / "all-in-one"
sys.path.insert(0, str(HELPERS))

import backend_dev as backend
import backend_group_cache_cleanup as group_cleanup

GROUP_STORAGE_MODE = "group-volume-v1"
CACHE_RECEIPT_SCHEMA = "fullmag.direct-compose.backend-volume-cache-receipt.v1"
OWNER_SCHEMA = "fullmag.backend-build-cache-owner.v2"


def _fixture_root(path: str | os.PathLike[str]) -> Path:
    """Resolve TEMP aliases/junctions before constructing related targets."""
    return Path(path).resolve(strict=True)


def _cache_identity(root: Path, package_root: Path | None = None) -> dict:
    root = Path(root).resolve()
    build_root = (root / "build").resolve()
    package_root = Path(package_root or (root / "package")).resolve()
    control_root = (root / "control").resolve()
    unit_key = "a" * 64
    return {
        "schema": CACHE_RECEIPT_SCHEMA,
        "state": "ready",
        "cache_schema": "fullmag.backend-build-cache.v2",
        "storage": "docker-named-volume",
        "unit_key": unit_key,
        "owner_id": unit_key,
        "volume_names": {
            "build": "fullmag-build-control-worktree",
            "package": "fullmag-packages-global",
            "control": "fullmag-build-control-worktree",
        },
        "targets": {
            "build": str(build_root),
            "package": str(package_root),
            "control": str(control_root),
            "receipt": str(control_root / "backend" / "backend-volume-cache-receipt.json"),
        },
    }


def _identity_environment(identity: dict) -> dict[str, str]:
    unit_key = identity["unit_key"]
    return {
        "FULLMAG_PRIVATE_GROUP_STORAGE": GROUP_STORAGE_MODE,
        "FULLMAG_SHARED_BACKEND_UNIT_KEY": unit_key,
        "FULLMAG_SHARED_BACKEND_GROUP": f"groups/{unit_key}",
        "FULLMAG_SHARED_BACKEND_VOLUME": identity["volume_names"]["package"],
    }


def _owned_workspace(root: Path, identity: dict) -> Path:
    build_root = Path(identity["targets"]["build"])
    build_root.mkdir(parents=True)
    marker = {
        "schema": OWNER_SCHEMA,
        "state": "owned",
        "unit_key": identity["unit_key"],
        "owner_id": identity["owner_id"],
        "role": "build",
        "volume_name": identity["volume_names"]["build"],
        "uid": 65532,
        "gid": 65532,
    }
    marker_raw = json.dumps(marker, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode("utf-8")
    (build_root / ".fullmag-backend-cache-owner.json").write_bytes(marker_raw + b"\n")
    probe = b"fullmag-cache-readback:" + hashlib.sha256(marker_raw).hexdigest().encode("ascii")
    (build_root / ".fullmag-backend-cache-readback").write_bytes(probe)
    control_root = Path(identity["targets"]["control"])
    (control_root / "backend").mkdir(parents=True, exist_ok=True)
    workspace = build_root / "workspace"
    workspace.mkdir()
    (workspace / ".fullmag-direct-backend-owner.json").write_text(
        json.dumps({
            "schema": "fullmag.direct-compose.backend-workspace.v1",
            "state": "ready",
            "source_digest": "b" * 64,
        }),
        encoding="utf-8",
    )
    compiled = workspace / ".fullmag-build" / "cargo-targets" / "direct" / "backend-dev"
    compiled.mkdir(parents=True)
    (compiled / "incremental.bin").write_bytes(b"compiled cache")
    (workspace / ".fullmag-cargo" / "registry").mkdir(parents=True)
    (workspace / ".fullmag-cargo" / "registry" / "shared-package.bin").write_bytes(b"shared deps")
    (workspace / ".fullmag-rustup").mkdir()
    (workspace / ".fullmag-rustup" / "toolchain.marker").write_text("keep", encoding="utf-8")
    (workspace / "source.rs").write_text("source", encoding="utf-8")
    (workspace / "results.zarr").mkdir()
    (workspace / "results.zarr" / "field.bin").write_bytes(b"scientific result")
    (workspace / ".fullmag" / "local").mkdir(parents=True)
    (workspace / ".fullmag" / "local" / "build.log").write_text("diagnostic", encoding="utf-8")
    return workspace


class BackendGroupCacheCleanupTests(unittest.TestCase):
    @staticmethod
    def _start_fixture(root: Path):
        root = _fixture_root(root)
        fixture_module = importlib.import_module("test_docker_backend_dev")
        fixture = fixture_module.BackendPackageTests(
            "test_start_prepares_and_serves_in_one_container"
        )
        package, records = fixture._published_package(root)
        manifest_path, manifest = fixture._live_manifest(root)
        toolchain = fixture._toolchain_fixture()
        backend._write_json(
            package / "backend-build-receipt.json",
            fixture._receipt_for_manifest(records, manifest, toolchain),
            "group cleanup start fixture receipt",
        )
        identity = _cache_identity(root, package)
        workspace = _owned_workspace(root, identity)
        return fixture, package, manifest_path, manifest, toolchain, identity, workspace

    @staticmethod
    def _tree_snapshot(root: Path, *, exclude_development: bool = False) -> dict[str, tuple]:
        snapshot = {}
        for path in sorted(root.rglob("*")):
            relative = path.relative_to(root)
            if exclude_development and relative.parts[0] == backend.PACKAGE_DEVELOPMENT_DIRNAME:
                continue
            metadata = path.lstat()
            if stat.S_ISLNK(metadata.st_mode):
                value = ("link", os.readlink(path))
            elif stat.S_ISDIR(metadata.st_mode):
                value = ("directory", stat.S_IMODE(metadata.st_mode))
            else:
                value = ("file", stat.S_IMODE(metadata.st_mode), path.read_bytes())
            snapshot[relative.as_posix()] = value
        return snapshot

    def _install_cache_cleaner_spy(self, events, protected_workspace, package):
        cleaner = backend._cleanup_group_build_outputs
        protected = (
            "source.rs",
            "results.zarr/field.bin",
            ".fullmag/local/build.log",
            ".fullmag-cargo/registry/shared-package.bin",
            ".fullmag-rustup/toolchain.marker",
        )

        def call(workspace, *, phase):
            package_before = self._tree_snapshot(package)
            protected_before = {
                relative: (protected_workspace / relative).read_bytes()
                for relative in protected
            }
            result = cleaner(workspace, phase=phase)
            self.assertFalse((protected_workspace / ".fullmag-build").exists())
            self.assertEqual(package_before, self._tree_snapshot(package))
            self.assertEqual(
                protected_before,
                {relative: (protected_workspace / relative).read_bytes() for relative in protected},
            )
            events.append(phase)
            return result

        return patch.object(backend, "_cleanup_group_build_outputs", side_effect=call)

    @staticmethod
    def _simulate_candidate_build(fixture, root, candidate, package, build_root):
        root = _fixture_root(root)
        workspace = fixture._package_workspace(root / "candidate-workspace")
        records = fixture._copy_into_marked_candidate(
            workspace, candidate, package, build_root
        )
        backend._write_json(
            candidate / "backend-build-receipt.json",
            {
                "schema": backend.RECEIPT_SCHEMA,
                "state": "succeeded",
                "execution_lanes": {lane: {"status": "compiled"} for lane in backend.LANES},
                "artifacts": records,
            },
            "simulated group build candidate receipt",
        )

    def setUp(self) -> None:
        if os.name == "nt":
            volume_patcher = patch.object(group_cleanup, "_same_volume", return_value=True)
            volume_patcher.start()
            self.addCleanup(volume_patcher.stop)
            fsync_patcher = patch.object(backend, "_fsync_directory", return_value=None)
            fsync_patcher.start()
            self.addCleanup(fsync_patcher.stop)
            tree_fsync_patcher = patch.object(backend, "_fsync_owned_tree", return_value=None)
            tree_fsync_patcher.start()
            self.addCleanup(tree_fsync_patcher.stop)

            def read_regular(path, _name, maximum):
                path = Path(path)
                raw = path.read_bytes()
                if len(raw) > maximum:
                    backend._fail("test fixture record exceeds its bound")
                return raw, path.stat()

            read_patcher = patch.object(backend, "_read_regular", side_effect=read_regular)
            read_patcher.start()
            self.addCleanup(read_patcher.stop)

    @unittest.skipIf(os.name == "nt", "backend start requires POSIX flock")
    def test_actual_group_build_cleans_before_make_and_after_verified_publication(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = _fixture_root(temporary)
            fixture, package, manifest_path, _manifest, toolchain, identity, workspace = (
                self._start_fixture(root)
            )
            build_root = Path(identity["targets"]["build"])
            provenance = root / "runtime-provenance.json"
            events = []
            original_package = backend.PACKAGE_ROOT
            original_provenance = backend.PROVENANCE_PATH

            def fake_prepare_locked(*args, on_actual_build=None):
                candidate = args[2]
                backend._cleanup_group_build_outputs(workspace, phase="pre-build")
                self.assertFalse((workspace / ".fullmag-build").exists())
                self.assertIsNotNone(on_actual_build)
                on_actual_build()
                events.append("make")
                compiled = workspace / ".fullmag-build" / "new" / "compiler-output.bin"
                compiled.parent.mkdir(parents=True)
                compiled.write_bytes(b"new compiler output")
                self._simulate_candidate_build(
                    fixture, root, candidate, package, build_root
                )
                return 0

            try:
                with (
                    patch.object(backend, "PACKAGE_ROOT", package),
                    patch.object(backend, "PROVENANCE_PATH", provenance),
                    patch.dict(
                        os.environ,
                        {
                            **_identity_environment(identity),
                            "FULLMAG_BACKEND_CARGO_PROFILE": "backend-dev",
                        },
                        clear=True,
                    ),
                    patch.object(backend, "_backend_cache_receipt", return_value=identity),
                    patch.object(backend, "_toolchain_identity", return_value=(toolchain["image_id"], toolchain)),
                    patch.object(backend, "_capture_start_manifest", return_value=manifest_path),
                    patch.object(backend, "_package_matches_fresh_live_manifest", return_value=False),
                    patch.object(backend, "_preflight_candidate_storage"),
                    patch.object(backend, "_prepare_locked", side_effect=fake_prepare_locked),
                    patch.object(backend, "_publish_runtime_provenance", side_effect=lambda _output: events.append("provenance")),
                    patch.object(backend, "_serve", side_effect=lambda _extra: events.append("serve") or 0),
                    self._install_cache_cleaner_spy(events, workspace, package),
                    patch.object(backend, "_log_phase"),
                ):
                    result = backend.main(
                        ["start", "--output", str(package), "--build-root", str(build_root)]
                    )

                self.assertEqual(result, 0)
                self.assertEqual(events, ["pre-build", "make", "provenance", "post-publish", "serve"])
                self.assertFalse((workspace / ".fullmag-build").exists())
                backend._validated_package(package, "published group package", exclude_development_control=True)
                cleanup_receipt = Path(identity["targets"]["control"]) / "backend" / "group-build-cleanup.json"
                self.assertEqual(json.loads(cleanup_receipt.read_text(encoding="utf-8"))["phase"], "post-publish")
            finally:
                backend.PACKAGE_ROOT = original_package
                backend.PROVENANCE_PATH = original_provenance

    @unittest.skipIf(os.name == "nt", "backend start requires POSIX flock")
    def test_group_current_package_cache_hit_skips_pre_and_post_cleanup(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = _fixture_root(temporary)
            _fixture, package, manifest_path, _manifest, toolchain, identity, _workspace = (
                self._start_fixture(root)
            )
            build_root = Path(identity["targets"]["build"])
            provenance = root / "runtime-provenance.json"
            original_package = backend.PACKAGE_ROOT
            original_provenance = backend.PROVENANCE_PATH
            try:
                with (
                    patch.object(backend, "PACKAGE_ROOT", package),
                    patch.object(backend, "PROVENANCE_PATH", provenance),
                    patch.dict(
                        os.environ,
                        {
                            **_identity_environment(identity),
                            "FULLMAG_BACKEND_CARGO_PROFILE": "backend-dev",
                        },
                        clear=True,
                    ),
                    patch.object(backend, "_backend_cache_receipt", return_value=identity),
                    patch.object(backend, "_toolchain_identity", return_value=(toolchain["image_id"], toolchain)),
                    patch.object(backend, "_capture_start_manifest", return_value=manifest_path),
                    patch.object(backend, "_cleanup_group_build_outputs") as cleanup,
                    patch.object(backend, "_prepare_locked") as prepare,
                    patch.object(backend, "_publish_runtime_provenance"),
                    patch.object(backend, "_serve", return_value=0) as serve,
                    patch.object(backend, "_log_phase"),
                ):
                    result = backend.main(
                        ["start", "--output", str(package), "--build-root", str(build_root)]
                    )
                self.assertEqual(result, 0)
                cleanup.assert_not_called()
                prepare.assert_not_called()
                serve.assert_called_once_with([])
            finally:
                backend.PACKAGE_ROOT = original_package
                backend.PROVENANCE_PATH = original_provenance

    @unittest.skipIf(os.name == "nt", "backend start requires POSIX flock")
    def test_group_build_publication_failure_keeps_only_prebuild_cleanup(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = _fixture_root(temporary)
            fixture, package, manifest_path, _manifest, toolchain, identity, workspace = (
                self._start_fixture(root)
            )
            build_root = Path(identity["targets"]["build"])
            provenance = root / "runtime-provenance.json"
            events = []
            package_before = self._tree_snapshot(package, exclude_development=True)
            original_package = backend.PACKAGE_ROOT
            original_provenance = backend.PROVENANCE_PATH

            def fake_prepare_locked(*args, on_actual_build=None):
                candidate = args[2]
                backend._cleanup_group_build_outputs(workspace, phase="pre-build")
                self.assertIsNotNone(on_actual_build)
                on_actual_build()
                events.append("make")
                compiled = workspace / ".fullmag-build" / "new" / "compiler-output.bin"
                compiled.parent.mkdir(parents=True)
                compiled.write_bytes(b"new compiler output")
                self._simulate_candidate_build(
                    fixture, root, candidate, package, build_root
                )
                return 0

            try:
                with (
                    patch.object(backend, "PACKAGE_ROOT", package),
                    patch.object(backend, "PROVENANCE_PATH", provenance),
                    patch.dict(
                        os.environ,
                        {
                            **_identity_environment(identity),
                            "FULLMAG_BACKEND_CARGO_PROFILE": "backend-dev",
                        },
                        clear=True,
                    ),
                    patch.object(backend, "_backend_cache_receipt", return_value=identity),
                    patch.object(backend, "_toolchain_identity", return_value=(toolchain["image_id"], toolchain)),
                    patch.object(backend, "_capture_start_manifest", return_value=manifest_path),
                    patch.object(backend, "_package_matches_fresh_live_manifest", return_value=False),
                    patch.object(backend, "_preflight_candidate_storage"),
                    patch.object(backend, "_prepare_locked", side_effect=fake_prepare_locked),
                    patch.object(backend, "_rotate_package", side_effect=backend.BackendBuildError("injected publication failure")),
                    patch.object(backend, "_publish_runtime_provenance") as publish,
                    patch.object(backend, "_serve") as serve,
                    self._install_cache_cleaner_spy(events, workspace, package),
                    patch.object(backend, "_log_phase"),
                ):
                    with redirect_stderr(io.StringIO()):
                        result = backend.main(
                            ["start", "--output", str(package), "--build-root", str(build_root)]
                        )

                self.assertEqual(result, 2)
                self.assertEqual(events, ["pre-build", "make"])
                self.assertEqual(package_before, self._tree_snapshot(package, exclude_development=True))
                self.assertEqual((workspace / ".fullmag-build" / "new" / "compiler-output.bin").read_bytes(), b"new compiler output")
                self.assertEqual((workspace / "source.rs").read_text(encoding="utf-8"), "source")
                self.assertEqual((workspace / "results.zarr" / "field.bin").read_bytes(), b"scientific result")
                publish.assert_not_called()
                serve.assert_not_called()
            finally:
                backend.PACKAGE_ROOT = original_package
                backend.PROVENANCE_PATH = original_provenance

    def test_prepare_cleanup_precedes_make_and_reports_actual_start_callback(self) -> None:
        source = (HELPERS / "backend_dev.py").read_text(encoding="utf-8")
        prepare_start = source.index("def _prepare_locked(")
        prepare_end = source.index("def _publish_completed_build(", prepare_start)
        prepare = source[prepare_start:prepare_end]
        cleanup = prepare.index("_cleanup_group_build_outputs(")
        make = prepare.index("_run_canonical_make(")
        callback = prepare.index("on_actual_build()", make - 500, make + 300)
        self.assertLess(cleanup, callback)
        self.assertLess(callback, make)

    def test_removes_only_compiler_root_and_writes_completion_receipt(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = _fixture_root(temporary)
            identity = _cache_identity(root)
            workspace = _owned_workspace(root, identity)
            compiled_bytes = sum(path.stat().st_size for path in (workspace / ".fullmag-build").rglob("*") if path.is_file())

            with patch.dict(os.environ, _identity_environment(identity)):
                result = group_cleanup.cleanup_group_compiler_outputs(
                    workspace, cache_identity=identity
                )

            self.assertFalse((workspace / ".fullmag-build").exists())
            self.assertTrue((workspace / "source.rs").is_file())
            self.assertEqual((workspace / "results.zarr" / "field.bin").read_bytes(), b"scientific result")
            self.assertEqual((workspace / ".fullmag" / "local" / "build.log").read_text(encoding="utf-8"), "diagnostic")
            self.assertTrue((workspace / ".fullmag-cargo" / "registry" / "shared-package.bin").is_file())
            self.assertTrue((workspace / ".fullmag-rustup" / "toolchain.marker").is_file())
            self.assertEqual(result["state"], "completed")
            self.assertEqual(result["removed_bytes"], compiled_bytes)
            receipt = json.loads(Path(result["receipt_path"]).read_text(encoding="utf-8"))
            self.assertEqual(receipt["unit_key"], identity["unit_key"])
            self.assertEqual(receipt["build_volume"], identity["volume_names"]["build"])
            self.assertEqual(receipt["removed_paths"], [".fullmag-build"])

    def test_internal_symlink_is_unlinked_without_deleting_its_external_target(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = _fixture_root(temporary)
            identity = _cache_identity(root)
            workspace = _owned_workspace(root, identity)
            outside = root / "outside.bin"
            outside.write_bytes(b"outside")
            (workspace / ".fullmag-build" / "escape").symlink_to(outside)

            with patch.dict(os.environ, _identity_environment(identity)):
                result = group_cleanup.cleanup_group_compiler_outputs(
                    workspace, cache_identity=identity
                )

            self.assertFalse((workspace / ".fullmag-build").exists())
            self.assertEqual(outside.read_bytes(), b"outside")
            self.assertEqual(result["state"], "completed")

    def test_compiler_root_symlink_is_rejected_without_touching_target(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = _fixture_root(temporary)
            identity = _cache_identity(root)
            workspace = _owned_workspace(root, identity)
            target = root / "outside-cache"
            target.mkdir()
            (target / "keep.bin").write_bytes(b"keep")
            shutil.rmtree(workspace / ".fullmag-build")
            (workspace / ".fullmag-build").symlink_to(target, target_is_directory=True)

            with patch.dict(os.environ, _identity_environment(identity)):
                with self.assertRaises(group_cleanup.BackendGroupCacheCleanupError):
                    group_cleanup.cleanup_group_compiler_outputs(
                        workspace, cache_identity=identity
                    )

            self.assertEqual((target / "keep.bin").read_bytes(), b"keep")

    def test_group_retention_rejects_backup_from_different_stable_unit(self) -> None:
        fixture_module = importlib.import_module("test_docker_backend_dev")
        fixture = fixture_module.BackendPackageTests(
            "test_retention_keeps_direct_rollback_and_archives_verified_obsolete_chain"
        )
        with tempfile.TemporaryDirectory() as temporary:
            root = _fixture_root(temporary)
            package, control, _toolchain = fixture._rotated_package_fixture(root, versions=1)
            current = backend._validated_package(
                package, "test current package", exclude_development_control=True
            )
            identity = _cache_identity(root, package)
            direct = fixture._direct_backup_for_current(control, current[1])
            environment = _identity_environment(identity)
            environment["FULLMAG_SHARED_BACKEND_GROUP"] = f"groups/{'e' * 64}"

            with (
                patch.dict(os.environ, environment),
                patch.object(backend, "PACKAGE_ROOT", package),
            ):
                with self.assertRaises(backend.BackendBuildError):
                    backend._retain_package_backups(
                        package, control, current[0], current[1], cache_identity=identity
                    )
            self.assertTrue(direct.is_dir())

    def test_unset_group_mode_preserves_compiler_tree(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = _fixture_root(temporary)
            identity = _cache_identity(root)
            workspace = _owned_workspace(root, identity)
            with patch.dict(os.environ, {}, clear=True):
                with self.assertRaises(group_cleanup.BackendGroupCacheCleanupError):
                    group_cleanup.cleanup_group_compiler_outputs(
                        workspace, cache_identity=identity
                    )
            self.assertTrue((workspace / ".fullmag-build" / "cargo-targets").is_dir())

    def test_interrupted_cleanup_receipt_resumes_after_target_was_removed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = _fixture_root(temporary)
            identity = _cache_identity(root)
            workspace = _owned_workspace(root, identity)
            remove = group_cleanup._remove_owned_cache_tree

            def remove_then_interrupt(path: Path, inventory):
                remove(path, inventory)
                raise OSError("simulated interruption after payload removal")

            with patch.dict(os.environ, _identity_environment(identity)):
                with patch.object(group_cleanup, "_remove_owned_cache_tree", side_effect=remove_then_interrupt):
                    with self.assertRaises(group_cleanup.BackendGroupCacheCleanupError):
                        group_cleanup.cleanup_group_compiler_outputs(workspace, cache_identity=identity)
                receipt_path = Path(identity["targets"]["control"]) / "backend" / "group-build-cleanup.json"
                self.assertEqual(json.loads(receipt_path.read_text(encoding="utf-8"))["state"], "started")
                result = group_cleanup.cleanup_group_compiler_outputs(workspace, cache_identity=identity)

            self.assertEqual(result["state"], "completed")
            self.assertFalse((workspace / ".fullmag-build").exists())

    def test_verified_package_and_shared_package_cache_hits_return_before_cleanup_hook(self) -> None:
        source = (HELPERS / "backend_dev.py").read_text(encoding="utf-8")
        start = source[source.index("def _start(args:"):]
        verified_hit = start.index('_log_phase("start", "cache-hit"')
        verified_return = start.index("return _serve([])", verified_hit)
        self.assertLess(verified_hit, verified_return)
        self.assertNotIn("cleanup_group_compiler_outputs", start[verified_hit:verified_return])

        shared_start = source.index("def _prepare_with_shared_package(")
        shared_end = source.index("def _prepare_locked(", shared_start)
        shared = source[shared_start:shared_end]
        shared_hit = shared.index("if cached is not None:")
        shared_return = shared.index("return 0", shared_hit)
        compile_call = shared.index("_prepare_locked(", shared_return)
        self.assertLess(shared_return, compile_call)

    def test_group_mode_keeps_cross_toolchain_and_cross_profile_direct_rollback(self) -> None:
        fixture_module = importlib.import_module("test_docker_backend_dev")
        fixture = fixture_module.BackendPackageTests(
            "test_retention_keeps_direct_rollback_and_archives_verified_obsolete_chain"
        )
        with tempfile.TemporaryDirectory() as temporary:
            root = _fixture_root(temporary)
            package, control, _toolchain = fixture._rotated_package_fixture(root, versions=1)
            current = backend._validated_package(
                package, "test current package", exclude_development_control=True
            )
            direct = fixture._direct_backup_for_current(control, current[1])
            receipt_path = direct / "backend-build-receipt.json"
            old_receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
            old_receipt["toolchain"] = {
                **old_receipt["toolchain"],
                "image_id": "sha256:" + "b" * 64,
                "dependency_manifest_sha256": "c" * 64,
            }
            old_receipt["build"]["cargo_profile"] = "release"
            old_receipt["build"]["cargo_target_profile_dir"] = "release"
            old_receipt["build"]["features"] = ["cuda", "fem-gpu", "different-abi"]
            old_bytes = backend._canonical(old_receipt)
            receipt_path.write_bytes(old_bytes)
            rotation_path = direct / "rotation.json"
            rotation = json.loads(rotation_path.read_text(encoding="utf-8"))
            new_backup_hash = backend._sha256_bytes(old_bytes)
            rotation["old_receipt_sha256"] = new_backup_hash
            backend._write_json(rotation_path, rotation, "test cross-toolchain rotation")
            identity = _cache_identity(root, package)

            with (
                patch.dict(os.environ, _identity_environment(identity)),
                patch.object(backend, "PACKAGE_ROOT", package),
            ):
                backend._retain_package_backups(
                    package, control, current[0], current[1], cache_identity=identity
                )

            self.assertEqual(len(tuple((control / backend.PACKAGE_BACKUPS_DIRNAME).iterdir())), 1)
            self.assertTrue(direct.is_dir())
            backend._validated_package(direct, "retained cross-toolchain rollback")

    def test_legacy_retention_still_rejects_cross_toolchain_backup(self) -> None:
        fixture_module = importlib.import_module("test_docker_backend_dev")
        fixture = fixture_module.BackendPackageTests(
            "test_retention_keeps_direct_rollback_and_archives_verified_obsolete_chain"
        )
        with tempfile.TemporaryDirectory() as temporary:
            root = _fixture_root(temporary)
            package, control, _toolchain = fixture._rotated_package_fixture(root, versions=1)
            current = backend._validated_package(
                package, "test current package", exclude_development_control=True
            )
            direct = fixture._direct_backup_for_current(control, current[1])
            receipt_path = direct / "backend-build-receipt.json"
            old_receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
            old_receipt["toolchain"]["image_id"] = "sha256:" + "d" * 64
            old_bytes = backend._canonical(old_receipt)
            receipt_path.write_bytes(old_bytes)
            rotation_path = direct / "rotation.json"
            rotation = json.loads(rotation_path.read_text(encoding="utf-8"))
            rotation["old_receipt_sha256"] = backend._sha256_bytes(old_bytes)
            backend._write_json(rotation_path, rotation, "test legacy rotation")

            with patch.dict(os.environ, {}, clear=False):
                os.environ.pop("FULLMAG_PRIVATE_GROUP_STORAGE", None)
                with self.assertRaises(backend.BackendBuildError):
                    backend._retain_package_backups(package, control, current[0], current[1])
            self.assertTrue(direct.is_dir())
