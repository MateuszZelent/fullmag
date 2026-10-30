"""Focused guards for the initial Compose pool-failure reconciler."""
from __future__ import annotations

import json
import fcntl
import tempfile
from pathlib import Path
import subprocess
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import docker_volume_network_failure_reconcile as reconcile
from docker_build_control import BuildControlError, canonical


ATTEMPT = "d9071f5ad22f492e9efcaab3d3e5abae"
PROJECT = "fullmag-worktree-fullmag-465ed74fce6e7ce0"
NETWORK = PROJECT + "_fullmag"
IDENTITY = {
    "project_name": PROJECT,
    "network_name": NETWORK,
    "project_id": "project-123",
    "worktree_id": "fullmag-465ed74fce6e7ce0",
    "checkout_kind": "worktree",
    "source_root": "/work/fullmag",
    "registered_name": "fullmag-465ed74fce6e7ce0",
}
POOL_ERROR = "all predefined address pools have been fully subnetted"
COMPOSE_ERROR = "\n".join((
    f"Network {NETWORK} Creating",
    f"Network {NETWORK} Creating",
    f"Network {NETWORK} Error Error response from daemon: {POOL_ERROR}",
    f"network:fullmag failed to create network {NETWORK}: Error response from daemon: {POOL_ERROR}",
    f"Container {PROJECT}-backend-1 Creating",
    f"failed to create network {NETWORK}: Error response from daemon: {POOL_ERROR}",
))


def helper_doc():
    labels = {
        "com.docker.compose.project": PROJECT,
        "com.docker.compose.service": "build-control",
        "org.fullmag.source.project-id": IDENTITY["project_id"],
        "org.fullmag.source.worktree-id": IDENTITY["worktree_id"],
        "org.fullmag.source.checkout-kind": IDENTITY["checkout_kind"],
        "org.fullmag.compose.project": PROJECT,
    }
    return {
        "Id": "a" * 64,
        "Name": "/fullmag-control-" + ATTEMPT,
        "Config": {"Labels": labels},
        "HostConfig": {"NetworkMode": "none"},
        "State": {"Running": True},
        "NetworkSettings": {"Networks": {}},
            "Mounts": [],
    }


