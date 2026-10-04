"""Interpreted regressions for the Fullmag package build backend."""

from __future__ import annotations

from datetime import date as calendar_date
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


BACKEND_PATH = Path(__file__).resolve().parents[1] / "fullmag_build_backend.py"
SPEC = importlib.util.spec_from_file_location("fullmag_build_backend_test_module", BACKEND_PATH)
assert SPEC is not None and SPEC.loader is not None
backend = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = backend
SPEC.loader.exec_module(backend)


class BuildBackendTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.root = Path(self.temporary_directory.name) / "package"
        self.root.mkdir()
        self._write_project()

    def _write_project(self, version: str = "0.1.0") -> None:
        (self.root / "pyproject.toml").write_text(
            "[project]\n"
            "name = \"fullmag\"\n"
            f"version = \"{version}\"\n",
            encoding="utf-8",
        )

    @staticmethod
    def _record(
        *,
        base: str = "0.1.0",
        commit: str = "0123456789abcdef0123456789abcdef01234567",
        snapshot: str = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        dirty: bool = False,
        date: str = "2026-10-03",
    ) -> dict[str, object]:
        token = date.replace("-", "")
        short_commit = commit[:12]
        short_snapshot = snapshot[:12]
        days_since_2000 = (
            calendar_date.fromisoformat(date) - calendar_date.fromisoformat("2000-01-01")
        ).days
        pep440 = f"{base}.dev{token}+g{short_commit}"
        semver = f"{base}-dev.{token}.g{short_commit}"
        if dirty:
            pep440 += f".dirty.s{short_snapshot}"
            semver += f".dirty.s{short_snapshot}"
        semver += f"+{days_since_2000}"
        base_components = [int(component) for component in base.split(".")]
        return {
            "schema": backend.SCHEMA,
            "product": "fullmag",
            "base_version": base,
            "base_version_source": "pyproject.toml:[project].version",
            "development": True,
            "version": semver,
            "product_version": semver,
            "semver_version": semver,
            "pep440_version": pep440,
            "build_date": date,
            "build_date_utc": f"{date}T12:34:56Z",
            "git_commit": commit,
            "git_short_commit": short_commit,
            "source_snapshot_sha256": snapshot,
            "source_snapshot_short": short_snapshot,
            "dirty": dirty,
            "worktree_state": "dirty" if dirty else "clean",
            "windows_file_version": ".".join(
                str(component) for component in [*base_components, days_since_2000]
            ),
            "windows_file_version_segments": [*base_components, days_since_2000],
        }

    def _write_record(self, record: dict[str, object]) -> Path:
        path = self.root / "managed-version.json"
        path.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
        return path

    def test_managed_record_is_the_only_version_source_and_provider_matches(self) -> None:
        record_path = self._write_record(self._record(dirty=True))
        with mock.patch.dict(
            os.environ,
            {backend.VERSION_FILE_ENV: str(record_path)},
            clear=True,
        ):
            resolution = backend.resolve_version(self.root)
            self.assertEqual(backend.get_version(self.root), resolution.pep440_version)

        self.assertTrue(resolution.version_source_bound)
        self.assertEqual(resolution.reason, "managed-version-file")
        self.assertEqual(
            resolution.pep440_version,
            "0.1.0.dev20261003+g0123456789ab.dirty.sabcdef012345",
        )

    def test_bound_identity_is_preferred_to_a_fresh_checkout_capture(self) -> None:
        repo_root = self.root
        (repo_root / "Cargo.toml").write_text(
            "[workspace]\n[workspace.package]\nversion = \"0.1.0\"\n",
            encoding="utf-8",
        )
        (repo_root / ".git").mkdir()
        scripts = repo_root / "scripts"
        scripts.mkdir()
        (scripts / "build_version.py").write_text("# fixture\n", encoding="utf-8")
        (scripts / "capture_source_snapshot_identity.py").write_text(
            "# fixture\n", encoding="utf-8"
        )
        identity_path = self.root / "bound-source-identity.json"
        identity_path.write_text("{}\n", encoding="utf-8")
        expected = backend.VersionResolution(
            pep440_version="0.1.0.dev20261003+g0123456789ab",
            base_version="0.1.0",
            version_source_bound=True,
            reason="managed-source-identity",
        )
        with mock.patch.dict(
            os.environ,
            {backend.SOURCE_IDENTITY_FILE_ENV: str(identity_path)},
            clear=True,
        ), mock.patch.object(
            backend, "_generate_from_identity", return_value=expected
        ) as generate, mock.patch.object(
            backend, "_capture_current_source"
        ) as capture:
            resolution = backend.resolve_version(self.root)

        generate.assert_called_once_with(repo_root, identity_path, "0.1.0")
        capture.assert_not_called()
        self.assertEqual(resolution, expected)

    def test_invalid_managed_record_fails_closed(self) -> None:
        record = self._record()
        record["git_commit"] = "A" * 40
        record_path = self._write_record(record)
        with mock.patch.dict(
            os.environ,
            {backend.VERSION_FILE_ENV: str(record_path)},
            clear=True,
        ):
            with self.assertRaises(backend.BuildBackendError):
                backend.resolve_version(self.root)

    def test_archive_fallback_requires_explicit_opt_in_and_is_unqualified(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(backend.BuildBackendError, "ALLOW_UNQUALIFIED"):
                backend.resolve_version(self.root)

        with mock.patch.dict(
            os.environ,
            {backend.ALLOW_UNQUALIFIED_ENV: "1"},
            clear=True,
        ):
            resolution = backend.resolve_version(self.root)
        self.assertFalse(resolution.version_source_bound)
        self.assertEqual(resolution.reason, "source-archive-without-git")
        self.assertEqual(resolution.pep440_version, "0.1.0")

    def test_archive_reuses_verified_pkg_info_version_before_base_fallback(self) -> None:
        package_version = "0.1.0.dev20261003+g0123456789ab"
        (self.root / "PKG-INFO").write_text(
            "Metadata-Version: 2.1\n"
            "Name: fullmag\n"
            f"Version: {package_version}\n\n",
            encoding="utf-8",
        )
        with mock.patch.dict(os.environ, {}, clear=True):
            resolution = backend.resolve_version(self.root)

        self.assertFalse(resolution.version_source_bound)
        self.assertEqual(resolution.reason, "source-archive-pkg-info")
        self.assertEqual(resolution.pep440_version, package_version)

    def test_dynamic_project_version_uses_cargo_workspace_authority(self) -> None:
        (self.root / "pyproject.toml").write_text(
            "[project]\nname = \"fullmag\"\ndynamic = [\"version\"]\n",
            encoding="utf-8",
        )
        (self.root / "Cargo.toml").write_text(
            "[workspace]\n[workspace.package]\nversion = \"3.4.5\"\n",
            encoding="utf-8",
        )
        record_path = self._write_record(self._record(base="3.4.5"))
        with mock.patch.dict(
            os.environ,
            {backend.VERSION_FILE_ENV: str(record_path)},
            clear=True,
        ):
            resolution = backend.resolve_version(self.root)
        self.assertEqual(resolution.base_version, "3.4.5")
        self.assertEqual(resolution.pep440_version, "3.4.5.dev20261003+g0123456789ab")

    def test_dynamic_archive_needs_an_explicit_base_version_for_fallback(self) -> None:
        (self.root / "pyproject.toml").write_text(
            "[project]\nname = \"fullmag\"\ndynamic = [\"version\"]\n",
            encoding="utf-8",
        )
        with mock.patch.dict(
            os.environ,
            {
                backend.ALLOW_UNQUALIFIED_ENV: "1",
                "FULLMAG_BASE_VERSION": "4.5.6",
            },
            clear=True,
        ):
            resolution = backend.resolve_version(self.root)
        self.assertEqual(resolution.pep440_version, "4.5.6")
        self.assertFalse(resolution.version_source_bound)

    def test_setuptools_metadata_uses_managed_pep440_version_without_source_edit(self) -> None:
        (self.root / "src" / "fullmag_fixture").mkdir(parents=True)
        (self.root / "src" / "fullmag_fixture" / "__init__.py").write_text(
            "__version__ = 'fixture'\n", encoding="utf-8"
        )
        (self.root / "pyproject.toml").write_text(
            "[build-system]\nrequires = [\"setuptools>=69\"]\n"
            "build-backend = \"setuptools.build_meta\"\n\n"
            "[project]\nname = \"fullmag\"\ndynamic = [\"version\"]\n\n"
            "[tool.setuptools]\npackage-dir = {\"\" = \"src\"}\n\n"
            "[tool.setuptools.packages.find]\nwhere = [\"src\"]\n",
            encoding="utf-8",
        )
        (self.root / "fullmag_build_backend.py").write_bytes(BACKEND_PATH.read_bytes())
        (self.root / "setup.py").write_text(
            "from pathlib import Path\n"
            "import sys\n"
            "from setuptools import setup\n"
            "sys.path.insert(0, str(Path(__file__).resolve().parent))\n"
            "from fullmag_build_backend import get_version\n"
            "setup(version=get_version())\n",
            encoding="utf-8",
        )
        record_path = self._write_record(self._record())
        metadata_directory = self.root / "metadata"
        metadata_directory.mkdir()
        original = (self.root / "pyproject.toml").read_bytes()
        previous_directory = Path.cwd()
        with mock.patch.dict(
            os.environ,
            {backend.VERSION_FILE_ENV: str(record_path)},
            clear=False,
        ):
            os.chdir(self.root)
            try:
                from setuptools import build_meta

                result = build_meta.prepare_metadata_for_build_wheel(str(metadata_directory))
            finally:
                os.chdir(previous_directory)

        metadata = (metadata_directory / result / "METADATA").read_text(encoding="utf-8")
        self.assertIn("Version: 0.1.0.dev20261003+g0123456789ab", metadata)
        self.assertEqual((self.root / "pyproject.toml").read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
