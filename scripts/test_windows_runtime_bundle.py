#!/usr/bin/env python3
"""Fixture-only checks for the bounded native Windows executable bundle."""

from __future__ import annotations

import hashlib
import ast
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


WINDOWS_SCRIPTS = Path(__file__).resolve().parent / "windows"
sys.path.insert(0, str(WINDOWS_SCRIPTS))
import runtime_bundle  # noqa: E402


TARGET_TRIPLE = "x86_64-pc-windows-msvc"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def cargo_bin_names(path: Path) -> set[str]:
    names: set[str] = set()
    in_bin = False
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped == "[[bin]]":
            in_bin = True
            continue
        if stripped.startswith("["):
            in_bin = False
            continue
        if in_bin:
            match = re.fullmatch(r'name\s*=\s*"([^"]+)"', stripped)
            if match:
                names.add(match.group(1))
    return names


class WindowsRuntimeBundleTests(unittest.TestCase):
    def test_bundle_publisher_and_native_closed_source_schema_match(self):
        # Cross-language contract check: inspect the real publisher and reader,
        # rather than replacing Rust deserialization with a Python substitute.
        repo = Path(__file__).resolve().parents[1]
        publisher = ast.parse((repo / "scripts/windows/runtime_bundle.py").read_text())
        keys = set()
        for node in ast.walk(publisher):
            if not isinstance(node, ast.Assign):
                continue
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == "source_record" and isinstance(node.value, ast.Dict):
                    keys.update(key.value for key in node.value.keys if isinstance(key, ast.Constant))
                elif (isinstance(target, ast.Subscript) and isinstance(target.value, ast.Name)
                      and target.value.id == "source_record" and isinstance(target.slice, ast.Constant)):
                    keys.add(target.slice.value)
        native = (repo / "crates/fullmag-api/src/development_handoff_validation.rs").read_text()
        source_body = re.search(r"struct RuntimeBundleSource \{(.*?)\n\}", native, re.S).group(1)
        fields = set(re.findall(r"^\s*([a-z_][a-z0-9_]*):", source_body, re.M))
        self.assertTrue(keys)
        self.assertEqual(fields, keys, "the closed native parser must accept exactly the publisher's source fields")
        frozen_keys = None
        for node in ast.walk(publisher):
            if (isinstance(node, ast.Compare) and isinstance(node.left, ast.Call)
                    and isinstance(node.left.func, ast.Name) and node.left.func.id == "set"
                    and len(node.left.args) == 1 and isinstance(node.left.args[0], ast.Name)
                    and node.left.args[0].id == "frozen"):
                for value in node.comparators:
                    if isinstance(value, ast.Set):
                        frozen_keys = {item.value for item in value.elts if isinstance(item, ast.Constant)}
        snapshot_body = re.search(r"struct RuntimeBuildSourceSnapshot \{(.*?)\n\}", native, re.S).group(1)
        self.assertIsNotNone(frozen_keys)
        self.assertEqual(set(re.findall(r"^\s*([a-z_][a-z0-9_]*):", snapshot_body, re.M)), frozen_keys)

    def test_frozen_metadata_omission_and_valid_shape(self) -> None:
        self.assertIsNone(runtime_bundle._frozen_source_metadata({}))
        base = self.root / "not-opened"
        frozen = dict(record_path=str(base / "record.json"),
                      inventory_sha256="a" * 64, source_root=str(base / "source"))
        self.assertEqual(runtime_bundle._frozen_source_metadata(dict(build_source_snapshot=frozen)), frozen)
        self.assertFalse(base.exists(), "metadata validation must not open or create source paths")

    def test_frozen_metadata_null_and_invalid_shapes_are_rejected(self) -> None:
        base = self.root / "not-opened"
        valid = dict(record_path=str(base / "record.json"),
                     inventory_sha256="a" * 64, source_root=str(base / "source"))
        variants = (None, {}, {**valid, "extra": True}, {**valid, "inventory_sha256": "invalid"},
                    {**valid, "record_path": None}, {**valid, "record_path": "record.json"},
                    {**valid, "source_root": str(self.root / "other/source")},
                    {**valid, "record_path": str(base / "../record.json")},
                    {**valid, "source_root": valid["source_root"] + "\n"})
        for value in variants:
            with self.subTest(value=value), self.assertRaises(runtime_bundle.BundleError):
                runtime_bundle._frozen_source_metadata(dict(build_source_snapshot=value))

    def test_source_manifest_explicit_null_snapshot_is_rejected(self) -> None:
        self.source_manifest["build_source_snapshot"] = None
        self.write_source_manifest()
        with self.assertRaisesRegex(runtime_bundle.BundleError, "Invalid frozen source binding"):
            self.build_bundle()

    def test_sealed_bundle_explicit_null_snapshot_is_rejected(self) -> None:
        result = self.build_bundle()
        manifest_path = Path(result["bundle_root"]) / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["source"]["build_source_snapshot"] = None
        manifest_path.chmod(stat.S_IREAD | stat.S_IWRITE)  # Only this fixture's sealed manifest.
        manifest_path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(runtime_bundle.BundleError, "Invalid frozen source binding"):
            runtime_bundle.validate_bundle(result["bundle_root"], self.runtime_root, "dev")

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="fullmag-runtime-bundle-")
        self.root = Path(self.temp.name)
        self.build_root = self.root / "build"
        self.runtime_root = self.root / "runtime"
        self.profile_dir = self.build_root / "cargo-target" / TARGET_TRIPLE / "backend-dev"
        self.manifest_path = self.build_root / "windows-runtime" / "build-manifest.json"
        self.profile_dir.mkdir(parents=True)
        self.manifest_path.parent.mkdir(parents=True)
        self.runtime_root.mkdir()
        self.data: dict[str, bytes] = {}
        for name in runtime_bundle.BINARY_NAMES:
            content = ("fixture executable: " + name + "\n").encode("ascii")
            self.data[name] = content
            (self.profile_dir / name).write_bytes(content)
        self.source_manifest = {
            "schema_version": 1,
            "target_triple": TARGET_TRIPLE,
            "compiler_profile": "backend-dev",
            "binary": str(self.profile_dir / "fullmag.exe"),
            "api_binary": str(self.profile_dir / "fullmag-api.exe"),
            "desktop_binary": str(self.profile_dir / "fullmag-ui.exe"),
            "cuda": False,
            "features": [],
            "cargo_target_dir": str(self.build_root / "cargo-target"),
            "git_commit": "a" * 40,
            "source_snapshot_sha256": "b" * 64,
            "backend_source_sha256": "c" * 64,
            "dependency_source_sha256": "d" * 64,
            "workspace_namespace": "fixture-worktree",
            "build_version": {
                "schema": "fullmag.build-version.v1",
                "product": "fullmag",
                "version": "0.1.0-dev.fixture",
                "build_date_utc": "2026-10-03T00:00:00Z",
                "git_commit": "a" * 40,
                "source_snapshot_sha256": "b" * 64,
            },
            "worktree_state": "dirty",
            "source_identity_check": "skipped",
            "binary_sha256": sha256(self.data["fullmag.exe"]),
            "api_binary_sha256": sha256(self.data["fullmag-api.exe"]),
            "desktop_binary_sha256": sha256(self.data["fullmag-ui.exe"]),
            "executable_sha256": {
                name: sha256(content) for name, content in self.data.items()
            },
        }
        self.write_source_manifest()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def write_source_manifest(self) -> None:
        self.manifest_path.write_text(
            json.dumps(self.source_manifest, indent=2) + "\n", encoding="utf-8"
        )

    def build_bundle(self) -> dict[str, str]:
        return runtime_bundle.create_bundle(
            self.build_root,
            self.runtime_root,
            self.manifest_path,
            "dev",
        )

    def test_fixture_allowlist_matches_cargo_bin_targets(self) -> None:
        repo_root = Path(__file__).resolve().parents[1]
        api_bins = cargo_bin_names(repo_root / "crates/fullmag-api/Cargo.toml")
        api_bins.discard("fullmag-api-openapi")
        cli_bins = cargo_bin_names(repo_root / "crates/fullmag-cli/Cargo.toml")
        ui_bins = cargo_bin_names(repo_root / "apps/desktop/src-tauri/Cargo.toml")
        expected = {f"{name}.exe" for name in api_bins | cli_bins | ui_bins}
        self.assertEqual(set(runtime_bundle.BINARY_NAMES), expected)
        self.assertNotIn("fullmag-api-openapi.exe", runtime_bundle.BINARY_NAMES)

    def test_missing_or_malformed_dependency_identity_cannot_start_a_bundle(self) -> None:
        for digest in (None, "not-a-digest"):
            with self.subTest(digest=digest):
                self.source_manifest["dependency_source_sha256"] = digest
                self.write_source_manifest()
                with self.assertRaisesRegex(runtime_bundle.BundleError, "dependency_source_sha256"):
                    self.build_bundle()

    def test_valid_bundle_is_sealed_and_independent_of_cargo_sources(self) -> None:
        result = self.build_bundle()
        bundle_root = Path(result["bundle_root"])
        manifest, checks = runtime_bundle.validate_bundle(bundle_root, self.runtime_root, "dev")
        self.assertEqual(manifest["qualification"], "not_assessed")
        self.assertEqual(len(checks), len(runtime_bundle.BINARY_NAMES))
        self.assertEqual(Path(result["fullmag_exe"]), bundle_root / "bin/fullmag.exe")
        self.assertEqual((bundle_root / "bin/fullmag.exe").read_bytes(), self.data["fullmag.exe"])
        self.assertFalse((bundle_root / "bin/fullmag.exe").stat().st_mode & stat.S_IWUSR)

        (self.profile_dir / "fullmag.exe").write_bytes(b"Cargo relinked this source\n")
        self.assertEqual((bundle_root / "bin/fullmag.exe").read_bytes(), self.data["fullmag.exe"])
        self.assertEqual(runtime_bundle.validate_bundle(bundle_root, self.runtime_root, "dev")[1], checks)

    def test_source_profile_mismatch_is_rejected(self) -> None:
        with self.assertRaises(runtime_bundle.BundleError):
            runtime_bundle.create_bundle(
                self.build_root, self.runtime_root, self.manifest_path, "release"
            )
        self.assertFalse((self.runtime_root / "native-bundles").exists())

    def test_relative_roots_are_rejected(self) -> None:
        with self.assertRaises(runtime_bundle.BundleError):
            runtime_bundle.create_bundle(
                "relative-build", self.runtime_root, self.manifest_path, "dev"
            )

    def test_path_escape_is_rejected(self) -> None:
        outside = self.root / "outside.exe"
        outside.write_bytes(b"outside")
        self.source_manifest["binary"] = str(outside)
        self.write_source_manifest()
        with self.assertRaises(runtime_bundle.BundleError):
            self.build_bundle()

    def test_symlink_source_is_rejected(self) -> None:
        source = self.profile_dir / "fullmag.exe"
        outside = self.root / "outside.exe"
        outside.write_bytes(self.data["fullmag.exe"])
        source.unlink()
        try:
            source.symlink_to(outside)
        except (OSError, NotImplementedError) as error:
            # Keep this path covered on hosts without symlink creation rights.
            source.write_bytes(self.data["fullmag.exe"])
            original_detector = runtime_bundle._is_reparse_point
            with mock.patch.object(
                runtime_bundle,
                "_is_reparse_point",
                side_effect=lambda path, info=None: Path(path) == source
                or original_detector(path, info),
            ):
                with self.assertRaises(runtime_bundle.BundleError):
                    self.build_bundle()
            self.assertIsNotNone(error)
            return
        with self.assertRaises(runtime_bundle.BundleError):
            self.build_bundle()

    def test_declared_hash_mismatch_is_rejected(self) -> None:
        self.source_manifest["binary_sha256"] = "d" * 64
        self.write_source_manifest()
        with self.assertRaises(runtime_bundle.BundleError):
            self.build_bundle()

    def test_new_full_executable_hash_map_covers_workers(self) -> None:
        worker = "fullmag-api-accepted-worker.exe"
        self.source_manifest["executable_sha256"][worker] = "d" * 64
        self.write_source_manifest()
        with self.assertRaises(runtime_bundle.BundleError):
            self.build_bundle()

    def test_legacy_manifest_without_full_hash_map_remains_supported(self) -> None:
        self.source_manifest.pop("executable_sha256")
        self.write_source_manifest()
        self.build_bundle()

    def test_build_version_source_mismatch_is_rejected(self) -> None:
        self.source_manifest["build_version"]["git_commit"] = "e" * 40
        self.write_source_manifest()
        with self.assertRaises(runtime_bundle.BundleError):
            self.build_bundle()

    def test_direct_script_checks_frozen_binding_without_pythonpath(self) -> None:
        self.source_manifest["build_source_snapshot"] = {}
        self.write_source_manifest()
        environment = dict(os.environ)
        environment.pop("PYTHONPATH", None)
        result = subprocess.run(
            [sys.executable, "-B", str(WINDOWS_SCRIPTS / "runtime_bundle.py"),
             "--build-root", str(self.build_root), "--runtime-root", str(self.runtime_root),
             "--manifest", str(self.manifest_path), "--profile", "dev"],
            cwd=self.root, env=environment, capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("runtime bundle error: Invalid frozen source binding", result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertFalse((self.runtime_root / "native-bundles").exists())

    def test_missing_required_worker_is_rejected(self) -> None:
        (self.profile_dir / "fullmag-api-accepted-worker.exe").unlink()
        with self.assertRaises(runtime_bundle.BundleError):
            self.build_bundle()

    def test_failed_copy_preserves_staging_directory(self) -> None:
        original_copy = runtime_bundle.shutil.copyfile

        def relink_after_first_copy(source: Path, destination: Path) -> None:
            original_copy(source, destination)
            if Path(source).name == "fullmag.exe":
                Path(source).write_bytes(b"concurrent Cargo relink")

        # The source-after-copy check must fail and retain the partial staging tree.
        with mock.patch.object(runtime_bundle.shutil, "copyfile", side_effect=relink_after_first_copy):
            with self.assertRaises(runtime_bundle.BundleError):
                self.build_bundle()
        bundles_root = self.runtime_root / "native-bundles"
        staging = [item for item in bundles_root.iterdir() if item.name.startswith(".staging-")]
        self.assertEqual(len(staging), 1)
        self.assertTrue((staging[0] / "bin/fullmag.exe").exists())

    def test_bundle_validator_detects_modified_copy(self) -> None:
        result = self.build_bundle()
        bundled_exe = Path(result["fullmag_exe"])
        bundled_exe.chmod(stat.S_IREAD | stat.S_IWRITE)
        bundled_exe.write_bytes(b"modified bundle executable")
        with self.assertRaises(runtime_bundle.BundleError):
            runtime_bundle.validate_bundle(result["bundle_root"], self.runtime_root, "dev")


if __name__ == "__main__":
    unittest.main(verbosity=2)
