import json
from pathlib import Path
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from scripts import data_volume_stopped_windows_bind as stopped_bind


POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"


def stopped_state():
    return {
        "Status": "exited",
        "Running": False,
        "Paused": False,
        "Restarting": False,
        "OOMKilled": False,
        "Dead": False,
        "Pid": 0,
        "ExitCode": 0,
    }


def valid_proof(path="C:/foreign/worktree/missing/data"):
    return {
        "schema": "fullmag.stopped-windows-bind-disjoint.v1",
        "path": path,
        "nearest_existing_path": "C:\\foreign\\worktree",
        "filesystem": "NTFS",
        "fixed": True,
        "no_reparse": True,
        "leaf_exists": False,
        "nearest_is_directory": True,
    }


def completed_process(payload, *, returncode=0, stderr=b""):
    return SimpleNamespace(returncode=returncode, stdout=payload, stderr=stderr)


class StoppedWindowsBindProofTests(unittest.TestCase):
    def test_missing_nested_windows_path_gets_read_only_disjointness_proof(self):
        source = "/run/desktop/mnt/host/c/foreign/worktree/missing/data"
        expected = valid_proof()
        raw = json.dumps(expected, separators=(",", ":")).encode("utf-8")

        with patch.object(
            stopped_bind.subprocess, "run", return_value=completed_process(raw)
        ) as run:
            result = stopped_bind.qualify_stopped_windows_bind(source, stopped_state())

        self.assertEqual(result, expected)
        args, kwargs = run.call_args
        self.assertEqual(args[0][0], POWERSHELL)
        self.assertEqual(args[0][1:3], ["-NoProfile", "-NonInteractive"])
        self.assertEqual(args[0][3], "-Command")
        self.assertEqual(args[0][4], stopped_bind.STOPPED_WINDOWS_BIND_PROBE)
        self.assertEqual(json.loads(kwargs["input"]), {"path": "C:/foreign/worktree/missing/data"})
        self.assertEqual(kwargs["timeout"], 30)
        self.assertNotIn("shell", kwargs)

    def test_existing_ordinary_file_leaf_is_allowed(self):
        expected = {
            "schema": "fullmag.stopped-windows-bind-disjoint.v1",
            "path": "D:/foreign/archive.bin",
            "nearest_existing_path": "D:\\foreign\\archive.bin",
            "filesystem": "ReFS",
            "fixed": True,
            "no_reparse": True,
            "leaf_exists": True,
            "nearest_is_directory": False,
        }
        raw = json.dumps(expected, separators=(",", ":")).encode()
        with patch.object(stopped_bind.subprocess, "run", return_value=completed_process(raw)):
            result = stopped_bind.qualify_stopped_windows_bind(
                r"D:\foreign\archive.bin", stopped_state()
            )
        self.assertEqual(result, expected)

    def test_live_or_inexact_container_states_are_rejected_before_probe(self):
        mutations = (
            ("Status", "running"),
            ("Status", "unknown"),
            ("Running", True),
            ("Running", 0),
            ("Paused", True),
            ("Paused", 0),
            ("Restarting", True),
            ("Dead", True),
            ("OOMKilled", True),
            ("Pid", 42),
            ("Pid", True),
        )
        for key, replacement in mutations:
            state = stopped_state()
            state[key] = replacement
            with self.subTest(key=key, replacement=replacement), patch.object(
                stopped_bind.subprocess, "run"
            ) as run, self.assertRaises(ValueError):
                stopped_bind.qualify_stopped_windows_bind(
                    r"C:\foreign\worktree", state
                )
            run.assert_not_called()

        state = stopped_state()
        del state["Dead"]
        with patch.object(stopped_bind.subprocess, "run") as run:
            with self.assertRaises(ValueError):
                stopped_bind.qualify_stopped_windows_bind(r"C:\foreign\worktree", state)
        run.assert_not_called()

    def test_non_drive_unc_traversal_and_unknown_alias_are_rejected_before_probe(self):
        sources = (
            "/srv/fullmag/storage/user-data",
            "\\\\server\\share\\foreign",
            "//server/share/foreign",
            r"C:\foreign\..\storage",
            "C:/foreign/./storage",
            "/run/desktop/mnt/host/c/foreign/../storage",
            "/run/desktop/mnt/host/wsl/Ubuntu/home/user",
            "",
        )
        for source in sources:
            with self.subTest(source=source), patch.object(
                stopped_bind.subprocess, "run"
            ) as run, self.assertRaises(ValueError):
                stopped_bind.qualify_stopped_windows_bind(source, stopped_state())
            run.assert_not_called()

    def test_closed_proof_schema_path_filesystem_and_ancestor_claims_are_checked(self):
        mutations = []

        wrong_schema = valid_proof()
        wrong_schema["schema"] = "fullmag.stopped-windows-bind-disjoint.v2"
        mutations.append(wrong_schema)

        wrong_path = valid_proof()
        wrong_path["path"] = "C:/other/path"
        mutations.append(wrong_path)

        unc_ancestor = valid_proof()
        unc_ancestor["nearest_existing_path"] = "\\\\server\\share"
        mutations.append(unc_ancestor)

        traversal_ancestor = valid_proof()
        traversal_ancestor["nearest_existing_path"] = "C:/foreign/../other"
        mutations.append(traversal_ancestor)

        nonancestor = valid_proof()
        nonancestor["nearest_existing_path"] = "C:/different/tree"
        mutations.append(nonancestor)

        non_directory_parent = valid_proof()
        non_directory_parent["nearest_is_directory"] = False
        mutations.append(non_directory_parent)

        missing_leaf_claim = valid_proof()
        missing_leaf_claim["leaf_exists"] = True
        mutations.append(missing_leaf_claim)

        contradictory_missing_leaf = valid_proof()
        contradictory_missing_leaf["nearest_existing_path"] = contradictory_missing_leaf[
            "path"
        ]
        mutations.append(contradictory_missing_leaf)

        wrong_filesystem = valid_proof()
        wrong_filesystem["filesystem"] = "exFAT"
        mutations.append(wrong_filesystem)

        malformed_filesystem = valid_proof()
        malformed_filesystem["filesystem"] = []
        mutations.append(malformed_filesystem)

        reparse = valid_proof()
        reparse["no_reparse"] = False
        mutations.append(reparse)

        nonfixed = valid_proof()
        nonfixed["fixed"] = False
        mutations.append(nonfixed)

        bool_as_string = valid_proof()
        bool_as_string["fixed"] = 1
        mutations.append(bool_as_string)

        unknown = valid_proof()
        unknown["device"] = "\\.\\PhysicalDrive0"
        mutations.append(unknown)

        missing = valid_proof()
        del missing["leaf_exists"]
        mutations.append(missing)

        for proof in mutations:
            raw = json.dumps(proof, separators=(",", ":")).encode()
            with self.subTest(proof=proof), patch.object(
                stopped_bind.subprocess,
                "run",
                return_value=completed_process(raw),
            ), self.assertRaises(ValueError):
                stopped_bind.qualify_stopped_windows_bind(
                    "/run/desktop/mnt/host/c/foreign/worktree/missing/data",
                    stopped_state(),
                )

    def test_nonzero_exit_oversized_and_malformed_proofs_fail_closed(self):
        valid = json.dumps(valid_proof(), separators=(",", ":")).encode()
        responses = (
            completed_process(valid, returncode=1),
            completed_process(b"{}" * 40000),
            completed_process(b"not JSON"),
            completed_process(
                b'{"schema":"fullmag.stopped-windows-bind-disjoint.v1",'
                b'"schema":"fullmag.stopped-windows-bind-disjoint.v1"}'
            ),
        )
        for response in responses:
            with self.subTest(response=response), patch.object(
                stopped_bind.subprocess, "run", return_value=response
            ), self.assertRaises(ValueError):
                stopped_bind.qualify_stopped_windows_bind(
                    "/run/desktop/mnt/host/c/foreign/worktree/missing/data",
                    stopped_state(),
                )


if __name__ == "__main__":
    unittest.main()