class NetworkFailureValidatorsTests(unittest.TestCase):
    def test_exact_compose_failure_sequence_is_admissible(self):
        terminal = reconcile.validate_pool_failure(COMPOSE_ERROR, NETWORK, PROJECT)
        self.assertEqual(terminal, f"failed to create network {NETWORK}: Error response from daemon: {POOL_ERROR}")

    def test_compose_success_or_other_error_lines_are_rejected(self):
        for text in (
            COMPOSE_ERROR.replace("backend-1 Creating", "backend-1 Created"),
            COMPOSE_ERROR.replace(POOL_ERROR, "permission denied"),
            COMPOSE_ERROR + "\nContainer " + PROJECT + "-frontend-1 Started",
        ):
            with self.subTest(text=text), self.assertRaises(BuildControlError):
                reconcile.validate_pool_failure(text, NETWORK, PROJECT)

    def test_network_absence_requires_empty_json_and_exact_stderr(self):
        value = reconcile.validate_network_absence(
            1, b"[]\n", f"Error response from daemon: network {NETWORK} not found\n".encode(), NETWORK
        )
        self.assertIn("not found", value)
        for code, stdout, stderr in (
            (0, b"[]\n", b""),
            (1, b"[{\"Name\":\"" + NETWORK.encode() + b"\"}]", b"Error: No such network: " + NETWORK.encode()),
            (1, b"[]\n", b"permission denied"),
            (1, b"[]\n", b"Error: No such network: other-network"),
        ):
            with self.subTest(code=code, stdout=stdout, stderr=stderr), self.assertRaises(BuildControlError):
                reconcile.validate_network_absence(code, stdout, stderr, NETWORK)

    def test_receipt_pins_unknown_initial_development_and_source(self):
        receipt = {
            "schema": "fullmag.docker-build-operation.v1",
            "phase": "development",
            "state": "outcome-unknown-resources-retained",
            "attempt": ATTEMPT,
            "compose_project": PROJECT,
            "control_volume": "fullmag-control-volume",
            "helper_container": "fullmag-control-" + ATTEMPT,
            "inputs": {
                "source_root": IDENTITY["source_root"],
                "source_project_id": IDENTITY["project_id"],
                "source_worktree_id": IDENTITY["worktree_id"],
                "source_checkout_kind": IDENTITY["checkout_kind"],
            },
            "compose_preflight": "PASS",
            "error": COMPOSE_ERROR,
        }
        self.assertIn(POOL_ERROR, reconcile.validate_initial_receipt(
            receipt, attempt=ATTEMPT, project=PROJECT, volume="fullmag-control-volume",
            identity=IDENTITY, network_name=NETWORK,
        ))
        cases = (
            {**receipt, "state": "succeeded"},
            {**receipt, "phase": "toolchain"},
            {**receipt, "inputs": {**receipt["inputs"], "source_worktree_id": "foreign"}},
            {**receipt, "backend_container_id": "f" * 64},
        )
        for changed in cases:
            with self.subTest(changed=changed), self.assertRaises(BuildControlError):
                reconcile.validate_initial_receipt(
                    changed, attempt=ATTEMPT, project=PROJECT, volume="fullmag-control-volume",
                    identity=IDENTITY, network_name=NETWORK,
                )

    def test_container_inventory_requires_exact_helper_and_rejects_stopped_app(self):
        helper = helper_doc()
        other_group = {
            "Id": "f" * 64,
            "Name": "/another-checkout-helper",
            "Config": {"Labels": {
                "com.docker.compose.project": "another-project",
                "com.docker.compose.service": "build-control",
                "org.fullmag.source.project-id": IDENTITY["project_id"],
                "org.fullmag.source.worktree-id": "another-worktree",
                "org.fullmag.source.checkout-kind": "worktree",
                "org.fullmag.compose.project": "another-project",
            }},
            "State": {"Running": True},
            "HostConfig": {"NetworkMode": "none"},
            "NetworkSettings": {"Networks": {}},
            "Mounts": [],
        }
        listed = reconcile.validate_container_inventory(
            [helper, other_group], helper_id="a" * 64, helper_name="fullmag-control-" + ATTEMPT,
            project=PROJECT, network_name=NETWORK, identity=IDENTITY, control_volume="own-control",
        )
        self.assertEqual(listed, [{"id": "a" * 64, "name": "fullmag-control-" + ATTEMPT,
                                   "service": "build-control"}])
        for mount in ({"Name": "own-control"}, *({"Type": "bind", "Source": source} for source in (IDENTITY["source_root"], "/work/fullmag/scripts", "/work"))):
            foreign_consumer = {**other_group, "Mounts": [mount]}
            with self.subTest(mount=mount), self.assertRaises(BuildControlError):
                reconcile.validate_container_inventory(
                    [helper, foreign_consumer], helper_id="a" * 64,
                    helper_name="fullmag-control-" + ATTEMPT, project=PROJECT,
                    network_name=NETWORK, identity=IDENTITY, control_volume="own-control",
                )
        stopped = {
            "Id": "b" * 64,
            "Name": "/" + PROJECT + "-backend-1",
            "Config": {"Labels": {"com.docker.compose.project": PROJECT,
                                    "com.docker.compose.service": "backend"}},
            "State": {"Running": False},
            "HostConfig": {"NetworkMode": "default"},
            "NetworkSettings": {"Networks": {}},
            "Mounts": [],
        }
        with self.assertRaises(BuildControlError):
            reconcile.validate_container_inventory(
                [helper, stopped], helper_id="a" * 64,
                helper_name="fullmag-control-" + ATTEMPT, project=PROJECT,
                network_name=NETWORK, identity=IDENTITY, control_volume="own-control",
            )
        attached = {**helper, "NetworkSettings": {"Networks": {NETWORK: {}}}}
        with self.assertRaises(BuildControlError):
            reconcile.validate_container_inventory(
                [attached], helper_id="a" * 64,
                helper_name="fullmag-control-" + ATTEMPT, project=PROJECT,
                network_name=NETWORK, identity=IDENTITY, control_volume="own-control",
            )
        unrelated_network_consumer = {**other_group, "NetworkSettings": {"Networks": {NETWORK: {}}}}
        with self.assertRaises(BuildControlError):
            reconcile.validate_container_inventory(
                [helper, unrelated_network_consumer], helper_id="a" * 64,
                helper_name="fullmag-control-" + ATTEMPT, project=PROJECT,
                network_name=NETWORK, identity=IDENTITY, control_volume="own-control",
            )

    def test_attempt_and_prior_publication_gates_are_fail_closed(self):
        reconcile.validate_initial_artifacts([(ATTEMPT, "d")], ATTEMPT)
        with self.assertRaises(BuildControlError):
            reconcile.validate_initial_artifacts([(ATTEMPT, "d"), ("b" * 32, "d")], ATTEMPT)
        absent = {
            "development/current.json": None,
            "development/verified.json": None,
            f"development/attempts/{ATTEMPT}/terminal.json": None,
            "backend/runtime-provenance.json": None,
            "runtime-control/runtime-services/OWNER.json": None,
            "runtime-control/runtime-service/process-tree.json": None,
        }
        reconcile.validate_absent_publications(absent, ATTEMPT)
        with self.assertRaises(BuildControlError):
            reconcile.validate_absent_publications({**absent, "development/current.json": b"{}"}, ATTEMPT)

    def test_cas_has_no_helper_active_removal_or_verified_publication(self):
        control = SimpleNamespace(path=lambda value: "/control/" + value)
        script = reconcile._cas_script(control, ATTEMPT, "a" * 64, "b" * 64,
                                       "c" * 64, "d" * 64, "e" * 64)
        self.assertNotIn("rm /control/active", script)
        self.assertNotRegex(script, r"mv[^;]*verified\.json")
        self.assertIn("flock -n 8", script)


