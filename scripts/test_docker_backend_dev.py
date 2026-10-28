"""Interpreted package publication regressions; no native compilation."""
from contextlib import redirect_stderr, redirect_stdout
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "docker" / "all-in-one"))
import backend_dev as backend


@unittest.skipIf(os.name == "nt", "Linux container symlink contract")
class BackendPackageTests(unittest.TestCase):
    @staticmethod
    def _capsule(source_digest, files):
        entries = []
        for relative, content in files.items():
            entries.append(
                {
                    "path": relative,
                    "type": "file",
                    "mode": "100644",
                    "size": len(content),
                    "sha256": hashlib.sha256(content).hexdigest(),
                }
            )
        return {"source_digest": source_digest, "files": sorted(entries, key=lambda entry: entry["path"])}

    @staticmethod
    def _stage(root, files):
        stage = root / f"stage-{len(tuple(root.glob('stage-*')))}"
        stage.mkdir()
        for relative, content in files.items():
            path = stage.joinpath(*relative.split("/"))
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        return stage

    @staticmethod
    def _workspace(root):
        workspace = backend._prepare_workspace(root)
        (workspace / ".fullmag-build" / "cargo-fingerprint").write_bytes(b"cache")
        return workspace

    @staticmethod
    def _package_workspace(root):
        workspace = root / "package-workspace"
        source = workspace / ".fullmag" / "local"
        source.mkdir(parents=True)
        for relative in backend.REQUIRED_PACKAGE_PATHS:
            if relative in backend.RUNTIME_MANIFEST_PATHS:
                continue
            path = source.joinpath(*relative.split("/"))
            path.parent.mkdir(parents=True, exist_ok=True)
            content = "cuda-fem-gpu\n" if relative == "launcher-build-mode" else "package\n"
            path.write_text(content, encoding="utf-8")
            if relative.startswith("bin/"):
                path.chmod(0o755)
        for relative in ("lib/libfullmag_fdm.so.1", "lib/libfullmag_fem.so.1"):
            path = source.joinpath(*relative.split("/"))
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"native-library")
        launcher = source / "bin/fullmag"
        launcher.write_text("#!/usr/bin/env bash\n", encoding="utf-8")
        launcher.chmod(0o755)
        (source / "direct-backend-build.log").write_text(
            "direct build fixture\n", encoding="utf-8"
        )
        return workspace

    def _published_package(self, root):
        workspace = self._package_workspace(root)
        output = root / "package"
        records = backend._copy_package(workspace, output)
        return output, records

    @staticmethod
    def _copy_into_marked_candidate(workspace, candidate, package_root, build_root):
        marker = candidate / backend.PACKAGE_CANDIDATE_MARKER
        backend._validate_candidate_marker(candidate, package_root, build_root, state="building")
        marker.unlink()
        records = backend._copy_package(workspace, candidate)
        backend._write_candidate_marker(
            candidate,
            package_root,
            build_root,
            state="ready",
            records=records,
        )
        return records

    @staticmethod
    def _populate_direct_candidate(package, build_root, candidate):
        candidate.mkdir()
        backend._write_candidate_marker(candidate, package, build_root, state="building")
        for relative in backend.REQUIRED_PACKAGE_PATHS:
            if relative in backend.RUNTIME_MANIFEST_PATHS:
                continue
            path = candidate.joinpath(*relative.split("/"))
            path.parent.mkdir(parents=True, exist_ok=True)
            content = b"cuda-fem-gpu\n" if relative == "launcher-build-mode" else b"candidate\n"
            path.write_bytes(content)
            if relative.startswith("bin/"):
                path.chmod(0o755)
        for relative in ("lib/libfullmag_fdm.so.1", "lib/libfullmag_fem.so.1"):
            path = candidate.joinpath(*relative.split("/"))
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"native-library")
        (candidate / "lib/libfullmag_fdm.so").symlink_to("libfullmag_fdm.so.1")
        (candidate / "lib/libfullmag_fem.so").symlink_to("libfullmag_fem.so.1")
        launcher = candidate / "bin/fullmag"
        launcher.write_text("#!/usr/bin/env bash\n", encoding="utf-8")
        launcher.chmod(0o755)
        for name in (
            "direct-backend-build.log",
            "install-cli-build.log",
            "install-cli-managed-fem-gpu.log",
        ):
            (candidate / name).write_text("build fixture\n", encoding="utf-8")

    @staticmethod
    def _direct_candidate_fixture(root, name=".backend-package-candidate-direct"):
        package = root / "package"
        package.mkdir()
        build_root = root / "build"
        build_root.mkdir()
        control = backend._ensure_package_development_root(package)
        candidate = control / backend.PACKAGE_CANDIDATES_DIRNAME / name
        workspace = root / "workspace"
        workspace.mkdir()
        BackendPackageTests._populate_direct_candidate(package, build_root, candidate)
        return package, build_root, control, candidate, workspace

    @staticmethod
    def _failed_make_fixture(root, name, payload=b"make failure\n"):
        root.mkdir(parents=True, exist_ok=True)
        package = root / "package"
        package.mkdir()
        build_root = root / "build"
        build_root.mkdir()
        control = backend._ensure_package_development_root(package)
        candidate = control / backend.PACKAGE_CANDIDATES_DIRNAME / name
        candidate.mkdir()
        backend._write_candidate_marker(candidate, package, build_root, state="building")
        log_path = backend._begin_failed_make_attempt(build_root, candidate, "install-cli-dev")
        log_path.write_bytes(payload)
        return package, build_root, candidate, log_path

    def _ready_rotation_fixture(self, root, name):
        package, current_records = self._published_package(root)
        backend._write_json(
            package / "backend-build-receipt.json",
            {
                "schema": backend.RECEIPT_SCHEMA,
                "state": "succeeded",
                "execution_lanes": {
                    lane: {"status": "compiled"} for lane in backend.LANES
                },
                "artifacts": current_records,
            },
            "rotation journal current receipt",
        )
        build_root = root / "build"
        build_root.mkdir()
        control = backend._ensure_package_development_root(package)
        candidate = control / backend.PACKAGE_CANDIDATES_DIRNAME / name
        self._populate_direct_candidate(package, build_root, candidate)
        workspace = root / "workspace"
        workspace.mkdir()
        candidate_records = backend._copy_package(
            workspace,
            candidate,
            direct_install=True,
            package_root=package,
            build_root=build_root,
        )
        previous = backend._validated_package(
            package,
            "rotation journal current package",
            exclude_development_control=True,
        )
        candidate_receipt = {
            "schema": backend.RECEIPT_SCHEMA,
            "state": "succeeded",
            "execution_lanes": {lane: {"status": "compiled"} for lane in backend.LANES},
            "artifacts": candidate_records,
        }
        backend._write_json(
            candidate / "backend-build-receipt.json",
            candidate_receipt,
            "rotation journal candidate receipt",
        )
        return (
            package,
            build_root,
            control,
            candidate,
            previous,
            (candidate / "backend-build-receipt.json").read_bytes(),
        )

    def _rotated_package_fixture(self, root, versions=3):
        package, records = self._published_package(root)
        toolchain = self._toolchain_fixture()
        _, manifest = self._live_manifest(root, commit="a" * 40, capture_id="retention-0")
        backend._write_json(
            package / "backend-build-receipt.json",
            self._receipt_for_manifest(records, manifest, toolchain),
            "retention fixture initial receipt",
        )
        control = backend._ensure_package_development_root(package)
        for index in range(1, versions + 1):
            candidate = (
                control / backend.PACKAGE_CANDIDATES_DIRNAME / f"candidate-{index}"
            )
            candidate.mkdir()
            workspace = self._package_workspace(root / f"retention-workspace-{index}")
            candidate_records = backend._copy_package(workspace, candidate)
            (candidate / "bin/fullmag-bin").write_bytes(
                f"retention-version-{index}\n".encode("ascii")
            )
            candidate_records = backend._hash_package(candidate)
            _, manifest = self._live_manifest(
                root,
                commit=f"{index + 1:040x}",
                capture_id=f"retention-{index}",
            )
            backend._write_json(
                candidate / "backend-build-receipt.json",
                self._receipt_for_manifest(candidate_records, manifest, toolchain),
                "retention fixture candidate receipt",
            )
            previous = backend._validated_package(
                package, "retention fixture current", exclude_development_control=True
            )
            candidate_receipt_bytes = (
                candidate / "backend-build-receipt.json"
            ).read_bytes()
            rotation = backend._rotate_package(
                package,
                candidate,
                control,
                previous[2],
                previous[1],
                candidate_receipt_bytes,
            )
            backend._finalize_published_candidate(candidate, rotation)
            backend._clear_rotation_journal(rotation)
        return package, control, toolchain

    def _direct_retention_fixture(self, root, *, remove_launcher):
        """Create a full receipt-backed rotation whose new package is direct-installed."""

        package, control, toolchain = self._rotated_package_fixture(root, versions=2)
        if remove_launcher:
            (package / "bin/fullmag").unlink()
        previous = backend._validated_package(
            package,
            "direct retention previous package",
            exclude_development_control=True,
        )
        build_root = root / "direct-retention-build"
        build_root.mkdir()
        candidate = (
            control
            / backend.PACKAGE_CANDIDATES_DIRNAME
            / ".backend-package-candidate-retention"
        )
        self._populate_direct_candidate(package, build_root, candidate)
        candidate_records = backend._copy_package(
            root / "direct-retention-workspace",
            candidate,
            direct_install=True,
            package_root=package,
            build_root=build_root,
        )
        _, manifest = self._live_manifest(
            root, commit="4" * 40, capture_id="retention-direct"
        )
        backend._write_json(
            candidate / "backend-build-receipt.json",
            self._receipt_for_manifest(candidate_records, manifest, toolchain),
            "direct retention candidate receipt",
        )
        candidate_receipt_bytes = (
            candidate / "backend-build-receipt.json"
        ).read_bytes()
        rotation = backend._rotate_package(
            package,
            candidate,
            control,
            previous[2],
            previous[1],
            candidate_receipt_bytes,
        )
        backend._finalize_published_candidate(candidate, rotation)
        backend._clear_rotation_journal(rotation)
        current = backend._validated_package(
            package,
            "direct retention current package",
            exclude_development_control=True,
        )
        return package, control, current

    @staticmethod
    def _direct_backup_for_current(control, current_receipt_bytes):
        expected = backend._sha256_bytes(current_receipt_bytes)
        backups = sorted(
            (control / backend.PACKAGE_BACKUPS_DIRNAME).glob(
                ".backend-package-backup-*"
            )
        )
        matches = []
        for backup in backups:
            rotation = json.loads(
                (backup / "rotation.json").read_text(encoding="utf-8")
            )
            if rotation.get("new_receipt_sha256") == expected:
                matches.append(backup)
        if len(matches) != 1:
            raise AssertionError(f"expected one direct rollback, found {matches!r}")
        return matches[0]

    def test_retention_accepts_current_direct_package_without_legacy_launcher(self):
        with tempfile.TemporaryDirectory() as directory:
            package, control, current = self._direct_retention_fixture(
                Path(directory), remove_launcher=True
            )
            backend._retain_package_backups(
                package, control, current[0], current[1]
            )
            direct_backup = self._direct_backup_for_current(control, current[1])
            self.assertFalse((direct_backup / "bin/fullmag").exists())
            self.assertEqual(
                len(
                    list(
                        (control / backend.PACKAGE_BACKUPS_DIRNAME).glob(
                            ".backend-package-backup-*"
                        )
                    )
                ),
                1,
            )

    def test_retention_accepts_legacy_launcher_in_verified_rollback(self):
        with tempfile.TemporaryDirectory() as directory:
            package, control, current = self._direct_retention_fixture(
                Path(directory), remove_launcher=False
            )
            backend._retain_package_backups(
                package, control, current[0], current[1]
            )
            direct_backup = self._direct_backup_for_current(control, current[1])
            self.assertTrue((direct_backup / "bin/fullmag").is_file())
            self.assertEqual(
                (direct_backup / "bin/fullmag").read_text(encoding="utf-8"),
                "#!/usr/bin/env bash\n",
            )

    def test_retention_rejects_unrecognized_launcher_prefix_without_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            package, control, current = self._direct_retention_fixture(
                Path(directory), remove_launcher=True
            )
            direct_backup = self._direct_backup_for_current(control, current[1])
            alien = direct_backup / "bin/fullmag.extra"
            alien.write_bytes(b"unowned\n")
            before_backups = sorted(
                path.name
                for path in (control / backend.PACKAGE_BACKUPS_DIRNAME).iterdir()
            )
            with self.assertRaisesRegex(
                backend.BackendBuildError,
                "unrecognized file or directory inventory",
            ):
                backend._retain_package_backups(
                    package, control, current[0], current[1]
                )
            self.assertEqual(
                sorted(
                    path.name
                    for path in (control / backend.PACKAGE_BACKUPS_DIRNAME).iterdir()
                ),
                before_backups,
            )
            self.assertEqual(alien.read_bytes(), b"unowned\n")

    @staticmethod
    def _live_manifest(root, *, commit="a" * 40, capture_id="test-capture"):
        capsule = {
            "schema": "fullmag.source-capsule.v1",
            "schema_version": "fullmag.source-capsule.v1",
            "source_mode": "snapshot",
            "resolved_commit": commit,
            "files": [],
            "deleted": [],
            "included_untracked": [],
            "excluded": [],
        }
        capsule["source_digest"] = backend._sha256_bytes(
            backend._canonical(
                {
                    "schema_version": capsule["schema_version"],
                    "source_mode": capsule["source_mode"],
                    "resolved_commit": capsule["resolved_commit"],
                    "files": capsule["files"],
                    "deleted": capsule["deleted"],
                    "included_untracked": capsule["included_untracked"],
                    "excluded": capsule["excluded"],
                }
            )
        )
        native = {
            "schema": "fullmag.source-snapshot.v2",
            "head_commit_full": commit,
            "head_tree_sha256": "b" * 64,
            "dirty_content_sha256": "c" * 64,
            "source_snapshot_sha256": "d" * 64,
            "source_snapshot_dirty": False,
            "ignored_non_runtime_dirty": False,
            "git_status_porcelain_v1": [],
            "dirty_path_content": [],
        }
        document = {
            "schema": backend.LIVE_MANIFEST_SCHEMA,
            "capture_id": capture_id,
            "source_mode": backend.LIVE_SOURCE_MODE,
            "source_root": str(root / "source"),
            "git_common_dir": str(root / "git-common"),
            "resolved_commit": commit,
            "source_digest": capsule["source_digest"],
            "source_snapshot_sha256": native["source_snapshot_sha256"],
            "native_source_identity": native,
            "source_manifest": capsule,
            "source_manifest_sha256": backend._sha256_bytes(backend._canonical(capsule)),
            "git_object_ids": {},
            "created_at": "2026-10-17T00:00:00Z",
        }
        document["live_manifest_sha256"] = backend._sha256_bytes(backend._canonical(document))
        path = root / f"{capture_id}.json"
        backend._write_json(path, document, "test live source manifest")
        return path, document

    @staticmethod
    def _toolchain_fixture():
        return {
            "image_id": "sha256:" + "e" * 64,
            "dependency_manifest_sha256": "f" * 64,
            "dependency_schema": "fullmag.docker.fem-gpu-dependencies.v1",
            "actual_source_commits": {
                "mfem": "1" * 40,
                "libceed": "2" * 40,
                "hypre": "3" * 40,
                "petsc": "4" * 40,
                "slepc": "5" * 40,
            },
        }

    @staticmethod
    def _receipt_for_manifest(records, manifest, toolchain):
        native = manifest["native_source_identity"]
        return {
            "schema": backend.RECEIPT_SCHEMA,
            "state": "succeeded",
            "execution_lanes": {lane: {"status": "compiled"} for lane in backend.LANES},
            "source": {
                "source_mode": backend.LIVE_SOURCE_MODE,
                "resolved_commit": manifest["resolved_commit"],
                "source_digest": manifest["source_digest"],
                "source_snapshot_sha256": manifest["source_snapshot_sha256"],
            },
            "native_source_identity": native,
            "native_source_identity_sha256": backend._sha256_bytes(backend._canonical(native)),
            "toolchain": toolchain,
            "build": backend._expected_backend_build_identity("backend-dev"),
            "artifacts": records,
        }

    def test_control_volume_provenance_can_be_published_without_a_host_bind(self):
        with tempfile.TemporaryDirectory() as temporary:
            control = Path(temporary) / "backend"
            with patch.object(backend, "BACKEND_CONTROL_ROOT", control):
                path = control / "runtime-provenance.json"
                backend._write_bound_json(path, {"state": "succeeded"}, "runtime provenance")
                self.assertEqual(json.loads(path.read_text(encoding="utf-8")), {"state": "succeeded"})
                backend._write_bound_json(path, {"state": "replaced"}, "runtime provenance")
                self.assertEqual(json.loads(path.read_text(encoding="utf-8")), {"state": "replaced"})

    def test_live_source_copy_performs_one_verified_read(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.rs"
            target = root / "shadow/source.rs"
            content = b"pub fn value() -> u8 { 1 }\n"
            source.write_bytes(content)
            entry = {
                "path": "source.rs",
                "size": len(content),
                "sha256": hashlib.sha256(content).hexdigest(),
                "mode": "100644",
            }
            original_open_regular = backend._open_regular
            source_opens = []

            def tracking_open_regular(path, name, maximum):
                if name == "live source source.rs":
                    source_opens.append(path)
                return original_open_regular(path, name, maximum)

            with patch.object(backend, "_open_regular", side_effect=tracking_open_regular):
                backend._copy_live_regular_file(source, target, "source.rs", entry)

            self.assertEqual(source_opens, [source])
            self.assertEqual(target.read_bytes(), content)

    def test_phase_log_is_flushable_and_excludes_paths_or_contents(self):
        class FlushTrackingStream(io.StringIO):
            flushed = False

            def flush(self):
                self.flushed = True
                super().flush()

        stream = FlushTrackingStream()
        with redirect_stderr(stream):
            backend._log_phase(
                "capture",
                "complete",
                files=9000,
                path="/sensitive/source.rs",
                content="private source",
            )
        output = stream.getvalue()
        self.assertTrue(stream.flushed)
        self.assertIn("backend-dev: phase=capture state=complete files=9000", output)
        self.assertNotIn("sensitive", output)
        self.assertNotIn("private source", output)

    def test_local_runtime_manifests_are_attested_and_resolve_workers_inside_package(self):
        with tempfile.TemporaryDirectory() as directory:
            output, records = self._published_package(Path(directory))
            self.assertEqual(backend._hash_package(output), records)
            record_paths = {record["path"] for record in records}
            self.assertTrue(set(backend.RUNTIME_MANIFEST_PATHS).issubset(record_paths))
            self.assertEqual(
                {record["path"] for record in records if record["path"].startswith("runtimes/")},
                set(backend.RUNTIME_MANIFEST_PATHS),
            )

            manifests = {}
            package_root = output.resolve()
            for relative in backend.RUNTIME_MANIFEST_PATHS:
                path = output / relative
                manifest = json.loads(path.read_text(encoding="utf-8"))
                manifests[manifest["family"]] = manifest
                worker = (path.parent / manifest["worker"]).resolve(strict=True)
                self.assertTrue(worker.is_relative_to(package_root))
                self.assertEqual(worker, (output / "bin/fullmag-bin").resolve())
                self.assertEqual(manifest["worker"], "../../bin/fullmag-bin")

            self.assertTrue(manifests["cpu-reference"]["engines"][0]["public"])
            self.assertTrue(manifests["fdm-cuda"]["engines"][0]["public"])
            for family in ("fem-cpu-native", "fem-gpu"):
                engine = manifests[family]["engines"][0]
                self.assertFalse(engine["public"])
                self.assertEqual(engine["stability"], "experimental")

    def test_tampered_runtime_manifest_is_rejected_by_serve_verifier(self):
        with tempfile.TemporaryDirectory() as directory:
            output, records = self._published_package(Path(directory))
            backend._write_json(
                output / "backend-build-receipt.json",
                {
                    "schema": backend.RECEIPT_SCHEMA,
                    "state": "succeeded",
                    "execution_lanes": {lane: {} for lane in backend.LANES},
                    "artifacts": records,
                },
                "test backend build receipt",
            )
            manifest = output / "runtimes/fem-gpu/manifest.json"
            manifest.write_text(manifest.read_text(encoding="utf-8") + "\n", encoding="utf-8")
            original_package_root = backend.PACKAGE_ROOT
            backend.PACKAGE_ROOT = output
            try:
                with self.assertRaisesRegex(
                    backend.BackendBuildError, "runtime package artifacts differ from the build receipt"
                ):
                    backend._serve([])
            finally:
                backend.PACKAGE_ROOT = original_package_root

    def test_development_compose_selects_receipt_validated_backend_start(self):
        repository = Path(__file__).resolve().parents[1]
        development_compose = (repository / "compose.dev.yaml").read_text(encoding="utf-8")
        backend_block = development_compose.split("\n  backend:\n", 1)[1].split(
            "\n  frontend:\n", 1
        )[0]
        self.assertIn(
            'entrypoint: ["/usr/local/bin/python3", "/opt/fullmag/backend_dev.py"]',
            backend_block,
        )
        self.assertIn("      - start\n", backend_block)
        for token in (
            "/opt/fullmag/source",
            "/opt/fullmag/source-git",
            "/opt/fullmag/package",
            "/build",
        ):
            self.assertIn(token, backend_block)
        for removed_token in ("/input/manifest.json", "--manifest", "--source-tar"):
            self.assertNotIn(removed_token, backend_block)
        self.assertIn("read_only: true", backend_block)
        self.assertIn("start_period: 14400s", backend_block)
        self.assertIn(
            "PYTHONPATH: /build/workspace/packages/fullmag-py/src:/opt/fullmag/package",
            backend_block,
        )
        static_compose = (repository / "compose.static.yaml").read_text(encoding="utf-8")
        self.assertNotIn("/opt/fullmag/backend_dev.py", static_compose)

        with tempfile.TemporaryDirectory() as directory:
            output, records = self._published_package(Path(directory))
            backend._write_json(
                output / "backend-build-receipt.json",
                {
                    "schema": backend.RECEIPT_SCHEMA,
                    "state": "succeeded",
                    "execution_lanes": {lane: {} for lane in backend.LANES},
                    "artifacts": records,
                },
                "test backend build receipt",
            )
            original_package_root = backend.PACKAGE_ROOT
            backend.PACKAGE_ROOT = output
            try:
                with patch.object(backend.os, "execvpe") as execvpe:
                    self.assertEqual(backend.main(["serve"]), 0)
                    self.assertEqual(backend.main(["serve", "--storage-probe"]), 0)
                self.assertEqual(execvpe.call_count, 2)
                self.assertEqual(
                    execvpe.call_args_list[0].args[1][1:],
                    ["/opt/fullmag/entrypoint.py"],
                )
                self.assertEqual(
                    execvpe.call_args_list[1].args[1][1:],
                    ["/opt/fullmag/entrypoint.py", "--storage-probe"],
                )
                self.assertEqual(
                    execvpe.call_args_list[0].args[2]["FULLMAG_RUNTIME_ROOT"],
                    str(output),
                )
                self.assertEqual(
                    execvpe.call_args_list[0].args[2]["FULLMAG_RUNTIME_PACKAGE_ROOT"],
                    str(output),
                )
                self.assertEqual(
                    execvpe.call_args_list[0].args[2]["FULLMAG_PACKAGE_PROVENANCE"],
                    str(backend.PROVENANCE_PATH),
                )

                manifest = output / "runtimes/fem-gpu/manifest.json"
                manifest.write_text(
                    manifest.read_text(encoding="utf-8") + "\n", encoding="utf-8"
                )
                with patch.object(backend.os, "execvpe") as tampered_exec:
                    self.assertEqual(backend.main(["serve"]), 2)
                    tampered_exec.assert_not_called()
            finally:
                backend.PACKAGE_ROOT = original_package_root

    def test_backend_cache_receipt_is_published_only_in_control_volume(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            control = root / "control"
            backend_control = control / "backend"
            host_storage = root / "storage"
            host_storage.mkdir()
            receipt_path = backend_control / backend.PACKAGE_CACHE_RECEIPT_NAME
            environment = {
                "FULLMAG_BACKEND_CACHE_SCHEMA": "fullmag.backend-build-cache.v2",
                "FULLMAG_BACKEND_CACHE_PROFILE": "backend-build-cache-v2",
                "FULLMAG_BACKEND_CACHE_PROJECT_ID": "fullmag",
                "FULLMAG_BACKEND_CACHE_KEY": "a" * 64,
                "FULLMAG_BACKEND_CACHE_UNIT_KEY": "b" * 64,
                "FULLMAG_BACKEND_CACHE_OWNER_ID": "c" * 64,
                "FULLMAG_BACKEND_CACHE_WORKTREE_ID": "docker-all-master-integration-20261017",
                "FULLMAG_BACKEND_CACHE_TOOLCHAIN_IMAGE_ID": "sha256:" + "d" * 64,
                "FULLMAG_BACKEND_RUNTIME_IMAGE_ID": "sha256:" + "e" * 64,
                "FULLMAG_BACKEND_CARGO_PROFILE": "backend-dev",
                "FULLMAG_BACKEND_CACHE_BUILD_VOLUME": "fullmag-build-cache",
                "FULLMAG_BACKEND_CACHE_PACKAGE_VOLUME": "fullmag-package-cache",
                "FULLMAG_BUILD_CONTROL_VOLUME": "fullmag-control-cache",
                "FULLMAG_BACKEND_CACHE_CONTROL_VOLUME": "fullmag-control-cache",
                "FULLMAG_BACKEND_CACHE_BUILD_ROOT": str(backend.BUILD_ROOT),
                "FULLMAG_BACKEND_CACHE_PACKAGE_ROOT": str(backend.PACKAGE_ROOT),
                "FULLMAG_BACKEND_CACHE_CONTROL_ROOT": str(control),
                "FULLMAG_BACKEND_CACHE_CONTROL_NAMESPACE": str(control / "backend"),
                "FULLMAG_BACKEND_CACHE_RECEIPT": str(receipt_path),
            }
            with (
                patch.object(backend, "CONTROL_ROOT", control),
                patch.object(backend, "BACKEND_CONTROL_ROOT", backend_control),
                patch.object(backend, "CACHE_RECEIPT_PATH", receipt_path),
                patch.dict(os.environ, environment, clear=False),
            ):
                receipt = backend._backend_cache_receipt()
            self.assertIsNotNone(receipt)
            self.assertEqual(receipt["storage"], "docker-named-volume")
            self.assertEqual(receipt["targets"]["receipt"], str(receipt_path))
            self.assertTrue(receipt_path.is_file())
            self.assertFalse((host_storage / backend.PACKAGE_CACHE_RECEIPT_NAME).exists())

    def test_start_prepares_and_serves_in_one_container(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            build_root = root / "build"
            build_root.mkdir()
            package = root / "package"
            package.mkdir()
            original_package_root = backend.PACKAGE_ROOT
            backend.PACKAGE_ROOT = package
            events = []
            build_number = 0

            def prepare_candidate(*args):
                nonlocal build_number
                candidate = args[2]
                build_number += 1
                workspace = self._package_workspace(root / f"candidate-{build_number}")
                records = self._copy_into_marked_candidate(
                    workspace, candidate, backend.PACKAGE_ROOT, args[1]
                )
                if build_number == 2:
                    binary = candidate / "bin/fullmag-bin"
                    binary.write_bytes(b"changed candidate\n")
                    records = backend._hash_package(candidate)
                    backend._write_candidate_marker(
                        candidate,
                        backend.PACKAGE_ROOT,
                        args[1],
                        state="ready",
                        records=records,
                    )
                backend._write_json(
                    candidate / "backend-build-receipt.json",
                    {
                        "schema": backend.RECEIPT_SCHEMA,
                        "state": "succeeded",
                        "execution_lanes": {
                            lane: {"status": "compiled"} for lane in backend.LANES
                        },
                        "artifacts": records,
                    },
                    "test candidate receipt",
                )
                events.append(("prepare", args))
                return 0

            try:
                with (
                    patch.dict(os.environ, {"FULLMAG_BACKEND_CARGO_PROFILE": "backend-dev"}),
                    patch.object(
                        backend,
                        "_toolchain_identity",
                        return_value=(
                            "sha256:" + "a" * 64,
                            {"image_id": "sha256:" + "a" * 64},
                        ),
                    ),
                    patch.object(
                        backend,
                        "_prepare_locked",
                        side_effect=prepare_candidate,
                    ),
                    patch.object(
                        backend,
                        "_capture_start_manifest",
                        return_value=Path("/build/live-source/manifest.json"),
                    ),
                    patch.object(
                        backend,
                        "_publish_runtime_provenance",
                        side_effect=lambda output: events.append(("provenance", output)) or 0,
                    ),
                    patch.object(
                        backend,
                        "_serve",
                        side_effect=lambda extra: events.append(("serve", extra)) or 0,
                    ),
                ):
                    command = [
                        "start",
                        "--build-root",
                        str(build_root),
                        "--jobs",
                        "3",
                    ]
                    self.assertEqual(backend.main(command), 0)
                    self.assertEqual(backend.main(command), 0)
                self.assertEqual(
                    [event[0] for event in events],
                    ["prepare", "provenance", "serve"] * 2,
                )
                prepare_args = events[0][1]
                self.assertEqual(
                    prepare_args[0].manifest,
                    Path("/build/live-source/manifest.json"),
                )
                self.assertIsNone(prepare_args[0].source_tar)
                self.assertEqual(prepare_args[1], build_root)
                self.assertTrue(
                    prepare_args[2].is_relative_to(
                        package / backend.PACKAGE_DEVELOPMENT_DIRNAME
                    )
                )
                self.assertTrue(
                    prepare_args[2].is_relative_to(
                        package
                        / backend.PACKAGE_DEVELOPMENT_DIRNAME
                        / backend.PACKAGE_CANDIDATES_DIRNAME
                    )
                )
                self.assertFalse(prepare_args[2].is_relative_to(build_root))
                self.assertNotEqual(prepare_args[2], package)
                self.assertEqual(prepare_args[3], 3)
                self.assertEqual(prepare_args[5], prepare_args[2])
                self.assertTrue(prepare_args[5].name.startswith(".backend-package-candidate-"))
                self.assertEqual(events[1][1], package)
                self.assertEqual(events[2][1], [])
                self.assertNotEqual((package / "bin/fullmag-bin").read_bytes(), b"package\n")
                backups = sorted(
                    (
                        package
                        / backend.PACKAGE_DEVELOPMENT_DIRNAME
                        / backend.PACKAGE_BACKUPS_DIRNAME
                    ).glob(".backend-package-backup-*")
                )
                self.assertEqual(len(backups), 1)
                self.assertEqual(
                    (backups[0] / "bin/fullmag-bin").read_bytes(), b"package\n"
                )
                rotation = json.loads(
                    (backups[0] / "rotation.json").read_text(encoding="utf-8")
                )
                self.assertEqual(
                    rotation["schema"], "fullmag.direct-compose.package-rotation.v1"
                )
                self.assertEqual(rotation["state"], "succeeded")
                self.assertFalse(
                    list(
                        (
                            package
                            / backend.PACKAGE_DEVELOPMENT_DIRNAME
                            / backend.PACKAGE_CANDIDATES_DIRNAME
                        ).glob(".backend-package-candidate-*")
                    )
                )
            finally:
                backend.PACKAGE_ROOT = original_package_root

    def test_start_reuses_verified_package_without_prepare_or_rotation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            build_root = root / "build"
            build_root.mkdir()
            package, records = self._published_package(root)
            manifest_path, manifest = self._live_manifest(root)
            toolchain = self._toolchain_fixture()
            backend._write_json(
                package / "backend-build-receipt.json",
                self._receipt_for_manifest(records, manifest, toolchain),
                "test backend build receipt",
            )
            provenance = root / "provenance.json"
            provenance.write_bytes(b'{"state":"previous"}\n')
            original_package_root = backend.PACKAGE_ROOT
            original_provenance_path = backend.PROVENANCE_PATH
            backend.PACKAGE_ROOT = package
            backend.PROVENANCE_PATH = provenance
            try:
                with (
                    patch.dict(os.environ, {"FULLMAG_BACKEND_CARGO_PROFILE": "backend-dev"}),
                    patch.object(
                        backend,
                        "_toolchain_identity",
                        return_value=(toolchain["image_id"], toolchain),
                    ),
                    patch.object(backend, "_capture_start_manifest", return_value=manifest_path),
                    patch.object(backend, "_preflight_candidate_storage") as space_preflight,
                    patch.object(backend, "_prepare_locked") as prepare,
                    patch.object(backend, "_rotate_package") as rotate,
                    patch.object(backend, "_publish_runtime_provenance") as publish,
                    patch.object(backend, "_serve", return_value=0) as serve,
                ):
                    self.assertEqual(
                        backend.main(["start", "--build-root", str(build_root)]),
                        0,
                    )
                prepare.assert_not_called()
                space_preflight.assert_not_called()
                rotate.assert_not_called()
                publish.assert_called_once_with(package)
                serve.assert_called_once_with([])
                self.assertFalse(
                    list(
                        (package / backend.PACKAGE_DEVELOPMENT_DIRNAME / backend.PACKAGE_CANDIDATES_DIRNAME)
                        .glob(".backend-package-candidate-*")
                    )
                )
            finally:
                backend.PACKAGE_ROOT = original_package_root
                backend.PROVENANCE_PATH = original_provenance_path

    def test_start_rejects_known_insufficient_cache_before_prepare(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            build_root = root / "build"
            build_root.mkdir()
            package, records = self._published_package(root)
            manifest_path, manifest = self._live_manifest(root)
            toolchain = self._toolchain_fixture()
            backend._write_json(
                package / "backend-build-receipt.json",
                self._receipt_for_manifest(records, manifest, toolchain),
                "test backend build receipt",
            )
            provenance = root / "provenance.json"
            provenance.write_bytes(b'{"state":"previous"}\n')
            backend._ensure_package_development_root(package)
            before = {
                path.relative_to(package).as_posix(): path.read_bytes()
                for path in package.rglob("*")
                if path.is_file()
            }
            original_package_root = backend.PACKAGE_ROOT
            original_provenance_path = backend.PROVENANCE_PATH
            backend.PACKAGE_ROOT = package
            backend.PROVENANCE_PATH = provenance
            try:
                with (
                    patch.dict(os.environ, {"FULLMAG_BACKEND_CARGO_PROFILE": "backend-dev"}),
                    patch.object(
                        backend,
                        "_toolchain_identity",
                        return_value=(toolchain["image_id"], toolchain),
                    ),
                    patch.object(backend, "_capture_start_manifest", return_value=manifest_path),
                    patch.object(backend, "_package_matches_fresh_live_manifest", return_value=False),
                    patch.object(backend, "_prepare_locked") as prepare,
                    patch.object(backend, "_serve") as serve,
                    patch.object(
                        backend.os,
                        "statvfs",
                        return_value=os.statvfs_result((4096, 4096, 1, 1, 0, 1, 1, 1, 0, 255)),
                    ) as statvfs,
                ):
                    stderr = io.StringIO()
                    with redirect_stderr(stderr):
                        result = backend.main(
                            [
                                "start",
                                "--output",
                                str(package),
                                "--build-root",
                                str(build_root),
                            ]
                        )
                self.assertEqual(result, 2)
                statvfs.assert_called_once_with(build_root)
                prepare.assert_not_called()
                serve.assert_not_called()
                message = stderr.getvalue()
                self.assertIn("insufficient backend cache space before rebuild", message)
                self.assertIn("cache_mount=", message)
                self.assertIn("free_bytes=0", message)
                self.assertIn("estimated_candidate_artifact_bytes=", message)
                after = {
                    path.relative_to(package).as_posix(): path.read_bytes()
                    for path in package.rglob("*")
                    if path.is_file()
                }
                self.assertEqual(after, before)
            finally:
                backend.PACKAGE_ROOT = original_package_root
                backend.PROVENANCE_PATH = original_provenance_path

    def test_start_cache_miss_space_preflight_is_only_a_lower_bound(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            build_root = root / "build"
            build_root.mkdir()
            package, records = self._published_package(root)
            manifest_path, manifest = self._live_manifest(root)
            toolchain = self._toolchain_fixture()
            backend._write_json(
                package / "backend-build-receipt.json",
                self._receipt_for_manifest(records, manifest, toolchain),
                "test backend build receipt",
            )
            provenance = root / "provenance.json"
            provenance.touch()
            estimated = sum(record["size"] for record in records)
            block_size = 4096
            available_blocks = (estimated + block_size - 1) // block_size
            original_package_root = backend.PACKAGE_ROOT
            original_provenance_path = backend.PROVENANCE_PATH
            backend.PACKAGE_ROOT = package
            backend.PROVENANCE_PATH = provenance
            try:
                with (
                    patch.dict(os.environ, {"FULLMAG_BACKEND_CARGO_PROFILE": "backend-dev"}),
                    patch.object(
                        backend,
                        "_toolchain_identity",
                        return_value=(toolchain["image_id"], toolchain),
                    ),
                    patch.object(backend, "_capture_start_manifest", return_value=manifest_path),
                    patch.object(backend, "_package_matches_fresh_live_manifest", return_value=False),
                    patch.object(
                        backend,
                        "_prepare_locked",
                        side_effect=backend.BackendBuildError("prepare reached after space preflight"),
                    ) as prepare,
                    patch.object(backend, "_serve") as serve,
                    patch.object(
                        backend.os,
                        "statvfs",
                        return_value=os.statvfs_result(
                            (block_size, block_size, 1, 1, available_blocks, 1, 1, 1, 0, 255)
                        ),
                    ) as statvfs,
                ):
                    stderr = io.StringIO()
                    with redirect_stderr(stderr):
                        result = backend.main(
                            [
                                "start",
                                "--output",
                                str(package),
                                "--build-root",
                                str(build_root),
                            ]
                        )
                self.assertEqual(result, 2)
                statvfs.assert_called_once_with(build_root)
                prepare.assert_called_once()
                serve.assert_not_called()
                message = stderr.getvalue()
                self.assertIn("phase=space state=preflight", message)
                self.assertNotIn("insufficient backend cache space before rebuild", message)
            finally:
                backend.PACKAGE_ROOT = original_package_root
                backend.PROVENANCE_PATH = original_provenance_path

    def test_make_output_log_is_bounded_without_changing_command_result(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            log_path = root / "build.log"
            with patch.object(backend, "MAX_BUILD_LOG_BYTES", 128), redirect_stderr(io.StringIO()), redirect_stdout(io.StringIO()):
                result = backend._run_canonical_make(
                    [sys.executable, "-B", "-c", "import sys;sys.stdout.buffer.write(b'x'*4096)"],
                    root, dict(os.environ), log_path)
            self.assertEqual(result, 0)
            self.assertEqual(log_path.read_bytes(), b'x'*128)

    def test_retention_metadata_limit_preserves_all_existing_packages(self):
        with tempfile.TemporaryDirectory() as temporary:
            package, control, _toolchain = self._rotated_package_fixture(Path(temporary), versions=3)
            current = backend._validated_package(package, "current", exclude_development_control=True)
            backups = control / backend.PACKAGE_BACKUPS_DIRNAME
            before = {str(path.relative_to(backups)): path.read_bytes()
                      for path in backups.rglob('*') if path.is_file()}
            with patch.object(backend, "MAX_RETENTION_ARCHIVES", 0):
                with self.assertRaisesRegex(backend.BackendBuildError, "metadata budget exhausted"):
                    backend._retain_package_backups(package, control, current[0], current[1])
            after = {str(path.relative_to(backups)): path.read_bytes()
                     for path in backups.rglob('*') if path.is_file()}
            self.assertEqual(before, after)
            self.assertEqual(current[1], backend._validated_package(package, "current", exclude_development_control=True)[1])

    def test_retention_keeps_direct_rollback_and_archives_verified_obsolete_chain(self):
        with tempfile.TemporaryDirectory() as directory:
            package, control, _toolchain = self._rotated_package_fixture(Path(directory), versions=3)
            current = backend._validated_package(
                package, "retention fixture current", exclude_development_control=True
            )
            backend._retain_package_backups(package, control, current[0], current[1])
            backups = sorted(
                (control / backend.PACKAGE_BACKUPS_DIRNAME).glob(
                    ".backend-package-backup-*"
                )
            )
            archives = sorted(
                (control / backend.PACKAGE_RETENTION_ARCHIVE_DIRNAME).glob(
                    ".backend-package-backup-*"
                )
            )
            self.assertEqual(len(backups), 1)
            self.assertEqual(len(archives), 2)
            direct_rotation = json.loads(
                (backups[0] / "rotation.json").read_text(encoding="utf-8")
            )
            self.assertEqual(
                direct_rotation["new_receipt_sha256"], backend._sha256_bytes(current[1])
            )
            for archive in archives:
                self.assertEqual(
                    {path.name for path in archive.iterdir()},
                    {
                        "backend-build-receipt.json",
                        "rotation.json",
                        "retention.json",
                    },
                )
            backend._validate_retention_archives(
                control / backend.PACKAGE_RETENTION_ARCHIVE_DIRNAME
            )
            backend._validated_package(
                package, "retention fixture current after cleanup", exclude_development_control=True
            )

    def test_retention_bounds_archive_history_without_copying_retired_logs(self):
        with tempfile.TemporaryDirectory() as directory:
            package, control, _toolchain = self._rotated_package_fixture(
                Path(directory), versions=10
            )
            current = backend._validated_package(
                package, "retention fixture current", exclude_development_control=True
            )

            backend._retain_package_backups(package, control, current[0], current[1])

            backups_root = control / backend.PACKAGE_BACKUPS_DIRNAME
            archive_root = control / backend.PACKAGE_RETENTION_ARCHIVE_DIRNAME
            backups = sorted(backups_root.glob(".backend-package-backup-*"))
            archives = sorted(archive_root.glob(".backend-package-backup-*"))
            self.assertEqual(len(backups), 1)
            self.assertLessEqual(len(archives), 8)
            self.assertLessEqual(
                sum(path.stat().st_size for archive in archives for path in archive.iterdir()),
                64 * 1024 * 1024,
            )
            for archive in archives:
                self.assertNotIn(
                    "direct-backend-build.log",
                    {item.name for item in archive.iterdir()},
                )

            backend._validated_package(
                backups[0], "retention fixture rollback after cleanup"
            )
            backend._validate_retention_archives(archive_root)
            backend._validated_package(
                package,
                "retention fixture current after cleanup",
                exclude_development_control=True,
            )

    def test_retention_discards_oversized_legacy_log_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            package, control, _toolchain = self._rotated_package_fixture(
                Path(directory), versions=2
            )
            current = backend._validated_package(
                package, "retention fixture current", exclude_development_control=True
            )
            backend._retain_package_backups(package, control, current[0], current[1])

            archive_root = control / backend.PACKAGE_RETENTION_ARCHIVE_DIRNAME
            archive = next(archive_root.glob(".backend-package-backup-*"))
            legacy_log = archive / "direct-backend-build.log"
            legacy_log_size = 64 * 1024 * 1024 + 1
            with legacy_log.open("wb") as stream:
                stream.truncate(legacy_log_size)
            digest = hashlib.sha256()
            zeroes = bytes(1024 * 1024)
            for _ in range(legacy_log_size // len(zeroes)):
                digest.update(zeroes)
            digest.update(zeroes[: legacy_log_size % len(zeroes)])
            log_digest = digest.hexdigest()

            manifest, _ = backend._read_json(
                archive / "retention.json", "legacy retention manifest"
            )
            manifest["metadata"] = [
                record
                for record in manifest["metadata"]
                if record.get("path") != "direct-backend-build.log"
            ]
            manifest["metadata"].append(
                {
                    "path": "direct-backend-build.log",
                    "size": legacy_log_size,
                    "sha256": log_digest,
                }
            )
            backend._write_json(archive / "retention.json", manifest, "legacy retention manifest")

            backend._retain_package_backups(package, control, current[0], current[1])

            self.assertFalse(archive.exists())
            self.assertEqual(
                len(
                    list(
                        (control / backend.PACKAGE_BACKUPS_DIRNAME).glob(
                            ".backend-package-backup-*"
                        )
                    )
                ),
                1,
            )

    def test_retention_preserves_archives_and_rollback_when_archive_is_corrupt(self):
        with tempfile.TemporaryDirectory() as directory:
            package, control, _toolchain = self._rotated_package_fixture(
                Path(directory), versions=3
            )
            current = backend._validated_package(
                package, "retention fixture current", exclude_development_control=True
            )
            backend._retain_package_backups(package, control, current[0], current[1])

            backups_root = control / backend.PACKAGE_BACKUPS_DIRNAME
            archive_root = control / backend.PACKAGE_RETENTION_ARCHIVE_DIRNAME
            before_backups = {path.name for path in backups_root.iterdir()}
            before_archives = {path.name for path in archive_root.iterdir()}
            archive = next(archive_root.glob(".backend-package-backup-*"))
            manifest, _ = backend._read_json(
                archive / "retention.json", "retention manifest"
            )
            manifest["receipt_sha256"] = "0" * 64
            backend._write_json(
                archive / "retention.json", manifest, "tampered retention manifest"
            )

            with self.assertRaises(backend.BackendBuildError):
                backend._retain_package_backups(package, control, current[0], current[1])

            self.assertEqual({path.name for path in backups_root.iterdir()}, before_backups)
            self.assertEqual({path.name for path in archive_root.iterdir()}, before_archives)

    def test_retention_retries_after_archive_commit_without_losing_backup_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            package, control, _toolchain = self._rotated_package_fixture(Path(directory), versions=3)
            current = backend._validated_package(
                package, "retention fixture current", exclude_development_control=True
            )
            failed = False

            def fail_first_backup_retirement(source, target, backup_name):
                nonlocal failed
                if not failed:
                    failed = True
                    raise backend.BackendBuildError("injected backup retirement failure")
                return original_rename(source, target, backup_name)

            original_rename = backend._rename_backup_to_tombstone
            with patch.object(backend, "_rename_backup_to_tombstone", side_effect=fail_first_backup_retirement):
                with self.assertRaises(backend.BackendBuildError):
                    backend._retain_package_backups(package, control, current[0], current[1])
            self.assertEqual(
                len(
                    list(
                        (control / backend.PACKAGE_RETENTION_ARCHIVE_DIRNAME).glob(
                            ".backend-package-backup-*"
                        )
                    )
                ),
                1,
            )
            self.assertEqual(
                len(
                    list(
                        (control / backend.PACKAGE_BACKUPS_DIRNAME).glob(
                            ".backend-package-backup-*"
                        )
                    )
                ),
                3,
            )
            backend._retain_package_backups(package, control, current[0], current[1])
            self.assertEqual(
                len(
                    list(
                        (control / backend.PACKAGE_BACKUPS_DIRNAME).glob(
                            ".backend-package-backup-*"
                        )
                    )
                ),
                1,
            )
            self.assertEqual(
                len(
                    list(
                        (control / backend.PACKAGE_RETENTION_ARCHIVE_DIRNAME).glob(
                            ".backend-package-backup-*"
                        )
                    )
                ),
                2,
            )

    def test_retention_rejects_mismatched_chain_childsets(self):
        with tempfile.TemporaryDirectory() as directory:
            package, control, _toolchain = self._rotated_package_fixture(Path(directory), versions=3)
            backups = sorted(
                (control / backend.PACKAGE_BACKUPS_DIRNAME).glob(
                    ".backend-package-backup-*"
                )
            )
            parsed = [
                (backup, json.loads((backup / "rotation.json").read_text(encoding="utf-8")))
                for backup in backups
            ]
            current = backend._validated_package(
                package, "retention fixture current", exclude_development_control=True
            )
            direct = next(
                item
                for item in parsed
                if item[1]["new_receipt_sha256"] == backend._sha256_bytes(current[1])
            )
            older = next(
                item
                for item in parsed
                if item[1]["new_receipt_sha256"] == direct[1]["old_receipt_sha256"]
            )
            tampered = dict(older[1])
            tampered["new_children"] = tampered["new_children"][:-1]
            backend._write_json(
                older[0] / "rotation.json", tampered, "tampered retention rotation"
            )
            with self.assertRaises(backend.BackendBuildError):
                backend._retain_package_backups(package, control, current[0], current[1])
            self.assertEqual(
                len(
                    list(
                        (control / backend.PACKAGE_BACKUPS_DIRNAME).glob(
                            ".backend-package-backup-*"
                        )
                    )
                ),
                3,
            )

    def test_retention_rejects_archive_missing_receipt_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            package, control, _toolchain = self._rotated_package_fixture(Path(directory), versions=3)
            current = backend._validated_package(
                package, "retention fixture current", exclude_development_control=True
            )
            backend._retain_package_backups(package, control, current[0], current[1])
            archive = next(
                (control / backend.PACKAGE_RETENTION_ARCHIVE_DIRNAME).glob(
                    ".backend-package-backup-*"
                )
            )
            (archive / "backend-build-receipt.json").unlink()
            manifest, _ = backend._read_json(archive / "retention.json", "retention manifest")
            manifest["metadata"] = [
                record
                for record in manifest["metadata"]
                if record["path"] != "backend-build-receipt.json"
            ]
            backend._write_json(archive / "retention.json", manifest, "tampered retention manifest")
            with self.assertRaises(backend.BackendBuildError):
                backend._validate_retention_archives(
                    control / backend.PACKAGE_RETENTION_ARCHIVE_DIRNAME
                )

    def test_retention_rejects_archive_unbound_receipt_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            package, control, _toolchain = self._rotated_package_fixture(Path(directory), versions=3)
            current = backend._validated_package(
                package, "retention fixture current", exclude_development_control=True
            )
            backend._retain_package_backups(package, control, current[0], current[1])
            archive = next(
                (control / backend.PACKAGE_RETENTION_ARCHIVE_DIRNAME).glob(
                    ".backend-package-backup-*"
                )
            )
            manifest, _ = backend._read_json(archive / "retention.json", "retention manifest")
            manifest["receipt_sha256"] = "0" * 64
            backend._write_json(archive / "retention.json", manifest, "tampered retention manifest")
            with self.assertRaises(backend.BackendBuildError):
                backend._validate_retention_archives(
                    control / backend.PACKAGE_RETENTION_ARCHIVE_DIRNAME
                )

    def test_retention_archive_copy_failure_preserves_original_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            package, control, _toolchain = self._rotated_package_fixture(Path(directory), versions=3)
            current = backend._validated_package(
                package, "retention fixture current", exclude_development_control=True
            )
            backups_root = control / backend.PACKAGE_BACKUPS_DIRNAME
            before = {
                backup.name: {
                    filename: (backup / filename).read_bytes()
                    for filename in ("backend-build-receipt.json", "rotation.json")
                }
                for backup in backups_root.glob(".backend-package-backup-*")
            }
            with patch.object(
                backend,
                "_copy_regular_file_fsync",
                side_effect=backend.BackendBuildError("injected archive copy failure"),
            ):
                with self.assertRaises(backend.BackendBuildError):
                    backend._retain_package_backups(package, control, current[0], current[1])
            after = {
                backup.name: {
                    filename: (backup / filename).read_bytes()
                    for filename in ("backend-build-receipt.json", "rotation.json")
                }
                for backup in backups_root.glob(".backend-package-backup-*")
            }
            self.assertEqual(after, before)
            self.assertEqual(
                list((control / backend.PACKAGE_RETENTION_ARCHIVE_DIRNAME).iterdir()), []
            )

    def test_retention_archive_fsync_failure_preserves_original_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            package, control, _toolchain = self._rotated_package_fixture(Path(directory), versions=3)
            current = backend._validated_package(
                package, "retention fixture current", exclude_development_control=True
            )
            backups_root = control / backend.PACKAGE_BACKUPS_DIRNAME
            before = {
                backup.name: {
                    filename: (backup / filename).read_bytes()
                    for filename in ("backend-build-receipt.json", "rotation.json")
                }
                for backup in backups_root.glob(".backend-package-backup-*")
            }
            original_fsync_directory = backend._fsync_directory

            def fail_archive_staging_fsync(path, name):
                if name == "backend package retention staging directory":
                    raise backend.BackendBuildError("injected archive fsync failure")
                return original_fsync_directory(path, name)

            with patch.object(backend, "_fsync_directory", side_effect=fail_archive_staging_fsync):
                with self.assertRaises(backend.BackendBuildError):
                    backend._retain_package_backups(package, control, current[0], current[1])
            after = {
                backup.name: {
                    filename: (backup / filename).read_bytes()
                    for filename in ("backend-build-receipt.json", "rotation.json")
                }
                for backup in backups_root.glob(".backend-package-backup-*")
            }
            self.assertEqual(after, before)
            self.assertEqual(
                list((control / backend.PACKAGE_RETENTION_ARCHIVE_DIRNAME).iterdir()), []
            )

    def test_retention_retained_tree_fsync_failure_deletes_no_obsolete_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            package, control, _toolchain = self._rotated_package_fixture(Path(directory), versions=3)
            current = backend._validated_package(
                package, "retention fixture current", exclude_development_control=True
            )
            backups_root = control / backend.PACKAGE_BACKUPS_DIRNAME
            before = {
                backup.name
                for backup in backups_root.glob(".backend-package-backup-*")
            }
            original_fsync_owned_tree = backend._fsync_owned_tree

            def fail_retained_tree_fsync(path, name, *, excluded_children=frozenset()):
                if name == "current backend package retained tree":
                    raise backend.BackendBuildError("injected retained tree fsync failure")
                return original_fsync_owned_tree(
                    path, name, excluded_children=excluded_children
                )

            with (
                patch.object(backend, "_fsync_owned_tree", side_effect=fail_retained_tree_fsync),
                patch.object(backend, "_remove_owned_tree", wraps=backend._remove_owned_tree) as remove,
            ):
                with self.assertRaises(backend.BackendBuildError):
                    backend._retain_package_backups(package, control, current[0], current[1])
            self.assertEqual(
                {backup.name for backup in backups_root.glob(".backend-package-backup-*")},
                before,
            )
            remove.assert_not_called()
            self.assertEqual(
                list((control / backend.PACKAGE_RETENTION_ARCHIVE_DIRNAME).iterdir()), []
            )

    def test_retention_preserves_unknown_backup_and_reports_without_deletion(self):
        with tempfile.TemporaryDirectory() as directory:
            package, control, _toolchain = self._rotated_package_fixture(Path(directory), versions=2)
            unknown = control / backend.PACKAGE_BACKUPS_DIRNAME / "foreign-backup"
            unknown.mkdir()
            (unknown / "marker").write_text("unknown\n", encoding="utf-8")
            current = backend._validated_package(
                package, "retention fixture current", exclude_development_control=True
            )
            with self.assertRaises(backend.BackendBuildError):
                backend._retain_package_backups(package, control, current[0], current[1])
            self.assertTrue(unknown.exists())
            self.assertEqual(
                len(
                    list(
                        (control / backend.PACKAGE_RETENTION_ARCHIVE_DIRNAME).iterdir()
                    )
                ),
                0,
            )

    def test_retention_rejects_unrecorded_nested_backup_entries(self):
        for relative, is_directory in (
            ("bin/foreign-result.dat", False),
            ("unexpected-empty", True),
        ):
            with self.subTest(relative=relative), tempfile.TemporaryDirectory() as directory:
                package, control, _toolchain = self._rotated_package_fixture(
                    Path(directory), versions=3
                )
                backups_root = control / backend.PACKAGE_BACKUPS_DIRNAME
                backups = sorted(backups_root.glob(".backend-package-backup-*"))
                target = backups[0] / relative
                if is_directory:
                    target.mkdir()
                else:
                    target.write_bytes(b"foreign result\n")
                current = backend._validated_package(
                    package, "retention fixture current", exclude_development_control=True
                )
                before = {backup.name for backup in backups}
                with self.assertRaises(backend.BackendBuildError):
                    backend._retain_package_backups(package, control, current[0], current[1])
                self.assertEqual(
                    {backup.name for backup in backups_root.glob(".backend-package-backup-*")},
                    before,
                )
                self.assertTrue(target.exists())
                self.assertEqual(
                    list((control / backend.PACKAGE_RETENTION_ARCHIVE_DIRNAME).iterdir()), []
                )

    def test_retention_preserves_corrupt_backup_and_does_not_touch_current_package(self):
        with tempfile.TemporaryDirectory() as directory:
            package, control, _toolchain = self._rotated_package_fixture(Path(directory), versions=2)
            direct = next(
                (control / backend.PACKAGE_BACKUPS_DIRNAME).glob(
                    ".backend-package-backup-*"
                )
            )
            (direct / "rotation.json").write_text("{\"state\":\"tampered\"}\n", encoding="utf-8")
            current = backend._validated_package(
                package, "retention fixture current", exclude_development_control=True
            )
            before = {
                path.relative_to(package).as_posix(): path.read_bytes()
                for path in package.rglob("*")
                if path.is_file()
                and backend.PACKAGE_DEVELOPMENT_DIRNAME
                not in path.relative_to(package).parts
            }
            with self.assertRaises(backend.BackendBuildError):
                backend._retain_package_backups(package, control, current[0], current[1])
            after = {
                path.relative_to(package).as_posix(): path.read_bytes()
                for path in package.rglob("*")
                if path.is_file()
                and backend.PACKAGE_DEVELOPMENT_DIRNAME
                not in path.relative_to(package).parts
            }
            self.assertEqual(after, before)
            self.assertTrue(direct.exists())

    def test_start_rebuilds_when_fresh_source_identity_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            build_root = root / "build"
            build_root.mkdir()
            package, records = self._published_package(root)
            old_manifest_path, old_manifest = self._live_manifest(root, capture_id="old-capture")
            changed_manifest_path, changed_manifest = self._live_manifest(
                root, commit="b" * 40, capture_id="changed-capture"
            )
            toolchain = self._toolchain_fixture()
            backend._write_json(
                package / "backend-build-receipt.json",
                self._receipt_for_manifest(records, old_manifest, toolchain),
                "test backend build receipt",
            )
            provenance = root / "provenance.json"
            provenance.touch()
            original_package_root = backend.PACKAGE_ROOT
            original_provenance_path = backend.PROVENANCE_PATH
            backend.PACKAGE_ROOT = package
            backend.PROVENANCE_PATH = provenance

            def prepare_candidate(*args):
                candidate = args[2]
                workspace = self._package_workspace(root / "changed-candidate")
                candidate_records = self._copy_into_marked_candidate(
                    workspace, candidate, backend.PACKAGE_ROOT, args[1]
                )
                (candidate / "bin/fullmag-bin").write_bytes(b"changed source candidate\n")
                candidate_records = backend._hash_package(candidate)
                backend._write_candidate_marker(
                    candidate,
                    backend.PACKAGE_ROOT,
                    args[1],
                    state="ready",
                    records=candidate_records,
                )
                backend._write_json(
                    candidate / "backend-build-receipt.json",
                    self._receipt_for_manifest(candidate_records, changed_manifest, toolchain),
                    "test candidate receipt",
                )
                return 0

            try:
                stderr = io.StringIO()
                with (
                    patch.dict(os.environ, {"FULLMAG_BACKEND_CARGO_PROFILE": "backend-dev"}),
                    patch.object(
                        backend,
                        "_toolchain_identity",
                        return_value=(toolchain["image_id"], toolchain),
                    ),
                    patch.object(backend, "_capture_start_manifest", return_value=changed_manifest_path),
                    patch.object(backend, "_prepare_locked", side_effect=prepare_candidate) as prepare,
                    patch.object(backend, "_publish_runtime_provenance"),
                    patch.object(
                        backend,
                        "_retain_package_backups",
                        side_effect=backend.BackendBuildError("retention state is unknown"),
                    ) as retain,
                    patch.object(backend, "_serve", return_value=0) as serve,
                ):
                    with redirect_stderr(stderr):
                        self.assertEqual(
                            backend.main(["start", "--build-root", str(build_root)]),
                            0,
                        )
                prepare.assert_called_once()
                retain.assert_not_called()
                serve.assert_called_once_with([])
                self.assertIn(
                    "phase=retention state=deferred reason=outside-startup",
                    stderr.getvalue(),
                )
                self.assertNotEqual(
                    (package / "bin/fullmag-bin").read_bytes(), b"package\n"
                )
            finally:
                backend.PACKAGE_ROOT = original_package_root
                backend.PROVENANCE_PATH = original_provenance_path

    def test_start_rejects_corrupt_existing_artifact_before_reuse_or_api(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            build_root = root / "build"
            build_root.mkdir()
            package, records = self._published_package(root)
            manifest_path, manifest = self._live_manifest(root)
            toolchain = self._toolchain_fixture()
            backend._write_json(
                package / "backend-build-receipt.json",
                self._receipt_for_manifest(records, manifest, toolchain),
                "test backend build receipt",
            )
            (package / "bin/fullmag-bin").write_bytes(b"tampered\n")
            original_package_root = backend.PACKAGE_ROOT
            backend.PACKAGE_ROOT = package
            try:
                with (
                    patch.object(backend, "_toolchain_identity") as toolchain_identity,
                    patch.object(backend, "_capture_start_manifest") as capture,
                    patch.object(backend, "_prepare_locked") as prepare,
                    patch.object(backend, "_serve") as serve,
                ):
                    self.assertEqual(
                        backend.main(["start", "--build-root", str(build_root)]),
                        2,
                    )
                toolchain_identity.assert_not_called()
                capture.assert_not_called()
                prepare.assert_not_called()
                serve.assert_not_called()
            finally:
                backend.PACKAGE_ROOT = original_package_root

    def test_storage_probe_bypasses_missing_package_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package = root / "package"
            package.mkdir()
            original_package_root = backend.PACKAGE_ROOT
            backend.PACKAGE_ROOT = package
            try:
                with (
                    patch.object(backend.os, "execvpe") as execvpe,
                    patch.object(backend, "_prepare_locked") as prepare,
                ):
                    self.assertEqual(backend.main(["serve", "--storage-probe"]), 0)
                    execvpe.assert_called_once()
                    prepare.assert_not_called()
                    self.assertEqual(
                        execvpe.call_args.args[1][1:],
                        ["/opt/fullmag/entrypoint.py", "--storage-probe"],
                    )
                    self.assertEqual(
                        execvpe.call_args.args[2]["FULLMAG_DOCKER_ROLE"], "backend"
                    )
                with patch.object(backend.os, "execvpe") as ordinary_exec:
                    self.assertEqual(backend.main(["serve"]), 2)
                    ordinary_exec.assert_not_called()
            finally:
                backend.PACKAGE_ROOT = original_package_root

    def _windows_folder_development_gate_fixture(self, root):
        package = root / "package"
        package.mkdir()
        host_path = root / "windows-folder-host.json"
        owner_path = root / "windows-folder-owner.json"
        image_id = "sha256:" + "a" * 64
        toolchain_image_id = "sha256:" + "b" * 64
        group_identity = "fullmag-dev"
        provenance = {
            "schema": "fullmag.docker-all-image.v1",
            "state": "succeeded",
            "cargo_profile": backend.BACKEND_CARGO_PROFILE,
            "toolchain_image_id": toolchain_image_id,
            "package_root": str(package),
        }
        development_build = {
            "schema": backend.WINDOWS_FOLDER_DEVELOPMENT_SCHEMA,
            "cargo_profile": backend.BACKEND_CARGO_PROFILE,
            "toolchain_image_id": toolchain_image_id,
            "package_root": str(package),
            "provenance_path": str(root / "provenance.json"),
            "group_identity": group_identity,
            "source_identity": {
                # Bootstrap evidence is deliberately different from the
                # current build identity; the Rust verifier binds the latter
                # to the current provenance and receipt instead.
                "commit": "c" * 40,
                "source_digest": "d" * 64,
                "source_snapshot_sha256": "e" * 64,
                "native_source_identity_sha256": "f" * 64,
            },
        }
        host = {
            "schema": backend.WINDOWS_FOLDER_HOST_SCHEMA,
            "storage_profile": backend.WINDOWS_FOLDER_STORAGE_PROFILE,
            "role": "session",
            "owner_scope": "docker-desktop-linux",
            "image_id": image_id,
            "owner_token": "owner-token",
            "restart_verified": True,
            "development_build": development_build,
        }
        return (
            package,
            host_path,
            owner_path,
            host,
            provenance,
            "1" * 64,
            {
                "FULLMAG_RUNTIME_IMAGE_ID": image_id,
                "FULLMAG_TOOLCHAIN_IMAGE_ID": toolchain_image_id,
                "FULLMAG_COMPOSE_PROJECT": group_identity,
            },
        )

    def test_linux_development_gate_binds_source_package_group_and_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package, _, _, host, provenance, digest, environment = self._windows_folder_development_gate_fixture(root)
            provenance["build_receipt_sha256"] = digest
            with (patch.dict(os.environ, environment, clear=True),
                  patch.object(backend, "PACKAGE_ROOT", package),
                  patch.object(backend, "PROVENANCE_PATH", root / "provenance.json")):
                backend._validate_linux_native_build(host, provenance, digest)
                for field, value in (("group_identity", "other-group"),
                                     ("toolchain_image_id", "sha256:" + "9" * 64),
                                     ("source_identity", {"commit": "bad"})):
                    altered = json.loads(json.dumps(host))
                    altered["development_build"][field] = value
                    with self.subTest(field=field), self.assertRaises(backend.BackendBuildError):
                        backend._validate_linux_native_build(altered, provenance, digest)
                with self.assertRaises(backend.BackendBuildError):
                    backend._validate_linux_native_build(host, provenance, "0" * 64)
                with self.assertRaises(backend.BackendBuildError):
                    backend._validate_linux_native_build({}, provenance, digest)

    def test_windows_folder_development_gate_accepts_matching_certificate(self):
        with tempfile.TemporaryDirectory() as directory:
            (
                package,
                host_path,
                owner_path,
                host,
                provenance,
                receipt_sha256,
                environment,
            ) = self._windows_folder_development_gate_fixture(Path(directory))
            backend._write_json(host_path, host, "test Windows-folder host certificate")
            backend._write_json(owner_path, host, "test Windows-folder owner marker")
            with (
                patch.object(backend, "PACKAGE_ROOT", package),
                patch.object(backend, "PROVENANCE_PATH", package.parent / "provenance.json"),
                patch.object(backend, "HOST_ATTESTATION_PATH", host_path),
                patch.object(backend, "WINDOWS_FOLDER_OWNER_PATH", owner_path),
                patch.dict(os.environ, environment, clear=False),
            ):
                backend._wait_for_windows_folder_attestation(provenance, receipt_sha256)

    def test_windows_folder_development_gate_times_out_without_certificate(self):
        with tempfile.TemporaryDirectory() as directory:
            (
                package,
                host_path,
                owner_path,
                _host,
                provenance,
                receipt_sha256,
                environment,
            ) = self._windows_folder_development_gate_fixture(Path(directory))
            with (
                patch.object(backend, "PACKAGE_ROOT", package),
                patch.object(backend, "PROVENANCE_PATH", package.parent / "provenance.json"),
                patch.object(backend, "HOST_ATTESTATION_PATH", host_path),
                patch.object(backend, "WINDOWS_FOLDER_OWNER_PATH", owner_path),
                patch.object(backend, "WINDOWS_FOLDER_GATE_TIMEOUT_SECONDS", 0.0),
                patch.dict(os.environ, environment, clear=False),
            ):
                with self.assertRaisesRegex(
                    backend.BackendBuildError,
                    "timed out waiting for a matching Windows-folder host attestation",
                ):
                    backend._wait_for_windows_folder_attestation(provenance, receipt_sha256)

    def test_windows_folder_development_gate_rejects_certificate_conflict(self):
        with tempfile.TemporaryDirectory() as directory:
            (
                package,
                host_path,
                owner_path,
                host,
                provenance,
                receipt_sha256,
                environment,
            ) = self._windows_folder_development_gate_fixture(Path(directory))
            backend._write_json(host_path, host, "test Windows-folder host certificate")
            conflicting_owner = dict(host)
            conflicting_owner["owner_token"] = "different-owner-token"
            backend._write_json(
                owner_path, conflicting_owner, "test Windows-folder owner marker"
            )
            with (
                patch.object(backend, "PACKAGE_ROOT", package),
                patch.object(backend, "PROVENANCE_PATH", package.parent / "provenance.json"),
                patch.object(backend, "HOST_ATTESTATION_PATH", host_path),
                patch.object(backend, "WINDOWS_FOLDER_OWNER_PATH", owner_path),
                patch.dict(os.environ, environment, clear=False),
            ):
                with self.assertRaisesRegex(
                    backend.BackendBuildError,
                    "host certificate and owner marker differ",
                ):
                    backend._wait_for_windows_folder_attestation(provenance, receipt_sha256)

    def test_host_attestation_read_racing_an_in_place_write_is_pending(self):
        with tempfile.TemporaryDirectory() as directory:
            host_path = Path(directory) / "windows-folder-host.json"
            host_path.write_text('{"schema": "x"}\n', encoding="utf-8")
            with patch.object(
                backend,
                "_read_json",
                side_effect=backend.BackendBuildError(
                    "Windows-folder host attestation changed while reading"
                ),
            ):
                self.assertIsNone(
                    backend._read_optional_storage_attestation(
                        host_path, "Windows-folder host attestation"
                    )
                )
            with patch.object(
                backend,
                "_read_json",
                side_effect=backend.BackendBuildError("Windows-folder host attestation is not one file"),
            ):
                with self.assertRaises(backend.BackendBuildError):
                    backend._read_optional_storage_attestation(
                        host_path, "Windows-folder host attestation"
                    )

    def test_windows_folder_development_gate_retries_restart_flag_publication_race(self):
        with tempfile.TemporaryDirectory() as directory:
            (
                package,
                host_path,
                owner_path,
                host,
                provenance,
                receipt_sha256,
                environment,
            ) = self._windows_folder_development_gate_fixture(Path(directory))
            host_before_restart_readback = dict(host)
            host_before_restart_readback["restart_verified"] = False
            backend._write_json(
                host_path,
                host_before_restart_readback,
                "test Windows-folder host certificate",
            )
            backend._write_json(owner_path, host, "test Windows-folder owner marker")
            with (
                patch.object(backend, "PACKAGE_ROOT", package),
                patch.object(backend, "PROVENANCE_PATH", package.parent / "provenance.json"),
                patch.object(backend, "HOST_ATTESTATION_PATH", host_path),
                patch.object(backend, "WINDOWS_FOLDER_OWNER_PATH", owner_path),
                patch.object(backend, "WINDOWS_FOLDER_GATE_TIMEOUT_SECONDS", 0.0),
                patch.dict(os.environ, environment, clear=False),
            ):
                with self.assertRaisesRegex(
                    backend.BackendBuildError,
                    "timed out waiting for a matching Windows-folder host attestation",
                ):
                    backend._wait_for_windows_folder_attestation(provenance, receipt_sha256)

    def test_windows_folder_development_gate_retries_bootstrap_to_live_audit_publication(self):
        with tempfile.TemporaryDirectory() as directory:
            (
                package,
                _host_path,
                _owner_path,
                host,
                provenance,
                receipt_sha256,
                environment,
            ) = self._windows_folder_development_gate_fixture(Path(directory))
            bootstrap = dict(host)
            bootstrap.update(
                source_commit="0" * 40,
                binary_hashes={"fullmag-api": "0" * 64},
                artifact_receipt_sha256="0" * 64,
                restart_verified=False,
            )
            bootstrap_delegation = dict(bootstrap["development_build"])
            bootstrap_delegation["source_identity"] = {
                "commit": "0" * 40,
                "source_digest": "0" * 64,
                "source_snapshot_sha256": "0" * 64,
                "native_source_identity_sha256": "0" * 64,
            }
            bootstrap["development_build"] = bootstrap_delegation

            live = dict(bootstrap)
            live.update(
                source_commit="1" * 40,
                binary_hashes={"fullmag-api": "2" * 64},
                artifact_receipt_sha256="3" * 64,
            )
            live_delegation = dict(bootstrap_delegation)
            live_delegation["source_identity"] = {
                "commit": "4" * 40,
                "source_digest": "5" * 64,
                "source_snapshot_sha256": "6" * 64,
                "native_source_identity_sha256": "7" * 64,
            }
            live["development_build"] = live_delegation

            with (
                patch.object(backend, "PACKAGE_ROOT", package),
                patch.object(backend, "PROVENANCE_PATH", package.parent / "provenance.json"),
                patch.dict(os.environ, environment, clear=False),
            ):
                self.assertEqual(
                    backend._validate_windows_folder_attestation(
                        live, bootstrap, provenance, receipt_sha256
                    ),
                    "pending",
                )
                live_verified = dict(live)
                live_verified["restart_verified"] = True
                self.assertEqual(
                    backend._validate_windows_folder_attestation(
                        live_verified, live_verified, provenance, receipt_sha256
                    ),
                    "ready",
                )
                bootstrap_verified = dict(bootstrap)
                bootstrap_verified["restart_verified"] = True
                with self.assertRaisesRegex(
                    backend.BackendBuildError,
                    "host certificate and owner marker differ",
                ):
                    backend._validate_windows_folder_attestation(
                        live_verified, bootstrap_verified, provenance, receipt_sha256
                    )

    def test_start_capture_reads_current_worktree_git_file_and_refreshes_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repository = root / "repository"
            repository.mkdir()

            def git(*arguments):
                subprocess.run(
                    ["git", "-C", str(repository), *arguments],
                    check=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )

            git("init", "--quiet")
            git("config", "user.email", "test@example.invalid")
            git("config", "user.name", "Fullmag test")
            source_file = repository / "src" / "main.rs"
            source_file.parent.mkdir()
            source_file.write_text("pub fn value() -> u8 { 1 }\n", encoding="utf-8")
            git("add", "src/main.rs")
            git("commit", "--quiet", "-m", "fixture")
            worktree = root / "worktree"
            subprocess.run(
                ["git", "-C", str(repository), "worktree", "add", "--quiet", "--detach", str(worktree), "HEAD"],
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            live_file = worktree / "src" / "main.rs"
            live_file.write_text("pub fn value() -> u8 { 2 }\n", encoding="utf-8")
            build_root = root / "build"
            build_root.mkdir()
            common_root = repository / ".git"

            first_path = backend.capture_live_source_manifest(worktree, common_root, build_root)
            first_document = json.loads(first_path.read_text(encoding="utf-8"))
            backend._validate_live_manifest(first_document)
            first_entry = next(
                entry for entry in first_document["source_manifest"]["files"]
                if entry["path"] == "src/main.rs"
            )
            self.assertEqual(first_entry["sha256"], hashlib.sha256(live_file.read_bytes()).hexdigest())
            self.assertEqual(first_document["source_root"], str(worktree))
            self.assertEqual(first_document["git_common_dir"], str(common_root))

            live_file.write_text("pub fn value() -> u8 { 3 }\n", encoding="utf-8")
            second_path = backend.capture_live_source_manifest(worktree, common_root, build_root)
            second_document = json.loads(second_path.read_text(encoding="utf-8"))
            second_entry = next(
                entry for entry in second_document["source_manifest"]["files"]
                if entry["path"] == "src/main.rs"
            )
            self.assertNotEqual(first_document["source_digest"], second_document["source_digest"])
            self.assertNotEqual(first_entry["sha256"], second_entry["sha256"])
            self.assertEqual(second_entry["sha256"], hashlib.sha256(live_file.read_bytes()).hexdigest())

    def test_start_does_not_serve_after_a_failed_prepare(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            build_root = root / "build"
            build_root.mkdir()
            package = root / "package"
            package.mkdir()
            original_package_root = backend.PACKAGE_ROOT
            backend.PACKAGE_ROOT = package
            try:
                with (
                    patch.dict(os.environ, {"FULLMAG_BACKEND_CARGO_PROFILE": "backend-dev"}),
                    patch.object(
                        backend,
                        "_toolchain_identity",
                        return_value=(
                            "sha256:" + "a" * 64,
                            {"image_id": "sha256:" + "a" * 64},
                        ),
                    ),
                    patch.object(
                        backend,
                        "_prepare_locked",
                        side_effect=backend.BackendBuildError("prepare failed"),
                    ),
                    patch.object(
                        backend,
                        "_capture_start_manifest",
                        return_value=Path("/build/live-source/manifest.json"),
                    ),
                    patch.object(backend, "_serve") as serve,
                ):
                    self.assertEqual(
                        backend.main(
                            [
                                "start",
                                "--manifest",
                                "/input/manifest.json",
                                "--build-root",
                                str(build_root),
                            ]
                        ),
                        2,
                    )
                serve.assert_not_called()
            finally:
                backend.PACKAGE_ROOT = original_package_root

    def test_failed_restart_keeps_the_previous_package_byte_exact(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            build_root = root / "build"
            build_root.mkdir()
            package = root / "package"
            package.mkdir()
            original_package_root = backend.PACKAGE_ROOT
            backend.PACKAGE_ROOT = package
            calls = 0

            def prepare_candidate(*args):
                nonlocal calls
                calls += 1
                candidate = args[2]
                if calls == 2:
                    (candidate / "bin").mkdir()
                    (candidate / "bin/fullmag-api.new").write_bytes(b"partial install")
                    log = backend._begin_failed_make_attempt(args[1], candidate, "install-cli-dev")
                    log.write_bytes(b"compiler failed after a partial install\n")
                    backend._finish_failed_make_attempt(args[1], candidate, 7)
                    raise backend.BackendBuildError("candidate build failed")
                workspace = self._package_workspace(root / f"candidate-{calls}")
                records = self._copy_into_marked_candidate(
                    workspace, candidate, backend.PACKAGE_ROOT, args[1]
                )
                backend._write_json(
                    candidate / "backend-build-receipt.json",
                    {
                        "schema": backend.RECEIPT_SCHEMA,
                        "state": "succeeded",
                        "execution_lanes": {
                            lane: {"status": "compiled"} for lane in backend.LANES
                        },
                        "artifacts": records,
                    },
                    "test candidate receipt",
                )
                return 0

            try:
                with (
                    patch.dict(os.environ, {"FULLMAG_BACKEND_CARGO_PROFILE": "backend-dev"}),
                    patch.object(
                        backend,
                        "_toolchain_identity",
                        return_value=(
                            "sha256:" + "a" * 64,
                            {"image_id": "sha256:" + "a" * 64},
                        ),
                    ),
                    patch.object(backend, "_prepare_locked", side_effect=prepare_candidate),
                    patch.object(
                        backend,
                        "_capture_start_manifest",
                        return_value=Path("/build/live-source/manifest.json"),
                    ),
                    patch.object(backend, "_publish_runtime_provenance"),
                    patch.object(backend, "_serve", return_value=0) as serve,
                ):
                    command = [
                        "start",
                        "--manifest",
                        "/input/manifest.json",
                        "--build-root",
                        str(build_root),
                    ]
                    self.assertEqual(backend.main(command), 0)
                    before = {
                        path.relative_to(package).as_posix(): path.read_bytes()
                        for path in package.rglob("*")
                        if path.is_file()
                        and backend.PACKAGE_DEVELOPMENT_DIRNAME
                        not in path.relative_to(package).parts
                    }
                    self.assertEqual(backend.main(command), 2)
                    retained = {
                        path.relative_to(package).as_posix(): path.read_bytes()
                        for path in package.rglob("*")
                        if path.is_file()
                        and backend.PACKAGE_DEVELOPMENT_DIRNAME
                        not in path.relative_to(package).parts
                    }
                    self.assertEqual(retained, before)
                    # The same container start can retry after the source fix;
                    # the failed candidate does not require manual deletion.
                    self.assertEqual(backend.main(command), 0)
                after = {
                    path.relative_to(package).as_posix(): path.read_bytes()
                    for path in package.rglob("*")
                    if path.is_file()
                    and backend.PACKAGE_DEVELOPMENT_DIRNAME
                    not in path.relative_to(package).parts
                }
                self.assertEqual(after, before)
                self.assertEqual(calls, 3)
                self.assertEqual(serve.call_count, 2)
                self.assertFalse(
                    list(
                        (
                            package
                            / backend.PACKAGE_DEVELOPMENT_DIRNAME
                            / backend.PACKAGE_CANDIDATES_DIRNAME
                        ).glob(".backend-package-candidate-*")
                    )
                )
            finally:
                backend.PACKAGE_ROOT = original_package_root

    def test_start_rejects_noncanonical_package_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            build_root = root / "build"
            build_root.mkdir()
            package = root / "package"
            package.mkdir()
            original_package_root = backend.PACKAGE_ROOT
            backend.PACKAGE_ROOT = package
            try:
                with patch.object(backend, "_toolchain_identity") as toolchain:
                    self.assertEqual(
                        backend.main(
                            [
                                "start",
                                "--manifest",
                                "/input/manifest.json",
                                "--output",
                                str(root / "other-package"),
                                "--build-root",
                                str(build_root),
                            ]
                        ),
                        2,
                    )
                toolchain.assert_not_called()
            finally:
                backend.PACKAGE_ROOT = original_package_root

    def test_start_rejects_an_unverified_existing_package_mount(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            build_root = root / "build"
            build_root.mkdir()
            package = root / "package"
            package.mkdir()
            retained = package / "backend-build-receipt.json"
            retained_bytes = b"unverified receipt"
            retained.write_bytes(retained_bytes)
            original_package_root = backend.PACKAGE_ROOT
            backend.PACKAGE_ROOT = package
            try:
                with (
                    patch.dict(os.environ, {"FULLMAG_BACKEND_CARGO_PROFILE": "backend-dev"}),
                    patch.object(backend, "_toolchain_identity") as toolchain,
                    patch.object(backend, "_prepare_locked") as prepare,
                    patch.object(backend, "_serve") as serve,
                ):
                    self.assertEqual(
                        backend.main(
                            [
                                "start",
                                "--manifest",
                                "/input/manifest.json",
                                "--build-root",
                                str(build_root),
                            ]
                        ),
                        2,
                    )
                toolchain.assert_not_called()
                prepare.assert_not_called()
                serve.assert_not_called()
                self.assertEqual(retained.read_bytes(), retained_bytes)
            finally:
                backend.PACKAGE_ROOT = original_package_root

    def test_start_rejects_unowned_package_development_control(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            build_root = root / "build"
            build_root.mkdir()
            package = root / "package"
            control = package / backend.PACKAGE_DEVELOPMENT_DIRNAME
            (control / "foreign").mkdir(parents=True)
            original_package_root = backend.PACKAGE_ROOT
            backend.PACKAGE_ROOT = package
            try:
                with (
                    patch.dict(os.environ, {"FULLMAG_BACKEND_CARGO_PROFILE": "backend-dev"}),
                    patch.object(backend, "_toolchain_identity") as toolchain,
                    patch.object(backend, "_prepare_locked") as prepare,
                    patch.object(backend, "_serve") as serve,
                ):
                    self.assertEqual(
                        backend.main(
                            [
                                "start",
                                "--manifest",
                                "/input/manifest.json",
                                "--build-root",
                                str(build_root),
                            ]
                        ),
                        2,
                    )
                toolchain.assert_not_called()
                prepare.assert_not_called()
                serve.assert_not_called()
            finally:
                backend.PACKAGE_ROOT = original_package_root

    def test_start_does_not_serve_after_a_failed_package_publication(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            build_root = root / "build"
            build_root.mkdir()
            package = root / "package"
            package.mkdir()
            original_package_root = backend.PACKAGE_ROOT
            backend.PACKAGE_ROOT = package
            prepare_calls = 0

            def prepare_candidate(*args):
                nonlocal prepare_calls
                prepare_calls += 1
                candidate = args[2]
                workspace = self._package_workspace(root / f"publication-{prepare_calls}")
                records = self._copy_into_marked_candidate(
                    workspace, candidate, backend.PACKAGE_ROOT, args[1]
                )
                if prepare_calls == 2:
                    binary = candidate / "bin/fullmag-bin"
                    binary.write_bytes(b"changed candidate\n")
                    records = backend._hash_package(candidate)
                    backend._write_candidate_marker(
                        candidate,
                        backend.PACKAGE_ROOT,
                        args[1],
                        state="ready",
                        records=records,
                    )
                backend._write_json(
                    candidate / "backend-build-receipt.json",
                    {
                        "schema": backend.RECEIPT_SCHEMA,
                        "state": "succeeded",
                        "execution_lanes": {
                            lane: {"status": "compiled"} for lane in backend.LANES
                        },
                        "artifacts": records,
                    },
                    "test candidate receipt",
                )
                return 0

            original_rename = backend._rename_package_child

            def fail_second_publication(source_root, target_root, name, label):
                if prepare_calls == 2 and label == "candidate package":
                    raise backend.BackendBuildError("injected publication failure")
                return original_rename(source_root, target_root, name, label)

            try:
                with (
                    patch.dict(os.environ, {"FULLMAG_BACKEND_CARGO_PROFILE": "backend-dev"}),
                    patch.object(
                        backend,
                        "_toolchain_identity",
                        return_value=(
                            "sha256:" + "a" * 64,
                            {"image_id": "sha256:" + "a" * 64},
                        ),
                    ),
                    patch.object(backend, "_prepare_locked", side_effect=prepare_candidate),
                    patch.object(
                        backend,
                        "_capture_start_manifest",
                        return_value=Path("/build/live-source/manifest.json"),
                    ),
                    patch.object(backend, "_publish_runtime_provenance"),
                    patch.object(backend, "_rename_package_child", side_effect=fail_second_publication),
                    patch.object(backend, "_serve", return_value=0) as serve,
                ):
                    command = [
                        "start",
                        "--manifest",
                        "/input/manifest.json",
                        "--build-root",
                        str(build_root),
                    ]
                    self.assertEqual(backend.main(command), 0)
                    before = {
                        path.relative_to(package).as_posix(): path.read_bytes()
                        for path in package.rglob("*")
                        if path.is_file()
                        and backend.PACKAGE_DEVELOPMENT_DIRNAME
                        not in path.relative_to(package).parts
                    }
                    self.assertEqual(backend.main(command), 2)
                after = {
                    path.relative_to(package).as_posix(): path.read_bytes()
                    for path in package.rglob("*")
                    if path.is_file()
                    and backend.PACKAGE_DEVELOPMENT_DIRNAME
                    not in path.relative_to(package).parts
                }
                self.assertEqual(after, before)
                self.assertEqual(serve.call_count, 1)
                self.assertTrue(
                    list(
                        (
                            package
                            / backend.PACKAGE_DEVELOPMENT_DIRNAME
                            / backend.PACKAGE_CANDIDATES_DIRNAME
                        ).glob(".backend-package-candidate-*")
                    )
                )
                self.assertFalse(
                    list(
                        (
                            package
                            / backend.PACKAGE_DEVELOPMENT_DIRNAME
                            / backend.PACKAGE_BACKUPS_DIRNAME
                        ).glob(".backend-package-backup-*")
                    )
                )
            finally:
                backend.PACKAGE_ROOT = original_package_root

    def test_failed_provenance_publication_restores_previous_bytes_and_package(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            build_root = root / "build"
            build_root.mkdir()
            package = root / "package"
            package.mkdir()
            provenance = root / "provenance.json"
            previous_provenance = b'{"state":"previous"}\n'
            provenance.write_bytes(previous_provenance)
            original_package_root = backend.PACKAGE_ROOT
            original_provenance_path = backend.PROVENANCE_PATH
            backend.PACKAGE_ROOT = package
            backend.PROVENANCE_PATH = provenance
            calls = 0

            def prepare_candidate(*args):
                nonlocal calls
                calls += 1
                candidate = args[2]
                workspace = self._package_workspace(root / f"candidate-{calls}")
                records = self._copy_into_marked_candidate(
                    workspace, candidate, backend.PACKAGE_ROOT, args[1]
                )
                if calls == 2:
                    binary = candidate / "bin/fullmag-bin"
                    binary.write_bytes(b"changed candidate\n")
                    records = backend._hash_package(candidate)
                    backend._write_candidate_marker(
                        candidate,
                        backend.PACKAGE_ROOT,
                        args[1],
                        state="ready",
                        records=records,
                    )
                backend._write_json(
                    candidate / "backend-build-receipt.json",
                    {
                        "schema": backend.RECEIPT_SCHEMA,
                        "state": "succeeded",
                        "execution_lanes": {lane: {} for lane in backend.LANES},
                        "artifacts": records,
                    },
                    "test candidate receipt",
                )
                return 0

            publish_calls = 0

            def publish_provenance(_output):
                nonlocal publish_calls
                publish_calls += 1
                if publish_calls == 2:
                    provenance.write_bytes(b"partial publication\n")
                    raise backend.BackendBuildError("injected provenance publication failure")

            try:
                with (
                    patch.dict(os.environ, {"FULLMAG_BACKEND_CARGO_PROFILE": "backend-dev"}),
                    patch.object(
                        backend,
                        "_toolchain_identity",
                        return_value=(
                            "sha256:" + "a" * 64,
                            {"image_id": "sha256:" + "a" * 64},
                        ),
                    ),
                    patch.object(backend, "_prepare_locked", side_effect=prepare_candidate),
                    patch.object(
                        backend,
                        "_capture_start_manifest",
                        return_value=Path("/build/live-source/manifest.json"),
                    ),
                    patch.object(backend, "_publish_runtime_provenance", side_effect=publish_provenance),
                    patch.object(backend, "_serve", return_value=0) as serve,
                ):
                    command = [
                        "start",
                        "--manifest",
                        "/input/manifest.json",
                        "--build-root",
                        str(build_root),
                    ]
                    self.assertEqual(backend.main(command), 0)
                    before_package = {
                        path.relative_to(package).as_posix(): path.read_bytes()
                        for path in package.rglob("*")
                        if path.is_file()
                        and not path.relative_to(package).parts[:1]
                        == (backend.PACKAGE_DEVELOPMENT_DIRNAME,)
                    }
                    self.assertEqual(backend.main(command), 2)
                after_package = {
                    path.relative_to(package).as_posix(): path.read_bytes()
                    for path in package.rglob("*")
                    if path.is_file()
                    and not path.relative_to(package).parts[:1]
                    == (backend.PACKAGE_DEVELOPMENT_DIRNAME,)
                }
                self.assertEqual(after_package, before_package)
                self.assertEqual(provenance.read_bytes(), previous_provenance)
                self.assertEqual(serve.call_count, 1)
                self.assertTrue(
                    list(
                        (
                            package
                            / backend.PACKAGE_DEVELOPMENT_DIRNAME
                            / backend.PACKAGE_BACKUPS_DIRNAME
                        ).glob(".backend-package-backup-*")
                    )
                )
            finally:
                backend.PACKAGE_ROOT = original_package_root
                backend.PROVENANCE_PATH = original_provenance_path

    def test_start_provenance_binds_source_and_receipt_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output, records = self._published_package(root)
            receipt = {
                "schema": backend.RECEIPT_SCHEMA,
                "state": "succeeded",
                "source": {
                    "source_mode": backend.LIVE_SOURCE_MODE,
                    "resolved_commit": "a" * 40,
                    "source_digest": "b" * 64,
                },
                "native_source_identity": {"source_snapshot_sha256": "c" * 64},
                "native_source_identity_sha256": "d" * 64,
                "toolchain": {"image_id": "sha256:" + "e" * 64},
                "build": {
                    "cargo_profile": "backend-dev",
                    "cargo_target_profile_dir": "backend-dev",
                },
                "execution_lanes": {lane: {"status": "compiled"} for lane in backend.LANES},
                "artifacts": records,
            }
            backend._write_json(
                output / "backend-build-receipt.json", receipt, "test backend build receipt"
            )
            provenance_path = root / "provenance.json"
            provenance_path.touch()
            original_provenance_path = backend.PROVENANCE_PATH
            backend.PROVENANCE_PATH = provenance_path
            runtime_image_id = "sha256:" + "f" * 64
            try:
                with patch.dict(
                    os.environ,
                    {"FULLMAG_RUNTIME_IMAGE_ID": runtime_image_id},
                    clear=False,
                ):
                    backend._publish_runtime_provenance(output)
                provenance = json.loads(provenance_path.read_text(encoding="utf-8"))
                published_bytes = provenance_path.read_bytes()
                self.assertEqual(provenance["image_id"], runtime_image_id)
                with patch.dict(os.environ, {}, clear=False):
                    os.environ.pop("FULLMAG_RUNTIME_IMAGE_ID", None)
                    with self.assertRaisesRegex(
                        backend.BackendBuildError, "FULLMAG_RUNTIME_IMAGE_ID"
                    ):
                        backend._publish_runtime_provenance(output)
                for malformed in (
                    "not-an-image",
                    "sha256:" + "A" * 64,
                    "sha256:" + "e" * 63,
                ):
                    with self.subTest(malformed=malformed), patch.dict(
                        os.environ,
                        {"FULLMAG_RUNTIME_IMAGE_ID": malformed},
                        clear=False,
                    ):
                        with self.assertRaisesRegex(
                            backend.BackendBuildError, "FULLMAG_RUNTIME_IMAGE_ID"
                        ):
                            backend._publish_runtime_provenance(output)
                self.assertEqual(provenance_path.read_bytes(), published_bytes)
            finally:
                backend.PROVENANCE_PATH = original_provenance_path
            self.assertEqual(provenance["commit"], "a" * 40)
            self.assertEqual(
                provenance["native_source_identity"]["source_snapshot_sha256"], "c" * 64
            )
            self.assertEqual(
                provenance["backend_build_receipt_schema"], backend.RECEIPT_SCHEMA
            )
            self.assertEqual(
                provenance["build_receipt_sha256"],
                hashlib.sha256(
                    (output / "backend-build-receipt.json").read_bytes()
                ).hexdigest(),
            )

    def test_native_soname_alias_is_published_as_regular_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            (source / "lib").mkdir(parents=True)
            (source / "lib/libfullmag_fdm.so.1").write_bytes(b"native-library")
            (source / "lib/libfullmag_fdm.so").symlink_to("libfullmag_fdm.so.1")
            target = root / "package"
            backend._copy_package_tree(source, target)
            self.assertEqual((target / "lib/libfullmag_fdm.so").read_bytes(), b"native-library")
            self.assertFalse((target / "lib/libfullmag_fdm.so").is_symlink())

    def test_direct_candidate_is_flattened_and_verified_without_mutating_legacy_stage(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package, build_root, _control, candidate, workspace = self._direct_candidate_fixture(root)
            legacy_stage = workspace / ".fullmag" / "local"
            (legacy_stage / "bin").mkdir(parents=True)
            (legacy_stage / "bin/fullmag").write_bytes(b"retained legacy launcher\n")
            (legacy_stage / "lib").mkdir()
            (legacy_stage / "lib/libfullmag_fdm.so.1").write_bytes(b"retained native\n")
            (legacy_stage / "lib/libfullmag_fdm.so").symlink_to("libfullmag_fdm.so.1")
            legacy_before = backend._snapshot_legacy_install_stage(workspace)
            records = backend._copy_package(
                workspace,
                candidate,
                direct_install=True,
                package_root=package,
                build_root=build_root,
            )
            self.assertEqual(backend._snapshot_legacy_install_stage(workspace), legacy_before)
            self.assertFalse((candidate / "bin/fullmag").exists())
            self.assertFalse((candidate / "lib/libfullmag_fdm.so").is_symlink())
            self.assertFalse((candidate / "lib/libfullmag_fem.so").is_symlink())
            marker = json.loads(
                (candidate / backend.PACKAGE_CANDIDATE_MARKER).read_text(encoding="utf-8")
            )
            self.assertEqual(marker["state"], "ready")
            self.assertEqual(
                marker["artifact_inventory_sha256"],
                backend._sha256_bytes(backend._canonical(records)),
            )
            self.assertEqual(records, backend._hash_package(candidate))

    def test_direct_candidate_rejects_an_unowned_symlink_without_deleting_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package, build_root, _control, candidate, workspace = self._direct_candidate_fixture(root)
            outside = root / "outside"
            outside.write_bytes(b"retained")
            (candidate / "unexpected-link").symlink_to(outside)
            with self.assertRaises(backend.BackendBuildError):
                backend._copy_package(
                    workspace,
                    candidate,
                    direct_install=True,
                    package_root=package,
                    build_root=build_root,
                )
            self.assertTrue((candidate / "unexpected-link").is_symlink())
            self.assertEqual(outside.read_bytes(), b"retained")

    def test_direct_candidate_rejects_preexisting_payload_before_make(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package, _build_root, _control, candidate, _workspace = self._direct_candidate_fixture(root)
            with self.assertRaisesRegex(backend.BackendBuildError, "pre-existing payload"):
                backend._assert_direct_candidate_empty_for_make(candidate)
            self.assertTrue((candidate / "bin/fullmag").is_file())

    def test_failed_candidate_cleanup_requires_known_marker_owned_inventory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package, build_root, _control, candidate, _workspace = self._direct_candidate_fixture(root)
            diagnostic = candidate / "direct-backend-build.log"
            diagnostic_bytes = diagnostic.read_bytes()
            self.assertFalse(
                backend._discard_failed_candidate_if_owned(candidate, package, build_root)
            )
            self.assertTrue(candidate.is_dir())
            self.assertEqual(diagnostic.read_bytes(), diagnostic_bytes)

            for name in (
                "direct-backend-build.log",
                "install-cli-build.log",
                "install-cli-managed-fem-gpu.log",
            ):
                (candidate / name).unlink()
            self.assertTrue(
                backend._discard_failed_candidate_if_owned(candidate, package, build_root)
            )
            self.assertFalse(candidate.exists())

            unknown_root = root / "unknown"
            unknown_root.mkdir()
            package, build_root, _control, candidate, _workspace = self._direct_candidate_fixture(
                unknown_root, name=".backend-package-candidate-unknown"
            )
            (candidate / "unknown-build-output.bin").write_bytes(b"preserve")
            self.assertFalse(
                backend._discard_failed_candidate_if_owned(candidate, package, build_root)
            )
            self.assertTrue((candidate / "unknown-build-output.bin").is_file())

    def test_failed_make_receipt_preserves_external_log_after_candidate_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            package, build_root, candidate, log_path = self._failed_make_fixture(
                Path(directory), ".backend-package-candidate-failed"
            )
            receipt = backend._finish_failed_make_attempt(build_root, candidate, 17)
            self.assertEqual(receipt["state"], "failed")
            self.assertTrue(
                backend._discard_failed_candidate_if_owned(candidate, package, build_root)
            )
            self.assertFalse(candidate.exists())
            self.assertTrue(log_path.is_file())
            attempt = build_root / backend.FAILED_MAKE_DIAGNOSTICS_DIRNAME / candidate.name
            observed, _ = backend._read_json(
                attempt / backend.FAILED_MAKE_RECEIPT_NAME,
                "failed Make receipt",
            )
            self.assertEqual(observed["log_sha256"], receipt["log_sha256"])
            self.assertEqual(observed["log_size"], log_path.stat().st_size)

    def test_building_make_attempt_blocks_candidate_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            package, build_root, candidate, log_path = self._failed_make_fixture(
                Path(directory), ".backend-package-candidate-building"
            )
            self.assertFalse(
                backend._discard_failed_candidate_if_owned(candidate, package, build_root)
            )
            self.assertTrue(candidate.is_dir())
            self.assertTrue(log_path.is_file())

    def test_prepare_locked_verifies_published_make_log_stat_size(self):
        for mutate_published_log in (False, True):
            with self.subTest(mutate_published_log=mutate_published_log), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                package = root / "package"
                package.mkdir()
                build_root = root / "build"
                build_root.mkdir()
                control = backend._ensure_package_development_root(package)
                candidate = (
                    control
                    / backend.PACKAGE_CANDIDATES_DIRNAME
                    / ".backend-package-candidate-prepare-logstat"
                )
                candidate.mkdir()
                backend._write_candidate_marker(
                    candidate, package, build_root, state="building"
                )
                workspace = root / "workspace"
                workspace.mkdir()
                manifest = root / "manifest.json"
                manifest.write_bytes(b"fixture manifest")
                args = backend.argparse.Namespace(
                    source_tar=None,
                    manifest=manifest,
                    source_root=root / "source",
                    git_common_root=root / "git-common",
                )

                def fake_make(command, actual_workspace, environment, log_path):
                    self.assertEqual(command[-1], "install-cli-dev")
                    log_path.write_bytes(b"make completed\\n")
                    return 0

                def fake_publish(*publish_args, **publish_kwargs):
                    if mutate_published_log:
                        with (candidate / backend.FAILED_MAKE_LOG_NAME).open("ab") as stream:
                            stream.write(b"publisher drift\n")
                    return 0

                with (
                    patch.object(backend, "PACKAGE_ROOT", package),
                    patch.dict(
                        os.environ,
                        {"FULLMAG_BACKEND_CARGO_PROFILE": "backend-dev"},
                        clear=False,
                    ),
                    patch.object(
                        backend,
                        "_materialize_source",
                        return_value=(workspace, {}, {}, "a" * 64, None, "snapshot"),
                    ),
                    patch.object(backend, "_build_environment", return_value={}),
                    patch.object(backend, "_run_canonical_make", side_effect=fake_make),
                    patch.object(
                        backend,
                        "_publish_completed_build",
                        side_effect=fake_publish,
                    ),
                ):
                    if mutate_published_log:
                        with self.assertRaisesRegex(
                            backend.BackendBuildError,
                            "published Make diagnostic log differs",
                        ):
                            backend._prepare_locked(
                                args, build_root, candidate, 2, {}, candidate
                            )
                        self.assertTrue(
                            (
                                build_root
                                / backend.FAILED_MAKE_DIAGNOSTICS_DIRNAME
                                / candidate.name
                                / backend.FAILED_MAKE_LOG_NAME
                            ).is_file()
                        )
                    else:
                        self.assertEqual(
                            backend._prepare_locked(
                                args, build_root, candidate, 2, {}, candidate
                            ),
                            0,
                        )
                        self.assertFalse(
                            (
                                build_root
                                / backend.FAILED_MAKE_DIAGNOSTICS_DIRNAME
                                / candidate.name
                                / backend.FAILED_MAKE_LOG_NAME
                            ).exists()
                        )

    def test_successful_make_log_is_copied_then_external_log_is_retired(self):
        with tempfile.TemporaryDirectory() as directory:
            package, build_root, candidate, log_path = self._failed_make_fixture(
                Path(directory), ".backend-package-candidate-succeeded", b"success\n"
            )
            receipt = backend._finish_failed_make_attempt(build_root, candidate, 0)
            digest, size = backend._copy_regular_file_fsync(
                log_path,
                candidate / backend.FAILED_MAKE_LOG_NAME,
                "successful Make diagnostic log",
            )
            self.assertEqual((digest, size), (receipt["log_sha256"], receipt["log_size"]))
            backend._retire_make_log(
                backend._read_failed_make_attempt(build_root, candidate)
            )
            self.assertEqual(
                (candidate / backend.FAILED_MAKE_LOG_NAME).read_bytes(), b"success\n"
            )
            self.assertFalse(log_path.exists())
            observed, _ = backend._read_json(
                build_root
                / backend.FAILED_MAKE_DIAGNOSTICS_DIRNAME
                / candidate.name
                / backend.FAILED_MAKE_RECEIPT_NAME,
                "retired Make receipt",
            )
            self.assertTrue(observed["log_retired"])

    def test_failed_make_log_retention_bounds_logs_and_preserves_receipts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package = root / "package"
            package.mkdir()
            build_root = root / "build"
            build_root.mkdir()
            control = backend._ensure_package_development_root(package)
            for index in range(backend.FAILED_MAKE_LOG_LIMIT + 1):
                candidate = (
                    control
                    / backend.PACKAGE_CANDIDATES_DIRNAME
                    / f".backend-package-candidate-{index}"
                )
                candidate.mkdir()
                backend._write_candidate_marker(
                    candidate, package, build_root, state="building"
                )
                log_path = backend._begin_failed_make_attempt(
                    build_root, candidate, "install-cli-dev"
                )
                log_path.write_bytes(f"failure-{index}\n".encode())
                backend._finish_failed_make_attempt(build_root, candidate, 17)
            backend._prune_failed_make_logs(build_root, package)
            namespace = build_root / backend.FAILED_MAKE_DIAGNOSTICS_DIRNAME
            self.assertEqual(
                len(list(namespace.glob(f"*/{backend.FAILED_MAKE_LOG_NAME}"))),
                backend.FAILED_MAKE_LOG_LIMIT,
            )
            self.assertEqual(
                len(list(namespace.glob(f"*/{backend.FAILED_MAKE_RECEIPT_NAME}"))),
                backend.FAILED_MAKE_LOG_LIMIT + 1,
            )

    def test_failed_make_log_drift_keeps_candidate_and_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            package, build_root, candidate, log_path = self._failed_make_fixture(
                Path(directory), ".backend-package-candidate-drift"
            )
            backend._finish_failed_make_attempt(build_root, candidate, 2)
            log_path.write_bytes(b"tampered\n")
            self.assertFalse(
                backend._discard_failed_candidate_if_owned(candidate, package, build_root)
            )
            self.assertTrue(candidate.is_dir())

    def test_failed_make_unknown_record_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            package, build_root, candidate, log_path = self._failed_make_fixture(
                Path(directory), ".backend-package-candidate-foreign"
            )
            backend._finish_failed_make_attempt(build_root, candidate, 3)
            namespace = build_root / backend.FAILED_MAKE_DIAGNOSTICS_DIRNAME
            (namespace / "foreign-record").write_bytes(b"keep")
            backend._prune_failed_make_logs(build_root, package)
            self.assertTrue(log_path.is_file())
            self.assertTrue((namespace / "foreign-record").is_file())

    def test_failed_make_zero_exit_code_cannot_claim_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            package, build_root, candidate, _log_path = self._failed_make_fixture(
                Path(directory), ".backend-package-candidate-zero"
            )
            backend._finish_failed_make_attempt(build_root, candidate, 2)
            receipt_path = (
                build_root
                / backend.FAILED_MAKE_DIAGNOSTICS_DIRNAME
                / candidate.name
                / backend.FAILED_MAKE_RECEIPT_NAME
            )
            receipt, _ = backend._read_json(receipt_path, "failed Make receipt")
            receipt["exit_code"] = 0
            backend._write_json(receipt_path, receipt, "tampered failed Make receipt")
            self.assertFalse(
                backend._discard_failed_candidate_if_owned(candidate, package, build_root)
            )
            self.assertTrue(candidate.is_dir())

    def test_failed_make_log_sync_failure_preserves_building_attempt(self):
        with tempfile.TemporaryDirectory() as directory:
            package, build_root, candidate, log = self._failed_make_fixture(
                Path(directory), ".backend-package-candidate-unsynced"
            )
            with patch.object(backend, "_fsync_owned_tree", side_effect=backend.BackendBuildError("log sync failed")):
                with self.assertRaises(backend.BackendBuildError):
                    backend._finish_failed_make_attempt(build_root, candidate, 7)
            attempt = backend._read_failed_make_attempt(build_root, candidate)
            self.assertEqual(attempt[0]["state"], "building")
            self.assertFalse(backend._discard_failed_candidate_if_owned(candidate, package, build_root))
            self.assertTrue(candidate.is_dir())
            self.assertTrue(log.is_file())

    def test_failed_make_prune_rejects_receipt_redirect(self):
        with tempfile.TemporaryDirectory() as directory:
            package, build_root, candidate_a, log_a = self._failed_make_fixture(
                Path(directory), ".backend-package-candidate-a", b"a\n"
            )
            candidate_b = candidate_a.parent / ".backend-package-candidate-b"
            candidate_b.mkdir()
            backend._write_candidate_marker(candidate_b, package, build_root, state="building")
            log_b = backend._begin_failed_make_attempt(build_root, candidate_b, "install-cli-dev")
            log_b.write_bytes(b"b\n")
            backend._finish_failed_make_attempt(build_root, candidate_a, 17)
            backend._finish_failed_make_attempt(build_root, candidate_b, 17)
            receipt_a = build_root / backend.FAILED_MAKE_DIAGNOSTICS_DIRNAME / candidate_a.name / backend.FAILED_MAKE_RECEIPT_NAME
            document, _ = backend._read_json(receipt_a, "redirected Make receipt")
            document["candidate"] = str(candidate_b)
            backend._write_json(receipt_a, document, "redirected Make receipt")
            with patch.object(backend, "FAILED_MAKE_LOG_LIMIT", 0):
                backend._prune_failed_make_logs(build_root, package)
            self.assertTrue(log_a.is_file())
            self.assertTrue(log_b.is_file())

    def test_rotation_rollback_reports_missing_or_linked_payload(self):
        for linked in (False, True):
            with self.subTest(linked=linked), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                package, build_root, control, candidate, previous, candidate_bytes = self._ready_rotation_fixture(
                    root, ".backend-package-candidate-unsafe-rollback"
                )
                rotation = backend._rotate_package(package, candidate, control, previous[2], previous[1], candidate_bytes)
                retained = root / "detached-bin"
                (package / "bin").rename(retained)
                if linked:
                    (package / "bin").symlink_to(retained, target_is_directory=True)
                errors = backend._rollback_package_rotation(rotation)
                self.assertTrue(errors)
                self.assertTrue(any("bin" in error for error in errors))
                self.assertTrue((retained / "fullmag-bin").is_file())
                self.assertTrue((control / backend.PACKAGE_ROTATION_JOURNAL_NAME).is_file())
                if linked:
                    self.assertTrue((package / "bin").is_symlink())

    def test_rotation_rollback_fsyncs_all_mutated_directories(self):
        with tempfile.TemporaryDirectory() as directory:
            package, build_root, control, candidate, previous, candidate_bytes = self._ready_rotation_fixture(
                Path(directory), ".backend-package-candidate-fsync-rollback"
            )
            rotation = backend._rotate_package(package, candidate, control, previous[2], previous[1], candidate_bytes)
            with patch.object(backend, "_fsync_directory", wraps=backend._fsync_directory) as sync:
                self.assertEqual(backend._rollback_package_rotation(rotation), [])
            self.assertTrue({package, candidate, Path(rotation["backup"])}.issubset({Path(call.args[0]) for call in sync.call_args_list}))

    def test_finalize_error_after_marker_unlink_keeps_committed_package_recoverable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package, build_root, control, candidate, previous, candidate_bytes = self._ready_rotation_fixture(
                root, ".backend-package-candidate-finalize-error"
            )
            provenance = root / "provenance.json"
            provenance.write_bytes(b"previous")
            records = json.loads(candidate_bytes)["artifacts"]

            def prepare(*args):
                backend._write_candidate_marker(candidate, package, build_root, state="ready", records=records)
                return 0

            def finalize(*args):
                (candidate / backend.PACKAGE_CANDIDATE_MARKER).unlink()
                raise backend.BackendBuildError("injected rmdir failure after marker unlink")

            with (
                patch.object(backend, "PACKAGE_ROOT", package),
                patch.object(backend, "PROVENANCE_PATH", provenance),
                patch.dict(os.environ, {"FULLMAG_BACKEND_CARGO_PROFILE": "backend-dev"}),
                patch.object(backend, "_toolchain_identity", return_value=("sha256:" + "a" * 64, {"image_id": "sha256:" + "a" * 64})),
                patch.object(backend, "_capture_start_manifest", return_value=root / "manifest.json"),
                # The fixture preconstructs the package normally produced by Make.
                patch.object(backend, "_reject_partial_package_candidates"),
                patch.object(backend.tempfile, "mkdtemp", return_value=str(candidate)),
                patch.object(backend, "_prepare_locked", side_effect=prepare),
                patch.object(backend, "_publish_runtime_provenance", side_effect=lambda output: provenance.write_bytes(b"successor")),
                patch.object(backend, "_finalize_published_candidate", side_effect=finalize),
                patch.object(backend, "_rollback_package_rotation", wraps=backend._rollback_package_rotation) as rollback,
                patch.object(backend, "_serve") as serve,
            ):
                self.assertEqual(backend.main(["start", "--build-root", str(build_root)]), 2)
                rollback.assert_not_called()
                serve.assert_not_called()
            self.assertEqual((package / "backend-build-receipt.json").read_bytes(), candidate_bytes)
            self.assertEqual(provenance.read_bytes(), b"successor")
            self.assertTrue((control / backend.PACKAGE_ROTATION_JOURNAL_NAME).is_file())
            backend._recover_pending_package_rotation(package, control, build_root)
            self.assertFalse(candidate.exists())
            self.assertFalse((control / backend.PACKAGE_ROTATION_JOURNAL_NAME).exists())
            self.assertEqual((package / "backend-build-receipt.json").read_bytes(), candidate_bytes)

    def test_direct_candidate_rotation_preserves_current_and_rollback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package, _current_records = self._published_package(root)
            backend._write_json(
                package / "backend-build-receipt.json",
                {
                    "schema": backend.RECEIPT_SCHEMA,
                    "state": "succeeded",
                    "execution_lanes": {
                        lane: {"status": "compiled"} for lane in backend.LANES
                    },
                    "artifacts": _current_records,
                },
                "initial direct rotation fixture receipt",
            )
            build_root = root / "build"
            build_root.mkdir()
            control = backend._ensure_package_development_root(package)
            candidate = control / backend.PACKAGE_CANDIDATES_DIRNAME / ".backend-package-candidate-rotation"
            self._populate_direct_candidate(package, build_root, candidate)
            workspace = root / "workspace"
            workspace.mkdir()
            candidate_records = backend._copy_package(
                workspace,
                candidate,
                direct_install=True,
                package_root=package,
                build_root=build_root,
            )
            previous = backend._validated_package(
                package,
                "current package",
                exclude_development_control=True,
            )
            previous_bytes = previous[1]
            candidate_receipt = {
                "schema": backend.RECEIPT_SCHEMA,
                "state": "succeeded",
                "execution_lanes": {lane: {"status": "compiled"} for lane in backend.LANES},
                "artifacts": candidate_records,
            }
            backend._write_json(
                candidate / "backend-build-receipt.json",
                candidate_receipt,
                "direct candidate receipt",
            )
            candidate_receipt_bytes = (candidate / "backend-build-receipt.json").read_bytes()
            _rotation = backend._rotate_package(
                package,
                candidate,
                control,
                previous[2],
                previous_bytes,
                candidate_receipt_bytes,
            )
            backup = next(
                (control / backend.PACKAGE_BACKUPS_DIRNAME).glob(".backend-package-backup-*")
            )
            self.assertEqual((package / "bin/fullmag-bin").read_bytes(), b"candidate\n")
            self.assertEqual((backup / "bin/fullmag-bin").read_bytes(), b"package\n")
            self.assertTrue((candidate / backend.PACKAGE_CANDIDATE_MARKER).is_file())
            current_after_rotation = backend._validated_package(
                package,
                "current package after interrupted finalize",
                exclude_development_control=True,
            )
            # Simulate a crash after the payload rotation and before the
            # normal in-process marker finalization.  The next-start preflight
            # must validate the real current package inventory before removing
            # the marker-only candidate.
            backend._recover_pending_package_rotation(package, control, build_root)
            self.assertFalse(candidate.exists())
            # The next unchanged start must not mistake a successfully
            # published candidate marker for an incomplete prior build.
            backend._reject_partial_package_candidates(
                package,
                control,
                build_root,
                current_package=current_after_rotation,
            )

            empty_candidate = (
                control
                / backend.PACKAGE_CANDIDATES_DIRNAME
                / ".backend-package-candidate-crash-empty"
            )
            empty_candidate.mkdir()
            # Simulate the narrower crash window after marker unlink and before
            # candidate rmdir.  Only this empty owned namespace is removable.
            backend._reject_partial_package_candidates(
                package,
                control,
                build_root,
                current_package=current_after_rotation,
            )
            self.assertFalse(empty_candidate.exists())

    def test_rotation_journal_recovers_crash_before_first_rename(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package, build_root, control, candidate, previous, candidate_bytes = (
                self._ready_rotation_fixture(
                    root, ".backend-package-candidate-journal-before-rename"
                )
            )
            with patch.object(
                backend,
                "_rename_package_child",
                side_effect=KeyboardInterrupt("fault before first rotation rename"),
            ):
                with self.assertRaises(KeyboardInterrupt):
                    backend._rotate_package(
                        package,
                        candidate,
                        control,
                        previous[2],
                        previous[1],
                        candidate_bytes,
                    )
            journal = control / backend.PACKAGE_ROTATION_JOURNAL_NAME
            self.assertTrue(journal.is_file())
            backend._recover_pending_package_rotation(package, control, build_root)
            self.assertFalse(journal.exists())
            self.assertFalse(candidate.exists())
            self.assertEqual((package / "bin/fullmag-bin").read_bytes(), b"package\n")
            self.assertEqual(tuple((control / backend.PACKAGE_BACKUPS_DIRNAME).iterdir()), ())

    def test_rotation_journal_recovers_after_first_old_backup_rename(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package, build_root, control, candidate, previous, candidate_bytes = (
                self._ready_rotation_fixture(
                    root, ".backend-package-candidate-journal-mid-old"
                )
            )
            original_rename = backend._rename_package_child
            calls = 0

            def fail_after_first_old(source, target, name, label):
                nonlocal calls
                if label == "old package backup":
                    calls += 1
                    if calls == 2:
                        raise KeyboardInterrupt("fault after first old backup rename")
                return original_rename(source, target, name, label)

            with patch.object(backend, "_rename_package_child", side_effect=fail_after_first_old):
                with self.assertRaises(KeyboardInterrupt):
                    backend._rotate_package(
                        package,
                        candidate,
                        control,
                        previous[2],
                        previous[1],
                        candidate_bytes,
                    )
            self.assertGreaterEqual(calls, 2)
            backend._recover_pending_package_rotation(package, control, build_root)
            self.assertFalse((control / backend.PACKAGE_ROTATION_JOURNAL_NAME).exists())
            self.assertFalse(candidate.exists())
            self.assertEqual(
                tuple((control / backend.PACKAGE_BACKUPS_DIRNAME).iterdir()), ()
            )
            backend._validated_package(
                package,
                "old package after mid-old recovery",
                exclude_development_control=True,
            )
            self.assertEqual((package / "bin/fullmag-bin").read_bytes(), b"package\n")

    def test_rotation_journal_recovers_after_first_new_publish_rename(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package, build_root, control, candidate, previous, candidate_bytes = (
                self._ready_rotation_fixture(
                    root, ".backend-package-candidate-journal-mid-new"
                )
            )
            original_rename = backend._rename_package_child
            calls = 0

            def fail_after_first_new(source, target, name, label):
                nonlocal calls
                if label == "candidate package":
                    calls += 1
                    if calls == 2:
                        raise KeyboardInterrupt("fault after first new publish rename")
                return original_rename(source, target, name, label)

            with patch.object(backend, "_rename_package_child", side_effect=fail_after_first_new):
                with self.assertRaises(KeyboardInterrupt):
                    backend._rotate_package(
                        package,
                        candidate,
                        control,
                        previous[2],
                        previous[1],
                        candidate_bytes,
                    )
            self.assertGreaterEqual(calls, 2)
            backend._recover_pending_package_rotation(package, control, build_root)
            self.assertFalse((control / backend.PACKAGE_ROTATION_JOURNAL_NAME).exists())
            self.assertFalse(candidate.exists())
            self.assertEqual(
                tuple((control / backend.PACKAGE_BACKUPS_DIRNAME).iterdir()), ()
            )
            backend._validated_package(
                package,
                "old package after mid-new recovery",
                exclude_development_control=True,
            )
            self.assertEqual((package / "bin/fullmag-bin").read_bytes(), b"package\n")

    def test_rotation_journal_recovers_first_publish_after_first_new_rename(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package, build_root, control, candidate, previous, candidate_bytes = (
                self._ready_rotation_fixture(
                    root, ".backend-package-candidate-journal-first-publish"
                )
            )
            for child_name in previous[2]:
                backend._remove_owned_tree(package / child_name)
            original_rename = backend._rename_package_child
            calls = 0

            def fail_after_first_new(source, target, name, label):
                nonlocal calls
                if label == "candidate package":
                    calls += 1
                    if calls == 2:
                        raise KeyboardInterrupt("fault during first package publish")
                return original_rename(source, target, name, label)

            with patch.object(backend, "_rename_package_child", side_effect=fail_after_first_new):
                with self.assertRaises(KeyboardInterrupt):
                    backend._rotate_package(
                        package,
                        candidate,
                        control,
                        {},
                        None,
                        candidate_bytes,
                    )
            self.assertGreaterEqual(calls, 2)
            backend._recover_pending_package_rotation(package, control, build_root)
            self.assertFalse((control / backend.PACKAGE_ROTATION_JOURNAL_NAME).exists())
            self.assertFalse(candidate.exists())
            self.assertEqual(
                {child.name for child in package.iterdir()},
                {backend.PACKAGE_DEVELOPMENT_DIRNAME},
            )

    def test_rotation_journal_preserves_unknown_partition_without_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package, build_root, control, candidate, previous, candidate_bytes = (
                self._ready_rotation_fixture(
                    root, ".backend-package-candidate-journal-unknown"
                )
            )
            with patch.object(
                backend,
                "_rename_package_child",
                side_effect=KeyboardInterrupt("fault before unknown partition check"),
            ):
                with self.assertRaises(KeyboardInterrupt):
                    backend._rotate_package(
                        package,
                        candidate,
                        control,
                        previous[2],
                        previous[1],
                        candidate_bytes,
                    )
            foreign = candidate / "unknown-after-journal.bin"
            foreign.write_bytes(b"preserve")
            journal = control / backend.PACKAGE_ROTATION_JOURNAL_NAME
            with self.assertRaisesRegex(backend.BackendBuildError, "unknown candidate"):
                backend._recover_pending_package_rotation(package, control, build_root)
            self.assertTrue(journal.is_file())
            self.assertTrue(foreign.is_file())
            self.assertEqual((package / "bin/fullmag-bin").read_bytes(), b"package\n")

    def test_legacy_stage_preservation_is_bounded_and_detects_metadata_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = self._workspace(root)
            stage = workspace / ".fullmag" / "local"
            stage.mkdir(parents=True)
            retained = stage / "retained.bin"
            retained.write_bytes(b"retained\n")
            before = backend._snapshot_legacy_install_stage(workspace)
            backend._remove_generated_build_output(
                workspace,
                preserve_legacy_install_stage=True,
            )
            backend._assert_legacy_install_stage_unchanged(
                workspace,
                before,
                "preservation probe",
            )
            retained.write_bytes(b"changed\n")
            with self.assertRaisesRegex(backend.BackendBuildError, "changed the retained"):
                backend._assert_legacy_install_stage_unchanged(
                    workspace,
                    before,
                    "mutation probe",
                )

    def test_partial_or_foreign_candidate_is_preserved_and_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package = root / "package"
            package.mkdir()
            build_root = root / "build"
            build_root.mkdir()
            control = backend._ensure_package_development_root(package)
            foreign = control / backend.PACKAGE_CANDIDATES_DIRNAME / "foreign-candidate"
            foreign.mkdir()
            with self.assertRaises(backend.BackendBuildError):
                backend._reject_partial_package_candidates(package, control, build_root)
            self.assertTrue(foreign.is_dir())
            candidate = (
                control
                / backend.PACKAGE_CANDIDATES_DIRNAME
                / ".backend-package-candidate-incomplete"
            )
            candidate.mkdir()
            marker = candidate / backend.PACKAGE_CANDIDATE_MARKER
            backend._write_candidate_marker(candidate, package, build_root, state="building")
            # A candidate holding only known Make output is discarded as an
            # interrupted build; unknown content keeps it fail-closed.
            (candidate / "operator-notes.txt").write_bytes(b"keep")
            with self.assertRaises(backend.BackendBuildError):
                backend._reject_partial_package_candidates(package, control, build_root)
            self.assertTrue(marker.is_file())
            self.assertTrue(candidate.is_dir())

    def test_make_default_and_direct_install_roots_are_distinct(self):
        """Exercise the installer with fake build outputs, without compiling."""
        makefile = Path(__file__).resolve().parents[1] / "Makefile"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tools = root / "tools"
            tools.mkdir()
            for tool in ("cargo", "patchelf"):
                executable = tools / tool
                executable.write_text(
                    "#!/bin/sh\nprintf '%s\\n' " + tool
                    + ' >> "$FULLMAG_INSTALL_TRACE"\n',
                    encoding="utf-8",
                )
                executable.chmod(0o755)
            target = root / "target" / "backend-dev"
            target.mkdir(parents=True)
            binaries = {
                Path(relative).name
                for relative in backend.REQUIRED_PACKAGE_PATHS
                if relative.startswith("bin/")
            }
            for binary in binaries:
                cargo_name = "fullmag" if binary == "fullmag-bin" else binary
                (target / cargo_name).write_bytes(("fixture:" + binary).encode())
            (target / "lib_fullmag_core.so").write_bytes(b"python-core-fixture")
            native = root / "native" / "backends" / "fdm"
            native.mkdir(parents=True)
            (native / "libfullmag_fdm.so.1").write_bytes(b"fdm-library-fixture")
            (native / "libfullmag_fdm.so").symlink_to("libfullmag_fdm.so.1")
            trace = root / "tools.log"
            for custom in (False, True):
                with self.subTest(custom=custom):
                    workspace = root / ("custom" if custom else "default")
                    workspace.mkdir()
                    legacy = workspace / ".fullmag" / "local"
                    legacy.mkdir(parents=True)
                    (legacy / "keep.txt").write_bytes(b"retain legacy data")
                    destination = root / "candidate" if custom else legacy
                    library_directory = destination / "lib"
                    library_directory.mkdir(parents=True)
                    stale = library_directory / "libfullmag_fdm.so.obsolete"
                    stale.write_bytes(b"obsolete-library")
                    environment = {
                        key: value for key, value in os.environ.items()
                        if not key.startswith("FULLMAG_")
                    }
                    environment.update(
                        PATH=str(tools) + os.pathsep + os.environ["PATH"],
                        FULLMAG_INSTALL_TRACE=str(trace),
                        FULLMAG_DIRECT_COMPOSE="1",
                        FULLMAG_BUILD_CPU_ONLY="1",
                        FULLMAG_BACKEND_CARGO_PROFILE="backend-dev",
                        FULLMAG_CARGO_TARGET_DIR=str(target.parent),
                        FULLMAG_FDM_NATIVE_BUILD_ROOT=str(root / "native"),
                        FULLMAG_SOURCE_GIT_COMMIT="a" * 40,
                        FULLMAG_SOURCE_WORKTREE_STATE="clean",
                        FULLMAG_SOURCE_SNAPSHOT_SHA256="b" * 64,
                    )
                    if custom:
                        environment["FULLMAG_INTERNAL_INSTALL_ROOT"] = str(destination)
                    result = subprocess.run(
                        # This fixture exercises the installer body with fake outputs;
                        # the managed storage shell is qualified by separate checks.
                        ["/usr/bin/make", "--no-print-directory", ".SHELLFLAGS=-e -c",
                         "-f", str(makefile), "install-cli-dev"],
                        cwd=workspace, env=environment, stdin=subprocess.DEVNULL,
                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30,
                    )
                    self.assertEqual(result.returncode, 0, result.stdout.decode("utf-8", "replace"))
                    for binary in binaries:
                        self.assertEqual(
                            (destination / "bin" / binary).read_bytes(),
                            ("fixture:" + binary).encode(),
                        )
                    self.assertEqual((destination / "_fullmag_core.so").read_bytes(), b"python-core-fixture")
                    self.assertEqual((library_directory / "libfullmag_fdm.so").read_bytes(), b"fdm-library-fixture")
                    self.assertEqual((destination / "launcher-build-mode").read_text().strip(), "cpu")
                    self.assertFalse(stale.exists())
                    self.assertEqual((legacy / "keep.txt").read_bytes(), b"retain legacy data")
                    if custom:
                        self.assertEqual({path.name for path in legacy.iterdir()}, {"keep.txt"})
            self.assertEqual(trace.read_text().splitlines().count("cargo"), 4)

    def test_package_alias_cannot_escape_library_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "outside").write_bytes(b"retained")
            source = root / "source"
            (source / "lib").mkdir(parents=True)
            (source / "lib/libfullmag_fem.so").symlink_to(root / "outside")
            with self.assertRaises(backend.BackendBuildError):
                backend._copy_package_tree(source, root / "package")
            self.assertEqual((root / "outside").read_bytes(), b"retained")

    def test_empty_first_attempt_workspace_is_recoverable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            workspace.mkdir()
            for name in backend.PERSISTENT_WORKSPACE_DIRS:
                (workspace / name).mkdir()
            self.assertEqual(backend._prepare_workspace(root), workspace)
            self.assertTrue((workspace / backend.OWNER_MARKER).is_file())
            self.assertEqual(backend._prepare_workspace(root), workspace)

    def test_unowned_nonempty_workspace_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            workspace.mkdir()
            retained = workspace / "unknown"
            retained.write_bytes(b"keep")
            with self.assertRaises(backend.BackendBuildError):
                backend._prepare_workspace(root)
            self.assertEqual(retained.read_bytes(), b"keep")

    def test_cleanup_unlinks_owned_alias_without_touching_target(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            outside = root / "retained"
            outside.write_bytes(b"keep")
            owned = root / "owned"
            owned.mkdir()
            (owned / "alias").symlink_to(outside)
            backend._remove_owned_tree(owned)
            self.assertFalse(owned.exists())
            self.assertEqual(outside.read_bytes(), b"keep")

    def test_reconcile_preserves_mtime_for_identical_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            files = {"crates/example/src/lib.rs": b"pub fn stable() {}\n"}
            capsule = self._capsule("a" * 64, files)
            workspace = self._workspace(root)
            backend._reconcile_source_tree(
                self._stage(root, files), workspace, capsule, "b" * 64
            )
            target = workspace / "crates/example/src/lib.rs"
            stable_time = 1_600_000_000_000_000_000
            os.utime(target, ns=(stable_time, stable_time))
            backend._reconcile_source_tree(
                self._stage(root, files), workspace, capsule, "c" * 64
            )
            self.assertEqual(target.stat().st_mtime_ns, stable_time)
            self.assertEqual(target.read_bytes(), files["crates/example/src/lib.rs"])
            target.write_bytes(b"tampered\n")
            os.utime(target, ns=(stable_time, stable_time))
            backend._reconcile_source_tree(
                self._stage(root, files), workspace, capsule, "d" * 64
            )
            self.assertEqual(target.read_bytes(), files["crates/example/src/lib.rs"])

    def test_reconcile_replaces_changed_and_removes_deleted_without_touching_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = {
                "crates/example/src/lib.rs": b"pub fn old() {}\n",
                "crates/example/src/stable.rs": b"pub fn stable() {}\n",
                "crates/example/src/removed.rs": b"removed\n",
            }
            workspace = self._workspace(root)
            backend._reconcile_source_tree(
                self._stage(root, first), workspace, self._capsule("a" * 64, first), "b" * 64
            )
            marker_path = workspace / backend.OWNER_MARKER
            marker, _ = backend._read_json(marker_path, "test backend workspace owner")
            marker.pop("workspace_inventory_schema")
            marker.pop("workspace_inventory_sha256")
            backend._write_json(marker_path, marker, "test backend workspace owner")
            stable = workspace / "crates/example/src/stable.rs"
            stable_time = 1_600_000_000_000_000_000
            os.utime(stable, ns=(stable_time, stable_time))
            cache = workspace / ".fullmag-build" / "cargo-fingerprint"
            cache_time = 1_600_000_000_000_000_000
            os.utime(cache, ns=(cache_time, cache_time))

            second = {
                "crates/example/src/lib.rs": b"pub fn new() {}\n",
                "crates/example/src/stable.rs": b"pub fn stable() {}\n",
            }
            backend._reconcile_source_tree(
                self._stage(root, second), workspace, self._capsule("c" * 64, second), "d" * 64
            )
            self.assertEqual(
                (workspace / "crates/example/src/lib.rs").read_bytes(),
                second["crates/example/src/lib.rs"],
            )
            self.assertEqual(stable.read_bytes(), second["crates/example/src/stable.rs"])
            self.assertEqual(stable.stat().st_mtime_ns, stable_time)
            self.assertFalse((workspace / "crates/example/src/removed.rs").exists())
            self.assertEqual(cache.read_bytes(), b"cache")
            self.assertEqual(cache.stat().st_mtime_ns, cache_time)
            marker = (workspace / backend.OWNER_MARKER).read_text(encoding="utf-8")
            self.assertIn('"state":"ready"', marker)
            self.assertIn('"source_digest":"' + "c" * 64 + '"', marker)
            self.assertIn('"workspace_inventory_schema":"' + backend.WORKSPACE_INVENTORY_SCHEMA + '"', marker)
            self.assertIn('"workspace_inventory_sha256":"' + "c" * 64 + '"', marker)

    def test_reconcile_removes_owned_generated_output_without_following_alias(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            files = {"crates/example/src/lib.rs": b"safe\n"}
            workspace = self._workspace(root)
            capsule = self._capsule("a" * 64, files)
            backend._reconcile_source_tree(
                self._stage(root, files), workspace, capsule, "b" * 64
            )

            outside = root / "outside.so"
            outside.write_bytes(b"keep")
            alias = workspace / ".fullmag/local/lib/libfullmag_fdm.so"
            alias.parent.mkdir(parents=True)
            alias.symlink_to(outside)

            backend._reconcile_source_tree(
                self._stage(root, files), workspace, capsule, "c" * 64
            )

            self.assertFalse(alias.exists())
            self.assertFalse(alias.is_symlink())
            self.assertEqual(outside.read_bytes(), b"keep")
            self.assertEqual(
                (workspace / "crates/example/src/lib.rs").read_bytes(), files["crates/example/src/lib.rs"]
            )

    def test_reconcile_rejects_workspace_links_and_preserves_target(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = self._workspace(root)
            outside = root / "outside"
            outside.write_bytes(b"keep")
            link = workspace / "crates/example/link"
            link.parent.mkdir(parents=True)
            link.symlink_to(outside)
            files = {"crates/example/src/lib.rs": b"safe\n"}
            with self.assertRaises(backend.BackendBuildError):
                backend._reconcile_source_tree(
                    self._stage(root, files), workspace, self._capsule("a" * 64, files), "b" * 64
                )
            self.assertTrue(link.is_symlink())
            self.assertEqual(outside.read_bytes(), b"keep")

    def test_reconcile_rejects_source_replacing_owner_before_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = self._workspace(root)
            owner = workspace / backend.OWNER_MARKER
            before = owner.read_bytes()
            files = {backend.OWNER_MARKER: b"unexpected source"}
            with self.assertRaises(backend.BackendBuildError):
                backend._reconcile_source_tree(
                    self._stage(root, files), workspace, self._capsule("a" * 64, files), "b" * 64
                )
            self.assertEqual(owner.read_bytes(), before)
            self.assertEqual((workspace / ".fullmag-build/cargo-fingerprint").read_bytes(), b"cache")

    def test_direct_build_keeps_runner_workspace_and_sets_explicit_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            native = {
                "head_commit_full": "a" * 40,
                "source_snapshot_dirty": False,
                "source_snapshot_sha256": "b" * 64,
            }
            environment = backend._build_environment(workspace, root, native, 1)
            self.assertEqual(environment["FULLMAG_DIRECT_COMPOSE"], "1")
            self.assertEqual(environment["FULLMAG_BACKEND_CARGO_PROFILE"], "backend-dev")
            self.assertEqual(environment["FULLMAG_RUNNER_WORKSPACE"], str(workspace))

    def test_release_profile_uses_separate_native_target_tree(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            native = {
                "head_commit_full": "a" * 40,
                "source_snapshot_dirty": False,
                "source_snapshot_sha256": "b" * 64,
            }
            environment = backend._build_environment(workspace, root, native, 1, "release")
            self.assertEqual(environment["FULLMAG_BACKEND_CARGO_PROFILE"], "release")
            self.assertIn("/direct/release/build/", environment["FULLMAG_FEM_NATIVE_BUILD_ROOT"])
            self.assertNotIn("backend-dev", environment["FULLMAG_FEM_NATIVE_BUILD_ROOT"])

    def test_direct_build_native_cache_roots_are_stable_and_cache_scoped(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            first_native = {
                "head_commit_full": "a" * 40,
                "source_snapshot_dirty": False,
                "source_snapshot_sha256": "b" * 64,
            }
            second_native = {**first_native, "source_snapshot_sha256": "c" * 64}
            first_environment = backend._build_environment(workspace, root, first_native, 1)
            second_environment = backend._build_environment(workspace, root, second_native, 1)

            other_root = root / "other-cache"
            other_workspace = other_root / "workspace"
            other_environment = backend._build_environment(
                other_workspace, other_root, first_native, 1
            )

            names = ("FULLMAG_FDM_NATIVE_BUILD_ROOT", "FULLMAG_FEM_NATIVE_BUILD_ROOT")
            for name in names:
                first = Path(first_environment[name])
                self.assertEqual(first, Path(second_environment[name]))
                self.assertNotEqual(first, Path(other_environment[name]))
                self.assertTrue(first.is_relative_to(workspace))
                self.assertTrue(first.is_relative_to(root))
                self.assertIn(".fullmag-build", first.parts)
                self.assertIn("backend-dev", first.parts)
                self.assertIn("native-build", first.parts)
            self.assertNotEqual(
                Path(first_environment["FULLMAG_FDM_NATIVE_BUILD_ROOT"]),
                Path(first_environment["FULLMAG_FEM_NATIVE_BUILD_ROOT"]),
            )


if __name__ == "__main__":
    unittest.main()
