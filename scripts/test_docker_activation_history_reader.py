from __future__ import annotations

import hashlib
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from docker_activation_history_reader import (
    ARCHIVE_SCHEMA,
    INDEX_MAX_BYTES,
    MAX_ARCHIVE_BYTES,
    MAX_ARCHIVE_FILES,
    MAX_DOCUMENT_BYTES,
    MAX_LOG_BYTES,
    activation_history_read_script,
)


ATTEMPT = "0123456789abcdef0123456789abcdef"
REQUIRED_FILES = {
    "receipt.json": b'{"receipt":true}\n',
    "terminal.json": b'{"terminal":true}\n',
    "result.json": b'{"result":true}\n',
    "startup-provenance.json": b'{"startup":true}\n',
    "authorization.json": b'{"authorization":true}\n',
    "build.log": b"activation build output\n",
}


class ActivationHistoryReadScriptTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="activation-history-")
        self.addCleanup(self.temp.cleanup)
        self.control = Path(self.temp.name) / "control"
        self.activation = self.control / "activation"
        self.live_root = self.activation / "attempts"
        self.history_root = self.activation / "history-v1"
        self.live_attempt = self.live_root / ATTEMPT
        self.archive = self.history_root / ATTEMPT
        self.control.mkdir()
        self.activation.mkdir()

    def run_read(self, filename: str, *, maximum: int = 4096) -> subprocess.CompletedProcess[bytes]:
        logical = f"/control/activation/attempts/{ATTEMPT}/{filename}"
        script = activation_history_read_script(logical, maximum)
        self.assertIsNotNone(script)
        assert script is not None
        script = script.replace("/control", str(self.control))
        return subprocess.run(
            ["/bin/bash", "-euo", "pipefail", "-c", script],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )

    def make_live(self, files: dict[str, bytes] | None = None) -> None:
        self.live_attempt.mkdir(parents=True)
        for name, payload in (files or REQUIRED_FILES).items():
            (self.live_attempt / name).write_bytes(payload)

    def make_archive(
        self,
        files: dict[str, bytes] | None = None,
        *,
        header: str | None = None,
        rows: list[tuple[str, int, str]] | None = None,
        include_index: bool = True,
    ) -> None:
        payloads = dict(REQUIRED_FILES if files is None else files)
        payloads[".history.json"] = (
            '{"schema":"fullmag.activation-history.v1",'
            f'"attempt":"{ATTEMPT}"}}\n'
        ).encode("ascii")
        self.archive.mkdir(parents=True)
        for name, payload in payloads.items():
            (self.archive / name).write_bytes(payload)
        if not include_index:
            return
        if rows is None:
            rows = [
                (hashlib.sha256(payload).hexdigest(), len(payload), name)
                for name, payload in payloads.items()
            ]
            rows.sort(key=lambda row: row[2])
        index = self.archive / ".history.sha256"
        index.write_text(
            (header or f"{ARCHIVE_SCHEMA} {ATTEMPT}")
            + "\n"
            + "".join(f"{digest} {size} {name}\n" for digest, size, name in rows),
            encoding="ascii",
        )

    def reset_archive(self) -> None:
        if self.archive.is_symlink():
            self.archive.unlink()
        elif self.archive.exists():
            shutil.rmtree(self.archive)

    def index_rows(self) -> list[tuple[str, int, str]]:
        rows: list[tuple[str, int, str]] = []
        for path in self.archive.iterdir():
            if path.name == ".history.sha256":
                continue
            payload = path.read_bytes()
            rows.append((hashlib.sha256(payload).hexdigest(), len(payload), path.name))
        return sorted(rows, key=lambda row: row[2])

    def rewrite_index(self, rows: list[tuple[str, int, str]]) -> None:
        (self.archive / ".history.sha256").write_text(
            f"{ARCHIVE_SCHEMA} {ATTEMPT}\n"
            + "".join(f"{digest} {size} {name}\n" for digest, size, name in rows),
            encoding="ascii",
        )

    def assert_integrity_failure(self, filename: str = "missing.optional") -> None:
        result = self.run_read(filename)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertNotEqual(result.returncode, 44, result.stderr.decode("utf-8", "replace"))

    def test_live_read_is_byte_identical_and_stays_bounded_by_caller_limit(self) -> None:
        payload = bytes(range(256)) * 20
        self.make_live({"payload.bin": payload})

        result = self.run_read("payload.bin", maximum=257)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, payload[:258])

    def test_archive_read_is_byte_identical_after_directory_rename(self) -> None:
        payload = b"\x00binary\xff\n" * 51
        files = dict(REQUIRED_FILES)
        files["payload.bin"] = payload
        self.make_archive(files)

        result = self.run_read("payload.bin")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, payload)

    def test_archive_read_emits_caller_limit_plus_one_byte(self) -> None:
        payload = b"x" * 1024
        files = dict(REQUIRED_FILES)
        files["payload.bin"] = payload
        self.make_archive(files)

        result = self.run_read("payload.bin", maximum=17)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, payload[:18])

    def test_valid_live_and_archive_optional_absence_returns_44(self) -> None:
        self.make_live()
        live_missing = self.run_read("not-yet-created.json")
        self.assertEqual(live_missing.returncode, 44, live_missing.stderr)

        shutil.rmtree(self.live_attempt)
        self.make_archive()
        archived_missing = self.run_read("not-indexed.json")
        self.assertEqual(archived_missing.returncode, 44, archived_missing.stderr)
        metadata_path = self.run_read(".history.json")
        self.assertEqual(metadata_path.returncode, 44, metadata_path.stderr)

    def test_live_legacy_attempt_may_be_incomplete_and_still_uses_old_read_semantics(self) -> None:
        self.make_live({"receipt.json": b"legacy receipt"})
        missing = self.run_read("terminal.json")
        self.assertEqual(missing.returncode, 44, missing.stderr)

    def test_corrupt_archive_never_turns_unknown_filename_into_optional_absence(self) -> None:
        self.make_archive()
        index = self.archive / ".history.sha256"
        index.write_bytes(index.read_bytes().replace(b"receipt.json", b"receipX.json"))

        self.assert_integrity_failure()

    def test_archive_rejects_wrong_header_id(self) -> None:
        self.make_archive(header=f"{ARCHIVE_SCHEMA} {'f' * 32}")
        self.assert_integrity_failure()

    def test_archive_rejects_hash_mismatch(self) -> None:
        self.make_archive()
        with (self.archive / "receipt.json").open("ab") as stream:
            stream.write(b"tamper")
        self.assert_integrity_failure("receipt.json")

    def test_archive_rejects_missing_required_original(self) -> None:
        self.make_archive()
        (self.archive / "terminal.json").unlink()
        self.assert_integrity_failure()

    def test_archive_rejects_metadata_that_is_not_listed(self) -> None:
        self.make_archive()
        rows = [row for row in self.index_rows() if row[2] != ".history.json"]
        self.rewrite_index(rows)
        self.assert_integrity_failure()

    def test_archive_rejects_unlisted_file_and_directory(self) -> None:
        self.make_archive()
        (self.archive / "extra.json").write_bytes(b"extra")
        self.assert_integrity_failure()

        (self.archive / "extra.json").unlink()
        (self.archive / "extra-directory").mkdir()
        self.assert_integrity_failure()

    def test_archive_rejects_unsorted_duplicate_and_unsafe_index_names(self) -> None:
        self.make_archive()
        rows = self.index_rows()
        self.rewrite_index(rows[::-1])
        self.assert_integrity_failure()

        self.rewrite_index(rows + [rows[-1]])
        self.assert_integrity_failure()

        unsafe = rows + [("a" * 64, 0, "../escape")]
        unsafe.sort(key=lambda row: row[2])
        self.rewrite_index(unsafe)
        self.assert_integrity_failure()

    def test_archive_rejects_noncanonical_decimal_and_nul_in_index(self) -> None:
        self.make_archive()
        index = self.archive / ".history.sha256"
        rows = self.index_rows()
        rows[0] = (rows[0][0], rows[0][1] + 1, rows[0][2])
        lines = index.read_text(encoding="ascii").splitlines()
        first = rows[0]
        lines[1] = f"{first[0]} 0{first[1]} {first[2]}"
        index.write_text("\n".join(lines) + "\n", encoding="ascii")
        self.assert_integrity_failure()

        index.write_bytes(index.read_bytes().replace(b"fullmag", b"full\x00mag"))
        self.assert_integrity_failure()

    def test_archive_rejects_index_without_final_newline(self) -> None:
        self.make_archive()
        index = self.archive / ".history.sha256"
        index.write_bytes(index.read_bytes().rstrip(b"\n"))
        self.assert_integrity_failure()

    def test_archive_rejects_index_link_count_type_and_size_violations(self) -> None:
        self.make_archive()
        index = self.archive / ".history.sha256"
        index.unlink()
        index.symlink_to(self.archive / "missing-index")
        self.assert_integrity_failure()

        index.unlink()
        self.reset_archive()
        self.make_archive()
        index = self.archive / ".history.sha256"
        with index.open("ab") as stream:
            stream.write(b" " * (INDEX_MAX_BYTES + 1))
        self.assert_integrity_failure()

    def test_archive_rejects_hardlinked_file(self) -> None:
        self.reset_archive()
        self.make_archive()
        outside = Path(self.temp.name) / "hardlink-target"
        (self.archive / "receipt.json").unlink()
        outside.write_bytes(REQUIRED_FILES["receipt.json"])
        (self.archive / "receipt.json").hardlink_to(outside)
        self.assert_integrity_failure("receipt.json")

    def test_archive_rejects_oversize_normal_file_and_build_log(self) -> None:
        self.make_archive()
        receipt = self.archive / "receipt.json"
        with receipt.open("r+b") as stream:
            stream.truncate(MAX_DOCUMENT_BYTES + 1)
        rows = [
            ("a" * 64 if name == "receipt.json" else digest,
             path.stat().st_size,
             name)
            for digest, _, name in self.index_rows()
            for path in [self.archive / name]
        ]
        self.rewrite_index(rows)
        self.assert_integrity_failure("receipt.json")

        with (self.archive / "build.log").open("r+b") as stream:
            stream.truncate(MAX_LOG_BYTES + 1)
        rows = [
            ("b" * 64 if name == "build.log" else digest,
             (self.archive / name).stat().st_size,
             name)
            for digest, _, name in self.index_rows()
        ]
        self.rewrite_index(rows)
        self.assert_integrity_failure("build.log")

    def test_archive_rejects_index_count_and_total_size_budgets(self) -> None:
        self.make_archive()
        rows = self.index_rows()
        for number in range(MAX_ARCHIVE_FILES - len(rows) + 1):
            rows.append(("c" * 64, 0, f"extra-{number:02d}.bin"))
        rows.sort(key=lambda row: row[2])
        self.rewrite_index(rows)
        self.assert_integrity_failure()

        self.reset_archive()
        self.make_archive()
        rows = self.index_rows()
        rows.extend(
            [("d" * 64, MAX_DOCUMENT_BYTES, "x-extra.bin"),
             ("e" * 64, MAX_DOCUMENT_BYTES, "y-extra.bin")]
        )
        rows = [(digest, MAX_DOCUMENT_BYTES, name) for digest, _, name in rows]
        rows.sort(key=lambda row: row[2])
        self.rewrite_index(rows)
        self.assertGreater(sum(row[1] for row in rows), MAX_ARCHIVE_BYTES)
        self.assert_integrity_failure()

    def test_live_and_archive_duplicates_are_integrity_failures(self) -> None:
        self.make_live()
        self.make_archive()
        self.assert_integrity_failure("receipt.json")

    def test_archive_and_parent_symlinks_fail_even_when_live_file_exists(self) -> None:
        self.make_live()
        self.history_root.symlink_to(Path(self.temp.name) / "does-not-exist")
        self.assert_integrity_failure("receipt.json")

    def test_canonical_parent_symlink_and_base_symlink_are_rejected(self) -> None:
        self.make_archive()
        real_history = Path(self.temp.name) / "real-history"
        self.history_root.rename(real_history)
        self.history_root.symlink_to(real_history, target_is_directory=True)
        self.assert_integrity_failure("receipt.json")

        self.history_root.unlink()
        real_control = Path(self.temp.name) / "real-control"
        self.control.rename(real_control)
        self.control.symlink_to(real_control, target_is_directory=True)
        self.assert_integrity_failure("receipt.json")

    def test_symlinked_attempt_and_dangling_file_are_integrity_failures(self) -> None:
        target = Path(self.temp.name) / "target-attempt"
        target.mkdir()
        (target / "receipt.json").write_bytes(b"receipt")
        self.live_root.mkdir()
        self.live_attempt.symlink_to(target, target_is_directory=True)
        self.assert_integrity_failure("receipt.json")

        self.live_attempt.unlink()
        self.live_attempt.mkdir()
        (self.live_attempt / "receipt.json").symlink_to(target / "missing")
        self.assert_integrity_failure("receipt.json")

    def test_archive_directory_and_dangling_index_symlinks_fail(self) -> None:
        self.make_archive()
        target = Path(self.temp.name) / "archive-target"
        self.archive.rename(target)
        self.archive.symlink_to(target, target_is_directory=True)
        self.assert_integrity_failure("receipt.json")

        self.archive.unlink()
        self.archive.symlink_to(Path(self.temp.name) / "missing-archive", target_is_directory=True)
        self.assert_integrity_failure("receipt.json")

    def test_non_activation_or_non_direct_paths_are_not_claimed(self) -> None:
        self.assertIsNone(activation_history_read_script("/control/runtime/receipt.json", 128))
        self.assertIsNone(
            activation_history_read_script(
                f"/control/activation/attempts/{ATTEMPT}/nested/receipt.json", 128
            )
        )
        self.assertIsNone(
            activation_history_read_script(
                f"/control/activation/attempts/../{ATTEMPT}/receipt.json", 128
            )
        )
        self.assertIsNone(
            activation_history_read_script(
                f"/control/activation/attempts/{ATTEMPT}/bad;touch-pwned", 128
            )
        )

    def test_invalid_limit_is_rejected_for_claimed_path(self) -> None:
        path = f"/control/activation/attempts/{ATTEMPT}/receipt.json"
        with self.assertRaises(ValueError):
            activation_history_read_script(path, 0)
        with self.assertRaises(ValueError):
            activation_history_read_script(path, MAX_DOCUMENT_BYTES + 1)


if __name__ == "__main__":
    unittest.main()