class ReconcileTransactionTests(unittest.TestCase):
    def setUp(self):
        self.original_raw = json.dumps({"error": COMPOSE_ERROR}).encode()
        self.result_raw = b'{"state":"failed-confirmed"}\n'
        self.observation = {
            "schema": "fullmag.docker-development-network-failure-observation.v1",
            "attempt": ATTEMPT,
            "engine_id": "engine-test",
            "source_root": IDENTITY["source_root"],
            "source_project_id": IDENTITY["project_id"],
            "source_worktree_id": IDENTITY["worktree_id"],
            "compose_project": PROJECT,
            "control_volume": "fullmag-control-volume",
            "receipt_sha256": reconcile.digest(self.original_raw),
            "compose_sha256": "b" * 64,
            "pool_error": POOL_ERROR,
            "network_absence_error": "Error response from daemon: network " + NETWORK + " not found",
            "network_name": NETWORK,
            "helper_id": "a" * 64,
            "helper_fingerprint": "c" * 64,
            "helper_log_sha256": "d" * 64,
            "container_inventory": [{"id": "a" * 64, "name": "fullmag-control-" + ATTEMPT,
                                     "service": "build-control"}],
            "development_attempts": [(ATTEMPT, "d")],
            "admission_scope": "initial-failure-only-group-local",
        }
        self.control = SimpleNamespace(
            namespace="", project=PROJECT, volume="fullmag-control-volume",
            helper_args=lambda script: ["docker", "run", script],
        )
        self.args = SimpleNamespace(
            source_root=IDENTITY["source_root"], attempt=ATTEMPT,
            receipt_sha256=reconcile.digest(self.original_raw), compose_sha256="b" * 64,
            engine_id="engine-test", apply=True,
        )

    def test_apply_full_mocked_transaction_preserves_then_publishes_failure(self):
        state = {"committed": False}

        def read(_control, relative, optional=False):
            if relative == f"development/attempts/{ATTEMPT}/receipt.json":
                return self.result_raw if state["committed"] else self.original_raw
            if relative in {"development/current.json", f"development/attempts/{ATTEMPT}/terminal.json"}:
                return self.result_raw if state["committed"] else None
            if relative == "active":
                return None if state["committed"] else (ATTEMPT + "\n").encode()
            return None

        writes = []

        def commit(*_args, **_kwargs):
            state["committed"] = True
            return subprocess.CompletedProcess(["docker"], 0, b"", b"")

        with (
            patch.object(reconcile, "_identity_and_control", return_value=(Path(IDENTITY["source_root"]), IDENTITY, self.control)),
            patch.object(reconcile, "_observe", return_value=self.observation) as observe,
            patch.object(reconcile, "read_raw", side_effect=read),
            patch.object(reconcile, "write_immutable", side_effect=lambda *_args: writes.append(_args[1])),
            patch.object(reconcile, "_proof_bytes", return_value=b"proof\n"),
            patch.object(reconcile, "_failure_result", return_value=self.result_raw),
            patch.object(reconcile, "_cas_script", return_value="cas"),
            patch.object(reconcile, "bounded_capture", side_effect=commit),
            patch.object(reconcile, "_probe_helper_absence", return_value="f" * 64),
            patch.object(reconcile.time, "sleep"),
        ):
            result = reconcile.reconcile(self.args)
        self.assertEqual(result["state"], "failed-confirmed")
        self.assertEqual(len(writes), 4)
        self.assertIn(f"development/attempts/{ATTEMPT}/unknown-receipt.json", writes)
        self.assertEqual(observe.call_count, 3)
        self.assertEqual(observe.call_args_list[-1].kwargs,
                         {"allowed_archive": self.original_raw})

    def test_changed_second_observation_refuses_before_any_write(self):
        changed = {**self.observation, "engine_id": "different-engine"}
        with (
            patch.object(reconcile, "_identity_and_control", return_value=(Path(IDENTITY["source_root"]), IDENTITY, self.control)),
            patch.object(reconcile, "_observe", side_effect=[self.observation, changed]),
            patch.object(reconcile, "write_immutable") as write,
            patch.object(reconcile.time, "sleep"),
        ):
            with self.assertRaises(BuildControlError):
                reconcile.reconcile(self.args)
        write.assert_not_called()




