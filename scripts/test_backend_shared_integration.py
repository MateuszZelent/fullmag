"""Shared-cache integration with the real package/receipt validators."""
import argparse
from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "docker/all-in-one"))
import backend_dev as backend
import backend_shared_store as shared
import test_docker_backend_dev as fixtures


class SharedBackendIntegrationTests(unittest.TestCase):
    def test_shared_hit_validates_real_package_and_keeps_consumer_receipt_private(self):
        fixture = fixtures.BackendPackageTests()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            store_root = root / "shared"
            store_root.mkdir()
            store = shared.Store(store_root)
            producer, records = fixture._published_package(root / "producer")
            manifest_path, manifest = fixture._live_manifest(root)
            toolchain = fixture._toolchain_fixture()
            receipt = fixture._receipt_for_manifest(records, manifest, toolchain)
            group = "groups/" + "a" * 64
            package = store_root / group
            package.mkdir(parents=True)
            build_root = root / "build"
            build_root.mkdir()
            with patch.object(shared, "ROOT", store_root), patch.object(backend, "PACKAGE_ROOT", package), \
                    patch.object(backend, "_dev_cuda_architectures", return_value=None), \
                    patch.dict(os.environ, {"FULLMAG_SHARED_BACKEND_STORE": str(store_root), "FULLMAG_SHARED_BACKEND_GROUP": group}), \
                    patch.object(backend, "_prepare_locked", side_effect=AssertionError("must not compile")):
                identity = backend._shared_package_identity(manifest_path, toolchain, None)
                receipt["shared_package"] = {"schema": shared.SCHEMA, "key": shared.key_for(identity), "inputs": identity, "reuse": "publisher"}
                with store.claim(identity) as entry:
                    entry.publish(producer, receipt)
                control = backend._ensure_package_development_root(package)
                candidate = Path(tempfile.mkdtemp(prefix=".backend-package-candidate-", dir=control / backend.PACKAGE_CANDIDATES_DIRNAME))
                backend._write_candidate_marker(candidate, package, build_root, state="building")
                result = backend._prepare_with_shared_package(argparse.Namespace(manifest=manifest_path), build_root,
                    candidate, 2, toolchain, candidate)
                self.assertEqual(result, 0)
                current, _, _ = backend._validated_package(candidate, "shared consumer", exclude_candidate_marker=True)
                self.assertEqual(current["operation"], "direct-compose-cache-reuse")
                self.assertEqual(current["shared_package"]["reuse"], "verified-hardlinks")
                self.assertEqual((candidate / "bin/fullmag-api").stat().st_ino, (producer / "bin/fullmag-api").stat().st_ino)
                self.assertEqual((candidate / "backend-build-receipt.json").stat().st_nlink, 1)
                backend._validate_candidate_marker(candidate, package, build_root, state="ready")

    def test_shared_key_changes_with_compiled_commit_cuda_and_compiler_flags(self):
        fixture = fixtures.BackendPackageTests()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first, _ = fixture._live_manifest(root, capture_id="one")
            second, _ = fixture._live_manifest(root, commit="b" * 40, capture_id="two")
            toolchain = fixture._toolchain_fixture()
            key = lambda path, cuda: shared.key_for(backend._shared_package_identity(path, toolchain, cuda))
            keys = {key(first, "89-real"), key(second, "89-real"), key(first, "90-real")}
            with patch.dict(os.environ, {"RUSTFLAGS": "-C target-cpu=native"}):
                keys.add(key(first, "89-real"))
            self.assertEqual(len(keys), 4)

    def test_explicit_maintenance_preserves_current_and_direct_rollback(self):
        fixture = fixtures.BackendPackageTests()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package, control, current = fixture._rotated_package_fixture(root, versions=3)
            build = root / "build"
            build.mkdir(exist_ok=True)
            before = (package / "backend-build-receipt.json").read_bytes()
            with patch.object(backend, "PACKAGE_ROOT", package), patch.object(backend, "BUILD_ROOT", build), \
                    patch.dict(os.environ, {"FULLMAG_SHARED_BACKEND_STORE": ""}), redirect_stdout(io.StringIO()) as output:
                self.assertEqual(backend.main(["maintain-packages"]), 0)
            result = json.loads(output.getvalue().splitlines()[-1])
            self.assertEqual(result["retained"], ["current", "direct-rollback"])
            self.assertEqual((package / "backend-build-receipt.json").read_bytes(), before)
            self.assertEqual(len(list((control / backend.PACKAGE_BACKUPS_DIRNAME).iterdir())), 1)

    def test_retention_accepts_cuda_target_changes_in_the_verified_rotation_chain(self):
        fixture = fixtures.BackendPackageTests()
        original = fixture._receipt_for_manifest
        targets = iter(['89-real', '90-real', '89-real', '90-real'])
        def receipt(*args, **kwargs):
            value = original(*args, **kwargs)
            value['build']['cuda_architectures'] = next(targets)
            return value
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with patch.object(fixture, '_receipt_for_manifest', receipt):
                package, control, _ = fixture._rotated_package_fixture(root, versions=3)
            current, raw, _ = backend._validated_package(package, 'current', exclude_development_control=True)
            backend._retain_package_backups(package, control, current, raw)
            self.assertEqual(len(list((control / backend.PACKAGE_BACKUPS_DIRNAME).iterdir())), 1)

    def test_shared_cargo_changes_only_package_cache_home(self):
        with tempfile.TemporaryDirectory() as temporary:
            build = Path(temporary)
            with patch.dict(os.environ, {"FULLMAG_SHARED_CARGO_HOME": ""}):
                self.assertEqual(backend._cargo_home(build), str(build / "cargo"))
            with patch.dict(os.environ, {"FULLMAG_SHARED_CARGO_HOME": "/tmp/foreign"}):
                with self.assertRaises(backend.BackendBuildError):
                    backend._cargo_home(build)


if __name__ == "__main__":
    unittest.main()
