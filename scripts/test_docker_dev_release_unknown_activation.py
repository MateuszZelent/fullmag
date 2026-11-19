"""Contract checks for releasing a pre-mutation unknown Docker DEV activation."""
from __future__ import annotations

import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import docker_dev_release_unknown_activation as release
from docker_build_control import BuildControlError


ACTIVATION = "a" * 32
BACKEND = "b" * 64
TIMEOUT_ERROR = (
    "Startup activation outcome is unknown; activation.json prevents retry: "
    "startup activation returned HTTP 500: "
    + json.dumps({
        "capability_reason": None, "code": "internal_error", "diagnostics": None,
        "error": "Python helper exceeded the 30 second deadline",
        "message": "Python helper exceeded the 30 second deadline",
        "revision_context": None,
    }, separators=(",", ":"))
)
# 2026-10-26T11:34:00Z .. 11:34:18Z
RECEIPT = {"started_at": 1793014440.0, "finished_at": 1793014458.0}


def backend_row(**state):
    values = {
        "Running": False, "Restarting": False, "ExitCode": 0, "OOMKilled": False,
        "StartedAt": "2026-10-26T11:25:13.215441247Z",
        "FinishedAt": "2026-10-26T11:38:34.967536333Z",
    }
    values.update(state)
    return {
        "Id": BACKEND,
        "Config": {"Labels": {
            "com.docker.compose.project": "project",
            "com.docker.compose.service": "backend",
        }},
        "State": values,
    }


class PreMutationSignatureTests(unittest.TestCase):
    def test_only_the_exact_helper_deadline_500_is_admissible(self) -> None:
        response = release.pre_mutation_response(TIMEOUT_ERROR)
        self.assertEqual(response["message"], "Python helper exceeded the 30 second deadline")
        for error in (
            TIMEOUT_ERROR.replace("HTTP 500", "HTTP 502"),
            TIMEOUT_ERROR.replace("30 second deadline", "60 second deadline"),
            TIMEOUT_ERROR.replace('"internal_error"', '"accepted_startup_release_missing"'),
            TIMEOUT_ERROR + "\ntrailing diagnostic",
            "Backend activation failed after publishing activation.json; retry is forbidden",
            None,
        ):
            with self.subTest(error=error), self.assertRaises(BuildControlError):
                release.pre_mutation_response(error)