class FailurePublicationShellTests(unittest.TestCase):
    def run_publication(self, *, corrupt=False, symlink=False):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp).resolve()
            control = SimpleNamespace(path=lambda relative: str(base / relative))
            root = base / "development/attempts" / ATTEMPT
            (root / "reconciliation").mkdir(parents=True)
            values = {
                "receipt.json": b"original", "compose.json": b"compose",
                "unknown-receipt.json": b"original",
                "reconciliation/network-failure-proof.json": b"proof",
                "reconciliation/result.json": b"result",
                "reconciliation/prepared.json": b"prepared",
            }
            for name, value in values.items():
                (root / name).write_bytes(value)
            (base / "active").write_text(ATTEMPT + "\n")
            if corrupt:
                (root / "compose.json").write_bytes(b"changed")
            if symlink:
                (root / "compose.json").rename(root / "real-compose.json")
                (root / "compose.json").symlink_to(root / "real-compose.json")
            with (base / "operation.lock").open("w") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                script = reconcile._cas_script(control, ATTEMPT, *[
                    reconcile.digest(value) for value in
                    (b"original", b"compose", b"proof", b"result", b"prepared")
                ])
                completed = subprocess.run(["bash", "-euc", script], capture_output=True)
            self.assertEqual((base / "active").read_text(), ATTEMPT + "\n")
            self.assertFalse((base / "development/verified.json").exists())
            if corrupt or symlink:
                self.assertNotEqual(completed.returncode, 0)
                self.assertEqual((root / "receipt.json").read_bytes(), b"original")
                self.assertFalse((root / "terminal.json").exists())
                self.assertFalse((base / "development/current.json").exists())
            else:
                self.assertEqual(completed.returncode, 0, completed.stderr.decode())
                for path in (root / "receipt.json", root / "terminal.json", base / "development/current.json"):
                    self.assertEqual(path.read_bytes(), b"result")
                self.assertEqual((root / "unknown-receipt.json").read_bytes(), b"original")

    def test_failure_publication_preserves_owner_and_original(self):
        self.run_publication()

    def test_changed_input_refuses_publication(self):
        self.run_publication(corrupt=True)

    def test_symlink_input_refuses_publication(self):
        self.run_publication(symlink=True)


if __name__ == "__main__":
    unittest.main()
