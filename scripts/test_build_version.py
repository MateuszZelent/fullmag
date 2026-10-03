"""Interpreted regression tests for scripts/build_version.py."""

from __future__ import annotations

from datetime import date, datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

try:
    from packaging.version import Version
except ImportError:  # Optional for the source-only regression suite.
    Version = None  # type: ignore[assignment]

try:
    from scripts.build_version import (
        BuildVersionError,
        build_version_record,
        canonical_json_bytes,
        load_source_identity,
        write_version_record,
    )
except ModuleNotFoundError:  # Direct ``python scripts/test_build_version.py``.
    from build_version import (  # type: ignore[no-redef]
        BuildVersionError,
        build_version_record,
        canonical_json_bytes,
        load_source_identity,
        write_version_record,
    )


class BuildVersionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.root = Path(self.temporary_directory.name) / "repo"
        self.root.mkdir()
        (self.root / "Cargo.toml").write_text(
            "[workspace]\n[workspace.package]\nversion = \"0.1.7\"\n",
            encoding="utf-8",
        )
        self.identity_path = self.root / "source-identity.json"

    def write_identity(
        self,
        *,
        commit: str = "0123456789abcdef0123456789abcdef01234567",
        snapshot: str = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        dirty: bool = False,
        reverse_order: bool = False,
    ) -> None:
        status = [] if not dirty else [{"status": " M", "paths": ["dirty.txt"]}]
        dirty_content = [] if not dirty else [
            {
                "path": "dirty.txt",
                "kind": "regular_file",
                "mode": "100644",
                "sha256": "d" * 64,
            }
        ]
        payload = {
            "schema": "fullmag.source-snapshot.v2",
            "head_commit_full": commit,
            "head_tree_sha256": snapshot,
            "git_status_porcelain_v1": status,
            "dirty_path_content": dirty_content,
        }
        values = {
            **payload,
            "source_snapshot_dirty": dirty,
            "dirty_content_sha256": hashlib.sha256(
                json.dumps(
                    dirty_content,
                    ensure_ascii=False,
                    separators=(",", ":"),
                    sort_keys=True,
                ).encode("utf-8")
                + b"\n"
            ).hexdigest(),
        }
        values["source_snapshot_sha256"] = hashlib.sha256(
            json.dumps(
                payload,
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
            ).encode("utf-8")
            + b"\n"
        ).hexdigest()
        if reverse_order:
            values = dict(reversed(list(values.items())))
        self.identity_path.write_text(
            json.dumps(values, indent=2) + "\n", encoding="utf-8"
        )

    @staticmethod
    def epoch(year: int, month: int, day: int) -> str:
        return str(
            int(
                datetime(year, month, day, 12, 34, 56, tzinfo=timezone.utc).timestamp()
            )
        )

    def test_reproducible_record_is_independent_of_input_json_order(self) -> None:
        self.write_identity(reverse_order=False)
        first = build_version_record(
            self.root, self.identity_path, source_date_epoch=self.epoch(2026, 10, 3)
        )
        first_bytes = canonical_json_bytes(first)

        self.write_identity(reverse_order=True)
        second = build_version_record(
            self.root, self.identity_path, source_date_epoch=self.epoch(2026, 10, 3)
        )
        second_bytes = canonical_json_bytes(second)

        self.assertEqual(first, second)
        self.assertEqual(first_bytes, second_bytes)

    def test_development_formats_and_windows_segments_are_bounded(self) -> None:
        self.write_identity()
        record = build_version_record(
            self.root, self.identity_path, source_date_epoch=self.epoch(2026, 10, 3)
        )

        days_since_2000 = (date(2026, 10, 3) - date(2000, 1, 1)).days
        self.assertEqual(
            record["version"],
            f"0.1.7-dev.20261003.g0123456789ab+{days_since_2000}",
        )
        self.assertEqual(record["product_version"], record["version"])
        self.assertEqual(record["semver_version"], record["version"])
        self.assertEqual(record["pep440_version"], "0.1.7.dev20261003+g0123456789ab")
        self.assertEqual(record["build_date_utc"], "2026-10-03T12:34:56Z")
        self.assertEqual(record["windows_file_version_segments"], [0, 1, 7, days_since_2000])
        self.assertEqual(record["windows_file_version"], f"0.1.7.{days_since_2000}")
        self.assertTrue(
            all(0 <= segment <= 65535 for segment in record["windows_file_version_segments"])
        )
        self.assertNotIn("20261003", record["windows_file_version_segments"])

    def test_source_date_epoch_environment_is_used(self) -> None:
        self.write_identity()
        with mock.patch.dict(os.environ, {"SOURCE_DATE_EPOCH": self.epoch(2000, 1, 1)}):
            record = build_version_record(self.root, self.identity_path)

        self.assertEqual(record["build_date_utc"], "2000-01-01T12:34:56Z")
        self.assertEqual(
            record["version"],
            f"0.1.7-dev.20000101.g0123456789ab+{(date(2000, 1, 1) - date(2000, 1, 1)).days}",
        )

    def test_windows_file_version_rejects_dates_before_2000(self) -> None:
        self.write_identity()
        with self.assertRaisesRegex(BuildVersionError, "days since 2000"):
            build_version_record(
                self.root,
                self.identity_path,
                source_date_epoch=self.epoch(1970, 1, 1),
            )

    def test_explicit_utc_now_is_used_when_epoch_is_absent(self) -> None:
        self.write_identity()
        with mock.patch.dict(os.environ, {}, clear=True):
            record = build_version_record(
                self.root,
                self.identity_path,
                now=datetime(2031, 2, 4, 5, 6, 7, 987654, tzinfo=timezone.utc),
            )

        self.assertEqual(record["build_date_utc"], "2031-02-04T05:06:07Z")

    def test_dirty_same_head_has_unique_snapshot_bound_versions(self) -> None:
        commit = "f" * 40
        self.write_identity(commit=commit, snapshot="a" * 64, dirty=True)
        first = build_version_record(
            self.root, self.identity_path, source_date_epoch=self.epoch(2026, 10, 3)
        )

        self.write_identity(commit=commit, snapshot="b" * 64, dirty=True)
        second = build_version_record(
            self.root, self.identity_path, source_date_epoch=self.epoch(2026, 10, 3)
        )

        self.assertNotEqual(first["version"], second["version"])
        self.assertNotEqual(first["pep440_version"], second["pep440_version"])
        self.assertEqual(first["git_commit"], second["git_commit"])
        self.assertIn(
            f".dirty.s{first['source_snapshot_sha256'][:12]}+",
            first["version"],
        )
        self.assertIn(
            f".dirty.s{second['source_snapshot_sha256'][:12]}+",
            second["version"],
        )
        self.assertTrue(first["version"].endswith("+" + str(first["windows_file_version_segments"][3])))
        self.assertTrue(second["version"].endswith("+" + str(second["windows_file_version_segments"][3])))
        self.assertTrue(
            first["pep440_version"].endswith(
                f".dirty.s{first['source_snapshot_sha256'][:12]}"
            )
        )

    def test_captured_older_commit_is_used_without_consulting_current_git(self) -> None:
        older_commit = "1234" * 10
        self.write_identity(commit=older_commit)
        record = build_version_record(
            self.root, self.identity_path, source_date_epoch=self.epoch(2026, 10, 3)
        )

        self.assertEqual(record["git_commit"], older_commit)
        self.assertEqual(record["git_short_commit"], older_commit[:12])

    def test_cargo_workspace_is_required_even_if_pyproject_exists(self) -> None:
        (self.root / "Cargo.toml").unlink()
        (self.root / "pyproject.toml").write_text(
            "[project]\nname = \"fullmag\"\nversion = \"2.3.4\"\n",
            encoding="utf-8",
        )
        self.write_identity()
        with self.assertRaisesRegex(BuildVersionError, "Cargo workspace manifest"):
            build_version_record(
                self.root, self.identity_path, source_date_epoch=self.epoch(2026, 10, 3)
            )

    def test_cargo_and_pyproject_version_mismatch_fails_closed(self) -> None:
        (self.root / "pyproject.toml").write_text(
            "[project]\nname = \"fullmag\"\nversion = \"2.3.4\"\n",
            encoding="utf-8",
        )
        self.write_identity()
        with self.assertRaisesRegex(BuildVersionError, "manifests disagree"):
            build_version_record(
                self.root, self.identity_path, source_date_epoch=self.epoch(2026, 10, 3)
            )

    def test_hardcoded_python_package_version_must_match_workspace(self) -> None:
        package_manifest = self.root / "packages" / "fullmag-py" / "pyproject.toml"
        package_manifest.parent.mkdir(parents=True)
        package_manifest.write_text(
            "[project]\nname = \"fullmag\"\nversion = \"0.1.8\"\n",
            encoding="utf-8",
        )
        self.write_identity()
        with self.assertRaisesRegex(BuildVersionError, "manifests disagree"):
            build_version_record(
                self.root, self.identity_path, source_date_epoch=self.epoch(2026, 10, 3)
            )

    def test_dynamic_python_package_version_is_not_a_second_authority(self) -> None:
        package_manifest = self.root / "packages" / "fullmag-py" / "pyproject.toml"
        package_manifest.parent.mkdir(parents=True)
        package_manifest.write_text(
            "[project]\nname = \"fullmag\"\ndynamic = [\"version\"]\n",
            encoding="utf-8",
        )
        self.write_identity()
        record = build_version_record(
            self.root, self.identity_path, source_date_epoch=self.epoch(2026, 10, 3)
        )
        self.assertEqual(record["base_version"], "0.1.7")

    def test_source_identity_schema_and_payload_hash_are_verified(self) -> None:
        self.write_identity()
        document = json.loads(self.identity_path.read_text(encoding="utf-8"))
        document["head_tree_sha256"] = "b" * 64
        self.identity_path.write_text(json.dumps(document), encoding="utf-8")
        with self.assertRaisesRegex(BuildVersionError, "does not match its payload"):
            load_source_identity(self.identity_path)

        document["head_tree_sha256"] = "a" * 64
        document["schema"] = "other"
        self.identity_path.write_text(json.dumps(document), encoding="utf-8")
        with self.assertRaisesRegex(BuildVersionError, "schema"):
            load_source_identity(self.identity_path)

    def test_invalid_identity_values_are_rejected(self) -> None:
        invalid_documents = (
            {"head_commit_full": "A" * 40, "source_snapshot_sha256": "a" * 64, "source_snapshot_dirty": False},
            {"head_commit_full": "a" * 40, "source_snapshot_sha256": "a" * 63, "source_snapshot_dirty": False},
            {"head_commit_full": "a" * 40, "source_snapshot_sha256": "a" * 64, "source_snapshot_dirty": "false"},
        )
        for document in invalid_documents:
            with self.subTest(document=document):
                self.identity_path.write_text(json.dumps(document), encoding="utf-8")
                with self.assertRaises(BuildVersionError):
                    load_source_identity(self.identity_path)

    def test_output_is_written_only_when_an_explicit_file_is_selected(self) -> None:
        self.write_identity()
        record = build_version_record(
            self.root, self.identity_path, source_date_epoch=self.epoch(2026, 10, 3)
        )
        output = self.root / "generated" / "version.json"
        write_version_record(record, output)

        self.assertEqual(output.read_bytes(), canonical_json_bytes(record))
        self.assertFalse((self.root / "version.json").exists())

    def test_output_directory_is_rejected(self) -> None:
        self.write_identity()
        record = build_version_record(
            self.root, self.identity_path, source_date_epoch=self.epoch(2026, 10, 3)
        )
        output = self.root / "generated"
        output.mkdir()
        with self.assertRaisesRegex(BuildVersionError, "regular"):
            write_version_record(record, output)

    @unittest.skipUnless(Version is not None, "packaging is not installed")
    def test_pep440_version_is_accepted_by_packaging(self) -> None:
        self.write_identity(dirty=True)
        record = build_version_record(
            self.root, self.identity_path, source_date_epoch=self.epoch(2026, 10, 3)
        )
        assert Version is not None
        self.assertEqual(str(Version(record["pep440_version"])), record["pep440_version"])

    def test_invalid_epoch_and_naive_now_fail_closed(self) -> None:
        self.write_identity()
        with self.assertRaises(BuildVersionError):
            build_version_record(self.root, self.identity_path, source_date_epoch="not-an-epoch")
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(BuildVersionError):
                build_version_record(
                    self.root,
                    self.identity_path,
                    now=datetime(2026, 10, 3, 12, 0, 0),
                )


if __name__ == "__main__":
    unittest.main()