class StoppedBackendTests(unittest.TestCase):
    def test_graceful_stop_after_the_recorded_outcome_is_accepted(self) -> None:
        release.validate_stopped_backend(
            backend_row(), backend=BACKEND, project="project", receipt=RECEIPT,
        )

    def test_running_failed_restarted_or_early_stop_is_refused(self) -> None:
        for state in (
            {"Running": True},
            {"ExitCode": 137},
            {"OOMKilled": True},
            {"StartedAt": "2026-10-26T11:35:00Z"},
            {"FinishedAt": "2026-10-26T11:34:10Z"},
        ):
            with self.subTest(state=state), self.assertRaises(BuildControlError):
                release.validate_stopped_backend(
                    backend_row(**state), backend=BACKEND, project="project", receipt=RECEIPT,
                )
        with self.assertRaises(BuildControlError):
            release.validate_stopped_backend(
                backend_row(), backend="c" * 64, project="project", receipt=RECEIPT,
            )

    def test_process_tree_must_be_drained_by_this_backend_run(self) -> None:
        started = release.docker_time("2026-10-26T11:25:13.215441247Z")
        drained = {
            "state": "drained", "accepted_store": release.ACCEPTED_STORE,
            "service_owner": {"acquired_at": "2026-10-26T11:33:13.940489644Z"},
        }
        release.validate_drained(drained, started_at=started)
        for change in (
            {"state": "running"},
            {"accepted_store": "/elsewhere"},
            {"service_owner": {"acquired_at": "2026-10-26T11:00:00Z"}},
        ):
            with self.subTest(change=change), self.assertRaises(BuildControlError):
                release.validate_drained({**drained, **change}, started_at=started)

    def test_any_accepted_run_keeps_the_quarantine(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            release.accepted_runs_empty(temporary)
            runs = Path(temporary) / "runs/docker-all/session-store/runs"
            runs.mkdir(parents=True)
            release.accepted_runs_empty(temporary)
            (runs / "run-live-1").mkdir()
            with self.assertRaises(BuildControlError):
                release.accepted_runs_empty(temporary)


class ReleaseRouteTests(unittest.TestCase):
    def _run(self, *, runs_present: bool):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        if runs_present:
            (Path(temporary.name) / "runs/docker-all/session-store/runs/run-1").mkdir(parents=True)
        written: dict[str, object] = {}
        files = {
            "active": (ACTIVATION + "\n").encode(),
            "backend/script-activation-k/activation.json": json.dumps({
                "state": "started", "request_id": "r", "source_sha256": "s",
                "provenance_sha256": "p",
            }).encode(),
            "runtime-control/runtime-service/process-tree.json": json.dumps({
                "state": "drained", "accepted_store": release.ACCEPTED_STORE,
                "service_owner": {"acquired_at": "2026-10-26T11:33:13Z"},
            }).encode(),
        }
        control = SimpleNamespace(
            project="project",
            read=lambda path, optional=False: {
                "development/current.json": {
                    "state": "succeeded", "attempt": "d" * 32, "config_sha256": "c" * 64,
                    "backend_container": BACKEND, "inputs": {"image_id": "sha256:" + "e" * 64},
                    "state_root": temporary.name,
                },
            }.get(path),
            write=lambda path, value: written.__setitem__(path, value),
            path=lambda path: "/control/" + path,
        )
        receipt = {**RECEIPT, "retirement_phase": "startup", "error": TIMEOUT_ERROR,
                   "helper_container": "fullmag-control-" + ACTIVATION}
        inputs = {"activation_receipt_path": "/opt/fullmag/control/backend/script-activation-k/activation.json",
                  "request_id": "r", "source_sha256": "s", "provenance_sha256": "p"}
        published = []

        def raw(_control, path, optional=False):
            if path == "active" and published:
                return None
            return files[path]

        def capture(*args, **_kwargs):
            if args[0] == "inspect":
                return SimpleNamespace(stdout=json.dumps([backend_row()]).encode())
            published.append(args)
            return SimpleNamespace(stdout=b"RELEASED\n")

        with patch.object(release, "_selected_context",
                          return_value=(None, None, None, {"source_root": "src"}, control)), \
                patch.object(release, "_validate_activation_receipt",
                             return_value=(receipt, b"receipt", inputs)), \
                patch.object(release, "_validate_helper", return_value=({}, "h" * 64)), \
                patch.object(release, "_validate_helper_logged", return_value=""), \
                patch.object(release, "_raw", side_effect=raw), \
                patch.object(release, "docker_capture", side_effect=capture):
            result = release.release(SimpleNamespace(activation=ACTIVATION))
        return result, written, published

    def test_release_publishes_terminal_through_the_original_helper(self) -> None:
        result, written, published = self._run(runs_present=False)
        self.assertEqual(result["state"], "released")
        self.assertFalse(result["replayed"])
        self.assertIn("activation/attempts/" + ACTIVATION + "/pre-mutation-release-proof.json", written)
        self.assertEqual(len(published), 1)
        script = published[0][-1]
        self.assertIn("/control/activation/attempts/" + ACTIVATION + "/terminal.json", script)
        # The marker is checked by digest but never rewritten.
        self.assertNotIn("mv -T \"$t\" /control/backend/", script)

    def test_an_admitted_run_blocks_release_before_any_publication(self) -> None:
        with self.assertRaisesRegex(BuildControlError, "accepted-run store"):
            self._run(runs_present=True)


if __name__ == "__main__":
    unittest.main()
