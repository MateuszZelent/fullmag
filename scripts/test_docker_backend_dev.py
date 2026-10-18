"""Interpreted package publication regressions; no native compilation."""
from contextlib import redirect_stderr
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
                commit=(chr(ord("a") + index) * 40),
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
            backend._rotate_package(
                package,
                candidate,
                control,
                previous[2],
                previous[1],
                candidate_receipt_bytes,
            )
            backend._remove_owned_tree(candidate)
        return package, control, toolchain

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
                records = backend._copy_package(workspace, candidate)
                if build_number == 2:
                    binary = candidate / "bin/fullmag-bin"
                    binary.write_bytes(b"changed candidate\n")
                    records = backend._hash_package(candidate)
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
                        "direct-backend-build.log",
                        "retention.json",
                    },
                )
            backend._validate_retention_archives(
                control / backend.PACKAGE_RETENTION_ARCHIVE_DIRNAME
            )
            backend._validated_package(
                package, "retention fixture current after cleanup", exclude_development_control=True
            )

    def test_retention_retries_after_archive_commit_without_losing_backup_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            package, control, _toolchain = self._rotated_package_fixture(Path(directory), versions=3)
            current = backend._validated_package(
                package, "retention fixture current", exclude_development_control=True
            )
            original_remove = backend._remove_owned_tree
            failed = False

            def fail_first_backup_delete(path):
                nonlocal failed
                if path.name.startswith(".backend-package-backup-") and not failed:
                    failed = True
                    raise backend.BackendBuildError("injected backup delete failure")
                return original_remove(path)

            with patch.object(backend, "_remove_owned_tree", side_effect=fail_first_backup_delete):
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
                candidate_records = backend._copy_package(workspace, candidate)
                (candidate / "bin/fullmag-bin").write_bytes(b"changed source candidate\n")
                candidate_records = backend._hash_package(candidate)
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
                retain.assert_called_once()
                serve.assert_called_once_with([])
                self.assertIn("retention-state-is-unknown", stderr.getvalue())
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
                if calls == 2:
                    raise backend.BackendBuildError("candidate build failed")
                candidate = args[2]
                workspace = self._package_workspace(root / "candidate")
                records = backend._copy_package(workspace, candidate)
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
                    }
                    self.assertEqual(backend.main(command), 2)
                after = {
                    path.relative_to(package).as_posix(): path.read_bytes()
                    for path in package.rglob("*")
                    if path.is_file()
                }
                self.assertEqual(after, before)
                self.assertEqual(serve.call_count, 1)
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
                records = backend._copy_package(workspace, candidate)
                if prepare_calls == 2:
                    binary = candidate / "bin/fullmag-bin"
                    binary.write_bytes(b"changed candidate\n")
                    records = backend._hash_package(candidate)
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
                    }
                    self.assertEqual(backend.main(command), 2)
                after = {
                    path.relative_to(package).as_posix(): path.read_bytes()
                    for path in package.rglob("*")
                    if path.is_file()
                }
                self.assertEqual(after, before)
                self.assertEqual(serve.call_count, 1)
                self.assertFalse(
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
                records = backend._copy_package(workspace, candidate)
                if calls == 2:
                    binary = candidate / "bin/fullmag-bin"
                    binary.write_bytes(b"changed candidate\n")
                    records = backend._hash_package(candidate)
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
            try:
                backend._publish_runtime_provenance(output)
                provenance = json.loads(provenance_path.read_text(encoding="utf-8"))
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
